/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * The 3.1 arcade games as plain functions (no Discord objects), so they can be tested directly:
 *   Tower    climb 8 floors, 3 doors each, one hides a trap; cash out any time
 *   Wires    5 wires, one is the bomb; every safe cut pays more; cash out any time
 *   Bingo    a 3x3 card from 1-20, up to 10 draws; a line sooner pays more
 *   Trivia   one question, 4 answers, 20 seconds (categories, one of them anime)
 *   Hangman  guess the word, 6 wrong guesses allowed
 *   Memory   16 cards, 8 pairs; fewer mistakes pay more
 * Luck games pay a little under fair odds (about 95-97% back on average), like any casino. Skill games pay for skill.
 * `rand` is always a function returning [0, 1), so tests can fix it.
 */

const shuffle = (list, rand) => { const a = [...list]; for (let k = a.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [a[k], a[j]] = [a[j], a[k]]; } return a; };
const round2 = (n) => Math.round(n * 100) / 100;

// ------------------------------------------------------------------ Tower
export const TOWER_FLOORS = 8, TOWER_DOORS = 3;
/** What cashing out pays after `floor` safe floors (a 2-in-3 chance each, so 1.5x is fair; this pays 1.45x). */
export const towerMultiplier = (floor) => round2(1.45 ** floor);
export function towerStart(rand) { return { floor: 0, traps: Array.from({ length: TOWER_FLOORS }, () => Math.floor(rand() * TOWER_DOORS)), status: 'climbing', picks: [] }; }
/** Picks a door on the current floor. */
export function towerPick(s, door) {
  if (s.status !== 'climbing') return s;
  s.picks.push(door);
  if (door === s.traps[s.floor]) { s.status = 'trapped'; return s; }
  s.floor += 1;
  if (s.floor >= TOWER_FLOORS) s.status = 'top';
  return s;
}

// ------------------------------------------------------------------ Wires
export const WIRES = ['🔴', '🔵', '🟢', '🟡', '🟣'];
/** Pays after `cut` safe cuts out of 5 wires with one bomb (fair is 5/(5-cut); this pays 96% of that). */
export const wiresMultiplier = (cut) => (cut <= 0 ? 1 : round2((WIRES.length / (WIRES.length - cut)) * 0.96));
export function wiresStart(rand) { return { bomb: Math.floor(rand() * WIRES.length), cut: [], status: 'cutting' }; }
export function wiresCut(s, wire) {
  if (s.status !== 'cutting' || s.cut.includes(wire)) return s;
  s.cut.push(wire);
  if (wire === s.bomb) s.status = 'boom';
  else if (s.cut.length >= WIRES.length - 1) s.status = 'cleared';
  return s;
}

// ------------------------------------------------------------------ Bingo
export const BINGO_POOL = 20, BINGO_DRAWS = 10;
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
/** Pays by the draw that finished the first line (worked out by simulation: about 95% back on average). */
export const bingoMultiplier = (drawsUsed) => (drawsUsed <= 0 ? 0 : drawsUsed <= 5 ? 4 : drawsUsed <= 7 ? 2 : drawsUsed <= BINGO_DRAWS ? 1.1 : 0);
export function bingoStart(rand) {
  const nums = Array.from({ length: BINGO_POOL }, (_, k) => k + 1);
  return { card: shuffle(nums, rand).slice(0, 9), order: shuffle(nums, rand).slice(0, BINGO_DRAWS), drawn: 0, status: 'drawing' };
}
export const bingoMarked = (s) => s.card.map((n) => s.order.slice(0, s.drawn).includes(n));
export function bingoDraw(s) {
  if (s.status !== 'drawing') return s;
  s.drawn += 1;
  const m = bingoMarked(s);
  if (LINES.some((l) => l.every((k) => m[k]))) s.status = 'bingo';
  else if (s.drawn >= BINGO_DRAWS) s.status = 'out';
  return s;
}

