//! Fishing's screens and flows, as Good Boy 3 has them: the hub, the cast popup, reeling with buttons, the bag and
//! selling, the tackle shop, rods and star upgrades, the collection and the daily and weekly challenges. The rules
//! are in `fishing.rs` and `fishchallenges.rs`; the saved data is Good Boy 3's own tables.
//!
//! Every screen belongs to the member who opened it. A cast in progress is saved after every press, so a restart in
//! the middle of a fight changes nothing.

use crate::bot::{CommandSpec, Directory};
use crate::card::group;
use crate::casino::MODULE;
use crate::fishchallenges as CH;
use crate::fishing::{self as F, CastGear, Earn, Reel};
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, Db, Field, FieldKind, FormEvent, Member, Select, Settings};
use gb_data::fishing::BagFish;

pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "fish", about: "Go fishing: cast, reel, collect and upgrade your gear", module: MODULE, options: &[], subs: &[] }];
const SESSION_MS: i64 = 10 * 60_000;
const DEX_PAGE: usize = 21;

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::Games).line(text).private() }]
}
fn stars(n: i64) -> String {
    format!("{}{}", "★".repeat(n.max(0) as usize), "☆".repeat((F::MAX_STARS - n).max(0) as usize))
}
fn short(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n.saturating_sub(1)).collect::<String>()) }
}
fn home_text(r: &F::RodDef) -> String {
    if r.perk == "mythic" || r.perk == "wanderer" { return "every place".into(); }
    let list: Vec<String> = r.home.iter().map(|h| { let b = F::biome_by_id(h); format!("{} {}", b.emoji, b.label) }).collect();
    if list.is_empty() { "none".into() } else { list.join(", ") }
}
fn mutation_label(m: &str) -> (&'static str, &'static str) {
    if m == "corrupted" { ("🕳️", "Corrupted") } else { ("🧬", "Mutated") }
}
/// "**Pier Minnow** · Common · 🧬 Mutated · Giant · 0.1 kg"
fn fish_line(species: &str, rarity: &str, mutation: Option<&str>, giant: bool, weight: f64) -> String {
    let name = F::fish_by_id(species).map(|f| f.name.as_str()).unwrap_or("Fish");
    let tags: Vec<String> = [mutation.map(|m| { let (e, l) = mutation_label(m); format!("{e} {l}") }), giant.then(|| "📏 Giant".to_string())].into_iter().flatten().collect();
    format!("**{name}** · {}{} · {} kg", F::rarity_by_id(rarity).label, if tags.is_empty() { String::new() } else { format!(" · {}", tags.join(" · ")) }, crate::fishchallenges::js_number(weight))
}
fn bag_line(c: &BagFish) -> String {
    fish_line(&c.species, &c.rarity, c.mutation.as_deref(), c.giant, c.weight)
}

