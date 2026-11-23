//! The classic image quote (Good Boy 3's look), in any colours:  the speaker's picture on the left (black and white unless asked for colour), fading into
//! black, and their words on the right with their name, handle and the date. A still PNG, a "motion" GIF (the picture
//! slowly zooms and a soft light sweeps across it), or, for an animated profile picture, a GIF of it moving. Only the
//! left tile changes between frames, so every frame after the first is just that tile (a much smaller file).

use crate::quote::{Look, Quote};
use crate::{data_uri, esc, fonts, png};

const W: u32 = 1200;
const H: u32 = 630;
const TILE_W: u32 = 643; // ceil(H * 1.02): the part the picture can touch; the words start further right
use crate::quote::MAX_UPLOAD;
const MOTION_FRAMES: usize = 28;
const MOTION_LOOP_MS: u32 = 2800;
const GIF_FRAMES: usize = 60;

/// How wide text is in the quote's font (the computer's Segoe UI or Helvetica when it has one, else Figtree).
fn measure(l: &Look, size: f32, italic: bool, bold: bool, text: &str) -> f32 {
    use resvg::usvg::fontdb::{Family, Query, Stretch, Style, Weight};
    let db = fonts();
    let names = l.font.names();
    let families: Vec<Family> = names.iter().map(|n| Family::Name(n)).collect();
    let query = Query { families: &families, weight: if bold { Weight::BOLD } else { Weight::NORMAL }, stretch: Stretch::Normal, style: if italic { Style::Italic } else { Style::Normal } };
    let width = db.query(&query).and_then(|id| db.with_face_data(id, |data, index| {
        let face = ttf_parser::Face::parse(data, index).ok()?;
        let per = size / face.units_per_em() as f32;
        Some(text.chars().map(|c| face.glyph_index(c).and_then(|g| face.glyph_hor_advance(g)).map(|a| a as f32 * per).unwrap_or(size * 0.55)).sum::<f32>())
    }).flatten());
    width.unwrap_or(text.chars().count() as f32 * size * 0.55)
}
use crate::quote::fit_text;
fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}

