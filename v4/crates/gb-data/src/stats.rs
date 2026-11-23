//! Good Boy 3's activity statistics tables: counts per member per day, per channel per day, per hour and joins and
//! leaves per day. Message text is never stored, only counts. `messages_bf` are messages counted from channel history.

use crate::{Result, Store};
use rusqlite::params;

pub const MIGRATIONS: &[(i64, &str)] = &[
    (1, "
    CREATE TABLE IF NOT EXISTS stats_user_day (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, day TEXT NOT NULL,
      messages INTEGER NOT NULL DEFAULT 0, messages_bf INTEGER NOT NULL DEFAULT 0, voice_seconds INTEGER NOT NULL DEFAULT 0, reactions INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, day));
    CREATE INDEX IF NOT EXISTS stats_user_day_by_day ON stats_user_day (guild_id, day);
    CREATE TABLE IF NOT EXISTS stats_channel_day (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, day TEXT NOT NULL,
      messages INTEGER NOT NULL DEFAULT 0, messages_bf INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, channel_id, day));
    CREATE TABLE IF NOT EXISTS stats_guild_day (guild_id TEXT NOT NULL, day TEXT NOT NULL, joins INTEGER NOT NULL DEFAULT 0, leaves INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, day));
    CREATE TABLE IF NOT EXISTS stats_optout (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
    "),
    (2, "CREATE TABLE IF NOT EXISTS stats_hour (guild_id TEXT NOT NULL, hour INTEGER NOT NULL, messages INTEGER NOT NULL DEFAULT 0, messages_bf INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, hour));"),
    (100, "CREATE TABLE IF NOT EXISTS stats_pulse (guild_id TEXT NOT NULL, hour INTEGER NOT NULL, members INTEGER, voice_peak INTEGER NOT NULL DEFAULT 0, messages INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, hour));"),
];

/// One hour of the dashboard's history: (hour, members, most people in voice, messages).
pub type PulseHour = (i64, Option<i64>, i64, i64);

/// One member's totals over some days.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Sum {
    pub messages: i64,
    pub bf: i64,
    pub voice: i64,
    pub reactions: i64,
    pub days: i64,
}
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Totals {
    pub messages: i64,
    pub voice: i64,
    pub reactions: i64,
    pub people: i64,
    pub joins: i64,
    pub leaves: i64,
}
/// What the live counters collected: (user, day, messages, voice seconds, reactions), (channel, day, messages),
/// (hour, messages), (day, joins, leaves).
#[derive(Debug, Default)]
pub struct Batch {
    pub users: Vec<(String, String, i64, i64, i64)>,
    pub channels: Vec<(String, String, i64)>,
    pub hours: Vec<(i64, i64)>,
    pub days: Vec<(String, i64, i64)>,
}
/// A member with activity: when they were last active and how much.
#[derive(Debug, Clone, PartialEq)]
pub struct Activity {
    pub id: String,
    pub last: String,
    pub total: i64,
    pub recent: i64,
    pub last_month: i64,
    pub voice: i64,
}

