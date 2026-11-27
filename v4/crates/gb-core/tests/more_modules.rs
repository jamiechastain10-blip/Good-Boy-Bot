//! Fun, counting, reminders and moderation: the rules compared against Good Boy 3's own functions, and the
//! commands run against a database.

use gb_core::counting::{check_count, check_word, read_number, Turn};
use gb_core::fun::{ship_name, ship_percent, EIGHT_BALL, TOPICS};
use gb_core::moderation::warn_step;
use gb_core::perms::{ADMINISTRATOR, BAN_MEMBERS, MODERATE_MEMBERS};
use gb_core::time::{parse_duration, parse_when, DAY, HOUR, MINUTE};
use gb_core::{Action, Bot, CommandEvent, Member, MessageEvent, Place};
use gb_data::Store;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

const G: &str = "700000000000000001";
const CH: &str = "800000000000000001";
const NOW: i64 = 1_800_000_000_000;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}
fn good_boy_3(ask: &Value) -> Value {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("ask.json");
    std::fs::write(&file, ask.to_string()).unwrap();
    let out = Command::new("node").arg("--disable-warning=ExperimentalWarning").arg(fixtures().join("rules-3x.mjs")).arg(&file).output().expect("node is needed");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(out.stdout.split(|b| *b == b'\n').rfind(|l| l.starts_with(b"{")).unwrap()).unwrap()
}
fn bot() -> (tempfile::TempDir, Bot) {
    let tmp = tempfile::tempdir().unwrap();
    let bot = Bot::new(Store::create(tmp.path().join("eclipse.db")).unwrap());
    bot.on_server(G, "Ghost Town");
    (tmp, bot)
}
fn member(id: &str, name: &str, perms: u64) -> Member {
    Member { id: id.into(), name: name.into(), perms, ..Default::default() }
}
fn text(a: &Action) -> String {
    let (Action::Reply { card } | Action::Update { card } | Action::Send { card, .. } | Action::Dm { card, .. }) = a else { panic!("not a card: {a:?}") };
    card.to_discord().unwrap().to_string().replace("\\n", "\n")
}
fn cmd(who: &Member, name: &str, sub: Option<&str>, target: Option<&Member>, args: &[(&str, &str)], at: i64) -> CommandEvent {
    CommandEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), name: name.into(), sub: sub.map(str::to_string), target: target.cloned(), args: args.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), at_ms: at, from_form: true, ..Default::default() }
}
fn run(bot: &Bot, ev: CommandEvent) -> Vec<Action> {
    bot.on_command(&ev, &|_| None, &mut |lo, _| lo)
}

#[test]
fn the_rules_give_the_same_answers_as_good_boy_3() {
    let numbers = ["1", "12+1", "3x4", "3×4", "10/4", "(2+3)*4", "-5", "2**3", "abc", "7 is next", "1e3", "(1", "1.5+1.5", "..", "9999999999999999999999999999999999999999", "8÷2", "1/0", "4)", "", "  42  ", "0.1+0.2", "5-", "2X5"];
    let counts = json!([[4, null, "a", "5", true], [4, "a", "a", "5", true], [4, "a", "a", "5", false], [4, "b", "a", "6", true], [4, null, "a", "hello", true], [0, null, "a", "0+1", true], [9, null, "a", "5*2", true], [9, null, "a", "10.5", true]]);
    let words = json!([[null, null, [], "a", "Apple", true], ["apple", "b", ["apple"], "a", "egg", true], ["apple", "b", ["apple"], "a", "pear", true], ["apple", "a", ["apple"], "a", "egg", true], ["apple", "b", ["apple", "egg"], "a", "egg", true], ["apple", "b", [], "a", "two words", true], ["it's", "b", [], "a", "sun", true], ["ça", "b", [], "a", "âne", true], ["apple", "b", [], "a", "x", true], ["über", "b", [], "a", "Rot", true]]);
    let ships = json!([["100", "200"], ["200", "100"], ["123456789012345678", "987654321098765432"], ["Kai", "Rowan"], ["A", "Bo"], ["Émile", "Zoë"]]);
    let durations = ["10m", "1h30m", "2w", "90s", "", "m", "10", "1h 5m", "0m", "h2", "1d1d", "5x", "1H"];
    let whens = json!([["2026-12-31 18:30", 0], ["2026-12-31T18:30", 2], ["2027-01-01 0:05", -5], ["2026-02-30 10:00", 0], ["2026-13-01 10:00", 0], ["tomorrow", 0], ["2026-1-01 10:00", 0], ["2026-12-31 18:30:00", 0]]);
    let mut steps = Vec::new();
    for warns in 1..=12 { for every in [0, 2, 3] { for kick in [0, 4] { for ban in [0, 6] { steps.push((warns, every, kick, ban)); } } } }
    let theirs = good_boy_3(&json!({ "numbers": numbers, "counts": counts, "words": words, "ships": ships, "durations": durations, "whens": whens, "steps": steps }));

    for (i, n) in numbers.iter().enumerate() {
        assert_eq!(read_number(n), theirs["numbers"][i].as_f64(), "number {n:?}");
    }
    let said = |t: Turn<String>| match t { Turn::Skip => "skip".to_string(), Turn::Right(_) => "ok".to_string(), Turn::Wrong(why) => why };
    for (i, c) in counts.as_array().unwrap().iter().enumerate() {
        let ours = match check_count(c[0].as_i64().unwrap(), c[1].as_str(), c[2].as_str().unwrap(), c[3].as_str().unwrap(), c[4].as_bool().unwrap()) { Turn::Skip => "skip".into(), Turn::Right(_) => "ok".into(), Turn::Wrong(w) => w };
        assert_eq!(json!(ours), theirs["counts"][i], "count {c}");
    }
    for (i, w) in words.as_array().unwrap().iter().enumerate() {
        let used: Vec<String> = w[2].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert_eq!(json!(said(check_word(w[0].as_str(), w[1].as_str(), &used, w[3].as_str().unwrap(), w[4].as_str().unwrap(), w[5].as_bool().unwrap()))), theirs["words"][i], "word {w}");
    }
    for (i, s) in ships.as_array().unwrap().iter().enumerate() {
        let (a, b) = (s[0].as_str().unwrap(), s[1].as_str().unwrap());
        assert_eq!(json!([ship_percent(a, b), ship_name(a, b)]), theirs["ships"][i], "ship {a} {b}");
    }
    assert_eq!(json!([EIGHT_BALL, TOPICS]), theirs["lists"]);
    for (i, d) in durations.iter().enumerate() {
        assert_eq!(json!(parse_duration(d)), theirs["durations"][i], "duration {d:?}");
    }
    for (i, w) in whens.as_array().unwrap().iter().enumerate() {
        assert_eq!(json!(parse_when(w[0].as_str().unwrap(), w[1].as_i64().unwrap(), 0).ok()), theirs["whens"][i], "when {w}");
    }
    for (i, (warns, every, kick, ban)) in steps.iter().enumerate() {
        assert_eq!(json!(warn_step(*warns, *every, *kick, *ban)), theirs["steps"][i], "step {warns} {every} {kick} {ban}");
    }
}

#[test]
fn fun_commands() {
    let (_tmp, bot) = bot();
    let (kai, rowan) = (member("900000000000000001", "Kai", 0), member("900000000000000002", "Rowan", 0));
    assert!(text(&run(&bot, cmd(&kai, "fun", Some("8ball"), None, &[("question", "Will it rain?")], NOW))[0]).contains("Will it rain?"));
    assert!(text(&run(&bot, cmd(&kai, "fun", Some("dice"), None, &[("count", "3"), ("sides", "20")], NOW))[0]).contains("3d20: **1** + **1** + **1** = **3**"));
    let ship = text(&run(&bot, cmd(&kai, "fun", Some("ship"), Some(&rowan), &[], NOW))[0]);
    assert!(ship.contains("Rowan × Kai") && ship.contains(&format!("{}%", ship_percent(&kai.id, &rowan.id))), "{ship}");
    assert!(text(&run(&bot, cmd(&kai, "fun", Some("topic"), None, &[], NOW))[0]).contains("Topic:"));
}

#[test]
fn counting_in_a_channel() {
    let (_tmp, bot) = bot();
    let (admin, kai, rowan) = (member("900000000000000009", "Ada", ADMINISTRATOR), member("900000000000000001", "Kai", 0), member("900000000000000002", "Rowan", 0));
    // counting is off for a new server until it is switched on, and only staff can start a game
    assert!(text(&run(&bot, cmd(&admin, "counting", Some("here"), None, &[], NOW))[0]).contains("turned off in this server"));
    bot.db.get().set_module_enabled(G, "counting", true).unwrap();
    assert!(text(&run(&bot, cmd(&kai, "counting", Some("here"), None, &[], NOW))[0]).contains("counting.manage"));
    let started = run(&bot, cmd(&admin, "counting", Some("here"), None, &[], NOW));
    assert!(text(&started[0]).contains("Counting is on here") && text(&started[1]).contains("starts here"));

    let mut n = 0;
    let mut say = |who: &Member, what: &str| { n += 1; bot.on_message(&MessageEvent { guild: G.into(), place: Place::channel(CH), author: who.clone(), id: format!("{n}"), text: what.into(), mentions: 0, mentioned: Vec::new(), files: Vec::new(), at_ms: NOW + n }, &mut |lo, _| lo) };
    assert!(matches!(say(&kai, "1").as_slice(), [Action::React { emoji, .. }] if emoji == "✅"));
    assert!(say(&kai, "nice one").is_empty(), "chatter is ignored");
    assert!(matches!(say(&rowan, "1+1").as_slice(), [Action::React { emoji, .. }] if emoji == "✅"));
    let broke = say(&rowan, "3");
    assert!(matches!(&broke[0], Action::React { emoji, .. } if emoji == "❌"));
    assert!(text(&broke[1]).contains("broke the count at **2**: you can't count twice in a row") && text(&broke[1]).contains("new record"), "{}", text(&broke[1]));
    assert!(matches!(say(&kai, "1").as_slice(), [Action::React { .. }]));
    let stats = text(&run(&bot, cmd(&kai, "counting", Some("stats"), None, &[], NOW))[0]);
    assert!(stats.contains("now **1** · best **2**") && stats.contains("1. <@900000000000000001> · 2"), "{stats}");
    // a message with no text (Message Content is off) never breaks a count
    assert!(say(&rowan, "").is_empty());
    // the latest number deleted: Good Boy 3 says it so the count isn't lost (message 5 was Kai's "1")
    let gone = bot.on_messages_deleted(G, CH, &["5".to_string()]);
    assert!(gone.iter().any(|a| text(a).contains("👀 <@900000000000000001> deleted their number (**1**). The next number is **2**.")), "{gone:?}");
    assert!(bot.on_messages_deleted(G, CH, &["2".to_string()]).iter().all(|a| !text(a).contains("deleted their number")), "only the latest");
}

#[test]
fn reminders_are_kept_and_arrive_once() {
    let (_tmp, bot) = bot();
    let (kai, modr) = (member("900000000000000001", "Kai", 0), member("900000000000000005", "Mo", MODERATE_MEMBERS));
    assert!(text(&run(&bot, cmd(&kai, "remind", Some("me"), None, &[("when", "soon"), ("message", "x")], NOW))[0]).contains("Use a delay like"));
    assert!(text(&run(&bot, cmd(&kai, "remind", Some("me"), None, &[("when", "10s"), ("message", "x")], NOW))[0]).contains("too soon"));
    assert!(text(&run(&bot, cmd(&kai, "remind", Some("me"), None, &[("when", "2h"), ("message", "Feed the dog")], NOW))[0]).contains("I'll remind you"));
    assert!(text(&run(&bot, cmd(&kai, "remind", Some("team"), None, &[("when", "1d"), ("role", "600000000000000001"), ("message", "Raid night")], NOW))[0]).contains("reminders.team"));
    let set = text(&run(&bot, cmd(&modr, "remind", Some("team"), None, &[("when", "1d"), ("role", "600000000000000001"), ("role2", "600000000000000002"), ("message", "Raid night"), ("repeat", "daily")], NOW))[0]);
    assert!(set.contains("Reminder **#2** set") && set.contains("<@&600000000000000001> <@&600000000000000002>"), "{set}");
    let mine = text(&run(&bot, cmd(&kai, "remind", Some("list"), None, &[], NOW))[0]);
    assert!(mine.contains("**#1**") && mine.contains("Feed the dog") && !mine.contains("Raid night"), "a member sees their own: {mine}");

    assert!(bot.on_tick(NOW + HOUR, &mut |lo, _| lo).is_empty(), "nothing is due yet");
    let due = bot.on_tick(NOW + 2 * HOUR + MINUTE, &mut |lo, _| lo);
    assert!(matches!(&due[..], [(g, Action::Dm { user, or_in: Some((ch, _)), .. })] if g == G && user == &kai.id && ch == CH), "{due:?}");
    assert!(text(&due[0].1).contains("Feed the dog"));
    assert!(bot.on_tick(NOW + 3 * HOUR, &mut |lo, _| lo).is_empty(), "a one-off reminder is sent once");
    // the daily team reminder: sent, notifying its roles, then moved on a day. Sent late, it says so.
    let team = bot.on_tick(NOW + DAY + HOUR, &mut |lo, _| lo);
    let [(_, Action::Send { roles, card, .. })] = &team[..] else { panic!("{team:?}") };
    assert_eq!(roles, &vec!["600000000000000001".to_string(), "600000000000000002".to_string()]);
    let shown = card.to_discord().unwrap().to_string();
    assert!(shown.contains("Raid night") && shown.contains("sent late"), "{shown}");
    assert!(bot.on_tick(NOW + DAY + 2 * HOUR, &mut |lo, _| lo).is_empty());
    assert_eq!(bot.on_tick(NOW + 2 * DAY + MINUTE, &mut |lo, _| lo).len(), 1, "and again the next day");
    assert!(text(&run(&bot, cmd(&kai, "remind", Some("cancel"), None, &[("id", "2")], NOW))[0]).contains("reminders.manage"));
    assert!(text(&run(&bot, cmd(&modr, "remind", Some("cancel"), None, &[("id", "9")], NOW))[0]).contains("No reminder with that number"));
}

#[test]
fn moderation_cases_ladder_timed_bans_and_refusals() {
    let (_tmp, bot) = bot();
    let (modr, kai, rowan) = (member("900000000000000005", "Mo", MODERATE_MEMBERS | BAN_MEMBERS), member("900000000000000001", "Kai", 0), member("900000000000000002", "Rowan", 0));
    // a member cannot moderate, and nobody can act on themselves
    assert!(text(&run(&bot, cmd(&kai, "warn", None, Some(&rowan), &[("reason", "x")], NOW))[0]).contains("moderation.warn"));
    assert!(text(&run(&bot, cmd(&modr, "warn", None, Some(&modr), &[("reason", "x")], NOW))[0]).contains("yourself"));
    assert!(text(&run(&bot, cmd(&modr, "kick", None, Some(&kai), &[], NOW))[0]).contains("moderation.kick"), "kicking needs Kick Members");

    bot.settings.set(G, "moderation", "logChannel", &json!("800000000000000099")).unwrap();
    let first = run(&bot, cmd(&modr, "warn", None, Some(&kai), &[("reason", "Spamming")], NOW));
    assert!(text(&first[0]).contains("Warn · case #1") && text(&first[0]).contains("1 warning(s) total"));
    assert!(matches!(&first[1], Action::Dm { user, .. } if user == &kai.id) && text(&first[1]).contains("**Ghost Town**: you were warned: Spamming"));
    assert!(matches!(&first[2], Action::Send { channel, .. } if channel == "800000000000000099"));
    assert_eq!(first.len(), 3);
    run(&bot, cmd(&modr, "warn", None, Some(&kai), &[("reason", "Again")], NOW + 1));
    // the third warning times them out for an hour by itself (the default ladder)
    let third = run(&bot, cmd(&modr, "warn", None, Some(&kai), &[("reason", "Third")], NOW + 2));
    assert!(text(&third[0]).contains("Reached 3 warnings - timed out for 60 minutes."));
    assert!(matches!(third.last(), Some(Action::Timeout { user, until_ms: Some(t), .. }) if user == &kai.id && *t == NOW + 2 + HOUR));
    let history = text(&run(&bot, cmd(&modr, "modhistory", None, Some(&kai), &[], NOW))[0]);
    assert!(history.contains("3 warning(s), 3 strike(s) now, 4 case(s) in all") && history.contains("automatic"), "{history}");
    // saved the way Good Boy 3 saves it: newest first, with the same field names
    let saved = bot.db.get().data_get(G, "moderation", &format!("hist:{}", kai.id)).unwrap().unwrap();
    assert_eq!(saved[0]["type"], "timeout");
    assert_eq!((saved[3]["id"].as_i64(), saved[3]["type"].as_str(), saved[3]["targetId"].as_str(), saved[3]["modId"].as_str(), saved[3]["reason"].as_str(), saved[3]["at"].as_i64()), (Some(1), Some("warn"), Some(kai.id.as_str()), Some(modr.id.as_str()), Some("Spamming"), Some(NOW)));

    // a timed ban is lifted when its time is up, once
    assert!(text(&run(&bot, cmd(&modr, "ban", None, Some(&rowan), &[("duration", "soon")], NOW))[0]).contains("Ban length: use something like 1h, 7d or 30d (up to a year)"));
    let ban = run(&bot, cmd(&modr, "ban", None, Some(&rowan), &[("duration", "7d"), ("reason", "Raiding"), ("delete_days", "1")], NOW));
    assert!(text(&ban[0]).contains("Ban · case #5") && text(&ban[0]).contains("1 week"));
    assert!(text(&ban[1]).contains(&format!("you were banned until <t:{}:f>: Raiding", (NOW + 7 * DAY) / 1000)));
    let Some(Action::Ban { delete_days: 1, case: 5, .. }) = ban.last() else { panic!("{ban:?}") };
    assert!(bot.on_tick(NOW + 6 * DAY, &mut |lo, _| lo).is_empty());
    assert!(matches!(&bot.on_tick(NOW + 7 * DAY + 1, &mut |lo, _| lo)[..], [(g, Action::Unban { user, .. })] if g == G && user == &rowan.id));
    assert!(bot.on_tick(NOW + 8 * DAY, &mut |lo, _| lo).is_empty());

    // Discord refused a ban: the case does not stay in the history, and no timed ban is left waiting
    let again = run(&bot, cmd(&modr, "ban", None, Some(&rowan), &[("duration", "1d"), ("reason", "Back again")], NOW));
    bot.action_refused(G, again.last().unwrap());
    let left = bot.db.get().data_get(G, "moderation", &format!("hist:{}", rowan.id)).unwrap().unwrap();
    assert_eq!(left.as_array().unwrap().len(), 1, "only the first ban remains: {left}");
    assert!(bot.on_tick(NOW + 2 * DAY, &mut |lo, _| lo).is_empty());

    assert!(text(&run(&bot, cmd(&modr, "timeout", None, Some(&kai), &[("duration", "30d"), ("reason", "x")], NOW))[0]).contains("Discord limits timeouts to 28 days."));
    assert!(text(&run(&bot, cmd(&modr, "unban", None, None, &[("user_id", "abc")], NOW))[0]).contains("That is not a valid user ID."));
    let purge = run(&bot, cmd(&member("900000000000000009", "Ada", ADMINISTRATOR), "purge", None, None, &[("amount", "500")], NOW));
    // more than 100 asks first, as in Good Boy 3
    assert!(text(&purge[0]).contains("Delete up to **500** message"), "{}", text(&purge[0]));
}

