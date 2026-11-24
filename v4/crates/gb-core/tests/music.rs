//! Music: the queue, what the voice layer is asked to do, what happens when it reports back, and reading what
//! yt-dlp says about a link.

use gb_core::music::{safe_art, tracks_from_ytdlp, Heard, MusicCmd};
use gb_core::{Action, Bot, CommandEvent, Member, Place};
use gb_data::Store;
use serde_json::json;

const G: &str = "700000000000000001";
const CH: &str = "800000000000000001";
const VC: &str = "800000000000000099";
const NOW: i64 = 1_800_000_000_000;

fn bot() -> (tempfile::TempDir, Bot) {
    let tmp = tempfile::tempdir().unwrap();
    let bot = Bot::new(Store::create(tmp.path().join("eclipse.db")).unwrap());
    bot.on_server(G, "Ghost Town");
    (tmp, bot)
}
fn member(id: &str) -> Member {
    Member { id: id.into(), name: format!("m{id}"), ..Default::default() }
}
fn play(bot: &Bot, who: &Member, song: &str, at: i64) -> Vec<Action> {
    let ev = CommandEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), name: "music".into(), sub: Some("play".into()), args: [("song".to_string(), song.to_string())].into(), at_ms: at, from_form: true, ..Default::default() };
    bot.on_command(&ev, &|_| None, &mut |lo, _| lo)
}
fn said(a: &Action) -> String {
    let (Action::Reply { card } | Action::Send { card, .. }) = a else { panic!("not a card: {a:?}") };
    card.to_discord().unwrap().to_string()
}
fn played(actions: &[Action]) -> Option<(String, String)> {
    actions.iter().find_map(|a| match a {
        Action::Music { cmd: MusicCmd::Play { voice, track, .. }, .. } => Some((voice.clone(), track.title.clone())),
        _ => None,
    })
}
fn uid_playing(bot: &Bot) -> String {
    bot.players.with(G, |p| p.now.as_ref().map(|t| t.uid.clone())).unwrap()
}

#[test]
fn songs_play_in_order_and_the_player_starts_over_when_disconnected() {
    let (_tmp, bot) = bot();
    let kai = member("1");
    // not in voice: told to join first
    assert!(said(&play(&bot, &kai, "https://example.com/a.mp3", NOW)[0]).contains("Join a voice channel first"));
    // the bot learns where people are from Discord's voice events
    bot.on_voice(G, &kai, Some(VC), true);
    assert_eq!(bot.directory.voice_of(G, "1").as_deref(), Some(VC));

    // a link straight to an audio file plays at once, in Kai's channel
    let out = play(&bot, &kai, "https://example.com/music/Morning%20Song.mp3", NOW);
    assert!(said(&out[0]).contains("Playing"), "{out:?}");
    assert_eq!(played(&out), Some((VC.to_string(), "Morning Song".to_string())));
    // a second song waits its turn
    let out = play(&bot, &kai, "https://example.com/b.ogg", NOW + 1000);
    assert!(said(&out[0]).contains("#1 in the queue"), "{out:?}");
    assert!(played(&out).is_none());

    // the voice layer says the first one ended: the next one is asked for
    let first = uid_playing(&bot);
    let out = bot.on_music(G, 0, Heard::Ended(first.clone()), NOW + 60_000);
    assert_eq!(played(&out).map(|p| p.1), Some("b".to_string()));
    // news about a song that is no longer playing (a skipped one ending late) changes nothing
    assert!(played(&bot.on_music(G, 0, Heard::Ended(first), NOW + 61_000)).is_none());

    // someone disconnects the bot: nothing is playing, the queue is empty, and it is not still "in" the channel
    play(&bot, &kai, "https://example.com/c.ogg", NOW + 62_000);
    bot.on_music(G, 0, Heard::Left, NOW + 63_000);
    bot.players.with(G, |p| {
        assert!(p.now.is_none() && p.queue.is_empty() && p.voice.is_none());
        assert_eq!(p.history.last().map(|t| t.title.as_str()), Some("b"));
    });
    // and music starts again normally afterwards
    assert!(played(&play(&bot, &kai, "https://example.com/d.mp3", NOW + 64_000)).is_some());
}

