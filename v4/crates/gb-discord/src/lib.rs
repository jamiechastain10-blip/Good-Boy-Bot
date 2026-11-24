//! Basic Ghost Labs - Good Boy 4. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
//!
//! The connection to Discord. It does three small jobs and nothing else:
//!   1. turns what Discord sends into the core's plain events,
//!   2. hands them to the core (`gb_core::Bot`),
//!   3. carries out the actions the core asks for.
//!
//! It remembers very little: where each channel sits (for threads and categories) and the names of members it
//! has seen (for the leaderboard). It never keeps whole member lists or old messages, which is what keeps the
//! bot light on big servers.

use gb_core::bot::{Named, Opt, Takes};
use gb_core::{Action, Bot, ButtonEvent, Card, CommandEvent, FormEvent, Member, MessageEvent, Place};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use twilight_gateway::{Event, EventTypeFlags, Intents, Shard, ShardId, StreamExt as _};
use twilight_http::request::AuditLogReason as _;
use twilight_http::Client;
use twilight_model::application::command::Command;
use twilight_model::application::interaction::application_command::CommandOptionValue;
use twilight_model::application::interaction::{Interaction, InteractionData};
use twilight_model::channel::message::{AllowedMentions, Component, MessageFlags};
use twilight_model::channel::Channel;
use twilight_model::guild::PartialMember;
use twilight_model::http::interaction::InteractionResponse;
use twilight_model::id::marker::{ApplicationMarker, ChannelMarker, GuildMarker, RoleMarker, UserMarker};
use twilight_model::id::Id;
use twilight_model::user::User;

mod dsp;
mod feeds;
mod lookup;
mod speech;
mod voice;
pub use lookup::{find_ytdlp, search_songs};
mod links;

/// A card as Discord's own component types. This is also the check that the core's layout is one Discord's
/// library accepts.
/// Whether a card carries something the member should keep (an export, a transcript). A picture (a game's board, a
/// card) is not: a private message with only pictures is taken down like any other once nobody is using it.
fn keeps_files(card: &Card) -> bool {
    card.files.iter().any(|f| !matches!(f.name.rsplit('.').next().map(str::to_ascii_lowercase).as_deref(), Some("png" | "gif" | "jpg" | "jpeg" | "webp")))
}
/// A private game window gets a Close button, so a player can put it away without waiting.
fn with_close(card: &Card) -> Card {
    if !card.private || card.area != gb_core::Area::Games || card.lines.is_empty() { return card.clone(); }
    let closed = card.clone().button_with("gbclose".to_string(), "Close", gb_core::ButtonStyle::Plain, Some("✖️".into()));
    if components(&closed).is_ok() { closed } else { card.clone() }
}
pub fn components(card: &Card) -> Result<Vec<Component>, String> {
    // the card's own help text names commands the way they are typed now (`/mod ban`)
    let mut named = card.clone();
    named.title = named.title.map(|t| gb_core::folds::rewrite(&t).into_owned());
    for l in named.lines.iter_mut() { if let std::borrow::Cow::Owned(r) = gb_core::folds::rewrite(l) { *l = r; } }
    let d = named.to_discord().map_err(|e| e.to_string())?;
    serde_json::from_value(d["components"].clone()).map_err(|e| format!("the card is not a layout Discord accepts: {e}"))
}
/// What a message's cards say, as plain text (one entry per card).
fn card_texts(list: &[Component]) -> Vec<String> {
    fn walk(c: &Component, out: &mut Vec<String>) {
        match c {
            Component::TextDisplay(t) => out.push(t.content.clone()),
            Component::Container(x) => for y in &x.components { walk(y, out) },
            Component::Section(x) => for y in &x.components { walk(y, out) },
            _ => {}
        }
    }
    list.iter().map(|c| { let mut v = Vec::new(); walk(c, &mut v); v.join("\n") }).filter(|t| !t.is_empty()).collect()
}
/// The card's files, as Discord attachments (the card's layout points to them by name).
fn files_of(card: &Card) -> Vec<twilight_model::http::attachment::Attachment> {
    card.files.iter().enumerate().map(|(k, f)| twilight_model::http::attachment::Attachment::from_bytes(f.name.clone(), f.data.to_vec(), k as u64)).collect()
}
fn flags(card: &Card) -> MessageFlags {
    if card.private { MessageFlags::IS_COMPONENTS_V2 | MessageFlags::EPHEMERAL } else { MessageFlags::IS_COMPONENTS_V2 }
}
fn option_json(o: &Opt) -> serde_json::Value {
    // Discord's option types: 3 = text, 4 = a whole number, 6 = a member picker, 7 = a channel picker, 8 = a role picker
    let mut v = json!({ "name": o.name, "description": o.about, "required": o.required });
    match o.takes {
        Takes::Member => v["type"] = json!(6),
        Takes::Text => v["type"] = json!(3),
        Takes::Whole { min, max } => { v["type"] = json!(4); v["min_value"] = json!(min); v["max_value"] = json!(max); }
        Takes::Role => v["type"] = json!(8),
        Takes::Category => { v["type"] = json!(7); v["channel_types"] = json!([4]); }
        Takes::AnyChannel => v["type"] = json!(7),
        Takes::YesNo => v["type"] = json!(5),
        Takes::Channel => { v["type"] = json!(7); v["channel_types"] = json!([0, 5]); } // text and announcement channels
        Takes::Choice(list) => { v["type"] = json!(3); v["choices"] = json!(list.iter().map(|(name, value)| json!({ "name": name, "value": value })).collect::<Vec<_>>()); }
    }
    v
}
/// The slash commands to register, from the core's list. Grouped commands become sub-commands (type 1).
/// Good Boy 3's right-click commands on a member: Warn member (moderation), View wallet and Pay member (economy).
pub const USER_COMMANDS: &[&str] = &["View wallet", "Pay member", "Warn member", "Message stats"];
/// Good Boy 3's right-click commands on a message.
pub const MESSAGE_COMMANDS: &[&str] = &["Translate", "Quote Image", "Quote Image (Color)", "Report message"];
pub fn commands() -> Vec<Command> {
    gb_core::folds::menu()
        .iter()
        .map(|c| {
            // Discord wants the boxes that must be filled in listed before the optional ones
            let ordered = |list: &[Opt]| list.iter().filter(|o| o.required).chain(list.iter().filter(|o| !o.required)).map(option_json).collect::<Vec<_>>();
            // every command is a popup (as in Good Boy 3): Discord gets the commands without their typed boxes, so
            // the command bar never asks for text; the popup built from the boxes opens when the command runs.
            // A command that opens its own popup is registered the same way.
            let _ = ordered;
            let options: Vec<serde_json::Value> = if c.subs.is_empty() {
                Vec::new()
            } else {
                // a part named "group part" (such as "type add") goes inside its group (type 2), in the order listed
                let mut out: Vec<serde_json::Value> = Vec::new();
                for s in c.subs {
                    match s.name.split_once(' ') {
                        None => out.push(json!({ "type": 1, "name": s.name, "description": s.about, "options": [] })),
                        Some((group, part)) => {
                            let leaf = json!({ "type": 1, "name": part, "description": s.about, "options": [] });
                            match out.iter_mut().find(|o| o["type"] == 2 && o["name"] == group) {
                                Some(g) => g["options"].as_array_mut().unwrap().push(leaf),
                                None => out.push(json!({ "type": 2, "name": group, "description": gb_core::bot::group_about(c.name, group), "options": [leaf] })),
                            }
                        }
                    }
                }
                out
            };
            // contexts [0] = servers only
            serde_json::from_value(json!({ "name": c.name, "description": c.about, "type": 1, "options": options, "contexts": [0], "version": "1" })).expect("a command Discord's library accepts")
        })
        // right-click > Apps > Warn member (Good Boy 3's user command): opens the warning form for that member
        // right-click > Apps: Good Boy 3's user commands
        .chain(USER_COMMANDS.iter().map(|name| serde_json::from_value(json!({ "name": name, "description": "", "type": 2, "contexts": [0], "version": "1" })).expect("a user command Discord's library accepts")))
        .chain(MESSAGE_COMMANDS.iter().map(|name| serde_json::from_value(json!({ "name": name, "description": "", "type": 3, "contexts": [0], "version": "1" })).expect("a message command Discord's library accepts")))
        .collect()
}

/// A member Discord sent along with a command (picked in a box, or right-clicked).
fn resolved_member(r: Option<&twilight_model::application::interaction::InteractionDataResolved>, id: twilight_model::id::Id<twilight_model::id::marker::UserMarker>) -> Option<Member> {
    let r = r?;
    let user = r.users.get(&id)?;
    let m = r.members.get(&id);
    let name = m.and_then(|m| m.nick.clone()).or_else(|| user.global_name.clone()).unwrap_or_else(|| user.name.clone());
    Some(Member { id: id.to_string(), name, avatar: user.avatar.map(|h| format!("https://cdn.discordapp.com/avatars/{id}/{h}.png?size=128")), roles: m.map(|m| m.roles.iter().map(|r| r.to_string()).collect()).unwrap_or_default(), bot: user.bot, perms: m.map(|m| m.permissions.bits()).unwrap_or(0), joined_at: m.and_then(|m| m.joined_at).map(|t| t.as_micros() / 1000) })
}

/// Where channels sit: each channel's parent (a thread's channel, or a channel's category) and whether it is a thread.
#[derive(Default)]
struct Places(HashMap<u64, (Option<u64>, bool)>);
impl Places {
    fn learn(&mut self, c: &Channel) {
        self.0.insert(c.id.get(), (c.parent_id.map(Id::get), c.kind.is_thread()));
    }
    fn forget(&mut self, id: Id<ChannelMarker>) {
        self.0.remove(&id.get());
    }
    fn place(&self, channel: Id<ChannelMarker>) -> Place {
        let id = channel.get();
        match self.0.get(&id) {
            Some((Some(parent), true)) => Place { channel: id.to_string(), thread_of: Some(parent.to_string()), category: self.0.get(parent).and_then(|(cat, _)| *cat).map(|c| c.to_string()) },
            Some((category, _)) => Place { channel: id.to_string(), thread_of: None, category: category.map(|c| c.to_string()) },
            None => Place::channel(&id.to_string()),
        }
    }
}
/// Names of members seen lately, for the leaderboard. Capped, so it cannot grow without end on a big server.
#[derive(Default)]
struct Names(HashMap<(u64, u64), String>);
impl Names {
    const MOST: usize = 20_000;
    fn learn(&mut self, guild: u64, user: u64, name: &str) {
        if self.0.len() >= Self::MOST && !self.0.contains_key(&(guild, user)) {
            self.0.clear(); // rare, and names come back as people talk
        }
        self.0.insert((guild, user), name.to_string());
    }
}

fn member_from(user: &User, member: Option<&PartialMember>, guild: Id<GuildMarker>) -> Member {
    let name = member.and_then(|m| m.nick.clone()).or_else(|| user.global_name.clone()).unwrap_or_else(|| user.name.clone());
    // a server avatar when they have one, else their own; none means Discord's default picture
    let avatar = match (member.and_then(|m| m.avatar), user.avatar) {
        (Some(hash), _) => Some(format!("https://cdn.discordapp.com/guilds/{guild}/users/{}/avatars/{hash}.png?size=128", user.id)),
        (None, Some(hash)) => Some(format!("https://cdn.discordapp.com/avatars/{}/{hash}.png?size=128", user.id)),
        (None, None) => None,
    };
    Member { id: user.id.to_string(), name, avatar, roles: member.map(|m| m.roles.iter().map(|r| r.to_string()).collect()).unwrap_or_default(), bot: user.bot, perms: member.and_then(|m| m.permissions).map(|p| p.bits()).unwrap_or(0), joined_at: member.and_then(|m| m.joined_at).map(|t| t.as_micros() / 1000) }
}

