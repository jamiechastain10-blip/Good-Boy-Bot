/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Fishing challenges (2.3.3) as plain functions: what today's and this week's challenges are, how a catch or a sale
 * moves them along, and what they pay.
 *
 *   - 3 daily challenges (new every day at midnight UTC) and 1 weekly challenge (new every Monday, midnight UTC)
 *   - picked for each member from the places they have unlocked, so they are always possible
 *   - the same member, server and day always get the same challenges (seeded), so nothing changes on a restart
 *   - rewards grow with fishing level: coins, plus XP worth a share of the member's next level
 *   - finishing all 3 dailies pays a bonus and grows a streak (days in a row); the bonus grows with the streak
 */
import * as F from './fishing.js';

const DAY = 86400000;
export const dayKey = (now) => new Date(now).toISOString().slice(0, 10);
/** The Monday (UTC) that starts the week holding `now`, as YYYY-MM-DD. */
export function weekKey(now) {
  const d = new Date(now);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10);
}
export const nextDayAt = (now) => Date.parse(`${dayKey(now)}T00:00:00Z`) + DAY;
export const nextWeekAt = (now) => Date.parse(`${weekKey(now)}T00:00:00Z`) + 7 * DAY;
export const yesterdayKey = (now) => dayKey(Date.parse(`${dayKey(now)}T00:00:00Z`) - DAY);

