//! Colours, for everything that has one. The dashboard has a real colour picker. Discord popups cannot have one, so
//! there a colour is picked from a dropdown of named swatches (each with a coloured square), and where the popup has
//! room a box to type an exact hex code as well.

use crate::{Field, FieldKind};

/// (name, "#rrggbb", the coloured square Discord shows beside it)
pub const PALETTE: &[(&str, &str, &str)] = &[
    ("Red", "#ed4245", "🟥"), ("Orange", "#f5871f", "🟧"), ("Yellow", "#fee75c", "🟨"), ("Green", "#3ba55d", "🟩"),
    ("Blue", "#5865f2", "🟦"), ("Purple", "#9b59b6", "🟪"), ("Brown", "#8d5a3b", "🟫"), ("Black", "#1e1f22", "⬛"),
    ("White", "#ffffff", "⬜"), ("Pink", "#ff69b4", "🌸"), ("Coral", "#ff7a59", "🪸"), ("Gold", "#f1c40f", "🌟"),
    ("Lime", "#a3e635", "🍏"), ("Mint", "#3ddc97", "🌿"), ("Teal", "#1abc9c", "🧊"), ("Sky", "#4cc9f0", "☁️"),
    ("Navy", "#1f3a93", "🌊"), ("Lavender", "#b39ddb", "💜"), ("Magenta", "#e91e8c", "🌺"), ("Maroon", "#8e1b2b", "🍷"),
    ("Grey", "#80848e", "🩶"), ("Cream", "#f4efe6", "🥛"), ("Midnight", "#0b1020", "🌌"), ("Burgundy", "#5c1a2b", "🍒"),
];

/// The same swatches as slash-command choices: (name, "#rrggbb").
pub const CHOICES: &[(&str, &str)] = &[
    ("Red", "#ed4245"), ("Orange", "#f5871f"), ("Yellow", "#fee75c"), ("Green", "#3ba55d"), ("Blue", "#5865f2"), ("Purple", "#9b59b6"),
    ("Brown", "#8d5a3b"), ("Black", "#1e1f22"), ("White", "#ffffff"), ("Pink", "#ff69b4"), ("Coral", "#ff7a59"), ("Gold", "#f1c40f"),
    ("Lime", "#a3e635"), ("Mint", "#3ddc97"), ("Teal", "#1abc9c"), ("Sky", "#4cc9f0"), ("Navy", "#1f3a93"), ("Lavender", "#b39ddb"),
    ("Magenta", "#e91e8c"), ("Maroon", "#8e1b2b"), ("Grey", "#80848e"), ("Cream", "#f4efe6"), ("Midnight", "#0b1020"), ("Burgundy", "#5c1a2b"),
];
/// A typed colour code if there is one, else the colour picked from the list (what `/say` and friends read).
pub fn typed_or_picked<'a>(typed: Option<&'a str>, picked: Option<&'a str>) -> Option<&'a str> {
    typed.filter(|t| !t.trim().is_empty()).or(picked.filter(|p| !p.trim().is_empty()))
}

