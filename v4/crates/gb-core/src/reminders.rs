//! Reminders: `/remind me` (a private reminder), `/remind team` (posted in a channel, notifying roles),
//! `/remind list` and `/remind cancel`. Saved the way Good Boy 3 saves them, so reminders set there still arrive.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::store::Data;
use crate::time::{parse_when, DAY, MINUTE};
use crate::{Action, Area, Card, CommandEvent, Db, Def, Kind, Settings};
use serde_json::{json, Value};

pub const MODULE: &str = "reminders";
pub static SETTINGS: &[Def] = &[
    Def { key: "timezoneOffset", label: "Server timezone offset from UTC, in hours (for dates like 2026-12-31 18:30)", kind: Kind::Number { min: -12, max: 14 }, default: Fallback::Int(0) },
    Def { key: "maxPersonal", label: "Personal reminders each member can keep", kind: Kind::Number { min: 1, max: 50 }, default: Fallback::Int(10) },
    Def { key: "maxTeam", label: "Team reminders the server can keep", kind: Kind::Number { min: 1, max: 100 }, default: Fallback::Int(25) },
];
pub const TEAM: Perm = Perm { key: "reminders.team", level: Level::Moderator(None) };
pub const MANAGE: Perm = Perm { key: "reminders.manage", level: Level::Admin };
pub const COMMANDS: &[CommandSpec] = &[CommandSpec {
    name: "remind",
    about: "Reminders",
    module: MODULE,
    options: &[],
    subs: &[
        Sub { name: "me", about: "Remind yourself", options: &[
            Opt { name: "when", about: "e.g. 30m, 2h, 1d, or 2026-12-31 18:30", takes: Takes::Text, required: true },
            Opt { name: "message", about: "What to remind you of", takes: Takes::Text, required: true },
            Opt { name: "where", about: "Where to remind you", takes: Takes::Choice(&[("direct message (default)", "dm"), ("this channel", "channel")]), required: false },
        ] },
        Sub { name: "team", about: "Post a reminder that notifies one or more roles", options: &[
            Opt { name: "channel", about: "Where to post it (leave everything empty for a popup)", takes: Takes::Channel, required: false },
            Opt { name: "when", about: "e.g. 2h, 1d, or 2026-12-31 18:30", takes: Takes::Text, required: false },
            Opt { name: "role", about: "A role to notify", takes: Takes::Role, required: false },
            Opt { name: "role2", about: "Another role", takes: Takes::Role, required: false },
            Opt { name: "role3", about: "Another role", takes: Takes::Role, required: false },
            Opt { name: "role4", about: "Another role", takes: Takes::Role, required: false },
            Opt { name: "role5", about: "Another role", takes: Takes::Role, required: false },
            Opt { name: "message", about: "The text. Leave empty to write it in a popup", takes: Takes::Text, required: false },
            Opt { name: "repeat", about: "Repeat?", takes: Takes::Choice(&[("no", "none"), ("daily", "daily"), ("weekly", "weekly")]), required: false },
        ] },
        Sub { name: "list", about: "Show your reminders", options: &[] },
        Sub { name: "cancel", about: "Cancel a reminder", options: &[Opt { name: "id", about: "Its number", takes: Takes::Whole { min: 1, max: 1_000_000_000 }, required: true }] },
    ],
}];
/// Later than this and the reminder says it is late (the bot was offline).
const LATE_AFTER: i64 = 5 * MINUTE;

