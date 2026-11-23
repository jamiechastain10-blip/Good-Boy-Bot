//! Music services whose own audio cannot be played outside them (Spotify, Apple Music, Deezer, Pandora, Tidal, Amazon
//! Music and the like). A link to one is read for what it names (the song, its artist, the playlist or album it
//! belongs to), and each song is then played by finding the same song on a site the media-links player can read.
//!
//! This file only understands the pages and answers that come back; fetching them is the Discord layer's job
//! (`gb-discord/src/links.rs`), so everything here can be tested without a network.
use crate::music::Track;
use regex::Regex;
use serde_json::Value;

/// A song as a service names it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Wanted {
    pub title: String,
    pub artist: String,
    pub seconds: Option<i64>,
}
/// What a link names: one song, or a list of them.
#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    pub name: Option<String>,
    pub songs: Vec<Wanted>,
    pub list: bool,
}
/// How the thing to fetch is understood.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum How {
    SpotifyEmbed,
    Deezer,
    Itunes,
    /// A web page: its structured data, or failing that its title.
    Page,
    /// An Apple Music playlist page: the songs' numbers are read, then looked up in Apple's catalogue.
    ApplePlaylist,
    /// Nothing to fetch: the link's own words name the song (Pandora's links do).
    Slug,
}
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub site: &'static str,
    pub how: How,
    /// What to fetch (empty for `Slug`).
    pub fetch: String,
    pub list: bool,
}

/// Most songs taken from one list.
pub const MOST: usize = 300;

/// A link taken apart: (host without `www.`, path pieces, query).
fn split(link: &str) -> Option<(String, Vec<String>, String)> {
    let rest = link.trim().strip_prefix("https://").or_else(|| link.trim().strip_prefix("http://"))?;
    let (before_hash, _) = rest.split_once('#').unwrap_or((rest, ""));
    let (path_part, query) = before_hash.split_once('?').unwrap_or((before_hash, ""));
    let (host, path) = path_part.split_once('/').unwrap_or((path_part, ""));
    let host = host.split('@').next_back().unwrap_or(host).split(':').next().unwrap_or(host).to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    if host.is_empty() { return None; }
    Some((host, path.split('/').filter(|p| !p.is_empty()).map(str::to_string).collect(), query.to_string()))
}
fn query_of(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|kv| kv.split_once('=').filter(|(k, _)| *k == key).map(|(_, v)| v.to_string())).filter(|v| !v.is_empty())
}
/// Links that only point somewhere else; the real address is what they redirect to.
pub fn is_short(link: &str) -> bool {
    split(link).is_some_and(|(h, _, _)| ["spotify.link", "spoti.fi", "link.deezer.com", "deezer.page.link", "pandora.app.link", "amzn.to", "amzn.eu", "tidal.link", "apple.co", "song.link", "album.link", "odesli.co"].contains(&h.as_str()))
}
fn is_id(s: &str, min: usize, max: usize) -> bool { (min..=max).contains(&s.len()) && s.chars().all(|c| c.is_ascii_alphanumeric()) }

