//! /migrate from start to end: a scan of what Carl-bot and MEE6 left, then "Bring everything over".
use gb_core::migrate::{Mee6Player, ScanInput, ScanMsg};
use gb_core::{Action, Bot, ButtonEvent, CommandEvent, Member};

const G: &str = "700000000000000001";
const CARL: &str = "235148962103951360";
const MEE6: &str = "159985870458322944";

fn msg(id: &str, ch: &str, author: &str, bot: bool, at: i64, content: &str) -> ScanMsg {
    ScanMsg { id: id.into(), channel: ch.into(), author: author.into(), author_bot: bot, at, content: content.into(), ..Default::default() }
}
fn admin() -> Member { Member { id: "500000000000000001".into(), name: "Jamie".into(), perms: gb_core::perms::ADMINISTRATOR, ..Default::default() } }

#[test]
fn scan_then_bring_everything_over() {
    let tmp = tempfile::tempdir().unwrap();
    let bot = Bot::new(gb_data::Store::create(tmp.path().join("eclipse.db")).unwrap());
    bot.on_server(G, "Ghost Town");
    let role = |name: &str| gb_core::bot::RoleFacts { name: name.into(), position: 1, managed: false, perms: 0, mentionable: false };
    bot.directory.set_role_facts(G, [("600000000000000001".to_string(), role("Gamer")), ("600000000000000002".to_string(), role("Siege"))].into_iter().collect(), Some(10));

    // the command only asks the Discord side to read the server, and only for admins
    let ev = CommandEvent { guild: G.into(), member: admin(), name: "migrate".into(), sub: Some("scan".into()), at_ms: 1_800_000_000_000, from_form: true, ..Default::default() };
    assert!(matches!(bot.on_command(&ev, &|_| None, &mut |lo, _| lo).as_slice(), [Action::Migrate { .. }]));
    let mut not_admin = ev.clone(); not_admin.member.perms = 0;
    assert!(!matches!(bot.on_command(&not_admin, &|_| None, &mut |lo, _| lo).as_slice(), [Action::Migrate { .. }]));

    let mut rr = msg("1", "800000000000000001", CARL, true, 1, "🎮 Gamer");
    rr.reactions = vec!["🎮".into()];
    let mut logs: Vec<ScanMsg> = (0..4).map(|n| { let mut m = msg(&format!("l{n}"), "800000000000000002", CARL, true, 2 + n, ""); m.embed_text = if n % 2 == 0 { "Message deleted in <#5>".into() } else { "Member joined".into() }; m }).collect();
    let ask = msg("6", "800000000000000003", "300000000000000001", false, 10, "?rules");
    let mut answer = msg("7", "800000000000000003", CARL, true, 11, "Be nice to everyone."); answer.reply_to = Some("6".into());
    let mut menu = msg("8", "800000000000000004", CARL, true, 12, "Pick your games");
    menu.components = vec![("rr:600000000000000002".into(), Some("Siege".into()), Some("🛡️".into()), Some("🛡️".into()))];
    let mut messages = vec![rr, ask, answer, menu]; messages.append(&mut logs);
    let input = ScanInput {
        server: "Ghost Town".into(), members: 40,
        bots: vec![(CARL.into(), "Carl-bot".into()), (MEE6.into(), "MEE6".into())],
        roles: vec![(G.into(), "@everyone".into(), false), ("600000000000000001".into(), "Gamer".into(), false), ("600000000000000002".into(), "Siege".into(), false)],
        channels: vec![("800000000000000001".into(), "roles".into()), ("800000000000000002".into(), "logs".into()), ("800000000000000003".into(), "chat".into()), ("800000000000000004".into(), "games".into())],
        voice: vec![("800000000000000005".into(), "Members: 40".into())], messages,
        bans: vec![("400000000000000001".into(), "spammer".into(), Some("spam".into()))],
        mee6: Some(Ok(vec![Mee6Player { id: "300000000000000001".into(), name: "ari".into(), xp: 5000, level: 9, messages: 300 }])),
        scanned_channels: 4, total_channels: 4, ..Default::default()
    };
    let card = bot.migrate_scanned(G, &admin().id, &input, 1_800_000_000_000);
    let text = card.lines.join("\n");
    assert!(text.contains("Carl-bot") && text.contains("MEE6"), "{text}");
    assert!(card.select.is_some() && !card.buttons.is_empty(), "something to pick and a button for everything");

    // someone else can't press it
    let press = |who: Member, values: Vec<String>, id: &str| bot.on_button(&ButtonEvent { guild: G.into(), member: who, id: id.into(), values, at_ms: 1_800_000_060_000, ..Default::default() }, &|_| None, &mut |lo, _| lo);
    let mut other = admin(); other.id = "500000000000000009".into();
    let no = press(other, vec![], &format!("mig:all:{}", admin().id));
    assert!(format!("{no:?}").contains("someone else"));

    let out = press(admin(), vec![], &format!("mig:all:{}", admin().id));
    let all = format!("{out:?}");
    assert!(!all.contains("❌"), "{all}");
    assert!(out.iter().any(|a| matches!(a, Action::Post { channel, .. } if channel == "800000000000000004")), "a Good Boy role menu replaces the button menu");
    assert!(out.iter().any(|a| matches!(a, Action::Delete { channel, message } if channel == "800000000000000004" && message == "8")), "and the old one goes");

    let data = |m: &str, k: &str| bot.db.get().data_get(G, m, k).unwrap();
    assert_eq!(data("roles", "rr:1:🎮"), Some(serde_json::json!("600000000000000001")), "the old reaction message now gives the role");
    assert_eq!(data("tags", "cc:rules").unwrap()["response"], "Be nice to everyone.");
    assert_eq!(data("stats", "counter:800000000000000005").unwrap()["template"], "Members: {members}");
    assert_eq!(data("moderation", "hist:400000000000000001").unwrap()[0]["reason"], "spam");
    assert_eq!(data("community", "user:300000000000000001").unwrap()["xp"], 5000);
    assert_eq!(bot.settings.get(G, "moderation", "logChannel"), serde_json::json!("800000000000000002"));
    assert!(bot.settings.bool(G, "moderation", "logJoins"));

    // the scan is used once
    assert!(format!("{:?}", press(admin(), vec![], &format!("mig:all:{}", admin().id))).contains("scan is gone"));

    // pasted custom commands
    let mut paste = CommandEvent { guild: G.into(), member: admin(), name: "migrate".into(), sub: Some("tags".into()), at_ms: 1_800_000_000_000, from_form: true, ..Default::default() };
    paste.args.insert("text".into(), "?faq\nRead the faq channel.\n---\nbad name here\nx\n".into());
    let said = format!("{:?}", bot.on_command(&paste, &|_| None, &mut |lo, _| lo));
    assert!(said.contains("Saved 2 commands") || said.contains("Saved 1 command"), "{said}");
    assert_eq!(data("tags", "cc:faq").unwrap()["response"], "Read the faq channel.");
}
