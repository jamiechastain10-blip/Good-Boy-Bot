//! Draws sample quotes to look at the drawing: `cargo run -p gb-art --example quote -- <folder> [avatar picture] [photo]`
//! writes quote-fancy.png (a fancy-letter name, other scripts and emoji), quote-photo.png (with the photo, if given),
//! quote-original.png (pixel art off) and quote-motion.gif.
use gb_art::{quote_motion, quote_png, Quote};
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let dir = std::path::PathBuf::from(a.get(1).map(String::as_str).unwrap_or("."));
    let avatar = a.get(2).and_then(|p| std::fs::read(p).ok());
    let photo = a.get(3).and_then(|p| std::fs::read(p).ok());
    std::fs::create_dir_all(&dir).unwrap();
    let base = Quote { text: "Good boy means every word, even the ones with sparkles ✨ and <:wave:123456789012345678> ありがとう Привет".into(), name: "𝓚𝓪𝓲 ✦ the Good 🐶".into(), handle: "kai_the_good".into(), when: "Nov 12, 2026".into(), color: true, pixel: true, picture: None, look: None };
    let write = |name: &str, q: &Quote| {
        let t = std::time::Instant::now();
        std::fs::write(dir.join(name), quote_png(q, avatar.as_deref()).expect("drawn")).unwrap();
        println!("{name} {:?}", t.elapsed());
    };
    write("quote-fancy.png", &base);
    write("quote-original.png", &Quote { pixel: false, ..base.clone() });
    // the ready-made classic looks
    for (id, _) in gb_art::quote::LOOKS.iter().filter(|(id, _)| *id != "pixel") {
        write(&format!("quote-{id}.png"), &Quote { pixel: false, look: gb_art::quote::preset_look(id), ..base.clone() });
    }
    if photo.is_some() {
        write("quote-photo.png", &Quote { text: "look what I caught at the lake today!".into(), name: "Mint".into(), handle: "mint".into(), picture: photo.clone(), ..base.clone() });
    }
    let t = std::time::Instant::now();
    let g = quote_motion(&base, avatar.as_deref()).expect("drawn");
    println!("motion {:?} {} bytes", t.elapsed(), g.len());
    std::fs::write(dir.join("quote-motion.gif"), g).unwrap();
}