/// A DM waiting for its server: (member, text, files, DM channel, message id, when).
type PendingDm = (Member, String, Vec<(String, String, u64)>, String, String, i64);
/// GIFs offered for a roleplay action: (server, action, from, to, the GIFs).
type RpPick = (String, String, String, Option<String>, Vec<String>);
/// A popup waiting for its "Continue" button: (who may open it, its id, its title, its boxes, when it was made).
type NextForm = (String, String, String, Vec<gb_core::Field>, i64);
/// A private message that goes when nobody has touched it for a while.
struct Dismiss {
    token: String,
    followup: Option<Id<twilight_model::id::marker::MessageMarker>>,
    due: i64,
}
struct Link {
    bot: Arc<Bot>,
    http: Client,
    app: Id<ApplicationMarker>,
    /// The bot's own user id (it gives itself access to the private channels it makes).
    me: Id<UserMarker>,
    places: Mutex<Places>,
    names: Mutex<Names>,
    /// Music in voice.
    voice: Arc<voice::Voice>,
    /// The helper music bots' sound, by number (index 0 is unused: the main bot's is `voice`).
    helper_voices: Vec<Option<Arc<voice::Voice>>>,
    /// For fetching pictures (avatars and backgrounds on rank cards) and keeping files.
    web: reqwest::Client,
    /// The bot's data folder (ticket files are kept under it).
    data: std::path::PathBuf,
    /// Purges running, by channel: set to stop one.
    purges: Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
    /// What each member was last seen playing ("server:user"), so a change can be told apart (game roles).
    playing: Mutex<HashMap<String, Vec<String>>>,
    /// Each member's roles as last seen ("server:user"): Discord doesn't say them when someone leaves, and Good Boy
    /// 3 gives them back if the member returns.
    member_roles: Mutex<HashMap<String, Vec<String>>>,
    /// GIFs shown to pick from for a roleplay action: pick id → (server, action, from, to, the GIFs).
    rp_picks: Mutex<HashMap<String, RpPick>>,
    /// A popup that was due to open straight after another popup (Discord cannot do that): kept for the "Continue" button.
    next_forms: Mutex<HashMap<String, NextForm>>,
    /// Interactions that were slow and so were acknowledged early; their answer goes out as an edit or a follow-up.
    slow: Mutex<std::collections::HashSet<u64>>,
    /// Each server's invites as last seen: code → (uses, who made it, most uses), to tell which one a new member used.
    invites: Mutex<HashMap<u64, HashMap<String, gb_core::invites::Invite>>>,
    /// A member's DM waiting for them to pick which server's staff it is for.
    mm_pending: Mutex<HashMap<u64, PendingDm>>,
    /// Private messages waiting to be taken down: key → (the interaction token that can delete it, the follow-up it is
    /// (none for the first answer), when it goes).
    dismiss: Mutex<HashMap<String, Dismiss>>,
}
impl Link {
    /// Carries out one action. Err says, in plain words, why Discord would not do it.
    /// The webhook this bot uses to speak as someone else in a channel (made the first time, then remembered).
    /// A proxied message that could not be sent says why in the channel, once in five minutes per channel (the reason
    /// otherwise only reaches the Logs page, and the member just sees nothing happen).
    async fn proxy_notice(&self, channel: Id<ChannelMarker>, why: &str) {
        static LAST: std::sync::OnceLock<Mutex<HashMap<u64, i64>>> = std::sync::OnceLock::new();
        let now = now_ms();
        {
            let mut last = LAST.get_or_init(Mutex::default).lock().unwrap_or_else(|p| p.into_inner());
            if now - last.get(&channel.get()).copied().unwrap_or(0) < 5 * 60_000 { return; }
            last.insert(channel.get(), now);
        }
        let _ = self.http.create_message(channel).content(&format!("🧩 Plural proxy: {why}")).await;
    }
    async fn proxy_webhook(&self, channel: Id<ChannelMarker>) -> Result<(Id<twilight_model::id::marker::WebhookMarker>, String), String> {
        type Hook = (Id<twilight_model::id::marker::WebhookMarker>, String);
        static CACHE: std::sync::OnceLock<Mutex<HashMap<u64, Hook>>> = std::sync::OnceLock::new();
        let cache = CACHE.get_or_init(Mutex::default);
        if let Some(found) = cache.lock().unwrap_or_else(|p| p.into_inner()).get(&channel.get()).cloned() { return Ok(found); }
        const NO: &str = "I can't make a webhook here. Give my role **Manage Webhooks** in this channel.";
        let existing = self.http.channel_webhooks(channel).await.map_err(|_| NO.to_string())?.models().await.map_err(|e| e.to_string())?;
        let mine = existing.into_iter().find(|w| w.name.as_deref() == Some("Good Boy proxy") && w.token.is_some());
        let hook = match mine {
            Some(w) => w,
            None => self.http.create_webhook(channel, "Good Boy proxy").await.map_err(|_| NO.to_string())?.model().await.map_err(|e| e.to_string())?,
        };
        let token = hook.token.clone().ok_or_else(|| NO.to_string())?;
        cache.lock().unwrap_or_else(|p| p.into_inner()).insert(channel.get(), (hook.id, token.clone()));
        Ok((hook.id, token))
    }
    async fn perform(&self, guild: Id<GuildMarker>, action: Action) -> Result<(), String> {
        const NO: &str = "Discord refused. My role may be below theirs, or I'm missing the permission for that.";
        let user_id = |u: &str| u.parse::<Id<UserMarker>>().map_err(|_| "That is not a member.".to_string());
        match action {
            Action::Send { channel, card, ping, roles } => {
                let Ok(channel) = channel.parse::<Id<ChannelMarker>>() else { return Ok(()) };
                // a card with a rank picture (a level-up shown as the member's own card): the picture goes up with the card's
                // buttons and a line of text, and nobody is pinged unless the action says so. If it cannot be drawn, the text card goes instead.
                // a welcome or goodbye card: the picture goes up with the message's words; the text card goes if it cannot be drawn
                if let Some(gb_core::Art::Greeting(art)) = &card.art {
                    let mentions = AllowedMentions { parse: Vec::new(), replied_user: false, roles: Vec::new(), users: ping.iter().filter_map(|u| u.parse::<Id<UserMarker>>().ok()).collect() };
                    if let Some(bytes) = self.draw_greeting(art).await {
                        let said = card.lines.join("\n");
                        let file = twilight_model::http::attachment::Attachment::from_bytes("greeting.png".into(), bytes, 0);
                        self.http.create_message(channel).content(&said).attachments(&[file]).allowed_mentions(Some(&mentions)).await.map_err(|e| post_refusal(channel, &e))?;
                        return Ok(());
                    }
                    let mut text = card.clone();
                    text.art = None;
                    let parts = components(&text)?;
                    self.http.create_message(channel).flags(flags(&text)).components(&parts).allowed_mentions(Some(&mentions)).await.map_err(|e| post_refusal(channel, &e))?;
                    return Ok(());
                }
                if let Some(gb_core::Art::Rank(art)) = &card.art {
                    if let Some((name, bytes)) = self.draw_rank(&guild.to_string(), art).await {
                        let buttons: Vec<serde_json::Value> = card.buttons.iter().map(|b| {
                            let mut x = json!({ "type": 2, "style": 2, "custom_id": b.id, "label": b.label });
                            if let Some(e) = &b.emoji { x["emoji"] = json!({ "name": e }); }
                            x
                        }).collect();
                        let rows = if buttons.is_empty() { json!([]) } else { json!([{ "type": 1, "components": buttons }]) };
                        let parts = serde_json::from_value::<Vec<Component>>(rows).unwrap_or_default();
                        let mentions = AllowedMentions { parse: Vec::new(), replied_user: false, roles: Vec::new(), users: ping.iter().filter_map(|u| u.parse::<Id<UserMarker>>().ok()).collect() };
                        let file = twilight_model::http::attachment::Attachment::from_bytes(name.into(), bytes, 0);
                        let said = card.title.clone().unwrap_or_default();
                        self.http.create_message(channel).content(&said).components(&parts).attachments(&[file]).allowed_mentions(Some(&mentions)).await.map_err(|e| post_refusal(channel, &e))?;
                        return Ok(());
                    }
                    let mut text = card.clone();
                    text.art = None;
                    let parts = components(&text)?;
                    let mentions = AllowedMentions { parse: Vec::new(), replied_user: false, roles: Vec::new(), users: ping.iter().filter_map(|u| u.parse::<Id<UserMarker>>().ok()).collect() };
                    self.http.create_message(channel).flags(flags(&text)).components(&parts).allowed_mentions(Some(&mentions)).await.map_err(|e| post_refusal(channel, &e))?;
                    return Ok(());
                }
                let parts = components(&card)?;
                // only the people and roles the card names may be pinged; never everyone
                let mentions = AllowedMentions { parse: Vec::new(), replied_user: false, roles: roles.iter().filter_map(|r| r.parse::<Id<RoleMarker>>().ok()).collect(), users: ping.iter().filter_map(|u| u.parse::<Id<UserMarker>>().ok()).collect() };
                self.http.create_message(channel).flags(flags(&card)).components(&parts).attachments(&files_of(&card)).allowed_mentions(Some(&mentions)).await.map_err(|e| post_refusal(channel, &e))?;
            }
            Action::Post { channel, card, note, ping, roles } => {
                let Ok(channel) = channel.parse::<Id<ChannelMarker>>() else { return Ok(()) };
                let parts = components(&card)?;
                let mentions = AllowedMentions { parse: Vec::new(), replied_user: false, roles: roles.iter().filter_map(|r| r.parse::<Id<RoleMarker>>().ok()).collect(), users: ping.iter().filter_map(|u| u.parse::<Id<UserMarker>>().ok()).collect() };
                let sent = self.http.create_message(channel).flags(flags(&card)).components(&parts).attachments(&files_of(&card)).allowed_mentions(Some(&mentions)).await.map_err(|e| post_refusal(channel, &e))?.model().await.map_err(|e| e.to_string())?;
                // a note ending in ";pin": the message is pinned in the channel once it is up (panels from the dashboard)
                let (note, pin) = match note.strip_suffix(";pin") { Some(n) => (n.to_string(), true), None => (note, false) };
                self.bot.on_posted(&guild.to_string(), &note, &sent.id.to_string());
                if pin {
                    self.http.create_pin(channel, sent.id).await.map_err(|_| format!("The panel is posted, but I couldn't pin it in <#{channel}>. Give my role **Pin Messages** (or Manage Messages) there."))?;
                }
            }
            Action::Access { channel, user, see, write } => {
                use twilight_model::guild::Permissions as P;
                use twilight_model::http::permission_overwrite::{PermissionOverwrite, PermissionOverwriteType};
                let (Ok(c), Ok(u)) = (channel.parse::<Id<ChannelMarker>>(), user.parse::<Id<UserMarker>>()) else { return Ok(()) };
                if !see {
                    self.http.delete_channel_permission(c).member(u).await.map_err(|_| "Discord would not change who can see the channel. I need Manage Channels there.".to_string())?;
                } else {
                    let read = P::VIEW_CHANNEL | P::READ_MESSAGE_HISTORY;
                    let talk = P::SEND_MESSAGES | P::ATTACH_FILES | P::EMBED_LINKS;
                    let over = PermissionOverwrite { allow: Some(if write { read | talk } else { read }), deny: Some(if write { P::empty() } else { P::SEND_MESSAGES }), id: u.cast(), kind: PermissionOverwriteType::Member };
                    self.http.update_channel_permission(c, &over).await.map_err(|_| "Discord would not change who can write in the channel. I need Manage Channels there.".to_string())?;
                }
            }
            Action::RenameChannel { channel, name } => {
                if let Ok(c) = channel.parse::<Id<ChannelMarker>>() {
                    self.http.update_channel(c).name(&name).await.map_err(|e| format!("Could not rename channel {c}: {e}"))?;
                }
            }
            Action::DeleteChannel { channel, after_secs } => {
                if let Ok(c) = channel.parse::<Id<ChannelMarker>>() {
                    tokio::time::sleep(std::time::Duration::from_secs(after_secs.min(60) as u64)).await;
                    self.http.delete_channel(c).await.map_err(|e| format!("Could not delete channel {c}: {e}"))?;
                }
            }
            Action::MoveChannel { channel, category } => {
                if let (Ok(c), Ok(cat)) = (channel.parse::<Id<ChannelMarker>>(), category.parse::<Id<ChannelMarker>>()) {
                    self.http.update_channel(c).parent_id(Some(cat)).reason("Ticket setup: move tickets into the ticket category").await.map_err(|e| format!("Could not move channel {c}: {e}"))?;
                }
            }
            Action::Transcript { channel, head, to } => {
                let file = self.transcript(&channel, &head).await;
                for t in to { self.deliver_transcript(&t, file.as_ref(), None).await; }
            }
            Action::KeepFiles { dir, files, post } => self.keep_files(&dir, &files, post).await,
            // these two only make sense as the answer to a button or a form (see `on_interaction`)
            Action::Form { .. } | Action::OpenChannel { .. } => {}
            Action::Edit { channel, message, card } => {
                if let (Ok(c), Ok(m)) = (channel.parse::<Id<ChannelMarker>>(), message.parse()) {
                    let parts = components(&card)?;
                    self.http.update_message(c, m).components(Some(&parts)).await.map_err(|e| format!("Could not update a message in channel {c}: {e}"))?;
                }
            }
            Action::Lockdown { on, .. } => self.lockdown(guild, on).await?,
            Action::BiteWatch { .. } => {} // handled with the answer to the press (see `on_interaction`)
            Action::EditOrPost { channel, message, card, note } => {
                let edited = match (channel.parse::<Id<ChannelMarker>>(), message.parse::<Id<twilight_model::id::marker::MessageMarker>>()) {
                    (Ok(c), Ok(m)) => match components(&card) {
                        Ok(parts) => self.http.update_message(c, m).components(Some(&parts)).await.is_ok(),
                        Err(_) => false,
                    },
                    _ => false,
                };
                // the message is gone (or can't be changed): put the card up again
                if !edited { Box::pin(self.perform(guild, Action::Post { channel, card, note, ping: Vec::new(), roles: Vec::new() })).await?; }
            }
            Action::CreateRole { name, color, hoist, below, give_to, note, mentionable } => {
                let mut req = self.http.create_role(guild).name(&name).hoist(hoist).mentionable(mentionable).permissions(twilight_model::guild::Permissions::empty());
                if let Some(c) = color { req = req.color(c); }
                let role = match req.await {
                    Ok(r) => r.model().await.map_err(|e| e.to_string())?,
                    Err(e) => return Err(format!("Could not make the role {name} (the bot needs Manage Roles, high in the list): {e}")),
                };
                // just below the anchor role, never above the bot's own highest role (Good Boy 3's placing)
                let g = guild.to_string();
                let dir = &self.bot.directory;
                if let Some(top) = dir.my_top(&g) {
                    let anchor = below.as_deref().and_then(|a| dir.role(&g, a)).map(|r| r.position).unwrap_or(top);
                    let target = (anchor - 1).min(top - 1).max(1) as u64;
                    let _ = self.http.update_role_positions(guild, &[twilight_model::guild::RolePosition { id: role.id, position: target }]).await;
                }
                if let Ok(user) = user_id(&give_to).map_err(|_| ()).and_then(|u| if give_to.is_empty() { Err(()) } else { Ok(u) }) {
                    if let Err(e) = self.http.add_guild_member_role(guild, user, role.id).reason("Profile role").await {
                        eprintln!("Made the role {} but could not give it (move the bot's role higher): {e}", role.name);
                    }
                }
                for action in self.bot.on_role_made(&g, &note, &role.id.to_string(), now_ms()) { Box::pin(self.perform(guild, action)).await.unwrap_or_else(|e| eprintln!("{e}")); }
            }
            Action::EditRole { role, name, color } => {
                if let Ok(r) = role.parse::<Id<RoleMarker>>() {
                    let mut req = self.http.update_role(guild, r).reason("Profile edit");
                    if let Some(n) = name.as_deref() { req = req.name(Some(n)); }
                    if let Some(c) = color { req = req.color(Some(c)); }
                    req.await.map_err(|e| format!("Could not change role {r}: {e}"))?;
                }
            }
            Action::DeleteRole { role, reason } => {
                if let Ok(r) = role.parse::<Id<RoleMarker>>() {
                    let _ = self.http.delete_role(guild, r).reason(&reason).await;
                }
            }
            Action::OpenThread { channel, name, card, roles, note } => {
                let c = channel.parse::<Id<ChannelMarker>>().map_err(|_| "That channel is gone.".to_string())?;
                let parts = components(&card)?;
                let ping = AllowedMentions { roles: roles.iter().filter_map(|r| r.parse().ok()).collect(), ..Default::default() };
                let kind = async { self.http.channel(c).await.ok()?.model().await.ok() }.await.map(|ch| ch.kind);
                let thread = if kind == Some(twilight_model::channel::ChannelType::GuildForum) {
                    let made = self.http.create_forum_thread(c, &name).message().flags(MessageFlags::IS_COMPONENTS_V2).components(&parts).allowed_mentions(Some(&ping)).await.map_err(|e| format!("I couldn't open a modmail thread in <#{c}>: {e}"))?;
                    made.model().await.map_err(|e| e.to_string())?.channel.id
                } else {
                    let starter = self.http.create_message(c).flags(MessageFlags::IS_COMPONENTS_V2).components(&parts).allowed_mentions(Some(&ping)).await.map_err(|e| format!("I couldn't post in <#{c}>: {e}"))?.model().await.map_err(|e| e.to_string())?;
                    self.http.create_thread_from_message(c, starter.id, &name).auto_archive_duration(twilight_model::channel::thread::AutoArchiveDuration::Week).await.map_err(|e| format!("I couldn't open a modmail thread: {e}"))?.model().await.map_err(|e| e.to_string())?.id
                };
                self.places.lock().unwrap_or_else(|p| p.into_inner()).0.insert(thread.get(), (Some(c.get()), true));
                for action in self.bot.on_thread_made(&guild.to_string(), &note, &thread.to_string(), now_ms()) { Box::pin(self.perform(guild, action)).await.unwrap_or_else(|e| eprintln!("{e}")); }
            }
            Action::Relay { user, card, channel, message } => {
                let (Ok(u), Ok(c), Ok(m)) = (user_id(&user), channel.parse::<Id<ChannelMarker>>(), message.parse::<Id<twilight_model::id::marker::MessageMarker>>()) else { return Ok(()) };
                let parts = components(&card)?;
                let sent = async { let dm = self.http.create_private_channel(u).await.ok()?.model().await.ok()?; self.http.create_message(dm.id).flags(MessageFlags::IS_COMPONENTS_V2).components(&parts).await.ok() }.await.is_some();
                let emoji = twilight_http::request::channel::reaction::RequestReactionType::Unicode { name: if sent { "📨" } else { "⚠️" } };
                let _ = self.http.create_reaction(c, m, &emoji).await;
                if !sent { let _ = self.http.create_message(c).content("I couldn't DM them (they may have DMs from this server turned off).").reply(m).await; }
            }
            Action::ArchiveThread { thread } => {
                if let Ok(t) = thread.parse::<Id<ChannelMarker>>() { let _ = self.http.update_thread(t).archived(true).await; }
            }
            Action::DmIfCanSee { user, channel, card } => {
                let (Ok(u), Ok(c)) = (user_id(&user), channel.parse::<Id<ChannelMarker>>()) else { return Ok(()) };
                if !can_see(self, guild, u, c).await { return Ok(()); }
                let parts = components(&card)?;
                if let Ok(dm) = async { self.http.create_private_channel(u).await.ok()?.model().await.ok() }.await.ok_or(()) {
                    let _ = self.http.create_message(dm.id).flags(MessageFlags::IS_COMPONENTS_V2).components(&parts).await;
                }
            }
            Action::OpenRoom { name, category, inherit_from, limit, owner, allow, lock, move_in, note } => {
                use twilight_model::guild::Permissions as P;
                use twilight_model::channel::permission_overwrite::{PermissionOverwrite, PermissionOverwriteType as Kind};
                let room = P::VIEW_CHANNEL | P::CONNECT | P::SPEAK | P::STREAM | P::USE_VAD;
                let cat = category.as_deref().and_then(|c| c.parse::<Id<ChannelMarker>>().ok());
                // permissions come from the room's category (or the lobby when it has none), except the owner's and mine
                let inherit = inherit_from.parse::<Id<ChannelMarker>>().ok();
                let lobby = match inherit { Some(c) => async { self.http.channel(c).await.ok()?.model().await.ok() }.await, None => None };
                let parent_id = cat.or_else(|| lobby.as_ref().and_then(|l| l.parent_id));
                let source = match parent_id { Some(p) => async { self.http.channel(p).await.ok()?.model().await.ok() }.await, None => lobby };
                let mine = owner.iter().chain(allow.iter()).filter_map(|u| u.parse::<Id<UserMarker>>().ok()).collect::<Vec<_>>();
                let mut over: Vec<PermissionOverwrite> = source.and_then(|s| s.permission_overwrites).unwrap_or_default().into_iter().filter(|o| o.id.get() != self.me.get() && !mine.iter().any(|u| u.get() == o.id.get())).collect();
                if lock {
                    over.retain(|o| o.id.get() != guild.get());
                    over.push(PermissionOverwrite { allow: P::empty(), deny: P::CONNECT, id: guild.cast(), kind: Kind::Role });
                }
                over.extend(mine.iter().map(|u| PermissionOverwrite { allow: room, deny: P::empty(), id: u.cast(), kind: Kind::Member }));
                over.push(PermissionOverwrite { allow: room | P::MANAGE_CHANNELS | P::MOVE_MEMBERS, deny: P::empty(), id: self.me.cast(), kind: Kind::Member });
                let mut req = self.http.create_guild_channel(guild, &name).kind(twilight_model::channel::ChannelType::GuildVoice).user_limit(limit.min(99) as u16).permission_overwrites(&over);
                if let Some(p) = parent_id { req = req.parent_id(p); }
                let made = match req.await { Ok(r) => r.model().await.map_err(|e| e.to_string())?, Err(_) => return Err("I couldn't create the room (I need Manage Channels and Move Members, and the category needs space).".into()) };
                for a in self.bot.on_room_made(&guild.to_string(), &note, &made.id.to_string()) { Box::pin(self.perform(guild, a)).await?; }
                let mut moved_any = move_in.is_empty();
                for u in &move_in {
                    if let Ok(u) = u.parse::<Id<UserMarker>>() { if self.http.update_guild_member(guild, u).channel_id(Some(made.id)).await.is_ok() { moved_any = true; } }
                }
                if !moved_any {
                    for a in self.bot.on_room_unused(&guild.to_string(), &made.id.to_string()) { Box::pin(self.perform(guild, a)).await?; }
                }
            }
            Action::RoomEdit { channel, name, limit } => {
                let Ok(c) = channel.parse::<Id<ChannelMarker>>() else { return Ok(()) };
                let mut req = self.http.update_channel(c);
                if let Some(n) = &name { req = req.name(n); }
                if let Some(l) = limit { req = req.user_limit(l.min(99) as u16); }
                req.await.map_err(|_| "Discord would not change that room. I need Manage Channels there.".to_string())?;
            }
            Action::Overwrite { channel, id, role, allow, deny, clear } => {
                use twilight_model::guild::Permissions as P;
                use twilight_model::http::permission_overwrite::{PermissionOverwrite, PermissionOverwriteType};
                let (Ok(c), Ok(target)) = (channel.parse::<Id<ChannelMarker>>(), id.parse::<Id<twilight_model::id::marker::GenericMarker>>()) else { return Ok(()) };
                // what is there now stays, except the bits being set or cleared (like editing in Discord)
                let old = async { self.http.channel(c).await.ok()?.model().await.ok() }.await.and_then(|ch| ch.permission_overwrites).unwrap_or_default().into_iter().find(|o| o.id.get() == target.get());
                let touched = P::from_bits_truncate(allow | deny | clear);
                let (old_allow, old_deny) = old.map(|o| (o.allow, o.deny)).unwrap_or((P::empty(), P::empty()));
                let over = PermissionOverwrite { allow: Some((old_allow & !touched) | P::from_bits_truncate(allow)), deny: Some((old_deny & !touched) | P::from_bits_truncate(deny)), id: target, kind: if role { PermissionOverwriteType::Role } else { PermissionOverwriteType::Member } };
                self.http.update_channel_permission(c, &over).await.map_err(|_| "Discord would not change who can use that room. I need Manage Channels there.".to_string())?;
            }
            Action::ClearOverwrite { channel, id } => {
                if let (Ok(c), Ok(u)) = (channel.parse::<Id<ChannelMarker>>(), id.parse::<Id<UserMarker>>()) { let _ = self.http.delete_channel_permission(c).member(u).await; }
            }
            Action::MoveMember { user, channel } => {
                let Ok(u) = user.parse::<Id<UserMarker>>() else { return Ok(()) };
                let to = channel.and_then(|c| c.parse::<Id<ChannelMarker>>().ok());
                self.http.update_guild_member(guild, u).channel_id(to).await.map_err(|_| "I couldn't move that member (I need Move Members, and they must be in voice).".to_string())?;
            }
            Action::Inactive(ask) => {
                let facts = self.member_facts(guild).await;
                for a in self.bot.inactive(&guild.to_string(), &ask, &facts, now_ms()) { Box::pin(self.perform(guild, a)).await?; }
            }
            Action::KickInactive { user, reason, dm } => {
                let Ok(u) = user.parse::<Id<UserMarker>>() else { return Ok(()) };
                if let Some(text) = dm {
                    let name = self.bot.db.get().guilds().unwrap_or_default().into_iter().find(|g| g.id == guild.to_string()).map(|g| g.name).unwrap_or_else(|| "the server".into());
                    let card = Card::new(gb_core::Area::General).line(text.replace("{server}", &name).chars().take(1900).collect::<String>());
                    let _ = self.dm(u, &card).await;
                }
                self.http.remove_guild_member(guild, u).reason(&reason).await.map_err(|_| "I couldn't kick that member (they may have left, or I can't kick them).".to_string())?;
            }
            Action::Counters { items } => self.refresh_counters(guild, &items).await,
            Action::Backfill { .. } => {} // started in `spawn`, which has the shared handle
            Action::Announce { channel, text, card, everyone, roles } => {
                let Ok(c) = channel.parse::<Id<ChannelMarker>>() else { return Ok(()) };
                let roles: Vec<Id<RoleMarker>> = roles.iter().filter_map(|r| r.parse().ok()).collect();
                let mentions = AllowedMentions { parse: if everyone { vec![twilight_model::channel::message::MentionType::Everyone] } else { Vec::new() }, roles, ..Default::default() };
                match card {
                    Some(card) => {
                        let parts = components(&card).map_err(|e| e.to_string())?;
                        self.http.create_message(c).flags(flags(&card)).components(&parts).allowed_mentions(Some(&mentions)).await.map_err(|e| post_refusal(c, &e))?;
                    }
                    None => { self.http.create_message(c).content(&text).allowed_mentions(Some(&mentions)).await.map_err(|e| post_refusal(c, &e))?; }
                }
            }
            Action::StarCheck { message, emoji, skip_author, channel } => {
                let (Some(Ok(c)), Ok(m)) = (channel.as_ref().map(|c| c.parse::<Id<ChannelMarker>>()), message.parse::<Id<twilight_model::id::marker::MessageMarker>>()) else { return Ok(()) };
                let Some(msg) = async { self.http.message(c, m).await.ok()?.model().await.ok() }.await else { return Ok(()) };
                let chan = async { self.http.channel(c).await.ok()?.model().await.ok() }.await;
                let kind = reaction_of(&emoji);
                let (mut count, mut after) = (0i64, None);
                loop {
                    let req = self.http.reactions(c, m, &kind).limit(100);
                    let Ok(page) = (match after { Some(a) => req.after(a).await, None => req.await }) else { return Ok(()) };
                    let Ok(users) = page.models().await else { return Ok(()) };
                    count += users.iter().filter(|u| !u.bot && !(skip_author && u.id == msg.author.id)).count() as i64;
                    after = users.last().map(|u| u.id);
                    if users.len() < 100 { break; }
                }
                let image = msg.attachments.iter().find(|a| a.content_type.as_deref().is_some_and(|t| t.starts_with("image/"))).map(|a| a.url.clone());
                let info = gb_core::engagement::StarInfo {
                    channel: c.to_string(), parent: chan.as_ref().and_then(|ch| ch.parent_id).map(|p| p.to_string()), message: m.to_string(), author: msg.author.id.to_string(),
                    author_name: self.names.lock().unwrap_or_else(|p| p.into_inner()).0.get(&(guild.get(), msg.author.id.get())).cloned().or_else(|| msg.author.global_name.clone()).unwrap_or_else(|| msg.author.name.clone()),
                    avatar: msg.author.avatar.map(|h| format!("https://cdn.discordapp.com/avatars/{}/{h}.png?size=64", msg.author.id)), author_bot: msg.author.bot, nsfw: chan.as_ref().and_then(|ch| ch.nsfw).unwrap_or(false),
                    content: msg.content.clone(), image, url: format!("https://discord.com/channels/{guild}/{c}/{m}"), at_ms: msg.timestamp.as_micros() / 1000, count,
                };
                for a in self.bot.on_star(&guild.to_string(), &info) { Box::pin(self.perform(guild, a)).await?; }
            }
            Action::Tts(cmd) => self.voice.tts(guild, cmd),
            Action::TtsInfo { .. } => {}
            Action::Fetch(f) => {
                use gb_core::integrations::Fetch as F;
                let g = guild.to_string();
                match *f {
                    F::Poll { key, provider, target } => {
                        let found = feeds::items(&self.web, &provider, &target).await;
                        for a in self.bot.feed_polled(&g, &key, found, now_ms()) { Box::pin(self.perform(guild, a)).await?; }
                    }
                    other => eprintln!("A lookup was asked for outside a command: {other:?}"),
                }
            }
            Action::Later { .. } | Action::Quote(_) | Action::Roblox { .. } | Action::Translate { .. } | Action::RpGifs { .. } | Action::TenorKey { .. } | Action::Backup { .. } => {}
            // server setup asked for from the dashboard (a command or button is answered in `on_interaction`)
            Action::Setup(job) => { let _ = self.run_setup(guild, &job).await; }
            Action::Roles { user, add, remove, reason } => {
                let user = user_id(&user)?;
                for (roles, adding) in [(add, true), (remove, false)] {
                    for role in roles.iter().filter_map(|r| r.parse::<Id<RoleMarker>>().ok()) {
                        let done = if adding { self.http.add_guild_member_role(guild, user, role).reason(&reason).await } else { self.http.remove_guild_member_role(guild, user, role).reason(&reason).await };
                        if let Err(e) = done {
                            eprintln!("Could not change role {role} for {user} (is the bot's role above it?): {e}");
                        }
                    }
                }
            }
            Action::Dm { user, card, or_in } => {
                let to = user_id(&user)?;
                let sent = async {
                    let dm = self.http.create_private_channel(to).await.ok()?.model().await.ok()?;
                    let parts = components(&card).ok()?;
                    self.http.create_message(dm.id).flags(MessageFlags::IS_COMPONENTS_V2).components(&parts).attachments(&files_of(&card)).await.ok()
                }
                .await
                .is_some();
                // closed DMs are normal; the card for the channel is used instead when there is one
                if let (false, Some((channel, card))) = (sent, or_in) {
                    return Box::pin(self.perform(guild, Action::Send { channel, card: *card, ping: vec![user], roles: Vec::new() })).await;
                }
            }
            Action::React { channel, message, emoji } => {
                if let (Ok(c), Ok(m)) = (channel.parse::<Id<ChannelMarker>>(), message.parse()) {
                    if let Err(e) = self.http.create_reaction(c, m, &reaction_of(&emoji)).await {
                        // the message is not in this channel (Discord: unknown message), or the emoji is not one it knows
                        let why = e.to_string();
                        if why.contains("10008") || why.contains("Unknown Message") || why.contains("10014") || why.contains("Unknown Emoji") {
                            self.bot.reaction_role_undo(&guild.to_string(), &message, &emoji);
                            return Err(if why.contains("10014") || why.contains("Unknown Emoji") { "I could not use that emoji. Nothing was saved. Use a standard emoji or one from this server.".into() } else { "I could not find that message in this channel. Nothing was saved: run the command in the channel the message is in.".into() });
                        }
                    }
                }
            }
            Action::OpenVoice { name, category, limit, note } => {
                let mut req = self.http.create_guild_channel(guild, &name).kind(twilight_model::channel::ChannelType::GuildVoice).user_limit(limit.min(99) as u16);
                let parent = category.and_then(|c| c.parse::<Id<ChannelMarker>>().ok());
                if let Some(p) = parent { req = req.parent_id(p); }
                match req.await {
                    Ok(r) => { if let Ok(c) = r.model().await { for a in self.bot.on_channel_made(&guild.to_string(), &note, &c.id.to_string()) { Box::pin(self.perform(guild, a)).await?; } } }
                    Err(_) => {
                        for a in self.bot.on_voice_failed(&guild.to_string(), &note) { Box::pin(self.perform(guild, a)).await?; }
                        return Err("I couldn't create the voice channel (I need Manage Channels). The party was created without one.".into());
                    }
                }
            }
            Action::CountVotes { channel, message, emoji, skip } => {
                let (Ok(c), Ok(m)) = (channel.parse::<Id<ChannelMarker>>(), message.parse::<Id<twilight_model::id::marker::MessageMarker>>()) else { return Ok(()) };
                let kind = reaction_of(&emoji);
                let (mut votes, mut after) = (0i64, None);
                loop {
                    let req = self.http.reactions(c, m, &kind).limit(100);
                    let Ok(page) = (match after { Some(a) => req.after(a).await, None => req.await }) else { return Ok(()) };
                    let Ok(users) = page.models().await else { return Ok(()) };
                    votes += users.iter().filter(|u| !u.bot && u.id.to_string() != skip).count() as i64;
                    after = users.last().map(|u| u.id);
                    if users.len() < 100 { break; }
                }
                for a in self.bot.clip_votes(&guild.to_string(), &message, votes) { Box::pin(self.perform(guild, a)).await?; }
            }
            Action::SendText { channel, text, ping, roles, video_from, note } => {
                let Ok(c) = channel.parse::<Id<ChannelMarker>>() else { return Ok(()) };
                // an uploaded clip is uploaded again when it fits (Discord's file links stop working after a while)
                let mut files = Vec::new();
                if let Some((fc, fm)) = video_from {
                    if let (Ok(fc), Ok(fm)) = (fc.parse::<Id<ChannelMarker>>(), fm.parse::<Id<twilight_model::id::marker::MessageMarker>>()) {
                        if let Ok(r) = self.http.message(fc, fm).await { if let Ok(msg) = r.model().await {
                            let limit = 10u64 << 20;
                            let video = msg.attachments.iter().find(|a| a.content_type.as_deref().is_some_and(|t| t.starts_with("video/")) || gb_core::clips::video_of(&[(a.filename.clone(), String::new(), 0)]).is_some());
                            if let Some(v) = video.filter(|v| v.size <= limit && (v.url.starts_with("https://cdn.discordapp.com/") || v.url.starts_with("https://media.discordapp.net/"))) {
                                if let Ok(Ok(r)) = tokio::time::timeout(std::time::Duration::from_secs(60), self.web.get(&v.url).send()).await {
                                    if r.status().is_success() { if let Ok(b) = r.bytes().await { files.push(twilight_model::http::attachment::Attachment::from_bytes(v.filename.clone(), b.to_vec(), 0)); } }
                                }
                            }
                        } }
                    }
                }
                let users: Vec<Id<UserMarker>> = ping.iter().filter_map(|u| u.parse().ok()).collect();
                let roles: Vec<Id<RoleMarker>> = roles.iter().filter_map(|r| r.parse().ok()).collect();
                let mentions = AllowedMentions { users, roles, ..Default::default() };
                let sent = self.http.create_message(c).content(&text).attachments(&files).allowed_mentions(Some(&mentions)).await.map_err(|e| post_refusal(c, &e))?;
                if let (Some(note), Ok(m)) = (note, sent.model().await) {
                    self.bot.on_posted(&guild.to_string(), &note, &m.id.to_string());
                    // a suggestion gets a thread to talk about it in (when the server wants that); if it cannot be made, the post stands
                    if let Some(name) = self.bot.thread_for_post(&guild.to_string(), &note) {
                        let name: String = name.chars().take(100).collect();
                        if let Err(e) = self.http.create_thread_from_message(c, m.id, &name).auto_archive_duration(twilight_model::channel::thread::AutoArchiveDuration::Week).await { eprintln!("suggestion thread: {e}"); }
                    }
                }
            }
            Action::DeleteMany { channel, messages } => {
                let Ok(c) = channel.parse::<Id<ChannelMarker>>() else { return Ok(()) };
                let ids: Vec<Id<twilight_model::id::marker::MessageMarker>> = messages.iter().filter_map(|m| m.parse().ok()).take(100).collect();
                match ids.as_slice() {
                    [] => {}
                    [one] => { let _ = self.http.delete_message(c, *one).await; }
                    many => { let _ = self.http.delete_messages(c, many).await; }
                }
            }
            Action::Flash { channel, card, ping, after_secs } => {
                let Ok(c) = channel.parse::<Id<ChannelMarker>>() else { return Ok(()) };
                let parts = components(&card)?;
                let mentions = AllowedMentions { parse: Vec::new(), replied_user: false, roles: Vec::new(), users: ping.iter().filter_map(|u| u.parse::<Id<UserMarker>>().ok()).collect() };
                let sent = self.http.create_message(c).flags(flags(&card)).components(&parts).attachments(&files_of(&card)).allowed_mentions(Some(&mentions)).await.map_err(|e| post_refusal(c, &e))?.model().await.map_err(|e| e.to_string())?;
                tokio::time::sleep(std::time::Duration::from_secs(after_secs.min(60) as u64)).await;
                let _ = self.http.delete_message(c, sent.id).await;
            }
            Action::SaveRankBackground { member, name, url } => {
                // Discord's link works for about a day, so the picture is copied now and kept
                let r = tokio::time::timeout(std::time::Duration::from_secs(25), self.web.get(&url).send()).await.map_err(|_| "Discord did not hand over the background picture in time.".to_string())?.map_err(|e| format!("The background picture could not be fetched: {e}"))?;
                if !r.status().is_success() { return Err(format!("The background picture could not be fetched ({}).", r.status())); }
                let bytes = tokio::time::timeout(std::time::Duration::from_secs(25), r.bytes()).await.map_err(|_| "The background picture took too long to arrive.".to_string())?.map_err(|e| e.to_string())?;
                self.bot.rank_background_saved(&guild.to_string(), &member, &name, &bytes, now_ms())?;
            }
            Action::Proxy { channel, thread, name, avatar, text, files, original, note } => {
                let Ok(ch) = channel.parse::<Id<ChannelMarker>>() else { return Ok(()) };
                let (hook, token) = match self.proxy_webhook(ch).await {
                    Ok(h) => h,
                    Err(why) => { self.proxy_notice(ch, &why).await; return Err(why); }
                };
                // the pictures and files that came with the message are sent again (up to 8 MB in all)
                let mut attach = Vec::new();
                let mut total = 0u64;
                for (n, (file, url, size)) in files.iter().take(10).enumerate() {
                    if total + size > 8 << 20 { break; }
                    let Ok(r) = self.web.get(url).send().await else { continue };
                    let Ok(bytes) = r.bytes().await else { continue };
                    total += bytes.len() as u64;
                    attach.push(twilight_model::http::attachment::Attachment::from_bytes(file.clone(), bytes.to_vec(), n as u64));
                }
                // people may be pinged, but never roles or everyone
                let mentions = AllowedMentions { parse: vec![twilight_model::channel::message::MentionType::Users], replied_user: false, roles: Vec::new(), users: Vec::new() };
                let mut req = self.http.execute_webhook(hook, &token).username(&name).content(&text).allowed_mentions(Some(&mentions)).attachments(&attach);
                if let Some(a) = avatar.as_deref() { req = req.avatar_url(a); }
                if let Some(t) = thread.as_deref().and_then(|t| t.parse::<Id<ChannelMarker>>().ok()) { req = req.thread_id(t); }
                let sent = match req.wait().await {
                    Ok(r) => r.model().await.map_err(|e| e.to_string())?,
                    Err(e) => {
                        let why = format!("Could not send the proxied message in <#{ch}>: {e}");
                        self.proxy_notice(ch, &format!("I couldn't send that as **{name}**: {e}. Your message was left as it was.")).await;
                        return Err(why);
                    }
                };
                self.bot.on_posted(&guild.to_string(), &note, &sent.id.to_string());
                // the original goes only now that the new message is up
                if let Some(m) = original.as_deref().and_then(|m| m.parse().ok()) {
                    let at = thread.as_deref().and_then(|t| t.parse::<Id<ChannelMarker>>().ok()).unwrap_or(ch);
                    let _ = self.http.delete_message(at, m).await;
                }
            }
            Action::Delete { channel, message } => {
                if let (Ok(c), Ok(m)) = (channel.parse::<Id<ChannelMarker>>(), message.parse()) {
                    let _ = self.http.delete_message(c, m).await;
                }
            }
            Action::Purge { channel, count, from, keep_pinned, progress, by } => {
                // not from a command (nothing to show progress on): it simply runs, and the log is told
                let (deleted, stopped) = self.run_purge(&channel, count, from.as_deref(), keep_pinned, &|_| {}).await;
                let (_, log) = self.bot.on_purged(&guild.to_string(), &channel, &by, from.as_deref(), deleted, stopped, progress);
                for a in log { let _ = Box::pin(self.perform(guild, a)).await; }
            }
            Action::PurgeStop { channel } => {
                if let Some(job) = self.purges.lock().unwrap_or_else(|p| p.into_inner()).get(&channel) { job.store(true, std::sync::atomic::Ordering::Relaxed); }
            }
            Action::RecreateChannel { channel, by } => {
                let c = channel.parse::<Id<ChannelMarker>>().map_err(|_| "That channel is gone.".to_string())?;
                let old = self.http.channel(c).await.map_err(|e| post_refusal(c, &e))?.model().await.map_err(|e| e.to_string())?;
                let name = old.name.clone().unwrap_or_else(|| "channel".into());
                let overwrites = old.permission_overwrites.clone().unwrap_or_default();
                let mut req = self.http.create_guild_channel(guild, &name).kind(old.kind).permission_overwrites(&overwrites).reason("Purge all");
                if let Some(t) = old.topic.as_deref().filter(|t| !t.is_empty()) { req = req.topic(t); }
                if let Some(p) = old.parent_id { req = req.parent_id(p); }
                if let Some(pos) = old.position { req = req.position(pos as u64); }
                if let Some(n) = old.nsfw { req = req.nsfw(n); }
                if let Some(r) = old.rate_limit_per_user { req = req.rate_limit_per_user(r); }
                let fresh = req.await.map_err(|_| "I couldn't recreate the channel. I need **Manage Channels**.".to_string())?.model().await.map_err(|e| e.to_string())?;
                self.http.delete_channel(c).reason("Purge all (recreated)").await.map_err(|_| format!("The new channel is made, but I couldn't delete the old one (<#{c}>)."))?;
                for a in self.bot.on_recreated(&guild.to_string(), &c.to_string(), &fresh.id.to_string(), &name, &by) { let _ = Box::pin(self.perform(guild, a)).await; }
            }
            Action::Kick { user, reason, .. } => {
                self.http.remove_guild_member(guild, user_id(&user)?).reason(&reason).await.map_err(|_| NO.to_string())?;
            }
            Action::Ban { user, reason, delete_days, .. } => {
                self.http.create_ban(guild, user_id(&user)?).delete_message_seconds(delete_days.min(7) * 86400).reason(&reason).await.map_err(|_| NO.to_string())?;
            }
            Action::Unban { user, reason, .. } => {
                self.http.delete_ban(guild, user_id(&user)?).reason(&reason).await.map_err(|_| "Discord refused. They may not be banned, or I'm missing the Ban Members permission.".to_string())?;
            }
            Action::Timeout { user, until_ms, reason, .. } => {
                let until = match until_ms {
                    Some(ms) => Some(twilight_model::util::Timestamp::from_secs(ms / 1000).map_err(|e| e.to_string())?),
                    None => None,
                };
                self.http.update_guild_member(guild, user_id(&user)?).communication_disabled_until(until).reason(&reason).await.map_err(|_| NO.to_string())?;
            }
            Action::Music { cmd, slot } => match cmd {
                // a lookup nobody is waiting on (from a button whose answer has gone): the songs are queued all the same
                gb_core::music::MusicCmd::Resolve { query, by, .. } => {
                    let found = self.voice.resolve(&query).await;
                    for action in self.bot.on_music_found(&guild.to_string(), slot, &by, found, now_ms()).into_iter().skip(1) { Box::pin(self.perform(guild, action)).await.ok(); }
                }
                gb_core::music::MusicCmd::Lyrics { .. } => {}
                cmd => self.voice_for(slot).send(guild, cmd),
            },
            Action::Reply { .. } | Action::Update { .. } | Action::FollowUp { .. } => {} // answers to a command or button (see `on_interaction`)
        }
        Ok(())
    }
    /// The server's layout as Good Boy 3's backup snapshot: roles (not @everyone or ones an integration manages),
    /// categories and channels with their role permissions, kept by name so a restore can put them back.
    async fn layout(&self, guild: Id<GuildMarker>) -> Result<serde_json::Value, String> {
        let roles = self.http.roles(guild).await.map_err(|e| format!("I couldn't read the roles: {e}"))?.models().await.map_err(|e| e.to_string())?;
        let channels = self.http.guild_channels(guild).await.map_err(|e| format!("I couldn't read the channels: {e}"))?.models().await.map_err(|e| e.to_string())?;
        let name = async { self.http.guild(guild).await.ok()?.model().await.ok().map(|g| g.name) }.await.unwrap_or_default();
        let role_name = |id: u64| if id == guild.get() { Some("@everyone".to_string()) } else { roles.iter().find(|r| r.id.get() == id).map(|r| r.name.clone()) };
        let mut kept: Vec<_> = roles.iter().filter(|r| r.id != guild.cast() && !r.managed).collect();
        kept.sort_by_key(|r| std::cmp::Reverse(r.position));
        #[allow(deprecated)]
        let roles_json: Vec<serde_json::Value> = kept.iter().map(|r| json!({ "id": r.id.to_string(), "name": r.name, "color": r.color, "hoist": r.hoist, "mentionable": r.mentionable, "permissions": r.permissions.bits().to_string(), "position": r.position })).collect();
        let other: Vec<&str> = roles.iter().filter(|r| r.managed || r.id == guild.cast()).map(|r| r.name.as_str()).collect();
        let kinds = gb_core::backup::KINDS;
        let mut chans: Vec<_> = channels.iter().filter(|c| kinds.contains(&(u8::from(c.kind) as i64))).collect();
        chans.sort_by_key(|c| c.position.unwrap_or(0));
        use twilight_model::channel::permission_overwrite::PermissionOverwriteType as T;
        let channels_json: Vec<serde_json::Value> = chans.iter().map(|c| {
            let parent = c.parent_id.and_then(|p| channels.iter().find(|x| x.id == p).and_then(|x| x.name.clone()));
            let overwrites: Vec<serde_json::Value> = c.permission_overwrites.iter().flatten().filter(|o| o.kind == T::Role).filter_map(|o| Some(json!({ "role": role_name(o.id.get())?, "allow": o.allow.bits().to_string(), "deny": o.deny.bits().to_string() }))).collect();
            let last = c.last_message_id.map(|m| ((m.get() >> 22) + 1_420_070_400_000) as i64);
            json!({ "id": c.id.to_string(), "parentId": c.parent_id.map(|p| p.to_string()), "lastMessage": last, "name": c.name, "type": u8::from(c.kind), "parent": parent, "position": c.position.unwrap_or(0), "topic": c.topic, "nsfw": c.nsfw.unwrap_or(false), "slowmode": c.rate_limit_per_user.unwrap_or(0), "bitrate": c.bitrate, "userLimit": c.user_limit, "overwrites": overwrites })
        }).collect();
        let everyone = roles.iter().find(|r| r.id == guild.cast()).map(|r| r.permissions.bits()).unwrap_or(0);
        Ok(json!({ "version": 1, "guildName": name, "at": now_ms(), "everyone": everyone.to_string(), "roles": roles_json, "otherRoles": other, "channels": channels_json }))
    }
    /// One step of server setup. The card is the answer for whoever asked; what happened is also kept for the dashboard.
    async fn run_setup(&self, guild: Id<GuildMarker>, job: &gb_core::SetupJob) -> Card {
        use gb_core::SetupStep as S;
        let g = guild.to_string();
        let warn = |t: String| Card::new(gb_core::Area::General).line(format!("⚠️ {t}")).private();
        let layout = match self.layout(guild).await { Ok(l) => l, Err(why) => { self.bot.setup_note(&g, "error", &why, now_ms()); return warn(why); } };
        match &job.step {
            S::Plan(t) => self.bot.setup_plan(t, &layout, &job.by).unwrap_or_else(|| warn("I don't know that layout.".into())),
            S::Scan => self.bot.setup_scan(&g, &layout, now_ms(), &job.by).0,
            S::Build(t) => self.setup_build(guild, t, &layout).await,
            S::Fix(what) => {
                let plan = self.bot.setup_fix(&g, what, &layout);
                let mut text = plan.text.clone();
                if let Some(t) = plan.build { return self.setup_build(guild, t, &layout).await; }
                for a in plan.actions { if let Err(e) = Box::pin(self.perform(guild, a)).await { text.push_str(&format!(" ({e})")); } }
                if plan.everyone_remove != 0 {
                    let now = layout["everyone"].as_str().and_then(|p| p.parse::<u64>().ok()).unwrap_or(0);
                    let keep = twilight_model::guild::Permissions::from_bits_truncate(now & !plan.everyone_remove);
                    if let Err(e) = self.http.update_role(guild, guild.cast()).permissions(keep).reason("Server check: take risky permissions off everyone").await { text = format!("I couldn't change @everyone: {e}. The bot needs Manage Roles, and its role must be above the one it changes."); }
                }
                self.bot.setup_note(&g, what, &text, now_ms());
                Card::new(gb_core::Area::General).line(format!("✅ {text}")).private()
            }
        }
    }
    /// Makes what a layout needs, connects the bot to it, and posts the rules and ticket buttons.
    async fn setup_build(&self, guild: Id<GuildMarker>, tid: &str, layout: &serde_json::Value) -> Card {
        let g = guild.to_string();
        let Some((roles, channels)) = self.bot.setup_missing(tid, layout) else { return Card::new(gb_core::Area::General).line("⚠️ I don't know that layout.").private() };
        let (r, c, failed) = self.restore(guild, &roles, &channels, "Server setup").await;
        // what is in the server now, by name, so the bot can be connected to it
        let mut built = gb_core::setup::Built::default();
        if let Ok(rs) = self.http.roles(guild).await { if let Ok(rs) = rs.models().await { built.roles = rs.iter().map(|x| (x.name.clone(), x.id.to_string())).collect(); } }
        if let Ok(cs) = self.http.guild_channels(guild).await { if let Ok(cs) = cs.models().await {
            built.channels = cs.iter().filter_map(|x| Some((x.name.clone()?, x.parent_id.and_then(|p| cs.iter().find(|y| y.id == p)).and_then(|p| p.name.clone()), x.id.to_string()))).collect();
        } }
        let (actions, wired) = self.bot.setup_wire(&g, tid, &built);
        for a in actions { let _ = Box::pin(self.perform(guild, a)).await; }
        let card = self.bot.setup_built_card(tid, (r, c), &failed, &wired);
        self.bot.setup_note(&g, "build", &format!("Added {r} roles and {c} channels{}. {}", if failed.is_empty() { String::new() } else { format!(", {} failed ({})", failed.len(), failed.iter().take(3).cloned().collect::<Vec<_>>().join("; ")) }, wired.join("; ")), now_ms());
        card
    }
    /// Puts back what a backup has and the server doesn't (Good Boy 3's restore): roles lowest first, then
    /// categories, then channels inside them. Gives (roles added, channels added, what failed).
    async fn restore(&self, guild: Id<GuildMarker>, roles: &[serde_json::Value], channels: &[serde_json::Value], reason: &str) -> (usize, usize, Vec<String>) {
        let (mut r_done, mut c_done, mut failed) = (0, 0, Vec::new());
        for r in roles.iter().rev() {
            let name = r["name"].as_str().unwrap_or("role");
            let perms = twilight_model::guild::Permissions::from_bits_truncate(r["permissions"].as_str().and_then(|p| p.parse().ok()).unwrap_or(0));
            let req = self.http.create_role(guild).name(name).color(r["color"].as_u64().unwrap_or(0) as u32).hoist(r["hoist"].as_bool().unwrap_or(false)).mentionable(r["mentionable"].as_bool().unwrap_or(false)).permissions(perms).reason(reason);
            match req.await { Ok(_) => r_done += 1, Err(e) => failed.push(format!("role {name}: {e}")) }
        }
        let now_roles = async { self.http.roles(guild).await.ok()?.models().await.ok() }.await.unwrap_or_default();
        let role_id = |name: &str| if name == "@everyone" { Some(guild.get()) } else { now_roles.iter().find(|r| r.name == name).map(|r| r.id.get()) };
        let (cats, rest): (Vec<_>, Vec<_>) = channels.iter().partition(|c| c["type"] == 4);
        for c in cats.into_iter().chain(rest) {
            let name = c["name"].as_str().unwrap_or("channel");
            let existing = async { self.http.guild_channels(guild).await.ok()?.models().await.ok() }.await.unwrap_or_default();
            let parent = c["parent"].as_str().and_then(|p| existing.iter().find(|x| x.kind == twilight_model::channel::ChannelType::GuildCategory && x.name.as_deref() == Some(p)).map(|x| x.id));
            let over: Vec<twilight_model::channel::permission_overwrite::PermissionOverwrite> = c["overwrites"].as_array().into_iter().flatten().filter_map(|o| Some(twilight_model::channel::permission_overwrite::PermissionOverwrite {
                id: Id::<twilight_model::id::marker::GenericMarker>::new_checked(role_id(o["role"].as_str()?)?)?,
                kind: twilight_model::channel::permission_overwrite::PermissionOverwriteType::Role,
                allow: twilight_model::guild::Permissions::from_bits_truncate(o["allow"].as_str()?.parse().ok()?),
                deny: twilight_model::guild::Permissions::from_bits_truncate(o["deny"].as_str()?.parse().ok()?),
            })).collect();
            let kind = twilight_model::channel::ChannelType::from(c["type"].as_u64().unwrap_or(0) as u8);
            let mut req = self.http.create_guild_channel(guild, name).kind(kind).permission_overwrites(&over).nsfw(c["nsfw"].as_bool().unwrap_or(false));
            if let Some(p) = parent { req = req.parent_id(p); }
            if let Some(t) = c["topic"].as_str() { req = req.topic(t); }
            if let Some(n) = c["slowmode"].as_u64().filter(|n| *n > 0) { req = req.rate_limit_per_user(n as u16); }
            if let Some(b) = c["bitrate"].as_u64() { req = req.bitrate(b as u32); }
            if let Some(u) = c["userLimit"].as_u64() { req = req.user_limit(u as u16); }
            match req.reason(reason).await { Ok(_) => c_done += 1, Err(e) => failed.push(format!("#{name}: {e}")) }
        }
        (r_done, c_done, failed)
    }
    /// A member's DM: to the one server it can go to, or they pick (Good Boy 3's modmail routing).
    async fn modmail_dm(self: Arc<Self>, dm: PendingDm) {
        let guilds: Vec<String> = self.bot.db.get().guilds().unwrap_or_default().into_iter().map(|g| g.id).collect();
        let candidates = self.bot.modmail_servers(&dm.0.id, &guilds);
        let mut servers = Vec::new();
        for (g, name, open) in candidates {
            let known = self.member_roles.lock().unwrap_or_else(|p| p.into_inner()).contains_key(&format!("{g}:{}", dm.0.id));
            let member = known || match (g.parse::<Id<GuildMarker>>(), dm.0.id.parse::<Id<UserMarker>>()) { (Ok(gid), Ok(uid)) => self.http.guild_member(gid, uid).await.is_ok(), _ => false };
            if member { servers.push((g, name, open)); }
        }
        if servers.is_empty() { return; }
        let open: Vec<_> = servers.iter().filter(|s| s.2).collect();
        let target = if open.len() == 1 { Some(open[0].0.clone()) } else if servers.len() == 1 { Some(servers[0].0.clone()) } else { None };
        match target {
            Some(g) => self.modmail_deliver(&g, &dm).await,
            None => {
                let dm_channel = dm.3.clone();
                self.mm_pending.lock().unwrap_or_else(|p| p.into_inner()).insert(dm.0.id.parse().unwrap_or(0), dm);
                let options = servers.iter().take(25).map(|(g, name, _)| (name.chars().take(100).collect(), g.clone(), None)).collect();
                let card = Card::new(gb_core::Area::General).line("Which server's staff is this for?").select(gb_core::Select { id: "mmpick".into(), placeholder: "Pick a server".into(), min: 1, max: 1, options });
                if let (Ok(c), Ok(parts)) = (dm_channel.parse::<Id<ChannelMarker>>(), components(&card)) { let _ = self.http.create_message(c).flags(MessageFlags::IS_COMPONENTS_V2).components(&parts).await; }
            }
        }
    }
    async fn modmail_deliver(self: &Arc<Self>, guild: &str, dm: &PendingDm) {
        let Ok(gid) = guild.parse::<Id<GuildMarker>>() else { return };
        let ev = gb_core::modmail::Dm { member: &dm.0, text: &dm.1, files: &dm.2, dm_channel: &dm.3, message: &dm.4, at: dm.5 };
        for action in self.bot.on_dm(guild, &ev) { self.spawn(gid, action); }
    }
    /// A server's invites now (None when the bot may not read them: it needs Manage Server).
    async fn read_invites(&self, guild: Id<GuildMarker>) -> Option<HashMap<String, gb_core::invites::Invite>> {
        let list = self.http.guild_invites(guild).await.ok()?.models().await.ok()?;
        Some(list.into_iter().map(|i| (i.code, (i.uses.unwrap_or(0), i.inviter.map(|u| u.id.to_string()), i.max_uses.unwrap_or(0)))).collect())
    }
    /// Someone joined: which invite they used, from the counts before and after (as Good Boy 3 does it).
    async fn invite_join(self: Arc<Self>, guild: Id<GuildMarker>, who: Member) {
        let before = self.invites.lock().unwrap_or_else(|p| p.into_inner()).get(&guild.get()).cloned().unwrap_or_default();
        let after = self.read_invites(guild).await;
        if let Some(a) = &after { self.invites.lock().unwrap_or_else(|p| p.into_inner()).insert(guild.get(), a.clone()); }
        let mut used = after.as_ref().and_then(|a| gb_core::invites::used_invite(&before, a)).map(|(c, i)| (c, i, false));
        if used.is_none() {
            // the server's own custom link (discord.gg/name)
            if let Some(code) = async { self.http.guild(guild).await.ok()?.model().await.ok()?.vanity_url_code }.await { used = Some((code, None, true)); }
        }
        for action in self.bot.on_invite_join(&guild.to_string(), &who, used, now_ms()) { self.spawn(guild, action); }
    }
    /// Posts a roleplay action in the channel and gives the private answer to show the member.
    async fn rp_send(&self, guild: Id<GuildMarker>, channel: &str, action: &str, from: &str, to: Option<&str>, gif: Option<&str>) -> Card {
        let me = self.me.to_string();
        let Some((card, ping)) = self.bot.rp_post(&guild.to_string(), action, from, to, gif, Some(&me)) else { return Card::new(gb_core::Area::Games).line("Pick an action from the list.").private() };
        match self.perform(guild, Action::Send { channel: channel.to_string(), card, ping, roles: Vec::new() }).await {
            Ok(()) => Card::new(gb_core::Area::Games).line("✅ Posted.").private(),
            Err(why) => Card::new(gb_core::Area::Games).line(format!("⚠️ {why}")).private(),
        }
    }
    /// Carries an action out on the side and notes a failure in the log.
    /// `/lockdown`: stops @everyone talking in every text channel, remembering exactly what each channel had so that
    /// opening the server again puts everything back as it was.
    async fn lockdown(&self, guild: Id<GuildMarker>, on: bool) -> Result<(), String> {
        use twilight_model::guild::Permissions as P;
        use twilight_model::http::permission_overwrite::{PermissionOverwrite, PermissionOverwriteType};
        let g = guild.to_string();
        let talk = P::SEND_MESSAGES | P::SEND_MESSAGES_IN_THREADS | P::ADD_REACTIONS | P::CREATE_PUBLIC_THREADS | P::CREATE_PRIVATE_THREADS;
        let everyone = guild.cast();
        let refused = |why: String| format!("Lockdown: {why} (I need Manage Channels and Manage Roles)");
        let mut failed = 0;
        if on {
            let all = self.http.guild_channels(guild).await.map_err(|e| refused(e.to_string()))?.models().await.map_err(|e| e.to_string())?;
            let mut saved = Vec::new();
            for c in all.iter().filter(|c| matches!(c.kind, twilight_model::channel::ChannelType::GuildText | twilight_model::channel::ChannelType::GuildAnnouncement | twilight_model::channel::ChannelType::GuildForum)) {
                let mine = c.permission_overwrites.as_ref().and_then(|o| o.iter().find(|o| o.id.get() == guild.get() && o.kind == twilight_model::channel::permission_overwrite::PermissionOverwriteType::Role));
                let (allow, deny, had) = mine.map(|o| (o.allow, o.deny, true)).unwrap_or((P::empty(), P::empty(), false));
                saved.push(json!({ "c": c.id.to_string(), "had": had, "allow": allow.bits(), "deny": deny.bits() }));
                let over = PermissionOverwrite { allow: Some(allow & !talk), deny: Some(deny | talk), id: everyone, kind: PermissionOverwriteType::Role };
                if self.http.update_channel_permission(c.id, &over).reason("Lockdown").await.is_err() { failed += 1; }
            }
            let _ = self.bot.db.get().data_set(&g, "moderation", "lockdownSaved", &json!(saved));
        } else {
            let saved = self.bot.db.get().data_get(&g, "moderation", "lockdownSaved").ok().flatten().and_then(|v| v.as_array().cloned()).unwrap_or_default();
            for s in &saved {
                let Some(c) = s["c"].as_str().and_then(|c| c.parse::<Id<ChannelMarker>>().ok()) else { continue };
                let ok = if s["had"] == true {
                    let over = PermissionOverwrite { allow: Some(P::from_bits_truncate(s["allow"].as_u64().unwrap_or(0))), deny: Some(P::from_bits_truncate(s["deny"].as_u64().unwrap_or(0))), id: everyone, kind: PermissionOverwriteType::Role };
                    self.http.update_channel_permission(c, &over).reason("Lockdown over").await.is_ok()
                } else {
                    self.http.delete_channel_permission(c).role(everyone.cast()).reason("Lockdown over").await.is_ok()
                };
                if !ok { failed += 1; }
            }
            let _ = self.bot.db.get().data_delete(&g, "moderation", "lockdownSaved");
        }
        if failed > 0 { return Err(format!("Lockdown: {failed} channel(s) could not be changed (I need Manage Channels and Manage Roles there).")); }
        Ok(())
    }
    /// The sound of one of the music bots: 0 is the main bot, 1 and up are helpers.
    fn voice_for(&self, slot: usize) -> &Arc<voice::Voice> {
        self.helper_voices.get(slot).and_then(|v| v.as_ref()).unwrap_or(&self.voice)
    }
    fn spawn(self: &Arc<Self>, guild: Id<GuildMarker>, action: Action) {
        let link = self.clone();
        // wait, then ask the bot what to do (a sticky message's quiet moment)
        if let Action::Backfill { days, by, channel } = action {
            let link = self.clone();
            tokio::spawn(async move { link.backfill(guild, days, by, channel).await });
            return;
        }
        if let Action::Later { after_ms, note } = action {
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(after_ms)).await;
                for a in link.bot.on_later(&guild.to_string(), &note) { link.spawn(guild, a); }
            });
            return;
        }
        tokio::spawn(async move {
            let kept = matches!(action, Action::Kick { .. } | Action::Ban { .. } | Action::Unban { .. } | Action::Timeout { .. }).then(|| action.clone());
            if let Err(why) = link.perform(guild, action).await {
                eprintln!("{why}");
                // a case for something Discord refused does not stay in the history
                if let Some(kept) = kept { link.bot.action_refused(&guild.to_string(), &kept); }
            }
        });
    }

    /// A private (only-you) message was sent: it is taken down when nobody has touched it for the server's idle time.
    /// `key` names the message (a button on the same message uses the same key, so a press starts the wait again).
    fn dismiss_later(&self, key: String, token: &str, followup: Option<Id<twilight_model::id::marker::MessageMarker>>) {
        let secs = self.bot.directory.dismiss_seconds();
        if secs == 0 { return; }
        self.dismiss.lock().unwrap_or_else(|p| p.into_inner()).insert(key, Dismiss { token: token.to_string(), followup, due: now_ms() + secs as i64 * 1000 });
    }
    /// The key of the message an interaction answers: the message a button is on, or the interaction itself.
    /// The keys a message might be waiting under: the interaction that made it (a command's own answer, or a reply a
    /// button press made), a follow-up, or an edit we started waiting on.
    fn dismiss_keys(i: &Interaction) -> Vec<String> {
        let Some(m) = i.message.as_ref() else { return Vec::new() };
        let mut keys = vec![format!("m{}", m.id), format!("f{}", m.id)];
        if let Some(meta) = m.interaction_metadata.as_ref() { keys.push(format!("i{}", meta.id)); }
        keys
    }
    /// Somebody pressed something on a message that is waiting to go: its wait starts again. With `new_token` (the press
    /// edits the message) the new link, which lasts 15 minutes from now, takes over. False when it was not waiting.
    fn dismiss_refresh(&self, i: &Interaction, new_token: Option<&str>) -> bool {
        let secs = self.bot.directory.dismiss_seconds();
        if secs == 0 { return false; }
        let mut all = self.dismiss.lock().unwrap_or_else(|p| p.into_inner());
        let mut found = false;
        for key in Self::dismiss_keys(i) {
            if let Some(d) = all.get_mut(&key) {
                d.due = now_ms() + secs as i64 * 1000;
                if let Some(t) = new_token { d.token = t.to_string(); }
                found = true;
            }
        }
        found
    }
    fn touch_private(&self, i: &Interaction) {
        self.dismiss_refresh(i, None);
    }
    /// A private message was made or edited by this answer: `new_message` is false when a button press edited the
    /// message it was on (the wait carries on under the new link), true when it made a message of its own.
    fn dismiss_answer(&self, i: &Interaction, new_message: bool) {
        if !new_message {
            if self.dismiss_refresh(i, Some(&i.token)) { return; }
            if let Some(m) = i.message.as_ref() { return self.dismiss_later(format!("m{}", m.id), &i.token, None); }
        }
        self.dismiss_later(format!("i{}", i.id), &i.token, None);
    }
    /// Takes down the private messages whose time has come. Their links last 15 minutes, so none is held longer.
    async fn sweep_private(&self) {
        let due: Vec<(String, Dismiss)> = {
            let mut all = self.dismiss.lock().unwrap_or_else(|p| p.into_inner());
            let now = now_ms();
            let keys: Vec<String> = all.iter().filter(|(_, d)| d.due <= now).map(|(k, _)| k.clone()).collect();
            keys.into_iter().filter_map(|k| all.remove(&k).map(|d| (k, d))).collect()
        };
        for (_, d) in due {
            let api = self.http.interaction(self.app);
            let _ = match d.followup { Some(m) => api.delete_followup(&d.token, m).await.map(|_| ()), None => api.delete_response(&d.token).await.map(|_| ()) };
        }
    }
    /// Runs the bot's answer to a button press on a worker thread: games draw their pictures there, and the connection
    /// keeps going meanwhile. Discord refuses a press that is not answered within three seconds, so when the work takes
    /// longer than two, Discord is told "one moment" first and the answer follows as an edit (or a follow-up).
    async fn run_button(self: &Arc<Self>, i: &Interaction, guild: Id<GuildMarker>, ev: ButtonEvent) -> Vec<Action> {
        let me = self.clone();
        let mut work = tokio::task::spawn_blocking(move || {
            let g = guild.get();
            let names = me.names.lock().unwrap_or_else(|p| p.into_inner());
            me.guarded(guild, "a button", || me.bot.on_button(&ev, &|id| id.parse::<u64>().ok().and_then(|u| names.0.get(&(g, u)).cloned()), &mut |lo, hi| fastrand::i64(lo..=hi.max(lo))))
        });
        let done = match tokio::time::timeout(std::time::Duration::from_millis(2000), &mut work).await {
            Ok(done) => done,
            Err(_) => {
                let ack = InteractionResponse { kind: twilight_model::http::interaction::InteractionResponseType::DeferredUpdateMessage, data: None };
                if self.http.interaction(self.app).create_response(i.id, &i.token, &ack).await.is_ok() {
                    self.slow.lock().unwrap_or_else(|p| p.into_inner()).insert(i.id.get());
                }
                work.await
            }
        };
        done.unwrap_or_else(|_| vec![Action::Reply { card: Card::new(gb_core::Area::General).line("⚠️ Something went wrong with a button. It was written to the Logs page so it can be fixed.").private() }])
    }
    /// The bot is stopping (a restart, an update, closing the app): every private window still open is told so and then
    /// taken down, instead of being left on screen with buttons that no longer work. At most 10 seconds are spent.
    async fn close_windows_for_restart(&self) {
        let windows: Vec<Dismiss> = { let mut all = self.dismiss.lock().unwrap_or_else(|p| p.into_inner()); all.drain().map(|(_, d)| d).take(200).collect() };
        if windows.is_empty() { return; }
        let card = Card::new(gb_core::Area::General).line("🔄 Good Boy is restarting. This window is closing; open it again in a minute.");
        let Ok(parts) = components(&card) else { return };
        let work = async {
            let api = self.http.interaction(self.app);
            for d in &windows {
                let _ = match d.followup {
                    Some(m) => api.update_followup(&d.token, m).components(Some(&parts)).await.map(|_| ()),
                    None => api.update_response(&d.token).flags(MessageFlags::IS_COMPONENTS_V2).components(Some(&parts)).await.map(|_| ()),
                };
            }
            // long enough to read the notice
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            for d in &windows {
                let _ = match d.followup { Some(m) => api.delete_followup(&d.token, m).await.map(|_| ()), None => api.delete_response(&d.token).await.map(|_| ()) };
            }
        };
        let _ = tokio::time::timeout(std::time::Duration::from_secs(10), work).await;
    }
    /// The Close button on a private window: acknowledge the press, then delete the message it was on.
    async fn close_window(&self, i: &Interaction) {
        let api = self.http.interaction(self.app);
        let ack = InteractionResponse { kind: twilight_model::http::interaction::InteractionResponseType::DeferredUpdateMessage, data: None };
        if api.create_response(i.id, &i.token, &ack).await.is_ok() { let _ = api.delete_response(&i.token).await; }
        let mut all = self.dismiss.lock().unwrap_or_else(|p| p.into_inner());
        for key in Self::dismiss_keys(i) { all.remove(&key); }
    }
    /// Whether this interaction was already acknowledged because it was slow (taking the mark off, so it counts once).
    fn take_slow(&self, i: &Interaction) -> bool {
        self.slow.lock().unwrap_or_else(|p| p.into_inner()).remove(&i.id.get())
    }
    /// Runs the bot's answer to one interaction. If it panics, the person still gets an answer (instead of "the application did
    /// not respond"), and what went wrong goes to the Logs page so it can be found and fixed.
    fn guarded(&self, guild: Id<GuildMarker>, what: &str, run: impl FnOnce() -> Vec<Action>) -> Vec<Action> {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(run)) {
            Ok(out) => out,
            Err(payload) => {
                let why = payload.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| payload.downcast_ref::<String>().cloned()).unwrap_or_else(|| "something unexpected".into());
                self.problem(Some(guild), &format!("{what} crashed: {why}"));
                vec![Action::Reply { card: Card::new(gb_core::Area::General).line(format!("⚠️ Something went wrong with {what}. It was written to the Logs page so it can be fixed.")).private() }]
            }
        }
    }
    /// A problem worth seeing: printed, and shown on the Logs page.
    fn problem(&self, guild: Option<Id<GuildMarker>>, text: &str) {
        eprintln!("{text}");
        if let Some(g) = guild { self.bot.db.seen().note(&g.to_string(), "error", &text.chars().take(300).collect::<String>()); }
    }
    async fn answer(&self, interaction: &Interaction, card: &Card, update: bool) {
        // a card with a picture: the picture is sent instead, with the card's buttons (the card is the fallback)
        if !update {
            if let Some(gb_core::Art::Rank(art)) = &card.art {
                return self.answer_rank_picture(interaction, art, card).await;
            }
            if let Some(gb_core::Art::Family(art)) = &card.art {
                return self.answer_family_picture(interaction, art, card).await;
            }
        }
        let shown = with_close(card);
        let card = &shown;
        let parts = match components(card) {
            Ok(p) => p,
            Err(e) => { self.problem(interaction.guild_id, &format!("A reply was not sent ({e}) - the card is too big or has a part Discord refuses")); let fallback = Card::new(gb_core::Area::General).line("⚠️ That screen could not be shown (it was written to the Logs page).").private(); if let Ok(p) = components(&fallback) { if let Ok(r) = serde_json::from_value::<InteractionResponse>(json!({ "type": 4, "data": { "flags": flags(&fallback).bits(), "components": p } })) { let _ = self.http.interaction(self.app).create_response(interaction.id, &interaction.token, &r).await; } } return; }
        };
        if self.take_slow(interaction) {
            // already acknowledged: an edit of the message that was pressed, or a new message sent as a follow-up
            let (files, quiet) = (files_of(card), AllowedMentions::default());
            let api = self.http.interaction(self.app);
            let sent = if update {
                api.update_response(&interaction.token).flags(MessageFlags::IS_COMPONENTS_V2).components(Some(&parts)).attachments(&files).allowed_mentions(Some(&quiet)).await.map(|_| ())
            } else {
                api.create_followup(&interaction.token).flags(flags(card)).components(&parts).attachments(&files).allowed_mentions(Some(&quiet)).await.map(|_| ())
            };
            if let Err(e) = sent { self.problem(interaction.guild_id, &format!("Could not send a slow answer: {e}")); }
            return;
        }
        let mut response: InteractionResponse = match serde_json::from_value(json!({ "type": if update { 7 } else { 4 }, "data": { "flags": flags(card).bits(), "components": parts, "allowed_mentions": { "parse": [], "users": card.ping } } })) {
            Ok(r) => r,
            Err(e) => return eprintln!("A reply could not be built: {e}"),
        };
        if !card.files.is_empty() {
            if let Some(d) = response.data.as_mut() { d.attachments = Some(files_of(card)); }
        }
        if let Err(e) = self.http.interaction(self.app).create_response(interaction.id, &interaction.token, &response).await {
            self.problem(interaction.guild_id, &format!("Could not answer a command: {e}"));
        } else if card.private && !keeps_files(card) {
            self.dismiss_answer(interaction, !update);
        }
    }

    /// Draws a welcome or goodbye picture: the server's background, the member's profile picture and two lines of words.
    async fn draw_greeting(&self, art: &gb_core::GreetingArt) -> Option<Vec<u8>> {
        let avatar = match &art.avatar_url {
            Some(url) => {
                let r = tokio::time::timeout(std::time::Duration::from_secs(6), self.web.get(url).send()).await.ok()?.ok().filter(|r| r.status().is_success());
                match r {
                    Some(r) => tokio::time::timeout(std::time::Duration::from_secs(8), r.bytes()).await.ok().and_then(|b| b.ok()).filter(|b| b.len() <= 8 << 20).map(|b| b.to_vec()),
                    None => None,
                }
            }
            None => None,
        };
        let a = art.clone();
        tokio::task::spawn_blocking(move || {
            let g = gb_art::Greeting { name: &a.name, avatar: avatar.as_deref(), background: a.background.as_deref(), title: &a.title, line: &a.line, accent: a.accent.as_deref(), theme: a.theme.as_deref(), pixel: a.pixel };
            gb_art::greeting_card(&g)
        }).await.ok().flatten()
    }
    /// Draws a rank card (the member's own theme, colours and background; a moving profile picture gives a moving card).
    async fn draw_rank(&self, guild: &str, art: &gb_core::RankArt) -> Option<(&'static str, Vec<u8>)> {
        let guild = guild.to_string();
        let fetch = |url: Option<String>, most: usize| {
            let web = self.web.clone();
            let bot = self.bot.clone();
            let guild = guild.clone();
            async move {
                let url = url?;
                // a background the member uploaded is kept on this computer
                if url.starts_with("file:") {
                    let bytes = std::fs::read(bot.rank_background_path(&guild, &url)?).ok()?;
                    return (bytes.len() <= most).then_some(bytes);
                }
                let r = tokio::time::timeout(std::time::Duration::from_secs(6), web.get(&url).send()).await.ok()?.ok()?;
                if !r.status().is_success() { return None; }
                let b = tokio::time::timeout(std::time::Duration::from_secs(8), r.bytes()).await.ok()?.ok()?;
                (b.len() <= most).then(|| b.to_vec())
            }
        };
        // an animated profile picture has a hash that starts with a_: its moving version is the .gif
        let moving = art.avatar_url.as_deref().filter(|u| u.contains("/a_")).map(|u| u.replacen(".png", ".gif", 1));
        let (gif, still, background) = tokio::join!(fetch(moving, 6 << 20), fetch(art.avatar_url.clone(), 8 << 20), fetch(art.background.clone(), 8 << 20));
        let a = art.clone();
        tokio::task::spawn_blocking(move || {
            let r = gb_art::Rank {
                name: &a.name, avatar: still.as_deref(), level: a.level, into: a.into, needed: a.needed, rank: a.rank, xp: a.xp, messages: a.messages,
                accent: a.accent.as_deref(), accent2: a.accent2.as_deref(), theme: a.theme.as_deref(), background: background.as_deref(), pixel: a.pixel,
            };
            if let Some(g) = gif.as_deref() { if let Some(moving) = gb_art::rank_card_animated(&r, g) { return Some(("rank.gif", moving)); } }
            gb_art::rank_card(&r).map(|png| ("rank.png", png))
        }).await.ok().flatten()
    }
    /// Draws a rank card (Good Boy 3's picture) and sends it with the card's buttons. The answer is "thinking…" first, so
    /// the pictures can take the time they need (a cold connection to Discord's picture server is slower than the three
    /// seconds an answer is allowed). A member with a moving profile picture gets a moving card. When the card cannot
    /// be drawn, the text version is sent instead.
    async fn answer_rank_picture(&self, interaction: &Interaction, art: &gb_core::RankArt, card: &Card) {
        let defer = InteractionResponse { kind: twilight_model::http::interaction::InteractionResponseType::DeferredChannelMessageWithSource, data: None };
        if self.http.interaction(self.app).create_response(interaction.id, &interaction.token, &defer).await.is_err() { return; }
        let drawn = self.draw_rank(&interaction.guild_id.map(|g| g.to_string()).unwrap_or_default(), art).await;
        let quiet = AllowedMentions::default();
        let Some((name, bytes)) = drawn else {
            // the text version
            let mut text = card.clone();
            text.art = None;
            if let Ok(parts) = components(&text) {
                if let Err(e) = self.http.interaction(self.app).update_response(&interaction.token).flags(MessageFlags::IS_COMPONENTS_V2).components(Some(&parts)).allowed_mentions(Some(&quiet)).await { eprintln!("Could not send the rank card: {e}"); }
            }
            return;
        };
        let buttons: Vec<serde_json::Value> = card.buttons.iter().map(|b| {
            let mut x = json!({ "type": 2, "style": 2, "custom_id": b.id, "label": b.label });
            if let Some(e) = &b.emoji { x["emoji"] = json!({ "name": e }); }
            x
        }).collect();
        let rows = if buttons.is_empty() { json!([]) } else { json!([{ "type": 1, "components": buttons }]) };
        let parts = serde_json::from_value::<Vec<Component>>(rows).unwrap_or_default();
        let file = twilight_model::http::attachment::Attachment::from_bytes(name.into(), bytes, 0);
        if let Err(e) = self.http.interaction(self.app).update_response(&interaction.token).components(Some(&parts)).attachments(&[file]).allowed_mentions(Some(&quiet)).await { eprintln!("Could not send the rank card: {e}"); }
    }
    /// Counts older messages from channel history (Good Boy 3's backfill) and messages whoever asked when done.
    /// Messages already counted live are left out; bots and opted-out members are not counted.
    async fn backfill(self: &Arc<Self>, guild: Id<GuildMarker>, days: Option<i64>, by: String, channel: String) {
        let g = guild.to_string();
        let (off, cutoff, optout, ignored) = self.bot.counting_rules(&g);
        let since = days.map(|d| now_ms() - d * 86_400_000).unwrap_or(0);
        let mut users: HashMap<(String, String), i64> = HashMap::new();
        let mut chans: HashMap<(String, String), i64> = HashMap::new();
        let mut hours: HashMap<i64, i64> = HashMap::new();
        let (mut total, mut counted_channels, mut oldest) = (0i64, 0i64, None::<i64>);
        let (mut skipped, mut truncated): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
        let channels: Vec<String> = self.bot.directory.channels(&g).into_iter().filter(|c| c.kind == "text" && !ignored.contains(&c.id)).map(|c| c.id).collect();
        for cid in channels {
            let Ok(c) = cid.parse::<Id<ChannelMarker>>() else { continue };
            let (mut before, mut got, mut readable, mut hit_old) = (None, 0i64, true, false);
            loop {
                let req = self.http.channel_messages(c).limit(100);
                let page = match before { Some(b) => req.before(b).await, None => req.await };
                let Ok(page) = page else { readable = false; break };
                let Ok(list) = page.models().await else { readable = false; break };
                if list.is_empty() { break; }
                before = list.iter().min_by_key(|m| m.timestamp.as_micros()).map(|m| m.id);
                for m in &list {
                    let at = m.timestamp.as_micros() / 1000;
                    if at < since { hit_old = true; continue; }
                    if at >= cutoff { continue; }
                    got += 1;
                    if !m.author.bot && !optout.contains(&m.author.id.to_string()) {
                        let day = gb_core::stats::day_key(at, off);
                        *users.entry((m.author.id.to_string(), day.clone())).or_default() += 1;
                        *chans.entry((cid.clone(), day)).or_default() += 1;
                        *hours.entry(((at + off * 3_600_000).div_euclid(3_600_000)).rem_euclid(24)).or_default() += 1;
                        total += 1;
                        oldest = Some(oldest.map_or(at, |o| o.min(at)));
                    }
                }
                if hit_old || list.len() < 100 { break; }
            }
            if !readable && got == 0 { skipped.push(cid); continue; }
            counted_channels += 1;
        }
        let _ = &mut truncated;
        let result = json!({ "ranAt": now_ms(), "days": days, "messages": total, "channels": counted_channels, "skipped": skipped, "truncated": truncated, "oldest": oldest });
        self.bot.backfilled(&g, result,
            &users.into_iter().map(|((u, d), n)| (u, d, n)).collect::<Vec<_>>(), &chans.into_iter().map(|((c, d), n)| (c, d, n)).collect::<Vec<_>>(), &hours.into_iter().collect::<Vec<_>>());
        let span = days.map(|d| format!("the last {d} days")).unwrap_or_else(|| "all time".into());
        let card = Card::new(gb_core::Area::General).line(format!("✅ **Message history counted** ({span}): {total} messages in {counted_channels} channels. Run `/stats coverage` to see exactly what the numbers include."));
        match by.parse::<Id<UserMarker>>() { Ok(u) if self.dm(u, &card).await.is_ok() => {}, _ => { if let Ok(c) = channel.parse::<Id<ChannelMarker>>() { if let Ok(parts) = components(&card) { let _ = self.http.create_message(c).flags(flags(&card)).components(&parts).await; } } } }
    }
    /// Everyone in the server, as the inactive-members tools need to see them.
    async fn member_facts(&self, guild: Id<GuildMarker>) -> Vec<gb_core::stats::MemberFact> {
        let dir = &self.bot.directory;
        let g = guild.to_string();
        let (mut out, mut after) = (Vec::new(), None);
        loop {
            let req = self.http.guild_members(guild).limit(1000);
            let Ok(page) = (match after { Some(a) => req.after(a).await, None => req.await }) else { break };
            let Ok(list) = page.models().await else { break };
            for m in &list {
                let roles: Vec<String> = m.roles.iter().map(|r| r.to_string()).collect();
                let perms = dir.power_of(&g, &m.user.id.to_string(), &roles);
                let top = roles.iter().filter_map(|r| dir.role(&g, r)).map(|r| r.position).max().unwrap_or(0);
                out.push(gb_core::stats::MemberFact {
                    id: m.user.id.to_string(), name: m.nick.clone().or_else(|| m.user.global_name.clone()).unwrap_or_else(|| m.user.name.clone()), bot: m.user.bot,
                    joined_at: m.joined_at.map(|t| t.as_micros() / 1000), perms, roles, owner: false, kickable: dir.my_top(&g).is_some_and(|t| t > top) && perms & (1 << 3) == 0,
                });
            }
            after = list.last().map(|m| m.user.id);
            if list.len() < 1000 { break; }
        }
        out
    }
    async fn dm(&self, user: Id<UserMarker>, card: &Card) -> Result<(), String> {
        let ch = self.http.create_private_channel(user).await.map_err(|_| "no DM".to_string())?.model().await.map_err(|e| e.to_string())?;
        let parts = components(card).map_err(|e| e.to_string())?;
        self.http.create_message(ch.id).flags(flags(card)).components(&parts).await.map_err(|_| "no DM".to_string())?;
        Ok(())
    }
    /// Counter channels: renamed to their numbers, only when the name changed.
    async fn refresh_counters(&self, guild: Id<GuildMarker>, items: &[(String, String)]) {
        let dir = &self.bot.directory;
        let g = guild.to_string();
        let mut v: HashMap<&str, i64> = HashMap::new();
        let counts = match self.http.guild(guild).with_counts(true).await { Ok(r) => r.model().await.ok(), Err(_) => None };
        let total = counts.as_ref().and_then(|c| c.approximate_member_count).map(|n| n as i64).or_else(|| dir.members(&g).map(|n| n as i64)).unwrap_or(0);
        let need_bots = items.iter().any(|(_, t)| t.contains("{bots}") || t.contains("{humans}"));
        let bots = if need_bots { self.member_facts(guild).await.iter().filter(|m| m.bot).count() as i64 } else { 0 };
        let voice: i64 = dir.channels(&g).iter().filter(|c| c.kind == "voice").map(|c| dir.in_voice(&g, &c.id).len() as i64).sum();
        v.insert("members", total);
        v.insert("bots", bots);
        v.insert("humans", (total - bots).max(0));
        v.insert("online", counts.as_ref().and_then(|c| c.approximate_presence_count).map(|n| n as i64).unwrap_or(0));
        v.insert("boosts", counts.as_ref().and_then(|c| c.premium_subscription_count).unwrap_or(0) as i64);
        v.insert("voice", voice);
        for (channel, tpl) in items {
            let name = gb_core::stats::counter_name(tpl, &v);
            let Ok(c) = channel.parse::<Id<ChannelMarker>>() else { continue };
            if dir.channels(&g).iter().find(|x| x.id == *channel).is_some_and(|x| x.name == name) { continue; }
            if self.http.update_channel(c).name(&name).await.is_ok() { dir.put_channel(&g, gb_core::bot::Named { id: channel.clone(), name, kind: "voice", parent: String::new() }); }
        }
    }
    /// The family tree (Good Boy 3's picture): "thinking…" first, the members' avatars fetched, then the picture in
    /// the card. When it can't be drawn, the card's text tree is sent instead.
    async fn answer_family_picture(&self, interaction: &Interaction, art: &gb_core::family::FamilyArt, card: &Card) {
        let defer = InteractionResponse { kind: twilight_model::http::interaction::InteractionResponseType::DeferredChannelMessageWithSource, data: None };
        if self.http.interaction(self.app).create_response(interaction.id, &interaction.token, &defer).await.is_err() { return; }
        let guild = interaction.guild_id;
        let fetch = |id: String, name: String| async move {
            let user = id.parse::<Id<UserMarker>>().ok();
            let hash = match (guild, user) {
                (Some(g), Some(u)) => match self.http.guild_member(g, u).await { Ok(r) => r.model().await.ok().and_then(|m| m.user.avatar), Err(_) => None },
                _ => None,
            };
            let bytes = match hash {
                Some(h) => async {
                    let r = self.web.get(format!("https://cdn.discordapp.com/avatars/{id}/{h}.png?size=64")).send().await.ok()?;
                    if !r.status().is_success() { return None; }
                    r.bytes().await.ok().map(|b| b.to_vec()).filter(|b| b.len() <= 2 << 20)
                }.await,
                None => None,
            };
            (id, (name, bytes))
        };
        let mut people: HashMap<String, (String, Option<Vec<u8>>)> = art.names.iter().map(|(id, n)| (id.clone(), (n.clone(), None))).collect();
        // pictures that take longer than a few seconds are left out (initials instead)
        if let Ok(found) = tokio::time::timeout(std::time::Duration::from_secs(6), futures_util::future::join_all(art.names.iter().map(|(id, n)| fetch(id.clone(), n.clone())))).await {
            people.extend(found);
        }
        let a = art.clone();
        let drawn = tokio::task::spawn_blocking(move || gb_art::family_tree(&a.tree, &people, Some(&a.highlight), &a.title, a.pixel)).await.ok().flatten();
        let mut shown = card.clone();
        shown.art = None;
        if let Some(png) = drawn {
            shown.lines.retain(|l| *l != art.text);
            shown = shown.file("family.png", png);
        }
        let Ok(parts) = components(&shown) else { return };
        let (files, quiet) = (files_of(&shown), AllowedMentions::default());
        if let Err(e) = self.http.interaction(self.app).update_response(&interaction.token).flags(MessageFlags::IS_COMPONENTS_V2).components(Some(&parts)).attachments(&files).allowed_mentions(Some(&quiet)).await { eprintln!("Could not send the family tree: {e}"); }
    }
    /// Good Boy 3's image quote: reads the message, draws it (moving when it can), and answers with it here, or posts
    /// it in the quote channel and tells the member where. Anything that goes wrong with a GIF falls back to the still.
    async fn answer_quote(&self, i: &Interaction, q: &gb_core::quotes::QuoteAsk) {
        let quiet = q.post_in.is_some();
        let defer = InteractionResponse { kind: twilight_model::http::interaction::InteractionResponseType::DeferredChannelMessageWithSource, data: Some(twilight_model::http::interaction::InteractionResponseData { flags: quiet.then_some(MessageFlags::EPHEMERAL), ..Default::default() }) };
        if self.http.interaction(self.app).create_response(i.id, &i.token, &defer).await.is_err() { return; }
        let say = |text: String| async move {
            let card = Card::new(gb_core::Area::General).line(text);
            if let Ok(parts) = components(&card) { let _ = self.http.interaction(self.app).update_response(&i.token).flags(MessageFlags::IS_COMPONENTS_V2).components(Some(&parts)).await; }
        };
        let (Ok(c), Ok(m), Some(guild)) = (q.channel.parse::<Id<ChannelMarker>>(), q.message.parse::<Id<twilight_model::id::marker::MessageMarker>>(), i.guild_id) else { return say("I couldn't find that message.".into()).await };
        if q.check_sees {
            let Ok(by) = q.by.parse::<Id<UserMarker>>() else { return };
            if !can_see(self, guild, by, c).await { return say("You can't see that channel, so I can't quote from it.".into()).await; }
        }
        let Some(msg) = async { self.http.message(c, m).await.ok()?.model().await.ok() }.await else { return say("I couldn't find that message (check the link, and that I can read that channel).".into()).await };
        // people may not quote themselves (unless the server allows it)
        if !q.may_quote(&msg.author.id.get().to_string()) {
            return say("You can't quote your own message. Ask someone else to quote it, or quote someone else's.".into()).await;
        }
        // mentions read as names, as Discord shows them
        let mut text = msg.content.clone();
        for u in &msg.mentions {
            let name = u.member.as_ref().and_then(|p| p.nick.clone()).unwrap_or_else(|| u.name.clone());
            text = text.replace(&format!("<@{}>", u.id), &format!("@{name}")).replace(&format!("<@!{}>", u.id), &format!("@{name}"));
        }
        let text: String = text.trim().chars().take(420).collect();
        if text.is_empty() {
            let reads = self.bot.directory.reads_messages();
            return say(if reads { "That message has no text to quote.".into() } else { "I can't read message text yet. Turn on **Message Content Intent** in the Developer Portal (Bot > Privileged Gateway Intents) and restart me.".into() }).await;
        }
        let name = self.names.lock().unwrap_or_else(|p| p.into_inner()).0.get(&(guild.get(), msg.author.id.get())).cloned().or_else(|| msg.author.global_name.clone()).unwrap_or_else(|| msg.author.name.clone());
        let fetch = |url: String, max: usize| async move {
            let r = tokio::time::timeout(std::time::Duration::from_secs(15), self.web.get(&url).send()).await.ok()?.ok()?;
            if !r.status().is_success() { return None; }
            r.bytes().await.ok().map(|b| b.to_vec()).filter(|b| b.len() <= max)
        };
        // the first picture in the message goes on the card (a still: an animated one shows its first frame)
        let photo = match msg.attachments.iter().find(|a| a.content_type.as_deref().is_some_and(|t| matches!(t, "image/png" | "image/jpeg" | "image/webp" | "image/gif")) && a.size <= 8 << 20) {
            Some(a) => fetch(a.url.clone(), 8 << 20).await,
            None => None,
        };
        // the look: the pixel quote, a ready-made classic one, or the server's own colours (needs a licence)
        let look = match q.style.as_str() {
            "pixel" => None,
            "custom" => q.custom.as_ref().and_then(|c| gb_art::quote::make_look(&c[0], &c[1], &c[2], gb_art::quote::Font::from_id(&c[3]))).or_else(|| gb_art::quote::preset_look("classic")),
            id => gb_art::quote::preset_look(id).or_else(|| gb_art::quote::preset_look("classic")),
        };
        let quote = gb_art::Quote { text: text.clone(), name, handle: msg.author.name.clone(), when: gb_core::quotes::when(msg.timestamp.as_micros() / 1000), color: q.color, pixel: q.pixel, picture: photo, look };
        // one moving quote is drawn at a time: it is the heaviest thing the bot does
        static DRAWING: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
        let mut drawn: Option<(Vec<u8>, bool)> = None;
        let hash = msg.author.avatar.map(|h| h.to_string());
        if let (true, Some(h)) = (q.animated, hash.as_ref().filter(|h| h.starts_with("a_"))) {
            let mut gif = None;
            for size in [512, 256] {
                if let Some(b) = fetch(format!("https://cdn.discordapp.com/avatars/{}/{h}.gif?size={size}", msg.author.id), 6 << 20).await { gif = Some(b); break; }
            }
            if let Some(g) = gif.filter(|g| g.starts_with(b"GIF8")) {
                let _turn = DRAWING.get_or_init(Default::default).lock().await;
                let qq = quote.clone();
                if let Ok(Some(out)) = tokio::task::spawn_blocking(move || gb_art::quote_animated(&qq, &g)).await { if out.len() <= gb_art::quote::MAX_UPLOAD { drawn = Some((out, true)); } }
            }
        }
        let avatar = match &hash { Some(h) => fetch(format!("https://cdn.discordapp.com/avatars/{}/{h}.png?size=512", msg.author.id), 8 << 20).await, None => None };
        if drawn.is_none() && q.motion {
            let _turn = DRAWING.get_or_init(Default::default).lock().await;
            let (qq, a) = (quote.clone(), avatar.clone());
            if let Ok(Some(out)) = tokio::task::spawn_blocking(move || gb_art::quote_motion(&qq, a.as_deref())).await { if out.len() <= gb_art::quote::MAX_UPLOAD { drawn = Some((out, true)); } }
        }
        if drawn.is_none() {
            let (qq, a) = (quote.clone(), avatar.clone());
            drawn = tokio::task::spawn_blocking(move || gb_art::quote_png(&qq, a.as_deref())).await.ok().flatten().map(|p| (p, false));
        }
        let Some((bytes, moving)) = drawn else { return say("I couldn't draw that image.".into()).await };
        let file_name = if moving { "quote.gif" } else { "quote.png" };
        let mut file = twilight_model::http::attachment::Attachment::from_bytes(file_name.into(), bytes, 0);
        file.description = Some(format!("Quote by {}: {text}", msg.author.name).chars().take(900).collect());
        let url = format!("https://discord.com/channels/{guild}/{c}/{m}");
        let quiet_mentions = AllowedMentions::default();
        if let Some(target) = q.post_in.as_ref().and_then(|t| t.parse::<Id<ChannelMarker>>().ok()) {
            let posted = self.http.create_message(target).content(&format!("Quoted by <@{}> · [original message]({url})", q.by)).attachments(std::slice::from_ref(&file)).allowed_mentions(Some(&quiet_mentions)).await;
            match posted {
                Ok(r) => { if let Ok(p) = r.model().await { return say(format!("Posted in <#{target}>: https://discord.com/channels/{guild}/{target}/{}", p.id)).await; } }
                Err(e) => {
                    let _ = self.http.interaction(self.app).update_response(&i.token).content(Some(&format!("I couldn't post the quote in <#{target}> ({}). Here it is privately instead.", post_refusal(target, &e)))).attachments(&[file]).await;
                    return;
                }
            }
            return;
        }
        if let Err(e) = self.http.interaction(self.app).update_response(&i.token).attachments(&[file]).allowed_mentions(Some(&quiet_mentions)).await { eprintln!("Could not send the quote: {e}"); }
    }
    /// Deletes messages newest first, as Good Boy 3's runPurge: young ones in bulk, ones older than 14 days one by one.
    /// Gives (deleted, stopped early).
    async fn run_purge(&self, channel: &str, count: u64, from: Option<&str>, keep_pinned: bool, progress: &(dyn Fn(u64) + Sync)) -> (u64, bool) {
        let Ok(c) = channel.parse::<Id<ChannelMarker>>() else { return (0, false) };
        let job = Arc::new(std::sync::atomic::AtomicBool::new(false));
        self.purges.lock().unwrap_or_else(|p| p.into_inner()).insert(channel.to_string(), job.clone());
        let stopped = || job.load(std::sync::atomic::Ordering::Relaxed);
        let (mut before, mut deleted) = (None, 0u64);
        let young_after = now_ms() - 14 * 86_400_000 + 60_000;
        while deleted < count && !stopped() {
            let req = self.http.channel_messages(c).limit(100);
            let page = match before { Some(b) => req.before(b).await, None => req.await };
            let Ok(page) = page else { break };
            let Ok(list) = page.models().await else { break };
            if list.is_empty() { break; }
            before = list.iter().min_by_key(|m| m.timestamp.as_micros()).map(|m| m.id);
            let pick: Vec<&twilight_model::channel::Message> = list.iter().filter(|m| from.is_none_or(|u| m.author.id.to_string() == u) && !(keep_pinned && m.pinned)).take((count - deleted) as usize).collect();
            let (young, old): (Vec<_>, Vec<_>) = pick.into_iter().partition(|m| m.timestamp.as_micros() / 1000 > young_after);
            match young.as_slice() {
                [] => {}
                [one] => { if self.http.delete_message(c, one.id).await.is_ok() { deleted += 1; } }
                many => { let ids: Vec<_> = many.iter().map(|m| m.id).collect(); if self.http.delete_messages(c, &ids).await.is_ok() { deleted += ids.len() as u64; } }
            }
            for m in old {
                if stopped() { break; }
                if self.http.delete_message(c, m.id).await.is_ok() { deleted += 1; } progress(deleted); }
            progress(deleted);
            if list.len() < 100 { break; }
        }
        self.purges.lock().unwrap_or_else(|p| p.into_inner()).remove(channel);
        (deleted, stopped())
    }
    /// A ticket's messages (up to 1,000, oldest first) as a transcript file, in the server's format.
    async fn transcript(&self, channel: &str, head: &gb_core::TranscriptHead) -> Option<(String, Vec<u8>)> {
        let c = channel.parse::<Id<ChannelMarker>>().ok()?;
        let mut msgs: Vec<twilight_model::channel::Message> = Vec::new();
        let mut before = None;
        for _ in 0..10 {
            let req = self.http.channel_messages(c).limit(100);
            let batch = match before { Some(b) => req.before(b).await.ok()?.models().await.ok()?, None => req.await.ok()?.models().await.ok()? };
            let n = batch.len();
            before = batch.last().map(|m| m.id);
            msgs.extend(batch);
            if n < 100 { break; }
        }
        msgs.reverse();
        let lines: Vec<gb_core::tickets::TranscriptMsg> = msgs.iter().map(|m| gb_core::tickets::TranscriptMsg {
            at_ms: m.timestamp.as_micros() / 1000,
            author_tag: m.author.name.clone(),
            avatar: m.author.avatar.map(|h| format!("https://cdn.discordapp.com/avatars/{}/{h}.png?size=64", m.author.id)),
            content: m.content.clone(),
            files: m.attachments.iter().map(|a| (a.filename.clone(), a.url.clone())).collect(),
            boxes: card_texts(&m.components).into_iter().chain(m.embeds.iter().map(|e| [e.title.clone(), e.description.clone()].into_iter().flatten().chain(e.fields.iter().map(|f| format!("{}: {}", f.name, f.value))).collect::<Vec<_>>().join("\n")).filter(|t| !t.is_empty())).collect(),
        }).collect();
        Some(gb_core::tickets::transcript_file(head, &lines))
    }
    /// Sends a transcript where it is meant to go. `asker`: the interaction to answer privately.
    async fn deliver_transcript(&self, to: &gb_core::TranscriptTo, file: Option<&(String, Vec<u8>)>, asker: Option<&Interaction>) {
        use gb_core::TranscriptTo as T;
        let attach = |f: &(String, Vec<u8>)| vec![twilight_model::http::attachment::Attachment::from_bytes(f.0.clone(), f.1.clone(), 0)];
        match to {
            T::Channel { channel, card } => {
                let card = match file { Some(f) => (**card).clone().file(&f.0, f.1.clone()), None => (**card).clone() };
                if let Ok(c) = channel.parse::<Id<ChannelMarker>>() {
                    if let Ok(parts) = components(&card) {
                        let _ = self.http.create_message(c).flags(flags(&card)).components(&parts).attachments(&files_of(&card)).allowed_mentions(Some(&AllowedMentions::default())).await;
                    }
                }
            }
            T::Dm { user, text } => {
                let (Some(f), Ok(u)) = (file, user.parse::<Id<UserMarker>>()) else { return };
                if let Ok(dm) = self.http.create_private_channel(u).await { if let Ok(dm) = dm.model().await {
                    let _ = self.http.create_message(dm.id).content(text).attachments(&attach(f)).await;
                } }
            }
            T::Asker => {
                let Some(i) = asker else { return };
                let card = match file { Some(f) => Card::new(gb_core::Area::General).line("📄 Transcript").file(&f.0, f.1.clone()).private(), None => Card::new(gb_core::Area::General).line("The transcript could not be made (I need Read Message History in this channel).").private() };
                if let Ok(parts) = components(&card) {
                    let _ = self.http.interaction(self.app).create_followup(&i.token).flags(flags(&card)).components(&parts).attachments(&files_of(&card)).await;
                }
            }
        }
    }
    /// Downloads files straight away and keeps them in the data folder; with `post`, the small ones go in the channel.
    async fn keep_files(&self, dir: &str, files: &[gb_core::KeepFile], post: Option<(String, String)>) {
        const MAX_FILE: u64 = 25 * 1024 * 1024;
        const MAX_REPOST: usize = 10 * 1024 * 1024;
        let folder = self.data.join(dir.replace("..", ""));
        let _ = std::fs::create_dir_all(&folder);
        let mut repost = Vec::new();
        let mut large = 0;
        let mut missed = Vec::new();
        for f in files.iter().take(10) {
            let got = async {
                let r = tokio::time::timeout(std::time::Duration::from_secs(20), self.web.get(&f.url).send()).await.map_err(|_| "took too long to download".to_string())?.map_err(|e| e.to_string())?;
                if !r.status().is_success() { return Err(format!("HTTP {}", r.status().as_u16())); }
                let b = tokio::time::timeout(std::time::Duration::from_secs(20), r.bytes()).await.map_err(|_| "took too long to download".to_string())?.map_err(|e| e.to_string())?;
                if b.len() as u64 > MAX_FILE { return Err("too big to keep".into()); }
                Ok(b.to_vec())
            }.await;
            match got {
                Ok(bytes) => {
                    let _ = std::fs::write(folder.join(&f.stored), &bytes);
                    if bytes.len() <= MAX_REPOST { repost.push((f.name.clone(), bytes)); } else { large += 1; }
                }
                Err(why) => missed.push(format!("{} ({why})", f.name)),
            }
        }
        let Some((channel, text)) = post else { return };
        let Ok(c) = channel.parse::<Id<ChannelMarker>>() else { return };
        let mut lines = vec![text];
        if large > 0 { lines.push(format!("{large} large file(s) are kept in the ticket archive on the bot's computer.")); }
        if !missed.is_empty() { lines.push(format!("Could not keep: {}", missed.join(", "))); }
        let attachments: Vec<twilight_model::http::attachment::Attachment> = repost.into_iter().enumerate().map(|(k, (n, b))| twilight_model::http::attachment::Attachment::from_bytes(n, b, k as u64)).collect();
        let _ = self.http.create_message(c).content(&lines.join("\n")).attachments(&attachments).allowed_mentions(Some(&AllowedMentions::default())).await;
    }
    /// Answers with a popup to fill in.
    async fn answer_form(&self, interaction: &Interaction, id: &str, title: &str, fields: &[gb_core::Field]) {
        let rows: Vec<serde_json::Value> = fields.iter().take(5).map(popup_field).collect();
        let response: InteractionResponse = match serde_json::from_value(json!({ "type": 9, "data": { "custom_id": id, "title": title, "components": rows } })) {
            Ok(r) => r,
            Err(e) => return eprintln!("A popup could not be built: {e}"),
        };
        if let Err(e) = self.http.interaction(self.app).create_response(interaction.id, &interaction.token, &response).await {
            eprintln!("Could not open a popup: {e}");
        }
    }
    /// Makes a private channel: hidden from everyone, open to the listed members, the staff roles and the bot.
    async fn open_channel(&self, guild: Id<GuildMarker>, name: &str, category: Option<&str>, topic: &str, members: &[String], staff_roles: &[String]) -> Result<Id<ChannelMarker>, String> {
        use twilight_model::guild::Permissions as P;
        use twilight_model::channel::permission_overwrite::{PermissionOverwrite, PermissionOverwriteType as Kind};
        let talk = P::VIEW_CHANNEL | P::SEND_MESSAGES | P::READ_MESSAGE_HISTORY | P::ATTACH_FILES | P::EMBED_LINKS;
        let mut over = vec![PermissionOverwrite { allow: P::empty(), deny: P::VIEW_CHANNEL, id: guild.cast(), kind: Kind::Role }];
        over.extend(members.iter().filter_map(|m| m.parse::<Id<UserMarker>>().ok()).map(|m| PermissionOverwrite { allow: talk, deny: P::empty(), id: m.cast(), kind: Kind::Member }));
        over.extend(staff_roles.iter().filter_map(|r| r.parse::<Id<RoleMarker>>().ok()).map(|r| PermissionOverwrite { allow: talk | P::MANAGE_MESSAGES, deny: P::empty(), id: r.cast(), kind: Kind::Role }));
        over.push(PermissionOverwrite { allow: talk | P::MANAGE_CHANNELS, deny: P::empty(), id: self.me.cast(), kind: Kind::Member });
        let mut request = self.http.create_guild_channel(guild, name).kind(twilight_model::channel::ChannelType::GuildText).permission_overwrites(&over).topic(topic);
        if let Some(parent) = category.and_then(|c| c.parse::<Id<ChannelMarker>>().ok()) {
            request = request.parent_id(parent);
        }
        const NO: &str = "I couldn't create the ticket channel. I need **Manage Channels**, and the category must have room (Discord allows 50 channels in one).";
        Ok(request.await.map_err(|_| NO.to_string())?.model().await.map_err(|e| e.to_string())?.id)
    }

    async fn on_interaction(self: &Arc<Self>, i: &Interaction) {
        self.touch_private(i);
        // the 1-5 star buttons in a member's DM after their ticket was closed: rate:<server>:<ticket>:<stars>
        if i.guild_id.is_none() {
            let (Some(InteractionData::MessageComponent(press)), Some(user)) = (&i.data, i.user.as_ref()) else { return };
            // modmail: the server picked for a DM
            if press.custom_id == "mmpick" {
                let pending = self.mm_pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&user.id.get());
                let gid = press.values.first().cloned().unwrap_or_default();
                let Some(dm) = pending else {
                    self.answer(i, &Card::new(gb_core::Area::General).line("That expired. Send your message again."), true).await;
                    return;
                };
                let name = self.bot.db.get().guilds().unwrap_or_default().into_iter().find(|g| g.id == gid).map(|g| g.name).unwrap_or_else(|| "that server".into());
                self.answer(i, &Card::new(gb_core::Area::General).line(format!("Sending it to the staff of **{name}**...")), true).await;
                self.modmail_deliver(&gid, &dm).await;
                return;
            }
            let p: Vec<&str> = press.custom_id.split(':').collect();
            if let ["rate", g, n, k] = p[..] {
                let Ok(gid) = g.parse::<Id<GuildMarker>>() else { return };
                let (say, log) = self.bot.on_rate(g, n.parse().unwrap_or(0), &user.id.to_string(), k.parse().unwrap_or(0), now_ms());
                self.answer(i, &Card::new(gb_core::Area::General).line(say), false).await;
                if let Some(a) = log { self.spawn(gid, a); }
            }
            return;
        }
        let (Some(guild), Some(member)) = (i.guild_id, i.member.as_ref()) else { return };
        let Some(user) = member.user.as_ref() else { return };
        let who = member_from(user, Some(member), guild);
        let place = i.channel.as_ref().map(|c| self.places.lock().unwrap_or_else(|p| p.into_inner()).place(c.id)).unwrap_or_default();
        let g = guild.get();
        let asker = who.id.clone();
        let actions = match &i.data {
            Some(InteractionData::ApplicationCommand(cmd)) => {
                // a grouped command arrives as one option holding the picked part's own options
                // a part inside a group arrives one level deeper; it is named "group part", as the core lists it
                let (sub, options) = match cmd.options.first().map(|o| (&o.name, &o.value)) {
                    Some((name, CommandOptionValue::SubCommand(inner))) => (Some(name.clone()), inner.as_slice()),
                    Some((group, CommandOptionValue::SubCommandGroup(parts))) => match parts.first().map(|o| (&o.name, &o.value)) {
                        Some((name, CommandOptionValue::SubCommand(inner))) => (Some(format!("{group} {name}")), inner.as_slice()),
                        _ => (Some(group.clone()), &[][..]),
                    },
                    _ => (None, cmd.options.as_slice()),
                };
                let (mut target, mut target2) = (None, None);
                let mut args = std::collections::BTreeMap::new();
                // a right-click user command names its member in target_id; "Warn member" runs /warn for them
                let is_message = cmd.kind == twilight_model::application::command::CommandType::Message;
                let context_user = cmd.target_id.filter(|_| !is_message).map(|t| t.cast::<twilight_model::id::marker::UserMarker>());
                // right-click a message > Apps: the message's text (and its cards' text) and the member's language
                if is_message {
                    if let Some(m) = cmd.target_id.and_then(|t| cmd.resolved.as_ref()?.messages.get(&t.cast())) {
                        let mut text = vec![m.content.clone()];
                        text.extend(m.embeds.iter().map(|e| [e.title.clone(), e.description.clone()].into_iter().flatten().collect::<Vec<_>>().join("\n")));
                        text.extend(card_texts(&m.components));
                        args.insert("text".to_string(), text.into_iter().filter(|t| !t.trim().is_empty()).collect::<Vec<_>>().join("\n"));
                    }
                    args.insert("locale".to_string(), i.locale.clone().unwrap_or_else(|| "en".into()));
                    if let Some(t) = cmd.target_id { args.insert("message_id".to_string(), t.to_string()); }
                    if let Some(m) = cmd.target_id.and_then(|t| cmd.resolved.as_ref()?.messages.get(&t.cast())) { args.insert("author_id".to_string(), m.author.id.to_string()); }
                    if let Some(c) = i.channel.as_ref().map(|c| c.id) { args.insert("channel_id".to_string(), c.to_string()); }
                }
                if let Some(id) = context_user { target = resolved_member(cmd.resolved.as_ref(), id); }
                for o in options {
                    match &o.value {
                        CommandOptionValue::User(id) => {
                            let picked = resolved_member(cmd.resolved.as_ref(), *id);
                            if target.is_none() { target = picked } else if target2.is_none() { target2 = picked }
                        }
                        CommandOptionValue::String(text) => { args.insert(o.name.clone(), text.clone()); }
                        CommandOptionValue::Integer(n) => { args.insert(o.name.clone(), n.to_string()); }
                        CommandOptionValue::Boolean(b) => { args.insert(o.name.clone(), b.to_string()); }
                        CommandOptionValue::Role(id) => { args.insert(o.name.clone(), id.to_string()); }
                        CommandOptionValue::Channel(id) => { args.insert(o.name.clone(), id.to_string()); }
                        _ => {}
                    }
                }
                // values typed in the command bar (an older Discord that still offers the boxes) run the command as typed
                let typed = context_user.is_none() && !is_message && (!args.is_empty() || target.is_some());
                let name = if cmd.name == "Warn member" { "warn".to_string() } else { cmd.name.clone() };
                let ev = CommandEvent { guild: guild.to_string(), place, member: who, name, sub, target, target2, args, at_ms: now_ms(), from_form: typed };
                let names = self.names.lock().unwrap_or_else(|p| p.into_inner());
                self.guarded(guild, &format!("/{}", ev.name), || self.bot.on_command(&ev, &|id| id.parse::<u64>().ok().and_then(|u| names.0.get(&(g, u)).cloned()), &mut |lo, hi| fastrand::i64(lo..=hi.max(lo))))
            }
            Some(InteractionData::MessageComponent(press)) => {
                // Close on a game window: it is taken down at once
                if press.custom_id == "gbclose" { return self.close_window(i).await; }
                // the "Continue" button after a popup that led to another popup
                if let Some(key) = press.custom_id.strip_prefix("fnext:") {
                    let found = self.next_forms.lock().unwrap_or_else(|p| p.into_inner()).remove(key);
                    match found {
                        Some((owner, id, title, fields, _)) if owner == who.id => return self.answer_form(i, &id, &title, &fields).await,
                        Some(_) => return self.answer(i, &Card::new(gb_core::Area::General).line("That button belongs to someone else.").private(), false).await,
                        None => return self.answer(i, &Card::new(gb_core::Area::General).line("That step has run out. Start again.").private(), false).await,
                    }
                }
                // a GIF picked for a roleplay action: posted with it (only by the member who asked)
                if let Some(rest) = press.custom_id.strip_prefix("rpg:") {
                    let (id, n) = rest.split_once(':').unwrap_or((rest, ""));
                    let picked = {
                        let mut picks = self.rp_picks.lock().unwrap_or_else(|p| p.into_inner());
                        match picks.get(id) {
                            Some(p) if p.2 != who.id => Err("That picker belongs to someone else."),
                            Some(_) => Ok(picks.remove(id)),
                            None => Ok(None),
                        }
                    };
                    let card = match picked {
                        Err(why) => Card::new(gb_core::Area::Games).line(why).private(),
                        Ok(None) => Card::new(gb_core::Area::Games).line("That picker is no longer active. Use `/rp` again.").private(),
                        Ok(Some((_, action, from, to, gifs))) => {
                            let gif = n.parse::<usize>().ok().and_then(|k| gifs.get(k).cloned());
                            let channel = i.channel.as_ref().map(|c| c.id.to_string()).unwrap_or_default();
                            self.rp_send(guild, &channel, &action, &from, to.as_deref(), gif.as_deref()).await
                        }
                    };
                    self.answer(i, &card, true).await;
                    return;
                }
                let ev = ButtonEvent { guild: guild.to_string(), place, member: who, id: press.custom_id.clone(), message: i.message.as_ref().map(|m| m.id.to_string()).unwrap_or_default(), values: press.values.clone(), at_ms: now_ms() };
                self.run_button(i, guild, ev).await
            }
            Some(InteractionData::ModalSubmit(form)) => {
                use twilight_model::application::interaction::modal::ModalInteractionComponent as C;
                // boxes arrive inside rows (or labels); only what was typed is wanted
                type Files = std::collections::BTreeMap<String, Vec<(String, String, u64)>>;
                let resolved = form.resolved.as_ref();
                fn typed(list: &[C], out: &mut std::collections::BTreeMap<String, String>, files: &mut Files, resolved: Option<&twilight_model::application::interaction::InteractionDataResolved>) {
                    let join = |ids: Vec<String>| ids.join(",");
                    for c in list {
                        match c {
                            C::ActionRow(row) => typed(&row.components, out, files, resolved),
                            C::Label(label) => typed(std::slice::from_ref(&*label.component), out, files, resolved),
                            C::TextInput(input) => { out.insert(input.custom_id.clone(), input.value.clone()); }
                            C::StringSelect(s) => { out.insert(s.custom_id.clone(), s.values.join(",")); }
                            C::UserSelect(s) => { out.insert(s.custom_id.clone(), join(s.values.iter().map(|v| v.to_string()).collect())); }
                            C::RoleSelect(s) => { out.insert(s.custom_id.clone(), join(s.values.iter().map(|v| v.to_string()).collect())); }
                            C::ChannelSelect(s) => { out.insert(s.custom_id.clone(), join(s.values.iter().map(|v| v.to_string()).collect())); }
                            C::FileUpload(u) => {
                                let got: Vec<(String, String, u64)> = u.values.iter().filter_map(|id| resolved?.attachments.get(id)).map(|a| (a.filename.clone(), a.url.clone(), a.size)).collect();
                                out.insert(u.custom_id.clone(), got.len().to_string());
                                files.insert(u.custom_id.clone(), got);
                            }
                            _ => {}
                        }
                    }
                }
                let mut values = std::collections::BTreeMap::new();
                let mut files = Files::new();
                typed(&form.components, &mut values, &mut files, resolved);
                // members picked in member pickers, with their names and roles
                let members: Vec<Member> = resolved.map(|r| r.users.iter().map(|(id, user)| {
                    let m = r.members.get(id);
                    let name = m.and_then(|m| m.nick.clone()).or_else(|| user.global_name.clone()).unwrap_or_else(|| user.name.clone());
                    Member { id: id.to_string(), name, avatar: user.avatar.map(|h| format!("https://cdn.discordapp.com/avatars/{id}/{h}.png?size=128")), roles: m.map(|m| m.roles.iter().map(|x| x.to_string()).collect()).unwrap_or_default(), bot: user.bot, perms: m.map(|m| m.permissions.bits()).unwrap_or(0), joined_at: m.and_then(|m| m.joined_at).map(|t| t.as_micros() / 1000) }
                }).collect()).unwrap_or_default();
                let names = self.names.lock().unwrap_or_else(|p| p.into_inner());
                self.guarded(guild, "a popup", || self.bot.on_form(&FormEvent { guild: guild.to_string(), place, member: who, id: form.custom_id.clone(), values, members, files, at_ms: now_ms() }, &|id| id.parse::<u64>().ok().and_then(|u| names.0.get(&(g, u)).cloned()), &mut |lo, hi| fastrand::i64(lo..=hi.max(lo))))
            }
            _ => return,
        };
        // A popup is the whole answer. Discord cannot open a popup in answer to a popup, so then a button opens it.
        if let Some(Action::Form { id, title, fields }) = actions.first() {
            if matches!(&i.data, Some(InteractionData::ModalSubmit(_))) || self.slow.lock().unwrap_or_else(|p| p.into_inner()).contains(&i.id.get()) {
                let key = format!("{:x}", fastrand::u64(..));
                {
                    let mut next = self.next_forms.lock().unwrap_or_else(|p| p.into_inner());
                    let now = now_ms();
                    next.retain(|_, v| now - v.4 < 15 * 60_000);
                    next.insert(key.clone(), (asker.clone(), id.clone(), title.clone(), fields.clone(), now));
                }
                let card = Card::new(gb_core::Area::General).title(title.clone()).line("One more step: press the button to open the next form.\n-# Only you can see this. The button works for 15 minutes.").button(format!("fnext:{key}"), "Continue", gb_core::ButtonStyle::Primary).private();
                return self.answer(i, &card, false).await;
            }
            return self.answer_form(i, id, title, fields).await;
        }
        // A private channel is made first; what the bot says once it exists is the answer.
        let actions = if let Some(Action::OpenChannel { name, category, topic, members, staff_roles, note }) = actions.first() {
            match self.open_channel(guild, name, category.as_deref(), topic, members, staff_roles).await {
                Ok(channel) => self.bot.on_channel_made(&guild.to_string(), note, &channel.to_string()),
                Err(why) => {
                    self.bot.on_channel_failed(&guild.to_string(), note);
                    return self.answer(i, &Card::new(gb_core::Area::General).line(why).private(), false).await;
                }
            }
        } else {
            actions
        };
        // The answer comes first in the list. Everything else is carried out before answering, so that when
        // Discord refuses a kick, ban or timeout the person is told so instead of being told it worked.
        let mut actions = actions.into_iter();
        let answer = actions.next();
        let mut failed = None;
        let mut followups = Vec::new();
        let mut lookups = Vec::new();
        let mut bites: Vec<(String, u64)> = Vec::new();
        let mut posts = Vec::new();
        let mut transcripts = Vec::new();
        let mut purge_jobs = Vec::new();
        for action in actions {
            if let Action::Transcript { channel, head, to } = action {
                transcripts.push((channel, head, to));
                continue;
            }
            if let Action::Purge { .. } = action {
                purge_jobs.push(action);
                continue;
            }
            if matches!(action, Action::Send { .. } | Action::Post { .. }) {
                posts.push(action);
                continue;
            }
            if let Action::FollowUp { card } = action {
                followups.push(card);
                continue;
            }
            if let Action::BiteWatch { id, after_ms } = action {
                bites.push((id, after_ms));
                continue;
            }
            if let Action::Music { cmd: cmd @ (gb_core::music::MusicCmd::Resolve { .. } | gb_core::music::MusicCmd::Lyrics { .. }), slot } = action {
                lookups.push((cmd, slot));
                continue;
            }
            if failed.is_some() && matches!(action, Action::Kick { .. } | Action::Ban { .. } | Action::Unban { .. } | Action::Timeout { .. }) {
                self.bot.action_refused(&guild.to_string(), &action);
                continue;
            }
            let critical = matches!(action, Action::Kick { .. } | Action::Ban { .. } | Action::Unban { .. } | Action::Timeout { .. });
            if critical {
                let kept = action.clone();
                if let Err(why) = self.perform(guild, action).await {
                    self.bot.action_refused(&guild.to_string(), &kept);
                    failed = Some(why);
                }
            } else {
                self.spawn(guild, action);
            }
        }
        // roleplay: GIFs are looked up first ("thinking…", only the member sees it); then a few to pick from, or the
        // action is posted straight away
        if let (None, Some(Action::RpGifs { action, from, to, query, pick })) = (&failed, &answer) {
            let defer = InteractionResponse { kind: twilight_model::http::interaction::InteractionResponseType::DeferredChannelMessageWithSource, data: Some(twilight_model::http::interaction::InteractionResponseData { flags: Some(MessageFlags::EPHEMERAL), ..Default::default() }) };
            let _ = self.http.interaction(self.app).create_response(i.id, &i.token, &defer).await;
            self.dismiss_answer(i, true);
            let key = self.bot.db.get().data_get("0", "roleplay", "tenorKey").ok().flatten().and_then(|v| v.as_str().map(str::to_string));
            let gifs = match (query, key) { (Some(q), Some(k)) => tenor_gifs(&self.web, &k, q).await, _ => Vec::new() };
            let channel = i.channel.as_ref().map(|c| c.id.to_string()).unwrap_or_default();
            let card = if *pick && !gifs.is_empty() {
                let shown: Vec<String> = gifs.into_iter().take(8).collect();
                let id = format!("{:x}", fastrand::u64(..));
                let mut card = Card::new(gb_core::Area::Games).title("Pick a GIF").line("-# Only you can see this. Press a number to post it.").private();
                for (n, g) in shown.iter().enumerate() { card = card.image(g.clone()).button(format!("rpg:{id}:{n}"), (n + 1).to_string(), gb_core::ButtonStyle::Plain); }
                card = card.button(format!("rpg:{id}:none"), "Post without a GIF", gb_core::ButtonStyle::Plain);
                self.rp_picks.lock().unwrap_or_else(|p| p.into_inner()).insert(id, (guild.to_string(), action.clone(), from.clone(), to.clone(), shown));
                card
            } else {
                let gif = (!gifs.is_empty()).then(|| gifs[fastrand::usize(..gifs.len())].clone());
                self.rp_send(guild, &channel, action, from, to.as_deref(), gif.as_deref()).await
            };
            if let Ok(parts) = components(&card) { let _ = self.http.interaction(self.app).update_response(&i.token).flags(MessageFlags::IS_COMPONENTS_V2).components(Some(&parts)).await; }
            return;
        }
        // server backups: the layout is read from Discord first ("thinking…", only the member sees it)
        if let (None, Some(Action::Backup { id, by, restore })) = (&failed, &answer) {
            let g = guild.to_string();
            if *restore {
                let _ = self.http.interaction(self.app).create_response(i.id, &i.token, &InteractionResponse { kind: twilight_model::http::interaction::InteractionResponseType::DeferredUpdateMessage, data: None }).await;
                let say = |card: Card| { let link = self.clone(); let token = i.token.clone(); async move { if let Ok(parts) = components(&card) { let _ = link.http.interaction(link.app).update_response(&token).components(Some(&parts)).await; } } };
                say(Card::new(gb_core::Area::General).line("♻️ Restoring…").private()).await;
                let n = id.unwrap_or(0);
                let card = match self.layout(guild).await {
                    Err(why) => Card::new(gb_core::Area::General).line(format!("⚠️ {why}")).private(),
                    Ok(now) => match self.bot.backup_plan(&g, n, &now) {
                        Some((roles, channels)) => { let (r, c, f) = self.restore(guild, &roles, &channels, &format!("Backup #{n} restored")).await; gb_core::backup::restored(r, c, &f) }
                        None => Card::new(gb_core::Area::General).line(format!("There's no backup #{n}. See `/backup list`.")).private(),
                    },
                };
                say(card).await;
                return;
            }
            let defer = InteractionResponse { kind: twilight_model::http::interaction::InteractionResponseType::DeferredChannelMessageWithSource, data: Some(twilight_model::http::interaction::InteractionResponseData { flags: Some(MessageFlags::EPHEMERAL), ..Default::default() }) };
            let _ = self.http.interaction(self.app).create_response(i.id, &i.token, &defer).await;
            self.dismiss_answer(i, true);
            let card = match self.layout(guild).await {
                Err(why) => Card::new(gb_core::Area::General).line(format!("⚠️ {why}")).private(),
                Ok(now) => match id { None => self.bot.backup_saved(&g, by, &now, now_ms()), Some(n) => self.bot.backup_preview(&g, *n, by, &now) },
            };
            if let Ok(parts) = components(&card) { let _ = self.http.interaction(self.app).update_response(&i.token).flags(MessageFlags::IS_COMPONENTS_V2).components(Some(&parts)).await; }
            return;
        }
        // server setup: the server is read first, so the answer takes a moment (a command is answered privately; a button updates its card)
        if let (None, Some(Action::Setup(job))) = (&failed, &answer) {
            let button = i.kind == twilight_model::application::interaction::InteractionType::MessageComponent;
            if button {
                let _ = self.http.interaction(self.app).create_response(i.id, &i.token, &InteractionResponse { kind: twilight_model::http::interaction::InteractionResponseType::DeferredUpdateMessage, data: None }).await;
            } else {
                let defer = InteractionResponse { kind: twilight_model::http::interaction::InteractionResponseType::DeferredChannelMessageWithSource, data: Some(twilight_model::http::interaction::InteractionResponseData { flags: Some(MessageFlags::EPHEMERAL), ..Default::default() }) };
                let _ = self.http.interaction(self.app).create_response(i.id, &i.token, &defer).await;
                self.dismiss_answer(i, true);
            }
            let card = self.run_setup(guild, job).await;
            if let Ok(parts) = components(&card) { let _ = self.http.interaction(self.app).update_response(&i.token).flags(MessageFlags::IS_COMPONENTS_V2).components(Some(&parts)).await; }
            return;
        }
        // /id roblox: Roblox is asked first ("thinking…", only the member sees it)
        if let (None, Some(Action::Roblox { name })) = (&failed, &answer) {
            let defer = InteractionResponse { kind: twilight_model::http::interaction::InteractionResponseType::DeferredChannelMessageWithSource, data: Some(twilight_model::http::interaction::InteractionResponseData { flags: Some(MessageFlags::EPHEMERAL), ..Default::default() }) };
            let _ = self.http.interaction(self.app).create_response(i.id, &i.token, &defer).await;
            self.dismiss_answer(i, true);
            let found = async {
                let r = tokio::time::timeout(std::time::Duration::from_secs(6), self.web.post("https://users.roblox.com/v1/usernames/users").json(&json!({ "usernames": [name], "excludeBannedUsers": true })).send()).await.map_err(|_| "Roblox did not answer in time.".to_string())?.map_err(|_| "I could not reach Roblox.".to_string())?;
                if !r.status().is_success() { return Err(format!("Roblox answered {}.", r.status().as_u16())); }
                let body: serde_json::Value = r.json().await.map_err(|_| "Roblox sent an answer I did not understand.".to_string())?;
                let Some(hit) = body["data"].as_array().and_then(|d| d.first()) else { return Ok(None) };
                let id = hit["id"].as_i64().map(|n| n.to_string()).or_else(|| hit["id"].as_str().map(str::to_string)).ok_or("Roblox sent an answer I did not understand.")?;
                Ok(Some((id, hit["name"].as_str().unwrap_or(name).to_string(), hit["displayName"].as_str().unwrap_or("").to_string())))
            }.await;
            let card = gb_core::eclipseid::roblox_said(name, found);
            if let Ok(parts) = components(&card) { let _ = self.http.interaction(self.app).update_response(&i.token).flags(MessageFlags::IS_COMPONENTS_V2).components(Some(&parts)).await; }
            return;
        }
        // the bot owner's Tenor key: tried once before it is kept, and never shown again
        if let (None, Some(Action::TenorKey { key })) = (&failed, &answer) {
            let text = match key {
                None => {
                    let _ = self.bot.db.get().data_set("0", "roleplay", "tenorKey", &serde_json::Value::Null);
                    "Tenor is off. Roleplay actions are posted without GIFs.".to_string()
                }
                Some(k) if tenor_gifs(&self.web, k, "furry hug").await.is_empty() => "Tenor didn't accept that key. Check it at developers.google.com/tenor and try again.".to_string(),
                Some(k) => {
                    let _ = self.bot.db.get().data_set("0", "roleplay", "tenorKey", &json!(k));
                    "✅ Tenor is on: roleplay actions show GIFs to pick from in every server.".to_string()
                }
            };
            self.answer(i, &Card::new(gb_core::Area::Games).line(text).private(), false).await;
            return;
        }
        // /tts voices and /tts diagnose: "thinking…" first, then what the computer says
        if let (None, Some(Action::TtsInfo { diagnose, provider, voice, lang })) = (&failed, &answer) {
            let defer = InteractionResponse { kind: twilight_model::http::interaction::InteractionResponseType::DeferredChannelMessageWithSource, data: Some(twilight_model::http::interaction::InteractionResponseData { flags: Some(MessageFlags::EPHEMERAL), ..Default::default() }) };
            let _ = self.http.interaction(self.app).create_response(i.id, &i.token, &defer).await;
            self.dismiss_answer(i, true);
            let text = if *diagnose {
                speech::diagnose(&self.web, &self.voice.cache_dir(), provider, voice.as_deref(), lang).await
            } else if !cfg!(windows) {
                "Named voices are only available when the bot runs on Windows. Use `/tts voice language:…` instead.".to_string()
            } else {
                let v = speech::voices().await;
                if v.is_empty() { "No voices found. Windows may have speech disabled.".into() } else { format!("Installed voices:\n{}\nPick one with `/tts voice name:…`.", v.iter().map(|n| format!("- {n}")).collect::<Vec<_>>().join("\n")) }
            };
            let card = Card::new(gb_core::Area::General).line(text);
            if let Ok(parts) = components(&card) { let _ = self.http.interaction(self.app).update_response(&i.token).flags(MessageFlags::IS_COMPONENTS_V2).components(Some(&parts)).await; }
            return;
        }
        // integrations: "thinking…" first (only the member sees it), then what the internet said
        if let (None, Some(Action::Fetch(f))) = (&failed, &answer) {
            use gb_core::integrations::Fetch as F;
            let quiet = !matches!(**f, F::Minecraft { .. });
            let defer = InteractionResponse { kind: twilight_model::http::interaction::InteractionResponseType::DeferredChannelMessageWithSource, data: Some(twilight_model::http::interaction::InteractionResponseData { flags: quiet.then_some(MessageFlags::EPHEMERAL), ..Default::default() }) };
            let _ = self.http.interaction(self.app).create_response(i.id, &i.token, &defer).await;
            let g = guild.to_string();
            let card = match (**f).clone() {
                F::Add { provider, target, lookup, channel, template, by } => {
                    let target = match (target, lookup) { (Some(t), _) => Ok(t), (None, Some(l)) => feeds::resolve(&self.web, &provider, &l).await, (None, None) => Err("Unknown provider.".to_string()) };
                    match target {
                        Ok(t) => { let found = feeds::items(&self.web, &provider, &t).await; self.bot.feed_added(&g, &provider, &t, &channel, template.as_deref(), &by, found, now_ms()) }
                        Err(why) => Card::new(gb_core::Area::General).line(why),
                    }
                }
                F::Minecraft { address } => {
                    let status = async { serde_json::from_str::<serde_json::Value>(&feeds::text(&self.web, &format!("https://api.mcsrvstat.us/3/{address}"), 1_000_000).await?).map_err(|_| "The status service sent an answer I did not understand.".to_string()) }.await;
                    gb_core::integrations::minecraft_card(&address, status)
                }
                F::TwitchKeys { id, secret } => match feeds::set_twitch(&self.web, &id, &secret).await {
                    Ok(()) => { let _ = self.bot.db.get().data_set("0", "integrations", "twitchKeys", &json!({ "id": id, "secret": secret })); Card::new(gb_core::Area::General).line("✅ Twitch keys saved. Add a live alert with `/feed add provider:twitch`.") }
                    Err(why) => Card::new(gb_core::Area::General).line(why),
                },
                F::Poll { .. } => Card::new(gb_core::Area::General).line("Checking."),
            };
            if let Ok(parts) = components(&card) { let _ = self.http.interaction(self.app).update_response(&i.token).flags(MessageFlags::IS_COMPONENTS_V2).components(Some(&parts)).await; }
            return;
        }
        // the inactive-members tools: the member list is read first
        if let (None, Some(Action::Inactive(ask))) = (&failed, &answer) {
            use twilight_model::http::interaction::{InteractionResponseData, InteractionResponseType as T};
            let defer = InteractionResponse { kind: if ask.update { T::DeferredUpdateMessage } else { T::DeferredChannelMessageWithSource }, data: (!ask.update).then(|| InteractionResponseData { flags: Some(MessageFlags::EPHEMERAL), ..Default::default() }) };
            let _ = self.http.interaction(self.app).create_response(i.id, &i.token, &defer).await;
            self.dismiss_answer(i, !ask.update);
            let facts = self.member_facts(guild).await;
            let mut acts = self.bot.inactive(&guild.to_string(), ask, &facts, now_ms()).into_iter();
            if let Some(first) = acts.next() {
                let card = match first { Action::Reply { card } | Action::Update { card } => Some(card), other => { self.spawn(guild, other); None } };
                if let Some(card) = card { if let Ok(parts) = components(&card) { let _ = self.http.interaction(self.app).update_response(&i.token).flags(MessageFlags::IS_COMPONENTS_V2).components(Some(&parts)).await; } }
            }
            for a in acts { self.spawn(guild, a); }
            return;
        }
        // an image quote: "thinking…" first (privately when it goes to the quote channel), then the picture
        if let (None, Some(Action::Quote(q))) = (&failed, &answer) {
            return self.answer_quote(i, q).await;
        }
        // Translate: "thinking…" first (only the member sees it), then the translation in its place
        if let (None, Some(Action::Translate { text, to })) = (&failed, &answer) {
            let defer = InteractionResponse { kind: twilight_model::http::interaction::InteractionResponseType::DeferredChannelMessageWithSource, data: Some(twilight_model::http::interaction::InteractionResponseData { flags: Some(MessageFlags::EPHEMERAL), ..Default::default() }) };
            let _ = self.http.interaction(self.app).create_response(i.id, &i.token, &defer).await;
            self.dismiss_answer(i, true);
            let card = match translate(&self.web, text, to).await {
                Ok((out, from)) => Card::new(gb_core::Area::General).title(format!("🌐 Translated{} to {to}", from.map(|f| format!(" from {f}")).unwrap_or_default())).line(out.chars().take(4000).collect::<String>()).line("-# Google Translate · only you can see this"),
                Err(why) => Card::new(gb_core::Area::General).line(why),
            };
            if let Ok(parts) = components(&card) { let _ = self.http.interaction(self.app).update_response(&i.token).flags(MessageFlags::IS_COMPONENTS_V2).components(Some(&parts)).await; }
            return;
        }
        match (failed, answer) {
            (Some(why), _) => self.answer(i, &Card::new(gb_core::Area::Moderation).line(format!("That did not go through. {why}")).private(), false).await,
            (None, Some(Action::Reply { card })) => self.answer(i, &card, false).await,
            (None, Some(Action::Update { card })) => self.answer(i, &card, true).await,
            (None, Some(other)) => self.spawn(guild, other),
            (None, None) => {}
        }
        // second messages, after the answer: only the person who pressed the button sees them
        for card in followups {
            let Ok(parts) = components(&card) else { continue };
            match self.http.interaction(self.app).create_followup(&i.token).flags(flags(&card)).components(&parts).attachments(&files_of(&card)).await {
                Ok(sent) => {
                    if card.private && !keeps_files(&card) {
                        if let Ok(m) = sent.model().await { self.dismiss_later(format!("f{}", m.id), &i.token, Some(m.id)); }
                    }
                }
                Err(e) => eprintln!("Could not send a follow-up: {e}"),
            }
        }
        // posts in channels (a panel, a giveaway, a player): when one can't be made, the person who asked is told why
        for post in posts {
            if let Err(why) = self.perform(guild, post).await {
                let card = Card::new(gb_core::Area::General).line(format!("⚠️ {why}")).private();
                let Ok(parts) = components(&card) else { continue };
                if let Err(e) = self.http.interaction(self.app).create_followup(&i.token).flags(flags(&card)).components(&parts).attachments(&files_of(&card)).await {
                    eprintln!("{why} (and the person could not be told: {e})");
                }
            }
        }
        // purges: run after the answer; a long one shows its progress on the answer (as Good Boy 3 does, for 14 minutes)
        for job in purge_jobs {
            let Action::Purge { channel, count, from, keep_pinned, progress, by } = job else { continue };
            let link = self.clone();
            let token = i.token.clone();
            tokio::spawn(async move {
                let started = now_ms();
                let last = std::sync::atomic::AtomicI64::new(0);
                let edit = |text: String, stop_button: bool| {
                    let link = link.clone();
                    let token = token.clone();
                    let by = by.clone();
                    async move {
                        let mut card = Card::new(gb_core::Area::Moderation).line(text).private();
                        if stop_button { card = card.button(format!("mpurge:stop:{by}"), "Stop", gb_core::ButtonStyle::Plain); }
                        if let Ok(parts) = components(&card) { let _ = link.http.interaction(link.app).update_response(&token).components(Some(&parts)).await; }
                    }
                };
                let handle = tokio::runtime::Handle::current();
                let tick = |deleted: u64| {
                    let now = now_ms();
                    if progress && now - last.load(std::sync::atomic::Ordering::Relaxed) > 5000 && now - started < 14 * 60_000 {
                        last.store(now, std::sync::atomic::Ordering::Relaxed);
                        handle.spawn(edit(format!("🧹 Purging… {} deleted so far.", deleted), true));
                    }
                };
                let (deleted, stopped) = link.run_purge(&channel, count, from.as_deref(), keep_pinned, &tick).await;
                let (text, log) = link.bot.on_purged(&guild.to_string(), &channel, &by, from.as_deref(), deleted, stopped, progress);
                for a in log { link.spawn(guild, a); }
                if now_ms() - started < 14 * 60_000 { edit(text, false).await; } else if let Ok(u) = by.parse::<Id<UserMarker>>() {
                    if let Ok(dm) = link.http.create_private_channel(u).await { if let Ok(dm) = dm.model().await { let _ = link.http.create_message(dm.id).content(&text).await; } }
                }
            });
        }
        // transcripts: made once, then sent to each place (privately to the person who asked, when they did)
        for (channel, head, to) in transcripts {
            let file = self.transcript(&channel, &head).await;
            for t in &to { self.deliver_transcript(t, file.as_ref(), Some(i)).await; }
        }
        // a fishing cast waits for its bite, then the player's message shows it
        for (id, after) in bites {
            let (me, token) = (self.clone(), i.token.clone());
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(after)).await;
                if let Some(card) = me.bot.fish_bite(&guild.to_string(), &id, now_ms()) {
                    if let Ok(parts) = components(&card) { let _ = me.http.interaction(me.app).update_response(&token).flags(MessageFlags::IS_COMPONENTS_V2).components(Some(&parts)).attachments(&files_of(&card)).await; }
                }
            });
        }
        // songs looked up and lyrics found: the answer goes to the person who asked, the rest is carried out
        for (cmd, slot) in lookups {
            let first = match cmd {
                gb_core::music::MusicCmd::Resolve { query, by, .. } => {
                    let found = self.voice.resolve(&query).await;
                    let mut actions = self.bot.on_music_found(&guild.to_string(), slot, &by, found, now_ms()).into_iter();
                    let first = actions.next();
                    for action in actions { self.spawn(guild, action); }
                    match first { Some(Action::Reply { card } | Action::Update { card } | Action::FollowUp { card }) => Some(card), Some(other) => { self.spawn(guild, other); None } None => None }
                }
                gb_core::music::MusicCmd::Lyrics { title, artist } => {
                    let found = self.voice.lyrics(&title, artist.as_deref()).await;
                    Some(gb_core::music::Music::lyrics_card(&title, found))
                }
                _ => None,
            };
            let Some(card) = first else { continue };
            let Ok(parts) = components(&card) else { continue };
            if let Err(e) = self.http.interaction(self.app).create_followup(&i.token).flags(flags(&card)).components(&parts).attachments(&files_of(&card)).await {
                eprintln!("Could not send a follow-up: {e}");
            }
        }
    }
}

