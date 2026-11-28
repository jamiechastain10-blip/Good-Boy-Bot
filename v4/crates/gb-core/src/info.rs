//! Good Boy 3's built-in staff commands that every server has: /health, /modules, /module, /channel and /config.
//! They belong to no module (like /help), so they work even when nothing is turned on. All are for staff
//! (Manage Server or Administrator), as in Good Boy 3. /about and /whatsnew are in about.rs.

use crate::bot::{Bot, CommandSpec, Opt, Takes, MODULES};
use crate::settings::Kind;
use crate::{botnews, notify, Action, Area, Card, CommandEvent};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicI64, Ordering};

const MODULE: &str = notify::MODULE;
static STARTED: AtomicI64 = AtomicI64::new(0);
/// The bot started (for the uptime on /health).
pub fn mark_started(now: i64) { let _ = STARTED.compare_exchange(0, now, Ordering::Relaxed, Ordering::Relaxed); }

const ON_OFF: &[(&str, &str)] = &[("Turn on", "on"), ("Turn off", "off")];
const QUIET: &[(&str, &str)] = &[("Quiet in this channel", "quiet"), ("Working in this channel again", "active")];
pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec { name: "health", about: "How the bot is doing in this server (admins)", module: MODULE, options: &[], subs: &[] },
    CommandSpec { name: "modules", about: "Every feature, and which ones are on here (admins)", module: MODULE, options: &[], subs: &[] },
    CommandSpec { name: "module", about: "Turn a feature on or off (admins)", module: MODULE, options: &[
        Opt { name: "module", about: "Which feature, for example levels, money or tickets (see /modules)", takes: Takes::Text, required: true },
        Opt { name: "state", about: "On or off", takes: Takes::Choice(ON_OFF), required: true },
    ], subs: &[] },
    CommandSpec { name: "channel", about: "Choose which features stay quiet in this channel (admins)", module: MODULE, options: &[
        Opt { name: "module", about: "Which feature, for example levels (empty: see what is quiet here)", takes: Takes::Text, required: false },
        Opt { name: "state", about: "Quiet here, or working here again", takes: Takes::Choice(QUIET), required: false },
    ], subs: &[] },
    CommandSpec { name: "config", about: "See or change a feature's settings (admins)", module: MODULE, options: &[
        Opt { name: "module", about: "Which feature, for example levels (empty: list them)", takes: Takes::Text, required: false },
        Opt { name: "setting", about: "The setting to change (empty: show them all)", takes: Takes::Text, required: false },
        Opt { name: "value", about: "Its new value (on/off, a number, a #channel, a @role, text; \"none\" to clear)", takes: Takes::Text, required: false },
    ], subs: &[] },
];

fn private(text: impl Into<String>) -> Vec<Action> { vec![Action::Reply { card: Card::new(Area::General).line(text).private() }] }
fn staff(ev: &CommandEvent) -> bool { ev.member.perms & (crate::perms::ADMINISTRATOR | crate::perms::MANAGE_GUILD) != 0 }
/// "3d 4h 10m" from milliseconds.
pub fn duration(ms: i64) -> String {
    let m = (ms.max(0) / 60_000) as u64;
    let (d, h, m) = (m / 1440, (m / 60) % 24, m % 60);
    if d > 0 { format!("{d}d {h}h {m}m") } else if h > 0 { format!("{h}h {m}m") } else { format!("{m}m") }
}
fn uptime(now: i64) -> String {
    match STARTED.load(Ordering::Relaxed) { 0 => "just started".into(), t => duration(now - t) }
}
/// A module by its id or its name, ignoring case ("levels", "Role menus", "role-menus").
pub fn find_module(text: &str) -> Option<&'static crate::bot::ModuleInfo> {
    let norm = |s: &str| s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    let t = norm(text);
    if t.is_empty() { return None; }
    MODULES.iter().find(|m| norm(m.id) == t || norm(m.name) == t)
        .or_else(|| { let close: Vec<_> = MODULES.iter().filter(|m| norm(m.name).starts_with(&t) || norm(m.id).starts_with(&t)).collect(); if close.len() == 1 { Some(close[0]) } else { None } })
}
fn shown(v: &Value, kind: Kind) -> String {
    match (v, kind) {
        (Value::Null, _) => "*not set*".into(),
        (Value::Bool(b), _) => if *b { "on".into() } else { "off".into() },
        (Value::String(s), Kind::Channel | Kind::Category) if !s.is_empty() => format!("<#{s}>"),
        (Value::String(s), Kind::Role) if !s.is_empty() => format!("<@&{s}>"),
        (Value::String(s), _) if s.is_empty() => "*empty*".into(),
        (Value::String(s), _) => { let s: String = s.chars().take(80).collect(); format!("`{}`", s.replace('`', "'")) }
        (Value::Array(a), _) if a.is_empty() => "*none*".into(),
        (Value::Array(a), _) => { let s = a.iter().map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string())).collect::<Vec<_>>().join(", "); format!("`{}`", s.chars().take(80).collect::<String>()) }
        (other, _) => format!("`{other}`"),
    }
}

