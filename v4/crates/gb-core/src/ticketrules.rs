//! The rules of the ticket system that need no Discord, exactly as Good Boy 3 has them (src/tickets.js): what members
//! can open a ticket about and how urgent each is, the popup for each, how a report's "who" is read and checked,
//! how a new ticket is matched against the staff watch log, the close form, and the numbers for /ticket stats.
//!
//! A watch-log entry is an ACCUSATION, not a finding. Matches are labelled "exact" (a user ID matched) or "possible"
//! (a name matched - names are not unique), and every flag shows the entry's outcome so staff are never told more
//! than is known.

use crate::event::FieldKind;
use crate::Field;
use gb_data::support::{HistoryRow, WatchEntry};
use serde_json::Value;
use std::collections::BTreeMap;

/// (id, label, rank, colour)
pub const URGENCY: &[(&str, &str, u8, u32)] = &[("urgent", "🔴 urgent", 3, 0xed4245), ("high", "🟠 high", 2, 0xfaa61a), ("normal", "🔵 normal", 1, 0x5865f2), ("low", "🟢 low", 0, 0x57f287)];
pub fn urgency(id: &str) -> (&'static str, &'static str, u8, u32) {
    *URGENCY.iter().find(|u| u.0 == id).unwrap_or(&URGENCY[2])
}

