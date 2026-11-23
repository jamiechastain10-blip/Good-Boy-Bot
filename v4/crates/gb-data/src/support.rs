//! Tickets: the history of every ticket, the staff watch log and the message archive, in the same tables Good Boy 3's
//! support module keeps (its migrations 1 and 2), so a server's ticket history carries over.

use crate::{Result, Store};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub const MIGRATIONS: &[(i64, &str)] = &[
    (1, "CREATE TABLE IF NOT EXISTS support_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, number INTEGER NOT NULL, channel_id TEXT,
      opener_id TEXT NOT NULL, opener_tag TEXT, category TEXT NOT NULL, category_label TEXT, urgency TEXT,
      opened_at INTEGER NOT NULL, first_response_at INTEGER, claimed_by TEXT,
      closed_at INTEGER, closed_by TEXT, close_kind TEXT, resolution TEXT, reason TEXT, action_taken TEXT, notes TEXT, follow_up TEXT,
      outcome TEXT, decision TEXT, decision_reason TEXT, reopened INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX IF NOT EXISTS support_history_ticket ON support_history (guild_id, number);
    CREATE INDEX IF NOT EXISTS support_history_opener ON support_history (guild_id, opener_id);
    CREATE TABLE IF NOT EXISTS support_watch (
      id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, target_id TEXT, target_name TEXT, target_alias TEXT,
      reporter_id TEXT NOT NULL, ticket_number INTEGER, category TEXT, summary TEXT, evidence TEXT,
      status TEXT NOT NULL DEFAULT 'open', outcome_by TEXT, outcome_note TEXT, outcome_at INTEGER, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS support_watch_target ON support_watch (guild_id, target_id);
    CREATE INDEX IF NOT EXISTS support_watch_name ON support_watch (guild_id, target_name);"),
    (2, "CREATE TABLE IF NOT EXISTS support_archive (
      guild_id TEXT NOT NULL, number INTEGER NOT NULL, message_id TEXT NOT NULL, channel_id TEXT, author_id TEXT, author_name TEXT, author_avatar TEXT,
      bot INTEGER NOT NULL DEFAULT 0, content TEXT NOT NULL DEFAULT '', embeds TEXT NOT NULL DEFAULT '[]', attachments TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, edited_at INTEGER, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, message_id));
    CREATE INDEX IF NOT EXISTS support_archive_ticket ON support_archive (guild_id, number, created_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS support_archive_fts USING fts5(content, guild_id UNINDEXED, number UNINDEXED, message_id UNINDEXED);
    ALTER TABLE support_history ADD COLUMN reported_id TEXT;
    ALTER TABLE support_history ADD COLUMN reported_name TEXT;
    ALTER TABLE support_history ADD COLUMN details TEXT;"),
];

/// One watch-log entry (a report about someone: an accusation, not a finding).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WatchEntry {
    pub id: i64,
    pub target_id: Option<String>,
    pub target_name: Option<String>,
    pub target_alias: Option<String>,
    pub reporter_id: String,
    pub ticket_number: Option<i64>,
    pub category: Option<String>,
    pub summary: Option<String>,
    pub evidence: Option<String>,
    pub status: String,
    pub outcome_by: Option<String>,
    pub outcome_note: Option<String>,
    pub outcome_at: Option<i64>,
    pub created_at: i64,
}
const WATCH_COLS: &str = "id, target_id, target_name, target_alias, reporter_id, ticket_number, category, summary, evidence, status, outcome_by, outcome_note, outcome_at, created_at";
fn watch_row(r: &rusqlite::Row) -> rusqlite::Result<WatchEntry> {
    Ok(WatchEntry { id: r.get(0)?, target_id: r.get(1)?, target_name: r.get(2)?, target_alias: r.get(3)?, reporter_id: r.get(4)?, ticket_number: r.get(5)?, category: r.get(6)?, summary: r.get(7)?, evidence: r.get(8)?, status: r.get(9)?, outcome_by: r.get(10)?, outcome_note: r.get(11)?, outcome_at: r.get(12)?, created_at: r.get(13)? })
}

/// One finished or running ticket in the history (only what the numbers and the staff view need).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HistoryRow {
    pub number: i64,
    pub opener_id: String,
    pub category: String,
    pub opened_at: i64,
    pub first_response_at: Option<i64>,
    pub claimed_by: Option<String>,
    pub closed_at: Option<i64>,
    pub close_kind: Option<String>,
}

