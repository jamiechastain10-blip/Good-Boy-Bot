/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Critters (3.1): Good Boy's own collectible creatures. 48 critters in 8 elements plus 4 legendaries, all made up for
 * Good Boy. Plain functions and data: species, stats, levels, element advantages, auto-battles, and a drawn picture
 * for each one (with the optional picture library; an emoji otherwise).
 */
import { canvasLib } from './gameart.js';

export const ELEMENTS = {
  fire: { emoji: '🔥', label: 'Fire', color: '#ff7a3d', dark: '#b8401a' },
  water: { emoji: '💧', label: 'Water', color: '#4aa8ff', dark: '#1f5fae' },
  leaf: { emoji: '🍃', label: 'Leaf', color: '#5fcf6a', dark: '#2d7d37' },
  spark: { emoji: '⚡', label: 'Spark', color: '#ffd23f', dark: '#b08b00' },
  stone: { emoji: '🪨', label: 'Stone', color: '#b59a7a', dark: '#6e5a43' },
  frost: { emoji: '❄️', label: 'Frost', color: '#9fe6ff', dark: '#4a9ab8' },
  shadow: { emoji: '🌑', label: 'Shadow', color: '#9a7bd8', dark: '#4c3487' },
  sky: { emoji: '☁️', label: 'Sky', color: '#c9d8ff', dark: '#6f83c4' },
};
/** Who beats whom: an attack against an element it beats does 1.2x, against one that beats it 0.83x. */
export const BEATS = { fire: ['leaf', 'frost'], water: ['fire', 'stone'], leaf: ['water', 'stone'], spark: ['water', 'sky'], stone: ['spark', 'fire'], frost: ['leaf', 'sky'], shadow: ['spark', 'shadow'], sky: ['leaf', 'shadow'] };
export function advantage(att, def) {
  if (BEATS[att]?.includes(def)) return 1.2;
  if (BEATS[def]?.includes(att)) return 0.83;
  return 1;
}

export const RARITIES = {
  common: { label: 'Common', weight: 60, color: 0x95a5a6, value: 50 },
  uncommon: { label: 'Uncommon', weight: 25, color: 0x2ecc71, value: 150 },
  rare: { label: 'Rare', weight: 10, color: 0x3498db, value: 500 },
  epic: { label: 'Epic', weight: 4.4, color: 0x9b59b6, value: 2000 },
  legendary: { label: 'Legendary', weight: 0.6, color: 0xf1c40f, value: 15000 },
};
export const SPARKLY_CHANCE = 1 / 400;

