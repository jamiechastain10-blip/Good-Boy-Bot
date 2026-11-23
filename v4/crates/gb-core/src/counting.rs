//! Counting and word chain: two channel games. The rules and the saved records are Good Boy 3's.

use crate::bot::{CommandSpec, Sub};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::store::Data;
use crate::{Action, Area, Card, CommandEvent, Db, Def, Kind, MessageEvent, Settings};
use serde_json::{json, Value};

pub const MODULE: &str = "counting";
pub static SETTINGS: &[Def] = &[
    Def { key: "oneAtATime", label: "Nobody can go twice in a row", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "reactions", label: "React ✅ to every right answer", kind: Kind::Toggle, default: Fallback::Bool(true) },
];
pub const MANAGE: Perm = Perm { key: "counting.manage", level: Level::Admin };
pub const COMMANDS: &[CommandSpec] = &[CommandSpec {
    name: "counting",
    about: "Counting and word chain channels",
    module: MODULE,
    options: &[],
    subs: &[
        Sub { name: "stats", about: "Current runs, records and top players", options: &[] },
        Sub { name: "here", about: "(Staff) Turn counting on or off in this channel", options: &[] },
        Sub { name: "words-here", about: "(Staff) Turn the word chain on or off in this channel", options: &[] },
        Sub { name: "reset", about: "(Staff) Start this channel's game again", options: &[] },
    ],
}];
const MAX_USED: usize = 3000;

/// Reads a number or a small sum (+ - * x / and brackets) from the first word. None when it is not one.
pub fn read_number(text: &str) -> Option<f64> {
    let first = text.split_whitespace().next()?;
    let src: Vec<char> = first.chars().map(|c| match c { '×' | 'x' | 'X' => '*', '÷' => '/', c => c }).collect();
    if src.is_empty() || src.len() > 40 || !src.iter().all(|c| c.is_ascii_digit() || "+-*/().".contains(*c)) || !src.iter().any(char::is_ascii_digit) {
        return None;
    }
    struct P<'a> { s: &'a [char], k: usize }
    impl P<'_> {
        fn peek(&self) -> Option<char> { self.s.get(self.k).copied() }
        fn num(&mut self) -> Option<f64> {
            let start = self.k;
            while self.peek().is_some_and(|c| c.is_ascii_digit()) { self.k += 1; }
            if self.k == start { return None; }
            if self.peek() == Some('.') && self.s.get(self.k + 1).is_some_and(|c| c.is_ascii_digit()) {
                self.k += 1;
                while self.peek().is_some_and(|c| c.is_ascii_digit()) { self.k += 1; }
            }
            self.s[start..self.k].iter().collect::<String>().parse().ok()
        }
        fn factor(&mut self, depth: u8) -> Option<f64> {
            if depth > 40 { return None; }
            match self.peek() {
                Some('-') => { self.k += 1; Some(-self.factor(depth + 1)?) }
                Some('(') => { self.k += 1; let v = self.expr(depth + 1)?; if self.peek() != Some(')') { return None; } self.k += 1; Some(v) }
                _ => self.num(),
            }
        }
        fn term(&mut self, depth: u8) -> Option<f64> {
            let mut v = self.factor(depth)?;
            while let Some(op @ ('*' | '/')) = self.peek() { self.k += 1; let r = self.factor(depth)?; v = if op == '*' { v * r } else { v / r }; }
            Some(v)
        }
        fn expr(&mut self, depth: u8) -> Option<f64> {
            let mut v = self.term(depth)?;
            while let Some(op @ ('+' | '-')) = self.peek() { self.k += 1; let r = self.term(depth)?; v = if op == '+' { v + r } else { v - r }; }
            Some(v)
        }
    }
    let mut p = P { s: &src, k: 0 };
    let v = p.expr(0)?;
    (p.k == src.len() && v.is_finite()).then(|| (v * 1e9).round() / 1e9)
}

