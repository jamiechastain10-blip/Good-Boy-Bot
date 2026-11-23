//! How the bot looks on Discord: its name, profile picture, banner and description (the bot's profile), and its app
//! icon (the application). As in Good Boy 3:
//! - **No licence:** the bot wears the Good Boy look. Any part that is missing or was changed is put back, quietly, in
//!   the background.
//! - **Licence with `whitelabel`:** the owner picks their own name, picture, banner and description, and Good Boy never
//!   touches them. The description always keeps a "Good Boy · Basic Ghost Labs" credit line at the end.
//!
//! Each part is tried on its own, so one refusal (Discord allows two name changes an hour) never stops the others.
//! The token is only ever sent to Discord. The address is a parameter so the whole thing is tested against a local one.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const API: &str = "https://discord.com/api/v10";
pub const NAME: &str = "Good Boy";
/// The version shown at the end of the description (the program's own).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DESCRIPTION: &str = "Good Boy by Basic Ghost Labs. A friendly all-in-one community bot: levels, moderation, tickets, announcements and more.";
const AVATAR: &[u8] = include_bytes!("../../../launcher/brand/avatar.png");
const BANNER: &[u8] = include_bytes!("../../../launcher/brand/banner.png");
const ICON: &[u8] = include_bytes!("../../../launcher/brand/app-icon.png");
/// What Discord takes for a description.
pub const DESCRIPTION_MAX: usize = 400;
/// The parts of the look, in the order they are set.
pub const PARTS: [&str; 5] = ["avatar", "banner", "name", "icon", "description"];

/// The picture IDs Discord gave back the last time Good Boy set them (to tell "still ours" from "changed since").
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Applied {
    pub avatar: Option<String>,
    pub banner: Option<String>,
    pub icon: Option<String>,
}

/// What the bot looks like right now.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Current {
    pub username: String,
    pub avatar: Option<String>,
    pub banner: Option<String>,
    pub icon: Option<String>,
    pub description: String,
}

fn data_uri(bytes: &[u8], mime: &str) -> String { format!("data:{mime};base64,{}", STANDARD.encode(bytes)) }

/// What Discord said, in plain words.
fn plain(status: u16, body: &Value) -> String {
    let msg = body["message"].as_str().unwrap_or("");
    if status == 429 || msg.to_lowercase().contains("too fast") || msg.to_lowercase().contains("rate") || !body["errors"]["username"].is_null() {
        return "Discord only allows two name changes an hour. Try again later.".into();
    }
    match status {
        401 => "The saved token no longer works.".into(),
        403 => "Discord did not allow this change for this bot.".into(),
        _ if !msg.is_empty() => format!("Discord said: {}", msg.chars().take(140).collect::<String>()),
        _ => format!("Discord answered {status}."),
    }
}

async fn send(http: &reqwest::Client, base: &str, token: &str, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    let mut r = http.request(method, format!("{base}{path}")).header("Authorization", format!("Bot {}", token.trim())).header("User-Agent", "GoodBot (https://basicghostlabs.com, 4)");
    if let Some(b) = body { r = r.json(&b); }
    let res = r.send().await.map_err(|_| "Could not reach Discord.".to_string())?;
    let status = res.status();
    let json: Value = res.json().await.unwrap_or(Value::Null);
    if status.is_success() { Ok(json) } else { Err(plain(status.as_u16(), &json)) }
}

/// The bot's profile and application as they are now.
pub async fn current(http: &reqwest::Client, base: &str, token: &str) -> Result<Current, String> {
    let user = send(http, base, token, reqwest::Method::GET, "/users/@me", None).await?;
    let app = send(http, base, token, reqwest::Method::GET, "/applications/@me", None).await?;
    let text = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_string);
    Ok(Current { username: user["username"].as_str().unwrap_or("").to_string(), avatar: text(&user["avatar"]), banner: text(&user["banner"]), icon: text(&app["icon"]), description: app["description"].as_str().unwrap_or("").to_string() })
}

