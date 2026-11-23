//! Tickets, as Good Boy 3's support module has them (modules/support): members pick what their ticket is about (each
//! category has its own urgency), fill in a popup (with files), and get a private channel. Staff claim, set priority
//! (with a reason) and close with a required popup (resolution, reason, action taken, notes). Reports about a member go
//! on a staff-only watch log, and later tickets that mention or come from a logged person are flagged to staff. Every
//! ticket - including ones whose channel was simply deleted - ends up in the history, and every message in the archive.
//!
//! The rules live in `ticketrules` and are checked against Good Boy 3's own functions. The records are Good Boy 3's
//! (`ticket:<channel>`, `counter`, `stats`, `types`, `rating:<n>`, the support_* tables), so tickets carry over.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::event::{FieldKind, KeepFile, TranscriptHead, TranscriptTo};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::store::Data;
use crate::ticketrules as R;
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Def, Field, FormEvent, Kind, Member, MessageEvent, Settings};
use gb_data::support::Closing;
use serde_json::{json, Value};

pub const MODULE: &str = "support";
pub static SETTINGS: &[Def] = &[
    Def { key: "ticketCategory", label: "Category for ticket channels", kind: Kind::Category, default: Fallback::None },
    Def { key: "staffRole", label: "Staff role (more can be added with /permissions on support.staff)", kind: Kind::Role, default: Fallback::None },
    Def { key: "logChannel", label: "Ticket log channel (transcripts and close notes go here - staff only!)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "watchChannel", label: "Staff-only channel for watch-log flags (empty = the ticket log)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "maxOpenPerUser", label: "Max open tickets per member", kind: Kind::Number { min: 1, max: 10 }, default: Fallback::Int(2) },
    Def { key: "autoCloseHours", label: "Auto-close tickets after N hours without a message (0 = never)", kind: Kind::Number { min: 0, max: 720 }, default: Fallback::Int(0) },
    Def { key: "hiddenCategories", label: "Ticket categories to switch off (ids: scam, safety, report, appeal, bot, access, partner, other)", kind: Kind::List, default: Fallback::None },
    Def { key: "watchRetentionDays", label: "Keep watch-log entries for N days (0 = forever)", kind: Kind::Number { min: 0, max: 3650 }, default: Fallback::Int(365) },
    Def { key: "unfoundedRetentionDays", label: "Delete entries marked unfounded after N days (0 = same as above)", kind: Kind::Number { min: 0, max: 3650 }, default: Fallback::Int(30) },
    Def { key: "transcriptFormat", label: "Transcript format", kind: Kind::Select(&["txt", "html"]), default: Fallback::Str("txt") },
    Def { key: "dmTranscript", label: "DM the transcript to the ticket owner", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "askRating", label: "Ask the ticket owner for a 1-5 star rating when staff close their ticket", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "deleteDelaySeconds", label: "Seconds before a deleted ticket vanishes", kind: Kind::Number { min: 1, max: 60 }, default: Fallback::Int(5) },
    Def { key: "archiveTickets", label: "Keep every ticket message and file in the archive on this computer", kind: Kind::Toggle, default: Fallback::Bool(true) },
];
pub const STAFF: Perm = Perm { key: "support.staff", level: Level::Moderator(None) };
pub const WATCH: Perm = Perm { key: "support.watch", level: Level::Moderator(None) };
pub const MANAGE: Perm = Perm { key: "support.manage", level: Level::Admin };

const fn o(name: &'static str, about: &'static str, takes: Takes, required: bool) -> Opt {
    Opt { name, about, takes, required }
}
const ENTRY: Opt = o("id", "Entry number", Takes::Whole { min: 1, max: 1_000_000_000 }, true);
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "ticket", about: "Support tickets", module: MODULE, options: &[], subs: &[
    Sub { name: "setup", about: "(Staff) Where tickets open, where logs go, and the staff role", options: &[
        o("category", "The category new ticket channels go in", Takes::Category, false),
        o("log_channel", "Staff-only channel for transcripts and close notes", Takes::Channel, false),
        o("staff_role", "Who answers tickets", Takes::Role, false),
        o("move_open_tickets", "Also move tickets that are already open into the category", Takes::YesNo, false),
    ] },
    Sub { name: "panel", about: "Post the \"open a ticket\" buttons", options: &[
        o("channel", "Where to post it", Takes::Channel, false), o("title", "Panel title", Takes::Text, false), o("description", "Panel text", Takes::Text, false),
    ] },
    Sub { name: "type add", about: "Add a ticket type", options: &[
        o("label", "Name, e.g. Event help", Takes::Text, true), o("emoji", "Emoji for the button", Takes::Text, false),
        o("questions", "Form questions separated by | (max 5)", Takes::Text, false), o("category", "Category for this type's channels", Takes::Category, false),
        o("application", "A staff application: staff get Accept and Deny buttons", Takes::YesNo, false), o("role", "Give this role when an application is accepted", Takes::Role, false),
    ] },
    Sub { name: "type remove", about: "Remove a type", options: &[o("id", "Type id (see list)", Takes::Text, true)] },
    Sub { name: "type list", about: "List types", options: &[] },
    Sub { name: "watch list", about: "Recent entries", options: &[o("search", "A user ID or part of a username", Takes::Text, false)] },
    Sub { name: "watch view", about: "Everything about one entry", options: &[ENTRY] },
    Sub { name: "watch outcome", about: "Mark a report confirmed or unfounded (asks for a reason)", options: &[ENTRY, o("status", "What staff found", Takes::Choice(&[("confirmed", "confirmed"), ("unfounded", "unfounded"), ("not reviewed", "open")]), true)] },
    Sub { name: "watch add", about: "Watch someone without a ticket (asks for a reason)", options: &[
        o("user", "The member", Takes::Member, false), o("user_id", "Their user ID, if they are not in the server", Takes::Text, false), o("username", "Their username", Takes::Text, false),
    ] },
    Sub { name: "watch remove", about: "(Admins) Delete an entry", options: &[ENTRY] },
    Sub { name: "close", about: "Close this ticket (staff: opens the notes popup)", options: &[o("reason", "Members: why you are closing it (optional)", Takes::Text, false)] },
    Sub { name: "add", about: "Add someone to this ticket", options: &[o("user", "Who", Takes::Member, true)] },
    Sub { name: "remove", about: "Remove someone from this ticket", options: &[o("user", "Who", Takes::Member, true)] },
    Sub { name: "rename", about: "Rename this ticket", options: &[o("name", "New name", Takes::Text, true)] },
    Sub { name: "priority", about: "Set priority (asks for a reason)", options: &[o("level", "Level", Takes::Choice(&[("urgent", "urgent"), ("high", "high"), ("normal", "normal"), ("low", "low")]), true)] },
    Sub { name: "info", about: "Staff view: reported person, priority changes, watch-log matches", options: &[] },
    Sub { name: "transcript", about: "Get a transcript of this ticket", options: &[] },
    Sub { name: "stats", about: "Ticket statistics", options: &[o("days", "Look back this many days (default 30)", Takes::Whole { min: 1, max: 365 }, false)] },
] }];

const MAX_FILE: u64 = 25 * 1024 * 1024;
const MAX_TOTAL: u64 = 60 * 1024 * 1024;

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}
/// "Event help!" -> "event-help"
fn slug(s: &str, max: usize) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() { out.push(c); } else if !out.ends_with('-') { out.push('-'); }
    }
    out.trim_matches('-').chars().take(max).collect::<String>().trim_end_matches('-').to_string()
}
fn safe_name(n: &str) -> String {
    let s: String = n.chars().map(|c| if c.is_alphanumeric() || c == '_' || c == '.' || c == '-' { c } else { '_' }).collect();
    let s = s.trim_start_matches('.').chars().take(80).collect::<String>();
    if s.is_empty() { "file".into() } else { s }
}
fn number_tag(t: &Value) -> String {
    format!("#{:03}", t["number"].as_i64().unwrap_or(0))
}
fn colour_area(urgency: &str) -> Area {
    if urgency == "urgent" || urgency == "high" { Area::Moderation } else { Area::General }
}
fn ts(ms: i64, style: char) -> String {
    format!("<t:{}:{style}>", ms / 1000)
}
fn decides(cat: Option<&R::Category>) -> bool {
    cat.is_some_and(|c| c.appeal || c.application)
}
fn decision_word(cat: Option<&R::Category>) -> &'static str {
    if cat.is_some_and(|c| c.application) { "Application" } else { "Appeal" }
}
fn utc(ms: i64) -> String {
    // "Thu, 12 Nov 2026 03:14:00 GMT", as Date.toUTCString writes it
    let days = ms.div_euclid(86_400_000);
    let secs = ms.rem_euclid(86_400_000) / 1000;
    let (y, m, d) = crate::time::civil(days);
    let wd = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"][days.rem_euclid(7) as usize];
    let mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(m - 1) as usize];
    format!("{wd}, {d:02} {mon} {y} {:02}:{:02}:{:02} GMT", secs / 3600, secs / 60 % 60, secs % 60)
}

/// Why the ticket was opened, for the top of every transcript (only what the member entered and can already see).
pub fn ticket_summary(t: &Value) -> Vec<(String, String)> {
    let mut rows: Vec<(String, Option<String>)> = vec![
        ("Type".into(), t["typeLabel"].as_str().map(str::to_string)),
        ("Urgency".into(), t["priority"].as_str().map(|p| R::urgency(p).1.to_string())),
        ("Opened by".into(), t["openerTag"].as_str().map(str::to_string)),
        ("Opened".into(), t["createdAt"].as_i64().map(utc)),
        ("About".into(), t["report"]["name"].as_str().or(t["report"]["id"].as_str()).map(str::to_string)),
    ];
    for a in t["answers"].as_array().into_iter().flatten() {
        if let Some(text) = a["a"].as_str().filter(|x| !x.is_empty()) { rows.push((a["q"].as_str().unwrap_or("").into(), Some(text.into()))); }
    }
    if t["status"] == "closed" {
        rows.push(("Closed".into(), Some(t["closedAt"].as_i64().map(utc).unwrap_or_else(|| "yes".into()))));
        rows.push(("Close reason".into(), t["closeReason"].as_str().map(str::to_string)));
    }
    rows.into_iter().filter_map(|(l, v)| v.filter(|v| !v.trim().is_empty()).map(|v| (l, v))).collect()
}

