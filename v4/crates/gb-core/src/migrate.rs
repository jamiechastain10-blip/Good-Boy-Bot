//! /migrate (Good Boy 3's 2.3 and 3.0): move from other bots to Good Boy without setting everything up again.
//!
//! Other bots keep their settings on their own servers, and none of them let another bot read them. So Good Boy
//! looks at what they left behind in this server, which Discord does let it read: reaction-role messages and button
//! role menus, log channels, the starboard, welcome and goodbye messages, counter channels, custom commands members
//! used, the ban list, and MEE6's public leaderboard. The Discord side reads the server (`ScanInput`); this file
//! works out what was found, shows it, and applies what staff pick. Nothing changes during the scan.
//! `/migrate tags` takes custom commands pasted in, because no bot lets those be read.

use crate::bot::{Bot, CommandSpec, Opt, Sub, Takes};
use crate::store::Data;
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Select};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;

pub const MODULE: &str = crate::notify::MODULE;
pub const MEE6_ID: &str = "159985870458322944";
/// Bots this replaces, by their public ids. Medal is left alone on purpose.
pub const KNOWN_BOTS: &[(&str, &str)] = &[
    ("235148962103951360", "Carl-bot"), ("204255221017214977", "YAGPDB"), ("491769129318088714", "Statbot"), ("513423712582762502", "TTS Bot"),
    ("368521195940741122", "Lawliet"), (MEE6_ID, "MEE6"), ("155149108183695360", "Dyno"), ("437808476106784770", "Arcane"), ("172002275412279296", "Tatsu"), ("282859044593598464", "ProBot"),
];
/// How many messages are read in each channel, and how long the whole scan may take.
pub const PER_CHANNEL: usize = 1000;
pub const TIME_BUDGET_MS: i64 = 10 * 60_000;

pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "migrate", about: "Move from Carl-bot, MEE6, Dyno, YAGPDB and others without setting everything up again (admins)", module: MODULE, options: &[], subs: &[
    Sub { name: "scan", about: "Look at what the old bots left in this server and pick what to bring over (nothing changes yet)", options: &[] },
    Sub { name: "tags", about: "Paste custom commands from another bot: a name on the first line, the reply under it, --- between them", options: &[
        Opt { name: "text", about: "name, then the reply under it; --- on its own line between commands", takes: Takes::Text, required: true },
    ] },
] }];

/// A button or dropdown option: (custom id or value, label, emoji as text, emoji key).
pub type Part = (String, Option<String>, Option<String>, Option<String>);
type Seen = HashMap<String, (usize, String)>;
/// One message as the scan saw it.
#[derive(Debug, Clone, Default)]
pub struct ScanMsg {
    pub id: String,
    pub channel: String,
    pub author: String,
    pub author_bot: bool,
    pub at: i64,
    pub content: String,
    /// Each embed's author, title, description, fields and footer, one after another.
    pub embed_text: String,
    /// The first embed's title and description (what a bot "said" in a box).
    pub embed_title: Option<String>,
    pub embed_description: Option<String>,
    /// The emojis people reacted with: a custom emoji's id, or the emoji itself.
    pub reactions: Vec<String>,
    /// Buttons and dropdown options: (custom id or value, label, emoji as text, emoji key).
    pub components: Vec<Part>,
    /// The message this one replies to.
    pub reply_to: Option<String>,
    /// The slash command that made this message, if any.
    pub used: Option<String>,
}
/// Everything the scan read from the server.
#[derive(Debug, Clone, Default)]
pub struct ScanInput {
    pub server: String,
    pub members: u64,
    /// Bots in the server: (id, username).
    pub bots: Vec<(String, String)>,
    /// Roles: (id, name, made by an app).
    pub roles: Vec<(String, String, bool)>,
    /// Text channels and threads: (id, name).
    pub channels: Vec<(String, String)>,
    /// Voice channels: (id, name).
    pub voice: Vec<(String, String)>,
    pub messages: Vec<ScanMsg>,
    /// (user id, name, reason)
    pub bans: Vec<(String, String, Option<String>)>,
    /// Roles an old bot gave people within a minute of them joining: (role id, how many times).
    pub join_roles: Vec<(String, u32)>,
    /// MEE6's public leaderboard: Ok(players) or Err("private" / why).
    pub mee6: Option<Result<Vec<Mee6Player>, String>>,
    pub scanned_channels: usize,
    pub total_channels: usize,
    pub unreadable: Vec<String>,
    pub stopped_early: bool,
}
#[derive(Debug, Clone, Default)]
pub struct Mee6Player { pub id: String, pub name: String, pub xp: i64, pub level: i64, pub messages: i64 }

/// The old bots among the server's bots.
pub fn old_bots(bots: &[(String, String)], me: Option<&str>) -> Vec<(String, String)> {
    static NAME: OnceLock<Regex> = OnceLock::new();
    let name_re = NAME.get_or_init(|| Regex::new(r"(?i)carl|yagpdb|statbot|tts|lawliet|mee6|dyno|arcane|tatsu|probot").unwrap());
    bots.iter().filter(|(id, name)| Some(id.as_str()) != me && (KNOWN_BOTS.iter().any(|(k, _)| k == id) || (name_re.is_match(name) && !name.to_lowercase().contains("medal"))))
        .map(|(id, name)| (id.clone(), KNOWN_BOTS.iter().find(|(k, _)| k == id).map(|(_, n)| n.to_string()).unwrap_or_else(|| name.clone()))).collect()
}

