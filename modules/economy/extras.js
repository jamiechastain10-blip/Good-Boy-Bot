/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * 3.1 economy extras, as plain functions:
 *   Rob      take a slice of someone's wallet (45% chance), or pay them a fine. Coins in the bank are safe; a Padlock
 *            (from the shop) stops one robbery. Off unless the server turns it on.
 *   Pets     adopt one, feed it and play with it. A happy, well-fed pet adds up to +25% to /work.
 *   Events   now and then while people chat: a bag of coins to grab (first press) or to share (everyone who presses).
 */
import { UserError } from '../../src/util.js';

export const PADLOCK_ID = 'padlock';
export const ROB_CHANCE = 0.45, ROB_COOLDOWN = 3600000, ROB_SHIELD = 2 * 3600000, ROB_MIN = 500;

/** One robbery attempt. rand returns [0, 1). Returns { outcome: 'stole'|'caught'|'padlock', coins }. */
export function robOutcome({ robberCoins, targetCoins, padlock, maxSteal }, rand = Math.random) {
  if (padlock) return { outcome: 'padlock', coins: Math.max(50, Math.floor(robberCoins * 0.1)) };
  if (rand() < ROB_CHANCE) return { outcome: 'stole', coins: Math.max(1, Math.min(maxSteal, Math.floor(targetCoins * (0.1 + rand() * 0.25)))) };
  return { outcome: 'caught', coins: Math.max(50, Math.floor(robberCoins * 0.1)) };
}
export const padlockPrice = (ctx) => Math.max(1, Math.round(ctx.config.get('dailyBase') * 2));

export async function rob(ctx, robberId, target, h, now = Date.now(), rand = Math.random) {
  if (!ctx.config.get('robbing')) throw new UserError('Robbing is turned off in this server.');
  if (!target || target.bot || target.id === robberId) throw new UserError('Pick another member (not a bot, not yourself).');
  const r = h.wallet(robberId), t = h.wallet(target.id);
  if (r.last_rob && now - r.last_rob < ROB_COOLDOWN) throw new UserError(`Lay low for a bit. You can rob again <t:${Math.floor((r.last_rob + ROB_COOLDOWN) / 1000)}:R>.`);
  if (r.coins < 250) throw new UserError('You need at least 250 coins in your wallet to try (you might get fined).');
  if (t.coins < ROB_MIN) throw new UserError(`They don't have enough in their wallet to be worth it (under ${ROB_MIN}).`);
  if (t.robbed_at && now - t.robbed_at < ROB_SHIELD) throw new UserError('They were robbed not long ago. Leave them alone for a while.');
  const lock = ctx.sql.get('SELECT qty FROM economy_items WHERE guild_id = ? AND user_id = ? AND item_id = ?', ctx.guildId, target.id, PADLOCK_ID)?.qty > 0;
  const o = robOutcome({ robberCoins: r.coins, targetCoins: t.coins, padlock: lock, maxSteal: ctx.config.get('robMax') }, rand);
  ctx.sql.transaction(() => {
    ctx.sql.run('UPDATE economy_wallets SET last_rob = ? WHERE guild_id = ? AND user_id = ?', now, ctx.guildId, robberId);
    if (o.outcome === 'stole') {
      h.debit(target.id, o.coins, `robbed by ${robberId}`); h.move(robberId, o.coins, `robbed ${target.id}`);
      ctx.sql.run('UPDATE economy_wallets SET robbed_at = ? WHERE guild_id = ? AND user_id = ?', now, ctx.guildId, target.id);
    } else {
      const fine = Math.min(o.coins, h.wallet(robberId).coins);
      if (fine > 0) { h.debit(robberId, fine, `rob fine to ${target.id}`); h.move(target.id, fine, `rob fine from ${robberId}`); }
      o.coins = fine;
      if (o.outcome === 'padlock') ctx.sql.run('UPDATE economy_items SET qty = qty - 1 WHERE guild_id = ? AND user_id = ? AND item_id = ?', ctx.guildId, target.id, PADLOCK_ID);
    }
  });
  return o;
}

