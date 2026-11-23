//! The arcade: Treasure Climb (tower), Bomb Squad (wires), Bingo, Memory, Balloon Rescue (hangman), Trivia and
//! Paddle Duel (pong), plus the `/arcade` panel. The odds of Tower, Wires, Memory, Hangman and Trivia start from
//! Good Boy 3's; each game then gets something new: a golden door, a sniffer, a bigger bingo card with falling balls,
//! memory combos, hints and whole-word bonuses, answer streaks, and a two-player rally.
//!
//! A game is one saved session per player (`ar:<game>:<user>`), so a restart loses nothing. Bets are taken when a
//! game starts and paid when it ends. Buttons: `ar:<game>:<user>:<action>`. Paddle Duel: `pg:<session>:<action>`.

use crate::arcade_data::pool;
use crate::bot::{CommandSpec, Opt, Takes};
use crate::card::group;
use crate::casino::{private, Games};
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Field, FieldKind, FormEvent, Member};
use gb_art::arcade as art;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

type Rng<'a> = &'a mut dyn FnMut(u32) -> u32;

const BET: Opt = Opt { name: "bet", about: "How many coins (500, 2.5k, half, all)", takes: Takes::Text, required: true };
pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec { name: "tower", about: "Treasure Climb: pick doors, climb 8 floors, cash out any time", module: crate::casino::MODULE, options: &[BET], subs: &[] },
    CommandSpec { name: "wires", about: "Bomb Squad: cut the safe wires, one is the bomb", module: crate::casino::MODULE, options: &[BET], subs: &[] },
    CommandSpec { name: "bingo", about: "Bingo: balls drop, a line sooner pays more", module: crate::casino::MODULE, options: &[BET], subs: &[] },
    CommandSpec { name: "memory", about: "Memory: match the pairs, combos pay more", module: crate::casino::MODULE, options: &[BET], subs: &[] },
    CommandSpec { name: "hangman", about: "Balloon Rescue: guess the word before the balloons pop", module: crate::casino::MODULE, options: &[BET], subs: &[] },
    CommandSpec { name: "trivia", about: "Trivia: answer in 20 seconds, streaks pay more", module: crate::casino::MODULE, options: &[BET, Opt { name: "category", about: "What kind of question", takes: Takes::Choice(&[("Anything", "any"), ("General", "general"), ("Science", "science"), ("Geography", "geography"), ("Games", "games"), ("Anime", "anime"), ("History", "history"), ("Animals", "animals"), ("Food & Drink", "food"), ("Tech", "tech"), ("Sports", "sports"), ("Music", "music"), ("Movies & TV", "movies"), ("Language", "language"), ("Math", "math")]), required: false }], subs: &[] },
    CommandSpec { name: "pong", about: "Paddle Duel: a rally against Good Boy or another member", module: crate::casino::MODULE, options: &[Opt { name: "opponent", about: "Who to challenge (leave empty to play Good Boy)", takes: Takes::Member, required: false }], subs: &[] },
    CommandSpec { name: "arcade", about: "(Admins) Post a game panel in this channel that anyone can use", module: crate::casino::MODULE, options: &[], subs: &[] },
];
/// (id, emoji, name, one line about it).
pub const MINI: &[(&str, &str, &str, &str)] = &[
    ("tower", "🗼", "Treasure Climb", "climb 8 floors, up to 19.54x"),
    ("wires", "💣", "Bomb Squad", "cut the safe wires, up to 4.8x"),
    ("bingo", "🔢", "Bingo", "a line in 4 draws pays 20x"),
    ("memory", "🃏", "Memory", "match the pairs, up to 2.5x"),
    ("hangman", "🎈", "Balloon Rescue", "guess the word, up to 2.7x"),
    ("trivia", "❓", "Trivia", "answer fast, streaks pay up to 2.1x"),
];
const SESSION_MS: i64 = 10 * 60_000;
fn mini(game: &str) -> (&'static str, &'static str, &'static str, &'static str) {
    MINI.iter().copied().find(|m| m.0 == game).unwrap_or(("", "🕹️", "Game", ""))
}
/// A bet times a multiplier, in whole coins (9.29 x 100 is 929, not the 928 a computer's fractions would give).
pub fn pays(bet: i64, mult: f64) -> i64 {
    (bet as f64 * mult + 1e-6).floor() as i64
}
fn round2(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}
fn shuffle<T>(list: &mut [T], rng: Rng) {
    for k in (1..list.len()).rev() {
        list.swap(k, rng(k as u32 + 1) as usize);
    }
}

// ------------------------------------------------------------------ Treasure Climb
pub const TOWER_FLOORS: usize = 8;
pub const GOLDEN_FLOOR: usize = 4;
/// The golden door opens this often (out of 100). It skips a floor, so it pays 2.1 times: a little under fair.
pub const GOLDEN_CHANCE: u32 = 46;
/// What cashing out pays after `floor` safe floors (a 2 in 3 chance each, so 1.5x is fair; this pays 1.45x).
pub fn tower_mult(floor: usize) -> f64 {
    round2(1.45f64.powi(floor as i32))
}
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Tower {
    pub bet: i64,
    pub at: i64,
    pub floor: usize,
    pub traps: Vec<usize>,
    pub picks: Vec<usize>,
    pub status: String,
}
pub fn tower_start(bet: i64, at: i64, rng: Rng) -> Tower {
    Tower { bet, at, floor: 0, traps: (0..TOWER_FLOORS).map(|_| rng(3) as usize).collect(), picks: Vec::new(), status: "climbing".into() }
}
pub fn tower_pick(s: &mut Tower, door: usize) {
    if s.status != "climbing" || door > 2 { return; }
    s.picks.push(door);
    if s.traps.get(s.floor) == Some(&door) { s.status = "trapped".into(); return; }
    s.floor += 1;
    if s.floor >= TOWER_FLOORS { s.status = "top".into(); }
}
pub fn tower_can_golden(s: &Tower) -> bool {
    s.status == "climbing" && s.floor == GOLDEN_FLOOR
}
/// The golden door: two floors at once, or the climb ends.
pub fn tower_golden(s: &mut Tower, lucky: bool) {
    if !tower_can_golden(s) { return; }
    s.picks.push(art::GOLDEN);
    if !lucky { s.status = "trapped".into(); return; }
    s.picks.push(art::GOLDEN);
    s.floor += 2;
}

// ------------------------------------------------------------------ Bomb Squad
pub const WIRES: [&str; 5] = ["🔴", "🔵", "🟢", "🟡", "🟣"];
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Wires {
    pub bet: i64,
    pub at: i64,
    pub bomb: usize,
    pub cut: Vec<usize>,
    pub sniffed: Option<usize>,
    /// What a fair game would pay so far.
    pub fair: f64,
    pub status: String,
}
impl Wires {
    /// Wires nobody knows anything about yet (the bomb is one of them).
    pub fn unknown(&self) -> usize {
        WIRES.len() - self.cut.len() - usize::from(self.sniffed.is_some())
    }
    pub fn safe_cuts(&self) -> usize {
        self.cut.len() - usize::from(self.status == "boom")
    }
}
pub fn wires_start(bet: i64, at: i64, rng: Rng) -> Wires {
    Wires { bet, at, bomb: rng(WIRES.len() as u32) as usize, cut: Vec::new(), sniffed: None, fair: 1.0, status: "cutting".into() }
}
/// Cashing out pays 96% of fair. With no cuts it is the bet back.
pub fn wires_mult(s: &Wires) -> f64 {
    if s.safe_cuts() == 0 { 1.0 } else { round2(s.fair * 0.96) }
}
pub fn wires_next(s: &Wires) -> f64 {
    let u = s.unknown() as f64;
    if u < 2.0 { wires_mult(s) } else { round2(s.fair * u / (u - 1.0) * 0.96) }
}
pub fn wires_cut(s: &mut Wires, wire: usize) {
    if s.status != "cutting" || wire >= WIRES.len() || s.cut.contains(&wire) || s.sniffed == Some(wire) { return; }
    let u = s.unknown() as f64;
    s.cut.push(wire);
    if wire == s.bomb { s.status = "boom".into(); return; }
    s.fair *= u / (u - 1.0);
    if s.unknown() <= 1 { s.status = "cleared".into(); }
}
pub fn wires_can_sniff(s: &Wires) -> bool {
    s.status == "cutting" && s.sniffed.is_none() && s.unknown() >= 3
}
/// Good Boy sniffs out one safe wire and sets it aside. It is not a cut, so it changes no odds and pays nothing.
pub fn wires_sniff(s: &mut Wires, pick: u32) {
    if !wires_can_sniff(s) { return; }
    let safe: Vec<usize> = (0..WIRES.len()).filter(|w| *w != s.bomb && !s.cut.contains(w)).collect();
    s.sniffed = Some(safe[pick as usize % safe.len()]);
}

// ------------------------------------------------------------------ Bingo
pub const BINGO_POOL: u32 = 20;
pub const BINGO_DRAWS: usize = 10;
const BINGO_LINES: [[usize; 4]; 10] = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15], [0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15], [0, 5, 10, 15], [3, 6, 9, 12]];
/// Pays by the draw that finished the first line (about 95% back on average; see the test).
pub fn bingo_mult(draws: usize) -> f64 {
    match draws { 0 => 0.0, 1..=4 => 20.0, 5 => 8.0, 6 => 5.0, 7 => 3.5, 8 => 2.5, 9 => 2.1, 10 => 1.4, _ => 0.0 }
}
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Bingo {
    pub bet: i64,
    pub at: i64,
    pub card: Vec<u32>,
    pub order: Vec<u32>,
    pub drawn: usize,
    pub status: String,
}
pub fn bingo_start(bet: i64, at: i64, rng: Rng) -> Bingo {
    let mut card: Vec<u32> = (1..=BINGO_POOL).collect();
    shuffle(&mut card, rng);
    card.truncate(16);
    let mut order: Vec<u32> = (1..=BINGO_POOL).collect();
    shuffle(&mut order, rng);
    order.truncate(BINGO_DRAWS);
    Bingo { bet, at, card, order, drawn: 0, status: "drawing".into() }
}
/// The finished lines.
pub fn bingo_lines(s: &Bingo) -> Vec<[usize; 4]> {
    let hit = &s.order[..s.drawn.min(s.order.len())];
    BINGO_LINES.iter().copied().filter(|l| l.iter().all(|k| hit.contains(&s.card[*k]))).collect()
}
pub fn bingo_draw(s: &mut Bingo) {
    if s.status != "drawing" { return; }
    s.drawn += 1;
    if !bingo_lines(s).is_empty() { s.status = "bingo".into(); } else if s.drawn >= BINGO_DRAWS { s.status = "out".into(); }
}
/// What a finished card pays: two lines at once pay double.
pub fn bingo_pays(s: &Bingo) -> f64 {
    if s.status != "bingo" { return 0.0; }
    bingo_mult(s.drawn) * if bingo_lines(s).len() > 1 { 2.0 } else { 1.0 }
}