/// Safe GIFs from Tenor (strict safe search). Empty when Tenor doesn't answer or the key is wrong.
async fn tenor_gifs(web: &reqwest::Client, key: &str, query: &str) -> Vec<String> {
    let Ok(url) = reqwest::Url::parse_with_params("https://tenor.googleapis.com/v2/search", &[("q", query), ("key", key), ("client_key", "goodboy"), ("limit", "24"), ("media_filter", "gif"), ("contentfilter", "high")]) else { return Vec::new() };
    let Ok(Ok(r)) = tokio::time::timeout(std::time::Duration::from_secs(6), web.get(url).send()).await else { return Vec::new() };
    if !r.status().is_success() { return Vec::new(); }
    let Ok(d) = r.json::<serde_json::Value>().await else { return Vec::new() };
    d["results"].as_array().into_iter().flatten().filter_map(|x| x["media_formats"]["gif"]["url"].as_str()).filter(|u| u.starts_with("https://") && u.contains(".tenor.com/")).map(str::to_string).collect()
}
/// Translates text with Google's free endpoint (as Good Boy 3 does). Gives (text, the language it was in).
async fn translate(web: &reqwest::Client, text: &str, to: &str) -> Result<(String, Option<String>), String> {
    let q: String = text.chars().take(1800).collect();
    let url = reqwest::Url::parse_with_params("https://translate.googleapis.com/translate_a/single", &[("client", "gtx"), ("sl", "auto"), ("tl", to), ("dt", "t"), ("q", q.as_str())]).map_err(|_| "Couldn't translate that.".to_string())?;
    let busy = || "Translation is not answering right now. Try again in a minute.".to_string();
    let r = tokio::time::timeout(std::time::Duration::from_secs(8), web.get(url).send()).await.map_err(|_| busy())?.map_err(|_| busy())?;
    if !r.status().is_success() { return Err(busy()); }
    let d: serde_json::Value = r.json().await.map_err(|_| busy())?;
    let out: String = d[0].as_array().map(|parts| parts.iter().filter_map(|p| p[0].as_str()).collect()).unwrap_or_default();
    if out.is_empty() { return Err("Couldn't translate that.".into()); }
    Ok((out, d[2].as_str().map(str::to_string)))
}
/// Whether a member can see a channel: the server's and the channel's permission rules, as Discord works them out.
async fn can_see(link: &Link, guild: Id<GuildMarker>, user: Id<UserMarker>, channel: Id<ChannelMarker>) -> bool {
    const VIEW: u64 = 1 << 10;
    const ADMIN: u64 = 1 << 3;
    let Ok(member) = async { link.http.guild_member(guild, user).await.ok()?.model().await.ok() }.await.ok_or(()) else { return false };
    let Some(ch) = async { link.http.channel(channel).await.ok()?.model().await.ok() }.await else { return false };
    // a thread follows the channel it is in
    let ch = match ch.parent_id.filter(|_| ch.kind.is_thread()) {
        Some(parent) => match async { link.http.channel(parent).await.ok()?.model().await.ok() }.await { Some(p) => p, None => return false },
        None => ch,
    };
    let g = guild.to_string();
    let roles: Vec<String> = member.roles.iter().map(|r| r.to_string()).collect();
    let base = link.bot.directory.power_of(&g, &user.to_string(), &roles);
    if base & ADMIN != 0 { return true; }
    let mut perms = base;
    let overwrites = ch.permission_overwrites.unwrap_or_default();
    use twilight_model::channel::permission_overwrite::PermissionOverwriteType as T;
    if let Some(o) = overwrites.iter().find(|o| o.kind == T::Role && o.id.get() == guild.get()) { perms = (perms & !o.deny.bits()) | o.allow.bits(); }
    let (mut allow, mut deny) = (0u64, 0u64);
    for o in overwrites.iter().filter(|o| o.kind == T::Role && member.roles.iter().any(|r| r.get() == o.id.get())) { allow |= o.allow.bits(); deny |= o.deny.bits(); }
    perms = (perms & !deny) | allow;
    if let Some(o) = overwrites.iter().find(|o| o.kind == T::Member && o.id.get() == user.get()) { perms = (perms & !o.deny.bits()) | o.allow.bits(); }
    perms & VIEW != 0
}
/// One labelled box of a popup: typed text, a dropdown, or one of Discord's pickers (Good Boy 3's popup kinds).
fn popup_field(f: &gb_core::Field) -> serde_json::Value {
    use gb_core::FieldKind as K;
    let (min, req) = (u8::from(f.required), f.required);
    let mut inner = match &f.kind {
        K::Text => {
            let mut t = json!({ "type": 4, "custom_id": f.id, "style": if f.long { 2 } else { 1 }, "required": req });
            if f.max > 0 { t["max_length"] = json!(f.max.min(4000)); }
            if let Some(v) = f.value.as_ref().filter(|v| !v.is_empty()) { t["value"] = json!(v.chars().take(f.max.max(1) as usize).collect::<String>()); }
            t
        }
        K::Select(list) => json!({ "type": 3, "custom_id": f.id, "min_values": min, "max_values": 1, "required": req,
            "options": list.iter().enumerate().map(|(n, (label, value))| {
                let mut o = json!({ "label": label, "value": value, "default": f.value.as_deref() == Some(value.as_str()) });
                if let Some(h) = f.hints.get(n).filter(|h| !h.is_empty()) { o["description"] = json!(h.chars().take(100).collect::<String>()); }
                o
            }).collect::<Vec<_>>() }),
        K::User { most } => json!({ "type": 5, "custom_id": f.id, "min_values": min, "max_values": (*most).max(1), "required": req }),
        K::Role { most } => {
            let mut r = json!({ "type": 6, "custom_id": f.id, "min_values": min, "max_values": (*most).max(1), "required": req });
            // the current role shows, so saving without touching it keeps it
            if let Some(v) = &f.value { r["default_values"] = json!(v.split(',').filter(|x| !x.is_empty()).map(|id| json!({ "id": id, "type": "role" })).collect::<Vec<_>>()); }
            r
        }
        K::Channel(kinds) => {
            let mut c = json!({ "type": 8, "custom_id": f.id, "min_values": min, "max_values": 1, "required": req, "channel_types": kinds });
            if let Some(v) = &f.value { c["default_values"] = json!([{ "id": v, "type": "channel" }]); }
            c
        }
        K::Files { most } => json!({ "type": 19, "custom_id": f.id, "min_values": min, "max_values": (*most).max(1), "required": req }),
    };
    if let Some(p) = &f.placeholder { if !matches!(f.kind, K::Files { .. }) { inner["placeholder"] = json!(p); } }
    // Discord refuses the whole popup if a label is over 45 characters or a description over 100
    let (short, spill) = fit_label(&f.label);
    let mut label = json!({ "type": 18, "label": short, "component": inner });
    let desc = f.desc.clone().or(spill).map(|d| d.chars().take(100).collect::<String>());
    if let Some(d) = desc { label["description"] = json!(d); }
    label
}