// ------------------------------------------------------------------ pets
export const PETS = {
  puppy: { emoji: '🐶', label: 'Puppy', price: 2000 }, kitten: { emoji: '🐱', label: 'Kitten', price: 2000 }, bunny: { emoji: '🐰', label: 'Bunny', price: 2500 },
  hamster: { emoji: '🐹', label: 'Hamster', price: 1500 }, fox: { emoji: '🦊', label: 'Fox', price: 6000 }, owl: { emoji: '🦉', label: 'Owl', price: 6000 },
  turtle: { emoji: '🐢', label: 'Turtle', price: 4000 }, dragon: { emoji: '🐉', label: 'Dragon', price: 50000 },
};
const HOUR = 3600000;
/** Hunger and happiness go down over time (from 100): about a point an hour for hunger, slower for happiness. */
export function petNow(p, now = Date.now()) {
  const hrs = Math.max(0, (now - p.updated_at) / HOUR);
  return { ...p, hunger: Math.max(0, Math.round(p.hunger - hrs * 1.2)), happy: Math.max(0, Math.round(p.happy - hrs * 0.8)) };
}
export const petLevel = (xp) => Math.min(20, Math.floor(Math.sqrt(xp / 10)));
/** What a pet adds to /work, in %: up to +25% for a level-20 pet that is fed and happy. */
export function petBonus(p, now = Date.now()) {
  if (!p) return 0;
  const n = petNow(p, now), care = Math.min(n.hunger, n.happy) / 100;
  return Math.round((5 + petLevel(p.xp)) * care);
}
export const getPet = (ctx, userId) => ctx.sql.get('SELECT * FROM economy_pets WHERE guild_id = ? AND user_id = ?', ctx.guildId, userId) ?? null;
export function adopt(ctx, userId, kind, name, h) {
  const k = PETS[kind];
  if (!k) throw new UserError('Pick a pet from the list.');
  if (getPet(ctx, userId)) throw new UserError('You already have a pet. Love the one you have!');
  const nm = String(name ?? '').trim().replace(/[*_`~|<>@#]/g, '').slice(0, 20) || k.label;
  ctx.sql.transaction(() => {
    h.debit(userId, k.price, `adopted a ${k.label}`);
    ctx.sql.run('INSERT INTO economy_pets (guild_id, user_id, kind, name, hunger, happy, xp, adopted_at, updated_at) VALUES (?, ?, ?, ?, 80, 80, 0, ?, ?)', ctx.guildId, userId, kind, nm, Date.now(), Date.now());
  });
  return getPet(ctx, userId);
}
const CARE = { feed: { stat: 'hunger', gain: 35, cost: 50, xp: 5, text: ['gobbles it all up', 'happily munches away', 'licks the bowl clean'] }, play: { stat: 'happy', gain: 30, cost: 0, xp: 8, text: ['zooms around in circles', 'brings the ball back again and again', 'does a little happy dance'] } };
/** Feed (costs a little) or play. 30 minutes between each kind. Returns { pet, text }. */
export function care(ctx, userId, what, h, now = Date.now(), rand = Math.random) {
  const c = CARE[what], p = getPet(ctx, userId);
  if (!p) throw new UserError("You don't have a pet yet. Adopt one with `/pet adopt`.");
  const last = what === 'feed' ? p.fed_at : p.played_at;
  if (last && now - last < 30 * 60000) throw new UserError(`${p.name} isn't ${what === 'feed' ? 'hungry' : 'in the mood'} right now. Try again <t:${Math.floor((last + 30 * 60000) / 1000)}:R>.`);
  const n = petNow(p, now);
  ctx.sql.transaction(() => {
    if (c.cost) h.debit(userId, c.cost, `fed ${p.name}`);
    const hunger = what === 'feed' ? Math.min(100, n.hunger + c.gain) : n.hunger, happy = what === 'play' ? Math.min(100, n.happy + c.gain) : n.happy;
    ctx.sql.run(`UPDATE economy_pets SET hunger = ?, happy = ?, xp = xp + ?, updated_at = ?, ${what === 'feed' ? 'fed_at' : 'played_at'} = ? WHERE guild_id = ? AND user_id = ?`, hunger, happy, c.xp, now, now, ctx.guildId, userId);
  });
  const after = getPet(ctx, userId);
  const up = petLevel(after.xp) > petLevel(p.xp);
  return { pet: after, text: `${PETS[p.kind].emoji} **${p.name}** ${c.text[Math.floor(rand() * c.text.length)]}!${up ? ` ⬆️ ${p.name} is now level ${petLevel(after.xp)}!` : ''}` };
}

// ------------------------------------------------------------------ chat events
export const EVENTS = [
  { kind: 'grab', emoji: '💰', title: 'A bag of coins fell out of the sky!', button: 'Grab it', text: 'First to press **Grab it** keeps it.' },
  { kind: 'split', emoji: '🎁', title: 'A treasure chest washed up!', button: 'Take a share', text: 'Everyone who presses **Take a share** in the next 30 seconds splits it.' },
  { kind: 'grab', emoji: '🐕', title: 'A good boy dropped a wallet!', button: 'Return it', text: 'First to press **Return it** gets the reward.' },
  { kind: 'split', emoji: '🍀', title: 'A lucky clover patch appeared!', button: 'Pick some', text: 'Everyone who presses **Pick some** in the next 30 seconds shares the luck.' },
];
/** How big an event's prize is: a few daily rewards' worth. */
export const eventPrize = (ctx, rand = Math.random) => Math.round(ctx.config.get('dailyBase') * (1 + rand() * 3));
/** Shares a prize between people, as evenly as whole coins allow. */
export const shares = (total, n) => (n ? Array.from({ length: n }, (_, k) => Math.floor(total / n) + (k < total % n ? 1 : 0)) : []);