pub struct Fishing<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub dir: &'a Directory,
    pub guild: &'a str,
}
impl Fishing<'_> {
    fn on(&self, key: &str) -> bool {
        self.settings.bool(self.guild, MODULE, key)
    }
    fn coins(&self, n: i64) -> String {
        format!("**{}** {}", group(n), self.settings.text(self.guild, crate::money::MODULE, "currencyEmoji").unwrap_or_else(|| "🪙".into()))
    }
    fn wallet(&self, user: &str) -> i64 {
        let start = self.settings.int(self.guild, crate::money::MODULE, "startingCoins");
        self.db.get().wallet(self.guild, user, None, start).map(|w| w.coins).unwrap_or(0)
    }
    fn debit(&self, user: &str, n: i64, why: &str) -> Result<(), String> {
        self.wallet(user);
        let done = self.db.get().debit(self.guild, user, n, why);
        match done {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(gb_data::Short::Only(have))) => Err(format!("You only have {}.", self.coins(have))),
            Err(e) => Err(format!("The wallet could not be changed just now ({e}).")),
        }
    }
    fn credit(&self, user: &str, n: i64, why: &str) {
        self.wallet(user);
        let _ = self.db.get().credit(self.guild, user, n, why);
    }
    fn profile(&self, user: &str) -> gb_data::fishing::FishProfile {
        self.db.get().fish_profile(self.guild, user).unwrap_or_default()
    }
    fn level_of(&self, user: &str) -> i64 {
        F::level_from_xp(self.profile(user).xp).level
    }
    fn belongs(&self, ev: &ButtonEvent, owner: &str) -> Option<Vec<Action>> {
        (owner != ev.member.id).then(|| private("That menu belongs to someone else. Run `/fish` for your own."))
    }
    fn live_streak(&self, p: &gb_data::fishing::FishProfile, now: i64) -> i64 {
        if p.streak_day.as_deref().is_some_and(|d| d == CH::day_key(now) || d == CH::yesterday_key(now)) { p.streak } else { 0 }
    }
    fn button_row(&self, card: Card, user: &str, view: &str, label: &str, emoji: &str) -> Card {
        card.button_with(format!("fh:{user}:{view}"), label, ButtonStyle::Plain, Some(emoji.into()))
    }

    // ------------------------------------------------------------------ the hub
    fn hub_text(&self, user: &str, now: i64) -> Card {
        let p = self.profile(user);
        let lv = F::level_from_xp(p.xp);
        let (bag_n, bag_v, _) = self.db.get().fish_bag_totals(self.guild, user).unwrap_or((0, 0, 0));
        let b = F::biome_by_id(p.last_biome.as_deref().unwrap_or("bay"));
        let rod = F::rod_by_id(p.last_rod.as_deref().unwrap_or("driftwood"));
        let bait = F::bait_by_id(p.last_bait.as_deref().unwrap_or("none"));
        let tackle = F::tackle_by_id(p.last_tackle.as_deref().unwrap_or("none"));
        let level_line = if lv.max { format!("Level **{}** (max) · {} XP", lv.level, group(p.xp)) } else { format!("Level **{}**\n{} {}/{} XP", lv.level, crate::card::bar_text(lv.into, lv.needed, 14), group(lv.into), group(lv.needed)) };
        let mut card = Card::new(Area::Games).title("🎣 Fishing").line(level_line);
        card = card
            .line(format!("**Last setup**\n{} {}\n🎣 {} · 🪱 {} · 🧰 {}", b.emoji, b.label, rod.label, bait.label, tackle.label))
            .line(format!("**Bag** {} fish worth {} · **Caught** {} of {} casts", group(bag_n), self.coins(bag_v), group(p.caught), group(p.casts)));
        let quests = self.on("fishChallenges");
        if quests {
            let rows = self.challenges(user, now);
            let done = rows.0.iter().filter(|r| r.done_at.is_some()).count();
            let weekly = rows.1.first().is_some_and(|r| r.done_at.is_some());
            let streak = self.live_streak(&p, now);
            card = card.line(format!("📜 {done}/3 today{}{}", if weekly { " · weekly ✅" } else { "" }, if streak > 0 { format!(" · 🔥 {streak}") } else { String::new() }));
        }
        card = card.line("-# Cast opens a form to pick where to fish, your rod, bait and tackle.")
            .button_with(format!("fh:{user}:cast"), "Cast", ButtonStyle::Good, Some("🎣".into()));
        card = self.button_row(card, user, "bag", "Bag", "🎒");
        card = self.button_row(card, user, "shop", "Shop", "🛒");
        card = self.button_row(card, user, "rods", "Rods", "🎣");
        card = self.button_row(card, user, "dex", "Collection", "📖");
        if quests { card = self.button_row(card, user, "quests", "Challenges", "📜"); }
        card.private()
    }


    // ------------------------------------------------------------------ the fishing screens as pictures
    /// Swaps a screen's long text for its picture (when pictures are on), keeping the buttons and menus the text version had.
    fn pictured(&self, card: Card, scr: gb_art::fishui::Screen, keep: Vec<String>) -> Card {
        if !self.pictures() { return card; }
        let Some((bytes, moving)) = gb_art::fishui::screen(&scr, self.settings.bool(self.guild, MODULE, "gameAnimations")) else { return card };
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        (scr.title, scr.subtitle, scr.tiles.iter().map(|t| (&t.title, &t.sub, &t.right, t.stars, &t.tag)).collect::<Vec<_>>(), &scr.foot).hash(&mut h);
        let mut c = card;
        c.lines = keep.into_iter().filter(|l| !l.is_empty()).collect();
        c.file(&format!("fishing-{:x}.{}", h.finish() & 0xffff_ffff, if moving { "gif" } else { "png" }), bytes)
    }
    fn rarity_hex(id: &str) -> String {
        format!("#{:06x}", F::rarity_by_id(id).color)
    }
    fn fish_tile(&self, c: &BagFish) -> gb_art::fishui::Tile {
        let name = F::fish_by_id(&c.species).map(|f| f.name.clone()).unwrap_or_else(|| "Fish".into());
        let tags: Vec<&str> = [c.mutation.as_deref().map(|m| mutation_label(m).1), c.giant.then_some("Giant")].into_iter().flatten().collect();
        gb_art::fishui::Tile { title: name, sub: format!("{} · {} kg", F::rarity_by_id(&c.rarity).label, crate::fishchallenges::js_number(c.weight)), right: group(c.value), accent: Self::rarity_hex(&c.rarity), tag: tags.join(" · "), ..Default::default() }
    }

    pub fn hub(&self, user: &str, now: i64) -> Card {
        let card = self.hub_text(user, now);
        let p = self.profile(user);
        let lv = F::level_from_xp(p.xp);
        let (bag_n, bag_v, _) = self.db.get().fish_bag_totals(self.guild, user).unwrap_or((0, 0, 0));
        let b = F::biome_by_id(p.last_biome.as_deref().unwrap_or("bay"));
        let rod = F::rod_by_id(p.last_rod.as_deref().unwrap_or("driftwood"));
        let bait = F::bait_by_id(p.last_bait.as_deref().unwrap_or("none"));
        let tackle = F::tackle_by_id(p.last_tackle.as_deref().unwrap_or("none"));
        let mut stats = vec![("Bag".to_string(), format!("{} fish", group(bag_n))), ("Worth".to_string(), group(bag_v)), ("Caught".to_string(), format!("{} / {} casts", group(p.caught), group(p.casts)))];
        if self.on("fishChallenges") {
            let rows = self.challenges(user, now);
            let done = rows.0.iter().filter(|r| r.done_at.is_some()).count();
            let streak = self.live_streak(&p, now);
            stats.push(("Challenges".to_string(), format!("{done}/3 today{}", if streak > 0 { format!(" · streak {streak}") } else { String::new() })));
        }
        let tile = |title: &str, sub: &str, accent: &str| gb_art::fishui::Tile { title: title.into(), sub: sub.into(), accent: accent.into(), ..Default::default() };
        let scr = gb_art::fishui::Screen { biome: b.id, place: b.label, title: "Fishing", subtitle: &format!("Level {}{}", lv.level, if lv.max { " (max)" } else { "" }), stats,
            meter: Some(if lv.max { (1.0, format!("Max level · {} XP", group(p.xp))) } else { (lv.into as f32 / lv.needed.max(1) as f32, format!("{} / {} XP to level {}", group(lv.into), group(lv.needed), lv.level + 1)) }),
            tiles: vec![tile("Where", b.label, "#3f9bd1"), tile("Rod", rod.label, "#e0a030"), tile("Bait", bait.label, "#58b368"), tile("Tackle", tackle.label, "#9b6fd6")], columns: 2, foot: "Cast opens a form to pick where to fish, your rod, bait and tackle.".into(), empty: "" };
        self.pictured(card, scr, vec![format!("-# Level {} · bag {} fish worth {} · {} of {} casts caught", lv.level, group(bag_n), group(bag_v), group(p.caught), group(p.casts))])
    }
    fn bag_card(&self, user: &str, note: Option<String>) -> Card {
        let card = self.bag_text(user, note.clone());
        let rows = self.db.get().fish_bag_top(self.guild, user, 10).unwrap_or_default();
        let (n, v, _) = self.db.get().fish_bag_totals(self.guild, user).unwrap_or((0, 0, 0));
        let p = self.profile(user);
        let b = F::biome_by_id(p.last_biome.as_deref().unwrap_or("bay"));
        let scr = gb_art::fishui::Screen { biome: b.id, place: b.label, title: "Your bag", subtitle: &format!("{} fish worth {} coins", group(n), group(v)), stats: vec![("Fish".into(), group(n)), ("Worth".into(), group(v))], meter: None,
            tiles: rows.iter().map(|c| self.fish_tile(c)).collect(), columns: 2, foot: if n > 10 { "Showing the 10 most valuable".into() } else { String::new() }, empty: "Empty. Go catch something!" };
        self.pictured(card, scr, vec![note.unwrap_or_default(), format!("-# {} fish · worth {} in total", group(n), group(v))])
    }
    fn rods_card(&self, user: &str) -> Card {
        let card = self.rods_text(user);
        let p = self.profile(user);
        let b = F::biome_by_id(p.last_biome.as_deref().unwrap_or("bay"));
        let mut owned: Vec<&F::RodDef> = F::RODS.iter().filter(|r| p.rods.iter().any(|x| x == r.id)).collect();
        owned.sort_by_key(|r| std::cmp::Reverse(F::rod_stats(r.id, 1, None).power));
        let mut tiles: Vec<gb_art::fishui::Tile> = owned.iter().map(|r| gb_art::fishui::Tile { title: r.label.into(), sub: F::perk(r.perk).map(|x| x.1.to_string()).unwrap_or_default(), accent: "#e0a030".into(), stars: *p.stars.get(r.id).unwrap_or(&1) as u8, ..Default::default() }).collect();
        let to_earn: Vec<&F::RodDef> = F::RODS.iter().filter(|r| r.earn.is_some() && !p.rods.iter().any(|x| x == r.id) && !matches!(r.earn, Some(Earn::Collection(_)))).collect();
        tiles.extend(to_earn.iter().take(8).map(|r| gb_art::fishui::Tile { title: r.label.into(), sub: F::earn_text(r), accent: "#6b7080".into(), tag: "LOCKED".into(), dim: true, ..Default::default() }));
        let keeps = F::RODS.iter().filter(|r| matches!(r.earn, Some(Earn::Collection(_))) && !p.rods.iter().any(|x| x == r.id)).count();
        let scr = gb_art::fishui::Screen { biome: b.id, place: b.label, title: "Your rods", subtitle: &format!("{} owned", owned.len()), stats: vec![("Owned".into(), owned.len().to_string())], meter: None, tiles, columns: 2,
            foot: if keeps > 0 { format!("{keeps} Keepsake rods: catch every fish in a place to earn its rod") } else { String::new() }, empty: "No rods yet." };
        self.pictured(card, scr, vec!["-# Every rod has a perk and home places where it is stronger. Upgrade your favourites to five stars with coins and fish.".into()])
    }
    fn shop_card(&self, user: &str, note: Option<String>) -> Card {
        let card = self.shop_text(user, note.clone());
        let p = self.profile(user);
        let lv = F::level_from_xp(p.xp).level;
        let stock = self.db.get().fish_bait_stock(self.guild, user).unwrap_or_default();
        let coins = self.wallet(user);
        let b = F::biome_by_id(p.last_biome.as_deref().unwrap_or("bay"));
        let owns = |id: &str| p.rods.iter().any(|r| r == id);
        let mut tiles: Vec<gb_art::fishui::Tile> = Vec::new();
        let shop: Vec<&F::RodDef> = F::RODS.iter().filter(|r| r.earn.is_none() && r.price > 0 && (owns(r.id) || r.level <= lv + 5)).collect();
        for r in shop.iter().rev().take(6).rev() {
            let own = owns(r.id);
            tiles.push(gb_art::fishui::Tile { title: r.label.into(), sub: format!("Level {}{}", r.level, F::perk(r.perk).map(|x| format!(" · {}", x.1)).unwrap_or_default()), right: if own { String::new() } else { group(r.price) }, accent: "#3f9bd1".into(), tag: if own { "OWNED".into() } else if r.level > lv { "LOCKED".into() } else { "ROD".into() }, dim: !own && r.level > lv, ..Default::default() });
        }
        for t in F::tackles().iter().filter(|t| t.price > 0) {
            let own = p.tackle.iter().any(|x| x == t.id);
            tiles.push(gb_art::fishui::Tile { title: t.label.into(), sub: t.desc.to_string(), right: if own { String::new() } else { group(t.price) }, accent: "#9b6fd6".into(), tag: if own { "OWNED".into() } else { "TACKLE".into() }, ..Default::default() });
        }
        for bt in F::baits().iter().filter(|b| b.price > 0) {
            let have = stock.get(bt.id).copied().unwrap_or(0);
            tiles.push(gb_art::fishui::Tile { title: bt.label.into(), sub: format!("luck +{}% · you have {}", (bt.luck * 100.0).round(), have), right: format!("{} each", group(bt.price)), accent: "#58b368".into(), tag: "BAIT".into(), ..Default::default() });
        }
        let scr = gb_art::fishui::Screen { biome: b.id, place: b.label, title: "Tackle shop", subtitle: &format!("You have {} coins", group(coins)), stats: vec![("Coins".into(), group(coins)), ("Level".into(), lv.to_string())], meter: None, tiles, columns: 2,
            foot: "Rods stay yours. Tackle is kept forever. Bait is used one per cast.".into(), empty: "Nothing for sale." };
        self.pictured(card, scr, vec![note.unwrap_or_default(), "-# Pick something to buy from the menu below.".into()])
    }
    fn challenges_card(&self, user: &str, now: i64) -> Card {
        let card = self.challenges_text(user, now);
        let (daily, weekly) = self.challenges(user, now);
        let p = self.profile(user);
        let b = F::biome_by_id(p.last_biome.as_deref().unwrap_or("bay"));
        let fmt = |n: i64| self.coins(n).replace("**", "");
        let tile = |r: &gb_data::fishing::ChallengeRow, accent: &str| {
            let spec = Self::spec(r)?;
            let (g, pr) = (spec.goal, r.progress.min(spec.goal));
            Some(gb_art::fishui::Tile { title: CH::describe(&spec, &fmt).replace("**", ""), sub: format!("{}/{} · {}{}", group(pr), group(g), group(spec.reward.coins), if spec.reward.xp > 0 { format!(" + {} XP", group(spec.reward.xp)) } else { String::new() }), accent: if r.done_at.is_some() { "#3fd08f".into() } else { accent.into() }, bar: Some(pr as f32 / g.max(1) as f32), tag: if r.done_at.is_some() { "DONE".into() } else { String::new() }, ..Default::default() })
        };
        let mut tiles: Vec<gb_art::fishui::Tile> = daily.iter().filter_map(|r| tile(r, "#3f9bd1")).collect();
        tiles.extend(weekly.iter().filter_map(|r| tile(r, "#e0a030")));
        let done_today = daily.iter().filter(|r| r.done_at.is_some()).count();
        let streak = self.live_streak(&p, now);
        let scr = gb_art::fishui::Screen { biome: b.id, place: b.label, title: "Fishing challenges", subtitle: &format!("{done_today}/3 done today · streak {streak} day{}", if streak == 1 { "" } else { "s" }), stats: vec![("Today".into(), format!("{done_today}/3")), ("Streak".into(), streak.to_string())], meter: None, tiles, columns: 1,
            foot: "Three daily challenges and one weekly. Rewards are paid the moment you finish one.".into(), empty: "No challenges right now." };
        self.pictured(card, scr, vec![format!("-# Daily challenges refresh <t:{}:R> · weekly <t:{}:R>", CH::next_day_at(now) / 1000, CH::next_week_at(now) / 1000)])
    }
    fn dex_card(&self, user: &str, view: Option<&str>) -> Card {
        let card = self.dex_text(user, view);
        let seen = self.db.get().fish_dex(self.guild, user).unwrap_or_default();
        let total = F::fish_list().len();
        let found = seen.keys().filter(|k| F::fish_by_id(k).is_some()).count();
        let lv = self.level_of(user);
        let (biome, page_raw) = view.unwrap_or("").split_once('.').unwrap_or((view.unwrap_or(""), ""));
        let scr = if let Some(pl) = F::biomes().into_iter().find(|b| b.id == biome) {
            let list = F::fish_in(pl.id);
            let have = list.iter().filter(|f| seen.contains_key(&f.id)).count();
            let pages = list.len().div_ceil(DEX_PAGE).max(1);
            let page = page_raw.parse::<i64>().unwrap_or(0).clamp(0, pages as i64 - 1) as usize;
            let tiles = list.iter().skip(page * DEX_PAGE).take(DEX_PAGE).map(|f| match seen.get(&f.id) {
                Some((count, best)) => gb_art::fishui::Tile { title: f.name.clone(), sub: format!("best {} kg · caught {}", crate::fishchallenges::js_number(*best), group(*count)), accent: Self::rarity_hex(f.rarity), tag: F::rarity_by_id(f.rarity).label.to_string(), ..Default::default() },
                None => gb_art::fishui::Tile { title: "? ? ?".into(), sub: format!("{} fish", F::rarity_by_id(f.rarity).label), accent: "#4a4e5a".into(), dim: true, ..Default::default() },
            }).collect();
            gb_art::fishui::Screen { biome: pl.id, place: pl.label, title: pl.label, subtitle: &format!("{have} of {} fish found", list.len()), stats: vec![("Found".into(), format!("{have}/{}", list.len()))], meter: Some((have as f32 / list.len().max(1) as f32, format!("{have} of {} found{}", list.len(), if pages > 1 { format!(" · page {} of {pages}", page + 1) } else { String::new() }))), tiles, columns: 2,
                foot: if pl.level > lv { format!("Unlocks at fishing level {}", pl.level) } else { pl.blurb.to_string() }, empty: "No fish here." }
        } else {
            let tiles = F::biomes().iter().map(|b| { let list = F::fish_in(b.id); let have = list.iter().filter(|f| seen.contains_key(&f.id)).count(); gb_art::fishui::Tile { title: b.label.into(), sub: if b.level > lv { format!("Level {}", b.level) } else { format!("{have} of {}", list.len()) }, accent: if have == list.len() && have > 0 { "#3fd08f".into() } else { "#3f9bd1".into() }, bar: Some(have as f32 / list.len().max(1) as f32), tag: if have == list.len() && have > 0 { "DONE".into() } else { String::new() }, dim: b.level > lv, ..Default::default() } }).collect();
            gb_art::fishui::Screen { biome: "bay", place: "Collection", title: "Collection", subtitle: &format!("{} of {} fish found", group(found as i64), group(total as i64)), stats: vec![("Found".into(), format!("{}/{}", group(found as i64), group(total as i64)))], meter: Some((found as f32 / total.max(1) as f32, format!("{} of {} fish", group(found as i64), group(total as i64)))), tiles, columns: 2, foot: "Pick a place from the menu to see its fish.".into(), empty: "" }
        };
        self.pictured(card, scr, Vec::new())
    }

    // ------------------------------------------------------------------ casting
    /// The cast popup: where, rod, bait, tackle, each starting at the last choice.
    pub fn cast_form(&self, user: &str) -> Action {
        let p = self.profile(user);
        let lv = F::level_from_xp(p.xp).level;
        let stock = self.db.get().fish_bait_stock(self.guild, user).unwrap_or_default();
        let last_biome = p.last_biome.clone().unwrap_or_else(|| "bay".into());
        let last_rod = p.last_rod.clone().unwrap_or_else(|| "driftwood".into());
        let last_bait = p.last_bait.clone().unwrap_or_else(|| "none".into());
        let last_tackle = p.last_tackle.clone().unwrap_or_else(|| "none".into());
        let places: Vec<(String, String)> = F::biomes().into_iter().filter(|b| b.level <= lv).map(|b| (short(&format!("{} {}", b.emoji, b.label), 100), b.id.to_string())).collect();
        let mut owned: Vec<&F::RodDef> = F::RODS.iter().filter(|r| p.rods.iter().any(|x| x == r.id)).collect();
        owned.sort_by(|a, b| {
            let key = |r: &&F::RodDef| (r.id == last_rod, F::rod_stats(r.id, *p.stars.get(r.id).unwrap_or(&1), None).power);
            key(b).cmp(&key(a))
        });
        let rods: Vec<(String, String)> = owned.iter().take(25).map(|r| (short(&format!("{} {}", r.label, "★".repeat(*p.stars.get(r.id).unwrap_or(&1) as usize)), 100), r.id.to_string())).collect();
        let baits: Vec<(String, String)> = F::baits().into_iter().filter(|b| b.id == "none" || stock.get(b.id).copied().unwrap_or(0) > 0).map(|b| (if b.id == "none" { b.label.to_string() } else { format!("{} ({} left)", b.label, stock.get(b.id).copied().unwrap_or(0)) }, b.id.to_string())).collect();
        let tackles: Vec<(String, String)> = F::tackles().into_iter().filter(|t| t.id == "none" || p.tackle.iter().any(|x| x == t.id)).map(|t| (t.label.to_string(), t.id.to_string())).collect();
        let pick = |list: &[(String, String)], want: &str, fallback: &str| if list.iter().any(|o| o.1 == want) { want.to_string() } else { fallback.to_string() };
        let field = |id: &str, label: &str, options: Vec<(String, String)>, value: String, hints: Vec<String>| Field { id: id.into(), label: label.into(), kind: FieldKind::Select(options), required: true, value: Some(value), hints, ..Default::default() };
        let place_hints: Vec<String> = F::biomes().into_iter().filter(|b| b.level <= lv).map(|b| short(b.blurb, 100)).collect();
        let rod_hints: Vec<String> = owned.iter().take(25).map(|r| short(&format!("{}home: {}", F::perk(r.perk).map(|(e, l, _)| format!("{e} {l} · ")).unwrap_or_default(), home_text(r)), 100)).collect();
        let bait_hints: Vec<String> = F::baits().into_iter().filter(|b| b.id == "none" || stock.get(b.id).copied().unwrap_or(0) > 0).map(|b| if b.id == "none" { "Free, no bonus".to_string() } else { format!("Luck +{}%{}", (b.luck * 100.0).round(), if b.corruption > 0.0 { " · draws corruption" } else { "" }) }).collect();
        let tackle_hints: Vec<String> = F::tackles().into_iter().filter(|t| t.id == "none" || p.tackle.iter().any(|x| x == t.id)).map(|t| short(t.desc, 100)).collect();
        Action::Form { id: format!("fcast:{user}"), title: "Cast your line".into(), fields: vec![
            field("biome", "Where to fish", places.clone(), pick(&places, &last_biome, "bay"), place_hints),
            field("rod", "Rod", rods.clone(), pick(&rods, &last_rod, "driftwood"), rod_hints),
            field("bait", "Bait", baits.clone(), pick(&baits, &last_bait, "none"), bait_hints),
            field("tackle", "Tackle", tackles.clone(), pick(&tackles, &last_tackle, "none"), tackle_hints),
        ] }
    }
    pub fn form(&self, ev: &FormEvent, now: i64, rng: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        let mut parts = ev.id.split(':');
        let (kind, owner) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        if owner != ev.member.id { return private("That form belongs to someone else. Run `/fish` for your own."); }
        let v = |k: &str, d: &str| ev.values.get(k).map(String::as_str).filter(|s| !s.is_empty()).unwrap_or(d).to_string();
        match kind {
            "fcast" => self.cast(&ev.member, (&v("biome", "bay"), &v("rod", "driftwood"), &v("bait", "none"), &v("tackle", "none")), now, rng, false),
            _ => {
                // fbait:<user>:<bait>
                let bait = ev.id.rsplit(':').next().unwrap_or("");
                let qty = match crate::money::parse_amount(&v("qty", "1"), None, 1, 500) { Ok(n) => n, Err(e) => return private(e) };
                match self.buy_item(&ev.member.id, &format!("bait-{bait}"), qty) { Ok(label) => private(format!("✅ Bought **{label}**.")), Err(e) => private(e) }
            }
        }
    }
    fn check_setup(&self, user: &str, setup: (&str, &str, &str, &str)) -> Result<(), String> {
        let p = self.profile(user);
        let lv = F::level_from_xp(p.xp).level;
        let b = F::biome_by_id(setup.0);
        if b.level > lv { return Err(format!("{} unlocks at fishing level {}. You are level {lv}.", b.label, b.level)); }
        if !p.rods.iter().any(|r| r == setup.1) { return Err("You do not own that rod.".into()); }
        if setup.3 != "none" && !p.tackle.iter().any(|t| t == setup.3) { return Err("You do not own that tackle.".into()); }
        if setup.2 != "none" && self.db.get().fish_bait_stock(self.guild, user).unwrap_or_default().get(setup.2).copied().unwrap_or(0) <= 0 { return Err(format!("You are out of {}.", F::bait_by_id(setup.2).label)); }
        Ok(())
    }
    fn luck_boost(&self, user: &str, now: i64) -> bool {
        self.db.get().data_get(self.guild, crate::money::MODULE, &format!("boost:luck:{user}")).ok().flatten().and_then(|v| v.as_i64()).is_some_and(|t| t > now)
    }
    /// Casting: an older cast still open is shown again; otherwise a new one starts.
    pub fn cast(&self, who: &Member, setup: (&str, &str, &str, &str), now: i64, rng: &mut dyn FnMut(i64, i64) -> i64, update: bool) -> Vec<Action> {
        if !self.on("fishingEnabled") { return private("That game is turned off in this server."); }
        let user = who.id.as_str();
        let wrap = |card: Card| if update { Action::Update { card } } else { Action::Reply { card: card.private() } };
        let open = self.db.get().game_session_active(self.guild, user, "fish", now - SESSION_MS).ok().flatten();
        if let Some(id) = open {
            let old = self.load_reel(&id);
            let stale = match &old { None => true, Some(s) => s.status != "reeling" || (F::bitten(s, now) && now - s.last_at.max(s.bite_at) > F::IDLE_MS) };
            if stale { let _ = self.db.get().game_session_drop(&id); } else if let Some(s) = old {
                let card = self.reel_card(&s, &id, now).line("🪝 You still have a fish on the line from your last cast. Here it is, reel it in!");
                let wait = (s.bite_at - now).max(0);
                let mut out = vec![wrap(card)];
                if wait > 0 { out.push(Action::BiteWatch { id, after_ms: wait as u64 + 100 }); }
                return out;
            }
        }
        if let Err(e) = self.check_setup(user, setup) { return private(e); }
        if setup.2 != "none" && !self.db.get().fish_bait_use(self.guild, user, setup.2).unwrap_or(false) { return private(format!("You are out of {}. Buy more in the shop, or fish without bait.", F::bait_by_id(setup.2).label)); }
        let p = self.profile(user);
        let seed = rng(0, (1i64 << 31) - 1) as u32;
        let star = *p.stars.get(setup.1).unwrap_or(&1);
        let lucky = self.luck_boost(user, now);
        let mut r = F::seeded(seed ^ 0x5bd1_e995);
        let fish = F::roll_catch(&CastGear { biome: setup.0, rod: setup.1, bait: setup.2, tackle: setup.3, stars: star, bonus_luck: if lucky { 0.3 } else { 0.0 } }, &mut || r.next());
        let mut s = F::start_reel(setup.1, setup.3, fish, seed, now, None, true, star, Some(setup.0));
        s.biome = Some(setup.0.into());
        s.bait = Some(setup.2.into());
        let _ = self.db.get().fish_cast_started(self.guild, user, setup.0, setup.1, setup.2, setup.3);
        let id = format!("{:010x}", rng(0, i64::MAX >> 8));
        self.save_reel(&id, user, &s, now);
        let card = self.reel_card(&s, &id, now);
        let wait = (s.bite_at - now).max(0) as u64;
        vec![wrap(card), Action::BiteWatch { id, after_ms: wait + 100 }]
    }
    fn save_reel(&self, id: &str, user: &str, s: &Reel, now: i64) {
        let _ = self.db.get().game_session_save(self.guild, id, user, "fish", &serde_json::to_string(s).unwrap_or_default(), now);
    }
    fn load_reel(&self, id: &str) -> Option<Reel> {
        let row = self.db.get().game_session(self.guild, id).ok().flatten()?;
        (row.kind == "fish").then(|| serde_json::from_str(&row.state).ok()).flatten()
    }
    fn pictures(&self) -> bool {
        self.settings.bool(self.guild, MODULE, "gamePictures")
    }
    fn reel_card(&self, s: &Reel, id: &str, now: i64) -> Card {
        let b = F::biome_by_id(s.biome.as_deref().unwrap_or("bay"));
        let waiting = !F::bitten(s, now);
        let note = F::reel_note(s, now);
        let r = F::rarity_by_id(&s.fish.rarity);
        let color = format!("#{:06x}", r.color);
        let moving = self.settings.bool(self.guild, MODULE, "gameAnimations");
        let draw = if moving { gb_art::games::fishing_loop } else { gb_art::games::fishing };
        let picture = self.pictures().then(|| draw(&gb_art::games::Fight {
            biome: b.id, place: b.label, rarity: (!waiting).then_some((r.label, color.as_str())), track: F::TRACK, zone: s.zone, zone_width: s.gear.control, pos: s.pos,
            catch_pct: s.progress as f32, tension_pct: (s.tension / s.gear.line as f64 * 100.0) as f32, surge: s.surge.is_some(),
        })).flatten();
        let top = if waiting { note.unwrap_or_default() } else {
            let hint = match s.fish.rarity.as_str() { "legendary" => "✨ Something **huge** is fighting back!", "mythical" => "✨ The water is glowing... this is no ordinary fish.", _ => "🐟 Something bit!" };
            [note.unwrap_or_default(), hint.to_string()].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join("\n")
        };
        let mut card = Card::new(Area::Games).title(if waiting { "🎣 Waiting for a bite".to_string() } else { "🎣 Reeling".to_string() });
        card = match picture {
            Some(pic) => card.file(&format!("fishing-{id}-{}-{}.{}", s.step, i64::from(waiting), if moving { "gif" } else { "png" }), pic).line(top),
            None => card.line(format!("{} {}", b.emoji, b.label)).line(if waiting { top } else { format!("{top}\n{}", F::reel_panel(s)) }),
        };
        card = card.line(format!("-# {} · {} · {} · keep the fish inside the green zone and Reel · Slack lets tension off", F::rod_by_id(&s.rod).label, F::bait_by_id(s.bait.as_deref().unwrap_or("none")).label, F::tackle_by_id(&s.tackle).label));
        card.accent = Some(if s.surge.is_some() { 0xf1c40f } else if waiting { 0x5fd3e6 } else { r.color });
        card.button_with(format!("fr:{id}:left"), "Pull", ButtonStyle::Plain, Some("◀️".into()))
            .button_with(format!("fr:{id}:reel"), "Reel", ButtonStyle::Good, Some("🎣".into()))
            .button_with(format!("fr:{id}:right"), "Pull", ButtonStyle::Plain, Some("▶️".into()))
            .button_with(format!("fr:{id}:slack"), "Slack", ButtonStyle::Primary, Some("🪢".into()))
            .button_with(format!("fr:{id}:cut"), "Cut line", ButtonStyle::Danger, Some("✂️".into()))
    }
    /// The bite: the cast's card with the bite showing (the Discord layer edits the message at that moment).
    pub fn bite_card(&self, id: &str, now: i64) -> Option<Card> {
        let s = self.load_reel(id)?;
        if s.status != "reeling" || s.struck.is_some() || s.step > 0 { return None; }
        Some(self.reel_card(&s, id, now).private())
    }

    // ------------------------------------------------------------------ reeling
    fn reel_press(&self, ev: &ButtonEvent, id: &str, action: &str, rng: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        let now = ev.at_ms;
        let user = ev.member.id.as_str();
        let Some(row) = self.db.get().game_session(self.guild, id).ok().flatten().filter(|r| r.kind == "fish") else { return private("That game has finished. Start a new one!") };
        if row.user != user { return private("That is someone else's game. Start your own!"); }
        let Some(mut s) = serde_json::from_str::<Reel>(&row.state).ok() else { return private("That game has finished. Start a new one!") };
        if action == "cut" { s.status = "escaped".into(); s.reason = Some("cut".into()); } else if matches!(action, "left" | "right" | "reel" | "slack") { F::reel_step(&mut s, action, now); }
        if s.status == "reeling" {
            self.save_reel(id, user, &s, now);
            return vec![Action::Update { card: self.reel_card(&s, id, now) }];
        }
        let mut salvaged: Option<String> = None;
        let mut landed = None;
        // in Ironwreck Graveyard a catch can be an old rod instead of a fish
        if s.status == "caught" && s.biome.as_deref() == Some("wreck") {
            if let Some(next) = F::next_sunken(&self.profile(user).rods) {
                let chance = F::SUNKEN_CHANCE * if s.gear.perk.as_deref() == Some("sunken") { 3.0 } else { 1.0 };
                if (rng(0, 999_999) as f64 / 1_000_000.0) < chance {
                    s.status = "salvaged".into();
                    salvaged = self.award_rod(user, next.id);
                }
            }
        }
        let landed_fish = s.status == "caught";
        if landed_fish { landed = Some(self.land_fish(user, &s, now)); }
        let _ = self.db.get().game_session_drop(id);
        let b = F::biome_by_id(s.biome.as_deref().unwrap_or("bay"));
        let mut card = Card::new(Area::Games).title(format!("{} {}", b.emoji, b.label));
        if s.status == "salvaged" {
            card = card.line(format!("# ⚓\nYour line snagged on something heavy... it's not a fish, it's an **old rod** from one of the wrecks!\n{}", salvaged.unwrap_or_default()));
            card.accent = Some(0xc9a227);
        } else if let Some((xp, before, after, lines)) = landed {
            let r = F::rarity_by_id(&s.fish.rarity);
            let name = F::fish_by_id(&s.fish.species).map(|f| f.name.clone()).unwrap_or_default();
            let big = matches!(s.fish.rarity.as_str(), "legendary" | "mythical") || s.fish.mutation.is_some();
            let skill: Vec<String> = [(s.struck == Some(true)).then(|| "⚡ strike".to_string()), (s.surges.won > 0).then(|| format!("🙌 {} surge{} nailed", s.surges.won, if s.surges.won == 1 { "" } else { "s" }))].into_iter().flatten().collect();
            let rar_color = format!("#{:06x}", r.color);
            let tags = [s.fish.mutation.as_deref().map(|m| mutation_label(m).1), s.fish.giant.then_some("Giant")].into_iter().flatten().collect::<Vec<_>>().join(" · ");
            let moving = self.settings.bool(self.guild, MODULE, "gameAnimations");
            let draw = if moving { gb_art::games::fishing_result_film } else { gb_art::games::fishing_result };
            let picture = self.pictures().then(|| draw(b.id, b.label, Some((r.label, &rar_color, &format!("{name}{}", if tags.is_empty() { String::new() } else { format!(" · {tags}") }), &format!("{} kg · worth {} · +{xp} XP", crate::fishchallenges::js_number(s.fish.weight), group(s.fish.value)))), "")).flatten();
            if let Some(pic) = picture { card = card.file(&format!("catch-{id}.{}", if moving { "gif" } else { "png" }), pic); }
            let mut text = vec![if card.files.is_empty() { format!("# 💦 {}{}", rarity_fish(&s.fish.rarity), if big { " ✨" } else { "" }) } else { String::new() }, format!("🎉 You caught a {}!", fish_line(&s.fish.species, &s.fish.rarity, s.fish.mutation.as_deref(), s.fish.giant, s.fish.weight)),
                format!("Worth {} · +{xp} XP{}", self.coins(s.fish.value), if skill.is_empty() { String::new() } else { format!(" · {}", skill.join(" · ")) })];
            text.extend(lines);
            if after > before { text.push(format!("⬆️ **Fishing level {after}{}!**{}", if after >= F::MAX_LEVEL { " (max)" } else { "" }, unlock_text(before, after))); }
            card = card.line(text.into_iter().filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n"));
            card.accent = Some(if s.fish.mutation.as_deref() == Some("corrupted") { 0x2c2f33 } else { r.color });
        } else {
            let why = match (s.status.as_str(), s.reason.as_deref()) {
                ("snapped", _) => "💥 **Snap!** The line broke. Watch the tension bar, press Slack, or fit a Steel Leader.",
                (_, Some("cut")) => "✂️ You cut the line.",
                (_, Some("idle")) => "⌛ You waited too long and it swam off.",
                (_, Some("tired")) => "😮‍💨 It tired you out and swam away.",
                _ => "🐟 It got away!",
            };
            let missed = match (s.status.as_str(), s.reason.as_deref()) { ("snapped", _) => "The line snapped", (_, Some("cut")) => "Line cut", _ => "It got away" };
            let moving = self.settings.bool(self.guild, MODULE, "gameAnimations");
            let draw = if moving { gb_art::games::fishing_result_film } else { gb_art::games::fishing_result };
            if let Some(pic) = self.pictures().then(|| draw(b.id, b.label, None, missed)).flatten() { card = card.file(&format!("miss-{id}.{}", if moving { "gif" } else { "png" }), pic); }
            card = card.line(format!("{why}\nIt was a **{}** fish.", F::rarity_by_id(&s.fish.rarity).label));
            card.accent = Some(0xed4245);
        }
        card = card.button_with(format!("fh:{user}:again"), "Cast again", ButtonStyle::Good, Some("🎣".into()))
            .button_with(format!("fh:{user}:cast"), "Change setup", ButtonStyle::Plain, Some("⚙️".into()))
            .button_with(format!("fh:{user}:bag"), "Bag", ButtonStyle::Plain, Some("🎒".into()));
        let mut out = vec![Action::Update { card }];
        // a rare catch is announced when the server has big-win announcements on
        if landed_fish {
            let kind = match s.fish.rarity.as_str() { "mythical" => Some("mythical"), "legendary" => Some("legendary"), _ => s.fish.mutation.as_ref().map(|_| "mutated") };
            if let (Some(kind), Some(f)) = (kind, F::fish_by_id(&s.fish.species)) {
                let name = ev.member.name.replace(['*', '_', '`', '~', '|', '>', '@'], "");
                let tag = s.fish.mutation.as_deref().map(|m| format!("{} ", mutation_label(m).1)).unwrap_or_default();
                out.extend(crate::casino::shout(self.db, self.settings, self.guild, (user, &ev.place.channel), format!("🎣 **{name}** caught a {tag}**{}** ({})!", f.name, F::rarity_by_id(&s.fish.rarity).label), kind, now));
            }
        }
        out
    }
    /// Records a caught fish: bag, collection, XP, challenges and keepsake rods. (XP, level before, level after, lines to show.)
    fn land_fish(&self, user: &str, s: &Reel, now: i64) -> (i64, i64, i64, Vec<String>) {
        let c = &s.fish;
        let sp = F::fish_by_id(&c.species);
        let biome = sp.map(|f| f.biome).unwrap_or("bay");
        let before = F::level_from_xp(self.profile(user).xp).level;
        let xp = F::catch_xp(c, Some(biome), s.gear.perk.as_deref());
        let is_new = self.db.get().fish_dex_add(self.guild, user, &c.species, c.weight, now).unwrap_or(false);
        let _ = self.db.get().fish_bag_add(self.guild, user, &c.species, &c.rarity, c.mutation.as_deref(), c.giant, c.weight, c.value, biome, now);
        let _ = self.db.get().fish_landed(self.guild, user, xp, c.weight);
        let mut lines = self.progress_challenges(user, &CH::Event::Catch(c), now);
        if is_new { lines.extend(self.collection_rod(user, biome)); }
        let after = F::level_from_xp(self.profile(user).xp).level;
        (xp, before, after, lines)
    }
    fn award_rod(&self, user: &str, rod: &str) -> Option<String> {
        let p = self.profile(user);
        if p.rods.iter().any(|r| r == rod) { return None; }
        let mut rods = p.rods.clone();
        rods.push(rod.into());
        let _ = self.db.get().fish_set_rods(self.guild, user, &rods, None);
        let r = F::rod_by_id(rod);
        let pk = F::perk(r.perk).map(|(e, l, d)| format!("{e} {l}: {d}. ")).unwrap_or_default();
        Some(format!("🎁 **New rod: {}!** {pk}Pick it when you cast.", r.label))
    }
    fn collection_rod(&self, user: &str, biome: &str) -> Option<String> {
        let ids: Vec<String> = F::fish_in(biome).iter().map(|f| f.id.clone()).collect();
        let have = { let dex = self.db.get().fish_dex(self.guild, user).unwrap_or_default(); ids.iter().filter(|i| dex.contains_key(*i)).count() };
        if have >= ids.len() { self.award_rod(user, &format!("keep-{biome}")) } else { None }
    }
    fn challenge_rods(&self, user: &str, now: i64) -> Vec<String> {
        let p = self.profile(user);
        F::challenge_rods_due(self.live_streak(&p, now), p.weeklies, &p.rods).into_iter().filter_map(|r| self.award_rod(user, r.id)).collect()
    }

    // ------------------------------------------------------------------ challenges
    fn periods(now: i64) -> (String, String) {
        (format!("d:{}", CH::day_key(now)), format!("w:{}", CH::week_key(now)))
    }
    /// Today's and this week's challenges, made the first time they are needed (from the member's level then).
    fn challenges(&self, user: &str, now: i64) -> (Vec<gb_data::fishing::ChallengeRow>, Vec<gb_data::fishing::ChallengeRow>) {
        let lv = self.level_of(user);
        let (d, w) = Self::periods(now);
        let seed = format!("{}:{user}", self.guild);
        let made = |p: &str| self.db.get().fish_challenges_made(self.guild, user, p).unwrap_or(false);
        if !made(&d) {
            for (slot, c) in CH::make_dailies(lv, &format!("{seed}:{}", CH::day_key(now))).iter().enumerate() {
                let _ = self.db.get().fish_challenge_put(self.guild, user, &d, slot as i64, &serde_json::to_string(c).unwrap_or_default());
            }
        }
        if !made(&w) {
            let c = CH::make_weekly(lv, &format!("{seed}:{}", CH::week_key(now)));
            let _ = self.db.get().fish_challenge_put(self.guild, user, &w, 0, &serde_json::to_string(&c).unwrap_or_default());
        }
        let rows = self.db.get().fish_challenges(self.guild, user, &[&d, &w]).unwrap_or_default();
        (rows.iter().filter(|r| r.period == d).cloned().collect(), rows.iter().filter(|r| r.period == w).cloned().collect())
    }
    fn spec(row: &gb_data::fishing::ChallengeRow) -> Option<CH::Challenge> {
        serde_json::from_str(&row.spec).ok()
    }
    /// Moves challenges along after a catch or a sale and pays any that finish. Returns lines for the player.
    fn progress_challenges(&self, user: &str, event: &CH::Event, now: i64) -> Vec<String> {
        let mut lines = Vec::new();
        if !self.on("fishChallenges") { return lines; }
        let (daily, weekly) = self.challenges(user, now);
        let fmt = |n: i64| self.coins(n);
        let mut daily_finished = false;
        let (dp, _) = Self::periods(now);
        for row in daily.iter().chain(weekly.iter()) {
            if row.done_at.is_some() { continue; }
            let Some(spec) = Self::spec(row) else { continue };
            let (progress, seen) = CH::advance(&spec, row.progress, &row.seen, event);
            if progress == row.progress && seen == row.seen { continue; }
            let done = progress >= spec.goal;
            let _ = self.db.get().fish_challenge_update(self.guild, user, &row.period, row.slot, progress, &seen, done.then_some(now));
            if !done { continue; }
            let reward = spec.reward;
            if reward.coins > 0 { self.credit(user, reward.coins, "fishing challenge"); }
            if reward.xp > 0 { let _ = self.db.get().fish_add_xp(self.guild, user, reward.xp); }
            let weekly_row = row.period.starts_with("w:");
            lines.push(format!("📜 **{} done:** {} · +{}{}", if weekly_row { "Weekly challenge" } else { "Challenge" }, CH::describe(&spec, &fmt), fmt(reward.coins), if reward.xp > 0 { format!(" · +{} XP", group(reward.xp)) } else { String::new() }));
            if row.period == dp { daily_finished = true; }
            if weekly_row {
                let _ = self.db.get().fish_weekly_done(self.guild, user);
                lines.extend(self.challenge_rods(user, now));
            }
        }
        if daily_finished && self.db.get().fish_challenges_open(self.guild, user, &dp).unwrap_or(1) == 0 {
            let p = self.profile(user);
            let streak = if p.streak_day.as_deref() == Some(CH::yesterday_key(now).as_str()) { p.streak + 1 } else { 1 };
            let bonus = CH::streak_bonus(F::level_from_xp(p.xp).level, streak);
            let _ = self.db.get().fish_set_streak(self.guild, user, streak, &CH::day_key(now));
            self.credit(user, bonus.coins, "fishing challenge streak");
            let _ = self.db.get().fish_bait_add(self.guild, user, bonus.bait, bonus.bait_qty);
            lines.push(format!("🔥 **All of today's challenges done!** Streak: {streak} day{} · +{} · +{} {}", if streak == 1 { "" } else { "s" }, fmt(bonus.coins), bonus.bait_qty, F::bait_by_id(bonus.bait).label));
            lines.extend(self.challenge_rods(user, now));
        }
        lines
    }
    fn challenges_text(&self, user: &str, now: i64) -> Card {
        let (daily, weekly) = self.challenges(user, now);
        let p = self.profile(user);
        let fmt = |n: i64| self.coins(n);
        let line = |r: &gb_data::fishing::ChallengeRow| {
            let Some(spec) = Self::spec(r) else { return String::new() };
            let (g, pr) = (spec.goal, r.progress.min(spec.goal));
            let shown = if spec.kind == "sell" { format!("{}/{}", group(pr), group(g)) } else { format!("{pr}/{g}") };
            format!("{} {}\n   {} {shown} · {}{}", if r.done_at.is_some() { "✅" } else { "▫️" }, CH::describe(&spec, &fmt), F::meter(pr as f64 / g as f64 * 100.0, 8), fmt(spec.reward.coins), if spec.reward.xp > 0 { format!(" + {} XP", group(spec.reward.xp)) } else { String::new() })
        };
        let streak = self.live_streak(&p, now);
        let done_today = daily.iter().filter(|r| r.done_at.is_some()).count();
        let bonus = CH::streak_bonus(F::level_from_xp(p.xp).level, if p.streak_day.as_deref() == Some(CH::day_key(now).as_str()) { streak } else { streak + 1 });
        let when = |ms: i64| format!("<t:{}:R>", ms / 1000);
        let card = Card::new(Area::Games).title("📜 Fishing challenges")
            .line(format!("Challenges count every fish you land (and fish you sell). Rewards are paid the moment you finish one.\n🔥 Streak: **{streak}** day{}{}", if streak == 1 { "" } else { "s" }, if done_today == 3 { " · all done today!".to_string() } else { format!(" · finish all 3 today for +{} and {} {}", fmt(bonus.coins), bonus.bait_qty, F::bait_by_id(bonus.bait).label) }))
            .line(format!("**Today · {done_today}/3 · new {}**\n{}", when(CH::next_day_at(now)), daily.iter().map(line).collect::<Vec<_>>().join("\n")))
            .line(format!("**This week · new {}**\n{}", when(CH::next_week_at(now)), weekly.iter().map(line).collect::<Vec<_>>().join("\n")))
            .button_with(format!("fh:{user}:cast"), "Cast", ButtonStyle::Good, Some("🎣".into()));
        self.button_row(card, user, "hub", "Back", "↩️").private()
    }

    // ------------------------------------------------------------------ bag, selling
    fn bag_text(&self, user: &str, note: Option<String>) -> Card {
        let rows = self.db.get().fish_bag_top(self.guild, user, 10).unwrap_or_default();
        let (n, v, cheap) = self.db.get().fish_bag_totals(self.guild, user).unwrap_or((0, 0, 0));
        let body = if rows.is_empty() { "*Empty. Go catch something!*".to_string() } else { rows.iter().map(|c| format!("{} · {}", bag_line(c), self.coins(c.value))).collect::<Vec<_>>().join("\n") };
        let mut card = Card::new(Area::Games).title("🎒 Your bag").line([note, Some(body)].into_iter().flatten().collect::<Vec<_>>().join("\n\n"))
            .line(format!("-# {} fish · worth {} in total{}", group(n), group(v), if n > 10 { " · showing the 10 most valuable" } else { "" }));
        let pick = self.db.get().fish_bag_top(self.guild, user, 25).unwrap_or_default();
        if !pick.is_empty() {
            card = card.select(Select { id: format!("fsel:{user}"), placeholder: "Choose fish to sell...".into(), min: 1, max: pick.len() as u8,
                options: pick.iter().map(|c| (short(&format!("{} · {} kg · {} coins", F::fish_by_id(&c.species).map(|f| f.name.as_str()).unwrap_or("Fish"), crate::fishchallenges::js_number(c.weight), group(c.value)), 100), c.id.to_string(), None)).collect() });
        }
        card = card.button_full(format!("fh:{user}:sellcommon"), format!("Sell all but rare finds ({})", group(cheap)), ButtonStyle::Good, Some("💰".into()), cheap == 0)
            .button_full(format!("fh:{user}:sellall"), format!("Sell everything ({})", group(v)), ButtonStyle::Danger, Some("💰".into()), v == 0);
        self.button_row(card, user, "hub", "Back", "↩️").private()
    }
    fn sell(&self, user: &str, what: Result<Vec<i64>, bool>, now: i64) -> (i64, i64, Vec<String>) {
        let (total, count) = match what {
            Ok(ids) => self.db.get().fish_bag_sell_ids(self.guild, user, &ids).unwrap_or((0, 0)),
            Err(all) => { let t = self.db.get().fish_bag_sell_all(self.guild, user, all).unwrap_or(0); (t, 0) }
        };
        let mut lines = Vec::new();
        if total > 0 {
            self.credit(user, total, "sold fish");
            lines = self.progress_challenges(user, &CH::Event::Sell(total), now);
        }
        (total, count, lines)
    }

    // ------------------------------------------------------------------ rods, shop, collection
    fn rods_text(&self, user: &str) -> Card {
        let p = self.profile(user);
        let mut owned: Vec<&F::RodDef> = F::RODS.iter().filter(|r| p.rods.iter().any(|x| x == r.id)).collect();
        owned.sort_by_key(|r| std::cmp::Reverse(F::rod_stats(r.id, 1, None).power));
        let line = |r: &&F::RodDef| format!("**{}** {}{}", r.label, stars(*p.stars.get(r.id).unwrap_or(&1)), F::perk(r.perk).map(|(e, l, _)| format!(" · {e} {l}")).unwrap_or_default());
        let to_earn: Vec<&F::RodDef> = F::RODS.iter().filter(|r| r.earn.is_some() && !p.rods.iter().any(|x| x == r.id)).collect();
        let keeps = to_earn.iter().filter(|r| matches!(r.earn, Some(Earn::Collection(_)))).count();
        let mut other: Vec<String> = to_earn.iter().filter(|r| !matches!(r.earn, Some(Earn::Collection(_)))).map(|r| format!("🔒 **{}** · {}", r.label, F::earn_text(r))).collect();
        if keeps > 0 { other.push(format!("🏅 **{keeps} Keepsake rods** · catch every fish in a place to earn its rod")); }
        let mut card = Card::new(Area::Games).title("🎣 Your rods").line(short(&owned.iter().map(line).collect::<Vec<_>>().join("\n"), 3000))
            .line(format!("**Rods to earn**\n{}", if other.is_empty() { "You have earned them all!".to_string() } else { short(&other.join("\n"), 1000) }))
            .line("-# Every rod has a perk and home places where it is stronger. Upgrade your favourites to ★5 with coins and fish.");
        if !owned.is_empty() {
            card = card.select(Select { id: format!("frod:{user}"), placeholder: "Look at a rod or upgrade it...".into(), min: 1, max: 1,
                options: owned.iter().take(25).map(|r| (short(&format!("{} · {} · {}", r.label, stars(*p.stars.get(r.id).unwrap_or(&1)), F::perk(r.perk).map(|x| x.1).unwrap_or("")), 100), r.id.to_string(), None)).collect() });
        }
        self.button_row(card, user, "hub", "Back", "↩️").private()
    }
    fn rod_card(&self, user: &str, rod: &str, note: Option<String>) -> Result<Card, String> {
        let p = self.profile(user);
        if !p.rods.iter().any(|r| r == rod) { return Err("You don't own that rod.".into()); }
        let r = F::rod_by_id(rod);
        let n = *p.stars.get(rod).unwrap_or(&1);
        let st = F::rod_stats(rod, n, None);
        let home_biome = r.home.first().copied().or(if r.perk == "mythic" || r.perk == "wanderer" { Some("bay") } else { None });
        let home = F::rod_stats(rod, n, home_biome);
        let cost = F::upgrade_cost(rod, n);
        let have = cost.map(|c| self.db.get().fish_bag_count_rarity(self.guild, user, c.1).unwrap_or(0)).unwrap_or(0);
        let coins = self.wallet(user);
        let pk = F::perk(r.perk).map(|(e, l, d)| format!("{e} **{l}:** {d}"));
        let mut card = Card::new(Area::Games).title(format!("🎣 {} {}", r.label, stars(n)))
            .line([note, pk, Some(format!("🏠 **Home:** {}", home_text(r))), Some(format!("-# {}", F::earn_text(r)))].into_iter().flatten().collect::<Vec<_>>().join("\n"))
            .line(format!("**Anywhere**\nLuck +{}% · zone {} · power {} · line {}", (st.luck * 100.0).round(), st.control, st.power, st.line));
        if home.home { card = card.line(format!("**At home**\nLuck +{}% · zone {} · power {} · line {}", (home.luck * 100.0).round(), home.control, home.power, home.line)); }
        match cost {
            Some((c, rarity, fish)) => card = card.line(format!("**Next: {}**\n{} (you have {})\n{fish} {} fish from your bag (you have {have}; mutated fish don't count)", stars(n + 1), self.coins(c), self.coins(coins), F::rarity_by_id(rarity).label)),
            None => card = card.line("**Fully upgraded**"),
        }
        if let Some((c, _, fish)) = cost { card = card.button_full(format!("fh:{user}:up-{rod}"), format!("Upgrade to ★{}", n + 1), ButtonStyle::Good, Some("⬆️".into()), coins < c || have < fish); }
        Ok(self.button_row(card, user, "rods", "All rods", "↩️").private())
    }
    fn upgrade_rod(&self, user: &str, rod: &str) -> Result<String, String> {
        let p = self.profile(user);
        if !p.rods.iter().any(|r| r == rod) { return Err("You don't own that rod.".into()); }
        let n = *p.stars.get(rod).unwrap_or(&1);
        let Some((coins, rarity, fish)) = F::upgrade_cost(rod, n) else { return Err("That rod is already at ★5.".into()) };
        let ids = self.db.get().fish_bag_cheapest(self.guild, user, rarity, fish).unwrap_or_default();
        if (ids.len() as i64) < fish { return Err(format!("You need {fish} {} fish in your bag (not mutated). You have {}.", F::rarity_by_id(rarity).label, ids.len())); }
        self.debit(user, coins, &format!("upgraded {}", F::rod_by_id(rod).label))?;
        let _ = self.db.get().fish_bag_mark_sold(&ids);
        let mut st = p.stars.clone();
        st.insert(rod.into(), n + 1);
        let _ = self.db.get().fish_set_stars(self.guild, user, &st);
        Ok(format!("⬆️ **Upgraded to {}!**", stars(n + 1)))
    }
    fn shop_text(&self, user: &str, note: Option<String>) -> Card {
        let p = self.profile(user);
        let lv = F::level_from_xp(p.xp).level;
        let stock = self.db.get().fish_bait_stock(self.guild, user).unwrap_or_default();
        let coins = self.wallet(user);
        let shop: Vec<&F::RodDef> = F::RODS.iter().filter(|r| r.earn.is_none()).collect();
        let owns = |id: &str| p.rods.iter().any(|r| r == id);
        let best = shop.iter().enumerate().filter(|(_, r)| owns(r.id)).map(|(k, _)| k).max().unwrap_or(0);
        let locked: Vec<&str> = shop.iter().filter(|r| r.level > lv).take(2).map(|r| r.id).collect();
        let rod_lines: Vec<String> = shop.iter().enumerate().filter(|(k, r)| r.price > 0 && (*k == best || (!owns(r.id) && r.level <= lv) || locked.contains(&r.id))).map(|(_, r)| r).collect::<Vec<_>>().into_iter().rev().take(8).rev()
            .map(|r| format!("{} **{}** · {} · level {}{}", if owns(r.id) { "✅" } else if r.level > lv { "🔒" } else { "▫️" }, r.label, group(r.price), r.level, F::perk(r.perk).map(|(e, l, _)| format!(" · {e} {l}")).unwrap_or_default())).collect();
        let tackle_lines: Vec<String> = F::tackles().iter().filter(|t| t.price > 0).map(|t| format!("{} **{}** · {} · {}", if p.tackle.iter().any(|x| x == t.id) { "✅" } else { "▫️" }, t.label, group(t.price), t.desc)).collect();
        let bait_lines: Vec<String> = F::baits().iter().filter(|b| b.price > 0).map(|b| format!("🪱 **{}** · {} each · luck +{}%{} · you have {}", b.label, group(b.price), (b.luck * 100.0).round(), if b.corruption > 0.0 { " · draws corruption" } else { "" }, stock.get(b.id).copied().unwrap_or(0))).collect();
        let mut options: Vec<(String, String, Option<String>)> = Vec::new();
        for r in shop.iter().filter(|r| r.price > 0 && !owns(r.id) && r.level <= lv) { options.push((format!("{} ({})", r.label, group(r.price)), format!("rod-{}", r.id), Some("🎣".into()))); }
        for t in F::tackles().iter().filter(|t| t.price > 0 && !p.tackle.iter().any(|x| x == t.id)) { options.push((format!("{} ({})", t.label, group(t.price)), format!("tackle-{}", t.id), Some("🧰".into()))); }
        for b in F::baits().iter().filter(|b| b.price > 0) { options.push((format!("{} ({} each)", b.label, group(b.price)), format!("bait-{}", b.id), Some("🪱".into()))); }
        let keep = options.len().saturating_sub(25);
        let options: Vec<_> = options.into_iter().skip(keep).collect();
        let mut card = Card::new(Area::Games).title("🛒 Tackle shop").line([note, Some(format!("You have {}", self.coins(coins)))].into_iter().flatten().collect::<Vec<_>>().join("\n"))
            .line(format!("**Rods**\n{}", rod_lines.join("\n"))).line(format!("**Tackle (kept forever)**\n{}", tackle_lines.join("\n"))).line(format!("**Bait (one per cast)**\n{}", bait_lines.join("\n")));
        if !options.is_empty() { card = card.select(Select { id: format!("fs:{user}"), placeholder: "Buy something...".into(), min: 1, max: 1, options }); }
        self.button_row(card, user, "hub", "Back", "↩️").private()
    }
    fn buy_item(&self, user: &str, value: &str, qty: i64) -> Result<String, String> {
        let (kind, id) = value.split_once('-').unwrap_or(("", ""));
        let p = self.profile(user);
        match kind {
            "rod" => {
                let r = F::RODS.iter().find(|x| x.id == id && x.price > 0 && x.earn.is_none()).ok_or("That rod is not for sale.")?;
                if p.rods.iter().any(|x| x == id) { return Err("You already own that rod.".into()); }
                if r.level > F::level_from_xp(p.xp).level { return Err(format!("That rod needs fishing level {}.", r.level)); }
                self.debit(user, r.price, &format!("bought {}", r.label))?;
                let mut rods = p.rods.clone();
                rods.push(id.into());
                let _ = self.db.get().fish_set_rods(self.guild, user, &rods, Some(id));
                Ok(r.label.into())
            }
            "tackle" => {
                let t = F::tackles().into_iter().find(|x| x.id == id && x.price > 0).ok_or("That tackle is not for sale.")?;
                if p.tackle.iter().any(|x| x == id) { return Err("You already own that.".into()); }
                self.debit(user, t.price, &format!("bought {}", t.label))?;
                let mut tk = p.tackle.clone();
                tk.push(id.into());
                let _ = self.db.get().fish_set_tackle(self.guild, user, &tk);
                Ok(t.label.into())
            }
            "bait" => {
                let b = F::baits().into_iter().find(|x| x.id == id && x.price > 0).ok_or("That bait is not for sale.")?;
                self.debit(user, b.price * qty, &format!("bought {qty} {}", b.label))?;
                let _ = self.db.get().fish_bait_add(self.guild, user, id, qty);
                Ok(format!("{qty} × {}", b.label))
            }
            _ => Err("That is not for sale.".into()),
        }
    }
    fn dex_text(&self, user: &str, view: Option<&str>) -> Card {
        let seen = self.db.get().fish_dex(self.guild, user).unwrap_or_default();
        let total = F::fish_list().len();
        let found = seen.keys().filter(|k| F::fish_by_id(k).is_some()).count();
        let lv = self.level_of(user);
        let (biome, page_raw) = view.unwrap_or("").split_once('.').unwrap_or((view.unwrap_or(""), ""));
        let place = F::biomes().into_iter().find(|b| b.id == biome);
        let mut card = Card::new(Area::Games);
        if let Some(pl) = place {
            let list = F::fish_in(pl.id);
            let have = list.iter().filter(|f| seen.contains_key(&f.id)).count();
            let pages = list.len().div_ceil(DEX_PAGE).max(1);
            let page = page_raw.parse::<i64>().unwrap_or(0).clamp(0, pages as i64 - 1) as usize;
            let lines: Vec<String> = list.iter().skip(page * DEX_PAGE).take(DEX_PAGE).map(|f| match seen.get(&f.id) {
                Some((count, best)) => format!("✅ **{}** · {} · best {} kg · caught {}", f.name, F::rarity_by_id(f.rarity).label, crate::fishchallenges::js_number(*best), group(*count)),
                None => format!("❔ {} fish ({})", F::rarity_by_id(f.rarity).label, f.id.rsplit('-').next().unwrap_or("")),
            }).collect();
            card = card.title(format!("📖 {} {} · {have}/{}", pl.emoji, pl.label, list.len())).line(if pl.level > lv { format!("🔒 Unlocks at fishing level {}.", group(pl.level)) } else { pl.blurb.to_string() }).line(lines.join("\n")).line(format!("-# Page {} of {pages}", page + 1))
                .button_full(format!("fh:{user}:dex-{}.{}", pl.id, page as i64 - 1), "", ButtonStyle::Plain, Some("◀️".into()), page == 0)
                .button_full(format!("fh:{user}:dex-{}.{}", pl.id, page + 1), "", ButtonStyle::Plain, Some("▶️".into()), page + 1 >= pages);
        } else {
            card = card.title(format!("📖 Collection · {}/{}", group(found as i64), group(total as i64))).line(format!("{} Catch every fish in every place. Pick a place below to see its fish.", F::meter(found as f64 / total as f64 * 100.0, 15)));
            let rows: Vec<String> = F::biomes().iter().map(|b| { let list = F::fish_in(b.id); let have = list.iter().filter(|f| seen.contains_key(&f.id)).count(); format!("{} **{}** · {}", b.emoji, b.label, if b.level > lv { format!("🔒 Level {}", group(b.level)) } else { format!("{} {have}/{}", if have == list.len() { "🏆".to_string() } else { F::meter(have as f64 / list.len() as f64 * 100.0, 6) }, list.len()) }) }).collect();
            card = card.line(rows.join("\n"));
        }
        card = card.select(Select { id: format!("fdx:{user}"), placeholder: "Pick a place...".into(), min: 1, max: 1,
            options: F::biomes().iter().map(|b| (short(&format!("{} · {}/{}", b.label, F::fish_in(b.id).iter().filter(|f| seen.contains_key(&f.id)).count(), F::fish_in(b.id).len()), 100), b.id.to_string(), Some(b.emoji.to_string()))).collect() });
        if place.is_some() { card = self.button_row(card, user, "dex", "All places", "📖"); }
        self.button_row(card, user, "hub", "Back", "↩️").private()
    }

    // ------------------------------------------------------------------ buttons and menus
    pub fn command(&self, who: &Member, now: i64) -> Vec<Action> {
        if !self.on("fishingEnabled") { return private("That game is turned off in this server."); }
        self.profile(&who.id);
        vec![Action::Reply { card: self.hub(&who.id, now) }]
    }
    pub fn press(&self, ev: &ButtonEvent, rng: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        let parts: Vec<&str> = ev.id.splitn(3, ':').collect();
        let (kind, a, b) = (parts.first().copied().unwrap_or(""), parts.get(1).copied().unwrap_or(""), parts.get(2).copied().unwrap_or(""));
        let now = ev.at_ms;
        if kind == "fr" { return self.reel_press(ev, a, b, rng); }
        // fh:<user>:<view>
        if let Some(no) = self.belongs(ev, a) { return no; }
        let user = a;
        let update = |c: Card| vec![Action::Update { card: c }];
        match b {
            "cast" => vec![self.cast_form(user)],
            "again" => {
                let p = self.profile(user);
                self.cast(&ev.member, (p.last_biome.as_deref().unwrap_or("bay"), p.last_rod.as_deref().unwrap_or("driftwood"), p.last_bait.as_deref().unwrap_or("none"), p.last_tackle.as_deref().unwrap_or("none")), now, rng, false)
            }
            "bag" => update(self.bag_card(user, None)),
            "shop" => update(self.shop_card(user, None)),
            "dex" => update(self.dex_card(user, None)),
            "quests" => update(self.challenges_card(user, now)),
            "rods" => update(self.rods_card(user)),
            "hub" => update(self.hub(user, now)),
            "sellall" | "sellcommon" => {
                let (total, _, lines) = self.sell(user, Err(b == "sellall"), now);
                update(self.bag_card(user, Some(if total > 0 { [format!("💰 Sold for {}.", self.coins(total))].into_iter().chain(lines).collect::<Vec<_>>().join("\n") } else { "Nothing to sell.".into() })))
            }
            v if v.starts_with("dex-") => update(self.dex_card(user, Some(&v[4..]))),
            v if v.starts_with("rod-") => match self.rod_card(user, &v[4..], None) { Ok(c) => update(c), Err(e) => private(e) },
            v if v.starts_with("up-") => {
                let rod = &v[3..];
                match self.upgrade_rod(user, rod) { Ok(note) => match self.rod_card(user, rod, Some(note)) { Ok(c) => update(c), Err(e) => private(e) }, Err(e) => private(e) }
            }
            _ => private("That button is no longer active."),
        }
    }
    /// A dropdown on one of the fishing screens.
    pub fn select(&self, ev: &ButtonEvent) -> Vec<Action> {
        let mut parts = ev.id.split(':');
        let (kind, owner) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        if owner != ev.member.id { return private("That menu belongs to someone else. Run `/fish` for your own."); }
        let user = owner;
        let first = ev.values.first().map(String::as_str).unwrap_or("");
        let now = ev.at_ms;
        match kind {
            "fsel" => {
                let ids: Vec<i64> = ev.values.iter().filter_map(|v| v.parse().ok()).filter(|n: &i64| *n > 0).take(25).collect();
                let (total, count, lines) = self.sell(user, Ok(ids), now);
                vec![Action::Update { card: self.bag_card(user, Some(if total > 0 { [format!("🪙 Sold {count} fish for {}.", self.coins(total))].into_iter().chain(lines).collect::<Vec<_>>().join("\n") } else { "Those fish were already sold.".into() })) }]
            }
            "frod" => match self.rod_card(user, first, None) { Ok(c) => vec![Action::Update { card: c }], Err(e) => private(e) },
            "fdx" => vec![Action::Update { card: self.dex_card(user, Some(first)) }],
            "fs" => {
                if let Some(bait) = first.strip_prefix("bait-") {
                    // the amount is typed, so: a popup
                    return vec![Action::Form { id: format!("fbait:{user}:{bait}"), title: short(&format!("Buy {}", F::bait_by_id(bait).label), 45), fields: vec![Field { id: "qty".into(), label: short(&format!("How many {}?", F::bait_by_id(bait).label), 45), required: true, max: 5, value: Some("10".into()), placeholder: Some(format!("{} coins each, up to 500", group(F::bait_by_id(bait).price))), ..Default::default() }] }];
                }
                match self.buy_item(user, first, 1) { Ok(label) => vec![Action::Update { card: self.shop_card(user, Some(format!("✅ Bought **{label}**."))) }], Err(e) => private(e) }
            }
            _ => private("That menu is no longer active."),
        }
    }
    /// Casts nobody finished are dropped after a while.
    pub fn due(&self, now: i64) {
        let old = self.db.get().game_sessions_old(self.guild, now - SESSION_MS).unwrap_or_default();
        for s in old.into_iter().filter(|s| s.kind == "fish") { let _ = self.db.get().game_session_drop(&s.id); }
        let _ = self.db.get().fish_challenges_prune(self.guild, &CH::day_key(now - 15 * 86_400_000));
    }
}
fn rarity_fish(r: &str) -> &'static str {
    match r { "common" => "🐟", "uncommon" => "🐠", "rare" => "🐡", "epic" => "🦈", "legendary" => "🐋", _ => "🐉" }
}
fn unlock_text(before: i64, after: i64) -> String {
    let unlocked: Vec<String> = F::biomes().iter().filter(|x| x.level > before && x.level <= after).map(|x| format!("{} **{}**", x.emoji, x.label)).collect();
    if unlocked.is_empty() { String::new() } else { format!(" New place unlocked: {}", unlocked.join(", ")) }
}