pub struct Tickets<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub guild: &'a str,
}
impl Tickets<'_> {
    fn data(&self) -> Data<'_> {
        Data { db: self.db, guild: self.guild, module: MODULE }
    }
    fn set(&self, key: &str) -> Option<String> {
        self.settings.text(self.guild, MODULE, key)
    }
    fn is_staff(&self, m: &Member) -> bool {
        perms::allowed(self.db, self.guild, m, STAFF) || self.set("staffRole").is_some_and(|r| m.roles.contains(&r))
    }
    fn need(&self, m: &Member, p: Perm) -> Option<Vec<Action>> {
        (!perms::allowed(self.db, self.guild, m, p)).then(|| private(format!("You don't have permission for that (`{}`).", p.key)))
    }
    fn admin(m: &Member) -> bool {
        m.perms & (perms::ADMINISTRATOR | (1 << 5)) != 0
    }
    /// The roles that see every ticket: the staff role, and any roles the server gave `support.staff`.
    fn staff_roles(&self) -> Vec<String> {
        let mut roles = self.db.get().perm_roles(self.guild, STAFF.key).unwrap_or_default();
        if let Some(r) = self.set("staffRole") { if !roles.contains(&r) { roles.push(r); } }
        roles
    }
    fn custom(&self) -> Value {
        self.data().get("types").unwrap_or(json!([]))
    }
    fn hidden(&self) -> Vec<String> {
        self.settings.list(self.guild, MODULE, "hiddenCategories")
    }
    fn cat_of(&self, t: &Value) -> Option<R::Category> {
        R::find_category(t["category"].as_str().or(t["type"].as_str()).unwrap_or("other"), &self.custom())
    }
    fn ticket(&self, channel: &str) -> Option<Value> {
        self.data().get(&format!("ticket:{channel}"))
    }
    fn save(&self, channel: &str, t: &Value) {
        self.data().set(&format!("ticket:{channel}"), t);
    }
    fn bump(&self, what: &str) {
        let d = self.data();
        let mut s = d.get("stats").filter(Value::is_object).unwrap_or_else(|| json!({}));
        s[what] = json!(s[what].as_i64().unwrap_or(0) + 1);
        d.set("stats", &s);
    }
    /// The ticket log.
    fn log(&self, card: Card) -> Option<Action> {
        Some(Action::Send { channel: self.set("logChannel")?, card, ping: Vec::new(), roles: Vec::new() })
    }
    /// Staff-only notices (watch flags, background): the watch channel, else the ticket log.
    fn staff_log(&self, card: Card, roles: Vec<String>) -> Option<Action> {
        let channel = self.set("watchChannel").or_else(|| self.set("logChannel"))?;
        Some(Action::Send { channel, card, ping: Vec::new(), roles })
    }
    fn mine_open(&self, user: &str) -> Vec<String> {
        self.data().list("ticket:").into_iter().filter(|(_, t)| t["opener"] == user && t["status"] == "open").map(|(k, _)| k["ticket:".len()..].to_string()).collect()
    }
    fn over_limit(&self, user: &str) -> Option<String> {
        let max = self.settings.int(self.guild, MODULE, "maxOpenPerUser") as usize;
        let mine = self.mine_open(user);
        (mine.len() >= max).then(|| format!("You already have {} open ticket(s): {}", mine.len(), mine.iter().map(|c| format!("<#{c}>")).collect::<Vec<_>>().join(" ")))
    }

    /// The card at the top of a ticket: number, type, who opened it and when, status, urgency, the answers, the
    /// decision; and its buttons.
    fn control(&self, t: &Value) -> Card {
        let cat = self.cat_of(t);
        let u = R::urgency(t["priority"].as_str().unwrap_or("normal"));
        let status = t["claimedBy"].as_str().map(|s| format!("Claimed by <@{s}>")).unwrap_or_else(|| "Waiting for staff".into());
        let mut card = Card::new(colour_area(u.0)).title(format!("Ticket {} · {}", number_tag(t), t["typeLabel"].as_str().unwrap_or("")))
            .line(format!("Opened by <@{}> {}\nStaff will be with you shortly.", t["opener"].as_str().unwrap_or(""), ts(t["createdAt"].as_i64().unwrap_or(0), 'R')))
            .line(format!("**Status** {status} · **Urgency** {}", u.1));
        for a in t["answers"].as_array().into_iter().flatten() {
            if let Some(text) = a["a"].as_str().filter(|x| !x.is_empty()) { card = card.line(format!("**{}**\n{}", short(a["q"].as_str().unwrap_or(""), 250), short(text, 1000))); }
        }
        if t["decision"].is_object() {
            let d = &t["decision"];
            card = card.line(format!("**{} {}**\n{}", d["word"].as_str().unwrap_or("Appeal"), d["result"].as_str().unwrap_or(""), short(d["message"].as_str().unwrap_or("The staff team has made a decision."), 500)));
        }
        card = card.button_with("ticket:claim", if t["claimedBy"].is_string() { "Unclaim" } else { "Claim" }, ButtonStyle::Primary, Some("🙋".into()))
            .button_with("ticket:close", "Close", ButtonStyle::Danger, Some("🔒".into()))
            .button_with("ticket:prio", "Priority", ButtonStyle::Plain, Some("🚦".into()))
            .button_with("ticket:transcript", "Transcript", ButtonStyle::Plain, Some("📄".into()));
        if decides(cat.as_ref()) && !t["decision"].is_object() {
            let app = cat.as_ref().is_some_and(|c| c.application);
            card = card.button_with("ticket:appeal:approve", if app { "Accept application" } else { "Approve appeal" }, ButtonStyle::Good, Some("✅".into()))
                .button_with("ticket:appeal:deny", if app { "Deny application" } else { "Deny appeal" }, ButtonStyle::Danger, Some("⛔".into()));
        }
        card
    }
    fn refresh(&self, channel: &str, t: &Value) -> Option<Action> {
        Some(Action::Edit { channel: channel.into(), message: t["controlMessageId"].as_str()?.into(), card: self.control(t) })
    }
    fn say(&self, channel: &str, text: String) -> Action {
        Action::Send { channel: channel.into(), card: Card::new(Area::General).line(text), ping: Vec::new(), roles: Vec::new() }
    }

    /// A member's card: name, id, account age and when they joined (or that they are not in the server).
    fn person(&self, id: Option<&str>, member: Option<&Member>, fallback: Option<&str>, now: i64) -> (Vec<String>, Value) {
        let Some(id) = id else {
            let name = fallback.unwrap_or("Unknown");
            return (vec![format!("**{name}** · no user ID given")], json!({ "id": null, "name": fallback, "created": null, "joined": null, "inServer": false }));
        };
        let name = member.map(|m| m.name.clone()).or_else(|| fallback.map(str::to_string)).unwrap_or_else(|| id.to_string());
        let mut lines = vec![format!("**@{name}** · `{id}`")];
        let made = R::account_created(id);
        if let Some(m) = made { lines.push(format!("Account made {} ({} ago)", ts(m, 'D'), R::age_text(m, now))); }
        let joined = member.and_then(|m| m.joined_at);
        lines.push(match (member, joined) { (_, Some(j)) => format!("Joined {} ({} ago)", ts(j, 'D'), R::age_text(j, now)), (Some(_), None) => "In the server".into(), (None, _) => "Not in the server".into() });
        (lines, json!({ "id": id, "name": name, "created": made, "joined": joined, "inServer": member.is_some() }))
    }
    /// What staff should know about someone: moderation history, reports about them and their earlier tickets.
    fn staff_facts(&self, id: &str) -> String {
        let hist = self.db.get().data_get(self.guild, crate::moderation::MODULE, &format!("hist:{id}")).ok().flatten().and_then(|v| v.as_array().cloned()).unwrap_or_default();
        let count = |k: &str| hist.iter().filter(|e| e["type"] == k).count();
        let reports = self.db.get().watch_about(self.guild, id).unwrap_or_default();
        let tickets = self.db.get().tickets_opened_by(self.guild, id).unwrap_or(0);
        let confirmed = reports.iter().filter(|r| r.status == "confirmed").count();
        let mut lines = vec![
            format!("Warnings **{}** · timeouts **{}** · kicks **{}** · bans **{}**", count("warn"), count("timeout"), count("kick"), count("ban")),
            format!("Reported **{}** time{} before{} · opened **{tickets}** ticket{}", reports.len(), if reports.len() == 1 { "" } else { "s" }, if reports.is_empty() { String::new() } else { format!(" ({confirmed} confirmed)") }, if tickets == 1 { "" } else { "s" }),
        ];
        for e in hist.iter().take(3) {
            lines.push(format!("· {} <t:{}:d>{}", e["type"].as_str().unwrap_or(""), e["at"].as_i64().unwrap_or(0) / 1000, e["reason"].as_str().filter(|r| !r.is_empty()).map(|r| format!(": {}", short(r, 60))).unwrap_or_default()));
        }
        lines.join("\n")
    }

    // ------------------------------------------------------------ commands
    pub fn command(&self, ev: &CommandEvent) -> Vec<Action> {
        let arg = |k: &str| ev.args.get(k).map(String::as_str).filter(|s| !s.trim().is_empty());
        let here = ev.place.channel.as_str();
        let sub = ev.sub.as_deref().unwrap_or("");
        if let Some(w) = sub.strip_prefix("watch ") { return self.watch_command(ev, w); }
        if let Some(w) = sub.strip_prefix("type ") { return self.type_command(ev, w); }
        match sub {
            "setup" => return self.setup(ev),
            "panel" => {
                if let Some(no) = self.need(&ev.member, MANAGE) { return no; }
                // nothing filled in: a popup with the channel and wording, already filled with sensible text
                if arg("channel").is_none() && arg("title").is_none() && arg("description").is_none() {
                    return vec![Action::Form { id: "ticket:panelform".into(), title: "Ticket panel".into(), fields: panel_fields(here) }];
                }
                return self.post_panel(arg("channel").unwrap_or(here), arg("title"), arg("description"));
            }
            "stats" => {
                if let Some(no) = self.need(&ev.member, STAFF) { return no; }
                return self.stats(arg("days").and_then(|d| d.parse().ok()).unwrap_or(30), ev.at_ms);
            }
            _ => {}
        }
        // everything below works inside a ticket channel
        let Some(mut t) = self.ticket(here) else { return private("Use this inside a ticket channel.") };
        let staff = self.is_staff(&ev.member);
        if sub == "close" {
            if staff { return self.start_staff_close(&t); }
            if t["opener"].as_str() != Some(ev.member.id.as_str()) { return private("Only staff or the ticket owner can close this."); }
            if t["status"] != "open" { return private("Already closed."); }
            let mut out = private("Closing…");
            out.extend(self.close(here, &mut t, &ev.member.id, "owner", None, None, arg("reason"), ev.at_ms));
            return out;
        }
        if !staff { return private("Staff only."); }
        match sub {
            "add" | "remove" => {
                let Some(who) = ev.target.as_ref() else { return private("Pick someone.") };
                if t["opener"].as_str() == Some(who.id.as_str()) { return private("That's the ticket owner."); }
                let adding = sub == "add";
                vec![
                    Action::Reply { card: Card::new(Area::General).line(format!("{} <@{}>.", if adding { "Added" } else { "Removed" }, who.id)) },
                    Action::Access { channel: here.into(), user: who.id.clone(), see: adding, write: adding },
                ]
            }
            "rename" => {
                let name = slug(arg("name").unwrap_or(""), 60);
                if name.is_empty() { return private("Use letters or numbers."); }
                let mut out = private(format!("Renamed to `ticket-{name}`."));
                out.push(Action::RenameChannel { channel: here.into(), name: format!("ticket-{name}") });
                out
            }
            "priority" => self.ask_priority_reason(&t, arg("level").unwrap_or("")),
            "transcript" => {
                let mut out = private("📄 Making the transcript…");
                out.push(self.transcript(here, &t, vec![TranscriptTo::Asker]));
                out
            }
            "info" => self.info(&t),
            _ => private("Unknown part of `/ticket`."),
        }
    }

    fn setup(&self, ev: &CommandEvent) -> Vec<Action> {
        if let Some(no) = self.need(&ev.member, MANAGE) { return no; }
        let arg = |k: &str| ev.args.get(k).map(String::as_str).filter(|s| !s.trim().is_empty());
        let mut done = Vec::new();
        let mut out = Vec::new();
        if let Some(cat) = arg("category") {
            let _ = self.settings.set(self.guild, MODULE, "ticketCategory", &json!(cat));
            done.push(format!("📁 New tickets open in **<#{cat}>**"));
        }
        if let Some(log) = arg("log_channel") {
            let _ = self.settings.set(self.guild, MODULE, "logChannel", &json!(log));
            done.push(format!("📝 Transcripts and close notes go to <#{log}>"));
        }
        if let Some(role) = arg("staff_role") {
            let _ = self.settings.set(self.guild, MODULE, "staffRole", &json!(role));
            done.push(format!("🛡️ Staff role: <@&{role}>"));
        }
        if arg("move_open_tickets") == Some("true") {
            if let Some(target) = self.set("ticketCategory") {
                let list = self.data().list("ticket:");
                for (k, _) in &list { out.push(Action::MoveChannel { channel: k["ticket:".len()..].into(), category: target.clone() }); }
                if !list.is_empty() { done.push(format!("🚚 Moving {} existing ticket{} into the category (I need Manage Channels, and categories hold at most 50 channels)", list.len(), if list.len() == 1 { "" } else { "s" })); }
            }
        }
        let now = |k: &str, f: &dyn Fn(&str) -> String| self.set(k).map(|v| f(&v)).unwrap_or_else(|| "*not set*".into());
        let cat_now = self.set("ticketCategory");
        let summary = [
            if done.is_empty() { "**Ticket setup**".to_string() } else { format!("**Saved:**\n{}\n", done.join("\n")) },
            format!("Category: {}{}", now("ticketCategory", &|id| format!("📁 <#{id}>")), if cat_now.is_some() { "" } else { " (tickets appear at the top of the channel list)" }),
            format!("Log channel: {}", now("logChannel", &|id| format!("<#{id}>"))),
            format!("Staff role: {}", now("staffRole", &|id| format!("<@&{id}>"))),
            if done.is_empty() { "\nFill in the options to change any of these.".into() } else { String::new() },
        ].join("\n");
        let mut all = private(summary.trim_end().to_string());
        all.extend(out);
        all
    }

    pub fn post_panel(&self, channel: &str, title: Option<&str>, description: Option<&str>) -> Vec<Action> {
        let custom = self.custom();
        let hidden = self.hidden();
        let mut all = R::built_in();
        for t in custom.as_array().into_iter().flatten() { if let Some(c) = t["id"].as_str().and_then(|id| R::find_category(id, &custom)) { all.push(c); } }
        all.retain(|c| !hidden.contains(&c.id));
        if all.is_empty() { return private("Every category is hidden. Un-hide some in the settings first."); }
        let list = all.iter().map(|c| format!("{} **{}**{}", c.emoji, c.label, if R::urgency(&c.urgency).2 >= 3 { " *(urgent)*" } else { "" })).collect::<Vec<_>>().join("\n");
        let mut card = Card::new(Area::General).title(short(title.unwrap_or("Need help?"), 200))
            .line(short(&format!("{}\n\n{list}", description.unwrap_or("Press the button that fits your problem. A private channel opens for you and our staff.")), 4000));
        for c in all.iter().take(20) {
            let style = match c.urgency.as_str() { "urgent" => ButtonStyle::Danger, "high" => ButtonStyle::Primary, _ => ButtonStyle::Plain };
            card = card.button_with(format!("ticket:open:{}", c.id), short(&c.label, 80), style, (!c.emoji.is_empty()).then(|| c.emoji.clone()));
        }
        let mut out = private(format!("Panel posted in <#{channel}>."));
        out.push(Action::Send { channel: channel.into(), card, ping: Vec::new(), roles: Vec::new() });
        out
    }

    fn type_command(&self, ev: &CommandEvent, sub: &str) -> Vec<Action> {
        if let Some(no) = self.need(&ev.member, MANAGE) { return no; }
        let arg = |k: &str| ev.args.get(k).map(|s| s.trim()).filter(|s| !s.is_empty());
        let mut list: Vec<Value> = self.custom().as_array().cloned().unwrap_or_default();
        match sub {
            "list" => private(if list.is_empty() { "No custom types. The built-in categories are always available (switch some off with the hiddenCategories setting).".to_string() } else {
                list.iter().map(|t| format!("{} **{}** (`{}`){}", t["emoji"].as_str().unwrap_or("🎫"), t["label"].as_str().unwrap_or(""), t["id"].as_str().unwrap_or(""), t["questions"].as_array().filter(|q| !q.is_empty()).map(|q| format!(" - {} question(s)", q.len())).unwrap_or_default())).collect::<Vec<_>>().join("\n")
            }),
            "remove" => {
                let id = arg("id").unwrap_or("");
                if !list.iter().any(|t| t["id"] == id) { return private("No such type."); }
                list.retain(|t| t["id"] != id);
                self.data().set("types", &json!(list));
                private("Removed. Existing panels using it will say the type is gone - repost the panel.")
            }
            _ => {
                let label = short(arg("label").unwrap_or(""), 40);
                let id = slug(&label, 20);
                if id.is_empty() { return private("Use letters or numbers in the name."); }
                if R::CATEGORIES.iter().any(|c| c.0 == id) { return private("That name is used by a built-in category."); }
                if list.len() >= 10 { return private("You can have up to 10 custom ticket types."); }
                if list.iter().any(|t| t["id"] == id) { return private("A type with that name already exists."); }
                let questions: Vec<String> = arg("questions").unwrap_or("").split('|').map(str::trim).filter(|q| !q.is_empty()).take(5).map(|q| short(q, 45)).collect();
                let application = arg("application") == Some("true");
                let role = arg("role").map(str::to_string);
                if role.is_some() && !application { return private("A role is given when an application is accepted, so turn on `application` too."); }
                let mut t = json!({ "id": id, "label": label, "questions": questions, "categoryId": arg("category"), "application": application, "role": role });
                if let Some(e) = arg("emoji") { t["emoji"] = json!(e.chars().take(40).collect::<String>()); }
                list.push(t);
                self.data().set("types", &json!(list));
                private(format!("Added ticket type **{label}**{}{}. Repost the panel with `/ticket panel` to show it.",
                    if questions.is_empty() { String::new() } else { format!(" with {} form question(s)", questions.len()) },
                    if application { format!(". It's an application: staff get **Accept** and **Deny** buttons{}", role.map(|r| format!(", and accepted members get <@&{r}>")).unwrap_or_default()) } else { String::new() }))
            }
        }
    }

    fn watch_label(e: &gb_data::support::WatchEntry) -> String {
        match &e.target_id { Some(t) => format!("<@{t}> (`{t}`)"), None => format!("**{}**", e.target_name.clone().unwrap_or_default()) }
    }
    fn watch_command(&self, ev: &CommandEvent, sub: &str) -> Vec<Action> {
        if let Some(no) = self.need(&ev.member, WATCH) { return no; }
        let arg = |k: &str| ev.args.get(k).map(|s| s.trim()).filter(|s| !s.is_empty());
        let id: i64 = arg("id").and_then(|v| v.parse().ok()).unwrap_or(0);
        let store = self.db.get();
        match sub {
            "list" => {
                let q = arg("search").unwrap_or("").to_lowercase();
                let mut rows = store.watch_rows(self.guild).unwrap_or_default();
                rows.reverse();
                if !q.is_empty() { rows.retain(|e| e.target_id.as_deref() == Some(q.as_str()) || e.target_name.as_deref().unwrap_or("").contains(&q) || e.target_alias.as_deref().unwrap_or("").contains(&q)); }
                let text = rows.iter().take(15).map(|e| format!("**#{}** {} · {} · ticket {} · {}", e.id, Self::watch_label(e), R::outcome_label(&e.status), e.ticket_number.map(|n| format!("#{n}")).unwrap_or_else(|| "n/a".into()), ts(e.created_at, 'd'))).collect::<Vec<_>>().join("\n");
                private(if text.is_empty() { "The watch log is empty.".into() } else { text })
            }
            "view" => {
                let Some(e) = store.watch_get(self.guild, id).ok().flatten() else { return private("No watch-log entry with that number.") };
                let card = Card::new(Area::Moderation).title(format!("Watch log #{}", e.id))
                    .line(format!("{}{}", Self::watch_label(&e), e.target_alias.as_ref().map(|a| format!(" · account name `{a}`")).unwrap_or_default()))
                    .line(format!("**Outcome**\n{}{}{}", R::outcome_label(&e.status), e.outcome_by.as_ref().map(|b| format!(" by <@{b}>")).unwrap_or_default(), e.outcome_note.as_ref().map(|n| format!("\n{}", short(n, 500))).unwrap_or_default()))
                    .line(format!("**Reported by** <@{}> {} · **Ticket** {}", e.reporter_id, ts(e.created_at, 'R'), e.ticket_number.map(|n| format!("#{n}")).unwrap_or_else(|| "added by staff".into())))
                    .line(format!("**What was reported**\n{}", short(e.summary.as_deref().filter(|s| !s.is_empty()).unwrap_or("—"), 900)))
                    .line(format!("**Evidence**\n{}", short(e.evidence.as_deref().filter(|s| !s.is_empty()).unwrap_or("—"), 900)))
                    .line("-# A report is an accusation, not proof.").private();
                vec![Action::Reply { card }]
            }
            "outcome" => {
                if store.watch_get(self.guild, id).ok().flatten().is_none() { return private("No watch-log entry with that number."); }
                let status = arg("status").unwrap_or("open");
                vec![Action::Form { id: format!("ticket:wf:outcome:{id}:{status}"), title: format!("Mark #{id} {status}"), fields: vec![reason_field("Why? (kept with the entry)")] }]
            }
            "add" => {
                let (username, userid) = (arg("username").map(str::to_string).or_else(|| ev.target.as_ref().map(|t| t.name.clone())), arg("user_id").map(str::to_string).or_else(|| ev.target.as_ref().map(|t| t.id.clone())));
                match R::parse_reported(username.as_deref(), userid.as_deref(), true) {
                    Err(why) => private(why),
                    Ok((rid, rname)) => {
                        let token = format!("ticket:wf:add:{}:{}", rid.unwrap_or_default(), rname.unwrap_or_default().replace(':', ""));
                        vec![Action::Form { id: short(&token, 100), title: "Add to the watch log".into(), fields: vec![reason_field("Why are they being watched?")] }]
                    }
                }
            }
            "remove" => {
                if let Some(no) = self.need(&ev.member, MANAGE) { return no; }
                if !store.watch_remove(self.guild, id).unwrap_or(false) { return private("No watch-log entry with that number."); }
                private(format!("Removed watch-log entry #{id}."))
            }
            _ => private("Unknown part of `/ticket watch`."),
        }
    }

    fn stats(&self, days: i64, now: i64) -> Vec<Action> {
        let s = self.data().get("stats").unwrap_or_default();
        let open = self.data().list("ticket:").iter().filter(|(_, t)| t["status"] == "open").count();
        let sum = R::summarize(&self.db.get().history_rows(self.guild).unwrap_or_default(), now, days);
        let dur = |ms: Option<i64>| match ms { None => "—".to_string(), Some(ms) if ms < 3_600_000 => format!("{} min", (ms as f64 / 60_000.0).round() as i64), Some(ms) => format!("{:.1} h", ms as f64 / 3_600_000.0) };
        let mut cats = sum.by_category.clone();
        cats.sort_by_key(|c| std::cmp::Reverse(c.1));
        let custom = self.custom();
        let cats = cats.iter().map(|(k, n)| format!("{}: {n}", R::find_category(k, &custom).map(|c| c.label).unwrap_or_else(|| k.clone()))).collect::<Vec<_>>().join("\n");
        let ratings: Vec<(i64, i64)> = self.data().list("rating:").iter().map(|(_, r)| (r["stars"].as_i64().unwrap_or(0), r["at"].as_i64().unwrap_or(0))).collect();
        let (rn, ravg) = R::rating_summary(&ratings, now, days);
        let mut card = Card::new(Area::General).title("Ticket stats")
            .line(format!("**Open now** {open} · **Opened (all time)** {} · **Closed (all time)** {}", s["opened"].as_i64().unwrap_or(0), s["closed"].as_i64().unwrap_or(0)))
            .line(format!("**Last {days} days**\n{} ticket(s) · first reply {} · to close {}\n{} auto-closed · {} closed without notes", sum.total, dur(sum.avg_first_response_ms), dur(sum.avg_resolution_ms), sum.auto_closed, sum.without_notes));
        if rn > 0 { card = card.line(format!("**Ratings**\n⭐ **{}** out of 5 from {rn} member{}", ravg.map(|a| if a.fract() == 0.0 { format!("{a:.0}") } else { format!("{a}") }).unwrap_or_default(), if rn == 1 { "" } else { "s" })); }
        if !cats.is_empty() { card = card.line(format!("**By category**\n{}", short(&cats, 900))); }
        vec![Action::Reply { card: card.private() }]
    }

    fn info(&self, t: &Value) -> Vec<Action> {
        let cat = self.cat_of(t);
        let number = t["number"].as_i64().unwrap_or(0);
        let earlier: Vec<_> = self.db.get().watch_rows(self.guild).unwrap_or_default().into_iter().filter(|e| e.ticket_number != Some(number)).collect();
        let text = t["answers"].as_array().into_iter().flatten().filter_map(|a| a["a"].as_str()).collect::<Vec<_>>().join("\n");
        let opener_name = t["openerTag"].as_str().unwrap_or("").split('#').next().unwrap_or("").to_string();
        let matches = R::match_watch(t["opener"].as_str().unwrap_or(""), &[opener_name], (t["report"]["id"].as_str(), t["report"]["name"].as_str()), &text, &earlier);
        let u = R::urgency(t["priority"].as_str().unwrap_or("normal"));
        let mut card = Card::new(colour_area(u.0)).title(format!("Ticket {} · staff view", number_tag(t)))
            .line(format!("**Category** {} {} · **Urgency** {} · **Opened by** <@{}> {}", cat.as_ref().map(|c| c.emoji.clone()).unwrap_or_default(), t["typeLabel"].as_str().unwrap_or(""), u.1, t["opener"].as_str().unwrap_or(""), ts(t["createdAt"].as_i64().unwrap_or(0), 'R')));
        if t["report"].is_object() {
            let id = t["report"]["id"].as_str().map(|i| format!("<@{i}> (`{i}`)")).unwrap_or_default();
            card = card.line(format!("**Reported person**\n{}", format!("{id} {}", t["report"]["name"].as_str().unwrap_or("")).trim()));
        }
        if let Some(log) = t["priorityLog"].as_array().filter(|l| !l.is_empty()) {
            let lines: Vec<String> = log.iter().rev().take(5).rev().map(|p| format!("{} → {} by <@{}>: {}", p["from"].as_str().unwrap_or(""), p["to"].as_str().unwrap_or(""), p["by"].as_str().unwrap_or(""), short(p["reason"].as_str().unwrap_or(""), 120))).collect();
            card = card.line(format!("**Priority changes**\n{}", short(&lines.join("\n"), 900)));
        }
        if t["decision"].is_object() { card = card.line(format!("**{} {}**\n{}", t["decision"]["word"].as_str().unwrap_or("Appeal"), t["decision"]["result"].as_str().unwrap_or(""), short(t["decision"]["reason"].as_str().unwrap_or(""), 500))); }
        card = card.line(format!("**Watch log**\n{}", if matches.is_empty() { "No matches.".into() } else { short(&R::describe_matches(&matches, &earlier), 1000) }));
        vec![Action::Reply { card: card.private() }]
    }

    // ------------------------------------------------------------ buttons
    pub fn button(&self, ev: &ButtonEvent, rest: &str) -> Vec<Action> {
        let here = ev.place.channel.as_str();
        let (action, arg) = rest.split_once(':').unwrap_or((rest, ""));
        if action == "open" {
            let Some(cat) = R::find_category(arg, &self.custom()).filter(|c| !self.hidden().contains(&c.id)) else { return private("That kind of ticket is not available any more.") };
            if let Some(no) = self.over_limit(&ev.member.id) { return private(no); }
            return vec![Action::Form { id: format!("ticket:form:{}", cat.id), title: short(&cat.label, 45), fields: R::questions_for(&cat) }];
        }
        let Some(mut t) = self.ticket(here) else { return private("This isn't a ticket channel anymore.") };
        let staff = self.is_staff(&ev.member);
        let owner = t["opener"].as_str() == Some(ev.member.id.as_str());
        let cat = self.cat_of(&t);
        match action {
            "claim" => {
                if !staff { return private("Only staff can claim tickets."); }
                if let Some(other) = t["claimedBy"].as_str().filter(|c| *c != ev.member.id) {
                    if !Self::admin(&ev.member) { return private(format!("Already claimed by <@{other}>.")); }
                }
                let mine = t["claimedBy"].as_str() == Some(ev.member.id.as_str());
                t["claimedBy"] = if mine { Value::Null } else { json!(ev.member.id) };
                self.save(here, &t);
                vec![Action::Update { card: self.control(&t) }, self.say(here, if mine { format!("<@{}> released this ticket.", ev.member.id) } else { format!("🙋 <@{}> claimed this ticket.", ev.member.id) })]
            }
            "close" => {
                if staff { return self.start_staff_close(&t); }
                if !owner { return private("Only staff or the ticket owner can close this."); }
                if t["status"] != "open" { return private("This ticket is already closed."); }
                vec![Action::Reply { card: Card::new(Area::General).line("Close this ticket?").button("ticket:confirm", "Yes, close it", ButtonStyle::Danger).button("ticket:cancel", "Cancel", ButtonStyle::Plain).private() }]
            }
            "outcome" => {
                if !staff { return private("Only staff can close tickets."); }
                if t["status"] != "open" { return private("This ticket is already closed."); }
                vec![close_popup(arg)]
            }
            "cancel" => vec![Action::Update { card: Card::new(Area::General).line("Cancelled.").private() }],
            "confirm" => {
                if staff || !owner { return private(if staff { "Staff close tickets with the Close button (it asks for notes)." } else { "Only staff or the ticket owner can close this." }); }
                if t["status"] != "open" { return vec![Action::Update { card: Card::new(Area::General).line("Already closed.").private() }]; }
                let mut out = vec![Action::Update { card: Card::new(Area::General).line("Closing…").private() }];
                out.extend(self.close(here, &mut t, &ev.member.id, "owner", None, None, None, ev.at_ms));
                out
            }
            "reopen" => {
                if !staff && !owner { return private("Only staff or the ticket owner can reopen this."); }
                if t["status"] != "closed" { return private("This ticket is already open."); }
                t["status"] = json!("open");
                t["lastActivity"] = json!(ev.at_ms);
                if let Some(o) = t.as_object_mut() { o.remove("closedAt"); o.remove("closeKind"); }
                self.save(here, &t);
                let _ = self.db.get().history_reopen(self.guild, t["number"].as_i64().unwrap_or(0));
                let opener = t["opener"].as_str().unwrap_or("").to_string();
                let mut again = self.control(&t);
                again.title = None;
                again.lines = vec![format!("🔓 Reopened by <@{}>.", ev.member.id)];
                vec![Action::Update { card: Card::new(Area::Moderation).title("Ticket closed").line("Reopened.") }, Action::Access { channel: here.into(), user: opener, see: true, write: true },
                    Action::Send { channel: here.into(), card: again, ping: Vec::new(), roles: Vec::new() }]
            }
            "delete" => {
                if !staff { return private("Only staff can delete tickets."); }
                let secs = self.settings.int(self.guild, MODULE, "deleteDelaySeconds").clamp(1, 60);
                let _ = self.db.get().history_ensure(self.guild, &t, here);
                self.data().delete(&format!("ticket:{here}"));
                vec![Action::Update { card: Card::new(Area::Moderation).title("Ticket closed").line(format!("🗑️ Deleting this channel in {secs} seconds.")) }, Action::DeleteChannel { channel: here.into(), after_secs: secs as u32 }]
            }
            "transcript" => {
                if !staff { return private("Only staff can pull transcripts."); }
                let mut out = private("📄 Making the transcript…");
                out.push(self.transcript(here, &t, vec![TranscriptTo::Asker]));
                out
            }
            "prio" => {
                if !staff { return private("Only staff can change priority."); }
                let mut card = Card::new(Area::General).line("New priority?").private();
                for (k, label, _, _) in R::URGENCY {
                    let (emoji, word) = label.split_once(' ').unwrap_or(("", label));
                    card = card.button_with(format!("ticket:level:{k}"), word, ButtonStyle::Plain, Some(emoji.into()));
                }
                vec![Action::Reply { card }]
            }
            "level" => {
                if !staff { return private("Only staff can change priority."); }
                self.ask_priority_reason(&t, arg)
            }
            "appeal" => {
                if !staff { return private("Only staff can decide appeals and applications."); }
                if !decides(cat.as_ref()) { return private("This is not an appeal or application."); }
                if t["decision"].is_object() { return private("A decision has already been made."); }
                let app = cat.as_ref().is_some_and(|c| c.application);
                let result = if arg == "approve" { if app { "accepted" } else { "approved" } } else { "denied" };
                let title = match (arg == "approve", app) { (true, true) => "Accept this application", (true, false) => "Approve this appeal", (false, true) => "Deny this application", (false, false) => "Deny this appeal" };
                vec![Action::Form { id: format!("ticket:af:{result}"), title: title.into(), fields: vec![
                    reason_field("Why? (kept in the staff log)"),
                    Field { id: "message".into(), label: "Message to the member (optional)".into(), long: true, max: 1500, ..Default::default() },
                ] }]
            }
            _ => private("Unknown button."),
        }
    }
    /// Staff pressing Close: outcome buttons for reports, otherwise straight to the popup.
    /// Claim, reply to or close a ticket from the launcher, as the bot's owner. `what`: "claim" (which also releases),
    /// "reply" or "close". Gives what to tell the person at the launcher and what Discord must do.
    /// Every ticket for the dashboard's list: who opened it, who it is about, how urgent it is, who has it and what they
    /// have done. An open ticket is read live (urgency and who claimed it change), a closed one from its history.
    pub fn launcher_rows(&self) -> Vec<Value> {
        let rows = self.db.get().history_list(self.guild).unwrap_or_default();
        let live: std::collections::HashMap<i64, Value> = self.data().list("ticket:").into_iter().filter_map(|(_, t)| Some((t["number"].as_i64()?, t))).collect();
        let ids: Vec<String> = rows.iter().flat_map(|r| [Some(r.opener_id.clone()), r.claimed_by.clone(), r.closed_by.clone(), r.reported_id.clone()]).flatten().chain(live.values().flat_map(|t| [t["claimedBy"].as_str().map(str::to_string)].into_iter().flatten())).collect();
        let names = self.db.get().roster_names(self.guild, &ids).unwrap_or_default();
        let person = |id: Option<&str>, tag: Option<&str>| -> Value {
            let Some(id) = id.filter(|i| !i.is_empty()) else { return Value::Null };
            let name = names.get(id).cloned().or_else(|| tag.filter(|t| !t.is_empty()).map(str::to_string)).unwrap_or_else(|| format!("Member {}", &id[id.len().saturating_sub(4)..]));
            json!({ "id": id, "name": name })
        };
        let mut out: Vec<Value> = rows.iter().map(|r| {
            let open = r.closed_at.is_none();
            let t = live.get(&r.number).filter(|_| open);
            // an open ticket's claim and urgency are the live ones
            let claimed = t.map(|t| t["claimedBy"].as_str().map(str::to_string)).unwrap_or_else(|| r.claimed_by.clone());
            let urgency = t.and_then(|t| t["priority"].as_str().map(str::to_string)).or_else(|| r.urgency.clone()).unwrap_or_else(|| "normal".into());
            let u = R::urgency(&urgency);
            let first = t.and_then(|t| t["firstResponseAt"].as_i64()).or(r.first_response_at);
            json!({
                "number": r.number, "open": open, "channel": r.channel,
                "opener": person(Some(&r.opener_id), r.opener_tag.as_deref()),
                "about": person(r.reported_id.as_deref(), r.reported_name.as_deref()).as_object().cloned().map(Value::Object).or_else(|| r.reported_name.as_ref().map(|n| json!({ "id": Value::Null, "name": n }))).unwrap_or(Value::Null),
                "severity": { "id": u.0, "label": u.1, "rank": u.2, "color": u.3 },
                "category": r.category, "category_label": r.category_label,
                "opened_at": r.opened_at, "closed_at": r.closed_at, "kind": r.close_kind, "resolution": r.resolution,
                "first_response_ms": first.map(|f| (f - r.opened_at).max(0)),
                "claimed_by": person(claimed.as_deref(), None), "closed_by": person(r.closed_by.as_deref(), None),
            })
        }).collect();
        out.sort_by_key(|t| std::cmp::Reverse(t["number"].as_i64().unwrap_or(0)));
        out
    }
    /// One ticket with its conversation: what the dashboard shows when a ticket is opened.
    pub fn launcher_thread(&self, number: i64) -> Option<Value> {
        let ticket = self.launcher_rows().into_iter().find(|t| t["number"].as_i64() == Some(number))?;
        let messages: Vec<Value> = self.db.get().archive_messages(self.guild, number, 300).unwrap_or_default().into_iter().map(|m| {
            let files: Vec<String> = serde_json::from_str::<Value>(&m.attachments).ok().and_then(|v| v.as_array().map(|a| a.iter().filter_map(|f| f["name"].as_str().or(f["filename"].as_str()).map(str::to_string)).collect())).unwrap_or_default();
            json!({ "id": m.id, "author": { "id": m.author_id, "name": m.author_name }, "bot": m.bot, "text": m.content, "files": files, "at": m.at, "deleted": m.deleted })
        }).collect();
        Some(json!({ "ticket": ticket, "messages": messages }))
    }
    /// The transcript file for the dashboard's Save button, as text or as Good Boy's HTML page: (file name, contents).
    pub fn launcher_transcript(&self, number: i64, html: bool, guild_name: &str) -> Option<(String, String)> {
        let thread = self.launcher_thread(number)?;
        let t = &thread["ticket"];
        let msgs: Vec<TranscriptMsg> = thread["messages"].as_array().map(|a| a.iter().map(|m| TranscriptMsg {
            at_ms: m["at"].as_i64().unwrap_or(0),
            author_tag: format!("{}{}", m["author"]["name"].as_str().filter(|n| !n.is_empty()).unwrap_or("Someone"), if m["bot"] == true { " (bot)" } else { "" }),
            avatar: None,
            content: format!("{}{}", m["text"].as_str().unwrap_or(""), if m["deleted"] == true { "  [deleted]" } else { "" }),
            files: m["files"].as_array().map(|f| f.iter().filter_map(|n| n.as_str()).map(|n| (n.to_string(), String::new())).collect()).unwrap_or_default(),
            boxes: Vec::new(),
        }).collect()).unwrap_or_default();
        let head = TranscriptHead {
            number,
            type_label: t["category_label"].as_str().or(t["category"].as_str()).unwrap_or("").to_string(),
            opener_tag: t["opener"]["name"].as_str().unwrap_or("").to_string(),
            guild_name: guild_name.to_string(),
            summary: Vec::new(),
            format: if html { "html" } else { "txt" }.into(),
        };
        let (name, bytes) = transcript_file(&head, &msgs);
        Some((name, String::from_utf8_lossy(&bytes).into_owned()))
    }
    pub fn from_launcher(&self, number: i64, what: &str, text: &str, by: &str, by_name: &str, now: i64) -> Result<(String, Vec<Action>), String> {
        let (channel, mut t) = self.data().list("ticket:").into_iter().find(|(_, t)| t["number"].as_i64() == Some(number)).map(|(k, t)| (k["ticket:".len()..].to_string(), t)).ok_or("There is no ticket with that number.")?;
        if t["status"] != "open" { return Err("That ticket is already closed.".into()); }
        let text: String = text.trim().chars().take(1500).collect();
        match what {
            "claim" => {
                let mine = t["claimedBy"].as_str() == Some(by);
                t["claimedBy"] = if mine { Value::Null } else { json!(by) };
                self.save(&channel, &t);
                let from = if by_name.is_empty() { String::new() } else { " (from the dashboard)".to_string() };
                let mut out = vec![self.say(&channel, if mine { format!("<@{by}> released this ticket.{from}") } else { format!("🙋 <@{by}> claimed this ticket.{from}") })];
                out.extend(self.refresh(&channel, &t));
                Ok((if mine { "Released." } else { "Claimed." }.into(), out))
            }
            "reply" => {
                if text.is_empty() { return Err("Write something to send.".into()); }
                // the first staff reply starts the clock for "first reply after"
                if !t["firstResponseAt"].is_i64() { t["firstResponseAt"] = json!(now); self.save(&channel, &t); }
                let who = if by_name.is_empty() { format!("<@{by}>") } else { format!("**{}**", by_name.replace('*', "")) };
                Ok(("Sent.".into(), vec![Action::Send { channel: channel.clone(), card: Card::new(Area::General).line(format!("💬 **Staff reply** from {who} (<@{by}>)\n{text}")), ping: t["opener"].as_str().map(|o| vec![o.to_string()]).unwrap_or_default(), roles: Vec::new() }]))
            }
            "close" => {
                if text.is_empty() { return Err("Say how it was resolved: it is kept in the staff log.".into()); }
                let form: std::collections::BTreeMap<&'static str, Option<String>> = [("resolution", Some(text.clone())), ("reason", None)].into();
                let out = self.close(&channel, &mut t, by, "staff", Some(&form), None, None, now);
                Ok(("Closed.".into(), out))
            }
            _ => Err("That is not something a ticket can do from here.".into()),
        }
    }
    fn start_staff_close(&self, t: &Value) -> Vec<Action> {
        if t["status"] != "open" { return private("This ticket is already closed."); }
        if self.cat_of(t).is_some_and(|c| c.report.is_some()) && t["report"]["watchId"].is_i64() {
            let card = Card::new(Area::General).line("**How did the report turn out?** This is recorded on the staff watch log.")
                .button("ticket:outcome:confirmed", "The report was right", ButtonStyle::Danger)
                .button("ticket:outcome:unfounded", "The report was wrong", ButtonStyle::Good)
                .button("ticket:outcome:inconclusive", "Not enough to say", ButtonStyle::Plain).private();
            return vec![Action::Reply { card }];
        }
        vec![close_popup("")]
    }
    fn ask_priority_reason(&self, t: &Value, level: &str) -> Vec<Action> {
        if !R::URGENCY.iter().any(|u| u.0 == level) { return private("Unknown priority."); }
        if level == t["priority"].as_str().unwrap_or("normal") { return private(format!("It is already {}.", R::urgency(level).1)); }
        vec![Action::Form { id: format!("ticket:pf:{level}"), title: format!("Priority → {level}"), fields: vec![reason_field("Why change it? (kept in the staff log)")] }]
    }

    // ------------------------------------------------------------ popups
    pub fn form(&self, ev: &FormEvent) -> Vec<Action> {
        let here = ev.place.channel.as_str();
        let rest = ev.id.strip_prefix("ticket:").unwrap_or("");
        let (action, arg) = rest.split_once(':').unwrap_or((rest, ""));
        let v = |k: &str| ev.values.get(k).map(|s| s.trim()).filter(|s| !s.is_empty());
        match action {
            "form" => return self.open(ev, arg),
            "panelform" => {
                if let Some(no) = self.need(&ev.member, MANAGE) { return no; }
                return self.post_panel(v("channel").unwrap_or(here), v("title"), v("description"));
            }
            "wf" => return self.watch_form(ev, arg),
            _ => {}
        }
        let Some(mut t) = self.ticket(here) else { return private("This isn't a ticket channel anymore.") };
        let staff = self.is_staff(&ev.member);
        match action {
            "cf" => {
                if !staff { return private("Only staff can close tickets."); }
                if t["status"] != "open" { return private("This ticket is already closed."); }
                let form = match R::read_close_form(&ev.values) { Ok(f) => f, Err(why) => return private(why) };
                let outcome = (!arg.is_empty()).then_some(arg);
                let mut out = private("Ticket closed. Your notes are in the staff log.");
                out.extend(self.close(here, &mut t, &ev.member.id, "staff", Some(&form), outcome, None, ev.at_ms));
                out
            }
            "pf" => {
                if !staff { return private("Only staff can change priority."); }
                let Some(reason) = v("reason") else { return private("A reason is required.") };
                let reason = short(reason, 800);
                let from = t["priority"].as_str().unwrap_or("normal").to_string();
                t["priority"] = json!(arg);
                let mut log = t["priorityLog"].as_array().cloned().unwrap_or_default();
                log.push(json!({ "from": from, "to": arg, "by": ev.member.id, "reason": reason, "at": ev.at_ms }));
                let skip = log.len().saturating_sub(20);
                t["priorityLog"] = json!(log.into_iter().skip(skip).collect::<Vec<_>>());
                self.save(here, &t);
                let (f, to) = (R::urgency(&from), R::urgency(arg));
                let mut out = private(format!("Priority changed to {}.", to.1));
                out.push(self.say(here, format!("🚦 Priority changed from {} to {} by <@{}>.", f.1, to.1, ev.member.id)));
                out.extend(self.refresh(here, &t));
                out.extend(self.staff_log(Card::new(colour_area(to.0)).title(format!("Priority changed · ticket {}", number_tag(&t))).line(format!("{} → {} by <@{}>\n**Reason:** {}", f.1, to.1, ev.member.id, short(&reason, 900))), Vec::new()));
                out
            }
            "af" => {
                if !staff { return private("Only staff can decide appeals and applications."); }
                if t["decision"].is_object() { return private("A decision has already been made."); }
                let cat = self.cat_of(&t);
                let word = decision_word(cat.as_ref());
                let Some(reason) = v("reason") else { return private("A reason is required for an appeal decision.") };
                let message = v("message").map(str::to_string);
                t["decision"] = json!({ "word": word, "result": arg, "reason": short(reason, 800), "message": message, "by": ev.member.id, "at": ev.at_ms });
                self.save(here, &t);
                let opener = t["opener"].as_str().unwrap_or("").to_string();
                let mut out = Vec::new();
                let mut role_note = String::new();
                if arg == "accepted" {
                    if let Some(role) = cat.as_ref().and_then(|c| c.role.clone()) {
                        out.push(Action::Roles { user: opener.clone(), add: vec![role.clone()], remove: Vec::new(), reason: format!("Application accepted by {}", ev.member.name) });
                        role_note = format!("\nThey get <@&{role}> (my role must be above it).");
                    }
                }
                let mut all = private(format!("{word} {arg}. Your reason is in the staff log.{role_note}"));
                all.append(&mut out);
                let msg = message.map(|m| short(&m, 1500)).unwrap_or_else(|| format!("The staff team has reviewed your {}.", word.to_lowercase()));
                all.push(Action::Send { channel: here.into(), card: Card::new(if arg == "denied" { Area::Moderation } else { Area::Games }).line(format!("<@{opener}>")).title(format!("{word} {arg}")).line(msg).line(format!("-# Decided by {}", ev.member.name)), ping: vec![opener.clone()], roles: Vec::new() });
                all.extend(self.refresh(here, &t));
                all.extend(self.log(Card::new(Area::General).title(format!("{word} {arg} · ticket {}", number_tag(&t))).line(format!("By <@{}> for <@{opener}>\n**Reason:** {}", ev.member.id, short(reason, 900)))));
                all
            }
            _ => private("That form is from an older message."),
        }
    }

    fn watch_form(&self, ev: &FormEvent, arg: &str) -> Vec<Action> {
        if let Some(no) = self.need(&ev.member, WATCH) { return no; }
        let Some(reason) = ev.values.get("reason").map(|s| s.trim()).filter(|s| !s.is_empty()) else { return private("A reason is required.") };
        let reason = short(reason, 800);
        let parts: Vec<&str> = arg.splitn(3, ':').collect();
        let store = self.db.get();
        match parts.as_slice() {
            ["outcome", id, status] => {
                let id: i64 = id.parse().unwrap_or(0);
                if !store.watch_set(self.guild, id, status, &ev.member.id, Some(&reason), ev.at_ms).unwrap_or(false) { return private("That entry no longer exists."); }
                private(format!("Entry #{id} is now **{}**.", R::outcome_label(status)))
            }
            ["add", id, name] => {
                let id = (!id.is_empty()).then_some(*id);
                let name = (!name.is_empty()).then_some(*name);
                let n = store.watch_add(self.guild, id, name, None, &ev.member.id, None, Some("staff"), Some(&reason), None, ev.at_ms).unwrap_or(0);
                private(format!("Added to the watch log as **#{n}**. New tickets that mention them (or come from them) will be flagged to staff."))
            }
            _ => private("That form is from an older message."),
        }
    }

    // ------------------------------------------------------------ opening
    fn open(&self, ev: &FormEvent, cat_id: &str) -> Vec<Action> {
        let Some(cat) = R::find_category(cat_id, &self.custom()).filter(|c| !self.hidden().contains(&c.id)) else { return private("That kind of ticket is not available any more.") };
        if let Some(no) = self.over_limit(&ev.member.id) { return private(no); }
        let qs = R::questions_for(&cat);
        let asked: Vec<&Field> = qs.iter().filter(|q| matches!(q.kind, FieldKind::Text) && q.id != "outside").collect();
        let answers: Vec<Value> = asked.iter().filter_map(|q| {
            let a = ev.values.get(&q.id).map(|s| s.trim().to_string()).unwrap_or_default();
            let label = q.label.split(" (").next().unwrap_or(&q.label).to_string();
            (!a.is_empty() || q.required).then(|| json!({ "q": label, "a": a }))
        }).collect();
        let reported = match cat.report {
            Some(req) => match R::reported_from(ev.values.get("who").map(String::as_str), ev.values.get("outside").map(String::as_str), req == "required") { Ok(r) => Some(r), Err(why) => return private(why) },
            None => None,
        };
        let number = self.data().next("counter");
        let staff = self.staff_roles();
        let parent = cat.category_id.clone().or_else(|| self.set("ticketCategory"));
        // the files: downloaded straight away, kept for the archive (names decided now)
        let mut files = Vec::new();
        let mut total = 0u64;
        for (k, (name, url, size)) in ev.files.get("files").cloned().unwrap_or_default().into_iter().take(10).enumerate() {
            let name = safe_name(&name);
            if size > MAX_FILE || total + size > MAX_TOTAL { files.push(json!({ "name": name, "error": "too big to keep" })); continue; }
            total += size;
            files.push(json!({ "name": name, "stored": format!("evidence-{k}-{name}"), "size": size, "url": url }));
        }
        let report = reported.as_ref().filter(|(id, name)| id.is_some() || name.is_some()).map(|(id, name)| json!({ "id": id, "name": name }));
        let t = json!({
            "number": number, "opener": ev.member.id, "openerTag": ev.member.name, "type": cat.id, "category": cat.id, "typeLabel": cat.label, "status": "open",
            "claimedBy": null, "priority": cat.urgency, "createdAt": ev.at_ms, "lastActivity": ev.at_ms, "answers": answers, "report": report, "files": files,
            "openerMember": serde_json::to_value(MemberCard::from(&ev.member)).unwrap_or(Value::Null),
            "aboutMember": reported.as_ref().and_then(|(id, _)| id.as_ref()).and_then(|id| ev.members.iter().find(|m| &m.id == id)).map(|m| serde_json::to_value(MemberCard::from(m)).unwrap_or(Value::Null)),
        });
        self.data().set(&format!("pending:{number}"), &t);
        let name = { let s = slug(&ev.member.name, 16); format!("ticket-{}-{number:03}", if s.is_empty() { "user".into() } else { s }) };
        vec![Action::OpenChannel {
            name, category: parent, topic: format!("Ticket #{number} · {} · {} · {}", ev.member.name, cat.label, R::urgency(&cat.urgency).1),
            members: vec![ev.member.id.clone()], staff_roles: staff, note: format!("ticket:{number}"),
        }]
    }

    /// The ticket's channel exists: the ticket moves under the channel's id, the watch log is checked, and the cards
    /// go up (the ticket card, who is involved, the evidence, the staff background, the log).
    pub fn channel_made(&self, note: &str, channel: &str) -> Vec<Action> {
        let d = self.data();
        let Some(number) = note.strip_prefix("ticket:") else { return Vec::new() };
        let Some(mut t) = d.get(&format!("pending:{number}")) else { return private("The ticket could not be found. Try again.") };
        d.delete(&format!("pending:{number}"));
        let now = t["createdAt"].as_i64().unwrap_or(0);
        let opener: Member = serde_json::from_value::<MemberCard>(t["openerMember"].clone()).map(Into::into).unwrap_or_default();
        let about: Option<Member> = serde_json::from_value::<MemberCard>(t["aboutMember"].clone()).ok().map(Into::into);
        if let Some(o) = t.as_object_mut() { o.remove("openerMember"); o.remove("aboutMember"); }
        let cat = self.cat_of(&t);
        let store = self.db.get();
        // does this ticket touch anyone already on the watch log? (checked before its own report is added)
        let earlier = store.watch_rows(self.guild).unwrap_or_default();
        let text = t["answers"].as_array().into_iter().flatten().filter_map(|a| a["a"].as_str()).collect::<Vec<_>>().join("\n");
        let matches = R::match_watch(&opener.id, std::slice::from_ref(&opener.name), (t["report"]["id"].as_str(), t["report"]["name"].as_str()), &text, &earlier);
        if t["report"].is_object() && t["report"]["id"].as_str() != Some(opener.id.as_str()) {
            let rid = t["report"]["id"].as_str().map(str::to_string);
            let real = about.as_ref().map(|m| R::normalize_name(&m.name));
            let tname = t["report"]["name"].as_str().map(str::to_string).or(real.clone());
            let alias = real.filter(|r| Some(r) != tname.as_ref());
            let summary = t["answers"].as_array().into_iter().flatten().find(|a| a["q"].as_str().unwrap_or("").to_lowercase().contains("happened")).and_then(|a| a["a"].as_str()).map(str::to_string);
            let evidence = t["answers"].as_array().into_iter().flatten().find(|a| a["q"].as_str().unwrap_or("").to_lowercase().contains("evidence") || a["q"].as_str().unwrap_or("").to_lowercase().contains("message links")).and_then(|a| a["a"].as_str()).map(str::to_string);
            if let Ok(id) = store.watch_add(self.guild, rid.as_deref(), tname.as_deref(), alias.as_deref(), &opener.id, t["number"].as_i64(), Some(&cat.as_ref().map(|c| c.id.clone()).unwrap_or_default()), summary.as_deref(), evidence.as_deref(), now) {
                t["report"]["watchId"] = json!(id);
            }
        }
        let flags: std::collections::BTreeSet<i64> = matches.iter().map(|m| m.0).collect();
        t["flagCount"] = json!(flags.len());
        let (opener_lines, opener_card) = self.person(Some(&opener.id), Some(&opener), Some(&opener.name), now);
        let (about_lines, about_card) = match t["report"].is_object() {
            true => { let (l, c) = self.person(t["report"]["id"].as_str(), about.as_ref(), t["report"]["name"].as_str(), now); (Some(l), c) }
            false => (None, Value::Null),
        };
        t["people"] = json!({ "opener": opener_card, "about": about_card });
        drop(store);
        self.save(channel, &t);
        self.bump("opened");
        self.db.seen().saw(self.guild, &opener.id, &opener.name);
        self.db.seen().note(self.guild, "ticket", &format!("{} opened ticket {} ({})", if opener.name.is_empty() { "A member" } else { opener.name.as_str() }, number_tag(&t), t["typeLabel"].as_str().unwrap_or("ticket")));
        let store = self.db.get();
        let _ = store.history_ensure(self.guild, &t, channel);
        let _ = store.history_details(self.guild, &t);
        drop(store);
        let roles = self.staff_roles();
        let u = R::urgency(t["priority"].as_str().unwrap_or("normal"));
        let mut control = self.control(&t);
        control.lines.insert(0, format!("<@{}> {}", opener.id, roles.iter().map(|r| format!("<@&{r}>")).collect::<Vec<_>>().join(" ")).trim().to_string());
        let mut out = private(format!("Your ticket is ready: <#{channel}>"));
        out.push(Action::Post { channel: channel.into(), card: control, note: format!("ticket-control:{channel}"), ping: vec![opener.id.clone()], roles: roles.clone() });
        // who is involved, filled in automatically (public details only)
        let mut who = Card::new(colour_area(u.0)).title("Who is involved").line(format!("**Opened by**\n{}", opener_lines.join("\n")));
        if let Some(l) = &about_lines { who = who.line(format!("**{}**\n{}", if cat.as_ref().is_some_and(|c| c.report.is_some()) { "About" } else { "Mentioned" }, l.join("\n"))); }
        if let Some(a) = about.as_ref().and_then(|m| m.avatar.clone()) { who = who.picture(Some(a)); }
        out.push(Action::Send { channel: channel.into(), card: who, ping: Vec::new(), roles: Vec::new() });
        // evidence: posted in the ticket so staff can see it, and kept on this computer
        let keep: Vec<KeepFile> = t["files"].as_array().into_iter().flatten().filter_map(|f| Some(KeepFile { name: f["name"].as_str()?.into(), url: f["url"].as_str()?.into(), size: f["size"].as_u64().unwrap_or(0), stored: f["stored"].as_str()?.into() })).collect();
        let missed: Vec<String> = t["files"].as_array().into_iter().flatten().filter_map(|f| f["error"].as_str().map(|e| format!("{} ({e})", f["name"].as_str().unwrap_or("file")))).collect();
        if !keep.is_empty() || !missed.is_empty() {
            let mut text = format!("📎 Evidence from <@{}>", opener.id);
            if !missed.is_empty() { text.push_str(&format!("\nCould not keep: {}", missed.join(", "))); }
            out.push(Action::KeepFiles { dir: format!("tickets/{}", t["number"].as_i64().unwrap_or(0)), files: keep, post: Some((channel.into(), text)) });
        }
        // the staff background, only staff see it
        let rid = t["report"]["id"].as_str().map(str::to_string);
        let opener_reports = self.db.get().watch_about(self.guild, &opener.id).unwrap_or_default().len();
        if rid.is_some() || t["report"].is_object() || opener_reports > 0 {
            let mut bg = Card::new(colour_area(u.0)).title(format!("Ticket {} · background", number_tag(&t))).line(format!("<#{channel}> · only staff see this."));
            if let Some(l) = &about_lines {
                let facts = rid.as_deref().map(|r| self.staff_facts(r)).unwrap_or_else(|| "No user ID, so no history to look up.".into());
                bg = bg.line(short(&format!("**About {}**\n{}\n{facts}", t["report"]["name"].as_str().map(|n| format!("@{n}")).unwrap_or_else(|| "them".into()), l[1..].join(" · ")), 1100));
            }
            bg = bg.line(short(&format!("**Opened by @{}**\n{}", opener.name, self.staff_facts(&opener.id)), 1100));
            out.extend(self.staff_log(bg, Vec::new()));
        }
        let urgent = if cat.as_ref().is_some_and(|c| c.urgency == "urgent") { "🚨 " } else { "" };
        out.extend(self.log(Card::new(colour_area(u.0)).title(format!("{urgent}Ticket opened")).line(format!("{} ({}) · {} · by <@{}> → <#{channel}>{}", number_tag(&t), t["typeLabel"].as_str().unwrap_or(""), u.1, opener.id, if flags.is_empty() { String::new() } else { " · ⚠️ watch-log match".into() }))));
        if !matches.is_empty() {
            let mut card = Card::new(Area::Moderation).title(format!("⚠️ Watch-log match · ticket {}", number_tag(&t))).line(format!("{}\n\nTicket: <#{channel}> - this is only shown to staff.", R::describe_matches(&matches, &earlier)));
            if !roles.is_empty() { card.lines.insert(0, roles.iter().map(|r| format!("<@&{r}>")).collect::<Vec<_>>().join(" ")); }
            out.extend(self.staff_log(card, roles));
        }
        out
    }
    pub fn channel_failed(&self, note: &str) {
        if let Some(number) = note.strip_prefix("ticket:") { self.data().delete(&format!("pending:{number}")); }
    }
    pub fn posted(&self, note: &str, message: &str) {
        if let Some(channel) = note.strip_prefix("ticket-control:") {
            if let Some(mut t) = self.ticket(channel) { t["controlMessageId"] = json!(message); self.save(channel, &t); }
        }
    }

    // ------------------------------------------------------------ closing
    /// kind: "staff" (with the close form), "owner" or "auto". Staff notes, reasons and actions go to the staff log and
    /// the history - never into the ticket channel the member can read.
    #[allow(clippy::too_many_arguments)]
    fn close(&self, channel: &str, t: &mut Value, closer: &str, kind: &str, form: Option<&std::collections::BTreeMap<&'static str, Option<String>>>, outcome: Option<&str>, reason: Option<&str>, at: i64) -> Vec<Action> {
        let hours = self.settings.int(self.guild, MODULE, "autoCloseHours");
        let fv = |k: &str| form.and_then(|f| f.get(k).cloned().flatten());
        t["status"] = json!("closed");
        t["closedBy"] = json!(closer);
        t["closedAt"] = json!(at);
        t["closeKind"] = json!(kind);
        let resolution = fv("resolution").or_else(|| match kind { "auto" => Some("Auto-closed (inactive)".into()), "owner" => Some("Closed by the member".into()), _ => None });
        let why = fv("reason").or_else(|| reason.map(str::to_string)).or_else(|| (kind == "auto").then(|| format!("No activity for {hours} hours.")));
        t["closeReason"] = json!(why);
        self.save(channel, t);
        self.bump("closed");
        let closed_by = match kind { "auto" => "automatically (nobody wrote for a while)".to_string(), "owner" => "by the member who opened it".to_string(), _ => format!("by {}", self.db.seen().name_or(self.guild, closer)) };
        self.db.seen().note(self.guild, "ticket", &format!("Ticket {} was closed {closed_by}", number_tag(t)));
        let store = self.db.get();
        let _ = store.history_close(self.guild, t, channel, &Closing { at, by: (kind != "auto").then_some(closer), kind, resolution: resolution.as_deref(), reason: why.as_deref(), action: fv("action").as_deref(), notes: fv("notes").as_deref(), followup: fv("followup").as_deref(), outcome });
        if let (Some(wid), Some(o)) = (t["report"]["watchId"].as_i64(), outcome.filter(|o| *o == "confirmed" || *o == "unfounded")) {
            let _ = store.watch_set(self.guild, wid, o, closer, why.as_deref().map(|w| short(w, 500)).as_deref(), at);
        }
        drop(store);
        let opener = t["opener"].as_str().unwrap_or("").to_string();
        let public = if kind == "auto" {
            format!("This ticket was **closed automatically** after {hours} hours without activity. Press Reopen if you still need help.")
        } else {
            format!("Closed by <@{closer}>{}{}", resolution.as_deref().map(|r| format!("\nResolution: {}", short(r, 200))).unwrap_or_default(), if kind == "owner" { why.as_deref().map(|w| format!("\nReason: {}", short(w, 500))).unwrap_or_default() } else { String::new() })
        };
        let mut out = vec![
            Action::Access { channel: channel.into(), user: opener.clone(), see: true, write: false },
            Action::Send { channel: channel.into(), card: Card::new(Area::Moderation).title("Ticket closed").line(public).button_with("ticket:reopen", "Reopen", ButtonStyle::Good, Some("🔓".into())).button_with("ticket:delete", "Delete", ButtonStyle::Danger, Some("🗑️".into())), ping: Vec::new(), roles: Vec::new() },
        ];
        let mut e = Card::new(Area::Moderation).title(format!("Ticket {} closed · {}", number_tag(t), R::close_kind_label(kind)))
            .line(format!("{} · opened by <@{opener}> · {}", t["typeLabel"].as_str().unwrap_or(""), if kind == "auto" { "closed automatically".into() } else { format!("closed by <@{closer}>") }));
        if let Some(r) = &resolution { e = e.line(format!("**Resolution**\n{}", short(r, 300))); }
        if form.is_some() {
            e = e.line(format!("**Reason**\n{}", short(&fv("reason").unwrap_or_default(), 900))).line(format!("**Action taken**\n{}", short(&fv("action").unwrap_or_default(), 700))).line(format!("**Notes**\n{}", short(&fv("notes").unwrap_or_default(), 900)));
        } else if let Some(w) = &why { e = e.line(format!("**Reason**\n{}", short(w, 900))); }
        if let Some(fu) = fv("followup") { e = e.line(format!("**⏭️ Follow-up needed**\n{}", short(&fu, 300))); }
        if let Some(o) = outcome { e = e.line(format!("**Report outcome**\n{}", if o == "inconclusive" { "Inconclusive - the watch-log entry stays open".into() } else { format!("Marked **{o}** on the watch log") })); }
        if t["decision"].is_object() { e = e.line(format!("**{} {}**\n{}", t["decision"]["word"].as_str().unwrap_or("Appeal"), t["decision"]["result"].as_str().unwrap_or(""), short(t["decision"]["reason"].as_str().unwrap_or(""), 500))); }
        // the transcript goes to the log with the close details, and to the member if the server wants
        let mut to = Vec::new();
        if let Some(log) = self.set("logChannel") { to.push(TranscriptTo::Channel { channel: log, card: Box::new(e) }); }
        if self.settings.bool(self.guild, MODULE, "dmTranscript") {
            to.push(TranscriptTo::Dm { user: opener.clone(), text: format!("Transcript of your ticket {} in **{}**:", number_tag(t), short(&self.server_name(), 60)) });
        }
        if !to.is_empty() { out.push(self.transcript(channel, t, to)); }
        // ask the member how it went (not for auto-closed tickets or ones they closed themselves)
        if self.settings.bool(self.guild, MODULE, "askRating") && kind != "auto" && closer != opener {
            let n = t["number"].as_i64().unwrap_or(0);
            let mut card = Card::new(Area::General).title("How did we do?").line(format!("Your ticket {} in **{}** was closed. How happy are you with the help you got?", number_tag(t), short(&self.server_name(), 60)));
            for k in 1..=5 { card = card.button(format!("rate:{}:{n}:{k}", self.guild), "⭐".repeat(k), if k >= 4 { ButtonStyle::Good } else if k <= 2 { ButtonStyle::Danger } else { ButtonStyle::Plain }); }
            out.push(Action::Dm { user: opener, card, or_in: None });
        }
        out
    }
    fn server_name(&self) -> String {
        self.db.get().guilds().ok().and_then(|all| all.into_iter().find(|g| g.id == self.guild)).map(|g| g.name).filter(|n| !n.is_empty()).unwrap_or_else(|| "the server".into())
    }
    fn transcript(&self, channel: &str, t: &Value, to: Vec<TranscriptTo>) -> Action {
        let head = TranscriptHead {
            number: t["number"].as_i64().unwrap_or(0), type_label: t["typeLabel"].as_str().unwrap_or("").into(), opener_tag: t["openerTag"].as_str().unwrap_or("").into(),
            guild_name: self.server_name(), summary: ticket_summary(t), format: self.set("transcriptFormat").unwrap_or_else(|| "txt".into()),
        };
        Action::Transcript { channel: channel.into(), head, to }
    }

    /// The 1-5 star buttons in the member's DM (Good Boy 3's rateTicket).
    pub fn rate(&self, number: i64, user: &str, stars: i64, now: i64) -> (String, Option<Action>) {
        if !(1..=5).contains(&stars) { return ("Pick 1 to 5 stars.".into(), None); }
        let Some((opener, claimed)) = self.db.get().history_people(self.guild, number).ok().flatten() else { return ("That isn't your ticket.".into(), None) };
        if opener != user { return ("That isn't your ticket.".into(), None); }
        let key = format!("rating:{number}");
        if self.data().get(&key).is_some() { return ("You already rated this ticket. Thank you!".into(), None); }
        self.data().set(&key, &json!({ "stars": stars, "by": user, "staff": claimed, "at": now }));
        let area = if stars >= 4 { Area::Games } else if stars <= 2 { Area::Moderation } else { Area::General };
        let log = self.log(Card::new(area).title(format!("{} rating · ticket #{number:04}", "⭐".repeat(stars as usize))).line(format!("From <@{user}>{}", claimed.map(|c| format!(" · handled by <@{c}>")).unwrap_or_default())));
        (format!("Thanks! You gave {}.", "⭐".repeat(stars as usize)), log)
    }

    // ------------------------------------------------------------ housekeeping
    /// A ticket channel was deleted by hand. If the ticket was open, nobody wrote notes: that is recorded honestly.
    pub fn channel_gone(&self, channel: &str, now: i64) -> Vec<Action> {
        let Some(t) = self.ticket(channel) else { return Vec::new() };
        self.data().delete(&format!("ticket:{channel}"));
        if t["status"] != "open" { return Vec::new(); }
        let _ = self.db.get().history_close(self.guild, &t, channel, &Closing { at: now, kind: "no-notes", reason: Some("The channel was deleted while the ticket was open."), ..Default::default() });
        self.bump("closed");
        self.log(Card::new(Area::General).title(format!("Ticket {} closed without notes", number_tag(&t))).line(format!("{} · opened by <@{}>\nIts channel was deleted while the ticket was still open, so nobody wrote close notes.", t["typeLabel"].as_str().unwrap_or(""), t["opener"].as_str().unwrap_or("")))).into_iter().collect()
    }
    /// A message in a ticket channel: kept in the archive (with its files), and the ticket's activity and first reply.
    pub fn on_message(&self, ev: &MessageEvent) -> Vec<Action> {
        let Some(mut t) = self.ticket(&ev.place.channel) else { return Vec::new() };
        let number = t["number"].as_i64().unwrap_or(0);
        let mut out = Vec::new();
        if self.settings.bool(self.guild, MODULE, "archiveTickets") {
            let files: Vec<Value> = ev.files.iter().enumerate().map(|(k, (name, _, size))| json!({ "name": safe_name(name), "stored": format!("{}-{k}-{}", ev.id, safe_name(name)), "size": size })).collect();
            let _ = self.db.get().archive_put(self.guild, number, &ev.id, &ev.place.channel, Some(&ev.author.id), &ev.author.name, ev.author.avatar.as_deref(), ev.author.bot, &ev.text, &json!([]), &json!(files), ev.at_ms);
            if !ev.files.is_empty() {
                let keep = ev.files.iter().enumerate().filter(|(_, (_, _, size))| *size <= MAX_FILE).map(|(k, (name, url, size))| KeepFile { name: safe_name(name), url: url.clone(), size: *size, stored: format!("{}-{k}-{}", ev.id, safe_name(name)) }).collect();
                out.push(Action::KeepFiles { dir: format!("tickets/{number}"), files: keep, post: None });
            }
        }
        if ev.author.bot || t["status"] != "open" { return out; }
        let mut changed = false;
        if ev.at_ms - t["lastActivity"].as_i64().unwrap_or(0) > 60_000 { t["lastActivity"] = json!(ev.at_ms); changed = true; }
        if !t["firstResponseAt"].is_i64() && t["opener"].as_str() != Some(ev.author.id.as_str()) && self.is_staff(&ev.author) { t["firstResponseAt"] = json!(ev.at_ms); changed = true; }
        if changed { self.save(&ev.place.channel, &t); }
        out
    }
    pub fn on_message_edited(&self, message: &str, text: &str, now: i64) {
        let _ = self.db.get().archive_edit(self.guild, message, text, now);
    }
    pub fn on_message_deleted(&self, message: &str) {
        let _ = self.db.get().archive_deleted(self.guild, message);
    }
}

