//! Member management, as Good Boy 3's `member-management` module: welcome and goodbye messages (with a picture),
//! welcome-back roles, the verification panel and captcha, profile roles, introductions, birthdays and AFK.
//! Settings, data and wording are Good Boy 3's, so a server's setup carries over.

use crate::bot::{CommandSpec, Directory, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::roles::grant_problem;
use crate::settings::Fallback;
use crate::store::Data;
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Def, Field, FieldKind, FormEvent, KeepFile, Kind, Member, MessageEvent, Settings};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub const MODULE: &str = "member-management";
pub const MANAGE: Perm = Perm { key: "member-management.manage", level: Level::Admin };
pub static SETTINGS: &[Def] = &[
    Def { key: "welcomeEnabled", label: "Send welcome messages", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "welcomeChannel", label: "Welcome channel", kind: Kind::Channel, default: Fallback::None },
    Def { key: "welcomeMessage", label: "Welcome message ({user} {username} {server} {count})", kind: Kind::Text { max_len: 1900 }, default: Fallback::Str("Welcome {user} to **{server}**! You are member #{count}.") },
    Def { key: "restoreRoles", label: "Welcome back: give members their roles back if they leave and rejoin (never staff roles)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "restoreRolesDays", label: "Welcome back: remember roles for this many days", kind: Kind::Number { min: 1, max: 3650 }, default: Fallback::Int(180) },
    Def { key: "goodbyeEnabled", label: "Send goodbye messages", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "goodbyeChannel", label: "Goodbye channel", kind: Kind::Channel, default: Fallback::None },
    Def { key: "goodbyeMessage", label: "Goodbye message ({username} {server} {count})", kind: Kind::Text { max_len: 1900 }, default: Fallback::Str("**{username}** has left the server.") },
    Def { key: "welcomeImage", label: "Welcome picture (set with /greeting image)", kind: Kind::Text { max_len: 200 }, default: Fallback::Str("") },
    Def { key: "goodbyeImage", label: "Goodbye picture (set with /greeting image)", kind: Kind::Text { max_len: 200 }, default: Fallback::Str("") },
    Def { key: "verificationRole", label: "Role given after verifying", kind: Kind::Role, default: Fallback::None },
    Def { key: "unverifiedRole", label: "Role new members get until verified (optional)", kind: Kind::Role, default: Fallback::None },
    Def { key: "verifyCaptcha", label: "Captcha: members type a code from a picture to verify (stops bot accounts)", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "verifyMessage", label: "Verification panel text", kind: Kind::Text { max_len: 1500 }, default: Fallback::Str("Press the button below to verify and unlock the server.") },
    Def { key: "verifyChannel", label: "Channel holding the verification panel", kind: Kind::Channel, default: Fallback::None },
    Def { key: "profilesEnabled", label: "Custom profile roles", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "profileAllowName", label: "Members may set a name", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "profileAllowColor", label: "Members may set a color", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "profileHoist", label: "Show profile roles separately in the member list", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "profileAllowedColors", label: "Allowed colors (hex, empty = any)", kind: Kind::List, default: Fallback::None },
    Def { key: "profileAnchorRole", label: "Place profile roles just below this role", kind: Kind::Role, default: Fallback::None },
    Def { key: "introChannel", label: "Introductions channel", kind: Kind::Channel, default: Fallback::None },
    Def { key: "birthdayChannel", label: "Birthday announcements channel", kind: Kind::Channel, default: Fallback::None },
    Def { key: "birthdayRole", label: "Role for the birthday person (optional)", kind: Kind::Role, default: Fallback::None },
    Def { key: "birthdayMessage", label: "Birthday message", kind: Kind::Text { max_len: 1900 }, default: Fallback::Str("Happy birthday {user}! 🎂") },
    Def { key: "timezoneOffset", label: "Server timezone offset from UTC (hours)", kind: Kind::Number { min: -12, max: 14 }, default: Fallback::Int(0) },
    Def { key: "afkEnabled", label: "AFK status", kind: Kind::Toggle, default: Fallback::Bool(true) },
];

const fn opt(name: &'static str, about: &'static str, takes: Takes, required: bool) -> Opt {
    Opt { name, about, takes, required }
}
pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec { name: "greeting", about: "(Staff) Add a picture to welcome or goodbye messages (opens a form)", module: MODULE, options: &[], subs: &[] },
    CommandSpec { name: "verify", about: "Verification gate", module: MODULE, options: &[], subs: &[
        Sub { name: "setup", about: "Set the roles and post the verification panel", options: &[
            opt("role", "Role members get after verifying (leave everything empty for a popup)", Takes::Role, false),
            opt("unverified", "Role new members hold until verified (optional)", Takes::Role, false),
            opt("channel", "Where to post the panel", Takes::Channel, false),
            opt("message", "Text shown on the panel", Takes::Text, false),
        ] },
        Sub { name: "panel", about: "Post a verification panel", options: &[opt("channel", "Where to post it", Takes::Channel, false)] },
        Sub { name: "repost", about: "Replace the panel (keeps all settings)", options: &[opt("channel", "Move it to this channel", Takes::Channel, false)] },
        Sub { name: "status", about: "Check that verification is working", options: &[] },
        Sub { name: "reset", about: "Remove the panel", options: &[opt("confirm", "Required: yes, remove it", Takes::YesNo, false), opt("settings", "Also forget the roles and channel", Takes::YesNo, false)] },
    ] },
    CommandSpec { name: "profile", about: "Your personal name and color role", module: MODULE, options: &[], subs: &[
        Sub { name: "setup", about: "Create your profile role", options: &[opt("name", "Name for your role", Takes::Text, false), opt("color", "Hex color, e.g. #FF69B4", Takes::Text, false), opt("colour", "Or pick a colour from a list", Takes::Choice(crate::colours::CHOICES), false)] },
        Sub { name: "edit", about: "Change your profile role", options: &[opt("name", "New name", Takes::Text, false), opt("color", "New hex color", Takes::Text, false), opt("colour", "Or pick a new colour from a list", Takes::Choice(crate::colours::CHOICES), false)] },
        Sub { name: "remove", about: "Delete your profile role", options: &[] },
        Sub { name: "view", about: "Look at a profile", options: &[opt("user", "Whose", Takes::Member, false)] },
    ] },
    CommandSpec { name: "introduce", about: "Post (or update) your introduction", module: MODULE, options: &[], subs: &[] },
    CommandSpec { name: "birthday", about: "Birthdays", module: MODULE, options: &[], subs: &[
        Sub { name: "set", about: "Save your birthday", options: &[opt("month", "1-12", Takes::Whole { min: 1, max: 12 }, true), opt("day", "1-31", Takes::Whole { min: 1, max: 31 }, true)] },
        Sub { name: "remove", about: "Forget your birthday", options: &[] },
        Sub { name: "upcoming", about: "Next birthdays in this server", options: &[] },
    ] },
    CommandSpec { name: "afk", about: "Mark yourself away", module: MODULE, options: &[opt("reason", "Why you are away", Takes::Text, false)], subs: &[] },
];

