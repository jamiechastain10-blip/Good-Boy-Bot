//! Cards: the one look for everything the bot says in Discord.
//!
//! A module describes what it wants to show (a title, some lines, maybe a picture, a bar, buttons) and the card
//! turns that into Discord's newer message layout. Every card is checked against Discord's limits before it is
//! sent, so a message Discord would refuse is caught here.

use serde_json::{json, Value};

/// What the card is about. It sets the colour, the same one the dashboard uses for that area.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Area {
    General,
    Money,
    Games,
    Moderation,
    Music,
    Clips,
}
impl Area {
    pub fn colour(self) -> u32 {
        match self {
            Area::General => 0x7b9dff,
            Area::Money => 0x3fd08f,
            Area::Games => 0xffb12e,
            Area::Moderation => 0xff6b7d,
            Area::Music => 0xc08bff,
            Area::Clips => 0x5fd3e6,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonStyle {
    Primary = 1,
    Plain = 2,
    Good = 3,
    Danger = 4,
}
#[derive(Debug, Clone, PartialEq)]
pub struct Button {
    /// What the bot is told when it is pressed.
    pub id: String,
    pub label: String,
    pub style: ButtonStyle,
    /// An emoji shown before the label: a plain one, or a server's own written as <:name:id>.
    pub emoji: Option<String>,
    /// Shown but can't be pressed (Previous on the first page).
    pub disabled: bool,
}
/// A dropdown list on a card. The bot is told the values picked.
#[derive(Debug, Clone, PartialEq)]
pub struct Select {
    pub id: String,
    pub placeholder: String,
    pub min: u8,
    pub max: u8,
    /// (label, value, emoji)
    pub options: Vec<(String, String, Option<String>)>,
}
/// A picture the Discord layer draws and sends in place of the card (the card's own text is the fallback).
#[derive(Debug, Clone, PartialEq)]
pub enum Art {
    Rank(RankArt),
    /// A family tree (`/family tree`): drawn with the members' avatars, the text tree taken off the card.
    Family(Box<crate::family::FamilyArt>),
}
/// What goes on a rank card (Good Boy 3's rankCard inputs).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RankArt {
    pub name: String,
    pub avatar_url: Option<String>,
    pub level: i64,
    pub into: i64,
    pub needed: i64,
    pub rank: Option<i64>,
    pub xp: i64,
    pub messages: i64,
    pub accent: Option<String>,
    pub accent2: Option<String>,
    pub theme: Option<String>,
    pub background: Option<String>,
    /// Draw the profile picture as pixel art (the server's choice).
    pub pixel: bool,
}
/// A file sent with a card (a transcript, evidence). Shown under the card's text.
#[derive(Debug, Clone, PartialEq)]
pub struct CardFile {
    pub name: String,
    pub data: std::sync::Arc<[u8]>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct Card {
    /// A picture sent instead of the card when it can be drawn (the card is the fallback).
    pub art: Option<Art>,
    /// Files sent with the card (up to 10).
    pub files: Vec<CardFile>,
    pub area: Area,
    pub title: Option<String>,
    pub lines: Vec<String>,
    /// A small picture beside the text (an avatar, an item).
    pub picture: Option<String>,
    /// Big pictures under the text (https addresses, such as GIFs), shown as a gallery.
    pub images: Vec<String>,
    /// Progress: (done, out of, what it counts).
    pub bar: Option<(i64, i64, String)>,
    pub buttons: Vec<Button>,
    pub select: Option<Select>,
    /// Shown only to the person who asked. Discord removes these by itself.
    pub private: bool,
    /// A colour of the server's own choosing for the card's edge (`/say`), in place of the area's.
    pub accent: Option<u32>,
    /// Members this card pings when it is an answer (a proposal pings the member asked).
    pub ping: Vec<String>,
    /// Buttons in a row (0: five). A game board sets this to get a square grid of buttons.
    pub per_row: usize,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum CardError {
    #[error("a card needs a title or at least one line")]
    Empty,
    #[error("a card's text is limited to 4000 characters (this one has {0})")]
    TooMuchText(usize),
    #[error("a card can have up to {max} buttons (this one has {found})")]
    TooManyButtons { found: usize, max: usize },
    #[error("button \"{0}\": labels are limited to 80 characters and ids to 100, and neither may be empty")]
    BadButton(String),
    #[error("two buttons share the id \"{0}\"")]
    SameButtonTwice(String),
    #[error("a picture must be an https address")]
    BadPicture,
}

/// `▰▰▰▱▱▱▱▱▱▱` for done out of total.
pub fn bar_text(done: i64, total: i64, width: usize) -> String {
    let part = if total > 0 { (done.max(0) as f64 / total as f64).min(1.0) } else { 0.0 };
    let filled = ((part * width as f64).round() as usize).min(width);
    format!("{}{}", "▰".repeat(filled), "▱".repeat(width - filled))
}

const BUTTONS_PER_ROW: usize = 5;
const MAX_BUTTON_ROWS: usize = 4;

impl Card {
    pub fn new(area: Area) -> Card {
        Card { art: None, files: Vec::new(), area, title: None, lines: Vec::new(), picture: None, images: Vec::new(), bar: None, buttons: Vec::new(), select: None, private: false, accent: None, ping: Vec::new(), per_row: 0 }
    }
    pub fn title(mut self, text: impl Into<String>) -> Card {
        self.title = Some(text.into());
        self
    }
    pub fn line(mut self, text: impl Into<String>) -> Card {
        self.lines.push(text.into());
        self
    }
    /// Sends a file with the card. Names are kept to letters, numbers, dots, dashes and underscores.
    pub fn file(mut self, name: &str, data: impl Into<std::sync::Arc<[u8]>>) -> Card {
        let safe: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || ".-_".contains(c) { c } else { '_' }).collect::<String>().trim_start_matches('.').chars().take(80).collect();
        if self.files.len() < 10 { self.files.push(CardFile { name: if safe.is_empty() { "file".into() } else { safe }, data: data.into() }); }
        self
    }
    /// A big picture under the text (https only), such as a GIF.
    pub fn image(mut self, url: impl Into<String>) -> Card {
        self.images.push(url.into());
        self
    }
    pub fn picture(mut self, url: Option<String>) -> Card {
        self.picture = url;
        self
    }
    pub fn bar(mut self, done: i64, total: i64, counts: impl Into<String>) -> Card {
        self.bar = Some((done, total, counts.into()));
        self
    }
    pub fn button(mut self, id: impl Into<String>, label: impl Into<String>, style: ButtonStyle) -> Card {
        self.buttons.push(Button { id: id.into(), label: label.into(), style, emoji: None, disabled: false });
        self
    }
    /// A button that opens a web link (such as a message). Nothing is sent to the bot when it is pressed.
    pub fn button_link(mut self, url: impl Into<String>, label: impl Into<String>) -> Card {
        self.buttons.push(Button { id: format!("link:{}", url.into()), label: label.into(), style: ButtonStyle::Plain, emoji: None, disabled: false });
        self
    }
    /// A button with an emoji before its label.
    pub fn button_with(mut self, id: impl Into<String>, label: impl Into<String>, style: ButtonStyle, emoji: Option<String>) -> Card {
        self.buttons.push(Button { id: id.into(), label: label.into(), style, emoji, disabled: false });
        self
    }
    /// A button that can be switched off (`off`), with an optional emoji; an empty label shows the emoji alone.
    pub fn button_full(mut self, id: impl Into<String>, label: impl Into<String>, style: ButtonStyle, emoji: Option<String>, off: bool) -> Card {
        self.buttons.push(Button { id: id.into(), label: label.into(), style, emoji, disabled: off });
        self
    }
    pub fn select(mut self, select: Select) -> Card {
        self.select = Some(select);
        self
    }
    /// Buttons in rows of this many (a square board of buttons).
    pub fn grid(mut self, per_row: usize) -> Card {
        self.per_row = per_row;
        self
    }
    pub fn private(mut self) -> Card {
        self.private = true;
        self
    }

    /// The card's words, as Discord text.
    fn text(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        if let Some(t) = &self.title {
            parts.push(format!("### {t}"));
        }
        parts.extend(self.lines.iter().cloned());
        if let Some((done, total, counts)) = &self.bar {
            parts.push(format!("{} {} of {} {}", bar_text(*done, *total, 12), group(*done), group(*total), counts));
        }
        parts.join("\n")
    }

    /// Discord's limits, checked before anything is sent.
    pub fn check(&self) -> Result<(), CardError> {
        if self.title.as_deref().unwrap_or("").trim().is_empty() && self.lines.iter().all(|l| l.trim().is_empty()) {
            return Err(CardError::Empty);
        }
        let chars = self.text().chars().count();
        if chars > 4000 {
            return Err(CardError::TooMuchText(chars));
        }
        // a dropdown takes one of the rows
        // a board of buttons (a grid) may use Discord's fifth row
        let max = if self.per_row > 0 { self.per_row * 5 } else { BUTTONS_PER_ROW * (MAX_BUTTON_ROWS - usize::from(self.select.is_some())) };
        if self.buttons.len() > max {
            return Err(CardError::TooManyButtons { found: self.buttons.len(), max });
        }
        for (k, b) in self.buttons.iter().enumerate() {
            if (b.label.trim().is_empty() && b.emoji.is_none()) || b.label.chars().count() > 80 || b.id.is_empty() || b.id.chars().count() > 100 {
                return Err(CardError::BadButton(b.label.clone()));
            }
            if self.buttons[..k].iter().any(|other| other.id == b.id) {
                return Err(CardError::SameButtonTwice(b.id.clone()));
            }
        }
        if let Some(sel) = &self.select {
            if sel.options.is_empty() || sel.options.len() > 25 || sel.id.is_empty() || sel.max < sel.min || sel.options.iter().any(|(l, v, _)| l.is_empty() || l.chars().count() > 100 || v.is_empty() || v.len() > 100) {
                return Err(CardError::BadButton(sel.placeholder.clone()));
            }
        }
        if let Some(p) = &self.picture {
            if !p.starts_with("https://") {
                return Err(CardError::BadPicture);
            }
        }
        if self.images.iter().any(|p| !p.starts_with("https://")) || self.images.len() > 10 {
            return Err(CardError::BadPicture);
        }
        Ok(())
    }

    /// The message as Discord's newer layout: one coloured container holding the text (with the picture beside it
    /// when there is one) and the buttons in rows of five. The dashboard's "preview" draws from this same data.
    pub fn to_discord(&self) -> Result<Value, CardError> {
        self.check()?;
        let is_picture = |n: &str| matches!(n.rsplit('.').next().map(str::to_ascii_lowercase).as_deref(), Some("png" | "jpg" | "jpeg" | "gif" | "webp"));
        let mut pictures: Vec<Value> = self.files.iter().filter(|f| is_picture(&f.name)).map(|f| json!({ "media": { "url": format!("attachment://{}", f.name) } })).collect();
        pictures.extend(self.images.iter().map(|u| json!({ "media": { "url": u } })));
        let mut inside: Vec<Value> = Vec::new();
        // a game's picture sits between the title and the lines under it (the slot window, the table, the water)
        let game = self.area == Area::Games && self.title.is_some() && !pictures.is_empty() && self.picture.is_none();
        if game {
            inside.push(json!({ "type": 10, "content": format!("### {}", self.title.as_deref().unwrap_or("")) }));
            inside.push(json!({ "type": 12, "items": pictures }));
            let rest = self.text().split_once('\n').map(|(_, r)| r.to_string()).unwrap_or_default();
            if !rest.trim().is_empty() { inside.push(json!({ "type": 10, "content": rest })); }
        } else {
            let text = json!({ "type": 10, "content": self.text() });
            match &self.picture {
                Some(url) => inside.push(json!({ "type": 9, "components": [text], "accessory": { "type": 11, "media": { "url": url } } })),
                None => inside.push(text),
            }
            // attached pictures are shown as pictures, straight under the text
            if !pictures.is_empty() { inside.push(json!({ "type": 12, "items": pictures })); }
        }
        for row in self.buttons.chunks(if self.per_row > 0 { self.per_row.min(BUTTONS_PER_ROW) } else { BUTTONS_PER_ROW }) {
            inside.push(json!({ "type": 1, "components": row.iter().map(|b| {
                let mut one = match b.id.strip_prefix("link:") {
                    Some(url) => json!({ "type": 2, "style": 5, "url": url }),
                    None => json!({ "type": 2, "style": b.style as u8, "custom_id": b.id }),
                };
                if !b.label.is_empty() || b.emoji.is_none() { one["label"] = json!(b.label); }
                if let Some(e) = &b.emoji { one["emoji"] = emoji_json(e); }
                if b.disabled { one["disabled"] = json!(true); }
                one
            }).collect::<Vec<_>>() }));
        }
        // files are shown under the text (Discord only shows the files a card points to)
        for f in self.files.iter().filter(|f| !is_picture(&f.name)) {
            inside.push(json!({ "type": 13, "file": { "url": format!("attachment://{}", f.name) } }));
        }
        if let Some(sel) = &self.select {
            let options: Vec<Value> = sel.options.iter().map(|(label, value, emoji)| {
                let mut o = json!({ "label": label, "value": value });
                if let Some(e) = emoji { o["emoji"] = emoji_json(e); }
                o
            }).collect();
            inside.push(json!({ "type": 1, "components": [{ "type": 3, "custom_id": sel.id, "placeholder": sel.placeholder, "min_values": sel.min, "max_values": sel.max.min(sel.options.len() as u8).max(sel.min), "options": options }] }));
        }
        const COMPONENTS_V2: u64 = 1 << 15;
        const ONLY_YOU: u64 = 1 << 6;
        Ok(json!({
            "flags": COMPONENTS_V2 | if self.private { ONLY_YOU } else { 0 },
            "components": [{ "type": 17, "accent_color": self.accent.unwrap_or_else(|| self.area.colour()), "components": inside }],
        }))
    }
}

/// An emoji as Discord's components want it: a server's own emoji by id, anything else by its text.
fn emoji_json(e: &str) -> Value {
    let t = e.trim();
    if let Some(inner) = t.strip_prefix('<').and_then(|x| x.strip_suffix('>')) {
        let animated = inner.starts_with("a:");
        let parts: Vec<&str> = inner.trim_start_matches("a:").trim_start_matches(':').split(':').collect();
        if let [name, id] = parts[..] {
            if !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) {
                return json!({ "id": id, "name": name, "animated": animated });
            }
        }
    }
    json!({ "name": t })
}

/// 12345 -> "12,345"
pub fn group(n: i64) -> String {
    let digits = n.abs().to_string();
    let mut out = String::new();
    for (k, c) in digits.chars().enumerate() {
        if k > 0 && (digits.len() - k).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 { format!("-{out}") } else { out }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bars_and_numbers() {
        assert_eq!(bar_text(0, 100, 10), "▱▱▱▱▱▱▱▱▱▱");
        assert_eq!(bar_text(50, 100, 10), "▰▰▰▰▰▱▱▱▱▱");
        assert_eq!(bar_text(500, 100, 4), "▰▰▰▰");
        assert_eq!(bar_text(5, 0, 4), "▱▱▱▱");
        assert_eq!(group(0), "0");
        assert_eq!(group(999), "999");
        assert_eq!(group(12345), "12,345");
        assert_eq!(group(-1234567), "-1,234,567");
    }
    #[test]
    fn a_card_becomes_discords_layout() {
        let card = Card::new(Area::General).title("Kai reached level 12").line("Rank 4 in the server").picture(Some("https://cdn.discordapp.com/a.png".into())).bar(180, 1000, "XP to level 13").button("rank:1", "View rank card", ButtonStyle::Primary);
        let d = card.to_discord().unwrap();
        assert_eq!(d["flags"], 1 << 15);
        let c = &d["components"][0];
        assert_eq!((c["type"].as_u64(), c["accent_color"].as_u64()), (Some(17), Some(0x7b9dff)));
        assert_eq!(c["components"][0]["type"], 9, "text with the picture beside it");
        assert_eq!(c["components"][0]["accessory"]["media"]["url"], "https://cdn.discordapp.com/a.png");
        let text = c["components"][0]["components"][0]["content"].as_str().unwrap();
        assert!(text.starts_with("### Kai reached level 12\nRank 4 in the server\n") && text.ends_with("180 of 1,000 XP to level 13"), "{text}");
        assert_eq!(c["components"][1]["components"][0]["custom_id"], "rank:1");
        assert_eq!(Card::new(Area::Money).line("hi").private().to_discord().unwrap()["flags"], (1 << 15) | (1 << 6));
    }
    #[test]
    fn what_discord_would_refuse_is_caught_first() {
        assert_eq!(Card::new(Area::General).check(), Err(CardError::Empty));
        assert!(matches!(Card::new(Area::General).line("x".repeat(4001)).check(), Err(CardError::TooMuchText(4001))));
        // the bug that broke fishing in 3.1: six buttons. Here they wrap onto a second row.
        let mut six = Card::new(Area::Games).title("Fishing");
        for n in 0..6 {
            six = six.button(format!("b{n}"), format!("Button {n}"), ButtonStyle::Plain);
        }
        let d = six.to_discord().unwrap();
        let rows: Vec<usize> = d["components"][0]["components"].as_array().unwrap().iter().filter(|c| c["type"] == 1).map(|r| r["components"].as_array().unwrap().len()).collect();
        assert_eq!(rows, vec![5, 1]);
        let mut many = Card::new(Area::Games).title("x");
        for n in 0..21 {
            many = many.button(format!("b{n}"), "b", ButtonStyle::Plain);
        }
        assert_eq!(many.check(), Err(CardError::TooManyButtons { found: 21, max: 20 }));
        assert_eq!(Card::new(Area::General).line("x").button("a", "A", ButtonStyle::Plain).button("a", "B", ButtonStyle::Plain).check(), Err(CardError::SameButtonTwice("a".into())));
        assert!(matches!(Card::new(Area::General).line("x").button("a", "", ButtonStyle::Plain).check(), Err(CardError::BadButton(_))));
        assert_eq!(Card::new(Area::General).line("x").picture(Some("http://plain.example/a.png".into())).check(), Err(CardError::BadPicture));
    }
}
