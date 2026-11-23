//! Draws the games' animations into a folder: `cargo run --release -p gb-art --example games_gif -- <folder>`.
use gb_art::games::*;
fn main() {
    let dir = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    let save = |name: &str, make: &dyn Fn() -> Option<Vec<u8>>| {
        let t = std::time::Instant::now();
        let b = make().expect("drawn");
        println!("{name}: {} KB in {} ms", b.len() / 1024, t.elapsed().as_millis());
        std::fs::write(format!("{dir}/{name}.gif"), b).expect("saved");
    };
    save("slots", &|| slots_spin(&[["lemon", "seven", "grape"], ["bell", "wild", "cherry"], ["star", "seven", "diamond"]], "Big win! 400x · +39,900", true));
    let c: Vec<String> = ["A♠", "10♥", "8♦", "8♣", "K♣", "5♥"].iter().map(|c| c.to_string()).collect();
    let hand = [TableHand { label: "Your hand · 16".into(), cards: &c[2..4], result: Some("Dealer wins · -100".into()), active: true }];
    save("blackjack-deal", &|| blackjack_film("Dealer · 10", "Dealer · ?", &c[..2], true, &hand, "Blackjack pays 3 to 2 · dealer stands on 17", true));
    save("blackjack-reveal", &|| blackjack_film("Dealer · 26", "Dealer · ?", &[c[1].clone(), c[2].clone(), c[3].clone()], false, &hand, "Blackjack pays 3 to 2 · dealer stands on 17", false));
    save("coin", &|| coin_flip(true, true, "Heads! You won 195"));
    let f = Fight { biome: "bay", place: "Lantern Bay", rarity: Some(("Epic", "#9b59b6")), track: 20, zone: 7, zone_width: 6, pos: 9, catch_pct: 45.0, tension_pct: 62.0, surge: false };
    save("fish-fight", &|| fishing_loop(&f));
    save("fish-wait", &|| fishing_loop(&Fight { rarity: None, ..f }));
    save("fish-caught", &|| fishing_result_film("bay", "Lantern Bay", Some(("Epic", "#9b59b6", "Lighthouse Pike · Giant", "31.4 kg · worth 1,288 · +100 XP")), ""));
    save("fish-missed", &|| fishing_result_film("bay", "Lantern Bay", None, "It got away"));
}
