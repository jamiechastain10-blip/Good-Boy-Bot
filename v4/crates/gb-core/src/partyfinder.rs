//! Good Boy 3's party finder (looking for group): `/party create` posts a party (game, slots, an optional start time
//! and details, an optional voice channel) with Join, Leave and Close; the post changes as people come and go.
//! `/party list|close|kick`. Parties end on their own; members who allow "party invitations" get a DM when a party
//! fills and shortly before it starts. The same data (`p:<id>`, `counter`), rules and wording as Good Boy 3.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::store::Data;
use crate::{notify, Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Def, Field, FieldKind, FormEvent, Kind, Settings};
use serde::{Deserialize, Serialize};
use serde_json::json;

pub const MODULE: &str = "partyfinder";
pub const CREATE: Perm = Perm { key: "partyfinder.create", level: Level::Everyone };
pub const MANAGE: Perm = Perm { key: "partyfinder.manage", level: Level::Moderator(None) };
pub const MIN_SLOTS: i64 = 2;
pub const MAX_SLOTS: i64 = 99;
const MIN: i64 = 60_000;
pub static SETTINGS: &[Def] = &[
    Def { key: "partyChannel", label: "Channel for party posts (default: where /party create is used)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "pingRole", label: "Role pinged when a party is posted (optional)", kind: Kind::Role, default: Fallback::None },
    Def { key: "allowVoice", label: "Let hosts ask for a voice channel", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "voiceCategory", label: "Category for party voice channels", kind: Kind::Category, default: Fallback::None },
    Def { key: "expireMinutes", label: "Minutes a party without a start time stays open", kind: Kind::Number { min: 15, max: 1440 }, default: Fallback::Int(180) },
    Def { key: "maxOpenPerUser", label: "Open parties per member", kind: Kind::Number { min: 1, max: 5 }, default: Fallback::Int(2) },
    Def { key: "maxOpen", label: "Open parties on the server", kind: Kind::Number { min: 1, max: 100 }, default: Fallback::Int(30) },
    Def { key: "timezoneOffset", label: "Server timezone offset from UTC, in hours (used for dates when a member has not set their own time zone)", kind: Kind::Number { min: -12, max: 14 }, default: Fallback::Int(0) },
];
const ID: Opt = Opt { name: "id", about: "Party number", takes: Takes::Whole { min: 1, max: 1_000_000 }, required: true };
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "party", about: "Find players for a game", module: MODULE, options: &[], subs: &[
    Sub { name: "create", about: "Post a party", options: &[
        Opt { name: "game", about: "Which game (leave everything empty for a popup)", takes: Takes::Text, required: false },
        Opt { name: "slots", about: "Total players wanted, including you", takes: Takes::Whole { min: MIN_SLOTS, max: MAX_SLOTS }, required: false },
        Opt { name: "when", about: "Start time: 30m, 2h, 8pm, tomorrow 8pm, or 2026-12-31 18:30 (empty = now)", takes: Takes::Text, required: false },
        Opt { name: "description", about: "Rank, mode, mics, anything else", takes: Takes::Text, required: false },
        Opt { name: "voice", about: "Also make a voice channel for the party", takes: Takes::YesNo, required: false },
        Opt { name: "channel", about: "Where to post it", takes: Takes::Channel, required: false },
    ] },
    Sub { name: "list", about: "Open parties", options: &[] },
    Sub { name: "close", about: "Close a party", options: &[ID] },
    Sub { name: "kick", about: "Remove someone from a party", options: &[ID, Opt { name: "member", about: "Who", takes: Takes::Member, required: true }] },
] }];