/// Which parts of the Good Boy look are not in place.
pub fn missing(cur: &Current, applied: &Applied) -> Vec<&'static str> {
    let mut out = Vec::new();
    if cur.avatar.is_none() || cur.avatar != applied.avatar { out.push("avatar"); }
    if cur.banner.is_none() || cur.banner != applied.banner { out.push("banner"); }
    if cur.username != NAME { out.push("name"); }
    if cur.icon.is_none() || cur.icon != applied.icon { out.push("icon"); }
    // the Good Boy text, ending in the line with this version (so each update refreshes the number Discord shows)
    if !cur.description.starts_with(&DESCRIPTION[..40]) || !cur.description.trim_end().ends_with(&format!("{CREDIT_PREFIX}{VERSION}{CREDIT_SUFFIX}")) { out.push("description"); }
    out
}

/// Puts the chosen parts of the Good Boy look on the bot. Returns how each went and the picture IDs Discord gave back.
pub async fn apply(http: &reqwest::Client, base: &str, token: &str, parts: &[&str], current: &Current) -> (BTreeMap<String, Result<(), String>>, Applied) {
    let want = |p: &str| parts.contains(&p);
    let mut results: BTreeMap<String, Result<(), String>> = BTreeMap::new();
    let mut applied = Applied::default();
    let patch = |path: &'static str, body: Value| async move { send(http, base, token, reqwest::Method::PATCH, path, Some(body)).await };
    if want("avatar") {
        match patch("/users/@me", json!({ "avatar": data_uri(AVATAR, "image/png") })).await { Ok(u) => { applied.avatar = u["avatar"].as_str().map(str::to_string); results.insert("avatar".into(), Ok(())); } Err(e) => { results.insert("avatar".into(), Err(e)); } }
    }
    if want("banner") {
        match patch("/users/@me", json!({ "banner": data_uri(BANNER, "image/png") })).await { Ok(u) => { applied.banner = u["banner"].as_str().map(str::to_string); results.insert("banner".into(), Ok(())); } Err(e) => { results.insert("banner".into(), Err(e)); } }
    }
    if want("name") && current.username != NAME {
        results.insert("name".into(), patch("/users/@me", json!({ "username": NAME })).await.map(|_| ()));
    } else if want("name") { results.insert("name".into(), Ok(())); }
    if want("icon") {
        match patch("/applications/@me", json!({ "icon": data_uri(ICON, "image/png") })).await { Ok(a) => { applied.icon = a["icon"].as_str().map(str::to_string); results.insert("icon".into(), Ok(())); } Err(e) => { results.insert("icon".into(), Err(e)); } }
    }
    if want("description") {
        results.insert("description".into(), patch("/applications/@me", json!({ "description": describe_with_credit(DESCRIPTION, VERSION) })).await.map(|_| ()));
    }
    (results, applied)
}

const CREDIT_PREFIX: &str = "Good Boy v";
const CREDIT_SUFFIX: &str = " · Basic Ghost Labs";
fn is_credit(line: &str) -> bool { line.trim().strip_prefix(CREDIT_PREFIX).and_then(|r| r.strip_suffix(CREDIT_SUFFIX)).is_some_and(|v| !v.is_empty() && !v.contains(char::is_whitespace)) }
/// The owner's description with the Good Boy credit line kept at the end, cut to fit what Discord takes.
pub fn describe_with_credit(text: &str, version: &str) -> String {
    let credit = format!("{CREDIT_PREFIX}{version}{CREDIT_SUFFIX}");
    let mut lines: Vec<&str> = text.lines().collect();
    while lines.last().is_some_and(|l| l.trim().is_empty() || is_credit(l)) { lines.pop(); }
    let mut mine = lines.join("\n").trim().to_string();
    let room = DESCRIPTION_MAX.saturating_sub(credit.chars().count() + if mine.is_empty() { 0 } else { 2 });
    if mine.chars().count() > room { mine = format!("{}…", mine.chars().take(room.saturating_sub(1)).collect::<String>().trim_end()); }
    if mine.is_empty() { credit } else { format!("{mine}\n\n{credit}") }
}

