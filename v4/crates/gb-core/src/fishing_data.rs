// Generated from Good Boy 3's src/fishing.js so every place, rod, bait and fish list is exactly the same.
// Do not edit by hand.
#![allow(clippy::type_complexity)]


use crate::fishing::{Earn, RodDef};
pub static SPECIES: &[(&str, &[(&str, f64, f64, f64)])] = &[
    ("bay", &[("Pier Minnow", 0.05, 0.3, 8.0), ("Lantern Perch", 0.3, 1.5, 20.0), ("Harbor Bass", 1.0, 6.0, 60.0), ("Copperfin Snapper", 3.0, 12.0, 150.0), ("Lighthouse Pike", 8.0, 30.0, 500.0), ("Old Beacon", 40.0, 120.0, 2500.0)]),
    ("marsh", &[("Mud Loach", 0.1, 0.5, 13.0), ("Reed Carp", 0.5, 4.0, 32.0), ("Bogscale Gar", 2.0, 9.0, 95.0), ("Willowhisker Catfish", 5.0, 20.0, 240.0), ("Moss Sturgeon", 15.0, 60.0, 800.0), ("The Marsh Warden", 80.0, 220.0, 4000.0)]),
    ("glacier", &[("Frostling", 0.1, 0.4, 20.0), ("Icefin Char", 0.6, 3.0, 50.0), ("Shelf Cod", 3.0, 14.0, 150.0), ("Aurora Trout", 4.0, 16.0, 375.0), ("Glacial Halibut", 30.0, 110.0, 1250.0), ("Rimewyrm Eel", 60.0, 300.0, 6250.0)]),
    ("vents", &[("Ashfry", 0.05, 0.3, 32.0), ("Ember Goby", 0.3, 2.0, 80.0), ("Magma Wrasse", 2.0, 10.0, 240.0), ("Obsidian Ray", 10.0, 45.0, 600.0), ("Scorchjaw Grouper", 40.0, 150.0, 2000.0), ("Heartfire Leviathan", 200.0, 600.0, 10000.0)]),
    ("deep", &[("Gloom Shrimpfish", 0.05, 0.2, 56.0), ("Hollow Eye", 0.5, 3.0, 140.0), ("Lantern Angler", 3.0, 15.0, 420.0), ("Abyssal Gulper", 15.0, 70.0, 1050.0), ("Void Cuttle", 50.0, 200.0, 3500.0), ("The Unnamed", 300.0, 1200.0, 17500.0)]),
    ("reef", &[("Glint Sprat", 0.05, 0.3, 90.0), ("Voltfin Tang", 0.4, 2.5, 220.0), ("Thunderhead Snapper", 4.0, 18.0, 650.0), ("Squall Manta", 20.0, 90.0, 1650.0), ("Stormcaller Marlin", 80.0, 300.0, 5500.0), ("The Tempest", 400.0, 1500.0, 27500.0)]),
    ("spire", &[("Moss Pebblefish", 0.1, 0.5, 140.0), ("Relic Carp", 1.0, 6.0, 350.0), ("Gilded Arowana", 4.0, 20.0, 1050.0), ("Sentinel Gar", 25.0, 110.0, 2650.0), ("Crowned Coelacanth", 90.0, 350.0, 8800.0), ("The Drowned King", 500.0, 1800.0, 44000.0)]),
    ("trench", &[("Glowmote", 0.02, 0.15, 225.0), ("Prism Jelly", 0.5, 4.0, 560.0), ("Lumen Ray", 6.0, 30.0, 1700.0), ("Aurora Serpent", 30.0, 140.0, 4200.0), ("Veilshark", 120.0, 450.0, 14000.0), ("The Northern Light", 600.0, 2200.0, 70000.0)]),
    ("abyss", &[("Stardust Minnow", 0.02, 0.1, 360.0), ("Comet Tetra", 0.3, 2.0, 900.0), ("Nebula Grouper", 10.0, 45.0, 2700.0), ("Void Leviathan Pup", 50.0, 200.0, 6700.0), ("Eclipse Kraken", 200.0, 700.0, 22000.0), ("The Last Star", 900.0, 3000.0, 112000.0)]),
];

