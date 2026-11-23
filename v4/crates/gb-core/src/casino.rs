//! Games: a new slot machine and a new blackjack table (fishing stays exactly as Good Boy 3 has it), and coin flip.
//! Coins are the economy's play money; nothing here can be bought with real money. The house keeps a small edge on
//! purpose: it is the economy's main coin sink.
//!
//! Slots: a 3 by 3 window, the middle line pays; a wild card fills in for anything; a progressive jackpot grows with
//! every spin; a hot streak adds a little to each win in a row; Auto x5 spins five times.
//! Blackjack: hit, stand, double, split, insurance and surrender, four decks, dealer stands on every 17.
//! The result of a spin or a card is decided and paid before anything is shown, so a restart changes nothing.

use crate::bot::{CommandSpec, Opt, Takes};
use crate::card::group;
use crate::money::parse_amount;
use crate::settings::{Def, Fallback, Kind};
use crate::store::Data;
use crate::{Action, Area, ButtonEvent, ButtonStyle, Card, CommandEvent, Db, Member, Settings};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const MODULE: &str = "games";
pub static SETTINGS: &[Def] = &[
    Def { key: "slotsEnabled", label: "Slots", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "blackjackEnabled", label: "Blackjack", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "coinflipEnabled", label: "Coin flip", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "towerEnabled", label: "Treasure Climb (tower)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "wiresEnabled", label: "Bomb Squad (wires)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "bingoEnabled", label: "Bingo", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "memoryEnabled", label: "Memory", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "hangmanEnabled", label: "Balloon Rescue (hangman)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "triviaEnabled", label: "Trivia", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "pongEnabled", label: "Paddle Duel (pong)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "fishingEnabled", label: "Fishing", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "fishChallenges", label: "Fishing challenges (3 daily and 1 weekly, with coin and XP rewards)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "announceBigWins", label: "Announce big wins publicly (no pings, at most one per member every 10 minutes)", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "bigWinLevel", label: "Which wins are announced (jackpots, mythical, rare)", kind: Kind::Select(&["jackpots", "mythical", "rare"]), default: Fallback::Str("mythical") },
    Def { key: "bigWinChannel", label: "Channel for big-win announcements (empty = where they played)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "minBet", label: "Smallest bet", kind: Kind::Number { min: 1, max: 1_000_000 }, default: Fallback::Int(10) },
    Def { key: "maxBet", label: "Biggest bet", kind: Kind::Number { min: 1, max: 100_000_000 }, default: Fallback::Int(50_000) },
    Def { key: "gamePictures", label: "Pictures for the games (text otherwise)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "gameAnimations", label: "Animate the pictures (spinning reels, cards being dealt, balloons popping, balls dropping)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "privateGames", label: "Only the player sees their game (keeps the channel quiet)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "jackpotSeed", label: "Jackpot pool starts at", kind: Kind::Number { min: 0, max: 100_000_000 }, default: Fallback::Int(5000) },
    Def { key: "jackpotPercent", label: "Share of each slots bet added to the jackpot (%)", kind: Kind::Number { min: 0, max: 20 }, default: Fallback::Int(3) },
];
const BET: Opt = Opt { name: "bet", about: "How many coins (500, 2.5k, half, all)", takes: Takes::Text, required: true };
pub const COMMANDS: &[CommandSpec] = &[
    CommandSpec { name: "slots", about: "Spin the slot machine", module: MODULE, options: &[BET], subs: &[] },
    CommandSpec { name: "blackjack", about: "Play a hand of blackjack", module: MODULE, options: &[BET], subs: &[] },
    CommandSpec { name: "coinflip", about: "Bet on a coin flip", module: MODULE, options: &[BET, Opt { name: "side", about: "Heads or tails", takes: Takes::Choice(&[("heads", "heads"), ("tails", "tails")]), required: true }], subs: &[] },
];
const SESSION_MS: i64 = 10 * 60_000;

/// Which kinds of win each announcement level covers (Good Boy 3's).
fn shout_kinds(level: &str) -> &'static [&'static str] {
    match level {
        "jackpots" => &["jackpot"],
        "rare" => &["jackpot", "mythical", "legendary", "mutated", "bigwin"],
        _ => &["jackpot", "mythical"],
    }
}
/// A big win or a rare catch, said out loud in the channel (no pings). Off unless the server turns it on; a member is
/// announced at most once every ten minutes, except for a jackpot.
pub(crate) fn shout(db: &Db, settings: &Settings, guild: &str, who: (&str, &str), text: String, kind: &str, now: i64) -> Option<Action> {
    // who: (the member, the channel they played in)
    let (user, played_in) = who;
    if !settings.bool(guild, MODULE, "announceBigWins") { return None; }
    let level = settings.text(guild, MODULE, "bigWinLevel").unwrap_or_else(|| "mythical".into());
    if !shout_kinds(&level).contains(&kind) { return None; }
    let data = Data { db, guild, module: MODULE };
    let key = format!("shout:{user}");
    let last = data.get(&key).and_then(|v| v.as_i64()).unwrap_or(0);
    if kind != "jackpot" && now - last <= SESSION_MS { return None; }
    data.set(&key, &json!(now));
    let channel = settings.text(guild, MODULE, "bigWinChannel").filter(|c| !c.is_empty()).unwrap_or_else(|| played_in.to_string());
    Some(Action::Send { channel, card: Card::new(Area::Games).line(text), ping: Vec::new(), roles: Vec::new() })
}

// ------------------------------------------------------------------ the slot machine's rules
/// (id, picture, stops on a reel). A reel has 33 stops in all.
pub const SYMBOLS: &[(&str, &str, u32)] = &[("cherry", "🍒", 10), ("lemon", "🍋", 8), ("grape", "🍇", 6), ("bell", "🔔", 4), ("star", "⭐", 2), ("diamond", "💎", 1), ("seven", "7️⃣", 1), ("wild", "🃏", 1)];
const STOPS: u32 = 33;
/// Three of a kind pays the bet times this (wild cards fill in). Three wilds pay `WILD_TRIPLE`.
pub fn triple(id: &str) -> f64 {
    match id { "cherry" => 4.0, "lemon" => 7.0, "grape" => 12.0, "bell" => 28.0, "star" => 70.0, "diamond" => 180.0, "seven" => 400.0, _ => 0.0 }
}
pub const WILD_TRIPLE: f64 = 200.0;
const TWO_CHERRIES: f64 = 1.0;
const PAIR: f64 = 0.2;
pub fn picture(id: &str) -> &'static str {
    SYMBOLS.iter().find(|s| s.0 == id).map(|s| s.1).unwrap_or("❔")
}
/// One reel stop from a number below 33.
pub fn reel_stop(mut r: u32) -> &'static str {
    for (id, _, w) in SYMBOLS {
        if r < *w { return id; }
        r -= w;
    }
    SYMBOLS[0].0
}
/// What the middle line pays, as times the bet (jackpot pool not counted).
pub fn multiplier(line: &[&str; 3]) -> f64 {
    let real: Vec<&str> = line.iter().copied().filter(|x| *x != "wild").collect();
    if real.is_empty() { return WILD_TRIPLE; }
    if real.iter().all(|x| *x == real[0]) { return triple(real[0]); }
    let cherries = line.iter().filter(|x| **x == "cherry" || **x == "wild").count();
    if line.contains(&"cherry") && cherries >= 2 { return TWO_CHERRIES; }
    let mut pair = line.contains(&"wild");
    for a in 0..3 { for b in a + 1..3 { if line[a] == line[b] { pair = true; } } }
    if pair { PAIR } else { 0.0 }
}
/// Three sevens (a wild may stand in): the progressive jackpot.
pub fn is_jackpot(line: &[&str; 3]) -> bool {
    line.iter().filter(|x| **x == "seven").count() >= 2 && line.iter().all(|x| *x == "seven" || *x == "wild") || line.iter().all(|x| *x == "seven")
}
/// The exact return of the table above, jackpot pool and streak bonus not counted.
pub fn return_to_player() -> f64 {
    let mut ev = 0.0;
    for a in SYMBOLS { for b in SYMBOLS { for c in SYMBOLS {
        let p = (a.2 * b.2 * c.2) as f64 / (STOPS as f64).powi(3);
        ev += p * multiplier(&[a.0, b.0, c.0]);
    } } }
    ev
}
pub const MAX_STREAK_BONUS: i64 = 20;

