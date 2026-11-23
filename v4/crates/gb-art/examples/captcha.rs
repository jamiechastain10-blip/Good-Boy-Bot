fn main() {
    let out = std::env::args().nth(1).unwrap_or_else(|| "captcha.png".into());
    std::fs::write(&out, gb_art::captcha("KM7TR", 42).expect("a picture")).unwrap();
}
