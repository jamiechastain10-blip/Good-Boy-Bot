//! Levels: XP for chatting, level-ups, role rewards, /rank and the leaderboard.
//!
//! The rules and the stored records are the same as Good Boy 3's community module, so a member's XP, level,
//! boosts and rewards carry on exactly where they were. What is new is the look (cards) and how the leaderboard
//! is read (from the database's XP order, never by reading every member).

use crate::card::group;
use crate::settings::{Def, Fallback, Kind};
use crate::{Action, Area, ButtonStyle, Card, CommandEvent, Db, MessageEvent, Place, Settings};
use gb_data::level_of;
use serde_json::{json, Value};

/// The module's name in the database (Good Boy 3 calls it "community").
pub const MODULE: &str = "community";

pub static SETTINGS: &[Def] = &[
    Def { key: "xpMin", label: "XP per message (min)", kind: Kind::Number { min: 1, max: 500 }, default: Fallback::Int(15) },
    Def { key: "xpMax", label: "XP per message (max)", kind: Kind::Number { min: 1, max: 500 }, default: Fallback::Int(25) },
    Def { key: "xpCooldownSeconds", label: "Seconds between XP gains", kind: Kind::Number { min: 5, max: 3600 }, default: Fallback::Int(60) },
    Def { key: "noXpChannels", label: "No XP in these channels or categories", kind: Kind::List, default: Fallback::None },
    Def { key: "levelUpEnabled", label: "Announce level-ups", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "levelUpChannel", label: "Level-up channel (empty = where they chatted)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "levelUpMessage", label: "Level-up message", kind: Kind::Text { max_len: 2000 }, default: Fallback::Str(DEFAULT_LEVEL_UP) },
    Def { key: "rankCards", label: "/rank shows a picture card (text if pictures are off)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "pixelPictures", label: "Draw profile pictures as pixel art on rank cards", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "cardBackgrounds", label: "Members can put their own picture behind their rank card", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "stackRewards", label: "Keep earlier level rewards (off = only the newest)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "reactionXp", label: "Reaction XP: members earn a little XP for reacting to other people's messages", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "reactionXpAmount", label: "Reaction XP per reaction", kind: Kind::Number { min: 1, max: 50 }, default: Fallback::Int(2) },
    Def { key: "reactionXpCooldownSeconds", label: "Reaction XP: seconds between XP gains", kind: Kind::Number { min: 5, max: 3600 }, default: Fallback::Int(60) },
    Def { key: "voiceXp", label: "Voice XP: members earn XP while talking in voice", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "voiceXpPerMinute", label: "Voice XP per minute", kind: Kind::Number { min: 1, max: 100 }, default: Fallback::Int(12) },
    Def { key: "voiceXpDailyMinutes", label: "Voice XP: most minutes that count per member per day (0 = no limit)", kind: Kind::Number { min: 0, max: 1440 }, default: Fallback::Int(300) },
    Def { key: "voiceXpCountMuted", label: "Voice XP: muted members earn too", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "repEnabled", label: "Reputation on", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "repAllowNegative", label: "Members may give negative reputation", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "repCooldownHours", label: "Hours between giving reputation", kind: Kind::Number { min: 1, max: 720 }, default: Fallback::Int(24) },
    Def { key: "repDailyLimit", label: "Max reputation gifts per member per day", kind: Kind::Number { min: 1, max: 50 }, default: Fallback::Int(5) },
    Def { key: "repPairCooldownHours", label: "Hours before rating the same member again", kind: Kind::Number { min: 1, max: 8760 }, default: Fallback::Int(168) },
    Def { key: "repNegativeDailyPerTarget", label: "Max negative votes one member can receive per day", kind: Kind::Number { min: 1, max: 50 }, default: Fallback::Int(5) },
    Def { key: "repMinMemberDays", label: "Days in the server before a member can give reputation", kind: Kind::Number { min: 0, max: 365 }, default: Fallback::Int(0) },
    Def { key: "repLogChannel", label: "Reputation audit-log channel", kind: Kind::Channel, default: Fallback::None },
    Def { key: "liveBoardChannel", label: "Live leaderboard channel (empty = off)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "liveBoardType", label: "Live leaderboard ranks by", kind: Kind::Select(&["xp", "rep", "messages"]), default: Fallback::Str("xp") },
    Def { key: "liveBoardSize", label: "Live leaderboard size (members)", kind: Kind::Number { min: 3, max: 25 }, default: Fallback::Int(10) },
    Def { key: "liveBoardMinutes", label: "Minutes between live leaderboard refreshes", kind: Kind::Number { min: 1, max: 120 }, default: Fallback::Int(5) },
    Def { key: "statsChannel", label: "Voice channel to show the member count", kind: Kind::Channel, default: Fallback::None },
    Def { key: "statsFormat", label: "Member counter name ({count} {humans} {bots})", kind: Kind::Text { max_len: 90 }, default: Fallback::Str("Members: {count}") },
];
const DEFAULT_LEVEL_UP: &str = "🎉 {user} reached **level {level}**!";

fn user_key(id: &str) -> String {
    format!("user:{id}")
}

/// No XP in channels the server switched off (or their category, or a thread's channel), and never in tickets.
pub fn xp_allowed(db: &Db, settings: &Settings, guild: &str, place: &Place) -> bool {
    if place.is_in(&settings.list(guild, MODULE, "noXpChannels")) {
        return false;
    }
    !matches!(db.get().data_get(guild, "support", &format!("ticket:{}", place.base())), Ok(Some(_)))
}

/// Boosts multiply XP: the best role boost the member has, times the boost of the most specific place
/// (the channel, else a thread's channel, else the category). Rounded to two places, as in Good Boy 3.
pub fn xp_boost(boosts: &Value, roles: &[String], place: &Place) -> f64 {
    let list: &[Value] = boosts.as_array().map(Vec::as_slice).unwrap_or(&[]);
    let mult = |b: &Value| b["mult"].as_f64();
    let role = list.iter().filter(|b| b["kind"] == "role" && b["id"].as_str().is_some_and(|id| roles.iter().any(|r| r == id))).filter_map(mult).fold(None::<f64>, |best, m| Some(best.map_or(m, |b| b.max(m)))).unwrap_or(1.0);
    let places = [Some(place.channel.as_str()), place.thread_of.as_deref(), place.category.as_deref()];
    let here = places.iter().flatten().find_map(|id| list.iter().find(|b| b["kind"] == "channel" && b["id"] == *id).and_then(mult)).unwrap_or(1.0);
    (role * here * 100.0).round() / 100.0
}

/// A message was posted: count it, and give XP when the member's cooldown has passed.
/// `roll(lo, hi)` picks the XP between the two (the bot passes real chance; tests pass a fixed pick).
pub fn on_message(db: &Db, settings: &Settings, ev: &MessageEvent, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
    if ev.author.bot || !xp_allowed(db, settings, &ev.guild, &ev.place) {
        return Vec::new();
    }
    let g = ev.guild.as_str();
    let cooldown_ms = settings.int(g, MODULE, "xpCooldownSeconds") * 1000;
    let lo = settings.int(g, MODULE, "xpMin");
    let hi = settings.int(g, MODULE, "xpMax").max(lo);
    let key = user_key(&ev.author.id);

    // read, change and write as one step
    let (before, after, total_xp) = {
        let store = db.get();
        let mut rec = match store.data_get(g, MODULE, &key) {
            Ok(Some(Value::Object(map))) => map,
            _ => serde_json::Map::new(),
        };
        for (field, start) in [("xp", 0), ("messages", 0), ("rep", 0), ("lastXp", 0), ("lastRep", 0)] {
            rec.entry(field).or_insert(json!(start));
        }
        let num = |rec: &serde_json::Map<String, Value>, f: &str| rec[f].as_i64().or_else(|| rec[f].as_f64().map(|x| x as i64)).unwrap_or(0);
        rec.insert("messages".into(), json!(num(&rec, "messages") + 1));
        let xp = num(&rec, "xp");
        let mut levels = None;
        if ev.at_ms - num(&rec, "lastXp") >= cooldown_ms {
            let boost = xp_boost(&store.data_get(g, MODULE, "xpBoosts").ok().flatten().unwrap_or(Value::Null), &ev.author.roles, &ev.place);
            let gained = ((roll(lo, hi).clamp(lo, hi) as f64) * boost).round().max(0.0) as i64;
            rec.insert("xp".into(), json!(xp + gained));
            rec.insert("lastXp".into(), json!(ev.at_ms));
            levels = Some((level_of(xp).level, level_of(xp + gained).level, xp + gained));
        }
        if store.data_set(g, MODULE, &key, &Value::Object(rec)).is_err() {
            return Vec::new();
        }
        match levels {
            Some(l) => l,
            None => return Vec::new(),
        }
    };
    if after <= before {
        return Vec::new();
    }

    level_up(db, settings, g, &ev.author, &ev.place.channel, after, total_xp)
}

/// A member reached a new level: the announcement (in the level-up channel, else `here`) and the level's reward roles.
pub(crate) fn level_up(db: &Db, settings: &Settings, g: &str, who: &crate::Member, here: &str, level: u32, total_xp: i64) -> Vec<Action> {
    let mut actions = Vec::new();
    db.seen().saw(g, &who.id, &who.name);
    db.seen().note(g, "level", &format!("{} reached level {level}", if who.name.is_empty() { "A member" } else { who.name.as_str() }));
    if settings.bool(g, MODULE, "levelUpEnabled") {
        let channel = settings.text(g, MODULE, "levelUpChannel").unwrap_or_else(|| here.to_string());
        actions.push(Action::Send { channel, card: level_up_card(db, settings, g, who, level, total_xp), ping: vec![who.id.clone()], roles: Vec::new() });
    }
    if let Some(roles) = rewards(db, settings, g, &who.roles, level) {
        actions.push(Action::Roles { user: who.id.clone(), add: roles.0, remove: roles.1, reason: format!("Level {level} reward") });
    }
    actions
}

/// Change a member's record in one step. `change` edits it and returns the XP it gave (None: no XP given, the
/// record is still saved). Returns (level before, level after, total XP) when XP was given.
pub(crate) fn grant(db: &Db, g: &str, user: &str, change: impl FnOnce(&mut serde_json::Map<String, Value>) -> Option<i64>) -> Option<(u32, u32, i64)> {
    let store = db.get();
    let key = user_key(user);
    let mut rec = match store.data_get(g, MODULE, &key) {
        Ok(Some(Value::Object(map))) => map,
        _ => serde_json::Map::new(),
    };
    for (field, start) in [("xp", 0), ("messages", 0), ("rep", 0), ("lastXp", 0), ("lastRep", 0)] {
        rec.entry(field).or_insert(json!(start));
    }
    let xp = rec["xp"].as_i64().or_else(|| rec["xp"].as_f64().map(|x| x as i64)).unwrap_or(0);
    let gained = change(&mut rec);
    let total = match gained { Some(n) => { let t = xp + n; rec.insert("xp".into(), json!(t)); t } None => xp };
    store.data_set(g, MODULE, &key, &Value::Object(rec)).ok()?;
    gained.map(|_| (level_of(xp).level, level_of(total).level, total))
}

fn level_up_card(db: &Db, settings: &Settings, g: &str, who: &crate::Member, level: u32, total_xp: i64) -> Card {
    let now = level_of(total_xp);
    let custom = settings.text(g, MODULE, "levelUpMessage").filter(|t| t != DEFAULT_LEVEL_UP);
    let mut card = Card::new(Area::General).picture(who.avatar.clone());
    card = match custom {
        // the server wrote its own message: it is shown as they wrote it
        Some(text) => card.line(text.replace("{user}", &format!("<@{}>", who.id)).replace("{username}", &who.name).replace("{level}", &level.to_string())),
        None => card.title(format!("{} reached level {level}", who.name)).line(format!("🎉 <@{}>", who.id)),
    };
    if let Ok(Some((rank, total))) = db.get().xp_rank(g, &who.id) {
        card = card.line(format!("Rank {} of {} in the server", group(rank as i64), group(total as i64)));
    }
    card.bar(now.into, now.needed, format!("XP to level {}", level + 1)).button(format!("rank:{}", who.id), "View rank", ButtonStyle::Plain)
}

/// The reward roles to add and to take away at this level, or None when nothing changes.
/// With "keep earlier rewards" off, only the newest earned reward is kept.
pub(crate) fn rewards(db: &Db, settings: &Settings, guild: &str, has: &[String], level: u32) -> Option<(Vec<String>, Vec<String>)> {
    let mut all: Vec<(u32, String)> = db.get().data_list(guild, MODULE, "reward:", 1000).ok()?.into_iter().filter_map(|(k, v)| Some((k[7..].parse().ok()?, v.as_str()?.to_string()))).collect();
    all.sort();
    let earned: Vec<&(u32, String)> = all.iter().filter(|(l, _)| *l <= level).collect();
    let stack = settings.bool(guild, MODULE, "stackRewards");
    let keep: Vec<&String> = if stack { earned.iter().map(|(_, r)| r).collect() } else { earned.last().map(|(_, r)| r).into_iter().collect() };
    let add: Vec<String> = keep.iter().filter(|r| !has.contains(r)).map(|r| r.to_string()).collect();
    let remove: Vec<String> = if stack { Vec::new() } else { all.iter().map(|(_, r)| r).filter(|r| !keep.contains(r) && has.contains(r)).cloned().collect() };
    if add.is_empty() && remove.is_empty() { None } else { Some((add, remove)) }
}

/// /rank: a member's level, place and progress.
/// Rank card themes, as Good Boy 3 offers them: (id, label).
pub const CARD_THEMES: &[(&str, &str)] = &[("dark", "Dark"), ("light", "Light"), ("midnight", "Midnight"), ("sunset", "Sunset"), ("forest", "Forest"), ("ocean", "Ocean"), ("candy", "Candy")];
/// A colour as Good Boy 3 accepts it: six hex digits, with or without #.
pub fn ok_hex(v: &str) -> bool {
    let v = v.trim().trim_start_matches('#');
    v.len() == 6 && v.chars().all(|c| c.is_ascii_hexdigit())
}
/// Only pictures uploaded to Discord can be card backgrounds (nothing from random sites), as in Good Boy 3.
pub fn ok_background(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://cdn.discordapp.com/attachments/").or_else(|| url.strip_prefix("https://media.discordapp.net/attachments/")) else { return false };
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let ext_ok = path.rsplit_once('.').is_some_and(|(_, e)| matches!(e.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif"));
    ext_ok && !path.is_empty() && path.chars().all(|c| c.is_ascii_alphanumeric() || "/._-%".contains(c)) && query.chars().all(|c| c.is_ascii_alphanumeric() || "=&._-%".contains(c))
}
fn bar16(value: i64, max: i64) -> String {
    let filled = ((value as f64 / max.max(1) as f64) * 16.0).round().clamp(0.0, 16.0) as usize;
    format!("{}{}", "▰".repeat(filled), "▱".repeat(16 - filled))
}

/// /rank: the member's rank card (a picture, with the text version when pictures are off), as in Good Boy 3.
pub fn rank(db: &Db, settings: &Settings, ev: &CommandEvent) -> Action {
    let who = ev.target.as_ref().unwrap_or(&ev.member);
    if who.bot { return Action::Reply { card: Card::new(Area::General).line("Bots don't earn XP.").private() }; }
    let store = db.get();
    let rec = store.data_get(&ev.guild, MODULE, &format!("user:{}", who.id)).ok().flatten().unwrap_or(Value::Null);
    let xp = rec["xp"].as_i64().unwrap_or(0);
    let messages = rec["messages"].as_i64().unwrap_or(0);
    let rep = rec["rep"].as_i64().unwrap_or(0);
    let level = level_of(xp);
    let pos = store.xp_rank(&ev.guild, &who.id).ok().flatten().map(|(r, _)| r as i64);
    // the text version (Good Boy 3's): shown when pictures are off, or when the picture can't be drawn
    let mut card = Card::new(Area::General).title(format!("Level {}", level.level)).picture(who.avatar.clone())
        .line(format!("**{}**", who.name))
        .line(format!("{}\n{} / {} XP to level {}", bar16(level.into, level.needed), level.into, level.needed, level.level + 1))
        .line(format!("**Rank** {} · **Total XP** {xp} · **Messages** {messages} · **Reputation** {rep}", pos.map(|p| format!("#{p}")).unwrap_or_else(|| "—".into())));
    if settings.bool(&ev.guild, MODULE, "rankCards") {
        let style = store.data_get(&ev.guild, MODULE, &format!("card:{}", who.id)).ok().flatten().unwrap_or(Value::Null);
        let text = |k: &str| style[k].as_str().filter(|s| !s.is_empty()).map(str::to_string);
        card.art = Some(crate::Art::Rank(crate::RankArt {
            name: who.name.clone(), avatar_url: who.avatar.clone().map(|a| a.replace("size=128", "size=256")), level: level.level as i64, into: level.into, needed: level.needed,
            rank: pos, xp, messages, accent: text("accent"), accent2: text("accent2"), theme: text("theme"),
            background: if settings.bool(&ev.guild, MODULE, "cardBackgrounds") { text("background") } else { None },
            pixel: settings.bool(&ev.guild, MODULE, "pixelPictures"),
        }));
        // your own card can be styled
        if who.id == ev.member.id { card = card.button_with(format!("rankstyle:open:{}", ev.member.id), "Customise", ButtonStyle::Plain, Some("🎨".into())); }
    }
    Action::Reply { card }
}

/// The 🎨 Customise button and its popup (Good Boy 3's rankstyle): theme, two colours and a background picture.
type Uploads = std::collections::BTreeMap<String, Vec<(String, String, u64)>>;
/// Where uploaded rank card backgrounds are kept: files/community/<server>/rankbg, next to the data.
pub fn background_dir(data_dir: &std::path::Path, guild: &str) -> std::path::PathBuf {
    data_dir.join("files").join(MODULE).join(guild).join("rankbg")
}
/// A background file name as this module writes it (digits, a dash, digits, a picture extension), so it can never name another path.
pub fn ok_background_file(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else { return false };
    matches!(ext, "png" | "jpg" | "gif" | "webp") && stem.split_once('-').is_some_and(|(a, b)| !a.is_empty() && !b.is_empty() && a.bytes().chain(b.bytes()).all(|c| c.is_ascii_digit()))
}
/// Only a picture Discord itself holds may be fetched for a background.
fn ok_upload_url(url: &str) -> bool {
    (url.starts_with("https://cdn.discordapp.com/") || url.starts_with("https://media.discordapp.net/")) && url.len() <= 2000 && !url.contains(char::is_whitespace)
}
fn data_dir_of(db: &Db) -> Option<std::path::PathBuf> {
    db.get().path().parent().map(|p| p.to_path_buf())
}
/// Keeps a downloaded background as the member's card background (and removes the one it replaces).
pub fn save_background(db: &Db, guild: &str, member: &str, name: &str, bytes: &[u8], at_ms: i64) -> Result<(), String> {
    let ext = crate::welcome::image_ext(name, bytes)?;
    let dir = background_dir(&data_dir_of(db).ok_or("The data folder is not ready yet.")?, guild);
    std::fs::create_dir_all(&dir).map_err(|e| format!("The picture could not be saved ({e})."))?;
    let stored = format!("{member}-{at_ms}.{ext}");
    std::fs::write(dir.join(&stored), bytes).map_err(|e| format!("The picture could not be saved ({e})."))?;
    let key = format!("card:{member}");
    let mut cur = db.get().data_get(guild, MODULE, &key).ok().flatten().unwrap_or(Value::Null);
    if let Some(old) = cur["background"].as_str().and_then(|b| b.strip_prefix("file:")).filter(|o| *o != stored && ok_background_file(o)) { let _ = std::fs::remove_file(dir.join(old)); }
    if !cur.is_object() { cur = json!({}); }
    cur["background"] = json!(format!("file:{stored}"));
    db.get().data_set(guild, MODULE, &key, &cur).map_err(|e| e.to_string())
}
#[allow(clippy::too_many_arguments)]
pub fn rank_style(db: &Db, settings: &Settings, guild: &str, member: &str, step: &str, owner: &str, values: Option<&std::collections::BTreeMap<String, String>>, files: Option<&Uploads>) -> Vec<Action> {
    let no = |t: &str| vec![Action::Reply { card: Card::new(Area::General).line(t).private() }];
    if !owner.is_empty() && owner != member { return no("That is someone else's card. Run `/rank` for your own."); }
    let key = format!("card:{member}");
    let cur = db.get().data_get(guild, MODULE, &key).ok().flatten().unwrap_or(Value::Null);
    let backgrounds = settings.bool(guild, MODULE, "cardBackgrounds");
    let s = |k: &str| cur[k].as_str().map(str::to_string);
    if step == "open" {
        let mut fields = vec![
            crate::Field { id: "theme".into(), label: "Theme".into(), kind: crate::FieldKind::Select(CARD_THEMES.iter().map(|(v, l)| (l.to_string(), v.to_string())).collect()), required: true, value: Some(s("theme").unwrap_or_else(|| "dark".into())), ..Default::default() },
            crate::colours::pick_field("accent", "Main colour", s("accent").as_deref(), Some("Default colour")),
            crate::colours::pick_field("accent2", "Second colour", s("accent2").as_deref(), Some("Default colour")),
        ];
        if backgrounds {
            fields.push(crate::Field { id: "bgfile".into(), label: "Background picture (optional)".into(), desc: Some("Upload a picture from your phone or computer (PNG, JPG, GIF or WebP, up to 8 MB).".into()), kind: crate::FieldKind::Files { most: 1 }, ..Default::default() });
            if s("background").is_some() {
                fields.push(crate::Field { id: "bgkeep".into(), label: "Your current background".into(), kind: crate::FieldKind::Select(vec![("Keep it".into(), "keep".into()), ("Remove it".into(), "remove".into())]), required: true, value: Some("keep".into()), ..Default::default() });
            }
        }
        return vec![Action::Form { id: format!("rankstyle:save:{member}"), title: "Your rank card".into(), fields }];
    }
    let v = |k: &str| values.and_then(|m| m.get(k)).map(|x| x.trim().to_string()).filter(|x| !x.is_empty());
    // each colour is picked from the swatches (or kept, or put back to the default); a code saved earlier still works
    let colour = |k: &str| crate::colours::read(v(k).as_deref(), None).map(|c| c.resolve(s(k)));
    let (accent, accent2) = match (colour("accent"), colour("accent2")) { (Ok(a), Ok(b)) => (a, b), (Err(e), _) | (_, Err(e)) => return no(&e) };
    let upload = if backgrounds { files.and_then(|f| f.get("bgfile")).and_then(|l| l.first()) } else { None };
    if let Some((name, url, size)) = upload {
        if !ok_upload_url(url) { return no("That picture did not come from Discord, so it was not used."); }
        if *size as usize > crate::welcome::MAX_IMAGE_BYTES { return no("That picture is too big. Use one under 8 MB."); }
        if !crate::welcome::GREET_IMAGE_TYPES.contains(&name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str()) { return no("Use a PNG, JPG, GIF or WebP picture."); }
    }
    // a background already kept stays unless it is removed (or replaced by the upload)
    let remove = backgrounds && v("bgkeep").as_deref() == Some("remove");
    let background = if remove || !backgrounds { None } else { cur["background"].as_str().map(str::to_string) };
    if remove || !backgrounds {
        if let (Some(dir), Some(old)) = (data_dir_of(db), cur["background"].as_str().and_then(|b| b.strip_prefix("file:")).filter(|o| ok_background_file(o))) { let _ = std::fs::remove_file(background_dir(&dir, guild).join(old)); }
    }
    let next = json!({ "theme": v("theme").unwrap_or_else(|| "dark".into()), "accent": accent, "accent2": accent2, "background": background });
    let _ = db.get().data_set(guild, MODULE, &key, &next);
    let mut out = no(if upload.is_some() { "🎨 Saved! Your new background is being added. Run `/rank` in a few seconds." } else { "🎨 Saved! Run `/rank` to see your new card." });
    if let Some((name, url, _)) = upload { out.push(Action::SaveRankBackground { member: member.to_string(), name: name.clone(), url: url.clone() }); }
    out
}
