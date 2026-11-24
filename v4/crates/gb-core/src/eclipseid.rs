//! Good Boy 3's Eclipse ID: a member-controlled gaming profile (about me, favourite games, platforms, availability,
//! region, linked game account names), with who may see each part. Linked names are only checked for the right
//! shape for that platform: nothing here proves the member owns the account. One card per person, the same ID everywhere.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::{Action, Area, CommandEvent, Card, Db, Def, Field, FormEvent, Kind, Member};
use gb_data::eclipseid::Profile;
use serde_json::{json, Value};

pub const MODULE: &str = "eclipseid";
pub const USE: Perm = Perm { key: "eclipseid.use", level: Level::Everyone };
pub const STAFF: Perm = Perm { key: "eclipseid.staff", level: Level::Moderator(None) };
pub static SETTINGS: &[Def] = &[
    Def { key: "autoDetect", label: "Pick up the games and platforms members play from their Discord status (members can switch it off for themselves with /id auto)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "robloxLookup", label: "Let /id roblox check that a Roblox username exists (contacts Roblox)", kind: Kind::Toggle, default: Fallback::Bool(false) },
];
/// (id, label, most characters, who sees it at first)
pub const FIELDS: &[(&str, &str, usize, &str)] = &[
    ("bio", "About me", 300, "public"), ("games", "Favourite games", 200, "public"), ("platforms", "Platforms", 80, "public"),
    ("availability", "Play style and availability", 120, "public"), ("region", "Region or timezone", 40, "public"), ("links", "Linked game accounts", 0, "private"),
    ("seen", "Games and platforms picked up automatically", 0, "public"),
];
pub const PLATFORMS: &[&str] = &["pc", "playstation", "xbox", "switch", "mobile", "vr"];
/// (id, label, what it should look like)
pub const LINKS: &[(&str, &str, &str)] = &[
    ("steam", "Steam", "profile name (vanity) or 17-digit Steam ID"), ("xbox", "Xbox", "gamertag"), ("playstation", "PlayStation", "PSN ID"),
    ("nintendo", "Nintendo Switch", "friend code like SW-1234-5678-9012"), ("epic", "Epic Games", "display name"), ("riot", "Riot ID", "Name#TAG"),
    ("battlenet", "Battle.net", "BattleTag like Name#1234"), ("roblox", "Roblox", "username"), ("minecraft", "Minecraft (Java)", "username"),
];
const FIELD_CHOICES: &[(&str, &str)] = &[("About me", "bio"), ("Favourite games", "games"), ("Platforms", "platforms"), ("Play style and availability", "availability"), ("Picked up automatically", "seen"), ("Region or timezone", "region"), ("Linked game accounts", "links")];
const SHARE_CHOICES: &[(&str, &str)] = &[("Show my card in this server", "here"), ("Hide my card in this server", "hide"), ("Show my card in every server", "all"), ("Hide my card in every server", "none")];
const WHO: &[(&str, &str)] = &[("everyone in the server", "public"), ("staff only", "staff"), ("only me", "private")];
const LINK_CHOICES: &[(&str, &str)] = &[("Steam", "steam"), ("Xbox", "xbox"), ("PlayStation", "playstation"), ("Nintendo Switch", "nintendo"), ("Epic Games", "epic"), ("Riot ID", "riot"), ("Battle.net", "battlenet"), ("Roblox", "roblox"), ("Minecraft (Java)", "minecraft")];
pub const COMMANDS: &[CommandSpec] = &[CommandSpec { name: "id", about: "Your Eclipse ID gaming profile", module: MODULE, options: &[], subs: &[
    Sub { name: "show", about: "Show a card", options: &[Opt { name: "member", about: "Whose", takes: Takes::Member, required: false }] },
    Sub { name: "edit", about: "Fill in your card", options: &[] },
    Sub { name: "privacy", about: "Who can see a part of your card", options: &[
        Opt { name: "field", about: "Which part", takes: Takes::Choice(FIELD_CHOICES), required: true },
        Opt { name: "who", about: "Who", takes: Takes::Choice(WHO), required: true },
        Opt { name: "platform", about: "For linked accounts: just this one", takes: Takes::Choice(LINK_CHOICES), required: false },
    ] },
    Sub { name: "link", about: "Add a game account name (not verified)", options: &[
        Opt { name: "platform", about: "Which game or platform", takes: Takes::Choice(LINK_CHOICES), required: true },
        Opt { name: "name", about: "Your name there", takes: Takes::Text, required: true },
        Opt { name: "who", about: "Who can see it (default: only me)", takes: Takes::Choice(WHO), required: false },
    ] },
    Sub { name: "unlink", about: "Remove a game account", options: &[Opt { name: "platform", about: "Which one", takes: Takes::Choice(LINK_CHOICES), required: true }] },
    Sub { name: "roblox", about: "Check that a Roblox username exists", options: &[Opt { name: "name", about: "Username", takes: Takes::Text, required: true }] },
    Sub { name: "share", about: "Choose which servers can see your card", options: &[Opt { name: "where", about: "Where", takes: Takes::Choice(SHARE_CHOICES), required: true }] },
    Sub { name: "auto", about: "Let Good Boy pick up what you play from your Discord status, or stop it", options: &[Opt { name: "mode", about: "What to do", takes: Takes::Choice(AUTO_CHOICES), required: true }] },
    Sub { name: "find", about: "Find members of this server who play a game", options: &[Opt { name: "game", about: "The game, such as Minecraft", takes: Takes::Text, required: true }] },
    Sub { name: "export", about: "Get a code that carries your card to another Good Boy", options: &[] },
    Sub { name: "import", about: "Replace your card with one from a code", options: &[Opt { name: "code", about: "The code from /id export", takes: Takes::Text, required: true }] },
    Sub { name: "delete", about: "Erase your card and linked accounts everywhere", options: &[] },
] }];
const AUTO_CHOICES: &[(&str, &str)] = &[("On: pick up what I play", "on"), ("Off: stop, and forget what was picked up", "off"), ("Forget what was picked up (keep it on)", "forget")];
const DAY: i64 = 86_400_000;

/// The platform a Discord status points to: a console's name from an activity, or the kind of app the person is on.
pub fn platform_of(raw: &str) -> Option<&'static str> {
    match raw.to_ascii_lowercase().as_str() { "desktop" | "pc" | "windows" | "steam" | "epic" => Some("pc"), "mobile" | "android" | "ios" => Some("mobile"), "xbox" | "xboxone" | "xbox360" => Some("xbox"), "ps4" | "ps5" | "playstation" => Some("playstation"), "switch" | "nintendo" => Some("switch"), _ => None }
}
/// Notes what a member was seen playing (from their Discord status): the games, and the platforms they were on. Nothing is
/// kept for someone who switched it off. Lets the server's members be found by `/id find`.
pub fn note_presence(db: &Db, guild: &str, user: &str, games: &[String], platforms: &[&str], now: i64) {
    if !db.get().eid_auto(user).unwrap_or(true) { return; }
    let d = db.get();
    let _ = d.eid_here_note(guild, user, now);
    for g in games.iter().take(5) {
        let g = clean_field(g, 60);
        if !g.is_empty() { let _ = d.eid_seen_note(user, "game", &g, now); }
    }
    for p in platforms { let _ = d.eid_seen_note(user, "platform", p, now); }
}

