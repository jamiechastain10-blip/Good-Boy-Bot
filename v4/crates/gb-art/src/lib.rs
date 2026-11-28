//! Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
//!
//! The pictures the bot draws. Rank cards are drawn exactly as Good Boy 3 draws them (src/rankcard.js): the same
//! 760×220 card, the same themes, colours, fonts, sizes and positions, so a member sees the same card.
//! Each picture is written as SVG and turned into a PNG here, with the fonts built in.

use std::sync::{Arc, OnceLock};

/// A theme: background gradient, main text, secondary text, the empty part of the bar.
pub struct Theme {
    pub id: &'static str,
    pub label: &'static str,
    pub bg: [&'static str; 2],
    pub text: &'static str,
    pub soft: &'static str,
    pub track: &'static str,
}
/// Good Boy 3's rank card themes, in its order.
pub const THEMES: &[Theme] = &[
    Theme { id: "dark", label: "Dark", bg: ["#151a26", "#0f131c"], text: "#e9edf5", soft: "#8b97ab", track: "#1b2130" },
    Theme { id: "light", label: "Light", bg: ["#f6f8fc", "#e4e9f2"], text: "#1b2130", soft: "#5b667a", track: "#d5dbe6" },
    Theme { id: "midnight", label: "Midnight", bg: ["#0b1030", "#1d0b33"], text: "#eef0ff", soft: "#9aa3d6", track: "#1d2250" },
    Theme { id: "sunset", label: "Sunset", bg: ["#3b1630", "#5c2a14"], text: "#fff1e6", soft: "#e0b49a", track: "#4a2030" },
    Theme { id: "forest", label: "Forest", bg: ["#0e2a1b", "#17331f"], text: "#eafbef", soft: "#93c4a2", track: "#1d3d29" },
    Theme { id: "ocean", label: "Ocean", bg: ["#0a2338", "#063a40"], text: "#e8f8ff", soft: "#8ec3d6", track: "#123548" },
    Theme { id: "candy", label: "Candy", bg: ["#3a1838", "#24194a"], text: "#fff0fb", soft: "#d9a6d2", track: "#46224a" },
];

/// "#6B93ff" or "6b93ff" -> "#6b93ff". None when it is not a colour.
pub fn hex(v: &str) -> Option<String> {
    let v = v.trim().trim_start_matches('#');
    (v.len() == 6 && v.chars().all(|c| c.is_ascii_hexdigit())).then(|| format!("#{}", v.to_ascii_lowercase()))
}
/// Only pictures uploaded to Discord can be card backgrounds (nothing from random sites), as in Good Boy 3.
pub fn ok_background(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://cdn.discordapp.com/attachments/").or_else(|| url.strip_prefix("https://media.discordapp.net/attachments/")) else { return false };
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let ext_ok = path.rsplit_once('.').is_some_and(|(_, e)| matches!(e.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif"));
    let path_ok = !path.is_empty() && path.chars().all(|c| c.is_ascii_alphanumeric() || "/._-%".contains(c));
    let query_ok = query.chars().all(|c| c.is_ascii_alphanumeric() || "=&._-%".contains(c));
    ext_ok && path_ok && query_ok
}

/// What goes on a rank card. Pictures are the raw bytes of the avatar and the background, already downloaded.
#[derive(Clone, Copy)]
pub struct Rank<'a> {
    pub name: &'a str,
    pub avatar: Option<&'a [u8]>,
    pub level: i64,
    pub into: i64,
    pub needed: i64,
    pub rank: Option<i64>,
    pub xp: i64,
    pub messages: i64,
    pub accent: Option<&'a str>,
    pub accent2: Option<&'a str>,
    pub theme: Option<&'a str>,
    pub background: Option<&'a [u8]>,
    /// Draw the profile picture as pixel art (the server's choice).
    pub pixel: bool,
}

pub mod arcade;
pub mod fishui;
pub mod games;
pub mod greeting;
pub mod pixel;
pub mod quote;
pub use greeting::{greeting_card, greeting_svg, Greeting};
pub use quote::{quote_animated, quote_motion, quote_png, Quote};

const FIGTREE_600: &[u8] = include_bytes!("../fonts/Figtree-SemiBold.ttf");
const FIGTREE_700: &[u8] = include_bytes!("../fonts/Figtree-Bold.ttf");
const DISPLAY_700: &[u8] = include_bytes!("../fonts/Bricolage-Bold.ttf");
const DISPLAY_800: &[u8] = include_bytes!("../fonts/Bricolage-ExtraBold.ttf");
const PRESS_START: &[u8] = include_bytes!("../fonts/PressStart2P-Regular.ttf");
const VT323: &[u8] = include_bytes!("../fonts/VT323-Regular.ttf");

/// Loads the fonts now. Reading every font a computer has takes seconds the first time, and a game's picture waits for it:
/// Discord only waits three, so this is done as the bot starts, before anyone presses anything.
pub fn warm() {
    let _ = fonts();
    // and one small picture, so the drawing code itself has run once
    let _ = png(r##"<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="#222"/><text x="6" y="22" font-size="16" fill="#fff">Good Boy</text></svg>"##);
}

pub(crate) fn fonts() -> Arc<resvg::usvg::fontdb::Database> {
    static DB: OnceLock<Arc<resvg::usvg::fontdb::Database>> = OnceLock::new();
    DB.get_or_init(|| {
        let mut db = resvg::usvg::fontdb::Database::new();
        // the computer's own fonts first, for names in other scripts and emoji; the card's own fonts are named directly
        db.load_system_fonts();
        for f in [FIGTREE_600, FIGTREE_700, DISPLAY_700, DISPLAY_800, PRESS_START, VT323] { db.load_font_data(f.to_vec()); }
        db.set_sans_serif_family("GB Figtree 600");
        Arc::new(db)
    }).clone()
}

/// How wide text is in one of the card's fonts (for shortening long names the way Good Boy 3 does).
fn width(font: &[u8], size: f32, text: &str) -> f32 {
    let Ok(face) = ttf_parser::Face::parse(font, 0) else { return text.chars().count() as f32 * size * 0.6 };
    let per_unit = size / face.units_per_em() as f32;
    text.chars().map(|c| face.glyph_index(c).and_then(|g| face.glyph_hor_advance(g)).map(|a| a as f32 * per_unit).unwrap_or(size * 0.6)).sum()
}
pub(crate) fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}
/// 12345 -> "12,345", as toLocaleString('en-US') writes it.
pub fn grouped(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (k, c) in digits.chars().enumerate() {
        if k > 0 && (digits.len() - k).is_multiple_of(3) { out.push(','); }
        out.push(c);
    }
    if n < 0 { format!("-{out}") } else { out }
}
pub(crate) fn data_uri(bytes: &[u8]) -> Option<String> {
    let kind = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) { "png" } else if bytes.starts_with(&[0xFF, 0xD8]) { "jpeg" } else if bytes.starts_with(b"GIF8") { "gif" } else if bytes.len() > 12 && &bytes[8..12] == b"WEBP" { "webp" } else { return None };
    Some(format!("data:image/{kind};base64,{}", base64(bytes)))
}
fn base64(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(b.len().div_ceil(3) * 4);
    for chunk in b.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for k in 0..4 { out.push(if k <= chunk.len() { T[(n >> (18 - 6 * k) & 63) as usize] as char } else { '=' }); }
    }
    out
}
/// The size of a picture (for fitting a background the way Good Boy 3 does), from its own header.
fn picture_size(b: &[u8]) -> Option<(f32, f32)> {
    let tree = resvg::usvg::Tree::from_str(&format!(r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="{}"/></svg>"#, data_uri(b)?), &resvg::usvg::Options::default()).ok()?;
    let r = tree.root().abs_bounding_box();
    (r.width() > 0.0 && r.height() > 0.0).then(|| (r.width(), r.height()))
}

/// The rank card as SVG (the same drawing as Good Boy 3's).
pub fn rank_svg(r: &Rank) -> String {
    rank_svg_with(r, r.avatar.and_then(|a| pixel::uri_at(a, r.pixel, RANK_GRID)))
}
/// The same, with the profile picture already prepared (an animated card keeps one palette for all its frames).
fn rank_svg_with(r: &Rank, avatar_uri: Option<String>) -> String {
    let t = r.theme.and_then(|id| THEMES.iter().find(|t| t.id == id)).unwrap_or(&THEMES[0]);
    let light = t.id == "light";
    let accent = r.accent.and_then(hex).unwrap_or_else(|| "#6b93ff".into());
    let accent2 = r.accent2.and_then(hex).unwrap_or_else(|| "#b07cff".into());
    let (w, h) = (760.0f32, 220.0f32);
    let mut s = format!(r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="760" height="220" viewBox="0 0 760 220">
<defs>
<linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="760" y2="220"><stop offset="0" stop-color="{b0}"/><stop offset="1" stop-color="{b1}"/></linearGradient>
<linearGradient id="top" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="760" y2="0"><stop offset="0" stop-color="{accent}"/><stop offset="1" stop-color="{accent2}"/></linearGradient>
<linearGradient id="fill" gradientUnits="userSpaceOnUse" x1="210" y1="0" x2="720" y2="0"><stop offset="0" stop-color="{accent}"/><stop offset="1" stop-color="{accent2}"/></linearGradient>
<clipPath id="card"><rect width="760" height="220" rx="24"/></clipPath>
<clipPath id="face"><circle cx="110" cy="110" r="70"/></clipPath>
</defs>
<rect width="760" height="220" rx="24" fill="url(#bg)"/>
"##, b0 = t.bg[0], b1 = t.bg[1]);
    // a member's own background picture, dimmed so the text stays readable
    if let Some((bytes, uri)) = r.background.and_then(|b| Some((b, data_uri(b)?))) {
        if let Some((pw, ph)) = picture_size(bytes) {
            let scale = (w / pw).max(h / ph);
            let (dw, dh) = (pw * scale, ph * scale);
            s.push_str(&format!(r#"<g clip-path="url(#card)"><image x="{}" y="{}" width="{dw}" height="{dh}" preserveAspectRatio="none" xlink:href="{uri}"/><rect width="760" height="220" fill="{}"/></g>
"#, (w - dw) / 2.0, (h - dh) / 2.0, if light { "rgba(246,248,252,0.72)" } else { "rgba(10,12,20,0.62)" }));
        }
    }
    s.push_str(r#"<g clip-path="url(#card)"><rect width="760" height="5" fill="url(#top)"/></g>
"#);
    // the avatar in its ring
    s.push_str(&format!(r#"<circle cx="110" cy="110" r="76" fill="{}"/><circle cx="110" cy="110" r="73" fill="none" stroke="{accent}" stroke-width="5"/>
"#, t.track));
    match avatar_uri {
        Some(uri) => s.push_str(&format!(r#"<image x="40" y="40" width="140" height="140" preserveAspectRatio="none"{} clip-path="url(#face)" xlink:href="{uri}"/>
"#, pixel::attr(r.pixel))),
        None => {
            let initials: String = r.name.chars().take(2).collect::<String>().to_uppercase();
            s.push_str(&format!(r##"<g clip-path="url(#face)"><rect x="40" y="40" width="140" height="140" fill="{accent}"/></g><text x="110" y="112" font-family="'GB Display 800', sans-serif" font-size="48" fill="#0b1020" text-anchor="middle" dominant-baseline="central">{}</text>
"##, esc(&initials)));
        }
    }
    // name, shortened the way Good Boy 3 does: two characters at a time until it fits, then "…"
    let mut name: Vec<char> = r.name.chars().collect();
    let full = name.len();
    while width(DISPLAY_700, 30.0, &name.iter().collect::<String>()) > 330.0 && name.len() > 3 { name.truncate(name.len() - 2); }
    let mut shown: String = name.iter().collect();
    if name.len() != full { shown.push('…'); }
    s.push_str(&format!(r#"<text x="210" y="72" font-family="'GB Display 700', sans-serif" font-size="30" fill="{}">{}</text>
"#, t.text, esc(&shown)));
    s.push_str(&format!(r#"<text x="630" y="46" font-family="'GB Figtree 600', sans-serif" font-size="16" fill="{}" text-anchor="end">LEVEL</text>
<text x="720" y="72" font-family="'GB Display 800', sans-serif" font-size="44" fill="{accent}" text-anchor="end">{}</text>
"#, t.soft, r.level));
    if let Some(rank) = r.rank.filter(|n| *n > 0) {
        s.push_str(&format!(r#"<text x="720" y="104" font-family="'GB Figtree 600', sans-serif" font-size="16" fill="{}" text-anchor="end">RANK #{rank}</text>
"#, t.soft));
    }
    // the XP bar
    let (bx, by, bw, bh) = (210.0f32, 140.0f32, w - 210.0 - 40.0, 26.0f32);
    let pct = (r.into as f32 / r.needed.max(1) as f32).clamp(0.0, 1.0);
    s.push_str(&format!(r#"<rect x="{bx}" y="{by}" width="{bw}" height="{bh}" rx="{}" fill="{}"/>
"#, bh / 2.0, t.track));
    if pct > 0.0 {
        s.push_str(&format!(r#"<rect x="{bx}" y="{by}" width="{}" height="{bh}" rx="{}" fill="url(#fill)"/>
"#, bh.max(bw * pct), bh / 2.0));
    }
    s.push_str(&format!(r#"<text x="{bx}" y="{}" font-family="'GB Figtree 600', sans-serif" font-size="15" fill="{}">{} / {} XP to level {}</text>
<text x="{}" y="{}" font-family="'GB Figtree 600', sans-serif" font-size="15" fill="{}" text-anchor="end">{} XP · {} messages</text>
</svg>"#, by + bh + 24.0, t.text, grouped(r.into), grouped(r.needed), r.level + 1, bx + bw, by + bh + 24.0, t.soft, grouped(r.xp), grouped(r.messages)));
    s
}

/// The rank card as a PNG. None if anything goes wrong (then /rank shows its text version, as in Good Boy 3).
pub fn rank_card(r: &Rank) -> Option<Vec<u8>> {
    png(&rank_svg(r))
}

/// The rank card's picture is 35 x 35 pixels, each drawn 4 wide (35 x 4 = the 140 it is shown at).
const RANK_GRID: u32 = 35;
/// Most frames an animated rank card keeps, and the widest part of the card a moving picture can touch (the avatar ring).
const RANK_FRAMES: usize = 40;
const RANK_TILE_W: u32 = 190;
/// The rank card with a moving profile picture, as a GIF: the first frame is the whole card, the rest only the part
/// the picture touches. Fewer frames when it would be too big. None when the picture has a single frame (draw it as a PNG).
pub fn rank_card_animated(r: &Rank, avatar_gif: &[u8]) -> Option<Vec<u8>> {
    const MAX_BYTES: usize = 8 * 1024 * 1024;
    let mut last = None;
    for max in [RANK_FRAMES, RANK_FRAMES / 2, RANK_FRAMES / 4] {
        let frames = quote::gif_frames(avatar_gif, max);
        if frames.len() < 2 { return None; }
        let mut out = Vec::new();
        let mut palette = None;
        {
            let mut enc = gif::Encoder::new(&mut out, 760, 220, &[]).ok()?;
            enc.set_repeat(gif::Repeat::Infinite).ok()?;
            for (n, (face, delay)) in frames.iter().enumerate() {
                let (w, _, mut px) = rgba(&rank_svg_with(r, pixel::frame_uri(face, r.pixel, &mut palette, RANK_GRID)))?;
                let width = if n == 0 { w } else { RANK_TILE_W.min(w) };
                if n > 0 {
                    // keep only the left strip of every row
                    let (full, strip) = (w as usize * 4, width as usize * 4);
                    px = px.chunks(full).flat_map(|row| row[..strip].to_vec()).collect();
                }
                let mut f = gif::Frame::from_rgba_speed(width as u16, 220, &mut px, 10);
                f.delay = (delay / 10).max(2) as u16;
                enc.write_frame(&f).ok()?;
            }
        }
        if out.len() <= MAX_BYTES { return Some(out); }
        last = Some(out);
    }
    last
}

/// Draws SVG into a PNG, with the card's fonts.
pub fn png(svg: &str) -> Option<Vec<u8>> {
    let opt = resvg::usvg::Options { fontdb: fonts(), ..Default::default() };
    let tree = resvg::usvg::Tree::from_str(svg, &opt).ok()?;
    let size = tree.size().to_int_size();
    let mut pixmap = resvg::tiny_skia::Pixmap::new(size.width(), size.height())?;
    resvg::render(&tree, resvg::tiny_skia::Transform::default(), &mut pixmap.as_mut());
    pixmap.encode_png().ok()
}

/// A small PNG of any picture (320×180, the middle cropped), for galleries and lists. A moving picture shows its first frame.
pub fn thumbnail(bytes: &[u8]) -> Option<Vec<u8>> {
    let uri = data_uri(bytes)?;
    png(&format!(r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#151a26"/><image x="0" y="0" width="320" height="180" preserveAspectRatio="xMidYMid slice" xlink:href="{uri}"/></svg>"##))
}

/// Draws SVG into plain pixels: (width, height, RGBA).
pub(crate) fn rgba(svg: &str) -> Option<(u32, u32, Vec<u8>)> {
    let opt = resvg::usvg::Options { fontdb: fonts(), ..Default::default() };
    let tree = resvg::usvg::Tree::from_str(svg, &opt).ok()?;
    let size = tree.size().to_int_size();
    let mut pixmap = resvg::tiny_skia::Pixmap::new(size.width(), size.height())?;
    resvg::render(&tree, resvg::tiny_skia::Transform::default(), &mut pixmap.as_mut());
    Some((size.width(), size.height(), pixmap.take()))
}

/// Good Boy 3's verification captcha (`src/captcha.js`): the code drawn wobbly over noise, 300×110. `seed` picks the
/// wobble, so the same seed draws the same picture.
pub fn captcha_svg(code: &str, seed: u64) -> String {
    let mut state = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407) | 1;
    let mut rand = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        (state >> 11) as f64 / (1u64 << 53) as f64
    };
    let (w, h) = (300.0, 110.0);
    let mut out = format!(r##"<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d2433"/><stop offset="1" stop-color="#2b2140"/></linearGradient><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="0" stdDeviation="2" flood-color="#000" flood-opacity="0.6"/></filter></defs><rect width="{w}" height="{h}" fill="url(#g)"/>"##);
    let hue = |r: &mut dyn FnMut() -> f64| format!("hsl({}, 70%, {}%)", (r() * 360.0).floor(), 55.0 + (r() * 20.0).floor());
    for _ in 0..220 {
        let (a, x, y) = (0.05 + rand() * 0.2, rand() * w, rand() * h);
        out += &format!(r##"<rect x="{x:.1}" y="{y:.1}" width="2" height="2" fill="#fff" fill-opacity="{a:.2}"/>"##);
    }
    for _ in 0..5 {
        let c = hue(&mut rand);
        let lw = 1.0 + rand() * 2.5;
        let (y0, y1, y2, y3) = (rand() * h, rand() * h, rand() * h, rand() * h);
        out += &format!(r##"<path d="M0 {y0:.1} C{:.1} {y1:.1} {:.1} {y2:.1} {w} {y3:.1}" stroke="{c}" stroke-opacity="0.45" stroke-width="{lw:.1}" fill="none"/>"##, w * 0.3, w * 0.7);
    }
    let step = (w - 40.0) / code.chars().count().max(1) as f64;
    for (k, ch) in code.chars().enumerate() {
        let x = 28.0 + k as f64 * step + rand() * 8.0;
        let y = h / 2.0 + (rand() - 0.5) * 22.0;
        let turn = (rand() - 0.5) * 0.7 * 180.0 / std::f64::consts::PI;
        let size = 44.0 + (rand() * 12.0).floor();
        let c = hue(&mut rand);
        out += &format!(r##"<text transform="translate({x:.1} {y:.1}) rotate({turn:.1})" font-family="'GB Display 800'" font-size="{size}" fill="{c}" dominant-baseline="middle" filter="url(#s)">{}</text>"##, esc(&ch.to_string()));
    }
    let (a, b, c) = (h * (0.3 + rand() * 0.4), h * rand(), h * (0.3 + rand() * 0.4));
    out += &format!(r##"<path d="M10 {a:.1} Q{} {b:.1} {} {c:.1}" stroke="#fff" stroke-opacity="0.55" stroke-width="2" fill="none"/></svg>"##, w / 2.0, w - 10.0);
    out
}
/// The captcha as a PNG.
pub fn captcha(code: &str, seed: u64) -> Option<Vec<u8>> {
    png(&captcha_svg(code, seed))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_captcha_is_a_picture_of_the_code() {
        let svg = captcha_svg("ACD34", 7);
        assert!(svg.contains(">A<") && svg.contains(">4<"));
        assert_eq!(svg, captcha_svg("ACD34", 7), "the same seed draws the same picture");
        let png = captcha("ACD34", 7).expect("a picture");
        assert_eq!(&png[1..4], b"PNG");
        assert_eq!(picture_size(&png), Some((300.0, 110.0)));
    }
    #[test]
    fn colours_and_backgrounds_are_checked_like_good_boy_3() {
        assert_eq!(hex("#6B93FF").as_deref(), Some("#6b93ff"));
        assert_eq!(hex("6b93ff").as_deref(), Some("#6b93ff"));
        assert!(hex("red").is_none() && hex("#12345").is_none());
        assert!(ok_background("https://cdn.discordapp.com/attachments/1/2/pic.png?ex=abc&is=def"));
        assert!(ok_background("https://media.discordapp.net/attachments/1/2/pic.JPG"));
        assert!(!ok_background("https://example.com/attachments/1/2/pic.png"));
        assert!(!ok_background("https://cdn.discordapp.com/attachments/1/2/pic.svg"));
        assert_eq!(grouped(1234567), "1,234,567");
        assert_eq!(grouped(999), "999");
    }
    #[test]
    fn a_member_with_a_moving_picture_gets_a_moving_card() {
        let mut gif = Vec::new();
        {
            let mut e = gif::Encoder::new(&mut gif, 4, 4, &[]).unwrap();
            for c in [[255u8, 0, 0, 255], [0, 0, 255, 255], [0, 255, 0, 255]] {
                let mut px: Vec<u8> = c.iter().copied().cycle().take(64).collect();
                let mut f = gif::Frame::from_rgba(4, 4, &mut px);
                f.delay = 5;
                e.write_frame(&f).unwrap();
            }
        }
        let card = Rank { name: "Kai", avatar: None, level: 3, into: 10, needed: 100, rank: Some(1), xp: 400, messages: 20, accent: None, accent2: None, theme: None, background: None, pixel: false };
        let out = rank_card_animated(&card, &gif).expect("animated card");
        assert!(out.starts_with(b"GIF89a"));
        let mut dec = gif::DecodeOptions::new();
        dec.set_color_output(gif::ColorOutput::RGBA);
        let mut d = dec.read_info(&out[..]).unwrap();
        let mut sizes = Vec::new();
        while let Some(f) = d.read_next_frame().unwrap() { sizes.push((f.width, f.height)); }
        assert_eq!((d.width(), d.height(), sizes), (760, 220, vec![(760, 220), (190, 220), (190, 220)]));
        // a picture with one frame is not animated: the PNG is drawn instead
        let mut one = Vec::new();
        { let mut e = gif::Encoder::new(&mut one, 2, 2, &[]).unwrap(); let mut px = vec![255u8; 16]; e.write_frame(&gif::Frame::from_rgba(2, 2, &mut px)).unwrap(); }
        assert!(rank_card_animated(&card, &one).is_none());
        assert!(rank_card_animated(&card, b"not a gif").is_none());
    }
    #[test]
    fn a_rank_card_is_drawn() {
        let card = Rank { name: "Kai with a really long display name that goes on", avatar: None, level: 12, into: 180, needed: 1000, rank: Some(4), xp: 12840, messages: 1204, accent: None, accent2: None, theme: Some("midnight"), background: None, pixel: false };
        let png = rank_card(&card).expect("a picture");
        assert!(png.starts_with(&[0x89, b'P', b'N', b'G']));
        // 760 x 220, read from the PNG header
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 760);
        assert_eq!(u32::from_be_bytes(png[20..24].try_into().unwrap()), 220);
        let svg = rank_svg(&card);
        assert!(svg.contains("…") && svg.contains("RANK #4") && svg.contains("180 / 1,000 XP to level 13") && svg.contains("12,840 XP · 1,204 messages"));
        // a broken avatar falls back to initials, an unknown theme to dark
        let bad = Rank { avatar: Some(b"not a picture"), theme: Some("nope"), ..card };
        assert!(rank_svg(&bad).contains("#151a26") && rank_svg(&bad).contains(">KA<"));
    }
}

/// One row of a family tree: a person and their partners, and the families of their children (Good Boy 3's units).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TreeUnit {
    pub people: Vec<String>,
    pub children: Vec<TreeUnit>,
}
impl TreeUnit {
    pub fn count(&self) -> usize {
        self.people.len() + self.children.iter().map(TreeUnit::count).sum::<usize>()
    }
    pub fn ids(&self) -> Vec<String> {
        let mut out = self.people.clone();
        for c in &self.children { out.extend(c.ids()); }
        out
    }
}
const NODE_W: f32 = 150.0;
const NODE_H: f32 = 52.0;
const GAP_X: f32 = 18.0;
const GAP_Y: f32 = 58.0;
const HEART: f32 = 22.0;
struct Placed<'a> {
    unit: &'a TreeUnit,
    w: f32,
    x: f32,
    y: f32,
    kids: Vec<Placed<'a>>,
}
fn unit_width(u: &TreeUnit) -> f32 {
    u.people.len() as f32 * NODE_W + (u.people.len().saturating_sub(1)) as f32 * HEART
}
fn measure(u: &TreeUnit) -> Placed<'_> {
    let kids: Vec<Placed> = u.children.iter().map(measure).collect();
    let kids_w = kids.iter().map(|k| k.w).sum::<f32>() + kids.len().saturating_sub(1) as f32 * GAP_X;
    Placed { unit: u, w: unit_width(u).max(kids_w), x: 0.0, y: 0.0, kids }
}
fn place(p: &mut Placed, x: f32, y: f32) {
    p.x = x + (p.w - unit_width(p.unit)) / 2.0;
    p.y = y;
    let kids_w = p.kids.iter().map(|k| k.w).sum::<f32>() + p.kids.len().saturating_sub(1) as f32 * GAP_X;
    let mut cx = x + (p.w - kids_w) / 2.0;
    for k in &mut p.kids { place(k, cx, y + NODE_H + GAP_Y); cx += k.w + GAP_X; }
}
fn depth(u: &TreeUnit) -> usize {
    1 + u.children.iter().map(depth).max().unwrap_or(0)
}

/// The family tree as SVG (the same drawing as Good Boy 3's). `people`: id → (name, avatar bytes).
pub fn family_svg(u: &TreeUnit, people: &std::collections::HashMap<String, (String, Option<Vec<u8>>)>, highlight: Option<&str>, title: &str, pixel: bool) -> String {
    let mut root = measure(u);
    place(&mut root, 30.0, 70.0);
    let w = (root.w + 60.0).ceil().clamp(420.0, 4000.0);
    let h = (70.0 + depth(u) as f32 * (NODE_H + GAP_Y) - GAP_Y + 40.0).min(4000.0);
    let mut s = format!(r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
<rect width="{w}" height="{h}" fill="#0f131c"/>
<text x="30" y="40" font-family="'GB Display 700', sans-serif" font-size="20" fill="#e9edf5">{}</text>
"##, esc(title));
    let mut clip = 0;
    fn draw(s: &mut String, p: &Placed, people: &std::collections::HashMap<String, (String, Option<Vec<u8>>)>, highlight: Option<&str>, clip: &mut usize, pixel: bool) {
        for (k, id) in p.unit.people.iter().enumerate() {
            let x = p.x + k as f32 * (NODE_W + HEART);
            let y = p.y;
            let me = Some(id.as_str()) == highlight;
            let (name, avatar) = people.get(id).map(|(n, a)| (n.as_str(), a.as_deref())).unwrap_or(("Someone", None));
            s.push_str(&format!(r#"<rect x="{x}" y="{y}" width="{NODE_W}" height="{NODE_H}" rx="12" fill="{}" stroke="{}" stroke-width="{}"/>
"#, if me { "#24305a" } else { "#1b2130" }, if me { "#6b93ff" } else { "rgba(160,180,230,0.18)" }, if me { 2 } else { 1 }));
            let (cx, cy) = (x + 26.0, y + NODE_H / 2.0);
            *clip += 1;
            s.push_str(&format!(r#"<clipPath id="f{clip}"><circle cx="{cx}" cy="{cy}" r="16"/></clipPath>
"#));
            match avatar.and_then(|a| pixel::uri_at(a, pixel, 16)) {
                Some(uri) => s.push_str(&format!(r#"<image x="{}" y="{}" width="32" height="32" preserveAspectRatio="none"{} clip-path="url(#f{clip})" xlink:href="{uri}"/>
"#, cx - 16.0, cy - 16.0, pixel::attr(pixel))),
                None => s.push_str(&format!(r##"<g clip-path="url(#f{clip})"><rect x="{}" y="{}" width="32" height="32" fill="#6b93ff"/></g><text x="{cx}" y="{cy}" font-family="'GB Figtree 700', sans-serif" font-size="13" fill="#0b1020" text-anchor="middle" dominant-baseline="central">{}</text>
"##, cx - 16.0, cy - 16.0, esc(&name.chars().take(2).collect::<String>().to_uppercase()))),
            }
            let font = if me { FIGTREE_700 } else { FIGTREE_600 };
            let mut t: Vec<char> = name.chars().collect();
            let full = t.len();
            while width(font, 13.0, &t.iter().collect::<String>()) > NODE_W - 56.0 && t.len() > 2 { t.truncate(t.len() - 2); }
            let mut shown: String = t.iter().collect();
            if t.len() != full { shown.push('…'); }
            s.push_str(&format!(r##"<text x="{}" y="{cy}" font-family="'GB Figtree {}', sans-serif" font-size="13" fill="#e9edf5" dominant-baseline="central">{}</text>
"##, x + 48.0, if me { 700 } else { 600 }, esc(&shown)));
            if k > 0 {
                s.push_str(&format!(r##"<text x="{}" y="{cy}" font-family="sans-serif" font-size="16" fill="#ff6b9a" text-anchor="middle" dominant-baseline="central">♥</text>
"##, x - HEART / 2.0));
            }
        }
        if !p.kids.is_empty() {
            let (from_x, from_y) = (p.x + unit_width(p.unit) / 2.0, p.y + NODE_H);
            let mid = from_y + GAP_Y / 2.0;
            let xs: Vec<f32> = p.kids.iter().map(|c| c.x + NODE_W / 2.0).collect();
            let lo = xs.iter().copied().fold(from_x, f32::min);
            let hi = xs.iter().copied().fold(from_x, f32::max);
            let line = "stroke=\"rgba(160,180,230,0.35)\" stroke-width=\"2\"";
            s.push_str(&format!("<line x1=\"{from_x}\" y1=\"{from_y}\" x2=\"{from_x}\" y2=\"{mid}\" {line}/>\n<line x1=\"{lo}\" y1=\"{mid}\" x2=\"{hi}\" y2=\"{mid}\" {line}/>\n"));
            for c in &p.kids {
                let cx = c.x + NODE_W / 2.0;
                s.push_str(&format!("<line x1=\"{cx}\" y1=\"{mid}\" x2=\"{cx}\" y2=\"{}\" {line}/>\n", c.y));
                draw(s, c, people, highlight, clip, pixel);
            }
        }
    }
    draw(&mut s, &root, people, highlight, &mut clip, pixel);
    s.push_str("</svg>");
    s
}
/// The family tree as a PNG. None if it could not be drawn (then the text tree is shown, as in Good Boy 3).
pub fn family_tree(u: &TreeUnit, people: &std::collections::HashMap<String, (String, Option<Vec<u8>>)>, highlight: Option<&str>, title: &str, pixel: bool) -> Option<Vec<u8>> {
    png(&family_svg(u, people, highlight, title, pixel))
}
