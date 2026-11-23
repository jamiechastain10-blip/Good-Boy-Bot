//! Good Boy 3's voice module: text-to-speech in voice channels with a queue (messages never overlap), auto-leave,
//! a per-member voice and language, playback controls, a "no mic" channel whose messages are read aloud for people
//! who are in voice but don't want to talk, and a command that tests every step. The queue and the rules live here;
//! the Discord layer makes the speech (Windows' own voices, or Google's) and plays it, and says when each message
//! ended or failed.

use crate::bot::{CommandSpec, Directory, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::store::Data;
use crate::{Action, Area, Card, CommandEvent, Db, Def, Kind, MessageEvent, Settings};
use regex::Regex;
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

pub const MODULE: &str = "voice";
pub const USE: Perm = Perm { key: "voice.use", level: Level::Everyone };
pub const CONTROL: Perm = Perm { key: "voice.control", level: Level::Moderator(None) };
pub const LANGS: &[&str] = &["en", "es", "fr", "de", "it", "pt", "ru", "ja", "ko", "zh-CN", "hi", "ar", "nl", "pl", "tr", "sv", "da", "fi", "cs", "el", "id", "th", "vi", "uk", "ro"];
const LANG_CHOICES: &[(&str, &str)] = &[("en", "en"), ("es", "es"), ("fr", "fr"), ("de", "de"), ("it", "it"), ("pt", "pt"), ("ru", "ru"), ("ja", "ja"), ("ko", "ko"), ("zh-CN", "zh-CN"), ("hi", "hi"), ("ar", "ar"), ("nl", "nl"), ("pl", "pl"), ("tr", "tr"), ("sv", "sv"), ("da", "da"), ("fi", "fi"), ("cs", "cs"), ("el", "el"), ("id", "id"), ("th", "th"), ("vi", "vi"), ("uk", "uk"), ("ro", "ro")];
const MAX_QUEUE: usize = 20;
const MAX_PER_USER: usize = 5;
pub static SETTINGS: &[Def] = &[
    Def { key: "ttsProvider", label: "Speech provider (auto = Windows voices on Windows, Google elsewhere)", kind: Kind::Select(&["auto", "windows", "google"]), default: Fallback::Str("auto") },
    Def { key: "ttsVoice", label: "Default Windows voice name (see /tts voices)", kind: Kind::Text { max_len: 100 }, default: Fallback::Str("") },
    Def { key: "ttsLanguage", label: "Default language (Google provider)", kind: Kind::Select(LANGS), default: Fallback::Str("en") },
    Def { key: "ttsRate", label: "Speaking speed (-10 slow ... 10 fast, Windows)", kind: Kind::Number { min: -10, max: 10 }, default: Fallback::Int(0) },
    Def { key: "ttsVolume", label: "Volume (%)", kind: Kind::Number { min: 10, max: 100 }, default: Fallback::Int(100) },
    Def { key: "ttsSlow", label: "Speak slowly (Google)", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "ttsEcho", label: "Show what is being spoken in chat", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "noMicChannel", label: "No-mic channel: messages typed here are read aloud (empty = off)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "noMicAnnounceName", label: "No-mic: say who wrote each message (\"Alex says ...\")", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "noMicRequireVoice", label: "No-mic: only read members who are in the bot's voice channel", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "noMicSkipPrefixes", label: "No-mic: do not read messages that start like a bot command (separate with spaces)", kind: Kind::Text { max_len: 60 }, default: Fallback::Str("! / . ? $ ; ~ -") },
    Def { key: "maxChars", label: "Max characters per message", kind: Kind::Number { min: 20, max: 1000 }, default: Fallback::Int(300) },
    Def { key: "userCooldownSeconds", label: "Seconds between a member's TTS messages", kind: Kind::Number { min: 0, max: 600 }, default: Fallback::Int(3) },
    Def { key: "autoLeaveMinutes", label: "Leave after N idle minutes", kind: Kind::Number { min: 1, max: 60 }, default: Fallback::Int(5) },
];
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "tts", about: "Text-to-speech in your voice channel", module: MODULE, options: &[], subs: &[
    Sub { name: "say", about: "Speak a message", options: &[Opt { name: "text", about: "What to say", takes: Takes::Text, required: true }] },
    Sub { name: "join", about: "Make me join your voice channel", options: &[] },
    Sub { name: "leave", about: "Make me leave", options: &[] },
    Sub { name: "skip", about: "Skip the current message", options: &[] },
    Sub { name: "stop", about: "Stop and clear the queue", options: &[] },
    Sub { name: "queue", about: "Show what is waiting", options: &[] },
    Sub { name: "voices", about: "List the voices installed on the bot's PC (Windows)", options: &[] },
    Sub { name: "voice", about: "Pick your own voice or language", options: &[
        Opt { name: "language", about: "Language (Google provider)", takes: Takes::Choice(LANG_CHOICES), required: false },
        Opt { name: "name", about: "Windows voice name from /tts voices", takes: Takes::Text, required: false },
    ] },
    Sub { name: "setup", about: "(Staff) Choose the no-mic channel whose messages are read aloud", options: &[Opt { name: "channel", about: "Text channel", takes: Takes::Channel, required: true }] },
    Sub { name: "reading", about: "Choose whether your messages in the no-mic channel are read aloud", options: &[Opt { name: "enabled", about: "On or off", takes: Takes::YesNo, required: true }] },
    Sub { name: "diagnose", about: "Test every step of text-to-speech and show what is wrong", options: &[] },
] }];