/// A popup label that fits Discord's 45 characters. A longer one is cut at a word, and the whole text goes
/// underneath as the small description instead, so nothing is lost.
fn fit_label(label: &str) -> (String, Option<String>) {
    if label.chars().count() <= 45 { return (label.to_string(), None); }
    let cut: String = label.chars().take(44).collect();
    let at = cut.rfind(' ').filter(|n| *n >= 20).unwrap_or(cut.len());
    (format!("{}…", cut[..at].trim_end_matches([',', ':', ';', ' ', '(', '-'])), Some(label.to_string()))
}

/// A connection to Discord (the bot shows as online, with no status text of its own).
fn connect_shard(token: &str, intents: Intents) -> Shard {
    Shard::with_config(ShardId::ONE, twilight_gateway::ConfigBuilder::new(token.to_string(), intents).build())
}

fn facts_of(r: &twilight_model::guild::Role) -> gb_core::bot::RoleFacts {
    gb_core::bot::RoleFacts { name: r.name.clone(), position: r.position, managed: r.managed, perms: r.permissions.bits(), mentionable: r.mentionable }
}
/// A reaction's emoji as the role modules look it up: a server's own emoji by id, anything else by its text.
/// An emoji as the bot reacts with it: "🔥", or a server's own as <:name:id>.
fn reaction_of(emoji: &str) -> twilight_http::request::channel::reaction::RequestReactionType<'_> {
    use twilight_http::request::channel::reaction::RequestReactionType as R;
    let inner = emoji.trim_start_matches('<').trim_end_matches('>').trim_start_matches('a').trim_start_matches(':');
    if let Some((name, id)) = inner.rsplit_once(':') {
        if let Ok(id) = id.parse() { return R::Custom { id, name: Some(name) }; }
    }
    R::Unicode { name: emoji }
}
fn reaction_key(e: &twilight_model::channel::message::EmojiReactionType) -> String {
    use twilight_model::channel::message::EmojiReactionType as E;
    match e { E::Custom { id, .. } => id.to_string(), E::Unicode { name } => name.clone() }
}