// ------------------------------------------------------------------ Memory
export const MEMORY_FACES = ['🐶', '🐱', '🦊', '🐸', '🐙', '🦋', '🍕', '⭐'];
/** Pays by mistakes (pairs flipped that didn't match). Perfect luck needs 0; a good memory about 6-10. */
export const memoryMultiplier = (mistakes) => (mistakes <= 6 ? 2 : mistakes <= 10 ? 1.4 : mistakes <= 14 ? 1 : 0);
export function memoryStart(rand) { return { cards: shuffle([...MEMORY_FACES, ...MEMORY_FACES], rand), found: [], open: [], mistakes: 0, status: 'playing' }; }
/** Flips a card. Two open cards that don't match turn back over on the next flip. */
export function memoryFlip(s, k) {
  if (s.status !== 'playing' || s.found.includes(k) || k < 0 || k >= s.cards.length) return s;
  if (s.open.length === 2) s.open = []; // a wrong pair turns back over first, so either card can be picked again
  if (s.open.includes(k)) return s;
  s.open.push(k);
  if (s.open.length === 2) {
    const [a, b] = s.open;
    if (s.cards[a] === s.cards[b]) { s.found.push(a, b); s.open = []; if (s.found.length === s.cards.length) s.status = 'done'; } else s.mistakes += 1;
  }
  return s;
}

// ------------------------------------------------------------------ Hangman
export const HANGMAN_LIVES = 6;
export const HANGMAN_WORDS = ['puppy', 'biscuit', 'treasure', 'lantern', 'galaxy', 'volcano', 'penguin', 'thunder', 'pyramid', 'compass', 'blanket', 'pancake', 'dolphin', 'rainbow', 'kingdom',
  'castle', 'dragon', 'wizard', 'island', 'jungle', 'rocket', 'planet', 'garden', 'mirror', 'candle', 'whistle', 'harbour', 'meadow', 'glacier', 'tornado', 'cactus', 'octopus', 'hamster',
  'giraffe', 'kangaroo', 'squirrel', 'blizzard', 'firework', 'keyboard', 'headphones', 'backpack', 'skateboard', 'sandwich', 'popcorn', 'pretzel', 'cupcake', 'avocado', 'pineapple',
  'notebook', 'umbrella', 'snowflake', 'campfire', 'lighthouse', 'waterfall', 'telescope', 'microscope', 'satellite', 'submarine', 'helicopter', 'adventure', 'mystery', 'puzzle', 'pirate',
  'knight', 'goblin', 'phoenix', 'unicorn', 'mermaid', 'vampire', 'zombie', 'robot', 'spaceship', 'meteor', 'comet', 'nebula', 'eclipse', 'horizon', 'sunrise', 'midnight', 'library',
  'museum', 'carnival', 'festival', 'orchestra', 'guitar', 'trumpet', 'violin', 'drummer', 'painter', 'sculpture', 'diamond', 'emerald', 'sapphire', 'crystal', 'marble', 'velvet', 'cookie'];
export function hangmanStart(rand) { return { word: HANGMAN_WORDS[Math.floor(rand() * HANGMAN_WORDS.length)], guessed: [], wrong: 0, status: 'guessing' }; }
export const hangmanShown = (s) => [...s.word].map((c) => (s.guessed.includes(c) || s.status !== 'guessing' ? c.toUpperCase() : '_')).join(' ');
/** Pays more for fewer wrong guesses. */
export const hangmanMultiplier = (wrong) => round2(1.3 + (HANGMAN_LIVES - wrong) * 0.15);
/** A letter, or a guess at the whole word (a wrong word costs 2 lives). Returns { s, note }. */
export function hangmanGuess(s, raw) {
  const g = String(raw ?? '').trim().toLowerCase();
  if (s.status !== 'guessing') return { s, note: null };
  if (!/^[a-z]+$/.test(g)) return { s, note: 'Use letters only.' };
  if (g.length > 1) {
    if (g === s.word) { s.status = 'won'; return { s, note: 'You got the word!' }; }
    s.wrong = Math.min(HANGMAN_LIVES, s.wrong + 2);
    if (s.wrong >= HANGMAN_LIVES) s.status = 'lost';
    return { s, note: `It isn't "${g}".` };
  }
  if (s.guessed.includes(g)) return { s, note: `You already tried ${g.toUpperCase()}.` };
  s.guessed.push(g);
  if (!s.word.includes(g)) { s.wrong += 1; if (s.wrong >= HANGMAN_LIVES) s.status = 'lost'; return { s, note: `No ${g.toUpperCase()}.` }; }
  if ([...s.word].every((c) => s.guessed.includes(c))) s.status = 'won';
  return { s, note: `Yes, there's ${s.word.split(g).length - 1 > 1 ? 'some' : 'an'} ${g.toUpperCase()}!` };
}
export const HANGMAN_ART = [
  '  +---+\n      |\n      |\n      |\n     ===', '  +---+\n  O   |\n      |\n      |\n     ===', '  +---+\n  O   |\n  |   |\n      |\n     ===',
  '  +---+\n  O   |\n /|   |\n      |\n     ===', '  +---+\n  O   |\n /|\\  |\n      |\n     ===', '  +---+\n  O   |\n /|\\  |\n /    |\n     ===', '  +---+\n  O   |\n /|\\  |\n / \\  |\n     ==='];