/// Text that is safe and pleasant to speak: no links, mentions, markdown or custom-emoji ids (Good Boy 3's cleanForSpeech).
pub fn clean_for_speech(s: &str) -> String {
    static R: OnceLock<[Regex; 3]> = OnceLock::new();
    let r = R.get_or_init(|| [Regex::new(r"(?i)https?://\S+").unwrap(), Regex::new(r"<a?:(\w+):\d+>").unwrap(), Regex::new(r"<[@#&!]+\d+>").unwrap()]);
    let t = r[0].replace_all(s, " link ");
    let t = r[1].replace_all(&t, " $1 ");
    let t = r[2].replace_all(&t, " ");
    let t: String = t.chars().filter(|c| !"*_~`|>".contains(*c)).collect();
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}
/// Looks like a command for another bot ("!play x", "/help")? A prefix followed by a letter or digit; "..." and "!!" are words.
pub fn looks_like_command(text: &str, prefixes: &[&str]) -> bool {
    let t = text.trim();
    prefixes.iter().any(|p| t.starts_with(p) && t[p.len()..].chars().next().is_some_and(char::is_alphanumeric))
}

/// One message waiting to be spoken.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub id: u64,
    pub text: String,
    pub by: String,
    pub lang: String,
    pub voice: Option<String>,
    /// Where it was asked (a problem is shown there) and, for a no-mic message, the message to put a ⚠️ on.
    pub channel: String,
    pub message: Option<String>,
}
#[derive(Default)]
struct State {
    channel: String,
    queue: VecDeque<Item>,
    current: Option<Item>,
    idle_since: i64,
    alone_since: Option<i64>,
}
#[derive(Default)]
struct Memory {
    states: HashMap<String, State>,
    last_say: HashMap<String, i64>,
    next_id: u64,
}
fn memory() -> std::sync::MutexGuard<'static, Memory> {
    static M: OnceLock<Mutex<Memory>> = OnceLock::new();
    M.get_or_init(Mutex::default).lock().unwrap_or_else(|p| p.into_inner())
}

/// What the Discord layer does for text-to-speech.
#[derive(Debug, Clone, PartialEq)]
pub enum TtsCmd {
    /// Join this voice channel.
    Join { voice: String },
    /// Say one message (the voice joins first if it must). The layer tells `Heard::TtsEnded` or `TtsFailed` after.
    Speak { id: u64, voice: String, text: String, lang: String, voice_name: Option<String>, provider: String, rate: i64, volume: u8, slow: bool },
    /// Stop what is being said.
    Stop,
    Leave,
}
fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}

