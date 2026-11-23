//! Music: a player card with buttons, a queue, playlists and lyrics. The rules live here; the sound itself is
//! played by the Discord layer, which this module tells what to do (`Action::Music`) and which reports back when
//! a song starts, ends or fails, and what a search found.
//!
//! Settings and playlists are Good Boy 3's (module `music`, playlists under `pl:<id>`), so they carry over.
//! Sources: links straight to an audio file and the server's radio stations always work. Links from YouTube,
//! SoundCloud and similar sites, and searching by name, only work once the bot's owner turns on media links in a
//! server, because those sites' terms forbid it; the owner sees that warning first.

use crate::bot::{CommandSpec, Directory, Opt, Sub, Takes};
use crate::settings::Fallback;
use crate::store::Data;
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Def, Field, FormEvent, Kind, Member, Select, Settings};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

/// The Add music box's label. Discord allows 45 characters.
const ADD_LABEL: &str = "A link, a station or a song to search";
/// For the check that it fits.
pub fn add_form_label() -> &'static str { ADD_LABEL }
pub const MODULE: &str = "music";
pub static SETTINGS: &[Def] = &[
    Def { key: "volume", label: "Volume (%)", kind: Kind::Number { min: 0, max: 100 }, default: Fallback::Int(70) },
    Def { key: "djRole", label: "DJ role: can skip and stop anyone's songs", kind: Kind::Role, default: Fallback::None },
    Def { key: "maxQueue", label: "Most songs in the queue", kind: Kind::Number { min: 5, max: 200 }, default: Fallback::Int(50) },
    Def { key: "maxPerMember", label: "Most songs one member can queue", kind: Kind::Number { min: 1, max: 50 }, default: Fallback::Int(10) },
    Def { key: "autoplay", label: "Autoplay: when the queue runs out, play something from the songs played earlier", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "idleMinutes", label: "Leave voice after this many minutes with nothing playing", kind: Kind::Number { min: 1, max: 60 }, default: Fallback::Int(5) },
    Def { key: "smooth", label: "Download each song before it plays (smoother sound; the first song takes a few seconds to start)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "stations", label: "Radio stations (Name | stream link). Only add stations that allow it.", kind: Kind::List, default: Fallback::None },
    Def { key: "filter", label: "Sound filter for downloaded songs (not radio): off, bass boost, nightcore or slowed", kind: Kind::Select(&["off", "bassboost", "nightcore", "slowed"]), default: Fallback::Str("off") },
    Def { key: "stay", label: "Stay in voice when nothing is playing (24/7)", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "voteSkip", label: "Vote skip: listeners can vote to skip a song they did not add", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "voteSkipPercent", label: "Share of the people in voice that must vote to skip (%)", kind: Kind::Number { min: 10, max: 100 }, default: Fallback::Int(50) },
    Def { key: "allowUploads", label: "Members can upload songs to play", kind: Kind::Toggle, default: Fallback::Bool(true) },
];
const QUERY: Opt = Opt { name: "song", about: "A link, a radio station's name, or a song to search for", takes: Takes::Text, required: true };
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "music", about: "Music in voice: the player, the queue, playlists and lyrics", module: MODULE, options: &[], subs: &[
    Sub { name: "player", about: "Post the music player in this channel", options: &[] },
    Sub { name: "play", about: "Add a song to the queue (you need to be in a voice channel)", options: &[QUERY] },
    Sub { name: "queue", about: "What's playing and what's next", options: &[] },
    Sub { name: "skip", about: "Skip the song that's playing", options: &[] },
    Sub { name: "voteskip", about: "Vote to skip the song that's playing", options: &[] },
    Sub { name: "stop", about: "Stop the music and clear the queue", options: &[] },
    Sub { name: "sound filter", about: "Change how songs sound (bass boost, nightcore, slowed) from the next song on", options: &[Opt { name: "filter", about: "Which sound", takes: Takes::Choice(&[("Off", "off"), ("Bass boost", "bassboost"), ("Nightcore (faster, higher)", "nightcore"), ("Slowed (slower, lower)", "slowed")]), required: true }] },
    Sub { name: "sound volume", about: "Set the volume", options: &[Opt { name: "percent", about: "0 to 100", takes: Takes::Whole { min: 0, max: 100 }, required: true }] },
    Sub { name: "lyrics", about: "The words to the song that's playing", options: &[] },
    Sub { name: "playlists", about: "Pick one of the server's playlists to play", options: &[] },
    Sub { name: "save", about: "Save the queue as a playlist", options: &[Opt { name: "name", about: "The playlist's name", takes: Takes::Text, required: true }] },
    Sub { name: "pause", about: "Pause the song", options: &[] },
    Sub { name: "resume", about: "Carry on with the song", options: &[] },
    Sub { name: "now", about: "What's playing, with the player's buttons (only you see it)", options: &[] },
    Sub { name: "playnext", about: "Add a song to the front of the queue", options: &[QUERY] },
    Sub { name: "remove", about: "Take a song out of the queue", options: &[Opt { name: "position", about: "Its place in the queue (see /music queue)", takes: Takes::Whole { min: 1, max: 200 }, required: true }] },
    Sub { name: "clear", about: "Empty the queue (the song playing carries on)", options: &[] },
    Sub { name: "shuffle", about: "Mix up the queue", options: &[] },
    Sub { name: "repeat", about: "Repeat one song, the whole queue, or nothing", options: &[Opt { name: "mode", about: "What to repeat (empty = the next one in the cycle)", takes: Takes::Choice(&[("off", "off"), ("this song", "one"), ("the whole queue", "all")]), required: false }] },
    Sub { name: "skipto", about: "Jump to a song in the queue", options: &[Opt { name: "position", about: "Its place in the queue", takes: Takes::Whole { min: 1, max: 200 }, required: true }] },
    Sub { name: "seek", about: "Jump to a time in the song", options: &[Opt { name: "time", about: "Seconds, or 1:30", takes: Takes::Text, required: true }] },
    Sub { name: "forward", about: "Skip ahead in the song", options: &[Opt { name: "seconds", about: "How far (default 10)", takes: Takes::Whole { min: 1, max: 3600 }, required: false }] },
    Sub { name: "rewind", about: "Go back in the song", options: &[Opt { name: "seconds", about: "How far (default 10)", takes: Takes::Whole { min: 1, max: 3600 }, required: false }] },
    Sub { name: "voice join", about: "Bring the bot to your voice channel", options: &[] },
    Sub { name: "voice move", about: "Move the bot to another voice channel (the music keeps playing)", options: &[Opt { name: "channel", about: "The voice channel (empty = the one you're in)", takes: Takes::AnyChannel, required: false }] },
    Sub { name: "voice stay", about: "Stay in voice even when nothing is playing (24/7)", options: &[Opt { name: "on", about: "Stay (yes) or leave when idle (no)", takes: Takes::YesNo, required: true }] },
    Sub { name: "grab", about: "Send yourself the song that's playing", options: &[] },
    Sub { name: "favorite add", about: "Save the song that's playing to your favourites", options: &[] },
    Sub { name: "favorite list", about: "Your saved songs, and which number plays which", options: &[] },
    Sub { name: "favorite play", about: "Queue one of your saved songs", options: &[Opt { name: "number", about: "Its number in /music favorite list", takes: Takes::Whole { min: 1, max: 50 }, required: true }] },
    Sub { name: "favorite remove", about: "Take a song off your favourites", options: &[Opt { name: "number", about: "Its number in /music favorite list", takes: Takes::Whole { min: 1, max: 50 }, required: true }] },
    Sub { name: "voice bots", about: "The music bots this server can use", options: &[] },
] }];
pub const AUDIO_EXT: &[&str] = &["mp3", "ogg", "oga", "opus", "wav", "flac", "m4a", "aac", "webm"];
#[path = "musicdash.rs"]
mod dash;
const MAX_PLAYLISTS: usize = 50;
/// How many times a dropped radio stream is picked up again before the player gives up on it.
const RADIO_RETRIES: u8 = 6;
const MAX_PLAYLIST_SONGS: usize = 300;
const MANAGE_CHANNELS: u64 = 1 << 4;

/// One song, in the shape Good Boy 3's playlists keep it (plus who queued it, while it is in a queue).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Track {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seconds: Option<i64>,
    /// "link" (an audio file), "media" (a site, through yt-dlp) or "radio".
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub art: Option<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub by: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub uid: String,
}
impl Track {
    /// What a playlist keeps: enough to find it again, not who queued it.
    pub fn savable(&self) -> Option<Value> {
        if self.url.is_none() && self.page.is_none() && self.search.is_none() { return None; }
        let mut t = self.clone();
        t.by.clear();
        t.uid.clear();
        serde_json::to_value(t).ok()
    }
    fn label(&self) -> String {
        match &self.artist { Some(a) if !a.is_empty() => format!("**{}** · {}", short(&self.title, 80), short(a, 50)), _ => format!("**{}**", short(&self.title, 100)) }
    }
}