/// One party, stored as Good Boy 3 stores it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Party {
    pub id: i64,
    pub owner: String,
    pub game: String,
    #[serde(default)]
    pub description: String,
    pub slots: i64,
    pub members: Vec<String>,
    pub start_at: Option<i64>,
    pub channel_id: String,
    pub message_id: Option<String>,
    pub voice_id: Option<String>,
    /// The voice channel is the host's own (they were in it when they started the party): never deleted by Good Boy.
    #[serde(default)]
    pub voice_own: bool,
    pub status: String,
    pub created_at: i64,
    pub expires_at: i64,
    #[serde(default)]
    pub reminded: bool,
    #[serde(default)]
    pub closed_at: Option<i64>,
    #[serde(default)]
    pub closed_why: Option<String>,
}
impl Party {
    pub fn full(&self) -> bool { self.members.len() as i64 >= self.slots }
    pub fn spots_left(&self) -> i64 { (self.slots - self.members.len() as i64).max(0) }
    /// Joining: the party as it is now and whether it just filled, or why not.
    pub fn join(&self, user: &str, now: i64) -> Result<(Party, bool), &'static str> {
        if self.status == "closed" { return Err("This party is closed."); }
        if self.expires_at <= now { return Err("This party has expired."); }
        if self.members.iter().any(|m| m == user) { return Err("You're already in this party."); }
        if self.full() { return Err("This party is full."); }
        let mut next = self.clone();
        next.members.push(user.to_string());
        next.status = if next.full() { "full" } else { "open" }.into();
        let filled = next.status == "full";
        Ok((next, filled))
    }
    pub fn leave(&self, user: &str) -> Result<Party, &'static str> {
        if self.status == "closed" { return Err("This party is closed."); }
        if user == self.owner { return Err("You're the host. Use **Close** to end the party."); }
        if !self.members.iter().any(|m| m == user) { return Err("You're not in this party."); }
        let mut next = self.clone();
        next.members.retain(|m| m != user);
        next.status = "open".into();
        Ok(next)
    }
}
/// Pings and control characters out, one line (Good Boy 3's cleanText).
pub fn clean_text(t: &str, max: usize) -> String {
    let mut s = t.replace("@everyone", "").replace("@here", "");
    while let Some(at) = s.find("<@") {
        let body = &s[at + 2..];
        let skip = usize::from(body.starts_with(['&', '!']));
        let digits = body[skip..].chars().take_while(char::is_ascii_digit).count();
        if digits > 0 && body[skip + digits..].starts_with('>') { s.replace_range(at..at + 2 + skip + digits + 1, ""); } else { break; }
    }
    s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}
pub fn expiry_for(start_at: Option<i64>, created_at: i64, expire_minutes: i64) -> i64 {
    match start_at { Some(s) => s + 30 * MIN, None => created_at + expire_minutes * MIN }
}

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::Games).line(text).private() }]
}
/// The party's post (Good Boy 3's partyMessage).
pub fn party_card(p: &Party) -> Card {
    let closed = p.status == "closed";
    let mut card = Card::new(Area::Games).title(format!("🎮 {}{}", p.game, if closed { " · closed" } else if p.status == "full" { " · FULL" } else { "" }));
    card.accent = Some(if closed { 0x6b7280 } else if p.status == "full" { 0xf59e0b } else { 0x22c55e });
    if !p.description.is_empty() { card = card.line(p.description.clone()); }
    let players: Vec<String> = p.members.iter().enumerate().map(|(n, id)| format!("{}<@{id}>", if n == 0 { "👑 " } else { "" })).collect();
    card = card.line(format!("**Players ({}/{})**\n{}", p.members.len(), p.slots, if players.is_empty() { "-".into() } else { players.join("\n") }));
    let mut meta = vec![format!("Host <@{}>", p.owner)];
    if let Some(s) = p.start_at { meta.push(format!("Starts <t:{0}:f> (<t:{0}:R>)", s / 1000)); }
    if let Some(v) = p.voice_id.as_ref().filter(|_| !closed) { meta.push(format!("Voice <#{v}>")); }
    if !closed { let n = p.spots_left(); meta.push(if n > 0 { format!("{n} spot{} left", if n == 1 { "" } else { "s" }) } else { "No spots left".into() }); }
    card = card.line(format!("**Details**\n{}", meta.join("\n")));
    if !closed {
        card = card.button_full(format!("party:join:{}", p.id), "Join", ButtonStyle::Good, None, p.full())
            .button(format!("party:leave:{}", p.id), "Leave", ButtonStyle::Plain)
            .button_with(format!("party:ping:{}", p.id), "Ping", ButtonStyle::Plain, Some("📣".into()))
            .button(format!("party:close:{}", p.id), "Close", ButtonStyle::Danger);
    }
    card
}