/// What a member can open a ticket about.
#[derive(Debug, Clone, PartialEq)]
pub struct Category {
    pub id: String,
    pub emoji: String,
    pub label: String,
    pub urgency: String,
    /// "required": the reported person must be named; "optional": asked for but may be unknown.
    pub report: Option<&'static str>,
    pub appeal: bool,
    pub description: String,
    /// One of the server's own ticket types.
    pub custom: bool,
    pub questions: Vec<String>,
    pub category_id: Option<String>,
    pub application: bool,
    pub role: Option<String>,
}
/// (id, emoji, label, urgency, report, appeal, description)
pub type BuiltIn = (&'static str, &'static str, &'static str, &'static str, Option<&'static str>, bool, &'static str);
pub const CATEGORIES: &[BuiltIn] = &[
    ("scam", "🚨", "Scam, phishing or hacked account", "urgent", Some("optional"), false, "Fake links, stolen accounts, someone trying to trick people"),
    ("safety", "🛡️", "Harassment, threats or safety concern", "urgent", Some("optional"), false, "Someone is threatening, targeting or putting someone at risk"),
    ("report", "📣", "Report a member", "high", Some("required"), false, "Someone broke the rules"),
    ("appeal", "⚖️", "Ban, mute or warning appeal", "normal", None, true, "Ask staff to review a punishment"),
    ("bot", "🛠️", "Problem with the bot or a channel", "normal", None, false, "Something is broken or not working"),
    ("access", "🔑", "Role, verification or access help", "normal", None, false, "Can't see a channel, missing a role, stuck verifying"),
    ("partner", "🤝", "Partnership or business", "low", None, false, "Collaborations, sponsorships, promotions"),
    ("other", "❓", "Question or other", "low", None, false, "Anything else"),
];
fn built(c: &BuiltIn) -> Category {
    Category { id: c.0.into(), emoji: c.1.into(), label: c.2.into(), urgency: c.3.into(), report: c.4, appeal: c.5, description: c.6.into(), custom: false, questions: Vec::new(), category_id: None, application: false, role: None }
}
pub fn built_in() -> Vec<Category> {
    CATEGORIES.iter().map(built).collect()
}
/// Looks a category up by id. `custom` is the server's list of its own ticket types (data `types`).
pub fn find_category(id: &str, custom: &Value) -> Option<Category> {
    if let Some(c) = CATEGORIES.iter().find(|c| c.0 == id) { return Some(built(c)); }
    let t = custom.as_array()?.iter().find(|t| t["id"] == id)?;
    Some(Category {
        id: id.into(), emoji: t["emoji"].as_str().unwrap_or("🎫").into(), label: t["label"].as_str().unwrap_or(id).into(), urgency: "normal".into(), report: None, appeal: false,
        description: String::new(), custom: true, questions: t["questions"].as_array().map(|q| q.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default(),
        category_id: t["categoryId"].as_str().map(str::to_string), application: t["application"] == true, role: t["role"].as_str().map(str::to_string),
    })
}

#[allow(clippy::too_many_arguments)]
fn f(id: &str, kind: FieldKind, long: bool, label: &str, desc: Option<&str>, required: bool, max: u16, placeholder: Option<&str>) -> Field {
    Field { id: id.into(), label: label.into(), desc: desc.map(str::to_string), kind, long, required, max, placeholder: placeholder.map(str::to_string), value: None, hints: Vec::new() }
}
/// Evidence uploads: every form ends with this (Discord allows up to 10 files).
pub fn files_field() -> Field {
    f("files", FieldKind::Files { most: 10 }, false, "Screenshots or files (optional)", Some("Up to 10. Only you and staff can see them."), false, 0, None)
}
/// The popup a member sees for a category. Reports use Discord's member picker, with a box for people not in the server.
pub fn questions_for(cat: &Category) -> Vec<Field> {
    let text = FieldKind::Text;
    if cat.custom {
        let mut out: Vec<Field> = cat.questions.iter().take(4).enumerate().map(|(n, q)| f(&format!("q{n}"), text.clone(), n == 0, &q.chars().take(45).collect::<String>(), None, true, 1000, None)).collect();
        out.push(files_field());
        return out;
    }
    if let Some(report) = cat.report {
        return vec![
            f("who", FieldKind::User { most: 1 }, false, "Who is it about?", Some(if report == "required" { "Search the member list by name. Not in the server? Use the next box." } else { "Search the member list, if you know who it is." }), false, 0, Some("Search members")),
            f("outside", text.clone(), false, "Not in the server? Their name or ID", None, false, 60, Some("e.g. coolguy123 or their user ID")),
            f("details", text.clone(), true, "What happened?", None, true, 1000, Some("Say what they did, where, and roughly when.")),
            f("evidence", text.clone(), true, "Message links (optional)", None, false, 800, Some("Paste message links. Nothing here is shown to them.")),
            files_field(),
        ];
    }
    if cat.appeal {
        return vec![
            f("what", text.clone(), false, "What are you appealing?", None, true, 200, Some("e.g. 7 day ban on 12 March for spam")),
            f("why", text.clone(), true, "Why should it be reviewed?", None, true, 1000, None),
            f("extra", text.clone(), true, "Anything else staff should know", None, false, 800, None),
            files_field(),
        ];
    }
    vec![
        f("details", text.clone(), true, "How can we help?", None, true, 1000, Some("Give as much detail as you can.")),
        f("extra", text, true, "Links or extra details (optional)", None, false, 800, None),
        files_field(),
    ]
}

/// A user name as people type it: lower case, no leading @, no "#0" / "#1234" tail, at most 40 characters.
pub fn normalize_name(raw: &str) -> String {
    let t = raw.trim().trim_start_matches('@');
    let t = match t.rsplit_once('#') { Some((a, b)) if (1..=4).contains(&b.len()) && b.chars().all(|c| c.is_ascii_digit()) => a, _ => t };
    t.trim().to_lowercase().chars().take(40).collect()
}
fn id_of(raw: &str) -> Option<String> {
    let inner = raw.strip_prefix("<@").and_then(|r| r.strip_suffix('>')).map(|r| r.trim_start_matches('!')).unwrap_or(raw);
    ((17..=20).contains(&inner.len()) && inner.chars().all(|c| c.is_ascii_digit())).then(|| inner.to_string())
}
/// Reads the "who" part of a report: (user id, normalised name). Good Boy 3's wording when it can't.
pub fn parse_reported(username: Option<&str>, userid: Option<&str>, required: bool) -> Result<(Option<String>, Option<String>), String> {
    let raw = userid.unwrap_or("").trim();
    let id = if raw.is_empty() { None } else {
        Some(id_of(raw).ok_or("That doesn't look like a user ID. It's a long number (17-20 digits): turn on Developer Mode in Discord's settings (Advanced), right-click the person and choose Copy User ID. Leave it empty if you don't have it.")?)
    };
    let name = normalize_name(username.unwrap_or(""));
    if required && id.is_none() && name.is_empty() { return Err("Tell us who it is about: pick them in the member search, or type their name or ID in the box below it.".into()); }
    Ok((id, (!name.is_empty()).then_some(name)))
}
/// Who a report is about, from the member picker (`who`, an id) or the "not in the server" box (`outside`).
pub fn reported_from(who: Option<&str>, outside: Option<&str>, required: bool) -> Result<(Option<String>, Option<String>), String> {
    if let Some(w) = who.filter(|w| !w.is_empty()) { return parse_reported(None, Some(w), required); }
    let raw = outside.unwrap_or("").trim();
    let is_id = (raw.starts_with("<@") && raw.ends_with('>') && raw[2..raw.len() - 1].trim_start_matches('!').chars().all(|c| c.is_ascii_digit())) || (!raw.is_empty() && raw.chars().all(|c| c.is_ascii_digit()));
    if is_id { parse_reported(None, Some(raw), required) } else { parse_reported(Some(raw), None, required) }
}
/// When a Discord account was made, from its id.
pub fn account_created(id: &str) -> Option<i64> {
    id.parse::<u64>().ok().map(|n| ((n >> 22) + 1_420_070_400_000) as i64)
}
/// "3 years", "5 months", "12 days", "2 hours".
pub fn age_text(ms: i64, now: i64) -> String {
    let d = (now - ms).max(0);
    let day = 86_400_000;
    let (n, unit) = if d >= 365 * day { (d / (365 * day), "year") } else if d >= 30 * day { (d / (30 * day), "month") } else if d >= day { (d / day, "day") } else { ((d / 3_600_000).max(1), "hour") };
    format!("{n} {unit}{}", if n == 1 { "" } else { "s" })
}

/// User IDs written anywhere in some text (plain or as a mention).
pub fn ids_in(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut k = 0;
    while k < chars.len() {
        if chars[k].is_ascii_digit() {
            let start = k;
            while k < chars.len() && chars[k].is_ascii_digit() { k += 1; }
            let run: String = chars[start..k].iter().collect();
            if (17..=20).contains(&run.len()) && !out.contains(&run) { out.push(run); }
        } else { k += 1; }
    }
    out
}
/// A character that continues a name.
fn name_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}
/// `name` appears in `hay` as a whole name ("bob." ends a sentence and matches; "bob.smith" is another name).
fn names_in(hay: &str, name: &str) -> bool {
    let h: Vec<char> = hay.chars().collect();
    let n: Vec<char> = name.chars().collect();
    if n.is_empty() || n.len() > h.len() { return false; }
    (0..=h.len() - n.len()).any(|i| {
        h[i..i + n.len()] == n[..]
            && !(i >= 1 && name_char(h[i - 1]))
            && !(i >= 2 && h[i - 1] == '.' && name_char(h[i - 2]))
            && !h.get(i + n.len()).is_some_and(|c| name_char(*c))
            && !(h.get(i + n.len()) == Some(&'.') && h.get(i + n.len() + 1).is_some_and(|c| name_char(*c)))
    })
}
/// Names shorter than this appear everywhere; they only ever match on a user ID.
const MIN_NAME: usize = 3;