fn emoji_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"<a?:\w+:(\d+)>|([0-9#*]\x{FE0F}?\x{20E3}|\p{Extended_Pictographic}(?:\x{FE0F}|\p{Emoji_Modifier}|\x{200D}\p{Extended_Pictographic})*)").unwrap())
}
fn norm(s: &str) -> String { s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect() }
fn edit_distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() { cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + usize::from(a[i - 1] != b[j - 1])); }
        prev = cur;
    }
    prev[b.len()]
}
/// The role a piece of text names: exact (ignoring case, spaces and symbols), then one name containing the other,
/// then a small typo in a longer name.
pub fn role_by_name(roles: &[(String, String, bool)], guild: &str, text: &str) -> Option<String> {
    let t = norm(text);
    if t.chars().count() < 2 { return None; }
    let roles: Vec<&(String, String, bool)> = roles.iter().filter(|r| r.0 != guild && !r.2).collect();
    if let Some(r) = roles.iter().find(|r| norm(&r.1) == t) { return Some(r.0.clone()); }
    let close: Vec<_> = roles.iter().filter(|r| { let n = norm(&r.1); n.chars().count() >= 3 && (t.contains(&n) || n.contains(&t)) }).collect();
    if close.len() == 1 { return Some(close[0].0.clone()); }
    let near: Vec<_> = roles.iter().filter(|r| { let n = norm(&r.1); n.chars().count() >= 6 && n.chars().count().abs_diff(t.chars().count()) <= 2 && edit_distance(&n, &t) <= 2 }).collect();
    if near.len() == 1 { Some(near[0].0.clone()) } else { None }
}
/// Lines like "🎮 : @Gamer" or "<:valo:123> Valorant players - <@&456>" → (emoji key, emoji, role id).
pub fn role_pairs(text: &str, roles: &[(String, String, bool)], guild: &str) -> Vec<(String, String, String)> {
    static MENTION: OnceLock<Regex> = OnceLock::new();
    let mention = MENTION.get_or_init(|| Regex::new(r"<@&(\d{17,20})>").unwrap());
    let mut out = Vec::new();
    for line in text.lines() {
        let Some(c) = emoji_re().captures(line) else { continue };
        let whole = c.get(0).map(|m| m.as_str().to_string()).unwrap_or_default();
        let key = c.get(1).or_else(|| c.get(2)).map(|m| m.as_str().to_string()).unwrap_or_default();
        let role = mention.captures(line).and_then(|m| m.get(1)).map(|m| m.as_str().to_string()).filter(|r| roles.iter().any(|x| &x.0 == r))
            .or_else(|| { let rest: String = emoji_re().replace_all(line, "").chars().map(|c| if "-:=→>|*_~`".contains(c) { ' ' } else { c }).collect(); role_by_name(roles, guild, rest.trim()) });
        if let Some(role) = role { if !key.is_empty() { out.push((key, whole, role)); } }
    }
    out
}
/// The role a button or dropdown option stands for: a role id inside its id or value, or a role named like its label.
fn role_of_component(roles: &[(String, String, bool)], guild: &str, id: &str, label: Option<&str>) -> Option<String> {
    static IDS: OnceLock<Regex> = OnceLock::new();
    let ids = IDS.get_or_init(|| Regex::new(r"\d{17,20}").unwrap());
    for m in ids.find_iter(id) { if roles.iter().any(|r| r.0 == m.as_str() && r.0 != guild) { return Some(m.as_str().to_string()); } }
    label.and_then(|l| role_by_name(roles, guild, l))
}
/// The old message's own heading and text (everything that is not an emoji-to-role line), for the new menu.
fn header_of(m: &ScanMsg) -> (String, Option<String>) {
    let all = format!("{}\n{}", m.content, m.embed_description.clone().unwrap_or_default());
    let mut lines: Vec<&str> = all.lines().map(str::trim).filter(|l| !l.is_empty() && !(emoji_re().is_match(l) && emoji_re().replace_all(l, "").trim().chars().count() < 60 && l.chars().any(char::is_alphabetic))).collect();
    let title = m.embed_title.clone().or_else(|| if lines.is_empty() { None } else { Some(lines.remove(0).to_string()) }).unwrap_or_else(|| "Pick your roles".into()).replace("**", "");
    let desc = lines.join("\n");
    (title.chars().take(200).collect(), if desc.is_empty() { None } else { Some(desc.chars().take(1500).collect()) })
}
fn short(s: &str, n: usize) -> String { if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n.saturating_sub(1)).collect::<String>()) } }
fn plural(n: usize, one: &str) -> String { format!("{n} {one}{}", if n == 1 { "" } else { "s" }) }

/// Built-in commands of the old bots: Good Boy has its own versions, so they are not learned as custom commands.
const BUILTIN: &str = "help commands ping rank level levels xp leaderboard lb top daily balance bal pay warn warnings ban unban kick mute unmute timeout untimeout purge clear prune remind reminder reminders poll suggest suggestion giveaway gstart tag tags t tagcreate avatar av userinfo whois serverinfo info say embed rr reactionrole role roles afk slowmode lock unlock nick nickname play skip stop queue np pause resume join leave tts voice rep cases modlogs case note notes reason starboard automod config prefix settings setup";
/// What to use in Good Boy for a command members used with the old bot (None: Good Boy has no such command).
fn good_boy_for(word: &str) -> Option<Option<&'static str>> {
    Some(match word {
        "rank" | "level" => Some("/rank"), "levels" | "leaderboard" | "lb" => Some("/leaderboard"), "top" => Some("/money top"), "daily" => Some("/money daily"), "balance" | "bal" => Some("/money balance"), "pay" => Some("/money pay"),
        "warn" => Some("/mod warn"), "warnings" | "cases" | "modlogs" => Some("/mod modhistory"), "ban" => Some("/mod ban"), "unban" => Some("/mod unban"), "kick" => Some("/mod kick"), "mute" | "timeout" => Some("/mod timeout"), "unmute" => Some("/mod untimeout"),
        "purge" | "clear" | "prune" => Some("/mod purge"), "remind" | "reminder" => Some("/remind me"), "poll" => Some("/poll create"), "suggest" => Some("/suggest"), "afk" => Some("/me afk"), "say" | "embed" => Some("/server say"),
        "rr" | "reactionrole" => Some("/roles rolemenu"), "rep" => Some("/community rep"), "tts" => Some("/voice tts"), "join" => Some("/voice tts"), "leave" => Some("/voice tts"), "starboard" => Some("/starboard"), "tag" => Some("custom commands (?name)"), "tags" => Some("/server tags"),
        "serverinfo" => Some("/community serverstats"), "userinfo" => Some("/me id"), "stats" => Some("/community stats"), "counter" => Some("/community counter"), "play" | "skip" | "queue" | "np" => Some("/music"), "giveaway" | "gstart" => Some("/giveaway start"),
        "avatar" | "av" => None,
        _ => return None,
    })
}

