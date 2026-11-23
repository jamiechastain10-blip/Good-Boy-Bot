//! Good Boy 3's clips channel that runs itself. A clip is an uploaded video, a pasted clip link (Medal, YouTube,
//! Twitch, Streamable, Outplayed, Allstar, TikTok) or Medal's own "@Member shared a clip" post (the member is
//! credited). Members vote with the vote emoji (the owner and bots don't count); enough votes reposts it in Best
//! clips once; every Monday last week's most-voted clip is announced and its owner gets coins; sharing earns a few
//! coins (a daily cap). Normal chat is left alone and message text is never stored, only the link, title and sharer.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::store::Data;
use crate::{Action, Area, Card, CommandEvent, Db, Def, Kind, MessageEvent, Settings};
use gb_data::clips::Clip;
use serde_json::json;

pub const MODULE: &str = "clips";
pub const VIEW: Perm = Perm { key: "clips.view", level: Level::Everyone };
pub const MANAGE: Perm = Perm { key: "clips.manage", level: Level::Admin };
pub static SETTINGS: &[Def] = &[
    Def { key: "clipsChannel", label: "Clips channel (where Medal and members post clips)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "bestChannel", label: "Best clips channel (top clips and clip of the week are reposted here)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "voteEmoji", label: "Vote emoji", kind: Kind::Text { max_len: 64 }, default: Fallback::Str("🔥") },
    Def { key: "bestVotes", label: "Votes needed for Best clips", kind: Kind::Number { min: 1, max: 100 }, default: Fallback::Int(5) },
    Def { key: "coinsPerClip", label: "Coins for sharing a clip (needs economy, 0 = off)", kind: Kind::Number { min: 0, max: 100_000 }, default: Fallback::Int(25) },
    Def { key: "rewardedClipsPerDay", label: "Clips per member per day that earn coins", kind: Kind::Number { min: 1, max: 50 }, default: Fallback::Int(3) },
    Def { key: "weeklyPrize", label: "Coins for clip of the week (needs economy, 0 = off)", kind: Kind::Number { min: 0, max: 10_000_000 }, default: Fallback::Int(1000) },
    Def { key: "pingWinner", label: "Ping the clip of the week winner", kind: Kind::Toggle, default: Fallback::Bool(true) },
];
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "clips", about: "Game clips: top clips and setup", module: MODULE, options: &[], subs: &[
    Sub { name: "top", about: "The most-voted clips", options: &[Opt { name: "period", about: "When", takes: Takes::Choice(&[("this week", "week"), ("this month", "month"), ("all time", "all")]), required: false }] },
    Sub { name: "setup", about: "Choose the clips channel, the Best clips channel and votes needed (staff)", options: &[
        Opt { name: "clips_channel", about: "Where Medal and members post clips", takes: Takes::Channel, required: true },
        Opt { name: "best_channel", about: "Where the top clips are reposted", takes: Takes::Channel, required: false },
        Opt { name: "votes_needed", about: "Votes needed for Best clips", takes: Takes::Whole { min: 1, max: 100 }, required: false },
    ] },
] }];
const HOSTS: &[&str] = &["medal.tv", "youtube.com/shorts", "youtube.com/watch", "youtu.be", "clips.twitch.tv", "twitch.tv/", "streamable.com", "outplayed.tv", "allstar.gg", "tiktok.com"];
const DAY: i64 = 86_400_000;
const ORANGE: u32 = 0xff7a45;

