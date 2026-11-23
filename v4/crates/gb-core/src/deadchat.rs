//! Good Boy 3's dead chat ping: when a chosen channel has been quiet for a while, the bot pings a role with a
//! conversation starter, at most once per quiet spell and never more often than the cooldown. Members opt in with
//! a "Ping me" button. Only message times are used, never what messages say.

use crate::bot::{CommandSpec, Directory};
use crate::perms::{self, Level, Perm};
use crate::roles::grant_problem;
use crate::settings::Fallback;
use crate::store::Data;
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Def, Field, FieldKind, FormEvent, Kind, MessageEvent, Settings};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub const MODULE: &str = "deadchat";
pub const MANAGE: Perm = Perm { key: "deadchat.manage", level: Level::Admin };
pub const ROLE_NAME: &str = "deadchat";
const MIN: i64 = 60_000;
const SAVE_EVERY: i64 = 30_000;
pub static SETTINGS: &[Def] = &[
    Def { key: "enabled", label: "Dead chat ping on", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "channel", label: "Channel to watch", kind: Kind::Channel, default: Fallback::None },
    Def { key: "role", label: "Role to ping (members opt in with a button; /deadchat can create @deadchat)", kind: Kind::Role, default: Fallback::None },
    Def { key: "quietMinutes", label: "Ping after this many quiet minutes", kind: Kind::Number { min: 10, max: 10080 }, default: Fallback::Int(60) },
    Def { key: "cooldownMinutes", label: "At most one ping every N minutes", kind: Kind::Number { min: 30, max: 10080 }, default: Fallback::Int(240) },
    Def { key: "starters", label: "Conversation starters (one picked at random)", kind: Kind::List, default: Fallback::None },
];
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "deadchat", about: "Set up the dead chat ping (opens a form)", module: MODULE, options: &[], subs: &[] }];
pub const DEFAULT_STARTERS: &[&str] = &[
    "What game have you been playing lately?",
    "Best snack of all time? Wrong answers only.",
    "What is something small that made your week better?",
    "If you could instantly master one skill, what would it be?",
    "Drop the last photo in your camera roll you are allowed to share.",
    "What is a hot take you will defend to the end?",
    "What are you looking forward to this week?",
    "Recommend one song everyone here should hear.",
];

/// Good Boy 3's rule: ping now?
pub fn should_ping(now: i64, last_message: i64, last_ping: i64, quiet: i64, cooldown: i64) -> bool {
    last_message != 0 && now - last_message >= quiet && last_ping < last_message && now - last_ping >= cooldown
}
fn last_seen() -> std::sync::MutexGuard<'static, HashMap<String, i64>> {
    static L: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    L.get_or_init(Mutex::default).lock().unwrap_or_else(|p| p.into_inner())
}
fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
fn opt_in(card: Card) -> Card {
    card.button_with("deadchat:toggle", "Ping me when chat dies / stop", ButtonStyle::Plain, Some("🔔".into()))
}