// ---- the code that moves a card to another Good Boy
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
fn b64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 4 / 3 + 3);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for k in 0..=c.len() { out.push(B64[(n >> (18 - 6 * k) & 63) as usize] as char); }
    }
    out
}
fn unb64(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for ch in text.bytes() {
        let v = B64.iter().position(|&b| b == ch)? as u32;
        acc = acc << 6 | v;
        bits += 6;
        if bits >= 8 { bits -= 8; out.push((acc >> bits & 0xff) as u8); }
    }
    Some(out)
}
fn check_of(body: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(format!("eidx1\n{body}").as_bytes()).iter().take(4).map(|b| format!("{b:02x}")).collect()
}
/// A person's whole card as a code: `EIDX1.<card>.<check>`. The check catches a mistyped or cut-off code.
pub fn export_code(db: &Db, user: &str) -> String {
    let p = db.get().eid_profile(user).ok().flatten().unwrap_or_default();
    let vis: Value = serde_json::from_str(&p.vis).unwrap_or(json!({}));
    let links: Vec<Value> = db.get().eid_links(user).unwrap_or_default().into_iter().map(|(pl, v, w)| json!([pl, v, w])).collect();
    let body = b64(json!({ "v": 1, "bio": p.bio, "games": p.games, "platforms": p.platforms, "availability": p.availability, "region": p.region, "vis": vis, "links": links }).to_string().as_bytes());
    format!("EIDX1.{body}.{}", check_of(&body))
}
/// Reads a code made by `export_code`. Everything in it is cleaned the way typing it in would have been. Gives the card,
/// its linked names, and how many linked names were left out because they did not look right.
/// A card read from a code: the card, its linked names (platform, name, who sees it) and how many names were left out.
pub type ReadCard = (Profile, Vec<(String, String, String)>, usize);
pub fn read_code(code: &str) -> Result<ReadCard, String> {
    let bad = || "That code is not complete or was changed. Copy the whole code from `/id export`, starting with EIDX1.".to_string();
    let code = code.trim().trim_matches('`');
    let mut parts = code.split('.');
    let (Some("EIDX1"), Some(body), Some(check), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else { return Err(bad()) };
    if check != check_of(body) { return Err(bad()); }
    let v: Value = serde_json::from_slice(&unb64(body).ok_or_else(bad)?).map_err(|_| bad())?;
    if v["v"] != 1 { return Err("That code is from a newer version of Good Boy than this one.".into()); }
    let text = |k: &str, max: usize| clean_field(v[k].as_str().unwrap_or(""), max);
    let (platforms, _) = parse_platforms(v["platforms"].as_str().unwrap_or(""));
    let mut vis = json!({});
    for (f, ..) in FIELDS { if let Some(w) = v["vis"][*f].as_str().filter(|w| WHO.iter().any(|x| x.1 == *w)) { vis[*f] = json!(w); } }
    let (mut links, mut skipped) = (Vec::new(), 0);
    for l in v["links"].as_array().into_iter().flatten().take(20) {
        let who = l[2].as_str().filter(|w| WHO.iter().any(|x| x.1 == *w)).unwrap_or("private");
        match normalize_link(l[0].as_str().unwrap_or(""), l[1].as_str().unwrap_or("")) { Ok(value) => links.push((l[0].as_str().unwrap_or("").to_string(), value, who.to_string())), Err(_) => skipped += 1 }
    }
    Ok((Profile { bio: text("bio", 300), games: text("games", 200), platforms: platforms.join(", "), availability: text("availability", 120), region: text("region", 40), vis: vis.to_string() }, links, skipped))
}

/// Pings and control characters out, one tidy block (Good Boy 3's cleanField).
pub fn clean_field(text: &str, max: usize) -> String {
    let mut s = text.to_string();
    for word in ["@everyone", "@here"] { s = s.replace(word, ""); }
    let mut out = String::new();
    let mut rest = s.as_str();
    while let Some(at) = rest.find("<@") {
        out.push_str(&rest[..at]);
        let tail = &rest[at + 2..];
        let body = tail.trim_start_matches(['&', '!']);
        let digits = body.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits > 0 && body[digits..].starts_with('>') { rest = &body[digits + 1..]; } else { out.push_str("<@"); rest = tail; }
    }
    out.push_str(rest);
    let spaced: String = out.chars().map(|c| if c.is_control() && c != '\n' { ' ' } else { c }).collect();
    let lines: Vec<String> = spaced.split('\n').map(|l| l.split([' ', '\t']).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ")).collect();
    let mut joined = lines.join("\n");
    while joined.contains("\n\n\n") { joined = joined.replace("\n\n\n", "\n\n"); }
    joined.trim().chars().take(max).collect()
}
/// "ps5, PC; nintendo" → (["playstation", "pc", "switch"], unknown words).
pub fn parse_platforms(text: &str) -> (Vec<String>, Vec<String>) {
    let low = text.to_lowercase();
    let mut out: Vec<String> = Vec::new();
    let mut bad = Vec::new();
    for raw in low.split([',', ';', '\n']).flat_map(|p| p.split("  ")).map(str::trim).filter(|r| !r.is_empty()) {
        let key: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
        let found = match key.as_str() { "ps" | "ps4" | "ps5" | "playstation" => Some("playstation"), "pc" | "computer" => Some("pc"), "xbox" => Some("xbox"), "switch" | "nintendo" => Some("switch"), "mobile" | "phone" => Some("mobile"), "vr" => Some("vr"), _ => None };
        match found { Some(k) => if !out.iter().any(|o| o == k) { out.push(k.into()) }, None => bad.push(raw.to_string()) }
    }
    (out, bad)
}
pub fn can_see(vis: &str, own: bool, staff: bool) -> bool {
    own || vis == "public" || (vis == "staff" && staff)
}
/// A person's Eclipse ID: the same on every server and every Good Boy, because it is made from their Discord user ID alone
/// (so nothing has to be stored or looked up). It is a label to show, not a secret and not proof of who someone is.
pub fn eid_code(user_id: &str) -> String {
    use sha2::{Digest, Sha256};
    const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let h = Sha256::digest(format!("eclipse-id-v1\n{user_id}").as_bytes());
    let mut n = u64::from_be_bytes([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]]) >> 14; // 50 bits
    let mut out = [b'0'; 10];
    for slot in out.iter_mut().rev() { *slot = ALPHABET[(n & 31) as usize]; n >>= 5; }
    let t = std::str::from_utf8(&out).unwrap_or("0000000000");
    format!("EID-{}-{}", &t[..5], &t[5..])
}
/// Checks a game account name for the right shape (Good Boy 3's normalizeLink). Gives the name to keep.
pub fn normalize_link(platform: &str, value: &str) -> Result<String, String> {
    let Some((_, label, hint)) = LINKS.iter().find(|l| l.0 == platform) else { return Err(format!("Unknown platform. Choose one of: {}.", LINKS.iter().map(|l| l.0).collect::<Vec<_>>().join(", "))) };
    let mut v = value.replace(['\r', '\n', '\t'], " ").replace("@everyone", "").replace("@here", "").trim().to_string();
    if platform == "nintendo" { v = v.to_uppercase(); }
    let alnum_ = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let len = v.chars().count();
    let ok = match platform {
        "steam" => (len == 17 && v.bytes().all(|b| b.is_ascii_digit())) || ((2..=32).contains(&len) && v.chars().all(|c| alnum_(c) || c == '-')),
        "xbox" => (1..=15).contains(&len) && v.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && v.chars().all(|c| c.is_ascii_alphanumeric() || c == ' '),
        "playstation" => (3..=16).contains(&len) && v.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && v.chars().all(|c| alnum_(c) || c == '-'),
        "nintendo" => { let p: Vec<&str> = v.split('-').collect(); p.len() == 4 && p[0] == "SW" && p[1..].iter().all(|x| x.len() == 4 && x.bytes().all(|b| b.is_ascii_digit())) }
        "epic" => (3..=32).contains(&len) && v.chars().all(|c| alnum_(c) || c == ' ' || c == '.' || c == '-'),
        "riot" => v.split_once('#').is_some_and(|(n, t)| (3..=16).contains(&n.chars().count()) && !n.contains('\n') && (3..=5).contains(&t.len()) && t.chars().all(|c| c.is_ascii_alphanumeric())),
        "battlenet" => v.split_once('#').is_some_and(|(n, t)| (3..=12).contains(&n.chars().count()) && n.chars().next().is_some_and(char::is_alphabetic) && n.chars().all(char::is_alphanumeric) && (4..=5).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_digit())),
        "roblox" => (3..=20).contains(&len) && v.chars().all(alnum_),
        "minecraft" => (3..=16).contains(&len) && v.chars().all(alnum_),
        _ => false,
    };
    if !ok { return Err(format!("That doesn't look like a {label} {hint}.")); }
    Ok(v)
}

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
fn vis_of(vis: &Value, field: &str) -> String {
    vis[field].as_str().map(str::to_string).unwrap_or_else(|| FIELDS.iter().find(|f| f.0 == field).map(|f| f.3).unwrap_or("public").to_string())
}
fn get(p: &Profile, f: &str) -> String {
    match f { "bio" => p.bio.clone(), "games" => p.games.clone(), "platforms" => p.platforms.clone(), "availability" => p.availability.clone(), _ => p.region.clone() }
}

