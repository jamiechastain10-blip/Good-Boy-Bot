//! Fishing's tables, exactly as Good Boy 3 made them (module "games"), so a member's profile, rods, bait, bag,
//! collection and challenges carry over untouched. Casts and blackjack hands in progress live in `games_sessions`.

use crate::{Result, Store};
use rusqlite::{params, OptionalExtension};
use std::collections::BTreeMap;

pub const MIGRATIONS: &[(i64, &str)] = &[
    (1, "CREATE TABLE IF NOT EXISTS games_sessions (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS games_sessions_user ON games_sessions (guild_id, user_id, kind);
      CREATE TABLE IF NOT EXISTS games_jackpot (guild_id TEXT PRIMARY KEY, pool INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS games_stats (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, game TEXT NOT NULL, played INTEGER NOT NULL DEFAULT 0, won INTEGER NOT NULL DEFAULT 0,
        wagered INTEGER NOT NULL DEFAULT 0, returned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, user_id, game));
      CREATE TABLE IF NOT EXISTS games_fish_profile (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0, casts INTEGER NOT NULL DEFAULT 0, caught INTEGER NOT NULL DEFAULT 0,
        best_weight REAL NOT NULL DEFAULT 0, rods TEXT NOT NULL DEFAULT '[\"driftwood\"]', tackle TEXT NOT NULL DEFAULT '[]',
        last_biome TEXT, last_rod TEXT, last_bait TEXT, last_tackle TEXT, PRIMARY KEY (guild_id, user_id));
      CREATE TABLE IF NOT EXISTS games_fish_bait (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, bait TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, user_id, bait));
      CREATE TABLE IF NOT EXISTS games_fish_bag (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, species TEXT NOT NULL, rarity TEXT NOT NULL, mutation TEXT,
        giant INTEGER NOT NULL DEFAULT 0, weight REAL NOT NULL, value INTEGER NOT NULL, biome TEXT NOT NULL, caught_at INTEGER NOT NULL, sold INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS games_fish_bag_user ON games_fish_bag (guild_id, user_id, sold);
      CREATE TABLE IF NOT EXISTS games_fish_dex (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, species TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, best_weight REAL NOT NULL DEFAULT 0,
        first_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id, species));"),
    (2, "CREATE TABLE IF NOT EXISTS games_fish_challenges (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, period TEXT NOT NULL, slot INTEGER NOT NULL, spec TEXT NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0, seen TEXT NOT NULL DEFAULT '[]', done_at INTEGER, PRIMARY KEY (guild_id, user_id, period, slot));
      ALTER TABLE games_fish_profile ADD COLUMN streak INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE games_fish_profile ADD COLUMN streak_day TEXT;"),
    (3, "ALTER TABLE games_fish_profile ADD COLUMN rod_stars TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE games_fish_profile ADD COLUMN weeklies INTEGER NOT NULL DEFAULT 0;"),
];

#[derive(Debug, Clone, Default, PartialEq)]
pub struct FishProfile {
    pub xp: i64,
    pub casts: i64,
    pub caught: i64,
    pub best_weight: f64,
    pub rods: Vec<String>,
    pub tackle: Vec<String>,
    pub last_biome: Option<String>,
    pub last_rod: Option<String>,
    pub last_bait: Option<String>,
    pub last_tackle: Option<String>,
    pub streak: i64,
    pub streak_day: Option<String>,
    pub stars: BTreeMap<String, i64>,
    pub weeklies: i64,
}
#[derive(Debug, Clone, PartialEq)]
pub struct BagFish {
    pub id: i64,
    pub species: String,
    pub rarity: String,
    pub mutation: Option<String>,
    pub giant: bool,
    pub weight: f64,
    pub value: i64,
    pub biome: String,
}
#[derive(Debug, Clone, PartialEq)]
pub struct ChallengeRow {
    pub period: String,
    pub slot: i64,
    pub spec: String,
    pub progress: i64,
    pub seen: Vec<String>,
    pub done_at: Option<i64>,
}
pub struct Session {
    pub id: String,
    pub user: String,
    pub kind: String,
    pub state: String,
    pub updated: i64,
}

fn strings(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}
fn list(v: &[String]) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".into())
}
fn bag_row(r: &rusqlite::Row) -> rusqlite::Result<BagFish> {
    Ok(BagFish { id: r.get(0)?, species: r.get(1)?, rarity: r.get(2)?, mutation: r.get(3)?, giant: r.get::<_, i64>(4)? != 0, weight: r.get(5)?, value: r.get(6)?, biome: r.get(7)? })
}
const BAG_COLS: &str = "id, species, rarity, mutation, giant, weight, value, biome";