/// The first clip link in some text (Good Boy 3's findClipUrl).
pub fn find_clip_url(text: &str) -> Option<String> {
    let mut rest = text;
    while let Some(at) = rest.find("http") {
        let tail = &rest[at..];
        let end = tail.find(|c: char| c.is_whitespace() || "<>()".contains(c)).unwrap_or(tail.len());
        let url = &tail[..end];
        if url.starts_with("https://") || url.starts_with("http://") {
            let clean = url.trim_end_matches([')', '>', '.', ',', '!', '?']);
            let low = clean.to_lowercase();
            if HOSTS.iter().any(|h| low.contains(h)) { return Some(clean.to_string()); }
        }
        rest = &tail[end.max(4)..];
    }
    None
}
/// A video attached to a message: (name, address, size).
pub fn video_of(files: &[(String, String, u64)]) -> Option<&(String, String, u64)> {
    files.iter().find(|(name, _, _)| { let n = name.to_lowercase(); [".mp4", ".mov", ".webm", ".mkv", ".m4v"].iter().any(|e| n.ends_with(e)) })
}
/// Who a clip message belongs to, its link, title and how it came: None when the message isn't a clip.
/// (Webhooks post as bots, so only Medal's "shared a clip" posts count from them. Titles come later, `on_embed`.)
pub fn clip_from(ev: &MessageEvent) -> Option<(String, Option<String>, Option<String>, &'static str)> {
    if ev.author.bot {
        // Medal's bot: "<@123> shared a clip"
        if !ev.text.to_lowercase().contains("shared a clip") { return None; }
        let who = ev.mentioned.first().map(|m| m.id.clone()).or_else(|| {
            let at = ev.text.find("<@")?;
            let id: String = ev.text[at + 2..].trim_start_matches('!').chars().take_while(char::is_ascii_digit).collect();
            (17..=20).contains(&id.len()).then_some(id)
        })?;
        return Some((who, find_clip_url(&ev.text), None, "medal"));
    }
    if let Some(url) = find_clip_url(&ev.text) { return Some((ev.author.id.clone(), Some(url), None, "link")); }
    // an uploaded video (Steam, NVIDIA, AMD, Xbox Game Bar, OBS, a phone): Discord's file links expire, so only the name is kept
    video_of(&ev.files).map(|v| (ev.author.id.clone(), None, Some(v.0.clone()), "upload"))
}
/// The Monday a moment's week starts on, as days since 1970 (Good Boy 3's weekStartKey, UTC).
pub fn week_start(ms: i64) -> i64 {
    let day = ms.div_euclid(DAY);
    day - (day + 3).rem_euclid(7)
}
fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}
fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::Clips).line(text).private() }]
}