const DAYS: [i64; 12] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const PANEL_KEY: &str = "verify:panel";
const CAPTCHA_MS: i64 = 10 * 60_000;
const CAPTCHA_TRIES: u32 = 3;
/// Captcha letters: ones that look alike (0/O, 1/I/l, 5/S, 2/Z, 8/B) are left out, as in Good Boy 3.
pub const ALPHABET: &str = "ACDEFGHJKMNPQRTUVWXY34679";
pub const CODE_LENGTH: usize = 5;
/// Most a picture may weigh.
pub const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
fn greet_kind(kind: &str) -> Option<&'static str> { match kind { "welcome" => Some("welcome"), "goodbye" => Some("goodbye"), _ => None } }
/// The picture's file type, from its name and from what is really inside (a renamed file is not a picture).
pub fn image_ext(name: &str, bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.is_empty() { return Err("That file is empty.".into()); }
    if bytes.len() > MAX_IMAGE_BYTES { return Err("That picture is too big. Use one under 8 MB.".into()); }
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if !GREET_IMAGE_TYPES.contains(&ext.as_str()) { return Err("Use a PNG, JPG, GIF or WebP picture.".into()); }
    let real = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) { "png" } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) { "jpg" } else if bytes.starts_with(b"GIF8") { "gif" } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" { "webp" } else { return Err("That file is not a picture Good Boy can use. Use a PNG, JPG, GIF or WebP.".into()) };
    Ok(real)
}
pub const GREET_IMAGE_TYPES: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}
fn ts(ms: i64) -> String {
    format!("<t:{}:R>", ms.div_euclid(1000))
}

/// Puts a member's details into a message (Good Boy 3's fillTemplate): only these four words; anything else is left.
pub fn fill(template: &str, member: &Member, server: &str, count: Option<u64>) -> String {
    let filled = template
        .replace("{user}", &format!("<@{}>", member.id))
        .replace("{username}", &member.name)
        .replace("{server}", server)
        .replace("{count}", &count.map(|n| n.to_string()).unwrap_or_else(|| "?".into()));
    filled.chars().take(1900).collect()
}
/// Good Boy 3's sanitizeName: no control characters, no @ # or backticks, single spaces, up to `max`.
pub fn sanitize_name(s: &str, max: usize) -> String {
    let cleaned: String = s.chars().filter(|c| !c.is_control() && !matches!(c, '@' | '#' | '`')).collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}
/// "#ff69b4", "FF69B4" → "#FF69B4" (Good Boy 3's normalizeHex).
pub fn normalize_hex(s: &str) -> Option<String> {
    let t = s.trim();
    let t = t.strip_prefix('#').unwrap_or(t);
    (t.len() == 6 && t.bytes().all(|b| b.is_ascii_hexdigit())).then(|| format!("#{}", t.to_ascii_uppercase()))
}
/// Is the typed answer the code? Case and spaces don't matter.
pub fn code_matches(typed: &str, code: &str) -> bool {
    typed.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_uppercase() == code
}
/// The code as spaced-out full-width letters (Good Boy 3's text fallback).
pub fn code_text(code: &str) -> String {
    code.chars().map(|c| char::from_u32(c as u32 + 0xfee0).unwrap_or(c).to_string()).collect::<Vec<_>>().join(" ")
}
fn leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// Things kept in memory, as Good Boy 3 keeps them: a restart just means pressing the button again.
#[derive(Default)]
struct Memory {
    /// guild:user → (code, made at, tries)
    captchas: HashMap<String, (String, i64, u32)>,
    /// user → last press of Verify me
    clicks: HashMap<String, i64>,
    /// channel:user → when the AFK notice was last given
    afk_notice: HashMap<String, i64>,
}
fn memory() -> std::sync::MutexGuard<'static, Memory> {
    static M: OnceLock<Mutex<Memory>> = OnceLock::new();
    M.get_or_init(Mutex::default).lock().unwrap_or_else(|p| p.into_inner())
}