#[test]
fn sites_and_searches_wait_for_the_bot_owner() {
    let (_tmp, bot) = bot();
    let kai = member("1");
    bot.on_voice(G, &kai, Some(VC), true);
    // media links are off until the bot's owner turns them on, so nothing is looked up
    let out = play(&bot, &kai, "https://www.youtube.com/watch?v=abc", NOW);
    assert!(said(&out[0]).contains("Media links"), "{out:?}");
    assert!(!out.iter().any(|a| matches!(a, Action::Music { .. })));
    // a radio station from the server's list always works
    bot.settings.set(G, "music", "stations", &json!(["Lofi Ghost | https://radio.example.com/live"])).unwrap();
    assert_eq!(played(&play(&bot, &kai, "lofi ghost", NOW)).map(|p| p.1), Some("Lofi Ghost".to_string()));

    // the owner turns media links on: a search is handed to the voice layer to look up
    bot.directory.set_bot_owner(Some("42".into()));
    let owner = member("42");
    let ev = gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: owner, id: "mu:mediaon".into(), at_ms: NOW, ..Default::default() };
    let out = bot.on_button(&ev, &|_| None, &mut |lo, _| lo);
    assert!(out.iter().any(|a| matches!(a, Action::Music { cmd: MusicCmd::GetTools, .. })), "{out:?}");
    let out = play(&bot, &kai, "lofi beats to study", NOW);
    assert!(out.iter().any(|a| matches!(a, Action::Music { cmd: MusicCmd::Resolve { query, by, voice }, .. } if query == "lofi beats to study" && by == "1" && voice == VC)), "{out:?}");
    // what it found is queued behind the station
    let found = tracks_from_ytdlp(&json!({ "extractor_key": "YoutubeSearch", "entries": [{ "id": "xyz", "title": "Lofi Beats", "channel": "Ghost FM", "duration": 185.0, "url": "https://www.youtube.com/watch?v=xyz" }] }), 100).unwrap();
    let out = bot.on_music_found(G, 0, "1", Ok(found), NOW);
    assert!(said(&out[0]).contains("Lofi Beats"), "{out:?}");
    bot.players.with(G, |p| assert_eq!(p.queue.len(), 1));
}

#[test]
fn reading_what_yt_dlp_says() {
    // one video
    let one = tracks_from_ytdlp(&json!({ "title": "Midnight Drive (Official Video)", "uploader": "Lo-Fi Ghost", "duration": 187.4, "webpage_url": "https://www.youtube.com/watch?v=abc", "extractor_key": "Youtube", "thumbnail": "https://i.ytimg.com/vi/abc/maxresdefault.jpg" }), 100).unwrap();
    assert_eq!(one.len(), 1);
    let t = &one[0];
    assert_eq!((t.title.as_str(), t.artist.as_deref(), t.seconds, t.source.as_str()), ("Midnight Drive (Official Video)", Some("Lo-Fi Ghost"), Some(187), "media"));
    assert_eq!(t.page.as_deref(), Some("https://www.youtube.com/watch?v=abc"));
    assert_eq!(t.site.as_deref(), Some("Youtube"));
    assert_eq!(t.art.as_deref(), Some("https://i.ytimg.com/vi/abc/maxresdefault.jpg"));
    // live streams and very long videos are turned down in words
    assert!(tracks_from_ytdlp(&json!({ "title": "Live", "is_live": true, "webpage_url": "https://x.example/1" }), 100).unwrap_err().contains("Live streams"));
    assert!(tracks_from_ytdlp(&json!({ "title": "Long", "duration": 20000, "webpage_url": "https://x.example/1" }), 100).unwrap_err().contains("too long"));
    // a playlist, flat: YouTube entries without a page get one, the cap is kept, and live entries are skipped
    let list = json!({ "extractor_key": "YoutubeTab", "entries": [
        { "id": "a1", "title": "One", "duration": 100 },
        { "id": "a2", "title": "Two", "live_status": "is_live" },
        { "id": "a3", "title": "Three", "url": "https://www.youtube.com/watch?v=a3" },
        null,
        { "id": "a4", "title": "Four" }
    ] });
    let got = tracks_from_ytdlp(&list, 2).unwrap();
    assert_eq!(got.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), vec!["One", "Three"]);
    assert_eq!(got[0].page.as_deref(), Some("https://www.youtube.com/watch?v=a1"));
    assert_eq!(got[0].art.as_deref(), Some("https://i.ytimg.com/vi/a1/hqdefault.jpg"));
    // nothing playable
    assert!(tracks_from_ytdlp(&json!({ "entries": [] }), 10).is_err());
    // cover pictures only come from the allowed picture servers
    assert!(safe_art("https://i.ytimg.com/vi/x/hq.jpg").is_some());
    assert!(safe_art("https://i.ytimg.com.evil.example/x.jpg").is_none());
    assert!(safe_art("http://i.ytimg.com/x.jpg").is_none());
    assert!(safe_art("https://tracker.example/x.png").is_none());
}

fn sub(bot: &Bot, who: &Member, name: &str, args: &[(&str, &str)], at: i64) -> Vec<Action> {
    let ev = CommandEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), name: "music".into(), sub: Some(name.into()), args: args.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), at_ms: at, from_form: true, ..Default::default() };
    bot.on_command(&ev, &|_| None, &mut |lo, _| lo)
}
fn slot_of(actions: &[Action]) -> Option<usize> {
    actions.iter().find_map(|a| match a { Action::Music { cmd: MusicCmd::Play { .. }, slot } => Some(*slot), _ => None })
}