/// What to do with a link to a music service. None when it is not one of the services read here.
pub fn plan(link: &str) -> Option<Plan> {
    let (host, parts, query) = split(link)?;
    let ends = |d: &str| host == d || host.ends_with(&format!(".{d}"));
    if ends("spotify.com") {
        let at = parts.iter().position(|p| ["track", "album", "playlist", "artist"].contains(&p.as_str()))?;
        let id = parts.get(at + 1).filter(|i| is_id(i, 10, 40))?;
        let kind = parts[at].as_str();
        return Some(Plan { site: "Spotify", how: How::SpotifyEmbed, fetch: format!("https://open.spotify.com/embed/{kind}/{id}"), list: kind != "track" });
    }
    if ends("deezer.com") {
        let at = parts.iter().position(|p| ["track", "album", "playlist", "artist"].contains(&p.as_str()))?;
        let id = parts.get(at + 1).filter(|i| i.chars().all(|c| c.is_ascii_digit()) && !i.is_empty())?;
        let kind = parts[at].as_str();
        let fetch = if kind == "artist" { format!("https://api.deezer.com/artist/{id}/top?limit=50") } else { format!("https://api.deezer.com/{kind}/{id}") };
        return Some(Plan { site: "Deezer", how: How::Deezer, fetch, list: kind != "track" });
    }
    if ends("music.apple.com") || ends("itunes.apple.com") {
        let cc = parts.first().filter(|p| p.len() == 2).cloned().unwrap_or_else(|| "us".into());
        let num = |p: Option<&String>| p.filter(|i| !i.is_empty() && i.chars().all(|c| c.is_ascii_digit())).cloned();
        let lookup = |ids: &str, more: &str| format!("https://itunes.apple.com/lookup?id={ids}{more}&country={cc}");
        if let Some(song) = query_of(&query, "i").filter(|i| i.chars().all(|c| c.is_ascii_digit())) {
            return Some(Plan { site: "Apple Music", how: How::Itunes, fetch: lookup(&song, ""), list: false });
        }
        if let Some(at) = parts.iter().position(|p| p == "song") {
            let id = num(parts.last().filter(|_| parts.len() > at + 1))?;
            return Some(Plan { site: "Apple Music", how: How::Itunes, fetch: lookup(&id, ""), list: false });
        }
        if let Some(at) = parts.iter().position(|p| p == "album") {
            let id = num(parts.last().filter(|_| parts.len() > at + 1))?;
            return Some(Plan { site: "Apple Music", how: How::Itunes, fetch: lookup(&id, "&entity=song"), list: true });
        }
        if parts.iter().any(|p| p == "playlist") {
            let clean = link.split(['?', '#']).next().unwrap_or(link).to_string();
            return Some(Plan { site: "Apple Music", how: How::ApplePlaylist, fetch: clean, list: true });
        }
        return None;
    }
    if ends("pandora.com") {
        return Some(Plan { site: "Pandora", how: How::Slug, fetch: String::new(), list: false });
    }
    let pages: [(&str, &str); 9] = [("tidal.com", "Tidal"), ("music.amazon.com", "Amazon Music"), ("napster.com", "Napster"), ("qobuz.com", "Qobuz"), ("shazam.com", "Shazam"), ("anghami.com", "Anghami"), ("jiosaavn.com", "JioSaavn"), ("boomplay.com", "Boomplay"), ("audius.co", "Audius")];
    for (d, name) in pages {
        if ends(d) { return Some(Plan { site: name, how: How::Page, fetch: link.split('#').next().unwrap_or(link).to_string(), list: false }); }
    }
    if host.starts_with("music.amazon.") { return Some(Plan { site: "Amazon Music", how: How::Page, fetch: link.split('#').next().unwrap_or(link).to_string(), list: false }); }
    None
}

fn clip(s: &str, max: usize) -> String { s.trim().chars().take(max).collect() }
fn song(title: &str, artist: &str, seconds: Option<i64>) -> Option<Wanted> {
    let title = clip(title, 200);
    if title.is_empty() { return None; }
    Some(Wanted { title, artist: clip(artist, 100), seconds: seconds.filter(|s| *s > 0) })
}
fn seconds_of(v: &Value) -> Option<i64> { v.as_f64().map(|n| n.round() as i64) }

/// Reads what a plan fetched. `link` is the address that was asked for (a Pandora link says everything itself).
pub fn read(plan: &Plan, link: &str, body: &str) -> Result<Reading, String> {
    let nothing = || format!("Couldn't read that {} link. Check that it is a song, album or playlist that is public, and try again.", plan.site);
    let reading = match plan.how {
        How::SpotifyEmbed => spotify_embed(body),
        How::Deezer => deezer(body),
        How::Itunes | How::ApplePlaylist => itunes(body),
        How::Page => page(body),
        How::Slug => pandora_slug(link),
    };
    match reading {
        Some(r) if !r.songs.is_empty() => Ok(Reading { songs: r.songs.into_iter().take(MOST).collect(), ..r }),
        _ => Err(nothing()),
    }
}

