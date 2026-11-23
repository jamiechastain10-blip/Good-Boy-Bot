//! Message proxying for plural systems, in the spirit of PluralKit: a person registers the members of their system
//! (a name, a picture, and proxy tags such as `k:` before or `[` `]` around a message). A message written with a
//! member's tags is replaced by the same message sent as that member, through a webhook. The original message is
//! only deleted once the new one is up.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::settings::Fallback;
use crate::store::Data;
use crate::{Action, Area, Card, CommandEvent, Db, Def, Kind, MessageEvent, Settings};
use serde::{Deserialize, Serialize};
use serde_json::json;

pub const MODULE: &str = "plural";
const MAX_NAME: usize = 80;

pub static SETTINGS: &[Def] = &[
    Def { key: "channels", label: "Only proxy in these channels (IDs; empty means everywhere)", kind: Kind::List, default: Fallback::None },
    Def { key: "deleteOriginal", label: "Delete the original message once the proxied one is up", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "maxMembers", label: "Most members one system may have", kind: Kind::Number { min: 1, max: 500 }, default: Fallback::Int(100) },
];
const NAME: Opt = Opt { name: "member", about: "The member's name", takes: Takes::Text, required: true };
const PREFIX: Opt = Opt { name: "prefix", about: "Text before a message that proxies as them, such as k:", takes: Takes::Text, required: false };
const SUFFIX: Opt = Opt { name: "suffix", about: "Text after a message that proxies as them", takes: Takes::Text, required: false };
const AVATAR: Opt = Opt { name: "avatar", about: "A picture link (https://...)", takes: Takes::Text, required: false };
const PRONOUNS: Opt = Opt { name: "pronouns", about: "Their pronouns", takes: Takes::Text, required: false };
const ABOUT: Opt = Opt { name: "description", about: "A short description", takes: Takes::Text, required: false };
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "plural", about: "Proxy messages as the members of your system", module: MODULE, options: &[], subs: &[
    Sub { name: "add", about: "Add a member to your system", options: &[NAME, PREFIX, SUFFIX, AVATAR, PRONOUNS] },
    Sub { name: "edit", about: "Change a member (a dash clears a box)", options: &[NAME,
        Opt { name: "new_name", about: "A new name", takes: Takes::Text, required: false }, PREFIX, SUFFIX, AVATAR, PRONOUNS, ABOUT] },
    Sub { name: "remove", about: "Remove a member", options: &[NAME] },
    Sub { name: "list", about: "Your system's members", options: &[] },
    Sub { name: "show", about: "One member", options: &[NAME] },
    Sub { name: "system", about: "Name your system", options: &[Opt { name: "name", about: "Your system's name", takes: Takes::Text, required: true }] },
    Sub { name: "proxy", about: "Turn proxying on or off for you", options: &[Opt { name: "mode", about: "On or off", takes: Takes::Choice(&[("On", "on"), ("Off", "off")]), required: true }] },
    Sub { name: "autoproxy", about: "Send everything as one member, or as whoever spoke last", options: &[Opt { name: "mode", about: "off, latch, or a member's name", takes: Takes::Text, required: true }] },
    Sub { name: "who", about: "Who sent a proxied message", options: &[Opt { name: "message", about: "The message's ID", takes: Takes::Text, required: true }] },
] }];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Alter {
    pub name: String,
    pub prefix: String,
    pub suffix: String,
    pub avatar: String,
    pub pronouns: String,
    pub description: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct System {
    pub name: String,
    pub members: Vec<Alter>,
    pub proxy: bool,
    /// "off", "latch", or a member's name.
    pub auto: String,
    pub last: Option<String>,
}
impl Default for System {
    fn default() -> Self { System { name: String::new(), members: Vec::new(), proxy: true, auto: "off".into(), last: None } }
}

/// Which member's tags this message uses, and the message without them. The longest matching tags win.
pub fn match_tags<'a>(members: &'a [Alter], text: &str) -> Option<(&'a Alter, String)> {
    let t = text.trim();
    let lower = t.to_lowercase();
    let mut best: Option<(&Alter, String, usize)> = None;
    for m in members {
        if m.prefix.is_empty() && m.suffix.is_empty() { continue; }
        let (p, s) = (m.prefix.to_lowercase(), m.suffix.to_lowercase());
        if lower.len() < p.len() + s.len() || !lower.starts_with(&p) || !lower.ends_with(&s) { continue; }
        let inner = t.get(p.len()..t.len() - s.len()).unwrap_or("").trim().to_string();
        if inner.is_empty() { continue; }
        let weight = p.len() + s.len();
        if best.as_ref().is_none_or(|b| weight > b.2) { best = Some((m, inner, weight)); }
    }
    best.map(|(m, text, _)| (m, text))
}
fn clean(s: &str, max: usize) -> String { s.trim().chars().filter(|c| !c.is_control()).take(max).collect() }
fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
/// Discord refuses these in a webhook's name.
fn name_problem(name: &str) -> Option<&'static str> {
    let l = name.to_lowercase();
    if name.is_empty() { Some("Give the member a name.") } else if l.contains("clyde") || l.contains("discord") || l.contains("everyone") || l.contains("here") && l.trim() == "here" { Some("Discord does not allow that name for a proxied message (it can't contain \"discord\", \"clyde\" or \"everyone\").") } else { None }
}

