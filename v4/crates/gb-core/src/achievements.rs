//! Good Boy 3's achievements and badges. Seventeen built-in ones are earned from activity (messages, voice time,
//! reactions, days active, streaks, time in the server); staff can make the server's own and grant or revoke them.
//! One message every 20 seconds (and one reaction every 5) counts, so spamming can't farm progress. Members can opt
//! out or hide theirs; announcements follow the member's "achievements" notification choice. The same tables,
//! catalogue and wording as Good Boy 3.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::{notify, Action, Area, Card, CommandEvent, Db, Def, Kind, Member, Settings};
use gb_data::achievements::Progress;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub const MODULE: &str = "achievements";
pub const USE: Perm = Perm { key: "achievements.use", level: Level::Everyone };
pub const MANAGE: Perm = Perm { key: "achievements.manage", level: Level::Admin };
pub static SETTINGS: &[Def] = &[
    Def { key: "announce", label: "How unlocks are announced", kind: Kind::Select(&["channel", "dm", "both", "off"]), default: Fallback::Str("channel") },
    Def { key: "announceChannel", label: "Channel for unlock announcements", kind: Kind::Channel, default: Fallback::None },
    Def { key: "timezoneOffset", label: "Server timezone offset from UTC, in hours (decides when a day starts for streaks)", kind: Kind::Number { min: -12, max: 14 }, default: Fallback::Int(0) },
];
const ID: Opt = Opt { name: "id", about: "Its id", takes: Takes::Text, required: true };
const WHO: Opt = Opt { name: "member", about: "Who", takes: Takes::Member, required: true };
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "achievements", about: "Achievements and badges", module: MODULE, options: &[], subs: &[
    Sub { name: "show", about: "Your achievements (or someone else's)", options: &[Opt { name: "member", about: "Whose", takes: Takes::Member, required: false }] },
    Sub { name: "list", about: "Every achievement and how to earn it", options: &[] },
    Sub { name: "privacy", about: "Who can see your achievements", options: &[Opt { name: "who", about: "Who", takes: Takes::Choice(&[("everyone in the server", "public"), ("only me", "private")]), required: true }] },
    Sub { name: "optout", about: "Stop counting my activity", options: &[] },
    Sub { name: "optin", about: "Count my activity again", options: &[] },
    Sub { name: "custom create", about: "Make a new achievement", options: &[
        Opt { name: "name", about: "Name", takes: Takes::Text, required: true },
        Opt { name: "description", about: "What it is for", takes: Takes::Text, required: true },
        Opt { name: "emoji", about: "An emoji for it", takes: Takes::Text, required: false },
    ] },
    Sub { name: "custom delete", about: "Delete one", options: &[ID] },
    Sub { name: "custom grant", about: "Give one to a member", options: &[ID, WHO] },
    Sub { name: "custom revoke", about: "Take one back", options: &[ID, WHO] },
] }];
const GOLD: u32 = 0xfbbf24;
const MAX_CUSTOM: usize = 25;
const MAX_SESSION_SECONDS: i64 = 12 * 3600;

/// (metric, label)
const METRICS: &[(&str, &str)] = &[("messages", "messages"), ("voice_hours", "hours in voice"), ("reactions", "reactions given"), ("active_days", "days active"), ("best_streak", "day streak"), ("member_days", "days in the server")];
/// Good Boy 3's built-in achievements: (id, name, emoji, metric, target).
pub const BUILTIN: &[(&str, &str, &str, &str, i64)] = &[
    ("first-words", "First Words", "💬", "messages", 1), ("regular", "Regular", "🗨️", "messages", 100), ("chatterbox", "Chatterbox", "📣", "messages", 1000),
    ("legend", "Legend of the Chat", "👑", "messages", 10000), ("hello-mic", "Hello, Mic", "🎙️", "voice_hours", 1), ("good-company", "Good Company", "🎧", "voice_hours", 10),
    ("always-online", "Always Online", "📡", "voice_hours", 100), ("reactor", "Reactor", "😄", "reactions", 50), ("hype-machine", "Hype Machine", "🎉", "reactions", 500),
    ("week-around", "A Week Around", "📅", "active_days", 7), ("monthly-regular", "Monthly Regular", "🗓️", "active_days", 30), ("centurion", "Centurion", "💯", "active_days", 100),
    ("three-in-a-row", "Three in a Row", "🔥", "best_streak", 3), ("week-streak", "Week Streak", "⚡", "best_streak", 7), ("month-streak", "Month Streak", "🌟", "best_streak", 30),
    ("one-month-in", "One Month In", "🌱", "member_days", 30), ("one-year-in", "One Year In", "🎂", "member_days", 365),
];

