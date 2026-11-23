//! Good Boy 3's modmail: members DM the bot, staff answer in a private thread.
//! A member's DM opens (or continues) a thread in the staff channel, with a header card and Close and Block buttons.
//! What staff write there goes back to the member as a DM, as "Staff" (or with their name if the server chose that);
//! lines starting with `//` stay in the thread as notes. Close ends the conversation; Block stops a member's DMs.
//! The same data as Good Boy 3 (`open:<member>`, `thread:<thread>`, `blocked:<member>`) and wording.

use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::store::Data;
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, Db, Def, Kind, Member, MessageEvent, Settings};
use serde_json::json;

pub const MODULE: &str = "modmail";
pub const REPLY: Perm = Perm { key: "modmail.reply", level: Level::Moderator(None) };
pub static SETTINGS: &[Def] = &[
    Def { key: "channel", label: "Staff channel where modmail threads open (a text or forum channel staff can see)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "pingRole", label: "Ping this role when a new conversation starts (optional)", kind: Kind::Role, default: Fallback::None },
    Def { key: "showStaffNames", label: "Show staff names on replies (otherwise just \"Staff\")", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "greeting", label: "First reply members get (optional)", kind: Kind::Text { max_len: 1000 }, default: Fallback::Str("") },
];

fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}
fn files_text(files: &[(String, String, u64)]) -> String {
    files.iter().map(|(name, url, _)| format!("📎 [{}]({url})", short(name, 60))).collect::<Vec<_>>().join("\n")
}

/// A DM from a member that is meant for this server's staff.
pub struct Dm<'a> {
    pub member: &'a Member,
    pub text: &'a str,
    pub files: &'a [(String, String, u64)],
    /// Where the DM is, and the DM's own id (to react on it).
    pub dm_channel: &'a str,
    pub message: &'a str,
    pub at: i64,
}