pub enum Turn<T> {
    /// Not a move in the game (chatter): ignored.
    Skip,
    Wrong(String),
    Right(T),
}
pub fn check_count(n: i64, last: Option<&str>, user: &str, text: &str, one_at_a_time: bool) -> Turn<i64> {
    let Some(v) = read_number(text) else { return Turn::Skip };
    if one_at_a_time && last == Some(user) {
        return Turn::Wrong("you can't count twice in a row".into());
    }
    if v != (n + 1) as f64 {
        return Turn::Wrong(format!("the next number was **{}**", n + 1));
    }
    Turn::Right(n + 1)
}
pub fn check_word(word: Option<&str>, last_user: Option<&str>, used: &[String], user: &str, text: &str, one_at_a_time: bool) -> Turn<String> {
    let w = text.trim().to_lowercase();
    let len = w.chars().count();
    if !(2..=30).contains(&len) || !w.chars().all(|c| c.is_alphabetic() || c == '\'' || c == '-') {
        return Turn::Skip;
    }
    if one_at_a_time && last_user == Some(user) {
        return Turn::Wrong("you can't go twice in a row".into());
    }
    if let Some(need) = word.and_then(|p| p.chars().rfind(|c| c.is_alphabetic())) {
        if !w.starts_with(need) {
            return Turn::Wrong(format!("the word had to start with **{}**", need.to_uppercase()));
        }
    }
    if used.contains(&w) {
        return Turn::Wrong(format!("**{w}** was already used in this chain"));
    }
    Turn::Right(w)
}

fn games(d: &Data) -> serde_json::Map<String, Value> {
    d.get("channels").and_then(|v| v.as_object().cloned()).unwrap_or_default()
}
fn say(channel: &str, text: String) -> Action {
    Action::Send { channel: channel.to_string(), card: Card::new(Area::Games).line(text), ping: Vec::new(), roles: Vec::new() }
}