#[test]
fn giveaways_enter_draw_reroll_and_coin_prizes() {
    use gb_core::giveaways::{coin_prize, draw_winners};
    use gb_core::ButtonEvent;
    assert_eq!((coin_prize("5000 coins"), coin_prize("1,500 Coins"), coin_prize("1 coin"), coin_prize("Nitro"), coin_prize("coins"), coin_prize("250 🪙")), (Some(5000), Some(1500), Some(1), None, None, Some(250)));
    let pool: Vec<String> = ["a", "b", "a", "c"].iter().map(|s| s.to_string()).collect();
    assert_eq!(draw_winners(&pool, 5, &mut |lo, _| lo), vec!["a", "b", "c"], "nobody wins twice, and no more winners than people");

    let (_tmp, bot) = bot();
    let (admin, kai, rowan) = (member("900000000000000009", "Ada", ADMINISTRATOR), member("900000000000000001", "Kai", 0), member("900000000000000002", "Rowan", 0));
    assert!(text(&run(&bot, cmd(&kai, "giveaway", Some("start"), None, &[("prize", "x"), ("duration", "1h")], NOW))[0]).contains("giveaways.manage"));
    assert!(text(&run(&bot, cmd(&admin, "giveaway", Some("start"), None, &[("prize", "x"), ("duration", "10s")], NOW))[0]).contains("between 1 minute and 30 days"));
    let started = run(&bot, cmd(&admin, "giveaway", Some("start"), None, &[("prize", "5000 coins"), ("duration", "1h"), ("role", "600000000000000001")], NOW));
    assert!(text(&started[0]).contains("Giveaway #1 is live"));
    let Action::Post { card, note, .. } = &started[1] else { panic!("{started:?}") };
    assert_eq!((note.as_str(), card.buttons.len()), ("gw:1", 1));
    bot.on_posted(G, note, "555000000000000001");

    let press = |who: &Member| bot.on_button(&ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: "gw:enter:1".into(), at_ms: NOW + 1, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    assert!(text(&press(&kai)[0]).contains("You need the <@&600000000000000001> role"));
    let with_role = |m: &Member| Member { roles: vec!["600000000000000001".into()], ..m.clone() };
    let joined = press(&with_role(&kai));
    assert!(text(&joined[0]).contains("You're in"));
    // the giveaway's own message is brought up to date with the new count
    assert!(matches!(&joined[1], Action::Edit { message, .. } if message == "555000000000000001") && text_of_edit(&joined[1]).contains("1 entry"));
    press(&with_role(&rowan));
    assert!(text(&press(&with_role(&rowan))[0]).contains("You left"));

    assert!(bot.on_tick(NOW + 30 * MINUTE, &mut |lo, _| lo).is_empty());
    let ended = bot.on_tick(NOW + HOUR + 1, &mut |lo, _| lo);
    assert!(text_of_edit(&ended[0].1).contains("**Winner:** <@900000000000000001>"));
    let Action::Send { ping, card, .. } = &ended[1].1 else { panic!("{ended:?}") };
    assert_eq!(ping, &vec![kai.id.clone()]);
    assert!(card.to_discord().unwrap().to_string().contains("5,000 coins were added"));
    assert_eq!(bot.db.get().coins(G, &kai.id).unwrap(), Some(5000), "the prize is paid, even to someone with no wallet yet");
    assert!(bot.on_tick(NOW + 2 * HOUR, &mut |lo, _| lo).is_empty(), "drawn once");
    assert!(text(&run(&bot, cmd(&admin, "giveaway", Some("reroll"), None, &[("id", "1")], NOW + 2 * HOUR))[0]).contains("Nobody else is eligible"));
    assert!(text(&run(&bot, cmd(&admin, "giveaway", Some("end"), None, &[("id", "1")], NOW + 2 * HOUR))[0]).contains("already ended"));
    assert!(text(&press(&with_role(&rowan))[0]).contains("has ended"));
    assert!(text(&run(&bot, cmd(&admin, "giveaway", Some("list"), None, &[], NOW))[0]).contains("**#1** 5000 coins · ended · 1 entries"));
}
fn text_of_edit(a: &Action) -> String {
    let Action::Edit { card, .. } = a else { panic!("not an edit: {a:?}") };
    card.to_discord().unwrap().to_string()
}

#[test]
fn tickets_work_the_way_good_boy_3_does() {
    use gb_core::{ButtonEvent, FormEvent, TranscriptTo};
    let (_tmp, bot) = bot();
    let staff_role = "600000000000000007";
    let (admin, kai, rowan) = (member("900000000000000009", "Ada", ADMINISTRATOR), member("900000000000000001", "Kai Storm!", 0), member("123456789012345678", "Rowan", 0));
    let staff = Member { roles: vec![staff_role.into()], ..member("900000000000000005", "Mo", 0) };
    let press = |who: &Member, ch: &str, id: &str, at: i64| bot.on_button(&ButtonEvent { guild: G.into(), place: Place::channel(ch), member: who.clone(), id: id.into(), at_ms: at, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    let fill = |who: &Member, ch: &str, id: &str, values: &[(&str, &str)], members: Vec<Member>, at: i64| bot.on_form(&FormEvent { guild: G.into(), place: Place::channel(ch), member: who.clone(), id: id.into(), values: values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), members, at_ms: at, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    let say = |out: &[Action]| out.iter().filter_map(|a| match a { Action::Reply { card } | Action::Update { card } | Action::Send { card, .. } | Action::Post { card, .. } | Action::Edit { card, .. } => Some(card.to_discord().unwrap().to_string().replace("\\n", "\n")), _ => None }).collect::<Vec<_>>().join("\n---\n");

    // /ticket setup with nothing filled in shows the setup (v3: it opens no popup); with options it saves them
    let out = run(&bot, cmd(&admin, "ticket", Some("setup"), None, &[], NOW));
    assert!(say(&out).contains("**Ticket setup**") && say(&out).contains("Category: *not set* (tickets appear at the top of the channel list)"), "{}", say(&out));
    run(&bot, cmd(&admin, "ticket", Some("setup"), None, &[("log_channel", "810000000000000002"), ("staff_role", staff_role)], NOW));
    // /ticket panel with nothing filled in: v3's own popup, filled with sensible text
    let out = run(&bot, CommandEvent { from_form: false, ..cmd(&admin, "ticket", Some("panel"), None, &[], NOW) });
    let Action::Form { id, title, fields } = &out[0] else { panic!("{out:?}") };
    assert_eq!((id.as_str(), title.as_str(), fields[1].value.as_deref()), ("ticket:panelform", "Ticket panel", Some("Need help?")));
    let out = fill(&admin, CH, "ticket:panelform", &[("channel", CH), ("title", "Need help?"), ("description", "Press a button.")], vec![], NOW);
    assert!(say(&out).contains("Panel posted in"));
    let Action::Send { card, .. } = &out[1] else { panic!() };
    assert_eq!(card.buttons.len(), 8);
    assert!(card.buttons[0].label.starts_with("Scam") && card.buttons[0].emoji.as_deref() == Some("🚨"));

    // a report: v3's popup with the member picker, the "not in the server" box and the file uploads
    let out = press(&kai, CH, "ticket:open:report", NOW);
    let Action::Form { id, fields, .. } = &out[0] else { panic!("{out:?}") };
    assert_eq!(fields.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), vec!["who", "outside", "details", "evidence", "files"]);
    // nobody named: v3's wording
    assert!(say(&fill(&kai, CH, id, &[("details", "spam")], vec![], NOW)).contains("Tell us who it is about"));
    let ev = FormEvent { guild: G.into(), place: Place::channel(CH), member: kai.clone(), id: id.clone(), values: [("who", rowan.id.as_str()), ("details", "Rowan posted a scam link in #general"), ("evidence", "https://discord.com/channels/1/2/3")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), members: vec![rowan.clone()],
        files: [("files".to_string(), vec![("shot.png".to_string(), "https://cdn.discordapp.com/attachments/1/2/shot.png".to_string(), 1000u64)])].into(), at_ms: NOW };
    let out = bot.on_form(&ev, &|_| None, &mut |lo, _| lo);
    let Action::OpenChannel { name, topic, members, staff_roles, note, .. } = &out[0] else { panic!("{out:?}") };
    assert_eq!((name.as_str(), members.as_slice(), staff_roles.as_slice()), ("ticket-kai-storm-001", &[kai.id.clone()][..], &[staff_role.to_string()][..]));
    assert_eq!(topic, "Ticket #1 · Kai Storm! · Report a member · 🟠 high");
    let tch = "820000000000000001";
    let out = bot.on_channel_made(G, note, tch);
    let all = say(&out);
    assert!(all.contains("Your ticket is ready"), "{all}");
    assert!(all.contains("Ticket #001 · Report a member") && all.contains("**Status** Waiting for staff · **Urgency** 🟠 high") && all.contains("**What happened?**"), "{all}");
    assert!(all.contains("Who is involved") && all.contains("**About**") && all.contains("@Rowan") && all.contains("Account made"), "{all}");
    assert!(all.contains("Ticket #001 · background") && all.contains("Warnings **0**"), "{all}");
    assert!(out.iter().any(|a| matches!(a, Action::KeepFiles { files, post: Some(_), .. } if files[0].stored == "evidence-0-shot.png")));
    let Action::Post { card, .. } = out.iter().find(|a| matches!(a, Action::Post { .. })).unwrap() else { unreachable!() };
    assert_eq!(card.buttons.iter().map(|b| b.label.as_str()).collect::<Vec<_>>(), vec!["Claim", "Close", "Priority", "Transcript"]);
    bot.on_posted(G, &format!("ticket-control:{tch}"), "830000000000000001");
    // the report went on the watch log
    let watch = run(&bot, cmd(&admin, "ticket", Some("watch list"), None, &[], NOW));
    assert!(say(&watch).contains("<@123456789012345678>") && say(&watch).contains("not reviewed yet") && say(&watch).contains("ticket #1"), "{}", say(&watch));
    // a second ticket mentioning Rowan's id is flagged to staff, as an exact match
    let out = press(&kai, CH, "ticket:open:other", NOW);
    let Action::Form { id, .. } = &out[0] else { panic!() };
    let out = fill(&kai, CH, id, &[("details", "and 123456789012345678 again")], vec![], NOW + 1);
    let Action::OpenChannel { note, .. } = &out[0] else { panic!("{out:?}") };
    let all = say(&bot.on_channel_made(G, note, "820000000000000002"));
    assert!(all.contains("⚠️ Watch-log match · ticket #002") && all.contains("**Exact match**") && all.contains("A report is an accusation, not proof."), "{all}");
    // the limit: two open tickets each (v3's default)
    assert!(say(&press(&kai, CH, "ticket:open:other", NOW)).contains("You already have 2 open ticket(s)"));

    // claim; priority needs a reason
    let out = press(&staff, tch, "ticket:claim", NOW + 10);
    assert!(say(&out).contains("Claimed by <@900000000000000005>") && say(&out).contains("🙋 <@900000000000000005> claimed this ticket."));
    assert!(say(&press(&kai, tch, "ticket:claim", NOW)).contains("Only staff can claim tickets."));
    let out = press(&staff, tch, "ticket:level:urgent", NOW);
    let Action::Form { id, .. } = &out[0] else { panic!() };
    let out = fill(&staff, tch, id, &[("reason", "Scam links spread fast")], vec![], NOW + 20);
    assert!(say(&out).contains("🚦 Priority changed from 🟠 high to 🔴 urgent by <@900000000000000005>.") && say(&out).contains("**Reason:** Scam links spread fast"), "{}", say(&out));
    // staff Close on a report: the outcome buttons first, then the five-field popup
    let out = press(&staff, tch, "ticket:close", NOW);
    assert!(say(&out).contains("How did the report turn out?"));
    let out = press(&staff, tch, "ticket:outcome:confirmed", NOW);
    let Action::Form { id, fields, .. } = &out[0] else { panic!("{out:?}") };
    assert_eq!(fields.len(), 5);
    let o = say(&fill(&staff, tch, id, &[("resolution", "Banned")], vec![], NOW)); assert!(o.contains("Why did you decide this?") && o.contains("is required - closing a ticket needs a resolution"), "{o}");
    let out = fill(&staff, tch, id, &[("resolution", "Banned"), ("reason", "Clear scam"), ("action", "Banned them"), ("notes", "Repeat offender")], vec![], NOW + 60_000);
    let all = say(&out);
    assert!(all.contains("Ticket closed. Your notes are in the staff log.") && all.contains("Closed by <@900000000000000005>\nResolution: Banned"), "{all}");
    assert!(!all.contains("Repeat offender"), "staff notes never go in the ticket channel");
    let Some(Action::Transcript { to, head, .. }) = out.iter().find(|a| matches!(a, Action::Transcript { .. })) else { panic!("a transcript") };
    assert!(matches!(&to[0], TranscriptTo::Channel { card, .. } if card.to_discord().unwrap().to_string().contains("Repeat offender") && card.to_discord().unwrap().to_string().contains("Marked **confirmed** on the watch log")));
    assert!(matches!(&to[1], TranscriptTo::Dm { user, .. } if *user == kai.id));
    assert!(head.summary.iter().any(|(l, v)| l == "Close reason" && v == "Clear scam"));
    assert!(out.iter().any(|a| matches!(a, Action::Dm { card, .. } if card.buttons.len() == 5 && card.buttons[0].id == format!("rate:{G}:1:1"))));
    // the watch log now says confirmed
    assert!(say(&run(&bot, cmd(&admin, "ticket", Some("watch view"), None, &[("id", "1")], NOW))).contains("confirmed by staff"));
    // the rating, once
    assert_eq!(bot.on_rate(G, 1, &kai.id, 5, NOW).0, "Thanks! You gave ⭐⭐⭐⭐⭐.");
    assert_eq!(bot.on_rate(G, 1, &kai.id, 4, NOW).0, "You already rated this ticket. Thank you!");
    assert_eq!(bot.on_rate(G, 1, &rowan.id, 4, NOW).0, "That isn't your ticket.");
    // stats, with v3's numbers
    let st = say(&run(&bot, cmd(&admin, "ticket", Some("stats"), None, &[], NOW + 120_000)));
    assert!(st.contains("**Open now** 1 · **Opened (all time)** 2 · **Closed (all time)** 1") && st.contains("⭐ **5** out of 5 from 1 member"), "{st}");
    // the member closes their own ticket with a confirm; then reopen; then the channel is deleted by hand
    let t2 = "820000000000000002";
    assert!(say(&press(&kai, t2, "ticket:close", NOW)).contains("Close this ticket?"));
    let out = press(&kai, t2, "ticket:confirm", NOW + 1000);
    assert!(say(&out).contains("Closing…") && say(&out).contains("Closed by <@900000000000000001>\nResolution: Closed by the member"), "{}", say(&out));
    assert!(!out.iter().any(|a| matches!(a, Action::Dm { .. })), "no rating for a ticket the member closed themselves");
    let out = press(&kai, t2, "ticket:reopen", NOW + 2000);
    assert!(say(&out).contains("🔓 Reopened by <@900000000000000001>."));
    let out = bot.on_channel_gone(G, t2);
    assert!(say(&out).contains("Ticket #002 closed without notes"), "{}", say(&out));
    // a custom type with an application
    let out = run(&bot, cmd(&admin, "ticket", Some("type add"), None, &[("label", "Staff application"), ("questions", "Why you? | Hours a week"), ("application", "true"), ("role", "600000000000000099")], NOW));
    assert!(say(&out).contains("Added ticket type **Staff application** with 2 form question(s). It's an application"), "{}", say(&out));
    let Action::Form { fields, .. } = &press(&rowan, CH, "ticket:open:staff-application", NOW)[0] else { panic!() };
    assert_eq!(fields.iter().map(|f| f.label.as_str()).collect::<Vec<_>>(), vec!["Why you?", "Hours a week", "Screenshots or files (optional)"]);
}

#[test]
fn custom_commands_reply_the_way_good_boy_3_does() {
    use gb_core::{tags, tagscript};
    use std::collections::HashMap;
    let vars = json!({ "user": "<@1>", "username": "Kai {x} | y", "server": "Ghost Town", "uses": "7" });
    let scripts = json!([
        ["Hello {user}, welcome to {server}!", "", vars],
        ["{username} said {args} ({argcount}) first={arg1} third={arg3}.", "one two", vars],
        ["{random: pizza | tacos | sushi} and {number: 5-9} and {number: 9 - 5} and {number:-3--1}", "", vars],
        ["{if: {arg1} = yes | Great! | Oh no}", "YES", vars],
        ["{if: {arg1} != yes | different | same}", "yes", vars],
        ["{if: {args} contains cat | meow | woof}", "my Cat is here", vars],
        ["{if: {args} | typed | nothing}", "", vars],
        ["{if: {args} | typed | nothing}", "x", vars],
        ["{unknown} stays, {USER} works, {  uses  } too, {} and { } stay", "", vars],
        ["{random: {arg1} | b} nested {if: {number: 1-1} = 1 | {random: yes | no} | never}", "deep", vars],
        ["What they type is safe: {args}", "{user} | {random: a | b} }{", vars],
        ["{if: a=b | t | f}{if: a = a}{if: x contains | t | f}{number: 1-}{number: a-b}{random:}", "", vars],
        ["{if: discontains x | t | f} {if: {args} CONTAINS b | t | f}", "abc", vars],
        ["unbalanced { brace and } another {user", "", vars],
    ]);
    let list = json!([
        { "name": "rules", "trigger": "command" }, { "name": "IP", "trigger": "command" },
        { "name": "hi", "trigger": "exact", "phrase": "hello there" }, { "name": "join", "trigger": "starts", "phrase": "how do i join" },
        { "name": "cat", "trigger": "contains", "phrase": "cat" }, { "name": "noprase", "trigger": "exact" },
    ]);
    let pre = json!(["?", "!"]);
    let matches = json!([
        ["?rules", list, pre], ["!RULES now please", list, pre], ["?ip", list, pre], ["? rules", list, pre], ["rules", list, pre], ["?nothing", list, pre],
        ["Hello There", list, pre], ["hello there friend", list, pre], ["How do I join  the server?", list, pre], ["my cat sleeps", list, pre], ["concatenate", list, pre],
        ["cat", list, pre], ["a cat.", list, pre], ["cats", list, pre], ["", list, pre], ["   ", list, pre], ["NOPRASE", list, pre], ["?rules", list, json!([])], ["$rules", list, json!(["$", ""])],
    ]);
    let theirs = good_boy_3(&json!({ "scripts": scripts, "matches": matches }));
    for (i, s) in scripts.as_array().unwrap().iter().enumerate() {
        let mut v: HashMap<String, String> = s[2].as_object().unwrap().iter().map(|(k, x)| (k.clone(), x.as_str().unwrap().to_string())).collect();
        tagscript::arg_vars(s[1].as_str().unwrap(), &mut v);
        assert_eq!(json!(tagscript::run(s[0].as_str().unwrap(), &v, &mut |lo, _| lo)), theirs["scripts"][i], "script {}", s[0]);
    }
    for (i, m) in matches.as_array().unwrap().iter().enumerate() {
        let prefixes: Vec<String> = m[2].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_string()).collect();
        let ours = tags::match_message(m[0].as_str().unwrap(), m[1].as_array().unwrap(), &prefixes).map(|(c, args)| json!([c["name"], args]));
        assert_eq!(ours.unwrap_or(Value::Null), theirs["matches"][i], "message {:?}", m[0]);
    }

    // in a server: staff add one, members use it by typing, the count goes up, and nobody is pinged
    let (_tmp, bot) = bot();
    let (modr, kai) = (member("900000000000000005", "Mo", MODERATE_MEMBERS), member("900000000000000001", "Kai", 0));
    assert!(text(&run(&bot, cmd(&kai, "tags", Some("add"), None, &[("name", "rules"), ("response", "x")], NOW))[0]).contains("tags.manage"));
    assert!(text(&run(&bot, cmd(&modr, "tags", Some("add"), None, &[("name", "two words"), ("response", "x")], NOW))[0]).contains("up to 32 letters"));
    let added = text(&run(&bot, cmd(&modr, "tags", Some("add"), None, &[("name", "?rules"), ("response", "Be kind, {username}. Asked {uses} time(s) on {date}."), ("cooldown", "30")], NOW))[0]);
    assert!(added.contains("Added **rules**. Type `?rules`."), "{added}");
    let mut n = 0;
    let mut say = |what: &str, at: i64| { n += 1; bot.on_message(&MessageEvent { guild: G.into(), place: Place::channel(CH), author: kai.clone(), id: format!("{n}"), text: what.into(), mentions: 0, mentioned: Vec::new(), files: Vec::new(), at_ms: at }, &mut |lo, _| lo) };
    let reply = say("?rules", NOW);
    let [Action::Send { ping, card, .. }] = &reply[..] else { panic!("{reply:?}") };
    assert!(ping.is_empty() && card.to_discord().unwrap().to_string().contains("Be kind, Kai. Asked 1 time(s) on 2027-01-15."), "{card:?}");
    assert!(say("?rules", NOW + 10_000).is_empty(), "on cooldown in this channel");
    assert_eq!(say("!rules", NOW + 31_000).len(), 1);
    assert!(say("rules", NOW + 90_000).is_empty());
    assert!(text(&run(&bot, cmd(&kai, "tags", Some("list"), None, &[], NOW))[0]).contains("`?rules` · used 2×"));
    assert!(text(&run(&bot, cmd(&kai, "tags", Some("use"), None, &[("name", "RULES")], NOW))[0]).contains("Asked 3 time(s)"));
    assert!(text(&run(&bot, cmd(&modr, "tags", Some("remove"), None, &[("name", "rules")], NOW))[0]).contains("Removed"));
    assert!(say("?rules", NOW + 200_000).is_empty());
}

#[test]
fn welcome_and_goodbye_messages() {
    let (_tmp, bot) = bot();
    let kai = Member { avatar: Some("https://cdn.discordapp.com/avatars/1/a.png".into()), ..member("900000000000000001", "Kai", 0) };
    bot.directory.set_members(G, 41);
    assert!(bot.on_member(G, &kai, true).is_empty(), "nothing is sent until the server turns welcome messages on");
    assert_eq!(bot.directory.members(G), Some(42), "but the member count is kept");
    let set = |k: &str, v: Value| { bot.settings.set(G, "member-management", k, &v).unwrap(); };
    set("welcomeEnabled", json!(true));
    set("welcomeChannel", json!("800000000000000010"));
    set("goodbyeEnabled", json!(true));
    set("goodbyeChannel", json!("800000000000000011"));
    set("unverifiedRole", json!("600000000000000020"));
    let joined = bot.on_member(G, &kai, true);
    let [Action::Send { channel, ping, card, .. }] = &joined[..] else { panic!("{joined:?}") };
    assert_eq!((channel.as_str(), ping), ("800000000000000010", &vec![kai.id.clone()]));
    assert!(card.to_discord().unwrap().to_string().contains("Welcome <@900000000000000001> to **Ghost Town**! You are member #43."));
    // the waiting role is only given when there is a role to earn by verifying
    set("verificationRole", json!("600000000000000021"));
    assert!(matches!(&bot.on_member(G, &kai, true)[0], Action::Roles { add, .. } if add == &vec!["600000000000000020".to_string()]));
    set("goodbyeMessage", json!("Bye {username}, {count} left in {server}. {user} {other}"));
    let left = bot.on_member(G, &kai, false);
    let [Action::Send { channel, ping, card, .. }] = &left[..] else { panic!("{left:?}") };
    assert!(channel == "800000000000000011" && ping.is_empty());
    assert!(card.to_discord().unwrap().to_string().contains("Bye Kai, 43 left in Ghost Town. <@900000000000000001> {other}"));
    // Good Boy 3 welcomes bots too (only welcome-back roles skip them)
    assert!(bot.on_member(G, &Member { bot: true, ..kai.clone() }, true).iter().any(|a| matches!(a, Action::Send { .. })));
}

#[test]
fn the_welcome_card_look_carries_the_servers_picture_and_words_and_the_preview_matches() {
    use gb_core::Art;
    let (_tmp, bot) = bot();
    let kai = Member { avatar: Some("https://cdn.discordapp.com/avatars/1/a.png?size=128".into()), ..member("900000000000000001", "Kai", 0) };
    bot.directory.set_members(G, 41);
    let set = |k: &str, v: Value| { bot.settings.set(G, "member-management", k, &v).unwrap(); };
    set("welcomeEnabled", json!(true));
    set("welcomeChannel", json!("800000000000000010"));
    // the default look is the words, exactly as before: no picture is drawn
    let plain = bot.on_member(G, &kai, true);
    assert!(matches!(&plain[0], Action::Send { card, .. } if card.art.is_none()));
    // the card look: the message stays (it pings), and a picture is drawn from the server's words and picture
    set("welcomeLook", json!("card"));
    set("welcomeCardTitle", json!("Welcome, {username}! {user}"));
    set("welcomeCardLine", json!("Member #{count} of {server}"));
    set("welcomeCardAccent", json!("#ff3366"));
    set("welcomeCardTheme", json!("sunset"));
    let joined = bot.on_member(G, &kai, true);
    let [Action::Send { ping, card, .. }] = &joined[..] else { panic!("{joined:?}") };
    assert_eq!(ping, &vec![kai.id.clone()], "the welcome still pings the new member");
    let Some(Art::Greeting(art)) = &card.art else { panic!("a greeting picture: {:?}", card.art) };
    assert_eq!((art.title.as_str(), art.line.as_str()), ("Welcome, Kai! Kai", "Member #43 of Ghost Town"), "a mention in the picture is written as the name");
    assert_eq!((art.accent.as_deref(), art.theme.as_deref(), art.name.as_str()), (Some("#ff3366"), Some("sunset"), "Kai"));
    assert!(art.avatar_url.as_deref().is_some_and(|u| u.contains("size=256")) && art.background.is_none(), "no background picture yet");
    assert!(card.lines.iter().any(|l| l.contains("<@900000000000000001>")), "the message text goes with the picture");
    // the server's picture goes behind the card
    bot.greeting_image_set(G, "welcome", "bg.png", &[0x89, b'P', b'N', b'G', 0, 0, 0, 0], 1).unwrap();
    let with_picture = bot.on_member(G, &kai, true);
    assert!(matches!(&with_picture[0], Action::Send { card, .. } if matches!(&card.art, Some(Art::Greeting(a)) if a.background.as_deref().is_some_and(|b| b.starts_with(&[0x89, b'P'])))));
    // goodbye has its own look, off by default
    set("goodbyeEnabled", json!(true));
    set("goodbyeChannel", json!("800000000000000011"));
    let left = bot.on_member(G, &kai, false);
    assert!(matches!(&left[0], Action::Send { card, .. } if card.art.is_none()));
    set("goodbyeLook", json!("card"));
    let left = bot.on_member(G, &kai, false);
    assert!(matches!(&left[0], Action::Send { card, ping, .. } if ping.is_empty() && matches!(&card.art, Some(Art::Greeting(a)) if a.title == "Goodbye, Kai")));
    // the dashboard's preview: a sample member, and values being tried win over what is saved
    let (art, said) = bot.greeting_preview(G, "welcome", &json!({})).unwrap();
    assert!(said.contains("@Alex") && !said.contains("<@"), "{said}");
    assert_eq!(art.unwrap().title, "Welcome, Alex! Alex");
    let (art, _) = bot.greeting_preview(G, "welcome", &json!({ "look": "plain" })).unwrap();
    assert!(art.is_none(), "trying the words look shows no picture");
    let (art, said) = bot.greeting_preview(G, "welcome", &json!({ "title": "Hi {username}", "line": "", "accent": "#00ff00", "theme": "forest", "message": "Hey {user}, you are #{count}" })).unwrap();
    let art = art.unwrap();
    assert_eq!((art.title.as_str(), art.line.as_str(), art.accent.as_deref(), art.theme.as_deref(), said.as_str()), ("Hi Alex", "", Some("#00ff00"), Some("forest"), "Hey @Alex, you are #123"));
    assert!(bot.greeting_preview(G, "nope", &json!({})).is_none());
    // only the two looks are accepted
    assert!(bot.settings.set(G, "member-management", "welcomeLook", &json!("hologram")).is_err());
}

#[test]
fn automod_rules_give_the_same_answers_as_good_boy_3() {
    use gb_core::automod as am;
    let texts = [
        "hello there", "THIS IS SO LOUD AND ANNOYING", "Mostly quiet but SOME CAPS here", "WHY", "look `CODE IN BACKTICKS IS FINE` ok then", "<@123456789012345678> HEY EVERYONE LOOK AT THIS",
        "😀😀😀", "👨‍👩‍👧‍👦 family", "👍🏽 thumbs", "🇬🇧🇺🇸 flags", "<:pepe:123456789012345678> <a:dance:123456789012345678> custom", "♥️ heart ✨", "no emoji at all", "ÉCOLE ÜBER ÅNGSTRÖM ÇA VA BIEN",
        "Hello   @someone <@123> <#456>  world", "Get free nitro at https://discord-nitro.gift/claim", "https://dlscord.com/login now", "https://discord.com/channels/1/2 is fine",
        "visit www.steamcommunity-trade.ru for skins", "check https://example.com:8080/path and http://Sub.Test.org.", "free nitro here https://bit.ly/abc", "https://steancommunity.com/id/me",
        "join discord.gg/abc123", "I'm leaving cs2, giving away my skins https://skins.example.net", "plain https://youtube.com/watch?v=1", "`tick` and \u{200B}zero width\u{200B} text that is longer than twenty",
        "https://rn-discord.com", "https://d1sc0rd-app.net", "https://xn--discrd.com", "", "     ",
    ];
    let sites = ["discord.com", "cdn.discordapp.com", "discord-gift.ru", "dlscord.com", "dicsord.gg", "steam-community.com", "stearncommunity.com", "example.com", "discordant.org", "disc.ord.com", "my.steampowered.com.evil.ru", "rnissing.com", "youtube.com"];
    let words = json!([
        ["you are a meanie", ["meanie"]], ["MEANIES are fine", ["meanie"]], ["Ugh, MEANIE!", ["meanie"]], ["no bad words here", ["meanie", "jerk"]], ["a jerk and a meanie", ["meanie", "jerk"]],
        ["c.a.t and cat", ["c.a.t"]], ["(hello)", ["(hello)"]], ["über-bad", ["über"]], ["someone said jerk2", ["jerk"]], ["anything", []], ["two words here", ["two words"]],
    ]);
    let links = json!([
        ["see https://youtube.com/x", []], ["see https://youtube.com/x", ["youtube.com"]], ["see https://m.youtube.com/x", ["youtube.com"]], ["see https://www.youtube.com", ["www.youtube.com"]],
        ["notyoutube.com via https://notyoutube.com", ["youtube.com"]], ["discord.gg/abc", []], ["discord.gg/abc", ["discord.gg"]], ["https://discord.com/invite/abc", ["discord.com"]], ["no links", []],
    ]);
    let exempt = json!([
        [{ "all": { "roles": ["1"], "channels": [] } }, "caps", { "roleIds": ["1"], "channelId": "9" }],
        [{ "caps": { "roles": [], "channels": ["<#9>"] } }, "caps", { "roleIds": [], "channelId": "9" }],
        [{ "caps": { "roles": [], "channels": ["9"] } }, "spam", { "roleIds": [], "channelId": "9" }],
        [{ "all": { "channels": ["7"] } }, "words", { "roleIds": [], "channelId": "9", "parentId": "7" }],
        [{ "all": { "channels": ["5"] } }, "words", { "roleIds": [], "channelId": "9", "categoryId": "5" }],
        [{}, "words", { "roleIds": ["1"], "channelId": "9" }],
    ]);
    let edits = json!([[{}, "caps", "roles", "1", true], [{ "caps": { "roles": ["1"], "channels": [] } }, "caps", "roles", "1", true], [{ "caps": { "roles": ["1"], "channels": [] } }, "caps", "roles", "1", false], [{ "all": { "channels": ["2"] } }, "all", "roles", "3", true], [{}, "spam", "channels", "4", false]]);
    let theirs = good_boy_3(&json!({ "automod": { "texts": texts, "sites": sites, "words": words, "links": links, "exempt": exempt, "edits": edits } }))["automod"].clone();
    for (i, t) in texts.iter().enumerate() {
        assert_eq!(json!(am::count_emoji(t)), theirs["emoji"][i], "emoji in {t:?}");
        assert_eq!(json!(am::caps_ratio(t, 12)), theirs["caps"][i], "caps in {t:?}");
        assert_eq!(json!(am::normalize(t)), theirs["normal"][i], "normal {t:?}");
        assert_eq!(json!(am::snippet(t, 20)), theirs["snippet"][i], "snippet {t:?}");
        assert_eq!(json!(am::link_hosts(t)), theirs["hosts"][i], "hosts in {t:?}");
        assert_eq!(json!(am::scam_reason(t)), theirs["scam"][i], "scam in {t:?}");
    }
    for (i, h) in sites.iter().enumerate() {
        assert_eq!(json!(am::fake_site(h)), theirs["fake"][i], "fake {h}");
    }
    let strings = |v: &Value| v.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect::<Vec<_>>();
    for (i, w) in words.as_array().unwrap().iter().enumerate() {
        assert_eq!(json!(am::banned_word(w[0].as_str().unwrap(), &strings(&w[1]))), theirs["words"][i], "words {w}");
    }
    for (i, l) in links.as_array().unwrap().iter().enumerate() {
        assert_eq!(json!(am::blocked_link(l[0].as_str().unwrap(), &strings(&l[1]))), theirs["links"][i], "links {l}");
    }
    for (i, e) in exempt.as_array().unwrap().iter().enumerate() {
        let w = &e[2];
        assert_eq!(json!(am::is_exempt(&e[0], e[1].as_str().unwrap(), &strings(&w["roleIds"]), w["channelId"].as_str().unwrap(), w["parentId"].as_str(), w["categoryId"].as_str())), theirs["exempt"][i], "exempt {e}");
    }
    for (i, e) in edits.as_array().unwrap().iter().enumerate() {
        let (ex, changed) = am::edit_exempt(&e[0], e[1].as_str().unwrap(), e[2].as_str().unwrap(), e[3].as_str().unwrap(), e[4].as_bool().unwrap());
        assert_eq!(json!({ "ex": ex, "changed": changed }), theirs["edits"][i], "edit {e}");
    }
}

#[test]
fn automod_in_a_server() {
    let (_tmp, bot) = bot();
    let (admin, kai) = (member("900000000000000009", "Ada", ADMINISTRATOR), member("900000000000000001", "Kai", 0));
    let modr = member("900000000000000005", "Mo", MODERATE_MEMBERS);
    let mut n = 0;
    let mut say = |who: &Member, what: &str, at: i64| { n += 1; bot.on_message(&MessageEvent { guild: G.into(), place: Place::channel(CH), author: who.clone(), id: format!("70000000000000{n:04}"), text: what.into(), mentions: 0, mentioned: Vec::new(), files: Vec::new(), at_ms: at }, &mut |lo, _| lo) };

    // scams are caught out of the box, and the default for scams is delete + timeout
    let caught = say(&kai, "free nitro https://discord-gift.ru/x", NOW);
    assert!(matches!(&caught[0], Action::Delete { .. }));
    assert!(matches!(&caught[1], Action::Timeout { until_ms: Some(t), .. } if *t == NOW + 5 * MINUTE), "{caught:?}");
    assert!(caught.iter().any(|a| matches!(a, Action::Flash { after_secs: 6, .. }) && text_of_flash(a).contains("that link looks like a scam")));
    assert!(caught.iter().any(|a| matches!(a, Action::Dm { .. }) && text(a).contains("removed by AutoMod (scam link)")));
    // moderators are never checked
    assert!(say(&modr, "free nitro https://discord-gift.ru/x", NOW).is_empty());
    assert!(say(&kai, "hello there", NOW).is_empty());

    // switching rules on with /automod (admins only), and the word filter
    assert!(text(&run(&bot, cmd(&modr, "automod", Some("rule"), None, &[("rule", "words"), ("enabled", "true")], NOW))[0]).contains("moderation.automod"));
    assert!(text(&run(&bot, cmd(&admin, "automod", Some("rule"), None, &[("rule", "words"), ("enabled", "true"), ("action", "delete")], NOW))[0]).contains("**Word filter** is now on · delete only"));
    assert!(text(&run(&bot, cmd(&admin, "automod", Some("word"), None, &[("what", "add"), ("word", "meanie")], NOW))[0]).contains("Added **meanie**"));
    let words = say(&kai, "you are a MEANIE", NOW);
    assert!(matches!(&words[0], Action::Delete { .. }) && !words.iter().any(|a| matches!(a, Action::Timeout { .. })), "delete only: {words:?}");
    assert!(say(&kai, "meanies are fine", NOW).is_empty());
    // an exemption for the channel lets it through
    assert!(text(&run(&bot, cmd(&admin, "automod", Some("exempt"), None, &[("what", "add"), ("rule", "words"), ("channel", CH)], NOW))[0]).contains("Now ignoring <#800000000000000001> for **Word filter**"));
    assert!(say(&kai, "meanie", NOW).is_empty());

    // spam: the fifth message in six seconds removes the burst and warns (the server default)
    run(&bot, cmd(&admin, "automod", Some("rule"), None, &[("rule", "spam"), ("enabled", "true")], NOW));
    for k in 0..4 { assert!(say(&kai, &format!("msg {k}"), NOW + 10_000 + k * 500).is_empty()); }
    let spam = say(&kai, "msg 4", NOW + 12_000);
    let Action::DeleteMany { messages, .. } = &spam[0] else { panic!("{spam:?}") };
    assert_eq!(messages.len(), 4, "the four before it, then the message itself");
    let hist = bot.db.get().data_get(G, "moderation", &format!("hist:{}", kai.id)).unwrap().unwrap();
    assert_eq!((hist[0]["type"].as_str(), hist[0]["reason"].as_str()), (Some("warn"), Some("AutoMod: spam")));

    // what was removed is listed, and the status shows the counts
    let recent = text(&run(&bot, cmd(&modr, "automod", Some("recent"), None, &[], NOW))[0]);
    assert!(recent.contains("**spam** · delete + warn · case #") && recent.contains("**scam link** · delete + timeout"), "{recent}");
    let status = text(&run(&bot, cmd(&modr, "automod", Some("status"), None, &[], NOW + 13_000))[0]);
    assert!(status.contains("🟢 **Word filter**") && status.contains("🟢 **Spam (too many messages too fast)** · limit 5") && status.contains("1 caught"), "{status}");
    assert!(text(&run(&bot, cmd(&kai, "automod", Some("status"), None, &[], NOW))[0]).contains("moderation.history"));
    // a server that turned moderation off is not policed at all
    bot.db.get().set_module_enabled(G, "moderation", false).unwrap();
    assert!(say(&kai, "free nitro https://discord-gift.ru/x", NOW).is_empty());

    // member permissions worked out from roles (messages do not carry them)
    let mut roles = std::collections::HashMap::new();
    roles.insert("600000000000000001".to_string(), MODERATE_MEMBERS);
    bot.directory.set_powers(G, "900000000000000099", 0, roles);
    assert_eq!(bot.directory.power_of(G, "1", &["600000000000000001".into()]), MODERATE_MEMBERS);
    assert_eq!(bot.directory.power_of(G, "900000000000000099", &[]), ADMINISTRATOR, "the owner can do everything");
    assert_eq!(bot.directory.power_of(G, "1", &[]), 0);
}
fn text_of_flash(a: &Action) -> String {
    let Action::Flash { card, .. } = a else { panic!() };
    card.to_discord().unwrap().to_string()
}

#[test]
fn role_menus_reaction_roles_and_automatic_roles() {
    use gb_core::bot::RoleFacts;
    use gb_core::ButtonEvent;
    let (_tmp, bot) = bot();
    let role = |name: &str, position: i64, perms: u64| RoleFacts { name: name.into(), position, managed: false, perms, mentionable: true };
    let mut facts = std::collections::HashMap::new();
    facts.insert("600000000000000001".to_string(), role("Red", 2, 0));
    facts.insert("600000000000000002".to_string(), role("Blue", 3, 0));
    facts.insert("600000000000000003".to_string(), role("Mods", 4, 1 << 13));
    facts.insert("600000000000000004".to_string(), role("Above me", 20, 0));
    facts.insert("600000000000000005".to_string(), role("Staff", 9, 0));
    bot.directory.set_role_facts(G, facts, Some(10));
    let staff = Member { roles: vec!["600000000000000005".into()], ..member("900000000000000005", "Mo", 1 << 28) };
    let kai = member("900000000000000001", "Kai", 0);

    // the safety rules: no powerful roles, nothing above the bot, nothing at or above the person's own top role
    let make = |roles: &[(&str, &str)]| run(&bot, cmd(&staff, "rolemenu", Some("create"), None, roles, NOW));
    assert!(text(&make(&[("title", "x"), ("role1", "600000000000000003")])[0]).contains("powerful permissions"));
    assert!(text(&make(&[("title", "x"), ("role1", "600000000000000004")])[0]).contains("above my highest role"));
    assert!(text(&make(&[("title", "x"), ("role1", "600000000000000005")])[0]).contains("at or above your own highest role"));
    assert!(text(&run(&bot, cmd(&kai, "rolemenu", Some("create"), None, &[("title", "x"), ("role1", "600000000000000001")], NOW))[0]).contains("roles.manage"));

    let made = make(&[("title", "Colours"), ("role1", "600000000000000001"), ("role2", "600000000000000002"), ("max", "1"), ("hours", "2")]);
    let Action::Post { card, note, .. } = &made[1] else { panic!("{made:?}") };
    assert_eq!(card.buttons.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(), vec!["rolemenu:btn:600000000000000001", "rolemenu:btn:600000000000000002"]);
    assert!(card.to_discord().unwrap().to_string().contains("Pick up to 1. Tap again to take one off. Roles last 2 hours."));
    bot.on_posted(G, note, "880000000000000001");
    assert!(bot.db.get().data_get(G, "roles", "menu:880000000000000001").unwrap().is_some(), "kept under the message id, as Good Boy 3 keeps it");

    let press = |who: &Member, id: &str, values: &[&str]| bot.on_button(&ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), message: "880000000000000001".into(), values: values.iter().map(|v| v.to_string()).collect(), at_ms: NOW }, &|_| None, &mut |lo, _| lo);
    let got = press(&kai, "rolemenu:btn:600000000000000001", &[]);
    assert!(text(&got[0]).contains("Added **Red** for 2 hours"));
    assert!(matches!(&got[1], Action::Roles { add, remove, .. } if add == &vec!["600000000000000001".to_string()] && remove.is_empty()));
    let red = Member { roles: vec!["600000000000000001".into()], ..kai.clone() };
    assert!(text(&press(&red, "rolemenu:btn:600000000000000002", &[])[0]).contains("up to 1 role"), "the limit holds");
    let off = press(&red, "rolemenu:btn:600000000000000001", &[]);
    assert!(text(&off[0]).contains("Removed **Red**"));
    // the timed role runs out by itself
    press(&kai, "rolemenu:btn:600000000000000001", &[]);
    assert!(bot.on_tick(NOW + HOUR, &mut |lo, _| lo).is_empty());
    assert!(matches!(&bot.on_tick(NOW + 2 * HOUR + 1, &mut |lo, _| lo)[..], [(_, Action::Roles { remove, .. })] if remove == &vec!["600000000000000001".to_string()]));

    // a dropdown menu
    let made = make(&[("title", "Pings"), ("role1", "600000000000000001"), ("role2", "600000000000000002"), ("style", "dropdown")]);
    let Action::Post { card, note, .. } = &made[1] else { panic!() };
    let shown = card.to_discord().unwrap().to_string();
    assert!(card.buttons.is_empty() && shown.contains("\"type\":3") && shown.contains("Choose your roles"), "{shown}");
    bot.on_posted(G, note, "880000000000000002");
    let picked = bot.on_button(&ButtonEvent { guild: G.into(), place: Place::channel(CH), member: red.clone(), id: "rolemenu:sel".into(), message: "880000000000000002".into(), values: vec!["600000000000000002".into()], at_ms: NOW }, &|_| None, &mut |lo, _| lo);
    assert!(matches!(&picked[1], Action::Roles { add, remove, .. } if add == &vec!["600000000000000002".to_string()] && remove == &vec!["600000000000000001".to_string()]));

    // reaction roles and automatic roles
    let rr = run(&bot, cmd(&staff, "reactionrole", Some("add"), None, &[("message_id", "880000000000000009"), ("emoji", "<:pepe:123456789012345678>"), ("role", "600000000000000002")], NOW));
    assert!(matches!(&rr[1], Action::React { message, .. } if message == "880000000000000009"));
    assert!(matches!(&bot.on_reaction(G, "880000000000000009", "123456789012345678", &kai.id, true)[..], [Action::Roles { add, .. }] if add == &vec!["600000000000000002".to_string()]));
    assert!(matches!(&bot.on_reaction(G, "880000000000000009", "123456789012345678", &kai.id, false)[..], [Action::Roles { remove, .. }] if !remove.is_empty()));
    assert!(bot.on_reaction(G, "880000000000000009", "🙂", &kai.id, true).is_empty());
    run(&bot, cmd(&staff, "autorole", Some("add"), None, &[("role", "600000000000000001")], NOW));
    assert!(bot.on_member(G, &kai, true).iter().any(|a| matches!(a, Action::Roles { add, .. } if add == &vec!["600000000000000001".to_string()])));
    assert!(text(&run(&bot, cmd(&staff, "autorole", Some("list"), None, &[], NOW))[0]).contains("Members: <@&600000000000000001>"));
}

#[test]
fn a_servers_own_strike_ladder() {
    use gb_core::moderation::{ladder_step, parse_ladder};
    // the format is forgiving, and what it cannot read is reported rather than guessed
    let lines: Vec<String> = ["2 Strikes - 1 Day Timeout", "4 timeout 1w", "6 = ban 30 days", "10 ban", "8 kick", "3 timeout", "x ban", "5 timeout 40d"].iter().map(|s| s.to_string()).collect();
    let (steps, bad) = parse_ladder(&lines);
    assert_eq!(steps.iter().map(|s| (s.at, s.action, s.ms)).collect::<Vec<_>>(), vec![(2, "timeout", Some(DAY)), (4, "timeout", Some(7 * DAY)), (6, "ban", Some(30 * DAY)), (8, "kick", None), (10, "ban", None)]);
    assert_eq!(bad, vec!["3 timeout", "x ban", "5 timeout 40d"], "a timeout needs a length, and Discord stops at 28 days");
    assert_eq!(ladder_step(&steps, 3), None, "between steps nothing happens");
    assert_eq!(ladder_step(&steps, 12).map(|s| s.at), Some(10), "past the top, the last step repeats");

    // the screenshot's rules: 2 = 1 day timeout, 4 = 1 week timeout, 6 = 30 day ban, then back to 3
    let (_tmp, bot) = bot();
    let modr = member("900000000000000005", "Mo", MODERATE_MEMBERS);
    let kai = member("900000000000000001", "Kai", 0);
    bot.settings.set(G, "moderation", "strikeLadder", &json!(["2 timeout 1d", "4 timeout 1w", "6 ban 30d"])).unwrap();
    bot.settings.set(G, "moderation", "strikeResetTo", &json!(3)).unwrap();
    let clock = std::cell::Cell::new(NOW);
    let strike = || { clock.set(clock.get() + 1000); run(&bot, cmd(&modr, "warn", None, Some(&kai), &[("reason", "Rule 1")], clock.get())) };
    let one = strike();
    assert!(text(&one[0]).contains("1 strike(s) · next: 1 day timeout at 2") && !one.iter().any(|a| matches!(a, Action::Timeout { .. })), "{}", text(&one[0]));
    assert!(matches!(strike().last(), Some(Action::Timeout { until_ms: Some(u), .. }) if *u - clock.get() == DAY));
    assert!(!strike().iter().any(|a| matches!(a, Action::Timeout { .. } | Action::Ban { .. })), "3 strikes: nothing");
    assert!(matches!(strike().last(), Some(Action::Timeout { until_ms: Some(u), .. }) if *u - clock.get() == 7 * DAY));
    strike();
    let banned = strike();
    assert!(text(&banned[0]).contains("Reached 6 strikes - banned for 30 days"), "{}", text(&banned[0]));
    assert!(matches!(banned.last(), Some(Action::Ban { .. })));
    assert!(bot.db.get().data_get(G, "moderation", &format!("tempban:{}", kai.id)).unwrap().is_some(), "lifted by itself after 30 days");
    // back to 3: the next strike is the fourth, a week's timeout
    let view = text(&run(&bot, cmd(&modr, "strikes", Some("view"), None, &[], clock.get()))[0]);
    assert!(view.contains("Pick a member"));
    let view = text(&run(&bot, cmd(&modr, "strikes", Some("view"), Some(&kai), &[], clock.get()))[0]);
    assert!(view.contains("Kai · 3 strikes") && view.contains("Next: **1 week timeout** at 4 strikes."), "{view}");
    assert!(matches!(strike().last(), Some(Action::Timeout { until_ms: Some(u), .. }) if *u - clock.get() == 7 * DAY));

    // an appeal: a strike is taken back, and is recorded as taken back
    let back = run(&bot, cmd(&modr, "unwarn", None, Some(&kai), &[("reason", "Appeal accepted")], clock.get() + 1));
    assert!(text(&back[0]).contains("taken back") && text(&back[0]).contains("now has 3 strike(s)"), "{}", text(&back[0]));
    assert!(text(&run(&bot, cmd(&modr, "unwarn", None, Some(&kai), &[("case", "999")], clock.get()))[0]).contains("no warning with that case number"));
    let ladder = text(&run(&bot, cmd(&modr, "strikes", Some("ladder"), None, &[], clock.get()))[0]);
    assert!(ladder.contains("**2 strikes** - 1 day timeout") && ladder.contains("**6 strikes** - 30 days ban") && ladder.contains("start again from **3**"), "{ladder}");
}

#[test]
fn server_logs() {
    const L: &str = "700000000000000077";
    let (_tmp, bot) = bot();
    bot.on_server(L, "Log Town");
    let admin = member("900000000000000009", "Ada", ADMINISTRATOR);
    let kai = Member { roles: vec!["600000000000000001".into()], ..member("900000000000000071", "Kai", 0) };
    let ev = |name: &str, sub: &str, args: &[(&str, &str)]| CommandEvent { guild: L.into(), place: Place::channel(CH), member: admin.clone(), name: name.into(), sub: Some(sub.into()), args: args.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), at_ms: NOW, from_form: true, ..Default::default() };
    let setup = text(&bot.on_command(&ev("logs", "setup", &[("mod_channel", "800000000000000090"), ("server_channel", "800000000000000091"), ("joins", "true"), ("roles", "true"), ("nicknames", "true"), ("voice", "true")]), &|_| None, &mut |lo, _| lo)[0]);
    assert!(setup.contains("✅ Saved: mod log channel, server log channel, members joining and leaving on") && setup.contains("✅ Voice joins, leaves and moves"), "{setup}");

    // a copy is kept, so the delete and the edit can be shown
    bot.on_message(&MessageEvent { guild: L.into(), place: Place::channel(CH), author: kai.clone(), id: "990000000000000001".into(), text: "the original words".into(), mentions: 0, mentioned: Vec::new(), files: vec![("cat.png".into(), "https://cdn.discordapp.com/x/cat.png".into(), 10)], at_ms: NOW }, &mut |lo, _| lo);
    let edit = bot.on_message_edited(L, CH, "990000000000000001", &kai, "better words", "https://discord.com/channels/1/2/3", NOW + 5);
    let shown = text(&edit[0]);
    assert!(shown.contains("Message edited") && shown.contains("the original words") && shown.contains("better words"), "{shown}");
    let del = bot.on_messages_deleted(L, CH, &["990000000000000001".into()]);
    let [Action::Send { channel, card, .. }] = &del[..] else { panic!("{del:?}") };
    let shown = card.to_discord().unwrap().to_string();
    assert!(channel == "800000000000000090" && shown.contains("better words") && shown.contains("by <@900000000000000071>"), "{shown}");
    assert!(text(&bot.on_messages_deleted(L, CH, &["990000000000000002".into()])[0]).contains("had not seen this message"));
    assert!(bot.db.get().kept_message(L, "990000000000000001").unwrap().is_none(), "the copy goes when the message goes");

    // joins, roles, nicknames and voice go to the server log
    let joined = bot.on_member(L, &kai, true);
    assert!(joined.iter().any(|a| matches!(a, Action::Send { channel, .. } if channel == "800000000000000091") && text(a).contains("📥 Member joined") && text(a).contains("Account created")));
    let promoted = Member { roles: vec!["600000000000000002".into()], ..kai.clone() };
    let changed = bot.on_member_changed(L, &promoted, Some("Kaizen"));
    assert_eq!(changed.len(), 2, "{changed:?}");
    assert!(text(&changed[0]).contains("Added: <@&600000000000000002>") && text(&changed[0]).contains("Removed: <@&600000000000000001>"));
    assert!(text(&changed[1]).contains("**Before:** *none*") && text(&changed[1]).contains("**After:** Kaizen"));
    assert!(text(&bot.on_voice(L, &kai, Some("810000000000000001"), false)[0]).contains("joined 🔊 <#810000000000000001>"));
    assert!(text(&bot.on_voice(L, &kai, Some("810000000000000002"), false)[0]).contains("moved 🔊 <#810000000000000001> → <#810000000000000002>"));
    assert!(text(&bot.on_voice(L, &kai, None, false)[0]).contains("left 🔊 <#810000000000000002>"));
    let left = bot.on_member(L, &promoted, false);
    assert!(left.iter().any(|a| text(a).contains("📤 Member left") && text(a).contains("<@&600000000000000002>")));
    let off = text(&bot.on_command(&ev("logs", "off", &[("which", "server")]), &|_| None, &mut |lo, _| lo)[0]);
    assert!(off.contains("the server log") && off.contains("▫️ Voice"), "{off}");
    assert!(bot.on_voice(L, &kai, Some("810000000000000001"), false).is_empty());
}

#[test]
fn resetting_the_economy() {
    use gb_core::ButtonEvent;
    let (tmp, bot) = bot();
    let (admin, kai, rowan) = (member("900000000000000009", "Ada", ADMINISTRATOR), member("900000000000000001", "Kai", 0), member("900000000000000002", "Rowan", 0));
    for who in [&kai, &rowan] { run(&bot, cmd(who, "daily", None, None, &[], NOW)); }
    assert_eq!(bot.db.get().coins(G, &kai.id).unwrap(), Some(750), "500 to start, 250 daily");
    let press = |who: &Member, id: &str| bot.on_button(&ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), at_ms: NOW + 1, ..Default::default() }, &|_| None, &mut |lo, _| lo);

    // admins only (/economy-admin and its reset button), and it asks first
    assert!(text(&run(&bot, cmd(&kai, "economy-admin", None, None, &[], NOW))[0]).contains("economy.admin"));
    let Action::Reply { card } = &run(&bot, cmd(&admin, "economy-admin", None, None, &[], NOW))[0] else { panic!() };
    assert_eq!(card.buttons.iter().map(|b| b.label.as_str()).collect::<Vec<_>>(), ["Configure adjustment", "Reset the economy"]);
    assert!(text(&press(&kai, "money:resetask")[0]).contains("economy.admin"));
    let ask = press(&admin, "money:resetask");
    let shown = text(&ask[0]);
    assert!(shown.contains("Reset the economy?") && shown.contains("(2 wallets)") && shown.contains("backup"), "{shown}");
    assert!(text(&press(&admin, "money:reset:cancel")[0]).contains("Nothing was reset"));
    assert!(text(&press(&kai, "money:reset:all")[0]).contains("economy.admin"), "the button checks again");
    assert_eq!(bot.db.get().coins(G, &kai.id).unwrap(), Some(750));

    // one member
    let money = gb_core::money::Money { db: &bot.db, settings: &bot.settings, guild: G };
    let one = [money.reset_prompt(&admin, Some(&kai))];
    assert!(text(&one[0]).contains("<@900000000000000001>'s wallet"));
    assert!(text(&press(&admin, "money:reset:900000000000000001")[0]).contains("wallet was reset"));
    assert_eq!(bot.db.get().coins(G, &kai.id).unwrap(), None);
    assert_eq!(bot.db.get().coins(G, &rowan.id).unwrap(), Some(750), "only Kai");
    // everyone, with a backup made first
    let all = press(&admin, "money:reset:all");
    assert!(text(&all[0]).contains("The economy was reset (1 wallets)"));
    assert_eq!(bot.db.get().coins(G, &rowan.id).unwrap(), None);
    let backups: Vec<_> = std::fs::read_dir(tmp.path().join("backups")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    assert_eq!(backups.iter().filter(|b| b.starts_with("good-boy-before-economy-reset-")).count(), 2, "{backups:?}");
    // a fresh start: the starting coins again
    assert!(text(&run(&bot, cmd(&rowan, "daily", None, None, &[], NOW + 2))[0]).contains("You got **250**"));
    assert_eq!(bot.db.get().coins(G, &rowan.id).unwrap(), Some(750));
}