impl Bot {
    /// /health, /modules, /module, /channel and /config.
    pub(crate) fn info_command(&self, ev: &CommandEvent) -> Vec<Action> {
        if !staff(ev) { return private("Only server admins (Manage Server) can use that."); }
        let g = &ev.guild;
        match ev.name.as_str() {
            "health" => {
                let on: Vec<&str> = MODULES.iter().filter(|m| self.module_on(g, m.id)).map(|m| m.name).collect();
                let tick = |b: bool| if b { "✅" } else { "❌" };
                let reads = self.directory.reads_messages();
                let mut card = Card::new(Area::General).title("Health")
                    .line(format!("**Version** v{} · **Uptime** {} · **Servers** {}", botnews::VERSION, uptime(ev.at_ms), self.db.get().guilds().map(|x| x.len()).unwrap_or(0)))
                    .line(format!("**Members here** {} · **Licence** {}", self.directory.members(g).map(|n| n.to_string()).unwrap_or_else(|| "?".into()), if self.directory.licensed() { "✅ good" } else { "⚠️ not checked or not valid" }))
                    .line(format!("**Privileged intents**\n{} Message Content{}\n{} Presence", tick(reads), if reads { "" } else { " *(custom commands, AutoMod words, highlights and counting need it)*" }, tick(self.directory.sees_presences())))
                    .line(format!("**Features on here ({})**\n{}", on.len(), if on.is_empty() { "*none*".to_string() } else { on.join(", ") }));
                if !reads || !self.directory.sees_presences() { card = card.line("-# Turn missing intents on in the Discord Developer Portal → your bot → Bot, then restart it."); }
                card.accent = Some(0x57f287);
                vec![Action::Reply { card: card.private() }]
            }
            "modules" => {
                let rows: Vec<String> = MODULES.iter().map(|m| format!("{} **{}** `{}`", if self.module_on(g, m.id) { "✅" } else { "⬜" }, m.name, m.id)).collect();
                let mut card = Card::new(Area::General).title("Features").private();
                for chunk in rows.chunks(18) { card = card.line(chunk.join("\n")); }
                vec![Action::Reply { card: card.line("-# Turn one on or off with `/module`, change its settings with `/config`, or use the dashboard.") }]
            }
            "module" => {
                let Some(m) = ev.args.get("module").and_then(|t| find_module(t)) else { return private("I don't know that feature. `/modules` lists them all."); };
                let on = matches!(ev.args.get("state").map(String::as_str), Some("on" | "true" | "yes"));
                if self.module_on(g, m.id) == on { return private(format!("**{}** is already {}.", m.name, if on { "on" } else { "off" })); }
                match self.set_module(g, m.id, on, ev.at_ms) {
                    Ok(mut out) => { out.insert(0, Action::Reply { card: Card::new(Area::General).line(format!("{} **{}** is now {}.{}", if on { "✅" } else { "⬜" }, m.name, if on { "on" } else { "off" }, if on { format!("\n-# {}", m.about) } else { String::new() })).private() }); out }
                    Err(e) => private(format!("I couldn't change that: {e}")),
                }
            }
            "channel" => {
                let here = ev.place.base().to_string();
                let Some(text) = ev.args.get("module").map(|s| s.trim()).filter(|s| !s.is_empty()) else {
                    let quiet: Vec<&str> = MODULES.iter().filter(|m| ev.place.is_in(&self.settings.off_channels(g, m.id))).map(|m| m.name).collect();
                    return private(if quiet.is_empty() { "Every feature that is on works in this channel. Make one quiet here with `/channel module:<name> state:Quiet`.".to_string() } else { format!("Quiet in this channel (or its category): {}.", quiet.join(", ")) });
                };
                let Some(m) = find_module(text) else { return private("I don't know that feature. `/modules` lists them all."); };
                let quiet = ev.args.get("state").map(String::as_str) != Some("active");
                let mut list = self.settings.off_channels(g, m.id);
                if quiet { if !list.contains(&here) { list.push(here.clone()); } } else { list.retain(|c| c != &here); }
                if let Err(e) = self.settings.set_off_channels(g, m.id, &list) { return private(format!("I couldn't change that: {e}")); }
                let by_category = !quiet && ev.place.is_in(&list);
                private(format!("{} **{}** is {} in <#{here}>.{}", if quiet { "🔇" } else { "🔊" }, m.name, if quiet { "quiet" } else { "working again" }, if by_category { " (It is still quiet in this channel's category; change that on the dashboard.)" } else { "" }))
            }
            "config" => {
                let Some(text) = ev.args.get("module").map(|s| s.trim()).filter(|s| !s.is_empty()) else {
                    return private(format!("Pick a feature: `/config module:<name>`. Features with settings: {}.", MODULES.iter().filter(|m| !self.settings.defs(m.id).is_empty()).map(|m| format!("`{}`", m.id)).collect::<Vec<_>>().join(" ")));
                };
                let Some(m) = find_module(text) else { return private("I don't know that feature. `/modules` lists them all."); };
                let defs = self.settings.defs(m.id);
                if defs.is_empty() { return private(format!("**{}** has no settings to change here.", m.name)); }
                if let Some(key) = ev.args.get("setting").map(|s| s.trim()).filter(|s| !s.is_empty()) {
                    let norm = |s: &str| s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
                    let Some(def) = defs.iter().find(|d| norm(d.key) == norm(key) || norm(d.label) == norm(key)) else { return private(format!("**{}** has no setting called `{}`. `/config module:{}` lists them.", m.name, key.chars().take(40).collect::<String>(), m.id)); };
                    let Some(value) = ev.args.get("value") else { return private(format!("**{}** is {}. Give a `value` to change it.", def.label, shown(&self.settings.get(g, m.id, def.key), def.kind))); };
                    let raw = match def.kind { Kind::List => json!(value.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>()), _ => json!(value.trim()) };
                    return match self.settings.set(g, m.id, def.key, &raw) {
                        Ok(v) => private(format!("✅ **{}** is now {}.", def.label, shown(&v, def.kind))),
                        Err(e) => private(format!("❌ {e}")),
                    };
                }
                let rows: Vec<String> = defs.iter().map(|d| format!("`{}` · {}: {}", d.key, d.label, shown(&self.settings.get(g, m.id, d.key), d.kind))).collect();
                let mut card = Card::new(Area::General).title(format!("{} settings{}", m.name, if self.module_on(g, m.id) { "" } else { " (this feature is off)" })).private();
                let mut part = String::new();
                for r in rows { if part.len() + r.len() > 1000 { card = card.line(std::mem::take(&mut part)); } part.push_str(&r); part.push('\n'); }
                if !part.is_empty() { card = card.line(part); }
                vec![Action::Reply { card: card.line(format!("-# Change one: `/config module:{} setting:<name> value:<new value>`. The dashboard has the same settings with pickers.", m.id)) }]
            }
            _ => private("Unknown command."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finds_modules_by_id_or_name() {
        assert_eq!(find_module("levels").map(|m| m.id), Some(crate::levels::MODULE));
        assert_eq!(find_module("Role menus").map(|m| m.id), Some(crate::roles::MODULE));
        assert!(find_module("").is_none());
        assert!(find_module("nothing-like-this").is_none());
    }
    #[test]
    fn durations() {
        assert_eq!(duration(0), "0m");
        assert_eq!(duration(90 * 60_000), "1h 30m");
        assert_eq!(duration(26 * 3_600_000), "1d 2h 0m");
    }
}
