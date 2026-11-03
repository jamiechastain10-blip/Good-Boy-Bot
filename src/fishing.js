/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Fishing as plain functions: the world (biomes, fish, rods, bait, tackle), what bites, and the reeling mini-game.
 *
 * The mini-game is driven by button presses only. Each press is one "step": the fish moves (from a seeded random
 * generator, so a step always plays out the same way), then the step is scored. Nothing runs on a timer, which is
 * what makes it safe across hot reloads and restarts: the whole game is the small state object saved after every
 * press. (A timer that edits the message on its own would also hit Discord's message edit limit within seconds.)
 *
 *   [░░░░■■■■◈■░░░░░░░░░░]   ■ = your catch zone, ◆ = the fish (◈ when it is inside your zone)
 *   ◀ Pull / ▶ Pull : move the zone (a small catch gain if the fish is inside afterwards)
 *   🎣 Reel         : big catch gain if the fish is inside the zone, but builds line tension; reeling while the
 *                     fish is outside builds tension fast and loses ground
 *   Catch reaches 100% -> caught.  Catch drops to 0% -> it got away.  Tension reaches the rod's limit -> line snaps.
 */

export const TRACK = 20;
export const IDLE_MS = 45000;
export const MAX_STEPS = 80;

export const RARITIES = [
  { id: 'common', label: 'Common', color: 0x95a5a6, weight: 55, xp: 10, escape: 5, agility: 1, pull: 0 },
  { id: 'uncommon', label: 'Uncommon', color: 0x2ecc71, weight: 25, xp: 20, escape: 6, agility: 1, pull: 2 },
  { id: 'rare', label: 'Rare', color: 0x3498db, weight: 12, xp: 45, escape: 8, agility: 2, pull: 4 },
  { id: 'epic', label: 'Epic', color: 0x9b59b6, weight: 5.5, xp: 100, escape: 10, agility: 2, pull: 7 },
  { id: 'legendary', label: 'Legendary', color: 0xf1c40f, weight: 2, xp: 250, escape: 12, agility: 3, pull: 10 },
  { id: 'mythical', label: 'Mythical', color: 0xe91e63, weight: 0.5, xp: 600, escape: 14, agility: 4, pull: 14 },
];
export const MUTATIONS = {
  mutated: { label: 'Mutated', emoji: '🧬', chance: 0.02, value: 2.5, weight: 1.3 },
  corrupted: { label: 'Corrupted', emoji: '🕳️', chance: 0.004, value: 5, weight: 1 },
};

// name, [min kg, max kg], base value (coins at average weight). One fish per rarity per biome (and MORE_SPECIES below).
const SPECIES = {
  bay: [['Pier Minnow', 0.05, 0.3, 8], ['Lantern Perch', 0.3, 1.5, 20], ['Harbor Bass', 1, 6, 60], ['Copperfin Snapper', 3, 12, 150], ['Lighthouse Pike', 8, 30, 500], ['Old Beacon', 40, 120, 2500]],
  marsh: [['Mud Loach', 0.1, 0.5, 13], ['Reed Carp', 0.5, 4, 32], ['Bogscale Gar', 2, 9, 95], ['Willowhisker Catfish', 5, 20, 240], ['Moss Sturgeon', 15, 60, 800], ['The Marsh Warden', 80, 220, 4000]],
  glacier: [['Frostling', 0.1, 0.4, 20], ['Icefin Char', 0.6, 3, 50], ['Shelf Cod', 3, 14, 150], ['Aurora Trout', 4, 16, 375], ['Glacial Halibut', 30, 110, 1250], ['Rimewyrm Eel', 60, 300, 6250]],
  vents: [['Ashfry', 0.05, 0.3, 32], ['Ember Goby', 0.3, 2, 80], ['Magma Wrasse', 2, 10, 240], ['Obsidian Ray', 10, 45, 600], ['Scorchjaw Grouper', 40, 150, 2000], ['Heartfire Leviathan', 200, 600, 10000]],
  deep: [['Gloom Shrimpfish', 0.05, 0.2, 56], ['Hollow Eye', 0.5, 3, 140], ['Lantern Angler', 3, 15, 420], ['Abyssal Gulper', 15, 70, 1050], ['Void Cuttle', 50, 200, 3500], ['The Unnamed', 300, 1200, 17500]],
  // 2.3.3 expansion: four late-game places.
  reef: [['Glint Sprat', 0.05, 0.3, 90], ['Voltfin Tang', 0.4, 2.5, 220], ['Thunderhead Snapper', 4, 18, 650], ['Squall Manta', 20, 90, 1650], ['Stormcaller Marlin', 80, 300, 5500], ['The Tempest', 400, 1500, 27500]],
  spire: [['Moss Pebblefish', 0.1, 0.5, 140], ['Relic Carp', 1, 6, 350], ['Gilded Arowana', 4, 20, 1050], ['Sentinel Gar', 25, 110, 2650], ['Crowned Coelacanth', 90, 350, 8800], ['The Drowned King', 500, 1800, 44000]],
  trench: [['Glowmote', 0.02, 0.15, 225], ['Prism Jelly', 0.5, 4, 560], ['Lumen Ray', 6, 30, 1700], ['Aurora Serpent', 30, 140, 4200], ['Veilshark', 120, 450, 14000], ['The Northern Light', 600, 2200, 70000]],
  abyss: [['Stardust Minnow', 0.02, 0.1, 360], ['Comet Tetra', 0.3, 2, 900], ['Nebula Grouper', 10, 45, 2700], ['Void Leviathan Pup', 50, 200, 6700], ['Eclipse Kraken', 200, 700, 22000], ['The Last Star', 900, 3000, 112000]],
};

export const BIOMES = [
  { id: 'bay', label: 'Lantern Bay', emoji: '🏮', level: 1, blurb: 'Calm harbour water. Everyone starts here.' },
  { id: 'marsh', label: 'Mossmere Marsh', emoji: '🌿', level: 5, blurb: 'Murky and slow. The big ones hide in the reeds.' },
  { id: 'glacier', label: 'Rimefall Shelf', emoji: '🧊', level: 12, blurb: 'Freezing water under the ice shelf.' },
  { id: 'vents', label: 'Cinder Vents', emoji: '🌋', level: 20, blurb: 'Boiling vents on the sea floor. Fast, angry fish.' },
  { id: 'deep', label: 'The Hollow Deep', emoji: '🕳️', level: 30, blurb: 'Nothing should live down here. Corruption is common.', corruption: 0.03 },
  // xp = XP multiplier for every catch here; hard = how much harder the fish fight (faster, pull harder, escape
  // faster). Later places pay more XP to make up for the steeper levels past 32.
  { id: 'reef', label: 'Stormglass Reef', emoji: '⛈️', level: 40, blurb: 'A reef of glass lit up by endless lightning.', xp: 1.5, hard: 1 },
  { id: 'spire', label: 'The Sunken Spire', emoji: '🏛️', level: 55, blurb: 'A drowned city. Its old guardians still swim the halls.', xp: 2, hard: 2 },
  { id: 'trench', label: 'Aurora Trench', emoji: '🌌', level: 70, blurb: 'Light that should not exist this deep. Everything here glows.', xp: 2.5, hard: 3, corruption: 0.01 },
  { id: 'abyss', label: 'Starfall Abyss', emoji: '✨', level: 85, blurb: 'Where fallen stars sink. The last place anyone has fished.', xp: 3, hard: 4, corruption: 0.04 },
];

// 2.3.3: a second fish of every rarity in every place (ids continue at -6 so saved catches keep their ids).
const MORE_SPECIES = {
  bay: [['Dock Sprat', 0.05, 0.25, 9], ['Rope Eel', 0.4, 2, 22], ['Buoy Bream', 1, 5, 65], ['Anchor Flounder', 4, 14, 160], ['Harbourmaster Tuna', 10, 40, 520], ['The Fogbell', 50, 150, 2600]],
  marsh: [['Peat Tadfish', 0.1, 0.4, 14], ['Lily Pike', 0.5, 3, 34], ['Frogmouth Bass', 2, 8, 100], ['Mirewing Ray', 6, 22, 250], ['Bogwitch Eel', 20, 70, 820], ['The Willow Ghost', 90, 250, 4100]],
  glacier: [['Snowdrop Smelt', 0.1, 0.35, 21], ['Crystal Shrimpfish', 0.5, 2.5, 52], ['Frostbite Pollock', 3, 12, 155], ['Tusked Iceling', 5, 18, 380], ['Polar Sturgeon', 35, 120, 1300], ['The Frozen Heart', 80, 320, 6400]],
  vents: [['Sootling', 0.05, 0.25, 33], ['Flare Tetra', 0.3, 1.8, 82], ['Basalt Pufferfish', 2, 9, 245], ['Lava Lamprey', 8, 40, 610], ['Pyroclast Shark', 50, 170, 2050], ['The Molten Crown', 250, 700, 10200]],
  deep: [['Hush Fry', 0.05, 0.2, 57], ['Pale Drifter', 0.5, 2.8, 142], ['Needle Viperfish', 3, 14, 425], ['Silent Siphon', 15, 65, 1060], ['Hollow Mantle', 60, 220, 3550], ['The Whisper Below', 350, 1300, 17800]],
  reef: [['Spark Minnow', 0.05, 0.3, 92], ['Static Eel', 0.5, 3, 222], ['Galecrest Wrasse', 4, 16, 655], ['Thunder Ray', 22, 95, 1670], ['Squallbreaker Sailfish', 90, 320, 5550], ['The Eye of the Storm', 450, 1600, 27800]],
  spire: [['Altar Tetra', 0.1, 0.5, 142], ['Mosaic Koi', 1, 5, 352], ['Pillar Grouper', 5, 22, 1060], ['Gargoyle Ray', 28, 120, 2670], ['Throne Sturgeon', 100, 380, 8850], ['The Sunken Oracle', 550, 1900, 44300]],
  trench: [['Shimmer Fry', 0.02, 0.15, 226], ['Halo Squidling', 0.5, 3.5, 562], ['Borealis Eel', 7, 32, 1710], ['Spectrum Manta', 35, 150, 4220], ['Polaris Shark', 130, 480, 14100], ['The Dawn Serpent', 650, 2300, 70500]],
  abyss: [['Moonspeck', 0.02, 0.1, 362], ['Meteor Darter', 0.3, 2, 905], ['Gravity Eel', 12, 50, 2710], ['Quasar Ray', 55, 210, 6730], ['Supernova Leviathan', 220, 750, 22100], ['The First Light', 950, 3100, 112500]],
};

export const FISH = Object.fromEntries([[SPECIES, 0], [MORE_SPECIES, 6]].flatMap(([table, offset]) => Object.entries(table).flatMap(([biome, list]) => list.map(([name, min, max, base], k) => {
  const id = `${biome}-${k + offset}`;
  return [id, { id, name, biome, rarity: RARITIES[k].id, min, max, base }];
}))));
/** The fish of one place, in rarity order (first and second fish of each rarity side by side). */
export const fishIn = (biome) => Object.values(FISH).filter((f) => f.biome === biome)
  .sort((a, b) => RARITIES.findIndex((r) => r.id === a.rarity) - RARITIES.findIndex((r) => r.id === b.rarity) || Number(a.id.split('-')[1]) - Number(b.id.split('-')[1]));

// Rods: luck shifts rarity odds, control = zone width, power = catch gain per good reel, step = how far a pull moves
// the zone, line = tension before the line snaps.
export const RODS = [
  { id: 'driftwood', label: 'Driftwood Rod', price: 0, level: 1, luck: 0, control: 5, power: 11, step: 2, line: 100 },
  { id: 'reedspring', label: 'Reedspring Rod', price: 1500, level: 3, luck: 0.1, control: 6, power: 13, step: 2, line: 110 },
  { id: 'carbon', label: 'Carbon Striker', price: 8000, level: 8, luck: 0.2, control: 6, power: 15, step: 3, line: 120 },
  { id: 'rimeglass', label: 'Rimeglass Rod', price: 25000, level: 14, luck: 0.35, control: 7, power: 17, step: 3, line: 130 },
  { id: 'cinderspine', label: 'Cinderspine Rod', price: 75000, level: 22, luck: 0.5, control: 7, power: 20, step: 3, line: 140 },
  { id: 'voidreach', label: 'Voidreach Rod', price: 250000, level: 32, luck: 0.8, control: 8, power: 24, step: 3, line: 160 },
  { id: 'stormglass', label: 'Stormglass Rod', price: 600000, level: 42, luck: 1.0, control: 8, power: 27, step: 3, line: 175 },
  { id: 'spirebone', label: 'Spirebone Rod', price: 1500000, level: 58, luck: 1.25, control: 9, power: 30, step: 3, line: 190 },
  { id: 'starforged', label: 'Starforged Rod', price: 4000000, level: 75, luck: 1.6, control: 9, power: 34, step: 4, line: 210 },
];
// Bait is used up, one per cast.
export const BAITS = [
  { id: 'none', label: 'No bait', price: 0, luck: 0 },
  { id: 'worm', label: 'Earthworm', price: 5, luck: 0.05 },
  { id: 'shrimp', label: 'Glass Shrimp', price: 25, luck: 0.15 },
  { id: 'glowgrub', label: 'Glowgrub', price: 120, luck: 0.35 },
  { id: 'voidlure', label: 'Void Lure', price: 400, luck: 0.2, corruption: 0.03 },
  { id: 'stormfly', label: 'Stormfly', price: 900, luck: 0.5 },
  { id: 'starlure', label: 'Starlure', price: 2500, luck: 0.6, corruption: 0.03 },
];
// Tackle is kept once bought; one piece is fitted per cast.
export const TACKLE = [
  { id: 'none', label: 'No tackle', price: 0, desc: 'Nothing fitted' },
  { id: 'leader', label: 'Steel Leader', price: 4000, desc: 'Line tension builds 40% slower', tension: 0.6 },
  { id: 'sinker', label: 'Lead Sinker', price: 6000, desc: 'Fish dart around less', calm: 1 },
  { id: 'spinner', label: 'Brass Spinner', price: 10000, desc: '+4 catch on every good reel', bonus: 4 },
  { id: 'charm', label: 'Four-Leaf Charm', price: 20000, desc: 'Mutations twice as likely', mutation: 2 },
];

export const rodById = (id) => RODS.find((r) => r.id === id) ?? RODS[0];
export const baitById = (id) => BAITS.find((b) => b.id === id) ?? BAITS[0];
export const tackleById = (id) => TACKLE.find((t) => t.id === id) ?? TACKLE[0];
export const biomeById = (id) => BIOMES.find((b) => b.id === id) ?? BIOMES[0];
export const rarityById = (id) => RARITIES.find((r) => r.id === id) ?? RARITIES[0];

// ------------------------------------------------------------------ levels
export const MAX_LEVEL = 100;
/** Levels up to here keep the original curve, so nobody's level changed when the cap went up. */
export const SOFT_CAP = 32;
/**
 * Total XP needed to reach `level` (level 1 needs 0). Past level 32 an extra term grows fast, so each level takes
 * longer than the one before (level 40 ≈ 28k XP, 60 ≈ 106k, 80 ≈ 270k, 100 ≈ 529k).
 */
export const xpForLevel = (level) => {
  const l = Math.min(Math.max(level, 1), MAX_LEVEL);
  return Math.round(100 * (l - 1) ** 1.5 + (l > SOFT_CAP ? 40 * (l - SOFT_CAP) ** 2.2 : 0));
};
/** Level, XP into it and XP for the next one. At the cap, `max` is true and `needed` is 0. */
export function levelFromXp(xp) {
  let l = 1;
  while (l < MAX_LEVEL && xpForLevel(l + 1) <= xp) l++;
  if (l >= MAX_LEVEL) return { level: MAX_LEVEL, into: xp - xpForLevel(MAX_LEVEL), needed: 0, max: true };
  return { level: l, into: xp - xpForLevel(l), needed: xpForLevel(l + 1) - xpForLevel(l), max: false };
}

// ------------------------------------------------------------------ randomness
/** Small seeded generator (mulberry32): the same seed always gives the same sequence. Returns [0, 1). */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rarity odds after luck: every tier above Common is boosted by (1 + luck) per tier. */
export function rarityWeights(luck = 0) {
  return RARITIES.map((r, k) => ({ id: r.id, weight: r.weight * (1 + luck) ** k }));
}

/** What bites. `rand` returns [0, 1). */
export function rollCatch({ biome = 'bay', rod, bait, tackle }, rand = Math.random) {
  const b = biomeById(biome), rd = rodById(rod), bt = baitById(bait), tk = tackleById(tackle);
  const weights = rarityWeights(rd.luck + bt.luck);
  const total = weights.reduce((a, w) => a + w.weight, 0);
  let r = rand() * total, rarity = weights[0].id;
  for (const w of weights) { if (r < w.weight) { rarity = w.id; break; } r -= w.weight; }
  const options = Object.values(FISH).filter((f) => f.biome === b.id && f.rarity === rarity);
  const species = options[Math.floor(rand() * options.length)] ?? options[0];
  // Smaller fish are more common: square the roll so weights lean towards the minimum.
  const roll = rand();
  let weight = species.min + (species.max - species.min) * roll * roll;
  const giant = roll > 0.98;
  if (giant) weight *= 1.6;
  const mult = tk.mutation ?? 1;
  const corruptChance = (MUTATIONS.corrupted.chance + (b.corruption ?? 0) + (bt.corruption ?? 0)) * mult;
  const mutRoll = rand();
  const mutation = mutRoll < corruptChance ? 'corrupted' : mutRoll < corruptChance + MUTATIONS.mutated.chance * mult ? 'mutated' : null;
  if (mutation) weight *= MUTATIONS[mutation].weight;
  weight = Math.round(weight * 100) / 100;
  return { species: species.id, rarity, weight, giant, mutation, value: fishValue(species, weight, mutation) };
}

export function fishValue(species, weight, mutation) {
  const avg = (species.min + species.max) / 2;
  const v = species.base * (weight / avg) ** 0.8 * (mutation ? MUTATIONS[mutation].value : 1);
  return Math.max(1, Math.round(v));
}
/** XP for a catch. `biome` (the place it was caught) adds that place's XP multiplier. */
export function catchXp(c, biome) {
  return Math.round(rarityById(c.rarity).xp * (c.mutation ? 1.5 : 1) * (c.giant ? 1.25 : 1) * (biome ? biomeById(biome).xp ?? 1 : 1));
}
/** How much harder fish fight in a place (0 for the first five). */
const hardOf = (s) => (s.biome ? biomeById(s.biome).hard ?? 0 : 0);

// ------------------------------------------------------------------ the reeling mini-game
export function startReel({ rod, tackle, fish, seed, now = Date.now() }) {
  const rd = rodById(rod);
  const zone = Math.floor((TRACK - rd.control) / 2);
  return { rod: rd.id, tackle: tackleById(tackle).id, fish, seed: seed >>> 0, step: 0, zone, pos: Math.floor(seeded(seed)() * TRACK), progress: 30, tension: 0, status: 'reeling', startedAt: now, lastAt: now };
}

export const inZone = (s) => s.pos >= s.zone && s.pos < s.zone + rodById(s.rod).control;

function moveFish(s) {
  const rand = seeded(s.seed + s.step * 7919);
  // Harder places add half their difficulty to how far fish move (rounded down), so a Lead Sinker still helps.
  const agility = Math.max(1, rarityById(s.fish.rarity).agility + Math.floor(hardOf(s) / 2) - (tackleById(s.tackle).calm ?? 0));
  const dart = rand() < 0.18;                                  // now and then the fish bolts
  const dist = dart ? agility + 1 + Math.floor(rand() * 2) : Math.floor(rand() * (agility + 1));
  const dir = rand() < 0.5 ? -1 : 1;
  let p = s.pos + dir * dist;
  if (p < 0) p = -p; if (p > TRACK - 1) p = 2 * (TRACK - 1) - p; // bounce off the edges
  s.pos = Math.max(0, Math.min(TRACK - 1, p));
}

/**
 * Plays one press. action: 'left' | 'right' | 'reel'. Returns the same (mutated) state. Pure apart from `now`.
 * A press after the fish has been left alone for IDLE_MS counts as the fish getting away.
 */
export function reelStep(s, action, now = Date.now()) {
  if (s.status !== 'reeling') return s;
  if (now - s.lastAt > IDLE_MS) return Object.assign(s, { status: 'escaped', reason: 'idle' });
  const rd = rodById(s.rod), tk = tackleById(s.tackle), base = rarityById(s.fish.rarity), hard = hardOf(s);
  const rar = { escape: base.escape + hard, pull: base.pull + hard * 2 };
  const tensionMul = tk.tension ?? 1;
  s.step += 1; s.lastAt = now;
  if (action === 'left') s.zone = Math.max(0, s.zone - rd.step);
  if (action === 'right') s.zone = Math.min(TRACK - rd.control, s.zone + rd.step);
  moveFish(s);
  const hit = inZone(s);
  if (action === 'reel') {
    if (hit) { s.progress += rd.power + (tk.bonus ?? 0); s.tension += (8 + rar.pull) * tensionMul; }
    else { s.progress -= rar.escape; s.tension += (20 + rar.pull) * tensionMul; }
  } else if (hit) { s.progress += Math.round(rd.power * 0.35); s.tension = Math.max(0, s.tension - 12); }
  else { s.progress -= Math.ceil(rar.escape * 0.6); s.tension = Math.max(0, s.tension - 6); }
  s.progress = Math.max(0, Math.min(100, Math.round(s.progress)));
  s.tension = Math.round(s.tension);
  if (s.tension >= rd.line) return Object.assign(s, { status: 'snapped' });
  if (s.progress >= 100) return Object.assign(s, { status: 'caught' });
  if (s.progress <= 0) return Object.assign(s, { status: 'escaped', reason: 'pulled' });
  if (s.step >= MAX_STEPS) return Object.assign(s, { status: 'escaped', reason: 'tired' });
  return s;
}

export function meter(pct, width = 10) {
  const n = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '▰'.repeat(n) + '▱'.repeat(width - n);
}

/** The slider line, e.g. [░░░░■■■■◈■░░░░░░░░░░]. */
export function trackLine(s) {
  const width = rodById(s.rod).control;
  let out = '';
  for (let k = 0; k < TRACK; k++) {
    const zone = k >= s.zone && k < s.zone + width;
    out += k === s.pos ? (zone ? '◈' : '◆') : zone ? '■' : '░';
  }
  return `[${out}]`;
}

export function reelPanel(s, rodLine = rodById(s.rod).line) {
  return [
    '```',
    trackLine(s),
    `Catch   ${meter(s.progress)} ${String(s.progress).padStart(3)}%`,
    `Tension ${meter((s.tension / rodLine) * 100)} ${String(Math.round((s.tension / rodLine) * 100)).padStart(3)}%`,
    '```',
  ].join('\n');
}