/// The parts of a member a ticket keeps until its channel is made.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct MemberCard {
    id: String,
    name: String,
    avatar: Option<String>,
    roles: Vec<String>,
    perms: u64,
    joined_at: Option<i64>,
}
impl From<&Member> for MemberCard {
    fn from(m: &Member) -> Self {
        MemberCard { id: m.id.clone(), name: m.name.clone(), avatar: m.avatar.clone(), roles: m.roles.clone(), perms: m.perms, joined_at: m.joined_at }
    }
}
impl From<MemberCard> for Member {
    fn from(m: MemberCard) -> Self {
        Member { id: m.id, name: m.name, avatar: m.avatar, roles: m.roles, perms: m.perms, joined_at: m.joined_at, bot: false }
    }
}

fn reason_field(label: &str) -> Field {
    Field { id: "reason".into(), label: label.into(), long: true, required: true, max: 800, ..Default::default() }
}
/// The popup staff must fill in to close a ticket (the outcome, for reports, is picked first with a button).
fn close_popup(outcome: &str) -> Action {
    Action::Form { id: format!("ticket:cf:{outcome}"), title: "Close ticket".into(), fields: R::close_form_fields() }
}
/// The panel popup: the channel and wording, already filled with sensible text.
pub fn panel_fields(channel: &str) -> Vec<Field> {
    vec![
        Field { id: "channel".into(), label: "Channel for the panel".into(), kind: FieldKind::Channel(vec![0, 5]), value: Some(channel.into()), ..Default::default() },
        Field { id: "title".into(), label: "Title".into(), max: 200, value: Some("Need help?".into()), ..Default::default() },
        Field { id: "description".into(), label: "Text".into(), long: true, max: 1500, value: Some("Press the button that fits your problem. A private channel opens for you and our staff.".into()), ..Default::default() },
    ]
}