fn named(c: &Channel) -> Named {
    use twilight_model::channel::ChannelType as T;
    let kind = match c.kind {
        T::GuildText | T::GuildAnnouncement => "text",
        T::GuildVoice | T::GuildStageVoice => "voice",
        T::GuildCategory => "category",
        T::GuildForum | T::GuildMedia => "forum",
        _ => "other",
    };
    Named { id: c.id.to_string(), name: c.name.clone().unwrap_or_default(), kind, parent: c.parent_id.map(|p| p.to_string()).unwrap_or_default() }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// What the connection is doing, told to whoever started it (the launcher's status light, the command line).
#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    Connecting,
    Online { name: String, servers: usize },
    Hiccup(String),
    /// Something the owner should know that is not a fault (a switch on the bot's page that is off).
    Notice(String),
}
/// How the connection is told to stop and where it reports.
pub struct Control {
    /// Send `true` to stop.
    pub stop: tokio::sync::watch::Receiver<bool>,
    pub report: Arc<dyn Fn(Status) + Send + Sync>,
    /// Things the launcher asks the running bot to do (post a panel from the dashboard): (server, action).
    pub act: Option<tokio::sync::mpsc::UnboundedReceiver<(String, Action)>>,
    /// Extra bots that only play music: (their number from 1, their token).
    pub helpers: Vec<(usize, String)>,
}
/// Who a token belongs to.
#[derive(Debug, Clone, PartialEq)]
pub struct Identity {
    pub id: String,
    pub name: String,
}
/// Why a post in a channel did not go through, in plain words.
fn post_refusal(channel: impl std::fmt::Display, e: &twilight_http::Error) -> String {
    use twilight_http::error::ErrorType;
    match e.kind() {
        ErrorType::Response { status, .. } if status.get() == 403 => format!("I'm not allowed to post in <#{channel}>. Give my role **View Channel** and **Send Messages** there (and **Embed Links**)."),
        ErrorType::Response { status, .. } if status.get() == 404 => format!("<#{channel}> doesn't exist any more. Pick another channel."),
        ErrorType::Validation => format!("That message couldn't be put together for <#{channel}> ({e}). This is a bug in this build; please report it."),
        ErrorType::RequestTimedOut | ErrorType::RequestError => "Discord could not be reached. Try again in a moment.".into(),
        _ => format!("Discord did not take the post in <#{channel}>: {e}"),
    }
}
fn refusal(e: &twilight_http::Error) -> String {
    use twilight_http::error::ErrorType;
    match e.kind() {
        ErrorType::Unauthorized => "Discord says this token is not valid. Reset the token on the bot's page and paste the new one.".into(),
        ErrorType::Response { status, .. } if status.get() == 401 => "Discord says this token is not valid. Reset the token on the bot's page and paste the new one.".into(),
        ErrorType::RequestTimedOut | ErrorType::RequestError => "Discord could not be reached. Check this computer's internet connection and try again.".into(),
        _ => format!("Discord did not accept the request: {e}"),
    }
}
/// Asks Discord whose token this is, without connecting the bot or changing anything.
pub async fn identify(token: &str) -> Result<Identity, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let http = Client::new(token.to_string());
    let me = http.current_user().await.map_err(|e| refusal(&e))?.model().await.map_err(|e| e.to_string())?;
    Ok(Identity { id: me.id.to_string(), name: me.name })
}

