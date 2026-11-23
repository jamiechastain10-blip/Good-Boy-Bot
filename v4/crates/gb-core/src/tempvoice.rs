//! Good Boy 3's temporary voice rooms: join a lobby and a room of your own appears with you in it (`/room` controls
//! it: name, limit, privacy, invite, kick, ban, transfer, claim, info; staff pick lobbies with `/voicehub`). Rooms go
//! when empty and are remembered, so a restart picks them up. Event hubs: one popup (event name, team size, most
//! teams, where the panel goes) posts a panel; members join solo (matched), with friends (they accept) or make a team
//! room others fill. Each team gets its own voice room that only the team can join, and anyone already in voice is
//! moved in. The same data (`lobby:`, `room:`, `ev:`), rules and wording as Good Boy 3.

use crate::bot::{CommandSpec, Directory, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::store::Data;
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Def, Field, FieldKind, FormEvent, Kind, Settings};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

pub const MODULE: &str = "tempvoice";
pub const USE: Perm = Perm { key: "tempvoice.use", level: Level::Everyone };
pub const MANAGE: Perm = Perm { key: "tempvoice.manage", level: Level::Admin };
pub static SETTINGS: &[Def] = &[
    Def { key: "nameTemplate", label: "Room name ({user} = creator, {n} = number)", kind: Kind::Text { max_len: 80 }, default: Fallback::Str("{user}'s room") },
    Def { key: "defaultLimit", label: "Default member limit (0 = none)", kind: Kind::Number { min: 0, max: 99 }, default: Fallback::Int(0) },
    Def { key: "maxRooms", label: "Most temporary rooms at once", kind: Kind::Number { min: 1, max: 100 }, default: Fallback::Int(40) },
    Def { key: "emptyDelaySeconds", label: "Seconds an empty room stays before it is deleted", kind: Kind::Number { min: 0, max: 600 }, default: Fallback::Int(5) },
    Def { key: "eventGraceSeconds", label: "Event hubs: seconds a new team room waits for its team", kind: Kind::Number { min: 30, max: 1800 }, default: Fallback::Int(180) },
    Def { key: "ownerLeaves", label: "When the owner leaves a room others are in (transfer = to who was there longest, claim = wait for /room claim)", kind: Kind::Select(&["transfer", "claim"]), default: Fallback::Str("transfer") },
];
const WHO: Opt = Opt { name: "member", about: "Who", takes: Takes::Member, required: true };
const LOBBY: Opt = Opt { name: "lobby", about: "The voice channel people join", takes: Takes::AnyChannel, required: true };
pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec { name: "room", about: "Control your temporary voice room", module: MODULE, options: &[], subs: &[
        Sub { name: "name", about: "Rename your room", options: &[Opt { name: "name", about: "New name", takes: Takes::Text, required: true }] },
        Sub { name: "limit", about: "Set how many people fit", options: &[Opt { name: "people", about: "0 = no limit", takes: Takes::Whole { min: 0, max: 99 }, required: true }] },
        Sub { name: "privacy", about: "Who can see and join", options: &[Opt { name: "mode", about: "Mode", takes: Takes::Choice(&[("public - anyone", "public"), ("locked - visible, invite only", "locked"), ("hidden - invite only and unseen", "hidden")]), required: true }] },
        Sub { name: "invite", about: "Let someone in", options: &[WHO] },
        Sub { name: "permit", about: "Let someone in (same as invite)", options: &[WHO] },
        Sub { name: "kick", about: "Remove someone from the room", options: &[WHO] },
        Sub { name: "ban", about: "Keep someone out of the room", options: &[WHO] },
        Sub { name: "transfer", about: "Give the room to someone inside", options: &[WHO] },
        Sub { name: "claim", about: "Take a room whose owner has left", options: &[] },
        Sub { name: "info", about: "About this room", options: &[] },
    ] },
    CommandSpec { name: "voicehub", about: "Set up join-to-create lobbies", module: MODULE, options: &[], subs: &[
        Sub { name: "add", about: "Make a voice channel a lobby", options: &[LOBBY,
            Opt { name: "category", about: "Where new rooms go (default: the lobby's category)", takes: Takes::Category, required: false },
            Opt { name: "name", about: "Room name, e.g. {user}'s squad", takes: Takes::Text, required: false },
            Opt { name: "limit", about: "Member limit for rooms from this lobby", takes: Takes::Whole { min: 0, max: 99 }, required: false },
        ] },
        Sub { name: "remove", about: "Stop using a channel as a lobby", options: &[LOBBY] },
        Sub { name: "list", about: "Show lobbies and open rooms", options: &[] },
        Sub { name: "event", about: "Start an event hub: teams get their own voice rooms (opens a popup)", options: &[] },
    ] },
];
// Discord's permission bits
const VIEW: u64 = 1 << 10;
const CONNECT: u64 = 1 << 20;
const SPEAK: u64 = 1 << 21;
const STREAM: u64 = 1 << 9;
const VAD: u64 = 1 << 25;
const OWNER_ALLOW: u64 = VIEW | CONNECT | SPEAK | STREAM | VAD;
pub const SIZES: &[i64] = &[2, 3, 4, 5, 6, 8, 10];
const RENAME_LIMIT: usize = 2;
const RENAME_WINDOW: i64 = 10 * 60_000;

// ------------------------------------------------------------------ pure rules (Good Boy 3's src/tempvoice.js)
/// One line of plain text: no control or direction characters, no mentions, 100 characters at most.
pub fn sanitize_name(text: &str, fallback: &str) -> String {
    let mut t = String::new();
    let mut skip = false;
    let cleaned: String = text.replace(['\r', '\n', '\t'], " ");
    for c in cleaned.chars() {
        if c == '<' { skip = false; }
        let bad = c.is_control() || ('\u{200b}'..='\u{200f}').contains(&c) || ('\u{2028}'..='\u{202e}').contains(&c) || ('\u{2066}'..='\u{2069}').contains(&c) || c == '\u{feff}';
        if !bad && !skip { t.push(c); }
    }
    // <@123> and <#123> go; @everyone and @here lose their @
    while let Some(a) = t.find("<@").or_else(|| t.find("<#")) { match t[a..].find('>') { Some(b) => t.replace_range(a..a + b + 1, ""), None => break } }
    let t = t.replace("@everyone", "everyone").replace("@here", "here").replace("@Everyone", "Everyone").replace("@Here", "Here");
    let t: String = t.split_whitespace().collect::<Vec<_>>().join(" ");
    let t: String = t.chars().take(100).collect::<String>().trim().to_string();
    if t.is_empty() { fallback.to_string() } else { t }
}
pub fn room_name(template: &str, user: &str, n: i64) -> String {
    let tpl = if template.is_empty() { "{user}'s room" } else { template };
    let who = sanitize_name(user, "Someone");
    let filled = tpl.replace("{user}", &who).replace("{USER}", &who).replace("{n}", &n.to_string()).replace("{N}", &n.to_string());
    sanitize_name(&filled, "Room")
}
/// Discord allows two renames per channel in ten minutes: (allowed, the kept times, when to try again).
pub fn check_rename(list: &[i64], now: i64) -> (bool, Vec<i64>, i64) {
    let kept: Vec<i64> = list.iter().copied().filter(|t| now - t < RENAME_WINDOW).collect();
    if kept.len() >= RENAME_LIMIT { let retry = kept[0] + RENAME_WINDOW; return (false, kept, retry); }
    let mut next = kept;
    next.push(now);
    (true, next, 0)
}
/// Who gets a room when its owner leaves: whoever has been there longest.
pub fn next_owner(members: &[String], owner: &str, joined: &HashMap<String, i64>) -> Option<String> {
    let mut others: Vec<&String> = members.iter().filter(|m| *m != owner).collect();
    others.sort_by(|a, b| joined.get(*a).unwrap_or(&i64::MAX).cmp(joined.get(*b).unwrap_or(&i64::MAX)).then(a.cmp(b)));
    others.first().map(|s| s.to_string())
}