/// "#rrggbb" in lower case from what someone typed: `#5865F2`, `5865f2` or `#58f` (three digits). None when it is not a colour.
pub fn normalize(text: &str) -> Option<String> {
    let t = text.trim().trim_start_matches('#');
    if !t.is_ascii() || !t.bytes().all(|b| b.is_ascii_hexdigit()) { return None; }
    match t.len() {
        6 => Some(format!("#{}", t.to_lowercase())),
        3 => Some(format!("#{}", t.chars().flat_map(|c| [c, c]).collect::<String>().to_lowercase())),
        _ => None,
    }
}
/// The palette's name for a colour, when it is one of the swatches.
pub fn name_of(hex: &str) -> Option<&'static str> {
    let h = normalize(hex)?;
    PALETTE.iter().find(|p| p.1 == h).map(|p| p.0)
}
/// A dropdown of the swatches. `current` is shown first as "Keep …" when it is not one of them (or there is one), so
/// saving the popup without touching it changes nothing. `none`: a first choice that means no colour.
pub fn pick_field(id: &str, label: &str, current: Option<&str>, none: Option<&str>) -> Field {
    let mut options: Vec<(String, String)> = Vec::new();
    let keep = current.and_then(normalize);
    if let Some(k) = &keep { options.push((format!("Keep my current colour ({})", name_of(k).unwrap_or(k)), "keep".into())); }
    if let Some(n) = none { options.push((n.to_string(), "none".into())); }
    let room = 25 - options.len();
    options.extend(PALETTE.iter().take(room).map(|(n, h, e)| (format!("{e} {n}"), h.to_string())));
    Field { id: id.into(), label: label.chars().take(45).collect(), kind: FieldKind::Select(options), required: false, value: Some(if keep.is_some() { "keep".into() } else if none.is_some() { "none".into() } else { PALETTE[4].1.into() }), ..Default::default() }
}
/// What a [`pick_field`] and an optional typed code answered. `typed` wins when it is a colour. `Ok(None)` means no colour
/// (or keep: the caller's saved colour stays, so it asks `kept`). Err when the typed code is not a colour.
pub fn read(picked: Option<&str>, typed: Option<&str>) -> Result<Choice, String> {
    if let Some(t) = typed.map(str::trim).filter(|t| !t.is_empty()) {
        return normalize(t).map(Choice::Colour).ok_or_else(|| format!("\"{t}\" isn't a colour. Use a code like #5865F2, or pick one from the list."));
    }
    Ok(match picked.map(str::trim) {
        None | Some("") | Some("keep") => Choice::Keep,
        Some("none") => Choice::None,
        Some(p) => normalize(p).map(Choice::Colour).unwrap_or(Choice::Keep),
    })
}
/// The answer to a colour question.
#[derive(Debug, Clone, PartialEq)]
pub enum Choice { Colour(String), None, Keep }
impl Choice {
    /// The colour to save: the new one, nothing, or what was there before.
    pub fn resolve(self, before: Option<String>) -> Option<String> {
        match self { Choice::Colour(c) => Some(c), Choice::None => None, Choice::Keep => before }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn colours_are_read_in_any_common_spelling() {
        assert_eq!(normalize("#5865F2").as_deref(), Some("#5865f2"));
        assert_eq!(normalize("5865f2").as_deref(), Some("#5865f2"));
        assert_eq!(normalize(" #f0a ").as_deref(), Some("#ff00aa"));
        assert!(normalize("red").is_none() && normalize("#12345").is_none() && normalize("#12345g").is_none() && normalize("").is_none());
        assert!(PALETTE.iter().all(|p| normalize(p.1).as_deref() == Some(p.1)) && PALETTE.len() <= 24);
        assert!(CHOICES.len() == PALETTE.len() && CHOICES.iter().zip(PALETTE).all(|(c, p)| c.0 == p.0 && c.1 == p.1), "the two lists match");
    }
    #[test]
    fn the_dropdown_fits_discord_and_keeps_what_was_there() {
        let f = pick_field("accent", "Main colour", Some("#123456"), Some("No colour"));
        let FieldKind::Select(o) = &f.kind else { panic!() };
        assert!(o.len() <= 25 && o[0].1 == "keep" && o[1].1 == "none" && f.value.as_deref() == Some("keep"));
        let f = pick_field("accent", "Main colour", None, None);
        assert_eq!(f.value.as_deref(), Some("#5865f2"));
        assert_eq!(read(Some("keep"), None), Ok(Choice::Keep));
        assert_eq!(read(Some("keep"), Some("#ABCDEF")), Ok(Choice::Colour("#abcdef".into())));
        assert_eq!(read(Some("#ed4245"), Some("")), Ok(Choice::Colour("#ed4245".into())));
        assert!(read(None, Some("nope")).is_err());
        assert_eq!(Choice::Keep.resolve(Some("#111111".into())), Some("#111111".into()));
        assert_eq!(Choice::None.resolve(Some("#111111".into())), None);
    }
}
