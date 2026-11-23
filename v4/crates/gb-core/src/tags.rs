//! Custom commands and auto-replies: `?rules`, `!ip`, or a reply when someone says a phrase.
//! Saved the way Good Boy 3 saves them (`cc:<name>`), so a server's custom commands carry over.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::store::Data;
use crate::tagscript;
use crate::{Action, Area, Card, CommandEvent, Db, Def, Kind, MessageEvent, Settings};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

pub const MODULE: &str = "tags";
pub static SETTINGS: &[Def] = &[Def { key: "prefixes", label: "Command prefixes", kind: Kind::List, default: Fallback::None }];
const DEFAULT_PREFIXES: [&str; 2] = ["?", "!"];
pub const MANAGE: Perm = Perm { key: "tags.manage", level: Level::Moderator(None) };
pub const COMMANDS: &[CommandSpec] = &[CommandSpec {
    name: "tags",
    about: "Custom commands and auto-replies",
    module: MODULE,
    options: &[],
    subs: &[
        Sub { name: "list", about: "Every custom command", options: &[] },
        Sub { name: "use", about: "Post a custom command here", options: &[Opt { name: "name", about: "Which one", takes: Takes::Text, required: true }, Opt { name: "args", about: "Words after the command, for {args} and {arg1}", takes: Takes::Text, required: false }] },
        Sub { name: "add", about: "Add or change a custom command (staff)", options: &[
            Opt { name: "name", about: "Its name, e.g. rules (used as ?rules)", takes: Takes::Text, required: true },
            Opt { name: "response", about: "Reply. {user} {args} {arg1} {random: a | b} {number: 1-6} {if: {arg1} = x | yes | no}", takes: Takes::Text, required: true },
            Opt { name: "trigger", about: "When it replies", takes: Takes::Choice(&[("command (?name)", "command"), ("whole message is the phrase", "exact"), ("message starts with the phrase", "starts"), ("message contains the phrase", "contains")]), required: false },
            Opt { name: "phrase", about: "The phrase for auto-replies (empty = the name)", takes: Takes::Text, required: false },
            Opt { name: "embed_title", about: "Optional: reply in a box with this title", takes: Takes::Text, required: false },
            Opt { name: "cooldown", about: "Seconds before it can reply again in the same channel", takes: Takes::Whole { min: 0, max: 3600 }, required: false },
        ] },
        Sub { name: "remove", about: "Remove a custom command (staff)", options: &[Opt { name: "name", about: "Which one", takes: Takes::Text, required: true }] },
    ],
}];
const MAX: usize = 200;

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}
fn key_of(name: &str) -> String {
    format!("cc:{}", name.to_lowercase())
}
fn word_char(c: char) -> bool {
    c.is_alphanumeric()
}
pub fn prefixes(settings: &Settings, guild: &str) -> Vec<String> {
    // nothing saved means Good Boy 3's defaults; an empty saved list means no prefixes at all
    match settings.get(guild, MODULE, "prefixes") {
        Value::Array(a) if a.is_empty() && !settings.is_saved(guild, MODULE, "prefixes") => DEFAULT_PREFIXES.iter().map(|p| p.to_string()).collect(),
        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        _ => DEFAULT_PREFIXES.iter().map(|p| p.to_string()).collect(),
    }
}

/// Which custom command a message sets off, and the words after it, or None.
pub fn match_message<'a>(text: &str, list: &'a [Value], prefixes: &[String]) -> Option<(&'a Value, String)> {
    let msg = text.trim();
    if msg.is_empty() { return None; }
    let lower = msg.to_lowercase();
    for p in prefixes {
        if p.is_empty() || !lower.starts_with(&p.to_lowercase()) { continue; }
        // the prefix is cut by its own length, as typed
        let rest: String = msg.chars().skip(p.chars().count()).collect();
        let mut words = rest.split_whitespace();
        // a space straight after the prefix means the first "word" is empty, which matches nothing
        let word = if rest.starts_with(char::is_whitespace) { "" } else { words.next().unwrap_or("") };
        if let Some(hit) = list.iter().find(|c| c["trigger"] == "command" && c["name"].as_str().is_some_and(|n| n.to_lowercase() == word.to_lowercase())) {
            return Some((hit, words.collect::<Vec<_>>().join(" ")));
        }
    }
    for c in list {
        let t = c["phrase"].as_str().or(c["name"].as_str()).unwrap_or("").to_lowercase();
        match c["trigger"].as_str() {
            Some("exact") if lower == t => return Some((c, String::new())),
            Some("starts") if lower.starts_with(&t) => return Some((c, msg.chars().skip(t.chars().count()).collect::<String>().trim().to_string())),
            Some("contains") if !t.is_empty() => {
                // as a whole word or phrase: not in the middle of a longer word
                let mut from = 0;
                while let Some(at) = lower[from..].find(&t) {
                    let (start, end) = (from + at, from + at + t.len());
                    let before = lower[..start].chars().next_back().is_none_or(|c| !word_char(c));
                    let after = lower[end..].chars().next().is_none_or(|c| !word_char(c));
                    if before && after { return Some((c, String::new())); }
                    from = start + lower[start..].chars().next().map_or(1, char::len_utf8);
                }
            }
            _ => {}
        }
    }
    None
}

