//! Basic Ghost Labs - Good Boy 4. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
//!
//! The data layer. Good Boy 4 opens the very same SQLite file Good Boy 3 wrote (`eclipse.db`), with the same
//! tables and the same JSON values, so nothing has to be converted and a server's levels, coins, tickets,
//! playlists and settings are simply there. This crate never changes a 3.x table's shape: anything v4 needs
//! on top goes in new tables whose names start with `v4_`.

pub mod achievements;
pub mod backup;
pub mod clips;
pub mod community;
pub mod critters;
pub mod eclipseid;
pub mod fishing;
pub mod economy;
pub mod family;
pub mod notify;
pub mod stats;
pub mod giveaways;
pub mod invites;
pub mod messages;
pub mod roster;
pub mod support;
mod handover;
mod levels;

pub use handover::{find_3x_data, import_3x, ImportReport};
pub use economy::{Short, Wallet, Pet, ShopItem, WalletMore, Supply};
pub use giveaways::Giveaway;
pub use levels::{level_of, Level};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The schema version Good Boy 3.1 and 3.2 write (the number of core migrations in `src/db.js`).
pub const KNOWN_3X_SCHEMA: i64 = 3;

#[derive(Debug, thiserror::Error)]
pub enum DataError {
    #[error("There is no Good Boy database at {0}.")]
    Missing(PathBuf),
    #[error("{0} is not a Good Boy database.")]
    NotGoodBoy(PathBuf),
    #[error("This database was made by a newer Good Boy (schema {found}) than this version understands ({known}). Update Good Boy first.")]
    TooNew { found: i64, known: i64 },
    #[error("The database is damaged: {0}")]
    Damaged(String),
    #[error("database error: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("file error: {0}")]
    Io(#[from] std::io::Error),
}
pub type Result<T> = std::result::Result<T, DataError>;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Guild {
    pub id: String,
    pub name: String,
    pub joined_at: Option<i64>,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ModuleState {
    pub module: String,
    pub enabled: bool,
    pub version: Option<String>,
}
/// What a database holds, in numbers (for the launcher's "your data came across" screen).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Summary {
    pub schema: i64,
    pub servers: usize,
    pub modules_on: usize,
    pub settings: i64,
    pub records: i64,
    pub tables: Vec<(String, i64)>,
}

/// Extra indexes v4 adds to its own copy of the data. They add no columns and change no table: an index only
/// makes look-ups faster. The XP one keeps each server's members in XP order.
const V4_INDEXES: &str = "
CREATE INDEX IF NOT EXISTS v4_idx_xp ON module_data (guild_id, CAST(json_extract(value, '$.xp') AS INTEGER))
  WHERE module = 'community' AND substr(key, 1, 5) = 'user:';
";
const TOP_XP: &str = "SELECT substr(key, 6), CAST(json_extract(value, '$.xp') AS INTEGER) FROM module_data
  WHERE guild_id = ?1 AND module = 'community' AND substr(key, 1, 5) = 'user:'
  ORDER BY CAST(json_extract(value, '$.xp') AS INTEGER) DESC LIMIT ?2";
const XP_AHEAD: &str = "SELECT COUNT(*) FROM module_data
  WHERE guild_id = ?1 AND module = 'community' AND substr(key, 1, 5) = 'user:' AND CAST(json_extract(value, '$.xp') AS INTEGER) > ?2";
const XP_TOTAL: &str = "SELECT COUNT(*) FROM module_data
  WHERE guild_id = ?1 AND module = 'community' AND substr(key, 1, 5) = 'user:'";

/// One open Good Boy database.
pub struct Store {
    conn: Connection,
    path: PathBuf,
}

/// LIKE treats % and _ as wildcards; keys are matched literally (the same escaping as 3.x).
fn like_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}
fn parse(text: Option<String>) -> Option<Value> {
    text.and_then(|t| serde_json::from_str(&t).ok())
}

