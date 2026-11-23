//! Giveaways: the same two tables Good Boy 3's giveaways module keeps.

use crate::{Result, Store};
use rusqlite::{params, OptionalExtension};

/// The giveaways module's tables, exactly as Good Boy 3 creates them.
pub const MIGRATIONS: &[(i64, &str)] = &[(1, "
    CREATE TABLE IF NOT EXISTS giveaways_list (guild_id TEXT NOT NULL, id INTEGER NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, host_id TEXT NOT NULL, prize TEXT NOT NULL,
      winner_count INTEGER NOT NULL, role_id TEXT, created_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, ended_at INTEGER, winners TEXT, PRIMARY KEY (guild_id, id));
    CREATE TABLE IF NOT EXISTS giveaways_entries (guild_id TEXT NOT NULL, giveaway_id INTEGER NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (guild_id, giveaway_id, user_id));
")];

#[derive(Debug, Clone, PartialEq)]
pub struct Giveaway {
    pub guild: String,
    pub id: i64,
    pub channel: String,
    pub message: Option<String>,
    pub host: String,
    pub prize: String,
    pub winner_count: i64,
    pub role: Option<String>,
    pub ends_at: i64,
    pub ended_at: Option<i64>,
    pub winners: Vec<String>,
}
const COLUMNS: &str = "guild_id, id, channel_id, message_id, host_id, prize, winner_count, role_id, ends_at, ended_at, winners";
fn read(r: &rusqlite::Row) -> rusqlite::Result<Giveaway> {
    let winners: Option<String> = r.get(10)?;
    Ok(Giveaway { guild: r.get(0)?, id: r.get(1)?, channel: r.get(2)?, message: r.get(3)?, host: r.get(4)?, prize: r.get(5)?, winner_count: r.get(6)?, role: r.get(7)?, ends_at: r.get(8)?, ended_at: r.get(9)?, winners: winners.and_then(|w| serde_json::from_str(&w).ok()).unwrap_or_default() })
}

impl Store {
    #[allow(clippy::too_many_arguments)]
    pub fn giveaway_start(&self, guild: &str, channel: &str, host: &str, prize: &str, winner_count: i64, role: Option<&str>, now: i64, ends_at: i64) -> Result<Giveaway> {
        self.batch(|s| {
            let id: i64 = s.conn().query_row("SELECT COALESCE(MAX(id), 0) + 1 FROM giveaways_list WHERE guild_id = ?", [guild], |r| r.get(0))?;
            s.conn().execute(
                "INSERT INTO giveaways_list (guild_id, id, channel_id, message_id, host_id, prize, winner_count, role_id, created_at, ends_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)",
                params![guild, id, channel, host, prize, winner_count, role, now, ends_at],
            )?;
            Ok(s.giveaway(guild, id)?.expect("just made"))
        })
    }
    pub fn giveaway(&self, guild: &str, id: i64) -> Result<Option<Giveaway>> {
        Ok(self.conn().query_row(&format!("SELECT {COLUMNS} FROM giveaways_list WHERE guild_id = ? AND id = ?"), params![guild, id], read).optional()?)
    }
    /// The newest giveaways in a server.
    pub fn giveaways(&self, guild: &str, limit: usize) -> Result<Vec<Giveaway>> {
        let mut st = self.conn().prepare(&format!("SELECT {COLUMNS} FROM giveaways_list WHERE guild_id = ? ORDER BY id DESC LIMIT ?"))?;
        let rows = st.query_map(params![guild, limit as i64], read)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// Giveaways whose time is up and that have not been drawn yet, in every server.
    pub fn giveaways_due(&self, now: i64) -> Result<Vec<Giveaway>> {
        let mut st = self.conn().prepare(&format!("SELECT {COLUMNS} FROM giveaways_list WHERE ended_at IS NULL AND ends_at <= ? ORDER BY guild_id, id"))?;
        let rows = st.query_map([now], read)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn giveaway_posted(&self, guild: &str, id: i64, message: &str) -> Result<()> {
        self.conn().execute("UPDATE giveaways_list SET message_id = ? WHERE guild_id = ? AND id = ?", params![message, guild, id])?;
        Ok(())
    }
    /// Enters a member, or takes them out when they were already in. True when they are now in.
    pub fn giveaway_toggle(&self, guild: &str, id: i64, user: &str, now: i64) -> Result<bool> {
        let gone = self.conn().execute("DELETE FROM giveaways_entries WHERE guild_id = ? AND giveaway_id = ? AND user_id = ?", params![guild, id, user])?;
        if gone > 0 {
            return Ok(false);
        }
        self.conn().execute("INSERT INTO giveaways_entries (guild_id, giveaway_id, user_id, at) VALUES (?, ?, ?, ?)", params![guild, id, user, now])?;
        Ok(true)
    }
    /// Everyone who entered, in the order they entered.
    pub fn giveaway_entries(&self, guild: &str, id: i64) -> Result<Vec<String>> {
        let mut st = self.conn().prepare("SELECT user_id FROM giveaways_entries WHERE guild_id = ? AND giveaway_id = ? ORDER BY at, user_id")?;
        let rows = st.query_map(params![guild, id], |r| r.get(0))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// Records the winners. The first time, it also records when the giveaway ended.
    pub fn giveaway_finish(&self, guild: &str, id: i64, winners: &[String], now: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE giveaways_list SET ended_at = COALESCE(ended_at, ?), winners = ? WHERE guild_id = ? AND id = ?",
            params![now, serde_json::to_string(winners).unwrap_or_else(|_| "[]".into()), guild, id],
        )?;
        Ok(())
    }
}
