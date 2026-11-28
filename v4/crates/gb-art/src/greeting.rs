//! Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
//!
//! The welcome and goodbye picture: the server's own background picture (or a colour theme), the member's profile picture
//! in a ring, and two lines of text. 1000 x 360, so it sits well in a Discord channel. The dashboard draws the very same
//! picture for its preview, so what the server owner sees is what members get.

use crate::{data_uri, esc, picture_size, pixel, png, width, DISPLAY_700, THEMES};

/// What goes on a welcome or goodbye picture.
#[derive(Clone, Copy)]
pub struct Greeting<'a> {
    /// Shown as initials when there is no profile picture.
    pub name: &'a str,
    pub avatar: Option<&'a [u8]>,
    /// The server's background picture (raw bytes); None draws the colour theme.
    pub background: Option<&'a [u8]>,
    pub title: &'a str,
    pub line: &'a str,
    pub accent: Option<&'a str>,
    pub theme: Option<&'a str>,
    /// Draw the profile picture as pixel art (the server's choice).
    pub pixel: bool,
}

pub const WIDTH: f32 = 1000.0;
pub const HEIGHT: f32 = 360.0;
const GRID: u32 = 60;

/// Shortens text until it fits `room` pixels in the title font, ending in "…".
fn fit(text: &str, size: f32, room: f32) -> String {
    let mut chars: Vec<char> = text.chars().collect();
    let full = chars.len();
    while width(DISPLAY_700, size, &chars.iter().collect::<String>()) > room && chars.len() > 3 { chars.truncate(chars.len() - 2); }
    let mut out: String = chars.iter().collect();
    if chars.len() != full { out.push('…'); }
    out
}

