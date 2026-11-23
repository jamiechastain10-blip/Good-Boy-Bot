//! The copies of recent messages the moderation module keeps, so a deleted or edited message can still be shown
//! in the log. The same table Good Boy 3 uses: kept for a week, at most 50,000 per server.

use crate::{Result, Store};
use rusqlite::{params, OptionalExtension};

pub const MIGRATIONS: &[(i64, &str)] = &[(1, "CREATE TABLE moderation_message_cache (guild_id TEXT NOT NULL, message_id TEXT NOT NULL, channel_id TEXT NOT NULL, author_id TEXT, content TEXT NOT NULL DEFAULT '',
            attachments TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, message_id));
          CREATE INDEX moderation_message_cache_age ON moderation_message_cache (guild_id, created_at);")];
const KEEP_MS: i64 = 7 * 86_400_000;
const MAX_PER_GUILD: i64 = 50_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Kept {
    pub channel: String,
    pub author: Option<String>,
    pub content: String,
    /// The files, as Good Boy 3 keeps them: [{ name, url, size }].
    pub attachments: String,
    pub at: i64,
}

impl Store {
    #[allow(clippy::too_many_arguments)]
    pub fn keep_message(&self, guild: &str, id: &str, channel: &str, author: &str, content: &str, attachments: &str, at: i64) -> Result<()> {
        let content: String = content.chars().take(4000).collect();
        self.conn().execute(
            "INSERT OR REPLACE INTO moderation_message_cache (guild_id, message_id, channel_id, author_id, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![guild, id, channel, author, content, attachments, at],
        )?;
        Ok(())
    }
    pub fn kept_message(&self, guild: &str, id: &str) -> Result<Option<Kept>> {
        Ok(self.conn().query_row("SELECT channel_id, author_id, content, attachments, created_at FROM moderation_message_cache WHERE guild_id = ? AND message_id = ?", [guild, id], |r| {
            Ok(Kept { channel: r.get(0)?, author: r.get(1)?, content: r.get(2)?, attachments: r.get(3)?, at: r.get(4)? })
        }).optional()?)
    }
    pub fn forget_message(&self, guild: &str, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM moderation_message_cache WHERE guild_id = ? AND message_id = ?", [guild, id])?;
        Ok(())
    }
    /// Drops copies older than a week, and the oldest beyond 50,000 in a server.
    pub fn forget_old_messages(&self, guild: &str, now: i64) -> Result<()> {
        self.conn().execute("DELETE FROM moderation_message_cache WHERE guild_id = ? AND created_at < ?", params![guild, now - KEEP_MS])?;
        self.conn().execute(
            "DELETE FROM moderation_message_cache WHERE guild_id = ?1 AND message_id IN (SELECT message_id FROM moderation_message_cache WHERE guild_id = ?1 ORDER BY created_at DESC LIMIT -1 OFFSET ?2)",
            params![guild, MAX_PER_GUILD],
        )?;
        Ok(())
    }
}
