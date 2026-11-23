//! The games' pictures: the slot machine's window, the blackjack table, the coin, and the fishing scene with its
//! fight bar and gauges. Everything is drawn from shapes (no emoji fonts needed), so it looks the same on every
//! computer. Each function gives a PNG, or None if drawing fails (the game then shows its text version).

use crate::{esc, png};

pub(crate) const W: f32 = 640.0;
pub(crate) const PANEL: &str = "#1a1b1e";
pub(crate) const CELL: &str = "#232428";
pub(crate) const GOLD: &str = "#ffb12e";

pub(crate) fn open(h: f32) -> String {
    format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{h}" viewBox="0 0 {W} {h}">"#)
}
pub(crate) fn text(x: f32, y: f32, size: f32, fill: &str, anchor: &str, weight: &str, s: &str) -> String {
    format!(r#"<text x="{x}" y="{y}" font-family="'GB {weight}', sans-serif" font-size="{size}" fill="{fill}" text-anchor="{anchor}">{}</text>"#, esc(s))
}

/// Frames (a picture as SVG, how long it shows in hundredths of a second) as one animated GIF. `repeat`: play on a
/// loop; otherwise it plays once and rests on the last frame.
pub(crate) fn gif(frames: &[(String, u16)], repeat: bool) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let (w, h, _) = crate::rgba(&frames.first()?.0)?;
        let mut enc = ::gif::Encoder::new(&mut out, w as u16, h as u16, &[]).ok()?;
        if repeat { enc.set_repeat(::gif::Repeat::Infinite).ok()?; }
        for (svg, delay) in frames {
            let (fw, fh, mut px) = crate::rgba(svg)?;
            let mut f = ::gif::Frame::from_rgba_speed(fw as u16, fh as u16, &mut px, 20);
            f.delay = *delay;
            enc.write_frame(&f).ok()?;
        }
    }
    Some(out)
}
/// A small repeatable "random" number for decoration (which symbols blur past on a spinning reel).
fn noise(a: u32, b: u32) -> u32 {
    let mut x = a.wrapping_mul(0x9e37_79b1) ^ b.wrapping_mul(0x85eb_ca6b);
    x ^= x >> 15;
    x = x.wrapping_mul(0x2c1b_3c6d);
    x ^ (x >> 12)
}

