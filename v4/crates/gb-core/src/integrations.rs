//! Good Boy 3's integrations: follow RSS/Atom feeds, YouTube channels, GitHub releases/commits/tags, subreddits,
//! Twitch and Kick live streams, Bluesky and Mastodon accounts in a channel (`/feed`); Minecraft server status
//! (`/minecraft`); and inbound webhooks that post into a channel (`/webhook`). New items only, never old ones.
//! The Discord layer does the fetching (only to public addresses); this keeps the rules, data and wording.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::store::Data;
use crate::{Action, Area, Card, CommandEvent, Db, Def, Field, FormEvent, Kind, Settings};
use serde_json::{json, Value};

pub const MODULE: &str = "integrations";
pub const MANAGE: Perm = Perm { key: "integrations.manage", level: Level::Admin };
pub const USE: Perm = Perm { key: "integrations.use", level: Level::Everyone };
pub static SETTINGS: &[Def] = &[Def { key: "pollMinutes", label: "Check feeds every N minutes", kind: Kind::Number { min: 5, max: 120 }, default: Fallback::Int(10) }];
const MAX_SUBS: usize = 15;
const MAX_HOOKS: usize = 10;
/// (provider, what it follows)
pub const PROVIDERS: &[(&str, &str)] = &[
    ("rss", "RSS / Atom feed URL"), ("youtube", "YouTube channel (ID, URL or @handle)"), ("github", "GitHub repo: owner/name[:releases|commits|tags]"),
    ("reddit", "Subreddit: r/name"), ("twitch", "Twitch channel: name or twitch.tv link (live alerts)"), ("bluesky", "Bluesky account: handle like name.bsky.social"),
    ("kick", "Kick channel: name or kick.com link (live alerts)"), ("mastodon", "Mastodon account: @name@server"),
];
const PROVIDER_CHOICES: &[(&str, &str)] = &[("rss - RSS / Atom feed", "rss"), ("youtube - YouTube channel", "youtube"), ("github - GitHub repo", "github"), ("reddit - Subreddit", "reddit"), ("twitch - Twitch live alerts", "twitch"), ("bluesky - Bluesky account", "bluesky"), ("kick - Kick live alerts", "kick"), ("mastodon - Mastodon account", "mastodon")];
const NUM: Takes = Takes::Whole { min: 1, max: 1_000_000 };
pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec { name: "feed", about: "Follow feeds in a channel", module: MODULE, options: &[], subs: &[
        Sub { name: "add", about: "Follow something", options: &[
            Opt { name: "provider", about: "rss, youtube, github, reddit, twitch, bluesky, kick, mastodon…", takes: Takes::Choice(PROVIDER_CHOICES), required: true },
            Opt { name: "target", about: "URL, channel, owner/repo or r/subreddit", takes: Takes::Text, required: true },
            Opt { name: "channel", about: "Where to post", takes: Takes::Channel, required: true },
            Opt { name: "message", about: "Template: {title} {url} {author}", takes: Takes::Text, required: false },
        ] },
        Sub { name: "remove", about: "Stop following", options: &[Opt { name: "id", about: "Feed number", takes: NUM, required: true }] },
        Sub { name: "list", about: "Show feeds", options: &[] },
        Sub { name: "check", about: "Check all feeds now", options: &[] },
        Sub { name: "twitch-keys", about: "(Bot owner) Add Twitch keys for live alerts", options: &[] },
    ] },
    CommandSpec { name: "minecraft", about: "Minecraft server status", module: MODULE, options: &[Opt { name: "address", about: "e.g. play.example.com", takes: Takes::Text, required: true }], subs: &[] },
    CommandSpec { name: "webhook", about: "Inbound webhooks that post into a channel", module: MODULE, options: &[], subs: &[
        Sub { name: "create", about: "Create a webhook URL", options: &[
            Opt { name: "name", about: "Label shown in the footer", takes: Takes::Text, required: true },
            Opt { name: "channel", about: "Where it posts", takes: Takes::Channel, required: true },
        ] },
        Sub { name: "list", about: "Show webhooks", options: &[] },
        Sub { name: "delete", about: "Delete a webhook", options: &[Opt { name: "id", about: "Webhook number", takes: NUM, required: true }] },
    ] },
];

