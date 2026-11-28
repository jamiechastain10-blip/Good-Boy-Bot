//! `/whatsnew` and `/about`, as Good Boy 3 had them. `/whatsnew` shows this build's change notes (the same
//! CHANGELOG.md the app's What's new page reads), with a menu to read an older version's notes.

use crate::bot::CommandSpec;
use crate::{Action, Area, Card, Select};

pub const MODULE: &str = "core";
pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec { name: "whatsnew", about: "What changed in this version of the bot", module: MODULE, options: &[], subs: &[] },
    CommandSpec { name: "about", about: "Which version of Good Boy this is, and who makes it", module: MODULE, options: &[], subs: &[] },
];
/// The id of the older-versions menu under `/whatsnew`.
pub const PICK: &str = "whatsnew:pick";
/// Discord shows at most 4000 characters of text in one message; the title and footer need some of it.
const ROOM: usize = 3600;

/// (version, notes) newest first. Only headings that are a version number start a version; any other `## heading`
/// is a part of the version above it and is kept as a bold line.
pub fn versions(changelog: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for line in changelog.replace("\r\n", "\n").lines() {
        if let Some(title) = line.strip_prefix("## ").map(str::trim).filter(|t| !t.is_empty()) {
            let version = title.trim_start_matches(['v', 'V']);
            if version.starts_with(|c: char| c.is_ascii_digit()) && !version.contains(' ') {
                out.push((version.to_string(), Vec::new()));
            } else if let Some(cur) = out.last_mut() {
                cur.1.push(format!("**{title}**"));
            }
            continue;
        }
        if let Some(cur) = out.last_mut() { cur.1.push(line.to_string()); }
    }
    out.into_iter().map(|(v, lines)| (v, lines.join("\n").trim().to_string())).collect()
}

/// Notes made ready for Discord: the members' note markers taken out, and cut at a whole line to fit.
pub fn for_discord(notes: &str) -> String {
    let body = notes.replace("<!-- members -->\n", "").replace("<!-- /members -->\n", "").replace("<!-- members -->", "").replace("<!-- /members -->", "");
    let body = body.trim();
    if body.chars().count() <= ROOM { return body.to_string(); }
    let mut kept = String::new();
    for line in body.lines() {
        if kept.chars().count() + line.chars().count() + 1 > ROOM { break; }
        kept.push_str(line);
        kept.push('\n');
    }
    // a single very long paragraph: cut it at a word
    if kept.trim().is_empty() {
        let cut: String = body.chars().take(ROOM).collect();
        kept = cut.rsplit_once(' ').map(|(a, _)| a.to_string()).unwrap_or(cut);
        kept.push('…');
    }
    format!("{}\n\n*…and more. The app's What's new page has the full list.*", kept.trim_end())
}

/// The `/whatsnew` card for one version (the one running when `want` is empty or unknown).
pub fn card(changelog: &str, running: &str, want: Option<&str>) -> Card {
    let list = versions(changelog);
    let Some(first) = list.first() else {
        return Card::new(Area::General).title("What's new").line("This copy of the bot has no change notes, so there is nothing to show.").private();
    };
    let want = want.map(|w| w.trim().trim_start_matches(['v', 'V'])).filter(|w| !w.is_empty()).unwrap_or(running);
    let (version, notes) = list.iter().find(|(v, _)| v == want).unwrap_or(first);
    let body = for_discord(notes);
    let mut card = Card::new(Area::General).title(format!("What's new in Good Boy {version}"))
        .line(if body.is_empty() { "*No notes for this version.*".to_string() } else { body })
        .line(format!("-# Running v{running}"))
        .private();
    card.accent = Some(0x5865f2);
    if list.len() > 1 {
        let options = list.iter().take(25).map(|(v, _)| (format!("Good Boy {v}{}", if v == running { " (running now)" } else { "" }), v.clone(), None)).collect();
        card = card.select(Select { id: PICK.into(), placeholder: "Read another version's notes…".into(), min: 1, max: 1, options });
    }
    card
}

/// The `/about` card.
pub fn about_card(running: &str, features_on: usize) -> Card {
    let mut card = Card::new(Area::General).title("Good Boy")
        .line("A modular community bot by **Basic Ghost Labs**. Server owners switch on only the features they want.")
        .line(format!("**Version** v{running} · **Features on here** {features_on}"))
        .line("-# /help shows what you can use here · /whatsnew shows what changed")
        .private();
    card.accent = Some(0x5865f2);
    card
}

/// `/whatsnew` or `/about` ran.
pub fn command(name: &str, features_on: usize) -> Vec<Action> {
    let running = crate::botnews::VERSION;
    let card = if name == "about" { about_card(running, features_on) } else { card(crate::botnews::CHANGELOG, running, None) };
    vec![Action::Reply { card }]
}

/// A version was picked from the menu under `/whatsnew`: the same message shows that version's notes.
pub fn picked(value: Option<&str>) -> Vec<Action> {
    vec![Action::Update { card: card(crate::botnews::CHANGELOG, crate::botnews::VERSION, value) }]
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOG: &str = "# Good Boy changes\n\nIntro.\n\n## 4.1.0\n**Big.** Thing one.\n\n<!-- members -->\nhi all\n<!-- /members -->\n\n## 4.0.1\nSmall fix.\n\n## 4.0.0\nFirst.\n\n## Music: it joins\nJoins the call.\n";

    #[test]
    fn reads_versions_and_keeps_sub_headings_inside() {
        let v = versions(LOG);
        assert_eq!(v.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["4.1.0", "4.0.1", "4.0.0"]);
        assert!(v[2].1.contains("**Music: it joins**") && v[2].1.contains("Joins the call."), "{:?}", v[2]);
    }

    #[test]
    fn shows_the_running_version_and_a_menu_for_the_others() {
        let c = card(LOG, "4.0.1", None);
        assert_eq!(c.title.as_deref(), Some("What's new in Good Boy 4.0.1"));
        assert!(c.lines[0].contains("Small fix") && c.private);
        let sel = c.select.expect("a menu");
        assert_eq!(sel.id, PICK);
        assert_eq!(sel.options.len(), 3);
        assert!(sel.options[1].0.contains("running now"));
        // an older one picked from the menu, without the members' markers
        let c = card(LOG, "4.0.1", Some("4.1.0"));
        assert!(c.lines[0].contains("hi all") && !c.lines[0].contains("<!--"), "{:?}", c.lines);
        // a version with no notes falls back to the newest
        assert_eq!(card(LOG, "9.9.9", None).title.as_deref(), Some("What's new in Good Boy 4.1.0"));
    }

    #[test]
    fn long_notes_fit_in_one_discord_message() {
        let long = format!("## 1.0.0\n{}", (0..400).map(|i| format!("- change number {i} with some words")).collect::<Vec<_>>().join("\n"));
        let c = card(&long, "1.0.0", None);
        let total: usize = c.title.iter().chain(c.lines.iter()).map(|l| l.chars().count()).sum();
        assert!(total < 4000, "{total}");
        assert!(c.lines[0].ends_with("full list.*"));
        assert!(c.select.is_none());
    }

    #[test]
    fn the_real_changelog_has_this_version() {
        let v = versions(crate::botnews::CHANGELOG);
        assert!(v.iter().any(|(x, _)| x == crate::botnews::VERSION), "CHANGELOG.md has no section for {}", crate::botnews::VERSION);
        let c = card(crate::botnews::CHANGELOG, crate::botnews::VERSION, None);
        let total: usize = c.title.iter().chain(c.lines.iter()).map(|l| l.chars().count()).sum();
        assert!(total < 4000, "{total}");
    }
}
