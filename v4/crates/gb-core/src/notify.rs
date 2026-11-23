//! Good Boy 3's notification choices. Everything that pings, DMs or announces to a member asks `allowed` first, so
//! no feature gets around a member's opt-out. A member's own choice wins, then the server's default, then the
//! category's own default. `/notifications view|set|server-default`, with Good Boy 3's wording.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::{Action, Area, Card, CommandEvent, Db};

pub const MODULE: &str = "core";
/// (category, label, on unless someone chose otherwise)
pub const CATEGORIES: &[(&str, &str, bool)] = &[
    ("game-pings", "Game pings (LFG and game role pings)", true),
    ("party-invites", "Party invitations", true),
    ("achievements", "Achievement announcements", true),
    ("recaps", "Weekly / monthly activity recaps", false),
    ("event-reminders", "Event reminders", true),
    ("minecraft", "Minecraft notifications", true),
    ("dms", "Direct messages from the bot", true),
];
const CHOICES: &[(&str, &str)] = &[("game-pings", "game-pings"), ("party-invites", "party-invites"), ("achievements", "achievements"), ("recaps", "recaps"), ("event-reminders", "event-reminders"), ("minecraft", "minecraft"), ("dms", "dms")];
const SET: &[Opt] = &[Opt { name: "category", about: "What kind", takes: Takes::Choice(CHOICES), required: true }, Opt { name: "enabled", about: "On or off", takes: Takes::YesNo, required: true }];
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "help", about: "See what this bot can do in this server", module: MODULE, options: &[], subs: &[] }, CommandSpec { name: "notifications", about: "Choose which optional pings and messages you get", module: MODULE, options: &[], subs: &[
    Sub { name: "view", about: "See your current choices", options: &[] },
    Sub { name: "set", about: "Turn a kind of notification on or off for yourself", options: SET },
    Sub { name: "server-default", about: "(Admins) Set this server's default for a kind of notification", options: SET },
] }];

/// Whether a member gets this kind of notification here. Unknown kinds are never allowed.
pub fn allowed(db: &Db, guild: &str, user: &str, category: &str) -> bool {
    let Some((_, _, default)) = CATEGORIES.iter().find(|c| c.0 == category) else { return false };
    let own = db.get().notify_pref(guild, user, category).ok().flatten();
    if let Some(v) = own { return v; }
    let server = db.get().notify_pref(guild, "*", category).ok().flatten();
    server.unwrap_or(*default)
}

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
pub fn command(db: &Db, ev: &CommandEvent) -> Vec<Action> {
    let sub = ev.sub.as_deref().unwrap_or("view");
    if sub == "view" {
        let rows: Vec<String> = CATEGORIES.iter().map(|(c, label, _)| {
            let own = db.get().notify_pref(&ev.guild, &ev.member.id, c).ok().flatten();
            let server = db.get().notify_pref(&ev.guild, "*", c).ok().flatten();
            let source = if own.is_some() { "you" } else if server.is_some() { "server" } else { "default" };
            format!("{} **{c}** - {label} *({source})*", if allowed(db, &ev.guild, &ev.member.id, c) { "✅" } else { "❌" })
        }).collect();
        let mut card = Card::new(Area::General).title("Your notifications").line(rows.join("\n")).line("-# Change with /notifications set").private();
        card.accent = Some(0x5865f2);
        return vec![Action::Reply { card }];
    }
    let Some(category) = ev.args.get("category").filter(|c| CATEGORIES.iter().any(|x| x.0 == c.as_str())) else { return private("Unknown category.") };
    let on = matches!(ev.args.get("enabled").map(String::as_str), Some("true" | "yes" | "on" | "1"));
    if sub == "server-default" {
        if ev.member.perms & (crate::perms::ADMINISTRATOR | crate::perms::MANAGE_GUILD) == 0 { return private("Only server admins can change server defaults."); }
        let _ = db.get().set_notify_pref(&ev.guild, "*", category, on, ev.at_ms);
        return private(format!("Server default for **{category}** is now {}. Members can still choose for themselves.", if on { "on" } else { "off" }));
    }
    let _ = db.get().set_notify_pref(&ev.guild, &ev.member.id, category, on, ev.at_ms);
    private(format!("{} **{category}** is now {} for you in this server.", if on { "✅" } else { "❌" }, if on { "on" } else { "off" }))
}
