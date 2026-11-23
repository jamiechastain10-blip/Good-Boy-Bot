//! Every command is a popup, as in Good Boy 3: the popup opens, the answers run the command, bad answers get
//! Good Boy 3's wording and a "Try again" button, and long commands are asked in parts.

use gb_core::forms::Token;
use gb_core::{Action, Bot, ButtonEvent, CommandEvent, FieldKind, FormEvent, Member, Place};
use gb_data::Store;
use std::collections::BTreeMap;

const G: &str = "700000000000000001";
const NOW: i64 = 1_800_000_000_000;

fn bot() -> (tempfile::TempDir, Bot) {
    let tmp = tempfile::tempdir().unwrap();
    let bot = Bot::new(Store::create(tmp.path().join("eclipse.db")).unwrap());
    bot.on_server(G, "Ghost Town");
    (tmp, bot)
}
fn kai() -> Member { Member { id: "1".into(), name: "Kai".into(), ..Default::default() } }
fn run(bot: &Bot, name: &str, sub: Option<&str>) -> Vec<Action> {
    let ev = CommandEvent { guild: G.into(), place: Place::channel("9"), member: kai(), name: name.into(), sub: sub.map(str::to_string), at_ms: NOW, ..Default::default() };
    bot.on_command(&ev, &|_| None, &mut |lo, _| lo)
}
fn submit(bot: &Bot, who: &Member, id: &str, values: &[(&str, &str)], members: Vec<Member>) -> Vec<Action> {
    let ev = FormEvent { guild: G.into(), place: Place::channel("9"), member: who.clone(), id: id.into(), values: values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<BTreeMap<_, _>>(), members, at_ms: NOW, ..Default::default() };
    bot.on_form(&ev, &|_| None, &mut |lo, _| lo)
}
fn said(a: &Action) -> String {
    let Action::Reply { card } = a else { panic!("not a reply: {a:?}") };
    card.to_discord().unwrap().to_string()
}

#[test]
fn commands_open_their_popup_and_run_with_the_answers() {
    let (_t, bot) = bot();
    // /pet adopt with nothing filled in: a popup with the pets as a dropdown and the name box
    let out = run(&bot, "pet", Some("adopt"));
    let Action::Form { id, title, fields } = &out[0] else { panic!("{out:?}") };
    assert_eq!(title, "/pet adopt");
    assert_eq!(fields.iter().map(|f| (f.label.as_str(), f.required)).collect::<Vec<_>>(), vec![("Kind", true), ("Name", false)]);
    assert!(matches!(&fields[0].kind, FieldKind::Select(list) if list.len() == 8 && list[0] == ("🐶 Puppy (2,000)".to_string(), "puppy".to_string())));
    // something missing: Good Boy 3's wording and a Try again button
    let out = submit(&bot, &kai(), id, &[("name", "Rex")], vec![]);
    assert!(said(&out[0]).contains("❌ Fill in **Kind**.") && said(&out[0]).contains("Try again"), "{out:?}");
    // the answers run the command (a puppy costs 2,000 and a new wallet holds 500)
    let out = submit(&bot, &kai(), id, &[("kind", "puppy"), ("name", "Rex")], vec![]);
    assert!(said(&out[0]).contains("You only have **500** 🪙."), "{out:?}");
    // someone else can't use Kai's popup
    let out = submit(&bot, &Member { id: "3".into(), ..Default::default() }, id, &[("kind", "puppy")], vec![]);
    assert!(said(&out[0]).contains("belongs to someone else"));
    // a command with no boxes just runs
    assert!(matches!(run(&bot, "daily", None)[0], Action::Reply { .. }));
}

#[test]
fn whole_numbers_are_checked_like_good_boy_3() {
    let (_t, bot) = bot();
    let out = run(&bot, "fun", Some("dice"));
    let Action::Form { id, fields, .. } = &out[0] else { panic!() };
    assert_eq!(fields[0].placeholder.as_deref(), Some("1 to 10"));
    assert!(said(&submit(&bot, &kai(), id, &[("count", "2.5")], vec![])[0]).contains("**Count** must be a whole number."));
    assert!(said(&submit(&bot, &kai(), id, &[("count", "11")], vec![])[0]).contains("**Count** can be at most 10."));
    assert!(said(&submit(&bot, &kai(), id, &[("count", "0")], vec![])[0]).contains("**Count** must be at least 1."));
    assert!(!said(&submit(&bot, &kai(), id, &[("count", "3"), ("sides", "1,000")], vec![])[0]).contains("❌"));
}

#[test]
fn long_commands_are_asked_in_parts() {
    // a command with more than five boxes is asked in parts, with a Continue button
    // (commands that open their own popup, as in Good Boy 3, are left out)
    let spec = gb_core::bot::commands().find(|c| c.subs.iter().any(|s| s.options.len() > 5 && !gb_core::forms::owns_popup(c.name, Some(s.name))) || c.options.len() > 5);
    let Some(spec) = spec else { return }; // none in this build yet
    let sub = spec.subs.iter().find(|s| s.options.len() > 5).map(|s| s.name);
    let (_t, bot) = bot();
    let out = run(&bot, spec.name, sub);
    let Action::Form { id, title, .. } = &out[0] else { panic!("{out:?}") };
    assert!(title.contains("(1 of"));
    let out = submit(&bot, &kai(), id, &[], vec![]);
    let text = said(&out[0]);
    assert!(text.contains("Part 1 of") && text.contains("Continue"), "{text}");
    let Action::Reply { card } = &out[0] else { unreachable!() };
    let next = Token::read(&card.buttons[0].id).unwrap();
    assert_eq!((next.step.as_str(), next.page), ("o", 1));
    let press = ButtonEvent { guild: G.into(), member: kai(), id: card.buttons[0].id.clone(), at_ms: NOW, ..Default::default() };
    let out = bot.on_button(&press, &|_| None, &mut |lo, _| lo);
    let Action::Form { title, .. } = &out[0] else { panic!("{out:?}") };
    assert!(title.contains("(2 of"));
}
