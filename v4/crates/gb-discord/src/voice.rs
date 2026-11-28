//! Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
//!
//! Music in voice. The music module decides what plays; this joins the voice channel, gets each song ready
//! (downloading it first when the server wants smooth sound), plays it, and tells the music module when a song
//! starts, ends or fails, and when the bot is disconnected.
//!
//! Each server gets its own small worker, so what one server asks for happens in order (skip, then play the
//! next song) and a slow download in one server never holds up another.

use gb_core::music::{Heard, MusicCmd, Track};
use songbird::events::{Event, EventContext, EventHandler, TrackEvent};
use songbird::input::{File as FileInput, HttpRequest, Input};
use songbird::tracks::{PlayMode, TrackHandle};
use songbird::{Config, ConnectionInfo, CoreEvent, Driver};
use std::collections::HashMap;
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, Notify};
use twilight_gateway::MessageSender;
use twilight_model::gateway::payload::outgoing::UpdateVoiceState;
use twilight_model::id::marker::{ChannelMarker, GuildMarker, UserMarker};
use twilight_model::id::Id;

/// The most a downloaded song may weigh.
const MAX_MB: u64 = 150;
const AGENT: &str = "GoodBoy/4 (+Discord bot)";

/// What a server's worker is asked to do.
enum Job {
    Cmd(MusicCmd, u64),
    /// A song is ready to play (or could not be got ready).
    Ready { uid: String, got: Result<Source, String>, turn: u64 },
    /// Discord says the bot is out of voice.
    Gone,
    /// Discord sent a new voice server, or the bot was moved to another channel: connect to what Discord says now.
    Refresh,
    /// Text-to-speech: join, say one message, stop, leave.
    Tts(gb_core::tts::TtsCmd),
    /// A spoken message's audio is ready (or could not be made).
    TtsReady { id: u64, got: Result<PathBuf, String>, volume: f32 },
}
enum Source {
    File(PathBuf),
    Url(String, Vec<(String, String)>),
}

/// What the voice connection is waiting for from Discord, per server.
#[derive(Default)]
struct Call {
    channel: Option<u64>,
    session: Option<String>,
    endpoint: Option<String>,
    token: Option<String>,
    /// The bot asked to leave (so being out of voice is expected, not news).
    leaving: bool,
    /// What the sound is connected with right now: channel, session, voice server, token.
    used: Option<(u64, String, String, String)>,
}

pub struct Voice {
    me: Id<UserMarker>,
    /// Which music bot this is: 0 is the main bot, 1 and up are helper bots.
    slot: usize,
    gateway: Mutex<Option<MessageSender>>,
    workers: Mutex<HashMap<u64, mpsc::UnboundedSender<Job>>>,
    /// Bumped by every play, stop and leave: a song that finishes downloading after something newer was asked for
    /// is not played.
    turns: Mutex<HashMap<u64, u64>>,
    calls: Mutex<HashMap<u64, Call>>,
    changed: Notify,
    heard: mpsc::UnboundedSender<(u64, usize, Heard)>,
    web: reqwest::Client,
    tools: PathBuf,
    cache: PathBuf,
}

impl Voice {
    /// `data` is the bot's data folder: yt-dlp goes in `tools`, downloaded songs in `music-cache` (and are deleted
    /// once played).
    pub fn new(me: Id<UserMarker>, slot: usize, data: &Path, heard: mpsc::UnboundedSender<(u64, usize, Heard)>) -> Arc<Voice> {
        let cache = data.join("music-cache");
        // songs left behind when the bot was closed mid-song
        if let Ok(list) = std::fs::read_dir(&cache).map(|l| l.filter(|_| slot == 0)) {
            for f in list.flatten() {
                if f.file_name().to_string_lossy().starts_with("dl-") { let _ = std::fs::remove_file(f.path()); }
            }
        }
        let web = reqwest::Client::builder().user_agent(AGENT).connect_timeout(Duration::from_secs(15)).build().unwrap_or_default();
        Arc::new(Voice { me, slot, gateway: Mutex::default(), workers: Mutex::default(), turns: Mutex::default(), calls: Mutex::default(), changed: Notify::new(), heard, web, tools: data.join("tools"), cache })
    }
    /// The connection to Discord's gateway changed (the bot connects again with fewer permissions, for example).
    pub fn set_gateway(&self, sender: MessageSender) {
        *self.gateway.lock().unwrap_or_else(|p| p.into_inner()) = Some(sender);
    }

