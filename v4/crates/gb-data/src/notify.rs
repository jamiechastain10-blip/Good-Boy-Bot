//! Good Boy 3's notification choices: a member's own, or the server's default (member "*").

use crate::{Result, Store};
use rusqlite::{params, OptionalExtension};

impl Store {
    pub fn notify_pref(&self, guild: &str, user: &str, category: &str) -> Result<Option<bool>> {
        Ok(self.conn().query_row("SELECT enabled FROM notification_prefs WHERE guild_id = ? AND user_id = ? AND category = ?", [guild, user, category], |r| r.get::<_, i64>(0)).optional()?.map(|v| v != 0))
    }
    pub fn set_notify_pref(&self, guild: &str, user: &str, category: &str, on: bool, now: i64) -> Result<()> {
        self.conn().execute("INSERT INTO notification_prefs (guild_id, user_id, category, enabled, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(guild_id, user_id, category) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at", params![guild, user, category, on as i64, now])?;
        Ok(())
    }
}