/// The core tables, exactly as Good Boy 3 creates them (its three core migrations), for a brand-new install.
const CORE_SCHEMA: &str = "
CREATE TABLE guilds (id TEXT PRIMARY KEY, name TEXT, joined_at INTEGER);
CREATE TABLE module_state (guild_id TEXT NOT NULL, module TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, version TEXT, PRIMARY KEY (guild_id, module));
CREATE TABLE module_config (guild_id TEXT NOT NULL, module TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (guild_id, module, key));
CREATE TABLE module_data (guild_id TEXT NOT NULL, module TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (guild_id, module, key));
CREATE TABLE permissions (guild_id TEXT NOT NULL, perm_key TEXT NOT NULL, role_id TEXT NOT NULL, PRIMARY KEY (guild_id, perm_key, role_id));
CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, guild_id TEXT, module TEXT, level TEXT NOT NULL, message TEXT NOT NULL);
CREATE INDEX idx_logs_guild ON logs (guild_id, id);
CREATE TABLE notification_prefs (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, category TEXT NOT NULL, enabled INTEGER NOT NULL, updated_at INTEGER, PRIMARY KEY (guild_id, user_id, category));
CREATE TABLE module_migrations (module TEXT NOT NULL, id INTEGER NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (module, id));
CREATE TABLE stat_history (guild_id TEXT NOT NULL, hour INTEGER NOT NULL, members INTEGER, messages INTEGER NOT NULL DEFAULT 0, voice INTEGER, PRIMARY KEY (guild_id, hour));
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO schema_meta (key, value) VALUES ('version', '3');
CREATE TABLE v4_meta (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO v4_meta (key, value) VALUES ('created_by', 'v4');
";

impl Store {
    /// Makes a brand-new, empty Good Boy database (someone starting with v4, with no Good Boy 3 data).
    /// Refuses when a file is already there: existing data is never replaced.
    pub fn create(path: impl AsRef<Path>) -> Result<Store> {
        let path = path.as_ref();
        if path.exists() {
            return Err(DataError::Damaged(format!("{} already exists, so a new database was not made over it", path.display())));
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        {
            let conn = Connection::open(path)?;
            conn.execute_batch("PRAGMA journal_mode = WAL;")?;
            conn.execute_batch(&format!("BEGIN; {CORE_SCHEMA} COMMIT;"))?;
        }
        Self::open(path)
    }
    /// Opens a database to use it (the bot). The file must already be a Good Boy database.
    pub fn open(path: impl AsRef<Path>) -> Result<Store> {
        Self::open_with(path.as_ref(), OpenFlags::SQLITE_OPEN_READ_WRITE)
    }
    /// Opens a database to look at it only (checking a 3.x install before bringing it across).
    pub fn open_read_only(path: impl AsRef<Path>) -> Result<Store> {
        Self::open_with(path.as_ref(), OpenFlags::SQLITE_OPEN_READ_ONLY)
    }
    fn open_with(path: &Path, flags: OpenFlags) -> Result<Store> {
        if !path.is_file() {
            return Err(DataError::Missing(path.to_path_buf()));
        }
        let conn = Connection::open_with_flags(path, flags | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        conn.busy_timeout(std::time::Duration::from_millis(5000))?;
        let writable = flags.contains(OpenFlags::SQLITE_OPEN_READ_WRITE);
        if writable {
            // the same settings 3.x uses, so both can open the file
            conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;
        }
        let store = Store { conn, path: path.to_path_buf() };
        let has_config: bool = store
            .conn
            .query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'module_config'", [], |_| Ok(true))
            .optional()
            .map_err(|e| if e.to_string().contains("not a database") { DataError::NotGoodBoy(path.to_path_buf()) } else { DataError::Damaged(e.to_string()) })?
            .unwrap_or(false);
        if !has_config {
            return Err(DataError::NotGoodBoy(path.to_path_buf()));
        }
        let schema = store.schema_version()?;
        if schema > KNOWN_3X_SCHEMA {
            return Err(DataError::TooNew { found: schema, known: KNOWN_3X_SCHEMA });
        }
        if writable {
            store.conn.execute_batch(V4_INDEXES)?;
        }
        Ok(store)
    }
    /// Several changes as one step: all of them happen, or none do. Much faster than one at a time.
    pub fn batch<T>(&self, work: impl FnOnce(&Store) -> Result<T>) -> Result<T> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        match work(self) {
            Ok(v) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    /// The core schema version 3.x recorded (0 when it never did).
    pub fn schema_version(&self) -> Result<i64> {
        let v: Option<String> = self
            .conn
            .query_row("SELECT value FROM schema_meta WHERE key = 'version'", [], |r| r.get(0))
            .optional()
            .or_else(|e| if e.to_string().contains("no such table") { Ok(None) } else { Err(e) })?;
        Ok(v.and_then(|s| s.parse().ok()).unwrap_or(0))
    }
    /// SQLite's own check that the file is sound.
    pub fn integrity_ok(&self) -> Result<()> {
        let answer: String = self.conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if answer == "ok" { Ok(()) } else { Err(DataError::Damaged(answer)) }
    }

    /// A consistent copy of the whole database in a new file, safe to take while the bot is running.
    pub fn backup_to(&self, file: &Path) -> Result<()> {
        if file.exists() {
            return Err(DataError::Damaged(format!("{} already exists", file.display())));
        }
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut dst = Connection::open(file)?;
        let backup = rusqlite::backup::Backup::new(&self.conn, &mut dst)?;
        backup.run_to_completion(256, std::time::Duration::from_millis(2), None)?;
        Ok(())
    }

    // ---- servers and modules
    pub fn guilds(&self) -> Result<Vec<Guild>> {
        let mut st = self.conn.prepare("SELECT id, name, joined_at FROM guilds ORDER BY joined_at, id")?;
        let rows = st.query_map([], |r| Ok(Guild { id: r.get(0)?, name: r.get::<_, Option<String>>(1)?.unwrap_or_default(), joined_at: r.get(2)? }))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// Records a server the bot is in (and its current name).
    pub fn upsert_guild(&self, id: &str, name: &str) -> Result<()> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        self.conn.execute(
            "INSERT INTO guilds (id, name, joined_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name",
            params![id, name, now],
        )?;
        Ok(())
    }
    pub fn module_states(&self, guild: &str) -> Result<Vec<ModuleState>> {
        let mut st = self.conn.prepare("SELECT module, enabled, version FROM module_state WHERE guild_id = ? ORDER BY module")?;
        let rows = st.query_map([guild], |r| Ok(ModuleState { module: r.get(0)?, enabled: r.get::<_, i64>(1)? != 0, version: r.get(2)? }))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// Turns a module on or off for a server (what the dashboard's module switch does).
    pub fn set_module_enabled(&self, guild: &str, module: &str, enabled: bool) -> Result<()> {
        self.conn.execute(
            "INSERT INTO module_state (guild_id, module, enabled) VALUES (?, ?, ?)
             ON CONFLICT(guild_id, module) DO UPDATE SET enabled = excluded.enabled",
            params![guild, module, enabled as i64],
        )?;
        Ok(())
    }
    /// For a server the bot has just met: turns a module on unless the server already has a choice recorded.
    pub fn default_module(&self, guild: &str, module: &str, enabled: bool) -> Result<()> {
        self.conn.execute("INSERT OR IGNORE INTO module_state (guild_id, module, enabled) VALUES (?, ?, ?)", params![guild, module, enabled as i64])?;
        Ok(())
    }
    pub fn module_enabled(&self, guild: &str, module: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row("SELECT enabled FROM module_state WHERE guild_id = ? AND module = ?", [guild, module], |r| r.get::<_, i64>(0))
            .optional()?
            .unwrap_or(0)
            != 0)
    }

    // ---- settings (what the dashboard edits). Values are JSON, exactly as 3.x stores them.
    pub fn config_get(&self, guild: &str, module: &str, key: &str) -> Result<Option<Value>> {
        let v: Option<Option<String>> = self
            .conn
            .query_row("SELECT value FROM module_config WHERE guild_id = ? AND module = ? AND key = ?", [guild, module, key], |r| r.get(0))
            .optional()?;
        Ok(parse(v.flatten()))
    }
    pub fn config_all(&self, guild: &str, module: &str) -> Result<BTreeMap<String, Value>> {
        let mut st = self.conn.prepare("SELECT key, value FROM module_config WHERE guild_id = ? AND module = ?")?;
        let rows = st.query_map([guild, module], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))?;
        let mut out = BTreeMap::new();
        for row in rows {
            let (k, v) = row?;
            if let Some(v) = parse(v) {
                out.insert(k, v);
            }
        }
        Ok(out)
    }
    pub fn config_set(&self, guild: &str, module: &str, key: &str, value: &Value) -> Result<()> {
        self.conn.execute(
            "INSERT INTO module_config (guild_id, module, key, value) VALUES (?, ?, ?, ?)
             ON CONFLICT(guild_id, module, key) DO UPDATE SET value = excluded.value",
            params![guild, module, key, value.to_string()],
        )?;
        Ok(())
    }

    // ---- a module's own records (levels, playlists, tickets...). A module only ever addresses its own rows.
    pub fn data_get(&self, guild: &str, module: &str, key: &str) -> Result<Option<Value>> {
        let v: Option<Option<String>> = self
            .conn
            .query_row("SELECT value FROM module_data WHERE guild_id = ? AND module = ? AND key = ?", [guild, module, key], |r| r.get(0))
            .optional()?;
        Ok(parse(v.flatten()))
    }
    pub fn data_set(&self, guild: &str, module: &str, key: &str, value: &Value) -> Result<()> {
        self.conn.execute(
            "INSERT INTO module_data (guild_id, module, key, value) VALUES (?, ?, ?, ?)
             ON CONFLICT(guild_id, module, key) DO UPDATE SET value = excluded.value",
            params![guild, module, key, value.to_string()],
        )?;
        Ok(())
    }
    pub fn data_delete(&self, guild: &str, module: &str, key: &str) -> Result<()> {
        self.conn.execute("DELETE FROM module_data WHERE guild_id = ? AND module = ? AND key = ?", [guild, module, key])?;
        Ok(())
    }
    /// Every record whose key starts with `prefix`, in key order.
    pub fn data_list(&self, guild: &str, module: &str, prefix: &str, limit: usize) -> Result<Vec<(String, Value)>> {
        let mut st = self.conn.prepare(
            "SELECT key, value FROM module_data WHERE guild_id = ? AND module = ? AND key LIKE ? ESCAPE '\\' ORDER BY key LIMIT ?",
        )?;
        let pattern = format!("{}%", like_escape(prefix));
        let rows = st.query_map(params![guild, module, pattern, limit as i64], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (k, v) = row?;
            if let Some(v) = parse(v) {
                out.push((k, v));
            }
        }
        Ok(out)
    }

    // ---- who may do what
    /// One module's records whose key starts with `prefix`, in every server: (server, key, value).
    /// For things that come due by the clock (reminders, timed bans).
    pub fn data_everywhere(&self, module: &str, prefix: &str) -> Result<Vec<(String, String, Value)>> {
        let mut st = self.conn.prepare("SELECT guild_id, key, value FROM module_data WHERE module = ?1 AND substr(key, 1, ?3) = ?2 ORDER BY guild_id, key")?;
        let rows = st.query_map(params![module, prefix, prefix.len() as i64], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))?;
        Ok(rows.filter_map(|r| r.ok()).filter_map(|(g, k, v)| Some((g, k, parse(v)?))).collect())
    }
    /// Hands a permission to exactly these roles (none: the permission's own default decides again).
    pub fn set_perm_roles(&self, guild: &str, perm_key: &str, roles: &[String]) -> Result<()> {
        self.conn.execute("DELETE FROM permissions WHERE guild_id = ?1 AND perm_key = ?2", [guild, perm_key])?;
        for r in roles {
            self.conn.execute("INSERT OR IGNORE INTO permissions (guild_id, role_id, perm_key) VALUES (?1, ?2, ?3)", [guild, r.as_str(), perm_key])?;
        }
        Ok(())
    }
    pub fn perm_roles(&self, guild: &str, perm_key: &str) -> Result<Vec<String>> {
        let mut st = self.conn.prepare("SELECT role_id FROM permissions WHERE guild_id = ? AND perm_key = ? ORDER BY role_id")?;
        let rows = st.query_map([guild, perm_key], |r| r.get(0))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    // ---- everything else: tables that 3.x modules made for themselves (wallets, stats, critters...)
    pub fn tables(&self) -> Result<Vec<String>> {
        let mut st = self.conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")?;
        let rows = st.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn count(&self, table: &str) -> Result<i64> {
        if !self.tables()?.iter().any(|t| t == table) {
            return Ok(0);
        }
        // the name came from the database's own list, so it is safe to put in the statement
        Ok(self.conn.query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |r| r.get(0))?)
    }
    /// A member's coins in one server (the economy module's own table), if they have a wallet.
    pub fn coins(&self, guild: &str, user: &str) -> Result<Option<i64>> {
        if !self.tables()?.iter().any(|t| t == "economy_wallets") {
            return Ok(None);
        }
        Ok(self.conn.query_row("SELECT coins FROM economy_wallets WHERE guild_id = ? AND user_id = ?", [guild, user], |r| r.get(0)).optional()?)
    }
    /// A channel was recreated with a new id: every setting and record that pointed at the old one now points at
    /// the new one (Good Boy 3 does the same after "purge all").
    pub fn replace_channel_id(&self, guild: &str, old: &str, new: &str) -> Result<()> {
        let like = format!("%{old}%");
        self.conn.execute("UPDATE module_config SET value = REPLACE(value, ?1, ?2) WHERE guild_id = ?3 AND value LIKE ?4", params![old, new, guild, like])?;
        self.conn.execute("UPDATE module_data SET value = REPLACE(value, ?1, ?2) WHERE guild_id = ?3 AND value LIKE ?4", params![old, new, guild, like])?;
        self.conn.execute("UPDATE OR IGNORE module_data SET key = REPLACE(key, ?1, ?2) WHERE guild_id = ?3 AND key LIKE ?4", params![old, new, guild, like])?;
        Ok(())
    }
    /// A member's XP record in one server (the community module keeps it as `user:<id>`).
    pub fn xp(&self, guild: &str, user: &str) -> Result<i64> {
        Ok(self.data_get(guild, "community", &format!("user:{user}"))?.and_then(|v| v.get("xp").and_then(Value::as_i64)).unwrap_or(0))
    }

    // ---- leaderboards, built for big servers.
    // Good Boy 3 read every member's record and sorted them for each /rank and leaderboard. Here the database
    // keeps members in XP order (see V4_INDEXES), so the top 10 of 50,000 members costs about the same as the top 10 of 50.

    /// The members with the most XP in a server: (user id, xp), highest first.
    pub fn top_xp(&self, guild: &str, limit: usize) -> Result<Vec<(String, i64)>> {
        let mut st = self.conn.prepare_cached(TOP_XP)?;
        let rows = st.query_map(params![guild, limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// Every member's XP in a server, highest first, for the level spread on the dashboard.
    pub fn all_xp(&self, guild: &str) -> Result<Vec<i64>> {
        let mut st = self.conn.prepare_cached(TOP_XP)?;
        let rows = st.query_map(params![guild, i64::MAX], |r| r.get::<_, Option<i64>>(1))?;
        Ok(rows.map(|r| r.map(|x| x.unwrap_or(0))).collect::<std::result::Result<_, _>>()?)
    }
    /// A member's place on the XP board (1 = top) and how many members are on it. None when they have no record.
    pub fn xp_rank(&self, guild: &str, user: &str) -> Result<Option<(usize, usize)>> {
        if self.data_get(guild, "community", &format!("user:{user}"))?.is_none() {
            return Ok(None);
        }
        let xp = self.xp(guild, user)?;
        let ahead: i64 = self.conn.prepare_cached(XP_AHEAD)?.query_row(params![guild, xp], |r| r.get(0))?;
        let total: i64 = self.conn.prepare_cached(XP_TOTAL)?.query_row([guild], |r| r.get(0))?;
        Ok(Some((ahead as usize + 1, total as usize)))
    }
    /// How the database would run the leaderboard (for tests that prove it uses the index).
    pub fn explain_top_xp(&self) -> Result<String> {
        let mut st = self.conn.prepare(&format!("EXPLAIN QUERY PLAN {TOP_XP}"))?;
        let rows = st.query_map(params!["g", 10], |r| r.get::<_, String>(3))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?.join(" | "))
    }

    pub fn summary(&self) -> Result<Summary> {
        let tables = self.tables()?;
        let mut counts = Vec::with_capacity(tables.len());
        for t in &tables {
            counts.push((t.clone(), self.count(t)?));
        }
        let modules_on: i64 = self.conn.query_row("SELECT COUNT(*) FROM module_state WHERE enabled = 1", [], |r| r.get(0))?;
        Ok(Summary {
            schema: self.schema_version()?,
            servers: self.guilds()?.len(),
            modules_on: modules_on as usize,
            settings: self.count("module_config")?,
            records: self.count("module_data")?,
            tables: counts,
        })
    }
}
