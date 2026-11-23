//! The image quote, drawn like the launcher: an 8-bit card with a pixel frame, the speaker's picture as pixel art on the
//! left (fading into the dark), their words in a pixel font on the right with their name, handle and the date, and
//! the picture from the message, if it had one, as pixel art under the words. Characters the pixel fonts do not have
//! (other scripts, fancy letters, emoji) are drawn in the computer's own fonts. A still PNG, a "motion" GIF (a light
//! band steps across the picture), or, for an animated profile picture, a GIF of it moving. Only the left tile changes
//! between frames, so every frame after the first is just that tile (a much smaller file).

use crate::{esc, fonts, pixel, png};

#[path = "quote_classic.rs"]
mod classic;

pub const W: u32 = 1200;
pub const H: u32 = 630;
const TILE_W: u32 = 643; // the part the picture and its fade can touch; the words start further right
pub const MAX_UPLOAD: usize = 8 * 1024 * 1024;
pub const MOTION_FRAMES: usize = 28;
const MOTION_LOOP_MS: u32 = 2800;
pub const GIF_FRAMES: usize = 60;
/// The initial letter's font: the pixel font first, then whatever the computer has for anything it lacks.
const LABEL: &str = "'Press Start 2P', 'Segoe UI', 'Segoe UI Symbol', 'Segoe UI Emoji', 'Noto Sans', sans-serif";
/// What a character the pixel font lacks is drawn in (the computer's own fonts, the way it would show it anywhere).
const FALLBACK: &str = "'Segoe UI', 'Segoe UI Symbol', 'Segoe UI Emoji', 'Noto Sans', sans-serif";
const TEXT_X: f32 = 660.0;
const TEXT_W: f32 = 484.0;
/// The size of a pixel in the picture from the message (it is shown 472 x 118, so 59 x 15 pixels).
const PHOTO: (u32, u32) = (59, 15);
/// The profile picture is 46 x 46 pixels, each drawn 12 wide (46 x 12 = the 552 the picture is shown at).
const TILE_GRID: u32 = 46;

/// What a quote says and who said it.
#[derive(Debug, Clone, Default)]
pub struct Quote {
    pub text: String,
    pub name: String,
    pub handle: String,
    /// "Nov 12, 2026"
    pub when: String,
    pub color: bool,
    /// Pixel art for the pictures (the server's choice).
    pub pixel: bool,
    /// The first picture in the quoted message, if it had one.
    pub picture: Option<Vec<u8>>,
    /// The colours and font of a classic quote; none draws the pixel quote.
    pub look: Option<Look>,
}

/// The font a classic quote is written in.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum Font { #[default] Sans, Serif, Mono }
impl Font {
    pub fn from_id(id: &str) -> Font { match id { "serif" => Font::Serif, "mono" => Font::Mono, _ => Font::Sans } }
    /// The computer's fonts for it, best first (the bundled Figtree is the last resort).
    pub fn names(self) -> Vec<&'static str> {
        match self {
            Font::Sans => vec!["Segoe UI", "Helvetica Neue", "Helvetica", "Arial", "GB Figtree 600"],
            Font::Serif => vec!["Georgia", "Times New Roman", "Cambria", "Times", "GB Figtree 600"],
            Font::Mono => vec!["Consolas", "Cascadia Mono", "Menlo", "Courier New", "GB Figtree 600"],
        }
    }
    /// The same list as an SVG font-family.
    pub fn family(self) -> String {
        let generic = match self { Font::Sans => "sans-serif", Font::Serif => "serif", Font::Mono => "monospace" };
        format!("{}, {generic}", self.names().iter().map(|n| format!("'{n}'")).collect::<Vec<_>>().join(", "))
    }
}

