//! Moderation: warn, time out, kick, ban (for good or for a while), unban, bulk delete and a member's history.
//! Cases are saved the way Good Boy 3 saves them, so the history carries over and both versions read it.
//!
//! Not here yet: AutoMod, raid protection, anti-nuke and the server logs. Their settings are kept untouched.

use crate::automod::{self as am, ACTIONS, RULES};
use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm, BAN_MEMBERS, KICK_MEMBERS, MANAGE_MESSAGES, MODERATE_MEMBERS};
use crate::settings::Fallback;
use crate::store::Data;
use crate::time::{in_words, parse_duration, DAY, HOUR, MINUTE};
use crate::ButtonStyle;
use crate::{Action, Area, Card, CommandEvent, Db, Def, Kind, Member, MessageEvent, Settings};
use std::collections::HashMap;
use std::sync::Mutex;
use serde_json::{json, Value};

pub const MODULE: &str = "moderation";
pub static SETTINGS: &[Def] = &[
    Def { key: "logChannel", label: "Mod log channel", kind: Kind::Channel, default: Fallback::None },
    Def { key: "raidProtection", label: "Raid protection", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "raidJoinThreshold", label: "Raid: joins...", kind: Kind::Number { min: 3, max: 100 }, default: Fallback::Int(8) },
    Def { key: "raidWindowSeconds", label: "...within N seconds", kind: Kind::Number { min: 3, max: 120 }, default: Fallback::Int(10) },
    Def { key: "raidAction", label: "Raid action", kind: Kind::Select(&["alert", "timeout", "kick"]), default: Fallback::Str("alert") },
    Def { key: "minAccountAgeDays", label: "Flag accounts younger than N days (0 = off)", kind: Kind::Number { min: 0, max: 365 }, default: Fallback::Int(0) },
    Def { key: "newAccountAction", label: "Young account action", kind: Kind::Select(&["alert", "kick"]), default: Fallback::Str("alert") },
    Def { key: "antiNuke", label: "Anti-nuke", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "nukeThreshold", label: "Anti-nuke: destructive actions...", kind: Kind::Number { min: 2, max: 20 }, default: Fallback::Int(3) },
    Def { key: "nukeWindowSeconds", label: "...within N seconds", kind: Kind::Number { min: 5, max: 300 }, default: Fallback::Int(30) },
    Def { key: "nukeAction", label: "Anti-nuke response", kind: Kind::Select(&["strip-roles", "ban", "alert"]), default: Fallback::Str("strip-roles") },
    Def { key: "leaveRecords", label: "Keep a record of who leaves (name, when, how, and anything that stands out) for a while", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "leaveRecordDays", label: "Days to keep leave records", kind: Kind::Number { min: 7, max: 365 }, default: Fallback::Int(60) },
    Def { key: "leaveAlerts", label: "Tell the mod log when someone leaves and something stands out (timed out, warned, on the watch list, gone within a day)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "dmOnAction", label: "DM users when action is taken", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "logMessages", label: "Log message edits & deletes", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "serverLogChannel", label: "Server log channel for joins, roles, nicknames, voice (empty = the mod log)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "logJoins", label: "Log members joining and leaving", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "logRoles", label: "Log role changes", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "logNicknames", label: "Log nickname changes", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "logVoice", label: "Log voice joins, leaves and moves", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "warnTimeoutThreshold", label: "Auto-timeout every N warnings (0 = off)", kind: Kind::Number { min: 0, max: 20 }, default: Fallback::Int(3) },
    Def { key: "warnTimeoutMinutes", label: "Auto-timeout length (minutes)", kind: Kind::Number { min: 1, max: 40320 }, default: Fallback::Int(60) },
    Def { key: "warnKickAt", label: "Auto-kick at this many warnings (0 = off)", kind: Kind::Number { min: 0, max: 50 }, default: Fallback::Int(0) },
    Def { key: "warnBanAt", label: "Auto-ban at this many warnings (0 = off)", kind: Kind::Number { min: 0, max: 50 }, default: Fallback::Int(0) },
    Def { key: "warnExpireDays", label: "Warnings stop counting as strikes after this many days (0 = never)", kind: Kind::Number { min: 0, max: 3650 }, default: Fallback::Int(0) },
    Def { key: "appealChannel", label: "Channel where appeals are sent (empty = the mod log)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "appealVotes", label: "Staff votes needed to take a warning back", kind: Kind::Number { min: 1, max: 5 }, default: Fallback::Int(1) },
    Def { key: "reportChannel", label: "Channel where reported messages are sent (empty = the mod log)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "needApproval", label: "A second staff member must approve", kind: Kind::Select(&["off", "ban", "kick-ban"]), default: Fallback::Str("off") },
    Def { key: "banEvasionAlerts", label: "Tell staff when a new member has the same name as a banned one", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "strikeLadder", label: "Strike ladder: one step per line, such as \"2 timeout 1d\", \"4 timeout 1w\", \"6 ban 30d\" or \"10 ban\" (empty = use the three numbers above)", kind: Kind::List, default: Fallback::None },
    Def { key: "strikeResetTo", label: "After a ban from the strike ladder, strikes start again from (0 = keep counting)", kind: Kind::Number { min: 0, max: 50 }, default: Fallback::Int(0) },
    Def { key: "automodAction", label: "AutoMod action", kind: Kind::Select(&["delete", "delete-warn", "delete-timeout"]), default: Fallback::Str("delete-warn") },
    Def { key: "automodTimeoutMinutes", label: "AutoMod timeout (minutes)", kind: Kind::Number { min: 1, max: 1440 }, default: Fallback::Int(5) },
    Def { key: "automodScams", label: "Scam and phishing link filter", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "automodSpam", label: "Spam protection", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "spamMaxMessages", label: "Spam: messages allowed...", kind: Kind::Number { min: 2, max: 30 }, default: Fallback::Int(5) },
    Def { key: "spamWindowSeconds", label: "...within N seconds", kind: Kind::Number { min: 2, max: 60 }, default: Fallback::Int(6) },
    Def { key: "automodWords", label: "Word filter", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "bannedWords", label: "Banned words", kind: Kind::List, default: Fallback::None },
    Def { key: "automodLinks", label: "Link & invite filter", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "allowedDomains", label: "Allowed link domains", kind: Kind::List, default: Fallback::None },
    Def { key: "maxMentions", label: "Max mentions per message (0 = off)", kind: Kind::Number { min: 0, max: 50 }, default: Fallback::Int(6) },
    Def { key: "automodRepeat", label: "Repeated-message filter", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "repeatMax", label: "Repeats: identical messages allowed...", kind: Kind::Number { min: 2, max: 20 }, default: Fallback::Int(3) },
    Def { key: "repeatWindowSeconds", label: "...within N seconds", kind: Kind::Number { min: 5, max: 600 }, default: Fallback::Int(60) },
    Def { key: "automodCaps", label: "Capital-letters filter", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "capsPercent", label: "Caps: percent of letters in capitals", kind: Kind::Number { min: 40, max: 100 }, default: Fallback::Int(70) },
    Def { key: "capsMinLetters", label: "Caps: ignore messages with fewer letters than", kind: Kind::Number { min: 5, max: 100 }, default: Fallback::Int(12) },
    Def { key: "automodEmoji", label: "Emoji filter", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "emojiMax", label: "Emoji: most allowed in one message", kind: Kind::Number { min: 2, max: 50 }, default: Fallback::Int(10) },
    Def { key: "scamsAction", label: "Scam and phishing links: action", kind: Kind::Select(ACTIONS), default: Fallback::Str("delete-timeout") },
    Def { key: "spamAction", label: "Spam (too many messages too fast): action", kind: Kind::Select(ACTIONS), default: Fallback::Str("default") },
    Def { key: "wordsAction", label: "Word filter: action", kind: Kind::Select(ACTIONS), default: Fallback::Str("default") },
    Def { key: "linksAction", label: "Links and invites: action", kind: Kind::Select(ACTIONS), default: Fallback::Str("default") },
    Def { key: "mentionsAction", label: "Mass mentions: action", kind: Kind::Select(ACTIONS), default: Fallback::Str("default") },
    Def { key: "repeatAction", label: "Repeated messages: action", kind: Kind::Select(ACTIONS), default: Fallback::Str("default") },
    Def { key: "capsAction", label: "Too many capital letters: action", kind: Kind::Select(ACTIONS), default: Fallback::Str("default") },
    Def { key: "emojiAction", label: "Too many emoji: action", kind: Kind::Select(ACTIONS), default: Fallback::Str("default") },
    Def { key: "automodKeepSnippets", label: "Keep a short preview of removed messages in the AutoMod activity list", kind: Kind::Toggle, default: Fallback::Bool(true) },
];
pub(crate) const WARN: Perm = Perm { key: "moderation.warn", level: Level::Moderator(Some(MODERATE_MEMBERS)) };
pub(crate) const TIMEOUT: Perm = Perm { key: "moderation.timeout", level: Level::Moderator(Some(MODERATE_MEMBERS)) };
pub(crate) const KICK: Perm = Perm { key: "moderation.kick", level: Level::Moderator(Some(KICK_MEMBERS)) };
pub(crate) const BAN: Perm = Perm { key: "moderation.ban", level: Level::Moderator(Some(BAN_MEMBERS)) };
pub(crate) const PURGE: Perm = Perm { key: "moderation.purge", level: Level::Moderator(Some(MANAGE_MESSAGES)) };
pub(crate) const HISTORY: Perm = Perm { key: "moderation.history", level: Level::Moderator(None) };
pub(crate) const AUTOMOD: Perm = Perm { key: "moderation.automod", level: Level::Admin };
const BYPASS: Perm = Perm { key: "moderation.bypass", level: Level::Moderator(None) };
const RULE_CHOICES: &[(&str, &str)] = &[("Scam and phishing links", "scams"), ("Spam (too many messages too fast)", "spam"), ("Word filter", "words"), ("Links and invites", "links"), ("Mass mentions", "mentions"), ("Repeated messages", "repeat"), ("Too many capital letters", "caps"), ("Too many emoji", "emoji")];
const EVERY_RULE: &[(&str, &str)] = &[("every rule", "all"), ("Scam and phishing links", "scams"), ("Spam (too many messages too fast)", "spam"), ("Word filter", "words"), ("Links and invites", "links"), ("Mass mentions", "mentions"), ("Repeated messages", "repeat"), ("Too many capital letters", "caps"), ("Too many emoji", "emoji")];
const ADD_REMOVE_LIST: &[(&str, &str)] = &[("add", "add"), ("remove", "remove"), ("list", "list")];

const USER: Opt = Opt { name: "user", about: "The user", takes: Takes::Member, required: true };
const fn who(about: &'static str) -> Opt { Opt { name: "user", about, takes: Takes::Member, required: true } }
const REASON: Opt = Opt { name: "reason", about: "Reason - leave empty to type it in a popup", takes: Takes::Text, required: false };
const fn cmd(name: &'static str, about: &'static str, options: &'static [Opt]) -> CommandSpec {
    CommandSpec { name, about, module: MODULE, options, subs: &[] }
}
pub const COMMANDS: &[CommandSpec] = &[
    cmd("warn", "Warn a member (opens a form)", &[]),
    cmd("timeout", "Time out a member", &[who("Who to time out"), Opt { name: "duration", about: "e.g. 10m, 2h, 1d (max 28d) - leave empty to use a popup", takes: Takes::Text, required: false }, REASON]),
    cmd("untimeout", "Remove a member's timeout", &[USER]),
    cmd("kick", "Kick a member", &[who("Who to kick"), REASON]),
    cmd("ban", "Ban a user", &[who("Who to ban"), REASON, Opt { name: "delete_days", about: "Also delete their messages from the last N days (0-7)", takes: Takes::Whole { min: 0, max: 7 }, required: false }, Opt { name: "duration", about: "Ban for how long, like 7d or 12h (empty = for good)", takes: Takes::Text, required: false }]),
    cmd("unban", "Unban a user by ID", &[Opt { name: "user_id", about: "The user's ID", takes: Takes::Text, required: true }, REASON]),
    cmd("purge", "Delete messages in this channel: a number, one member's, or everything", &[
        Opt { name: "amount", about: "How many (empty = all of them)", takes: Takes::Whole { min: 1, max: 100_000 }, required: false },
        Opt { name: "user", about: "Only this member's messages", takes: Takes::Member, required: false },
        Opt { name: "method", about: "How", takes: Takes::Choice(&[("Delete the messages (keeps the channel)", "delete"), ("Recreate the channel: everything gone at once", "recreate")]), required: false },
        Opt { name: "keep_pinned", about: "Keep pinned messages (default yes)", takes: Takes::YesNo, required: false },
    ]),
    cmd("modhistory", "See a user's moderation history", &[USER]),
    cmd("unwarn", "Take a warning back (after an appeal)", &[USER, Opt { name: "case", about: "Which warning, by case number (their newest if empty)", takes: Takes::Whole { min: 1, max: 1_000_000_000 }, required: false }, REASON]),
    CommandSpec { name: "strikes", about: "Strikes and the strike ladder", module: MODULE, options: &[], subs: &[
        Sub { name: "view", about: "A member's strikes and what the next one does", options: &[USER] },
        Sub { name: "ladder", about: "Show the server's strike ladder", options: &[] },
    ] },
    CommandSpec { name: "automod", about: "See and change AutoMod: rules, actions, exemptions", module: MODULE, options: &[], subs: &[
        Sub { name: "status", about: "Every rule: on or off, its action, and how often it fired this week", options: &[] },
        Sub { name: "rule", about: "Turn a rule on or off, or change its action or number", options: &[
            Opt { name: "rule", about: "Which rule", takes: Takes::Choice(RULE_CHOICES), required: true },
            Opt { name: "enabled", about: "On or off", takes: Takes::YesNo, required: false },
            Opt { name: "action", about: "What happens when it triggers", takes: Takes::Choice(&[("server default", "default"), ("delete only", "delete"), ("delete + warn", "delete-warn"), ("delete + timeout", "delete-timeout")]), required: false },
            Opt { name: "limit", about: "The rule's number (messages, mentions, percent, emoji...)", takes: Takes::Whole { min: 0, max: 1000 }, required: false },
        ] },
        Sub { name: "exempt", about: "Roles and channels AutoMod should ignore", options: &[
            Opt { name: "what", about: "Add, remove or list", takes: Takes::Choice(ADD_REMOVE_LIST), required: true },
            Opt { name: "rule", about: "One rule, or every rule (default)", takes: Takes::Choice(EVERY_RULE), required: false },
            Opt { name: "role", about: "A role to ignore", takes: Takes::Role, required: false },
            Opt { name: "channel", about: "A channel or category to ignore", takes: Takes::AnyChannel, required: false },
        ] },
        Sub { name: "recent", about: "The latest things AutoMod removed", options: &[Opt { name: "count", about: "How many (default 10)", takes: Takes::Whole { min: 1, max: 25 }, required: false }] },
        Sub { name: "word", about: "Banned words", options: &[Opt { name: "what", about: "Add, remove or list", takes: Takes::Choice(ADD_REMOVE_LIST), required: true }, Opt { name: "word", about: "The word or phrase", takes: Takes::Text, required: false }] },
        Sub { name: "domain", about: "Link domains that are always allowed", options: &[Opt { name: "what", about: "Add, remove or list", takes: Takes::Choice(ADD_REMOVE_LIST), required: true }, Opt { name: "domain", about: "For example youtube.com", takes: Takes::Text, required: false }] },
    ] },
];

/// Good Boy 3's warning severities: (id, label, what it means).
pub const SEVERITY: &[(&str, &str, &str)] = &[("low", "🟢 Low", "A friendly reminder"), ("medium", "🟡 Medium", "A clear rule break"), ("high", "🟠 High", "Serious, next step is a timeout"), ("critical", "🔴 Critical", "Final warning before a ban")];
/// Good Boy 3's titles for the moderation popups.
pub fn action_title(action: &str) -> &'static str {
    match action { "warn" => "Warn a member", "timeout" => "Time out a member", "kick" => "Kick a member", "ban" => "Ban a user", _ => "Unban a user" }
}
/// Good Boy 3's reason popup (`FIELD`): the timeout length, the reason, and for a ban how many days of messages go.
/// `extra`: the timeout length typed so far, or for a ban "length~days".
pub fn action_form(action: &str, user: &str, extra: &str) -> Action {
    let mut fields = Vec::new();
    if action == "timeout" { fields.push(crate::Field { id: "duration".into(), label: "How long? e.g. 10m, 2h, 1d (max 28d)".into(), required: true, max: 10, value: Some(extra.to_string()).filter(|v| v != "-"), ..Default::default() }); }
    fields.push(crate::Field { id: "reason".into(), label: "Reason (shown in the log and to the member)".into(), long: true, required: true, max: 500, ..Default::default() });
    if action == "ban" { fields.push(crate::Field { id: "days".into(), label: "Delete their messages from the last N days (0-7)".into(), max: 1, value: Some(extra.split_once('~').map(|(_, d)| d).unwrap_or("0").to_string()), ..Default::default() }); }
    Action::Form { id: format!("modq:{action}:{user}:{extra}"), title: action_title(action).into(), fields }
}
/// Good Boy 3's private "configure" message before the warning form: what will happen, and the one button
/// (only the person who ran /warn can press it).
pub fn warn_intro(owner: &str, target: Option<&str>, dm: bool) -> Action {
    let who = target.map(|t| format!("Warning <@{t}>. ")).unwrap_or_default();
    let told = if dm { " by DM" } else { " (DMs are off in settings)" };
    let card = Card::new(Area::Moderation).title("Warn a member").line(format!("{who}Nothing is recorded until you submit the form.\nThe member is told the reason{told}."))
        .line("-# Only you can see this. The button works for 15 minutes.")
        .button_with(format!("mwarn:{owner}:{}", target.unwrap_or("-")), "Configure warning", ButtonStyle::Danger, Some("⚠️".into()))
        .private();
    Action::Reply { card }
}
/// The warning form (Good Boy 3's "Warn a member"). With a target (right-click > Warn member) it doesn't ask who.
/// `recall`: what this moderator typed last time (within 30 minutes), so a second warning for the same thing is quicker (Good Boy 3's `recall`).
pub fn warn_form(target: Option<&str>, recall: Option<&Value>) -> Action {
    let mut fields = Vec::new();
    if target.is_none() { fields.push(crate::Field { id: "user".into(), label: "Member to warn".into(), kind: crate::FieldKind::User { most: 1 }, required: true, ..Default::default() }); }
    fields.push(crate::Field { id: "reason".into(), label: "Warning reason".into(), desc: Some("Shown in the log and to the member".into()), long: true, required: true, max: 500, ..Default::default() });
    fields.push(crate::Field { id: "severity".into(), label: "Severity".into(), kind: crate::FieldKind::Select(SEVERITY.iter().map(|(k, l, _)| (l.to_string(), k.to_string())).collect()), required: true, value: Some("medium".into()), hints: SEVERITY.iter().map(|(_, _, d)| d.to_string()).collect(), ..Default::default() });
    fields.push(crate::Field { id: "notes".into(), label: "Duration / severity notes".into(), desc: Some("Optional, staff only. e.g. \"counts for 30 days\"".into()), long: true, max: 300, ..Default::default() });
    if let Some(r) = recall {
        for f in fields.iter_mut() {
            if let Some(v) = r[f.id.as_str()].as_str().filter(|v| !v.is_empty()) { f.value = Some(v.to_string()); }
        }
    }
    Action::Form { id: format!("modwarn:{}", target.unwrap_or("-")), title: "Warn a member".into(), fields }
}
fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::Moderation).line(text).private() }]
}
fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}
fn warnings(d: &Data, user: &str) -> usize {
    d.get(&format!("hist:{user}")).and_then(|h| h.as_array().map(|a| a.iter().filter(|e| e["type"] == "warn").count())).unwrap_or(0)
}
/// One step of a server's own strike ladder: at this many strikes, do this (for this long).
#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub at: i64,
    /// "timeout", "kick" or "ban".
    pub action: &'static str,
    /// How long, for a timeout or a timed ban. A ban with none is for good.
    pub ms: Option<i64>,
}
/// Reads the ladder's lines. Gives the steps in order, and the lines that were not understood.
/// A line is a number, what happens, and how long: "2 timeout 1d", "4: timeout 1 week", "6 = ban 30 days", "10 ban".
pub fn parse_ladder(lines: &[String]) -> (Vec<Step>, Vec<String>) {
    let (mut steps, mut bad) = (Vec::new(), Vec::new());
    for line in lines {
        let clean: String = line.to_lowercase().replace(['=', ':', '-', '→', '>'], " ");
        let words: Vec<&str> = clean.split_whitespace().filter(|w| !["strike", "strikes", "warning", "warnings", "for", "a"].contains(w)).collect();
        let at = words.first().and_then(|w| w.parse::<i64>().ok()).filter(|n| (1..=100).contains(n));
        let action = words.iter().find_map(|w| match *w { "timeout" | "mute" | "timed" => Some("timeout"), "kick" => Some("kick"), "ban" | "banned" => Some("ban"), _ => None });
        // the length is whatever is left: "1d", "1 day", "30 days", "1w"
        let rest: String = words.iter().skip(1).filter(|w| !["timeout", "mute", "timed", "out", "kick", "ban", "banned"].contains(w)).copied().collect::<Vec<_>>().join("");
        let rest = rest.replace("weeks", "w").replace("week", "w").replace("days", "d").replace("day", "d").replace("hours", "h").replace("hour", "h").replace("minutes", "m").replace("minute", "m").replace("mins", "m").replace("min", "m");
        let ms = if rest.is_empty() { None } else { parse_duration(&rest) };
        match (at, action) {
            (Some(at), Some(action)) if (rest.is_empty() || ms.is_some()) && (action != "timeout" || ms.is_some_and(|m| m <= 28 * DAY)) && (action != "ban" || ms.is_none_or(|m| m <= 366 * DAY)) => {
                steps.retain(|s: &Step| s.at != at);
                steps.push(Step { at, action, ms: if action == "kick" { None } else { ms } });
            }
            _ => bad.push(line.clone()),
        }
    }
    steps.sort_by_key(|s| s.at);
    (steps, bad)
}
/// The step a strike count reaches: an exact match, or the last step again for every strike past the top.
pub fn ladder_step(steps: &[Step], strikes: i64) -> Option<&Step> {
    steps.iter().find(|s| s.at == strikes).or_else(|| steps.last().filter(|last| strikes > last.at))
}
fn step_words(s: &Step) -> String {
    match (s.action, s.ms) {
        ("timeout", Some(ms)) => format!("{} timeout", in_words(ms)),
        ("ban", Some(ms)) => format!("{} ban", in_words(ms)),
        ("ban", None) => "permanent ban".into(),
        _ => "kick".into(),
    }
}

