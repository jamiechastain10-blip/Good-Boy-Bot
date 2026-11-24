//! Every command is a popup, the way Good Boy 3 does it (its `autopopup`). Commands reach Discord without their
//! typed boxes, so the command bar never asks for text. When a command that has boxes runs, a popup built from
//! them opens instead, and the command runs with the answers exactly as if they had been typed:
//!
//!   text            -> text fields (reasons, messages and other long ones as tall boxes)
//!   choices, yes/no -> dropdowns
//!   whole numbers   -> number fields, checked against the box's lowest and highest
//!   members, channels, roles -> Discord's pickers
//!
//! Picking a part of a grouped command is not typing, so those stay. A popup holds at most 5 fields; a command
//! with more is asked in parts: each part is kept for 15 minutes and a "Continue" button opens the next.
//! Commands that open their own popup are listed in `OWN_POPUP` and left alone.

use crate::bot::{commands, CommandSpec, Opt, Takes};
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Field, FormEvent, Member};
use crate::event::FieldKind;
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

pub const MAX_FIELDS: usize = 5;
pub const MAX_LABEL: usize = 45;
const NS: &str = "gbc";
const DRAFT_MS: i64 = 15 * 60_000;

/// Commands (and parts) that open a popup of their own, as in Good Boy 3. Empty until those popups are rebuilt.
pub const OWN_POPUP: &[(&str, &str)] = &[("ticket", "panel"), ("ticket", "setup"), ("warn", "*"), ("rolemenu", "create"), ("greeting", "*"), ("images", "add"), ("verify", "setup"), ("introduce", "*"), ("pay", "*"), ("economy-admin", "*"), ("remind", "team"), ("giveaway", "start"), ("id", "edit"), ("party", "create"), ("deadchat", "*"), ("poll", "create"), ("suggest", "*"), ("suggestion", "edit"), ("announce", "*")];
pub fn owns_popup(name: &str, sub: Option<&str>) -> bool {
    OWN_POPUP.iter().any(|(n, s)| *n == name && (*s == "*" || Some(*s) == sub))
}

/// "remind_at" -> "Remind at"
pub fn humanize(name: &str) -> String {
    let spaced: String = name.chars().map(|c| if c == '_' || c == '-' { ' ' } else { c }).collect();
    let mut s = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    if let Some(first) = s.get(0..1) { s = first.to_uppercase() + &s[1..]; }
    s
}
fn long_name(name: &str) -> bool {
    matches!(name, "reason" | "message" | "text" | "content" | "description" | "idea" | "note" | "notes" | "bio" | "body" | "summary" | "details" | "question")
}
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}

/// The boxes of the command (or the part of it) that ran.
pub fn leaf_options(spec: &CommandSpec, sub: Option<&str>) -> &'static [Opt] {
    match sub {
        Some(s) if !spec.subs.is_empty() => spec.subs.iter().find(|x| x.name == s).map(|x| x.options).unwrap_or(&[]),
        _ => spec.options,
    }
}

/// Popup fields for a list of boxes.
pub fn fields_for(opts: &[Opt]) -> Vec<Field> {
    opts.iter().map(|o| {
        let mut label = humanize(o.name);
        if label.chars().count() > MAX_LABEL { label = label.chars().take(MAX_LABEL).collect(); }
        let desc = (!o.about.is_empty() && o.about != label).then(|| truncate(o.about, 100));
        let base = Field { id: o.name.to_string(), label, desc, required: o.required, ..Default::default() };
        match o.takes {
            Takes::Choice(list) => Field { kind: FieldKind::Select(list.iter().take(25).map(|(n, v)| (truncate(n, 100), v.to_string())).collect()), ..base },
            Takes::YesNo => Field { kind: FieldKind::Select(vec![("Yes".into(), "true".into()), ("No".into(), "false".into())]), ..base },
            Takes::Whole { min, max } => Field { max: 20, placeholder: Some(format!("{min} to {max}")), ..base },
            Takes::Member => Field { kind: FieldKind::User { most: 1 }, ..base },
            Takes::Channel => Field { kind: FieldKind::Channel(vec![0, 5]), ..base },
            Takes::Category => Field { kind: FieldKind::Channel(vec![4]), ..base },
            Takes::AnyChannel => Field { kind: FieldKind::Channel(vec![0, 2, 4, 5, 13, 15]), ..base },
            Takes::Role => Field { kind: FieldKind::Role { most: 1 }, ..base },
            Takes::Text => Field { long: long_name(o.name), max: 4000, ..base },
        }
    }).collect()
}
pub fn page_count(opts: &[Opt]) -> usize {
    opts.len().div_ceil(MAX_FIELDS).max(1)
}
fn page_of(opts: &'static [Opt], page: usize) -> &'static [Opt] {
    let start = (page * MAX_FIELDS).min(opts.len());
    &opts[start..(start + MAX_FIELDS).min(opts.len())]
}

/// Where a popup or its "Continue" button belongs: who may use it, which command, which part.
#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    /// "s" submits a part; "o" opens one (the Continue and Try again buttons).
    pub step: String,
    pub owner: String,
    pub name: String,
    pub sub: Option<String>,
    pub page: usize,
    pub draft: String,
}
impl Token {
    pub fn pack(&self) -> String {
        format!("{NS}:{}:{}:{}:{}:{}:{}", self.step, self.owner, self.name, self.sub.as_deref().unwrap_or("-"), self.page, self.draft)
    }
    pub fn read(id: &str) -> Option<Token> {
        let p: Vec<&str> = id.split(':').collect();
        if p.len() != 7 || p[0] != NS { return None; }
        Some(Token { step: p[1].into(), owner: p[2].into(), name: p[3].into(), sub: (p[4] != "-").then(|| p[4].to_string()), page: p[5].parse().ok()?, draft: p[6].into() })
    }
}