/// One achievement as shown: (id, name, description, emoji, the server's own).
#[derive(Debug, Clone)]
pub struct Badge {
    pub id: String,
    pub name: String,
    pub description: String,
    pub emoji: String,
    pub custom: bool,
}
/// (earned, out of, the last three as (name, emoji, when)).
pub type Summary = (usize, usize, Vec<(String, String, i64)>);
fn label(metric: &str) -> &'static str {
    METRICS.iter().find(|m| m.0 == metric).map(|m| m.1).unwrap_or("")
}
fn builtin_defs() -> Vec<Badge> {
    BUILTIN.iter().map(|(id, name, emoji, metric, target)| Badge { id: id.to_string(), name: name.to_string(), description: format!("{} {}", crate::card::group(*target), label(metric)), emoji: emoji.to_string(), custom: false }).collect()
}
pub fn value_of(metric: &str, p: &Progress, member_days: i64) -> i64 {
    match metric { "messages" => p.messages, "voice_hours" => p.voice_seconds / 3600, "reactions" => p.reactions, "active_days" => p.active_days, "best_streak" => p.best_streak, _ => member_days }
}
/// Built-in achievements the progress now reaches (Good Boy 3's `reached`).
pub fn reached(p: &Progress, member_days: i64) -> Vec<&'static str> {
    BUILTIN.iter().filter(|d| value_of(d.3, p, member_days) >= d.4).map(|d| d.0).collect()
}
/// `▰▰▱▱…` rounded down, as Good Boy 3's bar.
fn bar(value: i64, target: i64) -> String {
    let filled = ((value as f64 / target.max(1) as f64) * 10.0).floor().clamp(0.0, 10.0) as usize;
    format!("{}{}", "▰".repeat(filled), "▱".repeat(10 - filled))
}
/// The next few goals: the nearest unreached target for each metric, closest first (Good Boy 3's `nextUp`).
pub fn next_up(p: &Progress, member_days: i64, unlocked: &[String]) -> Vec<String> {
    let mut by_metric: Vec<&(&str, &str, &str, &str, i64)> = Vec::new();
    for d in BUILTIN.iter().filter(|d| !unlocked.iter().any(|u| u == d.0)) {
        match by_metric.iter_mut().find(|x| x.3 == d.3) { Some(x) => if d.4 < x.4 { *x = d }, None => by_metric.push(d) }
    }
    let mut rows: Vec<(f64, i64, String)> = by_metric.into_iter().map(|d| {
        let v = value_of(d.3, p, member_days);
        let shown = v.min(d.4);
        ((v as f64 / d.4 as f64).min(1.0), d.4, format!("{} **{}** {} {}/{} {}", d.2, d.1, bar(shown, d.4), crate::card::group(shown), crate::card::group(d.4), label(d.3)))
    }).collect();
    rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
    rows.into_iter().take(4).map(|r| r.2).collect()
}
/// "Regular" → "regular", "Top Fan!!" → "top-fan" (Good Boy 3's slugify).
pub fn slugify(s: &str) -> String {
    let low: String = s.to_lowercase().chars().map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() { c } else { '-' }).collect();
    let mut out = String::new();
    for c in low.chars() { if c == '-' && (out.is_empty() || out.ends_with('-')) { continue; } out.push(c); }
    out.trim_end_matches('-').chars().take(30).collect::<String>().trim_end_matches('-').to_string()
}
fn id_ok(id: &str) -> bool {
    let b = id.as_bytes();
    (2..=30).contains(&b.len()) && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}
