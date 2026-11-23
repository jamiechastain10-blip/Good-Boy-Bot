//! Good Boy 3's clips table: each clip message, who shared it, its link and title, votes, and whether it was reposted.

use crate::{Result, Store};
use rusqlite::{params, OptionalExtension};

pub const MIGRATIONS: &[(i64, &str)] = &[(1, "
    CREATE TABLE IF NOT EXISTS clips_list (guild_id TEXT NOT NULL, message_id TEXT NOT NULL, channel_id TEXT NOT NULL, user_id TEXT NOT NULL, url TEXT, title TEXT,
      via TEXT NOT NULL, at INTEGER NOT NULL, votes INTEGER NOT NULL DEFAULT 0, best_message_id TEXT, weekly_win INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, message_id));
    CREATE INDEX IF NOT EXISTS clips_list_user ON clips_list (guild_id, user_id, at);
")];

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Clip {
    pub message: String,
    pub channel: String,
    pub user: String,
    pub url: Option<String>,
    pub title: Option<String>,
    pub via: String,
    pub at: i64,
    pub votes: i64,
    pub best: Option<String>,
}
const COLS: &str = "message_id, channel_id, user_id, url, title, via, at, votes, best_message_id";
fn row(r: &rusqlite::Row) -> rusqlite::Result<Clip> {
    Ok(Clip { message: r.get(0)?, channel: r.get(1)?, user: r.get(2)?, url: r.get(3)?, title: r.get(4)?, via: r.get(5)?, at: r.get(6)?, votes: r.get(7)?, best: r.get(8)? })
}

impl Store {
    pub fn clip_add(&self, guild: &str, c: &Clip) -> Result<bool> {
        Ok(self.conn().execute("INSERT OR IGNORE INTO clips_list (guild_id, message_id, channel_id, user_id, url, title, via, at, votes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)",
            params![guild, c.message, c.channel, c.user, c.url, c.title, c.via, c.at])? > 0)
    }
    pub fn clip(&self, guild: &str, message: &str) -> Result<Option<Clip>> {
        Ok(self.conn().query_row(&format!("SELECT {COLS} FROM clips_list WHERE guild_id = ? AND message_id = ?"), [guild, message], row).optional()?)
    }
    /// Clips a member shared since then.
    pub fn clips_since(&self, guild: &str, user: &str, since: i64) -> Result<i64> {
        Ok(self.conn().query_row("SELECT COUNT(*) FROM clips_list WHERE guild_id = ? AND user_id = ? AND at >= ?", params![guild, user, since], |r| r.get(0))?)
    }
    /// A title found later (Discord looks a link up a moment after it is posted); a Medal post's link too.
    pub fn clip_title(&self, guild: &str, message: &str, title: &str, url: Option<&str>) -> Result<()> {
        self.conn().execute("UPDATE clips_list SET title = ? WHERE guild_id = ? AND message_id = ? AND title IS NULL", params![title, guild, message])?;
        if let Some(u) = url { self.conn().execute("UPDATE clips_list SET url = ? WHERE guild_id = ? AND message_id = ? AND url IS NULL", params![u, guild, message])?; }
        Ok(())
    }
    pub fn clip_votes(&self, guild: &str, message: &str, votes: i64) -> Result<()> {
        self.conn().execute("UPDATE clips_list SET votes = ? WHERE guild_id = ? AND message_id = ?", params![votes, guild, message])?;
        Ok(())
    }
    pub fn clip_best(&self, guild: &str, message: &str, best: &str) -> Result<()> {
        self.conn().execute("UPDATE clips_list SET best_message_id = ? WHERE guild_id = ? AND message_id = ?", [best, guild, message])?;
        Ok(())
    }
    /// The most-voted clips since then (most votes first, newest first on a tie).
    pub fn clips_top(&self, guild: &str, since: i64, limit: i64) -> Result<Vec<Clip>> {
        let mut st = self.conn().prepare_cached(&format!("SELECT {COLS} FROM clips_list WHERE guild_id = ? AND at >= ? AND votes > 0 ORDER BY votes DESC, at DESC LIMIT ?"))?;
        let rows = st.query_map(params![guild, since, limit], row)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// The week's winner (most votes, earliest on a tie), marked as the clip of the week.
    pub fn clip_of_week(&self, guild: &str, from: i64, to: i64) -> Result<Option<Clip>> {
        let top = self.conn().query_row(&format!("SELECT {COLS} FROM clips_list WHERE guild_id = ? AND at >= ? AND at < ? AND votes > 0 ORDER BY votes DESC, at ASC LIMIT 1"), params![guild, from, to], row).optional()?;
        if let Some(t) = &top { self.conn().execute("UPDATE clips_list SET weekly_win = 1 WHERE guild_id = ? AND message_id = ?", [guild, &t.message])?; }
        Ok(top)
    }
}