/// What the scan found: one thing that can be brought over (or, with `info`, only shown).
pub fn findings(input: &ScanInput, guild: &str, me: Option<&str>) -> Vec<Value> {
    static CMD: OnceLock<Regex> = OnceLock::new();
    static STAR: OnceLock<Regex> = OnceLock::new();
    static CHAN: OnceLock<Regex> = OnceLock::new();
    static USER: OnceLock<Regex> = OnceLock::new();
    let cmd_re = CMD.get_or_init(|| Regex::new(r"^([?!.\-$+;~>])([\p{L}\p{N}_-]{1,32})(?:\s+([\s\S]*))?$").unwrap());
    let star_re = STAR.get_or_init(|| Regex::new(r"(?:⭐|🌟|✨)\s*\**(\d+)\**").unwrap());
    let chan_re = CHAN.get_or_init(|| Regex::new(r"<#\d+>").unwrap());
    let user_re = USER.get_or_init(|| Regex::new(r"<@!?(\d{17,20})>").unwrap());
    let logs: &[(&str, Regex)] = &[
        ("logMessages", Regex::new(r"(?i)message (was )?(deleted|edited|updated)|deleted message|edited message|(deleted|edited) in (<#\d+>|#)").unwrap()),
        ("logJoins", Regex::new(r"(?i)member (joined|left)|user (joined|left)|joined the server|left the server").unwrap()),
        ("logRoles", Regex::new(r"(?i)roles? (added|removed|updated|changed)|role (given|taken)").unwrap()),
        ("logNicknames", Regex::new(r"(?i)nickname").unwrap()),
        ("logVoice", Regex::new(r"(?i)(joined|left|moved|switched).{0,12}voice|voice (join|leave|move)").unwrap()),
    ];
    let bots = old_bots(&input.bots, me);
    let bot_name: HashMap<&str, &str> = bots.iter().map(|(i, n)| (i.as_str(), n.as_str())).collect();
    let chan_name: HashMap<&str, &str> = input.channels.iter().map(|(i, n)| (i.as_str(), n.as_str())).collect();
    let builtin: HashSet<&str> = BUILTIN.split(' ').collect();
    let mut out: Vec<Value> = Vec::new();
    let mut add = |mut f: Value| { f["id"] = json!((out.len() + 1).to_string()); out.push(f); };

    let mut by_channel: BTreeMap<&str, Vec<&ScanMsg>> = BTreeMap::new();
    for m in &input.messages { by_channel.entry(m.channel.as_str()).or_default().push(m); }
    let mut learned: BTreeMap<String, Value> = BTreeMap::new();
    let mut usage: HashMap<String, usize> = HashMap::new();
    let mut log_hits: HashMap<&str, HashMap<String, usize>> = HashMap::new();
    let (mut welcome, mut goodbye, mut star): (Seen, Seen, HashMap<String, (usize, i64)>) = Default::default();
    for (ch, list) in by_channel.iter_mut() {
        list.sort_by_key(|m| m.at);
        let cname = chan_name.get(ch).copied().unwrap_or("channel");
        for (k, um) in list.iter().enumerate() {
            if let Some(used) = &um.used { if let Some(n) = bot_name.get(um.author.as_str()) { *usage.entry(format!("{n}|/{used}")).or_default() += 1; } }
            if um.author_bot { continue; }
            let Some(c) = cmd_re.captures(um.content.trim()) else { continue };
            let prefix = c.get(1).map(|m| m.as_str()).unwrap_or("?");
            let mut name = c.get(2).map(|m| m.as_str().to_lowercase()).unwrap_or_default();
            let rest = c.get(3).map(|m| m.as_str()).unwrap_or("");
            if (name == "tag" || name == "t") && !rest.trim().is_empty() { name = rest.split_whitespace().next().unwrap_or("").to_lowercase(); }
            else if builtin.contains(name.as_str()) { *usage.entry(format!("prefix|{prefix}{name}")).or_default() += 1; continue; }
            // the old bot's answer: a reply to this message, or its next message here within 15 seconds
            let Some(ans) = list.iter().skip(k + 1).take(5).find(|r| bot_name.contains_key(r.author.as_str()) && (r.reply_to.as_deref() == Some(um.id.as_str()) || r.at - um.at < 15_000)) else { continue };
            let text = [Some(ans.content.clone()).filter(|t| !t.is_empty()), ans.embed_title.clone().map(|t| format!("**{t}**")), ans.embed_description.clone()].into_iter().flatten().collect::<Vec<_>>().join("\n").trim().to_string();
            if text.chars().count() < 2 { continue; }
            let count = learned.get(&name).and_then(|v| v["count"].as_u64()).unwrap_or(0) + 1;
            learned.insert(name.clone(), json!({ "name": name, "prefix": prefix, "response": text.chars().take(2000).collect::<String>(), "count": count, "from": bot_name.get(ans.author.as_str()) }));
        }
        for msg in list.iter().filter(|m| bot_name.contains_key(m.author.as_str())) {
            let text = format!("{}\n{}", msg.content, msg.embed_text);
            let from = bot_name.get(msg.author.as_str()).copied().unwrap_or("another bot");
            if !msg.reactions.is_empty() {
                let pairs: Vec<_> = role_pairs(&text, &input.roles, guild).into_iter().filter(|p| msg.reactions.contains(&p.0)).collect();
                if !pairs.is_empty() {
                    add(json!({ "kind": "reactionroles", "title": format!("Reaction roles in #{cname} ({})", plural(pairs.len(), "role")), "detail": format!("{} → Good Boy answers these reactions (the message stays where it is)", pairs.iter().map(|p| format!("{} <@&{}>", p.1, p.2)).collect::<Vec<_>>().join(" ")),
                        "data": { "messageId": msg.id, "channelId": ch, "pairs": pairs.iter().map(|p| json!({ "emojiKey": p.0, "emoji": p.1, "roleId": p.2 })).collect::<Vec<_>>(), "from": from } }));
                }
            } else if !msg.components.is_empty() {
                let mut pairs: Vec<(String, Option<String>)> = Vec::new();
                for (cid, label, emoji, _) in &msg.components {
                    if let Some(r) = role_of_component(&input.roles, guild, cid, label.as_deref()) { if !pairs.iter().any(|p| p.0 == r) { pairs.push((r, emoji.clone())); } }
                }
                if !pairs.is_empty() {
                    let (title, description) = header_of(msg);
                    add(json!({ "kind": "rolemenu", "title": format!("Button role menu in #{cname} ({})", plural(pairs.len(), "role")), "detail": format!("{} → replaced by a Good Boy role menu in the same place", pairs.iter().map(|p| format!("{} <@&{}>", p.1.clone().unwrap_or_else(|| "•".into()), p.0)).collect::<Vec<_>>().join(" ")),
                        "data": { "messageId": msg.id, "channelId": ch, "roles": pairs.iter().map(|p| json!({ "id": p.0, "emoji": p.1 })).collect::<Vec<_>>(), "title": title, "description": description, "from": from } }));
                }
            }
            // logs are boxes from a moderation bot; TTS Bot's voice messages are not logs
            if !msg.embed_text.trim().is_empty() && !from.to_lowercase().contains("tts") {
                for (key, re) in logs { if re.is_match(&msg.embed_text) { *log_hits.entry(key).or_default().entry(ch.to_string()).or_default() += 1; } }
            }
            if let Some(n) = star_re.captures(&msg.content).and_then(|c| c.get(1)).and_then(|n| n.as_str().parse::<i64>().ok()) {
                if chan_re.is_match(&msg.content) { let s = star.entry(ch.to_string()).or_insert((0, 99)); s.0 += 1; s.1 = s.1.min(n); }
            }
            if user_re.is_match(&msg.content) && text.to_lowercase().contains("welcome") { welcome.entry(ch.to_string()).or_insert((0, msg.content.clone())).0 += 1; }
            let low = text.to_lowercase();
            if ["left", "goodbye", "has left", "bye"].iter().any(|w| low.contains(w)) && !low.contains("voice") && !logs[1].1.is_match(&text) {
                goodbye.entry(ch.to_string()).or_insert((0, if msg.content.is_empty() { msg.embed_description.clone().unwrap_or_default() } else { msg.content.clone() })).0 += 1;
            }
        }
    }
    for m in log_hits.values_mut() { m.retain(|_, n| *n >= 2); }
    log_hits.retain(|_, m| !m.is_empty());
    let top = |m: &HashMap<String, usize>| m.iter().max_by_key(|(_, n)| **n).map(|(c, _)| c.clone());
    if !log_hits.is_empty() {
        let msg_ch = log_hits.get("logMessages").and_then(top);
        let mut other_keys: Vec<&str> = log_hits.keys().copied().filter(|k| *k != "logMessages").collect();
        other_keys.sort();
        let mut merged: HashMap<String, usize> = HashMap::new();
        for k in &other_keys { for (c, n) in &log_hits[k] { *merged.entry(c.clone()).or_default() += n; } }
        let server_ch = top(&merged);
        let what = |k: &str| match k { "logJoins" => "joins/leaves", "logRoles" => "roles", "logNicknames" => "nicknames", _ => "voice" };
        let detail = [msg_ch.as_ref().map(|c| format!("message edits & deletes in <#{c}>")), server_ch.as_ref().map(|c| format!("{} in <#{c}>", other_keys.iter().map(|k| what(k)).collect::<Vec<_>>().join(", ")))].into_iter().flatten().collect::<Vec<_>>().join(" · ");
        add(json!({ "kind": "logs", "title": "Logging", "detail": detail, "data": { "msgCh": msg_ch, "serverCh": server_ch, "kinds": other_keys } }));
    }
    if let Some((c, (n, min))) = star.iter().max_by_key(|(_, s)| s.0) { if *n >= 2 { add(json!({ "kind": "starboard", "title": "Starboard", "detail": format!("<#{c}>, {min} stars needed"), "data": { "channelId": c, "threshold": (*min).clamp(1, 50) } })); } }
    let template = |s: &str| {
        let t = user_re.replace_all(s, "{user}").to_string();
        let t = if input.server.is_empty() { t } else { t.replace(&input.server, "{server}") };
        let t = if input.members > 0 { Regex::new(&format!(r"\b{}\b", input.members)).map(|r| r.replace_all(&t, "{count}").to_string()).unwrap_or(t) } else { t };
        t.chars().take(500).collect::<String>()
    };
    if let Some((c, (n, sample))) = welcome.iter().max_by_key(|(_, w)| w.0) { if *n >= 2 { add(json!({ "kind": "welcome", "title": "Welcome messages", "detail": format!("<#{c}>: “{}”", short(&template(sample), 120)), "data": { "channelId": c, "message": template(sample) } })); } }
    if let Some((c, (n, sample))) = goodbye.iter().max_by_key(|(_, w)| w.0) { if *n >= 2 { add(json!({ "kind": "goodbye", "title": "Goodbye messages", "detail": format!("<#{c}>"), "data": { "channelId": c, "message": template(sample).replacen("{user}", "**{username}**", 1) } })); } }
    if !learned.is_empty() {
        let mut list: Vec<Value> = learned.into_values().collect();
        list.sort_by_key(|t| std::cmp::Reverse(t["count"].as_u64().unwrap_or(0)));
        let names = list.iter().take(15).map(|t| format!("`{}{}`", t["prefix"].as_str().unwrap_or("?"), t["name"].as_str().unwrap_or(""))).collect::<Vec<_>>().join(" ");
        add(json!({ "kind": "tags", "title": format!("Custom commands learned from chat ({})", list.len()), "detail": format!("{names}{} → work the same in Good Boy", if list.len() > 15 { " …" } else { "" }), "data": { "tags": list } }));
    }
    if !usage.is_empty() {
        let mut rows: Vec<(String, usize)> = usage.into_iter().collect();
        rows.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let detail = rows.iter().take(12).map(|(k, n)| {
            let cmd = k.split_once('|').map(|x| x.1).unwrap_or(k);
            let word: String = cmd.trim_start_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
            let word = word.split_whitespace().next().unwrap_or("").to_string();
            let gb = match good_boy_for(&word) { Some(Some(g)) => format!("**{g}**"), Some(None) => "*no Good Boy version*".into(), None => "*check /help*".into() };
            format!("`{cmd}` {n}× → {gb}")
        }).collect::<Vec<_>>().join(" · ");
        add(json!({ "kind": "usage", "info": true, "title": "Commands your members used", "detail": detail, "data": {} }));
    }
    let join_roles: Vec<&String> = input.join_roles.iter().filter(|(r, n)| *n >= 2 && input.roles.iter().any(|x| &x.0 == r)).map(|(r, _)| r).collect();
    if !join_roles.is_empty() { add(json!({ "kind": "autoroles", "title": "Roles given on join", "detail": join_roles.iter().map(|r| format!("<@&{r}>")).collect::<Vec<_>>().join(" "), "data": { "roles": join_roles } })); }
    let counters: Vec<Value> = input.voice.iter().filter(|(_, n)| n.chars().any(|c| c.is_ascii_digit())).filter_map(|(id, name)| {
        let low = name.to_lowercase();
        let kind = if low.contains("online") { "online" } else if low.contains("boost") { "boosts" } else if low.contains("bot") { "bots" } else if low.contains("human") || low.contains("people") { "humans" } else if low.contains("member") || low.contains("user") || low.contains("total") { "members" } else { return None };
        static NUM: OnceLock<Regex> = OnceLock::new();
        let num = NUM.get_or_init(|| Regex::new(r"\d[\d,.]*").unwrap());
        Some(json!({ "channelId": id, "template": num.replace(name, format!("{{{kind}}}").as_str()).to_string() }))
    }).collect();
    if !counters.is_empty() { add(json!({ "kind": "counters", "title": "Counter channels", "detail": counters.iter().map(|c| format!("<#{}> → `{}`", c["channelId"].as_str().unwrap_or(""), c["template"].as_str().unwrap_or(""))).collect::<Vec<_>>().join(", "), "data": { "counters": counters } })); }
    if !input.bans.is_empty() {
        let with = input.bans.iter().filter(|b| b.2.is_some()).count();
        add(json!({ "kind": "bans", "title": "Ban list", "detail": format!("{}{} → copied into /mod modhistory", plural(input.bans.len(), "ban"), if with > 0 { format!(", {with} with reasons") } else { String::new() }),
            "data": { "bans": input.bans.iter().take(1000).map(|b| json!({ "id": b.0, "tag": b.1, "reason": b.2 })).collect::<Vec<_>>() } }));
    }
    match &input.mee6 {
        Some(Ok(players)) if !players.is_empty() => add(json!({ "kind": "levels", "title": format!("Levels from MEE6 ({} members)", players.len()), "detail": format!("Top: {} → the same levels in Good Boy (nobody goes down)", players.iter().take(3).map(|p| format!("{} level {}", if p.name.is_empty() { &p.id } else { &p.name }, p.level)).collect::<Vec<_>>().join(", ")),
            "data": { "from": "MEE6", "players": players.iter().take(10_000).map(|p| json!({ "id": p.id, "xp": p.xp, "messages": p.messages })).collect::<Vec<_>>() } })),
        Some(Err(e)) if e == "private" => add(json!({ "kind": "levels-private", "info": true, "title": "MEE6 levels", "detail": "MEE6's leaderboard for this server is private, so its levels can't be read. Make it public in MEE6's dashboard (Leaderboard, public), scan again, then make it private again.", "data": {} })),
        _ => {}
    }
    out
}

