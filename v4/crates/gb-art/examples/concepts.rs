//! Concept pictures for the redesigned arcade games (ideas to look at, not the finished games):
//! `cargo run --release -p gb-art --example concepts -- <folder>`.
use gb_art::png;

const W: f32 = 640.0;
fn open(h: f32, bg: &str) -> String {
    format!(r##"<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{h}" viewBox="0 0 {W} {h}"><rect width="{W}" height="{h}" rx="20" fill="{bg}"/>"##)
}
fn t(x: f32, y: f32, size: f32, fill: &str, anchor: &str, font: &str, s: &str) -> String {
    let s = s.replace('&', "&amp;").replace('<', "&lt;");
    format!(r##"<text x="{x}" y="{y}" font-family="'GB {font}', sans-serif" font-size="{size}" fill="{fill}" text-anchor="{anchor}">{s}</text>"##)
}
fn chip(x: f32, y: f32, w: f32, label: &str, fill: &str, ink: &str) -> String {
    format!(r##"<rect x="{x}" y="{y}" width="{w}" height="34" rx="9" fill="{fill}"/>{}"##, t(x + w / 2.0, y + 23.0, 17.0, ink, "middle", "Figtree 700", label))
}
fn pup(cx: f32, cy: f32, k: f32, worried: bool) -> String {
    format!(r##"<g transform="translate({cx} {cy}) scale({k})"><ellipse cx="-30" cy="-6" rx="13" ry="24" fill="#8a5a2b" transform="rotate(18 -30 -6)"/><ellipse cx="30" cy="-6" rx="13" ry="24" fill="#8a5a2b" transform="rotate(-18 30 -6)"/><circle r="34" fill="#f2d2a2"/><ellipse cx="0" cy="12" rx="17" ry="13" fill="#fff4e0"/><circle cx="-12" cy="-6" r="5" fill="#2a1a10"/><circle cx="12" cy="-6" r="5" fill="#2a1a10"/><ellipse cx="0" cy="6" rx="6" ry="4.5" fill="#2a1a10"/>{}</g>"##,
        if worried { r##"<path d="M-8 20 q8 -7 16 0" stroke="#2a1a10" stroke-width="3" fill="none" stroke-linecap="round"/>"## } else { r##"<path d="M-8 16 q8 8 16 0" stroke="#2a1a10" stroke-width="3" fill="none" stroke-linecap="round"/><ellipse cx="0" cy="22" rx="5" ry="6" fill="#ff7a8a"/>"## })
}

/// Hangman, redone as "Balloon Rescue": the word's blanks, the letters tried, and balloons instead of a gallows.
fn hangman() -> String {
    let h = 400.0;
    let mut s = open(h, "#1b2440");
    s += r##"<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b5bdb"/><stop offset="1" stop-color="#1b2440"/></linearGradient></defs><rect width="640" height="230" rx="20" fill="url(#sky)"/>"##;
    s += &chip(18.0, 16.0, 150.0, "Balloon Rescue", "#00000066", "#ffffff");
    s += &chip(472.0, 16.0, 150.0, "Category: Food", "#00000066", "#ffe08a");
    // balloons: four left, two popped
    let colors = ["#ff5d73", "#ffb12e", "#4dd0a1", "#5fb8ff", "#c08bff", "#ff8ad1"];
    for (k, c) in colors.iter().enumerate() {
        let x = 110.0 + k as f32 * 34.0;
        if k < 4 {
            s += &format!(r##"<path d="M{x} 108 L150 172" stroke="#ffffff" stroke-opacity="0.6" stroke-width="1.5"/><ellipse cx="{x}" cy="78" rx="19" ry="25" fill="{c}"/><ellipse cx="{}" cy="68" rx="5" ry="8" fill="#ffffff" fill-opacity="0.45"/>"##, x - 6.0);
        } else {
            s += &format!(r##"<g stroke="{c}" stroke-width="3" stroke-linecap="round"><path d="M{0} 70 l-9 -9 M{0} 70 l9 -9 M{0} 70 l-12 3 M{0} 70 l12 3 M{0} 70 l0 12"/></g>"##, x + 30.0);
        }
    }
    s += &pup(150.0, 192.0, 0.62, true);
    s += &t(420.0, 96.0, 18.0, "#dbe4ff", "middle", "Figtree 600", "4 balloons left");
    s += &t(420.0, 126.0, 30.0, "#ffffff", "middle", "Display 800", "Win 2.4x");
    s += &t(420.0, 152.0, 15.0, "#b9c6f5", "middle", "Figtree 600", "pays more with every balloon you keep");
    // the blanks
    let word = ['P', '_', 'N', 'C', '_', 'K', 'E'];
    let x0 = (W - word.len() as f32 * 62.0) / 2.0;
    for (k, c) in word.iter().enumerate() {
        let x = x0 + k as f32 * 62.0;
        s += &format!(r##"<rect x="{}" y="246" width="52" height="62" rx="10" fill="{}"/><rect x="{}" y="300" width="36" height="4" rx="2" fill="#ffffff" fill-opacity="{}"/>"##, x, if *c == '_' { "#26315a" } else { "#33407a" }, x + 8.0, if *c == '_' { "0.9" } else { "0" });
        if *c != '_' { s += &t(x + 26.0, 291.0, 40.0, "#ffffff", "middle", "Display 800", &c.to_string()); }
    }
    // letters tried
    let tried = [('E', true), ('A', false), ('N', true), ('S', false), ('K', true), ('C', true), ('P', true)];
    s += &t(24.0, 348.0, 15.0, "#b9c6f5", "start", "Figtree 700", "TRIED");
    for (k, (c, ok)) in tried.iter().enumerate() {
        let x = 86.0 + k as f32 * 42.0;
        s += &format!(r##"<rect x="{x}" y="326" width="34" height="34" rx="8" fill="{}"/>{}"##, if *ok { "#2f9e62" } else { "#c2374a" }, t(x + 17.0, 350.0, 19.0, "#ffffff", "middle", "Figtree 700", &c.to_string()));
    }
    s += &t(24.0, 386.0, 14.0, "#8fa0d8", "start", "Figtree 600", "Guess a letter opens a box to type one letter, or the whole word for a bonus.");
    s + "</svg>"
}

/// Tower, redone as "Treasure Climb".
fn tower() -> String {
    let h = 452.0;
    let mut s = open(h, "#15131f");
    s += &chip(18.0, 16.0, 150.0, "Treasure Climb", "#ffffff22", "#ffffff");
    let mults = ["1.45x", "2.1x", "3.05x", "4.42x", "6.41x", "9.29x", "13.5x", "19.5x"];
    for f in 0..8 {
        let y = 372.0 - f as f32 * 44.0;
        let (done, here) = (f < 3, f == 3);
        s += &format!(r##"<rect x="150" y="{y}" width="300" height="38" rx="8" fill="{}" stroke="{}" stroke-width="2"/>"##, if here { "#3a3360" } else if done { "#1f3a2c" } else { "#221f33" }, if here { "#ffd93b" } else { "#00000000" });
        for d in 0..3 {
            let x = 176.0 + d as f32 * 92.0;
            let picked = done && d == [1, 0, 2][f.min(2)];
            s += &format!(r##"<path d="M{x} {} v-18 a16 16 0 0 1 32 0 v18z" fill="{}"/>"##, y + 34.0, if picked { "#4dd0a1" } else if here { "#8f7cf7" } else { "#3b3655" });
            if picked { s += &format!(r##"<circle cx="{}" cy="{}" r="5" fill="#ffd93b"/>"##, x + 16.0, y + 20.0); }
            if here { s += &t(x + 16.0, y + 28.0, 15.0, "#ffffff", "middle", "Figtree 700", &(d + 1).to_string()); }
        }
        s += &t(476.0, y + 25.0, 17.0, if here { "#ffd93b" } else if done { "#4dd0a1" } else { "#77738f" }, "start", "Figtree 700", mults[f]);
        s += &t(128.0, y + 25.0, 15.0, "#77738f", "end", "Figtree 600", &format!("Floor {}", f + 1));
    }
    s += r##"<polygon points="300,20 360,62 240,62" fill="#ffd93b"/><rect x="286" y="34" width="28" height="22" rx="4" fill="#b8860b"/>"##;
    s += &pup(566.0, 250.0, 0.5, false);
    s += &t(566.0, 300.0, 15.0, "#b9b4d8", "middle", "Figtree 600", "Floor 4");
    s += &chip(488.0, 316.0, 144.0, "Cash out 3.05x", "#2f9e62", "#ffffff");
    s += &t(320.0, 438.0, 14.0, "#8d88ad", "middle", "Figtree 600", "One door on each floor is trapped. Floor 5 has a golden door: double or nothing.");
    s + "</svg>"
}

/// Wires, redone as "Bomb Squad".
fn wires() -> String {
    let h = 360.0;
    let mut s = open(h, "#1a1d21");
    s += &chip(18.0, 16.0, 130.0, "Bomb Squad", "#ffffff22", "#ffffff");
    s += r##"<rect x="60" y="70" width="520" height="210" rx="18" fill="#2b3036" stroke="#454c55" stroke-width="3"/><rect x="250" y="88" width="140" height="56" rx="8" fill="#0b0d0f"/>"##;
    s += &t(320.0, 130.0, 40.0, "#ff4d4d", "middle", "Display 800", "00:12");
    let wires = [("#e0263c", false), ("#3b82f6", true), ("#ffd93b", false), ("#2ecc71", true), ("#c08bff", false)];
    for (k, (c, cut)) in wires.iter().enumerate() {
        let x = 120.0 + k as f32 * 100.0;
        if *cut {
            s += &format!(r##"<path d="M{x} 160 v38" stroke="{c}" stroke-width="10" stroke-linecap="round"/><path d="M{x} 232 v36" stroke="{c}" stroke-width="10" stroke-linecap="round"/><circle cx="{x}" cy="215" r="13" fill="#2f9e62"/>{}"##, t(x, 221.0, 16.0, "#ffffff", "middle", "Figtree 700", "✓"));
        } else {
            s += &format!(r##"<path d="M{x} 160 q14 54 0 108" stroke="{c}" stroke-width="10" fill="none" stroke-linecap="round"/>"##);
        }
        s += &format!(r##"<circle cx="{x}" cy="160" r="9" fill="#11151a"/><circle cx="{x}" cy="268" r="9" fill="#11151a"/>"##);
    }
    s += &t(320.0, 312.0, 22.0, "#ffffff", "middle", "Figtree 700", "2 safe cuts · cash out 1.6x · next cut pays 2.4x");
    s += &t(320.0, 340.0, 14.0, "#8b94a0", "middle", "Figtree 600", "One wire is the bomb. A sniffer hint (once per game) rules one wire out.");
    s + "</svg>"
}

/// Bingo with balls dropping.
fn bingo() -> String {
    let h = 400.0;
    let mut s = open(h, "#1c1730");
    s += &chip(18.0, 16.0, 90.0, "Bingo", "#ffffff22", "#ffffff");
    let card = [[4, 17, 9, 12], [20, 7, 15, 2], [11, 19, 6, 14], [1, 13, 18, 8]];
    let hit = [17, 7, 19, 13, 9, 6];
    for (r, row) in card.iter().enumerate() {
        for (c, n) in row.iter().enumerate() {
            let (x, y) = (40.0 + c as f32 * 76.0, 70.0 + r as f32 * 76.0);
            let on = hit.contains(n);
            let line = c == 1;
            s += &format!(r##"<rect x="{x}" y="{y}" width="68" height="68" rx="12" fill="{}" stroke="{}" stroke-width="3"/>"##, if on { "#7c4dff" } else { "#2a2444" }, if line { "#ffd93b" } else { "#00000000" });
            s += &t(x + 34.0, y + 45.0, 28.0, if on { "#ffffff" } else { "#8c84b8" }, "middle", "Display 800", &n.to_string());
        }
    }
    s += &t(500.0, 96.0, 16.0, "#b9b0e8", "middle", "Figtree 700", "DRAWN 6 OF 10");
    for (k, n) in hit.iter().enumerate() {
        let (x, y) = (430.0 + (k % 3) as f32 * 70.0, 140.0 + (k / 3) as f32 * 70.0);
        s += &format!(r##"<circle cx="{x}" cy="{y}" r="28" fill="{}"/><circle cx="{}" cy="{}" r="8" fill="#ffffff" fill-opacity="0.35"/>{}"##, ["#ff5d73", "#ffb12e", "#4dd0a1", "#5fb8ff", "#c08bff", "#ff8ad1"][k], x - 9.0, y - 10.0, t(x, y + 9.0, 24.0, "#ffffff", "middle", "Display 800", &n.to_string()));
    }
    s += &t(500.0, 300.0, 26.0, "#ffd93b", "middle", "Display 800", "BINGO! 3x");
    s += &t(500.0, 326.0, 15.0, "#b9b0e8", "middle", "Figtree 600", "a line in 6 draws");
    s += &t(320.0, 386.0, 14.0, "#8c84b8", "middle", "Figtree 600", "Balls drop one by one. A line sooner pays more; two lines pays double.");
    s + "</svg>"
}

/// Memory with a combo streak.
fn memory() -> String {
    let h = 400.0;
    let mut s = open(h, "#12202a");
    s += &chip(18.0, 16.0, 100.0, "Memory", "#ffffff22", "#ffffff");
    s += &chip(500.0, 16.0, 122.0, "Combo ×3", "#ffb12e", "#2a1a00");
    let faces = ["★", "", "♥", "", "", "♦", "", "♥", "", "", "", "★", "♦", "", "", ""];
    let colors = ["#ffd93b", "", "#ff5d73", "", "", "#5fb8ff", "", "#ff5d73", "", "", "", "#ffd93b", "#5fb8ff", "", "", ""];
    for k in 0..16 {
        let (x, y) = (70.0 + (k % 4) as f32 * 126.0, 66.0 + (k / 4) as f32 * 76.0);
        if faces[k].is_empty() {
            s += &format!(r##"<rect x="{x}" y="{y}" width="112" height="64" rx="12" fill="#1f6f8a"/><rect x="{}" y="{}" width="96" height="48" rx="8" fill="none" stroke="#7fd3ea" stroke-opacity="0.5" stroke-width="2" stroke-dasharray="6 5"/>{}"##, x + 8.0, y + 8.0, t(x + 56.0, y + 41.0, 18.0, "#d6f4fb", "middle", "Figtree 700", &(k + 1).to_string()));
        } else {
            s += &format!(r##"<rect x="{x}" y="{y}" width="112" height="64" rx="12" fill="#f6fbfd"/>{}"##, t(x + 56.0, y + 46.0, 40.0, colors[k], "middle", "Display 800", faces[k]));
        }
    }
    s += &t(320.0, 386.0, 14.0, "#86a7b5", "middle", "Figtree 600", "Pick two numbers. Matches in a row build a combo that raises the payout.");
    s + "</svg>"
}

/// Trivia with a timer and a streak.
fn trivia() -> String {
    let h = 360.0;
    let mut s = open(h, "#1d1730");
    s += &chip(18.0, 16.0, 90.0, "Trivia", "#ffffff22", "#ffffff");
    s += &chip(120.0, 16.0, 110.0, "Anime", "#7c4dff", "#ffffff");
    s += &chip(492.0, 16.0, 130.0, "Streak 4 · 2x", "#ffb12e", "#2a1a00");
    s += r##"<rect x="40" y="66" width="560" height="10" rx="5" fill="#2b2444"/><rect x="40" y="66" width="340" height="10" rx="5" fill="#4dd0a1"/>"##;
    s += &t(600.0, 96.0, 15.0, "#b9b0e8", "end", "Figtree 700", "12 seconds left");
    s += &t(320.0, 142.0, 25.0, "#ffffff", "middle", "Display 700", "Which studio animated the first season");
    s += &t(320.0, 174.0, 25.0, "#ffffff", "middle", "Display 700", "of Attack on Titan?");
    let answers = [("A", "Wit Studio", "#3b82f6"), ("B", "MAPPA", "#e0263c"), ("C", "Bones", "#f59f00"), ("D", "Madhouse", "#2f9e62")];
    for (k, (l, a, c)) in answers.iter().enumerate() {
        let (x, y) = (40.0 + (k % 2) as f32 * 286.0, 206.0 + (k / 2) as f32 * 66.0);
        s += &format!(r##"<rect x="{x}" y="{y}" width="274" height="54" rx="12" fill="{c}"/><circle cx="{}" cy="{}" r="17" fill="#00000033"/>{}{}"##, x + 30.0, y + 27.0, t(x + 30.0, y + 34.0, 20.0, "#ffffff", "middle", "Display 800", l), t(x + 60.0, y + 34.0, 20.0, "#ffffff", "start", "Figtree 700", a));
    }
    s += &t(320.0, 348.0, 14.0, "#8c84b8", "middle", "Figtree 600", "Answer faster for more. Keep a streak going and each right answer pays more.");
    s + "</svg>"
}

/// Pong, redone as a two-player rally.
fn pong() -> String {
    let h = 380.0;
    let mut s = open(h, "#0d1b1e");
    s += &chip(18.0, 16.0, 120.0, "Paddle Duel", "#ffffff22", "#ffffff");
    s += r##"<rect x="40" y="66" width="560" height="240" rx="14" fill="#11343a" stroke="#2a6c75" stroke-width="3"/><path d="M320 70 v232" stroke="#2a6c75" stroke-width="3" stroke-dasharray="10 8"/>"##;
    for (k, y) in [106.0f32, 186.0, 266.0].iter().enumerate() {
        s += &t(52.0, *y + 5.0, 13.0, "#4f9aa5", "start", "Figtree 700", ["TOP", "MIDDLE", "BOTTOM"][k]);
    }
    s += r##"<rect x="122" y="150" width="14" height="72" rx="7" fill="#5fb8ff"/><rect x="562" y="70" width="14" height="72" rx="7" fill="#ff8ad1"/>"##;
    s += r##"<path d="M146 186 Q270 90 400 150" stroke="#ffffff" stroke-opacity="0.35" stroke-width="3" stroke-dasharray="4 8" fill="none"/><circle cx="400" cy="150" r="11" fill="#ffffff"/><circle cx="380" cy="142" r="8" fill="#ffffff" fill-opacity="0.4"/><circle cx="362" cy="136" r="6" fill="#ffffff" fill-opacity="0.2"/>"##;
    s += &t(230.0, 52.0, 26.0, "#5fb8ff", "middle", "Display 800", "You 3");
    s += &t(460.0, 52.0, 26.0, "#ff8ad1", "middle", "Display 800", "2 Rowan");
    s += &t(320.0, 338.0, 18.0, "#ffffff", "middle", "Figtree 700", "The ball is coming to Rowan: Top, Middle or Bottom?");
    s += &t(320.0, 364.0, 14.0, "#6fa7b0", "middle", "Figtree 600", "Guess where it lands to return it. A smash is harder to return but can miss. First to 5.");
    s + "</svg>"
}

fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    for (name, svg) in [("hangman", hangman()), ("tower", tower()), ("wires", wires()), ("bingo", bingo()), ("memory", memory()), ("trivia", trivia()), ("pong", pong())] {
        std::fs::write(format!("{dir}/{name}.png"), png(&svg).expect("drawn")).expect("saved");
    }
}