pub static MORE_SPECIES: &[(&str, &[(&str, f64, f64, f64)])] = &[
    ("bay", &[("Dock Sprat", 0.05, 0.25, 9.0), ("Rope Eel", 0.4, 2.0, 22.0), ("Buoy Bream", 1.0, 5.0, 65.0), ("Anchor Flounder", 4.0, 14.0, 160.0), ("Harbourmaster Tuna", 10.0, 40.0, 520.0), ("The Fogbell", 50.0, 150.0, 2600.0)]),
    ("marsh", &[("Peat Tadfish", 0.1, 0.4, 14.0), ("Lily Pike", 0.5, 3.0, 34.0), ("Frogmouth Bass", 2.0, 8.0, 100.0), ("Mirewing Ray", 6.0, 22.0, 250.0), ("Bogwitch Eel", 20.0, 70.0, 820.0), ("The Willow Ghost", 90.0, 250.0, 4100.0)]),
    ("glacier", &[("Snowdrop Smelt", 0.1, 0.35, 21.0), ("Crystal Shrimpfish", 0.5, 2.5, 52.0), ("Frostbite Pollock", 3.0, 12.0, 155.0), ("Tusked Iceling", 5.0, 18.0, 380.0), ("Polar Sturgeon", 35.0, 120.0, 1300.0), ("The Frozen Heart", 80.0, 320.0, 6400.0)]),
    ("vents", &[("Sootling", 0.05, 0.25, 33.0), ("Flare Tetra", 0.3, 1.8, 82.0), ("Basalt Pufferfish", 2.0, 9.0, 245.0), ("Lava Lamprey", 8.0, 40.0, 610.0), ("Pyroclast Shark", 50.0, 170.0, 2050.0), ("The Molten Crown", 250.0, 700.0, 10200.0)]),
    ("deep", &[("Hush Fry", 0.05, 0.2, 57.0), ("Pale Drifter", 0.5, 2.8, 142.0), ("Needle Viperfish", 3.0, 14.0, 425.0), ("Silent Siphon", 15.0, 65.0, 1060.0), ("Hollow Mantle", 60.0, 220.0, 3550.0), ("The Whisper Below", 350.0, 1300.0, 17800.0)]),
    ("reef", &[("Spark Minnow", 0.05, 0.3, 92.0), ("Static Eel", 0.5, 3.0, 222.0), ("Galecrest Wrasse", 4.0, 16.0, 655.0), ("Thunder Ray", 22.0, 95.0, 1670.0), ("Squallbreaker Sailfish", 90.0, 320.0, 5550.0), ("The Eye of the Storm", 450.0, 1600.0, 27800.0)]),
    ("spire", &[("Altar Tetra", 0.1, 0.5, 142.0), ("Mosaic Koi", 1.0, 5.0, 352.0), ("Pillar Grouper", 5.0, 22.0, 1060.0), ("Gargoyle Ray", 28.0, 120.0, 2670.0), ("Throne Sturgeon", 100.0, 380.0, 8850.0), ("The Sunken Oracle", 550.0, 1900.0, 44300.0)]),
    ("trench", &[("Shimmer Fry", 0.02, 0.15, 226.0), ("Halo Squidling", 0.5, 3.5, 562.0), ("Borealis Eel", 7.0, 32.0, 1710.0), ("Spectrum Manta", 35.0, 150.0, 4220.0), ("Polaris Shark", 130.0, 480.0, 14100.0), ("The Dawn Serpent", 650.0, 2300.0, 70500.0)]),
    ("abyss", &[("Moonspeck", 0.02, 0.1, 362.0), ("Meteor Darter", 0.3, 2.0, 905.0), ("Gravity Eel", 12.0, 50.0, 2710.0), ("Quasar Ray", 55.0, 210.0, 6730.0), ("Supernova Leviathan", 220.0, 750.0, 22100.0), ("The First Light", 950.0, 3100.0, 112500.0)]),
];

