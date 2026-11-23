//! Fishing, exactly as Good Boy 3 has it: the world (places, fish, rods, bait, tackle), what bites, and the reeling
//! mini-game. Every list is generated from Good Boy 3's own source (`fishing_data.rs`) and every rule is the same,
//! so a member's level, rods, stars and catches carry over untouched. The tests compare this file's answers with
//! answers recorded from Good Boy 3 itself (fixtures/fishing.json).
//!
//! The mini-game is driven by button presses only: each press is one step, the fish moves from a seeded generator,
//! and the whole game is the small state saved after every press.

use crate::fishing_data::{BAITS, BIOMES, MORE_SPECIES, NOUNS, SPECIES, TACKLE, WORDS};
pub use crate::fishing_data::RODS;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

pub const TRACK: i64 = 20;
pub const IDLE_MS: i64 = 45_000;
pub const MAX_STEPS: i64 = 80;
pub const BITE_MIN_MS: i64 = 2000;
pub const BITE_SPREAD_MS: i64 = 2500;
pub const STRIKE_MS: i64 = 3000;
pub const SURGE_MS: i64 = 5000;
pub const FISH_TOTAL: usize = 2000;
pub const MAX_STARS: i64 = 5;
pub const MAX_LEVEL: i64 = 4000;
pub const SUNKEN_CHANCE: f64 = 0.004;

/// JavaScript's `Math.round`: halves go up.
pub fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

