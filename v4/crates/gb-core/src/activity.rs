//! What the bot has just seen, for the launcher's Activity page: the last couple of hundred things per server,
//! kept in memory only. Each entry says who did what and where in plain words. Nothing that was typed in a
//! message, and no secret, is ever put here.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

/// How many entries are kept for each server.
pub const KEPT: usize = 200;
/// How many member names are remembered at most (across all servers).
const NAMES_KEPT: usize = 5000;

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Entry {
    /// Counts up from 1 in each server, so a screen can ask for "everything after the last one I have".
    pub id: u64,
    /// When, in milliseconds since 1970.
    pub at: i64,
    /// "command", "mod", "member", "ticket", "level", "giveaway" or "music".
    pub kind: &'static str,
    pub text: String,
}

/// One server's recent entries: the oldest fall off the front when it is full.
#[derive(Debug)]
pub struct Ring {
    most: usize,
    last_id: u64,
    entries: VecDeque<Entry>,
}
impl Ring {
    pub fn new(most: usize) -> Ring {
        Ring { most: most.max(1), last_id: 0, entries: VecDeque::new() }
    }
    pub fn push(&mut self, kind: &'static str, text: &str, at: i64) -> u64 {
        self.last_id += 1;
        if self.entries.len() >= self.most { self.entries.pop_front(); }
        self.entries.push_back(Entry { id: self.last_id, at, kind, text: tidy(text) });
        self.last_id
    }
    /// The entries newer than `since_id`, oldest first.
    pub fn since(&self, since_id: u64) -> Vec<Entry> {
        self.entries.iter().filter(|e| e.id > since_id).cloned().collect()
    }
    pub fn last_id(&self) -> u64 {
        self.last_id
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// One line of plain text: no line breaks or control characters, no Discord markup, and not too long.
fn tidy(text: &str) -> String {
    let flat: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let flat = flat.replace("**", "").replace('`', "");
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= 200 { flat } else { format!("{}…", flat.chars().take(199).collect::<String>()) }
}

#[derive(Default)]
pub struct Activity {
    rings: Mutex<HashMap<String, Ring>>,
    /// Members' names as last seen, by (server, member id), so an entry can say a name instead of a number.
    names: Mutex<HashMap<(String, String), String>>,
}
impl Activity {
    /// Something happened in a server.
    pub fn note(&self, guild: &str, kind: &'static str, text: &str) {
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        self.rings.lock().unwrap_or_else(|p| p.into_inner()).entry(guild.to_string()).or_insert_with(|| Ring::new(KEPT)).push(kind, text, at);
    }
    /// A server's entries newer than `since_id` (oldest first), and the newest id there is.
    pub fn since(&self, guild: &str, since_id: u64) -> (Vec<Entry>, u64) {
        match self.rings.lock().unwrap_or_else(|p| p.into_inner()).get(guild) {
            Some(r) => (r.since(since_id), r.last_id()),
            None => (Vec::new(), 0),
        }
    }
    /// Remembers what a member is called.
    pub fn saw(&self, guild: &str, id: &str, name: &str) {
        if id.is_empty() || name.trim().is_empty() { return; }
        let mut names = self.names.lock().unwrap_or_else(|p| p.into_inner());
        // a full list starts over rather than growing for ever; names come back as people do things
        if names.len() >= NAMES_KEPT { names.clear(); }
        names.insert((guild.to_string(), id.to_string()), tidy(name));
    }
    /// A member's name when it has been seen.
    pub fn name(&self, guild: &str, id: &str) -> Option<String> {
        self.names.lock().unwrap_or_else(|p| p.into_inner()).get(&(guild.to_string(), id.to_string())).cloned()
    }
    /// A member's name, or "a member" when they have not been seen yet.
    pub fn name_or(&self, guild: &str, id: &str) -> String {
        self.name(guild, id).unwrap_or_else(|| "a member".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ring_keeps_only_the_newest_and_ids_keep_counting() {
        let mut r = Ring::new(3);
        assert!(r.is_empty() && r.last_id() == 0 && r.since(0).is_empty());
        for n in 1..=5 { assert_eq!(r.push("command", &format!("entry {n}"), n), n as u64); }
        assert_eq!(r.len(), 3);
        let all = r.since(0);
        assert_eq!(all.iter().map(|e| e.id).collect::<Vec<_>>(), vec![3, 4, 5], "oldest first, the first two fell off");
        assert_eq!(all[0].text, "entry 3");
        assert_eq!(r.last_id(), 5);
    }

    #[test]
    fn since_gives_only_what_is_newer() {
        let mut r = Ring::new(10);
        for n in 1..=4 { r.push("member", "x", n); }
        assert_eq!(r.since(2).iter().map(|e| e.id).collect::<Vec<_>>(), vec![3, 4]);
        assert!(r.since(4).is_empty());
        assert!(r.since(99).is_empty(), "an id from the future gives nothing");
        r.push("member", "y", 5);
        assert_eq!(r.since(4).iter().map(|e| (e.id, e.text.as_str())).collect::<Vec<_>>(), vec![(5, "y")]);
    }

    #[test]
    fn servers_are_kept_apart_and_bounded() {
        let a = Activity::default();
        for n in 0..KEPT + 50 { a.note("1", "command", &format!("n{n}")); }
        a.note("2", "mod", "other server");
        let (one, last) = a.since("1", 0);
        assert_eq!((one.len(), last), (KEPT, (KEPT + 50) as u64));
        assert_eq!(one.first().map(|e| e.id), Some(51));
        assert!(one.windows(2).all(|w| w[0].id + 1 == w[1].id && w[0].at <= w[1].at));
        let (two, last2) = a.since("2", 0);
        assert_eq!((two.len(), last2, two[0].kind), (1, 1, "mod"));
        assert_eq!(a.since("3", 0), (Vec::new(), 0));
    }

    #[test]
    fn text_is_one_plain_line_and_names_are_remembered() {
        let mut r = Ring::new(2);
        r.push("command", "**Sam**\nused `/rank`\u{7}  twice", 0);
        assert_eq!(r.since(0)[0].text, "Sam used /rank twice");
        r.push("command", &"x".repeat(500), 0);
        assert_eq!(r.since(1)[0].text.chars().count(), 200);
        let a = Activity::default();
        assert_eq!(a.name_or("1", "7"), "a member");
        a.saw("1", "7", "Sam");
        a.saw("1", "8", "  ");
        assert_eq!((a.name("1", "7").as_deref(), a.name("2", "7"), a.name("1", "8")), (Some("Sam"), None, None));
    }
}