pub struct Modmail<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub guild: &'a str,
    pub server: &'a str,
}
impl Modmail<'_> {
    fn data(&self) -> Data<'_> {
        Data { db: self.db, guild: self.guild, module: MODULE }
    }
    /// Set up enough to take DMs (Good Boy 3's `ready`).
    pub fn ready(&self) -> bool {
        self.settings.text(self.guild, MODULE, "channel").is_some_and(|c| !c.is_empty())
    }
    pub fn has_open(&self, user: &str) -> bool {
        self.data().get(&format!("open:{user}")).is_some()
    }
    fn body(text: &str, files: &[(String, String, u64)]) -> String {
        let b = [Some(short(text, 3900)).filter(|t| !t.is_empty()), Some(files_text(files)).filter(|t| !t.is_empty())].into_iter().flatten().collect::<Vec<_>>().join("\n");
        if b.is_empty() { "*(empty message)*".into() } else { b }
    }
    /// The member's DM: into their open thread, or a new one is opened first (Good Boy 3's fromDM).
    pub fn from_dm(&self, dm: &Dm) -> Vec<Action> {
        let d = self.data();
        if d.get(&format!("blocked:{}", dm.member.id)).is_some() {
            return vec![Action::Send { channel: dm.dm_channel.into(), card: Card::new(Area::General).line("You can't message the staff of this server through me."), ping: Vec::new(), roles: Vec::new() }];
        }
        let card = Card::new(Area::General).title(dm.member.name.clone()).picture(dm.member.avatar.clone()).line(Self::body(dm.text, dm.files));
        if let Some(thread) = d.get(&format!("open:{}", dm.member.id)).and_then(|v| v.as_str().map(str::to_string)) {
            return vec![
                Action::Send { channel: thread, card, ping: Vec::new(), roles: Vec::new() },
                Action::React { channel: dm.dm_channel.into(), message: dm.message.into(), emoji: "✅".into() },
            ];
        }
        let Some(channel) = self.settings.text(self.guild, MODULE, "channel").filter(|c| !c.is_empty()) else {
            return vec![Action::Send { channel: dm.dm_channel.into(), card: Card::new(Area::General).line("Modmail is not set up in this server yet."), ping: Vec::new(), roles: Vec::new() }];
        };
        let created = crate::ticketrules::account_created(&dm.member.id).unwrap_or(dm.at);
        let joined = dm.member.joined_at.map(|j| format!(" · joined <t:{}:R>", j / 1000)).unwrap_or_default();
        let role = self.settings.text(self.guild, MODULE, "pingRole").filter(|r| !r.is_empty());
        let mut head = Card::new(Area::General).title(format!("📬 Modmail from {}", dm.member.name)).picture(dm.member.avatar.clone())
            .line(format!("<@{}> (`{}`)\nAccount made <t:{}:R>{joined}", dm.member.id, dm.member.id, created / 1000))
            .line("-# Write here to answer them. Start a line with // for a note only staff see.")
            .button_with(format!("mmail:close:{}", dm.member.id), "Close", ButtonStyle::Good, Some("✅".into()))
            .button_with(format!("mmail:block:{}", dm.member.id), "Block", ButtonStyle::Danger, Some("⛔".into()));
        if let Some(r) = &role { head = head.line(format!("<@&{r}>")); }
        // the member's message and the greeting follow once the thread exists (`thread_made`)
        d.set(&format!("pending:{}", dm.member.id), &json!({ "body": Self::body(dm.text, dm.files), "name": dm.member.name, "avatar": dm.member.avatar, "dm": dm.dm_channel }));
        vec![Action::OpenThread { channel, name: short(&format!("📬 {}", dm.member.name), 90), card: head, roles: role.into_iter().collect(), note: format!("modmail:{}", dm.member.id) }]
    }
    /// The thread for a member's conversation exists: it is kept, their first message goes in, and they are greeted.
    pub fn thread_made(&self, note: &str, thread: &str, now: i64) -> Vec<Action> {
        let Some(user) = note.strip_prefix("modmail:") else { return Vec::new() };
        let d = self.data();
        d.set(&format!("open:{user}"), &json!(thread));
        d.set(&format!("thread:{thread}"), &json!({ "userId": user, "at": now }));
        let Some(p) = d.get(&format!("pending:{user}")) else { return Vec::new() };
        d.delete(&format!("pending:{user}"));
        let card = Card::new(Area::General).title(p["name"].as_str().unwrap_or("").to_string()).picture(p["avatar"].as_str().map(str::to_string)).line(p["body"].as_str().unwrap_or("").to_string());
        let hello = self.settings.text(self.guild, MODULE, "greeting").filter(|g| !g.is_empty()).unwrap_or_else(|| format!("Thanks for your message! It went to the staff of **{}**. They'll answer here.", self.server));
        vec![
            Action::Send { channel: thread.into(), card, ping: Vec::new(), roles: Vec::new() },
            Action::Send { channel: p["dm"].as_str().unwrap_or("").to_string(), card: Card::new(Area::General).line(hello), ping: Vec::new(), roles: Vec::new() },
        ]
    }
    /// Staff writing in a modmail thread: sent to the member (lines starting with // stay here as notes).
    pub fn on_message(&self, ev: &MessageEvent) -> Vec<Action> {
        if ev.author.bot || ev.place.thread_of.is_none() { return Vec::new(); }
        let d = self.data();
        let Some(link) = d.get(&format!("thread:{}", ev.place.channel)) else { return Vec::new() };
        let user = link["userId"].as_str().unwrap_or("").to_string();
        if d.get(&format!("open:{user}")).and_then(|v| v.as_str().map(str::to_string)).as_deref() != Some(ev.place.channel.as_str()) { return Vec::new(); }
        if ev.text.is_empty() && ev.files.is_empty() { return Vec::new(); }
        if ev.text.trim_start().starts_with("//") { return Vec::new(); }
        let from = if self.settings.bool(self.guild, MODULE, "showStaffNames") { ev.author.name.clone() } else { "Staff".into() };
        let card = Card::new(Area::General).title(format!("{from} · {}", short(self.server, 60))).line(Self::body(&ev.text, &ev.files));
        vec![Action::Relay { user, card, channel: ev.place.channel.clone(), message: ev.id.clone() }]
    }
    /// Close and Block (staff only).
    pub fn press(&self, ev: &ButtonEvent, current: Option<Card>) -> Vec<Action> {
        let p: Vec<&str> = ev.id.split(':').collect();
        let (what, user) = (p.get(1).copied().unwrap_or(""), p.get(2).copied().unwrap_or(""));
        let private = |t: String| vec![Action::Reply { card: Card::new(Area::General).line(t).private() }];
        if !perms::allowed(self.db, self.guild, &ev.member, REPLY) { return private("Only staff can do that.".into()); }
        let d = self.data();
        match what {
            "close" => {
                let open = d.get(&format!("open:{user}")).and_then(|v| v.as_str().map(str::to_string));
                d.delete(&format!("open:{user}"));
                let mut done = current.unwrap_or_else(|| Card::new(Area::General).title("📬 Modmail"));
                done.buttons.clear();
                let mut out = vec![
                    Action::Update { card: done.line(format!("-# Closed by {}", ev.member.name)) },
                    Action::Dm { user: user.into(), card: Card::new(Area::General).line(format!("✅ Your conversation with the staff of **{}** was closed. Message me again any time to start a new one.", self.server)), or_in: None },
                ];
                if let Some(t) = open { out.push(Action::ArchiveThread { thread: t }); }
                out
            }
            "block" => {
                let key = format!("blocked:{user}");
                let blocked = d.get(&key).is_none();
                if blocked { d.set(&key, &json!({ "by": ev.member.id, "at": ev.at_ms })); } else { d.delete(&key); }
                vec![Action::Reply { card: Card::new(Area::General).line(if blocked { format!("⛔ <@{user}> can no longer message staff through me. Press Block again to undo.") } else { format!("<@{user}> can message staff again.") }) }]
            }
            _ => private("Unknown button.".into()),
        }
    }
}
