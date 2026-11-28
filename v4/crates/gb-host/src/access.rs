//! Basic Ghost Labs - Good Boy 4. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
//!
//! Who else may come into the web dashboard, and the record of what was done there.
//!
//! - People the owner lets in: a Discord account, for every server or only some. They sign in with Discord as usual and
//!   get the dashboard for those servers, even without Manage Server. Only the owner may change the list.
//! - Basic Ghost Labs support, only on a bot that Basic Ghost Labs hosts: a staff member opens a pass from the Basic
//!   Ghost Labs site (signed by its key, for this one bot, good to open for a few minutes and used once). It lets them
//!   see the bot's health and start, stop, restart or check for updates, and nothing about the servers, members,
//!   messages, tickets or settings. Tokens and secrets are never given out over the web to anyone. The owner can turn
//!   support off.
//! - The access log: sign-ins and every change made over the web, with who did it. It never holds what was typed (a
//!   message, a reason or a setting's value), only what kind of thing was done and in which server.
//!
//! Hosted settings: GOODBOY_HOSTED_ID (the hosting subscription's id) and GOODBOY_MAINTAIN_KEY (the site's public key,
//! base64, either the 32 raw bytes or the SPKI form the site prints). GOODBOY_OWNER_IDS: extra owner Discord ids
//! (comma separated), for a bot owned by a Discord team.
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// How long a support pass may wait before it is opened, and how long the visit then lasts.
pub const PASS_OPEN_MS: i64 = 15 * 60_000;
pub const SUPPORT_VISIT_MS: i64 = 60 * 60_000;
const LOG_MAX_BYTES: u64 = 1024 * 1024;
const MOST_PEOPLE: usize = 100;

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
fn is_discord_id(s: &str) -> bool { (17..=20).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit()) }

/// Someone the owner let in.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Person {
    pub user: String,
    pub name: String,
    /// The servers they may manage. Empty: every server the bot is in.
    #[serde(default)]
    pub guilds: Vec<String>,
    pub added: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Kept {
    #[serde(default)]
    people: Vec<Person>,
    #[serde(default = "yes")]
    support_on: bool,
}
fn yes() -> bool { true }
impl Default for Kept { fn default() -> Self { Kept { people: Vec::new(), support_on: true } } }

/// This bot as Basic Ghost Labs hosts it.
#[derive(Clone, Debug)]
pub struct Hosted { pub id: String, key: [u8; 32] }
impl Hosted {
    /// From GOODBOY_HOSTED_ID and GOODBOY_MAINTAIN_KEY. None on a bot people run themselves.
    pub fn from(get: &dyn Fn(&str) -> Option<String>) -> Option<Hosted> {
        let id = get("GOODBOY_HOSTED_ID").map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && s.len() <= 80 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))?;
        let raw = get("GOODBOY_MAINTAIN_KEY")?;
        let clean: String = raw.lines().filter(|l| !l.starts_with("-----")).collect::<String>().split_whitespace().collect();
        let bytes = base64::engine::general_purpose::STANDARD.decode(clean.as_bytes()).ok()?;
        // the SPKI form is a 12-byte header and then the key
        let key: [u8; 32] = match bytes.len() { 32 => bytes.try_into().ok()?, 44 => bytes[12..].try_into().ok()?, _ => return None };
        Some(Hosted { id, key })
    }
}

/// A support visit, from a pass that checked out.
#[derive(Clone, Debug, PartialEq)]
pub struct Visit { pub staff: String, pub name: String, pub reason: String, pub until: i64 }

pub struct Access {
    file: PathBuf,
    log: PathBuf,
    lock: Mutex<()>,
    used: Mutex<HashMap<String, i64>>,
    pub hosted: Option<Hosted>,
    pub owners: Vec<String>,
}

fn b64url(s: &str) -> Option<Vec<u8>> { base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s.trim_end_matches('=').as_bytes()).ok() }

