//! Good Boy 3's critter tables: every critter caught (with its four quality rolls) and each member's buddy and count.

use crate::{Result, Store};
use rusqlite::{params, OptionalExtension};

pub const MIGRATIONS: &[(i64, &str)] = &[(1, "
    CREATE TABLE IF NOT EXISTS critters_owned (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, species TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, xp INTEGER NOT NULL DEFAULT 0,
      iv_hp INTEGER NOT NULL, iv_atk INTEGER NOT NULL, iv_def INTEGER NOT NULL, iv_spd INTEGER NOT NULL, sparkly INTEGER NOT NULL DEFAULT 0, nickname TEXT, caught_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS critters_owned_user ON critters_owned (guild_id, user_id);
    CREATE TABLE IF NOT EXISTS critters_profile (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, buddy_id INTEGER, caught INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, user_id));
")];

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Critter {
    pub id: i64,
    pub user: String,
    pub species: String,
    pub level: i64,
    pub xp: i64,
    /// hp, atk, def, spd: 0..=31 each
    pub iv: [i64; 4],
    pub sparkly: bool,
    pub nickname: Option<String>,
}
const COLS: &str = "id, user_id, species, level, xp, iv_hp, iv_atk, iv_def, iv_spd, sparkly, nickname";
fn row(r: &rusqlite::Row) -> rusqlite::Result<Critter> {
    Ok(Critter { id: r.get(0)?, user: r.get(1)?, species: r.get(2)?, level: r.get(3)?, xp: r.get(4)?, iv: [r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?], sparkly: r.get::<_, i64>(9)? != 0, nickname: r.get(10)? })
}

impl Store {
    pub fn critter(&self, guild: &str, id: i64) -> Result<Option<Critter>> {
        Ok(self.conn().query_row(&format!("SELECT {COLS} FROM critters_owned WHERE guild_id = ? AND id = ?"), params![guild, id], row).optional()?)
    }
    /// A caught critter: its number. It becomes the member's buddy when they have none.
    pub fn critter_catch(&self, guild: &str, user: &str, c: &Critter, now: i64) -> Result<i64> {
        self.conn().execute("INSERT INTO critters_owned (guild_id, user_id, species, level, xp, iv_hp, iv_atk, iv_def, iv_spd, sparkly, caught_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)",
            params![guild, user, c.species, c.level, c.iv[0], c.iv[1], c.iv[2], c.iv[3], c.sparkly as i64, now])?;
        let id = self.conn().last_insert_rowid();
        self.conn().execute("INSERT INTO critters_profile (guild_id, user_id, buddy_id, caught) VALUES (?, ?, ?, 1) ON CONFLICT(guild_id, user_id) DO UPDATE SET caught = caught + 1, buddy_id = COALESCE(buddy_id, excluded.buddy_id)", params![guild, user, id])?;
        Ok(id)
    }
    pub fn critter_species_count(&self, guild: &str, user: &str, species: &str) -> Result<i64> {
        Ok(self.conn().query_row("SELECT COUNT(*) FROM critters_owned WHERE guild_id = ? AND user_id = ? AND species = ?", [guild, user, species], |r| r.get(0))?)
    }
    pub fn critter_buddy(&self, guild: &str, user: &str) -> Result<Option<Critter>> {
        let id: Option<i64> = self.conn().query_row("SELECT buddy_id FROM critters_profile WHERE guild_id = ? AND user_id = ?", [guild, user], |r| r.get(0)).optional()?.flatten();
        Ok(match id { Some(id) => self.critter(guild, id)?.filter(|c| c.user == user), None => None })
    }
    pub fn critter_set_buddy(&self, guild: &str, user: &str, id: i64) -> Result<()> {
        self.conn().execute("INSERT INTO critters_profile (guild_id, user_id, buddy_id) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET buddy_id = excluded.buddy_id", params![guild, user, id])?;
        Ok(())
    }
    pub fn critter_level(&self, id: i64, level: i64, xp: i64) -> Result<()> {
        self.conn().execute("UPDATE critters_owned SET level = ?, xp = ? WHERE id = ?", params![level, xp, id])?;
        Ok(())
    }
    pub fn critter_rename(&self, id: i64, name: Option<&str>) -> Result<()> {
        self.conn().execute("UPDATE critters_owned SET nickname = ? WHERE id = ?", params![name, id])?;
        Ok(())
    }
    pub fn critter_release(&self, guild: &str, user: &str, id: i64) -> Result<()> {
        self.conn().execute("DELETE FROM critters_owned WHERE id = ?", [id])?;
        self.conn().execute("UPDATE critters_profile SET buddy_id = NULL WHERE guild_id = ? AND user_id = ? AND buddy_id = ?", params![guild, user, id])?;
        Ok(())
    }
    /// Two critters change owners (and stop being anyone's buddy), all at once.
    pub fn critter_trade(&self, guild: &str, a: &Critter, b: &Critter) -> Result<()> {
        let tx = self.conn().unchecked_transaction()?;
        tx.execute("UPDATE critters_owned SET user_id = ? WHERE id = ?", params![b.user, a.id])?;
        tx.execute("UPDATE critters_owned SET user_id = ? WHERE id = ?", params![a.user, b.id])?;
        tx.execute("UPDATE critters_profile SET buddy_id = NULL WHERE guild_id = ? AND ((user_id = ? AND buddy_id = ?) OR (user_id = ? AND buddy_id = ?))", params![guild, a.user, a.id, b.user, b.id])?;
        tx.commit()?;
        Ok(())
    }
    /// A page of a member's critters (sparkly, then highest level first) and how many they have.
    pub fn critters_of(&self, guild: &str, user: &str, offset: i64, limit: i64) -> Result<(Vec<Critter>, i64)> {
        let total = self.conn().query_row("SELECT COUNT(*) FROM critters_owned WHERE guild_id = ? AND user_id = ?", [guild, user], |r| r.get(0))?;
        let mut st = self.conn().prepare_cached(&format!("SELECT {COLS} FROM critters_owned WHERE guild_id = ? AND user_id = ? ORDER BY sparkly DESC, level DESC, id ASC LIMIT ? OFFSET ?"))?;
        let rows = st.query_map(params![guild, user, limit, offset], row)?.collect::<std::result::Result<_, _>>()?;
        Ok((rows, total))
    }
    pub fn critter_kinds(&self, guild: &str, user: &str) -> Result<Vec<String>> {
        let mut st = self.conn().prepare_cached("SELECT DISTINCT species FROM critters_owned WHERE guild_id = ? AND user_id = ?")?;
        let rows = st.query_map([guild, user], |r| r.get(0))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
}