/// The popup for a part of a command's boxes.
pub fn popup(spec: &CommandSpec, sub: Option<&str>, owner: &str, page: usize, draft: &str) -> Action {
    let opts = leaf_options(spec, sub);
    let pages = page_count(opts);
    let mut title = format!("/{}", [Some(spec.name), sub].into_iter().flatten().collect::<Vec<_>>().join(" "));
    if pages > 1 { title.push_str(&format!(" ({} of {pages})", page + 1)); }
    let id = Token { step: "s".into(), owner: owner.into(), name: spec.name.into(), sub: sub.map(str::to_string), page, draft: draft.into() }.pack();
    Action::Form { id, title: truncate(&title, 45), fields: fields_for(page_of(opts, page)) }
}

/// Answers from earlier parts of a long popup, until the last part is in.
#[derive(Default)]
pub struct Drafts(Mutex<HashMap<String, Draft>>);
/// (whose it is, the answers so far, the members picked so far, when it runs out)
type Draft = (String, BTreeMap<String, String>, Vec<Member>, i64);
impl Drafts {
    fn save(&self, id: &str, owner: &str, raw: &BTreeMap<String, String>, members: &[Member], now: i64) -> Result<String, String> {
        let mut all = self.0.lock().unwrap_or_else(|p| p.into_inner());
        all.retain(|_, v| v.3 > now);
        let key = if id == "-" { format!("{:08x}", (now as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 32 ^ all.len() as u64) } else { id.to_string() };
        let entry = all.entry(key.clone()).or_insert_with(|| (owner.to_string(), BTreeMap::new(), Vec::new(), 0));
        if entry.0 != owner { return Err("That form belongs to someone else.".into()); }
        entry.1.extend(raw.iter().map(|(k, v)| (k.clone(), v.clone())));
        entry.2.extend(members.iter().cloned());
        entry.3 = now + DRAFT_MS;
        Ok(key)
    }
    fn take(&self, id: &str, owner: &str, now: i64) -> Result<(BTreeMap<String, String>, Vec<Member>), String> {
        if id == "-" { return Ok(Default::default()); }
        let mut all = self.0.lock().unwrap_or_else(|p| p.into_inner());
        match all.get(id) {
            Some(d) if d.3 > now && d.0 != owner => Err("That form belongs to someone else.".into()),
            Some(d) if d.3 > now => Ok(all.remove(id).map(|d| (d.1, d.2)).unwrap_or_default()),
            _ => Err("The earlier part of this form expired. Run the command again.".into()),
        }
    }
}

fn private(card: Card) -> Vec<Action> {
    vec![Action::Reply { card: card.private() }]
}
fn button_for(token: &Token, label: &str, emoji: &str) -> Card {
    Card::new(Area::General).button_with(token.pack(), label, ButtonStyle::Primary, Some(emoji.into()))
}

/// Checks the answers and turns them into the command's boxes, as if typed. Good Boy 3's own wording.
pub fn read_answers(opts: &[Opt], raw: &BTreeMap<String, String>, members: &[Member]) -> Result<(BTreeMap<String, String>, Vec<Member>), String> {
    let mut args = BTreeMap::new();
    let mut picked = Vec::new();
    for o in opts {
        let label = humanize(o.name);
        let v = raw.get(o.name).map(|s| s.trim()).filter(|s| !s.is_empty());
        let Some(v) = v else {
            if o.required { return Err(format!("Fill in **{label}**.")); }
            continue;
        };
        match o.takes {
            Takes::Whole { min, max } => {
                let cleaned: String = v.chars().filter(|c| !matches!(c, ',' | ' ' | '_')).collect();
                let n: f64 = cleaned.parse().map_err(|_| format!("**{label}** must be a whole number."))?;
                if !n.is_finite() || n.fract() != 0.0 { return Err(format!("**{label}** must be a whole number.")); }
                let n = n as i64;
                if n < min { return Err(format!("**{label}** must be at least {min}.")); }
                if n > max { return Err(format!("**{label}** can be at most {max}.")); }
                args.insert(o.name.to_string(), n.to_string());
            }
            Takes::Member => {
                let who = members.iter().find(|m| m.id == v).cloned().unwrap_or_else(|| Member { id: v.to_string(), name: v.to_string(), ..Default::default() });
                picked.push(who);
            }
            _ => { args.insert(o.name.to_string(), v.to_string()); }
        }
    }
    Ok((args, picked))
}

/// A command that ran with nothing filled in: its popup, when it has boxes and does not open its own.
pub fn ask(ev: &CommandEvent) -> Option<Action> {
    if ev.from_form || !ev.args.is_empty() || ev.target.is_some() || owns_popup(&ev.name, ev.sub.as_deref()) { return None; }
    let spec = commands().find(|c| c.name == ev.name)?;
    if leaf_options(spec, ev.sub.as_deref()).is_empty() { return None; }
    Some(popup(spec, ev.sub.as_deref(), &ev.member.id, 0, "-"))
}

/// What happened with a submitted part.
pub enum Answered {
    /// Answer with these (a saved part, or what to fix).
    Say(Vec<Action>),
    /// Every part is in: run the command.
    Run(Box<CommandEvent>),
}

/// A popup part was submitted.
pub fn submitted(ev: &FormEvent, drafts: &Drafts) -> Option<Answered> {
    let t = Token::read(&ev.id)?;
    if t.owner != ev.member.id { return Some(Answered::Say(private(Card::new(Area::General).line("That form belongs to someone else.")))); }
    let Some(spec) = commands().find(|c| c.name == t.name) else { return Some(Answered::Say(private(Card::new(Area::General).line("That command is not in this version any more.")))) };
    let opts = leaf_options(spec, t.sub.as_deref());
    let pages = page_count(opts);
    let again = Token { step: "o".into(), page: 0, draft: "-".into(), ..t.clone() };
    let fail = |why: String| Answered::Say(private(button_for(&again, "Try again", "✏️").line(format!("❌ {why}"))));
    // only this part's answers count from this popup
    let here: Vec<&str> = page_of(opts, t.page).iter().map(|o| o.name).collect();
    let raw: BTreeMap<String, String> = ev.values.iter().filter(|(k, _)| here.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    if t.page + 1 < pages {
        // not the last part yet: keep these answers and offer the next part
        return Some(match drafts.save(&t.draft, &ev.member.id, &raw, &ev.members, ev.at_ms) {
            Ok(draft) => {
                let next = Token { step: "o".into(), page: t.page + 1, draft, ..t.clone() };
                Answered::Say(private(button_for(&next, &format!("Continue (part {} of {pages})", t.page + 2), "➡️").line(format!("✅ Part {} of {pages} saved. Press **Continue** for the rest.", t.page + 1))))
            }
            Err(why) => fail(why),
        });
    }
    let (mut all, mut members) = match drafts.take(&t.draft, &ev.member.id, ev.at_ms) { Ok(d) => d, Err(why) => return Some(fail(why)) };
    all.extend(raw);
    members.extend(ev.members.iter().cloned());
    match read_answers(opts, &all, &members) {
        Err(why) => Some(fail(why)),
        Ok((args, picked)) => {
            let mut picked = picked.into_iter();
            Some(Answered::Run(Box::new(CommandEvent {
                guild: ev.guild.clone(), place: ev.place.clone(), member: ev.member.clone(), name: t.name.clone(), sub: t.sub.clone(),
                target: picked.next(), target2: picked.next(), args, at_ms: ev.at_ms, from_form: true,
            })))
        }
    }
}

/// The "Continue" or "Try again" button: the popup for that part.
pub fn reopen(ev: &ButtonEvent) -> Option<Vec<Action>> {
    let t = Token::read(&ev.id)?;
    if t.owner != ev.member.id { return Some(private(Card::new(Area::General).line("That form belongs to someone else."))); }
    let spec = commands().find(|c| c.name == t.name)?;
    Some(vec![popup(spec, t.sub.as_deref(), &t.owner, t.page, &t.draft)])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_command_popup_fits_discords_limits() {
        for spec in commands() {
            let subs: Vec<Option<&str>> = if spec.subs.is_empty() { vec![None] } else { spec.subs.iter().map(|s| Some(s.name)).collect() };
            for sub in subs {
                let opts = leaf_options(spec, sub);
                for page in 0..page_count(opts) {
                    let Action::Form { id, title, fields } = popup(spec, sub, "123456789012345678", page, "-") else { unreachable!() };
                    assert!(id.len() <= 100, "{id}");
                    assert!(title.chars().count() <= 45);
                    assert!(fields.len() <= MAX_FIELDS);
                    for f in &fields {
                        assert!(f.label.chars().count() <= MAX_LABEL, "{}", f.label);
                        assert!(f.desc.as_ref().is_none_or(|d| d.chars().count() <= 100));
                        if let FieldKind::Select(list) = &f.kind { assert!(!list.is_empty() && list.len() <= 25); }
                    }
                }
            }
        }
    }
    #[test]
    fn tokens_read_back() {
        let t = Token { step: "s".into(), owner: "42".into(), name: "money".into(), sub: Some("pay".into()), page: 1, draft: "ab12cd34".into() };
        assert_eq!(Token::read(&t.pack()), Some(t));
        assert_eq!(Token::read("ticket:open:bot"), None);
    }
}