#[test]
fn more_music_bots_move_seek_and_the_extra_commands() {
    let (_tmp, bot) = bot();
    let (kai, rowan) = (member("1"), member("2"));
    let (vc2, vc3) = ("800000000000000098", "800000000000000097");
    // a helper music bot is in the server
    bot.directory.set_helpers(vec![gb_core::bot::Helper { slot: 1, name: "Music Two".into(), id: "300".into() }]);
    bot.directory.helper_in(G, 1, true);
    bot.on_voice(G, &kai, Some(VC), true);
    bot.on_voice(G, &rowan, Some(vc2), true);
    // Kai's song goes to the main bot, Rowan's (in another channel) to the free helper
    assert_eq!(slot_of(&play(&bot, &kai, "https://example.com/a.mp3", NOW)), Some(0));
    let out = play(&bot, &rowan, "https://example.com/b.mp3", NOW + 1000);
    assert_eq!(slot_of(&out), Some(1), "{out:?}");
    // the helper has its own player card and buttons
    assert!(bot.players.with(&gb_core::music::slot_key(G, 1), |p| p.voice.clone()).as_deref() == Some(vc2));
    assert!(said(&sub(&bot, &rowan, "now", &[], NOW + 2000)[0]).contains("mu~1:skip"));
    // a third person with no free bot is told so, not given someone else's music
    let third = member("3");
    bot.on_voice(G, &third, Some(vc3), true);
    assert!(said(&play(&bot, &third, "https://example.com/c.mp3", NOW + 3000)[0]).contains("already playing"));
    // the bots list names both
    let list = said(&sub(&bot, &kai, "voice bots", &[], NOW + 3500)[0]);
    assert!(list.contains("The main bot") && list.contains("Music Two"), "{list}");

    // moving the bot: Kai steers his own bot to another channel; the sound is asked to move, the player follows
    let moved = sub(&bot, &kai, "voice move", &[("channel", vc3)], NOW + 4000);
    assert!(said(&moved[0]).contains("Moving to"), "{moved:?}");
    assert!(moved.iter().any(|a| matches!(a, Action::Music { cmd: MusicCmd::Move { voice }, slot: 0 } if voice == vc3)));
    assert_eq!(bot.players.with(G, |p| p.voice.clone()).as_deref(), Some(vc3));
    assert!(said(&sub(&bot, &kai, "voice move", &[("channel", vc3)], NOW + 4100)[0]).contains("already in"));
    // somebody who is not allowed cannot drag a busy bot away (Rowan has company in his channel now)
    bot.on_voice(G, &member("4"), Some(vc2), true);
    assert!(said(&sub(&bot, &rowan, "voice move", &[("channel", VC)], NOW + 4200)[0]).contains("Only a DJ"));
    // a moderator dragging the bot by hand: the voice layer reports it and the player follows
    bot.on_music(G, 0, Heard::Moved(VC.into()), NOW + 4300);
    assert_eq!(bot.players.with(G, |p| p.voice.clone()).as_deref(), Some(VC));

    // seek, forward, rewind keep the progress bar right
    bot.players.with(G, |p| { if let Some(t) = p.now.as_mut() { t.seconds = Some(200); } });
    let s = sub(&bot, &kai, "seek", &[("time", "1:30")], NOW + 10_000);
    assert!(s.iter().any(|a| matches!(a, Action::Music { cmd: MusicCmd::Seek(90), .. })), "{s:?}");
    let f = sub(&bot, &kai, "forward", &[("seconds", "30")], NOW + 10_000);
    assert!(f.iter().any(|a| matches!(a, Action::Music { cmd: MusicCmd::Seek(120), .. })), "{f:?}");
    assert!(said(&sub(&bot, &kai, "seek", &[("time", "9:00")], NOW + 10_000)[0]).contains("past the end"));
    assert!(said(&sub(&bot, &kai, "seek", &[("time", "soon")], NOW + 10_000)[0]).contains("Say a time"));

    // play next goes to the front; remove and clear work on the queue
    play(&bot, &kai, "https://example.com/second.mp3", NOW + 11_000);
    play(&bot, &kai, "https://example.com/third.mp3", NOW + 11_100);
    sub(&bot, &kai, "playnext", &[("song", "https://example.com/urgent.mp3")], NOW + 11_200);
    let first = bot.players.with(G, |p| p.queue.first().map(|t| t.title.clone())).unwrap();
    assert_eq!(first, "urgent");
    assert!(said(&sub(&bot, &kai, "remove", &[("position", "1")], NOW + 11_300)[0]).contains("Removed"));
    assert!(said(&sub(&bot, &kai, "clear", &[], NOW + 11_400)[0]).contains("Cleared 2"));
    // pause and resume say what happened
    assert!(said(&sub(&bot, &kai, "pause", &[], NOW + 12_000)[0]).contains("Paused"));
    assert!(said(&sub(&bot, &kai, "pause", &[], NOW + 12_100)[0]).contains("already paused"));
    assert!(said(&sub(&bot, &kai, "resume", &[], NOW + 12_200)[0]).contains("Playing again"));
    // 24/7: the bot does not leave when nothing plays
    bot.players.with(G, |p| { p.now = None; p.idle_since = Some(NOW); });
    let admin = Member { perms: 1 << 4, ..member("9") };
    assert!(said(&sub(&bot, &admin, "voice stay", &[("on", "yes")], NOW + 13_000)[0]).contains("stay in voice"));
    assert!(bot.on_music_tick(NOW + 9_000_000).iter().all(|(_, a)| !matches!(a, Action::Music { cmd: MusicCmd::Leave, .. })));
}

