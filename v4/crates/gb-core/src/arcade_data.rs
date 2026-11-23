//! Trivia questions, taken as they are from Good Boy 3 (generated from src/minigames.js; do not edit by hand).
/// (category id, label, questions as [question, right answer, three wrong answers]).
pub const TRIVIA: &[(&str, &str, &[[&str; 5]])] = &[
    ("general", "General", &[
        ["How many days are in a leap year?", "366", "365", "364", "360"],
        ["How many sides does a hexagon have?", "6", "5", "7", "8"],
        ["What colour do you get by mixing blue and yellow?", "Green", "Purple", "Orange", "Brown"],
        ["How many minutes are in a day?", "1,440", "1,240", "1,600", "960"],
        ["Which month has the fewest days?", "February", "April", "June", "November"],
        ["How many strings does a standard guitar have?", "6", "4", "5", "8"],
        ["What is the largest ocean on Earth?", "Pacific Ocean", "Atlantic Ocean", "Indian Ocean", "Arctic Ocean"],
        ["How many players are on the field for one football (soccer) team?", "11", "10", "9", "12"],
        ["Which shape has three sides?", "Triangle", "Square", "Pentagon", "Circle"],
        ["What is 12 times 12?", "144", "124", "132", "156"],
        ["How many continents are there?", "7", "5", "6", "8"],
        ["Which is the tallest animal in the world?", "Giraffe", "Elephant", "Camel", "Moose"],
        ["How many hours are in a week?", "168", "144", "172", "160"],
        ["Which instrument has 88 keys?", "Piano", "Organ", "Accordion", "Harp"],
        ["What do bees make?", "Honey", "Milk", "Silk", "Wax only"],
        ["How many zeros are in one million?", "6", "5", "7", "9"],
    ]),
    ("science", "Science", &[
        ["What planet is known as the Red Planet?", "Mars", "Venus", "Jupiter", "Mercury"],
        ["What gas do plants take in from the air?", "Carbon dioxide", "Oxygen", "Nitrogen", "Helium"],
        ["What is the chemical symbol for gold?", "Au", "Ag", "Gd", "Go"],
        ["Which planet is the largest in our solar system?", "Jupiter", "Saturn", "Neptune", "Earth"],
        ["What is H2O better known as?", "Water", "Salt", "Hydrogen", "Ice cream"],
        ["How many bones are in an adult human body?", "206", "186", "226", "306"],
        ["What is the closest star to Earth?", "The Sun", "Proxima Centauri", "Sirius", "Polaris"],
        ["At what temperature does water boil at sea level?", "100 °C", "90 °C", "80 °C", "120 °C"],
        ["Which organ pumps blood around the body?", "Heart", "Lungs", "Liver", "Kidneys"],
        ["What is the hardest natural substance?", "Diamond", "Gold", "Iron", "Quartz"],
        ["Which planet has the most famous rings?", "Saturn", "Mars", "Venus", "Mercury"],
        ["What do we call animals that eat only plants?", "Herbivores", "Carnivores", "Omnivores", "Insectivores"],
        ["What is the chemical symbol for sodium?", "Na", "So", "Sd", "S"],
        ["How many legs does a spider have?", "8", "6", "10", "12"],
        ["What force keeps us on the ground?", "Gravity", "Magnetism", "Friction", "Wind"],
    ]),
    ("geography", "Geography", &[
        ["What is the capital of France?", "Paris", "Lyon", "Marseille", "Nice"],
        ["What is the capital of Japan?", "Tokyo", "Kyoto", "Osaka", "Sapporo"],
        ["Which is the longest river in Africa?", "Nile", "Congo", "Niger", "Zambezi"],
        ["What is the capital of Australia?", "Canberra", "Sydney", "Melbourne", "Perth"],
        ["Which country is shaped like a boot?", "Italy", "Spain", "Greece", "Portugal"],
        ["What is the largest country by area?", "Russia", "Canada", "China", "United States"],
        ["Mount Everest is in which mountain range?", "Himalayas", "Andes", "Alps", "Rockies"],
        ["What is the capital of Canada?", "Ottawa", "Toronto", "Vancouver", "Montreal"],
        ["Which desert is the largest hot desert in the world?", "Sahara", "Gobi", "Kalahari", "Atacama"],
        ["What is the capital of Spain?", "Madrid", "Barcelona", "Seville", "Valencia"],
        ["Which country has the city of Rio de Janeiro?", "Brazil", "Argentina", "Portugal", "Mexico"],
        ["What is the capital of Egypt?", "Cairo", "Alexandria", "Giza", "Luxor"],
        ["Which US state is made up of islands in the Pacific?", "Hawaii", "Alaska", "Florida", "California"],
        ["What is the smallest country in the world?", "Vatican City", "Monaco", "San Marino", "Malta"],
    ]),
    ("games", "Games", &[
        ["In Minecraft, what do you need to make a Nether portal?", "Obsidian", "Bedrock", "Glass", "Netherrack"],
        ["What colour is the ghost Blinky in Pac-Man?", "Red", "Pink", "Blue", "Orange"],
        ["In Minecraft, what explodes with a hiss?", "Creeper", "Zombie", "Skeleton", "Enderman"],
        ["What is the best-selling video game of all time?", "Minecraft", "Tetris", "GTA V", "Wii Sports"],
        ["In Tetris, how many blocks make up each piece?", "4", "3", "5", "6"],
        ["What company makes the PlayStation?", "Sony", "Nintendo", "Microsoft", "Sega"],
        ["In Among Us, what is the bad player called?", "Impostor", "Traitor", "Spy", "Hunter"],
        ["What is the name of the princess Mario often rescues?", "Peach", "Daisy", "Zelda", "Rosalina"],
        ["In The Legend of Zelda, what is the hero usually called?", "Link", "Zelda", "Ganon", "Epona"],
        ["Which game has a battle bus?", "Fortnite", "Apex Legends", "PUBG", "Overwatch"],
        ["What is Sonic the Hedgehog's colour?", "Blue", "Red", "Green", "Yellow"],
        ["In Minecraft, which mob drops ender pearls?", "Enderman", "Blaze", "Ghast", "Creeper"],
        ["Roblox players call the in-game money what?", "Robux", "Bloxbucks", "Coins", "V-Bucks"],
    ]),
    ("anime", "Anime", &[
        ["In Naruto, what village is Naruto from?", "Hidden Leaf (Konoha)", "Hidden Sand", "Hidden Mist", "Hidden Cloud"],
        ["What is the name of Luffy's crew in One Piece?", "Straw Hat Pirates", "Red Hair Pirates", "Heart Pirates", "Whitebeard Pirates"],
        ["Which anime has the Survey Corps fighting Titans?", "Attack on Titan", "Demon Slayer", "Bleach", "Fullmetal Alchemist"],
        ["In Death Note, which Shinigami drops the notebook?", "Ryuk", "Rem", "Sidoh", "Gelus"],
        ["What is Goku's Saiyan birth name in Dragon Ball?", "Kakarot", "Raditz", "Bardock", "Tarble"],
        ["In Demon Slayer, what is Tanjiro's sister called?", "Nezuko", "Kanao", "Shinobu", "Mitsuri"],
        ["In My Hero Academia, what is Deku's Quirk called?", "One For All", "All For One", "Explosion", "Half-Cold Half-Hot"],
        ["What do the Elric brothers practise in Fullmetal Alchemist?", "Alchemy", "Magic", "Ninjutsu", "Swordplay"],
        ["In Spirited Away, what is the name of the girl who works at the bathhouse?", "Chihiro", "Kiki", "Sophie", "Satsuki"],
        ["In Jujutsu Kaisen, who is the main character?", "Yuji Itadori", "Megumi Fushiguro", "Satoru Gojo", "Nobara Kugisaki"],
        ["Which Studio Ghibli film features a giant furry forest spirit?", "My Neighbor Totoro", "Princess Mononoke", "Ponyo", "Howl's Moving Castle"],
        ["In One Piece, what does Luffy want to become?", "King of the Pirates", "A Marine Admiral", "The greatest swordsman", "A doctor"],
        ["In Hunter x Hunter, what is Gon searching for?", "His father", "A treasure", "His brother", "A lost city"],
        ["In Sailor Moon, what is Usagi's cat called?", "Luna", "Artemis", "Diana", "Jiji"],
        ["What is the name of the pirate swordsman who uses three swords in One Piece?", "Zoro", "Sanji", "Usopp", "Brook"],
    ]),
];