/// What the Discord layer tells the music module.
#[derive(Debug, Clone, PartialEq)]
pub enum Heard {
    Started(String),
    Ended(String),
    Failed(String, String),
    /// The bot is no longer in voice (someone disconnected it, or the connection was lost): the player starts over.
    Left,
    /// The bot was moved to another voice channel (by a moderator, or by `/music move`).
    Moved(String),
    /// A spoken message ended, or could not be said (text-to-speech).
    TtsEnded(u64),
    TtsFailed(u64, String),
}
/// What the music module asks the Discord layer to do.
#[derive(Debug, Clone, PartialEq)]
pub enum MusicCmd {
    /// Look a song up (a link, or a search); the answer comes back to `found`.
    Resolve { query: String, by: String, voice: String },
    /// Join this voice channel if needed, and play the song (downloading it first when `smooth`).
    Play { voice: String, track: Box<Track>, volume: u8, smooth: bool, filter: String },
    Pause,
    Resume,
    /// Jump to this many seconds into the song.
    Seek(u64),
    /// Join a voice channel and wait there.
    Join { voice: String },
    /// Go to another voice channel and keep playing.
    Move { voice: String },
    /// Stop the song that is playing (the next one is asked for separately).
    Stop,
    Volume(u8),
    Leave,
    /// Find the words to a song; they are sent to the person who asked.
    Lyrics { title: String, artist: Option<String> },
    /// Get yt-dlp, the free program that reads music sites, into the bot's tools folder.
    GetTools,
}

#[derive(Debug, Default)]
pub struct Player {
    pub queue: Vec<Track>,
    pub now: Option<Track>,
    pub started_ms: i64,
    pub paused_at: Option<i64>,
    pub paused_ms: i64,
    pub repeat: &'static str,
    pub history: Vec<Track>,
    pub voice: Option<String>,
    pub idle_since: Option<i64>,
    pub loading: bool,
    /// Votes to skip the song that began at this time (they start over with the next song).
    pub votes: (i64, Vec<String>),
    /// How many times a dropped radio stream has been picked up again since it last played properly.
    pub radio_tries: u8,
}
/// Every server's player, in memory.
#[derive(Default)]
pub struct Players(Mutex<HashMap<String, Player>>);
impl Players {
    pub fn with<T>(&self, guild: &str, f: impl FnOnce(&mut Player) -> T) -> T {
        let mut all = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let p = all.entry(guild.to_string()).or_insert_with(|| Player { repeat: "off", ..Default::default() });
        f(p)
    }
    pub fn guilds(&self) -> Vec<String> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).keys().cloned().collect()
    }
}

fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}
fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::Music).line(text).private() }]
}
/// "3:07"
pub fn clock(sec: i64) -> String {
    if sec <= 0 { "live".into() } else { format!("{}:{:02}", sec / 60, sec % 60) }
}
/// The radio stations from the setting's lines, "Name | https://stream". Bad lines are skipped.
pub fn stations(lines: &[String]) -> Vec<(String, String)> {
    lines.iter().filter_map(|l| {
        let (name, url) = l.split_once('|')?;
        let (name, url) = (name.trim(), url.trim());
        let ok = !name.is_empty() && (url.starts_with("https://") || url.starts_with("http://")) && !url.contains(char::is_whitespace);
        ok.then(|| (short(name, 80), url.to_string()))
    }).take(25).collect()
}
/// A link straight to an audio file.
pub fn audio_file_link(q: &str) -> bool {
    let q = q.trim();
    (q.starts_with("https://") || q.starts_with("http://")) && !q.contains(char::is_whitespace) && {
        let path = q.split(['?', '#']).next().unwrap_or("");
        path.rsplit('.').next().is_some_and(|ext| AUDIO_EXT.contains(&ext.to_lowercase().as_str()))
    }
}
/// Next in the repeat cycle.
pub fn next_repeat(r: &str) -> &'static str {
    match r { "off" => "one", "one" => "all", _ => "off" }
}

/// What a bot's player is called in memory: the server's id, with `~N` on a helper bot.
pub fn slot_key(guild: &str, slot: usize) -> String {
    if slot == 0 { guild.to_string() } else { format!("{guild}~{slot}") }
}
/// Splits a player's name back into the server and the bot.
pub fn split_key(key: &str) -> (&str, usize) {
    match key.split_once('~') { Some((g, n)) => (g, n.parse().unwrap_or(0)), None => (key, 0) }
}
/// The "~N" in a button id's kind (`mu~2`), as a bot number.
pub fn slot_of_kind(kind: &str) -> usize {
    kind.split_once('~').and_then(|(_, n)| n.parse().ok()).unwrap_or(0)
}

