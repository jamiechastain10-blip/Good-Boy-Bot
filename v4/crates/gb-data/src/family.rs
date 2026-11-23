//! Good Boy 3's family tables: married pairs (stored smaller id first) and who adopted whom.

use crate::{Result, Store};
use rusqlite::{params, OptionalExtension};

pub const MIGRATIONS: &[(i64, &str)] = &[(1, "
    CREATE TABLE IF NOT EXISTS family_partners (guild_id TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (guild_id, a, b));
    CREATE TABLE IF NOT EXISTS family_children (guild_id TEXT NOT NULL, child TEXT NOT NULL, parent TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (guild_id, child));
    CREATE INDEX IF NOT EXISTS family_children_parent ON family_children (guild_id, parent);
")];

/// (one, other) pairs: married couples, or parent and child.
pub type Pairs = Vec<(String, String)>;

fn pair<'a>(x: &'a str, y: &'a str) -> (&'a str, &'a str) {
    if x < y { (x, y) } else { (y, x) }
}
impl Store {
    /// Every married pair and every (parent, child) in a server.
    pub fn family_all(&self, guild: &str) -> Result<(Pairs, Pairs)> {
        let mut st = self.conn().prepare_cached("SELECT a, b FROM family_partners WHERE guild_id = ?")?;
        let partners = st.query_map([guild], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<Vec<_>, _>>()?;
        let mut st = self.conn().prepare_cached("SELECT parent, child FROM family_children WHERE guild_id = ?")?;
        let kids = st.query_map([guild], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok((partners, kids))
    }
    /// A member's partners and since when.
    pub fn family_partners_of(&self, guild: &str, user: &str) -> Result<Vec<(String, i64)>> {
        let mut st = self.conn().prepare_cached("SELECT a, b, since FROM family_partners WHERE guild_id = ? AND (a = ? OR b = ?) ORDER BY since")?;
        let rows = st.query_map([guild, user, user], |r| { let (a, b): (String, String) = (r.get(0)?, r.get(1)?); Ok((if a == user { b } else { a }, r.get(2)?)) })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn family_parent_of(&self, guild: &str, child: &str) -> Result<Option<(String, i64)>> {
        Ok(self.conn().query_row("SELECT parent, since FROM family_children WHERE guild_id = ? AND child = ?", [guild, child], |r| Ok((r.get(0)?, r.get(1)?))).optional()?)
    }
    pub fn family_marry(&self, guild: &str, x: &str, y: &str, now: i64) -> Result<()> {
        let (a, b) = pair(x, y);
        self.conn().execute("INSERT OR IGNORE INTO family_partners (guild_id, a, b, since) VALUES (?, ?, ?, ?)", params![guild, a, b, now])?;
        Ok(())
    }
    pub fn family_divorce(&self, guild: &str, x: &str, y: &str) -> Result<bool> {
        let (a, b) = pair(x, y);
        Ok(self.conn().execute("DELETE FROM family_partners WHERE guild_id = ? AND a = ? AND b = ?", [guild, a, b])? > 0)
    }
    pub fn family_adopt(&self, guild: &str, parent: &str, child: &str, now: i64) -> Result<()> {
        self.conn().execute("INSERT OR IGNORE INTO family_children (guild_id, child, parent, since) VALUES (?, ?, ?, ?)", params![guild, child, parent, now])?;
        Ok(())
    }
    pub fn family_unchild(&self, guild: &str, parent: &str, child: &str) -> Result<bool> {
        Ok(self.conn().execute("DELETE FROM family_children WHERE guild_id = ? AND child = ? AND parent = ?", [guild, child, parent])? > 0)
    }
}
