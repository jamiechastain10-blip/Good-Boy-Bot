//! Good Boy 3's ticket rules (src/tickets.js) asked the same questions as Good Boy 4's, and the answers compared.

use gb_core::ticketrules as T;
use gb_core::FieldKind;
use gb_data::support::{HistoryRow, WatchEntry};
use serde_json::{json, Value};
use std::path::Path;
use std::process::Command;

fn good_boy_3(ask: &Value) -> Value {
    let tmp = tempfile::tempdir().unwrap();
    let file = tmp.path().join("ask.json");
    std::fs::write(&file, ask.to_string()).unwrap();
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/rules-3x.mjs");
    let out = Command::new("node").arg("--disable-warning=ExperimentalWarning").arg(script).arg(&file).output().expect("node is needed");
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(out.stdout.split(|b| *b == b'\n').rfind(|l| l.starts_with(b"{")).unwrap()).unwrap()
}
fn entry(id: i64, tid: Option<&str>, name: Option<&str>, alias: Option<&str>, status: &str) -> WatchEntry {
    WatchEntry { id, target_id: tid.map(str::to_string), target_name: name.map(str::to_string), target_alias: alias.map(str::to_string), reporter_id: "9".into(), status: status.into(), created_at: 1, ..Default::default() }
}
fn res(r: Result<(Option<String>, Option<String>), String>) -> Value {
    match r { Ok((id, name)) => json!({ "ok": { "id": id, "name": name } }), Err(e) => json!({ "err": e }) }
}

