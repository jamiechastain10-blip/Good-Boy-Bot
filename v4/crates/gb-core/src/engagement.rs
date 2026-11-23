//! Good Boy 3's engagement module: announcements (also scheduled and repeating), polls and suggestions on one voting
//! engine (vote buttons, one vote each, bars, closing), and a fully configurable starboard. The same data (`sched:`,
//! `poll:`, `sugg:`, `star:`, counters), rules and wording as Good Boy 3.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::store::Data;
use crate::{notify, Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Def, Field, FieldKind, FormEvent, Kind, Select, Settings};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

pub const MODULE: &str = "engagement";
pub const ANNOUNCE: Perm = Perm { key: "engagement.announce", level: Level::Admin };
pub const POLL: Perm = Perm { key: "engagement.poll", level: Level::Moderator(None) };
pub const SUGGESTIONS: Perm = Perm { key: "engagement.suggestions", level: Level::Moderator(None) };
pub const MANAGE: Perm = Perm { key: "engagement.manage", level: Level::Admin };
pub static SETTINGS: &[Def] = &[
    Def { key: "starEnabled", label: "Starboard on", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "starboardChannel", label: "Starboard channel", kind: Kind::Channel, default: Fallback::None },
    Def { key: "starThreshold", label: "Stars needed", kind: Kind::Number { min: 1, max: 50 }, default: Fallback::Int(3) },
    Def { key: "starEmoji", label: "Star emoji", kind: Kind::Text { max_len: 60 }, default: Fallback::Str("⭐") },
    Def { key: "starSelf", label: "Count the author's own star", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "starIgnoreBots", label: "Ignore messages from bots", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "starRemoveBelow", label: "Remove from the board if stars drop below the threshold", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "starAllowNsfw", label: "Allow messages from NSFW channels", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "starIgnoreChannels", label: "Channels (or categories) the starboard ignores - IDs", kind: Kind::List, default: Fallback::None },
    Def { key: "suggestionChannel", label: "Suggestions channel", kind: Kind::Channel, default: Fallback::None },
    Def { key: "suggestionCooldownSeconds", label: "Seconds between a member's suggestions", kind: Kind::Number { min: 0, max: 86400 }, default: Fallback::Int(60) },
    Def { key: "suggestionThreads", label: "Open a discussion thread for each suggestion", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "suggestionAllowAnonymous", label: "Allow anonymous suggestions", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "timezoneOffset", label: "Timezone offset from UTC for scheduled dates (hours)", kind: Kind::Number { min: -12, max: 14 }, default: Fallback::Int(0) },
];
const HOUR: i64 = 3_600_000;
const DAY: i64 = 86_400_000;
const MAX_SCHEDULES: usize = 25;
/// (id, label, how often in milliseconds)
pub const REPEATS: &[(&str, &str, i64)] = &[("h1", "Every hour", HOUR), ("h2", "Every 2 hours", 2 * HOUR), ("h3", "Every 3 hours", 3 * HOUR), ("h6", "Every 6 hours", 6 * HOUR), ("h12", "Every 12 hours", 12 * HOUR), ("daily", "Every day", DAY), ("weekly", "Every week", 7 * DAY)];
/// (id, label, colour, people can still vote)
pub const STATUS: &[(&str, &str, u32, bool)] = &[("open", "Open", 0xfee75c, true), ("considering", "Under consideration", 0x3498db, true), ("approved", "Approved", 0x57f287, false), ("implemented", "Implemented", 0x9b59b6, false), ("denied", "Denied", 0xed4245, false)];
const STATUS_CHOICES: &[(&str, &str)] = &[("Open", "open"), ("Under consideration", "considering"), ("Approved", "approved"), ("Implemented", "implemented"), ("Denied", "denied")];
const ID: Opt = Opt { name: "id", about: "Suggestion number", takes: Takes::Whole { min: 1, max: 1_000_000 }, required: true };
const CH: Opt = Opt { name: "channel", about: "Where to post", takes: Takes::Channel, required: true };
const ANY: Opt = Opt { name: "channel", about: "Which channel or category", takes: Takes::AnyChannel, required: true };
pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec { name: "announce", about: "Announcements (everything is entered in a form)", module: MODULE, options: &[], subs: &[
        Sub { name: "send", about: "Post an announcement now", options: &[] },
        Sub { name: "schedule", about: "Post an announcement later, once or repeating", options: &[] },
        Sub { name: "list", about: "Show and cancel scheduled announcements", options: &[] },
    ] },
    CommandSpec { name: "poll", about: "Polls", module: MODULE, options: &[], subs: &[
        Sub { name: "create", about: "Start a poll in this channel", options: &[
            Opt { name: "question", about: "The question - leave empty to use a popup", takes: Takes::Text, required: false },
            Opt { name: "option1", about: "First choice", takes: Takes::Text, required: false },
            Opt { name: "option2", about: "Second choice", takes: Takes::Text, required: false },
            Opt { name: "option3", about: "Third choice", takes: Takes::Text, required: false },
            Opt { name: "option4", about: "Fourth choice", takes: Takes::Text, required: false },
            Opt { name: "option5", about: "Fifth choice", takes: Takes::Text, required: false },
            Opt { name: "duration", about: "Auto-close after, e.g. 30m, 2h, 3d", takes: Takes::Text, required: false },
            Opt { name: "multiple", about: "Let people pick more than one option", takes: Takes::YesNo, required: false },
        ] },
        Sub { name: "end", about: "End a poll early", options: &[Opt { name: "message_id", about: "Poll message ID", takes: Takes::Text, required: true }] },
    ] },
    CommandSpec { name: "suggest", about: "Suggest something for the server", module: MODULE, options: &[
        Opt { name: "idea", about: "Your suggestion - leave empty to write it in a popup", takes: Takes::Text, required: false },
        Opt { name: "anonymous", about: "Hide your name from the post", takes: Takes::YesNo, required: false },
    ], subs: &[] },
    CommandSpec { name: "suggestion", about: "Manage and browse suggestions", module: MODULE, options: &[], subs: &[
        Sub { name: "setup", about: "(Admins) Choose the suggestions channel", options: &[CH] },
        Sub { name: "status", about: "(Staff) Change a suggestion's status", options: &[ID, Opt { name: "status", about: "New status", takes: Takes::Choice(STATUS_CHOICES), required: true }, Opt { name: "note", about: "Note shown to everyone", takes: Takes::Text, required: false }] },
        Sub { name: "info", about: "Details about a suggestion", options: &[ID] },
        Sub { name: "top", about: "Most popular suggestions", options: &[Opt { name: "status", about: "Only this status", takes: Takes::Choice(STATUS_CHOICES), required: false }] },
        Sub { name: "mine", about: "Your suggestions", options: &[] },
        Sub { name: "edit", about: "Edit a suggestion while it is open", options: &[ID, Opt { name: "text", about: "New text - leave empty to edit in a popup", takes: Takes::Text, required: false }] },
        Sub { name: "delete", about: "(Staff) Delete a suggestion", options: &[ID] },
    ] },
    CommandSpec { name: "starboard", about: "Starboard settings", module: MODULE, options: &[], subs: &[
        Sub { name: "setup", about: "Turn the starboard on in one step", options: &[CH, Opt { name: "emoji", about: "Emoji to count (default ⭐)", takes: Takes::Text, required: false }, Opt { name: "threshold", about: "Stars needed", takes: Takes::Whole { min: 1, max: 50 }, required: false }] },
        Sub { name: "status", about: "Show settings and check they work", options: &[] },
        Sub { name: "enable", about: "Turn the starboard on", options: &[] },
        Sub { name: "disable", about: "Turn the starboard off", options: &[] },
        Sub { name: "channel", about: "Change the starboard channel", options: &[CH] },
        Sub { name: "emoji", about: "Change the emoji", options: &[Opt { name: "emoji", about: "The emoji", takes: Takes::Text, required: true }] },
        Sub { name: "threshold", about: "Change how many stars are needed", options: &[Opt { name: "count", about: "Stars", takes: Takes::Whole { min: 1, max: 50 }, required: true }] },
        Sub { name: "options", about: "Posting behaviour", options: &[
            Opt { name: "self_star", about: "Count the author's own star", takes: Takes::YesNo, required: false },
            Opt { name: "ignore_bots", about: "Ignore messages from bots", takes: Takes::YesNo, required: false },
            Opt { name: "remove_below", about: "Remove from the board if stars drop below the threshold", takes: Takes::YesNo, required: false },
            Opt { name: "allow_nsfw", about: "Allow NSFW channels", takes: Takes::YesNo, required: false },
        ] },
        Sub { name: "ignore add", about: "Ignore a channel or category", options: &[ANY] },
        Sub { name: "ignore remove", about: "Stop ignoring a channel", options: &[ANY] },
        Sub { name: "ignore list", about: "Show ignored channels", options: &[] },
        Sub { name: "top", about: "Most starred messages", options: &[] },
    ] },
];

fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}
fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
fn signed(n: i64) -> String {
    if n >= 0 { format!("+{n}") } else { n.to_string() }
}
fn tag(ms: i64, style: &str) -> String {
    format!("<t:{}:{style}>", ms / 1000)
}
fn coloured(c: u32, card: Card) -> Card {
    let mut card = card;
    card.accent = Some(c);
    card
}
/// "#5865F2" or "5865f2" as "#5865F2", or None.
pub fn normalize_hex(s: &str) -> Option<String> {
    let t = s.trim().trim_start_matches('#');
    let t = if t.len() == 3 { t.chars().flat_map(|c| [c, c]).collect::<String>() } else { t.to_string() };
    (t.len() == 6 && t.chars().all(|c| c.is_ascii_hexdigit())).then(|| format!("#{}", t.to_uppercase()))
}
fn hex_int(s: &str) -> u32 {
    u32::from_str_radix(s.trim_start_matches('#'), 16).unwrap_or(0x5865f2)
}
/// A single emoji: a normal one, or a server's own like `<:name:123…>`.
pub fn is_emoji(s: &str) -> bool {
    let t = s.trim();
    if let Some(inner) = t.strip_prefix("<a:").or_else(|| t.strip_prefix("<:")).and_then(|x| x.strip_suffix('>')) {
        return inner.split_once(':').is_some_and(|(n, id)| (2..=32).contains(&n.len()) && (17..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit()));
    }
    !t.is_empty() && t.chars().count() <= 8 && !t.chars().any(|c| c.is_ascii_alphanumeric() || c.is_whitespace())
}
/// The id inside a server emoji, or the emoji itself (what a reaction event calls it).
fn emoji_key(e: &str) -> String {
    let t = e.trim();
    t.trim_start_matches("<a:").trim_start_matches("<:").trim_end_matches('>').rsplit(':').next().filter(|_| t.starts_with('<')).unwrap_or(t).to_string()
}

/// A message a member starred, as the Discord layer read it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StarInfo {
    pub channel: String,
    pub parent: Option<String>,
    pub message: String,
    pub author: String,
    pub author_name: String,
    pub avatar: Option<String>,
    pub author_bot: bool,
    pub nsfw: bool,
    pub content: String,
    pub image: Option<String>,
    pub url: String,
    pub at_ms: i64,
    /// Stars from people (bots always left out; the author's own only when allowed).
    pub count: i64,
}
fn star_locks() -> std::sync::MutexGuard<'static, HashSet<String>> {
    static L: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    L.get_or_init(Mutex::default).lock().unwrap_or_else(|p| p.into_inner())
}

