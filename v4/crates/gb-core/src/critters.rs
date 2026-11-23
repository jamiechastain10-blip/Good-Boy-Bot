//! Good Boy 3's critters: its own collecting game. While people chat a wild critter sometimes appears (about every
//! 30 messages, at most one every 90 seconds, in the channels staff pick or anywhere); the first to press Catch and
//! type its name keeps it, and Hint shows a few letters. A buddy critter gains XP as its owner chats; `/critters`
//! battles buddies, trades (both agree), and releases one for coins. No critters are built in: each server adds its own roster with `/critters add`.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::store::Data;
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Def, Field, FormEvent, Kind, MessageEvent, Settings};
use gb_data::critters::Critter;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub const MODULE: &str = "critters";
pub const USE: Perm = Perm { key: "critters.use", level: Level::Everyone };
pub const ADMIN: Perm = Perm { key: "critters.admin", level: Level::Admin };
pub static SETTINGS: &[Def] = &[
    Def { key: "spawns", label: "Wild critters appear while people chat", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "spawnEvery", label: "About how many messages between critters", kind: Kind::Number { min: 5, max: 1000 }, default: Fallback::Int(30) },
    Def { key: "buddyXp", label: "Buddy critters gain XP when their owner chats", kind: Kind::Toggle, default: Fallback::Bool(true) },
];
const N: Takes = Takes::Whole { min: 1, max: 1_000_000_000 };
const ID: Opt = Opt { name: "id", about: "Its number", takes: N, required: true };
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "critters", about: "Your critters: list, buddy, trade, battle and more", module: MODULE, options: &[], subs: &[
    Sub { name: "list", about: "The critters you caught", options: &[Opt { name: "page", about: "Page", takes: N, required: false }] },
    Sub { name: "info", about: "One critter, with its picture and stats", options: &[Opt { name: "id", about: "Its number (your buddy if empty)", takes: N, required: false }] },
    Sub { name: "buddy", about: "Pick your buddy (it levels up while you chat)", options: &[ID] },
    Sub { name: "rename", about: "Give a critter a nickname", options: &[ID, Opt { name: "name", about: "Empty to remove it", takes: Takes::Text, required: false }] },
    Sub { name: "dex", about: "Which critters you have found", options: &[] },
    Sub { name: "trade", about: "Swap one of yours for one of theirs", options: &[
        Opt { name: "member", about: "Who", takes: Takes::Member, required: true },
        Opt { name: "give", about: "Your critter's number", takes: N, required: true },
        Opt { name: "get", about: "Their critter's number", takes: N, required: true },
    ] },
    Sub { name: "battle", about: "Your buddy against theirs", options: &[Opt { name: "member", about: "Who", takes: Takes::Member, required: true }] },
    Sub { name: "release", about: "Let one go (for coins, with the economy)", options: &[ID] },
    Sub { name: "add", about: "(Staff) Add a character to this server's roster", options: &[
        Opt { name: "name", about: "Its name (members type it to catch it)", takes: Takes::Text, required: true },
        Opt { name: "type", about: "Its type", takes: Takes::Choice(TYPES), required: true },
        Opt { name: "rarity", about: "How often it shows up", takes: Takes::Choice(RARITY_CHOICES), required: true },
        Opt { name: "picture", about: "A picture address (https://…)", takes: Takes::Text, required: false },
        Opt { name: "hp", about: "Health, 10 to 200 (default 50)", takes: Takes::Whole { min: 10, max: 200 }, required: false },
        Opt { name: "attack", about: "Attack, 10 to 200 (default 50)", takes: Takes::Whole { min: 10, max: 200 }, required: false },
        Opt { name: "defense", about: "Defense, 10 to 200 (default 50)", takes: Takes::Whole { min: 10, max: 200 }, required: false },
        Opt { name: "speed", about: "Speed, 10 to 200 (default 50)", takes: Takes::Whole { min: 10, max: 200 }, required: false },
    ] },
    Sub { name: "remove", about: "(Staff) Take a character off the roster", options: &[Opt { name: "name", about: "Its name", takes: Takes::Text, required: true }] },
    Sub { name: "roster", about: "(Staff) The characters on this server's roster", options: &[] },
    Sub { name: "here", about: "(Staff) Turn critters on or off in this channel", options: &[] },
    Sub { name: "spawn", about: "(Staff) Make a critter appear here now", options: &[] },
] }];
pub const TYPES: &[(&str, &str)] = &[("🔥 Fire", "fire"), ("💧 Water", "water"), ("🍃 Leaf", "leaf"), ("⚡ Spark", "spark"), ("🪨 Stone", "stone"), ("❄️ Frost", "frost"), ("🌑 Shadow", "shadow"), ("☁️ Sky", "sky")];
pub const RARITY_CHOICES: &[(&str, &str)] = &[("Common", "common"), ("Uncommon", "uncommon"), ("Rare", "rare"), ("Epic", "epic"), ("Legendary", "legendary")];
const SPAWN_MS: i64 = 3 * 60_000;
const SPAWN_GAP: i64 = 90_000;
const TRADE_MS: i64 = 5 * 60_000;
const BUDDY_COOLDOWN: i64 = 60_000;