pub struct Tts<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub dir: &'a Directory,
    pub guild: &'a str,
}
impl Tts<'_> {
    fn int(&self, k: &str) -> i64 {
        self.settings.int(self.guild, MODULE, k)
    }
    fn text(&self, k: &str) -> Option<String> {
        self.settings.text(self.guild, MODULE, k).filter(|v| !v.is_empty())
    }
    fn prefs(&self, user: &str) -> serde_json::Value {
        Data { db: self.db, guild: self.guild, module: MODULE }.get(&format!("pref:{user}")).unwrap_or(json!({}))
    }
    fn set_prefs(&self, user: &str, v: &serde_json::Value) {
        Data { db: self.db, guild: self.guild, module: MODULE }.set(&format!("pref:{user}"), v);
    }
    /// The next waiting message goes to the Discord layer.
    fn next(&self, now: i64) -> Vec<Action> {
        let mut m = memory();
        let Some(st) = m.states.get_mut(self.guild) else { return Vec::new() };
        if st.current.is_some() { return Vec::new(); }
        let Some(item) = st.queue.pop_front() else { st.idle_since = now; return Vec::new() };
        let cmd = TtsCmd::Speak {
            id: item.id, voice: st.channel.clone(), text: item.text.clone(), lang: item.lang.clone(), voice_name: item.voice.clone(),
            provider: self.text("ttsProvider").unwrap_or_else(|| "auto".into()), rate: self.int("ttsRate"), volume: self.int("ttsVolume").clamp(10, 100) as u8, slow: self.settings.bool(self.guild, MODULE, "ttsSlow"),
        };
        st.current = Some(item);
        vec![Action::Tts(cmd)]
    }
    /// Puts a message in the queue after the checks. `Err` is what to tell the member.
    fn queue(&self, text: &str, by: &str, channel: &str, message: Option<&str>, in_voice: Option<String>, now: i64) -> Result<(usize, Vec<Action>), String> {
        let item_lang = self.prefs(by);
        let (lang, voice) = (item_lang["lang"].as_str().map(str::to_string).or_else(|| self.text("ttsLanguage")).unwrap_or_else(|| "en".into()), item_lang["voice"].as_str().map(str::to_string).or_else(|| self.text("ttsVoice")));
        {
            let mut m = memory();
            let wait = self.int("userCooldownSeconds") * 1000;
            let key = format!("{}:{by}", self.guild);
            if now - m.last_say.get(&key).copied().unwrap_or(0) < wait { return Err("One moment between TTS messages.".into()); }
            let guild = self.guild.to_string();
            match m.states.get(&guild) {
                Some(st) => {
                    if in_voice.as_deref() != Some(st.channel.as_str()) { return Err(format!("Join <#{}> to use TTS with me.", st.channel)); }
                    if st.queue.len() >= MAX_QUEUE { return Err("The TTS queue is full - try again in a moment.".into()); }
                    if st.queue.iter().filter(|q| q.by == by).count() >= MAX_PER_USER { return Err(format!("You can have {MAX_PER_USER} messages waiting at once.")); }
                }
                None => {
                    let Some(vc) = in_voice else { return Err("Join a voice channel first.".into()) };
                    m.states.insert(guild.clone(), State { channel: vc, idle_since: now, ..Default::default() });
                }
            }
            m.last_say.insert(key, now);
            if m.last_say.len() > 5000 { m.last_say.retain(|_, t| now - *t < 60_000); }
            m.next_id += 1;
            let id = m.next_id;
            let st = m.states.get_mut(&guild).unwrap();
            st.queue.push_back(Item { id, text: text.to_string(), by: by.into(), lang, voice, channel: channel.into(), message: message.map(str::to_string) });
        }
        let waiting = { let m = memory(); m.states.get(self.guild).map(|s| s.queue.len() + usize::from(s.current.is_some())).unwrap_or(0) };
        Ok((waiting, self.next(now)))
    }
    /// A message in the no-mic channel (Good Boy 3's noMicPlan): read aloud while the bot is in voice.
    pub fn on_message(&self, ev: &MessageEvent) -> Vec<Action> {
        if self.text("noMicChannel").as_deref() != Some(ev.place.channel.as_str()) || ev.author.bot { return Vec::new(); }
        let channel = { let m = memory(); match m.states.get(self.guild) { Some(s) => s.channel.clone(), None => return Vec::new() } };
        if self.prefs(&ev.author.id)["noMic"].as_bool() == Some(false) { return Vec::new(); }
        let in_voice = self.dir.voice_of(self.guild, &ev.author.id);
        if self.settings.bool(self.guild, MODULE, "noMicRequireVoice") && in_voice.as_deref() != Some(channel.as_str()) { return Vec::new(); }
        let prefixes = self.text("noMicSkipPrefixes").unwrap_or_default();
        let prefixes: Vec<&str> = prefixes.split_whitespace().collect();
        if looks_like_command(&ev.text, &prefixes) { return Vec::new(); }
        let text: String = clean_for_speech(&ev.text.replace('@', "")).chars().take(self.int("maxChars") as usize).collect();
        if !text.chars().any(char::is_alphanumeric) { return Vec::new(); }
        let who: String = clean_for_speech(&ev.author.name).chars().take(40).collect();
        let spoken = if self.settings.bool(self.guild, MODULE, "noMicAnnounceName") && !who.is_empty() { format!("{who} says {text}") } else { text };
        self.queue(&spoken, &ev.author.id, &ev.place.channel, Some(&ev.id), in_voice, ev.at_ms).map(|r| r.1).unwrap_or_default()
    }
    /// The Discord layer finished a message, or could not say it.
    pub fn heard(&self, id: u64, failed: Option<&str>, now: i64) -> Vec<Action> {
        let item = {
            let mut m = memory();
            let Some(st) = m.states.get_mut(self.guild) else { return Vec::new() };
            if st.current.as_ref().map(|c| c.id) != Some(id) { return Vec::new(); }
            st.idle_since = now;
            st.current.take()
        };
        let mut out = Vec::new();
        if let (Some(why), Some(item)) = (failed, item) {
            match &item.message {
                Some(m) => out.push(Action::React { channel: item.channel.clone(), message: m.clone(), emoji: "⚠️".into() }),
                None => out.push(Action::Send { channel: item.channel.clone(), card: Card::new(Area::General).line(format!("⚠️ <@{}> I couldn't speak that: {}. An admin can run `/tts diagnose`.", item.by, short(why, 280))), ping: Vec::new(), roles: Vec::new() }),
            }
        }
        out.extend(self.next(now));
        out
    }
    /// Leaving voice when idle for a while, or alone in the channel for 30 seconds.
    pub fn tick(&self, now: i64) -> Vec<Action> {
        let humans = { let m = memory(); m.states.get(self.guild).map(|s| s.channel.clone()) }.map(|c| self.dir.in_voice(self.guild, &c).into_iter().filter(|u| Some(u.as_str()) != self.dir.me().as_deref()).count());
        let mut m = memory();
        let Some(st) = m.states.get_mut(self.guild) else { return Vec::new() };
        let alone = humans == Some(0);
        if alone { st.alone_since.get_or_insert(now); } else { st.alone_since = None; }
        let left_alone = st.alone_since.is_some_and(|t| now - t >= 30_000);
        let idle = st.current.is_none() && st.queue.is_empty() && now - st.idle_since >= self.int("autoLeaveMinutes") * 60_000;
        if left_alone || idle { m.states.remove(self.guild); return vec![Action::Tts(TtsCmd::Leave)]; }
        Vec::new()
    }
    /// The bot is no longer in voice (disconnected): the queue is forgotten.
    pub fn left(&self) {
        memory().states.remove(self.guild);
    }
    pub fn guilds() -> Vec<String> {
        memory().states.keys().cloned().collect()
    }

    pub fn command(&self, ev: &CommandEvent) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, USE) { return private(format!("You don't have permission for that (`{}`).", USE.key)); }
        let me = ev.member.id.as_str();
        let arg = |k: &str| ev.args.get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let control = perms::allowed(self.db, self.guild, &ev.member, CONTROL);
        let need_control = || private(format!("You need the `{}` permission for that.", CONTROL.key));
        let in_voice = self.dir.voice_of(self.guild, me);
        let current_state = |f: &dyn Fn(&State) -> String| { let m = memory(); m.states.get(self.guild).map(f) };
        match ev.sub.as_deref().unwrap_or("say") {
            "say" => {
                let text: String = clean_for_speech(&arg("text").unwrap_or_default()).chars().take(self.int("maxChars") as usize).collect();
                if text.is_empty() { return private("There is nothing speakable in that."); }
                match self.queue(&text, me, &ev.place.channel, None, in_voice, ev.at_ms) {
                    Err(no) => private(no),
                    Ok((waiting, mut cmds)) => {
                        let echo = self.settings.bool(self.guild, MODULE, "ttsEcho");
                        let mut card = Card::new(Area::General).line(format!("🔊 <@{me}> queued ({waiting} in line): {}", short(&text, 150)));
                        card.private = !echo;
                        let mut out = vec![Action::Reply { card }];
                        out.append(&mut cmds);
                        out
                    }
                }
            }
            "join" => {
                let Some(vc) = in_voice else { return private("Join a voice channel first.") };
                {
                    let mut m = memory();
                    if let Some(st) = m.states.get(self.guild) { if st.channel != vc { return private(format!("Join <#{}> to use TTS with me.", st.channel)); } }
                    else { m.states.insert(self.guild.to_string(), State { channel: vc.clone(), idle_since: ev.at_ms, ..Default::default() }); }
                }
                let reading = match self.text("noMicChannel") {
                    Some(c) => format!("Anything typed in <#{c}> is now read aloud - no command needed.{}", if self.dir.reads_messages() { "" } else { " ⚠️ But I can't read message text until **Message Content Intent** is on in the Developer Portal." }),
                    None => "Use `/tts say`, or set a no-mic channel with `/tts setup`.".into(),
                };
                let mut out = private(format!("Joined <#{vc}>. {reading}"));
                out.push(Action::Tts(TtsCmd::Join { voice: vc }));
                out
            }
            "queue" => {
                let rows = { let m = memory(); m.states.get(self.guild).map(|s| s.current.iter().map(|c| format!("▶️ <@{}>: {}", c.by, short(&c.text, 60))).chain(s.queue.iter().enumerate().map(|(n, q)| format!("{}. <@{}>: {}", n + 1, q.by, short(&q.text, 60)))).collect::<Vec<_>>()).unwrap_or_default() };
                if rows.is_empty() { return private("The queue is empty."); }
                let mut card = Card::new(Area::General).title("TTS queue").line(rows.join("\n")).private();
                card.accent = Some(0x5865f2);
                vec![Action::Reply { card }]
            }
            "skip" | "stop" | "leave" => {
                let sub = ev.sub.as_deref().unwrap_or("");
                if current_state(&|s| s.channel.clone()).is_none() { return private("I'm not in a voice channel."); }
                if sub == "skip" {
                    let mine = { let m = memory(); m.states.get(self.guild).and_then(|s| s.current.as_ref().map(|c| c.by == me)).unwrap_or(false) };
                    if !control && !mine { return private("Only the person who queued it (or a moderator) can skip."); }
                    let mut out = private("⏭️ Skipped.");
                    out.push(Action::Tts(TtsCmd::Stop));
                    return out;
                }
                if !control { return need_control(); }
                if sub == "stop" {
                    if let Some(st) = memory().states.get_mut(self.guild) { st.queue.clear(); }
                    let mut out = private("⏹️ Cleared the queue.");
                    out.push(Action::Tts(TtsCmd::Stop));
                    return out;
                }
                memory().states.remove(self.guild);
                let mut out = private("👋 Left the voice channel.");
                out.push(Action::Tts(TtsCmd::Leave));
                out
            }
            "voices" => vec![Action::TtsInfo { diagnose: false, provider: self.text("ttsProvider").unwrap_or_else(|| "auto".into()), voice: self.text("ttsVoice"), lang: self.text("ttsLanguage").unwrap_or_else(|| "en".into()) }],
            "diagnose" => {
                if !control { return need_control(); }
                vec![Action::TtsInfo { diagnose: true, provider: self.text("ttsProvider").unwrap_or_else(|| "auto".into()), voice: self.text("ttsVoice"), lang: self.text("ttsLanguage").unwrap_or_else(|| "en".into()) }]
            }
            "voice" => {
                let (lang, name) = (arg("language"), arg("name"));
                if lang.is_none() && name.is_none() { return private("Choose a language or a voice name."); }
                let mut pref = self.prefs(me);
                if let Some(l) = &lang { pref["lang"] = json!(l); }
                if let Some(n) = &name { pref["voice"] = json!(short(n, 100)); }
                self.set_prefs(me, &pref);
                private(format!("Saved. Your TTS: {} {}", pref["voice"].as_str().map(|v| format!("voice **{v}**")).unwrap_or_default(), pref["lang"].as_str().map(|l| format!("language **{l}**")).unwrap_or_default()).trim())
            }
            "reading" => {
                let on = matches!(arg("enabled").as_deref(), Some("true" | "yes" | "on"));
                let mut pref = self.prefs(me);
                pref["noMic"] = json!(on);
                self.set_prefs(me, &pref);
                private(if on { "Your messages in the no-mic channel will be read aloud." } else { "Your messages will no longer be read aloud." })
            }
            "setup" => {
                if !control { return need_control(); }
                let Some(ch) = arg("channel") else { return private("Pick a text channel.") };
                let _ = self.settings.set(self.guild, MODULE, "noMicChannel", &json!(ch));
                let note = if self.dir.reads_messages() { "" } else { "\n⚠️ I can't read message text yet: turn on **Message Content Intent** in the Developer Portal (Bot > Privileged Gateway Intents) and restart me." };
                private(format!("Messages typed in <#{ch}> will be read aloud while I'm in a voice channel. Use `/tts join` from a voice channel to start.{note}"))
            }
            _ => private("Unknown option."),
        }
    }
}