/// Sets the bot's description.
pub async fn set_description(http: &reqwest::Client, base: &str, token: &str, text: &str) -> Result<(), String> {
    send(http, base, token, reqwest::Method::PATCH, "/applications/@me", Some(json!({ "description": text }))).await.map(|_| ())
}
/// For a licensed bot: the description with its credit line brought up to `version`, or None when it already ends in that line.
/// The owner's own words are never changed.
pub fn credit_refresh(description: &str, version: &str) -> Option<String> {
    let next = describe_with_credit(description, version);
    (next.trim_end() != description.trim_end()).then_some(next)
}

/// A picture someone chose: its bytes and type.
pub struct Picture { pub bytes: Vec<u8>, pub mime: String }
/// Checks a chosen picture: PNG, JPEG or GIF by what is inside (not by its name), up to 8 MB.
pub fn check_picture(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > 8 * 1024 * 1024 { return Err("That picture is too big. Discord takes up to 8 MB.".into()); }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) { Ok("image/png".into()) }
    else if bytes.starts_with(&[0xff, 0xd8, 0xff]) { Ok("image/jpeg".into()) }
    else if bytes.starts_with(b"GIF8") { Ok("image/gif".into()) }
    else { Err("Use a PNG, JPG or GIF picture.".into()) }
}

