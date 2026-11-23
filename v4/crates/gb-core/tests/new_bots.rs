//! The bots a server often runs next to Good Boy (Friend Time, Alt Detect, PluralKit),
//! done by Good Boy itself.

use gb_core::perms::ADMINISTRATOR;
use gb_core::{Action, Bot, CommandEvent, Member, MessageEvent, Place};
use gb_data::Store;
use std::collections::BTreeMap;

const G: &str = "700000000000000001";
const CH: &str = "800000000000000001";
const NOW: i64 = 1_800_000_000_000;

fn bot() -> (tempfile::TempDir, Bot) {
    let tmp = tempfile::tempdir().unwrap();
    let bot = Bot::new(Store::create(tmp.path().join("eclipse.db")).unwrap());
    bot.on_server(G, "Ghost Town");
    (tmp, bot)
}
fn member(id: &str, name: &str, perms: u64) -> Member {
    Member { id: id.into(), name: name.into(), perms, ..Default::default() }
}
fn command(bot: &Bot, who: &Member, name: &str, sub: Option<&str>, args: &[(&str, &str)], target: Option<Member>, at: i64) -> Vec<Action> {
    let args: BTreeMap<String, String> = args.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    bot.on_command(&CommandEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), name: name.into(), sub: sub.map(str::to_string), args, target, at_ms: at, from_form: true, ..Default::default() }, &|_| None, &mut |lo, _| lo)
}
fn said(actions: &[Action]) -> String {
    actions.iter().filter_map(|a| match a { Action::Reply { card } | Action::Send { card, .. } | Action::Update { card } => Some(card.title.iter().cloned().chain(card.lines.iter().cloned()).collect::<Vec<_>>().join(" ")), _ => None }).collect::<Vec<_>>().join(" | ")
}
fn says(bot: &Bot, who: &Member, text: &str, at: i64) -> Vec<Action> {
    bot.on_message(&MessageEvent { guild: G.into(), place: Place::channel(CH), author: who.clone(), id: format!("m{at}"), text: text.into(), at_ms: at, ..Default::default() }, &mut |lo, _| lo)
}

#[test]
fn members_share_a_time_zone_and_see_each_others_time() {
    let (_t, bot) = bot();
    bot.db.get().set_module_enabled(G, "timezones", true).unwrap();
    let kai = member("900000000000000011", "Kai", 0);
    let sam = member("900000000000000012", "Sam", 0);
    assert!(said(&command(&bot, &kai, "time", None, &[], None, NOW)).contains("haven't said where"));
    assert!(said(&command(&bot, &kai, "timezone", Some("set"), &[("zone", "Narnia")], None, NOW)).contains("don't know that place"));
    assert!(said(&command(&bot, &kai, "timezone", Some("set"), &[("zone", "New York")], None, NOW)).contains("America/New_York"));
    assert!(said(&command(&bot, &sam, "timezone", Some("set"), &[("zone", "UTC+9")], None, NOW)).contains("UTC+9"));
    // NOW is 2027-01-15 08:00 UTC: 03:00 in New York, 17:00 at UTC+9
    assert!(said(&command(&bot, &sam, "time", None, &[], Some(kai.clone()), NOW)).contains("3:00 AM"), "{}", said(&command(&bot, &sam, "time", None, &[], Some(kai.clone()), NOW)));
    assert!(said(&command(&bot, &kai, "time", None, &[], Some(sam.clone()), NOW)).contains("5:00 PM"));
    // "8pm for Kai" becomes a time everyone sees in their own zone
    let out = said(&command(&bot, &sam, "time", None, &[("at", "8pm")], Some(kai.clone()), NOW));
    // 8pm in New York on 2027-01-15 is 01:00 UTC on the 16th = unix 1_800_000_000 + (17 hours)
    let expect = (NOW / 1000) + 17 * 3600;
    assert!(out.contains(&format!("<t:{expect}:t>")), "{out}");
    assert!(said(&command(&bot, &sam, "time", None, &[("at", "never")], Some(kai.clone()), NOW)).contains("Say a time like"));
    // the list, ordered by offset, naming who is where
    let list = said(&command(&bot, &kai, "timezone", Some("list"), &[], None, NOW));
    assert!(list.contains("<@900000000000000011>") && list.contains("<@900000000000000012>") && list.find("New_York").unwrap() < list.find("UTC+9").unwrap(), "{list}");
    command(&bot, &kai, "timezone", Some("clear"), &[], None, NOW);
    assert!(said(&command(&bot, &sam, "time", None, &[], Some(kai), NOW)).contains("hasn't shared"));
}

