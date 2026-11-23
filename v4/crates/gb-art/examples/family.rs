//! Draws a sample family tree to family.png (to look at the drawing).
use gb_art::{family_tree, TreeUnit};
fn main() {
    let u = |p: &[&str], c: Vec<TreeUnit>| TreeUnit { people: p.iter().map(|s| s.to_string()).collect(), children: c };
    let tree = u(&["1", "2"], vec![u(&["3"], vec![u(&["5"], vec![])]), u(&["4", "6"], vec![])]);
    let people = [("1", "Ghost"), ("2", "Rowan"), ("3", "Kai with a very long name"), ("4", "Mika"), ("5", "Pip"), ("6", "Juno")].iter().map(|(i, n)| (i.to_string(), (n.to_string(), None))).collect();
    let png = family_tree(&tree, &people, Some("3"), "Kai's family", std::env::args().nth(1).is_some_and(|a| a == "pixel")).expect("drawn");
    std::fs::write("family.png", png).unwrap();
}