// ------------------------------------------------------------------ Trivia
export const TRIVIA_MS = 20000;
export const TRIVIA_PAYOUT = 1.7;
/** [question, right answer, three wrong answers]. Written for Good Boy. */
export const TRIVIA = {
  general: [
    ['How many days are in a leap year?', '366', '365', '364', '360'],
    ['How many sides does a hexagon have?', '6', '5', '7', '8'],
    ['What colour do you get by mixing blue and yellow?', 'Green', 'Purple', 'Orange', 'Brown'],
    ['How many minutes are in a day?', '1,440', '1,240', '1,600', '960'],
    ['Which month has the fewest days?', 'February', 'April', 'June', 'November'],
    ['How many strings does a standard guitar have?', '6', '4', '5', '8'],
    ['What is the largest ocean on Earth?', 'Pacific Ocean', 'Atlantic Ocean', 'Indian Ocean', 'Arctic Ocean'],
    ['How many players are on the field for one football (soccer) team?', '11', '10', '9', '12'],
    ['Which shape has three sides?', 'Triangle', 'Square', 'Pentagon', 'Circle'],
    ['What is 12 times 12?', '144', '124', '132', '156'],
    ['How many continents are there?', '7', '5', '6', '8'],
    ['Which is the tallest animal in the world?', 'Giraffe', 'Elephant', 'Camel', 'Moose'],
    ['How many hours are in a week?', '168', '144', '172', '160'],
    ['Which instrument has 88 keys?', 'Piano', 'Organ', 'Accordion', 'Harp'],
    ['What do bees make?', 'Honey', 'Milk', 'Silk', 'Wax only'],
    ['How many zeros are in one million?', '6', '5', '7', '9'],
  ],
  science: [
    ['What planet is known as the Red Planet?', 'Mars', 'Venus', 'Jupiter', 'Mercury'],
    ['What gas do plants take in from the air?', 'Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium'],
    ['What is the chemical symbol for gold?', 'Au', 'Ag', 'Gd', 'Go'],
    ['Which planet is the largest in our solar system?', 'Jupiter', 'Saturn', 'Neptune', 'Earth'],
    ['What is H2O better known as?', 'Water', 'Salt', 'Hydrogen', 'Ice cream'],
    ['How many bones are in an adult human body?', '206', '186', '226', '306'],
    ['What is the closest star to Earth?', 'The Sun', 'Proxima Centauri', 'Sirius', 'Polaris'],
    ['At what temperature does water boil at sea level?', '100 °C', '90 °C', '80 °C', '120 °C'],
    ['Which organ pumps blood around the body?', 'Heart', 'Lungs', 'Liver', 'Kidneys'],
    ['What is the hardest natural substance?', 'Diamond', 'Gold', 'Iron', 'Quartz'],
    ['Which planet has the most famous rings?', 'Saturn', 'Mars', 'Venus', 'Mercury'],
    ['What do we call animals that eat only plants?', 'Herbivores', 'Carnivores', 'Omnivores', 'Insectivores'],
    ['What is the chemical symbol for sodium?', 'Na', 'So', 'Sd', 'S'],
    ['How many legs does a spider have?', '8', '6', '10', '12'],
    ['What force keeps us on the ground?', 'Gravity', 'Magnetism', 'Friction', 'Wind'],
  ],
  geography: [
    ['What is the capital of France?', 'Paris', 'Lyon', 'Marseille', 'Nice'],
    ['What is the capital of Japan?', 'Tokyo', 'Kyoto', 'Osaka', 'Sapporo'],
    ['Which is the longest river in Africa?', 'Nile', 'Congo', 'Niger', 'Zambezi'],
    ['What is the capital of Australia?', 'Canberra', 'Sydney', 'Melbourne', 'Perth'],
    ['Which country is shaped like a boot?', 'Italy', 'Spain', 'Greece', 'Portugal'],
    ['What is the largest country by area?', 'Russia', 'Canada', 'China', 'United States'],
    ['Mount Everest is in which mountain range?', 'Himalayas', 'Andes', 'Alps', 'Rockies'],
    ['What is the capital of Canada?', 'Ottawa', 'Toronto', 'Vancouver', 'Montreal'],
    ['Which desert is the largest hot desert in the world?', 'Sahara', 'Gobi', 'Kalahari', 'Atacama'],
    ['What is the capital of Spain?', 'Madrid', 'Barcelona', 'Seville', 'Valencia'],
    ['Which country has the city of Rio de Janeiro?', 'Brazil', 'Argentina', 'Portugal', 'Mexico'],
    ['What is the capital of Egypt?', 'Cairo', 'Alexandria', 'Giza', 'Luxor'],
    ['Which US state is made up of islands in the Pacific?', 'Hawaii', 'Alaska', 'Florida', 'California'],
    ['What is the smallest country in the world?', 'Vatican City', 'Monaco', 'San Marino', 'Malta'],
  ],
  games: [
    ['In Minecraft, what do you need to make a Nether portal?', 'Obsidian', 'Bedrock', 'Glass', 'Netherrack'],
    ['What colour is the ghost Blinky in Pac-Man?', 'Red', 'Pink', 'Blue', 'Orange'],
    ['In Minecraft, what explodes with a hiss?', 'Creeper', 'Zombie', 'Skeleton', 'Enderman'],
    ['What is the best-selling video game of all time?', 'Minecraft', 'Tetris', 'GTA V', 'Wii Sports'],
    ['In Tetris, how many blocks make up each piece?', '4', '3', '5', '6'],
    ['What company makes the PlayStation?', 'Sony', 'Nintendo', 'Microsoft', 'Sega'],
    ['In Among Us, what is the bad player called?', 'Impostor', 'Traitor', 'Spy', 'Hunter'],
    ['What is the name of the princess Mario often rescues?', 'Peach', 'Daisy', 'Zelda', 'Rosalina'],
    ['In The Legend of Zelda, what is the hero usually called?', 'Link', 'Zelda', 'Ganon', 'Epona'],
    ['Which game has a battle bus?', 'Fortnite', 'Apex Legends', 'PUBG', 'Overwatch'],
    ['What is Sonic the Hedgehog\'s colour?', 'Blue', 'Red', 'Green', 'Yellow'],
    ['In Minecraft, which mob drops ender pearls?', 'Enderman', 'Blaze', 'Ghast', 'Creeper'],
    ['Roblox players call the in-game money what?', 'Robux', 'Bloxbucks', 'Coins', 'V-Bucks'],
  ],
  anime: [
    ['In Naruto, what village is Naruto from?', 'Hidden Leaf (Konoha)', 'Hidden Sand', 'Hidden Mist', 'Hidden Cloud'],
    ['What is the name of Luffy\'s crew in One Piece?', 'Straw Hat Pirates', 'Red Hair Pirates', 'Heart Pirates', 'Whitebeard Pirates'],
    ['Which anime has the Survey Corps fighting Titans?', 'Attack on Titan', 'Demon Slayer', 'Bleach', 'Fullmetal Alchemist'],
    ['In Death Note, which Shinigami drops the notebook?', 'Ryuk', 'Rem', 'Sidoh', 'Gelus'],
    ['What is Goku\'s Saiyan birth name in Dragon Ball?', 'Kakarot', 'Raditz', 'Bardock', 'Tarble'],
    ['In Demon Slayer, what is Tanjiro\'s sister called?', 'Nezuko', 'Kanao', 'Shinobu', 'Mitsuri'],
    ['In My Hero Academia, what is Deku\'s Quirk called?', 'One For All', 'All For One', 'Explosion', 'Half-Cold Half-Hot'],
    ['What do the Elric brothers practise in Fullmetal Alchemist?', 'Alchemy', 'Magic', 'Ninjutsu', 'Swordplay'],
    ['In Spirited Away, what is the name of the girl who works at the bathhouse?', 'Chihiro', 'Kiki', 'Sophie', 'Satsuki'],
    ['In Jujutsu Kaisen, who is the main character?', 'Yuji Itadori', 'Megumi Fushiguro', 'Satoru Gojo', 'Nobara Kugisaki'],
    ['Which Studio Ghibli film features a giant furry forest spirit?', 'My Neighbor Totoro', 'Princess Mononoke', 'Ponyo', 'Howl\'s Moving Castle'],
    ['In One Piece, what does Luffy want to become?', 'King of the Pirates', 'A Marine Admiral', 'The greatest swordsman', 'A doctor'],
    ['In Hunter x Hunter, what is Gon searching for?', 'His father', 'A treasure', 'His brother', 'A lost city'],
    ['In Sailor Moon, what is Usagi\'s cat called?', 'Luna', 'Artemis', 'Diana', 'Jiji'],
    ['What is the name of the pirate swordsman who uses three swords in One Piece?', 'Zoro', 'Sanji', 'Usopp', 'Brook'],
  ],
};
export const TRIVIA_CATEGORIES = { any: '🎲 Anything', general: '💡 General', science: '🔬 Science', geography: '🌍 Geography', games: '🎮 Games', anime: '🌸 Anime' };
/** A question with its answers shuffled. Returns { cat, q, answers, right }. */
export function triviaPick(cat = 'any', rand = Math.random) {
  const cats = cat in TRIVIA ? [cat] : Object.keys(TRIVIA);
  const c = cats[Math.floor(rand() * cats.length)];
  const [q, right, ...wrong] = TRIVIA[c][Math.floor(rand() * TRIVIA[c].length)];
  const answers = shuffle([right, ...wrong], rand);
  return { cat: c, q, answers, right: answers.indexOf(right) };
}