#[test]
fn someone_who_looks_like_a_banned_member_is_flagged_for_staff() {
    let (_t, bot) = bot();
    bot.db.get().set_module_enabled(G, "altwatch", true).unwrap();
    bot.db.get().set_module_enabled(G, "moderation", true).unwrap();
    let admin = member("900000000000000001", "Owner", ADMINISTRATOR);
    let pic = "https://cdn.discordapp.com/avatars/900000000000000021/0123456789abcdef.png?size=128";
    // someone is removed, and written down as banned
    let banned = Member { id: "900000000000000021".into(), name: "Shadow_Wolf".into(), avatar: Some(pic.into()), ..Default::default() };
    bot.on_member(G, &banned, true);
    bot.on_member(G, &banned, false);
    assert!(bot.db.get().roster_how(G, &banned.id, "banned", None, None, i64::MAX / 2, i64::MAX / 2).unwrap(), "a leave record to mark");
    // set up: tell staff in a channel
    bot.settings.set(G, "altwatch", "enabled", &serde_json::json!(true)).unwrap();
    bot.settings.set(G, "altwatch", "channel", &serde_json::json!("800000000000000009")).unwrap();
    // a stranger with another picture and another name: nothing
    let stranger = Member { id: "900000000000000031".into(), name: "Pixel".into(), avatar: Some("https://cdn.discordapp.com/avatars/900000000000000031/aaaaaaaaaaaaaaaa.png".into()), ..Default::default() };
    assert!(bot.on_member(G, &stranger, true).iter().all(|a| !said(std::slice::from_ref(a)).contains("alt account")));
    // the banned member's picture on a new account: staff are told, in the channel, with what matched
    let alt = Member { id: "900000000000000032".into(), name: "Totally New".into(), avatar: Some(pic.replace("900000000000000021", "900000000000000032")), ..Default::default() };
    let out = bot.on_member(G, &alt, true);
    let alert = out.iter().find(|a| matches!(a, Action::Send { channel, .. } if channel == "800000000000000009")).expect("an alert");
    let text = said(std::slice::from_ref(alert));
    assert!(text.contains("Possible alt account") && text.contains("Shadow_Wolf") && text.contains("the same profile picture"), "{text}");
    assert!(out.iter().all(|a| !matches!(a, Action::Kick { .. } | Action::Timeout { .. })), "only tells staff by default");
    // /altcheck says the same on request, and only to staff
    let nobody = member("900000000000000002", "Nobody", 0);
    assert!(said(&command(&bot, &nobody, "altcheck", None, &[], Some(alt.clone()), NOW)).contains("permission"));
    assert!(said(&command(&bot, &admin, "altcheck", None, &[], Some(alt), NOW)).contains("Shadow_Wolf"));
    assert!(said(&command(&bot, &admin, "altcheck", None, &[], Some(stranger), NOW)).contains("doesn't look like"));
    // with the action set to kick, the newcomer is removed too
    bot.settings.set(G, "altwatch", "action", &serde_json::json!("kick")).unwrap();
    let alt2 = Member { id: "900000000000000033".into(), name: "Another".into(), avatar: Some(pic.replace("900000000000000021", "900000000000000033")), ..Default::default() };
    assert!(bot.on_member(G, &alt2, true).iter().any(|a| matches!(a, Action::Kick { user, .. } if user == "900000000000000033")));
}

fn proxied(actions: &[Action]) -> Option<(String, String, Option<String>, Option<String>)> {
    actions.iter().find_map(|a| match a { Action::Proxy { name, text, original, avatar, .. } => Some((name.clone(), text.clone(), original.clone(), avatar.clone())), _ => None })
}

