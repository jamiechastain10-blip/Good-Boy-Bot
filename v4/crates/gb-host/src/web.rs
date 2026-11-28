//! The dashboard on the web: the same screens as the launcher, served to a browser (and, as an installable web app, to
//! iPhone and Android). Everything here asks the same desk the launcher asks, after checking who is asking.
//!
//! Who may do what: people sign in with Discord. The person who runs the bot may do everything except handle secrets (tokens
//! and client secrets are never taken or shown over the web). Anyone else who has Manage Server in a server the bot is in
//! may manage that server only. People the owner lets in (the Access page) may manage the servers they were given. On a
//! bot Basic Ghost Labs hosts, support staff can come in with a pass from the site for an hour, to see the bot's health
//! and start, stop or restart it, and nothing else (see access.rs). Every change made here goes in the access log.
use crate::secrets::{self, Secret};
use crate::Desk;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const SESSION_DAYS: i64 = 30;
const MANAGE_GUILD: u64 = 1 << 5;
const ADMINISTRATOR: u64 = 1 << 3;
const COOKIE: &str = "gb_session";

/// Someone who has signed in.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Session {
    pub user: String,
    pub name: String,
    pub owner: bool,
    /// The servers they may manage (the owner may manage all of them).
    pub guilds: Vec<String>,
    /// Servers where they are ticket staff (they hold the tickets staff role) without managing the server: they may only
    /// use the Tickets page there.
    #[serde(default)]
    pub staff: Vec<String>,
    pub expires: i64,
    /// "support" for a Basic Ghost Labs support visit; "person" for someone the owner let in; otherwise empty.
    #[serde(default)]
    pub role: String,
}
impl Session {
    pub fn support(&self) -> bool { self.role == "support" }
    /// What the access log calls them.
    fn role_name(&self) -> &str { if self.support() { "support" } else if self.owner { "owner" } else if self.role == "person" { "let in" } else if self.guilds.is_empty() { "ticket staff" } else { "server manager" } }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
fn random_token() -> String {
    let mut b = [0u8; 32];
    getrandom::getrandom(&mut b).expect("the computer has no source of randomness");
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn digest(token: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(token.as_bytes()).iter().map(|x| format!("{x:02x}")).collect()
}

/// The web side: who is signed in (kept on disk, so a phone stays signed in), and the sign-in steps in progress.
pub struct Web {
    pub desk: Arc<Desk>,
    sessions: Mutex<HashMap<String, Session>>,
    states: Mutex<HashMap<String, i64>>,
    file: PathBuf,
    /// The public address people reach this at, such as https://dash.example.com (used for the Discord sign-in).
    pub address: String,
    http: reqwest::Client,
    /// Who else may come in, support visits, and the access log.
    pub access: crate::access::Access,
}

impl Web {
    pub fn new(desk: Arc<Desk>, address: &str) -> Arc<Web> {
        let access = crate::access::Access::open(&desk.folders.data, &|k| std::env::var(k).ok());
        Web::with_access(desk, address, access)
    }
    pub fn with_access(desk: Arc<Desk>, address: &str, access: crate::access::Access) -> Arc<Web> {
        let file = desk.folders.data.join("web-sessions.json");
        let loaded: HashMap<String, Session> = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let now = now_ms();
        let sessions = loaded.into_iter().filter(|(_, s)| s.expires > now).collect();
        Arc::new(Web { desk, sessions: Mutex::new(sessions), states: Mutex::new(HashMap::new()), file, address: address.trim_end_matches('/').to_string(), http: reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build().unwrap_or_default(), access })
    }
    fn save(&self, all: &HashMap<String, Session>) {
        if let Some(dir) = self.file.parent() { let _ = std::fs::create_dir_all(dir); }
        let tmp = self.file.with_extension("tmp");
        if std::fs::write(&tmp, serde_json::to_string(all).unwrap_or_default()).is_ok() { let _ = std::fs::rename(&tmp, &self.file); }
    }
    /// Signs someone in and gives the cookie value that proves it.
    pub fn sign_in(&self, who: Session) -> String {
        let token = random_token();
        let mut all = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let now = now_ms();
        all.retain(|_, s| s.expires > now);
        // a support visit keeps the end it was given (an hour); everyone else gets 30 days
        let expires = if who.support() { who.expires.min(now + crate::access::SUPPORT_VISIT_MS) } else { now + SESSION_DAYS * 86_400_000 };
        all.insert(digest(&token), Session { expires, ..who });
        self.save(&all);
        token
    }
    fn who(&self, headers: &HeaderMap) -> Option<Session> {
        let cookie = headers.get(header::COOKIE)?.to_str().ok()?;
        let token = cookie.split(';').filter_map(|p| p.trim().strip_prefix(&format!("{COOKIE}="))).next()?;
        let mut all = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let key = digest(token);
        let s = all.get(&key)?.clone();
        if s.expires <= now_ms() || (s.support() && !self.access.support_on()) { all.remove(&key); self.save(&all); return None; }
        if s.support() { return Some(s); }
        // a session that is used stays good: it runs out 30 days after the last time
        let fresh = now_ms() + SESSION_DAYS * 86_400_000;
        if fresh - s.expires > 86_400_000 { if let Some(m) = all.get_mut(&key) { m.expires = fresh; } self.save(&all); }
        Some(s)
    }
    /// Signs out everyone who matches (someone the owner just removed, or every support visit).
    pub fn sign_out_all(&self, which: impl Fn(&Session) -> bool) -> usize {
        let mut all = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let before = all.len();
        all.retain(|_, s| !which(s));
        let gone = before - all.len();
        if gone > 0 { self.save(&all); }
        gone
    }
    fn sign_out(&self, headers: &HeaderMap) {
        let Some(cookie) = headers.get(header::COOKIE).and_then(|c| c.to_str().ok()) else { return };
        if let Some(token) = cookie.split(';').filter_map(|p| p.trim().strip_prefix(&format!("{COOKIE}="))).next() {
            let mut all = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
            all.remove(&digest(token));
            self.save(&all);
        }
    }
}

// ---- what may be asked, by whom
/// Things only the person who runs the bot may do, and never from the web: they handle secrets or the computer itself.
const DESKTOP_ONLY: &[&str] = &["update_install", "setup_data", "token_test", "token_save", "token_forget", "helpers_list", "helper_add", "helper_remove", "secret_save", "secret_forget", "v3_status", "v3_folder_set", "v3_recopy", "v3_check", "backup_now", "open", "prefs_set", "licence_set", "licence_refresh", "brand_status", "brand_keep", "brand_custom"];
/// Things only the owner may do (over the web): start and stop the bot, and see how it is doing.
const OWNER_ONLY: &[&str] = &["bot_start", "bot_stop", "bot_restart", "announce_restart", "health"];
/// All that Basic Ghost Labs support may ask for on a hosted bot: how it is doing, start, stop, restart and updates.
/// Nothing that belongs to a server (every server-specific request is refused for them anyway, as they manage none).
const SUPPORT_CALLS: &[&str] = &["overview", "support_view", "health", "update_status", "update_check", "whatsnew", "bot_start", "bot_stop", "bot_restart", "announce_restart"];
/// The Access page: only the owner.
const ACCESS_CALLS: &[&str] = &["access_view", "access_add", "access_remove", "access_support_set"];
/// Requests that only look, which are not written in the access log (the screens ask for some of them every few seconds).
const LOOKS: &[&str] = &["overview", "servers", "pulse", "activity", "update_status", "whatsnew", "health", "settings", "dashboard", "cases", "tickets", "ticket_view", "ticket_transcript", "economy", "members_lookup", "members_search", "leavers", "inactive_view", "commands_view", "commands_guide", "directory", "images_view", "critters_view", "panel", "permissions", "role_menus", "shop", "boards", "panel_preview", "greeting_preview", "setup_view", "eclipse_view", "gallery_view", "access_view", "support_view", "music_api"];
/// All that ticket staff (who do not manage the server) may ask for: the tickets, and what the page needs to start.
const STAFF_CALLS: &[&str] = &["overview", "servers", "tickets", "ticket_view", "ticket_transcript", "ticket_action"];

fn text(a: &Value, k: &str) -> Result<String, String> {
    a.get(k).and_then(Value::as_str).map(str::to_string).ok_or_else(|| format!("Missing \"{k}\"."))
}
fn opt_text(a: &Value, k: &str) -> Option<String> { a.get(k).and_then(Value::as_str).map(str::to_string) }
fn int(a: &Value, k: &str) -> Option<i64> { a.get(k).and_then(Value::as_i64) }
fn flag(a: &Value, k: &str) -> Option<bool> { a.get(k).and_then(Value::as_bool) }
fn texts(a: &Value, k: &str) -> Vec<String> { a.get(k).and_then(Value::as_array).map(|l| l.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default() }

/// Everything the screens may ask for, for someone who is signed in. Mirrors the launcher's own commands.
pub async fn dispatch(web: &Web, who: &Session, name: &str, a: &Value) -> Result<Value, String> {
    let desk = web.desk.clone();
    if DESKTOP_ONLY.contains(&name) { return Err("That can only be done in the Good Boy app on the computer.".into()); }
    if who.support() {
        if !web.access.support_on() { return Err("The owner has turned Basic Ghost Labs support access off.".into()); }
        if !SUPPORT_CALLS.contains(&name) { return Err("Basic Ghost Labs support can see the bot's health and start, stop, restart or update it. Nothing about the servers, members, messages or settings.".into()); }
    } else if OWNER_ONLY.contains(&name) && !who.owner { return Err("Only the person who runs the bot can do that.".into()); }
    if ACCESS_CALLS.contains(&name) && (!who.owner || who.support()) { return Err("Only the person who runs the bot can change who comes in.".into()); }
    // every server-specific request must be for a server this person manages
    // someone who is only ticket staff may use the tickets and nothing else
    let staff_only = !who.owner && who.guilds.is_empty() && !who.support();
    if staff_only && !STAFF_CALLS.contains(&name) { return Err("You can use the Tickets page. The rest of the dashboard is for people who manage the server.".into()); }
    if let Some(g) = a.get("guild").and_then(Value::as_str) {
        let manages = who.owner || who.guilds.iter().any(|x| x == g);
        let staff_here = who.staff.iter().any(|x| x == g) && STAFF_CALLS.contains(&name);
        if !manages && !staff_here { return Err("You do not manage that server.".into()); }
    }
    let g = || text(a, "guild");
    let ok = |v: Value| Ok::<Value, String>(v);
    match name {
        "overview" => {
            let mut o = desk.overview();
            // what a browser is told: not where things are kept, not whether secrets exist
            if let Some(m) = o.as_object_mut() {
                for k in ["data_folder", "old_data", "secret_saved", "keeps_secrets", "secret_store"] { m.remove(k); }
                if let Some(p) = m.get_mut("prefs").and_then(Value::as_object_mut) { p.insert("setup_done".into(), json!(true)); p.insert("toured".into(), json!(true)); }
                m.insert("web".into(), json!({ "owner": who.owner, "name": who.name, "staff_only": staff_only, "support": who.support(), "hosted": web.access.hosted.is_some() }));
                // support sees how the bot is doing, not what it holds
                if who.support() { m.remove("licence"); }
            }
            ok(o)
        }
        "access_view" => ok(json!({
            "people": web.access.people(),
            "hosted": web.access.hosted.is_some(),
            "support_on": web.access.support_on(),
            "log": web.access.log(int(a, "most").unwrap_or(200).clamp(1, 1000) as usize),
        })),
        "access_add" => {
            let guilds = texts(a, "guilds");
            let ours = desk.guild_ids();
            if guilds.iter().any(|g| !ours.contains(g)) { return Err("The bot is not in one of those servers.".into()); }
            let p = web.access.add(&text(a, "user")?, &opt_text(a, "name").unwrap_or_default(), guilds)?;
            // they sign in again to get the new list
            web.sign_out_all(|s| s.user == p.user && !s.owner && !s.support());
            ok(json!(p))
        }
        "access_remove" => {
            let user = text(a, "user")?;
            let gone = web.access.remove(&user)?;
            web.sign_out_all(|s| s.user == user && !s.owner && !s.support());
            ok(json!(gone))
        }
        "access_support_set" => {
            let on = flag(a, "on").unwrap_or(false);
            if on && web.access.hosted.is_none() { return Err("This bot is not hosted by Basic Ghost Labs.".into()); }
            web.access.set_support(on)?;
            if !on { web.sign_out_all(Session::support); }
            ok(json!(on))
        }
        "support_view" => ok(json!({
            "support": who.support(),
            "name": who.name,
            "until": if who.support() { Some(who.expires) } else { None },
            "can": ["See the bot's health and check-up", "Start, stop and restart the bot", "Check for updates"],
            "cannot": ["See or change your servers, members, messages, tickets or settings", "See the bot token, client secret or licence key", "Let anyone else in"],
            "log": web.access.log(50).into_iter().filter(|l| l["role"] == "support").collect::<Vec<_>>(),
        })),
        "bot_start" => desk.start().map(|_| Value::Null),
        "bot_stop" => { desk.stop().await; ok(Value::Null) }
        "bot_restart" => desk.restart().await.map(|_| Value::Null),
        "whatsnew" => Ok(desk.whatsnew()),
        "update_status" => ok(desk.update_status()),
        "update_check" => desk.update_check().await,
        "announce_restart" => desk.announce_restart(int(a, "minutes").unwrap_or(5).clamp(1, 60) as u64).map(|n| json!(n)),
        "health" => ok(desk.health()),
        "servers" => {
            let mut v = desk.servers()?;
            if !who.owner { if let Some(l) = v.as_array_mut() { l.retain(|s| s["id"].as_str().is_some_and(|id| who.guilds.iter().chain(who.staff.iter()).any(|g| g == id))); } }
            ok(v)
        }
        "module_set" => desk.module_set(&g()?, &text(a, "module")?, flag(a, "on").unwrap_or(false)).map(|_| Value::Null),
        "settings" => desk.settings(&g()?, &text(a, "module")?),
        "off_channels_set" => desk.off_channels_set(&g()?, &text(a, "module")?, &texts(a, "channels")).map(|c| json!(c)),
        "setting_set" => desk.setting_set(&g()?, &text(a, "module")?, &text(a, "key")?, a.get("value").unwrap_or(&Value::Null)),
        "dashboard" => desk.dashboard(&g()?),
        "cases" => desk.cases(&g()?, int(a, "limit").unwrap_or(50).clamp(1, 500) as usize),
        "tickets" => desk.tickets_find(&g()?, int(a, "limit").unwrap_or(100).clamp(1, 500) as usize, a["find"].as_str()),
        "music_api" => desk.music_api(&g()?, &text(a, "kind")?, &text(a, "name")?, a.get("args").unwrap_or(&Value::Null), Some(who.user.as_str())).await,
        "inactive_scan" => desk.inactive_scan(&g()?, int(a, "days")).map(|_| Value::Null),
        "inactive_view" => desk.inactive_view(&g()?),
        "inactive_kick" => desk.inactive_kick(&g()?, texts(a, "ids"), int(a, "days")).map(|n| json!(n)),
        "inactive_keep" => desk.inactive_keep(&g()?, &text(a, "user")?, flag(a, "keep").unwrap_or(true)).map(|_| Value::Null),
        "economy" => desk.economy(&g()?),
        "treasury_add" => desk.treasury_add(&g()?, int(a, "amount").ok_or("Missing \"amount\".")?, &opt_text(a, "note").unwrap_or_default()).map(|n| json!(n)),
        "treasury_give" => desk.treasury_give(&g()?, &text(a, "user")?, int(a, "amount").ok_or("Missing \"amount\".")?, &text(a, "reason")?).map(|n| json!(n)),
        "members_lookup" => desk.members_lookup(&g()?, texts(a, "ids")),
        "members_search" => desk.members_search(&g()?, &opt_text(a, "q").unwrap_or_default(), flag(a, "bots").unwrap_or(false)),
        "leavers" => desk.leavers(&g()?, int(a, "days").unwrap_or(60), &opt_text(a, "q").unwrap_or_default()),
        "leaver_forget" => desk.leaver_forget(&g()?, &text(a, "user")?).map(|n| json!(n)),
        "ticket_action" => desk.ticket_action(&g()?, int(a, "number").ok_or("Missing \"number\".")?, &text(a, "what")?, &opt_text(a, "text").unwrap_or_default(), Some((who.user.as_str(), who.name.as_str()))).map(|s| json!(s)),
        "ticket_view" => desk.ticket_view(&g()?, int(a, "number").ok_or("Missing \"number\".")?),
        "ticket_transcript" => desk.ticket_transcript(&g()?, int(a, "number").ok_or("Missing \"number\".")?, flag(a, "html").unwrap_or(true)),
        "pulse" => desk.pulse(&g()?),
        "commands_view" => desk.commands_view(),
        "directory" => desk.directory_view(&g()?),
        "command_run" => { let values: std::collections::BTreeMap<String, String> = a.get("values").and_then(Value::as_object).map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect()).unwrap_or_default(); desk.command_run(&g()?, &text(a, "name")?, opt_text(a, "sub").as_deref(), &values) }
        "images_view" => desk.images_view(&g()?),
        "setup_view" => desk.setup_view(&g()?),
        "setup_run" => desk.setup_run(&g()?, &text(a, "step")?, &opt_text(a, "what").unwrap_or_default()).map(|_| Value::Null),
        "eclipse_view" => desk.eclipse_view(&g()?),
        "commands_guide" => Ok(desk.commands_guide()),
        "gallery_view" => desk.gallery_view(&g()?),
        "gallery_add" => desk.gallery_add(&g()?, &text(a, "name")?, &text(a, "data")?).map(Value::from),
        "gallery_rename" => desk.gallery_rename(&g()?, &text(a, "id")?, &text(a, "name")?).map(|_| Value::Null),
        "gallery_remove" => desk.gallery_remove(&g()?, &text(a, "id")?).map(|_| Value::Null),
        "gallery_use" => desk.gallery_use(&g()?, &text(a, "id")?, &text(a, "slot")?).map(|_| Value::Null),
        "gallery_stop" => desk.gallery_stop(&g()?, &text(a, "slot")?).map(|_| Value::Null),
        "greeting_preview" => desk.greeting_preview(&g()?, &text(a, "kind")?, &a["tried"]),
        "greeting_image_set" => desk.greeting_image_set(&g()?, &text(a, "kind")?, &text(a, "name")?, &text(a, "data")?).map(|_| Value::Null),
        "greeting_image_clear" => desk.greeting_image_clear(&g()?, &text(a, "kind")?).map(|_| Value::Null),
        "critters_view" => desk.critters_view(&g()?),
        "critter_save" => { let n = |k: &str| int(a, k).unwrap_or(50); desk.critter_save(&g()?, opt_text(a, "editing").as_deref(), &text(a, "name")?, &text(a, "element")?, &text(a, "rarity")?, [n("hp"), n("atk"), n("def"), n("spd")], &opt_text(a, "picture").unwrap_or_else(|| "keep".into()), &opt_text(a, "link").unwrap_or_default(), &opt_text(a, "file_name").unwrap_or_default(), &opt_text(a, "data").unwrap_or_default()).map(|s| json!(s)) }
        "critter_remove" => desk.critter_remove(&g()?, &text(a, "id")?).map(|s| json!(s)),
        "panel" => desk.panel(&g()?, &text(a, "panel")?),
        "panel_action" => desk.panel_action(&g()?, &text(a, "panel")?, &text(a, "row")?, &text(a, "action")?).map(|_| Value::Null),
        "permissions" => desk.permissions(&g()?),
        "permission_set" => desk.permission_set(&g()?, &text(a, "key")?, &texts(a, "roles")).map(|_| Value::Null),
        "role_menus" => desk.role_menus(&g()?),
        "role_menu_delete" => desk.role_menu_delete(&g()?, &text(a, "message")?).map(|_| Value::Null),
        "shop" => desk.shop(&g()?),
        "shop_save" => desk.shop_save(&g()?, &text(a, "name")?, int(a, "price").ok_or("Missing \"price\".")?, &opt_text(a, "emoji").unwrap_or_default(), opt_text(a, "role").as_deref(), int(a, "hours").unwrap_or(0), int(a, "stock"), &opt_text(a, "text").unwrap_or_default(), flag(a, "consumable").unwrap_or(false)).map(|s| json!(s)),
        "shop_remove" => desk.shop_remove(&g()?, &text(a, "id")?).map(|_| Value::Null),
        "boards" => desk.boards(&g()?, int(a, "limit").unwrap_or(10).clamp(1, 100) as usize),
        "staff_action" => desk.staff_action(&g()?, &text(a, "kind")?, &text(a, "user")?, &opt_text(a, "name").unwrap_or_default(), &text(a, "reason")?, opt_text(a, "duration").as_deref()).map(|s| json!(s)),
        "activity" => desk.activity(&g()?, a.get("sinceId").and_then(Value::as_u64).unwrap_or(0)),
        "economy_reset" => desk.economy_reset(&g()?).map(|n| json!(n)),
        "post_panel" => desk.post_panel(&g()?, &text(a, "module")?, &text(a, "channel")?, opt_text(a, "title").as_deref().filter(|t| !t.trim().is_empty()), opt_text(a, "text").as_deref().filter(|t| !t.trim().is_empty()), flag(a, "pin").unwrap_or(false)).map(|_| Value::Null),
        "panel_preview" => desk.panel_preview(&g()?, &text(a, "module")?, opt_text(a, "title").as_deref().filter(|t| !t.trim().is_empty()), opt_text(a, "text").as_deref().filter(|t| !t.trim().is_empty())),
        _ => Err("That is not something the web app can do.".into()),
    }
}

// ---- the web pages and the sign-in
type Shared = Arc<Web>;

fn json_error(code: StatusCode, text: &str) -> Response {
    (code, Json(json!({ "error": text }))).into_response()
}

async fn api(State(web): State<Shared>, Path(name): Path<String>, headers: HeaderMap, body: Option<Json<Value>>) -> Response {
    // a page on another site cannot set this header without the browser asking first, so this keeps other sites out
    if headers.get("x-gb").is_none() { return json_error(StatusCode::FORBIDDEN, "Not allowed."); }
    let Some(who) = web.who(&headers) else { return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Sign in with Discord first.", "signin": true }))).into_response() };
    let args = body.map(|b| b.0).unwrap_or(Value::Null);
    let done = dispatch(&web, &who, &name, &args).await;
    // every change goes in the access log, and everything support asks for; never what was typed
    let looks = LOOKS.contains(&name.as_str()) && !(name == "music_api" && args["kind"] == "action");
    if !looks || (who.support() && !["overview", "update_status", "support_view"].contains(&name.as_str())) {
        let what = if name.len() <= 40 && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') { name.as_str() } else { "unknown" };
        let detail = match what { "access_add" | "access_remove" => args["user"].as_str().unwrap_or("").to_string(), "access_support_set" => format!("{}", args["on"].as_bool().unwrap_or(false)), _ => String::new() };
        web.access.note(&who.user, &who.name, who.role_name(), what, args.get("guild").and_then(Value::as_str), done.is_ok(), &detail);
    }
    match done {
        Ok(v) => Json(json!({ "ok": true, "result": v })).into_response(),
        Err(e) => json_error(StatusCode::BAD_REQUEST, &e),
    }
}

async fn me(State(web): State<Shared>, headers: HeaderMap) -> Response {
    match web.who(&headers) {
        Some(s) => Json(json!({ "user": s.user, "name": s.name, "owner": s.owner, "support": s.support() })).into_response(),
        None => (StatusCode::UNAUTHORIZED, Json(json!({ "signin": true }))).into_response(),
    }
}

async fn logout(State(web): State<Shared>, headers: HeaderMap) -> Response {
    if headers.get("x-gb").is_none() { return json_error(StatusCode::FORBIDDEN, "Not allowed."); }
    web.sign_out(&headers);
    let mut r = Json(json!({ "ok": true })).into_response();
    r.headers_mut().insert(header::SET_COOKIE, cookie("", 0, &web.address).parse().unwrap_or(HeaderValue::from_static("")));
    r
}

fn cookie(value: &str, max_age: i64, address: &str) -> String {
    format!("{COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{}", if address.starts_with("https://") { "; Secure" } else { "" })
}

/// The first step of signing in: off to Discord.
async fn login(State(web): State<Shared>) -> Response {
    let Some(id) = web.bot_id().await else { return (StatusCode::SERVICE_UNAVAILABLE, "The bot has no token yet, so sign-in is not set up. Finish setup in the Good Boy app.").into_response() };
    if secrets::read(Secret::ClientSecret).is_none() { return (StatusCode::SERVICE_UNAVAILABLE, "Sign-in needs the client secret. Add it in the Good Boy app (Settings).").into_response(); }
    let state = random_token();
    {
        let mut s = web.states.lock().unwrap_or_else(|p| p.into_inner());
        let now = now_ms();
        s.retain(|_, t| now - *t < 10 * 60_000);
        s.insert(state.clone(), now);
    }
    let redirect = format!("{}/auth/callback", web.address);
    let url = format!("https://discord.com/oauth2/authorize?client_id={id}&response_type=code&scope=identify%20guilds&prompt=none&state={state}&redirect_uri={}", urlencode(&redirect));
    Redirect::to(&url).into_response()
}

#[derive(Deserialize)]
struct PassQuery { pass: Option<String> }

/// A Basic Ghost Labs support visit: the site sends staff here with a pass made for this one bot.
async fn maintain(State(web): State<Shared>, Query(q): Query<PassQuery>) -> Response {
    let back = |code: StatusCode, text: &str| secure((code, [(header::CACHE_CONTROL, "no-store")], text.to_string()).into_response());
    let Some(pass) = q.pass.filter(|p| p.len() < 4096) else { return back(StatusCode::BAD_REQUEST, "Open this from the Basic Ghost Labs site.") };
    match web.access.check_pass(&pass, now_ms()) {
        Ok(v) => {
            web.access.note(&v.staff, &v.name, "support", "support_sign_in", None, true, &v.reason);
            let value = web.sign_in(Session { user: v.staff.clone(), name: v.name.clone(), owner: false, guilds: Vec::new(), staff: Vec::new(), expires: v.until, role: "support".into() });
            let mut r = Redirect::to("/").into_response();
            r.headers_mut().insert(header::SET_COOKIE, cookie(&value, crate::access::SUPPORT_VISIT_MS / 1000, &web.address).parse().unwrap_or(HeaderValue::from_static("")));
            r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            secure(r)
        }
        Err(e) => {
            web.access.note("unknown", "unknown", "support", "support_sign_in", None, false, &e);
            back(StatusCode::FORBIDDEN, &e)
        }
    }
}

fn urlencode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[derive(Deserialize)]
struct Callback { code: Option<String>, state: Option<String>, error: Option<String> }

async fn callback(State(web): State<Shared>, Query(q): Query<Callback>) -> Response {
    let back = |text: &str| (StatusCode::BAD_REQUEST, format!("{text} Go back and press Sign in again.")).into_response();
    if q.error.is_some() { return back("Discord did not let you sign in."); }
    let (Some(code), Some(state)) = (q.code, q.state) else { return back("The sign-in was not finished.") };
    let fresh = { let mut s = web.states.lock().unwrap_or_else(|p| p.into_inner()); s.remove(&state).is_some_and(|t| now_ms() - t < 10 * 60_000) };
    if !fresh { return back("That sign-in took too long or was not started here.") }
    let Some(id) = web.bot_id().await else { return back("The bot has no token yet.") };
    let Some(secret) = secrets::read(Secret::ClientSecret) else { return back("Sign-in is not set up (no client secret).") };
    let redirect = format!("{}/auth/callback", web.address);
    let got: Result<Value, String> = async {
        let r = web.http.post("https://discord.com/api/v10/oauth2/token").form(&[("client_id", id.as_str()), ("client_secret", secret.as_str()), ("grant_type", "authorization_code"), ("code", code.as_str()), ("redirect_uri", redirect.as_str())]).send().await.map_err(|_| "Discord could not be reached.".to_string())?;
        if !r.status().is_success() { return Err("Discord refused the sign-in.".into()); }
        r.json().await.map_err(|_| "Discord's answer was not understood.".to_string())
    }.await;
    let token = match got { Ok(v) => v["access_token"].as_str().map(str::to_string), Err(e) => return back(&e) };
    let Some(token) = token else { return back("Discord did not give a sign-in.") };
    let get = |path: &str| { let http = web.http.clone(); let token = token.clone(); let path = path.to_string(); async move { http.get(format!("https://discord.com/api/v10{path}")).bearer_auth(token).send().await.ok()?.json::<Value>().await.ok() } };
    let (Some(user), Some(guilds)) = (get("/users/@me").await, get("/users/@me/guilds").await) else { return back("Discord did not say who you are.") };
    // people who manage a server, and (in servers they do not manage) the staff the tickets module knows
    let base = web.session_for(&user, &guilds);
    let (uid, uname) = (user["id"].as_str().unwrap_or("").to_string(), user["global_name"].as_str().or_else(|| user["username"].as_str()).unwrap_or("someone").to_string());
    let managed: Vec<String> = base.as_ref().map(|s| s.guilds.clone()).unwrap_or_default();
    let staff = if base.as_ref().is_some_and(|s| s.owner) || uid.is_empty() { Vec::new() } else { web.staff_guilds(&uid, &guilds, &managed).await };
    let Some(mut session) = base.or_else(|| (!staff.is_empty()).then(|| Session { user: uid, name: uname, owner: false, guilds: Vec::new(), staff: Vec::new(), expires: 0, role: String::new() })) else {
        return (StatusCode::FORBIDDEN, "This dashboard is for the person who runs the bot, for people with Manage Server in a server the bot is in, and for the ticket staff of those servers. That is not you.").into_response()
    };
    session.staff = staff;
    web.access.note(&session.user, &session.name, session.role_name(), "sign_in", None, true, "");
    let value = web.sign_in(session);
    let mut r = Redirect::to("/").into_response();
    r.headers_mut().insert(header::SET_COOKIE, cookie(&value, SESSION_DAYS * 86_400, &web.address).parse().unwrap_or(HeaderValue::from_static("")));
    r
}

impl Web {
    /// The bot's own id (its application id), from Discord, using the saved token.
    async fn bot_id(&self) -> Option<String> {
        self.desk.token_test(None).await.ok().and_then(|v| v["id"].as_str().map(str::to_string)).filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
    }
    /// Works out what a Discord user may do here, from who they are and the servers they manage. None: nothing.
    pub fn session_for(&self, user: &Value, guilds: &Value) -> Option<Session> {
        let id = user["id"].as_str()?.to_string();
        let name = user["global_name"].as_str().or_else(|| user["username"].as_str()).unwrap_or("someone").to_string();
        let owner = self.desk.owner_id().as_deref() == Some(id.as_str()) || self.access.owners.contains(&id);
        let ours: Vec<String> = self.desk.guild_ids();
        let mut manages: Vec<String> = guilds.as_array().map(|l| l.iter().filter(|g| g["owner"] == true || g["permissions"].as_str().and_then(|p| p.parse::<u64>().ok()).is_some_and(|p| p & (MANAGE_GUILD | ADMINISTRATOR) != 0)).filter_map(|g| g["id"].as_str().map(str::to_string)).filter(|g| ours.contains(g)).collect()).unwrap_or_default();
        // someone the owner let in gets the servers they were given (or every one), on top of the ones they manage
        let mut role = String::new();
        if let Some(p) = (!owner).then(|| self.access.person(&id)).flatten() {
            let given: Vec<String> = if p.guilds.is_empty() { ours.clone() } else { p.guilds.iter().filter(|g| ours.contains(g)).cloned().collect() };
            if !given.is_empty() { role = "person".into(); }
            for g in given { if !manages.contains(&g) { manages.push(g); } }
        }
        if !owner && manages.is_empty() { return None; }
        Some(Session { user: id, name, owner, guilds: if owner { ours } else { manages }, staff: Vec::new(), expires: 0, role })
    }
    /// The servers where this person holds the tickets staff role without managing the server. The bot asks Discord for
    /// their roles in each server they share with it; a server with no staff role set counts for nothing.
    pub async fn staff_guilds(&self, user: &str, guilds: &Value, already: &[String]) -> Vec<String> {
        let ours = self.desk.guild_ids();
        let mut found = Vec::new();
        for id in guilds.as_array().into_iter().flatten().filter_map(|g| g["id"].as_str()) {
            if !ours.iter().any(|g| g == id) || already.iter().any(|g| g == id) { continue; }
            let Some(role) = self.desk.ticket_staff_role(id) else { continue };
            if self.desk.member_roles(id, user).await.is_some_and(|roles| roles.contains(&role)) { found.push(id.to_string()); }
        }
        found
    }
}

// ---- the files
const FILES: &[(&str, &str, &[u8])] = &[
    ("/app.js", "text/javascript; charset=utf-8", include_bytes!("../../../launcher/ui/app.js")),
    ("/bridge.js", "text/javascript; charset=utf-8", include_bytes!("../../../launcher/ui/bridge.js")),
    ("/boot.js", "text/javascript; charset=utf-8", include_bytes!("../../../launcher/ui/boot.js")),
    ("/guide.js", "text/javascript; charset=utf-8", include_bytes!("../../../launcher/ui/guide.js")),
    ("/music.js", "text/javascript; charset=utf-8", include_bytes!("../../../launcher/ui/music.js")),
    ("/tour.js", "text/javascript; charset=utf-8", include_bytes!("../../../launcher/ui/tour.js")),
    ("/ui.css", "text/css; charset=utf-8", include_bytes!("../../../launcher/ui/ui.css")),
    ("/boot.css", "text/css; charset=utf-8", include_bytes!("../../../launcher/ui/boot.css")),
    ("/music.css", "text/css; charset=utf-8", include_bytes!("../../../launcher/ui/music.css")),
    ("/tour.css", "text/css; charset=utf-8", include_bytes!("../../../launcher/ui/tour.css")),
    ("/mascot.png", "image/png", include_bytes!("../../../launcher/ui/mascot.png")),
    ("/pixel.css", "text/css; charset=utf-8", include_bytes!("../../../launcher/ui/pixel.css")),
    ("/bgl.css", "text/css; charset=utf-8", include_bytes!("../../../launcher/ui/bgl.css")),
    ("/ctxmenu.css", "text/css; charset=utf-8", include_bytes!("../../../launcher/ui/ctxmenu.css")),
    ("/ctxmenu.js", "text/javascript; charset=utf-8", include_bytes!("../../../launcher/ui/ctxmenu.js")),
    ("/menu.js", "text/javascript; charset=utf-8", include_bytes!("../../../launcher/ui/menu.js")),
    ("/access.js", "text/javascript; charset=utf-8", include_bytes!("../../../launcher/ui/access.js")),
    ("/fonts/Figtree-400.ttf", "font/ttf", include_bytes!("../../../launcher/ui/fonts/Figtree-400.ttf")),
    ("/fonts/Figtree-500.ttf", "font/ttf", include_bytes!("../../../launcher/ui/fonts/Figtree-500.ttf")),
    ("/fonts/Figtree-600.ttf", "font/ttf", include_bytes!("../../../launcher/ui/fonts/Figtree-600.ttf")),
    ("/fonts/Figtree-700.ttf", "font/ttf", include_bytes!("../../../launcher/ui/fonts/Figtree-700.ttf")),
    ("/fonts/BowlbyOne-400.ttf", "font/ttf", include_bytes!("../../../launcher/ui/fonts/BowlbyOne-400.ttf")),
    ("/look.js", "text/javascript; charset=utf-8", include_bytes!("../../../launcher/ui/look.js")),
    ("/fonts/PressStart2P.woff2", "font/woff2", include_bytes!("../../../launcher/ui/fonts/PressStart2P.woff2")),
    ("/fonts/VT323.woff2", "font/woff2", include_bytes!("../../../launcher/ui/fonts/VT323.woff2")),
    ("/manifest.webmanifest", "application/manifest+json", include_bytes!("../../../launcher/ui/manifest.webmanifest")),
    ("/sw.js", "text/javascript; charset=utf-8", include_bytes!("../../../launcher/ui/sw.js")),
    ("/icon-192.png", "image/png", include_bytes!("../../../launcher/ui/icon-192.png")),
    ("/icon-512.png", "image/png", include_bytes!("../../../launcher/ui/icon-512.png")),
];
const INDEX: &str = include_str!("../../../launcher/ui/index.html");

fn secure(mut r: Response) -> Response {
    let h = r.headers_mut();
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    r
}

async fn page() -> Response {
    // the page says it is served by Good Boy, so the screens talk to this server instead of a pretend one
    let html = INDEX.replace("<head>", "<head>\n<meta name=\"gb-web\" content=\"1\">");
    secure(([(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-cache")], html).into_response())
}

async fn file(uri: axum::http::Uri) -> Response {
    let path = uri.path();
    match FILES.iter().find(|(p, _, _)| *p == path) {
        Some((_, kind, bytes)) => secure(([(header::CONTENT_TYPE, *kind), (header::CACHE_CONTROL, if path == "/sw.js" { "no-cache" } else { "public, max-age=3600" })], bytes.to_vec()).into_response()),
        None => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

/// The web app's routes.
pub fn router(web: Shared) -> Router {
    let mut r = Router::new().route("/", get(page)).route("/index.html", get(page))
        .route("/api/:name", post(api).layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024))).route("/auth/me", get(me)).route("/auth/login", get(login)).route("/auth/callback", get(callback)).route("/auth/logout", post(logout)).route("/auth/maintain", get(maintain));
    for (p, _, _) in FILES { r = r.route(p, get(file)); }
    r.with_state(web)
}

/// Serves the web app until the program stops. `bind_all`: listen to the network (a web host), not just this computer.
pub async fn serve(web: Shared, port: u16, bind_all: bool) -> Result<(), String> {
    let addr: std::net::SocketAddr = if bind_all { ([0, 0, 0, 0], port).into() } else { ([127, 0, 0, 1], port).into() };
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|e| if e.kind() == std::io::ErrorKind::AddrInUse { format!("Port {port} is already in use by another program.") } else { e.to_string() })?;
    axum::serve(listener, router(web)).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Folders;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn web(tmp: &std::path::Path) -> Arc<Web> {
        let desk = Arc::new(Desk::new(Folders { data: tmp.join("gb4"), old_app_data: Some(tmp.join("none")) }));
        desk.setup_data(false).unwrap();
        let bot = desk.bot().unwrap();
        bot.on_server("700000000000000001", "Ghost Town");
        bot.on_server("700000000000000002", "Other Place");
        bot.directory.set_bot_owner(Some("42".into()));
        Web::new(desk, "https://dash.example.com")
    }
    fn session(owner: bool, guilds: &[&str]) -> Session {
        Session { user: if owner { "42".into() } else { "7".into() }, name: "Basic".into(), owner, guilds: guilds.iter().map(|g| g.to_string()).collect(), staff: Vec::new(), expires: 0, role: String::new() }
    }
    async fn ask(app: &Router, method: &str, uri: &str, cookie: Option<&str>, body: Option<Value>, gb: bool) -> (StatusCode, Value, HeaderMap) {
        let mut req = axum::http::Request::builder().method(method).uri(uri);
        if let Some(c) = cookie { req = req.header(header::COOKIE, format!("{COOKIE}={c}")); }
        if gb { req = req.header("x-gb", "1"); }
        let req = if let Some(b) = body { req.header(header::CONTENT_TYPE, "application/json").body(axum::body::Body::from(b.to_string())).unwrap() } else { req.body(axum::body::Body::empty()).unwrap() };
        let resp = app.clone().oneshot(req).await.unwrap();
        let (status, headers) = (resp.status(), resp.headers().clone());
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))), headers)
    }

    #[tokio::test]
    async fn only_people_signed_in_can_ask_and_other_sites_cannot_ask_for_them() {
        let tmp = tempfile::tempdir().unwrap();
        let w = web(tmp.path());
        let app = router(w.clone());
        // nobody signed in
        let (code, body, _) = ask(&app, "POST", "/api/overview", None, None, true).await;
        assert_eq!((code, body["signin"].as_bool()), (StatusCode::UNAUTHORIZED, Some(true)));
        assert_eq!(ask(&app, "GET", "/auth/me", None, None, false).await.0, StatusCode::UNAUTHORIZED);
        // signed in, but a request without the header a browser only adds for this page is refused
        let cookie = w.sign_in(session(true, &["700000000000000001", "700000000000000002"]));
        assert_eq!(ask(&app, "POST", "/api/overview", Some(&cookie), None, false).await.0, StatusCode::FORBIDDEN);
        let (code, body, _) = ask(&app, "POST", "/api/overview", Some(&cookie), None, true).await;
        assert_eq!(code, StatusCode::OK, "{body}");
        let o = &body["result"];
        for secret in ["data_folder", "old_data", "secret_saved", "secret_store"] { assert!(o.get(secret).is_none(), "{secret} must not go to a browser"); }
        assert_eq!((o["web"]["owner"].as_bool(), o["prefs"]["setup_done"].as_bool()), (Some(true), Some(true)));
        // a wrong cookie is nobody
        assert_eq!(ask(&app, "POST", "/api/overview", Some("nonsense"), None, true).await.0, StatusCode::UNAUTHORIZED);
        // signing out ends it
        assert_eq!(ask(&app, "POST", "/auth/logout", Some(&cookie), None, true).await.0, StatusCode::OK);
        assert_eq!(ask(&app, "POST", "/api/overview", Some(&cookie), None, true).await.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_server_admin_gets_their_servers_only_and_nothing_that_handles_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        let w = web(tmp.path());
        let app = router(w.clone());
        let admin = w.sign_in(session(false, &["700000000000000001"]));
        let (_, body, _) = ask(&app, "POST", "/api/servers", Some(&admin), None, true).await;
        let ids: Vec<&str> = body["result"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["700000000000000001"], "their own server only");
        // their server works, another one is refused
        assert_eq!(ask(&app, "POST", "/api/economy", Some(&admin), Some(json!({ "guild": "700000000000000001" })), true).await.0, StatusCode::OK);
        let (code, body, _) = ask(&app, "POST", "/api/economy", Some(&admin), Some(json!({ "guild": "700000000000000002" })), true).await;
        assert_eq!(code, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("do not manage"));
        // only the owner may start and stop the bot; nobody may touch tokens from the web, not even the owner
        assert!(ask(&app, "POST", "/api/bot_stop", Some(&admin), None, true).await.1["error"].as_str().unwrap().contains("runs the bot"));
        let owner = w.sign_in(session(true, &["700000000000000001", "700000000000000002"]));
        for name in ["token_save", "token_forget", "secret_save", "helper_add", "open", "prefs_set", "v3_recopy"] {
            let (code, body, _) = ask(&app, "POST", &format!("/api/{name}"), Some(&owner), Some(json!({ "token": "x", "secret": "x" })), true).await;
            assert_eq!(code, StatusCode::BAD_REQUEST, "{name}");
            assert!(body["error"].as_str().unwrap().contains("on the computer"), "{name}: {body}");
        }
        assert_eq!(ask(&app, "POST", "/api/nonsense", Some(&owner), None, true).await.0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn the_pages_are_served_with_tight_headers_and_the_app_can_be_installed() {
        let tmp = tempfile::tempdir().unwrap();
        let app = router(web(tmp.path()));
        let (code, body, headers) = ask(&app, "GET", "/", None, None, false).await;
        assert_eq!(code, StatusCode::OK);
        assert!(body.as_str().unwrap().contains("name=\"gb-web\""), "the page says it is served by Good Boy");
        let csp = headers.get(header::CONTENT_SECURITY_POLICY).unwrap().to_str().unwrap();
        assert!(csp.contains("default-src 'self'") && csp.contains("frame-ancestors 'none'") && !csp.contains("unsafe-inline"));
        for (path, kind) in [("/app.js", "javascript"), ("/ui.css", "text/css"), ("/manifest.webmanifest", "manifest+json"), ("/sw.js", "javascript"), ("/icon-192.png", "image/png"), ("/icon-512.png", "image/png")] {
            let (code, _, h) = ask(&app, "GET", path, None, None, false).await;
            assert_eq!(code, StatusCode::OK, "{path}");
            assert!(h.get(header::CONTENT_TYPE).unwrap().to_str().unwrap().contains(kind), "{path}");
        }
        let (_, manifest, _) = ask(&app, "GET", "/manifest.webmanifest", None, None, false).await;
        assert!(manifest["display"] == "standalone" && manifest["icons"].as_array().unwrap().len() >= 2);
        assert_eq!(ask(&app, "GET", "/etc/passwd", None, None, false).await.0, StatusCode::NOT_FOUND);
        // the sign-in needs the bot's token and client secret; without them it says so instead of going to Discord
        assert_eq!(ask(&app, "GET", "/auth/login", None, None, false).await.0, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn who_may_come_in_follows_who_they_are_and_what_they_manage() {
        let tmp = tempfile::tempdir().unwrap();
        let w = web(tmp.path());
        let ours = |id: &str, owner: bool, perms: &str| json!([{ "id": id, "owner": owner, "permissions": perms }]);
        // the person who runs the bot: everything
        let s = w.session_for(&json!({ "id": "42", "username": "basic" }), &json!([])).unwrap();
        assert!(s.owner && s.guilds.len() == 2);
        // Manage Server in one of the bot's servers: that one
        let s = w.session_for(&json!({ "id": "7", "global_name": "Kai" }), &ours("700000000000000001", false, "32")).unwrap();
        assert!(!s.owner && s.guilds == ["700000000000000001"] && s.name == "Kai");
        // Administrator counts; the server's own owner counts
        assert!(w.session_for(&json!({ "id": "7" }), &ours("700000000000000001", false, "8")).is_some());
        assert!(w.session_for(&json!({ "id": "7" }), &ours("700000000000000001", true, "0")).is_some());
        // a plain member, or admin of a server the bot is not in: nobody
        assert!(w.session_for(&json!({ "id": "7" }), &ours("700000000000000001", false, "2048")).is_none());
        assert!(w.session_for(&json!({ "id": "7" }), &ours("999000000000000009", false, "8")).is_none());
    }

    #[tokio::test]
    async fn ticket_staff_may_use_the_tickets_of_their_server_and_nothing_else() {
        let tmp = tempfile::tempdir().unwrap();
        let w = web(tmp.path());
        let mine = "700000000000000001";
        // staff in one server, not managing anything
        let staff = Session { staff: vec![mine.to_string()], ..session(false, &[]) };
        // what a ticket page asks: allowed in their server (the answers may fail for other reasons, never for permission)
        for name in ["tickets", "ticket_view", "ticket_action", "overview", "servers"] {
            let err = dispatch(&w, &staff, name, &json!({ "guild": mine, "number": 1, "what": "claim" })).await.err().unwrap_or_default();
            assert!(!err.contains("do not manage") && !err.contains("rest of the dashboard"), "{name}: {err}");
        }
        // not in another server
        let err = dispatch(&w, &staff, "tickets", &json!({ "guild": "700000000000000002" })).await.unwrap_err();
        assert!(err.contains("do not manage"), "{err}");
        // and nothing else anywhere: settings, modules, commands, members, music, cases
        for name in ["settings", "module_set", "setting_set", "commands_view", "command_run", "cases", "members_lookup", "music_api", "permissions", "permission_set", "backup_now", "prefs_set", "staff_action", "economy"] {
            let err = dispatch(&w, &staff, name, &json!({ "guild": mine })).await.unwrap_err();
            assert!(err.contains("do not manage") || err.contains("rest of the dashboard") || err.contains("computer"), "{name} was allowed: {err}");
        }
        // the page is told they are staff only; a server they manage as well is fully theirs
        let o = dispatch(&w, &staff, "overview", &json!({})).await.unwrap();
        assert_eq!(o["web"]["staff_only"], true);
        let both = Session { guilds: vec!["700000000000000002".into()], staff: vec![mine.to_string()], ..session(false, &[]) };
        assert!(dispatch(&w, &both, "overview", &json!({})).await.unwrap()["web"]["staff_only"] == false);
        let err = dispatch(&w, &both, "settings", &json!({ "guild": mine, "module": "support" })).await.unwrap_err();
        assert!(err.contains("do not manage"), "staff in one server is not a manager of it: {err}");
        // sessions saved before staff existed still load
        let old: Session = serde_json::from_value(json!({ "user": "7", "name": "Kai", "owner": false, "guilds": [], "expires": 1 })).unwrap();
        assert!(old.staff.is_empty());
    }

    #[test]
    fn a_phone_stays_signed_in_after_the_program_restarts_but_not_forever() {
        let tmp = tempfile::tempdir().unwrap();
        let w = web(tmp.path());
        let cookie = w.sign_in(session(false, &["700000000000000001"]));
        let on_disk = std::fs::read_to_string(tmp.path().join("gb4").join("web-sessions.json")).unwrap();
        assert!(!on_disk.contains(&cookie), "only a fingerprint of the cookie is kept");
        let again = Web::new(w.desk.clone(), "https://dash.example.com");
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, format!("{COOKIE}={cookie}").parse().unwrap());
        assert_eq!(again.who(&h).unwrap().guilds, ["700000000000000001"]);
        // an old one is gone
        again.sessions.lock().unwrap().values_mut().for_each(|s| s.expires = 5);
        assert!(again.who(&h).is_none());
    }

    #[tokio::test]
    async fn every_screen_request_is_either_handled_over_the_web_or_kept_on_the_computer() {
        let tmp = tempfile::tempdir().unwrap();
        let w = web(tmp.path());
        let owner = session(true, &["700000000000000001", "700000000000000002"]);
        let ui = concat!(env!("CARGO_MANIFEST_DIR"), "/../../launcher/ui");
        let mut names = std::collections::BTreeSet::new();
        for file in ["app.js", "boot.js", "tour.js"] {
            let text = std::fs::read_to_string(format!("{ui}/{file}")).unwrap();
            let mut rest = text.as_str();
            while let Some(i) = rest.find("call('") {
                let tail = &rest[i + 6..];
                if let Some(end) = tail.find('\'') { names.insert(tail[..end].to_string()); }
                rest = &rest[i + 6..];
            }
        }
        assert!(names.len() > 40, "found the screens' requests: {}", names.len());
        for name in names {
            if DESKTOP_ONLY.contains(&name.as_str()) || name == "open" { continue; }
            let err = dispatch(&w, &owner, &name, &json!({ "guild": "700000000000000001" })).await.err().unwrap_or_default();
            assert!(!err.contains("not something the web app can do"), "{name} is asked for by the screens but the web app does not know it");
        }
    }

    fn hosted_web(tmp: &std::path::Path) -> Arc<Web> {
        let plain = web(tmp);
        let access = crate::access::tests::hosted(&plain.desk.folders.data, &crate::access::tests::key());
        Web::with_access(plain.desk.clone(), "https://dash.example.com", access)
    }

    #[tokio::test]
    async fn support_comes_in_with_a_pass_sees_only_the_bot_itself_and_everything_is_logged() {
        let tmp = tempfile::tempdir().unwrap();
        let w = hosted_web(tmp.path());
        let app = router(w.clone());
        let now = now_ms();
        let pass = crate::access::tests::pass(&crate::access::tests::key(), "sub_abc123", now + 60_000, "visit-1");
        let (code, _, headers) = ask(&app, "GET", &format!("/auth/maintain?pass={pass}"), None, None, false).await;
        assert_eq!(code, StatusCode::SEE_OTHER);
        let set = headers.get(header::SET_COOKIE).unwrap().to_str().unwrap().to_string();
        assert!(set.contains("Max-Age=3600") && set.contains("HttpOnly") && set.contains("Secure"), "{set}");
        let c = set.split(';').next().unwrap().trim_start_matches(&format!("{COOKIE}=")).to_string();
        // the same pass cannot be used again
        let (again, _, _) = ask(&app, "GET", &format!("/auth/maintain?pass={pass}"), None, None, false).await;
        assert_eq!(again, StatusCode::FORBIDDEN);
        // what support may ask for
        let (code, v, _) = ask(&app, "POST", "/api/overview", Some(&c), None, true).await;
        assert_eq!(code, StatusCode::OK, "{v}");
        assert_eq!(v["result"]["web"]["support"], true);
        assert!(v["result"].get("licence").is_none() && v["result"].get("data_folder").is_none());
        let (code, _, _) = ask(&app, "POST", "/api/health", Some(&c), None, true).await;
        assert_eq!(code, StatusCode::OK);
        let (code, v, _) = ask(&app, "POST", "/api/support_view", Some(&c), None, true).await;
        assert_eq!((code, v["result"]["support"].clone()), (StatusCode::OK, json!(true)));
        // and everything else, server by server, is refused
        for (call, body) in [("servers", json!({})), ("tickets", json!({ "guild": "700000000000000001" })), ("settings", json!({ "guild": "700000000000000001", "module": "levels" })), ("members_search", json!({ "guild": "700000000000000001" })), ("cases", json!({ "guild": "700000000000000001" })), ("access_view", json!({})), ("access_add", json!({ "user": "223456789012345678" })), ("token_save", json!({})), ("ticket_transcript", json!({ "guild": "700000000000000001", "number": 1 }))] {
            let (code, v, _) = ask(&app, "POST", &format!("/api/{call}"), Some(&c), Some(body), true).await;
            assert_eq!(code, StatusCode::BAD_REQUEST, "{call}: {v}");
        }
        let log = w.access.log(50);
        assert!(log.iter().any(|l| l["what"] == "support_sign_in" && l["ok"] == true && l["who"] == "sam@basicghostlabs.com"));
        assert!(log.iter().any(|l| l["what"] == "tickets" && l["ok"] == false && l["role"] == "support"), "refused asks are logged too");
        assert!(log.iter().all(|l| l.get("args").is_none()), "nothing typed is kept");
        // the owner sees it, and can turn support off, which ends the visit at once
        let owner = w.sign_in(session(true, &[]));
        let (_, v, _) = ask(&app, "POST", "/api/access_view", Some(&owner), None, true).await;
        assert_eq!(v["result"]["hosted"], true);
        assert!(v["result"]["log"].as_array().unwrap().iter().any(|l| l["role"] == "support"));
        let (code, _, _) = ask(&app, "POST", "/api/access_support_set", Some(&owner), Some(json!({ "on": false })), true).await;
        assert_eq!(code, StatusCode::OK);
        let (code, _, _) = ask(&app, "POST", "/api/health", Some(&c), None, true).await;
        assert_eq!(code, StatusCode::UNAUTHORIZED, "the visit is over");
        let p2 = crate::access::tests::pass(&crate::access::tests::key(), "sub_abc123", now + 60_000, "visit-2");
        let (code, _, _) = ask(&app, "GET", &format!("/auth/maintain?pass={p2}"), None, None, false).await;
        assert_eq!(code, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_bot_people_run_themselves_has_no_way_in_for_support() {
        let tmp = tempfile::tempdir().unwrap();
        let w = web(tmp.path());
        let app = router(w.clone());
        let pass = crate::access::tests::pass(&crate::access::tests::key(), "sub_abc123", now_ms() + 60_000, "x");
        let (code, _, _) = ask(&app, "GET", &format!("/auth/maintain?pass={pass}"), None, None, false).await;
        assert_eq!(code, StatusCode::FORBIDDEN);
        let owner = w.sign_in(session(true, &[]));
        let (code, _, _) = ask(&app, "POST", "/api/access_support_set", Some(&owner), Some(json!({ "on": true })), true).await;
        assert_eq!(code, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn the_owner_lets_someone_in_for_one_server_and_only_the_owner_can_change_the_list() {
        let tmp = tempfile::tempdir().unwrap();
        let w = web(tmp.path());
        let app = router(w.clone());
        let owner = w.sign_in(session(true, &[]));
        let (code, v, _) = ask(&app, "POST", "/api/access_add", Some(&owner), Some(json!({ "user": "223456789012345678", "name": "Ari", "guilds": ["700000000000000009"] })), true).await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "not a server the bot is in: {v}");
        let (code, _, _) = ask(&app, "POST", "/api/access_add", Some(&owner), Some(json!({ "user": "223456789012345678", "name": "Ari", "guilds": ["700000000000000002"] })), true).await;
        assert_eq!(code, StatusCode::OK);
        // Ari has no Manage Server anywhere, but gets the server they were given
        let s = w.session_for(&json!({ "id": "223456789012345678", "username": "ari" }), &json!([])).unwrap();
        assert_eq!((s.guilds.clone(), s.owner, s.role.as_str()), (vec!["700000000000000002".to_string()], false, "person"));
        let ari = w.sign_in(s);
        let (code, _, _) = ask(&app, "POST", "/api/cases", Some(&ari), Some(json!({ "guild": "700000000000000002" })), true).await;
        assert_eq!(code, StatusCode::OK);
        let (code, _, _) = ask(&app, "POST", "/api/cases", Some(&ari), Some(json!({ "guild": "700000000000000001" })), true).await;
        assert_eq!(code, StatusCode::BAD_REQUEST);
        for call in ["access_view", "access_add", "access_remove", "access_support_set", "bot_stop"] {
            let (code, _, _) = ask(&app, "POST", &format!("/api/{call}"), Some(&ari), Some(json!({ "user": "223456789012345678" })), true).await;
            assert_eq!(code, StatusCode::BAD_REQUEST, "{call}");
        }
        // removing them signs them out at once
        let (code, _, _) = ask(&app, "POST", "/api/access_remove", Some(&owner), Some(json!({ "user": "223456789012345678" })), true).await;
        assert_eq!(code, StatusCode::OK);
        let (code, _, _) = ask(&app, "POST", "/api/cases", Some(&ari), Some(json!({ "guild": "700000000000000002" })), true).await;
        assert_eq!(code, StatusCode::UNAUTHORIZED);
        assert!(w.session_for(&json!({ "id": "223456789012345678" }), &json!([])).is_none());
        let log = w.access.log(50);
        assert!(log.iter().any(|l| l["what"] == "access_add" && l["detail"] == "223456789012345678" && l["role"] == "owner"));
    }
}