    /// Carries out one of the music module's requests. Looking songs up and finding lyrics are answered
    /// separately (`resolve`, `lyrics`), because their answers go to the person who asked.
    /// Where speech and downloaded songs are kept while they play.
    pub fn cache_dir(&self) -> PathBuf { self.cache.clone() }
    /// Text-to-speech work for a server.
    pub fn tts(self: &Arc<Self>, guild: Id<GuildMarker>, cmd: gb_core::tts::TtsCmd) {
        if matches!(cmd, gb_core::tts::TtsCmd::Leave) { self.calls.lock().unwrap_or_else(|p| p.into_inner()).entry(guild.get()).or_default().leaving = true; }
        self.worker(guild).send(Job::Tts(cmd)).ok();
    }
    pub fn send(self: &Arc<Self>, guild: Id<GuildMarker>, cmd: MusicCmd) {
        let turn = {
            let mut turns = self.turns.lock().unwrap_or_else(|p| p.into_inner());
            let t = turns.entry(guild.get()).or_default();
            if matches!(cmd, MusicCmd::Play { .. } | MusicCmd::Stop | MusicCmd::Leave) { *t += 1; }
            *t
        };
        if matches!(cmd, MusicCmd::Leave) { self.calls.lock().unwrap_or_else(|p| p.into_inner()).entry(guild.get()).or_default().leaving = true; }
        if let MusicCmd::GetTools = cmd {
            let me = self.clone();
            tokio::spawn(async move { if let Err(why) = me.ytdlp().await { eprintln!("{why}"); } });
            return;
        }
        self.worker(guild).send(Job::Cmd(cmd, turn)).ok();
    }
    fn worker(self: &Arc<Self>, guild: Id<GuildMarker>) -> mpsc::UnboundedSender<Job> {
        let mut all = self.workers.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(tx) = all.get(&guild.get()).filter(|tx| !tx.is_closed()) { return tx.clone(); }
        let (tx, rx) = mpsc::unbounded_channel();
        all.insert(guild.get(), tx.clone());
        let me = self.clone();
        let own = tx.clone();
        tokio::spawn(async move { me.work(guild, rx, own).await });
        tx
    }
    fn current_turn(&self, guild: Id<GuildMarker>) -> u64 {
        self.turns.lock().unwrap_or_else(|p| p.into_inner()).get(&guild.get()).copied().unwrap_or(0)
    }
    fn tell(&self, guild: Id<GuildMarker>, what: Heard) {
        self.heard.send((guild.get(), self.slot, what)).ok();
    }

    /// Discord's news about the bot's own voice state.
    pub fn on_my_state(self: &Arc<Self>, guild: Id<GuildMarker>, channel: Option<Id<ChannelMarker>>, session: &str) {
        let expected = {
            let mut calls = self.calls.lock().unwrap_or_else(|p| p.into_inner());
            let c = calls.entry(guild.get()).or_default();
            let was_in = c.channel.is_some();
            c.channel = channel.map(Id::get);
            c.session = Some(session.to_string());
            let expected = c.leaving || !was_in;
            if channel.is_none() { c.leaving = false; c.endpoint = None; c.token = None; }
            expected
        };
        self.changed.notify_waiters();
        if channel.is_none() {
            if let Some(tx) = self.workers.lock().unwrap_or_else(|p| p.into_inner()).get(&guild.get()) { tx.send(Job::Gone).ok(); }
            if !expected { self.tell(guild, Heard::Left); }
        } else if let Some(tx) = self.workers.lock().unwrap_or_else(|p| p.into_inner()).get(&guild.get()) {
            // someone may have dragged the bot to another channel
            tx.send(Job::Refresh).ok();
        }
    }
    /// Discord's news about which voice server to use.
    pub fn on_server(&self, guild: Id<GuildMarker>, endpoint: Option<&str>, token: &str) {
        {
            let mut calls = self.calls.lock().unwrap_or_else(|p| p.into_inner());
            let c = calls.entry(guild.get()).or_default();
            c.endpoint = endpoint.map(|e| e.trim_start_matches("wss://").to_string());
            c.token = Some(token.to_string());
        }
        self.changed.notify_waiters();
        // Discord moved the call to another voice server: the sound has to follow, or it goes silent
        if endpoint.is_some() {
            if let Some(tx) = self.workers.lock().unwrap_or_else(|p| p.into_inner()).get(&guild.get()) { tx.send(Job::Refresh).ok(); }
        }
    }

