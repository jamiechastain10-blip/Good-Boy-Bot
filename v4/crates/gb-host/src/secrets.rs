//! The two secrets Good Boy holds: the bot token and the Discord client secret. They are kept by the operating
//! system (Windows Credential Manager, macOS Keychain), never in a file of Good Boy's own, and nothing here
//! hands one back to a screen: the launcher only ever learns whether one is saved.
//! On Linux (servers) there is no such store, so each secret is a file only the bot's own user can read: first a systemd
//! credential (LoadCredential=, in $CREDENTIALS_DIRECTORY), then GOODBOY_SECRETS_DIR (default ~/.config/goodboy/secrets).
//! DISCORD_TOKEN and DISCORD_CLIENT_SECRET still work as before.

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Secret {
    BotToken,
    ClientSecret,
    /// An extra bot that only plays music (number 1 to 9).
    Helper(u8),
}
impl Secret {
    fn name(self) -> String {
        match self {
            Secret::BotToken => "bot-token".into(),
            Secret::ClientSecret => "client-secret".into(),
            Secret::Helper(n) => format!("music-bot-{n}"),
        }
    }
}
/// How many extra music bots there can be.
pub const MOST_HELPERS: u8 = 9;

#[cfg(any(windows, target_os = "macos"))]
mod os {
    use super::Secret;
    fn entry(which: Secret) -> Result<keyring::Entry, String> {
        keyring::Entry::new("Good Boy 4", &which.name()).map_err(|e| e.to_string())
    }
    pub fn read(which: Secret) -> Option<String> {
        entry(which).ok()?.get_password().ok().filter(|t| !t.is_empty())
    }
    pub fn write(which: Secret, value: &str) -> Result<(), String> {
        entry(which)?.set_password(value).map_err(|e| e.to_string())
    }
    pub fn forget(which: Secret) -> Result<(), String> {
        match entry(which)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
mod os {
    use super::Secret;
    use std::path::PathBuf;
    /// Where secrets written by Good Boy itself go: GOODBOY_SECRETS_DIR, else ~/.config/goodboy/secrets.
    pub fn folder() -> Option<PathBuf> {
        if let Some(d) = std::env::var_os("GOODBOY_SECRETS_DIR").filter(|d| !d.is_empty()) { return Some(PathBuf::from(d)); }
        let base = std::env::var_os("XDG_CONFIG_HOME").filter(|d| !d.is_empty()).map(PathBuf::from).or_else(|| std::env::var_os("HOME").filter(|d| !d.is_empty()).map(|h| PathBuf::from(h).join(".config")))?;
        Some(base.join("goodboy").join("secrets"))
    }
    fn from_file(path: PathBuf) -> Option<String> {
        std::fs::read_to_string(path).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
    }
    fn from_env(which: Secret) -> Option<String> {
        let key = match which { Secret::ClientSecret => "DISCORD_CLIENT_SECRET", _ => return None };
        std::env::var(key).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
    }
    pub fn read(which: Secret) -> Option<String> {
        let name = which.name();
        std::env::var_os("CREDENTIALS_DIRECTORY").filter(|d| !d.is_empty()).and_then(|d| from_file(PathBuf::from(d).join(&name)))
            .or_else(|| folder().and_then(|d| from_file(d.join(&name))))
            .or_else(|| from_env(which))
    }
    pub fn write(which: Secret, value: &str) -> Result<(), String> {
        use std::io::Write as _;
        use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _, PermissionsExt as _};
        let dir = folder().ok_or("there is no home folder to keep it in (set GOODBOY_SECRETS_DIR)")?;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir).map_err(|e| e.to_string())?;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        let path = dir.join(which.name());
        let tmp = dir.join(format!(".{}.tmp", which.name()));
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).map_err(|e| e.to_string())?;
        f.write_all(value.trim().as_bytes()).and_then(|_| f.sync_all()).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }
    pub fn forget(which: Secret) -> Result<(), String> {
        let Some(dir) = folder() else { return Ok(()) };
        match std::fs::remove_file(dir.join(which.name())) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}
pub use os::{forget, read, write};

pub fn saved(which: Secret) -> bool {
    read(which).is_some()
}

/// A Discord bot token has three parts separated by dots. This only catches obvious slips (a client secret,
/// an empty paste); Discord itself says whether the token is real.
pub fn looks_like_a_token(t: &str) -> bool {
    let parts: Vec<&str> = t.trim().split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| p.len() >= 5 && p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
}
/// A client secret is one run of 32 letters, digits, dashes and underscores. A bot token pasted here by mistake has dots.
pub fn looks_like_a_client_secret(t: &str) -> bool {
    let t = t.trim();
    (24..=64).contains(&t.len()) && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn on_linux_a_secret_is_a_file_only_the_bot_can_read() {
        use std::os::unix::fs::PermissionsExt as _;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("secrets");
        std::env::set_var("GOODBOY_SECRETS_DIR", &dir);
        std::env::remove_var("CREDENTIALS_DIRECTORY");
        assert_eq!(read(Secret::Helper(9)), None);
        write(Secret::Helper(9), " abc.def.ghi \n").unwrap();
        assert_eq!(read(Secret::Helper(9)).as_deref(), Some("abc.def.ghi"));
        let mode = std::fs::metadata(dir.join("music-bot-9")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "only the owner may read it");
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        // a systemd credential comes first
        let creds = tmp.path().join("creds");
        std::fs::create_dir_all(&creds).unwrap();
        std::fs::write(creds.join("music-bot-9"), "from.systemd.cred").unwrap();
        std::env::set_var("CREDENTIALS_DIRECTORY", &creds);
        assert_eq!(read(Secret::Helper(9)).as_deref(), Some("from.systemd.cred"));
        std::env::remove_var("CREDENTIALS_DIRECTORY");
        forget(Secret::Helper(9)).unwrap();
        forget(Secret::Helper(9)).unwrap();
        assert_eq!(read(Secret::Helper(9)), None);
        std::env::remove_var("GOODBOY_SECRETS_DIR");
    }

    #[test]
    fn tokens_that_are_obviously_not_tokens() {
        assert!(looks_like_a_token("MTAwMDAwMDAwMDAwMDAwMDAw.Gabcde.abcdefghijklmnopqrstuvwxyz0123456789ABCD"));
        assert!(looks_like_a_token("  MTAwMDAwMDAw.Gab-de.abc_efghij  "));
        for bad in ["", "hello", "a.b.c", "abcdefghijklmnopqrstuvwxyz123456", "has spaces.in the.token here"] {
            assert!(!looks_like_a_token(bad), "{bad}");
        }
    }
    #[test]
    fn a_token_is_not_mistaken_for_a_client_secret_or_the_other_way_round() {
        let secret = "abcdefghijklmnopqrstuvwxyz_12345";
        let token = "MTAwMDAwMDAwMDAwMDAwMDAw.Gabcde.abcdefghijklmnopqrstuvwxyz0123456789ABCD";
        assert!(looks_like_a_client_secret(secret) && !looks_like_a_token(secret));
        assert!(looks_like_a_token(token) && !looks_like_a_client_secret(token));
        assert!(!looks_like_a_client_secret("short"));
    }
}
