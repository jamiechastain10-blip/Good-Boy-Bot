//! Good Boy 3's invite tracking: who invited each new member, worked out by comparing invite use counts before and
//! after a join (Discord doesn't say). Counts per member (joined, still here, left, brand-new accounts),
//! `/invites user`, `/invites top`, and an optional "joined, invited by" line. Needs Manage Server to read invites.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::{Action, Area, Card, CommandEvent, Db, Def, Kind, Member, Settings};
use std::collections::HashMap;

pub const MODULE: &str = "invites";
pub const VIEW: Perm = Perm { key: "invites.view", level: Level::Everyone };
pub static SETTINGS: &[Def] = &[
    Def { key: "logChannel", label: "Post \"joined, invited by…\" here (optional)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "newAccountDays", label: "Count accounts younger than this many days as new", kind: Kind::Number { min: 0, max: 90 }, default: Fallback::Int(7) },
];
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "invites", about: "Who invited whom", module: MODULE, options: &[], subs: &[
    Sub { name: "user", about: "Someone's invite count", options: &[Opt { name: "member", about: "Who (you if empty)", takes: Takes::Member, required: false }] },
    Sub { name: "top", about: "Top inviters", options: &[] },
] }];

/// One invite as Discord lists it: (uses, who made it, most uses allowed or 0).
pub type Invite = (u64, Option<String>, u64);
/// Which invite was used, from the counts before and after a join (Good Boy 3's usedInvite): (code, inviter).
pub fn used_invite(before: &HashMap<String, Invite>, after: &HashMap<String, Invite>) -> Option<(String, Option<String>)> {
    for (code, a) in after {
        let b = before.get(code);
        if a.0 > b.map(|b| b.0).unwrap_or(0) { return Some((code.clone(), a.1.clone().or_else(|| b.and_then(|b| b.1.clone())))); }
    }
    // an invite with a use limit disappears when its last use is taken
    let gone: Vec<_> = before.iter().filter(|(code, b)| !after.contains_key(*code) && b.2 > 0 && b.0 + 1 >= b.2).collect();
    match gone.as_slice() { [(code, b)] => Some((code.to_string(), b.1.clone())), _ => None }
}

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
fn plural(n: i64, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

/// Someone joined: who invited them is saved, and the line posted. `used`: (code, inviter, the server's custom link).
pub fn joined(db: &Db, settings: &Settings, guild: &str, member: &Member, used: Option<(String, Option<String>, bool)>, now: i64) -> Vec<Action> {
    if member.bot { return Vec::new(); }
    let created = crate::ticketrules::account_created(&member.id).unwrap_or(now);
    let fresh = ((now - created) as f64 / 86_400_000.0) < settings.int(guild, MODULE, "newAccountDays") as f64;
    let (code, inviter, vanity) = match &used { Some((c, i, v)) => (Some(c.as_str()), i.as_deref(), *v), None => (None, None, false) };
    let _ = db.get().invite_join(guild, &member.id, inviter, code, now, fresh);
    let Some(channel) = settings.text(guild, MODULE, "logChannel") else { return Vec::new() };
    let line = match (inviter, vanity) {
        (Some(by), _) => {
            let here = db.get().invite_stats(guild, by).map(|s| s.here).unwrap_or(0);
            format!("👋 <@{}> joined, invited by <@{by}> ({}){}", member.id, plural(here, "invite"), if fresh { " · ⚠️ new account" } else { "" })
        }
        (None, true) => format!("👋 <@{}> joined with the server's custom link (discord.gg/{})", member.id, code.unwrap_or("")),
        _ => format!("👋 <@{}> joined (couldn't tell which invite)", member.id),
    };
    vec![Action::Send { channel, card: Card::new(Area::General).line(line), ping: Vec::new(), roles: Vec::new() }]
}
pub fn left(db: &Db, guild: &str, member: &Member, now: i64) {
    let _ = db.get().invite_left(guild, &member.id, now);
}

pub fn command(db: &Db, ev: &CommandEvent) -> Vec<Action> {
    if !perms::allowed(db, &ev.guild, &ev.member, VIEW) { return private(format!("You don't have permission for that (`{}`).", VIEW.key)); }
    if ev.sub.as_deref() == Some("top") {
        let rows = db.get().top_inviters(&ev.guild, 10).unwrap_or_default();
        if rows.is_empty() { return private("Nobody's invites have been tracked yet. They count from when invite tracking was turned on."); }
        let medal = ["🥇", "🥈", "🥉"];
        let lines: Vec<String> = rows.iter().enumerate().map(|(k, (id, here, joined))| format!("{} <@{id}> · **{here}** here ({joined} joined)", medal.get(k).map(|m| m.to_string()).unwrap_or_else(|| format!("**{}.**", k + 1)))).collect();
        return vec![Action::Reply { card: Card::new(Area::General).title("📨 Top inviters").line(lines.join("\n")) }];
    }
    let who = ev.target.clone().unwrap_or_else(|| ev.member.clone());
    let s = db.get().invite_stats(&ev.guild, &who.id).unwrap_or_default();
    let by = db.get().invited_by(&ev.guild, &who.id).ok().flatten();
    let mut card = Card::new(Area::General).title(format!("📨 {}'s invites", who.name.chars().take(60).collect::<String>()))
        .line(format!("**{}** still here · {} joined · {} left{}", s.here, s.joined, s.left, if s.fresh > 0 { format!(" · {}", plural(s.fresh, "new account")) } else { String::new() }));
    if let Some((Some(inviter), _)) = &by { card = card.line(format!("**Invited by** <@{inviter}>")); }
    let foot = match &by { Some((Some(_), _)) => "Invited by someone in the server".to_string(), Some((None, Some(code))) => format!("Joined with discord.gg/{code}"), _ => "Counted since invite tracking was turned on".into() };
    vec![Action::Reply { card: card.line(format!("-# {foot}")) }]
}
