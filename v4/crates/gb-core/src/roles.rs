//! Role menus (buttons or a dropdown), reaction roles, automatic roles on join, and roles that run out.
//! Saved the way Good Boy 3 saves them, so menus posted there keep working here.
//!
//! The bot never hands out a role with powerful permissions, a role above its own, or (when someone sets one
//! up) a role at or above that person's highest role.
//! Game roles (a role while someone plays a game) need Discord's Presence Intent, switched on by the bot's owner.

use crate::bot::{CommandSpec, Directory, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::store::Data;
use crate::time::HOUR;
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Def, Kind, Member, Select};
use serde_json::{json, Value};

pub const MODULE: &str = "roles";
pub static SETTINGS: &[Def] = &[Def { key: "gameRoleRemove", label: "Remove a game role when the member stops playing", kind: Kind::Toggle, default: Fallback::Bool(true) }];
pub const MANAGE: Perm = Perm { key: "roles.manage", level: Level::Moderator(Some(1 << 28)) };
const fn role_opt(name: &'static str, about: &'static str, required: bool) -> Opt {
    Opt { name, about, takes: Takes::Role, required }
}
const MSG: Opt = Opt { name: "message_id", about: "The menu message ID", takes: Takes::Text, required: true };
const MAX: Opt = Opt { name: "max", about: "Most roles one member can pick from this menu", takes: Takes::Whole { min: 1, max: 25 }, required: false };
const NEEDS: Opt = Opt { name: "needs", about: "Only members with this role can use the menu", takes: Takes::Role, required: false };
const HOURS: Opt = Opt { name: "hours", about: "Roles from this menu are taken away after this many hours", takes: Takes::Whole { min: 1, max: 2160 }, required: false };
const WHO: Opt = Opt { name: "for", about: "Who gets it", takes: Takes::Choice(&[("members", "members"), ("bots", "bots")]), required: false };
pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec { name: "rolemenu", about: "Post a self-service role menu in this channel", module: MODULE, options: &[], subs: &[
        Sub { name: "create", about: "Create a menu (up to 10 roles)", options: &[
            Opt { name: "title", about: "Menu title", takes: Takes::Text, required: false },
            role_opt("role1", "Role 1 (leave everything empty for a popup)", false), role_opt("role2", "Role 2", false), role_opt("role3", "Role 3", false), role_opt("role4", "Role 4", false), role_opt("role5", "Role 5", false),
            role_opt("role6", "Role 6", false), role_opt("role7", "Role 7", false), role_opt("role8", "Role 8", false), role_opt("role9", "Role 9", false), role_opt("role10", "Role 10", false),
            Opt { name: "description", about: "Text under the title", takes: Takes::Text, required: false },
            Opt { name: "style", about: "Buttons or a dropdown", takes: Takes::Choice(&[("buttons", "buttons"), ("dropdown", "dropdown")]), required: false },
            Opt { name: "mode", about: "Can members hold several?", takes: Takes::Choice(&[("several (toggle)", "toggle"), ("only one", "unique")]), required: false },
            MAX, NEEDS, HOURS,
        ] },
        Sub { name: "limits", about: "Change an existing menu's limits (run it in the menu's channel)", options: &[MSG,
            Opt { name: "max", about: "Most roles one member can pick (empty = no limit)", takes: Takes::Whole { min: 1, max: 25 }, required: false },
            Opt { name: "needs", about: "Only members with this role can use it (empty = everyone)", takes: Takes::Role, required: false },
            Opt { name: "hours", about: "Roles are taken away after this many hours (empty = they stay)", takes: Takes::Whole { min: 1, max: 2160 }, required: false }] },
        Sub { name: "delete", about: "Stop a menu working and delete it", options: &[MSG] },
    ] },
    CommandSpec { name: "reactionrole", about: "Roles from message reactions", module: MODULE, options: &[], subs: &[
        Sub { name: "add", about: "React on a message to get a role", options: &[
            Opt { name: "message_id", about: "Message ID (in this channel)", takes: Takes::Text, required: true },
            Opt { name: "emoji", about: "The emoji", takes: Takes::Text, required: true },
            role_opt("role", "The role", true),
        ] },
        Sub { name: "remove", about: "Remove a reaction role", options: &[Opt { name: "message_id", about: "Message ID", takes: Takes::Text, required: true }, Opt { name: "emoji", about: "The emoji", takes: Takes::Text, required: true }] },
        Sub { name: "list", about: "Show all reaction roles", options: &[] },
    ] },
    CommandSpec { name: "autorole", about: "Roles given automatically on join", module: MODULE, options: &[], subs: &[
        Sub { name: "add", about: "Add an automatic role", options: &[role_opt("role", "The role", true), WHO] },
        Sub { name: "remove", about: "Remove an automatic role", options: &[role_opt("role", "The role", true), WHO] },
        Sub { name: "list", about: "Show automatic roles", options: &[] },
    ] },
    CommandSpec { name: "gamerole", about: "Give a role while members play a game", module: MODULE, options: &[], subs: &[
        Sub { name: "add", about: "Link a game to a role", options: &[Opt { name: "game", about: "Game name exactly as Discord shows it, e.g. Minecraft", takes: Takes::Text, required: true }, role_opt("role", "Role to give", true)] },
        Sub { name: "remove", about: "Unlink a game", options: &[Opt { name: "game", about: "Game name", takes: Takes::Text, required: true }] },
        Sub { name: "list", about: "Show linked games", options: &[] },
    ] },
];

