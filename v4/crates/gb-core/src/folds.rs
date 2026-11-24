//! The command list Discord shows, kept short. Commands in the same area are folded into one group (`/mod ban`,
//! `/money daily`, `/games slots`...), because Discord allows only 100 commands and a long list is hard to
//! use. Nothing else knows about this: the groups are built from the real commands, and what a member picks is
//! turned back into the real command's name before anything runs, so popups, permissions, setup from the dashboard
//! and every module work exactly as before.

use crate::bot::{commands, CommandSpec};
use crate::{Area, Card, Select};
use std::sync::OnceLock;

/// (group, what it is for, the commands inside it). A command with a part that is itself grouped ("type add") is
/// left on its own: Discord allows only one level of grouping.
pub const GROUPS: &[(&str, &str, &[&str])] = &[
    ("money", "Coins, daily rewards, the shop, jobs and the bank", &["balance", "daily", "work", "pay", "top", "shop", "rob", "pet", "bank", "treasury", "exchange", "economy-admin"]),
    ("games", "Games, fishing and collectable creatures", &["slots", "blackjack", "coinflip", "tower", "wires", "bingo", "memory", "hangman", "trivia", "pong", "arcade", "fun", "fish", "critters", "counting"]),
    ("mod", "Moderation tools (staff)", &["warn", "unwarn", "timeout", "untimeout", "kick", "ban", "unban", "purge", "modhistory", "strikes", "note", "watch", "appeal", "report", "lockdown", "altcheck", "automod"]),
    ("community", "Levels, XP, reputation and the server's numbers", &["stats", "liveboard", "serverstats", "counter", "xp", "levels", "rep"]),
    ("roles", "Role menus, reaction roles and automatic roles", &["rolemenu", "reactionrole", "autorole", "gamerole"]),
    ("me", "Your profile, birthday, time zone and system", &["profile", "introduce", "birthday", "afk", "timezone", "id", "plural"]),
    ("social", "Marriage, families, roleplay, quotes and looking for a group", &["marry", "family", "rp", "quote", "party", "highlight"]),
    ("voice", "Voice rooms and text-to-speech", &["tts", "room", "voicehub"]),
    ("server", "Server setup and tools (staff)", &["greeting", "images", "setup", "verify", "deadchat", "announce", "suggestion", "starboard", "feed", "minecraft", "webhook", "notifications", "backup", "invites", "logs", "say", "sticky", "botnews", "clips", "tags"]),
];

