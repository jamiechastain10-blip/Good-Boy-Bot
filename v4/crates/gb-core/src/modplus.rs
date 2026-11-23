//! Moderation upgrades that go beyond Good Boy 3, all inside the moderation module:
//! role-hierarchy checks, private notes and a watchlist, appeals with a staff vote, a second staff member's approval
//! for bans and kicks, ban-evasion alerts when someone who looks like a banned member joins, "Report message", and
//! `/lockdown` (stops everyone talking in every text channel, and puts every channel back exactly as it was).

use crate::bot::{CommandSpec, Directory, Opt, Sub, Takes};
use crate::moderation::MODULE;
use crate::perms::{self, Level, Perm};
use crate::store::Data;
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Member, MessageEvent, Settings};
use serde_json::{json, Value};

pub const NOTES: Perm = Perm { key: "moderation.notes", level: Level::Moderator(None) };
pub const LOCKDOWN: Perm = Perm { key: "moderation.lockdown", level: Level::Moderator(Some(1 << 4)) };
const DECIDE: Perm = Perm { key: "moderation.warn", level: Level::Moderator(Some(1 << 40)) };
const BAN: Perm = Perm { key: "moderation.ban", level: Level::Moderator(Some(1 << 2)) };
const KICK: Perm = Perm { key: "moderation.kick", level: Level::Moderator(Some(1 << 1)) };
const MINUTE: i64 = 60_000;
const DAY: i64 = 86_400_000;
const PENDING_MS: i64 = 24 * 3_600_000;

const WHO: Opt = Opt { name: "user", about: "Who", takes: Takes::Member, required: true };
pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec { name: "note", about: "Private notes about a member (staff only)", module: MODULE, options: &[], subs: &[
        Sub { name: "add", about: "Add a private note", options: &[WHO, Opt { name: "text", about: "The note", takes: Takes::Text, required: true }] },
        Sub { name: "list", about: "A member's notes", options: &[WHO] },
        Sub { name: "remove", about: "Delete a note", options: &[WHO, Opt { name: "number", about: "The note's number", takes: Takes::Whole { min: 1, max: 1_000_000 }, required: true }] },
    ] },
    CommandSpec { name: "watch", about: "A watchlist: staff are told when a watched member posts (staff only)", module: MODULE, options: &[], subs: &[
        Sub { name: "add", about: "Watch a member", options: &[WHO, Opt { name: "reason", about: "Why", takes: Takes::Text, required: false }] },
        Sub { name: "remove", about: "Stop watching a member", options: &[WHO] },
        Sub { name: "list", about: "Who is being watched", options: &[] },
    ] },
    CommandSpec { name: "appeal", about: "Ask staff to take back a warning or timeout you got", module: MODULE, options: &[
        Opt { name: "case", about: "The case number (it is in the message you were sent)", takes: Takes::Whole { min: 1, max: 1_000_000_000 }, required: true },
        Opt { name: "why", about: "Why it should be taken back", takes: Takes::Text, required: true },
    ], subs: &[] },
    CommandSpec { name: "report", about: "Tell staff about a message (also: right-click a message > Apps > Report message)", module: MODULE, options: &[
        Opt { name: "message", about: "A link to the message", takes: Takes::Text, required: false },
        Opt { name: "why", about: "What is wrong with it", takes: Takes::Text, required: false },
    ], subs: &[] },
    CommandSpec { name: "lockdown", about: "Stop everyone talking in every text channel, and undo it (staff)", module: MODULE, options: &[], subs: &[
        Sub { name: "on", about: "Lock the server's text channels", options: &[Opt { name: "reason", about: "Why", takes: Takes::Text, required: false }] },
        Sub { name: "off", about: "Put every channel back as it was", options: &[] },
        Sub { name: "status", about: "Is the server locked?", options: &[] },
    ] },
];

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::Moderation).line(text).private() }]
}
fn short(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n.saturating_sub(1)).collect::<String>()) }
}
fn stamp(ms: i64, style: &str) -> String {
    format!("<t:{}:{style}>", ms / 1000)
}
/// Letters and digits only, lower case: "Dark_Wolf 99" and "darkwolf99" are the same name.
pub fn plain_name(name: &str) -> String {
    name.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Good Boy 3's `hierarchyError`: why a moderator may not act on this member, or None.
pub fn hierarchy_problem(dir: &Directory, guild: &str, actor: &Member, target: &Member) -> Option<String> {
    let owner = dir.owner(guild);
    if owner.as_deref() == Some(target.id.as_str()) { return Some("You can't do that to the server owner.".into()); }
    if dir.me().as_deref() == Some(target.id.as_str()) { return Some("I can't do that to myself.".into()); }
    if target.id == actor.id { return Some("You can't do that to yourself.".into()); }
    let top = |m: &Member| m.roles.iter().filter_map(|r| dir.role(guild, r)).map(|r| r.position).max().unwrap_or(0);
    if owner.as_deref() != Some(actor.id.as_str()) && top(target) >= top(actor) && top(target) > 0 {
        return Some("That member's highest role is equal to or above yours.".into());
    }
    if dir.my_top(guild).is_some_and(|mine| top(target) >= mine && top(target) > 0) {
        return Some("That member's highest role is equal to or above mine. Move my role higher in Server Settings > Roles.".into());
    }
    None
}

pub struct ModPlus<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub dir: &'a Directory,
    pub guild: &'a str,
}

