//! Roleplay actions: `/rp action:hug member:@someone`, with a GIF, a "Hug back" button and a count of how many times
//! one member did it to another. Good Boy 3's twenty actions, wording, counts (`roleplay_counts`) and settings.
//!
//! The GIFs (a Good Boy 4 change, asked for by the owner): Good Boy 3's own drawn animations are gone. With the bot
//! owner's Tenor key, `/rp` shows a few furry GIFs found for the action (Tenor's strict safe search) and the member
//! picks one; "do it back" takes one at random. Without a key, or when nothing is found, the action is posted
//! without a GIF.

use crate::bot::{CommandSpec, Directory, Opt, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Def, Field, FormEvent, Kind, Settings};

pub const MODULE: &str = "roleplay";
pub const USE: Perm = Perm { key: "roleplay.use", level: Level::Everyone };
pub static SETTINGS: &[Def] = &[
    Def { key: "pictures", label: "Show GIFs with roleplay actions", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "useTenor", label: "Use Tenor GIFs when the bot owner has set them up", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "pingTarget", label: "Ping the member who receives the action", kind: Kind::Toggle, default: Fallback::Bool(false) },
];
pub const MIGRATIONS: &[(i64, &str)] = &[(1, "CREATE TABLE IF NOT EXISTS roleplay_counts (guild_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, action TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, from_id, to_id, action));")];
pub const SETUP: &str = "tenor-setup";

/// (id, past tense, done alone, emoji): Good Boy 3's twenty actions.
pub const ACTIONS: &[(&str, &str, bool, &str)] = &[
    ("hug", "hugged", false, "🤗"), ("cuddle", "cuddled", false, "🥰"), ("kiss", "kissed", false, "😘"), ("handhold", "held hands with", false, "🤝"),
    ("highfive", "high-fived", false, "🙌"), ("pat", "patted", false, "🫳"), ("boop", "booped", false, "👉"), ("poke", "poked", false, "👉"),
    ("tickle", "tickled", false, "🤭"), ("feed", "fed", false, "🍪"), ("bonk", "bonked", false, "🔨"), ("slap", "slapped", false, "✋"),
    ("bite", "bit", false, "😬"), ("wave", "waved at", true, "👋"), ("dance", "is dancing", true, "💃"), ("cry", "is crying", true, "😢"),
    ("blush", "is blushing", true, "😊"), ("smile", "is smiling", true, "😄"), ("laugh", "is laughing", true, "😂"), ("sleep", "fell asleep", true, "😴"),
];
const CHOICES: &[(&str, &str)] = &[
    ("🤗 hug", "hug"), ("🥰 cuddle", "cuddle"), ("😘 kiss", "kiss"), ("🤝 hold hands", "handhold"), ("🙌 high five", "highfive"), ("🫳 pat", "pat"),
    ("👉 boop", "boop"), ("👉 poke", "poke"), ("🤭 tickle", "tickle"), ("🍪 feed", "feed"), ("🔨 bonk", "bonk"), ("✋ slap", "slap"), ("😬 bite", "bite"),
    ("👋 wave", "wave"), ("💃 dance", "dance"), ("😢 cry", "cry"), ("😊 blush", "blush"), ("😄 smile", "smile"), ("😂 laugh", "laugh"), ("😴 sleep", "sleep"),
    ("⚙️ Tenor GIFs (bot owner)", SETUP),
];
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "rp", about: "Hug, pat, boop and more", module: MODULE, options: &[
    Opt { name: "action", about: "What to do", takes: Takes::Choice(CHOICES), required: true },
    Opt { name: "member", about: "Who to do it to", takes: Takes::Member, required: false },
], subs: &[] }];

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::Games).line(text).private() }]
}
fn action(id: &str) -> Option<(&'static str, &'static str, bool, &'static str)> {
    ACTIONS.iter().find(|a| a.0 == id).copied()
}
/// What Tenor is asked for: furry GIFs of the action.
pub fn search_words(id: &str) -> String {
    let what = match id { "handhold" => "hold hands", "highfive" => "high five", other => other };
    format!("furry {what}")
}
fn times(n: i64) -> String {
    if n == 1 { "for the first time".into() } else { format!("{n} times now") }
}

/// Checks an action and asks the Discord layer for GIFs (`pick`: the member chooses one).
fn ask_gifs(settings: &Settings, guild: &str, id: &str, from: &str, to: Option<&str>, pick: bool) -> Vec<Action> {
    let Some((_, _, solo, _)) = action(id) else { return private("Pick an action from the list.") };
    if !solo && to.is_none() { return private(format!("Pick who to {}.", if id == "handhold" { "hold hands with" } else { id })); }
    if to == Some(from) && !solo { return private(format!("You can't {id} yourself. Try someone else!")); }
    let gifs = settings.bool(guild, MODULE, "pictures") && settings.bool(guild, MODULE, "useTenor");
    vec![Action::RpGifs { action: id.into(), from: from.into(), to: to.map(str::to_string), query: if gifs { Some(search_words(id)) } else { None }, pick }]
}

