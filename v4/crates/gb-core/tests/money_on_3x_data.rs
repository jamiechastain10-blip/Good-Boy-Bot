//! Money in v4, on wallets written by Good Boy 3: the same streak and amount rules (compared against 3.x's own
//! functions), and coins that can never be spent twice.

use gb_core::money::{claim_daily, parse_amount, CLAIM_EVERY, HOUR};
use gb_core::{Action, Bot, ButtonEvent, CommandEvent, Member, Place};
use gb_data::{import_3x, Store};
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
fn world() -> (tempfile::TempDir, Bot, Value) {
    let tmp = tempfile::tempdir().unwrap();
    let wrote = node("make-3x-data.mjs", &[tmp.path().join("gb3").to_str().unwrap()]);
    import_3x(&tmp.path().join("gb3"), &tmp.path().join("gb4")).unwrap();
    let bot = Bot::new(Store::open(tmp.path().join("gb4/eclipse.db")).unwrap());
    (tmp, bot, wrote)
}
fn member(id: &str, name: &str) -> Member {
    Member { id: id.into(), name: name.into(), ..Default::default() }
}
fn card_text(a: &Action) -> String {
    let (Action::Reply { card } | Action::Update { card } | Action::Send { card, .. }) = a else { panic!("not a card: {a:?}") };
    card.to_discord().expect("within Discord's limits");
    card.title.iter().chain(card.lines.iter()).cloned().collect::<Vec<_>>().join("\n")
}
const NOW: i64 = 1_800_000_000_000;

#[test]
fn the_streak_and_amount_rules_give_the_same_answers_as_good_boy_3() {
    // every mix of: streak, how long since the last claim, shields held, and reward size
    let mut daily = Vec::new();
    for streak in [0, 1, 2, 6, 7, 13, 14, 29, 30, 31, 59, 60, 200] {
        for since in [0, HOUR, 19 * HOUR, CLAIM_EVERY, 24 * HOUR, 48 * HOUR, 48 * HOUR + 1, 100 * HOUR] {
            for shields in [0, 1, 3] {
                for base in [1, 7, 250, 999] {
                    let last = if since == 0 { 0 } else { NOW - since };
                    daily.push((streak, last, shields, streak.max(10), base, NOW));
                }
            }
        }
    }
    let amounts: Vec<(&str, Option<i64>, i64, i64)> = vec![
        ("500", None, 1, 1_000_000), ("1,500", None, 1, 1_000_000), ("2.5k", None, 1, 1_000_000), ("1m", None, 1, 1_000_000), ("1.999k", None, 1, 1_000_000), ("0.4", None, 1, 10),
        ("all", Some(320), 1, 1_000_000), ("max", Some(5), 1, 3), ("half", Some(321), 1, 1_000_000), ("half", Some(1), 1, 10), ("all", None, 1, 10), ("ALL", Some(9), 1, 10),
        ("", Some(5), 1, 10), ("abc", Some(5), 1, 10), ("-5", Some(5), 1, 10), ("1.2.3", None, 1, 10), (".5", None, 1, 10), ("5.", None, 1, 10), ("k", None, 1, 10), ("1e3", None, 1, 10_000),
        ("0", None, 1, 10), ("2m", None, 1, 1_000_000), (" 7 ", None, 1, 10), ("1_000", None, 1, 10_000), ("12 000", None, 1, 100_000),
    ];
    let ask = json!({ "daily": daily, "amounts": amounts });
    let tmp = tempfile::tempdir().unwrap();
    let questions = tmp.path().join("ask.json");
    std::fs::write(&questions, ask.to_string()).unwrap();
    let theirs = node("rules-3x.mjs", &[questions.to_str().unwrap()]);

    for (case, js) in daily.iter().zip(theirs["daily"].as_array().unwrap()) {
        let (streak, last, shields, best, base, now) = *case;
        match claim_daily(streak, last, shields, best, base, now) {
            Err(next) => assert_eq!((js["ok"].as_bool(), js["nextAt"].as_i64()), (Some(false), Some(next)), "{case:?}"),
            Ok(c) => {
                let mine = json!({ "ok": true, "reward": c.reward, "bonus": c.bonus, "total": c.total, "streak": c.streak, "shields": c.shields, "usedShield": c.used_shield, "shieldEarned": c.shield_earned, "lost": c.lost, "bestStreak": c.best_streak, "lastDaily": now, "nextAt": c.next_at });
                assert_eq!(&mine, js, "{case:?}");
            }
        }
    }
    assert_eq!(daily.len(), 13 * 8 * 3 * 4);
    for (case, js) in amounts.iter().zip(theirs["amounts"].as_array().unwrap()) {
        match parse_amount(case.0, case.1, case.2, case.3) {
            Ok(n) => assert_eq!(js["value"].as_i64(), Some(n), "{case:?} -> {js}"),
            Err(why) => assert_eq!(js["error"].as_str(), Some(why.as_str()), "{case:?}"),
        }
    }
}