// ------------------------------------------------------------------ slots
/// One slot symbol drawn in a 100 by 100 box centred on (cx, cy), scaled.
fn symbol(id: &str, cx: f32, cy: f32, scale: f32) -> String {
    let body = match id {
        "cherry" => r##"<path d="M50 18 Q40 40 30 58 M50 18 Q62 38 68 56" stroke="#3fa34d" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M50 18 q14 -8 24 0 q-12 8 -24 0z" fill="#3fa34d"/><circle cx="30" cy="66" r="17" fill="#e0263c"/><circle cx="68" cy="64" r="17" fill="#c81e33"/><circle cx="24" cy="60" r="5" fill="#ff8a98"/><circle cx="62" cy="58" r="5" fill="#ff8a98"/>"##.to_string(),
        "lemon" => r##"<ellipse cx="50" cy="52" rx="34" ry="25" fill="#ffd93b" transform="rotate(-20 50 52)"/><ellipse cx="40" cy="44" rx="12" ry="6" fill="#fff3a0" transform="rotate(-20 40 44)"/><circle cx="82" cy="40" r="5" fill="#e8b800"/><circle cx="18" cy="64" r="5" fill="#e8b800"/>"##.to_string(),
        "grape" => {
            let mut s = String::from(r##"<path d="M50 14 v14" stroke="#6b4a2a" stroke-width="5" stroke-linecap="round"/><path d="M50 20 q16 -12 26 -2 q-14 8 -26 2z" fill="#3fa34d"/>"##);
            for (x, y) in [(34, 40), (50, 40), (66, 40), (42, 54), (58, 54), (50, 68), (34, 54), (66, 54), (42, 68), (58, 68), (50, 82)] {
                s += &format!(r##"<circle cx="{x}" cy="{y}" r="9.5" fill="#8e44ad"/><circle cx="{}" cy="{}" r="3" fill="#c39bd3"/>"##, x - 3, y - 3);
            }
            s
        }
        "bell" => r##"<path d="M50 16 c-20 0 -26 18 -26 34 c0 12 -6 16 -10 22 h72 c-4 -6 -10 -10 -10 -22 c0 -16 -6 -34 -26 -34z" fill="#f5b301"/><path d="M34 34 c2 -8 8 -12 14 -13" stroke="#ffe08a" stroke-width="5" fill="none" stroke-linecap="round"/><rect x="12" y="70" width="76" height="8" rx="4" fill="#d99a00"/><circle cx="50" cy="84" r="7" fill="#d99a00"/>"##.to_string(),
        "star" => r##"<polygon points="50,10 61,38 91,39 67,58 76,87 50,70 24,87 33,58 9,39 39,38" fill="#ffd93b" stroke="#e8a700" stroke-width="3" stroke-linejoin="round"/><polygon points="50,24 56,40 44,40" fill="#fff3a0"/>"##.to_string(),
        "diamond" => r##"<polygon points="50,90 10,40 28,16 72,16 90,40" fill="#43c6f0"/><polygon points="10,40 90,40 50,90" fill="#1f9fd0"/><polygon points="28,16 40,40 10,40" fill="#8fe2ff"/><polygon points="72,16 60,40 90,40" fill="#6fd4f7"/><polygon points="40,40 60,40 50,90" fill="#2fb0de"/><polygon points="28,16 72,16 60,40 40,40" fill="#c7f1ff"/>"##.to_string(),
        "seven" => r##"<text x="50" y="84" font-family="'GB Display 800', sans-serif" font-size="92" fill="#e0263c" stroke="#ffd93b" stroke-width="3" text-anchor="middle">7</text>"##.to_string(),
        _ => r##"<rect x="18" y="8" width="64" height="84" rx="9" fill="#7c4dff" stroke="#ffd93b" stroke-width="4"/><text x="50" y="50" font-family="'GB Display 800', sans-serif" font-size="20" fill="#ffffff" text-anchor="middle">WILD</text><polygon points="50,56 55,68 68,68 58,76 62,88 50,81 38,88 42,76 32,68 45,68" fill="#ffd93b"/>"##.to_string(),
    };
    format!(r#"<g transform="translate({} {}) scale({scale})">{body}</g>"#, cx - 50.0 * scale, cy - 50.0 * scale)
}
const SYMBOL_IDS: [&str; 8] = ["cherry", "lemon", "grape", "bell", "star", "diamond", "seven", "wild"];
/// The window with the first `stopped` reels showing their result and the rest blurring past (`frame` moves them).
fn slots_svg(window: &[[&str; 3]; 3], banner: Option<&str>, win: bool, stopped: usize, frame: u32) -> String {
    let h = 420.0;
    let mut s = open(h);
    s += &format!(r#"<rect width="{W}" height="{h}" rx="22" fill="{PANEL}"/>"#);
    let (cw, ch, gap, left, top) = (184.0, 100.0, 14.0, 30.0, 24.0);
    for (r, reel) in window.iter().enumerate() {
        let spinning = r >= stopped;
        for (k, sym) in reel.iter().enumerate() {
            let (x, y) = (left + r as f32 * (cw + gap), top + k as f32 * (ch + gap));
            let mid = k == 1;
            s += &format!(r#"<rect x="{x}" y="{y}" width="{cw}" height="{ch}" rx="14" fill="{}"{}/>"#, if mid { "#2f3138" } else { CELL }, if mid { format!(r#" stroke="{GOLD}" stroke-opacity="0.55" stroke-width="3""#) } else { String::new() });
            if spinning {
                let pick = SYMBOL_IDS[(noise(frame * 7 + r as u32, k as u32 + 3) % 8) as usize];
                let dy = (noise(frame, r as u32 * 5 + k as u32) % 30) as f32 - 15.0;
                s += &format!(r##"<g opacity="0.55">{}</g><rect x="{}" y="{}" width="{}" height="{}" rx="10" fill="#ffffff" opacity="0.06"/>"##, symbol(pick, x + cw / 2.0, y + ch / 2.0 + dy, 0.74), x + 30.0, y + 8.0, cw - 60.0, ch - 16.0);
            } else {
                s += &symbol(sym, x + cw / 2.0, y + ch / 2.0, if mid { 0.92 } else { 0.78 });
            }
        }
    }
    let y = top + ch + gap + ch / 2.0;
    s += &format!(r#"<rect x="14" y="{}" width="{}" height="4" rx="2" fill="{GOLD}" opacity="0.6"/>"#, y - 2.0, W - 28.0);
    s += &format!(r#"<polygon points="6,{0} 22,{1} 22,{2}" fill="{GOLD}"/><polygon points="{3},{0} {4},{1} {4},{2}" fill="{GOLD}"/>"#, y, y - 10.0, y + 10.0, W - 6.0, W - 22.0);
    let shown = banner.is_some();
    s += &format!(r#"<rect x="30" y="366" width="{}" height="40" rx="12" fill="{}"/>"#, W - 60.0, if win && shown { "#2f6b3f" } else { "#2b2d31" });
    s += &text(W / 2.0, 393.0, 22.0, if win && shown { "#eaffef" } else { "#b5bac1" }, "middle", "Figtree 700", banner.unwrap_or("Spinning…"));
    s += "</svg>";
    s
}
/// The slot machine's 3 by 3 window (reel by reel: top, middle, bottom) with the middle line marked, and a banner.
pub fn slots(window: &[[&str; 3]; 3], banner: &str, win: bool) -> Option<Vec<u8>> {
    png(&slots_svg(window, Some(banner), win, 3, 0))
}
/// The same window as a short film: the reels spin, stop one by one, then the banner shows. It plays once.
pub fn slots_spin(window: &[[&str; 3]; 3], banner: &str, win: bool) -> Option<Vec<u8>> {
    let mut frames = Vec::new();
    for f in 0..5 { frames.push((slots_svg(window, None, win, 0, f), 7)); }
    for f in 5..8 { frames.push((slots_svg(window, None, win, 1, f), 8)); }
    for f in 8..11 { frames.push((slots_svg(window, None, win, 2, f), 9)); }
    frames.push((slots_svg(window, None, win, 3, 0), 25));
    frames.push((slots_svg(window, Some(banner), win, 3, 0), 10));
    gif(&frames, false)
}

// ------------------------------------------------------------------ cards
fn suit_shape(suit: char, cx: f32, cy: f32, size: f32, color: &str) -> String {
    let d = match suit {
        '♥' => "M50 88 C20 62 8 46 8 30 C8 16 19 8 30 8 C40 8 47 14 50 22 C53 14 60 8 70 8 C81 8 92 16 92 30 C92 46 80 62 50 88Z",
        '♦' => "M50 6 L88 50 L50 94 L12 50Z",
        '♣' => "M50 8 a20 20 0 0 1 17 31 a20 20 0 1 1 -9 33 q2 12 10 20 h-36 q8 -8 10 -20 a20 20 0 1 1 -9 -33 a20 20 0 0 1 17 -31z",
        _ => "M50 6 C60 26 92 40 92 62 C92 76 81 84 70 84 C63 84 58 81 55 76 Q57 88 66 94 H34 Q43 88 45 76 C42 81 37 84 30 84 C19 84 8 76 8 62 C8 40 40 26 50 6Z",
    };
    let k = size / 100.0;
    format!(r#"<path d="{d}" fill="{color}" transform="translate({} {}) scale({k})"/>"#, cx - size / 2.0, cy - size / 2.0)
}
/// One playing card ("10♥") with its top-left corner at (x, y). `back`: face down.
fn playing_card(card: &str, x: f32, y: f32, back: bool) -> String {
    let (w, h) = (84.0, 118.0);
    if back {
        return format!(r##"<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="9" fill="#5865f2" stroke="#ffffff" stroke-width="4"/><rect x="{}" y="{}" width="{}" height="{}" rx="5" fill="none" stroke="#aab1ff" stroke-width="2" stroke-dasharray="6 5"/>"##, x + 10.0, y + 10.0, w - 20.0, h - 20.0);
    }
    let suit = card.chars().last().unwrap_or('♠');
    let rank: String = card.chars().take(card.chars().count().saturating_sub(1)).collect();
    let color = if suit == '♥' || suit == '♦' { "#d32f3a" } else { "#1b1d27" };
    format!(r##"<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="9" fill="#ffffff"/>{}{}{}"##,
        text(x + 10.0, y + 34.0, 30.0, color, "start", "Display 800", &rank),
        suit_shape(suit, x + w / 2.0, y + 74.0, 46.0, color),
        suit_shape(suit, x + w - 18.0, y + 20.0, 18.0, color))
}
/// A hand on the table: its label, its cards, and a result line under it.
pub struct TableHand<'a> {
    pub label: String,
    pub cards: &'a [String],
    pub result: Option<String>,
    pub active: bool,
}
/// How many cards are on the table yet, while they are being dealt or turned over: (dealer's, first hand's).
type Shown = Option<(usize, usize)>;
fn blackjack_svg(dealer_label: &str, dealer: &[String], hide: bool, hands: &[TableHand], footer: &str, shown: Shown, results: bool) -> String {
    let h = 430.0;
    let mut s = open(h);
    s += &format!(r##"<defs><radialGradient id="felt" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#1f7a4d"/><stop offset="1" stop-color="#0f4a2e"/></radialGradient></defs><rect width="{W}" height="{h}" rx="22" fill="url(#felt)"/><rect x="10" y="10" width="{}" height="{}" rx="16" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="2"/>"##, W - 20.0, h - 20.0);
    let row = |cards: &[String], y: f32, x0: f32, room: f32, hide_second: bool, most: usize| -> String {
        let step = if cards.len() > 1 { ((room - 84.0) / (cards.len() as f32 - 1.0)).min(94.0) } else { 0.0 };
        cards.iter().enumerate().take(most).map(|(k, c)| playing_card(c, x0 + k as f32 * step, y, hide_second && k == 1)).collect()
    };
    s += &text(34.0, 46.0, 22.0, "#eaffef", "start", "Figtree 700", dealer_label);
    s += &row(dealer, 58.0, 34.0, W - 68.0, hide, shown.map(|x| x.0).unwrap_or(usize::MAX));
    let n = hands.len().max(1) as f32;
    let room = (W - 68.0 - (n - 1.0) * 24.0) / n;
    for (k, hand) in hands.iter().enumerate() {
        let x = 34.0 + k as f32 * (room + 24.0);
        if hand.active && hands.len() > 1 { s += &format!(r##"<rect x="{}" y="204" width="{}" height="186" rx="12" fill="#ffffff" fill-opacity="0.08" stroke="{GOLD}" stroke-width="2"/>"##, x - 10.0, room + 20.0); }
        s += &text(x, 232.0, 22.0, "#eaffef", "start", "Figtree 700", &hand.label);
        s += &row(hand.cards, 244.0, x, room, false, if k == 0 { shown.map(|x| x.1).unwrap_or(usize::MAX) } else { usize::MAX });
        if results { if let Some(r) = &hand.result { s += &text(x, 386.0, 18.0, "#ffe9a8", "start", "Figtree 700", r); } }
    }
    s += &text(W / 2.0, h - 14.0, 17.0, "#cfe9d9", "middle", "Figtree 600", footer);
    s += "</svg>";
    s
}
/// The blackjack table: the dealer on top (second card face down while `hide`), the player's hand or hands below.
pub fn blackjack(dealer_label: &str, dealer: &[String], hide: bool, hands: &[TableHand], footer: &str) -> Option<Vec<u8>> {
    png(&blackjack_svg(dealer_label, dealer, hide, hands, footer, None, true))
}
/// The table as a short film that plays once. `deal`: the first four cards land one by one. Otherwise the dealer's
/// hidden card turns over and the dealer's other cards come out one by one, then the results show.
pub fn blackjack_film(dealer_label: &str, hidden_label: &str, dealer: &[String], hide: bool, hands: &[TableHand], footer: &str, deal: bool) -> Option<Vec<u8>> {
    let mut frames = Vec::new();
    if deal {
        for (d, p) in [(0, 1), (1, 1), (1, 2), (2, 2)] { frames.push((blackjack_svg(hidden_label, dealer, true, hands, footer, Some((d, p)), false), 22)); }
        frames.push((blackjack_svg(dealer_label, dealer, hide, hands, footer, None, true), 10));
    } else {
        frames.push((blackjack_svg(hidden_label, dealer, true, hands, footer, Some((2, usize::MAX)), false), 35));
        for d in 2..=dealer.len() { frames.push((blackjack_svg(if d == dealer.len() { dealer_label } else { hidden_label }, dealer, false, hands, footer, Some((d, usize::MAX)), false), 40)); }
        frames.push((blackjack_svg(dealer_label, dealer, false, hands, footer, None, true), 10));
    }
    gif(&frames, false)
}

// ------------------------------------------------------------------ coin
/// The coin, `turn` of the way round (1 = flat on, 0 = edge on), lifted off the ground by `lift`.
fn coin_svg(heads: bool, turn: f32, lift: f32, line: Option<(&str, bool)>) -> String {
    let h = 250.0;
    let mut s = open(h);
    s += &format!(r##"<defs><radialGradient id="c" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#ffe9a0"/><stop offset="1" stop-color="#d9981a"/></radialGradient></defs><rect width="{W}" height="{h}" rx="22" fill="{PANEL}"/>"##);
    let cy = 104.0 - lift;
    let k = turn.abs().max(0.06);
    s += &format!(r##"<ellipse cx="320" cy="190" rx="{}" ry="10" fill="#000000" opacity="{}"/>"##, 70.0 - lift * 0.4, 0.35 - lift * 0.003);
    s += &format!(r##"<g transform="translate(320 {cy}) scale({k} 1)"><circle r="78" fill="url(#c)" stroke="#b97a0c" stroke-width="6"/><circle r="62" fill="none" stroke="#b97a0c" stroke-opacity="0.5" stroke-width="3"/>{}</g>"##, if k > 0.3 { text(0.0, 28.0, 78.0, "#7a5200", "middle", "Display 800", if heads { "H" } else { "T" }) } else { String::new() });
    if let Some((line, won)) = line { s += &text(320.0, 232.0, 22.0, if won { "#a8f0bf" } else { "#f2a0a6" }, "middle", "Figtree 700", line); }
    s += "</svg>";
    s
}
pub fn coin(heads: bool, won: bool, line: &str) -> Option<Vec<u8>> {
    png(&coin_svg(heads, 1.0, 0.0, Some((line, won))))
}
/// The coin tossed: it rises, turns over a few times, lands on its side, and the result shows. It plays once.
pub fn coin_flip(heads: bool, won: bool, line: &str) -> Option<Vec<u8>> {
    let mut frames = Vec::new();
    let n = 12;
    for k in 0..n {
        let t = k as f32 / n as f32;
        let angle = t * std::f32::consts::PI * 4.0;
        let turn = angle.cos();
        // the face showing swaps each half turn, and ends on the side it landed on
        let face = if turn >= 0.0 { heads } else { !heads };
        frames.push((coin_svg(face, turn, (t * std::f32::consts::PI).sin() * 22.0, None), 6));
    }
    frames.push((coin_svg(heads, 1.0, 0.0, None), 20));
    frames.push((coin_svg(heads, 1.0, 0.0, Some((line, won))), 10));
    gif(&frames, false)
}

// ------------------------------------------------------------------ fishing
/// Sky (top, bottom) and water (top, bottom) colours of a place.
fn scene_colors(biome: &str) -> (&'static str, &'static str, &'static str, &'static str) {
    match biome {
        "marsh" => ("#cfe3b0", "#9dbb7a", "#4a6b3a", "#2f4a2a"),
        "glacier" => ("#dff3ff", "#b5dcf5", "#5aa6c9", "#2f6f93"),
        "vents" => ("#5a2a1a", "#c4532a", "#3a1d1d", "#1c0f12"),
        "deep" => ("#1b2238", "#101524", "#0c1a2c", "#050b14"),
        "reef" => ("#5a6d8a", "#8fa3bf", "#1f6f8a", "#134a63"),
        "spire" => ("#e8dcb0", "#cdb97a", "#3f7d78", "#255551"),
        "trench" => ("#2a1f55", "#5a3fa0", "#1c3f6e", "#0d2140"),
        "abyss" => ("#0f1030", "#2a1f55", "#141a40", "#070a1f"),
        "mangrove" => ("#b9d6a0", "#7fae6d", "#2f5d4a", "#1c3d30"),
        "oasis" => ("#ffe2a8", "#f2b872", "#2f9aa3", "#1c6f78"),
        "kelp" => ("#a8d8c0", "#6fb89a", "#1f6a5a", "#12453a"),
        "caverns" => ("#3a2f5a", "#6a56a8", "#2a3f6a", "#162544"),
        "lotus" => ("#ffd6e8", "#f5a8c8", "#5a8fb0", "#356a8a"),
        "wreck" => ("#8a94a0", "#5f6b78", "#2f4a5a", "#1a2f3a"),
        "skyfall" => ("#cfeaff", "#9fd0ff", "#5aa0e0", "#3a78c0"),
        "clockwork" => ("#d9c39a", "#b08d57", "#4a5a5a", "#2a3838"),
        "caldera" => ("#ffb37a", "#e0522a", "#5a2418", "#2f100c"),
        "fjord" => ("#c8d8e8", "#8fa8c0", "#3a5a78", "#1f3550"),
        "shoals" => ("#ffd0ec", "#ffa8d8", "#58c0d8", "#3a98b8"),
        "mirror" => ("#e8eef5", "#c0ccd8", "#9ab0c4", "#6f8aa0"),
        "rift" => ("#5a3a2a", "#8a5a3a", "#3a2a2a", "#1f1414"),
        "dreamtide" => ("#3a2f6a", "#7a5fb0", "#2a3a7a", "#161f4a"),
        "eclipse" => ("#14101f", "#2a1f3a", "#0f0f1f", "#05050c"),
        _ => ("#ffd9a0", "#ffb27a", "#2c6e8f", "#1d4f6b"),
    }
}
pub(crate) fn pill(x: f32, y: f32, label: &str, fill: &str, right: bool) -> String {
    let w = label.chars().count() as f32 * 10.5 + 26.0;
    let x0 = if right { x - w } else { x };
    format!(r##"<rect x="{x0}" y="{y}" width="{w}" height="32" rx="8" fill="#000000" fill-opacity="0.55"/>{}"##, text(x0 + w / 2.0, y + 22.0, 18.0, fill, "middle", "Figtree 700", label))
}
/// A label on a solid colour (the fish's rarity), right-aligned at x.
fn badge(x: f32, y: f32, label: &str, fill: &str) -> String {
    let w = label.chars().count() as f32 * 10.5 + 26.0;
    format!(r##"<rect x="{}" y="{y}" width="{w}" height="32" rx="8" fill="{fill}" stroke="#ffffff" stroke-opacity="0.5" stroke-width="2"/>{}"##, x - w, text(x - w / 2.0, y + 22.0, 18.0, "#ffffff", "middle", "Figtree 700", label))
}
/// A fish facing right, about `size` wide, centred on (cx, cy).
pub(crate) fn fish_shape(cx: f32, cy: f32, size: f32, color: &str) -> String {
    let k = size / 100.0;
    format!(r##"<g transform="translate({} {}) scale({k})"><polygon points="4,24 30,50 4,76" fill="{color}"/><ellipse cx="58" cy="50" rx="38" ry="24" fill="{color}"/><path d="M48 28 q12 -16 26 -4z" fill="{color}"/><ellipse cx="56" cy="56" rx="24" ry="10" fill="#ffffff" fill-opacity="0.25"/><circle cx="80" cy="44" r="6" fill="#ffffff"/><circle cx="82" cy="44" r="3" fill="#1b1d27"/></g>"##, cx - size / 2.0, cy - size / 2.0)
}
pub(crate) fn scene(biome: &str, place: &str, h: f32, phase: f32) -> String {
    let (s1, s2, w1, w2) = scene_colors(biome);
    let horizon = h * 0.42;
    let mut s = format!(r##"<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{s1}"/><stop offset="1" stop-color="{s2}"/></linearGradient><linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{w1}"/><stop offset="1" stop-color="{w2}"/></linearGradient><clipPath id="clip"><rect width="{W}" height="{h}" rx="18"/></clipPath></defs><g clip-path="url(#clip)"><rect width="{W}" height="{horizon}" fill="url(#sky)"/><rect y="{horizon}" width="{W}" height="{}" fill="url(#sea)"/>"##, h - horizon);
    s += &format!(r##"<circle cx="130" cy="{}" r="34" fill="#fff6d0" fill-opacity="0.9"/><circle cx="130" cy="{0}" r="52" fill="#fff6d0" fill-opacity="0.18"/>"##, horizon * 0.5);
    for (k, y) in [0.56f32, 0.72, 0.88].iter().enumerate() {
        // each line of waves drifts sideways, the nearer ones faster; one loop of `phase` moves them a whole wave
        let shift = phase * 160.0 * if k % 2 == 0 { 1.0 } else { -1.0 };
        s += &format!(r##"<path transform="translate({shift} 0)" d="M-180 {0} q40 -10 80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0 t80 0" stroke="#ffffff" stroke-opacity="{1}" stroke-width="3" fill="none"/>"##, h * y, 0.22 - k as f32 * 0.05);
    }
    s += "</g>";
    s += &pill(16.0, 14.0, place, "#ffffff", false);
    s
}
/// What the fight looks like right now.
pub struct Fight<'a> {
    pub biome: &'a str,
    pub place: &'a str,
    /// None: still waiting for the bite.
    pub rarity: Option<(&'a str, &'a str)>,
    pub track: i64,
    pub zone: i64,
    pub zone_width: i64,
    pub pos: i64,
    pub catch_pct: f32,
    pub tension_pct: f32,
    pub surge: bool,
}
fn fishing_svg(f: &Fight, phase: f32) -> String {
    let biting = f.rarity.is_some();
    let scene_h = 240.0;
    let h = if biting { 420.0 } else { scene_h };
    let mut s = open(h);
    s += &format!(r#"<rect width="{W}" height="{h}" rx="18" fill="{PANEL}"/>"#);
    s += &scene(f.biome, f.place, scene_h, phase);
    let horizon = scene_h * 0.42;
    let swing = (phase * std::f32::consts::TAU).sin();
    // the bobber: riding the water, or pulled under and jerking on the bite
    let (bx, by) = (400.0 + if biting { swing * 5.0 } else { 0.0 }, horizon + if biting { 44.0 + swing.abs() * 6.0 } else { 18.0 + swing * 4.0 });
    s += &format!(r##"<path d="M{bx} {} L600 -10" stroke="#ffffff" stroke-opacity="0.7" stroke-width="2"/><ellipse cx="{bx}" cy="{}" rx="{}" ry="5" fill="none" stroke="#ffffff" stroke-opacity="0.5" stroke-width="2"/><path d="M{} {by} a14 16 0 0 1 28 0z" fill="#e0263c"/><path d="M{} {by} a14 12 0 0 0 28 0z" fill="#ffffff"/>"##, by - 16.0, horizon + 22.0, if biting { 40.0 + swing.abs() * 8.0 } else { 22.0 + swing.abs() * 4.0 }, bx - 14.0, bx - 14.0);
    if let Some((label, color)) = f.rarity {
        s += &badge(W - 16.0, 14.0, label, color);
        if f.surge { s += &pill(W / 2.0 + 60.0, scene_h - 46.0, "SURGE!", "#ffd93b", true); }
        let (x0, y0, bw, bh) = (20.0, 256.0, W - 40.0, 56.0);
        let unit = bw / f.track.max(1) as f32;
        s += &format!(r##"<rect x="{x0}" y="{y0}" width="{bw}" height="{bh}" rx="12" fill="#101114"/>"##);
        s += &format!(r##"<rect x="{}" y="{}" width="{}" height="{}" rx="8" fill="#2ecc71" fill-opacity="0.32" stroke="#2ecc71" stroke-width="3"/>"##, x0 + f.zone as f32 * unit, y0 + 4.0, f.zone_width as f32 * unit, bh - 8.0);
        let inside = f.pos >= f.zone && f.pos < f.zone + f.zone_width;
        let (fx, fy) = (x0 + (f.pos as f32 + 0.5) * unit, y0 + bh / 2.0);
        s += &format!(r#"<g transform="rotate({} {fx} {fy})">{}</g>"#, swing * 9.0, fish_shape(fx, fy + swing * 2.0, 50.0, if inside { "#ffffff" } else { color }));
        let gauge = |y: f32, label: &str, pct: f32, color: &str| -> String {
            let (gx, gw) = (130.0, W - 130.0 - 90.0);
            format!(r##"{}<rect x="{gx}" y="{}" width="{gw}" height="18" rx="9" fill="#101114"/><rect x="{gx}" y="{}" width="{}" height="18" rx="9" fill="{color}"/>{}"##,
                text(20.0, y + 6.0, 19.0, "#b5bac1", "start", "Figtree 700", label), y - 10.0, y - 10.0, (gw * pct.clamp(0.0, 100.0) / 100.0).max(if pct > 0.0 { 18.0 } else { 0.0 }),
                text(W - 20.0, y + 6.0, 19.0, "#ffffff", "end", "Figtree 700", &format!("{}%", pct.round() as i64)))
        };
        s += &gauge(346.0, "Catch", f.catch_pct, "#2ecc71");
        s += &gauge(388.0, "Tension", f.tension_pct, if f.tension_pct > 75.0 { "#e74c3c" } else if f.tension_pct > 45.0 { "#f1c40f" } else { "#5fd3e6" });
    } else {
        s += &pill(W - 16.0, 14.0, "Waiting for a bite", "#ffffff", true);
    }
    s += "</svg>";
    s
}
/// The cast in progress: the scene with the bobber, and once the fish bites, the fight bar and the two gauges.
pub fn fishing(f: &Fight) -> Option<Vec<u8>> {
    png(&fishing_svg(f, 0.0))
}
/// The same, moving on a loop: the water drifts, the float bobs (or jerks on a bite) and the fish wriggles.
pub fn fishing_loop(f: &Fight) -> Option<Vec<u8>> {
    let n = if f.rarity.is_some() { 6 } else { 8 };
    let frames: Vec<(String, u16)> = (0..n).map(|k| (fishing_svg(f, k as f32 / n as f32), if f.rarity.is_some() { 9 } else { 14 })).collect();
    gif(&frames, true)
}
fn fishing_result_svg(biome: &str, place: &str, caught: Option<(&str, &str, &str, &str)>, missed: &str, rise: f32, phase: f32) -> String {
    let h = 260.0;
    let mut s = open(h);
    s += &format!(r#"<rect width="{W}" height="{h}" rx="18" fill="{PANEL}"/>"#);
    s += &scene(biome, place, h, phase);
    match caught {
        Some((rarity, color, name, sub)) => {
            s += &badge(W - 16.0, 14.0, rarity, color);
            // the fish leaps out of the water: low and small at first, then up to the middle with a splash ring
            let cy = 118.0 + (1.0 - rise) * 120.0;
            let size = 60.0 + rise * 90.0;
            if rise >= 1.0 { s += r##"<circle cx="320" cy="118" r="74" fill="#ffffff" fill-opacity="0.16"/><circle cx="320" cy="118" r="54" fill="#ffffff" fill-opacity="0.16"/>"##; }
            else { s += &format!(r##"<ellipse cx="320" cy="{}" rx="{}" ry="{}" fill="none" stroke="#ffffff" stroke-opacity="0.7" stroke-width="3"/>"##, h * 0.62, 30.0 + rise * 60.0, 6.0 + rise * 10.0); }
            s += &format!(r#"<g transform="rotate({} 320 {cy})">{}</g>"#, (1.0 - rise) * -40.0, fish_shape(320.0, cy, size, color));
            if rise >= 1.0 {
                s += &format!(r##"<rect x="60" y="196" width="{}" height="52" rx="12" fill="#000000" fill-opacity="0.55"/>"##, W - 120.0);
                s += &text(W / 2.0, 218.0, 20.0, "#ffffff", "middle", "Figtree 700", name);
                s += &text(W / 2.0, 240.0, 16.0, "#d0d4dc", "middle", "Figtree 600", sub);
            }
        }
        None => {
            let grow = 1.0 + phase * 0.6;
            s += &format!(r##"<ellipse cx="400" cy="150" rx="{}" ry="{}" fill="none" stroke="#ffffff" stroke-opacity="{}" stroke-width="3"/><ellipse cx="400" cy="150" rx="{}" ry="{}" fill="none" stroke="#ffffff" stroke-opacity="{}" stroke-width="3"/>"##, 46.0 * grow, 9.0 * grow, 0.6 - phase * 0.4, 78.0 * grow, 15.0 * grow, 0.3 - phase * 0.2);
            s += &pill(W - 16.0, 14.0, missed, "#f2a0a6", true);
        }
    }
    s += "</svg>";
    s
}
/// How a cast ended: the fish held up over the water with its name, or empty ripples.
pub fn fishing_result(biome: &str, place: &str, caught: Option<(&str, &str, &str, &str)>, missed: &str) -> Option<Vec<u8>> {
    png(&fishing_result_svg(biome, place, caught, missed, 1.0, 0.0))
}
/// The same as a short film that plays once: the fish leaps out of the water (or the ripples spread and fade).
pub fn fishing_result_film(biome: &str, place: &str, caught: Option<(&str, &str, &str, &str)>, missed: &str) -> Option<Vec<u8>> {
    let n = 7;
    let mut frames: Vec<(String, u16)> = (0..n).map(|k| { let t = k as f32 / n as f32; (fishing_result_svg(biome, place, caught, missed, t * t.sqrt().max(0.2), t), 7) }).collect();
    frames.push((fishing_result_svg(biome, place, caught, missed, 1.0, if caught.is_some() { 0.0 } else { 1.0 }), 10));
    gif(&frames, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn is_png(b: &Option<Vec<u8>>) -> bool {
        b.as_ref().is_some_and(|b| b.len() > 2000 && b.starts_with(&[0x89, b'P', b'N', b'G']))
    }
    #[test]
    fn every_game_picture_draws() {
        let all = ["cherry", "lemon", "grape", "bell", "star", "diamond", "seven", "wild"];
        assert!(is_png(&slots(&[[all[0], all[1], all[2]], [all[3], all[4], all[5]], [all[6], all[7], all[0]]], "Big win! 28x · +2,700", true)));
        let cards: Vec<String> = ["A♠", "10♥", "7♦", "K♣"].iter().map(|c| c.to_string()).collect();
        let hands = [TableHand { label: "Hand 1 · 18".into(), cards: &cards[..2], result: Some("You win · +100".into()), active: true }, TableHand { label: "Hand 2 · 17".into(), cards: &cards[2..], result: None, active: false }];
        assert!(is_png(&blackjack("Dealer · 10", &cards[1..3], true, &hands, "Blackjack pays 3 to 2")));
        assert!(is_png(&coin(true, true, "Heads! +95")));
        let f = Fight { biome: "bay", place: "Lantern Bay", rarity: Some(("Epic", "#9b59b6")), track: 20, zone: 7, zone_width: 5, pos: 9, catch_pct: 45.0, tension_pct: 80.0, surge: true };
        assert!(is_png(&fishing(&f)));
        assert!(is_png(&fishing(&Fight { rarity: None, ..f })));
        assert!(is_png(&fishing_result("eclipse", "The Eclipse Sea", Some(("Mythical", "#e91e63", "The Umbra Leviathan", "1,204.5 kg · +600 XP")), "")));
        assert!(is_png(&fishing_result("marsh", "Mossmere Marsh", None, "It got away")));
    }
}