fn music_cmd(bot: &Bot, who: &Member, sub: &str, args: &[(&str, &str)], at: i64) -> Vec<Action> {
    let ev = CommandEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), name: "music".into(), sub: Some(sub.into()), args: args.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), at_ms: at, from_form: true, ..Default::default() };
    bot.on_command(&ev, &|_| None, &mut |lo, _| lo)
}

#[test]
fn listeners_can_vote_to_skip_when_the_server_allows_it() {
    let (_tmp, bot) = bot();
    let (kai, rowan, ada, outsider) = (member("1"), member("2"), member("3"), member("4"));
    for m in [&kai, &rowan, &ada] { bot.on_voice(G, m, Some(VC), true); }
    play(&bot, &kai, "https://example.com/a.mp3", NOW);
    play(&bot, &kai, "https://example.com/b.mp3", NOW + 1);
    // off by default: only the person who added it (or a DJ) can skip
    assert!(said(&music_cmd(&bot, &rowan, "skip", &[], NOW + 2)[0]).contains("Only the person who added"));
    bot.settings.set(G, "music", "voteSkip", &json!(true)).unwrap();
    // three people listen, half must agree: two votes
    assert!(said(&music_cmd(&bot, &outsider, "voteskip", &[], NOW + 3)[0]).contains("Join the voice channel"));
    assert!(said(&music_cmd(&bot, &rowan, "voteskip", &[], NOW + 4)[0]).contains("**1** of **2**"));
    assert!(said(&music_cmd(&bot, &rowan, "voteskip", &[], NOW + 5)[0]).contains("**1** of **2**"), "the same person votes once");
    let out = music_cmd(&bot, &ada, "voteskip", &[], NOW + 6);
    assert!(said(&out[0]).contains("Skipped"), "{out:?}");
    assert_eq!(played(&out).map(|p| p.1), Some("b".to_string()), "the next song starts");
}

#[test]
fn favourites_are_saved_per_member() {
    let (_tmp, bot) = bot();
    let (kai, rowan) = (member("1"), member("2"));
    bot.on_voice(G, &kai, Some(VC), true);
    assert!(said(&music_cmd(&bot, &kai, "favorite add", &[], NOW)[0]).contains("Nothing is playing"));
    play(&bot, &kai, "https://example.com/music/Morning%20Song.mp3", NOW);
    let saved = music_cmd(&bot, &kai, "favorite add", &[], NOW + 1);
    assert!(said(&saved[0]).contains("Saved **Morning Song**"), "{saved:?}");
    assert!(said(&music_cmd(&bot, &kai, "favorite add", &[], NOW + 2)[0]).contains("already in your favourites"));
    assert!(said(&music_cmd(&bot, &kai, "favorite list", &[], NOW + 3)[0]).contains("1. **Morning Song**"));
    assert!(said(&music_cmd(&bot, &rowan, "favorite list", &[], NOW + 3)[0]).contains("no favourites yet"));
    // playing one asks for it again (it is queued behind what is playing)
    let again = music_cmd(&bot, &kai, "favorite play", &[("number", "1")], NOW + 4);
    assert!(said(&again[0]).contains("queue") || said(&again[0]).contains("Playing"), "{again:?}");
    assert!(said(&music_cmd(&bot, &kai, "favorite play", &[("number", "9")], NOW + 5)[0]).contains("don't have a favourite"));
    assert!(said(&music_cmd(&bot, &kai, "favorite remove", &[("number", "1")], NOW + 6)[0]).contains("Removed **Morning Song**"));
    assert!(said(&music_cmd(&bot, &kai, "favorite list", &[], NOW + 7)[0]).contains("no favourites yet"));
}