pub struct Members<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub dir: &'a Directory,
    pub guild: &'a str,
    pub server: &'a str,
}
impl Members<'_> {
    fn data(&self) -> Data<'_> {
        Data { db: self.db, guild: self.guild, module: MODULE }
    }
    fn text(&self, key: &str) -> Option<String> {
        self.settings.text(self.guild, MODULE, key).filter(|s| !s.is_empty())
    }
    fn on(&self, key: &str) -> bool {
        self.settings.bool(self.guild, MODULE, key)
    }
    fn set(&self, key: &str, v: Value) {
        let _ = self.settings.set(self.guild, MODULE, key, &v);
    }
    fn role_name(&self, role: &str) -> String {
        self.dir.role(self.guild, role).map(|r| r.name).unwrap_or_else(|| "a deleted role".into())
    }
    /// Where Good Boy 3 keeps the welcome and goodbye pictures: files/member-management/<server>/greetings.
    fn greet_dir(&self) -> Option<std::path::PathBuf> {
        let base = self.db.get().path().parent()?.to_path_buf();
        Some(base.join("files").join(MODULE).join(self.guild).join("greetings"))
    }

    /// The welcome or goodbye picture as it is kept: its file name and bytes. None when there is none (or it is gone).
    pub fn greeting_image(&self, kind: &str) -> Option<(String, Vec<u8>)> {
        let name = self.text(&format!("{}Image", greet_kind(kind)?))?;
        let bytes = std::fs::read(self.greet_dir()?.join(&name)).ok()?;
        Some((name, bytes))
    }
    /// Keeps a picture for welcome or goodbye messages (from the launcher: the same rules as `/greeting image`).
    pub fn greeting_image_set(&self, kind: &str, name: &str, bytes: &[u8], at_ms: i64) -> Result<(), String> {
        let kind = greet_kind(kind).ok_or("Pick welcome or goodbye.")?;
        let ext = image_ext(name, bytes)?;
        let dir = self.greet_dir().ok_or("The data folder is not ready yet.")?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("The picture could not be saved ({e})."))?;
        let stored = format!("{kind}-{at_ms}.{ext}");
        std::fs::write(dir.join(&stored), bytes).map_err(|e| format!("The picture could not be saved ({e})."))?;
        if let Some(old) = self.text(&format!("{kind}Image")) { if old != stored { let _ = std::fs::remove_file(dir.join(old)); } }
        self.set(&format!("{kind}Image"), json!(stored));
        Ok(())
    }
    /// Takes the picture away: those messages are plain text again.
    pub fn greeting_image_clear(&self, kind: &str) -> Result<(), String> {
        let kind = greet_kind(kind).ok_or("Pick welcome or goodbye.")?;
        if let (Some(dir), Some(old)) = (self.greet_dir(), self.text(&format!("{kind}Image"))) { let _ = std::fs::remove_file(dir.join(old)); }
        self.set(&format!("{kind}Image"), json!(""));
        Ok(())
    }

    // ------------------------------------------------------------------ welcome / goodbye
    /// A welcome or goodbye message: plain text, or with the server's picture a card with the member's avatar.
    pub fn greeting(&self, kind: &str, member: &Member, text: String) -> Card {
        let picture = self.text(&format!("{kind}Image")).and_then(|name| {
            let bytes = std::fs::read(self.greet_dir()?.join(&name)).ok()?;
            Some((name, bytes))
        });
        match picture {
            None => Card::new(Area::General).line(text),
            Some((name, bytes)) => {
                let mention = if kind == "welcome" { format!("<@{}>\n", member.id) } else { String::new() };
                Card::new(Area::General).line(format!("{mention}{text}")).picture(member.avatar.clone()).file(&name, bytes)
            }
        }
    }
    /// Good Boy 3's rolesToRemember: everything but @everyone, the waiting role and roles it may not hand out.
    fn to_remember(&self, member: &Member) -> Vec<String> {
        let waiting = self.text("unverifiedRole");
        member.roles.iter().filter(|r| r.as_str() != self.guild && Some(r.as_str()) != waiting.as_deref() && grant_problem(self.dir, self.guild, r, None).is_none()).cloned().collect()
    }
    pub fn on_join(&self, member: &Member, count: Option<u64>, now: i64) -> Vec<Action> {
        let mut out = Vec::new();
        // welcome back: the roles they had, when they left recently enough
        let mut back = false;
        if self.on("restoreRoles") && !member.bot {
            let d = self.data();
            let saved = d.get(&format!("left:{}", member.id));
            d.delete(&format!("left:{}", member.id));
            if let Some(saved) = saved {
                let days = self.settings.int(self.guild, MODULE, "restoreRolesDays");
                if now - saved["at"].as_i64().unwrap_or(0) <= days * 86_400_000 {
                    let roles: Vec<String> = saved["roles"].as_array().into_iter().flatten().filter_map(|r| r.as_str()).filter(|r| grant_problem(self.dir, self.guild, r, None).is_none()).map(str::to_string).collect();
                    if !roles.is_empty() {
                        back = true;
                        out.push(Action::Roles { user: member.id.clone(), add: roles, remove: Vec::new(), reason: "Welcome back: roles they had before leaving".into() });
                    }
                }
            }
        }
        // someone who got their roles back was verified before, so they don't get the waiting role again
        if let (false, Some(waiting), Some(_)) = (back, self.text("unverifiedRole"), self.text("verificationRole")) {
            out.push(Action::Roles { user: member.id.clone(), add: vec![waiting], remove: Vec::new(), reason: "Awaiting verification".into() });
        }
        if self.on("welcomeEnabled") {
            if let Some(channel) = self.text("welcomeChannel") {
                let text = fill(&self.text("welcomeMessage").unwrap_or_default(), member, self.server, count);
                out.push(Action::Send { channel, card: self.greeting("welcome", member, text), ping: vec![member.id.clone()], roles: Vec::new() });
            }
        }
        out
    }
    pub fn on_leave(&self, member: &Member, count: Option<u64>, now: i64) -> Vec<Action> {
        let mut out = Vec::new();
        let d = self.data();
        if self.on("restoreRoles") && !member.bot {
            let roles = self.to_remember(member);
            if !roles.is_empty() { d.set(&format!("left:{}", member.id), &json!({ "roles": roles, "at": now })); }
        }
        if let Some(role) = d.get(&format!("profile:{}", member.id)).and_then(|p| p["roleId"].as_str().map(str::to_string)) {
            out.push(Action::DeleteRole { role, reason: "Member left".into() });
            d.delete(&format!("profile:{}", member.id));
        }
        d.delete(&format!("afk:{}", member.id));
        if self.on("goodbyeEnabled") {
            if let Some(channel) = self.text("goodbyeChannel") {
                let text = fill(&self.text("goodbyeMessage").unwrap_or_default(), member, self.server, count);
                out.push(Action::Send { channel, card: self.greeting("goodbye", member, text), ping: Vec::new(), roles: Vec::new() });
            }
        }
        out
    }

    // ------------------------------------------------------------------ commands
    pub fn command(&self, ev: &CommandEvent, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        let arg = |k: &str| ev.args.get(k).map(String::as_str).filter(|s| !s.trim().is_empty());
        let may = |p: Perm| perms::allowed(self.db, self.guild, &ev.member, p);
        let no = || private(format!("You don't have permission for that (`{}`).", MANAGE.key));
        let d = self.data();
        let _ = roll;
        match (ev.name.as_str(), ev.sub.as_deref().unwrap_or("")) {
            ("greeting", _) => {
                if !may(MANAGE) { return no(); }
                vec![Action::Form { id: "greet:image".into(), title: "Welcome and goodbye pictures".into(), fields: vec![
                    Field { id: "message".into(), label: "Which message".into(), kind: FieldKind::Select(vec![("Welcome message".into(), "welcome".into()), ("Goodbye message".into(), "goodbye".into())]), required: true, value: Some("welcome".into()), ..Default::default() },
                    Field { id: "image".into(), label: "Picture (leave empty to remove it)".into(), desc: Some("PNG, JPG, GIF or WebP, under 8 MB.".into()), kind: FieldKind::Files { most: 1 }, ..Default::default() },
                ] }]
            }
            ("verify", sub) => {
                if !may(MANAGE) { return no(); }
                self.verify(ev, sub)
            }
            ("profile", sub) => self.profile(ev, sub),
            ("introduce", _) => {
                if self.text("introChannel").is_none() { return private("An admin needs to set the introductions channel first."); }
                vec![Action::Form { id: "intro:submit".into(), title: "Introduce yourself".into(), fields: vec![
                    Field { id: "about".into(), label: "About you".into(), long: true, required: true, max: 800, ..Default::default() },
                    Field { id: "interests".into(), label: "Interests".into(), max: 200, ..Default::default() },
                    Field { id: "fun".into(), label: "A fun fact".into(), max: 200, ..Default::default() },
                ] }]
            }
            ("birthday", "set") => {
                let (m, day) = (arg("month").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0), arg("day").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0));
                if !(1..=12).contains(&m) || day < 1 || day > DAYS[(m - 1) as usize] { return private("That date doesn't exist."); }
                d.set(&format!("bday:{}", ev.member.id), &json!({ "m": m, "d": day }));
                private(format!("🎂 Saved: **{m}/{day}**. Only the month and day are stored."))
            }
            ("birthday", "remove") => {
                d.delete(&format!("bday:{}", ev.member.id));
                private("Your birthday was removed.")
            }
            ("birthday", _) => {
                let (y, m, day) = self.local_date(ev.at_ms);
                let today = crate::time::days_from_civil(y, m, day);
                let mut list: Vec<(i64, String, i64, i64)> = d.list("bday:").into_iter().filter_map(|(k, v)| {
                    let (bm, bd) = (v["m"].as_i64()?, v["d"].as_i64()?);
                    let mut t = crate::time::days_from_civil(y, bm, bd);
                    if t < today { t = crate::time::days_from_civil(y + 1, bm, bd); }
                    Some((t, k[5..].to_string(), bm, bd))
                }).collect();
                list.sort();
                let lines: Vec<String> = list.iter().take(10).map(|(_, id, bm, bd)| format!("<@{id}> - {bm}/{bd}")).collect();
                vec![Action::Reply { card: Card::new(Area::General).title("Upcoming birthdays").line(if lines.is_empty() { "No birthdays saved yet. Use `/birthday set`.".to_string() } else { lines.join("\n") }).private() }]
            }
            ("afk", _) => {
                if !self.on("afkEnabled") { return private("AFK is turned off here."); }
                let reason = arg("reason").unwrap_or("AFK").replace(['\r', '\n'], " ");
                let reason = short(&reason, 200);
                d.set(&format!("afk:{}", ev.member.id), &json!({ "reason": reason, "since": ev.at_ms }));
                private(format!("You're AFK: {reason}"))
            }
            _ => private("That command is not here."),
        }
    }

    /// The server's date now, with its timezone offset (Good Boy 3's localNow).
    fn local_date(&self, now: i64) -> (i64, i64, i64) {
        let off = self.settings.int(self.guild, MODULE, "timezoneOffset");
        crate::time::civil((now + off * 3_600_000).div_euclid(86_400_000))
    }

    // ------------------------------------------------------------------ verification
    /// What would stop verification working (Good Boy 3's verifyProblems).
    fn verify_problems(&self) -> Vec<String> {
        let mut out = Vec::new();
        match self.text("verificationRole") {
            None => out.push("No verification role is set (`/verify setup`).".into()),
            Some(r) if self.dir.role(self.guild, &r).is_none() => out.push("The verification role was deleted - run `/verify setup` again.".into()),
            Some(r) => out.extend(grant_problem(self.dir, self.guild, &r, None)),
        }
        if let Some(un) = self.text("unverifiedRole") {
            if self.dir.role(self.guild, &un).is_none() { out.push("The \"unverified\" role was deleted.".into()); } else if let Some(p) = grant_problem(self.dir, self.guild, &un, None) { out.push(format!("Unverified role: {p}")); }
        }
        // the panel needs these in its channel (checked server-wide: a channel's own rules can still say no)
        if let Some(power) = self.dir.my_power(self.guild).filter(|p| p & crate::perms::ADMINISTRATOR == 0) {
            let missing: Vec<&str> = [(1u64 << 10, "View Channel"), (1 << 11, "Send Messages"), (1 << 14, "Embed Links")].iter().filter(|(bit, _)| power & bit == 0).map(|(_, n)| *n).collect();
            if !missing.is_empty() { out.push(format!("I'm missing **{}** permission, so I can't post the verification panel. Give my role that in Server Settings > Roles.", missing.join("**, **"))); }
        }
        out
    }
    fn panel_card(&self) -> Card {
        Card::new(Area::General).title("Verify to enter").line(short(&self.text("verifyMessage").unwrap_or_default(), 1500)).button_with("verify:go", "Verify me", ButtonStyle::Good, Some("✅".into()))
    }
    /// Posts the panel (and takes the old one down). The panel's place is kept once Discord says where it is.
    fn post_panel(&self, channel: &str, by: &str) -> Result<Vec<Action>, Vec<Action>> {
        let problems = self.verify_problems();
        if !problems.is_empty() { return Err(private(format!("Verification isn't ready:\n- {}", problems.join("\n- ")))); }
        let mut out = vec![Action::Post { channel: channel.into(), card: self.panel_card(), note: format!("verify:panel:{channel}:{by}"), ping: Vec::new(), roles: Vec::new() }];
        if let Some(old) = self.data().get(PANEL_KEY) {
            if let (Some(c), Some(m)) = (old["channelId"].as_str(), old["messageId"].as_str()) { out.push(Action::Delete { channel: c.into(), message: m.into() }); }
        }
        self.set("verifyChannel", json!(channel));
        Ok(out)
    }
    fn verify(&self, ev: &CommandEvent, sub: &str) -> Vec<Action> {
        let arg = |k: &str| ev.args.get(k).map(String::as_str).filter(|s| !s.trim().is_empty());
        let d = self.data();
        let stored = d.get(PANEL_KEY);
        match sub {
            "setup" => {
                let Some(role) = arg("role") else {
                    if ev.from_form && ev.args.contains_key("role") { return private("Choose the role members get after verifying."); }
                    return vec![Action::Form { id: format!("verify:form:{}", ev.member.id), title: "Set up verification".into(), fields: vec![
                        Field { id: "role".into(), label: "Role members get after verifying".into(), kind: FieldKind::Role { most: 1 }, required: true, ..Default::default() },
                        Field { id: "unverified".into(), label: "Role new members hold until then (optional)".into(), kind: FieldKind::Role { most: 1 }, ..Default::default() },
                        Field { id: "channel".into(), label: "Channel for the Verify button".into(), kind: FieldKind::Channel(vec![0, 5]), required: true, value: Some(ev.place.channel.clone()), ..Default::default() },
                        Field { id: "message".into(), label: "Text on the panel (optional)".into(), long: true, max: 1500, value: self.text("verifyMessage"), ..Default::default() },
                    ] }];
                };
                if let Some(p) = grant_problem(self.dir, self.guild, role, Some(&ev.member)) { return private(p); }
                let unverified = arg("unverified");
                if let Some(u) = unverified { if let Some(p) = grant_problem(self.dir, self.guild, u, Some(&ev.member)) { return private(format!("Unverified role: {p}")); } }
                self.set("verificationRole", json!(role));
                if let Some(u) = unverified { self.set("unverifiedRole", json!(u)); }
                if let Some(m) = arg("message") { self.set("verifyMessage", json!(short(m, 1500))); }
                let channel = arg("channel").map(str::to_string).or_else(|| self.text("verifyChannel")).unwrap_or_else(|| ev.place.channel.clone());
                let mut out = match self.post_panel(&channel, &ev.member.id) { Ok(a) => a, Err(no) => return no };
                let lose = unverified.map(|u| format!(" and lose **{}**", self.role_name(u))).unwrap_or_default();
                let name = self.role_name(role);
                out.insert(0, Action::Reply { card: Card::new(Area::General).line(format!("✅ Verification is set up. Panel posted in <#{channel}>.\nMembers who press the button get **{name}**{lose}.\n⚠️ Remember to hide your other channels from @everyone and show them to **{name}**, otherwise verification isn't a gate.")).private() });
                out
            }
            "panel" | "repost" => {
                let channel = arg("channel").map(str::to_string).or_else(|| (sub == "repost").then(|| stored.as_ref().and_then(|s| s["channelId"].as_str().map(str::to_string))).flatten()).unwrap_or_else(|| ev.place.channel.clone());
                let mut out = match self.post_panel(&channel, &ev.member.id) { Ok(a) => a, Err(no) => return no };
                out.insert(0, Action::Reply { card: Card::new(Area::General).line(format!("✅ Panel {} in <#{channel}>.\nYour role settings were not changed.", if sub == "repost" { "reposted" } else { "posted" })).private() });
                out
            }
            "status" => {
                let role = self.text("verificationRole").map(|r| format!("<@&{r}>")).unwrap_or_else(|| "*not set*".into());
                let un = self.text("unverifiedRole").map(|r| format!("<@&{r}>")).unwrap_or_else(|| "*none*".into());
                let panel = match &stored {
                    Some(s) => format!("✅ [live panel](https://discord.com/channels/{}/{}/{}) in <#{}>", self.guild, s["channelId"].as_str().unwrap_or(""), s["messageId"].as_str().unwrap_or(""), s["channelId"].as_str().unwrap_or("")),
                    None => "*no panel posted*".into(),
                };
                let problems = self.verify_problems();
                let checks = if problems.is_empty() { "✅ everything looks right".to_string() } else { short(&problems.iter().map(|p| format!("❌ {p}")).collect::<Vec<_>>().join("\n"), 1000) };
                let count = d.get("verify:count").and_then(|v| v.as_i64()).unwrap_or(0);
                vec![Action::Reply { card: Card::new(Area::General).title("Verification status").line(format!("**Verified role** {role}\n**Unverified role** {un}\n**Panel** {panel}\n**Members verified** {count}\n**Checks**\n{checks}")).private() }]
            }
            _ => {
                if arg("confirm") != Some("true") { return private("This removes the verification panel. Run it again with `confirm:true`. Add `settings:true` to also forget the roles and channel."); }
                let mut out = Vec::new();
                if let Some(old) = stored {
                    if let (Some(c), Some(m)) = (old["channelId"].as_str(), old["messageId"].as_str()) { out.push(Action::Delete { channel: c.into(), message: m.into() }); }
                    d.delete(PANEL_KEY);
                }
                let forget = arg("settings") == Some("true");
                if forget { for k in ["verificationRole", "unverifiedRole", "verifyChannel"] { self.set(k, Value::Null); } }
                out.insert(0, private(format!("Panel removed.{}", if forget { " Roles and channel were cleared too." } else { " Your role settings were kept - use `/verify panel` to post a new one." })).remove(0));
                out
            }
        }
    }
    /// Verify me, Type the code (Good Boy 3's verifyClick and captchaEnter).
    pub fn press(&self, ev: &ButtonEvent, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        let key = format!("{}:{}", self.guild, ev.member.id);
        if ev.id == "verify:enter" {
            if !memory().captchas.contains_key(&key) { return private("That code ran out. Press **Verify me** again for a new one."); }
            return vec![Action::Form { id: "verify:code".into(), title: "Verification code".into(), fields: vec![Field { id: "code".into(), label: "The code from the picture".into(), required: true, max: 12, ..Default::default() }] }];
        }
        {
            let mut m = memory();
            if ev.at_ms - m.clicks.get(&ev.member.id).copied().unwrap_or(0) < 3000 { return private("Easy - one moment between clicks."); }
            m.clicks.insert(ev.member.id.clone(), ev.at_ms);
        }
        let Some(role) = self.text("verificationRole").filter(|r| self.dir.role(self.guild, r).is_some()) else { return private("Verification is not set up right now. Tell an admin to run `/verify status`.") };
        if ev.member.roles.contains(&role) { return private("You're already verified."); }
        if grant_problem(self.dir, self.guild, &role, None).is_some() { return private("Verification is misconfigured right now. Tell an admin to run `/verify status`."); }
        if self.on("verifyCaptcha") {
            let code: String = (0..CODE_LENGTH).map(|_| ALPHABET.as_bytes()[roll(0, ALPHABET.len() as i64 - 1).clamp(0, ALPHABET.len() as i64 - 1) as usize] as char).collect();
            memory().captchas.insert(key, (code.clone(), ev.at_ms, 0));
            let seed = roll(0, i64::MAX / 2) as u64;
            let png = gb_art::captcha(&code, seed);
            let mut card = Card::new(Area::General).title("🔐 One quick check")
                .line(if png.is_some() { "Type the code in the picture. Capitals or not, both are fine.".to_string() } else { format!("Type this code: **{}**", code_text(&code)) })
                .line(format!("-# {CAPTCHA_TRIES} tries · 10 minutes"))
                .button_with("verify:enter", "Type the code", ButtonStyle::Primary, Some("⌨️".into()))
                .private();
            if let Some(p) = png { card = card.file("code.png", p); }
            return vec![Action::Reply { card }];
        }
        self.grant(&ev.member, &role)
    }
    fn grant(&self, member: &Member, role: &str) -> Vec<Action> {
        let remove: Vec<String> = self.text("unverifiedRole").filter(|u| member.roles.contains(u)).into_iter().collect();
        let d = self.data();
        d.set("verify:count", &json!(d.get("verify:count").and_then(|v| v.as_i64()).unwrap_or(0) + 1));
        let mut out = private("✅ You are verified. Welcome!");
        out.push(Action::Roles { user: member.id.clone(), add: vec![role.to_string()], remove, reason: "Verified via button".into() });
        out
    }

    // ------------------------------------------------------------------ popups
    pub fn form(&self, ev: &FormEvent) -> Option<Vec<Action>> {
        let v = |k: &str| ev.values.get(k).map(|s| s.trim().to_string()).unwrap_or_default();
        if ev.id == "verify:code" {
            let key = format!("{}:{}", self.guild, ev.member.id);
            let mut m = memory();
            let Some((code, at, tries)) = m.captchas.get(&key).cloned() else { return Some(private("That code ran out. Press **Verify me** again for a new one.")) };
            if ev.at_ms - at > CAPTCHA_MS { m.captchas.remove(&key); return Some(private("That code ran out. Press **Verify me** again for a new one.")); }
            if !code_matches(&v("code"), &code) {
                let tries = tries + 1;
                if tries >= CAPTCHA_TRIES { m.captchas.remove(&key); return Some(private("That wasn't it, and that was the last try. Press **Verify me** again for a new code.")); }
                m.captchas.insert(key, (code, at, tries));
                let left = CAPTCHA_TRIES - tries;
                return Some(private(format!("That wasn't it. {left} {} left: press **Type the code** again.", if left == 1 { "try" } else { "tries" })));
            }
            m.captchas.remove(&key);
            drop(m);
            let Some(role) = self.text("verificationRole").filter(|r| self.dir.role(self.guild, r).is_some()) else { return Some(private("Verification is not set up right now. Tell an admin to run `/verify status`.")) };
            return Some(self.grant(&ev.member, &role));
        }
        if ev.id == "intro:submit" {
            let Some(channel) = self.text("introChannel") else { return Some(private("Introductions are not set up.")) };
            let mut card = Card::new(Area::General).title(ev.member.name.clone()).picture(ev.member.avatar.clone()).line(short(&v("about"), 1000));
            if !v("interests").is_empty() { card = card.line(format!("**Interests**\n{}", short(&v("interests"), 200))); }
            if !v("fun").is_empty() { card = card.line(format!("**Fun fact**\n{}", short(&v("fun"), 200))); }
            let d = self.data();
            let mut out = private(format!("Posted in <#{channel}>!"));
            match d.get(&format!("intro:{}", ev.member.id)).and_then(|p| p["messageId"].as_str().map(str::to_string)) {
                Some(message) => out.push(Action::Edit { channel, message, card }),
                None => out.push(Action::Post { channel, card, note: format!("intro:{}", ev.member.id), ping: Vec::new(), roles: Vec::new() }),
            }
            return Some(out);
        }
        if ev.id == "greet:image" {
            if !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return Some(private(format!("You don't have permission for that (`{}`).", MANAGE.key))); }
            let kind = if v("message") == "goodbye" { "goodbye" } else { "welcome" };
            let dir = self.greet_dir();
            let old = self.text(&format!("{kind}Image"));
            let file = ev.files.get("image").and_then(|f| f.first()).cloned();
            let Some((name, url, size)) = file else {
                if let (Some(dir), Some(old)) = (&dir, &old) { let _ = std::fs::remove_file(dir.join(old)); }
                self.set(&format!("{kind}Image"), json!(""));
                return Some(private(format!("The {kind} picture was removed. {} messages are plain text again.", if kind == "welcome" { "Welcome" } else { "Goodbye" })));
            };
            let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
            if !GREET_IMAGE_TYPES.contains(&ext.as_str()) { return Some(private("Use a PNG, JPG, GIF or WebP picture.")); }
            if size > 8 * 1024 * 1024 { return Some(private("That picture is too big. Use one under 8 MB.")); }
            if let (Some(dir), Some(old)) = (&dir, &old) { let _ = std::fs::remove_file(dir.join(old)); }
            let stored = format!("{kind}-{}.{ext}", ev.at_ms);
            self.set(&format!("{kind}Image"), json!(stored));
            let text = fill(&self.text(&format!("{kind}Message")).unwrap_or_default(), &ev.member, self.server, self.dir.members(self.guild));
            let preview = Card::new(Area::General).line(format!("Saved. Here is how {kind} messages will look:")).line(text).picture(ev.member.avatar.clone()).private();
            return Some(vec![
                Action::Reply { card: preview },
                Action::KeepFiles { dir: format!("files/{MODULE}/{}/greetings", self.guild), files: vec![KeepFile { name, url, size, stored }], post: None },
            ]);
        }
        None
    }
    /// A message the bot posted is up (an introduction, the verification panel).
    pub fn posted(&self, note: &str, message: &str, now: i64) {
        let d = self.data();
        if let Some(user) = note.strip_prefix("intro:") {
            d.set(&format!("intro:{user}"), &json!({ "messageId": message }));
        } else if let Some(rest) = note.strip_prefix("verify:panel:") {
            let (channel, by) = rest.split_once(':').unwrap_or((rest, ""));
            d.set(PANEL_KEY, &json!({ "channelId": channel, "messageId": message, "postedBy": by, "postedAt": now }));
        }
    }

    // ------------------------------------------------------------------ profiles
    fn profile(&self, ev: &CommandEvent, sub: &str) -> Vec<Action> {
        if !self.on("profilesEnabled") { return private("Custom profiles are turned off in this server."); }
        let d = self.data();
        let stored = d.get(&format!("profile:{}", ev.member.id));
        let role = stored.as_ref().and_then(|p| p["roleId"].as_str().map(str::to_string)).filter(|r| self.dir.role(self.guild, r).is_some());
        if sub == "view" {
            let who = ev.target.clone().unwrap_or_else(|| ev.member.clone());
            let theirs = d.get(&format!("profile:{}", who.id)).and_then(|p| p["roleId"].as_str().map(str::to_string)).and_then(|r| self.dir.role(self.guild, &r));
            let Some(r) = theirs else { return private(format!("{} has no custom profile.", who.name)) };
            return vec![Action::Reply { card: Card::new(Area::General).title(r.name).line(format!("Profile of <@{}>", who.id)).private() }];
        }
        if sub == "remove" {
            let Some(role) = role else { return private("You don't have a profile role.") };
            d.delete(&format!("profile:{}", ev.member.id));
            let mut out = private("Your profile role was removed.");
            out.push(Action::DeleteRole { role, reason: "Profile removed by member".into() });
            return out;
        }
        let name = ev.args.get("name").map(|n| sanitize_name(n, 32));
        let color = match crate::colours::typed_or_picked(ev.args.get("color").map(String::as_str), ev.args.get("colour").map(String::as_str)) {
            None => None,
            Some(raw) => match normalize_hex(raw) { Some(c) => Some(c), None => return private("Colors look like `#FF69B4`.") },
        };
        let check = |name: Option<&str>, color: Option<&str>, own: Option<&str>| -> Option<String> {
            if let Some(n) = name {
                if !self.on("profileAllowName") { return Some("Name changes are turned off in this server.".into()); }
                if n.is_empty() { return Some("That name has nothing usable in it. Letters, numbers and spaces work best.".into()); }
                if self.dir.roles(self.guild).iter().any(|r| r.name.to_lowercase() == n.to_lowercase() && Some(r.id.as_str()) != own) { return Some("A role with that name already exists - pick another so nobody is confused.".into()); }
            }
            if let Some(c) = color {
                if !self.on("profileAllowColor") { return Some("Color changes are turned off in this server.".into()); }
                let allowed: Vec<String> = self.settings.list(self.guild, MODULE, "profileAllowedColors").iter().filter_map(|c| normalize_hex(c)).collect();
                if !allowed.is_empty() && !allowed.iter().any(|a| a == c) { return Some(format!("Pick one of the allowed colors: {}", allowed.join(", "))); }
            }
            None
        };
        let to_int = |c: &str| u32::from_str_radix(c.trim_start_matches('#'), 16).ok();
        if sub == "setup" {
            if role.is_some() { return private("You already have a profile - use `/profile edit`."); }
            let final_name = name.filter(|n| !n.is_empty() || ev.args.contains_key("name")).unwrap_or_else(|| sanitize_name(&ev.member.name, 32));
            if let Some(no) = check(Some(&final_name), color.as_deref(), None) { return private(no); }
            let mut out = private(format!("Your profile **{final_name}** is ready. Change it any time with `/profile edit`."));
            out.push(Action::CreateRole { name: final_name, color: color.as_deref().and_then(to_int), hoist: self.on("profileHoist"), below: self.text("profileAnchorRole"), give_to: ev.member.id.clone(), note: format!("profile:{}", ev.member.id), mentionable: false });
            return out;
        }
        let Some(role) = role else { return private("You don't have a profile yet - use `/profile setup`.") };
        if name.is_none() && color.is_none() { return private("Tell me what to change: `name` and/or `color`."); }
        if let Some(no) = check(name.as_deref(), color.as_deref(), Some(&role)) { return private(no); }
        let shown = name.clone().unwrap_or_else(|| self.role_name(&role));
        let mut out = private(format!("Updated **{shown}**."));
        // only ever the exact role made and kept for this member, never a role they name
        out.push(Action::EditRole { role, name, color: color.as_deref().and_then(to_int) });
        out
    }
    /// The profile role was made: it is kept as this member's.
    pub fn role_made(&self, note: &str, role: &str, now: i64) {
        if let Some(user) = note.strip_prefix("profile:") {
            self.data().set(&format!("profile:{user}"), &json!({ "roleId": role, "at": now }));
        }
    }

    // ------------------------------------------------------------------ AFK
    pub fn on_message(&self, ev: &MessageEvent) -> Vec<Action> {
        if !self.on("afkEnabled") || ev.author.bot { return Vec::new(); }
        let d = self.data();
        let mut out = Vec::new();
        if let Some(mine) = d.get(&format!("afk:{}", ev.author.id)) {
            if ev.at_ms - mine["since"].as_i64().unwrap_or(0) > 10_000 {
                d.delete(&format!("afk:{}", ev.author.id));
                out.push(Action::Flash { channel: ev.place.channel.clone(), card: Card::new(Area::General).line(format!("Welcome back <@{}>, I removed your AFK.", ev.author.id)), ping: vec![ev.author.id.clone()], after_secs: 8 });
            }
        }
        for user in ev.mentioned.iter().take(5) {
            if user.bot || user.id == ev.author.id { continue; }
            let Some(afk) = d.get(&format!("afk:{}", user.id)) else { continue };
            let key = format!("{}:{}", ev.place.channel, user.id);
            {
                let mut m = memory();
                if ev.at_ms - m.afk_notice.get(&key).copied().unwrap_or(0) < 60_000 { continue; }
                m.afk_notice.insert(key, ev.at_ms);
            }
            out.push(Action::Send { channel: ev.place.channel.clone(), card: Card::new(Area::General).line(format!("**{}** is AFK: {} ({})", short(&user.name, 32), short(afk["reason"].as_str().unwrap_or("AFK"), 200), ts(afk["since"].as_i64().unwrap_or(0)))), ping: Vec::new(), roles: Vec::new() });
        }
        out
    }

    // ------------------------------------------------------------------ birthdays
    /// Once a day (in the server's own time): yesterday's birthday role comes off, today's birthdays get it and
    /// the message (Good Boy 3's birthdayTask). 29 February birthdays are on the 28th in other years.
    pub fn birthdays(&self, now: i64) -> Vec<Action> {
        let d = self.data();
        let (y, m, day) = self.local_date(now);
        let today = format!("{y}-{m}-{day}");
        if d.get("bdayLast").and_then(|v| v.as_str().map(str::to_string)).as_deref() == Some(today.as_str()) { return Vec::new(); }
        d.set("bdayLast", &json!(today));
        let mut out = Vec::new();
        let role = self.text("birthdayRole");
        if let Some(r) = &role {
            for id in d.get("bdayHolders").and_then(|v| v.as_array().cloned()).unwrap_or_default().iter().filter_map(|v| v.as_str()) {
                out.push(Action::Roles { user: id.into(), add: Vec::new(), remove: vec![r.clone()], reason: "Birthday is over".into() });
            }
        }
        let feb28 = m == 2 && day == 28 && !leap(y);
        let mut holders = Vec::new();
        let channel = self.text("birthdayChannel");
        for (key, v) in d.list("bday:") {
            let (bm, bd) = (v["m"].as_i64().unwrap_or(0), v["d"].as_i64().unwrap_or(0));
            if !(bm == m && (bd == day || (feb28 && bd == 29))) { continue; }
            let id = key[5..].to_string();
            if let Some(r) = &role { out.push(Action::Roles { user: id.clone(), add: vec![r.clone()], remove: Vec::new(), reason: "Birthday".into() }); holders.push(id.clone()); }
            if let Some(c) = &channel {
                let who = Member { id: id.clone(), name: id.clone(), ..Default::default() };
                out.push(Action::Send { channel: c.clone(), card: Card::new(Area::General).line(fill(&self.text("birthdayMessage").unwrap_or_default(), &who, self.server, self.dir.members(self.guild))), ping: vec![id], roles: Vec::new() });
            }
        }
        d.set("bdayHolders", &json!(holders));
        out
    }
}