    /// One server's music, in order.
    async fn work(self: Arc<Self>, guild: Id<GuildMarker>, mut jobs: mpsc::UnboundedReceiver<Job>, own: mpsc::UnboundedSender<Job>) {
        let mut driver: Option<Driver> = None;
        let mut joined: Option<u64> = None;
        let mut playing: Option<TrackHandle> = None;
        let mut volume = 0.7f32;
        let mut leftovers: Vec<PathBuf> = Vec::new();
        let mut speaking: Option<TrackHandle> = None;
        while let Some(job) = jobs.recv().await {
            // downloaded songs that have finished are deleted (a song still open is tried again next time)
            leftovers.retain(|f| std::fs::remove_file(f).is_err() && f.exists());
            match job {
                Job::Cmd(MusicCmd::Play { voice, track, volume: v, smooth, filter }, turn) => {
                    volume = f32::from(v) / 100.0;
                    if let Some(h) = playing.take() { let _ = h.stop(); }
                    if let Err(why) = self.join(guild, &mut driver, &mut joined, &voice).await {
                        self.tell(guild, Heard::Failed(track.uid.clone(), why));
                        continue;
                    }
                    let me = self.clone();
                    let own = own.clone();
                    tokio::spawn(async move {
                        let got = me.prepare(&track, smooth).await;
                        // a downloaded song can be filtered; if that does not work, it plays as it is
                        let got = match (got, crate::dsp::Filter::parse(&filter)) {
                            (Ok(Source::File(f)), fl) if fl != crate::dsp::Filter::Off => Ok(Source::File(me.filtered(f, fl).await)),
                            (other, _) => other,
                        };
                        own.send(Job::Ready { uid: track.uid.clone(), got, turn }).ok();
                    });
                }
                Job::Ready { uid, got, turn } => {
                    if turn != self.current_turn(guild) {
                        if let Ok(Source::File(f)) = got { leftovers.push(f); }
                        continue;
                    }
                    let (Some(d), Ok(source)) = (driver.as_mut(), got.as_ref().map_err(Clone::clone)) else {
                        self.tell(guild, Heard::Failed(uid, got.err().unwrap_or_else(|| "I'm not in a voice channel.".into())));
                        continue;
                    };
                    let input: Input = match source {
                        Source::File(f) => { leftovers.push(f.clone()); FileInput::new(f.clone()).into() }
                        Source::Url(url, headers) => {
                            let mut map = reqwest::header::HeaderMap::new();
                            for (k, v) in headers {
                                if let (Ok(k), Ok(v)) = (reqwest::header::HeaderName::from_bytes(k.as_bytes()), reqwest::header::HeaderValue::from_str(v)) { map.insert(k, v); }
                            }
                            HttpRequest::new_with_headers(self.web.clone(), url.clone(), map).into()
                        }
                    };
                    let h = d.play_only_input(input);
                    let _ = h.set_volume(volume);
                    let report = Report { guild, uid: uid.clone(), voice: self.clone() };
                    let _ = h.add_event(Event::Track(TrackEvent::Playable), Started(report.clone()));
                    let _ = h.add_event(Event::Track(TrackEvent::End), report.clone());
                    let _ = h.add_event(Event::Track(TrackEvent::Error), report);
                    playing = Some(h);
                }
                Job::Cmd(MusicCmd::Move { voice }, _) => {
                    // only a bot that is in voice moves; an idle one just joins the new channel on the next song
                    if driver.is_some() {
                        if let Err(why) = self.join(guild, &mut driver, &mut joined, &voice).await { eprintln!("voice (move): {why}"); }
                    }
                }
                Job::Refresh => {
                    let Some(d) = driver.as_mut() else { continue };
                    let info = {
                        let calls = self.calls.lock().unwrap_or_else(|p| p.into_inner());
                        calls.get(&guild.get()).and_then(|c| match (c.channel, &c.session, &c.endpoint, &c.token) {
                            (Some(ch), Some(s), Some(e), Some(t)) => Some((ch, s.clone(), e.clone(), t.clone())),
                            _ => None,
                        })
                    };
                    let Some(now) = info else { continue };
                    if self.calls.lock().unwrap_or_else(|p| p.into_inner()).get(&guild.get()).and_then(|c| c.used.clone()).as_ref() == Some(&now) { continue; }
                    let nz = |n: u64| NonZeroU64::new(n);
                    let (Some(ch), Some(g), Some(me)) = (nz(now.0), nz(guild.get()), nz(self.me.get())) else { continue };
                    let conn = ConnectionInfo { channel_id: ch.into(), endpoint: now.2.clone(), guild_id: g.into(), session_id: now.1.clone(), token: now.3.clone(), user_id: me.into() };
                    match tokio::time::timeout(Duration::from_secs(15), d.connect(conn)).await {
                        Ok(Ok(())) => {
                            if joined != Some(now.0) { self.tell(guild, Heard::Moved(now.0.to_string())); }
                            joined = Some(now.0);
                            if let Some(c) = self.calls.lock().unwrap_or_else(|p| p.into_inner()).get_mut(&guild.get()) { c.used = Some(now); }
                        }
                        Ok(Err(e)) => eprintln!("voice: could not follow the call to its new server: {e}"),
                        Err(_) => eprintln!("voice: following the call to its new server took too long"),
                    }
                }
                Job::Cmd(MusicCmd::Seek(secs), _) => { if let Some(h) = &playing { let _ = h.seek(Duration::from_secs(secs)); } }
                Job::Cmd(MusicCmd::Join { voice }, _) => {
                    if let Err(why) = self.join(guild, &mut driver, &mut joined, &voice).await { eprintln!("voice (join): {why}"); }
                }
                Job::Cmd(MusicCmd::Pause, _) => { if let Some(h) = &playing { let _ = h.pause(); } }
                Job::Cmd(MusicCmd::Resume, _) => { if let Some(h) = &playing { let _ = h.play(); } }
                Job::Cmd(MusicCmd::Volume(v), _) => {
                    volume = f32::from(v) / 100.0;
                    if let Some(h) = &playing { let _ = h.set_volume(volume); }
                }
                Job::Cmd(MusicCmd::Stop, _) => { if let Some(h) = playing.take() { let _ = h.stop(); } }
                Job::Cmd(MusicCmd::Leave, _) => {
                    if let Some(h) = playing.take() { let _ = h.stop(); }
                    if let Some(mut d) = driver.take() { d.leave(); }
                    joined = None;
                    self.say(&UpdateVoiceState::new(guild, None::<Id<ChannelMarker>>, true, false));
                }
                Job::Tts(gb_core::tts::TtsCmd::Join { voice }) => {
                    if let Err(why) = self.join(guild, &mut driver, &mut joined, &voice).await { eprintln!("voice (tts): {why}"); }
                }
                Job::Tts(gb_core::tts::TtsCmd::Speak { id, voice, text, lang, voice_name, provider, rate, volume, slow }) => {
                    if let Err(why) = self.join(guild, &mut driver, &mut joined, &voice).await {
                        self.tell(guild, Heard::TtsFailed(id, why));
                        continue;
                    }
                    let me = self.clone();
                    let own = own.clone();
                    let cache = self.cache.clone();
                    tokio::spawn(async move {
                        let got = super::speech::synth(&me.web, &cache, &provider, &text, &lang, voice_name.as_deref(), rate, slow).await.map(|r| r.0);
                        own.send(Job::TtsReady { id, got, volume: f32::from(volume) / 100.0 }).ok();
                    });
                }
                Job::TtsReady { id, got, volume } => {
                    let (Some(d), Ok(file)) = (driver.as_mut(), got.as_ref()) else {
                        self.tell(guild, Heard::TtsFailed(id, got.err().unwrap_or_else(|| "I'm not in a voice channel.".into())));
                        continue;
                    };
                    leftovers.push(file.clone());
                    // spoken over any music (the driver mixes them), so music's own player is left alone
                    let h = d.play_input(FileInput::new(file.clone()).into());
                    let _ = h.set_volume(volume);
                    let end = SpeechEnd { guild, id, voice: self.clone() };
                    let _ = h.add_event(Event::Track(TrackEvent::End), end.clone());
                    let _ = h.add_event(Event::Track(TrackEvent::Error), end);
                    speaking = Some(h);
                }
                Job::Tts(gb_core::tts::TtsCmd::Stop) => { if let Some(h) = speaking.take() { let _ = h.stop(); } }
                Job::Tts(gb_core::tts::TtsCmd::Leave) => {
                    if let Some(h) = speaking.take() { let _ = h.stop(); }
                    if let Some(h) = playing.take() { let _ = h.stop(); }
                    if let Some(mut d) = driver.take() { d.leave(); }
                    joined = None;
                    self.say(&UpdateVoiceState::new(guild, None::<Id<ChannelMarker>>, true, false));
                }
                Job::Gone => {
                    // the news can arrive after the bot has already joined again (left when idle, then a song was added)
                    if self.calls.lock().unwrap_or_else(|p| p.into_inner()).get(&guild.get()).is_some_and(|c| c.channel.is_some()) { continue; }
                    if let Some(h) = playing.take() { let _ = h.stop(); }
                    if let Some(mut d) = driver.take() { d.leave(); }
                    joined = None;
                }
                Job::Cmd(_, _) => {} // lookups and tools are handled elsewhere
            }
        }
    }
    fn say(&self, cmd: &UpdateVoiceState) -> bool {
        self.gateway.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|g| g.command(cmd).is_ok())
    }

    /// Joins (or moves to) a voice channel and connects the sound to it.
    async fn join(self: &Arc<Self>, guild: Id<GuildMarker>, driver: &mut Option<Driver>, joined: &mut Option<u64>, voice: &str) -> Result<(), String> {
        const NO: &str = "Discord didn't let me join that voice channel. Check that I can see it and have the Connect and Speak permissions.";
        let want = voice.parse::<Id<ChannelMarker>>().map_err(|_| "That is not a voice channel.".to_string())?;
        if *joined == Some(want.get()) && driver.is_some() { return Ok(()); }
        let moving = driver.is_some();
        {
            let mut calls = self.calls.lock().unwrap_or_else(|p| p.into_inner());
            let c = calls.entry(guild.get()).or_default();
            c.leaving = false;
            // a fresh join waits for a fresh voice server; a move keeps the one it has unless Discord sends another
            if !moving { c.endpoint = None; c.token = None; }
            if c.channel != Some(want.get()) { c.channel = None; }
        }
        if !self.say(&UpdateVoiceState::new(guild, Some(want), true, false)) { return Err("I'm not connected to Discord right now. Try again in a moment.".into()); }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let info = loop {
            let wake = self.changed.notified();
            let ready = {
                let calls = self.calls.lock().unwrap_or_else(|p| p.into_inner());
                calls.get(&guild.get()).and_then(|c| match (c.channel, &c.session, &c.endpoint, &c.token) {
                    (Some(ch), Some(s), Some(e), Some(t)) if ch == want.get() => Some((s.clone(), e.clone(), t.clone())),
                    _ => None,
                })
            };
            if let Some(r) = ready { break r; }
            if tokio::time::timeout_at(deadline, wake).await.is_err() { return Err(NO.into()); }
        };
        if moving && *joined == Some(want.get()) { return Ok(()); }
        let (session_id, endpoint, token) = info;
        let used = (want.get(), session_id.clone(), endpoint.clone(), token.clone());
        let d = driver.get_or_insert_with(|| {
            let mut d = Driver::new(Config::default());
            d.add_global_event(Event::Core(CoreEvent::DriverDisconnect), Lost { guild, voice: self.clone() });
            d
        });
        let nz = |n: u64| NonZeroU64::new(n).ok_or_else(|| NO.to_string());
        let info = ConnectionInfo { channel_id: nz(want.get())?.into(), endpoint, guild_id: nz(guild.get())?.into(), session_id, token, user_id: nz(self.me.get())?.into() };
        match tokio::time::timeout(Duration::from_secs(15), d.connect(info)).await {
            Ok(Ok(())) => {
                *joined = Some(want.get());
                if let Some(c) = self.calls.lock().unwrap_or_else(|p| p.into_inner()).get_mut(&guild.get()) { c.used = Some(used); }
                Ok(())
            }
            Ok(Err(e)) => { eprintln!("voice: {e}"); *driver = None; Err(NO.into()) }
            Err(_) => { *driver = None; Err("Joining the voice channel took too long. Try again.".into()) }
        }
    }

    /// Gets a song ready: a file on disk (smooth) or an address to stream from.
    async fn prepare(&self, t: &Track, smooth: bool) -> Result<Source, String> {
        match t.source.as_str() {
            "radio" => t.url.clone().map(|u| Source::Url(u, Vec::new())).ok_or_else(|| "That station has no link.".into()),
            "link" => {
                let url = t.url.clone().ok_or("That song has no link.")?;
                if smooth { self.download_link(&url).await.map(Source::File) } else { Ok(Source::Url(url, Vec::new())) }
            }
            "media" => {
                let page = t.page.clone().or_else(|| t.url.clone()).or_else(|| t.search.as_ref().map(|s| format!("ytsearch1:{s}"))).ok_or("That song has no link.")?;
                let bin = self.ytdlp().await?;
                if smooth { self.download_media(&bin, &page).await.map(Source::File) } else { self.direct_audio(&bin, &page).await }
            }
            _ => Err("I don't know how to play that kind of song.".into()),
        }
    }
    /// The song with the filter on it (a new file), or the song as it was if it cannot be filtered.
    async fn filtered(&self, file: PathBuf, filter: crate::dsp::Filter) -> PathBuf {
        let out = file.with_extension("filtered.wav");
        let (src, dst) = (file.clone(), out.clone());
        match tokio::task::spawn_blocking(move || crate::dsp::apply_file(&src, &dst, filter)).await {
            Ok(Ok(())) => { let _ = std::fs::remove_file(&file); out }
            Ok(Err(why)) => { eprintln!("music filter: {why}"); let _ = std::fs::remove_file(&out); file }
            Err(_) => { let _ = std::fs::remove_file(&out); file }
        }
    }
    fn new_file(&self) -> Result<PathBuf, String> {
        std::fs::create_dir_all(&self.cache).map_err(|e| format!("the music folder could not be made ({e})"))?;
        Ok(self.cache.join(format!("dl-{}-{:x}", super::now_ms(), fastrand::u32(..))))
    }
    async fn download_link(&self, url: &str) -> Result<PathBuf, String> {
        use tokio::io::AsyncWriteExt as _;
        let ext = url.split(['?', '#']).next().unwrap_or("").rsplit_once('.').map(|(_, e)| e.to_lowercase()).filter(|e| gb_core::music::AUDIO_EXT.contains(&e.as_str())).unwrap_or_else(|| "mp3".into());
        let file = self.new_file()?.with_extension(ext);
        let fetch = async {
            let mut r = self.web.get(url).send().await.map_err(|_| "the link could not be reached".to_string())?;
            if !r.status().is_success() { return Err(format!("the link answered {}", r.status())); }
            if r.content_length().is_some_and(|n| n > MAX_MB << 20) { return Err(format!("the song is over {MAX_MB} MB")); }
            let mut out = tokio::fs::File::create(&file).await.map_err(|e| e.to_string())?;
            let mut got = 0u64;
            while let Some(chunk) = r.chunk().await.map_err(|_| "the download was cut off".to_string())? {
                got += chunk.len() as u64;
                if got > MAX_MB << 20 { return Err(format!("the song is over {MAX_MB} MB")); }
                out.write_all(&chunk).await.map_err(|e| e.to_string())?;
            }
            out.flush().await.map_err(|e| e.to_string())?;
            Ok(())
        };
        match tokio::time::timeout(Duration::from_secs(240), fetch).await {
            Ok(Ok(())) => Ok(file),
            Ok(Err(why)) => { let _ = std::fs::remove_file(&file); Err(why) }
            Err(_) => { let _ = std::fs::remove_file(&file); Err("the download took too long".into()) }
        }
    }

    // ------------------------------------------------------------ yt-dlp
    async fn ytdlp(&self) -> Result<String, String> {
        crate::lookup::find_ytdlp(&self.web, &self.tools).await
    }
    async fn download_media(&self, bin: &str, page: &str) -> Result<PathBuf, String> {
        let base = self.new_file()?;
        let pattern = format!("{}.%(ext)s", base.display());
        let max = format!("{MAX_MB}M");
        let r = run(bin, &["-f", "bestaudio/best", "--no-playlist", "--no-warnings", "--no-progress", "--no-part", "--max-filesize", &max, "-o", &pattern, "--no-simulate", "--print", "after_move:filepath", page], 240).await;
        let cleanup = || {
            if let (Some(dir), Some(stem)) = (base.parent(), base.file_name().map(|n| n.to_string_lossy().into_owned())) {
                for f in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                    if f.file_name().to_string_lossy().starts_with(&stem) { let _ = std::fs::remove_file(f.path()); }
                }
            }
        };
        match r {
            Ok((0, out, _)) => {
                let file = out.lines().map(str::trim).rfind(|l| !l.is_empty()).map(PathBuf::from);
                match file.filter(|f| f.exists() && f.starts_with(&self.cache)) {
                    Some(f) => Ok(f),
                    None => { cleanup(); Err("the download did not work".into()) }
                }
            }
            Ok((_, out, err)) => {
                cleanup();
                let both = format!("{out}{err}");
                Err(if both.contains("File is larger") || both.contains("max-filesize") { format!("the song is over {MAX_MB} MB") } else { gb_core::music::ytdlp_refusal(&err) })
            }
            Err(why) => { cleanup(); Err(why) }
        }
    }
    /// The audio's own address for a page (asked for when the song starts, because these addresses expire).
    async fn direct_audio(&self, bin: &str, page: &str) -> Result<Source, String> {
        let (code, out, err) = run(bin, &["-J", "--no-playlist", "--no-warnings", "-f", "bestaudio/best", page], 45).await?;
        if code != 0 { return Err(gb_core::music::ytdlp_refusal(&err)); }
        let mut j: serde_json::Value = serde_json::from_str(&out).map_err(|_| "Couldn't read that link's details.".to_string())?;
        if let Some(first) = j["entries"].as_array().and_then(|e| e.iter().find(|x| !x.is_null())).cloned() { j = first; }
        let url = j["url"].as_str().filter(|u| u.starts_with("https://") || u.starts_with("http://")).ok_or("That site only gives audio I can't open by its address. Turn on smooth playback in Music settings.")?;
        let headers = j["http_headers"].as_object().map(|h| h.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).filter(|(k, v)| k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && !v.contains(['\r', '\n'])).collect()).unwrap_or_default();
        Ok(Source::Url(url.to_string(), headers))
    }

    /// Looks a song up: a link, a playlist link, or a search by name. Songs come back in the order found.
    pub async fn resolve(&self, query: &str) -> Result<Vec<Track>, String> {
        crate::lookup::resolve(&self.web, &self.tools, query).await
    }

    /// The words to a song, from LRCLIB (free, no key).
    pub async fn lyrics(&self, title: &str, artist: Option<&str>) -> Result<String, String> {
        let none = || "I couldn't find the words to that song.".to_string();
        let words = |v: &serde_json::Value| -> Option<String> {
            if v["instrumental"] == true { return Some("🎻 This one has no words.".into()); }
            v["plainLyrics"].as_str().filter(|s| !s.trim().is_empty()).map(str::to_string)
        };
        // a video's title often carries the artist ("Artist - Song (Official Video)"); tidy that up first
        let clean: String = {
            let t = title.split(['(', '[']).next().unwrap_or(title).trim();
            t.to_string()
        };
        let (artist, track) = match (artist, clean.split_once(" - ")) {
            (_, Some((a, s))) => (Some(a.trim().to_string()), s.trim().to_string()),
            (Some(a), None) => (Some(a.trim_end_matches(" - Topic").to_string()), clean.clone()),
            (None, None) => (None, clean.clone()),
        };
        if let Some(a) = &artist {
            let r = self.web.get("https://lrclib.net/api/get").query(&[("track_name", track.as_str()), ("artist_name", a.as_str())]).timeout(Duration::from_secs(15)).send().await;
            if let Ok(r) = r {
                if r.status().is_success() {
                    if let Some(w) = r.json::<serde_json::Value>().await.ok().as_ref().and_then(words) { return Ok(w); }
                }
            }
        }
        let q = match &artist { Some(a) => format!("{a} {track}"), None => track.clone() };
        let r = self.web.get("https://lrclib.net/api/search").query(&[("q", q.as_str())]).timeout(Duration::from_secs(15)).send().await.map_err(|_| "Lyrics could not be reached right now. Try again in a minute.".to_string())?;
        let list: serde_json::Value = r.json().await.map_err(|_| none())?;
        list.as_array().and_then(|l| l.iter().find_map(words)).ok_or_else(none)
    }
}