pub static WORDS: &[(&str, &[&str])] = &[
    ("bay", &["Harbour", "Wharf", "Salt", "Tide", "Lamp", "Mooring", "Brine", "Gull", "Rope", "Quay", "Barnacle", "Sail"]),
    ("marsh", &["Bog", "Fen", "Sedge", "Murk", "Peat", "Bramble", "Toad", "Silt", "Rush", "Moss", "Mire", "Cattail"]),
    ("glacier", &["Frost", "Rime", "Sleet", "Glacier", "Snow", "Hoar", "Floe", "Icicle", "Tundra", "Polar", "Shiver", "Aurora"]),
    ("vents", &["Cinder", "Ash", "Slag", "Flame", "Scoria", "Smoke", "Kiln", "Pumice", "Char", "Sulphur", "Blaze", "Furnace"]),
    ("deep", &["Gloom", "Hollow", "Murmur", "Shade", "Dusk", "Hush", "Pale", "Grave", "Lurk", "Dim", "Wraith", "Sunless"]),
    ("reef", &["Storm", "Thunder", "Volt", "Gale", "Bolt", "Spark", "Squall", "Surge", "Flash", "Static", "Cloud", "Tempest"]),
    ("spire", &["Relic", "Ruin", "Altar", "Crown", "Temple", "Idol", "Marble", "Herald", "Vault", "Column", "Sigil", "Gilded"]),
    ("trench", &["Prism", "Glow", "Lumen", "Halo", "Spectrum", "Shimmer", "Radiant", "Beacon", "Gleam", "Neon", "Opal", "Borealis"]),
    ("abyss", &["Star", "Comet", "Nebula", "Orbit", "Meteor", "Cosmic", "Galaxy", "Lunar", "Solar", "Pulsar", "Zenith", "Nova"]),
    ("mangrove", &["Root", "Tangle", "Knot", "Bark", "Vine", "Thicket", "Canopy", "Sap", "Briar", "Snarl", "Hollowroot", "Ivy"]),
    ("oasis", &["Mirage", "Dune", "Sand", "Palm", "Scarab", "Sunbaked", "Caravan", "Amber", "Date", "Sirocco", "Hazy", "Ochre"]),
    ("kelp", &["Kelp", "Frond", "Arch", "Choir", "Chapel", "Swaying", "Verdant", "Steeple", "Hymn", "Nave", "Cloister", "Wrack"]),
    ("caverns", &["Crystal", "Quartz", "Geode", "Echo", "Stalactite", "Amethyst", "Ringing", "Facet", "Glint", "Shard", "Druse", "Cavern"]),
    ("lotus", &["Lotus", "Petal", "Bloom", "Lily", "Nectar", "Pollen", "Blossom", "Dewdrop", "Orchid", "Sepal", "Fragrant", "Pistil"]),
    ("wreck", &["Rust", "Hull", "Anchor", "Rivet", "Cannon", "Bilge", "Keel", "Plank", "Mast", "Porthole", "Iron", "Salvage"]),
    ("skyfall", &["Sky", "Cirrus", "Updraft", "Feather", "Breeze", "Nimbus", "Soaring", "Zephyr", "Drifting", "Azure", "Vapour", "Highwind"]),
    ("clockwork", &["Cog", "Gear", "Spring", "Ticking", "Brass", "Piston", "Sprocket", "Pendulum", "Wound", "Escapement", "Ratchet", "Dial"]),
    ("caldera", &["Ember", "Magma", "Scorch", "Molten", "Lava", "Basalt", "Sear", "Inferno", "Smoulder", "Pyre", "Fumarole", "Crater"]),
    ("fjord", &["Ghost", "Wisp", "Phantom", "Spectral", "Lantern", "Haunt", "Banshee", "Misty", "Revenant", "Cold", "Ghostlight", "Veil"]),
    ("shoals", &["Sugar", "Candy", "Caramel", "Sherbet", "Toffee", "Gummy", "Frosted", "Licorice", "Honey", "Praline", "Fizz", "Marzipan"]),
    ("mirror", &["Mirror", "Glass", "Reflected", "Silver", "Twin", "Still", "Polished", "Echoed", "Mercury", "Doubled", "Gleaming", "Inverse"]),
    ("rift", &["Dragon", "Bone", "Scale", "Wyrm", "Fang", "Claw", "Rift", "Drake", "Ancient", "Horned", "Marrow", "Ossified"]),
    ("dreamtide", &["Dream", "Slumber", "Lullaby", "Drowsy", "Reverie", "Velvet", "Moonlit", "Sleepy", "Wandering", "Hazy", "Starry", "Yawning"]),
    ("eclipse", &["Eclipse", "Umbra", "Penumbra", "Corona", "Darkened", "Totality", "Blackout", "Shadowed", "Night", "Occult", "Duskfall", "Obscura"]),
];

