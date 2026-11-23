//! Alt detection, in the spirit of Alt Detect: when someone joins, they are compared with the members who were
//! banned (or kicked) from this server. Matching profile picture, a name that is the same apart from digits and
//! symbols, and a brand new account add up to a score; past the threshold staff are told what matched.
//! Nothing is guaranteed: it says "looks like", never "is", and by default it only tells staff.

use crate::bot::{CommandSpec, Opt, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::{Action, Area, Card, CommandEvent, Db, Def, Kind, Member, Settings};

pub const MODULE: &str = "altwatch";
pub const MANAGE: Perm = Perm { key: "altwatch.manage", level: Level::Moderator(None) };
const DAY: i64 = 86_400_000;

pub static SETTINGS: &[Def] = &[
    Def { key: "enabled", label: "Alt detection on", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "channel", label: "Channel staff are told in", kind: Kind::Channel, default: Fallback::None },
    Def { key: "threshold", label: "Tell staff at this score (60 = a matching profile picture alone)", kind: Kind::Number { min: 30, max: 150 }, default: Fallback::Int(60) },
    Def { key: "includeKicks", label: "Compare with kicked members too (not only banned)", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "action", label: "What to do besides telling staff", kind: Kind::Select(&["alert", "timeout", "kick"]), default: Fallback::Str("alert") },
    Def { key: "youngDays", label: "An account younger than this many days adds to the score", kind: Kind::Number { min: 1, max: 90 }, default: Fallback::Int(7) },
];
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "altcheck", about: "See whether a member looks like someone who was banned", module: MODULE, options: &[
    Opt { name: "member", about: "Who to check", takes: Takes::Member, required: true },
], subs: &[] }];