// [name, element, rarity, hp, atk, def, spd, shape]. Shapes pick how the picture is drawn.
const LIST = [
  ['Emberpup', 'fire', 'common', 45, 52, 40, 55, 'pup'], ['Cindermouse', 'fire', 'common', 40, 48, 38, 65, 'mouse'], ['Flarefin', 'fire', 'common', 50, 50, 45, 45, 'fish'],
  ['Blazeback', 'fire', 'uncommon', 65, 62, 55, 50, 'beast'], ['Pyrohorn', 'fire', 'rare', 75, 80, 60, 60, 'horned'], ['Infernyx', 'fire', 'epic', 85, 98, 70, 80, 'dragon'],
  ['Puddlepaw', 'water', 'common', 50, 45, 48, 45, 'pup'], ['Bubblet', 'water', 'common', 55, 40, 50, 40, 'blob'], ['Tidewhisk', 'water', 'common', 45, 50, 42, 58, 'mouse'],
  ['Coralcrest', 'water', 'uncommon', 70, 55, 65, 45, 'fish'], ['Riptusk', 'water', 'rare', 85, 78, 72, 50, 'beast'], ['Abyssqua', 'water', 'epic', 100, 85, 85, 65, 'dragon'],
  ['Sproutle', 'leaf', 'common', 50, 45, 50, 40, 'blob'], ['Mossnub', 'leaf', 'common', 55, 42, 55, 35, 'beast'], ['Thornip', 'leaf', 'common', 42, 55, 40, 55, 'mouse'],
  ['Bloomtail', 'leaf', 'uncommon', 62, 58, 58, 60, 'pup'], ['Barkbeast', 'leaf', 'rare', 95, 72, 85, 35, 'horned'], ['Verdantis', 'leaf', 'epic', 95, 88, 90, 60, 'dragon'],
  ['Zapling', 'spark', 'common', 38, 50, 35, 70, 'mouse'], ['Voltpup', 'spark', 'common', 45, 52, 40, 62, 'pup'], ['Fizzlet', 'spark', 'common', 48, 48, 42, 58, 'blob'],
  ['Staticoon', 'spark', 'uncommon', 58, 62, 50, 75, 'beast'], ['Thunderhorn', 'spark', 'rare', 72, 85, 60, 78, 'horned'], ['Fulgarix', 'spark', 'epic', 80, 100, 65, 95, 'dragon'],
  ['Pebblit', 'stone', 'common', 55, 45, 60, 25, 'blob'], ['Rubblebun', 'stone', 'common', 52, 48, 58, 35, 'mouse'], ['Cragjaw', 'stone', 'common', 58, 55, 55, 30, 'beast'],
  ['Boulderback', 'stone', 'uncommon', 80, 60, 80, 25, 'horned'], ['Geodrake', 'stone', 'rare', 90, 78, 92, 40, 'dragon'], ['Titanyx', 'stone', 'epic', 115, 90, 110, 35, 'beast'],
  ['Snowpip', 'frost', 'common', 45, 45, 48, 50, 'blob'], ['Frostkit', 'frost', 'common', 44, 50, 42, 60, 'pup'], ['Icicub', 'frost', 'common', 55, 50, 50, 40, 'beast'],
  ['Glacipaw', 'frost', 'uncommon', 68, 60, 62, 55, 'pup'], ['Blizzhorn', 'frost', 'rare', 80, 80, 70, 55, 'horned'], ['Cryonix', 'frost', 'epic', 90, 92, 80, 75, 'dragon'],
  ['Duskit', 'shadow', 'common', 42, 52, 40, 60, 'pup'], ['Gloomoth', 'shadow', 'common', 45, 48, 42, 62, 'wing'], ['Shadeling', 'shadow', 'common', 48, 50, 45, 55, 'blob'],
  ['Nightfang', 'shadow', 'uncommon', 60, 70, 52, 70, 'beast'], ['Umbrax', 'shadow', 'rare', 75, 85, 65, 72, 'horned'], ['Phantomaw', 'shadow', 'epic', 85, 100, 70, 85, 'dragon'],
  ['Puffwing', 'sky', 'common', 42, 45, 40, 65, 'wing'], ['Breezlet', 'sky', 'common', 45, 48, 42, 60, 'blob'], ['Gustkit', 'sky', 'common', 44, 52, 40, 64, 'pup'],
  ['Cloudmane', 'sky', 'uncommon', 65, 58, 60, 68, 'beast'], ['Stormtalon', 'sky', 'rare', 72, 84, 62, 85, 'wing'], ['Aerolux', 'sky', 'epic', 82, 92, 72, 100, 'dragon'],
  ['Solarion', 'fire', 'legendary', 120, 115, 100, 100, 'dragon'], ['Lunaris', 'shadow', 'legendary', 115, 110, 105, 105, 'wing'],
  ['Terravore', 'stone', 'legendary', 135, 112, 125, 70, 'horned'], ['Tempestra', 'sky', 'legendary', 110, 118, 95, 120, 'wing'],
];
export const SPECIES = Object.fromEntries(LIST.map(([name, element, rarity, hp, atk, def, spd, shape], k) => [name.toLowerCase(), { id: name.toLowerCase(), no: k + 1, name, element, rarity, base: { hp, atk, def, spd }, shape }]));
export const ALL = Object.values(SPECIES);
export const speciesById = (id) => SPECIES[String(id).toLowerCase()] ?? null;