/// One helper music bot: it only listens for what its own sound needs (which servers it is in, and the voice
/// connection details) and plays what the main bot's music module asks of it.
async fn run_helper(link: Arc<Link>, slot: usize, token: String, me: Id<UserMarker>, voice: Arc<voice::Voice>, mut stop: tokio::sync::watch::Receiver<bool>) {
    let config = twilight_gateway::ConfigBuilder::new(token, Intents::GUILDS | Intents::GUILD_VOICE_STATES).build();
    let mut shard = Shard::with_config(ShardId::ONE, config);
    voice.set_gateway(shard.sender());
    loop {
        let event = tokio::select! {
            _ = stop.changed() => { shard.close(twilight_gateway::CloseFrame::NORMAL); return; }
            next = shard.next_event(EventTypeFlags::all()) => match next {
                Some(Ok(e)) => e,
                Some(Err(_)) => continue,
                None => return,
            },
        };
        match event {
            Event::GuildCreate(g) => { link.bot.directory.helper_in(&g.id().to_string(), slot, true); }
            Event::GuildDelete(g) => { link.bot.directory.helper_in(&g.id.to_string(), slot, false); }
            Event::VoiceServerUpdate(v) => voice.on_server(v.guild_id, v.endpoint.as_deref(), &v.token),
            Event::VoiceStateUpdate(v) if v.0.user_id == me => {
                let Some(guild) = v.0.guild_id else { continue };
                voice.on_my_state(guild, v.0.channel_id, &v.0.session_id);
                link.bot.directory.set_voice(&guild.to_string(), &me.to_string(), v.0.channel_id.map(|c| c.to_string()).as_deref());
            }
            _ => {}
        }
    }
}

