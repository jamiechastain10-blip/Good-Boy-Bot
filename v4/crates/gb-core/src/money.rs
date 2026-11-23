//! The economy's settings and plain rules (Good Boy 3's src/economy.js): the daily streak, amounts people type,
//! the jobs, and resetting the economy. The commands are in `economy.rs`.

use crate::card::group;
use crate::settings::{Def, Fallback, Kind};
use crate::{Action, Area, ButtonStyle, Card, Db, Member, Settings};

pub const MODULE: &str = "economy";

pub static SETTINGS: &[Def] = &[
    Def { key: "privateReplies", label: "Only the member sees /daily, /balance and /top (keeps the channel quiet)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "currencyName", label: "Currency name", kind: Kind::Text { max_len: 20 }, default: Fallback::Str("coins") },
    Def { key: "currencyEmoji", label: "Currency emoji", kind: Kind::Text { max_len: 64 }, default: Fallback::Str("🪙") },
    Def { key: "startingCoins", label: "Coins a new member starts with", kind: Kind::Number { min: 0, max: 1_000_000 }, default: Fallback::Int(500) },
    Def { key: "dailyBase", label: "Daily reward (before streak bonus)", kind: Kind::Number { min: 1, max: 1_000_000 }, default: Fallback::Int(250) },
    Def { key: "maxPay", label: "Most coins in one payment", kind: Kind::Number { min: 1, max: 1_000_000_000 }, default: Fallback::Int(1_000_000) },
    Def { key: "workMin", label: "/work pays at least", kind: Kind::Number { min: 0, max: 1_000_000 }, default: Fallback::Int(50) },
    Def { key: "workMax", label: "/work pays at most", kind: Kind::Number { min: 1, max: 1_000_000 }, default: Fallback::Int(200) },
    Def { key: "workCooldownMinutes", label: "Minutes between /work", kind: Kind::Number { min: 1, max: 1440 }, default: Fallback::Int(60) },
    Def { key: "bankInterest", label: "Bank interest per day (%)", kind: Kind::Number { min: 0, max: 10 }, default: Fallback::Int(1) },
    Def { key: "bankInterestCap", label: "Most interest one member earns per day (0 = no limit)", kind: Kind::Number { min: 0, max: 100_000_000 }, default: Fallback::Int(1000) },
    Def { key: "lotteryChannel", label: "Announce the weekly lottery winner here (optional)", kind: Kind::Channel, default: Fallback::None },
    Def { key: "robbing", label: "Members can /rob each other (coins in the bank are safe; padlocks protect)", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "robMax", label: "Most coins one robbery can take", kind: Kind::Number { min: 1, max: 100_000_000 }, default: Fallback::Int(50_000) },
    Def { key: "events", label: "Coin events now and then while people chat (grab a bag, share a chest)", kind: Kind::Toggle, default: Fallback::Bool(true) },
    Def { key: "eventEvery", label: "About how many messages between coin events", kind: Kind::Number { min: 20, max: 5000 }, default: Fallback::Int(150) },
    Def { key: "taxPay", label: "Tax on /pay (%): comes off what the receiver gets and goes to the server treasury", kind: Kind::Number { min: 0, max: 50 }, default: Fallback::Int(0) },
    Def { key: "taxIncome", label: "Tax on /daily and /work (%): goes to the server treasury", kind: Kind::Number { min: 0, max: 50 }, default: Fallback::Int(0) },
    Def { key: "taxWithdraw", label: "Fee for taking coins out of the bank (%): goes to the server treasury", kind: Kind::Number { min: 0, max: 50 }, default: Fallback::Int(0) },
    Def { key: "taxWinnings", label: "Tax on game winnings (%): taken from the profit after a game, goes to the server treasury", kind: Kind::Number { min: 0, max: 50 }, default: Fallback::Int(0) },
    Def { key: "shopToTreasury", label: "Shop sales go to the server treasury (otherwise the coins just disappear)", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "gemsEnabled", label: "A second currency members can exchange coins for (/exchange)", kind: Kind::Toggle, default: Fallback::Bool(false) },
    Def { key: "gemName", label: "Second currency name", kind: Kind::Text { max_len: 20 }, default: Fallback::Str("gems") },
    Def { key: "gemEmoji", label: "Second currency emoji", kind: Kind::Text { max_len: 64 }, default: Fallback::Str("💎") },
    Def { key: "exchangeRate", label: "Exchange rate: coins for one of the second currency", kind: Kind::Number { min: 1, max: 1_000_000 }, default: Fallback::Int(100) },
    Def { key: "exchangeFee", label: "Exchange fee (%), either way: goes to the server treasury", kind: Kind::Number { min: 0, max: 50 }, default: Fallback::Int(5) },
    Def { key: "globalBoard", label: "Show this server's members on the global leaderboard", kind: Kind::Toggle, default: Fallback::Bool(false) },
];

// ---- the daily streak, as plain rules (the same numbers as Good Boy 3's src/economy.js)
pub const HOUR: i64 = 3_600_000;
/// Claimable 20 hours after the last claim, so the time of day can drift.
pub const CLAIM_EVERY: i64 = 20 * HOUR;
/// The streak survives up to 48 hours between claims.
pub const STREAK_GRACE: i64 = 48 * HOUR;
pub const MAX_SHIELDS: i64 = 3;
const STREAK_CAP: i64 = 30;

/// 1 + 5% per streak day after the first, capped at +150%.
pub fn streak_multiplier(streak: i64) -> f64 {
    1.0 + ((streak.max(1) - 1).min(STREAK_CAP) as f64) * 0.05
}
pub fn milestone_bonus(streak: i64, base: i64) -> i64 {
    if streak > 0 && streak % 30 == 0 {
        base * 10
    } else if streak == 14 {
        base * 4
    } else if streak == 7 {
        base * 2
    } else {
        0
    }
}
#[derive(Debug, Clone, PartialEq)]
pub struct Claim {
    pub reward: i64,
    pub bonus: i64,
    pub total: i64,
    pub streak: i64,
    pub shields: i64,
    pub best_streak: i64,
    pub used_shield: bool,
    pub shield_earned: bool,
    pub lost: bool,
    pub next_at: i64,
}
/// What a daily claim does. Err(when it is ready) when it is too early.
pub fn claim_daily(streak: i64, last_daily: i64, shields: i64, best_streak: i64, base: i64, now: i64) -> Result<Claim, i64> {
    if last_daily != 0 && now - last_daily < CLAIM_EVERY {
        return Err(last_daily + CLAIM_EVERY);
    }
    let (mut streak, mut shields) = (streak, shields);
    let (mut used_shield, mut lost) = (false, false);
    if last_daily == 0 {
        streak = 1;
    } else if now - last_daily <= STREAK_GRACE {
        streak += 1;
    } else if shields > 0 {
        shields -= 1;
        used_shield = true;
        streak += 1;
    } else {
        lost = streak > 1;
        streak = 1;
    }
    let mut shield_earned = false;
    if streak % 7 == 0 && shields < MAX_SHIELDS {
        shields += 1;
        shield_earned = true;
    }
    let reward = js_round(base as f64 * streak_multiplier(streak));
    let bonus = milestone_bonus(streak, base);
    Ok(Claim { reward, bonus, total: reward + bonus, streak, shields, best_streak: best_streak.max(streak), used_shield, shield_earned, lost, next_at: now + CLAIM_EVERY })
}
/// JavaScript's Math.round (halves go up), so rewards match Good Boy 3 to the coin.
fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

/// An amount someone typed: "500", "1,500", "2.5k", "1m", or "all" / "half" of what they have.
pub fn parse_amount(raw: &str, have: Option<i64>, min: i64, max: i64) -> Result<i64, String> {
    let s: String = raw.trim().to_lowercase().chars().filter(|c| !matches!(c, ',' | ' ' | '_')).collect();
    let wrong = || "Type a whole number like `500`, `2.5k`, `all` or `half`.".to_string();
    let n: f64 = match s.as_str() {
        "all" | "max" => have.ok_or_else(wrong)? as f64,
        "half" => (have.ok_or_else(wrong)? / 2) as f64,
        _ => {
            let (digits, times) = match s.strip_suffix('k') {
                Some(d) => (d, 1e3),
                None => match s.strip_suffix('m') {
                    Some(d) => (d, 1e6),
                    None => (s.as_str(), 1.0),
                },
            };
            let ok = !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit() || c == '.') && digits.matches('.').count() <= 1 && !digits.starts_with('.') && !digits.ends_with('.');
            if !ok {
                return Err(wrong());
            }
            digits.parse::<f64>().map_err(|_| wrong())? * times
        }
    };
    if !n.is_finite() {
        return Err(wrong());
    }
    let n = n.floor() as i64;
    if n < min {
        return Err(format!("The amount must be at least {}.", group(min)));
    }
    if n > max {
        return Err(format!("The amount can be at most {}.", group(max)));
    }
    Ok(n)
}

