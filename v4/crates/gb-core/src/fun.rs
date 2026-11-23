//! Fun: the magic 8-ball, dice, shipping two members and conversation topics. One command, `/fun`.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::card::bar_text;
use crate::{Action, Area, Card, CommandEvent, Def};

pub const MODULE: &str = "fun";
pub static SETTINGS: &[Def] = &[];
pub const COMMANDS: &[CommandSpec] = &[CommandSpec {
    name: "fun",
    about: "8-ball, dice, ship and topics",
    module: MODULE,
    options: &[],
    subs: &[
        Sub { name: "8ball", about: "Ask the magic 8-ball", options: &[Opt { name: "question", about: "A yes-or-no question", takes: Takes::Text, required: true }] },
        Sub { name: "dice", about: "Roll dice", options: &[Opt { name: "count", about: "How many (1-10)", takes: Takes::Whole { min: 1, max: 10 }, required: false }, Opt { name: "sides", about: "Sides on each (2-1000, default 6)", takes: Takes::Whole { min: 2, max: 1000 }, required: false }] },
        Sub { name: "ship", about: "How well two people match", options: &[Opt { name: "a", about: "Someone", takes: Takes::Member, required: true }, Opt { name: "b", about: "Someone else (you if empty)", takes: Takes::Member, required: false }] },
        Sub { name: "topic", about: "Something to talk about", options: &[] },
    ],
}];

pub const EIGHT_BALL: &[&str] = &[
    "It is certain.", "Without a doubt.", "Yes, definitely.", "You may rely on it.", "As I see it, yes.", "Most likely.", "Outlook good.", "Yes.", "Signs point to yes.",
    "Reply hazy, try again.", "Ask again later.", "Better not tell you now.", "Cannot predict now.", "Concentrate and ask again.",
    "Don't count on it.", "My reply is no.", "My sources say no.", "Outlook not so good.", "Very doubtful.", "Woof. (That means no.)",
];
pub const TOPICS: &[&str] = &[
    "What is a skill you wish you had?", "What was the best thing that happened to you this week?", "If you could live in any fictional world, which would it be?",
    "What is your favourite comfort food?", "What game have you played the most hours of?", "What is a hobby you would like to try?", "If you had a pet dragon, what would you name it?",
    "What is the best movie you have seen this year?", "Mountains or beach?", "What song is stuck in your head right now?", "What is your go-to snack when gaming?",
    "If you could have any superpower, what would you pick?", "What is something small that always makes your day better?", "What was your favourite cartoon as a kid?",
    "Would you rather explore space or the deep ocean?", "What is the most useless talent you have?", "Cats, dogs, or something weirder?", "What would your perfect day look like?",
    "What is an underrated game everyone should try?", "If you could instantly learn a language, which one?", "What is the best gift you have ever received?", "Morning person or night owl?",
    "What is a food you could eat every day?", "If you could meet any historical figure, who would it be?", "What is your favourite season and why?", "What app do you use the most?",
    "What would you do with a free day and no responsibilities?", "What is the last thing that made you laugh out loud?", "Which emoji do you use the most?", "What is your dream holiday destination?",
];

/// A match percentage that is always the same for the same two people (the same sum as Good Boy 3).
pub fn ship_percent(a: &str, b: &str) -> u32 {
    let (x, y) = if a <= b { (a, b) } else { (b, a) };
    let mut h: u32 = 2166136261;
    for unit in format!("{x}:{y}").encode_utf16() {
        h ^= unit as u32;
        h = h.wrapping_mul(16777619);
    }
    h % 101
}
/// The first half of one name and the second half of the other.
pub fn ship_name(a: &str, b: &str) -> String {
    let (a, b): (Vec<u16>, Vec<u16>) = (a.encode_utf16().collect(), b.encode_utf16().collect());
    let joined: Vec<u16> = a[..a.len().div_ceil(2)].iter().chain(&b[b.len() / 2..]).copied().collect();
    String::from_utf16_lossy(&joined)
}
pub fn ship_verdict(p: u32) -> &'static str {
    match p {
        90.. => "A perfect match! 💞",
        70.. => "Made for each other 💕",
        50.. => "There's something there 💗",
        30.. => "Could be friends first 🤝",
        10.. => "Not looking great 😬",
        _ => "Never going to happen 💔",
    }
}
fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}

pub fn command(ev: &CommandEvent, roll: &mut dyn FnMut(i64, i64) -> i64) -> Action {
    let card = match ev.sub.as_deref() {
        Some("8ball") => {
            let q = ev.args.get("question").map(String::as_str).unwrap_or("");
            Card::new(Area::Games).title("🎱 Magic 8-ball").line(format!("**You asked**\n{}", short(q, 1000))).line(format!("**The 8-ball says**\n**{}**", EIGHT_BALL[roll(0, EIGHT_BALL.len() as i64 - 1) as usize]))
        }
        Some("dice") => {
            let num = |k: &str, d: i64, lo: i64, hi: i64| ev.args.get(k).and_then(|v| v.parse::<i64>().ok()).unwrap_or(d).clamp(lo, hi);
            let (count, sides) = (num("count", 1, 1, 10), num("sides", 6, 2, 1000));
            let rolls: Vec<i64> = (0..count).map(|_| roll(1, sides)).collect();
            let total: i64 = rolls.iter().sum();
            let shown = rolls.iter().map(|r| format!("**{r}**")).collect::<Vec<_>>().join(" + ");
            Card::new(Area::Games).line(format!("🎲 {count}d{sides}: {shown}{}", if count > 1 { format!(" = **{total}**") } else { String::new() }))
        }
        Some("ship") => {
            let Some(a) = ev.target.as_ref() else { return Action::Reply { card: Card::new(Area::Games).line("Pick someone to ship.").private() } };
            let b = ev.target2.as_ref().unwrap_or(&ev.member);
            let p = if a.id == b.id { 100 } else { ship_percent(&a.id, &b.id) };
            Card::new(Area::Games)
                .title(format!("💘 {} × {}", short(&a.name, 40), short(&b.name, 40)))
                .line(format!("Ship name: **{}**\n{} **{p}%**\n{}", short(&ship_name(&a.name, &b.name), 60), bar_text(p as i64, 100, 14), if a.id == b.id { "Self-love is important 💖" } else { ship_verdict(p) }))
        }
        _ => Card::new(Area::Games).line(format!("💬 **Topic:** {}", TOPICS[roll(0, TOPICS.len() as i64 - 1) as usize])),
    };
    Action::Reply { card }
}