/// Runs a program (hidden, never a window) and collects what it printed. Gives (exit code, output, errors).
pub(crate) async fn run(bin: &str, args: &[&str], seconds: u64) -> Result<(i32, String, String), String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args).stdin(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // no console window
    let child = cmd.output();
    match tokio::time::timeout(Duration::from_secs(seconds), child).await {
        Ok(Ok(o)) => Ok((o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())),
        Ok(Err(e)) => Err(format!("yt-dlp could not be started ({e}).")),
        Err(_) => Err("That took too long. Try again in a minute.".into()),
    }
}

/// Tells the music module when a song ends or fails.
#[derive(Clone)]
struct Report {
    guild: Id<GuildMarker>,
    uid: String,
    voice: Arc<Voice>,
}
#[async_trait::async_trait]
impl EventHandler for Report {
    async fn act(&self, ctx: &EventContext<'_>) -> Option<Event> {
        let EventContext::Track(list) = ctx else { return None };
        for (state, _) in list.iter() {
            let what = match &state.playing {
                PlayMode::End | PlayMode::Stop => Heard::Ended(self.uid.clone()),
                PlayMode::Errored(e) => Heard::Failed(self.uid.clone(), plain_error(&e.to_string())),
                _ => continue,
            };
            self.voice.tell(self.guild, what);
        }
        None
    }
}
/// Tells the voice module when a spoken message ends or fails.
#[derive(Clone)]
struct SpeechEnd {
    guild: Id<GuildMarker>,
    id: u64,
    voice: Arc<Voice>,
}
#[async_trait::async_trait]
impl EventHandler for SpeechEnd {
    async fn act(&self, ctx: &EventContext<'_>) -> Option<Event> {
        let EventContext::Track(list) = ctx else { return None };
        for (state, _) in list.iter() {
            let what = match &state.playing {
                PlayMode::End | PlayMode::Stop => Heard::TtsEnded(self.id),
                PlayMode::Errored(e) => Heard::TtsFailed(self.id, plain_error(&e.to_string())),
                _ => continue,
            };
            self.voice.tell(self.guild, what);
        }
        None
    }
}
/// Tells the music module once, when the song actually starts (not again after a pause).
struct Started(Report);
#[async_trait::async_trait]
impl EventHandler for Started {
    async fn act(&self, _: &EventContext<'_>) -> Option<Event> {
        self.0.voice.tell(self.0.guild, Heard::Started(self.0.uid.clone()));
        Some(Event::Cancel)
    }
}
/// The voice connection was lost and could not come back.
struct Lost {
    guild: Id<GuildMarker>,
    voice: Arc<Voice>,
}
#[async_trait::async_trait]
impl EventHandler for Lost {
    async fn act(&self, ctx: &EventContext<'_>) -> Option<Event> {
        if let EventContext::DriverDisconnect(d) = ctx {
            if d.reason.is_some() {
                self.voice.say(&UpdateVoiceState::new(self.guild, None::<Id<ChannelMarker>>, true, false));
            }
        }
        None
    }
}
fn plain_error(e: &str) -> String {
    let e = e.to_lowercase();
    if e.contains("parsing") || e.contains("probe") || e.contains("codec") { "that file isn't audio I can play".into() }
    else if e.contains("input creation") || e.contains("http") || e.contains("connect") { "the song could not be reached".into() }
    else { "the song stopped with an error".into() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use songbird::input::{codecs, LiveInput};

    /// Opens a song file the way a song is played, and decodes its first sound.
    async fn decodes(path: &Path) -> Result<(), String> {
        let input: Input = FileInput::new(PathBuf::from(path)).into();
        let input = input.make_playable_async(codecs::get_codec_registry(), codecs::get_probe()).await.map_err(|e| e.to_string())?;
        let Input::Live(LiveInput::Parsed(mut p), _) = input else { return Err("not parsed".into()) };
        for _ in 0..3 {
            let packet = p.format.next_packet().map_err(|e| e.to_string())?;
            if packet.track_id() != p.track_id { continue; }
            p.decoder.decode(&packet).map_err(|e| e.to_string())?;
            return Ok(());
        }
        Err("no sound found".into())
    }

    #[tokio::test]
    async fn the_kinds_of_song_files_played_can_be_opened() {
        let dir = tempfile_dir();
        // a WAV made here, so this always runs
        let wav = dir.join("tone.wav");
        let (rate, secs) = (48_000u32, 1u32);
        let samples: Vec<i16> = (0..rate * secs).map(|i| ((i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 8000.0) as i16).collect();
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + samples.len() as u32 * 2).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes());
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&(rate * 2).to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&(samples.len() as u32 * 2).to_le_bytes());
        for s in samples { b.extend_from_slice(&s.to_le_bytes()); }
        std::fs::write(&wav, b).unwrap();
        decodes(&wav).await.unwrap();
        // the formats yt-dlp and links usually give, when ffmpeg is here to make them
        for (ext, codec) in [("mp3", "libmp3lame"), ("ogg", "libvorbis"), ("opus", "libopus"), ("webm", "libopus"), ("m4a", "aac"), ("flac", "flac")] {
            let f = dir.join(format!("tone.{ext}"));
            let made = std::process::Command::new("ffmpeg").args(["-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ac", "2", "-ar", "48000", "-c:a", codec]).arg(&f).status();
            if !made.is_ok_and(|s| s.success()) { continue; }
            decodes(&f).await.unwrap_or_else(|e| panic!("{ext}: {e}"));
        }
        let _ = std::fs::remove_dir_all(dir);
    }
    fn tempfile_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("gb-voice-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}