/// The jobs /work picks from (the same list as Good Boy 3).
pub const JOBS: &[(&str, &str)] = &[
    ("walked {n} dogs around the park", "🐕"), ("gave {n} puppies a bath", "🛁"), ("delivered {n} pizzas", "🍕"), ("fixed {n} bugs in a game", "🐛"),
    ("baked {n} batches of dog biscuits", "🍪"), ("helped {n} people find their lost cats", "🐈"), ("streamed for {n} hours", "🎥"), ("mowed {n} lawns", "🌱"),
    ("taught {n} dogs to sit", "🦴"), ("washed {n} cars", "🚗"), ("sold {n} lemonades", "🍋"), ("tutored {n} students", "📚"), ("fetched {n} sticks (professionally)", "🪵"),
    ("moderated a Discord server for {n} hours", "🛡️"), ("drew {n} commissions", "🎨"), ("ran {n} errands for the neighbours", "🛒"),
];

// ---- the module
/// Giving, taking and resetting coins: admins unless a server hands it to other roles.
pub const ADMIN: crate::perms::Perm = crate::perms::Perm { key: "economy.admin", level: crate::perms::Level::Admin };

pub struct Money<'a> {
    pub db: &'a Db,
    pub settings: &'a Settings,
    pub guild: &'a str,
}

