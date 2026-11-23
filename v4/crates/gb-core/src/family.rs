//! Good Boy 3's families: marry, divorce, adopt, disown, leave your family, and a family tree picture.
//! Families are per server. The rules (no marrying family, one parent per child, limits), the tree's shape, its text
//! version and its wording are Good Boy 3's.

use crate::bot::{CommandSpec, Opt, Sub, Takes};
use crate::perms::{self, Level, Perm};
use crate::settings::Fallback;
use crate::store::Data;
use crate::{Action, Area, Art, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Def, Kind, Settings};
use gb_art::TreeUnit;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};

pub const MODULE: &str = "family";
pub const USE: Perm = Perm { key: "family.use", level: Level::Everyone };
pub static SETTINGS: &[Def] = &[
    Def { key: "maxPartners", label: "How many partners one person can have", kind: Kind::Number { min: 1, max: 5 }, default: Fallback::Int(1) },
    Def { key: "maxChildren", label: "How many children one person can adopt", kind: Kind::Number { min: 1, max: 30 }, default: Fallback::Int(10) },
    Def { key: "pictures", label: "Show family trees as pictures (text otherwise)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "pixelPictures", label: "Draw profile pictures in family trees as pixel art", kind: Kind::Toggle, default: Fallback::Bool(true) },
];
const MEMBER: Opt = Opt { name: "member", about: "Who (you if empty)", takes: Takes::Member, required: false };
pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec { name: "marry", about: "Ask someone to marry you", module: MODULE, options: &[Opt { name: "member", about: "Who to propose to", takes: Takes::Member, required: true }], subs: &[] },
    CommandSpec { name: "family", about: "Your family: tree, adopt, divorce and more", module: MODULE, options: &[], subs: &[
        Sub { name: "tree", about: "See a family tree", options: &[Opt { name: "member", about: "Whose family (you if empty)", takes: Takes::Member, required: false }] },
        Sub { name: "info", about: "Partner, parent, children and siblings", options: &[MEMBER] },
        Sub { name: "adopt", about: "Ask someone to join your family as your child", options: &[Opt { name: "member", about: "Who to adopt", takes: Takes::Member, required: true }] },
        Sub { name: "divorce", about: "End a marriage", options: &[Opt { name: "partner", about: "Only needed if you have more than one partner", takes: Takes::Member, required: false }] },
        Sub { name: "disown", about: "Remove one of your children from your family", options: &[Opt { name: "member", about: "Which child", takes: Takes::Member, required: true }] },
        Sub { name: "leave", about: "Leave your parent's family", options: &[] },
    ] },
];
const PROPOSAL_MS: i64 = 10 * 60_000;
const PINK: u32 = 0xff6b9a;
const BLUE: u32 = 0x6b93ff;
const GREY: u32 = 0x95a5a6;

