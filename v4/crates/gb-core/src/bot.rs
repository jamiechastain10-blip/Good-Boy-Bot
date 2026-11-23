//! The bot: holds the database and settings, and passes each event through the modules that are on.

use crate::Member;
use crate::community;
use crate::modplus;
use crate::casino;
use crate::fish;
use crate::{plural, altwatch, timezones, roster, achievements, backup, botnews, clips, critters, engagement, integrations, stats, tempvoice, tts, partyfinder, quotes, counting, deadchat, eclipseid, family, notify, economy, messages, fun, invites, modmail, roleplay, utility, giveaways, levels, logs, moderation, money, music, reminders, roles, tags, tickets, welcome, Action, Area, ButtonEvent, Card, CommandEvent, Db, FormEvent, MessageEvent, Place, Settings};
use gb_data::Store;

/// Private messages go after this many seconds of nobody touching them (Discord lets a bot take one down for 15 minutes).
pub const DEFAULT_DISMISS: u64 = 300;

pub struct Bot {
    pub db: Db,
    pub settings: Settings,
    /// The channels and roles of each server the bot is connected to (names for the launcher's pickers).
    pub directory: Directory,
    /// Each server's music player.
    pub players: music::Players,
    /// Answers to the early parts of long command popups.
    pub drafts: crate::forms::Drafts,
    /// Members, voice and messages by the hour, for the dashboard's Home page.
    pub pulse: crate::pulse::Pulse,
    /// Raid protection and anti-nuke windows.
    pub shield: crate::shield::Shield,
}

/// A channel or role, by name.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Named {
    pub id: String,
    pub name: String,
    /// For channels: "text", "voice", "category", "forum" or "other". Empty for roles.
    pub kind: &'static str,
    /// For channels: the category it is in (empty when it is in none, and for roles).
    pub parent: String,
}
/// A server's owner, what everyone may do, and what each role adds.
type Powers = (String, u64, std::collections::HashMap<String, u64>);
#[derive(Default)]
pub struct Directory {
    channels: std::sync::RwLock<std::collections::HashMap<String, Vec<Named>>>,
    roles: std::sync::RwLock<std::collections::HashMap<String, Vec<Named>>>,
    members: std::sync::RwLock<std::collections::HashMap<String, u64>>,
    /// Each server's owner, what everyone may do, and what each role adds (Discord's permission numbers).
    powers: std::sync::RwLock<std::collections::HashMap<String, Powers>>,
    /// Each server's roles: name, position, whether an integration manages it, and its permissions.
    role_facts: std::sync::RwLock<std::collections::HashMap<String, std::collections::HashMap<String, RoleFacts>>>,
    /// The position of the bot's own highest role in each server.
    my_top: std::sync::RwLock<std::collections::HashMap<String, i64>>,
    /// Seconds a private (only-you) message stays after nobody touches it: stored plus one, so 0 means "not set" (the default).
    dismiss: std::sync::atomic::AtomicU64,
    /// The bot's own roles in each server.
    my_roles: std::sync::RwLock<std::collections::HashMap<String, Vec<String>>>,
    /// Who is in which voice channel: "server:user" to channel.
    voice: std::sync::RwLock<std::collections::HashMap<String, String>>,
    /// The bot's owner (the person who made the bot on Discord's developer page).
    owner: std::sync::RwLock<Option<String>>,
    presences: std::sync::atomic::AtomicBool,
    reads_messages: std::sync::atomic::AtomicBool,
    licensed: std::sync::atomic::AtomicBool,
    me: std::sync::RwLock<Option<String>>,
    /// Each server's AFK voice channel (time there earns nothing).
    afk: std::sync::RwLock<std::collections::HashMap<String, String>>,
    /// Who in voice is muted or deafened, and who they are ("server:user"), for voice XP.
    voice_flags: std::sync::RwLock<std::collections::HashMap<String, VoiceFlags>>,
    /// Which helper music bots (by number) are in each server.
    slots: std::sync::RwLock<std::collections::HashMap<String, Vec<usize>>>,
    /// The helper music bots this bot was started with.
    helpers: std::sync::RwLock<Vec<Helper>>,
    /// What Discord says about each server that is not a setting: boosts, tier, icon.
    guild_facts: std::sync::RwLock<std::collections::HashMap<String, GuildFacts>>,
}
/// An extra bot that only plays music (number 1 and up; the main bot is 0).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Helper {
    pub slot: usize,
    pub name: String,
    /// Its Discord application id, for the link that adds it to a server.
    pub id: String,
}
/// A member sitting in a voice channel.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct VoiceFlags {
    pub member: Member,
    pub muted: bool,
    pub deaf: bool,
    /// The category the voice channel is in.
    pub category: Option<String>,
}
/// Boosts, boost tier and icon of a server.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GuildFacts {
    pub boosts: u64,
    pub tier: u8,
    pub icon: Option<String>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct RoleFacts {
    pub name: String,
    pub position: i64,
    pub managed: bool,
    pub perms: u64,
    /// Anyone may @mention this role.
    pub mentionable: bool,
}
impl Directory {
    pub fn set_channels(&self, guild: &str, list: Vec<Named>) {
        self.channels.write().unwrap_or_else(|p| p.into_inner()).insert(guild.to_string(), list);
    }
    pub fn set_roles(&self, guild: &str, list: Vec<Named>) {
        self.roles.write().unwrap_or_else(|p| p.into_inner()).insert(guild.to_string(), list);
    }
    /// A channel was made or renamed.
    pub fn put_channel(&self, guild: &str, channel: Named) {
        let mut all = self.channels.write().unwrap_or_else(|p| p.into_inner());
        let list = all.entry(guild.to_string()).or_default();
        match list.iter_mut().find(|c| c.id == channel.id) {
            Some(had) => *had = channel,
            None => list.push(channel),
        }
    }
    pub fn drop_channel(&self, guild: &str, id: &str) {
        if let Some(list) = self.channels.write().unwrap_or_else(|p| p.into_inner()).get_mut(guild) {
            list.retain(|c| c.id != id);
        }
    }
    /// What everyone may do in a server and what each role adds, and who owns it.
    pub fn set_powers(&self, guild: &str, owner: &str, everyone: u64, roles: std::collections::HashMap<String, u64>) {
        self.powers.write().unwrap_or_else(|p| p.into_inner()).insert(guild.to_string(), (owner.to_string(), everyone, roles));
    }
    pub fn set_role_facts(&self, guild: &str, roles: std::collections::HashMap<String, RoleFacts>, my_top: Option<i64>) {
        self.role_facts.write().unwrap_or_else(|p| p.into_inner()).insert(guild.to_string(), roles);
        if let Some(top) = my_top {
            self.my_top.write().unwrap_or_else(|p| p.into_inner()).insert(guild.to_string(), top);
        }
    }
    pub fn put_role_facts(&self, guild: &str, role: &str, facts: Option<RoleFacts>) {
        let mut all = self.role_facts.write().unwrap_or_else(|p| p.into_inner());
        let map = all.entry(guild.to_string()).or_default();
        match facts { Some(f) => { map.insert(role.to_string(), f); } None => { map.remove(role); } }
    }
    pub fn role(&self, guild: &str, role: &str) -> Option<RoleFacts> {
        self.role_facts.read().unwrap_or_else(|p| p.into_inner()).get(guild)?.get(role).cloned()
    }
    /// How long a private message may sit untouched before it is taken down (0 = never). 3 minutes unless set.
    pub fn dismiss_seconds(&self) -> u64 {
        match self.dismiss.load(std::sync::atomic::Ordering::Relaxed) { 0 => DEFAULT_DISMISS, n => n - 1 }
    }
    pub fn set_dismiss_seconds(&self, secs: u64) {
        self.dismiss.store(secs.min(840) + 1, std::sync::atomic::Ordering::Relaxed);
    }
    /// What the bot may do server-wide (its roles' permissions together), when its roles are known.
    pub fn my_power(&self, guild: &str) -> Option<u64> {
        let mine = self.my_roles.read().unwrap_or_else(|p| p.into_inner()).get(guild).cloned()?;
        Some(self.power_of(guild, "\u{0}bot", &mine))
    }
    pub fn set_my_roles(&self, guild: &str, roles: Vec<String>) {
        self.my_roles.write().unwrap_or_else(|p| p.into_inner()).insert(guild.to_string(), roles);
    }
    /// Why pinging these roles would be ignored by Discord, or None when it will work (or when the bot's own
    /// roles are not known yet, so nothing is claimed).
    pub fn ping_problem(&self, guild: &str, roles: &[String]) -> Option<String> {
        let mine = self.my_roles.read().unwrap_or_else(|p| p.into_inner()).get(guild).cloned()?;
        let power = self.power_of(guild, "\u{0}bot", &mine);
        if power & (crate::perms::ADMINISTRATOR | (1 << 17)) != 0 { return None; }
        let blocked: Vec<String> = roles.iter().filter_map(|r| self.role(guild, r)).filter(|r| !r.mentionable).map(|r| format!("**{}**", r.name)).collect();
        if blocked.is_empty() { return None; }
        Some(format!("⚠️ I can't notify {}: it isn't mentionable and I don't have **Mention @everyone, @here, and All Roles**. Turn on \"Allow anyone to @mention this role\" for it, or give me that permission, or the reminder will post without pinging.", blocked.join(", ")))
    }
    pub fn my_top(&self, guild: &str) -> Option<i64> {
        self.my_top.read().unwrap_or_else(|p| p.into_inner()).get(guild).copied()
    }
    /// Someone joined, moved or left voice (`None`).
    pub fn set_voice(&self, guild: &str, user: &str, channel: Option<&str>) {
        let mut all = self.voice.write().unwrap_or_else(|p| p.into_inner());
        let key = format!("{guild}:{user}");
        match channel {
            Some(c) => { all.insert(key, c.to_string()); }
            None => {
                all.remove(&key);
                drop(all);
                self.voice_flags.write().unwrap_or_else(|p| p.into_inner()).remove(&format!("{guild}:{user}"));
            }
        }
    }
    /// Who someone in voice is and whether they are muted or deafened.
    pub fn set_voice_flags(&self, guild: &str, flags: VoiceFlags) {
        self.voice_flags.write().unwrap_or_else(|p| p.into_inner()).insert(format!("{guild}:{}", flags.member.id), flags);
    }
    /// Every voice channel with someone in it: (channel, the people there), in a steady order.
    pub fn voice_rooms(&self, guild: &str) -> Vec<(String, Vec<VoiceFlags>)> {
        let prefix = format!("{guild}:");
        let rooms: Vec<(String, String)> = self.voice.read().unwrap_or_else(|p| p.into_inner()).iter().filter(|(k, _)| k.starts_with(&prefix)).map(|(k, c)| (k[prefix.len()..].to_string(), c.clone())).collect();
        // the music bots sit in voice but are not people
        let bots: Vec<String> = self.helpers.read().unwrap_or_else(|p| p.into_inner()).iter().map(|h| h.id.clone()).chain(self.me()).collect();
        let rooms: Vec<(String, String)> = rooms.into_iter().filter(|(u, _)| !bots.contains(u)).collect();
        let flags = self.voice_flags.read().unwrap_or_else(|p| p.into_inner());
        let mut by: std::collections::BTreeMap<String, Vec<VoiceFlags>> = Default::default();
        for (user, channel) in rooms {
            let f = flags.get(&format!("{guild}:{user}")).cloned().unwrap_or_else(|| VoiceFlags { member: Member { id: user.clone(), ..Default::default() }, ..Default::default() });
            by.entry(channel).or_default().push(f);
        }
        by.into_iter().map(|(c, mut v)| { v.sort_by(|a, b| a.member.id.cmp(&b.member.id)); (c, v) }).collect()
    }
    /// How many roles a server has (everything Discord listed, @everyone included).
    pub fn role_count(&self, guild: &str) -> usize {
        self.role_facts.read().unwrap_or_else(|p| p.into_inner()).get(guild).map(|r| r.len()).unwrap_or(0)
    }
    /// The helper music bots in use (set when the bot starts).
    pub fn set_helpers(&self, list: Vec<Helper>) {
        *self.helpers.write().unwrap_or_else(|p| p.into_inner()) = list;
    }
    pub fn helpers(&self) -> Vec<Helper> {
        self.helpers.read().unwrap_or_else(|p| p.into_inner()).clone()
    }
    /// A helper bot is in (or left) a server.
    pub fn helper_in(&self, guild: &str, slot: usize, present: bool) {
        let mut all = self.slots.write().unwrap_or_else(|p| p.into_inner());
        let list = all.entry(guild.to_string()).or_default();
        list.retain(|s| *s != slot);
        if present { list.push(slot); list.sort_unstable(); }
    }
    /// The music bots a server can use: the main bot (0) and the helpers that are in it.
    pub fn slots(&self, guild: &str) -> Vec<usize> {
        let mut v = vec![0];
        v.extend(self.slots.read().unwrap_or_else(|p| p.into_inner()).get(guild).cloned().unwrap_or_default());
        v
    }
    pub fn set_guild_facts(&self, guild: &str, facts: GuildFacts) {
        self.guild_facts.write().unwrap_or_else(|p| p.into_inner()).insert(guild.to_string(), facts);
    }
    pub fn guild_facts(&self, guild: &str) -> GuildFacts {
        self.guild_facts.read().unwrap_or_else(|p| p.into_inner()).get(guild).cloned().unwrap_or_default()
    }
    pub fn voice_of(&self, guild: &str, user: &str) -> Option<String> {
        self.voice.read().unwrap_or_else(|p| p.into_inner()).get(&format!("{guild}:{user}")).cloned()
    }
    /// How many people are in a voice channel in this server right now.
    pub fn voice_count(&self, guild: &str) -> usize {
        let prefix = format!("{guild}:");
        self.voice.read().unwrap_or_else(|p| p.into_inner()).keys().filter(|k| k.starts_with(&prefix)).count()
    }
    /// Everyone in a voice channel.
    pub fn in_voice(&self, guild: &str, channel: &str) -> Vec<String> {
        let prefix = format!("{guild}:");
        self.voice.read().unwrap_or_else(|p| p.into_inner()).iter().filter(|(k, c)| k.starts_with(&prefix) && c.as_str() == channel).map(|(k, _)| k[prefix.len()..].to_string()).collect()
    }
    /// Whether Discord sends what people are playing (the Presence Intent, switched on by the bot's owner).
    /// Whether the bot may read what messages say (Message Content, switched on by the bot's owner).
    pub fn set_reads_messages(&self, on: bool) {
        self.reads_messages.store(on, std::sync::atomic::Ordering::Relaxed);
    }
    /// Whether this bot has a good licence (set by the app that runs it).
    pub fn set_licensed(&self, on: bool) {
        self.licensed.store(on, std::sync::atomic::Ordering::Relaxed);
    }
    pub fn licensed(&self) -> bool {
        self.licensed.load(std::sync::atomic::Ordering::Relaxed)
    }
    pub fn reads_messages(&self) -> bool {
        self.reads_messages.load(std::sync::atomic::Ordering::Relaxed)
    }
    /// The bot's own user id, once connected.
    pub fn set_me(&self, id: &str) {
        *self.me.write().unwrap_or_else(|p| p.into_inner()) = Some(id.to_string());
    }
    pub fn set_afk_channel(&self, guild: &str, channel: Option<String>) {
        let mut m = self.afk.write().unwrap_or_else(|p| p.into_inner());
        match channel { Some(c) => { m.insert(guild.to_string(), c); } None => { m.remove(guild); } }
    }
    pub fn afk_channel(&self, guild: &str) -> Option<String> {
        self.afk.read().unwrap_or_else(|p| p.into_inner()).get(guild).cloned()
    }
    pub fn me(&self) -> Option<String> {
        self.me.read().unwrap_or_else(|p| p.into_inner()).clone()
    }
    pub fn set_presences(&self, on: bool) {
        self.presences.store(on, std::sync::atomic::Ordering::Relaxed);
    }
    pub fn sees_presences(&self) -> bool {
        self.presences.load(std::sync::atomic::Ordering::Relaxed)
    }
    pub fn set_bot_owner(&self, owner: Option<String>) {
        *self.owner.write().unwrap_or_else(|p| p.into_inner()) = owner;
    }
    pub fn bot_owner(&self) -> Option<String> {
        self.owner.read().unwrap_or_else(|p| p.into_inner()).clone()
    }
    /// The owner of a server, when known.
    pub fn owner(&self, guild: &str) -> Option<String> {
        self.powers.read().unwrap_or_else(|p| p.into_inner()).get(guild).map(|p| p.0.clone())
    }
    /// A role was made, changed (`Some`) or deleted (`None`).
    pub fn set_role_power(&self, guild: &str, role: &str, power: Option<u64>) {
        let mut all = self.powers.write().unwrap_or_else(|p| p.into_inner());
        if let Some((_, everyone, roles)) = all.get_mut(guild) {
            match power {
                Some(p) if role == guild => *everyone = p,
                Some(p) => { roles.insert(role.to_string(), p); }
                None => { roles.remove(role); }
            }
        }
    }
    /// A member's Discord permissions in a server, worked out from their roles. The owner can do everything.
    pub fn power_of(&self, guild: &str, user: &str, roles: &[String]) -> u64 {
        let all = self.powers.read().unwrap_or_else(|p| p.into_inner());
        let Some((owner, everyone, by_role)) = all.get(guild) else { return 0 };
        if owner == user {
            return crate::perms::ADMINISTRATOR;
        }
        roles.iter().filter_map(|r| by_role.get(r)).fold(*everyone, |a, b| a | b)
    }
    /// How many members a server has, as Discord last said.
    pub fn set_members(&self, guild: &str, count: u64) {
        self.members.write().unwrap_or_else(|p| p.into_inner()).insert(guild.to_string(), count);
    }
    pub fn members(&self, guild: &str) -> Option<u64> {
        self.members.read().unwrap_or_else(|p| p.into_inner()).get(guild).copied()
    }
    pub fn channels(&self, guild: &str) -> Vec<Named> {
        self.channels.read().unwrap_or_else(|p| p.into_inner()).get(guild).cloned().unwrap_or_default()
    }
    pub fn roles(&self, guild: &str) -> Vec<Named> {
        self.roles.read().unwrap_or_else(|p| p.into_inner()).get(guild).cloned().unwrap_or_default()
    }
}