pub struct Clips<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub guild: &'a str,
    /// The economy is on (coins for clips).
    pub money: bool,
}
impl Clips<'_> {
    fn text(&self, k: &str) -> Option<String> {
        self.settings.text(self.guild, MODULE, k).filter(|v| !v.is_empty())
    }
    fn emoji(&self) -> String {
        self.text("voteEmoji").unwrap_or_else(|| "🔥".into())
    }
    fn line(&self, c: &Clip) -> String {
        format!("{} **{}** · clip by <@{}>{}", self.emoji(), c.votes, c.user, c.title.as_ref().map(|t| format!(" · {}", short(t, 120))).unwrap_or_default())
    }
    fn jump(&self, c: &Clip) -> String {
        format!("https://discord.com/channels/{}/{}/{}", self.guild, c.channel, c.message)
    }
    fn coins(&self, n: i64) -> String {
        crate::money::Money { db: self.db, settings: self.settings, guild: self.guild }.coins(n)
    }

    pub fn on_message(&self, ev: &MessageEvent) -> Vec<Action> {
        if self.text("clipsChannel").as_deref() != Some(ev.place.channel.as_str()) { return Vec::new(); }
        let Some((user, url, title, via)) = clip_from(ev) else { return Vec::new() };
        let clip = Clip { message: ev.id.clone(), channel: ev.place.channel.clone(), user: user.clone(), url, title: title.map(|t| short(&t, 200)), via: via.into(), at: ev.at_ms, ..Default::default() };
        if !self.db.get().clip_add(self.guild, &clip).unwrap_or(false) { return Vec::new(); }
        // a few coins per clip, at most N clips a day, so sharing is rewarded but spamming isn't
        let coins = self.settings.int(self.guild, MODULE, "coinsPerClip");
        if coins > 0 && self.money {
            let today = self.db.get().clips_since(self.guild, &user, ev.at_ms - DAY).unwrap_or(0);
            if today <= self.settings.int(self.guild, MODULE, "rewardedClipsPerDay") { let _ = self.db.get().credit(self.guild, &user, coins, "shared a clip"); }
        }
        vec![Action::React { channel: ev.place.channel.clone(), message: ev.id.clone(), emoji: self.emoji() }]
    }
    /// Discord found a link's title (and Medal's link) a moment after it was posted.
    pub fn on_embed(&self, channel: &str, message: &str, title: &str, url: Option<&str>) {
        if self.text("clipsChannel").as_deref() == Some(channel) { let _ = self.db.get().clip_title(self.guild, message, &short(title, 200), url); }
    }
    /// A reaction on a clip with the vote emoji: the Discord layer counts the voters.
    pub fn on_reaction(&self, message: &str, emoji: &str) -> Vec<Action> {
        let want = self.emoji();
        if !(want == emoji || (emoji.bytes().all(|b| b.is_ascii_digit()) && want.contains(emoji))) { return Vec::new(); }
        let Some(clip) = self.db.get().clip(self.guild, message).ok().flatten() else { return Vec::new() };
        vec![Action::CountVotes { channel: clip.channel, message: clip.message, emoji: want, skip: clip.user }]
    }
    /// The votes on a clip were counted: enough of them reposts it in Best clips, once.
    pub fn counted(&self, message: &str, votes: i64) -> Vec<Action> {
        let _ = self.db.get().clip_votes(self.guild, message, votes);
        let Some(clip) = self.db.get().clip(self.guild, message).ok().flatten() else { return Vec::new() };
        if votes < self.settings.int(self.guild, MODULE, "bestVotes") || clip.best.is_some() { return Vec::new(); }
        let Some(best) = self.text("bestChannel") else { return Vec::new() };
        // a link goes in the text so Discord shows the playable video; an uploaded file is uploaded again
        let text = format!("🏆 {} · [jump]({}){}", self.line(&clip), self.jump(&clip), clip.url.as_ref().map(|u| format!("\n{u}")).unwrap_or_default());
        vec![Action::SendText { channel: best, text, ping: Vec::new(), roles: Vec::new(), video_from: clip.url.is_none().then(|| (clip.channel.clone(), clip.message.clone())), note: Some(format!("clipbest:{}", clip.message)) }]
    }
    pub fn posted(&self, note: &str, message: &str) {
        if let Some(clip) = note.strip_prefix("clipbest:") { let _ = self.db.get().clip_best(self.guild, clip, message); }
    }
    /// Every Monday: last week's most-voted clip. The first run only starts the clock.
    pub fn weekly(&self, now: i64) -> Vec<Action> {
        let d = Data { db: self.db, guild: self.guild, module: MODULE };
        let week = week_start(now);
        let key = crate::time::date(week * DAY);
        let last = d.get("lastWeek").and_then(|v| v.as_str().map(str::to_string));
        d.set("lastWeek", &json!(key));
        if last.is_none() || last.as_deref() == Some(key.as_str()) { return Vec::new(); }
        let Some(top) = self.db.get().clip_of_week(self.guild, (week - 7) * DAY, week * DAY).ok().flatten() else { return Vec::new() };
        let prize = self.settings.int(self.guild, MODULE, "weeklyPrize");
        let paid = prize > 0 && self.money && self.db.get().credit(self.guild, &top.user, prize, "clip of the week").is_ok();
        let Some(channel) = self.text("bestChannel").or_else(|| self.text("clipsChannel")) else { return Vec::new() };
        let text = format!("🎬 **Clip of the week** goes to <@{}>!{}\n{} · [jump]({}){}", top.user, if paid { format!(" (+{})", self.coins(prize)) } else { String::new() }, self.line(&top), self.jump(&top), top.url.as_ref().map(|u| format!("\n{u}")).unwrap_or_default());
        let ping = if self.settings.bool(self.guild, MODULE, "pingWinner") { vec![top.user.clone()] } else { Vec::new() };
        vec![Action::SendText { channel, text, ping, roles: Vec::new(), video_from: None, note: None }]
    }

    pub fn command(&self, ev: &CommandEvent) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, VIEW) { return private(format!("You don't have permission for that (`{}`).", VIEW.key)); }
        if ev.sub.as_deref() == Some("setup") {
            if !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private("You don't have permission for that (`clips.manage`)."); }
            for (opt, key) in [("clips_channel", "clipsChannel"), ("best_channel", "bestChannel")] {
                if let Some(c) = ev.args.get(opt).filter(|c| !c.is_empty()) { let _ = self.settings.set(self.guild, MODULE, key, &json!(c)); }
            }
            if let Some(n) = ev.args.get("votes_needed").and_then(|v| v.parse::<i64>().ok()) { let _ = self.settings.set(self.guild, MODULE, "bestVotes", &json!(n.clamp(1, 100))); }
            let best = match self.text("bestChannel") { Some(b) => format!("Clips with **{}** {} votes go to <#{b}>.", self.settings.int(self.guild, MODULE, "bestVotes"), self.emoji()), None => "Pick a Best clips channel to repost the top ones.".into() };
            return private(format!("✅ Clips are watched in <#{}>. {best}\nMedal's **Send to Discord** button works: point MedalBot's Community Share at the same channel.", self.text("clipsChannel").unwrap_or_default()));
        }
        let period = ev.args.get("period").map(String::as_str).unwrap_or("week");
        let since = match period { "week" => ev.at_ms - 7 * DAY, "month" => ev.at_ms - 30 * DAY, _ => 0 };
        let words = match period { "week" => "this week", "month" => "this month", _ => "of all time" };
        let rows = self.db.get().clips_top(self.guild, since, 10).unwrap_or_default();
        let body = if rows.is_empty() { format!("No voted clips {words} yet. Share one in <#{}>!", self.text("clipsChannel").unwrap_or_default()) } else { rows.iter().enumerate().map(|(k, c)| format!("**{}.** {} · [watch]({})", k + 1, self.line(c), self.jump(c))).collect::<Vec<_>>().join("\n") };
        let mut card = Card::new(Area::Clips).title(format!("🎬 Top clips {words}")).line(body).private();
        card.accent = Some(ORANGE);
        vec![Action::Reply { card }]
    }
}
