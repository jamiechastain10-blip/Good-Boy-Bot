//! The desk: everything the launcher's screens can ask for or change, with no window library in sight so it
//! can all be tested. The window (gb-launcher) only passes requests through to here.
//!
//! Secrets go in and never come out: nothing here returns the bot token or the client secret.

use crate::secrets::{self, Secret};
use crate::{Folders, Runner};
use gb_core::bot::MODULES;
use gb_core::{Bot, Kind};
use gb_data::{find_3x_data, import_3x, Store};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// The launcher's own choices, kept next to the data.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Prefs {
    pub setup_done: bool,
    /// What this install is for: "bot", "clipper" or "both".
    pub parts: String,
    /// Where the bot runs: "pc" or "host".
    pub place: String,
    /// Start the bot when the launcher opens.
    pub start_with_app: bool,
    /// "dark", "light" or "system".
    pub theme: String,
    /// The guided tour was offered (and taken or put off).
    pub toured: bool,
    /// Seconds a private (only-you) message stays once nobody is touching it. 0 keeps them.
    pub private_dismiss_seconds: u64,
    /// The web app (for phones and other computers): switched on, the port it listens on, the public address people reach it
    /// at (used for the Discord sign-in), and whether it listens to the whole network (a web host) or only this computer.
    pub web_on: bool,
    pub web_port: u16,
    pub web_address: String,
    pub web_all: bool,
    /// A licence key (from Good Boy 3 or Licence Studio). Not a secret: it only works for one bot.
    pub licence: String,
    /// Good Boy 3's licence was looked for once (or the person chose), so a removed key is not taken over again.
    pub licence_looked: bool,
    /// Good Boy 3's backup from the move (a folder named before-v4-…) and when it was made; removed after 14 days.
    pub v3_backup: String,
    pub v3_backup_at: i64,
    /// The picture IDs Discord gave back when the Good Boy look was last put on the bot.
    pub brand_applied: crate::brand::Applied,
    /// The dashboard in the owner's own colours: a perk for paid supporters (a licence with `supporter` or `whitelabel`).
    pub colours: Colours,
}

/// The dashboard's own colours, each a #rrggbb colour. They show only while `on` and the licence is a paid one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Colours {
    pub on: bool,
    pub accent: String,
    pub bg: String,
    pub panel: String,
    pub ink: String,
}
impl Default for Colours {
    fn default() -> Self { Colours { on: false, accent: "#fd78f7".into(), bg: "#222222".into(), panel: "#2a2a2d".into(), ink: "#f6f2f7".into() } }
}
/// The licence features that make someone a paid supporter.
pub const PAID: &[&str] = &["supporter", "whitelabel"];
fn hex_colour(v: &Value) -> Option<String> {
    let s = v.as_str()?.trim();
    (s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())).then(|| s.to_ascii_lowercase())
}
impl Default for Prefs {
    fn default() -> Self {
        Prefs { setup_done: false, parts: "bot".into(), place: "pc".into(), start_with_app: true, theme: "system".into(), toured: false, private_dismiss_seconds: gb_core::bot::DEFAULT_DISMISS, web_on: false, web_port: 47890, web_address: String::new(), web_all: false, licence: String::new(), licence_looked: false, v3_backup: String::new(), v3_backup_at: 0, brand_applied: crate::brand::Applied::default(), colours: Colours::default() }
    }
}

/// The moderation log in numbers, over every case: how many of each kind in the last day, week, month and ever; cases
/// per day for the last 30 days; the moderators who acted most (AutoMod as "auto"); and the members with the most cases.
/// How levels are spread in a server, from every member's XP (highest first): totals, the middle member, and
/// how many sit in each band of levels.
pub fn level_stats(xp: &[i64]) -> Value {
    let levels: Vec<u32> = xp.iter().map(|&x| gb_data::level_of(x).level).collect();
    let total: i64 = xp.iter().sum();
    let n = levels.len();
    const BANDS: [(u32, u32, &str); 6] = [(0, 4, "0 to 4"), (5, 9, "5 to 9"), (10, 19, "10 to 19"), (20, 29, "20 to 29"), (30, 49, "30 to 49"), (50, u32::MAX, "50 and up")];
    let bands: Vec<Value> = BANDS.iter().map(|&(lo, hi, label)| json!({ "label": label, "count": levels.iter().filter(|&&l| l >= lo && l <= hi).count() })).collect();
    let avg = if n == 0 { 0.0 } else { levels.iter().map(|&l| l as f64).sum::<f64>() / n as f64 };
    json!({ "members": n, "total_xp": total, "avg_level": (avg * 10.0).round() / 10.0, "median_level": if n == 0 { 0 } else { levels[n / 2] }, "top_level": levels.first().copied().unwrap_or(0), "bands": bands })
}

pub fn case_stats(all: &[Value], now: i64) -> Value {
    use std::collections::{BTreeMap, HashMap};
    const DAY: i64 = 86_400_000;
    let mut kinds: BTreeMap<String, [u64; 4]> = BTreeMap::new();
    let mut days: Vec<BTreeMap<String, u64>> = vec![BTreeMap::new(); 30];
    let mut mods: HashMap<String, (u64, i64, BTreeMap<String, u64>)> = HashMap::new();
    let mut members: HashMap<String, (u64, String, i64, u64, u64)> = HashMap::new();
    for c in all {
        let kind = c["type"].as_str().unwrap_or("other").to_string();
        let at = c["at"].as_i64().unwrap_or(0);
        let ago = (now - at).max(0);
        let k = kinds.entry(kind.clone()).or_default();
        k[3] += 1;
        if ago < DAY { k[0] += 1; }
        if ago < 7 * DAY { k[1] += 1; }
        if ago < 30 * DAY { k[2] += 1; *days[(ago / DAY) as usize].entry(kind.clone()).or_default() += 1; }
        let by = c["modId"].as_str().filter(|m| !m.is_empty()).unwrap_or("auto").to_string();
        let m = mods.entry(by).or_insert((0, 0, BTreeMap::new()));
        m.0 += 1; m.1 = m.1.max(at); *m.2.entry(kind.clone()).or_default() += 1;
        if let Some(id) = c["targetId"].as_str() {
            let e = members.entry(id.to_string()).or_insert((0, String::new(), 0, 0, 0));
            e.0 += 1;
            if at >= e.2 { e.2 = at; if let Some(n) = c["targetTag"].as_str().filter(|n| !n.is_empty()) { e.1 = n.to_string(); } }
            if kind == "warn" { e.3 += 1; }
            if kind == "unwarn" { e.4 += 1; }
        }
    }
    let mut mods: Vec<_> = mods.into_iter().collect();
    mods.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then(b.1 .1.cmp(&a.1 .1)));
    let mut members: Vec<_> = members.into_iter().collect();
    members.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then(b.1 .2.cmp(&a.1 .2)));
    let people = members.len();
    json!({
        "kinds": kinds.into_iter().map(|(k, v)| (k, json!({ "day": v[0], "week": v[1], "month": v[2], "all": v[3] }))).collect::<serde_json::Map<_, _>>(),
        "days": days.into_iter().enumerate().map(|(ago, c)| json!({ "ago": ago, "counts": c })).collect::<Vec<_>>(),
        "mods": mods.into_iter().take(10).map(|(id, (n, last, by))| json!({ "id": id, "count": n, "last": last, "kinds": by })).collect::<Vec<_>>(),
        "members": members.into_iter().take(10).map(|(id, (n, name, last, w, u))| json!({ "id": id, "name": name, "count": n, "last": last, "warnings": w.saturating_sub(u) })).collect::<Vec<_>>(),
        "people": people,
    })
}

pub struct Desk {
    pub folders: Folders,
    pub runner: Runner,
    prefs: Mutex<Prefs>,
    bot: Mutex<Option<Arc<Bot>>>,
    /// A token given this session on a system with no credential store. Never written anywhere.
    session_token: Mutex<Option<String>>,
    /// Music bot tokens given this session on a system with no credential store. Never written anywhere.
    session_helpers: Mutex<std::collections::BTreeMap<usize, String>>,
    /// The runtime the program runs on, noted so the web app can be started and stopped from anywhere.
    rt: std::sync::OnceLock<tokio::runtime::Handle>,
    web_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    web_error: Arc<Mutex<Option<String>>>,
    /// An update found by the last check, and how far the download has got (0 to 100, or none).
    update_found: Mutex<Option<crate::update::Release>>,
    update_percent: std::sync::atomic::AtomicI32,
}