/// What a number of warnings leads to: the same ladder as Good Boy 3 (ban beats kick beats timeout).
pub fn warn_step(warns: i64, timeout_every: i64, kick_at: i64, ban_at: i64) -> Option<&'static str> {
    if ban_at > 0 && warns >= ban_at { return Some("ban"); }
    if kick_at > 0 && warns >= kick_at { return Some("kick"); }
    if timeout_every > 0 && warns > 0 && warns % timeout_every == 0 { return Some("timeout"); }
    None
}

pub struct Mod<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub dir: &'a crate::bot::Directory,
    pub guild: &'a str,
    pub guild_name: &'a str,
}
impl Mod<'_> {
    fn data(&self) -> Data<'_> {
        Data { db: self.db, guild: self.guild, module: MODULE }
    }
    fn plus(&self) -> crate::modplus::ModPlus<'_> {
        crate::modplus::ModPlus { db: self.db, settings: self.settings, dir: self.dir, guild: self.guild }
    }
    /// Records a case in the member's history (newest first, 100 kept) and gives it back.
    fn add_case(&self, kind: &str, user: &Member, moderator: Option<&str>, reason: &str, notes: Option<String>, at: i64) -> Value {
        let d = self.data();
        let id = d.next("counter");
        let mut entry = json!({ "id": id, "type": kind, "targetId": user.id, "targetTag": user.name, "modId": moderator, "reason": reason, "at": at });
        if let Some(n) = notes { entry["notes"] = json!(n); }
        let key = format!("hist:{}", user.id);
        let mut list = d.get(&key).and_then(|v| v.as_array().cloned()).unwrap_or_default();
        list.insert(0, entry.clone());
        list.truncate(100);
        d.set(&key, &Value::Array(list));
        // the Activity page: who and what, never the reason that was typed
        let seen = self.db.seen();
        seen.saw(self.guild, &user.id, &user.name);
        let did = match kind { "warn" => "was warned", "unwarn" => "had a warning removed", "timeout" => "was timed out", "untimeout" => "had their timeout removed", "kick" => "was kicked", "ban" => "was banned", "unban" => "was unbanned", _ => "got a new case" };
        let by = match moderator { Some(m) => format!("by {}", seen.name_or(self.guild, m)), None => "automatically".into() };
        seen.note(self.guild, "mod", &format!("{} {did} {by} (case #{id})", if user.name.is_empty() { "A member" } else { user.name.as_str() }));
        entry
    }
    /// Saves changes to a case already in the history.
    fn set_case(&self, user: &str, case: &Value) {
        let d = self.data();
        let key = format!("hist:{user}");
        let mut list = d.get(&key).and_then(|v| v.as_array().cloned()).unwrap_or_default();
        if let Some(e) = list.iter_mut().find(|e| e["id"] == case["id"]) { *e = case.clone(); }
        d.set(&key, &Value::Array(list));
    }
    /// Takes a case back out of the history (Discord refused the action it recorded).
    pub fn remove_case(&self, user: &str, case: i64) {
        let d = self.data();
        let key = format!("hist:{user}");
        if let Some(mut list) = d.get(&key).and_then(|v| v.as_array().cloned()) {
            list.retain(|e| e["id"].as_i64() != Some(case));
            d.set(&key, &Value::Array(list));
        }
        d.delete(&format!("tempban:{user}"));
    }
    fn case_card(&self, kind: &str, case: &Value, user: &Member, moderator: Option<&str>) -> Card {
        let title = format!("{}{} · case #{}", kind[..1].to_uppercase(), &kind[1..], case["id"]);
        let mut card = Card::new(Area::Moderation).title(title).line(format!("**User** {} ({})\n**Moderator** {}", user.name, user.id, moderator.map(|m| format!("<@{m}>")).unwrap_or_else(|| "AutoMod".into())))
            .line(format!("**Reason**\n{}", short(case["reason"].as_str().unwrap_or(""), 1000)));
        if let Some(s) = case["severity"].as_str() { card = card.line(format!("**Severity** {}", SEVERITY.iter().find(|(k, _, _)| *k == s).map(|(_, l, _)| *l).unwrap_or(s))); }
        if let Some(n) = case["notes"].as_str() { card = card.line(format!("**Duration / notes** {}", short(n, 500))); }
        // Good Boy 3's colour for each kind of case
        card.accent = Some(match kind { "warn" => 0xfaa61a, "timeout" => 0xe67e22, "untimeout" | "unban" | "unwarn" => 0x2ecc71, "kick" => 0xe74c3c, "ban" => 0x992d22, "purge" => 0x95a5a6, "automod" => 0x3498db, _ => 0x5865f2 });
        card
    }
    /// The things that go with any case: a line in the mod log, and a DM to the member when the server wants that.
    fn extras(&self, kind: &str, case: &Value, user: &Member, moderator: Option<&str>, told: &str) -> Vec<Action> {
        let mut out = Vec::new();
        if self.settings.bool(self.guild, MODULE, "dmOnAction") && !told.is_empty() {
            out.push(Action::Dm { user: user.id.clone(), card: Card::new(Area::Moderation).line(format!("**{}**: {told}", short(self.guild_name, 60))), or_in: None });
        }
        if let Some(channel) = self.settings.text(self.guild, MODULE, "logChannel") {
            out.push(Action::Send { channel, card: self.case_card(kind, case, user, moderator), ping: Vec::new(), roles: Vec::new() });
        }
        out
    }

    /// The server's own strike ladder, when it has one.
    fn steps(&self) -> Vec<Step> {
        parse_ladder(&self.settings.list(self.guild, MODULE, "strikeLadder")).0
    }
    /// A member's strikes: their warnings, counted from the last reset (after a ladder ban), if there was one.
    pub fn strikes(&self, user: &str) -> i64 {
        let d = self.data();
        let base = d.get(&format!("strikes:{user}"));
        let since = base.as_ref().and_then(|b| b["at"].as_i64()).unwrap_or(i64::MIN);
        let from = base.as_ref().and_then(|b| b["from"].as_i64()).unwrap_or(0);
        // warnings can expire: after this many days they stop counting as strikes (they stay in the history)
        let days = self.settings.int(self.guild, MODULE, "warnExpireDays");
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let floor = if days > 0 { now - days * DAY } else { i64::MIN };
        let after = d.get(&format!("hist:{user}")).and_then(|h| h.as_array().map(|a| a.iter().filter(|e| e["type"] == "warn" && e["at"].as_i64().unwrap_or(0) > since && e["at"].as_i64().unwrap_or(0) > floor).count())).unwrap_or(0);
        from + after as i64
    }

    /// The ladder: enough strikes time out, kick or ban by themselves. Gives the actions and a line for the moderator.
    fn ladder(&self, user: &Member, strikes: i64, at: i64) -> (Vec<Action>, Option<String>) {
        let steps = self.steps();
        let (step, ms) = if steps.is_empty() {
            let Some(step) = warn_step(strikes, self.settings.int(self.guild, MODULE, "warnTimeoutThreshold"), self.settings.int(self.guild, MODULE, "warnKickAt"), self.settings.int(self.guild, MODULE, "warnBanAt")) else { return (Vec::new(), None) };
            (step, (step == "timeout").then(|| self.settings.int(self.guild, MODULE, "warnTimeoutMinutes") * MINUTE))
        } else {
            let Some(s) = ladder_step(&steps, strikes) else { return (Vec::new(), None) };
            (s.action, s.ms)
        };
        let why = format!("Automatic: {strikes} {}", if steps.is_empty() { "warnings" } else { "strikes" });
        let auto = self.add_case(step, user, None, &why, ms.map(in_words), at);
        let id = auto["id"].as_i64().unwrap_or(0);
        // Good Boy 3's wording when the server has no ladder of its own
        let reached = if steps.is_empty() { format!("Reached {strikes} warnings") } else { format!("Reached {strikes} strikes") };
        let (action, said, told) = match (step, ms) {
            ("ban", Some(ms)) => {
                self.data().set(&format!("tempban:{}", user.id), &json!({ "until": at + ms, "by": null, "reason": why }));
                (Action::Ban { user: user.id.clone(), reason: why.clone(), delete_days: 0, case: id }, format!("{reached} - banned for {}.", in_words(ms)), format!("you were banned for {}: {why}.", in_words(ms)))
            }
            ("ban", None) => (Action::Ban { user: user.id.clone(), reason: why.clone(), delete_days: 0, case: id }, format!("{reached} - banned."), format!("you were banned: {why}.")),
            ("kick", _) => (Action::Kick { user: user.id.clone(), reason: why.clone(), case: id }, format!("{reached} - kicked."), format!("you were kicked: {why}.")),
            (_, ms) => {
                let ms = ms.unwrap_or(HOUR).min(28 * DAY - MINUTE);
                let length = if steps.is_empty() { format!("{} minutes", ms / MINUTE) } else { in_words(ms) };
                (Action::Timeout { user: user.id.clone(), until_ms: Some(at + ms), reason: why.clone(), case: id }, format!("{reached} - timed out for {length}."), format!("you were timed out for {}: {why}.", in_words(ms)))
            }
        };
        // after a ban from the ladder, strikes can start again from a lower number (as some servers' rules say)
        let reset = self.settings.int(self.guild, MODULE, "strikeResetTo");
        if step == "ban" && !steps.is_empty() && reset > 0 {
            self.data().set(&format!("strikes:{}", user.id), &json!({ "from": reset, "at": at }));
        }
        // the DM goes before the kick or ban: afterwards the bot can no longer reach them
        let mut out = self.extras(step, &auto, user, None, &told);
        out.push(action);
        (out, Some(said))
    }

    pub fn command(&self, ev: &CommandEvent) -> Vec<Action> {
        let d = self.data();
        let may = |p: Perm| perms::allowed(self.db, self.guild, &ev.member, p);
        let no = |p: Perm| private(format!("You don't have permission for that (`{}`).", p.key));
        let arg = |k: &str| ev.args.get(k).map(String::as_str).filter(|s| !s.trim().is_empty());
        let me = ev.member.id.as_str();
        let reason = short(arg("reason").unwrap_or(""), 500);
        // Good Boy 3 asks for a missing reason (and a timeout's length) in its own popup; Discord can't open a popup
        // straight after another, so a private button opens it
        let ask = |action: &str, user: &str, extra: &str| vec![Action::Reply { card: Card::new(Area::Moderation).title(action_title(action)).line("Press the button to fill in the form.").line("-# Only you can see this. The button works for 15 minutes.").button(format!("modq:{me}:{action}:{user}:{extra}"), "Open form", ButtonStyle::Primary).private() }];
        let target = || -> Result<&Member, Vec<Action>> {
            let t = ev.target.as_ref().ok_or_else(|| private("Pick a member."))?;
            if let Some(why) = crate::modplus::hierarchy_problem(self.dir, self.guild, &ev.member, t) { return Err(private(why)); }
            Ok(t)
        };
        macro_rules! target { () => { match target() { Ok(t) => t, Err(no) => return no } }; }
        match ev.name.as_str() {
            "warn" => {
                if !may(WARN) { return no(WARN); }
                // Good Boy 3's warning form: opened first, nothing is recorded until it is sent
                if !ev.from_form || reason.trim().is_empty() {
                    if let Some(t) = ev.target.as_ref() {
                        if t.id == ev.member.id { return private("You cannot warn yourself."); }
                        if t.bot { return private("Bots cannot be warned."); }
                    }
                    return vec![warn_intro(&ev.member.id, ev.target.as_ref().map(|t| t.id.as_str()), self.settings.bool(self.guild, MODULE, "dmOnAction"))];
                }
                let user = target!();
                if user.id == ev.member.id { return private("You cannot warn yourself."); }
                if user.bot { return private("Bots cannot be warned."); }
                let severity = arg("severity").filter(|s| SEVERITY.iter().any(|(k, _, _)| k == s)).unwrap_or("medium");
                let mut case = self.add_case("warn", user, Some(me), &reason, arg("notes").map(str::to_string), ev.at_ms);
                case["severity"] = json!(severity);
                self.set_case(&user.id, &case);
                let strikes = self.strikes(&user.id);
                let ladder = self.steps();
                let total = if ladder.is_empty() { format!("{strikes} warning(s) total") } else {
                    let next = ladder.iter().find(|s| s.at > strikes).map(|s| format!(" · next: {} at {}", step_words(s), s.at)).unwrap_or_default();
                    format!("{strikes} strike(s){next}")
                };
                let mut out = vec![Action::Reply { card: self.case_card("warn", &case, user, Some(me)).line(total) }];
                out.extend(self.extras("warn", &case, user, Some(me), &format!("you were warned: {reason}")));
                let (more, said) = self.ladder(user, strikes, ev.at_ms);
                if let (Some(said), Some(Action::Reply { card })) = (said, out.first_mut()) { *card = card.clone().line(said); }
                out.extend(more);
                out
            }
            "timeout" => {
                if !may(TIMEOUT) { return no(TIMEOUT); }
                let user = target!();
                if arg("duration").is_none() || reason.is_empty() { return ask("timeout", &user.id, arg("duration").unwrap_or("-")); }
                let Some(ms) = arg("duration").and_then(parse_duration) else { return private("Use a duration like `10m`, `2h` or `1d`.") };
                if ms > 28 * DAY { return private("Discord limits timeouts to 28 days."); }
                let mut case = self.add_case("timeout", user, Some(me), &reason, None, ev.at_ms);
                case["durationMs"] = json!(ms);
                self.set_case(&user.id, &case);
                let mut out = vec![Action::Reply { card: self.case_card("timeout", &case, user, Some(me)).line(format!("**Duration** {}", in_words(ms))) }];
                out.extend(self.extras("timeout", &case, user, Some(me), &format!("you were timed out for {}: {reason}", in_words(ms))));
                out.push(Action::Timeout { user: user.id.clone(), until_ms: Some(ev.at_ms + ms), reason, case: case["id"].as_i64().unwrap_or(0) });
                out
            }
            "untimeout" => {
                if !may(TIMEOUT) { return no(TIMEOUT); }
                let user = target!();
                let case = self.add_case("untimeout", user, Some(me), "Timeout removed", None, ev.at_ms);
                let mut out = vec![Action::Reply { card: Card::new(Area::Moderation).line(format!("Timeout removed for **{}**.", short(&user.name, 40))) }];
                out.extend(self.extras("untimeout", &case, user, Some(me), ""));
                out.push(Action::Timeout { user: user.id.clone(), until_ms: None, reason: format!("Timeout removed by {}", ev.member.name), case: case["id"].as_i64().unwrap_or(0) });
                out
            }
            "kick" => {
                if !may(KICK) { return no(KICK); }
                let user = target!();
                if reason.is_empty() { return ask("kick", &user.id, "-"); }
                let plus = self.plus();
                if arg("approved").is_none() && plus.needs_approval("kick", &ev.member) { return plus.ask_approval(ev, "kick", user, &reason, "0", "-"); }
                let case = self.add_case("kick", user, Some(me), &reason, None, ev.at_ms);
                let mut out = vec![Action::Reply { card: self.case_card("kick", &case, user, Some(me)) }];
                out.extend(self.extras("kick", &case, user, Some(me), &format!("you were kicked: {reason}")));
                out.push(Action::Kick { user: user.id.clone(), reason, case: case["id"].as_i64().unwrap_or(0) });
                out
            }
            "ban" => {
                if !may(BAN) { return no(BAN); }
                let user = target!();
                let length = match arg("duration") {
                    None => None,
                    Some(raw) => match parse_duration(raw) {
                        Some(ms) if (60_000..=365 * DAY).contains(&ms) => Some(ms),
                        _ => return private("Ban length: use something like 1h, 7d or 30d (up to a year), or leave it empty to ban for good."),
                    },
                };
                let days = match arg("delete_days").map(|v| v.trim().parse::<u32>()) {
                    None => 0,
                    Some(Ok(n)) if n <= 7 => n,
                    Some(_) => return private("Days of messages to delete must be a whole number from 0 to 7."),
                };
                if reason.is_empty() { return ask("ban", &user.id, &format!("{}~{days}", arg("duration").unwrap_or("-"))); }
                let plus = self.plus();
                if arg("approved").is_none() && plus.needs_approval("ban", &ev.member) { return plus.ask_approval(ev, "ban", user, &reason, &days.to_string(), arg("duration").unwrap_or("-")); }
                let recorded = match length { Some(ms) => format!("{reason} (for {})", in_words(ms)), None => reason.clone() };
                let case = self.add_case("ban", user, Some(me), &recorded, None, ev.at_ms);
                plus.remember_ban(user, case["id"].as_i64().unwrap_or(0));
                match length {
                    Some(ms) => d.set(&format!("tempban:{}", user.id), &json!({ "until": ev.at_ms + ms, "by": me, "reason": reason })),
                    None => d.delete(&format!("tempban:{}", user.id)),
                }
                let told = match length { Some(ms) => format!("you were banned until <t:{}:f>: {reason}", (ev.at_ms + ms) / 1000), None => format!("you were banned: {reason}") };
                let mut out = vec![Action::Reply { card: self.case_card("ban", &case, user, Some(me)) }];
                out.extend(self.extras("ban", &case, user, Some(me), &told));
                out.push(Action::Ban { user: user.id.clone(), reason, delete_days: days, case: case["id"].as_i64().unwrap_or(0) });
                out
            }
            "unban" => {
                if !may(BAN) { return no(BAN); }
                let id = arg("user_id").unwrap_or("").trim().to_string();
                if !(17..=20).contains(&id.len()) || !id.bytes().all(|b| b.is_ascii_digit()) { return private("That is not a valid user ID."); }
                if reason.is_empty() { return ask("unban", &id, "-"); }
                let user = Member { id: id.clone(), name: id.clone(), ..Default::default() };
                let case = self.add_case("unban", &user, Some(me), &reason, None, ev.at_ms);
                d.delete(&format!("tempban:{id}"));
                let mut out = vec![Action::Reply { card: Card::new(Area::Moderation).line(format!("Unbanned `{id}`.")) }];
                out.extend(self.extras("unban", &case, &user, Some(me), ""));
                out.push(Action::Unban { user: id, reason, case: case["id"].as_i64().unwrap_or(0) });
                out
            }
            "purge" => {
                if !may(PURGE) { return no(PURGE); }
                let amount = arg("amount").and_then(|v| v.parse::<u64>().ok());
                let method = arg("method").unwrap_or("delete");
                let keep_pinned = arg("keep_pinned") != Some("false");
                let here = ev.place.channel.clone();
                if method == "recreate" {
                    if amount.is_some() || ev.target.is_some() { return private("Recreate removes everything, so leave amount and user empty (or pick \"Delete the messages\")."); }
                    d.set(&format!("purge:{}", ev.member.id), &json!({ "channelId": here, "method": "recreate", "at": ev.at_ms }));
                    let card = Card::new(Area::Moderation).line(format!("⚠️ **Recreate <#{here}>?** Every message is gone at once, including pins. Permissions, topic, slowmode and position stay the same. Webhooks in this channel are removed."))
                        .button(format!("mpurge:yes:{}", ev.member.id), "Yes, recreate it", ButtonStyle::Danger).button(format!("mpurge:no:{}", ev.member.id), "Cancel", ButtonStyle::Plain).private();
                    return vec![Action::Reply { card }];
                }
                let from = ev.target.as_ref().map(|t| t.id.clone());
                // up to 100 recent messages: straight away; anything bigger asks first and runs in the background
                if let Some(n) = amount.filter(|n| *n <= 100) {
                    return vec![Action::Reply { card: Card::new(Area::Moderation).line("🧹 Deleting…").private() }, Action::Purge { channel: here, count: n, from, keep_pinned, progress: false, by: ev.member.id.clone() }];
                }
                d.set(&format!("purge:{}", ev.member.id), &json!({ "channelId": here, "method": "delete", "amount": amount, "userId": from, "keepPinned": keep_pinned, "at": ev.at_ms }));
                let what = format!("{} message{} in <#{here}>{}", amount.map(|a| format!("up to **{}**", crate::card::group(a as i64))).unwrap_or_else(|| "**every**".into()), from.as_ref().map(|u| format!(" from <@{u}>")).unwrap_or_default(), if keep_pinned { " (pins are kept)" } else { "" });
                let card = Card::new(Area::Moderation).line(format!("⚠️ Delete {what}? Messages older than 14 days are deleted one by one, about one a second, so a big purge takes a while. It runs in the background and you can stop it."))
                    .button(format!("mpurge:yes:{}", ev.member.id), "Yes, delete them", ButtonStyle::Danger).button(format!("mpurge:no:{}", ev.member.id), "Cancel", ButtonStyle::Plain).private();
                vec![Action::Reply { card }]
            }
            "automod" => self.automod_command(ev),
            "unwarn" => {
                if !may(WARN) { return no(WARN); }
                let Some(user) = ev.target.as_ref() else { return private("Pick a member.") };
                let key = format!("hist:{}", user.id);
                let mut hist = d.get(&key).and_then(|v| v.as_array().cloned()).unwrap_or_default();
                let wanted = arg("case").and_then(|v| v.parse::<i64>().ok());
                let Some(pos) = hist.iter().position(|e| e["type"] == "warn" && wanted.is_none_or(|c| e["id"].as_i64() == Some(c))) else {
                    return private(if wanted.is_some() { "That member has no warning with that case number.".to_string() } else { format!("{} has no warnings.", user.name) });
                };
                let gone = hist.remove(pos);
                d.set(&key, &Value::Array(hist));
                let note = format!("Warning #{} taken back", gone["id"]);
                let case = self.add_case("unwarn", user, Some(me), &reason, Some(note.clone()), ev.at_ms);
                let mut out = vec![Action::Reply { card: self.case_card("unwarn", &case, user, Some(me)).line(format!("{note}. {} now has {} strike(s).", user.name, self.strikes(&user.id))) }];
                out.extend(self.extras("unwarn", &case, user, Some(me), &format!("a warning was taken back: {reason}")));
                out
            }
            "strikes" => {
                if !may(HISTORY) { return no(HISTORY); }
                let (steps, bad) = parse_ladder(&self.settings.list(self.guild, MODULE, "strikeLadder"));
                let reset = self.settings.int(self.guild, MODULE, "strikeResetTo");
                let ladder_text = if steps.is_empty() {
                    "This server has no strike ladder of its own, so the warning numbers in the Moderation settings are used.".to_string()
                } else {
                    let mut lines: Vec<String> = steps.iter().map(|s| format!("• **{} strike{}** - {}", s.at, if s.at == 1 { "" } else { "s" }, step_words(s))).collect();
                    if reset > 0 { lines.push(format!("After a ban, strikes start again from **{reset}**.")); }
                    lines.join("\n")
                };
                let bad_text = if bad.is_empty() { String::new() } else { format!("\n⚠️ Not understood (ignored): {}", bad.iter().map(|b| format!("`{}`", short(b, 60))).collect::<Vec<_>>().join(", ")) };
                if ev.sub.as_deref() == Some("ladder") {
                    return vec![Action::Reply { card: Card::new(Area::Moderation).title("Strike ladder").line(format!("{ladder_text}{bad_text}")).private() }];
                }
                let Some(user) = ev.target.as_ref() else { return private("Pick a member.") };
                let n = self.strikes(&user.id);
                let next = steps.iter().find(|s| s.at > n).map(|s| format!("Next: **{}** at {} strikes.", step_words(s), s.at)).unwrap_or_else(|| if steps.is_empty() { String::new() } else { format!("Every further strike: **{}**.", step_words(steps.last().unwrap())) });
                vec![Action::Reply { card: Card::new(Area::Moderation).title(format!("{} · {n} strike{}", user.name, if n == 1 { "" } else { "s" })).line(next).line(format!("-# {}", ladder_text.replace('\n', " · "))).private() }]
            }
            "modhistory" => {
                if !may(HISTORY) { return no(HISTORY); }
                let Some(user) = ev.target.as_ref() else { return private("Pick a member.") };
                let hist = d.get(&format!("hist:{}", user.id)).and_then(|v| v.as_array().cloned()).unwrap_or_default();
                if hist.is_empty() { return private(format!("{} has a clean record here.", user.name)); }
                let lines: Vec<String> = hist.iter().take(15).map(|e| format!("**#{}** {} · <t:{}:d> · {}\n> {}", e["id"], e["type"].as_str().unwrap_or("?"), e["at"].as_i64().unwrap_or(0) / 1000, e["modId"].as_str().map(|m| format!("<@{m}>")).unwrap_or_else(|| "automatic".into()), short(e["reason"].as_str().unwrap_or(""), 120))).collect();
                let notes = self.plus().note_count(&user.id);
                let more = if hist.len() > 15 { format!("\n…and {} older.", hist.len() - 15) } else { String::new() };
                vec![Action::Reply { card: Card::new(Area::Moderation).title(format!("History for {}", user.name)).line(format!("{} warning(s), {} strike(s) now, {} case(s) in all", warnings(&d, &user.id), self.strikes(&user.id), hist.len())).line(format!("{}{more}{}", lines.join("\n"), if notes > 0 { format!("\n-# 📝 {notes} private note(s): /note list") } else { String::new() })).private() }]
            }
            _ => private("That command is not here yet."),
        }
    }
}

