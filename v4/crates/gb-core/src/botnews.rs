//! Good Boy 3's bot news: tells a server when the bot changes. The admin channel gets every update with its full
//! notes, new modules, and modules turned on or off; the announcements channel gets only what matters to members
//! (the members part of an update, and a short intro the first time a member feature is turned on). Member news can
//! go to the admin channel first as a draft to reword. Nothing is posted twice, and the very first run only
//! remembers where things are. The same settings, data keys and wording as Good Boy 3.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::store::Data;
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Def, Field, FormEvent, Kind, Settings};
use serde_json::json;

pub const MODULE: &str = "botnews";
pub const MANAGE: Perm = Perm { key: "botnews.manage", level: Level::Admin };
pub static SETTINGS: &[Def] = &[
    Def { key: "adminChannel", label: "Admin channel (full update notes, modules on/off)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "announceChannel", label: "Announcements channel (news for members only)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "pingRole", label: "Role to ping with member news (optional)", kind: Kind::Role, default: Fallback::None },
    Def { key: "adminUpdates", label: "Admin channel: post every update with its full notes", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "adminModules", label: "Admin channel: new modules and modules turned on/off", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "communityUpdates", label: "Announcements: what is new for members in each update", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "reviewAnnouncements", label: "Announcements: send each one to the admin channel first, to check and reword before it goes out", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "announceStyle", label: "Announcements look like", kind: Kind::Select(&["plain", "box"]), default: Fallback::Str("plain") },
    Def { key: "communityModules", label: "Announcements: introduce member features when first turned on", kind: Kind::Toggle, default: Fallback::Bool(true) },
];
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "botnews", about: "Bot news: where updates and new modules are posted", module: MODULE, options: &[], subs: &[
    Sub { name: "setup", about: "Choose the admin channel and the announcements channel", options: &[
        Opt { name: "admin_channel", about: "Staff channel: every update with full notes, module changes", takes: Takes::Channel, required: true },
        Opt { name: "announce_channel", about: "Everyone: only news for members", takes: Takes::Channel, required: true },
        Opt { name: "ping_role", about: "Role to ping with member news (optional)", takes: Takes::Role, required: false },
    ] },
    Sub { name: "test", about: "Post a test message to both channels", options: &[] },
] }];
/// The changes, newest first (this build's CHANGELOG.md).
pub const CHANGELOG: &str = include_str!("../../../CHANGELOG.md");
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Good Boy 3's member intros: (module, title, text), shown the first time a server turns the feature on.
pub const INTROS: &[(&str, &str, &str)] = &[
    ("clips", "clips channel", "there's a clips channel now. drop a video or a clip link in there and react on the ones you like. the best ones get reposted, and every monday the clip of the week wins some coins. /clips top shows the best ones so far"),
    ("counting", "counting", "there's a counting channel now. count up one at a time, and don't count twice in a row or the count starts over"),
    ("critters", "critters", "wild critters show up while we chat now 🐾 first to press Catch and type its name keeps it. /critters to see yours, pick a buddy, trade and battle"),
    ("deadchat", "dead chat pings", "when chat goes dead the bot can ping people who are down to talk, with a random question to get things going. if you want those pings hit the button on the dead chat message, hit it again whenever to stop"),
    ("economy", "coins are here", "everyone has a wallet now. do /daily every day for free coins (keep your streak going and you get more), /balance to see what you've got, /pay to send coins to someone, and /top to see who's richest"),
    ("family", "families", "you can marry people and adopt them now 💍 use /marry, then /family tree to see your whole family as a picture"),
    ("fun", "fun commands", "there's /fun now: ask the magic 8-ball, roll dice, ship two people, or get a topic when chat is quiet"),
    ("games", "games are open", "you can play games with your coins now. there's /slots (the jackpot keeps growing until someone hits it), /blackjack and /coinflip. there's also /fish, go catch stuff in different spots, find rare and giant fish, fill up your collection and get better rods"),
    ("giveaways", "giveaways", "giveaways are here 🎉 when one is posted just hit Enter to join, winners get picked at random when the timer ends"),
    ("modmail", "modmail", "need to talk to staff privately? just DM the bot and your message goes straight to them, their answers come back in your DMs"),
    ("roleplay", "roleplay actions", "you can hug, pat, boop and bonk each other now 🤗 use /rp, pick an action and a member. they can hit the button to do it back"),
];