#[test]
fn messages_with_a_members_tags_are_sent_as_that_member() {
    let (_t, bot) = bot();
    bot.db.get().set_module_enabled(G, "plural", true).unwrap();
    let me = member("900000000000000041", "Alex", 0);
    // no system yet: nothing is proxied
    assert!(proxied(&says(&bot, &me, "k: hello", NOW)).is_none());
    assert!(said(&command(&bot, &me, "plural", Some("add"), &[("member", "Kai"), ("prefix", "k:"), ("avatar", "https://example.com/kai.png")], None, NOW)).contains("Added **Kai**"));
    assert!(said(&command(&bot, &me, "plural", Some("add"), &[("member", "Rowan"), ("prefix", "["), ("suffix", "]")], None, NOW)).contains("Added **Rowan**"));
    assert!(said(&command(&bot, &me, "plural", Some("add"), &[("member", "kai")], None, NOW)).contains("already have"));
    assert!(said(&command(&bot, &me, "plural", Some("add"), &[("member", "Discord")], None, NOW)).contains("does not allow"));
    assert!(said(&command(&bot, &me, "plural", Some("add"), &[("member", "X"), ("avatar", "http://nope")], None, NOW)).contains("https"));
    // a tagged message: sent as Kai with their picture, the original goes after
    let (name, text, original, avatar) = proxied(&says(&bot, &me, "k: hello everyone", NOW + 10)).expect("proxied");
    assert_eq!((name.as_str(), text.as_str(), avatar.as_deref()), ("Kai", "hello everyone", Some("https://example.com/kai.png")));
    assert_eq!(original.as_deref(), Some(&format!("m{}", NOW + 10)[..]));
    // Rowan has no picture of their own: the author's is used (none here)
    assert_eq!(proxied(&says(&bot, &me, "[ hi there ]", NOW + 20)).map(|p| (p.0, p.1, p.3)), Some(("Rowan".into(), "hi there".into(), None)));
    // a backslash, an untagged message, a bot and someone else's message are left alone
    assert!(proxied(&says(&bot, &me, "\\k: not this one", NOW + 30)).is_none());
    assert!(proxied(&says(&bot, &me, "just talking", NOW + 40)).is_none());
    let stranger = member("900000000000000042", "Stranger", 0);
    assert!(proxied(&says(&bot, &stranger, "k: hello", NOW + 50)).is_none());
    // autoproxy: everything as one member; "latch" continues as whoever spoke last; off stops
    assert!(said(&command(&bot, &me, "plural", Some("autoproxy"), &[("mode", "Rowan")], None, NOW)).contains("sent as **Rowan**"));
    assert_eq!(proxied(&says(&bot, &me, "no tags needed", NOW + 60)).map(|p| (p.0, p.1)), Some(("Rowan".into(), "no tags needed".into())));
    command(&bot, &me, "plural", Some("autoproxy"), &[("mode", "latch")], None, NOW);
    proxied(&says(&bot, &me, "k: switching", NOW + 70)).unwrap();
    assert_eq!(proxied(&says(&bot, &me, "still Kai now", NOW + 80)).map(|p| p.0), Some("Kai".into()));
    command(&bot, &me, "plural", Some("autoproxy"), &[("mode", "off")], None, NOW);
    assert!(proxied(&says(&bot, &me, "plain again", NOW + 90)).is_none());
    // proxying can be turned off, and the channels limited
    command(&bot, &me, "plural", Some("proxy"), &[("mode", "off")], None, NOW);
    assert!(proxied(&says(&bot, &me, "k: off", NOW + 100)).is_none());
    command(&bot, &me, "plural", Some("proxy"), &[("mode", "on")], None, NOW);
    bot.settings.set(G, "plural", "channels", &serde_json::json!(["800000000000000099"])).unwrap();
    assert!(proxied(&says(&bot, &me, "k: wrong channel", NOW + 110)).is_none());
    bot.settings.set(G, "plural", "channels", &serde_json::json!([])).unwrap();
    // "who sent that?" once the proxied message is up
    bot.on_posted(G, "plural:900000000000000041:Kai", "777");
    assert!(said(&command(&bot, &stranger, "plural", Some("who"), &[("message", "https://discord.com/channels/1/2/777")], None, NOW)).contains("<@900000000000000041> as **Kai**"));
    // editing and removing
    assert!(said(&command(&bot, &me, "plural", Some("edit"), &[("member", "Kai"), ("prefix", "-"), ("suffix", "~k"), ("new_name", "Kaito")], None, NOW)).contains("Saved **Kaito**"));
    assert_eq!(proxied(&says(&bot, &me, "late night ~k", NOW + 120)).map(|p| p.0), Some("Kaito".into()));
    assert!(said(&command(&bot, &me, "plural", Some("list"), &[], None, NOW)).contains("Rowan"));
    assert!(said(&command(&bot, &me, "plural", Some("remove"), &[("member", "Rowan")], None, NOW)).contains("Removed **Rowan**"));
    assert!(proxied(&says(&bot, &me, "[gone]", NOW + 130)).is_none());
    // a thread: the message goes to the channel it was started in, in that thread
    let mut ev = MessageEvent { guild: G.into(), place: Place { channel: "800000000000000055".into(), thread_of: Some(CH.into()), category: None }, author: me.clone(), id: "t1".into(), text: "late night ~k".into(), at_ms: NOW + 140, ..Default::default() };
    let out = bot.on_message(&ev, &mut |lo, _| lo);
    assert!(out.iter().any(|a| matches!(a, Action::Proxy { channel, thread: Some(t), .. } if channel == CH && t == "800000000000000055")), "{out:?}");
    ev.author.bot = true;
    assert!(proxied(&bot.on_message(&ev, &mut |lo, _| lo)).is_none());
}

