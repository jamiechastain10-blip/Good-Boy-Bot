//! Pixel pictures: a profile picture or a photo shrunk to a small grid, held to a few colours with a light dither, and
//! drawn back up with hard edges. Every picture the bot draws goes through here, so they all look like they belong to
//! the same 8-bit game. The colours are picked from the picture itself, so people stay recognisable.

use crate::{data_uri, esc};

/// Colours a pixel picture is held to.
pub const COLORS: usize = 16;
/// The grid a profile picture is shrunk to when a card does not say (it is drawn back up to whatever size it needs).
pub const GRID: u32 = 48;
/// Where a transparent picture shows through (the launcher's panel colour).
const BACKDROP: [u8; 3] = [0x22, 0x1d, 0x54];
const BAYER: [[i32; 4]; 4] = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

/// The colours of one picture. An animated picture keeps the palette of its first frame, so it does not shimmer.
#[derive(Debug, Clone, PartialEq)]
pub struct Palette(pub Vec<[u8; 3]>);

/// The picture as `gw` x `gh` RGB, cropped from the middle to that shape (a square for an avatar).
fn small(bytes: &[u8], gw: u32, gh: u32) -> Option<Vec<[u8; 3]>> {
    let uri = data_uri(bytes)?;
    // drawn at four times the grid and averaged down, so shrinking does not skip over thin lines
    let (bw, bh) = (gw * 4, gh * 4);
    let svg = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{bw}" height="{bh}" viewBox="0 0 {bw} {bh}"><rect width="{bw}" height="{bh}" fill="rgb({},{},{})"/><image x="0" y="0" width="{bw}" height="{bh}" preserveAspectRatio="xMidYMid slice" xlink:href="{}"/></svg>"#, BACKDROP[0], BACKDROP[1], BACKDROP[2], esc(&uri));
    let tree = resvg::usvg::Tree::from_str(&svg, &resvg::usvg::Options::default()).ok()?;
    let mut pm = resvg::tiny_skia::Pixmap::new(bw, bh)?;
    resvg::render(&tree, resvg::tiny_skia::Transform::default(), &mut pm.as_mut());
    let px = pm.data();
    let mut out = Vec::with_capacity((gw * gh) as usize);
    for gy in 0..gh {
        for gx in 0..gw {
            let mut sum = [0u32; 3];
            for dy in 0..4 {
                for dx in 0..4 {
                    let i = (((gy * 4 + dy) * bw + gx * 4 + dx) * 4) as usize;
                    // opaque by construction (the backdrop is under it), so premultiplied is the same as straight
                    sum[0] += px[i] as u32;
                    sum[1] += px[i + 1] as u32;
                    sum[2] += px[i + 2] as u32;
                }
            }
            out.push([(sum[0] / 16) as u8, (sum[1] / 16) as u8, (sum[2] / 16) as u8]);
        }
    }
    Some(out)
}

fn dist(a: [f32; 3], b: [u8; 3]) -> f32 {
    let (r, g, bl) = (a[0] - b[0] as f32, a[1] - b[1] as f32, a[2] - b[2] as f32);
    // the eye is most sensitive to green and least to blue
    2.0 * r * r + 4.0 * g * g + 3.0 * bl * bl
}

/// k-means on the picture's own colours. Deterministic: the starting colours are spread evenly through the picture
/// sorted by brightness, so the same picture always gets the same palette.
fn palette_of(px: &[[u8; 3]], k: usize) -> Palette {
    let mut order: Vec<usize> = (0..px.len()).collect();
    order.sort_by_key(|&i| (px[i][0] as u32 * 3 + px[i][1] as u32 * 6 + px[i][2] as u32, i));
    let mut cent: Vec<[f32; 3]> = (0..k).map(|n| {
        let p = px[order[(n * 2 + 1) * order.len() / (k * 2)]];
        [p[0] as f32, p[1] as f32, p[2] as f32]
    }).collect();
    for _ in 0..8 {
        let mut sum = vec![[0f32; 4]; k];
        for p in px {
            let b = nearest(&cent, [p[0] as f32, p[1] as f32, p[2] as f32]);
            sum[b][0] += p[0] as f32;
            sum[b][1] += p[1] as f32;
            sum[b][2] += p[2] as f32;
            sum[b][3] += 1.0;
        }
        for (c, s) in cent.iter_mut().zip(&sum) {
            if s[3] > 0.0 { *c = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; }
        }
    }
    let mut out: Vec<[u8; 3]> = cent.iter().map(|c| [c[0].round() as u8, c[1].round() as u8, c[2].round() as u8]).collect();
    out.dedup();
    Palette(out)
}
fn nearest(cent: &[[f32; 3]], p: [f32; 3]) -> usize {
    let mut best = (0, f32::MAX);
    for (i, c) in cent.iter().enumerate() {
        let d = 2.0 * (c[0] - p[0]).powi(2) + 4.0 * (c[1] - p[1]).powi(2) + 3.0 * (c[2] - p[2]).powi(2);
        if d < best.1 { best = (i, d); }
    }
    best.0
}

/// Paints the grid with the palette, with an ordered dither (it depends only on where a pixel is, so animated
/// pictures stay steady between frames).
fn paint(px: &[[u8; 3]], width: u32, pal: &Palette) -> Vec<u8> {
    let mut out = Vec::with_capacity(px.len() * 4);
    for (n, p) in px.iter().enumerate() {
        let (x, y) = ((n as u32 % width) as usize, (n as u32 / width) as usize);
        let t = (BAYER[y % 4][x % 4] - 8) as f32 * 2.0;
        let want = [p[0] as f32 + t, p[1] as f32 + t, p[2] as f32 + t];
        let mut best = (pal.0[0], f32::MAX);
        for c in &pal.0 {
            let d = dist(want, *c);
            if d < best.1 { best = (*c, d); }
        }
        out.extend_from_slice(&[best.0[0], best.0[1], best.0[2], 255]);
    }
    out
}