#[test]
fn balance_daily_work_pay_and_the_rich_list_on_a_good_boy_3_wallet() {
    let (_tmp, bot, wrote) = world();
    let (g, kai, rowan) = (wrote["guild"].as_str().unwrap(), wrote["kai"].as_str().unwrap(), wrote["rowan"].as_str().unwrap());
    let (kai_m, rowan_m) = (member(kai, "Kai"), member(rowan, "Rowan"));
    let cmd = |who: &Member, name: &str, target: Option<&Member>, at: i64| CommandEvent {
        guild: g.into(), place: Place::channel("800000000000000001"), member: who.clone(), name: name.into(), target: target.cloned(), at_ms: at, from_form: true, ..Default::default()
    };
    let mut pick_low = |lo: i64, _hi: i64| lo;
    let mut run = |ev: CommandEvent| bot.on_command(&ev, &|_| None, &mut pick_low).remove(0);
    let pay = |who: &Member, to: &str, amount: &str| {
        let ev = gb_core::FormEvent { guild: g.into(), place: Place::channel("800000000000000001"), member: who.clone(), id: "mpx:pay:-".into(), values: [("to", to), ("amount", amount)].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), members: vec![kai_m.clone(), rowan_m.clone(), Member { bot: true, ..member("900000000000000777", "Robot") }], at_ms: NOW, ..Default::default() };
        card_text(&bot.on_form(&ev, &|_| None, &mut |lo, _| lo).remove(0))
    };

    // Kai's wallet came from Good Boy 3 with 1,840 coins
    let a = run(cmd(&kai_m, "balance", None, NOW));
    let text = card_text(&a);
    assert!(text.contains("**Wallet** **1,840** 🪙  ·  **Rank** #1") && text.contains("**Next daily** ✅ Ready now"), "{text}");
    let Action::Reply { card } = &a else { unreachable!() };
    assert!(card.private, "balances are private by default");
    assert_eq!(card.buttons.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(), vec![format!("econ:daily:{kai}"), format!("econ:top:{kai}"), format!("mpx:pay:{kai}:-")]);

    // daily: day 1 gives the base (250), and a second claim is too early
    assert!(card_text(&run(cmd(&kai_m, "daily", None, NOW))).contains("🔥 Day 1 streak\nYou got **250** 🪙"));
    assert!(card_text(&run(cmd(&kai_m, "daily", None, NOW + HOUR))).contains("⏳ You already claimed."));
    assert_eq!(bot.db.get().wallet(g, kai, None, 0).unwrap().coins, 2090);
    // the next day the streak grows: 250 x 1.05 = 263 (rounded as Good Boy 3 rounds)
    assert!(card_text(&run(cmd(&kai_m, "daily", None, NOW + 21 * HOUR))).contains("Day 2 streak\nYou got **263** 🪙"));

    // work: the lowest payout is 50, then a wait
    let text = card_text(&run(cmd(&kai_m, "work", None, NOW)));
    assert!(text.contains("🐕 You walked 2 dogs around the park and earned **50** 🪙."), "{text}");
    assert!(card_text(&run(cmd(&kai_m, "work", None, NOW + 59 * 60_000))).contains("😴 You're tired."));
    // a Work boost bought in Good Boy 3's shop still counts: +50%
    bot.db.get().data_set(g, "economy", &format!("boost:workboost:{kai}"), &json!(NOW + 10 * HOUR)).unwrap();
    assert!(card_text(&run(cmd(&kai_m, "work", None, NOW + 61 * 60_000))).contains("earned **50** 🪙 + **25** 🪙 (💼 work boost: +50%)"));
    let kai_coins = bot.db.get().wallet(g, kai, None, 0).unwrap().coins;
    assert_eq!(kai_coins, 2090 + 263 + 50 + 75);

    // /pay opens Good Boy 3's private message first, then the form
    let intro = run(cmd(&kai_m, "pay", None, NOW));
    assert!(card_text(&intro).contains("Pick who to pay and how much in the form."));
    let Action::Reply { card } = &intro else { unreachable!() };
    assert_eq!(card.buttons.iter().map(|b| (b.id.as_str(), b.label.as_str())).collect::<Vec<_>>(), vec![(format!("mpx:pay:{kai}:-").as_str(), "Configure payment")]);
    // Rowan is new to money, so starts with the server's 500
    let text = pay(&kai_m, rowan, "1k");
    assert!(text.contains(&format!("💸 <@{kai}> paid <@{rowan}> **1,000** 🪙")), "{text}");
    assert_eq!(bot.db.get().wallet(g, rowan, None, 0).unwrap().coins, 1500);
    assert_eq!(bot.db.get().wallet(g, kai, None, 0).unwrap().coins, kai_coins - 1000);
    // what cannot be paid, in Good Boy 3's words
    assert!(pay(&rowan_m, kai, "1501").contains("You only have **1,500** 🪙."));
    assert!(pay(&rowan_m, rowan, "5").contains("You cannot pay yourself."));
    assert!(pay(&rowan_m, "900000000000000777", "5").contains("Bots do not need coins."));
    assert!(pay(&rowan_m, kai, "lots").contains("Type a whole number"));
    assert!(pay(&rowan_m, "", "5").contains("Pick who to pay."));
    assert_eq!(bot.db.get().wallet(g, rowan, None, 0).unwrap().coins, 1500, "nothing moved");
    // "all" empties the wallet and no more
    pay(&rowan_m, kai, "all");
    assert_eq!(bot.db.get().wallet(g, rowan, None, 0).unwrap().coins, 0);
    assert!(pay(&rowan_m, kai, "1").contains("You only have **0** 🪙."));

    // the live leaderboard: Kai first, pages, the board picker
    let text = card_text(&run(cmd(&rowan_m, "top", None, NOW)));
    assert!(text.contains("🪙 Richest · ") && text.contains(&format!("🥇 <@{kai}> · **")) && text.contains("page 1 of 1 · live"), "{text}");
    // right-click > View wallet: someone else's wallet, no buttons
    let Action::Reply { card } = run(cmd(&rowan_m, "View wallet", Some(&kai_m), NOW)) else { unreachable!() };
    assert!(card.buttons.is_empty() && card.private);

    // buttons do the same things, privately
    let press = |id: &str, who: &Member, at: i64| ButtonEvent { guild: g.into(), place: Place::channel("800000000000000001"), member: who.clone(), id: id.into(), at_ms: at, ..Default::default() };
    let a = bot.on_button(&press(&format!("econ:daily:{rowan}"), &rowan_m, NOW), &|_| None, &mut |lo, _| lo).remove(0);
    assert!(card_text(&a).contains("Day 1 streak"));
    assert!(matches!(&a, Action::Reply { card } if card.private));
    assert!(card_text(&bot.on_button(&press(&format!("econ:top:{rowan}"), &rowan_m, NOW), &|_| None, &mut |lo, _| lo).remove(0)).contains("Richest"));
    assert!(card_text(&bot.on_button(&press("shop:old", &rowan_m, NOW), &|_| None, &mut |lo, _| lo).remove(0)).contains("older message"));
    // the "View rank" button on a level-up card
    assert!(card_text(&bot.on_button(&press(&format!("rank:{kai}"), &rowan_m, NOW), &|id| (id == kai).then(|| "Kai".to_string()), &mut |lo, _| lo).remove(0)).contains("**Kai**"));

    // every coin that moved is in the ledger, as in Good Boy 3
    assert!(bot.db.get().count("economy_ledger").unwrap() >= 8);
    // money turned off in this server
    bot.db.get().set_module_enabled(g, "economy", false).unwrap();
    assert!(card_text(&run(cmd(&kai_m, "daily", None, NOW + 100 * HOUR))).contains("Money is turned off in this server"));
}

#[test]
fn a_fresh_v4_install_gets_wallets_too() {
    let tmp = tempfile::tempdir().unwrap();
    let bot = Bot::new(Store::create(tmp.path().join("eclipse.db")).unwrap());
    let g = "900000000000000900";
    bot.on_server(g, "New server");
    let ev = CommandEvent { guild: g.into(), place: Place::channel("1"), member: member("900000000000000001", "Tess"), name: "daily".into(), at_ms: NOW, from_form: true, ..Default::default() };
    assert!(card_text(&bot.on_command(&ev, &|_| None, &mut |lo, _| lo).remove(0)).contains("You got **250** 🪙"));
    assert_eq!(bot.db.get().wallet(g, "900000000000000001", None, 0).unwrap().coins, 750, "500 to start with, plus the daily");
    // starting a second time on the same database changes nothing
    drop(bot);
    let again = Bot::new(Store::open(tmp.path().join("eclipse.db")).unwrap());
    assert_eq!(again.db.get().wallet(g, "900000000000000001", None, 0).unwrap().coins, 750);
}