/// A tax of `pct` percent of `amount`, rounded down. Never more than the amount.
pub fn tax_of(amount: i64, pct: i64) -> i64 {
    if amount <= 0 || pct <= 0 { 0 } else { (amount as i128 * pct.min(100) as i128 / 100) as i64 }
}
/// Buying second currency with coins: the most gems `coins` pays for after the fee, what that costs, and how much of
/// the cost is the fee. None when it does not even buy one.
pub fn coins_to_gems(coins: i64, rate: i64, fee_pct: i64) -> Option<(i64, i64, i64)> {
    let rate = rate.max(1);
    let keep = 100 - fee_pct.clamp(0, 99);
    let gems = (coins as i128 * keep as i128 / 100 / rate as i128) as i64;
    if gems < 1 { return None; }
    // the least coins that still pay for those gems, so no leftover coins are wasted
    let cost = (((gems as i128 * rate as i128 * 100) + keep as i128 - 1) / keep as i128) as i64;
    let cost = cost.min(coins);
    Some((gems, cost, cost - gems * rate))
}
/// Selling second currency: the coins received after the fee, and the fee.
pub fn gems_to_coins(gems: i64, rate: i64, fee_pct: i64) -> (i64, i64) {
    let gross = gems.saturating_mul(rate.max(1));
    let fee = tax_of(gross, fee_pct);
    (gross - fee, fee)
}