/// Married pairs (both ways) and parent → child links.
#[derive(Debug, Default)]
pub struct Graph {
    pub partners: BTreeMap<String, BTreeSet<String>>,
    pub parent_of: BTreeMap<String, String>,
    pub children_of: BTreeMap<String, Vec<String>>,
}
impl Graph {
    pub fn build(partners: &[(String, String)], kids: &[(String, String)]) -> Graph {
        let mut g = Graph::default();
        for (a, b) in partners {
            g.partners.entry(a.clone()).or_default().insert(b.clone());
            g.partners.entry(b.clone()).or_default().insert(a.clone());
        }
        for (parent, child) in kids {
            g.parent_of.insert(child.clone(), parent.clone());
            g.children_of.entry(parent.clone()).or_default().push(child.clone());
        }
        g
    }
    fn partners_of(&self, id: &str) -> Vec<String> {
        self.partners.get(id).map(|s| s.iter().cloned().collect()).unwrap_or_default()
    }
    fn kids_of(&self, id: &str) -> Vec<String> {
        self.children_of.get(id).cloned().unwrap_or_default()
    }
    /// Everyone connected by marriage or parenthood (the whole family), at most 500.
    pub fn family_of(&self, id: &str) -> HashSet<String> {
        let mut seen: HashSet<String> = [id.to_string()].into();
        let mut queue: VecDeque<String> = [id.to_string()].into();
        while let Some(x) = queue.pop_front() {
            if seen.len() >= 500 { break; }
            let next = self.partners_of(&x).into_iter().chain(self.kids_of(&x)).chain(self.parent_of.get(&x).cloned());
            for y in next { if seen.insert(y.clone()) { queue.push_back(y); } }
        }
        seen
    }
    /// Why a and b can't marry, or None.
    pub fn marry_problem(&self, a: &str, b: &str, max_partners: usize) -> Option<String> {
        let n = |x: &str| self.partners.get(x).map(BTreeSet::len).unwrap_or(0);
        if a == b { return Some("You can't marry yourself.".into()); }
        if self.partners.get(a).is_some_and(|s| s.contains(b)) { return Some("You're already married to them.".into()); }
        if n(a) >= max_partners { return Some(if max_partners == 1 { "You're already married. Divorce first with `/family divorce`.".into() } else { format!("You already have {max_partners} partners, the most this server allows.") }); }
        if n(b) >= max_partners { return Some(if max_partners == 1 { "They're already married.".into() } else { format!("They already have {max_partners} partners.") }); }
        if self.family_of(a).contains(b) { return Some("You're already in the same family, so you can't marry them.".into()); }
        None
    }
    /// Why parent can't adopt child, or None.
    pub fn adopt_problem(&self, parent: &str, child: &str, max_children: usize) -> Option<String> {
        if parent == child { return Some("You can't adopt yourself.".into()); }
        if self.parent_of.get(child).map(String::as_str) == Some(parent) { return Some("They're already your child.".into()); }
        if self.parent_of.contains_key(child) { return Some("They already have a parent. They can leave that family with `/family leave` first.".into()); }
        if self.children_of.get(parent).map(Vec::len).unwrap_or(0) >= max_children { return Some(format!("You already have {max_children} children, the most this server allows.")); }
        if self.family_of(parent).contains(child) { return Some("They're already in your family.".into()); }
        None
    }
    /// The top of the family line: up through parents (and a partner's parents) as far as possible.
    pub fn root_of(&self, id: &str) -> String {
        let mut cur = id.to_string();
        let mut seen = HashSet::new();
        loop {
            seen.insert(cur.clone());
            let up = self.parent_of.get(&cur).cloned().or_else(|| self.partners_of(&cur).iter().find_map(|p| self.parent_of.get(p).cloned()));
            match up { Some(u) if !seen.contains(&u) => cur = u, _ => return cur }
        }
    }
    /// The tree as nested units; each person once, at most 80 people and 12 generations.
    pub fn tree_from(&self, root: &str) -> Option<TreeUnit> {
        fn unit(g: &Graph, id: &str, depth: usize, placed: &mut HashSet<String>) -> Option<TreeUnit> {
            if placed.contains(id) || placed.len() >= 80 || depth > 12 { return None; }
            let people: Vec<String> = std::iter::once(id.to_string()).chain(g.partners_of(id).into_iter().filter(|p| !placed.contains(p))).collect();
            for p in &people { placed.insert(p.clone()); }
            let mut kids: Vec<String> = Vec::new();
            for k in people.iter().flat_map(|p| g.kids_of(p)) { if !kids.contains(&k) { kids.push(k); } }
            let children = kids.iter().filter_map(|k| unit(g, k, depth + 1, placed)).collect();
            Some(TreeUnit { people, children })
        }
        unit(self, root, 0, &mut HashSet::new())
    }
}
/// The tree as text (Good Boy 3's treeText).
pub fn tree_text(u: &TreeUnit, name: &dyn Fn(&str) -> String, highlight: Option<&str>) -> String {
    let label = |ids: &[String]| ids.iter().map(|id| if Some(id.as_str()) == highlight { format!("**{}**", name(id)) } else { name(id) }).collect::<Vec<_>>().join(" ❤️ ");
    fn walk(n: &TreeUnit, prefix: &str, last: bool, top: bool, label: &dyn Fn(&[String]) -> String, lines: &mut Vec<String>) {
        lines.push(if top { format!("👑 {}", label(&n.people)) } else { format!("{prefix}{} {}", if last { '└' } else { '├' }, label(&n.people)) });
        let next = if top { String::new() } else { format!("{prefix}{}", if last { "  " } else { "│ " }) };
        for (k, c) in n.children.iter().enumerate() { walk(c, &next, k + 1 == n.children.len(), false, label, lines); }
    }
    let mut lines = Vec::new();
    walk(u, "", true, true, &label, &mut lines);
    lines.join("\n")
}

