//! Levels in v4, running on data written by Good Boy 3: the same XP rules, cards for what is shown, and records
//! that Good Boy 3 can still read afterwards.

use gb_core::{levels, Action, Bot, CommandEvent, Member, MessageEvent, Place, SettingsError};
use gb_data::{import_3x, level_of, Store};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}
fn node(script: &str, args: &[&str]) -> Value {
    let out = Command::new("node").arg("--disable-warning=ExperimentalWarning").arg(fixtures().join(script)).args(args).output().expect("node is needed");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(out.stdout.split(|b| *b == b'\n').rfind(|l| l.starts_with(b"{")).unwrap()).unwrap()
}
/// A Good Boy 3 data folder, imported into a v4 folder, with the bot running on it.
fn world() -> (tempfile::TempDir, PathBuf, Bot, Value) {
    let tmp = tempfile::tempdir().unwrap();
    let wrote = node("make-3x-data.mjs", &[tmp.path().join("gb3").to_str().unwrap()]);
    let new = tmp.path().join("gb4");
    import_3x(&tmp.path().join("gb3"), &new).unwrap();
    let bot = Bot::new(Store::open(new.join("eclipse.db")).unwrap());
    (tmp, new, bot, wrote)
}
const GENERAL: &str = "800000000000000001";
fn member(id: &str, name: &str) -> Member {
    Member { id: id.into(), name: name.into(), avatar: Some(format!("https://cdn.discordapp.com/avatars/{id}/a.png")), perms: 0, roles: vec![], bot: false, joined_at: None }
}
fn says(guild: &str, who: &Member, channel: &str, at_ms: i64) -> MessageEvent {
    MessageEvent { guild: guild.into(), place: Place::channel(channel), author: who.clone(), id: String::new(), text: String::new(), mentions: 0, mentioned: Vec::new(), files: Vec::new(), at_ms }
}
fn text_of(action: &Action) -> String {
    let card = match action {
        Action::Send { card, .. } | Action::Reply { card } | Action::Update { card } => card,
        other => panic!("not a card: {other:?}"),
    };
    let d = card.to_discord().expect("every card the bot makes is within Discord's limits");
    let first = &d["components"][0]["components"][0];
    first["content"].as_str().or_else(|| first["components"][0]["content"].as_str()).unwrap().to_string()
}

#[test]
fn chatting_gives_xp_with_the_same_rules_and_good_boy_3_can_read_it_back() {
    let (_tmp, dir, bot, wrote) = world();
    let (g, kai) = (wrote["guild"].as_str().unwrap(), wrote["kai"].as_str().unwrap());
    let kai_m = member(kai, "Kai");
    let mut always_20 = |lo: i64, hi: i64| { assert_eq!((lo, hi), (15, 25), "the default XP range"); 20 };
    let t0 = 1_800_000_000_000i64;

    // a message gives XP...
    assert!(bot.on_message(&says(g, &kai_m, GENERAL, t0), &mut always_20).is_empty(), "no level-up yet, so nothing is posted");
    assert_eq!(bot.db.get().xp(g, kai).unwrap(), 12345 + 20);
    // ...but not again inside the cooldown (60 seconds); the message is still counted
    bot.on_message(&says(g, &kai_m, GENERAL, t0 + 30_000), &mut always_20);
    let rec = bot.db.get().data_get(g, "community", &format!("user:{kai}")).unwrap().unwrap();
    assert_eq!((rec["xp"].as_i64(), rec["messages"].as_i64(), rec["lastXp"].as_i64()), (Some(12365), Some(802), Some(t0)));
    assert_eq!(rec["rep"], 4, "what v4 does not use is kept as it was");
    bot.on_message(&says(g, &kai_m, GENERAL, t0 + 61_000), &mut always_20);
    assert_eq!(bot.db.get().xp(g, kai).unwrap(), 12385);
    // bots never earn
    let robot = Member { bot: true, ..member("900000000000000777", "Robot") };
    bot.on_message(&says(g, &robot, GENERAL, t0), &mut always_20);
    assert_eq!(bot.db.get().xp(g, &robot.id).unwrap(), 0);

    // Good Boy 3's own code reads the record v4 wrote, and works out the same level
    drop(bot);
    let back = node("read-3x.mjs", &[dir.to_str().unwrap(), g, kai]);
    assert_eq!(back["rec"]["xp"], 12385);
    assert_eq!(back["rec"]["messages"], 803);
    let mine = level_of(12385);
    assert_eq!(back["level"], json!({ "level": mine.level, "into": mine.into, "needed": mine.needed }));
}

