//! A Discord look-alike in the browser that runs the real bot: `cargo run -p gb-core --example emulator -- 8787`.
//! Every command, button, dropdown and popup goes through the same code the bot runs on Discord, and the cards and
//! pictures shown are exactly what the bot would send. Nothing here talks to Discord; it is for looking and trying.

use gb_core::{Action, Bot, ButtonEvent, Card, CommandEvent, FieldKind, FormEvent, Member, Place};
use gb_data::Store;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;

const G: &str = "700000000000000001";
const CH: &str = "800000000000000001";
const ME: &str = "900000000000000001";

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
fn base64(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(b.len().div_ceil(3) * 4);
    for chunk in b.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for k in 0..4 { out.push(if k <= chunk.len() { T[(n >> (18 - 6 * k) & 63) as usize] as char } else { '=' }); }
    }
    out
}
fn card_json(card: &Card) -> Value {
    let files: Vec<Value> = card.files.iter().map(|f| json!({ "name": f.name, "data": base64(&f.data) })).collect();
    json!({ "discord": card.to_discord().unwrap_or(Value::Null), "files": files, "private": card.private })
}
fn action_json(a: &Action) -> Value {
    match a {
        Action::Reply { card } => json!({ "t": "reply", "card": card_json(card) }),
        Action::Update { card } => json!({ "t": "update", "card": card_json(card) }),
        Action::FollowUp { card } => json!({ "t": "followup", "card": card_json(card) }),
        Action::Send { channel, card, .. } => json!({ "t": "send", "channel": channel, "card": card_json(card) }),
        Action::Dm { card, .. } => json!({ "t": "dm", "card": card_json(card) }),
        Action::BiteWatch { id, after_ms } => json!({ "t": "bite", "id": id, "after": after_ms }),
        Action::Form { id, title, fields } => json!({ "t": "form", "id": id, "title": title, "fields": fields.iter().map(|f| {
            let (kind, options) = match &f.kind {
                FieldKind::Select(o) => ("select", o.iter().map(|(l, v)| json!([l, v])).collect::<Vec<_>>()),
                FieldKind::Text => ("text", Vec::new()),
                _ => ("picker", Vec::new()),
            };
            json!({ "id": f.id, "label": f.label, "desc": f.desc, "kind": kind, "options": options, "hints": f.hints, "long": f.long, "required": f.required, "max": f.max, "placeholder": f.placeholder, "value": f.value })
        }).collect::<Vec<_>>() }),
        _ => json!({ "t": "other" }),
    }
}

fn main() {
    let port: u16 = std::env::args().nth(1).and_then(|p| p.parse().ok()).unwrap_or(8787);
    let dir = tempfile::tempdir().expect("a folder for the pretend server's data");
    let bot = Bot::new(Store::create(dir.path().join("emulator.db")).expect("a new database"));
    bot.on_server(G, "Ghost Town");
    for m in ["economy", "games", "community", "support"] { bot.db.get().set_module_enabled(G, m, true).expect("module on"); }
    bot.db.get().wallet(G, ME, Some("You"), 25_000).expect("a wallet");
    let me = Member { id: ME.into(), name: "You".into(), perms: gb_core::perms::ADMINISTRATOR, ..Default::default() };
    let mut seed = now_ms() as u64 | 1;
    let mut roll = move |lo: i64, hi: i64| -> i64 {
        seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
        if hi <= lo { lo } else { lo + (seed % ((hi - lo) as u64 + 1)) as i64 }
    };
    let listener = TcpListener::bind(("127.0.0.1", port)).expect("the port is free");
    println!("Good Boy game preview on http://localhost:{port} (close this window to stop it)");
    // double-clicked on Windows: open the page by itself
    #[cfg(windows)]
    { let _ = std::process::Command::new("cmd").args(["/C", "start", "", &format!("http://localhost:{port}")]).spawn(); }
    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let mut buf = Vec::new();
        let mut tmp = [0u8; 8192];
        let (mut head_end, mut need) = (None, 0usize);
        while let Ok(n) = stream.read(&mut tmp) {
            if n == 0 { break; }
            buf.extend_from_slice(&tmp[..n]);
            if head_end.is_none() {
                if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    head_end = Some(p + 4);
                    let head = String::from_utf8_lossy(&buf[..p]).to_lowercase();
                    need = head.lines().find_map(|l| l.strip_prefix("content-length:").and_then(|v| v.trim().parse().ok())).unwrap_or(0);
                }
            }
            if let Some(h) = head_end { if buf.len() >= h + need { break; } }
        }
        let Some(h) = head_end else { continue };
        let first = String::from_utf8_lossy(&buf[..h]).lines().next().unwrap_or("").to_string();
        let (kind, body): (&str, Vec<u8>) = if first.starts_with("POST /api") {
            let req: Value = serde_json::from_slice(&buf[h..]).unwrap_or(Value::Null);
            let now = now_ms();
            let s = |k: &str| req[k].as_str().unwrap_or("").to_string();
            let actions: Vec<Action> = match req["op"].as_str().unwrap_or("") {
                "command" => {
                    let args = req["args"].as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect()).unwrap_or_default();
                    let ev = CommandEvent { guild: G.into(), place: Place::channel(CH), member: me.clone(), name: s("name"), sub: req["sub"].as_str().map(str::to_string), args, at_ms: now, ..Default::default() };
                    bot.on_command(&ev, &|_| Some("You".into()), &mut roll)
                }
                "button" => {
                    let values = req["values"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
                    bot.on_button(&ButtonEvent { guild: G.into(), place: Place::channel(CH), member: me.clone(), id: s("id"), message: "m".into(), values, at_ms: now }, &|_| Some("You".into()), &mut roll)
                }
                "form" => {
                    let values = req["values"].as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect()).unwrap_or_default();
                    bot.on_form(&FormEvent { guild: G.into(), place: Place::channel(CH), member: me.clone(), id: s("id"), values, at_ms: now, ..Default::default() }, &|_| Some("You".into()), &mut roll)
                }
                "bite" => bot.fish_bite(G, &s("id"), now).map(|card| vec![Action::Update { card }]).unwrap_or_default(),
                _ => Vec::new(),
            };
            // a ticket's private channel is "made" here: the bot is told, and what it then posts in it is shown
            let mut shown: Vec<Action> = Vec::new();
            for a in actions {
                match a {
                    Action::OpenChannel { name, note, .. } => {
                        shown.push(Action::Send { channel: "tickets".into(), card: Card::new(gb_core::Area::General).line(format!("📁 A private channel **#{name}** was made for it. This is what the bot posts inside:")), ping: Vec::new(), roles: Vec::new() });
                        shown.extend(bot.on_channel_made(G, &note, "800000000000000777"));
                    }
                    other => shown.push(other),
                }
            }
            ("application/json", json!({ "actions": shown.iter().map(action_json).collect::<Vec<_>>() }).to_string().into_bytes())
        } else {
            ("text/html; charset=utf-8", include_str!("emulator.html").as_bytes().to_vec())
        };
        let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len()).as_bytes());
        let _ = stream.write_all(&body);
    }
}