pub static NOUNS: &[(&str, &[&str])] = &[
    ("common", &["Minnow", "Sprat", "Fry", "Darter", "Guppy", "Tetra", "Smelt", "Goby", "Shiner", "Dace", "Loach", "Chub", "Bleak", "Rasbora", "Killifish", "Molly", "Platy", "Danio", "Barb", "Pupfish"]),
    ("uncommon", &["Perch", "Bream", "Roach", "Carp", "Rudd", "Trout", "Wrasse", "Tang", "Blenny", "Sunfish", "Herring", "Mullet", "Snook", "Grayling", "Whiting", "Sculpin"]),
    ("rare", &["Bass", "Pike", "Snapper", "Gar", "Char", "Cod", "Koi", "Angelfish", "Pufferfish", "Lionfish", "Arowana", "Grouper", "Walleye", "Tilefish"]),
    ("epic", &["Ray", "Eel", "Catfish", "Sturgeon", "Barracuda", "Mahi", "Halibut", "Moray", "Swordfish", "Wahoo", "Paddlefish"]),
    ("legendary", &["Marlin", "Shark", "Manta", "Sailfish", "Coelacanth", "Oarfish", "Tarpon", "Bluefin"]),
    ("mythical", &["Leviathan", "Serpent", "Sovereign", "Colossus", "Matriarch", "Kraken", "Behemoth", "Wyrm", "Monarch", "Titan"]),
];

/// (id, label, emoji, level, blurb, xp multiplier, hardness, corruption chance)
pub static BIOMES: &[(&str, &str, &str, i64, &str, f64, i64, f64)] = &[
    ("bay", "Lantern Bay", "🏮", 1, "Calm harbour water. Everyone starts here.", 1.0, 0, 0.0),
    ("marsh", "Mossmere Marsh", "🌿", 5, "Murky and slow. The big ones hide in the reeds.", 1.0, 0, 0.0),
    ("glacier", "Rimefall Shelf", "🧊", 12, "Freezing water under the ice shelf.", 1.0, 0, 0.0),
    ("vents", "Cinder Vents", "🌋", 20, "Boiling vents on the sea floor. Fast, angry fish.", 1.0, 0, 0.0),
    ("deep", "The Hollow Deep", "🕳️", 30, "Nothing should live down here. Corruption is common.", 1.0, 0, 0.03),
    ("reef", "Stormglass Reef", "⛈️", 40, "A reef of glass lit up by endless lightning.", 1.5, 1, 0.0),
    ("spire", "The Sunken Spire", "🏛️", 55, "A drowned city. Its old guardians still swim the halls.", 2.0, 2, 0.0),
    ("trench", "Aurora Trench", "🌌", 70, "Light that should not exist this deep. Everything here glows.", 2.5, 3, 0.01),
    ("abyss", "Starfall Abyss", "✨", 85, "Where fallen stars sink. Past here, the maps run out.", 3.0, 4, 0.04),
    ("mangrove", "Tanglewood Mangroves", "🌳", 100, "Roots like cages. The fish know every gap.", 4.0, 5, 0.0),
    ("oasis", "Mirage Oasis", "🏜️", 140, "A lake in the desert that should not be there.", 5.0, 5, 0.0),
    ("kelp", "Kelpwood Cathedral", "🪸", 190, "Kelp grown into arches taller than towers.", 6.0, 5, 0.0),
    ("caverns", "Crystal Caverns", "💎", 250, "Underground pools that ring when a fish swims past.", 7.5, 6, 0.0),
    ("lotus", "Lotus Bloom Lake", "🪷", 320, "Flowers the size of boats, and fish that sleep in them.", 9.0, 6, 0.0),
    ("wreck", "Ironwreck Graveyard", "⚓", 400, "A thousand sunken ships. Something lives in every hull.", 11.0, 6, 0.01),
    ("skyfall", "Skyfall Lagoon", "☁️", 500, "Water that falls upward into the clouds.", 13.0, 7, 0.0),
    ("clockwork", "Clockwork Canals", "⚙️", 620, "Canals in a city of gears. The fish tick.", 16.0, 7, 0.0),
    ("caldera", "Emberfall Caldera", "🔥", 760, "A volcano lake that never stops simmering.", 19.0, 7, 0.0),
    ("fjord", "Ghostlight Fjord", "👻", 920, "Pale lights under the ice. Some of them are fish.", 23.0, 8, 0.02),
    ("shoals", "Sugartide Shoals", "🍬", 1100, "Sweet water, bright fish, and teeth you would not expect.", 28.0, 8, 0.0),
    ("mirror", "The Mirror Sea", "🪞", 1350, "Perfectly still. Your reflection fishes back.", 34.0, 8, 0.0),
    ("rift", "Dragonbone Rift", "🐉", 1650, "A crack in the world, lined with ancient bones.", 41.0, 9, 0.02),
    ("dreamtide", "Dreamtide Expanse", "🌙", 2000, "You only find it while half asleep.", 50.0, 9, 0.0),
    ("eclipse", "The Eclipse Sea", "🌑", 2500, "Where the sun goes dark. The end of every map.", 62.0, 10, 0.05),
];

