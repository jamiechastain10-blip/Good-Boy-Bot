//! The Good Boy hub connection. Publishes only this bot's server IDs and public dashboard link.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
struct SavedKey {
    #[serde(rename = "publicKey")]
    public_key: String,
    #[serde(rename = "privateKey")]
    private_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignedText<'a> {
    app_id: &'a str,
    url: Option<&'a str>,
    guilds: Option<&'a [String]>,
    at: i64,
    leave: bool,
}

pub struct Hub {
    base: String,
    data: PathBuf,
    app_id: String,
    token: String,
    url: String,
    description: String,
    http: reqwest::Client,
}

impl Hub {
    pub fn new(data: &Path, app_id: String, token: String, url: String, description: String) -> Hub {
        Hub {
            base: std::env::var("GOODBOY_HUB_URL").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "https://goodboyhub.pages.dev".into()).trim_end_matches('/').to_string(),
            data: data.to_path_buf(),
            app_id,
            token,
            url: url.trim_end_matches('/').to_string(),
            description,
            http: reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).user_agent("GoodBoy/4 hub").build().unwrap_or_default(),
        }
    }

    fn key(&self) -> Result<(SavedKey, SigningKey), String> {
        let path = self.data.join("hub-key.json");
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(saved) = serde_json::from_str::<SavedKey>(&text) {
                if let Some(seed) = decode_private(&saved.private_key) {
                    return Ok((saved, SigningKey::from_bytes(&seed)));
                }
            }
        }
        let mut seed = [0u8; 32];
        getrandom::getrandom(&mut seed).map_err(|e| format!("Could not make a hub key: {e}"))?;
        let signing = SigningKey::from_bytes(&seed);
        let mut pub_der = hex_prefix("302a300506032b6570032100");
        pub_der.extend_from_slice(signing.verifying_key().as_bytes());
        let mut private_der = hex_prefix("302e020100300506032b657004220420");
        private_der.extend_from_slice(&seed);
        let saved = SavedKey {
            public_key: STANDARD.encode(pub_der),
            private_key: format!("-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----", STANDARD.encode(private_der)),
        };
        std::fs::create_dir_all(&self.data).map_err(|e| e.to_string())?;
        let temp = path.with_extension("tmp");
        std::fs::write(&temp, serde_json::to_vec(&saved).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(temp, path).map_err(|e| e.to_string())?;
        Ok((saved, signing))
    }

    async fn post(&self, path: &str, body: &Value) -> Result<(bool, Value), String> {
        let response = self.http.post(format!("{}{path}", self.base)).json(body).send().await.map_err(|e| e.to_string())?;
        let ok = response.status().is_success();
        let data = response.json::<Value>().await.unwrap_or(Value::Null);
        Ok((ok, data))
    }

    async fn edit_description(&self, description: &str) -> Result<(), String> {
        let response = self.http.patch("https://discord.com/api/v10/applications/@me")
            .header(reqwest::header::AUTHORIZATION, format!("Bot {}", self.token))
            .json(&json!({ "description": description }))
            .send().await.map_err(|e| e.to_string())?;
        if response.status().is_success() { Ok(()) }
        else { Err(format!("Discord did not accept the temporary hub proof (HTTP {}).", response.status())) }
    }

    pub async fn register(&self, guilds: &[String]) -> Result<(), String> {
        if !self.url.starts_with("https://") { return Ok(()); }
        let (key, signing) = self.key()?;
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let signed = serde_json::to_vec(&SignedText { app_id: &self.app_id, url: Some(&self.url), guilds: Some(guilds), at, leave: false }).map_err(|e| e.to_string())?;
        let signature = STANDARD.encode(signing.sign(&signed).to_bytes());
        let body = || json!({ "appId": self.app_id, "publicKey": key.public_key, "url": self.url, "guilds": guilds, "at": at, "sig": signature });
        let (ok, data) = self.post("/v1/register", &body()).await?;
        if ok { return Ok(()); }
        if data["needsProof"] != true { return Err(data["error"].as_str().unwrap_or("The hub rejected this bot.").to_string()); }

        let (ok, challenge) = self.post("/v1/challenge", &json!({ "appId": self.app_id })).await?;
        let nonce = challenge["nonce"].as_str().filter(|n| n.len() == 20 && n.bytes().all(|b| b.is_ascii_hexdigit())).ok_or_else(|| "The hub did not provide a bot ownership code.".to_string())?.to_string();
        if !ok { return Err("The hub could not verify bot ownership.".into()); }
        let clean = self.description.lines().filter(|line| !line.contains("gb-hub:")).collect::<Vec<_>>().join("\n");
        let proof = format!("{clean}\ngb-hub:{nonce}");
        self.edit_description(&proof.chars().take(400).collect::<String>()).await?;
        let result = self.post("/v1/register", &json!({ "appId": self.app_id, "publicKey": key.public_key, "url": self.url, "guilds": guilds, "at": at, "sig": signature, "nonce": nonce })).await;
        let restored = self.edit_description(&clean).await;
        let (ok, data) = result?;
        restored?;
        if ok { Ok(()) } else { Err(data["error"].as_str().unwrap_or("The hub rejected this bot.").to_string()) }
    }
}

fn hex_prefix(value: &str) -> Vec<u8> {
    value.as_bytes().chunks_exact(2).map(|pair| {
        let digit = |b| if b.is_ascii_digit() { b - b'0' } else { b.to_ascii_lowercase() - b'a' + 10 };
        digit(pair[0]) * 16 + digit(pair[1])
    }).collect()
}

fn decode_private(value: &str) -> Option<[u8; 32]> {
    let encoded = value.lines().filter(|line| !line.starts_with("-----")).collect::<String>();
    let der = STANDARD.decode(encoded).ok()?;
    if der.len() < 32 { return None; }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&der[der.len() - 32..]);
    Some(seed)
}