/// The clock (every half minute, Good Boy 3 every ten minutes): inactive tickets auto-close, and once a day the
/// watch log keeps to its retention.
pub fn due(db: &Db, settings: &Settings, now: i64) -> Vec<(String, Action)> {
    let rows = db.get().data_everywhere(MODULE, "ticket:").unwrap_or_default();
    let mut out = Vec::new();
    for (guild, key, mut t) in rows {
        let hours = settings.int(&guild, MODULE, "autoCloseHours");
        if !R::inactive(&t, now, hours) { continue; }
        let tickets = Tickets { db, settings, guild: &guild };
        let channel = &key["ticket:".len()..];
        out.extend(tickets.close(channel, &mut t, "", "auto", None, None, None, now).into_iter().map(|a| (guild.clone(), a)));
    }
    // watch-log retention, at most once a day per server
    let guilds: std::collections::BTreeSet<String> = db.get().data_everywhere(MODULE, "counter").unwrap_or_default().into_iter().map(|(g, _, _)| g).collect();
    for g in guilds {
        let d = Data { db, guild: &g, module: MODULE };
        if now - d.get("lastPurge").and_then(|v| v.as_i64()).unwrap_or(0) > 86_400_000 {
            d.set("lastPurge", &json!(now));
            let (watch, unfounded) = (settings.int(&g, MODULE, "watchRetentionDays"), settings.int(&g, MODULE, "unfoundedRetentionDays"));
            let _ = db.get().watch_purge(&g, now, watch, unfounded);
        }
    }
    out
}