/// Good Boy 3's "New role menu" popup (opened by /rolemenu create with nothing filled in).
pub fn menu_form(owner: &str) -> Action {
    use crate::{Field, FieldKind};
    let fields = vec![
        Field { id: "title".into(), label: "Title".into(), required: true, max: 200, placeholder: Some("Pick your roles".into()), ..Default::default() },
        Field { id: "description".into(), label: "Text under the title (optional)".into(), long: true, max: 1500, ..Default::default() },
        Field { id: "roles".into(), label: "Roles people can pick".into(), kind: FieldKind::Role { most: 10 }, required: true, ..Default::default() },
        Field { id: "style".into(), label: "Look".into(), kind: FieldKind::Select(vec![("Buttons".into(), "buttons".into()), ("Dropdown list".into(), "dropdown".into())]), required: true, value: Some("buttons".into()), ..Default::default() },
        Field { id: "mode".into(), label: "How many can each person have".into(), kind: FieldKind::Select(vec![("Several".into(), "toggle".into()), ("Only one".into(), "unique".into())]), required: true, value: Some("toggle".into()), hints: vec!["Click to add or remove each role".into(), "Choosing another swaps it".into()], ..Default::default() },
    ];
    Action::Form { id: format!("rolemenu:form:{owner}"), title: "New role menu".into(), fields }
}