/// One message kept from a ticket's channel.
#[derive(Debug, Clone, Default)]
pub struct ArchiveMessage {
    pub id: String,
    pub author_id: Option<String>,
    pub author_name: String,
    pub bot: bool,
    pub content: String,
    /// JSON: the files that came with it.
    pub attachments: String,
    pub at: i64,
    pub deleted: bool,
}
/// A ticket as the dashboard lists it.
#[derive(Debug, Clone, Default)]
pub struct HistoryDetail {
    pub number: i64,
    pub channel: Option<String>,
    pub opener_id: String,
    pub opener_tag: Option<String>,
    pub category: String,
    pub category_label: Option<String>,
    pub urgency: Option<String>,
    pub reported_id: Option<String>,
    pub reported_name: Option<String>,
    pub opened_at: i64,
    pub first_response_at: Option<i64>,
    pub claimed_by: Option<String>,
    pub closed_at: Option<i64>,
    pub closed_by: Option<String>,
    pub close_kind: Option<String>,
    pub resolution: Option<String>,
}

/// How a ticket was closed, for the history.
#[derive(Debug, Clone, Default)]
pub struct Closing<'a> {
    pub at: i64,
    pub by: Option<&'a str>,
    pub kind: &'a str,
    pub resolution: Option<&'a str>,
    pub reason: Option<&'a str>,
    pub action: Option<&'a str>,
    pub notes: Option<&'a str>,
    pub followup: Option<&'a str>,
    pub outcome: Option<&'a str>,
}