pub struct Engagement<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub guild: &'a str,
}
impl Engagement<'_> {
    fn data(&self) -> Data<'_> {
        Data { db: self.db, guild: self.guild, module: MODULE }
    }
    fn text(&self, k: &str) -> Option<String> {
        self.settings.text(self.guild, MODULE, k).filter(|v| !v.is_empty())
    }
    fn next(&self, key: &str) -> i64 {
        let n = self.data().get(key).and_then(|v| v.as_i64()).unwrap_or(0) + 1;
        self.data().set(key, &json!(n));
        n
    }
    fn can(&self, who: &crate::Member, perm: Perm) -> bool {
        perms::allowed(self.db, self.guild, who, perm)
    }
    fn no(perm: Perm) -> Vec<Action> {
        private(format!("You don't have permission for that (`{}`).", perm.key))
    }

    // ------------------------------------------------------------------ announcements
    /// What an announcement is posted as: a normal message (pings are real text), or a card when it has a title or colour.
    pub fn announce_action(channel: &str, text: &str, title: Option<&str>, color: Option<&str>, ping: &str, roles: &[String]) -> Action {
        let text = text.replace("\\n", "\n");
        let pings: Vec<String> = match ping { "everyone" | "here" => vec![format!("@{ping}")], "role" => roles.iter().map(|r| format!("<@&{r}>")).collect(), _ => Vec::new() };
        let everyone = matches!(ping, "everyone" | "here");
        if title.is_some() || color.is_some() {
            let mut card = Card::new(Area::General);
            if !pings.is_empty() { card = card.line(pings.join(" ")); }
            if let Some(t) = title { card = card.title(short(t, 250)); }
            card = card.line(short(&text, 3800));
            card.accent = Some(color.map(hex_int).unwrap_or(0x5865f2));
            return Action::Announce { channel: channel.into(), text: String::new(), card: Some(card), everyone, roles: if ping == "role" { roles.to_vec() } else { Vec::new() } };
        }
        let content = short(&[pings.join(" "), text].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n"), 2000);
        Action::Announce { channel: channel.into(), text: content, card: None, everyone, roles: if ping == "role" { roles.to_vec() } else { Vec::new() } }
    }
    fn notify_from_roles(&self, roles: &[String]) -> (&'static str, Vec<String>) {
        if roles.iter().any(|r| r == self.guild) { ("everyone", Vec::new()) }
        else if !roles.is_empty() { ("role", roles.to_vec()) } else { ("none", Vec::new()) }
    }
    fn announce_intro(&self, ev: &CommandEvent, sub: &str) -> Vec<Action> {
        let (title, body, label, emoji) = if sub == "send" {
            ("New announcement", "Write the announcement in the form: title, text, color, where it goes and who gets pinged.\nNothing is posted until you submit.", "Configure Announcement", "📣")
        } else {
            ("Schedule an announcement", "Pick when it goes out, whether it repeats, the text and who gets pinged.", "Configure Announcement", "🗓️")
        };
        let card = coloured(0x5865f2, Card::new(Area::General).title(title).line(body).line("-# Only you can see this. The button works for 15 minutes.").button_with(format!("eng:ann:{}:{sub}", ev.member.id), label, ButtonStyle::Primary, Some(emoji.into())).private());
        vec![Action::Reply { card }]
    }
    fn announce_form(&self, sub: &str, channel: &str) -> Action {
        let ch = Field { id: "channel".into(), label: "Post in".into(), kind: FieldKind::Channel(vec![0, 5]), required: true, value: Some(channel.into()), ..Default::default() };
        let roles = Field { id: "roles".into(), label: "Ping (optional)".into(), desc: Some("Pick roles to notify. Pick @everyone to ping everyone.".into()), kind: FieldKind::Role { most: 5 }, ..Default::default() };
        let text = Field { id: "text".into(), label: "Main body text".into(), long: true, max: 1800, required: true, placeholder: Some("Write it exactly as it should appear. New lines work.".into()), ..Default::default() };
        if sub == "send" {
            Action::Form { id: "eng:announce:send".into(), title: "New announcement".into(), fields: vec![ch,
                Field { id: "title".into(), label: "Announcement title".into(), desc: Some("Optional. A title or color makes it a fancy embed".into()), max: 250, ..Default::default() },
                text, crate::colours::pick_field("color", "Box colour", None, Some("No colour (plain message)")), roles] }
        } else {
            Action::Form { id: "eng:announce:schedule".into(), title: "Schedule an announcement".into(), fields: vec![ch,
                Field { id: "when".into(), label: "When".into(), placeholder: Some("2h, 1d, or 2026-12-31 18:30".into()), max: 40, required: true, ..Default::default() },
                Field { id: "repeat".into(), label: "Repeat".into(), kind: FieldKind::Select(std::iter::once(("Only once".to_string(), "none".to_string())).chain(REPEATS.iter().map(|r| (r.1.to_string(), r.0.to_string()))).collect()), value: Some("none".into()), required: true, ..Default::default() },
                text, roles] }
        }
    }
    fn scheduled(&self) -> Vec<(String, Value)> {
        let mut v = self.data().list("sched:");
        v.sort_by_key(|(_, s)| s["nextAt"].as_i64().unwrap_or(0));
        v
    }
    fn schedule_list(&self, note: Option<&str>, owner: &str) -> Card {
        let items = self.scheduled();
        let rows: Vec<String> = items.iter().map(|(_, s)| format!("**#{}** {} → <#{}>{} - {}", s["id"], tag(s["nextAt"].as_i64().unwrap_or(0), "f"), s["channelId"].as_str().unwrap_or(""), match s["repeat"].as_str() { Some("none") | None => String::new(), Some(r) => format!(" ({})", REPEATS.iter().find(|x| x.0 == r).map(|x| x.1.to_lowercase()).unwrap_or_else(|| r.to_string())) }, short(s["text"].as_str().unwrap_or(""), 60))).collect();
        let mut card = Card::new(Area::General).line([note.map(str::to_string), Some(if rows.is_empty() { "Nothing scheduled.".into() } else { rows.join("\n") })].into_iter().flatten().collect::<Vec<_>>().join("\n\n")).private();
        if !items.is_empty() {
            card = card.select(Select { id: format!("eng:cancel:{owner}"), placeholder: "Cancel one...".into(), min: 1, max: 1, options: items.iter().take(25).map(|(_, s)| (format!("#{} · {}", s["id"], short(&s["text"].as_str().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" "), 80)), s["id"].to_string(), Some("🗑️".into()))).collect() });
        }
        card
    }
    #[allow(clippy::too_many_arguments)]
    fn finish_announcement(&self, by: &str, channel: &str, text: &str, title: Option<&str>, color: Option<&str>, ping: &str, roles: &[String], at: Option<i64>, repeat: &str) -> Vec<Action> {
        match at {
            None => {
                let mut out = private(format!("Announcement sent to <#{channel}>."));
                out.push(Self::announce_action(channel, text, title, color, ping, roles));
                out
            }
            Some(at) => {
                let id = self.next("schedCounter");
                self.data().set(&format!("sched:{id}"), &json!({ "id": id, "channelId": channel, "text": text, "title": title, "color": color, "ping": ping, "roleIds": roles, "repeat": repeat, "nextAt": at, "by": by }));
                private(format!("Scheduled **#{id}** for {} ({}).", tag(at, "f"), tag(at, "R")))
            }
        }
    }

    // ------------------------------------------------------------------ polls
    fn poll_card(p: &Value, id: &str, off: bool) -> Card {
        let options: Vec<String> = p["options"].as_array().map(|a| a.iter().filter_map(|o| o.as_str().map(str::to_string)).collect()).unwrap_or_default();
        let votes = p["votes"].as_object().cloned().unwrap_or_default();
        let choices = |v: &Value| -> Vec<i64> { match v { Value::Array(a) => a.iter().filter_map(Value::as_i64).collect(), Value::Number(n) => n.as_i64().into_iter().collect(), _ => Vec::new() } };
        let voters = votes.len() as i64;
        let counts: Vec<i64> = (0..options.len() as i64).map(|n| votes.values().filter(|v| choices(v).contains(&n)).count() as i64).collect();
        let lines: Vec<String> = options.iter().enumerate().map(|(n, o)| format!("**{}. {}**\n{} {} ({}%)", n + 1, short(o, 100), crate::card::bar_text(counts[n], voters.max(1), 14), counts[n], if voters > 0 { (counts[n] as f64 / voters as f64 * 100.0).round() as i64 } else { 0 })).collect();
        let closed = p["closed"].as_bool().unwrap_or(false);
        let ends = p["endsAt"].as_i64();
        let mut card = Card::new(Area::General).title(format!("📊 {}", short(p["question"].as_str().unwrap_or(""), 250))).line(lines.join("\n\n"))
            .line(format!("-# {voters} voter(s){} · {}", if p["multi"].as_bool().unwrap_or(false) { " · pick several" } else { "" }, if closed { "Poll closed".to_string() } else if let Some(e) = ends { format!("Ends {}", tag(e, "R")) } else { "Open until ended".into() }));
        card.accent = Some(if closed { 0x95a5a6 } else { 0x5865f2 });
        for n in 0..options.len() { card = card.button_full(format!("poll:vote:{id}:{n}"), format!("{}", n + 1), ButtonStyle::Primary, None, off); }
        card
    }
    #[allow(clippy::too_many_arguments)]
    fn create_poll(&self, by: &str, channel: &str, question: &str, options: &[String], dur_raw: Option<&str>, multi: bool, now: i64) -> Vec<Action> {
        let question = question.trim();
        if question.is_empty() { return private("A poll needs a question."); }
        if options.len() < 2 { return private("Give at least two choices, one per line."); }
        if options.len() > 5 { return private("Polls can have up to 5 choices."); }
        if options.iter().any(|o| o.chars().count() > 100) { return private("Each choice can be at most 100 characters."); }
        let lows: HashSet<String> = options.iter().map(|o| o.to_lowercase()).collect();
        if lows.len() != options.len() { return private("Each option must be different."); }
        let dur = dur_raw.filter(|d| !d.is_empty()).map(crate::time::parse_duration);
        if let Some(d) = dur { if d.is_none_or(|d| d > 30 * DAY || d <= 0) { return private("Use a duration like `30m`, `2h` or `3d` (max 30 days)."); } }
        let token = format!("{:08x}", (now as u64).wrapping_mul(2_654_435_761) as u32 ^ options.len() as u32);
        let p = json!({ "question": question, "options": options, "votes": {}, "author": by, "channelId": channel, "endsAt": dur.flatten().map(|d| now + d), "closed": false, "multi": multi });
        self.data().set(&format!("pollpending:{token}"), &p);
        let mut out = private("Poll started.");
        out.push(Action::Post { channel: channel.into(), card: Self::poll_card(&p, "new", false), note: format!("poll:{token}"), ping: Vec::new(), roles: Vec::new() });
        out
    }
    fn poll_form() -> Action {
        Action::Form { id: "eng:poll".into(), title: "New poll".into(), fields: vec![
            Field { id: "question".into(), label: "Question".into(), max: 250, required: true, ..Default::default() },
            Field { id: "options".into(), label: "Choices - one per line (2 to 5)".into(), long: true, max: 600, required: true, placeholder: Some("Pizza\nTacos\nSushi".into()), ..Default::default() },
            Field { id: "duration".into(), label: "Closes after (optional) e.g. 2h, 3d".into(), max: 10, ..Default::default() },
            Field { id: "multiple".into(), label: "Allow several choices? yes / no".into(), max: 3, ..Default::default() },
        ] }
    }
    fn close_poll(&self, key: &str, mut p: Value) -> Vec<Action> {
        p["closed"] = json!(true);
        self.data().set(key, &p);
        let id = key.trim_start_matches("poll:");
        let channel = p["channelId"].as_str().unwrap_or("").to_string();
        vec![
            Action::Edit { channel: channel.clone(), message: id.into(), card: Self::poll_card(&p, id, true) },
            Action::Send { channel, card: Card::new(Area::General).line(format!("📊 The poll **{}** has ended.", short(p["question"].as_str().unwrap_or(""), 100))), ping: Vec::new(), roles: Vec::new() },
        ]
    }

    // ------------------------------------------------------------------ suggestions
    fn status(s: &Value) -> &'static (&'static str, &'static str, u32, bool) {
        STATUS.iter().find(|x| Some(x.0) == s["status"].as_str()).unwrap_or(&STATUS[0])
    }
    fn net(s: &Value) -> i64 {
        s["up"].as_array().map(Vec::len).unwrap_or(0) as i64 - s["down"].as_array().map(Vec::len).unwrap_or(0) as i64
    }
    fn sugg_card(s: &Value) -> Card {
        let st = Self::status(s);
        let (up, down) = (s["up"].as_array().map(Vec::len).unwrap_or(0), s["down"].as_array().map(Vec::len).unwrap_or(0));
        let mut card = Card::new(Area::General).title(format!("Suggestion #{}", s["id"])).line(short(s["text"].as_str().unwrap_or(""), 1800))
            .line(format!("**Votes**\n👍 {up}   👎 {down}   (net {})", signed(Self::net(s)))).line(format!("**Status**\n{}", st.1));
        if let Some(n) = s["note"].as_str().filter(|n| !n.is_empty()) { card = card.line(format!("**Staff note**\n{}", short(n, 500))); }
        card = card.line(format!("-# {}", if s["anonymous"].as_bool().unwrap_or(false) { "Anonymous suggestion".to_string() } else { format!("by {}{}", s["authorTag"].as_str().unwrap_or(""), if s["edited"].as_bool().unwrap_or(false) { " · edited" } else { "" }) }));
        card.accent = Some(st.2);
        card.button_full(format!("sugg:up:{}", s["id"]), "", ButtonStyle::Plain, Some("👍".into()), !st.3).button_full(format!("sugg:down:{}", s["id"]), "", ButtonStyle::Plain, Some("👎".into()), !st.3)
    }
    fn sugg(&self, id: i64) -> Option<Value> {
        self.data().get(&format!("sugg:{id}"))
    }
    fn sugg_line(&self, s: &Value) -> String {
        format!("**#{}** {} · {} · {}{}", s["id"], signed(Self::net(s)), Self::status(s).1, short(s["text"].as_str().unwrap_or(""), 70), match (s["channelId"].as_str(), s["messageId"].as_str()) { (Some(c), Some(m)) => format!(" ([jump](https://discord.com/channels/{}/{c}/{m}))", self.guild), _ => String::new() })
    }
    fn cooldown(&self, user: &str, now: i64) -> Option<i64> {
        let cooldown = self.settings.int(self.guild, MODULE, "suggestionCooldownSeconds") * 1000;
        let last = self.data().get(&format!("cool:{user}")).and_then(|v| v.as_i64()).unwrap_or(0);
        (now - last < cooldown).then(|| (cooldown - (now - last) + 999) / 1000)
    }
    fn submit_suggestion(&self, who: &crate::Member, idea: &str, anonymous: bool, now: i64) -> Vec<Action> {
        let Some(channel) = self.text("suggestionChannel") else { return private("Suggestions are not set up here yet. An admin can run `/suggestion setup channel:#suggestions`.") };
        if let Some(wait) = self.cooldown(&who.id, now) { return private(format!("Please wait {wait}s before another suggestion.")); }
        let idea = idea.trim();
        if idea.is_empty() { return private("A suggestion cannot be empty."); }
        let id = self.next("suggCounter");
        let s = json!({ "id": id, "text": idea, "author": who.id, "authorTag": who.name, "anonymous": anonymous && self.settings.bool(self.guild, MODULE, "suggestionAllowAnonymous"), "up": [], "down": [], "status": "open", "channelId": channel, "createdAt": now, "history": [] });
        self.data().set(&format!("sugg:{id}"), &s);
        self.data().set(&format!("cool:{}", who.id), &json!(now));
        let mut out = private(format!("Thanks! Your suggestion is **#{id}**."));
        out.push(Action::Post { channel, card: Self::sugg_card(&s), note: format!("sugg:{id}"), ping: Vec::new(), roles: Vec::new() });
        out
    }
    fn refresh_sugg(&self, s: &Value) -> Option<Action> {
        match (s["channelId"].as_str(), s["messageId"].as_str()) { (Some(c), Some(m)) => Some(Action::Edit { channel: c.into(), message: m.into(), card: Self::sugg_card(s) }), _ => None }
    }
    fn idea_form(id: &str, title: &str, text: Option<&str>) -> Action {
        Action::Form { id: id.into(), title: title.into(), fields: vec![Field { id: "idea".into(), label: "Your suggestion".into(), long: true, max: 1000, required: true, placeholder: Some("What should we add or change, and why?".into()), value: text.map(str::to_string), ..Default::default() }] }
    }

    // ------------------------------------------------------------------ commands
    pub fn command(&self, ev: &CommandEvent) -> Vec<Action> {
        let arg = |k: &str| ev.args.get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let me = ev.member.id.as_str();
        let yes = |k: &str| matches!(arg(k).as_deref(), Some("true" | "yes" | "on"));
        match ev.name.as_str() {
            "announce" => {
                if !self.can(&ev.member, ANNOUNCE) { return Self::no(ANNOUNCE); }
                match ev.sub.as_deref().unwrap_or("send") {
                    "list" => vec![Action::Reply { card: self.schedule_list(None, me) }],
                    sub => {
                        if sub == "schedule" && self.scheduled().len() >= MAX_SCHEDULES { return private(format!("You can keep up to {MAX_SCHEDULES} scheduled announcements.")); }
                        self.announce_intro(ev, sub)
                    }
                }
            }
            "poll" => {
                if ev.sub.as_deref() == Some("end") {
                    let id = arg("message_id").unwrap_or_default();
                    let key = format!("poll:{id}");
                    let Some(p) = self.data().get(&key).filter(|p| !p["closed"].as_bool().unwrap_or(false)) else { return private("No open poll with that message ID.") };
                    if p["author"].as_str() != Some(me) && !self.can(&ev.member, ANNOUNCE) { return private("Only the poll creator or an announcer can end it."); }
                    let mut out = private("Poll ended.");
                    out.extend(self.close_poll(&key, p));
                    return out;
                }
                if !self.can(&ev.member, POLL) { return Self::no(POLL); }
                let options: Vec<String> = (1..=5).filter_map(|n| arg(&format!("option{n}"))).collect();
                match arg("question") {
                    Some(q) if options.len() >= 2 => self.create_poll(me, &ev.place.channel, &q, &options, arg("duration").as_deref(), yes("multiple"), ev.at_ms),
                    _ => vec![Self::poll_form()],
                }
            }
            "suggest" => match arg("idea") {
                Some(i) => self.submit_suggestion(&ev.member, &i, yes("anonymous"), ev.at_ms),
                None => {
                    if self.text("suggestionChannel").is_none() { return private("Suggestions are not set up here yet. An admin can run `/suggestion setup channel:#suggestions`."); }
                    if let Some(wait) = self.cooldown(me, ev.at_ms) { return private(format!("Please wait {wait}s before another suggestion.")); }
                    self.data().set(&format!("anon:{me}"), &json!(yes("anonymous")));
                    vec![Self::idea_form("eng:idea", "New suggestion", None)]
                }
            },
            "suggestion" => self.suggestion_command(ev),
            _ => self.starboard_command(ev),
        }
    }
    fn suggestion_command(&self, ev: &CommandEvent) -> Vec<Action> {
        let arg = |k: &str| ev.args.get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let me = ev.member.id.as_str();
        let sub = ev.sub.as_deref().unwrap_or("top");
        if sub == "setup" {
            if !self.can(&ev.member, MANAGE) { return Self::no(MANAGE); }
            let Some(c) = arg("channel") else { return private("Pick a text channel.") };
            let _ = self.settings.set(self.guild, MODULE, "suggestionChannel", &json!(c));
            return private(format!("Suggestions will be posted in <#{c}>. Members use `/suggest`."));
        }
        let staff = self.can(&ev.member, SUGGESTIONS);
        let id = arg("id").and_then(|i| i.parse::<i64>().ok()).unwrap_or(0);
        let all: Vec<Value> = self.data().list("sugg:").into_iter().map(|(_, v)| v).collect();
        match sub {
            "status" | "delete" | "info" | "edit" => {
                if sub != "info" && sub != "edit" && !staff { return private("Only staff can do that (`engagement.suggestions`)."); }
                let Some(mut s) = self.sugg(id) else { return private("No suggestion with that number.") };
                match sub {
                    "delete" => {
                        self.data().delete(&format!("sugg:{id}"));
                        let mut out = private(format!("Deleted suggestion #{id}."));
                        if let (Some(c), Some(m)) = (s["channelId"].as_str(), s["messageId"].as_str()) { out.push(Action::Delete { channel: c.into(), message: m.into() }); }
                        out
                    }
                    "status" => {
                        let status = arg("status").unwrap_or_default();
                        if !STATUS.iter().any(|x| x.0 == status) { return private("Unknown status."); }
                        s["status"] = json!(status);
                        if let Some(n) = arg("note") { s["note"] = json!(n); }
                        let note = s["note"].as_str().map(str::to_string);
                        let mut h = s["history"].as_array().cloned().unwrap_or_default();
                        h.push(json!({ "status": status, "by": me, "at": ev.at_ms, "note": note }));
                        s["history"] = json!(h);
                        self.data().set(&format!("sugg:{id}"), &s);
                        let label = Self::status(&s).1;
                        let mut out = private(format!("Suggestion #{id} is now **{label}**."));
                        out.extend(self.refresh_sugg(&s));
                        let author = s["author"].as_str().unwrap_or("").to_string();
                        if notify::allowed(self.db, self.guild, &author, "dms") {
                            out.push(Action::Dm { user: author, card: Card::new(Area::General).line(format!("Your suggestion #{id} is now **{label}**{}", note.as_ref().map(|n| format!(": {}", short(n, 300))).unwrap_or_else(|| ".".into()))), or_in: None });
                        }
                        out
                    }
                    "info" => {
                        let mut card = Self::sugg_card(&s);
                        card.buttons.clear();
                        if staff {
                            card = card.line(format!("**Author (staff only)**\n<@{}>", s["author"].as_str().unwrap_or("")));
                            let h: Vec<String> = s["history"].as_array().map(|a| a.iter().rev().take(5).rev().map(|h| format!("{} by <@{}> {}", STATUS.iter().find(|x| Some(x.0) == h["status"].as_str()).map(|x| x.1).unwrap_or(""), h["by"].as_str().unwrap_or(""), tag(h["at"].as_i64().unwrap_or(0), "R"))).collect()).unwrap_or_default();
                            if !h.is_empty() { card = card.line(format!("**History**\n{}", short(&h.join("\n"), 900))); }
                        }
                        vec![Action::Reply { card: card.private() }]
                    }
                    _ => {
                        if s["author"].as_str() != Some(me) && !staff { return private("You can only edit your own suggestions."); }
                        if !Self::status(&s).3 { return private("That suggestion is closed."); }
                        match arg("text") {
                            Some(t) => self.save_edit(id, &t),
                            None => { self.data().set(&format!("editing:{me}"), &json!(id)); vec![Self::idea_form("eng:edit", "Edit your suggestion", s["text"].as_str())] }
                        }
                    }
                }
            }
            "mine" => {
                let mut mine: Vec<&Value> = all.iter().filter(|s| s["author"].as_str() == Some(me)).collect();
                mine.sort_by_key(|s| std::cmp::Reverse(s["id"].as_i64().unwrap_or(0)));
                private(if mine.is_empty() { "You have no suggestions yet.".to_string() } else { mine.iter().take(10).map(|s| self.sugg_line(s)).collect::<Vec<_>>().join("\n") })
            }
            _ => {
                let want = arg("status");
                let mut pool: Vec<&Value> = all.iter().filter(|s| match &want { Some(w) => s["status"].as_str() == Some(w), None => Self::status(s).3 }).collect();
                pool.sort_by(|a, b| Self::net(b).cmp(&Self::net(a)).then(a["id"].as_i64().cmp(&b["id"].as_i64())));
                let title = format!("Top suggestions{}", want.as_ref().and_then(|w| STATUS.iter().find(|x| x.0 == w)).map(|x| format!(" · {}", x.1)).unwrap_or_default());
                let mut card = Card::new(Area::General).title(title).line(if pool.is_empty() { "Nothing here yet.".to_string() } else { pool.iter().take(10).map(|s| self.sugg_line(s)).collect::<Vec<_>>().join("\n") }).private();
                card.accent = Some(0x5865f2);
                vec![Action::Reply { card }]
            }
        }
    }
    fn save_edit(&self, id: i64, text: &str) -> Vec<Action> {
        let text = text.trim();
        if text.is_empty() { return private("A suggestion cannot be empty."); }
        let Some(mut s) = self.sugg(id) else { return private("No suggestion with that number.") };
        if !Self::status(&s).3 { return private("That suggestion is closed."); }
        s["text"] = json!(text);
        s["edited"] = json!(true);
        self.data().set(&format!("sugg:{id}"), &s);
        let mut out = private("Updated.");
        out.extend(self.refresh_sugg(&s));
        out
    }
    fn starboard_command(&self, ev: &CommandEvent) -> Vec<Action> {
        let arg = |k: &str| ev.args.get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let sub = ev.sub.as_deref().unwrap_or("status");
        if sub != "top" && !self.can(&ev.member, MANAGE) { return Self::no(MANAGE); }
        let set = |k: &str, v: Value| { let _ = self.settings.set(self.guild, MODULE, k, &v); };
        let emoji = || self.text("starEmoji").unwrap_or_else(|| "⭐".into());
        let thr = || self.settings.int(self.guild, MODULE, "starThreshold");
        match sub {
            "setup" => {
                let Some(c) = arg("channel") else { return private("Pick a text channel.") };
                if let Some(e) = arg("emoji") { if !is_emoji(&e) { return private("That is not a single emoji (a normal emoji or a custom one like `<:name:123…>`)."); } set("starEmoji", json!(e)); }
                set("starboardChannel", json!(c));
                if let Some(t) = arg("threshold").and_then(|t| t.parse::<i64>().ok()) { set("starThreshold", json!(t.clamp(1, 50))); }
                set("starEnabled", json!(true));
                private(format!("⭐ Starboard is on: <#{c}>, {} × {}.", emoji(), thr()))
            }
            "enable" | "disable" => { set("starEnabled", json!(sub == "enable")); private(format!("Starboard {sub}d.")) }
            "channel" => {
                let Some(c) = arg("channel") else { return private("Pick a text channel.") };
                set("starboardChannel", json!(c));
                private(format!("Starboard channel is now <#{c}>. Existing starred posts stay where they are."))
            }
            "emoji" => {
                let e = arg("emoji").unwrap_or_default();
                if !is_emoji(&e) { return private("That is not a single emoji."); }
                set("starEmoji", json!(e));
                private(format!("Starboard emoji is now {e}."))
            }
            "threshold" => { set("starThreshold", json!(arg("count").and_then(|c| c.parse::<i64>().ok()).unwrap_or(3).clamp(1, 50))); private(format!("Messages need **{}** stars.", thr())) }
            "options" => {
                let mut changed = 0;
                for (opt, key) in [("self_star", "starSelf"), ("ignore_bots", "starIgnoreBots"), ("remove_below", "starRemoveBelow"), ("allow_nsfw", "starAllowNsfw")] {
                    if let Some(v) = arg(opt) { set(key, json!(matches!(v.as_str(), "true" | "yes" | "on"))); changed += 1; }
                }
                if changed == 0 { return private("Choose at least one option to change."); }
                private("Saved. Run `/starboard status` to review.")
            }
            "ignore list" => {
                let list: Vec<String> = self.settings.list(self.guild, MODULE, "starIgnoreChannels");
                private(if list.is_empty() { "No channels are ignored.".to_string() } else { list.iter().map(|c| format!("<#{c}>")).collect::<Vec<_>>().join(" ") })
            }
            "ignore add" | "ignore remove" => {
                let Some(c) = arg("channel") else { return private("Pick a channel.") };
                let mut list: Vec<String> = self.settings.list(self.guild, MODULE, "starIgnoreChannels");
                let add = sub == "ignore add";
                if add { if !list.contains(&c) { list.push(c.clone()); } } else { list.retain(|x| *x != c); }
                set("starIgnoreChannels", json!(list));
                private(format!("{} <#{c}>.", if add { "Now ignoring" } else { "No longer ignoring" }))
            }
            "status" => {
                let b = |k: &str| if self.settings.bool(self.guild, MODULE, k) { "✅ yes" } else { "❌ no" };
                let channel = self.text("starboardChannel");
                let problems: Vec<String> = if channel.is_none() { vec!["No starboard channel is set (`/starboard setup`).".into()] } else { Vec::new() };
                let list: Vec<String> = self.settings.list(self.guild, MODULE, "starIgnoreChannels");
                let mut card = Card::new(Area::General).title("Starboard status")
                    .line(format!("**Enabled** {}\n**Channel** {}\n**Emoji × threshold** {} × {}", b("starEnabled"), channel.as_ref().map(|c| format!("<#{c}>")).unwrap_or_else(|| "*not set*".into()), emoji(), thr()))
                    .line(format!("**Behaviour**\nCount author's own star: {}\nIgnore bot messages: {}\nRemove from board when below threshold: {}\nAllow NSFW channels: {}", b("starSelf"), b("starIgnoreBots"), b("starRemoveBelow"), b("starAllowNsfw")))
                    .line(format!("**Ignored channels**\n{}", if list.is_empty() { "*none*".to_string() } else { list.iter().map(|c| format!("<#{c}>")).collect::<Vec<_>>().join(" ") }))
                    .line(format!("**Starred messages**\n{}", self.data().list("star:").len()))
                    .line(format!("**Checks**\n{}", if problems.is_empty() { "✅ everything looks right".to_string() } else { problems.iter().map(|p| format!("❌ {p}")).collect::<Vec<_>>().join("\n") })).private();
                card.accent = Some(if !problems.is_empty() || !self.settings.bool(self.guild, MODULE, "starEnabled") { 0xfaa61a } else { 0x57f287 });
                vec![Action::Reply { card }]
            }
            _ => {
                let mut rows: Vec<Value> = self.data().list("star:").into_iter().map(|(_, v)| v).filter(|r| r["count"].as_i64().unwrap_or(0) > 0).collect();
                rows.sort_by_key(|r| std::cmp::Reverse(r["count"].as_i64().unwrap_or(0)));
                let lines: Vec<String> = rows.iter().take(10).enumerate().map(|(n, r)| format!("**{}.** {} {} · <@{}> · [jump]({})", n + 1, emoji(), r["count"], r["authorId"].as_str().unwrap_or(""), r["url"].as_str().unwrap_or(""))).collect();
                vec![Action::Reply { card: coloured(0xfee75c, Card::new(Area::General).title("Most starred").line(if lines.is_empty() { "Nothing has been starred yet.".to_string() } else { lines.join("\n") })) }]
            }
        }
    }

    // ------------------------------------------------------------------ buttons, lists and popups
    pub fn press(&self, ev: &ButtonEvent) -> Vec<Action> {
        let p: Vec<&str> = ev.id.split(':').collect();
        let me = ev.member.id.as_str();
        match (p.first().copied(), p.get(1).copied()) {
            (Some("eng"), Some("ann")) => {
                if p.get(2) != Some(&me) { return private("That form belongs to someone else. Run the command yourself to get your own."); }
                if !self.can(&ev.member, ANNOUNCE) { return Self::no(ANNOUNCE); }
                vec![self.announce_form(p.get(3).copied().unwrap_or("send"), &ev.place.channel)]
            }
            (Some("eng"), Some("cancel")) => {
                if p.get(2) != Some(&me) { return private("That list belongs to someone else. Run `/announce list` yourself."); }
                if !self.can(&ev.member, ANNOUNCE) { return Self::no(ANNOUNCE); }
                let id = ev.values.first().cloned().unwrap_or_default();
                let key = format!("sched:{id}");
                let note = if self.data().get(&key).is_none() { "That one was already gone.".to_string() } else { self.data().delete(&key); format!("🗑️ Cancelled #{id}.") };
                vec![Action::Update { card: self.schedule_list(Some(&note), me) }]
            }
            (Some("poll"), Some("vote")) => {
                let key = format!("poll:{}", ev.message);
                let Some(mut poll) = self.data().get(&key).filter(|p| !p["closed"].as_bool().unwrap_or(false)) else { return private("This poll has ended.") };
                let n: i64 = p.get(3).and_then(|n| n.parse().ok()).unwrap_or(-1);
                let count = poll["options"].as_array().map(Vec::len).unwrap_or(0) as i64;
                if !(0..count).contains(&n) { return private("Invalid option."); }
                let votes = poll["votes"].as_object().cloned().unwrap_or_default();
                let mut votes = votes;
                if poll["multi"].as_bool().unwrap_or(false) {
                    let mut mine: Vec<i64> = match votes.get(me) { Some(Value::Array(a)) => a.iter().filter_map(Value::as_i64).collect(), Some(Value::Number(x)) => x.as_i64().into_iter().collect(), _ => Vec::new() };
                    if let Some(at) = mine.iter().position(|x| *x == n) { mine.remove(at); } else { mine.push(n); }
                    mine.sort();
                    if mine.is_empty() { votes.remove(me); } else { votes.insert(me.into(), json!(mine)); }
                } else if votes.get(me).and_then(Value::as_i64) == Some(n) { votes.remove(me); } else { votes.insert(me.into(), json!(n)); }
                poll["votes"] = Value::Object(votes);
                self.data().set(&key, &poll);
                vec![Action::Update { card: Self::poll_card(&poll, &ev.message, false) }]
            }
            (Some("sugg"), Some(dir)) => {
                let id: i64 = p.get(2).and_then(|n| n.parse().ok()).unwrap_or(0);
                let Some(mut s) = self.sugg(id).filter(|s| Self::status(s).3) else { return private("Voting on this suggestion is closed.") };
                let (mine, other) = if dir == "up" { ("up", "down") } else { ("down", "up") };
                let mut o: Vec<Value> = s[other].as_array().cloned().unwrap_or_default();
                o.retain(|u| u.as_str() != Some(me));
                let mut m: Vec<Value> = s[mine].as_array().cloned().unwrap_or_default();
                if m.iter().any(|u| u.as_str() == Some(me)) { m.retain(|u| u.as_str() != Some(me)); } else { m.push(json!(me)); }
                s[other] = json!(o);
                s[mine] = json!(m);
                self.data().set(&format!("sugg:{id}"), &s);
                vec![Action::Update { card: Self::sugg_card(&s) }]
            }
            _ => private("That button is no longer active."),
        }
    }
    pub fn form(&self, ev: &FormEvent) -> Vec<Action> {
        let v = |k: &str| ev.values.get(k).map(|x| x.trim().to_string()).filter(|x| !x.is_empty());
        let me = ev.member.id.as_str();
        match ev.id.as_str() {
            "eng:announce:send" | "eng:announce:schedule" => {
                if !self.can(&ev.member, ANNOUNCE) { return Self::no(ANNOUNCE); }
                let Some(text) = v("text") else { return private("The message cannot be empty.") };
                let channel = v("channel").unwrap_or_else(|| ev.place.channel.clone());
                let roles: Vec<String> = v("roles").map(|r| r.split(',').map(str::trim).filter(|x| !x.is_empty()).map(str::to_string).collect()).unwrap_or_default();
                let (ping, role_ids) = self.notify_from_roles(&roles);
                if ev.id.ends_with("send") {
                    let color = match crate::colours::read(v("color").as_deref(), None) { Ok(c) => match c { crate::colours::Choice::Colour(h) => Some(h), _ => None }, Err(no) => return private(no) };
                    return self.finish_announcement(me, &channel, &text, v("title").as_deref(), color.as_deref(), ping, &role_ids, None, "none");
                }
                let at = v("when").and_then(|w| crate::time::parse_when(&w, self.settings.int(self.guild, MODULE, "timezoneOffset"), ev.at_ms).ok());
                let Some(at) = at.filter(|a| *a >= ev.at_ms + 30_000) else { return private("That time is in the past (or too soon). Pick at least a minute ahead.") };
                if at > ev.at_ms + 366 * DAY { return private("Schedule within the next year."); }
                let repeat = v("repeat").filter(|r| REPEATS.iter().any(|x| x.0 == r)).unwrap_or_else(|| "none".into());
                self.finish_announcement(me, &channel, &text, None, None, ping, &role_ids, Some(at), &repeat)
            }
            "eng:poll" => {
                if !self.can(&ev.member, POLL) { return Self::no(POLL); }
                let options: Vec<String> = v("options").unwrap_or_default().lines().map(str::trim).filter(|o| !o.is_empty()).map(str::to_string).collect();
                let multi = v("multiple").is_some_and(|m| matches!(m.to_lowercase().as_str(), "y" | "yes" | "true" | "1"));
                self.create_poll(me, &ev.place.channel, &v("question").unwrap_or_default(), &options, v("duration").as_deref(), multi, ev.at_ms)
            }
            "eng:idea" => {
                let anon = self.data().get(&format!("anon:{me}")).and_then(|a| a.as_bool()).unwrap_or(false);
                self.submit_suggestion(&ev.member, &v("idea").unwrap_or_default(), anon, ev.at_ms)
            }
            "eng:edit" => {
                let Some(id) = self.data().get(&format!("editing:{me}")).and_then(|i| i.as_i64()) else { return private("That popup ran out. Run the command again.") };
                let Some(s) = self.sugg(id) else { return private("No suggestion with that number.") };
                if s["author"].as_str() != Some(me) && !self.can(&ev.member, SUGGESTIONS) { return private("You can only edit your own suggestions."); }
                self.save_edit(id, &v("idea").unwrap_or_default())
            }
            _ => Vec::new(),
        }
    }
    /// A post the bot made is up: polls, suggestions and starred messages remember their message.
    pub fn posted(&self, note: &str, message: &str) {
        if let Some(token) = note.strip_prefix("poll:") {
            if let Some(p) = self.data().get(&format!("pollpending:{token}")) { self.data().delete(&format!("pollpending:{token}")); self.data().set(&format!("poll:{message}"), &p); }
        } else if let Some(id) = note.strip_prefix("sugg:").and_then(|i| i.parse::<i64>().ok()) {
            if let Some(mut s) = self.sugg(id) { s["messageId"] = json!(message); self.data().set(&format!("sugg:{id}"), &s); }
        } else if let Some(m) = note.strip_prefix("star:") {
            if let Some(mut r) = self.data().get(&format!("star:{m}")) { r["boardMessageId"] = json!(message); self.data().set(&format!("star:{m}"), &r); }
        }
    }
    /// A suggestion that was just posted gets a discussion thread, when the server has that switched on: its name.
    pub fn thread_for(&self, note: &str) -> Option<String> {
        let id = note.strip_prefix("sugg:")?.parse::<i64>().ok()?;
        if !self.settings.bool(self.guild, MODULE, "suggestionThreads") { return None; }
        let s = self.sugg(id)?;
        let text: String = s["text"].as_str().or_else(|| s["suggestion"].as_str()).unwrap_or("").chars().take(60).collect();
        Some(if text.trim().is_empty() { format!("Suggestion #{id}") } else { format!("#{id}: {}", text.trim()) })
    }
    /// Scheduled announcements and polls whose time has come.
    pub fn due(&self, now: i64) -> Vec<Action> {
        let mut out = Vec::new();
        for (key, mut s) in self.scheduled() {
            if s["nextAt"].as_i64().unwrap_or(0) > now { continue; }
            let roles: Vec<String> = s["roleIds"].as_array().map(|a| a.iter().filter_map(|r| r.as_str().map(str::to_string)).collect()).unwrap_or_default();
            out.push(Self::announce_action(s["channelId"].as_str().unwrap_or(""), s["text"].as_str().unwrap_or(""), s["title"].as_str(), s["color"].as_str(), s["ping"].as_str().unwrap_or("none"), &roles));
            match s["repeat"].as_str().unwrap_or("none") {
                "none" => self.data().delete(&key),
                r => {
                    let step = REPEATS.iter().find(|x| x.0 == r).map(|x| x.2).unwrap_or(DAY);
                    let mut next = s["nextAt"].as_i64().unwrap_or(now);
                    while next <= now { next += step; }
                    s["nextAt"] = json!(next);
                    self.data().set(&key, &s);
                }
            }
        }
        for (key, p) in self.data().list("poll:") {
            if !p["closed"].as_bool().unwrap_or(false) && p["endsAt"].as_i64().is_some_and(|e| e <= now) { out.extend(self.close_poll(&key, p)); }
        }
        out
    }

    // ------------------------------------------------------------------ starboard
    /// A reaction came in: when it is the star emoji, the Discord layer reads the message and counts the stars.
    pub fn on_reaction(&self, channel_hint: Option<&str>, message: &str, emoji: &str) -> Vec<Action> {
        if !self.settings.bool(self.guild, MODULE, "starEnabled") || self.text("starboardChannel").is_none() { return Vec::new(); }
        let want = self.text("starEmoji").unwrap_or_else(|| "⭐".into());
        if emoji_key(&want) != emoji && want != emoji { return Vec::new(); }
        vec![Action::StarCheck { message: message.into(), emoji: want, skip_author: !self.settings.bool(self.guild, MODULE, "starSelf"), channel: channel_hint.map(str::to_string) }]
    }
    /// The message was read and its stars counted: the board's copy is made, kept up to date, or removed.
    pub fn starred(&self, i: &StarInfo) -> Vec<Action> {
        let Some(board) = self.text("starboardChannel") else { return Vec::new() };
        if i.channel == board { return Vec::new(); }
        let ignored: Vec<String> = self.settings.list(self.guild, MODULE, "starIgnoreChannels");
        if ignored.contains(&i.channel) || i.parent.as_ref().is_some_and(|p| ignored.contains(p)) { return Vec::new(); }
        if i.nsfw && !self.settings.bool(self.guild, MODULE, "starAllowNsfw") { return Vec::new(); }
        if i.author_bot && self.settings.bool(self.guild, MODULE, "starIgnoreBots") { return Vec::new(); }
        if !star_locks().insert(i.message.clone()) { return Vec::new(); }
        let want = self.text("starEmoji").unwrap_or_else(|| "⭐".into());
        let key = format!("star:{}", i.message);
        let rec = self.data().get(&key);
        let threshold = self.settings.int(self.guild, MODULE, "starThreshold");
        let header = format!("{want} **{}** · <#{}>", i.count, i.channel);
        let mut out = Vec::new();
        if i.count >= threshold {
            let mut card = Card::new(Area::General).line(header).picture(i.avatar.clone()).line(format!("**{}**\n{}", i.author_name, short(if i.content.is_empty() { if i.image.is_some() { "" } else { "*(no text)*" } } else { &i.content }, 1800)))
                .line(format!("**Source**\n[Jump to message]({})", i.url)).line(format!("-# {}", tag(i.at_ms, "f")));
            card.accent = Some(0xfee75c);
            if let Some(img) = &i.image { card = card.image(img.clone()); }
            let info = json!({ "count": i.count, "authorId": i.author, "url": i.url, "channelId": i.channel });
            match rec.as_ref().and_then(|r| r["boardMessageId"].as_str().map(str::to_string)) {
                Some(b) => { out.push(Action::Edit { channel: board, message: b.clone(), card }); self.data().set(&key, &json!({ "boardMessageId": b, "count": i.count, "authorId": i.author, "url": i.url, "channelId": i.channel })); }
                None => { self.data().set(&key, &info); out.push(Action::Post { channel: board, card, note: format!("star:{}", i.message), ping: Vec::new(), roles: Vec::new() }); }
            }
        } else if let Some(r) = rec {
            if self.settings.bool(self.guild, MODULE, "starRemoveBelow") {
                if let Some(b) = r["boardMessageId"].as_str() { out.push(Action::Delete { channel: board, message: b.into() }); }
                self.data().delete(&key);
            } else { let mut r = r; r["count"] = json!(i.count); self.data().set(&key, &r); }
        }
        star_locks().remove(&i.message);
        out
    }
    /// A starred message was deleted: its copy goes too.
    pub fn deleted(&self, ids: &[String]) -> Vec<Action> {
        let Some(board) = self.text("starboardChannel") else { return Vec::new() };
        let mut out = Vec::new();
        for id in ids {
            let key = format!("star:{id}");
            if let Some(r) = self.data().get(&key) {
                if let Some(b) = r["boardMessageId"].as_str() { out.push(Action::Delete { channel: board.clone(), message: b.into() }); }
                self.data().delete(&key);
            }
        }
        out
    }
}