#[allow(clippy::too_many_arguments)]
pub fn card(db: &Db, guild: &str, user: &Member, own: bool, staff: bool, now: i64, auto_server: bool, ach: Option<&crate::achievements::Achievements>) -> Card {
    let shared = db.get().eid_shared(&user.id, guild).unwrap_or(true);
    if !own && !shared {
        return Card::new(Area::General).title(format!("🪪 {}", user.name)).picture(user.avatar.clone()).line("*This member has not shared their card in this server.*").line(format!("-# {}", eid_code(&user.id)));
    }
    let p = db.get().eid_profile(&user.id).ok().flatten().unwrap_or_default();
    let vis: Value = serde_json::from_str(&p.vis).unwrap_or(json!({}));
    let mut hidden = Vec::new();
    let mut card = Card::new(Area::General).title(format!("🪪 {}", user.name)).picture(user.avatar.clone());
    let mut shown = false;
    for (f, name) in [("bio", ""), ("games", "Favourite games"), ("platforms", "Platforms"), ("availability", "Play style & availability"), ("region", "Region")] {
        let value = get(&p, f);
        if value.is_empty() { continue; }
        let v = vis_of(&vis, f);
        if own && v != "public" { hidden.push(FIELDS.iter().find(|x| x.0 == f).map(|x| x.1.to_lowercase()).unwrap_or_default()); }
        if !can_see(&v, own, staff) { continue; }
        let value = if f == "platforms" { value.split(',').map(str::trim).collect::<Vec<_>>().join(" · ") } else { value };
        card = card.line(if name.is_empty() { value.chars().take(300).collect() } else { format!("**{name}**\n{}", value.chars().take(200).collect::<String>()) });
        shown = true;
    }
    let links = db.get().eid_links(&user.id).unwrap_or_default();
    if own && links.iter().any(|l| l.2 != "public") { hidden.push("linked accounts".into()); }
    let seen: Vec<String> = links.iter().filter(|l| can_see(&l.2, own, staff)).map(|(pl, v, vis)| format!("**{}** {v}{}", LINKS.iter().find(|x| x.0 == pl).map(|x| x.1).unwrap_or(pl), match vis.as_str() { "staff" => " *(staff only)*", "private" => " *(only you)*", _ => "" })).collect();
    if !seen.is_empty() { card = card.line(format!("**Linked accounts (not verified)**\n{}", seen.join("\n"))); shown = true; }
    // what was picked up from their Discord status (only if the server allows it and they have not switched it off)
    if auto_server && db.get().eid_auto(&user.id).unwrap_or(true) && can_see(&vis_of(&vis, "seen"), own, staff) {
        let (games, plats) = { let d = db.get(); (d.eid_seen_list(&user.id, "game", now - 60 * DAY, 5).unwrap_or_default(), d.eid_seen_list(&user.id, "platform", now - 60 * DAY, 4).unwrap_or_default()) };
        if !games.is_empty() || !plats.is_empty() {
            let label = |p: &str| match p { "pc" => "PC".to_string(), "playstation" => "PlayStation".into(), "xbox" => "Xbox".into(), "switch" => "Switch".into(), "mobile" => "Mobile".into(), o => o.to_string() };
            let mut line = String::from("**Seen playing** (picked up automatically)");
            if !games.is_empty() { line.push_str(&format!("\n{}", games.iter().map(|g| g.0.clone()).collect::<Vec<_>>().join(" · "))); }
            if !plats.is_empty() { line.push_str(&format!("\n-# on {}", plats.iter().map(|p| label(&p.0)).collect::<Vec<_>>().join(", "))); }
            card = card.line(line);
            shown = true;
        }
    }
    if let Some((count, total, recent)) = ach.and_then(|a| a.summary(&user.id)).filter(|s| s.0 > 0) {
        card = card.line(format!("**Achievements {count}/{total}**\n{}", recent.iter().map(|(name, emoji, _)| format!("{emoji} {name}")).collect::<Vec<_>>().join(" · ")));
        shown = true;
    }
    if !shown { card = card.line(if own { "Your card is empty. Use `/id edit` to fill it in." } else { "*This member has not shared anything yet.*" }); }
    card.line(format!("-# {} · members choose what to share · linked accounts are not verified{}", eid_code(&user.id), if own && !hidden.is_empty() { format!(" · hidden from others: {}", hidden.join(", ")) } else { String::new() })).private()
}

