//! Good Boy 3's Eclipse ID: a member-controlled gaming profile (about me, favourite games, platforms, availability,
//! region, linked game account names), with who may see each part. Linked names are only checked for the right
//! shape for that platform: nothing here proves the member owns the account. The ID number is the same everywhere.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::{Action, Area, CommandEvent, Card, Db, Def, Field, FormEvent, Kind, Member};
use gb_data::eclipseid::Profile;
use serde_json::{json, Value};

pub const MODULE: &str = "eclipseid";
pub const USE: Perm = Perm { key: "eclipseid.use", level: Level::Everyone };
pub const STAFF: Perm = Perm { key: "eclipseid.staff", level: Level::Moderator(None) };
pub static SETTINGS: &[Def] = &[Def { key: "robloxLookup", label: "Let /id roblox check that a Roblox username exists (contacts Roblox)", kind: Kind::Toggle, default: Fallback::Bool(false) }];
/// (id, label, most characters, who sees it at first)
pub const FIELDS: &[(&str, &str, usize, &str)] = &[
    ("bio", "About me", 300, "public"), ("games", "Favourite games", 200, "public"), ("platforms", "Platforms", 80, "public"),
    ("availability", "Play style and availability", 120, "public"), ("region", "Region or timezone", 40, "public"), ("links", "Linked game accounts", 0, "private"),
];
pub const PLATFORMS: &[&str] = &["pc", "playstation", "xbox", "switch", "mobile", "vr"];
/// (id, label, what it should look like)
pub const LINKS: &[(&str, &str, &str)] = &[
    ("steam", "Steam", "profile name (vanity) or 17-digit Steam ID"), ("xbox", "Xbox", "gamertag"), ("playstation", "PlayStation", "PSN ID"),
    ("nintendo", "Nintendo Switch", "friend code like SW-1234-5678-9012"), ("epic", "Epic Games", "display name"), ("riot", "Riot ID", "Name#TAG"),
    ("battlenet", "Battle.net", "BattleTag like Name#1234"), ("roblox", "Roblox", "username"), ("minecraft", "Minecraft (Java)", "username"),
];
const FIELD_CHOICES: &[(&str, &str)] = &[("About me", "bio"), ("Favourite games", "games"), ("Platforms", "platforms"), ("Play style and availability", "availability"), ("Region or timezone", "region"), ("Linked game accounts", "links")];
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
    Sub { name: "delete", about: "Erase your card and linked accounts in this server", options: &[] },
] }];

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
pub fn eid_label(n: i64) -> String {
    format!("EID-{n:06}")
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

pub fn card(db: &Db, guild: &str, user: &Member, own: bool, staff: bool, now: i64, ach: Option<&crate::achievements::Achievements>) -> Card {
    let p = db.get().eid_profile(guild, &user.id).ok().flatten().unwrap_or_default();
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
    let links = db.get().eid_links(guild, &user.id).unwrap_or_default();
    if own && links.iter().any(|l| l.2 != "public") { hidden.push("linked accounts".into()); }
    let seen: Vec<String> = links.iter().filter(|l| can_see(&l.2, own, staff)).map(|(pl, v, vis)| format!("**{}** {v}{}", LINKS.iter().find(|x| x.0 == pl).map(|x| x.1).unwrap_or(pl), match vis.as_str() { "staff" => " *(staff only)*", "private" => " *(only you)*", _ => "" })).collect();
    if !seen.is_empty() { card = card.line(format!("**Linked accounts (not verified)**\n{}", seen.join("\n"))); shown = true; }
    if let Some((count, total, recent)) = ach.and_then(|a| a.summary(&user.id)).filter(|s| s.0 > 0) {
        card = card.line(format!("**Achievements {count}/{total}**\n{}", recent.iter().map(|(name, emoji, _)| format!("{emoji} {name}")).collect::<Vec<_>>().join(" · ")));
        shown = true;
    }
    if !shown { card = card.line(if own { "Your card is empty. Use `/id edit` to fill it in." } else { "*This member has not shared anything yet.*" }); }
    let eid = db.get().eid(&user.id, now).unwrap_or(0);
    card.line(format!("-# {} · members choose what to share · linked accounts are not verified{}", eid_label(eid), if own && !hidden.is_empty() { format!(" · hidden from others: {}", hidden.join(", ")) } else { String::new() })).private()
}

pub fn command(db: &Db, ev: &CommandEvent, roblox_on: bool, ach: Option<&crate::achievements::Achievements>) -> Vec<Action> {
    if !perms::allowed(db, &ev.guild, &ev.member, USE) { return private(format!("You don't have permission for that (`{}`).", USE.key)); }
    let arg = |k: &str| ev.args.get(k).map(String::as_str).filter(|v| !v.trim().is_empty());
    let me = &ev.member.id;
    let p = db.get().eid_profile(&ev.guild, me).ok().flatten().unwrap_or_default();
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
            vec![Action::Reply { card: card(db, &ev.guild, &u, u.id == *me, staff, ev.at_ms, ach) }]
        }
        "privacy" => {
            let (Some(field), Some(who)) = (arg("field").filter(|f| FIELDS.iter().any(|x| x.0 == *f)), arg("who").filter(|w| WHO.iter().any(|x| x.1 == *w))) else { return private("Pick a field and who may see it.") };
            if field == "links" { let _ = db.get().eid_link_vis(&ev.guild, me, arg("platform"), who); }
            let mut vis: Value = serde_json::from_str(&p.vis).unwrap_or(json!({}));
            vis[field] = json!(who);
            let _ = db.get().eid_save(&ev.guild, me, &Profile { vis: vis.to_string(), ..p }, ev.at_ms);
            let label = FIELDS.iter().find(|x| x.0 == field).map(|x| x.1).unwrap_or(field);
            private(format!("**{label}** can be seen by: {}.", match who { "public" => "everyone in the server", "staff" => "you and server staff", _ => "only you" }))
        }
        "link" => {
            let platform = arg("platform").unwrap_or("");
            let value = match normalize_link(platform, arg("name").unwrap_or("")) { Ok(v) => v, Err(no) => return private(no) };
            let who = arg("who").unwrap_or("private");
            let _ = db.get().eid_link(&ev.guild, me, platform, &value, who, ev.at_ms);
            let label = LINKS.iter().find(|x| x.0 == platform).map(|x| x.1).unwrap_or(platform);
            private(format!("Saved your {label} name **{value}** ({}). It is shown as *not verified*: I only checked that it looks right.", match who { "public" => "everyone can see it", "staff" => "staff only", _ => "only you can see it" }))
        }
        "unlink" => if db.get().eid_unlink(&ev.guild, me, arg("platform").unwrap_or("")).unwrap_or(false) { private("Removed.") } else { private("You have nothing linked for that platform.") },
        "delete" => { let _ = db.get().eid_delete(&ev.guild, me); private("Your Eclipse ID card and linked accounts in this server were erased.") }
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
    let old = db.get().eid_profile(&ev.guild, &ev.member.id).ok().flatten().unwrap_or_default();
    let p = Profile { bio: clean_field(&v("bio"), 300), games: clean_field(&v("games"), 200), platforms: platforms.join(", "), availability: clean_field(&v("availability"), 120), region: clean_field(&v("region"), 40), vis: if old.vis.is_empty() { "{}".into() } else { old.vis } };
    let _ = db.get().eid_save(&ev.guild, &ev.member.id, &p, ev.at_ms);
    private("Saved. See it with `/id show`. Change who can see each part with `/id privacy`.")
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