/// One way a ticket touches a watch-log entry: (entry id, how, exact). `how`: opener, id, opener-name or name.
pub type Match = (i64, &'static str, bool);
/// Which watch-log entries a new ticket touches (Good Boy 3's matchWatch).
pub fn match_watch(opener: &str, opener_names: &[String], reported: (Option<&str>, Option<&str>), text: &str, entries: &[WatchEntry]) -> Vec<Match> {
    let mut ids = ids_in(text);
    if let Some(r) = reported.0 { ids.push(r.to_string()); }
    let names: Vec<String> = opener_names.iter().map(|n| normalize_name(n)).filter(|n| !n.is_empty()).collect();
    let hay = text.to_lowercase();
    let mut out = Vec::new();
    for e in entries {
        if let Some(tid) = &e.target_id {
            if tid == opener { out.push((e.id, "opener", true)); continue; }
            if ids.contains(tid) { out.push((e.id, "id", true)); continue; }
        }
        for tname in [&e.target_name, &e.target_alias].into_iter().flatten() {
            if tname.chars().count() < MIN_NAME { continue; }
            if names.contains(tname) { out.push((e.id, "opener-name", false)); break; }
            if reported.1 == Some(tname.as_str()) { out.push((e.id, "name", false)); break; }
            if names_in(&hay, &tname.to_lowercase()) { out.push((e.id, "name", false)); break; }
        }
    }
    out
}
fn how_text(how: &str) -> &'static str {
    match how {
        "opener" => "The person who opened this ticket is on the watch log (user ID match).",
        "id" => "A user ID written in this ticket is on the watch log.",
        "opener-name" => "The person who opened this ticket has the same username as someone on the watch log.",
        _ => "A username written in this ticket matches someone on the watch log.",
    }
}
pub fn outcome_label(s: &str) -> String {
    match s { "open" => "not reviewed yet".into(), "confirmed" => "confirmed by staff".into(), "unfounded" => "marked unfounded by staff".into(), other => other.into() }
}
/// Staff-facing text for the matches: one block per watched person with every earlier report and its outcome.
pub fn describe_matches(matches: &[Match], all: &[WatchEntry]) -> String {
    let key_of = |e: &WatchEntry| e.target_id.clone().unwrap_or_else(|| format!("name:{}", e.target_name.clone().unwrap_or_default()));
    // in the order first seen: (key, how, exact, who)
    let mut groups: Vec<(String, &str, bool, String)> = Vec::new();
    for (id, how, exact) in matches {
        let Some(e) = all.iter().find(|e| e.id == *id) else { continue };
        let key = key_of(e);
        let who = match &e.target_id { Some(t) => format!("<@{t}> (`{t}`)"), None => format!("**{}**", e.target_name.clone().unwrap_or_default()) };
        match groups.iter_mut().find(|g| g.0 == key) {
            Some(g) => if *exact { g.2 = true; g.1 = how; },
            None => groups.push((key, how, *exact, who)),
        }
    }
    let blocks: Vec<String> = groups.iter().map(|(key, how, exact, who)| {
        let mine: Vec<&WatchEntry> = all.iter().filter(|e| &key_of(e) == key).collect();
        let tally: Vec<String> = ["confirmed", "unfounded", "open"].iter().filter_map(|s| {
            let n = mine.iter().filter(|e| e.status == *s).count();
            (n > 0).then(|| format!("{n} {}", if *s == "open" { "not reviewed" } else { s }))
        }).collect();
        format!("{}: {who}\n{}\n{} earlier report(s): {}", if *exact { "**Exact match**" } else { "**Possible match** (names are not unique)" }, how_text(how), mine.len(), tally.join(", "))
    }).collect();
    format!("{}\n\n*A report is an accusation, not proof. Check the outcomes before acting.*", blocks.join("\n\n"))
}

