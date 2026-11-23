//! Good Boy 3's economy module, one to one: /balance, /daily, /pay, /top (live leaderboards), /shop with an
//! inventory, /work, /rob, /pet, /bank, /economy-admin, right-click View wallet and Pay member, the weekly lottery,
//! coin events while people chat, roles bought for some hours. The same tables, rules and wording.
//! Coins are play money: they can't be bought, sold or cashed out.

use crate::bot::{CommandSpec, Directory, Opt, Sub, Takes};
use crate::card::group;
use crate::money::{claim_daily, coins_to_gems, gems_to_coins, parse_amount, tax_of, CLAIM_EVERY, JOBS, MAX_SHIELDS, MODULE};
use crate::perms::{self, Level, Perm};
use crate::store::Data;
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Field, FieldKind, FormEvent, Member, MessageEvent, Select, Settings};
use gb_data::{Pet, ShopItem, Short, Wallet};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

pub const USE: Perm = Perm { key: "economy.use", level: Level::Everyone };
pub const ADMIN: Perm = crate::money::ADMIN;

const fn opt(name: &'static str, about: &'static str, takes: Takes, required: bool) -> Opt {
    Opt { name, about, takes, required }
}
pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec { name: "balance", about: "Your wallet, streak and rank", module: MODULE, options: &[], subs: &[] },
    CommandSpec { name: "daily", about: "Claim your daily coins and grow your streak", module: MODULE, options: &[], subs: &[] },
    CommandSpec { name: "pay", about: "Send coins to another member (opens a form)", module: MODULE, options: &[], subs: &[] },
    CommandSpec { name: "top", about: "Live leaderboards: coins, streaks, fishing and more", module: MODULE, options: &[], subs: &[] },
    CommandSpec { name: "shop", about: "Buy roles and items with your coins", module: MODULE, options: &[], subs: &[] },
    CommandSpec { name: "work", about: "Do a job for some coins", module: MODULE, options: &[], subs: &[] },
    CommandSpec { name: "rob", about: "Try to take some of a member's wallet (if the server allows it)", module: MODULE, options: &[opt("member", "Who", Takes::Member, true)], subs: &[] },
    CommandSpec { name: "pet", about: "Your pet: adopt, feed, play", module: MODULE, options: &[], subs: &[
        Sub { name: "adopt", about: "Adopt a pet", options: &[opt("kind", "Which", Takes::Choice(PET_CHOICES), true), opt("name", "Its name", Takes::Text, false)] },
        Sub { name: "feed", about: "Feed your pet (50 coins)", options: &[] },
        Sub { name: "play", about: "Play with your pet", options: &[] },
        Sub { name: "info", about: "See a pet", options: &[opt("member", "Whose (yours if empty)", Takes::Member, false)] },
    ] },
    CommandSpec { name: "bank", about: "Keep coins safe and earn daily interest", module: MODULE, options: &[], subs: &[] },
    CommandSpec { name: "treasury", about: "The server treasury: what taxes and fees have collected, and what it paid out", module: MODULE, options: &[], subs: &[] },
    CommandSpec { name: "exchange", about: "Swap coins for the server's second currency and back (if the server has one)", module: MODULE, options: &[], subs: &[] },
    CommandSpec { name: "economy-admin", about: "(Admins) Give, take or set a member's coins (opens a form)", module: MODULE, options: &[], subs: &[] },
];

// ------------------------------------------------------------------ the rules (Good Boy 3's shop.js and extras.js)
pub const SHIELD_ID: &str = "shield";
pub const PADLOCK_ID: &str = "padlock";
pub const SHOP_MAX: usize = 25;
pub const ROB_CHANCE: f64 = 0.45;
pub const ROB_COOLDOWN: i64 = 3_600_000;
pub const ROB_SHIELD: i64 = 2 * 3_600_000;
pub const ROB_MIN: i64 = 500;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 86_400_000;
const LEDGER_DAYS: i64 = 30;

/// The built-in items: (id, name, emoji, description, default price × dailyBase).
pub const STARTERS: &[(&str, &str, &str, &str, f64)] = &[
    ("luck", "Lucky charm", "🍀", "Use it for +30% fishing luck for an hour.", 3.0),
    ("workboost", "Work boost", "💼", "Use it for +50% from /work for 24 hours.", 4.0),
    ("ticket", "Lottery ticket", "🎟️", "One entry in this week's draw. Everything spent on tickets is the prize; the winner is drawn every Monday.", 0.4),
    ("treat", "Pet treat", "🦴", "Use it to make your pet happier and less hungry right away.", 0.6),
];
/// Boosts from items: (id, how long, what it does).
pub const BOOSTS: &[(&str, i64, &str)] = &[("luck", HOUR, "+30% fishing luck"), ("workboost", DAY, "+50% from /work")];
/// (id, emoji, label, price)
pub const PETS: &[(&str, &str, &str, i64)] = &[
    ("puppy", "🐶", "Puppy", 2000), ("kitten", "🐱", "Kitten", 2000), ("bunny", "🐰", "Bunny", 2500), ("hamster", "🐹", "Hamster", 1500),
    ("fox", "🦊", "Fox", 6000), ("owl", "🦉", "Owl", 6000), ("turtle", "🐢", "Turtle", 4000), ("dragon", "🐉", "Dragon", 50000),
];
const PET_CHOICES: &[(&str, &str)] = &[
    ("🐶 Puppy (2,000)", "puppy"), ("🐱 Kitten (2,000)", "kitten"), ("🐰 Bunny (2,500)", "bunny"), ("🐹 Hamster (1,500)", "hamster"),
    ("🦊 Fox (6,000)", "fox"), ("🦉 Owl (6,000)", "owl"), ("🐢 Turtle (4,000)", "turtle"), ("🐉 Dragon (50,000)", "dragon"),
];
/// (kind, emoji, title, button, text)
pub const EVENTS: &[(&str, &str, &str, &str, &str)] = &[
    ("grab", "💰", "A bag of coins fell out of the sky!", "Grab it", "First to press **Grab it** keeps it."),
    ("split", "🎁", "A treasure chest washed up!", "Take a share", "Everyone who presses **Take a share** in the next 30 seconds splits it."),
    ("grab", "🐕", "A good boy dropped a wallet!", "Return it", "First to press **Return it** gets the reward."),
    ("split", "🍀", "A lucky clover patch appeared!", "Pick some", "Everyone who presses **Pick some** in the next 30 seconds shares the luck."),
];

/// Good Boy 3's slug: lower case letters and numbers joined by dashes, up to 30.
pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() { out.push(c) } else if !out.ends_with('-') && !out.is_empty() { out.push('-') }
    }
    out.trim_end_matches('-').chars().take(30).collect::<String>().trim_end_matches('-').to_string()
}
/// The Monday of the week a moment is in (the lottery's week), as 2026-11-09.
pub fn week_of(now: i64) -> String {
    let days = now.div_euclid(DAY);
    let weekday = (days + 4).rem_euclid(7); // 1970-01-01 was a Thursday; 0 = Sunday
    let back = (weekday + 6) % 7;
    crate::time::date((days - back) * DAY)
}
/// Daily interest owed: rate% of the bank per full day (compounding, at most 30 days), at most `cap` a day.
pub fn interest_due(bank: i64, last_paid: Option<i64>, now: i64, rate: i64, cap: i64) -> (i64, i64) {
    let Some(last) = last_paid.filter(|_| bank > 0 && rate > 0) else { return (0, 0) };
    let days = (now - last).div_euclid(DAY);
    if days <= 0 { return (0, 0); }
    let (mut total, mut b) = (0, bank);
    for _ in 0..days.min(30) {
        let add = (b * rate / 100).min(if cap > 0 { cap } else { i64::MAX });
        total += add;
        b += add;
    }
    (total, days)
}
/// One robbery: (outcome, coins). `r1`, `r2` are rolls in [0, 1).
pub fn rob_outcome(robber_coins: i64, target_coins: i64, padlock: bool, max_steal: i64, r1: f64, r2: f64) -> (&'static str, i64) {
    if padlock { return ("padlock", 50.max(robber_coins / 10)); }
    if r1 < ROB_CHANCE { return ("stole", 1.max(max_steal.min((target_coins as f64 * (0.1 + r2 * 0.25)).floor() as i64))); }
    ("caught", 50.max(robber_coins / 10))
}
/// A pet now: hunger and happiness go down over time (about 1.2 and 0.8 points an hour).
pub fn pet_now(p: &Pet, now: i64) -> (i64, i64) {
    let hrs = ((now - p.updated_at) as f64 / HOUR as f64).max(0.0);
    let r = |x: f64| (x + 0.5).floor() as i64;
    ((r(p.hunger as f64 - hrs * 1.2)).max(0), (r(p.happy as f64 - hrs * 0.8)).max(0))
}
pub fn pet_level(xp: i64) -> i64 {
    ((xp as f64 / 10.0).sqrt().floor() as i64).min(20)
}
/// What a pet adds to /work, in %: up to +25% for a level-20 pet that is fed and happy.
pub fn pet_bonus(p: Option<&Pet>, now: i64) -> i64 {
    let Some(p) = p else { return 0 };
    let (hunger, happy) = pet_now(p, now);
    let care = hunger.min(happy) as f64 / 100.0;
    (((5 + pet_level(p.xp)) as f64 * care) + 0.5).floor() as i64
}
/// A prize shared as evenly as whole coins allow.
pub fn shares(total: i64, n: usize) -> Vec<i64> {
    (0..n as i64).map(|k| total / n as i64 + i64::from(k < total % n as i64)).collect()
}
fn rank_label(rank: i64) -> String {
    match rank { 1 => "🥇".into(), 2 => "🥈".into(), 3 => "🥉".into(), r => format!("`#{r:>2}`") }
}
fn ts(ms: i64) -> String {
    format!("<t:{}:R>", ms.div_euclid(1000))
}
fn short(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { format!("{}…", s.chars().take(max.saturating_sub(1)).collect::<String>()) }
}
fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::Money).line(text).private() }]
}
fn plural(n: i64, one: &str, many: &str) -> String {
    format!("{} {}", group(n), if n == 1 { one } else { many })
}

/// An inventory line: (item id, how many, name, emoji, what using it says, used up when used).
type Held = (String, i64, Option<String>, Option<String>, Option<String>, bool);
/// A live coin event, kept in memory as Good Boy 3 keeps it.
struct LiveEvent {
    guild: String,
    kind: &'static str,
    prize: i64,
    takers: Vec<String>,
    channel: String,
    message: Option<String>,
    title: String,
    ends: i64,
}
#[derive(Default)]
struct Memory {
    /// guild → (messages since the last event, messages needed, when the last one was)
    counts: HashMap<String, (i64, i64, i64)>,
    events: HashMap<String, LiveEvent>,
    pruned: i64,
}
fn memory() -> std::sync::MutexGuard<'static, Memory> {
    static M: OnceLock<Mutex<Memory>> = OnceLock::new();
    M.get_or_init(Mutex::default).lock().unwrap_or_else(|p| p.into_inner())
}

