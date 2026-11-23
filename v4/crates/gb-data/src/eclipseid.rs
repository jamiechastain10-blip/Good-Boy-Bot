//! Good Boy 3's Eclipse ID tables: one ID number per person everywhere, a profile per server, linked game names.

use crate::{Result, Store};
use rusqlite::{params, OptionalExtension};

pub const MIGRATIONS: &[(i64, &str)] = &[(1, "
    CREATE TABLE IF NOT EXISTS eclipseid_ids (eid INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS eclipseid_profile (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', games TEXT NOT NULL DEFAULT '', platforms TEXT NOT NULL DEFAULT '',
      availability TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', vis TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
    CREATE TABLE IF NOT EXISTS eclipseid_link (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, platform TEXT NOT NULL, value TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'private', added_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id, platform));
")];

/// A profile: bio, games, platforms, availability, region, who may see each (JSON).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Profile {
    pub bio: String,
    pub games: String,
    pub platforms: String,
    pub availability: String,
    pub region: String,
    pub vis: String,
}

impl Store {
    /// A person's Eclipse ID number, made the first time it is needed.
    pub fn eid(&self, user: &str, now: i64) -> Result<i64> {
        self.conn().execute("INSERT OR IGNORE INTO eclipseid_ids (user_id, created_at) VALUES (?, ?)", params![user, now])?;
        Ok(self.conn().query_row("SELECT eid FROM eclipseid_ids WHERE user_id = ?", [user], |r| r.get(0))?)
    }
    pub fn eid_profile(&self, guild: &str, user: &str) -> Result<Option<Profile>> {
        Ok(self.conn().query_row("SELECT bio, games, platforms, availability, region, vis FROM eclipseid_profile WHERE guild_id = ? AND user_id = ?", [guild, user], |r| Ok(Profile { bio: r.get(0)?, games: r.get(1)?, platforms: r.get(2)?, availability: r.get(3)?, region: r.get(4)?, vis: r.get(5)? })).optional()?)
    }
    pub fn eid_save(&self, guild: &str, user: &str, p: &Profile, now: i64) -> Result<()> {
        self.conn().execute("INSERT INTO eclipseid_profile (guild_id, user_id, bio, games, platforms, availability, region, vis, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(guild_id, user_id) DO UPDATE SET bio = excluded.bio, games = excluded.games, platforms = excluded.platforms, availability = excluded.availability, region = excluded.region, vis = excluded.vis, updated_at = excluded.updated_at",
            params![guild, user, p.bio, p.games, p.platforms, p.availability, p.region, p.vis, now])?;
        Ok(())
    }
    /// Linked names: (platform, name, who may see it).
    pub fn eid_links(&self, guild: &str, user: &str) -> Result<Vec<(String, String, String)>> {
        let mut st = self.conn().prepare_cached("SELECT platform, value, visibility FROM eclipseid_link WHERE guild_id = ? AND user_id = ? ORDER BY platform")?;
        let rows = st.query_map([guild, user], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn eid_link(&self, guild: &str, user: &str, platform: &str, value: &str, vis: &str, now: i64) -> Result<()> {
        self.conn().execute("INSERT INTO eclipseid_link (guild_id, user_id, platform, value, visibility, added_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(guild_id, user_id, platform) DO UPDATE SET value = excluded.value, visibility = excluded.visibility, added_at = excluded.added_at", params![guild, user, platform, value, vis, now])?;
        Ok(())
    }
    pub fn eid_unlink(&self, guild: &str, user: &str, platform: &str) -> Result<bool> {
        Ok(self.conn().execute("DELETE FROM eclipseid_link WHERE guild_id = ? AND user_id = ? AND platform = ?", [guild, user, platform])? > 0)
    }
    /// Who may see linked names: one platform, or all of them.
    pub fn eid_link_vis(&self, guild: &str, user: &str, platform: Option<&str>, vis: &str) -> Result<()> {
        match platform {
            Some(p) => self.conn().execute("UPDATE eclipseid_link SET visibility = ? WHERE guild_id = ? AND user_id = ? AND platform = ?", [vis, guild, user, p])?,
            None => self.conn().execute("UPDATE eclipseid_link SET visibility = ? WHERE guild_id = ? AND user_id = ?", [vis, guild, user])?,
        };
        Ok(())
    }
    pub fn eid_delete(&self, guild: &str, user: &str) -> Result<()> {
        self.conn().execute("DELETE FROM eclipseid_profile WHERE guild_id = ? AND user_id = ?", [guild, user])?;
        self.conn().execute("DELETE FROM eclipseid_link WHERE guild_id = ? AND user_id = ?", [guild, user])?;
        Ok(())
    }
}