#[test]
fn the_launcher_sees_the_player_and_controls_it() {
    let (_tmp, bot) = bot();
    let kai = member("1");
    bot.directory.set_bot_owner(Some("900000000000000009".into()));
    // nothing playing: what is shown is empty, and controls say so
    let empty = bot.music_view(G, NOW);
    assert!(empty["now"].is_null() && empty["queue_total"] == 0 && empty["volume"].as_i64().is_some());
    assert!(bot.music_do(G, "skip", None, NOW).unwrap_err().contains("Nothing is playing"));
    assert!(bot.music_do(G, "dance", None, NOW).is_err());

    bot.on_voice(G, &kai, Some(VC), true);
    play(&bot, &kai, "https://example.com/music/Morning%20Song.mp3", NOW);
    play(&bot, &kai, "https://example.com/b.ogg", NOW + 1000);
    play(&bot, &kai, "https://example.com/c.ogg", NOW + 2000);
    assert!(bot.music_view(G, NOW + 5_000)["position"].is_null(), "no clock before the song has begun");
    let first = uid_playing(&bot);
    bot.on_music(G, 0, Heard::Started(first), NOW);
    let v = bot.music_view(G, NOW + 30_000);
    assert_eq!((v["now"]["title"].as_str(), v["queue_total"].as_i64(), v["paused"].as_bool(), v["position"].as_i64()), (Some("Morning Song"), Some(2), Some(false), Some(30)));

    // pausing holds the clock; playing again lets it run
    let (said, rest) = bot.music_do(G, "pause", None, NOW + 30_000).unwrap();
    assert!(said.contains("Paused") && rest.iter().any(|a| matches!(a, Action::Music { cmd: MusicCmd::Pause, .. })));
    assert_eq!(bot.music_view(G, NOW + 90_000)["position"].as_i64(), Some(30));
    bot.music_do(G, "pause", None, NOW + 90_000).unwrap();

    // volume is kept and sent to the voice layer; remove takes one song off the queue
    let (_, rest) = bot.music_do(G, "volume", Some(35), NOW + 91_000).unwrap();
    assert!(rest.iter().any(|a| matches!(a, Action::Music { cmd: MusicCmd::Volume(35), .. })));
    assert_eq!(bot.music_view(G, NOW + 91_000)["volume"].as_i64(), Some(35));
    assert!(bot.music_do(G, "remove", Some(9), NOW).unwrap_err().contains("no song"));
    bot.music_do(G, "remove", Some(1), NOW + 92_000).unwrap();
    assert_eq!(bot.music_view(G, NOW + 92_000)["queue_total"].as_i64(), Some(1));

    // skipping asks the voice layer to stop this song and move to the next
    let (said, rest) = bot.music_do(G, "skip", None, NOW + 93_000).unwrap();
    assert!(said.contains("Skipped") && rest.iter().any(|a| matches!(a, Action::Music { cmd: MusicCmd::Stop, .. })));
    assert_eq!(bot.music_view(G, NOW + 94_000)["queue_total"].as_i64(), Some(0));
}