fn tenor_form() -> Action {
    Action::Form { id: "rp:tenor".into(), title: "Tenor GIFs (optional)".into(), fields: vec![
        Field { id: "key".into(), label: "Tenor API key (empty to switch Tenor off)".into(), max: 100, placeholder: Some("From developers.google.com/tenor".into()), ..Default::default() },
    ] }
}

pub fn command(db: &Db, settings: &Settings, dir: &Directory, ev: &CommandEvent) -> Vec<Action> {
    if !perms::allowed(db, &ev.guild, &ev.member, USE) { return private(format!("You don't have permission for that (`{}`).", USE.key)); }
    let id = ev.args.get("action").map(String::as_str).unwrap_or("");
    if id == SETUP {
        if dir.bot_owner().as_deref() != Some(ev.member.id.as_str()) { return private("Only the person who runs this bot can set up Tenor."); }
        // Discord cannot open a popup from a popup, so when this came from the /rp popup a button opens the next one
        if ev.from_form {
            return vec![Action::Reply { card: crate::Card::new(crate::Area::General).title("Tenor GIFs").line("Press the button to enter your Tenor key. It is checked, kept safe and never shown again.\n-# Only you can see this.").button(format!("rp:tenorform:{}", ev.member.id), "Enter the Tenor key", crate::ButtonStyle::Primary).private() }];
        }
        return vec![tenor_form()];
    }
    if ev.target.as_ref().is_some_and(|t| t.bot) { return private("Pick a member, not a bot."); }
    ask_gifs(settings, &ev.guild, id, &ev.member.id, ev.target.as_ref().map(|t| t.id.as_str()), true)
}

/// The "Hug back" button: only the member it was done to can press it.
pub fn button(settings: &Settings, dir: &Directory, ev: &ButtonEvent) -> Vec<Action> {
    let p: Vec<&str> = ev.id.split(':').collect();
    if p.len() == 3 && p[1] == "tenorform" {
        if p[2] != ev.member.id || dir.bot_owner().as_deref() != Some(ev.member.id.as_str()) { return private("Only the person who runs this bot can set up Tenor."); }
        return vec![tenor_form()];
    }
    if p.len() != 5 || p[1] != "back" { return private("Unknown button."); }
    let (id, from, to) = (p[2], p[3], p[4]);
    if ev.member.id != to { return private(format!("Only <@{to}> can do that back.")); }
    ask_gifs(settings, &ev.guild, id, to, Some(from), false)
}

/// The bot owner's Tenor key from the popup (checked and saved by the Discord layer, never shown back).
pub fn form(dir: &Directory, ev: &FormEvent) -> Vec<Action> {
    if dir.bot_owner().as_deref() != Some(ev.member.id.as_str()) { return private("Only the person who runs this bot can set up Tenor."); }
    let key = ev.values.get("key").map(|k| k.trim().to_string()).unwrap_or_default();
    if !key.is_empty() && !(20..=100).contains(&key.len()) || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return private("That doesn't look like a Tenor API key.");
    }
    vec![Action::TenorKey { key: Some(key).filter(|k| !k.is_empty()) }]
}

/// The action itself, posted in the channel: counted, with the GIF and the "do it back" button.
#[allow(clippy::too_many_arguments)]
pub fn post(db: &Db, settings: &Settings, guild: &str, id: &str, from: &str, to: Option<&str>, gif: Option<&str>, me: Option<&str>) -> Option<(Card, Vec<String>)> {
    let (_, verb, solo, emoji) = action(id)?;
    let store = db.get();
    let n = store.roleplay_bump(guild, from, to.unwrap_or(""), id).unwrap_or(1);
    drop(store);
    let line = match to { Some(t) => format!("<@{from}> {verb} <@{t}>"), None => format!("<@{from}> {verb}") };
    let foot = if to.is_some() && !solo { format!("That's {}.", times(n)) } else if n > 1 { format!("{n} times so far.") } else { "First time!".into() };
    let mut card = Card::new(Area::Games).line(format!("{emoji} {line}!")).line(format!("-# {foot}{}", if gif.is_some() { " · via Tenor" } else { "" }));
    if let Some(g) = gif { card = card.image(g); }
    if let Some(t) = to.filter(|t| !solo && Some(*t) != me) {
        let label = if id == "highfive" { "High-five back".to_string() } else { format!("{}{} back", id[..1].to_uppercase(), &id[1..]) };
        card = card.button_with(format!("rp:back:{id}:{from}:{t}"), label, ButtonStyle::Plain, Some(emoji.into()));
    }
    let ping = if settings.bool(guild, MODULE, "pingTarget") { to.map(|t| vec![t.to_string()]).unwrap_or_default() } else { Vec::new() };
    Some((card, ping))
}