/// The colours of a classic quote.
#[derive(Debug, Clone, PartialEq)]
pub struct Look {
    pub bg: String,
    pub text: String,
    pub muted: String,
    pub accent: String,
    /// Behind the initial letter, when the speaker has no picture.
    pub panel: String,
    pub font: Font,
}
/// The looks a server can pick from: (id, what people see).
pub const LOOKS: &[(&str, &str)] = &[("classic", "Classic (black)"), ("midnight", "Midnight blue"), ("paper", "Paper"), ("sunset", "Sunset"), ("forest", "Forest"), ("pixel", "Pixel (8-bit)")];
fn hex(s: &str) -> Option<(u8, u8, u8)> {
    let h = s.trim().strip_prefix('#')?;
    if h.len() != 6 || !h.is_ascii() { return None; }
    Some((u8::from_str_radix(&h[0..2], 16).ok()?, u8::from_str_radix(&h[2..4], 16).ok()?, u8::from_str_radix(&h[4..6], 16).ok()?))
}
/// A colour `t` of the way from `a` to `b` (both "#rrggbb").
fn mix(a: &str, b: &str, t: f32) -> String {
    let (x, y) = (hex(a).unwrap_or((0, 0, 0)), hex(b).unwrap_or((255, 255, 255)));
    let m = |p: u8, q: u8| (p as f32 + (q as f32 - p as f32) * t).round() as u8;
    format!("#{:02x}{:02x}{:02x}", m(x.0, y.0), m(x.1, y.1), m(x.2, y.2))
}
/// A look from three colours and a font (the muted and panel colours follow from them). None when a colour is not "#rrggbb".
pub fn make_look(bg: &str, text: &str, accent: &str, font: Font) -> Option<Look> {
    hex(bg)?; hex(text)?; hex(accent)?;
    Some(Look { bg: bg.trim().to_lowercase(), text: text.trim().to_lowercase(), muted: mix(bg, text, 0.6), accent: accent.trim().to_lowercase(), panel: mix(bg, text, 0.12), font })
}
/// A ready-made look by its id; none for "pixel" (that is the other renderer) and for ids that do not exist.
pub fn preset_look(id: &str) -> Option<Look> {
    let (bg, text, accent, font) = match id {
        "classic" => ("#000000", "#ffffff", "#5865f2", Font::Sans),
        "midnight" => ("#0b1020", "#e8ecff", "#6c7cff", Font::Sans),
        "paper" => ("#f4efe6", "#1d1b17", "#b4562a", Font::Serif),
        "sunset" => ("#2a1226", "#ffe8d6", "#ff7a59", Font::Sans),
        "forest" => ("#0d1a14", "#e6f4ea", "#3ddc84", Font::Sans),
        _ => return None,
    };
    let mut l = make_look(bg, text, accent, font)?;
    if id == "classic" { l.muted = "#9a9a9a".into(); l.panel = "#23272f".into(); }
    Some(l)
}

