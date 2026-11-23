//! Links to music services (Spotify, Apple Music, Deezer, Pandora, Tidal, Amazon Music and the like): the pages are
//! fetched here and understood by `gb_core::streaming`. Each song is then found on YouTube when its turn comes.
use gb_core::music::Track;
use gb_core::streaming::{self as s, How, Plan};
use std::time::Duration;

const AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/// Only public web addresses: never the computer's own or a private network's.
fn public(link: &str) -> bool {
    let Some(rest) = link.strip_prefix("https://").or_else(|| link.strip_prefix("http://")) else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("").rsplit('@').next().unwrap_or("").split(':').next().unwrap_or("").to_ascii_lowercase();
    !(host.is_empty() || host == "localhost" || host.ends_with(".local") || host.ends_with(".internal") || host.starts_with("127.") || host.starts_with("10.") || host.starts_with("192.168.") || host.starts_with("169.254.") || host == "0.0.0.0" || host.starts_with('[')
        || (host.starts_with("172.") && host.split('.').nth(1).and_then(|n| n.parse::<u8>().ok()).is_some_and(|n| (16..=31).contains(&n))))
}
async fn get(web: &reqwest::Client, url: &str, cap: usize) -> Option<String> {
    let r = web.get(url).header("User-Agent", AGENT).header("Accept-Language", "en").timeout(Duration::from_secs(15)).send().await.ok()?;
    // a redirect may not lead somewhere private either
    if !public(r.url().as_str()) || !r.status().is_success() { return None; }
    let bytes = r.bytes().await.ok()?;
    Some(String::from_utf8_lossy(&bytes[..bytes.len().min(cap)]).into_owned())
}
/// Where a share link leads.
async fn follow(web: &reqwest::Client, link: &str) -> String {
    match web.get(link).header("User-Agent", AGENT).timeout(Duration::from_secs(15)).send().await {
        Ok(r) if public(r.url().as_str()) => r.url().to_string(),
        _ => link.to_string(),
    }
}
fn tracks_of(r: &s::Reading, site: &str) -> (Vec<Track>, Option<String>) { s::tracks(r, site) }

/// A link to a music service, as songs (and the list's name). Ok(None) when the link is not one of those services;
/// an Err says in plain words why it could not be read.
pub async fn read(web: &reqwest::Client, link: &str) -> Result<Option<(Vec<Track>, Option<String>)>, String> {
    let link = link.trim();
    if !public(link) { return Ok(None); }
    let link = if s::is_short(link) { follow(web, link).await } else { link.to_string() };
    let Some(plan) = s::plan(&link) else { return Ok(None) };
    let reading = fetch(web, &plan, &link).await?;
    Ok(Some(tracks_of(&reading, plan.site)))
}
async fn fetch(web: &reqwest::Client, plan: &Plan, link: &str) -> Result<s::Reading, String> {
    let sorry = || format!("Couldn't reach {} just now. Check the internet connection and the link, then try again.", plan.site);
    match plan.how {
        How::Slug => s::read(plan, link, ""),
        How::ApplePlaylist => {
            let html = get(web, &plan.fetch, 6_000_000).await.ok_or_else(sorry)?;
            let ids = s::apple_song_ids(&html);
            if ids.is_empty() { return Err(format!("Couldn't read that {} playlist. Check that it is public and try again.", plan.site)); }
            let cc = link.split('/').nth(3).filter(|c| c.len() == 2).unwrap_or("us");
            // Apple answers up to 200 songs at once
            let mut songs = Vec::new();
            for chunk in ids.chunks(150) {
                let answer = get(web, &s::apple_lookup(chunk, cc), 4_000_000).await.ok_or_else(sorry)?;
                let part = s::read(&Plan { how: How::Itunes, ..plan.clone() }, link, &answer)?;
                songs.extend(part.songs);
            }
            Ok(s::Reading { name: s::apple_playlist_name(&html), songs, list: true })
        }
        _ => {
            let body = get(web, &plan.fetch, 6_000_000).await.ok_or_else(sorry)?;
            s::read(plan, link, &body)
        }
    }
}
/// Any other page that names a song (a service not listed above, or a site yt-dlp does not know). Reads the page's
/// own description of the song, or its title, and finds the song that way.
pub async fn read_page(web: &reqwest::Client, link: &str) -> Option<(Vec<Track>, Option<String>)> {
    if !public(link) { return None; }
    let html = get(web, link, 3_000_000).await?;
    let r = s::page(&html)?;
    let host = link.split("//").nth(1).and_then(|h| h.split('/').next()).unwrap_or("the web").trim_start_matches("www.").to_string();
    Some(tracks_of(&r, &host))
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Real services, real pages. Run by hand: `cargo test -p gb-discord --lib live_services -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn live_services() {
        let web = reqwest::Client::new();
        for (link, least) in [
            ("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", 1),
            ("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", 20),
            ("https://open.spotify.com/album/4LH4d3cOWNNsVw41Gqt2kv", 5),
            ("https://www.deezer.com/en/track/3135556", 1),
            ("https://www.deezer.com/en/album/302127", 5),
            ("https://www.deezer.com/en/playlist/1313621735", 20),
            ("https://music.apple.com/us/album/never-gonna-give-you-up/1559885420?i=1559885421", 1),
            ("https://music.apple.com/us/album/whenever-you-need-somebody/1559885420", 5),
            ("https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb", 20),
            ("https://www.pandora.com/artist/rick-astley/whenever-you-need-somebody/never-gonna-give-you-up/TRqdvbXPj5mm5pP", 1),
        ] {
            let got = read(&web, link).await;
            match got {
                Ok(Some((songs, name))) => { println!("OK   {link}\n     {} songs, list {:?}, first {:?} / {:?}", songs.len(), name, songs[0].title, songs[0].search); assert!(songs.len() >= least, "{link}: {} songs", songs.len()); }
                other => panic!("{link}: {other:?}"),
            }
        }
    }
    #[test]
    fn only_public_addresses_are_fetched() {
        for ok in ["https://open.spotify.com/track/abc", "http://example.com/a", "https://172.15.0.1/x", "https://172.32.0.1/x"] { assert!(public(ok), "{ok}"); }
        for bad in ["http://localhost:8080/x", "https://127.0.0.1/x", "http://10.0.0.5/a", "http://192.168.1.2/a", "http://169.254.169.254/latest", "https://172.16.0.1/x", "https://172.31.255.1/x", "http://[::1]/x", "ftp://example.com/x", "https://user@127.0.0.1/", "file:///etc/passwd", "https://thing.local/x", ""] { assert!(!public(bad), "{bad}"); }
    }
}