/// CHANGELOG.md text → (version, body), in file order (Good Boy 3's parseChangelog).
pub fn sections(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, Vec<&str>)> = Vec::new();
    for raw in text.lines() {
        let t = raw.trim_end();
        if let Some(v) = t.strip_prefix("## ").map(str::trim).filter(|v| !v.is_empty() && !v.contains(' ')) { out.push((v.to_string(), Vec::new())); continue; }
        if let Some(cur) = out.last_mut() { cur.1.push(raw); }
    }
    out.into_iter().map(|(v, l)| (v, l.join("\n").trim().to_string())).collect()
}
/// The members part of a section (between the members markers), or None.
pub fn member_notes(body: &str) -> Option<String> {
    let low = body.to_lowercase();
    let a = low.find("<!-- members -->")? + "<!-- members -->".len();
    let b = low[a..].find("<!-- /members -->")? + a;
    Some(body[a..b].trim().to_string()).filter(|t| !t.is_empty())
}
/// A section for Discord: the markers taken out, bold lines as headings, shortened at a line (sectionForDiscord).
pub fn for_discord(body: &str, max: usize) -> String {
    let lines: Vec<String> = body.lines().filter(|l| { let t = l.trim().to_lowercase(); t != "<!-- members -->" && t != "<!-- /members -->" }).map(|l| {
        let t = l.trim();
        if t.len() > 4 && t.starts_with("**") && t.ends_with("**") { format!("__{t}__") } else { l.to_string() }
    }).collect();
    let all = lines.join("\n");
    if all.chars().count() <= max { return all; }
    let cut: String = all.chars().take(max).collect();
    format!("{}\n…\n*(Shortened. The full list is in CHANGELOG.md.)*", cut[..cut.rfind('\n').unwrap_or(cut.len())].trim_end())
}
/// Compares versions like semver: 4.0.0-dev.7 < 4.0.0-dev.10 < 4.0.0.
pub fn newer(a: &str, b: &str) -> std::cmp::Ordering {
    let key = |v: &str| {
        let (main, pre) = v.trim_start_matches('v').split_once('-').map(|(m, p)| (m, Some(p))).unwrap_or((v.trim_start_matches('v'), None));
        let nums: Vec<u64> = main.split('.').map(|x| x.parse().unwrap_or(0)).collect();
        let pre: Option<Vec<(u64, String)>> = pre.map(|p| p.split('.').map(|x| x.parse::<u64>().map(|n| (n, String::new())).unwrap_or((u64::MAX, x.to_string()))).collect());
        (nums, pre)
    };
    let ((an, ap), (bn, bp)) = (key(a), key(b));
    an.cmp(&bn).then_with(|| match (ap, bp) { (None, None) => std::cmp::Ordering::Equal, (None, Some(_)) => std::cmp::Ordering::Greater, (Some(_), None) => std::cmp::Ordering::Less, (Some(x), Some(y)) => x.cmp(&y) })
}
/// Splits text into Discord-sized messages, between paragraphs, then lines, then words (splitMessage).
pub fn split_message(text: &str, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest: String = text.trim().to_string();
    while rest.chars().count() > max {
        let head: String = rest.chars().take(max).collect();
        let cut = ["\n\n", "\n", " "].iter().filter_map(|s| head.rfind(s)).find(|n| *n > head.len() / 2).unwrap_or(head.len());
        out.push(rest[..cut].trim().to_string());
        rest = rest[cut..].trim().to_string();
    }
    if !rest.is_empty() { out.push(rest); }
    out
}

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
fn coloured(c: u32) -> Card {
    let mut card = Card::new(Area::General);
    card.accent = Some(c);
    card
}