impl Access {
    pub fn open(data: &Path, get: &dyn Fn(&str) -> Option<String>) -> Access {
        let owners = get("GOODBOY_OWNER_IDS").unwrap_or_default().split(',').map(str::trim).filter(|s| is_discord_id(s)).map(str::to_string).collect();
        Access { file: data.join("access.json"), log: data.join("access-log.jsonl"), lock: Mutex::new(()), used: Mutex::new(HashMap::new()), hosted: Hosted::from(get), owners }
    }
    fn kept(&self) -> Kept { std::fs::read_to_string(&self.file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default() }
    fn keep(&self, k: &Kept) -> Result<(), String> {
        if let Some(dir) = self.file.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
        let tmp = self.file.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(k).unwrap_or_default()).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.file).map_err(|e| e.to_string())
    }
    pub fn people(&self) -> Vec<Person> { self.kept().people }
    pub fn person(&self, user: &str) -> Option<Person> { self.kept().people.into_iter().find(|p| p.user == user) }
    /// Support may come in: the bot is hosted by Basic Ghost Labs and the owner has not turned it off.
    pub fn support_on(&self) -> bool { self.hosted.is_some() && self.kept().support_on }

    /// Lets someone in (or changes which servers they have). `guilds` empty: every server.
    pub fn add(&self, user: &str, name: &str, guilds: Vec<String>) -> Result<Person, String> {
        let user = user.trim();
        if !is_discord_id(user) { return Err("That is not a Discord user ID. In Discord, turn on Developer Mode, right-click the person and press Copy User ID.".into()); }
        if guilds.iter().any(|g| !is_discord_id(g)) { return Err("One of the servers is not a server ID.".into()); }
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut k = self.kept();
        let name = name.trim().chars().take(60).collect::<String>();
        let person = Person { user: user.into(), name: if name.is_empty() { user.into() } else { name }, guilds, added: now_ms() };
        match k.people.iter_mut().find(|p| p.user == user) {
            Some(p) => *p = Person { added: p.added, ..person.clone() },
            None => { if k.people.len() >= MOST_PEOPLE { return Err(format!("You can let in up to {MOST_PEOPLE} people.")); } k.people.push(person.clone()); }
        }
        self.keep(&k)?;
        Ok(person)
    }
    pub fn remove(&self, user: &str) -> Result<bool, String> {
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut k = self.kept();
        let before = k.people.len();
        k.people.retain(|p| p.user != user);
        self.keep(&k)?;
        Ok(k.people.len() != before)
    }
    pub fn set_support(&self, on: bool) -> Result<(), String> {
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut k = self.kept();
        k.support_on = on;
        self.keep(&k)
    }

    /// Checks a support pass: `<payload>.<signature>`, both base64url. The payload is JSON
    /// { kind: "bgl-maintain", sub, staff, name, reason, exp, id }, signed (Ed25519) over "bgl-maintain\n<payload>".
    pub fn check_pass(&self, pass: &str, now: i64) -> Result<Visit, String> {
        use ed25519_dalek::{Signature, Verifier, VerifyingKey};
        let hosted = self.hosted.as_ref().ok_or("This bot is not hosted by Basic Ghost Labs, so support passes do not work here.")?;
        if !self.support_on() { return Err("The owner of this bot has turned Basic Ghost Labs support access off.".into()); }
        let (body, sig) = pass.trim().split_once('.').ok_or("That pass is not complete.")?;
        let sig = b64url(sig).and_then(|s| <[u8; 64]>::try_from(s.as_slice()).ok()).ok_or("That pass is not complete.")?;
        let key = VerifyingKey::from_bytes(&hosted.key).map_err(|_| "This bot's support key is not right.")?;
        key.verify(format!("bgl-maintain\n{body}").as_bytes(), &Signature::from_bytes(&sig)).map_err(|_| "That pass was not made by Basic Ghost Labs.")?;
        let p: Value = b64url(body).and_then(|b| serde_json::from_slice(&b).ok()).ok_or("That pass is not complete.")?;
        if p["kind"] != "bgl-maintain" { return Err("That is not a support pass.".into()); }
        if p["sub"].as_str() != Some(hosted.id.as_str()) { return Err("That pass is for a different bot.".into()); }
        let exp = p["exp"].as_i64().unwrap_or(0);
        if exp <= now { return Err("That pass has run out. Make a new one.".into()); }
        if exp - now > PASS_OPEN_MS + 60_000 { return Err("That pass lasts too long to be one of ours.".into()); }
        let id = p["id"].as_str().filter(|s| !s.is_empty()).ok_or("That pass is not complete.")?.to_string();
        {
            let mut used = self.used.lock().unwrap_or_else(|x| x.into_inner());
            used.retain(|_, t| *t > now);
            if used.contains_key(&id) { return Err("That pass was already used. Make a new one.".into()); }
            used.insert(id, exp);
        }
        let text = |k: &str, n: usize| p[k].as_str().unwrap_or("").chars().filter(|c| !c.is_control()).take(n).collect::<String>();
        let staff = text("staff", 120);
        if staff.is_empty() { return Err("That pass does not say who it is for.".into()); }
        Ok(Visit { name: { let n = text("name", 60); if n.is_empty() { staff.clone() } else { n } }, staff, reason: text("reason", 200), until: now + SUPPORT_VISIT_MS })
    }

    // ---- the access log
    /// Writes one line. `what` is the kind of thing done, never what was typed.
    #[allow(clippy::too_many_arguments)]
    pub fn note(&self, who: &str, name: &str, role: &str, what: &str, guild: Option<&str>, ok: bool, detail: &str) {
        use std::io::Write as _;
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        if std::fs::metadata(&self.log).map(|m| m.len() > LOG_MAX_BYTES).unwrap_or(false) { let _ = std::fs::rename(&self.log, self.log.with_extension("jsonl.1")); }
        let line = json!({ "at": now_ms(), "who": who, "name": name, "role": role, "what": what, "guild": guild, "ok": ok, "detail": detail.chars().take(200).collect::<String>() });
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&self.log) { let _ = writeln!(f, "{line}"); }
    }
    /// The newest lines first.
    pub fn log(&self, most: usize) -> Vec<Value> {
        let read = |p: &Path| std::fs::read_to_string(p).unwrap_or_default();
        let text = format!("{}{}", read(&self.log.with_extension("jsonl.1")), read(&self.log));
        let mut out: Vec<Value> = text.lines().rev().filter_map(|l| serde_json::from_str(l).ok()).take(most).collect();
        out.shrink_to_fit();
        out
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    pub fn key() -> SigningKey { SigningKey::from_bytes(&[7u8; 32]) }
    fn spki(k: &SigningKey) -> String {
        let mut b = vec![0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
        b.extend_from_slice(k.verifying_key().as_bytes());
        base64::engine::general_purpose::STANDARD.encode(b)
    }
    pub fn hosted(dir: &Path, k: &SigningKey) -> Access {
        let pk = spki(k);
        Access::open(dir, &move |n| match n { "GOODBOY_HOSTED_ID" => Some("sub_abc123".into()), "GOODBOY_MAINTAIN_KEY" => Some(pk.clone()), "GOODBOY_OWNER_IDS" => Some("123456789012345678, nope".into()), _ => None })
    }
    pub fn pass(k: &SigningKey, sub: &str, exp: i64, id: &str) -> String {
        let body = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json!({ "kind": "bgl-maintain", "sub": sub, "staff": "sam@basicghostlabs.com", "name": "Sam", "reason": "bot offline", "exp": exp, "id": id }).to_string());
        let sig = k.sign(format!("bgl-maintain\n{body}").as_bytes());
        format!("{body}.{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes()))
    }

    #[test]
    fn a_support_pass_works_once_for_this_bot_only_and_not_for_long() {
        let tmp = tempfile::tempdir().unwrap();
        let a = hosted(tmp.path(), &key());
        assert_eq!(a.owners, vec!["123456789012345678".to_string()]);
        let now = 1_000_000_000_000;
        let v = a.check_pass(&pass(&key(), "sub_abc123", now + 60_000, "p1"), now).unwrap();
        assert_eq!((v.staff.as_str(), v.name.as_str(), v.until), ("sam@basicghostlabs.com", "Sam", now + SUPPORT_VISIT_MS));
        assert!(a.check_pass(&pass(&key(), "sub_abc123", now + 60_000, "p1"), now).unwrap_err().contains("already used"));
        assert!(a.check_pass(&pass(&key(), "sub_other", now + 60_000, "p2"), now).unwrap_err().contains("different bot"));
        assert!(a.check_pass(&pass(&key(), "sub_abc123", now - 1, "p3"), now).unwrap_err().contains("run out"));
        assert!(a.check_pass(&pass(&key(), "sub_abc123", now + 86_400_000, "p4"), now).unwrap_err().contains("too long"));
        let stranger = SigningKey::from_bytes(&[9u8; 32]);
        assert!(a.check_pass(&pass(&stranger, "sub_abc123", now + 60_000, "p5"), now).unwrap_err().contains("not made by"));
        let mut bad = pass(&key(), "sub_abc123", now + 60_000, "p6");
        bad.insert(3, 'x');
        assert!(a.check_pass(&bad, now).is_err(), "a changed pass fails");
        // the owner can turn support off
        a.set_support(false).unwrap();
        assert!(!a.support_on());
        assert!(a.check_pass(&pass(&key(), "sub_abc123", now + 60_000, "p7"), now).unwrap_err().contains("turned"));
    }

    #[test]
    fn a_bot_people_run_themselves_never_lets_support_in() {
        let tmp = tempfile::tempdir().unwrap();
        let a = Access::open(tmp.path(), &|_| None);
        assert!(a.hosted.is_none() && !a.support_on());
        assert!(a.check_pass(&pass(&key(), "sub_abc123", now_ms() + 60_000, "x"), now_ms()).unwrap_err().contains("not hosted"));
    }

    #[test]
    fn the_owner_lets_people_in_and_the_log_keeps_who_did_what_but_not_what_was_typed() {
        let tmp = tempfile::tempdir().unwrap();
        let a = Access::open(tmp.path(), &|_| None);
        assert!(a.add("not an id", "", vec![]).is_err());
        a.add("223456789012345678", "Ari", vec!["323456789012345678".into()]).unwrap();
        a.add("223456789012345678", "Ari B", vec![]).unwrap();
        assert_eq!(a.people().len(), 1);
        assert_eq!(a.person("223456789012345678").unwrap().name, "Ari B");
        assert!(a.person("223456789012345678").unwrap().guilds.is_empty(), "changed to every server");
        assert!(a.remove("223456789012345678").unwrap());
        assert!(!a.remove("223456789012345678").unwrap());
        a.note("1", "Jamie", "owner", "module_set", Some("323456789012345678"), true, "");
        a.note("sam@basicghostlabs.com", "Sam", "support", "bot_restart", None, true, "");
        let log = a.log(10);
        assert_eq!(log.len(), 2);
        assert_eq!(log[0]["what"], "bot_restart", "newest first");
        assert_eq!(log[1]["guild"], "323456789012345678");
    }
}