/// How wide text with every character in the pixel font is.
fn face_width(family: &str, size: f32, text: &str) -> f32 {
    use resvg::usvg::fontdb::{Family, Query, Stretch, Style, Weight};
    let db = fonts();
    let families = [Family::Name(family)];
    let q = Query { families: &families, weight: Weight::NORMAL, stretch: Stretch::Normal, style: Style::Normal };
    db.query(&q).and_then(|id| db.with_face_data(id, |data, index| {
        let face = ttf_parser::Face::parse(data, index).ok()?;
        let per = size / face.units_per_em() as f32;
        Some(text.chars().map(|c| face.glyph_index(c).and_then(|g| face.glyph_hor_advance(g)).map_or(size * 0.5, |a| a as f32 * per)).sum::<f32>())
    }).flatten()).unwrap_or_else(|| text.chars().count() as f32 * size * 0.5)
}
/// How wide text the pixel font lacks is, once the computer's own fonts draw it. Asked of the renderer itself (a
/// `|` on each side, so spaces count), and remembered.
fn fallback_width(size: f32, text: &str) -> f32 {
    use std::cell::RefCell;
    use std::collections::HashMap;
    thread_local! { static SEEN: RefCell<HashMap<(String, u32), f32>> = RefCell::default(); }
    let key = (text.to_string(), size.round() as u32);
    if let Some(w) = SEEN.with(|m| m.borrow().get(&key).copied()) { return w; }
    let of = |t: &str| -> Option<f32> {
        let svg = format!(r##"<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="400"><text x="0" y="200" font-family="{FALLBACK}" font-size="{size}" xml:space="preserve">{}</text></svg>"##, esc(t));
        let tree = resvg::usvg::Tree::from_str(&svg, &resvg::usvg::Options { fontdb: fonts(), ..Default::default() }).ok()?;
        tree.root().children().iter().find_map(|n| if let resvg::usvg::Node::Text(t) = n { Some(t.bounding_box().width()) } else { None })
    };
    let w = match (of(&format!("|{text}|")), of("||")) { (Some(a), Some(b)) => (a - b).max(0.0), _ => text.chars().count() as f32 * size };
    SEEN.with(|m| { let mut m = m.borrow_mut(); if m.len() > 4000 { m.clear(); } m.insert(key, w); });
    w
}
/// How wide text is in a pixel font, drawing what it lacks in the computer's own fonts.
fn text_width(family: &str, size: f32, text: &str) -> f32 {
    runs(family, text).iter().map(|(ok, run)| if *ok { face_width(family, size, run) } else { fallback_width(size, run) }).sum()
}
/// How wide text is in the body font.
fn measure(size: f32, text: &str) -> f32 { text_width("VT323", size, text) }

/// The text cut into runs: `true` where the pixel font has every character, `false` where it does not (spaces go with
/// the run before them). Each run is then drawn on its own, so one emoji does not change the font of the whole line.
fn runs(family: &str, text: &str) -> Vec<(bool, String)> {
    use resvg::usvg::fontdb::{Family, Query, Stretch, Style, Weight};
    let db = fonts();
    let families = [Family::Name(family)];
    let q = Query { families: &families, weight: Weight::NORMAL, stretch: Stretch::Normal, style: Style::Normal };
    let has: Vec<bool> = db.query(&q).and_then(|id| db.with_face_data(id, |data, index| {
        let face = ttf_parser::Face::parse(data, index).ok()?;
        Some(text.chars().map(|c| face.glyph_index(c).is_some()).collect::<Vec<bool>>())
    }).flatten()).unwrap_or_else(|| text.chars().map(|_| true).collect());
    let mut out: Vec<(bool, String)> = Vec::new();
    for (c, ok) in text.chars().zip(has) {
        let ok = if c == ' ' { out.last().is_none_or(|r| r.0) } else { ok };
        match out.last_mut() { Some((k, run)) if *k == ok => run.push(c), _ => out.push((ok, c.to_string())) }
    }
    out
}
/// The text drawn from `x`: each run on its own, in the pixel font or, where it has no such character, in the
/// computer's own fonts, so one emoji does not change the font of the whole line.
fn put(family: &str, x: f32, y: f32, size: f32, fill: &str, text: &str) -> String {
    let (mut x, mut out) = (x, String::new());
    for (ok, run) in runs(family, text) {
        let font = if ok { format!("'{family}'") } else { FALLBACK.to_string() };
        out.push_str(&format!(r#"<text x="{x}" y="{y}" font-family="{font}" font-size="{size}" fill="{fill}" xml:space="preserve">{}</text>"#, esc(&run)));
        x += if ok { face_width(family, size, &run) } else { fallback_width(size, &run) };
    }
    out.push('\n');
    out
}
/// A pixel-art opening quote mark (the pixel font's own is only a speck): two little 66-shapes, in shadow and colour.
fn quote_mark(x: f32, y: f32) -> String {
    const CELLS: [(f32, f32); 5] = [(1.0, 0.0), (0.0, 1.0), (1.0, 1.0), (0.0, 2.0), (1.0, 2.0)];
    let draw = |dx: f32, dy: f32, fill: &str| {
        let mut g = format!(r#"<g fill="{fill}">"#);
        for mark in [0.0f32, 3.5] { for (cx, cy) in CELLS { g.push_str(&format!(r#"<rect x="{}" y="{}" width="12" height="12"/>"#, x + dx + (mark + cx) * 12.0, y + dy + cy * 12.0)); } }
        g.push_str("</g>\n"); g
    };
    format!("{}{}", draw(4.0, 4.0, "#ff5a67"), draw(0.0, 0.0, "#f6dc3b"))
}

/// What a message says, ready to draw: custom server emoji (`<:name:123>`) read as `:name:`, and the invisible
/// characters that only confuse the layout are dropped.
pub fn clean(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('<') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let custom = tail.strip_prefix("<a:").or_else(|| tail.strip_prefix("<:")).and_then(|t| {
            let end = t.find('>')?;
            let (name, id) = t[..end].split_once(':')?;
            (!name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_') && !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())).then(|| (format!(":{name}:"), at + (tail.len() - t.len()) + end + 1))
        });
        match custom {
            Some((shown, next)) => { out.push_str(&shown); rest = &rest[next..]; }
            None => { out.push('<'); rest = &rest[at + 1..]; }
        }
    }
    out.push_str(rest);
    out.chars().filter(|c| !matches!(*c as u32, 0x200B | 0x200C | 0x2060 | 0xFEFF | 0x202A..=0x202E | 0x2066..=0x2069) && (!c.is_control() || *c == '\n')).collect()
}
/// Word-wraps text to a width, splitting words wider than a line (Good Boy 3's wrapText).
pub fn wrap_text(measure: &dyn Fn(&str) -> f32, text: &str, max_width: f32) -> Vec<String> {
    let mut lines = Vec::new();
    for para in text.split('\n') {
        let mut line = String::new();
        for word in para.split_whitespace() {
            let mut w: String = word.to_string();
            while measure(&w) > max_width && w.chars().count() > 1 {
                let chars: Vec<char> = w.chars().collect();
                let mut cut = chars.len();
                while cut > 1 && measure(&chars[..cut].iter().collect::<String>()) > max_width { cut -= 1; }
                if !line.is_empty() { lines.push(std::mem::take(&mut line)); }
                lines.push(chars[..cut].iter().collect());
                w = chars[cut..].iter().collect();
            }
            let test = if line.is_empty() { w.clone() } else { format!("{line} {w}") };
            if measure(&test) <= max_width { line = test; } else { if !line.is_empty() { lines.push(line); } line = w; }
        }
        if !line.is_empty() { lines.push(line); }
    }
    lines
}
/// The largest size (54 down to 24) at which the wrapped text fits (Good Boy 3's fitText).
pub fn fit_text(measure_at: &dyn Fn(f32, &str) -> f32, text: &str, max_width: f32, max_height: f32) -> (f32, Vec<String>) {
    fit_lines(measure_at, text, max_width, max_height, (54.0, 24.0), 1.25)
}
/// The largest size from `sizes.0` down to `sizes.1` (two at a time) at which the wrapped text fits.
pub fn fit_lines(measure_at: &dyn Fn(f32, &str) -> f32, text: &str, max_width: f32, max_height: f32, sizes: (f32, f32), line_height: f32) -> (f32, Vec<String>) {
    let mut lines = Vec::new();
    let mut size = sizes.0;
    while size >= sizes.1 {
        lines = wrap_text(&|s| measure_at(size, s), text, max_width);
        if lines.len() as f32 * size * line_height <= max_height { return (size, lines); }
        size -= 2.0;
    }
    let keep = (max_height / (sizes.1 * line_height)).floor() as usize;
    (sizes.1, lines.into_iter().take(keep).collect())
}

fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}

/// The caption: the words (fitted), a text cursor, the name, and the handle and date. The same for every frame.
fn caption(q: &Quote) -> String {
    let with_photo = q.picture.is_some();
    // (where the opening mark sits, where the words start, how tall they may be, where the name and handle sit)
    let (mark_y, top, max_h, name_y, at_y) = if with_photo { (92.0f32, 106.0f32, 190.0f32, 490.0f32, 534.0f32) } else { (112.0, 134.0, 286.0, 478.0, 526.0) };
    let text = clean(&q.text);
    let (size, lines) = fit_lines(&|sz, s| measure(sz, s), &text, TEXT_W, max_h, (68.0, 30.0), 1.02);
    let lh = size * 1.02;
    let mut s = String::new();
    s.push_str(&quote_mark(TEXT_X, mark_y - 36.0));
    // the words, vertically centred in their space
    let first = top + (max_h - lines.len() as f32 * lh) / 2.0;
    for (n, l) in lines.iter().enumerate() {
        let y = first + n as f32 * lh + size * 0.78;
        s.push_str(&put("VT323", TEXT_X + 3.0, y + 3.0, size, "#0d0a26", l));
        s.push_str(&put("VT323", TEXT_X, y, size, "#f1e7cf", l));
    }
    // the text cursor after the last word
    if let Some(last) = lines.last() {
        let y = first + (lines.len() - 1) as f32 * lh + size * 0.78;
        s.push_str(&format!(r##"<rect x="{}" y="{}" width="{}" height="{}" fill="#62f0b4"/>
"##, TEXT_X + measure(size, last) + size * 0.12, y - size * 0.7, (size * 0.36).max(10.0), size * 0.74));
    }
    if let Some(photo) = &q.picture {
        let (x, y, w, h) = (TEXT_X, 306.0f32, TEXT_W, 130.0f32);
        s.push_str(&format!(r##"<rect x="{}" y="{}" width="{w}" height="{h}" fill="#0d0a26"/><rect x="{x}" y="{y}" width="{w}" height="{h}" fill="#221d54" stroke="#0d0a26" stroke-width="6"/>
"##, x + 6.0, y + 6.0));
        let (ix, iy, iw, ih) = (x + 6.0, y + 6.0, w - 12.0, h - 12.0);
        if let Some(uri) = pixel::uri_rect(photo, q.pixel, PHOTO.0, PHOTO.1) {
            s.push_str(&format!(r#"<image x="{ix}" y="{iy}" width="{iw}" height="{ih}" preserveAspectRatio="{}"{} xlink:href="{uri}"/>
"#, if q.pixel { "none" } else { "xMidYMid slice" }, pixel::attr(q.pixel)));
        }
    }
    s.push_str(&put("Press Start 2P", TEXT_X, name_y, 20.0, "#f6dc3b", &short(&clean(&q.name), 22)));
    s.push_str(&put("VT323", TEXT_X, at_y, 30.0, "#a19bd6", &format!("@{}  ·  {}", short(&clean(&q.handle), 32), q.when)));
    s
}
/// The left tile: the picture (or the initial) in a pixel frame, fading into the dark. `zoom`/`drift` move an ordinary
/// picture (motion quotes; pixel art stays still so its pixels do not shimmer); `shine` is where the light band is
/// (0..1), if anywhere, and it moves in whole steps.
fn tile(q: &Quote, picture: Option<&str>, zoom: f32, drift: f32, shine: Option<f32>) -> String {
    let mut s = String::from(r##"<defs><filter id="bw" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0.299 0.587 0.114 0 0 0.299 0.587 0.114 0 0 0.299 0.587 0.114 0 0 0 0 0 1 0"/></filter>
<pattern id="stripes" width="24" height="630" patternUnits="userSpaceOnUse"><rect width="12" height="630" fill="#0d0a26"/></pattern>
<linearGradient id="fadeg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>
<mask id="fadem"><rect x="300" y="36" width="300" height="558" fill="url(#fadeg)"/></mask>
<clipPath id="inner"><rect x="39" y="39" width="552" height="552"/></clipPath></defs>
<rect x="44" y="44" width="558" height="558" fill="#0d0a26"/>
<rect x="36" y="36" width="558" height="558" fill="#221d54" stroke="#0d0a26" stroke-width="6"/>
"##);
    let filter = if q.color { "" } else { r#" filter="url(#bw)""# };
    s.push_str(&format!(r#"<g clip-path="url(#inner)"{filter}>"#));
    match picture {
        Some(uri) if q.pixel => s.push_str(&format!(r#"<image x="39" y="39" width="552" height="552" preserveAspectRatio="none"{} xlink:href="{uri}"/>"#, pixel::attr(true))),
        Some(uri) => {
            let sz = 552.0 * zoom;
            s.push_str(&format!(r#"<image x="{}" y="{}" width="{sz}" height="{sz}" preserveAspectRatio="none" xlink:href="{uri}"/>"#, 39.0 + (552.0 - sz) / 2.0 + drift * 552.0, 39.0 + (552.0 - sz) / 2.0));
        }
        None => {
            let initial: String = clean(&q.name).chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_else(|| "?".into());
            s.push_str(&format!(r##"<rect x="39" y="39" width="552" height="552" fill="#2d2768"/><text x="315" y="330" font-family="{LABEL}" font-size="220" fill="#6db7ff" text-anchor="middle" dominant-baseline="central">{}</text>"##, esc(&initial)));
        }
    }
    s.push_str("</g>\n<rect x=\"300\" y=\"36\" width=\"300\" height=\"558\" fill=\"url(#stripes)\" mask=\"url(#fadem)\"/>\n");
    if let Some(p) = shine {
        // a hard-edged band that jumps along in eight steps
        let step = ((p * 8.0).floor() / 8.0).clamp(0.0, 1.0);
        let x = 39.0 + step * 552.0;
        s.push_str(&format!("<g clip-path=\"url(#inner)\"><rect x=\"{x}\" y=\"39\" width=\"70\" height=\"552\" fill=\"#fff\" fill-opacity=\"0.2\"/></g>\n"));
    }
    s
}
/// The page, in the same dark grid, pixel frame and scanlines whatever is drawn on it.
fn svg(width: u32, body: &str) -> String {
    format!(r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{width}" height="{H}" viewBox="0 0 {width} {H}"><defs>
<pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><rect width="24" height="24" fill="#0d0a26"/><path d="M0 0H24M0 0V24" stroke="#17133a" stroke-width="4"/></pattern>
<pattern id="scan" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#000" fill-opacity="0.16"/></pattern></defs>
<rect width="{width}" height="{H}" fill="url(#grid)"/>{body}
<rect x="6" y="6" width="{}" height="{}" fill="none" stroke="#2d2768" stroke-width="12"/><rect x="15" y="15" width="{}" height="{}" fill="none" stroke="#0d0a26" stroke-width="6"/><rect x="21" y="21" width="{}" height="{}" fill="none" stroke="#f6dc3b" stroke-width="6"/>
<rect width="{width}" height="{H}" fill="url(#scan)"/></svg>"##, W - 12, H - 12, W - 30, H - 30, W - 42, H - 42)
}
/// The still quote as a PNG.
pub fn quote_png(q: &Quote, avatar: Option<&[u8]>) -> Option<Vec<u8>> {
    if let Some(l) = &q.look { return classic::quote_png(q, l, avatar); }
    let uri = avatar.and_then(|a| pixel::uri_at(a, q.pixel, TILE_GRID));
    png(&svg(W, &format!("{}{}", tile(q, uri.as_deref(), 1.0, 0.0, None), caption(q))))
}
/// One frame's zoom, drift and shine for a point in the loop (Good Boy 3's motionAt).
pub fn motion_at(phase: f32) -> (f32, f32, Option<f32>) {
    let wave = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * phase).cos();
    (1.0 + 0.075 * wave, (2.0 * std::f32::consts::PI * phase).sin() * 0.012, (phase < 0.5).then(|| phase / 0.5))
}

fn rgba(svg_text: &str) -> Option<(u32, Vec<u8>)> {
    let opt = resvg::usvg::Options { fontdb: fonts(), ..Default::default() };
    let tree = resvg::usvg::Tree::from_str(svg_text, &opt).ok()?;
    let size = tree.size().to_int_size();
    let mut pixmap = resvg::tiny_skia::Pixmap::new(size.width(), size.height())?;
    resvg::render(&tree, resvg::tiny_skia::Transform::default(), &mut pixmap.as_mut());
    // tiny-skia keeps colours premultiplied; everything here is opaque, so they are the same
    Some((size.width(), pixmap.take()))
}
/// Frames to a GIF: the first is the whole picture, the rest only the tile. `delays` in milliseconds.
fn encode(frames: Vec<(u32, Vec<u8>, u32)>) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = gif::Encoder::new(&mut out, W as u16, H as u16, &[]).ok()?;
        enc.set_repeat(gif::Repeat::Infinite).ok()?;
        for (width, mut px, delay) in frames {
            let mut f = gif::Frame::from_rgba_speed(width as u16, H as u16, &mut px, 10);
            f.delay = (delay / 10).max(2) as u16;
            enc.write_frame(&f).ok()?;
        }
    }
    Some(out)
}
/// The motion quote (a slow zoom and a shine), with fewer frames when it would be too big. None when it can't be drawn.
pub fn quote_motion(q: &Quote, avatar: Option<&[u8]>) -> Option<Vec<u8>> {
    if let Some(l) = &q.look { return classic::quote_motion(q, l, avatar); }
    let uri = avatar.and_then(|a| pixel::uri_at(a, q.pixel, TILE_GRID));
    let cap = caption(q);
    let mut last = None;
    for count in [MOTION_FRAMES, MOTION_FRAMES / 2] {
        let delay = MOTION_LOOP_MS / count as u32;
        let mut frames = Vec::new();
        for n in 0..count {
            let (zoom, drift, shine) = motion_at(n as f32 / count as f32);
            let t = tile(q, uri.as_deref(), zoom, drift, shine);
            let (w, px) = if n == 0 { rgba(&svg(W, &format!("{t}{cap}")))? } else { rgba(&svg(TILE_W, &t))? };
            frames.push((w, px, delay));
        }
        let gif = encode(frames)?;
        if gif.len() <= MAX_UPLOAD { return Some(gif); }
        last = Some(gif);
    }
    last
}
/// An animated profile picture's frames as PNGs with their delays (at most `max` frames, spread over the loop).
pub fn gif_frames(bytes: &[u8], max: usize) -> Vec<(Vec<u8>, u32)> {
    let mut opts = gif::DecodeOptions::new();
    opts.set_color_output(gif::ColorOutput::RGBA);
    let Ok(mut dec) = opts.read_info(bytes) else { return Vec::new() };
    let (w, h) = (dec.width() as usize, dec.height() as usize);
    if w == 0 || h == 0 || w * h > 4096 * 4096 { return Vec::new(); }
    let mut canvas = vec![0u8; w * h * 4];
    let mut all: Vec<(Vec<u8>, u32)> = Vec::new();
    while let Ok(Some(f)) = dec.read_next_frame() {
        let (fl, ft, fw, fh) = (f.left as usize, f.top as usize, f.width as usize, f.height as usize);
        let before = (f.dispose == gif::DisposalMethod::Previous).then(|| canvas.clone());
        for y in 0..fh { for x in 0..fw {
            let (cx, cy) = (fl + x, ft + y);
            if cx >= w || cy >= h { continue; }
            let s = (y * fw + x) * 4;
            if f.buffer.get(s + 3).copied().unwrap_or(0) == 0 { continue; }
            let d = (cy * w + cx) * 4;
            canvas[d..d + 4].copy_from_slice(&f.buffer[s..s + 4]);
        } }
        let mut pm = resvg::tiny_skia::Pixmap::new(w as u32, h as u32);
        if let Some(p) = pm.as_mut() {
            for (k, px) in canvas.chunks(4).enumerate() {
                let a = px[3] as u16;
                let pre = |c: u8| ((c as u16 * a) / 255) as u8;
                p.data_mut()[k * 4..k * 4 + 4].copy_from_slice(&[pre(px[0]), pre(px[1]), pre(px[2]), px[3]]);
            }
        }
        let Some(png) = pm.and_then(|p| p.encode_png().ok()) else { break };
        all.push((png, (f.delay as u32 * 10).max(20)));
        match f.dispose {
            gif::DisposalMethod::Background => for y in 0..fh { for x in 0..fw { let (cx, cy) = (fl + x, ft + y); if cx < w && cy < h { let d = (cy * w + cx) * 4; canvas[d..d + 4].fill(0); } } },
            gif::DisposalMethod::Previous => { if let Some(b) = before { canvas = b; } }
            _ => {}
        }
        if all.len() > 400 { break; }
    }
    if all.len() <= max { return all; }
    // keep `max` frames, each lasting as long as the ones it stands for
    let step = all.len() as f32 / max as f32;
    (0..max).map(|n| {
        let (from, to) = ((n as f32 * step) as usize, (((n + 1) as f32 * step) as usize).min(all.len()));
        (all[from].0.clone(), all[from..to].iter().map(|f| f.1).sum())
    }).collect()
}
/// The quote with the animated profile picture moving: fewer frames when too big; None when it has one picture.
pub fn quote_animated(q: &Quote, avatar_gif: &[u8]) -> Option<Vec<u8>> {
    if let Some(l) = &q.look { return classic::quote_animated(q, l, avatar_gif); }
    let cap = caption(q);
    let mut last = None;
    for max in [GIF_FRAMES, GIF_FRAMES / 2, GIF_FRAMES / 4] {
        let frames = gif_frames(avatar_gif, max);
        if frames.len() < 2 { return None; }
        let mut out = Vec::new();
        let mut palette = None;
        for (n, (png_bytes, delay)) in frames.iter().enumerate() {
            let uri = pixel::frame_uri(png_bytes, q.pixel, &mut palette, TILE_GRID)?;
            let t = tile(q, Some(&uri), 1.0, 0.0, None);
            let (w, px) = if n == 0 { rgba(&svg(W, &format!("{t}{cap}")))? } else { rgba(&svg(TILE_W, &t))? };
            out.push((w, px, *delay));
        }
        let gif = encode(out)?;
        if gif.len() <= MAX_UPLOAD { return Some(gif); }
        last = Some(gif);
    }
    last
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wraps_and_fits_like_good_boy_3() {
        let m = |s: &str| s.chars().count() as f32 * 10.0;
        assert_eq!(wrap_text(&m, "one two three", 80.0), ["one two", "three"]);
        assert_eq!(wrap_text(&m, "abcdefghijkl", 50.0), ["abcde", "fghij", "kl"]);
        let (size, lines) = fit_text(&|sz, s| s.chars().count() as f32 * sz * 0.5, "short", 480.0, 380.0);
        assert_eq!((size, lines.len()), (54.0, 1));
        let (a, b, c) = motion_at(0.0);
        assert!((a - 1.0).abs() < 1e-6 && b.abs() < 1e-6 && c == Some(0.0));
        assert_eq!(motion_at(0.75).2, None);
    }
    #[test]
    fn draws_a_still_and_reads_an_animated_picture() {
        let q = Quote { text: "hi".into(), name: "Kai".into(), handle: "kai".into(), when: "Nov 12, 2026".into(), color: false, ..Default::default() };
        assert!(quote_png(&q, None).is_some_and(|p| p.starts_with(&[0x89, b'P', b'N', b'G'])));
        // a two-frame 2x2 GIF
        let mut gif = Vec::new();
        {
            let mut e = gif::Encoder::new(&mut gif, 2, 2, &[]).unwrap();
            for c in [[255u8, 0, 0, 255], [0, 0, 255, 255]] {
                let mut px: Vec<u8> = c.iter().copied().cycle().take(16).collect();
                let mut f = gif::Frame::from_rgba(2, 2, &mut px);
                f.delay = 5;
                e.write_frame(&f).unwrap();
            }
        }
        let frames = gif_frames(&gif, 60);
        assert_eq!(frames.iter().map(|f| f.1).collect::<Vec<_>>(), [50, 50]);
    }
    #[test]
    fn cleans_text_and_cuts_it_into_runs() {
        assert_eq!(clean("hi <:wave:123456789012345678> there <a:spin:42> <@5>"), "hi :wave: there :spin: <@5>");
        assert_eq!(clean("a\u{200b}b\u{202e}c"), "abc");
        let r = runs("VT323", "hello ✨ there");
        assert_eq!(r.iter().map(|(ok, t)| (*ok, t.as_str())).collect::<Vec<_>>(), [(true, "hello "), (false, "✨ "), (true, "there")], "{r:?}");
        assert!(runs("VT323", "plain words").iter().all(|r| r.0));
    }
    #[test]
    fn every_look_draws_and_colours_are_checked() {
        for (id, _) in LOOKS.iter().filter(|(id, _)| *id != "pixel") {
            let q = Quote { text: "Hello there ✨ Привет".into(), name: "Kai".into(), handle: "kai".into(), when: "Nov 12, 2026".into(), look: preset_look(id), ..Default::default() };
            assert!(quote_png(&q, None).is_some_and(|p| p.starts_with(&[0x89, b'P', b'N', b'G'])), "{id}");
        }
        assert!(preset_look("pixel").is_none() && preset_look("nope").is_none());
        assert!(make_look("#102030", "#ffffff", "#ff0000", Font::Mono).is_some());
        assert!(make_look("red", "#ffffff", "#ff0000", Font::Sans).is_none() && make_look("#12345", "#ffffff", "#ff0000", Font::Sans).is_none());
    }
    #[test]
    fn what_the_pixel_font_lacks_still_has_a_width_and_is_drawn() {
        let plain = measure(40.0, "abc");
        assert!(plain > 30.0 && plain < 90.0, "{plain}");
        assert!(measure(40.0, "ありがとう") > measure(40.0, "あ"));
        assert!(fallback_width(40.0, "✨") > 0.0);
        let q = Quote { text: "Привет 𝓚𝓪𝓲 ✨ ありがとう".into(), name: "𝓚𝓪𝓲 ✦".into(), handle: "kai".into(), when: "Nov 12, 2026".into(), pixel: true, ..Default::default() };
        assert!(quote_png(&q, None).is_some());
    }
}