/// One new thing from a feed.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FeedItem {
    pub id: String,
    pub title: String,
    pub url: String,
    pub author: String,
}

// ------------------------------------------------------------------ feed text (Good Boy 3's minimal parser)
fn decode(s: &str) -> String {
    let mut t = s.to_string();
    while let Some(a) = t.find("<![CDATA[") { let Some(b) = t[a..].find("]]>") else { break }; let inner = t[a + 9..a + b].to_string(); t.replace_range(a..a + b + 3, &inner); }
    let mut out = String::new();
    let mut inside = false;
    for c in t.chars() { match c { '<' => inside = true, '>' if inside => inside = false, _ if !inside => out.push(c), _ => {} } }
    out.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#039;", "'").replace("&#39;", "'").replace("&apos;", "'").replace("&amp;", "&").trim().to_string()
}
fn open_tag_end(block: &str, name: &str, from: usize) -> Option<(usize, usize)> {
    let low = block.to_lowercase();
    let mut at = from;
    loop {
        let i = low[at..].find(&format!("<{name}"))? + at;
        let after = low.as_bytes().get(i + 1 + name.len()).copied();
        if matches!(after, Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') | Some(b'/')) {
            let end = low[i..].find('>')? + i;
            return Some((i, end + 1));
        }
        at = i + 1;
    }
}
fn tag(block: &str, name: &str) -> String {
    let Some((_, start)) = open_tag_end(block, name, 0) else { return String::new() };
    let low = block.to_lowercase();
    let Some(close) = low[start..].find(&format!("</{name}>")) else { return String::new() };
    decode(&block[start..start + close])
}
fn attr(t: &str, name: &str) -> Option<String> {
    let low = t.to_lowercase();
    let i = low.find(&format!("{name}="))? + name.len() + 1;
    let q = t[i..].chars().next()?;
    if q != '"' && q != '\'' { return None; }
    let end = t[i + 1..].find(q)? + i + 1;
    Some(t[i + 1..end].to_string())
}
fn blocks<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let low = xml.to_lowercase();
    let mut out = Vec::new();
    let mut at = 0;
    while let Some((s, _)) = open_tag_end(xml, name, at) {
        let Some(e) = low[s..].find(&format!("</{name}>")) else { break };
        out.push(&xml[s..s + e + name.len() + 3]);
        at = s + e + 1;
    }
    out
}
/// RSS or Atom text → items with an id and a web link (Good Boy 3's parseFeed).
pub fn parse_feed(xml: &str) -> Vec<FeedItem> {
    let atom = open_tag_end(xml, "feed", 0).is_some();
    blocks(xml, if atom { "entry" } else { "item" }).into_iter().map(|b| {
        let url = if atom {
            let mut found = String::new();
            let mut at = 0;
            while let Some((s, e)) = open_tag_end(b, "link", at) {
                let t = &b[s..e];
                let rel = attr(t, "rel");
                if let Some(h) = attr(t, "href") { if rel.as_deref().is_none_or(|r| r == "alternate") { found = decode(&h); break; } }
                at = e;
            }
            found
        } else { tag(b, "link") };
        let id = Some(tag(b, if atom { "id" } else { "guid" })).filter(|x| !x.is_empty()).unwrap_or_else(|| url.clone());
        let author = [tag(b, "name"), tag(b, "dc:creator"), tag(b, "author")].into_iter().find(|x| !x.is_empty()).unwrap_or_default();
        FeedItem { id, title: Some(tag(b, "title")).filter(|t| !t.is_empty()).unwrap_or_else(|| "(untitled)".into()), url, author }
    }).filter(|x| !x.id.is_empty() && (x.url.starts_with("http://") || x.url.starts_with("https://") || x.url.starts_with("HTTP"))).collect()
}
/// Whether text is a feed at all (an empty one is still a feed).
pub fn looks_like_feed(xml: &str) -> bool {
    let low = xml.to_lowercase();
    low.contains("<rss") || low.contains("<feed") || low.contains("<rdf")
}
/// "{title} by {author}" with the values filled in; unknown names stay as they are (Good Boy 3's fillTemplate).
pub fn fill_template(tpl: &str, vars: &[(&str, &str)]) -> String {
    let mut out = String::new();
    let mut rest = tpl;
    while let Some(a) = rest.find('{') {
        out.push_str(&rest[..a]);
        let after = &rest[a + 1..];
        match after.find('}') {
            Some(b) if after[..b].chars().all(|c| c.is_alphanumeric() || c == '_') && !after[..b].is_empty() => {
                let k = &after[..b];
                match vars.iter().find(|v| v.0 == k) { Some(v) => out.push_str(v.1), None => { out.push('{'); out.push_str(k); out.push('}'); } }
                rest = &after[b + 1..];
            }
            _ => { out.push('{'); rest = after; }
        }
    }
    out.push_str(rest);
    out
}
fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}

