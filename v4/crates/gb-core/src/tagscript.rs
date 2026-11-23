//! The little language custom commands can use. Everything is a {block}; blocks inside blocks work.
//! The same rules as Good Boy 3's, so commands written there give the same replies here.
//!
//!   {user} {username} {server} {channel} {membercount} {date}   the usual placeholders
//!   {args} {arg1} ... {arg9} {argcount} {uses}
//!   {random: pizza | tacos | sushi}     {number: 1-100}
//!   {if: {arg1} = yes | Great! | Oh no}   with = != contains, or just {if: {args} | something | nothing}
//!
//! What members type is data, never code: braces and bars in it are kept as plain text.

use std::collections::HashMap;

const OPEN: char = '\u{1}';
const CLOSE: char = '\u{2}';
const BAR: char = '\u{3}';

fn inert(v: &str) -> String {
    v.chars().map(|c| match c { '{' => OPEN, '}' => CLOSE, '|' => BAR, c => c }).collect()
}
fn restore(s: &str) -> String {
    s.chars().map(|c| match c { OPEN => '{', CLOSE => '}', BAR => '|', c => c }).collect()
}
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}
/// Is a condition true? "a = b", "a != b", "a contains b"; with none of those, true when there is any text.
fn test(cond: &str) -> bool {
    let chars: Vec<char> = cond.chars().collect();
    let lower: Vec<char> = cond.to_lowercase().chars().collect();
    // the first place one of the three appears
    let word = ['c', 'o', 'n', 't', 'a', 'i', 'n', 's'];
    for i in 0..chars.len() {
        let (op, len) = if chars[i] == '!' && chars.get(i + 1) == Some(&'=') {
            ("!=", 2)
        } else if chars[i] == '=' {
            ("=", 1)
        } else if lower.len() == chars.len() && lower[i..].starts_with(&word) && (i == 0 || !is_word(chars[i - 1])) && chars.get(i + 8).is_none_or(|c| !is_word(*c)) {
            ("contains", 8)
        } else {
            continue;
        };
        let a: String = chars[..i].iter().collect::<String>().trim().to_lowercase();
        let b: String = chars[i + len..].iter().collect::<String>().trim().to_lowercase();
        return match op { "=" => a == b, "!=" => a != b, _ => a.contains(&b) };
    }
    !cond.trim().is_empty()
}
/// `name : rest` with any spacing and any letter case gives `rest`.
fn after<'a>(inner: &'a str, name: &str) -> Option<&'a str> {
    let t = inner.trim_start();
    let head = t.get(..name.len())?;
    if !head.eq_ignore_ascii_case(name) { return None; }
    t[name.len()..].trim_start().strip_prefix(':')
}
fn whole(s: &str) -> Option<i64> {
    let digits = s.strip_prefix('-').unwrap_or(s);
    (!digits.is_empty() && digits.len() <= 9 && digits.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten()
}

/// Fills in a custom command's text. `roll(lo, hi)` picks a whole number between the two.
pub fn run(template: &str, vars: &HashMap<String, String>, roll: &mut dyn FnMut(i64, i64) -> i64) -> String {
    let safe: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_lowercase(), inert(v))).collect();
    let mut resolve = |inner: &str| -> Option<String> {
        let word = inner.trim().to_lowercase();
        if !word.is_empty() && word.chars().all(is_word) {
            return safe.get(&word).cloned();
        }
        if let Some(rest) = after(inner, "random") {
            let options: Vec<&str> = rest.split('|').map(str::trim).collect();
            return Some(options[roll(0, options.len() as i64 - 1).clamp(0, options.len() as i64 - 1) as usize].to_string());
        }
        if let Some(rest) = after(inner, "number") {
            // "lo-hi": the dash that separates them is the first one after the first number
            let r = rest.trim();
            let split = r.char_indices().skip(1).find(|(_, c)| *c == '-').map(|(i, _)| i)?;
            let (lo, hi) = (whole(r[..split].trim_end())?, whole(r[split + 1..].trim_start())?);
            return Some(roll(lo.min(hi), lo.max(hi)).to_string());
        }
        if let Some(rest) = after(inner, "if") {
            let mut parts = rest.split('|');
            let cond = parts.next().unwrap_or("");
            let (yes, no) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
            return Some(if test(&restore(cond)) { yes } else { no }.trim().to_string());
        }
        None // not ours: left as typed
    };
    let mut s: String = template.chars().take(4000).collect();
    for _ in 0..25 {
        let mut changed = false;
        let mut out = String::with_capacity(s.len());
        let chars: Vec<char> = s.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            // an innermost block: an opening brace with a closing one before any other brace
            if chars[i] == '{' {
                if let Some(len) = chars[i + 1..].iter().position(|c| *c == '{' || *c == '}').filter(|p| chars[i + 1 + p] == '}') {
                    let inner: String = chars[i + 1..i + 1 + len].iter().collect();
                    match resolve(&inner) {
                        Some(r) => { changed = true; out.push_str(&r); }
                        None => { out.push(OPEN); out.push_str(&inner); out.push(CLOSE); }
                    }
                    i += len + 2;
                    continue;
                }
            }
            out.push(chars[i]);
            i += 1;
        }
        s = out;
        if !changed { break; }
    }
    restore(&s)
}

/// The placeholders for what was typed after a command: {args}, {argcount}, {arg1}..{arg9}.
pub fn arg_vars(args: &str, into: &mut HashMap<String, String>) {
    let words: Vec<&str> = args.split_whitespace().collect();
    into.insert("args".into(), words.join(" "));
    into.insert("argcount".into(), words.len().to_string());
    for k in 0..9 {
        into.insert(format!("arg{}", k + 1), words.get(k).copied().unwrap_or("").to_string());
    }
}