// ------------------------------------------------------------------ Memory
pub const MEMORY_FACES: [&str; 8] = ["🐶", "🐱", "🦊", "🐸", "🐙", "🦋", "🍕", "⭐"];
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Memory {
    pub bet: i64,
    pub at: i64,
    pub cards: Vec<usize>,
    pub found: Vec<usize>,
    pub open: Vec<usize>,
    pub mistakes: u32,
    /// Matches in a row right now, and the best run this game.
    pub streak: u32,
    pub best: u32,
    pub status: String,
}
pub fn memory_start(bet: i64, at: i64, rng: Rng) -> Memory {
    let mut cards: Vec<usize> = (0..8).chain(0..8).collect();
    shuffle(&mut cards, rng);
    Memory { bet, at, cards, status: "playing".into(), ..Default::default() }
}
/// Good Boy 3's table by mistakes, plus a bonus for the best run of matches in a row.
pub fn memory_mult(mistakes: u32, best: u32) -> f64 {
    let base = if mistakes <= 6 { 2.0 } else if mistakes <= 10 { 1.4 } else if mistakes <= 14 { 1.0 } else { 0.0 };
    if base == 0.0 { 0.0 } else { round2(base + if best >= 5 { 0.5 } else if best >= 3 { 0.2 } else { 0.0 }) }
}
/// Flips a card. Two open cards that don't match turn back over on the next flip.
pub fn memory_flip(s: &mut Memory, k: usize) {
    if s.status != "playing" || k >= s.cards.len() || s.found.contains(&k) { return; }
    if s.open.len() == 2 { s.open.clear(); }
    if s.open.contains(&k) { return; }
    s.open.push(k);
    if s.open.len() == 2 {
        let (a, b) = (s.open[0], s.open[1]);
        if s.cards[a] == s.cards[b] {
            s.found.extend([a, b]);
            s.open.clear();
            s.streak += 1;
            s.best = s.best.max(s.streak);
            if s.found.len() == s.cards.len() { s.status = "done".into(); }
        } else {
            s.mistakes += 1;
            s.streak = 0;
        }
    }
}

// ------------------------------------------------------------------ Balloon Rescue
pub const HANGMAN_LIVES: u32 = 6;
/// Good Boy 3's words, sorted into categories so the player gets a clue.
pub const HANGMAN_WORDS: &[(&str, &[&str])] = &[
    ("Animals", &["puppy", "penguin", "dolphin", "octopus", "hamster", "giraffe", "kangaroo", "squirrel"]),
    ("Food", &["biscuit", "pancake", "sandwich", "popcorn", "pretzel", "cupcake", "avocado", "pineapple", "cookie"]),
    ("Nature", &["volcano", "thunder", "rainbow", "island", "jungle", "garden", "meadow", "glacier", "tornado", "cactus", "blizzard", "snowflake", "waterfall", "horizon", "sunrise", "midnight"]),
    ("Space", &["galaxy", "rocket", "planet", "telescope", "satellite", "spaceship", "meteor", "comet", "nebula", "eclipse"]),
    ("Fantasy", &["treasure", "kingdom", "castle", "dragon", "wizard", "pirate", "knight", "goblin", "phoenix", "unicorn", "mermaid", "vampire", "zombie", "robot", "adventure", "mystery"]),
    ("Things", &["lantern", "compass", "blanket", "mirror", "candle", "whistle", "firework", "keyboard", "headphones", "backpack", "skateboard", "notebook", "umbrella", "campfire", "microscope", "submarine", "helicopter", "puzzle", "pyramid"]),
    ("Places", &["harbour", "lighthouse", "library", "museum", "carnival", "festival"]),
    ("Music and art", &["orchestra", "guitar", "trumpet", "violin", "drummer", "painter", "sculpture"]),
    ("Treasures", &["diamond", "emerald", "sapphire", "crystal", "marble", "velvet"]),
];
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Hangman {
    pub bet: i64,
    pub at: i64,
    pub word: String,
    pub category: String,
    /// Letters tried, in order.
    pub guessed: Vec<char>,
    pub wrong: u32,
    /// Extra for guessing the whole word early.
    pub bonus: f64,
    pub status: String,
}
pub fn hangman_start(bet: i64, at: i64, rng: Rng) -> Hangman {
    let total: usize = HANGMAN_WORDS.iter().map(|c| c.1.len()).sum();
    let mut k = rng(total as u32) as usize;
    let (mut category, mut word) = ("", "");
    for (c, words) in HANGMAN_WORDS {
        if k < words.len() { category = c; word = words[k]; break; }
        k -= words.len();
    }
    Hangman { bet, at, word: word.into(), category: category.into(), status: "guessing".into(), ..Default::default() }
}
/// Pays more for fewer popped balloons (Good Boy 3's numbers), plus the whole-word bonus.
pub fn hangman_mult(s: &Hangman) -> f64 {
    round2(1.3 + (HANGMAN_LIVES - s.wrong.min(HANGMAN_LIVES)) as f64 * 0.15 + s.bonus)
}
fn hidden(s: &Hangman) -> Vec<char> {
    let mut left: Vec<char> = s.word.chars().filter(|c| !s.guessed.contains(c)).collect();
    left.sort_unstable();
    left.dedup();
    left
}
/// A letter, or a guess at the whole word (a wrong word pops two balloons). Returns what to tell the player and how
/// many balloons popped.
pub fn hangman_guess(s: &mut Hangman, raw: &str) -> (String, u32) {
    let g = raw.trim().to_lowercase();
    if s.status != "guessing" { return (String::new(), 0); }
    if g.is_empty() || !g.chars().all(|c| c.is_ascii_lowercase()) { return ("Use letters only.".into(), 0); }
    if g.len() > 1 {
        if g == s.word {
            // guessing the word with letters still hidden earns a little more
            s.bonus = (hidden(s).len() as f64 * 0.1).min(0.5);
            s.status = "won".into();
            return ("You got the word!".into(), 0);
        }
        let before = s.wrong;
        s.wrong = (s.wrong + 2).min(HANGMAN_LIVES);
        if s.wrong >= HANGMAN_LIVES { s.status = "lost".into(); }
        return (format!("It isn't \"{g}\"."), s.wrong - before);
    }
    let c = g.chars().next().unwrap_or('a');
    if s.guessed.contains(&c) { return (format!("You already tried {}.", c.to_ascii_uppercase()), 0); }
    s.guessed.push(c);
    if !s.word.contains(c) {
        s.wrong += 1;
        if s.wrong >= HANGMAN_LIVES { s.status = "lost".into(); }
        return (format!("No {}.", c.to_ascii_uppercase()), 1);
    }
    if hidden(s).is_empty() { s.status = "won".into(); }
    let many = s.word.matches(c).count();
    (format!("Yes, there {} {}!", if many > 1 { format!("are {many}") } else { "is one".to_string() }, c.to_ascii_uppercase()), 0)
}
pub fn hangman_can_hint(s: &Hangman) -> bool {
    s.status == "guessing" && s.wrong + 1 < HANGMAN_LIVES && hidden(s).len() > 1
}
/// A hint shows one hidden letter and costs a balloon.
pub fn hangman_hint(s: &mut Hangman, pick: u32) -> Option<char> {
    if !hangman_can_hint(s) { return None; }
    let left = hidden(s);
    let c = left[pick as usize % left.len()];
    s.guessed.push(c);
    s.wrong += 1;
    Some(c)
}

// ------------------------------------------------------------------ Trivia
pub const TRIVIA_MS: i64 = 20_000;
/// A little slack for the time a press takes to arrive.
const TRIVIA_GRACE_MS: i64 = 2_000;
const TRIVIA_FAST_MS: i64 = 7_000;
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Trivia {
    pub bet: i64,
    pub at: i64,
    pub cat: String,
    /// The category asked for ("any" keeps picking from all of them).
    pub wanted: String,
    pub q: String,
    pub answers: Vec<String>,
    pub right: usize,
    pub pick: Option<usize>,
    pub status: String,
}
pub fn trivia_label(cat: &str) -> &'static str {
    pool().iter().find(|c| c.id == cat).map(|c| c.label).unwrap_or("Anything")
}
pub fn trivia_start(bet: i64, at: i64, wanted: &str, rng: Rng) -> Trivia {
    let all = pool();
    let cats: Vec<_> = all.iter().filter(|c| c.id == wanted).collect();
    // "any" picks a question from the whole pool, so a big category turns up more often than a small one
    let (cat, row) = if cats.is_empty() {
        let total: usize = all.iter().map(|c| c.rows.len()).sum();
        let mut n = rng(total as u32) as usize;
        let c = all.iter().find(|c| { if n < c.rows.len() { true } else { n -= c.rows.len(); false } }).unwrap_or(&all[0]);
        (c.id, c.rows[n.min(c.rows.len() - 1)])
    } else {
        (cats[0].id, cats[0].rows[rng(cats[0].rows.len() as u32) as usize])
    };
    let mut order = [1usize, 2, 3, 4];
    shuffle(&mut order, rng);
    Trivia { bet, at, cat: cat.into(), wanted: wanted.into(), q: row[0].into(), answers: order.iter().map(|k| row[*k].to_string()).collect(), right: order.iter().position(|k| *k == 1).unwrap_or(0), pick: None, status: "asking".into() }
}
/// A right answer pays 1.6x, 1.8x when it comes within 7 seconds, plus 0.05x for each right answer in a row before
/// it (up to 0.3x).
pub fn trivia_mult(elapsed_ms: i64, streak: i64) -> f64 {
    round2(if elapsed_ms <= TRIVIA_FAST_MS { 1.8 } else { 1.6 } + streak.clamp(0, 6) as f64 * 0.05)
}

