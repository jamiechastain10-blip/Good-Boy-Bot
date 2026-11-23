//! Pictures for the arcade games: Balloon Rescue (hangman), Treasure Climb (tower), Bomb Squad (wires), Bingo,
//! Trivia and Paddle Duel (pong). Each has a still picture and, where something happens, a short animation.
use crate::games::{gif, text as t};
use crate::png;

const W: f32 = 640.0;
/// A picture and whether it moves (a GIF) or not (a PNG).
pub type Shot = Option<(Vec<u8>, bool)>;

fn open(h: f32, bg: &str) -> String {
    format!(r##"<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{h}" viewBox="0 0 {W} {h}"><rect width="{W}" height="{h}" rx="20" fill="{bg}"/>"##)
}
fn chip(x: f32, y: f32, w: f32, label: &str, fill: &str, ink: &str) -> String {
    format!(r##"<rect x="{x}" y="{y}" width="{w}" height="34" rx="9" fill="{fill}"/>{}"##, t(x + w / 2.0, y + 23.0, 17.0, ink, "middle", "Figtree 700", label))
}
/// A chip as wide as its words need.
fn tag(x: f32, y: f32, label: &str, fill: &str, ink: &str, right: bool) -> String {
    let w = 28.0 + label.chars().count() as f32 * 9.6;
    chip(if right { x - w } else { x }, y, w, label, fill, ink)
}
/// Good Boy's own pup face. mood: 0 happy, 1 worried, 2 dizzy.
fn pup(cx: f32, cy: f32, k: f32, mood: u8) -> String {
    let face = match mood {
        0 => r##"<circle cx="-12" cy="-6" r="5" fill="#2a1a10"/><circle cx="12" cy="-6" r="5" fill="#2a1a10"/><path d="M-8 16 q8 8 16 0" stroke="#2a1a10" stroke-width="3" fill="none" stroke-linecap="round"/><ellipse cx="0" cy="22" rx="5" ry="6" fill="#ff7a8a"/>"##,
        1 => r##"<circle cx="-12" cy="-6" r="5" fill="#2a1a10"/><circle cx="12" cy="-6" r="5" fill="#2a1a10"/><path d="M-8 20 q8 -7 16 0" stroke="#2a1a10" stroke-width="3" fill="none" stroke-linecap="round"/>"##,
        _ => r##"<path d="M-17 -11 l10 10 M-7 -11 l-10 10 M7 -11 l10 10 M17 -11 l-10 10" stroke="#2a1a10" stroke-width="3" stroke-linecap="round"/><path d="M-8 20 q8 -7 16 0" stroke="#2a1a10" stroke-width="3" fill="none" stroke-linecap="round"/>"##,
    };
    format!(r##"<g transform="translate({cx} {cy}) scale({k})"><ellipse cx="-30" cy="-6" rx="13" ry="24" fill="#8a5a2b" transform="rotate(18 -30 -6)"/><ellipse cx="30" cy="-6" rx="13" ry="24" fill="#8a5a2b" transform="rotate(-18 30 -6)"/><circle r="34" fill="#f2d2a2"/><ellipse cx="0" cy="12" rx="17" ry="13" fill="#fff4e0"/><ellipse cx="0" cy="6" rx="6" ry="4.5" fill="#2a1a10"/>{face}</g>"##)
}
fn tick(cx: f32, cy: f32, r: f32, fill: &str) -> String {
    format!(r##"<circle cx="{cx}" cy="{cy}" r="{r}" fill="{fill}"/><path d="M{} {cy} l{} {} l{} {}" stroke="#ffffff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>"##, cx - r * 0.45, r * 0.3, r * 0.35, r * 0.55, -r * 0.7)
}
fn cross(cx: f32, cy: f32, r: f32, color: &str) -> String {
    format!(r##"<path d="M{} {} L{} {} M{} {} L{} {}" stroke="{color}" stroke-width="4" stroke-linecap="round"/>"##, cx - r, cy - r, cx + r, cy + r, cx + r, cy - r, cx - r, cy + r)
}
fn confetti(h: f32, phase: u32) -> String {
    let colors = ["#ff5d73", "#ffb12e", "#4dd0a1", "#5fb8ff", "#c08bff", "#ffd93b"];
    (0..26u32).map(|k| {
        let x = (k * 97 + 31) % 620 + 10;
        let y = ((k * 53 + phase * 37) % (h as u32 - 20)) + 10;
        format!(r##"<rect x="{x}" y="{y}" width="8" height="5" rx="1.5" fill="{}" transform="rotate({} {x} {y})"/>"##, colors[(k % 6) as usize], (k * 47 + phase * 30) % 180)
    }).collect()
}
fn banner(y: f32, text: &str, good: bool) -> String {
    format!(r##"<rect x="110" y="{y}" width="420" height="46" rx="12" fill="{}"/>{}"##, if good { "#2f9e62" } else { "#c2374a" }, t(320.0, y + 31.0, 22.0, "#ffffff", "middle", "Display 800", text))
}
fn finish(frames: Vec<(String, u16)>) -> Shot {
    if frames.len() == 1 { png(&frames[0].0).map(|b| (b, false)) } else { gif(&frames, false).map(|b| (b, true)) }
}

// ------------------------------------------------------------------ Balloon Rescue (hangman)
#[derive(Clone, Copy, PartialEq)]
pub enum End { Playing, Won, Lost }
pub struct Hangman<'a> {
    pub category: &'a str,
    /// One per letter of the word: the letter when it is showing.
    pub letters: Vec<Option<char>>,
    /// Letters tried so far, and whether each was in the word.
    pub tried: Vec<(char, bool)>,
    pub balloons: u32,
    pub headline: &'a str,
    pub small: &'a str,
    pub end: End,
    /// This guess popped this many balloons (animated).
    pub popped: u32,
}
const BALLOONS: [&str; 6] = ["#ff5d73", "#ffb12e", "#4dd0a1", "#5fb8ff", "#c08bff", "#ff8ad1"];
fn hangman_svg(g: &Hangman, balloons: u32, burst: u32, lift: f32, phase: u32) -> String {
    let rows = g.tried.len().div_ceil(13).max(1) as f32;
    let h = 362.0 + rows * 40.0;
    let mut s = open(h, "#1b2440");
    s += r##"<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b5bdb"/><stop offset="1" stop-color="#1b2440"/></linearGradient></defs><rect width="640" height="230" rx="20" fill="url(#sky)"/>"##;
    s += &chip(18.0, 16.0, 150.0, "Balloon Rescue", "#00000066", "#ffffff");
    s += &tag(622.0, 16.0, g.category, "#00000066", "#ffe08a", true);
    let (px, py) = (150.0, 192.0 - lift);
    for (k, c) in BALLOONS.iter().enumerate() {
        let k = k as u32;
        let x = 62.0 + k as f32 * 35.0;
        let y = 78.0 - lift + ((phase + k) % 2) as f32 * 2.0;
        if k < balloons {
            s += &format!(r##"<path d="M{x} {} L{px} {}" stroke="#ffffff" stroke-opacity="0.6" stroke-width="1.5"/><ellipse cx="{x}" cy="{y}" rx="18" ry="24" fill="{c}"/><ellipse cx="{}" cy="{}" rx="5" ry="8" fill="#ffffff" fill-opacity="0.45"/>"##, y + 24.0, py - 20.0, x - 6.0, y - 10.0);
        } else if k < balloons + burst {
            s += &format!(r##"<g stroke="{c}" stroke-width="3" stroke-linecap="round"><path d="M{x} {y} l-11 -11 M{x} {y} l11 -11 M{x} {y} l-14 4 M{x} {y} l14 4 M{x} {y} l0 14"/></g>"##);
        }
    }
    s += &pup(px, py, 0.62, match g.end { End::Won => 0, End::Lost if lift < 0.0 => 2, _ => if balloons <= 2 { 1 } else { 0 } });
    s += &t(430.0, 96.0, 18.0, "#dbe4ff", "middle", "Figtree 600", &format!("{} balloon{} left", balloons, if balloons == 1 { "" } else { "s" }));
    s += &t(430.0, 128.0, 30.0, "#ffffff", "middle", "Display 800", g.headline);
    s += &t(430.0, 154.0, 15.0, "#b9c6f5", "middle", "Figtree 600", g.small);
    let n = g.letters.len().max(1) as f32;
    let step = (596.0 / n).min(62.0);
    let x0 = (W - n * step) / 2.0;
    for (k, c) in g.letters.iter().enumerate() {
        let x = x0 + k as f32 * step;
        let fill = match (c, g.end) { (None, _) => "#26315a", (_, End::Lost) => "#5a2632", (_, End::Won) => "#1f6b45", _ => "#33407a" };
        s += &format!(r##"<rect x="{x}" y="246" width="{}" height="62" rx="10" fill="{fill}"/>"##, step - 10.0);
        match c {
            Some(c) => s += &t(x + (step - 10.0) / 2.0, 291.0, (step * 0.66).min(40.0), "#ffffff", "middle", "Display 800", &c.to_uppercase().to_string()),
            None => s += &format!(r##"<rect x="{}" y="296" width="{}" height="4" rx="2" fill="#ffffff" fill-opacity="0.9"/>"##, x + 8.0, step - 26.0),
        }
    }
    s += &t(24.0, 349.0, 15.0, "#b9c6f5", "start", "Figtree 700", "TRIED");
    if g.tried.is_empty() { s += &t(86.0, 349.0, 15.0, "#8fa0d8", "start", "Figtree 600", "nothing yet"); }
    for (k, (c, ok)) in g.tried.iter().enumerate() {
        let (x, y) = (86.0 + (k % 13) as f32 * 41.0, 326.0 + (k / 13) as f32 * 40.0);
        s += &format!(r##"<rect x="{x}" y="{y}" width="34" height="34" rx="8" fill="{}"/>{}"##, if *ok { "#2f9e62" } else { "#c2374a" }, t(x + 17.0, y + 24.0, 19.0, "#ffffff", "middle", "Figtree 700", &c.to_uppercase().to_string()));
    }
    if g.end == End::Won { s += &confetti(230.0, phase); }
    s + "</svg>"
}
pub fn hangman(g: &Hangman, moving: bool) -> Shot {
    let mut frames = Vec::new();
    if moving && g.popped > 0 {
        frames.push((hangman_svg(g, g.balloons + g.popped, 0, 0.0, 0), 35));
        frames.push((hangman_svg(g, g.balloons, g.popped, 0.0, 1), 22));
    }
    if moving && g.end == End::Won {
        for k in 0..5 { frames.push((hangman_svg(g, g.balloons, 0, k as f32 * 9.0, k), 14)); }
        frames.push((hangman_svg(g, g.balloons, 0, 40.0, 5), 300));
    } else if moving && g.end == End::Lost {
        for k in 1..4 { frames.push((hangman_svg(g, 0, 0, -(k as f32) * 9.0, k), 12)); }
        frames.push((hangman_svg(g, 0, 0, -30.0, 4), 300));
    } else {
        frames.push((hangman_svg(g, g.balloons, 0, if g.end == End::Won { 40.0 } else if g.end == End::Lost { -30.0 } else { 0.0 }, 0), 300));
    }
    finish(frames)
}

// ------------------------------------------------------------------ Treasure Climb (tower)
pub const GOLDEN: usize = 9;
pub struct Tower<'a> {
    /// Floors safely climbed.
    pub floor: usize,
    /// The door picked on each floor so far (`GOLDEN` for the golden door).
    pub picks: &'a [usize],
    /// Where the traps were, once the climb is over.
    pub traps: Option<&'a [usize]>,
    pub mults: &'a [String],
    /// "climbing", "trapped", "top" or "cashed".
    pub state: &'a str,
    pub headline: &'a str,
    pub small: &'a str,
}
fn door(x: f32, y: f32, fill: &str) -> String {
    format!(r##"<path d="M{x} {} v-18 a16 16 0 0 1 32 0 v18z" fill="{fill}"/>"##, y + 34.0)
}
fn tower_svg(g: &Tower, reveal: bool, phase: u32) -> String {
    let floors = g.mults.len();
    let h = 132.0 + floors as f32 * 44.0;
    let mut s = open(h, "#15131f");
    s += &chip(18.0, 16.0, 150.0, "Treasure Climb", "#ffffff22", "#ffffff");
    let climbing = g.state == "climbing";
    // while a door is still opening, the picture shows the floor the player was on
    let (floor, state) = if reveal { (g.floor, g.state) } else { (g.picks.len().saturating_sub(1), "opening") };
    for f in 0..floors {
        let y = h - 96.0 - f as f32 * 44.0;
        let done = f < floor;
        let here = f == floor && state != "top" && state != "cashed";
        let lost_here = here && state == "trapped";
        s += &format!(r##"<rect x="150" y="{y}" width="300" height="38" rx="8" fill="{}" stroke="{}" stroke-width="2"/>"##, if lost_here { "#4a1f2a" } else if here { "#3a3360" } else if done { "#1f3a2c" } else { "#221f33" }, if here { "#ffd93b" } else { "#00000000" });
        let pick = g.picks.get(f).copied();
        if pick == Some(GOLDEN) && (done || lost_here || state == "opening" && here) {
            s += &format!(r##"<rect x="176" y="{}" width="216" height="26" rx="8" fill="{}"/>{}"##, y + 6.0, if lost_here { "#c2374a" } else { "#ffd93b" }, t(284.0, y + 25.0, 15.0, "#2a1a00", "middle", "Figtree 700", if lost_here { "The golden door was locked" } else if done { "Golden door" } else { "Golden door ..." }));
        } else {
            for d in 0..3 {
                let x = 176.0 + d as f32 * 92.0;
                let picked = pick == Some(d);
                let trap = g.traps.and_then(|t| t.get(f)).copied() == Some(d) && state != "opening";
                let fill = if done && picked { "#4dd0a1" } else if lost_here && picked { "#c2374a" } else if state == "opening" && here && picked { "#ffd93b" } else if trap && !done { "#6b2a38" } else if here && climbing { "#8f7cf7" } else { "#3b3655" };
                s += &door(x, y, fill);
                if done && picked { s += &format!(r##"<circle cx="{}" cy="{}" r="5" fill="#ffd93b"/>"##, x + 16.0, y + 20.0); }
                else if (lost_here && picked) || (trap && !done) { s += &cross(x + 16.0, y + 20.0, 5.0, "#ffffff"); }
                else if here && (climbing || state == "opening") { s += &t(x + 16.0, y + 28.0, 15.0, if picked && state == "opening" { "#2a1a00" } else { "#ffffff" }, "middle", "Figtree 700", &(d + 1).to_string()); }
            }
        }
        s += &t(476.0, y + 25.0, 17.0, if here { "#ffd93b" } else if done { "#4dd0a1" } else { "#77738f" }, "start", "Figtree 700", &g.mults[f]);
        s += &t(128.0, y + 25.0, 15.0, "#77738f", "end", "Figtree 600", &format!("Floor {}", f + 1));
    }
    s += r##"<polygon points="300,20 360,62 240,62" fill="#ffd93b"/><rect x="286" y="34" width="28" height="22" rx="4" fill="#b8860b"/>"##;
    let py = h - 96.0 - floor.min(floors - 1) as f32 * 44.0 + 10.0 - (phase % 2) as f32 * 3.0;
    s += &pup(566.0, py, 0.5, if state == "trapped" { 2 } else { 0 });
    s += &t(320.0, h - 34.0, 18.0, "#ffffff", "middle", "Figtree 700", if reveal { g.headline } else { "Opening the door ..." });
    s += &t(320.0, h - 12.0, 14.0, "#8d88ad", "middle", "Figtree 600", g.small);
    if reveal && state == "top" { s += &confetti(h - 96.0, phase); }
    s + "</svg>"
}
/// `opened`: a door was just picked, so the picture first shows it opening.
pub fn tower(g: &Tower, opened: bool, moving: bool) -> Shot {
    let mut frames = Vec::new();
    if moving && opened && !g.picks.is_empty() {
        frames.push((tower_svg(g, false, 0), 45));
        frames.push((tower_svg(g, true, 1), 20));
    }
    frames.push((tower_svg(g, true, 0), 300));
    finish(frames)
}

// ------------------------------------------------------------------ Bomb Squad (wires)
pub const WIRE_COLORS: [&str; 5] = ["#e0263c", "#3b82f6", "#2ecc71", "#ffd93b", "#c08bff"];
pub struct Wires<'a> {
    pub cut: &'a [usize],
    /// The wire Good Boy sniffed out as safe.
    pub sniffed: Option<usize>,
    /// The bomb's wire, once the game is over.
    pub bomb: Option<usize>,
    /// "cutting", "boom", "cleared" or "cashed".
    pub state: &'a str,
    pub screen: &'a str,
    pub headline: &'a str,
    pub small: &'a str,
}
fn wires_svg(g: &Wires, reveal: bool, flash: bool) -> String {
    let h = 360.0;
    let boom = reveal && g.state == "boom";
    let mut s = open(h, if flash { "#7a1420" } else { "#1a1d21" });
    s += &chip(18.0, 16.0, 130.0, "Bomb Squad", "#ffffff22", "#ffffff");
    s += &format!(r##"<rect x="60" y="70" width="520" height="210" rx="18" fill="#2b3036" stroke="{}" stroke-width="3"/><rect x="230" y="88" width="180" height="56" rx="8" fill="#0b0d0f"/>"##, if boom { "#e0263c" } else { "#454c55" });
    let screen = if !reveal { "..." } else { g.screen };
    s += &t(320.0, 130.0, 36.0, if reveal && (g.state == "cleared" || g.state == "cashed") { "#4dd0a1" } else { "#ff4d4d" }, "middle", "Display 800", screen);
    let last = g.cut.last().copied();
    for (k, c) in WIRE_COLORS.iter().enumerate() {
        let x = 120.0 + k as f32 * 100.0;
        let is_cut = g.cut.contains(&k) && (reveal || Some(k) != last);
        let is_bomb = reveal && g.bomb == Some(k);
        if g.sniffed == Some(k) {
            s += &format!(r##"<path d="M{x} 160 q14 54 0 108" stroke="{c}" stroke-opacity="0.3" stroke-width="10" fill="none" stroke-linecap="round"/>"##);
            s += &pup(x, 214.0, 0.3, 0);
            s += &t(x, 250.0, 12.0, "#9fe8c8", "middle", "Figtree 700", "SAFE");
        } else if is_cut {
            s += &format!(r##"<path d="M{x} 160 v38" stroke="{c}" stroke-width="10" stroke-linecap="round"/><path d="M{x} 232 v36" stroke="{c}" stroke-width="10" stroke-linecap="round"/>"##);
            if is_bomb { s += &format!(r##"<circle cx="{x}" cy="215" r="15" fill="#e0263c"/>{}"##, cross(x, 215.0, 6.0, "#ffffff")); } else { s += &tick(x, 215.0, 13.0, "#2f9e62"); }
        } else {
            s += &format!(r##"<path d="M{x} 160 q14 54 0 108" stroke="{c}" stroke-width="{}" fill="none" stroke-linecap="round"/>"##, if !reveal && Some(k) == last { 14 } else { 10 });
            if is_bomb { s += &format!(r##"<circle cx="{}" cy="215" r="13" fill="#11151a" stroke="#e0263c" stroke-width="3"/>{}"##, x + 7.0, t(x + 7.0, 220.0, 13.0, "#ff8a8a", "middle", "Figtree 700", "!")); }
        }
        s += &format!(r##"<circle cx="{x}" cy="160" r="9" fill="#11151a"/><circle cx="{x}" cy="268" r="9" fill="#11151a"/>"##);
    }
    s += &t(320.0, 312.0, 21.0, "#ffffff", "middle", "Figtree 700", if reveal { g.headline } else { "Snip ..." });
    s += &t(320.0, 340.0, 14.0, "#8b94a0", "middle", "Figtree 600", g.small);
    s + "</svg>"
}
pub fn wires(g: &Wires, snipped: bool, moving: bool) -> Shot {
    let mut frames = Vec::new();
    if moving && snipped && !g.cut.is_empty() {
        frames.push((wires_svg(g, false, false), 45));
        if g.state == "boom" { frames.push((wires_svg(g, true, true), 12)); frames.push((wires_svg(g, true, false), 10)); frames.push((wires_svg(g, true, true), 12)); }
    }
    frames.push((wires_svg(g, true, false), 300));
    finish(frames)
}

// ------------------------------------------------------------------ Bingo
pub struct Bingo<'a> {
    pub card: &'a [u32],
    pub drawn: &'a [u32],
    pub draws: usize,
    /// The squares of the finished line or lines.
    pub line: &'a [usize],
    pub headline: &'a str,
    pub detail: &'a str,
    pub small: &'a str,
    /// Balls that dropped on this press (animated one by one).
    pub fresh: usize,
    pub good: Option<bool>,
}
fn bingo_svg(g: &Bingo, shown: usize, drop: f32, last: bool) -> String {
    let h = 400.0;
    let mut s = open(h, "#1c1730");
    s += &chip(18.0, 16.0, 90.0, "Bingo", "#ffffff22", "#ffffff");
    let hit = &g.drawn[..shown.min(g.drawn.len())];
    let settled = if drop < 1.0 { &hit[..hit.len().saturating_sub(1)] } else { hit };
    for (k, n) in g.card.iter().enumerate() {
        let (x, y) = (40.0 + (k % 4) as f32 * 76.0, 70.0 + (k / 4) as f32 * 76.0);
        let on = settled.contains(n);
        let line = last && g.line.contains(&k);
        s += &format!(r##"<rect x="{x}" y="{y}" width="68" height="68" rx="12" fill="{}" stroke="{}" stroke-width="3"/>"##, if on { "#7c4dff" } else { "#2a2444" }, if line { "#ffd93b" } else { "#00000000" });
        s += &t(x + 34.0, y + 45.0, 28.0, if on { "#ffffff" } else { "#8c84b8" }, "middle", "Display 800", &n.to_string());
    }
    s += &t(500.0, 86.0, 16.0, "#b9b0e8", "middle", "Figtree 700", &format!("DRAWN {} OF {}", hit.len(), g.draws));
    for (k, n) in hit.iter().enumerate() {
        let (x, mut y) = (398.0 + (k % 4) as f32 * 68.0, 128.0 + (k / 4) as f32 * 62.0);
        if k + 1 == hit.len() && drop < 1.0 { y = y - 140.0 + 140.0 * drop; }
        let on_card = g.card.contains(n);
        s += &format!(r##"<circle cx="{x}" cy="{y}" r="26" fill="{}" fill-opacity="{}"/><circle cx="{}" cy="{}" r="7" fill="#ffffff" fill-opacity="0.35"/>{}"##, BALLOONS[k % 6], if on_card { "1" } else { "0.45" }, x - 9.0, y - 10.0, t(x, y + 8.0, 22.0, "#ffffff", "middle", "Display 800", &n.to_string()));
    }
    if last {
        s += &t(500.0, 322.0, 25.0, match g.good { Some(true) => "#ffd93b", Some(false) => "#ff8a9a", None => "#ffffff" }, "middle", "Display 800", g.headline);
        s += &t(500.0, 346.0, 15.0, "#b9b0e8", "middle", "Figtree 600", g.detail);
    }
    s += &t(320.0, 386.0, 14.0, "#8c84b8", "middle", "Figtree 600", g.small);
    if last && g.good == Some(true) { s += &confetti(360.0, shown as u32); }
    s + "</svg>"
}
pub fn bingo(g: &Bingo, moving: bool) -> Shot {
    let mut frames = Vec::new();
    let all = g.drawn.len();
    if moving && g.fresh > 0 {
        for shown in (all - g.fresh.min(all) + 1)..=all {
            frames.push((bingo_svg(g, shown, 0.35, false), 9));
            frames.push((bingo_svg(g, shown, 0.75, false), 9));
            if shown < all { frames.push((bingo_svg(g, shown, 1.0, false), 28)); }
        }
    }
    frames.push((bingo_svg(g, all, 1.0, true), 300));
    finish(frames)
}

// ------------------------------------------------------------------ Trivia
pub struct Trivia<'a> {
    pub category: &'a str,
    pub streak: &'a str,
    pub question: &'a str,
    pub answers: &'a [String],
    pub seconds: u32,
    /// Once answered: (the right answer, the one picked if any).
    pub result: Option<(usize, Option<usize>)>,
    pub headline: &'a str,
    pub small: &'a str,
}
/// The colours of Discord's own buttons, so the picture and the buttons under it match.
const ANSWER: [&str; 4] = ["#5865f2", "#da373c", "#4e5058", "#248046"];
fn wrap(s: &str, width: usize) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for word in s.split_whitespace() {
        match lines.last_mut() {
            Some(l) if l.chars().count() + 1 + word.chars().count() <= width => { l.push(' '); l.push_str(word); }
            _ => lines.push(word.to_string()),
        }
    }
    lines
}
fn trivia_svg(g: &Trivia, left: u32) -> String {
    let h = 372.0;
    let mut s = open(h, "#1d1730");
    s += &chip(18.0, 16.0, 90.0, "Trivia", "#ffffff22", "#ffffff");
    s += &tag(120.0, 16.0, g.category, "#7c4dff", "#ffffff", false);
    if !g.streak.is_empty() { s += &tag(622.0, 16.0, g.streak, "#ffb12e", "#2a1a00", true); }
    let part = left as f32 / g.seconds.max(1) as f32;
    let bar = if part > 0.5 { "#4dd0a1" } else if part > 0.25 { "#ffb12e" } else { "#ff5d73" };
    s += &format!(r##"<rect x="40" y="66" width="560" height="10" rx="5" fill="#2b2444"/><rect x="40" y="66" width="{}" height="10" rx="5" fill="{bar}"/>"##, (560.0 * part).max(0.0));
    s += &t(600.0, 96.0, 15.0, "#b9b0e8", "end", "Figtree 700", &match g.result { Some(_) => g.headline.to_string(), None if left == 0 => "Time's up!".to_string(), None => format!("{left} second{} left", if left == 1 { "" } else { "s" }) });
    let lines = wrap(g.question, 40);
    let size = if lines.len() > 2 { 21.0 } else { 25.0 };
    let top = 158.0 - (lines.len() as f32 - 1.0) * (size + 6.0) / 2.0;
    for (k, l) in lines.iter().take(3).enumerate() { s += &t(320.0, top + k as f32 * (size + 6.0), size, "#ffffff", "middle", "Display 700", l); }
    for (k, a) in g.answers.iter().take(4).enumerate() {
        let (x, y) = (40.0 + (k % 2) as f32 * 286.0, 206.0 + (k / 2) as f32 * 66.0);
        let (fill, edge, dim) = match g.result {
            Some((right, _)) if right == k => ("#248046", "#9ff0c0", "1"),
            Some((_, Some(p))) if p == k => ("#da373c", "#ffb3b8", "1"),
            Some(_) => ("#34303f", "#00000000", "0.55"),
            None => (ANSWER[k], "#00000000", "1"),
        };
        let size = if a.chars().count() > 18 { 15.5 } else { 20.0 };
        s += &format!(r##"<g opacity="{dim}"><rect x="{x}" y="{y}" width="274" height="54" rx="12" fill="{fill}" stroke="{edge}" stroke-width="3"/><circle cx="{}" cy="{}" r="17" fill="#00000033"/>{}{}</g>"##, x + 30.0, y + 27.0, t(x + 30.0, y + 34.0, 20.0, "#ffffff", "middle", "Display 800", ["A", "B", "C", "D"][k]), t(x + 58.0, y + 34.0, size, "#ffffff", "start", "Figtree 700", a));
    }
    s += &t(320.0, 358.0, 14.0, "#8c84b8", "middle", "Figtree 600", g.small);
    s + "</svg>"
}
/// While a question is open and `moving`, the timer bar runs down in real time.
pub fn trivia(g: &Trivia, moving: bool) -> Shot {
    let mut frames = Vec::new();
    if moving && g.result.is_none() {
        for left in (1..=g.seconds).rev() { frames.push((trivia_svg(g, left), 100)); }
        frames.push((trivia_svg(g, 0), 300));
    } else {
        frames.push((trivia_svg(g, if g.result.is_some() { 0 } else { g.seconds }), 300));
    }
    finish(frames)
}

// ------------------------------------------------------------------ Paddle Duel (pong)
pub struct Pong<'a> {
    pub left: &'a str,
    pub right: &'a str,
    pub score: (u32, u32),
    /// Where each paddle stands: 0 top, 1 middle, 2 bottom.
    pub paddles: (usize, usize),
    /// The last shot: (hit from the left side, the zone it flew to, a smash, how it ended).
    pub shot: Option<(bool, usize, bool, Landed)>,
    pub headline: &'a str,
    pub small: &'a str,
    pub over: bool,
}
#[derive(Clone, Copy, PartialEq)]
pub enum Landed { Returned, Scored, Out }
fn pong_svg(g: &Pong, travel: f32, done: bool) -> String {
    let h = 380.0;
    let mut s = open(h, "#0d1b1e");
    s += &chip(18.0, 16.0, 120.0, "Paddle Duel", "#ffffff22", "#ffffff");
    s += r##"<rect x="40" y="66" width="560" height="240" rx="14" fill="#11343a" stroke="#2a6c75" stroke-width="3"/><path d="M320 70 v232" stroke="#2a6c75" stroke-width="3" stroke-dasharray="10 8"/>"##;
    let zone_y = |z: usize| 106.0 + z as f32 * 80.0;
    for z in 0..3 { s += &t(52.0, zone_y(z) + 5.0, 13.0, "#4f9aa5", "start", "Figtree 700", ["TOP", "MIDDLE", "BOTTOM"][z]); }
    s += &format!(r##"<rect x="122" y="{}" width="14" height="72" rx="7" fill="#5fb8ff"/><rect x="562" y="{}" width="14" height="72" rx="7" fill="#ff8ad1"/>"##, zone_y(g.paddles.0) - 36.0, zone_y(g.paddles.1) - 36.0);
    if let Some((from_left, zone, smash, landed)) = g.shot {
        let (x0, y0) = if from_left { (146.0, zone_y(g.paddles.0)) } else { (552.0, zone_y(g.paddles.1)) };
        let end_x = if from_left { if landed == Landed::Returned { 552.0 } else { 590.0 } } else if landed == Landed::Returned { 146.0 } else { 50.0 };
        let y1 = if landed == Landed::Out { if zone == 2 { 318.0 } else { 54.0 } } else { zone_y(zone) };
        let (x, y) = (x0 + (end_x - x0) * travel, y0 + (y1 - y0) * travel - if smash { 0.0 } else { (travel * std::f32::consts::PI).sin() * 34.0 });
        s += &format!(r##"<path d="M{x0} {y0} L{x} {y}" stroke="{}" stroke-opacity="0.4" stroke-width="{}" stroke-dasharray="4 8" fill="none"/><circle cx="{x}" cy="{y}" r="11" fill="{}"/>"##, if smash { "#ffd93b" } else { "#ffffff" }, if smash { 5 } else { 3 }, if smash { "#ffd93b" } else { "#ffffff" });
    } else {
        s += r##"<circle cx="320" cy="186" r="11" fill="#ffffff"/>"##;
    }
    let cut = |n: &str| n.chars().take(12).collect::<String>();
    s += &t(230.0, 52.0, 26.0, "#5fb8ff", "middle", "Display 800", &format!("{} {}", cut(g.left), g.score.0));
    s += &t(460.0, 52.0, 26.0, "#ff8ad1", "middle", "Display 800", &format!("{} {}", g.score.1, cut(g.right)));
    s += &t(320.0, 338.0, 18.0, "#ffffff", "middle", "Figtree 700", if done { g.headline } else { "..." });
    s += &t(320.0, 364.0, 14.0, "#6fa7b0", "middle", "Figtree 600", g.small);
    if done && g.over { s += &confetti(300.0, 3); }
    s + "</svg>"
}
pub fn pong(g: &Pong, moving: bool) -> Shot {
    let mut frames = Vec::new();
    if moving && g.shot.is_some() {
        for k in 0..5 { frames.push((pong_svg(g, 0.1 + k as f32 * 0.2, false), 8)); }
    }
    frames.push((pong_svg(g, 1.0, true), 300));
    finish(frames)
}
// ------------------------------------------------------------------ Memory
pub struct Memory<'a> {
    /// The face of the card in each of the 16 places (0 to 7).
    pub cards: &'a [usize],
    pub found: &'a [usize],
    /// Face-up cards that are not matched (one, or two that did not match).
    pub open: &'a [usize],
    /// Cards that turned over on this press (they flip in).
    pub fresh: &'a [usize],
    pub mistakes: u32,
    pub streak: u32,
    pub best: u32,
    pub pays: &'a str,
    pub headline: &'a str,
    pub small: &'a str,
    /// Some(true) when the board is cleared for a payout, Some(false) when it is lost.
    pub end: Option<bool>,
}
const FACE_COLORS: [&str; 8] = ["#ffd93b", "#ff5d73", "#5fb8ff", "#4dd0a1", "#c08bff", "#ff9a3c", "#7be0e8", "#ff8ad1"];
/// Eight simple pictures, drawn (nothing depends on a font having emoji).
fn face(id: usize, cx: f32, cy: f32, r: f32, color: &str) -> String {
    let p = |pts: &[(f32, f32)]| pts.iter().map(|(x, y)| format!("{:.1},{:.1}", cx + x * r, cy + y * r)).collect::<Vec<_>>().join(" ");
    match id % 8 {
        0 => { let pts: Vec<(f32, f32)> = (0..10).map(|k| { let a = -std::f32::consts::FRAC_PI_2 + k as f32 * std::f32::consts::PI / 5.0; let rr = if k % 2 == 0 { 1.0 } else { 0.42 }; (rr * a.cos(), rr * a.sin()) }).collect(); format!(r##"<polygon points="{}" fill="{color}"/>"##, p(&pts)) }
        1 => format!(r##"<path d="M{cx} {} C{} {} {} {} {cx} {} C{} {} {} {} {cx} {}z" fill="{color}"/>"##, cy + r * 0.85, cx - r * 1.5, cy + r * 0.2, cx - r * 0.9, cy - r * 1.0, cy - r * 0.2, cx + r * 0.9, cy - r * 1.0, cx + r * 1.5, cy + r * 0.2, cy + r * 0.85),
        2 => format!(r##"<polygon points="{}" fill="{color}"/>"##, p(&[(0.0, -1.0), (0.8, 0.0), (0.0, 1.0), (-0.8, 0.0)])),
        3 => format!(r##"<circle cx="{cx}" cy="{cy}" r="{}" fill="{color}"/><circle cx="{cx}" cy="{cy}" r="{}" fill="#1b2a35"/>"##, r * 0.95, r * 0.45),
        4 => format!(r##"<polygon points="{}" fill="{color}"/>"##, p(&[(0.0, -1.0), (1.0, 0.8), (-1.0, 0.8)])),
        5 => format!(r##"<path d="M{} {} A{r} {r} 0 1 0 {} {} A{} {} 0 1 1 {} {}z" fill="{color}"/>"##, cx + r * 0.3, cy - r * 0.95, cx + r * 0.3, cy + r * 0.95, r * 0.75, r * 0.75, cx + r * 0.3, cy - r * 0.95),
        6 => format!(r##"<polygon points="{}" fill="{color}"/>"##, p(&[(0.2, -1.0), (-0.7, 0.1), (-0.05, 0.1), (-0.25, 1.0), (0.7, -0.15), (0.05, -0.15)])),
        _ => format!(r##"<rect x="{}" y="{}" width="{}" height="{}" rx="{}" fill="{color}"/>"##, cx - r * 0.85, cy - r * 0.85, r * 1.7, r * 1.7, r * 0.3),
    }
}
fn memory_svg(g: &Memory, flip: f32, burst: bool, phase: u32) -> String {
    let h = 492.0;
    let mut s = open(h, "#12202a");
    s += &chip(18.0, 16.0, 100.0, "Memory", "#ffffff22", "#ffffff");
    s += &tag(W - 18.0, 16.0, &format!("Pairs {} of 8", g.found.len() / 2), "#ffffff22", "#ffffff", true);
    if g.streak >= 2 { s += &tag(W - 160.0, 16.0, &format!("Combo x{}", g.streak), "#ffb12e", "#2a1a00", true); }
    s += &t(320.0, 78.0, 20.0, "#ffffff", "middle", "Figtree 700", g.headline);
    s += &t(320.0, 100.0, 14.0, "#86a7b5", "middle", "Figtree 600", &format!("Mistakes {} · paying {} · best combo x{}", g.mistakes, g.pays, g.best));
    let (cw, ch, gap) = (126.0, 72.0, 14.0);
    let x0 = (W - (4.0 * cw + 3.0 * gap)) / 2.0;
    for k in 0..16 {
        let (x, y) = (x0 + (k % 4) as f32 * (cw + gap), 118.0 + (k / 4) as f32 * (ch + gap));
        let is_found = g.found.contains(&k);
        let face_up = is_found || g.open.contains(&k) || g.end.is_some();
        let fresh = g.fresh.contains(&k);
        // a card turning over: it narrows to a line, then opens
        let squash = if fresh && flip < 1.0 { (1.0 - flip * 2.0).abs().max(0.08) } else { 1.0 };
        let shows_face = face_up && !(fresh && flip < 0.5);
        let w = cw * squash;
        let xx = x + (cw - w) / 2.0;
        let wrong = g.open.len() == 2 && g.open.contains(&k) && !is_found;
        let fill = if shows_face { if is_found { "#e4f7ee" } else if wrong { "#fde2e6" } else { "#f6fbfd" } } else { "#1f6f8a" };
        let edge = if wrong && shows_face { "#e0263c" } else if is_found { "#4dd0a1" } else if g.open.contains(&k) && shows_face { "#ffd93b" } else { "#00000000" };
        s += &format!(r##"<rect x="{xx}" y="{y}" width="{w}" height="{ch}" rx="12" fill="{fill}" stroke="{edge}" stroke-width="4"/>"##);
        if shows_face && squash > 0.5 { s += &face(g.cards[k], x + cw / 2.0, y + ch / 2.0, 24.0, FACE_COLORS[g.cards[k] % 8]); }
        else if !shows_face && squash > 0.5 { s += &format!(r##"<rect x="{}" y="{}" width="{}" height="{}" rx="8" fill="none" stroke="#7fd3ea" stroke-opacity="0.5" stroke-width="2" stroke-dasharray="6 5"/>"##, x + 8.0, y + 8.0, cw - 16.0, ch - 16.0); s += &t(x + cw / 2.0, y + 45.0, 22.0, "#d6f4fb", "middle", "Figtree 700", &(k + 1).to_string()); }
    }
    s += &t(320.0, 474.0, 14.0, "#86a7b5", "middle", "Figtree 600", g.small);
    if g.end == Some(true) { s += &confetti(h - 20.0, phase); }
    if burst { s += r##"<rect x="0" y="0" width="640" height="492" rx="20" fill="#ffffff" fill-opacity="0.06"/>"##; }
    s + "</svg>"
}
pub fn memory(g: &Memory, moving: bool) -> Shot {
    let mut frames = Vec::new();
    if moving && !g.fresh.is_empty() {
        for k in 0..4 { frames.push((memory_svg(g, k as f32 / 3.0, false, 0), 7)); }
    }
    if moving && g.end == Some(true) { for k in 0..4 { frames.push((memory_svg(g, 1.0, k % 2 == 0, k), 12)); } }
    frames.push((memory_svg(g, 1.0, false, 0), 300));
    finish(frames)
}

/// Used by the win and lose strips of games that end with a line across the picture.
pub fn strip(text: &str, good: bool) -> String {
    banner(0.0, text, good)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_arcade_picture_draws_still_and_moving() {
        let g = Hangman { category: "Food", letters: "p_nc_ke".chars().map(|c| Some(c).filter(|c| *c != '_')).collect(), tried: vec![('e', true), ('a', false)], balloons: 4, headline: "Win 2.2x", small: "more balloons, more coins", end: End::Playing, popped: 1 };
        assert!(!hangman(&g, false).unwrap().1 && hangman(&g, true).unwrap().1);
        let mults: Vec<String> = (1..=8).map(|f| format!("{f}x")).collect();
        let tw = Tower { floor: 2, picks: &[0, 1], traps: None, mults: &mults, state: "climbing", headline: "Pick a door", small: "", };
        assert!(tower(&tw, true, true).unwrap().1 && !tower(&tw, false, true).unwrap().1);
        let wi = Wires { cut: &[1, 3], sniffed: Some(0), bomb: Some(3), state: "boom", screen: "BOOM", headline: "That was the bomb", small: "" };
        assert!(wires(&wi, true, true).unwrap().1);
        let card: Vec<u32> = (1..=16).collect();
        let b = Bingo { card: &card, drawn: &[1, 2, 3, 4], draws: 10, line: &[0, 1, 2, 3], headline: "BINGO! 20x", detail: "a line in 4 draws", small: "", fresh: 2, good: Some(true) };
        assert!(bingo(&b, true).unwrap().1 && !bingo(&b, false).unwrap().1);
        let answers: Vec<String> = ["Wit Studio", "MAPPA", "Bones", "Hidden Leaf (Konoha) village"].iter().map(|s| s.to_string()).collect();
        let tr = Trivia { category: "Anime", streak: "Streak 4", question: "In Spirited Away, what is the name of the girl who works at the bathhouse?", answers: &answers, seconds: 20, result: Some((0, Some(1))), headline: "Wrong", small: "" };
        assert!(!trivia(&tr, true).unwrap().1);
        let cards: Vec<usize> = (0..8).chain(0..8).collect();
        let m = Memory { cards: &cards, found: &[0, 8], open: &[3, 5], fresh: &[3], mistakes: 2, streak: 2, best: 2, pays: "2x", headline: "No match", small: "x", end: None };
        assert!(memory(&m, true).unwrap().1 && !memory(&m, false).unwrap().1);
        let p = Pong { left: "You", right: "Good Boy", score: (3, 2), paddles: (1, 0), shot: Some((true, 0, true, Landed::Scored)), headline: "Smash!", small: "", over: false };
        assert!(pong(&p, true).unwrap().1);
        let _ = strip("x", true);
    }
}
