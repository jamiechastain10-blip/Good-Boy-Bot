//! Giveaways: a card with an Enter button, winners drawn fairly when the time is up, rerolls, and coin prizes
//! paid by themselves. The same tables as Good Boy 3, so a giveaway started there finishes here.
//!
//! One difference from Good Boy 3 for now: whether someone may win (the role a giveaway asks for) is checked
//! when they press Enter, not again at the draw.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::time::{parse_duration, DAY, MINUTE};
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Def};
use gb_data::Giveaway;

pub const MODULE: &str = "giveaways";
pub static SETTINGS: &[Def] = &[];
pub const MANAGE: Perm = Perm { key: "giveaways.manage", level: Level::Admin };
const ID: Opt = Opt { name: "id", about: "Giveaway number", takes: Takes::Whole { min: 1, max: 1_000_000_000 }, required: true };
pub const COMMANDS: &[CommandSpec] = &[CommandSpec {
    name: "giveaway",
    about: "Start, end or reroll giveaways",
    module: MODULE,
    options: &[],
    subs: &[
        Sub { name: "start", about: "Start a giveaway (opens a form)", options: &[] },
        Sub { name: "end", about: "End a giveaway now and draw the winners", options: &[ID] },
        Sub { name: "reroll", about: "Pick new winners for an ended giveaway", options: &[ID, Opt { name: "winners", about: "How many new winners (1 if empty)", takes: Takes::Whole { min: 1, max: 20 }, required: false }] },
        Sub { name: "list", about: "Recent giveaways", options: &[] },
    ],
}];

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::Games).line(text).private() }]
}
fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}
fn many(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}
fn mentions(ids: &[String]) -> String {
    ids.iter().map(|w| format!("<@{w}>")).collect::<Vec<_>>().join(", ")
}
/// "5000 coins" is 5000 (None when the prize is not coins).
pub fn coin_prize(prize: &str) -> Option<i64> {
    let t = prize.trim().to_lowercase();
    let number = t.strip_suffix("coins").or_else(|| t.strip_suffix("coin")).or_else(|| t.strip_suffix("🪙"))?.trim_end();
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit() || c == ',') {
        return None;
    }
    number.replace(',', "").parse::<i64>().ok().filter(|n| *n > 0)
}
/// Picks `count` different winners from the pool, each equally likely. `roll(lo, hi)` picks a whole number.
pub fn draw_winners(pool: &[String], count: usize, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<String> {
    let mut left: Vec<String> = Vec::new();
    for p in pool {
        if !left.contains(p) { left.push(p.clone()); }
    }
    let mut out = Vec::new();
    while out.len() < count && !left.is_empty() {
        let at = roll(0, left.len() as i64 - 1).clamp(0, left.len() as i64 - 1) as usize;
        out.push(left.remove(at));
    }
    out
}

fn card(g: &Giveaway, entries: usize) -> Card {
    let ended = g.ended_at.is_some();
    let top = if !ended {
        format!("Press **Enter** to join. Ends <t:{}:R>.", g.ends_at / 1000)
    } else if g.winners.is_empty() {
        "**No winner:** nobody eligible entered.".to_string()
    } else {
        format!("**Winner{}:** {}", many(g.winners.len()), mentions(&g.winners))
    };
    let mut lines = vec![top, format!("Hosted by <@{}> · {} winner{}", g.host, g.winner_count, many(g.winner_count as usize))];
    if let Some(role) = &g.role { lines.push(format!("You need <@&{role}> to win.")); }
    if coin_prize(&g.prize).is_some() { lines.push("🪙 Coins are paid to the winner automatically.".into()); }
    lines.push(format!("-# Giveaway #{} · {entries} {}{}", g.id, if entries == 1 { "entry" } else { "entries" }, if ended { " · ended" } else { "" }));
    let c = Card::new(if ended { Area::General } else { Area::Money }).title(format!("🎉 {}", short(&g.prize, 200))).line(lines.join("\n"));
    // an ended giveaway keeps its button, greyed out (as in Good Boy 3)
    c.button_full(format!("gw:enter:{}", g.id), if ended { "Ended" } else { "Enter" }, ButtonStyle::Good, Some("🎉".into()), ended)
}
/// Puts the giveaway's own message back in step with what is saved (entries, winners).
fn refresh(db: &Db, g: &Giveaway) -> Option<Action> {
    let entries = db.get().giveaway_entries(&g.guild, g.id).map(|e| e.len()).unwrap_or(0);
    Some(Action::Edit { channel: g.channel.clone(), message: g.message.clone()?, card: card(g, entries) })
}

/// Draws winners and says who won. `reroll` draws that many new winners from everyone who has not won yet.
/// Gives back the actions and the new winners.
/// `pay_coins`: the economy module is on, so a prize like "5000 coins" is paid.
pub fn finish(db: &Db, g: &Giveaway, reroll: usize, now: i64, pay_coins: bool, roll: &mut dyn FnMut(i64, i64) -> i64) -> (Vec<Action>, Vec<String>) {
    let entries = db.get().giveaway_entries(&g.guild, g.id).unwrap_or_default();
    // someone who has left the server (and not come back) cannot win, as in Good Boy 3
    let gone: Vec<String> = { let d = db.get(); entries.iter().filter(|u| d.roster_history(&g.guild, u).map(|h| h.iter().any(|l| l.returned_at.is_none())).unwrap_or(false)).cloned().collect() };
    let pool: Vec<String> = entries.into_iter().filter(|u| !gone.contains(u) && (reroll == 0 || !g.winners.contains(u))).collect();
    let won = draw_winners(&pool, if reroll > 0 { reroll } else { g.winner_count.max(1) as usize }, roll);
    let mut winners = if reroll > 0 { g.winners.clone() } else { Vec::new() };
    winners.extend(won.iter().cloned());
    let _ = db.get().giveaway_finish(&g.guild, g.id, &winners, now);
    let prize: String = g.prize.chars().take(60).collect();
    db.seen().note(&g.guild, "giveaway", &match (reroll > 0, won.len()) {
        (true, n) => format!("Giveaway #{} ({prize}) was rerolled: {n} new winner{}", g.id, if n == 1 { "" } else { "s" }),
        (false, 0) => format!("Giveaway #{} ({prize}) ended with no winner", g.id),
        (false, n) => format!("Giveaway #{} ({prize}) ended with {n} winner{}", g.id, if n == 1 { "" } else { "s" }),
    });
    let coins = coin_prize(&g.prize).filter(|_| pay_coins);
    if let Some(coins) = coins {
        let store = db.get();
        // a wallet is made for a winner who never had one, so the prize is never lost
        if store.module_migrate(crate::money::MODULE, gb_data::economy::MIGRATIONS).is_ok() {
            for w in &won {
                let _ = store.wallet(&g.guild, w, None, 0);
                let _ = store.credit(&g.guild, w, coins, &format!("giveaway #{}", g.id));
            }
        }
    }
    let mut out = Vec::new();
    // read first and let go of the database before refreshing, which reads again
    let fresh = db.get().giveaway(&g.guild, g.id).ok().flatten();
    if let Some(fresh) = fresh {
        out.extend(refresh(db, &fresh));
    }
    let text = if won.is_empty() {
        format!("Giveaway #{} for **{}** ended with no {}eligible entries.", g.id, short(&g.prize, 200), if reroll > 0 { "other " } else { "" })
    } else {
        let paid = coins.map(|c| format!(" 🪙 {} coins were added to your wallet.", crate::card::group(c))).unwrap_or_default();
        format!("🎉 {}{} {}! You won **{}**.{paid}", if reroll > 0 { "New winner" } else { "Congratulations" }, if reroll > 0 { many(won.len()) } else { "" }, mentions(&won), short(&g.prize, 200))
    };
    out.push(Action::Send { channel: g.channel.clone(), card: Card::new(Area::Money).line(text), ping: won.clone(), roles: Vec::new() });
    (out, won)
}

/// Good Boy 3's "Start a giveaway" form.
pub fn start_form(channel: &str) -> Action {
    use crate::{Field, FieldKind};
    Action::Form { id: "gw:start".into(), title: "Start a giveaway".into(), fields: vec![
        Field { id: "prize".into(), label: "Prize".into(), required: true, max: 200, placeholder: Some("e.g. Nitro Basic, 5000 coins, VIP role for a month".into()), ..Default::default() },
        Field { id: "duration".into(), label: "How long? (e.g. 30m, 6h, 2d)".into(), required: true, max: 10, value: Some("1d".into()), ..Default::default() },
        Field { id: "winners".into(), label: "How many winners?".into(), required: true, max: 2, value: Some("1".into()), ..Default::default() },
        Field { id: "channel".into(), label: "Post it in".into(), kind: FieldKind::Channel(vec![0, 5]), required: true, value: Some(channel.into()), ..Default::default() },
        Field { id: "role".into(), label: "Only members with this role can win (optional)".into(), kind: FieldKind::Role { most: 1 }, ..Default::default() },
    ] }
}
pub fn command(db: &Db, ev: &CommandEvent, pay_coins: bool, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
    if !perms::allowed(db, &ev.guild, &ev.member, MANAGE) {
        return private("You don't have permission for that (`giveaways.manage`).");
    }
    let arg = |k: &str| ev.args.get(k).map(String::as_str);
    let sub = ev.sub.as_deref().unwrap_or("list");
    if sub == "start" && !ev.args.contains_key("prize") {
        // Good Boy 3's private message first, then the form from its button
        let card = Card::new(Area::Money).title("Start a giveaway")
            .line("Pick the prize, how long it runs, how many win and where it goes. Write a prize like **5000 coins** and the coins are paid automatically.")
            .line("-# Only you can see this. The button works for 15 minutes.")
            .button_with(format!("gw:setup:{}", ev.member.id), "Set up the giveaway", ButtonStyle::Good, Some("🎉".into())).private();
        return vec![Action::Reply { card }];
    }
    if sub == "start" {
        let prize = short(arg("prize").unwrap_or("").trim(), 200);
        if prize.is_empty() { return private("Write the prize."); }
        let Some(ms) = arg("duration").and_then(parse_duration).filter(|ms| (MINUTE..=30 * DAY).contains(ms)) else { return private("Pick a time between 1 minute and 30 days, like 30m, 6h or 2d.") };
        let winners = arg("winners").and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(1).clamp(1, 20);
        let channel = arg("channel").filter(|c| !c.is_empty()).unwrap_or(&ev.place.channel);
        let made = db.get().giveaway_start(&ev.guild, channel, &ev.member.id, &prize, winners, arg("role").filter(|r| !r.is_empty()), ev.at_ms, ev.at_ms + ms);
        let Ok(g) = made else { return private("The giveaway could not be saved. Try again.") };
        let mut out = private(format!("🎉 Giveaway #{} is live in <#{channel}>. It ends <t:{}:R>.", g.id, g.ends_at / 1000));
        out.push(Action::Post { channel: channel.to_string(), card: card(&g, 0), note: format!("gw:{}", g.id), ping: Vec::new(), roles: Vec::new() });
        return out;
    }
    if sub == "list" {
        let rows = db.get().giveaways(&ev.guild, 15).unwrap_or_default();
        if rows.is_empty() { return private("No giveaways yet. Start one with `/giveaway start`."); }
        let lines: Vec<String> = rows.iter().map(|g| {
            let n = db.get().giveaway_entries(&g.guild, g.id).map(|e| e.len()).unwrap_or(0);
            format!("**#{}** {} · {} · {n} entries · <#{}>", g.id, short(&g.prize, 60), if g.ended_at.is_some() { "ended".to_string() } else { format!("ends <t:{}:R>", g.ends_at / 1000) }, g.channel)
        }).collect();
        return vec![Action::Reply { card: Card::new(Area::Money).title("🎉 Giveaways").line(lines.join("\n")).private() }];
    }
    let id = arg("id").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    let Some(g) = db.get().giveaway(&ev.guild, id).ok().flatten() else { return private(format!("There's no giveaway #{id}.")) };
    match sub {
        "end" => {
            if g.ended_at.is_some() { return private("That giveaway already ended. Use `/giveaway reroll` to pick someone else."); }
            let (actions, won) = finish(db, &g, 0, ev.at_ms, pay_coins, roll);
            let mut out = private(if won.is_empty() { format!("Ended giveaway #{id}: nobody eligible entered.") } else { format!("Ended giveaway #{id}. Winner{}: {}", many(won.len()), mentions(&won)) });
            out.extend(actions);
            out
        }
        "reroll" => {
            if g.ended_at.is_none() { return private("That giveaway hasn't ended yet."); }
            let n = arg("winners").and_then(|v| v.parse::<usize>().ok()).unwrap_or(1).clamp(1, 20);
            let (actions, won) = finish(db, &g, n, ev.at_ms, pay_coins, roll);
            let mut out = private(if won.is_empty() { "Nobody else is eligible.".to_string() } else { format!("New winner{}: {}", many(won.len()), mentions(&won)) });
            out.extend(actions);
            out
        }
        _ => private("Use `/giveaway start`, `end`, `reroll` or `list`."),
    }
}

/// The Enter button: joins, or leaves when pressed again.
pub fn button(db: &Db, ev: &ButtonEvent, rest: &str) -> Vec<Action> {
    if let Some(owner) = rest.strip_prefix("setup:") {
        if owner != ev.member.id { return private("That form belongs to someone else. Run the command yourself to get your own."); }
        if !perms::allowed(db, &ev.guild, &ev.member, MANAGE) { return private("You don't have permission for that (`giveaways.manage`)."); }
        return vec![start_form(&ev.place.channel)];
    }
    let id = rest.strip_prefix("enter:").and_then(|n| n.parse::<i64>().ok()).unwrap_or(0);
    let Some(g) = db.get().giveaway(&ev.guild, id).ok().flatten().filter(|g| g.ended_at.is_none()) else { return private("This giveaway has ended.") };
    if let Some(role) = g.role.as_ref().filter(|r| !ev.member.roles.contains(r)) {
        return private(format!("You need the <@&{role}> role to enter this one."));
    }
    if ev.member.bot { return private("Bots can't enter."); }
    let now_in = db.get().giveaway_toggle(&ev.guild, id, &ev.member.id, ev.at_ms).unwrap_or(false);
    let mut out = private(if now_in { "🎉 You're in! Good luck. Press **Enter** again to leave." } else { "You left the giveaway." });
    out.extend(refresh(db, &g));
    out
}

/// The bot's giveaway message was posted: its id is kept so the message can be updated later.
pub fn posted(db: &Db, guild: &str, note: &str, message: &str) {
    if let Some(id) = note.strip_prefix("gw:").and_then(|n| n.parse::<i64>().ok()) {
        let _ = db.get().giveaway_posted(guild, id, message);
    }
}

/// Giveaways whose time is up, in every server.
pub fn due(db: &Db, now: i64, pays: &dyn Fn(&str) -> bool, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<(String, Action)> {
    let list = db.get().giveaways_due(now).unwrap_or_default();
    let mut out = Vec::new();
    for g in list {
        let (actions, _) = finish(db, &g, 0, now, pays(&g.guild), roll);
        out.extend(actions.into_iter().map(|a| (g.guild.clone(), a)));
    }
    out
}
