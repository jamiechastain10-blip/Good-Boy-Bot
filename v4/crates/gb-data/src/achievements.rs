//! Good Boy 3's achievement tables: progress counters, unlocks, a server's own achievements, opt-outs and privacy.

use crate::{Result, Store};
use rusqlite::{params, OptionalExtension};

pub const MIGRATIONS: &[(i64, &str)] = &[(1, "
    CREATE TABLE IF NOT EXISTS achievements_progress (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, messages INTEGER NOT NULL DEFAULT 0, voice_seconds INTEGER NOT NULL DEFAULT 0,
      reactions INTEGER NOT NULL DEFAULT 0, active_days INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0, best_streak INTEGER NOT NULL DEFAULT 0, last_day TEXT,
      PRIMARY KEY (guild_id, user_id));
    CREATE TABLE IF NOT EXISTS achievements_unlock (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, achievement TEXT NOT NULL, at INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'auto',
      PRIMARY KEY (guild_id, user_id, achievement));
    CREATE TABLE IF NOT EXISTS achievements_custom (guild_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, emoji TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, id));
    CREATE TABLE IF NOT EXISTS achievements_optout (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (guild_id, user_id));
    CREATE TABLE IF NOT EXISTS achievements_privacy (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'public', PRIMARY KEY (guild_id, user_id));
")];

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Progress {
    pub messages: i64,
    pub voice_seconds: i64,
    pub reactions: i64,
    pub active_days: i64,
    pub streak: i64,
    pub best_streak: i64,
    pub last_day: Option<String>,
}
/// A server's own achievement: (id, name, description, emoji).
pub type Custom = (String, String, String, String);

impl Store {
    pub fn ach_progress(&self, guild: &str, user: &str) -> Result<Progress> {
        Ok(self.conn().query_row("SELECT messages, voice_seconds, reactions, active_days, streak, best_streak, last_day FROM achievements_progress WHERE guild_id = ? AND user_id = ?", [guild, user],
            |r| Ok(Progress { messages: r.get(0)?, voice_seconds: r.get(1)?, reactions: r.get(2)?, active_days: r.get(3)?, streak: r.get(4)?, best_streak: r.get(5)?, last_day: r.get(6)? })).optional()?.unwrap_or_default())
    }
    pub fn ach_save(&self, guild: &str, user: &str, p: &Progress) -> Result<()> {
        self.conn().execute("INSERT INTO achievements_progress (guild_id, user_id, messages, voice_seconds, reactions, active_days, streak, best_streak, last_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(guild_id, user_id) DO UPDATE SET messages = excluded.messages, voice_seconds = excluded.voice_seconds, reactions = excluded.reactions, active_days = excluded.active_days,
              streak = excluded.streak, best_streak = excluded.best_streak, last_day = excluded.last_day",
            params![guild, user, p.messages, p.voice_seconds, p.reactions, p.active_days, p.streak, p.best_streak, p.last_day])?;
        Ok(())
    }
    /// Unlocked achievements, oldest first: (id, when).
    pub fn ach_unlocked(&self, guild: &str, user: &str) -> Result<Vec<(String, i64)>> {
        let mut st = self.conn().prepare_cached("SELECT achievement, at FROM achievements_unlock WHERE guild_id = ? AND user_id = ? ORDER BY at")?;
        let rows = st.query_map([guild, user], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// True only the first time.
    pub fn ach_unlock(&self, guild: &str, user: &str, id: &str, source: &str, now: i64) -> Result<bool> {
        Ok(self.conn().execute("INSERT OR IGNORE INTO achievements_unlock (guild_id, user_id, achievement, at, source) VALUES (?, ?, ?, ?, ?)", params![guild, user, id, now, source])? > 0)
    }
    pub fn ach_revoke(&self, guild: &str, user: &str, id: &str) -> Result<bool> {
        Ok(self.conn().execute("DELETE FROM achievements_unlock WHERE guild_id = ? AND user_id = ? AND achievement = ?", [guild, user, id])? > 0)
    }
    pub fn ach_customs(&self, guild: &str) -> Result<Vec<Custom>> {
        let mut st = self.conn().prepare_cached("SELECT id, name, description, emoji FROM achievements_custom WHERE guild_id = ? ORDER BY created_at")?;
        let rows = st.query_map([guild], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn ach_custom_add(&self, guild: &str, c: &Custom, by: &str, now: i64) -> Result<()> {
        self.conn().execute("INSERT INTO achievements_custom (guild_id, id, name, description, emoji, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", params![guild, c.0, c.1, c.2, c.3, by, now])?;
        Ok(())
    }
    pub fn ach_custom_delete(&self, guild: &str, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM achievements_custom WHERE guild_id = ? AND id = ?", [guild, id])?;
        self.conn().execute("DELETE FROM achievements_unlock WHERE guild_id = ? AND achievement = ?", [guild, id])?;
        Ok(())
    }
    pub fn ach_opted_out(&self, guild: &str, user: &str) -> Result<bool> {
        Ok(self.conn().query_row("SELECT 1 FROM achievements_optout WHERE guild_id = ? AND user_id = ?", [guild, user], |_| Ok(())).optional()?.is_some())
    }
    pub fn ach_set_optout(&self, guild: &str, user: &str, out: bool) -> Result<()> {
        if out { self.conn().execute("INSERT OR IGNORE INTO achievements_optout (guild_id, user_id) VALUES (?, ?)", [guild, user])?; } else { self.conn().execute("DELETE FROM achievements_optout WHERE guild_id = ? AND user_id = ?", [guild, user])?; }
        Ok(())
    }
    pub fn ach_visibility(&self, guild: &str, user: &str) -> Result<String> {
        Ok(self.conn().query_row("SELECT visibility FROM achievements_privacy WHERE guild_id = ? AND user_id = ?", [guild, user], |r| r.get(0)).optional()?.unwrap_or_else(|| "public".into()))
    }
    pub fn ach_set_visibility(&self, guild: &str, user: &str, v: &str) -> Result<()> {
        self.conn().execute("INSERT INTO achievements_privacy (guild_id, user_id, visibility) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET visibility = excluded.visibility", [guild, user, v])?;
        Ok(())
    }
}