impl Store {
    // ---- profile
    pub fn fish_profile(&self, guild: &str, user: &str) -> Result<FishProfile> {
        self.conn.execute("INSERT OR IGNORE INTO games_fish_profile (guild_id, user_id) VALUES (?, ?)", params![guild, user])?;
        Ok(self.conn.query_row(
            "SELECT xp, casts, caught, best_weight, rods, tackle, last_biome, last_rod, last_bait, last_tackle, streak, streak_day, rod_stars, weeklies FROM games_fish_profile WHERE guild_id = ? AND user_id = ?",
            params![guild, user],
            |r| Ok(FishProfile {
                xp: r.get(0)?, casts: r.get(1)?, caught: r.get(2)?, best_weight: r.get(3)?, rods: strings(&r.get::<_, String>(4)?), tackle: strings(&r.get::<_, String>(5)?),
                last_biome: r.get(6)?, last_rod: r.get(7)?, last_bait: r.get(8)?, last_tackle: r.get(9)?, streak: r.get(10)?, streak_day: r.get(11)?,
                stars: serde_json::from_str(&r.get::<_, String>(12)?).unwrap_or_default(), weeklies: r.get(13)?,
            }),
        )?)
    }
    pub fn fish_cast_started(&self, guild: &str, user: &str, biome: &str, rod: &str, bait: &str, tackle: &str) -> Result<()> {
        self.conn.execute("UPDATE games_fish_profile SET casts = casts + 1, last_biome = ?, last_rod = ?, last_bait = ?, last_tackle = ? WHERE guild_id = ? AND user_id = ?", params![biome, rod, bait, tackle, guild, user])?;
        Ok(())
    }
    pub fn fish_add_xp(&self, guild: &str, user: &str, xp: i64) -> Result<()> {
        self.conn.execute("UPDATE games_fish_profile SET xp = xp + ? WHERE guild_id = ? AND user_id = ?", params![xp, guild, user])?;
        Ok(())
    }
    pub fn fish_landed(&self, guild: &str, user: &str, xp: i64, weight: f64) -> Result<()> {
        self.conn.execute("UPDATE games_fish_profile SET xp = xp + ?, caught = caught + 1, best_weight = MAX(best_weight, ?) WHERE guild_id = ? AND user_id = ?", params![xp, weight, guild, user])?;
        Ok(())
    }
    pub fn fish_set_rods(&self, guild: &str, user: &str, rods: &[String], last_rod: Option<&str>) -> Result<()> {
        self.conn.execute("UPDATE games_fish_profile SET rods = ?, last_rod = COALESCE(?, last_rod) WHERE guild_id = ? AND user_id = ?", params![list(rods), last_rod, guild, user])?;
        Ok(())
    }
    pub fn fish_set_tackle(&self, guild: &str, user: &str, tackle: &[String]) -> Result<()> {
        self.conn.execute("UPDATE games_fish_profile SET tackle = ? WHERE guild_id = ? AND user_id = ?", params![list(tackle), guild, user])?;
        Ok(())
    }
    pub fn fish_set_stars(&self, guild: &str, user: &str, stars: &BTreeMap<String, i64>) -> Result<()> {
        self.conn.execute("UPDATE games_fish_profile SET rod_stars = ? WHERE guild_id = ? AND user_id = ?", params![serde_json::to_string(stars).unwrap_or_else(|_| "{}".into()), guild, user])?;
        Ok(())
    }
    pub fn fish_set_streak(&self, guild: &str, user: &str, streak: i64, day: &str) -> Result<()> {
        self.conn.execute("UPDATE games_fish_profile SET streak = ?, streak_day = ? WHERE guild_id = ? AND user_id = ?", params![streak, day, guild, user])?;
        Ok(())
    }
    pub fn fish_weekly_done(&self, guild: &str, user: &str) -> Result<()> {
        self.conn.execute("UPDATE games_fish_profile SET weeklies = weeklies + 1 WHERE guild_id = ? AND user_id = ?", params![guild, user])?;
        Ok(())
    }