#[test]
fn the_launchers_music_page_keeps_playlists_and_runs_the_queue() {
    let (_tmp, bot) = bot();
    bot.directory.set_bot_owner(Some("900000000000000009".into()));
    bot.directory.set_channels(G, vec![gb_core::bot::Named { id: VC.into(), name: "Lounge".into(), kind: "voice", parent: String::new() }, gb_core::bot::Named { id: CH.into(), name: "chat".into(), kind: "text", parent: String::new() }]);
    let ask = |kind: &str, name: &str, args: serde_json::Value, at: i64| bot.music_api(G, kind, name, &args, at);

    // the first view lists voice channels (not text ones), playlists, and what can be played
    let (v, _) = ask("view", "player", json!({}), NOW).unwrap();
    assert_eq!((v["connected"].as_bool(), v["voiceChannels"].as_array().map(Vec::len), v["limits"]["playlistSongs"].as_i64()), (Some(false), Some(1), Some(300)));
    assert!(ask("action", "add", json!({ "link": "https://example.com/a.mp3" }), NOW).unwrap_err().contains("voice channel"));
    // the page is told which call the person looking at it is in, so playing can join that one
    assert!(v["myChannel"].is_null(), "nobody asked as anyone");
    bot.directory.set_voice(G, "900000000000000009", Some(VC));
    let (mine, _) = ask("view", "player", json!({ "me": "900000000000000009" }), NOW).unwrap();
    assert_eq!((mine["myChannel"].as_str(), mine["myChannelName"].as_str()), (Some(VC), Some("Lounge")));
    let (other, _) = ask("view", "player", json!({ "me": "900000000000000010" }), NOW).unwrap();
    assert!(other["myChannel"].is_null(), "someone who is not in a call has none");
    bot.directory.set_voice(G, "900000000000000009", None);

    // adding a link to an audio file joins the chosen channel and starts it; a second waits
    let (r, acts) = ask("action", "add", json!({ "link": "https://example.com/a.mp3", "channelId": VC }), NOW).unwrap();
    assert_eq!(r["added"], 1);
    assert!(acts.iter().any(|a| matches!(a, Action::Music { cmd: MusicCmd::Join { .. }, .. })) && played(&acts).is_some(), "{acts:?}");
    ask("action", "add", json!({ "link": "https://example.com/b.mp3" }), NOW + 1000).unwrap();
    ask("action", "add", json!({ "link": "https://example.com/c.mp3", "where": "next" }), NOW + 2000).unwrap();
    let (s, _) = ask("view", "player", json!({}), NOW + 3000).unwrap();
    assert_eq!((s["connected"].as_bool(), s["current"]["title"].as_str(), s["queueLength"].as_i64(), s["queue"][0]["title"].as_str()), (Some(true), Some("a"), Some(2), Some("c")));

    // queue changes: move the last song to the top, then remove it
    let b = s["queue"][1]["uid"].as_str().unwrap().to_string();
    let (s, _) = ask("action", "queue", json!({ "op": "top", "uid": b }), NOW + 4000).unwrap();
    assert_eq!(s["queue"][0]["title"], "b");
    let (s, _) = ask("action", "queue", json!({ "op": "remove", "uid": b }), NOW + 5000).unwrap();
    assert_eq!(s["queueLength"], 1);
    assert!(ask("action", "queue", json!({ "op": "remove", "uid": b }), NOW + 6000).unwrap_err().contains("not in the queue"));

    // a playlist is saved from the queue, renamed, played, and deleted
    let (r, _) = ask("action", "playlist", json!({ "op": "create", "name": "  Road   trip ", "fromQueue": true }), NOW + 7000).unwrap();
    assert_eq!((r["added"].as_i64(), r["playlist"]["name"].as_str()), (Some(2), Some("Road trip")));
    let id = r["playlist"]["id"].as_str().unwrap().to_string();
    assert!(ask("action", "playlist", json!({ "op": "create", "name": "" }), NOW).unwrap_err().contains("name"));
    let (r, _) = ask("action", "playlist", json!({ "op": "rename", "id": id, "name": "Drive" }), NOW + 8000).unwrap();
    assert_eq!(r["playlist"]["name"], "Drive");
    let first = ask("view", "playlist", json!({ "id": id }), NOW).unwrap().0["tracks"][0]["id"].as_str().unwrap().to_string();
    let (r, _) = ask("action", "playlist", json!({ "op": "move", "id": id, "trackId": first, "to": 1 }), NOW + 9000).unwrap();
    assert_eq!(r["playlist"]["tracks"][1]["id"], json!(first));
    let (_, acts) = ask("action", "playlist", json!({ "op": "play", "id": id }), NOW + 10_000).unwrap();
    assert!(acts.iter().any(|a| matches!(a, Action::Music { cmd: MusicCmd::Stop, .. })) && played(&acts).is_some(), "{acts:?}");
    let (s, _) = ask("view", "player", json!({}), NOW + 11_000).unwrap();
    assert_eq!(s["queueLength"], 1, "the queue was replaced by the playlist");
    ask("action", "playlist", json!({ "op": "remove", "id": id, "trackId": first }), NOW + 12_000).unwrap();
    assert_eq!(ask("view", "playlist", json!({ "id": id }), NOW).unwrap().0["count"], 1);
    ask("action", "playlist", json!({ "op": "delete", "id": id }), NOW + 13_000).unwrap();
    assert!(ask("view", "playlist", json!({ "id": id }), NOW).unwrap_err().contains("deleted"));

    // searching: a station's name is found; a site search needs the lookup program, and says so
    bot.settings.set(G, "music", "stations", &json!(["Lofi Radio | https://radio.example.com/lofi"])).unwrap();
    let (r, _) = ask("action", "search", json!({ "q": "lofi" }), NOW).unwrap();
    assert_eq!(r["results"][0]["title"], "Lofi Radio");
    // one search result is added to a playlist by its single "token" (the page sends it that way), and can start a playlist
    let token = r["results"][0]["token"].as_str().unwrap().to_string();
    let (made, _) = ask("action", "playlist", json!({ "op": "create", "name": "Chill" }), NOW).unwrap();
    let pid = made["playlist"]["id"].as_str().unwrap().to_string();
    let (r2, _) = ask("action", "playlist", json!({ "op": "add", "id": pid, "token": token }), NOW + 1).unwrap();
    assert_eq!((r2["added"].as_i64(), r2["playlist"]["count"].as_i64()), (Some(1), Some(1)), "{r2}");
    let (r3, _) = ask("action", "playlist", json!({ "op": "create", "name": "From a result", "token": token }), NOW + 2).unwrap();
    assert_eq!(r3["added"], 1);
    assert!(ask("action", "playlist", json!({ "op": "add", "id": pid }), NOW + 3).unwrap_err().contains("at least one song"));
    assert!(ask("action", "search", json!({ "q": "never gonna give you up" }), NOW).unwrap_err().contains("not in the launcher yet"));
    assert!(ask("action", "playlist", json!({ "op": "import", "link": "https://x" }), NOW).unwrap_err().contains("not in the launcher yet"));
    // the player can be stopped, and the volume and seek obey the same rules as the buttons
    let (_, acts) = ask("action", "control", json!({ "do": "stop" }), NOW + 14_000).unwrap();
    assert!(acts.iter().any(|a| matches!(a, Action::Music { cmd: MusicCmd::Leave, .. })));
}