fn text(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl Desk {
    pub fn new(folders: Folders) -> Desk {
        let prefs = std::fs::read_to_string(folders.data.join("launcher.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let desk = Desk { folders, runner: Runner::default(), prefs: Mutex::new(prefs), bot: Mutex::new(None), session_token: Mutex::new(None), session_helpers: Mutex::new(Default::default()), rt: std::sync::OnceLock::new(), web_task: Mutex::new(None), web_error: Arc::new(Mutex::new(None)), update_found: Mutex::new(None), update_percent: std::sync::atomic::AtomicI32::new(-1) };
        desk.carry_licence();
        desk.prune_v3_backup();
        desk
    }
    fn db_file(&self) -> PathBuf {
        self.folders.data.join("eclipse.db")
    }
    pub fn prefs(&self) -> Prefs {
        self.prefs.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    /// Changes some of the launcher's choices. Unknown names and wrong values are refused.
    pub fn prefs_set(&self, patch: &Value) -> Result<Prefs, String> {
        let mut next = self.prefs();
        let obj = patch.as_object().ok_or("Nothing to change.")?;
        for (key, v) in obj {
            match (key.as_str(), v) {
                ("setup_done", Value::Bool(b)) => next.setup_done = *b,
                ("start_with_app", Value::Bool(b)) => next.start_with_app = *b,
                ("toured", Value::Bool(b)) => next.toured = *b,
                ("private_dismiss_seconds", Value::Number(n)) if n.as_u64().is_some_and(|n| n == 0 || (10..=840).contains(&n)) => next.private_dismiss_seconds = n.as_u64().unwrap_or(300),
                ("web_on", Value::Bool(b)) => next.web_on = *b,
                ("web_all", Value::Bool(b)) => next.web_all = *b,
                ("web_port", Value::Number(n)) if n.as_u64().is_some_and(|n| (1024..=65535).contains(&n)) => next.web_port = n.as_u64().unwrap_or(47890) as u16,
                ("web_address", Value::String(a)) => {
                    let a = a.trim().trim_end_matches('/');
                    let local = a.starts_with("http://localhost") || a.starts_with("http://127.0.0.1");
                    if !a.is_empty() && !(a.starts_with("https://") || local) || a.len() > 200 || a.contains(char::is_whitespace) { return Err("The web address must start with https:// (for example https://dash.example.com).".into()); }
                    next.web_address = a.to_string();
                }
                ("parts", Value::String(s)) if ["bot", "clipper", "both"].contains(&s.as_str()) => next.parts = s.clone(),
                ("place", Value::String(s)) if ["pc", "host"].contains(&s.as_str()) => next.place = s.clone(),
                ("theme", Value::String(s)) if ["dark", "light", "system"].contains(&s.as_str()) => next.theme = s.clone(),
                ("colours", Value::Object(c)) => {
                    let mut own = next.colours.clone();
                    for (k, v) in c {
                        match k.as_str() {
                            "on" => own.on = v.as_bool().ok_or("\"on\" must be true or false.")?,
                            "accent" | "bg" | "panel" | "ink" => {
                                let colour = hex_colour(v).ok_or("Colours must look like #ff78f7.")?;
                                match k.as_str() { "accent" => own.accent = colour, "bg" => own.bg = colour, "panel" => own.panel = colour, _ => own.ink = colour }
                            }
                            "reset" if v == &Value::Bool(true) => own = Colours { on: own.on, ..Colours::default() },
                            _ => return Err(format!("\"{k}\" is not one of the colours.")),
                        }
                    }
                    // switching them off is always allowed; anything else is a supporter perk
                    let only_off = !own.on && own == Colours { on: false, ..next.colours.clone() };
                    if !only_off && !self.paid() {
                        return Err("Your own colours are a supporter perk. Add a Supporter licence in Settings to use them.".into());
                    }
                    next.colours = own;
                }
                _ => return Err(format!("\"{key}\" cannot be set to that.")),
            }
        }
        self.write_prefs(next)
    }
    fn write_prefs(&self, next: Prefs) -> Result<Prefs, String> {
        std::fs::create_dir_all(&self.folders.data).map_err(text)?;
        std::fs::write(self.folders.data.join("launcher.json"), serde_json::to_string_pretty(&next).map_err(text)?).map_err(text)?;
        *self.prefs.lock().unwrap_or_else(|p| p.into_inner()) = next.clone();
        // the running bot follows at once
        if let Some(bot) = self.bot.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            bot.directory.set_dismiss_seconds(next.private_dismiss_seconds);
            bot.directory.set_licensed(!next.licence.is_empty() && self.licence_check(&next.licence).ok);
        }
        Ok(next)
    }

    // ---- the licence (the same keys Good Boy 3 uses; the bot and token stay the same, so a key carries over)
    fn cancelled_file(&self) -> PathBuf {
        self.folders.data.join("licences-cancelled.json")
    }
    fn cancelled(&self) -> Vec<String> {
        std::fs::read_to_string(self.cancelled_file()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v["revoked"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())).unwrap_or_default()
    }
    fn now_ms() -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
    }
    fn licence_check(&self, key: &str) -> crate::licence::Check {
        let app = self.token().and_then(|t| crate::licence::app_id_of(&t));
        crate::licence::verify(key, crate::licence::PUBLIC_KEY_PEM, app.as_deref(), Self::now_ms(), &self.cancelled())
    }
    /// A paid supporter: the saved licence is good for this bot and carries one of the paid features.
    pub fn paid(&self) -> bool {
        let key = self.prefs().licence;
        if key.is_empty() { return false; }
        let c = self.licence_check(&key);
        PAID.iter().any(|f| c.has(f))
    }
    /// The licence as the launcher shows it. Whether a key is saved, whether it is good for this bot, who it is for
    /// and what it unlocks.
    pub fn licence_view(&self) -> Value {
        let key = self.prefs().licence;
        if key.is_empty() { return json!({ "has_key": false }); }
        let c = self.licence_check(&key);
        json!({ "has_key": true, "ok": c.ok, "error": c.error, "expired": c.expired,
            "to": c.payload.as_ref().map(|p| p.to.clone()), "features": c.payload.as_ref().map(|p| p.features.clone()).unwrap_or_default(),
            "ends": c.payload.as_ref().and_then(|p| p.exp), "whitelabel": c.has("whitelabel") })
    }
    /// Saves a licence key (an empty one removes it). A key that is not genuine, or is for another bot, is refused.
    pub fn licence_set(&self, key: &str) -> Result<Value, String> {
        let key = key.trim();
        if !key.is_empty() {
            let c = self.licence_check(key);
            if !c.ok { return Err(c.error.unwrap_or_else(|| "That licence key does not work.".into())); }
        }
        let mut next = self.prefs();
        next.licence = key.to_string();
        next.licence_looked = true;
        self.write_prefs(next)?;
        Ok(self.licence_view())
    }
    // ---- the bot's look on Discord (name, picture, banner, description)
    fn whitelabel(&self) -> bool {
        let key = self.prefs().licence;
        !key.is_empty() && self.licence_check(&key).has("whitelabel")
    }
    /// How the bot looks and whether the Good Boy look is in place. `licensed`: this install may use its own look.
    pub async fn brand_status(&self) -> Result<Value, String> {
        let token = self.token().ok_or("Add the bot's token first.")?;
        let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build().map_err(text)?;
        let cur = crate::brand::current(&http, crate::brand::API, &token).await?;
        let missing = crate::brand::missing(&cur, &self.prefs().brand_applied);
        Ok(json!({ "licensed": self.whitelabel(), "name": cur.username, "description": cur.description, "missing": missing, "done": missing.is_empty(), "good_boy_name": crate::brand::NAME }))
    }
    /// Puts back whatever part of the Good Boy look is missing (free installs only: a licence means the look is theirs).
    pub async fn brand_keep(&self, force: bool) -> Result<Value, String> {
        let token = self.token().ok_or("Add the bot's token first.")?;
        let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().map_err(text)?;
        let cur = crate::brand::current(&http, crate::brand::API, &token).await?;
        if self.whitelabel() {
            // a licence means the look is the owner's, and only the credit line at the end of the description is kept current
            return match crate::brand::credit_refresh(&cur.description, crate::brand::VERSION) {
                None => Ok(json!({ "changed": [], "problems": {} })),
                Some(text) => match crate::brand::set_description(&http, crate::brand::API, &token, &text).await {
                    Ok(()) => Ok(json!({ "changed": ["description"], "problems": {} })),
                    Err(e) => Ok(json!({ "changed": [], "problems": { "description": e } })),
                },
            };
        }
        let applied = self.prefs().brand_applied;
        let parts: Vec<&str> = if force { crate::brand::PARTS.to_vec() } else { crate::brand::missing(&cur, &applied) };
        if parts.is_empty() { return Ok(json!({ "changed": [], "problems": {} })); }
        let (results, got) = crate::brand::apply(&http, crate::brand::API, &token, &parts, &cur).await;
        let mut next = self.prefs();
        if got.avatar.is_some() { next.brand_applied.avatar = got.avatar; }
        if got.banner.is_some() { next.brand_applied.banner = got.banner; }
        if got.icon.is_some() { next.brand_applied.icon = got.icon; }
        self.write_prefs(next)?;
        let problems: serde_json::Map<String, Value> = results.iter().filter_map(|(k, r)| r.as_ref().err().map(|e| (k.clone(), json!(e)))).collect();
        let changed: Vec<&String> = results.iter().filter(|(_, r)| r.is_ok()).map(|(k, _)| k).collect();
        Ok(json!({ "changed": changed, "problems": problems }))
    }
    /// A licensed bot's own name, picture, banner and description. Pictures come as bytes; what is left out stays.
    pub async fn brand_custom(&self, name: Option<String>, description: Option<String>, image: Option<String>, banner: Option<String>) -> Result<(), String> {
        if !self.whitelabel() { return Err("Your own name, picture, banner and description come with a white-label licence.".into()); }
        let token = self.token().ok_or("Add the bot's token first.")?;
        // pictures arrive as base64 text from the screen
        let picture = |b: Option<String>| -> Result<Option<crate::brand::Picture>, String> {
            b.filter(|t| !t.is_empty()).map(|t| {
                let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, t.trim()).map_err(|_| "That picture could not be read.".to_string())?;
                crate::brand::check_picture(&bytes).map(|mime| crate::brand::Picture { bytes, mime })
            }).transpose()
        };
        let custom = crate::brand::Custom { name: name.filter(|n| !n.trim().is_empty()), description, image: picture(image)?, banner: picture(banner)?, version: env!("CARGO_PKG_VERSION").to_string() };
        let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build().map_err(text)?;
        crate::brand::apply_custom(&http, crate::brand::API, &token, &custom).await
    }
    /// Asks for the list of cancelled licences and keeps it if the owner signed it and it is newer than the one kept.
    pub async fn licence_refresh(&self) -> Result<(), String> {
        let body = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build().map_err(text)?
            .get(crate::licence::CANCEL_LIST_URL).send().await.map_err(|_| "Could not reach the cancel list.".to_string())?
            .error_for_status().map_err(|_| "The cancel list is not published yet.".to_string())?.text().await.map_err(text)?;
        let (at, revoked) = crate::licence::read_cancel_list(&body, crate::licence::PUBLIC_KEY_PEM).ok_or("The cancel list was not signed by Basic Ghost Labs, so it was ignored.")?;
        let kept = std::fs::read_to_string(self.cancelled_file()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["at"].as_i64()).unwrap_or(0);
        if at >= kept {
            std::fs::create_dir_all(&self.folders.data).map_err(text)?;
            std::fs::write(self.cancelled_file(), json!({ "at": at, "revoked": revoked }).to_string()).map_err(text)?;
        }
        Ok(())
    }
    /// Good Boy 3's backup from the move is removed 14 days after it was made (only a folder named before-v4-…).
    fn prune_v3_backup(&self) {
        let p = self.prefs();
        if p.v3_backup.is_empty() { return; }
        let path = PathBuf::from(&p.v3_backup);
        let old = Self::now_ms() - p.v3_backup_at > 14 * 86_400_000;
        if !old { return; }
        if crate::handoff::is_backup(&path) { let _ = std::fs::remove_dir_all(&path); }
        let mut next = p;
        next.v3_backup.clear();
        next.v3_backup_at = 0;
        let _ = self.write_prefs(next);
    }
    /// The move from Good Boy 3 (it started this program with `--from-v3 <file>`): copy its data, take its token and
    /// licence, start the bot, and tell it when the bot is running. If the bot does not come up, it is stopped again so
    /// Good Boy 3 can take its token back.
    pub async fn adopt_handoff(&self, file: &std::path::Path) -> Result<(), String> {
        let h = crate::handoff::read(file)?;
        // The move brings Good Boy 3's data across, even when this computer already holds Good Boy 4 data from a test
        // build: that is set aside (kept in "before-the-move"), never used instead and never deleted.
        let from = Some(PathBuf::from(&h.data)).filter(|d| !h.data.is_empty() && d.join("eclipse.db").is_file()).or_else(|| self.old_data())
            .ok_or("Good Boy 3's data could not be found, so nothing was changed.")?;
        self.replace_with_3x(from, "before-the-move")?;
        self.token_save(&h.token).await?;
        if !h.license.is_empty() { let _ = self.licence_set(&h.license); }
        let mut next = self.prefs();
        next.setup_done = true;
        next.start_with_app = true;
        if crate::handoff::is_backup(std::path::Path::new(&h.backup)) { next.v3_backup = h.backup.clone(); next.v3_backup_at = Self::now_ms(); }
        self.write_prefs(next)?;
        self.start()?;
        for _ in 0..240 {
            match self.runner.live().phase {
                crate::runner::Phase::Online => return crate::handoff::mark_started(&h.marker),
                crate::runner::Phase::Problem => { let why = self.runner.live().problem.unwrap_or_default(); self.stop().await; return Err(format!("Good Boy 4 could not come online: {why}")); }
                _ => tokio::time::sleep(std::time::Duration::from_millis(500)).await,
            }
        }
        self.stop().await;
        Err("Good Boy 4 did not come online in time.".into())
    }

    /// A licence Good Boy 3's app kept is taken over once (when there is none yet), so it carries over with the data.
    fn carry_licence(&self) {
        let p = self.prefs();
        if !p.licence.is_empty() || p.licence_looked { return; }
        let Some(from) = self.old_data() else { return };
        let mut next = p;
        next.licence_looked = true;
        if let Some(key) = crate::licence::read_3x_licence(&from) { next.licence = key; }
        let _ = self.write_prefs(next);
    }

    /// The bot over this install's data, opened once and shared with the connection to Discord, so a setting
    /// changed here is seen by the running bot straight away.
    pub fn bot(&self) -> Result<Arc<Bot>, String> {
        let mut held = self.bot.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(bot) = held.as_ref() {
            return Ok(bot.clone());
        }
        let store = Store::open(self.db_file()).map_err(text)?;
        store.integrity_ok().map_err(text)?;
        let bot = Arc::new(Bot::new(store));
        bot.directory.set_dismiss_seconds(self.prefs().private_dismiss_seconds);
        { let key = self.prefs().licence; bot.directory.set_licensed(!key.is_empty() && self.licence_check(&key).ok); }
        *held = Some(bot.clone());
        Ok(bot)
    }

    fn token(&self) -> Option<String> {
        self.session_token.lock().unwrap_or_else(|p| p.into_inner()).clone().or_else(|| secrets::read(Secret::BotToken)).or_else(|| std::env::var("DISCORD_TOKEN").ok().filter(|t| !t.trim().is_empty()))
    }
    /// The extra music bots' tokens: (their number from 1, token). From the credential store, this session, or the
    /// DISCORD_HELPER_TOKENS setting (comma separated).
    fn helper_tokens(&self) -> Vec<(usize, String)> {
        let mut out: Vec<(usize, String)> = Vec::new();
        for n in 1..=secrets::MOST_HELPERS {
            let t = self.session_helpers.lock().unwrap_or_else(|p| p.into_inner()).get(&(n as usize)).cloned().or_else(|| secrets::read(Secret::Helper(n)));
            if let Some(t) = t { out.push((n as usize, t)); }
        }
        if let Ok(list) = std::env::var("DISCORD_HELPER_TOKENS") {
            for t in list.split(',').map(str::trim).filter(|t| !t.is_empty()) {
                if out.iter().any(|(_, x)| x == t) { continue; }
                if let Some(n) = (1..=secrets::MOST_HELPERS as usize).find(|n| !out.iter().any(|(s, _)| s == n)) { out.push((n, t.to_string())); }
            }
        }
        out
    }
    fn old_data(&self) -> Option<PathBuf> {
        // a folder the owner pointed at wins over looking around
        if let Some(dir) = self.chosen_old_folder().filter(|d| d.join("eclipse.db").is_file()) { return Some(dir); }
        self.folders.old_app_data.as_deref().map(find_3x_data).unwrap_or_default().into_iter().next()
    }
    fn chosen_old_folder(&self) -> Option<PathBuf> {
        std::fs::read_to_string(self.folders.data.join("v3-folder.txt")).ok().map(|t| PathBuf::from(t.trim())).filter(|p| !p.as_os_str().is_empty())
    }
    /// Points Good Boy 4 at the folder Good Boy 3 keeps its data in (the one holding eclipse.db), when it is somewhere unusual.
    pub fn v3_folder_set(&self, path: &str) -> Result<Value, String> {
        let typed = PathBuf::from(path.trim().trim_matches('"'));
        let candidates = [typed.clone(), typed.join("bot-data"), typed.parent().map(PathBuf::from).unwrap_or_default()];
        let dir = if typed.file_name().is_some_and(|n| n == "eclipse.db") { typed.parent().map(PathBuf::from) } else { candidates.into_iter().find(|d| d.join("eclipse.db").is_file()) };
        let dir = dir.filter(|d| d.join("eclipse.db").is_file()).ok_or("There is no eclipse.db in that folder. Good Boy 3 keeps it in a folder called bot-data (usually inside AppData\\Roaming\\Good Boy). Paste that folder's path.")?;
        Store::open_read_only(dir.join("eclipse.db")).and_then(|s| s.summary()).map_err(|e| format!("That database could not be read: {e}"))?;
        std::fs::create_dir_all(&self.folders.data).map_err(text)?;
        std::fs::write(self.folders.data.join("v3-folder.txt"), dir.display().to_string()).map_err(text)?;
        Ok(self.v3_status())
    }



    // ---- the check-up: what could stop the bot working, in plain words
    /// Looks at everything that decides whether the bot answers: the token, the connection, the data, each server's modules
    /// and the permissions the bot has there, and any problems it has already written to the Logs page.
    pub fn health(&self) -> Value {
        let mut checks: Vec<Value> = Vec::new();
        let mut add = |level: &str, title: &str, detail: String| checks.push(json!({ "level": level, "title": title, "detail": detail }));
        let live = self.runner.live();
        if self.token().is_none() { add("bad", "Bot token", "No token is saved. Add it in Settings.".into()); } else { add("good", "Bot token", "A token is saved.".into()); }
        match live.phase {
            crate::Phase::Online => add("good", "Connection", format!("Online as {} in {} server{}.", live.name.clone().unwrap_or_default(), live.servers, if live.servers == 1 { "" } else { "s" })),
            crate::Phase::Starting => add("warn", "Connection", "Still connecting.".into()),
            crate::Phase::Problem => add("bad", "Connection", live.problem.clone().unwrap_or_else(|| "The bot stopped with a problem.".into())),
            crate::Phase::Stopped => add("warn", "Connection", "The bot is stopped. Press Start on Home.".into()),
        }
        if let Some(p) = live.problem.as_ref().filter(|_| live.phase == crate::Phase::Online) { add("warn", "Connection", p.clone()); }
        // the data
        match Store::open_read_only(self.db_file()) {
            Err(_) => add("bad", "Data", "There is no database yet. Use the From Good Boy 3 page to copy yours, or start fresh.".into()),
            Ok(st) => {
                match st.integrity_ok() { Ok(()) => {}, Err(e) => add("bad", "Data", format!("The database did not pass its own check: {e}. Do not use it; restore a copy.")) }
                match st.summary() {
                    Ok(sum) if sum.records == 0 && sum.servers == 0 => add("warn", "Data", "The database is empty: no servers and no saved records. If you came from Good Boy 3, open From Good Boy 3 and copy your data.".into()),
                    Ok(sum) => add("good", "Data", format!("{} server{}, {} saved record{}.", sum.servers, if sum.servers == 1 { "" } else { "s" }, sum.records, if sum.records == 1 { "" } else { "s" })),
                    Err(e) => add("bad", "Data", format!("The database could not be read: {e}")),
                }
            }
        }
        // each server
        if let Ok(bot) = self.bot() {
            let guilds = bot.db.get().guilds().unwrap_or_default();
            for g in guilds {
                let on: Vec<String> = bot.db.get().module_states(&g.id).unwrap_or_default().into_iter().filter(|m| m.enabled).map(|m| m.module).collect();
                let name = if g.name.is_empty() { g.id.clone() } else { g.name.clone() };
                if on.is_empty() { add("warn", &format!("{name}: modules"), "No module is switched on here. Open Modules and switch on what you want.".into()); }
                else if !on.iter().any(|m| m == "money") { add("warn", &format!("{name}: modules"), "The economy module is off, so coins, shop, fishing and the games say they need it. Switch it on in Modules.".into()); }
                else { add("good", &format!("{name}: modules"), format!("{} module{} on.", on.len(), if on.len() == 1 { "" } else { "s" })); }
                match bot.directory.my_power(&g.id) {
                    None => if live.phase == crate::Phase::Online { add("warn", &format!("{name}: permissions"), "The bot has not told me its roles here yet. Try again in a moment.".into()) },
                    Some(power) if power & gb_core::perms::ADMINISTRATOR != 0 => add("good", &format!("{name}: permissions"), "The bot has Administrator here.".into()),
                    Some(power) => {
                        let need: [(u64, &str); 8] = [(1 << 10, "View Channels"), (1 << 11, "Send Messages"), (1 << 14, "Embed Links"), (1 << 15, "Attach Files"), (1 << 6, "Add Reactions"), (1 << 28, "Manage Roles"), (1 << 20, "Connect (music)"), (1 << 21, "Speak (music)")];
                        let missing: Vec<&str> = need.iter().filter(|(bit, _)| power & bit == 0).map(|(_, n)| *n).collect();
                        if missing.is_empty() { add("good", &format!("{name}: permissions"), "The bot has the permissions most modules need.".into()); }
                        else { add("warn", &format!("{name}: permissions"), format!("The bot lacks: {}. Some commands will fail. Give its role these in Server Settings > Roles, or re-invite it.", missing.join(", "))); }
                    }
                }
                let (entries, _) = bot.db.seen().since(&g.id, 0);
                let problems = entries.iter().filter(|e| e.kind == "error").count();
                if problems > 0 { add("warn", &format!("{name}: problems"), format!("{problems} problem{} written to Logs (filter: Problems). The newest: {}", if problems == 1 { " was" } else { "s were" }, entries.iter().rev().find(|e| e.kind == "error").map(|e| e.text.clone()).unwrap_or_default())); }
            }
        }
        let bad = checks.iter().filter(|c| c["level"] == "bad").count();
        let warn = checks.iter().filter(|c| c["level"] == "warn").count();
        json!({ "checks": checks, "bad": bad, "warn": warn })
    }

    // ---- moving over from Good Boy 3 (and trying it first)
    /// Where things stand: Good Boy 3's data if it is on this computer, Good Boy 4's own, and whether the bot is running.
    pub fn v3_status(&self) -> Value {
        let old = self.old_data();
        let v3 = old.as_ref().and_then(|dir| Store::open_read_only(dir.join("eclipse.db")).and_then(|s| s.summary()).ok());
        let v4 = if self.db_file().is_file() { Store::open_read_only(self.db_file()).and_then(|s| s.summary()).ok() } else { None };
        json!({
            "found": old.is_some(), "folder": old.as_ref().map(|d| d.display().to_string()),
            "looked_in": self.folders.old_app_data.as_ref().map(|d| d.display().to_string()),
            "v3": v3.map(|s| json!({ "servers": s.servers, "records": s.records, "settings": s.settings })),
            "v4": v4.map(|s| json!({ "servers": s.servers, "records": s.records, "settings": s.settings })),
            "running": self.runner.is_running(), "data_folder": self.folders.data.display().to_string(),
        })
    }
    /// Copies Good Boy 3's data across again (it keeps changing while the new one is being tried). What Good Boy 4 has
    /// now is moved into a dated folder first, never deleted, and Good Boy 3's own data is only read.
    pub fn v3_recopy(&self) -> Result<Value, String> {
        if self.runner.is_running() {
            return Err("Stop Good Boy 4 first (Home > Stop), then copy again.".into());
        }
        let from = self.old_data().ok_or("Good Boy 3's data was not found on this computer.")?;
        self.replace_with_3x(from, "before-recopy")
    }
    /// Puts a copy of Good Boy 3's data in place of whatever Good Boy 4 holds. What is there now is moved into a dated
    /// folder called `folder` first, never deleted; if the copy fails it is all put back. Good Boy 3's own data is only read.
    fn replace_with_3x(&self, from: PathBuf, folder: &str) -> Result<Value, String> {
        let data = &self.folders.data;
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let aside = data.join(folder).join(stamp.to_string());
        let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
        if data.is_dir() {
            for e in std::fs::read_dir(data).map_err(text)?.flatten() {
                let name = e.file_name();
                if name.to_string_lossy().starts_with("eclipse.db") && e.path().is_file() {
                    std::fs::create_dir_all(&aside).map_err(text)?;
                    let to = aside.join(&name);
                    std::fs::rename(e.path(), &to).map_err(|e| format!("Good Boy 4's data could not be set aside: {e}. Nothing was changed."))?;
                    moved.push((to, e.path()));
                }
            }
        }
        match import_3x(&from, data) {
            Ok(r) => Ok(json!({ "servers": r.summary.servers, "settings": r.summary.settings, "records": r.summary.records, "kept": if moved.is_empty() { Value::Null } else { json!(aside.display().to_string()) } })),
            Err(e) => {
                for (from_back, to_back) in moved { let _ = std::fs::rename(from_back, to_back); } // put everything back
                Err(format!("Your Good Boy 3 data could not be copied: {e}. Your Good Boy 4 data is as it was."))
            }
        }
    }
    /// Good Boy 3's data against the copy, table by table: what carried across, and what is different.
    pub fn v3_check(&self) -> Result<Value, String> {
        let old = self.old_data().ok_or("Good Boy 3's data was not found on this computer.")?;
        let a = Store::open_read_only(old.join("eclipse.db")).map_err(text)?;
        let b = Store::open_read_only(self.db_file()).map_err(|_| "Good Boy 4 has no data yet. Copy Good Boy 3's data first.".to_string())?;
        let (sa, sb) = (a.summary().map_err(text)?, b.summary().map_err(text)?);
        let mut rows = Vec::new();
        for (t, n) in &sa.tables {
            let m = sb.tables.iter().find(|(x, _)| x == t).map(|(_, m)| *m);
            // fewer rows than Good Boy 3 had, or a table that went missing, is worth a look; more is just new activity
            let state = match m { None => "missing", Some(m) if m < *n => "fewer", Some(m) if m > *n => "more", _ => "same" };
            rows.push(json!({ "table": t, "v3": n, "v4": m, "state": state }));
        }
        let problems = rows.iter().filter(|r| r["state"] == "missing" || r["state"] == "fewer").count();
        Ok(json!({ "rows": rows, "problems": problems, "v3_ok": a.integrity_ok().is_ok(), "v4_ok": b.integrity_ok().is_ok() }))
    }

    /// Everything the launcher needs to draw itself.
    pub fn overview(&self) -> Value {
        let prefs = self.prefs();
        let has_data = self.db_file().is_file();
        let data = if has_data { Store::open_read_only(self.db_file()).and_then(|s| s.summary()).ok() } else { None };
        let old = if has_data { None } else { self.old_data() };
        let old_summary = old.as_ref().and_then(|dir| Store::open_read_only(dir.join("eclipse.db")).and_then(|s| s.summary()).ok());
        json!({
            "version": env!("CARGO_PKG_VERSION"),
            "prefs": prefs,
            "data_folder": self.folders.data.display().to_string(),
            "data": data.map(|s| json!({ "servers": s.servers, "modules_on": s.modules_on, "settings": s.settings, "records": s.records })),
            "old_data": old.map(|dir| json!({ "folder": dir.display().to_string(), "servers": old_summary.as_ref().map(|s| s.servers), "records": old_summary.as_ref().map(|s| s.records) })),
            "token_saved": self.token().is_some(),
            "secret_saved": secrets::saved(Secret::ClientSecret),
            "keeps_secrets": cfg!(any(windows, target_os = "macos")),
            "secret_store": if cfg!(windows) { "Windows Credential Manager" } else if cfg!(target_os = "macos") { "the macOS Keychain" } else { "memory, until this window closes" },
            "live": self.runner.live(),
            "web_status": self.web_status(),
            "licence": self.licence_view(),
            "perks": json!({ "own_colours": self.paid() }),
            "modules": MODULES.iter().map(|m| json!({ "id": m.id, "name": m.name, "about": m.about })).collect::<Vec<_>>(),
        })
    }

    /// First run: gets the data ready. `copy` brings Good Boy 3's data across when there is some; otherwise a
    /// new, empty database is made. Data that is already here is always kept.
    pub fn setup_data(&self, copy: bool) -> Result<Value, String> {
        if self.db_file().is_file() {
            let s = Store::open_read_only(self.db_file()).and_then(|s| s.summary()).map_err(text)?;
            return Ok(json!({ "how": "kept", "servers": s.servers, "modules_on": s.modules_on, "settings": s.settings, "records": s.records }));
        }
        match self.old_data().filter(|_| copy) {
            Some(from) => {
                let r = import_3x(&from, &self.folders.data).map_err(|e| format!("Your Good Boy 3 data could not be copied: {e}. Nothing was changed."))?;
                Ok(json!({ "how": "copied", "from": from.display().to_string(), "servers": r.summary.servers, "modules_on": r.summary.modules_on, "settings": r.summary.settings, "records": r.summary.records, "files": r.files }))
            }
            None => {
                Store::create(self.db_file()).map_err(text)?;
                Ok(json!({ "how": "fresh", "servers": 0, "modules_on": 0, "settings": 0, "records": 0 }))
            }
        }
    }

    // ---- the bot token and client secret
    /// Asks Discord whose token this is. With no token given, the saved one is checked.
    pub async fn token_test(&self, token: Option<String>) -> Result<Value, String> {
        let token = match token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
            Some(t) if !secrets::looks_like_a_token(&t) => return Err(not_a_token(&t)),
            Some(t) => t,
            None => self.token().ok_or("No bot token is saved yet.")?,
        };
        let who = gb_discord::identify(&token).await?;
        Ok(json!({ "id": who.id, "name": who.name }))
    }
    /// Checks a new token with Discord, saves it, and restarts the bot on it if the bot was running.
    /// A token Discord refuses is not saved, so a working bot is never swapped for a broken one.
    pub async fn token_save(&self, token: &str) -> Result<Value, String> {
        let token = token.trim().to_string();
        if !secrets::looks_like_a_token(&token) {
            return Err(not_a_token(&token));
        }
        let who = gb_discord::identify(&token).await?;
        let kept = match secrets::write(Secret::BotToken, &token) {
            Ok(()) => true,
            Err(_) => {
                *self.session_token.lock().unwrap_or_else(|p| p.into_inner()) = Some(token);
                false
            }
        };
        let was_running = self.runner.is_running();
        if was_running {
            self.restart().await?;
        }
        Ok(json!({ "id": who.id, "name": who.name, "kept": kept, "restarted": was_running }))
    }
    /// Stops the bot and removes the token from this computer.
    pub async fn token_forget(&self) -> Result<(), String> {
        self.runner.stop().await;
        *self.session_token.lock().unwrap_or_else(|p| p.into_inner()) = None;
        secrets::forget(Secret::BotToken)
    }
    pub fn secret_save(&self, secret: &str) -> Result<(), String> {
        let secret = secret.trim();
        if secrets::looks_like_a_token(secret) {
            return Err("That is a bot token, not a client secret. The client secret is on the OAuth2 page of your application.".into());
        }
        if !secrets::looks_like_a_client_secret(secret) {
            return Err("That does not look like a client secret. Copy it again from the OAuth2 page (press Reset Secret to get a new one).".into());
        }
        secrets::write(Secret::ClientSecret, secret)
    }
    pub fn secret_forget(&self) -> Result<(), String> {
        secrets::forget(Secret::ClientSecret)
    }

    // ---- extra music bots
    fn invite(id: &str) -> String {
        // View Channels, Connect and Speak: all a music bot needs
        format!("https://discord.com/oauth2/authorize?client_id={id}&scope=bot&permissions=3146752")
    }
    /// The extra music bots: who they are and the link that adds each to a server.
    pub async fn helpers_list(&self) -> Result<Value, String> {
        let mut out = Vec::new();
        for (slot, token) in self.helper_tokens() {
            match gb_discord::identify(&token).await {
                Ok(w) => out.push(json!({ "slot": slot, "name": w.name, "id": w.id, "invite": Self::invite(&w.id), "problem": null })),
                Err(why) => out.push(json!({ "slot": slot, "name": format!("Music bot {slot}"), "id": null, "invite": null, "problem": why })),
            }
        }
        Ok(json!({ "helpers": out, "most": secrets::MOST_HELPERS }))
    }
    /// Checks a new music bot's token with Discord, saves it, and restarts the bot so it joins in.
    pub async fn helper_add(&self, token: &str) -> Result<Value, String> {
        let token = token.trim().to_string();
        if !secrets::looks_like_a_token(&token) { return Err(not_a_token(&token)); }
        let who = gb_discord::identify(&token).await?;
        if let Some(main) = self.token() {
            if gb_discord::identify(&main).await.is_ok_and(|m| m.id == who.id) { return Err("That is this bot's own token. Make a second bot on Discord's developer page for the extra music bot.".into()); }
        }
        let have = self.helper_tokens();
        for (_, t) in &have {
            if gb_discord::identify(t).await.is_ok_and(|m| m.id == who.id) { return Err(format!("{} is already one of the music bots.", who.name)); }
        }
        let slot = (1..=secrets::MOST_HELPERS as usize).find(|n| !have.iter().any(|(s, _)| s == n)).ok_or_else(|| format!("There can be up to {} extra music bots.", secrets::MOST_HELPERS))?;
        let kept = match secrets::write(Secret::Helper(slot as u8), &token) {
            Ok(()) => true,
            Err(_) => { self.session_helpers.lock().unwrap_or_else(|p| p.into_inner()).insert(slot, token); false }
        };
        let was_running = self.runner.is_running();
        if was_running { self.restart().await?; }
        Ok(json!({ "slot": slot, "name": who.name, "id": who.id, "invite": Self::invite(&who.id), "kept": kept, "restarted": was_running }))
    }
    /// Removes a music bot's token from this computer (the bot restarts without it).
    pub async fn helper_remove(&self, slot: usize) -> Result<(), String> {
        self.session_helpers.lock().unwrap_or_else(|p| p.into_inner()).remove(&slot);
        if (1..=secrets::MOST_HELPERS as usize).contains(&slot) { secrets::forget(Secret::Helper(slot as u8))?; }
        if self.runner.is_running() { self.restart().await?; }
        Ok(())
    }

    // ---- starting and stopping
    pub fn start(&self) -> Result<(), String> {
        let token = self.token().ok_or("Add your bot's token first (Bot settings).")?;
        let prefs = self.prefs();
        let dashboard_url = (prefs.web_on && prefs.web_address.starts_with("https://")).then_some(prefs.web_address);
        self.runner.start(token, self.helper_tokens(), self.bot()?, dashboard_url);
        Ok(())
    }
    pub async fn stop(&self) {
        self.runner.stop().await;
    }
    pub async fn restart(&self) -> Result<(), String> {
        self.runner.stop().await;
        self.start()
    }

    // ---- servers, modules, settings
    pub fn servers(&self) -> Result<Value, String> {
        let bot = self.bot()?;
        // read what is needed and let go of the database before reading settings, which take it again
        let rows = {
            let db = bot.db.get();
            let mut rows = Vec::new();
            for g in db.guilds().map_err(text)? {
                let states = db.module_states(&g.id).map_err(text)?;
                rows.push((g, states));
            }
            rows
        };
        let mut out = Vec::new();
        for (g, states) in rows {
            let modules: Vec<Value> = MODULES.iter().map(|m| {
                let on = states.iter().any(|s| s.module == m.id && s.enabled);
                // the commands it brings (the Commands tab), as Good Boy 3's dashboard lists them
                let commands: Vec<Value> = gb_core::bot::commands().filter(|c| c.module == m.id).map(|c| json!({ "name": c.name, "about": c.about, "subs": c.subs.iter().map(|x| x.name).collect::<Vec<_>>() })).collect();
                // Good Boy 3's "Needs setup": a module that is on without the setting it can't work without
                let essential: &[&str] = match m.id { "moderation" | "support" => &["logChannel"], _ => &[] };
                let needs_setup = on && essential.iter().any(|k| bot.settings.text(&g.id, m.id, k).is_none());
                json!({ "id": m.id, "name": m.name, "about": m.about, "on": on, "commands": commands, "needs_setup": needs_setup })
            }).collect();
            let waiting = states.iter().filter(|s| s.enabled && !MODULES.iter().any(|m| m.id == s.module)).count();
            out.push(json!({ "id": g.id, "name": if g.name.is_empty() { "Unnamed server".to_string() } else { g.name }, "modules": modules, "waiting": waiting }));
        }
        Ok(json!(out))
    }
    /// Posts a module's panel (the ticket buttons, the music player) in a channel, from the launcher.
    pub fn post_panel(&self, guild: &str, module: &str, channel: &str, title: Option<&str>, text: Option<&str>, pin: bool) -> Result<(), String> {
        let bot = self.bot()?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let actions = bot.panel_from_dashboard(guild, module, channel, title, text, pin, now)?;
        self.runner.act(guild, actions)
    }
    /// How the panel will look in Discord (its card as Discord's layout), without posting anything.
    pub fn panel_preview(&self, guild: &str, module: &str, title: Option<&str>, text: Option<&str>) -> Result<Value, String> {
        let bot = self.bot()?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let actions = bot.panel_from_dashboard(guild, module, "0", title, text, false, now)?;
        let card = actions.into_iter().find_map(|a| match a { gb_core::Action::Send { card, .. } | gb_core::Action::Post { card, .. } => Some(card), _ => None }).ok_or("Nothing to show.")?;
        card.to_discord().map_err(|e| e.to_string())
    }
    pub fn module_set(&self, guild: &str, module: &str, on: bool) -> Result<(), String> {
        if !MODULES.iter().any(|m| m.id == module) {
            return Err("This build of Good Boy 4 does not have that module yet.".into());
        }
        let bot = self.bot()?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let news = bot.set_module(guild, module, on, now)?;
        // bot news about it is posted when the bot is running (and quietly skipped when it is not)
        if !news.is_empty() { let _ = self.runner.act(guild, news); }
        Ok(())
    }
    /// A module's settings for one server, each with its current value and what it accepts.
    pub fn settings(&self, guild: &str, module: &str) -> Result<Value, String> {
        let bot = self.bot()?;
        let list: Vec<Value> = bot
            .settings
            .defs(module)
            .iter()
            .map(|d| {
                let mut one = json!({ "key": d.key, "label": d.label, "value": bot.settings.get(guild, module, d.key), "default": d.default_value(), "group": gb_core::settings::group(module, d.key) });
                let (kind, extra) = match d.kind {
                    Kind::Toggle => ("toggle", json!({})),
                    Kind::Number { min, max } => ("number", json!({ "min": min, "max": max })),
                    Kind::Text { max_len } => ("text", json!({ "max": max_len })),
                    Kind::Channel => ("channel", json!({})),
                    Kind::Category => ("category", json!({})),
                    Kind::Role => ("role", json!({})),
                    Kind::List => ("list", json!({})),
                    Kind::Select(options) => ("select", json!({ "options": options })),
                    Kind::Colour => ("colour", json!({})),
                };
                one["kind"] = json!(kind);
                for (k, v) in extra.as_object().unwrap() {
                    one[k] = v.clone();
                }
                one
            })
            .collect();
        Ok(json!({ "settings": list, "channels": bot.directory.channels(guild), "roles": bot.directory.roles(guild),
            "off_channels": bot.settings.off_channels(guild, module), "permissions": bot.module_permissions(guild, module) }))
    }
    /// Where a module is switched off: the channels and categories it ignores.
    pub fn off_channels_set(&self, guild: &str, module: &str, channels: &[String]) -> Result<Vec<String>, String> {
        let bot = self.bot()?;
        bot.settings.set_off_channels(guild, module, channels).map_err(text)?;
        Ok(bot.settings.off_channels(guild, module))
    }
    pub fn setting_set(&self, guild: &str, module: &str, key: &str, value: &Value) -> Result<Value, String> {
        self.bot()?.settings.set(guild, module, key, value).map_err(text)
    }

    // ---- ticket staff who sign in on the web
    /// The role the tickets module treats as staff, when one is set.
    pub fn ticket_staff_role(&self, guild: &str) -> Option<String> {
        self.bot().ok()?.settings.text(guild, "support", "staffRole").filter(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_digit()))
    }
    /// A member's roles in a server, from Discord (the bot's own token): used to tell who is ticket staff.
    pub async fn member_roles(&self, guild: &str, user: &str) -> Option<Vec<String>> {
        if !guild.bytes().all(|b| b.is_ascii_digit()) || !user.bytes().all(|b| b.is_ascii_digit()) { return None; }
        let token = self.token()?;
        let r = reqwest::Client::new().get(format!("https://discord.com/api/v10/guilds/{guild}/members/{user}")).header("Authorization", format!("Bot {token}")).timeout(std::time::Duration::from_secs(10)).send().await.ok()?;
        if !r.status().is_success() { return None; }
        let v: Value = r.json().await.ok()?;
        Some(v["roles"].as_array()?.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
    }
    // ---- every command, run from the dashboard
    /// Every command with the boxes it takes (what the Commands page lists).
    pub fn commands_view(&self) -> Result<Value, String> {
        Ok(self.bot()?.command_catalog())
    }
    /// The server's channels and roles, for the pickers in a command's form.
    pub fn directory_view(&self, guild: &str) -> Result<Value, String> {
        let bot = self.bot()?;
        Ok(json!({ "channels": bot.directory.channels(guild), "roles": bot.directory.roles(guild) }))
    }
    /// Runs a command as the bot's owner with the answers typed into its boxes. What it says comes back as text;
    /// whatever it wants done in Discord happens when the bot is running.
    pub fn command_run(&self, guild: &str, name: &str, sub: Option<&str>, values: &std::collections::BTreeMap<String, String>) -> Result<Value, String> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let (said, rest) = self.bot()?.command_run(guild, name, sub, values, now)?;
        let mut note = Value::Null;
        if !rest.is_empty() {
            if self.runner.is_running() { self.runner.act(guild, rest)?; } else { note = json!("This also posts or changes something in Discord. That happens once the bot is running."); }
        }
        Ok(json!({ "said": said, "note": note }))
    }

    // ---- pictures set up from the dashboard (welcome, goodbye and critter characters)
    fn data_url(name: &str, bytes: &[u8]) -> String {
        use base64::Engine as _;
        let mime = match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() { "png" => "image/png", "gif" => "image/gif", "webp" => "image/webp", _ => "image/jpeg" };
        format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
    }
    fn unpack(data: &str) -> Result<Vec<u8>, String> {
        use base64::Engine as _;
        let raw = data.split_once(',').map(|(_, d)| d).unwrap_or(data);
        base64::engine::general_purpose::STANDARD.decode(raw.trim()).map_err(|_| "That picture could not be read.".to_string())
    }
    /// The welcome and goodbye pictures (a small preview of each).
    pub fn images_view(&self, guild: &str) -> Result<Value, String> {
        let bot = self.bot()?;
        let one = |kind: &str| match bot.greeting_image(guild, kind) {
            Some((name, bytes)) => json!({ "has": true, "name": name, "size": bytes.len(), "preview": Self::data_url(&name, &bytes) }),
            None => json!({ "has": false }),
        };
        Ok(json!({ "welcome": one("welcome"), "goodbye": one("goodbye") }))
    }
    /// How a welcome or goodbye message will look, with a sample member called Alex: the message as people read it, and the
    /// picture (drawn exactly as Discord will get it) when the card look is chosen. `tried` holds what is being tried out on
    /// screen before it is saved: look, message, title, line, accent, theme.
    pub fn greeting_preview(&self, guild: &str, kind: &str, tried: &Value) -> Result<Value, String> {
        let bot = self.bot()?;
        let (art, text) = bot.greeting_preview(guild, kind, tried).ok_or("Pick welcome or goodbye.")?;
        let image = match art {
            Some(a) => {
                let g = gb_art::Greeting { name: &a.name, avatar: None, background: a.background.as_deref(), title: &a.title, line: &a.line, accent: a.accent.as_deref(), theme: a.theme.as_deref(), pixel: false };
                match gb_art::greeting_card(&g) { Some(png) => json!(Self::data_url("preview.png", &png)), None => Value::Null }
            }
            None => Value::Null,
        };
        let has_picture = bot.greeting_image(guild, kind).is_some();
        Ok(json!({ "text": text, "image": image, "has_picture": has_picture }))
    }
    pub fn greeting_image_set(&self, guild: &str, kind: &str, name: &str, data: &str) -> Result<(), String> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        self.bot()?.greeting_image_set(guild, kind, name, &Self::unpack(data)?, now)
    }
    pub fn greeting_image_clear(&self, guild: &str, kind: &str) -> Result<(), String> {
        self.bot()?.greeting_image_clear(guild, kind)
    }
    /// The Server setup page: the layouts, the last check, and what the last build or fix did.
    pub fn setup_view(&self, guild: &str) -> Result<Value, String> { Ok(self.bot()?.setup_view(guild)) }
    /// Starts a step of server setup in Discord (it takes a few seconds to a minute; the page reads the result with `setup_view`).
    pub fn setup_run(&self, guild: &str, step: &str, what: &str) -> Result<(), String> {
        use gb_core::{SetupJob, SetupStep};
        let step = match step {
            "scan" => SetupStep::Scan,
            "build" if gb_core::setup::template(what).is_some() => SetupStep::Build(what.to_string()),
            "fix" if gb_core::setup::FIXES.iter().any(|f| f.0 == what) => SetupStep::Fix(what.to_string()),
            _ => return Err("I don't know that step.".into()),
        };
        self.runner.act(guild, vec![gb_core::Action::Setup(Box::new(SetupJob { by: "dashboard".into(), step }))])
    }
    /// Numbers for the Eclipse ID page: cards, people seen here, people with games picked up, and whether Discord shows statuses.
    pub fn eclipse_view(&self, guild: &str) -> Result<Value, String> { Ok(self.bot()?.eclipse_view(guild)) }
    /// Every command with its parts and boxes, by module (the app's Commands guide).
    pub fn commands_guide(&self) -> Value { gb_core::guide::reference() }
    /// The server's picture gallery: every picture saved for the bot, each with a small preview and where it is in use.
    pub fn gallery_view(&self, guild: &str) -> Result<Value, String> {
        let bot = self.bot()?;
        let thumbs = bot.gallery_dir(guild).map(|d| d.join("thumbs"));
        let list: Vec<Value> = bot.gallery_pictures(guild).into_iter().map(|(p, uses)| {
            // a small copy is drawn once and kept, so opening the gallery stays quick
            let cached = thumbs.as_ref().map(|d| d.join(format!("{}.png", p.id)));
            let thumb = cached.as_ref().and_then(|f| std::fs::read(f).ok()).or_else(|| {
                let png = gb_art::thumbnail(&bot.gallery_bytes(guild, &p.id)?)?;
                if let Some(f) = &cached { if let Some(d) = f.parent() { let _ = std::fs::create_dir_all(d); } let _ = std::fs::write(f, &png); }
                Some(png)
            });
            json!({ "id": p.id, "name": p.name, "size": p.size, "at": p.at, "uses": uses, "preview": thumb.map(|t| Self::data_url("t.png", &t)) })
        }).collect();
        Ok(json!({ "pictures": list, "max": gb_core::gallery::MAX_PICTURES, "slots": gb_core::gallery::SLOTS.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>() }))
    }
    pub fn gallery_add(&self, guild: &str, name: &str, data: &str) -> Result<String, String> {
        self.bot()?.gallery_add(guild, name, &Self::unpack(data)?, Self::now_ms())
    }
    pub fn gallery_rename(&self, guild: &str, id: &str, name: &str) -> Result<(), String> { self.bot()?.gallery_rename(guild, id, name) }
    pub fn gallery_remove(&self, guild: &str, id: &str) -> Result<(), String> { self.bot()?.gallery_remove(guild, id) }
    pub fn gallery_use(&self, guild: &str, id: &str, slot: &str) -> Result<(), String> { self.bot()?.gallery_use(guild, id, slot, Self::now_ms()) }
    pub fn gallery_stop(&self, guild: &str, slot: &str) -> Result<(), String> { self.bot()?.gallery_stop(guild, slot) }
    /// The server's critter characters, with pictures, and what a character can be.
    pub fn critters_view(&self, guild: &str) -> Result<Value, String> {
        let bot = self.bot()?;
        let list: Vec<Value> = bot.critter_roster(guild).into_iter().map(|(c, file)| {
            let picture = match (&file, &c.image) {
                (Some((name, bytes)), _) => json!({ "kind": "file", "preview": Self::data_url(name, bytes) }),
                (None, Some(url)) if !url.starts_with("file:") => json!({ "kind": "link", "preview": url, "link": url }),
                _ => Value::Null,
            };
            json!({ "id": c.id, "name": c.name, "element": c.element, "rarity": c.rarity, "hp": c.hp, "atk": c.atk, "def": c.def, "spd": c.spd, "picture": picture })
        }).collect();
        Ok(json!({ "characters": list, "types": gb_core::critters::TYPES.iter().map(|t| json!([t.0, t.1])).collect::<Vec<_>>(), "rarities": gb_core::critters::RARITY_CHOICES.iter().map(|t| json!([t.0, t.1])).collect::<Vec<_>>(), "most": 200 }))
    }
    /// Adds a character (`editing` None) or changes one. `picture`: "keep", "remove", "link" or "file".
    #[allow(clippy::too_many_arguments)]
    pub fn critter_save(&self, guild: &str, editing: Option<&str>, name: &str, element: &str, rarity: &str, stats: [i64; 4], picture: &str, link: &str, file_name: &str, data: &str) -> Result<String, String> {
        use gb_core::critters::Picture;
        let pic = match picture {
            "remove" => Picture::Remove,
            "link" => Picture::Link(link.to_string()),
            "file" => Picture::File { name: file_name.to_string(), bytes: Self::unpack(data)? },
            _ => Picture::Keep,
        };
        self.bot()?.critter_save(guild, editing, name, element, rarity, stats, pic)
    }
    pub fn critter_remove(&self, guild: &str, id: &str) -> Result<String, String> {
        self.bot()?.critter_remove(guild, id)
    }

    // ---- the dashboard's data pages
    /// One server at a glance: sizes, the newest cases, ticket counts and the top of the boards.
    pub fn dashboard(&self, guild: &str) -> Result<Value, String> {
        let bot = self.bot()?;
        let members = bot.directory.members(guild);
        let cases = self.cases(guild, 6)?;
        let db = bot.db.get();
        let rows = db.history_rows(guild).map_err(text)?;
        let open = rows.iter().filter(|r| r.closed_at.is_none()).count();
        let wallets = db.wallet_count(guild).map_err(text)?;
        let xp = db.all_xp(guild).map_err(text)?;
        let supply = db.money_supply(guild).map_err(text)?;
        let coins = db.top_coins(guild, 1).map_err(text)?.first().map(|c| c.2).unwrap_or(0);
        drop(db);
        let boards = self.boards(guild, 10)?;
        Ok(json!({ "members": members, "wallets": wallets, "ranked": xp.len(), "richest": coins, "levels": level_stats(&xp), "supply": supply,
            "tickets": { "open": open, "total": rows.len() }, "cases": cases["total"], "recent_cases": cases["cases"], "boards": boards }))
    }
    /// Moderation cases, newest first: {total, cases: [..]}.
    pub fn cases(&self, guild: &str, limit: usize) -> Result<Value, String> {
        let bot = self.bot()?;
        let lists = bot.db.get().data_list(guild, "moderation", "hist:", 100_000).map_err(text)?;
        let mut all: Vec<Value> = lists.into_iter().flat_map(|(_, v)| v.as_array().cloned().unwrap_or_default()).collect();
        all.sort_by_key(|c| std::cmp::Reverse(c["at"].as_i64().unwrap_or(0)));
        let total = all.len();
        let stats = case_stats(&all, Self::now_ms());
        all.truncate(limit.min(500));
        Ok(json!({ "total": total, "cases": all, "stats": stats }))
    }
    /// Tickets, newest first: {open, total, tickets: [{number, opener, category, opened_at, closed_at, claimed_by, first_response_ms, kind}]}.
    /// `find`: only tickets whose conversation has all these words (the archive's search), or whose number, opener,
    /// who it is about or category contains the text.
    pub fn tickets(&self, guild: &str, limit: usize) -> Result<Value, String> {
        self.tickets_find(guild, limit, None)
    }
    pub fn tickets_find(&self, guild: &str, limit: usize, find: Option<&str>) -> Result<Value, String> {
        let bot = self.bot()?;
        let mut rows = bot.ticket_rows(guild);
        if let Some(words) = find.map(str::trim).filter(|w| !w.is_empty()) {
            let hits: std::collections::HashSet<i64> = bot.db.get().archive_search(guild, words).unwrap_or_default().into_iter().collect();
            let low = words.trim_start_matches('#').to_lowercase();
            rows.retain(|r| {
                let n = r["number"].as_i64().unwrap_or(0);
                hits.contains(&n) || n.to_string() == low
                    || ["opener", "about", "category_label", "category"].iter().any(|k| r[*k]["name"].as_str().or_else(|| r[*k].as_str()).is_some_and(|s| s.to_lowercase().contains(&low)))
            });
        }
        let open = rows.iter().filter(|r| r["open"] == true).count();
        let total = rows.len();
        let list: Vec<Value> = rows.into_iter().take(limit.clamp(1, 500)).collect();
        Ok(json!({ "open": open, "total": total, "tickets": list }))
    }
    /// Tells every server's announcements channel (Bot news) that the bot restarts in `minutes`. Returns how many servers
    /// have such a channel. Needs the bot running.
    pub fn announce_restart(&self, minutes: u64) -> Result<usize, String> {
        let bot = self.bot()?;
        if !self.runner.is_running() { return Err("Start the bot first: the notice is posted through it.".into()); }
        let mut told = 0;
        for g in bot.db.get().guilds().unwrap_or_default() {
            let actions = bot.restart_notice(&g.id, minutes.clamp(1, 60));
            if !actions.is_empty() { told += 1; self.runner.act(&g.id, actions)?; }
        }
        Ok(told)
    }
    /// One ticket with its conversation (the dashboard's ticket view).
    pub fn ticket_view(&self, guild: &str, number: i64) -> Result<Value, String> {
        self.bot()?.ticket_thread(guild, number).ok_or_else(|| "There is no ticket with that number.".to_string())
    }
    fn update_asset(&self) -> &'static str {
        crate::update::asset_for(&std::env::current_exe().unwrap_or_default())
    }
    /// What the Updates page shows: this version, the newer one if the last check found one, and the download's progress.
    pub fn update_status(&self) -> Value {
        let found = self.update_found.lock().unwrap().clone();
        let pct = self.update_percent.load(std::sync::atomic::Ordering::Relaxed);
        json!({
            "current": gb_core::botnews::VERSION,
            "available": found.map(|r| json!({ "version": r.version, "notes": r.notes, "size": r.size })),
            "percent": if pct >= 0 { json!(pct) } else { Value::Null },
            "can_install": !cfg!(debug_assertions),
        })
    }
    /// Asks GitHub whether a newer Good Boy 4 is out. A GitHub that cannot be reached is an error the page words kindly.
    pub async fn update_check(&self) -> Result<Value, String> {
        let found = crate::update::check(gb_core::botnews::VERSION, self.update_asset(), false).await?;
        *self.update_found.lock().unwrap() = found;
        Ok(self.update_status())
    }
    /// Downloads and checks the update, stops the bot, swaps the program and starts the new one. Returns once the new
    /// program is running; the caller then closes this one. If anything fails the old program is left exactly as it was.
    pub async fn update_install(&self) -> Result<Value, String> {
        if cfg!(debug_assertions) { return Err("A development build does not update itself.".into()); }
        let rel = self.update_found.lock().unwrap().clone().ok_or("There is no update to install. Check for updates first.")?;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let new = exe.with_extension("exe.new");
        crate::update::clean_up(&exe);
        self.update_percent.store(0, std::sync::atomic::Ordering::Relaxed);
        let pct = &self.update_percent;
        let got = crate::update::download(&rel, &new, |p| pct.store(p as i32, std::sync::atomic::Ordering::Relaxed)).await;
        if let Err(e) = got { self.update_percent.store(-1, std::sync::atomic::Ordering::Relaxed); return Err(e); }
        // the file arrived and matched; check it again from the disk, then stop the bot (it must let go of Discord first)
        if let Err(e) = crate::update::verify(&new, rel.size, &rel.sha256) { let _ = std::fs::remove_file(&new); self.update_percent.store(-1, std::sync::atomic::Ordering::Relaxed); return Err(e); }
        self.stop().await;
        let started = crate::update::swap_in(&exe, &new).and_then(|_| {
            std::process::Command::new(&exe).arg("--updated").arg(std::process::id().to_string()).spawn()
                .map(|_| ()).map_err(|e| { let _ = crate::update::swap_back(&exe); format!("The new version would not start, so the old one was put back: {e}") })
        });
        self.update_percent.store(-1, std::sync::atomic::Ordering::Relaxed);
        if let Err(e) = started { if self.prefs().start_with_app { let _ = self.start(); } return Err(e); }
        Ok(json!({ "version": rel.version }))
    }
    /// What changed, newest first: {version, sections: [{title, body}]} from this build's change notes.
    pub fn whatsnew(&self) -> Value {
        let mut sections: Vec<(String, Vec<&str>)> = Vec::new();
        for line in gb_core::botnews::CHANGELOG.lines() {
            if let Some(title) = line.strip_prefix("## ").map(str::trim).filter(|t| !t.is_empty()) { sections.push((title.to_string(), Vec::new())); }
            else if let Some(cur) = sections.last_mut() { cur.1.push(line); }
        }
        let list: Vec<Value> = sections.into_iter().take(40).map(|(t, b)| json!({ "title": t, "body": b.join("\n").trim() })).collect();
        json!({ "version": gb_core::botnews::VERSION, "sections": list })
    }
    /// A ticket's transcript as a file: {file, content}. `html`: the styled page; otherwise plain text.
    pub fn ticket_transcript(&self, guild: &str, number: i64, html: bool) -> Result<Value, String> {
        let (file, content) = self.bot()?.ticket_transcript(guild, number, html).ok_or_else(|| "There is no ticket with that number.".to_string())?;
        Ok(json!({ "file": file, "content": content }))
    }
    /// The Music page's views and actions (the same ones Good Boy 3's dashboard had). Playing needs the bot running:
    /// the voice connection is its own. Searching music sites and reading a site's playlist need only yt-dlp.
    /// `viewer`: the Discord id of the person looking (who signed in on the web); none means the person who runs the bot.
    /// The page is told which voice call they are in, so playing joins that one.
    pub async fn music_api(&self, guild: &str, kind: &str, name: &str, args: &Value, viewer: Option<&str>) -> Result<Value, String> {
        let me = viewer.map(str::to_string).or_else(|| self.bot().ok().and_then(|b| b.directory.bot_owner()));
        let mut with_me = if args.is_object() { args.clone() } else { json!({}) };
        if let (Some(me), Some(obj)) = (me, with_me.as_object_mut()) { obj.insert("me".into(), json!(me)); }
        let args = &with_me;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let bot = self.bot()?;
        let tools = self.folders.data.join("tools");
        let text = |k: &str| args[k].as_str().unwrap_or("").trim().to_string();
        if kind == "action" && name == "search" {
            let q = text("q");
            // stations and links to audio files are found without a lookup program
            if let Ok((v, _)) = bot.music_api(guild, kind, name, args, now) { return Ok(v); }
            if q.chars().count() < 2 { return Err("Type at least 2 letters.".into()); }
            bot.music_site_search_ok(guild, &q)?;
            let (songs, list) = gb_discord::search_songs(&tools, &q, 12).await?;
            return Ok(bot.music_results(guild, &songs, list.as_deref()));
        }
        if kind == "action" && name == "playlist" && args["op"] == "import" {
            let link = text("link");
            let link = if link.starts_with("http://") || link.starts_with("https://") { link } else { format!("https://{link}") };
            bot.music_site_search_ok(guild, &link)?;
            let (songs, list) = gb_discord::search_songs(&tools, &link, 100).await?;
            let named = Some(text("name")).filter(|n| !n.is_empty()).or(list).unwrap_or_else(|| "Imported playlist".into());
            return bot.music_import(guild, &named, &songs, now);
        }
        // the media switch only writes a setting, so it works with the bot stopped
        if kind == "action" && name == "media" { return Ok(bot.music_api(guild, kind, name, args, now)?.0); }
        if kind != "view" && !self.runner.is_running() { return Err("Start the bot first: the music plays through it.".into()); }
        let (answer, rest) = bot.music_api(guild, kind, name, args, now)?;
        if !rest.is_empty() { self.runner.act(guild, rest)?; }
        Ok(answer)
    }
    /// Asks Discord for the member list and works out who is inactive. The answer lands in the database a moment
    /// later (`inactive_view` reads it): the bot must be running, because the member list comes from Discord.
    pub fn inactive_scan(&self, guild: &str, days: Option<i64>) -> Result<(), String> {
        if !self.runner.is_running() { return Err("Start the bot first: the member list comes from Discord.".into()); }
        let bot = self.bot()?;
        let days = days.unwrap_or_else(|| bot.settings.int(guild, "stats", "inactiveDays")).clamp(7, 365);
        let ask = gb_core::stats::InactiveAsk { owner: "launcher".into(), days, op: gb_core::stats::InactiveOp::Snapshot { show: "all".into() }, update: false };
        self.runner.act(guild, vec![gb_core::Action::Inactive(Box::new(ask))])
    }
    pub fn inactive_view(&self, guild: &str) -> Result<Value, String> {
        Ok(self.bot()?.inactive_view(guild))
    }
    /// Removes the members chosen on the Inactive page. The page has already asked; each is checked again against
    /// the same rules first, so a kept, active or staff member is never removed.
    pub fn inactive_kick(&self, guild: &str, ids: Vec<String>, days: Option<i64>) -> Result<usize, String> {
        if !self.runner.is_running() { return Err("Start the bot first: Discord is told to remove them through it.".into()); }
        if ids.is_empty() { return Err("Pick at least one member.".into()); }
        if ids.len() > 500 { return Err("Remove at most 500 at a time.".into()); }
        let bot = self.bot()?;
        let days = days.unwrap_or_else(|| bot.settings.int(guild, "stats", "inactiveDays")).clamp(7, 365);
        let n = ids.len();
        let ask = gb_core::stats::InactiveAsk { owner: bot.directory.bot_owner().unwrap_or_else(|| "launcher".into()), days, op: gb_core::stats::InactiveOp::Kick { ids }, update: false };
        self.runner.act(guild, vec![gb_core::Action::Inactive(Box::new(ask))])?;
        Ok(n)
    }
    pub fn inactive_keep(&self, guild: &str, user: &str, keep: bool) -> Result<(), String> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        self.bot()?.inactive_keep(guild, user, keep, now)
    }
    /// The economy at a glance: the treasury and its record, the rates in force, the second currency's richest.
    pub fn economy(&self, guild: &str) -> Result<Value, String> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let bot = self.bot()?;
        let mut v = bot.economy_view(guild, now);
        let db = bot.db.get();
        let supply = db.money_supply(guild).map_err(text)?;
        let richest: Vec<Value> = db.top_coins(guild, 10).map_err(text)?.into_iter().map(|(user, name, coins)| json!({ "user": user, "name": name, "coins": coins })).collect();
        drop(db);
        if let Some(o) = v.as_object_mut() { o.insert("supply".into(), json!(supply)); o.insert("richest".into(), json!(richest)); }
        Ok(v)
    }
    /// Adds new coins to the treasury. Works without the bot running: it only changes the database.
    pub fn treasury_add(&self, guild: &str, amount: i64, note: &str) -> Result<i64, String> {
        self.bot()?.economy_add(guild, amount, note, Self::now_ms())
    }
    /// Pays coins out of the treasury to a member. Works without the bot running: it only changes the database.
    pub fn treasury_give(&self, guild: &str, user: &str, amount: i64, reason: &str) -> Result<i64, String> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        self.bot()?.economy_give(guild, user, amount, reason, now)
    }
    // ---- names instead of numbers, and who left
    /// Names for member ids (the ones the bot knows; the rest are left out, and the screens say "unknown").
    pub fn members_lookup(&self, guild: &str, ids: Vec<String>) -> Result<Value, String> {
        Ok(json!(self.bot()?.member_names(guild, &ids)))
    }
    /// Members whose name matches what was typed, for the pickers. Everything but the person's id is shown.
    pub fn members_search(&self, guild: &str, q: &str, bots: bool) -> Result<Value, String> {
        Ok(json!(self.bot()?.member_search(guild, q, bots, 12)))
    }
    /// Who left, newest first, with how they went and anything that stood out.
    pub fn leavers(&self, guild: &str, days: i64, q: &str) -> Result<Value, String> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        Ok(self.bot()?.leavers(guild, days, q, now))
    }
    /// Erases everything kept about one person.
    pub fn leaver_forget(&self, guild: &str, user: &str) -> Result<usize, String> {
        Ok(self.bot()?.roster_forget(guild, user))
    }
    /// Claims, replies to or closes a ticket. The bot must be running: Discord is told through it.
    /// `actor`: the moderator who is signed in on the web (their Discord id and name); None is the person at this computer.
    pub fn ticket_action(&self, guild: &str, number: i64, what: &str, text: &str, actor: Option<(&str, &str)>) -> Result<String, String> {
        if !self.runner.is_running() { return Err("Start the bot first: the ticket lives in Discord.".into()); }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let (said, actions) = self.bot()?.ticket_action(guild, number, what, text, actor, now)?;
        self.runner.act(guild, actions)?;
        Ok(said)
    }
    // ---- the web app: starting it, stopping it and how it is doing
    /// Notes the runtime this program runs on (call it from inside the runtime, once, at start-up).
    pub fn capture_runtime(&self) {
        if let Ok(h) = tokio::runtime::Handle::try_current() { let _ = self.rt.set(h); }
    }
    /// Starts, restarts or stops the web app to match the choices (call it after they change, and once at start-up).
    pub fn web_apply(self: &Arc<Self>) {
        if let Some(old) = self.web_task.lock().unwrap_or_else(|p| p.into_inner()).take() { old.abort(); }
        *self.web_error.lock().unwrap_or_else(|p| p.into_inner()) = None;
        let p = self.prefs();
        if !p.web_on { return; }
        if p.web_address.is_empty() { *self.web_error.lock().unwrap_or_else(|e| e.into_inner()) = Some("Write the public address first (the link people will open).".into()); return; }
        let Some(rt) = self.rt.get() else { *self.web_error.lock().unwrap_or_else(|e| e.into_inner()) = Some("The program is not ready to serve yet.".into()); return };
        let web = crate::web::Web::new(self.clone(), &p.web_address);
        let failed = self.web_error.clone();
        let task = rt.spawn(async move {
            if let Err(e) = crate::web::serve(web, p.web_port, p.web_all).await { *failed.lock().unwrap_or_else(|x| x.into_inner()) = Some(e); }
        });
        *self.web_task.lock().unwrap_or_else(|p| p.into_inner()) = Some(task);
    }
    pub fn web_status(&self) -> Value {
        let p = self.prefs();
        let running = self.web_task.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|t| !t.is_finished());
        json!({ "on": p.web_on, "running": running, "error": self.web_error.lock().unwrap_or_else(|p| p.into_inner()).clone(), "port": p.web_port, "address": p.web_address, "all": p.web_all })
    }
    // ---- for the web app
    /// Who runs this bot (as Discord says), if it is known yet.
    pub fn owner_id(&self) -> Option<String> {
        self.bot().ok().and_then(|b| b.directory.bot_owner())
    }
    /// The servers the bot is in.
    pub fn guild_ids(&self) -> Vec<String> {
        self.bot().ok().map(|b| b.db.get().guilds().unwrap_or_default().into_iter().map(|g| g.id).collect()).unwrap_or_default()
    }
    // ---- Home's live numbers
    /// The Home page's numbers: now, and two weeks hour by hour.
    pub fn pulse(&self, guild: &str) -> Result<Value, String> {
        let bot = self.bot()?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let mut v = bot.history(guild, now);
        let live = self.runner.live();
        v["now"] = bot.live_numbers(guild);
        v["uptime_seconds"] = json!(live.online_since_ms.map(|t| ((now - t) / 1000).max(0)));
        Ok(v)
    }
    // ---- list pages
    pub fn panel(&self, guild: &str, panel: &str) -> Result<Value, String> {
        self.bot()?.panel_view(guild, panel)
    }
    pub fn panel_action(&self, guild: &str, panel: &str, row: &str, action: &str) -> Result<(), String> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let actions = self.bot()?.panel_action(guild, panel, row, action, now)?;
        if actions.is_empty() { return Ok(()); }
        if !self.runner.is_running() { return Err("Start the bot first: this happens in Discord.".into()); }
        self.runner.act(guild, actions)
    }
    // ---- permissions
    pub fn permissions(&self, guild: &str) -> Result<Value, String> {
        Ok(self.bot()?.permissions_view(guild))
    }
    pub fn permission_set(&self, guild: &str, key: &str, roles: &[String]) -> Result<(), String> {
        self.bot()?.permission_set(guild, key, roles)
    }
    // ---- role menus
    pub fn role_menus(&self, guild: &str) -> Result<Value, String> {
        Ok(self.bot()?.role_menus(guild))
    }
    pub fn role_menu_delete(&self, guild: &str, message: &str) -> Result<(), String> {
        if !self.runner.is_running() { return Err("Start the bot first: the menu is a message in Discord.".into()); }
        let actions = self.bot()?.role_menu_delete(guild, message)?;
        self.runner.act(guild, actions)
    }
    // ---- the shop
    pub fn shop(&self, guild: &str) -> Result<Value, String> {
        Ok(self.bot()?.shop_view(guild))
    }
    #[allow(clippy::too_many_arguments)]
    pub fn shop_save(&self, guild: &str, name: &str, price: i64, emoji: &str, role: Option<&str>, hours: i64, stock: Option<i64>, text: &str, consumable: bool) -> Result<String, String> {
        self.bot()?.shop_save(guild, name, price, emoji, role, hours, stock, text, consumable)
    }
    pub fn shop_remove(&self, guild: &str, id: &str) -> Result<(), String> {
        self.bot()?.shop_remove(guild, id)
    }
    /// The XP and coin boards: {xp: [{user, xp, level, name?}], coins: [{user, name, coins}]}.
    pub fn boards(&self, guild: &str, limit: usize) -> Result<Value, String> {
        let bot = self.bot()?;
        let db = bot.db.get();
        let limit = limit.clamp(1, 100);
        let xp: Vec<Value> = db.top_xp(guild, limit).map_err(text)?.into_iter().map(|(user, xp)| json!({ "user": user, "xp": xp, "level": gb_data::level_of(xp).level })).collect();
        let coins: Vec<Value> = db.top_coins(guild, limit).map_err(text)?.into_iter().map(|(user, name, coins)| json!({ "user": user, "name": name, "coins": coins })).collect();
        Ok(json!({ "xp": xp, "coins": coins }))
    }

    /// What the bot has just seen in a server, oldest first: {entries: [{id, at, kind, text}], last_id}. Give the
    /// `last_id` from the answer before as `since_id` to get only what is new. Kept in memory while the launcher is open.
    pub fn activity(&self, guild: &str, since_id: u64) -> Result<Value, String> {
        let (entries, last_id) = self.bot()?.db.seen().since(guild, since_id);
        Ok(json!({ "entries": entries, "last_id": last_id }))
    }

    /// Warns, times out, kicks or bans a member from the launcher. The bot must be running: Discord does the rest.
    pub fn staff_action(&self, guild: &str, kind: &str, user: &str, name: &str, reason: &str, duration: Option<&str>) -> Result<String, String> {
        // nothing is recorded unless Discord can be told as well
        if !self.runner.is_running() { return Err("Start the bot first: Discord is told to do this through it.".into()); }
        let bot = self.bot()?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let actions = bot.staff_action(guild, kind, user, name, reason, duration, now)?;
        // the answer card says what was recorded; the rest are the things Discord must do
        let said = actions.iter().find_map(|a| if let gb_core::Action::Reply { card } = a { Some(card.title.clone().into_iter().chain(card.lines.clone()).collect::<Vec<_>>().join(" · ")) } else { None }).unwrap_or_else(|| "Done.".into());
        let rest: Vec<gb_core::Action> = actions.into_iter().filter(|a| !matches!(a, gb_core::Action::Reply { .. })).collect();
        self.runner.act(guild, rest)?;
        Ok(said)
    }
    /// Resets a server's economy (everyone's wallets), after making a backup. Gives how many wallets were cleared.
    pub fn economy_reset(&self, guild: &str) -> Result<usize, String> {
        let bot = self.bot()?;
        let money = gb_core::money::Money { db: &bot.db, settings: &bot.settings, guild };
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        money.reset(None, now)
    }

    /// Copies the whole database into the backups folder. Works while the bot is running.
    pub fn backup_now(&self, stamp: &str) -> Result<String, String> {
        let clean: String = stamp.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(40).collect();
        let file = self.folders.data.join("backups").join(format!("good-boy-{clean}.db"));
        self.bot()?.db.get().backup_to(&file).map_err(text)?;
        Ok(file.display().to_string())
    }
}