impl Money<'_> {
    fn int(&self, key: &str) -> i64 {
        self.settings.int(self.guild, MODULE, key)
    }
    /// "**1,840** 🪙"
    pub fn coins(&self, n: i64) -> String {
        format!("**{}** {}", group(n), self.settings.text(self.guild, MODULE, "currencyEmoji").unwrap_or_else(|| "🪙".into()))
    }

    /// `/money reset`: asks first. Only for admins (`economy.admin`, the same permission as Good Boy 3's coin tools).
    pub fn reset_prompt(&self, who: &Member, target: Option<&Member>) -> Action {
        if !crate::perms::allowed(self.db, self.guild, who, ADMIN) {
            return Action::Reply { card: Card::new(Area::Money).line("You don't have permission for that (`economy.admin`).").private() };
        }
        let (what, id) = match target {
            Some(t) => (format!("<@{}>'s wallet: their coins, bank, streak, items and pet", t.id), format!("money:reset:{}", t.id)),
            None => (format!("the whole economy in this server: everyone's coins, bank, streaks, items, pets and lottery tickets ({} wallets)", self.db.get().wallet_count(self.guild).unwrap_or(0)), "money:reset:all".into()),
        };
        Action::Reply { card: Card::new(Area::Money).title("Reset the economy?").line(format!("This resets {what}. Members start again with {} the next time they use it.", self.coins(self.int("startingCoins"))))
            .line("The shop and the settings are kept. A backup of all the bot's data is made first, so it can be undone from Bot settings > Your data.")
            .button(id, "Yes, reset", ButtonStyle::Danger).button("money:reset:cancel", "Cancel", ButtonStyle::Plain).private() }
    }
    /// The reset's buttons. The permission is checked again: a button can be pressed long after it was shown.
    pub fn reset_press(&self, who: &Member, what: &str, now: i64) -> Vec<Action> {
        let say = |text: String| vec![Action::Update { card: Card::new(Area::Money).line(text).private() }];
        if what == "cancel" { return say("Nothing was reset.".into()); }
        if !crate::perms::allowed(self.db, self.guild, who, ADMIN) { return say("You don't have permission for that (`economy.admin`).".into()); }
        let user = (what != "all").then_some(what).filter(|u| u.bytes().all(|b| b.is_ascii_digit()));
        if what != "all" && user.is_none() { return say("That button is from an older message.".into()); }
        match self.reset(user, now) {
            Ok(n) => {
                let mut out = say(match user { Some(u) => format!("🪙 <@{u}>'s wallet was reset."), None => format!("🪙 The economy was reset ({n} wallets). A backup was made first.") });
                if let Some(channel) = self.settings.text(self.guild, "moderation", "logChannel") {
                    out.push(Action::Send { channel, card: Card::new(Area::Money).line(match user { Some(u) => format!("🪙 <@{}> reset <@{u}>'s wallet.", who.id), None => format!("🪙 <@{}> reset the economy ({n} wallets).", who.id) }), ping: Vec::new(), roles: Vec::new() });
                }
                out
            }
            Err(why) => say(why),
        }
    }
    /// Makes a backup of all the bot's data, then resets. Nothing is reset if the backup fails.
    pub fn reset(&self, user: Option<&str>, now: i64) -> Result<usize, String> {
        let store = self.db.get();
        let backups = store.path().parent().map(|p| p.join("backups")).ok_or("The data folder could not be found, so nothing was reset.")?;
        // never written over: a second reset in the same moment gets its own file
        let file = (1..).map(|n| backups.join(if n == 1 { format!("good-boy-before-economy-reset-{now}.db") } else { format!("good-boy-before-economy-reset-{now}-{n}.db") })).find(|f| !f.exists()).unwrap();
        store.backup_to(&file).map_err(|e| format!("A backup could not be made first, so nothing was reset ({e})."))?;
        store.economy_reset(self.guild, user).map_err(|e| format!("The reset did not go through: {e}"))
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn taxes_and_exchange_round_in_the_servers_favour_and_waste_nothing() {
        assert_eq!((tax_of(1000, 5), tax_of(19, 5), tax_of(0, 5), tax_of(100, 0), tax_of(-5, 10)), (50, 0, 0, 0, 0));
        // 5% fee, 100 coins a gem: 1,000 coins pay for 9 gems (900 + a 5% fee = 947.4, rounded up to 948), not 9.5
        let (g, cost, fee) = coins_to_gems(1000, 100, 5).unwrap();
        assert_eq!((g, cost, fee), (9, 948, 48));
        assert!(cost <= 1000 && g * 100 + fee == cost);
        assert_eq!(coins_to_gems(99, 100, 0), None);
        assert_eq!(coins_to_gems(100, 100, 5), None, "the fee leaves less than one gem");
        assert_eq!(coins_to_gems(100, 100, 0), Some((1, 100, 0)));
        // selling 3 gems is worth 300, 5% of it (15) is the fee
        assert_eq!(gems_to_coins(3, 100, 5), (285, 15));
        assert_eq!(gems_to_coins(1, 1, 50), (1, 0));
    }
    #[test]
    fn amounts_people_type() {
        assert_eq!(parse_amount("500", None, 1, 1_000_000), Ok(500));
        assert_eq!(parse_amount(" 1,500 ", None, 1, 1_000_000), Ok(1500));
        assert_eq!(parse_amount("2.5k", None, 1, 1_000_000), Ok(2500));
        assert_eq!(parse_amount("1M", None, 1, 1_000_000), Ok(1_000_000));
        assert_eq!(parse_amount("all", Some(320), 1, 1_000_000), Ok(320));
        assert_eq!(parse_amount("half", Some(321), 1, 1_000_000), Ok(160));
        assert!(parse_amount("all", None, 1, 10).is_err());
        for bad in ["", "abc", "-5", "1.2.3", ".5", "5.", "k", "1e9", "١٢٣"] {
            assert!(parse_amount(bad, Some(100), 1, 1_000_000).unwrap_err().starts_with("Type a whole number"), "{bad}");
        }
        assert_eq!(parse_amount("0", None, 1, 10).unwrap_err(), "The amount must be at least 1.");
        assert_eq!(parse_amount("2m", None, 1, 1_000_000).unwrap_err(), "The amount can be at most 1,000,000.");
    }
}