fn foldable(c: &CommandSpec) -> bool {
    !c.subs.iter().any(|s| s.name.contains(' '))
}
/// Which group a command is folded into, if any.
pub fn group_of(command: &str) -> Option<&'static str> {
    let spec = commands().find(|c| c.name == command)?;
    if !foldable(spec) { return None; }
    GROUPS.iter().find(|(_, _, members)| members.contains(&command)).map(|(g, _, _)| *g)
}
/// The commands to register with Discord: the ones left on their own, then each group (with no parts: a member picks
/// what they want from a menu that the group's command opens).
pub fn menu() -> &'static [CommandSpec] {
    static MENU: OnceLock<Vec<CommandSpec>> = OnceLock::new();
    MENU.get_or_init(|| {
        let mut out: Vec<CommandSpec> = commands().filter(|c| group_of(c.name).is_none()).copied().collect();
        for (group, about, members) in GROUPS {
            let Some(module) = members.iter().find_map(|n| commands().find(|c| c.name == *n && foldable(c))).map(|c| c.module) else { continue };
            out.push(CommandSpec { name: group, about, module, options: &[], subs: &[] });
        }
        out
    })
}
/// The group a command name is, if it is one.
pub fn is_group(name: &str) -> bool {
    GROUPS.iter().any(|(g, _, _)| *g == name)
}
fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max - 1).collect::<String>().trim_end()) }
}
/// What a group's command shows: a private menu of everything inside it.
pub fn menu_card(group: &str) -> Option<Card> {
    let (_, about, members) = GROUPS.iter().find(|(g, _, _)| *g == group)?;
    let options: Vec<(String, String, Option<String>)> = members.iter().filter_map(|n| commands().find(|c| c.name == *n && foldable(c)))
        .map(|c| (clip(&format!("{} · {}", crate::forms::humanize(c.name), c.about), 100), c.name.to_string(), None)).collect();
    if options.is_empty() { return None; }
    Some(Card::new(Area::General).title(about.to_string()).line("Pick what you want to do.")
        .select(Select { id: format!("gmenu:{group}"), placeholder: "Choose…".into(), min: 1, max: 1, options }).private())
}
/// A command with several parts: a second menu for its parts.
fn parts_card(group: &str, spec: &CommandSpec) -> Card {
    let options: Vec<(String, String, Option<String>)> = spec.subs.iter().take(25).map(|s| (clip(&format!("{} · {}", crate::forms::humanize(s.name), s.about), 100), s.name.to_string(), None)).collect();
    Card::new(Area::General).title(format!("{} · {}", crate::forms::humanize(spec.name), spec.about)).line("Pick which one.")
        .select(Select { id: format!("gmenu:{group}:{}", spec.name), placeholder: "Choose…".into(), min: 1, max: 1, options }).private()
}
/// Someone picked from a group's menu (`gmenu:<group>` or `gmenu:<group>:<command>`). Either a second menu to show,
/// or the real command to run (which opens its own popup, or answers).
pub enum Picked {
    Menu(Box<Card>),
    Run { name: String, sub: Option<String> },
}
pub fn picked(id: &str, value: &str) -> Option<Picked> {
    let rest = id.strip_prefix("gmenu:")?;
    let (group, command) = match rest.split_once(':') { Some((g, c)) => (g, Some(c)), None => (rest, None) };
    if !is_group(group) { return None; }
    match command {
        // a part of a command was picked
        Some(c) => {
            if group_of(c) != Some(GROUPS.iter().find(|(g, _, _)| *g == group)?.0) { return None; }
            let spec = commands().find(|x| x.name == c)?;
            spec.subs.iter().any(|s| s.name == value).then(|| Picked::Run { name: c.to_string(), sub: Some(value.to_string()) })
        }
        // a command was picked
        None => {
            if group_of(value) != Some(GROUPS.iter().find(|(g, _, _)| *g == group)?.0) { return None; }
            let spec = commands().find(|x| x.name == value)?;
            Some(if spec.subs.is_empty() { Picked::Run { name: value.to_string(), sub: None } } else { Picked::Menu(Box::new(parts_card(group, spec))) })
        }
    }
}
/// The bot's own help text names commands in backticks (`/ban`, `/backup create`). Folded commands are named the way
/// members now reach them: `/mod` → ban, `/server` → backup create.
pub fn rewrite(text: &str) -> std::borrow::Cow<'_, str> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        let mut names: Vec<&str> = GROUPS.iter().flat_map(|(_, _, m)| m.iter().copied()).filter(|n| group_of(n).is_some()).collect();
        names.sort_by_key(|n| std::cmp::Reverse(n.len()));
        regex::Regex::new(&format!(r"`/({})([^`]*)`", names.iter().map(|n| regex::escape(n)).collect::<Vec<_>>().join("|"))).expect("a pattern")
    });
    if !text.contains("`/") { return std::borrow::Cow::Borrowed(text); }
    re.replace_all(text, |c: &regex::Captures| format!("`/{}` → {}{}", group_of(&c[1]).unwrap_or(""), &c[1], &c[2]))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_menu_is_short_and_every_real_command_can_still_be_reached() {
        let menu = menu();
        assert!(menu.len() <= 30, "{} commands: {:?}", menu.len(), menu.iter().map(|c| c.name).collect::<Vec<_>>());
        assert!(menu.iter().filter(|c| is_group(c.name)).all(|c| c.subs.is_empty() && c.options.is_empty() && c.about.chars().count() <= 100));
        for real in commands() {
            match group_of(real.name) {
                None => assert!(menu.iter().any(|m| m.name == real.name), "{} is nowhere on the menu", real.name),
                Some(group) => {
                    // the group's menu lists it, within a select's 25 options and 100-letter labels
                    let card = menu_card(group).expect("a menu");
                    let sel = card.select.as_ref().unwrap();
                    assert!(sel.options.len() <= 25 && sel.options.iter().all(|o| o.0.chars().count() <= 100 && !o.1.is_empty()), "{group}'s menu does not fit a select");
                    assert!(sel.options.iter().any(|o| o.1 == real.name), "/{group} lacks {}", real.name);
                    // picking it runs it, or shows its parts and then runs the part
                    match picked(&format!("gmenu:{group}"), real.name) {
                        Some(Picked::Run { name, sub: None }) => assert!(real.subs.is_empty() && name == real.name),
                        Some(Picked::Menu(card)) => {
                            assert!(!real.subs.is_empty() && real.subs.len() <= 25, "{} has too many parts for a select", real.name);
                            for s in real.subs {
                                assert!(matches!(picked(&format!("gmenu:{group}:{}", real.name), s.name), Some(Picked::Run { name, sub: Some(p) }) if name == real.name && p == s.name));
                            }
                            assert!(card.select.is_some());
                        }
                        _ => panic!("picking {} in /{group} does nothing", real.name),
                    }
                }
            }
        }
        // nonsense is refused: a command from another group, a made-up part, an id that is not a menu
        assert!(picked("gmenu:mod", "balance").is_none() && picked("gmenu:money", "nonsense").is_none() && picked("rolemenu:x", "ban").is_none() && picked("gmenu:nogroup", "ban").is_none());
    }
    #[test]
    fn help_text_names_commands_the_way_members_reach_them() {
        assert_eq!(rewrite("Use `/ban` or `/backup create` (not `/musicxyz`). `/rank` stays, and so does https://x/ban"), "Use `/mod` → ban or `/server` → backup create (not `/musicxyz`). `/rank` stays, and so does https://x/ban");
        assert_eq!(rewrite("Add some with `/critters add`."), "Add some with `/games` → critters add.");
        assert_eq!(rewrite("`/pet` or `/pay`"), "`/money` → pet or `/money` → pay");
        assert_eq!(rewrite("no commands here"), "no commands here");
    }
    #[test]
    fn the_guide_in_the_app_knows_the_same_groups() {
        let js = include_str!("../../../launcher/ui/guide.js");
        let block = &js[js.find("window.GBGroups = {").expect("the group list") + 19..];
        let block = &block[..block.find("};").expect("its end")];
        let re = regex::Regex::new(r"(\w+): \[([^\]]*)\]").unwrap();
        let in_guide: Vec<(String, Vec<String>)> = re.captures_iter(block).map(|c| (c[1].to_string(), c[2].split(',').map(|n| n.trim().trim_matches('\'').to_string()).filter(|n| !n.is_empty()).collect())).collect();
        let in_bot: Vec<(String, Vec<String>)> = GROUPS.iter().map(|(g, _, m)| (g.to_string(), m.iter().map(|n| n.to_string()).collect())).collect();
        assert_eq!(in_guide, in_bot, "launcher/ui/guide.js GBGroups must match folds::GROUPS");
    }
    #[test]
    fn nothing_is_in_two_groups() {
        let mut seen = std::collections::HashSet::new();
        for (_, _, members) in GROUPS { for m in *members { assert!(seen.insert(*m), "{m} is in two groups"); assert!(commands().any(|c| c.name == *m), "{m} is not a command"); } }
    }
}
