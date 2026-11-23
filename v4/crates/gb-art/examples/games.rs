//! Draws the games' pictures into a folder, to look at them: `cargo run -p gb-art --example games -- <folder>`.
use gb_art::games::*;
fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    let save = |name: &str, b: Option<Vec<u8>>| std::fs::write(format!("{dir}/{name}.png"), b.expect("drawn")).expect("saved");
    save("slots", slots(&[["lemon", "seven", "grape"], ["bell", "wild", "cherry"], ["star", "seven", "diamond"]], "Big win! 400x · +39,900", true));
    save("slots-lose", slots(&[["cherry", "lemon", "grape"], ["bell", "star", "cherry"], ["diamond", "wild", "lemon"]], "No luck this time", false));
    let c: Vec<String> = ["A♠", "10♥", "8♦", "8♣", "K♣", "5♥"].iter().map(|c| c.to_string()).collect();
    save("blackjack", blackjack("Dealer · 10", &c[1..3], true, &[TableHand { label: "Your hand · 16".into(), cards: &c[2..4], result: None, active: true }], "Blackjack pays 3 to 2 · dealer stands on 17"));
    save("blackjack-split", blackjack("Dealer · 18", &c[1..3], false, &[TableHand { label: "Hand 1 · 21".into(), cards: &c[..2], result: Some("You win · +100".into()), active: false }, TableHand { label: "Hand 2 · 23".into(), cards: &c[3..], result: Some("Bust · -100".into()), active: true }], "Blackjack pays 3 to 2 · dealer stands on 17"));
    save("coin", coin(true, true, "Heads! You won 195"));
    let f = Fight { biome: "bay", place: "Lantern Bay", rarity: Some(("Epic", "#9b59b6")), track: 20, zone: 7, zone_width: 6, pos: 9, catch_pct: 45.0, tension_pct: 62.0, surge: false };
    save("fish-reel", fishing(&f));
    save("fish-wait", fishing(&Fight { rarity: None, ..f }));
    save("fish-caught", fishing_result("bay", "Lantern Bay", Some(("Epic", "#9b59b6", "Lighthouse Pike · Giant", "31.4 kg · worth 1,288 · +100 XP")), ""));
    save("fish-eclipse", fishing(&Fight { biome: "eclipse", place: "The Eclipse Sea", rarity: Some(("Mythical", "#e91e63")), pos: 2, tension_pct: 88.0, surge: true, ..f }));
}
// (animated versions are written by `games_gif`)