pub struct BotNews<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub guild: &'a str,
}
impl BotNews<'_> {
    fn data(&self) -> Data<'_> {
        Data { db: self.db, guild: self.guild, module: MODULE }
    }
    fn channel(&self, k: &str) -> Option<String> {
        self.settings.text(self.guild, MODULE, k).filter(|c| !c.is_empty())
    }
    fn admin(&self, card: Card) -> Vec<Action> {
        self.channel("adminChannel").map(|c| vec![Action::Send { channel: c, card, ping: Vec::new(), roles: Vec::new() }]).unwrap_or_default()
    }
    /// Member news, as a plain message (in parts) or a card with a title, pinging the role if one is set.
    pub fn post_announcement(&self, text: &str, title: &str) -> Vec<Action> {
        let Some(channel) = self.channel("announceChannel") else { return Vec::new() };
        let role = self.settings.text(self.guild, MODULE, "pingRole").filter(|r| !r.is_empty());
        if self.settings.text(self.guild, MODULE, "announceStyle").as_deref() == Some("box") {
            let mut card = coloured(0xf2a93b).title(title).line(text.chars().take(3800).collect::<String>());
            if let Some(r) = &role { card = card.line(format!("<@&{r}>")); }
            return vec![Action::Send { channel, card, ping: Vec::new(), roles: role.into_iter().collect() }];
        }
        split_message(text, if role.is_some() { 1950 } else { 2000 }).into_iter().enumerate().map(|(n, part)| {
            let first = n == 0 && role.is_some();
            Action::SendText { channel: channel.clone(), text: if first { format!("<@&{}>\n{part}", role.as_deref().unwrap_or("")) } else { part }, ping: Vec::new(), roles: if first { role.clone().into_iter().collect() } else { Vec::new() }, video_from: None, note: None }
        }).collect()
    }
    /// A heads-up that the bot restarts soon (members' open private windows close when it does). Goes straight to the
    /// announcements channel, with no draft to review: it cannot wait.
    pub fn restart_notice(&self, minutes: u64) -> Vec<Action> {
        let when = if minutes <= 1 { "in a minute".to_string() } else { format!("in {minutes} minutes") };
        self.post_announcement(&format!("🔄 Good Boy is restarting {when} for an update. It is back a minute later. Private windows (games, forms) will close when it does, so finish what you are doing first; coins, levels and everything else are kept."), "Good Boy is restarting soon")
    }
    /// Member news goes to the admin channel first as a draft when reviewing is on (and there is one).
    pub fn announce(&self, id: &str, text: &str, title: &str, now: i64) -> Vec<Action> {
        if self.settings.bool(self.guild, MODULE, "reviewAnnouncements") && self.channel("adminChannel").is_some() {
            self.data().set(&format!("draft:{id}"), &json!({ "text": text, "title": title, "status": "waiting", "at": now }));
            return self.admin(coloured(0xf2a93b).title(format!("Draft for the announcements channel: {title}")).line(text.chars().take(3800).collect::<String>())
                .line("-# Nothing is posted until someone picks a button. Edit lets you say it in your own words.")
                .button_with(format!("botnews:edit:{id}"), "Edit & post", ButtonStyle::Primary, Some("✏️".into()))
                .button(format!("botnews:post:{id}"), "Post as it is", ButtonStyle::Plain)
                .button(format!("botnews:skip:{id}"), "Skip", ButtonStyle::Danger));
        }
        self.post_announcement(text, title)
    }
    /// The bot started: updates since this server last heard, then modules that are new (both quiet the first time).
    pub fn started(&self, version: &str, changelog: &str, modules: &[(&str, &str)], now: i64) -> Vec<Action> {
        let mut out = Vec::new();
        let d = self.data();
        match d.get("lastVersion").and_then(|v| v.as_str().map(str::to_string)) {
            None => d.set("lastVersion", &json!(version)),
            Some(last) if newer(version, &last).is_gt() => {
                d.set("lastVersion", &json!(version)); // before posting: a failed post must not repeat on every restart
                let mut news: Vec<(String, String)> = sections(changelog).into_iter().filter(|(v, _)| newer(v, &last).is_gt() && newer(v, version).is_le()).collect();
                news.sort_by(|a, b| newer(&a.0, &b.0));
                for (v, body) in news {
                    if self.settings.bool(self.guild, MODULE, "adminUpdates") {
                        out.extend(self.admin(coloured(0x5865f2).title(format!("🆙 Good Boy updated to {v}")).line(for_discord(&body, 3800)).line(format!("-# Updated from {last}"))));
                    }
                    if let Some(members) = member_notes(&body).filter(|_| self.settings.bool(self.guild, MODULE, "communityUpdates")) {
                        out.extend(self.announce(&format!("v{v}"), &members, &format!("What's new in Good Boy {v}"), now));
                    }
                }
            }
            _ => {}
        }
        let known: Option<Vec<String>> = d.get("knownModules").and_then(|v| serde_json::from_value(v).ok());
        d.set("knownModules", &json!(modules.iter().map(|m| m.0).collect::<Vec<_>>()));
        if let Some(known) = known.filter(|_| self.settings.bool(self.guild, MODULE, "adminModules")) {
            let fresh: Vec<&(&str, &str)> = modules.iter().filter(|m| !known.iter().any(|k| k == m.0)).collect();
            if !fresh.is_empty() {
                out.extend(self.admin(coloured(0x22c38e).title(if fresh.len() == 1 { "🧩 A new module is available".to_string() } else { format!("🧩 {} new modules are available", fresh.len()) })
                    .line(fresh.iter().map(|(n, about)| format!("**{n}** · {}", if about.is_empty() { "no description" } else { about })).collect::<Vec<_>>().join("\n"))
                    .line("-# Turn them on with /module or /modules.")));
            }
        }
        out
    }
    /// A module was turned on or off here.
    pub fn module_changed(&self, module: &str, enabled: bool, now: i64) -> Vec<Action> {
        if module == MODULE { return Vec::new(); }
        let mut out = Vec::new();
        if self.settings.bool(self.guild, MODULE, "adminModules") {
            out.extend(self.admin(coloured(if enabled { 0x22c38e } else { 0x8b97ab }).line(format!("{} **{module}** was turned {}.", if enabled { "🟢" } else { "⬜" }, if enabled { "on" } else { "off" }))));
        }
        // members hear about a feature once, the first time it is switched on
        if let Some((_, title, intro)) = INTROS.iter().find(|i| i.0 == module).filter(|_| enabled && self.settings.bool(self.guild, MODULE, "communityModules")) {
            let key = format!("introduced:{module}");
            if self.data().get(&key).is_none() {
                self.data().set(&key, &json!(now));
                out.extend(self.announce(&format!("m{module}"), intro, title, now));
            }
        }
        out
    }

    pub fn command(&self, ev: &CommandEvent) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private(format!("You don't have permission for that (`{}`).", MANAGE.key)); }
        if ev.sub.as_deref() == Some("test") {
            let (a, b) = (self.channel("adminChannel"), self.channel("announceChannel"));
            let mut out = private(format!("{} Admin channel · {} Announcements{}", if a.is_some() { "✅" } else { "❌" }, if b.is_some() { "✅" } else { "❌" }, if a.is_none() || b.is_none() { "\nPick the channels with `/botnews setup`, and check I can post there." } else { "" }));
            if let Some(c) = a { out.push(Action::SendText { channel: c, text: "🧪 Bot news test: full updates and module changes will be posted here.".into(), ping: Vec::new(), roles: Vec::new(), video_from: None, note: None }); }
            if let Some(c) = b { out.push(Action::SendText { channel: c, text: "🧪 Bot news test: news for members will be posted here.".into(), ping: Vec::new(), roles: Vec::new(), video_from: None, note: None }); }
            return out;
        }
        let arg = |k: &str| ev.args.get(k).filter(|v| !v.is_empty()).cloned();
        for (opt, key) in [("admin_channel", "adminChannel"), ("announce_channel", "announceChannel"), ("ping_role", "pingRole")] {
            if let Some(v) = arg(opt) { let _ = self.settings.set(self.guild, MODULE, key, &json!(v)); }
        }
        let (admin, ann, role) = (arg("admin_channel"), arg("announce_channel"), arg("ping_role"));
        private(format!("✅ Admin channel: {} · Announcements: {}{}\nChoose what gets posted with `/modules` → botnews → Edit settings. Try it with `/botnews test`.",
            admin.map(|c| format!("<#{c}>")).unwrap_or_else(|| "*not set*".into()), ann.map(|c| format!("<#{c}>")).unwrap_or_else(|| "*not set*".into()), role.map(|r| format!(" · pinging <@&{r}>")).unwrap_or_default()))
    }
    /// Edit & post, Post as it is, Skip on a draft.
    pub fn press(&self, ev: &ButtonEvent) -> Vec<Action> {
        let p: Vec<&str> = ev.id.splitn(3, ':').collect();
        let (what, id) = (p.get(1).copied().unwrap_or(""), p.get(2).copied().unwrap_or(""));
        if !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private("Only people who manage bot news can do that."); }
        let key = format!("draft:{id}");
        let Some(d) = self.data().get(&key) else { return private("That draft is gone.") };
        let status = d["status"].as_str().unwrap_or("").to_string();
        if status != "waiting" { return private(format!("That draft was already {status}.")); }
        if what == "edit" {
            return vec![Action::Form { id: format!("botnews:submit:{id}"), title: "Announcement".into(), fields: vec![Field { id: "text".into(), label: "Say it your way".into(), long: true, max: 4000, value: d["text"].as_str().map(|t| t.chars().take(4000).collect()), ..Default::default() }] }];
        }
        let mut done = d.clone();
        done["by"] = json!(ev.member.id);
        done["doneAt"] = json!(ev.at_ms);
        if what == "skip" {
            done["status"] = json!("skipped");
            self.data().set(&key, &done);
            return vec![Action::Update { card: Card::new(Area::General).line(format!("⏭️ Skipped by <@{}>.", ev.member.id)) }];
        }
        let posted = self.post_announcement(d["text"].as_str().unwrap_or(""), d["title"].as_str().unwrap_or(""));
        if posted.is_empty() { return private("I couldn't post in the announcements channel. Check that I can send messages there."); }
        done["status"] = json!("posted");
        self.data().set(&key, &done);
        let mut out = vec![Action::Update { card: Card::new(Area::General).line(format!("✅ Posted by <@{}>.", ev.member.id)) }];
        out.extend(posted);
        out
    }
    /// The reworded announcement from the Edit popup.
    pub fn form(&self, ev: &FormEvent) -> Vec<Action> {
        let id = ev.id.trim_start_matches("botnews:submit:");
        if !perms::allowed(self.db, self.guild, &ev.member, MANAGE) { return private("Only people who manage bot news can do that."); }
        let key = format!("draft:{id}");
        let Some(d) = self.data().get(&key) else { return private("That draft is gone.") };
        if d["status"].as_str() != Some("waiting") { return private(format!("That draft was already {}.", d["status"].as_str().unwrap_or(""))); }
        let text = ev.values.get("text").map(|t| t.trim().to_string()).unwrap_or_default();
        if text.is_empty() { return private("Write something to post."); }
        let posted = self.post_announcement(&text, d["title"].as_str().unwrap_or(""));
        if posted.is_empty() { return private("I couldn't post in the announcements channel. Check that I can send messages there."); }
        let mut done = d.clone();
        done["status"] = json!("posted");
        done["by"] = json!(ev.member.id);
        done["doneAt"] = json!(ev.at_ms);
        self.data().set(&key, &done);
        let mut out = private(format!("✅ Posted your version by <@{}>.", ev.member.id));
        out.extend(posted);
        out
    }
}