fn private(text: impl Into<String>) -> Action {
    Action::Reply { card: Card::new(Area::General).line(text).private() }
}
fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}
fn roles_of(r: &Value) -> Vec<String> {
    r["roleIds"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

pub fn command(db: &Db, settings: &Settings, dir: &crate::bot::Directory, ev: &CommandEvent) -> Action {
    let d = Data { db, guild: &ev.guild, module: MODULE };
    let all: Vec<Value> = d.list("r:").into_iter().map(|(_, v)| v).collect();
    let me = ev.member.id.as_str();
    let arg = |k: &str| ev.args.get(k).map(String::as_str);
    let when = |raw: &str| -> Result<i64, String> {
        let at = parse_when(raw, settings.int(&ev.guild, MODULE, "timezoneOffset"), ev.at_ms).map_err(str::to_string)?;
        if at < ev.at_ms + 30_000 {
            return Err("That time is in the past (or too soon). Pick at least a minute ahead.".into());
        }
        if at > ev.at_ms + 366 * DAY {
            return Err("Set reminders within the next year.".into());
        }
        Ok(at)
    };
    match ev.sub.as_deref() {
        Some("list") => {
            let staff = perms::allowed(db, &ev.guild, &ev.member, MANAGE);
            let mut rows: Vec<&Value> = all.iter().filter(|r| staff || r["by"].as_str() == Some(me)).collect();
            rows.sort_by_key(|r| r["nextAt"].as_i64().unwrap_or(0));
            let lines: Vec<String> = rows.iter().map(|r| {
                let at = r["nextAt"].as_i64().unwrap_or(0) / 1000;
                let place = if r["kind"] == "team" { format!("<#{}> · {}", r["channelId"].as_str().unwrap_or(""), roles_of(r).iter().map(|id| format!("<@&{id}>")).collect::<Vec<_>>().join(" ")) }
                    else if r["delivery"] == "dm" { "DM".to_string() } else { format!("<#{}>", r["channelId"].as_str().unwrap_or("")) };
                let repeat = r["repeat"].as_str().filter(|x| *x != "none").map(|x| format!(" ({x})")).unwrap_or_default();
                let by = if staff && r["by"].as_str() != Some(me) { format!(" · by <@{}>", r["by"].as_str().unwrap_or("")) } else { String::new() };
                format!("**#{}** <t:{at}:f> → {place}{repeat}{by}\n> {}", r["id"], short(&r["text"].as_str().unwrap_or("").replace("\\n", " ").replace('\n', " "), 80))
            }).collect();
            private(if lines.is_empty() { "No reminders.".to_string() } else { short(&lines.join("\n"), 1900) })
        }
        Some("cancel") => {
            let id = arg("id").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
            let Some(r) = d.get(&format!("r:{id}")) else { return private("No reminder with that number.") };
            if r["by"].as_str() != Some(me) && !perms::allowed(db, &ev.guild, &ev.member, MANAGE) {
                return private("You don't have permission for that (`reminders.manage`).");
            }
            d.delete(&format!("r:{id}"));
            private(format!("Cancelled reminder #{id}."))
        }
        Some("me") => {
            let max = settings.int(&ev.guild, MODULE, "maxPersonal");
            if all.iter().filter(|r| r["by"].as_str() == Some(me)).count() as i64 >= max {
                return private(format!("You can keep {max} reminders at a time. Cancel one with `/remind cancel`."));
            }
            let at = match when(arg("when").unwrap_or("")) { Ok(at) => at, Err(why) => return private(why) };
            let id = d.next("counter");
            d.set(&format!("r:{id}"), &json!({ "id": id, "kind": "me", "by": me, "channelId": ev.place.channel, "text": short(arg("message").unwrap_or(""), 500), "nextAt": at, "repeat": "none", "delivery": arg("where").unwrap_or("dm"), "roleIds": [] }));
            private(format!("Okay, I'll remind you <t:{0}:R> (<t:{0}:f>).", at / 1000))
        }
        Some("team") => {
            if !perms::allowed(db, &ev.guild, &ev.member, TEAM) {
                return private("You don't have permission for that (`reminders.team`).");
            }
            let max = settings.int(&ev.guild, MODULE, "maxTeam");
            if all.iter().filter(|r| r["kind"] == "team").count() as i64 >= max {
                return private(format!("The server can keep {max} team reminders. Cancel one first."));
            }
            let filled = |k: &str| arg(k).is_some_and(|v| !v.trim().is_empty());
            // nothing filled in: Good Boy 3's one popup asks for everything
            if !filled("channel") && !filled("when") && !filled("role") && !filled("roles") {
                return team_form(&ev.member.id, &ev.place.channel);
            }
            let mut roles: Vec<String> = Vec::new();
            let picked = arg("roles").unwrap_or("").split(',').map(str::trim).filter(|r| !r.is_empty()).map(str::to_string).collect::<Vec<_>>();
            for id in ["role", "role2", "role3", "role4", "role5"].iter().filter_map(|k| arg(k).map(str::to_string)).chain(picked) {
                if id != ev.guild && !id.is_empty() && !roles.contains(&id) { roles.push(id); }
            }
            if roles.is_empty() { return private(if ev.args.contains_key("roles") { "Choose at least one role to notify." } else { "Choose at least one role." }); }
            let at = match arg("at").and_then(|a| a.parse::<i64>().ok()) {
                Some(at) => at,
                None => {
                    if !filled("when") { return private("Say when with the `when` option, or leave everything empty to use the popup."); }
                    match when(arg("when").unwrap_or("")) { Ok(at) => at, Err(why) => return private(why) }
                }
            };
            let channel = arg("channel").filter(|c| !c.is_empty()).unwrap_or(&ev.place.channel);
            let Some(text) = arg("message").map(str::trim).filter(|t| !t.is_empty()) else {
                if ev.args.contains_key("roles") { return private("The reminder cannot be empty."); }
                // the long text is typed in a popup (Good Boy 3's "Team reminder")
                return Action::Form { id: format!("remind:text:{}:{channel}:{}:{at}:{}", ev.member.id, roles.join(","), arg("repeat").unwrap_or("none")), title: "Team reminder".into(), fields: vec![
                    crate::Field { id: "text".into(), label: "What should the reminder say?".into(), long: true, required: true, max: 1500, placeholder: Some("New lines work.".into()), ..Default::default() },
                ] };
            };
            let id = d.next("counter");
            d.set(&format!("r:{id}"), &json!({ "id": id, "kind": "team", "by": me, "channelId": channel, "text": short(text, 1500), "roleIds": roles, "nextAt": at, "repeat": arg("repeat").unwrap_or("none"), "delivery": "channel" }));
            let warn = dir.ping_problem(&ev.guild, &roles).map(|w| format!("\n\n{w}")).unwrap_or_default();
            private(format!("Reminder **#{id}** set for <t:{0}:f> (<t:{0}:R>) in <#{channel}>, for {1}.{warn}", at / 1000, roles.iter().map(|r| format!("<@&{r}>")).collect::<Vec<_>>().join(" ")))
        }
        _ => private("Use `/remind me`, `/remind team`, `/remind list` or `/remind cancel`."),
    }
}

/// Good Boy 3's "Team reminder" popup: everything in one form.
pub fn team_form(owner: &str, channel: &str) -> Action {
    use crate::{Field, FieldKind};
    Action::Form { id: format!("remind:team:{owner}"), title: "Team reminder".into(), fields: vec![
        Field { id: "text".into(), label: "Message".into(), long: true, required: true, max: 1500, placeholder: Some("What should the reminder say?".into()), ..Default::default() },
        Field { id: "when".into(), label: "When".into(), desc: Some("For example: 2h, 1d, or 2026-12-31 18:30".into()), required: true, max: 40, placeholder: Some("1d".into()), ..Default::default() },
        Field { id: "channel".into(), label: "Channel".into(), kind: FieldKind::Channel(vec![0, 5]), required: true, value: Some(channel.into()), ..Default::default() },
        Field { id: "roles".into(), label: "Roles to notify".into(), kind: FieldKind::Role { most: 5 }, required: true, ..Default::default() },
        Field { id: "repeat".into(), label: "Repeat".into(), kind: FieldKind::Select(vec![("No, just once".into(), "none".into()), ("Every day".into(), "daily".into()), ("Every week".into(), "weekly".into())]), required: true, value: Some("none".into()), ..Default::default() },
    ] }
}
/// The team reminder popups, answered: back to `/remind team` with everything filled in.
pub fn form_args(ev: &crate::FormEvent) -> Option<std::collections::BTreeMap<String, String>> {
    let v = |k: &str| ev.values.get(k).map(|s| s.trim().to_string()).unwrap_or_default();
    if let Some(owner) = ev.id.strip_prefix("remind:team:") {
        if owner != ev.member.id { return None; }
        let mut args: std::collections::BTreeMap<String, String> = ["text", "when", "channel", "roles", "repeat"].iter().map(|k| (k.to_string(), v(k))).collect();
        args.insert("message".into(), v("text"));
        return Some(args);
    }
    let rest = ev.id.strip_prefix("remind:text:")?;
    let p: Vec<&str> = rest.splitn(5, ':').collect();
    let (owner, channel, roles, at, repeat) = (p.first()?, p.get(1)?, p.get(2)?, p.get(3)?, p.get(4).copied().unwrap_or("none"));
    if *owner != ev.member.id { return None; }
    Some([("channel", channel.to_string()), ("roles", roles.to_string()), ("at", at.to_string()), ("repeat", repeat.to_string()), ("message", v("text"))].into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}
/// Every reminder that is due, in every server. Each is sent once; a repeating one moves to its next time.
pub fn due(db: &Db, now: i64) -> Vec<(String, Action)> {
    let rows = db.get().data_everywhere(MODULE, "r:").unwrap_or_default();
    let names: std::collections::HashMap<String, String> = db.get().guilds().unwrap_or_default().into_iter().map(|g| (g.id, g.name)).collect();
    let mut out = Vec::new();
    for (guild, key, mut r) in rows {
        let next_at = r["nextAt"].as_i64().unwrap_or(i64::MAX);
        if next_at > now { continue; }
        let late = if now - next_at > LATE_AFTER { "\n\n*(sent late: the bot was offline at the scheduled time)*" } else { "" };
        let text = r["text"].as_str().unwrap_or("").replace("\\n", "\n");
        let channel = r["channelId"].as_str().unwrap_or("").to_string();
        let by = r["by"].as_str().unwrap_or("").to_string();
        if r["kind"] == "team" {
            let roles = roles_of(&r);
            let mut lines = vec!["⏰ **Reminder**".to_string()];
            lines.extend(roles.iter().map(|id| format!("<@&{id}>")));
            lines.push(String::new());
            lines.push(format!("{text}{late}"));
            out.push((guild.clone(), Action::Send { channel, card: Card::new(Area::General).line(short(&lines.join("\n"), 2000)), ping: Vec::new(), roles }));
        } else {
            let body = format!("⏰ **Reminder**\n{text}{late}");
            let in_channel = Card::new(Area::General).line(format!("<@{by}> {body}"));
            // a member who switched direct messages off (/notifications) gets it in the channel instead
            if r["delivery"] == "dm" && crate::notify::allowed(db, &guild, &by, "dms") {
                let server = names.get(&guild).filter(|n| !n.is_empty()).map(|n| short(n, 60)).unwrap_or_else(|| "a server".into());
                out.push((guild.clone(), Action::Dm { user: by.clone(), card: Card::new(Area::General).line(format!("{body}\n*(set in {server})*")), or_in: Some((channel, Box::new(in_channel))) }));
            } else {
                out.push((guild.clone(), Action::Send { channel, card: in_channel, ping: vec![by], roles: Vec::new() }));
            }
        }
        let store = db.get();
        match r["repeat"].as_str() {
            Some(repeat @ ("daily" | "weekly")) => {
                let step = if repeat == "weekly" { 7 * DAY } else { DAY };
                let mut at = next_at;
                while at <= now { at += step; }
                r["nextAt"] = json!(at);
                let _ = store.data_set(&guild, MODULE, &key, &r);
            }
            _ => { let _ = store.data_delete(&guild, MODULE, &key); }
        }
    }
    out
}