#[test]
fn ticket_rules_give_the_same_answers_as_good_boy_3() {
    let names = ["  @CoolGuy#1234 ", "bob#0", "Ünïcode Name", "@@x", "name#12345", "a".repeat(50).as_str()].map(String::from);
    let parsed: Vec<(Option<&str>, Option<&str>, bool)> = vec![(Some("Bob"), None, false), (None, Some("123456789012345678"), true), (None, Some("<@!123456789012345678>"), false), (None, Some("12345"), false), (None, None, true), (Some(""), Some(""), false)];
    let from: Vec<(Option<&str>, Option<&str>, bool)> = vec![(Some("123456789012345678"), None, true), (None, Some("coolguy123"), true), (None, Some("123"), false), (None, Some("<@123456789012345678>"), false), (None, None, true), (None, Some(""), false)];
    let now = 1_800_000_000_000i64;
    let ages = [(now - 2 * 365 * 86_400_000, now), (now - 40 * 86_400_000, now), (now - 3 * 86_400_000, now), (now - 60_000, now), (now - 3 * 3_600_000, now), (now + 5, now)];
    let texts = ["id 123456789012345678 and <@987654321098765432>", "no ids 1234", "1234567890123456789012 too long", "123456789012345678123456789012345678"];
    let entries = vec![
        entry(1, Some("111111111111111111"), Some("badguy"), None, "open"),
        entry(2, None, Some("bob"), Some("bobby"), "confirmed"),
        entry(3, Some("222222222222222222"), Some("al"), None, "unfounded"),
        entry(4, Some("111111111111111111"), Some("badguy"), None, "confirmed"),
        entry(5, None, Some("ünïcode"), None, "open"),
    ];
    let entries_json: Vec<Value> = entries.iter().map(|e| json!({ "id": e.id, "target_id": e.target_id, "target_name": e.target_name, "target_alias": e.target_alias, "status": e.status })).collect();
    let matches = vec![
        json!({ "openerId": "111111111111111111", "openerNames": [], "reported": {}, "text": "" }),
        json!({ "openerId": "5", "openerNames": ["Bob"], "reported": {}, "text": "hello" }),
        json!({ "openerId": "5", "openerNames": [], "reported": { "id": null, "name": "bobby" }, "text": "" }),
        json!({ "openerId": "5", "openerNames": [], "reported": {}, "text": "it was bob. then bob.smith and al and Bob_x and (bob)" }),
        json!({ "openerId": "5", "openerNames": [], "reported": { "id": "222222222222222222" }, "text": "see 111111111111111111" }),
        json!({ "openerId": "5", "openerNames": [], "reported": {}, "text": "Ünïcode was rude" }),
        json!({ "openerId": "5", "openerNames": [], "reported": {}, "text": "bobsled and abob" }),
    ];
    let close = vec![json!({ "resolution": "Resolved", "reason": "x", "action": "None", "notes": "n" }), json!({ "resolution": " ", "reason": "x" }), json!({ "resolution": "r", "reason": "why", "action": "a", "notes": "n", "followup": "later" })];
    let history = vec![
        json!({ "number": 1, "opener_id": "1", "category": "report", "opened_at": now - 86_400_000, "first_response_at": now - 86_000_000, "closed_at": now - 80_000_000, "close_kind": "staff" }),
        json!({ "number": 2, "opener_id": "2", "category": "bot", "opened_at": now - 2 * 86_400_000, "first_response_at": null, "closed_at": now - 86_400_000, "close_kind": "auto" }),
        json!({ "number": 3, "opener_id": "3", "category": "report", "opened_at": now - 40 * 86_400_000, "first_response_at": null, "closed_at": null, "close_kind": null }),
        json!({ "number": 4, "opener_id": "3", "category": "other", "opened_at": now - 3_600_000, "first_response_at": now - 3_599_999, "closed_at": now - 1_000, "close_kind": "no-notes" }),
    ];
    let custom = json!([{ "id": "own", "label": "Event help", "emoji": "🎉", "questions": ["What event is it about, in a few words please", "When", "Where", "Who", "Extra"] }]);
    let ratings = vec![json!({ "stars": 5, "at": now - 1000 }), json!({ "stars": 2, "at": now - 2000 }), json!({ "stars": 4, "at": now - 40 * 86_400_000 })];

    let theirs = good_boy_3(&json!({ "tickets": { "names": names, "parsed": parsed, "from": from, "ages": ages, "texts": texts, "entries": entries_json, "matches": matches, "close": close, "history": history, "now": now, "custom": custom, "ratings": ratings } }))["tickets"].clone();

    assert_eq!(json!(names.iter().map(|n| T::normalize_name(n)).collect::<Vec<_>>()), theirs["names"]);
    assert_eq!(json!(parsed.iter().map(|(u, id, req)| res(T::parse_reported(*u, *id, *req))).collect::<Vec<_>>()), theirs["parsed"]);
    assert_eq!(json!(from.iter().map(|(w, o, req)| res(T::reported_from(*w, *o, *req))).collect::<Vec<_>>()), theirs["from"]);
    assert_eq!(json!(ages.iter().map(|(ms, n)| T::age_text(*ms, *n)).collect::<Vec<_>>()), theirs["ages"]);
    assert_eq!(json!(texts.iter().map(|t| T::ids_in(t)).collect::<Vec<_>>()), theirs["ids"]);
    for (k, m) in matches.iter().enumerate() {
        let names: Vec<String> = m["openerNames"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let mine = T::match_watch(m["openerId"].as_str().unwrap(), &names, (m["reported"]["id"].as_str(), m["reported"]["name"].as_str()), m["text"].as_str().unwrap(), &entries);
        assert_eq!(json!(mine.iter().map(|(id, how, exact)| json!([id, how, exact])).collect::<Vec<_>>()), theirs["matches"][k], "match {k}: {m}");
        let described = (!mine.is_empty()).then(|| T::describe_matches(&mine, &entries));
        assert_eq!(json!(described), theirs["described"][k], "described {k}");
    }
    for (k, v) in close.iter().enumerate() {
        let values = v.as_object().unwrap().iter().map(|(a, b)| (a.clone(), b.as_str().unwrap().to_string())).collect();
        let mine = match T::read_close_form(&values) { Ok(m) => json!({ "ok": m }), Err(e) => json!({ "err": e }) };
        assert_eq!(mine, theirs["close"][k], "close {k}");
    }
    let rows: Vec<HistoryRow> = history.iter().map(|h| HistoryRow { number: h["number"].as_i64().unwrap(), opener_id: h["opener_id"].as_str().unwrap().into(), category: h["category"].as_str().unwrap().into(), opened_at: h["opened_at"].as_i64().unwrap(), first_response_at: h["first_response_at"].as_i64(), closed_at: h["closed_at"].as_i64(), close_kind: h["close_kind"].as_str().map(str::to_string), ..Default::default() }).collect();
    let s = T::summarize(&rows, now, 30);
    let ts = &theirs["summary"];
    assert_eq!((json!(s.total), json!(s.avg_first_response_ms), json!(s.avg_resolution_ms), json!(s.without_notes), json!(s.auto_closed)), (ts["total"].clone(), ts["avgFirstResponseMs"].clone(), ts["avgResolutionMs"].clone(), ts["withoutNotes"].clone(), ts["autoClosed"].clone()));
    assert_eq!(json!(s.by_category.iter().map(|(c, n)| (c.clone(), json!(n))).collect::<serde_json::Map<String, Value>>()), ts["byCategory"]);
    // the popups for every category, and a server's own type
    let mut cats = T::built_in();
    cats.push(T::find_category("own", &custom).unwrap());
    let kind = |f: &gb_core::Field| match &f.kind { FieldKind::Text if f.long => "paragraph", FieldKind::Text => "text", FieldKind::User { .. } => "user", FieldKind::Files { .. } => "files", _ => "?" };
    let mine: Vec<Vec<Value>> = cats.iter().map(|c| T::questions_for(c).iter().map(|q| json!([q.id, kind(q), q.label, q.desc, q.required, if q.max == 0 { Value::Null } else { json!(q.max) }, q.placeholder])).collect()).collect();
    assert_eq!(json!(mine), theirs["questions"]);
    let (n, avg) = T::rating_summary(&ratings.iter().map(|r| (r["stars"].as_i64().unwrap(), r["at"].as_i64().unwrap())).collect::<Vec<_>>(), now, 30);
    assert_eq!(json!({ "count": n, "avg": avg }), theirs["ratings"]);
}

#[test]
fn transcripts_are_the_same_files_as_good_boy_3s() {
    use gb_core::tickets::{transcript_file, TranscriptMsg};
    let msgs = vec![
        TranscriptMsg { at_ms: 1_800_000_000_000, author_tag: "kai".into(), avatar: Some("https://cdn.discordapp.com/avatars/1/a.png".into()), content: "hello <there> & \"you\"".into(), files: vec![("shot.png".into(), "https://cdn.discordapp.com/attachments/1/2/shot.png".into())], boxes: vec![] },
        TranscriptMsg { at_ms: 1_800_000_060_000, author_tag: "Good Boy".into(), avatar: None, content: String::new(), files: vec![], boxes: vec!["Ticket #001 · Report\nOpened by kai".into()] },
    ];
    let summary = vec![("Type".to_string(), "Report a member".to_string()), ("What happened?".to_string(), "spam\nlots".to_string())];
    let ask = json!({ "transcripts": {
        "ticket": { "number": 1, "typeLabel": "Report a member", "openerTag": "kai" }, "guild": "Ghost Town", "summary": summary.iter().map(|(l, v)| json!({ "label": l, "value": v })).collect::<Vec<_>>(),
        "messages": msgs.iter().map(|m| json!({ "at": m.at_ms, "tag": m.author_tag, "avatar": m.avatar, "content": m.content, "files": m.files, "boxes": m.boxes })).collect::<Vec<_>>(),
    } });
    let theirs = good_boy_3(&ask)["transcripts"].clone();
    for format in ["txt", "html"] {
        let head = gb_core::TranscriptHead { number: 1, type_label: "Report a member".into(), opener_tag: "kai".into(), guild_name: "Ghost Town".into(), summary: summary.clone(), format: format.into() };
        let (name, data) = transcript_file(&head, &msgs);
        assert_eq!(json!(name), theirs[format]["name"], "{format}");
        assert_eq!(String::from_utf8(data).unwrap(), theirs[format]["data"].as_str().unwrap(), "{format}");
    }
}