fn not_a_token(t: &str) -> String {
    if secrets::looks_like_a_client_secret(t) {
        "That looks like a client secret, not a bot token. The token is on the Bot page: press Reset Token and copy what appears.".into()
    } else {
        "That does not look like a bot token (it has three parts separated by dots). Press Reset Token on the Bot page and copy it again.".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn desk(tmp: &std::path::Path) -> Desk {
        Desk::new(Folders { data: tmp.join("gb4"), old_app_data: Some(tmp.join("none")) })
    }

    #[test]
    fn a_first_run_starts_fresh_and_remembers_its_choices() {
        let tmp = tempfile::tempdir().unwrap();
        let d = desk(tmp.path());
        let o = d.overview();
        assert_eq!(o["prefs"]["setup_done"], false);
        assert!(o["data"].is_null() && o["old_data"].is_null());
        assert_eq!(d.setup_data(true).unwrap()["how"], "fresh");
        assert_eq!(d.setup_data(true).unwrap()["how"], "kept");
        d.prefs_set(&json!({ "setup_done": true, "theme": "light", "parts": "bot" })).unwrap();
        assert!(d.prefs_set(&json!({ "theme": "pink" })).is_err());
        assert!(d.prefs_set(&json!({ "nonsense": true })).is_err());
        // a new window on the same folder sees the same choices
        // own colours are a paid supporter perk: without a licence they cannot be switched on or changed, only off
        let no = d.prefs_set(&json!({ "colours": { "on": true } })).unwrap_err();
        assert!(no.contains("supporter perk"), "{no}");
        assert!(d.prefs_set(&json!({ "colours": { "accent": "#00ff00" } })).is_err());
        assert!(d.prefs_set(&json!({ "colours": { "accent": "red" } })).is_err());
        assert!(d.prefs_set(&json!({ "colours": { "glow": "#00ff00" } })).is_err());
        d.prefs_set(&json!({ "colours": { "on": false } })).unwrap();
        assert_eq!(d.overview()["perks"]["own_colours"], false);
        let again = desk(tmp.path());
        assert_eq!(again.prefs(), Prefs { setup_done: true, theme: "light".into(), ..Prefs::default() });
        assert_eq!(again.overview()["data"]["servers"], 0);
    }


    #[test]
    fn trying_it_first_copies_again_without_losing_anything_and_checks_the_copy() {
        let tmp = tempfile::tempdir().unwrap();
        // a stand-in for Good Boy 3's folder: <app data>/Good Boy/bot-data/eclipse.db
        let old = tmp.path().join("appdata").join("Good Boy").join("bot-data");
        std::fs::create_dir_all(&old).unwrap();
        let v3 = Store::create(old.join("eclipse.db")).unwrap();
        drop(v3);
        let d = Desk::new(Folders { data: tmp.path().join("gb4"), old_app_data: Some(tmp.path().join("appdata")) });
        assert_eq!(d.v3_status()["found"], true);
        assert!(d.v3_check().is_err(), "nothing to check before the first copy");
        assert_eq!(d.setup_data(true).unwrap()["how"], "copied");
        let first = d.v3_check().unwrap();
        assert_eq!(first["problems"], 0, "{first}");
        // Good Boy 3 carries on, and the copy is made again: what was here is set aside, not deleted
        let again = d.v3_recopy().unwrap();
        let kept = again["kept"].as_str().expect("the old copy is kept in a folder").to_string();
        assert!(std::path::Path::new(&kept).join("eclipse.db").is_file());
        assert!(d.db_file().is_file());
        assert_eq!(d.v3_check().unwrap()["problems"], 0);
        assert!(old.join("eclipse.db").is_file(), "Good Boy 3's own data is untouched");
    }

    #[test]
    fn the_move_brings_good_boy_3s_data_across_even_when_a_test_build_left_data_behind() {
        let tmp = tempfile::tempdir().unwrap();
        // Good Boy 3's real data, with something only it has
        let old = tmp.path().join("appdata").join("Good Boy").join("bot-data");
        std::fs::create_dir_all(&old).unwrap();
        { let v3 = Store::create(old.join("eclipse.db")).unwrap(); v3.data_set("g1", "community", "who", &json!("good boy 3")).unwrap(); }
        let d = Desk::new(Folders { data: tmp.path().join("gb4"), old_app_data: Some(tmp.path().join("appdata")) });
        // an earlier test build of Good Boy 4 left its own data (with levels) in the data folder
        std::fs::create_dir_all(tmp.path().join("gb4")).unwrap();
        { let t = Store::create(d.db_file()).unwrap(); t.data_set("g1", "community", "who", &json!("old test build")).unwrap(); }
        assert_eq!(d.setup_data(true).unwrap()["how"], "kept", "this is the situation that used to win");
        let r = d.replace_with_3x(old.clone(), "before-the-move").unwrap();
        let now = Store::open_read_only(d.db_file()).unwrap();
        assert_eq!(now.data_get("g1", "community", "who").unwrap(), Some(json!("good boy 3")), "Good Boy 3's data is what Good Boy 4 holds now");
        let kept = r["kept"].as_str().expect("the test build's data is kept, not deleted");
        assert!(kept.contains("before-the-move"));
        let aside = Store::open_read_only(std::path::Path::new(kept).join("eclipse.db")).unwrap();
        assert_eq!(aside.data_get("g1", "community", "who").unwrap(), Some(json!("old test build")), "and it can be got back");
        assert!(old.join("eclipse.db").is_file(), "Good Boy 3's own data is untouched");
        // a Good Boy 3 folder that cannot be copied leaves Good Boy 4's data exactly as it was
        let bad = tmp.path().join("bad");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join("eclipse.db"), b"this is not a database").unwrap();
        assert!(d.replace_with_3x(bad, "before-the-move").is_err());
        assert_eq!(Store::open_read_only(d.db_file()).unwrap().data_get("g1", "community", "who").unwrap(), Some(json!("good boy 3")), "put back as it was");
    }

    #[test]
    fn good_boy_3s_data_in_an_unusual_place_can_be_pointed_at() {
        let tmp = tempfile::tempdir().unwrap();
        let odd = tmp.path().join("somewhere").join("bot-data");
        std::fs::create_dir_all(&odd).unwrap();
        drop(Store::create(odd.join("eclipse.db")).unwrap());
        let d = Desk::new(Folders { data: tmp.path().join("gb4"), old_app_data: Some(tmp.path().join("nothing-here")) });
        assert_eq!(d.v3_status()["found"], false);
        assert!(d.v3_folder_set(tmp.path().join("empty").to_str().unwrap()).unwrap_err().contains("no eclipse.db"));
        // the folder itself, the folder above it, or the file all work
        assert_eq!(d.v3_folder_set(&format!("\"{}\"", odd.display())).unwrap()["found"], true);
        assert_eq!(d.v3_status()["folder"], odd.display().to_string());
        assert_eq!(d.setup_data(true).unwrap()["how"], "copied", "the first run copies from the folder that was chosen");
        assert_eq!(d.v3_check().unwrap()["problems"], 0);
    }

    #[test]
    fn the_check_up_says_in_plain_words_what_would_stop_the_bot() {
        let tmp = tempfile::tempdir().unwrap();
        let d = desk(tmp.path());
        let titles = |v: &Value| v["checks"].as_array().unwrap().iter().map(|c| format!("{}:{}", c["level"].as_str().unwrap(), c["title"].as_str().unwrap())).collect::<Vec<_>>();
        // nothing set up: no data, no token, stopped
        let h = d.health();
        assert!(titles(&h).contains(&"bad:Data".to_string()) && titles(&h).contains(&"bad:Bot token".to_string()), "{h}");
        // an empty database is flagged, a server with the economy off says why games will refuse
        d.setup_data(false).unwrap();
        let bot = d.bot().unwrap();
        assert!(titles(&d.health()).contains(&"warn:Data".to_string()));
        bot.on_server("700000000000000001", "Ghost Town");
        bot.db.get().set_module_enabled("700000000000000001", "levels", true).unwrap();
        let h = d.health();
        let eco = h["checks"].as_array().unwrap().iter().find(|c| c["title"] == "Ghost Town: modules").unwrap();
        assert_eq!(eco["level"], "warn");
        assert!(eco["detail"].as_str().unwrap().contains("economy"));
        bot.db.get().set_module_enabled("700000000000000001", "money", true).unwrap();
        assert!(d.health()["checks"].as_array().unwrap().iter().any(|c| c["title"] == "Ghost Town: modules" && c["level"] == "good"));
        // a problem the bot wrote down shows up
        bot.db.seen().note("700000000000000001", "error", "/fish crashed: boom");
        assert!(d.health()["checks"].as_array().unwrap().iter().any(|c| c["title"] == "Ghost Town: problems" && c["detail"].as_str().unwrap().contains("boom")));
    }

    #[tokio::test]
    async fn the_web_app_follows_its_settings_and_refuses_bad_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let d = Arc::new(desk(tmp.path()));
        d.setup_data(false).unwrap();
        d.capture_runtime();
        assert!(d.prefs_set(&json!({ "web_address": "http://example.com" })).is_err(), "plain http is only for this computer");
        assert!(d.prefs_set(&json!({ "web_address": "https://a b" })).is_err());
        assert!(d.prefs_set(&json!({ "web_port": 80 })).is_err(), "ports under 1024 are refused");
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        // on, but with no address: it says what is missing instead of serving
        d.prefs_set(&json!({ "web_on": true, "web_port": port })).unwrap();
        d.web_apply();
        assert!(d.web_status()["error"].as_str().unwrap().contains("public address"));
        d.prefs_set(&json!({ "web_address": "https://dash.example.com/" })).unwrap();
        assert_eq!(d.prefs().web_address, "https://dash.example.com", "a trailing slash is dropped");
        d.web_apply();
        let mut up = false;
        for _ in 0..50 { if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() { up = true; break; } tokio::time::sleep(std::time::Duration::from_millis(50)).await; }
        assert!(up && d.web_status()["running"] == true, "{}", d.web_status());
        // off again: it stops listening
        d.prefs_set(&json!({ "web_on": false })).unwrap();
        d.web_apply();
        let mut down = false;
        for _ in 0..50 { if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_err() { down = true; break; } tokio::time::sleep(std::time::Duration::from_millis(50)).await; }
        assert!(down, "it no longer answers");
        // a port that is taken is reported
        let hog = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        d.prefs_set(&json!({ "web_on": true, "web_port": hog.local_addr().unwrap().port() })).unwrap();
        d.web_apply();
        for _ in 0..50 { if d.web_status()["error"].is_string() { break; } tokio::time::sleep(std::time::Duration::from_millis(50)).await; }
        assert!(d.web_status()["error"].as_str().unwrap().contains("already in use"), "{}", d.web_status());
    }

    #[test]
    fn private_messages_disappear_after_a_time_that_can_be_changed_and_applies_at_once() {
        let tmp = tempfile::tempdir().unwrap();
        let d = desk(tmp.path());
        d.setup_data(false).unwrap();
        let bot = d.bot().unwrap();
        assert_eq!((d.prefs().private_dismiss_seconds, bot.directory.dismiss_seconds()), (300, 300), "five minutes unless changed");
        assert_eq!(d.prefs_set(&json!({ "private_dismiss_seconds": 60 })).unwrap().private_dismiss_seconds, 60);
        assert_eq!(bot.directory.dismiss_seconds(), 60, "the running bot follows at once");
        d.prefs_set(&json!({ "private_dismiss_seconds": 0 })).unwrap();
        assert_eq!(bot.directory.dismiss_seconds(), 0, "0 keeps them");
        assert!(d.prefs_set(&json!({ "private_dismiss_seconds": 5 })).is_err(), "too short to read");
        assert!(d.prefs_set(&json!({ "private_dismiss_seconds": 3600 })).is_err(), "Discord only lets a bot take a private message down for 15 minutes");
        // a new window on the same folder remembers it
        assert_eq!(desk(tmp.path()).prefs().private_dismiss_seconds, 0);
    }

    #[test]
    fn modules_and_settings_change_what_the_running_bot_sees() {
        let tmp = tempfile::tempdir().unwrap();
        let d = desk(tmp.path());
        d.setup_data(false).unwrap();
        let bot = d.bot().unwrap();
        bot.on_server("100000000000000001", "Test server");
        let servers = d.servers().unwrap();
        assert_eq!(servers[0]["name"], "Test server");
        // a new server starts with everything on except counting, which needs a channel picked first
        let on: Vec<&str> = servers[0]["modules"].as_array().unwrap().iter().filter(|m| m["on"] == true).map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(on, vec!["community", "economy", "moderation", "member-management", "roles", "support", "reminders", "giveaways", "tags", "fun", "music"]);
        d.module_set("100000000000000001", "economy", false).unwrap();
        assert_eq!(d.servers().unwrap()[0]["modules"][1]["on"], false);
        assert!(d.module_set("100000000000000001", "fishing", true).is_err());

        let s = d.settings("100000000000000001", "community").unwrap();
        let first = &s["settings"][0];
        assert_eq!((first["key"].as_str(), first["kind"].as_str(), first["value"].as_i64(), first["max"].as_i64()), (Some("xpMin"), Some("number"), Some(15), Some(500)));
        assert_eq!(d.setting_set("100000000000000001", "community", "xpMin", &json!(40)).unwrap(), json!(40));
        // the same Bot the connection uses sees it at once
        assert_eq!(bot.settings.int("100000000000000001", "community", "xpMin"), 40);
        let refused = d.setting_set("100000000000000001", "community", "xpMin", &json!(9999)).unwrap_err();
        assert!(refused.contains("between 1 and 500"), "{refused}");
    }

    #[test]
    fn the_dashboard_reads_cases_tickets_and_boards() {
        let tmp = tempfile::tempdir().unwrap();
        let d = desk(tmp.path());
        d.setup_data(false).unwrap();
        let bot = d.bot().unwrap();
        bot.on_server("100000000000000001", "Test server");
        {
            let db = bot.db.get();
            db.data_set("100000000000000001", "moderation", "hist:7", &json!([{ "id": 2, "type": "warn", "targetId": "7", "reason": "spam", "at": 200 }, { "id": 1, "type": "kick", "targetId": "7", "reason": "x", "at": 100 }])).unwrap();
            db.data_set("100000000000000001", "moderation", "hist:8", &json!([{ "id": 3, "type": "ban", "targetId": "8", "reason": "y", "at": 300 }])).unwrap();
        }
        let c = d.cases("100000000000000001", 2).unwrap();
        assert_eq!((c["total"].as_i64(), c["cases"][0]["id"].as_i64(), c["cases"][1]["id"].as_i64(), c["cases"].as_array().unwrap().len()), (Some(3), Some(3), Some(2), 2));
        // the numbers are over every case, not only the ones sent
        assert_eq!((c["stats"]["kinds"]["warn"]["all"].as_u64(), c["stats"]["kinds"]["ban"]["all"].as_u64(), c["stats"]["people"].as_u64()), (Some(1), Some(1), Some(2)));
        assert_eq!((c["stats"]["members"][0]["id"].as_str(), c["stats"]["members"][0]["count"].as_u64(), c["stats"]["members"][0]["warnings"].as_u64()), (Some("7"), Some(2), Some(1)));
        assert_eq!((c["stats"]["mods"][0]["id"].as_str(), c["stats"]["mods"][0]["count"].as_u64()), (Some("auto"), Some(3)));
        assert_eq!(c["stats"]["days"].as_array().unwrap().len(), 30);
        let now = 40 * 86_400_000;
        let s = case_stats(&[json!({ "type": "warn", "at": now - 1000, "modId": "5", "targetId": "7" }), json!({ "type": "warn", "at": now - 3 * 86_400_000, "modId": "5", "targetId": "7" }), json!({ "type": "kick", "at": now - 35 * 86_400_000, "targetId": "9" })], now);
        assert_eq!((s["kinds"]["warn"]["day"].as_u64(), s["kinds"]["warn"]["week"].as_u64(), s["kinds"]["kick"]["month"].as_u64(), s["kinds"]["kick"]["all"].as_u64()), (Some(1), Some(2), Some(0), Some(1)));
        assert_eq!((s["days"][0]["counts"]["warn"].as_u64(), s["days"][3]["counts"]["warn"].as_u64(), s["mods"][0]["id"].as_str()), (Some(1), Some(1), Some("5")));
        let o = d.dashboard("100000000000000001").unwrap();
        assert_eq!((o["cases"].as_u64(), o["tickets"]["open"].as_u64()), (Some(3), Some(0)));
        assert_eq!((o["levels"]["members"].as_u64(), o["supply"]["coins"].as_i64(), o["levels"]["bands"].as_array().unwrap().len()), (Some(0), Some(0), 6));
        let l = level_stats(&[1_000_000, 50_000, 0, 0]);
        assert_eq!((l["members"].as_u64(), l["total_xp"].as_i64(), l["median_level"].as_u64(), l["bands"][0]["count"].as_u64()), (Some(4), Some(1_050_000), Some(0), Some(2)));
        assert!(l["top_level"].as_u64().unwrap() > 10);
        let e = d.economy("100000000000000001").unwrap();
        assert_eq!((e["supply"]["wallets"].as_i64(), e["richest"].as_array().map(Vec::len)), (Some(0), Some(0)));
        assert!(d.boards("100000000000000001", 5).unwrap()["xp"].as_array().unwrap().is_empty());
        let t = d.tickets("100000000000000001", 10).unwrap();
        assert_eq!((t["open"].as_u64(), t["total"].as_u64()), (Some(0), Some(0)));
    }

    #[test]
    fn tickets_are_found_by_what_was_said_their_number_or_their_people() {
        let tmp = tempfile::tempdir().unwrap();
        let d = desk(tmp.path());
        d.setup_data(false).unwrap();
        let bot = d.bot().unwrap();
        let g = "100000000000000001";
        bot.on_server(g, "Test server");
        {
            let db = bot.db.get();
            for (n, who, cat) in [(7, "kai", "report"), (8, "rowan", "help")] {
                db.history_ensure(g, &json!({ "number": n, "opener": format!("{n}"), "openerTag": who, "category": cat, "typeLabel": cat, "priority": "normal", "createdAt": 100 }), "c").unwrap();
            }
            db.archive_put(g, 7, "m1", "c", Some("7"), "Kai", None, false, "he sent a scam link", &json!([]), &json!([]), 100).unwrap();
            db.archive_put(g, 8, "m2", "c", Some("8"), "Rowan", None, false, "how do I change my nickname", &json!([]), &json!([]), 100).unwrap();
        }
        let numbers = |find: Option<&str>| -> Vec<i64> { d.tickets_find(g, 50, find).unwrap()["tickets"].as_array().unwrap().iter().map(|t| t["number"].as_i64().unwrap()).collect() };
        assert_eq!(numbers(None).len(), 2);
        assert_eq!(numbers(Some("scam link")), vec![7], "words anyone said");
        assert_eq!(numbers(Some("nickname")), vec![8]);
        assert_eq!(numbers(Some("#8")), vec![8], "a ticket number");
        assert_eq!(numbers(Some("rowan")), vec![8], "who opened it");
        assert!(numbers(Some("nothing like this")).is_empty());
        // the transcript the dashboard saves: the styled page, or plain text, with what each person said
        let page = d.ticket_transcript(g, 7, true).unwrap();
        assert_eq!(page["file"], "ticket-007.html");
        let html = page["content"].as_str().unwrap();
        assert!(html.starts_with("<!doctype html>") && html.contains("he sent a scam link") && html.contains("Ticket #7"), "{html}");
        let txt = d.ticket_transcript(g, 7, false).unwrap();
        assert_eq!(txt["file"], "ticket-007.txt");
        assert!(txt["content"].as_str().unwrap().contains("Kai: he sent a scam link"));
        assert!(d.ticket_transcript(g, 99, true).is_err());
        assert_eq!(numbers(Some("  ")).len(), 2, "blank search shows everything");
    }

    #[test]
    fn activity_says_who_did_what_and_only_gives_what_is_new() {
        let tmp = tempfile::tempdir().unwrap();
        let d = desk(tmp.path());
        d.setup_data(false).unwrap();
        let bot = d.bot().unwrap();
        let g = "100000000000000001";
        bot.on_server(g, "Test server");
        bot.directory.set_channels(g, vec![gb_core::bot::Named { id: "5".into(), name: "general".into(), kind: "text", parent: String::new() }]);
        assert_eq!(d.activity(g, 0).unwrap(), json!({ "entries": [], "last_id": 0 }));
        let sam = gb_core::Member { id: "7".into(), name: "Sam".into(), ..Default::default() };
        bot.on_member(g, &sam, true);
        // a command with something secret-looking typed into it: only its name and place are kept
        let mut args = std::collections::BTreeMap::new();
        args.insert("user".to_string(), "do-not-show-this".to_string());
        let ev = gb_core::CommandEvent { guild: g.into(), place: gb_core::Place::channel("5"), member: sam.clone(), name: "rank".into(), args, from_form: true, at_ms: 1, ..Default::default() };
        bot.on_command(&ev, &|_| None, &mut |lo, _| lo);
        let a = d.activity(g, 0).unwrap();
        let list = a["entries"].as_array().unwrap();
        assert_eq!(list.iter().map(|e| (e["id"].as_u64().unwrap(), e["kind"].as_str().unwrap(), e["text"].as_str().unwrap())).collect::<Vec<_>>(), vec![(1, "member", "Sam joined the server"), (2, "command", "Sam used /rank in #general")]);
        assert_eq!(a["last_id"], 2);
        assert!(list[0]["at"].as_i64().unwrap() > 1_600_000_000_000);
        assert!(!a.to_string().contains("do-not-show-this"));
        // asking again from the last id gives nothing, then only the new one
        assert_eq!(d.activity(g, 2).unwrap(), json!({ "entries": [], "last_id": 2 }));
        bot.on_member(g, &sam, false);
        let next = d.activity(g, 2).unwrap();
        assert_eq!((next["entries"].as_array().unwrap().len(), next["entries"][0]["id"].as_u64(), next["entries"][0]["text"].as_str(), next["last_id"].as_u64()), (1, Some(3), Some("Sam left the server"), Some(3)));
        // another server has its own list
        assert_eq!(d.activity("100000000000000002", 0).unwrap()["last_id"], 0);
    }

    #[test]
    fn a_backup_is_a_database_that_opens_and_holds_the_same_data() {
        let tmp = tempfile::tempdir().unwrap();
        let d = desk(tmp.path());
        d.setup_data(false).unwrap();
        d.bot().unwrap().on_server("100000000000000001", "Test server");
        let file = d.backup_now("2026-11-11-0930/../x").unwrap();
        assert!(file.ends_with("good-boy-2026-11-11-0930x.db"), "{file}");
        assert_eq!(Store::open_read_only(&file).unwrap().guilds().unwrap().len(), 1);
        assert!(d.backup_now("2026-11-11-0930x").is_err(), "a backup is never written over");
    }

    #[tokio::test]
    async fn secrets_are_checked_before_anything_is_saved_and_never_come_back() {
        let tmp = tempfile::tempdir().unwrap();
        let d = desk(tmp.path());
        d.setup_data(false).unwrap();
        let token = "MTAwMDAwMDAwMDAwMDAwMDAw.Gabcde.abcdefghijklmnopqrstuvwxyz0123456789ABCD";
        let secret = "abcdefghijklmnopqrstuvwxyz_12345";
        assert!(d.token_save(secret).await.unwrap_err().contains("client secret"));
        assert!(d.token_save("hello").await.unwrap_err().contains("three parts"));
        assert!(d.secret_save(token).unwrap_err().contains("bot token"));
        assert!(d.secret_save("nope").is_err());
        assert!(d.start().is_err() || std::env::var("DISCORD_TOKEN").is_ok(), "no token, no start");
        let shown = d.overview().to_string();
        assert!(!shown.contains(token) && !shown.contains(secret));
    }

    #[test]
    fn a_module_remembers_where_it_is_off_and_lists_its_own_permissions() {
        let tmp = tempfile::tempdir().unwrap();
        let d = desk(tmp.path());
        d.setup_data(false).unwrap();
        let g = "700000000000000001";
        d.bot().unwrap().on_server(g, "Ghost Town");
        let r = d.settings(g, "economy").unwrap();
        assert_eq!(r["off_channels"], json!([]));
        assert!(r["permissions"].as_array().unwrap().iter().all(|p| p["group"] == "economy"));
        // ids are kept once each, and anything that is not an id is dropped
        let kept = d.off_channels_set(g, "economy", &["123456789012345678".into(), "123456789012345678".into(), "nope".into()]).unwrap();
        assert_eq!(kept, vec!["123456789012345678".to_string()]);
        assert_eq!(d.settings(g, "economy").unwrap()["off_channels"], json!(["123456789012345678"]));
        assert_eq!(d.off_channels_set(g, "economy", &[]).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn welcome_goodbye_and_critter_pictures_are_set_up_from_the_dashboard() {
        use base64::Engine as _;
        let tmp = tempfile::tempdir().unwrap();
        let d = desk(tmp.path());
        d.setup_data(false).unwrap();
        let g = "700000000000000001";
        d.bot().unwrap().on_server(g, "Ghost Town");
        let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\n-pretend-picture");
        let url = format!("data:image/png;base64,{png}");
        // welcome and goodbye: nothing, then a picture each, then one taken away
        assert_eq!(d.images_view(g).unwrap()["welcome"]["has"], false);
        d.greeting_image_set(g, "welcome", "hello.PNG", &url).unwrap();
        let v = d.images_view(g).unwrap();
        assert!(v["welcome"]["has"] == true && v["welcome"]["preview"].as_str().unwrap().starts_with("data:image/png;base64,") && v["goodbye"]["has"] == false, "{v}");
        d.greeting_image_set(g, "goodbye", "bye.png", &url).unwrap();
        d.greeting_image_clear(g, "welcome").unwrap();
        assert_eq!((d.images_view(g).unwrap()["welcome"]["has"].clone(), d.images_view(g).unwrap()["goodbye"]["has"].clone()), (json!(false), json!(true)));
        // the greeting really carries it (the same file /greeting image would have kept)
        assert!(d.bot().unwrap().greeting_image(g, "goodbye").is_some());
        // things that are not pictures are refused, whatever they are called
        assert!(d.greeting_image_set(g, "welcome", "x.png", "data:image/png;base64,bm90IGEgcGljdHVyZQ==").unwrap_err().contains("not a picture"));
        assert!(d.greeting_image_set(g, "welcome", "x.exe", &url).unwrap_err().contains("PNG, JPG, GIF or WebP"));
        assert!(d.greeting_image_set(g, "nonsense", "x.png", &url).is_err());
        assert!(d.greeting_image_set(g, "welcome", "x.png", "%%%").is_err());
        // critters: a character with an uploaded picture, then a link, then changed, then removed
        let v = d.critters_view(g).unwrap();
        assert_eq!((v["characters"].as_array().unwrap().len(), v["types"].as_array().unwrap().is_empty()), (0, false));
        d.critter_save(g, None, "Mister Nine", "fire", "rare", [80, 70, 60, 90], "file", "", "nine.png", &url).unwrap();
        let v = d.critters_view(g).unwrap();
        assert_eq!((v["characters"][0]["id"].as_str(), v["characters"][0]["picture"]["kind"].as_str(), v["characters"][0]["hp"].as_i64()), (Some("mister-nine"), Some("file"), Some(80)));
        assert!(d.critter_save(g, None, "Mister Nine", "fire", "rare", [1, 1, 1, 1], "keep", "", "", "").unwrap_err().contains("already a character"));
        assert!(d.critter_save(g, None, "Bad Type", "lava", "rare", [50; 4], "keep", "", "", "").unwrap_err().contains("type"));
        assert!(d.critter_save(g, None, "Bad Link", "fire", "rare", [50; 4], "link", "http://example.com/a.png", "", "").unwrap_err().contains("https"));
        // a new name keeps the character's number; stats are kept within range; the picture is kept unless changed
        d.critter_save(g, Some("mister-nine"), "Mister Ten", "water", "epic", [500, 5, 60, 90], "keep", "", "", "").unwrap();
        let c = d.critters_view(g).unwrap()["characters"][0].clone();
        assert_eq!((c["id"].as_str(), c["name"].as_str(), c["hp"].as_i64(), c["atk"].as_i64(), c["picture"]["kind"].as_str()), (Some("mister-nine"), Some("Mister Ten"), Some(200), Some(10), Some("file")));
        d.critter_save(g, Some("mister-nine"), "Mister Ten", "water", "epic", [50; 4], "link", "https://example.com/a.png", "", "").unwrap();
        assert_eq!(d.critters_view(g).unwrap()["characters"][0]["picture"]["kind"], "link");
        d.critter_save(g, Some("mister-nine"), "Mister Ten", "water", "epic", [50; 4], "remove", "", "", "").unwrap();
        assert!(d.critters_view(g).unwrap()["characters"][0]["picture"].is_null());
        assert!(d.critter_remove(g, "mister-nine").is_ok() && d.critter_remove(g, "mister-nine").is_err());
    }

    #[test]
    fn any_command_can_be_run_from_the_dashboard_with_its_boxes() {
        let tmp = tempfile::tempdir().unwrap();
        let d = desk(tmp.path());
        d.setup_data(false).unwrap();
        let g = "700000000000000001";
        let bot = d.bot().unwrap();
        bot.on_server(g, "Ghost Town");
        let ch = "800000000000000001";
        bot.directory.set_channels(g, vec![gb_core::bot::Named { id: ch.into(), name: "stars".into(), kind: "text", parent: String::new() }]);
        // the page lists every command with its boxes and where it lives in Discord
        let cat = d.commands_view().unwrap();
        let list = cat["commands"].as_array().unwrap();
        assert!(list.len() > 90);
        let ban = list.iter().find(|c| c["name"] == "ban").unwrap();
        assert_eq!((ban["discord"].as_str(), ban["module_name"].as_str()), (Some("/mod → ban"), Some("Moderation")));
        assert!(ban["fields"].as_array().unwrap().iter().any(|f| f["kind"] == "member" && f["required"] == true));
        let rank = list.iter().find(|c| c["name"] == "rank").unwrap();
        assert_eq!(rank["discord"], "/rank");
        assert_eq!(d.directory_view(g).unwrap()["channels"][0]["name"], "stars");
        // a command whose module is off says so; turn it on and it runs with the typed boxes
        let mut values = std::collections::BTreeMap::new();
        values.insert("channel".to_string(), ch.to_string());
        assert!(d.command_run(g, "starboard", Some("setup"), &values).unwrap_err().contains("turned off"));
        bot.db.get().set_module_enabled(g, "engagement", true).unwrap();
        let out = d.command_run(g, "starboard", Some("setup"), &values).unwrap();
        assert!(out["said"][0].as_str().unwrap().contains("Starboard is on"), "{out}");
        assert_eq!(bot.settings.text(g, "engagement", "starboardChannel").as_deref(), Some(ch));
        // missing boxes, unknown commands and commands with their own popup are refused in plain words
        assert!(d.command_run(g, "starboard", Some("setup"), &Default::default()).is_err() || d.command_run(g, "starboard", Some("setup"), &Default::default()).unwrap()["said"][0].as_str().unwrap().len() > 3);
        assert!(d.command_run(g, "nonsense", None, &Default::default()).unwrap_err().contains("does not exist"));
        assert!(d.command_run(g, "starboard", None, &values).unwrap_err().contains("Pick which part"));
        assert!(d.command_run(g, "greeting", None, &Default::default()).unwrap_err().contains("own popup"));
    }

    #[test]
    fn a_licence_is_checked_saved_and_carried_over_from_good_boy_3() {
        let tmp = tempfile::tempdir().unwrap();
        let appdata = tmp.path().join("appdata");
        let data3 = appdata.join("Good Boy").join("bot-data");
        std::fs::create_dir_all(&data3).unwrap();
        std::fs::write(data3.join("eclipse.db"), b"").unwrap();
        // a key Good Boy 3's app had saved: it is taken over, and checked when shown (this one is not genuine)
        std::fs::write(appdata.join("Good Boy").join("settings.json"), r#"{"license":"GB1.eyJ2IjoxfQ.AAAA"}"#).unwrap();
        let d = Desk::new(Folders { data: tmp.path().join("gb4"), old_app_data: Some(appdata) });
        let v = d.licence_view();
        assert_eq!(v["has_key"], true);
        assert_eq!(v["ok"], false, "a key that is not genuine does not count");
        // a made-up key cannot be saved, and removing the key works
        assert!(d.licence_set("GB1.junk.junk").is_err());
        assert!(d.licence_set("hello").is_err());
        assert_eq!(d.licence_set("").unwrap()["has_key"], false);
        // the choice is kept across a restart, and a removed key is not taken over again
        let again = Desk::new(Folders { data: tmp.path().join("gb4"), old_app_data: d.folders.old_app_data.clone() });
        assert_eq!(again.prefs().licence, "", "a key that was removed is not taken over again");
    }
}