/// A licensed bot's own look. Each part is optional; what is left out stays as it is.
#[derive(Default)]
pub struct Custom { pub name: Option<String>, pub description: Option<String>, pub image: Option<Picture>, pub banner: Option<Picture>, pub version: String }
pub async fn apply_custom(http: &reqwest::Client, base: &str, token: &str, c: &Custom) -> Result<(), String> {
    let mut body = serde_json::Map::new();
    if let Some(n) = c.name.as_deref().map(str::trim) {
        let len = n.chars().count();
        if !(2..=32).contains(&len) { return Err("A bot name is 2 to 32 characters.".into()); }
        body.insert("username".into(), json!(n));
    }
    if let Some(p) = &c.image { body.insert("avatar".into(), json!(data_uri(&p.bytes, &p.mime))); }
    if let Some(p) = &c.banner { body.insert("banner".into(), json!(data_uri(&p.bytes, &p.mime))); }
    if !body.is_empty() { send(http, base, token, reqwest::Method::PATCH, "/users/@me", Some(Value::Object(body))).await?; }
    if let Some(d) = &c.description { send(http, base, token, reqwest::Method::PATCH, "/applications/@me", Some(json!({ "description": describe_with_credit(d, &c.version) }))).await?; }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::State, routing::get, Json, Router};
    use std::sync::{Arc, Mutex};

    #[test]
    fn a_licensed_bots_credit_line_is_brought_up_to_date_and_its_own_words_are_kept() {
        let mine = "Why hello there! I'm Caine.";
        let old = format!("{mine}\n\nGood Boy v3.2.1 · Basic Ghost Labs");
        assert_eq!(credit_refresh(&old, "4.0.1").unwrap(), format!("{mine}\n\nGood Boy v4.0.1 · Basic Ghost Labs"));
        assert!(credit_refresh(&format!("{mine}\n\nGood Boy v4.0.1 · Basic Ghost Labs"), "4.0.1").is_none(), "already current: nothing is sent");
        assert_eq!(credit_refresh(mine, "4.0.1").unwrap(), format!("{mine}\n\nGood Boy v4.0.1 · Basic Ghost Labs"), "a missing line is added");
    }
    #[test]
    fn the_free_look_description_ends_in_this_version_and_an_old_version_is_replaced() {
        let d = describe_with_credit(DESCRIPTION, VERSION);
        assert!(d.ends_with(&format!("Good Boy v{VERSION} · Basic Ghost Labs")) && d.chars().count() <= DESCRIPTION_MAX && d.starts_with("Good Boy by Basic Ghost Labs"));
        let ok = Current { username: NAME.into(), avatar: Some("a1".into()), banner: Some("b1".into()), icon: Some("i1".into()), description: d };
        let applied = Applied { avatar: Some("a1".into()), banner: Some("b1".into()), icon: Some("i1".into()) };
        assert!(missing(&ok, &applied).is_empty());
        let old = Current { description: describe_with_credit(DESCRIPTION, "3.9.9"), ..ok.clone() };
        assert_eq!(missing(&old, &applied), vec!["description"], "a new version refreshes the number Discord shows");
        let none = Current { description: DESCRIPTION.into(), ..ok };
        assert_eq!(missing(&none, &applied), vec!["description"]);
    }
    #[test]
    fn the_credit_line_always_ends_the_description_and_the_text_fits() {
        assert_eq!(describe_with_credit("", "4.0.0"), "Good Boy v4.0.0 · Basic Ghost Labs");
        assert_eq!(describe_with_credit("My server's helper", "4.0.0"), "My server's helper\n\nGood Boy v4.0.0 · Basic Ghost Labs");
        // an old credit line is replaced, not repeated
        assert_eq!(describe_with_credit("Hi\n\nGood Boy v3.9.9 · Basic Ghost Labs", "4.0.0"), "Hi\n\nGood Boy v4.0.0 · Basic Ghost Labs");
        let long = describe_with_credit(&"word ".repeat(200), "4.0.0");
        assert!(long.chars().count() <= DESCRIPTION_MAX && long.ends_with("Good Boy v4.0.0 · Basic Ghost Labs") && long.contains('…'));
    }
    #[test]
    fn pictures_are_known_by_what_is_inside_them() {
        assert_eq!(check_picture(&[0x89, b'P', b'N', b'G', 1]).unwrap(), "image/png");
        assert_eq!(check_picture(&[0xff, 0xd8, 0xff, 0]).unwrap(), "image/jpeg");
        assert_eq!(check_picture(b"GIF89a..").unwrap(), "image/gif");
        assert!(check_picture(b"<svg></svg>").is_err());
        assert!(check_picture(&vec![0x89; 9 * 1024 * 1024]).is_err());
    }
    #[test]
    fn missing_parts_are_found() {
        let applied = Applied { avatar: Some("a1".into()), banner: Some("b1".into()), icon: Some("i1".into()) };
        let ok = Current { username: NAME.into(), avatar: Some("a1".into()), banner: Some("b1".into()), icon: Some("i1".into()), description: describe_with_credit(DESCRIPTION, VERSION) };
        assert!(missing(&ok, &applied).is_empty());
        let changed = Current { avatar: Some("other".into()), username: "Someone".into(), ..ok.clone() };
        assert_eq!(missing(&changed, &applied), vec!["avatar", "name"]);
        assert_eq!(missing(&Current::default(), &Applied::default()).len(), 5);
    }

    /// A pretend Discord that keeps what it is told.
    #[derive(Default)]
    struct Fake { user: Value, app: Value, calls: Vec<(String, Value)>, refuse_name: bool }
    async fn serve() -> (String, Arc<Mutex<Fake>>) {
        let state = Arc::new(Mutex::new(Fake { user: json!({ "username": "Old name", "avatar": null, "banner": null }), app: json!({ "icon": null, "description": "" }), ..Default::default() }));
        async fn get_user(State(s): State<Arc<Mutex<Fake>>>) -> Json<Value> { Json(s.lock().unwrap().user.clone()) }
        async fn get_app(State(s): State<Arc<Mutex<Fake>>>) -> Json<Value> { Json(s.lock().unwrap().app.clone()) }
        async fn patch_user(State(s): State<Arc<Mutex<Fake>>>, Json(b): Json<Value>) -> (axum::http::StatusCode, Json<Value>) {
            let mut f = s.lock().unwrap();
            f.calls.push(("user".into(), b.clone()));
            if b.get("username").is_some() && f.refuse_name { return (axum::http::StatusCode::TOO_MANY_REQUESTS, Json(json!({ "message": "You are changing your username too fast" }))); }
            for k in ["username", "avatar", "banner"] { if let Some(v) = b.get(k) { f.user[k] = if k == "username" { v.clone() } else { json!(format!("{k}-hash-{}", f.calls.len())) }; } }
            (axum::http::StatusCode::OK, Json(f.user.clone()))
        }
        async fn patch_app(State(s): State<Arc<Mutex<Fake>>>, Json(b): Json<Value>) -> Json<Value> {
            let mut f = s.lock().unwrap();
            f.calls.push(("app".into(), b.clone()));
            if b.get("icon").is_some() { f.app["icon"] = json!(format!("icon-hash-{}", f.calls.len())); }
            if let Some(d) = b.get("description") { f.app["description"] = d.clone(); }
            Json(f.app.clone())
        }
        let app = Router::new().route("/users/@me", get(get_user).patch(patch_user)).route("/applications/@me", get(get_app).patch(patch_app)).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        (format!("http://{addr}"), state)
    }

    #[tokio::test]
    async fn the_good_boy_look_is_put_on_and_kept_and_one_refusal_does_not_stop_the_rest() {
        let (base, fake) = serve().await;
        let http = reqwest::Client::new();
        let cur = current(&http, &base, "token").await.unwrap();
        assert_eq!(missing(&cur, &Applied::default()).len(), 5);
        let (results, applied) = apply(&http, &base, "token", &PARTS, &cur).await;
        assert!(results.values().all(Result::is_ok), "{results:?}");
        assert!(applied.avatar.is_some() && applied.banner.is_some() && applied.icon.is_some());
        let now = current(&http, &base, "token").await.unwrap();
        assert_eq!((now.username.as_str(), now.description.as_str()), (NAME, describe_with_credit(DESCRIPTION, VERSION).as_str()));
        assert!(missing(&now, &applied).is_empty(), "everything is in place");
        // somebody changes the picture: only the picture is put back
        fake.lock().unwrap().user["avatar"] = json!("someone-else");
        let now = current(&http, &base, "token").await.unwrap();
        assert_eq!(missing(&now, &applied), vec!["avatar"]);
        // a refused name change (two an hour) does not stop the other parts
        { let mut f = fake.lock().unwrap(); f.user["username"] = json!("Changed"); f.refuse_name = true; f.user["banner"] = Value::Null; }
        let now = current(&http, &base, "token").await.unwrap();
        let (results, _) = apply(&http, &base, "token", &["name", "banner"], &now).await;
        assert!(results["name"].as_ref().unwrap_err().contains("two name changes"), "{results:?}");
        assert!(results["banner"].is_ok());
    }

    #[tokio::test]
    async fn a_licensed_bots_own_look_is_set_with_the_credit_kept() {
        let (base, fake) = serve().await;
        let http = reqwest::Client::new();
        let png = Picture { bytes: vec![0x89, b'P', b'N', b'G', 1, 2, 3], mime: "image/png".into() };
        apply_custom(&http, &base, "token", &Custom { name: Some("Rex".into()), description: Some("Rex keeps the peace".into()), image: Some(png), banner: None, version: "4.0.0".into() }).await.unwrap();
        {
            let f = fake.lock().unwrap();
            assert_eq!(f.user["username"], "Rex");
            assert_eq!(f.app["description"], "Rex keeps the peace\n\nGood Boy v4.0.0 · Basic Ghost Labs");
            assert!(f.user["avatar"].as_str().unwrap().starts_with("avatar-hash"));
        }
        assert_eq!(apply_custom(&http, &base, "token", &Custom { name: Some("x".into()), ..Default::default() }).await.unwrap_err(), "A bot name is 2 to 32 characters.");
    }
}