fn report(input: &ScanInput, bots: &[(String, String)], list: &[Value], by: &str) -> Card {
    let mut card = Card::new(Area::General).title("🔁 Move to Good Boy").private();
    card.accent = Some(0x5865f2);
    card = card.line([
        if bots.is_empty() { "I found none of the bots Good Boy replaces (Carl-bot, MEE6, Dyno, YAGPDB, Statbot, TTS Bot, Lawliet, Arcane, Tatsu, ProBot). Medal is left alone.".to_string() } else { format!("Found: {}.", bots.iter().map(|b| format!("**{}**", b.1)).collect::<Vec<_>>().join(", ")) },
        format!("Read **{}** messages in {} of {} channels and threads (up to {PER_CHANNEL} per channel).{}", input.messages.len(), input.scanned_channels, input.total_channels, if input.stopped_early { " I stopped after 10 minutes; run the scan again to finish." } else { "" }),
        if input.unreadable.is_empty() { String::new() } else { format!("I couldn't read {} (give me View Channel and Read Message History there).", plural(input.unreadable.len(), "channel")) },
        if list.iter().any(|f| f["info"] != true) { "Here is what they left behind that I can set up for you. **Nothing has changed yet.** Pick what to bring over:".to_string() } else { "I found nothing to bring over automatically.".to_string() },
    ].into_iter().filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n"));
    let mut body = String::new();
    for f in list {
        let line = format!("{} **{}** · {}\n", if f["info"] == true { "ℹ️".to_string() } else { format!("`{}`", f["id"].as_str().unwrap_or("")) }, f["title"].as_str().unwrap_or(""), short(f["detail"].as_str().unwrap_or(""), 400));
        if body.len() + line.len() > 1800 { card = card.line(std::mem::take(&mut body)); }
        body.push_str(&line);
    }
    if !body.is_empty() { card = card.line(body); }
    let picks: Vec<&Value> = list.iter().filter(|f| f["info"] != true).collect();
    if !picks.is_empty() {
        card = card.select(Select { id: format!("mig:pick:{by}"), placeholder: "Pick what to bring over".into(), min: 1, max: picks.len().min(25) as u8,
            options: picks.iter().take(25).map(|f| (short(&format!("{}. {}", f["id"].as_str().unwrap_or(""), f["title"].as_str().unwrap_or("")), 100), f["id"].as_str().unwrap_or("").to_string(), None)).collect() });
        card = card.button_with(format!("mig:all:{by}"), "Bring everything over", ButtonStyle::Primary, Some("✅".into()));
    }
    card.line("-# When you're happy, remove the old bots. Custom commands they never answered in chat can be pasted with `/migrate tags`.")
}

/// Custom commands pasted as blocks: a name on the first line, the reply under it, blocks split by ---.
pub fn parse_paste(text: &str) -> Vec<(String, String)> {
    static SEP: OnceLock<Regex> = OnceLock::new();
    let sep = SEP.get_or_init(|| Regex::new(r"(?m)^\s*-{3,}\s*$").unwrap());
    sep.split(text).map(str::trim).filter(|b| !b.is_empty()).filter_map(|block| {
        let (first, rest) = block.split_once('\n').unwrap_or((block, ""));
        let name = first.trim().trim_start_matches(['?', '!', '.', '-', '$']).split_whitespace().next().unwrap_or("").to_string();
        let response = rest.trim().to_string();
        (!name.is_empty() && !response.is_empty()).then_some((name, response))
    }).collect()
}
fn tag_ok(name: &str) -> bool { (1..=32).contains(&name.chars().count()) && name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') }

fn staff(member: &crate::Member) -> bool { member.perms & (crate::perms::ADMINISTRATOR | crate::perms::MANAGE_GUILD) != 0 }
fn private(text: impl Into<String>) -> Vec<Action> { vec![Action::Reply { card: Card::new(Area::General).line(text).private() }] }

impl Bot {
    /// /migrate scan asks the Discord side to read the server; /migrate tags saves pasted custom commands.
    pub(crate) fn migrate_command(&self, ev: &CommandEvent) -> Vec<Action> {
        if !staff(&ev.member) { return private("Only server admins (Manage Server) can use /migrate."); }
        match ev.sub.as_deref() {
            Some("tags") => {
                let list = parse_paste(ev.args.get("text").map(String::as_str).unwrap_or(""));
                if list.is_empty() { return private("I couldn't find any commands in that. Put the name on the first line and the reply under it, with `---` on its own line between commands."); }
                let (saved, skipped) = self.save_tags(&ev.guild, list.into_iter().map(|(n, r)| (n, r, None)).collect(), &ev.member.id, ev.at_ms);
                private(format!("✅ Saved {} as custom commands{}. Members can use them with `?name` (see `/server tags`).", plural(saved, "command"), if skipped > 0 { format!(" ({skipped} skipped: names can be up to 32 letters, numbers, - or _)") } else { String::new() }))
            }
            _ => vec![Action::Migrate { by: ev.member.id.clone() }],
        }
    }
    fn save_tags(&self, guild: &str, list: Vec<(String, String, Option<String>)>, by: &str, now: i64) -> (usize, usize) {
        if !self.module_on(guild, crate::tags::MODULE) { let _ = self.set_module(guild, crate::tags::MODULE, true, now); }
        let d = Data { db: &self.db, guild, module: crate::tags::MODULE };
        let (mut saved, mut skipped) = (0, 0);
        for (name, response, from) in list {
            if !tag_ok(&name) { skipped += 1; continue; }
            let key = format!("cc:{}", name.to_lowercase());
            let old = d.get(&key).unwrap_or(Value::Null);
            d.set(&key, &json!({ "name": name, "trigger": "command", "phrase": null, "response": response.chars().take(2000).collect::<String>(), "title": null, "color": null, "cooldown": 0,
                "channels": old.get("channels").cloned().unwrap_or_else(|| json!([])), "deleteTrigger": false, "uses": old["uses"].as_i64().unwrap_or(0), "by": by, "at": now, "from": from }));
            saved += 1;
        }
        (saved, skipped)
    }
    /// The scan is done: what was found is kept for whoever asked, and shown to them.
    pub fn migrate_scanned(&self, guild: &str, by: &str, input: &ScanInput, now: i64) -> Card {
        let me = self.directory.me();
        let bots = old_bots(&input.bots, me.as_deref());
        let list = findings(input, guild, me.as_deref());
        Data { db: &self.db, guild, module: MODULE }.set(&format!("mig:{by}"), &json!({ "at": now, "findings": list }));
        self.db.seen().note(guild, "setup", &format!("Move to Good Boy: scanned {} messages, found {}", input.messages.len(), plural(list.iter().filter(|f| f["info"] != true).count(), "thing")));
        report(input, &bots, &list, by)
    }
    /// `mig:` buttons: bring everything over, or what was picked.
    pub(crate) fn migrate_button(&self, ev: &ButtonEvent) -> Vec<Action> {
        let parts: Vec<&str> = ev.id.split(':').collect();
        let (what, owner) = match parts.as_slice() { ["mig", w, o] => (*w, *o), _ => return private("That button is from an older message. Run `/migrate scan` again.") };
        if owner != ev.member.id { return private("That belongs to someone else. Run `/migrate scan` yourself."); }
        if !staff(&ev.member) { return private("Only server admins (Manage Server) can use /migrate."); }
        let d = Data { db: &self.db, guild: &ev.guild, module: MODULE };
        let Some(saved) = d.get(&format!("mig:{owner}")) else { return private("That scan is gone. Run `/migrate scan` again.") };
        if ev.at_ms - saved["at"].as_i64().unwrap_or(0) > 6 * 3_600_000 { return private("That scan is more than six hours old. Run `/migrate scan` again so nothing is out of date."); }
        let list = saved["findings"].as_array().cloned().unwrap_or_default();
        let picked: Vec<&Value> = list.iter().filter(|f| f["info"] != true && (what == "all" || ev.values.iter().any(|v| f["id"].as_str() == Some(v.as_str())))).collect();
        if picked.is_empty() { return private("Pick at least one thing to bring over."); }
        let mut lines = Vec::new();
        let mut actions = Vec::new();
        for f in picked {
            match self.apply_finding(&ev.guild, f, &ev.member.id, ev.at_ms) {
                Ok((line, mut more)) => { lines.push(format!("✅ {line}")); actions.append(&mut more); }
                Err(why) => lines.push(format!("❌ {}: {why}", f["title"].as_str().unwrap_or(""))),
            }
        }
        d.delete(&format!("mig:{owner}"));
        self.db.seen().note(&ev.guild, "setup", &format!("Move to Good Boy: brought over {}", plural(lines.iter().filter(|l| l.starts_with('✅')).count(), "thing")));
        let card = Card::new(Area::General).title("🔁 Moved to Good Boy").line(lines.join("\n")).line("-# Check everything works, then you can remove the old bots.").private();
        let mut out = vec![Action::Update { card }];
        out.append(&mut actions);
        out
    }
    fn apply_finding(&self, guild: &str, f: &Value, by: &str, now: i64) -> Result<(String, Vec<Action>), String> {
        let data = &f["data"];
        let s = |module: &str, key: &str, v: Value| self.settings.set(guild, module, key, &v).map(|_| ()).map_err(|e| e.to_string());
        let enable = |module: &'static str| -> Vec<Action> { if self.module_on(guild, module) { Vec::new() } else { self.set_module(guild, module, true, now).unwrap_or_default() } };
        let str_of = |v: &Value| v.as_str().unwrap_or("").to_string();
        match f["kind"].as_str().unwrap_or("") {
            "reactionroles" => {
                let more = enable(crate::roles::MODULE);
                let d = Data { db: &self.db, guild, module: crate::roles::MODULE };
                let pairs = data["pairs"].as_array().cloned().unwrap_or_default();
                for p in &pairs { d.set(&format!("rr:{}:{}", str_of(&data["messageId"]), crate::roles::emoji_key(&str_of(&p["emojiKey"]))), &json!(str_of(&p["roleId"]))); }
                Ok((format!("Reaction roles in <#{}>: Good Boy now answers {} on that message. Members keep the roles they have.", str_of(&data["channelId"]), plural(pairs.len(), "reaction")), more))
            }
            "rolemenu" => {
                let mut more = enable(crate::roles::MODULE);
                let roles = data["roles"].as_array().cloned().unwrap_or_default();
                let ids: Vec<String> = roles.iter().map(|r| str_of(&r["id"])).filter(|r| self.directory.role(guild, r).is_some()).collect();
                if ids.is_empty() { return Err("the roles on that menu are gone".into()); }
                let emojis: serde_json::Map<String, Value> = roles.iter().filter_map(|r| Some((str_of(&r["id"]), json!(r["emoji"].as_str()?)))).collect();
                let channel = str_of(&data["channelId"]);
                let menu = json!({ "roleIds": ids, "emojis": emojis, "mode": "toggle", "type": "buttons", "title": data["title"].as_str().unwrap_or("Pick your roles"), "description": data["description"], "from": data["from"], "max": 0, "needs": null, "hours": 0, "channelId": channel });
                let d = Data { db: &self.db, guild, module: crate::roles::MODULE };
                let token = d.next("pending:counter");
                d.set(&format!("pending:{token}"), &menu);
                more.push(Action::Post { channel: channel.clone(), card: crate::roles::menu_card(&self.directory, guild, &menu, &HashMap::new()), note: format!("rolemenu:{token}"), ping: Vec::new(), roles: Vec::new() });
                more.push(Action::Delete { channel: channel.clone(), message: str_of(&data["messageId"]) });
                Ok((format!("Role menu in <#{channel}>: a Good Boy menu with {} is posted and the old one removed (if I can't delete it, give me Manage Messages there or delete it yourself). Members keep the roles they have.", plural(ids.len(), "role")), more))
            }
            "logs" => {
                let more = enable(crate::moderation::MODULE);
                let m = crate::moderation::MODULE;
                if let Some(c) = data["msgCh"].as_str() { s(m, "logChannel", json!(c))?; s(m, "logMessages", json!(true))?; }
                if let Some(c) = data["serverCh"].as_str() { s(m, "serverLogChannel", json!(c))?; for k in data["kinds"].as_array().into_iter().flatten() { if let Some(k) = k.as_str() { s(m, k, json!(true))?; } } }
                Ok(("Logging channels".into(), more))
            }
            "starboard" => {
                let more = enable(crate::engagement::MODULE);
                let m = crate::engagement::MODULE;
                s(m, "starboardChannel", data["channelId"].clone())?; s(m, "starThreshold", data["threshold"].clone())?; s(m, "starEnabled", json!(true))?;
                Ok(("Starboard".into(), more))
            }
            k @ ("welcome" | "goodbye") => {
                let more = enable(crate::welcome::MODULE);
                let m = crate::welcome::MODULE;
                s(m, &format!("{k}Channel"), data["channelId"].clone())?; s(m, &format!("{k}Message"), json!(short(data["message"].as_str().unwrap_or(""), 1900)))?; s(m, &format!("{k}Enabled"), json!(true))?;
                Ok((if k == "welcome" { "Welcome messages".into() } else { "Goodbye messages".into() }, more))
            }
            "autoroles" => {
                let more = enable(crate::roles::MODULE);
                let d = Data { db: &self.db, guild, module: crate::roles::MODULE };
                let mut have: Vec<Value> = d.get("autorole:members").and_then(|v| v.as_array().cloned()).unwrap_or_default();
                let new: Vec<Value> = data["roles"].as_array().cloned().unwrap_or_default();
                for r in &new { if !have.contains(r) { have.push(r.clone()); } }
                d.set("autorole:members", &Value::Array(have));
                Ok((format!("Roles given on join: {}", new.len()), more))
            }
            "counters" => {
                let more = enable(crate::stats::MODULE);
                let d = Data { db: &self.db, guild, module: crate::stats::MODULE };
                let list = data["counters"].as_array().cloned().unwrap_or_default();
                for c in &list { d.set(&format!("counter:{}", str_of(&c["channelId"])), &json!({ "template": c["template"], "by": "migrate" })); }
                Ok((format!("Counters: {}", list.len()), more))
            }
            "tags" => {
                let list: Vec<(String, String, Option<String>)> = data["tags"].as_array().into_iter().flatten().map(|t| (str_of(&t["name"]), str_of(&t["response"]), t["from"].as_str().map(str::to_string))).collect();
                let first = list.first().map(|t| t.0.clone()).unwrap_or_else(|| "name".into());
                let (n, _) = self.save_tags(guild, list, by, now);
                Ok((format!("Custom commands: {n} learned (try `?{first}`)"), Vec::new()))
            }
            "bans" => {
                let more = enable(crate::moderation::MODULE);
                let d = Data { db: &self.db, guild, module: crate::moderation::MODULE };
                let mut n = 0;
                for b in data["bans"].as_array().into_iter().flatten() {
                    let key = format!("hist:{}", str_of(&b["id"]));
                    let mut hist = d.get(&key).and_then(|v| v.as_array().cloned()).unwrap_or_default();
                    if hist.iter().any(|h| h["type"] == "ban" && h["imported"] == true) { continue; }
                    let id = d.next("counter");
                    hist.insert(0, json!({ "id": id, "type": "ban", "targetId": b["id"], "targetTag": b["tag"], "modId": null, "reason": b["reason"].as_str().unwrap_or("Imported (no reason recorded)"), "at": now, "imported": true }));
                    hist.truncate(100);
                    d.set(&key, &Value::Array(hist));
                    n += 1;
                }
                Ok((format!("Bans copied: {n}"), more))
            }
            "levels" => {
                // MEE6 and Good Boy use the same XP formula, so XP is copied as it is. Nobody loses XP: the higher number is kept.
                let more = enable(crate::levels::MODULE);
                let d = Data { db: &self.db, guild, module: crate::levels::MODULE };
                let players = data["players"].as_array().cloned().unwrap_or_default();
                let mut raised = 0;
                for p in &players {
                    let key = format!("user:{}", str_of(&p["id"]));
                    let mut u = d.get(&key).filter(|v| v.is_object()).unwrap_or_else(|| json!({ "xp": 0, "messages": 0, "rep": 0, "lastXp": 0, "lastRep": 0 }));
                    let xp = p["xp"].as_i64().unwrap_or(0);
                    if u["xp"].as_i64().unwrap_or(0) >= xp { continue; }
                    u["xp"] = json!(xp);
                    u["messages"] = json!(u["messages"].as_i64().unwrap_or(0).max(p["messages"].as_i64().unwrap_or(0)));
                    d.set(&key, &u);
                    raised += 1;
                }
                Ok((format!("Levels from {}: {} moved up to their old level ({} were already level with it or higher)", data["from"].as_str().unwrap_or("the old bot"), plural(raised, "member"), players.len() - raised), more))
            }
            _ => Err("I don't know how to bring that over".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const G: &str = "100000000000000000";
    fn roles() -> Vec<(String, String, bool)> {
        vec![(G.into(), "@everyone".into(), false), ("200000000000000001".into(), "Gamer".into(), false), ("200000000000000002".into(), "Valorant players".into(), false), ("200000000000000003".into(), "Siege".into(), false), ("200000000000000009".into(), "Carl-bot".into(), true)]
    }
    #[test]
    fn reads_role_lines() {
        let p = role_pairs("Pick a role!\n🎮 : @Gamer\n<:valo:123456789012345678> Valorant players\n🛡️ - <@&200000000000000003>", &roles(), G);
        assert_eq!(p.len(), 3);
        assert_eq!(p[0].0, "🎮"); assert_eq!(p[0].2, "200000000000000001");
        assert_eq!(p[1].0, "123456789012345678"); assert_eq!(p[1].2, "200000000000000002");
        assert_eq!(p[2].2, "200000000000000003");
        assert_eq!(role_by_name(&roles(), G, "Seige"), None); // too short for typo matching (5 letters)
        assert_eq!(role_by_name(&roles(), G, "carl-bot"), None); // app roles are never picked
    }
    #[test]
    fn pasted_tags() {
        let t = parse_paste("?rules\nBe nice.\n---\nfaq\nRead #faq\n---\nempty\n");
        assert_eq!(t, vec![("rules".to_string(), "Be nice.".to_string()), ("faq".to_string(), "Read #faq".to_string())]);
    }
    #[test]
    fn finds_what_old_bots_left() {
        let carl = "235148962103951360".to_string();
        let msg = |id: &str, ch: &str, author: &str, bot: bool, at: i64, content: &str| ScanMsg { id: id.into(), channel: ch.into(), author: author.into(), author_bot: bot, at, content: content.into(), ..Default::default() };
        let mut rr = msg("1", "c1", &carl, true, 1, "🎮 Gamer\n<:valo:123456789012345678> Valorant players");
        rr.reactions = vec!["🎮".into(), "123456789012345678".into()];
        let mut log1 = msg("2", "c2", &carl, true, 2, ""); log1.embed_text = "Message deleted in <#5>".into();
        let mut log2 = msg("3", "c2", &carl, true, 3, ""); log2.embed_text = "Member joined".into();
        let mut log3 = msg("4", "c2", &carl, true, 4, ""); log3.embed_text = "Message edited in <#5>".into();
        let mut log4 = msg("5", "c2", &carl, true, 5, ""); log4.embed_text = "Member left".into();
        let ask = msg("6", "c3", "300000000000000001", false, 10, "?rules");
        let mut answer = msg("7", "c3", &carl, true, 11, "Be nice to everyone."); answer.reply_to = Some("6".into());
        let mut menu = msg("8", "c4", &carl, true, 12, "Pick your games");
        menu.components = vec![("rr:200000000000000003".into(), Some("Siege".into()), Some("🛡️".into()), Some("🛡️".into())), ("x".into(), Some("Gamer".into()), None, None)];
        let input = ScanInput { server: "Ghost Town".into(), members: 50, bots: vec![(carl.clone(), "Carl-bot".into()), ("999".into(), "Medal".into())], roles: roles(),
            channels: vec![("c1".into(), "roles".into()), ("c2".into(), "logs".into()), ("c3".into(), "chat".into()), ("c4".into(), "games".into())], voice: vec![("v1".into(), "Members: 1,234".into())],
            messages: vec![rr, log1, log2, log3, log4, ask, answer, menu], bans: vec![("400000000000000001".into(), "spammer".into(), Some("spam".into()))], ..Default::default() };
        let f = findings(&input, G, None);
        let kinds: Vec<&str> = f.iter().map(|x| x["kind"].as_str().unwrap()).collect();
        assert!(kinds.contains(&"reactionroles"), "{kinds:?}");
        assert!(kinds.contains(&"rolemenu"), "{kinds:?}");
        assert!(kinds.contains(&"logs"), "{kinds:?}");
        assert!(kinds.contains(&"tags"), "{kinds:?}");
        assert!(kinds.contains(&"counters"), "{kinds:?}");
        assert!(kinds.contains(&"bans"), "{kinds:?}");
        let counters = f.iter().find(|x| x["kind"] == "counters").unwrap();
        assert_eq!(counters["data"]["counters"][0]["template"], "Members: {members}");
        assert_eq!(old_bots(&input.bots, None).len(), 1);
    }
}