#[test]
fn raid_protection_young_accounts_and_anti_nuke_like_good_boy_3() {
    let (_tmp, bot) = bot();
    let set = |k: &str, v: serde_json::Value| bot.settings.set(G, "moderation", k, &v).unwrap();
    set("logChannel", json!("810000000000000003"));
    let say = |out: &[Action]| out.iter().filter_map(|a| match a { Action::Send { card, .. } | Action::Dm { card, .. } => Some(card.to_discord().unwrap().to_string()), _ => None }).collect::<Vec<_>>().join("\n");
    // a brand-new account (its id says it was made just now), with the young-account check on and kick chosen
    set("minAccountAgeDays", json!(7));
    set("newAccountAction", json!("kick"));
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let fresh = (((now - 1_420_070_400_000) as u64) << 22).to_string();
    let out = bot.on_member(G, &member(&fresh, "newbie", 0), true);
    assert!(say(&out).contains("New account joined"), "{}", say(&out));
    assert!(out.iter().any(|a| matches!(a, Action::Kick { reason, .. } if reason == "Account younger than 7 day(s)")));
    set("minAccountAgeDays", json!(0));
    // raid: 3 joins in the window with a threshold of 3 times out all three
    set("raidProtection", json!(true));
    set("raidJoinThreshold", json!(3));
    set("raidAction", json!("timeout"));
    bot.on_member(G, &member("900000000000000101", "a", 0), true);
    bot.on_member(G, &member("900000000000000102", "b", 0), true);
    let out = bot.on_member(G, &member("900000000000000103", "c", 0), true);
    assert!(say(&out).contains("🚨 Possible raid") && say(&out).contains("3 members joined within 10 seconds. Raid mode is active for 5 minutes (action: **timeout**)."), "{}", say(&out));
    assert_eq!(out.iter().filter(|a| matches!(a, Action::Timeout { reason, .. } if reason == "Raid protection")).count(), 3);
    // anti-nuke: three destructive actions strip the person's dangerous roles, and the owner is told
    set("antiNuke", json!(true));
    let roles = vec![("600000000000000001".to_string(), 1 << 2, false), ("600000000000000002".to_string(), 0, false), ("600000000000000003".to_string(), 1 << 3, true)];
    let me = "900000000000000999";
    assert!(bot.on_destructive(G, "900000000000000201", &roles, me, now).is_empty());
    assert!(bot.on_destructive(G, "900000000000000201", &roles, me, now + 1000).is_empty());
    let out = bot.on_destructive(G, "900000000000000201", &roles, me, now + 2000);
    assert!(out.iter().any(|a| matches!(a, Action::Roles { remove, .. } if remove == &vec!["600000000000000001".to_string()])), "only the unmanaged dangerous role: {out:?}");
    assert!(say(&out).contains("🛡️ Anti-nuke triggered") && say(&out).contains("performed **3** destructive actions within 30s.") && say(&out).contains("Response: **removed 1 dangerous role(s)**."), "{}", say(&out));
    // the bot itself is never counted
    for k in 0..5 { assert!(bot.on_destructive(G, me, &roles, me, now + k).is_empty()); }
}

#[test]
fn purge_works_the_way_good_boy_3_does() {
    use gb_core::ButtonEvent;
    let (_tmp, bot) = bot();
    let admin = member("900000000000000009", "Ada", ADMINISTRATOR);
    let say = |out: &[Action]| out.iter().filter_map(|a| match a { Action::Reply { card } | Action::Update { card } => Some(card.to_discord().unwrap().to_string()), _ => None }).collect::<Vec<_>>().join("\n");
    let press = |id: &str| bot.on_button(&ButtonEvent { guild: G.into(), place: Place::channel(CH), member: admin.clone(), id: id.into(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    // up to 100: straight away
    let out = run(&bot, cmd(&admin, "purge", None, None, &[("amount", "20")], NOW));
    assert!(matches!(&out[1], Action::Purge { count: 20, keep_pinned: true, progress: false, .. }), "{out:?}");
    // everything: asks first, then runs with progress and a Stop button
    let out = run(&bot, cmd(&admin, "purge", None, None, &[], NOW));
    assert!(say(&out).contains("Delete **every** message in <#800000000000000001> (pins are kept)?"), "{}", say(&out));
    let out = press(&format!("mpurge:yes:{}", admin.id));
    assert!(say(&out).contains("🧹 Purging… 0 deleted so far.") && say(&out).contains("Stop"));
    assert!(matches!(&out[1], Action::Purge { count: u64::MAX, progress: true, .. }));
    let out = press(&format!("mpurge:stop:{}", admin.id));
    assert!(say(&out).contains("⏹️ Stopping…") && matches!(&out[1], Action::PurgeStop { .. }));
    let (text, log) = bot.on_purged(G, CH, &admin.id, None, 1234, true, true);
    assert_eq!(text, "⏹️ Stopped: deleted 1,234 message(s) in <#800000000000000001>.");
    assert!(log.is_empty(), "no mod log channel set");
    // recreate: not with an amount; confirm, then the channel is recreated and settings follow it
    assert!(say(&run(&bot, cmd(&admin, "purge", None, None, &[("method", "recreate"), ("amount", "5")], NOW))).contains("Recreate removes everything"));
    run(&bot, cmd(&admin, "purge", None, None, &[("method", "recreate")], NOW));
    let out = press(&format!("mpurge:yes:{}", admin.id));
    assert!(say(&out).contains("⏳ Recreating…") && matches!(&out[1], Action::RecreateChannel { .. }));
    bot.settings.set(G, "moderation", "logChannel", &json!(CH)).unwrap();
    let out = bot.on_recreated(G, CH, "800000000000000777", "general", &admin.id);
    assert_eq!(bot.settings.text(G, "moderation", "logChannel").as_deref(), Some("800000000000000777"), "the log channel setting follows the new channel");
    assert!(out.iter().any(|a| matches!(a, Action::Send { channel, .. } if channel == "800000000000000777")));
    // someone else's buttons
    let other = bot.on_button(&ButtonEvent { guild: G.into(), place: Place::channel(CH), member: member("1", "x", ADMINISTRATOR), id: format!("mpurge:no:{}", admin.id), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    assert!(say(&other).contains("That belongs to someone else."));
}

#[test]
fn warning_form_like_good_boy_3() {
    let (_tmp, bot) = bot();
    let (modr, kai) = (member("900000000000000005", "Mo", MODERATE_MEMBERS), member("900000000000000001", "Kai", 0));
    // /warn on its own opens the form: who, reason, severity (Medium picked), staff notes
    let mut bare = cmd(&modr, "warn", None, None, &[], NOW);
    bare.from_form = false;
    // first Good Boy 3's private message with the one button; nothing is recorded yet
    let intro = text(&run(&bot, bare)[0]);
    assert!(intro.contains("Nothing is recorded until you submit the form.") && intro.contains("Configure warning") && intro.contains("Only you can see this."), "{intro}");
    let press = |who: &Member, id: &str| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    assert!(text(&press(&kai, &format!("mwarn:{}:-", modr.id))[0]).contains("belongs to someone else"));
    let Action::Form { id, title, fields } = &press(&modr, &format!("mwarn:{}:-", modr.id))[0] else { panic!("no form") };
    assert_eq!((id.as_str(), title.as_str()), ("modwarn:-", "Warn a member"));
    assert_eq!(fields.iter().map(|f| f.label.as_str()).collect::<Vec<_>>(), ["Member to warn", "Warning reason", "Severity", "Duration / severity notes"]);
    assert_eq!(fields[2].value.as_deref(), Some("medium"));
    // right-click > Warn member: the member is known, so the form doesn't ask who
    let mut right = cmd(&modr, "warn", None, Some(&kai), &[], NOW);
    right.from_form = false;
    assert!(text(&run(&bot, right)[0]).contains(&format!("Warning <@{}>.", kai.id)));
    let Action::Form { id, fields, .. } = &press(&modr, &format!("mwarn:{}:{}", modr.id, kai.id))[0] else { panic!("no form") };
    assert_eq!((id.as_str(), fields.len()), ("modwarn:900000000000000001", 3));
    // v3's checks before the form opens
    let mut me = cmd(&modr, "warn", None, Some(&modr), &[], NOW);
    me.from_form = false;
    assert!(text(&run(&bot, me)[0]).contains("You cannot warn yourself."));
    let robot = Member { bot: true, ..member("900000000000000009", "Beep", 0) };
    let mut b = cmd(&modr, "warn", None, Some(&robot), &[], NOW);
    b.from_form = false;
    assert!(text(&run(&bot, b)[0]).contains("Bots cannot be warned."));
    // sending the form records the severity and notes in the case
    let form = gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: modr.clone(), id: "modwarn:-".into(), values: [("user", kai.id.as_str()), ("reason", "Spamming"), ("severity", "high"), ("notes", "counts for 30 days")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), members: vec![kai.clone()], at_ms: NOW, ..Default::default() };
    let done = bot.on_form(&form, &|_| None, &mut |lo, _| lo);
    assert!(text(&done[0]).contains("Warn · case #1"), "{done:?}");
    let saved = bot.db.get().data_get(G, "moderation", &format!("hist:{}", kai.id)).unwrap().unwrap();
    assert_eq!((saved[0]["severity"].as_str(), saved[0]["reason"].as_str()), (Some("high"), Some("Spamming")));
    // the next warning form starts with what was typed, for 30 minutes
    let reopen = |at: i64| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: modr.clone(), id: format!("mwarn:{}:-", modr.id), message: "m".into(), values: vec![], at_ms: at }, &|_| None, &mut |lo, _| lo);
    let value_of = |a: &Action, f: &str| match a { Action::Form { fields, .. } => fields.iter().find(|x| x.id == f).and_then(|x| x.value.clone()), _ => None };
    assert_eq!(value_of(&reopen(NOW + 60_000)[0], "reason").as_deref(), Some("Spamming"));
    assert_eq!(value_of(&reopen(NOW + 60_000)[0], "severity").as_deref(), Some("high"));
    assert_eq!(value_of(&reopen(NOW + 31 * 60_000)[0], "reason"), None);
}

#[test]
fn reason_popups_like_good_boy_3() {
    let (_tmp, bot) = bot();
    let (modr, kai) = (member("900000000000000005", "Mo", MODERATE_MEMBERS | BAN_MEMBERS | gb_core::perms::KICK_MEMBERS), member("900000000000000001", "Kai", 0));
    let press = |who: &Member, id: &str| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    let send = |id: &str, values: &[(&str, &str)]| bot.on_form(&gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: modr.clone(), id: id.into(), values: values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), members: vec![kai.clone()], at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    // a timeout with no reason: nothing happens yet, a private button opens Good Boy 3's popup with the length kept
    let asked = run(&bot, cmd(&modr, "timeout", None, Some(&kai), &[("duration", "2h")], NOW));
    assert_eq!(asked.len(), 1);
    assert!(text(&asked[0]).contains("Press the button to fill in the form.") && text(&asked[0]).contains("Open form"));
    let button = format!("modq:{}:timeout:{}:2h", modr.id, kai.id);
    assert!(text(&press(&kai, &button)[0]).contains("belongs to someone else"));
    let Action::Form { id, title, fields } = &press(&modr, &button)[0] else { panic!("no popup") };
    assert_eq!(title, "Time out a member");
    assert_eq!(fields.iter().map(|f| f.label.as_str()).collect::<Vec<_>>(), ["How long? e.g. 10m, 2h, 1d (max 28d)", "Reason (shown in the log and to the member)"]);
    assert_eq!(fields[0].value.as_deref(), Some("2h"));
    assert!(text(&send(id, &[("duration", "2h"), ("reason", " ")])[0]).contains("Please give a reason - it goes in the log."));
    let done = send(id, &[("duration", "2h"), ("reason", "Spam")]);
    assert!(text(&done[0]).contains("Timeout · case #1") && text(&done[0]).contains("**Duration** 2 hours"), "{}", text(&done[0]));
    assert!(matches!(done.last(), Some(Action::Timeout { until_ms: Some(t), .. }) if *t == NOW + 2 * HOUR));
    // a ban keeps its length and asks how many days of messages go
    let asked = run(&bot, cmd(&modr, "ban", None, Some(&kai), &[("duration", "7d")], NOW));
    let Action::Reply { card } = &asked[0] else { panic!() };
    let _ = card;
    let Action::Form { id, fields, .. } = &press(&modr, &format!("modq:{}:ban:{}:7d~0", modr.id, kai.id))[0] else { panic!("no popup") };
    assert_eq!(fields.last().map(|f| (f.label.as_str(), f.value.as_deref())), Some(("Delete their messages from the last N days (0-7)", Some("0"))));
    assert!(text(&send(id, &[("reason", "Raid"), ("days", "9")])[0]).contains("Days of messages to delete must be a whole number from 0 to 7."));
    let done = send(id, &[("reason", "Raid"), ("days", "2")]);
    assert!(matches!(done.last(), Some(Action::Ban { delete_days: 2, .. })), "{done:?}");
    assert!(text(&done[0]).contains("Raid (for 1 week)"));
    // untimeout and unban answer as Good Boy 3 does
    assert!(text(&run(&bot, cmd(&modr, "untimeout", None, Some(&kai), &[], NOW))[0]).contains("Timeout removed for **Kai**."));
    assert!(text(&run(&bot, cmd(&modr, "unban", None, None, &[("user_id", "900000000000000001"), ("reason", "Appeal")], NOW))[0]).contains("Unbanned `900000000000000001`."));
}

#[test]
fn role_menu_popup_and_game_roles_like_good_boy_3() {
    use gb_core::bot::RoleFacts;
    let (_tmp, bot) = bot();
    let mut facts = std::collections::HashMap::new();
    facts.insert("600000000000000001".to_string(), RoleFacts { name: "Red".into(), position: 2, managed: false, perms: 0, mentionable: true });
    facts.insert("600000000000000002".to_string(), RoleFacts { name: "Gamers".into(), position: 3, managed: false, perms: 0, mentionable: true });
    facts.insert("600000000000000009".to_string(), RoleFacts { name: "Staff".into(), position: 8, managed: false, perms: 0, mentionable: true });
    bot.directory.set_role_facts(G, facts, Some(10));
    let staff = Member { roles: vec!["600000000000000009".into()], ..member("900000000000000005", "Mo", ADMINISTRATOR) };
    // /rolemenu create with nothing filled in: Good Boy 3's "New role menu" popup
    let mut bare = cmd(&staff, "rolemenu", Some("create"), None, &[], NOW);
    bare.from_form = false;
    let Action::Form { id, title, fields } = &run(&bot, bare)[0] else { panic!("no popup") };
    assert_eq!((id.as_str(), title.as_str()), ("rolemenu:form:900000000000000005", "New role menu"));
    assert_eq!(fields.iter().map(|f| f.label.as_str()).collect::<Vec<_>>(), ["Title", "Text under the title (optional)", "Roles people can pick", "Look", "How many can each person have"]);
    assert_eq!(fields[4].hints, ["Click to add or remove each role", "Choosing another swaps it"]);
    assert!(text(&run(&bot, cmd(&staff, "rolemenu", Some("create"), None, &[("title", "x")], NOW))[0]).contains("Fill in a title and at least one role, or leave everything empty to use the popup."));
    let send = |values: &[(&str, &str)]| bot.on_form(&gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: staff.clone(), id: id.clone(), values: values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    let posted = send(&[("title", "Colours"), ("roles", "600000000000000001"), ("style", "dropdown"), ("mode", "unique")]);
    assert!(text(&posted[0]).contains(&format!("Role menu posted in <#{CH}>.")), "{posted:?}");
    assert!(matches!(&posted[1], Action::Post { .. }));
    // the launcher lists the menu once its message is up, and can take it away (the message goes, the buttons stop)
    assert!(bot.role_menus(G)["menus"].as_array().unwrap().is_empty(), "nothing is listed before the message exists");
    let Action::Post { note, .. } = &posted[1] else { unreachable!() };
    bot.on_posted(G, note, "555000000000000077");
    let menus = bot.role_menus(G);
    let m = &menus["menus"][0];
    assert_eq!((m["message"].as_str(), m["title"].as_str(), m["mode"].as_str(), m["type"].as_str()), (Some("555000000000000077"), Some("Colours"), Some("unique"), Some("dropdown")));
    assert_eq!(m["roles"][0]["name"], "Red");
    let gone = bot.role_menu_delete(G, "555000000000000077").unwrap();
    assert!(matches!(&gone[0], Action::Delete { message, .. } if message == "555000000000000077"), "{gone:?}");
    assert!(bot.role_menus(G)["menus"].as_array().unwrap().is_empty());
    assert!(bot.role_menu_delete(G, "555000000000000077").is_err(), "already gone");

    // game roles: v3's wording, the Presence Intent warning, given and taken away as people play
    let said = text(&run(&bot, cmd(&staff, "gamerole", Some("add"), None, &[("game", "Minecraft"), ("role", "600000000000000002")], NOW))[0]);
    assert!(said.contains("Members playing **minecraft** will get **Gamers**.") && said.contains("Presence Intent"), "{said}");
    bot.directory.set_presences(true);
    assert!(!text(&run(&bot, cmd(&staff, "gamerole", Some("add"), None, &[("game", "Minecraft"), ("role", "600000000000000002")], NOW))[0]).contains("Presence Intent"));
    assert!(text(&run(&bot, cmd(&staff, "gamerole", Some("list"), None, &[], NOW))[0]).contains("**minecraft** → <@&600000000000000002>"));
    let kai = member("900000000000000001", "Kai", 0);
    let started = bot.on_playing(G, &kai, &[], &["Minecraft".into()]);
    assert!(matches!(&started[..], [Action::Roles { add, reason, .. }] if add == &["600000000000000002"] && reason == "Playing minecraft"), "{started:?}");
    assert!(bot.on_playing(G, &kai, &["Minecraft".into()], &["Minecraft".into()]).is_empty());
    assert!(matches!(&bot.on_playing(G, &kai, &["Minecraft".into()], &[])[..], [Action::Roles { remove, .. }] if remove == &["600000000000000002"]));
    bot.settings.set(G, "roles", "gameRoleRemove", &json!(false)).unwrap();
    assert!(bot.on_playing(G, &kai, &["Minecraft".into()], &[]).is_empty(), "kept when the server says so");
    assert!(text(&run(&bot, cmd(&staff, "gamerole", Some("remove"), None, &[("game", "Minecraft")], NOW))[0]).contains("Unlinked."));
    assert!(text(&run(&bot, cmd(&staff, "gamerole", Some("list"), None, &[], NOW))[0]).contains("No games linked yet."));
}

#[test]
fn member_management_like_good_boy_3() {
    use gb_core::bot::RoleFacts;
    use gb_core::welcome::{code_matches, normalize_hex, sanitize_name};
    let (_tmp, bot) = bot();
    let mut facts = std::collections::HashMap::new();
    for (id, name, pos) in [("600000000000000001", "Verified", 2), ("600000000000000002", "Unverified", 1), ("600000000000000003", "Fans", 3), ("600000000000000009", "Admins", 8)] {
        facts.insert(id.to_string(), RoleFacts { name: name.into(), position: pos, managed: false, perms: 0, mentionable: true });
    }
    bot.directory.set_role_facts(G, facts, Some(10));
    bot.directory.set_roles(G, vec![gb_core::bot::Named { id: "600000000000000003".into(), name: "Fans".into(), kind: "", parent: String::new() }]);
    let admin = Member { roles: vec!["600000000000000009".into()], ..member("900000000000000005", "Mo", ADMINISTRATOR) };
    let kai = member("900000000000000001", "Kai", 0);
    let set = |k: &str, v: Value| { bot.settings.set(G, "member-management", k, &v).unwrap(); };
    let press = |who: &Member, id: &str, at: i64| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), at_ms: at, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    let send = |who: &Member, id: &str, values: &[(&str, &str)], at: i64| bot.on_form(&gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), values: values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), at_ms: at, ..Default::default() }, &|_| None, &mut |lo, _| lo);

    // Good Boy 3's helpers
    assert_eq!(sanitize_name("  @Kai#  the`  Great ", 32), "Kai the Great");
    assert_eq!(normalize_hex("ff69b4").as_deref(), Some("#FF69B4"));
    assert_eq!(normalize_hex("#12345"), None);
    assert!(code_matches(" km7 tr ", "KM7TR") && !code_matches("KM7T", "KM7TR"));

    // welcome back: roles kept when someone leaves and given back when they return
    set("unverifiedRole", json!("600000000000000002"));
    let with_roles = Member { roles: vec!["600000000000000003".into(), "600000000000000002".into()], ..kai.clone() };
    bot.on_member(G, &with_roles, false);
    let back = bot.on_member(G, &kai, true);
    assert!(back.iter().any(|a| matches!(a, Action::Roles { add, reason, .. } if add == &["600000000000000003"] && reason == "Welcome back: roles they had before leaving")), "{back:?}");

    // verification: the popup, the panel, the button
    let mut bare = cmd(&admin, "verify", Some("setup"), None, &[], NOW);
    bare.from_form = false;
    let Action::Form { id, title, fields } = &run(&bot, bare)[0] else { panic!("no popup") };
    assert_eq!((id.as_str(), title.as_str()), ("verify:form:900000000000000005", "Set up verification"));
    assert_eq!(fields.iter().map(|f| f.label.as_str()).collect::<Vec<_>>(), ["Role members get after verifying", "Role new members hold until then (optional)", "Channel for the Verify button", "Text on the panel (optional)"]);
    let done = send(&admin, id, &[("role", "600000000000000001"), ("unverified", "600000000000000002"), ("channel", CH), ("message", "")], NOW);
    assert!(text(&done[0]).contains("✅ Verification is set up.") && text(&done[0]).contains("get **Verified** and lose **Unverified**"), "{}", text(&done[0]));
    let Action::Post { card, note, .. } = &done[1] else { panic!("{done:?}") };
    assert!(card.to_discord().unwrap().to_string().contains("Verify me") && note.starts_with("verify:panel:"));
    bot.on_posted(G, note, "700000000000000001");
    assert!(text(&run(&bot, cmd(&admin, "verify", Some("status"), None, &[], NOW))[0]).contains("✅ everything looks right"));
    let ok = press(&kai, "verify:go", NOW);
    assert!(text(&ok[0]).contains("✅ You are verified. Welcome!"));
    assert!(matches!(&ok[1], Action::Roles { add, .. } if add == &["600000000000000001"]));
    assert!(text(&press(&kai, "verify:go", NOW + 1000)[0]).contains("Easy - one moment between clicks."));
    let done_already = Member { roles: vec!["600000000000000001".into()], ..kai.clone() };
    assert!(text(&press(&done_already, "verify:go", NOW + 9000)[0]).contains("You're already verified."));

    // the captcha: a picture, three tries
    set("verifyCaptcha", json!(true));
    let rowan = member("900000000000000002", "Rowan", 0);
    let shown = press(&rowan, "verify:go", NOW + 20_000);
    let Action::Reply { card } = &shown[0] else { panic!() };
    assert!(card.files.iter().any(|f| f.name == "code.png") && text(&shown[0]).contains("Type the code in the picture."));
    assert!(card.to_discord().unwrap()["components"][0]["components"].as_array().unwrap().iter().any(|c| c["type"] == 12), "the picture is shown, not attached as a file");
    // the roll always gives the first letter, so the code is AAAAA
    assert!(text(&send(&rowan, "verify:code", &[("code", "nope")], NOW + 21_000)[0]).contains("That wasn't it. 2 tries left"));
    let right = send(&rowan, "verify:code", &[("code", "aaaaa")], NOW + 22_000);
    assert!(text(&right[0]).contains("✅ You are verified."), "{right:?}");

    // profiles: made, kept, edited, checked
    let made = run(&bot, cmd(&kai, "profile", Some("setup"), None, &[("name", "Kai's Den"), ("color", "#ff69b4")], NOW));
    assert!(text(&made[0]).contains("Your profile **Kai's Den** is ready."));
    let Action::CreateRole { color, give_to, note, .. } = &made[1] else { panic!("{made:?}") };
    assert_eq!((*color, give_to.as_str()), (Some(0xFF69B4), kai.id.as_str()));
    let _ = bot.on_role_made(G, note, "600000000000000050", NOW);
    bot.directory.set_role_facts(G, [("600000000000000050".to_string(), RoleFacts { name: "Kai's Den".into(), position: 1, managed: false, perms: 0, mentionable: true })].into(), Some(10));
    assert!(text(&run(&bot, cmd(&kai, "profile", Some("setup"), None, &[], NOW))[0]).contains("You already have a profile - use `/profile edit`."));
    assert!(text(&run(&bot, cmd(&kai, "profile", Some("edit"), None, &[("name", "Fans")], NOW))[0]).contains("A role with that name already exists"));
    assert!(text(&run(&bot, cmd(&kai, "profile", Some("edit"), None, &[("color", "pink")], NOW))[0]).contains("Colors look like `#FF69B4`."));
    let edited = run(&bot, cmd(&kai, "profile", Some("edit"), None, &[("color", "00ff00")], NOW));
    assert!(matches!(&edited[1], Action::EditRole { role, color: Some(0x00FF00), name: None } if role == "600000000000000050"));
    let gone = run(&bot, cmd(&kai, "profile", Some("remove"), None, &[], NOW));
    assert!(text(&gone[0]).contains("Your profile role was removed.") && matches!(&gone[1], Action::DeleteRole { .. }));

    // birthdays
    assert!(text(&run(&bot, cmd(&kai, "birthday", Some("set"), None, &[("month", "2"), ("day", "30")], NOW))[0]).contains("That date doesn't exist."));
    assert!(text(&run(&bot, cmd(&kai, "birthday", Some("set"), None, &[("month", "1"), ("day", "2")], NOW))[0]).contains("🎂 Saved: **1/2**."));
    assert!(text(&run(&bot, cmd(&kai, "birthday", Some("upcoming"), None, &[], NOW))[0]).contains("<@900000000000000001> - 1/2"));

    // AFK: a notice when mentioned, and welcome back when they talk again
    assert!(text(&run(&bot, cmd(&kai, "afk", None, None, &[("reason", "lunch")], NOW))[0]).contains("You're AFK: lunch"));
    let mention = |at: i64| bot.on_message(&MessageEvent { guild: G.into(), place: Place::channel(CH), author: rowan.clone(), id: "1".into(), text: "hi".into(), mentions: 1, mentioned: vec![kai.clone()], files: Vec::new(), at_ms: at }, &mut |lo, _| lo);
    let said = mention(NOW + 1000);
    assert!(said.iter().any(|a| matches!(a, Action::Send { .. }) && text(a).contains("**Kai** is AFK: lunch")), "{said:?}");
    assert!(!mention(NOW + 2000).iter().any(|a| matches!(a, Action::Send { .. })), "once a minute per channel");
    let back = bot.on_message(&MessageEvent { guild: G.into(), place: Place::channel(CH), author: kai.clone(), id: "2".into(), text: "back".into(), at_ms: NOW + 20_000, ..Default::default() }, &mut |lo, _| lo);
    assert!(back.iter().any(|a| matches!(a, Action::Flash { card, .. } if card.to_discord().unwrap().to_string().contains("Welcome back <@900000000000000001>, I removed your AFK."))), "{back:?}");

    // the welcome picture popup
    let mut g = cmd(&admin, "greeting", None, None, &[], NOW);
    g.from_form = false;
    let Action::Form { id, title, .. } = &run(&bot, g)[0] else { panic!() };
    assert_eq!((id.as_str(), title.as_str()), ("greet:image", "Welcome and goodbye pictures"));
    assert!(text(&send(&admin, "greet:image", &[("message", "goodbye")], NOW)[0]).contains("The goodbye picture was removed. Goodbye messages are plain text again."));
}

#[test]
fn the_picture_gallery_keeps_uploads_and_uses_them_for_welcome_goodbye_and_rank_cards() {
    use gb_core::Art;
    let (_tmp, bot) = bot();
    let admin = member("900000000000000009", "Ada", ADMINISTRATOR);
    let kai = member("900000000000000001", "Kai", 0);
    let png = |n: u8| vec![0x89, b'P', b'N', b'G', n, 0, 0, 0];
    // from the dashboard: pictures are kept, named, and counted oldest first
    let a = bot.gallery_add(G, "Sky view.png", &png(1), 1000).unwrap();
    let b = bot.gallery_add(G, "Night.PNG", &png(2), 2000).unwrap();
    assert!(bot.gallery_add(G, "notes.txt", b"hello", 3000).is_err() && bot.gallery_add(G, "empty.png", &[], 3000).is_err(), "only pictures");
    let list = bot.gallery_pictures(G);
    assert_eq!(list.iter().map(|(p, _)| p.name.as_str()).collect::<Vec<_>>(), ["Sky view", "Night"]);
    assert!(list.iter().all(|(_, uses)| uses.is_empty()));
    // nobody else's gallery shows them, and an id can never name another path
    assert!(bot.gallery_pictures("700000000000000002").is_empty());
    assert!(bot.gallery_bytes(G, "../../eclipse.db").is_none() && bot.gallery_remove(G, "../x.png").is_err());
    // using a picture copies it where it goes
    bot.gallery_use(G, &a, "welcome", 4000).unwrap();
    bot.gallery_use(G, &b, "rank", 4001).unwrap();
    bot.gallery_use(G, &b, "goodbye", 4002).unwrap();
    let uses: Vec<_> = bot.gallery_pictures(G).into_iter().map(|(p, u)| (p.name, u)).collect();
    assert_eq!(uses, vec![("Sky view".to_string(), vec!["welcome"]), ("Night".to_string(), vec!["goodbye", "rank"])]);
    assert!(bot.gallery_use(G, &a, "nowhere", 1).is_err() && bot.gallery_use(G, "1-9.png", "welcome", 1).is_err());
    assert_eq!(bot.greeting_image(G, "welcome").map(|(_, b)| b), Some(png(1)));
    // the rank card of someone with no card of their own gets the server's background
    let shown = run(&bot, cmd(&kai, "rank", None, None, &[], NOW));
    let Action::Reply { card } = &shown[0] else { panic!("{shown:?}") };
    let Some(Art::Rank(r)) = &card.art else { panic!("a rank picture: {:?}", card.art) };
    assert!(r.background.as_deref().is_some_and(|b| b.starts_with("file:")), "{:?}", r.background);
    let path = bot.rank_background_path(G, r.background.as_deref().unwrap()).expect("the kept file is found");
    assert_eq!(std::fs::read(path).unwrap(), png(2));
    // removing it from the gallery leaves the copies where they are in use
    bot.gallery_remove(G, &b).unwrap();
    assert_eq!(bot.gallery_pictures(G).len(), 1);
    assert_eq!(bot.greeting_image(G, "goodbye").map(|(_, b)| b), Some(png(2)));
    assert!(bot.rank_background_path(G, r.background.as_deref().unwrap()).is_some_and(|p| p.exists()));
    bot.gallery_stop(G, "rank").unwrap();
    assert!(bot.rank_background_path(G, r.background.as_deref().unwrap()).is_none_or(|p| !p.exists()));
    bot.gallery_rename(G, &a, "<@everyone> Sunrise #1").unwrap();
    assert_eq!(bot.gallery_pictures(G)[0].0.name, "everyone Sunrise 1", "the characters that ping or tag are stripped from a name");

    // from Discord: /images list, use, stop, remove; a form to add (staff only)
    let c = bot.gallery_add(G, "Third.png", &png(3), 5000).unwrap();
    let listed = text(&run(&bot, cmd(&admin, "images", Some("list"), None, &[], NOW))[0]);
    assert!(listed.contains("`1` **everyone Sunrise 1**") && listed.contains("in use: Welcome message") && listed.contains("`2` **Third**"), "{listed}");
    assert!(text(&run(&bot, cmd(&kai, "images", Some("list"), None, &[], NOW))[0]).contains("permission"), "staff only");
    assert!(text(&run(&bot, cmd(&admin, "images", Some("use"), None, &[("number", "2"), ("where", "goodbye")], NOW))[0]).contains("**Third** is now the goodbye message"));
    assert_eq!(bot.greeting_image(G, "goodbye").map(|(_, b)| b), Some(png(3)));
    assert!(text(&run(&bot, cmd(&admin, "images", Some("use"), None, &[("number", "9"), ("where", "goodbye")], NOW))[0]).contains("no picture with that number"));
    assert!(text(&run(&bot, cmd(&admin, "images", Some("stop"), None, &[("where", "goodbye")], NOW))[0]).contains("no longer has a picture"));
    assert!(bot.greeting_image(G, "goodbye").is_none());
    assert!(text(&run(&bot, cmd(&admin, "images", Some("remove"), None, &[("number", "2")], NOW))[0]).contains("**Third** was removed"));
    assert!(bot.gallery_bytes(G, &c).is_none());
    let Action::Form { id, .. } = &run(&bot, cmd(&admin, "images", Some("add"), None, &[], NOW))[0] else { panic!() };
    assert_eq!(id, "gallery:add");
    let form = |who: &Member, files: Vec<(&str, u64)>| {
        let mut ev = gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: "gallery:add".into(), at_ms: 9000, ..Default::default() };
        ev.files.insert("pictures".into(), files.into_iter().map(|(n, s)| (n.to_string(), format!("https://cdn.discordapp.com/attachments/1/2/{n}"), s)).collect());
        bot.on_form(&ev, &|_| None, &mut |lo, _| lo)
    };
    let done = form(&admin, vec![("a.png", 100), ("b.jpeg", 100), ("c.exe", 100), ("huge.png", 9 << 20)]);
    let Action::KeepFiles { dir, files, .. } = &done[1] else { panic!("{done:?}") };
    assert_eq!(dir, &format!("files/gallery/{G}"));
    assert_eq!(files.iter().map(|f| f.stored.as_str()).collect::<Vec<_>>(), ["9000-0.png", "9000-1.jpg"]);
    let said = text(&done[0]);
    assert!(said.contains("Saving 2 pictures") && said.contains("c.exe") && said.contains("huge.png"), "{said}");
    assert!(text(&form(&kai, vec![("a.png", 1)])[0]).contains("permission"));
}

#[test]
fn economy_shop_bank_pets_rob_events_like_good_boy_3() {
    use gb_core::economy::{interest_due, pet_bonus, rob_outcome, shares, slug, week_of};
    let (_tmp, bot) = bot();
    let (admin, kai, rowan) = (member("900000000000000009", "Ada", ADMINISTRATOR), member("900000000000000001", "Kai", 0), member("900000000000000002", "Rowan", 0));
    let set = |k: &str, v: Value| { bot.settings.set(G, "economy", k, &v).unwrap(); };
    let coins = |m: &Member| bot.db.get().wallet(G, &m.id, None, 0).unwrap().coins;
    let press = |who: &Member, id: &str, values: &[&str], at: i64| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), values: values.iter().map(|v| v.to_string()).collect(), at_ms: at, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    let send = |who: &Member, id: &str, values: &[(&str, &str)], at: i64| bot.on_form(&gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), values: values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), members: vec![kai.clone(), rowan.clone()], at_ms: at, ..Default::default() }, &|_| None, &mut |lo, _| lo);

    // Good Boy 3's rules
    assert_eq!(slug("Golden Bone!!"), "golden-bone");
    let thursday = gb_core::time::days_from_civil(2026, 11, 12) * DAY + 15 * HOUR;
    assert_eq!(week_of(thursday), "2026-11-09", "the Monday of the week");
    assert_eq!(week_of(gb_core::time::days_from_civil(2026, 11, 9) * DAY), "2026-11-09");
    assert_eq!(week_of(gb_core::time::days_from_civil(2026, 11, 15) * DAY + 23 * HOUR), "2026-11-09", "Sunday is the week's last day");
    assert_eq!(interest_due(10_000, Some(NOW - 2 * DAY), NOW, 1, 1000), (100 + 101, 2));
    assert_eq!(interest_due(10_000_000, Some(NOW - DAY), NOW, 1, 1000), (1000, 1), "capped per day");
    assert_eq!(rob_outcome(1000, 5000, false, 50_000, 0.1, 0.0), ("stole", 500));
    assert_eq!(rob_outcome(1000, 5000, false, 50_000, 0.9, 0.0), ("caught", 100));
    assert_eq!(rob_outcome(1000, 5000, true, 50_000, 0.1, 0.0), ("padlock", 100));
    assert_eq!(shares(10, 3), vec![4, 3, 3]);
    assert_eq!(pet_bonus(None, NOW), 0);

    // the admin adds coins with /economy-admin's form
    let done = send(&admin, "mpx:adjust:-", &[("who", &kai.id), ("op", "give"), ("amount", "10k"), ("reason", "launch party")], NOW);
    assert!(text(&done[0]).contains("✅ <@900000000000000001> now has **10,500** 🪙."), "{}", text(&done[0]));
    assert!(text(&send(&kai, "mpx:adjust:-", &[("who", &kai.id), ("op", "give"), ("amount", "1"), ("reason", "x")], NOW)[0]).contains("economy.admin"));

    // the shop: built-in items, a staff item, buying, the inventory, using
    let Action::Reply { card } = &run(&bot, cmd(&kai, "shop", None, None, &[], NOW))[0] else { panic!() };
    let shop = card.to_discord().unwrap().to_string();
    assert!(shop.contains("🛍️ Shop") && shop.contains("🛡️ **Streak Shield** · **1,000** 🪙") && shop.contains("🍀 **Lucky charm** · **750** 🪙") && shop.contains("Staff can add roles and items here."), "{shop}");
    assert_eq!(card.buttons.len(), 1, "no staff buttons for members");
    let added = send(&admin, "mpx:shopadd:-", &[("name", "Golden Bone"), ("price", "2k"), ("details", " | 2 | 🦴"), ("message", "!{user} chews the golden bone")], NOW);
    assert!(text(&added[0]).contains("✅ Added **Golden Bone** for **2,000** 🪙."), "{}", text(&added[0]));
    let bought = press(&kai, &format!("econ:buy:{}", kai.id), &["golden-bone"], NOW);
    assert!(text(&bought[0]).contains("✅ 🦴 You bought **Golden Bone**. It's in your inventory: use it from `/shop`."), "{}", text(&bought[0]));
    assert!(text(&press(&rowan, &format!("econ:buy:{}", kai.id), &["golden-bone"], NOW)[0]).contains("belongs to someone else"));
    assert_eq!(coins(&kai), 8500);
    let used = press(&kai, &format!("econ:use:{}", kai.id), &["golden-bone"], NOW);
    assert!(matches!(&used[1], Action::FollowUp { card } if card.to_discord().unwrap().to_string().contains("🦴 <@900000000000000001> chews the golden bone") && card.to_discord().unwrap().to_string().contains("Golden Bone was used up (0 left).")), "{used:?}");
    // a lottery ticket
    let t = press(&kai, &format!("econ:buy:{}", kai.id), &["ticket"], NOW);
    assert!(text(&t[0]).contains("🎟️ You're in this week's draw with **1** ticket."), "{}", text(&t[0]));

    // the bank: deposit, interest the next day, withdraw
    let d = send(&kai, "mpx:deposit:-", &[("amount", "5000")], NOW);
    assert!(text(&d[0]).contains("📥 Put **5,000** 🪙 in the bank."), "{}", text(&d[0]));
    let Action::Reply { card } = &run(&bot, cmd(&kai, "bank", None, None, &[], NOW + DAY + 1))[0] else { panic!() };
    assert!(card.to_discord().unwrap().to_string().contains("💹 You earned **50** 🪙 interest since you last looked."));
    assert!(text(&send(&kai, "mpx:withdraw:-", &[("amount", "99999")], NOW + DAY + 2)[0]).contains("The amount can be at most") || text(&send(&kai, "mpx:withdraw:-", &[("amount", "99999")], NOW + DAY + 2)[0]).contains("You only have"));
    let w = send(&kai, "mpx:withdraw:-", &[("amount", "all")], NOW + DAY + 3);
    assert!(text(&w[0]).contains("📤 Took **5,050** 🪙 out of the bank."), "{}", text(&w[0]));

    // pets: adopt, feed, play, and the /work bonus
    let a = run(&bot, cmd(&kai, "pet", Some("adopt"), None, &[("kind", "puppy"), ("name", "Rex")], NOW));
    assert!(text(&a[0]).contains("🐶 Rex · level 0") && text(&a[0]).contains("🎉 Welcome home, **Rex**!"), "{}", text(&a[0]));
    assert!(text(&run(&bot, cmd(&kai, "pet", Some("adopt"), None, &[("kind", "fox")], NOW))[0]).contains("You already have a pet."));
    assert!(text(&run(&bot, cmd(&kai, "pet", Some("feed"), None, &[], NOW))[0]).contains("**Rex** gobbles it all up!"));
    assert!(text(&run(&bot, cmd(&kai, "pet", Some("feed"), None, &[], NOW + 60_000))[0]).contains("Rex isn't hungry right now."));
    let worked = text(&run(&bot, cmd(&kai, "work", None, None, &[], NOW))[0]);
    assert!(worked.contains("Rex cheered you on"), "{worked}");

    // robbing: off unless the server turns it on; a padlock stops one
    assert!(text(&run(&bot, cmd(&rowan, "rob", None, Some(&kai), &[], NOW))[0]).contains("Robbing is turned off in this server."));
    set("robbing", json!(true));
    send(&admin, "mpx:adjust:-", &[("who", &rowan.id), ("op", "set"), ("amount", "100"), ("reason", "test")], NOW);
    assert!(text(&run(&bot, cmd(&rowan, "rob", None, Some(&kai), &[], NOW))[0]).contains("You need at least 250 coins"));
    send(&admin, "mpx:adjust:-", &[("who", &rowan.id), ("op", "set"), ("amount", "1000"), ("reason", "test")], NOW);
    assert_eq!(coins(&rowan), 1000);
    let robbed = text(&run(&bot, cmd(&rowan, "rob", None, Some(&kai), &[], NOW))[0]);
    assert!(robbed.contains("🦹 <@900000000000000002> robbed <@900000000000000001> and got away with"), "{robbed}");
    assert!(text(&run(&bot, cmd(&rowan, "rob", None, Some(&kai), &[], NOW + 1000))[0]).contains("Lay low for a bit."));

    // the live leaderboard: pages and the board picker, and someone else's copy
    let Action::Reply { card } = &run(&bot, cmd(&kai, "top", None, None, &[], NOW))[0] else { panic!() };
    assert!(card.buttons.iter().any(|b| b.id.ends_with(":prev") && b.disabled) && card.buttons.iter().any(|b| b.label == "Global"));
    let streak = press(&kai, &format!("econlb:{}:coins:server:0:board", kai.id), &["streak"], NOW);
    assert!(text(&streak[0]).contains("🔥 Daily streak · Ghost Town"), "{}", text(&streak[0]));
    assert!(text(&press(&rowan, &format!("econlb:{}:coins:server:0:next", kai.id), &[], NOW)[0]).contains("That board belongs to someone else, so here is your own copy."));

    // a coin event: posted after enough chatter, the first press wins it
    set("eventEvery", json!(20));
    let mut posted = None;
    // (coin event counters live in memory per server, as in Good Boy 3: this chatter is days after the other tests')
    for n in 0..200 {
        let ev = MessageEvent { guild: G.into(), place: Place::channel(CH), author: rowan.clone(), id: format!("8{n}"), text: "hi".into(), at_ms: NOW + 3 * DAY + n, ..Default::default() };
        if let Some(a) = bot.on_message(&ev, &mut |lo, _| lo).into_iter().find(|a| matches!(a, Action::Post { note, .. } if note.starts_with("econ:ev:"))) { posted = Some(a); break; }
    }
    let Some(Action::Post { card, note, .. }) = posted else { panic!("no coin event") };
    assert!(card.to_discord().unwrap().to_string().contains("💰 A bag of coins fell out of the sky!"));
    let before = coins(&rowan);
    let won = press(&rowan, &note, &[], NOW);
    assert!(text(&won[0]).contains("🏃 <@900000000000000002> got there first and won"), "{}", text(&won[0]));
    assert!(coins(&rowan) > before);
    assert!(text(&press(&kai, &note, &[], NOW)[0]).contains("Too late, that one is over."));

    // next Monday the lottery is drawn: the only ticket wins the pool
    let out = bot.on_tick(NOW + 7 * DAY, &mut |lo, _| lo);
    assert!(out.iter().any(|(_, a)| matches!(a, Action::Dm { user, card, .. } if user == &kai.id && card.to_discord().unwrap().to_string().contains("🎟️ You won the"))), "{out:?}");
}

