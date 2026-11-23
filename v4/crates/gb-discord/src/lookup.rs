//! Looking songs up with yt-dlp: a link, a playlist link or a search by name. The voice layer uses it when someone
//! asks for a song in Discord, and the launcher's Music page uses it to search and to import playlists.
use crate::voice::run;
use gb_core::music::Track;
use std::path::Path;
use std::time::Duration;

fn name() -> &'static str {
    if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" }
}
/// Where yt-dlp is: YTDLP_PATH, the bot's own copy in `tools`, or one installed on the computer. Downloads the bot's
/// own copy when there is none.
pub async fn find_ytdlp(web: &reqwest::Client, tools: &Path) -> Result<String, String> {
    let own = tools.join(name());
    let tries = [std::env::var("YTDLP_PATH").ok(), Some(own.to_string_lossy().into_owned()), Some(name().to_string())];
    for bin in tries.into_iter().flatten() {
        if (bin.contains('/') || bin.contains('\\')) && !Path::new(&bin).exists() { continue; }
        if let Ok((0, _, _)) = run(&bin, &["--version"], 15).await { return Ok(bin); }
    }
    let file = if cfg!(windows) { "yt-dlp.exe" } else if cfg!(target_os = "macos") { "yt-dlp_macos" } else if cfg!(target_os = "linux") { "yt-dlp_linux" } else {
        return Err("yt-dlp has no ready-made program for this computer. Install it yourself and restart.".into());
    };
    let fail = || "Couldn't download yt-dlp from GitHub. Check the internet connection and try again.".to_string();
    let r = web.get(format!("https://github.com/yt-dlp/yt-dlp/releases/latest/download/{file}")).timeout(Duration::from_secs(120)).send().await.map_err(|_| fail())?;
    if !r.status().is_success() { return Err(fail()); }
    let body = r.bytes().await.map_err(|_| fail())?;
    if body.len() < 500_000 { return Err("The yt-dlp download looks broken. Try again in a minute.".into()); }
    std::fs::create_dir_all(tools).map_err(|e| e.to_string())?;
    std::fs::write(&own, &body).map_err(|e| format!("yt-dlp could not be saved ({e})"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(&own, std::fs::Permissions::from_mode(0o755));
    }
    Ok(own.to_string_lossy().into_owned())
}
/// Looks a song up: a link, a playlist link, or a search by name. Songs come back in the order found.
pub async fn resolve(web: &reqwest::Client, tools: &Path, query: &str) -> Result<Vec<Track>, String> {
    lookup(web, tools, query, 1).await.map(|(songs, _)| songs)
}
/// For the launcher's Music page: a search by name gives up to `count` songs to choose from; a link gives the song
/// or the whole playlist (and its name, when the site says). Makes its own connection, so it needs no bot running.
pub async fn search_songs(tools: &Path, query: &str, count: usize) -> Result<(Vec<Track>, Option<String>), String> {
    lookup(&reqwest::Client::new(), tools, query, count).await
}
/// The one lookup both use. Links to music services that cannot be played directly (Spotify, Apple Music, Deezer,
/// Pandora, Tidal, Amazon Music...) are read for the songs they name, and each is found on YouTube when it plays.
/// Everything else goes to yt-dlp, and a page it does not know is read for the song it names.
async fn lookup(web: &reqwest::Client, tools: &Path, query: &str, count: usize) -> Result<(Vec<Track>, Option<String>), String> {
    let q: String = query.replace(['\r', '\n'], " ").trim().chars().take(500).collect();
    if q.is_empty() { return Err("Type a link or a song's name.".into()); }
    let link = q.starts_with("https://") || q.starts_with("http://");
    if link {
        if let Some(found) = crate::links::read(web, &q).await? { return Ok(found); }
    }
    let bin = find_ytdlp(web, tools).await?;
    let lower = q.to_lowercase();
    let list = link && (lower.contains("list=") || lower.contains("/sets/") || lower.contains("/playlist") || lower.contains("/album/"));
    let search = format!("ytsearch{}:{q}", count.clamp(1, 25));
    let args: Vec<&str> = if !link {
        vec!["-J", "--flat-playlist", "--no-warnings", &search]
    } else if list {
        vec!["-J", "--flat-playlist", "--no-warnings", "--playlist-end", "100", &q]
    } else {
        vec!["-J", "--no-playlist", "--no-warnings", "--skip-download", "-f", "bestaudio/best", &q]
    };
    let (code, out, err) = run(&bin, &args, if list { 90 } else { 45 }).await?;
    if code != 0 {
        // a site yt-dlp does not know: its page may still say which song it is
        if link && err.to_lowercase().contains("unsupported url") {
            if let Some(found) = crate::links::read_page(web, &q).await { return Ok(found); }
        }
        return Err(if link { gb_core::music::ytdlp_refusal(&err) } else { "The search did not work right now. Try again in a minute.".into() });
    }
    let j: serde_json::Value = serde_json::from_str(&out).map_err(|_| "Couldn't read that link's details.".to_string())?;
    let name = j["title"].as_str().filter(|t| list && !t.is_empty()).map(str::to_string);
    Ok((gb_core::music::tracks_from_ytdlp(&j, 100)?, name))
}
