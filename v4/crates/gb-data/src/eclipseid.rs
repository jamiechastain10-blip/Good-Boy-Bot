//! The Eclipse ID tables. Version 1 (from Good Boy 3) kept a profile per server; version 2 keeps ONE card per person that
//! follows them to every server this bot is in, and a list of the servers they share it in. The version 1 tables are left
//! exactly as they were (nothing is deleted) and their cards are copied across once.

use crate::{Result, Store};
use rusqlite::{params, OptionalExtension};

pub const MIGRATIONS: &[(i64, &str)] = &[(1, "
    CREATE TABLE IF NOT EXISTS eclipseid_ids (eid INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS eclipseid_profile (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', games TEXT NOT NULL DEFAULT '', platforms TEXT NOT NULL DEFAULT '',
      availability TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', vis TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
    CREATE TABLE IF NOT EXISTS eclipseid_link (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, platform TEXT NOT NULL, value TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'private', added_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id, platform));
"), (2, "
    CREATE TABLE IF NOT EXISTS eclipseid_person (user_id TEXT PRIMARY KEY, bio TEXT NOT NULL DEFAULT '', games TEXT NOT NULL DEFAULT '', platforms TEXT NOT NULL DEFAULT '',
      availability TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', vis TEXT NOT NULL DEFAULT '{}', share_default INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS eclipseid_person_link (user_id TEXT NOT NULL, platform TEXT NOT NULL, value TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'private', added_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, platform));
    CREATE TABLE IF NOT EXISTS eclipseid_share (user_id TEXT NOT NULL, guild_id TEXT NOT NULL, shared INTEGER NOT NULL, PRIMARY KEY (user_id, guild_id));
    -- each person's newest per-server card becomes their one card; it stays shared only in the servers it was made in
    INSERT OR IGNORE INTO eclipseid_person (user_id, bio, games, platforms, availability, region, vis, share_default, updated_at)
      SELECT user_id, bio, games, platforms, availability, region, vis, 0, updated_at FROM eclipseid_profile p
      WHERE updated_at = (SELECT MAX(updated_at) FROM eclipseid_profile q WHERE q.user_id = p.user_id) GROUP BY user_id;
    INSERT OR IGNORE INTO eclipseid_person_link (user_id, platform, value, visibility, added_at)
      SELECT user_id, platform, value, visibility, added_at FROM eclipseid_link l
      WHERE added_at = (SELECT MAX(added_at) FROM eclipseid_link m WHERE m.user_id = l.user_id AND m.platform = l.platform) GROUP BY user_id, platform;
    INSERT OR IGNORE INTO eclipseid_person (user_id, share_default, updated_at) SELECT DISTINCT user_id, 0, 0 FROM eclipseid_link;
    INSERT OR IGNORE INTO eclipseid_share (user_id, guild_id, shared) SELECT user_id, guild_id, 1 FROM eclipseid_profile;
    INSERT OR IGNORE INTO eclipseid_share (user_id, guild_id, shared) SELECT user_id, guild_id, 1 FROM eclipseid_link;
"), (3, "
    -- what a person was seen playing (from their Discord status), with how often; they can switch it off and erase it
    CREATE TABLE IF NOT EXISTS eclipseid_seen (user_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, last_at INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (user_id, kind, name));
    CREATE TABLE IF NOT EXISTS eclipseid_auto (user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
    -- the servers where a person has shown up, so a server can look for players among its own members
    CREATE TABLE IF NOT EXISTS eclipseid_here (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
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
    /// A person's card: bio, games, platforms, availability, region and who may see each. None when they have none.
    pub fn eid_profile(&self, user: &str) -> Result<Option<Profile>> {
        Ok(self.conn().query_row("SELECT bio, games, platforms, availability, region, vis FROM eclipseid_person WHERE user_id = ?", [user], |r| Ok(Profile { bio: r.get(0)?, games: r.get(1)?, platforms: r.get(2)?, availability: r.get(3)?, region: r.get(4)?, vis: r.get(5)? })).optional()?)
    }
    /// Saves a person's card. A brand new card is shared in every server (the person can change that); a card that was
    /// carried over from the old per-server version keeps the servers it was in.
    pub fn eid_save(&self, user: &str, p: &Profile, now: i64) -> Result<()> {
        self.conn().execute("INSERT INTO eclipseid_person (user_id, bio, games, platforms, availability, region, vis, share_default, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
            ON CONFLICT(user_id) DO UPDATE SET bio = excluded.bio, games = excluded.games, platforms = excluded.platforms, availability = excluded.availability, region = excluded.region, vis = excluded.vis, updated_at = excluded.updated_at",
            params![user, p.bio, p.games, p.platforms, p.availability, p.region, p.vis, now])?;
        Ok(())
    }
    /// Does this person share their card in this server? A choice for the server wins; otherwise their general choice.
    pub fn eid_shared(&self, user: &str, guild: &str) -> Result<bool> {
        if let Some(v) = self.conn().query_row("SELECT shared FROM eclipseid_share WHERE user_id = ? AND guild_id = ?", [user, guild], |r| r.get::<_, i64>(0)).optional()? { return Ok(v != 0); }
        Ok(self.conn().query_row("SELECT share_default FROM eclipseid_person WHERE user_id = ?", [user], |r| r.get::<_, i64>(0)).optional()?.unwrap_or(1) != 0)
    }
    /// Share (or stop sharing) in one server.
    pub fn eid_set_share(&self, user: &str, guild: &str, shared: bool) -> Result<()> {
        self.conn().execute("INSERT INTO eclipseid_share (user_id, guild_id, shared) VALUES (?, ?, ?) ON CONFLICT(user_id, guild_id) DO UPDATE SET shared = excluded.shared", params![user, guild, shared as i64])?;
        Ok(())
    }
    /// Share (or stop sharing) everywhere: the general choice, and every choice made for one server is cleared.
    pub fn eid_set_share_all(&self, user: &str, shared: bool) -> Result<()> {
        self.conn().execute("UPDATE eclipseid_person SET share_default = ? WHERE user_id = ?", params![shared as i64, user])?;
        self.conn().execute("DELETE FROM eclipseid_share WHERE user_id = ?", [user])?;
        Ok(())
    }
    /// Linked names: (platform, name, who may see it).
    pub fn eid_links(&self, user: &str) -> Result<Vec<(String, String, String)>> {
        let mut st = self.conn().prepare_cached("SELECT platform, value, visibility FROM eclipseid_person_link WHERE user_id = ? ORDER BY platform")?;
        let rows = st.query_map([user], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn eid_link(&self, user: &str, platform: &str, value: &str, vis: &str, now: i64) -> Result<()> {
        self.conn().execute("INSERT OR IGNORE INTO eclipseid_person (user_id, updated_at) VALUES (?, ?)", params![user, now])?;
        self.conn().execute("INSERT INTO eclipseid_person_link (user_id, platform, value, visibility, added_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, platform) DO UPDATE SET value = excluded.value, visibility = excluded.visibility, added_at = excluded.added_at", params![user, platform, value, vis, now])?;
        Ok(())
    }
    pub fn eid_unlink(&self, user: &str, platform: &str) -> Result<bool> {
        Ok(self.conn().execute("DELETE FROM eclipseid_person_link WHERE user_id = ? AND platform = ?", [user, platform])? > 0)
    }
    /// Who may see linked names: one platform, or all of them.
    pub fn eid_link_vis(&self, user: &str, platform: Option<&str>, vis: &str) -> Result<()> {
        match platform {
            Some(p) => self.conn().execute("UPDATE eclipseid_person_link SET visibility = ? WHERE user_id = ? AND platform = ?", [vis, user, p])?,
            None => self.conn().execute("UPDATE eclipseid_person_link SET visibility = ? WHERE user_id = ?", [vis, user])?,
        };
        Ok(())
    }
    /// Does this person let Good Boy pick up what they play from their Discord status? On unless they said no.
    pub fn eid_auto(&self, user: &str) -> Result<bool> {
        Ok(self.conn().query_row("SELECT enabled FROM eclipseid_auto WHERE user_id = ?", [user], |r| r.get::<_, i64>(0)).optional()?.unwrap_or(1) != 0)
    }
    /// Turns picking things up on or off for a person. Turning it off also erases what was picked up.
    pub fn eid_set_auto(&self, user: &str, on: bool) -> Result<()> {
        self.conn().execute("INSERT INTO eclipseid_auto (user_id, enabled) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled", params![user, on as i64])?;
        if !on { self.eid_forget_seen(user)?; }
        Ok(())
    }
    /// Notes that a person was seen with a game or a platform. The same thing counts at most once every ten minutes, and only
    /// the newest 40 things are kept for a person.
    pub fn eid_seen_note(&self, user: &str, kind: &str, name: &str, now: i64) -> Result<()> {
        self.conn().execute("INSERT INTO eclipseid_seen (user_id, kind, name, last_at, hits) VALUES (?, ?, ?, ?, 1)
            ON CONFLICT(user_id, kind, name) DO UPDATE SET hits = hits + CASE WHEN excluded.last_at - last_at >= 600000 THEN 1 ELSE 0 END, last_at = excluded.last_at", params![user, kind, name, now])?;
        self.conn().execute("DELETE FROM eclipseid_seen WHERE user_id = ?1 AND rowid NOT IN (SELECT rowid FROM eclipseid_seen WHERE user_id = ?1 ORDER BY last_at DESC LIMIT 40)", [user])?;
        Ok(())
    }
    /// What was picked up (games or platforms) since a time, most often first: (name, times seen, last seen).
    pub fn eid_seen_list(&self, user: &str, kind: &str, since: i64, limit: usize) -> Result<Vec<(String, i64, i64)>> {
        let mut st = self.conn().prepare_cached("SELECT name, hits, last_at FROM eclipseid_seen WHERE user_id = ? AND kind = ? AND last_at >= ? ORDER BY hits DESC, last_at DESC LIMIT ?")?;
        let rows = st.query_map(params![user, kind, since, limit as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// Erases everything picked up about a person.
    pub fn eid_forget_seen(&self, user: &str) -> Result<()> {
        self.conn().execute("DELETE FROM eclipseid_seen WHERE user_id = ?", [user])?;
        Ok(())
    }
    /// Notes that a person has shown up in a server (they used Eclipse ID there, or were seen playing).
    pub fn eid_here_note(&self, guild: &str, user: &str, now: i64) -> Result<()> {
        self.conn().execute("INSERT INTO eclipseid_here (guild_id, user_id, at) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET at = excluded.at", params![guild, user, now])?;
        Ok(())
    }
    /// The people who have shown up in a server, newest first.
    pub fn eid_here_users(&self, guild: &str, limit: usize) -> Result<Vec<String>> {
        let mut st = self.conn().prepare_cached("SELECT user_id FROM eclipseid_here WHERE guild_id = ? ORDER BY at DESC LIMIT ?")?;
        let rows = st.query_map(params![guild, limit as i64], |r| r.get(0))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// Numbers for a server's Eclipse ID page: (cards made by anyone, people who showed up here, people here with games picked up).
    pub fn eid_counts(&self, guild: &str) -> Result<(i64, i64, i64)> {
        let c = self.conn();
        let one = |sql: &str, args: &[&str]| -> Result<i64> { Ok(c.query_row(sql, rusqlite::params_from_iter(args.iter()), |r| r.get(0))?) };
        Ok((one("SELECT COUNT(*) FROM eclipseid_person WHERE bio != '' OR games != '' OR platforms != '' OR availability != '' OR region != ''", &[])?,
            one("SELECT COUNT(*) FROM eclipseid_here WHERE guild_id = ?", &[guild])?,
            one("SELECT COUNT(DISTINCT s.user_id) FROM eclipseid_seen s JOIN eclipseid_here h ON h.user_id = s.user_id WHERE h.guild_id = ?", &[guild])?))
    }
    /// Erases a person's card, linked names and sharing choices everywhere. (The old per-server copies are erased too.)
    pub fn eid_delete(&self, user: &str) -> Result<()> {
        for sql in ["DELETE FROM eclipseid_seen WHERE user_id = ?", "DELETE FROM eclipseid_auto WHERE user_id = ?", "DELETE FROM eclipseid_here WHERE user_id = ?",
                    "DELETE FROM eclipseid_person WHERE user_id = ?", "DELETE FROM eclipseid_person_link WHERE user_id = ?", "DELETE FROM eclipseid_share WHERE user_id = ?",
                    "DELETE FROM eclipseid_profile WHERE user_id = ?", "DELETE FROM eclipseid_link WHERE user_id = ?"] {
            self.conn().execute(sql, [user])?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open() -> (tempfile::TempDir, Store) {
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::create(tmp.path().join("eclipse.db")).unwrap();
        (tmp, s)
    }

    #[test]
    fn old_per_server_cards_become_one_card_that_stays_in_the_servers_it_was_made_in() {
        let (_t, s) = open();
        // a bot that only has the old version: the same person made a card in two servers, and a link in a third
        s.module_migrate("eclipseid", &MIGRATIONS[..1]).unwrap();
        let c = s.conn();
        c.execute("INSERT INTO eclipseid_profile (guild_id, user_id, bio, games, platforms, availability, region, vis, updated_at) VALUES ('g1','u1','old bio','Halo','xbox','','','{}',100)", []).unwrap();
        c.execute("INSERT INTO eclipseid_profile (guild_id, user_id, bio, games, platforms, availability, region, vis, updated_at) VALUES ('g2','u1','newest bio','Halo, Celeste','pc','evenings','UK','{}',200)", []).unwrap();
        c.execute("INSERT INTO eclipseid_link (guild_id, user_id, platform, value, visibility, added_at) VALUES ('g1','u1','steam','oldname','private',10)", []).unwrap();
        c.execute("INSERT INTO eclipseid_link (guild_id, user_id, platform, value, visibility, added_at) VALUES ('g2','u1','steam','newname','public',20)", []).unwrap();
        c.execute("INSERT INTO eclipseid_link (guild_id, user_id, platform, value, visibility, added_at) VALUES ('g3','u2','roblox','builder','private',5)", []).unwrap();
        s.module_migrate("eclipseid", MIGRATIONS).unwrap();

        let p = s.eid_profile("u1").unwrap().expect("a card");
        assert_eq!((p.bio.as_str(), p.games.as_str(), p.platforms.as_str(), p.region.as_str()), ("newest bio", "Halo, Celeste", "pc", "UK"), "the newest card wins");
        assert_eq!(s.eid_links("u1").unwrap(), vec![("steam".to_string(), "newname".to_string(), "public".to_string())], "the newest name for each platform wins");
        // shown only where it was made, not in a server that never had it
        assert!(s.eid_shared("u1", "g1").unwrap() && s.eid_shared("u1", "g2").unwrap());
        assert!(!s.eid_shared("u1", "g9").unwrap(), "a carried-over card is not suddenly shown in other servers");
        // a person who only had a link keeps it too
        assert_eq!(s.eid_links("u2").unwrap().len(), 1);
        assert!(s.eid_shared("u2", "g3").unwrap() && !s.eid_shared("u2", "g1").unwrap());
        // nothing from the old version was deleted
        let n: i64 = s.conn().query_row("SELECT COUNT(*) FROM eclipseid_profile", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
        // running it again changes nothing
        s.module_migrate("eclipseid", MIGRATIONS).unwrap();
        assert_eq!(s.eid_profile("u1").unwrap().unwrap().bio, "newest bio");
    }

    #[test]
    fn a_new_card_goes_everywhere_until_its_owner_says_otherwise_and_delete_erases_all_of_it() {
        let (_t, s) = open();
        s.module_migrate("eclipseid", MIGRATIONS).unwrap();
        assert_eq!(s.eid_profile("u1").unwrap(), None);
        s.eid_save("u1", &Profile { bio: "hi".into(), games: "Celeste".into(), ..Default::default() }, 1).unwrap();
        assert!(s.eid_shared("u1", "any").unwrap() && s.eid_shared("u1", "other").unwrap(), "a new card is shared in every server");
        s.eid_set_share("u1", "other", false).unwrap();
        assert!(s.eid_shared("u1", "any").unwrap() && !s.eid_shared("u1", "other").unwrap(), "hidden in one server only");
        s.eid_set_share_all("u1", false).unwrap();
        assert!(!s.eid_shared("u1", "any").unwrap() && !s.eid_shared("u1", "other").unwrap(), "hidden everywhere");
        s.eid_set_share("u1", "any", true).unwrap();
        assert!(s.eid_shared("u1", "any").unwrap() && !s.eid_shared("u1", "other").unwrap(), "shown in one server again");
        // linking a name before any card makes the card, and editing the card keeps the names
        s.eid_link("u2", "riot", "Name#1234", "public", 5).unwrap();
        s.eid_save("u2", &Profile { bio: "x".into(), ..Default::default() }, 6).unwrap();
        assert_eq!(s.eid_links("u2").unwrap().len(), 1);
        s.eid_delete("u1").unwrap();
        assert_eq!(s.eid_profile("u1").unwrap(), None);
        assert!(s.eid_links("u1").unwrap().is_empty());
        assert!(s.eid_profile("u2").unwrap().is_some(), "other people are not touched");
    }
}