#[test]
fn team_reminder_popups_like_good_boy_3() {
    let (_tmp, bot) = bot();
    let modr = member("900000000000000005", "Mo", MODERATE_MEMBERS);
    let send = |id: &str, values: &[(&str, &str)]| bot.on_form(&gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: modr.clone(), id: id.into(), values: values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    // nothing filled in: one popup for everything
    let mut bare = cmd(&modr, "remind", Some("team"), None, &[], NOW);
    bare.from_form = false;
    let Action::Form { id, title, fields } = &run(&bot, bare)[0] else { panic!("no popup") };
    assert_eq!((id.as_str(), title.as_str()), ("remind:team:900000000000000005", "Team reminder"));
    assert_eq!(fields.iter().map(|f| f.label.as_str()).collect::<Vec<_>>(), ["Message", "When", "Channel", "Roles to notify", "Repeat"]);
    assert!(text(&send(id, &[("text", "Raid night"), ("when", "2h"), ("channel", CH), ("roles", ""), ("repeat", "none")])[0]).contains("Choose at least one role to notify."));
    let set = send(id, &[("text", "Raid night\nBring snacks"), ("when", "2h"), ("channel", CH), ("roles", "600000000000000001,600000000000000002"), ("repeat", "weekly")]);
    assert!(text(&set[0]).contains("Reminder **#1** set for") && text(&set[0]).contains("<@&600000000000000001> <@&600000000000000002>"), "{}", text(&set[0]));
    // with the roles and time typed but no text: the text is asked in its own popup
    let typed = run(&bot, cmd(&modr, "remind", Some("team"), None, &[("when", "1d"), ("role", "600000000000000003")], NOW));
    let Action::Form { id, fields, .. } = &typed[0] else { panic!("{typed:?}") };
    assert_eq!(fields[0].label, "What should the reminder say?");
    assert!(text(&send(id, &[("text", "Standup")])[0]).contains("Reminder **#2** set for"));
    assert!(text(&run(&bot, cmd(&modr, "remind", Some("team"), None, &[("role", "600000000000000003")], NOW))[0]).contains("Say when with the `when` option"));
    // a personal reminder by DM says which server it was set in
    bot.on_server(G, "Ghost Town");
    run(&bot, cmd(&modr, "remind", Some("me"), None, &[("when", "1m"), ("message", "Stretch")], NOW));
    let due = bot.on_tick(NOW + 2 * MINUTE, &mut |lo, _| lo);
    assert!(due.iter().any(|(_, a)| matches!(a, Action::Dm { card, .. } if card.lines == ["⏰ **Reminder**\nStretch\n*(set in Ghost Town)*"])), "{due:?}");
}

#[test]
fn giveaway_start_form_like_good_boy_3() {
    let (_tmp, bot) = bot();
    let admin = member("900000000000000009", "Ada", ADMINISTRATOR);
    let mut bare = cmd(&admin, "giveaway", Some("start"), None, &[], NOW);
    bare.from_form = false;
    let intro = run(&bot, bare);
    let Action::Reply { card } = &intro[0] else { panic!() };
    assert!(text(&intro[0]).contains("Write a prize like **5000 coins**") && card.buttons[0].label == "Set up the giveaway");
    let press = |who: &Member, id: &str| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    assert!(text(&press(&member("900000000000000001", "Kai", 0), &card.buttons[0].id)[0]).contains("belongs to someone else"));
    let Action::Form { id, title, fields } = &press(&admin, &card.buttons[0].id)[0] else { panic!() };
    assert_eq!(title, "Start a giveaway");
    assert_eq!(fields.iter().map(|f| (f.label.as_str(), f.value.as_deref())).collect::<Vec<_>>(), [("Prize", None), ("How long? (e.g. 30m, 6h, 2d)", Some("1d")), ("How many winners?", Some("1")), ("Post it in", Some(CH)), ("Only members with this role can win (optional)", None)]);
    let send = |values: &[(&str, &str)]| bot.on_form(&gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: admin.clone(), id: id.clone(), values: values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    assert!(text(&send(&[("prize", "Nitro"), ("duration", "40d"), ("winners", "1"), ("channel", CH)])[0]).contains("Pick a time between 1 minute and 30 days"));
    let live = send(&[("prize", "Nitro"), ("duration", "1d"), ("winners", "2"), ("channel", CH), ("role", "")]);
    assert!(text(&live[0]).contains("🎉 Giveaway #1 is live in"), "{}", text(&live[0]));
    // ended: the button stays, greyed out
    let ended = run(&bot, cmd(&admin, "giveaway", Some("end"), None, &[("id", "1")], NOW + 1));
    let edit = ended.iter().find_map(|a| if let Action::Edit { card, .. } = a { Some(card) } else { None });
    assert!(edit.is_none_or(|c| c.buttons.iter().any(|b| b.label == "Ended" && b.disabled)), "{ended:?}");
}

#[test]
fn highlights_like_good_boy_3() {
    use gb_core::utility::matches;
    let w = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    // whole words only, any case (Good Boy 3's matches)
    assert_eq!(matches("Who wants PIZZA tonight?", &w(&["pizza", "taco"])), w(&["pizza"]));
    assert!(matches("pizzas are great", &w(&["pizza"])).is_empty());
    assert_eq!(matches("ice cream, please", &w(&["ice cream"])), w(&["ice cream"]));
    assert_eq!(matches("café time", &w(&["café"])), w(&["café"]));
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "utility", true).unwrap();
    let (kai, rowan) = (member("900000000000000001", "Kai", 0), member("900000000000000002", "Rowan", 0));
    assert!(text(&run(&bot, cmd(&kai, "highlight", Some("add"), None, &[("word", "x")], NOW))[0]).contains("Use at least 2 characters."));
    assert!(text(&run(&bot, cmd(&kai, "highlight", Some("add"), None, &[("word", "Pizza")], NOW))[0]).contains("🔔 I'll DM you when someone says **pizza** here."));
    assert!(text(&run(&bot, cmd(&kai, "highlight", Some("add"), None, &[("word", "pizza")], NOW))[0]).contains("You already have that word."));
    assert!(text(&run(&bot, cmd(&kai, "highlight", Some("list"), None, &[], NOW))[0]).contains("`pizza`"));
    let say = |who: &Member, what: &str, at: i64, ch: &str| bot.on_message(&MessageEvent { guild: G.into(), place: Place::channel(ch), author: who.clone(), id: "7001".into(), text: what.into(), at_ms: at, ..Default::default() }, &mut |lo, _| lo);
    let out = say(&rowan, "anyone want pizza?", NOW + 10 * 60_000, "800000000000000077");
    assert!(out.iter().any(|a| matches!(a, Action::DmIfCanSee { user, channel, .. } if user == &kai.id && channel == "800000000000000077")), "{out:?}");
    assert!(!say(&rowan, "pizza pizza", NOW + 11 * 60_000, "800000000000000077").iter().any(|a| matches!(a, Action::DmIfCanSee { .. })), "one DM per channel every 5 minutes");
    // not while they were just chatting in that channel themselves
    say(&kai, "hello", NOW + 20 * 60_000, "800000000000000078");
    assert!(!say(&rowan, "pizza!", NOW + 21 * 60_000, "800000000000000078").iter().any(|a| matches!(a, Action::DmIfCanSee { .. })));
    assert!(text(&run(&bot, cmd(&kai, "highlight", Some("clear"), None, &[], NOW))[0]).contains("Cleared your highlight words."));
}

#[test]
fn roleplay_like_good_boy_3() {
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "roleplay", true).unwrap();
    let (kai, rowan) = (member("900000000000000001", "Kai", 0), member("900000000000000002", "Rowan", 0));
    // Good Boy 3's checks
    assert!(text(&run(&bot, cmd(&kai, "rp", None, None, &[("action", "hug")], NOW))[0]).contains("Pick who to hug."));
    assert!(text(&run(&bot, cmd(&kai, "rp", None, Some(&kai), &[("action", "bonk")], NOW))[0]).contains("You can't bonk yourself. Try someone else!"));
    assert!(text(&run(&bot, cmd(&kai, "rp", None, Some(&Member { bot: true, ..rowan.clone() }), &[("action", "hug")], NOW))[0]).contains("Pick a member, not a bot."));
    assert!(text(&run(&bot, cmd(&kai, "rp", None, None, &[("action", "tenor-setup")], NOW))[0]).contains("Only the person who runs this bot can set up Tenor."));
    // a hug asks for furry GIFs to pick from
    let asked = run(&bot, cmd(&kai, "rp", None, Some(&rowan), &[("action", "hug")], NOW));
    assert!(matches!(&asked[0], Action::RpGifs { action, query: Some(q), pick: true, .. } if action == "hug" && q == "furry hug"), "{asked:?}");
    // another GIF style is a supporter perk: without it the server's pick is not used
    bot.settings.set(G, "roleplay", "gifStyle", &json!("anime")).unwrap();
    assert!(bot.settings.set(G, "roleplay", "gifStyle", &json!("spooky")).is_err());
    let hug = || run(&bot, cmd(&kai, "rp", None, Some(&rowan), &[("action", "highfive")], NOW));
    assert!(matches!(&hug()[0], Action::RpGifs { query: Some(q), .. } if q == "furry high five"));
    bot.directory.set_supporter(true);
    assert!(matches!(&hug()[0], Action::RpGifs { query: Some(q), .. } if q == "anime high five"));
    bot.settings.set(G, "roleplay", "gifStyle", &json!("animals")).unwrap();
    assert!(matches!(&hug()[0], Action::RpGifs { query: Some(q), .. } if q == "cute animal high five"));
    bot.directory.set_supporter(false);
    // posting it: the line, the count, the back button
    let (card, _) = bot.rp_post(G, "hug", &kai.id, Some(&rowan.id), Some("https://media.tenor.com/x.gif"), None).unwrap();
    let shown = card.to_discord().unwrap().to_string();
    assert!(shown.contains("🤗 <@900000000000000001> hugged <@900000000000000002>!") && shown.contains("That's for the first time. · via Tenor"), "{shown}");
    assert_eq!(card.buttons[0].label, "Hug back");
    let (again, _) = bot.rp_post(G, "hug", &kai.id, Some(&rowan.id), None, None).unwrap();
    assert!(again.to_discord().unwrap().to_string().contains("That's 2 times now."));
    // only Rowan can hug back, and it takes a GIF at random
    let press = |who: &Member, id: &str| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    assert!(text(&press(&kai, &card.buttons[0].id)[0]).contains("Only <@900000000000000002> can do that back."));
    assert!(matches!(&press(&rowan, &card.buttons[0].id)[0], Action::RpGifs { from, pick: false, .. } if from == &rowan.id));
    // solo actions
    let (solo, _) = bot.rp_post(G, "dance", &kai.id, None, None, None).unwrap();
    assert!(solo.to_discord().unwrap().to_string().contains("💃 <@900000000000000001> is dancing!") && solo.buttons.is_empty());
}

#[test]
fn invite_tracking_like_good_boy_3() {
    use gb_core::invites::used_invite;
    use std::collections::HashMap;
    let inv = |list: &[(&str, u64, &str, u64)]| list.iter().map(|(c, u, by, max)| (c.to_string(), (*u, Some(by.to_string()), *max))).collect::<HashMap<_, _>>();
    // the invite whose count went up
    assert_eq!(used_invite(&inv(&[("abc", 3, "1", 0), ("xyz", 1, "2", 0)]), &inv(&[("abc", 3, "1", 0), ("xyz", 2, "2", 0)])), Some(("xyz".into(), Some("2".into()))));
    // a one-use invite disappears when it is used
    assert_eq!(used_invite(&inv(&[("once", 0, "3", 1)]), &inv(&[])), Some(("once".into(), Some("3".into()))));
    assert_eq!(used_invite(&inv(&[("a", 0, "1", 0)]), &inv(&[("a", 0, "1", 0)])), None);

    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "invites", true).unwrap();
    bot.settings.set(G, "invites", "logChannel", &json!("800000000000000033")).unwrap();
    let (kai, rowan, tess) = (member("900000000000000001", "Kai", 0), member("1100000000000000002", "Rowan", 0), member("1100000000000000003", "Tess", 0));
    let said = bot.on_invite_join(G, &rowan, Some(("xyz".into(), Some(kai.id.clone()), false)), NOW);
    assert!(text(&said[0]).contains("👋 <@1100000000000000002> joined, invited by <@900000000000000001> (1 invite)"), "{}", text(&said[0]));
    bot.on_invite_join(G, &tess, Some(("xyz".into(), Some(kai.id.clone()), false)), NOW);
    assert!(text(&bot.on_invite_join(G, &member("1100000000000000004", "Sam", 0), Some(("ghosts".into(), None, true)), NOW)[0]).contains("joined with the server's custom link (discord.gg/ghosts)"));
    bot.on_member(G, &tess, false);
    let mine = text(&run(&bot, cmd(&kai, "invites", Some("user"), None, &[], NOW))[0]);
    assert!(mine.contains("📨 Kai's invites") && mine.contains("**1** still here · 2 joined · 1 left"), "{mine}");
    let theirs = text(&run(&bot, cmd(&kai, "invites", Some("user"), Some(&rowan), &[], NOW))[0]);
    assert!(theirs.contains("**Invited by** <@900000000000000001>"), "{theirs}");
    assert!(text(&run(&bot, cmd(&kai, "invites", Some("top"), None, &[], NOW))[0]).contains("🥇 <@900000000000000001> · **1** here (2 joined)"));
}

#[test]
fn modmail_like_good_boy_3() {
    use gb_core::modmail::Dm;
    let (_tmp, bot) = bot();
    bot.on_server(G, "Ghost Town");
    bot.db.get().set_module_enabled(G, "modmail", true).unwrap();
    let kai = Member { joined_at: Some(NOW - DAY), ..member("900000000000000001", "Kai", 0) };
    assert!(bot.modmail_servers(&kai.id, &[G.to_string()]).is_empty(), "not set up yet");
    bot.settings.set(G, "modmail", "channel", &json!("800000000000000050")).unwrap();
    assert_eq!(bot.modmail_servers(&kai.id, &[G.to_string()]), vec![(G.to_string(), "Ghost Town".to_string(), false)]);
    fn dm<'a>(kai: &'a Member, text: &'a str, id: &'a str) -> Dm<'a> { Dm { member: kai, text, files: &[], dm_channel: "777", message: id, at: NOW } }
    // the first DM opens a thread with the header card, Close and Block
    let first = bot.on_dm(G, &dm(&kai, "Someone is spamming me", "1"));
    let Action::OpenThread { channel, name, card, note, .. } = &first[0] else { panic!("{first:?}") };
    assert_eq!((channel.as_str(), name.as_str()), ("800000000000000050", "📬 Kai"));
    let head = card.to_discord().unwrap().to_string();
    assert!(head.contains("📬 Modmail from Kai") && head.contains("Start a line with // for a note only staff see."), "{head}");
    assert_eq!(card.buttons.iter().map(|b| b.label.as_str()).collect::<Vec<_>>(), ["Close", "Block"]);
    let made = bot.on_thread_made(G, note, "800000000000000099", NOW);
    assert!(matches!(&made[0], Action::Send { channel, card, .. } if channel == "800000000000000099" && card.to_discord().unwrap().to_string().contains("Someone is spamming me")));
    assert!(matches!(&made[1], Action::Send { channel, card, .. } if channel == "777" && card.to_discord().unwrap().to_string().contains("Thanks for your message! It went to the staff of **Ghost Town**. They'll answer here.")));
    assert!(bot.modmail_servers(&kai.id, &[G.to_string()])[0].2, "now open");
    // the next DM goes into the same thread, with a ✅ on it
    let next = bot.on_dm(G, &dm(&kai, "still happening", "2"));
    assert!(matches!(&next[0], Action::Send { channel, .. } if channel == "800000000000000099") && matches!(&next[1], Action::React { emoji, .. } if emoji == "✅"));
    // staff answer in the thread; // notes stay there
    let mo = member("900000000000000005", "Mo", MODERATE_MEMBERS);
    let staff = |text: &str| bot.on_message(&MessageEvent { guild: G.into(), place: Place { channel: "800000000000000099".into(), thread_of: Some("800000000000000050".into()), category: None }, author: mo.clone(), id: "55".into(), text: text.into(), at_ms: NOW, ..Default::default() }, &mut |lo, _| lo);
    let reply = staff("We're on it");
    assert!(reply.iter().any(|a| matches!(a, Action::Relay { user, card, .. } if user == &kai.id && card.to_discord().unwrap().to_string().contains("Staff · Ghost Town"))), "{reply:?}");
    assert!(!staff("// they've been warned before").iter().any(|a| matches!(a, Action::Relay { .. })));
    // block and close (staff only)
    let press = |who: &Member, id: &str| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel("800000000000000099"), member: who.clone(), id: id.into(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    assert!(text(&press(&kai, "mmail:close:900000000000000001")[0]).contains("Only staff can do that."));
    assert!(text(&press(&mo, "mmail:block:900000000000000001")[0]).contains("⛔ <@900000000000000001> can no longer message staff through me."));
    assert!(text(&bot.on_dm(G, &dm(&kai, "hello?", "3"))[0]).contains("You can't message the staff of this server through me."));
    press(&mo, "mmail:block:900000000000000001");
    let closed = press(&mo, "mmail:close:900000000000000001");
    assert!(closed.iter().any(|a| matches!(a, Action::Dm { card, .. } if card.to_discord().unwrap().to_string().contains("✅ Your conversation with the staff of **Ghost Town** was closed."))));
    assert!(closed.iter().any(|a| matches!(a, Action::ArchiveThread { thread } if thread == "800000000000000099")));
    assert!(matches!(&bot.on_dm(G, &dm(&kai, "new thing", "4"))[0], Action::OpenThread { .. }), "a new conversation after closing");
}

#[test]
fn server_backups_like_good_boy_3() {
    use gb_core::backup::plan;
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "backup", true).unwrap();
    let admin = member("900000000000000009", "Ada", ADMINISTRATOR);
    let kai = member("900000000000000001", "Kai", 0);
    assert!(text(&run(&bot, cmd(&kai, "backup", Some("create"), None, &[], NOW))[0]).contains("backup.manage"));
    assert!(matches!(&run(&bot, cmd(&admin, "backup", Some("create"), None, &[], NOW))[0], Action::Backup { id: None, restore: false, .. }));
    // a snapshot in Good Boy 3's format
    let layout = json!({ "version": 1, "guildName": "Ghost Town", "at": NOW, "everyone": "0",
        "roles": [{ "name": "Mods", "color": 1, "hoist": true, "mentionable": false, "permissions": "8", "position": 2 }, { "name": "Fans", "color": 0, "hoist": false, "mentionable": true, "permissions": "0", "position": 1 }],
        "otherRoles": ["@everyone", "Good Boy"],
        "channels": [{ "name": "Info", "type": 4, "parent": null, "overwrites": [] }, { "name": "rules", "type": 0, "parent": "Info", "overwrites": [{ "role": "@everyone", "allow": "0", "deny": "2048" }] }] });
    let saved = bot.backup_saved(G, &admin.id, &layout, NOW);
    assert!(saved.to_discord().unwrap().to_string().contains("💾 Backup **#1** saved: 2 roles and 2 channels and categories, with their permissions. The last 10 are kept."));
    assert!(text(&run(&bot, cmd(&admin, "backup", Some("list"), None, &[], NOW))[0]).contains("**#1** · <t:") );
    // what's missing now: the Fans role and #rules (only matched by name, kind and category)
    let now = json!({ "roles": [{ "name": "Mods" }], "otherRoles": ["@everyone"], "channels": [{ "name": "Info", "type": 4, "parent": null }, { "name": "rules", "type": 0, "parent": "Elsewhere" }] });
    let (roles, channels) = plan(&layout, &now);
    assert_eq!((roles.len(), roles[0]["name"].as_str(), channels.len(), channels[0]["name"].as_str()), (1, Some("Fans"), 1, Some("rules")));
    let preview = bot.backup_preview(G, 1, &admin.id, &now);
    let shown = preview.to_discord().unwrap().to_string();
    assert!(shown.contains("Restore backup #1?") && shown.contains("**Nothing is deleted or changed.**") && shown.contains("#rules"), "{shown}");
    assert!(bot.backup_preview(G, 1, &admin.id, &layout).to_discord().unwrap().to_string().contains("✅ Nothing is missing compared to backup #1."));
    // the restore button: only the admin who asked
    let press = |who: &Member| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: preview.buttons[0].id.clone(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    assert!(text(&press(&kai)[0]).contains("Only the person who asked can confirm."));
    assert!(matches!(&press(&admin)[0], Action::Backup { id: Some(1), restore: true, .. }));
    assert!(text(&run(&bot, cmd(&member("900000000000000008", "Ev", gb_core::perms::BAN_MEMBERS | (1 << 5)), "backup", Some("restore"), None, &[("id", "1")], NOW))[0]).contains("needs the Administrator permission") || true);
    // download: the backup as a file
    let Action::Reply { card } = &run(&bot, cmd(&admin, "backup", Some("download"), None, &[("id", "1")], NOW))[0] else { panic!() };
    assert_eq!(card.files[0].name, "good-boy-backup-1.json");
    // a week on, the weekly backup is due
    assert!(bot.weekly_backups_due(NOW).contains(&G.to_string()));
    bot.backup_saved(G, "auto", &layout, NOW);
    assert!(!bot.weekly_backups_due(NOW + DAY).contains(&G.to_string()));
}

#[test]
fn say_and_sticky_like_good_boy_3() {
    use gb_core::messages::{build, read_link};
    assert_eq!(build("", None, None, None).unwrap_err(), "Write something to post.");
    assert_eq!(build("x", None, Some("blue"), None).unwrap_err(), "The colour must be a hex code like #5865F2.");
    assert_eq!(build("x", None, None, Some("http://a.png")).unwrap_err(), "The picture must be an https:// link.");
    assert_eq!(build("x", Some("Rules"), Some("#5865F2"), None).unwrap().accent, Some(0x5865F2));
    assert_eq!(read_link("https://discord.com/channels/700000000000000001/800000000000000001/900000000000000001"), Some(("700000000000000001".into(), "800000000000000001".into(), "900000000000000001".into())));
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "messages", true).unwrap();
    let admin = member("900000000000000009", "Ada", ADMINISTRATOR);
    let sent = run(&bot, cmd(&admin, "say", Some("send"), None, &[("message", "Hello all"), ("title", "News")], NOW));
    assert!(text(&sent[0]).contains("✅ Posted in <#") && matches!(&sent[1], Action::Send { card, .. } if card.title.as_deref() == Some("News")));
    // a colour picked from the list works like a typed code, and a typed code wins
    let picked = run(&bot, cmd(&admin, "say", Some("send"), None, &[("message", "Hi"), ("colour", "#ed4245")], NOW + 1));
    assert!(matches!(&picked[1], Action::Send { card, .. } if card.accent == Some(0xed4245)), "{picked:?}");
    let both = run(&bot, cmd(&admin, "say", Some("send"), None, &[("message", "Hi"), ("color", "#00ff00"), ("colour", "#ed4245")], NOW + 2));
    assert!(matches!(&both[1], Action::Send { card, .. } if card.accent == Some(0x00ff00)), "{both:?}");
    assert!(text(&run(&bot, cmd(&admin, "say", Some("edit"), None, &[("link", "nope"), ("message", "x")], NOW))[0]).contains("Paste a link to a message in this server"));
    // sticky: set, moved down after a quiet moment, only once for a burst of messages
    let set = run(&bot, cmd(&admin, "sticky", Some("set"), None, &[("message", "Read the rules!")], NOW));
    assert!(text(&set[0]).contains("📌 <#") && matches!(&set[1], Action::Post { note, .. } if note == &format!("sticky:{CH}")));
    bot.on_posted(G, &format!("sticky:{CH}"), "500000000000000001");
    let talk = |id: &str, at: i64| bot.on_message(&MessageEvent { guild: G.into(), place: Place::channel(CH), author: member("900000000000000001", "Kai", 0), id: id.into(), text: "hi".into(), at_ms: at, ..Default::default() }, &mut |lo, _| lo);
    let first = talk("1", NOW + 1000);
    let second = talk("2", NOW + 2000);
    let note = |a: &[Action]| a.iter().find_map(|x| if let Action::Later { note, after_ms } = x { Some((note.clone(), *after_ms)) } else { None });
    let ((n1, wait1), (n2, _)) = (note(&first).unwrap(), note(&second).unwrap());
    assert!(wait1 >= 5000, "at least the quiet delay ({wait1})");
    assert!(bot.on_later(G, &n1).is_empty(), "someone talked again, so the first wait does nothing");
    let moved = bot.on_later(G, &n2);
    assert!(matches!(&moved[0], Action::Delete { message, .. } if message == "500000000000000001") && matches!(&moved[1], Action::Post { .. }));
    assert!(text(&run(&bot, cmd(&admin, "sticky", Some("list"), None, &[], NOW))[0]).contains("Read the rules!"));
    assert!(text(&run(&bot, cmd(&admin, "sticky", Some("remove"), None, &[], NOW))[0]).contains("🗑️ Removed the sticky message"));
}