#[test]
fn a_group_command_opens_a_menu_and_picking_runs_the_real_command() {
    use gb_core::ButtonEvent;
    let (_t, bot) = bot();
    for m in ["moderation", "money", "member-management"] { bot.db.get().set_module_enabled(G, m, true).unwrap(); }
    let admin = member("900000000000000001", "Owner", ADMINISTRATOR);
    let pick = |id: &str, value: &str| bot.on_button(&ButtonEvent { guild: G.into(), place: Place::channel(CH), member: admin.clone(), id: id.into(), message: "1".into(), values: vec![value.into()], at_ms: NOW }, &|_| None, &mut |lo, _| lo);
    // /mod: a private menu listing what is inside, ban among it
    let out = command(&bot, &admin, "mod", None, &[], None, NOW);
    let card = match &out[..] { [Action::Reply { card }] => card.clone(), other => panic!("{other:?}") };
    assert!(card.private);
    let select = card.select.expect("a menu");
    assert_eq!(select.id, "gmenu:mod");
    for want in ["ban", "kick", "warn", "purge", "lockdown"] { assert!(select.options.iter().any(|o| o.1 == want), "{want}"); }
    // picking ban opens its popup (the same one /ban used to open)
    let out = pick("gmenu:mod", "ban");
    assert!(matches!(out.first(), Some(Action::Form { .. })), "{out:?}");
    // picking a command with nothing to fill in just runs it
    let out = pick("gmenu:money", "daily");
    assert!(out.iter().any(|a| matches!(a, Action::Reply { .. })), "{out:?}");
    // a command with parts shows its parts, then picking a part runs it
    let out = pick("gmenu:server", "backup");
    let parts = match &out[..] { [Action::Update { card }] => card.select.clone().expect("a second menu"), other => panic!("{other:?}") };
    assert_eq!(parts.id, "gmenu:server:backup");
    assert!(parts.options.iter().any(|o| o.1 == "create"));
    assert!(!pick("gmenu:server:backup", "create").is_empty());
    // a stale or invented pick is answered, not ignored
    assert!(said(&pick("gmenu:mod", "balance")).contains("older message"));
    assert!(said(&pick("gmenu:nowhere", "ban")).contains("older message"));
}

#[test]
fn the_dashboard_shows_who_opened_a_ticket_who_it_is_about_how_urgent_it_is_and_which_moderator_has_it() {
    let (_t, bot) = bot();
    bot.db.get().set_module_enabled(G, "support", true).unwrap();
    bot.directory.set_bot_owner(Some("900000000000000009".into()));
    let ch = "820000000000000007";
    let t = serde_json::json!({ "number": 7, "opener": "900000000000000001", "openerTag": "kai", "category": "report", "type": "report", "typeLabel": "Report a member", "priority": "urgent", "status": "open", "createdAt": NOW,
        "report": { "id": "900000000000000055", "name": "troublemaker" }, "controlMessageId": "812" });
    bot.db.get().data_set(G, "support", &format!("ticket:{ch}"), &t).unwrap();
    bot.db.get().history_ensure(G, &t, ch).unwrap();
    bot.db.get().history_details(G, &t).unwrap();
    // the list says who opened it, who it is about and how urgent it is; nobody has it yet
    let row = || bot.ticket_rows(G).into_iter().find(|r| r["number"] == 7).unwrap();
    let r = row();
    assert_eq!((r["opener"]["name"].as_str(), r["about"]["name"].as_str(), r["about"]["id"].as_str(), r["severity"]["id"].as_str(), r["open"].as_bool()), (Some("kai"), Some("troublemaker"), Some("900000000000000055"), Some("urgent"), Some(true)));
    assert!(r["severity"]["label"].as_str().unwrap().contains("urgent") && r["severity"]["rank"] == 3 && r["claimed_by"].is_null());
    // a moderator signed in on the web claims it: it is theirs, and the ticket channel says who and where from
    let (said, out) = bot.ticket_action(G, 7, "claim", "", Some(("900000000000000077", "Mod Maya")), NOW + 1000).unwrap();
    assert_eq!(said, "Claimed.");
    assert!(said_in(&out).contains("<@900000000000000077> claimed this ticket") && said_in(&out).contains("from the dashboard"), "{}", said_in(&out));
    assert_eq!(row()["claimed_by"]["id"], "900000000000000077");
    // their reply is sent under their name, pings the opener, and counts as the first reply
    let (_, out) = bot.ticket_action(G, 7, "reply", "We are looking into it now.", Some(("900000000000000077", "Mod Maya")), NOW + 61_000).unwrap();
    let text = said_in(&out);
    assert!(text.contains("Staff reply") && text.contains("Mod Maya") && text.contains("We are looking into it now."), "{text}");
    assert!(matches!(&out[0], Action::Send { ping, .. } if ping == &vec!["900000000000000001".to_string()]));
    assert_eq!(row()["first_response_ms"], 61_000);
    // someone else releasing is refused? No: claiming again by the same moderator releases it
    bot.ticket_action(G, 7, "claim", "", Some(("900000000000000077", "Mod Maya")), NOW + 62_000).unwrap();
    assert!(row()["claimed_by"].is_null());
    // the ticket view carries the conversation that the bot kept, oldest first
    bot.db.get().archive_put(G, 7, "m1", ch, Some("900000000000000001"), "kai", None, false, "Hello, I need help", &serde_json::json!([]), &serde_json::json!([]), NOW + 500).unwrap();
    bot.db.get().archive_put(G, 7, "m2", ch, Some("900000000000000077"), "Mod Maya", None, false, "On it", &serde_json::json!([]), &serde_json::json!([]), NOW + 900).unwrap();
    let thread = bot.ticket_thread(G, 7).unwrap();
    let texts: Vec<&str> = thread["messages"].as_array().unwrap().iter().map(|m| m["text"].as_str().unwrap()).collect();
    assert_eq!(texts, ["Hello, I need help", "On it"]);
    assert_eq!(thread["ticket"]["number"], 7);
    assert!(bot.ticket_thread(G, 99).is_none());
    // once closed, the list keeps who it was about, how urgent it was and who closed it
    bot.ticket_action(G, 7, "close", "Warned them", Some(("900000000000000077", "Mod Maya")), NOW + 90_000).unwrap();
    let r = row();
    assert_eq!((r["open"].as_bool(), r["severity"]["id"].as_str(), r["about"]["name"].as_str(), r["closed_by"]["id"].as_str(), r["resolution"].as_str()), (Some(false), Some("urgent"), Some("troublemaker"), Some("900000000000000077"), Some("Warned them")));
}
fn said_in(actions: &[Action]) -> String {
    actions.iter().filter_map(|a| match a { Action::Send { card, .. } | Action::Reply { card } => Some(card.title.iter().cloned().chain(card.lines.iter().cloned()).collect::<Vec<_>>().join(" ")), _ => None }).collect::<Vec<_>>().join(" | ")
}