/// Connects to Discord and runs until it is told to stop. `bot` already holds the open database.
pub async fn run(token: String, bot: Arc<Bot>, mut ctl: Control) -> Result<(), String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let http = Client::new(token.clone());
    let application = http.current_user_application().await.map_err(|e| refusal(&e))?.model().await.map_err(|e| e.to_string())?;
    let app = application.id;
    // the bot's owner (a team's owner when the bot belongs to a team) is the only one who may turn on media links
    bot.directory.set_bot_owner(application.team.as_ref().map(|t| t.owner_user_id.to_string()).or_else(|| application.owner.as_ref().map(|u| u.id.to_string())));
    http.interaction(app).set_global_commands(&commands()).await.map_err(|e| format!("Could not register the commands: {e}"))?;
    let me = http.current_user().await.map_err(|e| refusal(&e))?.model().await.map_err(|e| e.to_string())?.id;
    let data = bot.db.get().path().parent().map(std::path::Path::to_path_buf).unwrap_or_default();
    let (heard_tx, mut heard) = tokio::sync::mpsc::unbounded_channel();
    let voice = voice::Voice::new(me, 0, &data, heard_tx.clone());
    // helper music bots: who they are (asked from Discord) and their sound
    let mut helper_voices: Vec<Option<Arc<voice::Voice>>> = vec![None];
    let mut helper_list: Vec<(usize, String, Id<UserMarker>, Arc<voice::Voice>)> = Vec::new();
    let mut known = Vec::new();
    for (slot, helper_token) in &ctl.helpers {
        let who = match identify(helper_token).await {
            Ok(w) => w,
            Err(why) => { (ctl.report)(Status::Notice(format!("Music bot {slot} could not start: {why}"))); continue; }
        };
        let Some(id) = who.id.parse::<Id<UserMarker>>().ok() else { continue };
        let v = voice::Voice::new(id, *slot, &data, heard_tx.clone());
        while helper_voices.len() <= *slot { helper_voices.push(None); }
        helper_voices[*slot] = Some(v.clone());
        known.push(gb_core::bot::Helper { slot: *slot, name: who.name.clone(), id: who.id.clone() });
        helper_list.push((*slot, helper_token.clone(), id, v));
    }
    bot.directory.set_helpers(known);
    let link = Arc::new(Link { bot, http, app, me, places: Mutex::default(), names: Mutex::default(), voice, helper_voices, data: data.clone(), purges: Mutex::default(), playing: Mutex::default(), next_forms: Mutex::default(), slow: Mutex::default(), member_roles: Mutex::default(), rp_picks: Mutex::default(), invites: Mutex::default(), mm_pending: Mutex::default(), dismiss: Mutex::default(), web: reqwest::Client::builder().user_agent("GoodBoy/4 (+Discord bot)").build().unwrap_or_default() });
    // private messages that nobody has touched for a while are taken down
    {
        let link = link.clone();
        // the pictures for games and cards need the computer's fonts loaded, which takes seconds the first time
        tokio::task::spawn_blocking(gb_art::warm);
        tokio::spawn(async move { loop { tokio::time::sleep(std::time::Duration::from_secs(10)).await; link.sweep_private().await; } });
    }

    // Only what the modules in this build need: servers (channels and threads), messages, and what messages say
    // (for counting). Reading messages is something the bot's owner switches on, on the bot's page; when it is
    // off Discord closes the connection, and the bot connects again without it.
    let mut basic = Intents::DIRECT_MESSAGES | Intents::GUILD_INVITES | Intents::GUILDS | Intents::GUILD_MESSAGES | Intents::GUILD_MESSAGE_REACTIONS | Intents::GUILD_VOICE_STATES | Intents::GUILD_MODERATION;
    // what people are playing (game roles) is only asked for when the bot's owner has switched on Presence Intent,
    // which Discord says in the application's flags; asking without it would close the connection
    use twilight_model::oauth::ApplicationFlags as F;
    let presences = application.flags.is_some_and(|f| f.intersects(F::GATEWAY_PRESENCE | F::GATEWAY_PRESENCE_LIMITED));
    if presences { basic |= Intents::GUILD_PRESENCES; }
    link.bot.directory.set_presences(presences);
    // Reading messages and seeing members join are each switched on by the bot's owner on the bot's page.
    // When one is off Discord closes the connection, so the bot tries again with less until it is let in.
    const NO_MESSAGES: &str = "Message Content is switched off on the bot's page, so counting and custom commands cannot see what people type.";
    const NO_MEMBERS: &str = "Server Members is switched off on the bot's page, so welcome and goodbye messages cannot be sent.";
    let attempts: [(Intents, Vec<&str>); 4] = [
        (basic | Intents::MESSAGE_CONTENT | Intents::GUILD_MEMBERS, vec![]),
        (basic | Intents::MESSAGE_CONTENT, vec![NO_MEMBERS]),
        (basic | Intents::GUILD_MEMBERS, vec![NO_MESSAGES]),
        (basic, vec![NO_MESSAGES, NO_MEMBERS]),
    ];
    let mut attempt = 0;
    let mut shard = connect_shard(&token, attempts[0].0);
    link.voice.set_gateway(shard.sender());
    for (slot, helper_token, id, v) in helper_list {
        let (link, stop) = (link.clone(), ctl.stop.clone());
        tokio::spawn(async move { run_helper(link, slot, helper_token, id, v, stop).await });
    }
    let mut clock = tokio::time::interval(std::time::Duration::from_secs(30));
    clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // the music player's progress bar, and leaving voice when nothing has played for a while
    let mut music_clock = tokio::time::interval(std::time::Duration::from_secs(10));
    music_clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    (ctl.report)(Status::Connecting);
    let mut online = false;
    let mut last_backup_check = 0i64;
    loop {
        let event = tokio::select! {
            _ = ctl.stop.changed() => { link.close_windows_for_restart().await; shard.close(twilight_gateway::CloseFrame::NORMAL); break; }
            _ = clock.tick() => {
                // the weekly server backups (looked at every 6 hours, as in Good Boy 3)
                if now_ms() - last_backup_check >= 6 * 3_600_000 {
                    last_backup_check = now_ms();
                    let link = link.clone();
                    tokio::spawn(async move {
                        for g in link.bot.weekly_backups_due(now_ms()) {
                            let Ok(gid) = g.parse::<Id<GuildMarker>>() else { continue };
                            if let Ok(layout) = link.layout(gid).await { link.bot.backup_saved(&g, "auto", &layout, now_ms()); }
                        }
                    });
                }
                // reminders and timed bans that have come due
                for (guild, action) in link.bot.on_tick(now_ms(), &mut |lo, hi| fastrand::i64(lo..=hi.max(lo))) {
                    if let Ok(guild) = guild.parse::<Id<GuildMarker>>() { link.spawn(guild, action); }
                }
                continue;
            }
            _ = music_clock.tick() => {
                for (guild, action) in link.bot.on_music_tick(now_ms()) {
                    if let Ok(guild) = guild.parse::<Id<GuildMarker>>() { link.spawn(guild, action); }
                }
                continue;
            }
            Some((guild, action)) = async { match ctl.act.as_mut() { Some(r) => r.recv().await, None => std::future::pending().await } } => {
                // asked for from the launcher (a panel posted from the dashboard)
                if let Ok(guild) = guild.parse::<Id<GuildMarker>>() { link.spawn(guild, action); }
                continue;
            }
            Some((guild, slot, what)) = heard.recv() => {
                // a song started, ended or failed, or the bot left voice
                let Some(guild) = Id::<GuildMarker>::new_checked(guild) else { continue };
                for action in link.bot.on_music(&guild.to_string(), slot, what, now_ms()) { link.spawn(guild, action); }
                continue;
            }
            next = shard.next_event(EventTypeFlags::all()) => match next {
                Some(e) => e,
                None if attempt + 1 < attempts.len() && !online && shard.state() == twilight_gateway::ShardState::FatallyClosed => {
                    attempt += 1;
                    shard = connect_shard(&token, attempts[attempt].0);
                    link.voice.set_gateway(shard.sender());
                    continue;
                }
                None if shard.state() == twilight_gateway::ShardState::FatallyClosed => return Err("Discord closed the connection and will not take this bot back. Check the token in Bot settings.".into()),
                None => break,
            },
        };
        let event = match event {
            Ok(e) => e,
            Err(e) => { (ctl.report)(Status::Hiccup(e.to_string())); continue; }
        };
        match event {
            Event::Ready(r) => {
                link.bot.directory.set_me(&r.user.id.to_string());
                // the bot owner's Twitch keys (live alerts), kept from before
                if let Ok(Some(k)) = link.bot.db.get().data_get("0", "integrations", "twitchKeys") {
                    if let (Some(id), Some(secret)) = (k["id"].as_str(), k["secret"].as_str()) { *feeds::TWITCH.lock().unwrap_or_else(|p| p.into_inner()) = (id.into(), secret.into(), String::new(), 0); }
                }
                link.bot.directory.set_reads_messages(attempts[attempt].0.contains(Intents::MESSAGE_CONTENT));
                (ctl.report)(Status::Online { name: r.user.name.clone(), servers: r.guilds.len() });
                if !online && !attempts[attempt].1.is_empty() {
                    (ctl.report)(Status::Notice(format!("{} Everything else works. Turn it on under Bot > Privileged Gateway Intents, then restart.", attempts[attempt].1.join(" "))));
                }
                if !online {
                    for (g, a) in link.bot.on_started(now_ms()) { if let Ok(g) = g.parse() { link.spawn(g, a); } }
                }
                online = true;
            }
            Event::MemberAdd(m) => {
                let who = Member { id: m.user.id.to_string(), name: m.nick.clone().or_else(|| m.user.global_name.clone()).unwrap_or_else(|| m.user.name.clone()), avatar: m.user.avatar.map(|h| format!("https://cdn.discordapp.com/avatars/{}/{h}.png?size=128", m.user.id)), roles: Vec::new(), bot: m.user.bot, perms: 0, joined_at: Some(m.joined_at.map(|t| t.as_micros() / 1000).unwrap_or_else(now_ms)) };
                link.member_roles.lock().unwrap_or_else(|p| p.into_inner()).insert(format!("{}:{}", m.guild_id, m.user.id), m.roles.iter().map(|r| r.to_string()).collect());
                if link.bot.tracks_invites(&m.guild_id.to_string()) && !who.bot { tokio::spawn(link.clone().invite_join(m.guild_id, who.clone())); }
                for action in link.bot.on_member(&m.guild_id.to_string(), &who, true) { link.spawn(m.guild_id, action); }
            }
            Event::BanAdd(b) => {
                link.bot.on_ban(&b.guild_id.to_string(), &b.user.id.to_string(), &b.user.global_name.clone().unwrap_or_else(|| b.user.name.clone()));
            }
            Event::MemberRemove(m) => {
                let roles = link.member_roles.lock().unwrap_or_else(|p| p.into_inner()).remove(&format!("{}:{}", m.guild_id, m.user.id)).unwrap_or_default();
                let who = Member { id: m.user.id.to_string(), name: m.user.global_name.clone().unwrap_or_else(|| m.user.name.clone()), avatar: None, roles, bot: m.user.bot, perms: 0, joined_at: None };
                for action in link.bot.on_member(&m.guild_id.to_string(), &who, false) { link.spawn(m.guild_id, action); }
            }
            Event::GuildUpdate(g) => {
                link.bot.directory.set_guild_facts(&g.id.to_string(), gb_core::bot::GuildFacts { boosts: g.premium_subscription_count.unwrap_or(0), tier: u8::from(g.premium_tier), icon: g.icon.map(|h| format!("https://cdn.discordapp.com/icons/{}/{h}.png?size=128", g.id)) });
            }
            Event::GuildCreate(g) => {
                if let twilight_model::gateway::payload::incoming::GuildCreate::Available(guild) = *g {
                    let gid = guild.id.to_string();
                    link.bot.on_server(&gid, &guild.name);
                    // the invites as they are now, so the first join can be told apart
                    if link.bot.tracks_invites(&gid) {
                        let (link, id) = (link.clone(), guild.id);
                        tokio::spawn(async move { if let Some(list) = link.read_invites(id).await { link.invites.lock().unwrap_or_else(|p| p.into_inner()).insert(id.get(), list); } });
                    }
                    link.bot.directory.set_channels(&gid, guild.channels.iter().map(named).collect());
                    if let Some(n) = guild.member_count { link.bot.directory.set_members(&gid, n); }
                    link.bot.directory.set_afk_channel(&gid, guild.afk_channel_id.map(|c| c.to_string()));
                    let everyone = guild.roles.iter().find(|r| r.id.get() == guild.id.get()).map(|r| r.permissions.bits()).unwrap_or(0);
                    link.bot.directory.set_powers(&gid, &guild.owner_id.to_string(), everyone, guild.roles.iter().map(|r| (r.id.to_string(), r.permissions.bits())).collect());
                    let facts = guild.roles.iter().map(|r| (r.id.to_string(), facts_of(r))).collect();
                    {
                        let mut known = link.member_roles.lock().unwrap_or_else(|p| p.into_inner());
                        for m in &guild.members { known.insert(format!("{}:{}", guild.id, m.user.id), m.roles.iter().map(|r| r.to_string()).collect()); }
                    }
                    // the first look at the server's members: names for the launcher, and the people to remember
                    let first_look: Vec<Member> = guild.members.iter().map(|m| Member { id: m.user.id.to_string(), name: m.nick.clone().or_else(|| m.user.global_name.clone()).unwrap_or_else(|| m.user.name.clone()),
                        avatar: m.user.avatar.map(|h| format!("https://cdn.discordapp.com/avatars/{}/{h}.png?size=128", m.user.id)), roles: m.roles.iter().map(|r| r.to_string()).collect(), bot: m.user.bot, perms: 0, joined_at: m.joined_at.map(|t| t.as_micros() / 1000) }).collect();
                    link.bot.roster_seed(&gid, &first_look);
                    let top = guild.members.iter().find(|m| m.user.id == link.me).map(|m| m.roles.iter().filter_map(|id| guild.roles.iter().find(|r| r.id == *id)).map(|r| r.position).max().unwrap_or(0));
                    link.bot.directory.set_role_facts(&gid, facts, top);
                    if let Some(m) = guild.members.iter().find(|m| m.user.id == link.me) { link.bot.directory.set_my_roles(&gid, m.roles.iter().map(|r| r.to_string()).collect()); }
                    link.bot.directory.set_guild_facts(&gid, gb_core::bot::GuildFacts { boosts: guild.premium_subscription_count.unwrap_or(0), tier: u8::from(guild.premium_tier), icon: guild.icon.map(|h| format!("https://cdn.discordapp.com/icons/{}/{h}.png?size=128", guild.id)) });
                    for v in &guild.voice_states {
                        if let Some(c) = v.channel_id {
                            let who = match &v.member { Some(m) => Member { id: m.user.id.to_string(), name: m.nick.clone().or_else(|| m.user.global_name.clone()).unwrap_or_else(|| m.user.name.clone()), avatar: None, roles: m.roles.iter().map(|r| r.to_string()).collect(), bot: m.user.bot, perms: 0, joined_at: None }, None => Member { id: v.user_id.to_string(), ..Default::default() } };
                            let category = link.places.lock().unwrap_or_else(|p| p.into_inner()).place(c).category;
                            link.bot.directory.set_voice_flags(&gid, gb_core::bot::VoiceFlags { member: who.clone(), muted: v.self_mute || v.mute, deaf: v.self_deaf || v.deaf, category });
                            link.bot.on_voice(&gid, &who, Some(&c.to_string()), true);
                        }
                    }
                    let mut roles: Vec<&twilight_model::guild::Role> = guild.roles.iter().filter(|r| r.id.get() != guild.id.get() && !r.managed).collect();
                    roles.sort_by_key(|r| std::cmp::Reverse(r.position));
                    link.bot.directory.set_roles(&gid, roles.into_iter().map(|r| Named { id: r.id.to_string(), name: r.name.clone(), kind: "", parent: String::new() }).collect());
                    let mut places = link.places.lock().unwrap_or_else(|p| p.into_inner());
                    for c in guild.channels.iter().chain(guild.threads.iter()) {
                        places.learn(c);
                    }
                }
            }
            Event::RoleCreate(r) => { link.bot.directory.set_role_power(&r.guild_id.to_string(), &r.role.id.to_string(), Some(r.role.permissions.bits())); link.bot.directory.put_role_facts(&r.guild_id.to_string(), &r.role.id.to_string(), Some(facts_of(&r.role))); }
            Event::RoleUpdate(r) => { link.bot.directory.set_role_power(&r.guild_id.to_string(), &r.role.id.to_string(), Some(r.role.permissions.bits())); link.bot.directory.put_role_facts(&r.guild_id.to_string(), &r.role.id.to_string(), Some(facts_of(&r.role))); }
            Event::RoleDelete(r) => { link.bot.directory.set_role_power(&r.guild_id.to_string(), &r.role_id.to_string(), None); link.bot.directory.put_role_facts(&r.guild_id.to_string(), &r.role_id.to_string(), None); }
            Event::MessageDelete(d) => {
                let Some(guild) = d.guild_id else { continue };
                for action in link.bot.on_messages_deleted(&guild.to_string(), &d.channel_id.to_string(), &[d.id.to_string()]) { link.spawn(guild, action); }
            }
            Event::MessageDeleteBulk(d) => {
                let Some(guild) = d.guild_id else { continue };
                let ids: Vec<String> = d.ids.iter().map(|i| i.to_string()).collect();
                for action in link.bot.on_messages_deleted(&guild.to_string(), &d.channel_id.to_string(), &ids) { link.spawn(guild, action); }
            }
            Event::MessageUpdate(m) => {
                let m = &m.0;
                let Some(guild) = m.guild_id else { continue };
                let author = member_from(&m.author, m.member.as_ref(), guild);
                let url = format!("https://discord.com/channels/{guild}/{}/{}", m.channel_id, m.id);
                let at = m.edited_timestamp.map(|t| t.as_micros() / 1000).unwrap_or_else(now_ms);
                if let Some(t) = m.embeds.first().and_then(|e| e.title.as_deref()) { link.bot.on_embed(&guild.to_string(), &m.channel_id.to_string(), &m.id.to_string(), t, m.embeds[0].url.as_deref()); }
                for action in link.bot.on_message_edited(&guild.to_string(), &m.channel_id.to_string(), &m.id.to_string(), &author, &m.content, &url, at) { link.spawn(guild, action); }
            }
            Event::MemberUpdate(m) => {
                let who = Member { id: m.user.id.to_string(), name: m.nick.clone().or_else(|| m.user.global_name.clone()).unwrap_or_else(|| m.user.name.clone()), avatar: None, roles: m.roles.iter().map(|r| r.to_string()).collect(), bot: m.user.bot, perms: 0, joined_at: None };
                link.member_roles.lock().unwrap_or_else(|p| p.into_inner()).insert(format!("{}:{}", m.guild_id, m.user.id), who.roles.clone());
                for action in link.bot.on_member_changed(&m.guild_id.to_string(), &who, m.nick.as_deref()) { link.spawn(m.guild_id, action); }
            }
            Event::GuildAuditLogEntryCreate(e) => {
                // anti-nuke (as in Good Boy 3): channel and role deletions, bans and kicks, counted per person
                use twilight_model::guild::audit_log::AuditLogEventType as A;
                let e = &e.0;
                let (Some(guild), Some(executor)) = (e.guild_id, e.user_id) else { continue };
                if !matches!(e.action_type, A::ChannelDelete | A::RoleDelete | A::MemberBanAdd | A::MemberKick) { continue; }
                let link = link.clone();
                tokio::spawn(async move {
                    let g = guild.to_string();
                    let roles: Vec<(String, u64, bool)> = match link.http.guild_member(guild, executor).await { Ok(r) => match r.model().await { Ok(m) => m.roles.iter().map(|r| {
                        let facts = link.bot.directory.role(&g, &r.to_string());
                        (r.to_string(), facts.as_ref().map(|f| f.perms).unwrap_or(0), facts.as_ref().is_some_and(|f| f.managed))
                    }).collect(), Err(_) => Vec::new() }, Err(_) => Vec::new() };
                    for action in link.bot.on_destructive(&g, &executor.to_string(), &roles, &link.me.to_string(), now_ms()) { link.spawn(guild, action); }
                });
            }
            Event::VoiceServerUpdate(v) => link.voice.on_server(v.guild_id, v.endpoint.as_deref(), &v.token),
            Event::VoiceStateUpdate(v) => {
                let v = &v.0;
                let Some(guild) = v.guild_id else { continue };
                if v.user_id == link.me {
                    link.voice.on_my_state(guild, v.channel_id, &v.session_id);
                    link.bot.directory.set_voice(&guild.to_string(), &v.user_id.to_string(), v.channel_id.map(|c| c.to_string()).as_deref());
                    continue;
                }
                let user = v.member.as_ref().map(|m| &m.user);
                let who = Member { id: v.user_id.to_string(), name: v.member.as_ref().and_then(|m| m.nick.clone()).or_else(|| user.and_then(|u| u.global_name.clone())).or_else(|| user.map(|u| u.name.clone())).unwrap_or_default(), bot: user.is_some_and(|u| u.bot), ..Default::default() };
                if let Some(c) = v.channel_id {
                    let category = link.places.lock().unwrap_or_else(|p| p.into_inner()).place(c).category;
                    let mut flagged = who.clone();
                    if let Some(m) = &v.member { flagged.roles = m.roles.iter().map(|r| r.to_string()).collect(); flagged.bot = m.user.bot; }
                    link.bot.directory.set_voice_flags(&guild.to_string(), gb_core::bot::VoiceFlags { member: flagged, muted: v.self_mute || v.mute, deaf: v.self_deaf || v.deaf, category });
                }
                for action in link.bot.on_voice(&guild.to_string(), &who, v.channel_id.map(|c| c.to_string()).as_deref(), false) { link.spawn(guild, action); }
            }
            Event::PresenceUpdate(p) => {
                let p = &p.0;
                let guild = p.guild_id;
                let user = match &p.user { twilight_model::gateway::presence::UserOrId::User(u) => (u.id, u.bot, u.global_name.clone().unwrap_or_else(|| u.name.clone())), twilight_model::gateway::presence::UserOrId::UserId { id } => (*id, false, String::new()) };
                if user.1 { continue; }
                let now: Vec<String> = p.activities.iter().filter(|a| a.kind == twilight_model::gateway::presence::ActivityType::Playing).map(|a| a.name.clone()).collect();
                let before = link.playing.lock().unwrap_or_else(|p| p.into_inner()).insert(format!("{guild}:{}", user.0), now.clone()).unwrap_or_default();
                let who = Member { id: user.0.to_string(), name: user.2, ..Default::default() };
                for action in link.bot.on_playing(&guild.to_string(), &who, &before, &now) { link.spawn(guild, action); }
                // for Eclipse ID: the games, and the kind of app they are using (a PC or a phone; Discord does not say more)
                let mut platforms: Vec<&str> = Vec::new();
                if p.client_status.desktop.is_some() { platforms.push("pc"); }
                if p.client_status.mobile.is_some() { platforms.push("mobile"); }
                platforms.sort_unstable();
                platforms.dedup();
                let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
                if !now.is_empty() { link.bot.eid_presence(&guild.to_string(), &who.id, &now, &platforms, at); }
            }
            Event::InviteCreate(inv) => {
                let mut all = link.invites.lock().unwrap_or_else(|p| p.into_inner());
                all.entry(inv.guild_id.get()).or_default().insert(inv.code.clone(), (inv.uses.into(), inv.inviter.as_ref().map(|u| u.id.to_string()), inv.max_uses));
            }
            Event::InviteDelete(inv) => {
                // kept a moment: a join may still need it
                let (link, guild, code) = (link.clone(), inv.guild_id.get(), inv.code.clone());
                tokio::spawn(async move { tokio::time::sleep(std::time::Duration::from_secs(3)).await; if let Some(m) = link.invites.lock().unwrap_or_else(|p| p.into_inner()).get_mut(&guild) { m.remove(&code); } });
            }
            Event::ReactionAdd(r) => {
                let Some(guild) = r.guild_id else { continue };
                if r.user_id == link.me || r.member.as_ref().is_some_and(|m| m.user.bot) { continue; }
                for action in link.bot.on_reaction_at(&guild.to_string(), &r.channel_id.to_string(), &r.message_id.to_string(), &reaction_key(&r.emoji), &r.user_id.to_string(), true) { link.spawn(guild, action); }
                // a little XP for reacting to someone else's message
                if let Some(m) = &r.member {
                    let who = Member { id: m.user.id.to_string(), name: m.nick.clone().or_else(|| m.user.global_name.clone()).unwrap_or_else(|| m.user.name.clone()), avatar: None, roles: m.roles.iter().map(|x| x.to_string()).collect(), bot: m.user.bot, perms: 0, joined_at: None };
                    let place = link.places.lock().unwrap_or_else(|p| p.into_inner()).place(r.channel_id);
                    let author = r.message_author_id.map(|a| a.to_string());
                    for action in link.bot.on_reaction_xp(&guild.to_string(), &who, author.as_deref(), &place, now_ms()) { link.spawn(guild, action); }
                }
            }
            Event::ReactionRemove(r) => {
                let Some(guild) = r.guild_id else { continue };
                if r.user_id == link.me { continue; }
                for action in link.bot.on_reaction_at(&guild.to_string(), &r.channel_id.to_string(), &r.message_id.to_string(), &reaction_key(&r.emoji), &r.user_id.to_string(), false) { link.spawn(guild, action); }
            }
            Event::ChannelCreate(c) => { link.places.lock().unwrap_or_else(|p| p.into_inner()).learn(&c); if let Some(g) = c.guild_id { link.bot.directory.put_channel(&g.to_string(), named(&c)); } }
            Event::ChannelUpdate(c) => { link.places.lock().unwrap_or_else(|p| p.into_inner()).learn(&c); if let Some(g) = c.guild_id { link.bot.directory.put_channel(&g.to_string(), named(&c)); } }
            Event::ChannelDelete(c) => { link.places.lock().unwrap_or_else(|p| p.into_inner()).forget(c.id); if let Some(g) = c.guild_id { link.bot.directory.drop_channel(&g.to_string(), &c.id.to_string()); for action in link.bot.on_channel_gone(&g.to_string(), &c.id.to_string()) { link.spawn(g, action); } } }
            Event::ThreadCreate(c) => link.places.lock().unwrap_or_else(|p| p.into_inner()).learn(&c),
            Event::ThreadUpdate(c) => link.places.lock().unwrap_or_else(|p| p.into_inner()).learn(&c),
            Event::ThreadDelete(t) => link.places.lock().unwrap_or_else(|p| p.into_inner()).forget(t.id),
            Event::MessageCreate(m) if m.guild_id.is_none() => {
                // a DM: modmail (Good Boy 3 sends it to the staff of the server the member shares with the bot)
                if m.author.bot { continue; }
                let who = Member { id: m.author.id.to_string(), name: m.author.global_name.clone().unwrap_or_else(|| m.author.name.clone()), avatar: m.author.avatar.map(|h| format!("https://cdn.discordapp.com/avatars/{}/{h}.png?size=128", m.author.id)), ..Default::default() };
                let dm: PendingDm = (who, m.content.clone(), m.attachments.iter().map(|a| (a.filename.clone(), a.url.clone(), a.size)).collect(), m.channel_id.to_string(), m.id.to_string(), m.timestamp.as_micros() / 1000);
                tokio::spawn(link.clone().modmail_dm(dm));
            }
            Event::MessageCreate(m) => {
                let Some(guild) = m.guild_id else { continue };
                let mut author = member_from(&m.author, m.member.as_ref(), guild);
                author.perms = link.bot.directory.power_of(&guild.to_string(), &author.id, &author.roles);
                if !author.roles.is_empty() { link.member_roles.lock().unwrap_or_else(|p| p.into_inner()).insert(format!("{guild}:{}", author.id), author.roles.clone()); }
                link.names.lock().unwrap_or_else(|p| p.into_inner()).learn(guild.get(), m.author.id.get(), &author.name);
                let ev = MessageEvent { guild: guild.to_string(), place: link.places.lock().unwrap_or_else(|p| p.into_inner()).place(m.channel_id), author, id: m.id.to_string(), text: if m.content.is_empty() { card_texts(&m.components).join("\n") } else { m.content.clone() }, mentions: m.mentions.len() + m.mention_roles.len(), mentioned: m.mentions.iter().map(|u| Member { id: u.id.to_string(), name: u.member.as_ref().and_then(|x| x.nick.clone()).unwrap_or_else(|| u.name.clone()), bot: u.bot, ..Default::default() }).collect(), files: m.attachments.iter().map(|a| (a.filename.clone(), a.url.clone(), a.size)).collect(), at_ms: m.timestamp.as_micros() / 1000 };
                // the rules run here, in order; talking to Discord happens on the side so one slow send holds nothing up
                let actions = link.bot.on_message(&ev, &mut |lo, hi| fastrand::i64(lo..=hi.max(lo)));
                for action in actions {
                    link.spawn(guild, action);
                }
                if let Some(e) = m.embeds.first() {
                    if let Some(t) = &e.title { link.bot.on_embed(&guild.to_string(), &m.channel_id.to_string(), &m.id.to_string(), t, e.url.as_deref()); }
                }
            }
            Event::InteractionCreate(i) => {
                let link = link.clone();
                tokio::spawn(async move { link.on_interaction(&i).await });
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use gb_core::{Area, ButtonStyle};

    fn file(name: &str) -> gb_core::CardFile { gb_core::CardFile { name: name.into(), data: std::sync::Arc::from(vec![1u8, 2, 3]) } }
    #[test]
    fn a_picture_does_not_keep_a_private_message_from_going_but_an_export_does() {
        let mut c = Card::new(Area::Games).line("hi").private();
        assert!(!keeps_files(&c));
        c.files.push(file("board.PNG"));
        c.files.push(file("round.gif"));
        assert!(!keeps_files(&c), "pictures do not count");
        c.files.push(file("transcript.txt"));
        assert!(keeps_files(&c), "an export or transcript stays");
    }
    #[test]
    fn only_private_game_windows_get_a_close_button() {
        let has_close = |c: &Card| serde_json::to_string(&components(&with_close(c)).unwrap()).unwrap().contains("gbclose");
        assert!(has_close(&Card::new(Area::Games).line("your hand").private()));
        assert!(!has_close(&Card::new(Area::Games).line("the table")), "a message everyone can see is not closed by one player");
        assert!(!has_close(&Card::new(Area::General).line("your balance").private()));
    }

    #[test]
    fn every_fishing_screen_a_new_player_meets_is_a_card_discord_accepts() {
        use gb_core::{Action, Bot, CommandEvent, Member, Place};
        let tmp = tempfile::tempdir().unwrap();
        let bot = Bot::new(gb_data::Store::create(tmp.path().join("eclipse.db")).unwrap());
        bot.on_server("700000000000000001", "Ghost Town");
        bot.db.get().set_module_enabled("700000000000000001", "money", true).unwrap();
        let kai = Member { id: "900000000000000001".into(), name: "Kai".into(), ..Default::default() };
        let ev = CommandEvent { guild: "700000000000000001".into(), place: Place::channel("800000000000000001"), member: kai, name: "fish".into(), at_ms: 1_800_000_000_000, ..Default::default() };
        let out = bot.on_command(&ev, &|_| None, &mut |lo, _| lo);
        let card = match out.first() { Some(Action::Reply { card }) | Some(Action::Send { card, .. }) => card.clone(), other => panic!("not a card: {other:?}") };
        if let Err(e) = components(&card) { panic!("the /fish screen cannot be sent: {e}"); }
    }
    #[test]
    fn the_cores_cards_are_layouts_discords_library_accepts() {
        let plain = Card::new(Area::General).title("XP leaderboard").line("🥇 Kai · level 12");
        let with_picture = Card::new(Area::Games).title("Kai reached level 12").line("Rank 4").picture(Some("https://cdn.discordapp.com/avatars/1/a.png".into())).bar(180, 1000, "XP to level 13").button("rank:1", "View rank", ButtonStyle::Plain);
        for card in [plain, with_picture.clone(), with_picture.clone().private()] {
            let parts = components(&card).unwrap();
            assert!(matches!(parts.as_slice(), [Component::Container(_)]), "one coloured container");
        }
        let Component::Container(c) = &components(&with_picture).unwrap()[0] else { unreachable!() };
        assert!(matches!(c.components[0], Component::Section(_)), "text with the picture beside it");
        assert!(matches!(c.components[1], Component::ActionRow(_)));
        assert_eq!(flags(&with_picture), MessageFlags::IS_COMPONENTS_V2);
        assert!(flags(&with_picture.private()).contains(MessageFlags::EPHEMERAL));
        // a card over Discord's limits is refused before anything is sent
        assert!(components(&Card::new(Area::General)).is_err());
    }
    #[test]
    fn the_bot_stays_inside_discords_command_limits() {
        // Discord allows 100 slash commands, and 5 right-click commands on members and 5 on messages: more and
        // the whole list is refused ("Could not register the commands")
        use twilight_model::application::command::CommandType as T;
        let list = commands();
        let count = |kind: T| list.iter().filter(|c| c.kind == kind).count();
        assert!(count(T::ChatInput) <= 100, "{} slash commands: fold some into groups", count(T::ChatInput));
        assert!(count(T::User) <= 5 && count(T::Message) <= 5, "{} member and {} message right-click commands", count(T::User), count(T::Message));
    }
    #[test]
    fn no_command_has_more_parts_than_discord_allows() {
        // Discord refuses a command with more than 25 sub-commands or groups, and a group with more than 25 parts
        for (i, c) in commands().iter().enumerate() {
            let v = serde_json::to_value(c).unwrap();
            let opts = v["options"].as_array().cloned().unwrap_or_default();
            assert!(opts.len() <= 25, "command {i} ({}) has {} parts", c.name, opts.len());
            for o in opts {
                assert!(o["options"].as_array().map_or(0, |a| a.len()) <= 25, "group {} of {} is too big", o["name"], c.name);
            }
        }
    }
    #[test]
    fn popup_labels_fit_what_discord_allows() {
        // a 49-letter label (the Add music box) made Discord refuse the whole popup: "the bot couldn't respond"
        let long = "A link, a station's name, or a song to search for";
        let (short, rest) = fit_label(long);
        assert!(short.chars().count() <= 45 && short.ends_with('…'), "{short}");
        assert_eq!(rest.as_deref(), Some(long));
        assert_eq!(fit_label("Where"), ("Where".to_string(), None));
        let field = gb_core::Field { id: "x".into(), label: "Inactive members: members who never sent a message are listed after this many days in the server".into(), ..Default::default() };
        let row = popup_field(&field);
        assert!(row["label"].as_str().unwrap().chars().count() <= 45 && row["description"].as_str().unwrap().chars().count() <= 100);
        // every popup the music player opens
        let music = gb_core::music::add_form_label();
        assert!(music.chars().count() <= 45, "{music}");
    }
    #[test]
    fn every_commands_popup_is_one_discord_accepts() {
        // each command's popup, and one with every kind of box, as the response Discord's library builds
        let mut forms = Vec::new();
        for spec in gb_core::bot::commands() {
            let subs: Vec<Option<&str>> = if spec.subs.is_empty() { vec![None] } else { spec.subs.iter().map(|s| Some(s.name)).collect() };
            for sub in subs {
                if gb_core::forms::leaf_options(spec, sub).is_empty() { continue; }
                if let Action::Form { id, title, fields } = gb_core::forms::popup(spec, sub, "1", 0, "-") { forms.push((id, title, fields)); }
            }
        }
        use gb_core::FieldKind as K;
        let every = [K::Text, K::Select(vec![("Yes".into(), "true".into())]), K::User { most: 1 }, K::Role { most: 3 }, K::Files { most: 10 }];
        forms.push(("x".into(), "Every kind".into(), every.into_iter().enumerate().map(|(k, kind)| gb_core::Field { id: format!("f{k}"), label: format!("Box {k}"), desc: Some("Help".into()), kind, required: k % 2 == 0, max: 100, ..Default::default() }).collect()));
        forms.push(("y".into(), "Channel".into(), vec![gb_core::Field { id: "c".into(), label: "Where".into(), kind: K::Channel(vec![0, 5]), value: Some("5".into()), ..Default::default() }]));
        assert!(forms.len() > 20);
        for (id, title, fields) in forms {
            let rows: Vec<serde_json::Value> = fields.iter().map(popup_field).collect();
            let r: Result<InteractionResponse, _> = serde_json::from_value(json!({ "type": 9, "data": { "custom_id": id, "title": title, "components": rows } }));
            let r = r.unwrap_or_else(|e| panic!("{title}: {e}"));
            let back = serde_json::to_value(&r).unwrap();
            assert_eq!(back["data"]["components"].as_array().unwrap().len(), fields.len(), "{title}");
            assert!(back["data"]["components"].as_array().unwrap().iter().all(|c| c["type"] == 18), "{title}: every box has its label");
        }
    }
    #[tokio::test]
    async fn cards_posted_in_channels_pass_discords_checks() {
        use twilight_http::request::TryIntoRequest as _;
        // the ticket panel: a title, text and eight buttons, posted in a channel
        let mut panel = Card::new(Area::General).title("Need help?").line("Press the button that fits your problem.");
        for (k, c) in gb_core::ticketrules::CATEGORIES.iter().enumerate() { panel = panel.button(format!("ticket:open:{k}"), format!("{} {}", c.1, c.2), ButtonStyle::Plain); }
        let parts = components(&panel).unwrap();
        let http = Client::new("not-a-real-token".into());
        let channel: Id<ChannelMarker> = Id::new(1);
        // the style has to be set before the card is attached, or the library checks it by the old rules and refuses it
        assert!(http.create_message(channel).flags(flags(&panel)).components(&parts).try_into_request().is_ok());
        assert!(http.create_message(channel).components(&parts).flags(flags(&panel)).try_into_request().is_err());
        assert!(http.interaction(Id::new(1)).create_followup("token").flags(flags(&panel.clone().private())).components(&parts).try_into_request().is_ok());
        // a card with a file (a transcript): the file is shown in the card and sent with it
        let with_file = Card::new(Area::General).title("Ticket #001 closed").line("Transcript attached.").file("ticket-001.txt", b"hello".to_vec());
        let parts = components(&with_file).unwrap();
        let Component::Container(c) = &parts[0] else { panic!() };
        assert!(c.components.iter().any(|x| matches!(x, Component::File(f) if f.file.url == "attachment://ticket-001.txt")));
        assert!(http.create_message(channel).flags(flags(&with_file)).components(&parts).attachments(&files_of(&with_file)).try_into_request().is_ok());
    }
    #[test]
    fn the_music_player_is_a_layout_discord_accepts() {
        let dir = std::env::temp_dir().join(format!("gb-player-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bot = Bot::new(gb_data::Store::create(dir.join("eclipse.db")).unwrap());
        let g = "700000000000000001";
        let music = gb_core::music::Music { db: &bot.db, settings: &bot.settings, dir: &bot.directory, players: &bot.players, slot: 0, guild: g };
        // empty, then playing with a cover picture, a long queue and every button
        components(&music.card(0)).unwrap();
        bot.players.with(g, |p| {
            let song = |n: usize| gb_core::music::Track { title: format!("Song number {n} with a fairly long title to fill the line"), artist: Some("Lo-Fi Ghost".into()), seconds: Some(187), source: "media".into(), page: Some("https://www.youtube.com/watch?v=abc".into()), site: Some("Youtube".into()), art: Some("https://i.ytimg.com/vi/abc/hqdefault.jpg".into()), by: "1".into(), uid: format!("u{n}"), ..Default::default() };
            p.now = Some(song(0));
            p.queue = (1..60).map(song).collect();
            p.started_ms = 0;
        });
        let parts = components(&music.card(60_000)).unwrap();
        let Component::Container(c) = &parts[0] else { panic!("one container") };
        let buttons: usize = c.components.iter().map(|x| if let Component::ActionRow(r) = x { r.components.len() } else { 0 }).sum();
        assert_eq!(buttons, 14, "back, pause, skip, stop, add, start mine, quieter, louder, repeat, shuffle, queue, playlists, lyrics, media links");
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn the_commands_are_ones_discord_accepts() {
        let list = commands();
        assert_eq!(list.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["rank", "leaderboard", "remind", "giveaway", "ticket", "achievements", "poll", "suggest", "starboard", "xp", "levels", "help", "music", "time", "money", "games", "mod", "community", "roles", "me", "social", "voice", "server", "View wallet", "Pay member", "Warn member", "Message stats", "Translate", "Quote Image", "Quote Image (Color)", "Report message"]);
        assert_eq!(list.iter().find(|c| c.name == "Warn member").map(|c| c.kind), Some(twilight_model::application::command::CommandType::User), "right-click a member > Apps > Warn member");
        assert_eq!(list.last().map(|c| c.kind), Some(twilight_model::application::command::CommandType::Message), "right-click a message > Apps > Translate");
        assert!(list[0].options.is_empty(), "/rank's member box is asked in its popup");
        // a group command has no parts to scroll: it opens a menu of what is inside
        for group in ["money", "games", "mod", "community", "roles", "me", "social", "voice", "server"] {
            let c = list.iter().find(|c| c.name == group).unwrap_or_else(|| panic!("/{group}"));
            assert!(c.options.is_empty(), "/{group} opens a menu, it has no parts");
        }
        // no typed boxes reach Discord: every command opens its popup instead (as in Good Boy 3)
        use twilight_model::application::command::CommandOptionType as K;
        let leaf = |o: &twilight_model::application::command::CommandOption| o.kind == K::SubCommand && o.options.as_ref().is_none_or(|x| x.is_empty());
        assert!(list.iter().all(|c| c.options.iter().all(|o| leaf(o) || (o.kind == K::SubCommandGroup && o.options.as_ref().is_some_and(|x| x.iter().all(leaf))))));
        // /ticket has its groups, as in Good Boy 3
        let ticket = list.iter().find(|c| c.name == "ticket").unwrap();
        assert!(ticket.options.iter().any(|o| o.name == "type" && o.kind == K::SubCommandGroup && o.options.as_ref().unwrap().iter().map(|x| x.name.as_str()).collect::<Vec<_>>() == ["add", "remove", "list"]));
        assert!(list.iter().all(|c| c.description.len() <= 100));
    }
    #[test]
    fn a_thread_counts_as_its_channel_and_category() {
        let mut p = Places::default();
        p.0.insert(10, (Some(1), false)); // channel 10 in category 1
        p.0.insert(20, (Some(10), true)); // thread 20 in channel 10
        assert_eq!(p.place(Id::new(10)), Place { channel: "10".into(), thread_of: None, category: Some("1".into()) });
        assert_eq!(p.place(Id::new(20)), Place { channel: "20".into(), thread_of: Some("10".into()), category: Some("1".into()) });
        assert_eq!(p.place(Id::new(99)), Place::channel("99"));
    }
}
