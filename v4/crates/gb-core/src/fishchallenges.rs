//! Fishing challenges, exactly as Good Boy 3 has them: 3 daily challenges (new every day at midnight UTC) and 1 weekly
//! challenge (new every Monday), picked for each member from the places they have unlocked so they are always
//! possible. The same member, server and day always get the same challenges. Finishing all 3 dailies pays a bonus
//! and grows a streak. The tests compare every answer with answers recorded from Good Boy 3.

use crate::fishing::{self as F, js_round, Catch};
use serde::{Deserialize, Serialize};

const DAY: i64 = 86_400_000;
const DAILY_KINDS: [&str; 7] = ["catch", "place", "rarity", "species", "heavy", "sell", "variety"];
const WEEKLY_KINDS: [&str; 5] = ["mutation", "bigrarity", "catch", "place", "giant"];

/// The day (UTC) as YYYY-MM-DD.
pub fn day_key(now: i64) -> String {
    crate::time::date(now)
}
fn midnight(key: &str) -> i64 {
    let p: Vec<i64> = key.split('-').map(|x| x.parse().unwrap_or(0)).collect();
    if p.len() == 3 { crate::time::days_from_civil(p[0], p[1], p[2]) * DAY } else { 0 }
}
/// The Monday (UTC) that starts the week holding `now`.
pub fn week_key(now: i64) -> String {
    let days = now.div_euclid(DAY);
    // 1970-01-01 was a Thursday: (days + 4) % 7 is the weekday with Sunday = 0
    let sunday0 = (days + 4).rem_euclid(7);
    let back = (sunday0 + 6) % 7;
    let (y, m, d) = crate::time::civil(days - back);
    format!("{y:04}-{m:02}-{d:02}")
}
pub fn next_day_at(now: i64) -> i64 {
    midnight(&day_key(now)) + DAY
}
pub fn next_week_at(now: i64) -> i64 {
    midnight(&week_key(now)) + 7 * DAY
}
pub fn yesterday_key(now: i64) -> String {
    day_key(midnight(&day_key(now)) - DAY)
}