static COOLDOWNS: Mutex<Option<HashMap<String, i64>>> = Mutex::new(None);
fn on_cooldown(guild: &str, c: &Value, channel: &str, now: i64) -> bool {
    let secs = c["cooldown"].as_i64().unwrap_or(0);
    if secs <= 0 { return false; }
    let mut all = COOLDOWNS.lock().unwrap_or_else(|p| p.into_inner());
    let map = all.get_or_insert_with(HashMap::new);
    if map.len() > 20_000 { map.retain(|_, until| *until > now); }
    let k = format!("{guild}:{}:{channel}", c["name"].as_str().unwrap_or(""));
    if map.get(&k).copied().unwrap_or(0) > now { return true; }
    map.insert(k, now + secs * 1000);
    false
}

pub struct Who<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub channel: &'a str,
    pub server: &'a str,
    pub members: Option<u64>,
    pub at_ms: i64,
}
fn render(c: &Value, who: &Who, args: &str, uses: i64, roll: &mut dyn FnMut(i64, i64) -> i64) -> Card {
    let mut vars: HashMap<String, String> = HashMap::new();
    vars.insert("user".into(), format!("<@{}>", who.id));
    vars.insert("username".into(), who.name.to_string());
    vars.insert("server".into(), who.server.to_string());
    vars.insert("channel".into(), format!("<#{}>", who.channel));
    vars.insert("membercount".into(), who.members.map(|n| n.to_string()).unwrap_or_default());
    vars.insert("date".into(), crate::time::date(who.at_ms));
    vars.insert("uses".into(), uses.to_string());
    tagscript::arg_vars(args, &mut vars);
    let text = tagscript::run(c["response"].as_str().unwrap_or(""), &vars, roll);
    let text = if text.trim().is_empty() { "\u{200b}".to_string() } else { text };
    match c["title"].as_str().filter(|t| !t.is_empty()) {
        Some(title) => Card::new(Area::General).title(short(&tagscript::run(title, &vars, roll), 256)).line(short(&text, 3500)),
        None => Card::new(Area::General).line(short(&text, 2000)),
    }
}