/// A module, as people see it.
#[derive(Debug, Clone, Copy)]
pub struct ModuleInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub about: &'static str,
}
/// The modules this build of the bot has.
pub const MODULES: &[ModuleInfo] = &[
    ModuleInfo { id: levels::MODULE, name: "Levels", about: "Members earn XP for chatting, reacting and talking in voice, and level up with role rewards. Reputation, leaderboards (also a live one), XP boosts, a member counter. /rank, /leaderboard, /rep, /xp, /levels, /liveboard, /serverstats." },
    ModuleInfo { id: money::MODULE, name: "Money", about: "Coins, daily streaks, paying members, live leaderboards, the shop and inventory, work, the bank, pets, robbing (if allowed), the weekly lottery and coin events. /balance, /daily, /pay, /top, /shop, /work, /rob, /pet, /bank." },
    ModuleInfo { id: moderation::MODULE, name: "Moderation", about: "Warn, time out, kick, ban (for good or for a while), purge, each member's history, AutoMod, a strike ladder, server logs, raid protection and anti-nuke." },
    ModuleInfo { id: welcome::MODULE, name: "Welcome", about: "Welcome and goodbye messages with a picture, roles given back to members who return, verification with an optional captcha, profile roles, introductions, birthdays and AFK. Needs Server Members on the bot's page. /greeting, /verify, /profile, /introduce, /birthday, /afk." },
    ModuleInfo { id: roles::MODULE, name: "Role menus", about: "Buttons or a dropdown for members to pick roles, reaction roles, roles given on join, roles while playing a game, and roles that run out. /rolemenu, /reactionrole, /autorole, /gamerole." },
    ModuleInfo { id: tickets::MODULE, name: "Tickets", about: "Tickets with categories and urgency, popups, a staff watch log for reports, required close notes, transcripts, ratings and a history. /ticket." },
    ModuleInfo { id: reminders::MODULE, name: "Reminders", about: "Private reminders and team reminders that notify roles, once or repeating. /remind." },
    ModuleInfo { id: giveaways::MODULE, name: "Giveaways", about: "A card with an Enter button, winners drawn fairly when time is up, rerolls, and coin prizes paid by themselves. /giveaway." },
    ModuleInfo { id: tags::MODULE, name: "Custom commands", about: "Your own commands such as ?rules, and replies when someone says a phrase. /tags. Needs Message Content." },
    ModuleInfo { id: counting::MODULE, name: "Counting", about: "Counting channels and word chain, with records and top players. /counting. Needs Message Content." },
    ModuleInfo { id: fun::MODULE, name: "Fun", about: "Magic 8-ball, dice, ship two members and conversation topics. /fun." },
    ModuleInfo { id: eclipseid::MODULE, name: "Eclipse ID", about: "A gaming profile members control: favourite games, platforms, availability, linked game names, and who sees each part. /id." },
    ModuleInfo { id: stats::MODULE, name: "Activity stats", about: "Counts messages, voice time and reactions (never message text) for member stats, leaderboards, weekly recaps, inactive-member clean-up and counter channels. /stats, /counter." },
    ModuleInfo { id: engagement::MODULE, name: "Announcements, polls and suggestions", about: "Announcements (also scheduled and repeating), polls and suggestions on one voting engine, and a configurable starboard. /announce, /poll, /suggest, /suggestion, /starboard." },
    ModuleInfo { id: tempvoice::MODULE, name: "Temporary voice rooms", about: "Join-to-create voice rooms with full controls, plus event hubs that sort players into teams with their own voice rooms. /room, /voicehub." },
    ModuleInfo { id: tts::MODULE, name: "Voice (text-to-speech)", about: "Speaks messages in voice channels with a queue, per-member voices, a no-mic channel read aloud, auto-leave and diagnostics. /tts." },
    ModuleInfo { id: integrations::MODULE, name: "Integrations", about: "Follow RSS, YouTube, GitHub, Reddit, Twitch, Bluesky, Kick and Mastodon in a channel; Minecraft status; inbound webhooks. /feed, /minecraft, /webhook." },
    ModuleInfo { id: critters::MODULE, name: "Critters", about: "Catch, collect, trade and battle characters from your own roster that appear while people chat. /critters." },
    ModuleInfo { id: quotes::MODULE, name: "Quotes", about: "Turn any message into a shareable image quote (right-click a message > Apps, or /quote)." },
    ModuleInfo { id: partyfinder::MODULE, name: "Party finder", about: "Looking-for-group posts with Join/Leave buttons, slots, start times, optional voice channels, and opt-in reminders. /party." },
    ModuleInfo { id: botnews::MODULE, name: "Bot news", about: "Posts bot updates and new modules: everything to the admin channel, member news to announcements. /botnews." },
    ModuleInfo { id: clips::MODULE, name: "Clips", about: "A game-clips channel that runs itself: votes, Best clips reposts, clip of the week with coins. /clips." },
    ModuleInfo { id: achievements::MODULE, name: "Achievements", about: "Badges earned from chatting, voice time, reactions and streaks, plus the server's own. /achievements." },
    ModuleInfo { id: family::MODULE, name: "Families", about: "Marry, adopt and build a family tree with other members. /marry, /family." },
    ModuleInfo { id: plural::MODULE, name: "Plural proxy", about: "For plural systems: register members with a name, a picture and proxy tags, and messages that use the tags are sent as that member (PluralKit style). Needs Manage Webhooks and Message Content. /plural.", },
    ModuleInfo { id: altwatch::MODULE, name: "Alt detector", about: "When someone joins, compares them with members who were banned: the same profile picture, a near-identical name, a brand new account. Staff are told what matched; it only guesses. /altcheck.", },
    ModuleInfo { id: timezones::MODULE, name: "Time zones", about: "Members say where they are; /time shows what time it is for someone, and turns '8pm for them' into a time everyone sees in their own zone. /timezone, /time." },
    ModuleInfo { id: deadchat::MODULE, name: "Dead chat ping", about: "Pings a role with a conversation starter when a channel goes quiet. Members opt in with a button. /deadchat." },
    ModuleInfo { id: messages::MODULE, name: "Messages", about: "Post and edit messages as the bot, and sticky messages that stay at the bottom of a channel. /say, /sticky." },
    ModuleInfo { id: backup::MODULE, name: "Backup", about: "Save the server's roles, channels and permissions, and put back anything that goes missing. /backup. A backup every week by itself." },
    ModuleInfo { id: modmail::MODULE, name: "Modmail", about: "Members DM the bot to reach staff; staff answer from a private thread. Lines starting with // stay as staff notes." },
    ModuleInfo { id: invites::MODULE, name: "Invites", about: "Who invited each new member, with counts (still here, left, new accounts) and a leaderboard. /invites. Needs Manage Server to read invites." },
    ModuleInfo { id: roleplay::MODULE, name: "Roleplay", about: "Hug, pat, boop, bonk and more with a GIF to pick, a count for each pair, and a button to do it back. /rp. GIFs need the bot owner's Tenor key." },
    ModuleInfo { id: utility::MODULE, name: "Utility", about: "Highlights (a DM when someone says your word) and Translate on any message. /highlight, right-click > Apps > Translate. Highlights need Message Content." },
    ModuleInfo { id: casino::MODULE, name: "Games", about: "Slots with a growing jackpot, wild cards and hot streaks; blackjack with split, double, insurance and surrender; coin flip; fishing; and the arcade: Treasure Climb, Bomb Squad, Bingo, Memory, Balloon Rescue, Trivia and Paddle Duel. Played with economy coins. /slots, /blackjack, /coinflip, /fish, /tower, /wires, /bingo, /memory, /hangman, /trivia, /pong, /arcade." },
    ModuleInfo { id: music::MODULE, name: "Music", about: "A player with buttons in voice: a queue, repeat, shuffle, seek, volume, playlists, lyrics, move the bot between channels, 24/7 mode, and extra music bots so several channels can play at once. Audio file links and radio stations always work; YouTube and similar sites only once the bot's owner turns on media links. /music." },
];

/// What a command's box takes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Takes {
    Member,
    Text,
    /// A whole number between the two.
    Whole { min: i64, max: i64 },
    Role,
    Channel,
    /// A category of channels.
    Category,
    /// Any channel or category.
    AnyChannel,
    /// Yes or no.
    YesNo,
    /// One of a fixed list: (what people see, what the bot gets).
    Choice(&'static [(&'static str, &'static str)]),
}
/// One box of a command.
#[derive(Debug, Clone, Copy)]
pub struct Opt {
    pub name: &'static str,
    pub about: &'static str,
    pub takes: Takes,
    pub required: bool,
}
/// One part of a grouped command, such as `daily` in `/money daily`.
#[derive(Debug, Clone, Copy)]
pub struct Sub {
    pub name: &'static str,
    pub about: &'static str,
    pub options: &'static [Opt],
}
#[derive(Debug, Clone, Copy)]
pub struct CommandSpec {
    pub name: &'static str,
    pub about: &'static str,
    /// The module it belongs to: the command only works where that module is on.
    pub module: &'static str,
    pub options: &'static [Opt],
    pub subs: &'static [Sub],
}

/// The commands levels and money answer. Every module lists its own; `commands()` gathers them all.
const OWN: &[CommandSpec] = &[
    CommandSpec { name: "rank", about: "See your level, or someone else's", module: levels::MODULE, options: &[Opt { name: "member", about: "Whose level to show (yours if empty)", takes: Takes::Member, required: false }], subs: &[] },
    CommandSpec { name: "leaderboard", about: "Top members", module: levels::MODULE, options: &[Opt { name: "type", about: "What to rank", takes: Takes::Choice(&[("XP", "xp"), ("Reputation", "rep"), ("Messages", "messages")]), required: false }, Opt { name: "page", about: "Page", takes: Takes::Whole { min: 1, max: 100_000 }, required: false }], subs: &[] },
];
/// What a group of parts is for, shown in Discord's command list (`/ticket type …`, `/ticket watch …`).
pub fn group_about(command: &str, group: &str) -> &'static str {
    match (command, group) {
        ("ticket", "type") => "Your own extra ticket types",
        ("ticket", "watch") => "(Staff) The watch log of reported people",
        ("xp", "ignore") => "Channels or categories where nobody earns XP",
        ("xp", "boost") => "More (or less) XP for some roles or channels",
        ("music", "favorite") => "Songs you saved",
        ("music", "voice") => "Where the bot sits in voice",
        ("levels", "reward") => "Role rewards",
        _ => "More options",
    }
}
/// Every command this build of the bot answers. The Discord layer registers exactly these.
pub fn commands() -> impl Iterator<Item = &'static CommandSpec> {
    OWN.iter().chain(fun::COMMANDS).chain(counting::COMMANDS).chain(reminders::COMMANDS).chain(giveaways::COMMANDS).chain(tickets::COMMANDS).chain(tags::COMMANDS).chain(roles::COMMANDS).chain(welcome::COMMANDS).chain(economy::COMMANDS).chain(utility::COMMANDS).chain(roleplay::COMMANDS).chain(invites::COMMANDS).chain(backup::COMMANDS).chain(messages::COMMANDS).chain(deadchat::COMMANDS).chain(eclipseid::COMMANDS).chain(family::COMMANDS).chain(achievements::COMMANDS).chain(clips::COMMANDS).chain(botnews::COMMANDS).chain(partyfinder::COMMANDS).chain(quotes::COMMANDS).chain(critters::COMMANDS).chain(integrations::COMMANDS).chain(tts::COMMANDS).chain(tempvoice::COMMANDS).chain(engagement::COMMANDS).chain(stats::COMMANDS).chain(community::COMMANDS).chain(casino::COMMANDS).chain(crate::arcade::COMMANDS).chain(fish::COMMANDS).chain(notify::COMMANDS).chain(moderation::COMMANDS).chain(modplus::COMMANDS).chain(logs::COMMANDS).chain(music::COMMANDS).chain(timezones::COMMANDS).chain(altwatch::COMMANDS).chain(plural::COMMANDS)
}

/// Modules a brand-new server starts with.
pub const STARTING_MODULES: &[&str] = &[levels::MODULE, money::MODULE, moderation::MODULE, welcome::MODULE, roles::MODULE, tickets::MODULE, reminders::MODULE, giveaways::MODULE, tags::MODULE, fun::MODULE, music::MODULE];

fn private(text: impl Into<String>) -> Action {
    Action::Reply { card: Card::new(Area::General).line(text).private() }
}
fn friendly(module: &str) -> &'static str {
    match module {
        m if m == levels::MODULE => "Levels are",
        m if m == money::MODULE => "Money is",
        m if m == moderation::MODULE => "Moderation is",
        m if m == reminders::MODULE => "Reminders are",
        m if m == counting::MODULE => "Counting is",
        m if m == giveaways::MODULE => "Giveaways are",
        m if m == tickets::MODULE => "Tickets are",
        m if m == tags::MODULE => "Custom commands are",
        m if m == roles::MODULE => "Role menus are",
        m if m == music::MODULE => "Music is",
        m if m == fun::MODULE => "Fun commands are",
        _ => "That is",
    }
}