impl ModPlus<'_> {
    fn data(&self) -> Data<'_> {
        Data { db: self.db, guild: self.guild, module: MODULE }
    }
    fn may(&self, m: &Member, p: Perm) -> bool {
        perms::allowed(self.db, self.guild, m, p)
    }
    fn no(p: Perm) -> Vec<Action> {
        private(format!("You don't have permission for that (`{}`).", p.key))
    }
    fn log_channel(&self) -> Option<String> {
        self.settings.text(self.guild, MODULE, "logChannel")
    }
    fn to_staff(&self, setting: &str, card: Card) -> Option<Action> {
        let channel = self.settings.text(self.guild, MODULE, setting).or_else(|| self.log_channel())?;
        Some(Action::Send { channel, card, ping: Vec::new(), roles: Vec::new() })
    }

    // ------------------------------------------------------------------ notes
    fn notes_of(&self, user: &str) -> Vec<Value> {
        self.data().get(&format!("note:{user}")).and_then(|v| v.as_array().cloned()).unwrap_or_default()
    }
    pub fn note_count(&self, user: &str) -> usize {
        self.notes_of(user).len()
    }
    fn note_command(&self, ev: &CommandEvent) -> Vec<Action> {
        if !self.may(&ev.member, NOTES) { return Self::no(NOTES); }
        let Some(user) = ev.target.as_ref() else { return private("Pick a member.") };
        let mut notes = self.notes_of(&user.id);
        let key = format!("note:{}", user.id);
        match ev.sub.as_deref().unwrap_or("list") {
            "add" => {
                let text = ev.args.get("text").map(|t| t.trim()).unwrap_or("");
                if text.is_empty() { return private("Write the note."); }
                if notes.len() >= 50 { return private("That member already has 50 notes. Remove one first."); }
                let id = self.data().next("noteCounter");
                notes.push(json!({ "id": id, "by": ev.member.id, "text": short(text, 800), "at": ev.at_ms }));
                self.data().set(&key, &Value::Array(notes));
                private(format!("📝 Note #{id} saved for **{}**. Only staff can see it.", short(&user.name, 40)))
            }
            "remove" => {
                let n: i64 = ev.args.get("number").and_then(|n| n.trim().parse().ok()).unwrap_or(0);
                let before = notes.len();
                notes.retain(|x| x["id"].as_i64() != Some(n));
                if notes.len() == before { return private("That member has no note with that number."); }
                self.data().set(&key, &Value::Array(notes));
                private(format!("Note #{n} deleted."))
            }
            _ => {
                if notes.is_empty() { return private(format!("{} has no notes.", user.name)); }
                let lines: Vec<String> = notes.iter().rev().take(15).map(|n| format!("**#{}** · {} · <@{}>\n> {}", n["id"], stamp(n["at"].as_i64().unwrap_or(0), "d"), n["by"].as_str().unwrap_or("?"), n["text"].as_str().unwrap_or(""))).collect();
                vec![Action::Reply { card: Card::new(Area::Moderation).title(format!("Notes about {}", short(&user.name, 40))).line(lines.join("\n")).private() }]
            }
        }
    }

    // ------------------------------------------------------------------ watchlist
    fn watch_command(&self, ev: &CommandEvent) -> Vec<Action> {
        if !self.may(&ev.member, NOTES) { return Self::no(NOTES); }
        let sub = ev.sub.as_deref().unwrap_or("list");
        if sub == "list" {
            let rows = self.data().list("watch:");
            if rows.is_empty() { return private("Nobody is on the watchlist."); }
            let lines: Vec<String> = rows.iter().map(|(k, v)| format!("<@{}> · since {}{}", &k[6..], stamp(v["at"].as_i64().unwrap_or(0), "d"), v["reason"].as_str().filter(|r| !r.is_empty()).map(|r| format!(" · {}", short(r, 100))).unwrap_or_default())).collect();
            return vec![Action::Reply { card: Card::new(Area::Moderation).title("👁️ Watchlist").line(lines.join("\n")).private() }];
        }
        let Some(user) = ev.target.as_ref() else { return private("Pick a member.") };
        if sub == "remove" {
            if self.data().get(&format!("watch:{}", user.id)).is_none() { return private("They are not on the watchlist."); }
            self.data().delete(&format!("watch:{}", user.id));
            return private(format!("Stopped watching **{}**.", short(&user.name, 40)));
        }
        if user.bot { return private("Bots can't be watched."); }
        let reason = ev.args.get("reason").map(|r| short(r.trim(), 300)).unwrap_or_default();
        self.data().set(&format!("watch:{}", user.id), &json!({ "by": ev.member.id, "reason": reason, "at": ev.at_ms }));
        private(format!("👁️ Watching **{}**. Staff are told in the mod log when they post (at most once every 10 minutes).", short(&user.name, 40)))
    }
    /// A watched member posted: staff get one note about it every ten minutes.
    pub fn on_message(&self, ev: &MessageEvent) -> Vec<Action> {
        if ev.author.bot { return Vec::new(); }
        let Some(w) = self.data().get(&format!("watch:{}", ev.author.id)) else { return Vec::new() };
        let last = self.data().get(&format!("watchSeen:{}", ev.author.id)).and_then(|v| v.as_i64()).unwrap_or(0);
        if ev.at_ms - last < 10 * MINUTE { return Vec::new(); }
        self.data().set(&format!("watchSeen:{}", ev.author.id), &json!(ev.at_ms));
        let link = format!("https://discord.com/channels/{}/{}/{}", self.guild, ev.place.channel, ev.id);
        let why = w["reason"].as_str().filter(|r| !r.is_empty()).map(|r| format!("\nWatched because: {}", short(r, 200))).unwrap_or_default();
        self.to_staff("logChannel", Card::new(Area::Moderation).title("👁️ Watched member posted").line(format!("<@{}> posted in <#{}>.{why}", ev.author.id, ev.place.channel)).button_link(link, "Jump to message")).into_iter().collect()
    }

    // ------------------------------------------------------------------ appeals
    fn appeal_command(&self, ev: &CommandEvent) -> Vec<Action> {
        let Some(case_id) = ev.args.get("case").and_then(|c| c.trim().parse::<i64>().ok()) else { return private("Say which case number you are appealing.") };
        let why = ev.args.get("why").map(|w| short(w.trim(), 800)).unwrap_or_default();
        if why.is_empty() { return private("Say why it should be taken back."); }
        let hist = self.data().get(&format!("hist:{}", ev.member.id)).and_then(|v| v.as_array().cloned()).unwrap_or_default();
        let Some(case) = hist.iter().find(|e| e["id"].as_i64() == Some(case_id)) else { return private("You have no case with that number.") };
        let kind = case["type"].as_str().unwrap_or("");
        if !matches!(kind, "warn" | "timeout" | "kick") { return private("Only a warning or a timeout can be appealed here. Bans are appealed where the server says."); }
        if self.data().get(&format!("appealOpen:{case_id}")).is_some() { return private("That case already has an appeal waiting for staff."); }
        let last = self.data().get(&format!("appealLast:{}", ev.member.id)).and_then(|v| v.as_i64()).unwrap_or(0);
        if ev.at_ms - last < DAY { return private("You can send one appeal a day."); }
        let id = self.data().next("appealCounter");
        self.data().set(&format!("appeal:{id}"), &json!({ "user": ev.member.id, "name": ev.member.name, "case": case_id, "kind": kind, "why": why, "at": ev.at_ms, "yes": [], "no": [] }));
        self.data().set(&format!("appealOpen:{case_id}"), &json!(id));
        self.data().set(&format!("appealLast:{}", ev.member.id), &json!(ev.at_ms));
        let mut out = private(format!("📨 Your appeal (#{id}) was sent to staff. You'll get a message with their answer."));
        out.extend(self.to_staff("appealChannel", self.appeal_card(id, &self.data().get(&format!("appeal:{id}")).unwrap_or(Value::Null), case, None)));
        out
    }
    fn appeal_card(&self, id: i64, a: &Value, case: &Value, done: Option<&str>) -> Card {
        let votes = self.settings.int(self.guild, MODULE, "appealVotes").max(1);
        let mut card = Card::new(Area::Moderation).title(format!("📨 Appeal #{id} · case #{}", a["case"])).line(format!("**From** <@{}>\n**Case** {} · {}\n**Their reason for the appeal**\n{}", a["user"].as_str().unwrap_or("?"), case["type"].as_str().unwrap_or("?"), short(case["reason"].as_str().unwrap_or(""), 300), short(a["why"].as_str().unwrap_or(""), 800)));
        match done {
            Some(text) => card = card.line(text),
            None => {
                let yes = a["yes"].as_array().map(Vec::len).unwrap_or(0);
                let no = a["no"].as_array().map(Vec::len).unwrap_or(0);
                card = card.line(format!("-# Votes: {yes} to accept (needs {votes}) · {no} to decline"))
                    .button(format!("mapp:yes:{id}"), "Take it back", ButtonStyle::Good).button(format!("mapp:no:{id}"), "Decline", ButtonStyle::Danger);
            }
        }
        card
    }
    /// A staff member pressed Take it back or Decline on an appeal.
    pub fn appeal_press(&self, ev: &ButtonEvent) -> Vec<Action> {
        let mut parts = ev.id.splitn(3, ':').skip(1);
        let (verdict, id) = (parts.next().unwrap_or(""), parts.next().and_then(|i| i.parse::<i64>().ok()).unwrap_or(0));
        if !self.may(&ev.member, DECIDE) { return Self::no(DECIDE); }
        let key = format!("appeal:{id}");
        let Some(mut a) = self.data().get(&key) else { return private("That appeal has already been answered.") };
        let case_id = a["case"].as_i64().unwrap_or(0);
        let who = ev.member.id.clone();
        if a["user"].as_str() == Some(who.as_str()) { return private("You can't decide your own appeal."); }
        for side in ["yes", "no"] {
            if let Some(list) = a[side].as_array_mut() { list.retain(|v| v.as_str() != Some(who.as_str())); }
        }
        let side = if verdict == "yes" { "yes" } else { "no" };
        if let Some(list) = a[side].as_array_mut() { list.push(json!(who)); }
        let need = self.settings.int(self.guild, MODULE, "appealVotes").max(1) as usize;
        let yes = a["yes"].as_array().map(Vec::len).unwrap_or(0);
        let no = a["no"].as_array().map(Vec::len).unwrap_or(0);
        let user = a["user"].as_str().unwrap_or("").to_string();
        let hist = self.data().get(&format!("hist:{user}")).and_then(|v| v.as_array().cloned()).unwrap_or_default();
        let case = hist.iter().find(|e| e["id"].as_i64() == Some(case_id)).cloned().unwrap_or(Value::Null);
        if yes >= need {
            self.data().delete(&key);
            self.data().delete(&format!("appealOpen:{case_id}"));
            let mut out = Vec::new();
            // a taken-back warning leaves the record (so the strikes drop); a timeout is lifted
            match a["kind"].as_str() {
                Some("warn") => {
                    let mut left = hist.clone();
                    left.retain(|e| e["id"].as_i64() != Some(case_id));
                    self.data().set(&format!("hist:{user}"), &Value::Array(left));
                }
                Some("timeout") => out.push(Action::Timeout { user: user.clone(), until_ms: None, reason: format!("Appeal #{id} accepted"), case: 0 }),
                _ => {}
            }
            out.insert(0, Action::Update { card: self.appeal_card(id, &a, &case, Some(&format!("✅ Taken back by <@{}>{}", who, if need > 1 { format!(" and {} more", need - 1) } else { String::new() }))) });
            out.push(Action::Dm { user, card: Card::new(Area::Moderation).line(format!("**{}**: your appeal for case #{case_id} was accepted. It was taken back.", short(&self.guild_name(), 60))), or_in: None });
            return out;
        }
        if no >= need.max(1) && no > yes {
            self.data().delete(&key);
            self.data().delete(&format!("appealOpen:{case_id}"));
            return vec![
                Action::Update { card: self.appeal_card(id, &a, &case, Some(&format!("❌ Declined by <@{who}>"))) },
                Action::Dm { user, card: Card::new(Area::Moderation).line(format!("**{}**: your appeal for case #{case_id} was declined.", short(&self.guild_name(), 60))), or_in: None },
            ];
        }
        self.data().set(&key, &a);
        vec![Action::Update { card: self.appeal_card(id, &a, &case, None) }]
    }
    fn guild_name(&self) -> String {
        self.db.get().guilds().ok().and_then(|all| all.into_iter().find(|g| g.id == self.guild)).map(|g| g.name).filter(|n| !n.is_empty()).unwrap_or_else(|| "The server".into())
    }

    // ------------------------------------------------------------------ second-staff approval for bans and kicks
    /// Whether this ban or kick needs another staff member's say-so first (and the member is not an administrator).
    pub fn needs_approval(&self, action: &str, who: &Member) -> bool {
        if who.perms & perms::ADMINISTRATOR != 0 { return false; }
        match self.settings.text(self.guild, MODULE, "needApproval").as_deref() {
            Some("ban") => action == "ban",
            Some("kick-ban") => matches!(action, "ban" | "kick"),
            _ => false,
        }
    }
    /// Asks for approval: the request is kept for a day and staff see Approve / Deny buttons in the mod log.
    pub fn ask_approval(&self, ev: &CommandEvent, action: &str, target: &Member, reason: &str, days: &str, duration: &str) -> Vec<Action> {
        let id = self.data().next("pendCounter");
        self.data().set(&format!("pend:{id}"), &json!({ "action": action, "by": ev.member.id, "byName": ev.member.name, "byPerms": ev.member.perms, "target": target.id, "targetName": target.name, "reason": reason, "days": days, "duration": duration, "at": ev.at_ms }));
        let card = Card::new(Area::Moderation).title(format!("🛡️ {} needs a second staff member", short(&action[..1].to_uppercase(), 1).to_string() + &action[1..]))
            .line(format!("<@{}> wants to {action} <@{}>.\n**Reason** {}", ev.member.id, target.id, short(reason, 400)))
            .line("-# Another staff member with the same permission has to approve. The request lasts a day.")
            .button(format!("mapr:yes:{id}"), "Approve", ButtonStyle::Good).button(format!("mapr:no:{id}"), "Deny", ButtonStyle::Danger);
        let mut out = private(format!("⏳ A second staff member has to approve this {action}. I asked in the mod log (request #{id})."));
        out.extend(self.to_staff("logChannel", card));
        out
    }
    /// A staff member pressed Approve or Deny. On approval the command runs as if the first moderator had sent it.
    pub fn approval_press(&self, ev: &ButtonEvent) -> Result<(Value, bool, Vec<Action>), Vec<Action>> {
        let mut parts = ev.id.splitn(3, ':').skip(1);
        let (verdict, id) = (parts.next().unwrap_or(""), parts.next().and_then(|i| i.parse::<i64>().ok()).unwrap_or(0));
        let key = format!("pend:{id}");
        let Some(p) = self.data().get(&key) else { return Err(private("That request has already been answered.")) };
        let action = p["action"].as_str().unwrap_or("ban");
        let perm = if action == "kick" { KICK } else { BAN };
        if !self.may(&ev.member, perm) { return Err(Self::no(perm)); }
        if p["by"].as_str() == Some(ev.member.id.as_str()) { return Err(private("You asked for this one. Another staff member has to approve it.")); }
        if ev.at_ms - p["at"].as_i64().unwrap_or(0) > PENDING_MS {
            self.data().delete(&key);
            return Err(private("That request ran out (it only lasts a day). Ask again."));
        }
        self.data().delete(&key);
        let approved = verdict == "yes";
        let line = if approved { format!("✅ Approved by <@{}>", ev.member.id) } else { format!("❌ Denied by <@{}>", ev.member.id) };
        let card = Card::new(Area::Moderation).title(format!("🛡️ {action} request #{id}")).line(format!("<@{}> wanted to {action} <@{}>: {}", p["by"].as_str().unwrap_or("?"), p["target"].as_str().unwrap_or("?"), short(p["reason"].as_str().unwrap_or(""), 300))).line(line);
        Ok((p, approved, vec![Action::Update { card }]))
    }

    // ------------------------------------------------------------------ ban evasion
    /// A ban was made: its name is remembered so a look-alike joining later is noticed.
    pub fn remember_ban(&self, user: &Member, case: i64) {
        let plain = plain_name(&user.name);
        if plain.len() < 4 { return; }
        let mut map = self.data().get("banNames").and_then(|v| v.as_object().cloned()).unwrap_or_default();
        if map.len() >= 2000 { if let Some(k) = map.keys().next().cloned() { map.remove(&k); } }
        map.insert(plain, json!({ "id": user.id, "case": case, "name": user.name }));
        self.data().set("banNames", &Value::Object(map));
    }
    /// Someone joined: an alert when their name matches a banned member's, or their account is brand new.
    pub fn joined(&self, member: &Member, now: i64) -> Vec<Action> {
        if member.bot || !self.settings.bool(self.guild, MODULE, "banEvasionAlerts") { return Vec::new(); }
        let plain = plain_name(&member.name);
        let hit = self.data().get("banNames").and_then(|m| m.get(&plain).cloned());
        let Some(hit) = hit.filter(|h| h["id"].as_str() != Some(member.id.as_str())) else { return Vec::new() };
        let created = crate::ticketrules::account_created(&member.id).unwrap_or(now);
        let fresh = now - created < 30 * DAY;
        let card = Card::new(Area::Moderation).title("🕵️ Might be a banned member back").line(format!("<@{}> has the same name as **{}** (banned, case #{}).\nAccount created {}{}", member.id, short(hit["name"].as_str().unwrap_or("?"), 40), hit["case"], stamp(created, "R"), if fresh { " · **less than 30 days old**" } else { "" }))
            .line("-# A matching name is only a hint. Look at the account before doing anything.");
        self.to_staff("logChannel", card).into_iter().collect()
    }

    // ------------------------------------------------------------------ Report message
    fn report_command(&self, ev: &CommandEvent) -> Vec<Action> {
        let arg = |k: &str| ev.args.get(k).map(|s| s.trim()).filter(|s| !s.is_empty());
        let (channel, message) = match (arg("channel_id"), arg("message_id")) {
            (Some(c), Some(m)) => (c.to_string(), m.to_string()),
            _ => {
                // a pasted link: https://discord.com/channels/<server>/<channel>/<message>
                let parts: Vec<&str> = arg("message").unwrap_or("").trim_end_matches('/').rsplit('/').take(3).collect();
                if parts.len() < 3 || !parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit())) { return private("Right-click the message > Apps > Report message, or paste the message's link."); }
                (parts[1].to_string(), parts[0].to_string())
            }
        };
        let last = self.data().get(&format!("reportLast:{}", ev.member.id)).and_then(|v| v.as_i64()).unwrap_or(0);
        if ev.at_ms - last < 30_000 { return private("Slow down a little: one report every 30 seconds."); }
        self.data().set(&format!("reportLast:{}", ev.member.id), &json!(ev.at_ms));
        let why = arg("why").map(|w| short(w, 400)).unwrap_or_default();
        let author = arg("author_id").unwrap_or("").to_string();
        let link = format!("https://discord.com/channels/{}/{channel}/{message}", self.guild);
        let text = arg("text").map(|t| short(t, 500)).unwrap_or_default();
        let mut card = Card::new(Area::Moderation).title("🚩 Message reported").line(format!("**By** <@{}> · **In** <#{channel}>{}", ev.member.id, if author.is_empty() { String::new() } else { format!(" · **Author** <@{author}>") }));
        if !text.is_empty() { card = card.line(format!("**The message**\n> {}", text.replace('\n', "\n> "))); }
        if !why.is_empty() { card = card.line(format!("**Why** {why}")); }
        card = card.button_link(link, "Jump to message");
        if !author.is_empty() { card = card.button(format!("mrep:warn:{author}"), "Warn author", ButtonStyle::Primary); }
        card = card.button("mrep:done", "Handled", ButtonStyle::Plain);
        let mut out = private("🚩 Thanks. Staff have been told.");
        match self.to_staff("reportChannel", card) {
            Some(a) => out.push(a),
            None => return private("This server has no staff channel for reports yet. Ask the admins to set a mod log channel."),
        }
        out
    }
    /// The buttons on a report: warn the author, or mark it handled.
    pub fn report_press(&self, ev: &ButtonEvent) -> Vec<Action> {
        if !self.may(&ev.member, NOTES) { return Self::no(NOTES); }
        match ev.id.split(':').nth(1) {
            Some("warn") => {
                let target = ev.id.split(':').nth(2).unwrap_or("");
                vec![crate::moderation::warn_intro(&ev.member.id, Some(target), self.settings.bool(self.guild, MODULE, "dmOnAction"))]
            }
            _ => vec![Action::Update { card: Card::new(Area::Moderation).title("🚩 Report handled").line(format!("Marked as handled by <@{}>.", ev.member.id)) }],
        }
    }

    // ------------------------------------------------------------------ lockdown
    fn lockdown_command(&self, ev: &CommandEvent) -> Vec<Action> {
        if !self.may(&ev.member, LOCKDOWN) { return Self::no(LOCKDOWN); }
        let sub = ev.sub.as_deref().unwrap_or("status");
        let locked = self.data().get("lockdown").is_some();
        match sub {
            "status" => private(if locked { "🔒 The server is locked down. Use `/lockdown off` to open it again." } else { "The server is open." }),
            "on" => {
                if locked { return private("It is already locked down."); }
                let reason = ev.args.get("reason").map(|r| short(r.trim(), 300)).unwrap_or_default();
                self.data().set("lockdown", &json!({ "by": ev.member.id, "at": ev.at_ms, "reason": reason }));
                let mut out = private("🔒 Locking every text channel. This takes a moment.");
                out.push(Action::Lockdown { on: true, by: ev.member.id.clone(), reason: reason.clone() });
                out.extend(self.to_staff("logChannel", Card::new(Area::Moderation).title("🔒 Lockdown on").line(format!("<@{}> locked the server{}.", ev.member.id, if reason.is_empty() { String::new() } else { format!(": {reason}") }))));
                out
            }
            _ => {
                if !locked { return private("The server isn't locked down."); }
                self.data().delete("lockdown");
                let mut out = private("🔓 Opening every channel again, exactly as it was.");
                out.push(Action::Lockdown { on: false, by: ev.member.id.clone(), reason: String::new() });
                out.extend(self.to_staff("logChannel", Card::new(Area::Moderation).title("🔓 Lockdown off").line(format!("<@{}> opened the server again.", ev.member.id))));
                out
            }
        }
    }

    pub fn command(&self, ev: &CommandEvent) -> Vec<Action> {
        match ev.name.as_str() {
            "note" => self.note_command(ev),
            "watch" => self.watch_command(ev),
            "appeal" => self.appeal_command(ev),
            "report" | "Report message" => self.report_command(ev),
            "lockdown" => self.lockdown_command(ev),
            _ => Vec::new(),
        }
    }
}