#[test]
fn site_searches_and_imports_follow_the_media_switch_and_keep_what_was_found() {
    use gb_core::music::Track;
    let (_tmp, bot) = bot();
    bot.directory.set_bot_owner(Some("900000000000000009".into()));
    // a name search on a music site is off until the bot's owner turns media links on; a playlist link can always be read
    assert!(bot.music_site_search_ok(G, "never gonna give you up").unwrap_err().contains("off in this server"));
    assert!(bot.music_site_search_ok(G, "https://www.youtube.com/playlist?list=abc").is_ok());
    // Spotify, Apple Music, Deezer, Pandora and the rest are read like any other link (they play once media links are on)
    for link in ["https://open.spotify.com/playlist/x", "https://music.apple.com/us/album/a/1", "https://www.deezer.com/track/1", "https://www.pandora.com/artist/a/b/c/TRabc", "https://tidal.com/browse/track/1"] {
        assert!(bot.music_site_search_ok(G, link).is_ok(), "{link}");
    }
    let songs = vec![Track { title: "One".into(), source: "media".into(), page: Some("https://www.youtube.com/watch?v=1".into()), ..Default::default() }, Track { title: "Two".into(), source: "media".into(), page: Some("https://www.youtube.com/watch?v=2".into()), ..Default::default() }];
    // results carry a token each, and say plainly that they cannot play yet
    let found = bot.music_results(G, &songs, Some("Road trip"));
    assert_eq!((found["results"].as_array().map(Vec::len), found["list"]["name"].as_str(), found["list"]["count"].as_i64()), (Some(2), Some("Road trip"), Some(2)));
    assert!(found["note"].as_str().unwrap().contains("media links"));
    let tokens: Vec<String> = found["results"].as_array().unwrap().iter().map(|r| r["token"].as_str().unwrap().to_string()).collect();
    // a found song can be saved to a playlist by its token
    let (r, _) = bot.music_api(G, "action", "playlist", &json!({ "op": "create", "name": "Found", "tokens": tokens }), NOW).unwrap();
    assert_eq!(r["added"], 2);
    // an imported list becomes a playlist of its own, with its songs in order
    let imported = bot.music_import(G, "Road trip", &songs, NOW + 1000).unwrap();
    assert_eq!((imported["added"].as_i64(), imported["playlist"]["name"].as_str(), imported["playlist"]["tracks"][1]["title"].as_str()), (Some(2), Some("Road trip"), Some("Two")));
    assert!(bot.music_import(G, "Empty", &[], NOW).is_err());
}

#[test]
fn autoplay_brings_an_earlier_song_round_when_the_queue_runs_out() {
    let (_tmp, bot) = bot();
    let kai = member("1");
    bot.on_voice(G, &kai, Some(VC), true);
    play(&bot, &kai, "https://example.com/a.mp3", NOW);
    play(&bot, &kai, "https://example.com/b.mp3", NOW + 1);
    // off by default: the queue ends and nothing more is asked for
    let first = uid_playing(&bot);
    let out = bot.on_music(G, 0, Heard::Ended(first), NOW + 100);
    assert_eq!(played(&out).map(|p| p.1), Some("b".to_string()));
    let second = uid_playing(&bot);
    assert!(played(&bot.on_music(G, 0, Heard::Ended(second), NOW + 200)).is_none(), "autoplay is off");
    // on: when b ends, the only other song played earlier (a) comes back, and when a ends, b does
    bot.settings.set(G, "music", "autoplay", &json!(true)).unwrap();
    play(&bot, &kai, "https://example.com/b.mp3", NOW + 300);
    let b = uid_playing(&bot);
    let out = bot.on_music(G, 0, Heard::Ended(b), NOW + 400);
    let again = played(&out).map(|p| p.1);
    assert!(again.as_deref().is_some_and(|t| t == "a"), "{again:?}");
    // a song that fails does not autoplay another one over the problem
    let a = uid_playing(&bot);
    assert!(played(&bot.on_music(G, 0, Heard::Failed(a, "nope".into()), NOW + 500)).is_none());
}

#[test]
fn a_radio_stream_that_drops_is_picked_up_again_a_few_times_and_a_good_stretch_starts_the_count_over() {
    let (_tmp, bot) = bot();
    let kai = member("1");
    bot.on_voice(G, &kai, Some(VC), true);
    bot.settings.set(G, "music", "stations", &json!(["Lofi Ghost | https://radio.example.com/live"])).unwrap();
    assert_eq!(played(&play(&bot, &kai, "lofi ghost", NOW)).map(|p| p.1), Some("Lofi Ghost".to_string()));
    // the stream drops again and again: the same station is asked for each time, but not for ever
    for i in 0..6 {
        let uid = uid_playing(&bot);
        let out = bot.on_music(G, 0, Heard::Failed(uid, "connection reset".into()), NOW + 1000 * (i + 1));
        assert_eq!(played(&out).map(|p| p.1), Some("Lofi Ghost".to_string()), "pick-up {i}: {out:?}");
        assert!(!out.iter().any(|a| matches!(a, Action::Send { .. }) && said(a).contains("Couldn't play")), "no noise while reconnecting");
    }
    let uid = uid_playing(&bot);
    let out = bot.on_music(G, 0, Heard::Failed(uid, "connection reset".into()), NOW + 20_000);
    assert!(played(&out).is_none(), "after six tries it gives up");
    // a station that plays properly starts the count over
    play(&bot, &kai, "lofi ghost", NOW + 30_000);
    let uid = uid_playing(&bot);
    bot.on_music(G, 0, Heard::Started(uid), NOW + 31_000);
    let uid = uid_playing(&bot);
    assert_eq!(played(&bot.on_music(G, 0, Heard::Ended(uid), NOW + 40_000)).map(|p| p.1), Some("Lofi Ghost".to_string()));
}