pub fn on_message(db: &Db, settings: &Settings, ev: &MessageEvent, server: &str, members: Option<u64>, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
    if ev.author.bot || ev.text.is_empty() { return Vec::new(); }
    let d = Data { db, guild: &ev.guild, module: MODULE };
    let list: Vec<Value> = d.list("cc:").into_iter().map(|(_, v)| v).collect();
    if list.is_empty() { return Vec::new(); }
    let Some((c, args)) = match_message(&ev.text, &list, &prefixes(settings, &ev.guild)) else { return Vec::new() };
    let only: Vec<&str> = c["channels"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default();
    if !only.is_empty() && !only.contains(&ev.place.channel.as_str()) && !ev.place.category.as_deref().is_some_and(|cat| only.contains(&cat)) { return Vec::new(); }
    if on_cooldown(&ev.guild, c, &ev.place.channel, ev.at_ms) { return Vec::new(); }
    let uses = c["uses"].as_i64().unwrap_or(0) + 1;
    let mut saved = c.clone();
    saved["uses"] = json!(uses);
    d.set(&key_of(c["name"].as_str().unwrap_or("")), &saved);
    let who = Who { id: &ev.author.id, name: &ev.author.name, channel: &ev.place.channel, server, members, at_ms: ev.at_ms };
    let mut out = Vec::new();
    if c["deleteTrigger"] == true && c["trigger"] == "command" {
        out.push(Action::Delete { channel: ev.place.channel.clone(), message: ev.id.clone() });
    }
    out.push(Action::Send { channel: ev.place.channel.clone(), card: render(c, &who, &args, uses, roll), ping: Vec::new(), roles: Vec::new() });
    out
}

pub fn command(db: &Db, settings: &Settings, ev: &CommandEvent, server: &str, members: Option<u64>, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
    let d = Data { db, guild: &ev.guild, module: MODULE };
    let arg = |k: &str| ev.args.get(k).map(String::as_str);
    let pre = prefixes(settings, &ev.guild);
    let first = pre.first().map(String::as_str).unwrap_or("?");
    let words = |t: &str| match t { "exact" => "whole message", "starts" => "message starts with", "contains" => "message contains", _ => "command (?name)" };
    match ev.sub.as_deref().unwrap_or("list") {
        "list" => {
            let mut list: Vec<Value> = d.list("cc:").into_iter().map(|(_, v)| v).collect();
            list.sort_by_key(|c| c["name"].as_str().unwrap_or("").to_lowercase());
            let lines: Vec<String> = list.iter().map(|c| {
                let name = c["name"].as_str().unwrap_or("");
                let t = c["trigger"].as_str().unwrap_or("command");
                format!("{} · used {}×", if t == "command" { format!("`{first}{name}`") } else { format!("**{}** · {}", c["phrase"].as_str().unwrap_or(name), words(t)) }, c["uses"].as_i64().unwrap_or(0))
            }).collect();
            vec![Action::Reply { card: Card::new(Area::General).title(format!("📝 Custom commands · {}", list.len())).line(if lines.is_empty() { "None yet. Staff can add one with `/tags add`.".to_string() } else { short(&lines.join("\n"), 3500) }).private() }]
        }
        "use" => {
            let Some(c) = d.get(&key_of(arg("name").unwrap_or(""))) else { return private("There is no custom command with that name. See `/tags list`.") };
            let uses = c["uses"].as_i64().unwrap_or(0) + 1;
            let mut saved = c.clone();
            saved["uses"] = json!(uses);
            d.set(&key_of(c["name"].as_str().unwrap_or("")), &saved);
            let who = Who { id: &ev.member.id, name: &ev.member.name, channel: &ev.place.channel, server, members, at_ms: ev.at_ms };
            vec![Action::Reply { card: render(&c, &who, arg("args").unwrap_or(""), uses, roll) }]
        }
        sub => {
            if !perms::allowed(db, &ev.guild, &ev.member, MANAGE) { return private("You don't have permission for that (`tags.manage`)."); }
            if sub == "remove" {
                let name = arg("name").unwrap_or("");
                if d.get(&key_of(name)).is_none() { return private("There is no custom command with that name."); }
                d.delete(&key_of(name));
                return private(format!("🗑️ Removed **{name}**."));
            }
            let name = arg("name").unwrap_or("").trim().trim_start_matches(['?', '!', '.', '-', '$']).to_string();
            let count = name.chars().count();
            if !(1..=32).contains(&count) || !name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') { return private("The name can be up to 32 letters, numbers, - or _ (no spaces)."); }
            let response = arg("response").unwrap_or("").trim();
            if response.is_empty() { return private("Write what the bot should reply."); }
            let existing = d.get(&key_of(&name));
            if existing.is_none() && d.list("cc:").len() >= MAX { return private(format!("You can have up to {MAX} custom commands.")); }
            let trigger = arg("trigger").filter(|t| ["command", "exact", "starts", "contains"].contains(t)).unwrap_or("command");
            let old = existing.clone().unwrap_or(Value::Null);
            let cmd = json!({
                "name": name, "trigger": trigger, "phrase": arg("phrase").map(|p| short(p.trim(), 100)).filter(|p| !p.is_empty()),
                "response": response.chars().take(2000).collect::<String>(), "title": arg("embed_title").map(|t| t.chars().take(256).collect::<String>()), "color": null,
                "cooldown": arg("cooldown").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0).clamp(0, 3600), "channels": old.get("channels").cloned().unwrap_or_else(|| json!([])), "deleteTrigger": false,
                "uses": old["uses"].as_i64().unwrap_or(0), "by": ev.member.id, "at": ev.at_ms, "from": old.get("from").cloned().unwrap_or(Value::Null),
            });
            d.set(&key_of(&name), &cmd);
            let how = if trigger == "command" { format!("Type `{first}{name}`") } else { format!("It replies when a {} **{}**", words(trigger), cmd["phrase"].as_str().unwrap_or(&name)) };
            private(format!("✅ {} **{name}**. {how}.", if existing.is_some() { "Updated" } else { "Added" }))
        }
    }
}