/// Day "2026-11-12" moves the streak: (streak, best, a new day).
pub fn advance_streak(last: Option<&str>, streak: i64, best: i64, today: &str) -> (i64, i64, bool) {
    if last == Some(today) { return (streak, best, false); }
    let num = |k: &str| { let p: Vec<i64> = k.split('-').map(|x| x.parse().unwrap_or(0)).collect(); if p.len() == 3 { crate::time::days_from_civil(p[0], p[1], p[2]) } else { 0 } };
    let s = if last.is_some_and(|l| num(today) - num(l) == 1) { streak + 1 } else { 1 };
    (s, best.max(s), true)
}

#[derive(Default)]
struct Memory {
    last: HashMap<String, i64>,
    voice: HashMap<String, i64>,
}
fn memory() -> std::sync::MutexGuard<'static, Memory> {
    static M: OnceLock<Mutex<Memory>> = OnceLock::new();
    M.get_or_init(Mutex::default).lock().unwrap_or_else(|p| p.into_inner())
}
fn throttle(key: String, now: i64, gap: i64) -> bool {
    let mut m = memory();
    if m.last.get(&key).is_some_and(|t| now - t < gap) { return false; }
    m.last.insert(key, now);
    if m.last.len() > 50_000 { m.last.retain(|_, t| now - *t < 600_000); }
    true
}
fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
fn member_days(m: &Member, now: i64) -> i64 {
    m.joined_at.map(|j| (now - j) / 86_400_000).unwrap_or(0)
}

