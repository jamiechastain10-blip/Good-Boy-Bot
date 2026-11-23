//! What happens in Discord, and what the bot wants done about it, as plain data.

use crate::Card;
use std::collections::BTreeMap;

/// Where something happened: the channel, the channel it belongs to when it is a thread, and their category.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Place {
    pub channel: String,
    /// For a thread: the channel it was started in.
    pub thread_of: Option<String>,
    /// The category of the channel (or of the thread's channel).
    pub category: Option<String>,
}
impl Place {
    pub fn channel(id: &str) -> Place {
        Place { channel: id.to_string(), thread_of: None, category: None }
    }
    /// The channel a thread counts as (a thread counts as the channel it was started in).
    pub fn base(&self) -> &str {
        self.thread_of.as_deref().unwrap_or(&self.channel)
    }
    /// True when this place is, or is inside, any of the listed channels or categories.
    pub fn is_in(&self, list: &[String]) -> bool {
        list.iter().any(|x| x == &self.channel || Some(x.as_str()) == self.thread_of.as_deref() || Some(x.as_str()) == self.category.as_deref())
    }
}
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Member {
    pub id: String,
    /// The name to show for them in this server.
    pub name: String,
    pub avatar: Option<String>,
    pub roles: Vec<String>,
    pub bot: bool,
    /// Their Discord permissions in this server, as Discord's own number. Known for commands and buttons;
    /// 0 for a plain message.
    pub perms: u64,
    /// When they joined the server (ms), when Discord said.
    pub joined_at: Option<i64>,
}
/// Someone posted a message in a server.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MessageEvent {
    pub guild: String,
    pub place: Place,
    pub author: Member,
    /// The message's id, and what it says. The text is empty when the bot is not allowed to read messages
    /// (Message Content is off on the bot's page).
    pub id: String,
    pub text: String,
    /// How many members and roles it mentions.
    pub mentions: usize,
    /// The members it mentions (AFK notices).
    pub mentioned: Vec<Member>,
    /// Files attached: (name, address, size).
    pub files: Vec<(String, String, u64)>,
    /// When, in milliseconds since 1970 (the same clock Good Boy 3 stores).
    pub at_ms: i64,
}
/// Someone used a command.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CommandEvent {
    pub guild: String,
    pub place: Place,
    pub member: Member,
    /// The command, such as "rank" or "money".
    pub name: String,
    /// The part of a grouped command that was picked, such as "daily" in `/money daily`.
    pub sub: Option<String>,
    /// Another member the command is about, when one was picked (and a second, for commands about two people).
    pub target: Option<Member>,
    pub target2: Option<Member>,
    /// What was typed into the command's other boxes, by box name.
    pub args: BTreeMap<String, String>,
    pub at_ms: i64,
    /// The answers came from the command's popup (so it is run, not asked again).
    pub from_form: bool,
}
/// Someone pressed a button on one of the bot's cards.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ButtonEvent {
    pub guild: String,
    pub place: Place,
    pub member: Member,
    /// The button's id, such as "money:daily" or "rank:<member id>".
    pub id: String,
    /// The message the button or list is on.
    pub message: String,
    /// What was picked, for a dropdown list.
    pub values: Vec<String>,
    pub at_ms: i64,
}
/// Someone filled in one of the bot's popups.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FormEvent {
    pub guild: String,
    pub place: Place,
    pub member: Member,
    /// The popup's id, such as "ticket:open:bot".
    pub id: String,
    /// What was typed or picked, by box id. Pickers give ids; several picks are joined with commas.
    pub values: BTreeMap<String, String>,
    /// The members picked in member pickers, with their names and roles.
    pub members: Vec<Member>,
    /// Files uploaded in upload boxes, by box id: (file name, link, size in bytes).
    pub files: BTreeMap<String, Vec<(String, String, u64)>>,
    pub at_ms: i64,
}
/// What a popup box is: typed text, or one of Discord's pickers.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum FieldKind {
    /// Typed text (one line, or several when `long`).
    #[default]
    Text,
    /// A channel picker, limited to these kinds of channel (0 text, 2 voice, 4 category, 5 announcement, 13 stage, 15 forum).
    Channel(Vec<u8>),
    /// A role picker: one role, or up to this many.
    Role { most: u8 },
    /// A member picker: one member, or up to this many.
    User { most: u8 },
    /// A dropdown: (what people see, what the bot gets).
    Select(Vec<(String, String)>),
    /// Uploads: up to this many files.
    Files { most: u8 },
}
/// One box of a popup.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Field {
    pub id: String,
    /// Up to 45 characters, shown above the box.
    pub label: String,
    /// Help shown under the label (up to 100 characters).
    pub desc: Option<String>,
    pub kind: FieldKind,
    /// A tall box for several lines (typed text only).
    pub long: bool,
    pub required: bool,
    pub max: u16,
    pub placeholder: Option<String>,
    /// What the box starts with (typed text, or the picked value of a dropdown or picker).
    pub value: Option<String>,
    /// For a dropdown: a short line shown under each choice, in the same order as the choices.
    pub hints: Vec<String>,
}
/// What goes at the top of a transcript.
#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptHead {
    pub number: i64,
    pub type_label: String,
    pub opener_tag: String,
    pub guild_name: String,
    /// "WHY THIS TICKET WAS OPENED": (label, value)
    pub summary: Vec<(String, String)>,
    /// "txt" or "html"
    pub format: String,
}
/// Where a transcript goes.
#[derive(Debug, Clone, PartialEq)]
pub enum TranscriptTo {
    /// Attached to this card in a channel (the ticket log).
    Channel { channel: String, card: Box<Card> },
    /// Sent to a member by DM with this text.
    Dm { user: String, text: String },
    /// Sent privately to the person who pressed the button or used the command.
    Asker,
}
/// A file to download and keep.
#[derive(Debug, Clone, PartialEq)]
pub struct KeepFile {
    pub name: String,
    pub url: String,
    pub size: u64,
    /// The name it is kept under.
    pub stored: String,
}
/// Something the bot wants done in Discord.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Post a card in a channel. `ping` lists the members the card may notify (nobody else is ever pinged).
    /// `roles` lists the roles it may notify (team reminders); empty for almost everything.
    Send { channel: String, card: Card, ping: Vec<String>, roles: Vec<String> },
    /// Post a card and remember the message: once it is up, the bot is told its id along with `note`.
    /// `ping` and `roles` are who it may notify.
    Post { channel: String, card: Card, note: String, ping: Vec<String>, roles: Vec<String> },
    /// Change a message the bot posted earlier.
    Edit { channel: String, message: String, card: Card },
    /// Change a message the bot posted earlier; when it is gone, post the card again (the bot is told the new
    /// message's id along with `note`): the live leaderboard.
    EditOrPost { channel: String, message: String, card: Card, note: String },
    /// Answer the command or button press with a popup to fill in (up to five boxes).
    Form { id: String, title: String, fields: Vec<Field> },
    /// Make a private channel that only `members`, `staff_roles` and the bot can see. When it exists the bot is
    /// told its id along with `note`, and what it answers then is the answer to the person who asked.
    OpenChannel { name: String, category: Option<String>, topic: String, members: Vec<String>, staff_roles: Vec<String>, note: String },
    /// Set what one member may do in a channel: see it and write in it, see it only, or neither.
    Access { channel: String, user: String, see: bool, write: bool },
    RenameChannel { channel: String, name: String },
    /// Delete a channel after a short wait.
    DeleteChannel { channel: String, after_secs: u32 },
    /// Move a channel into a category (permissions are left as they are).
    MoveChannel { channel: String, category: String },
    /// Make a transcript of a channel from its messages (Good Boy 3's txt or html) and send it where `to` says.
    Transcript { channel: String, head: TranscriptHead, to: Vec<TranscriptTo> },
    /// Download files straight away (Discord's links to uploads stop working) and keep them in the bot's data folder
    /// under `dir`. With `post`, the small ones are posted in that channel under the text given.
    KeepFiles { dir: String, files: Vec<KeepFile>, post: Option<(String, String)> },
    /// Something for the music player to do (play, pause, join a voice channel...).
    Music { cmd: crate::music::MusicCmd, slot: usize },
    /// A second, private message to the person who pressed a button (after the card it was on is updated).
    FollowUp { card: Card },
    /// Answer the command or button press with a new message.
    Reply { card: Card },
    /// Change the card the button is on (a menu moving to its next screen).
    Update { card: Card },
    /// Make a role (a member's profile role) with no permissions, just below `below` (or the bot's own role),
    /// and give it to `give_to`. When it exists the bot is told its id along with `note`.
    /// `give_to` empty: nobody is given it. `mentionable`: it can be pinged (the @deadchat role).
    CreateRole { name: String, color: Option<u32>, hoist: bool, below: Option<String>, give_to: String, note: String, mentionable: bool },
    /// Rename or recolour a role the bot made.
    EditRole { role: String, name: Option<String>, color: Option<u32> },
    DeleteRole { role: String, reason: String },
    /// Count who reacted with `emoji` on a message, leaving out bots and `skip`, and tell the bot (`clip_votes`).
    CountVotes { channel: String, message: String, emoji: String, skip: String },
    /// Post plain text (so Discord shows a link's video player). `video_from`: upload again the video attached to
    /// that message (channel, message) when it fits. `note`: the bot is told the new message's id with it.
    SendText { channel: String, text: String, ping: Vec<String>, roles: Vec<String>, video_from: Option<(String, String)>, note: Option<String> },
    /// Make a voice channel (a party's) holding at most `limit` people. When it exists the bot is told its id
    /// along with `note` (`on_channel_made`).
    OpenVoice { name: String, category: Option<String>, limit: u32, note: String },
    /// Read a message and answer with it as an image quote (`/quote`, right-click > Apps > Quote Image).
    Quote(Box<crate::quotes::QuoteAsk>),
    /// Make a voice room: `inherit_from` (a channel) lends its permissions, `owner` and `allow` get the usual room
    /// permissions, `lock` stops everyone else connecting, and `move_in` are moved into it. When it exists the bot is
    /// told its id along with `note` (`on_room_made`); when the first mover could not be moved in, `on_room_unused`.
    OpenRoom { name: String, category: Option<String>, inherit_from: String, limit: u32, owner: Option<String>, allow: Vec<String>, lock: bool, move_in: Vec<String>, note: String },
    /// Rename a voice room and/or change how many people fit.
    RoomEdit { channel: String, name: Option<String>, limit: Option<u32> },
    /// Change a channel's permissions for a role or member: `allow` and `deny` bits are set, `clear` bits go back to
    /// neutral, everything else stays (like editing in Discord).
    Overwrite { channel: String, id: String, role: bool, allow: u64, deny: u64, clear: u64 },
    /// Take a member's own permissions off a channel.
    ClearOverwrite { channel: String, id: String },
    /// Move a member to a voice channel, or out of voice (None).
    MoveMember { user: String, channel: Option<String> },
    /// A fishing cast is waiting for its bite: after the wait, the Discord layer asks the bot for the card with the
    /// bite showing and edits the player's private message.
    BiteWatch { id: String, after_ms: u64 },
    /// Lock every text channel so nobody can talk (`on`), or put each one back exactly as it was (`/lockdown`).
    Lockdown { on: bool, by: String, reason: String },
    /// Look at the server's members for quiet ones (the Discord layer sends the member list to `inactive`).
    Inactive(Box<crate::stats::InactiveAsk>),
    /// Kick a member for being inactive, telling them why first when `dm` is set.
    KickInactive { user: String, reason: String, dm: Option<String> },
    /// Rename counter channels to their numbers: (channel, name template).
    Counters { items: Vec<(String, String)> },
    /// Count older messages from channel history (a job that messages `by` when it is done).
    Backfill { days: Option<i64>, by: String, channel: String },
    /// Post an announcement: plain text (or, with a card, a card), pinging everyone/here or these roles for real.
    Announce { channel: String, text: String, card: Option<Card>, everyone: bool, roles: Vec<String> },
    /// Read a message that got the star emoji and count its stars; the answer comes back to `on_star`.
    StarCheck { message: String, emoji: String, skip_author: bool, channel: Option<String> },
    /// Text-to-speech work for the Discord layer (join, say one message, stop, leave).
    Tts(crate::tts::TtsCmd),
    /// `/tts voices` (the voices on the bot's computer) or `/tts diagnose` (test every step of speech).
    TtsInfo { diagnose: bool, provider: String, voice: Option<String>, lang: String },
    /// Look something up on the internet for the integrations module (feeds, Minecraft, Twitch keys).
    Fetch(Box<crate::integrations::Fetch>),
    /// Ask Roblox whether a username exists (`/id roblox`), and answer privately.
    Roblox { name: String },
    /// Wait, then tell the bot (`on_later` with `note`): a sticky message's quiet moment.
    Later { after_ms: u64, note: String },
    /// A server backup: the Discord layer reads the server's layout. `id` None: save it (`/backup create`); Some with
    /// `restore` false: show what restoring would add; with `restore` true: put that back.
    Backup { id: Option<i64>, by: String, restore: bool },
    /// Open a private thread in a channel (a forum post in a forum) starting with `card`, pinging `roles`. When it
    /// exists the bot is told its id along with `note`.
    OpenThread { channel: String, name: String, card: Card, roles: Vec<String>, note: String },
    /// Send a member a DM and react on `message` in `channel`: 📨 sent, ⚠️ not (then say why there).
    Relay { user: String, card: Card, channel: String, message: String },
    ArchiveThread { thread: String },
    /// A private message only if that member can see `channel` (highlights never show a channel they can't see).
    DmIfCanSee { user: String, channel: String, card: Card },
    /// Find GIFs for a roleplay action (Tenor, safe search), then post it. `pick`: show a few to choose from first;
    /// otherwise one at random. `query` None: post it without a GIF.
    RpGifs { action: String, from: String, to: Option<String>, query: Option<String>, pick: bool },
    /// Check and keep the bot owner's Tenor key (None switches Tenor off). It is never shown again.
    TenorKey { key: Option<String> },
    /// Translate text into the member's Discord language and answer privately (right-click > Apps > Translate).
    Translate { text: String, to: String },
    /// Give a member roles and take roles away (level rewards). The Discord layer skips roles the bot may not manage.
    Roles { user: String, add: Vec<String>, remove: Vec<String>, reason: String },
    /// Send a member a private message. When their DMs are closed, post the `or_in` card in that channel instead.
    Dm { user: String, card: Card, or_in: Option<(String, Box<Card>)> },
    /// Put an emoji on a message.
    React { channel: String, message: String, emoji: String },
    /// Remove several messages in one channel at once.
    DeleteMany { channel: String, messages: Vec<String> },
    /// Post a short notice and take it down again after a few seconds.
    Flash { channel: String, card: Card, ping: Vec<String>, after_secs: u32 },
    /// Send a message as someone else (a webhook with their name and picture), then remove the original if it is given.
    /// `thread`: the thread to post in, when `channel` is the channel it was started in. `note` comes back with the new
    /// message's id.
    /// Download a picture a member uploaded in their rank card popup and keep it as their card background. The
    /// Discord layer fetches it (the link stops working after a day) and tells the bot with `rank_background_saved`.
    SaveRankBackground { member: String, name: String, url: String },
    Proxy { channel: String, thread: Option<String>, name: String, avatar: Option<String>, text: String, files: Vec<(String, String, u64)>, original: Option<String>, note: String },
    /// Remove one message.
    Delete { channel: String, message: String },
    /// Remove the newest `count` messages in a channel (only `from`'s, when given). Pinned messages are kept.
    /// Delete messages in a channel, newest first: up to `count` (u64::MAX = all), only `from`'s when set, keeping
    /// pins when `keep_pinned`. `progress`: a long purge that shows its progress and can be stopped. `by` did it.
    Purge { channel: String, count: u64, from: Option<String>, keep_pinned: bool, progress: bool, by: String },
    /// Stop the purge running in this channel.
    PurgeStop { channel: String },
    /// Clone a channel in place and delete the old one: every message gone at once (`by` asked).
    RecreateChannel { channel: String, by: String },
    /// `case` on these four is the moderation case that recorded it (0 for none): if Discord refuses, the case is taken back.
    Kick { user: String, reason: String, case: i64 },
    /// `delete_days`: also remove their messages from the last 0 to 7 days.
    Ban { user: String, reason: String, delete_days: u32, case: i64 },
    Unban { user: String, reason: String, case: i64 },
    /// Time a member out until then (milliseconds since 1970); `None` lifts a timeout.
    Timeout { user: String, until_ms: Option<i64>, reason: String, case: i64 },
}