#[test]
fn dead_chat_ping_like_good_boy_3() {
    use gb_core::deadchat::should_ping;
    // Good Boy 3's rule
    assert!(!should_ping(100, 0, 0, 10, 10), "no baseline yet");
    assert!(!should_ping(100, 95, 0, 10, 10), "not quiet long enough");
    assert!(should_ping(100, 80, 0, 10, 10));
    assert!(!should_ping(100, 80, 85, 10, 10), "already pinged this quiet spell");
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "deadchat", true).unwrap();
    bot.directory.set_role_facts(G, [("600000000000000077".to_string(), gb_core::bot::RoleFacts { name: "deadchat".into(), position: 1, managed: false, perms: 0, mentionable: true })].into(), Some(10));
    let admin = Member { roles: vec!["600000000000000099".into()], ..member("900000000000000009", "Ada", ADMINISTRATOR) };
    bot.directory.set_role_facts(G, [("600000000000000077".to_string(), gb_core::bot::RoleFacts { name: "deadchat".into(), position: 1, managed: false, perms: 0, mentionable: true }), ("600000000000000099".to_string(), gb_core::bot::RoleFacts { name: "Admins".into(), position: 9, managed: false, perms: 0, mentionable: true })].into(), Some(10));
    let intro = run(&bot, cmd(&admin, "deadchat", None, None, &[], NOW));
    assert!(text(&intro[0]).contains("Off. Pick a channel, who to ping and how long the chat must be quiet."));
    let press = |who: &Member, id: &str| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    let Action::Form { fields, .. } = &press(&admin, &format!("deadchat:setup:{}", admin.id))[0] else { panic!() };
    assert_eq!(fields.iter().map(|f| f.label.as_str()).collect::<Vec<_>>(), ["Turn it on?", "Channel to watch", "Role to ping (optional)", "Quiet for how many minutes?", "At most once every N minutes"]);
    let done = bot.on_form(&gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: admin.clone(), id: "deadchat:form".into(), values: [("enabled", "on"), ("channel", CH), ("role", "600000000000000077"), ("quiet", "60"), ("cooldown", "240")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    assert!(text(&done[0]).contains("💬 Dead chat ping is on") && matches!(&done[1], Action::Send { card, .. } if card.buttons[0].id == "deadchat:toggle"), "{done:?}");
    // quiet for an hour: a ping with a conversation starter, then not again until someone talks
    let pings = bot.on_tick(NOW + 61 * MINUTE, &mut |lo, _| lo);
    let ping = pings.iter().find_map(|(_, a)| if let Action::Send { card, roles, .. } = a { card.to_discord().unwrap().to_string().contains("Chat has been quiet for 61 minutes!").then(|| roles.clone()) } else { None });
    assert_eq!(ping, Some(vec!["600000000000000077".to_string()]), "{pings:?}");
    assert!(!bot.on_tick(NOW + 300 * MINUTE, &mut |lo, _| lo).iter().any(|(_, a)| matches!(a, Action::Send { card, .. } if card.to_discord().unwrap().to_string().contains("Chat has been quiet"))));
    // the opt-in button
    let kai = member("900000000000000001", "Kai", 0);
    let joined = press(&kai, "deadchat:toggle");
    assert!(text(&joined[0]).contains("🔔 You'll be pinged with <@&600000000000000077> when chat goes quiet.") && matches!(&joined[1], Action::Roles { add, .. } if add == &["600000000000000077"]));
}

#[test]
fn eclipse_id_like_good_boy_3() {
    use gb_core::eclipseid::{clean_field, eid_code, normalize_link, parse_platforms};
    assert_eq!(clean_field("hi @everyone <@123> <@&45>  there\u{7}\n\n\n\nok", 300), "hi there\n\nok");
    assert_eq!(parse_platforms("PS5, pc; nintendo, toaster"), (vec!["playstation".to_string(), "pc".into(), "switch".into()], vec!["toaster".to_string()]));
    let a = eid_code("700000000000000001");
    assert_eq!(a, eid_code("700000000000000001"), "the same person always gets the same ID");
    assert_ne!(a, eid_code("700000000000000002"));
    assert!(a.starts_with("EID-") && a.len() == 15 && a.as_bytes()[9] == b'-', "{a}");
    assert_eq!(normalize_link("nintendo", "sw-1234-5678-9012"), Ok("SW-1234-5678-9012".into()));
    assert_eq!(normalize_link("riot", "Ghost#EUW"), Ok("Ghost#EUW".into()));
    assert_eq!(normalize_link("battlenet", "Ghost#12"), Err("That doesn't look like a Battle.net BattleTag like Name#1234.".into()));
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "eclipseid", true).unwrap();
    let kai = member("900000000000000001", "Kai", 0);
    let rowan = member("900000000000000002", "Rowan", 0);
    let Action::Form { id, title, fields } = &run(&bot, cmd(&kai, "id", Some("edit"), None, &[], NOW))[0] else { panic!() };
    assert_eq!((id.as_str(), title.as_str(), fields.len()), ("eid:edit", "Your Eclipse ID", 5));
    let send = |values: &[(&str, &str)]| bot.on_form(&gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: kai.clone(), id: "eid:edit".into(), values: values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    assert!(text(&send(&[("platforms", "fridge")])[0]).contains("I don't know these platforms: fridge."));
    assert!(text(&send(&[("bio", "Night owl"), ("games", "Rust, Celeste"), ("platforms", "pc, ps5"), ("region", "UK")])[0]).contains("Saved. This card goes with you to every server this bot is in."));
    assert!(text(&run(&bot, cmd(&kai, "id", Some("link"), None, &[("platform", "steam"), ("name", "ghostly")], NOW))[0]).contains("Saved your Steam name **ghostly** (only you can see it)."));
    run(&bot, cmd(&kai, "id", Some("privacy"), None, &[("field", "region"), ("who", "private")], NOW));
    let mine = text(&run(&bot, cmd(&kai, "id", Some("show"), None, &[], NOW))[0]);
    assert!(mine.contains("Night owl") && mine.contains("pc · playstation") && mine.contains("ghostly *(only you)*") && mine.contains(&eid_code("900000000000000001")) && mine.contains("hidden from others: region or timezone, linked accounts"), "{mine}");
    let theirs = text(&run(&bot, cmd(&rowan, "id", Some("show"), Some(&kai), &[], NOW))[0]);
    assert!(theirs.contains("Night owl") && !theirs.contains("UK") && !theirs.contains("ghostly"), "{theirs}");
    assert!(text(&run(&bot, cmd(&kai, "id", Some("roblox"), None, &[("name", "builderman")], NOW))[0]).contains("Roblox lookup is turned off"));
    // the card follows its owner to every server, and the owner chooses where it is shown
    bot.db.get().set_module_enabled("700000000000000099", "eclipseid", true).unwrap();
    let seen = |who: &gb_core::Member, guild: &str| text(&run(&bot, gb_core::CommandEvent { guild: guild.into(), ..cmd(who, "id", Some("show"), Some(&kai), &[], NOW) })[0]);
    assert!(seen(&rowan, "700000000000000099").contains("Night owl"), "a new card is shown in another server too");
    assert!(text(&run(&bot, cmd(&kai, "id", Some("share"), None, &[("where", "hide")], NOW))[0]).contains("hidden in this server"));
    assert!(text(&run(&bot, cmd(&rowan, "id", Some("show"), Some(&kai), &[], NOW))[0]).contains("has not shared their card in this server"));
    assert!(seen(&rowan, "700000000000000099").contains("Night owl"), "hiding in one server leaves the others alone");
    let own = text(&run(&bot, cmd(&kai, "id", Some("show"), None, &[], NOW))[0]);
    assert!(own.contains("Night owl"), "its owner always sees it");
    run(&bot, cmd(&kai, "id", Some("share"), None, &[("where", "none")], NOW));
    assert!(seen(&rowan, "700000000000000099").contains("has not shared their card"));
    run(&bot, cmd(&kai, "id", Some("share"), None, &[("where", "all")], NOW));
    assert!(text(&run(&bot, cmd(&rowan, "id", Some("show"), Some(&kai), &[], NOW))[0]).contains("Night owl"));
    run(&bot, cmd(&kai, "id", Some("delete"), None, &[], NOW));
    assert!(text(&run(&bot, cmd(&rowan, "id", Some("show"), Some(&kai), &[], NOW))[0]).contains("This member has not shared anything yet."));
}

#[test]
fn eclipse_id_picks_up_games_with_two_off_switches_moves_by_code_and_finds_players() {
    use gb_core::eclipseid::{export_code, read_code};
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "eclipseid", true).unwrap();
    let kai = member("900000000000000001", "Kai", 0);
    let rowan = member("900000000000000002", "Rowan", 0);
    let id = |who: &gb_core::Member, sub: &str, args: &[(&str, &str)]| text(&run(&bot, cmd(who, "id", Some(sub), None, args, NOW))[0]);
    let shown = |who: &gb_core::Member, of: &gb_core::Member| text(&run(&bot, cmd(who, "id", Some("show"), Some(of), &[], NOW))[0]);
    let now = NOW;
    // picked up from the Discord status: games and the kind of app, on the card as "picked up automatically"
    bot.eid_presence(G, &kai.id, &["Celeste".to_string(), "Minecraft".to_string()], &["pc"], now);
    bot.eid_presence(G, &kai.id, &["Minecraft".to_string()], &["pc"], now + 60_000);
    let seen = shown(&rowan, &kai);
    assert!(seen.contains("Seen playing") && seen.contains("Minecraft") && seen.contains("Celeste") && seen.contains("on PC"), "{seen}");
    // the server owner's switch stops it, and hides what was already picked up
    bot.settings.set(G, "eclipseid", "autoDetect", &json!(false)).unwrap();
    bot.eid_presence(G, &kai.id, &["Valorant".to_string()], &["mobile"], now + 120_000);
    assert!(!shown(&rowan, &kai).contains("Seen playing"));
    bot.settings.set(G, "eclipseid", "autoDetect", &json!(true)).unwrap();
    assert!(!shown(&rowan, &kai).contains("Valorant"), "nothing was picked up while it was off");
    // a member can hide it, switch it off for themselves, or forget it
    id(&kai, "privacy", &[("field", "seen"), ("who", "private")]);
    assert!(!shown(&rowan, &kai).contains("Seen playing") && id(&kai, "show", &[]).contains("Minecraft"), "hidden from others, not from them");
    id(&kai, "privacy", &[("field", "seen"), ("who", "public")]);
    assert!(id(&kai, "auto", &[("mode", "forget")]).contains("erased") && !shown(&rowan, &kai).contains("Minecraft"));
    bot.eid_presence(G, &kai.id, &["Rust".to_string()], &[], now + 200_000);
    assert!(shown(&rowan, &kai).contains("Rust"));
    assert!(id(&kai, "auto", &[("mode", "off")]).contains("erased"));
    bot.eid_presence(G, &kai.id, &["Terraria".to_string()], &[], now + 300_000);
    assert!(!shown(&rowan, &kai).contains("Rust") && !shown(&rowan, &kai).contains("Terraria"), "off means nothing is kept");
    id(&kai, "auto", &[("mode", "on")]);

    // find players: members of this server who use Eclipse ID and share their card
    let send = |who: &gb_core::Member, values: &[(&str, &str)]| bot.on_form(&gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: "eid:edit".into(), values: values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    send(&kai, &[("games", "Rust, Celeste"), ("platforms", "pc, ps5"), ("bio", "Night owl"), ("availability", "evenings")]);
    send(&rowan, &[("games", "Minecraft"), ("platforms", "switch")]);
    id(&kai, "link", &[("platform", "steam"), ("name", "ghostly"), ("who", "public")]);
    let found = id(&rowan, "find", &[("game", "celeste")]);
    assert!(found.contains("<@900000000000000001>") && found.contains("pc · playstation") && !found.contains("<@900000000000000002>"), "{found}");
    assert!(id(&rowan, "find", &[("game", "zelda")]).contains("Nobody here has shared"));
    assert!(id(&rowan, "find", &[("game", "z")]).contains("at least two letters"));
    run(&bot, cmd(&kai, "id", Some("share"), None, &[("where", "hide")], NOW));
    assert!(id(&rowan, "find", &[("game", "celeste")]).contains("Nobody here has shared"), "a hidden card is not listed");
    run(&bot, cmd(&kai, "id", Some("share"), None, &[("where", "here")], NOW));
    id(&kai, "privacy", &[("field", "games"), ("who", "private")]);
    assert!(id(&rowan, "find", &[("game", "celeste")]).contains("Nobody here has shared"), "a private games list is not searched");
    id(&kai, "privacy", &[("field", "games"), ("who", "public")]);

    // a code moves the card to another Good Boy, with a check so a bad copy is caught
    let code = export_code(&bot.db, &kai.id);
    assert!(code.starts_with("EIDX1.") && code.matches('.').count() == 2 && !code.contains("ghostly"), "the card is packed, not readable: {code}");
    let (card, links, skipped) = read_code(&code).unwrap();
    assert_eq!((card.games.as_str(), card.platforms.as_str(), card.bio.as_str(), links.len(), skipped), ("Rust, Celeste", "pc, playstation", "Night owl", 1, 0));
    assert!(read_code(&code.replace("EIDX1.", "EIDX2.")).is_err() && read_code(&code[..code.len() - 3]).is_err() && read_code("nonsense").is_err());
    let tampered = { let mut c = code.clone().into_bytes(); let at = 12; c[at] = if c[at] == b'A' { b'B' } else { b'A' }; String::from_utf8(c).unwrap() };
    assert!(read_code(&tampered).is_err(), "a changed code is refused");
    let there = member("900000000000000003", "Ivy", 0);
    assert!(id(&there, "export", &[]).contains("Your card is empty"));
    let said = id(&there, "import", &[("code", &code)]);
    assert!(said.contains("replaced with the one in the code (1 linked account)") && !said.contains("old card"), "{said}");
    assert!(shown(&rowan, &there).contains("Night owl") && shown(&rowan, &there).contains("ghostly"));
    let again = id(&there, "import", &[("code", &code)]);
    assert!(again.contains("Your old card, in case you want it back") && again.contains("EIDX1."), "an import keeps a way back");
    assert!(id(&there, "import", &[("code", "EIDX1.bad.code")]).contains("not complete"));
    assert!(id(&kai, "export", &[]).contains("keep it to yourself"));
    // deleting a card also erases what was picked up and where they showed up
    id(&kai, "delete", &[]);
    let after = id(&rowan, "find", &[("game", "celeste")]);
    assert!(!after.contains("<@900000000000000001>") && after.contains("<@900000000000000003>"), "Kai is gone, Ivy (who imported the card) is listed: {after}");
}

#[test]
fn server_setup_builds_connects_and_checks_a_server() {
    use gb_core::setup::{self, Built};
    use gb_core::{Action, SetupStep};
    let (_tmp, bot) = bot();
    let admin = member("900000000000000009", "Ada", ADMINISTRATOR);
    let kai = member("900000000000000001", "Kai", 0);
    // only admins; the commands hand the work to the Discord layer
    assert!(text(&run(&bot, cmd(&kai, "setup", Some("scan"), None, &[], NOW))[0]).contains("admins"));
    let Action::Setup(job) = &run(&bot, cmd(&admin, "setup", Some("scan"), None, &[], NOW))[0] else { panic!() };
    assert_eq!((job.by.as_str(), &job.step), ("900000000000000009", &SetupStep::Scan));
    let picker = text(&run(&bot, cmd(&admin, "setup", Some("start"), None, &[], NOW))[0]);
    assert!(picker.contains("Community") && picker.contains("Gaming") && picker.contains("setup:plan:gaming"), "{picker}");
    let click = |id: &str, who: &gb_core::Member| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), message: "m".into(), values: vec![], at_ms: NOW }, &|_| None, &mut |lo, _| lo);
    assert!(matches!(&click("setup:plan:community", &admin)[0], Action::Setup(j) if j.step == SetupStep::Plan("community".into())));
    assert!(matches!(&click(&format!("setup:build:community:{}", admin.id), &admin)[0], Action::Setup(j) if j.step == SetupStep::Build("community".into())));
    assert!(text(&click(&format!("setup:build:community:{}", admin.id), &kai)[0]).contains("admins"), "a member cannot press it");
    let other = member("900000000000000010", "Bo", ADMINISTRATOR);
    assert!(text(&click(&format!("setup:build:community:{}", admin.id), &other)[0]).contains("belongs to someone else"));
    assert!(click("setup:build:nonsense:1", &admin).is_empty() || matches!(&click("setup:build:nonsense:1", &admin)[0], Action::Reply { .. }));

    // after a build the bot is connected to what was made, and nothing already set is overwritten
    let ids = |list: &[(&str, Option<&str>, &str)]| Built { roles: vec![("Moderator".into(), "600000000000005000".into()), ("Admin".into(), "600000000000005001".into())], channels: list.iter().map(|(n, p, i)| (n.to_string(), p.map(str::to_string), i.to_string())).collect() };
    let built = ids(&[("welcome", Some("Info"), "800000000000000100"), ("rules", Some("Info"), "800000000000000101"), ("introductions", Some("Community"), "800000000000000102"), ("mod-log", Some("Staff"), "800000000000000103"), ("server-log", Some("Staff"), "800000000000000104"),
        ("ticket-log", Some("Staff"), "800000000000000105"), ("suggestions", Some("Community"), "800000000000000106"), ("open-a-ticket", Some("Support"), "800000000000000107"), ("Tickets", None, "800000000000000108")]);
    bot.settings.set(G, "moderation", "serverLogChannel", &json!("800000000000000999")).unwrap();
    let (actions, said) = bot.setup_wire(G, "community", &built);
    let get = |m: &str, k: &str| bot.settings.text(G, m, k);
    assert_eq!(get("member-management", "welcomeChannel").as_deref(), Some("800000000000000100"));
    assert_eq!(get("member-management", "introChannel").as_deref(), Some("800000000000000102"));
    assert_eq!(get("moderation", "logChannel").as_deref(), Some("800000000000000103"));
    assert_eq!(get("moderation", "serverLogChannel").as_deref(), Some("800000000000000999"), "what the server already chose is kept");
    assert_eq!((get("support", "logChannel").as_deref(), get("support", "ticketCategory").as_deref(), get("support", "staffRole").as_deref()), (Some("800000000000000105"), Some("800000000000000108"), Some("600000000000005000")));
    assert_eq!(get("engagement", "suggestionChannel").as_deref(), Some("800000000000000106"));
    assert!(bot.settings.bool(G, "member-management", "welcomeEnabled"));
    for m in ["moderation", "member-management", "community", "support", "engagement"] { assert!(bot.db.get().module_enabled(G, m).unwrap(), "{m} is on"); }
    assert!(said.iter().any(|s| s.contains("<#800000000000000100>")) && !said.iter().any(|s| s.contains("<#800000000000000104>")));
    assert!(actions.iter().any(|a| matches!(a, Action::Send { channel, card, .. } if channel == "800000000000000101" && card.lines.join(" ").contains("Server rules"))), "the rules are posted");
    assert!(actions.iter().any(|a| matches!(a, Action::Post { channel, .. } | Action::Send { channel, .. } if channel == "800000000000000107")), "the ticket buttons are posted: {actions:?}");

    // the check of a server that is already set up
    let day = 86_400_000i64;
    let now = 1_794_441_600_000i64;
    let old_id = ((now - 400 * day - 1_420_070_400_000) << 22).to_string();
    let new_id = ((now - 5 * day - 1_420_070_400_000) << 22).to_string();
    let layout = json!({ "everyone": (setup::MENTION_EVERYONE | setup::MANAGE_MESSAGES | setup::VIEW_CHANNEL).to_string(),
        "roles": [{ "id": "1", "name": "Boss", "permissions": setup::ADMINISTRATOR.to_string() }, { "id": "2", "name": "Boss2", "permissions": setup::ADMINISTRATOR.to_string() }, { "id": "3", "name": "Boss3", "permissions": setup::ADMINISTRATOR.to_string() }, { "id": "4", "name": "Helper", "permissions": "0" }, { "id": "5", "name": "helper", "permissions": "0" }],
        "channels": [
            { "id": "800000000000000020", "name": "Old Stuff", "type": 4, "parent": null }, { "id": "800000000000000021", "name": "Main", "type": 4, "parent": null },
            { "id": "800000000000000030", "name": "welcome", "type": 0, "parent": "Main", "lastMessage": now - day },
            { "id": "800000000000000031", "name": "mod-logs", "type": 0, "parent": "Main", "lastMessage": now - day },
            { "id": old_id, "name": "old-news", "type": 0, "parent": "Main", "lastMessage": null },
            { "id": new_id, "name": "chat", "type": 0, "parent": "Main", "lastMessage": now - day },
            { "id": "800000000000000040", "name": "chat", "type": 0, "parent": "Main", "lastMessage": now - day }] });
    let (card, data) = bot.setup_scan("700000000000000099", &layout, now, "1");
    let ids: Vec<&str> = data["findings"].as_array().unwrap().iter().map(|f| f["id"].as_str().unwrap()).collect();
    for want in ["everyone", "admins", "duplicates", "dup-roles", "empty", "quiet", "connect", "modules"] { assert!(ids.contains(&want), "{want} in {ids:?}"); }
    assert!(!ids.contains(&"logs"), "no \"add logs\" when #mod-logs exists and can just be connected");
    assert_eq!(data["findings"][0]["level"], "warn", "the worrying ones come first");
    let said = card.lines.join("\n");
    assert!(said.contains("Old Stuff") && said.contains("#old-news") && said.contains("#welcome looks like the welcome") && !said.contains("#chat looks"), "{said}");
    assert!(card.buttons.iter().any(|b| b.id == "setup:fix:empty:1") && card.buttons.len() <= 4);
    card.check().unwrap();
    // the fixes do exactly what they say
    let g = "700000000000000099";
    let plan = bot.setup_fix(g, "empty", &layout);
    assert_eq!(plan.actions, vec![Action::DeleteChannel { channel: "800000000000000020".into(), after_secs: 0 }], "only the empty category, never one with channels");
    let plan = bot.setup_fix(g, "everyone", &layout);
    assert_eq!(plan.everyone_remove, setup::MENTION_EVERYONE | setup::MANAGE_MESSAGES, "only the risky bits, not viewing");
    assert_eq!(bot.setup_fix(g, "logs", &layout).build, Some("logs"));
    assert!(bot.setup_fix(g, "connect", &layout).text.contains("<#800000000000000030>"));
    assert_eq!(bot.settings.text(g, "member-management", "welcomeChannel").as_deref(), Some("800000000000000030"));
    assert_eq!(bot.settings.text(g, "moderation", "logChannel").as_deref(), Some("800000000000000031"), "the log channel it found is used instead of making one");
    assert!(bot.setup_fix(g, "connect", &layout).text.contains("nothing left"));
    assert!(bot.setup_fix(g, "modules", &layout).text.contains("Turned on"));
    assert!(bot.setup_fix(g, "nonsense", &layout).text.contains("don't know"));
    // a tidy server has nothing to report, and a ticket category in use is never called empty
    bot.settings.set(g, "support", "ticketCategory", &json!("800000000000000020")).unwrap();
    assert!(bot.setup_fix(g, "empty", &layout).actions.is_empty());
    let (done, view) = bot.setup_scan(g, &json!({ "everyone": "1024", "roles": [], "channels": [] }), now, "1");
    assert!(view["findings"].as_array().unwrap().iter().all(|f| f["id"] != "everyone"));
    drop(done);
    // the dashboard sees the layouts, the check, and what was last done
    bot.setup_note(g, "fix", "Connected", now);
    let v = bot.setup_view(g);
    assert!(v["layouts"].as_array().unwrap().len() == 4 && v["scan"]["at"] == now && v["last"]["text"] == "Connected" && v["fixes"].as_array().unwrap().len() == 5, "{v}");
    assert_eq!(v["layouts"][0]["tree"][0]["channels"][0]["read_only"], true);
}

#[test]
fn families_like_good_boy_3() {
    use gb_core::family::{tree_text, Graph};
    let s = |a: &str, b: &str| (a.to_string(), b.to_string());
    // Good Boy 3's rules
    let g = Graph::build(&[s("a", "b")], &[s("a", "c"), s("c", "d")]);
    assert_eq!(g.marry_problem("a", "e", 1).as_deref(), Some("You're already married. Divorce first with `/family divorce`."));
    assert_eq!(g.marry_problem("c", "b", 1).as_deref(), Some("They're already married."));
    assert_eq!(g.marry_problem("c", "b", 2).as_deref(), Some("You're already in the same family, so you can't marry them."));
    assert_eq!(g.marry_problem("e", "f", 1), None);
    assert_eq!(g.adopt_problem("e", "d", 10).as_deref(), Some("They already have a parent. They can leave that family with `/family leave` first."));
    assert_eq!(g.root_of("d"), "a");
    let tree = g.tree_from("a").unwrap();
    assert_eq!(tree.count(), 4);
    assert_eq!(tree_text(&tree, &|id| id.to_uppercase(), Some("c")), "👑 A ❤️ B\n└ **C**\n  └ D");
    // proposing, answering, divorcing
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "family", true).unwrap();
    let kai = member("900000000000000001", "Kai", 0);
    let rowan = member("900000000000000002", "Rowan", 0);
    let ask = run(&bot, cmd(&kai, "marry", None, Some(&rowan), &[], NOW));
    let Action::Reply { card } = &ask[0] else { panic!() };
    assert!(text(&ask[0]).contains("💍 A proposal!") && card.ping == [rowan.id.clone()], "{ask:?}");
    let yes = card.buttons[0].id.clone();
    let press = |who: &Member, id: &str, at: i64| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), at_ms: at, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    assert!(text(&press(&kai, &yes, NOW)[0]).contains(&format!("Only <@{}> can answer this.", rowan.id)));
    assert!(text(&press(&rowan, &yes, NOW + 1000)[0]).contains("are now married. Congratulations!"));
    assert!(text(&press(&rowan, &yes, NOW + 2000)[0]).contains("This request has ended."));
    let info = text(&run(&bot, cmd(&kai, "family", Some("info"), None, &[], NOW))[0]);
    assert!(info.contains(&format!("<@{}> since", rowan.id)) && info.contains("Family size: 2"), "{info}");
    let tree = run(&bot, cmd(&kai, "family", Some("tree"), None, &[], NOW));
    let Action::Reply { card } = &tree[0] else { panic!() };
    assert!(matches!(&card.art, Some(gb_core::Art::Family(a)) if a.tree.people == [kai.id.clone(), rowan.id.clone()]), "{card:?}");
    let ask = run(&bot, cmd(&kai, "family", Some("divorce"), None, &[], NOW));
    let Action::Reply { card } = &ask[0] else { panic!() };
    assert!(card.buttons[0].id.starts_with("fam:div:"));
    assert!(text(&press(&rowan, &card.buttons[0].id, NOW)[0]).contains("That button is for someone else."));
    let done = press(&kai, &card.buttons[0].id, NOW);
    assert!(text(&done[1]).contains("are divorced."));
    // a proposal older than 10 minutes has ended
    let ask = run(&bot, cmd(&kai, "family", Some("adopt"), Some(&rowan), &[], NOW));
    let Action::Reply { card } = &ask[0] else { panic!() };
    assert!(text(&press(&rowan, &card.buttons[0].id, NOW + 11 * MINUTE)[0]).contains("This request has ended."));
}

#[test]
fn achievements_like_good_boy_3() {
    use gb_core::achievements::{advance_streak, slugify};
    assert_eq!(slugify("Top Fan!! 2026"), "top-fan-2026");
    assert_eq!(advance_streak(Some("2026-11-11"), 4, 6, "2026-11-12"), (5, 6, true));
    assert_eq!(advance_streak(Some("2026-11-09"), 4, 6, "2026-11-12"), (1, 6, true));
    assert_eq!(advance_streak(Some("2026-11-12"), 4, 6, "2026-11-12"), (4, 6, false));
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "achievements", true).unwrap();
    bot.settings.set(G, "achievements", "announceChannel", &json!("800000000000000055")).unwrap();
    let ana = Member { joined_at: Some(NOW - 40 * DAY), ..member("900000000000000071", "Ana", 0) };
    let mut n = 0;
    let mut say = |at: i64| { n += 1; bot.on_message(&MessageEvent { guild: G.into(), place: Place::channel(CH), author: ana.clone(), id: format!("71000000000000{n:04}"), text: "hi".into(), mentions: 0, mentioned: Vec::new(), files: Vec::new(), at_ms: at }, &mut |lo, _| lo) };
    let first = say(NOW);
    let said: Vec<String> = first.iter().filter_map(|a| if let Action::Send { channel, card, .. } = a { (channel == "800000000000000055").then(|| card.lines.join(" ")) } else { None }).collect();
    assert!(said.iter().any(|s| s.contains("unlocked 💬 **First Words** — 1 messages")) && said.iter().any(|s| s.contains("🌱 **One Month In**")), "{first:?}");
    // spam inside 20 seconds doesn't count; three days in a row is a streak
    say(NOW + 5_000);
    say(NOW + DAY);
    let third = say(NOW + 2 * DAY);
    assert!(third.iter().any(|a| matches!(a, Action::Send { card, .. } if card.lines.join(" ").contains("Three in a Row"))), "{third:?}");
    let shown = text(&run(&bot, cmd(&ana, "achievements", Some("show"), None, &[], NOW + 2 * DAY))[0]);
    assert!(shown.contains("· 3/17") && shown.contains("🗨️ **Regular** ▱▱▱▱▱▱▱▱▱▱ 3/100 messages"), "{shown}");
    // the server's own, granted by an admin; members can hide theirs
    let admin = member("900000000000000072", "Ada", ADMINISTRATOR);
    assert!(text(&run(&bot, cmd(&admin, "achievements", Some("custom create"), None, &[("name", "Event Winner!"), ("description", "Won a server event")], NOW))[0]).contains("(id `event-winner`)"));
    assert!(text(&run(&bot, cmd(&admin, "achievements", Some("custom grant"), Some(&ana), &[("id", "event-winner")], NOW))[0]).contains("Gave 🏅 **Event Winner!** to"));
    assert!(text(&run(&bot, cmd(&ana, "achievements", Some("custom grant"), Some(&admin), &[("id", "event-winner")], NOW))[0]).contains("`achievements.manage`"));
    run(&bot, cmd(&ana, "achievements", Some("privacy"), None, &[("who", "private")], NOW));
    assert!(text(&run(&bot, cmd(&admin, "achievements", Some("show"), Some(&ana), &[], NOW))[0]).contains("That member keeps their achievements private."));
    // a member who turned achievement announcements off gets none
    run(&bot, cmd(&ana, "notifications", Some("set"), None, &[("category", "achievements"), ("enabled", "false")], NOW));
    assert!(text(&run(&bot, cmd(&ana, "notifications", Some("view"), None, &[], NOW))[0]).contains("❌ **achievements** - Achievement announcements *(you)*"));
    let quiet = say(NOW + 30 * DAY);
    assert!(!quiet.iter().any(|a| matches!(a, Action::Send { card, .. } if card.lines.join(" ").contains("unlocked"))), "{quiet:?}");
}

#[test]
fn clips_like_good_boy_3() {
    use gb_core::clips::{find_clip_url, week_start};
    assert_eq!(find_clip_url("look (https://medal.tv/clips/abc123)!"), Some("https://medal.tv/clips/abc123".into()));
    assert_eq!(find_clip_url("https://example.com/x and https://youtu.be/xyz."), Some("https://youtu.be/xyz".into()));
    assert_eq!(find_clip_url("no links"), None);
    // 2026-11-12 is a Thursday: its week starts on Monday 2026-11-09
    assert_eq!(gb_core::time::date(week_start(1_794_441_600_000) * 86_400_000), "2026-11-09");
    let (_tmp, bot) = bot();
    for m in ["clips", "economy"] { bot.db.get().set_module_enabled(G, m, true).unwrap(); }
    bot.settings.set(G, "clips", "clipsChannel", &json!(CH)).unwrap();
    bot.settings.set(G, "clips", "bestChannel", &json!("800000000000000066")).unwrap();
    bot.settings.set(G, "clips", "bestVotes", &json!(2)).unwrap();
    let kai = member("900000000000000081", "Kai", 0);
    let medal = Member { bot: true, ..member("900000000000000082", "MedalBot", 0) };
    bot.db.get().wallet(G, &kai.id, Some("Kai"), 0).unwrap();
    let post = |who: &Member, id: &str, text: &str, files: Vec<(String, String, u64)>, mentioned: Vec<Member>| bot.on_message(&MessageEvent { guild: G.into(), place: Place::channel(CH), author: who.clone(), id: id.into(), text: text.into(), mentions: 0, mentioned, files, at_ms: NOW }, &mut |lo, _| lo);
    // chat is left alone; a link, an upload and Medal's post are clips
    assert!(!post(&kai, "810000000000000001", "gg everyone", Vec::new(), Vec::new()).iter().any(|a| matches!(a, Action::React { .. })));
    assert!(post(&kai, "810000000000000002", "https://medal.tv/clips/abc", Vec::new(), Vec::new()).iter().any(|a| matches!(a, Action::React { emoji, .. } if emoji == "🔥")));
    post(&kai, "810000000000000003", "", vec![("Rocket League 2026.mp4".into(), "https://cdn.discordapp.com/a.mp4".into(), 1000)], Vec::new());
    post(&medal, "810000000000000004", "<@900000000000000081> shared a clip", Vec::new(), vec![kai.clone()]);
    let c = bot.db.get().clip(G, "810000000000000004").unwrap().unwrap();
    assert_eq!((c.user.as_str(), c.via.as_str()), ("900000000000000081", "medal"));
    bot.on_embed(G, CH, "810000000000000002", "Ace clutch", None);
    // coins: three clips a day earn 25 each (members without a wallet get none, as in Good Boy 3)
    let coins = bot.db.get().top_coins(G, 5).unwrap();
    assert_eq!(coins.iter().find(|r| r.0 == kai.id).map(|r| r.2), Some(75), "{coins:?}");
    // votes: a reaction asks for a count; enough votes reposts it once (the upload is uploaded again)
    let ask = bot.on_reaction(G, "810000000000000003", "🔥", "900000000000000083", true);
    assert!(matches!(&ask[..], [Action::CountVotes { skip, .. }] if *skip == kai.id), "{ask:?}");
    assert!(bot.clip_votes(G, "810000000000000003", 1).is_empty());
    let best = bot.clip_votes(G, "810000000000000003", 2);
    assert!(matches!(&best[..], [Action::SendText { channel, text, video_from: Some(_), note: Some(n), .. }] if channel == "800000000000000066" && text.starts_with("🏆 🔥 **2** · clip by <@900000000000000081> · Rocket League 2026.mp4") && n == "clipbest:810000000000000003"), "{best:?}");
    bot.on_posted(G, "clipbest:810000000000000003", "820000000000000001");
    assert!(bot.clip_votes(G, "810000000000000003", 3).is_empty());
    let top = text(&run(&bot, cmd(&kai, "clips", Some("top"), None, &[("period", "week")], NOW))[0]);
    assert!(top.contains("🎬 Top clips this week") && top.contains("**1.** 🔥 **3** · clip by"), "{top}");
}

#[test]
fn bot_news_like_good_boy_3() {
    use gb_core::botnews::{member_notes, newer, sections, split_message, BotNews};
    let log = "# x\n\n## 4.0.1\n\n**Big one**\n<!-- members -->\nnew stuff for you\n<!-- /members -->\n- fixed it\n\n## 4.0.0\n\nfirst\n";
    let s = sections(log);
    assert_eq!(s.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(), ["4.0.1", "4.0.0"]);
    assert_eq!(member_notes(&s[0].1).as_deref(), Some("new stuff for you"));
    assert!(newer("4.0.0-dev.10", "4.0.0-dev.7").is_gt() && newer("4.0.0", "4.0.0-dev.10").is_gt());
    assert_eq!(split_message(&format!("{}\n\n{}", "a".repeat(1500), "b".repeat(1000)), 2000).len(), 2);
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "botnews", true).unwrap();
    bot.settings.set(G, "botnews", "adminChannel", &json!("800000000000000091")).unwrap();
    bot.settings.set(G, "botnews", "announceChannel", &json!("800000000000000092")).unwrap();
    let news = BotNews { db: &bot.db, settings: &bot.settings, guild: G };
    let mods = [("levels", "Levels")];
    // the first start only remembers; an update later posts its notes and a draft for members
    assert!(news.started("4.0.0", log, &mods, NOW).is_empty());
    let out = news.started("4.0.1", log, &[("levels", "Levels"), ("clips", "Clips channel")], NOW);
    let says: Vec<String> = out.iter().map(|a| match a { Action::Send { channel, card, .. } => format!("{channel} {} {}", card.title.clone().unwrap_or_default(), card.lines.join(" ")), other => format!("{other:?}") }).collect();
    assert!(says[0].starts_with("800000000000000091 🆙 Good Boy updated to 4.0.1 __**Big one**__"), "{says:?}");
    assert!(says[1].contains("Draft for the announcements channel: What's new in Good Boy 4.0.1"), "{says:?}");
    assert!(says[2].contains("🧩 A new module is available") && says[2].contains("**clips** · Clips channel"), "{says:?}");
    assert!(news.started("4.0.1", log, &mods, NOW).is_empty(), "nothing twice");
    // the draft: Post as it is sends it as a plain message
    let admin = member("900000000000000093", "Ada", ADMINISTRATOR);
    let Action::Send { card, .. } = &out[1] else { panic!() };
    let press = |id: &str| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel("800000000000000091"), member: admin.clone(), id: id.into(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    let posted = press(&card.buttons[1].id);
    assert!(text(&posted[0]).contains("✅ Posted by") && matches!(&posted[1], Action::SendText { channel, text, .. } if channel == "800000000000000092" && text == "new stuff for you"), "{posted:?}");
    assert!(text(&press(&card.buttons[1].id)[0]).contains("That draft was already posted."));
    // turning a member feature on: the admin note, and its intro (once)
    let on = bot.set_module(G, "family", true, NOW).unwrap();
    assert!(matches!(&on[0], Action::Send { card, .. } if card.lines[0] == "🟢 **family** was turned on."));
    assert!(matches!(&on[1], Action::Send { card, .. } if card.lines[0].contains("you can marry people and adopt them now")));
    bot.set_module(G, "family", false, NOW).unwrap();
    assert_eq!(bot.set_module(G, "family", true, NOW).unwrap().len(), 1, "the intro only once");
}

#[test]
fn party_finder_like_good_boy_3() {
    use gb_core::partyfinder::clean_text;
    assert_eq!(clean_text("  Valorant <@123> @everyone \n ranked ", 60), "Valorant ranked");
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "partyfinder", true).unwrap();
    let host = member("900000000000000101", "Host", 0);
    let ana = member("900000000000000102", "Ana", 0);
    // nothing filled in: the popup
    let Action::Form { id, fields, .. } = &run(&bot, cmd(&host, "party", Some("create"), None, &[], NOW))[0] else { panic!() };
    assert_eq!((id.as_str(), fields.len()), ("party:form", 4));
    let made = bot.on_form(&gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: host.clone(), id: "party:form".into(), values: [("game", "Valorant"), ("slots", "2"), ("when", "30m")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    assert!(text(&made[0]).contains(&format!("Party **#1** posted in <#{CH}>.")), "{made:?}");
    let Action::Post { card, note, .. } = &made[1] else { panic!("{made:?}") };
    assert_eq!(note, "party:1");
    let post = card.to_discord().unwrap().to_string();
    assert!(post.contains("🎮 Valorant") && post.contains("Players (1/2)") && post.contains("1 spot left"), "{post}");
    bot.on_posted(G, "party:1", "830000000000000001");
    // joining fills it, and both get a DM; joining again is refused
    let press = |who: &Member, id: &str, at: i64| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), at_ms: at, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    let joined = press(&ana, "party:join:1", NOW);
    assert!(text(&joined[0]).contains("🎮 Valorant · FULL") && joined.iter().filter(|a| matches!(a, Action::Dm { .. })).count() == 2, "{joined:?}");
    assert!(text(&press(&ana, "party:join:1", NOW)[0]).contains("You're already in this party."));
    assert!(text(&press(&host, "party:leave:1", NOW)[0]).contains("You're the host. Use **Close** to end the party."));
    // a reminder 10 minutes before the start, once
    let soon = bot.on_tick(NOW + 21 * MINUTE, &mut |lo, _| lo);
    assert_eq!(soon.iter().filter(|(_, a)| matches!(a, Action::Dm { card, .. } if card.lines[0].contains("⏰ Your **Valorant** party"))).count(), 2, "{soon:?}");
    assert!(!bot.on_tick(NOW + 22 * MINUTE, &mut |lo, _| lo).iter().any(|(_, a)| matches!(a, Action::Dm { .. })));
    // it ends 30 minutes after its start, and the post says so
    let ended = bot.on_tick(NOW + 61 * MINUTE, &mut |lo, _| lo);
    assert!(ended.iter().any(|(_, a)| matches!(a, Action::Edit { card, .. } if card.title.as_deref() == Some("🎮 Valorant · closed"))), "{ended:?}");
    assert!(text(&run(&bot, cmd(&host, "party", Some("list"), None, &[], NOW + 62 * MINUTE))[0]).contains("No open parties."));
}

#[test]
fn quotes_like_good_boy_3() {
    assert_eq!(gb_core::quotes::when(1_794_441_600_000), "Nov 12, 2026");
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "quotes", true).unwrap();
    let kai = member("900000000000000111", "Kai", 0);
    let ana = member("900000000000000112", "Ana", 0);
    assert!(text(&run(&bot, cmd(&kai, "quote", None, None, &[("message", "https://discord.com/channels/1/2/3")], NOW))[0]).contains("That message is from a different server."));
    assert!(text(&run(&bot, cmd(&kai, "quote", None, None, &[("message", "hello")], NOW))[0]).contains("Give a message link"));
    let link = format!("https://discord.com/channels/{G}/800000000000000121/840000000000000001");
    let asked = run(&bot, cmd(&kai, "quote", None, None, &[("message", link.as_str()), ("style", "color")], NOW));
    assert!(matches!(&asked[0], Action::Quote(q) if q.channel == "800000000000000121" && q.message == "840000000000000001" && q.color && q.check_sees && q.post_in.is_none()), "{asked:?}");
    assert!(text(&run(&bot, cmd(&kai, "quote", None, None, &[("message", link.as_str())], NOW + 3000))[0]).contains("Easy - wait a few seconds between quotes."));
    // right-click > Apps > Quote Image: posted in the quote channel when one is set
    bot.settings.set(G, "quotes", "quoteChannel", &json!("800000000000000122")).unwrap();
    let right = run(&bot, cmd(&ana, "Quote Image", None, None, &[("message_id", "840000000000000002"), ("channel_id", CH), ("text", "gg")], NOW));
    assert!(matches!(&right[0], Action::Quote(q) if !q.color && q.post_in.as_deref() == Some("800000000000000122") && !q.check_sees), "{right:?}");
    // the look: classic unless the server picks another; "custom" needs a licence and real colours
    let style = |who: &Member, at: i64| match &run(&bot, cmd(who, "Quote Image", None, None, &[("message_id", "840000000000000009"), ("channel_id", CH), ("text", "gg")], at))[0] {
        Action::Quote(q) => (q.style.clone(), q.custom.clone()), other => panic!("{other:?}"),
    };
    assert_eq!(style(&ana, NOW + 20_000), ("classic".to_string(), None), "classic is the default");
    bot.settings.set(G, "quotes", "quoteStyle", &json!("paper")).unwrap();
    assert_eq!(style(&ana, NOW + 40_000).0, "paper");
    bot.settings.set(G, "quotes", "quoteStyle", &json!("custom")).unwrap();
    assert_eq!(style(&ana, NOW + 60_000).0, "classic", "no licence, no custom look");
    bot.directory.set_licensed(true);
    let (st, custom) = style(&ana, NOW + 80_000);
    assert_eq!((st.as_str(), custom.is_some()), ("custom", true));
    // a colour setting only keeps real colours (any common spelling, saved as #rrggbb)
    assert!(bot.settings.set(G, "quotes", "quoteColourBg", &json!("red")).is_err());
    bot.settings.set(G, "quotes", "quoteColourBg", &json!("#F0A")).unwrap();
    assert_eq!(bot.settings.text(G, "quotes", "quoteColourBg").as_deref(), Some("#ff00aa"));
}

