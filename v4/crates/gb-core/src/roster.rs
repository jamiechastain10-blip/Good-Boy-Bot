//! Who is in each server, by name, and a record of who left: how, when, and whether anything stands out (they
//! left while timed out, with warnings, within a day, while on the watch list). Kept for a while (60 days unless a
//! server says otherwise), then forgotten. The launcher shows names instead of numbers, and picks members from here.

use crate::store::Data;
use crate::{Action, Area, Card, Db, Member, Settings};
use gb_data::roster::Leaving;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub const MODULE: &str = crate::moderation::MODULE;
const DAY: i64 = 86_400_000;
const HOUR: i64 = 3_600_000;

/// The name last written for each member, so a chatty member is written once (and again when their name changes).
fn written() -> &'static Mutex<HashMap<String, String>> {
    static W: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashMap::new()))
}

pub struct Roster<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub guild: &'a str,
}
impl Roster<'_> {
    pub fn keeps_records(&self) -> bool {
        self.settings.bool(self.guild, MODULE, "leaveRecords")
    }
    /// How many days leave records are kept.
    pub fn days(&self) -> i64 {
        self.settings.int(self.guild, MODULE, "leaveRecordDays").clamp(7, 365)
    }
    /// Remembers a member's name (and, when `roles` is true, the roles they hold). Cheap enough to call on every
    /// message: it only writes when something is new.
    pub fn see(&self, m: &Member, roles: bool, now: i64) {
        if m.id.is_empty() || m.name.trim().is_empty() { return; }
        let key = format!("{}:{}", self.guild, m.id);
        {
            let mut w = written().lock().unwrap_or_else(|p| p.into_inner());
            if !roles && w.get(&key).is_some_and(|n| *n == m.name) { return; }
            w.insert(key, m.name.clone());
        }
        let _ = self.db.get().roster_seen(self.guild, &m.id, &m.name, m.avatar.as_deref(), m.bot, m.joined_at, roles.then_some(m.roles.as_slice()), now);
    }
    /// Many members at once (the first look at a server, or a scan).
    pub fn seed(&self, members: &[Member], now: i64) {
        let store = self.db.get();
        let _ = store.batch(|s| {
            for m in members.iter().filter(|m| !m.id.is_empty() && !m.name.trim().is_empty()) {
                s.roster_seen(self.guild, &m.id, &m.name, m.avatar.as_deref(), m.bot, m.joined_at, Some(&m.roles), now)?;
            }
            Ok(())
        });
        let mut w = written().lock().unwrap_or_else(|p| p.into_inner());
        for m in members { w.insert(format!("{}:{}", self.guild, m.id), m.name.clone()); }
    }
    /// Somebody joined: written down, and a record of an earlier leaving learns they are back.
    pub fn joined(&self, m: &Member, now: i64) {
        self.see(m, true, now);
        let _ = self.db.get().roster_returned(self.guild, &m.id, now);
    }
    /// What stands out about someone leaving, in plain words.
    fn flags(&self, user: &str, joined_at: Option<i64>, now: i64) -> (Vec<String>, i64, i64) {
        let mut flags = Vec::new();
        let d = Data { db: self.db, guild: self.guild, module: MODULE };
        let hist: Vec<Value> = d.get(&format!("hist:{user}")).and_then(|h| h.as_array().cloned()).unwrap_or_default();
        let at = |e: &Value| e["at"].as_i64().unwrap_or(0);
        let warns = hist.iter().filter(|e| e["type"] == "warn" && now - at(e) < 30 * DAY).count() as i64;
        let recent = hist.iter().filter(|e| matches!(e["type"].as_str(), Some("warn" | "timeout" | "automod" | "kick" | "ban")) && now - at(e) < 30 * DAY).count() as i64;
        if let Some(j) = joined_at.filter(|j| now - j < DAY && now >= *j) { let _ = j; flags.push("left within a day of joining".to_string()); }
        if hist.iter().any(|e| e["type"] == "timeout" && at(e) + e["durationMs"].as_i64().unwrap_or(0) > now) { flags.push("was timed out when they left".into()); }
        if let Some(e) = hist.iter().find(|e| matches!(e["type"].as_str(), Some("warn" | "timeout")) && now - at(e) < HOUR && now >= at(e)) { flags.push(format!("left within an hour of a {}", e["type"].as_str().unwrap_or("warning"))); }
        if warns > 0 { flags.push(format!("had {warns} warning{} in the last 30 days", if warns == 1 { "" } else { "s" })); }
        let watched = self.db.get().watch_about(self.guild, user).unwrap_or_default().iter().any(|w| matches!(w.status.as_str(), "open" | "pending" | "confirmed" | "watching"));
        if watched { flags.push("is on the staff watch list".into()); }
        (flags, warns, recent)
    }
    /// Somebody left. Writes the record (when the server keeps them) and, when something stands out, tells the
    /// staff in the mod log.
    pub fn left(&self, m: &Member, now: i64) -> Vec<Action> {
        if !self.keeps_records() || m.bot { return Vec::new(); }
        let known = self.db.get().roster_get(self.guild, &m.id).ok().flatten();
        let name = if m.name.trim().is_empty() { known.as_ref().map(|k| k.0.clone()).unwrap_or_default() } else { m.name.clone() };
        if name.is_empty() { return Vec::new(); }
        let joined = m.joined_at.or_else(|| known.as_ref().and_then(|k| k.2));
        let roles = if m.roles.is_empty() { known.as_ref().map(|k| k.3.clone()).unwrap_or_default() } else { m.roles.clone() };
        let (flags, warns, recent) = self.flags(&m.id, joined, now);
        let avatar = m.avatar.clone().or_else(|| known.as_ref().and_then(|k| k.1.clone()));
        let l = Leaving { user: &m.id, name: &name, avatar: avatar.as_deref(), at: now, joined_at: joined, roles: &roles, strikes: warns, cases: recent, flags: &flags };
        let fresh = self.db.get().roster_left(self.guild, &l).is_ok();
        // a kick or ban our own commands made a moment ago explains the leaving
        let d = Data { db: self.db, guild: self.guild, module: MODULE };
        let case = d.get(&format!("hist:{}", m.id)).and_then(|h| h.as_array().and_then(|a| a.iter().find(|e| matches!(e["type"].as_str(), Some("kick" | "ban")) && now - e["at"].as_i64().unwrap_or(0) < 120_000).cloned()));
        if let Some(c) = case {
            let how = if c["type"] == "ban" { "banned" } else { "kicked" };
            let _ = self.db.get().roster_how(self.guild, &m.id, how, c["modId"].as_str(), c["reason"].as_str(), now, 120_000);
        }
        if !fresh || flags.is_empty() || !self.settings.bool(self.guild, MODULE, "leaveAlerts") { return Vec::new(); }
        let Some(channel) = self.settings.text(self.guild, MODULE, "logChannel").filter(|c| !c.is_empty()) else { return Vec::new() };
        let card = Card::new(Area::Moderation).title("👋 A member left, and something stands out")
            .line(format!("**{}** (<@{}>)\n{}", name.replace(['*', '_', '`', '~', '|', '>', '@'], ""), m.id, flags.iter().map(|f| format!("• {f}")).collect::<Vec<_>>().join("\n")))
            .line("-# Leave records are kept for a while. See them in the launcher under Members > Leavers.");
        vec![Action::Send { channel, card, ping: Vec::new(), roles: Vec::new() }]
    }
    /// A ban arrived from Discord (by a moderator, a bot or the audit log): the record of the leaving says so.
    pub fn banned(&self, user: &str, name: &str, now: i64) {
        if !self.keeps_records() { return; }
        let fresh = self.db.get().roster_how(self.guild, user, "banned", None, None, now, 120_000).unwrap_or(false);
        if fresh { return; }
        // no leaving was seen (the member was not in the list): a record is still made
        let known = self.db.get().roster_get(self.guild, user).ok().flatten();
        let name = if name.is_empty() { known.as_ref().map(|k| k.0.clone()).unwrap_or_default() } else { name.to_string() };
        if name.is_empty() { return; }
        let l = Leaving { user, name: &name, avatar: known.as_ref().and_then(|k| k.1.as_deref()), at: now, joined_at: known.as_ref().and_then(|k| k.2), roles: &[], strikes: 0, cases: 0, flags: &[] };
        if self.db.get().roster_left(self.guild, &l).is_ok() { let _ = self.db.get().roster_how(self.guild, user, "banned", None, None, now, 120_000); }
    }
    /// Forgets what is past its time.
    pub fn prune(&self, now: i64) -> usize {
        self.db.get().roster_prune(self.guild, now - self.days() * DAY).unwrap_or(0)
    }
}

/// Once an hour, forgets leave records that are past their time in every server.
pub fn prune_due(db: &Db, settings: &Settings, now: i64) {
    static LAST: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
    let last = LAST.load(std::sync::atomic::Ordering::Relaxed);
    // once an hour; a clock that jumped back just runs it again
    if now >= last && now - last < HOUR { return; }
    LAST.store(now, std::sync::atomic::Ordering::Relaxed);
    let guilds = db.get().roster_guilds().unwrap_or_default();
    for g in guilds { Roster { db, settings, guild: &g }.prune(now); }
}