fn hash(s: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for c in s.encode_utf16() {
        h ^= u32::from(c);
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}
/// Two significant figures, so rewards and goals read nicely (1,234 becomes 1,200).
fn nice(n: f64) -> i64 {
    if n < 100.0 { return 1.max(js_round(n)); }
    let p = 10f64.powi(n.log10().floor() as i32 - 1);
    js_round(n / p) * p as i64
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Reward {
    pub coins: i64,
    pub xp: i64,
}
/// Rewards for a member at `level`: coins grow with level; XP is a share of what their next level needs.
pub fn rewards(level: i64) -> (Reward, Reward) {
    let lv = F::level_from_xp(F::xp_for_level(level));
    let coins = nice(150.0 * (1.0 + (level as f64).powf(1.3) / 6.0));
    let xp = |floor: i64, share: f64| if lv.max { 0 } else { floor.max(js_round(lv.needed as f64 * share)) };
    (Reward { coins, xp: xp(10, 0.12) }, Reward { coins: coins * 5, xp: xp(50, 0.6) })
}
pub struct StreakBonus {
    pub coins: i64,
    pub bait: &'static str,
    pub bait_qty: i64,
}
/// The streak bonus for finishing all 3 dailies: more coins for every day in a row (up to 7), plus some bait.
pub fn streak_bonus(level: i64, streak: i64) -> StreakBonus {
    let days = streak.clamp(1, 7);
    let bait = if level >= 40 { "stormfly" } else if level >= 12 { "glowgrub" } else if level >= 5 { "shrimp" } else { "worm" };
    StreakBonus { coins: nice(rewards(level).0.coins as f64 * (1.0 + 0.25 * days as f64)), bait, bait_qty: 3 }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Challenge {
    pub kind: String,
    pub goal: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub biome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rarity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub species: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
    pub reward: Reward,
}
fn top_places(level: i64) -> Vec<F::Biome> {
    let mut v: Vec<F::Biome> = F::biomes().into_iter().filter(|b| b.level <= level).collect();
    let keep = v.len().saturating_sub(3);
    v.drain(..keep);
    v.reverse();
    v
}
fn build(kind: &str, level: i64, rand: &mut F::Seeded, weekly: bool) -> Challenge {
    let places = top_places(level);
    let place = &places[(rand.next() * places.len() as f64).floor() as usize];
    let mut c = Challenge { kind: kind.into(), goal: 0, biome: None, rarity: None, species: None, weight: None, reward: Reward { coins: 0, xp: 0 } };
    match kind {
        "catch" => c.goal = if weekly { 60 + (rand.next() * 31.0).floor() as i64 } else { 8 + (rand.next() * 8.0).floor() as i64 },
        "place" => {
            c.biome = Some(if weekly { places[0].id } else { place.id }.into());
            c.goal = if weekly { 30 } else { 5 + (rand.next() * 6.0).floor() as i64 };
        }
        "rarity" => {
            let (rarity, goal) = if level < 5 { ("uncommon", 3) } else if level < 20 {
                [("uncommon", 4), ("rare", 2)][(rand.next() * 2.0).floor() as usize]
            } else { [("rare", 3), ("epic", 1)][(rand.next() * 2.0).floor() as usize] };
            c.rarity = Some(rarity.into());
            c.goal = goal;
        }
        "bigrarity" => {
            c.kind = "rarity".into();
            if level >= 12 { c.rarity = Some("legendary".into()); c.goal = 1; } else { c.rarity = Some("epic".into()); c.goal = 2; }
        }
        "species" => {
            let options: Vec<&F::Fish> = F::fish_in(place.id).into_iter().filter(|f| F::rarity_index(f.rarity) <= 1).collect();
            let fish = options[(rand.next() * options.len() as f64).floor() as usize];
            c.species = Some(fish.id.clone());
            c.biome = Some(place.id.into());
            c.goal = if fish.rarity == "common" { 2 } else { 1 };
        }
        "heavy" => {
            let weight = F::fish_in(place.id).into_iter().filter(|f| f.rarity == "uncommon").map(|f| f.max).fold(f64::MIN, f64::max);
            c.biome = Some(place.id.into());
            c.weight = Some((weight * 10.0).ceil() / 10.0);
            c.goal = 1;
        }
        "sell" => {
            let commons: Vec<&F::Fish> = F::fish_in(places[0].id).into_iter().filter(|f| f.rarity == "common").collect();
            c.goal = nice(15.0 * commons.iter().map(|f| f.base).sum::<f64>() / commons.len() as f64);
        }
        "variety" => c.goal = 4 + (rand.next() * 3.0).floor() as i64,
        _ => c.goal = 1,
    }
    c
}
/// Today's 3 challenges for a member. `seed` is any text unique to the member, server and day.
pub fn make_dailies(level: i64, seed: &str) -> Vec<Challenge> {
    let mut rand = F::seeded(hash(&format!("d:{seed}")));
    let mut kinds = DAILY_KINDS.to_vec();
    let mut out = Vec::new();
    while out.len() < 3 {
        let k = kinds.remove((rand.next() * kinds.len() as f64).floor() as usize);
        let mut c = build(k, level, &mut rand, false);
        c.reward = rewards(level).0;
        out.push(c);
    }
    out
}
/// This week's challenge for a member.
pub fn make_weekly(level: i64, seed: &str) -> Challenge {
    let mut rand = F::seeded(hash(&format!("w:{seed}")));
    let kind = WEEKLY_KINDS[(rand.next() * WEEKLY_KINDS.len() as f64).floor() as usize];
    let mut c = build(kind, level, &mut rand, true);
    c.reward = rewards(level).1;
    c
}

/// Something that moves a challenge along.
pub enum Event<'a> {
    Catch(&'a Catch),
    Sell(i64),
}
/// How an event moves a challenge: the new progress and the kinds of fish seen (for "variety").
pub fn advance(ch: &Challenge, progress: i64, seen: &[String], event: &Event) -> (i64, Vec<String>) {
    let mut out = (progress, seen.to_vec());
    if progress >= ch.goal { return out; }
    match event {
        Event::Sell(coins) => {
            if ch.kind == "sell" { out.0 = ch.goal.min(progress + (*coins).clamp(0, i64::from(i32::MAX))); }
            out
        }
        Event::Catch(f) => {
            let Some(sp) = F::fish_by_id(&f.species) else { return out };
            let rank = |r: &str| F::rarity_index(r);
            let hit = match ch.kind.as_str() {
                "catch" => true,
                "place" => Some(sp.biome) == ch.biome.as_deref(),
                "rarity" => rank(&f.rarity) >= rank(ch.rarity.as_deref().unwrap_or("common")),
                "species" => Some(f.species.as_str()) == ch.species.as_deref(),
                "heavy" => Some(sp.biome) == ch.biome.as_deref() && f.weight >= ch.weight.unwrap_or(f64::MAX),
                "variety" => !seen.contains(&f.species),
                "mutation" => f.mutation.is_some(),
                "giant" => f.giant,
                _ => false,
            };
            if !hit { return out; }
            out.0 = progress + 1;
            if ch.kind == "variety" { out.1.push(f.species.clone()); }
            out
        }
    }
}
/// Plain words for a challenge. `money(n)` formats coins the server's way.
pub fn describe(ch: &Challenge, money: &dyn Fn(i64) -> String) -> String {
    let at = |id: &str| { let b = F::biome_by_id(id); format!("{} {}", b.emoji, b.label) };
    let r = |id: &str| F::rarity_by_id(id).label;
    let biome = ch.biome.as_deref().unwrap_or("bay");
    match ch.kind.as_str() {
        "catch" => format!("Catch {} fish", ch.goal),
        "place" => format!("Catch {} fish at {}", ch.goal, at(biome)),
        "rarity" => {
            let rar = r(ch.rarity.as_deref().unwrap_or("common"));
            if ch.goal == 1 { format!("Catch a {rar} fish or rarer") } else { format!("Catch {} {rar} fish or rarer", ch.goal) }
        }
        "species" => format!("Catch {} {} ({})", if ch.goal == 1 { "a".to_string() } else { ch.goal.to_string() }, ch.species.as_deref().and_then(F::fish_by_id).map(|f| f.name.as_str()).unwrap_or("fish"), at(biome)),
        "heavy" => format!("Land a fish of {} kg or more at {}", js_number(ch.weight.unwrap_or(0.0)), at(biome)),
        "sell" => format!("Sell fish worth {}", money(ch.goal)),
        "variety" => format!("Catch {} different kinds of fish", ch.goal),
        "mutation" => "Catch a Mutated or Corrupted fish".into(),
        "giant" => "Catch a Giant fish".into(),
        _ => "Challenge".into(),
    }
}
/// A number the way JavaScript prints it: 12 not 12.0, 1.5 as 1.5.
pub fn js_number(n: f64) -> String {
    if n.fract() == 0.0 { format!("{}", n as i64) } else { format!("{n}") }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../../fixtures/fishchallenges.json")).expect("the recorded Good Boy 3 answers")
    }
    fn coins(n: i64) -> String {
        format!("{} coins", crate::card::group(n))
    }
    #[test]
    fn days_weeks_and_rewards_are_the_same_as_in_good_boy_3() {
        let j = fixture();
        for t in j["times"].as_array().unwrap() {
            let now = t[0].as_i64().unwrap();
            assert_eq!((day_key(now), week_key(now), next_day_at(now), next_week_at(now), yesterday_key(now)), (t[1].as_str().unwrap().to_string(), t[2].as_str().unwrap().to_string(), t[3].as_i64().unwrap(), t[4].as_i64().unwrap(), t[5].as_str().unwrap().to_string()), "{now}");
        }
        for r in j["rewards"].as_array().unwrap() {
            let (d, w) = rewards(r[0].as_i64().unwrap());
            assert_eq!((d.coins, d.xp, w.coins, w.xp), (r[1]["daily"]["coins"].as_i64().unwrap(), r[1]["daily"]["xp"].as_i64().unwrap(), r[1]["weekly"]["coins"].as_i64().unwrap(), r[1]["weekly"]["xp"].as_i64().unwrap()), "level {}", r[0]);
        }
        for s in j["streak"].as_array().unwrap() {
            let b = streak_bonus(s[0].as_i64().unwrap(), s[1].as_i64().unwrap());
            assert_eq!((b.coins, b.bait, b.bait_qty), (s[2]["coins"].as_i64().unwrap(), s[2]["bait"].as_str().unwrap(), s[2]["baitQty"].as_i64().unwrap()), "{s}");
        }
    }
    #[test]
    fn every_challenge_and_every_step_of_it_is_the_same_as_in_good_boy_3() {
        let j = fixture();
        let same = |got: &Challenge, want: &Value| {
            let w = |k: &str| want[k].as_str().map(str::to_string);
            assert_eq!((got.kind.as_str(), got.goal, got.biome.clone(), got.rarity.clone(), got.species.clone(), got.reward.coins, got.reward.xp), (want["kind"].as_str().unwrap(), want["goal"].as_i64().unwrap(), w("biome"), w("rarity"), w("species"), want["reward"]["coins"].as_i64().unwrap(), want["reward"]["xp"].as_i64().unwrap()), "{want}");
            assert_eq!(got.weight, want["weight"].as_f64(), "{want}");
        };
        for l in j["lists"].as_array().unwrap() {
            let (level, seed) = (l[0].as_i64().unwrap(), l[1].as_str().unwrap());
            let dailies = make_dailies(level, seed);
            let weekly = make_weekly(level, seed);
            let want = l[2].as_array().unwrap();
            assert_eq!(dailies.len(), want.len());
            for (g, w) in dailies.iter().zip(want) { same(g, w); }
            same(&weekly, &l[3]);
            let events: Vec<(Option<Catch>, i64)> = l[4].as_array().unwrap().iter().map(|e| if e["type"] == "catch" {
                let f = &e["fish"];
                (Some(Catch { species: f["species"].as_str().unwrap().into(), rarity: f["rarity"].as_str().unwrap().into(), weight: f["weight"].as_f64().unwrap(), giant: f["giant"].as_bool().unwrap(), mutation: f["mutation"].as_str().map(str::to_string), value: f["value"].as_i64().unwrap() }), 0)
            } else { (None, e["coins"].as_i64().unwrap()) }).collect();
            let all: Vec<&Challenge> = dailies.iter().chain(std::iter::once(&weekly)).collect();
            for (ch, run) in all.iter().zip(l[5].as_array().unwrap()) {
                let (mut progress, mut seen) = (0, Vec::new());
                for (n, (ev, c)) in events.iter().enumerate() {
                    let r = match ev { Some(f) => advance(ch, progress, &seen, &Event::Catch(f)), None => advance(ch, progress, &seen, &Event::Sell(*c)) };
                    progress = r.0;
                    seen = r.1;
                    let t = &run["trace"][n];
                    assert_eq!((progress, seen.len() as i64), (t[0].as_i64().unwrap(), t[1].as_i64().unwrap()), "level {level} {seed} event {n} {}", ch.kind);
                }
                assert_eq!(describe(ch, &coins), run["text"].as_str().unwrap(), "{seed}");
            }
        }
    }
}
