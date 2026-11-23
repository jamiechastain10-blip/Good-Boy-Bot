//! AutoMod's rules as plain checks: text in, a verdict out. The same rules and numbers as Good Boy 3
//! (src/automod.js), compared against it in the tests.

use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;

/// One rule. `on` and `limit` name the settings holding its switch and its number; `action` its own action.
pub struct Rule {
    pub id: &'static str,
    pub label: &'static str,
    pub on: Option<&'static str>,
    pub limit: Option<&'static str>,
    pub action: &'static str,
}
const fn rule(id: &'static str, label: &'static str, on: Option<&'static str>, limit: Option<&'static str>, action: &'static str) -> Rule {
    Rule { id, label, on, limit, action }
}
pub const RULES: &[Rule] = &[
    rule("scams", "Scam and phishing links", Some("automodScams"), None, "scamsAction"),
    rule("spam", "Spam (too many messages too fast)", Some("automodSpam"), Some("spamMaxMessages"), "spamAction"),
    rule("words", "Word filter", Some("automodWords"), None, "wordsAction"),
    rule("links", "Links and invites", Some("automodLinks"), None, "linksAction"),
    rule("mentions", "Mass mentions", None, Some("maxMentions"), "mentionsAction"),
    rule("repeat", "Repeated messages", Some("automodRepeat"), Some("repeatMax"), "repeatAction"),
    rule("caps", "Too many capital letters", Some("automodCaps"), Some("capsPercent"), "capsAction"),
    rule("emoji", "Too many emoji", Some("automodEmoji"), Some("emojiMax"), "emojiAction"),
];
pub const ACTIONS: &[&str] = &["default", "delete", "delete-warn", "delete-timeout"];
pub fn rule_by_id(id: &str) -> Option<&'static Rule> {
    RULES.iter().find(|r| r.id == id)
}
pub fn action_words(a: &str) -> &'static str {
    match a { "default" => "server default", "delete" => "delete only", "delete-warn" => "delete + warn", "delete-timeout" => "delete + timeout", _ => "delete + warn" }
}

fn id_of(x: &Value) -> String {
    x.as_str().unwrap_or("").chars().filter(|c| !"<>#@&!".contains(*c)).collect::<String>().trim().to_string()
}
/// Exemptions are lists of role and channel ids, for every rule ("all") or one rule. A channel covers a thread in
/// it, and a category covers its channels.
pub fn is_exempt(ex: &Value, rule: &str, roles: &[String], channel: &str, parent: Option<&str>, category: Option<&str>) -> bool {
    let chans: Vec<&str> = [Some(channel), parent, category].into_iter().flatten().filter(|c| !c.is_empty()).collect();
    for set in [&ex["all"], &ex[rule]] {
        if set["roles"].as_array().is_some_and(|a| a.iter().any(|r| roles.contains(&id_of(r)))) { return true; }
        if set["channels"].as_array().is_some_and(|a| a.iter().any(|c| chans.contains(&id_of(c).as_str()))) { return true; }
    }
    false
}
/// Adds or removes one id. Gives the new exemptions and whether anything changed.
pub fn edit_exempt(ex: &Value, rule: &str, kind: &str, id: &str, add: bool) -> (Value, bool) {
    let mut next = if ex.is_object() { ex.clone() } else { json!({}) };
    let mut set = next.get(rule).cloned().filter(Value::is_object).unwrap_or_else(|| json!({ "roles": [], "channels": [] }));
    for k in ["roles", "channels"] {
        if !set[k].is_array() { set[k] = json!([]); }
    }
    let mut list: Vec<String> = set[kind].as_array().unwrap().iter().map(id_of).collect();
    let had = list.iter().any(|x| x == id);
    if add && !had { list.push(id.to_string()); }
    if !add { list.retain(|x| x != id); }
    set[kind] = json!(list);
    if set["roles"].as_array().unwrap().is_empty() && set["channels"].as_array().unwrap().is_empty() {
        next.as_object_mut().unwrap().remove(rule);
    } else {
        next[rule] = set;
    }
    (next, add != had)
}