// ------------------------------------------------------------------ event hubs (Good Boy 3's src/eventhub.js)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub n: i64,
    pub members: Vec<String>,
    #[serde(default)]
    pub invited: Vec<String>,
    pub open: bool,
    pub room_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub name: String,
    pub size: i64,
    pub max_teams: i64,
    pub by: String,
    pub channel_id: Option<String>,
    pub category_id: Option<String>,
    pub message_id: Option<String>,
    pub teams: Vec<Team>,
    pub queue: Vec<String>,
    pub locked: bool,
    pub ended: bool,
    pub created_at: i64,
    pub next_n: i64,
}
impl Event {
    pub fn new(name: &str, size: i64, max_teams: i64, by: &str, channel: &str, category: Option<String>, now: i64) -> Result<Event, String> {
        if !SIZES.contains(&size) { return Err(format!("Team size must be one of {}.", SIZES.iter().map(i64::to_string).collect::<Vec<_>>().join(", "))); }
        if !(1..=50).contains(&max_teams) { return Err("Most teams must be 1 to 50.".into()); }
        let name: String = name.trim().chars().take(60).collect();
        Ok(Event { id: "new".into(), name: if name.is_empty() { "Event".into() } else { name }, size, max_teams, by: by.into(), channel_id: Some(channel.into()), category_id: category, created_at: now, next_n: 1, ..Default::default() })
    }
    fn space(&self, t: &Team) -> i64 { self.size - t.members.len() as i64 - t.invited.len() as i64 }
    pub fn place_of(&self, uid: &str) -> Option<(bool, Option<&Team>)> {
        if self.queue.iter().any(|q| q == uid) { return Some((true, None)); }
        self.teams.iter().find(|t| t.members.iter().any(|m| m == uid)).map(|t| (false, Some(t)))
    }
    fn can_join(&self) -> Option<&'static str> {
        if self.ended { Some("This event has ended.") } else if self.locked { Some("The event is locked: no new players right now.") } else { None }
    }
    fn new_team(&mut self, members: Vec<String>, open: bool, invited: Vec<String>) -> usize {
        let n = self.next_n;
        self.next_n += 1;
        self.teams.push(Team { n, members, invited, open, room_id: None });
        self.teams.len() - 1
    }
    /// Join and be matched with others: into the fullest open team, or the queue (a team forms when enough wait).
    pub fn join_solo(&mut self, uid: &str) -> Result<Joined, String> {
        if let Some(why) = self.can_join() { return Err(why.into()); }
        if self.place_of(uid).is_some() { return Err("You are already in this event. Press Leave first to change.".into()); }
        let open = self.teams.iter().enumerate().filter(|(_, t)| t.open && self.space(t) > 0).min_by_key(|(_, t)| (self.space(t), t.n)).map(|(i, _)| i);
        if let Some(i) = open {
            self.teams[i].members.push(uid.to_string());
            if self.space(&self.teams[i]) <= 0 { self.teams[i].open = false; }
            return Ok(Joined::Added(self.teams[i].clone()));
        }
        self.queue.push(uid.to_string());
        if self.queue.len() as i64 >= self.size {
            if self.teams.len() as i64 >= self.max_teams { return Ok(Joined::QueuedFull(self.queue.len())); }
            let members: Vec<String> = self.queue.drain(..self.size as usize).collect();
            let i = self.new_team(members, false, Vec::new());
            return Ok(Joined::Formed(self.teams[i].clone()));
        }
        Ok(Joined::Queued { position: self.queue.len(), needed: self.size - self.queue.len() as i64 })
    }
    /// Make a team, optionally inviting friends.
    pub fn make_team(&mut self, uid: &str, invited: &[String], open: bool) -> Result<Team, String> {
        if let Some(why) = self.can_join() { return Err(why.into()); }
        if self.place_of(uid).is_some() { return Err("You are already in this event. Press Leave first to change.".into()); }
        if self.teams.len() as i64 >= self.max_teams { return Err(format!("The event is full ({} teams).", self.max_teams)); }
        let mut friends: Vec<String> = Vec::new();
        for f in invited { if f != uid && !friends.contains(f) { friends.push(f.clone()); } }
        if friends.len() as i64 > self.size - 1 { return Err(format!("A team has {} players, so pick up to {} friends.", self.size, self.size - 1)); }
        if let Some(busy) = friends.iter().find(|f| self.place_of(f).is_some()) { return Err(format!("<@{busy}> is already in this event.")); }
        let open = open && (friends.len() as i64) < self.size - 1;
        let i = self.new_team(vec![uid.to_string()], open, friends);
        Ok(self.teams[i].clone())
    }
    pub fn accept(&mut self, n: i64, uid: &str) -> Result<Team, String> {
        if self.ended { return Err("This event has ended.".into()); }
        let Some(i) = self.teams.iter().position(|t| t.n == n) else { return Err("That team is gone.".into()) };
        if !self.teams[i].invited.iter().any(|x| x == uid) { return Err("That invite is not for you.".into()); }
        match self.place_of(uid) { Some((true, _)) => self.queue.retain(|x| x != uid), Some(_) => return Err("You are already on another team. Press Leave first.".into()), None => {} }
        self.teams[i].invited.retain(|x| x != uid);
        self.teams[i].members.push(uid.to_string());
        if self.space(&self.teams[i]) <= 0 { self.teams[i].open = false; }
        Ok(self.teams[i].clone())
    }
    pub fn decline(&mut self, n: i64, uid: &str) -> Result<Team, String> {
        let Some(i) = self.teams.iter().position(|t| t.n == n && t.invited.iter().any(|x| x == uid)) else { return Err("That invite is not for you.".into()) };
        self.teams[i].invited.retain(|x| x != uid);
        Ok(self.teams[i].clone())
    }
    /// Leave the queue or a team: (from the queue, the team, the team is now empty and gone).
    pub fn leave(&mut self, uid: &str) -> Result<(bool, Option<Team>, bool), String> {
        if self.queue.iter().any(|q| q == uid) { self.queue.retain(|x| x != uid); return Ok((true, None, false)); }
        let Some(i) = self.teams.iter().position(|t| t.members.iter().any(|m| m == uid)) else { return Err("You are not in this event.".into()) };
        self.teams[i].members.retain(|x| x != uid);
        if self.teams[i].members.is_empty() { let t = self.teams.remove(i); return Ok((false, Some(t), true)); }
        if self.space(&self.teams[i]) > 0 { self.teams[i].open = true; }
        Ok((false, Some(self.teams[i].clone()), false))
    }
    pub fn drop_team(&mut self, n: i64) -> bool {
        let before = self.teams.len();
        self.teams.retain(|t| t.n != n);
        self.teams.len() != before
    }
    /// Spots opened: who waiting joined which team, and the teams newly formed from the queue.
    pub fn drain_queue(&mut self) -> (Vec<(Team, String)>, Vec<Team>) {
        let (mut added, mut formed) = (Vec::new(), Vec::new());
        if self.ended || self.locked { return (added, formed); }
        for i in 0..self.teams.len() {
            if !self.teams[i].open { continue; }
            while !self.queue.is_empty() && self.space(&self.teams[i]) > 0 {
                let uid = self.queue.remove(0);
                self.teams[i].members.push(uid.clone());
                added.push((self.teams[i].clone(), uid));
            }
            if self.space(&self.teams[i]) <= 0 { self.teams[i].open = false; }
        }
        while self.queue.len() as i64 >= self.size && (self.teams.len() as i64) < self.max_teams {
            let members: Vec<String> = self.queue.drain(..self.size as usize).collect();
            let i = self.new_team(members, false, Vec::new());
            formed.push(self.teams[i].clone());
        }
        (added, formed)
    }
    /// (teams, players, waiting, open spots)
    pub fn summary(&self) -> (usize, usize, usize, i64) {
        (self.teams.len(), self.teams.iter().map(|t| t.members.len()).sum::<usize>() + self.queue.len(), self.queue.len(), self.teams.iter().filter(|t| t.open).map(|t| self.space(t)).sum())
    }
}
#[derive(Debug, Clone, PartialEq)]
pub enum Joined {
    Added(Team),
    Formed(Team),
    Queued { position: usize, needed: i64 },
    QueuedFull(usize),
}
fn size_label(n: i64) -> String {
    match n { 2 => "Duos (2)".into(), 3 => "Trios (3)".into(), 4 => "Squads (4)".into(), n => format!("Teams of {n}") }
}
/// The sign-up panel (Good Boy 3's panelFor).
pub fn panel(ev: &Event) -> Card {
    let (teams, players, _, open_spots) = ev.summary();
    let lines: Vec<String> = ev.teams.iter().map(|t| {
        let who: Vec<String> = t.members.iter().map(|u| format!("<@{u}>")).collect();
        let inv = if t.invited.is_empty() { String::new() } else { format!(" · invited {}", t.invited.iter().map(|u| format!("<@{u}>")).collect::<Vec<_>>().join(" ")) };
        let space = ev.size - t.members.len() as i64 - t.invited.len() as i64;
        format!("**Team {}** {}{inv}{}{}", t.n, who.join(" "), if space > 0 { if t.open { format!(" · {space} open") } else { format!(" · {space} kept") } } else { String::new() }, t.room_id.as_ref().map(|r| format!(" · <#{r}>")).unwrap_or_default())
    }).collect();
    let mut list = String::new();
    for (k, l) in lines.iter().enumerate() {
        if list.len() + l.len() > 3000 { list.push_str(&format!("\n…and {} more teams", lines.len() - k)); break; }
        if !list.is_empty() { list.push('\n'); }
        list.push_str(l);
    }
    let state = if ev.ended { "This event has ended." } else if ev.locked { "Sign-ups are locked." } else { "**Join solo** to be matched, **Join with friends** to pick your team, or **Make a team room** and let others fill it." };
    let waiting = if ev.queue.is_empty() { String::new() } else { format!("\n\nWaiting for a team: {}", ev.queue.iter().map(|u| format!("<@{u}>")).collect::<Vec<_>>().join(" ")) };
    let mut card = Card::new(Area::General).title(format!("{} · {}", ev.name, size_label(ev.size))).line(format!("{state}\n\n{}{waiting}", if list.is_empty() { "_No teams yet._".to_string() } else { list }))
        .line(format!("-# {teams}/{} teams · {players} players{}", ev.max_teams, if open_spots > 0 { format!(" · {open_spots} open spots") } else { String::new() }));
    card.accent = Some(if ev.ended { 0x6b7280 } else if ev.locked { 0xf59e0b } else { 0x5865f2 });
    if ev.ended { return card; }
    let full = ev.locked || ev.teams.len() as i64 >= ev.max_teams;
    card.button_full(format!("tvev:solo:{}", ev.id), "Join solo", ButtonStyle::Good, None, ev.locked)
        .button_full(format!("tvev:friends:{}", ev.id), "Join with friends", ButtonStyle::Primary, None, full)
        .button_full(format!("tvev:make:{}", ev.id), "Make a team room", ButtonStyle::Plain, None, full)
        .button(format!("tvev:leave:{}", ev.id), "Leave", ButtonStyle::Plain)
        .button(format!("tvev:lock:{}", ev.id), if ev.locked { "Unlock sign-ups" } else { "Lock sign-ups" }, ButtonStyle::Plain)
        .button(format!("tvev:end:{}", ev.id), "End event", ButtonStyle::Danger)
}
fn event_fields(channel: &str) -> Vec<Field> {
    vec![
        Field { id: "name".into(), label: "Event name".into(), max: 60, required: true, placeholder: Some("Fortnite Battle Duos".into()), ..Default::default() },
        Field { id: "size".into(), label: "Players per team".into(), kind: FieldKind::Select(SIZES.iter().map(|n| (size_label(*n), n.to_string())).collect()), value: Some("2".into()), required: true, ..Default::default() },
        Field { id: "maxTeams".into(), label: "Most teams (optional)".into(), desc: Some("Empty means 10. Players past this wait in a queue.".into()), max: 2, placeholder: Some("10".into()), ..Default::default() },
        Field { id: "channel".into(), label: "Post the sign-up panel in".into(), kind: FieldKind::Channel(vec![0]), value: Some(channel.into()), required: true, ..Default::default() },
        Field { id: "category".into(), label: "Category for team rooms (optional)".into(), desc: Some("Empty means the panel channel's category.".into()), kind: FieldKind::Channel(vec![4]), ..Default::default() },
    ]
}
fn friend_fields(ev: &Event) -> Vec<Field> {
    let mut f = vec![Field { id: "friends".into(), label: if ev.size == 2 { "Your teammate".into() } else { format!("Your teammates (up to {})", ev.size - 1) }, kind: FieldKind::User { most: (ev.size - 1) as u8 }, required: true, ..Default::default() }];
    if ev.size > 2 { f.push(Field { id: "fill".into(), label: "Empty spots".into(), kind: FieldKind::Select(vec![("Let solo players fill them".into(), "yes".into()), ("Keep them for us".into(), "no".into())]), value: Some("yes".into()), required: true, ..Default::default() }); }
    f
}

