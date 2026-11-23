//! Who is (and was) in each server: names, so the launcher never has to show a number, and a record of who left, for a
//! while, so staff can see who they were, how they went and whether they were dodging something.
//! These are Good Boy 4's own tables (module `roster`); Good Boy 3 ignores them.

use crate::{Result, Store};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;

pub const MIGRATIONS: &[(i64, &str)] = &[
    (1, "CREATE TABLE roster_members (
            guild_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, avatar TEXT, bot INTEGER NOT NULL DEFAULT 0,
            joined_at INTEGER, roles TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, left_at INTEGER,
            PRIMARY KEY (guild_id, user_id));
          CREATE INDEX roster_members_name ON roster_members (guild_id, left_at, name COLLATE NOCASE);
          CREATE TABLE roster_leaves (
            id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, avatar TEXT,
            left_at INTEGER NOT NULL, joined_at INTEGER, roles TEXT, how TEXT NOT NULL DEFAULT 'left', by_user TEXT, reason TEXT,
            strikes INTEGER NOT NULL DEFAULT 0, cases INTEGER NOT NULL DEFAULT 0, flags TEXT, returned_at INTEGER);
          CREATE INDEX roster_leaves_when ON roster_leaves (guild_id, left_at DESC);
          CREATE INDEX roster_leaves_user ON roster_leaves (guild_id, user_id, left_at DESC);"),
];

/// A member as the roster knows them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Known {
    pub id: String,
    pub name: String,
    pub avatar: Option<String>,
    pub bot: bool,
}
/// What is written down when someone leaves.
#[derive(Debug, Clone, Default)]
pub struct Leaving<'a> {
    pub user: &'a str,
    pub name: &'a str,
    pub avatar: Option<&'a str>,
    pub at: i64,
    pub joined_at: Option<i64>,
    /// Their role ids.
    pub roles: &'a [String],
    pub strikes: i64,
    pub cases: i64,
    /// Plain words for what stands out: "left within a day of joining", "still on the watch list" and so on.
    pub flags: &'a [String],
}
/// What the roster remembers about one member: name, avatar, when they joined, their roles.
pub type Remembered = (String, Option<String>, Option<i64>, Vec<String>);
/// One record of someone leaving.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Left {
    pub id: i64,
    pub user: String,
    pub name: String,
    pub avatar: Option<String>,
    pub left_at: i64,
    pub joined_at: Option<i64>,
    pub roles: Vec<String>,
    /// "left", "kicked" or "banned".
    pub how: String,
    pub by: Option<String>,
    pub reason: Option<String>,
    pub strikes: i64,
    pub cases: i64,
    pub flags: Vec<String>,
    /// When they came back, if they did.
    pub returned_at: Option<i64>,
}

