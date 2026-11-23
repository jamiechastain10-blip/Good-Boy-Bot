//! Server logs: deleted and edited messages, members joining and leaving, role and nickname changes, and voice.
//! Part of the moderation module, with Good Boy 3's settings and the same copies of recent messages.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::{Action, Area, Card, CommandEvent, Db, Member, Settings};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

pub const MODULE: &str = "moderation";
pub(crate) const LOGS_PERM: Perm = Perm { key: "moderation.logs", level: Level::Admin };
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "logs", about: "(Admins) Choose log channels and what gets logged", module: MODULE, options: &[], subs: &[
    Sub { name: "setup", about: "Set log channels and turn events on or off (empty = show the current setup)", options: &[
        Opt { name: "mod_channel", about: "Warnings, timeouts, kicks, bans, AutoMod and message logs", takes: Takes::Channel, required: false },
        Opt { name: "server_channel", about: "Joins, leaves, roles, nicknames, voice (empty = the mod log)", takes: Takes::Channel, required: false },
        Opt { name: "message_edits", about: "Message edits and deletes", takes: Takes::YesNo, required: false },
        Opt { name: "joins", about: "Members joining and leaving", takes: Takes::YesNo, required: false },
        Opt { name: "roles", about: "Role changes", takes: Takes::YesNo, required: false },
        Opt { name: "nicknames", about: "Nickname changes", takes: Takes::YesNo, required: false },
        Opt { name: "voice", about: "Voice joins, leaves and moves", takes: Takes::YesNo, required: false },
    ] },
    Sub { name: "off", about: "Stop logging", options: &[Opt { name: "which", about: "Which log", takes: Takes::Choice(&[("Mod log", "mod"), ("Server log", "server"), ("Everything", "all")]), required: true }] },
] }];
const EVENTS: &[(&str, &str, &str)] = &[("message_edits", "logMessages", "Message edits and deletes"), ("joins", "logJoins", "Members joining and leaving"), ("roles", "logRoles", "Role changes"), ("nicknames", "logNicknames", "Nickname changes"), ("voice", "logVoice", "Voice joins, leaves and moves")];

fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}
fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::Moderation).line(text).private() }]
}
/// When a Discord account was made, from its id.
pub fn created_ms(id: &str) -> i64 {
    id.parse::<u64>().map(|n| ((n >> 22) + 1_420_070_400_000) as i64).unwrap_or(0)
}
fn age(ms: i64, now: i64) -> String {
    let d = (now - ms).max(0) / 86_400_000;
    if d < 1 { "today".into() } else if d < 60 { format!("{d} days ago") } else { format!("{} months ago", d / 30) }
}
fn who(m: &Member) -> String {
    format!("<@{}> · {} ({})", m.id, m.name, m.id)
}

/// What the bot last saw of each member (roles and nickname) and who is in which voice channel, so a change can be
/// described. Kept small: only members seen since the bot started.
#[derive(Default)]
struct Seen {
    members: HashMap<String, (Vec<String>, Option<String>)>,
    voice: HashMap<String, String>,
}
static SEEN: Mutex<Option<Seen>> = Mutex::new(None);
fn seen<T>(f: impl FnOnce(&mut Seen) -> T) -> T {
    let mut s = SEEN.lock().unwrap_or_else(|p| p.into_inner());
    let s = s.get_or_insert_with(Seen::default);
    if s.members.len() > 200_000 { s.members.clear(); }
    f(s)
}