/// Administrator, Manage Server, Roles, Channels, Webhooks and Messages, Ban, Kick, Time out, and @everyone.
const DANGEROUS: u64 = (1 << 3) | (1 << 5) | (1 << 28) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 29) | (1 << 13) | (1 << 40) | (1 << 17);

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}
fn plural(n: i64, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}
fn ids(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

/// Why the bot must not hand this role out (None means it may). `actor` adds "must be below the person setting it up".
pub fn grant_problem(dir: &Directory, guild: &str, role: &str, actor: Option<&Member>) -> Option<String> {
    if role == guild { return Some("@everyone can't be used here.".into()); }
    let Some(r) = dir.role(guild, role) else { return Some("That role no longer exists.".into()) };
    if r.managed { return Some(format!("**{}** is managed by an integration.", r.name)); }
    if r.perms & DANGEROUS != 0 {
        return Some(format!("**{}** has powerful permissions (like Administrator, Manage Server/Roles/Channels, ban/kick, timeout, delete messages or @everyone). I won't hand that out automatically.", r.name));
    }
    if dir.my_top(guild).is_some_and(|top| r.position >= top) {
        return Some(format!("**{}** is above my highest role - move my role up in Server Settings > Roles.", r.name));
    }
    if let Some(a) = actor {
        if dir.owner(guild).as_deref() != Some(a.id.as_str()) {
            let theirs = a.roles.iter().filter_map(|x| dir.role(guild, x)).map(|x| x.position).max().unwrap_or(0);
            if r.position >= theirs { return Some(format!("**{}** is at or above your own highest role.", r.name)); }
        }
    }
    None
}

/// Why a member cannot make this choice on a menu, or None.
pub fn limit_problem(menu: &Value, member_roles: &[String], wanted: &[String]) -> Option<String> {
    if let Some(needs) = menu["needs"].as_str().filter(|n| !n.is_empty()) {
        if !member_roles.iter().any(|r| r == needs) { return Some(format!("You need the <@&{needs}> role to use this menu.")); }
    }
    let before = ids(&menu["roleIds"]).iter().filter(|r| member_roles.contains(r)).count();
    let max = menu["max"].as_i64().unwrap_or(0) as usize;
    if max > 0 && menu["mode"] != "unique" && wanted.len() > max && wanted.len() > before {
        return Some(format!("You can have up to {max} role{} from this menu. Take one off first.", if max == 1 { "" } else { "s" }));
    }
    None
}

/// The menu message: the roles with their emoji, and a button each or a dropdown.
pub fn menu_card(dir: &Directory, guild: &str, menu: &Value, counts: &std::collections::HashMap<String, i64>) -> Card {
    let roles: Vec<(String, String)> = ids(&menu["roleIds"]).into_iter().filter_map(|id| dir.role(guild, &id).map(|r| (id, r.name))).collect();
    let emoji = |id: &str| menu["emojis"][id].as_str().map(str::to_string);
    let lines: Vec<String> = roles.iter().map(|(id, _)| format!("{}<@&{id}>{}", emoji(id).map(|e| format!("{e} ")).unwrap_or_default(), counts.get(id).map(|n| format!(" · **{n}** {}", if *n == 1 { "member" } else { "members" })).unwrap_or_default())).collect();
    let max = menu["max"].as_i64().unwrap_or(0);
    let hours = menu["hours"].as_i64().unwrap_or(0);
    let mut foot = vec![if menu["mode"] == "unique" { "Pick one. Choosing another swaps it.".to_string() } else if max > 0 { format!("Pick up to {max}. Tap again to take one off.") } else { "Tap a button to add or remove a role. Tap again to take it off.".to_string() }];
    if hours > 0 { foot.push(format!("Roles last {}.", plural(hours, "hour"))); }
    let mut body: Vec<String> = menu["description"].as_str().filter(|d| !d.is_empty()).map(|d| vec![d.to_string()]).unwrap_or_default();
    body.push(if lines.is_empty() { "*The roles on this menu are gone.*".to_string() } else { lines.join("\n") });
    if let Some(needs) = menu["needs"].as_str().filter(|n| !n.is_empty()) { body.push(format!("🔒 Only for members with <@&{needs}>.")); }
    body.push(format!("-# {}", foot.join(" ")));
    let mut card = Card::new(Area::General).title(short(menu["title"].as_str().filter(|t| !t.is_empty()).unwrap_or("Pick your roles"), 200)).line(short(&body.join("\n\n"), 3800));
    if roles.is_empty() { return card; }
    if menu["type"] == "dropdown" {
        let most = if menu["mode"] == "unique" { 1 } else { (roles.len().min(25) as i64).min(if max > 0 { max } else { 25 }).max(1) };
        card = card.select(Select { id: "rolemenu:sel".into(), placeholder: "Choose your roles".into(), min: 0, max: most as u8, options: roles.iter().take(25).map(|(id, name)| (short(name, 100), id.clone(), emoji(id))).collect() });
    } else {
        // up to 25 buttons, five to a row (Good Boy 3's limit)
        for (id, name) in roles.iter().take(25) {
            card = card.button_with(format!("rolemenu:btn:{id}"), short(name, 80), ButtonStyle::Plain, emoji(id));
        }
        card = card.grid(5);
    }
    card
}

pub struct Roles<'a> {
    pub db: &'a Db,
    pub dir: &'a Directory,
    pub guild: &'a str,
}
impl Roles<'_> {
    fn data(&self) -> Data<'_> {
        Data { db: self.db, guild: self.guild, module: MODULE }
    }
    /// How many members hold each of a menu's roles.
    fn counts(&self, menu: &Value) -> std::collections::HashMap<String, i64> {
        let roles = ids(&menu["roleIds"]);
        self.db.get().roster_role_counts(self.guild, &roles).unwrap_or_default()
    }
    fn name(&self, role: &str) -> String {
        self.dir.role(self.guild, role).map(|r| r.name).unwrap_or_else(|| "a deleted role".into())
    }

    pub fn command(&self, ev: &CommandEvent) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private("You don't have permission for that (`roles.manage`)."); }
        let arg = |k: &str| ev.args.get(k).map(String::as_str).filter(|s| !s.trim().is_empty());
        let d = self.data();
        match (ev.name.as_str(), ev.sub.as_deref().unwrap_or("list")) {
            ("rolemenu", "create") => {
                let mut picked: Vec<String> = Vec::new();
                for n in 1..=10 {
                    if let Some(r) = arg(&format!("role{n}")) { if !picked.iter().any(|p| p == r) { picked.push(r.to_string()); } }
                }
                // from the popup: the roles picked together
                for r in arg("roles").unwrap_or("").split(',').map(str::trim).filter(|r| !r.is_empty()) {
                    if self.dir.role(self.guild, r).is_some() && !picked.iter().any(|p| p == r) { picked.push(r.to_string()); }
                }
                if arg("title").is_none() && picked.is_empty() {
                    if ev.from_form && ev.args.contains_key("roles") { return private("Choose at least one role."); }
                    return vec![menu_form(&ev.member.id)];
                }
                if arg("title").is_none() || picked.is_empty() { return private("Fill in a title and at least one role, or leave everything empty to use the popup."); }
                for r in &picked {
                    if let Some(no) = grant_problem(self.dir, self.guild, r, Some(&ev.member)) { return private(no); }
                }
                let menu = json!({
                    "roleIds": picked, "emojis": {}, "mode": arg("mode").unwrap_or("toggle"), "type": arg("style").unwrap_or("buttons"),
                    "title": short(arg("title").unwrap_or("Pick your roles"), 200), "description": arg("description").map(|t| short(t, 1500)), "from": null,
                    "max": arg("max").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0), "needs": arg("needs"), "hours": arg("hours").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0),
                    "channelId": ev.place.channel,
                });
                let token = d.next("pending:counter");
                d.set(&format!("pending:{token}"), &menu);
                let mut out = private(format!("Role menu posted in <#{}>.", ev.place.channel));
                out.push(Action::Post { channel: ev.place.channel.clone(), card: menu_card(self.dir, self.guild, &menu, &self.counts(&menu)), note: format!("rolemenu:{token}"), ping: Vec::new(), roles: Vec::new() });
                out
            }
            ("rolemenu", sub @ ("limits" | "delete")) => {
                let id = arg("message_id").unwrap_or("").trim().to_string();
                let Some(mut menu) = d.get(&format!("menu:{id}")) else { return private("No menu with that message ID.") };
                let channel = menu["channelId"].as_str().unwrap_or(&ev.place.channel).to_string();
                if sub == "delete" {
                    d.delete(&format!("menu:{id}"));
                    let mut out = private("Menu removed.");
                    out.push(Action::Delete { channel, message: id });
                    return out;
                }
                if let Some(n) = arg("needs") { if self.dir.role(self.guild, n).is_none() { return private("That role is gone."); } }
                menu["max"] = json!(arg("max").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0));
                menu["needs"] = json!(arg("needs"));
                menu["hours"] = json!(arg("hours").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0));
                d.set(&format!("menu:{id}"), &menu);
                let (max, hours) = (menu["max"].as_i64().unwrap_or(0), menu["hours"].as_i64().unwrap_or(0));
                let said = [if max > 0 { format!("Up to **{max}** at once") } else { "No limit on how many".into() }, arg("needs").map(|n| format!("only for <@&{n}>")).unwrap_or_else(|| "open to everyone".into()), if hours > 0 { format!("roles last **{hours} h**") } else { "roles stay".into() }];
                let mut out = private(format!("Saved. {}.", said.join(" · ")));
                out.push(Action::Edit { channel, message: id, card: menu_card(self.dir, self.guild, &menu, &self.counts(&menu)) });
                out
            }
            ("reactionrole", "add") => {
                let mid = arg("message_id").unwrap_or("").trim().to_string();
                if !(17..=20).contains(&mid.len()) || !mid.bytes().all(|b| b.is_ascii_digit()) { return private("That is not a message ID. Right-click the message > Copy Message ID."); }
                let role = arg("role").unwrap_or("");
                if let Some(no) = grant_problem(self.dir, self.guild, role, Some(&ev.member)) { return private(no); }
                let emoji = arg("emoji").unwrap_or("").trim().to_string();
                d.set(&format!("rr:{mid}:{}", emoji_key(&emoji)), &json!(role));
                let mut out = private(format!("Reacting with {emoji} on that message now gives **{}**.", self.name(role)));
                out.push(Action::React { channel: ev.place.channel.clone(), message: mid, emoji });
                out
            }
            ("reactionrole", "remove") => {
                let key = format!("rr:{}:{}", arg("message_id").unwrap_or("").trim(), emoji_key(arg("emoji").unwrap_or("")));
                if d.get(&key).is_none() { return private("No reaction role matches that."); }
                d.delete(&key);
                private("Removed.")
            }
            ("reactionrole", _) => {
                let rows: Vec<String> = d.list("rr:").into_iter().map(|(k, v)| {
                    let mut parts = k.splitn(3, ':').skip(1);
                    let (mid, em) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
                    let em = if em.len() >= 15 && em.bytes().all(|b| b.is_ascii_digit()) { format!("(custom emoji {em})") } else { em.to_string() };
                    format!("message `{mid}` {em} → <@&{}>", v.as_str().unwrap_or(""))
                }).collect();
                private(if rows.is_empty() { "No reaction roles yet.".to_string() } else { short(&rows.join("\n"), 1900) })
            }
            ("autorole", sub) => {
                let key = format!("autorole:{}", arg("for").unwrap_or("members"));
                if sub == "list" {
                    let f = |k: &str| { let l = ids(&d.get(k).unwrap_or_default()); if l.is_empty() { "*none*".to_string() } else { l.iter().map(|r| format!("<@&{r}>")).collect::<Vec<_>>().join(" ") } };
                    return private(format!("Members: {}\nBots: {}", f("autorole:members"), f("autorole:bots")));
                }
                let role = arg("role").unwrap_or("").to_string();
                let mut list = ids(&d.get(&key).unwrap_or_default());
                if sub == "add" {
                    if let Some(no) = grant_problem(self.dir, self.guild, &role, Some(&ev.member)) { return private(no); }
                    if !list.contains(&role) { list.push(role.clone()); }
                    list.truncate(10);
                } else {
                    list.retain(|r| r != &role);
                }
                d.set(&key, &json!(list));
                let who = if key.ends_with("bots") { "bots" } else { "members" };
                private(format!("Done. {} {who} {} **{}**.", if sub == "add" { "New" } else { "Future" }, if sub == "add" { "will get" } else { "will no longer get" }, self.name(&role)))
            }
            ("gamerole", "list") => {
                let rows: Vec<String> = d.list("game:").into_iter().map(|(k, v)| format!("**{}** → <@&{}>", &k[5..], v.as_str().unwrap_or(""))).collect();
                private(if rows.is_empty() { "No games linked yet.".to_string() } else { rows.join("\n") })
            }
            ("gamerole", sub) => {
                let game = short(arg("game").unwrap_or("").trim(), 100).to_lowercase();
                if game.is_empty() { return private("Fill in **Game**."); }
                if sub == "remove" { d.delete(&format!("game:{game}")); return private("Unlinked."); }
                let role = arg("role").unwrap_or("").to_string();
                if let Some(no) = grant_problem(self.dir, self.guild, &role, Some(&ev.member)) { return private(no); }
                d.set(&format!("game:{game}"), &json!(role));
                let warn = if self.dir.sees_presences() { "" } else { "\n⚠️ I can't see activities yet: enable **Presence Intent** in the Developer Portal (Bot > Privileged Gateway Intents) and restart me." };
                private(format!("Members playing **{game}** will get **{}**.{warn}", self.name(&role)))
            }
            _ => private("Use `/rolemenu`, `/reactionrole`, `/autorole` or `/gamerole`."),
        }
    }

    /// A button or the dropdown on a role menu.
    pub fn press(&self, ev: &ButtonEvent, rest: &str) -> Vec<Action> {
        let d = self.data();
        let Some(menu) = d.get(&format!("menu:{}", ev.message)) else { return private("This menu is no longer active.") };
        let menu_roles = ids(&menu["roleIds"]);
        let has = |r: &str| ev.member.roles.iter().any(|x| x == r);
        let wanted: Vec<String> = if rest == "sel" {
            ev.values.iter().filter(|v| menu_roles.contains(v)).cloned().collect()
        } else {
            let id = rest.strip_prefix("btn:").unwrap_or("");
            if !menu_roles.iter().any(|r| r == id) { return private("That role is not part of this menu."); }
            if menu["mode"] == "unique" {
                if has(id) { Vec::new() } else { vec![id.to_string()] }
            } else {
                let mut w: Vec<String> = menu_roles.iter().filter(|r| has(r) && r.as_str() != id).cloned().collect();
                if !has(id) { w.push(id.to_string()); }
                w
            }
        };
        if let Some(no) = limit_problem(&menu, &ev.member.roles, &wanted) { return private(no); }
        let (mut adds, mut removes, mut skipped) = (Vec::new(), Vec::new(), Vec::new());
        for id in &menu_roles {
            let want = wanted.contains(id);
            if want == has(id) { continue; }
            if let Some(no) = grant_problem(self.dir, self.guild, id, None) { skipped.push(no); continue; }
            if want { adds.push(id.clone()) } else { removes.push(id.clone()) }
        }
        let hours = menu["hours"].as_i64().unwrap_or(0);
        for r in &adds {
            if hours > 0 { d.set(&format!("temp:{}:{r}", ev.member.id), &json!(ev.at_ms + hours * HOUR)); }
        }
        for r in &removes { d.delete(&format!("temp:{}:{r}", ev.member.id)); }
        let names = |list: &[String]| list.iter().map(|r| format!("**{}**", self.name(r))).collect::<Vec<_>>().join(", ");
        let mut said = Vec::new();
        if !adds.is_empty() { said.push(format!("Added {}{}", names(&adds), if hours > 0 { format!(" for {}", plural(hours, "hour")) } else { String::new() })); }
        if !removes.is_empty() { said.push(format!("Removed {}", names(&removes))); }
        if let Some(first) = skipped.first() { said.push(first.clone()); }
        let mut out = private(if said.is_empty() { "No changes.".to_string() } else { said.join("\n") });
        if !adds.is_empty() || !removes.is_empty() {
            // the member's roles are known to change now, so the counts on the menu are right straight away
            let now: Vec<String> = ev.member.roles.iter().filter(|r| !removes.contains(r)).cloned().chain(adds.iter().cloned()).collect();
            let _ = self.db.get().roster_seen(self.guild, &ev.member.id, &ev.member.name, ev.member.avatar.as_deref(), ev.member.bot, ev.member.joined_at, Some(&now), ev.at_ms);
            out.push(Action::Roles { user: ev.member.id.clone(), add: adds, remove: removes, reason: "Role menu".into() });
            out.push(Action::Edit { channel: ev.place.channel.clone(), message: ev.message.clone(), card: menu_card(self.dir, self.guild, &menu, &self.counts(&menu)) });
        }
        out
    }

    /// The message for a reaction role could not be found: what was saved for it is taken back.
    pub fn reaction_role_undo(&self, message: &str, emoji: &str) {
        self.data().delete(&format!("rr:{message}:{}", emoji_key(emoji)));
    }

    /// The menus this server has, for the launcher: where each is, how it behaves and which roles it gives.
    pub fn menu_list(&self) -> Vec<Value> {
        let mut out: Vec<Value> = self.data().list("menu:").into_iter().map(|(key, m)| {
            let message = key.strip_prefix("menu:").unwrap_or(&key).to_string();
            let roles: Vec<Value> = ids(&m["roleIds"]).into_iter().map(|id| json!({ "id": id, "name": self.dir.role(self.guild, &id).map(|r| r.name), "emoji": m["emojis"][&id] })).collect();
            json!({ "message": message, "channel": m["channelId"], "title": m["title"], "type": m["type"], "mode": m["mode"], "max": m["max"], "hours": m["hours"], "needs": m["needs"], "roles": roles })
        }).collect();
        out.sort_by(|a, b| b["message"].as_str().cmp(&a["message"].as_str()));
        out
    }
    /// Forgets a menu (so its buttons stop working). Gives the channel it was posted in.
    pub fn menu_remove(&self, message: &str) -> Option<String> {
        let m = self.data().get(&format!("menu:{message}"))?;
        self.data().delete(&format!("menu:{message}"));
        Some(m["channelId"].as_str().unwrap_or("").to_string())
    }
    /// The menu message is up: the menu is kept under the message's id, the way Good Boy 3 keeps it.
    pub fn posted(&self, note: &str, message: &str) {
        if let Some(token) = note.strip_prefix("rolemenu:") {
            let d = self.data();
            if let Some(menu) = d.get(&format!("pending:{token}")) {
                d.delete(&format!("pending:{token}"));
                d.set(&format!("menu:{message}"), &menu);
            }
        }
    }

    /// Someone reacted on a message (or took the reaction off).
    pub fn reaction(&self, message: &str, emoji: &str, user: &str, add: bool) -> Vec<Action> {
        let Some(role) = self.data().get(&format!("rr:{message}:{}", emoji_key(emoji))).and_then(|v| v.as_str().map(str::to_string)) else { return Vec::new() };
        if grant_problem(self.dir, self.guild, &role, None).is_some() { return Vec::new(); }
        let (add_roles, remove) = if add { (vec![role], Vec::new()) } else { (Vec::new(), vec![role]) };
        vec![Action::Roles { user: user.to_string(), add: add_roles, remove, reason: "Reaction role".into() }]
    }

    /// What someone is playing changed: the linked game roles are given, and (when the server wants that) taken
    /// away when they stop. `before`/`now`: the games, as Discord names them.
    pub fn playing(&self, member: &Member, before: &[String], now: &[String], remove: bool) -> Vec<Action> {
        if member.bot { return Vec::new(); }
        let low = |l: &[String]| l.iter().map(|g| g.to_lowercase()).collect::<std::collections::BTreeSet<_>>();
        let (before, now) = (low(before), low(now));
        if before == now { return Vec::new(); }
        let mut out = Vec::new();
        for (key, role) in self.data().list("game:") {
            let game = &key[5..];
            let Some(role) = role.as_str().map(str::to_string) else { continue };
            if grant_problem(self.dir, self.guild, &role, None).is_some() { continue; }
            if now.contains(game) && !before.contains(game) {
                out.push(Action::Roles { user: member.id.clone(), add: vec![role], remove: Vec::new(), reason: format!("Playing {game}") });
            } else if !now.contains(game) && before.contains(game) && remove {
                out.push(Action::Roles { user: member.id.clone(), add: Vec::new(), remove: vec![role], reason: format!("Stopped playing {game}") });
            }
        }
        out
    }

    /// Someone joined: the automatic roles for members (or for bots).
    pub fn on_join(&self, member: &Member) -> Vec<Action> {
        let list = ids(&self.data().get(if member.bot { "autorole:bots" } else { "autorole:members" }).unwrap_or_default());
        let ok: Vec<String> = list.into_iter().filter(|r| grant_problem(self.dir, self.guild, r, None).is_none()).collect();
        if ok.is_empty() { return Vec::new(); }
        vec![Action::Roles { user: member.id.clone(), add: ok, remove: Vec::new(), reason: "Automatic role".into() }]
    }
}