pub struct PartyFinder<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub guild: &'a str,
    pub server: &'a str,
    /// Who is in which voice channel right now.
    pub directory: &'a crate::bot::Directory,
}
impl PartyFinder<'_> {
    fn data(&self) -> Data<'_> {
        Data { db: self.db, guild: self.guild, module: MODULE }
    }
    fn int(&self, k: &str) -> i64 {
        self.settings.int(self.guild, MODULE, k)
    }
    /// What a member typed as a start time, as a moment. A delay (`30m`, `2h`) needs no time zone. A time of day (`8pm`,
    /// `tomorrow 8pm`) or a date (`2026-12-31 18:30`) is in the member's own time zone (`/me` → Time zone). A date with
    /// no zone saved falls back to the server's offset setting, as it always did.
    fn start_time(&self, owner: &str, input: &str, now: i64) -> Result<i64, String> {
        let text = input.trim();
        if let Some(ms) = crate::time::parse_duration(text) { return Ok(now + ms); }
        let zone = crate::timezones::TimeZones { db: self.db, settings: self.settings, guild: self.guild }.zone_for(owner);
        let low = text.to_lowercase();
        let (days, clock) = match low.split_once(' ') {
            Some(("tomorrow", c)) => (Some(1), c.to_string()),
            Some(("today", c)) => (Some(0), c.to_string()),
            _ => (None, low.clone()),
        };
        if let Some((h, m)) = crate::timezones::parse_clock(&clock) {
            let Some(zone) = zone else { return Err("I don't know your time zone yet, so I can't tell when that is for you. Set it first (`/me` → Time zone), or use a delay like `2h`.".into()) };
            let at = match days {
                Some(d) => crate::timezones::on_day(&zone, d, h, m, now),
                None => crate::timezones::next_at(&zone, h, m, now),
            };
            return at.ok_or_else(|| "I couldn't work out that time.".to_string());
        }
        // a date and time: in the member's zone when they have one
        if let (Some(zone), Some((date, time))) = (zone.as_ref(), text.split_once([' ', 'T'])) {
            let d: Vec<i64> = date.split('-').filter_map(|x| x.parse().ok()).collect();
            if let (3, Some((h, m))) = (d.len(), crate::timezones::parse_clock(time)) {
                if let Some(at) = crate::timezones::at_civil(zone, d[0] as i16, d[1] as i8, d[2] as i8, h, m) { return Ok(at); }
            }
        }
        crate::time::parse_when(text, self.int("timezoneOffset"), now).map_err(|how| format!("{how} You can also say `8pm` or `tomorrow 8pm`."))
    }
    pub fn all(&self) -> Vec<Party> {
        self.data().list("p:").into_iter().filter_map(|(_, v)| serde_json::from_value(v).ok()).collect()
    }
    fn get(&self, id: &str) -> Option<Party> {
        self.data().get(&format!("p:{id}")).and_then(|v| serde_json::from_value(v).ok())
    }
    fn save(&self, p: &Party) {
        self.data().set(&format!("p:{}", p.id), &json!(p));
    }
    fn edit(&self, p: &Party) -> Option<Action> {
        p.message_id.as_ref().map(|m| Action::Edit { channel: p.channel_id.clone(), message: m.clone(), card: party_card(p) })
    }
    fn dm(&self, user: &str, text: String) -> Option<Action> {
        notify::allowed(self.db, self.guild, user, "party-invites").then(|| Action::Dm { user: user.into(), card: Card::new(Area::Games).line(text.chars().take(1900).collect::<String>()), or_in: None })
    }
    fn limits(&self, user: &str) -> Result<(), String> {
        let open: Vec<Party> = self.all().into_iter().filter(|p| p.status != "closed").collect();
        let mine = open.iter().filter(|p| p.owner == user).count() as i64;
        let max_mine = self.int("maxOpenPerUser");
        if mine >= max_mine { return Err(format!("You already have {mine} open part{} (most allowed: {max_mine}). Close one with `/party close`.", if mine == 1 { "y" } else { "ies" })); }
        if open.len() as i64 >= self.int("maxOpen") { return Err("There are too many open parties right now. Try again in a little while.".into()); }
        Ok(())
    }
    fn fields(&self) -> Vec<Field> {
        let mut f = vec![
            Field { id: "game".into(), label: "Game".into(), max: 60, required: true, placeholder: Some("Fortnite, Valorant, Minecraft...".into()), ..Default::default() },
            Field { id: "slots".into(), label: "Players, including you".into(), max: 2, required: true, placeholder: Some("4".into()), ..Default::default() },
            Field { id: "when".into(), label: "Start time (optional)".into(), desc: Some("Empty = now. Like 30m, 2h, 8pm, tomorrow 8pm or 2026-12-31 18:30 (in your time zone)".into()), max: 40, ..Default::default() },
            Field { id: "description".into(), label: "Details (optional)".into(), long: true, max: 300, placeholder: Some("Rank, mode, mics, anything else".into()), ..Default::default() },
        ];
        if self.settings.bool(self.guild, MODULE, "allowVoice") {
            f.push(Field { id: "voice".into(), label: "Voice channel for the party".into(), kind: FieldKind::Select(vec![("No".into(), "no".into()), ("Yes, make one".into(), "yes".into())]), value: Some("no".into()), required: true, ..Default::default() });
        }
        f
    }

    pub fn command(&self, ev: &CommandEvent) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, CREATE) { return private(format!("You don't have permission for that (`{}`).", CREATE.key)); }
        let arg = |k: &str| ev.args.get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        match ev.sub.as_deref().unwrap_or("list") {
            "list" => {
                let mut open: Vec<Party> = self.all().into_iter().filter(|p| p.status != "closed").collect();
                open.sort_by_key(|p| p.start_at.unwrap_or(p.created_at));
                let rows: Vec<String> = open.iter().map(|p| format!("**#{}** {} · {}/{} · host <@{}>{} · [open](https://discord.com/channels/{}/{}/{})", p.id, p.game, p.members.len(), p.slots, p.owner, p.start_at.map(|s| format!(" · <t:{}:R>", s / 1000)).unwrap_or_default(), self.guild, p.channel_id, p.message_id.clone().unwrap_or_default())).collect();
                private(if rows.is_empty() { "No open parties. Start one with `/party create`.".to_string() } else { rows.join("\n").chars().take(1900).collect() })
            }
            sub @ ("close" | "kick") => {
                let Some(mut p) = arg("id").and_then(|i| self.get(&i)).filter(|p| p.status != "closed") else { return private("No open party with that number.") };
                if p.owner != ev.member.id && !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private(format!("You don't have permission for that (`{}`).", MANAGE.key)); }
                if sub == "close" {
                    let mut out = private(format!("Closed party #{}.", p.id));
                    out.extend(self.close(&mut p, "host", ev.at_ms, &|_| 0));
                    return out;
                }
                let Some(u) = ev.target.as_ref() else { return private("Pick a member.") };
                if u.id == p.owner { return private("The host cannot be removed. Close the party instead."); }
                let Ok(next) = p.leave(&u.id) else { return private("They are not in that party.") };
                self.save(&next);
                let mut out = private(format!("Removed <@{}> from party #{}.", u.id, p.id));
                out.extend(self.edit(&next));
                out
            }
            _ => {
                // with nothing filled in, one popup asks for it all
                if arg("game").is_none() && arg("slots").is_none() {
                    if let Err(no) = self.limits(&ev.member.id) { return private(no); }
                    return vec![Action::Form { id: "party:form".into(), title: "Find players".into(), fields: self.fields() }];
                }
                let (Some(game), Some(slots)) = (arg("game"), arg("slots").and_then(|s| s.parse::<i64>().ok())) else { return private("Fill in `game` and `slots`, or leave everything empty to use the popup.") };
                let voice = matches!(arg("voice").as_deref(), Some("true" | "yes"));
                self.create(&ev.member.id, &game, slots, arg("when").as_deref(), arg("description").as_deref(), voice, arg("channel"), &ev.place.channel, ev.at_ms)
            }
        }
    }
    pub fn form(&self, ev: &FormEvent) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, CREATE) { return private(format!("You don't have permission for that (`{}`).", CREATE.key)); }
        let v = |k: &str| ev.values.get(k).map(|x| x.trim().to_string()).filter(|x| !x.is_empty());
        let Some(slots) = v("slots").and_then(|s| s.parse::<i64>().ok()) else { return private("Say how many players, including you.") };
        self.create(&ev.member.id, &v("game").unwrap_or_default(), slots, v("when").as_deref(), v("description").as_deref(), v("voice").as_deref() == Some("yes"), None, &ev.place.channel, ev.at_ms)
    }
    #[allow(clippy::too_many_arguments)]
    fn create(&self, owner: &str, game: &str, slots: i64, when: Option<&str>, description: Option<&str>, voice: bool, channel: Option<String>, here: &str, now: i64) -> Vec<Action> {
        if let Err(no) = self.limits(owner) { return private(no); }
        if !(MIN_SLOTS..=MAX_SLOTS).contains(&slots) { return private(format!("Parties need {MIN_SLOTS} to {MAX_SLOTS} slots (you count as one).")); }
        let game = clean_text(game, 60);
        if game.is_empty() { return private("Say which game this is for."); }
        let mut start_at = None;
        if let Some(w) = when {
            match self.start_time(owner, w, now) {
                Ok(t) if t < now + MIN => return private("The start time is in the past. Use something like `30m`, `2h`, `8pm` or `tomorrow 8pm`."),
                Ok(t) if t > now + 14 * 86_400_000 => return private("Parties can be planned up to two weeks ahead."),
                Ok(t) => start_at = Some(t),
                Err(how) => return private(how),
            }
        }
        if voice && !self.settings.bool(self.guild, MODULE, "allowVoice") { return private("Voice channels for parties are turned off on this server."); }
        let target = channel.or_else(|| self.settings.text(self.guild, MODULE, "partyChannel").filter(|c| !c.is_empty())).unwrap_or_else(|| here.to_string());
        let d = self.data();
        let id = d.get("counter").and_then(|v| v.as_i64()).unwrap_or(0) + 1;
        d.set("counter", &json!(id));
        // the host is already in a voice channel: the party uses it, and members who join are moved there
        let host_vc = self.directory.voice_of(self.guild, owner);
        let p = Party { id, owner: owner.into(), game: game.clone(), description: clean_text(description.unwrap_or(""), 300), slots, members: vec![owner.into()], start_at, channel_id: target.clone(), message_id: None, voice_own: host_vc.is_some(), voice_id: host_vc.clone(),
            status: "open".into(), created_at: now, expires_at: expiry_for(start_at, now, self.int("expireMinutes")), ..Default::default() };
        self.save(&p);
        let mut out = private(format!("Party **#{id}** posted in <#{target}>."));
        if voice && host_vc.is_none() {
            // the voice channel first, so the post shows it; the post follows (`voice_made`, or `voice_failed`)
            let category = self.settings.text(self.guild, MODULE, "voiceCategory").filter(|c| !c.is_empty());
            out.push(Action::OpenVoice { name: format!("{game} · party {id}").chars().take(100).collect(), category, limit: slots as u32, note: format!("party:{id}") });
            return out;
        }
        out.push(self.post(&p));
        out
    }
    fn post(&self, p: &Party) -> Action {
        let role = self.settings.text(self.guild, MODULE, "pingRole").filter(|r| !r.is_empty());
        let mut card = party_card(p);
        if let Some(r) = &role { card = card.line(format!("<@&{r}>")); }
        Action::Post { channel: p.channel_id.clone(), card, note: format!("party:{}", p.id), ping: Vec::new(), roles: role.into_iter().collect() }
    }
    /// The party's post is up, or its voice channel was made.
    pub fn posted(&self, note: &str, message: &str) {
        let Some(id) = note.strip_prefix("party:") else { return };
        if let Some(mut p) = self.get(id) { p.message_id = Some(message.into()); self.save(&p); }
    }
    pub fn voice_made(&self, note: &str, channel: &str) -> Vec<Action> {
        let Some(id) = note.strip_prefix("party:") else { return Vec::new() };
        let Some(mut p) = self.get(id) else { return Vec::new() };
        p.voice_id = Some(channel.into());
        self.save(&p);
        vec![self.post(&p)]
    }
    /// Discord would not make the voice channel: the party is posted without one.
    pub fn voice_failed(&self, note: &str) -> Vec<Action> {
        note.strip_prefix("party:").and_then(|id| self.get(id)).map(|p| vec![self.post(&p)]).unwrap_or_default()
    }
    /// Closes a party; its voice channel goes when nobody is in it. `in_voice(channel)`: how many people are there.
    fn close(&self, p: &mut Party, why: &str, now: i64, in_voice: &dyn Fn(&str) -> usize) -> Vec<Action> {
        if p.status == "closed" { return Vec::new(); }
        p.status = "closed".into();
        p.closed_at = Some(now);
        p.closed_why = Some(why.into());
        let mut out: Vec<Action> = self.edit(p).into_iter().collect();
        if let Some(v) = p.voice_id.clone().filter(|v| !p.voice_own && in_voice(v) == 0) { out.push(Action::DeleteChannel { channel: v, after_secs: 0 }); p.voice_id = None; }
        self.save(p);
        out
    }
    /// The host picked a role to ping for their party. Only a role anyone may mention (as Discord has it set), the
    /// server's own party role, or any role for a server admin; the @everyone role only for an admin. Once every ten
    /// minutes per party.
    pub fn ping_form(&self, ev: &FormEvent, id: &str, mentionable: &dyn Fn(&str) -> bool) -> Vec<Action> {
        let Some(p) = self.get(id).filter(|p| p.status != "closed") else { return private("That party is gone.") };
        if p.owner != ev.member.id && !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private("Only the host can ping a role for this party."); }
        if p.full() { return private("That party is full, so there is nobody left to look for."); }
        let Some(role) = ev.values.get("role").map(|r| r.trim().to_string()).filter(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_digit())) else { return private("Pick a role to ping.") };
        let admin = ev.member.perms & (perms::ADMINISTRATOR | perms::MANAGE_GUILD) != 0;
        let server_role = self.settings.text(self.guild, MODULE, "pingRole").is_some_and(|r| r == role);
        if role == self.guild && !admin { return private("Only a server admin can ping everyone."); }
        if !admin && !server_role && !mentionable(&role) {
            return private("Members can only ping roles that are set to \"Allow anyone to @mention this role\" in the server's role settings. Ask an admin, or pick another role.");
        }
        let d = self.data();
        let key = format!("ping:{id}");
        let last = d.get(&key).and_then(|v| v.as_i64()).unwrap_or(0);
        if ev.at_ms - last < 10 * 60_000 { return private(format!("This party was pinged a moment ago. You can ping again <t:{}:R>.", (last + 10 * 60_000) / 1000)); }
        d.set(&key, &json!(ev.at_ms));
        let open = (p.slots - p.members.len() as i64).max(1);
        let note = ev.values.get("note").map(|n| clean_text(n, 200)).filter(|n| !n.is_empty()).map(|n| format!("\n> {n}")).unwrap_or_default();
        let link = p.message_id.as_ref().map(|m| format!(" · [join here](https://discord.com/channels/{}/{}/{m})", self.guild, p.channel_id)).unwrap_or_default();
        let card = Card::new(Area::Games).line(format!("<@&{role}> <@{}> is looking for {open} more for **{}**{link}{note}", p.owner, p.game));
        let mut out = private("📣 Pinged.");
        out.push(Action::Send { channel: p.channel_id.clone(), card, ping: Vec::new(), roles: vec![role] });
        out
    }
    pub fn press(&self, ev: &ButtonEvent, in_voice: &dyn Fn(&str) -> usize) -> Vec<Action> {
        let parts: Vec<&str> = ev.id.split(':').collect();
        let (what, id) = (parts.get(1).copied().unwrap_or(""), parts.get(2).copied().unwrap_or(""));
        let Some(mut p) = self.get(id) else { return private("That party is gone.") };
        match what {
            "close" => {
                if p.owner != ev.member.id && !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private("Only the host (or a moderator) can close this party."); }
                let mut out = private("Party closed.");
                out.extend(self.close(&mut p, "host", ev.at_ms, in_voice));
                out
            }
            "ping" => {
                if p.owner != ev.member.id && !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private("Only the host can ping a role for this party."); }
                if p.status == "closed" || p.full() { return private("That party is full or closed, so there is nobody left to look for."); }
                vec![Action::Form { id: format!("party:pingform:{id}"), title: "Ping a role for this party".into(), fields: vec![
                    Field { id: "role".into(), label: "Role to ping".into(), kind: FieldKind::Role { most: 1 }, required: true, ..Default::default() },
                    Field { id: "note".into(), label: "Message (optional)".into(), max: 200, placeholder: Some("Rank, mode, mics, anything else".into()), ..Default::default() },
                ] }]
            }
            "join" => match p.join(&ev.member.id, ev.at_ms) {
                Err(no) => private(no),
                Ok((next, filled)) => {
                    self.save(&next);
                    let mut out = vec![Action::Update { card: party_card(&next) }];
                    // already in voice somewhere else: move them to the party's channel (needs Move Members)
                    if let Some(v) = next.voice_id.as_ref() {
                        if self.directory.voice_of(self.guild, &ev.member.id).is_some_and(|c| c != *v) { out.push(Action::MoveMember { user: ev.member.id.clone(), channel: Some(v.clone()) }); }
                    }
                    if filled {
                        let voice = next.voice_id.as_ref().map(|v| format!("Voice: <#{v}>")).unwrap_or_default();
                        out.extend(next.members.iter().filter_map(|m| self.dm(m, format!("🎮 Your **{}** party in **{}** is full! {voice}", next.game, self.server))));
                    }
                    out
                }
            },
            "leave" => match p.leave(&ev.member.id) {
                Err(no) => private(no),
                Ok(next) => { self.save(&next); vec![Action::Update { card: party_card(&next) }] }
            },
            _ => private("Unknown button."),
        }
    }
    /// A party's post was deleted: nothing left to join, so the party ends.
    pub fn deleted(&self, messages: &[String], now: i64, in_voice: &dyn Fn(&str) -> usize) -> Vec<Action> {
        let mut out = Vec::new();
        for mut p in self.all().into_iter().filter(|p| p.status != "closed" && p.message_id.as_ref().is_some_and(|m| messages.contains(m))) {
            p.message_id = None;
            out.extend(self.close(&mut p, "post-deleted", now, in_voice));
        }
        out
    }
    /// Every minute: parties past their time close; closed ones are tidied (their voice channel once it is empty,
    /// or after 6 hours); members are reminded 10 minutes before a start.
    pub fn sweep(&self, now: i64, in_voice: &dyn Fn(&str) -> usize) -> Vec<Action> {
        let mut out = Vec::new();
        for mut p in self.all() {
            if p.status != "closed" && p.expires_at <= now { out.extend(self.close(&mut p, "expired", now, in_voice)); }
            if p.status == "closed" {
                let old = now - p.closed_at.unwrap_or(now) > 6 * 3_600_000;
                match p.voice_id.clone() {
                    Some(v) if in_voice(&v) == 0 || old => { out.push(Action::DeleteChannel { channel: v, after_secs: 0 }); self.data().delete(&format!("p:{}", p.id)); }
                    Some(_) => {}
                    None => self.data().delete(&format!("p:{}", p.id)),
                }
                continue;
            }
            if let Some(s) = p.start_at.filter(|s| !p.reminded && s - now <= 10 * MIN && *s > now - 5 * MIN) {
                p.reminded = true;
                self.save(&p);
                let voice = p.voice_id.as_ref().map(|v| format!(" Voice: <#{v}>")).unwrap_or_default();
                out.extend(p.members.iter().filter_map(|m| self.dm(m, format!("⏰ Your **{}** party in **{}** starts <t:{}:R>.{voice}", p.game, self.server, s / 1000))));
            }
        }
        out
    }
}
