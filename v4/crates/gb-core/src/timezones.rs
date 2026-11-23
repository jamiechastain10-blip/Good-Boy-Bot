//! Time zones, the way Friend Time does them: members say where they are, and anyone can see what time it is for
//! them, or turn "8pm for them" into a time everyone sees in their own zone.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::settings::Fallback;
use crate::store::Data;
use crate::{Action, Area, Card, CommandEvent, Db, Def, Kind, Settings};
use jiff::tz::TimeZone;
use jiff::{Timestamp, Zoned};
use serde_json::json;

pub const MODULE: &str = "timezones";
pub static SETTINGS: &[Def] = &[
    Def { key: "showInProfile", label: "Show members' local time in /time lists", kind: Kind::Toggle, default: Fallback::Bool(true) },
];
pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec { name: "timezone", about: "Say where you are, so others can see your time", module: MODULE, options: &[], subs: &[
        Sub { name: "set", about: "Save your time zone", options: &[Opt { name: "zone", about: "A city or zone, such as London, New York, EST or UTC+2", takes: Takes::Text, required: true }] },
        Sub { name: "clear", about: "Forget your time zone", options: &[] },
        Sub { name: "list", about: "What time it is for everyone who shared a zone", options: &[] },
    ] },
    CommandSpec { name: "time", about: "What time it is for someone, or turn a time into everyone's own", module: MODULE, options: &[
        Opt { name: "member", about: "Whose time (yours if empty)", takes: Takes::Member, required: false },
        Opt { name: "at", about: "A time for them, such as 8pm or 20:30: shown in each person's own zone", takes: Takes::Text, required: false },
    ], subs: &[] },
];

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
/// Names people type for zones that are not in the database's list.
const ALIASES: &[(&str, &str)] = &[
    ("est", "America/New_York"), ("edt", "America/New_York"), ("eastern", "America/New_York"), ("cst", "America/Chicago"), ("cdt", "America/Chicago"), ("central", "America/Chicago"),
    ("mst", "America/Denver"), ("mdt", "America/Denver"), ("mountain", "America/Denver"), ("pst", "America/Los_Angeles"), ("pdt", "America/Los_Angeles"), ("pacific", "America/Los_Angeles"),
    ("akst", "America/Anchorage"), ("hst", "Pacific/Honolulu"), ("gmt", "Etc/GMT"), ("utc", "UTC"), ("bst", "Europe/London"), ("uk", "Europe/London"), ("cet", "Europe/Paris"), ("cest", "Europe/Paris"),
    ("eet", "Europe/Athens"), ("eest", "Europe/Athens"), ("ist", "Asia/Kolkata"), ("india", "Asia/Kolkata"), ("jst", "Asia/Tokyo"), ("japan", "Asia/Tokyo"), ("kst", "Asia/Seoul"), ("korea", "Asia/Seoul"),
    ("aest", "Australia/Sydney"), ("aedt", "Australia/Sydney"), ("acst", "Australia/Adelaide"), ("awst", "Australia/Perth"), ("nzst", "Pacific/Auckland"), ("nzdt", "Pacific/Auckland"),
    ("china", "Asia/Shanghai"), ("hong kong", "Asia/Hong_Kong"), ("singapore", "Asia/Singapore"), ("brazil", "America/Sao_Paulo"), ("mexico", "America/Mexico_City"), ("california", "America/Los_Angeles"),
    ("texas", "America/Chicago"), ("florida", "America/New_York"), ("new york", "America/New_York"), ("los angeles", "America/Los_Angeles"), ("san francisco", "America/Los_Angeles"),
    ("germany", "Europe/Berlin"), ("france", "Europe/Paris"), ("spain", "Europe/Madrid"), ("italy", "Europe/Rome"), ("poland", "Europe/Warsaw"), ("turkey", "Europe/Istanbul"), ("dubai", "Asia/Dubai"),
    ("egypt", "Africa/Cairo"), ("south africa", "Africa/Johannesburg"), ("canada", "America/Toronto"), ("philippines", "Asia/Manila"), ("indonesia", "Asia/Jakarta"), ("thailand", "Asia/Bangkok"),
];
/// "UTC+2", "+05:30", "GMT-4" as a fixed offset.
fn parse_offset(text: &str) -> Option<TimeZone> {
    let t = text.trim().to_lowercase();
    let t = t.strip_prefix("utc").or_else(|| t.strip_prefix("gmt")).unwrap_or(&t).trim();
    let (sign, rest) = match t.chars().next()? { '+' => (1, &t[1..]), '-' | '\u{2212}' => (-1, &t[t.chars().next()?.len_utf8()..]), _ => return None };
    let (h, m) = rest.split_once(':').unwrap_or((rest, "0"));
    let (h, m): (i32, i32) = (h.trim().parse().ok()?, m.trim().parse().ok()?);
    if !(0..=14).contains(&h) || !(0..60).contains(&m) { return None; }
    jiff::tz::Offset::from_seconds(sign * (h * 3600 + m * 60)).ok().map(TimeZone::fixed)
}
/// A zone from what a member typed: a database name, an alias, a city, or an offset. Returns the zone and the name to keep.
pub fn resolve(input: &str) -> Option<(TimeZone, String)> {
    let raw = input.trim();
    if raw.is_empty() || raw.len() > 60 { return None; }
    if let Some(z) = parse_offset(raw) { return Some((z, raw.to_uppercase().replace(' ', ""))); }
    let key = raw.to_lowercase();
    let named = ALIASES.iter().find(|(a, _)| *a == key).map(|(_, z)| z.to_string());
    let try_name = |n: &str| TimeZone::get(n).ok().map(|z| (z, n.to_string()));
    if let Some(n) = named { if let Some(r) = try_name(&n) { return Some(r); } }
    if let Some(r) = try_name(raw) { return Some(r); }
    // a city: the last part of a database name ("new york" is America/New_York)
    let want = key.replace(' ', "_");
    let mut hit: Option<String> = None;
    for name in jiff::tz::db().available() {
        let n = name.as_str();
        if n.to_lowercase().rsplit('/').next() == Some(want.as_str()) { hit = Some(n.to_string()); break; }
    }
    hit.and_then(|n| try_name(&n))
}
/// "8pm", "8:30 pm", "20:30", "8" as (hour, minute).
pub fn parse_clock(input: &str) -> Option<(i8, i8)> {
    let t = input.trim().to_lowercase().replace(' ', "");
    let (body, pm, am) = if let Some(b) = t.strip_suffix("pm") { (b, true, false) } else if let Some(b) = t.strip_suffix("am") { (b, false, true) } else { (t.as_str(), false, false) };
    let (h, m) = body.split_once([':', '.']).unwrap_or((body, "0"));
    let (mut h, m): (i8, i8) = (h.parse().ok()?, m.parse().ok()?);
    if !(0..60).contains(&m) { return None; }
    if pm || am {
        if !(1..=12).contains(&h) { return None; }
        if pm && h != 12 { h += 12; }
        if am && h == 12 { h = 0; }
    }
    if !(0..24).contains(&h) { return None; }
    Some((h, m))
}
/// The next moment it is `h:m` on the wall clock in `zone`, after `now_ms`.
pub fn next_at(zone: &TimeZone, h: i8, m: i8, now_ms: i64) -> Option<i64> {
    let now = Timestamp::from_millisecond(now_ms).ok()?.to_zoned(zone.clone());
    let today = now.date().at(h, m, 0, 0).to_zoned(zone.clone()).ok()?;
    let chosen = if today.timestamp() > now.timestamp() { today } else { now.date().tomorrow().ok()?.at(h, m, 0, 0).to_zoned(zone.clone()).ok()? };
    Some(chosen.timestamp().as_millisecond())
}
/// The moment it is `h:m` on the wall clock in `zone`, `days` days from today (0 = today, 1 = tomorrow).
pub fn on_day(zone: &TimeZone, days: i64, h: i8, m: i8, now_ms: i64) -> Option<i64> {
    let now = Timestamp::from_millisecond(now_ms).ok()?.to_zoned(zone.clone());
    let date = if days == 0 { now.date() } else { now.date().checked_add(jiff::Span::new().days(days)).ok()? };
    Some(date.at(h, m, 0, 0).to_zoned(zone.clone()).ok()?.timestamp().as_millisecond())
}
/// The moment of a calendar date and wall-clock time in `zone`.
pub fn at_civil(zone: &TimeZone, year: i16, month: i8, day: i8, h: i8, m: i8) -> Option<i64> {
    Some(jiff::civil::date(year, month, day).at(h, m, 0, 0).to_zoned(zone.clone()).ok()?.timestamp().as_millisecond())
}
fn clock_text(z: &Zoned) -> String {
    z.strftime("%a %-I:%M %p").to_string().replace(" 0:", " 12:")
}