// ------------------------------------------------------------------ memory kept only while running
#[derive(Default)]
struct Memory {
    renames: HashMap<String, Vec<i64>>,
    last_made: HashMap<String, i64>,
    joined_at: HashMap<String, HashMap<String, i64>>,
    bots: HashSet<String>,
}
fn memory() -> std::sync::MutexGuard<'static, Memory> {
    static M: OnceLock<Mutex<Memory>> = OnceLock::new();
    M.get_or_init(Mutex::default).lock().unwrap_or_else(|p| p.into_inner())
}
/// Two button presses never change one event at once.
fn event_lock() -> std::sync::MutexGuard<'static, ()> {
    static L: OnceLock<Mutex<()>> = OnceLock::new();
    L.get_or_init(Mutex::default).lock().unwrap_or_else(|p| p.into_inner())
}
fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}

/// A room, as Good Boy 3 stores it (`room:<channel id>`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub id: String,
    pub owner: Option<String>,
    #[serde(default)]
    pub lobby: Option<String>,
    pub created_at: i64,
    pub privacy: String,
    #[serde(default)]
    pub n: i64,
    #[serde(default)]
    pub banned: Vec<String>,
    #[serde(default)]
    pub empty_since: Option<i64>,
    #[serde(default)]
    pub grace_until: Option<i64>,
    #[serde(default)]
    pub event: Option<String>,
    #[serde(default)]
    pub team: Option<i64>,
}

