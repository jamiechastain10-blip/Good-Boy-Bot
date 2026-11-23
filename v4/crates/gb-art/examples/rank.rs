//! Draws a rank card to a file, for comparing with Good Boy 3's: rank <out.png> <theme> [avatar.png] [background]
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let avatar = a.get(3).and_then(|p| std::fs::read(p).ok());
    let bg = a.get(4).and_then(|p| std::fs::read(p).ok());
    let card = gb_art::Rank { name: "Kai the Good Boy", avatar: avatar.as_deref(), level: 12, into: 180, needed: 1000, rank: Some(4), xp: 12840, messages: 1204, accent: a.get(5).map(String::as_str), accent2: None, theme: a.get(2).map(String::as_str), background: bg.as_deref(), pixel: a.get(6).is_some_and(|v| v == "pixel") };
    std::fs::write(&a[1], gb_art::rank_card(&card).expect("drawn")).unwrap();
}