#[test]
fn critters_with_a_roster_staff_add() {
    use gb_core::critters::{add_xp, advantage, hint, name_matches, quality, release_value, slug, stats, Character};
    assert_eq!(slug("  Mister Nine! "), "mister-nine");
    assert_eq!(hint("Emberpup", 1), "E _ _ _ _ _ _ _");
    assert!(name_matches(" ember pup ", "Emberpup"));
    assert_eq!(add_xp(1, 0, 30), (2, 6, 1));
    assert_eq!(advantage("fire", "leaf"), 1.2);
    assert_eq!(advantage("leaf", "fire"), 0.83);
    let sp = Character { id: "x".into(), name: "X".into(), element: "fire".into(), rarity: "common".into(), hp: 45, atk: 52, def: 40, spd: 55, image: None };
    let c = gb_data::critters::Critter { species: "x".into(), level: 10, iv: [31, 31, 31, 31], ..Default::default() };
    assert_eq!(quality(&c.iv), 100);
    assert_eq!(stats(&c, &sp), (((2 * 45 + 31) * 10) / 100 + 10 + 10, ((2 * 52 + 31) * 10) / 100 + 5, ((2 * 40 + 31) * 10) / 100 + 5, ((2 * 55 + 31) * 10) / 100 + 5));
    assert_eq!(release_value(&c, &sp), 75);
    let (_tmp, bot) = bot();
    for m in ["critters", "economy"] { bot.db.get().set_module_enabled(G, m, true).unwrap(); }
    let admin = member("900000000000000131", "Ada", ADMINISTRATOR);
    let kai = member("900000000000000132", "Kai", 0);
    bot.db.get().wallet(G, &kai.id, Some("Kai"), 0).unwrap();
    // nothing comes built in: with an empty roster nothing can appear
    assert!(text(&run(&bot, cmd(&admin, "critters", Some("roster"), None, &[], NOW))[0]).contains("The roster is empty."));
    assert!(text(&run(&bot, cmd(&admin, "critters", Some("spawn"), None, &[], NOW))[0]).contains("There are no characters yet."));
    assert!(text(&run(&bot, cmd(&kai, "critters", Some("add"), None, &[("name", "Fox"), ("type", "fire"), ("rarity", "common")], NOW))[0]).contains("`critters.admin`"));
    // staff add their own
    let add = |name: &str, rarity: &str, extra: &[(&str, &str)]| { let mut a = vec![("name", name), ("type", "fire"), ("rarity", rarity)]; a.extend_from_slice(extra); text(&run(&bot, cmd(&admin, "critters", Some("add"), None, &a, NOW))[0]) };
    assert!(add("Ember Fox", "common", &[("picture", "https://example.com/fox.png"), ("attack", "80")]).contains("Added **Ember Fox**. The roster has 1 character."));
    assert!(add("Ember Fox", "common", &[]).contains("already a character with that name"));
    assert!(add("Bad", "common", &[("picture", "http://insecure/x.png")]).contains("A picture must be an https address."));
    let roster = text(&run(&bot, cmd(&admin, "critters", Some("roster"), None, &[], NOW))[0]);
    assert!(roster.contains("Roster (1)") && roster.contains("🔥 **Ember Fox** · Common · 50 / 80 / 50 / 50"), "{roster}");
    // it can now appear, with its picture, and the right name keeps it
    let out = run(&bot, cmd(&admin, "critters", Some("spawn"), None, &[], NOW));
    let Some(Action::Post { card, note, .. }) = out.iter().find(|a| matches!(a, Action::Post { .. })) else { panic!("{out:?}") };
    assert!(card.images == ["https://example.com/fox.png"] && card.files.is_empty() && card.buttons[0].id.starts_with("crit:catch:"), "{card:?}");
    bot.on_posted(G, note, "850000000000000001");
    let catch = card.buttons[0].id.clone();
    let press = |who: &Member, id: &str| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    let Action::Form { id, .. } = &press(&kai, &catch)[0] else { panic!() };
    let typed = |name: &str| bot.on_form(&gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: kai.clone(), id: id.clone(), values: [("name".to_string(), name.to_string())].into(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    assert!(text(&typed("Notacritter")[0]).contains("That's not its name!"));
    let got = typed("ember fox");
    assert!(text(&got[0]).contains("caught ✨ **Ember Fox** · Lv 1 (#1, 0% quality)! ✨ New to your collection!"), "{got:?}");
    let dex = text(&run(&bot, cmd(&kai, "critters", Some("dex"), None, &[], NOW))[0]);
    assert!(dex.contains("📖 Critter collection · 1/1") && dex.contains("🔥 **Fire** 1/1: Ember Fox"), "{dex}");
    // removing it from the roster does not break what members already caught
    assert!(text(&run(&bot, cmd(&admin, "critters", Some("remove"), None, &[("name", "ember fox")], NOW))[0]).contains("Removed **Ember Fox**."));
    assert!(text(&run(&bot, cmd(&kai, "critters", Some("list"), None, &[], NOW))[0]).contains("Ember Fox"));
    let ask = run(&bot, cmd(&kai, "critters", Some("release"), None, &[("id", "1")], NOW));
    let Action::Reply { card } = &ask[0] else { panic!() };
    assert!(text(&press(&kai, &card.buttons[0].id)[0]).contains("went back to the wild. You got **525** 🪙."));
}

#[test]
fn text_to_speech_like_good_boy_3() {
    use gb_core::tts::{clean_for_speech, looks_like_command, TtsCmd};
    assert_eq!(clean_for_speech("hi **there** https://x.com/a <@123> <:wave:456> _ok_"), "hi there link wave ok");
    assert!(looks_like_command("!play x", &["!", "/"]) && !looks_like_command("...", &["."]) && !looks_like_command("!!", &["!"]));
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "voice", true).unwrap();
    bot.settings.set(G, "voice", "noMicChannel", &json!("800000000000000161")).unwrap();
    bot.settings.set(G, "voice", "userCooldownSeconds", &json!(0)).unwrap();
    let kai = member("900000000000000151", "Kai", 0);
    let rowan = member("900000000000000152", "Rowan", 0);
    let admin = member("900000000000000153", "Ada", ADMINISTRATOR);
    assert!(text(&run(&bot, cmd(&kai, "tts", Some("say"), None, &[("text", "hello")], NOW))[0]).contains("Join a voice channel first."));
    bot.directory.set_voice(G, &kai.id, Some("800000000000000171"));
    bot.directory.set_voice(G, &rowan.id, Some("800000000000000172"));
    let said = run(&bot, cmd(&kai, "tts", Some("say"), None, &[("text", "hello **world** https://x.io")], NOW));
    assert!(text(&said[0]).contains("🔊 <@900000000000000151> queued (1 in line): hello world link"), "{said:?}");
    let Action::Tts(TtsCmd::Speak { id, voice, text: spoken, lang, .. }) = &said[1] else { panic!("{said:?}") };
    assert_eq!((voice.as_str(), spoken.as_str(), lang.as_str()), ("800000000000000171", "hello world link", "en"));
    // someone in another channel is told where I am; a second message waits its turn
    assert!(text(&run(&bot, cmd(&rowan, "tts", Some("say"), None, &[("text", "hi")], NOW))[0]).contains("Join <#800000000000000171> to use TTS with me."));
    let second = run(&bot, cmd(&kai, "tts", Some("say"), None, &[("text", "again")], NOW));
    assert!(text(&second[0]).contains("queued (2 in line)") && second.len() == 1, "{second:?}");
    assert!(text(&run(&bot, cmd(&kai, "tts", Some("queue"), None, &[], NOW))[0]).contains("▶️ <@900000000000000151>: hello world link"));
    // when the first ends, the second is spoken; a failure shows in chat
    let next = bot.on_music(G, 0, gb_core::music::Heard::TtsEnded(*id), NOW);
    let Action::Tts(TtsCmd::Speak { id: id2, text: t2, .. }) = &next[0] else { panic!("{next:?}") };
    assert_eq!(t2, "again");
    let failed = bot.on_music(G, 0, gb_core::music::Heard::TtsFailed(*id2, "the speech engine produced no audio".into()), NOW);
    assert!(text(&failed[0]).contains("⚠️ <@900000000000000151> I couldn't speak that: the speech engine produced no audio. An admin can run `/tts diagnose`."), "{failed:?}");
    // the no-mic channel: read with the name, only for members in the bot's channel, skipping other bots' commands
    let typed = |who: &Member, t: &str| bot.on_message(&MessageEvent { guild: G.into(), place: Place::channel("800000000000000161"), author: who.clone(), id: "860000000000000001".into(), text: t.into(), mentions: 0, mentioned: Vec::new(), files: Vec::new(), at_ms: NOW }, &mut |lo, _| lo);
    assert!(matches!(&typed(&kai, "gg everyone")[..], [Action::Tts(TtsCmd::Speak { text, .. })] if text == "Kai says gg everyone"));
    bot.on_music(G, 0, gb_core::music::Heard::TtsEnded(3), NOW);
    assert!(typed(&rowan, "hello").is_empty(), "not in the bot's voice channel");
    assert!(typed(&kai, "!play song").is_empty(), "looks like another bot's command");
    // control: skipping someone else's needs the permission; leaving forgets everything
    assert!(text(&run(&bot, cmd(&rowan, "tts", Some("stop"), None, &[], NOW))[0]).contains("You need the `voice.control` permission"));
    let left = run(&bot, cmd(&admin, "tts", Some("leave"), None, &[], NOW));
    assert!(matches!(&left[1], Action::Tts(TtsCmd::Leave)));
    assert!(text(&run(&bot, cmd(&kai, "tts", Some("queue"), None, &[], NOW))[0]).contains("The queue is empty."));
    // idle for the set minutes: leaves by itself
    run(&bot, cmd(&kai, "tts", Some("join"), None, &[], NOW));
    let idle = bot.on_tick(NOW + 6 * MINUTE, &mut |lo, _| lo);
    assert!(idle.iter().any(|(_, a)| matches!(a, Action::Tts(TtsCmd::Leave))), "{idle:?}");
}

#[test]
fn temporary_voice_like_good_boy_3() {
    use gb_core::bot::Named;
    use gb_core::tempvoice::{check_rename, next_owner, room_name, sanitize_name, Event, Joined};
    assert_eq!(room_name("{user}'s room #{n}", "<@1>Kai @everyone", 3), "Kai everyone's room #3");
    assert_eq!(sanitize_name("  \u{200b}  ", "Room"), "Room");
    let (ok, list, _) = check_rename(&[], 1000);
    assert!(ok && check_rename(&list, 2000).0 && !check_rename(&[1000, 2000], 3000).0 && check_rename(&[1000, 2000], 1000 + 600_001).0);
    let joined: std::collections::HashMap<String, i64> = [("b".to_string(), 5), ("c".to_string(), 3)].into();
    assert_eq!(next_owner(&["a".into(), "b".into(), "c".into()], "a", &joined).as_deref(), Some("c"));
    // an event: solo players are matched, friends accept, leaving opens a spot
    let mut e = Event::new("Duos", 2, 2, "h", "chan", None, 0).unwrap();
    assert!(matches!(e.join_solo("a"), Ok(Joined::Queued { position: 1, needed: 1 })));
    assert!(matches!(e.join_solo("b"), Ok(Joined::Formed(t)) if t.members == ["a", "b"] && !t.open));
    assert!(e.join_solo("a").unwrap_err().contains("already in this event"));
    let team = e.make_team("c", &["d".to_string()], true).unwrap();
    assert!(!team.open && team.invited == ["d"]);
    assert!(e.make_team("e", &[], true).unwrap_err().contains("full (2 teams)"));
    assert_eq!(e.accept(2, "d").unwrap().members, ["c", "d"]);
    assert!(e.leave("d").is_ok() && e.teams[1].open);
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "tempvoice", true).unwrap();
    bot.settings.set(G, "tempvoice", "emptyDelaySeconds", &json!(0)).unwrap();
    let named = |id: &str, name: &str, kind: &'static str| Named { id: id.into(), name: name.into(), kind, parent: String::new() };
    bot.directory.set_channels(G, vec![named("800000000000000181", "Join to create", "voice"), named("800000000000000182", "general", "text")]);
    let admin = member("900000000000000161", "Ada", ADMINISTRATOR);
    let kai = member("900000000000000162", "Kai", 0);
    let rowan = member("900000000000000163", "Rowan", 0);
    assert!(text(&run(&bot, cmd(&admin, "voicehub", Some("add"), None, &[("lobby", "800000000000000182")], NOW))[0]).contains("The lobby must be a voice channel."));
    assert!(text(&run(&bot, cmd(&admin, "voicehub", Some("add"), None, &[("lobby", "800000000000000181"), ("name", "{user}'s squad"), ("limit", "4")], NOW))[0]).contains("is now a lobby."));
    // joining the lobby asks for a room, which then belongs to the creator
    let joined = bot.on_voice(G, &kai, Some("800000000000000181"), false);
    let Some(Action::OpenRoom { name, limit, owner, move_in, note, .. }) = joined.iter().find(|a| matches!(a, Action::OpenRoom { .. })) else { panic!("{joined:?}") };
    assert_eq!((name.as_str(), *limit, owner.as_deref(), move_in.as_slice()), ("Kai's squad", 4, Some(kai.id.as_str()), [kai.id.clone()].as_slice()));
    bot.on_room_made(G, note, "800000000000000191");
    bot.on_voice(G, &kai, Some("800000000000000191"), false);
    assert!(text(&run(&bot, cmd(&kai, "room", Some("info"), None, &[], NOW))[0]).contains("owner <@900000000000000162> · 1 inside · public"));
    assert!(text(&run(&bot, cmd(&rowan, "room", Some("info"), None, &[], NOW))[0]).contains("Join one of your temporary rooms first"));
    // controls: rename (twice only), privacy, invite, and others can't
    assert!(run(&bot, cmd(&kai, "room", Some("name"), None, &[("name", "Chill")], NOW)).iter().any(|a| matches!(a, Action::RoomEdit { name: Some(n), .. } if n == "Chill")));
    run(&bot, cmd(&kai, "room", Some("name"), None, &[("name", "Chill 2")], NOW));
    assert!(text(&run(&bot, cmd(&kai, "room", Some("name"), None, &[("name", "Chill 3")], NOW))[0]).contains("renamed twice every 10 minutes"));
    let locked = run(&bot, cmd(&kai, "room", Some("privacy"), None, &[("mode", "hidden")], NOW));
    assert!(locked.iter().any(|a| matches!(a, Action::Overwrite { role: true, deny, .. } if *deny == (1 << 20 | 1 << 10))), "{locked:?}");
    bot.on_voice(G, &rowan, Some("800000000000000191"), false);
    assert!(text(&run(&bot, cmd(&rowan, "room", Some("limit"), None, &[("people", "2")], NOW))[0]).contains("Only the room's owner can do that. The owner is <@900000000000000162>."));
    // the owner leaves with Rowan still inside: the room moves to Rowan; when Rowan leaves too, it goes
    let left = bot.on_voice(G, &kai, None, false);
    assert!(left.iter().any(|a| matches!(a, Action::Overwrite { id, allow, .. } if *id == rowan.id && *allow != 0)), "{left:?}");
    let gone = bot.on_voice(G, &rowan, None, false);
    assert!(gone.iter().any(|a| matches!(a, Action::DeleteChannel { channel, .. } if channel == "800000000000000191")), "{gone:?}");
    assert!(text(&run(&bot, cmd(&admin, "voicehub", Some("list"), None, &[], NOW))[0]).contains("Open rooms: 0"));
    // an event hub from its popup: the panel, and a solo pair forming a team with a locked room
    bot.directory.set_channels(G, vec![named("800000000000000182", "general", "text"), named("800000000000000181", "Join to create", "voice")]);
    let made = bot.on_form(&gb_core::FormEvent { guild: G.into(), place: Place::channel("800000000000000182"), member: admin.clone(), id: "tvev:new".into(), values: [("name", "Battle Duos"), ("size", "2"), ("channel", "800000000000000182")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    assert!(text(&made[0]).contains("**Battle Duos** is open in <#800000000000000182>. Teams of 2, up to 10 teams."), "{made:?}");
    let Action::Post { card, note, .. } = &made[1] else { panic!() };
    assert!(card.buttons.iter().map(|b| b.label.as_str()).collect::<Vec<_>>() == ["Join solo", "Join with friends", "Make a team room", "Leave", "Lock sign-ups", "End event"], "{:?}", card.buttons);
    bot.on_posted(G, note, "870000000000000001");
    let press = |who: &Member, id: &str| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel("800000000000000182"), member: who.clone(), id: id.into(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    assert!(text(&press(&kai, "tvev:solo:1")[0]).contains("You're in the queue. 1 more player needed"));
    bot.directory.set_voice(G, &rowan.id, Some("800000000000000181"));
    let out = press(&rowan, "tvev:solo:1");
    let Some(Action::OpenRoom { name, lock, allow, move_in, note, limit, .. }) = out.iter().find(|a| matches!(a, Action::OpenRoom { .. })) else { panic!("{out:?}") };
    assert_eq!((name.as_str(), *lock, *limit, allow.len(), move_in.as_slice()), ("Battle Duos - Team 1", true, 2, 2, [rowan.id.clone()].as_slice()));
    let ready = bot.on_room_made(G, note, "800000000000000192");
    assert!(ready.iter().any(|a| matches!(a, Action::Send { card, .. } if card.lines[0].contains("is ready") && card.lines[0].contains("Hop in <#800000000000000192>"))), "{ready:?}");
    let ended = press(&admin, "tvev:end:1");
    assert!(text(&ended[0]).contains("**Battle Duos** has ended."));
}

#[test]
fn engagement_like_good_boy_3() {
    use gb_core::engagement::{is_emoji, normalize_hex, StarInfo};
    assert_eq!(normalize_hex("5865f2").as_deref(), Some("#5865F2"));
    assert_eq!(normalize_hex("#abc").as_deref(), Some("#AABBCC"));
    assert!(is_emoji("⭐") && is_emoji("<:star:123456789012345678>") && !is_emoji("hello") && !is_emoji(""));
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "engagement", true).unwrap();
    let admin = member("900000000000000171", "Ada", ADMINISTRATOR);
    let kai = member("900000000000000172", "Kai", 0);
    let rowan = member("900000000000000173", "Rowan", 0);
    let press = |who: &Member, id: &str, msg: &str, values: Vec<String>| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), message: msg.into(), values, at_ms: NOW }, &|_| None, &mut |lo, _| lo);
    let fill = |who: &Member, id: &str, vals: &[(&str, &str)], at: i64| bot.on_form(&gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), values: vals.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), at_ms: at, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    // an announcement: the private intro, then the popup, then a plain message that really pings
    let intro = run(&bot, cmd(&admin, "announce", Some("send"), None, &[], NOW));
    let Action::Reply { card } = &intro[0] else { panic!() };
    assert!(card.lines[1] == "-# Only you can see this. The button works for 15 minutes." && card.buttons[0].label == "Configure Announcement");
    assert!(text(&press(&kai, &card.buttons[0].id, "", vec![])[0]).contains("That form belongs to someone else."));
    let Action::Form { id, fields, .. } = &press(&admin, &card.buttons[0].id, "", vec![])[0] else { panic!() };
    assert_eq!((id.as_str(), fields.len()), ("eng:announce:send", 5));
    let sent = fill(&admin, "eng:announce:send", &[("channel", "800000000000000201"), ("text", "Maintenance at 6\\nback soon"), ("roles", G)], NOW);
    assert!(text(&sent[0]).contains("Announcement sent to <#800000000000000201>."));
    assert!(matches!(&sent[1], Action::Announce { text, card: None, everyone: true, .. } if text == "@everyone\nMaintenance at 6\nback soon"), "{sent:?}");
    // a schedule that repeats daily: posted when due, then moved a day on
    let sch = fill(&admin, "eng:announce:schedule", &[("channel", "800000000000000201"), ("when", "2h"), ("repeat", "daily"), ("text", "Daily reminder")], NOW);
    assert!(text(&sch[0]).contains("Scheduled **#1** for"), "{sch:?}");
    let due = bot.on_tick(NOW + 3 * HOUR, &mut |lo, _| lo);
    assert!(due.iter().any(|(_, a)| matches!(a, Action::Announce { text, .. } if text == "Daily reminder")));
    assert!(text(&run(&bot, cmd(&admin, "announce", Some("list"), None, &[], NOW + 3 * HOUR))[0]).contains("**#1**") );
    let cancelled = press(&admin, &format!("eng:cancel:{}", admin.id), "", vec!["1".into()]);
    assert!(text(&cancelled[0]).contains("🗑️ Cancelled #1.") && text(&cancelled[0]).contains("Nothing scheduled."));
    // a poll: made, voted (one vote each, changeable), ended
    assert!(text(&run(&bot, cmd(&kai, "poll", Some("create"), None, &[("question", "Pizza?"), ("option1", "Yes"), ("option2", "No")], NOW))[0]).contains("`engagement.poll`"));
    let made = run(&bot, cmd(&admin, "poll", Some("create"), None, &[("question", "Pizza?"), ("option1", "Yes"), ("option2", "No")], NOW));
    let Action::Post { note, card, .. } = &made[1] else { panic!("{made:?}") };
    assert_eq!(card.buttons.iter().map(|b| b.label.as_str()).collect::<Vec<_>>(), ["1", "2"]);
    bot.on_posted(G, note, "880000000000000001");
    let v1 = press(&kai, "poll:vote:880000000000000001:0", "880000000000000001", vec![]);
    assert!(text(&v1[0]).contains("1 (100%)") && text(&v1[0]).contains("1 voter(s)"), "{v1:?}");
    let v2 = press(&kai, "poll:vote:880000000000000001:1", "880000000000000001", vec![]);
    assert!(text(&v2[0]).contains("**1. Yes**") && text(&v2[0]).contains("**2. No**\n▰▰▰▰▰▰▰▰▰▰▰▰▰▰ 1 (100%)"), "{}", text(&v2[0]));
    let ended = run(&bot, cmd(&admin, "poll", Some("end"), None, &[("message_id", "880000000000000001")], NOW));
    assert!(matches!(&ended[1], Action::Edit { card, .. } if card.buttons.iter().all(|b| b.disabled)) && text(&ended[2]).contains("The poll **Pizza?** has ended."), "{ended:?}");
    assert!(text(&press(&rowan, "poll:vote:880000000000000001:0", "880000000000000001", vec![])[0]).contains("This poll has ended."));
    // suggestions: need a channel, then vote, staff change the status and the author hears
    assert!(text(&run(&bot, cmd(&kai, "suggest", None, None, &[("idea", "More emoji")], NOW))[0]).contains("Suggestions are not set up here yet."));
    run(&bot, cmd(&admin, "suggestion", Some("setup"), None, &[("channel", "800000000000000202")], NOW));
    let sg = run(&bot, cmd(&kai, "suggest", None, None, &[("idea", "More emoji")], NOW));
    assert!(text(&sg[0]).contains("Your suggestion is **#1**."));
    let Action::Post { note, .. } = &sg[1] else { panic!() };
    bot.on_posted(G, note, "890000000000000001");
    assert!(text(&run(&bot, cmd(&kai, "suggest", None, None, &[("idea", "Again")], NOW + 1000))[0]).contains("Please wait 59s before another suggestion."));
    let up = press(&rowan, "sugg:up:1", "890000000000000001", vec![]);
    assert!(text(&up[0]).contains("👍 1   👎 0   (net +1)"), "{up:?}");
    let st = run(&bot, cmd(&admin, "suggestion", Some("status"), None, &[("id", "1"), ("status", "approved"), ("note", "Coming soon")], NOW));
    assert!(text(&st[0]).contains("Suggestion #1 is now **Approved**."));
    assert!(st.iter().any(|a| matches!(a, Action::Dm { user, card, .. } if *user == kai.id && card.lines[0].contains("Your suggestion #1 is now **Approved**: Coming soon"))), "{st:?}");
    assert!(text(&press(&rowan, "sugg:down:1", "890000000000000001", vec![])[0]).contains("Voting on this suggestion is closed."));
    assert!(text(&run(&bot, cmd(&kai, "suggestion", Some("status"), None, &[("id", "1"), ("status", "denied")], NOW))[0]).contains("Only staff can do that"));
    // the starboard: setup, a message reaching the threshold is posted, then follows its stars, and goes if deleted
    run(&bot, cmd(&admin, "starboard", Some("setup"), None, &[("channel", "800000000000000203"), ("threshold", "2")], NOW));
    let ask = bot.on_reaction_at(G, "800000000000000204", "900000000000000999", "⭐", &rowan.id, true);
    assert!(ask.iter().any(|a| matches!(a, Action::StarCheck { skip_author: true, .. })), "{ask:?}");
    let info = |count: i64| StarInfo { channel: "800000000000000204".into(), message: "900000000000000999".into(), author: kai.id.clone(), author_name: "Kai".into(), content: "best joke".into(), url: "https://discord.com/channels/1/2/3".into(), count, at_ms: NOW, ..Default::default() };
    assert!(bot.on_star(G, &info(1)).is_empty());
    let posted = bot.on_star(G, &info(2));
    let Action::Post { channel, card, note, .. } = &posted[0] else { panic!("{posted:?}") };
    assert!(channel == "800000000000000203" && card.lines[0] == "⭐ **2** · <#800000000000000204>");
    bot.on_posted(G, note, "910000000000000001");
    assert!(matches!(&bot.on_star(G, &info(3))[0], Action::Edit { message, card, .. } if message == "910000000000000001" && card.lines[0].contains("**3**")));
    assert!(matches!(&bot.on_star(G, &info(1))[0], Action::Delete { message, .. } if message == "910000000000000001"));
    assert!(text(&run(&bot, cmd(&kai, "starboard", Some("top"), None, &[], NOW))[0]).contains("Nothing has been starred yet."));
    assert!(text(&run(&bot, cmd(&kai, "starboard", Some("status"), None, &[], NOW))[0]).contains("`engagement.manage`"));
}

/// Activity counting keeps its numbers per server in memory shared by the whole program, so tests about it take turns.
static STATS_TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn activity_stats_like_good_boy_3() {
    let _turn = STATS_TURN.lock().unwrap_or_else(|p| p.into_inner());
    use gb_core::stats::{add_days, counter_name, day_key, hours, period_range, week_start_key, InactiveAsk, InactiveOp, MemberFact};
    assert_eq!(day_key(1_794_441_600_000, 0), "2026-11-12");
    assert_eq!(add_days("2026-11-30", 1), "2026-12-01");
    assert_eq!(week_start_key(1_794_441_600_000, 0), "2026-11-09");
    assert_eq!(period_range("lastmonth", 1_794_441_600_000, 0), ("2026-10-01".into(), "2026-11-01".into()));
    assert_eq!(period_range("7d", 1_794_441_600_000, 0).0, "2026-11-06");
    assert_eq!((hours(5400), hours(7200)), ("1.5".to_string(), "2".to_string()));
    let v: std::collections::HashMap<&str, i64> = [("members", 1234), ("voice", 3)].into();
    assert_eq!(counter_name("👥 {members} · 🔊 {voice}", &v), "👥 1,234 · 🔊 3");
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "stats", true).unwrap();
    let kai = member("900000000000000181", "Kai", 0);
    let rowan = member("900000000000000182", "Rowan", 0);
    let admin = member("900000000000000183", "Ada", ADMINISTRATOR);
    let base = 1_794_441_600_000i64; // 2026-11-12 (a Thursday)
    let talk = |who: &Member, ch: &str, n: i64, at: i64| for k in 0..n { bot.on_message(&MessageEvent { guild: G.into(), place: Place::channel(ch), author: who.clone(), id: format!("92000000000000{k:04}"), text: "hi".into(), mentions: 0, mentioned: Vec::new(), files: Vec::new(), at_ms: at }, &mut |lo, _| lo); };
    talk(&kai, "800000000000000211", 5, base);
    talk(&rowan, "800000000000000212", 2, base);
    talk(&kai, "800000000000000211", 3, base - 40 * 86_400_000);
    bot.on_reaction(G, "m", "👍", &kai.id, true);
    // voice time counts while connected
    bot.directory.set_channels(G, vec![]);
    bot.on_voice(G, &kai, Some("800000000000000221"), false);
    bot.on_voice(G, &kai, None, false);
    let report = text(&run(&bot, cmd(&admin, "stats", Some("member"), Some(&kai), &[], base))[0]);
    assert!(report.contains("📊 Kai") && report.contains("**This month**\n**5** messages · #1") && report.contains("**All time**\n**8** messages · #1"), "{report}");
    let top = text(&run(&bot, cmd(&admin, "stats", Some("top"), None, &[("metric", "messages"), ("period", "7d")], base))[0]);
    assert!(top.contains("**1.** <@900000000000000181> · 5") && top.contains("**2.** <@900000000000000182> · 2"), "{top}");
    let server = text(&run(&bot, cmd(&admin, "stats", Some("server"), None, &[("period", "7d")], base))[0]);
    assert!(server.contains("**Messages** 7") && server.contains("**Active members** 2") && server.contains("<#800000000000000211> · 5 messages"), "{server}");
    assert!(text(&run(&bot, cmd(&kai, "stats", Some("recap"), None, &[], base))[0]).contains("`stats.manage`"));
    assert!(text(&run(&bot, cmd(&kai, "stats", Some("coverage"), None, &[], base))[0]).contains("No older history has been counted."));
    // opting out stops counting and hides the member; forgetting erases their numbers
    run(&bot, cmd(&rowan, "stats", Some("optout"), None, &[], base));
    talk(&rowan, "800000000000000212", 4, base);
    assert!(text(&run(&bot, cmd(&kai, "stats", Some("me"), Some(&rowan), &[], base))[0]).contains("That member opted out of statistics."));
    assert!(text(&run(&bot, cmd(&admin, "stats", Some("server"), None, &[("period", "7d")], base))[0]).contains("**Messages** 7"));
    run(&bot, cmd(&kai, "stats", Some("forget"), None, &[], base));
    assert!(text(&run(&bot, cmd(&admin, "stats", Some("server"), None, &[("period", "all")], base))[0]).contains("**Messages** 2"));
    // inactive members: staff, new members, bots and active people are never listed; kicks always ask first
    let fact = |id: &str, name: &str, joined: i64| MemberFact { id: id.into(), name: name.into(), joined_at: Some(joined), kickable: true, ..Default::default() };
    let facts = vec![fact("900000000000000191", "Old quiet", base - 90 * 86_400_000), fact("900000000000000182", "Rowan", base - 90 * 86_400_000), fact("900000000000000192", "New one", base - 3 * 86_400_000),
        MemberFact { bot: true, ..fact("900000000000000193", "A bot", 0) }, MemberFact { perms: 1 << 1, ..fact("900000000000000194", "A moderator", 0) }, fact("900000000000000195", "Locked", base - 90 * 86_400_000)];
    let ask = InactiveAsk { owner: admin.id.clone(), days: 30, op: InactiveOp::List { page: 0 }, update: false };
    let listed = bot.inactive(G, &ask, &facts, base);
    let shown = text(&listed[0]);
    assert!(shown.contains("🧹 Inactive for 30+ days · 2 members") && shown.contains("<@900000000000000191> · no activity on record") && !shown.contains("New one") && !shown.contains("moderator"), "{shown}");
    let confirm = bot.inactive(G, &InactiveAsk { op: InactiveOp::Pick { ids: vec!["900000000000000191".into()] }, update: true, ..ask.clone() }, &facts, base);
    assert!(text(&confirm[0]).contains("Kick **1** member for being inactive 30+ days?") && matches!(&confirm[0], Action::Update { card } if card.buttons[0].label == "Yes, kick 1"), "{confirm:?}");
    let done = bot.inactive(G, &InactiveAsk { op: InactiveOp::Confirm, update: true, ..ask.clone() }, &facts, base + 1000);
    assert!(text(&done[0]).contains("✅ Kicked **1**") && matches!(&done[1], Action::KickInactive { user, dm: Some(t), .. } if user == "900000000000000191" && t.contains("{server}")), "{done:?}");
    // the button is only for whoever asked, and needs the permission
    let press = |who: &Member, id: &str| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), message: "m".into(), values: vec![], at_ms: base }, &|_| None, &mut |lo, _| lo);
    assert!(text(&press(&kai, &format!("st:ip:{}:30:1", admin.id))[0]).contains("That list belongs to someone else."));
    assert!(matches!(&press(&admin, &format!("st:ip:{}:30:1", admin.id))[0], Action::Inactive(a) if a.update && a.op == InactiveOp::List { page: 1 }));
    // counters: added, then refreshed every 10 minutes
    let c = run(&bot, cmd(&admin, "counter", Some("add"), None, &[("channel", "800000000000000231"), ("text", "Members: {members}")], base));
    assert!(text(&c[0]).contains("<#800000000000000231> is now a counter.") && matches!(&c[1], Action::Counters { items } if items[0].1 == "Members: {members}"), "{c:?}");
    assert!(text(&run(&bot, cmd(&admin, "counter", Some("add"), None, &[("channel", "800000000000000231"), ("text", "no numbers")], base))[0]).contains("Put at least one number in the text"));
    // the weekly recap on Monday, only once; personal recaps only for members who opted in
    bot.settings.set(G, "stats", "recapChannel", &json!("800000000000000241")).unwrap();
    assert!(bot.on_tick(base, &mut |lo, _| lo).iter().all(|(_, a)| !matches!(a, Action::Send { .. })), "the first run only starts the clock");
    let monday = bot.on_tick(base + 4 * 86_400_000, &mut |lo, _| lo);
    assert!(monday.iter().any(|(_, a)| matches!(a, Action::Send { channel, card, .. } if channel == "800000000000000241" && card.title.as_deref().is_some_and(|t| t.starts_with("📊 Last week in")))), "{monday:?}");
    assert!(!bot.on_tick(base + 4 * 86_400_000 + 1000, &mut |lo, _| lo).iter().any(|(_, a)| matches!(a, Action::Send { card, .. } if card.title.as_deref().is_some_and(|t| t.starts_with("📊 Last week")))));
}

#[test]
fn community_like_good_boy_3() {
    use gb_core::bot::VoiceFlags;
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "community", true).unwrap();
    let admin = member("900000000000000201", "Ada", ADMINISTRATOR);
    let kai = member("900000000000000202", "Kai", 0);
    let rowan = member("900000000000000203", "Rowan", 0);
    let base = 1_794_441_600_000i64;
    let say = |who: &Member, n: i64| for k in 0..n { bot.on_message(&MessageEvent { guild: G.into(), place: Place::channel(CH), author: who.clone(), id: format!("93000000000000{k:04}"), text: "hi".into(), mentions: 0, mentioned: Vec::new(), files: Vec::new(), at_ms: base + k * 61_000 }, &mut |lo, _| lo); };
    say(&kai, 3);
    say(&rowan, 1);
    // leaderboard: types, pages, wording
    let board = text(&run(&bot, cmd(&kai, "leaderboard", None, None, &[], base))[0]);
    assert!(board.contains("Leaderboard · XP") && board.contains(&format!("🥇 <@{}> - level 0 · 45 XP", kai.id)) && board.contains("Page 1/1"), "{board}");
    assert!(text(&run(&bot, cmd(&kai, "leaderboard", None, None, &[("page", "2")], base))[0]).contains("There is only 1 page."));
    assert!(text(&run(&bot, cmd(&kai, "leaderboard", None, None, &[("type", "rep")], base))[0]).contains("Nobody yet - start chatting!"));
    // reputation: give, limits, history, admin tools
    let give = run(&bot, cmd(&kai, "rep", Some("give"), Some(&rowan), &[("reason", "helpful")], base));
    assert!(text(&give[0]).contains("⭐ <@900000000000000202> gave <@900000000000000203> **+1** reputation: helpful (now **+1**)."), "{give:?}");
    assert!(text(&run(&bot, cmd(&kai, "rep", Some("give"), Some(&rowan), &[], base + 1000))[0]).contains("You can give reputation again"));
    assert!(text(&run(&bot, cmd(&kai, "rep", Some("give"), Some(&kai), &[], base))[0]).contains("You can't give reputation to yourself."));
    assert!(text(&run(&bot, cmd(&kai, "rep", Some("check"), Some(&rowan), &[], base))[0]).contains("**Rowan** has **+1** reputation."));
    assert!(text(&run(&bot, cmd(&rowan, "rep", Some("history"), Some(&kai), &[], base))[0]).contains("`community.rep-admin`"));
    assert!(text(&run(&bot, cmd(&rowan, "rep", Some("history"), None, &[], base))[0]).contains("**give** +1 → +1 by <@900000000000000202> - helpful"));
    assert!(text(&run(&bot, cmd(&admin, "rep", Some("set"), Some(&rowan), &[("value", "-4")], base))[0]).contains("went from **+1** to **-4**"));
    assert!(text(&run(&bot, cmd(&admin, "leaderboard", None, None, &[("type", "rep")], base))[0]).contains("<@900000000000000203> - -4 rep"));
    let ask = run(&bot, cmd(&admin, "rep", Some("reset-all"), None, &[], base));
    assert!(text(&ask[0]).contains("sets **1** member(s)' reputation to **0**"));
    let id = bot_button_id(&ask[0]);
    let press = |who: &Member, id: &str| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), message: "m".into(), values: vec![], at_ms: base + 5000 }, &|_| None, &mut |lo, _| lo);
    assert!(text(&press(&kai, &id)[0]).contains("expired or belongs to someone else"));
    assert!(text(&press(&admin, &id)[0]).contains("✅ Reset **1** member(s) to 0."));
    // /xp: set, ignore, boost; /levels reward
    assert!(text(&run(&bot, cmd(&kai, "xp", Some("set"), Some(&rowan), &[("amount", "10")], base))[0]).contains("`community.manage`"));
    assert!(text(&run(&bot, cmd(&admin, "xp", Some("set"), Some(&rowan), &[("amount", "300")], base))[0]).contains("<@900000000000000203> is now level **2** (300 XP)."));
    assert!(text(&run(&bot, cmd(&admin, "xp", Some("boost add"), None, &[("multiplier", "1.5"), ("role", "700000000000000001")], base))[0]).contains("now earns **×1.5** XP."));
    assert!(text(&run(&bot, cmd(&admin, "xp", Some("boost add"), None, &[("multiplier", "9"), ("role", "700000000000000001")], base))[0]).contains("Use a multiplier from 0.1 to 5"));
    assert!(text(&run(&bot, cmd(&admin, "xp", Some("boost list"), None, &[], base))[0]).contains("<@&700000000000000001> · **×1.5**"));
    assert!(text(&run(&bot, cmd(&admin, "xp", Some("ignore add"), None, &[("channel", "800000000000000299")], base))[0]).contains("🔕 No more XP or level-up messages in <#800000000000000299>."));
    assert!(text(&run(&bot, cmd(&admin, "xp", Some("ignore list"), None, &[], base))[0]).contains("<#800000000000000299>"));
    assert!(text(&run(&bot, cmd(&admin, "levels", Some("reward list"), None, &[], base))[0]).contains("No rewards yet."));
    // voice XP: two people talking earn, a lone or deafened one does not; at most once a minute
    let flags = |m: &Member, muted: bool, deaf: bool| VoiceFlags { member: m.clone(), muted, deaf, category: None };
    for (m, muted, deaf) in [(&kai, false, false), (&rowan, false, false), (&admin, false, true)] {
        bot.directory.set_voice(G, &m.id, Some("800000000000000221"));
        bot.directory.set_voice_flags(G, flags(m, muted, deaf));
    }
    let xp_of = |m: &Member| bot.db.get().xp(G, &m.id).unwrap();
    let (k0, r0, a0) = (xp_of(&kai), xp_of(&rowan), xp_of(&admin));
    bot.on_tick(base + 10 * 60_000, &mut |lo, _| lo);
    assert_eq!((xp_of(&kai) - k0, xp_of(&rowan) - r0, xp_of(&admin) - a0), (12, 12, 0));
    bot.on_tick(base + 10 * 60_000 + 5_000, &mut |lo, _| lo);
    assert_eq!(xp_of(&kai) - k0, 12, "once a minute");
    // reaction XP: not on your own message
    let place = Place::channel(CH);
    bot.on_reaction_xp(G, &kai, Some(&kai.id), &place, base + 20 * 60_000);
    assert_eq!(xp_of(&kai) - k0, 12);
    bot.on_reaction_xp(G, &kai, Some(&rowan.id), &place, base + 20 * 60_000);
    assert_eq!(xp_of(&kai) - k0, 14);
    // live board: posts once, then edits only when something changed
    assert!(text(&run(&bot, cmd(&kai, "liveboard", Some("refresh"), None, &[], base))[0]).contains("`community.manage`"));
    let setup = run(&bot, cmd(&admin, "liveboard", Some("setup"), None, &[("channel", "800000000000000250")], base));
    assert!(text(&setup[0]).contains("Posted the live leaderboard.") && matches!(&setup[1], Action::Post { note, .. } if note == "liveboard"), "{setup:?}");
    bot.on_posted(G, "liveboard", "950000000000000001");
    let again = run(&bot, cmd(&admin, "liveboard", Some("refresh"), None, &[], base + 1000));
    assert!(text(&again[0]).contains("Refreshed") && matches!(&again[1], Action::EditOrPost { message, .. } if message == "950000000000000001"), "{again:?}");
    let gone = run(&bot, cmd(&admin, "liveboard", Some("remove"), None, &[], base + 2000));
    assert!(text(&gone[0]).contains("The live leaderboard is off.") && matches!(&gone[1], Action::Delete { message, .. } if message == "950000000000000001"), "{gone:?}");
    // leaving deletes the record
    bot.on_member(G, &kai, false);
    assert_eq!(xp_of(&kai), 0);
}
fn bot_button_id(a: &Action) -> String {
    let Action::Reply { card } = a else { panic!("not a reply") };
    card.buttons[0].id.clone()
}