pub struct Music<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub dir: &'a Directory,
    pub players: &'a Players,
    pub guild: &'a str,
    /// Which of the server's music bots this is: 0 is the main bot, 1 and up are helper bots.
    pub slot: usize,
}
impl Music<'_> {
    fn data(&self) -> Data<'_> {
        Data { db: self.db, guild: self.guild, module: MODULE }
    }
    /// What this bot's player is called in memory.
    fn key(&self) -> String {
        slot_key(self.guild, self.slot)
    }
    /// A saved value's name: helper bots keep their own player message.
    fn dk(&self, name: &str) -> String {
        if self.slot == 0 { name.to_string() } else { format!("{name}~{}", self.slot) }
    }
    /// A button's id on this bot's player: `mu:skip`, or `mu~2:skip` on a helper.
    fn mu(&self, what: &str) -> String {
        if self.slot == 0 { format!("mu:{what}") } else { format!("mu~{}:{what}", self.slot) }
    }
    fn music(&self, cmd: MusicCmd) -> Action {
        Action::Music { cmd, slot: self.slot }
    }
    fn volume(&self) -> u8 {
        self.settings.int(self.guild, MODULE, "volume").clamp(0, 100) as u8
    }
    fn filter(&self) -> String {
        self.settings.text(self.guild, MODULE, "filter").filter(|f| matches!(f.as_str(), "bassboost" | "nightcore" | "slowed")).unwrap_or_else(|| "off".into())
    }
    fn smooth(&self) -> bool {
        self.settings.bool(self.guild, MODULE, "smooth")
    }
    pub fn media_on(&self) -> bool {
        self.data().get("mediaLinks").is_some_and(|m| m["on"] == true)
    }
    /// Who may skip or stop: whoever added the song, the DJ role, anyone with Manage Channels, or anyone alone with the bot.
    fn can_control(&self, m: &Member, track: Option<&Track>) -> bool {
        let listeners = self.players.with(&self.key(), |p| p.voice.clone()).map(|v| self.dir.in_voice(self.guild, &v).len()).unwrap_or(0);
        listeners <= 1
            || track.is_some_and(|t| t.by == m.id)
            || self.settings.text(self.guild, MODULE, "djRole").is_some_and(|r| m.roles.contains(&r))
            || m.perms & (MANAGE_CHANNELS | crate::perms::ADMINISTRATOR) != 0
    }

    /// The player card: what's playing, how far in, what's next, and the buttons.
    pub fn card(&self, now_ms: i64) -> Card {
        let vol = self.volume();
        let media = self.media_on();
        self.players.with(&self.key(), |p| {
            let mut c = Card::new(Area::Music);
            match &p.now {
                Some(t) => {
                    let paused = p.paused_at.is_some();
                    let at = ((p.paused_at.unwrap_or(now_ms) - p.started_ms - p.paused_ms).max(0) / 1000).min(t.seconds.unwrap_or(i64::MAX));
                    c = c.title(if paused { "⏸️ Paused" } else if p.loading { "⏳ Getting it ready" } else { "🎵 Now playing" }).line(t.label()).picture(t.art.clone().filter(|a| a.starts_with("https://")));
                    match t.seconds { Some(total) if total > 0 => c = c.line(format!("{} {} / {}", crate::card::bar_text(at, total, 14), clock(at), clock(total))), _ => c = c.line("🔴 live".to_string()) }
                    let mut facts = vec![format!("Added by <@{}>", t.by)];
                    if let Some(site) = &t.site { facts.push(site.clone()); }
                    c = c.line(facts.join(" · "));
                    if let Some(credit) = &t.credit { c = c.line(format!("-# {}", short(credit, 200))); }
                }
                None => c = c.title("🎵 Music").line(if p.queue.is_empty() { "Nothing is playing. Press **Add** or use `/music play` while you're in a voice channel." } else { "Starting…" }),
            }
            if !p.queue.is_empty() {
                let next: Vec<String> = p.queue.iter().take(3).enumerate().map(|(k, t)| format!("{}. {}", k + 1, t.label())).collect();
                let more = if p.queue.len() > 3 { format!("\n…and {} more", p.queue.len() - 3) } else { String::new() };
                c = c.line(format!("**Up next**\n{}{more}", next.join("\n")));
            }
            let repeat = match p.repeat { "one" => "🔂 Repeat one", "all" => "🔁 Repeat all", _ => "Repeat off" };
            c = c.line(format!("-# 🔊 {vol}% · {repeat} · {} in queue", p.queue.len()));
            let playing = p.now.is_some();
            c = c.button_with(self.mu("back"), "Back", ButtonStyle::Plain, Some("⏮️".into()))
                .button_with(self.mu("pause"), if p.paused_at.is_some() { "Play" } else { "Pause" }, ButtonStyle::Primary, Some(if p.paused_at.is_some() { "▶️" } else { "⏸️" }.into()))
                .button_with(self.mu("skip"), "Skip", ButtonStyle::Plain, Some("⏭️".into()))
                .button_with(self.mu("stop"), "Stop", ButtonStyle::Danger, Some("⏹️".into()))
                .button_with(self.mu("add"), "Add", ButtonStyle::Good, Some("➕".into()))
                .button_with(self.mu("down"), "Quieter", ButtonStyle::Plain, Some("🔉".into()))
                .button_with(self.mu("up"), "Louder", ButtonStyle::Plain, Some("🔊".into()))
                .button_with(self.mu("repeat"), "Repeat", ButtonStyle::Plain, Some("🔁".into()))
                .button_with(self.mu("shuffle"), "Shuffle", ButtonStyle::Plain, Some("🔀".into()))
                .button_with(self.mu("queue"), "Queue", ButtonStyle::Plain, Some("📜".into()))
                .button_with(self.mu("lists"), "Playlists", ButtonStyle::Plain, Some("🎶".into()));
            if playing { c = c.button_with(self.mu("lyrics"), "Lyrics", ButtonStyle::Plain, Some("🎤".into())); }
            if !media { c = c.button_with(self.mu("media"), "Media links", ButtonStyle::Plain, Some("🔗".into())); }
            c
        })
    }
    /// The player message, brought up to date.
    fn refresh(&self, now_ms: i64) -> Option<Action> {
        let saved = self.data().get(&self.dk("player"))?;
        Some(Action::Edit { channel: saved["channelId"].as_str()?.to_string(), message: saved["messageId"].as_str()?.to_string(), card: self.card(now_ms) })
    }

    /// Adds a song to the queue, keeping the limits. Gives its place (1 = next).
    fn enqueue(&self, p: &mut Player, mut t: Track) -> Result<usize, String> {
        let max = self.settings.int(self.guild, MODULE, "maxQueue") as usize;
        let per = self.settings.int(self.guild, MODULE, "maxPerMember") as usize;
        if p.queue.len() >= max { return Err(format!("The queue is full ({max} songs). Wait for some to play.")); }
        if p.queue.iter().filter(|q| q.by == t.by).count() >= per { return Err(format!("You already have {per} songs waiting. Let others have a turn.")); }
        if t.uid.is_empty() { t.uid = format!("{:x}", fastrand_u64()); }
        p.queue.push(t);
        Ok(p.queue.len())
    }
    /// If nothing is playing and something is queued, the next song starts.
    fn kick(&self, p: &mut Player, now_ms: i64) -> Option<Action> {
        if p.now.is_some() || p.queue.is_empty() { return None; }
        let voice = p.voice.clone()?;
        let t = p.queue.remove(0);
        p.now = Some(t.clone());
        p.started_ms = now_ms;
        p.paused_at = None;
        p.paused_ms = 0;
        p.idle_since = None;
        p.loading = true;
        Some(self.music(MusicCmd::Play { voice, track: Box::new(t), volume: self.volume(), smooth: self.smooth(), filter: self.filter() }))
    }

    /// `/music play`, the Add form and the playlist picker all end up here: a query to look up.
    fn ask(&self, member: &Member, query: &str) -> Vec<Action> {
        let q = query.trim();
        if q.is_empty() { return private("Type a link, a radio station's name, or a song's name."); }
        let Some(voice) = self.dir.voice_of(self.guild, &member.id) else { return private("Join a voice channel first, then add a song.") };
        if let Some(busy) = self.players.with(&self.key(), |p| p.voice.clone()).filter(|v| *v != voice && self.players.with(&self.key(), |p| p.now.is_some())) {
            return private(format!("I'm already playing in <#{busy}>. Join that channel to add songs."));
        }
        let lower = q.to_lowercase();
        let station = stations(&self.settings.list(self.guild, MODULE, "stations")).into_iter().find(|(n, _)| n.to_lowercase() == lower);
        if !audio_file_link(q) && station.is_none() && !self.media_on() {
            return private("Searching and links from YouTube, SoundCloud and similar sites are off in this server (those sites' terms forbid it). The bot's owner can turn them on with the 🔗 Media links button on the player. Links straight to an audio file, and the server's radio stations, always work.");
        }
        self.players.with(&self.key(), |p| { if p.voice.is_none() || p.now.is_none() { p.voice = Some(voice.clone()); } });
        if let Some((name, url)) = station {
            return self.found(&member.id, Ok(vec![Track { title: name, source: "radio".into(), url: Some(url), ..Default::default() }]), 0);
        }
        if audio_file_link(q) {
            let name = q.split(['?', '#']).next().unwrap_or(q).rsplit('/').next().unwrap_or("Song");
            let title = name.rsplit_once('.').map(|(a, _)| a).unwrap_or(name).replace("%20", " ");
            let site = q.split("//").nth(1).and_then(|r| r.split('/').next()).map(str::to_string);
            return self.found(&member.id, Ok(vec![Track { title: short(&title, 120), source: "link".into(), url: Some(q.to_string()), site, ..Default::default() }]), 0);
        }
        let mut out = private(format!("🔎 Looking up **{}**…", short(q, 100)));
        out.push(self.music(MusicCmd::Resolve { query: q.to_string(), by: member.id.clone(), voice }));
        out
    }

    /// What a lookup found (or why it found nothing). The first action is for the person who asked.
    pub fn found(&self, by: &str, result: Result<Vec<Track>, String>, now_ms: i64) -> Vec<Action> {
        let tracks = match result { Ok(t) if !t.is_empty() => t, Ok(_) => return private("Nothing was found for that."), Err(why) => return private(why) };
        let front = self.data().get(&self.dk("playnext")).is_some_and(|v| v.as_str() == Some(by));
        if front { self.data().delete(&self.dk("playnext")); }
        let (said, start) = self.players.with(&self.key(), |p| {
            let (mut added, mut full, mut first) = (0, None, None);
            for mut t in tracks.into_iter() {
                t.by = by.to_string();
                match self.enqueue(p, t.clone()) { Ok(place) => { added += 1; first.get_or_insert((t, place)); } Err(why) => { full = Some(why); break; } }
            }
            if front && added > 0 && p.queue.len() >= added {
                // "play next": the new songs go to the front, in the order they were asked for
                let at = p.queue.len() - added;
                let moved: Vec<Track> = p.queue.drain(at..).collect();
                for (k, t) in moved.into_iter().enumerate() { p.queue.insert(k, t); }
            }
            let start = self.kick(p, now_ms);
            let said = match (added, first) {
                (0, _) => full.unwrap_or_else(|| "Nothing was added.".into()),
                (1, Some((t, place))) => if start.is_some() { format!("▶️ Playing {}", t.label()) } else { format!("➕ Added {} · #{place} in the queue", t.label()) },
                (n, _) => format!("➕ Added **{n}** songs{}", full.map(|f| format!(". {f}")).unwrap_or_default()),
            };
            (said, start)
        });
        let mut out = private(said);
        out.extend(start);
        out.extend(self.refresh(now_ms));
        out
    }

    pub fn command(&self, ev: &CommandEvent) -> Vec<Action> {
        let arg = |k: &str| ev.args.get(k).map(String::as_str).unwrap_or("");
        match ev.sub.as_deref().unwrap_or("player") {
            "player" => {
                if !crate::perms::allowed(self.db, self.guild, &ev.member, crate::perms::Perm { key: "music.player", level: crate::perms::Level::Moderator(None) }) {
                    return private("You don't have permission for that (`music.player`).");
                }
                let mut out = private(format!("The music player is posted in <#{}>.", ev.place.channel));
                if let Some(old) = self.data().get(&self.dk("player")) {
                    if let (Some(c), Some(m)) = (old["channelId"].as_str(), old["messageId"].as_str()) { out.push(Action::Delete { channel: c.into(), message: m.into() }); }
                }
                out.push(Action::Post { channel: ev.place.channel.clone(), card: self.card(ev.at_ms), note: "music-player".into(), ping: Vec::new(), roles: Vec::new() });
                self.data().set(&self.dk("player-pending"), &json!(ev.place.channel));
                out
            }
            "play" => self.ask(&ev.member, arg("song")),
            "playnext" => {
                self.data().set(&self.dk("playnext"), &json!(ev.member.id));
                self.ask(&ev.member, arg("song"))
            }
            "pause" | "resume" => self.pause_set(&ev.member, ev.sub.as_deref() == Some("pause"), ev.at_ms),
            "now" => vec![Action::Reply { card: { let mut c = self.card(ev.at_ms); c.private = true; c } }],
            "remove" => self.remove(&ev.member, arg("position").parse().unwrap_or(0), ev.at_ms),
            "clear" => self.clear(&ev.member, ev.at_ms),
            "repeat" if !arg("mode").is_empty() => self.set_repeat(arg("mode"), ev.at_ms),
            "skipto" => self.skip_to(&ev.member, arg("position").parse().unwrap_or(0), ev.at_ms),
            "seek" | "forward" | "rewind" => self.seek(&ev.member, ev.sub.as_deref().unwrap_or("seek"), arg("time"), arg("seconds"), ev.at_ms),
            "voice join" => self.move_to(&ev.member, None, ev.at_ms, true),
            "voice move" => self.move_to(&ev.member, Some(arg("channel")).filter(|c| !c.is_empty()), ev.at_ms, false),
            "voice stay" => self.stay(&ev.member, matches!(arg("on").to_lowercase().as_str(), "yes" | "y" | "true" | "on" | "1"), ev.at_ms),
            "grab" => self.grab(&ev.member),
            "voteskip" => self.press(&ev.member, "skip", ev.at_ms, false),
            "favorite add" => self.favorite_add(&ev.member),
            "favorite list" => self.favorite_list(&ev.member),
            "favorite play" => self.favorite_play(&ev.member, arg("number").parse().unwrap_or(0)),
            "favorite remove" => self.favorite_remove(&ev.member, arg("number").parse().unwrap_or(0)),
            "voice bots" => self.bots(),
            "sound volume" => self.set_volume(&ev.member, arg("percent").parse().unwrap_or(70), ev.at_ms),
            "sound filter" => self.set_filter(&ev.member, arg("filter"), ev.at_ms),
            "save" => self.save(&ev.member, arg("name"), ev.at_ms),
            "playlists" => self.pick_playlist(),
            other => self.press(&ev.member, other, ev.at_ms, false),
        }
    }
    pub fn button(&self, ev: &ButtonEvent, rest: &str) -> Vec<Action> {
        if rest == "pl" {
            let Some(id) = ev.values.first() else { return private("Pick a playlist.") };
            return self.play_playlist(&ev.member, id, ev.at_ms);
        }
        self.press(&ev.member, rest, ev.at_ms, true)
    }

    /// The player's buttons (and the commands that do the same).
    fn press(&self, m: &Member, what: &str, now: i64, from_card: bool) -> Vec<Action> {
        let now_track = self.players.with(&self.key(), |p| p.now.clone());
        let update = |out: &mut Vec<Action>| { if !from_card { out.extend(self.refresh(now)); } };
        let answer = |text: String| -> Vec<Action> {
            if from_card { vec![Action::Update { card: self.card(now) }, Action::FollowUp { card: Card::new(Area::Music).line(text).private() }] } else { private(text) }
        };
        match what {
            "add" => vec![Action::Form { id: self.mu("add"), title: "Add music".into(), fields: vec![Field { id: "song".into(), label: ADD_LABEL.into(), long: false, required: true, max: 300, placeholder: Some("e.g. never gonna give you up".into()), ..Default::default() }] }],
            "queue" => {
                let text = self.players.with(&self.key(), |p| {
                    let mut lines = Vec::new();
                    if let Some(t) = &p.now { lines.push(format!("**Now:** {}", t.label())); }
                    lines.extend(p.queue.iter().take(20).enumerate().map(|(k, t)| format!("{}. {} · <@{}>{}", k + 1, t.label(), t.by, t.seconds.map(|s| format!(" · {}", clock(s))).unwrap_or_default())));
                    if p.queue.len() > 20 { lines.push(format!("…and {} more", p.queue.len() - 20)); }
                    if lines.is_empty() { "The queue is empty.".to_string() } else { lines.join("\n") }
                });
                vec![Action::Reply { card: Card::new(Area::Music).title("📜 Queue").line(short(&text, 3800)).private() }]
            }
            "lyrics" => match now_track {
                Some(t) => {
                    let mut out = private(format!("🎤 Finding the words to {}…", t.label()));
                    out.push(self.music(MusicCmd::Lyrics { title: t.title.clone(), artist: t.artist.clone() }));
                    out
                }
                None => private("Nothing is playing."),
            },
            "lists" => self.pick_playlist(),
            "media" => self.media_prompt(m),
            "mediaon" | "mediaoff" => self.media_set(m, what == "mediaon", now),
            "pause" => {
                let Some(t) = now_track else { return private("Nothing is playing.") };
                if !self.can_control(m, Some(&t)) { return private("Only the person who added this song, a DJ, or someone with Manage Channels can do that."); }
                let paused = self.players.with(&self.key(), |p| match p.paused_at.take() { Some(at) => { p.paused_ms += now - at; false } None => { p.paused_at = Some(now); true } });
                let mut out = answer(if paused { "⏸️ Paused.".into() } else { "▶️ Playing again.".into() });
                out.push(self.music(if paused { MusicCmd::Pause } else { MusicCmd::Resume }));
                update(&mut out);
                out
            }
            "skip" => {
                let Some(t) = now_track else { return private("Nothing is playing.") };
                if !self.can_control(m, Some(&t)) {
                    if !self.settings.bool(self.guild, MODULE, "voteSkip") { return private("Only the person who added this song, a DJ, or someone with Manage Channels can skip it."); }
                    if let Some(said) = self.vote(m) { return said; }
                }
                // a skipped song is done with, even when repeating one: it is not played again
                self.players.with(&self.key(), |p| { p.history.push(t.clone()); p.now = None; });
                let mut out = answer(format!("⏭️ Skipped {}.", t.label()));
                out.push(self.music(MusicCmd::Stop));
                out.extend(self.players.with(&self.key(), |p| { p.history.truncate(20); self.kick(p, now) }));
                update(&mut out);
                out
            }
            "back" => {
                let Some(prev) = self.players.with(&self.key(), |p| p.history.pop()) else { return private("There's no song before this one.") };
                if !self.can_control(m, now_track.as_ref()) { return private("Only a DJ, or someone with Manage Channels, can go back."); }
                self.players.with(&self.key(), |p| { if let Some(cur) = p.now.take() { p.queue.insert(0, cur); } p.queue.insert(0, prev.clone()); });
                let mut out = answer(format!("⏮️ Back to {}.", prev.label()));
                if now_track.is_some() { out.push(self.music(MusicCmd::Stop)); }
                out.extend(self.players.with(&self.key(), |p| self.kick(p, now)));
                update(&mut out);
                out
            }
            "stop" => {
                if !self.can_control(m, now_track.as_ref()) { return private("Only a DJ, or someone with Manage Channels, can stop the music for everyone."); }
                self.players.with(&self.key(), |p| { p.queue.clear(); p.now = None; p.paused_at = None; p.idle_since = Some(now); p.loading = false; });
                let mut out = answer("⏹️ Stopped, and the queue is cleared.".into());
                out.push(self.music(MusicCmd::Leave));
                self.players.with(&self.key(), |p| p.voice = None);
                update(&mut out);
                out
            }
            "down" | "up" => {
                let v = self.volume() as i64 + if what == "up" { 10 } else { -10 };
                self.set_volume(m, v, now)
            }
            "repeat" => {
                let r = self.players.with(&self.key(), |p| { p.repeat = next_repeat(p.repeat); p.repeat });
                let mut out = answer(match r { "one" => "🔂 Repeating this song.".into(), "all" => "🔁 Repeating the whole queue.".into(), _ => "Repeat is off.".into() });
                update(&mut out);
                out
            }
            "shuffle" => {
                let n = self.players.with(&self.key(), |p| {
                    for k in (1..p.queue.len()).rev() { let j = (fastrand_u64() % (k as u64 + 1)) as usize; p.queue.swap(k, j); }
                    p.queue.len()
                });
                let mut out = answer(if n < 2 { "There's nothing to shuffle yet.".into() } else { format!("🔀 Shuffled {n} songs.") });
                update(&mut out);
                out
            }
            _ => private("That button is from an older message. Use `/music player` again."),
        }
    }

    /// Whether this member may steer the music (skip, move the bot, seek...).
    fn steer(&self, m: &Member, why: &str) -> Option<Vec<Action>> {
        let now = self.players.with(&self.key(), |p| p.now.clone());
        if self.can_control(m, now.as_ref()) { None } else { Some(private(why)) }
    }
    fn pause_set(&self, m: &Member, pause: bool, now: i64) -> Vec<Action> {
        let Some(t) = self.players.with(&self.key(), |p| p.now.clone()) else { return private("Nothing is playing.") };
        if !self.can_control(m, Some(&t)) { return private("Only the person who added this song, a DJ, or someone with Manage Channels can do that."); }
        let changed = self.players.with(&self.key(), |p| match (p.paused_at, pause) {
            (None, true) => { p.paused_at = Some(now); true }
            (Some(at), false) => { p.paused_ms += now - at; p.paused_at = None; true }
            _ => false,
        });
        if !changed { return private(if pause { "It's already paused." } else { "It's already playing." }); }
        let mut out = private(if pause { "⏸️ Paused." } else { "▶️ Playing again." });
        out.push(self.music(if pause { MusicCmd::Pause } else { MusicCmd::Resume }));
        out.extend(self.refresh(now));
        out
    }
    fn remove(&self, m: &Member, n: usize, now: i64) -> Vec<Action> {
        let gone = self.players.with(&self.key(), |p| if n >= 1 && n <= p.queue.len() { Some(p.queue[n - 1].clone()) } else { None });
        let Some(t) = gone else { return private("There's no song at that place in the queue.") };
        if t.by != m.id && !self.can_control(m, None) { return private("Only the person who added it, a DJ, or someone with Manage Channels can take it out."); }
        self.players.with(&self.key(), |p| { if n >= 1 && n <= p.queue.len() { p.queue.remove(n - 1); } });
        let mut out = private(format!("🗑️ Removed {}.", t.label()));
        out.extend(self.refresh(now));
        out
    }
    fn clear(&self, m: &Member, now: i64) -> Vec<Action> {
        if let Some(no) = self.steer(m, "Only a DJ, or someone with Manage Channels, can clear the queue.") { return no; }
        let n = self.players.with(&self.key(), |p| { let n = p.queue.len(); p.queue.clear(); n });
        let mut out = private(if n == 0 { "The queue is already empty.".to_string() } else { format!("🧹 Cleared {n} song{}.", if n == 1 { "" } else { "s" }) });
        out.extend(self.refresh(now));
        out
    }
    fn set_repeat(&self, mode: &str, now: i64) -> Vec<Action> {
        let r: &'static str = match mode { "one" => "one", "all" => "all", _ => "off" };
        self.players.with(&self.key(), |p| p.repeat = r);
        let mut out = private(match r { "one" => "🔂 Repeating this song.", "all" => "🔁 Repeating the whole queue.", _ => "Repeat is off." });
        out.extend(self.refresh(now));
        out
    }
    fn skip_to(&self, m: &Member, n: usize, now: i64) -> Vec<Action> {
        let len = self.players.with(&self.key(), |p| p.queue.len());
        if n < 1 || n > len { return private("There's no song at that place in the queue."); }
        if let Some(no) = self.steer(m, "Only a DJ, or someone with Manage Channels, can jump around the queue.") { return no; }
        let mut out = Vec::new();
        let cur = self.players.with(&self.key(), |p| {
            for _ in 1..n { let t = p.queue.remove(0); p.history.push(t); }
            p.history.truncate(20);
            let c = p.now.take();
            if let Some(c) = &c { p.history.push(c.clone()); }
            c
        });
        out.extend(private(format!("⏭️ Jumped to #{n}.")));
        if cur.is_some() { out.push(self.music(MusicCmd::Stop)); }
        out.extend(self.players.with(&self.key(), |p| self.kick(p, now)));
        out.extend(self.refresh(now));
        out
    }
    /// "90", "1:30" or "1:02:03" as seconds.
    pub fn parse_time(t: &str) -> Option<u64> {
        let parts: Vec<&str> = t.trim().split(':').collect();
        if parts.is_empty() || parts.len() > 3 { return None; }
        let mut total = 0u64;
        for p in &parts { total = total.checked_mul(60)?.checked_add(p.trim().parse::<u64>().ok()?)?; }
        Some(total)
    }
    fn seek(&self, m: &Member, how: &str, time: &str, secs: &str, now: i64) -> Vec<Action> {
        let Some(t) = self.players.with(&self.key(), |p| p.now.clone()) else { return private("Nothing is playing.") };
        if !self.can_control(m, Some(&t)) { return private("Only the person who added this song, a DJ, or someone with Manage Channels can do that."); }
        if t.source == "radio" || t.seconds.unwrap_or(0) <= 0 { return private("A live stream can't be skipped through."); }
        let at = self.players.with(&self.key(), |p| ((p.paused_at.unwrap_or(now) - p.started_ms - p.paused_ms).max(0) / 1000) as u64);
        let step = secs.trim().parse::<u64>().unwrap_or(10);
        let to = match how {
            "forward" => at + step,
            "rewind" => at.saturating_sub(step),
            _ => match Self::parse_time(time) { Some(s) => s, None => return private("Say a time like `90` or `1:30`.") },
        };
        let total = t.seconds.unwrap_or(0) as u64;
        if to >= total { return private(format!("That's past the end of the song ({}).", clock(total as i64))); }
        self.players.with(&self.key(), |p| { p.started_ms = now - (to as i64) * 1000; p.paused_ms = 0; if p.paused_at.is_some() { p.paused_at = Some(now); } });
        let mut out = private(format!("⏩ {}", clock(to as i64)));
        out.push(self.music(MusicCmd::Seek(to)));
        out.extend(self.refresh(now));
        out
    }
    /// `/music join` and `/music move`: bring the bot to a voice channel, keeping whatever plays.
    fn move_to(&self, m: &Member, channel: Option<&str>, now: i64, join: bool) -> Vec<Action> {
        let dest = match channel.map(str::to_string).or_else(|| self.dir.voice_of(self.guild, &m.id)) {
            Some(d) => d,
            None => return private("Join a voice channel first, or pick one."),
        };
        if !self.dir.channels(self.guild).iter().any(|c| c.id == dest && c.kind == "voice") && !self.dir.channels(self.guild).is_empty() {
            return private("That is not a voice channel.");
        }
        let (here, busy) = self.players.with(&self.key(), |p| (p.voice.clone(), p.now.is_some() || !p.queue.is_empty()));
        if here.as_deref() == Some(dest.as_str()) { return private(format!("I'm already in <#{dest}>.")); }
        if busy && !self.can_control(m, None) { return private("Only a DJ, someone with Manage Channels, or the person who started it can move the bot while music is playing."); }
        self.players.with(&self.key(), |p| { p.voice = Some(dest.clone()); p.idle_since = Some(now); });
        let mut out = private(if join { format!("👋 Joining <#{dest}>.") } else { format!("➡️ Moving to <#{dest}>.") });
        out.push(self.music(if busy || here.is_some() { MusicCmd::Move { voice: dest } } else { MusicCmd::Join { voice: dest } }));
        out.extend(self.refresh(now));
        out
    }
    fn stay(&self, m: &Member, on: bool, now: i64) -> Vec<Action> {
        if !(m.perms & (MANAGE_CHANNELS | crate::perms::ADMINISTRATOR) != 0 || self.settings.text(self.guild, MODULE, "djRole").is_some_and(|r| m.roles.contains(&r))) {
            return private("Only a DJ, or someone with Manage Channels, can change that.");
        }
        let _ = self.settings.set(self.guild, MODULE, "stay", &json!(on));
        if on { self.players.with(&self.key(), |p| p.idle_since = None); } else { self.players.with(&self.key(), |p| p.idle_since = Some(now)); }
        private(if on { "📌 I'll stay in voice, even when nothing is playing." } else { "I'll leave voice after a while with nothing playing." })
    }
    /// A vote to skip. None when the vote carried (the song is skipped); otherwise what to tell the voter.
    fn vote(&self, m: &Member) -> Option<Vec<Action>> {
        let (voice, started) = self.players.with(&self.key(), |p| (p.voice.clone(), p.started_ms));
        let here = voice.map(|v| self.dir.in_voice(self.guild, &v)).unwrap_or_default();
        if !here.contains(&m.id) { return Some(private("Join the voice channel the music is playing in to vote.")); }
        let percent = self.settings.int(self.guild, MODULE, "voteSkipPercent").clamp(10, 100) as usize;
        let needed = (here.len() * percent).div_ceil(100).max(1);
        let votes = self.players.with(&self.key(), |p| {
            if p.votes.0 != started { p.votes = (started, Vec::new()); }
            if !p.votes.1.contains(&m.id) { p.votes.1.push(m.id.clone()); }
            p.votes.1.iter().filter(|v| here.contains(v)).count()
        });
        if votes >= needed { return None; }
        Some(vec![Action::Reply { card: Card::new(Area::Music).line(format!("🗳️ Vote counted: **{votes}** of **{needed}** needed to skip.")).private() }])
    }
    fn favorites(&self, m: &Member) -> Vec<Track> {
        self.data().get(&format!("fav:{}", m.id)).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
    }
    fn favorite_add(&self, m: &Member) -> Vec<Action> {
        let Some(t) = self.players.with(&self.key(), |p| p.now.clone()) else { return private("Nothing is playing.") };
        let mut list = self.favorites(m);
        let same = |a: &Track| a.title == t.title && a.artist == t.artist;
        if list.iter().any(same) { return private("That song is already in your favourites."); }
        if list.len() >= 50 { return private("You can keep up to 50 favourites. Take one off first with `/music unfavorite`."); }
        list.push(Track { by: m.id.clone(), ..t.clone() });
        self.data().set(&format!("fav:{}", m.id), &serde_json::to_value(&list).unwrap_or_default());
        private(format!("⭐ Saved {} to your favourites ({} saved).", t.label(), list.len()))
    }
    fn favorite_list(&self, m: &Member) -> Vec<Action> {
        let list = self.favorites(m);
        if list.is_empty() { return private("You have no favourites yet. Press `/music favorite` while a song plays."); }
        let lines: Vec<String> = list.iter().enumerate().map(|(k, t)| format!("{}. {}", k + 1, t.label())).collect();
        vec![Action::Reply { card: Card::new(Area::Music).title("⭐ Your favourites").line(short(&lines.join("\n"), 3800)).line("-# Queue one with `/music playfavorite`, remove one with `/music unfavorite`.").private() }]
    }
    fn favorite_play(&self, m: &Member, n: usize) -> Vec<Action> {
        let list = self.favorites(m);
        let Some(t) = n.checked_sub(1).and_then(|k| list.get(k)) else { return private("You don't have a favourite with that number. See `/music favorite list`.") };
        let query = t.page.clone().or(t.url.clone()).filter(|u| u.starts_with("http")).unwrap_or_else(|| t.label());
        self.ask(m, &query)
    }
    fn favorite_remove(&self, m: &Member, n: usize) -> Vec<Action> {
        let mut list = self.favorites(m);
        let Some(k) = n.checked_sub(1).filter(|k| *k < list.len()) else { return private("You don't have a favourite with that number. See `/music favorite list`.") };
        let gone = list.remove(k);
        self.data().set(&format!("fav:{}", m.id), &serde_json::to_value(&list).unwrap_or_default());
        private(format!("Removed {} from your favourites.", gone.label()))
    }
    fn grab(&self, m: &Member) -> Vec<Action> {
        let Some(t) = self.players.with(&self.key(), |p| p.now.clone()) else { return private("Nothing is playing.") };
        let mut lines = vec![format!("🎵 {}", t.label())];
        if let Some(u) = t.page.clone().or(t.url.clone()).filter(|u| u.starts_with("http")) { lines.push(u); }
        vec![Action::Dm { user: m.id.clone(), card: Card::new(Area::Music).title("Saved for you").line(lines.join("\n")), or_in: None }, private("📨 Sent you the song.").remove(0)]
    }
    /// The music bots this server can use: the main bot and any helper bots that are in the server.
    fn bots(&self) -> Vec<Action> {
        let present = self.dir.slots(self.guild);
        let mut lines = Vec::new();
        for h in self.dir.helpers() {
            let here = present.contains(&h.slot);
            let busy = self.players.with(&slot_key(self.guild, h.slot), |p| p.voice.clone());
            let state = match (here, busy) { (true, Some(v)) => format!("playing in <#{v}>"), (true, None) => "free".into(), (false, _) => format!("not in this server yet · [add it](https://discord.com/oauth2/authorize?client_id={}&scope=bot&permissions=3146752)", h.id) };
            lines.push(format!("**{}** · {state}", h.name));
        }
        let main = self.players.with(&slot_key(self.guild, 0), |p| p.voice.clone());
        let mut all = vec![format!("**The main bot** · {}", main.map(|v| format!("in <#{v}>")).unwrap_or_else(|| "free".into()))];
        all.extend(lines);
        let extra = if self.dir.helpers().is_empty() { "\n\nWant more music bots playing at the same time in different channels? The bot's owner can add more under **Music bots** in the Good Boy app." } else { "\n\nEach bot plays in its own voice channel. Use `/music play` in the channel you want." };
        vec![Action::Reply { card: Card::new(Area::Music).title("🎶 Music bots").line(format!("{}{extra}", all.join("\n"))).private() }]
    }

    fn set_filter(&self, m: &Member, name: &str, now: i64) -> Vec<Action> {
        if !self.can_control(m, self.players.with(&self.key(), |p| p.now.clone()).as_ref()) { return private("Only a DJ, or someone with Manage Channels, can change the sound while others are listening."); }
        let name = if matches!(name, "bassboost" | "nightcore" | "slowed") { name } else { "off" };
        let _ = self.settings.set(self.guild, MODULE, "filter", &json!(name));
        let label = match name { "bassboost" => "Bass boost", "nightcore" => "Nightcore", "slowed" => "Slowed", _ => "Off" };
        let mut text = format!("🎚️ Sound filter: **{label}**. It starts with the next song.");
        if name != "off" && !self.smooth() { text.push_str(" Songs are only filtered when they are downloaded first, so turn on smooth playback in the music settings. Radio and live streams are never filtered."); }
        else if name != "off" { text.push_str(" Radio and live streams are never filtered."); }
        let mut out = private(text);
        out.extend(self.refresh(now));
        out
    }
    fn set_volume(&self, m: &Member, v: i64, now: i64) -> Vec<Action> {
        if !self.can_control(m, self.players.with(&self.key(), |p| p.now.clone()).as_ref()) { return private("Only a DJ, or someone with Manage Channels, can change the volume while others are listening."); }
        let v = v.clamp(0, 100);
        let _ = self.settings.set(self.guild, MODULE, "volume", &json!(v));
        let mut out = private(format!("🔊 Volume {v}%."));
        out.push(self.music(MusicCmd::Volume(v as u8)));
        out.extend(self.refresh(now));
        out
    }

    // ---- the launcher's view and controls
    /// The player as the launcher shows it: what is playing, how far in, the queue and the switches.
    pub fn view(&self, now: i64) -> Value {
        let track = |t: &Track| json!({ "title": t.title, "artist": t.artist, "seconds": t.seconds, "by": t.by, "source": t.source, "art": t.art.as_deref().and_then(safe_art) });
        let mut v = self.players.with(&self.key(), |p| {
            let gone = p.paused_ms + p.paused_at.map(|at| now - at).unwrap_or(0);
            // the clock starts when the voice layer says the song began
            let position = p.now.as_ref().filter(|_| p.started_ms > 0).map(|_| ((now - p.started_ms - gone) / 1000).max(0));
            json!({ "now": p.now.as_ref().map(track), "paused": p.paused_at.is_some(), "position": position, "repeat": p.repeat, "loading": p.loading, "in_voice": p.voice.is_some(),
                "queue": p.queue.iter().take(100).map(track).collect::<Vec<_>>(), "queue_total": p.queue.len() })
        });
        v["volume"] = json!(self.volume());
        v["filter"] = json!(self.filter());
        v
    }
    /// Does what a player button does, as the bot's owner. The first value is what to tell whoever pressed it,
    /// the rest is for Discord.
    pub fn from_launcher(&self, what: &str, arg: Option<i64>, now: i64) -> Result<(String, Vec<Action>), String> {
        let owner = self.dir.bot_owner().unwrap_or_else(|| "0".into());
        let me = Member { id: owner, name: "The launcher".into(), perms: MANAGE_CHANNELS | crate::perms::ADMINISTRATOR, ..Default::default() };
        let out = match what {
            "pause" | "skip" | "back" | "stop" | "repeat" | "shuffle" => self.press(&me, what, now, false),
            "volume" => self.set_volume(&me, arg.ok_or("Say how loud: 0 to 100.")?, now),
            "filter" => self.set_filter(&me, ["off", "bassboost", "nightcore", "slowed"].get(arg.unwrap_or(0).max(0) as usize).copied().unwrap_or("off"), now),
            "remove" => {
                let n = arg.filter(|n| *n >= 1).ok_or("Say which song to remove.")? as usize;
                let gone = self.players.with(&self.key(), |p| if n <= p.queue.len() { Some(p.queue.remove(n - 1)) } else { None }).ok_or("There is no song at that place in the queue.")?;
                let mut out = private(format!("Removed {} from the queue.", gone.title));
                out.extend(self.refresh(now));
                out
            }
            _ => return Err("That is not something the player can do from here.".into()),
        };
        let mut said = String::new();
        let mut rest = Vec::new();
        for a in out {
            match a {
                Action::Reply { card } if said.is_empty() => { said = card.lines.join(" "); if card.private && rest.is_empty() && said.starts_with("Only ") { return Err(said); } }
                Action::Reply { .. } | Action::Update { .. } | Action::FollowUp { .. } => {}
                other => rest.push(other),
            }
        }
        if said.starts_with("Nothing is playing") || said.starts_with("There's no song") { return Err(said); }
        Ok((if said.is_empty() { "Done.".into() } else { said }, rest))
    }

    fn media_prompt(&self, m: &Member) -> Vec<Action> {
        if self.dir.bot_owner().as_deref() != Some(m.id.as_str()) { return private("Only the bot's owner can turn media links on or off."); }
        let on = self.media_on();
        vec![Action::Reply { card: Card::new(Area::Music).title("🔗 Media links").line("Playing music from YouTube, SoundCloud and similar sites, and searching by name, uses a free program called **yt-dlp**, which Good Boy downloads the first time.")
            .line("⚠️ Those sites' terms of service forbid playing their audio through a bot. Turning this on is your decision, for this server only.")
            .line(format!("Media links are **{}** here.", if on { "on" } else { "off" }))
            .button(self.mu(if on { "mediaoff" } else { "mediaon" }), if on { "Turn them off" } else { "I understand, turn them on" }, if on { ButtonStyle::Danger } else { ButtonStyle::Primary }).private() }]
    }
    fn media_set(&self, m: &Member, on: bool, now: i64) -> Vec<Action> {
        if self.dir.bot_owner().as_deref() != Some(m.id.as_str()) { return private("Only the bot's owner can turn media links on or off."); }
        self.data().set("mediaLinks", &json!({ "on": on, "by": m.id, "at": now }));
        let mut out = vec![Action::Update { card: Card::new(Area::Music).line(if on { "🔗 Media links are **on** in this server. Getting yt-dlp ready…" } else { "🔇 Media links are **off** in this server." }).private() }];
        if on { out.push(self.music(MusicCmd::GetTools)); }
        out.extend(self.refresh(now));
        out
    }

    fn playlists(&self) -> Vec<Value> {
        let mut all: Vec<Value> = self.data().list("pl:").into_iter().map(|(_, v)| v).filter(|p| p["id"].is_string() && p["tracks"].is_array()).collect();
        all.sort_by_key(|p| std::cmp::Reverse(p["updatedAt"].as_i64().unwrap_or(0)));
        all
    }
    fn pick_playlist(&self) -> Vec<Action> {
        let lists = self.playlists();
        if lists.is_empty() { return private("This server has no playlists yet. Queue some songs, then save them with `/music save`."); }
        let options = lists.iter().take(25).map(|p| (short(&format!("{} · {} songs", p["name"].as_str().unwrap_or("Playlist"), p["tracks"].as_array().map_or(0, Vec::len)), 100), p["id"].as_str().unwrap_or("").to_string(), Some("🎶".to_string()))).collect();
        vec![Action::Reply { card: Card::new(Area::Music).title("🎶 Playlists").line("Pick one to add it to the queue.").select(Select { id: self.mu("pl"), placeholder: "Choose a playlist".into(), min: 1, max: 1, options }).private() }]
    }
    fn play_playlist(&self, m: &Member, id: &str, now: i64) -> Vec<Action> {
        let Some(pl) = self.data().get(&format!("pl:{id}")) else { return private("That playlist was deleted.") };
        let Some(voice) = self.dir.voice_of(self.guild, &m.id) else { return private("Join a voice channel first, then pick a playlist.") };
        let tracks: Vec<Track> = pl["tracks"].as_array().cloned().unwrap_or_default().into_iter().filter_map(|t| serde_json::from_value::<Track>(t).ok()).filter(|t| t.source != "media" || self.media_on()).map(|mut t| { t.uid.clear(); t }).collect();
        if tracks.is_empty() { return private("Nothing in that playlist can play here (its songs need media links, which are off)."); }
        self.players.with(&self.key(), |p| { if p.now.is_none() { p.voice = Some(voice); } });
        let mut out = self.found(&m.id, Ok(tracks), now);
        if let Some(Action::Reply { card }) = out.first_mut() { card.lines.insert(0, format!("🎶 **{}**", short(pl["name"].as_str().unwrap_or("Playlist"), 60))); }
        out
    }
    fn save(&self, m: &Member, name: &str, now: i64) -> Vec<Action> {
        let name: String = name.chars().filter(|c| !c.is_control()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ").chars().take(60).collect();
        if name.is_empty() { return private("Give the playlist a name."); }
        let tracks: Vec<Value> = self.players.with(&self.key(), |p| p.now.iter().chain(p.queue.iter()).filter_map(Track::savable).take(MAX_PLAYLIST_SONGS).collect());
        if tracks.is_empty() { return private("The queue is empty, so there's nothing to save."); }
        if self.playlists().len() >= MAX_PLAYLISTS { return private(format!("This server already has {MAX_PLAYLISTS} playlists. Delete one first.")); }
        let id: String = format!("{:x}", fastrand_u64()).chars().take(8).collect();
        let n = tracks.len();
        let tracks: Vec<Value> = tracks.into_iter().map(|mut t| { t["id"] = json!(format!("{:x}", fastrand_u64()).chars().take(8).collect::<String>()); t }).collect();
        self.data().set(&format!("pl:{id}"), &json!({ "id": id, "name": name, "by": m.id, "byName": m.name, "createdAt": now, "updatedAt": now, "tracks": tracks }));
        private(format!("🎶 Saved **{name}** with {n} song{}. Play it any time with `/music playlists`.", if n == 1 { "" } else { "s" }))
    }

    pub fn form(&self, ev: &FormEvent) -> Vec<Action> {
        self.ask(&ev.member, ev.values.get("song").map(String::as_str).unwrap_or(""))
    }

    /// The Discord layer's news about the song playing.
    pub fn heard(&self, what: Heard, now: i64) -> Vec<Action> {
        let autoplay = self.settings.bool(self.guild, MODULE, "autoplay");
        let mut out = Vec::new();
        if what == Heard::Left {
            let had = self.players.with(&self.key(), |p| {
                let had = p.now.is_some() || !p.queue.is_empty();
                if let Some(t) = p.now.take() { p.history.push(t); }
                if p.history.len() > 20 { p.history.remove(0); }
                p.queue.clear();
                p.voice = None;
                p.paused_at = None;
                p.loading = false;
                p.idle_since = None;
                had
            });
            if had {
                if let Some(c) = self.data().get(&self.dk("player")).and_then(|s| s["channelId"].as_str().map(str::to_string)) {
                    out.push(Action::Send { channel: c, card: Card::new(Area::Music).line("👋 I was disconnected from voice, so the queue was cleared."), ping: Vec::new(), roles: Vec::new() });
                }
            }
            out.extend(self.refresh(now));
            return out;
        }
        if let Heard::Moved(ch) = &what {
            self.players.with(&self.key(), |p| p.voice = Some(ch.clone()));
            return self.refresh(now).into_iter().collect();
        }
        let next = self.players.with(&self.key(), |p| {
            let current = p.now.as_ref().map(|t| t.uid.clone());
            match &what {
                Heard::Started(uid) if current.as_deref() == Some(uid.as_str()) => {
                    p.loading = false; p.started_ms = now; p.paused_ms = 0; p.radio_tries = 0;
                    if let Some(t) = &p.now { self.db.seen().note(self.guild, "music", &format!("Now playing: {} (added by {})", short(&t.title, 100), self.db.seen().name_or(self.guild, &t.by))); }
                    None
                }
                Heard::Ended(uid) | Heard::Failed(uid, _) if current.as_deref() == Some(uid.as_str()) => {
                    let done = p.now.take().unwrap();
                    p.loading = false;
                    let failed = matches!(what, Heard::Failed(..));
                    // a radio station never finishes: when its stream drops, pick it up again (a few times) before giving up
                    if done.source == "radio" && p.radio_tries < RADIO_RETRIES {
                        p.radio_tries += 1;
                        let mut again = done.clone();
                        again.uid = format!("{:x}", fastrand_u64());
                        p.queue.insert(0, again);
                        return Some((done, false));
                    }
                    if !failed {
                        match p.repeat { "one" => p.queue.insert(0, done.clone()), "all" => p.queue.push(done.clone()), _ => {} }
                    }
                    p.history.push(done.clone());
                    if p.history.len() > 20 { p.history.remove(0); }
                    // autoplay: the queue ran out, so a song played earlier comes round again (never the one that just ended)
                    if !failed && p.queue.is_empty() && autoplay {
                        let same = |a: &Track, b: &Track| a.title == b.title && a.url == b.url && a.page == b.page;
                        let pool: Vec<Track> = p.history.iter().filter(|h| !same(h, &done)).cloned().collect();
                        if !pool.is_empty() {
                            let mut pick = pool[(fastrand_u64() % pool.len() as u64) as usize].clone();
                            pick.uid = format!("{:x}", fastrand_u64());
                            p.queue.push(pick);
                        }
                    }
                    if p.queue.is_empty() { p.idle_since = Some(now); }
                    Some((done, failed))
                }
                _ => None,
            }
        });
        if let Some((done, true)) = &next {
            if let (Heard::Failed(_, why), Some(saved)) = (&what, self.data().get(&self.dk("player"))) {
                if let Some(c) = saved["channelId"].as_str() { out.push(Action::Send { channel: c.into(), card: Card::new(Area::Music).line(format!("⚠️ Couldn't play {}: {}", done.label(), short(why, 300))), ping: Vec::new(), roles: Vec::new() }); }
            }
        }
        if next.is_some() { out.extend(self.players.with(&self.key(), |p| self.kick(p, now))); }
        out.extend(self.refresh(now));
        out
    }
    /// The player message is up.
    pub fn posted(&self, note: &str, message: &str) {
        if note == "music-player" {
            if let Some(channel) = self.data().get(&self.dk("player-pending")).and_then(|c| c.as_str().map(str::to_string)) {
                self.data().set(&self.dk("player"), &json!({ "channelId": channel, "messageId": message }));
            }
        }
    }
    /// Every few seconds while music plays: the progress bar moves, and an empty voice channel is left after a while.
    pub fn tick(&self, now: i64) -> Vec<Action> {
        let idle = self.settings.int(self.guild, MODULE, "idleMinutes") * 60_000;
        let stay = self.settings.bool(self.guild, MODULE, "stay");
        let (playing, leave) = self.players.with(&self.key(), |p| {
            let leave = !stay && p.now.is_none() && p.voice.is_some() && p.idle_since.is_some_and(|t| now - t >= idle);
            if leave { p.voice = None; p.idle_since = None; }
            (p.now.is_some() && p.paused_at.is_none(), leave)
        });
        let mut out = Vec::new();
        if leave { out.push(self.music(MusicCmd::Leave)); }
        if playing || leave { out.extend(self.refresh(now)); }
        out
    }
    /// Lyrics found (or not), as the card the person who asked will see.
    pub fn lyrics_card(title: &str, found: Result<String, String>) -> Card {
        match found {
            Ok(words) => {
                let text = words.trim();
                let cut = text.chars().count() > 3600;
                Card::new(Area::Music).title(format!("🎤 {}", short(title, 100))).line(short(text, 3600)).line(if cut { "-# The words are longer than Discord shows. Lyrics from LRCLIB." } else { "-# Lyrics from LRCLIB." }).private()
            }
            Err(why) => Card::new(Area::Music).line(format!("🎤 {why}")).private(),
        }
    }
}