impl Bot {
    pub fn new(store: Store) -> Bot {
        // a module's own tables are made here when a database does not have them yet (a fresh v4 install);
        // a database Good Boy 3 set up already has them and is left alone
        let _ = store.module_migrate(levels::MODULE, gb_data::community::MIGRATIONS);
        let _ = store.module_migrate(casino::MODULE, gb_data::fishing::MIGRATIONS);
        let _ = store.module_migrate(money::MODULE, gb_data::economy::MIGRATIONS);
        let _ = store.module_migrate(giveaways::MODULE, gb_data::giveaways::MIGRATIONS);
        let _ = store.module_migrate("roster", gb_data::roster::MIGRATIONS);
        let _ = store.module_migrate(moderation::MODULE, gb_data::messages::MIGRATIONS);
        let _ = store.module_migrate(tickets::MODULE, gb_data::support::MIGRATIONS);
        let _ = store.module_migrate(roleplay::MODULE, roleplay::MIGRATIONS);
        let _ = store.module_migrate(invites::MODULE, gb_data::invites::MIGRATIONS);
        let _ = store.module_migrate(backup::MODULE, gb_data::backup::MIGRATIONS);
        let _ = store.module_migrate(eclipseid::MODULE, gb_data::eclipseid::MIGRATIONS);
        let _ = store.module_migrate(family::MODULE, gb_data::family::MIGRATIONS);
        let _ = store.module_migrate(achievements::MODULE, gb_data::achievements::MIGRATIONS);
        let _ = store.module_migrate(clips::MODULE, gb_data::clips::MIGRATIONS);
        let _ = store.module_migrate(stats::MODULE, gb_data::stats::MIGRATIONS);
        let _ = store.module_migrate(critters::MODULE, gb_data::critters::MIGRATIONS);
        let db = Db::new(store);
        let mut settings = Settings::new(db.clone());
        settings.register(levels::MODULE, levels::SETTINGS);
        settings.register(money::MODULE, money::SETTINGS);
        settings.register(moderation::MODULE, moderation::SETTINGS);
        settings.register(reminders::MODULE, reminders::SETTINGS);
        settings.register(counting::MODULE, counting::SETTINGS);
        settings.register(fun::MODULE, fun::SETTINGS);
        settings.register(giveaways::MODULE, giveaways::SETTINGS);
        settings.register(tickets::MODULE, tickets::SETTINGS);
        settings.register(tags::MODULE, tags::SETTINGS);
        settings.register(welcome::MODULE, welcome::SETTINGS);
        settings.register(utility::MODULE, utility::SETTINGS);
        settings.register(roleplay::MODULE, roleplay::SETTINGS);
        settings.register(invites::MODULE, invites::SETTINGS);
        settings.register(modmail::MODULE, modmail::SETTINGS);
        settings.register(backup::MODULE, backup::SETTINGS);
        settings.register(messages::MODULE, messages::SETTINGS);
        settings.register(deadchat::MODULE, deadchat::SETTINGS);
        settings.register(timezones::MODULE, timezones::SETTINGS);
        settings.register(altwatch::MODULE, altwatch::SETTINGS);
        settings.register(plural::MODULE, plural::SETTINGS);
        settings.register(family::MODULE, family::SETTINGS);
        settings.register(achievements::MODULE, achievements::SETTINGS);
        settings.register(clips::MODULE, clips::SETTINGS);
        settings.register(botnews::MODULE, botnews::SETTINGS);
        settings.register(partyfinder::MODULE, partyfinder::SETTINGS);
        settings.register(quotes::MODULE, quotes::SETTINGS);
        settings.register(critters::MODULE, critters::SETTINGS);
        settings.register(integrations::MODULE, integrations::SETTINGS);
        settings.register(tts::MODULE, tts::SETTINGS);
        settings.register(tempvoice::MODULE, tempvoice::SETTINGS);
        settings.register(engagement::MODULE, engagement::SETTINGS);
        settings.register(stats::MODULE, stats::SETTINGS);
        settings.register(eclipseid::MODULE, eclipseid::SETTINGS);
        settings.register(roles::MODULE, roles::SETTINGS);
        settings.register(music::MODULE, music::SETTINGS);
        settings.register(casino::MODULE, casino::SETTINGS);
        Bot { db, settings, directory: Directory::default(), players: music::Players::default(), drafts: Default::default(), pulse: Default::default(), shield: Default::default() }
    }
    /// The bot is in this server. Its name is recorded, and a server it has never seen gets the starting set of
    /// modules turned on. A server that already made its choices (in Good Boy 3 or here) keeps them.
    pub fn on_server(&self, guild: &str, name: &str) {
        let db = self.db.get();
        let _ = db.upsert_guild(guild, name);
        for module in STARTING_MODULES {
            let _ = db.default_module(guild, module, true);
        }
    }
    /// `/help`: what this server can use, named the way members reach it (`/mod` then ban, `/rank`...). Only features
    /// that are switched on here are listed.
    pub fn help(&self, guild: &str) -> Card {
        let mut alone: Vec<String> = Vec::new();
        let mut grouped: std::collections::BTreeMap<&'static str, Vec<&'static str>> = std::collections::BTreeMap::new();
        for c in commands().filter(|c| !c.name.contains(' ')) {
            if c.module != notify::MODULE && !self.on(guild, c.module) { continue; }
            match crate::folds::group_of(c.name) {
                Some(g) => grouped.entry(g).or_default().push(c.name),
                None => alone.push(format!("`/{}`", c.name)),
            }
        }
        let mut card = Card::new(Area::General).title("Good Boy · what you can use here".to_string()).private();
        let mut any = false;
        for (group, about, _) in crate::folds::GROUPS {
            if let Some(names) = grouped.get(group) {
                any = true;
                card = card.line(format!("`/{group}` · {about}\n-# {}", names.join(" · ")));
            }
        }
        if !alone.is_empty() {
            any = true;
            alone.sort();
            card = card.line(format!("**Commands on their own**\n{}", alone.join(" ")));
        }
        if !any { card = card.line("No features are turned on yet. An admin can turn them on from the dashboard."); }
        card.line("-# Group commands (like `/mod`) open a menu: pick what you want from it. Staff-only ones only work for staff.")
    }
    fn on(&self, guild: &str, module: &str) -> bool {
        self.db.get().module_enabled(guild, module).unwrap_or(false)
    }
    /// A module runs for a server when the server turned it on and it is not switched off where this happened.
    fn runs(&self, guild: &str, module: &str, place: &Place) -> bool {
        self.on(guild, module) && !place.is_in(&self.settings.off_channels(guild, module))
    }
    /// Why a module's command or button cannot be used here, when it cannot.
    fn refused(&self, guild: &str, module: &str, place: &Place, member: &Member) -> Option<Action> {
        if !self.on(guild, module) {
            return Some(private(format!("{} turned off in this server.", friendly(module))));
        }
        // admins can always use a module, even in a channel it is switched off in (as in Good Boy 3)
        let admin = member.perms & (crate::perms::ADMINISTRATOR | crate::perms::MANAGE_GUILD) != 0;
        if !admin && place.is_in(&self.settings.off_channels(guild, module)) {
            return Some(private("That is switched off in this channel. Try it in another one."));
        }
        None
    }

    /// A message was posted. One pass through the modules that are on.
    pub fn on_message(&self, ev: &MessageEvent, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        self.pulse.message(&ev.guild);
        // every message in a ticket channel goes in the ticket archive first, the bot's own included (as in Good Boy 3)
        let kept = if self.on(&ev.guild, tickets::MODULE) { self.tickets(&ev.guild).on_message(ev) } else { Vec::new() };
        let mut out = self.on_message_rest(ev, roll);
        out.extend(kept);
        out
    }
    fn on_message_rest(&self, ev: &MessageEvent, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        // AutoMod goes first: a message it removes earns no XP and sets nothing off. A copy is kept for the
        // message log before that, so a removed message can still be shown.
        if self.on(&ev.guild, moderation::MODULE) {
            self.logs(&ev.guild).keep(&ev.id, &ev.place.channel, &ev.author, &ev.text, &ev.files, ev.at_ms);
            let caught = self.moderation(&ev.guild, &self.server_name(&ev.guild)).on_message(ev);
            if !caught.is_empty() {
                return caught;
            }
        }
        let mut actions = Vec::new();
        if self.runs(&ev.guild, levels::MODULE, &ev.place) {
            actions.extend(levels::on_message(&self.db, &self.settings, ev, roll));
        }
        if self.runs(&ev.guild, tags::MODULE, &ev.place) {
            actions.extend(tags::on_message(&self.db, &self.settings, ev, &self.server_name(&ev.guild), self.directory.members(&ev.guild), roll));
        }
        if self.on(&ev.guild, counting::MODULE) {
            actions.extend(counting::on_message(&self.db, &self.settings, ev));
        }
        if self.on(&ev.guild, welcome::MODULE) {
            actions.extend(self.members(&ev.guild, "").on_message(ev));
        }
        if self.runs(&ev.guild, money::MODULE, &ev.place) {
            actions.extend(self.economy(&ev.guild, "").on_message(ev, roll));
        }
        if self.on(&ev.guild, deadchat::MODULE) { self.deadchat(&ev.guild).on_message(ev); }
        if self.on(&ev.guild, plural::MODULE) { actions.extend(self.plural(&ev.guild).on_message(ev)); }
        if self.on(&ev.guild, clips::MODULE) { actions.extend(self.clips(&ev.guild).on_message(ev)); }
        if self.on(&ev.guild, stats::MODULE) { self.stats(&ev.guild, "").on_message(ev, ev.place.thread_of.as_deref()); }
        if self.on(&ev.guild, moderation::MODULE) { actions.extend(self.modplus(&ev.guild).on_message(ev)); }
        if self.on(&ev.guild, tts::MODULE) { actions.extend(self.tts(&ev.guild).on_message(ev)); }
        if self.runs(&ev.guild, critters::MODULE, &ev.place) { let mut rand = || roll(0, 999_999) as f64 / 1_000_000.0; actions.extend(self.critters(&ev.guild).on_message(ev, &mut rand)); }
        if self.on(&ev.guild, achievements::MODULE) {
            let server = self.server_name(&ev.guild);
            actions.extend(self.achievements(&ev.guild, &server).on_message(&ev.author, ev.at_ms));
        }
        if self.on(&ev.guild, messages::MODULE) {
            let me = self.directory.me();
            actions.extend(messages::on_message(&self.db, &self.settings, ev, me.as_deref()));
        }
        if self.on(&ev.guild, modmail::MODULE) {
            let server = self.server_name(&ev.guild);
            actions.extend(self.modmail(&ev.guild, &server).on_message(ev));
        }
        if self.on(&ev.guild, utility::MODULE) {
            let channel = self.directory.channels(&ev.guild).into_iter().find(|c| c.id == ev.place.channel).map(|c| c.name).unwrap_or_else(|| "a channel".into());
            actions.extend(utility::on_message(&self.db, &self.settings, ev, &channel, &self.server_name(&ev.guild)));
        }
        actions
    }