pub struct TimeZones<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub guild: &'a str,
}
impl TimeZones<'_> {
    fn data(&self) -> Data<'_> { Data { db: self.db, guild: self.guild, module: MODULE } }
    /// The zone a member saved (its name).
    pub fn zone_name(&self, user: &str) -> Option<String> {
        self.data().get(&format!("tz:{user}")).and_then(|v| v["zone"].as_str().map(str::to_string))
    }
    /// The time zone a member saved, if any.
    pub fn zone_for(&self, user: &str) -> Option<TimeZone> { self.zone_of(user).map(|(z, _)| z) }
    fn zone_of(&self, user: &str) -> Option<(TimeZone, String)> {
        let name = self.zone_name(user)?;
        resolve(&name)
    }
    pub fn command(&self, ev: &CommandEvent) -> Vec<Action> {
        if ev.name == "time" { return self.time(ev); }
        match ev.sub.as_deref().unwrap_or("list") {
            "set" => {
                let Some((zone, name)) = ev.args.get("zone").and_then(|z| resolve(z)) else { return private("I don't know that place. Try a city (London, New York), a zone name (America/Chicago), EST, or an offset such as UTC+2.") };
                self.data().set(&format!("tz:{}", ev.member.id), &json!({ "zone": name }));
                let now = Timestamp::now().to_zoned(zone);
                private(format!("🕒 Saved: **{name}**. It's {} for you right now.", clock_text(&now)))
            }
            "clear" => { self.data().delete(&format!("tz:{}", ev.member.id)); private("Your time zone was forgotten.") }
            _ => self.list(ev.at_ms),
        }
    }
    fn list(&self, now_ms: i64) -> Vec<Action> {
        let mut by_zone: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        for (key, v) in self.data().list("tz:") {
            let (Some(zone), Some(user)) = (v["zone"].as_str(), key.strip_prefix("tz:")) else { continue };
            by_zone.entry(zone.to_string()).or_default().push(user.to_string());
        }
        if by_zone.is_empty() { return private("Nobody has shared a time zone yet. Use `/timezone set`."); }
        let Ok(ts) = Timestamp::from_millisecond(now_ms) else { return private("The clock is not set.") };
        let mut rows: Vec<(i64, String)> = by_zone.into_iter().filter_map(|(name, users)| {
            let (zone, _) = resolve(&name)?;
            let z = ts.to_zoned(zone);
            let offset = z.offset().seconds() as i64;
            let who: Vec<String> = users.iter().take(8).map(|u| format!("<@{u}>")).collect();
            Some((offset, format!("**{}** · {}\n{}{}", clock_text(&z), name, who.join(" "), if users.len() > 8 { format!(" +{} more", users.len() - 8) } else { String::new() })))
        }).collect();
        rows.sort_by_key(|r| r.0);
        let mut card = Card::new(Area::General).title("🕒 Time around the server");
        for (_, line) in rows.into_iter().take(15) { card = card.line(line); }
        vec![Action::Reply { card: card.private() }]
    }
    fn time(&self, ev: &CommandEvent) -> Vec<Action> {
        let who = ev.target.clone().unwrap_or_else(|| ev.member.clone());
        let Some((zone, name)) = self.zone_of(&who.id) else {
            return private(if who.id == ev.member.id { "You haven't said where you are. Use `/timezone set`.".to_string() } else { format!("<@{}> hasn't shared a time zone.", who.id) });
        };
        match ev.args.get("at").map(|a| a.trim()).filter(|a| !a.is_empty()) {
            None => {
                let z = Timestamp::from_millisecond(ev.at_ms).map(|t| t.to_zoned(zone)).ok();
                let Some(z) = z else { return private("The clock is not set.") };
                vec![Action::Reply { card: Card::new(Area::General).line(format!("🕒 It's **{}** for <@{}> ({name}).", clock_text(&z), who.id)).private() }]
            }
            Some(at) => {
                let Some((h, m)) = parse_clock(at) else { return private("Say a time like `8pm`, `8:30 pm` or `20:30`.") };
                let Some(ms) = next_at(&zone, h, m, ev.at_ms) else { return private("I couldn't work that time out.") };
                let unix = ms / 1000;
                vec![Action::Reply { card: Card::new(Area::General).line(format!("🕒 When it's **{at}** for <@{}> ({name}), it's <t:{unix}:t> on <t:{unix}:D> for you: <t:{unix}:R>.", who.id)).private() }]
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn zones_come_from_cities_names_abbreviations_and_offsets() {
        assert_eq!(resolve("America/New_York").unwrap().1, "America/New_York");
        assert_eq!(resolve("new york").unwrap().1, "America/New_York");
        assert_eq!(resolve("London").unwrap().1, "Europe/London");
        assert_eq!(resolve("EST").unwrap().1, "America/New_York");
        assert_eq!(resolve("Tokyo").unwrap().1, "Asia/Tokyo");
        let (z, name) = resolve("UTC+5:30").unwrap();
        assert_eq!(name, "UTC+5:30");
        assert_eq!(Timestamp::from_millisecond(0).unwrap().to_zoned(z).offset().seconds(), 19800);
        assert_eq!(Timestamp::from_millisecond(0).unwrap().to_zoned(resolve("-8").unwrap().0).offset().seconds(), -28800);
        assert!(resolve("Narnia").is_none() && resolve("").is_none() && resolve("UTC+99").is_none());
    }
    #[test]
    fn clock_times_are_read_as_people_type_them() {
        for (t, want) in [("8pm", (20, 0)), ("8:30 pm", (20, 30)), ("20:30", (20, 30)), ("12am", (0, 0)), ("12pm", (12, 0)), ("7", (7, 0)), ("9.15am", (9, 15))] {
            assert_eq!(parse_clock(t), Some(want), "{t}");
        }
        assert!(parse_clock("25:00").is_none() && parse_clock("13pm").is_none() && parse_clock("soon").is_none());
    }
    #[test]
    fn the_next_time_it_is_8pm_in_a_zone_follows_daylight_saving() {
        let ny = resolve("America/New_York").unwrap().0;
        // 2026-07-01 12:00 UTC is 08:00 in New York (summer): 8pm there is 00:00 UTC the next day
        let noon_utc = 1_782_907_200_000i64;
        assert_eq!(next_at(&ny, 20, 0, noon_utc), Some(noon_utc + 12 * 3_600_000));
        // in winter (UTC-5) 8pm is 01:00 UTC
        let winter_noon = 1_798_804_800_000i64; // 2027-01-01 12:00 UTC = 07:00 in New York
        assert_eq!(next_at(&ny, 20, 0, winter_noon), Some(winter_noon + 13 * 3_600_000));
        // a time that has passed today is tomorrow's
        assert_eq!(next_at(&ny, 6, 0, noon_utc), Some(noon_utc + 22 * 3_600_000));
    }
}