// ------------------------------------------------------------------ randomness
/// Good Boy 3's small seeded generator (mulberry32): the same seed always gives the same numbers in [0, 1).
pub struct Seeded(u32);
pub fn seeded(seed: u32) -> Seeded {
    Seeded(seed)
}
fn imul(a: u32, b: u32) -> u32 {
    a.wrapping_mul(b)
}
impl Seeded {
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = self.0;
        t = imul(t ^ (t >> 15), t | 1);
        t ^= t.wrapping_add(imul(t ^ (t >> 7), t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

// ------------------------------------------------------------------ rarities, places
#[derive(Debug, Clone, Copy)]
pub struct Rarity {
    pub id: &'static str,
    pub label: &'static str,
    pub color: u32,
    pub weight: f64,
    pub xp: f64,
    pub escape: i64,
    pub agility: i64,
    pub pull: i64,
}
pub const RARITIES: [Rarity; 6] = [
    Rarity { id: "common", label: "Common", color: 0x95a5a6, weight: 55.0, xp: 10.0, escape: 5, agility: 1, pull: 0 },
    Rarity { id: "uncommon", label: "Uncommon", color: 0x2ecc71, weight: 25.0, xp: 20.0, escape: 6, agility: 1, pull: 2 },
    Rarity { id: "rare", label: "Rare", color: 0x3498db, weight: 12.0, xp: 45.0, escape: 8, agility: 2, pull: 4 },
    Rarity { id: "epic", label: "Epic", color: 0x9b59b6, weight: 5.5, xp: 100.0, escape: 10, agility: 2, pull: 7 },
    Rarity { id: "legendary", label: "Legendary", color: 0xf1c40f, weight: 2.0, xp: 250.0, escape: 12, agility: 3, pull: 10 },
    Rarity { id: "mythical", label: "Mythical", color: 0xe91e63, weight: 0.5, xp: 600.0, escape: 14, agility: 4, pull: 14 },
];
pub fn rarity_index(id: &str) -> usize {
    RARITIES.iter().position(|r| r.id == id).unwrap_or(0)
}
pub fn rarity_by_id(id: &str) -> &'static Rarity {
    &RARITIES[rarity_index(id)]
}
pub const MUTATED_CHANCE: f64 = 0.02;
pub const CORRUPTED_CHANCE: f64 = 0.004;
pub fn mutation_value(m: &str) -> f64 {
    if m == "corrupted" { 5.0 } else { 2.5 }
}
pub fn mutation_weight(m: &str) -> f64 {
    if m == "corrupted" { 1.0 } else { 1.3 }
}

#[derive(Debug, Clone, Copy)]
pub struct Biome {
    pub id: &'static str,
    pub label: &'static str,
    pub emoji: &'static str,
    pub level: i64,
    pub blurb: &'static str,
    pub xp: f64,
    pub hard: i64,
    pub corruption: f64,
}
pub fn biomes() -> Vec<Biome> {
    BIOMES.iter().map(|b| Biome { id: b.0, label: b.1, emoji: b.2, level: b.3, blurb: b.4, xp: b.5, hard: b.6, corruption: b.7 }).collect()
}
pub fn biome_by_id(id: &str) -> Biome {
    let b = BIOMES.iter().find(|b| b.0 == id).unwrap_or(&BIOMES[0]);
    Biome { id: b.0, label: b.1, emoji: b.2, level: b.3, blurb: b.4, xp: b.5, hard: b.6, corruption: b.7 }
}

// ------------------------------------------------------------------ the fish
#[derive(Debug, Clone, PartialEq)]
pub struct Fish {
    pub id: String,
    pub name: String,
    pub biome: &'static str,
    pub rarity: &'static str,
    pub min: f64,
    pub max: f64,
    pub base: f64,
}
fn str_hash(s: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for c in s.encode_utf16() {
        h ^= u32::from(c);
        h = imul(h, 0x0100_0193);
    }
    h
}
fn size_range(rarity: &str) -> (f64, f64) {
    match rarity { "common" => (0.02, 0.6), "uncommon" => (0.3, 5.0), "rare" => (3.0, 40.0), "epic" => (15.0, 180.0), "legendary" => (80.0, 700.0), _ => (400.0, 3500.0) }
}
fn abyss_base(rarity: &str) -> f64 {
    match rarity { "common" => 360.0, "uncommon" => 900.0, "rare" => 2700.0, "epic" => 6700.0, "legendary" => 22000.0, _ => 112_000.0 }
}
fn counts(late: bool, last: bool) -> [usize; 6] {
    if late { [if last { 29 } else { 30 }, 22, 14, 9, 5, 3] } else { [26, 19, 12, 8, 5, 2] }
}
fn round2(x: f64) -> f64 {
    js_round(x * 100.0) as f64 / 100.0
}
fn make_fish() -> Vec<Fish> {
    let mut handmade: Vec<Fish> = Vec::new();
    for (table, offset) in [(SPECIES, 0usize), (MORE_SPECIES, 6)] {
        for (biome, list) in table {
            let biome_id = BIOMES.iter().find(|b| b.0 == *biome).map(|b| b.0).unwrap_or("bay");
            for (k, (name, min, max, base)) in list.iter().enumerate() {
                handmade.push(Fish { id: format!("{biome}-{}", k + offset), name: name.to_string(), biome: biome_id, rarity: RARITIES[k].id, min: *min, max: *max, base: *base });
            }
        }
    }
    let mut taken: std::collections::HashSet<String> = handmade.iter().map(|f| f.name.clone()).collect();
    let mut made_more = Vec::new();
    let late_ids: Vec<&str> = BIOMES.iter().skip(9).map(|b| b.0).collect();
    for b in BIOMES.iter() {
        let mut rand = seeded(str_hash(&format!("fish:{}", b.0)));
        let words = WORDS.iter().find(|w| w.0 == b.0).map(|w| w.1).unwrap_or(&[]);
        let late = late_ids.iter().position(|x| *x == b.0);
        let mut n = 12;
        for r in RARITIES.iter() {
            let reference = handmade.iter().find(|f| f.biome == b.0 && f.rarity == r.id);
            let base = match late { Some(l) => abyss_base(r.id) * 1.22f64.powi(l as i32 + 1), None => reference.map(|f| f.base).unwrap_or(0.0) };
            let (lo, hi) = match late {
                Some(l) => { let s = size_range(r.id); (s.0 * (1.0 + l as f64 * 0.06), s.1 * (1.0 + l as f64 * 0.06)) }
                None => reference.map(|f| (f.min, f.max)).unwrap_or((0.0, 0.0)),
            };
            let want = counts(late.is_some(), late.is_some_and(|l| l == late_ids.len() - 1))[rarity_index(r.id)];
            let nouns = NOUNS.iter().find(|x| x.0 == r.id).map(|x| x.1).unwrap_or(&[]);
            let (mut made, mut tries) = (0, 0);
            while made < want && tries < 2000 {
                tries += 1;
                let word = words[(rand.next() * words.len() as f64).floor() as usize];
                let noun = nouns[(rand.next() * nouns.len() as f64).floor() as usize];
                let name = if r.id == "mythical" { format!("The {word} {noun}") } else { format!("{word} {noun}") };
                if taken.contains(&name) { continue; }
                taken.insert(name.clone());
                let spread = 0.8 + rand.next() * 0.45;
                let min = round2(lo * spread);
                let max = round2(hi * spread);
                let id = format!("{}-{n}", b.0);
                n += 1;
                let value = js_round(base * (0.9 + rand.next() * 0.25)) as f64;
                made_more.push(Fish { id, name, biome: b.0, rarity: r.id, min: min.max(0.01), max: max.max(min + 0.05), base: value });
                made += 1;
            }
        }
    }
    handmade.extend(made_more);
    handmade
}
/// Every fish, in Good Boy 3's order.
pub fn fish_list() -> &'static [Fish] {
    static ALL: OnceLock<Vec<Fish>> = OnceLock::new();
    ALL.get_or_init(make_fish)
}
pub fn fish_by_id(id: &str) -> Option<&'static Fish> {
    fish_list().iter().find(|f| f.id == id)
}
/// The fish of one place, in rarity order (first and second fish of each rarity side by side).
pub fn fish_in(biome: &str) -> Vec<&'static Fish> {
    let mut v: Vec<&Fish> = fish_list().iter().filter(|f| f.biome == biome).collect();
    let n = |f: &Fish| f.id.rsplit('-').next().and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    v.sort_by(|a, b| rarity_index(a.rarity).cmp(&rarity_index(b.rarity)).then(n(a).cmp(&n(b))));
    v
}

