//! Good Boy 3's image quotes: right-click a message > Apps > "Quote Image" (black and white) or "Quote Image
//! (Color)", or `/quote message:<link or ID> [style]`. Every quote is a GIF when it can be (the picture slowly zooms
//! with a shine; an animated profile picture moves) and a still picture otherwise. Quotes made elsewhere go to the
//! quote channel when one is set. The Discord layer reads the message and draws the picture; this checks the ask.

use crate::bot::{CommandSpec, Opt, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::{Action, Area, Card, CommandEvent, Db, Def, Kind, Settings};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub const MODULE: &str = "quotes";
pub const USE: Perm = Perm { key: "quotes.use", level: Level::Everyone };
pub static SETTINGS: &[Def] = &[
    Def { key: "motionQuotes", label: "Make every quote a GIF (normal profile pictures get a slow zoom and a shine)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "animatedQuotes", label: "Animated quotes for members with an animated profile picture", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "quoteStyle", label: "Look of image quotes: classic, midnight, paper, sunset, forest, pixel, or custom (needs a licence)", kind: Kind::Select(&["classic", "midnight", "paper", "sunset", "forest", "pixel", "custom"]), default: Fallback::Str("classic") },
    Def { key: "pixelPictures", label: "Draw profile pictures as pixel art on rank cards and family trees (and on pixel quotes)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "quoteColourBg", label: "Custom quote: background colour", kind: Kind::Colour, default: Fallback::Str("#101820") },
    Def { key: "quoteColourText", label: "Custom quote: text colour", kind: Kind::Colour, default: Fallback::Str("#ffffff") },
    Def { key: "quoteColourAccent", label: "Custom quote: accent colour", kind: Kind::Colour, default: Fallback::Str("#ff7a59") },
    Def { key: "quoteFont", label: "Custom quote: font (sans, serif or mono)", kind: Kind::Select(&["sans", "serif", "mono"]), default: Fallback::Str("sans") },
    Def { key: "selfQuotes", label: "Let members quote their own messages (off = only other people's)", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "quoteChannel", label: "Channel where image quotes are posted", kind: Kind::Channel, default: Fallback::None },
];
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "quote", about: "Turn a message into an image quote", module: MODULE, options: &[
    Opt { name: "message", about: "Message link (Copy Message Link) or ID from this channel", takes: Takes::Text, required: true },
    Opt { name: "style", about: "Look", takes: Takes::Choice(&[("black & white", "bw"), ("color", "color")]), required: false },
], subs: &[] }];

/// What the Discord layer does for a quote.
#[derive(Debug, Clone, PartialEq)]
pub struct QuoteAsk {
    pub channel: String,
    pub message: String,
    pub color: bool,
    pub motion: bool,
    pub animated: bool,
    /// Post it there (the quote channel) and tell the member privately; None: answer here.
    pub post_in: Option<String>,
    pub by: String,
    /// `/quote` with a link: the member must be able to see that channel.
    pub check_sees: bool,
    /// Draw the pictures as pixel art (the server's choice).
    pub pixel: bool,
    /// Members may quote their own messages (off: they are told to ask someone else).
    pub allow_self: bool,
    /// The look: a preset's id ("classic", "midnight", "paper", "sunset", "forest", "pixel") or "custom".
    pub style: String,
    /// With "custom": background, text and accent colours and the font (only ever set when the server has a licence).
    pub custom: Option<[String; 4]>,
}

impl QuoteAsk {
    /// Whether the member may quote a message written by `author`: not their own, unless the server allows it.
    pub fn may_quote(&self, author: &str) -> bool { self.allow_self || self.by != author }
}

/// "#rrggbb".
pub fn valid_colour(s: &str) -> bool { s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit()) }
fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
fn last_use() -> std::sync::MutexGuard<'static, HashMap<String, i64>> {
    static M: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    M.get_or_init(Mutex::default).lock().unwrap_or_else(|p| p.into_inner())
}
/// "Nov 12, 2026", as toLocaleDateString('en-US') writes it.
pub fn when(ms: i64) -> String {
    let d = crate::time::date(ms);
    let p: Vec<i64> = d.split('-').map(|x| x.parse().unwrap_or(0)).collect();
    const M: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    format!("{} {}, {}", M[(p[1] - 1).clamp(0, 11) as usize], p[2], p[0])
}