pub struct Achievements<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub guild: &'a str,
    pub server: &'a str,
}
impl Achievements<'_> {
    fn catalog(&self) -> Vec<Badge> {
        let mut all = builtin_defs();
        let customs = self.db.get().ach_customs(self.guild).unwrap_or_default();
        all.extend(customs.into_iter().map(|(id, name, description, emoji)| Badge { id, name, description, emoji, custom: true }));
        all
    }
    fn announce(&self, user: &str, d: &Badge) -> Vec<Action> {
        let mode = self.settings.text(self.guild, MODULE, "announce").unwrap_or_else(|| "channel".into());
        if mode == "off" || !notify::allowed(self.db, self.guild, user, "achievements") { return Vec::new(); }
        let what = format!("{} **{}** — {}", d.emoji, d.name, d.description);
        let mut out = Vec::new();
        if mode == "channel" || mode == "both" {
            if let Some(c) = self.settings.text(self.guild, MODULE, "announceChannel").filter(|c| !c.is_empty()) {
                out.push(Action::Send { channel: c, card: Card::new(Area::General).line(format!("🏆 <@{user}> unlocked {what}")), ping: vec![user.to_string()], roles: Vec::new() });
            }
        }
        if (mode == "dm" || mode == "both") && notify::allowed(self.db, self.guild, user, "dms") {
            out.push(Action::Dm { user: user.into(), card: Card::new(Area::General).line(format!("🏆 You unlocked {what} (in {})", self.server).chars().take(1900).collect::<String>()), or_in: None });
        }
        out
    }
    /// Adds to a member's counters, moves the streak and awards anything newly earned (Good Boy 3's `record`).
    pub fn record(&self, member: &Member, messages: i64, voice_seconds: i64, reactions: i64, now: i64) -> Vec<Action> {
        if member.bot || self.db.get().ach_opted_out(self.guild, &member.id).unwrap_or(false) { return Vec::new(); }
        let p = self.db.get().ach_progress(self.guild, &member.id).unwrap_or_default();
        let today = crate::time::date(now + self.settings.int(self.guild, MODULE, "timezoneOffset") * 3_600_000);
        let (streak, best, new_day) = advance_streak(p.last_day.as_deref(), p.streak, p.best_streak, &today);
        let next = Progress {
            messages: p.messages + messages, voice_seconds: p.voice_seconds + voice_seconds, reactions: p.reactions + reactions,
            active_days: p.active_days + i64::from(new_day && (messages > 0 || reactions > 0 || voice_seconds > 0)), streak, best_streak: best, last_day: Some(today),
        };
        let _ = self.db.get().ach_save(self.guild, &member.id, &next);
        let have: Vec<String> = self.db.get().ach_unlocked(self.guild, &member.id).unwrap_or_default().into_iter().map(|u| u.0).collect();
        let defs = builtin_defs();
        let mut out = Vec::new();
        for id in reached(&next, member_days(member, now)) {
            if have.iter().any(|h| h == id) { continue; }
            let fresh = self.db.get().ach_unlock(self.guild, &member.id, id, "auto", now).unwrap_or(false);
            if fresh { if let Some(d) = defs.iter().find(|d| d.id == id) { out.extend(self.announce(&member.id, d)); } }
        }
        out
    }
    pub fn on_message(&self, author: &Member, now: i64) -> Vec<Action> {
        if author.bot || !throttle(format!("{}:m:{}", self.guild, author.id), now, 20_000) { return Vec::new(); }
        self.record(author, 1, 0, 0, now)
    }
    pub fn on_reaction(&self, user: &Member, now: i64) -> Vec<Action> {
        if user.bot || !throttle(format!("{}:r:{}", self.guild, user.id), now, 5_000) { return Vec::new(); }
        self.record(user, 0, 0, 1, now)
    }
    /// Voice time is "connected", not "talking"; a session counts at most 12 hours. `afk`: the server's AFK channel.
    pub fn on_voice(&self, member: &Member, channel: Option<&str>, afk: Option<&str>, now: i64) -> Vec<Action> {
        if member.bot { return Vec::new(); }
        let key = format!("{}:{}", self.guild, member.id);
        let inside = channel.is_some_and(|c| Some(c) != afk);
        let started = { let mut m = memory(); if inside { m.voice.entry(key).or_insert(now); None } else { m.voice.remove(&key) } };
        match started {
            Some(t) => { let s = ((now - t) / 1000).clamp(0, MAX_SESSION_SECONDS); if s > 0 { self.record(member, 0, s, 0, now) } else { Vec::new() } }
            None => Vec::new(),
        }
    }
    /// A short summary for other modules (Eclipse ID): (earned, out of, the last three), or None when hidden.
    pub fn summary(&self, user: &str) -> Option<Summary> {
        if self.db.get().ach_opted_out(self.guild, user).unwrap_or(false) || self.db.get().ach_visibility(self.guild, user).unwrap_or_default() == "private" { return None; }
        let defs = self.catalog();
        let got: Vec<(String, i64)> = self.db.get().ach_unlocked(self.guild, user).unwrap_or_default().into_iter().filter(|u| defs.iter().any(|d| d.id == u.0)).collect();
        let recent = got.iter().rev().take(3).filter_map(|(id, at)| defs.iter().find(|d| d.id == *id).map(|d| (d.name.clone(), d.emoji.clone(), *at))).collect();
        Some((got.len(), defs.len(), recent))
    }

    pub fn command(&self, ev: &CommandEvent) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, USE) { return private(format!("You don't have permission for that (`{}`).", USE.key)); }
        let me = ev.member.id.as_str();
        let arg = |k: &str| ev.args.get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let sub = ev.sub.as_deref().unwrap_or("show");
        if let Some(what) = sub.strip_prefix("custom ") {
            if !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private(format!("You don't have permission for that (`{}`).", MANAGE.key)); }
            if what == "create" {
                let customs = self.db.get().ach_customs(self.guild).unwrap_or_default();
                if customs.len() >= MAX_CUSTOM { return private(format!("A server can have {MAX_CUSTOM} custom achievements. Delete one first.")); }
                let name: String = arg("name").unwrap_or_default().replace(['\r', '\n'], " ").trim().chars().take(40).collect();
                let id = slugify(&name);
                if !id_ok(&id) { return private("Give it a name with at least two letters or numbers."); }
                if self.catalog().iter().any(|d| d.id == id) { return private("An achievement with that name already exists."); }
                let description: String = arg("description").unwrap_or_default().replace(['\r', '\n'], " ").trim().chars().take(120).collect();
                let emoji: String = arg("emoji").map(|e| e.chars().take(16).collect()).unwrap_or_else(|| "🏅".into());
                let _ = self.db.get().ach_custom_add(self.guild, &(id.clone(), name.clone(), description, emoji.clone()), me, ev.at_ms);
                return private(format!("Created {emoji} **{name}** (id `{id}`). Give it with `/achievements custom grant`."));
            }
            let id = arg("id").unwrap_or_default().to_lowercase();
            let Some(c) = self.catalog().into_iter().find(|d| d.custom && d.id == id) else { return private("No custom achievement with that id. Built-in ones are earned automatically and cannot be granted by hand.") };
            if what == "delete" {
                let _ = self.db.get().ach_custom_delete(self.guild, &id);
                return private(format!("Deleted **{}** and removed it from everyone who had it.", c.name));
            }
            let Some(user) = ev.target.as_ref() else { return private("Pick a person.") };
            if user.bot { return private("Pick a person."); }
            if what == "grant" {
                if !self.db.get().ach_unlock(self.guild, &user.id, &id, &format!("granted by {me}"), ev.at_ms).unwrap_or(false) { return private("They already have it."); }
                let mut out = private(format!("Gave {} **{}** to <@{}>.", c.emoji, c.name, user.id));
                out.extend(self.announce(&user.id, &c));
                return out;
            }
            if !self.db.get().ach_revoke(self.guild, &user.id, &id).unwrap_or(false) { return private("They do not have it."); }
            return private(format!("Took {} **{}** from <@{}>.", c.emoji, c.name, user.id));
        }
        match sub {
            "optout" => { let _ = self.db.get().ach_set_optout(self.guild, me, true); private("Your activity no longer counts toward achievements here, and your achievements are hidden. Earned ones are kept. `/achievements optin` turns it back on.") }
            "optin" => { let _ = self.db.get().ach_set_optout(self.guild, me, false); private("Your activity counts toward achievements again.") }
            "privacy" => {
                let private_now = arg("who").as_deref() == Some("private");
                let _ = self.db.get().ach_set_visibility(self.guild, me, if private_now { "private" } else { "public" });
                private(if private_now { "Only you can see your achievements now." } else { "Everyone in the server can see your achievements." })
            }
            "list" => {
                let lines: Vec<String> = self.catalog().iter().map(|d| format!("{} **{}** · {}", d.emoji, d.name, if d.custom { format!("{} *(server)*", d.description) } else { d.description.clone() })).collect();
                let mut card = Card::new(Area::General).title("🏆 Achievements").line(lines.join("\n").chars().take(3900).collect::<String>()).private();
                card.accent = Some(GOLD);
                vec![Action::Reply { card }]
            }
            _ => {
                let user = ev.target.clone().unwrap_or_else(|| ev.member.clone());
                let own = user.id == me;
                let out = self.db.get().ach_opted_out(self.guild, &user.id).unwrap_or(false);
                if !own {
                    if out { return private("That member opted out of achievements."); }
                    if self.db.get().ach_visibility(self.guild, &user.id).unwrap_or_default() == "private" { return private("That member keeps their achievements private."); }
                }
                let p = self.db.get().ach_progress(self.guild, &user.id).unwrap_or_default();
                let got = self.db.get().ach_unlocked(self.guild, &user.id).unwrap_or_default();
                let defs = self.catalog();
                let earned: Vec<String> = got.iter().filter_map(|(id, at)| defs.iter().find(|d| d.id == *id).map(|d| format!("{} **{}** <t:{}:d>", d.emoji, d.name, at / 1000))).collect();
                let ids: Vec<String> = got.iter().map(|g| g.0.clone()).collect();
                let next = next_up(&p, member_days(&user, ev.at_ms), &ids);
                let cut = |s: String| s.chars().take(1000).collect::<String>();
                let mut card = Card::new(Area::General).title(format!("🏆 {} · {}/{}", user.name, earned.len(), defs.len()))
                    .line(format!("**Earned**\n{}", cut(if earned.is_empty() { "*none yet*".into() } else { earned.join("\n") })))
                    .line(format!("**Next up**\n{}", cut(if next.is_empty() { "*you have them all*".into() } else { next.join("\n") })));
                if own && out { card = card.line("-# You opted out: progress is not being counted."); }
                card.accent = Some(GOLD);
                vec![Action::Reply { card: card.private() }]
            }
        }
    }
}
