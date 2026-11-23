//! Fetching for the integrations module: feeds and live checks, only from public internet addresses, with a size
//! cap and a time limit (Good Boy 3's fetchText rules).

use gb_core::integrations::{feed_url, looks_like_feed, parse_feed, FeedItem};
use serde_json::Value;
use std::net::IpAddr;
use std::sync::Mutex;

/// The bot owner's Twitch app: (id, secret, token, token good until).
pub static TWITCH: Mutex<(String, String, String, i64)> = Mutex::new((String::new(), String::new(), String::new(), 0));

fn private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => v.is_private() || v.is_loopback() || v.is_link_local() || v.is_unspecified() || v.is_broadcast() || v.octets()[0] == 100 && (64..128).contains(&v.octets()[1]) || v.octets()[0] == 0,
        IpAddr::V6(v) => v.is_loopback() || v.is_unspecified() || (v.segments()[0] & 0xfe00) == 0xfc00 || (v.segments()[0] & 0xffc0) == 0xfe80 || v.to_ipv4_mapped().is_some_and(|m| private_ip(IpAddr::V4(m))),
    }
}
/// Refuses addresses on this computer or the local network.
async fn safe(url: &str) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(url).map_err(|_| "That is not a valid URL.".to_string())?;
    if !matches!(u.scheme(), "http" | "https") { return Err("Only http and https addresses work.".into()); }
    let host = u.host_str().ok_or("That is not a valid URL.")?.to_string();
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".local") || host.ends_with(".internal") { return Err("That address is on a private network.".into()); }
    let port = u.port_or_known_default().unwrap_or(443);
    let addrs: Vec<_> = tokio::net::lookup_host((host.as_str(), port)).await.map_err(|_| "I couldn't find that address.".to_string())?.collect();
    if addrs.is_empty() || addrs.iter().any(|a| private_ip(a.ip())) { return Err("That address is on a private network.".into()); }
    Ok(u)
}
pub async fn text(web: &reqwest::Client, url: &str, max: usize) -> Result<String, String> {
    let u = safe(url).await?;
    let r = tokio::time::timeout(std::time::Duration::from_secs(10), web.get(u).send()).await.map_err(|_| "The server didn't answer in time.".to_string())?.map_err(|_| "I couldn't reach that server.".to_string())?;
    if !r.status().is_success() { return Err(format!("The server answered {}.", r.status().as_u16())); }
    let b = tokio::time::timeout(std::time::Duration::from_secs(10), r.bytes()).await.map_err(|_| "The server didn't answer in time.".to_string())?.map_err(|_| "The answer was cut off.".to_string())?;
    if b.len() > max { return Err("That response is too large.".into()); }
    Ok(String::from_utf8_lossy(&b).into_owned())
}
async fn feed(web: &reqwest::Client, url: &str) -> Result<Vec<FeedItem>, String> {
    let xml = text(web, url, 2_000_000).await?;
    let items = parse_feed(&xml);
    if items.is_empty() && !looks_like_feed(&xml) { return Err("That doesn't look like an RSS/Atom feed.".into()); }
    Ok(items)
}
async fn twitch_token(web: &reqwest::Client) -> Result<(String, String), String> {
    let (id, secret, token, until) = TWITCH.lock().unwrap().clone();
    if id.is_empty() || secret.is_empty() { return Err("Twitch alerts need the bot owner to add Twitch keys first: `/feed twitch-keys` (free from dev.twitch.tv/console).".into()); }
    let now = crate::now_ms();
    if !token.is_empty() && now < until { return Ok((id, token)); }
    let r = web.post("https://id.twitch.tv/oauth2/token").query(&[("client_id", id.as_str()), ("client_secret", secret.as_str()), ("grant_type", "client_credentials")]).timeout(std::time::Duration::from_secs(10)).send().await.ok();
    let d: Option<Value> = match r { Some(r) if r.status().is_success() => r.json().await.ok(), _ => None };
    let Some(t) = d.as_ref().and_then(|d| d["access_token"].as_str()).map(str::to_string) else { return Err("Twitch didn't accept the bot's Twitch keys. The bot owner can enter them again with `/feed twitch-keys`.".into()) };
    let secs = d.as_ref().and_then(|d| d["expires_in"].as_i64()).unwrap_or(3600);
    *TWITCH.lock().unwrap() = (id.clone(), secret, t.clone(), now + (secs - 120).max(60) * 1000);
    Ok((id, t))
}
async fn twitch_live(web: &reqwest::Client, login: &str) -> Result<Vec<FeedItem>, String> {
    let (id, token) = twitch_token(web).await?;
    let r = web.get("https://api.twitch.tv/helix/streams").query(&[("user_login", login)]).header("Client-Id", id).bearer_auth(token).timeout(std::time::Duration::from_secs(10)).send().await.map_err(|_| "Twitch didn't answer.".to_string())?;
    if r.status().as_u16() == 401 { TWITCH.lock().unwrap().2.clear(); return Err("Twitch asked for new keys. Try again in a minute.".into()); }
    if !r.status().is_success() { return Err("Twitch didn't answer.".into()); }
    let d: Value = r.json().await.map_err(|_| "Twitch didn't answer.".to_string())?;
    Ok(d["data"].as_array().cloned().unwrap_or_default().iter().map(|st| FeedItem {
        id: format!("live-{}", st["id"].as_str().unwrap_or("")),
        title: format!("🔴 {} is live: {}", st["user_name"].as_str().unwrap_or(login), st["title"].as_str().filter(|t| !t.is_empty()).unwrap_or("streaming now")),
        url: format!("https://twitch.tv/{}", st["user_login"].as_str().unwrap_or(login)),
        author: st["game_name"].as_str().filter(|g| !g.is_empty()).or(st["user_name"].as_str()).unwrap_or("").to_string(),
    }).collect())
}
async fn bluesky(web: &reqwest::Client, handle: &str) -> Result<Vec<FeedItem>, String> {
    let r = web.get("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed").query(&[("actor", handle), ("limit", "10"), ("filter", "posts_no_replies")]).timeout(std::time::Duration::from_secs(10)).send().await.map_err(|_| "Bluesky didn't answer.".to_string())?;
    if r.status().as_u16() == 400 { return Err("That Bluesky account doesn't exist.".into()); }
    if !r.status().is_success() { return Err("Bluesky didn't answer.".into()); }
    let d: Value = r.json().await.map_err(|_| "Bluesky didn't answer.".to_string())?;
    Ok(d["feed"].as_array().cloned().unwrap_or_default().iter().filter(|x| x["reason"].is_null() && x["post"]["author"]["handle"].as_str().is_some_and(|h| h.eq_ignore_ascii_case(handle))).map(|x| {
        let uri = x["post"]["uri"].as_str().unwrap_or("").to_string();
        let h = x["post"]["author"]["handle"].as_str().unwrap_or(handle);
        let text: String = x["post"]["record"]["text"].as_str().filter(|t| !t.is_empty()).unwrap_or("New post").chars().take(200).collect();
        FeedItem { url: format!("https://bsky.app/profile/{h}/post/{}", uri.rsplit('/').next().unwrap_or("")), id: uri, title: text, author: x["post"]["author"]["displayName"].as_str().filter(|n| !n.is_empty()).unwrap_or(h).to_string() }
    }).collect())
}
async fn kick(web: &reqwest::Client, slug: &str) -> Result<Vec<FeedItem>, String> {
    let r = web.get(format!("https://kick.com/api/v2/channels/{slug}")).header("User-Agent", "Mozilla/5.0 (compatible; GoodBoyBot)").header("Accept", "application/json").timeout(std::time::Duration::from_secs(10)).send().await.map_err(|_| "Kick didn't answer (it sometimes blocks bots; it will be tried again).".to_string())?;
    if r.status().as_u16() == 404 { return Err("That Kick channel doesn't exist.".into()); }
    if !r.status().is_success() { return Err("Kick didn't answer (it sometimes blocks bots; it will be tried again).".into()); }
    let d: Value = r.json().await.unwrap_or(Value::Null);
    let ls = &d["livestream"];
    if !ls["is_live"].as_bool().unwrap_or(false) { return Ok(Vec::new()); }
    let user = d["user"]["username"].as_str().unwrap_or(slug);
    Ok(vec![FeedItem { id: format!("kick-{}", ls["id"]), title: format!("🟢 {user} is live on Kick: {}", ls["session_title"].as_str().filter(|t| !t.is_empty()).unwrap_or("streaming now")), url: format!("https://kick.com/{}", d["slug"].as_str().unwrap_or(slug)), author: ls["categories"][0]["name"].as_str().unwrap_or(user).to_string() }])
}
/// A provider's items right now.
pub async fn items(web: &reqwest::Client, provider: &str, target: &str) -> Result<Vec<FeedItem>, String> {
    match provider {
        "twitch" => twitch_live(web, target).await,
        "bluesky" => bluesky(web, target).await,
        "kick" => kick(web, target).await,
        p => match feed_url(p, target) { Some(u) => feed(web, &u).await, None => Err("Unknown provider.".into()) },
    }
}
/// Finishes what needed looking up: a YouTube @handle's channel ID; Twitch and Bluesky are checked to exist.
pub async fn resolve(web: &reqwest::Client, provider: &str, lookup: &str) -> Result<String, String> {
    match provider {
        "youtube" => {
            let html = text(web, &format!("https://www.youtube.com/{lookup}"), 6_000_000).await?;
            let find = |key: &str| html.find(key).map(|i| html[i + key.len()..].chars().take(24).collect::<String>()).filter(|id| id.len() == 24 && id.starts_with("UC"));
            find("\"channelId\":\"").or_else(|| find("channel/")).ok_or_else(|| "I couldn't find that channel. Try its channel ID instead.".to_string())
        }
        "twitch" => { twitch_token(web).await?; Ok(lookup.to_string()) }
        "bluesky" => { bluesky(web, lookup).await?; Ok(lookup.to_string()) }
        _ => Ok(lookup.to_string()),
    }
}
/// The bot owner's Twitch keys: tried once before they are kept.
pub async fn set_twitch(web: &reqwest::Client, id: &str, secret: &str) -> Result<(), String> {
    let before = TWITCH.lock().unwrap().clone();
    *TWITCH.lock().unwrap() = (id.to_string(), secret.to_string(), String::new(), 0);
    match twitch_token(web).await { Ok(_) => Ok(()), Err(e) => { *TWITCH.lock().unwrap() = before; Err(e) } }
}