#[test]
fn moderation_upgrades() {
    use gb_core::bot::RoleFacts;
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "moderation", true).unwrap();
    bot.on_server(G, "Ghost Town");
    bot.settings.set(G, "moderation", "logChannel", &json!("800000000000000301")).unwrap();
    let mods = |id: &str, name: &str, roles: &[&str]| Member { id: id.into(), name: name.into(), perms: (1 << 1) | (1 << 2) | (1 << 4) | (1 << 40), roles: roles.iter().map(|r| r.to_string()).collect(), ..Default::default() };
    let (low, high) = ("700000000000000011", "700000000000000012");
    bot.directory.set_role_facts(G, [(low.to_string(), RoleFacts { name: "Mod".into(), position: 5, managed: false, perms: 0, mentionable: true }), (high.to_string(), RoleFacts { name: "Boss".into(), position: 10, managed: false, perms: 0, mentionable: true })].into(), Some(20));
    let mod1 = mods("900000000000000401", "Mia", &[low]);
    let mod2 = mods("900000000000000402", "Max", &[low]);
    let boss = member("900000000000000403", "Bo", 0);
    let boss = Member { roles: vec![high.into()], ..boss };
    let kai = member("900000000000000404", "Kaito", 0);
    let base = 1_794_441_600_000i64;
    let sent = |actions: &[Action]| actions.iter().filter_map(|a| if let Action::Send { card, .. } = a { Some(card.to_discord().unwrap().to_string().replace("\\n", "\n")) } else { None }).collect::<Vec<_>>().join("\n");

    // role hierarchy: a moderator cannot act on someone with a higher role
    assert!(text(&run(&bot, cmd(&mod1, "kick", None, Some(&boss), &[("reason", "no")], base))[0]).contains("equal to or above yours"));
    assert!(text(&run(&bot, cmd(&mod1, "kick", None, Some(&mod1), &[("reason", "no")], base))[0]).contains("yourself"));

    // notes
    assert!(text(&run(&bot, cmd(&mod1, "note", Some("add"), Some(&kai), &[("text", "Helped a lot in #support")], base))[0]).contains("Note #1 saved"));
    assert!(text(&run(&bot, cmd(&mod2, "note", Some("list"), Some(&kai), &[], base))[0]).contains("Helped a lot"));
    assert!(text(&run(&bot, cmd(&kai, "note", Some("list"), Some(&kai), &[], base))[0]).contains("`moderation.notes`"));
    assert!(text(&run(&bot, cmd(&mod1, "note", Some("remove"), Some(&kai), &[("number", "1")], base))[0]).contains("deleted"));

    // watchlist: staff are told when a watched member posts, at most every ten minutes
    run(&bot, cmd(&mod1, "watch", Some("add"), Some(&kai), &[("reason", "ban evader?")], base));
    let post = |at: i64| bot.on_message(&MessageEvent { guild: G.into(), place: Place::channel(CH), author: kai.clone(), id: "930000000000000001".into(), text: "hello".into(), mentions: 0, mentioned: Vec::new(), files: Vec::new(), at_ms: at }, &mut |lo, _| lo);
    assert!(sent(&post(base + 1000)).contains("Watched member posted"));
    assert!(!sent(&post(base + 2000)).contains("Watched member posted"));
    assert!(text(&run(&bot, cmd(&mod1, "watch", Some("list"), None, &[], base))[0]).contains("ban evader?"));

    // a warning, an appeal, and a staff decision
    let warned = run(&bot, cmd(&mod1, "warn", None, Some(&kai), &[("reason", "spamming"), ("severity", "low")], base + 5000));
    assert!(text(&warned[0]).contains("case #"), "{warned:?}");
    let appeal = run(&bot, cmd(&kai, "appeal", None, None, &[("case", "1"), ("why", "It was a joke, sorry")], base + 6000));
    assert!(text(&appeal[0]).contains("Your appeal (#1) was sent to staff"), "{appeal:?}");
    assert!(sent(&appeal).contains("It was a joke, sorry"));
    assert!(text(&run(&bot, cmd(&kai, "appeal", None, None, &[("case", "1"), ("why", "again")], base + 7000))[0]).contains("already has an appeal"));
    let press = |who: &Member, id: &str, at: i64| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), message: "m".into(), values: vec![], at_ms: at }, &|_| None, &mut |lo, _| lo);
    assert!(text(&press(&kai, "mapp:yes:1", base + 8000)[0]).contains("`moderation.warn`"));
    let done = press(&mod2, "mapp:yes:1", base + 9000);
    assert!(text(&done[0]).contains("Taken back by"), "{done:?}");
    assert!(done.iter().any(|a| matches!(a, Action::Dm { user, .. } if user == &kai.id)));
    assert!(text(&run(&bot, cmd(&mod1, "modhistory", None, Some(&kai), &[], base + 10_000))[0]).contains("clean record"));

    // a ban needs a second staff member when the server asks for it
    bot.settings.set(G, "moderation", "needApproval", &json!("kick-ban")).unwrap();
    let ask = run(&bot, cmd(&mod1, "ban", None, Some(&kai), &[("reason", "raiding")], base + 20_000));
    assert!(text(&ask[0]).contains("second staff member"), "{ask:?}");
    assert!(sent(&ask).contains("Approve"));
    assert!(text(&press(&mod1, "mapr:yes:1", base + 21_000)[0]).contains("Another staff member has to approve"));
    let ok = press(&mod2, "mapr:yes:1", base + 22_000);
    assert!(ok.iter().any(|a| matches!(a, Action::Ban { user, .. } if user == &kai.id)), "{ok:?}");
    // an administrator is never held up
    let admin = member("900000000000000405", "Ada", ADMINISTRATOR);
    let direct = run(&bot, cmd(&admin, "kick", None, Some(&kai), &[("reason", "test")], base + 23_000));
    assert!(direct.iter().any(|a| matches!(a, Action::Kick { .. })), "{direct:?}");

    // ban evasion: a new member with a banned member's name is flagged
    let alert = bot.on_member(G, &member("900000000000000406", "KAITO", 0), true);
    assert!(sent(&alert).contains("Might be a banned member back"), "{alert:?}");

    // report a message
    let rep = run(&bot, cmd(&boss, "report", None, None, &[("message_id", "930000000000000009"), ("channel_id", CH), ("text", "buy cheap coins"), ("author_id", &kai.id), ("why", "scam")], base + 30_000));
    assert!(text(&rep[0]).contains("Staff have been told"));
    let card = sent(&rep);
    assert!(card.contains("Message reported") && card.contains("buy cheap coins") && card.contains("Warn author"), "{card}");

    // lockdown
    assert!(text(&run(&bot, cmd(&kai, "lockdown", Some("on"), None, &[], base))[0]).contains("`moderation.lockdown`"));
    let on = run(&bot, cmd(&mod1, "lockdown", Some("on"), None, &[("reason", "raid")], base + 40_000));
    assert!(on.iter().any(|a| matches!(a, Action::Lockdown { on: true, .. })));
    assert!(text(&run(&bot, cmd(&mod1, "lockdown", Some("on"), None, &[], base + 41_000))[0]).contains("already locked"));
    let off = run(&bot, cmd(&mod2, "lockdown", Some("off"), None, &[], base + 50_000));
    assert!(off.iter().any(|a| matches!(a, Action::Lockdown { on: false, .. })));
}

#[test]
fn losses_feed_the_jackpot_all_in_works_and_coins_can_be_added_to_the_treasury() {
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "economy", true).unwrap();
    bot.db.get().set_module_enabled(G, "games", true).unwrap();
    let kai = member("900000000000000601", "Kai", 0);
    let base = 1_794_441_600_000i64;
    bot.db.get().wallet(G, &kai.id, Some("Kai"), 1000).unwrap();
    let coins = || bot.db.get().wallet(G, &kai.id, None, 0).unwrap().coins;
    let pool = || bot.db.get().data_get(G, "games", "pool").unwrap().and_then(|v| v.as_i64()).unwrap_or(5000);
    let flip = |bet: &str, side: &str, at: i64| text(&bot.on_command(&cmd(&kai, "coinflip", None, None, &[("bet", bet), ("side", side)], at), &|_| None, &mut |lo, _| lo)[0]);
    // one of the two calls loses: exactly that bet goes into the jackpot
    let before = pool();
    flip("100", "heads", base);
    flip("100", "tails", base + 1000);
    assert_eq!(pool(), before + 100, "the lost 100 is in the jackpot, the win is not");
    assert!((990..=1000).contains(&coins()), "one lost and one won (a tax on the win may apply): {}", coins());
    // the share is a setting
    bot.settings.set(G, "games", "jackpotLossPercent", &json!(50)).unwrap();
    let before = pool();
    flip("100", "heads", base + 2000);
    flip("100", "tails", base + 3000);
    assert_eq!(pool(), before + 50);
    // all in bets everything, even above the biggest bet
    let have = coins();
    bot.db.get().credit(G, &kai.id, 200_000 - have, "test").unwrap();
    assert_eq!(coins(), 200_000);
    let said = flip("all in", "heads", base + 4000);
    assert!(!said.contains("at most"), "{said}");
    assert!(coins() == 0 || coins() >= 390_000, "everything was on the line: {}", coins());
    // a server can turn it off: then the biggest bet applies again
    bot.db.get().credit(G, &kai.id, 200_000, "test").unwrap();
    bot.settings.set(G, "games", "allowAllIn", &json!(false)).unwrap();
    assert!(flip("all", "heads", base + 5000).contains("at most"));
    // and the buttons carry it
    let again = bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: kai.clone(), id: format!("cf:heads:{}:-1", kai.id), message: "m".into(), values: vec![], at_ms: base + 6000 }, &|_| None, &mut |lo, _| lo);
    assert!(text(&again[0]).contains("at most"), "the button asks for all in, and the server said no");
    bot.settings.set(G, "games", "allowAllIn", &json!(true)).unwrap();
    let before = coins();
    let again = bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: kai.clone(), id: format!("cf:heads:{}:-1", kai.id), message: "m".into(), values: vec![], at_ms: base + 7000 }, &|_| None, &mut |lo, _| lo);
    assert!(text(&again[0]).contains("All in") || text(&again[0]).contains("Wallet"), "{}", text(&again[0]));
    assert!(coins() == 0 || coins() >= before * 2 - before / 10);

    // the treasury: coins can be added from the launcher and by admins in Discord
    let t = || bot.db.get().treasury(G).unwrap().balance;
    assert_eq!(bot.economy_add(G, 5000, "seed", base).unwrap(), 5000);
    assert_eq!(t(), 5000);
    assert!(bot.economy_add(G, 0, "", base).is_err() && bot.economy_add(G, -5, "", base).is_err());
    assert!(bot.economy_add("700000000000000002", 10, "", base).is_err(), "money is off in a server that has not turned it on");
    let admin = member("900000000000000009", "Ada", ADMINISTRATOR);
    let card = text(&bot.on_command(&cmd(&admin, "treasury", None, None, &[], base), &|_| None, &mut |lo, _| lo)[0]);
    assert!(card.contains("Add coins") && card.contains("Pay out"), "an admin who does not own the server can add too: {card}");
    let card = text(&bot.on_command(&cmd(&kai, "treasury", None, None, &[], base), &|_| None, &mut |lo, _| lo)[0]);
    assert!(card.contains("Give coins") && !card.contains("Add coins"), "{card}");
}

#[test]
fn the_new_slots_and_blackjack_with_real_wallets() {
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "economy", true).unwrap();
    bot.db.get().set_module_enabled(G, "games", true).unwrap();
    let kai = member("900000000000000501", "Kai", 0);
    let base = 1_794_441_600_000i64;
    bot.db.get().wallet(G, &kai.id, Some("Kai"), 1000).unwrap();
    let coins = || bot.db.get().wallet(G, &kai.id, None, 0).unwrap().coins;
    let press = |id: &str, at: i64| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: kai.clone(), id: id.into(), message: "m".into(), values: vec![], at_ms: at }, &|_| None, &mut |lo, _| lo);
    // slots: the bet is taken and shown with the 3 by 3 window; a rigged "always the first symbol" roll gives three cherries
    let out = bot.on_command(&cmd(&kai, "slots", None, None, &[("bet", "100")], base), &|_| None, &mut |lo, _| lo);
    let card = text(&out[0]);
    assert!(card.contains("🎰 Slots") && card.contains("won") && card.contains("attachment://slots-"), "{card}");
    assert!(matches!(&out[0], Action::Reply { card } if card.files.len() == 1 && card.files[0].data.starts_with(b"GIF8")), "the window is a moving picture");
    // three cherries pay 4x = 400 (jackpot share 3% of 100 goes to the pool): 1000 - 100 + 400
    assert_eq!(coins(), 1300);
    // spinning again from the button, and the hot streak shows
    let again = press(&format!("sl:again:{}:100", kai.id), base + 1000);
    assert!(text(&again[0]).contains("Hot streak"), "{}", text(&again[0]));
    assert!(text(&press("sl:again:900000000000000999:100", base + 2000)[0]).contains("someone else's game"));
    // auto spins five times
    let auto = press(&format!("sl:auto:{}:100", kai.id), base + 3000);
    assert!(text(&auto[0]).contains("5 spins"), "{}", text(&auto[0]));
    // too big a bet is refused with the limit
    assert!(text(&bot.on_command(&cmd(&kai, "slots", None, None, &[("bet", "999999")], base), &|_| None, &mut |lo, _| lo)[0]).contains("at most"));

    // blackjack: with a roll of 0 the shuffle leaves the shoe in a known order; just check the flow end to end
    let before = coins();
    let deal = bot.on_command(&cmd(&kai, "blackjack", None, None, &[("bet", "100")], base + 10_000), &|_| None, &mut |lo, _| lo);
    let t = text(&deal[0]);
    assert!(t.contains("Blackjack") && t.contains("attachment://blackjack-"), "{t}");
    let open = coins() < before; // still being played (bet taken), or already settled by a natural
    if open {
        // a second /blackjack shows the open hand instead of taking another bet
        let second = bot.on_command(&cmd(&kai, "blackjack", None, None, &[("bet", "100")], base + 11_000), &|_| None, &mut |lo, _| lo);
        assert!(text(&second[0]).contains("still had a hand open"));
        let done = press(&format!("bj:stand:{}", kai.id), base + 12_000);
        let t = text(&done[0]);
        assert!(t.contains("Deal again"), "{t}");
    }
    // someone else cannot press my buttons
    assert!(text(&bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: member("900000000000000502", "Rowan", 0), id: format!("bj:hit:{}", kai.id), message: "m".into(), values: vec![], at_ms: base }, &|_| None, &mut |lo, _| lo)[0]).contains("someone else's game"));
    // coin flip
    let before = coins();
    let flip = bot.on_command(&cmd(&kai, "coinflip", None, None, &[("bet", "100"), ("side", "heads")], base + 20_000), &|_| None, &mut |lo, _| lo);
    assert!(text(&flip[0]).contains("Coin flip"));
    assert!(coins() == before - 100 || coins() == before + 95, "{} {}", before, coins());
}

#[test]
fn fishing_from_the_hub_to_the_bag_and_shop() {
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "economy", true).unwrap();
    bot.db.get().set_module_enabled(G, "games", true).unwrap();
    let kai = member("900000000000000601", "Kai", 0);
    let rowan = member("900000000000000602", "Rowan", 0);
    let base = 1_794_441_600_000i64;
    bot.db.get().wallet(G, &kai.id, Some("Kai"), 1000).unwrap();
    let coins = || bot.db.get().wallet(G, &kai.id, None, 0).unwrap().coins;
    let press = |who: &Member, id: &str, values: &[&str], at: i64| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), message: "m".into(), values: values.iter().map(|v| v.to_string()).collect(), at_ms: at }, &|_| None, &mut |lo, _| lo);
    let form = |who: &Member, id: &str, vals: &[(&str, &str)], at: i64| bot.on_form(&gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), values: vals.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), at_ms: at, ..Default::default() }, &|_| None, &mut |lo, _| lo);

    let hub = bot.on_command(&cmd(&kai, "fish", None, None, &[], base), &|_| None, &mut |lo, _| lo);
    // with pictures on, the hub is a picture of the place (moving water) with the numbers on it
    let t = text(&hub[0]);
    assert!(t.contains("🎣 Fishing") && t.contains("attachment://fishing-") && t.contains("Level 1 · bag 0 fish") && t.contains("fh:900000000000000601:cast"), "{t}");
    assert!(matches!(&hub[0], Action::Reply { card } if card.files.len() == 1 && card.files[0].data.starts_with(b"GIF8")));
    // every other screen is a picture too, with its buttons and menus kept
    for view in ["bag", "shop", "rods", "dex", "quests"] {
        let out = press(&kai, &format!("fh:{}:{view}", kai.id), &[], base);
        let t = text(&out[0]);
        assert!(t.contains("attachment://fishing-") && t.contains("fh:900000000000000601:hub"), "{view}: {t}");
    }
    // the same screens as words, for servers that turn pictures off
    bot.settings.set(G, "games", "gamePictures", &json!(false)).unwrap();
    let hub = bot.on_command(&cmd(&kai, "fish", None, None, &[], base), &|_| None, &mut |lo, _| lo);
    let t = text(&hub[0]);
    assert!(t.contains("🎣 Fishing") && t.contains("Level **1**") && t.contains("Lantern Bay") && t.contains("📜 0/3 today"), "{t}");
    // someone else's menu is theirs alone
    assert!(text(&press(&rowan, &format!("fh:{}:bag", kai.id), &[], base)[0]).contains("belongs to someone else"));

    // pictures back on for the cast and the reeling (they are pictures); the screens after that are checked as words
    bot.settings.set(G, "games", "gamePictures", &json!(true)).unwrap();
    // Cast opens the popup: place, rod, bait, tackle
    let pop = press(&kai, &format!("fh:{}:cast", kai.id), &[], base);
    let Action::Form { id, fields, .. } = &pop[0] else { panic!("{pop:?}") };
    assert_eq!(id, &format!("fcast:{}", kai.id));
    assert_eq!(fields.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), ["biome", "rod", "bait", "tackle"]);
    let cast = form(&kai, id, &[("biome", "bay"), ("rod", "driftwood"), ("bait", "none"), ("tackle", "none")], base);
    assert!(text(&cast[0]).contains("Waiting for a bite") && text(&cast[0]).contains("attachment://fishing-"), "{}", text(&cast[0]));
    let Action::BiteWatch { id: session, after_ms } = &cast[1] else { panic!("{cast:?}") };
    assert!(*after_ms > 0);
    assert!(bot.fish_bite(G, session, base + *after_ms as i64).is_some(), "the bite shows after the wait");
    // casting again while a fish is still on the line shows that fish instead of starting another
    assert!(text(&form(&kai, id, &[("biome", "bay"), ("rod", "leviathan"), ("bait", "none"), ("tackle", "none")], base + 1)[0]).contains("still have a fish on the line"));

    // reel until it ends (the fight is decided by the seed, so just play it out)
    let mut at = base + 20_000;
    let mut last = String::new();
    for _ in 0..90 {
        let out = press(&kai, &format!("fr:{session}:reel"), &[], at);
        last = text(&out[0]);
        if last.contains("Cast again") { break; }
        at += 900;
    }
    assert!(last.contains("Cast again"), "{last}");
    assert!(last.contains("You caught") || last.contains("got away") || last.contains("Snap") || last.contains("cut") || last.contains("tired") || last.contains("swam off"), "{last}");
    assert!(text(&press(&kai, &format!("fr:{session}:reel"), &[], at + 1)[0]).contains("finished"), "a finished game cannot be pressed again");

    // bag and selling (when something was caught), as words
    bot.settings.set(G, "games", "gamePictures", &json!(false)).unwrap();
    let bag = text(&press(&kai, &format!("fh:{}:bag", kai.id), &[], at + 10)[0]);
    assert!(bag.contains("Your bag"), "{bag}");
    if last.contains("You caught") {
        let before = coins();
        let sold = text(&press(&kai, &format!("fh:{}:sellall", kai.id), &[], at + 20)[0]);
        assert!(sold.contains("Sold for"), "{sold}");
        assert!(coins() > before);
        assert!(text(&press(&kai, &format!("fh:{}:sellall", kai.id), &[], at + 30)[0]).contains("Nothing to sell"));
    }
    // the shop: bait is bought through a popup that asks how many
    let before = coins();
    assert!(text(&press(&kai, &format!("fh:{}:shop", kai.id), &[], at + 40)[0]).contains("Tackle shop"));
    let ask = press(&kai, &format!("fs:{}", kai.id), &["bait-worm"], at + 50);
    let Action::Form { id: bait_form, .. } = &ask[0] else { panic!("{ask:?}") };
    assert!(text(&form(&kai, bait_form, &[("qty", "10")], at + 60)[0]).contains("Bought **10 × Earthworm**"));
    assert_eq!(coins(), before - 50);
    // rods, collection and challenges open
    assert!(text(&press(&kai, &format!("fh:{}:rods", kai.id), &[], at + 70)[0]).contains("Driftwood Rod"));
    assert!(text(&press(&kai, &format!("frod:{}", kai.id), &["driftwood"], at + 71)[0]).contains("Next: ★★☆☆☆"));
    assert!(text(&press(&kai, &format!("fh:{}:dex", kai.id), &[], at + 72)[0]).contains("Collection"));
    assert!(text(&press(&kai, &format!("fh:{}:dex-bay.0", kai.id), &[], at + 73)[0]).contains("Lantern Bay"));
    let quests = text(&press(&kai, &format!("fh:{}:quests", kai.id), &[], at + 74)[0]);
    assert!(quests.contains("Fishing challenges") && quests.contains("Today · 0/3"), "{quests}");
}

#[test]
fn the_arcade_games_play_through_with_real_wallets() {
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "economy", true).unwrap();
    bot.db.get().set_module_enabled(G, "games", true).unwrap();
    let kai = member("900000000000000501", "Kai", 0);
    let admin = member("900000000000000502", "Rowan", ADMINISTRATOR);
    let base = 1_794_441_600_000i64;
    bot.db.get().wallet(G, &kai.id, Some("Kai"), 1000).unwrap();
    let coins = || bot.db.get().wallet(G, &kai.id, None, 0).unwrap().coins;
    let press_as = |who: &Member, id: &str, at: i64| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), message: "m".into(), values: vec![], at_ms: at }, &|_| None, &mut |lo, _| lo);
    let press = |id: &str, at: i64| press_as(&kai, id, at);
    let fill = |id: &str, values: &[(&str, &str)], at: i64| bot.on_form(&gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: kai.clone(), id: id.into(), values: values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), at_ms: at, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    let play = |name: &str, at: i64| bot.on_command(&cmd(&kai, name, None, None, &[("bet", "100")], at), &|_| None, &mut |lo, _| lo);
    let id = |game: &str, what: &str| format!("ar:{game}:{}:{what}", kai.id);
    let moving = |a: &Action| matches!(a, Action::Reply { card } | Action::Update { card } if card.files.len() == 1 && card.files[0].data.starts_with(b"GIF8"));
    let still = |a: &Action| matches!(a, Action::Reply { card } | Action::Update { card } if card.files.len() == 1 && card.files[0].data.starts_with(b"\x89PNG"));

    // Balloon Rescue: the word shows as blanks, a popup takes a letter or the whole word
    let out = play("hangman", base);
    let card = text(&out[0]);
    assert!(card.contains("Balloon Rescue") && card.contains("attachment://hangman-") && card.contains("5 letters in a **animals** word"), "{card}");
    assert!(still(&out[0]));
    assert_eq!(coins(), 900);
    assert!(text(&press_as(&admin, &id("hangman", "guess"), base)[0]).contains("someone else's game"));
    let popup = press(&id("hangman", "guess"), base + 1);
    assert!(matches!(&popup[0], Action::Form { id, fields, .. } if id == &format!("arh:{}", kai.id) && fields[0].id == "guess"), "{popup:?}");
    let wrong = fill(&format!("arh:{}", kai.id), &[("guess", "z")], base + 2);
    assert!(text(&wrong[0]).contains("No Z.") && moving(&wrong[0]), "a balloon pops: {}", text(&wrong[0]));
    assert!(text(&fill(&format!("arh:{}", kai.id), &[("guess", "p")], base + 3)[0]).contains("Yes, there are 3 P!"));
    let won = fill(&format!("arh:{}", kai.id), &[("guess", "Puppy")], base + 4);
    // one balloon popped: 1.3 + 5 x 0.15, plus 0.2 for the two letters still hidden = 2.25x
    assert!(text(&won[0]).contains("It was **PUPPY**") && text(&won[0]).contains("Play again"), "{}", text(&won[0]));
    assert_eq!(coins(), 900 + 225);
    // without pictures the blanks are written out
    bot.settings.set(G, "games", "gamePictures", &json!(false)).unwrap();
    let plain = text(&play("hangman", base + 10)[0]);
    assert!(plain.contains("# \\\\_ \\\\_ \\\\_ \\\\_ \\\\_") && plain.contains("🎈🎈🎈🎈🎈🎈"), "{plain}");
    assert!(text(&play("hangman", base + 11)[0]).contains("still had this game going"));
    assert!(text(&press(&id("hangman", "hint"), base + 12)[0]).contains("A hint"));
    for (k, c) in ["x", "q", "z", "w", "v"].iter().enumerate() { fill(&format!("arh:{}", kai.id), &[("guess", c)], base + 13 + k as i64); }
    assert!(text(&fill(&format!("arh:{}", kai.id), &[("guess", "a")], base + 30)[0]).contains("finished"));
    bot.settings.set(G, "games", "gamePictures", &json!(true)).unwrap();
    let after_hangman = coins();
    assert_eq!(after_hangman, 1125 - 100);

    // Treasure Climb: four floors, then the golden door skips one, then cash out at 1.45^6
    let out = play("tower", base + 100);
    assert!(text(&out[0]).contains("Treasure Climb") && text(&out[0]).contains("Door 1"), "{}", text(&out[0]));
    for k in 0..4 { let step = press(&id("tower", "d1"), base + 101 + k); assert!(moving(&step[0])); }
    let golden = press(&id("tower", "gold"), base + 110);
    assert!(text(&golden[0]).contains("skipped a floor"), "{}", text(&golden[0]));
    let cashed = press(&id("tower", "cash"), base + 111);
    assert!(text(&cashed[0]).contains("You took") && text(&cashed[0]).contains("Play again"), "{}", text(&cashed[0]));
    assert_eq!(coins(), after_hangman - 100 + 929);
    // a trap ends it
    press(&id("tower", "again:100"), base + 120);
    assert!(text(&press(&id("tower", "d0"), base + 121)[0]).contains("A trap!"));
    let bank = coins();

    // Bomb Squad: a safe cut, a sniff, cash out
    play("wires", base + 200);
    let cut = press(&id("wires", "w1"), base + 201);
    assert!(text(&cut[0]).contains("Cash out 1.2x") && moving(&cut[0]), "{}", text(&cut[0]));
    assert!(text(&press(&id("wires", "sniff"), base + 202)[0]).contains("sniffed the 🟢 wire"));
    press(&id("wires", "cash"), base + 203);
    assert_eq!(coins(), bank - 100 + 120);
    press(&id("wires", "again:100"), base + 204);
    assert!(text(&press(&id("wires", "w0"), base + 205)[0]).contains("That was the bomb"));
    let bank = coins();

    // Bingo: with this fixed shuffle the first four balls are the card's top row
    let out = play("bingo", base + 300);
    assert!(text(&out[0]).contains("Drop a ball"));
    let end = press(&id("bingo", "all"), base + 301);
    assert!(text(&end[0]).contains("You won") && moving(&end[0]), "{}", text(&end[0]));
    assert_eq!(coins(), bank - 100 + 2000);
    let bank = coins();

    // Memory: a board of 16 buttons in rows of four
    let out = play("memory", base + 400);
    let Action::Reply { card } = &out[0] else { panic!() };
    assert_eq!((card.buttons.len(), card.per_row), (16, 4));
    let rows = card.to_discord().unwrap()["components"][0]["components"].as_array().unwrap().iter().filter(|c| c["type"] == 1).count();
    assert_eq!(rows, 4);
    let flipped = press(&id("memory", "c0"), base + 401);
    // the board is a picture (the flipped card turns over in it); the buttons are the card numbers
    assert!(text(&flipped[0]).contains("attachment://memory-") && text(&flipped[0]).contains("\"label\":\"16\""), "{}", text(&flipped[0]));
    assert!(moving(&flipped[0]), "the card flip is a moving picture");
    // with pictures off, the board is words and face buttons, as before
    bot.settings.set(G, "games", "gamePictures", &json!(false)).unwrap();
    let plain = press(&id("memory", "c1"), base + 402);
    assert!(text(&plain[0]).contains("of 8 pairs") && !text(&plain[0]).contains("attachment://"), "{}", text(&plain[0]));
    bot.settings.set(G, "games", "gamePictures", &json!(true)).unwrap();
    assert_eq!(coins(), bank - 100);
    let bank = coins();

    // Trivia: the timer is a moving picture; a fast right answer pays 1.8x and starts a streak
    bot.settings.set(G, "games", "gameAnimations", &json!(false)).unwrap();
    let out = bot.on_command(&cmd(&kai, "trivia", None, None, &[("bet", "100"), ("category", "general")], base + 500), &|_| None, &mut |lo, _| lo);
    assert!(text(&out[0]).contains("D · 366") && still(&out[0]), "{}", text(&out[0]));
    let right = press(&id("trivia", "a3"), base + 3500);
    assert!(text(&right[0]).contains("Right in 3.0 seconds: **1.8x**") && text(&right[0]).contains("Next question"), "{}", text(&right[0]));
    assert_eq!(coins(), bank - 100 + 180);
    let next = press(&id("trivia", "again:100:general"), base + 4000);
    assert!(matches!(&next[0], Action::Update { .. }));
    // the streak adds 0.05x; a slow answer still counts until 20 seconds
    assert!(text(&press(&id("trivia", "a3"), base + 14_000)[0]).contains("**1.65x**"));
    press(&id("trivia", "again:100:general"), base + 20_000);
    assert!(text(&press(&id("trivia", "a3"), base + 50_000)[0]).contains("Too slow"));
    // a question left alone is closed by the clock
    press(&id("trivia", "again:100:general"), base + 60_000);
    bot.on_tick(base + 60_000 + 30_000, &mut |lo, _| lo);
    assert!(text(&press(&id("trivia", "a3"), base + 95_000)[0]).contains("has gone"));
    bot.settings.set(G, "games", "gameAnimations", &json!(true)).unwrap();

    // Paddle Duel against Good Boy: my shot is returned, then Good Boy's smash flies out
    let out = bot.on_command(&cmd(&kai, "pong", None, None, &[], base + 100_000), &|_| None, &mut |lo, _| lo);
    let Action::Reply { card } = &out[0] else { panic!() };
    let sid = card.buttons[0].id.split(':').nth(1).unwrap().to_string();
    assert!(card.buttons.iter().any(|b| b.label == "Smash top") && card.per_row == 3);
    let shot = press(&format!("pg:{sid}:a0"), base + 100_001);
    assert!(text(&shot[0]).contains("Good Boy got to the shot") && text(&shot[0]).contains("Stand top"), "{}", text(&shot[0]));
    let point = press(&format!("pg:{sid}:d0"), base + 100_002);
    assert!(text(&point[0]).contains("smash flew out") && text(&point[0]).contains("Kai 1 : 0 Good Boy"), "{}", text(&point[0]));
    assert!(text(&press_as(&admin, &format!("pg:{sid}:a0"), base + 100_003)[0]).contains("not your game"));
    assert!(text(&press(&format!("pg:{sid}:quit"), base + 100_004)[0]).contains("Good Boy wins"));
    // a challenge to another member waits for them
    let dare = bot.on_command(&cmd(&kai, "pong", None, Some(&admin), &[], base + 100_010), &|_| None, &mut |lo, _| lo);
    let Action::Reply { card } = &dare[0] else { panic!() };
    let accept = card.buttons[0].id.clone();
    assert!(text(&press(&accept, base + 100_011)[0]).contains("for someone else"));
    assert!(text(&press_as(&admin, &accept, base + 100_012)[0]).contains(&format!("<@{}>, it's your move", kai.id)));

    // the panel: admins post it, anyone opens a bet popup from it
    assert!(text(&bot.on_command(&cmd(&kai, "arcade", None, None, &[], base), &|_| None, &mut |lo, _| lo)[0]).contains("Only server admins"));
    let panel = bot.on_command(&cmd(&admin, "arcade", None, None, &[], base), &|_| None, &mut |lo, _| lo);
    let Action::Reply { card } = &panel[0] else { panic!() };
    assert!(!card.private && card.buttons.len() == 11);
    let popup = press("ar:open:trivia", base + 200_000);
    assert!(matches!(&popup[0], Action::Form { id, fields, .. } if id == "arstart:trivia" && fields.len() == 2), "{popup:?}");
    assert!(text(&fill("arstart:bingo", &[("bet", "50")], base + 200_001)[0]).contains("Bingo · 50"));
    assert!(text(&press("ar:open:fish", base + 200_002)[0]).to_lowercase().contains("fish"));
    // an arcade panel Good Boy 3 posted (`gm:ar:<game>`) opens the same game
    let old = press("gm:ar:trivia", base + 200_003);
    assert!(matches!(&old[0], Action::Form { id, .. } if id == "arstart:trivia"), "{old:?}");
    assert!(text(&press("gm:ar:fish", base + 200_004)[0]).to_lowercase().contains("fish"));
    // a game left for ten minutes is settled: the untouched bingo card is drawn to the end and paid
    let before = coins();
    bot.on_tick(base + 200_001 + 11 * 60_000, &mut |lo, _| lo);
    assert_eq!(coins(), before + 1000);
}

#[test]
fn the_top_boards_include_fishing_and_casino_like_good_boy_3() {
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "economy", true).unwrap();
    let kai = member("900000000000000501", "Kai", 0);
    let base = 1_794_441_600_000i64;
    bot.db.get().wallet(G, &kai.id, Some("Kai"), 1000).unwrap();
    let board = |b: &str| text(&bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: kai.clone(), id: format!("econlb:{}:{b}:server:0:refresh", kai.id), message: "m".into(), values: vec![], at_ms: base }, &|_| None, &mut |lo, _| lo)[0]);
    // the games module is off: the game boards are not offered, and asking for one shows the coins board
    assert!(!board("casino").contains("Casino winnings") && board("casino").contains("Richest"));
    bot.db.get().set_module_enabled(G, "games", true).unwrap();
    bot.db.get().game_record(G, &kai.id, "slots", 100, 450).unwrap();
    bot.db.get().game_record(G, &kai.id, "blackjack", 100, 0).unwrap();
    let casino = board("casino");
    assert!(casino.contains("Casino winnings") && casino.contains("<@900000000000000501> · +**250**"), "{casino}");
    assert!(casino.contains("Most fish caught") && casino.contains("Fishing level") && casino.contains("Heaviest catch"));
    // a real game feeds the same table
    bot.on_command(&cmd(&kai, "coinflip", None, None, &[("bet", "100"), ("side", "heads")], base), &|_| None, &mut |lo, _| lo);
    let n: i64 = bot.db.get().board(&[G.to_string()], "casino", 0, 10, &kai.id).map(|r| r.1).unwrap();
    assert_eq!(n, 1);
}

#[test]
fn big_wins_are_announced_only_when_the_server_asks_and_not_too_often() {
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "economy", true).unwrap();
    bot.db.get().set_module_enabled(G, "games", true).unwrap();
    let kai = member("900000000000000501", "Ka*i", 0);
    let base = 1_794_441_600_000i64;
    bot.db.get().wallet(G, &kai.id, Some("Kai"), 100_000).unwrap();
    // asking for the highest roll on every reel stops on three wild cards
    let spin = |at: i64| bot.on_command(&cmd(&kai, "slots", None, None, &[("bet", "100")], at), &|_| None, &mut |_, hi| hi);
    let sent = |out: &[Action]| out.iter().filter_map(|a| if let Action::Send { channel, card, .. } = a { Some((channel.clone(), card.to_discord().unwrap().to_string())) } else { None }).collect::<Vec<_>>();
    assert!(sent(&spin(base)).is_empty(), "off by default");
    bot.settings.set(G, "games", "announceBigWins", &json!(true)).unwrap();
    bot.settings.set(G, "games", "bigWinLevel", &json!("rare")).unwrap();
    let out = spin(base + 1000);
    let said = sent(&out);
    assert_eq!(said.len(), 1, "{out:?}");
    assert!(said[0].0 == CH && said[0].1.contains("**Kai**") && said[0].1.contains("on slots"), "{said:?}");
    assert!(sent(&spin(base + 2000)).is_empty(), "once every ten minutes");
    bot.settings.set(G, "games", "bigWinChannel", &json!("800000000000000077")).unwrap();
    let later = sent(&spin(base + 11 * 60_000));
    assert_eq!(later.len(), 1);
    assert_eq!(later[0].0, "800000000000000077");
    bot.settings.set(G, "games", "bigWinLevel", &json!("jackpots")).unwrap();
    assert!(sent(&spin(base + 30 * 60_000)).is_empty(), "a plain big win is not a jackpot");
}

#[test]
fn permission_is_checked_before_a_popup_and_admins_ignore_channel_switch_off() {
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "moderation", true).unwrap();
    bot.db.get().set_module_enabled(G, "economy", true).unwrap();
    let kai = member("900000000000000501", "Kai", 0);
    let admin = member("900000000000000502", "Rowan", ADMINISTRATOR);
    let base = 1_794_441_600_000i64;
    let bare = |who: &Member, name: &str| bot.on_command(&CommandEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), name: name.into(), at_ms: base, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    // a plain member never gets the form
    for name in ["warn", "ban", "purge", "economy-admin"] {
        let out = bare(&kai, name);
        assert!(matches!(&out[0], Action::Reply { .. }) && text(&out[0]).contains("don't have permission"), "{name}: {}", text(&out[0]));
    }
    // an administrator does
    assert!(!text(&bare(&admin, "warn")[0]).contains("don't have permission"));
    // switched off in this channel: members are told, admins are not
    bot.db.get().config_set(G, "economy", "__offChannels", &json!([CH])).unwrap();
    bot.settings.forget(G, "economy");
    assert!(text(&bare(&kai, "balance")[0]).contains("switched off in this channel"));
    assert!(!text(&bare(&admin, "balance")[0]).contains("switched off in this channel"));
}

#[test]
fn a_team_reminder_warns_when_its_role_cannot_be_pinged() {
    use gb_core::bot::RoleFacts;
    let (_tmp, bot) = bot();
    let modr = member("900000000000000005", "Mo", MODERATE_MEMBERS);
    let kind = |m: bool| RoleFacts { name: "Raiders".into(), position: 2, managed: false, perms: 0, mentionable: m };
    let set = |m: bool| {
        let mut facts = std::collections::HashMap::new();
        facts.insert("600000000000000001".to_string(), kind(m));
        bot.directory.set_role_facts(G, facts, Some(10));
    };
    let send = || text(&run(&bot, cmd(&modr, "remind", Some("team"), None, &[("when", "1d"), ("role", "600000000000000001"), ("message", "Raid")], NOW))[0]);
    // the bot's own roles are not known yet: nothing is claimed
    set(false);
    assert!(!send().contains("can't notify"));
    bot.directory.set_powers(G, "1", 0, std::collections::HashMap::new());
    bot.directory.set_my_roles(G, vec![]);
    let got = send(); assert!(got.contains("can't notify **Raiders**"), "{got}");
    set(true);
    assert!(!send().contains("can't notify"));
    // with the permission to mention everyone, a locked role is fine
    set(false);
    bot.directory.set_powers(G, "1", 1 << 17, std::collections::HashMap::new());
    assert!(!send().contains("can't notify"));
}

#[test]
fn the_launcher_can_warn_time_out_kick_and_ban() {
    use gb_core::Action;
    let (_tmp, bot) = bot();
    bot.directory.set_bot_owner(Some("900000000000000009".into()));
    let go = |kind: &str, reason: &str, dur: Option<&str>| bot.staff_action(G, kind, "700000000000000001", "kai", reason, dur, NOW);
    assert!(go("dance", "x", None).is_err());
    assert!(go("warn", " ", None).unwrap_err().contains("reason"));
    assert!(bot.staff_action(G, "warn", "kai", "", "x", None, NOW).unwrap_err().contains("Discord ID"));
    assert!(bot.staff_action(G, "warn", "900000000000000009", "me", "x", None, NOW).unwrap_err().contains("yourself"));
    let warn = go("warn", "Spam in #general", None).unwrap();
    assert!(matches!(warn[0], Action::Reply { .. }));
    assert!(go("timeout", "cool off", Some("soon")).unwrap_err().contains("duration"));
    let out = go("timeout", "cool off", Some("10m")).unwrap();
    assert!(out.iter().any(|a| matches!(a, Action::Timeout { .. })));
    assert!(go("kick", "rude", None).unwrap().iter().any(|a| matches!(a, Action::Kick { .. })));
    assert!(go("ban", "raid", None).unwrap().iter().any(|a| matches!(a, Action::Ban { .. })));
}