/// Cover pictures a song may show: only these picture servers (the same list Good Boy 3 allows).
pub const ART_HOSTS: &[&str] = &["i.ytimg.com", "i1.sndcdn.com", "usercontent.jamendo.com", "i.scdn.co"];
pub fn safe_art(raw: &str) -> Option<String> {
    let rest = raw.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    (ART_HOSTS.contains(&host) && !raw.contains(char::is_whitespace)).then(|| raw.chars().take(500).collect())
}
/// The longest song that can be queued.
pub const MAX_SECONDS: i64 = 3 * 3600;

/// Songs from what yt-dlp says about a link, a playlist or a search (its `-J` output). The song's own page is kept,
/// not the audio's address, because those addresses expire: the audio is fetched again when the song starts.
pub fn tracks_from_ytdlp(j: &Value, most: usize) -> Result<Vec<Track>, String> {
    let text = |v: &Value, keys: &[&str]| keys.iter().find_map(|k| v[*k].as_str().filter(|s| !s.trim().is_empty()).map(str::to_string));
    // YouTube's own lists and searches are named YoutubeTab, YoutubeSearch and so on
    let youtube = |s: &str| s.to_ascii_lowercase().starts_with("youtube");
    let one = |e: &Value, site_of_list: Option<&str>| -> Option<Track> {
        if e.is_null() || e["is_live"] == true || e["live_status"].as_str().is_some_and(|s| s.contains("live") && s != "was_live") { return None; }
        let id = e["id"].as_str();
        let page = text(e, &["webpage_url", "original_url"]).or_else(|| e["url"].as_str().filter(|u| u.starts_with("https://")).map(str::to_string))
            .or_else(|| id.filter(|_| site_of_list.is_some_and(youtube)).map(|id| format!("https://www.youtube.com/watch?v={id}")))?;
        if !page.starts_with("https://") && !page.starts_with("http://") { return None; }
        let seconds = e["duration"].as_f64().map(|d| d.round() as i64).filter(|d| *d > 0);
        if seconds.is_some_and(|s| s > MAX_SECONDS) { return None; }
        let site = text(e, &["extractor_key", "ie_key", "extractor"]).or_else(|| site_of_list.map(str::to_string)).map(|s| s.split(':').next().unwrap_or("").to_string()).map(|s| if youtube(&s) { "Youtube".to_string() } else { s }).filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("generic"));
        let art = e["thumbnail"].as_str().and_then(safe_art)
            .or_else(|| e["thumbnails"].as_array().and_then(|list| { let mut l: Vec<&Value> = list.iter().collect(); l.sort_by_key(|t| std::cmp::Reverse(t["width"].as_i64().unwrap_or(0))); l.into_iter().find_map(|t| t["url"].as_str().and_then(safe_art)) }))
            .or_else(|| id.filter(|_| site.as_deref().is_some_and(youtube)).and_then(|id| safe_art(&format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"))));
        Some(Track {
            title: short(&text(e, &["track", "title"]).unwrap_or_else(|| "Song".into()), 200),
            artist: text(e, &["artist", "uploader", "channel"]).map(|a| short(&a, 100)),
            seconds, source: "media".into(), page: Some(page), site, art, ..Default::default()
        })
    };
    match j["entries"].as_array() {
        Some(list) => {
            let site = text(j, &["extractor_key", "extractor"]).map(|s| s.split(':').next().unwrap_or("").to_string());
            let tracks: Vec<Track> = list.iter().filter_map(|e| one(e, site.as_deref())).take(most).collect();
            if tracks.is_empty() { Err("Nothing that can be played was found for that.".into()) } else { Ok(tracks) }
        }
        None => {
            if j["is_live"] == true { return Err("Live streams can't be played. Add it as a radio station instead.".into()); }
            if j["duration"].as_f64().is_some_and(|d| d as i64 > MAX_SECONDS) { return Err("That's too long (over 3 hours).".into()); }
            one(j, None).map(|t| vec![t]).ok_or_else(|| "That link can't be played.".into())
        }
    }
}
/// yt-dlp's complaint, in plain words.
pub fn ytdlp_refusal(err: &str) -> String {
    let e = err.to_lowercase();
    let why = if e.contains("unsupported url") { "That site isn't supported." }
        else if e.contains("private") || e.contains("unavailable") || e.contains("removed") { "That video is private or was removed." }
        else if e.contains("sign in") || e.contains("age") { "That one needs signing in (age-restricted or members only)." }
        else { "It might be blocked right now; sites change often." };
    format!("Couldn't play that link. {why}")
}

/// A fast, good-enough random number for ids and shuffling.
fn fastrand_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    h.finish()
}
