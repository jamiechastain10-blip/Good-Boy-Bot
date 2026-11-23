//! Good Boy 3's messages module: post as the bot (`/say send`), edit what the bot posted (`/say edit`), and sticky
//! messages that move back to the bottom of a channel when people talk (after a short quiet, at most once per
//! cooldown). Never pings. The same data (`sticky:<channel>`), settings and wording.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::store::Data;
use crate::{Action, Area, Card, CommandEvent, Db, Def, Kind, MessageEvent, Settings};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub const MODULE: &str = "messages";
pub const POST: Perm = Perm { key: "messages.post", level: Level::Admin };
pub static SETTINGS: &[Def] = &[
    Def { key: "stickyDelaySeconds", label: "Sticky: wait this many seconds of quiet before reposting", kind: Kind::Number { min: 2, max: 300 }, default: Fallback::Int(5) },
    Def { key: "stickyCooldownSeconds", label: "Sticky: repost at most once every N seconds", kind: Kind::Number { min: 10, max: 3600 }, default: Fallback::Int(30) },
];
const MESSAGE: Opt = Opt { name: "message", about: "The text", takes: Takes::Text, required: true };
const TITLE: Opt = Opt { name: "title", about: "Optional: put it in a box with this title", takes: Takes::Text, required: false };
const COLOR: Opt = Opt { name: "color", about: "Optional: box colour as a code, like #5865F2", takes: Takes::Text, required: false };
const COLOUR: Opt = Opt { name: "colour", about: "Or pick a box colour from a list", takes: Takes::Choice(crate::colours::CHOICES), required: false };
const IMAGE: Opt = Opt { name: "image", about: "Optional: a picture link (https://...)", takes: Takes::Text, required: false };
const CHANNEL: Opt = Opt { name: "channel", about: "Which channel (empty = here)", takes: Takes::Channel, required: false };
pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec { name: "say", about: "Post or edit a message as the bot (staff)", module: MODULE, options: &[], subs: &[
        Sub { name: "send", about: "Post a message as the bot", options: &[MESSAGE, TITLE, COLOR, COLOUR, Opt { name: "channel", about: "Where (empty = here)", takes: Takes::Channel, required: false }, IMAGE] },
        Sub { name: "edit", about: "Change a message the bot posted", options: &[Opt { name: "link", about: "The message link (right-click → Copy Message Link)", takes: Takes::Text, required: true }, Opt { name: "message", about: "The text", takes: Takes::Text, required: false }, TITLE, COLOR, IMAGE] },
    ] },
    CommandSpec { name: "sticky", about: "A message that stays at the bottom of a channel (staff)", module: MODULE, options: &[], subs: &[
        Sub { name: "set", about: "Set the sticky message for a channel", options: &[MESSAGE, TITLE, COLOR, COLOUR, CHANNEL] },
        Sub { name: "remove", about: "Remove a channel's sticky message", options: &[CHANNEL] },
        Sub { name: "list", about: "Every sticky message", options: &[] },
    ] },
];

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}

/// The message to post (Good Boy 3's buildPost): the text, in a box with a title, colour or picture when given.
pub fn build(text: &str, title: Option<&str>, color: Option<&str>, image: Option<&str>) -> Result<Card, String> {
    let text = text.trim();
    let accent = match color.filter(|c| !c.trim().is_empty()) {
        None => None,
        Some(c) => {
            let h = c.trim().trim_start_matches('#');
            if h.len() != 6 || !h.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("The colour must be a hex code like #5865F2.".into()); }
            Some(u32::from_str_radix(h, 16).unwrap_or(0))
        }
    };
    let image = image.filter(|i| !i.trim().is_empty());
    if let Some(i) = image { if !i.starts_with("https://") || i.contains(char::is_whitespace) { return Err("The picture must be an https:// link.".into()); } }
    let title = title.filter(|t| !t.trim().is_empty());
    if title.is_none() && accent.is_none() && image.is_none() && text.is_empty() { return Err("Write something to post.".into()); }
    let mut card = Card::new(Area::General);
    if let Some(t) = title { card = card.title(short(t, 256)); }
    if !text.is_empty() { card = card.line(short(text, 4000)); }
    if let Some(i) = image { card = card.image(i); }
    card.accent = accent;
    Ok(card)
}
fn from_saved(post: &Value) -> Option<Card> {
    build(post["text"].as_str().unwrap_or(""), post["title"].as_str(), post["color"].as_str(), None).ok()
}
/// A message link's (server, channel, message).
pub fn read_link(link: &str) -> Option<(String, String, String)> {
    let at = link.find("/channels/")?;
    let mut p = link[at + 10..].split('/').map(|x| x.trim_end_matches(|c: char| !c.is_ascii_digit()));
    let (g, c, m) = (p.next()?, p.next()?, p.next()?);
    let ok = |s: &str| (17..=20).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit());
    (ok(g) && ok(c) && ok(m)).then(|| (g.to_string(), c.to_string(), m.to_string()))
}

/// Each channel's newest message count, so only the last message before a quiet moves the sticky.
fn generation() -> std::sync::MutexGuard<'static, HashMap<String, u64>> {
    static G: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    G.get_or_init(Mutex::default).lock().unwrap_or_else(|p| p.into_inner())
}