fn encode(rgba: Vec<u8>, w: u32, h: u32) -> Option<Vec<u8>> {
    // tiny-skia keeps colours premultiplied; these are opaque, so they are the same
    let mut pm = resvg::tiny_skia::Pixmap::new(w, h)?;
    pm.data_mut().copy_from_slice(&rgba);
    pm.encode_png().ok()
}

/// The picture as a small PNG, plus the palette it used (pass it back in for the next frame of an animation).
pub fn picture(bytes: &[u8], grid: u32, palette: Option<&Palette>) -> Option<(Vec<u8>, Palette)> {
    rect(bytes, grid, grid, palette)
}
/// The same for a picture that is not square (a photo in a quote).
pub fn rect(bytes: &[u8], gw: u32, gh: u32, palette: Option<&Palette>) -> Option<(Vec<u8>, Palette)> {
    let px = small(bytes, gw.clamp(1, 512), gh.clamp(1, 512))?;
    let pal = match palette { Some(p) if !p.0.is_empty() => p.clone(), _ => palette_of(&px, COLORS) };
    Some((encode(paint(&px, gw, &pal), gw, gh)?, pal))
}

/// What goes in an SVG `href`: the pixel picture (drawn up with hard edges by the `image-rendering` attribute on the
/// image), or the original picture when `pixel` is off.
pub fn uri(bytes: &[u8], pixel: bool) -> Option<String> {
    uri_at(bytes, pixel, GRID)
}
/// The same, on a grid of your choosing (a small picture wants a coarser grid to stay blocky).
pub fn uri_at(bytes: &[u8], pixel: bool, grid: u32) -> Option<String> {
    if !pixel { return data_uri(bytes); }
    data_uri(&picture(bytes, grid, None)?.0)
}
/// A photo as a pixel picture on a `gw` x `gh` grid.
pub fn uri_rect(bytes: &[u8], pixel: bool, gw: u32, gh: u32) -> Option<String> {
    if !pixel { return data_uri(bytes); }
    data_uri(&rect(bytes, gw, gh, None)?.0)
}
/// Like `uri`, but keeping the palette between frames of an animated picture.
pub fn frame_uri(bytes: &[u8], pixel: bool, palette: &mut Option<Palette>, grid: u32) -> Option<String> {
    if !pixel { return data_uri(bytes); }
    let (png, pal) = picture(bytes, grid, palette.as_ref())?;
    palette.get_or_insert(pal);
    data_uri(&png)
}
/// ` image-rendering="optimizeSpeed"` when the picture is pixel art (it makes the renderer enlarge it without smoothing).
pub fn attr(pixel: bool) -> &'static str {
    if pixel { r#" image-rendering="optimizeSpeed""# } else { "" }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 64x64 PNG with a smooth red-to-blue gradient.
    fn gradient() -> Vec<u8> {
        let mut pm = resvg::tiny_skia::Pixmap::new(64, 64).unwrap();
        for y in 0..64u32 {
            for x in 0..64u32 {
                let i = ((y * 64 + x) * 4) as usize;
                pm.data_mut()[i..i + 4].copy_from_slice(&[(x * 4) as u8, (y * 2) as u8, (255 - x * 4) as u8, 255]);
            }
        }
        pm.encode_png().unwrap()
    }

    #[test]
    fn a_picture_is_held_to_a_few_colours_and_the_same_every_time() {
        let g = gradient();
        let (a, pal) = picture(&g, 32, None).unwrap();
        let (b, _) = picture(&g, 32, None).unwrap();
        assert_eq!(a, b, "the same picture gives the same pixels");
        assert!(pal.0.len() <= COLORS && pal.0.len() >= 4);
        // decode it again and count the colours
        let tree = resvg::usvg::Tree::from_str(&format!(r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="32" height="32"><image width="32" height="32" xlink:href="{}"/></svg>"#, data_uri(&a).unwrap()), &resvg::usvg::Options::default()).unwrap();
        let mut pm = resvg::tiny_skia::Pixmap::new(32, 32).unwrap();
        resvg::render(&tree, resvg::tiny_skia::Transform::default(), &mut pm.as_mut());
        let mut seen: Vec<[u8; 3]> = pm.data().chunks(4).map(|p| [p[0], p[1], p[2]]).collect();
        seen.sort_unstable();
        seen.dedup();
        assert!(seen.len() <= COLORS, "{} colours", seen.len());
    }

    #[test]
    fn an_animation_keeps_one_palette() {
        let g = gradient();
        let mut pal = None;
        let first = frame_uri(&g, true, &mut pal, 32).unwrap();
        let kept = pal.clone();
        let second = frame_uri(&g, true, &mut pal, 32).unwrap();
        assert_eq!(pal, kept);
        assert_eq!(first, second);
    }

    #[test]
    fn pixel_off_leaves_the_picture_alone_and_a_broken_one_is_refused() {
        let g = gradient();
        assert_eq!(uri(&g, false), data_uri(&g));
        assert!(uri(b"not a picture", true).is_none());
        assert_eq!(attr(true), r#" image-rendering="optimizeSpeed""#);
        assert_eq!(attr(false), "");
    }
}