// ---------------------------------------------------------------- the whole pool
/// One trivia category with every question from Good Boy 3 and the extra pool in `data/trivia.tsv`.
pub struct TriviaCat {
    pub id: &'static str,
    pub label: &'static str,
    pub rows: Vec<[&'static str; 5]>,
}
/// Labels for the categories the extra pool adds, in the order they are listed.
const EXTRA_LABELS: &[(&str, &str)] = &[
    ("history", "History"), ("animals", "Animals"), ("food", "Food & Drink"), ("tech", "Tech"), ("sports", "Sports"),
    ("music", "Music"), ("movies", "Movies & TV"), ("language", "Language"), ("math", "Math"),
];
const EXTRA: &str = include_str!("../assets/trivia.tsv");
/// Every category: the Good Boy 3 questions first, then the extra pool (made by `tools/trivia/make-trivia.py`).
pub fn pool() -> &'static [TriviaCat] {
    static POOL: std::sync::OnceLock<Vec<TriviaCat>> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        let mut cats: Vec<TriviaCat> = TRIVIA.iter().map(|c| TriviaCat { id: c.0, label: c.1, rows: c.2.to_vec() }).collect();
        for (id, label) in EXTRA_LABELS {
            cats.push(TriviaCat { id, label, rows: Vec::new() });
        }
        let mut seen: std::collections::HashSet<String> = cats.iter().flat_map(|c| c.rows.iter().map(|r| r[0].to_lowercase())).collect();
        for line in EXTRA.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()) {
            let f: Vec<&'static str> = line.split('\t').collect();
            // a question Good Boy 3 already asks is not asked twice
            if f.len() != 6 || !seen.insert(f[1].to_lowercase()) { continue; }
            if let Some(c) = cats.iter_mut().find(|c| c.id == f[0]) {
                c.rows.push([f[1], f[2], f[3], f[4], f[5]]);
            }
        }
        cats.retain(|c| !c.rows.is_empty());
        cats
    })
}