pub struct TempVoice<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub dir: &'a Directory,
    pub guild: &'a str,
}
impl TempVoice<'_> {
    fn data(&self) -> Data<'_> {
        Data { db: self.db, guild: self.guild, module: MODULE }
    }
    fn int(&self, k: &str) -> i64 {
        self.settings.int(self.guild, MODULE, k)
    }
    fn room(&self, id: &str) -> Option<Room> {
        self.data().get(&format!("room:{id}")).and_then(|v| serde_json::from_value(v).ok())
    }
    fn save_room(&self, r: &Room) {
        self.data().set(&format!("room:{}", r.id), &json!(r));
    }
    fn rooms(&self) -> Vec<Room> {
        self.data().list("room:").into_iter().filter_map(|(_, v)| serde_json::from_value(v).ok()).collect()
    }
    fn lobby(&self, id: &str) -> Option<serde_json::Value> {
        self.data().get(&format!("lobby:{id}"))
    }
    fn event(&self, id: &str) -> Option<Event> {
        self.data().get(&format!("ev:{id}")).and_then(|v| serde_json::from_value(v).ok())
    }
    fn save_event(&self, e: &Event) {
        self.data().set(&format!("ev:{}", e.id), &json!(e));
    }
    fn events(&self) -> Vec<Event> {
        self.data().list("ev:").into_iter().filter_map(|(_, v)| serde_json::from_value(v).ok()).collect()
    }
    /// People (not bots, not me) in a voice channel.
    fn humans(&self, channel: &str) -> Vec<String> {
        let (me, bots) = (self.dir.me(), memory().bots.clone());
        self.dir.in_voice(self.guild, channel).into_iter().filter(|u| Some(u) != me.as_ref() && !bots.contains(u)).collect()
    }

    // ------------------------------------------------------------ rooms following voice
    /// Someone moved between voice channels (`from`/`to`: channel ids, None = not in voice).
    pub fn on_voice(&self, who: &crate::Member, from: Option<&str>, to: Option<&str>, now: i64) -> Vec<Action> {
        if who.bot { memory().bots.insert(who.id.clone()); return Vec::new(); }
        if from == to { return Vec::new(); }
        let mut out = Vec::new();
        if let Some(old) = from {
            if let Some(mut room) = self.room(old) {
                if let Some(j) = memory().joined_at.get_mut(old) { j.remove(&who.id); }
                room.empty_since = None;
                let inside = self.humans(old);
                if inside.is_empty() {
                    room.empty_since = Some(now);
                    self.save_room(&room);
                    out.extend(self.remove_if_empty(&room.id, false, false, now));
                    let wait = self.int("emptyDelaySeconds");
                    if wait > 0 { out.push(Action::Later { after_ms: (wait * 1000 + 50) as u64, note: format!("tv:empty:{}", room.id) }); }
                } else if room.owner.as_deref() == Some(who.id.as_str()) && self.settings.text(self.guild, MODULE, "ownerLeaves").as_deref() != Some("claim") {
                    let joined = memory().joined_at.get(old).cloned().unwrap_or_default();
                    if let Some(next) = next_owner(&inside, &who.id, &joined) { out.extend(self.set_owner(&mut room, &next)); }
                } else { self.save_room(&room); }
            }
        }
        if let Some(new) = to {
            if let Some(mut room) = self.room(new) {
                memory().joined_at.entry(new.to_string()).or_default().insert(who.id.clone(), now);
                if room.empty_since.is_some() || room.grace_until.is_some() { room.empty_since = None; room.grace_until = None; self.save_room(&room); }
            } else if let Some(lobby) = self.lobby(new) {
                out.extend(self.make_room(who, new, &lobby, now));
            }
        }
        out
    }
    fn set_owner(&self, room: &mut Room, new: &str) -> Vec<Action> {
        let mut out = Vec::new();
        if let Some(old) = &room.owner { out.push(Action::ClearOverwrite { channel: room.id.clone(), id: old.clone() }); }
        out.push(Action::Overwrite { channel: room.id.clone(), id: new.into(), role: false, allow: OWNER_ALLOW, deny: 0, clear: 0 });
        room.owner = Some(new.into());
        self.save_room(room);
        out
    }
    fn make_room(&self, who: &crate::Member, lobby_id: &str, lobby: &serde_json::Value, now: i64) -> Vec<Action> {
        let key = format!("{}:{}", who.id, self.guild);
        if let Some(r) = self.rooms().into_iter().find(|r| r.owner.as_deref() == Some(who.id.as_str()) && r.event.is_none()) {
            return vec![Action::MoveMember { user: who.id.clone(), channel: Some(r.id) }];
        }
        { let mut m = memory(); if now - m.last_made.get(&key).copied().unwrap_or(0) < 10_000 { return Vec::new(); } m.last_made.insert(key, now); }
        if self.rooms().len() as i64 >= self.int("maxRooms") {
            return vec![Action::Dm { user: who.id.clone(), card: Card::new(Area::General).line("Sorry, the server has too many temporary rooms right now. Try again soon."), or_in: None }];
        }
        let n = self.data().get("counter").and_then(|v| v.as_i64()).unwrap_or(0) + 1;
        self.data().set("counter", &json!(n));
        let template = lobby["template"].as_str().map(str::to_string).or_else(|| self.settings.text(self.guild, MODULE, "nameTemplate")).unwrap_or_default();
        let limit = lobby["limit"].as_i64().unwrap_or_else(|| self.int("defaultLimit")).clamp(0, 99);
        vec![Action::OpenRoom { name: room_name(&template, &who.name, n), category: lobby["categoryId"].as_str().map(str::to_string), inherit_from: lobby_id.to_string(), limit: limit as u32, owner: Some(who.id.clone()), allow: Vec::new(), lock: false, move_in: vec![who.id.clone()], note: format!("tvroom:{lobby_id}:{n}:{}", who.id) }]
    }
    /// Deletes a room that is empty (after the wait, unless `force`); gone rooms are forgotten.
    fn remove_if_empty(&self, id: &str, force: bool, ignore_grace: bool, now: i64) -> Vec<Action> {
        let Some(mut room) = self.room(id) else { return Vec::new() };
        if !self.humans(id).is_empty() { return Vec::new(); }
        if !ignore_grace && room.grace_until.is_some_and(|g| now < g) { return Vec::new(); }
        let wait = self.int("emptyDelaySeconds") * 1000;
        if !force && wait > 0 {
            let since = *room.empty_since.get_or_insert(now);
            self.save_room(&room);
            if now - since < wait { return Vec::new(); }
        }
        let mut out = vec![Action::DeleteChannel { channel: id.into(), after_secs: 0 }];
        out.extend(self.forget(&room, now));
        let _ = &mut room;
        out
    }
    /// The room is gone: forget it, and if it was an event team's room, take the team off the event.
    fn forget(&self, room: &Room, now: i64) -> Vec<Action> {
        self.data().delete(&format!("room:{}", room.id));
        { let mut m = memory(); m.renames.remove(&room.id); m.joined_at.remove(&room.id); }
        match (&room.event, room.team) { (Some(ev), Some(n)) => self.team_room_gone(ev, n, now), _ => Vec::new() }
    }
    /// A channel was deleted by someone: rooms and lobbies are forgotten.
    pub fn channel_gone(&self, channel: &str, now: i64) -> Vec<Action> {
        let mut out = Vec::new();
        if let Some(r) = self.room(channel) { out.extend(self.forget(&r, now)); }
        if self.lobby(channel).is_some() { self.data().delete(&format!("lobby:{channel}")); }
        out
    }
    /// The room was made (`Action::OpenRoom`): remember it.
    pub fn room_made(&self, note: &str, channel: &str, now: i64) -> Vec<Action> {
        let p: Vec<&str> = note.split(':').collect();
        match p.as_slice() {
            ["tvroom", lobby, n, owner] => { self.save_room(&Room { id: channel.into(), owner: Some((*owner).into()), lobby: Some((*lobby).into()), created_at: now, privacy: "public".into(), n: n.parse().unwrap_or(0), ..Default::default() }); Vec::new() }
            ["tvteam", ev, n] => self.team_room_made(ev, n.parse().unwrap_or(0), channel, now),
            _ => Vec::new(),
        }
    }
    /// The creator could not be moved in: the room is removed again.
    pub fn room_unused(&self, channel: &str) -> Vec<Action> {
        self.data().delete(&format!("room:{channel}"));
        vec![Action::DeleteChannel { channel: channel.into(), after_secs: 0 }]
    }
    /// Timers and the sweep: empty rooms go, lobbies whose channel is gone are forgotten.
    pub fn later(&self, note: &str, now: i64) -> Vec<Action> {
        match note.strip_prefix("tv:empty:") { Some(id) => self.remove_if_empty(id, true, false, now), None => Vec::new() }
    }
    pub fn sweep(&self, now: i64) -> Vec<Action> {
        let ids: HashSet<String> = self.dir.channels(self.guild).into_iter().map(|c| c.id).collect();
        let mut out = Vec::new();
        for r in self.rooms() {
            if !ids.is_empty() && !ids.contains(&r.id) { out.extend(self.forget(&r, now)); continue; }
            out.extend(self.remove_if_empty(&r.id, false, false, now));
        }
        out
    }

    // ------------------------------------------------------------ /room
    fn my_room(&self, ev: &CommandEvent, owner_only: bool) -> Result<Room, String> {
        let here = self.dir.voice_of(self.guild, &ev.member.id);
        let Some(room) = here.as_deref().and_then(|c| self.room(c)) else { return Err("Join one of your temporary rooms first, then use this command.".into()) };
        if owner_only && room.owner.as_deref() != Some(ev.member.id.as_str()) && !perms::allowed(self.db, self.guild, &ev.member, MANAGE) {
            let claim = self.settings.text(self.guild, MODULE, "ownerLeaves").as_deref() == Some("claim");
            return Err(format!("Only the room's owner can do that. The owner is <@{}>{}.", room.owner.clone().unwrap_or_default(), if claim { ", or use `/room claim` if they have left" } else { "" }));
        }
        Ok(room)
    }
    pub fn room_command(&self, ev: &CommandEvent) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, USE) { return private(format!("You don't have permission for that (`{}`).", USE.key)); }
        let me = ev.member.id.as_str();
        let sub = ev.sub.as_deref().unwrap_or("info");
        let arg = |k: &str| ev.args.get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        if sub == "info" {
            let room = match self.my_room(ev, false) { Ok(r) => r, Err(no) => return private(no) };
            let name = self.dir.channels(self.guild).into_iter().find(|c| c.id == room.id).map(|c| c.name).unwrap_or_else(|| "room".into());
            return private(format!("**{name}** · owner <@{}> · {} inside · {}{}", room.owner.clone().unwrap_or_default(), self.humans(&room.id).len(), room.privacy, if room.banned.is_empty() { String::new() } else { format!(" · {} banned", room.banned.len()) }));
        }
        if sub == "claim" {
            let mut room = match self.my_room(ev, false) { Ok(r) => r, Err(no) => return private(no) };
            if room.owner.as_deref() == Some(me) { return private("You already own this room."); }
            if room.owner.as_ref().is_some_and(|o| self.dir.voice_of(self.guild, o).as_deref() == Some(room.id.as_str())) { return private("The owner is still here."); }
            let mut out = private("You now own this room.");
            out.extend(self.set_owner(&mut room, me));
            return out;
        }
        let mut room = match self.my_room(ev, true) { Ok(r) => r, Err(no) => return private(no) };
        let target = || -> Result<&crate::Member, String> {
            let u = ev.target.as_ref().ok_or("Pick someone.")?;
            if u.id == me { return Err("Pick someone else.".into()); }
            if u.bot { return Err("Pick a person.".into()); }
            Ok(u)
        };
        match sub {
            "name" => {
                let (ok, list, retry) = check_rename(&memory().renames.get(&room.id).cloned().unwrap_or_default(), ev.at_ms);
                if !ok { return private(format!("Discord only lets a room be renamed twice every 10 minutes. Try again <t:{}:R>.", (retry + 999) / 1000)); }
                let name = sanitize_name(&arg("name").unwrap_or_default(), "Room");
                memory().renames.insert(room.id.clone(), list);
                let mut out = private(format!("Renamed to **{name}**."));
                out.push(Action::RoomEdit { channel: room.id.clone(), name: Some(name), limit: None });
                out
            }
            "limit" => {
                let n = arg("people").and_then(|p| p.parse::<i64>().ok()).unwrap_or(-1);
                if !(0..=99).contains(&n) { return private("Pick 0 (no limit) to 99."); }
                let mut out = private(if n > 0 { format!("Limit set to {n}.") } else { "Limit removed.".to_string() });
                out.push(Action::RoomEdit { channel: room.id.clone(), name: None, limit: Some(n as u32) });
                out
            }
            "privacy" => {
                let mode = arg("mode").unwrap_or_default();
                let (deny, text) = match mode.as_str() {
                    "public" => (0, "Anyone can see and join the room."),
                    "locked" => (CONNECT, "The room is visible but only people you invite can join."),
                    "hidden" => (CONNECT | VIEW, "The room is hidden. Only people you invite can see and join it."),
                    _ => return private("Choose public, locked or hidden."),
                };
                room.privacy = mode;
                self.save_room(&room);
                let mut out = private(text);
                out.push(Action::Overwrite { channel: room.id.clone(), id: self.guild.into(), role: true, allow: 0, deny, clear: CONNECT | VIEW });
                out
            }
            "invite" | "permit" => {
                let u = match target() { Ok(u) => u, Err(no) => return private(no) };
                room.banned.retain(|b| *b != u.id);
                self.save_room(&room);
                let mut out = private(format!("<@{}> can join.", u.id));
                out.push(Action::Overwrite { channel: room.id.clone(), id: u.id.clone(), role: false, allow: VIEW | CONNECT, deny: 0, clear: 0 });
                out
            }
            "kick" => {
                let u = match target() { Ok(u) => u, Err(no) => return private(no) };
                if self.dir.voice_of(self.guild, &u.id).as_deref() != Some(room.id.as_str()) { return private("They are not in your room."); }
                let mut out = private(format!("Removed <@{}> from the room. They can come back unless you ban them.", u.id));
                out.push(Action::MoveMember { user: u.id.clone(), channel: None });
                out
            }
            "ban" => {
                let u = match target() { Ok(u) => u, Err(no) => return private(no) };
                if !room.banned.contains(&u.id) { room.banned.push(u.id.clone()); }
                self.save_room(&room);
                let mut out = private(format!("<@{}> can't join this room.", u.id));
                out.push(Action::Overwrite { channel: room.id.clone(), id: u.id.clone(), role: false, allow: 0, deny: CONNECT | VIEW, clear: 0 });
                if self.dir.voice_of(self.guild, &u.id).as_deref() == Some(room.id.as_str()) { out.push(Action::MoveMember { user: u.id.clone(), channel: None }); }
                out
            }
            "transfer" => {
                let u = match target() { Ok(u) => u, Err(no) => return private(no) };
                if self.dir.voice_of(self.guild, &u.id).as_deref() != Some(room.id.as_str()) { return private("They need to be in the room."); }
                let mut out = private(format!("<@{}> now owns the room.", u.id));
                out.extend(self.set_owner(&mut room, &u.id));
                out
            }
            _ => private("Unknown option."),
        }
    }

    // ------------------------------------------------------------ /voicehub
    pub fn hub_command(&self, ev: &CommandEvent) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private(format!("You don't have permission for that (`{}`).", MANAGE.key)); }
        let arg = |k: &str| ev.args.get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        match ev.sub.as_deref().unwrap_or("list") {
            "event" => vec![Action::Form { id: "tvev:new".into(), title: "Start an event hub".into(), fields: event_fields(&ev.place.channel) }],
            "list" => {
                let lobbies: Vec<String> = self.data().list("lobby:").into_iter().map(|(_, l)| {
                    let limit = l["limit"].as_i64().unwrap_or_else(|| self.int("defaultLimit"));
                    format!("<#{}> · name \"{}\" · limit {}{}", l["id"].as_str().unwrap_or(""), l["template"].as_str().map(str::to_string).or_else(|| self.settings.text(self.guild, MODULE, "nameTemplate")).unwrap_or_default(), if limit > 0 { limit.to_string() } else { "none".into() }, l["categoryId"].as_str().map(|c| format!(" · in <#{c}>")).unwrap_or_default())
                }).collect();
                let evs: Vec<String> = self.events().iter().filter(|e| !e.ended).map(|e| format!("**{}** · teams of {} · {}/{} teams · panel in <#{}>{}", e.name, e.size, e.teams.len(), e.max_teams, e.channel_id.clone().unwrap_or_default(), if e.locked { " · locked" } else { "" })).collect();
                private(format!("{}\n\nOpen rooms: {}{}", if lobbies.is_empty() { "No lobbies yet. Add one with /voicehub add.".to_string() } else { lobbies.join("\n") }, self.rooms().len(), if evs.is_empty() { String::new() } else { format!("\n\n**Event hubs**\n{}", evs.join("\n")) }))
            }
            "remove" => {
                let Some(id) = arg("lobby") else { return private("Pick a lobby.") };
                if self.lobby(&id).is_none() { return private("That channel is not a lobby."); }
                self.data().delete(&format!("lobby:{id}"));
                private(format!("<#{id}> is no longer a lobby. Rooms already open stay until they empty."))
            }
            _ => {
                let Some(id) = arg("lobby") else { return private("Pick a lobby.") };
                if !self.dir.channels(self.guild).iter().any(|c| c.id == id && c.kind == "voice") { return private("The lobby must be a voice channel."); }
                let lobby = json!({ "id": id, "template": arg("name").map(|n| n.chars().take(80).collect::<String>()), "limit": arg("limit").and_then(|l| l.parse::<i64>().ok()), "categoryId": arg("category") });
                self.data().set(&format!("lobby:{id}"), &lobby);
                private(format!("<#{id}> is now a lobby. Joining it creates a room."))
            }
        }
    }

    // ------------------------------------------------------------ event hubs
    fn refresh(&self, ev: &Event) -> Vec<Action> {
        match (&ev.channel_id, &ev.message_id) { (Some(c), Some(m)) => vec![Action::Edit { channel: c.clone(), message: m.clone(), card: panel(ev) }], _ => Vec::new() }
    }
    fn say(&self, ev: &Event, text: String, users: Vec<String>) -> Action {
        Action::Send { channel: ev.channel_id.clone().unwrap_or_default(), card: Card::new(Area::General).line(text), ping: users, roles: Vec::new() }
    }
    /// A voice room for a team that only the team can join; members already in voice are moved in.
    fn open_team_room(&self, ev: &Event, team: &Team) -> Action {
        let panel_cat = ev.category_id.clone();
        Action::OpenRoom {
            name: format!("{} - Team {}", ev.name, team.n).chars().take(100).collect(), category: panel_cat, inherit_from: String::new(), limit: ev.size as u32, owner: None,
            allow: team.members.iter().chain(team.invited.iter()).cloned().collect(), lock: true,
            move_in: team.members.iter().filter(|m| self.dir.voice_of(self.guild, m).is_some()).cloned().collect(), note: format!("tvteam:{}:{}", ev.id, team.n),
        }
    }
    fn team_room_made(&self, ev_id: &str, n: i64, channel: &str, now: i64) -> Vec<Action> {
        let _g = event_lock();
        let Some(mut ev) = self.event(ev_id) else { return vec![Action::DeleteChannel { channel: channel.into(), after_secs: 0 }] };
        let Some(i) = ev.teams.iter().position(|t| t.n == n) else { return vec![Action::DeleteChannel { channel: channel.into(), after_secs: 0 }] };
        ev.teams[i].room_id = Some(channel.into());
        let team = ev.teams[i].clone();
        self.save_event(&ev);
        self.save_room(&Room { id: channel.into(), owner: team.members.first().cloned(), created_at: now, privacy: "locked".into(), event: Some(ev.id.clone()), team: Some(n), grace_until: Some(now + self.int("eventGraceSeconds") * 1000), ..Default::default() });
        let mut out = self.refresh(&ev);
        // a team that formed from the queue (or filled up) hears where to go
        if !team.open && team.invited.is_empty() && team.members.len() as i64 >= ev.size {
            out.push(self.say(&ev, format!("**{} · Team {}** is ready: {}. Hop in <#{channel}>.", ev.name, team.n, team.members.iter().map(|u| format!("<@{u}>")).collect::<Vec<_>>().join(" ")), team.members.clone()));
        }
        out
    }
    fn team_room_gone(&self, ev_id: &str, n: i64, _now: i64) -> Vec<Action> {
        let _g = event_lock();
        let Some(mut ev) = self.event(ev_id) else { return Vec::new() };
        if !ev.drop_team(n) { return Vec::new(); }
        let mut out = self.fill_from_queue(&mut ev);
        self.save_event(&ev);
        out.extend(self.refresh(&ev));
        out
    }
    /// Spots opened up: waiting players get them, and new teams get rooms.
    fn fill_from_queue(&self, ev: &mut Event) -> Vec<Action> {
        let (added, formed) = ev.drain_queue();
        let mut out = Vec::new();
        for (team, uid) in added {
            out.extend(self.let_in(&team, &uid));
            out.push(self.say(ev, format!("<@{uid}>, a spot opened: you're on **{} · Team {}**{}.", ev.name, team.n, team.room_id.as_ref().map(|r| format!(" in <#{r}>")).unwrap_or_default()), vec![uid]));
        }
        for team in formed { out.push(self.open_team_room(ev, &team)); }
        out
    }
    fn let_in(&self, team: &Team, uid: &str) -> Vec<Action> {
        let Some(room) = &team.room_id else { return Vec::new() };
        let mut out = vec![Action::Overwrite { channel: room.clone(), id: uid.into(), role: false, allow: OWNER_ALLOW, deny: 0, clear: 0 }];
        if self.dir.voice_of(self.guild, uid).is_some_and(|c| c != *room) { out.push(Action::MoveMember { user: uid.into(), channel: Some(room.clone()) }); }
        out
    }
    /// The new-event popup or the sign-up buttons' popups.
    pub fn form(&self, ev: &FormEvent) -> Vec<Action> {
        let v = |k: &str| ev.values.get(k).map(|x| x.trim().to_string()).filter(|x| !x.is_empty());
        if ev.id == "tvev:new" {
            if !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private(format!("You don't have permission for that (`{}`).", MANAGE.key)); }
            let Some(name) = v("name") else { return private("Give the event a name.") };
            let channel = v("channel").unwrap_or_else(|| ev.place.channel.clone());
            if !self.dir.channels(self.guild).iter().any(|c| c.id == channel && c.kind == "text") { return private("Pick a text channel for the sign-up panel."); }
            let category = v("category").filter(|c| self.dir.channels(self.guild).iter().any(|x| x.id == *c && x.kind == "category"));
            let mut e = match Event::new(&name, v("size").and_then(|s| s.parse().ok()).unwrap_or(2), v("maxTeams").and_then(|s| s.parse().ok()).unwrap_or(10), &ev.member.id, &channel, category, ev.at_ms) { Ok(e) => e, Err(why) => return private(why) };
            let id = self.data().get("evcounter").and_then(|v| v.as_i64()).unwrap_or(0) + 1;
            self.data().set("evcounter", &json!(id));
            e.id = id.to_string();
            self.save_event(&e);
            let mut out = private(format!("**{}** is open in <#{channel}>. Teams of {}, up to {} teams. Use the panel's buttons to lock sign-ups or end the event.", e.name, e.size, e.max_teams));
            out.push(Action::Post { channel, card: panel(&e), note: format!("tvev:{}", e.id), ping: Vec::new(), roles: Vec::new() });
            return out;
        }
        let Some(id) = ev.id.strip_prefix("tvev:friendsform:") else { return Vec::new() };
        let _g = event_lock();
        let Some(mut e) = self.event(id) else { return private("That event is gone.") };
        let friends: Vec<String> = ev.members.iter().map(|m| m.id.clone()).collect();
        if friends.is_empty() { return private("Pick at least one friend."); }
        if ev.members.iter().any(|m| m.bot) { return private("Pick people, not bots."); }
        let team = match e.make_team(&ev.member.id, &friends, v("fill").as_deref() != Some("no")) { Ok(t) => t, Err(why) => return private(why) };
        self.save_event(&e);
        let mut out = private(format!("Team {} is yours. I asked {} to accept.", team.n, team.invited.iter().map(|u| format!("<@{u}>")).collect::<Vec<_>>().join(" ")));
        out.push(self.open_team_room(&e, &team));
        out.extend(self.refresh(&e));
        let mut ask = Card::new(Area::General).line(format!("{}: <@{}> wants you on their team for **{}**.", team.invited.iter().map(|u| format!("<@{u}>")).collect::<Vec<_>>().join(" "), ev.member.id, e.name))
            .button_with(format!("tvev:accept:{id}:{}", team.n), "Accept", ButtonStyle::Good, None).button(format!("tvev:decline:{id}:{}", team.n), "Decline", ButtonStyle::Plain);
        ask.ping = team.invited.clone();
        out.push(Action::Send { channel: e.channel_id.clone().unwrap_or_default(), card: ask, ping: team.invited.clone(), roles: Vec::new() });
        out
    }
    /// The panel's id is kept when it is posted.
    pub fn posted(&self, note: &str, message: &str) {
        let Some(id) = note.strip_prefix("tvev:") else { return };
        let _g = event_lock();
        if let Some(mut e) = self.event(id) { e.message_id = Some(message.into()); self.save_event(&e); }
    }
    pub fn press(&self, ev: &ButtonEvent, now: i64) -> Vec<Action> {
        let p: Vec<&str> = ev.id.split(':').collect();
        let (what, id) = (p.get(1).copied().unwrap_or(""), p.get(2).copied().unwrap_or(""));
        let me = ev.member.id.as_str();
        if !perms::allowed(self.db, self.guild, &ev.member, USE) { return private(format!("You don't have permission for that (`{}`).", USE.key)); }
        let _g = event_lock();
        let Some(mut e) = self.event(id) else { return private("That event is gone.") };
        match what {
            "friends" => {
                if e.ended || e.locked { return private(if e.ended { "This event has ended." } else { "Sign-ups are locked." }); }
                if e.place_of(me).is_some() { return private("You are already in this event. Press Leave first to change."); }
                vec![Action::Form { id: format!("tvev:friendsform:{id}"), title: format!("Team up · {}", e.name).chars().take(45).collect(), fields: friend_fields(&e) }]
            }
            "lock" | "end" => {
                if !perms::allowed(self.db, self.guild, &ev.member, MANAGE) && e.by != me { return private("Only the event host or staff can do that."); }
                if what == "lock" {
                    e.locked = !e.locked;
                    let mut out = if e.locked { Vec::new() } else { self.fill_from_queue(&mut e) };
                    self.save_event(&e);
                    out.extend(self.refresh(&e));
                    let mut r = private(if e.locked { "Sign-ups are locked. Teams already made keep their rooms." } else { "Sign-ups are open again." });
                    r.extend(out);
                    return r;
                }
                e.ended = true;
                let mut out = private(format!("**{}** has ended. Empty team rooms were removed; the others go when their players leave.", e.name));
                out.extend(self.refresh(&e));
                // rooms with people in them stay until they empty, like any temporary room; empty ones go now
                for t in &e.teams {
                    let Some(rid) = &t.room_id else { continue };
                    let Some(mut room) = self.room(rid) else { continue };
                    room.event = None;
                    room.grace_until = None;
                    self.save_room(&room);
                    if self.humans(rid).is_empty() { out.push(Action::DeleteChannel { channel: rid.clone(), after_secs: 0 }); self.data().delete(&format!("room:{rid}")); }
                    else { out.push(Action::Later { after_ms: 5_000, note: format!("tv:empty:{rid}") }); }
                }
                self.data().delete(&format!("ev:{id}"));
                out
            }
            "solo" | "make" => {
                let res = if what == "solo" { e.join_solo(me) } else { e.make_team(me, &[], true).map(Joined::Added) };
                let joined = match res { Ok(j) => j, Err(why) => return private(why) };
                let mut out: Vec<Action> = Vec::new();
                let reply: String;
                match (&joined, what) {
                    (Joined::Formed(t), _) => { out.push(self.open_team_room(&e, t)); reply = format!("You're on Team {}.", t.n); }
                    (Joined::Added(t), "make") => { out.push(self.open_team_room(&e, t)); reply = format!("You made Team {}. Solo players will fill the other {} spot{}.", t.n, e.size - 1, if e.size == 2 { "" } else { "s" }); }
                    (Joined::Added(t), _) => {
                        out.extend(self.let_in(t, me));
                        reply = format!("You're on Team {}.{}", t.n, t.room_id.as_ref().map(|r| format!(" Your room: <#{r}>.")).unwrap_or_default());
                        if !t.open { out.push(self.say(&e, format!("**{} · Team {}** is full: {}.{}", e.name, t.n, t.members.iter().map(|u| format!("<@{u}>")).collect::<Vec<_>>().join(" "), t.room_id.as_ref().map(|r| format!(" Hop in <#{r}>.")).unwrap_or_default()), t.members.clone())); }
                    }
                    (Joined::Queued { position: _, needed }, _) => reply = format!("You're in the queue. {needed} more player{} needed for the next team, and I'll ping you when it's ready.", if *needed == 1 { "" } else { "s" }),
                    (Joined::QueuedFull(pos), _) => reply = format!("The event is full, so you're on the waiting list (number {pos}). You'll get a team if a spot opens."),
                }
                self.save_event(&e);
                out.extend(self.refresh(&e));
                let mut r = private(reply);
                r.extend(out);
                r
            }
            "accept" | "decline" => {
                let n: i64 = p.get(3).and_then(|n| n.parse().ok()).unwrap_or(0);
                let res = if what == "accept" { e.accept(n, me) } else { e.decline(n, me) };
                let team = match res { Ok(t) => t, Err(why) => return private(why) };
                let mut out = Vec::new();
                if what == "accept" { out.extend(self.let_in(&team, me)); }
                else if let Some(r) = &team.room_id { out.push(Action::ClearOverwrite { channel: r.clone(), id: me.into() }); }
                self.save_event(&e);
                out.extend(self.refresh(&e));
                let mut r = private(if what == "accept" { format!("You're on Team {n}.{}", team.room_id.as_ref().map(|r| format!(" Your room: <#{r}>.")).unwrap_or_default()) } else { "Invite declined.".to_string() });
                r.extend(out);
                r
            }
            "leave" => {
                let (from_queue, team, emptied) = match e.leave(me) { Ok(x) => x, Err(why) => return private(why) };
                let mut out = Vec::new();
                if let Some(t) = &team {
                    if emptied { if let Some(r) = &t.room_id { self.data().delete(&format!("room:{r}")); out.push(Action::DeleteChannel { channel: r.clone(), after_secs: 0 }); } }
                    else if let Some(r) = &t.room_id { out.push(Action::ClearOverwrite { channel: r.clone(), id: me.into() }); }
                }
                out.extend(self.fill_from_queue(&mut e));
                self.save_event(&e);
                out.extend(self.refresh(&e));
                let text = if from_queue { "You left the queue.".to_string() } else if emptied { format!("You left Team {}. Nobody was left, so its room was removed.", team.map(|t| t.n).unwrap_or(0)) } else { format!("You left Team {}. Your spot is open for someone else.", team.map(|t| t.n).unwrap_or(0)) };
                let mut r = private(text);
                r.extend(out);
                let _ = now;
                r
            }
            _ => private("That button is no longer active."),
        }
    }
}