static EMOJI_CUSTOM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<a?:\w{2,32}:\d{15,25}>").unwrap());
static EMOJI_UNICODE: LazyLock<Regex> = LazyLock::new(|| Regex::new("\\p{Extended_Pictographic}(?:\u{fe0f}|\u{200d}\\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*").unwrap());
static FLAGS: LazyLock<Regex> = LazyLock::new(|| Regex::new("[\u{1F1E6}-\u{1F1FF}]{2}").unwrap());
/// How many emoji (unicode, flags and custom server emoji) a message has. A joined family counts once.
pub fn count_emoji(text: &str) -> usize {
    let custom = EMOJI_CUSTOM.find_iter(text).count();
    custom + EMOJI_UNICODE.find_iter(&EMOJI_CUSTOM.replace_all(text, "")).count() + FLAGS.find_iter(text).count()
}

static CAPS_CLEAN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)```.*?```|`[^`]*`|https?://\S+|<[@#:a][^>]*>").unwrap());
/// The share of letters that are capitals (0 to 100), ignoring mentions, links, emoji and code. Short messages are 0.
pub fn caps_ratio(text: &str, min_letters: usize) -> i64 {
    let clean = CAPS_CLEAN.replace_all(text, " ");
    let letters: Vec<char> = clean.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.len() < min_letters || letters.is_empty() { return 0; }
    let upper = letters.iter().filter(|c| { let s = c.to_string(); s != s.to_lowercase() && s == s.to_uppercase() }).count();
    ((upper as f64 / letters.len() as f64) * 100.0 + 0.5).floor() as i64
}

static PINGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[@#][^>]*>").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
/// Lower case, no pings, one space between words: so "Hello  @a" and "hello @b" count as the same message.
pub fn normalize(text: &str) -> String {
    SPACES.replace_all(&PINGS.replace_all(&text.to_lowercase(), ""), " ").trim().to_string()
}
/// A short preview of a removed message for the staff list.
pub fn snippet(text: &str, max: usize) -> String {
    let t: String = SPACES.replace_all(text, " ").trim().chars().map(|c| if c == '`' || c == '\u{200b}' { '\'' } else { c }).collect();
    if t.chars().count() > max { format!("{}…", t.chars().take(max - 1).collect::<String>()) } else { t }
}

/// A word from the list, as a whole word (not inside a longer one), ignoring case. The first one found.
pub fn banned_word(text: &str, words: &[String]) -> Option<String> {
    let lower = text.to_lowercase();
    let ok = |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric());
    let mut best: Option<(usize, String)> = None;
    for w in words.iter().map(|w| w.to_lowercase()).filter(|w| !w.is_empty()) {
        let mut from = 0;
        while let Some(at) = lower[from..].find(&w) {
            let start = from + at;
            let end = start + w.len();
            if ok(lower[..start].chars().next_back()) && ok(lower[end..].chars().next()) {
                if best.as_ref().is_none_or(|(b, _)| start < *b) {
                    // what was actually typed, as Good Boy 3 shows it
                    best = Some((start, text.get(start..end).unwrap_or(&w).to_string()));
                }
                break;
            }
            from = start + lower[start..].chars().next().map_or(1, char::len_utf8);
        }
    }
    best.map(|(_, w)| w)
}

static LINKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:https?://|www\.)([^\s/?#<>]+)").unwrap());
static INVITE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:discord\.gg|discord(?:app)?\.com/invite)/\w+").unwrap());
static TRAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[:.]+$").unwrap());
static PORT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r":\d+$").unwrap());
/// The site names linked in a message, lower case.
pub fn link_hosts(text: &str) -> Vec<String> {
    LINKS.captures_iter(text).map(|c| {
        let h = c[1].to_lowercase();
        let h = h.strip_prefix("www.").unwrap_or(&h).to_string();
        PORT.replace(&TRAIL.replace(&h, ""), "").to_string()
    }).collect()
}
pub fn domain_allowed(host: &str, allowed: &[String]) -> bool {
    let host = host.to_lowercase();
    allowed.iter().any(|a| { let a = a.to_lowercase(); let a = a.strip_prefix("www.").unwrap_or(&a); host == a || host.ends_with(&format!(".{a}")) })
}
/// The first linked site that is not allowed, or "a server invite".
pub fn blocked_link(text: &str, allowed: &[String]) -> Option<String> {
    if let Some(bad) = LINKS.captures_iter(text).map(|c| c[1].to_string()).find(|d| !domain_allowed(d, allowed)) {
        return Some(bad);
    }
    (INVITE.is_match(text) && !domain_allowed("discord.gg", allowed)).then(|| "a server invite".to_string())
}

const OFFICIAL: &[&str] = &["discord.com", "discord.gg", "discordapp.com", "discordapp.net", "discord.media", "discord.gift", "discord.new", "discordstatus.com", "discord.dev", "dis.gd", "discordmerch.com",
    "steamcommunity.com", "steampowered.com", "steamstatic.com", "steamdeck.com", "steamgames.com"];
const TARGETS: &[&str] = &["discord", "discordapp", "discordgift", "discordnitro", "steamcommunity", "steampowered"];
static BAIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(free\s*nitro|nitro\s*(for\s*)?free|gift(ed)?\s*(you\s*)?(a\s*)?nitro|nitro\s*(gift|giveaway|generator)|steam\s*(gift|giveaway|wallet\s*code)|free\s*(cs2?|csgo)\s*skins?|claim\s+(your|the|a)\s+(free\s+)?(gift|reward|nitro|prize)|crypto\s*airdrop|airdrop\s*(is\s*)?live|i('|\s*a)?m\s*leaving\s*(cs|csgo|cs2|steam).{0,40}(skins|inventory))").unwrap());
fn official(host: &str) -> bool {
    OFFICIAL.iter().any(|d| host == *d || host.ends_with(&format!(".{d}")))
}
fn distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut prev = row[0];
        row[0] = i;
        for j in 1..=b.len() {
            let keep = row[j];
            row[j] = (row[j] + 1).min(row[j - 1] + 1).min(prev + usize::from(a[i - 1] != b[j - 1]));
            prev = keep;
        }
    }
    row[b.len()]
}
/// Does this site pretend to be Discord or Steam?
pub fn fake_site(host: &str) -> bool {
    let host = host.to_lowercase();
    if host.is_empty() || official(&host) { return false; }
    // undo the usual swaps (1 for l, 0 for o, rn for m...) and drop dashes, then compare every label and all of them joined
    let plain = |x: &str| x.replace("rn", "m").chars().filter_map(|c| match c { '1' | '|' | '!' => Some('l'), '0' => Some('o'), '3' => Some('e'), '5' => Some('s'), '-' | '_' => None, c => Some(c) }).collect::<String>();
    let parts: Vec<&str> = host.split('.').collect();
    let names = &parts[..parts.len().saturating_sub(1)];
    let mut labels: Vec<String> = names.iter().map(|l| plain(l)).collect();
    labels.push(plain(&names.concat()));
    labels.iter().any(|l| {
        TARGETS.iter().any(|t| l.contains(t)) || (l.chars().count() >= 6 && TARGETS.iter().any(|t| (l.chars().count() as i64 - t.len() as i64).abs() <= 2 && distance(l, t) <= 2))
    })
}
/// Why a message looks like a scam, or None.
pub fn scam_reason(text: &str) -> Option<String> {
    let hosts = link_hosts(text);
    if let Some(fake) = hosts.iter().find(|h| fake_site(h)) {
        let steam = fake.contains("stea") || fake.contains("st3a");
        return Some(format!("a fake site pretending to be {} ({fake})", if steam { "Steam" } else { "Discord" }));
    }
    (hosts.iter().any(|h| !official(h)) && BAIT.is_match(text)).then(|| "a \"free Nitro/gift\" scam link".to_string())
}