/// The picture's identity in an avatar address: Discord's file name for it.
pub fn avatar_hash(url: &str) -> Option<String> {
    let tail = url.split('?').next()?.rsplit('/').next()?;
    let hash = tail.rsplit_once('.').map(|(h, _)| h).unwrap_or(tail);
    (hash.len() >= 8 && hash.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')).then(|| hash.to_string())
}
/// A name with the things alts change removed: case, symbols, spaces and numbers on the end.
pub fn plain_name(name: &str) -> String {
    let s: String = name.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect();
    s.trim_end_matches(|c: char| c.is_ascii_digit()).to_string()
}
fn distance(a: &[char], b: &[char]) -> usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() { cur.push((prev[j] + usize::from(ca != cb)).min(prev[j + 1] + 1).min(cur[j] + 1)); }
        prev = cur;
    }
    prev[b.len()]
}
/// 0 to 100: how alike two names are once plain.
pub fn name_likeness(a: &str, b: &str) -> u32 {
    let (a, b) = (plain_name(a), plain_name(b));
    if a.chars().count() < 4 || b.chars().count() < 4 { return 0; }
    if a == b { return 100; }
    let (x, y): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let most = x.len().max(y.len());
    (100 - distance(&x, &y) * 100 / most) as u32
}
/// One earlier member and why a newcomer looks like them.
#[derive(Debug, Clone, PartialEq)]
pub struct Match {
    pub user: String,
    pub name: String,
    pub how: String,
    pub left_at: i64,
    pub score: i64,
    pub reasons: Vec<String>,
}
/// How much `newcomer` looks like one earlier member. `created`: when the newcomer's account was made.
pub fn compare(newcomer: &Member, created: i64, now: i64, young_days: i64, old: &gb_data::roster::Left) -> Match {
    let mut score = 0;
    let mut reasons = Vec::new();
    let (a, b) = (newcomer.avatar.as_deref().and_then(avatar_hash), old.avatar.as_deref().and_then(avatar_hash));
    if a.is_some() && a == b { score += 60; reasons.push("the same profile picture".to_string()); }
    match name_likeness(&newcomer.name, &old.name) {
        100 => { score += 50; reasons.push("the same name (apart from symbols or numbers)".into()); }
        n if n >= 80 => { score += 35; reasons.push(format!("a very similar name ({n}% alike)")); }
        _ => {}
    }
    // a new account only counts when something else matches too
    if score > 0 && now - created < young_days * DAY { score += 15; reasons.push("an account made very recently".into()); }
    Match { user: old.user.clone(), name: old.name.clone(), how: old.how.clone(), left_at: old.left_at, score, reasons }
}

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::Moderation).line(text).private() }]
}
pub struct AltWatch<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub guild: &'a str,
}
impl AltWatch<'_> {
    fn matches(&self, who: &Member, now: i64) -> Vec<Match> {
        let kicks = self.settings.bool(self.guild, MODULE, "includeKicks");
        let young = self.settings.int(self.guild, MODULE, "youngDays");
        let created = crate::ticketrules::account_created(&who.id).unwrap_or(now);
        let mut found: Vec<Match> = self.db.get().roster_leaves(self.guild, 0, "", 1000).unwrap_or_default().iter()
            .filter(|l| l.user != who.id && (l.how == "banned" || (kicks && l.how == "kicked")))
            .map(|l| compare(who, created, now, young, l)).filter(|m| m.score > 0).collect();
        found.sort_by_key(|m| std::cmp::Reverse(m.score));
        found.dedup_by(|a, b| a.user == b.user);
        found
    }
    fn evidence(who: &Member, found: &[Match], threshold: i64) -> Card {
        let mut card = Card::new(Area::Moderation).title("🕵️ Possible alt account").line(format!("<@{}> looks like a member who was removed from this server.", who.id));
        for m in found.iter().take(3) {
            card = card.line(format!("**{}** ({}, <@{}>) · {} · score **{}** of {threshold}\n{}", m.name, m.how, m.user, if m.left_at > 0 { format!("gone <t:{}:R>", m.left_at / 1000) } else { "gone".into() }, m.score, m.reasons.iter().map(|r| format!("• {r}")).collect::<Vec<_>>().join("\n")));
        }
        card.line("-# This is a guess from what is public, not proof. Look before you act.")
    }
    /// Someone joined: staff are told when they look like a banned member.
    pub fn joined(&self, who: &Member, now: i64) -> Vec<Action> {
        if !self.settings.bool(self.guild, MODULE, "enabled") || who.bot { return Vec::new(); }
        let threshold = self.settings.int(self.guild, MODULE, "threshold");
        let found = self.matches(who, now);
        let Some(best) = found.first().filter(|m| m.score >= threshold) else { return Vec::new() };
        let mut out = Vec::new();
        if let Some(channel) = self.settings.text(self.guild, MODULE, "channel").filter(|c| !c.is_empty()) {
            out.push(Action::Send { channel, card: Self::evidence(who, &found, threshold), ping: Vec::new(), roles: Vec::new() });
        }
        let reason = format!("Looks like {} (banned): {}", best.name, best.reasons.join(", "));
        match self.settings.text(self.guild, MODULE, "action").as_deref() {
            Some("timeout") => out.push(Action::Timeout { user: who.id.clone(), until_ms: Some(now + 7 * DAY), reason, case: 0 }),
            Some("kick") => out.push(Action::Kick { user: who.id.clone(), reason, case: 0 }),
            _ => {}
        }
        out
    }
    pub fn command(&self, ev: &CommandEvent) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private(format!("You don't have permission for that (`{}`).", MANAGE.key)); }
        let Some(who) = ev.target.as_ref() else { return private("Pick a member to check.") };
        let found = self.matches(who, ev.at_ms);
        let threshold = self.settings.int(self.guild, MODULE, "threshold");
        if found.is_empty() { return private(format!("<@{}> doesn't look like anyone who was removed from this server.", who.id)); }
        let mut card = Self::evidence(who, &found, threshold);
        card.private = true;
        vec![Action::Reply { card }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn left(user: &str, name: &str, avatar: Option<&str>, how: &str) -> gb_data::roster::Left {
        gb_data::roster::Left { id: 1, user: user.into(), name: name.into(), avatar: avatar.map(str::to_string), left_at: 1000, joined_at: None, roles: vec![], how: how.into(), by: None, reason: None, strikes: 0, cases: 0, flags: vec![], returned_at: None }
    }
    #[test]
    fn names_are_compared_without_the_things_alts_change() {
        assert_eq!(plain_name("Cool_Guy_1234"), "coolguy");
        assert_eq!(name_likeness("CoolGuy", "cool_guy99"), 100);
        assert!(name_likeness("xXShadowXx", "xXShad0wXx") >= 80);
        assert_eq!(name_likeness("Kai", "Kai"), 0, "short names say nothing");
        assert!(name_likeness("Sunflower", "Thunderbolt") < 50);
    }
    #[test]
    fn a_picture_hash_comes_out_of_an_avatar_address() {
        assert_eq!(avatar_hash("https://cdn.discordapp.com/avatars/123/a_abcdef0123456789.png?size=128").as_deref(), Some("a_abcdef0123456789"));
        assert_eq!(avatar_hash("https://cdn.discordapp.com/guilds/1/users/2/avatars/0123456789abcdef.png").as_deref(), Some("0123456789abcdef"));
        assert!(avatar_hash("https://x/y/1.png").is_none());
    }
    #[test]
    fn scores_add_up_from_what_matches() {
        let now = 10 * DAY;
        let pic = "https://cdn.discordapp.com/avatars/1/0123456789abcdef.png?size=128";
        let new = |name: &str, avatar: Option<&str>| Member { id: "2".into(), name: name.into(), avatar: avatar.map(str::to_string), ..Default::default() };
        // the same picture alone is enough for the default threshold
        assert_eq!(compare(&new("Totally Different", Some(pic)), 0, now, 7, &left("1", "BanMe", Some(pic), "banned")).score, 60);
        // the same name alone is not, but with a brand new account it is
        assert_eq!(compare(&new("ban_me7", None), 0, now, 7, &left("1", "BanMe", None, "banned")).score, 50);
        assert_eq!(compare(&new("ban_me7", None), now - DAY, now, 7, &left("1", "BanMe", None, "banned")).score, 65);
        // a new account with nothing else matching scores nothing
        assert_eq!(compare(&new("Someone", None), now - 1000, now, 7, &left("1", "BanMe", None, "banned")).score, 0);
    }
}