/// (id, label, price, level, luck, control, power, step, line, home places, perk, how it is earned, worth)
pub static RODS: &[RodDef] = &[
    RodDef { id: "driftwood", label: "Driftwood Rod", price: 0, level: 1, luck: 0.0, control: 5, power: 11, step: 2, line: 100, home: &["bay"], perk: "xp", earn: None, worth: 0 },
    RodDef { id: "reedspring", label: "Reedspring Rod", price: 1500, level: 3, luck: 0.1, control: 6, power: 13, step: 2, line: 110, home: &["marsh"], perk: "calm", earn: None, worth: 0 },
    RodDef { id: "carbon", label: "Carbon Striker", price: 8000, level: 8, luck: 0.2, control: 6, power: 15, step: 3, line: 120, home: &["bay", "reef"], perk: "strike", earn: None, worth: 0 },
    RodDef { id: "rimeglass", label: "Rimeglass Rod", price: 25000, level: 14, luck: 0.35, control: 7, power: 17, step: 3, line: 130, home: &["glacier", "fjord"], perk: "tension", earn: None, worth: 0 },
    RodDef { id: "cinderspine", label: "Cinderspine Rod", price: 75000, level: 22, luck: 0.5, control: 7, power: 20, step: 3, line: 140, home: &["vents", "caldera"], perk: "nosnap", earn: None, worth: 0 },
    RodDef { id: "voidreach", label: "Voidreach Rod", price: 250000, level: 32, luck: 0.8, control: 8, power: 24, step: 3, line: 160, home: &["deep", "eclipse"], perk: "corrupt", earn: None, worth: 0 },
    RodDef { id: "stormglass", label: "Stormglass Rod", price: 600000, level: 42, luck: 1.0, control: 8, power: 27, step: 3, line: 175, home: &["reef", "skyfall"], perk: "surge", earn: None, worth: 0 },
    RodDef { id: "spirebone", label: "Spirebone Rod", price: 1500000, level: 58, luck: 1.25, control: 9, power: 30, step: 3, line: 190, home: &["spire", "rift"], perk: "giant", earn: None, worth: 0 },
    RodDef { id: "starforged", label: "Starforged Rod", price: 4000000, level: 75, luck: 1.6, control: 9, power: 34, step: 4, line: 210, home: &["abyss", "trench"], perk: "mutation", earn: None, worth: 0 },
    RodDef { id: "rootbinder", label: "Rootbinder Rod", price: 9000000, level: 100, luck: 1.8, control: 10, power: 38, step: 4, line: 230, home: &["mangrove", "kelp"], perk: "calm", earn: None, worth: 0 },
    RodDef { id: "geode", label: "Geode Rod", price: 20000000, level: 240, luck: 2.0, control: 10, power: 42, step: 4, line: 250, home: &["caverns", "oasis"], perk: "value", earn: None, worth: 0 },
    RodDef { id: "anchorchain", label: "Anchorchain Rod", price: 45000000, level: 390, luck: 2.2, control: 11, power: 46, step: 4, line: 270, home: &["wreck"], perk: "sunken", earn: None, worth: 0 },
    RodDef { id: "mainspring", label: "Mainspring Rod", price: 100000000, level: 600, luck: 2.45, control: 11, power: 50, step: 5, line: 290, home: &["clockwork"], perk: "strike", earn: None, worth: 0 },
    RodDef { id: "wisplight", label: "Wisplight Rod", price: 220000000, level: 900, luck: 2.7, control: 11, power: 54, step: 5, line: 310, home: &["fjord", "lotus"], perk: "xp", earn: None, worth: 0 },
    RodDef { id: "quicksilver", label: "Quicksilver Rod", price: 500000000, level: 1300, luck: 3.0, control: 12, power: 58, step: 5, line: 335, home: &["mirror", "shoals"], perk: "quickbite", earn: None, worth: 0 },
    RodDef { id: "wyrmspine", label: "Wyrmspine Rod", price: 1100000000, level: 1650, luck: 3.3, control: 12, power: 62, step: 5, line: 360, home: &["rift", "dreamtide"], perk: "tamer", earn: None, worth: 0 },
    RodDef { id: "umbral", label: "Umbral Rod", price: 2500000000, level: 2450, luck: 3.7, control: 13, power: 68, step: 5, line: 400, home: &["eclipse"], perk: "surge", earn: None, worth: 0 },
    RodDef { id: "eclipsebreaker", label: "Eclipsebreaker Rod", price: 6000000000, level: 2800, luck: 4.1, control: 13, power: 74, step: 5, line: 440, home: &["eclipse", "dreamtide"], perk: "mutation", earn: None, worth: 0 },
    RodDef { id: "tidecaller", label: "Tidecaller Rod", price: 14000000000, level: 3200, luck: 4.5, control: 14, power: 80, step: 6, line: 480, home: &["mirror", "dreamtide", "shoals"], perk: "quickbite", earn: None, worth: 0 },
    RodDef { id: "worldline", label: "Worldline Rod", price: 32000000000, level: 3600, luck: 4.9, control: 14, power: 86, step: 6, line: 520, home: &["rift", "eclipse"], perk: "tamer", earn: None, worth: 0 },
    RodDef { id: "leviathan", label: "Leviathan's Oath", price: 75000000000, level: 4000, luck: 5.4, control: 15, power: 94, step: 6, line: 580, home: &[], perk: "mythic", earn: None, worth: 0 },
    RodDef { id: "barnacle", label: "Barnacled Rod", price: 0, level: 0, luck: 1.1, control: 9, power: 30, step: 4, line: 190, home: &["wreck", "reef"], perk: "giant", earn: Some(Earn::Sunken(1)), worth: 800000 },
    RodDef { id: "captain", label: "Captain's Rod", price: 0, level: 0, luck: 2.5, control: 11, power: 52, step: 5, line: 300, home: &["wreck", "clockwork"], perk: "value", earn: Some(Earn::Sunken(2)), worth: 150000000 },
    RodDef { id: "drownedking", label: "Drowned King's Rod", price: 0, level: 0, luck: 3.4, control: 13, power: 64, step: 5, line: 380, home: &["wreck", "eclipse", "deep"], perk: "tamer", earn: Some(Earn::Sunken(3)), worth: 1500000000 },
    RodDef { id: "streakline", label: "Streakline Rod", price: 0, level: 0, luck: 0.4, control: 7, power: 17, step: 3, line: 135, home: &[], perk: "xp", earn: Some(Earn::Streak(7)), worth: 30000 },
    RodDef { id: "taskmaster", label: "Taskmaster Rod", price: 0, level: 0, luck: 0.9, control: 8, power: 25, step: 3, line: 165, home: &[], perk: "strike", earn: Some(Earn::Weeklies(10)), worth: 300000 },
    RodDef { id: "grandangler", label: "Grand Angler Rod", price: 0, level: 0, luck: 1.7, control: 9, power: 35, step: 4, line: 215, home: &[], perk: "wanderer", earn: Some(Earn::Streak(30)), worth: 5000000 },
    RodDef { id: "keep-bay", label: "Lantern Bay Keepsake Rod", price: 0, level: 0, luck: 0.0, control: 6, power: 12, step: 2, line: 110, home: &["bay"], perk: "collector", earn: Some(Earn::Collection("bay")), worth: 5000 },
    RodDef { id: "keep-marsh", label: "Mossmere Marsh Keepsake Rod", price: 0, level: 0, luck: 0.1, control: 7, power: 14, step: 2, line: 121, home: &["marsh"], perk: "collector", earn: Some(Earn::Collection("marsh")), worth: 5000 },
    RodDef { id: "keep-glacier", label: "Rimefall Shelf Keepsake Rod", price: 0, level: 0, luck: 0.2, control: 7, power: 17, step: 3, line: 132, home: &["glacier"], perk: "collector", earn: Some(Earn::Collection("glacier")), worth: 8000 },
    RodDef { id: "keep-vents", label: "Cinder Vents Keepsake Rod", price: 0, level: 0, luck: 0.35, control: 8, power: 19, step: 3, line: 143, home: &["vents"], perk: "collector", earn: Some(Earn::Collection("vents")), worth: 25000 },
    RodDef { id: "keep-deep", label: "The Hollow Deep Keepsake Rod", price: 0, level: 0, luck: 0.5, control: 8, power: 22, step: 3, line: 154, home: &["deep"], perk: "collector", earn: Some(Earn::Collection("deep")), worth: 75000 },
    RodDef { id: "keep-reef", label: "Stormglass Reef Keepsake Rod", price: 0, level: 0, luck: 0.8, control: 9, power: 26, step: 3, line: 176, home: &["reef"], perk: "collector", earn: Some(Earn::Collection("reef")), worth: 250000 },
    RodDef { id: "keep-spire", label: "The Sunken Spire Keepsake Rod", price: 0, level: 0, luck: 1.0, control: 9, power: 30, step: 3, line: 193, home: &["spire"], perk: "collector", earn: Some(Earn::Collection("spire")), worth: 600000 },
    RodDef { id: "keep-trench", label: "Aurora Trench Keepsake Rod", price: 0, level: 0, luck: 1.25, control: 10, power: 33, step: 3, line: 209, home: &["trench"], perk: "collector", earn: Some(Earn::Collection("trench")), worth: 1500000 },
    RodDef { id: "keep-abyss", label: "Starfall Abyss Keepsake Rod", price: 0, level: 0, luck: 1.6, control: 10, power: 37, step: 4, line: 231, home: &["abyss"], perk: "collector", earn: Some(Earn::Collection("abyss")), worth: 4000000 },
    RodDef { id: "keep-mangrove", label: "Tanglewood Mangroves Keepsake Rod", price: 0, level: 0, luck: 1.8, control: 11, power: 42, step: 4, line: 253, home: &["mangrove"], perk: "collector", earn: Some(Earn::Collection("mangrove")), worth: 9000000 },
    RodDef { id: "keep-oasis", label: "Mirage Oasis Keepsake Rod", price: 0, level: 0, luck: 1.8, control: 11, power: 42, step: 4, line: 253, home: &["oasis"], perk: "collector", earn: Some(Earn::Collection("oasis")), worth: 9000000 },
    RodDef { id: "keep-kelp", label: "Kelpwood Cathedral Keepsake Rod", price: 0, level: 0, luck: 1.8, control: 11, power: 42, step: 4, line: 253, home: &["kelp"], perk: "collector", earn: Some(Earn::Collection("kelp")), worth: 9000000 },
    RodDef { id: "keep-caverns", label: "Crystal Caverns Keepsake Rod", price: 0, level: 0, luck: 2.0, control: 11, power: 46, step: 4, line: 275, home: &["caverns"], perk: "collector", earn: Some(Earn::Collection("caverns")), worth: 20000000 },
    RodDef { id: "keep-lotus", label: "Lotus Bloom Lake Keepsake Rod", price: 0, level: 0, luck: 2.0, control: 11, power: 46, step: 4, line: 275, home: &["lotus"], perk: "collector", earn: Some(Earn::Collection("lotus")), worth: 20000000 },
    RodDef { id: "keep-wreck", label: "Ironwreck Graveyard Keepsake Rod", price: 0, level: 0, luck: 2.2, control: 12, power: 51, step: 4, line: 297, home: &["wreck"], perk: "collector", earn: Some(Earn::Collection("wreck")), worth: 45000000 },
    RodDef { id: "keep-skyfall", label: "Skyfall Lagoon Keepsake Rod", price: 0, level: 0, luck: 2.2, control: 12, power: 51, step: 4, line: 297, home: &["skyfall"], perk: "collector", earn: Some(Earn::Collection("skyfall")), worth: 45000000 },
    RodDef { id: "keep-clockwork", label: "Clockwork Canals Keepsake Rod", price: 0, level: 0, luck: 2.45, control: 12, power: 55, step: 5, line: 319, home: &["clockwork"], perk: "collector", earn: Some(Earn::Collection("clockwork")), worth: 100000000 },
    RodDef { id: "keep-caldera", label: "Emberfall Caldera Keepsake Rod", price: 0, level: 0, luck: 2.45, control: 12, power: 55, step: 5, line: 319, home: &["caldera"], perk: "collector", earn: Some(Earn::Collection("caldera")), worth: 100000000 },
    RodDef { id: "keep-fjord", label: "Ghostlight Fjord Keepsake Rod", price: 0, level: 0, luck: 2.7, control: 12, power: 59, step: 5, line: 341, home: &["fjord"], perk: "collector", earn: Some(Earn::Collection("fjord")), worth: 220000000 },
    RodDef { id: "keep-shoals", label: "Sugartide Shoals Keepsake Rod", price: 0, level: 0, luck: 2.7, control: 12, power: 59, step: 5, line: 341, home: &["shoals"], perk: "collector", earn: Some(Earn::Collection("shoals")), worth: 220000000 },
    RodDef { id: "keep-mirror", label: "The Mirror Sea Keepsake Rod", price: 0, level: 0, luck: 3.0, control: 13, power: 64, step: 5, line: 369, home: &["mirror"], perk: "collector", earn: Some(Earn::Collection("mirror")), worth: 500000000 },
    RodDef { id: "keep-rift", label: "Dragonbone Rift Keepsake Rod", price: 0, level: 0, luck: 3.3, control: 13, power: 68, step: 5, line: 396, home: &["rift"], perk: "collector", earn: Some(Earn::Collection("rift")), worth: 1100000000 },
    RodDef { id: "keep-dreamtide", label: "Dreamtide Expanse Keepsake Rod", price: 0, level: 0, luck: 3.3, control: 13, power: 68, step: 5, line: 396, home: &["dreamtide"], perk: "collector", earn: Some(Earn::Collection("dreamtide")), worth: 1100000000 },
    RodDef { id: "keep-eclipse", label: "The Eclipse Sea Keepsake Rod", price: 0, level: 0, luck: 3.7, control: 14, power: 75, step: 5, line: 440, home: &["eclipse"], perk: "collector", earn: Some(Earn::Collection("eclipse")), worth: 2500000000 },
];

