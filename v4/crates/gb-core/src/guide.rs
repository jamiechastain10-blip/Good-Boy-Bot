//! The command guide: every command, its parts and their boxes, written out from the bot's own command list so it can
//! never fall behind, plus a few lines by hand for the commands that need more than their one-line summary.
//! It feeds `/help command:<name>` in Discord and the Commands guide in the app and the dashboard.

use crate::bot::{commands, CommandSpec, Opt, Takes, MODULES};
use crate::{Area, Card};
use serde_json::{json, Value};

/// More than the one-line summary, for the commands that need it. Each key must be a real command (a test checks).
pub const NOTES: &[(&str, &str)] = &[
    ("rank", "Shows a picture card with the level, place and progress to the next level. Everyone has their own card: the theme, colours and background picture are chosen from the buttons under the card, and a server can set one background for everyone who has not picked their own (the Images page). Leave the member box empty to see your own."),
    ("leaderboard", "The top members of the server by XP, reputation or messages, a page at a time. For a board that keeps itself up to date in a channel, use the live board instead."),
    ("images", "The server's picture gallery. Every picture saved for the bot lives here so it can be used again. `list` numbers them, `add` opens a form that takes up to 10 pictures (PNG, JPG, GIF or WebP under 8 MB), `use` puts one on the welcome message, the goodbye message or the rank cards, `stop` takes it off again, and `remove` deletes it (anywhere it is already in use keeps its own copy). The same gallery is on the Images page of the app and the dashboard. Staff only."),
    ("greeting", "Opens a small form to add or remove the picture that goes with welcome or goodbye messages. For the full designer (picture card, words, colours and a live preview) use the Welcome page of the app or the dashboard."),
    ("verify", "A gate new members pass before they see the server. `setup` picks the role, the channel and the message, `panel` posts the button, `repost` posts it again, `status` shows how it is set up, and `reset` takes someone back to the start. With the captcha turned on, members type a short code."),
    ("music", "Plays music in your voice channel. `player` posts the player with its buttons (play or pause, skip, stop, volume, shuffle, repeat, queue and **Start mine**). If you are in a voice channel with no music bot, **Start mine** finds a free music bot, joins your channel and starts a second queue, so two calls can listen to different music. `sound` has the filters and the volume, `playlists` and `save` keep your own lists, and `lyrics` shows the words to the song that is playing."),
    ("ticket", "Support tickets. Staff run `setup` and `panel` to post the buttons members press to open a ticket; the `type` parts add your own ticket types. Inside a ticket staff can `close`, `add` or `remove` people, `rename`, set the `priority`, see `info` and save a `transcript`. The `watch` parts keep a private log of reported people."),
    ("rolemenu", "Posts a menu in this channel where members pick their own roles. The form chooses the title, the roles, the style (buttons or a dropdown) and the mode, such as a maximum number of roles. Use `limits` to change those later and `delete` to remove a menu."),
    ("backup", "Saves the server's roles, channels and permissions so they can be put back. `create` makes a backup, `list` shows them, `restore` rebuilds from one and `download` gives you the file."),
    ("say", "Posts or edits a message as the bot. The form takes plain text or an embed. Staff only."),
    ("giveaway", "`start` opens a form (prize, how long, how many winners, who may enter), `end` finishes one early, `reroll` picks new winners and `list` shows what is running."),
    ("id", "Your Eclipse ID is one gaming profile for you, the same in every server that runs Good Boy: about me, favourite games, platforms, when you play, your region and your game names. `edit` fills it in, `privacy` chooses who sees which part, `link` and `unlink` add or remove game names. `share` chooses which servers show it. `auto` lets Good Boy pick up the games you play from your Discord status (shown as picked up automatically; you can hide it, switch it off or erase it), `find` lists members of this server who play a game, `export` gives a code that carries your whole card to another Good Boy and `import` brings one in. `delete` removes your card everywhere."),
    ("party", "Find players for a game. `create` posts a call for players, `list` shows the open ones, `close` finishes yours and `kick` removes someone."),
    ("critters", "Collect, trade and battle the server's own characters. `list` and `info` show yours, `buddy` picks the one that follows you, `trade` swaps with another member, `battle` fights, and `dex` shows the ones you have found. Staff manage the roster with `add`, `remove`, `roster`, `here` and `spawn`."),
    ("xp", "Change someone's XP, stop channels from giving XP and set XP boosts for some roles or channels. Staff only."),
    ("levels", "Level rewards: the roles given when a member reaches a level. `reward add` and `reward remove` change them and `reward list` shows them."),
    ("warn", "Opens a form for the member, the reason and the strike. The warning is saved to their history and the strike ladder can escalate to a timeout, kick or ban."),
    ("purge", "Deletes recent messages in this channel: a number of messages, one member's messages, or everything. Staff only."),
    ("automod", "Shows and changes AutoMod: which rules are on, what they do, who is exempt, and the word and domain lists. `recent` shows what it caught lately."),
    ("lockdown", "`on` stops everyone from talking in every text channel, `off` puts it back, and `status` shows whether it is on. Staff only."),
    ("notifications", "Choose which optional pings and messages you get. Your own choice always wins, then the server's default. Admins use `server-default`."),
    ("setup", "Server setup for admins. `start` offers layouts (Community, Gaming, Support and product, Small group): pick one and you see exactly which roles, categories and channels it would add, and only what is missing is made. It then connects the welcome, log, suggestion and ticket channels to the bot, turns on the modules it needs, and posts the rules and the ticket buttons. `scan` checks a server that is already set up: risky permissions for everyone, empty categories, channels nobody has used for three months, duplicate names, and channels the bot is not using yet. Nothing changes until you press a Fix button. The same two things are on the Server setup page of the dashboard."),
    ("help", "Without anything typed, lists what you can use in this server. Type a command, a group or a module in the box (for example `images`, `mod` or `music`) to see what it does, its parts and what each box takes."),
    ("stats", "Activity numbers for members and the server: messages, voice time and trends. `member` and `me` show one person, `top` the most active, `recap` a summary, and `optout`, `optin` and `forget` let a member control their own numbers."),
    ("plural", "For systems: add the members of your system and send messages as them. `proxy` sets how a message is recognised and `autoproxy` keeps one member talking until you switch."),
];