#[test]
fn a_level_up_posts_a_card_and_gives_reward_roles() {
    let (_tmp, _dir, bot, wrote) = world();
    let (g, rowan) = (wrote["guild"].as_str().unwrap(), wrote["rowan"].as_str().unwrap());
    let (bronze, silver) = ("900000000000000801", "900000000000000802");
    // rewards, stored the way Good Boy 3 stores them: level 1 and level 2
    bot.db.get().data_set(g, "community", "reward:0001", &json!(bronze)).unwrap();
    bot.db.get().data_set(g, "community", "reward:0002", &json!(silver)).unwrap();
    // Rowan has 150 XP (level 1, 50 into it; level 2 needs 155 more than level 1's start)
    assert_eq!(level_of(150).level, 1);
    let mut rowan_m = member(rowan, "Rowan");
    rowan_m.roles = vec![bronze.to_string()];
    let need = level_of(150).needed - level_of(150).into; // XP still missing for level 2
    let mut exactly = |_: i64, _: i64| 25;
    let mut t = 1_800_000_000_000i64;
    let mut actions = Vec::new();
    for _ in 0..(need / 25 + 1) {
        actions = bot.on_message(&says(g, &rowan_m, GENERAL, t), &mut exactly);
        t += 61_000;
        if !actions.is_empty() { break; }
    }
    assert_eq!(level_of(bot.db.get().xp(g, rowan).unwrap()).level, 2);
    // the card: where they chatted, pinging only them
    match &actions[0] {
        Action::Send { channel, card, ping, .. } => {
            assert_eq!((channel.as_str(), ping), (GENERAL, &vec![rowan.to_string()]));
            assert_eq!(card.title.as_deref(), Some("Rowan reached level 2"));
            assert!(card.picture.is_some() && card.bar.is_some());
        }
        other => panic!("{other:?}"),
    }
    let text = text_of(&actions[0]);
    assert!(text.contains("Rank 2 of 2 in the server") && text.contains("XP to level 3"), "{text}");
    // the reward: silver is added; bronze is kept because rewards stack by default
    assert_eq!(actions[1], Action::Roles { user: rowan.into(), add: vec![silver.into()], remove: vec![], reason: "Level 2 reward".into() });

    // a server's own level-up message and channel are respected
    bot.settings.set(g, levels::MODULE, "levelUpMessage", &json!("GG {username}, level {level}! {user}")).unwrap();
    bot.settings.set(g, levels::MODULE, "levelUpChannel", &json!("<#800000000000000099>")).unwrap();
    bot.settings.set(g, levels::MODULE, "stackRewards", &json!(false)).unwrap();
    bot.db.get().data_set(g, "community", &format!("user:{rowan}"), &json!({ "xp": 0, "messages": 0, "rep": 0, "lastXp": 0, "lastRep": 0 })).unwrap();
    let mut big = |_: i64, _: i64| 25;
    let mut out = Vec::new();
    for n in 0..5 {
        out = bot.on_message(&says(g, &rowan_m, GENERAL, t + n * 61_000), &mut big);
        if !out.is_empty() { break; }
    }
    match &out[0] {
        Action::Send { channel, card, .. } => {
            assert_eq!(channel, "800000000000000099");
            assert_eq!(card.title, None);
            assert_eq!(card.lines[0], format!("GG Rowan, level 1! <@{rowan}>"));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(out.len(), 1, "they already hold the level 1 role, and nothing lower exists to take away");
    // turned off: XP still counts, nothing is posted
    bot.settings.set(g, levels::MODULE, "levelUpEnabled", &json!("off")).unwrap();
    bot.db.get().data_set(g, "community", &format!("user:{rowan}"), &json!({ "xp": 90, "lastXp": 0 })).unwrap();
    assert!(bot.on_message(&says(g, &rowan_m, GENERAL, t + 900_000), &mut big).is_empty());
    assert_eq!(level_of(bot.db.get().xp(g, rowan).unwrap()).level, 1);
}

#[test]
fn a_level_up_can_ping_say_it_quietly_or_show_the_members_own_rank_card() {
    let (_tmp, _dir, bot, wrote) = world();
    let (g, rowan) = (wrote["guild"].as_str().unwrap(), wrote["rowan"].as_str().unwrap());
    let rowan_m = member(rowan, "Rowan");
    let mut t = 1_900_000_000_000i64;
    let mut up = |style: &str| -> Action {
        bot.settings.set(g, levels::MODULE, "levelUpStyle", &json!(style)).unwrap();
        bot.db.get().data_set(g, "community", &format!("user:{rowan}"), &json!({ "xp": 90, "messages": 7, "lastXp": 0 })).unwrap();
        t += 600_000;
        let mut gain = |_: i64, _: i64| 25;
        bot.on_message(&says(g, &rowan_m, GENERAL, t), &mut gain).remove(0)
    };
    // the default is the message that pings them
    assert_eq!(bot.settings.text(g, levels::MODULE, "levelUpStyle").as_deref(), Some("ping"));
    match up("ping") { Action::Send { ping, card, .. } => { assert_eq!(ping, vec![rowan.to_string()]); assert!(card.lines.iter().any(|l| l.contains(&format!("<@{rowan}>")))); } other => panic!("{other:?}") }
    // quiet: the same message, nobody is pinged and their name is not a mention
    match up("quiet") {
        Action::Send { ping, card, .. } => {
            assert!(ping.is_empty(), "no ping");
            assert_eq!(card.title.as_deref(), Some("Rowan reached level 1"));
            assert!(card.lines.iter().any(|l| l.contains("**Rowan**")) && !card.lines.iter().any(|l| l.contains("<@")), "{:?}", card.lines);
            assert!(card.art.is_none());
        }
        other => panic!("{other:?}"),
    }
    // card: their own rank card, no ping and no mention
    match up("card") {
        Action::Send { ping, card, .. } => {
            assert!(ping.is_empty(), "no ping");
            assert_eq!(card.title.as_deref(), Some("Rowan reached level 1"));
            assert!(!card.lines.iter().any(|l| l.contains("<@")), "{:?}", card.lines);
            match card.art { Some(gb_core::Art::Rank(r)) => assert_eq!((r.name.as_str(), r.level, r.messages), ("Rowan", 1, 8)), other => panic!("a rank card is drawn: {other:?}") }
            assert!(card.buttons.iter().any(|b| b.label == "View rank"));
        }
        other => panic!("{other:?}"),
    }
    // it is THEIR card: the theme and colours they picked with /rank's Customise button are used
    bot.db.get().data_set(g, "community", &format!("card:{rowan}"), &json!({ "theme": "sunset", "accent": "#ff3366", "accent2": "#ffaa00" })).unwrap();
    match up("card") {
        Action::Send { card, .. } => match card.art { Some(gb_core::Art::Rank(r)) => assert_eq!((r.theme.as_deref(), r.accent.as_deref(), r.accent2.as_deref()), (Some("sunset"), Some("#ff3366"), Some("#ffaa00"))), other => panic!("{other:?}") },
        other => panic!("{other:?}"),
    }
    // pictures off for the server: the same message in text, still without a ping
    bot.settings.set(g, levels::MODULE, "rankCards", &json!("off")).unwrap();
    match up("card") { Action::Send { ping, card, .. } => { assert!(ping.is_empty() && card.art.is_none()); assert!(card.lines.iter().any(|l| l.contains("XP to level 2"))); } other => panic!("{other:?}") }
    // and only the three styles are accepted
    assert!(bot.settings.set(g, levels::MODULE, "levelUpStyle", &json!("loud")).is_err());
}

#[test]
fn no_xp_where_it_is_switched_off_in_tickets_or_when_levels_are_off_and_boosts_multiply() {
    let (_tmp, _dir, bot, wrote) = world();
    let (g, kai) = (wrote["guild"].as_str().unwrap(), wrote["kai"].as_str().unwrap());
    let mut kai_m = member(kai, "Kai");
    let mut ten = |_: i64, _: i64| 15;
    let xp = || bot.db.get().xp(g, kai).unwrap();
    let mut t = 1_800_000_000_000i64;
    let mut say = |place: Place, who: &Member| { t += 61_000; bot.on_message(&MessageEvent { guild: g.into(), place, author: who.clone(), id: String::new(), text: String::new(), mentions: 0, mentioned: Vec::new(), files: Vec::new(), at_ms: t }, &mut ten) };
    let start = xp();

    // a no-XP channel, a thread inside it, and a channel in a no-XP category
    let (quiet, category, ticket, arcade) = ("800000000000000010", "800000000000000020", "800000000000000030", "800000000000000040");
    bot.settings.set(g, levels::MODULE, "noXpChannels", &json!([quiet, category])).unwrap();
    say(Place::channel(quiet), &kai_m);
    say(Place { channel: "800000000000000011".into(), thread_of: Some(quiet.into()), category: None }, &kai_m);
    say(Place { channel: "800000000000000021".into(), thread_of: None, category: Some(category.into()) }, &kai_m);
    assert_eq!(xp(), start, "none of those gave XP");
    // a support ticket (Good Boy 3 keeps open tickets as ticket:<channel>)
    bot.db.get().data_set(g, "support", &format!("ticket:{ticket}"), &json!({ "number": 7, "status": "open" })).unwrap();
    say(Place::channel(ticket), &kai_m);
    assert_eq!(xp(), start, "tickets never give XP");
    // the whole module switched off in one channel with /channel
    bot.db.get().config_set(g, levels::MODULE, "__offChannels", &json!([arcade])).unwrap();
    bot.settings.forget(g, levels::MODULE);
    say(Place::channel(arcade), &kai_m);
    assert_eq!(xp(), start);
    let rec = bot.db.get().data_get(g, "community", &format!("user:{kai}")).unwrap().unwrap();
    assert_eq!(rec["messages"], 800, "a module that is off there does not even count the message");
    // a normal channel still works
    say(Place::channel(GENERAL), &kai_m);
    assert_eq!(xp(), start + 15);

    // boosts: the best role boost times the channel's boost (x2 role, x1.5 channel = x3)
    let vip = "900000000000000850";
    bot.db.get().data_set(g, "community", "xpBoosts", &json!([{ "kind": "role", "id": vip, "mult": 2 }, { "kind": "role", "id": "1", "mult": 5 }, { "kind": "channel", "id": GENERAL, "mult": 1.5 }])).unwrap();
    kai_m.roles = vec![vip.to_string()];
    say(Place::channel(GENERAL), &kai_m);
    assert_eq!(xp(), start + 15 + 45);
    assert_eq!(levels::xp_boost(&json!([{ "kind": "channel", "id": "cat", "mult": 0.5 }]), &[], &Place { channel: "c".into(), thread_of: None, category: Some("cat".into()) }), 0.5);

    // levels turned off for the whole server: nothing is counted, and the commands say so
    let before = xp();
    bot.db.get().set_module_enabled(g, levels::MODULE, false).unwrap();
    say(Place::channel(GENERAL), &kai_m);
    assert_eq!(xp(), before);
    let cmd = CommandEvent { guild: g.into(), place: Place::channel(GENERAL), member: kai_m.clone(), name: "rank".into(), from_form: true, ..Default::default() };
    assert!(text_of(&bot.on_command(&cmd, &|_| None, &mut |lo, _| lo).remove(0)).contains("Levels are turned off in this server"));
    bot.db.get().set_module_enabled(g, levels::MODULE, true).unwrap();
    say(Place::channel(GENERAL), &kai_m);
    assert!(xp() > before, "turned back on, it carries on");
}

#[test]
fn rank_and_leaderboard_cards_and_commands_that_are_not_here_yet() {
    let (_tmp, _dir, bot, wrote) = world();
    let (g, kai, rowan) = (wrote["guild"].as_str().unwrap(), wrote["kai"].as_str().unwrap(), wrote["rowan"].as_str().unwrap());
    let cmd = |name: &str, who: &Member, target: Option<Member>| CommandEvent { guild: g.into(), place: Place::channel(GENERAL), member: who.clone(), name: name.into(), target, from_form: true, ..Default::default() };
    let names = |id: &str| if id == kai { Some("Kai".to_string()) } else { None };
    let (kai_m, rowan_m) = (member(kai, "Kai"), member(rowan, "Rowan"));

    let mine = level_of(12345);
    let a = bot.on_command(&cmd("rank", &kai_m, None), &names, &mut |lo, _| lo).remove(0);
    let text = text_of(&a);
    // Good Boy 3's text version (shown when pictures are off or can't be drawn)
    assert!(text.starts_with(&format!("### Level {}", mine.level)), "{text}");
    assert!(text.contains(&format!("{} / {} XP to level {}", mine.into, mine.needed, mine.level + 1)) && text.contains("**Rank** #1 · **Total XP** 12345 · **Messages** 800 · **Reputation** 4"), "{text}");
    // and the picture, with what Good Boy 3 draws on it, and Customise on your own card
    let Action::Reply { card } = &a else { unreachable!() };
    let Some(gb_core::Art::Rank(art)) = &card.art else { panic!("a rank card picture") };
    assert_eq!((art.level, art.into, art.needed, art.rank, art.xp, art.messages), (mine.level as i64, mine.into, mine.needed, Some(1), 12345, 800));
    assert!(card.buttons.iter().any(|b| b.id == format!("rankstyle:open:{kai}") && b.label == "Customise"));
    // someone else's rank: no Customise; someone with no XP: rank —
    let Action::Reply { card } = bot.on_command(&cmd("rank", &kai_m, Some(rowan_m.clone())), &names, &mut |lo, _| lo).remove(0) else { panic!() };
    assert!(card.buttons.is_empty());
    assert!(text_of(&bot.on_command(&cmd("rank", &member("900000000000000999", "Newbie"), None), &names, &mut |lo, _| lo).remove(0)).contains("**Rank** —"));
    // pictures off: the text version only
    bot.settings.set(g, "community", "rankCards", &serde_json::json!(false)).unwrap();
    let Action::Reply { card } = bot.on_command(&cmd("rank", &kai_m, None), &names, &mut |lo, _| lo).remove(0) else { panic!() };
    assert!(card.art.is_none() && card.buttons.is_empty());
    bot.settings.set(g, "community", "rankCards", &serde_json::json!(true)).unwrap();

    // Customise: the popup, Good Boy 3's checks, and the saved style on the next card
    let press = gb_core::ButtonEvent { guild: g.into(), place: Place::channel(GENERAL), member: kai_m.clone(), id: format!("rankstyle:open:{kai}"), ..Default::default() };
    let Action::Form { id, title, fields } = bot.on_button(&press, &names, &mut |lo, _| lo).remove(0) else { panic!("a popup") };
    assert_eq!((title.as_str(), fields.len()), ("Your rank card", 4));
    let other = gb_core::ButtonEvent { member: rowan_m.clone(), ..press.clone() };
    assert!(text_of(&bot.on_button(&other, &names, &mut |lo, _| lo).remove(0)).contains("someone else's card"));
    let fill = |vals: &[(&str, &str)]| text_of(&bot.on_form(&gb_core::FormEvent { guild: g.into(), place: Place::channel(GENERAL), member: kai_m.clone(), id: id.clone(), values: vals.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), ..Default::default() }, &names, &mut |lo, _| lo).remove(0));
    // colours are picked from swatches now (a dropdown), not typed
    assert!(fields.iter().filter(|f| f.id.starts_with("accent")).all(|f| matches!(&f.kind, gb_core::FieldKind::Select(o) if o.len() <= 25 && o.iter().any(|x| x.1 == "#ed4245"))), "swatch dropdowns");
    // a background is uploaded in the popup now (not pasted as a link), so a typed link is simply not used
    assert!(fill(&[("theme", "ocean"), ("accent", "#FF9A3C"), ("background", "https://example.com/a.png")]).contains("🎨 Saved!"));
    let Action::Reply { card } = bot.on_command(&cmd("rank", &kai_m, None), &names, &mut |lo, _| lo).remove(0) else { panic!() };
    let Some(gb_core::Art::Rank(art)) = &card.art else { panic!() };
    assert_eq!((art.theme.as_deref(), art.accent.as_deref(), art.background.as_deref()), (Some("ocean"), Some("#ff9a3c"), None));
    // a background that Good Boy 3 saved as a link keeps working until it is replaced or removed
    bot.db.get().data_set(g, "community", &format!("card:{kai}"), &serde_json::json!({ "theme": "ocean", "accent": "#FF9A3C", "background": "https://cdn.discordapp.com/attachments/1/2/bg.png" })).unwrap();
    let Action::Reply { card } = bot.on_command(&cmd("rank", &kai_m, None), &names, &mut |lo, _| lo).remove(0) else { panic!() };
    let Some(gb_core::Art::Rank(art)) = &card.art else { panic!() };
    assert_eq!(art.background.as_deref(), Some("https://cdn.discordapp.com/attachments/1/2/bg.png"));

    let board = text_of(&bot.on_command(&cmd("leaderboard", &rowan_m, None), &names, &mut |lo, _| lo).remove(0));
    let lines: Vec<&str> = board.lines().collect();
    assert_eq!(lines[0], "### Leaderboard · XP");
    assert_eq!(lines[1], format!("🥇 <@{kai}> - level {} · 12345 XP", mine.level));
    assert_eq!(lines[2], format!("🥈 <@{rowan}> - level 1 · 150 XP"), "members are shown as mentions, as in Good Boy 3");

    // a command this build does not have yet says so, privately
    match bot.on_command(&cmd("collect", &kai_m, None), &names, &mut |lo, _| lo).remove(0) {
        Action::Reply { card } => { assert!(card.private); assert!(card.lines[0].contains("does not have `/collect` yet")); }
        other => panic!("{other:?}"),
    }
    // switched off in this channel
    bot.db.get().config_set(g, levels::MODULE, "__offChannels", &json!([GENERAL])).unwrap();
    bot.settings.forget(g, levels::MODULE);
    assert!(text_of(&bot.on_command(&cmd("rank", &kai_m, None), &names, &mut |lo, _| lo).remove(0)).contains("switched off in this channel"));
}

#[test]
fn settings_are_checked_held_in_memory_and_stored_the_way_good_boy_3_stores_them() {
    let (_tmp, dir, bot, wrote) = world();
    let g = wrote["guild"].as_str().unwrap();
    let s = &bot.settings;
    // defaults, when the server never chose
    assert_eq!((s.int(g, levels::MODULE, "xpMin"), s.int(g, levels::MODULE, "xpCooldownSeconds"), s.bool(g, levels::MODULE, "levelUpEnabled")), (15, 60, true));
    assert_eq!(s.list(g, levels::MODULE, "noXpChannels"), Vec::<String>::new());
    // each kind of setting is checked
    assert_eq!(s.set(g, levels::MODULE, "xpMin", &json!("40")).unwrap(), json!(40));
    assert_eq!(s.set(g, levels::MODULE, "xpMin", &json!(9999)), Err(SettingsError::NotNumber { label: "XP per message (min)", min: 1, max: 500 }));
    assert_eq!(s.set(g, levels::MODULE, "levelUpEnabled", &json!("maybe")), Err(SettingsError::NotToggle("Announce level-ups")));
    assert_eq!(s.set(g, levels::MODULE, "levelUpChannel", &json!("general")), Err(SettingsError::NotId("channel")));
    assert_eq!(s.set(g, levels::MODULE, "levelUpChannel", &json!("none")).unwrap(), Value::Null);
    assert!(matches!(s.set(g, levels::MODULE, "nope", &json!(1)), Err(SettingsError::Unknown(..))));
    assert_eq!(s.set(g, levels::MODULE, "noXpChannels", &json!("a, b, a")).unwrap(), json!(["a", "b"]));
    assert_eq!(s.int(g, levels::MODULE, "xpMin"), 40, "a change is seen straight away");
    // held in memory: a change made behind its back is not seen until it is told
    bot.db.get().config_set(g, levels::MODULE, "xpMin", &json!(77)).unwrap();
    assert_eq!(s.int(g, levels::MODULE, "xpMin"), 40);
    s.forget(g, levels::MODULE);
    assert_eq!(s.int(g, levels::MODULE, "xpMin"), 77);
    // and Good Boy 3 reads a setting v4 saved (the music volume it wrote was 35)
    bot.db.get().config_set(g, "music", "volume", &json!(80)).unwrap();
    drop(bot);
    assert_eq!(node("read-3x.mjs", &[dir.to_str().unwrap(), g, "0"])["volume"], 80);
}