/// A custom emoji by its id, anything else by its text (the key Good Boy 3 saves reaction roles under).
pub fn emoji_key(s: &str) -> String {
    let t = s.trim();
    if let Some(inner) = t.strip_prefix('<').and_then(|x| x.strip_suffix('>')) {
        if let Some(id) = inner.rsplit(':').next().filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())) {
            return id.to_string();
        }
    }
    t.to_string()
}

/// Roles from menus whose time is up, in every server.
pub fn due(db: &Db, now: i64) -> Vec<(String, Action)> {
    let rows = db.get().data_everywhere(MODULE, "temp:").unwrap_or_default();
    let mut out = Vec::new();
    for (guild, key, until) in rows {
        if until.as_i64().unwrap_or(i64::MAX) > now { continue; }
        let _ = db.get().data_delete(&guild, MODULE, &key);
        let mut parts = key.splitn(3, ':').skip(1);
        let (user, role) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
        out.push((guild, Action::Roles { user, add: Vec::new(), remove: vec![role], reason: "Temporary role ran out".into() }));
    }
    out
}

#[cfg(test)]
mod count_tests {
    use super::*;
    #[test]
    fn a_menu_shows_how_many_members_hold_each_role() {
        let dir = Directory::default();
        dir.set_roles("g", vec![crate::bot::Named { id: "111".into(), name: "Gamers".into(), kind: "", parent: String::new() }, crate::bot::Named { id: "222".into(), name: "Artists".into(), kind: "", parent: String::new() }]);
        dir.set_role_facts("g", [("111".to_string(), crate::bot::RoleFacts { name: "Gamers".into(), position: 1, managed: false, perms: 0, mentionable: true }), ("222".to_string(), crate::bot::RoleFacts { name: "Artists".into(), position: 1, managed: false, perms: 0, mentionable: true })].into(), None);
        let menu = json!({ "title": "Pick", "type": "buttons", "roleIds": ["111", "222"] });
        let counts: std::collections::HashMap<String, i64> = [("111".to_string(), 3), ("222".to_string(), 1)].into();
        let text = menu_card(&dir, "g", &menu, &counts).to_discord().unwrap().to_string();
        assert!(text.contains("<@&111> · **3** members") && text.contains("<@&222> · **1** member\\n") || text.contains("<@&222> · **1** member"), "{text}");
        let none = menu_card(&dir, "g", &menu, &Default::default()).to_discord().unwrap().to_string();
        assert!(!none.contains("members"), "no counts known, none shown: {none}");
    }
}