pub fn command(db: &Db, ev: &CommandEvent, roblox_on: bool, auto_server: bool, ach: Option<&crate::achievements::Achievements>) -> Vec<Action> {
    if !perms::allowed(db, &ev.guild, &ev.member, USE) { return private(format!("You don't have permission for that (`{}`).", USE.key)); }
    let arg = |k: &str| ev.args.get(k).map(String::as_str).filter(|v| !v.trim().is_empty());
    let me = &ev.member.id;
    let p = db.get().eid_profile(me).ok().flatten().unwrap_or_default();
    let _ = db.get().eid_here_note(&ev.guild, me, ev.at_ms);
    match ev.sub.as_deref().unwrap_or("show") {
        "edit" => {
            let f = |id: &str, label: &str, long: bool, max: u16, value: &str, hint: Option<&str>| Field { id: id.into(), label: label.into(), long, max, value: Some(value.to_string()).filter(|v| !v.is_empty()), placeholder: hint.map(str::to_string), ..Default::default() };
            vec![Action::Form { id: "eid:edit".into(), title: "Your Eclipse ID".into(), fields: vec![
                f("bio", "About me", true, 300, &p.bio, None), f("games", "Favourite games", false, 200, &p.games, None),
                f("platforms", "Platforms", false, 80, &p.platforms, Some("pc, playstation, xbox, switch, mobile, vr")),
                f("availability", "Play style and availability", false, 120, &p.availability, None), f("region", "Region or timezone", false, 40, &p.region, None),
            ] }]
        }
        "show" => {
            let u = ev.target.clone().unwrap_or_else(|| ev.member.clone());
            if u.bot { return private("Bots do not have an Eclipse ID."); }
            let staff = perms::allowed(db, &ev.guild, &ev.member, STAFF);
            vec![Action::Reply { card: card(db, &ev.guild, &u, u.id == *me, staff, ev.at_ms, auto_server, ach) }]
        }
        "privacy" => {
            let (Some(field), Some(who)) = (arg("field").filter(|f| FIELDS.iter().any(|x| x.0 == *f)), arg("who").filter(|w| WHO.iter().any(|x| x.1 == *w))) else { return private("Pick a field and who may see it.") };
            if field == "links" { let _ = db.get().eid_link_vis(me, arg("platform"), who); }
            let mut vis: Value = serde_json::from_str(&p.vis).unwrap_or(json!({}));
            vis[field] = json!(who);
            let _ = db.get().eid_save(me, &Profile { vis: vis.to_string(), ..p }, ev.at_ms);
            let label = FIELDS.iter().find(|x| x.0 == field).map(|x| x.1).unwrap_or(field);
            private(format!("**{label}** can be seen by: {}.", match who { "public" => "everyone in the server", "staff" => "you and server staff", _ => "only you" }))
        }
        "link" => {
            let platform = arg("platform").unwrap_or("");
            let value = match normalize_link(platform, arg("name").unwrap_or("")) { Ok(v) => v, Err(no) => return private(no) };
            let who = arg("who").unwrap_or("private");
            let _ = db.get().eid_link(me, platform, &value, who, ev.at_ms);
            let label = LINKS.iter().find(|x| x.0 == platform).map(|x| x.1).unwrap_or(platform);
            private(format!("Saved your {label} name **{value}** ({}). It is shown as *not verified*: I only checked that it looks right.", match who { "public" => "everyone can see it", "staff" => "staff only", _ => "only you can see it" }))
        }
        "unlink" => if db.get().eid_unlink(me, arg("platform").unwrap_or("")).unwrap_or(false) { private("Removed.") } else { private("You have nothing linked for that platform.") },
        "share" => {
            let d = db.get();
            let said = match arg("where").unwrap_or("") {
                "here" => { let _ = d.eid_set_share(me, &ev.guild, true); "Your card is now shown in **this server**." }
                "hide" => { let _ = d.eid_set_share(me, &ev.guild, false); "Your card is now **hidden in this server**. Other servers are not changed." }
                "all" => { let _ = d.eid_set_share_all(me, true); "Your card is now shown in **every server** this bot is in." }
                "none" => { let _ = d.eid_set_share_all(me, false); "Your card is now **hidden in every server**. You can still see it yourself." }
                _ => return private("Choose where to show your card."),
            };
            private(said)
        }
        "auto" => match arg("mode").unwrap_or("") {
            "on" => { let _ = db.get().eid_set_auto(me, true); private(if auto_server { "Good Boy will pick up the games and platforms from your Discord status and show them on your card as *picked up automatically*. Change who sees them with `/id privacy field:Picked up automatically`, or stop it any time with `/id auto`." } else { "Saved, but this server's admins have switched picking things up off, so nothing is picked up here." }) }
            "off" => { let _ = db.get().eid_set_auto(me, false); private("Stopped. Nothing more is picked up about you, and what was picked up is erased.") }
            "forget" => { let _ = db.get().eid_forget_seen(me); private("Everything that was picked up about you is erased.") }
            _ => private("Choose on, off or forget."),
        },
        "export" => {
            let has = !p.bio.is_empty() || !p.games.is_empty() || !p.platforms.is_empty() || !p.availability.is_empty() || !p.region.is_empty() || !db.get().eid_links(me).unwrap_or_default().is_empty();
            if !has { return private("Your card is empty. Fill it in with `/id edit` first."); }
            private(format!("Here is your card as a code. Paste it into `/id import` on another Good Boy to bring your card there. It includes your linked accounts, even the ones only you can see, so keep it to yourself.\n```\n{}\n```", export_code(db, me)))
        }
        "import" => {
            let (card, links, skipped) = match read_code(arg("code").unwrap_or("")) { Ok(x) => x, Err(no) => return private(no) };
            let had = !p.bio.is_empty() || !p.games.is_empty() || !p.platforms.is_empty() || !p.availability.is_empty() || !p.region.is_empty();
            let before = if had { Some(export_code(db, me)) } else { None };
            let d = db.get();
            let _ = d.eid_save(me, &card, ev.at_ms);
            for (pl, ..) in d.eid_links(me).unwrap_or_default() { let _ = d.eid_unlink(me, &pl); }
            for (pl, v, who) in &links { let _ = d.eid_link(me, pl, v, who, ev.at_ms); }
            drop(d);
            private(format!("Your card was replaced with the one in the code{}.{}{}", if links.is_empty() { String::new() } else { format!(" ({} linked account{})", links.len(), if links.len() == 1 { "" } else { "s" }) }, if skipped > 0 { format!(" {skipped} linked name{} did not look right and {} left out.", if skipped == 1 { "" } else { "s" }, if skipped == 1 { "was" } else { "were" }) } else { String::new() }, before.map(|c| format!("\nYour old card, in case you want it back (`/id import`):\n```\n{c}\n```")).unwrap_or_default()))
        }
        "find" => {
            let term = clean_field(arg("game").unwrap_or(""), 60).to_lowercase();
            if term.chars().count() < 2 { return private("Type the name of a game, at least two letters."); }
            let staff = perms::allowed(db, &ev.guild, &ev.member, STAFF);
            let mut found: Vec<(String, String)> = Vec::new();
            let here = db.get().eid_here_users(&ev.guild, 500).unwrap_or_default();
            for u in here {
                if u == *me || !db.get().eid_shared(&u, &ev.guild).unwrap_or(false) { continue; }
                let prof = db.get().eid_profile(&u).ok().flatten().unwrap_or_default();
                let vis: Value = serde_json::from_str(&prof.vis).unwrap_or(json!({}));
                let listed = can_see(&vis_of(&vis, "games"), false, staff) && prof.games.to_lowercase().contains(&term);
                let seen = auto_server && db.get().eid_auto(&u).unwrap_or(true) && can_see(&vis_of(&vis, "seen"), false, staff)
                    && db.get().eid_seen_list(&u, "game", ev.at_ms - 60 * DAY, 40).unwrap_or_default().iter().any(|g| g.0.to_lowercase().contains(&term));
                if listed || seen {
                    let plats = if can_see(&vis_of(&vis, "platforms"), false, staff) { prof.platforms.replace(',', " ·") } else { String::new() };
                    found.push((u, plats));
                }
                if found.len() >= 15 { break; }
            }
            if found.is_empty() { return private(format!("Nobody here has shared that they play **{}** yet. Members add games with `/id edit`, and picked-up games appear by themselves. Start a group with `/party create`.", term)); }
            let list = found.iter().map(|(u, p)| format!("<@{u}>{}", if p.is_empty() { String::new() } else { format!(" · {p}") })).collect::<Vec<_>>().join("\n");
            vec![Action::Reply { card: Card::new(Area::General).title(format!("🪪 Players of {}", term)).line(list).line("-# Only members who use Eclipse ID in this server and share their card are listed. Start a group with `/party create`.").private() }]
        }
        "delete" => { let _ = db.get().eid_delete(me); private("Your Eclipse ID card, linked accounts and sharing choices were erased everywhere.") }
        _ => {
            if !roblox_on { return private("Roblox lookup is turned off on this server."); }
            match normalize_link("roblox", arg("name").unwrap_or("")) { Ok(name) => vec![Action::Roblox { name }], Err(no) => private(no) }
        }
    }
}
/// The `/id edit` popup sent.
pub fn form(db: &Db, ev: &FormEvent) -> Vec<Action> {
    let v = |k: &str| ev.values.get(k).cloned().unwrap_or_default();
    let (platforms, unknown) = parse_platforms(&v("platforms"));
    if !unknown.is_empty() { return private(format!("I don't know these platforms: {}. Use: {}.", unknown.join(", "), PLATFORMS.join(", "))); }
    let old = db.get().eid_profile(&ev.member.id).ok().flatten().unwrap_or_default();
    let p = Profile { bio: clean_field(&v("bio"), 300), games: clean_field(&v("games"), 200), platforms: platforms.join(", "), availability: clean_field(&v("availability"), 120), region: clean_field(&v("region"), 40), vis: if old.vis.is_empty() { "{}".into() } else { old.vis } };
    let _ = db.get().eid_save(&ev.member.id, &p, ev.at_ms);
    private("Saved. This card goes with you to every server this bot is in. See it with `/id show`, change who can see each part with `/id privacy`, and choose which servers show it with `/id share`.")
}
/// What Roblox said about a name (Good Boy 3's wording).
pub fn roblox_said(name: &str, found: Result<Option<(String, String, String)>, String>) -> Card {
    let text = match found {
        Err(why) => format!("I couldn't check that: {why}"),
        Ok(None) => format!("Roblox says there is no account named **{name}**."),
        Ok(Some((id, real, display))) => format!("Roblox has an account **{real}** (id {id}{}). That only shows the name exists, not that it is yours. Add it with `/id link platform:roblox`.", if display.is_empty() { String::new() } else { format!(", display name {display}") }),
    };
    Card::new(Area::General).line(text).private()
}