/// (id, label, price, luck, corruption)
pub static BAITS: &[(&str, &str, i64, f64, f64)] = &[
    ("none", "No bait", 0, 0.0, 0.0),
    ("worm", "Earthworm", 5, 0.05, 0.0),
    ("shrimp", "Glass Shrimp", 25, 0.15, 0.0),
    ("glowgrub", "Glowgrub", 120, 0.35, 0.0),
    ("voidlure", "Void Lure", 400, 0.2, 0.03),
    ("stormfly", "Stormfly", 900, 0.5, 0.0),
    ("starlure", "Starlure", 2500, 0.6, 0.03),
    ("dreamworm", "Dreamworm", 12000, 0.8, 0.0),
    ("umbralure", "Umbral Lure", 40000, 1.0, 0.04),
];

/// (id, label, price, description, tension multiplier, calm, bonus, mutation multiplier)
pub static TACKLE: &[(&str, &str, i64, &str, f64, i64, i64, f64)] = &[
    ("none", "No tackle", 0, "Nothing fitted", 1.0, 0, 0, 1.0),
    ("leader", "Steel Leader", 4000, "Line tension builds 40% slower", 0.6, 0, 0, 1.0),
    ("sinker", "Lead Sinker", 6000, "Fish dart around less", 1.0, 1, 0, 1.0),
    ("spinner", "Brass Spinner", 10000, "+4 catch on every good reel", 1.0, 0, 4, 1.0),
    ("charm", "Four-Leaf Charm", 20000, "Mutations twice as likely", 1.0, 0, 0, 2.0),
];