pub struct Logs<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub guild: &'a str,
}
impl Logs<'_> {
    fn on(&self, key: &str) -> bool {
        self.settings.bool(self.guild, MODULE, key)
    }
    fn mod_log(&self, card: Card) -> Vec<Action> {
        self.settings.text(self.guild, MODULE, "logChannel").map(|channel| Action::Send { channel, card, ping: Vec::new(), roles: Vec::new() }).into_iter().collect()
    }
    fn server_log(&self, kind: &str, card: Card) -> Vec<Action> {
        if !self.on(kind) { return Vec::new(); }
        let channel = self.settings.text(self.guild, MODULE, "serverLogChannel").or_else(|| self.settings.text(self.guild, MODULE, "logChannel"));
        channel.map(|channel| Action::Send { channel, card, ping: Vec::new(), roles: Vec::new() }).into_iter().collect()
    }

    /// Every message is copied (for a week) while message logging is on, so a later delete or edit can be shown.
    pub fn keep(&self, id: &str, channel: &str, author: &Member, text: &str, files: &[(String, String, u64)], at: i64) {
        if !self.on("logMessages") || author.bot || (text.is_empty() && files.is_empty()) { return; }
        let attachments = json!(files.iter().take(10).map(|(name, url, size)| json!({ "name": short(name, 100), "url": url, "size": size })).collect::<Vec<_>>()).to_string();
        let store = self.db.get();
        let _ = store.keep_message(self.guild, id, channel, &author.id, text, &attachments, at);
        // a clean-up every 500 copies or so
        static SINCE: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);
        let due = {
            let mut all = SINCE.lock().unwrap_or_else(|p| p.into_inner());
            let n = all.get_or_insert_with(HashMap::new).entry(self.guild.to_string()).or_insert(0);
            *n += 1;
            if *n >= 500 { *n = 0; true } else { false }
        };
        if due { let _ = store.forget_old_messages(self.guild, at); }
    }
    fn files_text(attachments: &str) -> String {
        let files: Vec<Value> = serde_json::from_str(attachments).unwrap_or_default();
        if files.is_empty() { return String::new(); }
        format!("\n**Attachments:** {}", files.iter().map(|f| { let name = f["name"].as_str().unwrap_or("file"); match f["url"].as_str().filter(|u| !u.is_empty()) { Some(u) => format!("[{name}]({u})"), None => name.to_string() } }).collect::<Vec<_>>().join(", "))
    }

    pub fn deleted(&self, channel: &str, id: &str) -> Vec<Action> {
        if !self.on("logMessages") { return Vec::new(); }
        let kept = self.db.get().kept_message(self.guild, id).ok().flatten();
        let _ = self.db.get().forget_message(self.guild, id);
        if self.settings.text(self.guild, MODULE, "logChannel").as_deref() == Some(channel) { return Vec::new(); }
        let text = match &kept {
            Some(k) if !k.content.is_empty() || k.attachments != "[]" => format!("{}{}", if k.content.is_empty() { "*no text*".to_string() } else { short(&k.content, 1500) }, Self::files_text(&k.attachments)),
            _ => "*Good Boy had not seen this message (it was sent before message logging was on, or more than a week ago).*".into(),
        };
        let author = kept.as_ref().and_then(|k| k.author.clone());
        let sent = kept.as_ref().map(|k| format!(" · sent <t:{}:R>", k.at / 1000)).unwrap_or_default();
        let foot = match &author { Some(a) => format!("Author ID {a} · message ID {id}"), None => format!("Message ID {id}") };
        self.mod_log(Card::new(Area::Moderation).title("Message deleted").line(format!("In <#{channel}>{}{sent}\n{text}", author.map(|a| format!(" by <@{a}>")).unwrap_or_default())).line(format!("-# {foot}")))
    }
    pub fn deleted_many(&self, channel: &str, ids: &[String]) -> Vec<Action> {
        if !self.on("logMessages") || self.settings.text(self.guild, MODULE, "logChannel").as_deref() == Some(channel) { return Vec::new(); }
        let mut rows: Vec<(i64, String)> = Vec::new();
        for id in ids {
            if let Some(k) = self.db.get().kept_message(self.guild, id).ok().flatten() {
                rows.push((k.at, format!("{}: {}", k.author.map(|a| format!("<@{a}>")).unwrap_or_else(|| "Someone".into()), if k.content.is_empty() { "*not seen*".to_string() } else { short(&k.content, 120) })));
            }
            let _ = self.db.get().forget_message(self.guild, id);
        }
        rows.sort_by_key(|r| r.0);
        let lines = rows.into_iter().map(|r| r.1).collect::<Vec<_>>().join("\n");
        self.mod_log(Card::new(Area::Moderation).title(format!("{} messages deleted at once", ids.len())).line(format!("In <#{channel}>\n{}", short(if lines.is_empty() { "*Good Boy had not seen these messages.*" } else { &lines }, 3700))))
    }
    pub fn edited(&self, channel: &str, id: &str, author: &Member, text: &str, url: &str, at: i64) -> Vec<Action> {
        if !self.on("logMessages") || author.bot { return Vec::new(); }
        let before = self.db.get().kept_message(self.guild, id).ok().flatten().map(|k| k.content).unwrap_or_default();
        self.keep(id, channel, author, text, &[], at);
        if text.is_empty() || before == text || self.settings.text(self.guild, MODULE, "logChannel").as_deref() == Some(channel) { return Vec::new(); }
        self.mod_log(Card::new(Area::Moderation).title("Message edited").line(format!("In <#{channel}> by <@{}> - [jump]({url})", author.id))
            .line(format!("**Before**\n{}", if before.is_empty() { "*Good Boy had not seen the old version.*".to_string() } else { short(&before, 1000) }))
            .line(format!("**After**\n{}", short(text, 1000))))
    }

    pub fn joined(&self, m: &Member, count: Option<u64>, now: i64) -> Vec<Action> {
        seen(|s| { s.members.insert(format!("{}:{}", self.guild, m.id), (m.roles.clone(), None)); });
        self.server_log("logJoins", Card::new(Area::General).title("📥 Member joined").line(format!("{}\nAccount created {}", who(m), age(created_ms(&m.id), now))).line(format!("-# Members: {}", count.map(|n| n.to_string()).unwrap_or_else(|| "?".into()))))
    }
    pub fn left(&self, m: &Member) -> Vec<Action> {
        let roles = seen(|s| s.members.remove(&format!("{}:{}", self.guild, m.id))).map(|r| r.0).unwrap_or_default();
        let roles_text = if roles.is_empty() { String::new() } else { format!("\nRoles: {}", roles.iter().filter(|r| r.as_str() != self.guild).take(20).map(|r| format!("<@&{r}>")).collect::<Vec<_>>().join(" ")) };
        self.server_log("logJoins", Card::new(Area::General).title("📤 Member left").line(format!("{}{roles_text}", who(m))))
    }
    /// A member's roles or nickname changed. The first time the bot sees a member it only remembers them.
    pub fn member_changed(&self, m: &Member, nick: Option<&str>) -> Vec<Action> {
        let key = format!("{}:{}", self.guild, m.id);
        let before = seen(|s| s.members.insert(key, (m.roles.clone(), nick.map(str::to_string))));
        let Some((had, old_nick)) = before else { return Vec::new() };
        let mut out = Vec::new();
        let added: Vec<String> = m.roles.iter().filter(|r| !had.contains(r)).map(|r| format!("<@&{r}>")).collect();
        let removed: Vec<String> = had.iter().filter(|r| !m.roles.contains(r)).map(|r| format!("<@&{r}>")).collect();
        if !added.is_empty() || !removed.is_empty() {
            let mut lines = vec![who(m)];
            if !added.is_empty() { lines.push(format!("Added: {}", added.join(" "))); }
            if !removed.is_empty() { lines.push(format!("Removed: {}", removed.join(" "))); }
            out.extend(self.server_log("logRoles", Card::new(Area::General).title("🎭 Roles changed").line(lines.join("\n"))));
        }
        if old_nick.as_deref() != nick {
            out.extend(self.server_log("logNicknames", Card::new(Area::General).title("🏷️ Nickname changed").line(format!("{}\n**Before:** {}\n**After:** {}", who(m), old_nick.as_deref().unwrap_or("*none*"), nick.unwrap_or("*none*")))));
        }
        out
    }
    /// Where a member is in voice now (None: not in voice).
    pub fn voice(&self, m: &Member, channel: Option<&str>) -> Vec<Action> {
        let key = format!("{}:{}", self.guild, m.id);
        let before = seen(|s| match channel { Some(c) => s.voice.insert(key, c.to_string()), None => s.voice.remove(&key) });
        if m.bot || before.as_deref() == channel { return Vec::new(); }
        let text = match (before.as_deref(), channel) {
            (None, Some(to)) => format!("joined 🔊 <#{to}>"),
            (Some(from), None) => format!("left 🔊 <#{from}>"),
            (Some(from), Some(to)) => format!("moved 🔊 <#{from}> → <#{to}>"),
            (None, None) => return Vec::new(),
        };
        self.server_log("logVoice", Card::new(Area::General).line(format!("{} {text}", who(m))))
    }
    /// Who was already in voice when the bot connected.
    pub fn voice_seen(&self, user: &str, channel: &str) {
        seen(|s| { s.voice.insert(format!("{}:{user}", self.guild), channel.to_string()); });
    }

    fn status(&self) -> String {
        let ch = |id: Option<String>| id.map(|c| format!("<#{c}>")).unwrap_or_else(|| "*not set*".into());
        let (modl, server) = (self.settings.text(self.guild, MODULE, "logChannel"), self.settings.text(self.guild, MODULE, "serverLogChannel"));
        let server_text = match (&server, &modl) { (Some(s), _) => format!("<#{s}>"), (None, Some(m)) => format!("<#{m}> (same as the mod log)"), _ => "*not set*".into() };
        let mut lines = vec![format!("**Mod log** (warnings, timeouts, kicks, bans, AutoMod): {}", ch(modl.clone())), format!("**Server log** (the events below): {server_text}"), String::new()];
        lines.extend(EVENTS.iter().map(|(_, key, label)| format!("{} {label}", if self.on(key) { "✅" } else { "▫️" })));
        lines.push(String::new());
        lines.push("Ticket logs have their own channel: `/ticket setup`.".into());
        lines.join("\n")
    }
    pub fn command(&self, ev: &CommandEvent) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, LOGS_PERM) { return private("You don't have permission for that (`moderation.logs`)."); }
        let arg = |k: &str| ev.args.get(k).map(String::as_str).filter(|s| !s.is_empty());
        let set = |key: &str, v: Value| { let _ = self.settings.set(self.guild, MODULE, key, &v); };
        if ev.sub.as_deref() == Some("off") {
            let which = arg("which").unwrap_or("all");
            if which == "mod" || which == "all" { set("logChannel", Value::Null); }
            if which == "server" || which == "all" {
                set("serverLogChannel", Value::Null);
                for (_, key, _) in &EVENTS[1..] { set(key, json!(false)); }
            }
            let what = match which { "all" => "everything", "mod" => "the mod log", _ => "the server log" };
            return private(format!("Logging turned off for: **{what}**.\n\n{}", self.status()));
        }
        let mut changed = Vec::new();
        if let Some(c) = arg("mod_channel") { set("logChannel", json!(c)); changed.push("mod log channel".to_string()); }
        if let Some(c) = arg("server_channel") { set("serverLogChannel", json!(c)); changed.push("server log channel".to_string()); }
        for (opt, key, label) in EVENTS {
            if let Some(v) = arg(opt) {
                let on = v == "true";
                set(key, json!(on));
                changed.push(format!("{} {}", label.to_lowercase(), if on { "on" } else { "off" }));
            }
        }
        let any_on = EVENTS[1..].iter().any(|(_, key, _)| self.on(key));
        let warn = if any_on && self.settings.text(self.guild, MODULE, "serverLogChannel").is_none() && self.settings.text(self.guild, MODULE, "logChannel").is_none() { "\n\n⚠️ Pick a channel (`server_channel` or `mod_channel`) or nothing will be logged." } else { "" };
        private(format!("{}{}{warn}", if changed.is_empty() { String::new() } else { format!("✅ Saved: {}.\n\n", changed.join(", ")) }, self.status()))
    }
}