// ------------------------------------------------------------------ Paddle Duel
pub const DUEL_TO: u32 = 5;
const ZONES: [&str; 3] = ["Top", "Middle", "Bottom"];
/// A smash flies out this often (out of 100); a normal shot aimed one zone away is reached this often.
pub const SMASH_OUT: u32 = 30;
pub const REACH: u32 = 50;
#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct Duel {
    pub ids: [String; 2],
    pub names: [String; 2],
    pub score: [u32; 2],
    /// Who hits next: 0 the left player, 1 the right.
    pub hitter: usize,
    /// The shot in the air: (zone, smash). Kept hidden from the receiver.
    pub aim: Option<(usize, bool)>,
    pub paddles: [usize; 2],
    /// The last shot, for the picture: (from the left, zone, smash, 0 returned, 1 scored, 2 out).
    pub shot: Option<(bool, usize, bool, u8)>,
    pub said: String,
    pub rally: u32,
    pub at: i64,
    /// "invite", "aim", "stand" or "over".
    pub status: String,
}
impl Duel {
    pub fn receiver(&self) -> usize {
        1 - self.hitter
    }
    /// Whose press the game is waiting for.
    pub fn waiting_on(&self) -> usize {
        if self.status == "stand" { self.receiver() } else { self.hitter }
    }
    pub fn winner(&self) -> Option<usize> {
        self.score.iter().position(|s| *s >= DUEL_TO)
    }
}
pub fn duel_aim(d: &mut Duel, zone: usize, smash: bool) {
    if d.status != "aim" || zone > 2 { return; }
    d.aim = Some((zone, smash));
    d.status = "stand".into();
}
/// The receiver picks where to stand and the shot is played out.
pub fn duel_stand(d: &mut Duel, zone: usize, rng: Rng) {
    let Some((aim, smash)) = d.aim.filter(|_| d.status == "stand" && zone <= 2) else { return };
    let (hitter, receiver) = (d.hitter, d.receiver());
    d.paddles[receiver] = zone;
    d.aim = None;
    let away = aim.abs_diff(zone);
    let landed = if smash && rng(100) < SMASH_OUT { 2 } else if away == 0 || (!smash && away == 1 && rng(100) < REACH) { 0 } else { 1 };
    d.shot = Some((hitter == 0, aim, smash, landed));
    let shot = if smash { "smash" } else { "shot" };
    match landed {
        0 => {
            d.rally += 1;
            d.said = format!("{} got to the {shot} at the {}! Rally of {}.", d.names[receiver], ZONES[aim].to_lowercase(), d.rally);
            d.hitter = receiver;
            d.status = "aim".into();
        }
        _ => {
            let scorer = if landed == 1 { hitter } else { receiver };
            d.score[scorer] += 1;
            d.said = if landed == 2 { format!("{}'s smash flew out! Point to {}.", d.names[hitter], d.names[receiver]) } else { format!("{}'s {shot} to the {} got past {}!", d.names[hitter], ZONES[aim].to_lowercase(), d.names[receiver]) };
            d.rally = 0;
            // whoever lost the point serves next
            d.hitter = 1 - scorer;
            d.status = if d.winner().is_some() { "over".into() } else { "aim".into() };
        }
    }
}
/// Good Boy plays its own presses until it is a person's turn again.
pub fn duel_bot(d: &mut Duel, rng: Rng) {
    for _ in 0..40 {
        if d.status == "over" || d.ids[d.waiting_on()] != "bot" { return; }
        if d.status == "aim" { let zone = rng(3) as usize; let smash = rng(100) < 25; duel_aim(d, zone, smash); } else { let zone = rng(3) as usize; duel_stand(d, zone, rng); }
    }
}

