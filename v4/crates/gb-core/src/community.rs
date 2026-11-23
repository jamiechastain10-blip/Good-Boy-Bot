//! The rest of Good Boy 3's community module, next to levels.rs: XP for reactions and voice, the leaderboard (XP,
//! reputation or messages, in pages) and the live leaderboard message, reputation (`/rep`, with limits, an audit trail
//! and admin tools), `/xp` (set, ignore, boost), `/levels reward`, `/serverstats` and the member counter channel.
//! The same records, rules and wording as Good Boy 3.

use crate::bot::{CommandSpec, Directory, Opt, Sub, Takes};
use crate::levels::{self, MODULE};
use crate::perms::{self, Level, Perm};
use crate::store::Data;
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Member, Place, Settings};
use gb_data::community::Board;
use gb_data::level_of;
use serde_json::{json, Value};

pub const MANAGE: Perm = Perm { key: "community.manage", level: Level::Admin };
pub const REP_ADMIN: Perm = Perm { key: "community.rep-admin", level: Level::Admin };
const REP_RESET_MS: i64 = 60_000;
const DANGEROUS: u64 = (1 << 3) | (1 << 5) | (1 << 28) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 29) | (1 << 13) | (1 << 40) | (1 << 17);

const BOARDS: &[(&str, &str)] = &[("XP", "xp"), ("Reputation", "rep"), ("Messages", "messages")];
const WHO: Opt = Opt { name: "user", about: "Who", takes: Takes::Member, required: true };
const WHO_OR_YOU: Opt = Opt { name: "user", about: "Who (default: you)", takes: Takes::Member, required: false };
const REASON: Opt = Opt { name: "reason", about: "Why", takes: Takes::Text, required: false };
const KINDS: &[(&str, &str)] = &[("positive (+1)", "positive"), ("negative (-1)", "negative")];

pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec { name: "liveboard", about: "A leaderboard message that keeps itself up to date", module: MODULE, options: &[], subs: &[
        Sub { name: "setup", about: "Post it in a channel", options: &[Opt { name: "channel", about: "Where", takes: Takes::Channel, required: true }, Opt { name: "type", about: "What to rank", takes: Takes::Choice(BOARDS), required: false }] },
        Sub { name: "refresh", about: "Update it right now", options: &[] },
        Sub { name: "remove", about: "Turn it off and delete the message", options: &[] },
    ] },
    CommandSpec { name: "rep", about: "Reputation", module: MODULE, options: &[], subs: &[
        Sub { name: "give", about: "Give someone reputation", options: &[WHO, Opt { name: "type", about: "Positive (default) or negative", takes: Takes::Choice(KINDS), required: false }, REASON] },
        Sub { name: "check", about: "See someone's reputation", options: &[WHO_OR_YOU] },
        Sub { name: "view", about: "Same as check", options: &[WHO_OR_YOU] },
        Sub { name: "history", about: "Reputation changes (yours, or anyone's for admins)", options: &[Opt { name: "user", about: "Whose", takes: Takes::Member, required: false }, Opt { name: "limit", about: "How many (1-25)", takes: Takes::Whole { min: 1, max: 25 }, required: false }] },
        Sub { name: "remove", about: "(Admins) Take reputation away", options: &[WHO, Opt { name: "amount", about: "How much (default 1)", takes: Takes::Whole { min: 1, max: 1000 }, required: false }, REASON] },
        Sub { name: "set", about: "(Admins) Set an exact score (can be negative)", options: &[WHO, Opt { name: "value", about: "New score", takes: Takes::Whole { min: -100_000, max: 100_000 }, required: true }, REASON] },
        Sub { name: "reset", about: "(Admins) Reset one member to 0", options: &[WHO, REASON] },
        Sub { name: "reset-all", about: "(Admins) Reset EVERYONE to 0 (asks you to confirm)", options: &[] },
    ] },
    CommandSpec { name: "serverstats", about: "Statistics about this server", module: MODULE, options: &[], subs: &[] },
    CommandSpec { name: "xp", about: "Edit someone's XP", module: MODULE, options: &[], subs: &[
        Sub { name: "set", about: "Set total XP", options: &[WHO, Opt { name: "amount", about: "XP", takes: Takes::Whole { min: 0, max: 100_000_000 }, required: true }] },
        Sub { name: "reset", about: "Reset a member", options: &[WHO] },
        Sub { name: "ignore add", about: "No XP in a channel or a whole category", options: &[Opt { name: "channel", about: "A channel or a category", takes: Takes::AnyChannel, required: true }] },
        Sub { name: "ignore remove", about: "Give XP there again", options: &[Opt { name: "channel", about: "A channel or a category", takes: Takes::AnyChannel, required: true }] },
        Sub { name: "ignore list", about: "Where XP is switched off", options: &[] },
        Sub { name: "boost add", about: "Set a boost (e.g. 1.5 for Boosters)", options: &[Opt { name: "multiplier", about: "1.5 = 50% more XP, 2 = double, 0.5 = half", takes: Takes::Text, required: true }, Opt { name: "role", about: "A role (or pick a channel)", takes: Takes::Role, required: false }, Opt { name: "channel", about: "A channel or category (or pick a role)", takes: Takes::AnyChannel, required: false }] },
        Sub { name: "boost remove", about: "Remove a boost", options: &[Opt { name: "role", about: "The role", takes: Takes::Role, required: false }, Opt { name: "channel", about: "The channel or category", takes: Takes::AnyChannel, required: false }] },
        Sub { name: "boost list", about: "All XP boosts", options: &[] },
    ] },
    CommandSpec { name: "levels", about: "Level rewards", module: MODULE, options: &[], subs: &[
        Sub { name: "reward add", about: "Give a role at a level", options: &[Opt { name: "level", about: "Level", takes: Takes::Whole { min: 1, max: 200 }, required: true }, Opt { name: "role", about: "Role", takes: Takes::Role, required: true }] },
        Sub { name: "reward remove", about: "Remove a reward", options: &[Opt { name: "level", about: "Level", takes: Takes::Whole { min: 1, max: 200 }, required: true }] },
        Sub { name: "reward list", about: "Show rewards", options: &[] },
    ] },
];