fn list(v: Option<String>) -> Vec<String> {
    v.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

impl Store {
    /// Remembers a member's name (and when they joined and what roles they hold). A member who was marked as gone
    /// is marked as back, and their latest leave record learns when they returned.
    #[allow(clippy::too_many_arguments)]
    pub fn roster_seen(&self, guild: &str, user: &str, name: &str, avatar: Option<&str>, bot: bool, joined_at: Option<i64>, roles: Option<&[String]>, now: i64) -> Result<()> {
        let name = name.trim();
        if name.is_empty() { return Ok(()); }
        let roles_json = roles.map(|r| serde_json::to_string(r).unwrap_or_default());
        self.conn().execute(
            "INSERT INTO roster_members (guild_id, user_id, name, avatar, bot, joined_at, roles, first_seen, last_seen) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
             ON CONFLICT (guild_id, user_id) DO UPDATE SET name = ?3, avatar = COALESCE(?4, avatar), bot = ?5, joined_at = COALESCE(?6, joined_at), roles = COALESCE(?7, roles), last_seen = ?8, left_at = NULL",
            params![guild, user, name.chars().take(80).collect::<String>(), avatar, bot as i64, joined_at, roles_json, now])?;
        Ok(())
    }
    /// A member came back: their newest leave record that was still open learns it.
    pub fn roster_returned(&self, guild: &str, user: &str, now: i64) -> Result<()> {
        self.conn().execute("UPDATE roster_leaves SET returned_at = ?3 WHERE id = (SELECT id FROM roster_leaves WHERE guild_id = ?1 AND user_id = ?2 AND returned_at IS NULL ORDER BY left_at DESC, id DESC LIMIT 1)", params![guild, user, now])?;
        Ok(())
    }
    /// Names for some ids: whoever the roster knows.
    pub fn roster_names(&self, guild: &str, ids: &[String]) -> Result<HashMap<String, String>> {
        let mut out = HashMap::new();
        let mut st = self.conn().prepare_cached("SELECT name FROM roster_members WHERE guild_id = ? AND user_id = ?")?;
        for id in ids.iter().take(500) {
            if let Some(n) = st.query_row([guild, id.as_str()], |r| r.get::<_, String>(0)).optional()? { out.insert(id.clone(), n); }
        }
        Ok(out)
    }
    /// Members whose name starts with or contains `q` (people still here first), for a picker. Empty `q` gives the
    /// most recently seen.
    pub fn roster_search(&self, guild: &str, q: &str, include_bots: bool, limit: usize) -> Result<Vec<Known>> {
        let q = q.trim().to_lowercase().replace(['%', '_', '\\'], "");
        let mut st = self.conn().prepare(
            "SELECT user_id, name, avatar, bot FROM roster_members WHERE guild_id = ?1 AND left_at IS NULL AND (?3 OR bot = 0) AND (?2 = '' OR LOWER(name) LIKE '%' || ?2 || '%')
             ORDER BY (LOWER(name) LIKE ?2 || '%') DESC, last_seen DESC LIMIT ?4")?;
        let rows = st.query_map(params![guild, q, include_bots, limit.min(50) as i64], |r| Ok(Known { id: r.get(0)?, name: r.get(1)?, avatar: r.get(2)?, bot: r.get::<_, i64>(3)? != 0 }))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// How many members hold each of these roles (as far as the roster knows their roles).
    pub fn roster_role_counts(&self, guild: &str, roles: &[String]) -> Result<HashMap<String, i64>> {
        let mut out = HashMap::new();
        let mut st = self.conn().prepare_cached("SELECT COUNT(*) FROM roster_members WHERE guild_id = ?1 AND left_at IS NULL AND roles LIKE ?2")?;
        for r in roles.iter().filter(|r| r.bytes().all(|b| b.is_ascii_digit())).take(50) {
            out.insert(r.clone(), st.query_row(params![guild, format!("%\"{r}\"%")], |row| row.get::<_, i64>(0))?);
        }
        Ok(out)
    }
    /// What the roster remembers about one member (for a leave record).
    pub fn roster_get(&self, guild: &str, user: &str) -> Result<Option<Remembered>> {
        Ok(self.conn().query_row("SELECT name, avatar, joined_at, roles FROM roster_members WHERE guild_id = ? AND user_id = ?", [guild, user], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<i64>>(2)?, list(r.get(3)?)))).optional()?)
    }
    pub fn roster_count(&self, guild: &str) -> Result<i64> {
        Ok(self.conn().query_row("SELECT COUNT(*) FROM roster_members WHERE guild_id = ? AND left_at IS NULL", [guild], |r| r.get(0))?)
    }
    /// Writes down that someone left. A second event for the same leaving (within a minute) is the same record.
    pub fn roster_left(&self, guild: &str, l: &Leaving) -> Result<i64> {
        self.batch(|s| {
            s.conn().execute("UPDATE roster_members SET left_at = ? WHERE guild_id = ? AND user_id = ?", params![l.at, guild, l.user])?;
            let dup: Option<i64> = s.conn().query_row("SELECT id FROM roster_leaves WHERE guild_id = ? AND user_id = ? AND left_at >= ? AND returned_at IS NULL ORDER BY id DESC LIMIT 1", params![guild, l.user, l.at - 60_000], |r| r.get(0)).optional()?;
            if let Some(id) = dup { return Ok(id); }
            s.conn().execute(
                "INSERT INTO roster_leaves (guild_id, user_id, name, avatar, left_at, joined_at, roles, strikes, cases, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![guild, l.user, l.name.chars().take(80).collect::<String>(), l.avatar, l.at, l.joined_at, serde_json::to_string(l.roles).unwrap_or_default(), l.strikes, l.cases, serde_json::to_string(l.flags).unwrap_or_default()])?;
            Ok(s.conn().last_insert_rowid())
        })
    }
    #[allow(clippy::too_many_arguments)]
    /// Says how someone's latest leaving went ("kicked", "banned"), if it was within `within` ms of `now`. Gives
    /// whether a record was found.
    pub fn roster_how(&self, guild: &str, user: &str, how: &str, by: Option<&str>, reason: Option<&str>, now: i64, within: i64) -> Result<bool> {
        let n = self.conn().execute(
            "UPDATE roster_leaves SET how = ?3, by_user = COALESCE(?4, by_user), reason = COALESCE(?5, reason) WHERE id = (SELECT id FROM roster_leaves WHERE guild_id = ?1 AND user_id = ?2 AND left_at >= ?6 ORDER BY left_at DESC, id DESC LIMIT 1)",
            params![guild, user, how, by, reason.map(|r| r.chars().take(200).collect::<String>()), now - within])?;
        Ok(n > 0)
    }
    /// Leave records since a moment, newest first, optionally only those matching a name.
    pub fn roster_leaves(&self, guild: &str, since: i64, q: &str, limit: usize) -> Result<Vec<Left>> {
        let q = q.trim().to_lowercase().replace(['%', '_', '\\'], "");
        let mut st = self.conn().prepare(
            "SELECT id, user_id, name, avatar, left_at, joined_at, roles, how, by_user, reason, strikes, cases, flags, returned_at FROM roster_leaves
             WHERE guild_id = ?1 AND left_at >= ?2 AND (?3 = '' OR LOWER(name) LIKE '%' || ?3 || '%') ORDER BY left_at DESC, id DESC LIMIT ?4")?;
        let rows = st.query_map(params![guild, since, q, limit.min(1000) as i64], |r| Ok(Left {
            id: r.get(0)?, user: r.get(1)?, name: r.get(2)?, avatar: r.get(3)?, left_at: r.get(4)?, joined_at: r.get(5)?, roles: list(r.get(6)?), how: r.get(7)?, by: r.get(8)?, reason: r.get(9)?,
            strikes: r.get(10)?, cases: r.get(11)?, flags: list(r.get(12)?), returned_at: r.get(13)? }))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// Their earlier leavings, newest first (for a member who joined again).
    pub fn roster_history(&self, guild: &str, user: &str) -> Result<Vec<Left>> {
        let mut st = self.conn().prepare("SELECT id, user_id, name, avatar, left_at, joined_at, roles, how, by_user, reason, strikes, cases, flags, returned_at FROM roster_leaves WHERE guild_id = ? AND user_id = ? ORDER BY left_at DESC, id DESC LIMIT 20")?;
        let rows = st.query_map([guild, user], |r| Ok(Left {
            id: r.get(0)?, user: r.get(1)?, name: r.get(2)?, avatar: r.get(3)?, left_at: r.get(4)?, joined_at: r.get(5)?, roles: list(r.get(6)?), how: r.get(7)?, by: r.get(8)?, reason: r.get(9)?,
            strikes: r.get(10)?, cases: r.get(11)?, flags: list(r.get(12)?), returned_at: r.get(13)? }))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// Forgets leave records older than the cutoff, and the names of members who left before it. Gives how many
    /// leave records went.
    pub fn roster_prune(&self, guild: &str, before: i64) -> Result<usize> {
        self.batch(|s| {
            let n = s.conn().execute("DELETE FROM roster_leaves WHERE guild_id = ? AND left_at < ?", params![guild, before])?;
            s.conn().execute("DELETE FROM roster_members WHERE guild_id = ? AND left_at IS NOT NULL AND left_at < ?", params![guild, before])?;
            Ok(n)
        })
    }
    /// Erases everything about one person (they asked, or staff decided).
    pub fn roster_forget(&self, guild: &str, user: &str) -> Result<usize> {
        self.batch(|s| {
            let n = s.conn().execute("DELETE FROM roster_leaves WHERE guild_id = ? AND user_id = ?", params![guild, user])?;
            s.conn().execute("DELETE FROM roster_members WHERE guild_id = ? AND user_id = ?", params![guild, user])?;
            Ok(n)
        })
    }
    pub fn roster_guilds(&self) -> Result<Vec<String>> {
        let mut st = self.conn().prepare("SELECT DISTINCT guild_id FROM roster_leaves")?;
        let rows = st.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> (tempfile::TempDir, Store) {
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::create(tmp.path().join("eclipse.db")).unwrap();
        s.module_migrate("roster", MIGRATIONS).unwrap();
        (tmp, s)
    }
    #[test]
    fn names_are_kept_found_and_forgotten() {
        let (_t, s) = store();
        s.roster_seen("g", "1", "Kai", None, false, Some(100), Some(&["r1".into()]), 10).unwrap();
        s.roster_seen("g", "2", "kaitlyn", Some("https://x/a.png"), false, None, None, 11).unwrap();
        s.roster_seen("g", "3", "Rowan", None, false, None, None, 12).unwrap();
        s.roster_seen("g", "4", "HelperBot", None, true, None, None, 13).unwrap();
        s.roster_seen("g", "5", "  ", None, false, None, None, 14).unwrap();
        assert_eq!(s.roster_count("g").unwrap(), 4);
        // a name search finds the start of a name first, ignores case, and leaves bots out unless asked
        let found: Vec<String> = s.roster_search("g", "KAI", false, 10).unwrap().into_iter().map(|k| k.name).collect();
        assert_eq!(found.len(), 2);
        assert!(s.roster_search("g", "bot", false, 10).unwrap().is_empty());
        assert_eq!(s.roster_search("g", "bot", true, 10).unwrap().len(), 1);
        assert_eq!(s.roster_search("g", "", false, 2).unwrap().len(), 2);
        assert!(s.roster_search("g", "100%", false, 10).unwrap().is_empty(), "wildcards are plain text");
        let names = s.roster_names("g", &["1".into(), "3".into(), "nobody".into()]).unwrap();
        assert_eq!((names.get("1").map(String::as_str), names.get("3").map(String::as_str), names.len()), (Some("Kai"), Some("Rowan"), 2));
        // a renamed member keeps their first-seen time and the avatar they had
        s.roster_seen("g", "2", "Kaitlyn B", None, false, None, None, 20).unwrap();
        assert_eq!(s.roster_get("g", "2").unwrap().unwrap().0, "Kaitlyn B");
        assert_eq!(s.roster_search("g", "kaitlyn", false, 5).unwrap()[0].avatar.as_deref(), Some("https://x/a.png"));
        let counts = s.roster_role_counts("g", &["1".into(), "9".into()]).unwrap();
        assert_eq!((counts.get("1"), counts.get("9")), (Some(&0), Some(&0)));
        s.roster_seen("g", "6", "Ira", None, false, None, Some(&["123".into(), "456".into()]), 15).unwrap();
        s.roster_seen("g", "7", "Jo", None, false, None, Some(&["123".into()]), 16).unwrap();
        let counts = s.roster_role_counts("g", &["123".into(), "456".into(), "789".into(), "x\"y".into()]).unwrap();
        assert_eq!((counts.get("123"), counts.get("456"), counts.get("789"), counts.len()), (Some(&2), Some(&1), Some(&0), 3), "only plain ids are counted");
        assert_eq!(s.roster_forget("g", "3").unwrap(), 0);
        assert!(s.roster_names("g", &["3".into()]).unwrap().is_empty());
    }
    #[test]
    fn leavings_are_recorded_explained_returned_and_forgotten_after_a_while() {
        let (_t, s) = store();
        const DAY: i64 = 86_400_000;
        s.roster_seen("g", "1", "Kai", None, false, Some(1000), Some(&["mod".into()]), 10).unwrap();
        let flags = vec!["left within a day of joining".to_string()];
        let l = Leaving { user: "1", name: "Kai", avatar: None, at: 100 * DAY, joined_at: Some(1000), roles: &["mod".into()], strikes: 2, cases: 3, flags: &flags };
        let id = s.roster_left("g", &l).unwrap();
        // someone who left is not offered by the picker, and the same leaving is one record
        assert!(s.roster_search("g", "kai", false, 5).unwrap().is_empty());
        assert_eq!(s.roster_left("g", &Leaving { at: 100 * DAY + 5_000, ..l.clone() }).unwrap(), id);
        let all = s.roster_leaves("g", 0, "", 10).unwrap();
        assert_eq!((all.len(), all[0].how.as_str(), all[0].strikes, all[0].roles.clone(), all[0].flags.clone()), (1, "left", 2, vec!["mod".to_string()], flags.clone()));
        // a ban that follows turns it into a ban, with who and why; one long after does not
        assert!(s.roster_how("g", "1", "banned", Some("mod9"), Some("raiding"), 100 * DAY + 2_000, 120_000).unwrap());
        assert!(!s.roster_how("g", "1", "banned", None, None, 101 * DAY, 120_000).unwrap());
        assert!(!s.roster_how("g", "2", "banned", None, None, 100 * DAY, 120_000).unwrap(), "no such leaving");
        let r = &s.roster_leaves("g", 0, "KA", 10).unwrap()[0];
        assert_eq!((r.how.as_str(), r.by.as_deref(), r.reason.as_deref(), r.returned_at), ("banned", Some("mod9"), Some("raiding"), None));
        // coming back is noticed
        s.roster_seen("g", "1", "Kai", None, false, None, None, 110 * DAY).unwrap();
        s.roster_returned("g", "1", 110 * DAY).unwrap();
        assert_eq!(s.roster_history("g", "1").unwrap()[0].returned_at, Some(110 * DAY));
        assert_eq!(s.roster_search("g", "kai", false, 5).unwrap().len(), 1);
        // records are kept for the time asked, then go
        assert_eq!(s.roster_prune("g", 90 * DAY).unwrap(), 0);
        assert_eq!(s.roster_prune("g", 120 * DAY).unwrap(), 1);
        assert!(s.roster_leaves("g", 0, "", 10).unwrap().is_empty());
        assert_eq!(s.roster_forget("g", "1").unwrap(), 0);
    }
}