// ------------------------------------------------------------------ what people type (checked here, looked up there)
/// The first check of what was typed for a provider: Ok(target) when nothing needs looking up, or Err(why not).
/// YouTube handles, Twitch and Bluesky are finished by the Discord layer.
pub fn resolve_local(provider: &str, raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    let word = |s: &str, ok: &dyn Fn(char) -> bool, lo: usize, hi: usize| (lo..=hi).contains(&s.chars().count()) && s.chars().all(ok);
    let strip = |s: &str, prefixes: &[&str]| { let mut t = s; for p in prefixes { if let Some(r) = t.strip_prefix(p) { t = r; break; } } t.trim_end_matches('/').to_string() };
    match provider {
        "rss" => { if (raw.starts_with("http://") || raw.starts_with("https://")) && raw.len() > 10 && !raw.contains(char::is_whitespace) { Ok(raw.to_string()) } else { Err("That is not a valid URL.".into()) } }
        "youtube" => {
            if let Some(at) = raw.find("UC") { let id: String = raw[at..].chars().take(24).collect(); if id.len() == 24 && id[2..].chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') { return Ok(id); } }
            let h = strip(raw, &["https://www.youtube.com/", "https://youtube.com/", "http://www.youtube.com/", "http://youtube.com/"]);
            if h.starts_with('@') && word(&h[1..], &|c| c.is_ascii_alphanumeric() || "_.-".contains(c), 3, 40) { Err(format!("@lookup:{h}")) } else { Err("Give a channel ID (UC…), a channel URL, or an @handle.".into()) }
        }
        "github" => {
            let (repo, kind) = raw.split_once(':').map(|(r, k)| (r, Some(k))).unwrap_or((raw, None));
            let Some((o, n)) = repo.split_once('/') else { return Err("Use `owner/repo` or `owner/repo:commits`.".into()) };
            let ok = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-';
            if !word(o, &ok, 1, 39) || !word(n, &ok, 1, 100) || kind.is_some_and(|k| !["releases", "commits", "tags"].contains(&k)) { return Err("Use `owner/repo` or `owner/repo:commits`.".into()); }
            Ok(format!("{o}/{n}:{}", kind.unwrap_or("releases")))
        }
        "reddit" => {
            let s = raw.trim_start_matches('/').trim_start_matches("r/");
            if word(s, &|c| c.is_ascii_alphanumeric() || c == '_', 2, 21) { Ok(s.to_string()) } else { Err("Use a subreddit like `r/gaming`.".into()) }
        }
        "twitch" => {
            let s = strip(raw, &["https://www.twitch.tv/", "https://twitch.tv/", "http://www.twitch.tv/", "http://twitch.tv/"]);
            if word(&s, &|c| c.is_ascii_alphanumeric() || c == '_', 3, 25) { Err(format!("@lookup:{}", s.to_lowercase())) } else { Err("Use a Twitch name like `ninja` or a twitch.tv link.".into()) }
        }
        "bluesky" => {
            let s = strip(raw, &["https://bsky.app/profile/"]);
            let s = s.trim_start_matches('@');
            let tld_ok = s.rsplit_once('.').is_some_and(|(a, t)| !a.is_empty() && t.len() >= 2 && t.chars().all(|c| c.is_ascii_alphabetic()));
            if tld_ok && word(s, &|c| c.is_ascii_alphanumeric() || c == '.' || c == '-', 4, 253) { Err(format!("@lookup:{}", s.to_lowercase())) } else { Err("Use a Bluesky handle like `name.bsky.social` or a bsky.app profile link.".into()) }
        }
        "kick" => {
            let s = strip(raw, &["https://www.kick.com/", "https://kick.com/", "http://kick.com/"]);
            if word(&s, &|c| c.is_ascii_alphanumeric() || c == '_' || c == '-', 2, 30) { Ok(s.to_lowercase()) } else { Err("Use a Kick name like `xqc` or a kick.com link.".into()) }
        }
        "mastodon" => {
            let (user, server) = if let Some(rest) = raw.strip_prefix("https://").or_else(|| raw.strip_prefix("http://")) {
                let (server, path) = rest.split_once("/@").unwrap_or(("", ""));
                (path.trim_end_matches('/').to_string(), server.to_string())
            } else {
                let t = raw.trim_start_matches('@');
                let (u, s) = t.split_once('@').unwrap_or(("", ""));
                (u.to_string(), s.to_string())
            };
            let server_ok = server.rsplit_once('.').is_some_and(|(a, t)| !a.is_empty() && t.len() >= 2) && server.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
            if word(&user, &|c| c.is_ascii_alphanumeric() || c == '_', 1, 30) && server_ok { Ok(format!("{user}@{}", server.to_lowercase())) } else { Err("Use a Mastodon address like `@name@mastodon.social`.".into()) }
        }
        _ => Err(format!("Unknown provider. Available: {}", PROVIDERS.iter().map(|p| p.0).collect::<Vec<_>>().join(", "))),
    }
}
/// The address of a provider's feed, for the ones that are plain feeds (None: looked up another way).
pub fn feed_url(provider: &str, target: &str) -> Option<String> {
    match provider {
        "rss" => Some(target.to_string()),
        "youtube" => Some(format!("https://www.youtube.com/feeds/videos.xml?channel_id={target}")),
        "github" => { let (repo, kind) = target.split_once(':').unwrap_or((target, "releases")); Some(format!("https://github.com/{repo}/{kind}.atom")) }
        "reddit" => Some(format!("https://www.reddit.com/r/{target}/new/.rss")),
        "mastodon" => { let (u, s) = target.split_once('@')?; Some(format!("https://{s}/@{u}.rss")) }
        _ => None,
    }
}

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
/// SHA-256 of a webhook's secret part (only that is kept), as hex.
pub fn sha_hex(s: &str) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

pub struct Integrations<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub guild: &'a str,
}
impl Integrations<'_> {
    fn data(&self) -> Data<'_> {
        Data { db: self.db, guild: self.guild, module: MODULE }
    }
    fn subs(&self) -> Vec<(String, Value)> {
        self.data().list("sub:")
    }
    fn next(&self, key: &str) -> i64 {
        let n = self.data().get(key).and_then(|v| v.as_i64()).unwrap_or(0) + 1;
        self.data().set(key, &json!(n));
        n
    }

    pub fn command(&self, ev: &CommandEvent, bot_owner: Option<&str>, random: &dyn Fn() -> String) -> Vec<Action> {
        let arg = |k: &str| ev.args.get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        if ev.name == "minecraft" {
            if !perms::allowed(self.db, self.guild, &ev.member, USE) { return private(format!("You don't have permission for that (`{}`).", USE.key)); }
            let addr = arg("address").unwrap_or_default();
            let (host, port) = addr.split_once(':').map(|(h, p)| (h, Some(p))).unwrap_or((addr.as_str(), None));
            let ok = (3..=253).contains(&host.len()) && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') && port.is_none_or(|p| (1..=5).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()));
            if !ok { return private("That does not look like a server address."); }
            return vec![Action::Fetch(Box::new(Fetch::Minecraft { address: addr }))];
        }
        if !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private(format!("You don't have permission for that (`{}`).", MANAGE.key)); }
        if ev.name == "webhook" {
            let hooks = self.data().list("hook:");
            return match ev.sub.as_deref().unwrap_or("list") {
                "list" => private(if hooks.is_empty() { "No webhooks.".to_string() } else { hooks.iter().map(|(_, h)| format!("**#{}** {} → <#{}>", h["id"], h["name"].as_str().unwrap_or(""), h["channelId"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n") }),
                "delete" => {
                    let id = arg("id").and_then(|i| i.parse::<i64>().ok()).unwrap_or(0);
                    match hooks.iter().find(|(_, h)| h["id"].as_i64() == Some(id)) { Some((k, _)) => { self.data().delete(k); private(format!("Deleted webhook #{id}.")) } None => private("No webhook with that number.") }
                }
                _ => {
                    if hooks.len() >= MAX_HOOKS { return private(format!("Up to {MAX_HOOKS} webhooks per server.")); }
                    let Some(channel) = arg("channel") else { return private("Pick a text channel.") };
                    let token = random();
                    let id = self.next("hookCounter");
                    self.data().set(&format!("hook:{}", sha_hex(&token)), &json!({ "id": id, "name": short(&arg("name").unwrap_or_default(), 60), "channelId": channel, "by": ev.member.id }));
                    private(format!("Webhook **#{id}** created. **Copy this now - it is never shown again:**\n`{{address}}/hooks/{}/{token}`\nPOST JSON like `{{\"title\":\"Hi\",\"description\":\"Hello\"}}` or `{{\"content\":\"text\"}}`.\n*This address only works from this computer unless you expose the bot's web port to the internet.*", self.guild))
                }
            };
        }
        match ev.sub.as_deref().unwrap_or("list") {
            "twitch-keys" => {
                if bot_owner != Some(ev.member.id.as_str()) { return private("Only the person who runs this bot can set the Twitch keys."); }
                vec![Action::Form { id: "feedtw:keys".into(), title: "Twitch keys (for live alerts)".into(), fields: vec![
                    Field { id: "id".into(), label: "Client ID".into(), max: 60, required: true, ..Default::default() },
                    Field { id: "secret".into(), label: "Client secret".into(), max: 60, required: true, ..Default::default() },
                ] }]
            }
            "list" => {
                let rows: Vec<String> = self.subs().iter().map(|(_, s)| format!("**#{}** {} · `{}` → <#{}>{}", s["id"], s["provider"].as_str().unwrap_or(""), short(s["target"].as_str().unwrap_or(""), 60), s["channelId"].as_str().unwrap_or(""), match s["failures"].as_i64().unwrap_or(0) { 0 => String::new(), n => format!(" ⚠️ {n} failure(s)") })).collect();
                private(if rows.is_empty() { "No feeds yet. Add one with `/feed add`.".to_string() } else { rows.join("\n") })
            }
            "remove" => {
                let id = arg("id").unwrap_or_default();
                let key = format!("sub:{id}");
                if self.data().get(&key).is_none() { return private("No feed with that number."); }
                self.data().delete(&key);
                private(format!("Removed feed #{id}."))
            }
            "check" => {
                let subs = self.subs();
                let mut out = private(format!("Checked {} feed(s).", subs.len()));
                out.extend(subs.into_iter().map(|(k, s)| self.poll_action(&k, &s, ev.at_ms)));
                out
            }
            _ => {
                let provider = arg("provider").unwrap_or_default().to_lowercase();
                if !PROVIDERS.iter().any(|p| p.0 == provider) { return private(format!("Unknown provider. Available: {}", PROVIDERS.iter().map(|p| p.0).collect::<Vec<_>>().join(", "))); }
                if self.subs().len() >= MAX_SUBS { return private(format!("Up to {MAX_SUBS} feeds per server.")); }
                let Some(channel) = arg("channel") else { return private("Pick a text channel.") };
                let raw = arg("target").unwrap_or_default();
                let target = match resolve_local(&provider, &raw) { Ok(t) => Some(t), Err(e) if e.starts_with("@lookup:") => None, Err(why) => return private(why) };
                let lookup = resolve_local(&provider, &raw).err().and_then(|e| e.strip_prefix("@lookup:").map(str::to_string));
                vec![Action::Fetch(Box::new(Fetch::Add { provider, target, lookup, channel, template: arg("message").map(|m| short(&m, 300)), by: ev.member.id.clone() }))]
            }
        }
    }
    /// The Discord layer found what a new feed points at and its items right now: it is kept, starting from now.
    #[allow(clippy::too_many_arguments)]
    pub fn added(&self, provider: &str, target: &str, channel: &str, template: Option<&str>, by: &str, items: Result<Vec<FeedItem>, String>, now: i64) -> Card {
        let items = match items { Ok(i) => i, Err(why) => return Card::new(Area::General).line(why).private() };
        if self.subs().len() >= MAX_SUBS { return Card::new(Area::General).line(format!("Up to {MAX_SUBS} feeds per server.")).private(); }
        let id = self.next("subCounter");
        let seen: Vec<String> = items.iter().map(|x| x.id.clone()).take(60).collect();
        self.data().set(&format!("sub:{id}"), &json!({ "id": id, "provider": provider, "target": target, "channelId": channel, "template": template, "seen": seen, "failures": 0, "lastPoll": now, "by": by }));
        Card::new(Area::General).line(format!("Following **{provider}** `{}` in <#{channel}> (feed #{id}). New items only - I won't repost old ones.", short(target, 80))).private()
    }
    fn poll_action(&self, key: &str, s: &Value, now: i64) -> Action {
        // marked as being checked now, so the next tick doesn't ask again while this one is out
        let mut next = s.clone();
        next["lastPoll"] = json!(now);
        self.data().set(key, &next);
        Action::Fetch(Box::new(Fetch::Poll { key: key.into(), provider: s["provider"].as_str().unwrap_or("").into(), target: s["target"].as_str().unwrap_or("").into() }))
    }
    /// Feeds due a check (every `pollMinutes`).
    pub fn due(&self, now: i64) -> Vec<Action> {
        let every = self.settings.int(self.guild, MODULE, "pollMinutes") * 60_000;
        self.subs().into_iter().filter(|(_, s)| now - s["lastPoll"].as_i64().unwrap_or(0) >= every).map(|(k, s)| self.poll_action(&k, &s, now)).collect()
    }
    /// What a check found: new items are posted (at most 5, oldest first); failures back off up to 30 minutes and
    /// a feed that keeps failing (30 times) is removed.
    pub fn polled(&self, key: &str, items: Result<Vec<FeedItem>, String>, now: i64) -> Vec<Action> {
        let Some(mut s) = self.data().get(key) else { return Vec::new() };
        let mut out = Vec::new();
        match items {
            Ok(items) => {
                let seen: Vec<String> = serde_json::from_value(s["seen"].clone()).unwrap_or_default();
                if !seen.is_empty() {
                    let fresh: Vec<&FeedItem> = items.iter().filter(|x| !seen.contains(&x.id)).take(5).collect();
                    let tpl = s["template"].as_str().filter(|t| !t.is_empty()).unwrap_or("**{title}**\n{url}").to_string();
                    let provider = s["provider"].as_str().unwrap_or("").to_string();
                    for item in fresh.into_iter().rev() {
                        let title = short(&item.title, 200);
                        let text = fill_template(&tpl, &[("title", &title), ("url", &item.url), ("author", &item.author), ("provider", &provider)]);
                        out.push(Action::SendText { channel: s["channelId"].as_str().unwrap_or("").into(), text: short(&text, 1900), ping: Vec::new(), roles: Vec::new(), video_from: None, note: None });
                    }
                }
                let mut all: Vec<String> = items.iter().map(|x| x.id.clone()).collect();
                for x in seen { if !all.contains(&x) { all.push(x); } }
                all.truncate(60);
                s["seen"] = json!(all);
                s["failures"] = json!(0);
                s["lastPoll"] = json!(now);
            }
            Err(_) => {
                let failures = s["failures"].as_i64().unwrap_or(0) + 1;
                if failures >= 30 { self.data().delete(key); return Vec::new(); }
                s["failures"] = json!(failures);
                s["lastPoll"] = json!(now + failures.min(6) * 300_000);
            }
        }
        self.data().set(key, &s);
        out
    }
    /// A webhook was called: its JSON is posted in its channel, or false when the address is wrong.
    pub fn webhook(&self, token: &str, body: &Value) -> Option<Action> {
        let hook = self.data().get(&format!("hook:{}", sha_hex(token)))?;
        let channel = hook["channelId"].as_str()?.to_string();
        let content = body["content"].as_str().map(|c| short(c, 1900));
        let (title, desc) = (body["title"].as_str(), body["description"].as_str());
        if content.is_none() && title.is_none() && desc.is_none() { return None; }
        let mut card = Card::new(Area::General);
        if let Some(c) = content { card = card.line(c); }
        if let Some(t) = title {
            let t = short(t, 250);
            let url = body["url"].as_str().filter(|u| u.starts_with("http://") || u.starts_with("https://"));
            card = card.title(match url { Some(u) => format!("[{t}]({u})"), None => t });
        }
        if let Some(d) = desc { card = card.line(short(d, 3800)); }
        card = card.line(format!("-# {}", short(hook["name"].as_str().unwrap_or(""), 80)));
        card.accent = Some(body["color"].as_i64().filter(|c| (0..=0xff_ffff).contains(c)).unwrap_or(0x5865f2) as u32);
        Some(Action::Send { channel, card, ping: Vec::new(), roles: Vec::new() })
    }
    /// The Twitch keys popup (bot owner): checked by the Discord layer, kept for every server.
    pub fn twitch_form(ev: &FormEvent, bot_owner: Option<&str>) -> Vec<Action> {
        if bot_owner != Some(ev.member.id.as_str()) { return private("Only the person who runs this bot can set the Twitch keys."); }
        let v = |k: &str| ev.values.get(k).map(|x| x.trim().to_string()).unwrap_or_default();
        vec![Action::Fetch(Box::new(Fetch::TwitchKeys { id: v("id"), secret: v("secret") }))]
    }
}

/// Something the Discord layer looks up on the internet for this module.
#[derive(Debug, Clone, PartialEq)]
pub enum Fetch {
    /// `/feed add`: finish the target (YouTube handle, Twitch, Bluesky), read its items, then `added`.
    Add { provider: String, target: Option<String>, lookup: Option<String>, channel: String, template: Option<String>, by: String },
    /// A feed's check: its items, then `polled`.
    Poll { key: String, provider: String, target: String },
    /// `/minecraft`: the server's status.
    Minecraft { address: String },
    /// The bot owner's Twitch app keys: tried once, then kept.
    TwitchKeys { id: String, secret: String },
}
/// The `/minecraft` answer (Good Boy 3's wording).
pub fn minecraft_card(address: &str, status: Result<Value, String>) -> Card {
    let data = match status { Ok(d) => d, Err(why) => return Card::new(Area::General).line(why) };
    let online = data["online"].as_bool().unwrap_or(false);
    let mut card = Card::new(Area::General).title(short(address, 100));
    card.accent = Some(if online { 0x57f287 } else { 0xed4245 });
    if !online { return card.line("🔴 Offline (or not reachable)."); }
    let motd: Vec<String> = data["motd"]["clean"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
    card.line(format!("🟢 Online\n{}", short(&motd.join("\n"), 300)))
        .line(format!("**Players** {} / {} · **Version** {}", data["players"]["online"].as_i64().unwrap_or(0), data["players"]["max"].as_i64().map(|m| m.to_string()).unwrap_or_else(|| "?".into()), short(data["version"].as_str().unwrap_or("?"), 60)))
}
