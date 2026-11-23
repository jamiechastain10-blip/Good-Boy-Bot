//! Good Boy 3's utility module: highlights (a DM when someone says one of your words, with a jump link) and
//! Translate on any message (right-click > Apps > Translate). The same data (`hl:<member>`), rules and wording.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::store::Data;
use crate::{Action, Area, Card, CommandEvent, Db, Def, Kind, MessageEvent, Settings};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub const MODULE: &str = "utility";
pub const USE: Perm = Perm { key: "utility.use", level: Level::Everyone };
pub static SETTINGS: &[Def] = &[Def { key: "highlights", label: "Highlights on (members get a DM when someone says their words)", kind: Kind::Toggle, default: Fallback::Bool(true) }];
const WORD: Opt = Opt { name: "word", about: "The word or phrase", takes: Takes::Text, required: true };
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "highlight", about: "Get a DM when someone says your words", module: MODULE, options: &[], subs: &[
    Sub { name: "add", about: "Add a word", options: &[WORD] },
    Sub { name: "remove", about: "Remove a word", options: &[WORD] },
    Sub { name: "list", about: "Your words here", options: &[] },
    Sub { name: "clear", about: "Remove all your words here", options: &[] },
] }];
const MAX_WORDS: usize = 20;
const COOLDOWN: i64 = 5 * 60_000;
const ACTIVE: i64 = 5 * 60_000;

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}

/// Which of the words are in the text as whole words, ignoring case (Good Boy 3's `matches`).
pub fn matches(text: &str, words: &[String]) -> Vec<String> {
    let low = text.to_lowercase();
    let is_word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric());
    words.iter().filter(|w| {
        let w = w.to_lowercase();
        if w.is_empty() { return false; }
        let mut from = 0;
        while let Some(at) = low[from..].find(&w) {
            let start = from + at;
            let end = start + w.len();
            if !is_word(low[..start].chars().next_back()) && !is_word(low[end..].chars().next()) { return true; }
            from = start + w.chars().next().map(char::len_utf8).unwrap_or(1);
        }
        false
    }).cloned().collect()
}

#[derive(Default)]
struct Memory {
    said: HashMap<String, i64>,
    pinged: HashMap<String, i64>,
}
fn memory() -> std::sync::MutexGuard<'static, Memory> {
    static M: OnceLock<Mutex<Memory>> = OnceLock::new();
    M.get_or_init(Mutex::default).lock().unwrap_or_else(|p| p.into_inner())
}

pub fn command(db: &Db, ev: &CommandEvent, reads_messages: bool) -> Vec<Action> {
    if !perms::allowed(db, &ev.guild, &ev.member, USE) { return private(format!("You don't have permission for that (`{}`).", USE.key)); }
    let d = Data { db, guild: &ev.guild, module: MODULE };
    let key = format!("hl:{}", ev.member.id);
    let words: Vec<String> = d.get(&key).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    match ev.sub.as_deref().unwrap_or("list") {
        "list" => private(if words.is_empty() { "You have no highlight words here. Add one with `/highlight add`.".to_string() } else { format!("Your highlight words here: {}", words.iter().map(|w| format!("`{w}`")).collect::<Vec<_>>().join(", ")) }),
        "clear" => { d.delete(&key); private("Cleared your highlight words.") }
        sub => {
            let word: String = ev.args.get("word").map(|w| w.trim().to_lowercase()).unwrap_or_default().chars().take(50).collect();
            if word.chars().count() < 2 { return private("Use at least 2 characters."); }
            if sub == "add" {
                if words.contains(&word) { return private("You already have that word."); }
                if words.len() >= MAX_WORDS { return private(format!("You can have up to {MAX_WORDS} words.")); }
                let mut next = words;
                next.push(word.clone());
                d.set(&key, &json!(next));
                let warn = if reads_messages { "" } else { "\n⚠️ The bot can't read messages yet (Message Content is off in the Developer Portal), so highlights won't fire until it's on." };
                return private(format!("🔔 I'll DM you when someone says **{word}** here.{warn}"));
            }
            if !words.contains(&word) { return private("You don't have that word."); }
            d.set(&key, &json!(words.into_iter().filter(|w| *w != word).collect::<Vec<_>>()));
            private(format!("Removed **{word}**."))
        }
    }
}

/// Someone said something: members whose words are in it get a DM, unless they wrote it, were just chatting in
/// that channel, had one from this channel in the last 5 minutes, or can't see the channel (the Discord layer
/// checks that before sending). `channel_name` and `server` are for the DM.
pub fn on_message(db: &Db, settings: &Settings, ev: &MessageEvent, channel_name: &str, server: &str) -> Vec<Action> {
    if ev.author.bot || ev.text.is_empty() { return Vec::new(); }
    let now = ev.at_ms;
    memory().said.insert(format!("{}:{}:{}", ev.guild, ev.place.channel, ev.author.id), now);
    if !settings.bool(&ev.guild, MODULE, "highlights") { return Vec::new(); }
    let d = Data { db, guild: &ev.guild, module: MODULE };
    let mut out = Vec::new();
    for (key, v) in d.list("hl:") {
        let user = &key[3..];
        if user == ev.author.id { continue; }
        let words: Vec<String> = serde_json::from_value(v).unwrap_or_default();
        let hit = matches(&ev.text, &words);
        let Some(first) = hit.first() else { continue };
        let k = format!("{}:{}:{user}", ev.guild, ev.place.channel);
        {
            let mut m = memory();
            if now - m.said.get(&k).copied().unwrap_or(0) < ACTIVE || now - m.pinged.get(&k).copied().unwrap_or(0) < COOLDOWN { continue; }
            m.pinged.insert(k, now);
        }
        let link = format!("https://discord.com/channels/{}/{}/{}", ev.guild, ev.place.channel, ev.id);
        let card = Card::new(Area::General).title(format!("🔔 \"{first}\" was mentioned in #{channel_name}"))
            .line(format!("**{}:** {}\n\n[Jump to the message]({link})", ev.author.name, short(&ev.text, 1500)))
            .line(format!("-# {server} · /highlight to change your words"));
        out.push(Action::DmIfCanSee { user: user.to_string(), channel: ev.place.channel.clone(), card });
    }
    out
}
