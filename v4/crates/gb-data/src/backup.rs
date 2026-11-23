//! Good Boy 3's server backups table (`backup_snapshots`): the layout as JSON, the last 10 per server.

use crate::{Result, Store};
use rusqlite::{params, OptionalExtension};

pub const MIGRATIONS: &[(i64, &str)] = &[(1, "CREATE TABLE IF NOT EXISTS backup_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, created_at INTEGER NOT NULL, by TEXT, data TEXT NOT NULL,
    roles INTEGER NOT NULL DEFAULT 0, channels INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS backup_snapshots_guild ON backup_snapshots (guild_id, id);")];
pub const KEEP: i64 = 10;

/// One saved backup: (id, when, who, roles, channels).
pub type BackupRow = (i64, i64, Option<String>, i64, i64);

impl Store {
    /// Saves a backup and keeps only the newest ten. Gives its number.
    pub fn backup_save(&self, guild: &str, at: i64, by: &str, data: &str, roles: i64, channels: i64) -> Result<i64> {
        self.batch(|s| {
            s.conn().execute("INSERT INTO backup_snapshots (guild_id, created_at, by, data, roles, channels, size) VALUES (?, ?, ?, ?, ?, ?, ?)", params![guild, at, by, data, roles, channels, data.len() as i64])?;
            let id = s.conn().last_insert_rowid();
            s.conn().execute("DELETE FROM backup_snapshots WHERE guild_id = ?1 AND id NOT IN (SELECT id FROM backup_snapshots WHERE guild_id = ?1 ORDER BY id DESC LIMIT ?2)", params![guild, KEEP])?;
            Ok(id)
        })
    }
    pub fn backups(&self, guild: &str) -> Result<Vec<BackupRow>> {
        let mut st = self.conn().prepare_cached("SELECT id, created_at, by, roles, channels FROM backup_snapshots WHERE guild_id = ? ORDER BY id DESC")?;
        let rows = st.query_map([guild], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// A backup: (when, its layout as JSON).
    pub fn backup(&self, guild: &str, id: i64) -> Result<Option<(i64, String)>> {
        Ok(self.conn().query_row("SELECT created_at, data FROM backup_snapshots WHERE guild_id = ? AND id = ?", params![guild, id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?)
    }
    /// When the last automatic backup was made (0 for never).
    pub fn last_auto_backup(&self, guild: &str) -> Result<i64> {
        Ok(self.conn().query_row("SELECT COALESCE(MAX(created_at), 0) FROM backup_snapshots WHERE guild_id = ? AND by = 'auto'", [guild], |r| r.get(0))?)
    }
}