pub fn command(db: &Db, ev: &CommandEvent) -> Vec<Action> {
    if !perms::allowed(db, &ev.guild, &ev.member, POST) { return private(format!("You don't have permission for that (`{}`).", POST.key)); }
    let arg = |k: &str| ev.args.get(k).map(String::as_str).filter(|v| !v.trim().is_empty());
    // a typed code wins over one picked from the list
    let colour = || crate::colours::typed_or_picked(arg("color"), arg("colour"));
    let d = Data { db, guild: &ev.guild, module: MODULE };
    match (ev.name.as_str(), ev.sub.as_deref().unwrap_or("")) {
        ("say", "send") => {
            let channel = arg("channel").unwrap_or(&ev.place.channel).to_string();
            let card = match build(arg("message").unwrap_or(""), arg("title"), colour(), arg("image")) { Ok(c) => c, Err(no) => return private(no) };
            let mut out = private(format!("✅ Posted in <#{channel}>. To change it later: `/say edit` with that message's link."));
            out.push(Action::Send { channel, card, ping: Vec::new(), roles: Vec::new() });
            out
        }
        ("say", _) => {
            let Some((g, channel, message)) = arg("link").and_then(read_link).filter(|(g, _, _)| *g == ev.guild) else { return private("Paste a link to a message in this server (right-click the message → Copy Message Link).") };
            let _ = g;
            let card = match build(arg("message").unwrap_or(""), arg("title"), colour(), arg("image")) { Ok(c) => c, Err(no) => return private(no) };
            let mut out = private("✅ Message updated.");
            out.push(Action::Edit { channel, message, card });
            out
        }
        ("sticky", "list") => {
            let rows: Vec<String> = d.list("sticky:").into_iter().map(|(k, v)| format!("<#{}> · {}", &k[7..], short(v["post"]["title"].as_str().filter(|t| !t.is_empty()).or(v["post"]["text"].as_str()).unwrap_or("(picture)"), 80))).collect();
            private(if rows.is_empty() { "No sticky messages yet.".to_string() } else { rows.join("\n") })
        }
        ("sticky", sub) => {
            let channel = arg("channel").unwrap_or(&ev.place.channel).to_string();
            let key = format!("sticky:{channel}");
            if sub == "remove" {
                let Some(s) = d.get(&key) else { return private(format!("<#{channel}> has no sticky message.")) };
                d.delete(&key);
                let mut out = private(format!("🗑️ Removed the sticky message from <#{channel}>."));
                if let Some(last) = s["lastId"].as_str() { out.push(Action::Delete { channel, message: last.into() }); }
                return out;
            }
            let post = json!({ "text": arg("message"), "title": arg("title"), "color": colour() });
            let Some(card) = from_saved(&post) else { return private(build(arg("message").unwrap_or(""), arg("title"), colour(), None).err().unwrap_or_default()) };
            let old = d.get(&key);
            d.set(&key, &json!({ "post": post, "lastId": old.as_ref().and_then(|o| o["lastId"].as_str()), "lastAt": 0, "by": ev.member.id }));
            let mut out = private(format!("📌 <#{channel}> now has a sticky message. It moves back to the bottom when people talk."));
            if let Some(last) = old.as_ref().and_then(|o| o["lastId"].as_str()) { out.push(Action::Delete { channel: channel.clone(), message: last.into() }); }
            out.push(Action::Post { channel: channel.clone(), card, note: format!("sticky:{channel}"), ping: Vec::new(), roles: Vec::new() });
            out
        }
        _ => private("Unknown subcommand."),
    }
}

/// Someone talked in a channel with a sticky message: it is moved back down after a quiet moment (Good Boy 3's
/// wait: the delay, or what is left of the cooldown, whichever is longer).
pub fn on_message(db: &Db, settings: &Settings, ev: &MessageEvent, me: Option<&str>) -> Vec<Action> {
    if Some(ev.author.id.as_str()) == me { return Vec::new(); }
    let d = Data { db, guild: &ev.guild, module: MODULE };
    let Some(s) = d.get(&format!("sticky:{}", ev.place.channel)) else { return Vec::new() };
    let gen = {
        let mut g = generation();
        let n = g.entry(ev.place.channel.clone()).or_insert(0);
        *n += 1;
        *n
    };
    let delay = settings.int(&ev.guild, MODULE, "stickyDelaySeconds") * 1000;
    let cooldown = settings.int(&ev.guild, MODULE, "stickyCooldownSeconds") * 1000;
    let wait = delay.max(s["lastAt"].as_i64().unwrap_or(0) + cooldown - ev.at_ms);
    vec![Action::Later { after_ms: wait.max(0) as u64, note: format!("sticky:{}:{gen}", ev.place.channel) }]
}
/// The quiet moment came: if nobody talked since, the old copy goes and a new one is posted at the bottom.
pub fn fire(db: &Db, guild: &str, note: &str) -> Vec<Action> {
    let Some(rest) = note.strip_prefix("sticky:") else { return Vec::new() };
    let (channel, gen) = rest.split_once(':').unwrap_or((rest, "0"));
    if generation().get(channel).copied() != gen.parse().ok() { return Vec::new(); }
    let d = Data { db, guild, module: MODULE };
    let Some(s) = d.get(&format!("sticky:{channel}")) else { return Vec::new() };
    let Some(card) = from_saved(&s["post"]) else { return Vec::new() };
    let mut out = Vec::new();
    if let Some(last) = s["lastId"].as_str() { out.push(Action::Delete { channel: channel.into(), message: last.into() }); }
    out.push(Action::Post { channel: channel.into(), card, note: format!("sticky:{channel}"), ping: Vec::new(), roles: Vec::new() });
    out
}
/// The sticky copy is up: kept so the next move can take it down.
pub fn posted(db: &Db, guild: &str, note: &str, message: &str, now: i64) {
    let Some(channel) = note.strip_prefix("sticky:") else { return };
    let d = Data { db, guild, module: MODULE };
    if let Some(mut s) = d.get(&format!("sticky:{channel}")) {
        s["lastId"] = json!(message);
        s["lastAt"] = json!(now);
        d.set(&format!("sticky:{channel}"), &s);
    }
}
