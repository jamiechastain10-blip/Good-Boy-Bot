//! Good Boy 3's activity statistics: messages, voice time (connected, not necessarily talking) and reactions per day,
//! per member and per channel. Message text is never stored, only counts. `/stats member|me|server|top|coverage|
//! recap|backfill|inactive|optout|optin|forget`, a weekly recap, the monthly "who has gone quiet" review with a "we
//! miss you" message and a kick list that always asks first, and counter channels (what Statbot did). The same tables,
//! rules and wording as Good Boy 3.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::store::Data;
use crate::{notify, Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Def, Kind, Member, MessageEvent, Select, Settings};
use gb_data::stats::Batch;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

pub const MODULE: &str = "stats";
pub const VIEW: Perm = Perm { key: "stats.view", level: Level::Everyone };
pub const MANAGE: Perm = Perm { key: "stats.manage", level: Level::Admin };
pub const PRUNE: Perm = Perm { key: "stats.prune", level: Level::Moderator(Some(1 << 1)) };
pub static SETTINGS: &[Def] = &[
    Def { key: "trackVoice", label: "Count time connected to voice channels", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "ignoredChannels", label: "Channels or categories that are not counted - IDs", kind: Kind::List, default: Fallback::None },
    Def { key: "recapChannel", label: "Where the weekly recap is posted (leave empty for none)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "inactiveDays", label: "Inactive members: no activity for this many days", kind: Kind::Number { min: 7, max: 365 }, default: Fallback::Int(30) },
    Def { key: "inactiveExemptRoles", label: "Inactive members: roles that are never listed (role IDs, one per line)", kind: Kind::List, default: Fallback::None },
    Def { key: "inactiveGhostDays", label: "Inactive members: members who never sent a message are listed after this many days in the server (0 = same as above)", kind: Kind::Number { min: 0, max: 365 }, default: Fallback::Int(0) },
    Def { key: "inactiveProtectMessages", label: "Inactive members: members with at least this many messages in all are only listed after twice the days (0 = off)", kind: Kind::Number { min: 0, max: 100_000 }, default: Fallback::Int(0) },
    Def { key: "inactiveUnverifiedDays", label: "Inactive members: members still holding the unverified role this many days after joining are listed (0 = off)", kind: Kind::Number { min: 0, max: 365 }, default: Fallback::Int(0) },
    Def { key: "inactiveAuto", label: "Monthly review: remove quiet members by itself (only ones already sent the \"we miss you\" message, never staff or kept members)", kind: Kind::Select(&["off", "kick"]), default: Fallback::Str("off") },
    Def { key: "inactiveAutoMax", label: "Most members the monthly review may remove by itself", kind: Kind::Number { min: 1, max: 500 }, default: Fallback::Int(25) },
    Def { key: "inactiveGrace", label: "Days someone must have had since the \"we miss you\" message before they can be removed by itself", kind: Kind::Number { min: 0, max: 30 }, default: Fallback::Int(6) },
    Def { key: "inactiveWarn", label: "Inactive members: send a \"we miss you\" message a week before the monthly review", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "inactiveWarnText", label: "That message ({server}, {days})", kind: Kind::Text { max_len: 500 }, default: Fallback::Str("Hey! We haven't seen you in {server} for a while. Come say hi, members who stay quiet for {days} days are removed at the start of next month (you can always rejoin).") },
    Def { key: "reviewChannel", label: "Staff channel for the monthly activity review (leave empty for none)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "inactiveDm", label: "Inactive members: send a message before kicking", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "inactiveDmText", label: "That message ({server}, {days})", kind: Kind::Text { max_len: 500 }, default: Fallback::Str("You were removed from {server} because you haven't been active for {days} days. You're welcome back any time!") },
    Def { key: "timezoneOffset", label: "Server timezone offset from UTC, in hours (decides where a day and a week start)", kind: Kind::Number { min: -12, max: 14 }, default: Fallback::Int(0) },
];
const PERIODS: &[(&str, &str)] = &[("this month", "month"), ("last month", "lastmonth"), ("last 7 days", "7d"), ("last 30 days", "30d"), ("last 90 days", "90d"), ("last year", "365d"), ("all time (includes counted history)", "all")];
const PERIOD: Opt = Opt { name: "period", about: "How far back", takes: Takes::Choice(PERIODS), required: false };
const WHO: Opt = Opt { name: "member", about: "Whose", takes: Takes::Member, required: false };
pub const COUNTER_VARS: &str = "{members} {humans} {bots} {online} {boosts} {voice}";
pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec { name: "stats", about: "Activity statistics", module: MODULE, options: &[], subs: &[
        Sub { name: "member", about: "A member's messages this month, last month, all time and month by month", options: &[Opt { name: "member", about: "Who", takes: Takes::Member, required: true }, Opt { name: "period", about: "Optional: one period instead of the full report", takes: Takes::Choice(PERIODS), required: false }] },
        Sub { name: "me", about: "Your numbers (or someone else's)", options: &[WHO, PERIOD] },
        Sub { name: "server", about: "Server totals", options: &[PERIOD] },
        Sub { name: "top", about: "Leaderboard", options: &[Opt { name: "metric", about: "What to rank", takes: Takes::Choice(&[("messages", "messages"), ("voice time", "voice"), ("reactions given", "reactions")]), required: true }, PERIOD] },
        Sub { name: "coverage", about: "Exactly what the numbers cover", options: &[] },
        Sub { name: "recap", about: "Preview a recap (staff)", options: &[PERIOD] },
        Sub { name: "backfill", about: "Count older messages from channel history (staff)", options: &[Opt { name: "days", about: "How many days back (leave empty for all time)", takes: Takes::Whole { min: 1, max: 36500 }, required: false }] },
        Sub { name: "inactive", about: "Members who have not been active lately, to clean up (staff)", options: &[Opt { name: "days", about: "No activity for how many days (empty = the server setting)", takes: Takes::Whole { min: 7, max: 365 }, required: false }, Opt { name: "show", about: "Which members to list", takes: Takes::Choice(&[("everyone quiet", "all"), ("never sent a message", "never"), ("spoke before, now quiet", "once"), ("still unverified", "unverified")]), required: false }] },
        Sub { name: "keep", about: "Never list a member as inactive, or stop keeping them (staff)", options: &[Opt { name: "member", about: "Who", takes: Takes::Member, required: true }, Opt { name: "do", about: "Keep or stop keeping", takes: Takes::Choice(&[("keep them", "add"), ("stop keeping them", "remove")]), required: false }] },
        Sub { name: "optout", about: "Stop being counted", options: &[] },
        Sub { name: "optin", about: "Be counted again", options: &[] },
        Sub { name: "forget", about: "Erase your numbers in this server", options: &[] },
    ] },
    CommandSpec { name: "counter", about: "Voice channels that show live numbers in their name (staff)", module: MODULE, options: &[], subs: &[
        Sub { name: "add", about: "Make a channel a counter", options: &[Opt { name: "channel", about: "A voice channel (members see the name, nobody needs to join)", takes: Takes::AnyChannel, required: true }, Opt { name: "text", about: "The name, with {members} {humans} {bots} {online} {boosts} {voice}", takes: Takes::Text, required: true }] },
        Sub { name: "remove", about: "Stop updating a counter", options: &[Opt { name: "channel", about: "Which one", takes: Takes::AnyChannel, required: true }] },
        Sub { name: "list", about: "Every counter", options: &[] },
    ] },
];
const DAY: i64 = 86_400_000;
const MAX_SESSION_SECONDS: i64 = 12 * 3600;
const STAFF_BITS: [u64; 4] = [1 << 3, 1 << 5, 1 << 1, 1 << 2];
const PAGE: usize = 15;
const FAR: &str = "9999-99-99";

// ------------------------------------------------------------------ days (Good Boy 3's activity.js)
pub fn day_key(ms: i64, off: i64) -> String {
    crate::time::date(ms + off * 3_600_000)
}
fn day_num(key: &str) -> i64 {
    let p: Vec<i64> = key.split('-').map(|x| x.parse().unwrap_or(0)).collect();
    if p.len() == 3 { crate::time::days_from_civil(p[0], p[1], p[2]) } else { 0 }
}
pub fn add_days(key: &str, n: i64) -> String {
    let (y, m, d) = crate::time::civil(day_num(key) + n);
    format!("{y:04}-{m:02}-{d:02}")
}
/// The Monday of the week a moment is in, as a day key.
pub fn week_start_key(ms: i64, off: i64) -> String {
    let k = day_key(ms, off);
    add_days(&k, -((day_num(&k) + 3).rem_euclid(7)))
}
/// A period as [from, to) day keys.
pub fn period_range(period: &str, now: i64, off: i64) -> (String, String) {
    let today = day_key(now, off);
    let month_start = format!("{}-01", &today[..7]);
    match period {
        "month" => (month_start, FAR.into()),
        "lastmonth" => {
            let (y, m) = (today[..4].parse::<i64>().unwrap_or(1970), today[5..7].parse::<i64>().unwrap_or(1));
            let prev = if m == 1 { format!("{}-12", y - 1) } else { format!("{y}-{:02}", m - 1) };
            (format!("{prev}-01"), month_start)
        }
        "all" => ("0000-00-00".into(), FAR.into()),
        p => {
            let n = match p { "7d" => 7, "30d" => 30, "90d" => 90, "365d" => 365, _ => 7 };
            (add_days(&today, -(n - 1)), FAR.into())
        }
    }
}
fn period_words(p: &str) -> &'static str {
    match p { "all" => "all time", "month" => "this month", "lastmonth" => "last month", "7d" => "last 7 days", "30d" => "last 30 days", "90d" => "last 90 days", "365d" => "last year", _ => "last 7 days" }
}
/// Seconds as hours with one decimal, written the way JavaScript writes a number (1.5, 2).
pub fn hours(seconds: i64) -> String {
    let h = (seconds as f64 / 3600.0 * 10.0).round() / 10.0;
    if h.fract() == 0.0 { format!("{}", h as i64) } else { format!("{h}") }
}
fn group(n: i64) -> String {
    crate::card::group(n)
}
/// A counter channel's name with the numbers filled in.
pub fn counter_name(tpl: &str, v: &HashMap<&str, i64>) -> String {
    let mut out = tpl.to_string();
    for k in ["members", "humans", "bots", "online", "boosts", "voice"] { out = out.replace(&format!("{{{k}}}"), &group(v.get(k).copied().unwrap_or(0))); }
    out.chars().take(100).collect()
}
fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}
fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
fn tag(ms: i64, style: &str) -> String {
    format!("<t:{}:{style}>", ms / 1000)
}