/// The picture as SVG.
pub fn greeting_svg(g: &Greeting) -> String {
    let t = g.theme.and_then(|id| THEMES.iter().find(|t| t.id == id)).unwrap_or(&THEMES[0]);
    let light = t.id == "light";
    let accent = g.accent.and_then(crate::hex).unwrap_or_else(|| "#6b93ff".into());
    let mut s = format!(r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1000" height="360" viewBox="0 0 1000 360">
<defs>
<linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1000" y2="360"><stop offset="0" stop-color="{b0}"/><stop offset="1" stop-color="{b1}"/></linearGradient>
<clipPath id="card"><rect width="1000" height="360" rx="28"/></clipPath>
<clipPath id="face"><circle cx="500" cy="118" r="76"/></clipPath>
</defs>
<rect width="1000" height="360" rx="28" fill="url(#bg)"/>
"##, b0 = t.bg[0], b1 = t.bg[1]);
    // the server's picture fills the card (cropped to fit), dimmed so the words stay readable
    if let Some((bytes, uri)) = g.background.and_then(|b| Some((b, data_uri(b)?))) {
        if let Some((pw, ph)) = picture_size(bytes) {
            let scale = (WIDTH / pw).max(HEIGHT / ph);
            let (dw, dh) = (pw * scale, ph * scale);
            s.push_str(&format!(r#"<g clip-path="url(#card)"><image x="{}" y="{}" width="{dw}" height="{dh}" preserveAspectRatio="none" xlink:href="{uri}"/><rect width="1000" height="360" fill="{}"/></g>
"#, (WIDTH - dw) / 2.0, (HEIGHT - dh) / 2.0, if light { "rgba(246,248,252,0.55)" } else { "rgba(8,10,18,0.50)" }));
        }
    }
    s.push_str(&format!(r#"<g clip-path="url(#card)"><rect y="346" width="1000" height="14" fill="{accent}"/></g>
<circle cx="500" cy="118" r="84" fill="{}"/><circle cx="500" cy="118" r="80" fill="none" stroke="{accent}" stroke-width="6"/>
"#, t.track));
    match g.avatar.and_then(|a| pixel::uri_at(a, g.pixel, GRID)) {
        Some(uri) => s.push_str(&format!(r#"<image x="424" y="42" width="152" height="152" preserveAspectRatio="none"{} clip-path="url(#face)" xlink:href="{uri}"/>
"#, pixel::attr(g.pixel))),
        None => {
            let initials: String = g.name.chars().take(2).collect::<String>().to_uppercase();
            s.push_str(&format!(r##"<g clip-path="url(#face)"><rect x="424" y="42" width="152" height="152" fill="{accent}"/></g><text x="500" y="132" font-family="'GB Display 800', sans-serif" font-size="48" fill="#0b1020" text-anchor="middle">{}</text>
"##, esc(&initials)));
        }
    }
    let title = fit(g.title, 46.0, 900.0);
    s.push_str(&format!(r#"<text x="500" y="252" font-family="'GB Display 800', sans-serif" font-size="46" fill="{}" text-anchor="middle">{}</text>
"#, t.text, esc(&title)));
    if !g.line.trim().is_empty() {
        let line = fit(g.line, 24.0, 900.0);
        s.push_str(&format!(r#"<text x="500" y="298" font-family="'GB Figtree 600', sans-serif" font-size="24" fill="{}" text-anchor="middle">{}</text>
"#, t.soft, esc(&line)));
    }
    s.push_str("</svg>");
    s
}

/// The picture as a PNG. None if anything goes wrong (then the message goes out as text).
pub fn greeting_card(g: &Greeting) -> Option<Vec<u8>> {
    png(&greeting_svg(g))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_greeting_card_is_drawn_with_or_without_pictures() {
        let plain = Greeting { name: "Alex", avatar: None, background: None, title: "Welcome, Alex!", line: "You are member #123", accent: Some("#fd78f7"), theme: Some("midnight"), pixel: false };
        let png = greeting_card(&plain).expect("drawn");
        assert!(png.starts_with(&[0x89, b'P', b'N', b'G']));
        // a very long name is shortened, never overflowing
        let long = Greeting { title: "Welcome, A Person With An Extraordinarily Long Display Name That Would Never Fit!", ..plain };
        let svg = greeting_svg(&long);
        assert!(svg.contains('…'), "shortened with an ellipsis");
        assert!(greeting_card(&long).is_some());
        // words that could break the picture are escaped
        let sneaky = Greeting { title: "<b>&\"</b>", line: "", ..plain };
        assert!(greeting_svg(&sneaky).contains("&lt;b&gt;&amp;&quot;&lt;/b&gt;"));
        assert!(greeting_card(&sneaky).is_some());
        // an unknown theme and a bad colour fall back to the defaults
        assert!(greeting_card(&Greeting { theme: Some("nope"), accent: Some("red"), ..plain }).is_some());
    }

    #[test]
    fn a_background_picture_fills_the_card_and_is_dimmed() {
        // a tiny 2x1 PNG made here (white and black), stretched over the whole card
        let bg = png_of_two_pixels();
        let g = Greeting { name: "Alex", avatar: None, background: Some(&bg), title: "Welcome!", line: "Hi", accent: None, theme: None, pixel: false };
        let svg = greeting_svg(&g);
        assert!(svg.contains("data:image/png;base64,") && svg.contains("rgba(8,10,18,0.50)"));
        assert!(greeting_card(&g).is_some());
    }

    #[test]
    fn a_thumbnail_is_a_small_png_of_any_picture_and_nothing_for_other_files() {
        let t = crate::thumbnail(&png_of_two_pixels()).expect("a small picture");
        assert_eq!(&t[1..4], b"PNG");
        assert!(crate::thumbnail(b"not a picture").is_none() && crate::thumbnail(&[]).is_none());
    }

    fn png_of_two_pixels() -> Vec<u8> {
        // the smallest valid 2x1 RGB PNG, written by hand
        let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        let chunk = |kind: &[u8; 4], data: &[u8]| {
            let mut c = Vec::new();
            c.extend((data.len() as u32).to_be_bytes());
            c.extend(kind);
            c.extend(data);
            let mut crc = 0xFFFF_FFFFu32;
            for b in kind.iter().chain(data) { crc ^= *b as u32; for _ in 0..8 { crc = if crc & 1 != 0 { 0xEDB8_8320 ^ (crc >> 1) } else { crc >> 1 }; } }
            c.extend((!crc).to_be_bytes());
            c
        };
        out.extend(chunk(b"IHDR", &[0, 0, 0, 2, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
        // one scanline: filter 0, then white and black pixels, stored (uncompressed) in a zlib stream
        let raw = [0u8, 255, 255, 255, 0, 0, 0];
        let mut z = vec![0x78, 0x01, 0x01, raw.len() as u8, 0, !(raw.len() as u8), 0xFF];
        z.extend(raw);
        let (mut a, mut b) = (1u32, 0u32);
        for x in raw { a = (a + x as u32) % 65521; b = (b + a) % 65521; }
        z.extend(((b << 16) | a).to_be_bytes());
        out.extend(chunk(b"IDAT", &z));
        out.extend(chunk(b"IEND", &[]));
        out
    }
}