fn private(text: impl Into<String>) -> Action {
    Action::Reply { card: Card::new(Area::General).line(text).private() }
}
fn stamp(ms: i64, style: &str) -> String {
    format!("<t:{}:{style}>", ms / 1000)
}
fn denied(perm: Perm) -> Action {
    private(format!("You don't have permission for that (`{}`).", perm.key))
}
fn fmt_rep(n: i64) -> String {
    if n > 0 { format!("+{n}") } else { n.to_string() }
}
fn cut(s: &str, n: usize) -> String {
    if s.chars().count() <= n { s.to_string() } else { format!("{}…", s.chars().take(n.saturating_sub(1)).collect::<String>()) }
}
fn boosted(n: i64, mult: f64) -> i64 {
    ((n as f64) * mult).round().max(0.0) as i64
}
fn day_of(ms: i64) -> String {
    crate::time::date(ms)
}
fn board_title(b: Board) -> String {
    format!("Leaderboard · {}", b.title())
}

pub struct Community<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub dir: &'a Directory,
    pub guild: &'a str,
}

impl Community<'_> {
    fn data(&self) -> Data<'_> {
        Data { db: self.db, guild: self.guild, module: MODULE }
    }
    fn boosts(&self) -> Value {
        self.data().get("xpBoosts").unwrap_or(Value::Null)
    }

    // ------------------------------------------------------------------ XP from reactions
    /// Reacting to someone else's message gives a little XP, at most once per cooldown. Your own message, bots and
    /// switched-off channels (and tickets) give nothing.
    pub fn on_reaction(&self, who: &Member, author: Option<&str>, place: &Place, now: i64) -> Vec<Action> {
        let g = self.guild;
        if !self.settings.bool(g, MODULE, "reactionXp") || who.bot || author == Some(who.id.as_str()) {
            return Vec::new();
        }
        if !levels::xp_allowed(self.db, self.settings, g, place) {
            return Vec::new();
        }
        let boost = levels::xp_boost(&self.boosts(), &who.roles, place);
        let amount = boosted(self.settings.int(g, MODULE, "reactionXpAmount"), boost);
        let cooldown = self.settings.int(g, MODULE, "reactionXpCooldownSeconds").max(1) * 1000;
        if amount <= 0 {
            return Vec::new();
        }
        let given = levels::grant(self.db, g, &who.id, |rec| {
            let last = rec.get("lastReactXp").and_then(Value::as_i64).unwrap_or(0);
            if now - last < cooldown {
                return None;
            }
            rec.insert("lastReactXp".into(), json!(now));
            let n = rec.get("reactions").and_then(Value::as_i64).unwrap_or(0) + 1;
            rec.insert("reactions".into(), json!(n));
            Some(amount)
        });
        match given {
            Some((before, after, total)) if after > before => levels::level_up(self.db, self.settings, g, who, &place.channel, after, total),
            _ => Vec::new(),
        }
    }

    // ------------------------------------------------------------------ XP from voice
    /// One minute of voice XP, when a minute has passed. Members in a voice channel (not the AFK one) with at least
    /// one other person who is not a bot and not deafened earn it. Deafened members never earn; muted members only
    /// when the server allows it. At most `voiceXpDailyMinutes` a day.
    pub fn voice_tick(&self, now: i64) -> Vec<Action> {
        let g = self.guild;
        if !self.settings.bool(g, MODULE, "voiceXp") {
            return Vec::new();
        }
        {
            let last = self.data().get("voiceTickAt").and_then(|v| v.as_i64()).unwrap_or(0);
            if now - last < 60_000 {
                return Vec::new();
            }
            self.data().set("voiceTickAt", &json!(now));
        }
        let per = self.settings.int(g, MODULE, "voiceXpPerMinute");
        let cap = self.settings.int(g, MODULE, "voiceXpDailyMinutes");
        if per <= 0 {
            return Vec::new();
        }
        let count_muted = self.settings.bool(g, MODULE, "voiceXpCountMuted");
        let off = self.settings.list(g, MODULE, "noXpChannels");
        let afk = self.dir.afk_channel(g);
        let boosts = self.boosts();
        let today = day_of(now);
        let mut out = Vec::new();
        for (channel, people) in self.dir.voice_rooms(g) {
            if afk.as_deref() == Some(channel.as_str()) || off.contains(&channel) {
                continue;
            }
            let here: Vec<&crate::bot::VoiceFlags> = people.iter().filter(|p| !p.member.bot && !p.deaf).collect();
            if here.first().is_some_and(|p| p.category.as_ref().is_some_and(|c| off.contains(c))) {
                continue;
            }
            if here.len() < 2 {
                continue; // alone (or only with bots / deafened people)
            }
            for p in here.into_iter().filter(|p| count_muted || !p.muted) {
                let place = Place { channel: channel.clone(), thread_of: None, category: p.category.clone() };
                let gain = boosted(per, levels::xp_boost(&boosts, &p.member.roles, &place));
                let given = levels::grant(self.db, g, &p.member.id, |rec| {
                    if rec.get("voiceDay").and_then(Value::as_str) != Some(today.as_str()) {
                        rec.insert("voiceDay".into(), json!(today));
                        rec.insert("voiceToday".into(), json!(0));
                    }
                    let spent = rec.get("voiceToday").and_then(Value::as_i64).unwrap_or(0);
                    if cap > 0 && spent >= cap {
                        return None; // reached today's limit
                    }
                    rec.insert("voiceToday".into(), json!(spent + 1));
                    let n = rec.get("voiceMinutes").and_then(Value::as_i64).unwrap_or(0) + 1;
                    rec.insert("voiceMinutes".into(), json!(n));
                    Some(gain)
                });
                if let Some((before, after, total)) = given {
                    if after > before {
                        out.extend(levels::level_up(self.db, self.settings, g, &p.member, &channel, after, total));
                    }
                }
            }
        }
        out
    }

    // ------------------------------------------------------------------ leaderboards
    /// One page of a board: the lines, how many pages there are, and its title.
    pub fn board_page(&self, board: Board, page: usize, size: usize) -> (usize, String, String) {
        let store = self.db.get();
        let len = store.level_board_len(self.guild, board).unwrap_or(0);
        let pages = len.div_ceil(size).max(1);
        let rows = store.level_board(self.guild, board, size, (page.max(1) - 1) * size).unwrap_or_default();
        drop(store);
        let medals = ["🥇", "🥈", "🥉"];
        let lines: Vec<String> = rows.iter().enumerate().map(|(n, (id, v))| {
            let idx = (page.max(1) - 1) * size + n;
            let val = match board {
                Board::Xp => format!("level {} · {v} XP", level_of(*v).level),
                Board::Rep => format!("{v} rep"),
                Board::Messages => format!("{v} messages"),
            };
            format!("{} <@{id}> - {val}", medals.get(idx).map(|m| m.to_string()).unwrap_or_else(|| format!("**{}.**", idx + 1)))
        }).collect();
        let text = if lines.is_empty() { "Nobody yet - start chatting!".to_string() } else { lines.join("\n") };
        (pages, text, board_title(board))
    }
    /// /leaderboard
    pub fn leaderboard(&self, ev: &CommandEvent) -> Action {
        let board = Board::parse(ev.args.get("type").map(String::as_str).unwrap_or("xp"));
        let page: usize = ev.args.get("page").and_then(|p| p.trim().parse().ok()).filter(|p| *p >= 1).unwrap_or(1);
        let (pages, text, title) = self.board_page(board, page, 10);
        if page > pages {
            return private(format!("There {} {}.", if pages == 1 { "is only" } else { "are only" }, if pages == 1 { "1 page".to_string() } else { format!("{pages} pages") }));
        }
        Action::Reply { card: Card::new(Area::General).title(title).line(text).line(format!("-# Page {page}/{pages}")) }
    }

    // ------------------------------------------------------------------ the live leaderboard
    fn live_size(&self) -> usize {
        (self.settings.int(self.guild, MODULE, "liveBoardSize").max(3) as usize).min(25)
    }
    fn live_board(&self) -> Board {
        Board::parse(&self.settings.text(self.guild, MODULE, "liveBoardType").unwrap_or_else(|| "xp".into()))
    }
    /// Post or refresh the live board. Returns the actions and what happened: off, posted, updated or same.
    pub fn refresh_live(&self, force: bool, now: i64) -> (Vec<Action>, &'static str) {
        let saved = self.data().get("liveboard").unwrap_or(Value::Null);
        let saved_msg = saved["messageId"].as_str().filter(|m| !m.is_empty()).map(str::to_string);
        let saved_ch = saved["channelId"].as_str().map(str::to_string);
        let Some(ch) = self.settings.text(self.guild, MODULE, "liveBoardChannel") else {
            let mut out = Vec::new();
            if let (Some(m), Some(c)) = (saved_msg, saved_ch) {
                out.push(Action::Delete { channel: c, message: m });
            }
            self.data().delete("liveboard");
            return (out, "off");
        };
        let board = self.live_board();
        let (_, text, title) = self.board_page(board, 1, self.live_size());
        let fingerprint = format!("{ch}|{}|{text}", board.id());
        let card = Card::new(Area::General).title(format!("{title} · live")).line(text).line(format!("-# Updates automatically · {}", stamp(now, "R")));
        let mut out = Vec::new();
        if saved_msg.is_some() && saved_ch.as_deref() != Some(ch.as_str()) {
            out.push(Action::Delete { channel: saved_ch.clone().unwrap_or_default(), message: saved_msg.clone().unwrap_or_default() });
        }
        match (&saved_msg, saved_ch.as_deref() == Some(ch.as_str())) {
            (Some(m), true) => {
                if !force && saved["fingerprint"].as_str() == Some(fingerprint.as_str()) {
                    self.data().set("liveboard", &json!({ "channelId": ch, "messageId": m, "fingerprint": fingerprint, "at": now }));
                    return (out, "same");
                }
                self.data().set("liveboard", &json!({ "channelId": ch, "messageId": m, "fingerprint": fingerprint, "at": now }));
                out.push(Action::EditOrPost { channel: ch, message: m.clone(), card, note: "liveboard".into() });
                (out, "updated")
            }
            _ => {
                // the message id comes back from `posted`
                self.data().set("liveboard", &json!({ "channelId": ch, "messageId": "", "fingerprint": fingerprint, "at": now }));
                out.push(Action::Post { channel: ch, card, note: "liveboard".into(), ping: Vec::new(), roles: Vec::new() });
                (out, "posted")
            }
        }
    }
    /// The live board's message was posted (or posted again): remember it.
    pub fn posted(&self, note: &str, message: &str) {
        if note != "liveboard" {
            return;
        }
        let mut saved = self.data().get("liveboard").unwrap_or(Value::Null);
        if let Some(o) = saved.as_object_mut() {
            o.insert("messageId".into(), json!(message));
            self.data().set("liveboard", &saved);
        }
    }
    fn liveboard_command(&self, ev: &CommandEvent) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, MANAGE) {
            return vec![private("You need the `community.manage` permission for that.")];
        }
        let sub = ev.sub.as_deref().unwrap_or("refresh");
        if sub == "setup" {
            let Some(ch) = ev.args.get("channel").filter(|c| !c.is_empty()) else { return vec![private("Pick a text channel.")] };
            let _ = self.settings.set(self.guild, MODULE, "liveBoardChannel", &json!(ch));
            if let Some(t) = ev.args.get("type").filter(|t| !t.is_empty()) {
                let _ = self.settings.set(self.guild, MODULE, "liveBoardType", &json!(t));
            }
        }
        if sub == "remove" {
            let _ = self.settings.set(self.guild, MODULE, "liveBoardChannel", &json!(""));
        }
        let (actions, status) = self.refresh_live(sub != "remove", ev.at_ms);
        let note = match status {
            "off" => "The live leaderboard is off.",
            "posted" => "Posted the live leaderboard.",
            "updated" => "Refreshed the live leaderboard.",
            _ => "It is already up to date.",
        };
        let mut out = vec![private(note)];
        out.extend(actions);
        out
    }

    // ------------------------------------------------------------------ reputation
    #[allow(clippy::too_many_arguments)]
    fn rep_log(&self, target: &str, actor: &str, delta: i64, balance: i64, kind: &str, reason: Option<&str>, now: i64) {
        let _ = self.db.get().rep_log(self.guild, target, actor, delta, balance, kind, reason, now);
    }
    fn rep_of(&self, user: &str) -> i64 {
        self.data().get(&format!("user:{user}")).and_then(|v| v["rep"].as_i64()).unwrap_or(0)
    }
    /// Adds `delta` to a member's reputation and writes it to the history. Gives the new score.
    fn change_rep(&self, target: &str, actor: &str, delta: i64, kind: &str, reason: Option<&str>, now: i64) -> i64 {
        let mut balance = 0;
        levels::grant(self.db, self.guild, target, |rec| {
            balance = rec.get("rep").and_then(Value::as_i64).unwrap_or(0) + delta;
            rec.insert("rep".into(), json!(balance));
            None
        });
        self.rep_log(target, actor, delta, balance, kind, reason, now);
        balance
    }
    fn set_rep(&self, target: &str, actor: &str, value: i64, kind: &str, reason: Option<&str>, now: i64) -> (i64, i64) {
        let mut before = 0;
        levels::grant(self.db, self.guild, target, |rec| {
            before = rec.get("rep").and_then(Value::as_i64).unwrap_or(0);
            rec.insert("rep".into(), json!(value));
            None
        });
        self.rep_log(target, actor, value - before, value, kind, reason, now);
        (before, value)
    }
    fn audit(&self, text: String) -> Option<Action> {
        let channel = self.settings.text(self.guild, MODULE, "repLogChannel")?;
        Some(Action::Send { channel, card: Card::new(Area::General).line(cut(&text, 1900)), ping: Vec::new(), roles: Vec::new() })
    }
    fn rep_command(&self, ev: &CommandEvent, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        let g = self.guild;
        let sub = ev.sub.as_deref().unwrap_or("check");
        let need_admin = || (!perms::allowed(self.db, g, &ev.member, REP_ADMIN)).then(|| private("You need the `community.rep-admin` permission for that."));
        let reason = ev.args.get("reason").map(|r| r.trim()).filter(|r| !r.is_empty()).map(|r| cut(r, 200));
        let now = ev.at_ms;
        match sub {
            "give" => self.rep_give(ev, reason.as_deref()),
            "check" | "view" => {
                let u = ev.target.as_ref().unwrap_or(&ev.member);
                vec![Action::Reply { card: Card::new(Area::General).line(format!("**{}** has **{}** reputation.", cut(&u.name, 40), fmt_rep(self.rep_of(&u.id)))) }]
            }
            "history" => {
                let u = ev.target.as_ref().unwrap_or(&ev.member);
                if u.id != ev.member.id {
                    if let Some(no) = need_admin() { return vec![no]; }
                }
                let limit = ev.args.get("limit").and_then(|l| l.trim().parse().ok()).unwrap_or(10usize).clamp(1, 25);
                let rows = self.db.get().rep_history(g, &u.id, limit).unwrap_or_default();
                let lines: Vec<String> = rows.iter().map(|r| format!("{} **{}** {} → {} by <@{}>{}", stamp(r.at, "R"), r.kind, fmt_rep(r.delta), fmt_rep(r.balance), r.actor, r.reason.as_ref().map(|x| format!(" - {}", cut(x, 80))).unwrap_or_default())).collect();
                vec![Action::Reply { card: Card::new(Area::General).title(format!("Reputation history · {}", cut(&u.name, 40))).line(if lines.is_empty() { "No reputation activity yet.".to_string() } else { lines.join("\n") }).private() }]
            }
            _ => {
                if let Some(no) = need_admin() { return vec![no]; }
                if sub == "reset-all" {
                    let affected = self.db.get().rep_nonzero(g).unwrap_or(0);
                    let token: String = (0..8).map(|_| format!("{:02x}", roll(0, 255))).collect();
                    self.data().set(&format!("repReset:{token}"), &json!({ "by": ev.member.id, "exp": now + REP_RESET_MS }));
                    return vec![Action::Reply { card: Card::new(Area::General)
                        .line(format!("⚠️ This sets **{affected}** member(s)' reputation to **0** for the whole server. A database backup is taken first, but this can't be undone from Discord. Confirm within 60 seconds."))
                        .button(format!("rep:resetall:{token}"), "Yes, reset everyone", ButtonStyle::Danger)
                        .button(format!("rep:cancel:{token}"), "Cancel", ButtonStyle::Plain).private() }];
                }
                let Some(target) = ev.target.as_ref() else { return vec![private("Pick a member.")] };
                if target.bot { return vec![private("Bots don't take part in reputation.")]; }
                let why = |s: &str| reason.as_ref().map(|r| format!("{s}{}", cut(r, 200))).unwrap_or_default();
                let mut out = Vec::new();
                match sub {
                    "remove" => {
                        let amount = ev.args.get("amount").and_then(|a| a.trim().parse().ok()).unwrap_or(1i64).clamp(1, 1000);
                        let balance = self.change_rep(&target.id, &ev.member.id, -amount, "remove", reason.as_deref(), now);
                        out.push(private(format!("Removed **{amount}** from <@{}>. They are now at **{}**.", target.id, fmt_rep(balance))));
                        out.extend(self.audit(format!("🛠️ <@{}> removed {amount} reputation from <@{}> (now {}){}", ev.member.id, target.id, fmt_rep(balance), why(": "))));
                    }
                    "set" => {
                        let Some(value) = ev.args.get("value").and_then(|v| v.trim().parse::<i64>().ok()).filter(|v| (-100_000..=100_000).contains(v)) else { return vec![private("The score must be a whole number between -100000 and 100000.")] };
                        let (before, after) = self.set_rep(&target.id, &ev.member.id, value, "set", reason.as_deref(), now);
                        out.push(private(format!("<@{}> went from **{}** to **{}**.", target.id, fmt_rep(before), fmt_rep(after))));
                        out.extend(self.audit(format!("🛠️ <@{}> set <@{}> from {} to {}{}", ev.member.id, target.id, fmt_rep(before), fmt_rep(after), why(": "))));
                    }
                    _ => {
                        let (before, _) = self.set_rep(&target.id, &ev.member.id, 0, "reset", reason.as_deref(), now);
                        out.push(private(format!("Reset <@{}> (was **{}**).", target.id, fmt_rep(before))));
                        out.extend(self.audit(format!("🛠️ <@{}> reset <@{}> (was {}){}", ev.member.id, target.id, fmt_rep(before), why(": "))));
                    }
                }
                out
            }
        }
    }
    fn rep_give(&self, ev: &CommandEvent, reason: Option<&str>) -> Vec<Action> {
        let g = self.guild;
        let no = |t: String| vec![private(t)];
        if !self.settings.bool(g, MODULE, "repEnabled") { return no("Reputation is turned off in this server.".into()); }
        let Some(target) = ev.target.as_ref() else { return no("Pick a member.".into()) };
        let negative = ev.args.get("type").map(String::as_str) == Some("negative");
        if negative && !self.settings.bool(g, MODULE, "repAllowNegative") { return no("Negative reputation is turned off in this server.".into()); }
        if target.bot { return no("Bots don't take part in reputation.".into()); }
        if target.id == ev.member.id { return no("You can't give reputation to yourself.".into()); }
        let now = ev.at_ms;
        let min_days = self.settings.int(g, MODULE, "repMinMemberDays");
        if min_days > 0 && ev.member.joined_at.is_some_and(|j| now - j < min_days * 86_400_000) {
            return no(format!("You need to have been in this server for {min_days} day(s) before giving reputation."));
        }
        let cooldown = self.settings.int(g, MODULE, "repCooldownHours") * 3_600_000;
        let last = self.data().get(&format!("user:{}", ev.member.id)).and_then(|v| v["lastRep"].as_i64()).unwrap_or(0);
        if now - last < cooldown { return no(format!("You can give reputation again {}.", stamp(last + cooldown, "R"))); }
        let (today, pair, negs) = {
            let store = self.db.get();
            (store.rep_gives_since(g, &ev.member.id, now - 86_400_000).unwrap_or(0), store.rep_pair_last(g, &ev.member.id, &target.id).ok().flatten(), store.rep_negs_since(g, &target.id, now - 86_400_000).unwrap_or(0))
        };
        let limit = self.settings.int(g, MODULE, "repDailyLimit");
        if today >= limit { return no(format!("You've reached today's limit of {limit} reputation gifts.")); }
        let pair_ms = self.settings.int(g, MODULE, "repPairCooldownHours") * 3_600_000;
        if let Some(t) = pair.filter(|t| now - t < pair_ms) {
            return no(format!("You already rated <@{}> recently. You can rate them again {}.", target.id, stamp(t + pair_ms, "R")));
        }
        if negative && negs >= self.settings.int(g, MODULE, "repNegativeDailyPerTarget") {
            let mut out = Vec::new();
            out.extend(self.audit(format!("⚠️ Possible reputation brigading: <@{}> has already received {negs} negative votes in 24h. Further negatives are blocked.", target.id)));
            out.insert(0, private("That member has received a lot of negative reputation today, so more are paused. A moderator can look into it."));
            return out;
        }
        let delta = if negative { -1 } else { 1 };
        let balance = self.change_rep(&target.id, &ev.member.id, delta, "give", reason, now);
        levels::grant(self.db, g, &ev.member.id, |rec| { rec.insert("lastRep".into(), json!(now)); None });
        let icon = if negative { "👎" } else { "⭐" };
        let why = reason.map(|r| format!(": {}", cut(r, 200))).unwrap_or_default();
        let mut card = Card::new(Area::General).line(format!("{icon} <@{}> gave <@{}> **{}** reputation{why} (now **{}**).", ev.member.id, target.id, if negative { "-1" } else { "+1" }, fmt_rep(balance)));
        card.ping = vec![target.id.clone()];
        let mut out = vec![Action::Reply { card }];
        out.extend(self.audit(format!("{icon} <@{}> gave <@{}> {}{why} (now {})", ev.member.id, target.id, if negative { "-1" } else { "+1" }, fmt_rep(balance))));
        out
    }
    /// The Yes / Cancel buttons of `/rep reset-all`.
    pub fn rep_button(&self, ev: &ButtonEvent, now: i64) -> Vec<Action> {
        let g = self.guild;
        let mut parts = ev.id.splitn(3, ':').skip(1);
        let (action, token) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        let key = format!("repReset:{token}");
        let pending = self.data().get(&key);
        let ok = pending.as_ref().is_some_and(|p| p["by"].as_str() == Some(ev.member.id.as_str()) && p["exp"].as_i64().unwrap_or(0) >= now);
        if !ok { return vec![private("That confirmation expired or belongs to someone else. Run `/rep reset-all` again.")]; }
        self.data().delete(&key);
        if action == "cancel" {
            return vec![Action::Update { card: Card::new(Area::General).line("Cancelled. Nothing was changed.") }];
        }
        if !perms::allowed(self.db, g, &ev.member, REP_ADMIN) {
            return vec![private("You need the `community.rep-admin` permission for that.")];
        }
        let store = self.db.get();
        let backups = store.path().parent().map(|p| p.join("backups"));
        let file = backups.as_ref().and_then(|dir| (1..).map(|n| dir.join(if n == 1 { format!("good-boy-before-rep-reset-all-{now}.db") } else { format!("good-boy-before-rep-reset-all-{now}-{n}.db") })).find(|f| !f.exists()));
        let made = match file { Some(f) => store.backup_to(&f).ok().map(|_| f), None => None };
        let affected = store.rep_reset_all(g, &ev.member.id, now).unwrap_or(0);
        drop(store);
        let saved = made.as_ref().and_then(|f| f.file_name()).map(|n| format!(" (`{}`)", n.to_string_lossy())).unwrap_or_default();
        let mut out = vec![Action::Update { card: Card::new(Area::General).line(format!("✅ Reset **{affected}** member(s) to 0. Backup saved{saved}.")) }];
        out.extend(self.audit(format!("🧹 <@{}> reset ALL reputation ({affected} members).", ev.member.id)));
        out
    }

    // ------------------------------------------------------------------ /xp and /levels
    fn channel_label(&self, id: &str) -> String {
        match self.dir.channels(self.guild).iter().find(|c| c.id == id) {
            Some(c) if c.kind == "category" => format!("📁 {}", c.name),
            _ => format!("<#{id}>"),
        }
    }
    fn is_category(&self, id: &str) -> bool {
        self.dir.channels(self.guild).iter().any(|c| c.id == id && c.kind == "category")
    }
    fn rewards_for(&self, who: &Member, level: u32) -> Option<Action> {
        let (add, remove) = levels::rewards(self.db, self.settings, self.guild, &who.roles, level)?;
        Some(Action::Roles { user: who.id.clone(), add, remove, reason: format!("Level {level} reward") })
    }
    fn xp_command(&self, ev: &CommandEvent) -> Vec<Action> {
        let g = self.guild;
        if !perms::allowed(self.db, g, &ev.member, MANAGE) { return vec![denied(MANAGE)]; }
        let sub = ev.sub.as_deref().unwrap_or("");
        match sub {
            "ignore list" => {
                let list = self.settings.list(g, MODULE, "noXpChannels");
                let channels = self.dir.channels(g);
                let lines: Vec<String> = list.iter().map(|id| match channels.iter().find(|c| &c.id == id) {
                    Some(c) if c.kind == "category" => format!("📁 {} (whole category)", c.name),
                    Some(_) => format!("<#{id}>"),
                    None if channels.is_empty() => format!("<#{id}>"),
                    None => format!("`{id}` (deleted)"),
                }).collect();
                vec![private(format!("**No XP in:**\n{}\n\nSupport tickets never give XP.", if lines.is_empty() { "Nowhere yet.".to_string() } else { lines.join("\n") }))]
            }
            "ignore add" | "ignore remove" => {
                let Some(ch) = ev.args.get("channel").filter(|c| !c.is_empty()).cloned() else { return vec![private("Pick a channel or a category.")] };
                let mut list = self.settings.list(g, MODULE, "noXpChannels");
                let add = sub == "ignore add";
                if add { if !list.contains(&ch) { list.push(ch.clone()); } } else { list.retain(|x| x != &ch); }
                if let Err(e) = self.settings.set(g, MODULE, "noXpChannels", &json!(list)) { return vec![private(e.to_string())]; }
                let what = if self.is_category(&ch) { format!("every channel in **{}**", self.dir.channels(g).iter().find(|c| c.id == ch).map(|c| c.name.clone()).unwrap_or_default()) } else { format!("<#{ch}>") };
                vec![private(if add { format!("🔕 No more XP or level-up messages in {what}.") } else { format!("🔔 {what} gives XP again.") })]
            }
            "boost list" | "boost add" | "boost remove" => self.boost_command(ev, sub),
            _ => {
                let Some(user) = ev.target.as_ref() else { return vec![private("Pick a member.")] };
                if user.bot { return vec![private("Bots have no XP.")]; }
                let amount: i64 = if sub == "set" { ev.args.get("amount").and_then(|a| a.trim().parse().ok()).unwrap_or(0).clamp(0, 100_000_000) } else { 0 };
                let _ = levels::grant(self.db, g, &user.id, |rec| { let old = rec.get("xp").and_then(Value::as_i64).unwrap_or(0); Some(amount - old) });
                let level = level_of(amount).level;
                let mut out = vec![private(format!("<@{}> is now level **{level}** ({amount} XP).", user.id))];
                out.extend(self.rewards_for(user, level));
                out
            }
        }
    }
    fn boost_command(&self, ev: &CommandEvent, sub: &str) -> Vec<Action> {
        let mut list: Vec<Value> = self.boosts().as_array().cloned().unwrap_or_default();
        let label = |b: &Value| if b["kind"] == "role" { format!("<@&{}>", b["id"].as_str().unwrap_or("")) } else { self.channel_label(b["id"].as_str().unwrap_or("")) };
        if sub == "boost list" {
            let lines: Vec<String> = list.iter().map(|b| format!("{} · **×{}**", label(b), b["mult"].as_f64().map(trim_num).unwrap_or_default())).collect();
            return vec![private(format!("**XP boosts**\n{}\n-# A member gets their best role boost, times the boost of the channel they're in.", if lines.is_empty() { "None yet. Add one with `/xp boost add`.".to_string() } else { lines.join("\n") }))];
        }
        let role = ev.args.get("role").filter(|r| !r.is_empty());
        let ch = ev.args.get("channel").filter(|c| !c.is_empty());
        if role.is_some() == ch.is_some() { return vec![private("Pick a role or a channel (one of them).")]; }
        let (kind, id) = if let Some(r) = role { ("role", r.clone()) } else { ("channel", ch.cloned().unwrap_or_default()) };
        let same = |b: &Value| b["kind"] == kind && b["id"].as_str() == Some(id.as_str());
        let had = list.len();
        list.retain(|b| !same(b));
        let what = label(&json!({ "kind": kind, "id": id }));
        if sub == "boost remove" {
            if list.len() == had { return vec![private("That has no boost.")]; }
            self.data().set("xpBoosts", &json!(list));
            return vec![private(format!("Removed the boost for {what}."))];
        }
        let raw = ev.args.get("multiplier").map(|m| m.trim().replace(',', ".")).unwrap_or_default();
        let mult = raw.parse::<f64>().ok().map(|m| (m * 100.0).round() / 100.0).filter(|m| *m >= 0.1 && *m <= 5.0);
        let Some(mult) = mult else { return vec![private("Use a multiplier from 0.1 to 5 (for example 1.5 for 50% more XP).")] };
        if list.len() >= 25 { return vec![private("You can have up to 25 boosts.")]; }
        list.push(json!({ "kind": kind, "id": id, "mult": mult }));
        self.data().set("xpBoosts", &json!(list));
        vec![private(format!("🚀 {what} now earns **×{}** XP.", trim_num(mult)))]
    }
    fn levels_command(&self, ev: &CommandEvent) -> Vec<Action> {
        let g = self.guild;
        if !perms::allowed(self.db, g, &ev.member, MANAGE) { return vec![denied(MANAGE)]; }
        let sub = ev.sub.as_deref().unwrap_or("");
        let key = |l: i64| format!("reward:{l:04}");
        if sub == "reward list" {
            let mut rows: Vec<(i64, String)> = self.data().list("reward:").into_iter().filter_map(|(k, v)| Some((k.get(7..)?.parse().ok()?, v.as_str()?.to_string()))).collect();
            rows.sort();
            let lines: Vec<String> = rows.iter().map(|(l, r)| format!("Level **{l}** → <@&{r}>")).collect();
            return vec![private(if lines.is_empty() { "No rewards yet.".to_string() } else { lines.join("\n") })];
        }
        let Some(level) = ev.args.get("level").and_then(|l| l.trim().parse::<i64>().ok()).filter(|l| (1..=200).contains(l)) else { return vec![private("The level must be a whole number from 1 to 200.")] };
        if sub == "reward remove" {
            self.data().delete(&key(level));
            return vec![private("Removed.")];
        }
        let Some(role) = ev.args.get("role").filter(|r| !r.is_empty()) else { return vec![private("Pick a role.")] };
        if role == g { return vec![private("That role can't be used.")]; }
        let Some(facts) = self.dir.role(g, role) else { return vec![private("That role can't be used.")] };
        if facts.managed { return vec![private("That role can't be used.")]; }
        if facts.perms & DANGEROUS != 0 { return vec![private("That role has powerful permissions - I won't hand it out automatically.")]; }
        if self.dir.my_top(g).is_some_and(|top| facts.position >= top) { return vec![private("Move my role above that role first.")]; }
        if self.dir.owner(g).as_deref() != Some(ev.member.id.as_str()) {
            let theirs = ev.member.roles.iter().filter_map(|r| self.dir.role(g, r)).map(|r| r.position).max().unwrap_or(0);
            if facts.position >= theirs { return vec![private("You can only reward roles below your own highest role.")]; }
        }
        self.data().set(&key(level), &json!(role));
        vec![private(format!("Reaching level **{level}** now grants **{}**.", facts.name))]
    }

    // ------------------------------------------------------------------ /serverstats and the member counter
    fn serverstats(&self, name: &str) -> Action {
        let g = self.guild;
        let facts = self.dir.guild_facts(g);
        let (total, top) = {
            let store = self.db.get();
            (store.messages_total(g).unwrap_or(0), store.level_board(g, Board::Messages, 3, 0).unwrap_or_default())
        };
        let created = g.parse::<i64>().map(|id| (id >> 22) + 1_420_070_400_000).unwrap_or(0);
        let channels = self.dir.channels(g).len();
        let roles = self.dir.role_count(g);
        let mut card = Card::new(Area::General).title(name.to_string()).picture(facts.icon.clone())
            .line(format!("**Members** {} · **Channels** {channels} · **Roles** {roles}", self.dir.members(g).map(|m| m.to_string()).unwrap_or_else(|| "—".into())))
            .line(format!("**Boosts** {} (tier {}) · **Created** {} · **Messages tracked** {}", facts.boosts, facts.tier, stamp(created, "D"), total));
        let most: Vec<String> = top.iter().enumerate().map(|(n, (id, c))| format!("{}. <@{id}> ({c})", n + 1)).collect();
        card = card.line(format!("**Most active**\n{}", if most.is_empty() { "—".to_string() } else { most.join("\n") }));
        Action::Reply { card }
    }
    /// The member counter channel (every ten minutes): `{count}`, `{humans}`, `{bots}` as in Good Boy 3.
    pub fn counter_due(&self, now: i64) -> Option<Action> {
        let g = self.guild;
        let ch = self.settings.text(g, MODULE, "statsChannel")?;
        let last = self.data().get("counterAt").and_then(|v| v.as_i64()).unwrap_or(0);
        if now - last < 600_000 { return None; }
        self.data().set("counterAt", &json!(now));
        let format = self.settings.text(g, MODULE, "statsFormat").unwrap_or_else(|| "Members: {count}".into());
        let template = format.replace("{count}", "{members}");
        Some(Action::Counters { items: vec![(ch, template)] })
    }

    // ------------------------------------------------------------------ commands
    pub fn command(&self, ev: &CommandEvent, name: &str, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        match ev.name.as_str() {
            "leaderboard" => vec![self.leaderboard(ev)],
            "liveboard" => self.liveboard_command(ev),
            "rep" => self.rep_command(ev, roll),
            "serverstats" => vec![self.serverstats(name)],
            "xp" => self.xp_command(ev),
            "levels" => self.levels_command(ev),
            _ => Vec::new(),
        }
    }
    /// Every minute: voice XP, the live board, the member counter.
    pub fn due(&self, now: i64) -> Vec<Action> {
        let mut out = self.voice_tick(now);
        if self.settings.text(self.guild, MODULE, "liveBoardChannel").is_some() || self.data().get("liveboard").is_some() {
            let saved = self.data().get("liveboard").unwrap_or(Value::Null);
            let gap = self.settings.int(self.guild, MODULE, "liveBoardMinutes").max(1) * 60_000;
            let same_channel = saved["channelId"].as_str() == self.settings.text(self.guild, MODULE, "liveBoardChannel").as_deref();
            let fresh = saved["at"].as_i64().is_some_and(|at| now - at < gap) && same_channel;
            if !fresh {
                out.extend(self.refresh_live(false, now).0);
            }
        }
        out.extend(self.counter_due(now));
        out
    }
}

/// 1.5 shown as "1.5", 2.0 as "2" (what JavaScript prints).
fn trim_num(n: f64) -> String {
    if n.fract() == 0.0 { format!("{}", n as i64) } else { format!("{n}") }
}