// ------------------------------------------------------------------ live counting, buffered and flushed every few seconds
#[derive(Default)]
struct Buf {
    users: HashMap<(String, String), (i64, i64, i64)>,
    channels: HashMap<(String, String), i64>,
    hours: HashMap<i64, i64>,
    days: HashMap<String, (i64, i64)>,
}
#[derive(Default)]
struct Live {
    bufs: HashMap<String, Buf>,
    voice: HashMap<(String, String), i64>,
    optout: HashMap<String, HashSet<String>>,
    counters_at: HashMap<String, i64>,
}
fn live() -> std::sync::MutexGuard<'static, Live> {
    static L: OnceLock<Mutex<Live>> = OnceLock::new();
    L.get_or_init(Mutex::default).lock().unwrap_or_else(|p| p.into_inner())
}

/// What the Discord layer knows about a member when it looks for quiet ones.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MemberFact {
    pub id: String,
    pub name: String,
    pub bot: bool,
    pub joined_at: Option<i64>,
    pub perms: u64,
    pub roles: Vec<String>,
    pub owner: bool,
    pub kickable: bool,
}
#[derive(Debug, Clone, PartialEq)]
pub enum InactiveOp {
    List { page: usize },
    Pick { ids: Vec<String> },
    All,
    Confirm,
    Back,
    /// The monthly review for staff.
    Review,
    /// The "we miss you" messages.
    MissYou,
    /// Which members the list shows: "all", "never", "once" or "unverified".
    Show { show: String },
    /// The list as a spreadsheet file.
    Export,
    /// Writes the list where the launcher reads it (nothing is sent to Discord).
    Snapshot { show: String },
    /// Removes these members at once (the launcher asks first).
    Kick { ids: Vec<String> },
}
#[derive(Debug, Clone, PartialEq)]
pub struct InactiveAsk {
    pub owner: String,
    pub days: i64,
    pub op: InactiveOp,
    /// The answer replaces the card the member pressed (instead of a new private answer).
    pub update: bool,
}
/// One quiet member.
#[derive(Debug, Clone, PartialEq)]
pub struct Quiet {
    pub id: String,
    pub last: Option<String>,
    pub total: i64,
    pub joined: Option<i64>,
    pub kickable: bool,
    pub name: String,
    /// Why they are listed: "never" (no message on record), "quiet" (stopped), or "unverified" (never got past the gate).
    pub why: &'static str,
}

