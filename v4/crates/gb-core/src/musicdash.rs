//! The launcher's Music page speaks the same views and actions as Good Boy 3's dashboard, so the page that
//! members and staff already know (a library on the left, the player bar along the bottom) works unchanged.
//! This is a child of `music`: it uses the player's own rules and sends the voice layer the same commands.
use super::*;
use std::sync::OnceLock;

/// Songs found by a search, kept for a while so "add" and "save" can name them by a short token.
fn tokens() -> &'static Mutex<Vec<(String, Track)>> {
    static T: OnceLock<Mutex<Vec<(String, Track)>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(Vec::new()))
}
fn remember(t: &Track) -> String {
    let id = format!("{:x}", fastrand_u64());
    let mut all = tokens().lock().unwrap_or_else(|p| p.into_inner());
    all.push((id.clone(), t.clone()));
    if all.len() > 500 { all.remove(0); }
    id
}
fn recall(id: &str) -> Option<Track> {
    tokens().lock().unwrap_or_else(|p| p.into_inner()).iter().find(|(k, _)| k == id).map(|(_, t)| t.clone())
}
fn short_id() -> String {
    format!("{:x}", fastrand_u64()).chars().take(8).collect()
}
fn total_seconds(tracks: &[Track]) -> i64 {
    tracks.iter().filter_map(|t| t.seconds).filter(|s| *s > 0).sum()
}
fn can_seek(t: &Track) -> bool {
    t.source != "radio" && t.seconds.unwrap_or(0) > 0
}
type Done = Result<(Value, Vec<Action>), String>;

