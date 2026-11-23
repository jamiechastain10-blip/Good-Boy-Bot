//! The numbers under the dashboard's Home page: how many members, how many people in voice and how many messages, hour by hour
//! for two weeks. Kept for every server whether or not the statistics module is on, since it only counts and never reads.
use crate::bot::Directory;
use crate::Db;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

const HOUR: i64 = 3_600_000;
const KEEP_HOURS: i64 = 14 * 24;
const SAVE_EVERY: i64 = 5 * 60_000;

#[derive(Default)]
struct Cur {
    messages: i64,
    voice_peak: i64,
    saved_at: i64,
}
#[derive(Default)]
pub struct Pulse {
    cur: Mutex<HashMap<String, Cur>>,
}
impl Pulse {
    /// A message was sent (the text is never looked at).
    pub fn message(&self, guild: &str) {
        self.cur.lock().unwrap_or_else(|p| p.into_inner()).entry(guild.to_string()).or_default().messages += 1;
    }
    /// Writes what has been counted: at most every five minutes for each server. Also notes who is in voice right now.
    pub fn save(&self, db: &Db, dir: &Directory, now: i64) {
        let guilds = db.get().guilds().unwrap_or_default();
        let hour = now.div_euclid(HOUR);
        for g in guilds {
            let voice = dir.voice_count(&g.id) as i64;
            let (messages, peak) = {
                let mut all = self.cur.lock().unwrap_or_else(|p| p.into_inner());
                let c = all.entry(g.id.clone()).or_default();
                c.voice_peak = c.voice_peak.max(voice);
                if now - c.saved_at < SAVE_EVERY { continue; }
                let out = (c.messages, c.voice_peak);
                c.messages = 0; c.voice_peak = voice; c.saved_at = now;
                out
            };
            let _ = db.get().pulse_add(&g.id, hour, dir.members(&g.id).map(|m| m as i64), peak, messages);
        }
        if hour % 24 == 0 { let _ = db.get().pulse_prune(hour - KEEP_HOURS); }
    }
    /// Two weeks, hour by hour (as Good Boy 3's dashboard drew them): { from, hourMs, members, voice, messages }. A number is
    /// null for an hour the bot was not running.
    pub fn history(db: &Db, guild: &str, now: i64) -> Value {
        let hour = now.div_euclid(HOUR);
        let from = hour - KEEP_HOURS + 1;
        let rows = db.get().pulse_range(guild, from).unwrap_or_default();
        let mut members: Vec<Value> = vec![Value::Null; KEEP_HOURS as usize];
        let mut voice = members.clone();
        let mut messages = members.clone();
        for (h, m, v, n) in rows {
            let i = (h - from) as usize;
            if i < members.len() { members[i] = m.map(Value::from).unwrap_or(Value::Null); voice[i] = json!(v); messages[i] = json!(n); }
        }
        json!({ "from": from * HOUR, "hourMs": HOUR, "members": members, "voice": voice, "messages": messages })
    }
}