#[test]
fn plural_is_reachable_through_the_me_menu_and_each_part_opens_a_popup_or_runs() {
    use gb_core::ButtonEvent;
    let (_t, bot) = bot();
    let me = member("900000000000000041", "Kai", 0);
    let pick = |id: &str, value: &str| bot.on_button(&ButtonEvent { guild: G.into(), place: Place::channel(CH), member: me.clone(), id: id.into(), message: "1".into(), values: vec![value.into()], at_ms: NOW }, &|_| None, &mut |lo, _| lo);
    // with the module off, picking it says so instead of staying silent
    let off = pick("gmenu:me", "plural");
    println!("module off -> {off:?}");
    bot.db.get().set_module_enabled(G, "plural", true).unwrap();
    let out = pick("gmenu:me", "plural");
    let parts = match &out[..] { [Action::Update { card }] => card.select.clone().expect("a second menu"), other => panic!("the plural menu did not open: {other:?}") };
    assert_eq!(parts.id, "gmenu:me:plural");
    for want in ["add", "edit", "list", "who", "proxy", "autoproxy"] { assert!(parts.options.iter().any(|o| o.1 == want), "{want}"); }
    for part in ["add", "edit", "remove", "show", "system", "proxy", "autoproxy", "who"] {
        let out = pick("gmenu:me:plural", part);
        let Some(Action::Form { fields, title, .. }) = out.first() else { panic!("{part}: {out:?}") };
        assert!(title.chars().count() <= 45, "{part}: title {title}");
        assert!(!fields.is_empty() && fields.len() <= 5, "{part}: {} fields", fields.len());
        for f in fields { assert!(f.label.chars().count() <= 45, "{part}: the box label \"{}\" is {} characters, Discord takes 45", f.label, f.label.chars().count()); }
    }
    assert!(!said(&pick("gmenu:me:plural", "list")).is_empty(), "list runs");
}

#[test]
fn help_lists_what_is_switched_on_here_and_nothing_else() {
    let (_t, bot) = bot();
    let me = member("900000000000000041", "Kai", 0);
    bot.db.get().set_module_enabled(G, "moderation", false).unwrap();
    bot.db.get().set_module_enabled(G, "plural", false).unwrap();
    let before = said(&command(&bot, &me, "help", None, &[], None, NOW));
    assert!(before.contains("`/rank`"), "{before}");
    assert!(!before.contains("Moderation tools"), "moderation is off here: {before}");
    assert!(!before.contains("plural"), "{before}");
    bot.db.get().set_module_enabled(G, "moderation", true).unwrap();
    bot.db.get().set_module_enabled(G, "plural", true).unwrap();
    let after = said(&command(&bot, &me, "help", None, &[], None, NOW));
    assert!(after.contains("Moderation tools") && after.contains("ban"), "{after}");
    assert!(after.contains("`/me`") && after.contains("plural"), "{after}");
    assert!(command(&bot, &me, "help", None, &[], None, NOW).iter().all(|a| matches!(a, Action::Reply { card } if card.private)), "only the asker sees it");
}

