//! Coins: the same wallets and ledger Good Boy 3's economy module keeps, in the same tables.

use crate::{Result, Store};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

/// The economy module's tables, exactly as Good Boy 3 creates them (its migrations 1 to 4).
pub const MIGRATIONS: &[(i64, &str)] = &[
    (1, "CREATE TABLE economy_wallets (
            guild_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, coins INTEGER NOT NULL DEFAULT 0, earned INTEGER NOT NULL DEFAULT 0,
            streak INTEGER NOT NULL DEFAULT 0, best_streak INTEGER NOT NULL DEFAULT 0, shields INTEGER NOT NULL DEFAULT 0,
            last_daily INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
          CREATE INDEX economy_wallets_rich ON economy_wallets (guild_id, coins DESC);
          CREATE TABLE economy_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, delta INTEGER NOT NULL, reason TEXT, at INTEGER NOT NULL);
          CREATE INDEX economy_ledger_user ON economy_ledger (guild_id, user_id, at);"),
    (2, "CREATE TABLE economy_shop (guild_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, emoji TEXT, price INTEGER NOT NULL, description TEXT, role_id TEXT, hours INTEGER NOT NULL DEFAULT 0,
            stock INTEGER, message TEXT, consumable INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, id));
          CREATE TABLE economy_items (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, item_id TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, user_id, item_id));
          ALTER TABLE economy_wallets ADD COLUMN bank INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE economy_wallets ADD COLUMN bank_paid_at INTEGER;
          ALTER TABLE economy_wallets ADD COLUMN last_work INTEGER NOT NULL DEFAULT 0;"),
    (3, "ALTER TABLE economy_wallets ADD COLUMN last_rob INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE economy_wallets ADD COLUMN robbed_at INTEGER NOT NULL DEFAULT 0;
          CREATE TABLE economy_pets (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, hunger INTEGER NOT NULL, happy INTEGER NOT NULL, xp INTEGER NOT NULL DEFAULT 0,
            adopted_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, fed_at INTEGER, played_at INTEGER, PRIMARY KEY (guild_id, user_id));"),
    (4, "CREATE TABLE economy_lottery (guild_id TEXT NOT NULL, week TEXT NOT NULL, user_id TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, spent INTEGER NOT NULL DEFAULT 0,
            drawn INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, week, user_id));"),
    // Good Boy 4's own tables (ids from 100, so Good Boy 3's migrations can keep counting up): the server treasury that
    // taxes and exchange fees go into, and a second currency that coins can be exchanged for. Good Boy 3 ignores them.
    (100, "CREATE TABLE economy_treasury (guild_id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0, collected INTEGER NOT NULL DEFAULT 0, paid_out INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE economy_treasury_log (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, delta INTEGER NOT NULL, kind TEXT NOT NULL, user_id TEXT, note TEXT, at INTEGER NOT NULL);
          CREATE INDEX economy_treasury_log_guild ON economy_treasury_log (guild_id, id DESC);
          CREATE TABLE economy_gems (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, gems INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, user_id));"),
];

/// The server treasury: what has been collected, what is in it, what has been paid out.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Treasury {
    pub balance: i64,
    pub collected: i64,
    pub paid_out: i64,
}
/// One line of the treasury's record.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TreasuryLine {
    pub at: i64,
    pub delta: i64,
    pub kind: String,
    pub user: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Wallet {
    pub coins: i64,
    pub earned: i64,
    pub bank: i64,
    pub streak: i64,
    pub best_streak: i64,
    pub shields: i64,
    pub last_daily: i64,
    pub last_work: i64,
}

/// Why coins could not be taken.
#[derive(Debug, PartialEq)]
pub enum Short {
    /// They only have this many.
    Only(i64),
}

impl Store {
    /// Runs a module's own table changes that have not been run yet, and records each one, the same way
    /// Good Boy 3 does. A database that 3.x already set up is left as it is.
    pub fn module_migrate(&self, module: &str, migrations: &[(i64, &str)]) -> Result<usize> {
        let mut ran = 0;
        for (id, sql) in migrations {
            let done: bool = self.conn().query_row("SELECT 1 FROM module_migrations WHERE module = ? AND id = ?", params![module, id], |_| Ok(true)).optional()?.unwrap_or(false);
            if done {
                continue;
            }
            self.batch(|s| {
                s.conn().execute_batch(sql)?;
                s.conn().execute("INSERT INTO module_migrations (module, id, applied_at) VALUES (?, ?, ?)", params![module, id, now_ms()])?;
                Ok(())
            })?;
            ran += 1;
        }
        Ok(ran)
    }

