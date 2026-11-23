//! The promise v4 makes: a database written by Good Boy 3's own code opens unchanged, every value reads back,
//! and importing copies it without touching the original.
//!
//! The 3.x data is made by `fixtures/make-3x-data.mjs`, which runs the real Good Boy 3 modules (needs Node 22+).

use gb_data::{find_3x_data, import_3x, level_of, DataError, Store};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

fn workspace() -> PathBuf {
    // not canonicalize(): on Windows that gives a \\\\?\\ path Node cannot open
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Runs Good Boy 3's code to write a data folder. Returns what it wrote.
fn make_3x(dir: &Path) -> Value {
    let out = Command::new("node")
        .arg("--disable-warning=ExperimentalWarning")
        .arg(workspace().join("fixtures/make-3x-data.mjs"))
        .arg(dir)
        .output()
        .expect("node is needed to make Good Boy 3 test data");
    assert!(out.status.success(), "the Good Boy 3 fixture failed: {}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(out.stdout.split(|b| *b == b'\n').rfind(|l| l.starts_with(b"{")).expect("fixture output")).unwrap()
}

#[test]
fn a_good_boy_3_database_opens_and_every_value_reads_back() {
    let tmp = tempfile::tempdir().unwrap();
    let old = tmp.path().join("Good Boy").join("bot-data");
    let wrote = make_3x(&old);
    let (g, kai, rowan, dj) = (wrote["guild"].as_str().unwrap(), wrote["kai"].as_str().unwrap(), wrote["rowan"].as_str().unwrap(), wrote["dj"].as_str().unwrap());

    let db = Store::open_read_only(old.join("eclipse.db")).unwrap();
    db.integrity_ok().unwrap();
    assert_eq!(db.schema_version().unwrap(), gb_data::KNOWN_3X_SCHEMA);
    // the server and its modules
    let guilds = db.guilds().unwrap();
    assert_eq!(guilds.len(), 1);
    assert_eq!((guilds[0].id.as_str(), guilds[0].name.as_str()), (g, "BoxBoyz"));
    assert!(db.module_enabled(g, "music").unwrap() && db.module_enabled(g, "community").unwrap());
    assert!(!db.module_enabled(g, "moderation").unwrap(), "a module nobody turned on is off");
    // settings, with their types
    assert_eq!(db.config_get(g, "music", "volume").unwrap(), Some(json!(35)));
    assert_eq!(db.config_get(g, "music", "stations").unwrap(), Some(json!(["Lofi | https://radio.example/lofi"])));
    assert_eq!(db.config_get(g, "music", "never-set").unwrap(), None);
    assert_eq!(db.config_all(g, "music").unwrap().len(), 2);
    // levels: the same XP gives the same level as Good Boy 3 worked out
    assert_eq!(db.xp(g, kai).unwrap(), 12345);
    assert_eq!(db.xp(g, "nobody").unwrap(), 0);
    for (who, key) in [(kai, "kaiLevel"), (rowan, "rowanLevel")] {
        let mine = level_of(db.xp(g, who).unwrap());
        assert_eq!(json!({ "level": mine.level, "into": mine.into, "needed": mine.needed }), wrote[key], "level for {who}");
    }
    // records by prefix, in order, with keys matched literally
    let users = db.data_list(g, "community", "user:", 100).unwrap();
    assert_eq!(users.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), vec![format!("user:{kai}"), format!("user:{rowan}")]);
    assert_eq!(db.data_list(g, "community", "odd_key%", 100).unwrap().len(), 1);
    assert_eq!(db.data_list(g, "community", "odd%key", 100).unwrap().len(), 0, "% in a prefix is not a wildcard");
    // coins, a playlist, and who may DJ
    assert_eq!(db.coins(g, kai).unwrap(), Some(1840));
    assert_eq!(db.coins(g, rowan).unwrap(), None);
    let playlist = db.data_get(g, "music", "pl:abc12345").unwrap().unwrap();
    assert_eq!(playlist["name"], "Late night vibes");
    assert_eq!(playlist["tracks"][0]["title"], "Midnight Drive");
    assert_eq!(db.perm_roles(g, "music.dj").unwrap(), vec![dj.to_string()]);
    let summary = db.summary().unwrap();
    assert_eq!((summary.servers, summary.modules_on), (1, 3));
    assert!(summary.tables.iter().any(|(t, n)| t == "economy_wallets" && *n == 1));
}

#[test]
fn importing_copies_everything_and_never_touches_the_original() {
    let tmp = tempfile::tempdir().unwrap();
    let app_data = tmp.path().join("AppData");
    let old = app_data.join("Good Boy").join("bot-data");
    let wrote = make_3x(&old);
    let g = wrote["guild"].as_str().unwrap();
    let before = std::fs::read(old.join("eclipse.db")).unwrap();

    // the launcher finds it by itself
    assert_eq!(find_3x_data(&app_data), vec![old.clone()]);
    assert!(find_3x_data(&tmp.path().join("nowhere")).is_empty());

    let new = tmp.path().join("Good Boy 4").join("data");
    let report = import_3x(&old, &new).unwrap();
    assert!(!report.already_there);
    assert_eq!((report.summary.servers, report.summary.modules_on), (1, 3));
    assert_eq!(report.files, 1, "the owner's own art came too");
    assert!(new.join("art/rp/boop/mine.gif").is_file());
    assert!(!new.join("eclipse.db.importing").exists());

    // v4 can use the copy: read what 3.x wrote, and write to it
    let db = Store::open(new.join("eclipse.db")).unwrap();
    db.integrity_ok().unwrap();
    assert_eq!(db.xp(g, wrote["kai"].as_str().unwrap()).unwrap(), 12345);
    db.config_set(g, "music", "volume", &json!(80)).unwrap();
    db.data_set(g, "music", "pl:new", &json!({ "id": "new", "name": "Made in v4", "tracks": [] })).unwrap();
    assert_eq!(db.config_get(g, "music", "volume").unwrap(), Some(json!(80)));
    db.data_delete(g, "music", "pl:new").unwrap();
    assert_eq!(db.data_get(g, "music", "pl:new").unwrap(), None);
    drop(db);

    // the Good Boy 3 data is byte-for-byte what it was, and still says 35
    assert_eq!(std::fs::read(old.join("eclipse.db")).unwrap(), before);
    assert_eq!(Store::open_read_only(old.join("eclipse.db")).unwrap().config_get(g, "music", "volume").unwrap(), Some(json!(35)));

    // importing again never overwrites what v4 now has
    let again = import_3x(&old, &new).unwrap();
    assert!(again.already_there);
    assert_eq!(Store::open_read_only(new.join("eclipse.db")).unwrap().config_get(g, "music", "volume").unwrap(), Some(json!(80)));
}

#[test]
fn files_that_are_not_good_boy_databases_are_refused_with_a_plain_reason() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(matches!(Store::open_read_only(tmp.path().join("eclipse.db")), Err(DataError::Missing(_))));
    // some other program's database
    let other = tmp.path().join("other.db");
    rusqlite::Connection::open(&other).unwrap().execute_batch("CREATE TABLE notes (t TEXT);").unwrap();
    assert!(matches!(Store::open_read_only(&other), Err(DataError::NotGoodBoy(_))));
    // not a database at all
    let junk = tmp.path().join("junk.db");
    std::fs::write(&junk, b"this is not a database, just some text that is long enough to look at").unwrap();
    assert!(Store::open_read_only(&junk).is_err());
    // a database from a Good Boy newer than this one understands
    let future = tmp.path().join("future.db");
    rusqlite::Connection::open(&future)
        .unwrap()
        .execute_batch("CREATE TABLE module_config (guild_id TEXT, module TEXT, key TEXT, value TEXT); CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO schema_meta VALUES ('version', '99');")
        .unwrap();
    let err = Store::open_read_only(&future).err().unwrap();
    assert!(matches!(err, DataError::TooNew { found: 99, .. }));
    assert!(err.to_string().contains("Update Good Boy first"));
}

#[test]
fn a_brand_new_v4_database_is_one_good_boy_3_can_open_too() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("fresh");
    let g = "900000000000000900";
    {
        let db = Store::create(dir.join("eclipse.db")).unwrap();
        db.integrity_ok().unwrap();
        assert_eq!(db.schema_version().unwrap(), gb_data::KNOWN_3X_SCHEMA);
        assert_eq!(db.summary().unwrap().servers, 0);
        db.upsert_guild(g, "New server").unwrap();
        db.default_module(g, "community", true).unwrap();
        db.default_module(g, "community", false).unwrap(); // a choice already recorded is kept
        assert!(db.module_enabled(g, "community").unwrap());
        db.data_set(g, "community", "user:1", &json!({ "xp": 100, "messages": 3 })).unwrap();
        db.config_set(g, "music", "volume", &json!(55)).unwrap();
        // existing data is never replaced
        assert!(Store::create(dir.join("eclipse.db")).is_err());
    }
    // Good Boy 3's own code opens it (its start-up checks pass) and reads what v4 wrote
    let out = Command::new("node").arg("--disable-warning=ExperimentalWarning").arg(workspace().join("fixtures/read-3x.mjs")).arg(&dir).arg(g).arg("1").output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let back: Value = serde_json::from_slice(out.stdout.split(|b| *b == b'\n').rfind(|l| l.starts_with(b"{")).unwrap()).unwrap();
    assert_eq!(back["rec"]["xp"], 100);
    assert_eq!(back["level"]["level"], 1);
    assert_eq!(back["volume"], 55);
}