#[test]
fn view_rank_on_a_level_up_shows_the_members_name_and_picture_even_if_they_have_not_spoken_since_start() {
    use gb_core::ButtonEvent;
    let (_t, bot) = bot();
    let viewer = member("900000000000000001", "Viewer", 0);
    // someone the bot remembers from earlier, whose name is not in the live list
    bot.db.get().roster_seen(G, "900000000000000077", "car-SON", Some("https://cdn.discordapp.com/avatars/900000000000000077/abc.png?size=128"), false, None, None, NOW).unwrap();
    let press = |who: &str| bot.on_button(&ButtonEvent { guild: G.into(), place: Place::channel(CH), member: viewer.clone(), id: format!("rank:{who}"), message: "1".into(), values: vec![], at_ms: NOW }, &|_| None, &mut |lo, _| lo);
    let out = press("900000000000000077");
    let card = match &out[..] { [Action::Reply { card }, ..] => card.clone(), other => panic!("{other:?}") };
    let text = format!("{card:?}");
    assert!(text.contains("car-SON"), "the name is shown: {text}");
    assert!(!text.contains("<@"), "no raw mention: {text}");
    assert!(text.contains("abc.png"), "the profile picture is used: {text}");
    // someone never seen at all still gets a readable card, not a mention
    let text = format!("{:?}", press("900000000000000088"));
    assert!(!text.contains("<@900000000000000088>"), "{text}");
}

#[test]
fn a_rank_card_background_can_be_uploaded_in_the_popup_kept_and_removed() {
    use gb_core::{ButtonEvent, FieldKind, FormEvent};
    let (_t, bot) = bot();
    let me = member("900000000000000041", "Kai", 0);
    // the popup has an upload box (and, once there is a picture, a way to remove it)
    let open = bot.on_button(&ButtonEvent { guild: G.into(), place: Place::channel(CH), member: me.clone(), id: format!("rankstyle:open:{}", me.id), message: "1".into(), values: vec![], at_ms: NOW }, &|_| None, &mut |lo, _| lo);
    let Some(Action::Form { fields, .. }) = open.first() else { panic!("{open:?}") };
    assert!(fields.iter().any(|f| f.id == "bgfile" && matches!(f.kind, FieldKind::Files { most: 1 })), "an upload box");
    assert!(fields.len() <= 5 && fields.iter().all(|f| f.label.chars().count() <= 45));
    let save = |files: Vec<(&str, &str, u64)>, remove: bool| {
        let mut values = std::collections::BTreeMap::new();
        values.insert("theme".to_string(), "dark".to_string());
        if remove { values.insert("bgkeep".to_string(), "remove".to_string()); }
        let mut f = std::collections::BTreeMap::new();
        if !files.is_empty() { f.insert("bgfile".to_string(), files.into_iter().map(|(a, b, c)| (a.to_string(), b.to_string(), c)).collect()); }
        bot.on_form(&FormEvent { guild: G.into(), place: Place::channel(CH), member: me.clone(), id: format!("rankstyle:save:{}", me.id), values, members: vec![], files: f, at_ms: NOW }, &|_| None, &mut |lo, _| lo)
    };
    // a link that is not Discord's, a file that is not a picture, and one that is too big are all refused
    assert!(said(&save(vec![("bg.png", "https://evil.example/bg.png", 1000)], false)).contains("did not come from Discord"));
    assert!(said(&save(vec![("bg.exe", "https://cdn.discordapp.com/ephemeral-attachments/1/2/bg.exe", 1000)], false)).contains("PNG, JPG"));
    assert!(said(&save(vec![("bg.png", "https://cdn.discordapp.com/ephemeral-attachments/1/2/bg.png", 9 << 20)], false)).contains("too big"));
    // a good one asks the Discord layer to fetch and keep it
    let ok = save(vec![("bg.png", "https://cdn.discordapp.com/ephemeral-attachments/1/2/bg.png", 5000)], false);
    assert!(ok.iter().any(|a| matches!(a, Action::SaveRankBackground { member, .. } if *member == me.id)), "{ok:?}");
    // once fetched it is kept next to the data and the rank card carries it
    let png: Vec<u8> = [&[0x89u8, b'P', b'N', b'G'][..], &[0u8; 64][..]].concat();
    bot.rank_background_saved(G, &me.id, "bg.png", &png, NOW).unwrap();
    assert!(bot.rank_background_saved(G, &me.id, "bg.png", b"not a picture", NOW).is_err());
    let card = command(&bot, &me, "rank", None, &[], None, NOW);
    let art = match &card[..] { [Action::Reply { card }] => card.art.clone(), other => panic!("{other:?}") };
    let Some(gb_core::Art::Rank(art)) = art else { panic!("a rank picture") };
    let stored = art.background.clone().expect("the background is on the card");
    assert!(stored.starts_with("file:"), "{stored}");
    let path = bot.rank_background_path(G, &stored).expect("a kept file");
    assert_eq!(std::fs::read(&path).unwrap(), png);
    assert!(bot.rank_background_path(G, "file:../../etc/passwd").is_none(), "only names this module writes");
    // the popup now offers to remove it, and removing deletes the file
    let open = bot.on_button(&ButtonEvent { guild: G.into(), place: Place::channel(CH), member: me.clone(), id: format!("rankstyle:open:{}", me.id), message: "1".into(), values: vec![], at_ms: NOW }, &|_| None, &mut |lo, _| lo);
    let Some(Action::Form { fields, .. }) = open.first() else { panic!() };
    assert!(fields.iter().any(|f| f.id == "bgkeep"));
    let _ = save(vec![], true);
    assert!(!path.exists(), "the file is gone");
    let art = match &command(&bot, &me, "rank", None, &[], None, NOW)[..] { [Action::Reply { card }] => card.art.clone(), _ => None };
    let Some(gb_core::Art::Rank(art)) = art else { panic!() };
    assert!(art.background.is_none());
}