/// `/quote` and the two right-click commands. `reads_messages`: Message Content is on.
/// `licensed`: this bot has a licence, which is what lets a server design its own quote look.
pub fn command(db: &Db, settings: &Settings, ev: &CommandEvent, reads_messages: bool, licensed: bool) -> Vec<Action> {
    if !perms::allowed(db, &ev.guild, &ev.member, USE) { return private(format!("You don't have permission for that (`{}`).", USE.key)); }
    let right_click = ev.name.starts_with("Quote Image");
    let (channel, message, check_sees) = if right_click {
        let (Some(c), Some(m)) = (ev.args.get("channel_id"), ev.args.get("message_id")) else { return private("I couldn't find that message.") };
        if ev.args.get("text").is_none_or(|t| t.trim().is_empty()) {
            return private(if reads_messages { "That message has no text to quote." } else { "I can't read message text yet. Turn on **Message Content Intent** in the Developer Portal (Bot > Privileged Gateway Intents) and restart me." });
        }
        (c.clone(), m.clone(), false)
    } else {
        let raw = ev.args.get("message").map(|s| s.trim().to_string()).unwrap_or_default();
        let (mut channel, mut message, mut linked) = (ev.place.channel.clone(), raw.clone(), false);
        if let Some(at) = raw.find("channels/") {
            let parts: Vec<&str> = raw[at + "channels/".len()..].split('/').collect();
            if parts.len() >= 3 {
                if parts[0] != ev.guild { return private("That message is from a different server."); }
                channel = parts[1].to_string();
                message = parts[2].chars().take_while(char::is_ascii_digit).collect();
                linked = true;
            }
        }
        if !(17..=20).contains(&message.len()) || !message.bytes().all(|b| b.is_ascii_digit()) { return private("Give a message link (right-click > Copy Message Link) or a message ID from this channel."); }
        (channel, message, linked)
    };
    {
        let mut m = last_use();
        if ev.at_ms - m.get(&ev.member.id).copied().unwrap_or(0) < 8_000 { return private("Easy - wait a few seconds between quotes."); }
        m.insert(ev.member.id.clone(), ev.at_ms);
        if m.len() > 10_000 { let now = ev.at_ms; m.retain(|_, t| now - *t < 60_000); }
    }
    let color = if right_click { ev.name.ends_with("(Color)") } else { ev.args.get("style").map(String::as_str) == Some("color") };
    let post_in = settings.text(&ev.guild, MODULE, "quoteChannel").filter(|c| !c.is_empty() && *c != ev.place.channel);
    let custom_text = |k: &str| settings.text(&ev.guild, MODULE, k).unwrap_or_default();
    let chosen = settings.text(&ev.guild, MODULE, "quoteStyle").unwrap_or_default();
    let (style, custom) = match chosen.as_str() {
        // a custom look is for servers with a licence; without one (or with a colour that is not #rrggbb) the classic look is used
        "custom" if licensed => {
            let c = [custom_text("quoteColourBg"), custom_text("quoteColourText"), custom_text("quoteColourAccent"), custom_text("quoteFont")];
            if c[..3].iter().all(|x| valid_colour(x)) { ("custom".to_string(), Some(c)) } else { ("classic".to_string(), None) }
        }
        "custom" | "" => ("classic".to_string(), None),
        other => (other.to_string(), None),
    };
    vec![Action::Quote(Box::new(QuoteAsk { style, custom, channel, message, color, motion: settings.bool(&ev.guild, MODULE, "motionQuotes"), animated: settings.bool(&ev.guild, MODULE, "animatedQuotes"), post_in, by: ev.member.id.clone(), check_sees, pixel: settings.bool(&ev.guild, MODULE, "pixelPictures"), allow_self: settings.bool(&ev.guild, MODULE, "selfQuotes") }))]
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ask(allow_self: bool) -> QuoteAsk {
        QuoteAsk { channel: "1".into(), message: "2".into(), color: false, motion: false, animated: false, post_in: None, by: "42".into(), check_sees: false, pixel: true, allow_self, style: "classic".into(), custom: None }
    }
    #[test]
    fn members_may_not_quote_themselves_unless_the_server_allows_it() {
        assert!(!ask(false).may_quote("42"));
        assert!(ask(false).may_quote("43"));
        assert!(ask(true).may_quote("42"));
    }
}