pub struct Economy<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub dir: &'a Directory,
    pub guild: &'a str,
    pub server: &'a str,
}
/// (id, name, emoji, what it counts, needs the games module). Good Boy 3's boards: the games module added the fishing and casino ones.
const BOARDS: [(&str, &str, &str, &str, bool); 6] = [
    ("coins", "Richest", "🪙", "coins", false),
    ("streak", "Daily streak", "🔥", "days", false),
    ("fish", "Most fish caught", "🎣", "fish", true),
    ("heaviest", "Heaviest catch", "⚖️", "kg", true),
    ("fishlevel", "Fishing level", "⭐", "xp", true),
    ("casino", "Casino winnings", "🎰", "coins", true),
];
impl Economy<'_> {
    fn int(&self, k: &str) -> i64 {
        self.settings.int(self.guild, MODULE, k)
    }
    fn on(&self, k: &str) -> bool {
        self.settings.bool(self.guild, MODULE, k)
    }
    fn data(&self) -> Data<'_> {
        Data { db: self.db, guild: self.guild, module: MODULE }
    }
    /// "**1,840** 🪙"
    pub fn money(&self, n: i64) -> String {
        format!("**{}** {}", group(n), self.settings.text(self.guild, MODULE, "currencyEmoji").unwrap_or_else(|| "🪙".into()))
    }
    fn quiet(&self, card: Card) -> Card {
        if self.on("privateReplies") { card.private() } else { card }
    }
    fn wallet(&self, who: &Member) -> Wallet {
        let start = self.int("startingCoins");
        self.db.get().wallet(self.guild, &who.id, Some(&who.name).filter(|n| !n.is_empty()).map(|x| x.as_str()), start).unwrap_or(Wallet { coins: 0, earned: 0, bank: 0, streak: 0, best_streak: 0, shields: 0, last_daily: 0, last_work: 0 })
    }
    fn wallet_of(&self, id: &str) -> Wallet {
        self.wallet(&Member { id: id.into(), ..Default::default() })
    }
    fn debit(&self, user: &str, amount: i64, reason: &str) -> Result<i64, String> {
        self.wallet_of(user); // as in Good Boy 3, taking coins makes the wallet first
        let done = self.db.get().debit(self.guild, user, amount, reason);
        match done {
            Ok(Ok(left)) => Ok(left),
            Ok(Err(Short::Only(have))) => Err(format!("You only have {}.", self.money(have))),
            Err(e) => Err(format!("The wallet could not be changed just now ({e}).")),
        }
    }
    fn credit(&self, user: &str, amount: i64, reason: &str) -> i64 {
        self.wallet_of(user);
        self.db.get().credit(self.guild, user, amount, reason).unwrap_or(0)
    }
    fn starters(&self) -> Vec<(&'static str, &'static str, &'static str, &'static str, i64, bool)> {
        let base = self.int("dailyBase") as f64;
        STARTERS.iter().map(|(id, name, emoji, desc, times)| {
            let saved = self.data().get(&format!("builtin:{id}")).unwrap_or_default();
            let fallback = ((base * times + 0.5).floor() as i64).max(1);
            (*id, *name, *emoji, *desc, saved["price"].as_i64().unwrap_or(fallback), saved["off"].as_bool().unwrap_or(false))
        }).collect()
    }
    fn shield_price(&self) -> i64 {
        (self.int("dailyBase") * 4).max(1)
    }
    fn padlock_price(&self) -> i64 {
        (self.int("dailyBase") * 2).max(1)
    }
    fn boost_until(&self, user: &str, kind: &str, now: i64) -> i64 {
        self.data().get(&format!("boost:{kind}:{user}")).and_then(|v| v.as_i64()).filter(|t| *t > now).unwrap_or(0)
    }
    fn lottery(&self, user: &str, now: i64) -> (String, i64, i64, i64) {
        let week = week_of(now);
        let (t, p, mine) = self.db.get().lottery_week(self.guild, &week, user).unwrap_or((0, 0, 0));
        (week, t, p, mine)
    }
    /// Only the server's owner (Discord's owner of the server, not just an admin).
    fn is_server_owner(&self, m: &Member) -> bool { self.dir.owner(self.guild).is_some_and(|o| o == m.id) }
    fn staff(&self, m: &Member) -> bool {
        perms::allowed(self.db, self.guild, m, ADMIN)
    }

    // ------------------------------------------------------------------ cards
    pub fn wallet_card(&self, who: &Member, now: i64) -> Card {
        let w = self.wallet(who);
        let rank = self.db.get().coin_rank(self.guild, w.coins).ok().flatten();
        let ready = w.last_daily == 0 || now - w.last_daily >= CLAIM_EVERY;
        Card::new(Area::Money).title(who.name.clone()).picture(who.avatar.clone())
            .line(format!("**Wallet** {}  ·  **Rank** {}", self.money(w.coins), rank.map(|r| format!("#{}", group(r))).unwrap_or_else(|| "—".into())))
            .line(format!("**Daily streak** 🔥 {} (best {})  ·  🛡️ {}", w.streak, w.best_streak, w.shields))
            .line(format!("**Next daily** {}  ·  **Earned in total** {}", if ready { "✅ Ready now".to_string() } else { ts(w.last_daily + CLAIM_EVERY) }, self.money(w.earned)))
    }
    fn gems_line(&self, card: Card, who: &str) -> Card {
        if !self.on("gemsEnabled") { return card; }
        let gems = self.db.get().gems(self.guild, who).unwrap_or(0);
        card.line(format!("**{}** {}", short(&self.gem_name(), 20), self.gem(gems)))
    }
    // ------------------------------------------------------------------ taxes, the treasury and the second currency
    fn gem(&self, n: i64) -> String {
        format!("**{}** {}", group(n), self.settings.text(self.guild, MODULE, "gemEmoji").unwrap_or_else(|| "💎".into()))
    }
    fn gem_name(&self) -> String {
        self.settings.text(self.guild, MODULE, "gemName").filter(|n| !n.is_empty()).unwrap_or_else(|| "gems".into())
    }
    /// Takes a tax from what someone just earned, puts it in the treasury, and gives what was taken.
    fn tax_income(&self, user: &str, earned: i64, now: i64) -> i64 {
        let tax = tax_of(earned, self.int("taxIncome"));
        if tax == 0 { return 0; }
        self.db.get().skim(self.guild, user, tax, "tax:income", now).unwrap_or(0)
    }
    /// Shop sales go to the treasury when the server wants that.
    fn sale(&self, user: &str, price: i64, what: &str, now: i64) {
        if self.on("shopToTreasury") { let _ = self.db.get().treasury_in(self.guild, price, "shop", Some(user), Some(what), now); }
    }
    /// The tax rates in force, in words (nothing when there are none).
    fn tax_words(&self) -> Vec<String> {
        [("taxPay", "payments"), ("taxIncome", "daily and work"), ("taxWithdraw", "bank withdrawals"), ("taxWinnings", "game winnings")].iter()
            .filter(|(k, _)| self.int(k) > 0).map(|(k, w)| format!("{}% on {w}", self.int(k))).collect()
    }
    pub fn treasury_card(&self, me: &Member, now: i64) -> Card {
        let t = self.db.get().treasury(self.guild).unwrap_or_default();
        let rates = self.tax_words();
        let week = self.db.get().treasury_by_kind(self.guild, now - 7 * DAY).unwrap_or_default();
        let mut lines = vec![format!("**In the treasury** {}\n**Collected in all** {}  ·  **Paid out** {}", self.money(t.balance), self.money(t.collected), self.money(t.paid_out))];
        lines.push(if rates.is_empty() && !self.on("shopToTreasury") && !self.on("gemsEnabled") { "No taxes or fees are switched on, so nothing is collected yet. Admins can set them in the launcher under Economy.".to_string() } else {
            format!("**Taxes** {}{}{}", if rates.is_empty() { "none".to_string() } else { rates.join(" · ") }, if self.on("shopToTreasury") { " · shop sales" } else { "" }, if self.on("gemsEnabled") { format!(" · {}% exchange fee", self.int("exchangeFee")) } else { String::new() })
        });
        if !week.is_empty() {
            let word = |k: &str| -> String { match k { "tax:pay" => "payments", "tax:income" => "daily and work", "tax:withdraw" => "bank withdrawals", "tax:winnings" => "game winnings", "shop" => "the shop", "fee:exchange" => "exchange fees", "grant" => "paid out", "donation" => "donations", "staff" => "added by staff", o => o }.to_string() };
            lines.push(format!("**Last 7 days**\n{}", week.iter().take(6).map(|(k, v)| format!("{} {} · {}", if *v < 0 { "−" } else { "+" }, group(v.abs()), word(k))).collect::<Vec<_>>().join("\n")));
        }
        let mut card = Card::new(Area::Money).title("🏛️ The treasury").line(lines.join("\n\n")).line("-# Taxes and fees from the economy collect here. Admins pay it out as prizes and rewards.");
        card = card.button_with(format!("mpx:tdonate:{}:-", me.id), "Give coins", ButtonStyle::Good, Some("🎁".into()));
        if self.is_server_owner(me) { card = card.button_with(format!("mpx:tadd:{}:-", me.id), "Add coins", ButtonStyle::Good, Some("➕".into())); }
        if self.staff(me) { card = card.button_with(format!("mpx:tgive:{}:-", me.id), "Pay out", ButtonStyle::Primary, Some("💸".into())); }
        card
    }
    pub fn exchange_card(&self, me: &Member) -> Card {
        let w = self.wallet(me);
        let gems = self.db.get().gems(self.guild, &me.id).unwrap_or(0);
        let (rate, fee) = (self.int("exchangeRate").max(1), self.int("exchangeFee"));
        Card::new(Area::Money).title(format!("💱 Exchange · coins and {}", self.gem_name()))
            .line(format!("**You have** {}  ·  {}", self.money(w.coins), self.gem(gems)))
            .line(format!("**Rate** {} = {}{}", self.money(rate), self.gem(1), if fee > 0 { format!("\n**Fee** {fee}% either way, it goes to the server treasury") } else { String::new() }))
            .line("-# Only you can see this.")
            .button_with(format!("mpx:xgems:{}:-", me.id), format!("Coins → {}", self.gem_name()), ButtonStyle::Primary, Some("➡️".into()))
            .button_with(format!("mpx:xcoins:{}:-", me.id), format!("{} → coins", self.gem_name()), ButtonStyle::Plain, Some("⬅️".into()))
            .private()
    }
    /// Pays coins out of the treasury to a member (admins), with the reason in the record.
    pub fn treasury_give(&self, by: &str, to: &str, amount: i64, reason: &str, now: i64) -> Result<(i64, i64), String> {
        if amount <= 0 { return Err("The amount must be at least 1.".into()); }
        self.wallet_of(to);
        let out = self.db.get().batch(|s| match s.treasury_out(self.guild, amount, "grant", Some(to), Some(reason), now)? {
            Err(short) => Ok(Err(short)),
            Ok(left) => { s.credit(self.guild, to, amount, &format!("treasury: {reason}"))?; Ok(Ok(left)) }
        });
        match out {
            Ok(Ok(left)) => { let _ = by; Ok((left, self.wallet_of(to).coins)) }
            Ok(Err(Short::Only(have))) => Err(format!("The treasury only has {}.", self.money(have))),
            Err(_) => Err("The treasury could not be changed just now. Try again in a moment.".into()),
        }
    }
    fn quick_row(&self, card: Card, owner: &str, daily: bool) -> Card {
        let card = if daily { card.button_with(format!("econ:daily:{owner}"), "Daily", ButtonStyle::Good, Some("🎁".into())) } else { card };
        card.button_with(format!("econ:top:{owner}"), "Leaderboard", ButtonStyle::Plain, Some("🏆".into()))
            .button_with(format!("mpx:pay:{owner}:-"), "Pay someone", ButtonStyle::Primary, Some("💸".into()))
    }
    /// Good Boy 3's private "configure" message before a form: what it does, and the one button.
    fn intro(&self, title: &str, text: String, button: String, label: &str, emoji: &str, style: ButtonStyle) -> Vec<Action> {
        vec![Action::Reply { card: Card::new(Area::Money).title(title).line(text).line("-# Only you can see this. The button works for 15 minutes.").button_with(button, label, style, Some(emoji.into())).private() }]
    }

    pub fn shop_card(&self, me: &Member, note: Option<String>, now: i64) -> Card {
        let items = self.db.get().shop_items(self.guild).unwrap_or_default();
        let staff = self.staff(me);
        let (_, tickets, pool, _) = self.lottery(&me.id, now);
        let mut lines: Vec<String> = note.into_iter().collect();
        lines.push(format!("You have {}.", self.money(self.wallet(me).coins)));
        lines.push(String::new());
        lines.push(format!("🛡️ **Streak Shield** · {}\n-# Saves your daily streak if you miss a day (hold up to 3).", self.money(self.shield_price())));
        if self.on("robbing") { lines.push(format!("🔒 **Padlock** · {}\n-# Stops the next robbery, and the robber pays you a fine.", self.money(self.padlock_price()))); }
        for (id, name, emoji, desc, price, off) in self.starters() {
            if off { continue; }
            let desc = if id == "ticket" { format!("{desc} This week: {} from {tickets} tickets.", self.money(pool)) } else { desc.to_string() };
            lines.push(format!("{emoji} **{name}** · {}\n-# {desc}", self.money(price)));
        }
        for it in &items {
            let mut l = format!("{} **{}** · {}", it.emoji.as_deref().unwrap_or("🎁"), it.name, self.money(it.price));
            if let Some(r) = &it.role_id { l += &format!(" · gives <@&{r}>{}", if it.hours > 0 { format!(" for {} h", it.hours) } else { String::new() }); }
            if let Some(s) = it.stock { l += &if s > 0 { format!(" · {s} left") } else { " · **sold out**".to_string() }; }
            if let Some(d) = &it.description { l += &format!("\n-# {}", short(d, 150)); }
            lines.push(l);
        }
        if items.is_empty() { lines.push(format!("\n-# {}", if staff { "Add roles or items with **Add item** below." } else { "Staff can add roles and items here." })); }
        let mut options: Vec<(String, String, Option<String>)> = vec![(format!("Streak Shield ({})", group(self.shield_price())), SHIELD_ID.into(), Some("🛡️".into()))];
        if self.on("robbing") { options.push((format!("Padlock ({})", group(self.padlock_price())), PADLOCK_ID.into(), Some("🔒".into()))); }
        for (id, name, emoji, _, price, off) in self.starters() { if !off { options.push((format!("{name} ({})", group(price)), id.into(), Some(emoji.into()))); } }
        for it in items.iter().filter(|i| i.stock != Some(0)) { options.push((short(&format!("{} ({})", it.name, group(it.price)), 100), it.id.clone(), it.emoji.clone().filter(|e| !e.starts_with('<')))); }
        options.truncate(25);
        let mut card = Card::new(Area::Money).title("🛍️ Shop").line(lines.join("\n")).private()
            .select(Select { id: format!("econ:buy:{}", me.id), placeholder: "Buy something...".into(), min: 1, max: 1, options })
            .button_with(format!("econ:inv:{}", me.id), "Inventory", ButtonStyle::Plain, Some("🎒".into()));
        if staff {
            card = card.button_with(format!("mpx:shopadd:{}:-", me.id), "Add item", ButtonStyle::Good, Some("➕".into()))
                .button_with(format!("econ:rmlist:{}", me.id), "Remove item", ButtonStyle::Danger, Some("🗑️".into()));
        }
        card
    }
    /// A member's inventory: (id, how many, name, emoji, message, used up when used).
    fn inventory(&self, user: &str) -> Vec<Held> {
        let items = self.db.get().items(self.guild, user).unwrap_or_default();
        let mut out: Vec<_> = items.into_iter().map(|(id, qty)| {
            if id == PADLOCK_ID { return (id, qty, Some("Padlock".into()), Some("🔒".into()), Some("Your padlock is on. It stops the next robbery.".into()), false); }
            if let Some((_, name, emoji, _, _)) = STARTERS.iter().find(|s| s.0 == id) { return (id, qty, Some(name.to_string()), Some(emoji.to_string()), None, true); }
            match self.db.get().shop_item(self.guild, &id).ok().flatten() {
                Some(it) => (id, qty, Some(it.name), it.emoji, it.message, it.consumable),
                None => (id, qty, None, None, None, false),
            }
        }).collect();
        out.sort_by(|a, b| a.2.cmp(&b.2));
        out
    }
    fn inventory_card(&self, me: &Member, note: Option<String>) -> Card {
        let inv = self.inventory(&me.id);
        let list = if inv.is_empty() { "Nothing yet. Buy something in the shop!".to_string() } else {
            inv.iter().map(|(id, qty, name, emoji, _, _)| format!("{} **{}** × {qty}", emoji.as_deref().unwrap_or("🎁"), name.clone().unwrap_or_else(|| format!("{id} (no longer in the shop)")))).collect::<Vec<_>>().join("\n")
        };
        let mut card = Card::new(Area::Money).title("🎒 Inventory").line(note.into_iter().chain(std::iter::once(list)).collect::<Vec<_>>().join("\n\n")).private();
        let usable: Vec<_> = inv.iter().filter(|x| x.2.is_some()).take(25).map(|(id, qty, name, _, _, _)| (short(&format!("{} × {qty}", name.clone().unwrap_or_default()), 100), id.clone(), None)).collect();
        if !usable.is_empty() { card = card.select(Select { id: format!("econ:use:{}", me.id), placeholder: "Use an item...".into(), min: 1, max: 1, options: usable }); }
        card.button_with(format!("econ:shop:{}", me.id), "Shop", ButtonStyle::Plain, Some("🛍️".into()))
    }
    /// Pays any interest owed (into the bank) and gives the wallet and the interest just paid.
    fn settle_bank(&self, user: &str, now: i64) -> (Wallet, i64) {
        let w = self.wallet_of(user);
        let more = self.db.get().wallet_more(self.guild, user).unwrap_or_default();
        let Some(paid) = more.bank_paid_at else {
            let _ = self.db.get().set_bank_paid(self.guild, user, now);
            return (w, 0);
        };
        let (coins, days) = interest_due(w.bank, Some(paid), now, self.int("bankInterest"), self.int("bankInterestCap"));
        if days == 0 { return (w, 0); }
        let _ = self.db.get().pay_interest(self.guild, user, coins, days);
        (self.wallet_of(user), coins)
    }
    fn bank_card(&self, me: &Member, note: Option<String>, now: i64) -> Card {
        let (w, interest) = self.settle_bank(&me.id, now);
        let (rate, cap) = (self.int("bankInterest"), self.int("bankInterestCap"));
        let mut top: Vec<String> = note.into_iter().collect();
        if interest > 0 { top.push(format!("💹 You earned {} interest since you last looked.", self.money(interest))); }
        let rate_text = if rate > 0 { format!("{rate}% a day{}", if cap > 0 { format!(", up to {} a day", self.money(cap)) } else { String::new() }) } else { "Off in this server".into() };
        let mut card = Card::new(Area::Money).title("🏦 Bank");
        if !top.is_empty() { card = card.line(top.join("\n")); }
        card.line(format!("**Wallet** {}  ·  **Bank** {}  ·  **Interest** {rate_text}", self.money(w.coins), self.money(w.bank)))
            .line("-# Bets and purchases use your wallet, so coins in the bank are safe from them.")
            .button_with(format!("mpx:deposit:{}:-", me.id), "Deposit", ButtonStyle::Good, Some("📥".into()))
            .button_with(format!("mpx:withdraw:{}:-", me.id), "Withdraw", ButtonStyle::Primary, Some("📤".into()))
            .private()
    }
    fn pet_card(&self, p: &Pet, note: Option<String>, now: i64) -> Card {
        let (hunger, happy) = pet_now(p, now);
        let (_, emoji, _, _) = PETS.iter().find(|k| k.0 == p.kind).copied().unwrap_or(("", "🐾", "", 0));
        let bar = |v: i64| { let f = ((v as f64 / 10.0) + 0.5).floor() as usize; format!("{}{} {v}", "█".repeat(f.min(10)), "░".repeat(10 - f.min(10))) };
        let mut lines: Vec<String> = note.into_iter().collect();
        lines.push(format!("🍖 Fed  `{}`", bar(hunger)));
        lines.push(format!("💖 Happy `{}`", bar(happy)));
        lines.push(format!("💼 Adds **+{}%** to /work", pet_bonus(Some(p), now)));
        self.quiet(Card::new(Area::Money).title(format!("{emoji} {} · level {}", p.name, pet_level(p.xp))).line(lines.join("\n")).line("-# Feed (50 coins) and play every 30 minutes. A fed, happy pet helps more."))
    }

    // ------------------------------------------------------------------ leaderboards
    /// One page of a board: Good Boy 3's live leaderboard (every press reads the numbers again).
    pub fn board_card(&self, owner: &str, board: &str, scope: &str, page: i64) -> Card {
        let games = self.db.get().module_enabled(self.guild, crate::casino::MODULE).unwrap_or(false);
        let board = BOARDS.iter().find(|b| b.0 == board && (games || !b.4)).map(|b| b.0).unwrap_or("coins");
        let (_, label, emoji, _, _) = BOARDS.iter().copied().find(|b| b.0 == board).unwrap_or(BOARDS[0]);
        let guilds = if scope == "global" { self.db.get().global_board_guilds().unwrap_or_default() } else { vec![self.guild.to_string()] };
        let total = self.db.get().board(&guilds, board, 0, 0, owner).map(|r| r.1).unwrap_or(0);
        let pages = ((total + 9) / 10).max(1);
        let page = page.clamp(0, pages - 1);
        let (rows, total, me) = self.db.get().board(&guilds, board, page * 10, 10, owner).unwrap_or_default();
        let format = |v: i64| match board {
            "streak" => format!("**{}** day{}", group(v), if v == 1 { "" } else { "s" }),
            "fish" => format!("**{}** fish", group(v)),
            "heaviest" => format!("**{}** kg", v as f64 / 100.0),
            "fishlevel" => format!("level **{}** · {} XP", crate::fishing::level_from_xp(v).level, group(v)),
            "casino" => format!("+{}", self.money(v)),
            _ => self.money(v),
        };
        let lines = if rows.is_empty() { "*Nobody here yet. Be the first!*".to_string() } else {
            rows.iter().enumerate().map(|(k, (user, name, v))| {
                let who = if scope == "global" { format!("**{}**", name.clone().unwrap_or_else(|| "someone".into())) } else { format!("<@{user}>") };
                format!("{} {who} · {}", rank_label(page * 10 + k as i64 + 1), format(*v))
            }).collect::<Vec<_>>().join("\n")
        };
        let opted = scope != "global" || self.on("globalBoard");
        let you = match me {
            Some((v, rank)) => format!("#{} · {}", group(rank), format(v)),
            None if opted => "*Not on this board yet*".into(),
            None => "*This server is not on the global board. Admins can turn it on in `/config` > economy.*".into(),
        };
        let nav = |action: &str| format!("econlb:{owner}:{board}:{scope}:{page}:{action}");
        let other = if scope == "global" { "server" } else { "global" };
        Card::new(Area::Money).title(format!("{emoji} {label} · {}", if scope == "global" { "Global" } else { self.server }))
            .line(lines).line(format!("**You** {you}"))
            .line(format!("-# {} · page {} of {pages} · live", plural(total, "entry", "entries"), page + 1))
            .select(Select { id: nav("board"), placeholder: "Choose a leaderboard".into(), min: 1, max: 1, options: BOARDS.iter().filter(|b| games || !b.4).map(|b| (b.1.to_string(), b.0.to_string(), Some(b.2.to_string()))).collect() })
            .button_full(nav("prev"), "", ButtonStyle::Plain, Some("◀️".into()), page <= 0)
            .button_full(nav("noop"), format!("{} / {pages}", page + 1), ButtonStyle::Plain, None, true)
            .button_full(nav("next"), "", ButtonStyle::Plain, Some("▶️".into()), page >= pages - 1)
            .button_full(nav("refresh"), "", ButtonStyle::Plain, Some("🔄".into()), false)
            .button_full(format!("econlb:{owner}:{board}:{other}:0:scope"), if other == "global" { "Global" } else { "This server" }, ButtonStyle::Primary, Some(if other == "global" { "🌍" } else { "🏠" }.into()), false)
    }

    // ------------------------------------------------------------------ commands
    pub fn command(&self, ev: &CommandEvent, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        let me = &ev.member;
        if !perms::allowed(self.db, self.guild, me, USE) { return private(format!("You don't have permission for that (`{}`).", USE.key)); }
        let now = ev.at_ms;
        match ev.name.as_str() {
            "balance" => vec![Action::Reply { card: self.quick_row(self.quiet(self.gems_line(self.wallet_card(me, now), &me.id)), &me.id, true) }],
            "View wallet" => {
                let Some(t) = ev.target.as_ref() else { return private("Pick a member.") };
                if t.bot { return private("Bots do not have wallets."); }
                vec![Action::Reply { card: self.wallet_card(t, now).private() }]
            }
            "Pay member" => {
                let Some(t) = ev.target.as_ref().filter(|t| !t.bot && t.id != me.id) else { return private("Pick another member (not a bot, not yourself).") };
                self.intro("Pay a member", format!("You have {}. Pick who to pay and how much in the form.", self.money(self.wallet(me).coins)), format!("mpx:pay:{}:{}", me.id, t.id), "Configure payment", "💸", ButtonStyle::Primary)
            }
            "pay" => self.intro("Pay a member", format!("You have {}. Pick who to pay and how much in the form.", self.money(self.wallet(me).coins)), format!("mpx:pay:{}:-", me.id), "Configure payment", "💸", ButtonStyle::Primary),
            "economy-admin" => {
                if !self.staff(me) { return private(format!("You don't have permission for that (`{}`).", ADMIN.key)); }
                self.intro("Adjust a wallet", "Give, take or set coins for one member. Every change is written to the ledger with your reason.".into(), format!("mpx:adjust:{}:-", me.id), "Configure adjustment", "🛠️", ButtonStyle::Danger)
            }
            "treasury" => vec![Action::Reply { card: self.quiet(self.treasury_card(me, now)) }],
            "exchange" => {
                if !self.on("gemsEnabled") { return private("This server has no second currency. An admin can turn it on in the launcher under Economy."); }
                self.wallet(me);
                vec![Action::Reply { card: self.exchange_card(me) }]
            }
            "daily" => self.daily(me, now),
            "top" => {
                self.wallet(me); // keeps the name shown on the global board current
                vec![Action::Reply { card: self.quiet(self.board_card(&me.id, "coins", "server", 0)) }]
            }
            "shop" => { self.wallet(me); vec![Action::Reply { card: self.shop_card(me, None, now) }] }
            "bank" => { self.wallet(me); vec![Action::Reply { card: self.bank_card(me, None, now) }] }
            "work" => self.work(me, now, roll),
            "rob" => self.rob(me, ev.target.as_ref(), now, roll),
            "pet" => self.pet(ev, now, roll),
            _ => private("That command is not here."),
        }
    }
    fn daily(&self, me: &Member, now: i64) -> Vec<Action> {
        self.wallet(me); // a new member starts with the server's starting coins
        let base = self.int("dailyBase");
        let income_tax = self.int("taxIncome");
        let outcome = self.db.get().batch(|s| {
            let w = s.wallet(self.guild, &me.id, None, 0)?;
            match claim_daily(w.streak, w.last_daily, w.shields, w.best_streak, base, now) {
                Err(next) => Ok(Err(next)),
                Ok(c) => {
                    s.set_daily(self.guild, &me.id, c.streak, c.best_streak, c.shields, now)?;
                    s.credit(self.guild, &me.id, c.total, &format!("daily (streak {})", c.streak))?;
                    let tax = s.skim_in(self.guild, &me.id, tax_of(c.total, income_tax), "tax:income", now)?;
                    Ok(Ok((c, tax)))
                }
            }
        });
        let (c, tax) = match outcome {
            Ok(Ok(c)) => c,
            Ok(Err(next)) => return private(format!("⏳ You already claimed. Your next daily is ready {}.", ts(next))),
            Err(_) => return private("The wallet could not be read just now. Try again in a moment."),
        };
        let mut lines = vec![if c.bonus > 0 { format!("You got {} + {} **day {} bonus!**", self.money(c.reward), self.money(c.bonus), c.streak) } else { format!("You got {}", self.money(c.reward)) }];
        if c.used_shield { lines.push("🛡️ A Streak Shield saved your streak.".into()); }
        if c.lost { lines.push("💔 You missed a day, so your streak started again.".into()); }
        if c.shield_earned { lines.push(format!("🛡️ You earned a Streak Shield ({}/3). It saves your streak if you miss a day.", c.shields)); }
        if tax > 0 { lines.push(format!("🏛️ Tax: {} went to the server treasury.", group(tax))); }
        lines.push(format!("Next daily {}.", ts(c.next_at)));
        let extra = ((c.reward as f64 / base as f64 - 1.0) * 100.0 + 0.5).floor() as i64;
        let card = Card::new(Area::Money).title(format!("🔥 Day {} streak", c.streak)).line(lines.join("\n")).line(format!("-# Streak bonus: +{extra}% · it grows every day you come back"));
        vec![Action::Reply { card: self.quick_row(self.quiet(card), &me.id, false) }]
    }
    fn work(&self, me: &Member, now: i64, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        let w = self.wallet(me);
        let every = self.int("workCooldownMinutes").max(1) * 60_000;
        if w.last_work != 0 && now - w.last_work < every { return private(format!("😴 You're tired. You can work again {}.", ts(w.last_work + every))); }
        let lo = self.int("workMin");
        let hi = self.int("workMax").max(lo);
        let coins = roll(lo, hi).clamp(lo, hi);
        let (job, emoji) = JOBS[roll(0, JOBS.len() as i64 - 1).clamp(0, JOBS.len() as i64 - 1) as usize];
        let n = roll(2, 10).clamp(2, 10);
        let _ = self.db.get().batch(|s| { s.set_last_work(self.guild, &me.id, now)?; s.credit(self.guild, &me.id, coins, "work")?; Ok(()) });
        let pet = self.db.get().pet(self.guild, &me.id).ok().flatten();
        let boosted = self.boost_until(&me.id, "workboost", now) > 0;
        let pct = pet_bonus(pet.as_ref(), now) + if boosted { 50 } else { 0 };
        let extra = coins * pct / 100;
        if extra > 0 { self.credit(&me.id, extra, "work (bonus)"); }
        let tax = self.tax_income(&me.id, coins + extra, now);
        let why: Vec<String> = [boosted.then(|| "💼 work boost".to_string()), pet.as_ref().filter(|p| pet_bonus(Some(p), now) > 0).map(|p| format!("{} cheered you on", p.name))].into_iter().flatten().collect();
        let bonus = if extra > 0 { format!(" + {} ({}: +{pct}%)", self.money(extra), why.join(", ")) } else { String::new() };
        vec![Action::Reply { card: self.quiet(Card::new(Area::Money).line(format!("{emoji} You {} and earned {}{bonus}.{}\n-# You can work again {}.", job.replace("{n}", &n.to_string()), self.money(coins), if tax > 0 { format!("\n🏛️ Tax: {} went to the server treasury.", group(tax)) } else { String::new() }, ts(now + every)))) }]
    }
    fn rob(&self, me: &Member, target: Option<&Member>, now: i64, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        if !self.on("robbing") { return private("Robbing is turned off in this server."); }
        let Some(t) = target.filter(|t| !t.bot && t.id != me.id) else { return private("Pick another member (not a bot, not yourself).") };
        let (r, tw) = (self.wallet(me), self.wallet(t));
        let rm = self.db.get().wallet_more(self.guild, &me.id).unwrap_or_default();
        let tm = self.db.get().wallet_more(self.guild, &t.id).unwrap_or_default();
        if rm.last_rob != 0 && now - rm.last_rob < ROB_COOLDOWN { return private(format!("Lay low for a bit. You can rob again <t:{}:R>.", (rm.last_rob + ROB_COOLDOWN) / 1000)); }
        if r.coins < 250 { return private("You need at least 250 coins in your wallet to try (you might get fined)."); }
        if tw.coins < ROB_MIN { return private(format!("They don't have enough in their wallet to be worth it (under {ROB_MIN}).")); }
        if tm.robbed_at != 0 && now - tm.robbed_at < ROB_SHIELD { return private("They were robbed not long ago. Leave them alone for a while."); }
        let lock = self.db.get().items(self.guild, &t.id).unwrap_or_default().iter().any(|(i, q)| i == PADLOCK_ID && *q > 0);
        let (r1, r2) = (roll(0, 999_999) as f64 / 1e6, roll(0, 999_999) as f64 / 1e6);
        let (outcome, mut coins) = rob_outcome(r.coins, tw.coins, lock, self.int("robMax"), r1, r2);
        let store = self.db.get();
        let _ = store.batch(|s| {
            if outcome == "stole" {
                s.set_rob_times(self.guild, &me.id, Some(&t.id), now)?;
                let _ = s.debit(self.guild, &t.id, coins, &format!("robbed by {}", me.id))?;
                s.move_coins(self.guild, &me.id, coins, &format!("robbed {}", t.id))?;
            } else {
                s.set_rob_times(self.guild, &me.id, None, now)?;
                let have = s.wallet(self.guild, &me.id, None, 0)?.coins;
                coins = coins.min(have);
                if coins > 0 {
                    let _ = s.debit(self.guild, &me.id, coins, &format!("rob fine to {}", t.id))?;
                    s.move_coins(self.guild, &t.id, coins, &format!("rob fine from {}", me.id))?;
                }
                if outcome == "padlock" { s.item_use(self.guild, &t.id, PADLOCK_ID)?; }
            }
            Ok(())
        });
        drop(store);
        let text = match outcome {
            "stole" => format!("🦹 <@{}> robbed <@{}> and got away with {}!", me.id, t.id, self.money(coins)),
            "padlock" => format!("🔒 <@{}>'s padlock stopped <@{}>! The padlock broke, and the robber paid {} as a fine.", t.id, me.id, self.money(coins)),
            _ => format!("🚓 <@{}> got caught trying to rob <@{}> and paid them {}.", me.id, t.id, self.money(coins)),
        };
        vec![Action::Reply { card: Card::new(Area::Money).line(text) }]
    }
    fn pet(&self, ev: &CommandEvent, now: i64, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        let me = &ev.member;
        let arg = |k: &str| ev.args.get(k).map(String::as_str).filter(|s| !s.trim().is_empty());
        let store = self.db.get();
        let pet = store.pet(self.guild, &me.id).ok().flatten();
        drop(store);
        match ev.sub.as_deref().unwrap_or("info") {
            "adopt" => {
                let Some((kind, _, label, price)) = PETS.iter().find(|k| Some(k.0) == arg("kind")).copied() else { return private("Pick a pet from the list.") };
                if pet.is_some() { return private("You already have a pet. Love the one you have!"); }
                let name: String = arg("name").unwrap_or("").trim().chars().filter(|c| !"*_`~|<>@#".contains(*c)).take(20).collect();
                let name = if name.is_empty() { label.to_string() } else { name };
                if let Err(no) = self.debit(&me.id, price, &format!("adopted a {label}")) { return private(no); }
                let _ = self.db.get().pet_adopt(self.guild, &me.id, kind, &name, now);
                let p = self.db.get().pet(self.guild, &me.id).ok().flatten().unwrap_or_default();
                vec![Action::Reply { card: self.pet_card(&p, Some(format!("🎉 Welcome home, **{name}**!")), now) }]
            }
            what @ ("feed" | "play") => {
                let Some(p) = pet else { return private("You don't have a pet yet. Adopt one with `/pet adopt`.") };
                let last = if what == "feed" { p.fed_at } else { p.played_at };
                if let Some(l) = last.filter(|l| now - l < 30 * 60_000) { return private(format!("{} isn't {} right now. Try again <t:{}:R>.", p.name, if what == "feed" { "hungry" } else { "in the mood" }, (l + 30 * 60_000) / 1000)); }
                let (hunger, happy) = pet_now(&p, now);
                let (gain, xp, texts): (i64, i64, [&str; 3]) = if what == "feed" { (35, 5, ["gobbles it all up", "happily munches away", "licks the bowl clean"]) } else { (30, 8, ["zooms around in circles", "brings the ball back again and again", "does a little happy dance"]) };
                if what == "feed" { if let Err(no) = self.debit(&me.id, 50, &format!("fed {}", p.name)) { return private(no); } }
                let (h2, p2) = if what == "feed" { ((hunger + gain).min(100), happy) } else { (hunger, (happy + gain).min(100)) };
                let _ = self.db.get().pet_care(self.guild, &me.id, h2, p2, xp, now, Some(what));
                let after = self.db.get().pet(self.guild, &me.id).ok().flatten().unwrap_or_default();
                let emoji = PETS.iter().find(|k| k.0 == p.kind).map(|k| k.1).unwrap_or("🐾");
                let up = pet_level(after.xp) > pet_level(p.xp);
                let text = format!("{emoji} **{}** {}!{}", p.name, texts[roll(0, 2).clamp(0, 2) as usize], if up { format!(" ⬆️ {} is now level {}!", p.name, pet_level(after.xp)) } else { String::new() });
                vec![Action::Reply { card: self.pet_card(&after, Some(text), now) }]
            }
            _ => {
                let who = ev.target.clone().unwrap_or_else(|| me.clone());
                let theirs = if who.id == me.id { pet } else { self.db.get().pet(self.guild, &who.id).ok().flatten() };
                let Some(p) = theirs else { return private(if who.id == me.id { "You don't have a pet yet. Adopt one with `/pet adopt`." } else { "They don't have a pet." }) };
                vec![Action::Reply { card: self.pet_card(&p, None, now) }]
            }
        }
    }

    // ------------------------------------------------------------------ buttons and dropdowns
    pub fn press(&self, ev: &ButtonEvent, now: i64, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        let _ = roll;
        let me = &ev.member;
        let parts: Vec<&str> = ev.id.splitn(3, ':').collect();
        let (what, owner) = (parts.get(1).copied().unwrap_or(""), parts.get(2).copied().unwrap_or(""));
        let not_yours = || private("That menu belongs to someone else. Run the command for your own.");
        match what {
            "daily" => self.daily(me, now),
            "top" => vec![Action::Reply { card: self.board_card(&me.id, "coins", "server", 0).private() }],
            "ev" => self.event_press(me, owner),
            "buy" => {
                if owner != me.id { return not_yours(); }
                match self.buy(me, ev.values.first().map(String::as_str).unwrap_or(""), now) {
                    Ok((text, mut extra)) => { let mut out = vec![Action::Update { card: self.shop_card(me, Some(format!("✅ {text}")), now) }]; out.append(&mut extra); out }
                    Err(no) => private(no),
                }
            }
            "inv" => { if owner != me.id { return not_yours(); } vec![Action::Update { card: self.inventory_card(me, None) }] }
            "shop" => { if owner != me.id { return not_yours(); } vec![Action::Update { card: self.shop_card(me, None, now) }] }
            "use" => {
                if owner != me.id { return not_yours(); }
                match self.use_item(&me.id, ev.values.first().map(String::as_str).unwrap_or(""), now) {
                    Ok(text) => vec![Action::Update { card: self.inventory_card(me, None) }, Action::FollowUp { card: Card::new(Area::Money).line(text) }],
                    Err(no) => private(no),
                }
            }
            "rmlist" => {
                if owner != me.id { return not_yours(); }
                if !self.staff(me) { return private("Only staff can change the shop."); }
                let mut options: Vec<(String, String, Option<String>)> = self.starters().into_iter().filter(|s| !s.5).map(|s| (format!("{} (built-in)", s.1), format!("builtin:{}", s.0), None)).collect();
                options.extend(self.db.get().shop_items(self.guild).unwrap_or_default().into_iter().map(|it| (short(&it.name, 100), it.id, None)));
                options.truncate(25);
                vec![Action::Reply { card: Card::new(Area::Money).line("Which item should go?").select(Select { id: format!("econ:rm:{}", me.id), placeholder: "Pick an item to remove".into(), min: 1, max: 1, options }).private() }]
            }
            "rm" => {
                if owner != me.id { return not_yours(); }
                if !self.staff(me) { return private("Only staff can change the shop."); }
                let v = ev.values.first().cloned().unwrap_or_default();
                if let Some(id) = v.strip_prefix("builtin:") {
                    let mut saved = self.data().get(&format!("builtin:{id}")).unwrap_or_else(|| json!({}));
                    saved["off"] = json!(true);
                    self.data().set(&format!("builtin:{id}"), &saved);
                } else if !self.db.get().shop_remove(self.guild, &v).unwrap_or(false) {
                    return private("There is no item like that in the shop.");
                }
                vec![Action::Update { card: Card::new(Area::Money).line(format!("Removed from the shop. Members who bought it keep what they have.{}", if v.starts_with("builtin:") { " Built-in items can be brought back on the dashboard's Shop page." } else { "" })).private() }]
            }
            _ => private("That button is no longer active."),
        }
    }
    /// The leaderboard's buttons and picker (`econlb:<owner>:<board>:<scope>:<page>:<action>`).
    pub fn board_press(&self, ev: &ButtonEvent) -> Vec<Action> {
        let p: Vec<&str> = ev.id.split(':').collect();
        if p.len() != 6 { return private("That leaderboard button is broken. Run `/top` again."); }
        let (owner, board, scope, page, action) = (p[1], p[2], p[3], p[4].parse::<i64>().unwrap_or(0).max(0), p[5]);
        if owner != ev.member.id {
            return vec![Action::Reply { card: Card::new(Area::Money).line("That board belongs to someone else, so here is your own copy.").private() }, Action::FollowUp { card: self.board_card(&ev.member.id, board, scope, 0) }];
        }
        let board = if action == "board" { ev.values.first().map(String::as_str).unwrap_or(board) } else { board };
        let page = match action { "board" => 0, "prev" => page - 1, "next" => page + 1, _ => page };
        vec![Action::Update { card: self.board_card(owner, board, scope, page) }]
    }

    /// Buys one of something. Gives what to say, and what else to do (a role to give).
    fn buy(&self, me: &Member, item: &str, now: i64) -> Result<(String, Vec<Action>), String> {
        if let Some((id, name, emoji, _, price, off)) = self.starters().into_iter().find(|s| s.0 == item) {
            if off { return Err("That item is not for sale in this server.".into()); }
            self.debit(&me.id, price, &format!("bought {name}"))?;
            if id != "ticket" { self.sale(&me.id, price, name, now); }
            if id == "ticket" {
                let _ = self.db.get().lottery_buy(self.guild, &week_of(now), &me.id, price);
                let (_, _, pool, mine) = self.lottery(&me.id, now);
                return Ok((format!("🎟️ You're in this week's draw with **{mine}** ticket{}. The prize is up to **{}** coins and grows with every ticket. The winner is drawn on Monday.", if mine == 1 { "" } else { "s" }, group(pool)), Vec::new()));
            }
            let _ = self.db.get().item_add(self.guild, &me.id, id);
            return Ok((format!("{emoji} You bought a **{name}**. Use it from your inventory when you want it."), Vec::new()));
        }
        if item == PADLOCK_ID {
            if !self.on("robbing") { return Err("Robbing is off in this server, so you don't need a padlock.".into()); }
            self.debit(&me.id, self.padlock_price(), "bought a Padlock")?;
            self.sale(&me.id, self.padlock_price(), "Padlock", now);
            let _ = self.db.get().item_add(self.guild, &me.id, PADLOCK_ID);
            return Ok(("🔒 You bought a **Padlock**. It stops the next person who tries to rob you (and they pay you a fine).".into(), Vec::new()));
        }
        if item == SHIELD_ID {
            let w = self.wallet(me);
            if w.shields >= MAX_SHIELDS { return Err(format!("You already have {MAX_SHIELDS} Streak Shields, the most you can hold.")); }
            self.debit(&me.id, self.shield_price(), "bought a Streak Shield")?;
            self.sale(&me.id, self.shield_price(), "Streak Shield", now);
            let _ = self.db.get().add_shield(self.guild, &me.id);
            return Ok((format!("🛡️ You bought a **Streak Shield** ({}/{MAX_SHIELDS}). It saves your daily streak if you miss a day.", w.shields + 1), Vec::new()));
        }
        let Some(it) = self.db.get().shop_item(self.guild, item).ok().flatten() else { return Err("That item is no longer in the shop.".into()) };
        if it.stock == Some(0) { return Err("That item is sold out.".into()); }
        if let Some(role) = &it.role_id {
            let Some(r) = self.dir.role(self.guild, role) else { return Err("That role was deleted. Tell an admin to fix the shop.".into()) };
            if me.roles.contains(role) && it.hours == 0 { return Err("You already have that role.".into()); }
            if r.managed || self.dir.my_top(self.guild).is_some_and(|top| r.position >= top) { return Err("I can't give that role (my role must be above it). Tell an admin.".into()); }
        }
        self.debit(&me.id, it.price, &format!("bought {}", it.name))?;
        if it.stock.is_some() && !self.db.get().shop_take_one(self.guild, &it.id).unwrap_or(false) {
            let _ = self.db.get().move_coins(self.guild, &me.id, it.price, &format!("refund: {}", it.name));
            return Err("That item just sold out.".into());
        }
        self.sale(&me.id, it.price, &it.name, now);
        let emoji = it.emoji.clone().unwrap_or_else(|| "🎁".into());
        match &it.role_id {
            Some(role) => {
                let give = vec![Action::Roles { user: me.id.clone(), add: vec![role.clone()], remove: Vec::new(), reason: format!("Bought in the shop: {}", it.name) }];
                if it.hours > 0 {
                    let key = format!("shoprole:{}:{role}", me.id);
                    let until = now.max(self.data().get(&key).and_then(|v| v.as_i64()).unwrap_or(0)) + it.hours * HOUR; // buying again adds time
                    self.data().set(&key, &json!(until));
                    return Ok((format!("{emoji} You bought **{}**: you have <@&{role}> until <t:{}:f>.", it.name, until / 1000), give));
                }
                Ok((format!("{emoji} You bought **{}** and got <@&{role}>.", it.name), give))
            }
            None => {
                let _ = self.db.get().item_add(self.guild, &me.id, &it.id);
                Ok((format!("{emoji} You bought **{}**. It's in your inventory{}.", it.name, if it.message.is_some() { ": use it from `/shop`" } else { "" }), Vec::new()))
            }
        }
    }
    fn use_item(&self, user: &str, item: &str, now: i64) -> Result<String, String> {
        let Some((_, qty, name, emoji, message, consumable)) = self.inventory(user).into_iter().find(|x| x.0 == item) else { return Err("You don't have that item.".into()) };
        if item == "treat" || BOOSTS.iter().any(|b| b.0 == item) {
            let text = if item == "treat" {
                let Some(pet) = self.db.get().pet(self.guild, user).ok().flatten() else { return Err("You need a pet for that. Adopt one with `/pet adopt`.".into()) };
                let (hunger, happy) = pet_now(&pet, now);
                let (h, p) = ((hunger + 20).min(100), (happy + 40).min(100));
                let _ = self.db.get().pet_care(self.guild, user, h, p, 6, now, None);
                format!("🦴 **{}** loves the treat! (happy {p}, fed {h})", pet.name)
            } else {
                let (_, ms, label) = BOOSTS.iter().find(|b| b.0 == item).copied().unwrap_or(("", 0, ""));
                let key = format!("boost:{item}:{user}");
                let until = now.max(self.data().get(&key).and_then(|v| v.as_i64()).unwrap_or(0)) + ms; // another adds more time
                self.data().set(&key, &json!(until));
                format!("{} **{label}** until <t:{}:t>.", emoji.unwrap_or_default(), until / 1000)
            };
            let _ = self.db.get().item_use(self.guild, user, item);
            return Ok(format!("{text}\n-# {} left.", qty - 1));
        }
        let Some(name) = name else { return Err("That item was taken out of the shop, so it does nothing now.".into()) };
        if consumable { let _ = self.db.get().item_use(self.guild, user, item); }
        let said = message.map(|m| m.replace("{user}", &format!("<@{user}>"))).unwrap_or_else(|| format!("You looked at your **{name}**. Nice."));
        Ok(format!("{} {said}{}", emoji.unwrap_or_else(|| "🎁".into()), if consumable { format!("\n-# {name} was used up ({} left).", qty - 1) } else { String::new() }))
    }

    // ------------------------------------------------------------------ popups
    /// A button that opens one of Good Boy 3's forms (`mpx:<form>:<owner>:<member or ->`).
    pub fn open_form(&self, ev: &ButtonEvent) -> Vec<Action> {
        let p: Vec<&str> = ev.id.splitn(4, ':').collect();
        let (form, owner, target) = (p.get(1).copied().unwrap_or(""), p.get(2).copied().unwrap_or(""), p.get(3).copied().unwrap_or("-"));
        if owner != ev.member.id { return private("That form belongs to someone else. Run the command yourself to get your own."); }
        let amount = || Field { id: "amount".into(), label: "How much".into(), placeholder: Some("e.g. 500, 2.5k, half or all".into()), required: true, max: 20, ..Default::default() };
        let (title, fields) = match form {
            "pay" => {
                let mut f = Vec::new();
                if target == "-" { f.push(Field { id: "to".into(), label: "Who to pay".into(), kind: FieldKind::User { most: 1 }, required: true, ..Default::default() }); }
                f.push(Field { id: "amount".into(), label: "Amount".into(), placeholder: Some("e.g. 500, 2.5k, half or all".into()), required: true, max: 20, ..Default::default() });
                f.push(Field { id: "note".into(), label: "Note (optional)".into(), placeholder: Some("What it is for".into()), max: 100, ..Default::default() });
                ("Pay a member", f)
            }
            "tdonate" => ("Give coins to the treasury", vec![amount(), Field { id: "note".into(), label: "Note (optional)".into(), placeholder: Some("What it is for".into()), max: 100, ..Default::default() }]),
            "tadd" => {
                if !self.is_server_owner(&ev.member) { return private("Only the server owner can add coins to the treasury."); }
                ("Add coins to the treasury", vec![amount(), Field { id: "note".into(), label: "Note (optional)".into(), placeholder: Some("What it is for".into()), max: 100, ..Default::default() }])
            }
            "tgive" => {
                if !self.staff(&ev.member) { return private(format!("You don't have permission for that (`{}`).", ADMIN.key)); }
                ("Pay out from the treasury", vec![
                    Field { id: "who".into(), label: "Member".into(), kind: FieldKind::User { most: 1 }, required: true, ..Default::default() },
                    amount(),
                    Field { id: "reason".into(), label: "Reason (kept in the record)".into(), long: true, required: true, max: 120, placeholder: Some("e.g. Event winner".into()), ..Default::default() },
                ])
            }
            "xgems" => {
                if !self.on("gemsEnabled") { return private("This server has no second currency."); }
                ("Coins into the second currency", vec![Field { id: "amount".into(), label: "Coins to spend".into(), placeholder: Some("e.g. 1000, 2.5k, half or all".into()), required: true, max: 20, ..Default::default() }])
            }
            "xcoins" => {
                if !self.on("gemsEnabled") { return private("This server has no second currency."); }
                ("Second currency into coins", vec![Field { id: "amount".into(), label: "How many to sell".into(), placeholder: Some("e.g. 5 or all".into()), required: true, max: 20, ..Default::default() }])
            }
            "deposit" => ("Put coins in the bank", vec![amount()]),
            "withdraw" => ("Take coins out of the bank", vec![amount()]),
            "shopadd" => {
                if !self.staff(&ev.member) { return private(format!("You don't have permission for that (`{}`).", ADMIN.key)); }
                ("Add to the shop", vec![
                    Field { id: "name".into(), label: "Name".into(), placeholder: Some("e.g. VIP or Golden Bone".into()), required: true, max: 60, ..Default::default() },
                    Field { id: "price".into(), label: "Price".into(), placeholder: Some("e.g. 5000 or 5k".into()), required: true, max: 15, ..Default::default() },
                    Field { id: "role".into(), label: "Role it gives (empty for an item)".into(), kind: FieldKind::Role { most: 1 }, ..Default::default() },
                    Field { id: "details".into(), label: "Hours | stock | emoji (all optional)".into(), placeholder: Some("e.g. 24 | 10 | 🦴  (24 h role, 10 for sale)".into()), max: 60, ..Default::default() },
                    Field { id: "message".into(), label: "Description, or what using the item says".into(), long: true, placeholder: Some("Items: {user} is replaced with the buyer. Start with ! to use it up when used.".into()), max: 500, ..Default::default() },
                ])
            }
            "adjust" => {
                if !self.staff(&ev.member) { return private(format!("You don't have permission for that (`{}`).", ADMIN.key)); }
                ("Adjust a wallet", vec![
                    Field { id: "who".into(), label: "Member".into(), kind: FieldKind::User { most: 1 }, required: true, ..Default::default() },
                    Field { id: "op".into(), label: "Action".into(), kind: FieldKind::Select({ let mut o = vec![("Give coins".into(), "give".into()), ("Take coins".into(), "take".into()), ("Set balance to".into(), "set".into())]; if self.on("gemsEnabled") { o.push((format!("Give {}", self.gem_name()), "gemgive".into())); o.push((format!("Take {}", self.gem_name()), "gemtake".into())); } o }), required: true, value: Some("give".into()), ..Default::default() },
                    Field { id: "amount".into(), label: "Amount".into(), placeholder: Some("e.g. 1000 or 10k".into()), required: true, max: 20, ..Default::default() },
                    Field { id: "reason".into(), label: "Reason (kept in the ledger)".into(), long: true, required: true, max: 200, ..Default::default() },
                ])
            }
            _ => return private("That button is no longer active."),
        };
        vec![Action::Form { id: format!("mpx:{form}:{target}"), title: title.into(), fields }]
    }
    pub fn form(&self, ev: &FormEvent, now: i64) -> Vec<Action> {
        let me = &ev.member;
        let v = |k: &str| ev.values.get(k).map(|s| s.trim().to_string()).unwrap_or_default();
        let p: Vec<&str> = ev.id.splitn(3, ':').collect();
        let (form, target) = (p.get(1).copied().unwrap_or(""), p.get(2).copied().unwrap_or("-"));
        match form {
            "pay" => {
                let to = if target != "-" { target.to_string() } else { v("to") };
                if to.is_empty() { return private("Pick who to pay."); }
                if to == me.id { return private("You cannot pay yourself."); }
                let them = ev.members.iter().find(|m| m.id == to).cloned().unwrap_or(Member { id: to.clone(), ..Default::default() });
                if them.bot { return private("Bots do not need coins."); }
                let have = self.wallet(me).coins;
                let amount = match parse_amount(&v("amount"), Some(have), 1, self.int("maxPay")) { Ok(n) => n, Err(no) => return private(no) };
                self.wallet(&them);
                let tax = tax_of(amount, self.int("taxPay"));
                let paid = self.db.get().pay_taxed(self.guild, &me.id, &to, amount, tax, &format!("pay to {to}"), &format!("pay from {}", me.id), now);
                match paid {
                    Ok(Ok(_)) => {}
                    Ok(Err(Short::Only(have))) => return private(format!("You only have {}.", self.money(have))),
                    Err(_) => return private("The wallet could not be changed just now. Try again in a moment."),
                }
                let note = if v("note").is_empty() { String::new() } else { format!("\n> {}", crate::welcome::sanitize_name(&v("note"), 100)) };
                let taxed = if tax > 0 { format!("\n-# 🏛️ {}% tax: {} went to the server treasury, <@{to}> got {}.", self.int("taxPay"), group(tax), group(amount - tax)) } else { String::new() };
                vec![Action::Reply { card: Card::new(Area::Money).line(format!("<@{to}>")).line(format!("💸 <@{}> paid <@{to}> {}{note}{taxed}", me.id, self.money(amount))) }]
            }
            "tdonate" => {
                let amount = match parse_amount(&v("amount"), Some(self.wallet(me).coins), 1, i64::MAX) { Ok(n) => n, Err(no) => return private(no) };
                let note = crate::welcome::sanitize_name(&v("note"), 100);
                let done = self.db.get().batch(|s| match s.debit(self.guild, &me.id, amount, "gift to the treasury")? {
                    Err(short) => Ok(Err(short)),
                    Ok(_) => { s.treasury_in(self.guild, amount, "donation", Some(&me.id), Some(&note).filter(|n| !n.is_empty()).map(|n| n.as_str()), now)?; Ok(Ok(())) }
                });
                match done {
                    Ok(Ok(())) => vec![Action::Reply { card: Card::new(Area::Money).line(format!("🏛️ <@{}> gave {} to the server treasury. Thank you!{}", me.id, self.money(amount), if note.is_empty() { String::new() } else { format!("\n> {note}") })) }],
                    Ok(Err(Short::Only(have))) => private(format!("You only have {}.", self.money(have))),
                    Err(_) => private("The wallet could not be changed just now. Try again in a moment."),
                }
            }
            "tadd" => {
                if !self.is_server_owner(me) { return private("Only the server owner can add coins to the treasury."); }
                let amount = match parse_amount(&v("amount"), None, 1, 1_000_000_000_000) { Ok(n) => n, Err(no) => return private(no) };
                let note = crate::welcome::sanitize_name(&v("note"), 100);
                if self.db.get().treasury_in(self.guild, amount, "staff", Some(&me.id), Some(&note).filter(|n| !n.is_empty()).map(|n| n.as_str()), now).is_err() { return private("The treasury could not be changed just now. Try again in a moment."); }
                let left = self.db.get().treasury(self.guild).map(|t| t.balance).unwrap_or(amount);
                vec![Action::Reply { card: Card::new(Area::Money).line(format!("🏛️ <@{}> added {} to the server treasury. It now has {}.{}", me.id, self.money(amount), self.money(left), if note.is_empty() { String::new() } else { format!("\n> {note}") })) }]
            }
            "tgive" => {
                if !self.staff(me) { return private(format!("You don't have permission for that (`{}`).", ADMIN.key)); }
                let amount = match parse_amount(&v("amount"), None, 1, 1_000_000_000_000) { Ok(n) => n, Err(no) => return private(no) };
                let who = v("who");
                if who.is_empty() { return private("Pick a member."); }
                match self.treasury_give(&me.id, &who, amount, &crate::welcome::sanitize_name(&v("reason"), 120), now) {
                    Ok((left, theirs)) => vec![Action::Reply { card: Card::new(Area::Money).line(format!("🏛️ <@{}> paid {} from the treasury to <@{who}> ({}).\n-# <@{who}> now has {}. The treasury has {} left.", me.id, self.money(amount), crate::welcome::sanitize_name(&v("reason"), 120), self.money(theirs), self.money(left))) }],
                    Err(no) => private(no),
                }
            }
            "xgems" => {
                if !self.on("gemsEnabled") { return private("This server has no second currency."); }
                let have = self.wallet(me).coins;
                let amount = match parse_amount(&v("amount"), Some(have), 1, i64::MAX) { Ok(n) => n, Err(no) => return private(no) };
                let (rate, fee) = (self.int("exchangeRate"), self.int("exchangeFee"));
                let Some((gems, cost, fee_coins)) = coins_to_gems(amount, rate, fee) else { return private(format!("That is not enough: one {} costs {} plus the {fee}% fee.", self.gem_name(), self.money(rate))) };
                let done = self.db.get().exchange_to_gems(self.guild, &me.id, cost, fee_coins, gems, now);
                match done {
                    Ok(Ok((left, now_gems))) => private(format!("💱 You swapped {} for {}.{}\n-# You now have {} and {}.", self.money(cost), self.gem(gems), if fee_coins > 0 { format!(" The fee ({}) went to the server treasury.", group(fee_coins)) } else { String::new() }, self.money(left), self.gem(now_gems))),
                    Ok(Err(Short::Only(have))) => private(format!("You only have {}.", self.money(have))),
                    Err(_) => private("The wallet could not be changed just now. Try again in a moment."),
                }
            }
            "xcoins" => {
                if !self.on("gemsEnabled") { return private("This server has no second currency."); }
                let have = self.db.get().gems(self.guild, &me.id).unwrap_or(0);
                let n = match parse_amount(&v("amount"), Some(have), 1, i64::MAX) { Ok(n) => n, Err(no) => return private(no) };
                if n > have { return private(format!("You only have {}.", self.gem(have))); }
                let (coins, fee_coins) = gems_to_coins(n, self.int("exchangeRate"), self.int("exchangeFee"));
                self.wallet(me);
                let done = self.db.get().exchange_to_coins(self.guild, &me.id, n, coins, fee_coins, now);
                match done {
                    Ok(Ok((c, g))) => private(format!("💱 You swapped {} for {}.{}\n-# You now have {} and {}.", self.gem(n), self.money(coins), if fee_coins > 0 { format!(" The fee ({}) went to the server treasury.", group(fee_coins)) } else { String::new() }, self.money(c), self.gem(g))),
                    Ok(Err(Short::Only(have))) => private(format!("You only have {}.", self.gem(have))),
                    Err(_) => private("The wallet could not be changed just now. Try again in a moment."),
                }
            }
            "deposit" => {
                let amount = match parse_amount(&v("amount"), Some(self.wallet(me).coins), 1, i64::MAX) { Ok(n) => n, Err(no) => return private(no) };
                self.settle_bank(&me.id, now);
                let put = self.db.get().deposit(self.guild, &me.id, amount);
                match put {
                    Ok(Ok(())) => {}
                    Ok(Err(Short::Only(have))) => return private(format!("You only have {}.", self.money(have))),
                    Err(_) => return private("The bank could not be changed just now."),
                }
                vec![Action::Reply { card: self.bank_card(me, Some(format!("📥 Put {} in the bank.", self.money(amount))), now) }]
            }
            "withdraw" => {
                let (w, _) = self.settle_bank(&me.id, now);
                let amount = match parse_amount(&v("amount"), Some(w.bank), 1, i64::MAX) { Ok(n) => n, Err(no) => return private(no) };
                if amount > w.bank || !self.db.get().withdraw(self.guild, &me.id, amount).unwrap_or(false) { return private(format!("You only have {} in the bank.", group(w.bank))); }
                let fee_due = tax_of(amount, self.int("taxWithdraw"));
                let fee = self.db.get().skim(self.guild, &me.id, fee_due, "tax:withdraw", now).unwrap_or(0);
                let said = if fee > 0 { format!("📤 Took {} out of the bank. 🏛️ {} went to the server treasury as a fee.", self.money(amount), group(fee)) } else { format!("📤 Took {} out of the bank.", self.money(amount)) };
                vec![Action::Reply { card: self.bank_card(me, Some(said), now) }]
            }
            "shopadd" => {
                if !self.staff(me) { return private(format!("You don't have permission for that (`{}`).", ADMIN.key)); }
                let price = match parse_amount(&v("price"), None, 1, 1_000_000_000_000) { Ok(n) => n, Err(no) => return private(no) };
                let details = v("details");
                let mut d = details.split('|').map(|x| x.trim().to_string());
                let (hours, stock, emoji) = (d.next().unwrap_or_default(), d.next().unwrap_or_default(), d.next().unwrap_or_default());
                if !hours.is_empty() && !hours.bytes().all(|b| b.is_ascii_digit()) { return private("Hours must be a whole number (or empty)."); }
                if !stock.is_empty() && !stock.bytes().all(|b| b.is_ascii_digit()) { return private("Stock must be a whole number (or empty for unlimited)."); }
                let name = v("name");
                let id = slug(&name);
                if id.is_empty() { return private("Give the item a name with letters or numbers."); }
                if id == SHIELD_ID { return private("That name is used by the built-in Streak Shield."); }
                let exists = self.db.get().shop_item(self.guild, &id).ok().flatten().is_some();
                if !exists && self.db.get().shop_items(self.guild).unwrap_or_default().len() >= SHOP_MAX { return private(format!("The shop can hold up to {SHOP_MAX} items.")); }
                let text = v("message");
                let consumable = text.starts_with('!');
                let role = Some(v("role")).filter(|r| !r.is_empty());
                let it = ShopItem {
                    id, name: name.chars().take(60).collect(), emoji: Some(emoji).filter(|e| !e.is_empty()).map(|e| e.chars().take(64).collect()), price,
                    description: if role.is_some() { Some(text.chars().take(200).collect::<String>()).filter(|t: &String| !t.is_empty()) } else { None },
                    hours: if role.is_some() { hours.parse().unwrap_or(0) } else { 0 }, stock: stock.parse().ok(),
                    message: if role.is_some() { None } else { Some(if consumable { text[1..].trim().to_string() } else { text.clone() }).filter(|t| !t.is_empty()).map(|t| t.chars().take(500).collect()) },
                    consumable: role.is_none() && consumable, role_id: role,
                };
                let replaced = self.db.get().shop_put(self.guild, &it).unwrap_or(false);
                private(format!("✅ {} **{}** for {}. Members buy it with `/shop`.", if replaced { "Updated" } else { "Added" }, short(&name, 60), self.money(price)))
            }
            "adjust" => {
                if !self.staff(me) { return private(format!("You don't have permission for that (`{}`).", ADMIN.key)); }
                let amount = match parse_amount(&v("amount"), None, 0, 1_000_000_000_000) { Ok(n) => n, Err(no) => return private(no) };
                let who = v("who");
                if who.is_empty() { return private("Pick a member."); }
                let them = ev.members.iter().find(|m| m.id == who).cloned().unwrap_or(Member { id: who.clone(), ..Default::default() });
                if matches!(v("op").as_str(), "gemgive" | "gemtake") {
                    if !self.on("gemsEnabled") { return private("This server has no second currency."); }
                    let n = if v("op") == "gemgive" { amount } else { -amount };
                    let now_has = self.db.get().gems_add(self.guild, &who, n).unwrap_or(0);
                    return private(format!("✅ <@{who}> now has {}.", self.gem(now_has)));
                }
                let w = self.wallet(&them);
                let reason = format!("admin {}: {}", me.id, v("reason"));
                let now_has = match v("op").as_str() {
                    "take" => { let take = amount.min(w.coins); if take > 0 { self.debit(&who, take, &reason).unwrap_or(w.coins) } else { w.coins } }
                    "set" => { let _ = self.db.get().set_coins(self.guild, &who, amount, &reason); amount }
                    _ => self.credit(&who, amount, &reason),
                };
                private(format!("✅ <@{who}> now has {}.", self.money(now_has)))
            }
            _ => private("That form is no longer active."),
        }
    }

    // ------------------------------------------------------------------ coin events
    /// Counts messages; now and then (and at most once every 10 minutes) a coin event is posted.
    pub fn on_message(&self, ev: &MessageEvent, roll: &mut dyn FnMut(i64, i64) -> i64) -> Vec<Action> {
        if ev.author.bot || !self.on("events") { return Vec::new(); }
        let every = self.int("eventEvery");
        let start = {
            let mut m = memory();
            let c = m.counts.entry(self.guild.to_string()).or_insert((0, 0, 0));
            // how many messages until the next one: 60–140% of the setting (from the clock, so the dice other
            // modules share are left alone)
            if c.1 == 0 { let spread = (ev.at_ms.unsigned_abs().wrapping_mul(2_654_435_761) % 800) as f64 / 1000.0; c.1 = 10.max((every as f64 * (0.6 + spread) + 0.5) as i64); }
            c.0 += 1;
            if c.0 < c.1 || ev.at_ms - c.2 < 10 * 60_000 { false } else { *c = (0, 0, ev.at_ms); true }
        };
        if !start { return Vec::new(); }
        let pick = EVENTS[roll(0, EVENTS.len() as i64 - 1).clamp(0, EVENTS.len() as i64 - 1) as usize];
        let prize = (self.int("dailyBase") as f64 * (1.0 + roll(0, 2999) as f64 / 1000.0) + 0.5) as i64;
        vec![self.start_event(&ev.place.channel, pick, prize, ev.at_ms, &format!("{:010x}", roll(0, i64::MAX / 2)))]
    }
    pub fn start_event(&self, channel: &str, pick: (&'static str, &'static str, &'static str, &'static str, &'static str), prize: i64, now: i64, id: &str) -> Action {
        let (kind, emoji, title, button, text) = pick;
        let title = format!("{emoji} {title}");
        memory().events.insert(id.to_string(), LiveEvent { guild: self.guild.to_string(), kind, prize, takers: Vec::new(), channel: channel.to_string(), message: None, title: title.clone(), ends: now + if kind == "split" { 30_000 } else { 120_000 } });
        let card = Card::new(Area::Money).title(title).line(format!("It holds {}. {text}", self.money(prize))).button_with(format!("econ:ev:{id}"), button, ButtonStyle::Good, Some(emoji.into()));
        Action::Post { channel: channel.to_string(), card, note: format!("econ:ev:{id}"), ping: Vec::new(), roles: Vec::new() }
    }
    fn event_press(&self, me: &Member, id: &str) -> Vec<Action> {
        let mut m = memory();
        let Some(st) = m.events.get_mut(id).filter(|e| e.guild == self.guild) else { return private("Too late, that one is over.") };
        if st.kind == "split" {
            if !st.takers.contains(&me.id) { st.takers.push(me.id.clone()); }
            return private(format!("You're in! {} so far. The coins are shared when time runs out.", st.takers.len()));
        }
        let prize = st.prize;
        m.events.remove(id);
        drop(m);
        self.wallet(me);
        self.credit(&me.id, prize, "chat event");
        vec![Action::Update { card: Card::new(Area::Money).line(format!("🏃 <@{}> got there first and won {}!", me.id, self.money(prize))) }]
    }
    pub fn posted(&self, note: &str, message: &str) {
        if let Some(id) = note.strip_prefix("econ:ev:") {
            if let Some(e) = memory().events.get_mut(id) { e.message = Some(message.to_string()); }
        }
    }
}