/** A wild critter: species (by rarity weight), quality rolls 0-31 per stat, sparkly or not. */
export function rollWild(rand = Math.random) {
  const total = Object.values(RARITIES).reduce((a, r) => a + r.weight, 0);
  let r = rand() * total, rarity = 'common';
  for (const [id, x] of Object.entries(RARITIES)) { if (r < x.weight) { rarity = id; break; } r -= x.weight; }
  const pool = ALL.filter((s) => s.rarity === rarity);
  const sp = pool[Math.floor(rand() * pool.length)];
  const iv = () => Math.floor(rand() * 32);
  return { species: sp.id, iv: { hp: iv(), atk: iv(), def: iv(), spd: iv() }, sparkly: rand() < SPARKLY_CHANCE };
}
/** Quality in %: how good its four rolls are. */
export const quality = (iv) => Math.round(((iv.hp + iv.atk + iv.def + iv.spd) / 124) * 100);
export const MAX_LEVEL = 100;
export const xpToNext = (level) => (level >= MAX_LEVEL ? Infinity : 20 + level * level * 4);
/** Adds XP, levelling up as many times as it fills. Returns { level, xp, ups }. */
export function addXp(level, xp, gain) {
  let ups = 0; xp += gain;
  while (level < MAX_LEVEL && xp >= xpToNext(level)) { xp -= xpToNext(level); level += 1; ups += 1; }
  if (level >= MAX_LEVEL) xp = 0;
  return { level, xp, ups };
}
/** A critter's battle stats at its level. */
export function stats(c) {
  const sp = speciesById(c.species), iv = c.iv ?? { hp: c.iv_hp, atk: c.iv_atk, def: c.iv_def, spd: c.iv_spd };
  const f = (base, v) => Math.floor(((2 * base + v) * c.level) / 100) + 5;
  return { hp: Math.floor(((2 * sp.base.hp + iv.hp) * c.level) / 100) + c.level + 10, atk: f(sp.base.atk, iv.atk), def: f(sp.base.def, iv.def), spd: f(sp.base.spd, iv.spd) };
}
/** The hint for catching: the name with some letters hidden; more show the longer it waits. */
export function hint(name, shown = 1) {
  const keep = new Set([0]);
  const order = [...name].map((_, k) => k).filter((k) => k > 0).sort((a, b) => ((a * 7) % name.length) - ((b * 7) % name.length));
  for (const k of order.slice(0, Math.max(0, shown - 1))) keep.add(k);
  return [...name].map((ch, k) => (keep.has(k) ? ch : '_')).join(' ');
}
export const nameMatches = (typed, name) => String(typed ?? '').trim().toLowerCase().replace(/\s+/g, '') === name.toLowerCase();

/**
 * An automatic battle between two critters. Each turn the faster one attacks first; damage depends on attack,
 * defence, level and element. rand returns [0, 1). Returns { winner: 0|1, log: [...lines], turns }.
 */
export function battle(a, b, rand = Math.random) {
  const side = [a, b].map((c) => ({ c, sp: speciesById(c.species), st: stats(c) }));
  const hp = side.map((x) => x.st.hp);
  const log = [];
  let turns = 0;
  while (hp[0] > 0 && hp[1] > 0 && turns < 50) {
    turns += 1;
    const first = side[0].st.spd === side[1].st.spd ? (rand() < 0.5 ? 0 : 1) : side[0].st.spd > side[1].st.spd ? 0 : 1;
    for (const at of [first, 1 - first]) {
      const df = 1 - at;
      if (hp[at] <= 0 || hp[df] <= 0) continue;
      const adv = advantage(side[at].sp.element, side[df].sp.element);
      const crit = rand() < 0.1 ? 1.5 : 1;
      if (rand() < 0.08) { if (turns <= 3) log.push(`${side[df].sp.name} dodges!`); continue; }
      const dmg = Math.max(1, Math.floor((((2 * side[at].c.level) / 5 + 2) * 110 * (side[at].st.atk / side[df].st.def)) / 50 + 2) * adv * crit * (0.7 + rand() * 0.3));
      hp[df] = Math.max(0, hp[df] - Math.floor(dmg));
      if (turns <= 3 || hp[df] === 0 || crit > 1) log.push(`${side[at].sp.name} hits for **${Math.floor(dmg)}**${adv > 1 ? ' (super effective!)' : adv < 1 ? ' (not very effective)' : ''}${crit > 1 ? ' ⚡ critical!' : ''}${hp[df] === 0 ? ` · ${side[df].sp.name} is out!` : ''}`);
    }
  }
  const winner = hp[0] > 0 && hp[1] <= 0 ? 0 : hp[1] > 0 && hp[0] <= 0 ? 1 : hp[0] / side[0].st.hp >= hp[1] / side[1].st.hp ? 0 : 1;
  return { winner, log, turns, hpLeft: hp };
}