/// One message for a transcript.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TranscriptMsg {
    pub at_ms: i64,
    pub author_tag: String,
    pub avatar: Option<String>,
    pub content: String,
    /// (file name, link)
    pub files: Vec<(String, String)>,
    /// What the message's boxes (cards) say, as plain text.
    pub boxes: Vec<String>,
}
fn iso_minute(ms: i64) -> String {
    let secs = ms.rem_euclid(86_400_000) / 1000;
    format!("{} {:02}:{:02}", crate::time::date(ms), secs / 3600, secs / 60 % 60)
}
fn html_esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&#39;")
}
/// The transcript file, in Good Boy 3's txt format or its HTML add-on's format: (file name, contents).
pub fn transcript_file(head: &TranscriptHead, msgs: &[TranscriptMsg]) -> (String, Vec<u8>) {
    if head.format == "html" {
        let rows: Vec<String> = msgs.iter().map(|m| {
            let files: String = m.files.iter().map(|(n, u)| format!(r#"<div class="att">📎 <a href="{}">{}</a></div>"#, html_esc(u), html_esc(n))).collect();
            let boxes: String = m.boxes.iter().map(|t| format!(r#"<div class="box">{}</div>"#, html_esc(t))).collect();
            format!(r#"<div class="msg"><img src="{}" alt=""><div><b>{}</b> <span class="t">{} UTC</span><div class="c">{}</div>{files}{boxes}</div></div>"#, html_esc(m.avatar.as_deref().unwrap_or("")), html_esc(&m.author_tag), iso_minute(m.at_ms), html_esc(&m.content))
        }).collect();
        let why = if head.summary.is_empty() { String::new() } else {
            format!(r#"<section class="why"><h2>Why this ticket was opened</h2><dl>{}</dl></section>"#, head.summary.iter().map(|(l, v)| format!("<dt>{}</dt><dd>{}</dd>", html_esc(l), html_esc(v))).collect::<String>())
        };
        let html = format!(r#"<!doctype html><html><head><meta charset="utf-8"><title>Ticket #{n}</title><style>
body{{background:#1e1f22;color:#dbdee1;font:14px system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px}}
h1{{font-size:20px}}.meta{{color:#949ba4;margin-bottom:16px}}.msg{{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #2b2d31}}
.msg img{{width:36px;height:36px;border-radius:50%;background:#2b2d31}}.t{{color:#949ba4;font-size:12px}}.c{{white-space:pre-wrap;word-break:break-word}}
.att{{font-size:13px;margin-top:4px}}a{{color:#00a8fc}}
.box{{white-space:pre-wrap;border-left:3px solid #5865f2;background:#2b2d31;border-radius:4px;padding:8px 10px;margin-top:6px}}
.why{{background:#2b2d31;border-radius:8px;padding:12px 16px;margin-bottom:18px}}.why h2{{font-size:15px;margin:0 0 8px}}
.why dl{{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}}.why dt{{color:#949ba4}}.why dd{{margin:0;white-space:pre-wrap;word-break:break-word}}</style></head><body>
<h1>Ticket #{n} · {label}</h1>
<div class="meta">{guild} · opened by {opener} · {count} message(s)</div>
{why}
{rows}
</body></html>"#, n = head.number, label = html_esc(&head.type_label), guild = html_esc(&head.guild_name), opener = html_esc(&head.opener_tag), count = msgs.len(), rows = rows.join("\n"));
        return (format!("ticket-{:03}.html", head.number), html.into_bytes());
    }
    let mut lines = vec![format!("Ticket #{} ({}) - {}", head.number, head.type_label, head.guild_name), String::new(), "WHY THIS TICKET WAS OPENED".into()];
    lines.extend(head.summary.iter().map(|(l, v)| format!("{l}: {v}")));
    lines.push("-".repeat(60));
    for m in msgs {
        let boxes: String = m.boxes.iter().map(|t| format!("\n    {}", t.replace('\n', "\n    "))).collect();
        let files = if m.files.is_empty() { String::new() } else { format!(" {}", m.files.iter().map(|(_, u)| u.as_str()).collect::<Vec<_>>().join(" ")) };
        lines.push(format!("[{}] {}: {}{files}{boxes}", iso_minute(m.at_ms), m.author_tag, m.content));
    }
    lines.push(String::new());
    (format!("ticket-{:03}.txt", head.number), lines.join("\n").into_bytes())
}