// ------------------------------------------------------------------ rods, bait, tackle
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Earn {
    Sunken(i64),
    Streak(i64),
    Weeklies(i64),
    Collection(&'static str),
}
#[derive(Debug, Clone, Copy)]
pub struct RodDef {
    pub id: &'static str,
    pub label: &'static str,
    pub price: i64,
    pub level: i64,
    pub luck: f64,
    pub control: i64,
    pub power: i64,
    pub step: i64,
    pub line: i64,
    pub home: &'static [&'static str],
    pub perk: &'static str,
    pub earn: Option<Earn>,
    pub worth: i64,
}
pub fn rod_by_id(id: &str) -> &'static RodDef {
    RODS.iter().find(|r| r.id == id).unwrap_or(&RODS[0])
}
#[derive(Debug, Clone, Copy)]
pub struct Bait {
    pub id: &'static str,
    pub label: &'static str,
    pub price: i64,
    pub luck: f64,
    pub corruption: f64,
}
pub fn baits() -> Vec<Bait> {
    BAITS.iter().map(|b| Bait { id: b.0, label: b.1, price: b.2, luck: b.3, corruption: b.4 }).collect()
}
pub fn bait_by_id(id: &str) -> Bait {
    let b = BAITS.iter().find(|b| b.0 == id).unwrap_or(&BAITS[0]);
    Bait { id: b.0, label: b.1, price: b.2, luck: b.3, corruption: b.4 }
}
#[derive(Debug, Clone, Copy)]
pub struct Tackle {
    pub id: &'static str,
    pub label: &'static str,
    pub price: i64,
    pub desc: &'static str,
    pub tension: f64,
    pub calm: i64,
    pub bonus: i64,
    pub mutation: f64,
}
pub fn tackles() -> Vec<Tackle> {
    TACKLE.iter().map(|t| Tackle { id: t.0, label: t.1, price: t.2, desc: t.3, tension: t.4, calm: t.5, bonus: t.6, mutation: t.7 }).collect()
}
pub fn tackle_by_id(id: &str) -> Tackle {
    let t = TACKLE.iter().find(|t| t.0 == id).unwrap_or(&TACKLE[0]);
    Tackle { id: t.0, label: t.1, price: t.2, desc: t.3, tension: t.4, calm: t.5, bonus: t.6, mutation: t.7 }
}
/// What each perk does: (emoji, label, description).
pub fn perk(id: &str) -> Option<(&'static str, &'static str, &'static str)> {
    Some(match id {
        "xp" => ("📘", "Fast learner", "+20% fishing XP"),
        "calm" => ("🫧", "Steady", "Fish dart around less"),
        "strike" => ("⚡", "Hair trigger", "Longer strike window and a bigger strike head start"),
        "tension" => ("🧵", "Soft line", "Line tension builds 25% slower"),
        "nosnap" => ("🔥", "Heatproof", "The line never snaps in its home places"),
        "corrupt" => ("🕳️", "Void-touched", "Corrupted fish 2.5× as likely"),
        "surge" => ("🌊", "Surge rider", "Answering a surge gives twice the gain"),
        "giant" => ("📏", "Big game", "Giant fish 3× as likely"),
        "mutation" => ("🧬", "Strange lure", "Mutations 1.5× as likely"),
        "value" => ("💰", "Appraiser", "Fish are worth 15% more"),
        "sunken" => ("⚓", "Salvager", "Sunken rods 3× as likely to be fished up"),
        "quickbite" => ("⏱️", "Quick bite", "Fish bite much faster, and the strike window is longer"),
        "tamer" => ("🐉", "Tamer", "Legendary and mythical fish fight 40% less"),
        "collector" => ("🏅", "Keepsake", "Fish from its home place are worth 25% more"),
        "wanderer" => ("🧭", "Wanderer", "At home in every place"),
        "mythic" => ("🌟", "Mythic", "At home in every place, +20% XP, and the line never snaps"),
        _ => return None,
    })
}