/// What AutoMod remembers between messages, per server and member: recent messages for the repeat and spam rules.
type Window = Vec<(i64, String, String, String)>; // (when, message id, channel, normalized text)
static REPEATS: Mutex<Option<HashMap<String, Window>>> = Mutex::new(None);
static SPAM: Mutex<Option<HashMap<String, Window>>> = Mutex::new(None);
fn window(store: &Mutex<Option<HashMap<String, Window>>>, key: &str, keep_ms: i64, now: i64, add: (String, String, String)) -> Window {
    let mut all = store.lock().unwrap_or_else(|p| p.into_inner());
    let map = all.get_or_insert_with(HashMap::new);
    if map.len() > 50_000 { map.retain(|_, w| w.last().is_some_and(|e| now - e.0 < 600_000)); }
    let list = map.entry(key.to_string()).or_default();
    list.retain(|e| now - e.0 < keep_ms);
    list.push((now, add.0, add.1, add.2));
    list.clone()
}
fn forget(store: &Mutex<Option<HashMap<String, Window>>>, key: &str) {
    if let Some(map) = store.lock().unwrap_or_else(|p| p.into_inner()).as_mut() { map.remove(key); }
}

/// What a message broke: the rule, its name, what the member is told, and earlier messages to remove with it.
pub struct Caught {
    pub rule: &'static str,
    pub name: &'static str,
    pub tell: &'static str,
    pub earlier: Vec<(String, String)>,
}