pub struct Plural<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub guild: &'a str,
}
impl Plural<'_> {
    fn data(&self) -> Data<'_> { Data { db: self.db, guild: self.guild, module: MODULE } }
    pub fn system(&self, user: &str) -> System {
        self.data().get(&format!("sys:{user}")).and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
    }
    fn save(&self, user: &str, s: &System) { self.data().set(&format!("sys:{user}"), &json!(s)); }
    fn find(s: &System, name: &str) -> Option<usize> {
        let n = name.trim().to_lowercase();
        s.members.iter().position(|m| m.name.to_lowercase() == n)
    }
    pub fn command(&self, ev: &CommandEvent) -> Vec<Action> {
        let arg = |k: &str| ev.args.get(k).map(|v| v.trim().to_string());
        let me = &ev.member.id;
        let mut sys = self.system(me);
        match ev.sub.as_deref().unwrap_or("list") {
            "add" => {
                let name = clean(&arg("member").unwrap_or_default(), MAX_NAME);
                if let Some(p) = name_problem(&name) { return private(p); }
                if Self::find(&sys, &name).is_some() { return private("You already have a member with that name."); }
                if sys.members.len() as i64 >= self.settings.int(self.guild, MODULE, "maxMembers") { return private("Your system is full."); }
                let avatar = arg("avatar").unwrap_or_default();
                if !avatar.is_empty() && !(avatar.starts_with("https://") && avatar.len() <= 500 && !avatar.contains(char::is_whitespace)) { return private("A picture must be an https link."); }
                let alter = Alter { name: name.clone(), prefix: arg("prefix").unwrap_or_default(), suffix: arg("suffix").unwrap_or_default(), avatar, pronouns: clean(&arg("pronouns").unwrap_or_default(), 40), description: String::new() };
                let tags = if alter.prefix.is_empty() && alter.suffix.is_empty() { "no tags yet: add some with `/plural edit`".to_string() } else { format!("tags: `{}text{}`", alter.prefix, alter.suffix) };
                sys.members.push(alter);
                self.save(me, &sys);
                private(format!("🧩 Added **{name}** ({tags}). Messages that use their tags are sent as them."))
            }
            "edit" => {
                let Some(at) = Self::find(&sys, &arg("member").unwrap_or_default()) else { return private("You don't have a member with that name. See `/plural list`.") };
                // a value of "-" clears a box; an empty one leaves it alone
                let pick = |k: &str, old: &str| match arg(k) { Some(v) if v == "-" => String::new(), Some(v) if !v.is_empty() => v, _ => old.to_string() };
                let avatar = pick("avatar", &sys.members[at].avatar);
                if !avatar.is_empty() && !(avatar.starts_with("https://") && avatar.len() <= 500 && !avatar.contains(char::is_whitespace)) { return private("A picture must be an https link."); }
                let new_name = clean(&arg("new_name").filter(|n| !n.is_empty()).unwrap_or_else(|| sys.members[at].name.clone()), MAX_NAME);
                if let Some(p) = name_problem(&new_name) { return private(p); }
                if sys.members.iter().enumerate().any(|(k, m)| k != at && m.name.to_lowercase() == new_name.to_lowercase()) { return private("You already have a member with that name."); }
                let old = sys.members[at].clone();
                sys.members[at] = Alter { name: new_name.clone(), prefix: pick("prefix", &old.prefix), suffix: pick("suffix", &old.suffix), avatar, pronouns: clean(&pick("pronouns", &old.pronouns), 40), description: clean(&pick("description", &old.description), 300) };
                if sys.auto.to_lowercase() == old.name.to_lowercase() { sys.auto = new_name.clone(); }
                self.save(me, &sys);
                private(format!("🧩 Saved **{new_name}**."))
            }
            "remove" => {
                let Some(at) = Self::find(&sys, &arg("member").unwrap_or_default()) else { return private("You don't have a member with that name.") };
                let gone = sys.members.remove(at);
                if sys.auto.to_lowercase() == gone.name.to_lowercase() { sys.auto = "off".into(); }
                self.save(me, &sys);
                private(format!("Removed **{}**.", gone.name))
            }
            "show" => {
                let Some(at) = Self::find(&sys, &arg("member").unwrap_or_default()) else { return private("You don't have a member with that name.") };
                let m = &sys.members[at];
                let mut card = Card::new(Area::General).title(m.name.clone());
                if !m.avatar.is_empty() { card = card.picture(Some(m.avatar.clone())); }
                card = card.line(format!("Tags: {}", if m.prefix.is_empty() && m.suffix.is_empty() { "none".to_string() } else { format!("`{}text{}`", m.prefix, m.suffix) }));
                if !m.pronouns.is_empty() { card = card.line(format!("Pronouns: {}", m.pronouns)); }
                if !m.description.is_empty() { card = card.line(m.description.clone()); }
                vec![Action::Reply { card: card.private() }]
            }
            "system" => { sys.name = clean(&arg("name").unwrap_or_default(), 80); self.save(me, &sys); private(format!("Your system is now called **{}**.", sys.name)) }
            "proxy" => { sys.proxy = arg("mode").as_deref() != Some("off"); self.save(me, &sys); private(if sys.proxy { "Proxying is on." } else { "Proxying is off: your messages are left alone." }) }
            "autoproxy" => {
                let mode = arg("mode").unwrap_or_default();
                let l = mode.to_lowercase();
                if l == "off" || l == "latch" { sys.auto = l.clone(); }
                else if let Some(at) = Self::find(&sys, &mode) { sys.auto = sys.members[at].name.clone(); }
                else { return private("Say `off`, `latch`, or the name of one of your members."); }
                self.save(me, &sys);
                private(match sys.auto.as_str() { "off" => "Autoproxy is off: only messages with tags are proxied.".to_string(), "latch" => "Autoproxy: whoever you last spoke as keeps speaking.".to_string(), n => format!("Autoproxy: everything you write is sent as **{n}**.") })
            }
            "who" => {
                let id = arg("message").unwrap_or_default().rsplit('/').next().unwrap_or("").to_string();
                match self.data().get(&format!("msg:{id}")) {
                    Some(v) => private(format!("That was sent by <@{}> as **{}**.", v["user"].as_str().unwrap_or("?"), v["member"].as_str().unwrap_or("?"))),
                    None => private("I don't know that message (only recent proxied ones are remembered)."),
                }
            }
            _ => {
                if sys.members.is_empty() { return private("Your system has no members yet. Add one with `/plural add`."); }
                let mut card = Card::new(Area::General).title(if sys.name.is_empty() { "Your system".to_string() } else { sys.name.clone() });
                for m in &sys.members { card = card.line(format!("**{}**{} · {}", m.name, if m.pronouns.is_empty() { String::new() } else { format!(" ({})", m.pronouns) }, if m.prefix.is_empty() && m.suffix.is_empty() { "no tags".to_string() } else { format!("`{}text{}`", m.prefix, m.suffix) })); }
                vec![Action::Reply { card: card.line(format!("-# Proxying is {}. Autoproxy: {}.", if sys.proxy { "on" } else { "off" }, sys.auto)).private() }]
            }
        }
    }
    /// A message: when it uses a member's tags (or autoproxy is on), it is sent again as that member.
    pub fn on_message(&self, ev: &MessageEvent) -> Vec<Action> {
        if ev.author.bot || ev.text.trim().is_empty() && ev.files.is_empty() { return Vec::new(); }
        let only = self.settings.list(self.guild, MODULE, "channels");
        if !only.is_empty() && !only.iter().any(|c| *c == ev.place.channel || Some(c.as_str()) == ev.place.thread_of.as_deref()) { return Vec::new(); }
        let mut sys = self.system(&ev.author.id);
        if !sys.proxy || sys.members.is_empty() || ev.text.trim_start().starts_with('\\') { return Vec::new(); }
        let (alter, text) = match match_tags(&sys.members, &ev.text) {
            Some((m, t)) => (m.clone(), t),
            None => {
                let who = match sys.auto.as_str() { "off" => None, "latch" => sys.last.clone(), name => Some(name.to_string()) };
                let Some(found) = who.and_then(|n| Self::find(&sys, &n)) else { return Vec::new() };
                (sys.members[found].clone(), ev.text.trim().to_string())
            }
        };
        if text.is_empty() && ev.files.is_empty() { return Vec::new(); }
        sys.last = Some(alter.name.clone());
        self.save(&ev.author.id, &sys);
        let text: String = text.chars().take(2000).collect();
        let delete = self.settings.bool(self.guild, MODULE, "deleteOriginal");
        vec![Action::Proxy {
            channel: ev.place.base().to_string(),
            thread: ev.place.thread_of.as_ref().map(|_| ev.place.channel.clone()),
            name: alter.name.clone(),
            avatar: Some(if alter.avatar.is_empty() { ev.author.avatar.clone().unwrap_or_default() } else { alter.avatar.clone() }).filter(|a| !a.is_empty()),
            text,
            files: ev.files.clone(),
            original: delete.then(|| ev.id.clone()),
            note: format!("plural:{}:{}", ev.author.id, alter.name),
        }]
    }
    /// The proxied message is up: who sent it is remembered (for `/plural who`).
    pub fn posted(&self, note: &str, message: &str) {
        let Some(rest) = note.strip_prefix("plural:") else { return };
        let (user, member) = rest.split_once(':').unwrap_or((rest, ""));
        self.data().set(&format!("msg:{message}"), &json!({ "user": user, "member": member }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn alter(name: &str, prefix: &str, suffix: &str) -> Alter { Alter { name: name.into(), prefix: prefix.into(), suffix: suffix.into(), ..Default::default() } }
    #[test]
    fn tags_before_after_or_around_a_message_pick_the_member() {
        let list = vec![alter("Kai", "k:", ""), alter("Rowan", "[", "]"), alter("Sun", "", "~s"), alter("Kaito", "k:ito ", "")];
        assert_eq!(match_tags(&list, "k: hello there").map(|(m, t)| (m.name.clone(), t)), Some(("Kai".into(), "hello there".into())));
        assert_eq!(match_tags(&list, "[ hi ]").map(|(m, t)| (m.name.clone(), t)), Some(("Rowan".into(), "hi".into())));
        assert_eq!(match_tags(&list, "good night ~s").map(|(m, t)| (m.name.clone(), t)), Some(("Sun".into(), "good night".into())));
        // the longest tag wins, and case does not matter
        assert_eq!(match_tags(&list, "K:ITO hey").map(|(m, _)| m.name.clone()), Some("Kaito".into()));
        // a message with only the tags, or none, is not proxied
        assert!(match_tags(&list, "k:").is_none() && match_tags(&list, "[]").is_none() && match_tags(&list, "plain text").is_none());
        assert!(match_tags(&[alter("NoTags", "", "")], "anything").is_none());
    }
    #[test]
    fn names_discord_refuses_are_caught() {
        assert!(name_problem("Discord Bot").is_some() && name_problem("clyde").is_some() && name_problem("").is_some());
        assert!(name_problem("Kai").is_none());
    }
}