/// A rod's numbers with its stars and the place it's used in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RodStats {
    pub id: String,
    pub label: String,
    pub perk: Option<String>,
    pub stars: i64,
    pub home: bool,
    pub luck: f64,
    pub control: i64,
    pub power: i64,
    pub step: i64,
    pub line: i64,
}
pub fn rod_stats(id: &str, stars: i64, biome: Option<&str>) -> RodStats {
    let r = rod_by_id(id);
    let n = stars.clamp(1, MAX_STARS) - 1;
    let home = biome.is_some_and(|b| r.perk == "mythic" || r.perk == "wanderer" || r.home.contains(&b));
    let ctrl = r.control + i64::from(n >= 2) + i64::from(n >= 4);
    let h = |yes: f64| if home { yes } else { 1.0 };
    RodStats {
        id: r.id.into(),
        label: r.label.into(),
        perk: (!r.perk.is_empty()).then(|| r.perk.to_string()),
        stars: n + 1,
        home,
        luck: js_round((r.luck + 0.05 * n as f64 + if home { 0.4 } else { 0.0 }) * 100.0) as f64 / 100.0,
        control: ctrl.min(16),
        power: js_round(r.power as f64 * (1.0 + 0.06 * n as f64) * h(1.2)),
        step: r.step,
        line: js_round(r.line as f64 * (1.0 + 0.05 * n as f64) * h(1.15)),
    }
}
/// What going from `stars` to `stars + 1` costs: coins plus fish of one rarity. None at the top.
pub fn upgrade_cost(id: &str, stars: i64) -> Option<(i64, &'static str, i64)> {
    if stars >= MAX_STARS { return None; }
    let r = rod_by_id(id);
    let worth = 2000.max(if r.price != 0 { r.price } else { r.worth });
    let (mult, rarity, fish) = [(0.3, "common", 15), (0.6, "uncommon", 12), (1.0, "rare", 8), (1.6, "epic", 4)][(stars - 1).clamp(0, 3) as usize];
    Some((js_round(worth as f64 * mult), rarity, fish))
}
/// The next sunken rod a member has not got, if any.
pub fn next_sunken(owned: &[String]) -> Option<&'static RodDef> {
    let mut v: Vec<&RodDef> = RODS.iter().filter(|r| matches!(r.earn, Some(Earn::Sunken(_)))).collect();
    v.sort_by_key(|r| match r.earn { Some(Earn::Sunken(o)) => o, _ => 0 });
    v.into_iter().find(|r| !owned.iter().any(|o| o == r.id))
}
/// Challenge rods earned by now that a member does not own yet.
pub fn challenge_rods_due(streak: i64, weeklies: i64, owned: &[String]) -> Vec<&'static RodDef> {
    RODS.iter().filter(|r| !owned.iter().any(|o| o == r.id) && match r.earn { Some(Earn::Streak(d)) => streak >= d, Some(Earn::Weeklies(c)) => weeklies >= c, _ => false }).collect()
}
/// How a rod is earned, in words.
pub fn earn_text(r: &RodDef) -> String {
    match r.earn {
        None if r.price != 0 => format!("Shop · {} coins · level {}", crate::card::group(r.price), r.level),
        None => "Everyone starts with it".into(),
        Some(Earn::Collection(b)) => format!("Catch every fish in {}", biome_by_id(b).label),
        Some(Earn::Sunken(_)) => "Fished up in Ironwreck Graveyard (rare)".into(),
        Some(Earn::Streak(d)) => format!("A {d}-day fishing challenge streak"),
        Some(Earn::Weeklies(c)) => format!("Finish {c} weekly fishing challenges"),
    }
}

// ------------------------------------------------------------------ levels
const SOFT_CAP: i64 = 32;
const OLD_CAP: i64 = 100;
fn old_curve(l: i64) -> i64 {
    let l = l as f64;
    js_round(100.0 * (l - 1.0).powf(1.5) + if l > SOFT_CAP as f64 { 40.0 * (l - SOFT_CAP as f64).powf(2.2) } else { 0.0 })
}
fn past() -> &'static Vec<i64> {
    static P: OnceLock<Vec<i64>> = OnceLock::new();
    P.get_or_init(|| {
        let step = old_curve(OLD_CAP) - old_curve(OLD_CAP - 1);
        let mut v = vec![0i64];
        for l in OLD_CAP + 1..=MAX_LEVEL {
            let last = *v.last().unwrap_or(&0);
            v.push(last + js_round(step as f64 * (l as f64 / OLD_CAP as f64).powf(0.6)));
        }
        v
    })
}
/// Total XP needed to reach `level` (level 1 needs 0).
pub fn xp_for_level(level: i64) -> i64 {
    let l = level.clamp(1, MAX_LEVEL);
    if l <= OLD_CAP { old_curve(l) } else { old_curve(OLD_CAP) + past()[(l - OLD_CAP) as usize] }
}
#[derive(Debug, Clone, PartialEq)]
pub struct Level {
    pub level: i64,
    pub into: i64,
    pub needed: i64,
    pub max: bool,
}
pub fn level_from_xp(xp: i64) -> Level {
    let (mut lo, mut hi) = (1, MAX_LEVEL);
    while lo < hi {
        let mid = (lo + hi + 1) >> 1;
        if xp_for_level(mid) <= xp { lo = mid; } else { hi = mid - 1; }
    }
    if lo >= MAX_LEVEL { return Level { level: MAX_LEVEL, into: xp - xp_for_level(MAX_LEVEL), needed: 0, max: true }; }
    Level { level: lo, into: xp - xp_for_level(lo), needed: xp_for_level(lo + 1) - xp_for_level(lo), max: false }
}