/// Spotify's public embed page: a song, or the songs of an album, playlist or artist.
pub fn spotify_embed(html: &str) -> Option<Reading> {
    let re = Regex::new(r#"(?s)<script id="__NEXT_DATA__"[^>]*>(.*?)</script>"#).ok()?;
    let j: Value = serde_json::from_str(re.captures(html)?.get(1)?.as_str()).ok()?;
    let e = &j["props"]["pageProps"]["state"]["data"]["entity"];
    let first_artist = |s: &str| s.replace('\u{a0}', " ").split(',').next().unwrap_or("").trim().to_string();
    if let Some(list) = e["trackList"].as_array() {
        let songs = list.iter().filter(|t| t["isPlayable"] != false && t["entityType"].as_str().unwrap_or("track") == "track")
            .filter_map(|t| song(t["title"].as_str()?, &first_artist(t["subtitle"].as_str().unwrap_or("")), seconds_of(&t["duration"]).map(|ms| ms / 1000))).collect();
        let name = e["name"].as_str().or(e["title"].as_str()).map(|n| clip(n, 100)).filter(|n| !n.is_empty());
        return Some(Reading { name, songs, list: true });
    }
    if e["type"] == "track" {
        let artist = e["artists"].as_array().and_then(|a| a.first()).and_then(|a| a["name"].as_str()).unwrap_or("");
        let one = song(e["title"].as_str().or(e["name"].as_str())?, artist, seconds_of(&e["duration"]).map(|ms| ms / 1000))?;
        return Some(Reading { name: None, songs: vec![one], list: false });
    }
    None
}

/// Deezer's public API: a song, an album, a playlist, or an artist's top songs.
pub fn deezer(body: &str) -> Option<Reading> {
    let j: Value = serde_json::from_str(body).ok()?;
    if j["error"].is_object() { return None; }
    let one = |t: &Value, fallback: &str| song(t["title"].as_str()?, t["artist"]["name"].as_str().unwrap_or(fallback), seconds_of(&t["duration"]));
    if let Some(list) = j["tracks"]["data"].as_array().or(j["data"].as_array()) {
        let by = j["artist"]["name"].as_str().unwrap_or("");
        let name = j["title"].as_str().map(|n| clip(n, 100)).filter(|n| !n.is_empty());
        return Some(Reading { name, songs: list.iter().filter_map(|t| one(t, by)).collect(), list: true });
    }
    Some(Reading { name: None, songs: vec![one(&j, "")?], list: false })
}

/// Apple's catalogue lookup (iTunes): songs, or an album with its songs after it.
pub fn itunes(body: &str) -> Option<Reading> {
    let j: Value = serde_json::from_str(body).ok()?;
    let rows = j["results"].as_array()?;
    let songs: Vec<Wanted> = rows.iter().filter(|r| r["wrapperType"] == "track" && r["kind"] == "song")
        .filter_map(|r| song(r["trackName"].as_str()?, r["artistName"].as_str().unwrap_or(""), seconds_of(&r["trackTimeMillis"]).map(|ms| ms / 1000))).collect();
    let name = rows.iter().find(|r| r["wrapperType"] == "collection").and_then(|c| c["collectionName"].as_str()).map(|n| clip(n, 100));
    let list = name.is_some() || songs.len() > 1;
    Some(Reading { name, songs, list })
}
/// The song numbers listed on an Apple Music playlist page, in order.
pub fn apple_song_ids(html: &str) -> Vec<String> {
    let re = Regex::new(r#"https://music\.apple\.com/[a-z]{2}/song/[^"/]+/(\d+)"#).unwrap();
    let mut seen: Vec<String> = Vec::new();
    for c in re.captures_iter(html) {
        let id = c[1].to_string();
        if !seen.contains(&id) { seen.push(id); }
        if seen.len() >= MOST { break; }
    }
    seen
}
/// The address that looks those numbers up.
pub fn apple_lookup(ids: &[String], country: &str) -> String {
    format!("https://itunes.apple.com/lookup?id={}&country={}", ids.join(","), country)
}
/// The name of an Apple Music playlist page.
pub fn apple_playlist_name(html: &str) -> Option<String> {
    og(html, "og:title").map(|t| clip(t.trim_end_matches(" on Apple Music"), 100))
}

/// Pandora pages are drawn by a script, so the words in the link are all there is:
/// `/artist/<artist>/<album>/<song>/<id>` names the song.
pub fn pandora_slug(link: &str) -> Option<Reading> {
    let (_, parts, _) = split(link)?;
    let words = |s: &str| s.replace(['-', '_'], " ").split_whitespace().collect::<Vec<_>>().join(" ");
    let parts: Vec<&String> = parts.iter().collect();
    if parts.first().map(|p| p.as_str()) != Some("artist") { return None; }
    let id_like = |s: &str| s.len() > 8 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == ':') && s.chars().any(|c| c.is_ascii_uppercase()) && (s.starts_with("TR") || s.starts_with("AL") || s.starts_with("AR"));
    let named: Vec<&&String> = parts.iter().skip(1).filter(|p| !id_like(p)).collect();
    let (artist, title) = match named.as_slice() {
        [artist, _album, track] => (words(artist), words(track)),
        [artist, album] => (words(artist), words(album)),
        [artist] => (words(artist), String::new()),
        _ => return None,
    };
    let one = Wanted { title: if title.is_empty() { artist.clone() } else { title }, artist, seconds: None };
    if one.title.is_empty() { return None; }
    Some(Reading { name: None, songs: vec![one], list: false })
}

fn decode(s: &str) -> String {
    s.replace("&amp;", "&").replace("&quot;", "\"").replace("&#x27;", "'").replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ").trim().to_string()
}
/// A page's `<meta property="…" content="…">` value.
pub fn og(html: &str, prop: &str) -> Option<String> {
    let p = regex::escape(prop);
    let a = Regex::new(&format!(r#"(?i)<meta[^>]+(?:property|name)\s*=\s*["']{p}["'][^>]*content\s*=\s*["']([^"']*)["']"#)).ok()?;
    let b = Regex::new(&format!(r#"(?i)<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*(?:property|name)\s*=\s*["']{p}["']"#)).ok()?;
    a.captures(html).or_else(|| b.captures(html)).map(|c| decode(&c[1])).filter(|v| !v.is_empty())
}
/// "PT3M28S" as seconds.
pub fn iso_seconds(d: &str) -> Option<i64> {
    let c = Regex::new(r"^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$").ok()?.captures(d.trim())?;
    let n = |i: usize| c.get(i).and_then(|m| m.as_str().parse::<f64>().ok()).unwrap_or(0.0);
    let total = n(1) * 3600.0 + n(2) * 60.0 + n(3);
    (total > 0.0).then_some(total.round() as i64)
}
fn artist_names(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Object(_) => v["name"].as_str().unwrap_or("").to_string(),
        Value::Array(a) => a.iter().map(artist_names).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", "),
        _ => String::new(),
    }
}
fn ld_blocks(html: &str) -> Vec<Value> {
    let re = Regex::new(r#"(?is)<script[^>]*type\s*=\s*["']application/ld\+json["'][^>]*>(.*?)</script>"#).unwrap();
    let mut out = Vec::new();
    for c in re.captures_iter(html) {
        if let Ok(v) = serde_json::from_str::<Value>(c[1].trim()) {
            match v { Value::Array(a) => out.extend(a), other => out.push(other) }
        }
    }
    out
}
fn ld_song(t: &Value, fallback_artist: &str) -> Option<Wanted> {
    let by = artist_names(&t["byArtist"]);
    let by = if by.is_empty() { artist_names(&t["author"]) } else { by };
    song(t["name"].as_str()?, if by.is_empty() { fallback_artist } else { &by }, t["duration"].as_str().and_then(iso_seconds))
}
/// A page's own description of a song, album or playlist (the data sites add for search engines), else its title.
pub fn page(html: &str) -> Option<Reading> {
    for b in ld_blocks(html) {
        let kind = b["@type"].as_str().unwrap_or("");
        let tracks = b["track"].as_array().or(b["itemListElement"].as_array());
        if let (true, Some(list)) = (matches!(kind, "MusicAlbum" | "MusicPlaylist" | "ItemList" | "MusicGroup"), tracks) {
            let by = artist_names(&b["byArtist"]);
            let songs: Vec<Wanted> = list.iter().filter_map(|t| ld_song(if t["item"].is_object() { &t["item"] } else { t }, &by)).collect();
            if !songs.is_empty() { return Some(Reading { name: b["name"].as_str().map(|n| clip(n, 100)), songs, list: true }); }
        }
        if kind == "MusicRecording" {
            if let Some(one) = ld_song(&b, "") { return Some(Reading { name: None, songs: vec![one], list: false }); }
        }
    }
    title_only(html)
}
/// What a page's title says, with the service's name taken off: "Song by Artist on Apple Music" is a song and an artist.
pub fn title_only(html: &str) -> Option<Reading> {
    let raw = og(html, "og:title").or_else(|| og(html, "twitter:title")).or_else(|| {
        let re = Regex::new(r"(?is)<title[^>]*>(.*?)</title>").ok()?;
        re.captures(html).map(|c| decode(&c[1])).filter(|t| !t.is_empty())
    })?;
    let one = from_title(&raw)?;
    Some(Reading { name: None, songs: vec![one], list: false })
}
/// A page title as a song. None when there is nothing left once the service's name is removed.
pub fn from_title(raw: &str) -> Option<Wanted> {
    let sites = Regex::new(r"(?i)\s*(?:[|\u{2013}\u{2014}-]|\bon\b)\s*(?:apple music(?: - web player)?|spotify|tidal|amazon music|amazon\.com|pandora|napster|qobuz|shazam|deezer|anghami|jiosaavn|boomplay|audius|youtube music|soundcloud|bandcamp)\s*$").ok()?;
    let mut t = raw.trim().to_string();
    // "Song - Single by Artist", "Song by Artist", "Song (Live) - song and lyrics by Artist"
    for _ in 0..2 { let cut = sites.replace(&t, "").trim().to_string(); if cut == t { break; } t = cut; }
    let t = Regex::new(r"(?i)\s*[-\u{2013}\u{2014}]\s*(?:song and lyrics|single|ep|album|song)\b.*?\bby\b").ok()?.replace(&t, " by").to_string();
    if t.is_empty() { return None; }
    if let Some((title, artist)) = t.rsplit_once(" by ") {
        return song(title, artist, None);
    }
    song(&t, "", None)
}

/// A song as a track the media player can play: it is found on YouTube when its turn comes.
pub fn track(w: &Wanted, site: &str) -> Track {
    let tidy = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let query = tidy(&format!("{} {} audio", w.artist, w.title));
    Track {
        title: clip(&tidy(&w.title), 200),
        artist: Some(tidy(&w.artist)).filter(|a| !a.is_empty()),
        seconds: w.seconds,
        source: "media".into(),
        search: Some(query),
        site: Some(site.to_string()),
        ..Default::default()
    }
}
/// A reading as tracks, and the list's name.
pub fn tracks(r: &Reading, site: &str) -> (Vec<Track>, Option<String>) {
    (r.songs.iter().map(|w| track(w, site)).collect(), if r.list { r.name.clone() } else { None })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(link: &str) -> Plan { plan(link).unwrap_or_else(|| panic!("no plan for {link}")) }

    #[test]
    fn every_service_link_is_told_what_to_fetch() {
        let s = p("https://open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT?si=abc");
        assert_eq!((s.site, s.how, s.list, s.fetch.as_str()), ("Spotify", How::SpotifyEmbed, false, "https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT"));
        assert!(p("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M").list && p("https://open.spotify.com/album/4LH4d3cOWNNsVw41Gqt2kv").list);
        assert_eq!(p("https://www.deezer.com/en/track/3135556").fetch, "https://api.deezer.com/track/3135556");
        assert_eq!(p("https://deezer.com/fr/playlist/1313621735").fetch, "https://api.deezer.com/playlist/1313621735");
        assert_eq!(p("https://www.deezer.com/artist/27").fetch, "https://api.deezer.com/artist/27/top?limit=50");
        // Apple: ?i= is a song inside an album, /album/ is the whole album, /song/ one song, /playlist/ is read from its page
        assert_eq!(p("https://music.apple.com/us/album/never-gonna-give-you-up/1559885420?i=1559885421").fetch, "https://itunes.apple.com/lookup?id=1559885421&country=us");
        assert_eq!(p("https://music.apple.com/gb/album/whenever-you-need-somebody/1559885420").fetch, "https://itunes.apple.com/lookup?id=1559885420&entity=song&country=gb");
        assert_eq!(p("https://music.apple.com/us/song/housewife/6822497774").fetch, "https://itunes.apple.com/lookup?id=6822497774&country=us");
        let pl = p("https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb?l=en");
        assert_eq!((pl.how, pl.fetch.as_str()), (How::ApplePlaylist, "https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb"));
        assert_eq!(p("https://www.pandora.com/artist/a/b/c/TRabc").how, How::Slug);
        for l in ["https://tidal.com/browse/track/123", "https://listen.tidal.com/album/9", "https://music.amazon.com/albums/B0", "https://music.amazon.co.uk/tracks/B0", "https://napster.com/artist/x", "https://www.qobuz.com/us-en/album/x/y", "https://www.shazam.com/track/1/x"] {
            assert_eq!(p(l).how, How::Page, "{l}");
        }
        // YouTube, SoundCloud and the rest go to yt-dlp, not here
        assert!(plan("https://www.youtube.com/watch?v=abc").is_none() && plan("https://soundcloud.com/a/b").is_none() && plan("not a link").is_none());
        // links that only redirect
        assert!(is_short("https://spotify.link/xyz") && is_short("https://link.deezer.com/s/abc") && is_short("https://pandora.app.link/x") && !is_short("https://open.spotify.com/track/abc"));
    }

    #[test]
    fn a_spotify_song_and_a_spotify_playlist_are_read_from_the_embed_page() {
        let wrap = |entity: &str| format!(r#"<html><script id="__NEXT_DATA__" type="application/json">{{"props":{{"pageProps":{{"state":{{"data":{{"entity":{entity}}}}}}}}}}}</script></html>"#);
        let one = spotify_embed(&wrap(r#"{"type":"track","name":"Never Gonna Give You Up","title":"Never Gonna Give You Up","artists":[{"name":"Rick Astley"}],"duration":213573}"#)).unwrap();
        assert_eq!(one.songs, vec![Wanted { title: "Never Gonna Give You Up".into(), artist: "Rick Astley".into(), seconds: Some(213) }]);
        assert!(!one.list);
        let many = spotify_embed(&wrap(r#"{"type":"playlist","name":"Today’s Top Hits","trackList":[{"title":"BbY WOW","subtitle":"KAROL G, Judeline","duration":225834,"isPlayable":true,"entityType":"track"},{"title":"Gone","subtitle":"X","isPlayable":false,"entityType":"track"},{"title":"An episode","subtitle":"Y","entityType":"episode"}]}"#)).unwrap();
        assert_eq!((many.name.as_deref(), many.list, many.songs.len()), (Some("Today’s Top Hits"), true, 1));
        assert_eq!((many.songs[0].artist.as_str(), many.songs[0].seconds), ("KAROL G", Some(225)));
        assert!(spotify_embed("<html>nothing</html>").is_none());
    }

    #[test]
    fn deezer_answers_for_songs_albums_playlists_and_artists() {
        let one = deezer(r#"{"id":3135556,"title":"Harder, Better, Faster, Stronger","duration":224,"artist":{"name":"Daft Punk"}}"#).unwrap();
        assert_eq!((one.songs[0].title.as_str(), one.songs[0].artist.as_str(), one.songs[0].seconds, one.list), ("Harder, Better, Faster, Stronger", "Daft Punk", Some(224), false));
        // an album's songs carry no artist of their own in some answers: the album's artist is used
        let album = deezer(r#"{"title":"Discovery","artist":{"name":"Daft Punk"},"tracks":{"data":[{"title":"One More Time","duration":320},{"title":"Aerodynamic","duration":212,"artist":{"name":"Daft Punk"}}]}}"#).unwrap();
        assert_eq!((album.name.as_deref(), album.songs.len(), album.songs[0].artist.as_str()), (Some("Discovery"), 2, "Daft Punk"));
        let top = deezer(r#"{"data":[{"title":"Get Lucky","duration":369,"artist":{"name":"Daft Punk"}}],"total":1}"#).unwrap();
        assert_eq!(top.songs.len(), 1);
        assert!(deezer(r#"{"error":{"type":"DataException","message":"no data","code":800}}"#).is_none());
    }

    #[test]
    fn apples_catalogue_gives_songs_and_albums() {
        let song_only = r#"{"resultCount":1,"results":[{"wrapperType":"track","kind":"song","artistName":"Rick Astley","trackName":"Never Gonna Give You Up","trackTimeMillis":213573}]}"#;
        let one = itunes(song_only).unwrap();
        assert_eq!((one.songs.len(), one.list, one.songs[0].seconds), (1, false, Some(213)));
        let album = r#"{"resultCount":3,"results":[{"wrapperType":"collection","collectionName":"Whenever You Need Somebody"},{"wrapperType":"track","kind":"song","artistName":"Rick Astley","trackName":"A","trackTimeMillis":1000},{"wrapperType":"track","kind":"song","artistName":"Rick Astley","trackName":"B","trackTimeMillis":2000}]}"#;
        let r = itunes(album).unwrap();
        assert_eq!((r.name.as_deref(), r.list, r.songs.len()), (Some("Whenever You Need Somebody"), true, 2));
        // a playlist page lists its songs' numbers; they are looked up together
        let html = r#"<script>{"url":"https://music.apple.com/us/song/housewife/6822497774"},{"url":"https://music.apple.com/us/song/other/111"},{"url":"https://music.apple.com/us/song/housewife/6822497774"}</script>"#;
        let ids = apple_song_ids(html);
        assert_eq!(ids, vec!["6822497774".to_string(), "111".to_string()]);
        assert_eq!(apple_lookup(&ids, "us"), "https://itunes.apple.com/lookup?id=6822497774,111&country=us");
    }

    #[test]
    fn a_pandora_link_names_its_song_in_its_own_words() {
        let r = pandora_slug("https://www.pandora.com/artist/rick-astley/whenever-you-need-somebody/never-gonna-give-you-up/TRqdvbXPj5mm5pP").unwrap();
        assert_eq!((r.songs[0].title.as_str(), r.songs[0].artist.as_str()), ("never gonna give you up", "rick astley"));
        let album = pandora_slug("https://www.pandora.com/artist/rick-astley/whenever-you-need-somebody/ALabc12345").unwrap();
        assert_eq!(album.songs[0].title, "whenever you need somebody");
        let artist = pandora_slug("https://www.pandora.com/artist/rick-astley/ARpXkx6zvg4jXX4").unwrap();
        assert_eq!((artist.songs[0].title.as_str(), artist.songs[0].artist.as_str()), ("rick astley", "rick astley"));
        assert!(pandora_slug("https://www.pandora.com/station/play/123").is_none());
    }

    #[test]
    fn a_pages_own_description_is_used_before_its_title() {
        let album = r#"<script type="application/ld+json">{"@type":"MusicAlbum","name":"Discovery","byArtist":{"@type":"MusicGroup","name":"Daft Punk"},"track":[{"@type":"MusicRecording","name":"One More Time","duration":"PT5M20S"},{"@type":"MusicRecording","name":"Aerodynamic","byArtist":[{"name":"A"},{"name":"B"}]}]}</script>"#;
        let r = page(album).unwrap();
        assert_eq!((r.name.as_deref(), r.songs.len(), r.songs[0].artist.as_str(), r.songs[0].seconds, r.songs[1].artist.as_str()), (Some("Discovery"), 2, "Daft Punk", Some(320), "A, B"));
        let song = r#"<script type="application/ld+json">{"@type":"MusicRecording","name":"Get Lucky","byArtist":"Daft Punk","duration":"PT6M9S"}</script>"#;
        assert_eq!(page(song).unwrap().songs[0], Wanted { title: "Get Lucky".into(), artist: "Daft Punk".into(), seconds: Some(369) });
        // no structured data: the title, with the service's name taken off
        let t = r#"<meta property="og:title" content="Never Gonna Give You Up by Rick Astley on Apple Music">"#;
        assert_eq!(page(t).unwrap().songs[0], Wanted { title: "Never Gonna Give You Up".into(), artist: "Rick Astley".into(), seconds: None });
        // content before property, and a <title> when there is no og:title
        assert_eq!(page(r#"<meta content="Song by Band | TIDAL" property="og:title">"#).unwrap().songs[0].artist, "Band");
        assert_eq!(page("<title>Some Song - Single by Some Band | Spotify</title>").unwrap().songs[0].title, "Some Song");
        assert!(page("<html></html>").is_none());
    }

    #[test]
    fn titles_lose_the_service_name_and_keep_the_song() {
        for (raw, title, artist) in [
            ("Never Gonna Give You Up by Rick Astley on Apple Music", "Never Gonna Give You Up", "Rick Astley"),
            ("Song by Artist on Amazon Music", "Song", "Artist"),
            ("Track – Single by Band | Pandora", "Track", "Band"),
            ("Just A Name | Napster", "Just A Name", ""),
            ("Daft Punk - Get Lucky", "Daft Punk - Get Lucky", ""),
        ] {
            let w = from_title(raw).unwrap();
            assert_eq!((w.title.as_str(), w.artist.as_str()), (title, artist), "{raw}");
        }
        assert!(from_title("   ").is_none());
    }

    #[test]
    fn iso_durations_become_seconds() {
        assert_eq!((iso_seconds("PT3M28S"), iso_seconds("PT1H2M3S"), iso_seconds("PT45S"), iso_seconds("nonsense"), iso_seconds("PT0S")), (Some(208), Some(3723), Some(45), None, None));
    }

    #[test]
    fn a_wanted_song_is_played_by_finding_it_on_youtube() {
        let t = track(&Wanted { title: "Get Lucky".into(), artist: "Daft  Punk".into(), seconds: Some(369) }, "Spotify");
        assert_eq!((t.source.as_str(), t.search.as_deref(), t.site.as_deref(), t.artist.as_deref(), t.seconds), ("media", Some("Daft Punk Get Lucky audio"), Some("Spotify"), Some("Daft Punk"), Some(369)));
        assert!(t.savable().is_some(), "it can be kept in a playlist");
        let (list, name) = tracks(&Reading { name: Some("Mix".into()), songs: vec![Wanted { title: "A".into(), ..Default::default() }, Wanted { title: "B".into(), ..Default::default() }], list: true }, "Deezer");
        assert_eq!((list.len(), name.as_deref()), (2, Some("Mix")));
        // a single song has no list name
        assert_eq!(tracks(&Reading { name: Some("x".into()), songs: vec![Wanted { title: "A".into(), ..Default::default() }], list: false }, "Deezer").1, None);
    }

    #[test]
    fn reading_something_empty_says_so_in_plain_words() {
        let plan = p("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT");
        let why = read(&plan, "", "<html></html>").unwrap_err();
        assert!(why.contains("Spotify") && why.contains("public"), "{why}");
        let long = (0..400).map(|n| format!(r#"{{"title":"S{n}","subtitle":"A","isPlayable":true,"entityType":"track"}}"#)).collect::<Vec<_>>().join(",");
        let html = format!(r#"<script id="__NEXT_DATA__">{{"props":{{"pageProps":{{"state":{{"data":{{"entity":{{"name":"Big","trackList":[{long}]}}}}}}}}}}}}</script>"#);
        assert_eq!(read(&plan, "", &html).unwrap().songs.len(), MOST);
    }
}