/// The caption: the words (fitted), the name and the handle and date. The same for every frame.
fn caption(q: &Quote, l: &Look) -> String {
    let family = l.font.family();
    let (x, max_w, max_h) = (660.0f32, (W as f32) - 660.0 - 60.0, 380.0f32);
    let text = format!("“{}”", q.text);
    let (size, lines) = fit_text(&|sz, s| measure(l, sz, true, false, s), &text, max_w, max_h);
    let lh = size * 1.25;
    let top = 70.0 + (max_h - lines.len() as f32 * lh) / 2.0;
    let (txt, muted) = (&l.text, &l.muted);
    let mut s = String::new();
    for (n, line) in lines.iter().enumerate() {
        // canvas draws from the top of the line; SVG from the baseline (about 0.93 of the size below it)
        s.push_str(&format!(r##"<text x="{x}" y="{}" font-family="{family}" font-style="italic" font-size="{size}" fill="{}">{}</text>
"##, top + n as f32 * lh + size * 0.93, l.text, esc(line)));
    }
    s.push_str(&format!(r##"<text x="{x}" y="{}" font-family="{family}" font-weight="700" font-size="30" fill="{txt}">— {}</text>
<text x="{x}" y="{}" font-family="{family}" font-size="22" fill="{muted}">@{}  ·  {}</text>
"##, 490.0 + 28.0, esc(&short(&q.name, 28)), 534.0 + 20.5, esc(&short(&q.handle, 32)), esc(&q.when)));
    s
}
/// The left tile: the picture (or the initial), black and white unless colour, fading into black.
/// `zoom`/`drift` move the picture (motion quotes); `shine` is where the light band is (0..1), if anywhere.
fn tile(q: &Quote, l: &Look, picture: Option<&str>, zoom: f32, drift: f32, shine: Option<f32>) -> String {
    let h = H as f32;
    let mut s = r##"<defs><filter id="bw" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0.299 0.587 0.114 0 0 0.299 0.587 0.114 0 0 0.299 0.587 0.114 0 0 0 0 0 1 0"/></filter>
<linearGradient id="fade" gradientUnits="userSpaceOnUse" x1="283.5" y1="0" x2="642.6" y2="0"><stop offset="0" stop-color="{bg}" stop-opacity="0"/><stop offset="1" stop-color="{bg}" stop-opacity="1"/></linearGradient>
<clipPath id="sq"><rect width="630" height="630"/></clipPath><clipPath id="tile"><rect width="643" height="630"/></clipPath>
<linearGradient id="band" gradientUnits="objectBoundingBox" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
<rect width="643" height="630" fill="{bg}"/>
"##.replace("{bg}", &l.bg);
    let filter = if q.color { "" } else { r#" filter="url(#bw)""# };
    s.push_str(&format!(r#"<g clip-path="url(#sq)"{filter}>"#));
    match picture {
        Some(uri) => {
            let sz = h * zoom;
            s.push_str(&format!(r#"<image x="{}" y="{}" width="{sz}" height="{sz}" preserveAspectRatio="none" xlink:href="{uri}"/>"#, (h - sz) / 2.0 + drift * h, (h - sz) / 2.0));
        }
        None => {
            let initial: String = q.name.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_else(|| "?".into());
            s.push_str(&format!(r##"<rect width="630" height="630" fill="{}"/><text x="315" y="315" font-family="sans-serif" font-weight="700" font-size="260" fill="{}" text-anchor="middle" dominant-baseline="central">{}</text>"##, l.panel, l.accent, esc(&initial)));
        }
    }
    s.push_str("</g>\n<rect width=\"643\" height=\"630\" fill=\"url(#fade)\"/>\n");
    if let Some(p) = shine {
        let x = -h * 0.35 + p * (TILE_W as f32 + h * 0.7);
        s.push_str(&format!(r#"<g clip-path="url(#tile)"><rect x="{}" y="0" width="{}" height="630" fill="url(#band)" transform="matrix(1 0 -0.35 1 0 0)"/></g>
"#, x - 90.0, 180.0 + h * 0.4));
    }
    s
}
fn svg(width: u32, bg: &str, body: &str) -> String {
    format!(r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{width}" height="{H}" viewBox="0 0 {width} {H}"><rect width="{width}" height="{H}" fill="{bg}"/>{body}</svg>"##)
}
/// The still quote as a PNG.
pub fn quote_png(q: &Quote, l: &Look, avatar: Option<&[u8]>) -> Option<Vec<u8>> {
    let uri = avatar.and_then(data_uri);
    png(&svg(W, &l.bg, &format!("{}{}", tile(q, l, uri.as_deref(), 1.0, 0.0, None), caption(q, l))))
}
use crate::quote::{gif_frames, motion_at};
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
pub fn quote_motion(q: &Quote, l: &Look, avatar: Option<&[u8]>) -> Option<Vec<u8>> {
    let uri = avatar.and_then(data_uri);
    let cap = caption(q, l);
    let mut last = None;
    for count in [MOTION_FRAMES, MOTION_FRAMES / 2] {
        let delay = MOTION_LOOP_MS / count as u32;
        let mut frames = Vec::new();
        for n in 0..count {
            let (zoom, drift, shine) = motion_at(n as f32 / count as f32);
            let t = tile(q, l, uri.as_deref(), zoom, drift, shine);
            let (w, px) = if n == 0 { rgba(&svg(W, &l.bg, &format!("{t}{cap}")))? } else { rgba(&svg(TILE_W, &l.bg, &t))? };
            frames.push((w, px, delay));
        }
        let gif = encode(frames)?;
        if gif.len() <= MAX_UPLOAD { return Some(gif); }
        last = Some(gif);
    }
    last
}
/// The quote with the animated profile picture moving: fewer frames when too big; None when it has one picture.
pub fn quote_animated(q: &Quote, l: &Look, avatar_gif: &[u8]) -> Option<Vec<u8>> {
    let cap = caption(q, l);
    let mut last = None;
    for max in [GIF_FRAMES, GIF_FRAMES / 2, GIF_FRAMES / 4] {
        let frames = gif_frames(avatar_gif, max);
        if frames.len() < 2 { return None; }
        let mut out = Vec::new();
        for (n, (png_bytes, delay)) in frames.iter().enumerate() {
            let uri = data_uri(png_bytes)?;
            let t = tile(q, l, Some(&uri), 1.0, 0.0, None);
            let (w, px) = if n == 0 { rgba(&svg(W, &l.bg, &format!("{t}{cap}")))? } else { rgba(&svg(TILE_W, &l.bg, &t))? };
            out.push((w, px, *delay));
        }
        let gif = encode(out)?;
        if gif.len() <= MAX_UPLOAD { return Some(gif); }
        last = Some(gif);
    }
    last
}