function hash(str) {
  let h = 0x811c9dc5;
  for (let k = 0; k < str.length; k++) { h ^= str.charCodeAt(k); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
const rank = (rarity) => F.RARITIES.findIndex((r) => r.id === rarity);
/** Two significant figures, so rewards and goals read nicely (1,234 -> 1,200). */
const nice = (n) => { if (n < 100) return Math.max(1, Math.round(n)); const p = 10 ** (Math.floor(Math.log10(n)) - 1); return Math.round(n / p) * p; };

/** Rewards for a member at `level`: coins grow with level; XP is a share of what their next level needs. */
export function rewards(level) {
  const lv = F.levelFromXp(F.xpForLevel(level));
  const coins = nice(150 * (1 + level ** 1.3 / 6));
  return {
    daily: { coins, xp: lv.max ? 0 : Math.max(10, Math.round(lv.needed * 0.12)) },
    weekly: { coins: coins * 5, xp: lv.max ? 0 : Math.max(50, Math.round(lv.needed * 0.6)) },
  };
}
/** The streak bonus for finishing all 3 dailies: more coins for every day in a row (up to 7), plus some bait. */
export function streakBonus(level, streak) {
  const days = Math.min(Math.max(streak, 1), 7);
  const bait = level >= 40 ? 'stormfly' : level >= 12 ? 'glowgrub' : level >= 5 ? 'shrimp' : 'worm';
  return { coins: nice(rewards(level).daily.coins * (1 + 0.25 * days)), bait, baitQty: 3 };
}

/** The three highest places a member can fish, best first. Challenges pick from these. */
const topPlaces = (level) => F.BIOMES.filter((b) => b.level <= level).slice(-3).reverse();

const DAILY_KINDS = ['catch', 'place', 'rarity', 'species', 'heavy', 'sell', 'variety'];
const WEEKLY_KINDS = ['mutation', 'bigrarity', 'catch', 'place', 'giant'];

function build(kind, level, rand, weekly) {
  const places = topPlaces(level), pick = (list) => list[Math.floor(rand() * list.length)];
  const place = pick(places);
  switch (kind) {
    case 'catch': return { kind, goal: weekly ? 60 + Math.floor(rand() * 31) : 8 + Math.floor(rand() * 8) };
    case 'place': return { kind, biome: weekly ? places[0].id : place.id, goal: weekly ? 30 : 5 + Math.floor(rand() * 6) };
    case 'rarity': {
      const [rarity, goal] = level < 5 ? ['uncommon', 3] : level < 20 ? pick([['uncommon', 4], ['rare', 2]]) : pick([['rare', 3], ['epic', 1]]);
      return { kind, rarity, goal };
    }
    case 'bigrarity': return level >= 12 ? { kind: 'rarity', rarity: 'legendary', goal: 1 } : { kind: 'rarity', rarity: 'epic', goal: 2 };
    case 'species': {
      const fish = pick(F.fishIn(place.id).filter((f) => rank(f.rarity) <= 1));
      return { kind, species: fish.id, biome: place.id, goal: fish.rarity === 'common' ? 2 : 1 };
    }
    case 'heavy': {
      // Heavier than any Uncommon fish there can be, so it takes a Rare or better (or a Giant).
      const weight = Math.max(...F.fishIn(place.id).filter((f) => f.rarity === 'uncommon').map((f) => f.max));
      return { kind, biome: place.id, weight: Math.ceil(weight * 10) / 10, goal: 1 };
    }
    case 'sell': {
      const commons = F.fishIn(places[0].id).filter((f) => f.rarity === 'common');
      return { kind, goal: nice(15 * commons.reduce((a, f) => a + f.base, 0) / commons.length) };
    }
    case 'variety': return { kind, goal: 4 + Math.floor(rand() * 3) };
    case 'mutation': return { kind, goal: 1 };
    case 'giant': return { kind, goal: 1 };
    default: throw new Error(`unknown challenge ${kind}`);
  }
}

/** Today's 3 challenges for a member. `seed` is any string unique to the member, server and day. */
export function makeDailies(level, seed) {
  const rand = F.seeded(hash(`d:${seed}`));
  const kinds = [...DAILY_KINDS];
  const out = [];
  while (out.length < 3) {
    const kind = kinds.splice(Math.floor(rand() * kinds.length), 1)[0];
    out.push({ ...build(kind, level, rand, false), reward: rewards(level).daily });
  }
  return out;
}
/** This week's challenge for a member. */
export function makeWeekly(level, seed) {
  const rand = F.seeded(hash(`w:${seed}`));
  const kind = WEEKLY_KINDS[Math.floor(rand() * WEEKLY_KINDS.length)];
  return { ...build(kind, level, rand, true), reward: rewards(level).weekly };
}

/**
 * How an event moves a challenge. Events: { type: 'catch', fish: { species, rarity, weight, giant, mutation } } or
 * { type: 'sell', coins }. Returns { progress, seen } (unchanged when the event does not count).
 */
export function advance(ch, progress, seen, event) {
  const out = { progress, seen };
  if (progress >= ch.goal) return out;
  if (event.type === 'sell') { if (ch.kind === 'sell') out.progress = Math.min(ch.goal, progress + Math.max(0, event.coins | 0)); return out; }
  if (event.type !== 'catch') return out;
  const f = event.fish, sp = F.FISH[f.species];
  if (!sp) return out;
  const hit = {
    catch: true,
    place: sp.biome === ch.biome,
    rarity: rank(f.rarity) >= rank(ch.rarity),
    species: f.species === ch.species,
    heavy: sp.biome === ch.biome && f.weight >= ch.weight,
    variety: !seen.includes(f.species),
    mutation: !!f.mutation,
    giant: !!f.giant,
  }[ch.kind];
  if (!hit) return out;
  out.progress = progress + 1;
  if (ch.kind === 'variety') out.seen = [...seen, f.species];
  return out;
}

/** Plain words for a challenge. `money(n)` formats coins the server's way. */
export function describe(ch, money = (n) => `${n.toLocaleString('en-US')} coins`) {
  const at = (id) => { const b = F.biomeById(id); return `${b.emoji} ${b.label}`; };
  const r = (id) => F.rarityById(id).label;
  switch (ch.kind) {
    case 'catch': return `Catch ${ch.goal} fish`;
    case 'place': return `Catch ${ch.goal} fish at ${at(ch.biome)}`;
    case 'rarity': return ch.goal === 1 ? `Catch a ${r(ch.rarity)} fish or rarer` : `Catch ${ch.goal} ${r(ch.rarity)} fish or rarer`;
    case 'species': return `Catch ${ch.goal === 1 ? 'a' : ch.goal} ${F.FISH[ch.species].name} (${at(ch.biome)})`;
    case 'heavy': return `Land a fish of ${ch.weight} kg or more at ${at(ch.biome)}`;
    case 'sell': return `Sell fish worth ${money(ch.goal)}`;
    case 'variety': return `Catch ${ch.goal} different kinds of fish`;
    case 'mutation': return 'Catch a Mutated or Corrupted fish';
    case 'giant': return 'Catch a Giant fish';
    default: return 'Challenge';
  }
}
