//! The fishing screens as pictures: the hub, bag, shop, rods, collection and challenges. One layout for all of them: the
//! place's own water scene across the top with the title and a few numbers, then a grid of tiles. Nothing here decides
//! anything about the game; the words and numbers come from the same data the text screens used.
use crate::arcade::Shot;
use crate::games::{fish_shape, gif, open, pill, scene, text, CELL, GOLD, PANEL, W};
use crate::png;

/// One tile in the grid.
#[derive(Clone, Default)]
pub struct Tile {
    pub title: String,
    pub sub: String,
    /// Right-hand text (a price, a weight).
    pub right: String,
    /// A colour stripe on the left (a rarity, or a state).
    pub accent: String,
    /// A progress bar, 0 to 1.
    pub bar: Option<f32>,
    /// A small label on the tile (a rarity, "OWNED", "LOCKED").
    pub tag: String,
    /// 0 stars means none are drawn.
    pub stars: u8,
    pub dim: bool,
}
pub struct Screen<'a> {
    pub biome: &'a str,
    pub place: &'a str,
    pub title: &'a str,
    pub subtitle: &'a str,
    /// Up to four (label, value) numbers across the top right.
    pub stats: Vec<(String, String)>,
    /// A bar under the header: (0 to 1, what it counts).
    pub meter: Option<(f32, String)>,
    pub tiles: Vec<Tile>,
    pub columns: usize,
    pub foot: String,
    /// What to show when there are no tiles.
    pub empty: &'a str,
}
const HEAD: f32 = 170.0;
const TILE_H: f32 = 72.0;
const GAP: f32 = 10.0;
fn trunc(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n.saturating_sub(1)).collect::<String>()) }
}
fn star(cx: f32, cy: f32, r: f32, fill: &str) -> String {
    let pts: Vec<String> = (0..10).map(|k| { let a = -std::f32::consts::FRAC_PI_2 + k as f32 * std::f32::consts::PI / 5.0; let rr = if k % 2 == 0 { r } else { r * 0.42 }; format!("{:.1},{:.1}", cx + rr * a.cos(), cy + rr * a.sin()) }).collect();
    format!(r##"<polygon points="{}" fill="{fill}"/>"##, pts.join(" "))
}
fn svg(s: &Screen, phase: f32) -> String {
    let cols = s.columns.clamp(1, 2);
    let rows = if s.tiles.is_empty() { 1 } else { s.tiles.len().div_ceil(cols) };
    let meter_h = if s.meter.is_some() { 46.0 } else { 0.0 };
    let top = HEAD + meter_h + 14.0;
    let h = top + rows as f32 * (TILE_H + GAP) + 34.0;
    let mut out = open(h);
    out += &format!(r#"<rect width="{W}" height="{h}" rx="18" fill="{PANEL}"/>"#);
    out += &scene(s.biome, s.place, HEAD, phase);
    // a darker band at the bottom of the scene so the title reads on any water
    out += &format!(r##"<defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.62"/></linearGradient></defs><rect y="{}" width="{W}" height="{}" fill="url(#shade)"/>"##, HEAD - 90.0, 90.0);
    out += &text(22.0, HEAD - 44.0, 34.0, "#ffffff", "start", "Display 800", &trunc(s.title, 26));
    out += &text(22.0, HEAD - 16.0, 17.0, "#e8eefc", "start", "Figtree 600", &trunc(s.subtitle, 58));
    for (k, (label, value)) in s.stats.iter().take(4).enumerate() {
        let y = 18.0 + k as f32 * 36.0;
        let w = (label.chars().count() + value.chars().count()) as f32 * 9.2 + 40.0;
        out += &format!(r##"<rect x="{}" y="{y}" width="{w}" height="30" rx="8" fill="#000000" fill-opacity="0.5"/>"##, W - 16.0 - w);
        out += &text(W - 16.0 - w + 12.0, y + 21.0, 15.0, "#cdd6ec", "start", "Figtree 600", label);
        out += &text(W - 28.0, y + 21.0, 16.0, "#ffffff", "end", "Figtree 700", value);
    }
    if let Some((part, label)) = &s.meter {
        let y = HEAD + 12.0;
        out += &format!(r##"<rect x="20" y="{y}" width="{}" height="16" rx="8" fill="#101114"/><rect x="20" y="{y}" width="{}" height="16" rx="8" fill="{GOLD}"/>"##, W - 40.0, ((W - 40.0) * part.clamp(0.0, 1.0)).max(if *part > 0.0 { 12.0 } else { 0.0 }));
        out += &text(20.0, y + 36.0, 15.0, "#b7bdcb", "start", "Figtree 600", &trunc(label, 70));
    }
    if s.tiles.is_empty() {
        out += &fish_shape(W / 2.0 - 10.0, top + 28.0, 56.0, "#3a3d46");
        out += &text(W / 2.0, top + 70.0, 18.0, "#9aa1b2", "middle", "Figtree 600", s.empty);
    }
    let tw = (W - 40.0 - GAP * (cols as f32 - 1.0)) / cols as f32;
    for (k, t) in s.tiles.iter().enumerate() {
        let (c, r) = (k % cols, k / cols);
        let x = 20.0 + c as f32 * (tw + GAP);
        let y = top + r as f32 * (TILE_H + GAP);
        let op = if t.dim { "0.5" } else { "1" };
        let accent = if t.accent.is_empty() { "#4a4e5a" } else { &t.accent };
        out += &format!(r##"<g opacity="{op}"><rect x="{x}" y="{y}" width="{tw}" height="{TILE_H}" rx="12" fill="{CELL}"/><rect x="{x}" y="{y}" width="7" height="{TILE_H}" rx="3" fill="{accent}"/>"##);
        let right_w = t.right.chars().count() as f32 * 10.0 + 8.0;
        let name_room = ((tw - 34.0 - right_w) / 9.6) as usize;
        out += &text(x + 20.0, y + 28.0, 18.0, "#ffffff", "start", "Figtree 700", &trunc(&t.title, name_room.max(8)));
        if !t.right.is_empty() { out += &text(x + tw - 14.0, y + 28.0, 17.0, GOLD, "end", "Figtree 700", &t.right); }
        let mut sx = x + 20.0;
        if t.stars > 0 { for k in 0..5u8 { out += &star(sx + 7.0 + k as f32 * 17.0, y + 49.0, 7.5, if k < t.stars { GOLD } else { "#3d414c" }); } sx += 92.0; }
        if !t.tag.is_empty() {
            let w = t.tag.chars().count() as f32 * 8.6 + 16.0;
            out += &format!(r##"<rect x="{sx}" y="{}" width="{w}" height="22" rx="6" fill="{accent}" fill-opacity="0.95"/>"##, y + 38.0);
            out += &text(sx + w / 2.0, y + 54.0, 13.0, "#ffffff", "middle", "Figtree 700", &t.tag);
            sx += w + 8.0;
        }
        out += &text(sx, y + 54.0, 14.0, "#aab1c2", "start", "Figtree 600", &trunc(&t.sub, (((x + tw - 14.0 - sx) / 7.8) as usize).max(6)));
        if let Some(b) = t.bar {
            out += &format!(r##"<rect x="{}" y="{}" width="{}" height="7" rx="3.5" fill="#101114"/><rect x="{}" y="{}" width="{}" height="7" rx="3.5" fill="{accent}"/>"##, x + 20.0, y + TILE_H - 11.0, tw - 40.0, x + 20.0, y + TILE_H - 11.0, ((tw - 40.0) * b.clamp(0.0, 1.0)).max(if b > 0.0 { 6.0 } else { 0.0 }));
        }
        out += "</g>";
    }
    if !s.foot.is_empty() { out += &text(W / 2.0, h - 12.0, 14.0, "#8b92a4", "middle", "Figtree 600", &trunc(&s.foot, 90)); }
    let _ = pill;
    out + "</svg>"
}
/// A still picture, or the same with the water drifting on a loop.
pub fn screen(s: &Screen, moving: bool) -> Shot {
    if moving {
        let frames: Vec<(String, u16)> = (0..8).map(|k| (svg(s, k as f32 / 8.0), 14)).collect();
        return gif(&frames, true).map(|b| (b, true));
    }
    png(&svg(s, 0.0)).map(|b| (b, false))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_fishing_screen_draws() {
        let t = |n: &str| Tile { title: n.into(), sub: "Rare · 2.4 kg".into(), right: "1,240".into(), accent: "#4aa3ff".into(), bar: Some(0.5), tag: "RARE".into(), stars: 3, dim: false };
        let s = Screen { biome: "reef", place: "Coral Reef", title: "Your bag", subtitle: "12 fish worth 4,500 coins", stats: vec![("Fish".into(), "12".into()), ("Worth".into(), "4,500".into())], meter: Some((0.4, "40/100 XP".into())), tiles: vec![t("Moonlit Carp"), t("A very long fish name that must be cut short somewhere"), t("Third")], columns: 2, foot: "showing the 10 most valuable".into(), empty: "Empty." };
        assert!(!screen(&s, false).unwrap().1 && screen(&s, true).unwrap().1);
        let empty = Screen { tiles: vec![], ..s };
        assert!(screen(&empty, false).is_some());
    }
}