// ------------------------------------------------------------------ the cards and the buttons
fn x(m: f64) -> String {
    format!("{m}x")
}
fn again(out: Vec<Action>) -> Vec<Action> {
    out.into_iter().map(|a| match a { Action::Reply { card } => Action::Update { card }, o => o }).collect()
}
impl Games<'_> {
    fn ar_key(game: &str, user: &str) -> String {
        format!("ar:{game}:{user}")
    }
    fn ar_load<T: DeserializeOwned>(&self, game: &str, user: &str) -> Option<T> {
        self.data().get(&Self::ar_key(game, user)).and_then(|v| serde_json::from_value(v).ok())
    }
    fn ar_save<T: Serialize>(&self, game: &str, user: &str, s: &T) {
        self.data().set(&Self::ar_key(game, user), &serde_json::to_value(s).unwrap_or(Value::Null));
    }
    fn ar_drop(&self, game: &str, user: &str) {
        self.data().delete(&Self::ar_key(game, user));
    }
    /// Pays a finished game and writes it into the player's record.
    fn ar_pay(&self, user: &str, game: &str, bet: i64, mult: f64) -> i64 {
        let back = pays(bet, mult);
        if back > 0 { self.give(user, back, &format!("{} win", mini(game).2)); }
        self.record(user, game, bet, back);
        back
    }
    fn ar_title(&self, game: &str, bet: i64) -> Card {
        let m = mini(game);
        Card::new(Area::Games).title(format!("{} {} · {}", m.1, m.2, group(bet)))
    }
    fn ar_shot(&self, card: Card, game: &str, now: i64, shot: art::Shot) -> Card {
        match shot { Some((bytes, moving)) => card.file(&format!("{game}-{now}.{}", if moving { "gif" } else { "png" }), bytes), None => card }
    }
    fn ar_again(&self, card: Card, game: &str, user: &str, bet: i64, extra: &str) -> Card {
        card.button(format!("ar:{game}:{user}:again:{bet}{extra}"), format!("Play again ({})", group(bet)), ButtonStyle::Good)
    }
    fn ar_wallet(&self, user: &str) -> String {
        let have = self.db.get().wallet(self.guild, user, None, 0).map(|w| w.coins).unwrap_or(0);
        format!("-# Wallet {}", self.coins(have))
    }

    // ---- Treasure Climb
    fn tower_card(&self, user: &str, s: &Tower, note: Option<String>, opened: bool, now: i64) -> Card {
        let climbing = s.status == "climbing";
        let cash = tower_mult(s.floor);
        let headline = match s.status.as_str() {
            "trapped" => "A trap! You lost your bet".to_string(),
            "top" => format!("The top! {} pays {}", x(tower_mult(TOWER_FLOORS)), group(pays(s.bet, tower_mult(TOWER_FLOORS)))),
            "cashed" => format!("Cashed out at {}", x(cash)),
            _ => format!("Floor {}: pick a door", s.floor + 1),
        };
        let small = if tower_can_golden(s) { "The golden door skips a floor, but it only opens about half the time." } else if climbing { "One door on each floor is trapped. Cash out any time." } else { "" };
        let mut card = self.ar_title("tower", s.bet);
        if self.pictures() {
            let mults: Vec<String> = (1..=TOWER_FLOORS).map(|f| x(tower_mult(f))).collect();
            let g = art::Tower { floor: s.floor, picks: &s.picks, traps: (!climbing).then_some(&s.traps[..]), mults: &mults, state: &s.status, headline: &headline, small };
            card = self.ar_shot(card, "tower", now, art::tower(&g, opened, self.animated()));
        } else {
            let rows: Vec<String> = (0..TOWER_FLOORS).rev().map(|f| {
                let doors: String = (0..3).map(|d| if f < s.floor { if s.picks.get(f) == Some(&d) || s.picks.get(f) == Some(&art::GOLDEN) { "🟩" } else { "⬛" } } else if f == s.floor && s.status == "trapped" { if s.picks.get(f) == Some(&d) { "💥" } else if s.traps[f] == d { "💀" } else { "⬛" } } else if !climbing && s.traps[f] == d { "💀" } else if f == s.floor && climbing { "🚪" } else { "⬜" }).collect();
                format!("{doors} {} {}", if f == s.floor && climbing { "◀️" } else { "" }, x(tower_mult(f + 1)))
            }).collect();
            card = card.line(rows.join("\n")).line(format!("**{headline}**"));
        }
        if let Some(n) = note { card = card.line(n); }
        if climbing {
            card = card.line(format!("Cash out now for **{}** ({}). The next floor pays **{}**.", x(cash), self.coins(pays(s.bet, cash)), x(tower_mult(s.floor + 1))));
            for d in 0..3 { card = card.button_with(format!("ar:tower:{user}:d{d}"), format!("Door {}", d + 1), ButtonStyle::Primary, Some("🚪".into())); }
            if tower_can_golden(s) { card = card.button_with(format!("ar:tower:{user}:gold"), format!("Golden door ({})", x(tower_mult(s.floor + 2))), ButtonStyle::Plain, Some("✨".into())); }
            card = card.button_full(format!("ar:tower:{user}:cash"), format!("Cash out {}", x(cash)), ButtonStyle::Good, Some("💰".into()), s.floor == 0);
        } else {
            card = self.ar_again(card.line(self.ar_wallet(user)), "tower", user, s.bet, "");
        }
        card.accent = Some(if s.status == "trapped" { 0xed4245 } else if climbing { 0x6b93ff } else { 0x57f287 });
        card
    }
    fn tower_press(&self, user: &str, what: &str, now: i64, rng: Rng) -> Vec<Action> {
        let Some(mut s) = self.ar_load::<Tower>("tower", user) else { return private("That game has finished. Start a new one with `/tower`.") };
        let mut note = None;
        let mut opened = false;
        match what {
            "cash" if s.status == "climbing" && s.floor > 0 => {
                s.status = "cashed".into();
                note = Some(format!("💰 You took {}.", self.coins(self.ar_pay(user, "tower", s.bet, tower_mult(s.floor)))));
            }
            "gold" if tower_can_golden(&s) => { let lucky = rng(100) < GOLDEN_CHANCE; tower_golden(&mut s, lucky); opened = true; if s.status == "climbing" { note = Some("✨ The golden door opened! You skipped a floor.".into()); } }
            d if d.starts_with('d') && s.status == "climbing" => { tower_pick(&mut s, d[1..].parse().unwrap_or(9)); opened = true; }
            _ => {}
        }
        if opened && s.status == "trapped" { self.ar_pay(user, "tower", s.bet, 0.0); note = Some(if s.picks.last() == Some(&art::GOLDEN) { "🔒 The golden door stayed shut. You lost your bet.".into() } else { "💀 A trap! You lost your bet.".into() }); }
        if opened && s.status == "top" { note = Some(format!("🏆 The top! You won {}.", self.coins(self.ar_pay(user, "tower", s.bet, tower_mult(TOWER_FLOORS))))); }
        if s.status == "climbing" { s.at = now; self.ar_save("tower", user, &s); } else { self.ar_drop("tower", user); }
        vec![Action::Update { card: self.tower_card(user, &s, note, opened, now) }]
    }

    // ---- Bomb Squad
    fn wires_card(&self, user: &str, s: &Wires, note: Option<String>, snipped: bool, now: i64) -> Card {
        let live = s.status == "cutting";
        let cash = wires_mult(s);
        let headline = match s.status.as_str() {
            "boom" => "That was the bomb! You lost your bet".to_string(),
            "cleared" => format!("Defused! Every safe wire cut: {}", x(cash)),
            "cashed" => format!("Cashed out at {}", x(cash)),
            _ if s.safe_cuts() == 0 => format!("Pick a wire. The first safe cut pays {}", x(wires_next(s))),
            _ => format!("{} safe cut{} · cash out {} · next cut pays {}", s.safe_cuts(), if s.safe_cuts() == 1 { "" } else { "s" }, x(cash), x(wires_next(s))),
        };
        let small = if live { "One wire is the bomb. Good Boy can sniff out one safe wire, once a game." } else { "" };
        let mut card = self.ar_title("wires", s.bet);
        if self.pictures() {
            let g = art::Wires { cut: &s.cut, sniffed: s.sniffed, bomb: (!live).then_some(s.bomb), state: &s.status, screen: match s.status.as_str() { "boom" => "BOOM", "cutting" => "ARMED", _ => "SAFE" }, headline: &headline, small };
            card = self.ar_shot(card, "wires", now, art::wires(&g, snipped, self.animated()));
        } else {
            let line: Vec<&str> = WIRES.iter().enumerate().map(|(k, w)| if s.cut.contains(&k) { if k == s.bomb { "💥" } else { "✂️" } } else if s.sniffed == Some(k) { "🐶" } else if !live && k == s.bomb { "💣" } else { w }).collect();
            card = card.line(format!("# {}", line.join(" "))).line(format!("**{headline}**"));
        }
        if let Some(n) = note { card = card.line(n); }
        if live {
            for (k, w) in WIRES.iter().enumerate() { card = card.button_full(format!("ar:wires:{user}:w{k}"), "Cut", ButtonStyle::Plain, Some((*w).into()), s.cut.contains(&k) || s.sniffed == Some(k)); }
            card = card.button_full(format!("ar:wires:{user}:sniff"), "Sniff", ButtonStyle::Primary, Some("🐶".into()), !wires_can_sniff(s))
                .button_full(format!("ar:wires:{user}:cash"), format!("Cash out {}", x(cash)), ButtonStyle::Good, Some("💰".into()), s.safe_cuts() == 0);
        } else {
            card = self.ar_again(card.line(self.ar_wallet(user)), "wires", user, s.bet, "");
        }
        card.accent = Some(if s.status == "boom" { 0xed4245 } else if live { 0x6b93ff } else { 0x57f287 });
        card
    }
    fn wires_press(&self, user: &str, what: &str, now: i64, rng: Rng) -> Vec<Action> {
        let Some(mut s) = self.ar_load::<Wires>("wires", user) else { return private("That game has finished. Start a new one with `/wires`.") };
        let mut note = None;
        let mut snipped = false;
        match what {
            "cash" if s.status == "cutting" && s.safe_cuts() > 0 => {
                s.status = "cashed".into();
                note = Some(format!("💰 You took {}.", self.coins(self.ar_pay(user, "wires", s.bet, wires_mult(&s)))));
            }
            "sniff" if wires_can_sniff(&s) => { wires_sniff(&mut s, rng(4)); note = s.sniffed.map(|k| format!("🐶 Good Boy sniffed the {} wire: it is safe, so it is set aside.", WIRES[k])); }
            w if w.starts_with('w') && s.status == "cutting" => { let before = s.cut.len(); wires_cut(&mut s, w[1..].parse().unwrap_or(9)); snipped = s.cut.len() > before; }
            _ => {}
        }
        if snipped && s.status == "boom" { self.ar_pay(user, "wires", s.bet, 0.0); note = Some("💥 That was the bomb! You lost your bet.".into()); }
        if snipped && s.status == "cleared" { note = Some(format!("✅ Every safe wire cut! You won {}.", self.coins(self.ar_pay(user, "wires", s.bet, wires_mult(&s))))); }
        if s.status == "cutting" { s.at = now; self.ar_save("wires", user, &s); } else { self.ar_drop("wires", user); }
        vec![Action::Update { card: self.wires_card(user, &s, note, snipped, now) }]
    }

    // ---- Bingo
    fn bingo_card(&self, user: &str, s: &Bingo, note: Option<String>, fresh: usize, now: i64) -> Card {
        let live = s.status == "drawing";
        let lines = bingo_lines(s);
        let squares: Vec<usize> = lines.iter().flatten().copied().collect();
        let headline = match s.status.as_str() { "bingo" => format!("BINGO! {}", x(bingo_pays(s))), "out" => "No line this time".to_string(), _ if s.drawn == 0 => "Drop the first ball".to_string(), _ => format!("Next line pays {}", x(bingo_mult(s.drawn + 1))) };
        let detail = match s.status.as_str() { "bingo" => format!("{} in {} draws", if lines.len() > 1 { "two lines" } else { "a line" }, s.drawn), "out" => "you lost your bet".to_string(), _ => format!("{} balls to go", BINGO_DRAWS - s.drawn) };
        let mut card = self.ar_title("bingo", s.bet);
        if self.pictures() {
            let g = art::Bingo { card: &s.card, drawn: &s.order[..s.drawn], draws: BINGO_DRAWS, line: &squares, headline: &headline, detail: &detail, small: "A line of four, any way. Sooner pays more; two lines at once pay double.", fresh, good: match s.status.as_str() { "bingo" => Some(true), "out" => Some(false), _ => None } };
            card = self.ar_shot(card, "bingo", now, art::bingo(&g, self.animated()));
        } else {
            let hit = &s.order[..s.drawn];
            let grid: Vec<String> = s.card.chunks(4).map(|r| r.iter().map(|n| if hit.contains(n) { "✅".to_string() } else { format!("`{n:>2}`") }).collect::<Vec<_>>().join(" ")).collect();
            card = card.line(grid.join("\n")).line(format!("Drawn: {}", if hit.is_empty() { "nothing yet".to_string() } else { hit.iter().map(u32::to_string).collect::<Vec<_>>().join(", ") })).line(format!("**{headline}** · {detail}"));
        }
        if let Some(n) = note { card = card.line(n); }
        if live {
            card = card.line("-# A line by ball 4 pays 20x, 5: 8x, 6: 5x, 7: 3.5x, 8: 2.5x, 9: 2.1x, 10: 1.4x.")
                .button_with(format!("ar:bingo:{user}:draw"), "Drop a ball", ButtonStyle::Primary, Some("🎱".into()))
                .button(format!("ar:bingo:{user}:all"), "Drop them all", ButtonStyle::Plain);
        } else {
            card = self.ar_again(card.line(self.ar_wallet(user)), "bingo", user, s.bet, "");
        }
        card.accent = Some(if s.status == "out" { 0xed4245 } else if live { 0x6b93ff } else { 0x57f287 });
        card
    }
    fn bingo_press(&self, user: &str, what: &str, now: i64) -> Vec<Action> {
        let Some(mut s) = self.ar_load::<Bingo>("bingo", user) else { return private("That game has finished. Start a new one with `/bingo`.") };
        let before = s.drawn;
        match what { "draw" => bingo_draw(&mut s), "all" => while s.status == "drawing" { bingo_draw(&mut s) }, _ => {} }
        let mut note = None;
        if s.status == "bingo" { note = Some(format!("🎉 You won {}.", self.coins(self.ar_pay(user, "bingo", s.bet, bingo_pays(&s))))); }
        if s.status == "out" { self.ar_pay(user, "bingo", s.bet, 0.0); }
        if s.status == "drawing" { s.at = now; self.ar_save("bingo", user, &s); } else { self.ar_drop("bingo", user); }
        vec![Action::Update { card: self.bingo_card(user, &s, note, s.drawn - before, now) }]
    }

    // ---- Memory
    fn memory_card(&self, user: &str, s: &Memory, note: Option<String>, fresh: &[usize], now: i64) -> Card {
        let live = s.status == "playing";
        let now_pays = memory_mult(s.mistakes, s.best);
        let mut card = self.ar_title("memory", s.bet);
        let pictured = self.pictures();
        if pictured {
            let headline = if !live { if now_pays > 0.0 { "All pairs found!" } else { "Board cleared, too many mistakes" } }
                else if s.open.len() == 2 { "No match: turn two new cards" }
                else if s.open.len() == 1 { "Now pick a second card" }
                else if !fresh.is_empty() && !s.found.is_empty() { "A match!" } else { "Pick two cards" };
            let pays = if now_pays > 0.0 { x(now_pays) } else { "nothing yet".to_string() };
            let g = art::Memory { cards: &s.cards, found: &s.found, open: &s.open, fresh, mistakes: s.mistakes, streak: s.streak, best: s.best, pays: &pays, headline, small: "6 or fewer mistakes: 2x · 10: 1.4x · 14: bet back. Three matches in a row +0.2x, five +0.5x.", end: (!live).then_some(now_pays > 0.0) };
            card = self.ar_shot(card, "memory", now, art::memory(&g, self.animated()));
        } else {
            card = card.line(if live { format!("**{} of 8 pairs** · mistakes **{}** · paying **{}** right now", s.found.len() / 2, s.mistakes, x(now_pays)) } else { format!("**All pairs found** with {} mistake{}", s.mistakes, if s.mistakes == 1 { "" } else { "s" }) })
                .line(if s.streak >= 2 && live { format!("🔥 Combo ×{}! Three in a row adds 0.2x, five adds 0.5x.", s.streak) } else { format!("Best combo: ×{} · three matches in a row add 0.2x, five add 0.5x", s.best) });
            if live { card = card.line("-# 6 or fewer mistakes: 2x · 10 or fewer: 1.4x · 14 or fewer: your bet back"); }
        }
        if let Some(n) = note { card = card.line(n); }
        for (k, face) in s.cards.iter().enumerate() {
            let (found, open) = (s.found.contains(&k), s.open.contains(&k));
            let shown = found || open || !live;
            let style = if found { ButtonStyle::Good } else if open { ButtonStyle::Primary } else { ButtonStyle::Plain };
            // with the picture, the buttons are just the card numbers (the faces are in the picture); without it they show the faces
            card = if pictured { card.button_full(format!("ar:memory:{user}:c{k}"), (k + 1).to_string(), style, None, !live || found) }
                else { card.button_full(format!("ar:memory:{user}:c{k}"), "", style, Some(if shown { MEMORY_FACES[*face].to_string() } else { "❔".to_string() }), !live || found) };
        }
        if !live { card = self.ar_again(card.line(self.ar_wallet(user)), "memory", user, s.bet, ""); }
        card.accent = Some(if live { 0x6b93ff } else if now_pays > 0.0 { 0x57f287 } else { 0xed4245 });
        card.grid(4)
    }
    fn memory_press(&self, user: &str, what: &str, now: i64) -> Vec<Action> {
        let Some(mut s) = self.ar_load::<Memory>("memory", user) else { return private("That game has finished. Start a new one with `/memory`.") };
        let before = (s.found.clone(), s.open.clone());
        let mut fresh: Vec<usize> = Vec::new();
        if let Some(k) = what.strip_prefix('c').and_then(|k| k.parse::<usize>().ok()) { memory_flip(&mut s, k); if (&s.found, &s.open) != (&before.0, &before.1) || s.open.contains(&k) || s.found.contains(&k) { fresh.push(k); } }
        let mut note = None;
        if s.status == "done" {
            let mult = memory_mult(s.mistakes, s.best);
            let back = self.ar_pay(user, "memory", s.bet, mult);
            note = Some(if mult > 0.0 { format!("🧠 That pays **{}**: you got {}.", x(mult), self.coins(back)) } else { "Too many mistakes this time, so you lost your bet.".to_string() });
            self.ar_drop("memory", user);
        } else { s.at = now; self.ar_save("memory", user, &s); }
        vec![Action::Update { card: self.memory_card(user, &s, note, &fresh, now) }]
    }

    // ---- Balloon Rescue
    fn hangman_card(&self, user: &str, s: &Hangman, note: Option<String>, popped: u32, now: i64) -> Card {
        let live = s.status == "guessing";
        let left = HANGMAN_LIVES - s.wrong.min(HANGMAN_LIVES);
        let mult = hangman_mult(s);
        let letters: Vec<Option<char>> = s.word.chars().map(|c| Some(c).filter(|c| !live || s.guessed.contains(c))).collect();
        let headline = match s.status.as_str() { "won" => format!("Rescued! {}", x(mult)), "lost" => "All balloons popped".to_string(), _ => format!("Win {}", x(mult)) };
        let small = match s.status.as_str() { "won" => "You got the word".to_string(), "lost" => format!("The word was {}", s.word.to_uppercase()), _ => "pays more with every balloon you keep".to_string() };
        let mut card = self.ar_title("hangman", s.bet);
        if self.pictures() {
            let g = art::Hangman { category: &s.category, letters, tried: s.guessed.iter().map(|c| (*c, s.word.contains(*c))).collect(), balloons: left, headline: &headline, small: &small, end: match s.status.as_str() { "won" => art::End::Won, "lost" => art::End::Lost, _ => art::End::Playing }, popped };
            card = self.ar_shot(card, "hangman", now, art::hangman(&g, self.animated()));
        } else {
            let blanks: Vec<String> = letters.iter().map(|c| c.map(|c| c.to_ascii_uppercase().to_string()).unwrap_or_else(|| "\\_".into())).collect();
            card = card.line(format!("{} · {}", "🎈".repeat(left as usize), s.category)).line(format!("# {}", blanks.join(" ")))
                .line(format!("Tried: {}", if s.guessed.is_empty() { "nothing yet".to_string() } else { s.guessed.iter().map(|c| c.to_ascii_uppercase().to_string()).collect::<Vec<_>>().join(" ") }))
                .line(format!("**{headline}** · {small}"));
        }
        if let Some(n) = note { card = card.line(n); }
        if live {
            card = card.line(format!("{} letter{} in a **{}** word. A wrong letter pops one balloon, a wrong whole word pops two.", s.word.len(), if s.word.len() == 1 { "" } else { "s" }, s.category.to_lowercase()))
                .button_with(format!("ar:hangman:{user}:guess"), "Guess a letter or the word", ButtonStyle::Primary, Some("⌨️".into()))
                .button_full(format!("ar:hangman:{user}:hint"), "Hint (pops a balloon)", ButtonStyle::Plain, Some("💡".into()), !hangman_can_hint(s));
        } else {
            card = self.ar_again(card.line(self.ar_wallet(user)), "hangman", user, s.bet, "");
        }
        card.accent = Some(if s.status == "lost" { 0xed4245 } else if live { 0x6b93ff } else { 0x57f287 });
        card
    }
    /// After a guess or a hint: pay if it is over, save if not, and show the card.
    fn hangman_after(&self, user: &str, mut s: Hangman, mut note: Option<String>, popped: u32, now: i64) -> Vec<Action> {
        if s.status == "won" { note = Some(format!("🎉 It was **{}**! You won {}.", s.word.to_uppercase(), self.coins(self.ar_pay(user, "hangman", s.bet, hangman_mult(&s))))); }
        if s.status == "lost" { self.ar_pay(user, "hangman", s.bet, 0.0); note = Some(format!("💥 The word was **{}**. You lost your bet.", s.word.to_uppercase())); }
        if s.status == "guessing" { s.at = now; self.ar_save("hangman", user, &s); } else { self.ar_drop("hangman", user); }
        vec![Action::Update { card: self.hangman_card(user, &s, note, popped, now) }]
    }
    fn hangman_press(&self, user: &str, what: &str, now: i64, rng: Rng) -> Vec<Action> {
        let Some(mut s) = self.ar_load::<Hangman>("hangman", user) else { return private("That game has finished. Start a new one with `/hangman`.") };
        match what {
            "guess" => vec![Action::Form { id: format!("arh:{user}"), title: "Balloon Rescue".into(), fields: vec![Field { id: "guess".into(), label: "A letter, or the whole word".into(), desc: Some(format!("{} letters · {}", s.word.len(), s.category)), required: true, max: 20, placeholder: Some("One letter is the safe way".into()), ..Default::default() }] }],
            "hint" => {
                let Some(c) = hangman_hint(&mut s, rng(26)) else { return private("No hint this time: you need a balloon to spare.") };
                self.hangman_after(user, s, Some(format!("💡 A hint: there is a **{}**. That cost a balloon.", c.to_ascii_uppercase())), 1, now)
            }
            _ => Vec::new(),
        }
    }

    // ---- Trivia
    fn trivia_streak(&self, user: &str) -> i64 {
        self.data().get(&format!("trs:{user}")).and_then(|v| v.as_i64()).unwrap_or(0)
    }
    fn trivia_card(&self, user: &str, s: &Trivia, note: Option<String>, now: i64) -> Card {
        let live = s.status == "asking";
        let streak = self.trivia_streak(user);
        let label = trivia_label(&s.cat);
        let tag = if streak > 0 { format!("Streak {streak}") } else { String::new() };
        let headline = match s.status.as_str() { "right" => "Right!", "late" => "Too slow!", "wrong" => "Wrong", _ => "" };
        let small = if live { "Answer within 7 seconds for 1.8x, later for 1.6x. Every right answer in a row adds 0.05x." } else { "" };
        let mut card = self.ar_title("trivia", s.bet);
        if self.pictures() {
            let g = art::Trivia { category: label, streak: &tag, question: &s.q, answers: &s.answers, seconds: (TRIVIA_MS / 1000) as u32, result: (!live).then_some((s.right, s.pick)), headline, small };
            card = self.ar_shot(card, "trivia", now, art::trivia(&g, self.animated()));
        } else {
            card = card.line(format!("**{label}** · {}", if tag.is_empty() { "no streak yet".to_string() } else { tag })).line(format!("**{}**", s.q));
            if live { card = card.line(format!("You have {} seconds.", TRIVIA_MS / 1000)); }
        }
        if let Some(n) = note { card = card.line(n); }
        let styles = [ButtonStyle::Primary, ButtonStyle::Danger, ButtonStyle::Plain, ButtonStyle::Good];
        for (k, a) in s.answers.iter().enumerate() {
            let style = if live { styles[k % 4] } else if k == s.right { ButtonStyle::Good } else if s.pick == Some(k) { ButtonStyle::Danger } else { ButtonStyle::Plain };
            let label: String = format!("{} · {a}", ["A", "B", "C", "D"][k % 4]).chars().take(80).collect();
            card = card.button_full(format!("ar:trivia:{user}:a{k}"), label, style, None, !live);
        }
        if !live { card = card.line(self.ar_wallet(user)).button(format!("ar:trivia:{user}:again:{}:{}", s.bet, s.wanted), format!("Next question ({})", group(s.bet)), ButtonStyle::Primary); }
        card.accent = Some(if live { 0x6b93ff } else if s.status == "right" { 0x57f287 } else { 0xed4245 });
        card.grid(4)
    }
    fn trivia_press(&self, user: &str, what: &str, now: i64) -> Vec<Action> {
        let Some(mut s) = self.ar_load::<Trivia>("trivia", user) else { return private("That question has gone. Ask for a new one with `/trivia`.") };
        let Some(pick) = what.strip_prefix('a').and_then(|k| k.parse::<usize>().ok()).filter(|k| *k < s.answers.len()) else { return Vec::new() };
        let elapsed = now - s.at;
        let streak = self.trivia_streak(user);
        s.pick = Some(pick);
        let right_answer = s.answers[s.right].clone();
        let note = if elapsed > TRIVIA_MS + TRIVIA_GRACE_MS {
            s.status = "late".into();
            format!("⌛ Too slow! It was **{right_answer}**.")
        } else if pick == s.right {
            s.status = "right".into();
            let mult = trivia_mult(elapsed, streak);
            let back = self.ar_pay(user, "trivia", s.bet, mult);
            self.data().set(&format!("trs:{user}"), &json!(streak + 1));
            format!("✅ Right in {:.1} seconds: **{}** pays {}.", elapsed.max(0) as f64 / 1000.0, x(mult), self.coins(back))
        } else {
            s.status = "wrong".into();
            format!("❌ It was **{right_answer}**.")
        };
        if s.status != "right" {
            self.ar_pay(user, "trivia", s.bet, 0.0);
            self.data().delete(&format!("trs:{user}"));
        }
        self.ar_drop("trivia", user);
        vec![Action::Update { card: self.trivia_card(user, &s, Some(note), now) }]
    }

    // ---- starting, the popups and the panel
    /// Starts a game (or shows the one still going).
    fn ar_start(&self, who: &Member, game: &str, raw_bet: &str, category: &str, now: i64, rng: Rng) -> Vec<Action> {
        let m = mini(game);
        if m.0.is_empty() { return Vec::new(); }
        if !self.on(game) { return private(format!("{} is turned off in this server.", m.2)); }
        let u = who.id.as_str();
        let still = "-# You still had this game going, so here it is.".to_string();
        let open = match game {
            "tower" => self.ar_load::<Tower>(game, u).map(|s| self.tower_card(u, &s, Some(still), false, now)),
            "wires" => self.ar_load::<Wires>(game, u).map(|s| self.wires_card(u, &s, Some(still), false, now)),
            "bingo" => self.ar_load::<Bingo>(game, u).map(|s| self.bingo_card(u, &s, Some(still), 0, now)),
            "memory" => self.ar_load::<Memory>(game, u).map(|s| self.memory_card(u, &s, Some(still), &[], now)),
            "hangman" => self.ar_load::<Hangman>(game, u).map(|s| self.hangman_card(u, &s, Some(still), 0, now)),
            // an open question that ran out of time is closed (and lost) before the next one
            _ => { self.trivia_expire(u, now); self.ar_load::<Trivia>(game, u).map(|_| Card::new(Area::Games).line("You still have a question open. Answer it first!").private()) }
        };
        if let Some(card) = open { return vec![Action::Reply { card: self.quiet(card) }]; }
        let bet = match self.bet(who, raw_bet) { Ok(b) => b, Err(e) => return private(e) };
        if let Err(e) = self.take(who, bet, &format!("{} bet", m.2)) { return private(e); }
        let card = match game {
            "tower" => { let s = tower_start(bet, now, rng); self.ar_save(game, u, &s); self.tower_card(u, &s, None, false, now) }
            "wires" => { let s = wires_start(bet, now, rng); self.ar_save(game, u, &s); self.wires_card(u, &s, None, false, now) }
            "bingo" => { let s = bingo_start(bet, now, rng); self.ar_save(game, u, &s); self.bingo_card(u, &s, None, 0, now) }
            "memory" => { let s = memory_start(bet, now, rng); self.ar_save(game, u, &s); self.memory_card(u, &s, None, &[], now) }
            "hangman" => { let s = hangman_start(bet, now, rng); self.ar_save(game, u, &s); self.hangman_card(u, &s, None, 0, now) }
            _ => { let s = trivia_start(bet, now, category, rng); self.ar_save(game, u, &s); self.trivia_card(u, &s, None, now) }
        };
        vec![Action::Reply { card: self.quiet(card) }]
    }
    fn trivia_expire(&self, user: &str, now: i64) {
        if let Some(s) = self.ar_load::<Trivia>("trivia", user).filter(|s| now - s.at > TRIVIA_MS + TRIVIA_GRACE_MS) {
            self.ar_pay(user, "trivia", s.bet, 0.0);
            self.data().delete(&format!("trs:{user}"));
            self.ar_drop("trivia", user);
        }
    }
    fn panel(&self) -> Card {
        let mut card = Card::new(Area::Games).title("🕹️ Arcade")
            .line("Pick a game. Each button opens a private popup just for you.")
            .line(format!("🎰 **Slots** · jackpot pool {}\n🃏 **Blackjack** · pays 3 to 2\n🪙 **Coin flip** · call it right to double up\n🎣 **Fishing** · cast, reel and collect\n🏓 **Paddle Duel** · a rally against Good Boy", self.coins(self.pool())))
            .line(MINI.iter().filter(|m| self.on(m.0)).map(|m| format!("{} **{}** · {}", m.1, m.2, m.3)).collect::<Vec<_>>().join("\n"))
            .line("-# Play money only. Coins cannot be bought or cashed out.");
        for (id, emoji, label) in [("slots", "🎰", "Slots"), ("blackjack", "🃏", "Blackjack"), ("coinflip", "🪙", "Coin flip"), ("fish", "🎣", "Fishing"), ("pong", "🏓", "Paddle Duel")] {
            card = card.button_with(format!("ar:open:{id}"), label, ButtonStyle::Primary, Some(emoji.into()));
        }
        for m in MINI.iter().filter(|m| self.on(m.0)) { card = card.button_with(format!("ar:open:{}", m.0), m.2, ButtonStyle::Plain, Some(m.1.into())); }
        card
    }
    /// A panel button: the bet popup for that game.
    fn open_form(&self, who: &Member, game: &str, now: i64, rng: Rng) -> Vec<Action> {
        if game == "pong" { return self.duel_start(who, None, now, rng); }
        let name = match game { "slots" => "Slots", "blackjack" => "Blackjack", "coinflip" => "Coin flip", g => mini(g).2 };
        if !self.on(game) { return private(format!("{name} is turned off in this server.")); }
        let have = self.wallet(who);
        let mut fields = vec![Field { id: "bet".into(), label: "Your bet".into(), desc: Some(format!("You have {} coins. Bets from {} to {}.", group(have), group(self.int("minBet")), group(self.int("maxBet")))), required: true, max: 12, placeholder: Some("500, 2.5k, half or all".into()), value: Some(self.int("minBet").to_string()), ..Default::default() }];
        if game == "trivia" { fields.push(Field { id: "category".into(), label: "Category".into(), kind: FieldKind::Select(std::iter::once(("Anything".to_string(), "any".to_string())).chain(pool().iter().map(|c| (c.label.to_string(), c.id.to_string()))).collect()), value: Some("any".into()), ..Default::default() }); }
        if game == "coinflip" { fields.push(Field { id: "side".into(), label: "Your call".into(), kind: FieldKind::Select(vec![("Heads".into(), "heads".into()), ("Tails".into(), "tails".into())]), value: Some("heads".into()), required: true, ..Default::default() }); }
        vec![Action::Form { id: format!("arstart:{game}"), title: format!("{name}: set your bet"), fields }]
    }

    pub fn arcade_command(&self, ev: &CommandEvent, rng: Rng) -> Vec<Action> {
        let arg = |k: &str| ev.args.get(k).map(String::as_str).unwrap_or("");
        match ev.name.as_str() {
            "arcade" => {
                if ev.member.perms & (crate::perms::ADMINISTRATOR | crate::perms::MANAGE_GUILD) == 0 { return private("Only server admins can post the arcade panel."); }
                vec![Action::Reply { card: self.panel() }]
            }
            "pong" => self.duel_start(&ev.member, ev.target.as_ref(), ev.at_ms, rng),
            game => self.ar_start(&ev.member, game, arg("bet"), if arg("category").is_empty() { "any" } else { arg("category") }, ev.at_ms, rng),
        }
    }
    /// `ar:` buttons. `ar:open:fish` is answered by the bot itself (the fishing hub lives there).
    pub fn arcade_press(&self, ev: &ButtonEvent, rng: Rng) -> Vec<Action> {
        let parts: Vec<&str> = ev.id.split(':').collect();
        let (game, owner, what) = (parts.get(1).copied().unwrap_or(""), parts.get(2).copied().unwrap_or(""), parts.get(3).copied().unwrap_or(""));
        if game == "open" { return self.open_form(&ev.member, owner, ev.at_ms, rng); }
        if owner != ev.member.id { return private("That's someone else's game. Start your own!"); }
        if what == "again" {
            let bet = parts.get(4).copied().unwrap_or("0");
            return again(self.ar_start(&ev.member, game, bet, parts.get(5).copied().unwrap_or("any"), ev.at_ms, rng));
        }
        match game {
            "tower" => self.tower_press(owner, what, ev.at_ms, rng),
            "wires" => self.wires_press(owner, what, ev.at_ms, rng),
            "bingo" => self.bingo_press(owner, what, ev.at_ms),
            "memory" => self.memory_press(owner, what, ev.at_ms),
            "hangman" => self.hangman_press(owner, what, ev.at_ms, rng),
            "trivia" => self.trivia_press(owner, what, ev.at_ms),
            _ => Vec::new(),
        }
    }
    /// The hangman guess popup (`arh:<user>`) and the panel's bet popups (`arstart:<game>`).
    pub fn arcade_form(&self, ev: &FormEvent, rng: Rng) -> Vec<Action> {
        let value = |k: &str| ev.values.get(k).map(String::as_str).unwrap_or("");
        if let Some(game) = ev.id.strip_prefix("arstart:") {
            return match game {
                "slots" => self.slots(&ev.member, value("bet"), rng, false, &ev.place.channel, ev.at_ms),
                "blackjack" => self.blackjack(&ev.member, value("bet"), ev.at_ms, rng),
                "coinflip" => self.coinflip(&ev.member, value("bet"), if value("side") == "tails" { "tails" } else { "heads" }, rng),
                g => self.ar_start(&ev.member, g, value("bet"), if value("category").is_empty() { "any" } else { value("category") }, ev.at_ms, rng),
            };
        }
        let owner = ev.id.strip_prefix("arh:").unwrap_or("");
        if owner != ev.member.id { return private("That popup belongs to someone else."); }
        let Some(mut s) = self.ar_load::<Hangman>("hangman", owner) else { return private("That game has finished. Start a new one with `/hangman`.") };
        let (said, popped) = hangman_guess(&mut s, value("guess"));
        self.hangman_after(owner, s, Some(said).filter(|t| !t.is_empty()), popped, ev.at_ms)
    }
    /// Games nobody finished. After ten minutes a climb or a bomb is cashed out where it stood, a bingo card is drawn
    /// to the end, and a memory board or a word is closed as lost. A trivia question closes when its time is up.
    pub fn arcade_due(&self, now: i64) {
        for (key, v) in self.data().list("ar:") {
            let mut parts = key.splitn(3, ':');
            let (_, game, user) = (parts.next(), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
            let at = v["at"].as_i64().unwrap_or(0);
            if game == "trivia" { self.trivia_expire(user, now); continue; }
            if now - at < SESSION_MS { continue; }
            let bet = v["bet"].as_i64().unwrap_or(0);
            let mult = match game {
                "tower" => serde_json::from_value::<Tower>(v).map(|s| tower_mult(s.floor)).unwrap_or(1.0),
                "wires" => serde_json::from_value::<Wires>(v).map(|s| wires_mult(&s)).unwrap_or(1.0),
                "bingo" => serde_json::from_value::<Bingo>(v).map(|mut s| { while s.status == "drawing" { bingo_draw(&mut s); } bingo_pays(&s) }).unwrap_or(1.0),
                _ => 0.0,
            };
            self.ar_pay(user, game, bet, mult);
            self.data().delete(&key);
        }
        for (key, v) in self.data().list("pg:") {
            if now - v["at"].as_i64().unwrap_or(0) >= SESSION_MS { self.data().delete(&key); }
        }
    }

    // ---- Paddle Duel
    fn duel_card(&self, id: &str, d: &Duel, moving: bool, now: i64) -> Card {
        let over = d.status == "over";
        let turn = d.waiting_on();
        let headline = if let Some(w) = d.winner() { format!("{} wins {} to {}!", d.names[w], d.score[w], d.score[1 - w]) }
            else if d.status == "stand" { format!("{} has hit the ball. {}: where do you stand?", d.names[d.hitter], d.names[turn]) }
            else { format!("{} to hit: aim it, or risk a smash", d.names[turn]) };
        let small = "Stand where the ball lands to return it. A smash is harder to reach, but it can fly out. First to 5.";
        let mut card = Card::new(Area::Games).title(format!("🏓 Paddle Duel · {} {} : {} {}", d.names[0], d.score[0], d.score[1], d.names[1]));
        if self.pictures() {
            let g = art::Pong { left: &d.names[0], right: &d.names[1], score: (d.score[0], d.score[1]), paddles: (d.paddles[0], d.paddles[1]), shot: d.shot.map(|(l, z, s, how)| (l, z, s, match how { 0 => art::Landed::Returned, 1 => art::Landed::Scored, _ => art::Landed::Out })), headline: &headline, small, over };
            card = self.ar_shot(card, "pong", now, art::pong(&g, moving && self.animated()));
        } else {
            card = card.line(format!("**{headline}**"));
        }
        if !d.said.is_empty() { card = card.line(d.said.clone()); }
        if over && self.pictures() { card = card.line(format!("🏆 **{headline}**")); }
        if over { return card.button(format!("pg:{id}:rematch"), "Rematch", ButtonStyle::Good); }
        if d.ids[turn] != "bot" { card = card.line(format!("<@{}>, it's your move.", d.ids[turn])); }
        if d.status == "stand" {
            for (z, name) in ZONES.iter().enumerate() { card = card.button(format!("pg:{id}:d{z}"), format!("Stand {}", name.to_lowercase()), ButtonStyle::Primary); }
        } else {
            for (z, name) in ZONES.iter().enumerate() { card = card.button(format!("pg:{id}:a{z}"), format!("Aim {}", name.to_lowercase()), ButtonStyle::Primary); }
            for (z, name) in ZONES.iter().enumerate() { card = card.button_with(format!("pg:{id}:s{z}"), format!("Smash {}", name.to_lowercase()), ButtonStyle::Danger, Some("💥".into())); }
        }
        card.button(format!("pg:{id}:quit"), "Give up", ButtonStyle::Plain).grid(3)
    }
    fn duel_start(&self, who: &Member, rival: Option<&Member>, now: i64, rng: Rng) -> Vec<Action> {
        if !self.on("pong") { return private("Paddle Duel is turned off in this server."); }
        let id = format!("{}-{}", who.id, now % 100_000_000);
        let mut d = Duel { ids: [who.id.clone(), "bot".into()], names: [who.name.clone(), "Good Boy".into()], paddles: [1, 1], at: now, status: "aim".into(), ..Default::default() };
        match rival {
            Some(r) if r.bot => private("Bots can't play. Leave the opponent empty to play Good Boy."),
            Some(r) if r.id == who.id => private("Pick someone else, or leave it empty to play Good Boy."),
            Some(r) => {
                d.ids[1] = r.id.clone();
                d.names[1] = r.name.clone();
                d.status = "invite".into();
                self.data().set(&format!("pg:{id}"), &serde_json::to_value(&d).unwrap_or(Value::Null));
                let mut card = Card::new(Area::Games).title("🏓 Paddle Duel").line(format!("<@{}>, <@{}> challenges you to a Paddle Duel! First to {DUEL_TO}.", r.id, who.id))
                    .button_with(format!("pg:{id}:accept"), "Play", ButtonStyle::Good, Some("🏓".into())).button(format!("pg:{id}:decline"), "No thanks", ButtonStyle::Plain);
                card.ping = vec![r.id.clone()];
                vec![Action::Reply { card }]
            }
            None => {
                duel_bot(&mut d, rng);
                self.data().set(&format!("pg:{id}"), &serde_json::to_value(&d).unwrap_or(Value::Null));
                vec![Action::Reply { card: self.quiet(self.duel_card(&id, &d, false, now)) }]
            }
        }
    }
    /// `pg:<session>:<action>` buttons.
    pub fn duel_press(&self, ev: &ButtonEvent, rng: Rng) -> Vec<Action> {
        let mut parts = ev.id.splitn(3, ':');
        let (_, id, what) = (parts.next(), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        let key = format!("pg:{id}");
        let Some(mut d) = self.data().get(&key).and_then(|v| serde_json::from_value::<Duel>(v).ok()) else { return private("That duel has finished. Start a new one with `/pong`.") };
        let me = ev.member.id.as_str();
        let Some(side) = d.ids.iter().position(|p| p == me) else { return private("This is not your game. Start your own with `/pong`.") };
        let now = ev.at_ms;
        let save = |d: &Duel| self.data().set(&key, &serde_json::to_value(d).unwrap_or(Value::Null));
        match (d.status.as_str(), what) {
            ("invite", "accept" | "decline") => {
                if side != 1 { return private("That challenge is for someone else."); }
                if what == "decline" { self.data().delete(&key); return vec![Action::Update { card: Card::new(Area::Games).line(format!("<@{me}> passed on the Paddle Duel this time.")) }]; }
                d.status = "aim".into();
                d.at = now;
                save(&d);
                vec![Action::Update { card: self.duel_card(id, &d, false, now) }]
            }
            ("over", "rematch") => {
                let mut fresh = Duel { ids: d.ids.clone(), names: d.names.clone(), paddles: [1, 1], at: now, status: "aim".into(), hitter: d.winner().map(|w| 1 - w).unwrap_or(0), ..Default::default() };
                duel_bot(&mut fresh, rng);
                save(&fresh);
                vec![Action::Update { card: self.duel_card(id, &fresh, false, now) }]
            }
            ("aim" | "stand", "quit") => {
                d.score[1 - side] = DUEL_TO;
                d.said = format!("{} gave up.", d.names[side]);
                d.shot = None;
                self.duel_finish(&mut d);
                save(&d);
                vec![Action::Update { card: self.duel_card(id, &d, false, now) }]
            }
            ("aim" | "stand", w) => {
                if d.waiting_on() != side { return private(if d.status == "stand" { "You hit that one. Wait for them to pick where to stand." } else { "It is not your turn yet." }); }
                let zone = w[1..].parse::<usize>().unwrap_or(9);
                match (d.status.as_str(), &w[..1]) {
                    ("aim", "a") => duel_aim(&mut d, zone, false),
                    ("aim", "s") => duel_aim(&mut d, zone, true),
                    ("stand", "d") => duel_stand(&mut d, zone, rng),
                    _ => return private("That button is from an earlier shot."),
                }
                duel_bot(&mut d, rng);
                d.at = now;
                if d.status == "over" { self.duel_finish(&mut d); }
                save(&d);
                vec![Action::Update { card: self.duel_card(id, &d, true, now) }]
            }
            _ => private("That button is from an earlier game."),
        }
    }
    /// A finished duel goes into both players' records (no coins are at stake).
    fn duel_finish(&self, d: &mut Duel) {
        d.status = "over".into();
        let Some(w) = d.winner() else { return };
        for side in 0..2 {
            if d.ids[side] != "bot" { self.record(&d.ids[side], "pong", 0, i64::from(side == w)); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::arcade_data::TRIVIA;
    /// A small repeatable random source.
    fn lcg(seed: u64) -> impl FnMut(u32) -> u32 {
        let mut s = seed;
        move |n| { s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); ((s >> 33) % n.max(1) as u64) as u32 }
    }
    #[test]
    fn tower_pays_what_good_boy_3_paid_and_the_golden_door_is_not_free_money() {
        assert_eq!((tower_mult(0), tower_mult(1), tower_mult(3), tower_mult(8)), (1.0, 1.45, 3.05, 19.54));
        let mut s = Tower { traps: vec![0; 8], status: "climbing".into(), ..Default::default() };
        tower_pick(&mut s, 1);
        assert_eq!((s.floor, s.status.as_str()), (1, "climbing"));
        tower_pick(&mut s, 0);
        assert_eq!(s.status, "trapped");
        let mut s = Tower { traps: vec![0; 8], floor: 4, picks: vec![1; 4], status: "climbing".into(), ..Default::default() };
        assert!(tower_can_golden(&s));
        tower_golden(&mut s, true);
        assert_eq!((s.floor, s.picks.len()), (6, 6));
        assert!(!tower_can_golden(&s));
        // the golden door gives back less than it costs on average
        assert!(GOLDEN_CHANCE as f64 / 100.0 * tower_mult(6) / tower_mult(4) < 1.0);
        let mut s = Tower { traps: vec![0; 8], status: "climbing".into(), ..Default::default() };
        for _ in 0..8 { tower_pick(&mut s, 2); }
        assert_eq!(s.status, "top");
    }
    #[test]
    fn wires_match_good_boy_3_and_the_sniffer_changes_no_odds() {
        let mut s = Wires { bomb: 4, fair: 1.0, status: "cutting".into(), ..Default::default() };
        let mut seen = vec![wires_mult(&s)];
        for w in 0..4 { wires_cut(&mut s, w); seen.push(wires_mult(&s)); }
        assert_eq!(seen, vec![1.0, 1.2, 1.6, 2.4, 4.8]);
        assert_eq!(s.status, "cleared");
        // sniffing first: four unknown wires, so each cut pays what a fair four-wire game would (less 4%)
        let mut s = Wires { bomb: 4, fair: 1.0, status: "cutting".into(), ..Default::default() };
        wires_sniff(&mut s, 0);
        assert_eq!(s.sniffed, Some(0));
        wires_cut(&mut s, 0);
        assert!(s.cut.is_empty(), "a sniffed wire is set aside");
        wires_cut(&mut s, 1);
        assert_eq!(wires_mult(&s), 1.28);
        wires_cut(&mut s, 2);
        wires_cut(&mut s, 3);
        assert_eq!((s.status.as_str(), wires_mult(&s)), ("cleared", 3.84));
        assert!(!wires_can_sniff(&s));
        let mut s = Wires { bomb: 2, fair: 1.0, status: "cutting".into(), ..Default::default() };
        wires_cut(&mut s, 2);
        assert_eq!((s.status.as_str(), s.safe_cuts()), ("boom", 0));
    }
    #[test]
    fn bingo_gives_back_about_95_percent() {
        let mut rng = lcg(7);
        let (mut paid, games) = (0.0, 60_000);
        for _ in 0..games {
            let mut s = bingo_start(1, 0, &mut rng);
            assert_eq!((s.card.len(), s.order.len()), (16, 10));
            while s.status == "drawing" { bingo_draw(&mut s); }
            paid += bingo_pays(&s);
        }
        let back = paid / games as f64;
        assert!((0.90..0.99).contains(&back), "{back}");
    }
    #[test]
    fn memory_combos_and_mistakes() {
        let mut s = Memory { cards: vec![0, 0, 1, 1, 2, 3, 2, 3], status: "playing".into(), ..Default::default() };
        memory_flip(&mut s, 0);
        memory_flip(&mut s, 1);
        memory_flip(&mut s, 2);
        memory_flip(&mut s, 3);
        assert_eq!((s.found.len(), s.streak, s.best), (4, 2, 2));
        memory_flip(&mut s, 4);
        memory_flip(&mut s, 5);
        assert_eq!((s.mistakes, s.streak, s.open.len()), (1, 0, 2));
        memory_flip(&mut s, 4); // the wrong pair turns back over, and this card is opened again
        memory_flip(&mut s, 6);
        memory_flip(&mut s, 5);
        memory_flip(&mut s, 7);
        assert_eq!((s.status.as_str(), s.best), ("done", 2));
        assert_eq!((memory_mult(0, 8), memory_mult(6, 3), memory_mult(7, 0), memory_mult(14, 5), memory_mult(15, 8)), (2.5, 2.2, 1.4, 1.5, 0.0));
    }
    #[test]
    fn hangman_letters_words_hints_and_pay() {
        let new = || Hangman { word: "pancake".into(), category: "Food".into(), status: "guessing".into(), ..Default::default() };
        let mut s = new();
        assert_eq!(hangman_mult(&s), 2.2);
        assert_eq!(hangman_guess(&mut s, "A"), ("Yes, there are 2 A!".to_string(), 0));
        assert_eq!(hangman_guess(&mut s, "z"), ("No Z.".to_string(), 1));
        assert_eq!(hangman_guess(&mut s, "z").1, 0);
        assert_eq!(hangman_guess(&mut s, "pankace").1, 2);
        assert_eq!((s.wrong, hangman_mult(&s)), (3, 1.75));
        assert_eq!(hangman_guess(&mut s, "3").0, "Use letters only.");
        let c = hangman_hint(&mut s, 0).unwrap();
        assert!(s.word.contains(c) && s.wrong == 4);
        assert_eq!(hangman_guess(&mut s, "pancake").0, "You got the word!");
        assert!(s.status == "won" && s.bonus > 0.0 && hangman_mult(&s) > 1.6);
        let mut s = new();
        for c in ["x", "y", "z", "q", "w", "v"] { hangman_guess(&mut s, c); }
        assert_eq!(s.status, "lost");
        let mut s = new();
        for c in ["p", "a", "n", "c", "k", "e"] { hangman_guess(&mut s, c); }
        assert_eq!((s.status.as_str(), hangman_mult(&s)), ("won", 2.2));
        // every word is plain lower-case letters and short enough for the picture
        assert_eq!(HANGMAN_WORDS.iter().map(|c| c.1.len()).sum::<usize>(), 97);
        assert!(HANGMAN_WORDS.iter().flat_map(|c| c.1.iter()).all(|w| w.len() <= 10 && w.chars().all(|c| c.is_ascii_lowercase())));
    }
    #[test]
    fn trivia_shuffles_answers_and_pays_for_speed_and_streaks() {
        let mut rng = lcg(3);
        for _ in 0..200 {
            let t = trivia_start(10, 0, "anime", &mut rng);
            assert_eq!((t.cat.as_str(), t.answers.len()), ("anime", 4));
            let row = pool().iter().find(|c| c.id == "anime").unwrap().rows.iter().find(|r| r[0] == t.q).unwrap();
            assert_eq!(t.answers[t.right], row[1]);
        }
        assert_eq!(TRIVIA.iter().map(|c| c.2.len()).sum::<usize>(), 73);
        // the extra pool: at least 2,500 more, every one with four different answers that fit the picture
        let all: Vec<_> = pool().iter().flat_map(|c| c.rows.iter()).collect();
        assert!(all.len() >= 73 + 2500, "only {} questions", all.len());
        let mut seen = std::collections::HashSet::new();
        for r in &all {
            assert!(seen.insert(r[0]), "repeated: {}", r[0]);
            let mut a: Vec<String> = r[1..].iter().map(|x| x.to_lowercase()).collect();
            a.sort();
            a.dedup();
            assert_eq!(a.len(), 4, "answers repeat: {}", r[0]);
            assert!(r[0].chars().count() <= 110 && r[1..].iter().all(|x| !x.is_empty() && x.chars().count() <= 30), "too long: {}", r[0]);
        }
        assert_eq!((trivia_mult(3000, 0), trivia_mult(12_000, 0), trivia_mult(3000, 4), trivia_mult(3000, 99)), (1.8, 1.6, 2.0, 2.1));
        assert_eq!(trivia_label("anime"), "Anime");
    }
    #[test]
    fn a_duel_plays_to_five() {
        let mut d = Duel { ids: ["a".into(), "b".into()], names: ["A".into(), "B".into()], status: "aim".into(), ..Default::default() };
        duel_aim(&mut d, 0, false);
        assert_eq!((d.status.as_str(), d.waiting_on()), ("stand", 1));
        duel_stand(&mut d, 0, &mut |_| 0); // stood in the right place: returned, B hits next
        assert_eq!((d.hitter, d.rally, d.score), (1, 1, [0, 0]));
        duel_aim(&mut d, 2, false);
        duel_stand(&mut d, 0, &mut |_| 0); // two zones away: a point for B, A serves
        assert_eq!((d.score, d.hitter), ([0, 1], 0));
        duel_aim(&mut d, 1, true);
        duel_stand(&mut d, 1, &mut |_| 0); // the smash flew out
        assert_eq!(d.score, [0, 2]);
        duel_aim(&mut d, 1, true);
        duel_stand(&mut d, 0, &mut |_| 99); // a smash that stayed in and was not reached
        assert_eq!(d.score, [1, 2]);
        // against Good Boy the game always reaches the end
        let mut rng = lcg(11);
        let mut d = Duel { ids: ["a".into(), "bot".into()], names: ["A".into(), "Good Boy".into()], status: "aim".into(), ..Default::default() };
        for _ in 0..400 {
            if d.status == "over" { break; }
            if d.status == "aim" { duel_aim(&mut d, 1, false); } else { duel_stand(&mut d, 1, &mut rng); }
            duel_bot(&mut d, &mut rng);
        }
        assert!(d.status == "over" && d.winner().is_some(), "{d:?}");
    }
}