#[test]
fn the_sound_filter_is_a_setting_that_rides_along_with_each_song_and_follows_the_same_rules_as_volume() {
    let (_tmp, bot) = bot();
    let kai = member("1");
    bot.on_voice(G, &kai, Some(VC), true);
    let set = |who: &Member, filter: &str| {
        let ev = CommandEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), name: "music".into(), sub: Some("sound filter".into()), args: [("filter".to_string(), filter.to_string())].into(), at_ms: NOW, from_form: false, ..Default::default() };
        bot.on_command(&ev, &|_| None, &mut |lo, _| lo)
    };
    let filter_of = |out: &[Action]| out.iter().find_map(|a| match a { Action::Music { cmd: MusicCmd::Play { filter, .. }, .. } => Some(filter.clone()), _ => None });
    // nobody is playing yet, so Kai may set it
    assert!(said(&set(&kai, "nightcore")[0]).contains("Nightcore"));
    assert_eq!(filter_of(&play(&bot, &kai, "https://example.com/a.mp3", NOW)).as_deref(), Some("nightcore"));
    // the launcher shows it and can change it
    assert_eq!(bot.music_view(G, NOW)["filter"], "nightcore");
    let (_, rest) = bot.music_do(G, "filter", Some(1), NOW + 1000).unwrap();
    assert_eq!(bot.music_view(G, NOW)["filter"], "bassboost");
    assert!(rest.iter().all(|a| !matches!(a, Action::Music { cmd: MusicCmd::Play { .. }, .. })));
    // something it does not know means off
    set(&kai, "echo");
    assert_eq!(bot.music_view(G, NOW)["filter"], "off");
    // with a song on, a stranger cannot change what everyone hears
    set(&kai, "slowed");
    let stranger = member("2");
    bot.on_voice(G, &stranger, Some(VC), true);
    assert!(said(&set(&stranger, "off")[0]).contains("Only a DJ"));
    assert_eq!(bot.music_view(G, NOW)["filter"], "slowed");
}


fn press(bot: &Bot, who: &Member, id: &str, at: i64) -> Vec<Action> {
    let ev = gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), at_ms: at, ..Default::default() };
    bot.on_button(&ev, &|_| None, &mut |lo, _| lo)
}
fn form_id(out: &[Action]) -> Option<String> {
    out.iter().find_map(|a| match a { Action::Form { id, .. } => Some(id.clone()), _ => None })
}

#[test]
fn someone_in_another_call_starts_their_own_queue_instead_of_touching_the_others() {
    let (_tmp, bot) = bot();
    let (kai, rowan, third, nobody) = (member("1"), member("2"), member("3"), member("4"));
    let (vc2, vc3) = ("800000000000000098", "800000000000000097");
    bot.directory.set_helpers(vec![gb_core::bot::Helper { slot: 1, name: "Music Two".into(), id: "300".into() }]);
    bot.directory.helper_in(G, 1, true);
    bot.on_voice(G, &kai, Some(VC), true);
    bot.on_voice(G, &rowan, Some(vc2), true);
    bot.on_voice(G, &third, Some(vc3), true);
    // Kai is alone in the call with the main bot, and it is playing his song
    assert_eq!(slot_of(&play(&bot, &kai, "https://example.com/a.mp3", NOW)), Some(0));
    // Rowan, in a different call, cannot stop it, even though Kai is the only one listening; he is told what to do instead
    let no = said(&press(&bot, &rowan, "mu:stop", NOW + 1000)[0]);
    assert!(no.contains("different voice channel") && no.contains("Start mine"), "{no}");
    assert!(bot.players.with(&gb_core::music::slot_key(G, 0), |p| p.now.is_some() || !p.queue.is_empty()), "Kai's queue is untouched");
    // Kai can still control his own
    assert!(matches!(press(&bot, &kai, "mu:pause", NOW + 1500)[0], Action::Update { .. }), "Kai can pause his own player");
    // Start mine opens the Add popup for the FREE helper, so Rowan's songs play in Rowan's call
    assert_eq!(form_id(&press(&bot, &rowan, "mu:start", NOW + 2000)).as_deref(), Some("mu~1:add"));
    // once the helper is playing for Rowan, a third person with no free bot is told why, not given someone else's music
    assert_eq!(slot_of(&play(&bot, &rowan, "https://example.com/b.mp3", NOW + 3000)), Some(1));
    let busy = said(&press(&bot, &third, "mu:start", NOW + 4000)[0]);
    assert!(busy.contains("busy"), "{busy}");
    // someone who is already in a call with a bot is pointed at it
    assert!(said(&press(&bot, &kai, "mu:start", NOW + 5000)[0]).contains("already in"));
    // someone who is not in any voice channel is asked to join one
    assert!(said(&press(&bot, &nobody, "mu:start", NOW + 6000)[0]).contains("Join a voice channel"));
    // the player card now offers it
    assert!(said(&sub(&bot, &kai, "now", &[], NOW + 7000)[0]).contains("mu:start"));
}

#[test]
fn with_no_helper_bot_start_mine_explains_that_a_second_bot_is_needed() {
    let (_tmp, bot) = bot();
    let (kai, rowan) = (member("1"), member("2"));
    bot.on_voice(G, &kai, Some(VC), true);
    bot.on_voice(G, &rowan, Some("800000000000000098"), true);
    play(&bot, &kai, "https://example.com/a.mp3", NOW);
    let said_ = said(&press(&bot, &rowan, "mu:start", NOW + 1000)[0]);
    assert!(said_.contains("one channel at a time") && said_.contains("Music bots"), "{said_}");
}