/// The required close form: (id, label, tall, required, max, placeholder). Every field except follow-up must be filled in.
pub type CloseField = (&'static str, &'static str, bool, bool, u16, Option<&'static str>);
pub const CLOSE_FIELDS: &[CloseField] = &[
    ("resolution", "Resolution", false, true, 100, Some("e.g. Resolved, No action needed, Referred to an admin")),
    ("reason", "Why did you decide this?", true, true, 800, None),
    ("action", "Action taken", true, true, 600, Some("What you did (warned, banned, removed a message...). Write \"None\" if nothing.")),
    ("notes", "Notes for other staff", true, true, 800, None),
    ("followup", "Follow-up needed (optional)", false, false, 200, None),
];
pub fn close_form_fields() -> Vec<Field> {
    CLOSE_FIELDS.iter().map(|(id, label, long, required, max, ph)| f(id, FieldKind::Text, *long, label, None, *required, *max, *ph)).collect()
}
/// Reads the close form (Good Boy 3's readCloseForm). Values are cut to each field's length; empty optional ones are None.
pub fn read_close_form(values: &BTreeMap<String, String>) -> Result<BTreeMap<&'static str, Option<String>>, String> {
    let mut out = BTreeMap::new();
    for (id, label, _, required, max, _) in CLOSE_FIELDS {
        let v = values.get(*id).map(|s| s.trim()).unwrap_or("");
        if *required && v.is_empty() { return Err(format!("\"{label}\" is required - closing a ticket needs a resolution, a reason, the action taken and notes.")); }
        let cut: String = v.chars().take(*max as usize).collect();
        out.insert(*id, (!cut.is_empty()).then_some(cut));
    }
    Ok(out)
}
/// How a ticket ended, for the history.
pub fn close_kind_label(kind: &str) -> &'static str {
    match kind { "staff" => "closed by staff", "owner" => "closed by the member who opened it (no staff notes)", "auto" => "auto-closed after inactivity", _ => "closed without notes" }
}
/// Open tickets that have been quiet longer than `hours` (0 = never).
pub fn inactive(t: &Value, now: i64, hours: i64) -> bool {
    hours > 0 && t["status"] == "open" && now - t["lastActivity"].as_i64().or(t["createdAt"].as_i64()).unwrap_or(now) >= hours * 3_600_000
}
/// Numbers for /ticket stats, from the history (Good Boy 3's summarize).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Summary {
    pub total: usize,
    pub by_category: Vec<(String, usize)>,
    pub avg_first_response_ms: Option<i64>,
    pub avg_resolution_ms: Option<i64>,
    pub without_notes: usize,
    pub auto_closed: usize,
}
pub fn summarize(rows: &[HistoryRow], now: i64, days: i64) -> Summary {
    let since = now - days * 86_400_000;
    let recent: Vec<&HistoryRow> = rows.iter().filter(|r| r.opened_at >= since).collect();
    let mut by: Vec<(String, usize)> = Vec::new();
    for r in &recent { match by.iter_mut().find(|(c, _)| *c == r.category) { Some(x) => x.1 += 1, None => by.push((r.category.clone(), 1)) } }
    // Math.round of the average, as Good Boy 3 does
    let avg = |xs: Vec<i64>| (!xs.is_empty()).then(|| (xs.iter().sum::<i64>() as f64 / xs.len() as f64).round() as i64);
    Summary {
        total: recent.len(),
        by_category: by,
        avg_first_response_ms: avg(recent.iter().filter_map(|r| r.first_response_at.map(|f| f - r.opened_at)).collect()),
        avg_resolution_ms: avg(recent.iter().filter_map(|r| r.closed_at.map(|c| c - r.opened_at)).collect()),
        without_notes: recent.iter().filter(|r| r.close_kind.as_deref() == Some("no-notes")).count(),
        auto_closed: recent.iter().filter(|r| r.close_kind.as_deref() == Some("auto")).count(),
    }
}
/// Average rating (to one decimal) and how many, over the last `days` days: (count, average).
pub fn rating_summary(ratings: &[(i64, i64)], now: i64, days: i64) -> (usize, Option<f64>) {
    let list: Vec<i64> = ratings.iter().filter(|(_, at)| now - at <= days * 86_400_000).map(|(stars, _)| *stars).collect();
    let n = list.len();
    (n, (n > 0).then(|| ((list.iter().sum::<i64>() as f64 / n as f64) * 10.0).round() / 10.0))
}
