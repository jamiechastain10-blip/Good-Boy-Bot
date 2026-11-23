//! Raid protection, the young-account check and anti-nuke, as Good Boy 3's moderation module has them: settings,
//! windows, actions and wording are the same. The windows are kept in memory and start over on a restart, as in
//! Good Boy 3.

use crate::moderation::MODULE;
use crate::{Action, Area, Card, Db, Member, Settings};
use std::collections::HashMap;
use std::sync::Mutex;

const RAID_MODE_MS: i64 = 300_000;
const RAID_TIMEOUT_MS: i64 = 600_000;
/// Discord permission bits Good Boy 3 counts as dangerous: Administrator, Manage Server, Manage Roles,
/// Manage Channels, Ban, Kick, Manage Webhooks.
pub const DANGEROUS: u64 = (1 << 3) | (1 << 5) | (1 << 28) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 29);

/// What the shield remembers between events: recent joins per server, raid mode, and destructive actions per person.
#[derive(Default)]
pub struct Shield {
    joins: Mutex<HashMap<String, Vec<(i64, String)>>>,
    raid_until: Mutex<HashMap<String, i64>>,
    nuke: Mutex<HashMap<String, Vec<i64>>>,
}

fn alert(settings: &Settings, guild: &str, card: Card) -> Option<Action> {
    Some(Action::Send { channel: settings.text(guild, MODULE, "logChannel")?, card, ping: Vec::new(), roles: Vec::new() })
}
fn raid_act(settings: &Settings, guild: &str, user: &str, now: i64) -> Option<Action> {
    match settings.text(guild, MODULE, "raidAction").as_deref() {
        Some("timeout") => Some(Action::Timeout { user: user.into(), until_ms: Some(now + RAID_TIMEOUT_MS), reason: "Raid protection".into(), case: 0 }),
        Some("kick") => Some(Action::Kick { user: user.into(), reason: "Raid protection".into(), case: 0 }),
        _ => None,
    }
}

impl Shield {
    /// Someone joined: the young-account check, then raid protection (Good Boy 3's onJoin).
    pub fn joined(&self, settings: &Settings, guild: &str, member: &Member, now: i64) -> Vec<Action> {
        let mut out = Vec::new();
        let age_days = settings.int(guild, MODULE, "minAccountAgeDays");
        let created = crate::ticketrules::account_created(&member.id).unwrap_or(now);
        if age_days > 0 && now - created < age_days * 86_400_000 {
            out.extend(alert(settings, guild, Card::new(Area::Moderation).title("New account joined").line(format!("<@{}> - account created <t:{}:R>", member.id, created / 1000))));
            if settings.text(guild, MODULE, "newAccountAction").as_deref() == Some("kick") {
                out.push(Action::Kick { user: member.id.clone(), reason: format!("Account younger than {age_days} day(s)"), case: 0 });
            }
        }
        if !settings.bool(guild, MODULE, "raidProtection") { return out; }
        let window = settings.int(guild, MODULE, "raidWindowSeconds") * 1000;
        let threshold = settings.int(guild, MODULE, "raidJoinThreshold").max(1) as usize;
        let list = {
            let mut joins = self.joins.lock().unwrap_or_else(|p| p.into_inner());
            let l = joins.entry(guild.to_string()).or_default();
            l.retain(|(t, _)| now - t < window);
            l.push((now, member.id.clone()));
            l.clone()
        };
        let mut raid = self.raid_until.lock().unwrap_or_else(|p| p.into_inner());
        let in_raid = raid.get(guild).copied().unwrap_or(0) > now;
        if !in_raid && list.len() >= threshold {
            raid.insert(guild.to_string(), now + RAID_MODE_MS);
            let action = settings.text(guild, MODULE, "raidAction").unwrap_or_else(|| "alert".into());
            out.extend(alert(settings, guild, Card::new(Area::Moderation).title("🚨 Possible raid").line(format!("{} members joined within {} seconds. Raid mode is active for 5 minutes (action: **{action}**).", list.len(), window / 1000))));
            for (_, id) in &list[..list.len() - 1] { out.extend(raid_act(settings, guild, id, now)); }
        }
        if in_raid || list.len() >= threshold { out.extend(raid_act(settings, guild, &member.id, now)); }
        out
    }

    /// Someone deleted a channel or role, banned or kicked (from the audit log). Past the threshold, Good Boy 3's
    /// response: strip their dangerous roles, ban them, or only alert; the log and the owner are told.
    /// `roles`: the person's roles as (id, permission bits, managed). `immune`: they hold a trusted role.
    #[allow(clippy::too_many_arguments)]
    pub fn destructive(&self, db: &Db, settings: &Settings, guild: &str, executor: &str, owner: Option<&str>, me: &str, roles: &[(String, u64, bool)], immune: bool, now: i64) -> Vec<Action> {
        let _ = db;
        if !settings.bool(guild, MODULE, "antiNuke") || executor == me || Some(executor) == owner || immune { return Vec::new(); }
        let window = settings.int(guild, MODULE, "nukeWindowSeconds") * 1000;
        let threshold = settings.int(guild, MODULE, "nukeThreshold").max(1) as usize;
        let count = {
            let mut nuke = self.nuke.lock().unwrap_or_else(|p| p.into_inner());
            let key = format!("{guild}:{executor}");
            let l = nuke.entry(key.clone()).or_default();
            l.retain(|t| now - t < window);
            l.push(now);
            let n = l.len();
            if n >= threshold { nuke.remove(&key); }
            n
        };
        if count < threshold { return Vec::new(); }
        let mut out = Vec::new();
        let result = match settings.text(guild, MODULE, "nukeAction").as_deref().unwrap_or("strip-roles") {
            "strip-roles" => {
                let risky: Vec<String> = roles.iter().filter(|(id, perms, managed)| !managed && id != guild && perms & DANGEROUS != 0).map(|(id, _, _)| id.clone()).collect();
                let n = risky.len();
                out.push(Action::Roles { user: executor.into(), add: Vec::new(), remove: risky, reason: "Anti-nuke: mass destructive actions".into() });
                format!("removed {n} dangerous role(s)")
            }
            "ban" => {
                out.push(Action::Ban { user: executor.into(), reason: "Anti-nuke: mass destructive actions".into(), delete_days: 0, case: 0 });
                "banned".into()
            }
            _ => "alert only".to_string(),
        };
        let card = Card::new(Area::Moderation).title("🛡️ Anti-nuke triggered").line(format!("<@{executor}> performed **{count}** destructive actions within {}s.\nResponse: **{result}**.", window / 1000));
        out.extend(alert(settings, guild, card.clone()));
        if let Some(o) = owner { out.push(Action::Dm { user: o.into(), card, or_in: None }); }
        out
    }
}
