//! Who may do what, with the same rules as Good Boy 3: an administrator always can; a server can hand a
//! permission to roles of its choosing; otherwise the permission's own default decides.

use crate::{Db, Member};

pub const ADMINISTRATOR: u64 = 1 << 3;
pub const KICK_MEMBERS: u64 = 1 << 1;
pub const BAN_MEMBERS: u64 = 1 << 2;
pub const MANAGE_GUILD: u64 = 1 << 5;
pub const MANAGE_MESSAGES: u64 = 1 << 13;
pub const MODERATE_MEMBERS: u64 = 1 << 40;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Level {
    Everyone,
    /// Moderators. With a Discord permission named, having that permission is what counts.
    Moderator(Option<u64>),
    Admin,
}
/// One thing a server can allow or restrict, such as "moderation.ban".
#[derive(Debug, Clone, Copy)]
pub struct Perm {
    pub key: &'static str,
    pub level: Level,
}

fn is_admin(m: &Member) -> bool {
    m.perms & (ADMINISTRATOR | MANAGE_GUILD) != 0
}
pub fn allowed(db: &Db, guild: &str, member: &Member, perm: Perm) -> bool {
    if member.perms & ADMINISTRATOR != 0 {
        return true;
    }
    let roles = db.get().perm_roles(guild, perm.key).unwrap_or_default();
    if !roles.is_empty() {
        return roles.iter().any(|r| member.roles.contains(r)) || is_admin(member);
    }
    match perm.level {
        Level::Everyone => true,
        Level::Moderator(Some(bit)) => member.perms & bit != 0 || is_admin(member),
        Level::Moderator(None) => is_admin(member) || member.perms & (MODERATE_MEMBERS | KICK_MEMBERS | BAN_MEMBERS | MANAGE_MESSAGES) != 0,
        Level::Admin => is_admin(member),
    }
}