pub struct Stats<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub guild: &'a str,
    pub server: &'a str,
}
impl Stats<'_> {
    fn data(&self) -> Data<'_> {
        Data { db: self.db, guild: self.guild, module: MODULE }
    }
    fn off(&self) -> i64 {
        self.settings.int(self.guild, MODULE, "timezoneOffset")
    }
    fn ignored(&self, channel: &str, parent: Option<&str>) -> bool {
        let l: Vec<String> = self.settings.list(self.guild, MODULE, "ignoredChannels");
        l.iter().any(|c| c == channel) || parent.is_some_and(|p| l.iter().any(|c| c == p))
    }
    fn opted_out(&self, user: &str) -> bool {
        let loaded = live().optout.contains_key(self.guild);
        if !loaded {
            let list: HashSet<String> = self.db.get().stats_optouts(self.guild).unwrap_or_default().into_iter().collect();
            live().optout.insert(self.guild.to_string(), list);
        }
        live().optout.get(self.guild).is_some_and(|s| s.contains(user))
    }
    fn ensure_coverage(&self, now: i64) {
        if self.data().get("coverage").is_none() { self.data().set("coverage", &json!({ "trackingSince": now })); }
    }
    pub fn on_message(&self, ev: &MessageEvent, parent: Option<&str>) {
        if ev.author.bot { return; }
        if self.opted_out(&ev.author.id) || self.ignored(&ev.place.channel, parent) { return; }
        self.ensure_coverage(ev.at_ms);
        let (day, off) = (day_key(ev.at_ms, self.off()), self.off());
        let mut l = live();
        let b = l.bufs.entry(self.guild.to_string()).or_default();
        b.users.entry((ev.author.id.clone(), day.clone())).or_default().0 += 1;
        *b.channels.entry((ev.place.channel.clone(), day)).or_default() += 1;
        *b.hours.entry(((ev.at_ms + off * 3_600_000).div_euclid(3_600_000)).rem_euclid(24)).or_default() += 1;
    }
    pub fn on_reaction(&self, user: &str, now: i64) {
        if self.opted_out(user) { return; }
        let day = day_key(now, self.off());
        live().bufs.entry(self.guild.to_string()).or_default().users.entry((user.to_string(), day)).or_default().2 += 1;
    }
    /// Voice time: counted while connected (not in the AFK channel or an ignored one), when the member leaves.
    pub fn on_voice(&self, who: &Member, from: Option<&str>, to: Option<&str>, afk: Option<&str>, now: i64) {
        if !self.settings.bool(self.guild, MODULE, "trackVoice") || who.bot || self.opted_out(&who.id) { return; }
        let counts = |c: Option<&str>| c.is_some_and(|c| Some(c) != afk && !self.ignored(c, None));
        let (was, is) = (counts(from), counts(to));
        let key = (self.guild.to_string(), who.id.clone());
        if was && !is {
            let started = live().voice.remove(&key);
            if let Some(t) = started {
                let s = ((now - t) / 1000).clamp(0, MAX_SESSION_SECONDS);
                if s > 0 { let day = day_key(now, self.off()); live().bufs.entry(self.guild.to_string()).or_default().users.entry((who.id.clone(), day)).or_default().1 += s; }
            }
        } else if !was && is { live().voice.entry(key).or_insert(now); }
    }
    /// Members already in voice when the bot starts.
    pub fn voice_seen(&self, user: &str, channel: &str, afk: Option<&str>, now: i64) {
        if Some(channel) != afk && !self.ignored(channel, None) { live().voice.entry((self.guild.to_string(), user.to_string())).or_insert(now); }
    }
    pub fn on_member(&self, joined: bool, now: i64) {
        let day = day_key(now, self.off());
        let mut l = live();
        let e = l.bufs.entry(self.guild.to_string()).or_default().days.entry(day).or_default();
        if joined { e.0 += 1 } else { e.1 += 1 }
    }
    /// Counts in memory go to the database; open voice sessions are counted up to now first.
    pub fn flush(&self, now: i64, close_voice: bool) {
        let batch = {
            let mut l = live();
            if close_voice {
                let off = self.off();
                let open: Vec<(String, i64)> = l.voice.iter().filter(|((g, _), _)| g == self.guild).map(|((_, u), t)| (u.clone(), *t)).collect();
                for (u, t) in open {
                    let s = ((now - t) / 1000).clamp(0, MAX_SESSION_SECONDS);
                    if s > 0 { l.bufs.entry(self.guild.to_string()).or_default().users.entry((u.clone(), day_key(now, off))).or_default().1 += s; }
                    l.voice.insert((self.guild.to_string(), u), now);
                }
            }
            let Some(b) = l.bufs.remove(self.guild) else { return };
            Batch { users: b.users.into_iter().map(|((u, d), (m, v, r))| (u, d, m, v, r)).collect(), channels: b.channels.into_iter().map(|((c, d), m)| (c, d, m)).collect(), hours: b.hours.into_iter().collect(), days: b.days.into_iter().map(|(d, (j, l))| (d, j, l)).collect() }
        };
        let _ = self.db.get().stats_flush(self.guild, &batch);
    }

    // ------------------------------------------------------------------ what is shown
    fn lines(&self, rows: &[(String, i64)], fmt: &dyn Fn(i64) -> String) -> String {
        if rows.is_empty() { return "*nothing yet*".into(); }
        rows.iter().enumerate().map(|(n, (id, v))| format!("**{}.** <@{id}> · {}", n + 1, fmt(*v))).collect::<Vec<_>>().join("\n")
    }
    fn chan_lines(&self, rows: &[(String, i64)]) -> String {
        if rows.is_empty() { return "*nothing yet*".into(); }
        rows.iter().enumerate().map(|(n, (id, v))| format!("**{}.** <#{id}> · {} messages", n + 1, group(*v))).collect::<Vec<_>>().join("\n")
    }
    pub fn coverage_text(&self) -> String {
        let Some(c) = self.data().get("coverage") else { return "Live tracking has not started yet.".into() };
        let mut parts = vec![format!("Live tracking since {}: messages, voice time (connected, not necessarily talking) and reactions.", tag(c["trackingSince"].as_i64().unwrap_or(0), "f"))];
        match c.get("backfill").filter(|b| !b.is_null()) {
            Some(bf) => {
                parts.push(format!("Message counts before that were **backfilled** on {} from channel history: {} messages in {} channel{}{}.", tag(bf["ranAt"].as_i64().unwrap_or(0), "f"), group(bf["messages"].as_i64().unwrap_or(0)), bf["channels"], if bf["channels"].as_i64() == Some(1) { "" } else { "s" }, bf["oldest"].as_i64().map(|o| format!(", going back to {}", tag(o, "D"))).unwrap_or_default()));
                let list = |k: &str| -> Vec<String> { bf[k].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default() };
                let (skipped, truncated) = (list("skipped"), list("truncated"));
                if !skipped.is_empty() { parts.push(format!("I could not read {} channel{} ({}{}), so they are missing.", skipped.len(), if skipped.len() == 1 { "" } else { "s" }, skipped.iter().take(5).map(|id| format!("<#{id}>")).collect::<Vec<_>>().join(" "), if skipped.len() > 5 { " …" } else { "" })); }
                if !truncated.is_empty() { parts.push(format!("The limit was reached in {} channel{} ({}{}): older messages there are not counted.", truncated.len(), if truncated.len() == 1 { "" } else { "s" }, truncated.iter().take(5).map(|id| format!("<#{id}>")).collect::<Vec<_>>().join(" "), if truncated.len() > 5 { " …" } else { "" })); }
                parts.push("Backfilled numbers cover messages only, and only members who were still in the server and not opted out are counted from the author on each message.".into());
            }
            None => parts.push("No older history has been counted. Staff can run `/stats backfill`.".into()),
        }
        parts.push("Voice time and reactions from before tracking started cannot be recovered. Message text is never stored.".into());
        parts.join("\n")
    }
    pub fn recap_card(&self, from: &str, to: &str, label: &str) -> Card {
        let db = self.db.get();
        let t = db.stats_totals(self.guild, from, to).unwrap_or_default();
        let top_m = db.stats_top(self.guild, "messages", from, to, 5).unwrap_or_default();
        let top_v = db.stats_top(self.guild, "voice", from, to, 3).unwrap_or_default();
        let top_c = db.stats_top_channels(self.guild, from, to, 3).unwrap_or_default();
        drop(db);
        let mut card = Card::new(Area::General).title(format!("📊 {label}"))
            .line(format!("{} messages · {} voice hours · {} reactions · {} active member{}\n+{} joined · −{} left", group(t.messages), hours(t.voice), group(t.reactions), t.people, if t.people == 1 { "" } else { "s" }, t.joins, t.leaves))
            .line(format!("**Most messages**\n{}", self.lines(&top_m, &|n| group(n))))
            .line(format!("**Most time in voice**\n{}", self.lines(&top_v, &|n| format!("{} h", hours(n)))))
            .line(format!("**Busiest channels**\n{}", self.chan_lines(&top_c)))
            .line("-# Counts only: message text is not stored. Members can opt out with /stats optout.");
        card.accent = Some(0x38bdf8);
        card
    }
    /// One member at a glance: this month, last month, all time, and the last 6 months one by one.
    pub fn member_report(&self, user: &str, name: &str, joined: Option<i64>, now: i64) -> Card {
        self.flush(now, false);
        let off = self.off();
        let (tm, lm) = (period_range("month", now, off), period_range("lastmonth", now, off));
        let db = self.db.get();
        let (this, last, all) = (db.stats_sum(self.guild, user, &tm.0, &tm.1).unwrap_or_default(), db.stats_sum(self.guild, user, &lm.0, &lm.1).unwrap_or_default(), db.stats_sum(self.guild, user, "0000-00-00", FAR).unwrap_or_default());
        let rank = |from: &str, to: &str, n: i64| if n > 0 { db.stats_rank(self.guild, from, to, n).ok().map(|r| format!(" · #{r}")).unwrap_or_default() } else { String::new() };
        let (r1, r2, r3) = (rank(&tm.0, &tm.1, this.messages), rank(&lm.0, &lm.1, last.messages), rank("0000-00-00", FAR, all.messages));
        let months = db.stats_months(self.guild, user, 6).unwrap_or_default();
        let last_active = db.stats_last_day(self.guild, user).ok().flatten();
        drop(db);
        let max = months.iter().map(|m| m.1).max().unwrap_or(1).max(1);
        const NAMES: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        let label = |ym: &str| format!("{} {}", NAMES[(ym[5..7].parse::<usize>().unwrap_or(1) - 1).min(11)], &ym[..4]);
        let by_month = if months.is_empty() { "*No messages counted yet.*".to_string() } else { months.iter().map(|(m, n)| format!("`{:<8}` {} {}", label(m), "▰".repeat(((*n as f64 / max as f64) * 12.0).round().max(1.0) as usize), group(*n))).collect::<Vec<_>>().join("\n") };
        let mut card = Card::new(Area::General).title(format!("📊 {name}"))
            .line(format!("**This month**\n**{}** messages{r1}\n{} h voice · {} active days", group(this.messages), hours(this.voice), this.days))
            .line(format!("**Last month**\n**{}** messages{r2}\n{} h voice · {} active days", group(last.messages), hours(last.voice), last.days))
            .line(format!("**All time**\n**{}** messages{r3}\n{} h voice · {} active days", group(all.messages), hours(all.voice), all.days))
            .line(format!("**Month by month**\n{by_month}"))
            .line(format!("**Last active** {} · **Joined** {}", last_active.unwrap_or_else(|| "never".into()), joined.map(|j| tag(j, "D")).unwrap_or_else(|| "-".into())))
            .line(format!("-# Ranks are by messages.{} Pick a period in /stats member for other ranges.", if all.bf > 0 { format!(" Includes {} counted from older history.", group(all.bf)) } else { String::new() }));
        card.accent = Some(0x38bdf8);
        card
    }

    pub fn command(&self, ev: &CommandEvent, name_of: &dyn Fn(&str) -> Option<String>) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, VIEW) { return private(format!("You don't have permission for that (`{}`).", VIEW.key)); }
        if ev.name == "Message stats" {
            let Some(u) = ev.target.as_ref() else { return private("Pick a member.") };
            if self.opted_out(&u.id) { return private("That member opted out of statistics."); }
            return vec![Action::Reply { card: self.member_report(&u.id, &u.name, u.joined_at, ev.at_ms).private() }];
        }
        if ev.name == "counter" { return self.counter_command(ev); }
        let me = ev.member.id.as_str();
        let arg = |k: &str| ev.args.get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let sub = ev.sub.as_deref().unwrap_or("me");
        self.flush(ev.at_ms, true);
        match sub {
            "optout" => {
                let _ = self.db.get().stats_set_optout(self.guild, me, true, ev.at_ms);
                live().optout.entry(self.guild.to_string()).or_default().insert(me.to_string());
                private("You are no longer counted in statistics or achievements progress here. Your existing numbers stay until you run `/stats forget`.")
            }
            "optin" => {
                let _ = self.db.get().stats_set_optout(self.guild, me, false, ev.at_ms);
                live().optout.entry(self.guild.to_string()).or_default().remove(me);
                private("You are counted again from now on.")
            }
            "forget" => { let _ = self.db.get().stats_forget(self.guild, me); private("Your activity numbers in this server were erased. (Server-wide channel totals are anonymous counts and stay.) Use `/stats optout` to stop being counted.") }
            "coverage" => private(self.coverage_text()),
            "inactive" => {
                if !perms::allowed(self.db, self.guild, &ev.member, PRUNE) { return private(format!("You don't have permission for that (`{}`).", PRUNE.key)); }
                let days = arg("days").and_then(|d| d.parse().ok()).unwrap_or_else(|| self.settings.int(self.guild, MODULE, "inactiveDays"));
                if let Some(show) = arg("show") { self.data().set(&format!("inactive:view:{me}"), &json!({ "show": show })); }
                vec![Action::Inactive(Box::new(InactiveAsk { owner: me.into(), days, op: InactiveOp::List { page: 0 }, update: false }))]
            }
            "keep" => {
                if !perms::allowed(self.db, self.guild, &ev.member, PRUNE) { return private(format!("You don't have permission for that (`{}`).", PRUNE.key)); }
                let Some(t) = ev.target.as_ref() else { return private("Pick a member.") };
                let keep = arg("do").as_deref() != Some("remove");
                self.keep_set(&t.id, me, keep, ev.at_ms);
                private(if keep { format!("**{}** will never be listed as inactive. `/stats keep` with \"stop keeping them\" undoes it.", short(&t.name, 40)) } else { format!("**{}** can be listed as inactive again.", short(&t.name, 40)) })
            }
            "backfill" => {
                if !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private(format!("You don't have permission for that (`{}`).", MANAGE.key)); }
                let days = arg("days").and_then(|d| d.parse::<i64>().ok());
                self.ensure_coverage(ev.at_ms);
                let mut out = private(format!("📊 Started counting message history ({}, including threads). Big servers can take a while: Discord hands out 100 messages at a time.\nI'll **message you when it's done**. Check on it any time with `/stats coverage`.", days.map(|d| format!("the last {} days", group(d))).unwrap_or_else(|| "**all time**".into())));
                out.push(Action::Backfill { days, by: me.into(), channel: ev.place.channel.clone() });
                out
            }
            _ => {
                let chosen = arg("period");
                let has_bf = self.data().get("coverage").is_some_and(|c| c.get("backfill").is_some_and(|b| !b.is_null()));
                let period = chosen.clone().unwrap_or_else(|| if matches!(sub, "me" | "member") { "month".into() } else if has_bf { "all".into() } else { "7d".into() });
                let (from, to) = period_range(&period, ev.at_ms, self.off());
                match sub {
                    "recap" => {
                        if !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private(format!("You don't have permission for that (`{}`).", MANAGE.key)); }
                        let end = if to == FAR { day_key(ev.at_ms + DAY, self.off()) } else { to };
                        vec![Action::Reply { card: self.recap_card(&from, &end, &format!("{} in {}", period_words(&period), self.server)).private() }]
                    }
                    "server" => {
                        let t = self.db.get().stats_totals(self.guild, &from, &to).unwrap_or_default();
                        let top = self.db.get().stats_top_channels(self.guild, &from, &to, 5).unwrap_or_default();
                        let mut card = Card::new(Area::General).title(format!("📊 Server · {}", period_words(&period)))
                            .line(format!("**Messages** {} · **Voice hours** {} · **Reactions** {}\n**Active members** {} · **Joined / left** +{} / −{}", group(t.messages), hours(t.voice), group(t.reactions), t.people, t.joins, t.leaves))
                            .line(format!("**Busiest channels**\n{}", self.chan_lines(&top))).line("-# See /stats coverage for what these numbers include.").private();
                        card.accent = Some(0x38bdf8);
                        vec![Action::Reply { card }]
                    }
                    "top" => {
                        let metric = arg("metric").unwrap_or_else(|| "messages".into());
                        let rows = self.db.get().stats_top(self.guild, &metric, &from, &to, 10).unwrap_or_default();
                        let mut card = Card::new(Area::General).title(format!("🏆 Top {metric} · {}", period_words(&period))).line(self.lines(&rows, &|n| if metric == "voice" { format!("{} h", hours(n)) } else { group(n) })).private();
                        card.accent = Some(0xfbbf24);
                        vec![Action::Reply { card }]
                    }
                    _ => {
                        let user = ev.target.clone().unwrap_or_else(|| ev.member.clone());
                        let name = if user.name.is_empty() { name_of(&user.id).unwrap_or_else(|| user.id.clone()) } else { user.name.clone() };
                        if self.opted_out(&user.id) { return private(if user.id == me { "You opted out of statistics. Use `/stats optin` to be counted again." } else { "That member opted out of statistics." }); }
                        if chosen.is_none() { return vec![Action::Reply { card: self.member_report(&user.id, &name, user.joined_at, ev.at_ms).private() }]; }
                        let r = self.db.get().stats_sum(self.guild, &user.id, &from, &to).unwrap_or_default();
                        let rank = self.db.get().stats_rank(self.guild, &from, &to, r.messages).unwrap_or(1);
                        let mut card = Card::new(Area::General).title(format!("📊 {name} · {}", period_words(&period)))
                            .line(format!("**Messages** {}{}\n**Voice hours** {} · **Reactions given** {}\n**Active days** {} · **Message rank** {}", group(r.messages), if r.bf > 0 { format!(" ({} backfilled)", group(r.bf)) } else { String::new() }, hours(r.voice), group(r.reactions), r.days, if r.messages > 0 { format!("#{rank}") } else { "-".into() }))
                            .line("-# Voice time = connected time. See /stats coverage.").private();
                        card.accent = Some(0x38bdf8);
                        vec![Action::Reply { card }]
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------ counters (what Statbot did)
    fn counter_command(&self, ev: &CommandEvent) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private(format!("You don't have permission for that (`{}`).", MANAGE.key)); }
        let arg = |k: &str| ev.args.get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        match ev.sub.as_deref().unwrap_or("list") {
            "list" => {
                let rows: Vec<String> = self.data().list("counter:").into_iter().map(|(k, v)| format!("<#{}> · `{}`", &k[8..], v["template"].as_str().unwrap_or(""))).collect();
                private(if rows.is_empty() { format!("No counters yet. Add one with `/counter add`. You can use {COUNTER_VARS}.") } else { rows.join("\n") })
            }
            "remove" => {
                let c = arg("channel").unwrap_or_default();
                self.data().delete(&format!("counter:{c}"));
                private(format!("Removed the counter from <#{c}>. (The channel stays; delete it in Discord if you want.)"))
            }
            _ => {
                let (Some(c), Some(tpl)) = (arg("channel"), arg("text")) else { return private("Pick a channel and write its name.") };
                if !["members", "humans", "bots", "online", "boosts", "voice"].iter().any(|k| tpl.contains(&format!("{{{k}}}"))) { return private(format!("Put at least one number in the text: {COUNTER_VARS}")); }
                self.data().set(&format!("counter:{c}"), &json!({ "template": tpl, "by": ev.member.id }));
                let mut out = private(format!("✅ <#{c}> is now a counter. It updates every 10 minutes (Discord's limit for renaming channels)."));
                out.push(Action::Counters { items: vec![(c, tpl)] });
                out
            }
        }
    }

    // ------------------------------------------------------------------ inactive members
    /// Quiet members: no activity for `days`. Never listed: bots, the owner, staff, exempt roles, kept members, new
    /// members. Also listed, by their own rules: members who never spoke (after `inactiveGhostDays`) and members
    /// still behind the verification gate (after `inactiveUnverifiedDays`); members with lots of history wait twice as long.
    pub fn quiet(&self, facts: &[MemberFact], days: i64, now: i64) -> (Vec<Quiet>, i64, bool) {
        self.flush(now, true);
        let exempt: Vec<String> = self.settings.list(self.guild, MODULE, "inactiveExemptRoles");
        let ghost_days = self.settings.int(self.guild, MODULE, "inactiveGhostDays");
        let protect = self.settings.int(self.guild, MODULE, "inactiveProtectMessages");
        let gate_days = self.settings.int(self.guild, MODULE, "inactiveUnverifiedDays");
        let gate_role = self.settings.text(self.guild, crate::welcome::MODULE, "unverifiedRole").filter(|r| !r.is_empty());
        let kept: HashSet<String> = self.keeps().into_iter().map(|k| k.0).collect();
        let last: HashMap<String, (String, i64)> = self.db.get().stats_last_active(self.guild).unwrap_or_default().into_iter().map(|(u, d, t)| (u, (d, t))).collect();
        let mut out: Vec<Quiet> = Vec::new();
        for m in facts {
            if m.bot || m.owner || STAFF_BITS.iter().any(|b| m.perms & b != 0) || m.roles.iter().any(|r| exempt.contains(r)) || kept.contains(&m.id) { continue; }
            let a = last.get(&m.id);
            let age = m.joined_at.map(|j| now - j);
            let gated = gate_days > 0 && gate_role.as_ref().is_some_and(|r| m.roles.contains(r)) && age.is_some_and(|g| g >= gate_days * DAY);
            let why: &'static str = if gated {
                "unverified"
            } else {
                // how long they must have been quiet: the server's number, shorter for members who never spoke, longer for veterans
                let mut need = days;
                if a.is_none() && ghost_days > 0 { need = ghost_days; }
                if protect > 0 && a.is_some_and(|a| a.1 >= protect) { need = days * 2; }
                if age.is_some_and(|g| g < need * DAY) { continue; }
                if a.is_some_and(|a| a.0 >= day_key(now - need * DAY, self.off())) { continue; }
                if a.is_some() { "quiet" } else { "never" }
            };
            out.push(Quiet { id: m.id.clone(), last: a.map(|a| a.0.clone()), total: a.map(|a| a.1).unwrap_or(0), joined: m.joined_at, kickable: m.kickable, name: m.name.clone(), why });
        }
        out.sort_by(|x, y| x.last.clone().unwrap_or_default().cmp(&y.last.clone().unwrap_or_default()).then(x.joined.unwrap_or(0).cmp(&y.joined.unwrap_or(0))));
        let start = self.coverage_start();
        let covered = (now - start) / DAY;
        (out, covered, covered < days)
    }
    /// Which of the listed members a view shows.
    fn shown<'q>(list: &'q [Quiet], show: &str) -> Vec<&'q Quiet> {
        list.iter().filter(|q| match show { "never" => q.why == "never", "once" => q.why == "quiet", "unverified" => q.why == "unverified", _ => true }).collect()
    }
    /// What a person last chose to see (kept per person, so buttons need not carry it).
    fn show_of(&self, owner: &str) -> String {
        self.data().get(&format!("inactive:view:{owner}")).and_then(|v| v["show"].as_str().map(str::to_string)).filter(|s| ["all", "never", "once", "unverified"].contains(&s.as_str())).unwrap_or_else(|| "all".into())
    }
    /// Members who are never listed as inactive, newest first: (id, when).
    pub fn keeps(&self) -> Vec<(String, i64)> {
        let mut v: Vec<(String, i64)> = self.data().list("keep:").into_iter().map(|(k, v)| (k[5..].to_string(), v["at"].as_i64().unwrap_or(0))).collect();
        v.sort_by_key(|k| std::cmp::Reverse(k.1));
        v
    }
    pub fn keep_set(&self, id: &str, by: &str, keep: bool, now: i64) {
        if keep { self.data().set(&format!("keep:{id}"), &json!({ "at": now, "by": by })); } else { self.data().delete(&format!("keep:{id}")); }
    }
    /// How many of the list have been quiet at least `d` days (members with no activity on record count).
    fn quiet_for(&self, list: &[Quiet], d: i64, now: i64) -> usize {
        let since = day_key(now - d * DAY, self.off());
        list.iter().filter(|q| q.why != "unverified" && q.last.as_ref().is_none_or(|l| *l < since)).count()
    }
    /// The earliest moment the numbers cover: tracking start, or further back when history was counted.
    fn coverage_start(&self) -> i64 {
        let c = self.data().get("coverage").unwrap_or(json!({}));
        let mut start = c["trackingSince"].as_i64().unwrap_or(0);
        if let Some(bf) = c.get("backfill").filter(|b| !b.is_null()) {
            let from = match bf["days"].as_i64() { Some(d) => bf["ranAt"].as_i64().unwrap_or(0) - d * DAY, None => 0 };
            start = start.min(from);
        }
        start
    }
    fn coverage_warning(days: i64, covered: i64, short: bool) -> Option<String> {
        short.then(|| format!("⚠️ Activity has only been tracked for **{covered} days**, less than {days}. \"No activity on record\" may just mean before tracking began. Run `/stats backfill` to count older messages."))
    }
    fn last_text(q: &Quiet) -> String {
        q.last.as_ref().map(|l| format!("last active {l}")).unwrap_or_else(|| "no activity on record".into())
    }
    #[allow(clippy::too_many_arguments)]
    fn inactive_card(&self, owner: &str, all: &[Quiet], show: &str, days: i64, covered: i64, short_cov: bool, page: usize, now: i64) -> Card {
        let list = Self::shown(all, show);
        let pages = list.len().div_ceil(PAGE).max(1);
        let page = page.min(pages - 1);
        let slice: Vec<&&Quiet> = list.iter().skip(page * PAGE).take(PAGE).collect();
        let lines: Vec<String> = slice.iter().enumerate().map(|(k, r)| format!("**{}.** <@{}> · {}{}{}{}{}", page * PAGE + k + 1, r.id, Self::last_text(r), if r.total > 0 { format!(" · {} msgs", group(r.total)) } else { String::new() }, r.joined.map(|j| format!(" · joined <t:{}:R>", j / 1000)).unwrap_or_default(), if r.why == "unverified" { " · never got past verification" } else { "" }, if r.kickable { "" } else { " · can't kick" })).collect();
        let never = all.iter().filter(|q| q.why == "never").count();
        let gate = all.iter().filter(|q| q.why == "unverified").count();
        let tiers = format!("**{}** listed · {} quiet 60+ days · {} quiet 90+ days · {never} never spoke{}", all.len(), self.quiet_for(all, 60, now), self.quiet_for(all, 90, now), if gate > 0 { format!(" · {gate} unverified") } else { String::new() });
        let body = [Self::coverage_warning(days, covered, short_cov), Some(tiers), Some(if lines.is_empty() { "*Nobody matches. Nothing to clean up.*".to_string() } else { lines.join("\n") })].into_iter().flatten().collect::<Vec<_>>().join("\n\n");
        let label = match show { "never" => "never sent a message", "once" => "spoke before, now quiet", "unverified" => "still unverified", _ => "all quiet members" };
        let mut card = Card::new(Area::General).title(format!("🧹 Inactive for {days}+ days · {} member{}", list.len(), if list.len() == 1 { "" } else { "s" })).line(body)
            .line(format!("-# Showing: {label} · page {}/{pages} · not listed: bots, staff, exempt or kept members, new members. `/stats keep` protects someone.", page + 1)).private();
        card.accent = Some(0xe67e22);
        let kickable: Vec<&&&Quiet> = slice.iter().filter(|r| r.kickable).collect();
        if !kickable.is_empty() {
            card = card.select(Select { id: format!("st:ik:{owner}:{days}"), placeholder: "Pick members to kick (asks first)".into(), min: 1, max: kickable.len() as u8, options: kickable.iter().map(|r| (short(&r.name, 90), r.id.clone(), None)).collect() });
        }
        card = card.select(Select { id: format!("st:is:{owner}:{days}"), placeholder: "Show a different group".into(), min: 1, max: 1, options: vec![("All quiet members".into(), "all".into(), None), ("Never sent a message".into(), "never".into(), None), ("Spoke before, now quiet".into(), "once".into(), None), ("Still unverified".into(), "unverified".into(), None)] });
        let all_kick = list.iter().filter(|r| r.kickable).count();
        card.button_full(format!("st:ip:{owner}:{days}:{}", page.saturating_sub(1)), "", ButtonStyle::Plain, Some("◀️".into()), page == 0)
            .button_full(format!("st:ip:{owner}:{days}:{}", page + 1), "", ButtonStyle::Plain, Some("▶️".into()), page + 1 >= pages)
            .button_full(format!("st:ie:{owner}:{days}"), "Export", ButtonStyle::Plain, Some("📄".into()), list.is_empty())
            .button_full(format!("st:ia:{owner}:{days}"), format!("Kick all {all_kick}"), ButtonStyle::Danger, Some("🧹".into()), all_kick == 0)
    }
    fn render(&self, ask: &InactiveAsk, card: Card) -> Vec<Action> {
        vec![if ask.update { Action::Update { card } } else { Action::Reply { card } }]
    }
    /// The member list arrived (`Action::Inactive`): the list, a confirmation, the kicks, the review or the messages.
    pub fn inactive(&self, ask: &InactiveAsk, facts: &[MemberFact], now: i64) -> Vec<Action> {
        let (full, covered, short_cov) = self.quiet(facts, ask.days, now);
        let show = if ask.owner.is_empty() { "all".to_string() } else { self.show_of(&ask.owner) };
        let list: Vec<Quiet> = Self::shown(&full, &show).into_iter().cloned().collect();
        let render_list = |page: usize| self.render(ask, self.inactive_card(&ask.owner, &full, &show, ask.days, covered, short_cov, page, now));
        // keeps the record of who was removed, and why, so an owner can look back
        let remember = |kicked: &[String], by: &str, how: &str| {
            if kicked.is_empty() { return; }
            let mut log: Vec<serde_json::Value> = self.data().get("pruneLog").and_then(|v| v.as_array().cloned()).unwrap_or_default();
            let who: Vec<serde_json::Value> = kicked.iter().take(200).map(|id| json!({ "id": id, "name": full.iter().find(|q| q.id == *id).map(|q| q.name.clone()).unwrap_or_default() })).collect();
            log.insert(0, json!({ "at": now, "by": by, "count": kicked.len(), "days": ask.days, "how": how, "members": who }));
            log.truncate(24);
            self.data().set("pruneLog", &json!(log));
        };
        let dm_text = || {
            let tpl = self.settings.text(self.guild, MODULE, "inactiveDmText").unwrap_or_default().replace("{days}", &ask.days.to_string());
            (self.settings.bool(self.guild, MODULE, "inactiveDm") && !tpl.is_empty()).then_some(tpl)
        };
        match &ask.op {
            InactiveOp::List { page } => render_list(*page),
            InactiveOp::Back => render_list(0),
            InactiveOp::Show { show: wanted } => {
                if ["all", "never", "once", "unverified"].contains(&wanted.as_str()) { self.data().set(&format!("inactive:view:{}", ask.owner), &json!({ "show": wanted })); }
                let show = self.show_of(&ask.owner);
                self.render(ask, self.inactive_card(&ask.owner, &full, &show, ask.days, covered, short_cov, 0, now))
            }
            InactiveOp::Export => {
                let mut csv = String::from("id,name,why,last_active,total_messages,joined,can_kick\n");
                for q in &list {
                    let name = q.name.replace('"', "\"\"");
                    csv.push_str(&format!("{},\"{name}\",{},{},{},{},{}\n", q.id, q.why, q.last.clone().unwrap_or_default(), q.total, q.joined.map(|j| day_key(j, 0)).unwrap_or_default(), q.kickable));
                }
                let card = Card::new(Area::General).line(format!("📄 **{}** member{} listed. Open the file in a spreadsheet.", list.len(), if list.len() == 1 { "" } else { "s" })).file("inactive-members.csv", csv.into_bytes()).private();
                vec![Action::Reply { card }]
            }
            InactiveOp::Snapshot { .. } => {
                let rows: Vec<serde_json::Value> = full.iter().take(2000).map(|q| json!({ "id": q.id, "name": q.name, "last": q.last, "total": q.total, "joined": q.joined, "kickable": q.kickable, "why": q.why })).collect();
                let tiers = json!({ "all": full.len(), "d60": self.quiet_for(&full, 60, now), "d90": self.quiet_for(&full, 90, now), "never": full.iter().filter(|q| q.why == "never").count(), "unverified": full.iter().filter(|q| q.why == "unverified").count() });
                self.data().set("inactive:snapshot", &json!({ "at": now, "days": ask.days, "covered": covered, "short": short_cov, "tiers": tiers, "rows": rows }));
                Vec::new()
            }
            InactiveOp::Kick { ids } => {
                let still: HashMap<&str, &Quiet> = full.iter().map(|q| (q.id.as_str(), q)).collect();
                let kick: Vec<String> = ids.iter().filter(|id| still.get(id.as_str()).is_some_and(|q| q.kickable)).cloned().collect();
                remember(&kick, &ask.owner, "launcher");
                let tpl = dm_text();
                kick.into_iter().map(|u| Action::KickInactive { user: u, reason: format!("Inactive for {}+ days (removed from the launcher)", ask.days), dm: tpl.clone() }).collect()
            }
            InactiveOp::Pick { .. } | InactiveOp::All => {
                let ids: Vec<String> = match &ask.op { InactiveOp::Pick { ids } => ids.clone(), _ => list.iter().filter(|r| r.kickable).map(|r| r.id.clone()).collect() };
                if ids.is_empty() { return private("Nobody to kick."); }
                self.data().set(&format!("prune:pending:{}", ask.owner), &json!({ "ids": ids, "days": ask.days, "at": now }));
                let mut card = Card::new(Area::General).line(format!("Kick **{}** member{} for being inactive {}+ days? {}{}\nThey can rejoin with an invite.", ids.len(), if ids.len() == 1 { "" } else { "s" }, ask.days, ids.iter().take(20).map(|i| format!("<@{i}>")).collect::<Vec<_>>().join(" "), if ids.len() > 20 { format!(" and {} more", ids.len() - 20) } else { String::new() })).private();
                card = card.button(format!("st:ic:{}", ask.owner), format!("Yes, kick {}", ids.len()), ButtonStyle::Danger).button(format!("st:ix:{}:{}", ask.owner, ask.days), "Cancel", ButtonStyle::Plain);
                self.render(ask, card)
            }
            InactiveOp::Confirm => {
                let key = format!("prune:pending:{}", ask.owner);
                let pending = self.data().get(&key);
                self.data().delete(&key);
                let Some(p) = pending.filter(|p| now - p["at"].as_i64().unwrap_or(0) <= 15 * 60_000) else { return private("That confirmation expired. Run `/stats inactive` again.") };
                let wanted: Vec<String> = p["ids"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
                let still: HashMap<&str, &Quiet> = full.iter().map(|q| (q.id.as_str(), q)).collect();
                let (mut kick, mut skipped) = (Vec::new(), 0);
                for id in &wanted { if still.get(id.as_str()).is_some_and(|q| q.kickable) { kick.push(id.clone()); } else { skipped += 1; } }
                remember(&kick, &ask.owner, "command");
                let tpl = dm_text();
                let mut out = vec![Action::Update { card: Card::new(Area::General).line(format!("✅ Kicked **{}**{}.", kick.len(), if skipped > 0 { format!(" · {skipped} skipped (became active, left, or I can't kick them)") } else { String::new() })) }];
                out.extend(kick.into_iter().map(|u| Action::KickInactive { user: u, reason: format!("Inactive for {}+ days (removed by {})", ask.days, ask.owner), dm: tpl.clone() }));
                out
            }
            InactiveOp::Review => {
                let Some(channel) = self.settings.text(self.guild, MODULE, "reviewChannel").filter(|c| !c.is_empty()) else { return Vec::new() };
                // by itself: only members already told ("we miss you") long enough ago, never more than the cap
                let mut gone: Vec<&Quiet> = Vec::new();
                if self.settings.text(self.guild, MODULE, "inactiveAuto").as_deref() == Some("kick") && self.settings.bool(self.guild, MODULE, "inactiveWarn") && covered >= ask.days {
                    let grace = self.settings.int(self.guild, MODULE, "inactiveGrace") * DAY;
                    let cap = self.settings.int(self.guild, MODULE, "inactiveAutoMax").max(1) as usize;
                    gone = full.iter().filter(|q| q.kickable && self.data().get(&format!("warned:{}", q.id)).and_then(|w| w["at"].as_i64()).is_some_and(|at| now - at >= grace)).take(cap).collect();
                }
                let ids: Vec<String> = gone.iter().map(|q| q.id.clone()).collect();
                remember(&ids, "the monthly review", "automatic");
                let left = full.len() - gone.len();
                let mut lines = vec![format!("**{}** member{} not been active in the last {} days.", full.len(), if full.len() == 1 { " has" } else { "s have" }, ask.days)];
                lines.extend(Self::coverage_warning(ask.days, covered, short_cov));
                if !gone.is_empty() {
                    lines.push(format!("🧹 Removed **{}** who had already been sent the \"we miss you\" message: {}{}\nThey can rejoin with an invite.", gone.len(), gone.iter().take(15).map(|q| format!("<@{}>", q.id)).collect::<Vec<_>>().join(" "), if gone.len() > 15 { format!(" and {} more", gone.len() - 15) } else { String::new() }));
                }
                lines.push(if left == 0 { "Nothing left to clean up this month.".to_string() } else { format!("**{left}** still listed. Review and kick them with `/stats inactive`, or in the launcher under Members > Inactive.") });
                let mut card = Card::new(Area::General).title("🧹 Monthly activity review").line(lines.join("\n\n"));
                card.accent = Some(0xe67e22);
                let tpl = dm_text();
                let mut out = vec![Action::Send { channel, card, ping: Vec::new(), roles: Vec::new() }];
                out.extend(ids.into_iter().map(|u| Action::KickInactive { user: u, reason: format!("Inactive for {}+ days (monthly review)", ask.days), dm: tpl.clone() }));
                out
            }
            InactiveOp::MissYou => {
                let text = self.settings.text(self.guild, MODULE, "inactiveWarnText").unwrap_or_default().replace("{days}", &ask.days.to_string());
                // who was told, and when, so the review can wait for them
                for q in &full { self.data().set(&format!("warned:{}", q.id), &json!({ "at": now })); }
                full.iter().map(|q| Action::Dm { user: q.id.clone(), card: Card::new(Area::General).line(short(&text, 1900)), or_in: None }).collect()
            }
        }
    }
    /// The buttons and the kick list.
    pub fn press(&self, ev: &ButtonEvent) -> Vec<Action> {
        let p: Vec<&str> = ev.id.split(':').collect();
        let (kind, owner) = (p.get(1).copied().unwrap_or(""), p.get(2).copied().unwrap_or(""));
        if owner != ev.member.id { return private("That list belongs to someone else. Run `/stats inactive` for your own."); }
        if !perms::allowed(self.db, self.guild, &ev.member, PRUNE) { return private(format!("You don't have permission for that (`{}`).", PRUNE.key)); }
        let days: i64 = p.get(3).and_then(|d| d.parse().ok()).unwrap_or_else(|| self.settings.int(self.guild, MODULE, "inactiveDays"));
        let op = match kind {
            "ip" => InactiveOp::List { page: p.get(4).and_then(|n| n.parse().ok()).unwrap_or(0) },
            "ix" => InactiveOp::Back,
            "ik" => InactiveOp::Pick { ids: ev.values.clone() },
            "ia" => InactiveOp::All,
            "ie" => InactiveOp::Export,
            "is" => InactiveOp::Show { show: ev.values.first().cloned().unwrap_or_default() },
            "ic" => InactiveOp::Confirm,
            _ => return private("That button is no longer active."),
        };
        vec![Action::Inactive(Box::new(InactiveAsk { owner: owner.into(), days, op: op.clone(), update: !matches!(op, InactiveOp::Export) }))]
    }

    // ------------------------------------------------------------------ the clock
    /// Every few seconds: counts go to the database; recaps, reviews, warnings and counters when their time comes.
    pub fn due(&self, now: i64) -> Vec<Action> {
        self.flush(now, true);
        let mut out = Vec::new();
        let off = self.off();
        let week = week_start_key(now, off);
        match self.data().get("lastRecapWeek").and_then(|v| v.as_str().map(str::to_string)) {
            None => self.data().set("lastRecapWeek", &json!(week)),
            Some(last) if last != week => {
                self.data().set("lastRecapWeek", &json!(week));
                let from = add_days(&week, -7);
                if let Some(c) = self.settings.text(self.guild, MODULE, "recapChannel").filter(|c| !c.is_empty()) {
                    out.push(Action::Send { channel: c, card: self.recap_card(&from, &week, &format!("Last week in {}", self.server)), ping: Vec::new(), roles: Vec::new() });
                }
                // personal recaps: only members who opted in (off unless the member or the server turns it on)
                let active: Vec<String> = self.db.get().stats_top(self.guild, "messages", &from, &week, 500).unwrap_or_default().into_iter().map(|r| r.0).collect();
                let mut sent = 0;
                for id in active {
                    if sent >= 200 { break; }
                    if self.opted_out(&id) || !notify::allowed(self.db, self.guild, &id, "recaps") || !notify::allowed(self.db, self.guild, &id, "dms") { continue; }
                    let s = self.db.get().stats_sum(self.guild, &id, &from, &week).unwrap_or_default();
                    out.push(Action::Dm { user: id, card: Card::new(Area::General).line(format!("📊 Your week: {} messages, {} voice hours. (Turn these off with /notifications.)", s.messages, hours(s.voice))), or_in: None });
                    sent += 1;
                }
            }
            _ => {}
        }
        let today = day_key(now, off);
        let month = &today[..7];
        let days = self.settings.int(self.guild, MODULE, "inactiveDays");
        // the monthly review, on the 1st
        match self.data().get("lastReviewMonth").and_then(|v| v.as_str().map(str::to_string)) {
            None => self.data().set("lastReviewMonth", &json!(month)),
            Some(last) if last != month && self.settings.text(self.guild, MODULE, "reviewChannel").is_some_and(|c| !c.is_empty()) => {
                self.data().set("lastReviewMonth", &json!(month));
                out.push(Action::Inactive(Box::new(InactiveAsk { owner: String::new(), days, op: InactiveOp::Review, update: false })));
            }
            _ => {}
        }
        // "we miss you", a week before the review
        if self.settings.bool(self.guild, MODULE, "inactiveWarn") {
            let (y, mo, d) = (today[..4].parse::<i64>().unwrap_or(1970), today[5..7].parse::<i64>().unwrap_or(1), today[8..10].parse::<i64>().unwrap_or(1));
            let in_month = crate::time::days_from_civil(if mo == 12 { y + 1 } else { y }, if mo == 12 { 1 } else { mo + 1 }, 1) - crate::time::days_from_civil(y, mo, 1);
            if d == in_month - 6 && self.data().get("lastWarnMonth").and_then(|v| v.as_str().map(str::to_string)).as_deref() != Some(month) {
                self.data().set("lastWarnMonth", &json!(month));
                out.push(Action::Inactive(Box::new(InactiveAsk { owner: String::new(), days, op: InactiveOp::MissYou, update: false })));
            }
        }
        // counter channels: every 10 minutes
        let counters: Vec<(String, String)> = self.data().list("counter:").into_iter().map(|(k, v)| (k[8..].to_string(), v["template"].as_str().unwrap_or("").to_string())).collect();
        if !counters.is_empty() {
            let due = { let mut l = live(); let at = l.counters_at.get(self.guild).copied().unwrap_or(0); if now - at >= 600_000 { l.counters_at.insert(self.guild.to_string(), now); true } else { false } };
            if due { out.push(Action::Counters { items: counters }); }
        }
        out
    }
    /// Counting older messages finished: remember what it covers (`Action::Backfill` came back).
    pub fn backfilled(&self, result: serde_json::Value, users: &[(String, String, i64)], channels: &[(String, String, i64)], hours: &[(i64, i64)]) {
        let _ = self.db.get().stats_set_backfill(self.guild, users, channels, hours);
        let mut c = self.data().get("coverage").unwrap_or(json!({}));
        c["backfill"] = result;
        self.data().set("coverage", &c);
    }
    /// Time-zone aware day, hour and optouts for the Discord layer's history count.
    pub fn counting_rules(&self) -> (i64, i64, HashSet<String>, Vec<String>) {
        let cov = self.data().get("coverage").and_then(|c| c["trackingSince"].as_i64()).unwrap_or(i64::MAX);
        let out = self.db.get().stats_optouts(self.guild).unwrap_or_default().into_iter().collect();
        (self.off(), cov, out, self.settings.list(self.guild, MODULE, "ignoredChannels"))
    }
}