/// What has come due in every server: coin events whose time ran out, shop roles that ran out, lottery draws,
/// and the ledger trimmed to 30 days. Gives (server, action).
pub fn due(db: &Db, settings: &Settings, dir: &Directory, now: i64, roll: &mut dyn FnMut(i64, i64) -> i64, on: &dyn Fn(&str) -> bool) -> Vec<(String, Action)> {
    let mut out = Vec::new();
    let finished: Vec<LiveEvent> = {
        let mut m = memory();
        let ids: Vec<String> = m.events.iter().filter(|(_, e)| e.ends <= now).map(|(k, _)| k.clone()).collect();
        ids.into_iter().filter_map(|k| m.events.remove(&k)).collect()
    };
    for e in finished {
        let econ = Economy { db, settings, dir, guild: &e.guild, server: "" };
        let text = if e.kind == "split" {
            for (u, part) in e.takers.iter().zip(shares(e.prize, e.takers.len())) { econ.wallet_of(u); econ.credit(u, part, "chat event"); }
            if e.takers.is_empty() { "Nobody took a share. It washed away...".to_string() } else { format!("{} shared {}: {}", plural(e.takers.len() as i64, "person", "people"), econ.money(e.prize), e.takers.iter().map(|u| format!("<@{u}>")).collect::<Vec<_>>().join(", ")) }
        } else {
            "Nobody grabbed it in time. It's gone!".to_string()
        };
        if let Some(message) = e.message { out.push((e.guild.clone(), Action::Edit { channel: e.channel, message, card: Card::new(Area::Money).title(e.title).line(text) })); }
    }
    // shop roles bought for some hours
    // read first, then let go of the database: the loop takes it again
    let roles = db.get().data_everywhere(MODULE, "shoprole:").unwrap_or_default();
    for (guild, key, until) in roles {
        if until.as_i64().unwrap_or(i64::MAX) > now || !on(&guild) { continue; }
        let _ = db.get().data_delete(&guild, MODULE, &key);
        let mut p = key.splitn(3, ':').skip(1);
        let (user, role) = (p.next().unwrap_or("").to_string(), p.next().unwrap_or("").to_string());
        out.push((guild, Action::Roles { user, add: Vec::new(), remove: vec![role], reason: "Shop role ran out".into() }));
    }
    // the weekly lottery: every finished week is drawn once (one ticket, one chance) and the winner gets the pool
    let this_week = week_of(now);
    let guilds = db.get().economy_guilds().unwrap_or_default();
    for guild in guilds.into_iter().filter(|g| on(g)) {
        let weeks = db.get().lottery_undrawn(&guild, &this_week).unwrap_or_default();
        for (week, rows) in weeks {
            let total: i64 = rows.iter().map(|r| r.1).sum();
            let pool: i64 = rows.iter().map(|r| r.2).sum();
            let mut pick = roll(0, (total - 1).max(0));
            let mut winner = rows.first().map(|r| r.0.clone());
            for (u, count, _) in &rows { if pick < *count { winner = Some(u.clone()); break; } pick -= count; }
            let _ = db.get().lottery_drawn(&guild, &week);
            let Some(w) = winner.filter(|_| pool > 0) else { continue };
            let econ = Economy { db, settings, dir, guild: &guild, server: "" };
            econ.credit(&w, pool, &format!("lottery win ({week})"));
            econ.data().set("lottery:last", &json!({ "week": week, "winner": w, "pool": pool, "tickets": total, "at": now }));
            let people = plural(rows.len() as i64, "person", "people");
            out.push((guild.clone(), Action::Dm { user: w.clone(), card: Card::new(Area::Money).line(format!("🎟️ You won the **{}** lottery! {} is in your wallet ({total} tickets from {people}).", short(&dir_name(db, &guild), 60), econ.money(pool))), or_in: None }));
            if let Some(ch) = settings.text(&guild, MODULE, "lotteryChannel") {
                out.push((guild.clone(), Action::Send { channel: ch, card: Card::new(Area::Money).line(format!("🎟️ <@{w}> won this week's lottery: {} from {total} tickets! Buy a ticket in `/shop` for next week's.", econ.money(pool))), ping: Vec::new(), roles: Vec::new() }));
            }
        }
    }
    let prune = { let mut m = memory(); if now - m.pruned >= 6 * HOUR { m.pruned = now; true } else { false } };
    if prune { let _ = db.get().ledger_prune(now - LEDGER_DAYS * DAY); }
    out
}
fn dir_name(db: &Db, guild: &str) -> String {
    db.get().guilds().unwrap_or_default().into_iter().find(|g| g.id == guild).map(|g| g.name).filter(|n| !n.is_empty()).unwrap_or_else(|| "server".into())
}