pub struct DeadChat<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub dir: &'a Directory,
    pub guild: &'a str,
}
impl DeadChat<'_> {
    fn data(&self) -> Data<'_> {
        Data { db: self.db, guild: self.guild, module: MODULE }
    }
    fn text(&self, k: &str) -> Option<String> {
        self.settings.text(self.guild, MODULE, k).filter(|v| !v.is_empty())
    }
    fn int(&self, k: &str) -> i64 {
        self.settings.int(self.guild, MODULE, k)
    }
    /// `/deadchat`: Good Boy 3's private message, what it is set to, and the button to the form.
    pub fn command(&self, ev: &CommandEvent) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private(format!("You don't have permission for that (`{}`).", MANAGE.key)); }
        let now = if self.settings.bool(self.guild, MODULE, "enabled") {
            format!("On: <#{}> after **{} min** of quiet, at most every **{} min**{}.", self.text("channel").unwrap_or_default(), self.int("quietMinutes"), self.int("cooldownMinutes"), self.text("role").map(|r| format!(", pinging <@&{r}>")).unwrap_or_default())
        } else { "Off. Pick a channel, who to ping and how long the chat must be quiet.".into() };
        vec![Action::Reply { card: Card::new(Area::General).title("Dead chat ping").line(now).line("-# Only you can see this. The button works for 15 minutes.").button_with(format!("deadchat:setup:{}", ev.member.id), "Configure dead chat ping", ButtonStyle::Primary, Some("💬".into())).private() }]
    }
    pub fn press(&self, ev: &ButtonEvent) -> Vec<Action> {
        if let Some(owner) = ev.id.strip_prefix("deadchat:setup:") {
            if owner != ev.member.id { return private("That form belongs to someone else. Run the command yourself to get your own."); }
            let ch = self.text("channel").unwrap_or_else(|| ev.place.channel.clone());
            return vec![Action::Form { id: "deadchat:form".into(), title: "Dead chat ping".into(), fields: vec![
                Field { id: "enabled".into(), label: "Turn it on?".into(), kind: FieldKind::Select(vec![("On".into(), "on".into()), ("Off".into(), "off".into())]), required: true, value: Some("on".into()), ..Default::default() },
                Field { id: "channel".into(), label: "Channel to watch".into(), kind: FieldKind::Channel(vec![0, 5]), required: true, value: Some(ch), ..Default::default() },
                Field { id: "role".into(), label: "Role to ping (optional)".into(), desc: Some(format!("Leave empty and I'll make a @{ROLE_NAME} role people can opt into")), kind: FieldKind::Role { most: 1 }, ..Default::default() },
                Field { id: "quiet".into(), label: "Quiet for how many minutes?".into(), required: true, max: 5, value: Some(self.int("quietMinutes").to_string()), ..Default::default() },
                Field { id: "cooldown".into(), label: "At most once every N minutes".into(), required: true, max: 5, value: Some(self.int("cooldownMinutes").to_string()), ..Default::default() },
            ] }];
        }
        // the opt-in button: anyone can press it for themselves
        let Some(role) = self.text("role").filter(|_| self.settings.bool(self.guild, MODULE, "enabled")) else { return private("The dead chat ping is not set up right now.") };
        if let Some(p) = grant_problem(self.dir, self.guild, &role, None) { return private(format!("I can't hand out that role: {p}")); }
        let has = ev.member.roles.contains(&role);
        let mut out = private(if has { "🔕 You won't be pinged when chat dies any more.".to_string() } else { format!("🔔 You'll be pinged with <@&{role}> when chat goes quiet. Press the button again to stop.") });
        let (add, remove) = if has { (Vec::new(), vec![role]) } else { (vec![role], Vec::new()) };
        out.push(Action::Roles { user: ev.member.id.clone(), add, remove, reason: format!("Dead chat ping: opted {}", if has { "out" } else { "in" }) });
        out
    }
    pub fn form(&self, ev: &FormEvent) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private(format!("You don't have permission for that (`{}`).", MANAGE.key)); }
        let v = |k: &str| ev.values.get(k).map(|s| s.trim().to_string()).unwrap_or_default();
        if v("channel").is_empty() { return private("Pick a channel to watch."); }
        let (Ok(quiet), Ok(cooldown)) = (v("quiet").parse::<i64>(), v("cooldown").parse::<i64>()) else { return private("Fill in both numbers.") };
        if !(10..=10080).contains(&quiet) { return private("**Quiet for how many minutes?** must be at least 10 and at most 10080."); }
        if !(30..=10080).contains(&cooldown) { return private("**At most once every N minutes** must be at least 30 and at most 10080."); }
        let set = |k: &str, val: serde_json::Value| { let _ = self.settings.set(self.guild, MODULE, k, &val); };
        set("channel", json!(v("channel")));
        set("quietMinutes", json!(quiet));
        set("cooldownMinutes", json!(cooldown));
        let on = v("enabled") != "off";
        set("enabled", json!(on));
        if self.data().get("lastMessageAt").is_none() { self.data().set("lastMessageAt", &json!(ev.at_ms)); }
        let picked = Some(v("role")).filter(|r| !r.is_empty()).or_else(|| self.dir.roles(self.guild).into_iter().find(|r| r.name.to_lowercase() == ROLE_NAME).map(|r| r.id));
        let Some(role) = picked else {
            // no role yet: Good Boy 3 makes a mentionable @deadchat with no permissions, then finishes the setup
            self.data().set("setup", &json!({ "quiet": quiet, "cooldown": cooldown, "on": on }));
            return vec![
                Action::Reply { card: Card::new(Area::General).line(format!("Making the @{ROLE_NAME} role…")).private() },
                Action::CreateRole { name: ROLE_NAME.into(), color: None, hoist: false, below: None, give_to: String::new(), note: "deadchat:role".into(), mentionable: true },
            ];
        };
        if let Some(p) = grant_problem(self.dir, self.guild, &role, Some(&ev.member)) { return private(format!("Members can't opt into that role: {p}")); }
        set("role", json!(role));
        let mut out = vec![Action::Reply { card: self.done_card(on, &v("channel"), &role, quiet, cooldown) }];
        out.extend(self.panel(on, &v("channel"), &role, quiet));
        out
    }
    fn done_card(&self, on: bool, channel: &str, role: &str, quiet: i64, cooldown: i64) -> Card {
        Card::new(if on { Area::Money } else { Area::General }).title(if on { "💬 Dead chat ping is on" } else { "💬 Dead chat ping is off" })
            .line(format!("Watching <#{channel}>. After **{quiet} min** without a message the bot posts a conversation starter and pings <@&{role}>, at most every **{cooldown} min**. Members opt in with the **Ping me** button I posted there.\nConversation starters can be edited in the dashboard or with `/config`.")).private()
    }
    fn panel(&self, on: bool, channel: &str, role: &str, quiet: i64) -> Option<Action> {
        on.then(|| Action::Send { channel: channel.into(), card: opt_in(Card::new(Area::General).line(format!("💬 **Dead chat ping is on here.** When this channel goes quiet for {quiet} minutes, <@&{role}> gets a ping and a conversation starter. Want in?"))), ping: Vec::new(), roles: Vec::new() })
    }
    /// The @deadchat role was made: the setup is finished.
    pub fn role_made(&self, role: &str) -> Vec<Action> {
        let Some(s) = self.data().get("setup") else { return Vec::new() };
        self.data().delete("setup");
        let _ = self.settings.set(self.guild, MODULE, "role", &json!(role));
        let channel = self.text("channel").unwrap_or_default();
        self.panel(s["on"].as_bool().unwrap_or(true), &channel, role, s["quiet"].as_i64().unwrap_or(60)).into_iter().collect()
    }
    /// Someone talked in the watched channel: only the time is kept (written at most every 30 seconds).
    pub fn on_message(&self, ev: &MessageEvent) {
        if ev.author.bot || Some(ev.place.channel.as_str()) != self.text("channel").as_deref() { return; }
        last_seen().insert(self.guild.to_string(), ev.at_ms);
        let saved = self.data().get("lastMessageAt").and_then(|v| v.as_i64()).unwrap_or(0);
        if ev.at_ms - saved > SAVE_EVERY { self.data().set("lastMessageAt", &json!(ev.at_ms)); }
    }
    /// Every minute or so: ping when the channel has been quiet long enough (Good Boy 3's check).
    pub fn check(&self, now: i64, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        if !self.settings.bool(self.guild, MODULE, "enabled") { return Vec::new(); }
        let Some(channel) = self.text("channel") else { return Vec::new() };
        let d = self.data();
        let last = last_seen().get(self.guild).copied().unwrap_or(0).max(d.get("lastMessageAt").and_then(|v| v.as_i64()).unwrap_or(0));
        if last == 0 { d.set("lastMessageAt", &json!(now)); last_seen().insert(self.guild.to_string(), now); return Vec::new(); }
        let last_ping = d.get("lastPingAt").and_then(|v| v.as_i64()).unwrap_or(0);
        if !should_ping(now, last, last_ping, self.int("quietMinutes") * MIN, self.int("cooldownMinutes") * MIN) { return Vec::new(); }
        let mins = (now - last + MIN / 2) / MIN;
        let custom: Vec<String> = self.settings.list(self.guild, MODULE, "starters").into_iter().filter(|s| !s.is_empty()).collect();
        let pool: Vec<String> = if custom.is_empty() { DEFAULT_STARTERS.iter().map(|s| s.to_string()).collect() } else { custom };
        let starter = pool[roll(0, pool.len() as i64 - 1).clamp(0, pool.len() as i64 - 1) as usize].clone();
        let role = self.text("role");
        let quiet = if mins >= 120 { format!("{} hours", (mins + 30) / 60) } else { format!("{mins} minutes") };
        d.set("lastPingAt", &json!(now)); // first: a failed send must not turn into a ping every minute
        let card = Card::new(Area::General).line(format!("{}💬 **Chat has been quiet for {quiet}!**\n{starter}", role.as_ref().map(|r| format!("<@&{r}> ")).unwrap_or_default()));
        let card = if role.is_some() { opt_in(card) } else { card };
        vec![Action::Send { channel, card, ping: Vec::new(), roles: role.into_iter().collect() }]
    }
}