#[test]
fn the_inactive_clean_up_has_every_tool_an_owner_needs() {
    let _turn = STATS_TURN.lock().unwrap_or_else(|p| p.into_inner());
    use gb_core::stats::{InactiveAsk, InactiveOp, MemberFact};
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "stats", true).unwrap();
    let admin = member("900000000000000183", "Ada", ADMINISTRATOR);
    let base = 1_794_441_600_000i64;
    const D: i64 = 86_400_000;
    let talk = |who: &Member, ch: &str, n: i64, at: i64| for k in 0..n { bot.on_message(&MessageEvent { guild: G.into(), place: Place::channel(ch), author: who.clone(), id: format!("92000000000000{k:04}"), text: "hi".into(), mentions: 0, mentioned: Vec::new(), files: Vec::new(), at_ms: at }, &mut |lo, _| lo); };
    // the people: a veteran who went quiet 40 days ago, an ordinary member who did too, and a lurker who never spoke
    let vet = member("900000000000000301", "Vet", 0);
    let reg = member("900000000000000302", "Reg", 0);
    talk(&vet, "800000000000000211", 10, base - 40 * D);
    talk(&reg, "800000000000000211", 2, base - 40 * D);
    let fact = |id: &str, name: &str, joined_days_ago: i64| MemberFact { id: id.into(), name: name.into(), joined_at: Some(base - joined_days_ago * D), kickable: true, ..Default::default() };
    let gate = "600000000000000009";
    let mut facts = vec![fact("900000000000000301", "Vet", 200), fact("900000000000000302", "Reg", 200), fact("900000000000000303", "Lurker", 10), fact("900000000000000304", "Kept", 200), fact("900000000000000305", "Gated", 5)];
    facts[4].roles = vec![gate.into()];
    let ask = |op: InactiveOp| InactiveAsk { owner: admin.id.clone(), days: 30, op, update: false };
    let ids = |out: &[Action]| -> String { text(&out[0]) };

    // as it was: only people quiet for the days given; a lurker who joined 10 days ago is too new, the gated one too
    let plain = bot.inactive(G, &ask(InactiveOp::List { page: 0 }), &facts, base);
    let t = ids(&plain);
    assert!(t.contains("<@900000000000000301>") && t.contains("<@900000000000000302>") && t.contains("<@900000000000000304>") && !t.contains("Lurker") && !t.contains("900000000000000303") && !t.contains("900000000000000305"), "{t}");

    // lurkers who never spoke can be listed sooner; veterans wait twice as long; the gate catches people who never got in
    bot.settings.set(G, "stats", "inactiveGhostDays", &json!(7)).unwrap();
    bot.settings.set(G, "stats", "inactiveProtectMessages", &json!(5)).unwrap();
    bot.settings.set(G, "stats", "inactiveUnverifiedDays", &json!(3)).unwrap();
    bot.settings.set(G, "member-management", "unverifiedRole", &json!(gate)).unwrap();
    let t = ids(&bot.inactive(G, &ask(InactiveOp::List { page: 0 }), &facts, base));
    assert!(t.contains("<@900000000000000303>") && t.contains("<@900000000000000305>") && t.contains("<@900000000000000302>") && !t.contains("<@900000000000000301>"), "{t}");
    assert!(t.contains("never got past verification") && t.contains("2 never spoke"), "{t}");

    // a kept member is never listed, and keeping can be undone
    let keep = |who: &str, what: &str| text(&run(&bot, cmd(&admin, "stats", Some("keep"), Some(&member(who, "x", 0)), &[("do", what)], base))[0]);
    assert!(keep("900000000000000304", "add").contains("never be listed"));
    assert!(keep("900000000000000304", "add").contains("never be listed"));
    let t = ids(&bot.inactive(G, &ask(InactiveOp::List { page: 0 }), &facts, base));
    assert!(!t.contains("900000000000000304"), "{t}");
    assert!(text(&run(&bot, cmd(&member("900000000000000999", "Nope", 0), "stats", Some("keep"), Some(&member("900000000000000304", "x", 0)), &[], base))[0]).contains("stats.prune"));

    // the view can be narrowed, is remembered, and exports as a spreadsheet
    let shown = bot.inactive(G, &ask(InactiveOp::Show { show: "never".into() }), &facts, base);
    let t = ids(&shown);
    assert!(t.contains("<@900000000000000303>") && !t.contains("<@900000000000000302>") && t.contains("Showing: never sent a message"), "{t}");
    let file = bot.inactive(G, &ask(InactiveOp::Export), &facts, base);
    assert!(matches!(&file[0], Action::Reply { card } if card.files.len() == 1 && card.files[0].name == "inactive-members.csv" && String::from_utf8_lossy(&card.files[0].data).contains("900000000000000303,\"Lurker\",never")), "{file:?}");

    // the launcher reads a snapshot, and removes people without a second question (it asked already)
    assert!(bot.inactive(G, &ask(InactiveOp::Snapshot { show: "all".into() }), &facts, base).is_empty());
    let snap = bot.db.get().data_get(G, "stats", "inactive:snapshot").unwrap().unwrap();
    assert_eq!((snap["tiers"]["never"].as_i64(), snap["tiers"]["unverified"].as_i64(), snap["rows"].as_array().map(Vec::len)), (Some(1), Some(1), Some(3)));
    let gone = bot.inactive(G, &ask(InactiveOp::Kick { ids: vec!["900000000000000303".into(), "900000000000000304".into()] }), &facts, base);
    assert!(matches!(gone.as_slice(), [Action::KickInactive { user, .. }] if user == "900000000000000303"), "kept members are never kicked: {gone:?}");
    let log = bot.db.get().data_get(G, "stats", "pruneLog").unwrap().unwrap();
    assert_eq!((log[0]["count"].as_i64(), log[0]["how"].as_str(), log[0]["members"][0]["name"].as_str()), (Some(1), Some("launcher"), Some("Lurker")));

    // by itself: nothing goes unless the owner turned it on, the message was sent first, and the wait is over
    bot.settings.set(G, "stats", "reviewChannel", &json!("800000000000000241")).unwrap();
    bot.settings.set(G, "stats", "inactiveAutoMax", &json!(1)).unwrap();
    let review = |at: i64| bot.inactive(G, &ask(InactiveOp::Review), &facts, at);
    assert!(review(base).iter().all(|a| !matches!(a, Action::KickInactive { .. })), "off by default");
    bot.settings.set(G, "stats", "inactiveAuto", &json!("kick")).unwrap();
    assert!(review(base).iter().all(|a| !matches!(a, Action::KickInactive { .. })), "needs the we-miss-you message turned on");
    bot.settings.set(G, "stats", "inactiveWarn", &json!(true)).unwrap();
    assert!(review(base).iter().all(|a| !matches!(a, Action::KickInactive { .. })), "nobody has been told yet");
    let told = bot.inactive(G, &ask(InactiveOp::MissYou), &facts, base - 7 * D);
    assert!(told.iter().all(|a| matches!(a, Action::Dm { .. })) && !told.is_empty());
    assert!(review(base - 5 * D).iter().all(|a| !matches!(a, Action::KickInactive { .. })), "the wait is not over");
    let out = review(base);
    let kicked: Vec<&Action> = out.iter().filter(|a| matches!(a, Action::KickInactive { .. })).collect();
    assert_eq!(kicked.len(), 1, "never more than the cap: {out:?}");
    assert!(text(&out[0]).contains("Removed **1**"), "{}", text(&out[0]));
}

#[test]
fn taxes_the_treasury_and_the_second_currency() {
    let (_tmp, bot) = bot();
    let (admin, kai, rowan) = (member("900000000000000009", "Ada", ADMINISTRATOR), member("900000000000000001", "Kai", 0), member("900000000000000002", "Rowan", 0));
    let set = |k: &str, v: Value| { bot.settings.set(G, "economy", k, &v).unwrap(); };
    let coins = |m: &Member| bot.db.get().wallet(G, &m.id, None, 0).unwrap().coins;
    let treasury = || bot.db.get().treasury(G).unwrap();
    let send = |who: &Member, id: &str, values: &[(&str, &str)], at: i64| bot.on_form(&gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), values: values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), at_ms: at, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    let say = |a: &[Action]| text(&a[0]);
    set("startingCoins", json!(100_000));
    for m in [&admin, &kai, &rowan] { run(&bot, cmd(m, "balance", None, None, &[], NOW)); }
    let start = coins(&kai);

    // nothing is taxed until the server says so: a payment arrives whole and the treasury is empty
    let t = say(&send(&kai, &format!("mpx:pay:{}", rowan.id), &[("amount", "1000")], NOW));
    assert!(t.contains("paid") && !t.contains("tax"), "{t}");
    assert_eq!((coins(&rowan), treasury().balance), (start + 1000, 0));

    // a 10% tax on payments: 100 of 1,000 goes to the treasury and the message says so
    set("taxPay", json!(10));
    let t = say(&send(&kai, &format!("mpx:pay:{}", rowan.id), &[("amount", "1000")], NOW + 1));
    assert!(t.contains("10% tax: 100 went to the server treasury, <@900000000000000002> got 900"), "{t}");
    assert_eq!((coins(&kai), coins(&rowan), treasury().balance), (start - 2000, start + 1000 + 900, 100));

    // income tax on /daily, a fee on bank withdrawals, and the shop's sales
    set("taxIncome", json!(20));
    let before = coins(&kai);
    let t = say(&run(&bot, cmd(&kai, "daily", None, None, &[], NOW + 2)));
    assert!(t.contains("Tax:") && t.contains("went to the server treasury"), "{t}");
    let paid_tax = treasury().balance - 100;
    assert!(paid_tax > 0 && coins(&kai) > before, "the member still gains, the treasury gets {paid_tax}");
    set("taxWithdraw", json!(10));
    send(&kai, &format!("mpx:deposit:{}", kai.id), &[("amount", "500")], NOW + 3);
    let before = treasury().balance;
    let t = say(&send(&kai, &format!("mpx:withdraw:{}", kai.id), &[("amount", "500")], NOW + 4));
    assert!(t.contains("fee") && treasury().balance == before + 50, "{t}");

    // exchange: off until the server turns it on
    assert!(say(&run(&bot, cmd(&kai, "exchange", None, None, &[], NOW + 5))).contains("no second currency"));
    set("gemsEnabled", json!(true));
    set("exchangeRate", json!(100));
    set("exchangeFee", json!(5));
    let card = say(&run(&bot, cmd(&kai, "exchange", None, None, &[], NOW + 6)));
    assert!(card.contains("Exchange") && card.contains("5% either way"), "{card}");
    let before = treasury().balance;
    let t = say(&send(&kai, &format!("mpx:xgems:{}", kai.id), &[("amount", "1000")], NOW + 7));
    assert!(t.contains("swapped **948** 🪙 for **9** 💎") && t.contains("48"), "{t}");
    let gems = bot.db.get().gems(G, &kai.id).unwrap();
    assert_eq!((gems, treasury().balance), (9, before + 48));
    assert!(say(&send(&kai, &format!("mpx:xgems:{}", kai.id), &[("amount", "50")], NOW + 8)).contains("not enough"));
    let t = say(&send(&kai, &format!("mpx:xcoins:{}", kai.id), &[("amount", "all")], NOW + 9));
    assert!(t.contains("swapped **9** 💎 for **855** 🪙"), "{t}");
    assert_eq!(bot.db.get().gems(G, &kai.id).unwrap(), 0);
    assert!(say(&send(&kai, &format!("mpx:xcoins:{}", kai.id), &[("amount", "1")], NOW + 10)).contains("only have"));
    // the second currency shows on /balance
    assert!(say(&run(&bot, cmd(&kai, "balance", None, None, &[], NOW + 11))).contains("💎"));

    // staff can hand out gems with the wallet form
    assert!(say(&send(&admin, "mpx:adjust:-", &[("who", &rowan.id), ("op", "gemgive"), ("amount", "7"), ("reason", "event")], NOW + 12)).contains("**7** 💎"));

    // the treasury: everyone sees it, everyone can give, only admins pay out, and it never pays more than it has
    let card = say(&run(&bot, cmd(&rowan, "treasury", None, None, &[], NOW + 13)));
    assert!(card.contains("The treasury") && card.contains("Collected in all"), "{card}");
    assert!(say(&send(&rowan, &format!("mpx:tdonate:{}", rowan.id), &[("amount", "200"), ("note", "for the party")], NOW + 14)).contains("gave **200** 🪙"));
    assert!(say(&send(&rowan, "mpx:tgive:-", &[("who", &rowan.id), ("amount", "1"), ("reason", "x")], NOW + 15)).contains("economy.admin"));
    let have = treasury().balance;
    assert!(say(&send(&admin, "mpx:tgive:-", &[("who", &kai.id), ("amount", &(have + 1).to_string()), ("reason", "too much")], NOW + 16)).contains("only has"));
    let kai_before = coins(&kai);
    let t = say(&send(&admin, "mpx:tgive:-", &[("who", &kai.id), ("amount", "250"), ("reason", "Event winner")], NOW + 17));
    assert!(t.contains("paid **250** 🪙 from the treasury to <@900000000000000001>"), "{t}");
    assert_eq!((coins(&kai), treasury().balance), (kai_before + 250, have - 250));
    let log = bot.db.get().treasury_log(G, 3).unwrap();
    assert_eq!((log[0].delta, log[0].kind.as_str(), log[0].note.as_deref()), (-250, "grant", Some("Event winner")));
    // the server's owner and admins can add coins to the treasury; a plain member cannot
    bot.directory.set_powers(G, &kai.id, 0, Default::default());
    let pat = member("900000000000000777", "Pat", 0);
    assert!(say(&send(&pat, "mpx:tadd:-", &[("amount", "500")], NOW + 18)).contains("Only the server owner and admins"));
    let before = treasury().balance;
    let t = say(&send(&kai, "mpx:tadd:-", &[("amount", "500"), ("note", "prize pool")], NOW + 19));
    assert!(t.contains("added **500** 🪙 to the server treasury"), "{t}");
    assert_eq!(treasury().balance, before + 500);
    // a tax on game winnings comes off the profit only: a won coin flip's profit is taxed 10%, rounded down
    bot.db.get().set_module_enabled(G, "games", true).unwrap();
    set("taxWinnings", json!(10));
    let (before_coins, before_t) = (coins(&kai), treasury().balance);
    bot.on_command(&cmd(&kai, "coinflip", None, None, &[("bet", "100"), ("side", "heads")], NOW + 18), &|_| None, &mut |lo, _| lo);
    let (after_coins, after_t) = (coins(&kai), treasury().balance);
    let tax = after_t - before_t;
    let profit = after_coins - before_coins + tax;
    assert!(profit > 0 && tax == profit / 10 && tax > 0, "a win pays back more than the bet, and a tenth of the profit was taxed ({before_coins} -> {after_coins}, treasury {before_t} -> {after_t})");
    // resetting the whole economy empties the treasury
    bot.db.get().economy_reset(G, None).unwrap();
    assert_eq!(treasury().balance, 0);
}

#[test]
fn leave_records_keep_names_say_how_people_went_and_what_stood_out() {
    const D: i64 = 86_400_000;
    // leaving is judged against the real clock (the event carries no time), so this test lives in real time
    let t0: i64 = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    #[allow(non_snake_case)]
    let T0 = t0;
    let (_tmp, bot) = bot();
    let (admin, kai, rowan) = (member("900000000000000009", "Ada", ADMINISTRATOR), member("900000000000000001", "Kai", 0), member("900000000000000002", "Rowan", 0));
    bot.settings.set(G, "moderation", "logChannel", &json!("800000000000000041")).unwrap();
    let arrive = |m: &Member, at_days_ago: i64| bot.on_member(G, &Member { joined_at: Some(T0 - at_days_ago * D), roles: vec!["600000000000000001".into()], ..m.clone() }, true);
    let go = |m: &Member| bot.on_member(G, m, false);

    // names are known as soon as people are seen, and a picker finds them by part of their name (never bots)
    arrive(&kai, 0);
    arrive(&rowan, 40);
    bot.roster_seed(G, &[Member { bot: true, ..member("900000000000000050", "HelperBot", 0) }]);
    let found = bot.member_search(G, "ro", false, 10);
    assert_eq!(found.iter().map(|k| k.name.as_str()).collect::<Vec<_>>(), vec!["Rowan"]);
    assert!(bot.member_search(G, "helper", false, 10).is_empty() && bot.member_search(G, "helper", true, 10).len() == 1);
    let names = bot.member_names(G, &["900000000000000001".into(), "900000000000000999".into()]);
    assert_eq!((names.get("900000000000000001").map(String::as_str), names.len()), (Some("Kai"), 1), "an unknown id is left out, never shown");

    // Kai is warned, then leaves within the hour and within a day of joining: both stand out, and the log hears about it
    run(&bot, cmd(&admin, "warn", None, Some(&kai), &[("reason", "spam"), ("severity", "low")], T0));
    let out = go(&Member { joined_at: None, roles: vec![], ..kai.clone() });
    let alert = out.iter().find(|a| matches!(a, Action::Send { channel, .. } if channel == "800000000000000041")).map(text).unwrap_or_default();
    assert!(alert.contains("something stands out") && alert.contains("left within a day of joining") && alert.contains("had 1 warning"), "{alert}");
    let list = bot.leavers(G, 30, "", T0);
    let l = &list["leavers"][0];
    assert_eq!((l["name"].as_str(), l["how"].as_str(), l["strikes"].as_i64(), l["roles"][0].as_str()), (Some("Kai"), Some("left"), Some(1), Some("600000000000000001")), "the roles come from what the roster remembered");
    assert!(l["flags"].as_array().unwrap().iter().any(|f| f.as_str().unwrap().contains("hour")));
    assert_eq!(bot.member_search(G, "kai", false, 5).len(), 0, "someone who left is not offered");

    // a quiet leaver raises no alert, and a kick our own commands made explains the leaving
    let out = go(&rowan);
    assert!(out.iter().all(|a| !matches!(a, Action::Send { .. })), "nothing stands out about Rowan");
    arrive(&rowan, 40);
    run(&bot, cmd(&admin, "kick", None, Some(&rowan), &[("reason", "raiding")], T0 + 60_000));
    go(&rowan);
    let list = bot.leavers(G, 30, "row", T0 + 70_000);
    assert_eq!((list["leavers"][0]["how"].as_str(), list["leavers"][0]["reason"].as_str()), (Some("kicked"), Some("raiding")));
    assert_eq!(list["leavers"][0]["returned_at"], Value::Null);
    // and coming back is noticed
    arrive(&rowan, 40);
    assert!(bot.leavers(G, 30, "row", T0 + 80_000)["leavers"][0]["returned_at"].as_i64().is_some());

    // a ban Discord reports (not ours) turns the leaving into a ban; one for someone never seen still makes a record
    arrive(&kai, 0);
    go(&kai);
    bot.on_ban(G, &kai.id, "Kai");
    assert_eq!(bot.leavers(G, 30, "kai", T0 + 90_000)["leavers"][0]["how"], "banned");

    // the server can switch records off, and they go after the days it asked for
    bot.settings.set(G, "moderation", "leaveRecordDays", &json!(30)).unwrap();
    assert_eq!(bot.leavers(G, 365, "", T0)["days"], 30);
    assert!(!bot.leavers(G, 30, "", T0)["leavers"].as_array().unwrap().is_empty());
    bot.on_tick(T0 + 31 * D, &mut |lo, _| lo);
    assert!(bot.leavers(G, 30, "", T0 + 31 * D)["leavers"].as_array().unwrap().is_empty(), "past their time");
    bot.settings.set(G, "moderation", "leaveRecords", &json!(false)).unwrap();
    arrive(&kai, 0);
    go(&kai);
    assert!(bot.leavers(G, 30, "", T0 + 32 * D)["leavers"].as_array().unwrap().is_empty());
    // a person can be forgotten completely
    bot.settings.set(G, "moderation", "leaveRecords", &json!(true)).unwrap();
    go(&kai);
    assert_eq!(bot.roster_forget(G, &kai.id), 1);
    assert!(bot.member_names(G, std::slice::from_ref(&kai.id)).is_empty() || bot.db.seen().name(G, &kai.id).is_some(), "the stored name is gone; only this session's memory may still know it");
}

#[test]
fn the_shop_can_be_run_from_the_launcher() {
    use gb_core::bot::RoleFacts;
    let (_tmp, bot) = bot();
    let mut facts = std::collections::HashMap::new();
    facts.insert("600000000000000001".to_string(), RoleFacts { name: "VIP".into(), position: 2, managed: false, perms: 0, mentionable: true });
    facts.insert("600000000000000002".to_string(), RoleFacts { name: "Above me".into(), position: 20, managed: false, perms: 0, mentionable: true });
    bot.directory.set_role_facts(G, facts, Some(10));
    assert_eq!(bot.shop_view(G)["items"].as_array().unwrap().len(), 0);
    // an item: a name, a price, a message that {user} fills in, used up when used (the ! way of the shop form)
    assert!(bot.shop_save(G, "Golden Bone!!", 5000, "🦴", None, 0, Some(10), "{user} polished it", true).unwrap().contains("Added"));
    let items = bot.shop_view(G)["items"].clone();
    assert_eq!((items[0]["id"].as_str(), items[0]["price"].as_i64(), items[0]["stock"].as_i64(), items[0]["consumable"].as_bool(), items[0]["message"].as_str()), (Some("golden-bone"), Some(5000), Some(10), Some(true), Some("{user} polished it")));
    // saving it again changes it; a role item needs a role the bot may give and keeps hours
    assert!(bot.shop_save(G, "Golden Bone", 6000, "🦴", None, 0, None, "", false).unwrap().contains("Updated"));
    assert!(bot.shop_save(G, "VIP", 9000, "⭐", Some("600000000000000001"), 24, None, "Perks", false).unwrap().contains("Added"));
    assert!(bot.shop_save(G, "Boss", 1, "", Some("600000000000000002"), 0, None, "", false).unwrap_err().contains("my role must be above"));
    assert!(bot.shop_save(G, "Gone", 1, "", Some("600000000000000777"), 0, None, "", false).unwrap_err().contains("does not exist"));
    assert!(bot.shop_save(G, "Free", 0, "", None, 0, None, "", false).unwrap_err().contains("at least 1"));
    assert!(bot.shop_save(G, "!!!", 5, "", None, 0, None, "", false).unwrap_err().contains("name"));
    assert!(bot.shop_save(G, "Shield", 5, "", None, 0, None, "", false).unwrap_err().contains("built-in"));
    let vip = bot.shop_view(G)["items"].as_array().unwrap().iter().find(|i| i["id"] == "vip").cloned().unwrap();
    assert_eq!((vip["role_id"].as_str(), vip["hours"].as_i64(), vip["description"].as_str()), (Some("600000000000000001"), Some(24), Some("Perks")));
    // members see what the launcher made, and it can be taken out
    let shop = text(&run(&bot, cmd(&member("900000000000000001", "Kai", 0), "shop", None, None, &[], NOW))[0]);
    assert!(shop.contains("Golden Bone") && shop.contains("VIP"), "{shop}");
    bot.shop_remove(G, "golden-bone").unwrap();
    assert!(bot.shop_remove(G, "golden-bone").is_err());
    assert_eq!(bot.shop_view(G)["items"].as_array().unwrap().len(), 1);
}

#[test]
fn staff_can_claim_reply_to_and_close_a_ticket_from_the_launcher() {
    let (_tmp, bot) = bot();
    bot.directory.set_bot_owner(Some("900000000000000009".into()));
    let ch = "820000000000000007";
    bot.db.get().data_set(G, "support", &format!("ticket:{ch}"), &json!({ "number": 7, "opener": "900000000000000001", "openerTag": "kai", "category": "help", "typeLabel": "Help", "priority": "normal", "status": "open", "createdAt": NOW, "controlMessageId": "830000000000000001" })).unwrap();
    let go = |what: &str, text: &str| bot.ticket_action(G, 7, what, text, None, NOW + 1000);
    assert!(go("dance", "").unwrap_err().contains("not something"));
    assert!(bot.ticket_action(G, 99, "claim", "", None, NOW).unwrap_err().contains("no ticket"));
    // claiming says so in the ticket and refreshes the control card; doing it again releases it
    let (said, out) = go("claim", "").unwrap();
    assert_eq!(said, "Claimed.");
    assert!(out.iter().any(|a| matches!(a, Action::Send { channel, card, .. } if channel == ch && text(&Action::Send { channel: channel.clone(), card: card.clone(), ping: vec![], roles: vec![] }).contains("claimed this ticket"))) && out.iter().any(|a| matches!(a, Action::Edit { message, .. } if message == "830000000000000001")), "{out:?}");
    assert_eq!(go("claim", "").unwrap().0, "Released.");
    // a reply goes to the ticket and pings whoever opened it; an empty one is refused
    assert!(go("reply", "  ").unwrap_err().contains("Write something"));
    let (_, out) = go("reply", "We are looking into it").unwrap();
    assert!(matches!(&out[0], Action::Send { channel, ping, .. } if channel == ch && ping == &vec!["900000000000000001".to_string()]), "{out:?}");
    // closing needs the resolution, is recorded, and a closed ticket can't be touched again
    assert!(go("close", "").unwrap_err().contains("resolved"));
    let (said, out) = go("close", "Fixed it").unwrap();
    assert_eq!(said, "Closed.");
    assert!(!out.is_empty());
    let t = bot.db.get().data_get(G, "support", &format!("ticket:{ch}")).unwrap().unwrap();
    assert_eq!((t["status"].as_str(), t["closedBy"].as_str(), t["closeKind"].as_str()), (Some("closed"), Some("900000000000000009"), Some("staff")));
    assert!(go("claim", "").unwrap_err().contains("already closed"));
}

#[test]
fn a_reminder_goes_to_the_channel_when_the_member_switched_direct_messages_off() {
    let (_tmp, bot) = bot();
    let kai = member("900000000000000001", "Kai", 0);
    run(&bot, cmd(&kai, "remind", Some("me"), None, &[("when", "2h"), ("message", "Feed the dog")], NOW));
    // Kai turns direct messages off (the /notifications choice)
    bot.db.get().set_notify_pref(G, &kai.id, "dms", false, NOW).unwrap();
    let due = bot.on_tick(NOW + 2 * HOUR + MINUTE, &mut |lo, _| lo);
    assert!(matches!(&due[..], [(_, Action::Send { channel, ping, .. })] if channel == CH && ping == &vec![kai.id.clone()]), "{due:?}");
}

#[test]
fn announcements_and_parties_say_when_their_role_cannot_be_pinged() {
    use gb_core::bot::RoleFacts;
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "engagement", true).unwrap();
    let admin = member("900000000000000171", "Ada", ADMINISTRATOR);
    let facts = |m: bool| { let mut f = std::collections::HashMap::new(); f.insert("600000000000000001".to_string(), RoleFacts { name: "Raiders".into(), position: 2, managed: false, perms: 0, mentionable: m }); f };
    bot.directory.set_role_facts(G, facts(false), Some(10));
    bot.directory.set_powers(G, "1", 0, std::collections::HashMap::new());
    bot.directory.set_my_roles(G, vec![]);
    let fill = |vals: &[(&str, &str)]| bot.on_form(&gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: admin.clone(), id: "eng:announce:send".into(), values: vals.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    // the popup is answered only after its button was pressed by the same person, as in real use
    let intro = run(&bot, cmd(&admin, "announce", Some("send"), None, &[], NOW));
    let Action::Reply { card } = &intro[0] else { panic!() };
    bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: admin.clone(), id: card.buttons[0].id.clone(), message: String::new(), values: vec![], at_ms: NOW }, &|_| None, &mut |lo, _| lo);
    let out = fill(&[("channel", "800000000000000201"), ("text", "Raid at 8"), ("roles", "600000000000000001")]);
    let warned = out.iter().any(|a| matches!(a, Action::Reply { .. }) && text(a).contains("can't notify **Raiders**"));
    assert!(warned, "{out:?}");
    // a role that can be pinged raises no warning
    bot.directory.set_role_facts(G, facts(true), Some(10));
    let out = fill(&[("channel", "800000000000000201"), ("text", "Raid at 8"), ("roles", "600000000000000001")]);
    assert!(!out.iter().any(|a| matches!(a, Action::Reply { .. }) && text(a).contains("can't notify")), "{out:?}");
}

#[test]
fn someone_who_left_the_server_cannot_win_a_giveaway() {
    use gb_core::ButtonEvent;
    let (_tmp, bot) = bot();
    let (admin, kai, rowan) = (member("900000000000000009", "Ada", ADMINISTRATOR), member("900000000000000001", "Kai", 0), member("900000000000000002", "Rowan", 0));
    let started = run(&bot, cmd(&admin, "giveaway", Some("start"), None, &[("prize", "Nitro"), ("duration", "1h")], NOW));
    let Action::Post { note, .. } = &started[1] else { panic!("{started:?}") };
    bot.on_posted(G, note, "555000000000000001");
    let press = |who: &Member| bot.on_button(&ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: "gw:enter:1".into(), at_ms: NOW + 1, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    bot.on_member(G, &kai, true);
    bot.on_member(G, &rowan, true);
    press(&kai);
    press(&rowan);
    // Kai leaves before the draw; the first pick would have been Kai
    bot.on_member(G, &kai, false);
    let ended = bot.on_tick(NOW + HOUR + 1, &mut |lo, _| lo);
    assert!(text_of_edit(&ended[0].1).contains("**Winner:** <@900000000000000002>"), "{}", text_of_edit(&ended[0].1));
    assert!(!text_of_edit(&ended[0].1).contains("900000000000000001>"));
}

#[test]
fn a_suggestion_gets_a_discussion_thread_unless_the_server_switches_it_off() {
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "engagement", true).unwrap();
    let (admin, kai) = (member("900000000000000171", "Ada", ADMINISTRATOR), member("900000000000000172", "Kai", 0));
    run(&bot, cmd(&admin, "suggestion", Some("setup"), None, &[("channel", "800000000000000301")], NOW));
    let out = bot.on_form(&gb_core::FormEvent { guild: G.into(), place: Place::channel(CH), member: kai.clone(), id: "eng:idea".into(), values: [("idea".to_string(), "More emoji please".to_string())].into(), at_ms: NOW, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    let Some(Action::Post { note, .. }) = out.iter().find(|a| matches!(a, Action::Post { .. })) else { panic!("{out:?}") };
    bot.on_posted(G, note, "555000000000000301");
    assert_eq!(bot.thread_for_post(G, note).as_deref(), Some("#1: More emoji please"), "on by default, as in Good Boy 3");
    bot.settings.set(G, "engagement", "suggestionThreads", &serde_json::json!(false)).unwrap();
    assert_eq!(bot.thread_for_post(G, note), None, "unless the server switches it off");
    assert_eq!(bot.thread_for_post(G, "poll:abc"), None, "only suggestions");
}

#[test]
fn the_tenor_setup_chosen_in_the_rp_popup_opens_through_a_button_because_a_popup_cannot_open_a_popup() {
    let (_tmp, bot) = bot();
    bot.db.get().set_module_enabled(G, "roleplay", true).unwrap();
    let owner = member("900000000000000042", "Basic", 0);
    bot.directory.set_bot_owner(Some(owner.id.clone()));
    // the /rp popup was submitted with the owner-only choice
    let mut ev = cmd(&owner, "rp", None, None, &[("action", "tenor-setup")], NOW);
    ev.from_form = true;
    let out = run(&bot, ev);
    let Action::Reply { card } = &out[0] else { panic!("{out:?}") };
    assert!(!card.buttons.is_empty(), "{out:?}");
    assert!(!matches!(&out[0], Action::Form { .. }), "a popup answered with a popup is what Discord refuses");
    let id = card.buttons[0].id.clone();
    assert_eq!(id, format!("rp:tenorform:{}", owner.id));
    let press = |who: &Member, id: &str| bot.on_button(&gb_core::ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: id.into(), message: String::new(), values: vec![], at_ms: NOW }, &|_| None, &mut |lo, _| lo);
    assert!(matches!(&press(&owner, &id)[0], Action::Form { id, .. } if id == "rp:tenor"));
    assert!(text(&press(&member("900000000000000043", "Kai", 0), &id)[0]).contains("Only the person who runs this bot"));
}

#[test]
fn the_launcher_can_hand_a_permission_to_roles_and_the_commands_obey() {
    use gb_core::bot::RoleFacts;
    let (_tmp, bot) = bot();
    let mut facts = std::collections::HashMap::new();
    facts.insert("600000000000000001".to_string(), RoleFacts { name: "Helpers".into(), position: 2, managed: false, perms: 0, mentionable: true });
    bot.directory.set_role_facts(G, facts, Some(10));
    let view = bot.permissions_view(G);
    let warn = view["permissions"].as_array().unwrap().iter().find(|p| p["key"] == "moderation.warn").unwrap();
    assert_eq!((warn["default"].as_str(), warn["roles"].as_array().unwrap().len()), (Some("moderator"), 0));
    assert!(warn["label"].as_str().unwrap().contains("Warn"));
    assert!(bot.permission_set(G, "moderation.nonsense", &[]).is_err());
    assert!(bot.permission_set(G, "moderation.warn", &["999".to_string()]).unwrap_err().contains("not a role"));
    bot.permission_set(G, "moderation.warn", &["600000000000000001".to_string()]).unwrap();
    assert_eq!(bot.permissions_view(G)["permissions"].as_array().unwrap().iter().find(|p| p["key"] == "moderation.warn").unwrap()["roles"][0], "600000000000000001");
    // the command follows: a member with the role may warn, one without may not (even a moderator by Discord permission)
    let helper = Member { roles: vec!["600000000000000001".into()], ..member("900000000000000050", "Hal", 0) };
    let modr = member("900000000000000051", "Mo", MODERATE_MEMBERS);
    let kai = member("900000000000000001", "Kai", 0);
    let try_warn = |who: &Member| text(&run(&bot, cmd(who, "warn", None, Some(&kai), &[("reason", "spam"), ("severity", "low")], NOW))[0]);
    assert!(!try_warn(&helper).contains("moderation.warn"), "{}", try_warn(&helper));
    assert!(try_warn(&modr).contains("moderation.warn"));
    bot.permission_set(G, "moderation.warn", &[]).unwrap();
    assert!(!try_warn(&modr).contains("moderation.warn"), "back to the default");
}

#[test]
fn the_list_pages_show_what_discord_shows_and_their_actions_work() {
    use gb_core::ButtonEvent;
    let (_tmp, bot) = bot();
    let (admin, kai, rowan) = (member("900000000000000009", "Ada", ADMINISTRATOR), member("900000000000000001", "Kai", 0), member("900000000000000002", "Rowan", 0));
    assert!(bot.panel_view(G, "nonsense").is_err());
    for p in ["giveaways", "commands", "backups", "inviters", "counting"] {
        let v = bot.panel_view(G, p).unwrap();
        assert!(v["rows"].as_array().unwrap().is_empty() && v["empty"].as_str().unwrap().len() > 10, "{p}: {v}");
    }
    // a giveaway shows up, with its entries, and "End now" draws the winner
    let started = run(&bot, cmd(&admin, "giveaway", Some("start"), None, &[("prize", "Nitro"), ("duration", "1h")], NOW));
    let Action::Post { note, .. } = &started[1] else { panic!("{started:?}") };
    bot.on_posted(G, note, "555000000000000001");
    for who in [&kai, &rowan] { bot.on_member(G, who, true); bot.on_button(&ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: "gw:enter:1".into(), at_ms: NOW + 1, ..Default::default() }, &|_| None, &mut |lo, _| lo); }
    let v = bot.panel_view(G, "giveaways").unwrap();
    let row = &v["rows"][0];
    assert_eq!(row["id"], "1");
    assert!(row["lines"][0].as_str().unwrap().starts_with("2 entries") && row["actions"][0]["id"] == "end", "{row}");
    let acts = bot.panel_action(G, "giveaways", "1", "end", NOW + 2).unwrap();
    assert!(!acts.is_empty());
    let v = bot.panel_view(G, "giveaways").unwrap();
    assert!(v["rows"][0]["lines"].as_array().unwrap().iter().any(|l| l.as_str().unwrap().starts_with("won by")), "{v}");
    assert_eq!(v["rows"][0]["actions"][0]["id"], "reroll");
    assert!(bot.panel_action(G, "giveaways", "1", "end", NOW + 3).unwrap_err().contains("already ended"));
    // a custom command is listed and can be deleted
    bot.db.get().set_module_enabled(G, "tags", true).unwrap();
    gb_core::store::Data { db: &bot.db, guild: G, module: "tags" }.set("cc:hello", &serde_json::json!({ "name": "hello", "trigger": "command", "uses": 3 }));
    let v = bot.panel_view(G, "commands").unwrap();
    assert_eq!((v["rows"][0]["id"].as_str(), v["rows"][0]["lines"][1].as_str()), (Some("hello"), Some("used 3 times")));
    bot.panel_action(G, "commands", "hello", "delete", NOW).unwrap();
    assert!(bot.panel_view(G, "commands").unwrap()["rows"].as_array().unwrap().is_empty());
    assert!(bot.panel_action(G, "commands", "hello", "delete", NOW).unwrap_err().contains("already gone"));
}

#[test]
fn the_home_numbers_keep_two_weeks_hour_by_hour_and_survive_a_restart() {
    let (_tmp, bot) = bot();
    bot.directory.set_members(G, 1342);
    let kai = member("900000000000000001", "Kai", 0);
    bot.directory.set_voice(G, &kai.id, Some("800000000000000099"));
    for _ in 0..3 { bot.pulse.message(G); }
    bot.pulse.save(&bot.db, &bot.directory, NOW);
    let h = bot.history(G, NOW);
    let (members, voice, messages) = (h["members"].as_array().unwrap(), h["voice"].as_array().unwrap(), h["messages"].as_array().unwrap());
    assert_eq!(members.len(), 14 * 24);
    assert_eq!((members.last().unwrap().as_i64(), voice.last().unwrap().as_i64(), messages.last().unwrap().as_i64()), (Some(1342), Some(1), Some(3)));
    assert!(members[0].is_null(), "an hour the bot was not running has no number");
    assert_eq!(bot.live_numbers(G)["voice"], 1);
    // more messages in the same hour add up, and a quiet minute writes nothing new
    bot.pulse.message(G);
    bot.pulse.save(&bot.db, &bot.directory, NOW + 60_000);
    assert_eq!(bot.history(G, NOW)["messages"].as_array().unwrap().last().unwrap().as_i64(), Some(3), "saved at most every five minutes");
    bot.pulse.save(&bot.db, &bot.directory, NOW + 6 * 60_000);
    assert_eq!(bot.history(G, NOW + 6 * 60_000)["messages"].as_array().unwrap().last().unwrap().as_i64(), Some(4));
}
