//! Server setup: builds a new server's roles, categories and channels from a template, connects them to the bot's modules
//! (welcome, logs, tickets and so on), and checks a server that is already set up for things to tidy or connect.
//!
//! Everything here decides *what* to do from the server's layout (the same JSON a backup is made from, with ids added) and
//! the bot's own settings. The Discord layer reads the layout, makes the roles and channels, and tells this module what it
//! made so the bot can be connected to it. Nothing is ever deleted or changed without being asked for by name.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::{Action, Area, ButtonStyle, Card, CommandEvent, Db, Settings};
use serde_json::{json, Value};

pub const MODULE: &str = crate::notify::MODULE;
pub const USE: Perm = Perm { key: "setup.use", level: Level::Admin };

// Discord's permission bits
pub const CREATE_INVITE: u64 = 1;
pub const KICK: u64 = 1 << 1;
pub const BAN: u64 = 1 << 2;
pub const ADMINISTRATOR: u64 = 1 << 3;
pub const MANAGE_CHANNELS: u64 = 1 << 4;
pub const MANAGE_GUILD: u64 = 1 << 5;
pub const VIEW_AUDIT_LOG: u64 = 1 << 7;
pub const VIEW_CHANNEL: u64 = 1 << 10;
pub const SEND_MESSAGES: u64 = 1 << 11;
pub const MANAGE_MESSAGES: u64 = 1 << 13;
pub const ADD_REACTIONS: u64 = 1 << 6;
pub const MENTION_EVERYONE: u64 = 1 << 17;
pub const CONNECT: u64 = 1 << 20;
pub const MANAGE_NICKNAMES: u64 = 1 << 27;
pub const MANAGE_ROLES: u64 = 1 << 28;
pub const MANAGE_WEBHOOKS: u64 = 1 << 29;
pub const MODERATE_MEMBERS: u64 = 1 << 40;
/// What @everyone should never have in a community server.
pub const RISKY_FOR_EVERYONE: u64 = ADMINISTRATOR | MANAGE_GUILD | MANAGE_ROLES | MANAGE_CHANNELS | KICK | BAN | MENTION_EVERYONE | MANAGE_WEBHOOKS | MANAGE_MESSAGES | MODERATE_MEMBERS;