impl Music<'_> {
    /// A song as the page shows it: no file names, no stream addresses.
    fn public(&self, t: &Track) -> Value {
        json!({ "uid": if t.uid.is_empty() { Value::Null } else { json!(t.uid) }, "title": t.title, "artist": t.artist, "seconds": t.seconds.filter(|s| *s > 0), "source": t.source, "site": t.site, "credit": t.credit,
            "page": t.page.as_deref().filter(|p| p.starts_with("https://")), "art": t.art.as_deref().and_then(safe_art), "by": if t.by.is_empty() { Value::Null } else { json!(t.by) }, "byName": Value::Null, "canSave": t.savable().is_some() })
    }
    fn saved_playlist(&self, id: &str) -> Result<Value, String> {
        self.data().get(&format!("pl:{id}")).filter(|p| p["tracks"].is_array()).ok_or_else(|| "That playlist was deleted.".to_string())
    }
    fn playlist_tracks(pl: &Value) -> Vec<Track> {
        pl["tracks"].as_array().cloned().unwrap_or_default().into_iter().filter_map(|t| serde_json::from_value::<Track>(t).ok()).collect()
    }
    fn playlist_summary(&self, pl: &Value) -> Value {
        let tracks = Self::playlist_tracks(pl);
        let mut art: Vec<String> = Vec::new();
        for a in tracks.iter().filter_map(|t| t.art.as_deref().and_then(safe_art)) {
            if !art.contains(&a) { art.push(a); }
            if art.len() == 4 { break; }
        }
        json!({ "id": pl["id"], "name": pl["name"], "count": tracks.len(), "seconds": total_seconds(&tracks), "art": art, "byName": pl["byName"], "updatedAt": pl["updatedAt"] })
    }
    fn playlist_full(&self, pl: &Value) -> Value {
        let mut v = self.playlist_summary(pl);
        let tracks: Vec<Value> = pl["tracks"].as_array().cloned().unwrap_or_default().into_iter().map(|raw| {
            let id = raw["id"].clone();
            let mut j = serde_json::from_value::<Track>(raw).map(|t| self.public(&t)).unwrap_or(Value::Null);
            j["id"] = id;
            j["by"] = Value::Null;
            j
        }).collect();
        v["tracks"] = json!(tracks);
        v
    }
    fn store(&self, pl: &mut Value, now: i64) {
        pl["updatedAt"] = json!(now);
        let id = pl["id"].as_str().unwrap_or("").to_string();
        self.data().set(&format!("pl:{id}"), pl);
    }
    /// Adds songs to a playlist, as many as fit. Uploads cannot be kept. Gives (added, skipped).
    fn fill(pl: &mut Value, tracks: &[Track]) -> Result<(usize, usize), String> {
        let keep: Vec<Value> = tracks.iter().filter_map(Track::savable).collect();
        let have = pl["tracks"].as_array().map_or(0, Vec::len);
        let room = MAX_PLAYLIST_SONGS.saturating_sub(have);
        if room == 0 && !keep.is_empty() { return Err(format!("A playlist holds up to {MAX_PLAYLIST_SONGS} songs.")); }
        let ok: Vec<Value> = keep.into_iter().take(room).map(|mut t| { t["id"] = json!(short_id()); t }).collect();
        let added = ok.len();
        if let Some(list) = pl["tracks"].as_array_mut() { list.extend(ok); }
        Ok((added, tracks.len() - added))
    }
    fn clean_name(raw: &Value) -> Result<String, String> {
        let name: String = raw.as_str().unwrap_or("").chars().filter(|c| !c.is_control()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ").chars().take(60).collect();
        if name.is_empty() { Err("Give the playlist a name.".into()) } else { Ok(name) }
    }

    /// What the player looks like right now (the page's `snapshot`).
    pub fn dash_state(&self, now: i64) -> Value {
        let volume = self.volume();
        let voice = self.players.with(&self.key(), |p| p.voice.clone());
        let (view, repeat) = self.players.with(&self.key(), |p| {
            let gone = p.paused_ms + p.paused_at.map(|at| now - at).unwrap_or(0);
            let elapsed = p.now.as_ref().filter(|_| p.started_ms > 0 && !p.loading).map(|_| ((now - p.started_ms - gone) as f64 / 1000.0).max(0.0)).unwrap_or(0.0);
            (json!({ "paused": p.paused_at.is_some(), "preparing": p.loading, "elapsed": (elapsed * 10.0).round() / 10.0,
                "current": p.now.as_ref().map(|t| self.public(t)), "canSeek": p.now.as_ref().is_some_and(can_seek),
                "hasBack": p.now.as_ref().is_some_and(|t| can_seek(t) || !p.history.is_empty()),
                "queue": p.queue.iter().take(100).map(|t| self.public(t)).collect::<Vec<_>>(), "queueLength": p.queue.len(), "totalSeconds": total_seconds(&p.queue) }), p.repeat)
        });
        let Some(voice) = voice else { return json!({ "connected": false, "volume": volume, "repeat": "off", "queue": [], "queueLength": 0, "at": now }) };
        let name = self.dir.channels(self.guild).into_iter().find(|c| c.id == voice).map(|c| c.name);
        let me = self.dir.me();
        let listeners = self.dir.in_voice(self.guild, &voice).into_iter().filter(|u| Some(u) != me.as_ref()).count();
        let mut v = view;
        // who added each song, by name (never by number): the roster knows them
        let ids: Vec<String> = std::iter::once(&v["current"]).chain(v["queue"].as_array().into_iter().flatten()).filter_map(|t| t["by"].as_str().map(str::to_string)).collect();
        if !ids.is_empty() {
            let names = self.db.get().roster_names(self.guild, &ids).unwrap_or_default();
            let fill = |t: &mut Value| { if let Some(n) = t["by"].as_str().and_then(|b| names.get(b)) { t["byName"] = json!(n); } };
            fill(&mut v["current"]);
            if let Some(q) = v["queue"].as_array_mut() { q.iter_mut().for_each(fill); }
        }
        v["connected"] = json!(true);
        v["channelId"] = json!(voice);
        v["channelName"] = json!(name);
        v["listeners"] = json!(listeners);
        v["volume"] = json!(volume);
        v["repeat"] = json!(repeat);
        v["at"] = json!(now);
        v
    }

    pub fn dash_view(&self, name: &str, args: &Value, now: i64) -> Result<Value, String> {
        match name {
            "player" => {
                let me = self.dir.me();
                let voice_channels: Vec<Value> = self.dir.channels(self.guild).into_iter().filter(|c| c.kind == "voice").take(100)
                    .map(|c| json!({ "id": c.id, "name": c.name, "listeners": self.dir.in_voice(self.guild, &c.id).into_iter().filter(|u| Some(u) != me.as_ref()).count(), "canJoin": true })).collect();
                let stations: Vec<Value> = stations(&self.settings.list(self.guild, MODULE, "stations")).into_iter().map(|(n, _)| json!({ "id": n, "name": n })).collect();
                let mut v = self.dash_state(now);
                v["voiceChannels"] = json!(voice_channels);
                // the call the person looking at this page is in right now (they are asked as `me`): playing joins it
                if let Some(mine) = args["me"].as_str().filter(|m| !m.is_empty()).and_then(|m| self.dir.voice_of(self.guild, m)) {
                    v["myChannel"] = json!(mine);
                    v["myChannelName"] = json!(self.dir.channels(self.guild).into_iter().find(|c| c.id == mine).map(|c| c.name));
                }
                v["playlists"] = json!(self.playlists().iter().map(|p| self.playlist_summary(p)).collect::<Vec<_>>());
                v["limits"] = json!({ "maxQueue": self.settings.int(self.guild, MODULE, "maxQueue"), "playlistSongs": MAX_PLAYLIST_SONGS, "playlists": MAX_PLAYLISTS });
                v["sources"] = json!({ "media": self.media_on(), "jamendo": false, "stations": stations });
                Ok(v)
            }
            "playlist" => Ok(self.playlist_full(&self.saved_playlist(args["id"].as_str().unwrap_or(""))?)),
            _ => Err("The launcher does not have that view.".into()),
        }
    }

    /// Songs a request names: search tokens, a song already in the queue, or a link to an audio file.
    fn songs_from(&self, body: &Value) -> Result<Vec<Track>, String> {
        let mut out = Vec::new();
        // one search result sends "token", several send "tokens"
        let single = body["token"].as_str().into_iter();
        for t in body["tokens"].as_array().into_iter().flatten().filter_map(Value::as_str).chain(single) { out.push(recall(t).ok_or("Those search results are too old. Search again.")?); }
        if let Some(uid) = body["uid"].as_str() {
            let t = self.players.with(&self.key(), |p| p.now.iter().chain(p.queue.iter()).find(|t| t.uid == uid).cloned());
            out.push(t.ok_or("That song is no longer in the queue.")?);
        }
        if let Some(link) = body["link"].as_str().map(str::trim).filter(|l| !l.is_empty()) { out.extend(self.lookup(link)?); }
        if out.is_empty() { return Err("Pick at least one song.".into()); }
        Ok(out)
    }
    /// Finds songs for something typed: a station's name or a link to an audio file work from here; sites and searches
    /// need the lookup program, which the voice layer runs.
    fn lookup(&self, q: &str) -> Result<Vec<Track>, String> {
        let q = q.trim();
        let lower = q.to_lowercase();
        if let Some((name, url)) = stations(&self.settings.list(self.guild, MODULE, "stations")).into_iter().find(|(n, _)| n.to_lowercase() == lower) {
            return Ok(vec![Track { title: name, source: "radio".into(), url: Some(url), ..Default::default() }]);
        }
        if audio_file_link(q) {
            let name = q.split(['?', '#']).next().unwrap_or(q).rsplit('/').next().unwrap_or("Song");
            let title = name.rsplit_once('.').map(|(a, _)| a).unwrap_or(name).replace("%20", " ");
            let site = q.split("//").nth(1).and_then(|r| r.split('/').next()).map(str::to_string);
            return Ok(vec![Track { title: short(&title, 120), source: "link".into(), url: Some(q.to_string()), site, ..Default::default() }]);
        }
        Err("Searching music sites and pasting site links is not in the launcher yet. Paste a link to an audio file, type a radio station's name, or use /music play in Discord.".into())
    }
    /// Makes sure the bot has a voice channel to play in: the one it is in, or the one the page chose.
    fn voice_for(&self, body: &Value) -> Result<(String, Vec<Action>), String> {
        let wanted = body["channelId"].as_str().filter(|c| !c.is_empty()).map(str::to_string);
        let busy = self.players.with(&self.key(), |p| p.voice.clone().filter(|_| p.now.is_some()));
        let voice = busy.clone().or(wanted).or_else(|| self.players.with(&self.key(), |p| p.voice.clone())).ok_or("Pick a voice channel first.")?;
        let mut out = Vec::new();
        if busy.is_none() { self.players.with(&self.key(), |p| p.voice = Some(voice.clone())); out.push(self.music(MusicCmd::Join { voice: voice.clone() })); }
        Ok((voice, out))
    }
    /// Puts songs in the queue as the launcher's owner. `where_`: "end", "next" or "now".
    fn queue_songs(&self, tracks: Vec<Track>, where_: &str, now: i64) -> Result<(String, usize, Vec<Action>), String> {
        let by = self.dir.bot_owner().unwrap_or_default();
        let (mut added, mut full) = (0usize, None);
        let mut put = Vec::new();
        let mut actions = Vec::new();
        let media = self.media_on();
        let mut offline = 0;
        let started = self.players.with(&self.key(), |p| {
            for mut t in tracks {
                if t.source == "media" && !media { offline += 1; continue; }
                t.by = by.clone();
                t.uid.clear();
                // the launcher's owner may queue as many as the queue holds
                let max = self.settings.int(self.guild, MODULE, "maxQueue") as usize;
                if p.queue.len() >= max { full = Some(format!("The queue is full ({max} songs).")); break; }
                t.uid = short_id();
                p.queue.push(t.clone());
                put.push(t);
                added += 1;
            }
            if where_ != "end" && !put.is_empty() {
                let at = p.queue.len() - put.len();
                let moved: Vec<Track> = p.queue.drain(at..).collect();
                for (k, t) in moved.into_iter().enumerate() { p.queue.insert(k, t); }
            }
            if where_ == "now" && p.now.is_some() && added > 0 {
                if let Some(cur) = p.now.take() { p.history.push(cur); p.history.truncate(20); }
                return (true, self.kick(p, now));
            }
            (false, self.kick(p, now))
        });
        if started.0 { actions.push(self.music(MusicCmd::Stop)); }
        actions.extend(started.1);
        if added == 0 {
            return Err(full.unwrap_or_else(|| "Those songs are from a music site, and media links are off in this server.".into()));
        }
        let note = [full, (offline > 0).then(|| format!("{offline} song{} from a music site can't play while media links are off.", if offline == 1 { "" } else { "s" }))].into_iter().flatten().collect::<Vec<_>>().join(" ");
        actions.extend(self.refresh(now));
        Ok((note, added, actions))
    }

    /// Whether searching sites by name is allowed here (the bot's owner has turned media links on), and if not, why.
    pub fn dash_site_search_ok(&self, q: &str) -> Result<(), String> {
        let lower = q.to_lowercase();
        let link = lower.starts_with("http://") || lower.starts_with("https://");
        if !link && !self.media_on() { return Err("Searching music sites is off in this server (those sites' terms forbid it). The bot's owner can turn it on with the switch on this page, or the 🔗 Media links button on the /music player in Discord.".into()); }
        Ok(())
    }
    /// What a lookup found, as the search page wants it (each song with a token to add or save it by).
    pub fn dash_results(&self, tracks: &[Track], list_name: Option<&str>, site: Option<&str>) -> Value {
        let results: Vec<Value> = tracks.iter().map(|t| { let mut j = self.public(t); j["token"] = json!(remember(t)); j }).collect();
        let list = list_name.map(|n| json!({ "name": n, "kind": "playlist", "site": site, "count": tracks.len() }));
        let note = if self.media_on() { Value::Null } else { json!("You can save these as a playlist now. They play once the bot's owner turns on media links with /music in Discord.") };
        json!({ "results": results, "list": list, "note": note })
    }
    /// Saves a playlist read from a site, as the launcher's owner.
    pub fn dash_import(&self, name: &str, tracks: &[Track], now: i64) -> Result<Value, String> {
        if self.playlists().len() >= MAX_PLAYLISTS { return Err(format!("This server already has {MAX_PLAYLISTS} playlists. Delete one first.")); }
        let mut pl = json!({ "id": short_id(), "name": Self::clean_name(&json!(name))?, "by": self.dir.bot_owner(), "byName": "The launcher", "createdAt": now, "tracks": [] });
        let (added, skipped) = Self::fill(&mut pl, tracks)?;
        if added == 0 { return Err("Nothing in that list can be kept as a playlist.".into()); }
        self.store(&mut pl, now);
        Ok(json!({ "added": added, "skipped": skipped, "playlist": self.playlist_full(&pl), "note": if self.media_on() { Value::Null } else { json!("These songs play once the bot's owner turns on media links with /music in Discord.") } }))
    }

    pub fn dash_action(&self, name: &str, body: &Value, now: i64) -> Done {
        let state = |extra: Vec<Action>| -> Done { Ok((self.dash_state(now), extra)) };
        match name {
            "join" => {
                let channel = body["channelId"].as_str().filter(|c| !c.is_empty()).ok_or("Pick a voice channel.")?.to_string();
                self.players.with(&self.key(), |p| p.voice = Some(channel.clone()));
                state(vec![self.music(MusicCmd::Join { voice: channel })])
            }
            // the owner's own switch for music sites (the same one as the 🔗 button in Discord), for this server
            "media" => {
                let on = body["on"].as_bool().ok_or("Say whether to turn media links on or off.")?;
                let by = self.dir.bot_owner().unwrap_or_else(|| "launcher".into());
                self.data().set("mediaLinks", &json!({ "on": on, "by": by, "at": now }));
                let mut v = self.dash_state(now);
                v["sources"] = json!({ "media": on });
                Ok((v, Vec::new()))
            }
            "control" => {
                let what = body["do"].as_str().unwrap_or("");
                let paused = self.players.with(&self.key(), |p| p.paused_at.is_some());
                match what {
                    "pause" | "resume" | "toggle" => {
                        if !matches!((what, paused), ("pause", true) | ("resume", false)) {
                            let (_, rest) = self.from_launcher("pause", None, now)?;
                            return state(rest);
                        }
                        state(vec![])
                    }
                    "repeat" if matches!(body["value"].as_str(), Some("off" | "one" | "all")) => {
                        let v = match body["value"].as_str() { Some("one") => "one", Some("all") => "all", _ => "off" };
                        self.players.with(&self.key(), |p| p.repeat = v);
                        state(self.refresh(now).into_iter().collect())
                    }
                    "skip" | "back" | "stop" | "shuffle" | "repeat" => { let (_, rest) = self.from_launcher(what, None, now)?; state(rest) }
                    _ => Err("Unknown control.".into()),
                }
            }
            "filter" => { let n = ["off", "bassboost", "nightcore", "slowed"].iter().position(|f| Some(*f) == body["value"].as_str()).ok_or("That is not one of the filters.")? as i64; let (_, rest) = self.from_launcher("filter", Some(n), now)?; state(rest) }
            "volume" => { let v = body["value"].as_i64().ok_or("Say how loud: 0 to 100.")?; let (_, rest) = self.from_launcher("volume", Some(v), now)?; state(rest) }
            "seek" => {
                let t = self.players.with(&self.key(), |p| p.now.clone()).ok_or("Nothing is playing.")?;
                if !can_seek(&t) { return Err("You can't jump around in this one (radio, or a song whose length isn't known).".into()); }
                let to = body["seconds"].as_f64().unwrap_or(0.0).max(0.0) as u64;
                let to = to.min(t.seconds.unwrap_or(1).max(1) as u64 - 1);
                self.players.with(&self.key(), |p| { p.started_ms = now - (to as i64) * 1000; p.paused_ms = 0; if p.paused_at.is_some() { p.paused_at = Some(now); } });
                Ok((json!({ "ok": true }), vec![self.music(MusicCmd::Seek(to))]))
            }
            "queue" => {
                let uid = body["uid"].as_str().unwrap_or("").to_string();
                let op = body["op"].as_str().unwrap_or("");
                let mut actions = Vec::new();
                let found = self.players.with(&self.key(), |p| p.queue.iter().position(|t| t.uid == uid));
                match op {
                    "clear" => self.players.with(&self.key(), |p| p.queue.clear()),
                    "remove" | "top" | "move" | "play" => {
                        let k = found.ok_or("That song is not in the queue any more.")?;
                        self.players.with(&self.key(), |p| {
                            let t = p.queue.remove(k);
                            match op {
                                "remove" => {}
                                "move" => { let to = (body["to"].as_i64().unwrap_or(0).max(0) as usize).min(p.queue.len()); p.queue.insert(to, t); }
                                _ => p.queue.insert(0, t),
                            }
                        });
                        if op == "play" {
                            let playing = self.players.with(&self.key(), |p| p.now.is_some());
                            if playing {
                                self.players.with(&self.key(), |p| { if let Some(cur) = p.now.take() { p.history.push(cur); p.history.truncate(20); } });
                                actions.push(self.music(MusicCmd::Stop));
                            }
                            actions.extend(self.players.with(&self.key(), |p| self.kick(p, now)));
                        }
                    }
                    _ => return Err("Unknown queue change.".into()),
                }
                actions.extend(self.refresh(now));
                state(actions)
            }
            "search" => {
                let q = body["q"].as_str().unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
                if q.chars().count() < 2 { return Err("Type at least 2 letters.".into()); }
                let lower = q.to_lowercase();
                // a station's name (or part of it), or a link to an audio file, can be found from here
                let mut found: Vec<Track> = stations(&self.settings.list(self.guild, MODULE, "stations")).into_iter().filter(|(n, _)| n.to_lowercase().contains(&lower))
                    .map(|(name, url)| Track { title: name, source: "radio".into(), url: Some(url), ..Default::default() }).collect();
                if audio_file_link(&q) { found = self.lookup(&q)?; }
                if found.is_empty() { return Err(self.lookup(&q).err().unwrap_or_else(|| "Nothing was found.".into())); }
                let results: Vec<Value> = found.iter().map(|t| { let mut j = self.public(t); j["token"] = json!(remember(t)); j }).collect();
                Ok((json!({ "results": results, "list": Value::Null, "note": if self.media_on() { json!("Searching music sites is not in the launcher yet. These are the stations and links it can find.") } else { Value::Null } }), vec![]))
            }
            "add" => {
                let tracks = self.songs_from(body)?;
                let (_, mut actions) = self.voice_for(body)?;
                let where_ = match body["where"].as_str() { Some("next") => "next", Some("now") => "now", _ => "end" };
                let (note, added, more) = self.queue_songs(tracks, where_, now)?;
                actions.extend(more);
                Ok((json!({ "added": added, "skipped": 0, "note": if note.is_empty() { Value::Null } else { json!(note) }, "state": self.dash_state(now) }), actions))
            }
            "playlist" => self.dash_playlist(body, now),
            _ => Err("The launcher does not have that action.".into()),
        }
    }

    fn dash_playlist(&self, body: &Value, now: i64) -> Done {
        let op = body["op"].as_str().unwrap_or("");
        let owner = self.dir.bot_owner();
        let nothing = Vec::new;
        match op {
            "import" => Err("Importing a playlist from a music site is not in the launcher yet. Save one from the queue instead, or use /music play in Discord.".into()),
            "create" => {
                if self.playlists().len() >= MAX_PLAYLISTS { return Err(format!("This server already has {MAX_PLAYLISTS} playlists. Delete one first.")); }
                let mut pl = json!({ "id": short_id(), "name": Self::clean_name(&body["name"])?, "by": owner, "byName": "The launcher", "createdAt": now, "tracks": [] });
                let (mut added, mut skipped) = (0, 0);
                if body["fromQueue"].as_bool() == Some(true) {
                    let all: Vec<Track> = self.players.with(&self.key(), |p| p.now.iter().chain(p.queue.iter()).cloned().collect());
                    if all.is_empty() { return Err("The queue is empty, so there's nothing to save.".into()); }
                    (added, skipped) = Self::fill(&mut pl, &all)?;
                    if added == 0 { return Err("Nothing in the queue can be saved (uploaded songs are deleted once they play).".into()); }
                } else if body["tokens"].is_array() || body["token"].is_string() || body["link"].is_string() || body["uid"].is_string() {
                    (added, skipped) = Self::fill(&mut pl, &self.songs_from(body)?)?;
                }
                self.store(&mut pl, now);
                Ok((json!({ "added": added, "skipped": skipped, "playlist": self.playlist_full(&pl) }), nothing()))
            }
            _ => {
                let id = body["id"].as_str().unwrap_or("");
                let mut pl = self.saved_playlist(id)?;
                match op {
                    "rename" => { pl["name"] = json!(Self::clean_name(&body["name"])?); self.store(&mut pl, now); Ok((json!({ "playlist": self.playlist_full(&pl) }), nothing())) }
                    "delete" => { self.data().delete(&format!("pl:{id}")); Ok((json!({ "deleted": true }), nothing())) }
                    "add" => {
                        let (added, skipped) = Self::fill(&mut pl, &self.songs_from(body)?)?;
                        self.store(&mut pl, now);
                        Ok((json!({ "added": added, "skipped": skipped, "playlist": self.playlist_full(&pl) }), nothing()))
                    }
                    "remove" | "move" => {
                        let tid = body["trackId"].as_str().unwrap_or("");
                        let list = pl["tracks"].as_array_mut().ok_or("That playlist was deleted.")?;
                        let k = list.iter().position(|t| t["id"].as_str() == Some(tid)).ok_or("That song is not on the playlist any more.")?;
                        let t = list.remove(k);
                        if op == "move" { let to = (body["to"].as_i64().unwrap_or(0).max(0) as usize).min(list.len()); list.insert(to, t); }
                        self.store(&mut pl, now);
                        Ok((json!({ "playlist": self.playlist_full(&pl) }), nothing()))
                    }
                    "play" => {
                        let mut tracks = Self::playlist_tracks(&pl);
                        if tracks.is_empty() { return Err("This playlist is empty. Add some songs first.".into()); }
                        if let Some(tid) = body["trackId"].as_str() {
                            let ids: Vec<String> = pl["tracks"].as_array().into_iter().flatten().map(|t| t["id"].as_str().unwrap_or("").to_string()).collect();
                            if let Some(from) = ids.iter().position(|i| i == tid).filter(|f| *f > 0) { tracks.rotate_left(from); }
                        }
                        if body["shuffle"].as_bool() == Some(true) { for k in (1..tracks.len()).rev() { let j = (fastrand_u64() % (k as u64 + 1)) as usize; tracks.swap(k, j); } }
                        let (_, mut actions) = self.voice_for(body)?;
                        let replace = body["replace"].as_bool() != Some(false);
                        if replace { self.players.with(&self.key(), |p| p.queue.clear()); }
                        let (note, added, more) = self.queue_songs(tracks, if replace { "now" } else { "end" }, now)?;
                        actions.extend(more);
                        Ok((json!({ "added": added, "skipped": 0, "note": if note.is_empty() { Value::Null } else { json!(note) }, "state": self.dash_state(now) }), actions))
                    }
                    _ => Err("Unknown playlist change.".into()),
                }
            }
        }
    }
}