// ------------------------------------------------------------------ pictures
function seeded(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hashName = (s) => { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
/** A 320x320 PNG of the critter, or null without the picture library. hidden = a dark silhouette (before it's caught). */
export async function critterImage(speciesId, { sparkly = false, hidden = false } = {}) {
  const C = await canvasLib();
  if (!C) return null;
  const sp = speciesById(speciesId), el = ELEMENTS[sp.element], r = seeded(hashName(sp.id));
  const W = 320, cv = C.createCanvas(W, W), g = cv.getContext('2d');
  const bg = g.createRadialGradient(W / 2, W / 2, 20, W / 2, W / 2, W * 0.7);
  bg.addColorStop(0, sparkly ? '#fff4c2' : '#2a3142'); bg.addColorStop(1, sparkly ? '#d4a017' : '#141821');
  g.fillStyle = bg; g.fillRect(0, 0, W, W);
  const body = hidden ? '#0b0d12' : sparkly ? shift(el.color, 40) : el.color, dark = hidden ? '#0b0d12' : sparkly ? shift(el.dark, 40) : el.dark;
  const cx = W / 2, cy = W / 2 + 25;
  const bw = 92 + r() * 30, bh = 70 + r() * 25;
  g.lineWidth = 6; g.strokeStyle = hidden ? '#000' : 'rgba(0,0,0,0.55)';
  const blob = (x, y, rx, ry, fill) => { g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.fillStyle = fill; g.fill(); g.stroke(); };
  // Tail / wings / fins behind the body.
  if (sp.shape === 'wing' || sp.shape === 'dragon') for (const s of [-1, 1]) { g.beginPath(); g.moveTo(cx + s * bw * 0.5, cy - 10); g.quadraticCurveTo(cx + s * (bw + 55), cy - 90 - r() * 20, cx + s * (bw + 30), cy + 10); g.closePath(); g.fillStyle = dark; g.fill(); g.stroke(); }
  if (sp.shape === 'fish') { g.beginPath(); g.moveTo(cx + bw * 0.8, cy); g.lineTo(cx + bw + 45, cy - 40); g.lineTo(cx + bw + 45, cy + 40); g.closePath(); g.fillStyle = dark; g.fill(); g.stroke(); }
  if (['pup', 'mouse', 'beast', 'dragon'].includes(sp.shape)) { g.beginPath(); g.moveTo(cx + bw * 0.7, cy + 10); g.quadraticCurveTo(cx + bw + 50, cy - 20, cx + bw + 30, cy - 60); g.lineWidth = 16; g.strokeStyle = dark; g.stroke(); g.lineWidth = 6; g.strokeStyle = hidden ? '#000' : 'rgba(0,0,0,0.55)'; }
  // Feet, body, belly.
  if (sp.shape !== 'fish' && sp.shape !== 'blob') for (const s of [-1, 1]) blob(cx + s * bw * 0.45, cy + bh * 0.85, 22, 14, dark);
  blob(cx, cy, bw, bh, body);
  if (!hidden) { g.beginPath(); g.ellipse(cx, cy + bh * 0.3, bw * 0.55, bh * 0.45, 0, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,0.28)'; g.fill(); }
  // Head.
  const hx = cx - bw * 0.25, hy = cy - bh * 0.95, hr = 52 + r() * 12;
  if (sp.shape === 'pup' || sp.shape === 'beast') for (const s of [-1, 1]) { g.beginPath(); g.moveTo(hx + s * hr * 0.5, hy - hr * 0.6); g.lineTo(hx + s * hr * 1.05, hy - hr * 1.25); g.lineTo(hx + s * hr * 0.95, hy - hr * 0.2); g.closePath(); g.fillStyle = dark; g.fill(); g.stroke(); }
  if (sp.shape === 'mouse') for (const s of [-1, 1]) blob(hx + s * hr * 0.75, hy - hr * 0.75, hr * 0.45, hr * 0.45, dark);
  if (sp.shape === 'horned' || sp.shape === 'dragon') for (const s of [-1, 1]) { g.beginPath(); g.moveTo(hx + s * hr * 0.35, hy - hr * 0.75); g.quadraticCurveTo(hx + s * hr * 0.9, hy - hr * 1.6, hx + s * hr * 0.2, hy - hr * 1.5); g.closePath(); g.fillStyle = hidden ? '#000' : '#f5ecd7'; g.fill(); g.stroke(); }
  if (sp.shape !== 'fish' && sp.shape !== 'blob') blob(hx, hy, hr, hr * 0.92, body);
  else { /* blobs and fish: the face sits on the body */ }
  const fx = sp.shape === 'fish' || sp.shape === 'blob' ? cx - 10 : hx, fy = sp.shape === 'fish' || sp.shape === 'blob' ? cy - 12 : hy;
  if (!hidden) {
    for (const s of [-1, 1]) { blob(fx + s * 20, fy - 4, 12, 14, '#ffffff'); g.beginPath(); g.arc(fx + s * 20 + 3, fy - 2, 6.5, 0, Math.PI * 2); g.fillStyle = '#1b1b1b'; g.fill(); g.beginPath(); g.arc(fx + s * 20 + 5, fy - 5, 2.2, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill(); }
    g.beginPath(); g.arc(fx, fy + 16, 9, 0.15 * Math.PI, 0.85 * Math.PI); g.lineWidth = 4; g.strokeStyle = '#2a1a12'; g.stroke();
    for (const s of [-1, 1]) { g.beginPath(); g.ellipse(fx + s * 36, fy + 12, 9, 5, 0, 0, Math.PI * 2); g.fillStyle = 'rgba(255,120,150,0.55)'; g.fill(); }
    // Element mark on the body: a little badge (drawn, so it never depends on an emoji font).
    const bx = cx + bw * 0.38, by = cy + 4;
    g.beginPath(); g.moveTo(bx, by - 16); g.lineTo(bx + 14, by); g.lineTo(bx, by + 16); g.lineTo(bx - 14, by); g.closePath(); g.fillStyle = dark; g.fill(); g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,0.7)'; g.stroke();
  } else { g.font = 'bold 90px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillText('?', cx, cy - 20); }
  if (sparkly && !hidden) for (const [x, y, size] of [[42, 48, 20], [W - 46, 72, 16], [W - 70, W - 60, 12]]) star(g, x, y, size);
  return cv.toBuffer('image/png');
}
/** A four-point sparkle. */
function star(g, x, y, r) {
  g.beginPath(); g.moveTo(x, y - r); g.quadraticCurveTo(x, y, x + r, y); g.quadraticCurveTo(x, y, x, y + r); g.quadraticCurveTo(x, y, x - r, y); g.quadraticCurveTo(x, y, x, y - r);
  g.fillStyle = '#fffbe6'; g.fill();
}
function shift(hex, amt) {
  const n = parseInt(hex.slice(1), 16), c = (v) => Math.max(0, Math.min(255, v));
  return `#${[(n >> 16) + amt, ((n >> 8) & 255) - amt / 2, (n & 255) + amt].map((v) => c(Math.round(v)).toString(16).padStart(2, '0')).join('')}`;
}