    fn fishing<'a>(&'a self, guild: &'a str) -> fish::Fishing<'a> {
        fish::Fishing { db: &self.db, settings: &self.settings, dir: &self.directory, guild }
    }
    /// A fishing cast reached its bite: the card to show (the Discord layer edits the player's message).
    pub fn fish_bite(&self, guild: &str, id: &str, now: i64) -> Option<Card> {
        self.fishing(guild).bite_card(id, now)
    }
    fn games<'a>(&'a self, guild: &'a str) -> casino::Games<'a> {
        casino::Games { db: &self.db, settings: &self.settings, guild }
    }
    fn modplus<'a>(&'a self, guild: &'a str) -> modplus::ModPlus<'a> {
        modplus::ModPlus { db: &self.db, settings: &self.settings, dir: &self.directory, guild }
    }
    fn moderation<'a>(&'a self, guild: &'a str, name: &'a str) -> moderation::Mod<'a> {
        moderation::Mod { db: &self.db, settings: &self.settings, dir: &self.directory, guild, guild_name: name }
    }
    fn logs<'a>(&'a self, guild: &'a str) -> logs::Logs<'a> {
        logs::Logs { db: &self.db, settings: &self.settings, guild }
    }
    /// A message was deleted (one, or several at once).
    pub fn on_messages_deleted(&self, guild: &str, channel: &str, ids: &[String]) -> Vec<Action> {
        if self.on(guild, tickets::MODULE) { for id in ids { self.tickets(guild).on_message_deleted(id); } }
        let mut out = Vec::new();
        if self.on(guild, counting::MODULE) { for id in ids { out.extend(counting::on_deleted(&self.db, guild, channel, id)); } }
        if self.on(guild, engagement::MODULE) { out.extend(self.engagement(guild).deleted(ids)); }
        if self.on(guild, partyfinder::MODULE) {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            out.extend(self.party(guild, "").deleted(ids, now, &|c| self.directory.in_voice(guild, c).len()));
        }
        if !self.on(guild, moderation::MODULE) { return out; }
        out.extend(match ids { [one] => self.logs(guild).deleted(channel, one), many => self.logs(guild).deleted_many(channel, many) });
        out
    }
    /// A message was edited.
    #[allow(clippy::too_many_arguments)]
    pub fn on_message_edited(&self, guild: &str, channel: &str, id: &str, author: &Member, text: &str, url: &str, at: i64) -> Vec<Action> {
        if self.on(guild, tickets::MODULE) && self.settings.bool(guild, tickets::MODULE, "archiveTickets") { self.tickets(guild).on_message_edited(id, text, at); }
        if !self.on(guild, moderation::MODULE) { return Vec::new(); }
        self.logs(guild).edited(channel, id, author, text, url, at)
    }
    /// A member's roles or nickname changed (or the bot saw them for the first time).
    pub fn on_member_changed(&self, guild: &str, member: &Member, nick: Option<&str>) -> Vec<Action> {
        self.roster(guild).see(member, true, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0));
        if !self.on(guild, moderation::MODULE) { return Vec::new(); }
        self.logs(guild).member_changed(member, nick)
    }
    /// Someone joined, left or moved voice channel (`None`: left voice). `quiet` only notes it (when connecting).
    pub fn on_voice(&self, guild: &str, member: &Member, channel: Option<&str>, quiet: bool) -> Vec<Action> {
        // who is where, for music (who can add songs, and who is listening)
        let before = self.directory.voice_of(guild, &member.id);
        self.directory.set_voice(guild, &member.id, channel);
        if quiet {
            if let Some(c) = channel {
                self.logs(guild).voice_seen(&member.id, c);
                if self.on(guild, stats::MODULE) { self.stats(guild, "").voice_seen(&member.id, c, self.directory.afk_channel(guild).as_deref(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)); }
            }
            return Vec::new();
        }
        let mut out = Vec::new();
        if self.on(guild, stats::MODULE) {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            self.stats(guild, "").on_voice(member, before.as_deref(), channel, self.directory.afk_channel(guild).as_deref(), now);
        }
        if self.on(guild, tempvoice::MODULE) {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            out.extend(self.tempvoice(guild).on_voice(member, before.as_deref(), channel, now));
        }
        if self.on(guild, achievements::MODULE) {
            let server = self.server_name(guild);
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            let afk = self.directory.afk_channel(guild);
            out.extend(self.achievements(guild, &server).on_voice(member, channel, afk.as_deref(), now));
        }
        if self.on(guild, moderation::MODULE) { out.extend(self.logs(guild).voice(member, channel)); }
        out
    }
    fn music<'a>(&'a self, guild: &'a str) -> music::Music<'a> {
        self.music_slot(guild, 0)
    }
    fn music_slot<'a>(&'a self, guild: &'a str, slot: usize) -> music::Music<'a> {
        music::Music { db: &self.db, settings: &self.settings, dir: &self.directory, players: &self.players, guild, slot }
    }
    /// The main player of a server, as the launcher shows it.
    pub fn music_view(&self, guild: &str, now: i64) -> serde_json::Value {
        self.music(guild).view(now)
    }
    /// The launcher's Music page asks the way Good Boy 3's dashboard did: a view by name, or an action with a body.
    /// Gives the answer and what the voice layer and Discord must do.
    pub fn music_api(&self, guild: &str, kind: &str, name: &str, args: &serde_json::Value, now: i64) -> Result<(serde_json::Value, Vec<Action>), String> {
        if !self.on(guild, music::MODULE) { return Err("Music is turned off in this server. Turn it on first.".into()); }
        let m = self.music(guild);
        match kind { "view" => m.dash_view(name, args, now).map(|v| (v, Vec::new())), _ => m.dash_action(name, args, now) }
    }
    /// What the launcher's Economy page shows: the treasury, where it comes from, the newest lines of its record,
    /// the rates in force and who holds the most of the second currency.
    pub fn economy_view(&self, guild: &str, now: i64) -> serde_json::Value {
        let db = self.db.get();
        let t = db.treasury(guild).unwrap_or_default();
        let log = db.treasury_log(guild, 30).unwrap_or_default();
        let week = db.treasury_by_kind(guild, now - 7 * 86_400_000).unwrap_or_default();
        let month = db.treasury_by_kind(guild, now - 30 * 86_400_000).unwrap_or_default();
        let gems = db.top_gems(guild, 5).unwrap_or_default();
        let wallets = db.wallet_count(guild).unwrap_or(0);
        drop(db);
        let s = |k: &str| self.settings.get(guild, money::MODULE, k);
        serde_json::json!({
            "on": self.on(guild, money::MODULE), "treasury": t, "log": log, "week": week, "month": month, "wallets": wallets,
            "top_gems": gems.into_iter().map(|(user, gems)| serde_json::json!({ "user": user, "gems": gems })).collect::<Vec<_>>(),
            "rates": { "taxPay": s("taxPay"), "taxIncome": s("taxIncome"), "taxWithdraw": s("taxWithdraw"), "taxWinnings": s("taxWinnings"), "shopToTreasury": s("shopToTreasury"),
                "gemsEnabled": s("gemsEnabled"), "gemName": s("gemName"), "gemEmoji": s("gemEmoji"), "exchangeRate": s("exchangeRate"), "exchangeFee": s("exchangeFee"), "currencyName": s("currencyName"), "currencyEmoji": s("currencyEmoji") },
        })
    }
    /// Pays coins from the treasury to a member, chosen in the launcher. Gives what the treasury has left.
    pub fn economy_give(&self, guild: &str, user: &str, amount: i64, reason: &str, now: i64) -> Result<i64, String> {
        if !self.on(guild, money::MODULE) { return Err("Money is turned off in this server. Turn it on first.".into()); }
        if user.is_empty() || !user.bytes().all(|b| b.is_ascii_digit()) { return Err("That is not a member's Discord ID.".into()); }
        if reason.trim().is_empty() { return Err("Give a reason: it is kept in the treasury's record.".into()); }
        let server = self.server_name(guild);
        self.economy(guild, &server).treasury_give(&self.directory.bot_owner().unwrap_or_default(), user, amount, &crate::welcome::sanitize_name(reason.trim(), 120), now).map(|(left, _)| left)
    }
    /// Discord could not find the message a reaction role was set on: nothing stays saved for it.
    pub fn reaction_role_undo(&self, guild: &str, message: &str, emoji: &str) {
        self.roles(guild).reaction_role_undo(message, emoji);
    }
    /// A ticket action chosen in the launcher (claim, reply, close), run as the bot's owner.
    /// `actor`: the moderator doing it (their Discord id and name), when someone signed in on the web; None is the owner.
    pub fn ticket_action(&self, guild: &str, number: i64, what: &str, text: &str, actor: Option<(&str, &str)>, now: i64) -> Result<(String, Vec<Action>), String> {
        if !self.on(guild, tickets::MODULE) { return Err("Tickets are turned off in this server. Turn them on first.".into()); }
        let owner = self.directory.bot_owner().unwrap_or_default();
        let (by, name) = actor.map(|(i, n)| (i.to_string(), n.to_string())).unwrap_or_else(|| { let n = self.db.get().roster_names(guild, std::slice::from_ref(&owner)).ok().and_then(|m| m.get(&owner).cloned()).unwrap_or_default(); (owner.clone(), n) });
        self.tickets(guild).from_launcher(number, what, text, &by, &name, now)
    }
    /// A restart heads-up for one server's announcements channel (nothing when it has none).
    pub fn restart_notice(&self, guild: &str, minutes: u64) -> Vec<Action> {
        self.botnews(guild).restart_notice(minutes)
    }
    /// Every ticket for the dashboard's list (see `Tickets::launcher_rows`).
    pub fn ticket_rows(&self, guild: &str) -> Vec<serde_json::Value> {
        self.tickets(guild).launcher_rows()
    }
    /// A ticket's transcript as a file (text or HTML), for the dashboard's Save button.
    pub fn ticket_transcript(&self, guild: &str, number: i64, html: bool) -> Option<(String, String)> {
        self.tickets(guild).launcher_transcript(number, html, &self.server_name(guild))
    }
    /// One ticket with its conversation, for the dashboard's ticket view.
    pub fn ticket_thread(&self, guild: &str, number: i64) -> Option<serde_json::Value> {
        self.tickets(guild).launcher_thread(number)
    }
    /// Two weeks of members, voice and messages by the hour, for the Home page's small charts.
    pub fn history(&self, guild: &str, now: i64) -> serde_json::Value {
        crate::pulse::Pulse::history(&self.db, guild, now)
    }
    /// The numbers at the top of Home, live: members, people in voice now, messages today and when the bot started.
    pub fn live_numbers(&self, guild: &str) -> serde_json::Value {
        serde_json::json!({ "members": self.directory.members(guild), "voice": self.directory.voice_count(guild) })
    }
    /// One of the list pages (giveaways, custom commands, backups, top inviters, counting games), as data.
    pub fn panel_view(&self, guild: &str, panel: &str) -> Result<serde_json::Value, String> {
        let mut v = crate::panels::view(&self.db, guild, panel)?;
        let names: std::collections::HashMap<String, String> = self.directory.channels(guild).into_iter().map(|c| (c.id, c.name)).collect();
        if let Some(rows) = v["rows"].as_array_mut() {
            for r in rows.iter_mut() { if let Some(c) = r["channel"].as_str().and_then(|c| names.get(c)).cloned() { r["title"] = serde_json::json!(format!("#{c}")); } }
        }
        Ok(v)
    }
    /// An action on one row of a list page. Gives the actions to carry out in Discord.
    pub fn panel_action(&self, guild: &str, panel: &str, row: &str, action: &str, now: i64) -> Result<Vec<Action>, String> {
        let pay = self.on(guild, money::MODULE);
        crate::panels::act(&self.db, guild, panel, row, action, pay, now, &mut |lo, hi| roll_between(lo, hi))
    }
    /// Every permission a server can hand out, with who has it now: plain words, the roles it is given to, and its default.
    pub fn permissions_view(&self, guild: &str) -> serde_json::Value {
        let list: Vec<serde_json::Value> = serde_json::from_str(include_str!("../assets/permissions.json")).unwrap_or_default();
        let db = self.db.get();
        let rows: Vec<serde_json::Value> = list.into_iter().map(|mut p| {
            let key = p["key"].as_str().unwrap_or("").to_string();
            p["roles"] = serde_json::json!(db.perm_roles(guild, &key).unwrap_or_default());
            p
        }).collect();
        drop(db);
        serde_json::json!({ "permissions": rows, "roles": self.directory.roles(guild).into_iter().map(|r| serde_json::json!({ "id": r.id, "name": r.name })).collect::<Vec<_>>() })
    }
    /// The permissions that belong to one module, with the roles chosen for each.
    pub fn module_permissions(&self, guild: &str, module: &str) -> Vec<serde_json::Value> {
        self.permissions_view(guild)["permissions"].as_array().map(|l| l.iter().filter(|p| p["group"] == module).cloned().collect()).unwrap_or_default()
    }
    /// Gives a permission to these roles. Only permissions that exist can be set, and only roles of this server.
    pub fn permission_set(&self, guild: &str, key: &str, roles: &[String]) -> Result<(), String> {
        let list: Vec<serde_json::Value> = serde_json::from_str(include_str!("../assets/permissions.json")).unwrap_or_default();
        if !list.iter().any(|p| p["key"] == key) { return Err("That permission does not exist.".into()); }
        if let Some(bad) = roles.iter().find(|r| self.directory.role(guild, r).is_none()) { return Err(format!("{bad} is not a role in this server.")); }
        self.db.get().set_perm_roles(guild, key, roles).map_err(|e| e.to_string())
    }
    /// The role menus as the launcher shows them.
    pub fn role_menus(&self, guild: &str) -> serde_json::Value {
        let names: std::collections::HashMap<String, String> = self.directory.channels(guild).into_iter().map(|c| (c.id, c.name)).collect();
        let mut menus = self.roles(guild).menu_list();
        for m in menus.iter_mut() { let n = m["channel"].as_str().and_then(|c| names.get(c)).cloned(); m["channel_name"] = serde_json::json!(n); }
        serde_json::json!({ "menus": menus })
    }
    /// Takes a role menu away: its message is deleted and its buttons stop working.
    pub fn role_menu_delete(&self, guild: &str, message: &str) -> Result<Vec<Action>, String> {
        let channel = self.roles(guild).menu_remove(message).ok_or("That menu is already gone.")?;
        Ok(if channel.is_empty() { Vec::new() } else { vec![Action::Delete { channel, message: message.to_string() }] })
    }
    /// The shop as the launcher shows it: every item, the server's roles to pick from, and the limit.
    pub fn shop_view(&self, guild: &str) -> serde_json::Value {
        let items = self.db.get().shop_items(guild).unwrap_or_default();
        serde_json::json!({ "items": items, "roles": self.directory.roles(guild), "max": economy::SHOP_MAX })
    }
    /// Adds or changes a shop item from the launcher, with the same rules as the shop form in Discord.
    #[allow(clippy::too_many_arguments)]
    pub fn shop_save(&self, guild: &str, name: &str, price: i64, emoji: &str, role: Option<&str>, hours: i64, stock: Option<i64>, text: &str, consumable: bool) -> Result<String, String> {
        let name: String = name.trim().chars().take(60).collect();
        let id = economy::slug(&name);
        if id.is_empty() { return Err("Give the item a name with letters or numbers.".into()); }
        if id == economy::SHIELD_ID || id == economy::PADLOCK_ID { return Err("That name is used by a built-in item.".into()); }
        if price < 1 { return Err("The price must be at least 1.".into()); }
        let role = role.filter(|r| !r.is_empty());
        if let Some(r) = role {
            let Some(facts) = self.directory.role(guild, r) else { return Err("That role does not exist any more.".into()) };
            if facts.managed || self.directory.my_top(guild).is_some_and(|top| facts.position >= top) { return Err("I can't give that role: my role must be above it (Server Settings > Roles).".into()); }
        }
        let text: String = text.trim().chars().take(if role.is_some() { 200 } else { 500 }).collect();
        let it = gb_data::ShopItem {
            id: id.clone(), name: name.clone(), emoji: Some(emoji.trim().chars().take(64).collect::<String>()).filter(|e| !e.is_empty()), price,
            description: if role.is_some() { Some(text.clone()).filter(|t| !t.is_empty()) } else { None }, role_id: role.map(str::to_string),
            hours: if role.is_some() { hours.clamp(0, 8760) } else { 0 }, stock: stock.filter(|n| *n >= 0),
            message: if role.is_some() { None } else { Some(text).filter(|t| !t.is_empty()) }, consumable: role.is_none() && consumable,
        };
        let exists = self.db.get().shop_item(guild, &id).ok().flatten().is_some();
        if !exists && self.db.get().shop_items(guild).unwrap_or_default().len() >= economy::SHOP_MAX { return Err(format!("The shop can hold up to {} items.", economy::SHOP_MAX)); }
        let replaced = self.db.get().shop_put(guild, &it).map_err(|e| e.to_string())?;
        Ok(if replaced { format!("Updated {name}.") } else { format!("Added {name} to the shop.") })
    }
    pub fn shop_remove(&self, guild: &str, id: &str) -> Result<(), String> {
        if self.db.get().shop_remove(guild, id).unwrap_or(false) { Ok(()) } else { Err("That item is not in the shop.".into()) }
    }
    /// Checks that a typed search or link may be looked up on music sites here.
    pub fn music_site_search_ok(&self, guild: &str, q: &str) -> Result<(), String> {
        if !self.on(guild, music::MODULE) { return Err("Music is turned off in this server. Turn it on first.".into()); }
        self.music(guild).dash_site_search_ok(q)
    }
    /// What a site search found, shaped for the Music page.
    pub fn music_results(&self, guild: &str, tracks: &[music::Track], list_name: Option<&str>) -> serde_json::Value {
        self.music(guild).dash_results(tracks, list_name, None)
    }
    /// Saves a playlist read from a music site.
    pub fn music_import(&self, guild: &str, name: &str, tracks: &[music::Track], now: i64) -> Result<serde_json::Value, String> {
        self.music(guild).dash_import(name, tracks, now)
    }
    /// A player control chosen in the launcher (pause, skip, back, stop, repeat, shuffle, volume, remove).
    pub fn music_do(&self, guild: &str, what: &str, arg: Option<i64>, now: i64) -> Result<(String, Vec<Action>), String> {
        if !self.on(guild, music::MODULE) { return Err("Music is turned off in this server. Turn it on first.".into()); }
        self.music(guild).from_launcher(what, arg, now)
    }
    /// Which of the server's music bots should handle this member: the one already in their voice channel, else (when
    /// `free` is set) the first one that is not busy, else the main bot.
    fn pick_slot(&self, guild: &str, member: &str, free: bool) -> usize {
        let slots = self.directory.slots(guild);
        if slots.len() == 1 { return 0; }
        let mine = self.directory.voice_of(guild, member);
        let state = |s: usize| self.players.with(&music::slot_key(guild, s), |p| (p.voice.clone(), p.now.is_some() || !p.queue.is_empty()));
        if let Some(v) = &mine {
            if let Some(s) = slots.iter().copied().find(|s| state(*s).0.as_ref() == Some(v)) { return s; }
        }
        if free {
            if let Some(s) = slots.iter().copied().find(|s| { let (v, busy) = state(*s); v.is_none() && !busy }) { return s; }
        }
        0
    }
    /// What a music lookup found. The first action is for the person who asked.
    pub fn on_music_found(&self, guild: &str, slot: usize, by: &str, result: Result<Vec<music::Track>, String>, now_ms: i64) -> Vec<Action> {
        self.music_slot(guild, slot).found(by, result, now_ms)
    }
    /// News about the song playing in a server (started, ended, failed).
    pub fn on_music(&self, guild: &str, slot: usize, what: music::Heard, now_ms: i64) -> Vec<Action> {
        match &what {
            music::Heard::TtsEnded(id) => return self.tts(guild).heard(*id, None, now_ms),
            music::Heard::TtsFailed(id, why) => return self.tts(guild).heard(*id, Some(why), now_ms),
            music::Heard::Left if slot == 0 => self.tts(guild).left(),
            _ => {}
        }
        self.music_slot(guild, slot).heard(what, now_ms)
    }
    /// Every few seconds: music players move their progress bar, and leave voice when they have been idle a while.
    pub fn on_music_tick(&self, now_ms: i64) -> Vec<(String, Action)> {
        self.players.guilds().into_iter().flat_map(|key| {
            let (g, slot) = music::split_key(&key);
            let g = g.to_string();
            self.music_slot(&g, slot).tick(now_ms).into_iter().map(move |a| (g.clone(), a)).collect::<Vec<_>>()
        }).collect()
    }
    fn roster<'a>(&'a self, guild: &'a str) -> roster::Roster<'a> {
        roster::Roster { db: &self.db, settings: &self.settings, guild }
    }
    /// The first look at a server's members (when the bot connects, or after a scan): names for the launcher.
    pub fn roster_seed(&self, guild: &str, members: &[Member]) {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        self.roster(guild).seed(members, now);
    }
    /// Discord banned someone (a moderator's click, another bot, or this one).
    pub fn on_ban(&self, guild: &str, user: &str, name: &str) {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        self.roster(guild).banned(user, name, now);
    }
    /// Names for some member ids: the roster's, then whatever was seen this session. Ids nobody knows are left out.
    pub fn member_names(&self, guild: &str, ids: &[String]) -> std::collections::HashMap<String, String> {
        let mut out = self.db.get().roster_names(guild, ids).unwrap_or_default();
        for id in ids { if !out.contains_key(id) { if let Some(n) = self.db.seen().name(guild, id) { out.insert(id.clone(), n); } } }
        out
    }
    /// Members whose name matches, for a picker (bots only when asked for).
    pub fn member_search(&self, guild: &str, q: &str, bots: bool, limit: usize) -> Vec<gb_data::roster::Known> {
        self.db.get().roster_search(guild, q, bots, limit).unwrap_or_default()
    }
    /// Who left in the last `days` days (never more than the server keeps), newest first.
    pub fn leavers(&self, guild: &str, days: i64, q: &str, now: i64) -> serde_json::Value {
        let r = self.roster(guild);
        let keep = r.days();
        let days = days.clamp(1, keep);
        let list = self.db.get().roster_leaves(guild, now - days * 86_400_000, q, 500).unwrap_or_default();
        let roles: std::collections::HashMap<String, String> = self.directory.roles(guild).into_iter().map(|r| (r.id, r.name)).collect();
        serde_json::json!({ "keeps": r.keeps_records(), "days": keep, "leavers": list, "members": self.db.get().roster_count(guild).unwrap_or(0), "roles": roles })
    }
    /// The welcome or goodbye picture, as kept (file name and bytes).
    pub fn greeting_image(&self, guild: &str, kind: &str) -> Option<(String, Vec<u8>)> {
        self.members(guild, "").greeting_image(kind)
    }
    pub fn greeting_image_set(&self, guild: &str, kind: &str, name: &str, bytes: &[u8], now: i64) -> Result<(), String> {
        self.members(guild, "").greeting_image_set(kind, name, bytes, now)
    }
    pub fn greeting_image_clear(&self, guild: &str, kind: &str) -> Result<(), String> {
        self.members(guild, "").greeting_image_clear(kind)
    }
    /// The server's own critter characters (each with its uploaded picture's name and bytes, when it has one).
    pub fn critter_roster(&self, guild: &str) -> Vec<(critters::Character, Option<critters::StoredPicture>)> {
        let c = self.critters(guild);
        c.roster().into_iter().map(|ch| { let pic = c.picture_file(&ch); (ch, pic) }).collect()
    }
    #[allow(clippy::too_many_arguments)]
    pub fn critter_save(&self, guild: &str, editing: Option<&str>, name: &str, element: &str, rarity: &str, stats: [i64; 4], picture: critters::Picture) -> Result<String, String> {
        self.critters(guild).roster_save(editing, name, element, rarity, stats, picture)
    }
    pub fn critter_remove(&self, guild: &str, id: &str) -> Result<String, String> {
        self.critters(guild).roster_remove(id)
    }
    /// Forgets everything kept about one person.
    pub fn roster_forget(&self, guild: &str, user: &str) -> usize {
        self.db.get().roster_forget(guild, user).unwrap_or(0)
    }
    fn economy<'a>(&'a self, guild: &'a str, server: &'a str) -> economy::Economy<'a> {
        economy::Economy { db: &self.db, settings: &self.settings, dir: &self.directory, guild, server }
    }
    fn members<'a>(&'a self, guild: &'a str, server: &'a str) -> welcome::Members<'a> {
        welcome::Members { db: &self.db, settings: &self.settings, dir: &self.directory, guild, server }
    }
    /// A roleplay action with its GIF (or none), as the message to post: the card and who it may ping.
    pub fn rp_post(&self, guild: &str, action: &str, from: &str, to: Option<&str>, gif: Option<&str>, me: Option<&str>) -> Option<(Card, Vec<String>)> {
        roleplay::post(&self.db, &self.settings, guild, action, from, to, gif, me)
    }
    /// A snapshot of the server's layout was made for `/backup create` (or the weekly one, `by` "auto").
    pub fn backup_saved(&self, guild: &str, by: &str, data: &serde_json::Value, now: i64) -> Card {
        backup::saved(&self.db, guild, by, data, now)
    }
    pub fn backup_preview(&self, guild: &str, id: i64, owner: &str, now_layout: &serde_json::Value) -> Card {
        backup::preview(&self.db, guild, id, owner, now_layout)
    }
    /// A backup's layout, and what of it is missing from the server now.
    pub fn backup_plan(&self, guild: &str, id: i64, now_layout: &serde_json::Value) -> Option<(Vec<serde_json::Value>, Vec<serde_json::Value>)> {
        let (_, data) = self.db.get().backup(guild, id).ok().flatten()?;
        Some(backup::plan(&serde_json::from_str(&data).ok()?, now_layout))
    }
    /// Something asked for with `Action::Later` is due now (a sticky message's quiet moment).
    pub fn on_later(&self, guild: &str, note: &str) -> Vec<Action> {
        if note.starts_with("crit:") { return self.critters(guild).later(note); }
        if note.starts_with("tv:") {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            return self.tempvoice(guild).later(note, now);
        }
        if !self.on(guild, messages::MODULE) { return Vec::new(); }
        messages::fire(&self.db, guild, note)
    }
    /// Servers due their weekly backup.
    pub fn weekly_backups_due(&self, now: i64) -> Vec<String> {
        // the list first, then let go of the database: checking each server reads it again
        let all = self.db.get().guilds().unwrap_or_default();
        let guilds: Vec<String> = all.into_iter().map(|g| g.id).filter(|g| self.on(g, backup::MODULE)).collect();
        backup::weekly_due(&self.db, &self.settings, &guilds, now)
    }
    fn modmail<'a>(&'a self, guild: &'a str, server: &'a str) -> modmail::Modmail<'a> {
        modmail::Modmail { db: &self.db, settings: &self.settings, guild, server }
    }
    /// The servers a member's DM could go to: (server, name, has an open conversation). `shared`: the servers the
    /// member and the bot are both in.
    pub fn modmail_servers(&self, user: &str, shared: &[String]) -> Vec<(String, String, bool)> {
        shared.iter().filter(|g| self.on(g, modmail::MODULE)).filter_map(|g| {
            let name = self.server_name(g);
            let m = self.modmail(g, &name);
            m.ready().then(|| (g.clone(), name.clone(), m.has_open(user)))
        }).collect()
    }
    /// A member's DM for one server's staff.
    pub fn on_dm(&self, guild: &str, dm: &modmail::Dm) -> Vec<Action> {
        if !self.on(guild, modmail::MODULE) { return Vec::new(); }
        let server = self.server_name(guild);
        self.modmail(guild, &server).from_dm(dm)
    }
    /// A thread the bot opened exists now (a modmail conversation).
    pub fn on_thread_made(&self, guild: &str, note: &str, thread: &str, now: i64) -> Vec<Action> {
        let server = self.server_name(guild);
        self.modmail(guild, &server).thread_made(note, thread, now)
    }
    /// Someone joined and the invite they used was worked out (see `invites::used_invite`).
    pub fn on_invite_join(&self, guild: &str, member: &Member, used: Option<(String, Option<String>, bool)>, now: i64) -> Vec<Action> {
        if !self.on(guild, invites::MODULE) { return Vec::new(); }
        invites::joined(&self.db, &self.settings, guild, member, used, now)
    }
    /// Whether invite tracking is on in a server (the Discord layer then keeps the invite counts).
    pub fn tracks_invites(&self, guild: &str) -> bool {
        self.on(guild, invites::MODULE)
    }
    /// A role the bot made (a profile role) exists now.
    pub fn on_role_made(&self, guild: &str, note: &str, role: &str, now: i64) -> Vec<Action> {
        if note == "deadchat:role" { return self.deadchat(guild).role_made(role); }
        self.members(guild, "").role_made(note, role, now);
        Vec::new()
    }
    fn community<'a>(&'a self, guild: &'a str) -> community::Community<'a> {
        community::Community { db: &self.db, settings: &self.settings, dir: &self.directory, guild }
    }
    /// Someone reacted to a message: a little XP (reaction XP). `author` is who wrote the message, when known.
    pub fn on_reaction_xp(&self, guild: &str, who: &Member, author: Option<&str>, place: &Place, now: i64) -> Vec<Action> {
        if !self.runs(guild, levels::MODULE, place) { return Vec::new(); }
        self.community(guild).on_reaction(who, author, place, now)
    }
    fn stats<'a>(&'a self, guild: &'a str, server: &'a str) -> stats::Stats<'a> {
        stats::Stats { db: &self.db, settings: &self.settings, guild, server }
    }
    /// The member list was read for the inactive-members tools (`Action::Inactive`).
    pub fn inactive(&self, guild: &str, ask: &stats::InactiveAsk, facts: &[stats::MemberFact], now: i64) -> Vec<Action> {
        // a scan reads the whole member list, so the launcher learns every name from it
        let members: Vec<Member> = facts.iter().map(|f| Member { id: f.id.clone(), name: f.name.clone(), roles: f.roles.clone(), bot: f.bot, joined_at: f.joined_at, ..Default::default() }).collect();
        self.roster(guild).seed(&members, now);
        if !self.on(guild, stats::MODULE) { return Vec::new(); }
        let server = self.server_name(guild);
        self.stats(guild, &server).inactive(ask, facts, now)
    }
    /// Protects a member from the inactive list (or stops protecting them). The launcher's way of `/stats keep`.
    pub fn inactive_keep(&self, guild: &str, user: &str, keep: bool, now: i64) -> Result<(), String> {
        if !self.on(guild, stats::MODULE) { return Err("Statistics are turned off in this server. Turn them on first.".into()); }
        if user.is_empty() || !user.bytes().all(|b| b.is_ascii_digit()) { return Err("That is not a member's Discord ID.".into()); }
        let server = self.server_name(guild);
        self.stats(guild, &server).keep_set(user, &self.directory.bot_owner().unwrap_or_default(), keep, now);
        Ok(())
    }
    /// What the launcher's Inactive page shows: the last scan, who is kept, who was removed, and the rules in force.
    pub fn inactive_view(&self, guild: &str) -> serde_json::Value {
        let server = self.server_name(guild);
        let st = self.stats(guild, &server);
        let d = crate::store::Data { db: &self.db, guild, module: stats::MODULE };
        let s = |k: &str| self.settings.get(guild, stats::MODULE, k);
        serde_json::json!({
            "on": self.on(guild, stats::MODULE),
            "snapshot": d.get("inactive:snapshot"),
            "keeps": st.keeps().into_iter().map(|(id, at)| serde_json::json!({ "id": id, "at": at })).collect::<Vec<_>>(),
            "log": d.get("pruneLog").unwrap_or_else(|| serde_json::json!([])),
            "rules": { "days": s("inactiveDays"), "ghostDays": s("inactiveGhostDays"), "protectMessages": s("inactiveProtectMessages"), "unverifiedDays": s("inactiveUnverifiedDays"), "warn": s("inactiveWarn"), "auto": s("inactiveAuto"), "autoMax": s("inactiveAutoMax"), "grace": s("inactiveGrace"), "reviewChannel": s("reviewChannel") },
        })
    }
    /// Counting older messages finished (`Action::Backfill`).
    pub fn backfilled(&self, guild: &str, result: serde_json::Value, users: &[(String, String, i64)], channels: &[(String, String, i64)], hours: &[(i64, i64)]) {
        let server = self.server_name(guild);
        self.stats(guild, &server).backfilled(result, users, channels, hours);
    }
    /// What the history count needs to know: (time zone offset, when live counting began, opted-out members, ignored channels).
    pub fn counting_rules(&self, guild: &str) -> (i64, i64, std::collections::HashSet<String>, Vec<String>) {
        let server = self.server_name(guild);
        self.stats(guild, &server).counting_rules()
    }
    fn engagement<'a>(&'a self, guild: &'a str) -> engagement::Engagement<'a> {
        engagement::Engagement { db: &self.db, settings: &self.settings, guild }
    }
    /// A star-emoji message was read and its stars counted (`Action::StarCheck`).
    pub fn on_star(&self, guild: &str, info: &engagement::StarInfo) -> Vec<Action> {
        if !self.on(guild, engagement::MODULE) { return Vec::new(); }
        self.engagement(guild).starred(info)
    }
    /// Like `on_reaction`, knowing which channel it happened in (the starboard needs it).
    pub fn on_reaction_at(&self, guild: &str, channel: &str, message: &str, emoji: &str, user: &str, add: bool) -> Vec<Action> {
        let mut out = self.on_reaction(guild, message, emoji, user, add);
        if self.on(guild, engagement::MODULE) { out.extend(self.engagement(guild).on_reaction(Some(channel), message, emoji)); }
        out
    }
    fn tempvoice<'a>(&'a self, guild: &'a str) -> tempvoice::TempVoice<'a> {
        tempvoice::TempVoice { db: &self.db, settings: &self.settings, dir: &self.directory, guild }
    }
    /// A temporary room was made (`Action::OpenRoom`).
    pub fn on_room_made(&self, guild: &str, note: &str, channel: &str) -> Vec<Action> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        self.tempvoice(guild).room_made(note, channel, now)
    }
    /// The first person could not be moved into a new room: it is removed again.
    pub fn on_room_unused(&self, guild: &str, channel: &str) -> Vec<Action> {
        self.tempvoice(guild).room_unused(channel)
    }
    fn tts<'a>(&'a self, guild: &'a str) -> tts::Tts<'a> {
        tts::Tts { db: &self.db, settings: &self.settings, dir: &self.directory, guild }
    }
    fn integrations<'a>(&'a self, guild: &'a str) -> integrations::Integrations<'a> {
        integrations::Integrations { db: &self.db, settings: &self.settings, guild }
    }
    /// A new feed was looked up (`Fetch::Add`).
    #[allow(clippy::too_many_arguments)]
    pub fn feed_added(&self, guild: &str, provider: &str, target: &str, channel: &str, template: Option<&str>, by: &str, items: Result<Vec<integrations::FeedItem>, String>, now: i64) -> Card {
        self.integrations(guild).added(provider, target, channel, template, by, items, now)
    }
    /// A feed was checked (`Fetch::Poll`).
    pub fn feed_polled(&self, guild: &str, key: &str, items: Result<Vec<integrations::FeedItem>, String>, now: i64) -> Vec<Action> {
        if !self.on(guild, integrations::MODULE) { return Vec::new(); }
        self.integrations(guild).polled(key, items, now)
    }
    /// An inbound webhook was called: what to post, or None when the address is wrong.
    pub fn on_webhook(&self, guild: &str, token: &str, body: &serde_json::Value) -> Option<Action> {
        if !self.on(guild, integrations::MODULE) { return None; }
        self.integrations(guild).webhook(token, body)
    }
    fn critters<'a>(&'a self, guild: &'a str) -> critters::Critters<'a> {
        critters::Critters { db: &self.db, settings: &self.settings, guild, money: self.on(guild, money::MODULE) }
    }
    fn party<'a>(&'a self, guild: &'a str, server: &'a str) -> partyfinder::PartyFinder<'a> {
        partyfinder::PartyFinder { db: &self.db, settings: &self.settings, guild, server, directory: &self.directory }
    }
    fn botnews<'a>(&'a self, guild: &'a str) -> botnews::BotNews<'a> {
        botnews::BotNews { db: &self.db, settings: &self.settings, guild }
    }
    /// The bot started: bot news in each server that has it (updates since it last heard, new modules).
    pub fn on_started(&self, now: i64) -> Vec<(String, Action)> {
        let modules: Vec<(&str, &str)> = MODULES.iter().map(|m| (m.id, m.about)).collect();
        let all = self.db.get().guilds().unwrap_or_default();
        all.into_iter().filter(|g| self.on(&g.id, botnews::MODULE))
            .flat_map(|g| self.botnews(&g.id).started(botnews::VERSION, botnews::CHANGELOG, &modules, now).into_iter().map(move |a| (g.id.clone(), a)).collect::<Vec<_>>())
            .collect()
    }
    /// A module was turned on or off for a server (from the launcher): the module is switched, and bot news is told.
    pub fn set_module(&self, guild: &str, module: &str, on: bool, now: i64) -> Result<Vec<Action>, String> {
        let was = self.on(guild, module);
        self.db.get().set_module_enabled(guild, module, on).map_err(|e| e.to_string())?;
        if was == on || !self.on(guild, botnews::MODULE) { return Ok(Vec::new()); }
        Ok(self.botnews(guild).module_changed(module, on, now))
    }
    fn clips<'a>(&'a self, guild: &'a str) -> clips::Clips<'a> {
        clips::Clips { db: &self.db, settings: &self.settings, guild, money: self.on(guild, money::MODULE) }
    }
    /// Discord found a message's link title (a clip's), a moment after it was posted or with it.
    pub fn on_embed(&self, guild: &str, channel: &str, message: &str, title: &str, url: Option<&str>) {
        if self.on(guild, clips::MODULE) { self.clips(guild).on_embed(channel, message, title, url); }
    }
    /// The votes on a clip were counted (`Action::CountVotes`).
    pub fn clip_votes(&self, guild: &str, message: &str, votes: i64) -> Vec<Action> {
        if !self.on(guild, clips::MODULE) { return Vec::new(); }
        self.clips(guild).counted(message, votes)
    }
    fn achievements<'a>(&'a self, guild: &'a str, server: &'a str) -> achievements::Achievements<'a> {
        achievements::Achievements { db: &self.db, settings: &self.settings, guild, server }
    }
    fn family<'a>(&'a self, guild: &'a str) -> family::Family<'a> {
        family::Family { db: &self.db, settings: &self.settings, guild }
    }
    fn plural<'a>(&'a self, guild: &'a str) -> plural::Plural<'a> {
        plural::Plural { db: &self.db, settings: &self.settings, guild }
    }
    fn altwatch<'a>(&'a self, guild: &'a str) -> altwatch::AltWatch<'a> {
        altwatch::AltWatch { db: &self.db, settings: &self.settings, guild }
    }
    fn timezones<'a>(&'a self, guild: &'a str) -> timezones::TimeZones<'a> {
        timezones::TimeZones { db: &self.db, settings: &self.settings, guild }
    }
    fn deadchat<'a>(&'a self, guild: &'a str) -> deadchat::DeadChat<'a> {
        deadchat::DeadChat { db: &self.db, settings: &self.settings, dir: &self.directory, guild }
    }
    fn roles<'a>(&'a self, guild: &'a str) -> roles::Roles<'a> {
        roles::Roles { db: &self.db, dir: &self.directory, guild }
    }
    /// What someone is playing changed (game roles).
    pub fn on_playing(&self, guild: &str, member: &Member, before: &[String], now: &[String]) -> Vec<Action> {
        if !self.on(guild, roles::MODULE) { return Vec::new(); }
        self.roles(guild).playing(member, before, now, self.settings.bool(guild, roles::MODULE, "gameRoleRemove"))
    }
    /// Someone reacted on a message, or took a reaction off.
    pub fn on_reaction(&self, guild: &str, message: &str, emoji: &str, user: &str, add: bool) -> Vec<Action> {
        let mut out = Vec::new();
        if add && self.on(guild, stats::MODULE) && self.directory.me().as_deref() != Some(user) {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            self.stats(guild, "").on_reaction(user, now);
        }
        if add && self.on(guild, achievements::MODULE) && self.directory.me().as_deref() != Some(user) {
            let server = self.server_name(guild);
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            out.extend(self.achievements(guild, &server).on_reaction(&Member { id: user.into(), ..Default::default() }, now));
        }
        if self.on(guild, clips::MODULE) { out.extend(self.clips(guild).on_reaction(message, emoji)); }
        if self.on(guild, roles::MODULE) { out.extend(self.roles(guild).reaction(message, emoji, user, add)); }
        out
    }
    fn tickets<'a>(&'a self, guild: &'a str) -> tickets::Tickets<'a> {
        tickets::Tickets { db: &self.db, settings: &self.settings, guild }
    }
    /// One of the bot's popups was filled in. The first action answers it.
    /// Anything posted that pings a role Discord would not let the bot ping says so, privately, to whoever caused it.
    fn ping_note(&self, guild: &str, out: &mut Vec<Action>) {
        let roles: Vec<String> = out.iter().flat_map(|a| match a { Action::Announce { roles, .. } | Action::Post { roles, .. } | Action::Send { roles, .. } => roles.clone(), _ => Vec::new() }).collect();
        if roles.is_empty() { return; }
        if let Some(w) = self.directory.ping_problem(guild, &roles) { out.push(private(w.replace("or the reminder will post without pinging.", "or the message will post without pinging."))); }
    }
    pub fn on_form(&self, ev: &FormEvent, name_of: &dyn Fn(&str) -> Option<String>, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        let mut out = self.on_form_inner(ev, name_of, roll);
        if !ev.id.starts_with("remind") { self.ping_note(&ev.guild, &mut out); }
        out
    }
    fn on_form_inner(&self, ev: &FormEvent, name_of: &dyn Fn(&str) -> Option<String>, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        // a command's popup: run the command with the answers (or say what to fix, or offer the next part)
        match crate::forms::submitted(ev, &self.drafts) {
            Some(crate::forms::Answered::Run(cmd)) => return self.on_command(&cmd, name_of, roll),
            Some(crate::forms::Answered::Say(out)) => return out,
            None => {}
        }
        if ev.id.starts_with("arh:") || ev.id.starts_with("arstart:") {
            if let Some(no) = self.refused(&ev.guild, casino::MODULE, &ev.place, &ev.member) { return vec![no]; }
            return self.games(&ev.guild).arcade_form(ev, &mut |n| roll(0, n as i64 - 1) as u32);
        }
        if ev.id.starts_with("fcast:") || ev.id.starts_with("fbait:") {
            if let Some(no) = self.refused(&ev.guild, casino::MODULE, &ev.place, &ev.member) { return vec![no]; }
            return self.fishing(&ev.guild).form(ev, ev.at_ms, roll);
        }
        // Good Boy 3's "Start a giveaway" form: /giveaway start with its answers
        if ev.id == "gw:start" {
            let args = ["prize", "duration", "winners", "channel", "role"].iter().map(|k| (k.to_string(), ev.values.get(*k).cloned().unwrap_or_default())).collect();
            let cmd = CommandEvent { guild: ev.guild.clone(), place: ev.place.clone(), member: ev.member.clone(), name: "giveaway".into(), sub: Some("start".into()), args, at_ms: ev.at_ms, from_form: true, ..Default::default() };
            return self.on_command(&cmd, name_of, roll);
        }
        if ev.id == "rp:tenor" { return roleplay::form(&self.directory, ev); }
        if ev.id == "deadchat:form" { return self.deadchat(&ev.guild).form(ev); }
        if ev.id == "eid:edit" { return eclipseid::form(&self.db, ev); }
        if ev.id.starts_with("eng:") { if let Some(no) = self.refused(&ev.guild, engagement::MODULE, &ev.place, &ev.member) { return vec![no]; } return self.engagement(&ev.guild).form(ev); }
        if ev.id == "tvev:new" || ev.id.starts_with("tvev:friendsform:") { if let Some(no) = self.refused(&ev.guild, tempvoice::MODULE, &ev.place, &ev.member) { return vec![no]; } return self.tempvoice(&ev.guild).form(ev); }
        if ev.id == "feedtw:keys" { return integrations::Integrations::twitch_form(ev, self.directory.bot_owner().as_deref()); }
        if ev.id.starts_with("crit:name:") { if let Some(no) = self.refused(&ev.guild, critters::MODULE, &ev.place, &ev.member) { return vec![no]; } let mut rand = || roll(0, 999_999) as f64 / 1_000_000.0; return self.critters(&ev.guild).form(ev, &mut rand); }
        if let Some(party) = ev.id.strip_prefix("party:pingform:") {
            if let Some(no) = self.refused(&ev.guild, partyfinder::MODULE, &ev.place, &ev.member) { return vec![no]; }
            let server = self.server_name(&ev.guild);
            let mentionable = |role: &str| self.directory.role(&ev.guild, role).is_some_and(|r| r.mentionable);
            return self.party(&ev.guild, &server).ping_form(ev, party, &mentionable);
        }
        if ev.id == "party:form" { if let Some(no) = self.refused(&ev.guild, partyfinder::MODULE, &ev.place, &ev.member) { return vec![no]; } let server = self.server_name(&ev.guild); return self.party(&ev.guild, &server).form(ev); }
        if ev.id.starts_with("botnews:submit:") { return self.botnews(&ev.guild).form(ev); }
        // the team reminder popups: /remind team with everything filled in
        if ev.id.starts_with("remind:team:") || ev.id.starts_with("remind:text:") {
            let Some(args) = reminders::form_args(ev) else { return vec![private("That form belongs to someone else. Run the command yourself to get your own.")] };
            let cmd = CommandEvent { guild: ev.guild.clone(), place: ev.place.clone(), member: ev.member.clone(), name: "remind".into(), sub: Some("team".into()), args, at_ms: ev.at_ms, from_form: true, ..Default::default() };
            return self.on_command(&cmd, name_of, roll);
        }
        // the economy's popups (pay, bank, shop items, wallet adjustments)
        if ev.id.starts_with("mpx:") {
            if let Some(no) = self.refused(&ev.guild, money::MODULE, &ev.place, &ev.member) { return vec![no]; }
            return self.economy(&ev.guild, "").form(ev, ev.at_ms);
        }
        // member management: verification setup, the captcha, introductions, welcome pictures
        if let Some(owner) = ev.id.strip_prefix("verify:form:") {
            if owner != ev.member.id { return vec![private("That form belongs to someone else. Run the command yourself to get your own.")]; }
            let args = ["role", "unverified", "channel", "message"].iter().map(|k| (k.to_string(), ev.values.get(*k).cloned().unwrap_or_default())).collect();
            let cmd = CommandEvent { guild: ev.guild.clone(), place: ev.place.clone(), member: ev.member.clone(), name: "verify".into(), sub: Some("setup".into()), args, at_ms: ev.at_ms, from_form: true, ..Default::default() };
            return self.on_command(&cmd, name_of, roll);
        }
        if ["verify:code", "intro:submit", "greet:image"].contains(&ev.id.as_str()) {
            if let Some(no) = self.refused(&ev.guild, welcome::MODULE, &ev.place, &ev.member) { return vec![no]; }
            let server = self.server_name(&ev.guild);
            if let Some(out) = self.members(&ev.guild, &server).form(ev) { return out; }
        }
        // Good Boy 3's "New role menu" popup: runs /rolemenu create with what was picked
        if let Some(owner) = ev.id.strip_prefix("rolemenu:form:") {
            if owner != ev.member.id { return vec![private("That form belongs to someone else. Run the command yourself to get your own.")]; }
            let args = ["title", "description", "roles", "style", "mode"].iter().map(|k| (k.to_string(), ev.values.get(*k).cloned().unwrap_or_default())).collect();
            let cmd = CommandEvent { guild: ev.guild.clone(), place: ev.place.clone(), member: ev.member.clone(), name: "rolemenu".into(), sub: Some("create".into()), args, at_ms: ev.at_ms, from_form: true, ..Default::default() };
            return self.on_command(&cmd, name_of, roll);
        }
        // the warning form: runs /warn with its answers (the member from the picker, or the right-clicked one)
        // Good Boy 3's reason popup: runs the command again with everything filled in
        if let Some(rest) = ev.id.strip_prefix("modq:") {
            let mut it = rest.splitn(3, ':');
            let (action, user, extra) = (it.next().unwrap_or(""), it.next().unwrap_or(""), it.next().unwrap_or("-"));
            let typed = |k: &str| ev.values.get(k).map(|v| v.trim().to_string()).unwrap_or_default();
            if typed("reason").is_empty() { return vec![private("Please give a reason - it goes in the log.")]; }
            let mut args: std::collections::BTreeMap<String, String> = [("reason".to_string(), typed("reason"))].into();
            let ban_length = extra.split_once('~').map(|(l, _)| l).unwrap_or(extra);
            match action {
                "timeout" => { args.insert("duration".into(), typed("duration")); }
                "ban" => {
                    if ban_length != "-" { args.insert("duration".into(), ban_length.to_string()); }
                    if !typed("days").is_empty() { args.insert("delete_days".into(), typed("days")); }
                }
                "unban" => { args.insert("user_id".into(), user.to_string()); }
                _ => {}
            }
            let who = ev.members.iter().find(|m| m.id == user).cloned().unwrap_or(crate::Member { id: user.to_string(), name: name_of(user).unwrap_or_else(|| user.to_string()), ..Default::default() });
            let cmd = CommandEvent { guild: ev.guild.clone(), place: ev.place.clone(), member: ev.member.clone(), name: action.to_string(), target: (action != "unban").then_some(who), args, at_ms: ev.at_ms, from_form: true, ..Default::default() };
            return self.on_command(&cmd, name_of, roll);
        }
        if let Some(target) = ev.id.strip_prefix("modwarn:") {
            let id = if target == "-" { ev.values.get("user").cloned().unwrap_or_default() } else { target.to_string() };
            if id.is_empty() { return vec![private("Pick a member to warn.")]; }
            // remembered for 30 minutes, so the next warning form starts with the same words
            let said: serde_json::Map<String, serde_json::Value> = ["reason", "severity", "notes"].iter().filter_map(|k| ev.values.get(*k).map(|v| (k.to_string(), serde_json::json!(v)))).chain(std::iter::once(("at".to_string(), serde_json::json!(ev.at_ms)))).collect();
            crate::store::Data { db: &self.db, guild: &ev.guild, module: moderation::MODULE }.set(&format!("recall:{}", ev.member.id), &serde_json::Value::Object(said));
            let who = ev.members.iter().find(|m| m.id == id).cloned().unwrap_or(crate::Member { id: id.clone(), name: id.clone(), ..Default::default() });
            let args = ["reason", "severity", "notes"].iter().filter_map(|k| ev.values.get(*k).filter(|v| !v.trim().is_empty()).map(|v| (k.to_string(), v.clone()))).collect();
            let cmd = CommandEvent { guild: ev.guild.clone(), place: ev.place.clone(), member: ev.member.clone(), name: "warn".into(), target: Some(who), args, at_ms: ev.at_ms, from_form: true, ..Default::default() };
            return self.on_command(&cmd, name_of, roll);
        }
        if let Some(rest) = ev.id.strip_prefix("rankstyle:") {
            if let Some(no) = self.refused(&ev.guild, levels::MODULE, &ev.place, &ev.member) { return vec![no]; }
            let (step, owner) = rest.split_once(':').unwrap_or((rest, ""));
            return levels::rank_style(&self.db, &self.settings, &ev.guild, &ev.member.id, step, owner, Some(&ev.values), Some(&ev.files));
        }
        if ev.id.starts_with("mu") && ev.id.ends_with(":add") && ev.id.split(':').next().is_some_and(|k| k == "mu" || k.starts_with("mu~")) {
            if let Some(no) = self.refused(&ev.guild, music::MODULE, &ev.place, &ev.member) { return vec![no]; }
            let slot = music::slot_of_kind(ev.id.split(':').next().unwrap_or("mu"));
            return self.music_slot(&ev.guild, slot).form(ev);
        }
        if !ev.id.starts_with("ticket:") {
            return vec![private("That form is from an older message. Use the command again.")];
        }
        if let Some(no) = self.refused(&ev.guild, tickets::MODULE, &Place::default(), &ev.member) {
            return vec![no];
        }
        self.tickets(&ev.guild).form(ev)
    }
    /// A panel posted from the launcher (Good Boy 3's dashboard did the same): what the bot should send. Err says why not.
    #[allow(clippy::too_many_arguments)]
    pub fn panel_from_dashboard(&self, guild: &str, module: &str, channel: &str, title: Option<&str>, text: Option<&str>, pin: bool, now: i64) -> Result<Vec<Action>, String> {
        if !self.on(guild, module) { return Err(format!("{} turned off in this server. Turn it on first.", friendly(module))); }
        let out = match module {
            m if m == tickets::MODULE => self.tickets(guild).post_panel(channel, title, text),
            m if m == music::MODULE => {
                let admin = crate::Member { perms: crate::perms::ADMINISTRATOR, ..Default::default() };
                let ev = CommandEvent { guild: guild.into(), place: Place::channel(channel), member: admin, name: "music".into(), sub: Some("player".into()), at_ms: now, from_form: true, ..Default::default() };
                self.music(guild).command(&ev)
            }
            _ => return Err("This module has no panel to post.".into()),
        };
        // the first action is the answer meant for whoever asked; the launcher says it itself
        let mut it = out.into_iter();
        let rest: Vec<Action> = match it.next() {
            Some(Action::Reply { card }) if it.len() == 0 => return Err(card.lines.join(" ")),
            _ => it.collect(),
        };
        // pinned: the post becomes a Post with a note the Discord layer pins by
        Ok(rest.into_iter().map(|a| match (a, pin) {
            (Action::Send { channel, card, ping, roles }, true) => Action::Post { channel, card, note: "panel;pin".into(), ping, roles },
            (Action::Post { channel, card, note, ping, roles }, true) => Action::Post { channel, card, note: format!("{note};pin"), ping, roles },
            (a, _) => a,
        }).collect())
    }
    /// A moderation action chosen in the launcher (warn, timeout, kick or ban), run as the bot's owner so it
    /// is recorded and logged like the command. Gives the actions to carry out; the launcher reads the first
    /// card as the answer when nothing else happens.
    #[allow(clippy::too_many_arguments)]
    pub fn staff_action(&self, guild: &str, kind: &str, user: &str, name: &str, reason: &str, duration: Option<&str>, now: i64) -> Result<Vec<Action>, String> {
        if !["warn", "timeout", "kick", "ban"].contains(&kind) { return Err("That is not something the launcher can do.".into()); }
        if !self.on(guild, moderation::MODULE) { return Err("Moderation is turned off in this server. Turn it on first.".into()); }
        if user.is_empty() || !user.bytes().all(|b| b.is_ascii_digit()) { return Err("Use the member's Discord ID (right-click them with Developer Mode on and Copy User ID).".into()); }
        if reason.trim().is_empty() { return Err("Give a reason: the member and the log are told it.".into()); }
        let me = self.directory.bot_owner().unwrap_or_else(|| "0".into());
        let mut args = std::collections::BTreeMap::new();
        args.insert("reason".to_string(), reason.trim().to_string());
        if let Some(d) = duration.filter(|d| !d.trim().is_empty()) { args.insert("duration".to_string(), d.trim().to_string()); }
        let ev = CommandEvent {
            guild: guild.into(), place: Place::channel("0"), name: kind.into(), at_ms: now, from_form: true, args,
            member: crate::Member { id: me.clone(), name: "The launcher".into(), perms: crate::perms::ADMINISTRATOR, ..Default::default() },
            target: Some(crate::Member { id: user.into(), name: if name.is_empty() { format!("Member {}", &user[user.len().saturating_sub(4)..]) } else { name.into() }, ..Default::default() }),
            ..Default::default()
        };
        if user == me { return Err("You cannot do that to yourself.".into()); }
        let out = self.moderation(guild, &self.server_name(guild)).command(&ev);
        // a lone private reply is a refusal ("you don't have permission", "use a duration like 10m")
        if let [Action::Reply { card }] = out.as_slice() { if card.private { return Err(card.lines.join(" ")); } }
        Ok(out)
    }
    /// Every command with the boxes it takes, for the launcher's Commands page: so anything that is set up with a
    /// command in Discord can be set up from the dashboard too.
    pub fn command_catalog(&self) -> serde_json::Value {
        use crate::event::FieldKind as K;
        let field = |f: &crate::Field| {
            let (kind, extra) = match &f.kind {
                K::Text => ("text", serde_json::json!({})),
                K::Select(list) => ("select", serde_json::json!({ "options": list })),
                K::User { .. } => ("member", serde_json::json!({})),
                K::Role { .. } => ("role", serde_json::json!({})),
                K::Channel(types) => ("channel", serde_json::json!({ "types": types })),
                K::Files { .. } => ("files", serde_json::json!({})),
            };
            let mut j = serde_json::json!({ "id": f.id, "label": f.label, "desc": f.desc, "kind": kind, "required": f.required, "long": f.long, "max": f.max, "placeholder": f.placeholder });
            if let (Some(o), Some(e)) = (j.as_object_mut(), extra.as_object()) { for (k, v) in e { o.insert(k.clone(), v.clone()); } }
            j
        };
        let part = |name: &str, about: &str, opts: &[Opt], own: bool| serde_json::json!({ "name": name, "about": about, "own_popup": own, "fields": crate::forms::fields_for(opts).iter().map(&field).collect::<Vec<_>>() });
        let mut list = Vec::new();
        for spec in commands() {
            let subs: Vec<serde_json::Value> = if spec.subs.is_empty() { Vec::new() } else { spec.subs.iter().map(|s| part(s.name, s.about, s.options, crate::forms::owns_popup(spec.name, Some(s.name)))).collect() };
            let module = self.module_name(spec.module);
            let reach = crate::folds::group_of(spec.name).map(|g| format!("/{g} → {}", spec.name)).unwrap_or_else(|| format!("/{}", spec.name));
            list.push(serde_json::json!({ "name": spec.name, "about": spec.about, "module": spec.module, "module_name": module, "discord": reach,
                "own_popup": spec.subs.is_empty() && crate::forms::owns_popup(spec.name, None), "fields": if spec.subs.is_empty() { crate::forms::fields_for(spec.options).iter().map(&field).collect::<Vec<_>>() } else { Vec::new() }, "subs": subs }));
        }
        serde_json::json!({ "commands": list })
    }
    fn module_name(&self, id: &str) -> String {
        MODULES.iter().find(|m| m.id == id).map(|m| m.name.to_string()).unwrap_or_else(|| id.to_string())
    }
    /// Runs a command from the launcher as the bot's owner, with the answers typed into its boxes. Returns what it
    /// said (in plain text) and whatever it wants done in Discord.
    pub fn command_run(&self, guild: &str, name: &str, sub: Option<&str>, values: &std::collections::BTreeMap<String, String>, now: i64) -> Result<(Vec<String>, Vec<Action>), String> {
        let spec = commands().find(|c| c.name == name).ok_or("That command does not exist.")?;
        if !self.on(guild, spec.module) { return Err(format!("{} is turned off in this server. Turn it on first.", self.module_name(spec.module))); }
        if !spec.subs.is_empty() && !sub.is_some_and(|s| spec.subs.iter().any(|x| x.name == s)) { return Err("Pick which part of the command to run.".into()); }
        if crate::forms::owns_popup(name, sub) { return Err("This one opens its own popup in Discord. Use it there.".into()); }
        let opts = crate::forms::leaf_options(spec, sub);
        // member boxes arrive as Discord ids
        let (args, members) = crate::forms::read_answers(opts, values, &[])?;
        let me = self.directory.bot_owner().unwrap_or_else(|| "0".into());
        let ev = CommandEvent {
            guild: guild.into(), place: Place::channel("0"), name: name.into(), sub: sub.map(str::to_string), args, at_ms: now, from_form: true,
            member: crate::Member { id: me, name: "The dashboard".into(), perms: crate::perms::ADMINISTRATOR, ..Default::default() },
            target: members.first().cloned(), target2: members.get(1).cloned(),
        };
        let out = self.on_command(&ev, &|_| None, &mut roll_between);
        self.db.seen().note(guild, "command", &format!("The dashboard ran /{name}{}", sub.map(|s| format!(" {s}")).unwrap_or_default()));
        let (mut said, mut rest) = (Vec::new(), Vec::new());
        for a in out {
            match a {
                Action::Reply { card } | Action::Update { card } | Action::FollowUp { card } => {
                    let text = card.title.iter().cloned().chain(card.lines.iter().cloned()).collect::<Vec<_>>().join("\n");
                    if !text.trim().is_empty() { said.push(text); }
                }
                other => rest.push(other),
            }
        }
        Ok((said, rest))
    }
    /// Someone deleted a channel or role, banned or kicked (Discord's audit log). Anti-nuke counts it.
    /// `roles`: the person's roles (id, permission bits, managed).
    pub fn on_destructive(&self, guild: &str, executor: &str, roles: &[(String, u64, bool)], me: &str, now: i64) -> Vec<Action> {
        if !self.on(guild, moderation::MODULE) { return Vec::new(); }
        let immune_roles = self.db.get().perm_roles(guild, "moderation.antinuke-immune").unwrap_or_default();
        let immune = roles.iter().any(|(r, _, _)| immune_roles.contains(r));
        let owner = self.directory.owner(guild);
        self.shield.destructive(&self.db, &self.settings, guild, executor, owner.as_deref(), me, roles, immune, now)
    }
    /// A purge finished in the Discord layer: what to tell whoever ran it, and the mod log.
    #[allow(clippy::too_many_arguments)]
    pub fn on_purged(&self, guild: &str, channel: &str, by: &str, from: Option<&str>, deleted: u64, stopped: bool, progress: bool) -> (String, Vec<Action>) {
        self.moderation(guild, "").purged(channel, by, from, deleted, stopped, progress)
    }
    /// A channel was recreated by a purge: its new id, and its name.
    pub fn on_recreated(&self, guild: &str, old: &str, new: &str, name: &str, by: &str) -> Vec<Action> {
        self.moderation(guild, "").recreated(old, new, name, by)
    }
    /// A member pressed a star button in their DM to rate a closed ticket: what to tell them, and the rating's log.
    pub fn on_rate(&self, guild: &str, number: i64, user: &str, stars: i64, now: i64) -> (String, Option<Action>) {
        if !self.on(guild, tickets::MODULE) { return ("Tickets are off in that server now.".into(), None); }
        self.tickets(guild).rate(number, user, stars, now)
    }
    /// A channel asked for with `Action::OpenChannel` exists. The first action answers the person who asked.
    pub fn on_channel_made(&self, guild: &str, note: &str, channel: &str) -> Vec<Action> {
        if note.starts_with("party:") { return self.party(guild, "").voice_made(note, channel); }
        self.tickets(guild).channel_made(note, channel)
    }
    /// Discord would not make a party's voice channel.
    pub fn on_voice_failed(&self, guild: &str, note: &str) -> Vec<Action> {
        self.party(guild, "").voice_failed(note)
    }
    /// Discord would not make the channel.
    pub fn on_channel_failed(&self, guild: &str, note: &str) {
        self.tickets(guild).channel_failed(note);
    }
    /// A channel was deleted.
    pub fn on_channel_gone(&self, guild: &str, channel: &str) -> Vec<Action> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        let mut out = self.tickets(guild).channel_gone(channel, now);
        if self.on(guild, tempvoice::MODULE) { out.extend(self.tempvoice(guild).channel_gone(channel, now)); }
        out
    }
    fn server_name(&self, guild: &str) -> String {
        self.db.get().guilds().ok().and_then(|all| all.into_iter().find(|g| g.id == guild)).map(|g| g.name).filter(|n| !n.is_empty()).unwrap_or_else(|| "The server".into())
    }

    /// A command was used. The first action answers it; any others are carried out as well.
    /// `name_of` gives a member's display name when the Discord layer knows it; `roll(lo, hi)` picks a whole
    /// number between the two.
    pub fn on_command(&self, ev: &CommandEvent, name_of: &dyn Fn(&str) -> Option<String>, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        // a group command (`/mod`, `/money`...) opens a menu of what is inside it
        if crate::folds::is_group(&ev.name) {
            return crate::folds::menu_card(&ev.name).map(|card| vec![Action::Reply { card }]).unwrap_or_else(|| vec![private("Nothing is in that group.")]);
        }
        let seen = self.db.seen();
        seen.saw(&ev.guild, &ev.member.id, &ev.member.name);
        for m in ev.target.iter().chain(ev.target2.iter()) { seen.saw(&ev.guild, &m.id, &m.name); }
        {
            let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            let roster = self.roster(&ev.guild);
            roster.see(&ev.member, false, at);
            for m in ev.target.iter().chain(ev.target2.iter()) { roster.see(m, false, at); }
        }
        let mut out = self.run_command(ev, name_of, roll);
        if ev.name != "remind" && !matches!(out.as_slice(), [Action::Form { .. }]) { self.ping_note(&ev.guild, &mut out); }
        // the Activity page: who used which command, and where. Never what was typed into it. A command that only
        // opened its popup is noted when the popup is sent.
        if !matches!(out.as_slice(), [Action::Form { .. }]) {
            let what = match &ev.sub { Some(s) => format!("/{} {s}", ev.name), None if ev.name.contains(' ') => format!("\"{}\" (right-click)", ev.name), None => format!("/{}", ev.name) };
            let place = self.directory.channels(&ev.guild).into_iter().find(|c| c.id == ev.place.base()).map(|c| format!(" in #{}", c.name)).unwrap_or_default();
            let who = if ev.member.name.is_empty() { "A member" } else { ev.member.name.as_str() };
            seen.note(&ev.guild, "command", &format!("{who} used {what}{place}"));
        }
        out
    }
    fn run_command(&self, ev: &CommandEvent, name_of: &dyn Fn(&str) -> Option<String>, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        // the right-click user commands belong to the module of the command they stand for
        let looked_up = match ev.name.as_str() { "View wallet" | "Pay member" => "balance", "Translate" => "highlight", "Quote Image" | "Quote Image (Color)" => "quote", "Report message" => "report", "Message stats" => "stats", n => n };
        let Some(spec) = commands().find(|c| c.name == looked_up) else {
            return vec![private(format!("This version of Good Boy does not have `/{}` yet.", ev.name))];
        };
        if spec.module != notify::MODULE {
            if let Some(no) = self.refused(&ev.guild, spec.module, &ev.place, &ev.member) {
                return vec![no];
            }
        }
        // the command's permission is checked before its popup opens (as in Good Boy 3), so nobody fills in a form they can't send
        if let Some(perm) = command_permission(&ev.name) {
            if !crate::perms::allowed(&self.db, &ev.guild, &ev.member, perm) {
                return vec![private(format!("You don't have permission for that (`{}`).", perm.key))];
            }
        }
        // every command is a popup, as in Good Boy 3: nothing filled in yet opens the command's form
        if let Some(form) = crate::forms::ask(ev) {
            return vec![form];
        }
        let one = match (ev.name.as_str(), ev.sub.as_deref()) {
            ("rank", _) => levels::rank(&self.db, &self.settings, ev),
            ("leaderboard" | "liveboard" | "rep" | "serverstats" | "xp" | "levels", _) => {
                let server = self.server_name(&ev.guild);
                return self.community(&ev.guild).command(ev, &server, roll);
            }
            ("balance" | "daily" | "pay" | "top" | "shop" | "work" | "rob" | "pet" | "bank" | "economy-admin" | "treasury" | "exchange" | "View wallet" | "Pay member", _) => {
                let server = self.server_name(&ev.guild);
                let mut out = self.economy(&ev.guild, &server).command(ev, roll);
                // the whole-server reset (a Good Boy 4 extra) sits next to the wallet tool
                if ev.name == "economy-admin" {
                    if let Some(Action::Reply { card }) = out.first_mut() {
                        if card.buttons.len() == 1 { *card = card.clone().button_with("money:resetask", "Reset the economy", crate::ButtonStyle::Plain, Some("♻️".into())); }
                    }
                }
                return out;
            }
            ("fun", _) => fun::command(ev, roll),
            ("remind", _) => reminders::command(&self.db, &self.settings, &self.directory, ev),
            ("counting", _) => return counting::command(&self.db, ev),
            ("giveaway", _) => return giveaways::command(&self.db, ev, self.on(&ev.guild, money::MODULE), roll),
            ("ticket", _) => return self.tickets(&ev.guild).command(ev),
            ("music", sub) => {
                // with several music bots, the one already in your channel answers; a new song goes to a free one
                let free = matches!(sub, Some("play" | "playnext" | "playlists" | "voice join" | "save" | "player"));
                let slot = self.pick_slot(&ev.guild, &ev.member.id, free);
                return self.music_slot(&ev.guild, slot).command(ev);
            }
            ("invites", _) => return invites::command(&self.db, ev),
            ("backup", _) => return backup::command(&self.db, ev),
            ("say" | "sticky", _) => return messages::command(&self.db, ev),
            ("deadchat", _) => return self.deadchat(&ev.guild).command(ev),
            ("timezone" | "time", _) => return self.timezones(&ev.guild).command(ev),
            ("altcheck", _) => return self.altwatch(&ev.guild).command(ev),
            ("plural", _) => return self.plural(&ev.guild).command(ev),
            ("tts", _) => return self.tts(&ev.guild).command(ev),
            ("fish", _) => {
                if !self.on(&ev.guild, money::MODULE) { return vec![private("Games need the **economy** module. An admin can turn it on.")]; }
                return self.fishing(&ev.guild).command(&ev.member, ev.at_ms);
            }
            ("slots" | "blackjack" | "coinflip", _) => {
                if !self.on(&ev.guild, money::MODULE) { return vec![private("Games need the **economy** module. An admin can turn it on.")]; }
                return self.games(&ev.guild).command(ev, &mut |n| roll(0, n as i64 - 1) as u32);
            }
            ("tower" | "wires" | "bingo" | "memory" | "hangman" | "trivia" | "pong" | "arcade", _) => {
                if !self.on(&ev.guild, money::MODULE) { return vec![private("Games need the **economy** module. An admin can turn it on.")]; }
                return self.games(&ev.guild).arcade_command(ev, &mut |n| roll(0, n as i64 - 1) as u32);
            }
            ("note" | "watch" | "appeal" | "report" | "Report message" | "lockdown", _) => { return self.modplus(&ev.guild).command(ev); }
            ("stats" | "Message stats" | "counter", _) => { let server = self.server_name(&ev.guild); return self.stats(&ev.guild, &server).command(ev, name_of); }
            ("announce" | "poll" | "suggest" | "suggestion" | "starboard", _) => return self.engagement(&ev.guild).command(ev),
            ("room", _) => return self.tempvoice(&ev.guild).room_command(ev),
            ("voicehub", _) => return self.tempvoice(&ev.guild).hub_command(ev),
            ("feed" | "minecraft" | "webhook", _) => {
                let random = || { let mut b = [0u8; 24]; let _ = getrandom::getrandom(&mut b); b.iter().map(|x| format!("{x:02x}")).collect::<String>() };
                return self.integrations(&ev.guild).command(ev, self.directory.bot_owner().as_deref(), &random);
            }
            ("critters", _) => { let mut rand = || roll(0, 999_999) as f64 / 1_000_000.0; return self.critters(&ev.guild).command(ev, &mut rand); }
            ("quote" | "Quote Image" | "Quote Image (Color)", _) => return quotes::command(&self.db, &self.settings, ev, self.directory.reads_messages(), self.directory.licensed()),
            ("party", _) => { let server = self.server_name(&ev.guild); return self.party(&ev.guild, &server).command(ev); }
            ("botnews", _) => return self.botnews(&ev.guild).command(ev),
            ("clips", _) => return self.clips(&ev.guild).command(ev),
            ("help", _) => return vec![Action::Reply { card: self.help(&ev.guild) }],
            ("notifications", _) => return notify::command(&self.db, ev),
            ("achievements", _) => { let server = self.server_name(&ev.guild); return self.achievements(&ev.guild, &server).command(ev); }
            ("marry" | "family", _) => return self.family(&ev.guild).command(ev, name_of),
            ("id", _) => {
                let server = self.server_name(&ev.guild);
                let ach = self.on(&ev.guild, achievements::MODULE).then(|| self.achievements(&ev.guild, &server));
                return eclipseid::command(&self.db, ev, self.settings.bool(&ev.guild, eclipseid::MODULE, "robloxLookup"), ach.as_ref());
            }
            ("rp", _) => return roleplay::command(&self.db, &self.settings, &self.directory, ev),
            ("highlight", _) => return utility::command(&self.db, ev, self.directory.reads_messages()),
            ("Translate", _) => {
                if !crate::perms::allowed(&self.db, &ev.guild, &ev.member, utility::USE) { return vec![private(format!("You don't have permission for that (`{}`).", utility::USE.key))]; }
                let text = ev.args.get("text").cloned().unwrap_or_default();
                if text.trim().is_empty() { return vec![private("That message has no text to translate.")]; }
                return vec![Action::Translate { text, to: ev.args.get("locale").map(|l| l.split('-').next().unwrap_or("en").to_string()).filter(|l| !l.is_empty()).unwrap_or_else(|| "en".into()) }];
            }
            ("greeting" | "verify" | "profile" | "introduce" | "birthday" | "afk", _) => {
                let server = self.server_name(&ev.guild);
                return self.members(&ev.guild, &server).command(ev, roll);
            }
            ("rolemenu" | "reactionrole" | "autorole" | "gamerole", _) => return self.roles(&ev.guild).command(ev),
            ("tags", _) => return tags::command(&self.db, &self.settings, ev, &self.server_name(&ev.guild), self.directory.members(&ev.guild), roll),
            ("logs", _) => return self.logs(&ev.guild).command(ev),
            _ if spec.module == moderation::MODULE => return self.moderation(&ev.guild, &self.server_name(&ev.guild)).command(ev),
            (name, sub) => private(format!("This version of Good Boy does not have `/{name}{}` yet.", sub.map(|s| format!(" {s}")).unwrap_or_default())),
        };
        vec![one]
    }

    /// Someone joined (`joined`) or left the server. The member count is kept in step.
    pub fn on_member(&self, guild: &str, member: &Member, joined: bool) -> Vec<Action> {
        {
            let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            if joined { self.roster(guild).joined(member, at); }
        }
        if !member.name.is_empty() {
            self.db.seen().saw(guild, &member.id, &member.name);
            self.db.seen().note(guild, "member", &format!("{}{} {}", member.name, if member.bot { " (a bot)" } else { "" }, if joined { "joined the server" } else { "left the server" }));
        }
        if !member.bot && self.on(guild, stats::MODULE) {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            self.stats(guild, "").on_member(joined, now);
        }
        // a member's XP record is deleted when they leave
        if !joined && !member.bot && self.on(guild, levels::MODULE) {
            let _ = self.db.get().data_delete(guild, levels::MODULE, &format!("user:{}", member.id));
        }
        let count = self.directory.members(guild).map(|n| if joined { n + 1 } else { n.saturating_sub(1) });
        if let Some(n) = count {
            self.directory.set_members(guild, n);
        }
        let mut out = Vec::new();
        if !joined {
            let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            out.extend(self.roster(guild).left(member, at).into_iter().filter(|_| self.on(guild, moderation::MODULE)));
        }
        if joined && !member.bot && self.on(guild, moderation::MODULE) {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            out.extend(self.shield.joined(&self.settings, guild, member, now));
            out.extend(self.modplus(guild).joined(member, now));
        }
        if self.on(guild, moderation::MODULE) {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            out.extend(if joined { self.logs(guild).joined(member, count, now) } else { self.logs(guild).left(member) });
        }
        if !joined && self.on(guild, invites::MODULE) {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            invites::left(&self.db, guild, member, now);
        }
        if joined && !member.bot && self.on(guild, altwatch::MODULE) {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            out.extend(self.altwatch(guild).joined(member, now));
        }
        if joined && self.on(guild, roles::MODULE) {
            out.extend(self.roles(guild).on_join(member));
        }
        if self.on(guild, welcome::MODULE) {
            let server = self.server_name(guild);
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            let m = self.members(guild, &server);
            out.extend(if joined { m.on_join(member, count, now) } else { m.on_leave(member, count, now) });
        }
        out
    }

    /// The clock moved on (about every half minute): what has come due, as (server, action).
    pub fn on_tick(&self, now_ms: i64, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<(String, Action)> {
        // a module that a server turned off stays quiet, even for things set before it was turned off
        let mut out: Vec<(String, Action)> = reminders::due(&self.db, now_ms).into_iter().filter(|(g, _)| self.on(g, reminders::MODULE)).collect();
        out.extend(moderation::due(&self.db, now_ms).into_iter().filter(|(g, _)| self.on(g, moderation::MODULE)));
        out.extend(giveaways::due(&self.db, now_ms, &|g| self.on(g, money::MODULE), roll));
        out.extend(roles::due(&self.db, now_ms).into_iter().filter(|(g, _)| self.on(g, roles::MODULE)));
        out.extend(tickets::due(&self.db, &self.settings, now_ms).into_iter().filter(|(g, _)| self.on(g, tickets::MODULE)));
        out.extend(economy::due(&self.db, &self.settings, &self.directory, now_ms, roll, &|g| self.on(g, money::MODULE)));
        self.pulse.save(&self.db, &self.directory, now_ms);
        // leave records past their time, once an hour
        roster::prune_due(&self.db, &self.settings, now_ms);
        // dead chat pings
        let all = self.db.get().guilds().unwrap_or_default();
        for g in all.into_iter().filter(|g| self.on(&g.id, deadchat::MODULE)) {
            out.extend(self.deadchat(&g.id).check(now_ms, roll).into_iter().map(|a| (g.id.clone(), a)));
        }
        // clip of the week, on Mondays
        let all = self.db.get().guilds().unwrap_or_default();
        for g in all.into_iter().filter(|g| self.on(&g.id, clips::MODULE)) {
            out.extend(self.clips(&g.id).weekly(now_ms).into_iter().map(|a| (g.id.clone(), a)));
        }
        // parties: closing, tidying, reminders
        let all = self.db.get().guilds().unwrap_or_default();
        for g in all.into_iter().filter(|g| self.on(&g.id, partyfinder::MODULE)) {
            let server = self.server_name(&g.id);
            out.extend(self.party(&g.id, &server).sweep(now_ms, &|c| self.directory.in_voice(&g.id, c).len()).into_iter().map(|a| (g.id.clone(), a)));
        }
        // blackjack hands nobody finished
        let all = self.db.get().guilds().unwrap_or_default();
        for g in all.into_iter().filter(|g| self.on(&g.id, casino::MODULE)) {
            self.games(&g.id).due(now_ms, &mut |n| roll(0, n as i64 - 1) as u32);
            self.games(&g.id).arcade_due(now_ms);
            self.fishing(&g.id).due(now_ms);
        }
        // levels: voice XP, the live leaderboard, the member counter
        let all = self.db.get().guilds().unwrap_or_default();
        for g in all.into_iter().filter(|g| self.on(&g.id, levels::MODULE)) {
            out.extend(self.community(&g.id).due(now_ms).into_iter().map(|a| (g.id.clone(), a)));
        }
        // activity stats: counts saved; recaps, reviews, warnings and counters when due
        let all = self.db.get().guilds().unwrap_or_default();
        for g in all.into_iter().filter(|g| self.on(&g.id, stats::MODULE)) {
            let server = self.server_name(&g.id);
            out.extend(self.stats(&g.id, &server).due(now_ms).into_iter().map(|a| (g.id.clone(), a)));
        }
        // scheduled announcements and polls that end
        let all = self.db.get().guilds().unwrap_or_default();
        for g in all.into_iter().filter(|g| self.on(&g.id, engagement::MODULE)) {
            out.extend(self.engagement(&g.id).due(now_ms).into_iter().map(|a| (g.id.clone(), a)));
        }
        // temporary rooms: empty ones go
        let all = self.db.get().guilds().unwrap_or_default();
        for g in all.into_iter().filter(|g| self.on(&g.id, tempvoice::MODULE)) {
            out.extend(self.tempvoice(&g.id).sweep(now_ms).into_iter().map(|a| (g.id.clone(), a)));
        }
        // text-to-speech leaving voice when idle or alone
        for g in tts::Tts::guilds() {
            if self.on(&g, tts::MODULE) { out.extend(self.tts(&g).tick(now_ms).into_iter().map(|a| (g.clone(), a))); }
        }
        // feeds due a check
        let all = self.db.get().guilds().unwrap_or_default();
        for g in all.into_iter().filter(|g| self.on(&g.id, integrations::MODULE)) {
            out.extend(self.integrations(&g.id).due(now_ms).into_iter().map(|a| (g.id.clone(), a)));
        }
        // family proposals left unanswered are forgotten
        let all = self.db.get().guilds().unwrap_or_default();
        for g in all { self.family(&g.id).expire(now_ms); }
        // birthdays: once a day in each server's own time
        let guilds = self.db.get().guilds().unwrap_or_default();
        for g in guilds.into_iter().filter(|g| self.on(&g.id, welcome::MODULE)) {
            let server = self.server_name(&g.id);
            out.extend(self.members(&g.id, &server).birthdays(now_ms).into_iter().map(|a| (g.id.clone(), a)));
        }
        out
    }

    /// A card sent with `Action::Post` is up: here is the message's id, with the note that came with it.
    /// The Discord layer fetched a picture a member uploaded for their rank card: it is kept as their background.
    pub fn rank_background_saved(&self, guild: &str, member: &str, name: &str, bytes: &[u8], at_ms: i64) -> Result<(), String> {
        levels::save_background(&self.db, guild, member, name, bytes, at_ms)
    }
    /// Where the Discord layer finds a kept rank card background (`file:<name>` in a card's style).
    pub fn rank_background_path(&self, guild: &str, stored: &str) -> Option<std::path::PathBuf> {
        let name = stored.strip_prefix("file:")?;
        if !levels::ok_background_file(name) { return None; }
        Some(levels::background_dir(self.db.get().path().parent()?, guild).join(name))
    }
    pub fn on_posted(&self, guild: &str, note: &str, message: &str) {
        giveaways::posted(&self.db, guild, note, message);
        self.clips(guild).posted(note, message);
        self.party(guild, "").posted(note, message);
        self.tempvoice(guild).posted(note, message);
        self.engagement(guild).posted(note, message);
        self.critters(guild).posted(note, message);
        self.tickets(guild).posted(note, message);
        self.roles(guild).posted(note, message);
        self.music(guild).posted(note, message);
        self.plural(guild).posted(note, message);
        self.community(guild).posted(note, message);
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        self.members(guild, "").posted(note, message, now);
        self.economy(guild, "").posted(note, message);
        messages::posted(&self.db, guild, note, message, now);
    }

    /// After a post landed: the name of a discussion thread to open on it, if it is one that gets one (a suggestion).
    pub fn thread_for_post(&self, guild: &str, note: &str) -> Option<String> {
        self.engagement(guild).thread_for(note)
    }

    /// Discord refused a moderation action: the case that recorded it is taken back out of the history.
    pub fn action_refused(&self, guild: &str, action: &Action) {
        if let Action::Kick { user, case, .. } | Action::Ban { user, case, .. } | Action::Unban { user, case, .. } | Action::Timeout { user, case, .. } = action {
            if *case > 0 {
                self.moderation(guild, "").remove_case(user, *case);
                self.db.seen().note(guild, "mod", &format!("Discord refused, so case #{case} was taken back"));
            }
        }
    }

    /// A button on one of the bot's cards was pressed. Ids look like "module:what" or "rank:<member id>".
    /// The first action answers the press; any others are carried out as well.
    pub fn on_button(&self, ev: &ButtonEvent, name_of: &dyn Fn(&str) -> Option<String>, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        // an arcade panel posted by Good Boy 3 (`gm:ar:<game>`) keeps working: it opens the same game here
        if let Some(game) = ev.id.strip_prefix("gm:ar:") {
            let mut moved = ev.clone();
            moved.id = format!("ar:open:{game}");
            return self.on_button(&moved, name_of, roll);
        }
        // the menu a group command (`/mod`, `/money`...) opens: pick a command, and it runs or opens its popup
        if ev.id.starts_with("gmenu:") {
            return match ev.values.first().and_then(|v| crate::folds::picked(&ev.id, v)) {
                Some(crate::folds::Picked::Menu(card)) => vec![Action::Update { card: *card }],
                Some(crate::folds::Picked::Run { name, sub }) => self.on_command(&CommandEvent { guild: ev.guild.clone(), place: ev.place.clone(), member: ev.member.clone(), name, sub, at_ms: ev.at_ms, ..Default::default() }, name_of, roll),
                None => vec![private("That menu is from an older message. Use the command again.")],
            };
        }
        let old = || vec![private("That button is from an older message. Use the command again.")];
        self.db.seen().saw(&ev.guild, &ev.member.id, &ev.member.name);
        if let Some(form) = crate::forms::reopen(ev) {
            return form;
        }
        if let Some(rest) = ev.id.strip_prefix("modq:") {
            let mut it = rest.splitn(4, ':');
            let (owner, action, user, extra) = (it.next().unwrap_or(""), it.next().unwrap_or(""), it.next().unwrap_or(""), it.next().unwrap_or("-"));
            if owner != ev.member.id { return vec![private("That form belongs to someone else. Run the command yourself to get your own.")]; }
            return vec![crate::moderation::action_form(action, user, extra)];
        }
        if let Some(rest) = ev.id.strip_prefix("mwarn:") {
            let (owner, target) = rest.split_once(':').unwrap_or((rest, "-"));
            if owner != ev.member.id { return vec![private("That form belongs to someone else. Run the command yourself to get your own.")]; }
            let recall = crate::store::Data { db: &self.db, guild: &ev.guild, module: moderation::MODULE }.get(&format!("recall:{}", ev.member.id)).filter(|r| ev.at_ms - r["at"].as_i64().unwrap_or(0) < 30 * 60_000);
            return vec![crate::moderation::warn_form(Some(target).filter(|t| *t != "-"), recall.as_ref())];
        }
        let (kind, rest) = ev.id.split_once(':').unwrap_or((ev.id.as_str(), ""));
        let module = match kind {
            "rank" | "rankstyle" | "rep" => levels::MODULE,
            "money" | "econ" | "econlb" | "mpx" => money::MODULE,
            "mpurge" | "mapp" | "mapr" | "mrep" => moderation::MODULE,
            "sl" | "cf" | "bj" | "fh" | "fr" | "fsel" | "frod" | "fs" | "fdx" | "ar" | "pg" => casino::MODULE,
            "gw" => giveaways::MODULE,
            "ticket" => tickets::MODULE,
            "rolemenu" | "gamerole" => roles::MODULE,
            "verify" => welcome::MODULE,
            "rp" => roleplay::MODULE,
            "mmail" => modmail::MODULE,
            "backup" => backup::MODULE,
            "deadchat" => deadchat::MODULE,
            "fam" => family::MODULE,
            "botnews" => botnews::MODULE,
            "party" => partyfinder::MODULE,
            "crit" => critters::MODULE,
            "tvev" => tempvoice::MODULE,
            "eng" | "poll" | "sugg" => engagement::MODULE,
            "st" => stats::MODULE,
            k if k == "mu" || k.starts_with("mu~") => music::MODULE,
            _ => return old(),
        };
        if let Some(no) = self.refused(&ev.guild, module, &ev.place, &ev.member) {
            return vec![no];
        }
        let money = money::Money { db: &self.db, settings: &self.settings, guild: &ev.guild };
        let mut answer = match (kind, rest) {
            ("rank", id) => {
                // the name and picture come from what the bot remembers of the member, so the card is right even when they
                // have not spoken since the bot started (only then would the live name list have them)
                let known = self.db.get().roster_get(&ev.guild, id).ok().flatten();
                let name = name_of(id).or_else(|| known.as_ref().map(|k| k.0.clone()).filter(|n| !n.is_empty())).unwrap_or_else(|| "Member".to_string());
                let target = crate::Member { id: id.to_string(), name, avatar: known.and_then(|k| k.1), ..Default::default() };
                levels::rank(&self.db, &self.settings, &CommandEvent { guild: ev.guild.clone(), place: ev.place.clone(), member: ev.member.clone(), name: "rank".into(), target: Some(target), at_ms: ev.at_ms, ..Default::default() })
            }
            ("rankstyle", rest) => {
                let (step, owner) = rest.split_once(':').unwrap_or((rest, ""));
                return levels::rank_style(&self.db, &self.settings, &ev.guild, &ev.member.id, step, owner, None, None);
            }
            ("money", "resetask") => money.reset_prompt(&ev.member, None),
            ("econ", _) => { let server = self.server_name(&ev.guild); return self.economy(&ev.guild, &server).press(ev, ev.at_ms, roll) }
            ("econlb", _) => { let server = self.server_name(&ev.guild); return self.economy(&ev.guild, &server).board_press(ev) }
            ("mpx", _) => return self.economy(&ev.guild, "").open_form(ev),
            ("fh" | "fr", _) => return self.fishing(&ev.guild).press(ev, roll),
            ("fsel" | "frod" | "fs" | "fdx", _) => return self.fishing(&ev.guild).select(ev),
            ("sl" | "cf" | "bj", _) => return self.games(&ev.guild).press(ev, &mut |n| roll(0, n as i64 - 1) as u32),
            ("ar" | "pg", _) => {
                if !self.on(&ev.guild, money::MODULE) { return vec![private("Games need the **economy** module. An admin can turn it on.")]; }
                // the panel's Fishing button opens the fishing hub
                if ev.id == "ar:open:fish" { return self.fishing(&ev.guild).command(&ev.member, ev.at_ms); }
                let games = self.games(&ev.guild);
                return if kind == "pg" { games.duel_press(ev, &mut |n| roll(0, n as i64 - 1) as u32) } else { games.arcade_press(ev, &mut |n| roll(0, n as i64 - 1) as u32) };
            }
            ("mapp", _) => return self.modplus(&ev.guild).appeal_press(ev),
            ("mrep", _) => return self.modplus(&ev.guild).report_press(ev),
            ("mapr", _) => {
                let plus = self.modplus(&ev.guild);
                return match plus.approval_press(ev) {
                    Err(no) => no,
                    Ok((p, approved, mut out)) => {
                        if approved {
                            let s = |k: &str| p[k].as_str().unwrap_or("").to_string();
                            let mut args = std::collections::BTreeMap::new();
                            args.insert("reason".to_string(), s("reason"));
                            args.insert("approved".to_string(), "1".to_string());
                            if p["action"] == "ban" {
                                args.insert("delete_days".to_string(), s("days"));
                                if s("duration") != "-" { args.insert("duration".to_string(), s("duration")); }
                            }
                            let asker = Member { id: s("by"), name: s("byName"), perms: p["byPerms"].as_u64().unwrap_or(0), ..Default::default() };
                            let target = Member { id: s("target"), name: s("targetName"), ..Default::default() };
                            let cmd = CommandEvent { guild: ev.guild.clone(), place: ev.place.clone(), member: asker, name: s("action"), target: Some(target), args, at_ms: ev.at_ms, from_form: true, ..Default::default() };
                            let server = self.server_name(&ev.guild);
                            // the first moderator's own answer is not for the person who approved
                            out.extend(self.moderation(&ev.guild, &server).command(&cmd).into_iter().filter(|a| !matches!(a, Action::Reply { .. })));
                        }
                        out
                    }
                };
            }
            ("mpurge", rest) => return self.moderation(&ev.guild, "").purge_press(&ev.member, rest, ev.at_ms),
            ("money", rest) if rest.starts_with("reset:") => return money.reset_press(&ev.member, &rest["reset:".len()..], ev.at_ms),
            ("gw", rest) => return giveaways::button(&self.db, ev, rest),
            ("ticket", rest) => return self.tickets(&ev.guild).button(ev, rest),
            ("rolemenu", rest) => return self.roles(&ev.guild).press(ev, rest),
            ("verify", _) => return self.members(&ev.guild, "").press(ev, roll),
            ("rp", _) => return roleplay::button(&self.settings, &self.directory, ev),
            ("backup", _) => return backup::press(&self.db, ev),
            ("deadchat", _) => return self.deadchat(&ev.guild).press(ev),
            ("fam", _) => return self.family(&ev.guild).press(ev),
            ("botnews", _) => return self.botnews(&ev.guild).press(ev),
            ("crit", _) => { let mut rand = || roll(0, 999_999) as f64 / 1_000_000.0; return self.critters(&ev.guild).press(ev, &mut rand); }
            ("tvev", _) => return self.tempvoice(&ev.guild).press(ev, ev.at_ms),
            ("eng" | "poll" | "sugg", _) => return self.engagement(&ev.guild).press(ev),
            ("rep", _) => return self.community(&ev.guild).rep_button(ev, ev.at_ms),
            ("st", _) => { let server = self.server_name(&ev.guild); return self.stats(&ev.guild, &server).press(ev); }
            ("party", _) => { let server = self.server_name(&ev.guild); return self.party(&ev.guild, &server).press(ev, &|c| self.directory.in_voice(&ev.guild, c).len()); }
            ("mmail", _) => {
                let server = self.server_name(&ev.guild);
                let user = rest.split(':').nth(1).unwrap_or("").to_string();
                let header = Card::new(Area::General).title("📬 Modmail").line(format!("<@{user}> (`{user}`)"));
                return self.modmail(&ev.guild, &server).press(ev, Some(header));
            }
            (k, rest) if k == "mu" || k.starts_with("mu~") => return self.music_slot(&ev.guild, music::slot_of_kind(k)).button(ev, rest),
            _ => return old(),
        };
        // what a button brings up is for the person who pressed it
        if let Action::Reply { card } = &mut answer {
            card.private = true;
        }
        vec![answer]
    }
}

/// Commands that are staff-only whatever is asked of them: their permission, so it can be checked before the popup opens.
fn command_permission(name: &str) -> Option<crate::perms::Perm> {
    use crate::{logs, messages, moderation as m, money};
    Some(match name {
        "warn" | "unwarn" => m::WARN,
        "timeout" | "untimeout" => m::TIMEOUT,
        "kick" => m::KICK,
        "ban" | "unban" => m::BAN,
        "purge" => m::PURGE,
        "modhistory" | "strikes" => m::HISTORY,
        "logs" => logs::LOGS_PERM,
        "say" | "sticky" => messages::POST,
        "economy-admin" => money::ADMIN,
        _ => return None,
    })
}

/// A fair whole number from `lo` to `hi`, for draws that nobody can predict.
fn roll_between(lo: i64, hi: i64) -> i64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
    let span = (hi - lo + 1).max(1) as u64;
    lo + (h.finish() % span) as i64
}