// ------------------------------------------------------------------ /fun
export const EIGHT_BALL = ['It is certain.', 'Without a doubt.', 'Yes, definitely.', 'You may rely on it.', 'As I see it, yes.', 'Most likely.', 'Outlook good.', 'Yes.', 'Signs point to yes.',
  'Reply hazy, try again.', 'Ask again later.', 'Better not tell you now.', 'Cannot predict now.', 'Concentrate and ask again.',
  "Don't count on it.", 'My reply is no.', 'My sources say no.', 'Outlook not so good.', 'Very doubtful.', 'Woof. (That means no.)'];
export const TOPICS = ['What is a skill you wish you had?', 'What was the best thing that happened to you this week?', 'If you could live in any fictional world, which would it be?',
  'What is your favourite comfort food?', 'What game have you played the most hours of?', 'What is a hobby you would like to try?', 'If you had a pet dragon, what would you name it?',
  'What is the best movie you have seen this year?', 'Mountains or beach?', 'What song is stuck in your head right now?', 'What is your go-to snack when gaming?',
  'If you could have any superpower, what would you pick?', 'What is something small that always makes your day better?', 'What was your favourite cartoon as a kid?',
  'Would you rather explore space or the deep ocean?', 'What is the most useless talent you have?', 'Cats, dogs, or something weirder?', 'What would your perfect day look like?',
  'What is an underrated game everyone should try?', 'If you could instantly learn a language, which one?', 'What is the best gift you have ever received?', 'Morning person or night owl?',
  'What is a food you could eat every day?', 'If you could meet any historical figure, who would it be?', 'What is your favourite season and why?', 'What app do you use the most?',
  'What would you do with a free day and no responsibilities?', 'What is the last thing that made you laugh out loud?', 'Which emoji do you use the most?', 'What is your dream holiday destination?'];
/** A love-match percentage that is always the same for the same two people. */
export function shipPercent(a, b) {
  const [x, y] = [String(a), String(b)].sort();
  let h = 2166136261; for (const ch of `${x}:${y}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 101;
}
export const shipName = (a, b) => `${String(a).slice(0, Math.ceil(String(a).length / 2))}${String(b).slice(Math.floor(String(b).length / 2))}`;
/** Rolls `count` dice with `sides` sides. */
export const rollDice = (count, sides, rand = Math.random) => Array.from({ length: count }, () => 1 + Math.floor(rand() * sides));
