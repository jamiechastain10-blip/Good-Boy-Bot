//! The two secrets Good Boy holds: the bot token and the Discord client secret. They are kept by the operating
//! system (Windows Credential Manager, macOS Keychain), never in a file of Good Boy's own, and nothing here
//! hands one back to a screen: the launcher only ever learns whether one is saved.
//! On other systems nothing is saved; the token comes from DISCORD_TOKEN.

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Secret {
    BotToken,
    ClientSecret,
    /// An extra bot that only plays music (number 1 to 9).
    Helper(u8),
}
impl Secret {
    #[cfg(any(windows, target_os = "macos"))]
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
    pub fn read(_: Secret) -> Option<String> {
        None
    }
    pub fn write(_: Secret, _: &str) -> Result<(), String> {
        Err("this system has no credential store Good Boy uses yet, so it was not saved (set DISCORD_TOKEN instead)".into())
    }
    pub fn forget(_: Secret) -> Result<(), String> {
        Ok(())
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