pub struct RoleSpec { pub name: &'static str, pub color: u32, pub hoist: bool, pub perms: u64 }
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// Everyone can read and write.
    Open,
    /// Everyone can read, only staff can write.
    ReadOnly,
    /// Only staff can see it.
    Staff,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Type { Text, News, Voice, Category }
pub struct ChanSpec { pub name: &'static str, pub kind: Type, pub topic: &'static str, pub access: Access, pub purpose: &'static str, pub limit: u32 }
pub struct CatSpec { pub name: &'static str, pub access: Access, pub purpose: &'static str, pub chans: &'static [ChanSpec] }
pub struct Template { pub id: &'static str, pub name: &'static str, pub about: &'static str, pub roles: &'static [RoleSpec], pub cats: &'static [CatSpec], pub modules: &'static [&'static str] }

const fn text(name: &'static str, topic: &'static str, access: Access, purpose: &'static str) -> ChanSpec { ChanSpec { name, kind: Type::Text, topic, access, purpose, limit: 0 } }
const fn voice(name: &'static str, limit: u32) -> ChanSpec { ChanSpec { name, kind: Type::Voice, topic: "", access: Access::Open, purpose: "", limit } }
const fn news(name: &'static str, topic: &'static str, purpose: &'static str) -> ChanSpec { ChanSpec { name, kind: Type::News, topic, access: Access::ReadOnly, purpose, limit: 0 } }

const STAFF_ROLES: &[RoleSpec] = &[
    RoleSpec { name: "Admin", color: 0xe74c3c, hoist: true, perms: ADMINISTRATOR },
    RoleSpec { name: "Moderator", color: 0x3498db, hoist: true, perms: KICK | BAN | MANAGE_MESSAGES | MODERATE_MEMBERS | MANAGE_NICKNAMES | VIEW_AUDIT_LOG },
];
const INFO: CatSpec = CatSpec { name: "Info", access: Access::ReadOnly, purpose: "", chans: &[
    text("welcome", "Say hello to new members.", Access::ReadOnly, "welcome"),
    text("rules", "Read these before you chat.", Access::ReadOnly, "rules"),
    news("announcements", "News from the team.", "news"),
] };
const STAFF_CAT: CatSpec = CatSpec { name: "Staff", access: Access::Staff, purpose: "", chans: &[
    text("staff-chat", "Private chat for the team.", Access::Staff, ""),
    text("mod-log", "Warnings, bans and other moderation, written by Good Boy.", Access::Staff, "mod-log"),
    text("server-log", "Joins, leaves, role and name changes, voice.", Access::Staff, "server-log"),
    text("ticket-log", "Closed tickets and their transcripts.", Access::Staff, "tickets-log"),
] };
const TICKETS_CAT: CatSpec = CatSpec { name: "Tickets", access: Access::Staff, purpose: "ticket-category", chans: &[] };

pub static TEMPLATES: &[Template] = &[
    Template { id: "community", name: "Community", about: "A friendly general server: info, chat, voice, support tickets and a staff area, with logs and welcome messages connected.", roles: STAFF_ROLES, cats: &[
        INFO,
        CatSpec { name: "Community", access: Access::Open, purpose: "", chans: &[
            text("general", "Chat about anything.", Access::Open, ""),
            text("introductions", "Tell us about yourself.", Access::Open, "intro"),
            text("media", "Pictures, clips and links.", Access::Open, ""),
            text("bot-commands", "Use bot commands here.", Access::Open, ""),
            text("suggestions", "Ideas for the server.", Access::Open, "suggestions"),
        ] },
        CatSpec { name: "Voice", access: Access::Open, purpose: "", chans: &[voice("General", 0), voice("Music", 0), voice("Chill", 0)] },
        CatSpec { name: "Support", access: Access::ReadOnly, purpose: "", chans: &[text("open-a-ticket", "Press the button to talk to staff in private.", Access::ReadOnly, "ticket-panel")] },
        TICKETS_CAT, STAFF_CAT,
    ], modules: &["moderation", "member-management", "community", "support", "engagement", "logs"] },
    Template { id: "gaming", name: "Gaming", about: "For a gaming group or clan: looking-for-group, clips, squad voice rooms, and everything in the Community layout.", roles: STAFF_ROLES, cats: &[
        INFO,
        CatSpec { name: "Community", access: Access::Open, purpose: "", chans: &[
            text("general", "Chat about anything.", Access::Open, ""),
            text("introductions", "Tell us about yourself and what you play.", Access::Open, "intro"),
            text("bot-commands", "Use bot commands here.", Access::Open, ""),
            text("suggestions", "Ideas for the server.", Access::Open, "suggestions"),
        ] },
        CatSpec { name: "Games", access: Access::Open, purpose: "", chans: &[
            text("looking-for-group", "Find people to play with. Try /party create.", Access::Open, ""),
            text("game-chat", "Talk about what you are playing.", Access::Open, ""),
            text("clips", "Share your best moments.", Access::Open, ""),
            text("screenshots", "Pictures from your games.", Access::Open, ""),
        ] },
        CatSpec { name: "Voice", access: Access::Open, purpose: "", chans: &[voice("Lobby", 0), voice("Squad 1", 4), voice("Squad 2", 4), voice("Squad 3", 4), voice("Music", 0)] },
        CatSpec { name: "Support", access: Access::ReadOnly, purpose: "", chans: &[text("open-a-ticket", "Press the button to talk to staff in private.", Access::ReadOnly, "ticket-panel")] },
        TICKETS_CAT, STAFF_CAT,
    ], modules: &["moderation", "member-management", "community", "support", "engagement", "logs", "partyfinder", "clips"] },
    Template { id: "support", name: "Support and product", about: "For a product, shop or creator: announcements, FAQ, tickets, feedback and a staff area.", roles: STAFF_ROLES, cats: &[
        CatSpec { name: "Info", access: Access::ReadOnly, purpose: "", chans: &[
            text("welcome", "Welcome! Start here.", Access::ReadOnly, "welcome"),
            text("rules", "Please read before posting.", Access::ReadOnly, "rules"),
            news("announcements", "Updates and releases.", "news"),
            text("faq", "Answers to common questions.", Access::ReadOnly, ""),
        ] },
        CatSpec { name: "Community", access: Access::Open, purpose: "", chans: &[
            text("general", "Chat with the community.", Access::Open, ""),
            text("feedback", "Tell us what you think.", Access::Open, ""),
            text("suggestions", "Ideas for what comes next.", Access::Open, "suggestions"),
        ] },
        CatSpec { name: "Support", access: Access::ReadOnly, purpose: "", chans: &[text("open-a-ticket", "Press the button to get help in private.", Access::ReadOnly, "ticket-panel")] },
        TICKETS_CAT, STAFF_CAT,
    ], modules: &["moderation", "member-management", "support", "engagement", "logs"] },
    Template { id: "small", name: "Small group of friends", about: "Just the basics: a couple of chat channels, a voice room and a private log, kept simple.", roles: STAFF_ROLES, cats: &[
        CatSpec { name: "Text", access: Access::Open, purpose: "", chans: &[text("general", "Chat about anything.", Access::Open, ""), text("memes", "The good stuff.", Access::Open, ""), text("bot-commands", "Use bot commands here.", Access::Open, "")] },
        CatSpec { name: "Voice", access: Access::Open, purpose: "", chans: &[voice("Hangout", 0)] },
        CatSpec { name: "Staff", access: Access::Staff, purpose: "", chans: &[text("mod-log", "Moderation and server logs, written by Good Boy.", Access::Staff, "mod-log")] },
    ], modules: &["moderation", "member-management", "community"] },
    // used by "Check my server" to add just the logs
    Template { id: "logs", name: "Logs only", about: "A staff-only area for the moderation and server logs.", roles: STAFF_ROLES, cats: &[
        CatSpec { name: "Staff", access: Access::Staff, purpose: "", chans: &[
            text("mod-log", "Warnings, bans and other moderation, written by Good Boy.", Access::Staff, "mod-log"),
            text("server-log", "Joins, leaves, role and name changes, voice.", Access::Staff, "server-log"),
        ] },
    ], modules: &["moderation", "logs"] },
];
/// Templates people can pick (the logs-only one is for fixes).
pub fn pickable() -> impl Iterator<Item = &'static Template> { TEMPLATES.iter().filter(|t| t.id != "logs") }
pub fn template(id: &str) -> Option<&'static Template> { TEMPLATES.iter().find(|t| t.id == id) }

pub const RULES: &str = "**Server rules**\n1. Be kind and respectful. No harassment, hate or bullying.\n2. Keep each channel on topic, and keep the chat safe for work.\n3. No spam, scams, or advertising without asking staff.\n4. Do not share anyone's private information.\n5. Listen to the staff. If you have a problem, open a ticket or message a moderator.\n\nBreaking the rules can lead to a warning, a timeout or a ban.";

/// (purpose, module, setting) for every channel the bot can be connected to.
pub const WIRING: &[(&str, &str, &str)] = &[
    ("welcome", "member-management", "welcomeChannel"), ("intro", "member-management", "introChannel"),
    ("mod-log", "moderation", "logChannel"), ("server-log", "moderation", "serverLogChannel"),
    ("tickets-log", "support", "logChannel"), ("ticket-category", "support", "ticketCategory"),
    ("suggestions", "engagement", "suggestionChannel"),
];
/// Names an existing channel is likely to have for each purpose, so a set-up server can be connected without building anything.
fn aliases(purpose: &str) -> &'static [&'static str] {
    match purpose {
        "welcome" => &["welcome", "welcomes", "welcome-and-rules", "arrivals", "new-members"],
        "intro" => &["introductions", "introduction", "intros", "introduce-yourself"],
        "mod-log" => &["mod-log", "mod-logs", "modlog", "modlogs", "moderation-log", "moderation-logs", "mod-actions"],
        "server-log" => &["server-log", "server-logs", "serverlog", "audit-log", "logs", "member-log"],
        "tickets-log" => &["ticket-log", "ticket-logs", "ticket-transcripts", "transcripts"],
        "suggestions" => &["suggestions", "suggestion", "suggest", "ideas"],
        _ => &[],
    }
}
fn purposes_wired_to_module(purpose: &str) -> Option<(&'static str, &'static str)> { WIRING.iter().find(|w| w.0 == purpose).map(|w| (w.1, w.2)) }
fn module_name(id: &str) -> &'static str { crate::bot::MODULES.iter().find(|m| m.id == id).map(|m| m.name).unwrap_or(match id { "logs" => "Logs", _ => "" }) }

fn pbits(n: u64) -> String { n.to_string() }
fn overwrites(access: Access, staff: &[&str]) -> Vec<Value> {
    match access {
        Access::Open => Vec::new(),
        Access::ReadOnly => {
            let mut o = vec![json!({ "role": "@everyone", "allow": pbits(VIEW_CHANNEL), "deny": pbits(SEND_MESSAGES | ADD_REACTIONS) })];
            for s in staff { o.push(json!({ "role": s, "allow": pbits(SEND_MESSAGES | ADD_REACTIONS), "deny": "0" })); }
            o
        }
        Access::Staff => {
            let mut o = vec![json!({ "role": "@everyone", "allow": "0", "deny": pbits(VIEW_CHANNEL) })];
            for s in staff { o.push(json!({ "role": s, "allow": pbits(VIEW_CHANNEL | SEND_MESSAGES | CONNECT), "deny": "0" })); }
            o
        }
    }
}
fn kind_id(t: Type) -> u8 { match t { Type::Text => 0, Type::Voice => 2, Type::Category => 4, Type::News => 5 } }

/// A template as the same JSON a backup is made of, so the backup machinery can add what is missing.
pub fn as_layout(t: &Template) -> Value {
    let staff: Vec<&str> = t.roles.iter().filter(|r| r.perms & (ADMINISTRATOR | KICK) != 0).map(|r| r.name).collect();
    let roles: Vec<Value> = t.roles.iter().map(|r| json!({ "name": r.name, "color": r.color, "hoist": r.hoist, "mentionable": false, "permissions": pbits(r.perms), "position": 0 })).collect();
    let mut channels = Vec::new();
    for cat in t.cats {
        channels.push(json!({ "name": cat.name, "type": 4, "parent": null, "topic": null, "nsfw": false, "slowmode": 0, "bitrate": null, "userLimit": null, "overwrites": overwrites(if cat.access == Access::Staff { Access::Staff } else { Access::Open }, &staff) }));
        for c in cat.chans {
            channels.push(json!({ "name": c.name, "type": kind_id(c.kind), "parent": cat.name, "topic": if c.topic.is_empty() { Value::Null } else { json!(c.topic) }, "nsfw": false, "slowmode": 0,
                "bitrate": null, "userLimit": if c.limit > 0 { json!(c.limit) } else { Value::Null }, "overwrites": overwrites(c.access, &staff) }));
        }
    }
    json!({ "version": 1, "roles": roles, "channels": channels })
}
/// What a build would add and what is already there: (roles to add, channels to add, roles that exist, channels that exist).
pub fn diff(t: &Template, now: &Value) -> (Vec<Value>, Vec<Value>, Vec<String>, Vec<String>) {
    let want = as_layout(t);
    let (roles, channels) = crate::backup::plan(&want, now);
    let had_roles: Vec<String> = want["roles"].as_array().into_iter().flatten().filter_map(|r| r["name"].as_str()).filter(|n| !roles.iter().any(|r| r["name"] == *n)).map(str::to_string).collect();
    let had_ch: Vec<String> = want["channels"].as_array().into_iter().flatten().filter(|c| !channels.contains(c)).filter_map(|c| c["name"].as_str()).map(str::to_string).collect();
    (roles, channels, had_roles, had_ch)
}

/// The ids of what is in the server after a build: roles and channels by name (categories too).
#[derive(Debug, Clone, Default)]
pub struct Built {
    pub roles: Vec<(String, String)>,
    /// (name, parent category's name, id)
    pub channels: Vec<(String, Option<String>, String)>,
}
impl Built {
    fn channel(&self, name: &str, parent: Option<&str>) -> Option<&str> { self.channels.iter().find(|(n, p, _)| n == name && p.as_deref() == parent).map(|c| c.2.as_str()) }
    fn role(&self, name: &str) -> Option<&str> { self.roles.iter().find(|r| r.0 == name).map(|r| r.1.as_str()) }
}

/// What a fix needs done. `everyone_remove` is permission bits to take off @everyone, `build` a layout to build.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FixPlan { pub actions: Vec<Action>, pub everyone_remove: u64, pub build: Option<&'static str>, pub text: String }

/// Something found in a server worth telling the owner about. `fix` is what the "Fix" button does.
#[derive(Debug, Clone, PartialEq)]
pub struct Finding { pub id: &'static str, pub warn: bool, pub title: String, pub detail: String, pub fix: Option<&'static str> }
impl Finding {
    pub fn json(&self) -> Value { json!({ "id": self.id, "level": if self.warn { "warn" } else { "tip" }, "title": self.title, "detail": self.detail, "fix": self.fix }) }
}
pub const FIXES: &[(&str, &str)] = &[("connect", "Connect these channels"), ("modules", "Turn them on"), ("empty", "Remove the empty categories"), ("everyone", "Take these away from everyone"), ("logs", "Add a logs area")];

pub struct Setup<'a> { pub db: &'a Db, pub settings: &'a Settings, pub guild: &'a str }
fn snowflake_ms(id: &str) -> Option<i64> { id.parse::<u64>().ok().map(|n| ((n >> 22) + 1_420_070_400_000) as i64) }
const DAY: i64 = 86_400_000;
impl Setup<'_> {
    fn module_on(&self, module: &str) -> bool { self.db.get().module_enabled(self.guild, module).unwrap_or(false) }
    fn set_of(&self, module: &str, key: &str) -> bool { self.settings.text(self.guild, module, key).is_some_and(|s| !s.is_empty()) }
    /// Existing channels that look like they are meant for something the bot can be connected to: (purpose, channel id, name).
    pub fn connectable(&self, layout: &Value) -> Vec<(&'static str, String, String)> {
        let mut out = Vec::new();
        for (purpose, module, key) in WIRING {
            if *purpose == "ticket-category" || self.set_of(module, key) { continue; }
            let wanted = aliases(purpose);
            let hit = layout["channels"].as_array().into_iter().flatten().find(|c| matches!(c["type"].as_i64(), Some(0 | 5)) && c["name"].as_str().is_some_and(|n| wanted.contains(&n.to_ascii_lowercase().as_str())));
            if let Some(c) = hit { if let (Some(id), Some(name)) = (c["id"].as_str(), c["name"].as_str()) { out.push((*purpose, id.to_string(), name.to_string())); } }
        }
        out
    }
    /// Connects the bot to channels it was found or told about. Only fills in what is empty. Turns on the module each belongs to.
    pub fn connect(&self, items: &[(&str, String)]) -> Vec<String> {
        let mut said = Vec::new();
        for (purpose, id) in items {
            let Some((module, key)) = purposes_wired_to_module(purpose) else { continue };
            if self.set_of(module, key) { continue; }
            if self.settings.set(self.guild, module, key, &json!(id)).is_ok() {
                let _ = self.db.get().set_module_enabled(self.guild, module, true);
                said.push(format!("{} → <#{id}>", match *purpose { "welcome" => "Welcome messages", "intro" => "Introductions", "mod-log" => "Moderation log", "server-log" => "Server log", "tickets-log" => "Ticket log", "suggestions" => "Suggestions", p => p }));
            }
        }
        said
    }
    /// Turns the template's modules on, connects its channels and roles to them, and gives the actions that put text in them.
    pub fn wire(&self, t: &Template, built: &Built) -> (Vec<Action>, Vec<String>) {
        let mut said = Vec::new();
        let mut actions = Vec::new();
        let mut items: Vec<(&str, String)> = Vec::new();
        for cat in t.cats {
            if let (false, Some(id)) = (cat.purpose.is_empty(), built.channel(cat.name, None)) { items.push((cat.purpose, id.to_string())); }
            for c in cat.chans {
                if c.purpose.is_empty() { continue; }
                if let Some(id) = built.channel(c.name, Some(cat.name)) { items.push((c.purpose, id.to_string())); }
            }
        }
        said.extend(self.connect(&items));
        for m in t.modules { if !self.module_on(m) && self.db.get().set_module_enabled(self.guild, m, true).is_ok() { said.push(format!("Turned on **{}**", module_name(m))); } }
        if let Some(role) = built.role("Moderator") {
            if !self.set_of("support", "staffRole") && self.settings.set(self.guild, "support", "staffRole", &json!(role)).is_ok() { said.push(format!("Ticket staff role → <@&{role}>")); }
        }
        // welcome and goodbye start on, so the welcome channel does something straight away
        if self.set_of("member-management", "welcomeChannel") && self.settings.set(self.guild, "member-management", "welcomeEnabled", &json!(true)).is_ok() { said.push("Welcome messages are on".into()); }
        for cat in t.cats { for c in cat.chans {
            let Some(id) = built.channel(c.name, Some(cat.name)) else { continue };
            match c.purpose {
                "rules" => actions.push(Action::Send { channel: id.to_string(), card: Card::new(Area::General).line(RULES), ping: Vec::new(), roles: Vec::new() }),
                "ticket-panel" if t.modules.contains(&"support") => actions.extend(crate::tickets::Tickets { db: self.db, settings: self.settings, guild: self.guild }.post_panel(id, None, None)),
                _ => {}
            }
        } }
        (actions, said)
    }

    /// One fix from a check. `layout` is the server as the check saw it.
    pub fn fix(&self, what: &str, layout: &Value) -> FixPlan {
        let mut plan = FixPlan::default();
        match what {
            "connect" => {
                let items: Vec<(&str, String)> = self.connectable(layout).into_iter().map(|(p, id, _)| (p, id)).collect();
                let said = self.connect(&items);
                plan.text = if said.is_empty() { "There was nothing left to connect.".into() } else { format!("Connected:\n{}", said.join("\n")) };
            }
            "modules" => {
                let mut on = Vec::new();
                for m in ["moderation", "member-management", "community"] { if !self.module_on(m) && self.db.get().set_module_enabled(self.guild, m, true).is_ok() { on.push(module_name(m)); } }
                plan.text = if on.is_empty() { "Those are already on.".into() } else { format!("Turned on {}. Finish setting them up on the dashboard's Modules page.", on.join(", ")) };
            }
            "empty" => {
                let used = self.settings.text(self.guild, "support", "ticketCategory").unwrap_or_default();
                let chans: Vec<&Value> = layout["channels"].as_array().into_iter().flatten().collect();
                let empty: Vec<(&str, &str)> = chans.iter().filter(|c| c["type"].as_i64() == Some(4) && !chans.iter().any(|x| x["parent"] == c["name"] && x["type"].as_i64() != Some(4))).filter_map(|c| Some((c["id"].as_str()?, c["name"].as_str()?))).filter(|(id, _)| *id != used).collect();
                for (id, _) in &empty { plan.actions.push(Action::DeleteChannel { channel: id.to_string(), after_secs: 0 }); }
                plan.text = if empty.is_empty() { "There are no empty categories.".into() } else { format!("Removed {}: {}.", if empty.len() == 1 { "the empty category" } else { "the empty categories" }, empty.iter().map(|e| e.1).collect::<Vec<_>>().join(", ")) };
            }
            "everyone" => {
                let everyone = layout["everyone"].as_str().and_then(|p| p.parse::<u64>().ok()).unwrap_or(0);
                plan.everyone_remove = everyone & RISKY_FOR_EVERYONE;
                plan.text = if plan.everyone_remove == 0 { "Everyone already has nothing risky.".into() } else { format!("Took these away from @everyone: {}. Roles you gave them on purpose are not affected.", risky_names(plan.everyone_remove).join(", ")) };
            }
            "logs" => { plan.build = Some("logs"); plan.text = "Adding a staff-only logs area and connecting it.".into(); }
            _ => plan.text = "I don't know that fix.".into(),
        }
        plan
    }

    /// Looks at a server's layout and the bot's settings and gives what is worth a look, most important first.
    pub fn audit(&self, layout: &Value, now: i64, members: Option<u64>) -> Vec<Finding> {
        let mut out = Vec::new();
        let chans: Vec<&Value> = layout["channels"].as_array().into_iter().flatten().collect();
        let roles: Vec<&Value> = layout["roles"].as_array().into_iter().flatten().collect();
        let name = |c: &Value| c["name"].as_str().unwrap_or("").to_string();
        // @everyone with powers it should not have
        let everyone = layout["everyone"].as_str().and_then(|p| p.parse::<u64>().ok()).unwrap_or(0);
        if everyone & RISKY_FOR_EVERYONE != 0 {
            let names = risky_names(everyone & RISKY_FOR_EVERYONE);
            out.push(Finding { id: "everyone", warn: true, title: "Everyone has powers they should not".into(), detail: format!("The @everyone role can: {}. Anyone who joins gets these.", names.join(", ")), fix: Some("everyone") });
        }
        // roles that can do anything
        let admins: Vec<String> = roles.iter().filter(|r| r["permissions"].as_str().and_then(|p| p.parse::<u64>().ok()).is_some_and(|p| p & ADMINISTRATOR != 0)).map(|r| name(r)).collect();
        if admins.len() > 2 { out.push(Finding { id: "admins", warn: true, title: format!("{} roles have Administrator", admins.len()), detail: format!("{}. Administrator can do anything, including deleting the server's channels. Give most people only the permissions they need.", admins.join(", ")), fix: None }); }
        // names that repeat
        let mut seen: Vec<String> = Vec::new();
        let mut dup: Vec<String> = Vec::new();
        for c in chans.iter().filter(|c| matches!(c["type"].as_i64(), Some(0 | 5))) { let n = name(c); if seen.contains(&n) && !dup.contains(&n) { dup.push(n); } else { seen.push(n); } }
        if !dup.is_empty() { out.push(Finding { id: "duplicates", warn: false, title: "Channels with the same name".into(), detail: format!("{}. Two channels called the same are easy to mix up. Rename or merge them.", dup.iter().map(|d| format!("#{d}")).collect::<Vec<_>>().join(", ")), fix: None }); }
        let mut rn: Vec<String> = Vec::new();
        let mut rdup: Vec<String> = Vec::new();
        for r in &roles { let n = name(r).to_lowercase(); if rn.contains(&n) && !rdup.contains(&n) { rdup.push(n); } else { rn.push(n); } }
        if !rdup.is_empty() { out.push(Finding { id: "dup-roles", warn: false, title: "Roles with the same name".into(), detail: format!("{}. Merge them so members are not given the wrong one.", rdup.join(", ")), fix: None }); }
        // empty categories
        let used_cat = self.settings.text(self.guild, "support", "ticketCategory").unwrap_or_default();
        let empty: Vec<&Value> = chans.iter().filter(|c| c["type"].as_i64() == Some(4) && c["id"].as_str().is_some_and(|id| id != used_cat) && !chans.iter().any(|x| x["parent"] == c["name"] && x["type"].as_i64() != Some(4))).copied().collect();
        if !empty.is_empty() { out.push(Finding { id: "empty", warn: false, title: format!("{} empty categor{}", empty.len(), if empty.len() == 1 { "y" } else { "ies" }), detail: format!("{} have nothing in them. They only add clutter to the channel list.", empty.iter().map(|c| name(c)).collect::<Vec<_>>().join(", ")), fix: Some("empty") }); }
        // quiet channels
        let quiet: Vec<String> = chans.iter().filter(|c| matches!(c["type"].as_i64(), Some(0 | 5))).filter(|c| {
            let made = c["id"].as_str().and_then(snowflake_ms).unwrap_or(now);
            let last = c["lastMessage"].as_i64().unwrap_or(0);
            now - made > 90 * DAY && (last == 0 || now - last > 90 * DAY)
        }).map(|c| format!("#{}", name(c))).collect();
        if !quiet.is_empty() { out.push(Finding { id: "quiet", warn: false, title: format!("{} channel{} with no messages for 3 months", quiet.len(), if quiet.len() == 1 { "" } else { "s" }), detail: format!("{}. Archive or delete the ones nobody uses, so the active ones are easier to find.", quiet.iter().take(12).cloned().collect::<Vec<_>>().join(", ") + if quiet.len() > 12 { ", and more" } else { "" }), fix: None }); }
        // too many roles
        if roles.len() > 40 { out.push(Finding { id: "many-roles", warn: false, title: format!("{} roles", roles.len()), detail: "That is a lot to manage. Roles nobody uses, or that only differ by colour, can be merged.".into(), fix: None }); }
        // channels the bot could be connected to
        let connect = self.connectable(layout);
        if !connect.is_empty() { out.push(Finding { id: "connect", warn: false, title: format!("{} channel{} the bot is not using yet", connect.len(), if connect.len() == 1 { "" } else { "s" }), detail: connect.iter().map(|(p, _, n)| format!("#{n} looks like the {} channel", match *p { "welcome" => "welcome", "intro" => "introductions", "mod-log" => "moderation log", "server-log" => "server log", "tickets-log" => "ticket log", _ => "suggestions" })).collect::<Vec<_>>().join("; ") + ". Connect them so the bot posts there.", fix: Some("connect") }); }
        // nowhere for logs
        let has_log = self.set_of("moderation", "logChannel");
        if !has_log && connect.iter().all(|c| c.0 != "mod-log") { out.push(Finding { id: "logs", warn: true, title: "No moderation log".into(), detail: "Warnings, bans and timeouts have nowhere to be written down, so staff cannot look back at what happened. Add a staff-only logs area.".into(), fix: Some("logs") }); }
        // modules worth having
        let missing: Vec<&str> = ["moderation", "member-management", "community"].into_iter().filter(|m| !self.module_on(m)).collect();
        if !missing.is_empty() { out.push(Finding { id: "modules", warn: false, title: "Basic features are off".into(), detail: format!("{} {} not turned on. They are what most servers use first.", missing.iter().map(|m| module_name(m)).collect::<Vec<_>>().join(", "), if missing.len() == 1 { "is" } else { "are" }), fix: Some("modules") }); }
        // a module that is on but cannot work yet
        let mut unset: Vec<String> = Vec::new();
        for (m, key) in [("moderation", "logChannel"), ("support", "logChannel")] { if self.module_on(m) && !self.set_of(m, key) && !(m == "moderation" && !has_log && false) { unset.push(module_name(m).to_string()); } }
        if !unset.is_empty() { out.push(Finding { id: "needs-setup", warn: false, title: "Turned on, but not finished".into(), detail: format!("{} need a log channel. Pick one on the Modules page, or connect one above.", unset.join(" and ")), fix: None }); }
        if members.unwrap_or(0) >= 50 && !self.set_of("member-management", "verificationRole") { out.push(Finding { id: "verify", warn: false, title: "No verification".into(), detail: "With this many members, a verification step keeps bots and raiders out. Set it up in Welcome (it can be a button or a short code).".into(), fix: None }); }
        out.sort_by_key(|f| !f.warn);
        out
    }
}
fn risky_names(bits: u64) -> Vec<&'static str> {
    [(ADMINISTRATOR, "Administrator"), (MANAGE_GUILD, "Manage Server"), (MANAGE_ROLES, "Manage Roles"), (MANAGE_CHANNELS, "Manage Channels"), (KICK, "Kick"), (BAN, "Ban"), (MENTION_EVERYONE, "Mention @everyone"), (MANAGE_WEBHOOKS, "Manage Webhooks"), (MANAGE_MESSAGES, "Manage Messages"), (MODERATE_MEMBERS, "Time out members")]
        .into_iter().filter(|(b, _)| bits & b != 0).map(|(_, n)| n).collect()
}

fn private(text: impl Into<String>) -> Vec<Action> { vec![Action::Reply { card: Card::new(Area::General).line(text).private() }] }

/// What `/setup` shows to pick a layout.
pub fn picker_card() -> Card {
    let mut card = Card::new(Area::General).title("🧱 Set up this server").line("Pick a layout. I will show you exactly what it would add before anything is made. Nothing that already exists is touched.").private();
    for t in pickable() { card = card.line(format!("**{}** · {}", t.name, t.about)); }
    for t in pickable() { card = card.button(format!("setup:plan:{}", t.id), t.name, ButtonStyle::Primary); }
    card
}
/// What would be added, for the owner to read before pressing Build.
pub fn plan_card(t: &Template, now: &Value, owner: &str) -> Card {
    let (roles, channels, had_roles, had_ch) = diff(t, now);
    let cats: Vec<String> = channels.iter().filter(|c| c["type"] == 4).filter_map(|c| c["name"].as_str().map(str::to_string)).collect();
    let chans: Vec<String> = channels.iter().filter(|c| c["type"] != 4).filter_map(|c| Some(format!("{}{}", match c["type"].as_i64() { Some(2) => "🔊 ", _ => "# " }, c["name"].as_str()?))).collect();
    let mut card = Card::new(Area::General).title(format!("🧱 {} layout", t.name)).line(t.about).private();
    if roles.is_empty() && channels.is_empty() { return card.line("Everything in this layout is already in your server, so there is nothing to add. Use **Check my server** (`/setup scan`) to connect what you have to the bot."); }
    if !roles.is_empty() { card = card.line(format!("**Roles to add**\n{}", roles.iter().filter_map(|r| r["name"].as_str()).collect::<Vec<_>>().join(", "))); }
    if !cats.is_empty() { card = card.line(format!("**Categories to add**\n{}", cats.join(", "))); }
    if !chans.is_empty() { card = card.line(format!("**Channels to add ({})**\n{}", chans.len(), chans.join("  "))); }
    if !had_roles.is_empty() || !had_ch.is_empty() { card = card.line(format!("-# Already there, so skipped: {}", had_roles.iter().chain(had_ch.iter()).take(14).cloned().collect::<Vec<_>>().join(", "))); }
    card = card.line(format!("**Then I will** connect the welcome, log and ticket channels to the bot, turn on {}, and post the rules and the ticket buttons.", t.modules.iter().map(|m| module_name(m)).filter(|n| !n.is_empty()).collect::<Vec<_>>().join(", ")));
    card.button(format!("setup:build:{}:{owner}", t.id), "Build it", ButtonStyle::Good).button(format!("setup:cancel:{owner}"), "Cancel", ButtonStyle::Plain)
}
/// The check-up as a card, with a Fix button for each thing that can be fixed.
pub fn scan_card(findings: &[Finding], owner: &str) -> Card {
    let mut card = Card::new(Area::General).title("🔎 Server check").private();
    if findings.is_empty() { return card.line("✅ I found nothing to tidy. Your channels, roles and bot connections look good."); }
    card = card.line(format!("{} thing{} worth a look. Nothing is changed unless you press a Fix button.", findings.len(), if findings.len() == 1 { "" } else { "s" }));
    for f in findings.iter().take(12) { card = card.line(format!("{} **{}**\n{}", if f.warn { "⚠️" } else { "💡" }, f.title, f.detail)); }
    let mut fixes: Vec<&Finding> = findings.iter().filter(|f| f.fix.is_some()).collect();
    fixes.dedup_by_key(|f| f.fix);
    for f in fixes.into_iter().take(4) {
        let fix = f.fix.unwrap_or("");
        card = card.button(format!("setup:fix:{fix}:{owner}"), FIXES.iter().find(|x| x.0 == fix).map(|x| x.1).unwrap_or("Fix"), if f.warn { ButtonStyle::Danger } else { ButtonStyle::Good });
    }
    card
}

pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "setup", about: "(Admins) Build a new server's roles and channels, or check one that is already set up", module: MODULE, options: &[], subs: &[
    Sub { name: "start", about: "Pick a layout and build a server's roles, channels, logs and ticket buttons", options: &[] },
    Sub { name: "scan", about: "Check this server for clutter, risky permissions and channels the bot is not using", options: &[] },
    Sub { name: "layout", about: "See what one layout would add, without building it", options: &[Opt { name: "name", about: "Which layout", takes: Takes::Choice(LAYOUTS), required: true }] },
] }];
const LAYOUTS: &[(&str, &str)] = &[("Community", "community"), ("Gaming", "gaming"), ("Support and product", "support"), ("Small group of friends", "small")];

pub fn command(db: &Db, ev: &CommandEvent) -> Vec<Action> {
    if !perms::allowed(db, &ev.guild, &ev.member, USE) { return private(format!("You don't have permission for that (`{}`). Server setup is for admins.", USE.key)); }
    match ev.sub.as_deref().unwrap_or("start") {
        "scan" => vec![Action::Setup(Box::new(crate::event::SetupJob { by: ev.member.id.clone(), step: crate::event::SetupStep::Scan }))],
        "layout" => match ev.args.get("name").and_then(|n| template(n)) {
            Some(t) => vec![Action::Setup(Box::new(crate::event::SetupJob { by: ev.member.id.clone(), step: crate::event::SetupStep::Plan(t.id.to_string()) }))],
            None => private("Pick one of the layouts."),
        },
        _ => vec![Action::Reply { card: picker_card() }],
    }
}
/// A button on the setup cards: `setup:plan:<layout>`, `setup:build:<layout>:<who>`, `setup:fix:<fix>:<who>`, `setup:cancel:<who>`.
pub fn button(db: &Db, guild: &str, id: &str, member: &crate::Member) -> Option<Vec<Action>> {
    let rest = id.strip_prefix("setup:")?;
    if !perms::allowed(db, guild, member, USE) && member.perms & (perms::ADMINISTRATOR | perms::MANAGE_GUILD) == 0 { return Some(private("Server setup is for admins.")); }
    let parts: Vec<&str> = rest.split(':').collect();
    let owner_ok = |o: Option<&&str>| o.is_none_or(|o| *o == member.id);
    let job = |step| vec![Action::Setup(Box::new(crate::event::SetupJob { by: member.id.clone(), step }))];
    match parts.as_slice() {
        ["plan", t] => template(t).map(|t| job(crate::event::SetupStep::Plan(t.id.to_string()))),
        ["build", t, o] => { if !owner_ok(Some(o)) { return Some(private("That belongs to someone else. Run `/setup start` yourself.")); } template(t).map(|t| job(crate::event::SetupStep::Build(t.id.to_string()))) }
        ["fix", f, o] => { if !owner_ok(Some(o)) { return Some(private("That belongs to someone else. Run `/setup scan` yourself.")); } FIXES.iter().find(|x| x.0 == *f).map(|x| job(crate::event::SetupStep::Fix(x.0.to_string()))) }
        ["cancel", _] => Some(vec![Action::Update { card: Card::new(Area::General).line("Okay, nothing was changed.").private() }]),
        _ => None,
    }
}

/// The finished build as a card.
pub fn built_card(t: &Template, added: (usize, usize), failed: &[String], wired: &[String]) -> Card {
    let mut card = Card::new(Area::General).title(format!("✅ {} layout built", t.name)).line(format!("Added {} role{} and {} channel{}.", added.0, if added.0 == 1 { "" } else { "s" }, added.1, if added.1 == 1 { "" } else { "s" })).private();
    if !wired.is_empty() { card = card.line(format!("**Connected to the bot**\n{}", wired.join("\n"))); }
    if !failed.is_empty() { card = card.line(format!("⚠️ Could not add: {}. The bot needs Manage Roles and Manage Channels, and its role must be above the ones it makes.", failed.iter().take(6).cloned().collect::<Vec<_>>().join("; "))); }
    card.line("-# Change anything later on the dashboard. Roles and channels are yours: rename, move or delete them freely.")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_layout_is_a_valid_discord_layout() {
        for t in TEMPLATES {
            let l = as_layout(t);
            let chans = l["channels"].as_array().unwrap();
            assert!(chans.len() <= 60 && chans.len() >= 3, "{}: {}", t.id, chans.len());
            for c in chans {
                let name = c["name"].as_str().unwrap();
                let ty = c["type"].as_i64().unwrap();
                assert!(!name.is_empty() && name.chars().count() <= 100, "{name}");
                if matches!(ty, 0 | 5) { assert!(name.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-'), "text channel names are lowercase with dashes: {name}"); }
                if let Some(p) = c["parent"].as_str() { assert!(chans.iter().any(|x| x["type"] == 4 && x["name"] == p), "{name} sits in a category that exists"); }
                for o in c["overwrites"].as_array().unwrap() { assert!(o["allow"].as_str().unwrap().parse::<u64>().is_ok() && o["deny"].as_str().unwrap().parse::<u64>().is_ok()); }
            }
            let mut names: Vec<(&str, &str)> = chans.iter().map(|c| (c["name"].as_str().unwrap(), c["parent"].as_str().unwrap_or(""))).collect();
            names.sort();
            let before = names.len();
            names.dedup();
            assert_eq!(before, names.len(), "{}: no channel twice in one category", t.id);
            // every module it turns on is a real one
            for m in t.modules { assert!(crate::bot::MODULES.iter().any(|x| x.id == *m) || *m == "logs", "{m}"); }
            // every purpose it names can be connected, or is one this module handles itself
            for cat in t.cats { for c in cat.chans.iter().map(|c| c.purpose).chain(std::iter::once(cat.purpose)).filter(|p| !p.is_empty()) { assert!(WIRING.iter().any(|w| w.0 == c) || matches!(c, "rules" | "ticket-panel" | "news"), "{c}"); } }
        }
        // the settings it connects exist
        let s: Vec<_> = crate::bot::MODULES.iter().map(|m| m.id).collect();
        for (_, module, _) in WIRING { assert!(s.contains(module), "{module}"); }
    }
    #[test]
    fn staff_areas_hide_from_everyone_and_info_areas_are_read_only() {
        let l = as_layout(template("community").unwrap());
        let find = |n: &str| l["channels"].as_array().unwrap().iter().find(|c| c["name"] == n).unwrap().clone();
        let log = find("mod-log");
        assert_eq!(log["overwrites"][0]["role"], "@everyone");
        assert_eq!(log["overwrites"][0]["deny"].as_str().unwrap().parse::<u64>().unwrap() & VIEW_CHANNEL, VIEW_CHANNEL);
        assert!(log["overwrites"].as_array().unwrap().iter().any(|o| o["role"] == "Moderator"));
        let rules = find("rules");
        assert_eq!(rules["overwrites"][0]["deny"].as_str().unwrap().parse::<u64>().unwrap() & SEND_MESSAGES, SEND_MESSAGES);
        assert!(find("general")["overwrites"].as_array().unwrap().is_empty());
        assert_eq!(l["roles"][0]["name"], "Admin");
    }
    #[test]
    fn a_build_only_adds_what_is_missing() {
        let t = template("community").unwrap();
        let none = json!({ "roles": [], "otherRoles": [], "channels": [] });
        let (r, c, hr, hc) = diff(t, &none);
        assert_eq!((r.len(), hr.len(), hc.len()), (2, 0, 0));
        assert!(c.len() > 15);
        let have = json!({ "roles": [{ "name": "Moderator" }], "otherRoles": ["Good Boy"], "channels": [
            { "name": "Info", "type": 4, "parent": null }, { "name": "welcome", "type": 0, "parent": "Info" }, { "name": "general", "type": 0, "parent": "Community" }] });
        let (r, c2, hr, hc) = diff(t, &have);
        assert_eq!((r.len(), hr), (1, vec!["Moderator".to_string()]));
        assert!(hc.contains(&"welcome".to_string()) && hc.contains(&"Info".to_string()) && hc.contains(&"general".to_string()));
        assert_eq!(c2.len(), c.len() - 3, "the three that exist are skipped");
        assert!(c2.iter().all(|c| c["name"] != "welcome"));
    }
    #[test]
    fn the_plan_and_the_picker_are_readable_cards() {
        for t in pickable() {
            let c = plan_card(t, &json!({ "roles": [], "channels": [] }), "1");
            c.check().unwrap_or_else(|e| panic!("{}: {e:?}", t.id));
            assert!(c.to_discord().is_ok() && c.buttons.len() == 2 && c.buttons[0].id == format!("setup:build:{}:1", t.id));
        }
        let p = picker_card();
        p.check().unwrap();
        assert_eq!(p.buttons.len(), 4);
        assert!(plan_card(template("small").unwrap(), &as_layout(template("small").unwrap()), "1").lines.join(" ").contains("already in your server"));
    }
    #[test]
    fn names_are_cleaned_and_snowflakes_read() {
        assert_eq!(snowflake_ms("175928847299117063"), Some(1_462_015_105_796));
        assert!(risky_names(ADMINISTRATOR | MENTION_EVERYONE).contains(&"Mention @everyone"));
        assert_eq!(RISKY_FOR_EVERYONE & (VIEW_CHANNEL | SEND_MESSAGES), 0, "reading and writing are fine for everyone");
    }
}