// ------------------------------------------------------------------ what bites
pub fn rarity_weights(luck: f64) -> Vec<(&'static str, f64)> {
    RARITIES.iter().enumerate().map(|(k, r)| (r.id, r.weight * (1.0 + luck).powi(k as i32))).collect()
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Catch {
    pub species: String,
    pub rarity: String,
    pub weight: f64,
    pub giant: bool,
    pub mutation: Option<String>,
    pub value: i64,
}
pub struct CastGear<'a> {
    pub biome: &'a str,
    pub rod: &'a str,
    pub bait: &'a str,
    pub tackle: &'a str,
    pub stars: i64,
    pub bonus_luck: f64,
}
/// What bites. `rand` gives numbers in [0, 1).
pub fn roll_catch(g: &CastGear, rand: &mut dyn FnMut() -> f64) -> Catch {
    let b = biome_by_id(g.biome);
    let rd = rod_stats(g.rod, g.stars, Some(g.biome));
    let bt = bait_by_id(g.bait);
    let tk = tackle_by_id(g.tackle);
    let weights = rarity_weights(rd.luck + bt.luck + g.bonus_luck);
    let total: f64 = weights.iter().map(|w| w.1).sum();
    let mut r = rand() * total;
    let mut rarity = weights[0].0;
    for w in &weights {
        if r < w.1 { rarity = w.0; break; }
        r -= w.1;
    }
    let options: Vec<&Fish> = fish_list().iter().filter(|f| f.biome == b.id && f.rarity == rarity).collect();
    let species = options.get((rand() * options.len() as f64).floor() as usize).or(options.first()).copied().unwrap_or(&fish_list()[0]);
    // smaller fish are more common: the roll is squared
    let roll = rand();
    let mut weight = species.min + (species.max - species.min) * roll * roll;
    let giant = roll > if rd.perk.as_deref() == Some("giant") { 0.94 } else { 0.98 };
    if giant { weight *= 1.6; }
    let mult = tk.mutation * if rd.perk.as_deref() == Some("mutation") { 1.5 } else { 1.0 };
    let corrupt_chance = (CORRUPTED_CHANCE + b.corruption + bt.corruption) * mult * if rd.perk.as_deref() == Some("corrupt") { 2.5 } else { 1.0 };
    let mut_roll = rand();
    let mutation = if mut_roll < corrupt_chance { Some("corrupted") } else if mut_roll < corrupt_chance + MUTATED_CHANCE * mult { Some("mutated") } else { None };
    if let Some(m) = mutation { weight *= mutation_weight(m); }
    weight = js_round(weight * 100.0) as f64 / 100.0;
    let worth = if rd.perk.as_deref() == Some("value") { 1.15 } else if rd.perk.as_deref() == Some("collector") && rd.home { 1.25 } else { 1.0 };
    Catch { species: species.id.clone(), rarity: rarity.into(), weight, giant, mutation: mutation.map(str::to_string), value: js_round(fish_value(species, weight, mutation) as f64 * worth) }
}
pub fn fish_value(species: &Fish, weight: f64, mutation: Option<&str>) -> i64 {
    let avg = (species.min + species.max) / 2.0;
    let v = species.base * (weight / avg).powf(0.8) * mutation.map(mutation_value).unwrap_or(1.0);
    1.max(js_round(v))
}
/// XP for a catch in a place, with the rod's perk.
pub fn catch_xp(c: &Catch, biome: Option<&str>, perk: Option<&str>) -> i64 {
    js_round(rarity_by_id(&c.rarity).xp * if c.mutation.is_some() { 1.5 } else { 1.0 } * if c.giant { 1.25 } else { 1.0 } * biome.map(|b| biome_by_id(b).xp).unwrap_or(1.0) * if matches!(perk, Some("xp") | Some("mythic")) { 1.2 } else { 1.0 })
}

