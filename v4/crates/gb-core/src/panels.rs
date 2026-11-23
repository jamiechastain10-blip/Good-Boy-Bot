//! The lists Good Boy 3's dashboard shows for a few modules (giveaways, custom commands, backups, top inviters, counting
//! games), as plain data the launcher and the phone app draw, and the few actions that belong on them.
use crate::store::Data;
use crate::{Action, Db};
use serde_json::{json, Value};

fn short(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n.saturating_sub(1)).collect::<String>()) }
}
fn when(ms: i64) -> String {
    let secs = ms / 1000;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // civil date from days since 1970-01-01
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02} {:02}:{:02}", if m <= 2 { y + 1 } else { y }, m, d, rem / 3600, rem % 3600 / 60)
}

/// The panels there are: (id, title).
pub const PANELS: &[(&str, &str, &str)] = &[
    ("giveaways", "Giveaways", "giveaways"),
    ("commands", "Custom commands", "tags"),
    ("backups", "Backups", "backup"),
    ("inviters", "Top inviters", "invites"),
    ("counting", "Counting and word chain", "counting"),
];

/// One panel's rows. Each row has a title, some lines of detail and the actions it offers.
pub fn view(db: &Db, guild: &str, panel: &str) -> Result<Value, String> {
    let name = |id: &str| db.seen().name_or(guild, id);
    let (title, empty, rows): (&str, &str, Vec<Value>) = match panel {
        "giveaways" => ("Giveaways", "No giveaways yet. Start one with /giveaway start in Discord.", {
            let list = db.get().giveaways(guild, 25).unwrap_or_default();
            list.iter().map(|g| {
                let entries = db.get().giveaway_entries(&g.guild, g.id).map(|e| e.len()).unwrap_or(0);
                let ended = g.ended_at.is_some();
                let mut lines = vec![format!("{entries} entr{}", if entries == 1 { "y" } else { "ies" }), if ended { format!("ended {}", when(g.ended_at.unwrap_or(0))) } else { format!("ends {}", when(g.ends_at)) }];
                if !g.winners.is_empty() { lines.push(format!("won by {}", g.winners.iter().map(|w| name(w)).collect::<Vec<_>>().join(", "))); }
                let actions = if ended { json!([{ "id": "reroll", "label": "Pick another winner" }]) } else { json!([{ "id": "end", "label": "End now", "ask": "End it now and pick the winners?" }]) };
                json!({ "id": g.id.to_string(), "title": format!("#{} {}", g.id, short(&g.prize, 60)), "lines": lines, "actions": actions })
            }).collect()
        }),
        "commands" => ("Custom commands", "No custom commands yet. Add them with /tags add in Discord.", {
            let d = Data { db, guild, module: crate::tags::MODULE };
            let mut list: Vec<Value> = d.list("cc:").into_iter().map(|(_, v)| v).collect();
            list.sort_by_key(|c| c["name"].as_str().unwrap_or("").to_lowercase());
            list.iter().map(|c| {
                let n = c["name"].as_str().unwrap_or("");
                let how = match c["trigger"].as_str().unwrap_or("command") { "exact" => "whole message", "starts" => "message starts with", "contains" => "message contains", _ => "command" };
                let shown = if c["trigger"].as_str().unwrap_or("command") == "command" { n.to_string() } else { c["phrase"].as_str().unwrap_or(n).to_string() };
                json!({ "id": n, "title": short(&shown, 60), "lines": [how, format!("used {} time{}", c["uses"].as_i64().unwrap_or(0), if c["uses"].as_i64() == Some(1) { "" } else { "s" })], "actions": [{ "id": "delete", "label": "Delete", "ask": "Delete this custom command?" }] })
            }).collect()
        }),
        "backups" => ("Backups", "No backups yet. Make one with /backup create in Discord.", {
            db.get().backups(guild).unwrap_or_default().into_iter().map(|(id, at, by, roles, channels)| {
                json!({ "id": id.to_string(), "title": format!("Backup #{id}"), "lines": [when(at), format!("{roles} roles, {channels} channels"), match by.as_deref() { Some("auto") | None => "made automatically".to_string(), Some(u) => format!("by {}", name(u)) }], "actions": [] })
            }).collect()
        }),
        "inviters" => ("Top inviters", "Nobody's invites have been tracked yet. They count from when invite tracking was turned on.", {
            db.get().top_inviters(guild, 25).unwrap_or_default().into_iter().enumerate().map(|(k, (id, here, joined))| {
                json!({ "id": id.clone(), "title": format!("{}. {}", k + 1, name(&id)), "lines": [format!("{here} still here"), format!("{joined} joined")], "actions": [] })
            }).collect()
        }),
        "counting" => ("Counting and word chain", "No game channels yet. Use /counting in a channel in Discord.", {
            let d = Data { db, guild, module: crate::counting::MODULE };
            let games = d.get("channels").and_then(|v| v.as_object().cloned()).unwrap_or_default();
            games.iter().map(|(c, kind)| {
                let kind = kind.as_str().unwrap_or("count");
                let lines = if kind == "count" {
                    let st = d.get(&format!("count:{c}")).unwrap_or_default();
                    vec!["counting game".to_string(), format!("now at {}", st["n"].as_i64().unwrap_or(0)), format!("best {}", st["record"].as_i64().unwrap_or(0))]
                } else {
                    let st = d.get(&format!("chain:{c}")).unwrap_or_default();
                    vec!["word chain".to_string(), format!("{} words so far", st["used"].as_array().map_or(0, Vec::len)), format!("best {}", st["record"].as_i64().unwrap_or(0))]
                };
                json!({ "id": c, "channel": c, "title": "A channel", "lines": lines, "actions": [] })
            }).collect()
        }),
        _ => return Err("There is no such page.".into()),
    };
    Ok(json!({ "id": panel, "title": title, "empty": empty, "rows": rows }))
}

/// An action on a row. Gives what the bot should do in Discord.
#[allow(clippy::too_many_arguments)]
pub fn act(db: &Db, guild: &str, panel: &str, row: &str, action: &str, pay_coins: bool, now: i64, roll: &mut dyn FnMut(i64, i64) -> i64) -> Result<Vec<Action>, String> {
    match (panel, action) {
        ("giveaways", "end") | ("giveaways", "reroll") => {
            let id: i64 = row.parse().map_err(|_| "That giveaway is gone.".to_string())?;
            let g = db.get().giveaway(guild, id).map_err(|e| e.to_string())?.ok_or("That giveaway is gone.")?;
            if action == "end" {
                if g.ended_at.is_some() { return Err("That giveaway already ended.".into()); }
                Ok(crate::giveaways::finish(db, &g, 0, now, pay_coins, roll).0)
            } else {
                if g.ended_at.is_none() { return Err("End it first, then pick another winner.".into()); }
                let (actions, won) = crate::giveaways::finish(db, &g, 1, now, pay_coins, roll);
                if won.is_empty() { return Err("Nobody else is eligible.".into()); }
                Ok(actions)
            }
        }
        ("commands", "delete") => {
            let d = Data { db, guild, module: crate::tags::MODULE };
            let key = format!("cc:{}", row.to_lowercase());
            if d.get(&key).is_none() { return Err("That custom command is already gone.".into()); }
            d.delete(&key);
            Ok(Vec::new())
        }
        _ => Err("That cannot be done here.".into()),
    }
}