/// (id, emoji, label, colour, dark)
pub const ELEMENTS: &[(&str, &str, &str, &str, &str)] = &[
    ("fire", "🔥", "Fire", "#ff7a3d", "#b8401a"), ("water", "💧", "Water", "#4aa8ff", "#1f5fae"), ("leaf", "🍃", "Leaf", "#5fcf6a", "#2d7d37"), ("spark", "⚡", "Spark", "#ffd23f", "#b08b00"),
    ("stone", "🪨", "Stone", "#b59a7a", "#6e5a43"), ("frost", "❄️", "Frost", "#9fe6ff", "#4a9ab8"), ("shadow", "🌑", "Shadow", "#9a7bd8", "#4c3487"), ("sky", "☁️", "Sky", "#c9d8ff", "#6f83c4"),
];
/// Who beats whom: 1.2x against an element it beats, 0.83x against one that beats it.
pub const BEATS: &[(&str, [&str; 2])] = &[("fire", ["leaf", "frost"]), ("water", ["fire", "stone"]), ("leaf", ["water", "stone"]), ("spark", ["water", "sky"]), ("stone", ["spark", "fire"]), ("frost", ["leaf", "sky"]), ("shadow", ["spark", "shadow"]), ("sky", ["leaf", "shadow"])];
/// (id, label, weight, colour, release value)
pub const RARITIES: &[(&str, &str, f64, u32, i64)] = &[("common", "Common", 60.0, 0x95a5a6, 50), ("uncommon", "Uncommon", 25.0, 0x2ecc71, 150), ("rare", "Rare", 10.0, 0x3498db, 500), ("epic", "Epic", 4.4, 0x9b59b6, 2000), ("legendary", "Legendary", 0.6, 0xf1c40f, 15000)];
pub const SPARKLY_CHANCE: f64 = 1.0 / 400.0;
pub const MAX_LEVEL: i64 = 100;
/// One character of a server's own roster (added with `/critters add`; none come built in).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Character {
    pub id: String,
    pub name: String,
    /// One of the type names in `ELEMENTS`.
    pub element: String,
    /// One of the rarity ids in `RARITIES`.
    pub rarity: String,
    pub hp: i64,
    pub atk: i64,
    pub def: i64,
    pub spd: i64,
    /// An https picture address (optional).
    pub image: Option<String>,
}
/// "Mister Nine" → "mister-nine" (the character's id).
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() { if c.is_alphanumeric() { out.push(c); } else if !out.ends_with('-') && !out.is_empty() { out.push('-'); } }
    out.trim_end_matches('-').chars().take(40).collect()
}
fn element(id: &str) -> &'static (&'static str, &'static str, &'static str, &'static str, &'static str) {
    ELEMENTS.iter().find(|e| e.0 == id).unwrap_or(&ELEMENTS[0])
}
fn rarity(id: &str) -> &'static (&'static str, &'static str, f64, u32, i64) {
    RARITIES.iter().find(|r| r.0 == id).unwrap_or(&RARITIES[0])
}
pub fn advantage(att: &str, def: &str) -> f64 {
    let beats = |a: &str, d: &str| BEATS.iter().any(|(x, l)| *x == a && l.contains(&d));
    if beats(att, def) { 1.2 } else if beats(def, att) { 0.83 } else { 1.0 }
}
/// A wild critter: species by rarity weight, four quality rolls 0..=31, sparkly or not. `rand()` gives 0..1.
pub fn roll_wild(roster: &[Character], rand: &mut dyn FnMut() -> f64) -> Option<Critter> {
    if roster.is_empty() { return None; }
    // rarities nobody on the roster has are left out of the roll
    let present: Vec<&(&str, &str, f64, u32, i64)> = RARITIES.iter().filter(|r| roster.iter().any(|c| c.rarity == r.0)).collect();
    let total: f64 = present.iter().map(|r| r.2).sum();
    let mut r = rand() * total;
    let mut pick = present[0].0;
    for x in &present { if r < x.2 { pick = x.0; break; } r -= x.2; }
    let pool: Vec<&Character> = roster.iter().filter(|c| c.rarity == pick).collect();
    let sp = pool[((rand() * pool.len() as f64) as usize).min(pool.len() - 1)];
    let mut iv = || (rand() * 32.0).floor() as i64;
    let ivs = [iv(), iv(), iv(), iv()];
    Some(Critter { species: sp.id.clone(), iv: ivs, sparkly: rand() < SPARKLY_CHANCE, level: 1, ..Default::default() })
}
pub fn quality(iv: &[i64; 4]) -> i64 {
    ((iv.iter().sum::<i64>() as f64 / 124.0) * 100.0).round() as i64
}
pub fn xp_to_next(level: i64) -> i64 {
    if level >= MAX_LEVEL { i64::MAX } else { 20 + level * level * 4 }
}
/// Adds XP, levelling up as many times as it fills: (level, xp, level-ups).
pub fn add_xp(mut level: i64, mut xp: i64, gain: i64) -> (i64, i64, i64) {
    let mut ups = 0;
    xp += gain;
    while level < MAX_LEVEL && xp >= xp_to_next(level) { xp -= xp_to_next(level); level += 1; ups += 1; }
    if level >= MAX_LEVEL { xp = 0; }
    (level, xp, ups)
}
/// Battle stats at its level: (hp, atk, def, spd).
pub fn stats(c: &Critter, sp: &Character) -> (i64, i64, i64, i64) {
    let f = |base: i64, v: i64| ((2 * base + v) * c.level) / 100 + 5;
    (((2 * sp.hp + c.iv[0]) * c.level) / 100 + c.level + 10, f(sp.atk, c.iv[1]), f(sp.def, c.iv[2]), f(sp.spd, c.iv[3]))
}
/// The name with some letters hidden; more show as Hint is pressed (Good Boy 3's hint).
pub fn hint(name: &str, shown: usize) -> String {
    let chars: Vec<char> = name.chars().collect();
    let len = chars.len().max(1);
    let mut order: Vec<usize> = (1..chars.len()).collect();
    order.sort_by_key(|k| (k * 7) % len);
    let keep: Vec<usize> = std::iter::once(0).chain(order.into_iter().take(shown.saturating_sub(1))).collect();
    chars.iter().enumerate().map(|(k, c)| if keep.contains(&k) { c.to_string() } else { "_".into() }).collect::<Vec<_>>().join(" ")
}
pub fn name_matches(typed: &str, name: &str) -> bool {
    let squash = |t: &str| t.trim().to_lowercase().split_whitespace().collect::<String>();
    squash(typed) == squash(name)
}
/// Coins for letting one go: more for rarer, higher-level and sparkly ones.
pub fn release_value(c: &Critter, sp: &Character) -> i64 {
    (rarity(&sp.rarity).4 as f64 * (1.0 + c.level as f64 / 20.0) * if c.sparkly { 10.0 } else { 1.0 }).round() as i64
}
/// Buddy against buddy (Good Boy 3's battle): (winner 0 or 1, what happened).
pub fn battle(a: (&Critter, &Character), b: (&Critter, &Character), rand: &mut dyn FnMut() -> f64) -> (usize, Vec<String>) {
    let side = [a, b].map(|(c, sp)| (c, sp, stats(c, sp)));
    let mut hp = [side[0].2 .0, side[1].2 .0];
    let mut log = Vec::new();
    let mut turns = 0;
    while hp[0] > 0 && hp[1] > 0 && turns < 50 {
        turns += 1;
        let first = if side[0].2 .3 == side[1].2 .3 { usize::from(rand() >= 0.5) } else if side[0].2 .3 > side[1].2 .3 { 0 } else { 1 };
        for at in [first, 1 - first] {
            let df = 1 - at;
            if hp[at] <= 0 || hp[df] <= 0 { continue; }
            let adv = advantage(&side[at].1.element, &side[df].1.element);
            let crit = if rand() < 0.1 { 1.5 } else { 1.0 };
            if rand() < 0.08 { if turns <= 3 { log.push(format!("{} dodges!", side[df].1.name)); } continue; }
            let base = (((2 * side[at].0.level) as f64 / 5.0 + 2.0) * 110.0 * (side[at].2 .1 as f64 / side[df].2 .2 as f64) / 50.0 + 2.0).floor();
            let dmg = (base * adv * crit * (0.7 + rand() * 0.3)).max(1.0).floor() as i64;
            hp[df] = (hp[df] - dmg).max(0);
            if turns <= 3 || hp[df] == 0 || crit > 1.0 {
                log.push(format!("{} hits for **{dmg}**{}{}{}", side[at].1.name, if adv > 1.0 { " (super effective!)" } else if adv < 1.0 { " (not very effective)" } else { "" }, if crit > 1.0 { " ⚡ critical!" } else { "" }, if hp[df] == 0 { format!(" · {} is out!", side[df].1.name) } else { String::new() }));
            }
        }
    }
    let winner = if hp[0] > 0 && hp[1] <= 0 { 0 } else if hp[1] > 0 && hp[0] <= 0 { 1 } else if hp[0] as f64 / side[0].2 .0 as f64 >= hp[1] as f64 / side[1].2 .0 as f64 { 0 } else { 1 };
    (winner, log)
}
pub fn label(c: &Critter, sp: &Character) -> String {
    format!("{}**{}** · Lv {}", if c.sparkly { "✨ " } else { "" }, c.nickname.as_ref().map(|n| format!("{n} ({})", sp.name)).unwrap_or_else(|| sp.name.clone()), c.level)
}
fn element_tag(el: &str) -> String {
    let e = element(el);
    format!("{} {}", e.1, e.2)
}
/// A wild critter waiting to be caught, and the pending trades and battles (in memory, as in Good Boy 3).
#[derive(Debug, Clone)]
struct Wild { id: String, critter: Critter, channel: String, message: Option<String>, hints: usize }
#[derive(Default)]
struct Memory {
    spawns: HashMap<String, Wild>,
    counts: HashMap<String, (i64, i64, i64)>,
    offers: HashMap<String, (String, String, String, i64, i64, i64)>,
    buddy_at: HashMap<String, i64>,
}
fn memory() -> std::sync::MutexGuard<'static, Memory> {
    static M: OnceLock<Mutex<Memory>> = OnceLock::new();
    M.get_or_init(Mutex::default).lock().unwrap_or_else(|p| p.into_inner())
}
fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::Games).line(text).private() }]
}