    /// A member's wallet, made with the server's starting coins the first time it is needed.
    pub fn wallet(&self, guild: &str, user: &str, name: Option<&str>, starting_coins: i64) -> Result<Wallet> {
        self.conn().execute(
            "INSERT INTO economy_wallets (guild_id, user_id, name, coins, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(guild_id, user_id) DO UPDATE SET name = COALESCE(excluded.name, economy_wallets.name)",
            params![guild, user, name, starting_coins, now_ms()],
        )?;
        Ok(self.conn().query_row(
            "SELECT coins, earned, bank, streak, best_streak, shields, last_daily, last_work FROM economy_wallets WHERE guild_id = ? AND user_id = ?",
            [guild, user],
            |r| Ok(Wallet { coins: r.get(0)?, earned: r.get(1)?, bank: r.get(2)?, streak: r.get(3)?, best_streak: r.get(4)?, shields: r.get(5)?, last_daily: r.get(6)?, last_work: r.get(7)? }),
        )?)
    }
    fn ledger(&self, guild: &str, user: &str, delta: i64, reason: &str) -> Result<()> {
        let reason: String = reason.chars().take(80).collect();
        self.conn().execute("INSERT INTO economy_ledger (guild_id, user_id, delta, reason, at) VALUES (?, ?, ?, ?, ?)", params![guild, user, delta, reason, now_ms()])?;
        Ok(())
    }
    /// Gives coins (counted as earned). Returns the new balance. The wallet must exist.
    pub fn credit(&self, guild: &str, user: &str, amount: i64, reason: &str) -> Result<i64> {
        if amount > 0 {
            self.conn().execute("UPDATE economy_wallets SET coins = coins + ?1, earned = earned + ?1 WHERE guild_id = ?2 AND user_id = ?3", params![amount, guild, user])?;
            self.ledger(guild, user, amount, reason)?;
        }
        Ok(self.conn().query_row("SELECT coins FROM economy_wallets WHERE guild_id = ? AND user_id = ?", [guild, user], |r| r.get(0))?)
    }
    /// Takes coins only if they are there, in one statement, so two quick presses can never spend the same coins twice.
    pub fn debit(&self, guild: &str, user: &str, amount: i64, reason: &str) -> Result<std::result::Result<i64, Short>> {
        let changed = self.conn().execute("UPDATE economy_wallets SET coins = coins - ?1 WHERE guild_id = ?2 AND user_id = ?3 AND coins >= ?1 AND ?1 > 0", params![amount, guild, user])?;
        let have: i64 = self.conn().query_row("SELECT coins FROM economy_wallets WHERE guild_id = ? AND user_id = ?", [guild, user], |r| r.get(0))?;
        if changed == 0 {
            return Ok(Err(Short::Only(have)));
        }
        self.ledger(guild, user, -amount, reason)?;
        Ok(Ok(have))
    }
    /// Moves coins from one member to another as one step: both happen or neither does.
    pub fn pay(&self, guild: &str, from: &str, to: &str, amount: i64, reason_out: &str, reason_in: &str) -> Result<std::result::Result<(i64, i64), Short>> {
        self.batch(|s| match s.debit(guild, from, amount, reason_out)? {
            Err(short) => Ok(Err(short)),
            Ok(left) => {
                s.conn().execute("UPDATE economy_wallets SET coins = coins + ? WHERE guild_id = ? AND user_id = ?", params![amount, guild, to])?;
                s.ledger(guild, to, amount, reason_in)?;
                let theirs: i64 = s.conn().query_row("SELECT coins FROM economy_wallets WHERE guild_id = ? AND user_id = ?", [guild, to], |r| r.get(0))?;
                Ok(Ok((left, theirs)))
            }
        })
    }
    pub fn set_daily(&self, guild: &str, user: &str, streak: i64, best_streak: i64, shields: i64, last_daily: i64) -> Result<()> {
        self.conn().execute("UPDATE economy_wallets SET streak = ?, best_streak = ?, shields = ?, last_daily = ? WHERE guild_id = ? AND user_id = ?", params![streak, best_streak, shields, last_daily, guild, user])?;
        Ok(())
    }
    pub fn set_last_work(&self, guild: &str, user: &str, at: i64) -> Result<()> {
        self.conn().execute("UPDATE economy_wallets SET last_work = ? WHERE guild_id = ? AND user_id = ?", params![at, guild, user])?;
        Ok(())
    }
    /// A member's place by coins (1 = richest), from the table's own coin order. None when they have no coins.
    pub fn coin_rank(&self, guild: &str, coins: i64) -> Result<Option<i64>> {
        if coins <= 0 {
            return Ok(None);
        }
        let ahead: i64 = self.conn().query_row("SELECT COUNT(*) FROM economy_wallets WHERE guild_id = ? AND coins > ?", params![guild, coins], |r| r.get(0))?;
        Ok(Some(ahead + 1))
    }
    /// Resets the economy: everyone's (or one member's) coins, bank, streaks, timers, history, items, pets and
    /// lottery tickets. The shop and the settings are kept. Members start again with the starting coins the next
    /// time they use the economy. Gives how many wallets were cleared.
    pub fn economy_reset(&self, guild: &str, user: Option<&str>) -> Result<usize> {
        self.batch(|s| {
            let tables = ["economy_wallets", "economy_ledger", "economy_items", "economy_pets", "economy_lottery", "economy_gems"];
            let mut cleared = 0;
            for t in tables {
                let exists: bool = s.conn().query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t], |_| Ok(true)).optional()?.unwrap_or(false);
                if !exists { continue; }
                let n = match user {
                    Some(u) => s.conn().execute(&format!("DELETE FROM {t} WHERE guild_id = ? AND user_id = ?"), params![guild, u])?,
                    None => s.conn().execute(&format!("DELETE FROM {t} WHERE guild_id = ?"), params![guild])?,
                };
                if t == "economy_wallets" { cleared = n; }
            }
            if user.is_none() && s.has("economy_treasury") {
                s.conn().execute("DELETE FROM economy_treasury WHERE guild_id = ?", [guild])?;
                s.conn().execute("DELETE FROM economy_treasury_log WHERE guild_id = ?", [guild])?;
            }
            Ok(cleared)
        })
    }
    // ---------------------------------------------------------------- treasury and the second currency
    fn has(&self, table: &str) -> bool {
        self.conn().query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [table], |_| Ok(true)).optional().ok().flatten().unwrap_or(false)
    }
    pub fn treasury(&self, guild: &str) -> Result<Treasury> {
        if !self.has("economy_treasury") { return Ok(Treasury::default()); }
        Ok(self.conn().query_row("SELECT balance, collected, paid_out FROM economy_treasury WHERE guild_id = ?", [guild], |r| Ok(Treasury { balance: r.get(0)?, collected: r.get(1)?, paid_out: r.get(2)? })).optional()?.unwrap_or_default())
    }
    /// Puts coins in the treasury (a tax, a fee or a gift) and records why. Nothing is taken from a wallet here:
    /// whoever calls this has already taken the coins.
    pub fn treasury_in(&self, guild: &str, amount: i64, kind: &str, user: Option<&str>, note: Option<&str>, now: i64) -> Result<()> {
        if amount <= 0 { return Ok(()); }
        self.conn().execute("INSERT INTO economy_treasury (guild_id, balance, collected) VALUES (?1, ?2, ?2) ON CONFLICT (guild_id) DO UPDATE SET balance = balance + ?2, collected = collected + ?2", params![guild, amount])?;
        self.conn().execute("INSERT INTO economy_treasury_log (guild_id, delta, kind, user_id, note, at) VALUES (?, ?, ?, ?, ?, ?)", params![guild, amount, kind, user, note.map(|n| n.chars().take(120).collect::<String>()), now])?;
        Ok(())
    }
    /// Takes coins out of the treasury, only if they are there, in one statement. The coins are for the caller to hand on.
    pub fn treasury_out(&self, guild: &str, amount: i64, kind: &str, user: Option<&str>, note: Option<&str>, now: i64) -> Result<std::result::Result<i64, Short>> {
        let changed = self.conn().execute("UPDATE economy_treasury SET balance = balance - ?1, paid_out = paid_out + ?1 WHERE guild_id = ?2 AND balance >= ?1 AND ?1 > 0", params![amount, guild])?;
        if changed == 0 { return Ok(Err(Short::Only(self.treasury(guild)?.balance))); }
        self.conn().execute("INSERT INTO economy_treasury_log (guild_id, delta, kind, user_id, note, at) VALUES (?, ?, ?, ?, ?, ?)", params![guild, -amount, kind, user, note.map(|n| n.chars().take(120).collect::<String>()), now])?;
        Ok(Ok(self.treasury(guild)?.balance))
    }
    /// The newest lines of the treasury's record.
    pub fn treasury_log(&self, guild: &str, limit: usize) -> Result<Vec<TreasuryLine>> {
        if !self.has("economy_treasury_log") { return Ok(Vec::new()); }
        let mut st = self.conn().prepare("SELECT at, delta, kind, user_id, note FROM economy_treasury_log WHERE guild_id = ? ORDER BY id DESC LIMIT ?")?;
        let rows = st.query_map(params![guild, limit as i64], |r| Ok(TreasuryLine { at: r.get(0)?, delta: r.get(1)?, kind: r.get(2)?, user: r.get(3)?, note: r.get(4)? }))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// Coins collected by kind (for example "tax:pay"), newest `days` days: (kind, total).
    pub fn treasury_by_kind(&self, guild: &str, since: i64) -> Result<Vec<(String, i64)>> {
        if !self.has("economy_treasury_log") { return Ok(Vec::new()); }
        let mut st = self.conn().prepare("SELECT kind, SUM(delta) FROM economy_treasury_log WHERE guild_id = ? AND at >= ? GROUP BY kind ORDER BY SUM(ABS(delta)) DESC")?;
        let rows = st.query_map(params![guild, since], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// A payment with a tax: the payer is charged `amount`, the receiver gets `amount - tax`, the treasury gets `tax`.
    /// All of it or none of it. Gives (what the payer has left, what the receiver has now).
    #[allow(clippy::too_many_arguments)]
    pub fn pay_taxed(&self, guild: &str, from: &str, to: &str, amount: i64, tax: i64, reason_out: &str, reason_in: &str, now: i64) -> Result<std::result::Result<(i64, i64), Short>> {
        let tax = tax.clamp(0, amount);
        self.batch(|s| match s.debit(guild, from, amount, reason_out)? {
            Err(short) => Ok(Err(short)),
            Ok(have) => {
                s.move_coins(guild, to, amount - tax, reason_in)?;
                s.treasury_in(guild, tax, "tax:pay", Some(from), None, now)?;
                let theirs: i64 = s.conn().query_row("SELECT coins FROM economy_wallets WHERE guild_id = ? AND user_id = ?", [guild, to], |r| r.get(0))?;
                Ok(Ok((have, theirs)))
            }
        })
    }
    /// Takes a tax or fee from a wallet and puts it in the treasury. Takes at most what is there.
    pub fn skim(&self, guild: &str, user: &str, tax: i64, kind: &str, now: i64) -> Result<i64> {
        if tax <= 0 { return Ok(0); }
        self.batch(|s| s.skim_in(guild, user, tax, kind, now))
    }
    /// The same, for use inside a step that is already all-or-nothing.
    pub fn skim_in(&self, guild: &str, user: &str, tax: i64, kind: &str, now: i64) -> Result<i64> {
        if tax <= 0 { return Ok(0); }
        let have: i64 = self.conn().query_row("SELECT coins FROM economy_wallets WHERE guild_id = ? AND user_id = ?", [guild, user], |r| r.get(0)).optional()?.unwrap_or(0);
        let take = tax.min(have);
        if take <= 0 { return Ok(0); }
        let _ = self.debit(guild, user, take, &format!("tax: {}", kind.trim_start_matches("tax:")))?;
        self.treasury_in(guild, take, kind, Some(user), None, now)?;
        Ok(take)
    }
    /// A member's second currency.
    pub fn gems(&self, guild: &str, user: &str) -> Result<i64> {
        if !self.has("economy_gems") { return Ok(0); }
        Ok(self.conn().query_row("SELECT gems FROM economy_gems WHERE guild_id = ? AND user_id = ?", [guild, user], |r| r.get(0)).optional()?.unwrap_or(0))
    }
    /// Gives (or, negative, takes) second currency, never below nothing. Gives the new balance.
    pub fn gems_add(&self, guild: &str, user: &str, n: i64) -> Result<i64> {
        self.conn().execute("INSERT INTO economy_gems (guild_id, user_id, gems) VALUES (?1, ?2, MAX(?3, 0)) ON CONFLICT (guild_id, user_id) DO UPDATE SET gems = MAX(gems + ?3, 0)", params![guild, user, n])?;
        self.gems(guild, user)
    }
    /// Coins into second currency: `coins` leave the wallet (the fee among them goes to the treasury), `gems` arrive.
    /// Gives (coins left, gems now).
    pub fn exchange_to_gems(&self, guild: &str, user: &str, coins: i64, fee: i64, gems: i64, now: i64) -> Result<std::result::Result<(i64, i64), Short>> {
        self.batch(|s| match s.debit(guild, user, coins, "exchange: coins for gems")? {
            Err(short) => Ok(Err(short)),
            Ok(have) => {
                s.treasury_in(guild, fee.clamp(0, coins), "fee:exchange", Some(user), None, now)?;
                let now_gems = s.gems_add(guild, user, gems)?;
                Ok(Ok((have, now_gems)))
            }
        })
    }
    /// Second currency into coins: `gems` leave, `coins` arrive, and `fee` coins (taken from what the exchange is worth)
    /// go to the treasury. Gives (coins now, gems left).
    pub fn exchange_to_coins(&self, guild: &str, user: &str, gems: i64, coins: i64, fee: i64, now: i64) -> Result<std::result::Result<(i64, i64), Short>> {
        self.batch(|s| {
            let have = s.gems(guild, user)?;
            if gems <= 0 || have < gems { return Ok(Err(Short::Only(have))); }
            s.gems_add(guild, user, -gems)?;
            s.move_coins(guild, user, coins, "exchange: gems for coins")?;
            s.treasury_in(guild, fee, "fee:exchange", Some(user), None, now)?;
            let c: i64 = s.conn().query_row("SELECT coins FROM economy_wallets WHERE guild_id = ? AND user_id = ?", [guild, user], |r| r.get(0))?;
            Ok(Ok((c, have - gems)))
        })
    }
    /// The richest in second currency: (user, gems).
    pub fn top_gems(&self, guild: &str, limit: usize) -> Result<Vec<(String, i64)>> {
        if !self.has("economy_gems") { return Ok(Vec::new()); }
        let mut st = self.conn().prepare("SELECT user_id, gems FROM economy_gems WHERE guild_id = ? AND gems > 0 ORDER BY gems DESC LIMIT ?")?;
        let rows = st.query_map(params![guild, limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// How many members have a wallet in a server.
    pub fn wallet_count(&self, guild: &str) -> Result<i64> {
        Ok(self.conn().query_row("SELECT COUNT(*) FROM economy_wallets WHERE guild_id = ?", [guild], |r| r.get(0))?)
    }
    /// The richest members: (user id, saved name, coins).
    pub fn top_coins(&self, guild: &str, limit: usize) -> Result<Vec<(String, Option<String>, i64)>> {
        let mut st = self.conn().prepare_cached("SELECT user_id, name, coins FROM economy_wallets WHERE guild_id = ? AND coins > 0 ORDER BY coins DESC LIMIT ?")?;
        let rows = st.query_map(params![guild, limit as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
}

/// A lottery entry: (member, tickets, coins spent).
pub type Entry = (String, i64, i64);
/// One page of a leaderboard: the rows (member, saved name, value), how many there are, and the viewer's (value, rank).
pub type BoardPage = (Vec<(String, Option<String>, i64)>, i64, Option<(i64, i64)>);
/// An item staff put in the shop (Good Boy 3's economy_shop row).
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct ShopItem {
    pub id: String,
    pub name: String,
    pub emoji: Option<String>,
    pub price: i64,
    pub description: Option<String>,
    pub role_id: Option<String>,
    pub hours: i64,
    pub stock: Option<i64>,
    pub message: Option<String>,
    pub consumable: bool,
}
/// A member's pet (economy_pets).
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct Pet {
    pub kind: String,
    pub name: String,
    pub hunger: i64,
    pub happy: i64,
    pub xp: i64,
    pub adopted_at: i64,
    pub updated_at: i64,
    pub fed_at: Option<i64>,
    pub played_at: Option<i64>,
}
/// The wallet columns Good Boy 3 added in 3.1: when interest was last paid, the last robbery, being robbed.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct WalletMore {
    pub bank_paid_at: Option<i64>,
    pub last_rob: i64,
    pub robbed_at: i64,
}

fn shop_row(r: &rusqlite::Row) -> rusqlite::Result<ShopItem> {
    Ok(ShopItem { id: r.get("id")?, name: r.get("name")?, emoji: r.get("emoji")?, price: r.get("price")?, description: r.get("description")?, role_id: r.get("role_id")?, hours: r.get("hours")?, stock: r.get("stock")?, message: r.get("message")?, consumable: r.get::<_, i64>("consumable")? != 0 })
}
fn pet_row(r: &rusqlite::Row) -> rusqlite::Result<Pet> {
    Ok(Pet { kind: r.get("kind")?, name: r.get("name")?, hunger: r.get("hunger")?, happy: r.get("happy")?, xp: r.get("xp")?, adopted_at: r.get("adopted_at")?, updated_at: r.get("updated_at")?, fed_at: r.get("fed_at")?, played_at: r.get("played_at")? })
}

impl Store {
    pub fn wallet_more(&self, guild: &str, user: &str) -> Result<WalletMore> {
        Ok(self.conn().query_row("SELECT bank_paid_at, last_rob, robbed_at FROM economy_wallets WHERE guild_id = ? AND user_id = ?", [guild, user], |r| Ok(WalletMore { bank_paid_at: r.get(0)?, last_rob: r.get(1)?, robbed_at: r.get(2)? })).optional()?.unwrap_or_default())
    }
    /// Adds (or with a negative amount takes) coins without counting them as earned: bank withdrawals, refunds, fines.
    pub fn move_coins(&self, guild: &str, user: &str, amount: i64, reason: &str) -> Result<()> {
        self.conn().execute("UPDATE economy_wallets SET coins = coins + ? WHERE guild_id = ? AND user_id = ?", params![amount, guild, user])?;
        self.ledger(guild, user, amount, reason)
    }
    /// Sets a balance (staff), with the difference in the ledger.
    pub fn set_coins(&self, guild: &str, user: &str, coins: i64, reason: &str) -> Result<()> {
        self.batch(|s| {
            let had: i64 = s.conn().query_row("SELECT coins FROM economy_wallets WHERE guild_id = ? AND user_id = ?", [guild, user], |r| r.get(0))?;
            s.conn().execute("UPDATE economy_wallets SET coins = ? WHERE guild_id = ? AND user_id = ?", params![coins, guild, user])?;
            s.ledger(guild, user, coins - had, reason)
        })
    }
    pub fn add_shield(&self, guild: &str, user: &str) -> Result<()> {
        self.conn().execute("UPDATE economy_wallets SET shields = shields + 1 WHERE guild_id = ? AND user_id = ?", params![guild, user])?;
        Ok(())
    }
    // ---------------------------------------------------------------- bank
    pub fn set_bank_paid(&self, guild: &str, user: &str, at: i64) -> Result<()> {
        self.conn().execute("UPDATE economy_wallets SET bank_paid_at = ? WHERE guild_id = ? AND user_id = ?", params![at, guild, user])?;
        Ok(())
    }
    /// Interest owed is put in the bank and the paid-until time moves on by whole days.
    pub fn pay_interest(&self, guild: &str, user: &str, coins: i64, days: i64) -> Result<()> {
        self.conn().execute("UPDATE economy_wallets SET bank = bank + ?, bank_paid_at = bank_paid_at + ? WHERE guild_id = ? AND user_id = ?", params![coins, days * 86_400_000, guild, user])?;
        Ok(())
    }
    pub fn deposit(&self, guild: &str, user: &str, amount: i64) -> Result<std::result::Result<(), Short>> {
        self.batch(|s| match s.debit(guild, user, amount, "bank deposit")? {
            Err(short) => Ok(Err(short)),
            Ok(_) => { s.conn().execute("UPDATE economy_wallets SET bank = bank + ? WHERE guild_id = ? AND user_id = ?", params![amount, guild, user])?; Ok(Ok(())) }
        })
    }
    pub fn withdraw(&self, guild: &str, user: &str, amount: i64) -> Result<bool> {
        self.batch(|s| {
            let n = s.conn().execute("UPDATE economy_wallets SET bank = bank - ?1 WHERE guild_id = ?2 AND user_id = ?3 AND bank >= ?1", params![amount, guild, user])?;
            if n == 0 { return Ok(false); }
            s.move_coins(guild, user, amount, "bank withdrawal")?;
            Ok(true)
        })
    }
    // ---------------------------------------------------------------- rob
    pub fn set_rob_times(&self, guild: &str, robber: &str, target: Option<&str>, now: i64) -> Result<()> {
        self.conn().execute("UPDATE economy_wallets SET last_rob = ? WHERE guild_id = ? AND user_id = ?", params![now, guild, robber])?;
        if let Some(t) = target { self.conn().execute("UPDATE economy_wallets SET robbed_at = ? WHERE guild_id = ? AND user_id = ?", params![now, guild, t])?; }
        Ok(())
    }
    // ---------------------------------------------------------------- shop and inventory
    pub fn shop_items(&self, guild: &str) -> Result<Vec<ShopItem>> {
        let mut st = self.conn().prepare_cached("SELECT * FROM economy_shop WHERE guild_id = ? ORDER BY price ASC, name ASC")?;
        let rows = st.query_map([guild], shop_row)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn shop_item(&self, guild: &str, id: &str) -> Result<Option<ShopItem>> {
        Ok(self.conn().query_row("SELECT * FROM economy_shop WHERE guild_id = ? AND id = ?", [guild, id], shop_row).optional()?)
    }
    /// Adds or replaces an item; true when it replaced one.
    pub fn shop_put(&self, guild: &str, it: &ShopItem) -> Result<bool> {
        let had = self.shop_item(guild, &it.id)?.is_some();
        self.conn().execute("INSERT INTO economy_shop (guild_id, id, name, emoji, price, description, role_id, hours, stock, message, consumable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(guild_id, id) DO UPDATE SET name = excluded.name, emoji = excluded.emoji, price = excluded.price, description = excluded.description, role_id = excluded.role_id,
            hours = excluded.hours, stock = excluded.stock, message = excluded.message, consumable = excluded.consumable",
            params![guild, it.id, it.name, it.emoji, it.price, it.description, it.role_id, it.hours, it.stock, it.message, it.consumable as i64, now_ms()])?;
        Ok(had)
    }
    pub fn shop_remove(&self, guild: &str, id: &str) -> Result<bool> {
        Ok(self.conn().execute("DELETE FROM economy_shop WHERE guild_id = ? AND id = ?", [guild, id])? > 0)
    }
    /// Takes one from an item's stock; false when it just sold out.
    pub fn shop_take_one(&self, guild: &str, id: &str) -> Result<bool> {
        Ok(self.conn().execute("UPDATE economy_shop SET stock = stock - 1 WHERE guild_id = ? AND id = ? AND stock > 0", [guild, id])? > 0)
    }
    /// A member's items: (item id, how many).
    pub fn items(&self, guild: &str, user: &str) -> Result<Vec<(String, i64)>> {
        let mut st = self.conn().prepare_cached("SELECT item_id, qty FROM economy_items WHERE guild_id = ? AND user_id = ? AND qty > 0")?;
        let rows = st.query_map([guild, user], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn item_add(&self, guild: &str, user: &str, item: &str) -> Result<()> {
        self.conn().execute("INSERT INTO economy_items (guild_id, user_id, item_id, qty) VALUES (?, ?, ?, 1) ON CONFLICT(guild_id, user_id, item_id) DO UPDATE SET qty = qty + 1", [guild, user, item])?;
        Ok(())
    }
    pub fn item_use(&self, guild: &str, user: &str, item: &str) -> Result<()> {
        self.conn().execute("UPDATE economy_items SET qty = qty - 1 WHERE guild_id = ? AND user_id = ? AND item_id = ?", [guild, user, item])?;
        Ok(())
    }
    // ---------------------------------------------------------------- pets
    pub fn pet(&self, guild: &str, user: &str) -> Result<Option<Pet>> {
        Ok(self.conn().query_row("SELECT * FROM economy_pets WHERE guild_id = ? AND user_id = ?", [guild, user], pet_row).optional()?)
    }
    pub fn pet_adopt(&self, guild: &str, user: &str, kind: &str, name: &str, now: i64) -> Result<()> {
        self.conn().execute("INSERT INTO economy_pets (guild_id, user_id, kind, name, hunger, happy, xp, adopted_at, updated_at) VALUES (?, ?, ?, ?, 80, 80, 0, ?, ?)", params![guild, user, kind, name, now, now])?;
        Ok(())
    }
    /// Saves a pet's care: new hunger and happiness, xp added, and (for feed or play) when.
    #[allow(clippy::too_many_arguments)]
    pub fn pet_care(&self, guild: &str, user: &str, hunger: i64, happy: i64, xp: i64, now: i64, what: Option<&str>) -> Result<()> {
        let extra = match what { Some("feed") => ", fed_at = ?5", Some("play") => ", played_at = ?5", _ => "" };
        let sql = format!("UPDATE economy_pets SET hunger = ?1, happy = ?2, xp = xp + ?3, updated_at = ?4{extra} WHERE guild_id = ?6 AND user_id = ?7");
        self.conn().execute(&sql, params![hunger, happy, xp, now, now, guild, user])?;
        Ok(())
    }
    // ---------------------------------------------------------------- lottery
    pub fn lottery_buy(&self, guild: &str, week: &str, user: &str, price: i64) -> Result<()> {
        self.conn().execute("INSERT INTO economy_lottery (guild_id, week, user_id, count, spent, drawn) VALUES (?, ?, ?, 1, ?, 0)
            ON CONFLICT(guild_id, week, user_id) DO UPDATE SET count = count + 1, spent = spent + excluded.spent", params![guild, week, user, price])?;
        Ok(())
    }
    /// (tickets, pool, the member's tickets) this week.
    pub fn lottery_week(&self, guild: &str, week: &str, user: &str) -> Result<(i64, i64, i64)> {
        let (t, p): (i64, i64) = self.conn().query_row("SELECT COALESCE(SUM(count), 0), COALESCE(SUM(spent), 0) FROM economy_lottery WHERE guild_id = ? AND week = ?", [guild, week], |r| Ok((r.get(0)?, r.get(1)?)))?;
        let mine: i64 = self.conn().query_row("SELECT count FROM economy_lottery WHERE guild_id = ? AND week = ? AND user_id = ?", [guild, week, user], |r| r.get(0)).optional()?.unwrap_or(0);
        Ok((t, p, mine))
    }
    /// Weeks before this one not drawn yet, with their entries (user, tickets, spent).
    pub fn lottery_undrawn(&self, guild: &str, before: &str) -> Result<Vec<(String, Vec<Entry>)>> {
        let weeks: Vec<String> = {
            let mut st = self.conn().prepare_cached("SELECT DISTINCT week FROM economy_lottery WHERE guild_id = ? AND week < ? AND drawn = 0 ORDER BY week")?;
            let rows = st.query_map([guild, before], |r| r.get(0))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        let mut out = Vec::new();
        for w in weeks {
            let mut st = self.conn().prepare_cached("SELECT user_id, count, spent FROM economy_lottery WHERE guild_id = ? AND week = ?")?;
            let rows = st.query_map([guild, w.as_str()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            out.push((w.clone(), rows.collect::<std::result::Result<_, _>>()?));
        }
        Ok(out)
    }
    pub fn lottery_drawn(&self, guild: &str, week: &str) -> Result<()> {
        self.conn().execute("UPDATE economy_lottery SET drawn = 1 WHERE guild_id = ? AND week = ?", [guild, week])?;
        Ok(())
    }
    /// Servers that have economy turned on with a wallet table (for the lottery draw).
    pub fn economy_guilds(&self) -> Result<Vec<String>> {
        let mut st = self.conn().prepare_cached("SELECT DISTINCT guild_id FROM economy_lottery WHERE drawn = 0")?;
        let rows = st.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn ledger_prune(&self, before: i64) -> Result<usize> {
        Ok(self.conn().execute("DELETE FROM economy_ledger WHERE at < ?", [before])?)
    }
    // ---------------------------------------------------------------- leaderboards
    /// One page of a board ("coins" or "streak") across the given servers (one server, or the opted-in ones for the
    /// global board, one line per person). Gives the rows (user, name, value), how many there are, and the viewer's
    /// (value, rank).
    /// Adds one finished game to a player's record (Good Boy 3's `games_stats` table, so an upgraded server keeps its history).
    pub fn game_record(&self, guild: &str, user: &str, game: &str, wagered: i64, returned: i64) -> Result<()> {
        self.conn().execute(
            "INSERT INTO games_stats (guild_id, user_id, game, played, won, wagered, returned) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6) \
             ON CONFLICT(guild_id, user_id, game) DO UPDATE SET played = played + 1, won = won + ?4, wagered = wagered + ?5, returned = returned + ?6",
            rusqlite::params![guild, user, game, i64::from(returned > wagered), wagered, returned],
        )?;
        Ok(())
    }
    pub fn board(&self, guilds: &[String], board: &str, offset: i64, limit: i64, viewer: &str) -> Result<BoardPage> {
        if guilds.is_empty() { return Ok((Vec::new(), 0, None)); }
        // the names come from the wallets; the game boards are Good Boy 3's (fishing and casino tables)
        let named = "LEFT JOIN economy_wallets w ON w.guild_id = x.guild_id AND w.user_id = x.user_id";
        let source = match board {
            "streak" => "SELECT guild_id, user_id, name, streak AS value FROM economy_wallets WHERE streak > 0 AND last_daily > 0".to_string(),
            "fish" => format!("SELECT x.guild_id, x.user_id, w.name, x.caught AS value FROM games_fish_profile x {named} WHERE x.caught > 0"),
            // kilograms times 100, so a whole number carries the two decimals
            "heaviest" => format!("SELECT x.guild_id, x.user_id, w.name, CAST(ROUND(x.best_weight * 100) AS INTEGER) AS value FROM games_fish_profile x {named} WHERE x.best_weight > 0"),
            "fishlevel" => format!("SELECT x.guild_id, x.user_id, w.name, x.xp AS value FROM games_fish_profile x {named} WHERE x.xp > 0"),
            "casino" => format!("SELECT x.guild_id, x.user_id, w.name, SUM(x.returned - x.wagered) AS value FROM games_stats x {named} GROUP BY x.guild_id, x.user_id HAVING SUM(x.returned - x.wagered) > 0"),
            _ => "SELECT guild_id, user_id, name, coins AS value FROM economy_wallets WHERE coins > 0".to_string(),
        };
        let source = source.as_str();
        let marks = vec!["?"; guilds.len()].join(",");
        let base = if guilds.len() > 1 { format!("SELECT user_id, MAX(name) AS name, MAX(value) AS value FROM ({source}) WHERE guild_id IN ({marks}) GROUP BY user_id") } else { format!("SELECT user_id, name, value FROM ({source}) WHERE guild_id IN ({marks})") };
        let ids: Vec<&dyn rusqlite::ToSql> = guilds.iter().map(|g| g as &dyn rusqlite::ToSql).collect();
        let total: i64 = self.conn().query_row(&format!("SELECT COUNT(*) FROM ({base})"), ids.as_slice(), |r| r.get(0))?;
        let mut with_page = ids.clone();
        with_page.push(&limit);
        with_page.push(&offset);
        let rows = {
            let mut st = self.conn().prepare(&format!("SELECT * FROM ({base}) ORDER BY value DESC, user_id ASC LIMIT ? OFFSET ?"))?;
            let r = st.query_map(with_page.as_slice(), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            r.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut with_me = ids.clone();
        with_me.push(&viewer);
        let mine: Option<i64> = self.conn().query_row(&format!("SELECT value FROM ({base}) WHERE user_id = ?"), with_me.as_slice(), |r| r.get(0)).optional()?;
        let me = match mine {
            None => None,
            Some(v) => {
                let mut above = ids.clone();
                above.push(&v);
                let n: i64 = self.conn().query_row(&format!("SELECT COUNT(*) FROM ({base}) WHERE value > ?"), above.as_slice(), |r| r.get(0))?;
                Some((v, n + 1))
            }
        };
        Ok((rows, total, me))
    }
    /// Counts one roleplay action from one member to another (Good Boy 3's roleplay_counts) and gives the new count.
    pub fn roleplay_bump(&self, guild: &str, from: &str, to: &str, action: &str) -> Result<i64> {
        self.conn().execute("INSERT INTO roleplay_counts (guild_id, from_id, to_id, action, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT (guild_id, from_id, to_id, action) DO UPDATE SET n = n + 1", [guild, from, to, action])?;
        Ok(self.conn().query_row("SELECT n FROM roleplay_counts WHERE guild_id = ? AND from_id = ? AND to_id = ? AND action = ?", [guild, from, to, action], |r| r.get(0))?)
    }
    /// Servers that show their members on the global board.
    pub fn global_board_guilds(&self) -> Result<Vec<String>> {
        let mut st = self.conn().prepare_cached("SELECT guild_id FROM module_config WHERE module = 'economy' AND key = 'globalBoard' AND value = 'true'")?;
        let rows = st.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn store() -> (tempfile::TempDir, Store) {
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::create(tmp.path().join("eclipse.db")).unwrap();
        s.module_migrate("economy", MIGRATIONS).unwrap();
        (tmp, s)
    }
    #[test]
    fn taxes_and_fees_fill_the_treasury_and_every_coin_is_accounted_for() {
        let (_t, s) = store();
        for u in ["a", "b"] { s.wallet("g", u, None, 1000).unwrap(); }
        assert_eq!(s.treasury("g").unwrap(), Treasury::default());
        // a taxed payment: the payer loses 200, the receiver gets 180, the treasury 20
        assert_eq!(s.pay_taxed("g", "a", "b", 200, 20, "pay", "pay", 1).unwrap(), Ok((800, 1180)));
        assert_eq!(s.treasury("g").unwrap(), Treasury { balance: 20, collected: 20, paid_out: 0 });
        // not enough: nothing moves, nothing is collected
        assert_eq!(s.pay_taxed("g", "a", "b", 5000, 500, "pay", "pay", 2).unwrap(), Err(Short::Only(800)));
        assert_eq!(s.treasury("g").unwrap().balance, 20);
        // a tax skimmed from a wallet takes at most what is there
        assert_eq!(s.skim("g", "a", 50, "tax:income", 3).unwrap(), 50);
        assert_eq!(s.skim("g", "nobody", 50, "tax:income", 3).unwrap(), 0);
        assert_eq!(s.wallet("g", "a", None, 0).unwrap().coins, 750);
        assert_eq!(s.treasury("g").unwrap().balance, 70);
        // paying out of the treasury: only what is there
        assert_eq!(s.treasury_out("g", 100, "grant", Some("b"), None, 4).unwrap(), Err(Short::Only(70)));
        assert_eq!(s.treasury_out("g", 30, "grant", Some("b"), Some("event prize"), 5).unwrap(), Ok(40));
        let t = s.treasury("g").unwrap();
        assert_eq!((t.balance, t.collected, t.paid_out), (40, 70, 30));
        let log = s.treasury_log("g", 10).unwrap();
        assert_eq!((log[0].delta, log[0].kind.as_str(), log[0].note.as_deref()), (-30, "grant", Some("event prize")));
        assert_eq!(s.treasury_by_kind("g", 0).unwrap().iter().find(|k| k.0 == "tax:pay").map(|k| k.1), Some(20));
        // other servers have their own
        assert_eq!(s.treasury("other").unwrap(), Treasury::default());
    }
    #[test]
    fn exchanging_coins_and_gems_keeps_the_fee_and_never_goes_below_nothing() {
        let (_t, s) = store();
        s.wallet("g", "a", None, 1000).unwrap();
        // 500 coins in: 25 of them are the fee, 4 gems arrive
        assert_eq!(s.exchange_to_gems("g", "a", 500, 25, 4, 1).unwrap(), Ok((500, 4)));
        assert_eq!(s.treasury("g").unwrap().balance, 25);
        assert_eq!(s.exchange_to_gems("g", "a", 9999, 5, 1, 2).unwrap(), Err(Short::Only(500)));
        assert_eq!(s.gems("g", "a").unwrap(), 4);
        // back again: 3 gems are worth 300, 15 of that is the fee, so the wallet gets 285 and the treasury 15
        assert_eq!(s.exchange_to_coins("g", "a", 3, 285, 15, 3).unwrap(), Ok((785, 1)));
        assert_eq!(s.treasury("g").unwrap().balance, 40);
        assert_eq!(s.exchange_to_coins("g", "a", 5, 1, 0, 4).unwrap(), Err(Short::Only(1)));
        assert_eq!(s.gems_add("g", "a", -50).unwrap(), 0);
        assert_eq!(s.gems_add("g", "b", 7).unwrap(), 7);
        assert_eq!(s.top_gems("g", 5).unwrap(), vec![("b".to_string(), 7)]);
        // a reset clears them, and the treasury only when the whole economy goes
        assert_eq!(s.economy_reset("g", Some("b")).unwrap(), 0);
        assert_eq!(s.gems("g", "b").unwrap(), 0);
        s.economy_reset("g", None).unwrap();
        assert_eq!(s.treasury("g").unwrap(), Treasury::default());
    }
}
