//! Good Boy 3's reputation history (who gave or changed whose reputation, and why) and the three leaderboards.
//! Scores themselves live in each member's `user:<id>` record next to their XP, exactly as in Good Boy 3.

use crate::{Result, Store};
use rusqlite::params;
use serde_json::{json, Value};

pub const MIGRATIONS: &[(i64, &str)] = &[(1, "
    CREATE TABLE IF NOT EXISTS community_rep_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, target_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      delta INTEGER NOT NULL, balance_after INTEGER, kind TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS community_rep_history_target ON community_rep_history (guild_id, target_id, created_at);
    CREATE INDEX IF NOT EXISTS community_rep_history_actor ON community_rep_history (guild_id, actor_id, created_at);
")];

/// One line of a member's reputation history.
#[derive(Debug, Clone, PartialEq)]
pub struct RepRow {
    pub actor: String,
    pub delta: i64,
    pub balance: i64,
    pub kind: String,
    pub reason: Option<String>,
    pub at: i64,
}

/// What a leaderboard ranks by. Only these three are ever put into a query.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Board {
    Xp,
    Rep,
    Messages,
}
impl Board {
    pub fn parse(s: &str) -> Board {
        match s {
            "rep" => Board::Rep,
            "messages" => Board::Messages,
            _ => Board::Xp,
        }
    }
    pub fn id(self) -> &'static str {
        match self { Board::Xp => "xp", Board::Rep => "rep", Board::Messages => "messages" }
    }
    pub fn title(self) -> &'static str {
        match self { Board::Xp => "XP", Board::Rep => "Reputation", Board::Messages => "Messages" }
    }
    fn shown(self) -> &'static str {
        match self {
            Board::Rep => "CAST(json_extract(value, '$.rep') AS INTEGER) != 0",
            Board::Messages => "CAST(json_extract(value, '$.messages') AS INTEGER) > 0",
            Board::Xp => "CAST(json_extract(value, '$.xp') AS INTEGER) > 0",
        }
    }
    fn column(self) -> &'static str {
        match self {
            Board::Rep => "CAST(json_extract(value, '$.rep') AS INTEGER)",
            Board::Messages => "CAST(json_extract(value, '$.messages') AS INTEGER)",
            Board::Xp => "CAST(json_extract(value, '$.xp') AS INTEGER)",
        }
    }
}

impl Store {
    #[allow(clippy::too_many_arguments)]
    pub fn rep_log(&self, guild: &str, target: &str, actor: &str, delta: i64, balance: i64, kind: &str, reason: Option<&str>, at: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO community_rep_history (guild_id, target_id, actor_id, delta, balance_after, kind, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![guild, target, actor, delta, balance, kind, reason.map(|r| r.chars().take(300).collect::<String>()), at],
        )?;
        Ok(())
    }
    /// A member's latest reputation changes, newest first.
    pub fn rep_history(&self, guild: &str, target: &str, limit: usize) -> Result<Vec<RepRow>> {
        let mut st = self.conn.prepare_cached("SELECT actor_id, delta, balance_after, kind, reason, created_at FROM community_rep_history WHERE guild_id = ? AND target_id = ? ORDER BY id DESC LIMIT ?")?;
        let rows = st.query_map(params![guild, target, limit as i64], |r| Ok(RepRow { actor: r.get(0)?, delta: r.get(1)?, balance: r.get::<_, Option<i64>>(2)?.unwrap_or(0), kind: r.get(3)?, reason: r.get(4)?, at: r.get(5)? }))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// How many times this member gave reputation since `since`.
    pub fn rep_gives_since(&self, guild: &str, actor: &str, since: i64) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM community_rep_history WHERE guild_id = ? AND actor_id = ? AND kind = 'give' AND created_at > ?", params![guild, actor, since], |r| r.get(0))?)
    }
    /// When this member last rated that member.
    pub fn rep_pair_last(&self, guild: &str, actor: &str, target: &str) -> Result<Option<i64>> {
        Ok(self.conn.query_row("SELECT MAX(created_at) FROM community_rep_history WHERE guild_id = ? AND actor_id = ? AND target_id = ? AND kind = 'give'", params![guild, actor, target], |r| r.get(0))?)
    }
    /// How many negative votes a member received since `since`.
    pub fn rep_negs_since(&self, guild: &str, target: &str, since: i64) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM community_rep_history WHERE guild_id = ? AND target_id = ? AND kind = 'give' AND delta < 0 AND created_at > ?", params![guild, target, since], |r| r.get(0))?)
    }
    /// One page of a leaderboard: (member, value), best first (ties: more XP first).
    pub fn level_board(&self, guild: &str, board: Board, limit: usize, offset: usize) -> Result<Vec<(String, i64)>> {
        let sql = format!(
            "SELECT substr(key, 6), {col} FROM module_data WHERE guild_id = ?1 AND module = 'community' AND substr(key, 1, 5) = 'user:' AND {shown} \
             ORDER BY {col} DESC, CAST(json_extract(value, '$.xp') AS INTEGER) DESC, key LIMIT ?2 OFFSET ?3",
            col = board.column(), shown = board.shown());
        let mut st = self.conn.prepare_cached(&sql)?;
        let rows = st.query_map(params![guild, limit as i64, offset as i64], |r| Ok((r.get(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0))))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// How many members are on a leaderboard.
    pub fn level_board_len(&self, guild: &str, board: Board) -> Result<usize> {
        let sql = format!("SELECT COUNT(*) FROM module_data WHERE guild_id = ?1 AND module = 'community' AND substr(key, 1, 5) = 'user:' AND {}", board.shown());
        let n: i64 = self.conn.query_row(&sql, [guild], |r| r.get(0))?;
        Ok(n as usize)
    }
    /// Every counted message in the server (the /serverstats line).
    pub fn messages_total(&self, guild: &str) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COALESCE(SUM(CAST(json_extract(value, '$.messages') AS INTEGER)), 0) FROM module_data WHERE guild_id = ? AND module = 'community' AND substr(key, 1, 5) = 'user:'", [guild], |r| r.get(0))?)
    }
    /// Sets everyone's reputation to 0 and writes each change to the history. Returns how many members changed.
    pub fn rep_reset_all(&self, guild: &str, actor: &str, at: i64) -> Result<usize> {
        let all = self.data_list(guild, "community", "user:", usize::MAX >> 1)?;
        self.conn.execute_batch("BEGIN")?;
        let mut done = 0;
        let run = (|| -> Result<()> {
            for (key, mut value) in all {
                let rep = value.get("rep").and_then(Value::as_i64).unwrap_or(0);
                if rep == 0 { continue; }
                if let Some(o) = value.as_object_mut() { o.insert("rep".into(), json!(0)); }
                self.data_set(guild, "community", &key, &value)?;
                self.rep_log(guild, &key[5..], actor, -rep, 0, "reset_all", Some("server-wide reset"), at)?;
                done += 1;
            }
            Ok(())
        })();
        match run {
            Ok(()) => { self.conn.execute_batch("COMMIT")?; Ok(done) }
            Err(e) => { let _ = self.conn.execute_batch("ROLLBACK"); Err(e) }
        }
    }
    /// How many members have a reputation other than 0.
    pub fn rep_nonzero(&self, guild: &str) -> Result<usize> {
        self.level_board_len(guild, Board::Rep)
    }
}