// ------------------------------------------------------------------ the reeling mini-game
pub const SURGE_KINDS: [&str; 4] = ["boltLeft", "boltRight", "leap", "tired"];
/// (answer, emoji, text) of a surge.
pub fn surge(kind: &str) -> (&'static str, &'static str, &'static str) {
    match kind {
        "boltLeft" => ("left", "⬅️", "It bolts **left**! Pull ◀ now!"),
        "boltRight" => ("right", "➡️", "It bolts **right**! Pull ▶ now!"),
        "leap" => ("slack", "🌊", "It **leaps** out of the water! Give it 🪢 Slack!"),
        _ => ("reel", "💦", "It is **tiring**! 🎣 Reel hard!"),
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Surge {
    pub kind: String,
    pub at: i64,
}
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Surges {
    pub won: i64,
    pub lost: i64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reel {
    pub gear: RodStats,
    pub rod: String,
    pub tackle: String,
    pub fish: Catch,
    pub seed: u32,
    pub step: i64,
    pub zone: i64,
    pub pos: i64,
    pub progress: f64,
    pub tension: f64,
    pub status: String,
    pub started_at: i64,
    pub last_at: i64,
    pub bite_at: i64,
    pub struck: Option<bool>,
    pub surge: Option<Surge>,
    pub last_surge: i64,
    pub surges: Surges,
    pub no_surges: bool,
    pub note: Option<String>,
    pub reason: Option<String>,
    pub biome: Option<String>,
    pub bait: Option<String>,
}
/// `bite_ms`: how long until the bite (None: a few seconds, from the seed). `surges`: false turns surges off.
#[allow(clippy::too_many_arguments)]
pub fn start_reel(rod: &str, tackle: &str, fish: Catch, seed: u32, now: i64, bite_ms: Option<i64>, surges: bool, stars: i64, biome: Option<&str>) -> Reel {
    let rd = rod_stats(rod, stars, biome);
    let zone = (TRACK - rd.control) / 2;
    let mut r = seeded(seed ^ 0x2545_f491);
    let wait = bite_ms.unwrap_or_else(|| BITE_MIN_MS + (r.next() * BITE_SPREAD_MS as f64).floor() as i64);
    let bite_at = now + if rd.perk.as_deref() == Some("quickbite") && bite_ms.is_none() { js_round(wait as f64 * 0.4) } else { wait };
    let pos = (seeded(seed).next() * TRACK as f64).floor() as i64;
    Reel { rod: rd.id.clone(), gear: rd, tackle: tackle_by_id(tackle).id.into(), fish, seed, step: 0, zone, pos, progress: 30.0, tension: 0.0, status: "reeling".into(), started_at: now, last_at: now, bite_at, struck: None, surge: None, last_surge: 0, surges: Surges::default(), no_surges: !surges, note: None, reason: None, biome: None, bait: None }
}
/// Has the fish bitten yet?
pub fn bitten(s: &Reel, now: i64) -> bool {
    s.bite_at == 0 || now >= s.bite_at
}
fn strike_ms(g: &RodStats) -> i64 {
    STRIKE_MS + match g.perk.as_deref() { Some("quickbite") => 2000, Some("strike") => 1500, _ => 0 }
}
pub fn in_zone(s: &Reel) -> bool {
    s.pos >= s.zone && s.pos < s.zone + s.gear.control
}
fn hard_of(s: &Reel) -> i64 {
    s.biome.as_deref().map(|b| biome_by_id(b).hard).unwrap_or(0)
}
fn move_fish(s: &mut Reel) {
    let mut rand = seeded((s.seed as u64 + s.step as u64 * 7919) as u32);
    let agility = 1.max(rarity_by_id(&s.fish.rarity).agility + hard_of(s) / 2 - tackle_by_id(&s.tackle).calm - i64::from(s.gear.perk.as_deref() == Some("calm")));
    let dart = rand.next() < 0.18;
    let dist = if dart { agility + 1 + (rand.next() * 2.0).floor() as i64 } else { (rand.next() * (agility + 1) as f64).floor() as i64 };
    let dir = if rand.next() < 0.5 { -1 } else { 1 };
    let mut p = s.pos + dir * dist;
    if p < 0 { p = -p; }
    if p > TRACK - 1 { p = 2 * (TRACK - 1) - p; }
    s.pos = p.clamp(0, TRACK - 1);
}
/// Plays one press: "left", "right", "reel" or "slack".
pub fn reel_step(s: &mut Reel, action: &str, now: i64) {
    if s.status != "reeling" { return; }
    s.note = None;
    if !bitten(s, now) {
        s.last_at = now;
        s.progress = 5f64.max(s.progress - 8.0);
        s.struck = Some(false);
        s.note = Some("early".into());
        return;
    }
    if now - s.last_at.max(s.bite_at) > IDLE_MS {
        s.status = "escaped".into();
        s.reason = Some("idle".into());
        return;
    }
    let rd = s.gear.clone();
    let tk = tackle_by_id(&s.tackle);
    let base = rarity_by_id(&s.fish.rarity);
    let hard = hard_of(s);
    let tame = if rd.perk.as_deref() == Some("tamer") && matches!(s.fish.rarity.as_str(), "legendary" | "mythical") { 0.6 } else { 1.0 };
    let escape = js_round((base.escape + hard) as f64 * tame) as f64;
    let pull = js_round((base.pull + hard * 2) as f64 * tame) as f64;
    let tension_mul = tk.tension * if rd.perk.as_deref() == Some("tension") { 0.75 } else { 1.0 };
    let power = rd.power as f64;
    // the strike: the first press after the bite
    if s.struck.is_none() {
        let struck = action == "reel" && now - s.bite_at <= strike_ms(&rd);
        s.struck = Some(struck);
        if struck {
            s.step += 1;
            s.last_at = now;
            s.progress = 99f64.min(s.progress + if rd.perk.as_deref() == Some("strike") { 25.0 } else { 15.0 });
            s.note = Some("strike".into());
            return;
        }
    }
    // a surge: the next press has to be the right answer, quickly
    if let Some(sg) = s.surge.clone() {
        let (answer, _, _) = surge(&sg.kind);
        let fast = now - sg.at <= SURGE_MS;
        s.step += 1;
        s.last_at = now;
        if action == answer && fast {
            s.surges.won += 1;
            s.note = Some("surge-won".into());
            s.progress += (12 + js_round(power / 3.0)) as f64 * if rd.perk.as_deref() == Some("surge") { 2.0 } else { 1.0 };
            s.tension = 0f64.max(s.tension - 15.0);
        } else {
            s.surges.lost += 1;
            s.note = Some(if fast { "surge-wrong" } else { "surge-slow" }.into());
            if sg.kind == "leap" { s.tension += (30.0 + pull) * tension_mul; } else { s.progress -= 10.0 + escape; }
        }
        s.surge = None;
        s.last_surge = s.step;
        finish(s, &rd);
        return;
    }
    s.step += 1;
    s.last_at = now;
    if action == "left" { s.zone = 0.max(s.zone - rd.step); }
    if action == "right" { s.zone = (TRACK - rd.control).min(s.zone + rd.step); }
    move_fish(s);
    let hit = in_zone(s);
    if action == "slack" {
        s.tension = 0f64.max(s.tension - 28.0);
        s.progress -= if hit { 2.0 } else { 5.0 };
    } else if action == "reel" {
        if hit {
            s.progress += power + tk.bonus as f64;
            s.tension += (8.0 + pull) * tension_mul;
        } else {
            s.progress -= escape;
            s.tension += (20.0 + pull) * tension_mul;
        }
    } else if hit {
        s.progress += js_round(power * 0.35) as f64;
        s.tension = 0f64.max(s.tension - 12.0);
    } else {
        s.progress -= (escape * 0.6).ceil();
        s.tension = 0f64.max(s.tension - 6.0);
    }
    // now and then the fish surges (more often for rarer fish); never twice in a row
    let roll = seeded((s.seed as u64 + s.step as u64 * 104_729) as u32).next();
    let chance = 0.1 + rarity_index(&s.fish.rarity) as f64 * 0.025;
    if !s.no_surges && s.step >= 3 && s.step - s.last_surge >= 4 && roll < chance {
        let k = (seeded(s.seed ^ ((s.step * 31) as u32)).next() * SURGE_KINDS.len() as f64).floor() as usize;
        s.surge = Some(Surge { kind: SURGE_KINDS[k].into(), at: now });
    }
    finish(s, &rd);
}
fn finish(s: &mut Reel, rd: &RodStats) {
    s.progress = 0f64.max(100f64.min(js_round(s.progress) as f64));
    s.tension = 0f64.max(js_round(s.tension) as f64);
    if (rd.perk.as_deref() == Some("nosnap") && rd.home) || rd.perk.as_deref() == Some("mythic") { s.tension = s.tension.min((rd.line - 1) as f64); }
    if s.tension >= rd.line as f64 { s.status = "snapped".into(); }
    else if s.progress >= 100.0 { s.status = "caught".into(); }
    else if s.progress <= 0.0 { s.status = "escaped".into(); s.reason = Some("pulled".into()); }
    else if s.step >= MAX_STEPS { s.status = "escaped".into(); s.reason = Some("tired".into()); }
}

pub fn meter(pct: f64, width: usize) -> String {
    let n = (js_round(pct / 100.0 * width as f64)).clamp(0, width as i64) as usize;
    format!("{}{}", "▰".repeat(n), "▱".repeat(width - n))
}
/// The slider line, e.g. `[░░░░■■■■◈■░░░░░░░░░░]`.
pub fn track_line(s: &Reel) -> String {
    let width = s.gear.control;
    let mut out = String::new();
    for k in 0..TRACK {
        let zone = k >= s.zone && k < s.zone + width;
        out.push(if k == s.pos { if zone { '◈' } else { '◆' } } else if zone { '■' } else { '░' });
    }
    format!("[{out}]")
}
/// The line above the panel: what just happened, or what to do right now.
pub fn reel_note(s: &Reel, now: i64) -> Option<String> {
    if s.status == "reeling" && !bitten(s, now) { return Some("🎣 The float bobs... wait for the bite, then **Reel** fast to strike.".into()); }
    if let Some(sg) = &s.surge {
        let (_, emoji, text) = surge(&sg.kind);
        return Some(format!("{emoji} {text} ({} seconds)", js_round(SURGE_MS as f64 / 1000.0)));
    }
    Some(match s.note.as_deref()? {
        "early" => "😬 Too early! You tugged before it bit.",
        "strike" => "⚡ **Strike!** Perfect timing, a head start.",
        "surge-won" => "🙌 **Nailed it!** Big gain.",
        "surge-wrong" => "❌ Wrong move!",
        "surge-slow" => "🐢 Too slow!",
        _ => return None,
    }.into())
}
pub fn reel_panel(s: &Reel) -> String {
    let line = s.gear.line as f64;
    format!("```\n{}\nCatch   {} {:>3}%\nTension {} {:>3}%\n```", track_line(s), meter(s.progress, 10), s.progress as i64, meter(s.tension / line * 100.0, 10), js_round(s.tension / line * 100.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../../fixtures/fishing.json")).expect("the recorded Good Boy 3 answers")
    }
    #[test]
    fn every_fish_is_the_same_as_in_good_boy_3() {
        let j = fixture();
        let want = j["fish"].as_array().unwrap();
        let got = fish_list();
        assert_eq!(got.len(), FISH_TOTAL);
        assert_eq!(got.len(), want.len());
        for (g, w) in got.iter().zip(want) {
            let w = w.as_array().unwrap();
            assert_eq!((g.id.as_str(), g.name.as_str(), g.biome, g.rarity), (w[0].as_str().unwrap(), w[1].as_str().unwrap(), w[2].as_str().unwrap(), w[3].as_str().unwrap()), "{g:?}");
            assert!((g.min - w[4].as_f64().unwrap()).abs() < 1e-9 && (g.max - w[5].as_f64().unwrap()).abs() < 1e-9 && (g.base - w[6].as_f64().unwrap()).abs() < 1e-9, "{g:?} vs {w:?}");
        }
    }
    #[test]
    fn levels_are_the_same_as_in_good_boy_3() {
        let j = fixture();
        for l in j["levels"].as_array().unwrap() {
            assert_eq!(xp_for_level(l[0].as_i64().unwrap()), l[1].as_i64().unwrap(), "level {}", l[0]);
        }
        for r in j["fromXp"].as_array().unwrap() {
            let x = r[0].as_f64().unwrap() as i64;
            let got = level_from_xp(x);
            assert_eq!((got.level, got.into, got.needed, got.max), (r[1].as_i64().unwrap(), r[2].as_i64().unwrap(), r[3].as_i64().unwrap(), r[4].as_bool().unwrap()), "xp {x}");
        }
    }
    #[test]
    fn rods_and_upgrade_costs_are_the_same_as_in_good_boy_3() {
        let j = fixture();
        for (id, list) in j["rodstats"].as_array().unwrap().iter().map(|r| (r[0].as_str().unwrap(), r[1].as_array().unwrap())) {
            for (k, want) in list.iter().enumerate() {
                let stars = [1, 3, 5][k];
                let home = rod_by_id(id).home.first().copied().unwrap_or("bay");
                let got = rod_stats(id, stars, Some(home));
                assert_eq!((got.control, got.power, got.line, got.step, got.stars, got.home), (want["control"].as_i64().unwrap(), want["power"].as_i64().unwrap(), want["line"].as_i64().unwrap(), want["step"].as_i64().unwrap(), want["stars"].as_i64().unwrap(), want["home"].as_bool().unwrap()), "{id} {stars}");
                assert!((got.luck - want["luck"].as_f64().unwrap()).abs() < 1e-9, "{id} {stars}: {} vs {}", got.luck, want["luck"]);
            }
        }
        for (id, list) in j["upgrades"].as_array().unwrap().iter().map(|r| (r[0].as_str().unwrap(), r[1].as_array().unwrap())) {
            for (k, want) in list.iter().enumerate() {
                let got = upgrade_cost(id, k as i64 + 1);
                match want {
                    Value::Null => assert!(got.is_none()),
                    w => assert_eq!(got, Some((w["coins"].as_i64().unwrap(), w["rarity"].as_str().unwrap(), w["fish"].as_i64().unwrap())), "{id} {k}"),
                }
            }
        }
    }
    #[test]
    fn what_bites_is_the_same_as_in_good_boy_3() {
        let j = fixture();
        for r in j["rolls"].as_array().unwrap() {
            let i = &r[0];
            let seed = r[1].as_u64().unwrap() as u32;
            let g = CastGear { biome: i["biome"].as_str().unwrap(), rod: i["rod"].as_str().unwrap(), bait: i["bait"].as_str().unwrap(), tackle: i["tackle"].as_str().unwrap(), stars: i["stars"].as_i64().unwrap(), bonus_luck: i["bonusLuck"].as_f64().unwrap() };
            let mut rng = seeded(seed ^ 0x5bd1_e995);
            let got = roll_catch(&g, &mut || rng.next());
            let w = &r[2];
            assert_eq!((got.species.as_str(), got.rarity.as_str(), got.giant, got.mutation.as_deref(), got.value), (w["species"].as_str().unwrap(), w["rarity"].as_str().unwrap(), w["giant"].as_bool().unwrap(), w["mutation"].as_str(), w["value"].as_i64().unwrap()), "{i}");
            assert!((got.weight - w["weight"].as_f64().unwrap()).abs() < 1e-9, "{i}");
            let perk = rod_stats(g.rod, g.stars, Some(g.biome)).perk;
            assert_eq!(catch_xp(&got, Some(g.biome), perk.as_deref()), r[3].as_i64().unwrap());
        }
    }
    #[test]
    fn every_reeling_game_plays_out_the_same_as_in_good_boy_3() {
        let j = fixture();
        for r in j["reels"].as_array().unwrap() {
            let i = &r[0];
            let seed = r[1].as_u64().unwrap() as u32;
            let w = &r[2];
            let fish = Catch { species: w["species"].as_str().unwrap().into(), rarity: w["rarity"].as_str().unwrap().into(), weight: w["weight"].as_f64().unwrap(), giant: w["giant"].as_bool().unwrap(), mutation: w["mutation"].as_str().map(str::to_string), value: w["value"].as_i64().unwrap() };
            let now0 = 1_800_000_000_000i64;
            let mut s = start_reel(i["rod"].as_str().unwrap(), i["tackle"].as_str().unwrap(), fish, seed, now0, None, true, i["stars"].as_i64().unwrap(), Some(i["biome"].as_str().unwrap()));
            s.biome = Some(i["biome"].as_str().unwrap().into());
            assert_eq!(s.bite_at - now0, r[3].as_i64().unwrap(), "bite time for seed {seed}");
            for (n, step) in r[4].as_array().unwrap().iter().enumerate() {
                reel_step(&mut s, step[0].as_str().unwrap(), step[1].as_i64().unwrap());
                let got = (s.progress as i64, s.tension as i64, s.pos, s.zone, s.status.clone(), s.reason.clone(), s.note.clone(), s.surge.as_ref().map(|x| x.kind.clone()));
                let want = (step[2].as_i64().unwrap(), step[3].as_i64().unwrap(), step[4].as_i64().unwrap(), step[5].as_i64().unwrap(), step[6].as_str().unwrap().to_string(), step[7].as_str().map(str::to_string), step[8].as_str().map(str::to_string), step[9].as_str().map(str::to_string));
                assert_eq!(got, want, "seed {seed} step {n} ({})", step[0]);
            }
        }
    }
    #[test]
    fn the_reel_panel_looks_the_same() {
        let mut s = start_reel("driftwood", "none", Catch { species: "bay-0".into(), rarity: "common".into(), weight: 0.1, giant: false, mutation: None, value: 8 }, 7, 0, Some(0), false, 1, Some("bay"));
        s.pos = 8;
        s.zone = 7;
        assert_eq!(track_line(&s), "[░░░░░░░■◈■■■░░░░░░░░]");
        assert!(reel_panel(&s).contains("Catch   ▰▰▰▱▱▱▱▱▱▱  30%"));
    }
}