fn post_text(actions: &[Action]) -> String {
    actions.iter().filter_map(|a| match a { Action::Post { card, .. } => Some(card.lines.join(" ")), _ => None }).collect::<Vec<_>>().join(" ")
}

#[test]
fn a_party_start_time_is_in_the_hosts_own_time_zone() {
    let (_t, bot) = bot();
    for m in ["partyfinder", "timezones"] { bot.db.get().set_module_enabled(G, m, true).unwrap(); }
    let kai = member("900000000000000041", "Kai", 0);
    let make = |who: &Member, when: &str| command(&bot, who, "party", Some("create"), &[("game", "Valorant"), ("slots", "4"), ("when", when)], None, NOW);
    // a delay needs no time zone
    assert!(post_text(&make(&kai, "2h")).contains(&format!("<t:{}:f>", (NOW + 2 * 3_600_000) / 1000)));
    // a time of day with no zone saved says what to do, instead of guessing in UTC
    assert!(said(&make(&kai, "8pm")).contains("time zone"), "{}", said(&make(&kai, "8pm")));
    // with a zone saved, 8pm is 8pm there
    assert!(said(&command(&bot, &kai, "timezone", Some("set"), &[("zone", "New York")], None, NOW)).contains("America/New_York"));
    let zone = jiff::tz::TimeZone::get("America/New_York").unwrap();
    let now = jiff::Timestamp::from_millisecond(NOW).unwrap().to_zoned(zone.clone());
    let today = now.date().at(20, 0, 0, 0).to_zoned(zone.clone()).unwrap().timestamp().as_millisecond();
    let expected = if today > NOW + 60_000 { today } else { now.date().tomorrow().unwrap().at(20, 0, 0, 0).to_zoned(zone.clone()).unwrap().timestamp().as_millisecond() };
    let out = post_text(&make(&kai, "8pm"));
    assert!(out.contains(&format!("<t:{}:f>", expected / 1000)), "expected {expected}: {out}");
    // a date and time too, and a different host has their own zone (none saved here: the server's offset applies)
    let day = jiff::Timestamp::from_millisecond(NOW + 3 * 86_400_000).unwrap().to_zoned(zone.clone()).date();
    let want = day.at(18, 30, 0, 0).to_zoned(zone).unwrap().timestamp().as_millisecond();
    let rowan = member("900000000000000042", "Rowan", 0);
    bot.settings.set(G, "partyfinder", "maxOpenPerUser", &serde_json::json!(5)).ok();
    let typed = format!("{} 18:30", day);
    assert!(post_text(&make(&kai, &typed)).contains(&format!("<t:{}:f>", want / 1000)), "{typed}");
    assert!(!post_text(&make(&rowan, &typed)).is_empty());
}