impl Store {
    /// Adds the ticket to the history if it is not there yet. `t` is the ticket record (Good Boy 3's shape).
    pub fn history_ensure(&self, guild: &str, t: &Value, channel: &str) -> Result<()> {
        self.conn().execute("INSERT OR IGNORE INTO support_history (guild_id, number, channel_id, opener_id, opener_tag, category, category_label, urgency, opened_at, first_response_at, claimed_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![guild, t["number"].as_i64().unwrap_or(0), channel, t["opener"].as_str().unwrap_or(""), t["openerTag"].as_str(), t["category"].as_str().or(t["type"].as_str()).unwrap_or("other"),
                t["typeLabel"].as_str(), t["priority"].as_str().unwrap_or("normal"), t["createdAt"].as_i64().unwrap_or(0), t["firstResponseAt"].as_i64(), t["claimedBy"].as_str()])?;
        Ok(())
    }
    /// Who the ticket is about, the answers and the kept files, for the archive.
    pub fn history_details(&self, guild: &str, t: &Value) -> Result<()> {
        let details = json!({ "answers": t.get("answers").cloned().unwrap_or(json!([])), "people": t.get("people").cloned().unwrap_or(Value::Null), "files": t.get("files").cloned().unwrap_or(json!([])) });
        self.conn().execute("UPDATE support_history SET reported_id = ?, reported_name = ?, details = ? WHERE guild_id = ? AND number = ?",
            params![t["report"]["id"].as_str(), t["report"]["name"].as_str().or(t["people"]["about"]["name"].as_str()), details.to_string(), guild, t["number"].as_i64().unwrap_or(0)])?;
        Ok(())
    }
    pub fn history_close(&self, guild: &str, t: &Value, channel: &str, f: &Closing) -> Result<()> {
        self.history_ensure(guild, t, channel)?;
        self.conn().execute("UPDATE support_history SET closed_at = ?, closed_by = ?, close_kind = ?, resolution = ?, reason = ?, action_taken = ?, notes = ?, follow_up = ?, outcome = ?,
            urgency = ?, claimed_by = ?, first_response_at = ?, decision = ?, decision_reason = ? WHERE guild_id = ? AND number = ?",
            params![f.at, f.by, f.kind, f.resolution, f.reason, f.action, f.notes, f.followup, f.outcome, t["priority"].as_str().unwrap_or("normal"), t["claimedBy"].as_str(),
                t["firstResponseAt"].as_i64(), t["decision"]["result"].as_str(), t["decision"]["reason"].as_str(), guild, t["number"].as_i64().unwrap_or(0)])?;
        Ok(())
    }
    pub fn history_reopen(&self, guild: &str, number: i64) -> Result<()> {
        self.conn().execute("UPDATE support_history SET closed_at = NULL, closed_by = NULL, close_kind = NULL, reopened = reopened + 1 WHERE guild_id = ? AND number = ?", params![guild, number])?;
        Ok(())
    }
    pub fn history_rows(&self, guild: &str) -> Result<Vec<HistoryRow>> {
        let mut st = self.conn().prepare("SELECT number, opener_id, category, opened_at, first_response_at, claimed_by, closed_at, close_kind FROM support_history WHERE guild_id = ?")?;
        let rows = st.query_map([guild], |r| Ok(HistoryRow { number: r.get(0)?, opener_id: r.get(1)?, category: r.get(2)?, opened_at: r.get(3)?, first_response_at: r.get(4)?, claimed_by: r.get(5)?, closed_at: r.get(6)?, close_kind: r.get(7)? }))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// A ticket's conversation, oldest first (the newest `limit` messages).
    pub fn archive_messages(&self, guild: &str, number: i64, limit: usize) -> Result<Vec<ArchiveMessage>> {
        let mut st = self.conn().prepare("SELECT message_id, author_id, author_name, bot, content, attachments, created_at, deleted FROM support_archive WHERE guild_id = ? AND number = ? ORDER BY created_at DESC, message_id DESC LIMIT ?")?;
        let rows = st.query_map(params![guild, number, limit.clamp(1, 1000) as i64], |r| Ok(ArchiveMessage { id: r.get(0)?, author_id: r.get(1)?, author_name: r.get::<_, Option<String>>(2)?.unwrap_or_default(), bot: r.get::<_, i64>(3)? != 0, content: r.get(4)?, attachments: r.get(5)?, at: r.get(6)?, deleted: r.get::<_, i64>(7)? != 0 }))?;
        let mut all: Vec<ArchiveMessage> = rows.collect::<std::result::Result<_, _>>()?;
        all.reverse();
        Ok(all)
    }
    /// Every ticket with the details the dashboard shows: who opened it, who it is about, how urgent it is and who has it.
    pub fn history_list(&self, guild: &str) -> Result<Vec<HistoryDetail>> {
        let mut st = self.conn().prepare("SELECT number, channel_id, opener_id, opener_tag, category, category_label, urgency, reported_id, reported_name, opened_at, first_response_at, claimed_by, closed_at, closed_by, close_kind, resolution FROM support_history WHERE guild_id = ?")?;
        let rows = st.query_map([guild], |r| Ok(HistoryDetail { number: r.get(0)?, channel: r.get(1)?, opener_id: r.get(2)?, opener_tag: r.get(3)?, category: r.get(4)?, category_label: r.get(5)?, urgency: r.get(6)?, reported_id: r.get(7)?, reported_name: r.get(8)?,
            opened_at: r.get(9)?, first_response_at: r.get(10)?, claimed_by: r.get(11)?, closed_at: r.get(12)?, closed_by: r.get(13)?, close_kind: r.get(14)?, resolution: r.get(15)? }))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// (who opened it, who claimed it) for one ticket number.
    pub fn history_people(&self, guild: &str, number: i64) -> Result<Option<(String, Option<String>)>> {
        Ok(self.conn().query_row("SELECT opener_id, claimed_by FROM support_history WHERE guild_id = ? AND number = ?", params![guild, number], |r| Ok((r.get(0)?, r.get(1)?))).optional()?)
    }
    pub fn tickets_opened_by(&self, guild: &str, user: &str) -> Result<i64> {
        Ok(self.conn().query_row("SELECT COUNT(*) FROM support_history WHERE guild_id = ? AND opener_id = ?", params![guild, user], |r| r.get(0))?)
    }

    pub fn watch_rows(&self, guild: &str) -> Result<Vec<WatchEntry>> {
        let mut st = self.conn().prepare(&format!("SELECT {WATCH_COLS} FROM support_watch WHERE guild_id = ? ORDER BY id"))?;
        let rows = st.query_map([guild], watch_row)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn watch_get(&self, guild: &str, id: i64) -> Result<Option<WatchEntry>> {
        Ok(self.conn().query_row(&format!("SELECT {WATCH_COLS} FROM support_watch WHERE id = ? AND guild_id = ?"), params![id, guild], watch_row).optional()?)
    }
    pub fn watch_about(&self, guild: &str, target: &str) -> Result<Vec<WatchEntry>> {
        let mut st = self.conn().prepare(&format!("SELECT {WATCH_COLS} FROM support_watch WHERE guild_id = ? AND target_id = ? ORDER BY id DESC"))?;
        let rows = st.query_map([guild, target], watch_row)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// Adds an entry; summary and evidence are cut to 500 characters, as Good Boy 3 does. Gives its number.
    #[allow(clippy::too_many_arguments)]
    pub fn watch_add(&self, guild: &str, target_id: Option<&str>, target_name: Option<&str>, alias: Option<&str>, reporter: &str, ticket: Option<i64>, category: Option<&str>, summary: Option<&str>, evidence: Option<&str>, now: i64) -> Result<i64> {
        let cut = |s: Option<&str>| s.map(|s| if s.chars().count() > 500 { format!("{}…", s.chars().take(499).collect::<String>()) } else { s.to_string() });
        self.conn().execute("INSERT INTO support_watch (guild_id, target_id, target_name, target_alias, reporter_id, ticket_number, category, summary, evidence, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
            params![guild, target_id, target_name, alias, reporter, ticket, category, cut(summary), cut(evidence), now])?;
        Ok(self.conn().last_insert_rowid())
    }
    /// Sets an entry's outcome. False when there is no such entry.
    pub fn watch_set(&self, guild: &str, id: i64, status: &str, by: &str, note: Option<&str>, now: i64) -> Result<bool> {
        Ok(self.conn().execute("UPDATE support_watch SET status = ?, outcome_by = ?, outcome_note = ?, outcome_at = ? WHERE id = ? AND guild_id = ?", params![status, by, note, now, id, guild])? > 0)
    }
    pub fn watch_remove(&self, guild: &str, id: i64) -> Result<bool> {
        Ok(self.conn().execute("DELETE FROM support_watch WHERE id = ? AND guild_id = ?", params![id, guild])? > 0)
    }
    /// Keeps the watch log to its retention: everything older than `days`, and unfounded entries older than `unfounded` days.
    pub fn watch_purge(&self, guild: &str, now: i64, days: i64, unfounded: i64) -> Result<()> {
        const DAY: i64 = 86_400_000;
        if days > 0 { self.conn().execute("DELETE FROM support_watch WHERE guild_id = ? AND created_at < ?", params![guild, now - days * DAY])?; }
        if unfounded > 0 { self.conn().execute("DELETE FROM support_watch WHERE guild_id = ? AND status = 'unfounded' AND COALESCE(outcome_at, created_at) < ?", params![guild, now - unfounded * DAY])?; }
        Ok(())
    }

    /// Keeps one ticket message in the archive, with the words searchable.
    #[allow(clippy::too_many_arguments)]
    pub fn archive_put(&self, guild: &str, number: i64, message: &str, channel: &str, author: Option<&str>, author_name: &str, avatar: Option<&str>, bot: bool, content: &str, embeds: &Value, files: &Value, at: i64) -> Result<()> {
        self.batch(|s| {
            s.conn().execute("INSERT OR REPLACE INTO support_archive (guild_id, number, message_id, channel_id, author_id, author_name, author_avatar, bot, content, embeds, attachments, created_at, edited_at, deleted)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)", params![guild, number, message, channel, author, author_name, avatar, bot as i64, content, embeds.to_string(), files.to_string(), at])?;
            s.conn().execute("DELETE FROM support_archive_fts WHERE guild_id = ? AND message_id = ?", params![guild, message])?;
            let mut text = vec![content.to_string()];
            for e in embeds.as_array().into_iter().flatten() {
                for k in ["title", "description"] { if let Some(v) = e[k].as_str() { text.push(v.into()); } }
                for f in e["fields"].as_array().into_iter().flatten() { text.push(format!("{} {}", f["name"].as_str().unwrap_or(""), f["value"].as_str().unwrap_or(""))); }
            }
            let text = text.into_iter().filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n");
            if !text.is_empty() { s.conn().execute("INSERT INTO support_archive_fts (content, guild_id, number, message_id) VALUES (?, ?, ?, ?)", params![text, guild, number, message])?; }
            Ok(())
        })
    }
    /// A ticket message was edited: the archive keeps the new words (only when they changed).
    pub fn archive_edit(&self, guild: &str, message: &str, content: &str, now: i64) -> Result<()> {
        let row: Option<(i64, String)> = self.conn().query_row("SELECT number, content FROM support_archive WHERE guild_id = ? AND message_id = ?", params![guild, message], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        let Some((number, old)) = row else { return Ok(()) };
        if old == content { return Ok(()); }
        self.batch(|s| {
            s.conn().execute("UPDATE support_archive SET content = ?, edited_at = ? WHERE guild_id = ? AND message_id = ?", params![content, now, guild, message])?;
            s.conn().execute("DELETE FROM support_archive_fts WHERE guild_id = ? AND message_id = ?", params![guild, message])?;
            s.conn().execute("INSERT INTO support_archive_fts (content, guild_id, number, message_id) VALUES (?, ?, ?, ?)", params![content, guild, number, message])?;
            Ok(())
        })
    }
    pub fn archive_deleted(&self, guild: &str, message: &str) -> Result<()> {
        self.conn().execute("UPDATE support_archive SET deleted = 1 WHERE guild_id = ? AND message_id = ?", params![guild, message])?;
        Ok(())
    }
    /// Ticket numbers whose archived messages contain these words (for searching the archive).
    pub fn archive_search(&self, guild: &str, words: &str) -> Result<Vec<i64>> {
        let q = words.split_whitespace().map(|w| format!("\"{}\"", w.replace('"', "\"\""))).collect::<Vec<_>>().join(" ");
        if q.is_empty() { return Ok(Vec::new()); }
        let mut st = self.conn().prepare("SELECT DISTINCT number FROM support_archive_fts WHERE support_archive_fts MATCH ? AND guild_id = ? LIMIT 500")?;
        let rows = st.query_map(params![q, guild], |r| r.get::<_, i64>(0))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_tables_are_made_and_searched() {
        let tmp = std::env::temp_dir().join(format!("gb-support-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let s = Store::create(&tmp).unwrap();
        assert_eq!(s.module_migrate("support", MIGRATIONS).unwrap(), 2);
        let t = json!({ "number": 7, "opener": "1", "openerTag": "kai", "category": "report", "typeLabel": "Report a member", "priority": "high", "createdAt": 100 });
        s.history_ensure("g", &t, "c").unwrap();
        s.history_close("g", &t, "c", &Closing { at: 500, by: Some("2"), kind: "staff", resolution: Some("Resolved"), ..Default::default() }).unwrap();
        let rows = s.history_rows("g").unwrap();
        assert_eq!((rows[0].number, rows[0].closed_at, rows[0].close_kind.as_deref()), (7, Some(500), Some("staff")));
        let id = s.watch_add("g", Some("123456789012345678"), Some("badguy"), None, "1", Some(7), Some("report"), Some("spam"), None, 100).unwrap();
        assert!(s.watch_set("g", id, "confirmed", "2", Some("seen it"), 200).unwrap());
        assert_eq!(s.watch_get("g", id).unwrap().unwrap().status, "confirmed");
        s.archive_put("g", 7, "m1", "c", Some("1"), "Kai", None, false, "he sent a scam link", &json!([]), &json!([]), 100).unwrap();
        assert_eq!(s.archive_search("g", "scam link").unwrap(), vec![7]);
        s.archive_edit("g", "m1", "fixed words", 300).unwrap();
        assert!(s.archive_search("g", "scam").unwrap().is_empty());
        let _ = std::fs::remove_file(&tmp);
    }
}