/// What the Discord layer needs to draw a family tree (avatars are looked up there).
#[derive(Debug, Clone, PartialEq)]
pub struct FamilyArt {
    pub tree: TreeUnit,
    pub names: Vec<(String, String)>,
    pub highlight: String,
    pub title: String,
    /// The text tree's line on the card, taken out when the picture is shown.
    pub text: String,
    /// Draw the profile pictures as pixel art (the server's choice).
    pub pixel: bool,
}

fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::General).line(text).private() }]
}
fn coloured(c: u32) -> Card {
    let mut card = Card::new(Area::General);
    card.accent = Some(c);
    card
}
fn since(t: i64) -> String {
    format!("<t:{}:D>", t / 1000)
}

pub struct Family<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub guild: &'a str,
}
impl Family<'_> {
    fn data(&self) -> Data<'_> {
        Data { db: self.db, guild: self.guild, module: MODULE }
    }
    fn graph(&self) -> Graph {
        let (p, k) = self.db.get().family_all(self.guild).unwrap_or_default();
        Graph::build(&p, &k)
    }
    fn limits(&self) -> (usize, usize) {
        (self.settings.int(self.guild, MODULE, "maxPartners").max(1) as usize, self.settings.int(self.guild, MODULE, "maxChildren").max(1) as usize)
    }
    fn propose(&self, kind: &str, from: &str, to: &str, at: i64) -> String {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        (kind, from, to, at).hash(&mut h);
        let token = format!("{:010x}", h.finish() & 0xff_ffff_ffff);
        self.data().set(&format!("prop:{token}"), &json!({ "kind": kind, "from": from, "to": to, "at": at }));
        token
    }
    fn proposal(token: &str, card: Card) -> Card {
        card.button_with(format!("fam:yes:{token}"), "Accept", ButtonStyle::Good, Some("💍".into())).button(format!("fam:no:{token}"), "Decline", ButtonStyle::Plain)
    }
    fn confirm(id: String, label: &str, text: String) -> Vec<Action> {
        vec![Action::Reply { card: Card::new(Area::General).line(text).button(id, label, ButtonStyle::Danger).button("fam:cancel", "Cancel", ButtonStyle::Plain).private() }]
    }

    pub fn command(&self, ev: &CommandEvent, name_of: &dyn Fn(&str) -> Option<String>) -> Vec<Action> {
        if !perms::allowed(self.db, self.guild, &ev.member, USE) { return private(format!("You don't have permission for that (`{}`).", USE.key)); }
        let me = ev.member.id.as_str();
        let name = |id: &str| if id == me { ev.member.name.clone() } else if ev.target.as_ref().is_some_and(|t| t.id == id) { ev.target.as_ref().map(|t| t.name.clone()).unwrap_or_default() } else { name_of(id).unwrap_or_else(|| "Someone".into()) };
        let check = || -> Result<&crate::Member, String> {
            let Some(t) = ev.target.as_ref() else { return Err("Pick a member.".into()) };
            if t.bot { return Err("Bots can't join families.".into()); }
            if t.id == me { return Err("That's you!".into()); }
            Ok(t)
        };
        let (max_partners, max_children) = self.limits();
        let sub = if ev.name == "marry" { "marry" } else { ev.sub.as_deref().unwrap_or("info") };
        match sub {
            "marry" | "adopt" => {
                let t = match check() { Ok(t) => t, Err(no) => return private(no) };
                let g = self.graph();
                let why = if sub == "marry" { g.marry_problem(me, &t.id, max_partners) } else { g.adopt_problem(me, &t.id, max_children) };
                if let Some(why) = why { return private(why); }
                let token = self.propose(sub, me, &t.id, ev.at_ms);
                let card = if sub == "marry" {
                    coloured(PINK).title("💍 A proposal!").line(format!("<@{me}> is asking <@{}> to marry them.\n<@{}>, will you say yes?", t.id, t.id)).line("-# This proposal ends in 10 minutes.")
                } else {
                    coloured(BLUE).title("🏡 An adoption request").line(format!("<@{me}> would like to adopt <@{}>.\n<@{}>, do you want to join their family?", t.id, t.id)).line("-# This request ends in 10 minutes.")
                };
                let mut card = Self::proposal(&token, card);
                card.ping = vec![t.id.clone()];
                vec![Action::Reply { card }]
            }
            "divorce" => {
                let mine = self.graph().partners_of(me);
                if mine.is_empty() { return private("You're not married."); }
                let who = match ev.target.as_ref().map(|t| t.id.clone()).or_else(|| (mine.len() == 1).then(|| mine[0].clone())) { Some(w) => w, None => return private("You have more than one partner. Say which one: `/family divorce partner:@them`.") };
                if !mine.contains(&who) { return private("You're not married to them."); }
                Self::confirm(format!("fam:div:{who}:{me}"), "Divorce", format!("Divorce <@{who}>? This can't be undone (you'd have to marry again)."))
            }
            "disown" => {
                let Some(t) = ev.target.as_ref() else { return private("Pick the child to disown.") };
                if self.graph().parent_of.get(&t.id).map(String::as_str) != Some(me) { return private("They're not your child."); }
                Self::confirm(format!("fam:dis:{}:{me}", t.id), "Disown", format!("Disown <@{}>? Their own children stay with them.", t.id))
            }
            "leave" => {
                let Some(parent) = self.graph().parent_of.get(me).cloned() else { return private("You don't have a parent here.") };
                Self::confirm(format!("fam:lv:{parent}:{me}"), "Leave the family", format!("Leave <@{parent}>'s family? Your partner and children stay with you."))
            }
            "tree" => {
                let who = ev.target.as_ref().map(|t| t.id.clone()).unwrap_or_else(|| me.to_string());
                let g = self.graph();
                let fam = g.family_of(&who);
                if fam.len() == 1 { return private(if who == me { "You don't have a family yet. Try `/marry` or `/family adopt`.".to_string() } else { format!("{} doesn't have a family yet.", name(&who)) }); }
                let Some(tree) = g.tree_from(&g.root_of(&who)) else { return private("Something went wrong drawing that family.") };
                let title = format!("{}'s family", name(&who));
                let count = tree.count();
                let text: String = tree_text(&tree, &|id| name(id), Some(&who)).chars().take(4000).collect();
                let mut card = coloured(PINK).title(format!("🌳 {title}")).line(text.clone()).line(format!("-# {count} people · {}", if fam.len() > count { "too big to show everyone" } else { "the whole family" }));
                if self.settings.bool(self.guild, MODULE, "pictures") && count <= 60 {
                    let names = tree.ids().into_iter().map(|id| { let n = name(&id); (id, n) }).collect();
                    card.art = Some(Art::Family(Box::new(FamilyArt { tree, names, highlight: who, title, text, pixel: self.settings.bool(self.guild, MODULE, "pixelPictures") })));
                }
                vec![Action::Reply { card }]
            }
            _ => {
                let who = ev.target.as_ref().map(|t| t.id.clone()).unwrap_or_else(|| me.to_string());
                let store = self.db.get();
                let partners = store.family_partners_of(self.guild, &who).unwrap_or_default();
                let parent = store.family_parent_of(self.guild, &who).ok().flatten();
                drop(store);
                let g = self.graph();
                let kids = g.kids_of(&who);
                let siblings: Vec<String> = parent.as_ref().map(|(p, _)| g.kids_of(p).into_iter().filter(|x| *x != who).collect()).unwrap_or_default();
                let list = |ids: &[String]| if ids.is_empty() { "None".to_string() } else { ids.iter().take(15).map(|k| format!("<@{k}>")).collect::<Vec<_>>().join(" ") };
                let card = coloured(PINK).title(format!("👪 {}", name(&who)))
                    .line(format!("**{}**\n{}", if partners.len() > 1 { "Partners" } else { "Partner" }, if partners.is_empty() { "Single".to_string() } else { partners.iter().map(|(p, t)| format!("<@{p}> since {}", since(*t))).collect::<Vec<_>>().join("\n") }))
                    .line(format!("**Parent**\n{}", parent.map(|(p, t)| format!("<@{p}> since {}", since(t))).unwrap_or_else(|| "None".into())))
                    .line(format!("**Children ({})**\n{}", kids.len(), list(&kids)))
                    .line(format!("**Siblings ({})**\n{}", siblings.len(), list(&siblings)))
                    .line(format!("-# Family size: {}", g.family_of(&who).len()));
                vec![Action::Reply { card }]
            }
        }
    }

    pub fn press(&self, ev: &ButtonEvent) -> Vec<Action> {
        let p: Vec<&str> = ev.id.split(':').collect();
        let (what, a, b) = (p.get(1).copied().unwrap_or(""), p.get(2).copied().unwrap_or(""), p.get(3).copied().unwrap_or(""));
        let me = ev.member.id.as_str();
        let done = |text: String| vec![Action::Update { card: Card::new(Area::General).line(text).private() }];
        match what {
            "yes" | "no" => {
                let yes = what == "yes";
                let key = format!("prop:{a}");
                let d = self.data();
                let ended = || vec![Action::Update { card: coloured(GREY).line("This request has ended.") }];
                let Some(prop) = d.get(&key) else { return ended() };
                if ev.at_ms - prop["at"].as_i64().unwrap_or(0) > PROPOSAL_MS { d.delete(&key); return ended(); }
                let (kind, from, to) = (prop["kind"].as_str().unwrap_or(""), prop["from"].as_str().unwrap_or("").to_string(), prop["to"].as_str().unwrap_or("").to_string());
                if me != to {
                    if me == from && !yes { d.delete(&key); return vec![Action::Update { card: coloured(GREY).line(format!("<@{from}> took the {} back.", if kind == "marry" { "proposal" } else { "request" })) }]; }
                    return private(format!("Only <@{to}> can answer this."));
                }
                d.delete(&key);
                if !yes { return vec![Action::Update { card: coloured(GREY).line(if kind == "marry" { format!("💔 <@{to}> said no to <@{from}>.") } else { format!("<@{to}> said no thanks to joining <@{from}>'s family.") }) }]; }
                let g = self.graph();
                let (max_partners, max_children) = self.limits();
                if kind == "marry" {
                    if let Some(why) = g.marry_problem(&from, &to, max_partners) { return private(format!("It can't happen any more: {why}")); }
                    let _ = self.db.get().family_marry(self.guild, &from, &to, ev.at_ms);
                    return vec![Action::Update { card: coloured(PINK).title("💒 Just married!").line(format!("<@{from}> and <@{to}> are now married. Congratulations! 🎉")) }];
                }
                if let Some(why) = g.adopt_problem(&from, &to, max_children) { return private(format!("It can't happen any more: {why}")); }
                let _ = self.db.get().family_adopt(self.guild, &from, &to, ev.at_ms);
                vec![Action::Update { card: coloured(BLUE).title("🏡 Welcome to the family!").line(format!("<@{from}> adopted <@{to}>.")) }]
            }
            "cancel" => done("Cancelled.".into()),
            _ if b != me => private("That button is for someone else."),
            "div" => {
                if !self.db.get().family_divorce(self.guild, a, b).unwrap_or(false) { return done("You're not married to them any more.".into()); }
                vec![Action::Update { card: Card::new(Area::General).line("Divorced.").private() }, Action::Send { channel: ev.place.channel.clone(), card: Card::new(Area::General).line(format!("💔 <@{b}> and <@{a}> are divorced.")), ping: Vec::new(), roles: Vec::new() }]
            }
            "dis" | "lv" => {
                let (child, parent) = if what == "dis" { (a, b) } else { (b, a) };
                if !self.db.get().family_unchild(self.guild, parent, child).unwrap_or(false) { return done("That already changed.".into()); }
                let said = if what == "dis" { format!("<@{parent}> disowned <@{child}>.") } else { format!("<@{child}> left <@{parent}>'s family.") };
                vec![Action::Update { card: Card::new(Area::General).line("Done.").private() }, Action::Send { channel: ev.place.channel.clone(), card: Card::new(Area::General).line(said), ping: Vec::new(), roles: Vec::new() }]
            }
            _ => private("Unknown button."),
        }
    }
    /// Proposals older than 10 minutes are forgotten (Good Boy 3's expire task).
    pub fn expire(&self, now: i64) {
        let d = self.data();
        for (key, v) in d.list("prop:") {
            if now - v["at"].as_i64().unwrap_or(0) > PROPOSAL_MS { d.delete(&key); }
        }
    }
}
