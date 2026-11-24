//! Good Boy licence keys, the same ones Good Boy 3 reads (`GB1.<payload>.<signature>`).
//!
//! Licence Studio signs a key with a private key that never leaves the owner's computer; every Good Boy checks it
//! with the matching public key. A key names one bot (its application ID), what it unlocks and until when, so it
//! cannot be moved to another bot or have its date changed. Because Good Boy 4 keeps the same bot and token, a
//! licence carries over from Good Boy 3 unchanged.

use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;

/// The public key every Good Boy checks licences with (the same file Good Boy 3 ships).
pub const PUBLIC_KEY_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAqqEyB1bxUMqXHZloy4OrSZFbRRcXPjAyNrYvmpqqVEo=\n-----END PUBLIC KEY-----\n";
/// Where the owner publishes the list of cancelled licences (signed by Licence Studio).
pub const CANCEL_LIST_URL: &str = "https://goodboyhub.pages.dev/v1/cancel-list/goodboy";
const PREFIX: &str = "GB1";

/// What a key says.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Payload {
    pub v: u32,
    pub id: String,
    pub app: String,
    #[serde(default)]
    pub to: String,
    pub features: Vec<String>,
    pub iat: i64,
    /// When it ends (milliseconds since 1970); none for a lifetime licence.
    pub exp: Option<i64>,
}

/// The result of checking a key.
#[derive(Debug, Clone, PartialEq)]
pub struct Check {
    pub ok: bool,
    pub error: Option<String>,
    pub expired: bool,
    pub payload: Option<Payload>,
}
impl Check {
    fn bad(error: &str) -> Check { Check { ok: false, error: Some(error.into()), expired: false, payload: None } }
    /// Whether the key is good and unlocks `feature`.
    pub fn has(&self, feature: &str) -> bool { self.ok && self.payload.as_ref().is_some_and(|p| p.features.iter().any(|f| f == feature)) }
}

/// The 32 bytes of an Ed25519 public key from a PEM (SubjectPublicKeyInfo) file.
fn key_bytes(pem: &str) -> Option<[u8; 32]> {
    let body: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
    let der = STANDARD.decode(body.trim()).ok()?;
    // a 12-byte header, then the key
    (der.len() == 44).then(|| der[12..44].try_into().ok()).flatten()
}

fn signed_by(public_pem: &str, message: &[u8], signature: &str) -> bool {
    let (Some(key), Ok(sig)) = (key_bytes(public_pem), URL_SAFE_NO_PAD.decode(signature)) else { return false };
    let (Ok(key), Ok(sig)) = (VerifyingKey::from_bytes(&key), Signature::from_slice(&sig)) else { return false };
    key.verify(message, &sig).is_ok()
}

/// Checks a key. `app_id`: the bot this install runs (the key must be for it). `revoked`: IDs of cancelled keys.
pub fn verify(key: &str, public_pem: &str, app_id: Option<&str>, now_ms: i64, revoked: &[String]) -> Check {
    let key = key.trim();
    let parts: Vec<&str> = key.split('.').collect();
    if parts.len() != 3 || parts[0] != PREFIX { return Check::bad("That is not a Good Boy licence key."); }
    if key_bytes(public_pem).is_none() { return Check::bad("Licences are not switched on in this version yet."); }
    if !signed_by(public_pem, format!("{PREFIX}.{}", parts[1]).as_bytes(), parts[2]) { return Check::bad("This licence key is not genuine, or it was changed."); }
    let Some(p) = URL_SAFE_NO_PAD.decode(parts[1]).ok().and_then(|b| serde_json::from_slice::<Payload>(&b).ok()) else { return Check::bad("That is not a Good Boy licence key.") };
    let digits = |s: &str| (17..=20).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit());
    if p.v != 1 || !digits(&p.app) { return Check::bad("That is not a Good Boy licence key."); }
    let fail = |error: String, expired: bool| Check { ok: false, error: Some(error), expired, payload: Some(p.clone()) };
    if revoked.contains(&p.id) { return fail("This licence was cancelled by Basic Ghost Labs.".into(), false); }
    if app_id.is_some_and(|a| a != p.app) { return fail("This licence is for a different bot.".into(), false); }
    if p.exp.is_some_and(|e| e <= now_ms) { return fail("This licence has ended.".into(), true); }
    Check { ok: true, error: None, expired: false, payload: Some(p) }
}

#[derive(Deserialize)]
struct CancelFile { body: String, sig: String }
#[derive(Deserialize)]
struct CancelBody { v: u32, at: i64, revoked: Vec<String> }

/// Reads a cancel list from Licence Studio. Returns (when it was made, the cancelled IDs) only if it was signed with
/// the owner's key.
pub fn read_cancel_list(text: &str, public_pem: &str) -> Option<(i64, Vec<String>)> {
    let f: CancelFile = serde_json::from_str(text).ok()?;
    if f.body.len() > 500_000 || !signed_by(public_pem, f.body.as_bytes(), &f.sig) { return None; }
    let b: CancelBody = serde_json::from_str(&f.body).ok()?;
    (b.v == 1).then(|| (b.at, b.revoked.into_iter().filter(|x| x.len() == 12 && x.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())).collect()))
}

/// The licence key Good Boy 3's app kept, found next to its bot data (`from` is the folder that holds eclipse.db; the
/// app's settings are in the folder above it).
pub fn read_3x_licence(from: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(from.parent()?.join("settings.json")).ok()?;
    let key = serde_json::from_str::<serde_json::Value>(&text).ok()?.get("license")?.as_str()?.trim().to_string();
    (key.starts_with("GB1.") && key.len() <= 2048 && key.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))).then_some(key)
}