#[test]
fn the_host_can_ping_a_role_for_their_party_but_only_one_anyone_may_mention() {
    use gb_core::{ButtonEvent, FormEvent};
    let (_t, bot) = bot();
    bot.db.get().set_module_enabled(G, "partyfinder", true).unwrap();
    let host = member("900000000000000041", "Kai", 0);
    let other = member("900000000000000042", "Rowan", 0);
    let admin = member("900000000000000043", "Owner", gb_core::perms::ADMINISTRATOR);
    assert!(command(&bot, &host, "party", Some("create"), &[("game", "Valorant"), ("slots", "4")], None, NOW).iter().any(|a| matches!(a, Action::Post { .. })), "the party is posted");
    let press = |who: &Member, at: i64| bot.on_button(&ButtonEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: "party:ping:1".into(), message: "1".into(), values: vec![], at_ms: at }, &|_| None, &mut |lo, _| lo);
    // only the host gets the popup
    assert!(matches!(press(&host, NOW).first(), Some(Action::Form { id, .. }) if id == "party:pingform:1"));
    assert!(said(&press(&other, NOW)).contains("Only the host"));
    let submit = |who: &Member, role: &str, at: i64| bot.on_form(&FormEvent { guild: G.into(), place: Place::channel(CH), member: who.clone(), id: "party:pingform:1".into(), values: [("role".to_string(), role.to_string()), ("note".to_string(), "silver and up".to_string())].into_iter().collect(), members: vec![], files: Default::default(), at_ms: at }, &|_| None, &mut |lo, _| lo);
    // a role nobody may mention is refused (and so is @everyone)
    assert!(said(&submit(&host, "111", NOW)).contains("Allow anyone to @mention"));
    assert!(said(&submit(&host, G, NOW)).contains("everyone"));
    // once Discord says anyone may mention it, it goes through, with the note, pinging only that role
    let roles = [("111".to_string(), gb_core::bot::RoleFacts { name: "Gamers".into(), position: 1, managed: false, perms: 0, mentionable: true })].into_iter().collect();
    bot.directory.set_role_facts(G, roles, None);
    let out = submit(&host, "111", NOW);
    let sent = out.iter().find_map(|a| match a { Action::Send { card, roles, .. } => Some((card.lines.join(" "), roles.clone())), _ => None }).expect("the ping is posted");
    assert!(sent.0.contains("<@&111>") && sent.0.contains("silver and up") && sent.0.contains("3 more"), "{}", sent.0);
    assert_eq!(sent.1, vec!["111".to_string()]);
    // not again within ten minutes
    assert!(said(&submit(&host, "111", NOW + 60_000)).contains("pinged a moment ago"));
    assert!(submit(&host, "111", NOW + 11 * 60_000).iter().any(|a| matches!(a, Action::Send { .. })));
    // another member cannot ping, and an admin may ping any role
    assert!(said(&submit(&other, "111", NOW + 30 * 60_000)).contains("Only the host"));
    assert!(submit(&admin, "222", NOW + 60 * 60_000).iter().any(|a| matches!(a, Action::Send { .. })));
}

#[test]
fn a_party_uses_the_hosts_voice_channel_and_moves_joiners_into_it() {
    use gb_core::ButtonEvent;
    let (_t, bot) = bot();
    bot.db.get().set_module_enabled(G, "partyfinder", true).unwrap();
    let host = member("900000000000000051", "Kai", 0);
    let guest = member("900000000000000052", "Rowan", 0);
    bot.directory.set_voice(G, &host.id, Some("777"));
    bot.directory.set_voice(G, &guest.id, Some("888"));
    let out = command(&bot, &host, "party", Some("create"), &[("game", "Valorant"), ("slots", "4")], None, NOW);
    let card = out.iter().find_map(|a| match a { Action::Post { card, .. } => Some(card.lines.join(" ")), _ => None }).expect("posted");
    assert!(card.contains("<#777>"), "{card}");
    assert!(!out.iter().any(|a| matches!(a, Action::OpenVoice { .. })), "no new channel is made");
    let join = bot.on_button(&ButtonEvent { guild: G.into(), place: Place::channel(CH), member: guest.clone(), id: "party:join:1".into(), message: "1".into(), values: vec![], at_ms: NOW }, &|_| None, &mut |lo, _| lo);
    assert!(join.iter().any(|a| matches!(a, Action::MoveMember { user, channel } if *user == guest.id && channel.as_deref() == Some("777"))));
}

#[test]
fn a_restart_heads_up_goes_to_the_announcements_channel_only() {
    let (_t, bot) = bot();
    assert!(bot.restart_notice(G, 5).is_empty(), "no announcements channel, nothing to post");
    bot.settings.set(G, "botnews", "announceChannel", &serde_json::json!("800000000000000099")).unwrap();
    let out = bot.restart_notice(G, 5);
    let text = out.iter().find_map(|a| match a { Action::SendText { channel, text, .. } if channel == "800000000000000099" => Some(text.clone()), _ => None }).expect("posted there");
    assert!(text.contains("restarting in 5 minutes") && text.contains("Private windows"), "{text}");
    assert!(bot.restart_notice(G, 1).iter().any(|a| matches!(a, Action::SendText { text, .. } if text.contains("in a minute"))));
}