impl Mod<'_> {
    fn on(&self, key: &str) -> bool {
        self.settings.bool(self.guild, MODULE, key)
    }
    fn num(&self, key: &str) -> i64 {
        self.settings.int(self.guild, MODULE, key)
    }
    fn rule_on(&self, rule: &am::Rule) -> bool {
        match rule.on { Some(on) => self.on(on), None => rule.limit.is_some_and(|l| self.num(l) > 0) }
    }
    fn action_for(&self, rule: &am::Rule) -> String {
        match self.settings.text(self.guild, MODULE, rule.action) {
            Some(own) if own != "default" => own,
            _ => self.settings.text(self.guild, MODULE, "automodAction").unwrap_or_else(|| "delete-warn".into()),
        }
    }
    fn exempt(&self) -> Value {
        self.data().get("automod:exempt").unwrap_or_else(|| json!({}))
    }

    /// The first rule a message breaks, in Good Boy 3's order, or None.
    pub fn detect(&self, ev: &MessageEvent) -> Option<Caught> {
        let text = ev.text.as_str();
        let ex = self.exempt();
        let live = |id: &str| { let r = am::rule_by_id(id).unwrap(); self.rule_on(r) && !am::is_exempt(&ex, id, &ev.author.roles, &ev.place.channel, ev.place.thread_of.as_deref(), ev.place.category.as_deref()) };
        let caught = |rule, name, tell| Some(Caught { rule, name, tell, earlier: Vec::new() });
        if !text.is_empty() && live("scams") && am::scam_reason(text).is_some() {
            return caught("scams", "scam link", "that link looks like a scam, so it was removed. If your account was hacked, change your password and turn on two-factor login.");
        }
        if !text.is_empty() && live("words") && am::banned_word(text, &self.settings.list(self.guild, MODULE, "bannedWords")).is_some() {
            return caught("words", "word filter", "that word is not allowed here.");
        }
        if !text.is_empty() && live("links") {
            match am::blocked_link(text, &self.settings.list(self.guild, MODULE, "allowedDomains")).as_deref() {
                Some("a server invite") => return caught("links", "invite filter", "invites aren't allowed here."),
                Some(_) => return caught("links", "link filter", "links aren't allowed here."),
                None => {}
            }
        }
        if live("mentions") && ev.mentions as i64 >= self.num("maxMentions") {
            return caught("mentions", "mass mention", "too many mentions in one message.");
        }
        if !text.is_empty() && live("caps") && am::caps_ratio(text, self.num("capsMinLetters").max(0) as usize) >= self.num("capsPercent") {
            return caught("caps", "too many capitals", "please do not shout - too many capital letters.");
        }
        if !text.is_empty() && live("emoji") && am::count_emoji(text) as i64 > self.num("emojiMax") {
            return caught("emoji", "too many emoji", "too many emoji in one message.");
        }
        let key = format!("{}:{}", self.guild, ev.author.id);
        if !text.is_empty() && live("repeat") {
            let norm = am::normalize(text);
            if norm.chars().count() >= 2 {
                let list = window(&REPEATS, &key, self.num("repeatWindowSeconds") * 1000, ev.at_ms, (ev.id.clone(), ev.place.channel.clone(), norm.clone()));
                let hits: Vec<(String, String)> = list.iter().filter(|e| e.3 == norm).map(|e| (e.2.clone(), e.1.clone())).collect();
                if hits.len() as i64 >= self.num("repeatMax") {
                    forget(&REPEATS, &key);
                    return Some(Caught { rule: "repeat", name: "repeated message", tell: "please do not repeat the same message.", earlier: hits });
                }
            }
        }
        if live("spam") {
            let list = window(&SPAM, &key, self.num("spamWindowSeconds") * 1000, ev.at_ms, (ev.id.clone(), ev.place.channel.clone(), String::new()));
            if list.len() as i64 >= self.num("spamMaxMessages") {
                forget(&SPAM, &key);
                return Some(Caught { rule: "spam", name: "spam", tell: "slow down - you are sending messages too fast.", earlier: list.iter().map(|e| (e.2.clone(), e.1.clone())).collect() });
            }
        }
        None
    }

    /// Checks a message and deals with it: removes it, warns or times out, tells the member, and logs it.
    pub fn on_message(&self, ev: &MessageEvent) -> Vec<Action> {
        if ev.author.bot || perms::allowed(self.db, self.guild, &ev.author, BYPASS) {
            return Vec::new();
        }
        let Some(v) = self.detect(ev) else { return Vec::new() };
        let rule = am::rule_by_id(v.rule).unwrap();
        let action = self.action_for(rule);
        let mut out = Vec::new();
        // earlier messages from the same burst, then the message itself
        let mut by_channel: Vec<(String, Vec<String>)> = Vec::new();
        for (ch, id) in v.earlier.iter().filter(|(_, id)| *id != ev.id) {
            match by_channel.iter_mut().find(|(c, _)| c == ch) { Some((_, ids)) => ids.push(id.clone()), None => by_channel.push((ch.clone(), vec![id.clone()])) }
        }
        for (channel, messages) in by_channel {
            out.push(Action::DeleteMany { channel, messages });
        }
        out.push(Action::Delete { channel: ev.place.channel.clone(), message: ev.id.clone() });
        let reason = format!("AutoMod: {}", v.name);
        let mut case = None;
        if action == "delete-warn" {
            let c = self.add_case("warn", &ev.author, None, &reason, None, ev.at_ms);
            case = c["id"].as_i64();
            let strikes = self.strikes(&ev.author.id);
            out.extend(self.ladder(&ev.author, strikes, ev.at_ms).0);
        }
        if action == "delete-timeout" {
            let mins = self.num("automodTimeoutMinutes");
            let c = self.add_case("timeout", &ev.author, None, &reason, Some(in_words(mins * MINUTE)), ev.at_ms);
            case = c["id"].as_i64();
            if let Some(channel) = self.settings.text(self.guild, MODULE, "logChannel") {
                out.push(Action::Send { channel, card: self.case_card("timeout", &c, &ev.author, None), ping: Vec::new(), roles: Vec::new() });
            }
            // Discord's limit is 28 days; a minute is kept spare
            out.push(Action::Timeout { user: ev.author.id.clone(), until_ms: Some(ev.at_ms + (mins * MINUTE).min(28 * DAY - MINUTE)), reason: reason.clone(), case: case.unwrap_or(0) });
        }
        // remembered for /automod recent and the weekly counts (newest first, 200 kept)
        let mut entry = json!({ "at": ev.at_ms, "userId": ev.author.id, "tag": short(&ev.author.name, 40), "channelId": ev.place.channel, "rule": v.rule, "name": v.name, "action": action, "caseId": case });
        if self.on("automodKeepSnippets") { entry["snippet"] = json!(am::snippet(&ev.text, 80)); }
        let mut recent = self.data().get("automod:recent").and_then(|r| r.as_array().cloned()).unwrap_or_default();
        recent.insert(0, entry);
        recent.truncate(200);
        self.data().set("automod:recent", &Value::Array(recent));
        out.push(Action::Flash { channel: ev.place.channel.clone(), card: Card::new(Area::Moderation).line(format!("<@{}>, {}", ev.author.id, v.tell)), ping: vec![ev.author.id.clone()], after_secs: 6 });
        if self.on("dmOnAction") {
            out.push(Action::Dm { user: ev.author.id.clone(), card: Card::new(Area::Moderation).line(format!("**{}**: your message was removed by AutoMod ({}).", short(self.guild_name, 60), v.name)), or_in: None });
        }
        if let Some(channel) = self.settings.text(self.guild, MODULE, "logChannel") {
            let case_note = case.map(|c| format!(" (case #{c})")).unwrap_or_default();
            out.push(Action::Send { channel, card: Card::new(Area::Moderation).title("AutoMod").line(format!("<@{}> in <#{}> - **{}**{case_note}", ev.author.id, ev.place.channel, v.name)), ping: Vec::new(), roles: Vec::new() });
        }
        out
    }

    fn rule_line(&self, rule: &am::Rule, counts: &HashMap<&str, usize>) -> String {
        let own = self.settings.text(self.guild, MODULE, rule.action).unwrap_or_else(|| "default".into());
        let server = self.settings.text(self.guild, MODULE, "automodAction").unwrap_or_else(|| "delete-warn".into());
        let action = if own == "default" { format!("Server default ({})", am::action_words(&server)) } else { let w = am::action_words(&own); format!("{}{}", w[..1].to_uppercase(), &w[1..]) };
        let ex = self.exempt();
        let n = ex[rule.id]["roles"].as_array().map_or(0, Vec::len) + ex[rule.id]["channels"].as_array().map_or(0, Vec::len);
        let exemptions = if n > 0 { format!(" · {n} role{}/channel{} exemption(s)", if n == 1 { "" } else { "s" }, if n == 1 { "" } else { "s" }) } else { String::new() };
        let limit = rule.limit.map(|l| format!(" · limit {}", self.num(l))).unwrap_or_default();
        let caught = counts.get(rule.id).copied().unwrap_or(0);
        format!("{} **{}**{limit}\n   {action}{exemptions} · {} this week", if self.rule_on(rule) { "🟢" } else { "⚫" }, rule.label, if caught > 0 { format!("{caught} caught") } else { "None".into() })
    }
    fn exemption_lines(&self) -> Vec<String> {
        let ex = self.exempt();
        let mut lines = Vec::new();
        for key in std::iter::once("all").chain(RULES.iter().map(|r| r.id)) {
            let s = &ex[key];
            let bits: Vec<String> = s["roles"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|r| format!("<@&{r}>")).chain(s["channels"].as_array().into_iter().flatten().filter_map(Value::as_str).map(|c| format!("<#{c}>"))).collect();
            if !bits.is_empty() { lines.push(format!("**{}:** {}", if key == "all" { "Every rule" } else { am::rule_by_id(key).unwrap().label }, bits.join(" "))); }
        }
        lines
    }

    /// The purge confirm, cancel and stop buttons (Good Boy 3's purgeClick).
    pub fn purge_press(&self, member: &Member, rest: &str, now: i64) -> Vec<Action> {
        let up = |t: &str| vec![Action::Update { card: Card::new(Area::Moderation).line(t).private() }];
        let (kind, owner) = rest.split_once(':').unwrap_or((rest, ""));
        if owner != member.id { return private("That belongs to someone else."); }
        if !crate::perms::allowed(self.db, self.guild, member, PURGE) { return private("You don't have permission for that (`moderation.purge`)."); }
        let d = self.data();
        let key = format!("purge:{owner}");
        let p = d.get(&key).unwrap_or(Value::Null);
        if kind == "stop" {
            let mut out = up("⏹️ Stopping…");
            if let Some(c) = p["channelId"].as_str() { out.push(Action::PurgeStop { channel: c.into() }); }
            return out;
        }
        d.delete(&key);
        if kind == "no" { return up("Cancelled. Nothing was deleted."); }
        if p.is_null() || now - p["at"].as_i64().unwrap_or(0) > 10 * 60_000 { return private("That confirmation expired. Run `/purge` again."); }
        let channel = p["channelId"].as_str().unwrap_or("").to_string();
        if p["method"] == "recreate" {
            let mut out = up("⏳ Recreating…");
            out.push(Action::RecreateChannel { channel, by: member.id.clone() });
            return out;
        }
        d.set(&key, &json!({ "channelId": channel, "at": now }));
        let card = Card::new(Area::Moderation).line("🧹 Purging… 0 deleted so far.").button(format!("mpurge:stop:{owner}"), "Stop", ButtonStyle::Plain).private();
        vec![Action::Update { card }, Action::Purge { channel, count: p["amount"].as_u64().unwrap_or(u64::MAX), from: p["userId"].as_str().map(str::to_string), keep_pinned: p["keepPinned"] != false, progress: true, by: member.id.clone() }]
    }
    /// A purge finished: (what to tell whoever ran it, the mod log card).
    pub fn purged(&self, channel: &str, by: &str, from: Option<&str>, deleted: u64, stopped: bool, progress: bool) -> (String, Vec<Action>) {
        if progress { self.data().delete(&format!("purge:{by}")); }
        let mut out = Vec::new();
        if let Some(log) = self.settings.text(self.guild, MODULE, "logChannel") {
            out.push(Action::Send { channel: log, card: Card::new(Area::Moderation).title("Purge").line(format!("<@{by}> deleted **{deleted}** message(s) in <#{channel}>{}{}.", from.map(|u| format!(" from <@{u}>")).unwrap_or_default(), if stopped { " (stopped early)" } else { "" })), ping: Vec::new(), roles: Vec::new() });
        }
        let text = if progress { format!("{}: deleted {} message(s) in <#{channel}>.", if stopped { "⏹️ Stopped" } else { "✅ Done" }, crate::card::group(deleted as i64)) } else { format!("🧹 Deleted {deleted} message(s).") };
        (text, out)
    }
    /// A channel was recreated: settings follow it, the log is told and the new channel says so.
    pub fn recreated(&self, old: &str, new: &str, name: &str, by: &str) -> Vec<Action> {
        let _ = self.db.get().replace_channel_id(self.guild, old, new);
        let mut out = vec![Action::Send { channel: new.into(), card: Card::new(Area::Moderation).line("🧹 This channel was cleared by a moderator."), ping: Vec::new(), roles: Vec::new() }];
        if let Some(log) = self.settings.text(self.guild, MODULE, "logChannel") {
            out.push(Action::Send { channel: log, card: Card::new(Area::Moderation).title("Purge all (channel recreated)").line(format!("<@{by}> recreated **#{name}**: every message removed.")), ping: Vec::new(), roles: Vec::new() });
        }
        out
    }
    pub fn automod_command(&self, ev: &CommandEvent) -> Vec<Action> {
        let may = |p: Perm| perms::allowed(self.db, self.guild, &ev.member, p);
        if !may(HISTORY) { return private("You don't have permission for that (`moderation.history`)."); }
        let arg = |k: &str| ev.args.get(k).map(String::as_str).filter(|s| !s.trim().is_empty());
        let need_admin = || private("You don't have permission for that (`moderation.automod`).");
        match ev.sub.as_deref().unwrap_or("status") {
            "status" => {
                let week = ev.at_ms - 7 * DAY;
                let mut counts: HashMap<&str, usize> = HashMap::new();
                for e in self.data().get("automod:recent").and_then(|r| r.as_array().cloned()).unwrap_or_default() {
                    if e["at"].as_i64().unwrap_or(0) >= week {
                        if let Some(r) = RULES.iter().find(|r| e["rule"] == r.id) { *counts.entry(r.id).or_default() += 1; }
                    }
                }
                let mut card = Card::new(Area::Moderation).title("AutoMod").line(RULES.iter().map(|r| self.rule_line(r, &counts)).collect::<Vec<_>>().join("\n"));
                let ex = self.exemption_lines();
                if !ex.is_empty() { card = card.line(format!("**Ignored**\n{}", short(&ex.join("\n"), 1000))); }
                vec![Action::Reply { card: card.line("-# Change a rule with /automod rule. Staff with the bypass permission are never checked.").private() }]
            }
            "recent" => {
                let n = arg("count").and_then(|v| v.parse::<usize>().ok()).unwrap_or(10).clamp(1, 25);
                let rows = self.data().get("automod:recent").and_then(|r| r.as_array().cloned()).unwrap_or_default();
                if rows.is_empty() { return private("AutoMod has not removed anything yet."); }
                let lines: Vec<String> = rows.iter().take(n).map(|e| format!("<t:{}:f> <@{}> in <#{}> · **{}** · {}{}{}", e["at"].as_i64().unwrap_or(0) / 1000, e["userId"].as_str().unwrap_or(""), e["channelId"].as_str().unwrap_or(""), e["name"].as_str().unwrap_or(""), am::action_words(e["action"].as_str().unwrap_or("")), e["caseId"].as_i64().map(|c| format!(" · case #{c}")).unwrap_or_default(), e["snippet"].as_str().map(|s| format!("\n   > {s}")).unwrap_or_default())).collect();
                private(short(&lines.join("\n"), 3500))
            }
            sub @ ("word" | "domain") => {
                let key = if sub == "word" { "bannedWords" } else { "allowedDomains" };
                let what = arg("what").unwrap_or("list");
                let list = self.settings.list(self.guild, MODULE, key);
                if what == "list" {
                    return private(if list.is_empty() { "The list is empty.".to_string() } else { format!("**{}** ({}): {}", if sub == "word" { "Banned words" } else { "Allowed domains" }, list.len(), short(&list.join(", "), 1700)) });
                }
                if !may(AUTOMOD) { return need_admin(); }
                let mut v = arg(sub).unwrap_or("").trim().to_string();
                if sub == "domain" {
                    let lower = v.to_lowercase();
                    let lower = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")).unwrap_or(&lower);
                    let lower = lower.strip_prefix("www.").unwrap_or(lower);
                    v = lower.split(['/', '?', '#']).next().unwrap_or("").to_string();
                }
                if v.is_empty() { return private(format!("Say which {sub}.")); }
                let mut next = list.clone();
                if what == "add" { if !next.contains(&v) { next.push(v.clone()); } } else { next.retain(|x| x != &v); }
                if let Err(e) = self.settings.set(self.guild, MODULE, key, &json!(next)) { return private(e.to_string()); }
                private(format!("{} **{}**.", if what == "add" { "Added" } else { "Removed" }, short(&v, 80)))
            }
            "rule" => {
                if !may(AUTOMOD) { return need_admin(); }
                let Some(rule) = arg("rule").and_then(am::rule_by_id) else { return private("Unknown rule. Choose one of: scams, spam, words, links, mentions, repeat, caps, emoji.") };
                let set = |key: &str, v: Value| self.settings.set(self.guild, MODULE, key, &v).map(|_| ()).map_err(|e| e.to_string());
                let done = (|| -> Result<(), String> {
                    if let Some(a) = arg("action") {
                        if !ACTIONS.contains(&a) { return Err(format!("The action must be one of: {}.", ACTIONS.join(", "))); }
                        set(rule.action, json!(a))?;
                    }
                    if let Some(n) = arg("limit").and_then(|v| v.parse::<i64>().ok()) {
                        let Some(l) = rule.limit else { return Err(format!("The {} rule has no number to set.", rule.label.to_lowercase())) };
                        set(l, json!(n))?;
                    }
                    if let Some(on) = arg("enabled").map(|v| v == "true") {
                        match (rule.on, rule.limit) {
                            (Some(k), _) => set(k, json!(on))?,
                            (None, Some(l)) if !on => set(l, json!(0))?,
                            (None, Some(l)) if self.num(l) <= 0 => set(l, json!(6))?,
                            _ => {}
                        }
                    }
                    Ok(())
                })();
                if let Err(why) = done { return private(why); }
                let own = self.settings.text(self.guild, MODULE, rule.action).unwrap_or_else(|| "default".into());
                let server = self.settings.text(self.guild, MODULE, "automodAction").unwrap_or_else(|| "delete-warn".into());
                let action = if own == "default" { format!("Server default ({})", am::action_words(&server)) } else { am::action_words(&own).to_string() };
                private(format!("**{}** is now {} · {action}{}.", rule.label, if self.rule_on(rule) { "on" } else { "off" }, rule.limit.map(|l| format!(" · limit {}", self.num(l))).filter(|_| rule.limit.is_some_and(|l| self.num(l) > 0)).unwrap_or_default()))
            }
            _ => {
                // exempt
                let what = arg("what").unwrap_or("list");
                if what == "list" {
                    let ex = self.exemption_lines();
                    return private(if ex.is_empty() { "Nothing is exempt. (Members with the bypass permission are always ignored.)".to_string() } else { ex.join("\n") });
                }
                if !may(AUTOMOD) { return need_admin(); }
                let (role, channel) = (arg("role"), arg("channel"));
                if role.is_none() && channel.is_none() { return private("Pick a role or a channel."); }
                let rule = arg("rule").unwrap_or("all");
                let (mut ex, mut changed) = (self.exempt(), false);
                for (kind, thing) in [("roles", role), ("channels", channel)] {
                    if let Some(id) = thing {
                        let (next, c) = am::edit_exempt(&ex, rule, kind, id, what == "add");
                        ex = next;
                        changed |= c;
                    }
                }
                self.data().set("automod:exempt", &ex);
                let label = if rule == "all" { "every rule".to_string() } else { am::rule_by_id(rule).map(|r| r.label.to_string()).unwrap_or_default() };
                let things = [role.map(|r| format!("<@&{r}>")), channel.map(|c| format!("<#{c}>"))].into_iter().flatten().collect::<Vec<_>>().join(" and ");
                private(if changed { format!("{} {things} for **{label}**.", if what == "add" { "Now ignoring" } else { "No longer ignoring" }) } else { "Nothing changed - it was already that way.".to_string() })
            }
        }
    }
}

/// Timed bans that have run out, in every server: each is lifted once.
pub fn due(db: &Db, now: i64) -> Vec<(String, Action)> {
    let rows = db.get().data_everywhere(MODULE, "tempban:").unwrap_or_default();
    let mut out = Vec::new();
    for (guild, key, v) in rows {
        if v["until"].as_i64().unwrap_or(i64::MAX) > now { continue; }
        let _ = db.get().data_delete(&guild, MODULE, &key);
        out.push((guild, Action::Unban { user: key["tempban:".len()..].to_string(), reason: "The timed ban ended".into(), case: 0 }));
    }
    out
}
