//! Good Boy 3's server backups: a snapshot of the roles, categories, channels and channel permissions (the last 10,
//! and an optional weekly one). Restoring shows what is missing first, then puts back only that: nothing that is
//! still there is deleted or changed. The snapshot is Good Boy 3's JSON, made by the Discord layer from the server.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm, ADMINISTRATOR};
use crate::settings::Fallback;
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Def, Kind, Settings};
use serde_json::Value;

pub const MODULE: &str = "backup";
pub const MANAGE: Perm = Perm { key: "backup.manage", level: Level::Admin };
pub static SETTINGS: &[Def] = &[Def { key: "weekly", label: "Make a backup automatically once a week", kind: Kind::Toggle, default: Fallback::Bool(true) }];
const ID: Opt = Opt { name: "id", about: "Backup number", takes: Takes::Whole { min: 1, max: 1_000_000_000 }, required: true };
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "backup", about: "Server backups: roles, channels and permissions", module: MODULE, options: &[], subs: &[
    Sub { name: "create", about: "Make a backup now", options: &[] },
    Sub { name: "list", about: "The saved backups", options: &[] },
    Sub { name: "restore", about: "Put back what is missing (shows you first)", options: &[ID] },
    Sub { name: "download", about: "Get a backup as a file", options: &[ID] },
] }];
/// Category, text, voice, announcement, stage, forum.
pub const KINDS: &[i64] = &[4, 0, 2, 5, 13, 15];

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
fn stamp(ms: i64) -> String {
    format!("<t:{}:f>", ms / 1000)
}
fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}
fn plural(n: i64, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

/// What restoring would add (Good Boy 3's plan): roles and channels in the backup that the server doesn't have,
/// matched by name (and for channels by kind and category). `now` is the server's own snapshot.
pub fn plan(data: &Value, now: &Value) -> (Vec<Value>, Vec<Value>) {
    let mut have_roles: Vec<&str> = now["roles"].as_array().into_iter().flatten().filter_map(|r| r["name"].as_str()).collect();
    have_roles.extend(now["otherRoles"].as_array().into_iter().flatten().filter_map(|r| r.as_str()));
    let key = |c: &Value| format!("{}|{}|{}", c["type"], c["name"].as_str().unwrap_or(""), c["parent"].as_str().unwrap_or(""));
    let have_ch: Vec<String> = now["channels"].as_array().into_iter().flatten().map(key).collect();
    let roles = data["roles"].as_array().into_iter().flatten().filter(|r| !have_roles.contains(&r["name"].as_str().unwrap_or(""))).cloned().collect();
    let channels = data["channels"].as_array().into_iter().flatten().filter(|c| !have_ch.contains(&key(c))).cloned().collect();
    (roles, channels)
}

pub fn command(db: &Db, ev: &CommandEvent) -> Vec<Action> {
    if !perms::allowed(db, &ev.guild, &ev.member, MANAGE) { return private(format!("You don't have permission for that (`{}`).", MANAGE.key)); }
    let id = ev.args.get("id").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    match ev.sub.as_deref().unwrap_or("list") {
        "create" => vec![Action::Backup { id: None, by: ev.member.id.clone(), restore: false }],
        "list" => {
            let rows = db.get().backups(&ev.guild).unwrap_or_default();
            let lines: Vec<String> = rows.iter().map(|(id, at, by, roles, channels)| format!("**#{id}** · {} · {roles} roles, {channels} channels · {}", stamp(*at), match by.as_deref() { Some("auto") => "automatic".to_string(), Some(b) => format!("by <@{b}>"), None => "by someone".into() })).collect();
            vec![Action::Reply { card: Card::new(Area::General).title("💾 Backups").line(if lines.is_empty() { "No backups yet. Make one with `/backup create`.".to_string() } else { lines.join("\n") }).private() }]
        }
        sub => {
            let Some((at, data)) = db.get().backup(&ev.guild, id).ok().flatten() else { return private(format!("There's no backup #{id}. See `/backup list`.")) };
            if sub == "download" {
                let pretty = serde_json::from_str::<Value>(&data).ok().and_then(|v| serde_json::to_string_pretty(&v).ok()).unwrap_or(data);
                return vec![Action::Reply { card: Card::new(Area::General).line(format!("Backup #{id} ({}).", stamp(at))).file(&format!("good-boy-backup-{id}.json"), pretty.into_bytes()).private() }];
            }
            if ev.member.perms & ADMINISTRATOR == 0 { return private("Restoring a backup needs the Administrator permission in Discord."); }
            vec![Action::Backup { id: Some(id), by: ev.member.id.clone(), restore: false }]
        }
    }
}
/// The Discord layer made a snapshot of the server for `/backup create`: saved, and what to say.
pub fn saved(db: &Db, guild: &str, by: &str, data: &Value, now: i64) -> Card {
    let (roles, channels) = (data["roles"].as_array().map(|a| a.len()).unwrap_or(0) as i64, data["channels"].as_array().map(|a| a.len()).unwrap_or(0) as i64);
    let mut keep = data.clone();
    if let Some(o) = keep.as_object_mut() { o.remove("otherRoles"); }
    match db.get().backup_save(guild, now, by, &keep.to_string(), roles, channels) {
        Ok(id) => Card::new(Area::General).line(format!("💾 Backup **#{id}** saved: {roles} roles and {channels} channels and categories, with their permissions. The last {} are kept.", gb_data::backup::KEEP)).private(),
        Err(e) => Card::new(Area::General).line(format!("The backup could not be saved: {e}")).private(),
    }
}
/// The preview before a restore: what would be put back (or that nothing is missing).
pub fn preview(db: &Db, guild: &str, id: i64, owner: &str, now_layout: &Value) -> Card {
    let Some((_, data)) = db.get().backup(guild, id).ok().flatten() else { return Card::new(Area::General).line(format!("There's no backup #{id}. See `/backup list`.")).private() };
    let data: Value = serde_json::from_str(&data).unwrap_or_default();
    let (roles, channels) = plan(&data, now_layout);
    if roles.is_empty() && channels.is_empty() { return Card::new(Area::General).line(format!("✅ Nothing is missing compared to backup #{id}.")).private(); }
    let names = |list: &[Value]| list.iter().filter_map(|r| r["name"].as_str()).collect::<Vec<_>>().join(", ");
    let chans = channels.iter().map(|c| format!("{}{}", if c["type"] == 4 { "📁" } else { "#" }, c["name"].as_str().unwrap_or(""))).collect::<Vec<_>>().join(", ");
    Card::new(Area::Moderation).title(format!("Restore backup #{id}?"))
        .line("These are in the backup but not in the server, so they would be added back. **Nothing is deleted or changed.**")
        .line(format!("**Roles ({})**\n{}", roles.len(), short(&Some(names(&roles)).filter(|n| !n.is_empty()).unwrap_or_else(|| "none".into()), 1000)))
        .line(format!("**Channels ({})**\n{}", channels.len(), short(if chans.is_empty() { "none" } else { &chans }, 1000)))
        .button_with(format!("backup:go:{id}:{owner}"), "Put them back", ButtonStyle::Danger, Some("♻️".into())).private()
}
/// "Put them back": only the person who asked, and only an administrator.
pub fn press(db: &Db, ev: &ButtonEvent) -> Vec<Action> {
    let p: Vec<&str> = ev.id.split(':').collect();
    let (id, owner) = (p.get(2).and_then(|v| v.parse::<i64>().ok()).unwrap_or(0), p.get(3).copied().unwrap_or(""));
    if ev.member.id != owner { return private("Only the person who asked can confirm."); }
    if ev.member.perms & ADMINISTRATOR == 0 { return private("Restoring a backup needs the Administrator permission in Discord."); }
    if db.get().backup(&ev.guild, id).ok().flatten().is_none() { return private(format!("There's no backup #{id}. See `/backup list`.")); }
    vec![Action::Backup { id: Some(id), by: ev.member.id.clone(), restore: true }]
}
/// What a restore did, in Good Boy 3's words.
pub fn restored(roles: usize, channels: usize, failed: &[String]) -> Card {
    let s = |n: usize, w: &str| plural(n as i64, w);
    let mut text = format!("✅ Added back {} and {}.", s(roles, "role"), s(channels, "channel"));
    if !failed.is_empty() { text += &format!("\n⚠️ Couldn't add {}: {}\n-# My role must be above roles I create, and I need Manage Roles and Manage Channels.", failed.len(), short(&failed.join("; "), 800)); }
    Card::new(Area::General).line(text).private()
}
/// The servers due an automatic backup (a week since the last one, when `weekly` is on).
pub fn weekly_due(db: &Db, settings: &Settings, guilds: &[String], now: i64) -> Vec<String> {
    guilds.iter().filter(|g| settings.bool(g, MODULE, "weekly") && now - db.get().last_auto_backup(g).unwrap_or(0) >= 7 * 86_400_000).cloned().collect()
}