/// The bot's application ID, read from the first part of its token (there is no secret in it).
pub fn app_id_of(token: &str) -> Option<String> {
    let id = String::from_utf8(URL_SAFE_NO_PAD.decode(token.split('.').next()?.trim_end_matches('=')).ok()?).ok()?;
    ((17..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())).then_some(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    /// A key pair made for the tests, and a licence signed with it.
    fn pair() -> (SigningKey, String) {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let mut der = vec![0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
        der.extend_from_slice(sk.verifying_key().as_bytes());
        (sk, format!("-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n", STANDARD.encode(der)))
    }
    fn licence(sk: &SigningKey, app: &str, exp: Option<i64>) -> String {
        let payload = serde_json::json!({ "v": 1, "id": "0123456789ab", "app": app, "to": "Kai", "features": ["whitelabel"], "iat": 1, "exp": exp });
        let body = URL_SAFE_NO_PAD.encode(payload.to_string());
        let sig = sk.sign(format!("{PREFIX}.{body}").as_bytes());
        format!("{PREFIX}.{body}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
    }
    const APP: &str = "123456789012345678";

    #[test]
    fn the_shipped_public_key_parses() {
        assert!(key_bytes(PUBLIC_KEY_PEM).is_some());
    }
    #[test]
    fn a_good_key_is_accepted_for_its_own_bot_only() {
        let (sk, pem) = pair();
        let k = licence(&sk, APP, None);
        let c = verify(&k, &pem, Some(APP), 1000, &[]);
        assert!(c.ok && c.has("whitelabel") && !c.has("other"), "{c:?}");
        assert_eq!(c.payload.as_ref().map(|p| p.to.as_str()), Some("Kai"));
        let other = verify(&k, &pem, Some("999999999999999999"), 1000, &[]);
        assert!(!other.ok && other.error.as_deref() == Some("This licence is for a different bot."));
    }
    #[test]
    fn changed_cancelled_and_ended_keys_are_refused() {
        let (sk, pem) = pair();
        let k = licence(&sk, APP, Some(5000));
        assert!(verify(&k, &pem, Some(APP), 4999, &[]).ok);
        let ended = verify(&k, &pem, Some(APP), 5000, &[]);
        assert!(!ended.ok && ended.expired);
        let cancelled = verify(&k, &pem, Some(APP), 1, &["0123456789ab".into()]);
        assert!(!cancelled.ok && cancelled.error.as_deref() == Some("This licence was cancelled by Basic Ghost Labs."));
        // a changed payload no longer matches its signature
        let mut parts: Vec<String> = k.split('.').map(str::to_string).collect();
        parts[1] = URL_SAFE_NO_PAD.encode(serde_json::json!({ "v": 1, "id": "0123456789ab", "app": APP, "to": "Kai", "features": ["whitelabel"], "iat": 1, "exp": 999999999999i64 }).to_string());
        assert!(!verify(&parts.join("."), &pem, Some(APP), 1, &[]).ok);
        // a key from someone else's key pair
        let (other_sk, _) = (SigningKey::from_bytes(&[9u8; 32]), ());
        assert!(!verify(&licence(&other_sk, APP, None), &pem, Some(APP), 1, &[]).ok);
        for junk in ["", "GB1.x", "hello.world.now", "GB1.a.b"] { assert!(!verify(junk, &pem, None, 1, &[]).ok, "{junk}"); }
    }
    #[test]
    fn a_cancel_list_counts_only_when_signed() {
        let (sk, pem) = pair();
        let body = serde_json::json!({ "v": 1, "at": 42, "revoked": ["0123456789ab", "not-an-id"] }).to_string();
        let sig = URL_SAFE_NO_PAD.encode(sk.sign(body.as_bytes()).to_bytes());
        let file = serde_json::json!({ "body": body, "sig": sig }).to_string();
        assert_eq!(read_cancel_list(&file, &pem), Some((42, vec!["0123456789ab".to_string()])));
        let forged = serde_json::json!({ "body": body.replace("42", "43"), "sig": sig }).to_string();
        assert_eq!(read_cancel_list(&forged, &pem), None);
        assert_eq!(read_cancel_list("not json", &pem), None);
    }
    #[test]
    fn a_licence_is_found_in_good_boy_3s_settings() {
        let dir = std::env::temp_dir().join(format!("gb-licence-test-{}", std::process::id()));
        let data = dir.join("Good Boy").join("bot-data");
        std::fs::create_dir_all(&data).unwrap();
        assert_eq!(read_3x_licence(&data), None);
        std::fs::write(dir.join("Good Boy").join("settings.json"), r#"{"license":" GB1.abc.def "}"#).unwrap();
        assert_eq!(read_3x_licence(&data).as_deref(), Some("GB1.abc.def"));
        std::fs::write(dir.join("Good Boy").join("settings.json"), r#"{"license":"<script>"}"#).unwrap();
        assert_eq!(read_3x_licence(&data), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn the_bots_id_is_read_from_its_token() {
        let token = format!("{}.abc.def", URL_SAFE_NO_PAD.encode(APP));
        assert_eq!(app_id_of(&token).as_deref(), Some(APP));
        assert_eq!(app_id_of("nonsense"), None);
    }
}