pub struct Spin {
    /// The 3 by 3 window, reel by reel: [top, middle, bottom].
    pub window: [[&'static str; 3]; 3],
    pub multiplier: f64,
    pub jackpot: bool,
}
pub fn spin(rng: &mut dyn FnMut(u32) -> u32) -> Spin {
    let mut window = [[""; 3]; 3];
    for reel in window.iter_mut() { for cell in reel.iter_mut() { *cell = reel_stop(rng(STOPS)); } }
    let line = [window[0][1], window[1][1], window[2][1]];
    Spin { window, multiplier: multiplier(&line), jackpot: is_jackpot(&line) }
}

// ------------------------------------------------------------------ blackjack's rules
const SUITS: [&str; 4] = ["♠", "♥", "♦", "♣"];
const RANKS: [&str; 13] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const DECKS: usize = 4;

pub fn shoe(rng: &mut dyn FnMut(u32) -> u32) -> Vec<String> {
    let mut d: Vec<String> = Vec::with_capacity(52 * DECKS);
    for _ in 0..DECKS { for s in SUITS { for r in RANKS { d.push(format!("{r}{s}")); } } }
    for k in (1..d.len()).rev() { let j = rng(k as u32 + 1) as usize; d.swap(k, j); }
    d
}
fn rank(card: &str) -> &str {
    card.trim_end_matches(['♠', '♥', '♦', '♣'])
}
fn points(card: &str) -> u32 {
    match rank(card) { "A" => 11, "J" | "Q" | "K" => 10, r => r.parse().unwrap_or(0) }
}
/// Best total of a hand, and whether an ace still counts as 11.
pub fn value(cards: &[String]) -> (u32, bool) {
    let mut total: u32 = cards.iter().map(|c| points(c)).sum();
    let mut aces = cards.iter().filter(|c| rank(c) == "A").count();
    while total > 21 && aces > 0 { total -= 10; aces -= 1; }
    (total, aces > 0)
}
pub fn is_natural(cards: &[String]) -> bool {
    cards.len() == 2 && value(cards).0 == 21
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Hand {
    pub cards: Vec<String>,
    pub bet: i64,
    pub doubled: bool,
    pub done: bool,
    /// "win" "lose" "bust" "push" "blackjack" "surrender"
    pub result: Option<String>,
    pub payout: i64,
    pub split: bool,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Table {
    pub shoe: Vec<String>,
    pub hands: Vec<Hand>,
    pub active: usize,
    pub dealer: Vec<String>,
    /// Insurance staked (0 = none), and whether it is still being offered.
    pub insurance: i64,
    pub offering: bool,
    pub insurance_payout: i64,
    pub moved: bool,
    pub done: bool,
    pub bet: i64,
    pub at: i64,
}
impl Table {
    pub fn hand(&self) -> &Hand {
        &self.hands[self.active.min(self.hands.len() - 1)]
    }
    pub fn can_double(&self) -> bool {
        !self.done && !self.offering && self.hand().cards.len() == 2 && !self.hand().doubled
    }
    pub fn can_split(&self) -> bool {
        let h = self.hand();
        !self.done && !self.offering && self.hands.len() == 1 && h.cards.len() == 2 && points(&h.cards[0]) == points(&h.cards[1]) && !h.split
    }
    pub fn can_surrender(&self) -> bool {
        !self.done && !self.offering && !self.moved && self.hands.len() == 1 && self.hand().cards.len() == 2
    }
    fn draw(&mut self) -> String {
        self.shoe.pop().unwrap_or_else(|| "10♠".into())
    }
    /// Moves to the next hand that is still being played; when none is, the dealer plays and everything is settled.
    fn advance(&mut self) {
        while self.active < self.hands.len() && self.hands[self.active].done { self.active += 1; }
        if self.active >= self.hands.len() {
            self.active = self.hands.len() - 1;
            self.finish();
        }
    }
    fn finish(&mut self) {
        let live = self.hands.iter().any(|h| !matches!(h.result.as_deref(), Some("bust") | Some("surrender")) && !(is_natural(&h.cards) && !h.split));
        if live { while value(&self.dealer).0 < 17 { let c = self.draw(); self.dealer.push(c); } }
        self.settle();
    }
    fn settle(&mut self) {
        let d = value(&self.dealer).0;
        let dealer_natural = is_natural(&self.dealer);
        for h in self.hands.iter_mut() {
            let p = value(&h.cards).0;
            let natural = is_natural(&h.cards) && !h.split;
            let (result, payout) = if h.result.as_deref() == Some("surrender") { ("surrender", h.bet / 2) }
                else if p > 21 { ("bust", 0) }
                else if natural && dealer_natural { ("push", h.bet) }
                else if natural { ("blackjack", h.bet * 5 / 2) }
                else if dealer_natural { ("lose", 0) }
                else if d > 21 || p > d { ("win", h.bet * 2) }
                else if p < d { ("lose", 0) }
                else { ("push", h.bet) };
            h.result = Some(result.into());
            h.payout = payout;
            h.done = true;
        }
        if self.insurance > 0 && dealer_natural { self.insurance_payout = self.insurance * 3; }
        self.done = true;
        self.offering = false;
    }
    pub fn total_paid(&self) -> i64 {
        self.hands.iter().map(|h| h.payout).sum::<i64>() + self.insurance_payout
    }
    pub fn total_staked(&self) -> i64 {
        self.hands.iter().map(|h| h.bet).sum::<i64>() + self.insurance
    }
}
/// A new round: two cards each. Naturals are settled at once (after an insurance offer when the dealer shows an ace).
pub fn deal(bet: i64, at: i64, rng: &mut dyn FnMut(u32) -> u32) -> Table {
    let mut t = Table { shoe: shoe(rng), bet, at, ..Default::default() };
    let (a, b, c, d) = (t.draw(), t.draw(), t.draw(), t.draw());
    t.hands = vec![Hand { cards: vec![a, c], bet, ..Default::default() }];
    t.dealer = vec![b, d];
    if rank(&t.dealer[0]) == "A" { t.offering = true; return t; }
    peek(&mut t);
    t
}
/// The dealer looks at a hidden ten or ace: a natural ends the round, and so does the player's own.
fn peek(t: &mut Table) {
    if is_natural(&t.dealer) || is_natural(&t.hands[0].cards) { t.settle(); }
}
pub fn insure(t: &mut Table, take: bool) {
    if !t.offering { return; }
    t.offering = false;
    if take { t.insurance = t.bet / 2; }
    peek(t);
}
pub fn hit(t: &mut Table) {
    if t.done || t.offering { return; }
    t.moved = true;
    let c = t.draw();
    let i = t.active;
    t.hands[i].cards.push(c);
    let v = value(&t.hands[i].cards).0;
    if v > 21 { t.hands[i].done = true; t.hands[i].result = Some("bust".into()); t.advance(); }
    else if v == 21 { t.hands[i].done = true; t.advance(); }
}
pub fn stand(t: &mut Table) {
    if t.done || t.offering { return; }
    t.moved = true;
    let i = t.active;
    t.hands[i].done = true;
    t.advance();
}
/// Doubling: the caller has taken the extra stake. One card, then the hand stands.
pub fn double(t: &mut Table) {
    if !t.can_double() { return; }
    t.moved = true;
    let i = t.active;
    t.hands[i].bet *= 2;
    t.hands[i].doubled = true;
    let c = t.draw();
    t.hands[i].cards.push(c);
    t.hands[i].done = true;
    if value(&t.hands[i].cards).0 > 21 { t.hands[i].result = Some("bust".into()); }
    t.advance();
}
/// Splitting a pair: the caller has taken the second stake. Each hand gets a card; split aces get just that one.
pub fn split(t: &mut Table) {
    if !t.can_split() { return; }
    t.moved = true;
    let second = t.hands[0].cards.pop().unwrap_or_default();
    let bet = t.hands[0].bet;
    let aces = rank(&t.hands[0].cards[0]) == "A";
    let (x, y) = (t.draw(), t.draw());
    t.hands[0].cards.push(x);
    t.hands[0].split = true;
    t.hands.push(Hand { cards: vec![second, y], bet, split: true, ..Default::default() });
    if aces { for h in t.hands.iter_mut() { h.done = true; } }
    t.advance();
}
pub fn surrender(t: &mut Table) {
    if !t.can_surrender() { return; }
    t.hands[0].done = true;
    t.hands[0].result = Some("surrender".into());
    t.advance();
}

// ------------------------------------------------------------------ the module
pub(crate) fn private(text: impl Into<String>) -> Vec<Action> {
    vec![Action::Reply { card: Card::new(Area::Games).line(text).private() }]
}
fn cards_text(cards: &[String], hide_second: bool) -> String {
    cards.iter().enumerate().map(|(k, c)| if hide_second && k == 1 { "🂠".to_string() } else { format!("`{c}`") }).collect::<Vec<_>>().join(" ")
}
const RESULT_TEXT: &[(&str, &str)] = &[("win", "You win"), ("blackjack", "Blackjack! Pays 3 to 2"), ("lose", "Dealer wins"), ("bust", "Bust, over 21"), ("push", "Push, your bet is back"), ("surrender", "You gave up: half back")];

pub struct Games<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub guild: &'a str,
}
impl Games<'_> {
    pub(crate) fn data(&self) -> Data<'_> {
        Data { db: self.db, guild: self.guild, module: MODULE }
    }
    pub(crate) fn int(&self, k: &str) -> i64 {
        self.settings.int(self.guild, MODULE, k)
    }
    pub(crate) fn on(&self, game: &str) -> bool {
        self.settings.bool(self.guild, MODULE, &format!("{game}Enabled"))
    }
    pub(crate) fn coins(&self, n: i64) -> String {
        format!("**{}** {}", group(n), self.settings.text(self.guild, crate::money::MODULE, "currencyEmoji").unwrap_or_else(|| "🪙".into()))
    }
    pub(crate) fn wallet(&self, who: &Member) -> i64 {
        let start = self.settings.int(self.guild, crate::money::MODULE, "startingCoins");
        self.db.get().wallet(self.guild, &who.id, Some(&who.name).filter(|n| !n.is_empty()).map(|n| n.as_str()), start).map(|w| w.coins).unwrap_or(0)
    }
    pub(crate) fn take(&self, who: &Member, amount: i64, reason: &str) -> Result<i64, String> {
        self.wallet(who);
        let done = self.db.get().debit(self.guild, &who.id, amount, reason);
        match done {
            Ok(Ok(left)) => Ok(left - amount),
            Ok(Err(gb_data::economy::Short::Only(have))) => Err(format!("You only have {}.", self.coins(have))),
            Err(e) => Err(format!("The wallet could not be changed just now ({e}).")),
        }
    }
    pub(crate) fn give(&self, who: &str, amount: i64, reason: &str) -> i64 {
        self.db.get().credit(self.guild, who, amount, reason).unwrap_or(0)
    }
    pub(crate) fn balance(&self, who: &Member) -> i64 {
        self.wallet(who)
    }
    pub(crate) fn pictures(&self) -> bool {
        self.settings.bool(self.guild, MODULE, "gamePictures")
    }
    pub(crate) fn animated(&self) -> bool {
        self.settings.bool(self.guild, MODULE, "gameAnimations")
    }
    pub(crate) fn quiet(&self, card: Card) -> Card {
        if self.settings.bool(self.guild, MODULE, "privateGames") { card.private() } else { card }
    }
    /// Checks the money module is on and reads a bet.
    pub(crate) fn bet(&self, who: &Member, raw: &str) -> Result<i64, String> {
        let have = self.wallet(who);
        let min = self.int("minBet");
        parse_amount(raw, Some(have), min, self.int("maxBet").min(have.max(min)))
    }
    pub(crate) fn record(&self, user: &str, game: &str, wagered: i64, returned: i64) {
        let _ = self.db.get().game_record(self.guild, user, game, wagered, returned);
        // a tax on winnings comes off the profit (never the stake), after the game, and goes to the server treasury
        let tax = crate::money::tax_of(returned - wagered, self.settings.int(self.guild, crate::money::MODULE, "taxWinnings"));
        if tax > 0 {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            let _ = self.db.get().skim(self.guild, user, tax, "tax:winnings", now);
        }
    }

    // ---- slots
    pub(crate) fn pool(&self) -> i64 {
        self.data().get("pool").and_then(|v| v.as_i64()).unwrap_or_else(|| self.int("jackpotSeed"))
    }
    fn streak_of(&self, user: &str) -> i64 {
        self.data().get(&format!("streak:{user}")).and_then(|v| v.as_i64()).unwrap_or(0)
    }
    /// One paid spin: the bet is taken, the jackpot grows, the spin is decided, winnings are paid.
    fn spin_once(&self, who: &Member, bet: i64, rng: &mut dyn FnMut(u32) -> u32) -> Result<SlotResult, String> {
        self.take(who, bet, "slots bet")?;
        let cut = bet * self.int("jackpotPercent") / 100;
        let pool = self.pool() + cut;
        let s = spin(rng);
        let streak = self.streak_of(&who.id);
        let base = (bet as f64 * s.multiplier).floor() as i64;
        let (won_pool, pool_after) = if s.jackpot { (pool, self.int("jackpotSeed")) } else { (0, pool) };
        let bonus_pct = if base > 0 { (streak * 5).min(MAX_STREAK_BONUS) } else { 0 };
        let bonus = base * bonus_pct / 100;
        let payout = base + bonus + won_pool;
        self.data().set("pool", &json!(pool_after));
        let streak = if payout > bet { streak + 1 } else { 0 };
        self.data().set(&format!("streak:{}", who.id), &json!(streak));
        if payout > 0 { self.give(&who.id, payout, if s.jackpot { "slots JACKPOT" } else { "slots win" }); }
        self.record(&who.id, "slots", bet, payout);
        Ok(SlotResult { window: s.window, multiplier: s.multiplier, jackpot: s.jackpot, bet, payout, bonus_pct, streak, pool: pool_after, balance: self.balance(who) })
    }
    fn slots_card(&self, r: &SlotResult, who: &Member, note: Option<String>) -> Card {
        let row = |k: usize| format!("┃ {} ┃ {} ┃ {} ┃", picture(r.window[0][k]), picture(r.window[1][k]), picture(r.window[2][k]));
        let board = format!("{}\n▶ {} ◀\n{}", row(0), row(1), row(2));
        let net = r.payout - r.bet;
        let line = if r.jackpot { format!("💥 **JACKPOT!** You won {}!", self.coins(r.payout)) }
            else if r.payout >= r.bet * 5 { format!("🎉 **Big win!** {}x · you won {}", r.multiplier, self.coins(r.payout)) }
            else if r.payout > r.bet { format!("🪙 You won {} ({}x)", self.coins(r.payout), r.multiplier) }
            else if r.payout > 0 { format!("😮 Close! {} back", self.coins(r.payout)) }
            else { "No luck this time.".to_string() };
        let banner = if r.jackpot { format!("JACKPOT! +{}", group(net)) } else if r.payout >= r.bet * 5 { format!("Big win! {}x · +{}", r.multiplier, group(net)) } else if r.payout > r.bet { format!("{}x · +{}", r.multiplier, group(net)) } else if r.payout > 0 { format!("Close! {} back", group(r.payout)) } else { "No luck this time".to_string() };
        let moving = self.animated();
        let picture = self.pictures().then(|| if moving { gb_art::games::slots_spin(&r.window, &banner, net > 0) } else { gb_art::games::slots(&r.window, &banner, net > 0) }).flatten();
        let mut card = Card::new(Area::Games).title(format!("🎰 Slots · {}", group(r.bet)));
        card = match picture { Some(pic) => card.file(&format!("slots-{}-{}.{}", r.balance, r.pool, if moving { "gif" } else { "png" }), pic), None => card.line(board) };
        card = card.line(line);
        if r.bonus_pct > 0 { card = card.line(format!("🔥 Hot streak: +{}% on this win", r.bonus_pct)); }
        else if r.streak > 0 { card = card.line(format!("🔥 {} win{} in a row: the next win pays more", r.streak, if r.streak == 1 { "" } else { "s" })); }
        if let Some(n) = note { card = card.line(n); }
        card = card.line(format!("Wallet {} · jackpot pool {}{}", self.coins(r.balance), self.coins(r.pool), if net != 0 { format!(" · {}{}", if net > 0 { "+" } else { "" }, group(net)) } else { String::new() }));
        card.accent = Some(if net > 0 { 0xffb12e } else { 0xed4245 });
        let id = |what: &str, bet: i64| format!("sl:{what}:{}:{bet}", who.id);
        card.button(id("again", r.bet), format!("Spin again ({})", group(r.bet)), ButtonStyle::Good)
            .button(id("auto", r.bet), "Auto ×5", ButtonStyle::Primary)
            .button(id("double", r.bet * 2), "Bet ×2", ButtonStyle::Plain)
            .button(id("half", (r.bet / 2).max(1)), "Bet ½", ButtonStyle::Plain)
    }
    pub(crate) fn slots(&self, who: &Member, raw: &str, rng: &mut dyn FnMut(u32) -> u32, auto: bool, place: &str, now: i64) -> Vec<Action> {
        if !self.on("slots") { return private("Slots are turned off in this server."); }
        let bet = match self.bet(who, raw) { Ok(b) => b, Err(e) => return private(e) };
        let spins = if auto { 5 } else { 1 };
        let mut last = None;
        let (mut spent, mut got) = (0, 0);
        for _ in 0..spins {
            match self.spin_once(who, bet, rng) {
                Ok(r) => { spent += bet; got += r.payout; last = Some(r); }
                Err(e) => { if last.is_none() { return private(e); } break; }
            }
        }
        let Some(r) = last else { return private("Nothing was spun.") };
        let note = (auto && spent > bet).then(|| format!("Auto spins: {} spins · bet {} · won back {} · {}{}", spent / bet, self.coins(spent), self.coins(got), if got >= spent { "+" } else { "-" }, group((got - spent).abs())));
        let mut out = vec![Action::Reply { card: self.quiet(self.slots_card(&r, who, note)) }];
        let name = who.name.replace(['*', '_', '`', '~', '|', '>', '@'], "");
        let said = if r.jackpot { Some((format!("💥 **{name}** hit the slots **JACKPOT** and won {}!", self.coins(r.payout)), "jackpot")) }
            else if r.payout >= r.bet * 20 { Some((format!("🎰 **{name}** won **{}x** on slots ({})!", r.multiplier, self.coins(r.payout)), "bigwin")) } else { None };
        if let Some((text, kind)) = said { out.extend(shout(self.db, self.settings, self.guild, (&who.id, place), text, kind, now)); }
        out
    }

    // ---- coin flip
    pub(crate) fn coinflip(&self, who: &Member, raw: &str, side: &str, rng: &mut dyn FnMut(u32) -> u32) -> Vec<Action> {
        if !self.on("coinflip") { return private("Coin flip is turned off in this server."); }
        let bet = match self.bet(who, raw) { Ok(b) => b, Err(e) => return private(e) };
        let side = if side == "tails" { "tails" } else { "heads" };
        if let Err(e) = self.take(who, bet, "coin flip bet") { return private(e); }
        let landed = if rng(2) == 0 { "heads" } else { "tails" };
        let payout = if landed == side { bet * 195 / 100 } else { 0 };
        if payout > 0 { self.give(&who.id, payout, "coin flip win"); }
        self.record(&who.id, "coinflip", bet, payout);
        let won = payout > 0;
        let moving = self.animated();
        let draw = if moving { gb_art::games::coin_flip } else { gb_art::games::coin };
        let picture = self.pictures().then(|| draw(landed == "heads", won, &if won { format!("{}! +{}", if landed == "heads" { "Heads" } else { "Tails" }, group(payout - bet)) } else { format!("{}. -{}", if landed == "heads" { "Heads" } else { "Tails" }, group(bet)) })).flatten();
        let mut card = Card::new(Area::Games).title("🪙 Coin flip");
        card = match picture {
            Some(pic) => card.file(&format!("coin-{}.{}", self.balance(who), if moving { "gif" } else { "png" }), pic).line(format!("You called **{side}** for {}.", self.coins(bet))),
            None => card.line(format!("You called **{side}** for {}.\n# {} {}", self.coins(bet), if won { "🎉" } else { "😕" }, if landed == "heads" { "Heads" } else { "Tails" })),
        };
        card = card
            .line(if won { format!("You won {}", self.coins(payout)) } else { format!("You lost {}", self.coins(bet)) })
            .line(format!("Wallet {}", self.coins(self.balance(who))))
            .button(format!("cf:{side}:{}:{bet}", who.id), format!("Again ({})", group(bet)), ButtonStyle::Good)
            .button(format!("cf:{}:{}:{bet}", if side == "heads" { "tails" } else { "heads" }, who.id), format!("Switch to {}", if side == "heads" { "tails" } else { "heads" }), ButtonStyle::Plain);
        card.accent = Some(if won { 0xffb12e } else { 0xed4245 });
        vec![Action::Reply { card: self.quiet(card) }]
    }

    // ---- blackjack
    fn table_key(user: &str) -> String {
        format!("bj:{user}")
    }
    fn load(&self, user: &str) -> Option<Table> {
        self.data().get(&Self::table_key(user)).and_then(|v| serde_json::from_value(v).ok())
    }
    fn save(&self, user: &str, t: &Table) {
        self.data().set(&Self::table_key(user), &serde_json::to_value(t).unwrap_or(Value::Null));
    }
    /// A finished table is paid and put away. Returns what it paid.
    fn close(&self, who: &str, t: &Table) -> i64 {
        let paid = t.total_paid();
        if paid > 0 { self.give(who, paid, "blackjack"); }
        self.record(who, "blackjack", t.total_staked(), paid);
        self.data().delete(&Self::table_key(who));
        paid
    }
    /// `film`: Some(true) plays the deal, Some(false) plays the dealer turning their cards over, None is a still.
    fn table_card(&self, who: &Member, t: &Table, film: Option<bool>) -> Card {
        let (dv, _) = value(&t.dealer);
        let hide = !t.done;
        let mut card = Card::new(Area::Games).title("🃏 Blackjack");
        let mut lines = Vec::new();
        for (k, h) in t.hands.iter().enumerate() {
            let (v, soft) = value(&h.cards);
            let mark = if t.hands.len() > 1 && k == t.active && !t.done { "▶ " } else { "" };
            let name = if t.hands.len() > 1 { format!("Hand {}", k + 1) } else { "Your hand".to_string() };
            let mut l = format!("{mark}**{name}** · {v}{} · bet {}{}\n{}", if soft && v < 21 { " soft" } else { "" }, group(h.bet), if h.doubled { " (doubled)" } else { "" }, cards_text(&h.cards, false));
            if t.done {
                if let Some(r) = &h.result {
                    let net = h.payout - h.bet;
                    l += &format!("\n→ {}{}", RESULT_TEXT.iter().find(|(k, _)| k == r).map(|(_, t)| *t).unwrap_or("Done"), if net != 0 { format!(" · {}{}", if net > 0 { "+" } else { "" }, group(net)) } else { String::new() });
                }
            }
            lines.push(l);
        }
        // the table as a picture (the text version when pictures are off or can't be drawn)
        let picture = self.pictures().then(|| {
            let hands: Vec<gb_art::games::TableHand> = t.hands.iter().enumerate().map(|(k, h)| {
                let (v, soft) = value(&h.cards);
                let name = if t.hands.len() > 1 { format!("Hand {}", k + 1) } else { "Your hand".to_string() };
                let result = if t.done { h.result.as_ref().map(|r| { let net = h.payout - h.bet; format!("{}{}", RESULT_TEXT.iter().find(|(k, _)| k == r).map(|(_, t)| *t).unwrap_or("Done"), if net != 0 { format!(" · {}{}", if net > 0 { "+" } else { "" }, group(net)) } else { String::new() }) }) } else { None };
                gb_art::games::TableHand { label: format!("{name} · {v}{}{}", if soft && v < 21 { " soft" } else { "" }, if h.doubled { " · doubled" } else { "" }), cards: &h.cards, result, active: k == t.active && !t.done }
            }).collect();
            let dealer_label = format!("Dealer · {}", if hide { points(&t.dealer[0]).to_string() } else { dv.to_string() });
            let footer = "Blackjack pays 3 to 2 · dealer stands on 17";
            match film.filter(|_| self.animated()) {
                Some(deal) => gb_art::games::blackjack_film(&dealer_label, &format!("Dealer · {}", points(&t.dealer[0])), &t.dealer, hide, &hands, footer, deal),
                None => gb_art::games::blackjack(&dealer_label, &t.dealer, hide, &hands, footer),
            }
        }).flatten();
        let ext = if film.is_some() && self.animated() { "gif" } else { "png" };
        card = match picture {
            Some(pic) => card.file(&format!("blackjack-{}-{}.{ext}", t.at, t.hands.iter().map(|h| h.cards.len()).sum::<usize>() + t.dealer.len() + usize::from(t.done)), pic).line(format!("Bet **{}**", group(t.total_staked() - t.insurance))),
            None => card.line(lines.join("\n\n")).line(format!("**Dealer** · {}\n{}", if hide { points(&t.dealer[0]).to_string() } else { dv.to_string() }, cards_text(&t.dealer, hide))),
        };
        if t.insurance > 0 { card = card.line(format!("🛡️ Insurance {}{}", group(t.insurance), if t.done { if t.insurance_payout > 0 { " · the dealer had blackjack: paid 2 to 1".to_string() } else { " · lost".to_string() } } else { String::new() })); }
        let id = |what: &str| format!("bj:{what}:{}", who.id);
        if t.done {
            let net = t.total_paid() - t.total_staked();
            card = card.line(format!("{} Wallet {}", if net > 0 { "🎉" } else if net == 0 { "🤝" } else { "😕" }, self.coins(self.balance(who))));
            card.accent = Some(if net > 0 { 0xffb12e } else if net == 0 { 0x95a5a6 } else { 0xed4245 });
            return card.button(format!("bj:again:{}:{}", who.id, t.bet), format!("Deal again ({})", group(t.bet)), ButtonStyle::Good).button(format!("bj:bethalf:{}:{}", who.id, (t.bet / 2).max(1)), "Bet ½", ButtonStyle::Plain).button(format!("bj:betdouble:{}:{}", who.id, t.bet * 2), "Bet ×2", ButtonStyle::Plain);
        }
        if t.offering {
            return card.line("The dealer shows an ace. Insurance costs half your bet and pays 2 to 1 if the dealer has blackjack.")
                .button(id("insure"), format!("Take insurance ({})", group(t.bet / 2)), ButtonStyle::Primary).button(id("noinsure"), "No thanks", ButtonStyle::Plain);
        }
        card.button(id("hit"), "Hit", ButtonStyle::Primary).button(id("stand"), "Stand", ButtonStyle::Good)
            .button_full(id("double"), "Double", ButtonStyle::Plain, Some("✖️".into()), !t.can_double())
            .button_full(id("split"), "Split", ButtonStyle::Plain, Some("✂️".into()), !t.can_split())
            .button_full(id("surrender"), "Surrender", ButtonStyle::Danger, Some("🏳️".into()), !t.can_surrender())
    }
    pub(crate) fn blackjack(&self, who: &Member, raw: &str, now: i64, rng: &mut dyn FnMut(u32) -> u32) -> Vec<Action> {
        if !self.on("blackjack") { return private("Blackjack is turned off in this server."); }
        if let Some(open) = self.load(&who.id).filter(|t| now - t.at < SESSION_MS) {
            return vec![Action::Reply { card: self.quiet(self.table_card(who, &open, None).line("-# You still had a hand open, so here it is. Finish it first.")) }];
        }
        let bet = match self.bet(who, raw) { Ok(b) => b, Err(e) => return private(e) };
        if let Err(e) = self.take(who, bet, "blackjack bet") { return private(e); }
        let t = deal(bet, now, rng);
        if t.done { self.close(&who.id, &t); } else { self.save(&who.id, &t); }
        vec![Action::Reply { card: self.quiet(self.table_card(who, &t, Some(true))) }]
    }
    fn blackjack_press(&self, who: &Member, what: &str, bet_arg: Option<i64>, now: i64, rng: &mut dyn FnMut(u32) -> u32) -> Vec<Action> {
        if matches!(what, "again" | "bethalf" | "betdouble") && bet_arg.is_some() {
            // "double" and "half" here change the next bet; the move buttons share the name "double", told apart by the bet
            return self.blackjack(who, &bet_arg.unwrap_or(0).to_string(), now, rng).into_iter().map(|a| match a { Action::Reply { card } => Action::Update { card }, o => o }).collect();
        }
        let Some(mut t) = self.load(&who.id) else { return private("That hand has finished. Start a new one with `/blackjack`.") };
        match what {
            "hit" => hit(&mut t),
            "stand" => stand(&mut t),
            "insure" | "noinsure" => {
                if t.offering && what == "insure" {
                    if let Err(e) = self.take(who, t.bet / 2, "blackjack insurance") { return private(e); }
                }
                insure(&mut t, what == "insure");
            }
            "double" => {
                if !t.can_double() { return private("You can only double on your first two cards."); }
                if let Err(e) = self.take(who, t.hand().bet, "blackjack double") { return private(e); }
                double(&mut t);
            }
            "split" => {
                if !t.can_split() { return private("You can only split a pair on your first move."); }
                if let Err(e) = self.take(who, t.hand().bet, "blackjack split") { return private(e); }
                split(&mut t);
            }
            "surrender" => {
                if !t.can_surrender() { return private("You can only give up before your first move."); }
                surrender(&mut t);
            }
            _ => return private("That button is from an older game."),
        }
        if t.done { self.close(&who.id, &t); } else { t.at = now; self.save(&who.id, &t); }
        // when the hand ends on this press, the dealer's cards are turned over one by one
        let film = (t.done && matches!(what, "stand" | "double" | "hit" | "noinsure" | "insure")).then_some(false);
        vec![Action::Update { card: self.table_card(who, &t, film) }]
    }

    // ---- commands and buttons
    pub fn command(&self, ev: &CommandEvent, rng: &mut dyn FnMut(u32) -> u32) -> Vec<Action> {
        let arg = |k: &str| ev.args.get(k).map(String::as_str).unwrap_or("");
        match ev.name.as_str() {
            "slots" => self.slots(&ev.member, arg("bet"), rng, false, &ev.place.channel, ev.at_ms),
            "blackjack" => self.blackjack(&ev.member, arg("bet"), ev.at_ms, rng),
            "coinflip" => self.coinflip(&ev.member, arg("bet"), arg("side"), rng),
            _ => Vec::new(),
        }
    }
    pub fn press(&self, ev: &ButtonEvent, rng: &mut dyn FnMut(u32) -> u32) -> Vec<Action> {
        let parts: Vec<&str> = ev.id.split(':').collect();
        let (kind, what, owner) = (parts.first().copied().unwrap_or(""), parts.get(1).copied().unwrap_or(""), parts.get(2).copied().unwrap_or(""));
        if owner != ev.member.id { return private("That's someone else's game. Start your own!"); }
        let bet: Option<i64> = parts.get(3).and_then(|b| b.parse().ok());
        let again = |out: Vec<Action>| -> Vec<Action> { out.into_iter().map(|a| match a { Action::Reply { card } => Action::Update { card }, o => o }).collect() };
        match kind {
            "sl" => again(self.slots(&ev.member, &bet.unwrap_or(0).to_string(), rng, what == "auto", &ev.place.channel, ev.at_ms)),
            "cf" => again(self.coinflip(&ev.member, &bet.unwrap_or(0).to_string(), what, rng)),
            _ => self.blackjack_press(&ev.member, what, bet, ev.at_ms, rng),
        }
    }
    /// Hands nobody finished: after ten minutes the player stands and the hand is paid.
    pub fn due(&self, now: i64, rng: &mut dyn FnMut(u32) -> u32) {
        let _ = rng;
        for (key, v) in self.data().list("bj:") {
            let Ok(mut t) = serde_json::from_value::<Table>(v) else { self.data().delete(&key); continue };
            if now - t.at < SESSION_MS { continue; }
            let user = key[3..].to_string();
            if t.offering { insure(&mut t, false); }
            while !t.done { stand(&mut t); }
            self.close(&user, &t);
        }
    }
}

pub struct SlotResult {
    pub window: [[&'static str; 3]; 3],
    pub multiplier: f64,
    pub jackpot: bool,
    pub bet: i64,
    pub payout: i64,
    pub bonus_pct: i64,
    pub streak: i64,
    pub pool: i64,
    pub balance: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cards(list: &[&str]) -> Vec<String> {
        list.iter().map(|c| c.to_string()).collect()
    }
    /// A rigged shoe: cards come off the end, so they are listed in reverse.
    fn rigged(order: &[&str]) -> Vec<String> {
        let mut v = cards(order);
        v.reverse();
        v
    }
    fn table(player: &[&str], dealer: &[&str], deck: &[&str]) -> Table {
        Table { shoe: rigged(deck), hands: vec![Hand { cards: cards(player), bet: 100, ..Default::default() }], dealer: cards(dealer), bet: 100, ..Default::default() }
    }
    #[test]
    fn the_slot_machine_is_fair_but_leaves_the_house_a_little() {
        let rtp = return_to_player();
        assert!((0.90..0.99).contains(&rtp), "{rtp}");
        assert_eq!(SYMBOLS.iter().map(|s| s.2).sum::<u32>(), STOPS);
        // a wild fills in, three wilds pay well, a lone pair gives a little back
        assert_eq!(multiplier(&["seven", "wild", "seven"]), 400.0);
        assert_eq!(multiplier(&["wild", "wild", "wild"]), WILD_TRIPLE);
        assert_eq!(multiplier(&["cherry", "wild", "lemon"]), 1.0);
        assert_eq!(multiplier(&["lemon", "lemon", "bell"]), 0.2);
        assert_eq!(multiplier(&["lemon", "bell", "grape"]), 0.0);
        assert!(is_jackpot(&["seven", "seven", "seven"]) && is_jackpot(&["seven", "wild", "seven"]) && !is_jackpot(&["seven", "seven", "bell"]));
    }
    #[test]
    fn blackjack_counts_aces_and_naturals() {
        assert_eq!(value(&cards(&["A♠", "K♥"])), (21, true));
        assert_eq!(value(&cards(&["A♠", "A♥", "9♦"])), (21, true));
        assert_eq!(value(&cards(&["K♠", "Q♥", "5♦"])), (25, false));
        assert!(is_natural(&cards(&["A♠", "10♥"])) && !is_natural(&cards(&["7♠", "7♥", "7♦"])));
    }
    #[test]
    fn hitting_standing_and_the_dealer_standing_on_seventeen() {
        let mut t = table(&["10♠", "6♥"], &["10♦", "7♣"], &["5♣"]);
        hit(&mut t); // 21: stands by itself, dealer has 17 and stays
        assert!(t.done && t.hands[0].result.as_deref() == Some("win") && t.hands[0].payout == 200, "{t:?}");
        let mut t = table(&["10♠", "6♥"], &["10♦", "6♣"], &["K♣", "3♦"]);
        hit(&mut t); // 26: bust, the dealer never draws
        assert_eq!(t.hands[0].result.as_deref(), Some("bust"));
        assert_eq!(t.dealer.len(), 2);
        let mut t = table(&["10♠", "9♥"], &["10♦", "6♣"], &["4♦"]);
        stand(&mut t); // dealer draws to 20, player 19 loses
        assert_eq!((t.hands[0].result.as_deref(), t.hands[0].payout), (Some("lose"), 0));
        let mut t = table(&["10♠", "9♥"], &["10♦", "9♣"], &[]);
        stand(&mut t);
        assert_eq!((t.hands[0].result.as_deref(), t.hands[0].payout), (Some("push"), 100));
    }
    #[test]
    fn double_split_insurance_and_surrender() {
        let mut t = table(&["5♠", "6♥"], &["10♦", "8♣"], &["10♣"]);
        assert!(t.can_double());
        double(&mut t); // 21 with double: pays 2 x 200
        assert_eq!((t.hands[0].bet, t.hands[0].payout), (200, 400));
        let mut t = table(&["8♠", "8♥"], &["10♦", "7♣"], &["3♦", "10♣", "10♥", "2♦"]);
        assert!(t.can_split());
        split(&mut t);
        assert_eq!(t.hands.len(), 2);
        assert!(!t.can_split());
        stand(&mut t);
        stand(&mut t);
        assert!(t.done);
        let mut aces = table(&["A♠", "A♥"], &["10♦", "7♣"], &["9♦", "9♣"]);
        split(&mut aces);
        assert!(aces.done && aces.hands.iter().all(|h| h.cards.len() == 2), "split aces get one card each");
        // insurance pays 2 to 1 when the dealer has blackjack
        let mut t = Table { shoe: Vec::new(), hands: vec![Hand { cards: cards(&["9♠", "9♥"]), bet: 100, ..Default::default() }], dealer: cards(&["A♦", "K♣"]), bet: 100, offering: true, ..Default::default() };
        insure(&mut t, true);
        assert!(t.done && t.insurance == 50 && t.insurance_payout == 150 && t.hands[0].result.as_deref() == Some("lose"));
        assert_eq!(t.total_paid() - t.total_staked(), 150 - 150, "insurance exactly covers the lost bet");
        let mut t = table(&["10♠", "6♥"], &["10♦", "7♣"], &[]);
        assert!(t.can_surrender());
        surrender(&mut t);
        assert_eq!((t.hands[0].result.as_deref(), t.hands[0].payout), (Some("surrender"), 50));
        // a natural pays 3 to 2, unless both have one
        let t = deal(100, 0, &mut |_| 0);
        assert!(t.hands[0].cards.len() == 2);
        let mut t = table(&["A♠", "K♥"], &["9♦", "7♣"], &[]);
        peek(&mut t);
        assert_eq!((t.hands[0].result.as_deref(), t.hands[0].payout), (Some("blackjack"), 250));
    }
}