    // ---- bait
    pub fn fish_bait_stock(&self, guild: &str, user: &str) -> Result<BTreeMap<String, i64>> {
        let mut st = self.conn.prepare("SELECT bait, qty FROM games_fish_bait WHERE guild_id = ? AND user_id = ? AND qty > 0")?;
        let rows = st.query_map(params![guild, user], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// Uses one bait. False when there is none.
    pub fn fish_bait_use(&self, guild: &str, user: &str, bait: &str) -> Result<bool> {
        Ok(self.conn.execute("UPDATE games_fish_bait SET qty = qty - 1 WHERE guild_id = ? AND user_id = ? AND bait = ? AND qty > 0", params![guild, user, bait])? > 0)
    }
    pub fn fish_bait_add(&self, guild: &str, user: &str, bait: &str, qty: i64) -> Result<()> {
        self.conn.execute("INSERT INTO games_fish_bait (guild_id, user_id, bait, qty) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, user_id, bait) DO UPDATE SET qty = qty + excluded.qty", params![guild, user, bait, qty])?;
        Ok(())
    }

    // ---- bag and collection
    #[allow(clippy::too_many_arguments)]
    pub fn fish_bag_add(&self, guild: &str, user: &str, species: &str, rarity: &str, mutation: Option<&str>, giant: bool, weight: f64, value: i64, biome: &str, at: i64) -> Result<()> {
        self.conn.execute("INSERT INTO games_fish_bag (guild_id, user_id, species, rarity, mutation, giant, weight, value, biome, caught_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", params![guild, user, species, rarity, mutation, i64::from(giant), weight, value, biome, at])?;
        Ok(())
    }
    pub fn fish_bag_top(&self, guild: &str, user: &str, limit: usize) -> Result<Vec<BagFish>> {
        let mut st = self.conn.prepare(&format!("SELECT {BAG_COLS} FROM games_fish_bag WHERE guild_id = ? AND user_id = ? AND sold = 0 ORDER BY value DESC LIMIT ?"))?;
        let rows = st.query_map(params![guild, user, limit as i64], bag_row)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// (how many, what they are worth, what the ordinary ones are worth).
    pub fn fish_bag_totals(&self, guild: &str, user: &str) -> Result<(i64, i64, i64)> {
        Ok(self.conn.query_row("SELECT COUNT(*), COALESCE(SUM(value), 0), COALESCE(SUM(CASE WHEN rarity IN ('legendary', 'mythical') OR mutation IS NOT NULL THEN 0 ELSE value END), 0) FROM games_fish_bag WHERE guild_id = ? AND user_id = ? AND sold = 0", params![guild, user], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?)
    }
    /// Sells the chosen fish (skipping any already sold or someone else's). Gives (coins, how many).
    pub fn fish_bag_sell_ids(&self, guild: &str, user: &str, ids: &[i64]) -> Result<(i64, i64)> {
        let (mut total, mut count) = (0, 0);
        for id in ids {
            let v: Option<i64> = self.conn.query_row("SELECT value FROM games_fish_bag WHERE id = ? AND guild_id = ? AND user_id = ? AND sold = 0", params![id, guild, user], |r| r.get(0)).optional()?;
            if let Some(v) = v {
                self.conn.execute("UPDATE games_fish_bag SET sold = 1 WHERE id = ?", [id])?;
                total += v;
                count += 1;
            }
        }
        Ok((total, count))
    }
    /// Sells everything, or everything except rare finds (legendary, mythical, mutated).
    pub fn fish_bag_sell_all(&self, guild: &str, user: &str, all: bool) -> Result<i64> {
        let filter = if all { "" } else { "AND rarity NOT IN ('legendary', 'mythical') AND mutation IS NULL" };
        let total: i64 = self.conn.query_row(&format!("SELECT COALESCE(SUM(value), 0) FROM games_fish_bag WHERE guild_id = ? AND user_id = ? AND sold = 0 {filter}"), params![guild, user], |r| r.get(0))?;
        self.conn.execute(&format!("UPDATE games_fish_bag SET sold = 1 WHERE guild_id = ? AND user_id = ? AND sold = 0 {filter}"), params![guild, user])?;
        Ok(total)
    }
    /// How many unsold, not mutated fish of one rarity (for rod upgrades).
    pub fn fish_bag_count_rarity(&self, guild: &str, user: &str, rarity: &str) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM games_fish_bag WHERE guild_id = ? AND user_id = ? AND sold = 0 AND rarity = ? AND mutation IS NULL", params![guild, user, rarity], |r| r.get(0))?)
    }
    pub fn fish_bag_cheapest(&self, guild: &str, user: &str, rarity: &str, limit: i64) -> Result<Vec<i64>> {
        let mut st = self.conn.prepare("SELECT id FROM games_fish_bag WHERE guild_id = ? AND user_id = ? AND sold = 0 AND rarity = ? AND mutation IS NULL ORDER BY value ASC LIMIT ?")?;
        let rows = st.query_map(params![guild, user, rarity, limit], |r| r.get(0))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn fish_bag_mark_sold(&self, ids: &[i64]) -> Result<()> {
        for id in ids { self.conn.execute("UPDATE games_fish_bag SET sold = 1 WHERE id = ?", [id])?; }
        Ok(())
    }
    pub fn fish_dex(&self, guild: &str, user: &str) -> Result<BTreeMap<String, (i64, f64)>> {
        let mut st = self.conn.prepare("SELECT species, count, best_weight FROM games_fish_dex WHERE guild_id = ? AND user_id = ?")?;
        let rows = st.query_map(params![guild, user], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)?, r.get::<_, f64>(2)?))))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// Logs a catch in the collection. True when the fish is new to that member.
    pub fn fish_dex_add(&self, guild: &str, user: &str, species: &str, weight: f64, at: i64) -> Result<bool> {
        let seen: Option<i64> = self.conn.query_row("SELECT 1 FROM games_fish_dex WHERE guild_id = ? AND user_id = ? AND species = ?", params![guild, user, species], |r| r.get(0)).optional()?;
        self.conn.execute("INSERT INTO games_fish_dex (guild_id, user_id, species, count, best_weight, first_at) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(guild_id, user_id, species) DO UPDATE SET count = count + 1, best_weight = MAX(best_weight, excluded.best_weight)", params![guild, user, species, weight, at])?;
        Ok(seen.is_none())
    }

    // ---- challenges
    pub fn fish_challenges(&self, guild: &str, user: &str, periods: &[&str]) -> Result<Vec<ChallengeRow>> {
        let mut out = Vec::new();
        for p in periods {
            let mut st = self.conn.prepare("SELECT period, slot, spec, progress, seen, done_at FROM games_fish_challenges WHERE guild_id = ? AND user_id = ? AND period = ? ORDER BY slot")?;
            let rows = st.query_map(params![guild, user, p], |r| Ok(ChallengeRow { period: r.get(0)?, slot: r.get(1)?, spec: r.get(2)?, progress: r.get(3)?, seen: strings(&r.get::<_, String>(4)?), done_at: r.get(5)? }))?;
            for r in rows { out.push(r?); }
        }
        Ok(out)
    }
    pub fn fish_challenges_made(&self, guild: &str, user: &str, period: &str) -> Result<bool> {
        let n: i64 = self.conn.query_row("SELECT COUNT(*) FROM games_fish_challenges WHERE guild_id = ? AND user_id = ? AND period = ?", params![guild, user, period], |r| r.get(0))?;
        Ok(n > 0)
    }
    pub fn fish_challenge_put(&self, guild: &str, user: &str, period: &str, slot: i64, spec: &str) -> Result<()> {
        self.conn.execute("INSERT OR IGNORE INTO games_fish_challenges (guild_id, user_id, period, slot, spec) VALUES (?, ?, ?, ?, ?)", params![guild, user, period, slot, spec])?;
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    pub fn fish_challenge_update(&self, guild: &str, user: &str, period: &str, slot: i64, progress: i64, seen: &[String], done_at: Option<i64>) -> Result<()> {
        self.conn.execute("UPDATE games_fish_challenges SET progress = ?, seen = ?, done_at = ? WHERE guild_id = ? AND user_id = ? AND period = ? AND slot = ?", params![progress, list(seen), done_at, guild, user, period, slot])?;
        Ok(())
    }
    pub fn fish_challenges_open(&self, guild: &str, user: &str, period: &str) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM games_fish_challenges WHERE guild_id = ? AND user_id = ? AND period = ? AND done_at IS NULL", params![guild, user, period], |r| r.get(0))?)
    }
    /// Challenges older than a few weeks are no longer shown anywhere.
    pub fn fish_challenges_prune(&self, guild: &str, before_day: &str) -> Result<()> {
        self.conn.execute("DELETE FROM games_fish_challenges WHERE guild_id = ? AND substr(period, 3) < ?", params![guild, before_day])?;
        Ok(())
    }

    // ---- sessions (casts and blackjack hands)
    pub fn game_session_save(&self, guild: &str, id: &str, user: &str, kind: &str, state: &str, now: i64) -> Result<()> {
        self.conn.execute("INSERT INTO games_sessions (id, guild_id, user_id, kind, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at", params![id, guild, user, kind, state, now, now])?;
        Ok(())
    }
    pub fn game_session(&self, guild: &str, id: &str) -> Result<Option<Session>> {
        Ok(self.conn.query_row("SELECT id, user_id, kind, state, updated_at FROM games_sessions WHERE id = ? AND guild_id = ?", params![id, guild], |r| Ok(Session { id: r.get(0)?, user: r.get(1)?, kind: r.get(2)?, state: r.get(3)?, updated: r.get(4)? })).optional()?)
    }
    pub fn game_session_drop(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM games_sessions WHERE id = ?", [id])?;
        Ok(())
    }
    /// A session of this kind the member still has open (touched since `since`).
    pub fn game_session_active(&self, guild: &str, user: &str, kind: &str, since: i64) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT id FROM games_sessions WHERE guild_id = ? AND user_id = ? AND kind = ? AND updated_at > ?", params![guild, user, kind, since], |r| r.get(0)).optional()?)
    }
    pub fn game_sessions_old(&self, guild: &str, before: i64) -> Result<Vec<Session>> {
        let mut st = self.conn.prepare("SELECT id, user_id, kind, state, updated_at FROM games_sessions WHERE guild_id = ? AND updated_at < ?")?;
        let rows = st.query_map(params![guild, before], |r| Ok(Session { id: r.get(0)?, user: r.get(1)?, kind: r.get(2)?, state: r.get(3)?, updated: r.get(4)? }))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
}