/// What a box takes, in words.
pub fn takes_words(t: &Takes) -> String {
    match t {
        Takes::Member => "a member".into(),
        Takes::Text => "text".into(),
        Takes::Whole { min, max } => format!("a whole number from {min} to {max}"),
        Takes::Role => "a role".into(),
        Takes::Channel => "a channel".into(),
        Takes::Category => "a category".into(),
        Takes::AnyChannel => "a channel or category".into(),
        Takes::YesNo => "yes or no".into(),
        Takes::Choice(list) => {
            let shown: Vec<&str> = list.iter().take(8).map(|(label, _)| *label).collect();
            format!("one of: {}{}", shown.join(", "), if list.len() > 8 { ", …" } else { "" })
        }
    }
}
/// Whether the summary says only staff can use it.
pub fn staff_only(about: &str) -> bool {
    let a = about.to_ascii_lowercase();
    a.starts_with("(staff") || a.starts_with("(admin") || a.ends_with("(staff)") || a.contains("staff only") || a.contains("(staff only)")
}
/// The summary without its "(Staff) " prefix, since the guide shows who can use it separately.
fn plain(about: &str) -> String {
    match about.strip_prefix('(').and_then(|r| r.split_once(") ")) {
        Some((who, rest)) if who.to_ascii_lowercase().starts_with("staff") || who.to_ascii_lowercase().starts_with("admin") => rest.to_string(),
        _ => about.to_string(),
    }
}
/// How a member reaches a command: on its own, or inside a group's menu.
pub fn path(command: &str) -> String {
    match crate::folds::group_of(command) {
        Some(g) => format!("/{g} → {command}"),
        None => format!("/{command}"),
    }
}
fn options_json(options: &[Opt]) -> Vec<Value> {
    options.iter().map(|o| json!({ "name": o.name, "about": o.about, "required": o.required, "takes": takes_words(&o.takes) })).collect()
}
fn command_json(c: &CommandSpec) -> Value {
    let note = NOTES.iter().find(|(n, _)| *n == c.name).map(|(_, t)| *t);
    json!({
        "name": c.name, "path": path(c.name), "about": plain(c.about), "staff": staff_only(c.about), "note": note,
        "options": options_json(c.options),
        "subs": c.subs.iter().map(|s| json!({ "name": s.name, "about": plain(s.about), "staff": staff_only(s.about), "options": options_json(s.options) })).collect::<Vec<_>>(),
    })
}
/// Everything, by module: `{ modules: [{ id, name, about, commands: [...] }], groups: [[name, about]] }`.
pub fn reference() -> Value {
    let mut modules: Vec<Value> = Vec::new();
    for m in MODULES {
        let list: Vec<Value> = commands().filter(|c| c.module == m.id).map(command_json).collect();
        if list.is_empty() { continue; }
        // a module's about ends with the commands it adds; the guide lists them properly
        let about = m.about.split(" /").next().unwrap_or(m.about).trim_end_matches('.').to_string() + ".";
        modules.push(json!({ "id": m.id, "name": m.name, "about": about, "commands": list }));
    }
    // commands of modules that are always on (help, notifications)
    let rest: Vec<Value> = commands().filter(|c| !MODULES.iter().any(|m| m.id == c.module)).map(command_json).collect();
    if !rest.is_empty() { modules.push(json!({ "id": "core", "name": "Always on", "about": "Commands every server has, whichever modules are on.", "commands": rest })); }
    json!({ "modules": modules, "groups": crate::folds::GROUPS.iter().map(|(g, a, _)| json!([g, a])).collect::<Vec<_>>() })
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max - 1).collect::<String>().trim_end()) }
}
fn options_line(options: &[Opt]) -> String {
    options.iter().map(|o| format!("`{}`{} ({})", o.name, if o.required { "" } else { " optional" }, takes_words(&o.takes))).collect::<Vec<_>>().join(" · ")
}
/// The module's name in the app, and whether this server has it on.
fn module_name(id: &str) -> String {
    MODULES.iter().find(|m| m.id == id).map(|m| m.name.to_string()).unwrap_or_else(|| "Always on".into())
}
fn one_command(c: &CommandSpec, on: bool) -> Card {
    let mut card = Card::new(Area::General).title(clip(&path(c.name), 100)).private();
    let mut head = plain(c.about);
    if staff_only(c.about) { head.push_str("\n-# Staff only"); }
    card = card.line(head);
    if let Some((_, note)) = NOTES.iter().find(|(n, _)| *n == c.name) { card = card.line(clip(note, 1500)); }
    card = card.line(format!("-# Part of **{}**{}", module_name(c.module), if on { "" } else { ", which is turned off in this server" }));
    if !c.options.is_empty() { card = card.line(format!("**Boxes:** {}", clip(&options_line(c.options), 600))); }
    if !c.subs.is_empty() {
        let mut text = String::from("**Parts**");
        for s in c.subs.iter().take(30) {
            let line = format!("\n`{}` · {}{}{}", s.name, plain(s.about), if staff_only(s.about) { " (staff)" } else { "" }, if s.options.is_empty() { String::new() } else { format!("\n-# {}", clip(&options_line(s.options), 300)) });
            if text.chars().count() + line.chars().count() > 1900 { text.push_str("\n…and more. The Commands guide in the app lists them all."); break; }
            text.push_str(&line);
        }
        card = card.line(text);
    }
    card
}
fn list_card(title: String, about: &str, rows: &[&CommandSpec], enabled: &dyn Fn(&str) -> bool) -> Card {
    let mut text = String::new();
    for c in rows {
        let line = format!("`{}`{} · {}{}\n", path(c.name), if enabled(c.module) { "" } else { " (off here)" }, clip(&plain(c.about), 110), if staff_only(c.about) { " (staff)" } else { "" });
        if text.chars().count() + line.chars().count() > 3300 { text.push_str("…and more."); break; }
        text.push_str(&line);
    }
    Card::new(Area::General).title(clip(&title, 100)).line(about.to_string()).line(text).line("-# Type one of these in the box for the details, for example `/help command:images`.").private()
}
/// `/help command:<words>`: a command, a group of commands, or a module. `enabled` says whether a module is on here.
pub fn explain(query: &str, enabled: &dyn Fn(&str) -> bool) -> Card {
    let q = query.trim().trim_start_matches('/').trim().to_ascii_lowercase();
    let q = q.split(['→', ' ']).filter(|w| !w.is_empty() && *w != "→").collect::<Vec<_>>();
    // "/mod → ban", "mod ban", "ban": the last word that names a command wins, else the first
    let find = |name: &str| commands().find(|c| c.name == name);
    if let Some(c) = q.iter().rev().find_map(|w| find(w)) { return one_command(c, enabled(c.module)); }
    if let Some(first) = q.first() {
        if let Some((g, about, members)) = crate::folds::GROUPS.iter().find(|(g, _, _)| g == first) {
            let rows: Vec<&CommandSpec> = members.iter().filter_map(|n| find(n)).collect();
            return list_card(format!("/{g} · {about}"), "Everything inside this group. Pick one from the menu the group opens.", &rows, enabled);
        }
        if let Some(m) = MODULES.iter().find(|m| m.id == *first || m.name.to_ascii_lowercase() == q.join(" ")) {
            let rows: Vec<&CommandSpec> = commands().filter(|c| c.module == m.id).collect();
            return list_card(format!("{} commands", m.name), &clip(m.about.split(" /").next().unwrap_or(m.about), 400), &rows, enabled);
        }
    }
    // nothing exact: anything whose name or summary has all the words
    let rows: Vec<&CommandSpec> = commands().filter(|c| { let hay = format!("{} {}", c.name, c.about).to_ascii_lowercase(); !q.is_empty() && q.iter().all(|w| hay.contains(w)) }).take(12).collect();
    if rows.is_empty() {
        return Card::new(Area::General).title("Nothing by that name").line(format!("There is no command, group or module called `{}`. Run `/help` to see what you can use here.", clip(query.trim(), 60))).private();
    }
    list_card(format!("Closest to \"{}\"", clip(query.trim(), 40)), "These look close:", &rows, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_command_is_in_the_guide_once_with_something_to_read() {
        let r = reference();
        let mut seen: Vec<String> = Vec::new();
        for m in r["modules"].as_array().unwrap() {
            assert!(!m["about"].as_str().unwrap().trim().is_empty(), "{m}");
            for c in m["commands"].as_array().unwrap() {
                seen.push(c["name"].as_str().unwrap().to_string());
                assert!(!c["about"].as_str().unwrap().trim().is_empty() && c["path"].as_str().unwrap().starts_with('/'), "{c}");
                for s in c["subs"].as_array().unwrap() { assert!(!s["about"].as_str().unwrap().trim().is_empty(), "{} {s}", c["name"]); }
                for o in c["options"].as_array().unwrap().iter().chain(c["subs"].as_array().unwrap().iter().flat_map(|s| s["options"].as_array().unwrap())) {
                    assert!(!o["about"].as_str().unwrap().trim().is_empty() && !o["takes"].as_str().unwrap().is_empty(), "{} {o}", c["name"]);
                }
            }
        }
        let mut want: Vec<String> = commands().map(|c| c.name.to_string()).collect();
        want.sort();
        seen.sort();
        assert_eq!(seen, want, "every command, once");
    }
    #[test]
    fn every_note_is_for_a_real_command_and_the_hand_written_ones_stay_short() {
        for (name, note) in NOTES {
            assert!(commands().any(|c| c.name == *name), "{name} is not a command");
            assert!(note.chars().count() <= 1500 && note.chars().count() > 40, "{name}: {}", note.chars().count());
        }
        let mut names: Vec<&str> = NOTES.iter().map(|(n, _)| *n).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), NOTES.len(), "a command has one note");
    }
    #[test]
    fn help_can_explain_a_command_a_group_a_module_or_a_guess_and_every_card_fits_discord() {
        let on = |_: &str| true;
        let off = |m: &str| m != "member-management";
        let text = |c: &Card| format!("{} {}", c.title.clone().unwrap_or_default(), c.lines.join(" "));
        let images = explain("/images", &on);
        assert!(text(&images).contains("/server → images") && text(&images).contains("Staff only") && text(&images).contains("`use`") && text(&images).contains("number"), "{}", text(&images));
        assert!(text(&explain("/images", &off)).contains("turned off in this server"));
        assert!(text(&explain("server images", &on)).contains("/server → images"), "the way members reach it works too");
        assert!(text(&explain("/server → images", &on)).contains("picture gallery"));
        assert!(text(&explain("mod", &on)).contains("`/mod → ban`"), "a group lists its commands");
        assert!(text(&explain("Welcome", &on)).contains("Welcome commands") && text(&explain("music", &on)).contains("Plays music"));
        assert!(text(&explain("gallery", &on)).contains("images"), "a guess finds the command by its words");
        assert!(text(&explain("zzzz nothing", &on)).contains("Nothing by that name"));
        for c in commands() {
            let card = explain(c.name, &on);
            card.check().unwrap_or_else(|e| panic!("{}: {e:?}", c.name));
            card.to_discord().unwrap_or_else(|e| panic!("{}: {e:?}", c.name));
        }
        for (g, _, _) in crate::folds::GROUPS { explain(g, &on).check().unwrap_or_else(|e| panic!("{g}: {e:?}")); }
        for m in MODULES { explain(m.id, &on).check().unwrap_or_else(|e| panic!("{}: {e:?}", m.id)); }
    }
    #[test]
    fn staff_only_is_read_from_the_summary() {
        assert!(staff_only("(Staff) Add a picture") && staff_only("(Admins) Give coins") && staff_only("Post a message as the bot (staff)") && !staff_only("See your level"));
        assert_eq!(plain("(Staff) Add a picture"), "Add a picture");
        assert_eq!(plain("(Admins) Set the log channels"), "Set the log channels");
        assert_eq!(plain("See your level"), "See your level");
    }
}
