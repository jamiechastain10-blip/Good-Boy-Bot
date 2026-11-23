//! v4 has to be ready for big servers. This fills a real Good Boy 3 database with thousands of members and
//! checks that the leaderboard stays correct and fast, because the database keeps members in XP order.

use gb_data::{import_3x, Store};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

fn make_3x(dir: &Path) -> serde_json::Value {
    let script: PathBuf = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/make-3x-data.mjs");
    let out = Command::new("node").arg("--disable-warning=ExperimentalWarning").arg(script).arg(dir).output().expect("node is needed");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(out.stdout.split(|b| *b == b'\n').rfind(|l| l.starts_with(b"{")).unwrap()).unwrap()
}
/// A spread of XP values that is the same every run (no random numbers, so a failure can be repeated).
fn xp_for(n: u64) -> i64 {
    ((n.wrapping_mul(2654435761) >> 7) % 250_000) as i64
}

#[test]
fn leaderboards_stay_correct_and_fast_with_tens_of_thousands_of_members() {
    let tmp = tempfile::tempdir().unwrap();
    let old = tmp.path().join("gb3");
    make_3x(&old);
    let new = tmp.path().join("gb4");
    import_3x(&old, &new).unwrap();
    let db = Store::open(new.join("eclipse.db")).unwrap();

    // two servers: one with 6,000 members and one with 60,000
    for (guild, members) in [("700000000000000001", 6_000u64), ("700000000000000002", 60_000u64)] {
        db.batch(|s| {
            for n in 0..members {
                s.data_set(guild, "community", &format!("user:{}", 800_000_000_000_000_000u64 + n), &json!({ "xp": xp_for(n), "messages": n % 500, "rep": 0, "lastXp": 0, "lastRep": 0 }))?;
            }
            Ok(())
        })
        .unwrap();
    }
    assert!(db.explain_top_xp().unwrap().contains("v4_idx_xp"), "the leaderboard reads members in XP order from the index: {}", db.explain_top_xp().unwrap());

    for (guild, members) in [("700000000000000001", 6_000u64), ("700000000000000002", 60_000u64)] {
        // the slow way, the way Good Boy 3 does it: read everyone, then sort
        let t = Instant::now();
        let mut everyone: Vec<(String, i64)> = db.data_list(guild, "community", "user:", usize::MAX >> 1).unwrap().into_iter().map(|(k, v)| (k[5..].to_string(), v["xp"].as_i64().unwrap())).collect();
        everyone.sort_by_key(|(_, xp)| std::cmp::Reverse(*xp));
        let slow = t.elapsed();
        assert_eq!(everyone.len() as u64, members);

        let t = Instant::now();
        let top = db.top_xp(guild, 10).unwrap();
        let fast = t.elapsed();
        assert_eq!(top.iter().map(|(_, xp)| *xp).collect::<Vec<_>>(), everyone[..10].iter().map(|(_, xp)| *xp).collect::<Vec<_>>(), "the same top 10");

        // someone in the middle of the board
        let (someone, their_xp) = everyone[everyone.len() / 2].clone();
        let t = Instant::now();
        let (rank, total) = db.xp_rank(guild, &someone).unwrap().unwrap();
        let rank_time = t.elapsed();
        assert_eq!(total as u64, members);
        assert_eq!(rank, everyone.iter().filter(|(_, xp)| *xp > their_xp).count() + 1, "their place counts everyone with more XP");
        assert_eq!(db.xp_rank(guild, "nobody").unwrap(), None);

        println!("{members} members: read-everyone {slow:?}, top 10 {fast:?}, one member's rank {rank_time:?}");
        assert!(fast.as_millis() < 50, "top 10 of {members} took {fast:?}");
        assert!(rank_time.as_millis() < 100, "a rank among {members} took {rank_time:?}");
    }
    // a member's XP changing moves them on the board straight away
    let g = "700000000000000001";
    db.data_set(g, "community", "user:newcomer", &json!({ "xp": 999_999, "messages": 1 })).unwrap();
    assert_eq!(db.top_xp(g, 1).unwrap(), vec![("newcomer".to_string(), 999_999)]);
    assert_eq!(db.xp_rank(g, "newcomer").unwrap(), Some((1, 6_001)));
    db.integrity_ok().unwrap();
}