impl Store {
    pub fn stats_flush(&self, guild: &str, b: &Batch) -> Result<()> {
        let tx = self.conn().unchecked_transaction()?;
        for (u, day, m, v, r) in &b.users {
            tx.execute("INSERT INTO stats_user_day (guild_id, user_id, day, messages, voice_seconds, reactions) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(guild_id, user_id, day) DO UPDATE SET messages = messages + excluded.messages, voice_seconds = voice_seconds + excluded.voice_seconds, reactions = reactions + excluded.reactions", params![guild, u, day, m, v, r])?;
        }
        for (c, day, m) in &b.channels {
            tx.execute("INSERT INTO stats_channel_day (guild_id, channel_id, day, messages) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, channel_id, day) DO UPDATE SET messages = messages + excluded.messages", params![guild, c, day, m])?;
        }
        for (h, m) in &b.hours {
            tx.execute("INSERT INTO stats_hour (guild_id, hour, messages) VALUES (?, ?, ?) ON CONFLICT(guild_id, hour) DO UPDATE SET messages = messages + excluded.messages", params![guild, h, m])?;
        }
        for (day, j, l) in &b.days {
            tx.execute("INSERT INTO stats_guild_day (guild_id, day, joins, leaves) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, day) DO UPDATE SET joins = joins + excluded.joins, leaves = leaves + excluded.leaves", params![guild, day, j, l])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn stats_optouts(&self, guild: &str) -> Result<Vec<String>> {
        let mut st = self.conn().prepare_cached("SELECT user_id FROM stats_optout WHERE guild_id = ?")?;
        let rows = st.query_map([guild], |r| r.get(0))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn stats_set_optout(&self, guild: &str, user: &str, out: bool, now: i64) -> Result<()> {
        if out { self.conn().execute("INSERT OR IGNORE INTO stats_optout (guild_id, user_id, at) VALUES (?, ?, ?)", params![guild, user, now])?; }
        else { self.conn().execute("DELETE FROM stats_optout WHERE guild_id = ? AND user_id = ?", [guild, user])?; }
        Ok(())
    }
    pub fn stats_forget(&self, guild: &str, user: &str) -> Result<()> {
        self.conn().execute("DELETE FROM stats_user_day WHERE guild_id = ? AND user_id = ?", [guild, user])?;
        Ok(())
    }
    pub fn stats_sum(&self, guild: &str, user: &str, from: &str, to: &str) -> Result<Sum> {
        Ok(self.conn().query_row("SELECT COALESCE(SUM(messages + messages_bf), 0), COALESCE(SUM(messages_bf), 0), COALESCE(SUM(voice_seconds), 0), COALESCE(SUM(reactions), 0),
            COUNT(DISTINCT CASE WHEN messages + messages_bf + voice_seconds + reactions > 0 THEN day END) FROM stats_user_day WHERE guild_id = ? AND user_id = ? AND day >= ? AND day < ?",
            params![guild, user, from, to], |r| Ok(Sum { messages: r.get(0)?, bf: r.get(1)?, voice: r.get(2)?, reactions: r.get(3)?, days: r.get(4)? }))?)
    }
    /// Where a message count would stand among everyone's in the period (1 = most).
    pub fn stats_rank(&self, guild: &str, from: &str, to: &str, messages: i64) -> Result<i64> {
        Ok(self.conn().query_row("SELECT COUNT(*) + 1 FROM (SELECT user_id, SUM(messages + messages_bf) AS m FROM stats_user_day WHERE guild_id = ? AND day >= ? AND day < ? GROUP BY user_id) WHERE m > ?", params![guild, from, to, messages], |r| r.get(0))?)
    }
    /// The top members for "messages", "voice" or "reactions": (user, count).
    pub fn stats_top(&self, guild: &str, metric: &str, from: &str, to: &str, limit: i64) -> Result<Vec<(String, i64)>> {
        let col = match metric { "messages" => "SUM(messages + messages_bf)", "voice" => "SUM(voice_seconds)", "reactions" => "SUM(reactions)", _ => return Ok(Vec::new()) };
        let mut st = self.conn().prepare(&format!("SELECT user_id, {col} AS n FROM stats_user_day WHERE guild_id = ? AND day >= ? AND day < ? GROUP BY user_id HAVING n > 0 ORDER BY n DESC, user_id LIMIT ?"))?;
        let rows = st.query_map(params![guild, from, to, limit], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn stats_top_channels(&self, guild: &str, from: &str, to: &str, limit: i64) -> Result<Vec<(String, i64)>> {
        let mut st = self.conn().prepare_cached("SELECT channel_id, SUM(messages + messages_bf) AS n FROM stats_channel_day WHERE guild_id = ? AND day >= ? AND day < ? GROUP BY channel_id HAVING n > 0 ORDER BY n DESC, channel_id LIMIT ?")?;
        let rows = st.query_map(params![guild, from, to, limit], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn stats_totals(&self, guild: &str, from: &str, to: &str) -> Result<Totals> {
        let (messages, voice, reactions, people) = self.conn().query_row("SELECT COALESCE(SUM(messages + messages_bf), 0), COALESCE(SUM(voice_seconds), 0), COALESCE(SUM(reactions), 0), COUNT(DISTINCT user_id) FROM stats_user_day WHERE guild_id = ? AND day >= ? AND day < ?", params![guild, from, to], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        let (joins, leaves) = self.conn().query_row("SELECT COALESCE(SUM(joins), 0), COALESCE(SUM(leaves), 0) FROM stats_guild_day WHERE guild_id = ? AND day >= ? AND day < ?", params![guild, from, to], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(Totals { messages, voice, reactions, people, joins, leaves })
    }
    /// A member's messages by month, newest first.
    pub fn stats_months(&self, guild: &str, user: &str, limit: i64) -> Result<Vec<(String, i64)>> {
        let mut st = self.conn().prepare_cached("SELECT substr(day, 1, 7) AS month, SUM(messages + messages_bf) FROM stats_user_day WHERE guild_id = ? AND user_id = ? GROUP BY month ORDER BY month DESC LIMIT ?")?;
        let rows = st.query_map(params![guild, user, limit], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn stats_last_day(&self, guild: &str, user: &str) -> Result<Option<String>> {
        Ok(self.conn().query_row("SELECT MAX(day) FROM stats_user_day WHERE guild_id = ? AND user_id = ? AND (messages + messages_bf + voice_seconds + reactions) > 0", [guild, user], |r| r.get(0))?)
    }
    /// Everyone with activity: (user, last active day, messages in all).
    pub fn stats_last_active(&self, guild: &str) -> Result<Vec<(String, String, i64)>> {
        let mut st = self.conn().prepare_cached("SELECT user_id, MAX(day), SUM(messages + messages_bf) FROM stats_user_day WHERE guild_id = ? AND (messages + messages_bf + voice_seconds + reactions) > 0 GROUP BY user_id")?;
        let rows = st.query_map([guild], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn stats_activity(&self, guild: &str, month_from: &str, last_from: &str, last_to: &str, limit: i64) -> Result<Vec<Activity>> {
        let mut st = self.conn().prepare_cached("SELECT user_id, MAX(day), SUM(messages + messages_bf), SUM(CASE WHEN day >= ?1 THEN messages + messages_bf ELSE 0 END),
            SUM(CASE WHEN day >= ?2 AND day < ?3 THEN messages + messages_bf ELSE 0 END), SUM(CASE WHEN day >= ?1 THEN voice_seconds ELSE 0 END)
            FROM stats_user_day WHERE guild_id = ?4 AND (messages + messages_bf + voice_seconds + reactions) > 0 GROUP BY user_id ORDER BY MAX(day) DESC, SUM(messages + messages_bf) DESC LIMIT ?5")?;
        let rows = st.query_map(params![month_from, last_from, last_to, guild, limit], |r| Ok(Activity { id: r.get(0)?, last: r.get(1)?, total: r.get(2)?, recent: r.get(3)?, last_month: r.get(4)?, voice: r.get(5)? }))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// Messages per day since a day (live and counted together).
    pub fn stats_per_day(&self, guild: &str, from: &str) -> Result<Vec<(String, i64)>> {
        let mut st = self.conn().prepare_cached("SELECT day, SUM(messages + messages_bf) FROM stats_user_day WHERE guild_id = ? AND day >= ? GROUP BY day")?;
        let rows = st.query_map([guild, from], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    pub fn stats_joins(&self, guild: &str, from: &str) -> Result<Vec<(String, i64, i64)>> {
        let mut st = self.conn().prepare_cached("SELECT day, joins, leaves FROM stats_guild_day WHERE guild_id = ? AND day >= ?")?;
        let rows = st.query_map([guild, from], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// The dashboard's live history: this hour's numbers are added to (messages), raised (the most people in voice) or
    /// replaced (how many members there are). `hour` counts hours since 1970.
    pub fn pulse_add(&self, guild: &str, hour: i64, members: Option<i64>, voice: i64, messages: i64) -> Result<()> {
        self.conn().execute("INSERT INTO stats_pulse (guild_id, hour, members, voice_peak, messages) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(guild_id, hour) DO UPDATE SET members = COALESCE(?3, members), voice_peak = MAX(voice_peak, ?4), messages = messages + ?5", rusqlite::params![guild, hour, members, voice, messages])?;
        Ok(())
    }
    /// Hours from `from` on: (hour, members, voice peak, messages), oldest first.
    pub fn pulse_range(&self, guild: &str, from: i64) -> Result<Vec<PulseHour>> {
        let mut st = self.conn().prepare_cached("SELECT hour, members, voice_peak, messages FROM stats_pulse WHERE guild_id = ? AND hour >= ? ORDER BY hour")?;
        let rows = st.query_map(rusqlite::params![guild, from], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// Old hours are dropped (the dashboard shows two weeks).
    pub fn pulse_prune(&self, before: i64) -> Result<()> {
        self.conn().execute("DELETE FROM stats_pulse WHERE hour < ?", [before])?;
        Ok(())
    }
    pub fn stats_hours(&self, guild: &str) -> Result<Vec<(i64, i64)>> {
        let mut st = self.conn().prepare_cached("SELECT hour, messages + messages_bf FROM stats_hour WHERE guild_id = ?")?;
        let rows = st.query_map([guild], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
    /// Counted history replaces the earlier counted history (the live counts are left alone).
    pub fn stats_set_backfill(&self, guild: &str, users: &[(String, String, i64)], channels: &[(String, String, i64)], hours: &[(i64, i64)]) -> Result<()> {
        let tx = self.conn().unchecked_transaction()?;
        tx.execute("UPDATE stats_user_day SET messages_bf = 0 WHERE guild_id = ?", [guild])?;
        tx.execute("UPDATE stats_channel_day SET messages_bf = 0 WHERE guild_id = ?", [guild])?;
        tx.execute("UPDATE stats_hour SET messages_bf = 0 WHERE guild_id = ?", [guild])?;
        for (h, n) in hours { tx.execute("INSERT INTO stats_hour (guild_id, hour, messages_bf) VALUES (?, ?, ?) ON CONFLICT(guild_id, hour) DO UPDATE SET messages_bf = excluded.messages_bf", params![guild, h, n])?; }
        for (u, day, n) in users { tx.execute("INSERT INTO stats_user_day (guild_id, user_id, day, messages_bf) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, user_id, day) DO UPDATE SET messages_bf = excluded.messages_bf", params![guild, u, day, n])?; }
        for (c, day, n) in channels { tx.execute("INSERT INTO stats_channel_day (guild_id, channel_id, day, messages_bf) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, channel_id, day) DO UPDATE SET messages_bf = excluded.messages_bf", params![guild, c, day, n])?; }
        tx.commit()?;
        Ok(())
    }
}