/// Someone deleted the latest number: Good Boy 3 says it, so the count doesn't get lost.
pub fn on_deleted(db: &Db, guild: &str, channel: &str, message: &str) -> Vec<Action> {
    let d = Data { db, guild, module: MODULE };
    if games(&d).get(channel).and_then(|v| v.as_str()) != Some("count") { return Vec::new(); }
    let Some(st) = d.get(&format!("count:{channel}")) else { return Vec::new() };
    if st["msg"].as_str() != Some(message) { return Vec::new(); }
    let n = st["n"].as_i64().unwrap_or(0);
    vec![Action::Send { channel: channel.into(), card: Card::new(Area::Games).line(format!("👀 <@{}> deleted their number (**{n}**). The next number is **{}**.", st["last"].as_str().unwrap_or(""), n + 1)), ping: Vec::new(), roles: Vec::new() }]
}
pub fn on_message(db: &Db, settings: &Settings, ev: &MessageEvent) -> Vec<Action> {
    if ev.author.bot || ev.text.is_empty() {
        return Vec::new();
    }
    let d = Data { db, guild: &ev.guild, module: MODULE };
    let ch = ev.place.channel.as_str();
    let Some(kind) = games(&d).get(ch).and_then(|k| k.as_str().map(str::to_string)) else { return Vec::new() };
    let one = settings.bool(&ev.guild, MODULE, "oneAtATime");
    let react = |emoji: &str| Action::React { channel: ch.to_string(), message: ev.id.clone(), emoji: emoji.to_string() };
    let user = ev.author.id.as_str();
    if kind == "count" {
        let key = format!("count:{ch}");
        let st = d.get(&key).unwrap_or_else(|| json!({}));
        let (n, record) = (st["n"].as_i64().unwrap_or(0), st["record"].as_i64().unwrap_or(0));
        return match check_count(n, st["last"].as_str(), user, &ev.text, one) {
            Turn::Skip => Vec::new(),
            Turn::Right(value) => {
                d.set(&key, &json!({ "n": value, "last": user, "record": record.max(value), "msg": ev.id, "lastValue": value }));
                d.add(&format!("cu:{user}"), 1);
                if settings.bool(&ev.guild, MODULE, "reactions") { vec![react(if value > record && value % 100 == 0 { "🎉" } else { "✅" })] } else { Vec::new() }
            }
            Turn::Wrong(why) => {
                d.set(&key, &json!({ "n": 0, "last": null, "record": record, "msg": null }));
                let tail = if n >= record && n > 0 { " (That was a new record!)".to_string() } else { format!(" Best: **{record}**.") };
                vec![react("❌"), say(ch, format!("💥 <@{user}> broke the count at **{n}**: {why}. Start again from **1**!{tail}"))]
            }
        };
    }
    let key = format!("chain:{ch}");
    let st = d.get(&key).unwrap_or_else(|| json!({}));
    let used: Vec<String> = st["used"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
    let record = st["record"].as_i64().unwrap_or(0);
    match check_word(st["word"].as_str(), st["lastUser"].as_str(), &used, user, &ev.text, one) {
        Turn::Skip => Vec::new(),
        Turn::Right(word) => {
            let mut used = used;
            used.push(word.clone());
            if used.len() > MAX_USED { used.drain(..used.len() - MAX_USED); }
            d.set(&key, &json!({ "word": word, "lastUser": user, "record": record.max(used.len() as i64), "used": used }));
            d.add(&format!("wu:{user}"), 1);
            if settings.bool(&ev.guild, MODULE, "reactions") { vec![react("✅")] } else { Vec::new() }
        }
        Turn::Wrong(why) => {
            d.set(&key, &json!({ "word": null, "lastUser": null, "used": [], "record": record }));
            vec![react("❌"), say(ch, format!("💥 <@{user}> broke the chain after **{}** words: {why}. New chain: any word!", used.len()))]
        }
    }
}

pub fn command(db: &Db, ev: &CommandEvent) -> Vec<Action> {
    let d = Data { db, guild: &ev.guild, module: MODULE };
    let private = |text: &str| vec![Action::Reply { card: Card::new(Area::Games).line(text).private() }];
    let ch = ev.place.channel.as_str();
    let sub = ev.sub.as_deref().unwrap_or("stats");
    if sub == "stats" {
        let lines: Vec<String> = games(&d).iter().map(|(c, kind)| {
            if kind == "count" {
                let st = d.get(&format!("count:{c}")).unwrap_or_default();
                format!("🔢 <#{c}> · now **{}** · best **{}**", st["n"].as_i64().unwrap_or(0), st["record"].as_i64().unwrap_or(0))
            } else {
                let st = d.get(&format!("chain:{c}")).unwrap_or_default();
                format!("🔤 <#{c}> · chain of **{}** · best **{}**", st["used"].as_array().map_or(0, Vec::len), st["record"].as_i64().unwrap_or(0))
            }
        }).collect();
        let top = |prefix: &str| {
            let mut rows: Vec<(String, i64)> = d.list(prefix).into_iter().map(|(k, v)| (k[prefix.len()..].to_string(), v.as_i64().unwrap_or(0))).collect();
            rows.sort_by_key(|r| std::cmp::Reverse(r.1));
            let text = rows.iter().take(5).enumerate().map(|(i, (id, n))| format!("{}. <@{id}> · {n}", i + 1)).collect::<Vec<_>>().join("\n");
            if text.is_empty() { "Nobody yet.".to_string() } else { text }
        };
        let body = if lines.is_empty() { "No game channels yet. Staff can start one with `/counting here`.".to_string() } else { lines.join("\n") };
        return vec![Action::Reply { card: Card::new(Area::Games).title("🔢 Counting and word chain").line(body).line(format!("**Top counters**\n{}", top("cu:"))).line(format!("**Top word chainers**\n{}", top("wu:"))) }];
    }
    if !perms::allowed(db, &ev.guild, &ev.member, MANAGE) {
        return private("You don't have permission for that (`counting.manage`).");
    }
    let mut all = games(&d);
    if sub == "reset" {
        let Some(kind) = all.get(ch).and_then(|k| k.as_str()) else { return private("There is no game in this channel.") };
        let count = kind == "count";
        if count {
            let mut st = d.get(&format!("count:{ch}")).unwrap_or_else(|| json!({}));
            st["n"] = json!(0); st["last"] = Value::Null; st["msg"] = Value::Null;
            d.set(&format!("count:{ch}"), &st);
        } else {
            let record = d.get(&format!("chain:{ch}")).and_then(|s| s["record"].as_i64()).unwrap_or(0);
            d.set(&format!("chain:{ch}"), &json!({ "word": null, "lastUser": null, "used": [], "record": record }));
        }
        let mut out = private("Reset.");
        out.push(say(ch, if count { "🔄 The count was reset by staff. Start from **1**!".into() } else { "🔄 The word chain was reset by staff. Any word!".into() }));
        return out;
    }
    let kind = if sub == "here" { "count" } else { "words" };
    let name = if kind == "count" { "Counting" } else { "Word chain" };
    if all.get(ch).and_then(|k| k.as_str()) == Some(kind) {
        all.remove(ch);
        d.set("channels", &Value::Object(all));
        return private(&format!("{name} is off in this channel now."));
    }
    all.insert(ch.to_string(), json!(kind));
    d.set("channels", &Value::Object(all));
    let mut out = private(&format!("✅ {name} is on here."));
    out.push(say(ch, if kind == "count" {
        "🔢 **Counting** starts here! Count up one at a time, starting from **1**. One number each, no counting twice in a row.".into()
    } else {
        "🔤 **Word chain** starts here! Each word starts with the last letter of the one before. No repeats. Any word to begin!".into()
    }));
    out
}
