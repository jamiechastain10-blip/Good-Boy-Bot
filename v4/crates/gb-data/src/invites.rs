//! Good Boy 3's invite tracking table: who invited each member, and whether they are still here.

use crate::{Result, Store};
use rusqlite::{params, OptionalExtension};

pub const MIGRATIONS: &[(i64, &str)] = &[(1, "
    CREATE TABLE IF NOT EXISTS invites_joins (guild_id TEXT NOT NULL, member_id TEXT NOT NULL, inviter_id TEXT, code TEXT, joined_at INTEGER NOT NULL, left_at INTEGER, new_account INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, member_id));
    CREATE INDEX IF NOT EXISTS invites_joins_inviter ON invites_joins (guild_id, inviter_id);
")];

/// An inviter's numbers: everyone they brought in, still here, left, brand-new accounts.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct InviteStats {
    pub joined: i64,
    pub here: i64,
    pub left: i64,
    pub fresh: i64,
}

impl Store {
    pub fn invite_join(&self, guild: &str, member: &str, inviter: Option<&str>, code: Option<&str>, at: i64, new_account: bool) -> Result<()> {
        self.conn().execute("INSERT OR REPLACE INTO invites_joins (guild_id, member_id, inviter_id, code, joined_at, left_at, new_account) VALUES (?, ?, ?, ?, ?, NULL, ?)", params![guild, member, inviter, code, at, new_account as i64])?;
        Ok(())
    }
    pub fn invite_left(&self, guild: &str, member: &str, at: i64) -> Result<()> {
        self.conn().execute("UPDATE invites_joins SET left_at = ? WHERE guild_id = ? AND member_id = ? AND left_at IS NULL", params![at, guild, member])?;
        Ok(())
    }
    pub fn invite_stats(&self, guild: &str, inviter: &str) -> Result<InviteStats> {
        Ok(self.conn().query_row("SELECT COUNT(*), COALESCE(SUM(CASE WHEN left_at IS NULL THEN 1 ELSE 0 END), 0), COALESCE(SUM(CASE WHEN left_at IS NOT NULL THEN 1 ELSE 0 END), 0), COALESCE(SUM(new_account), 0) FROM invites_joins WHERE guild_id = ? AND inviter_id = ?", [guild, inviter], |r| Ok(InviteStats { joined: r.get(0)?, here: r.get(1)?, left: r.get(2)?, fresh: r.get(3)? }))?)
    }
    /// Who invited a member, and with which code.
    pub fn invited_by(&self, guild: &str, member: &str) -> Result<Option<(Option<String>, Option<String>)>> {
        Ok(self.conn().query_row("SELECT inviter_id, code FROM invites_joins WHERE guild_id = ? AND member_id = ?", [guild, member], |r| Ok((r.get(0)?, r.get(1)?))).optional()?)
    }
    /// The top inviters: (member, still here, joined).
    pub fn top_inviters(&self, guild: &str, limit: i64) -> Result<Vec<(String, i64, i64)>> {
        let mut st = self.conn().prepare_cached("SELECT inviter_id, SUM(CASE WHEN left_at IS NULL THEN 1 ELSE 0 END) AS here, COUNT(*) AS joined FROM invites_joins WHERE guild_id = ? AND inviter_id IS NOT NULL GROUP BY inviter_id ORDER BY here DESC, joined DESC LIMIT ?")?;
        let rows = st.query_map(params![guild, limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
}