/// An uploaded picture as kept: its file name and bytes.
pub type StoredPicture = (String, Vec<u8>);
/// What to do with a character's picture when saving it.
pub enum Picture {
    Keep,
    Remove,
    /// An https address.
    Link(String),
    /// A picture from the computer.
    File { name: String, bytes: Vec<u8> },
}

pub struct Critters<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub guild: &'a str,
    /// The economy is on: releases pay coins.
    pub money: bool,
}
impl Critters<'_> {
    fn coins(&self, n: i64) -> String {
        crate::money::Money { db: self.db, settings: self.settings, guild: self.guild }.coins(n)
    }
    fn mine(&self, user: &str, id: i64) -> Result<Critter, String> {
        self.db.get().critter(self.guild, id).ok().flatten().filter(|c| c.user == user).ok_or_else(|| format!("You don't have a critter #{id}. See `/critters list`."))
    }
    /// This server's own roster (nothing is built in).
    pub fn roster(&self) -> Vec<Character> {
        Data { db: self.db, guild: self.guild, module: MODULE }.get("roster").and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
    }
    fn set_roster(&self, list: &[Character]) {
        Data { db: self.db, guild: self.guild, module: MODULE }.set("roster", &json!(list));
    }
    /// Where uploaded pictures of this server's characters are kept.
    fn pictures_dir(&self) -> Option<std::path::PathBuf> {
        Some(self.db.get().path().parent()?.join("files").join(MODULE).join(self.guild).join("pictures"))
    }
    /// A character's uploaded picture (its file name and bytes), when it has one.
    pub fn picture_file(&self, ch: &Character) -> Option<StoredPicture> {
        let name = ch.image.as_deref()?.strip_prefix("file:")?;
        if name.contains(['/', '\\']) || name.starts_with('.') { return None; }
        Some((name.to_string(), std::fs::read(self.pictures_dir()?.join(name)).ok()?))
    }
    /// The picture on a card: a link is shown from the web, an uploaded file is sent with the card.
    fn with_picture(&self, card: Card, ch: &Character) -> Card {
        match (&ch.image, self.picture_file(ch)) {
            (_, Some((name, bytes))) => card.file(&name, bytes),
            (Some(url), None) if !url.starts_with("file:") => card.image(url.clone()),
            _ => card,
        }
    }
    /// Adds or changes a character from the launcher (the same rules as `/critters add`), with its picture.
    #[allow(clippy::too_many_arguments)]
    pub fn roster_save(&self, editing: Option<&str>, name: &str, element: &str, rarity: &str, stats: [i64; 4], picture: Picture) -> Result<String, String> {
        let name: String = name.trim().chars().filter(|c| !"*_`~|<>@#\n".contains(*c)).take(30).collect();
        let named = slug(&name);
        if named.is_empty() { return Err("Give it a name with letters or numbers.".into()); }
        // a changed name keeps the character's number, so the critters people already caught stay theirs
        let id = editing.map(str::to_string).unwrap_or_else(|| named.clone());
        if !TYPES.iter().any(|t| t.1 == element) || !RARITY_CHOICES.iter().any(|r| r.1 == rarity) { return Err("Pick a type and a rarity from the lists.".into()); }
        let mut roster = self.roster();
        let at = match editing {
            Some(old) => Some(roster.iter().position(|c| c.id == old).ok_or("That character is gone. Reload the page.")?),
            None => None,
        };
        if at.is_none() && roster.len() >= 200 { return Err("A roster holds up to 200 characters. Remove one first.".into()); }
        if roster.iter().enumerate().any(|(k, c)| c.id == named && Some(k) != at) { return Err("There's already a character with that name.".into()); }
        let [hp, atk, def, spd] = stats.map(|n| n.clamp(10, 200));
        let before = at.map(|k| roster[k].clone());
        let dir = self.pictures_dir();
        let had_file = before.as_ref().and_then(|c| c.image.as_deref()).and_then(|i| i.strip_prefix("file:")).map(str::to_string);
        let image = match picture {
            Picture::Keep => before.as_ref().and_then(|c| c.image.clone()),
            Picture::Remove => None,
            Picture::Link(url) => {
                let url = url.trim().to_string();
                if url.is_empty() { None } else if !url.starts_with("https://") || url.len() > 500 || url.contains(char::is_whitespace) { return Err("A picture link must be an https address.".into()); } else { Some(url) }
            }
            Picture::File { name: file, bytes } => {
                let ext = crate::welcome::image_ext(&file, &bytes)?;
                let dir = dir.clone().ok_or("The data folder is not ready yet.")?;
                std::fs::create_dir_all(&dir).map_err(|e| format!("The picture could not be saved ({e})."))?;
                let stored = format!("{id}-{}.{ext}", bytes.len());
                std::fs::write(dir.join(&stored), &bytes).map_err(|e| format!("The picture could not be saved ({e})."))?;
                Some(format!("file:{stored}"))
            }
        };
        // an older uploaded picture that is no longer used is deleted
        if let (Some(old), Some(dir)) = (&had_file, &dir) { if image.as_deref() != Some(&format!("file:{old}")) { let _ = std::fs::remove_file(dir.join(old)); } }
        let one = Character { id: id.clone(), name: name.clone(), element: element.into(), rarity: rarity.into(), hp, atk, def, spd, image };
        match at { Some(k) => roster[k] = one, None => roster.push(one) }
        self.set_roster(&roster);
        Ok(format!("Saved **{name}**. The roster has {} character{}.", roster.len(), if roster.len() == 1 { "" } else { "s" }))
    }
    /// Takes a character off the roster (the critters people already caught keep working, as "Unknown" ones).
    pub fn roster_remove(&self, id: &str) -> Result<String, String> {
        let mut roster = self.roster();
        let at = roster.iter().position(|c| c.id == id).ok_or("That character is already gone.")?;
        let gone = roster.remove(at);
        if let (Some(dir), Some(file)) = (self.pictures_dir(), gone.image.as_deref().and_then(|i| i.strip_prefix("file:"))) { let _ = std::fs::remove_file(dir.join(file)); }
        self.set_roster(&roster);
        Ok(format!("Removed **{}**.", gone.name))
    }
    /// A critter's character; one removed from the roster since keeps working as an "Unknown" with middling stats.
    fn sp(&self, id: &str) -> Character {
        self.roster().into_iter().find(|c| c.id == id).unwrap_or(Character { id: id.into(), name: id.split('-').map(|w| { let mut c = w.chars(); c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default() }).collect::<Vec<_>>().join(" "), element: "stone".into(), rarity: "common".into(), hp: 50, atk: 50, def: 50, spd: 50, image: None })
    }
    fn label(&self, c: &Critter) -> String { label(c, &self.sp(&c.species)) }
    fn buddy(&self, user: &str) -> Option<Critter> {
        self.db.get().critter_buddy(self.guild, user).ok().flatten()
    }
    /// A wild critter appears in a channel (the one before it wanders off).
    pub fn spawn(&self, channel: &str, now: i64, rand: &mut dyn FnMut() -> f64) -> Vec<Action> {
        let Some(wild) = roll_wild(&self.roster(), rand) else { return private("There are no characters yet. Add some with `/critters add`.") };
        let id = format!("{:010x}", (now as u64).wrapping_mul(2_654_435_761) ^ (rand() * 1e9) as u64);
        let old = memory().spawns.insert(self.guild.to_string(), Wild { id: id.clone(), critter: wild.clone(), channel: channel.into(), message: None, hints: 1 });
        let mut out: Vec<Action> = old.and_then(|o| self.gone(&o, true)).into_iter().collect();
        let sp = self.sp(&wild.species);
        let mut card = Card::new(Area::Games).title(format!("{} critter appeared!", if wild.sparkly { "✨ A sparkly" } else { "A wild" }))
            .line(format!("It's a {} {} critter. Press **Catch** and type its name to keep it!\n`{}`", rarity(&sp.rarity).1.to_lowercase(), element_tag(&sp.element), hint(&sp.name, 1)))
            .line("-# It runs away in 3 minutes.")
            .button_with(format!("crit:catch:{id}"), "Catch", ButtonStyle::Good, Some("🫳".into()))
            .button_with(format!("crit:hint:{id}"), "Hint", ButtonStyle::Plain, Some("💡".into()));
        card.accent = Some(if wild.sparkly { 0xf1c40f } else { rarity(&sp.rarity).3 });
        card = self.with_picture(card, &sp);
        out.push(Action::Post { channel: channel.into(), card, note: format!("crit:{id}"), ping: Vec::new(), roles: Vec::new() });
        out.push(Action::Later { after_ms: SPAWN_MS as u64, note: format!("crit:expire:{id}") });
        out
    }
    fn gone(&self, w: &Wild, replaced: bool) -> Option<Action> {
        let mut card = Card::new(Area::Games).title(format!("The {} {}...", self.sp(&w.critter.species).name, if replaced { "wandered off" } else { "ran away" }));
        card.accent = Some(0x95a5a6);
        w.message.as_ref().map(|m| Action::Edit { channel: w.channel.clone(), message: m.clone(), card })
    }
    pub fn posted(&self, note: &str, message: &str) {
        let Some(id) = note.strip_prefix("crit:") else { return };
        if let Some(w) = memory().spawns.get_mut(self.guild).filter(|w| w.id == id) { w.message = Some(message.into()); }
    }
    /// Three minutes later: it runs away if nobody caught it.
    pub fn later(&self, note: &str) -> Vec<Action> {
        let Some(id) = note.strip_prefix("crit:expire:") else { return Vec::new() };
        let w = { let mut m = memory(); if m.spawns.get(self.guild).is_some_and(|w| w.id == id) { m.spawns.remove(self.guild) } else { None } };
        w.and_then(|w| self.gone(&w, false)).into_iter().collect()
    }
    /// Chatting: the buddy's XP, and sometimes a wild critter.
    pub fn on_message(&self, ev: &MessageEvent, rand: &mut dyn FnMut() -> f64) -> Vec<Action> {
        if ev.author.bot { return Vec::new(); }
        if self.settings.bool(self.guild, MODULE, "buddyXp") {
            let k = format!("{}:{}", self.guild, ev.author.id);
            let due = ev.at_ms - memory().buddy_at.get(&k).copied().unwrap_or(0) >= BUDDY_COOLDOWN;
            if due {
                if let Some(b) = self.buddy(&ev.author.id) {
                    memory().buddy_at.insert(k, ev.at_ms);
                    let (level, xp, _) = add_xp(b.level, b.xp, 5 + (rand() * 6.0).floor() as i64);
                    let _ = self.db.get().critter_level(b.id, level, xp);
                }
            }
        }
        if !self.settings.bool(self.guild, MODULE, "spawns") { return Vec::new(); }
        let d = Data { db: self.db, guild: self.guild, module: MODULE };
        let only: Vec<String> = d.get("channels").and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        if !only.is_empty() && !only.contains(&ev.place.channel) { return Vec::new(); }
        let every = self.settings.int(self.guild, MODULE, "spawnEvery");
        let go = {
            let mut m = memory();
            let c = m.counts.entry(self.guild.to_string()).or_insert((0, 0, 0));
            if c.1 == 0 { c.1 = ((every as f64) * (0.6 + rand() * 0.8)).round().max(3.0) as i64; }
            c.0 += 1;
            let go = c.0 >= c.1 && ev.at_ms - c.2 >= SPAWN_GAP;
            if go { *c = (0, 0, ev.at_ms); }
            go
        };
        if go { self.spawn(&ev.place.channel, ev.at_ms, rand) } else { Vec::new() }
    }

    pub fn press(&self, ev: &ButtonEvent, rand: &mut dyn FnMut() -> f64) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, USE) { return private(format!("You don't have permission for that (`{}`).", USE.key)); }
        let p: Vec<&str> = ev.id.split(':').collect();
        let (kind, id, extra) = (p.get(1).copied().unwrap_or(""), p.get(2).copied().unwrap_or(""), p.get(3).copied().unwrap_or(""));
        match kind {
            "catch" | "hint" => {
                let mut m = memory();
                let Some(w) = m.spawns.get_mut(self.guild).filter(|w| w.id == id) else { return private("Too late, that critter is gone.") };
                if kind == "catch" { return vec![Action::Form { id: format!("crit:name:{id}"), title: "Catch it!".into(), fields: vec![Field { id: "name".into(), label: "What's its name?".into(), max: 30, required: true, ..Default::default() }] }]; }
                let name = self.sp(&w.critter.species).name;
                w.hints = (w.hints + 1).min((name.len() as f64 * 0.6).ceil() as usize);
                private(format!("💡 `{}`", hint(&name, w.hints)))
            }
            "trade" | "battle" => self.answer(ev, kind, id, extra, rand),
            "release" => {
                if ev.member.id != id { return private("That is not your critter."); }
                let c = match self.mine(id, extra.parse().unwrap_or(0)) { Ok(c) => c, Err(no) => return private(no) };
                let coins = release_value(&c, &self.sp(&c.species));
                let _ = self.db.get().critter_release(self.guild, id, c.id);
                let why = format!("released {}", self.sp(&c.species).name);
                let paid = self.money && self.db.get().credit(self.guild, id, coins, &why).is_ok();
                vec![Action::Update { card: Card::new(Area::Games).line(format!("👋 {} went back to the wild.{}", self.label(&c), if paid { format!(" You got {}.", self.coins(coins)) } else { String::new() })).private() }]
            }
            _ => private("That button is no longer active."),
        }
    }
    /// The name typed in the Catch popup: the first right answer keeps it.
    pub fn form(&self, ev: &FormEvent, rand: &mut dyn FnMut() -> f64) -> Vec<Action> {
        let id = ev.id.trim_start_matches("crit:name:");
        let w = {
            let mut m = memory();
            let Some(w) = m.spawns.get(self.guild).filter(|w| w.id == id).cloned() else { return private("Too late, that critter is gone.") };
            let sp = self.sp(&w.critter.species);
            if !name_matches(ev.values.get("name").map(String::as_str).unwrap_or(""), &sp.name) { return private("That's not its name! Try again (the Hint button shows some letters)."); }
            m.spawns.remove(self.guild); // first right answer wins, even if two arrive together
            w
        };
        let sp = self.sp(&w.critter.species);
        let caught = Critter { level: 1 + (rand() * 10.0).floor() as i64, ..w.critter.clone() };
        let Ok(new_id) = self.db.get().critter_catch(self.guild, &ev.member.id, &caught, ev.at_ms) else { return private("Something went wrong saving that critter.") };
        let first = self.db.get().critter_species_count(self.guild, &ev.member.id, &caught.species).unwrap_or(0) == 1;
        let c = self.db.get().critter(self.guild, new_id).ok().flatten().unwrap_or(caught);
        let mut out = vec![Action::Reply { card: Card::new(Area::Games).line(format!("🎉 <@{}> caught {} (#{new_id}, {}% quality)!{}", ev.member.id, self.label(&c), quality(&c.iv), if first { " ✨ New to your collection!" } else { "" })) }];
        if let Some(m) = &w.message {
            let mut done = Card::new(Area::Games).title(format!("{} critter appeared!", if w.critter.sparkly { "✨ A sparkly" } else { "A wild" })).line(format!("Caught by <@{}>: it was **{}**.", ev.member.id, sp.name))
                .button_full(format!("crit:catch:{id}"), "Catch", ButtonStyle::Good, Some("🫳".into()), true).button_full(format!("crit:hint:{id}"), "Hint", ButtonStyle::Plain, Some("💡".into()), true);
            done.accent = Some(rarity(&sp.rarity).3);
            out.push(Action::Edit { channel: w.channel.clone(), message: m.clone(), card: done });
        }
        out
    }
    fn answer(&self, ev: &ButtonEvent, kind: &str, tok: &str, answer: &str, rand: &mut dyn FnMut() -> f64) -> Vec<Action> {
        let o = {
            let mut m = memory();
            let Some(o) = m.offers.get(tok).cloned() else { return private("That offer ran out.") };
            if ev.at_ms - o.5 > TRADE_MS { m.offers.remove(tok); return private("That offer ran out."); }
            if ev.member.id != o.2 && !(answer == "no" && ev.member.id == o.1) { return private("That offer is for someone else."); }
            m.offers.remove(tok);
            o
        };
        let (_, from, to, give, get, _) = o;
        let done = |text: String| vec![Action::Update { card: Card::new(Area::Games).line(text) }];
        if answer == "no" { return done(format!("{} {}.", if kind == "trade" { "Trade" } else { "Battle" }, if ev.member.id == from { "called off" } else { "declined" })); }
        if kind == "trade" {
            let (a, b) = match (self.mine(&from, give), self.mine(&to, get)) { (Ok(a), Ok(b)) => (a, b), (Err(no), _) | (_, Err(no)) => return private(no) };
            if self.db.get().critter_trade(self.guild, &a, &b).is_err() { return private("That trade didn't go through."); }
            return done(format!("🤝 Trade done! <@{from}> got {} and <@{to}> got {}.", self.label(&b), self.label(&a)));
        }
        let (Some(a), Some(b)) = (self.buddy(&from), self.buddy(&to)) else { return private("Both of you need a buddy critter (`/critters buddy`).") };
        let (winner, log) = battle((&a, &self.sp(&a.species)), (&b, &self.sp(&b.species)), rand);
        let (win, lose) = if winner == 0 { ((&from, &a), (&to, &b)) } else { ((&to, &b), (&from, &a)) };
        let gain = 20 + 5 * lose.1.level;
        let (level, xp, ups) = add_xp(win.1.level, win.1.xp, gain);
        let _ = self.db.get().critter_level(win.1.id, level, xp);
        let mut lines: Vec<String> = log.into_iter().take(8).collect();
        lines.push(String::new());
        let won = Critter { level, xp, ..win.1.clone() };
        lines.push(format!("🏆 <@{}>'s {} wins! +{gain} XP{}", win.0, self.label(&won), if ups > 0 { format!(" · ⬆️ now level {level}") } else { String::new() }));
        let mut card = Card::new(Area::Games).title(format!("⚔️ {} vs {}", self.sp(&a.species).name, self.sp(&b.species).name)).line(lines.join("\n"));
        card.accent = Some(0xf1c40f);
        vec![Action::Update { card }]
    }

    pub fn command(&self, ev: &CommandEvent, rand: &mut dyn FnMut() -> f64) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, USE) { return private(format!("You don't have permission for that (`{}`).", USE.key)); }
        let me = ev.member.id.as_str();
        let num = |k: &str| ev.args.get(k).and_then(|v| v.parse::<i64>().ok());
        match ev.sub.as_deref().unwrap_or("list") {
            "list" => {
                let page = num("page").unwrap_or(1).max(1);
                let (rows, total) = self.db.get().critters_of(self.guild, me, (page - 1) * 15, 15).unwrap_or_default();
                if total == 0 { return private("You haven't caught any critters yet. Keep chatting: wild ones appear now and then!"); }
                let buddy = self.buddy(me).map(|b| b.id);
                let lines: Vec<String> = rows.iter().map(|c| format!("`#{}` {} · {} · {}%{}", c.id, self.label(c), element_tag(&self.sp(&c.species).element), quality(&c.iv), if buddy == Some(c.id) { " · 🐾 buddy" } else { "" })).collect();
                let mut card = Card::new(Area::Games).title(format!("🫳 Your critters · {total}")).line(if lines.is_empty() { "Nothing on this page.".into() } else { lines.join("\n") })
                    .line(format!("-# Page {page} of {} · /critters info id:<number> for one critter", (total + 14) / 15)).private();
                card.accent = Some(0x6b93ff);
                vec![Action::Reply { card }]
            }
            "info" => {
                let c = match num("id") { Some(id) => self.db.get().critter(self.guild, id).ok().flatten(), None => self.buddy(me) };
                let Some(c) = c else { return private(match num("id") { Some(id) => format!("There's no critter #{id}."), None => "You don't have a buddy yet. Pick one with `/critters buddy`.".into() }) };
                let sp = self.sp(&c.species);
                let (hp, atk, def, spd) = stats(&c, &sp);
                let strong: Vec<&str> = BEATS.iter().find(|b| b.0 == sp.element).map(|b| b.1.iter().map(|x| element(x).2).collect()).unwrap_or_default();
                let mut card = Card::new(Area::Games).title(format!("{}{} #{}{}", if c.sparkly { "✨ " } else { "" }, sp.name, c.id, c.nickname.as_ref().map(|n| format!(" · \"{n}\"")).unwrap_or_default()))
                    .line(format!("{} · {} · owned by <@{}>\nLevel **{}**{} · quality **{}%**", element_tag(&sp.element), rarity(&sp.rarity).1, c.user, c.level, if c.level < MAX_LEVEL { format!(" · {}/{} XP", c.xp, xp_to_next(c.level)) } else { " (max)".into() }, quality(&c.iv)))
                    .line(format!("**Stats**\n❤️ {hp} · ⚔️ {atk} · 🛡️ {def} · 💨 {spd}"))
                    .line(format!("**Strong against**\n{}", strong.join(", "))).private();
                card.accent = Some(rarity(&sp.rarity).3);
                card = self.with_picture(card, &sp);
                vec![Action::Reply { card }]
            }
            "buddy" => match self.mine(me, num("id").unwrap_or(0)) {
                Err(no) => private(no),
                Ok(c) => { let _ = self.db.get().critter_set_buddy(self.guild, me, c.id); private(format!("🐾 {} is your buddy now. It gains XP while you chat and fights in your battles.", self.label(&c))) }
            },
            "rename" => match self.mine(me, num("id").unwrap_or(0)) {
                Err(no) => private(no),
                Ok(c) => {
                    let name: String = ev.args.get("name").map(|n| n.trim().chars().filter(|ch| !"*_`~|<>@#".contains(*ch)).take(20).collect()).unwrap_or_default();
                    let _ = self.db.get().critter_rename(c.id, Some(name.as_str()).filter(|n| !n.is_empty()));
                    private(if name.is_empty() { format!("✏️ #{}'s nickname was removed.", c.id) } else { format!("✏️ #{} is now called **{name}**.", c.id) })
                }
            },
            "dex" => {
                let have = self.db.get().critter_kinds(self.guild, me).unwrap_or_default();
                let roster = self.roster();
                if roster.is_empty() { return private("There are no characters to collect yet. Staff add them with `/critters add`."); }
                let got = |c: &Character| have.contains(&c.id);
                let lines: Vec<String> = ELEMENTS.iter().filter_map(|(el, emoji, name, _, _)| {
                    let list: Vec<&Character> = roster.iter().filter(|c| c.element == *el).collect();
                    (!list.is_empty()).then(|| format!("{emoji} **{name}** {}/{}: {}", list.iter().filter(|c| got(c)).count(), list.len(), list.iter().map(|c| if got(c) { c.name.as_str() } else { "???" }).collect::<Vec<_>>().join(", ")))
                }).collect();
                let mut card = Card::new(Area::Games).title(format!("📖 Critter collection · {}/{}", roster.iter().filter(|c| got(c)).count(), roster.len())).line(lines.join("\n").chars().take(4000).collect::<String>()).private();
                card.accent = Some(0x6b93ff);
                vec![Action::Reply { card }]
            }
            "release" => match self.mine(me, num("id").unwrap_or(0)) {
                Err(no) => private(no),
                Ok(c) => vec![Action::Reply { card: Card::new(Area::Games).line(format!("Let {} go?{} This can't be undone.", self.label(&c), if self.money { format!(" You get {}.", self.coins(release_value(&c, &self.sp(&c.species)))) } else { String::new() })).button(format!("crit:release:{me}:{}", c.id), "Let it go", ButtonStyle::Danger).private() }],
            },
            sub @ ("trade" | "battle") => {
                let Some(other) = ev.target.as_ref().filter(|o| !o.bot && o.id != me) else { return private("Pick another member.") };
                let tok = format!("{:010x}", (ev.at_ms as u64).wrapping_mul(2_654_435_761) ^ (rand() * 1e9) as u64);
                let row = |card: Card| card.button_with(format!("crit:{sub}:{tok}:yes"), if sub == "trade" { "Accept trade" } else { "Fight!" }, ButtonStyle::Good, Some(if sub == "trade" { "🤝" } else { "⚔️" }.into())).button(format!("crit:{sub}:{tok}:no"), "No thanks", ButtonStyle::Plain);
                if sub == "trade" {
                    let a = match self.mine(me, num("give").unwrap_or(0)) { Ok(a) => a, Err(no) => return private(no) };
                    let Some(b) = self.db.get().critter(self.guild, num("get").unwrap_or(0)).ok().flatten().filter(|b| b.user == other.id) else { return private(format!("<@{}> doesn't have that critter. Ask them for its number (from `/critters list`).", other.id)) };
                    memory().offers.insert(tok.clone(), ("trade".into(), me.into(), other.id.clone(), a.id, b.id, ev.at_ms));
                    let mut card = row(Card::new(Area::Games).line(format!("<@{}>, <@{me}> wants to trade their {} for your {}.", other.id, self.label(&a), self.label(&b))));
                    card.ping = vec![other.id.clone()];
                    return vec![Action::Reply { card }];
                }
                let Some(mine) = self.buddy(me) else { return private("Pick a buddy first with `/critters buddy`.") };
                let Some(theirs) = self.buddy(&other.id) else { return private(format!("<@{}> doesn't have a buddy critter yet.", other.id)) };
                memory().offers.insert(tok.clone(), ("battle".into(), me.into(), other.id.clone(), 0, 0, ev.at_ms));
                let mut card = row(Card::new(Area::Games).line(format!("⚔️ <@{}>, <@{me}>'s {} challenges your {}!", other.id, self.label(&mine), self.label(&theirs))));
                card.ping = vec![other.id.clone()];
                vec![Action::Reply { card }]
            }
            sub => {
                if !perms::allowed(self.db, self.guild, &ev.member, ADMIN) { return private(format!("You don't have permission for that (`{}`).", ADMIN.key)); }
                if sub == "add" {
                    let name: String = ev.args.get("name").map(|n| n.trim().chars().filter(|c| !"*_`~|<>@#\n".contains(*c)).take(30).collect()).unwrap_or_default();
                    let id = slug(&name);
                    if id.is_empty() { return private("Give it a name with letters or numbers."); }
                    let mut roster = self.roster();
                    if roster.len() >= 200 { return private("A roster holds up to 200 characters. Remove one first."); }
                    if roster.iter().any(|c| c.id == id) { return private("There's already a character with that name."); }
                    let picture = ev.args.get("picture").map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
                    if picture.as_ref().is_some_and(|p| !p.starts_with("https://") || p.len() > 500 || p.contains(char::is_whitespace)) { return private("A picture must be an https address."); }
                    let stat = |k: &str| num(k).unwrap_or(50).clamp(10, 200);
                    let (element, rarity_id) = (ev.args.get("type").cloned().unwrap_or_default(), ev.args.get("rarity").cloned().unwrap_or_default());
                    if !TYPES.iter().any(|t| t.1 == element) || !RARITY_CHOICES.iter().any(|r| r.1 == rarity_id) { return private("Pick a type and a rarity from the lists."); }
                    roster.push(Character { id, name: name.clone(), element, rarity: rarity_id, hp: stat("hp"), atk: stat("attack"), def: stat("defense"), spd: stat("speed"), image: picture });
                    self.set_roster(&roster);
                    return private(format!("Added **{name}**. The roster has {} character{}.", roster.len(), if roster.len() == 1 { "" } else { "s" }));
                }
                if sub == "remove" {
                    let id = slug(ev.args.get("name").map(String::as_str).unwrap_or(""));
                    let mut roster = self.roster();
                    let Some(at) = roster.iter().position(|c| c.id == id) else { return private("There's no character with that name on the roster.") };
                    let gone = roster.remove(at);
                    self.set_roster(&roster);
                    return private(format!("Removed **{}**. Critters members already caught keep working.", gone.name));
                }
                if sub == "roster" {
                    let roster = self.roster();
                    if roster.is_empty() { return private("The roster is empty. Add characters with `/critters add`."); }
                    let lines: Vec<String> = roster.iter().map(|c| format!("{} **{}** · {} · {} / {} / {} / {}", element_tag(&c.element).chars().next().unwrap_or('•'), c.name, rarity(&c.rarity).1, c.hp, c.atk, c.def, c.spd)).collect();
                    return private(format!("**Roster ({})**  name · rarity · hp / atk / def / spd\n{}", roster.len(), lines.join("\n").chars().take(3800).collect::<String>()));
                }
                if sub == "here" {
                    let d = Data { db: self.db, guild: self.guild, module: MODULE };
                    let mut list: Vec<String> = d.get("channels").and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
                    let here = ev.place.channel.clone();
                    let on = !list.contains(&here);
                    if on { list.push(here.clone()); } else { list.retain(|c| *c != here); }
                    d.set("channels", &json!(list));
                    return private(if on { format!("✅ Critters now appear in <#{here}>{}.", if list.len() > 1 { format!(" (and {} other channel{})", list.len() - 1, if list.len() == 2 { "" } else { "s" }) } else { " (only here)".into() }) } else { format!("Critters no longer appear here.{}", if list.is_empty() { " With no channels picked, they can appear in any channel." } else { "" }) });
                }
                if self.roster().is_empty() { return private("There are no characters yet. Add some with `/critters add`."); }
                let mut out = private("Here comes one!");
                out.extend(self.spawn(&ev.place.channel, ev.at_ms, rand));
                out
            }
        }
    }
}
