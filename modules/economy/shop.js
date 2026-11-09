/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * 3.1: the coin shop, inventory, /work and the bank, as plain functions on top of the wallet.
 *   Shop      items staff add: a role (for good, or for some hours) or a collectible item (kept in your inventory, with an
 *             optional message when used, and used up if it's consumable). Optional stock. A Streak Shield is always for sale.
 *   Work      a job every hour or so (a setting) for a random amount between two settings.
 *   Bank      coins in the bank are safe from your own bets and earn daily interest (a setting, capped per day).
 */
import { UserError } from '../../src/util.js';
import { MAX_SHIELDS } from '../../src/economy.js';

export const SHIELD_ID = 'shield';
export const SHOP_MAX = 25;
export const JOBS = [
  ['walked {n} dogs around the park', '🐕'], ['gave {n} puppies a bath', '🛁'], ['delivered {n} pizzas', '🍕'], ['fixed {n} bugs in a game', '🐛'],
  ['baked {n} batches of dog biscuits', '🍪'], ['helped {n} people find their lost cats', '🐈'], ['streamed for {n} hours', '🎥'], ['mowed {n} lawns', '🌱'],
  ['taught {n} dogs to sit', '🦴'], ['washed {n} cars', '🚗'], ['sold {n} lemonades', '🍋'], ['tutored {n} students', '📚'], ['fetched {n} sticks (professionally)', '🪵'],
  ['moderated a Discord server for {n} hours', '🛡️'], ['drew {n} commissions', '🎨'], ['ran {n} errands for the neighbours', '🛒'],
];

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
// ------------------------------------------------------------------ 3.1 starter items (every server has them)
/**
 * Built-in items. Staff can change their price or take them out of the shop (and bring them back); that choice is kept
 * as 'builtin:<id>' = { price, off }. price(ctx) is the default.
 */
export const STARTERS = {
  luck: { name: 'Lucky charm', emoji: '🍀', desc: 'Use it for +30% fishing luck for an hour.', price: (ctx) => Math.round(ctx.config.get('dailyBase') * 3) },
  workboost: { name: 'Work boost', emoji: '💼', desc: 'Use it for +50% from /work for 24 hours.', price: (ctx) => Math.round(ctx.config.get('dailyBase') * 4) },
  ticket: { name: 'Lottery ticket', emoji: '🎟️', desc: "One entry in this week's draw. Everything spent on tickets is the prize; the winner is drawn every Monday.", price: (ctx) => Math.max(1, Math.round(ctx.config.get('dailyBase') * 0.4)) },
  treat: { name: 'Pet treat', emoji: '🦴', desc: 'Use it to make your pet happier and less hungry right away.', price: (ctx) => Math.max(1, Math.round(ctx.config.get('dailyBase') * 0.6)) },
};
export const BOOSTS = { luck: { ms: 3600000, label: '+30% fishing luck' }, workboost: { ms: 86400000, label: '+50% from /work' } };
/** The starter items as they are in this server: { id, name, emoji, desc, price, off }. */
export function starters(ctx) {
  return Object.entries(STARTERS).map(([id, s]) => { const o = ctx.data.get(`builtin:${id}`) ?? {}; return { id, name: s.name, emoji: s.emoji, desc: s.desc, price: o.price ?? s.price(ctx), off: !!o.off }; });
}
export function setStarter(ctx, id, patch) {
  if (!STARTERS[id]) throw new UserError('That is not a built-in item.');
  if (patch.price != null && !(Math.floor(patch.price) >= 1)) throw new UserError('The price must be at least 1.');
  ctx.data.set(`builtin:${id}`, { ...(ctx.data.get(`builtin:${id}`) ?? {}), ...patch });
}
/** When a member's boost (luck or workboost) runs out, or 0. */
export const boostUntil = (ctx, userId, kind) => { const t = ctx.data.get(`boost:${kind}:${userId}`) ?? 0; return t > Date.now() ? t : 0; };
const weekOf = (now) => { const d = new Date(now), back = (d.getUTCDay() + 6) % 7; return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back)).toISOString().slice(0, 10); };
/** This week's lottery: { week, tickets, pool, mine }. */
export function lottery(ctx, userId = null, now = Date.now()) {
  const week = weekOf(now);
  const r = ctx.sql.get('SELECT COALESCE(SUM(count), 0) AS tickets, COALESCE(SUM(spent), 0) AS pool FROM economy_lottery WHERE guild_id = ? AND week = ?', ctx.guildId, week);
  const mine = userId ? ctx.sql.get('SELECT count FROM economy_lottery WHERE guild_id = ? AND week = ? AND user_id = ?', ctx.guildId, week, userId)?.count ?? 0 : 0;
  return { week, tickets: r.tickets, pool: r.pool, mine };
}
/**
 * Draws any finished week (one ticket = one chance) and pays the winner the whole pool. Returns the results.
 * h: { credit }. Runs from the shop task; a week is drawn once.
 */
export function drawLotteries(ctx, h, now = Date.now(), rand = Math.random) {
  const out = [];
  for (const { week } of ctx.sql.all('SELECT DISTINCT week FROM economy_lottery WHERE guild_id = ? AND week < ? AND drawn = 0', ctx.guildId, weekOf(now))) {
    const rows = ctx.sql.all('SELECT user_id, count, spent FROM economy_lottery WHERE guild_id = ? AND week = ?', ctx.guildId, week);
    const total = rows.reduce((a, r) => a + r.count, 0), pool = rows.reduce((a, r) => a + r.spent, 0);
    let pick = Math.floor(rand() * total), winner = rows[0]?.user_id;
    for (const r of rows) { if (pick < r.count) { winner = r.user_id; break; } pick -= r.count; }
    ctx.sql.run('UPDATE economy_lottery SET drawn = 1 WHERE guild_id = ? AND week = ?', ctx.guildId, week);
    if (winner && pool > 0) { h.credit(winner, pool, `lottery win (${week})`); out.push({ week, winner, pool, tickets: total, players: rows.length }); ctx.data.set('lottery:last', { week, winner, pool, tickets: total, at: now }); }
  }
  return out;
}

export const shopItems = (ctx) => ctx.sql.all('SELECT * FROM economy_shop WHERE guild_id = ? ORDER BY price ASC, name ASC', ctx.guildId);
export const shieldPrice = (ctx) => Math.max(1, Math.round(ctx.config.get('dailyBase') * 4));

/** Adds or replaces a shop item. */
export function addItem(ctx, { name, price, emoji = null, description = null, roleId = null, hours = 0, stock = null, message = null, consumable = false }) {
  const id = slug(name);
  if (!id) throw new UserError('Give the item a name with letters or numbers.');
  if (id === SHIELD_ID) throw new UserError('That name is used by the built-in Streak Shield.');
  if (!(price >= 1)) throw new UserError('The price must be at least 1.');
  const exists = ctx.sql.get('SELECT 1 FROM economy_shop WHERE guild_id = ? AND id = ?', ctx.guildId, id);
  if (!exists && shopItems(ctx).length >= SHOP_MAX) throw new UserError(`The shop can hold up to ${SHOP_MAX} items.`);
  ctx.sql.run(`INSERT INTO economy_shop (guild_id, id, name, emoji, price, description, role_id, hours, stock, message, consumable, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, id) DO UPDATE SET name = excluded.name, emoji = excluded.emoji, price = excluded.price, description = excluded.description, role_id = excluded.role_id,
    hours = excluded.hours, stock = excluded.stock, message = excluded.message, consumable = excluded.consumable`,
  ctx.guildId, id, String(name).slice(0, 60), emoji ? String(emoji).slice(0, 64) : null, Math.floor(price), description ? String(description).slice(0, 200) : null, roleId, Math.max(0, Math.floor(hours || 0)),
  stock == null || stock === '' ? null : Math.max(0, Math.floor(stock)), message ? String(message).slice(0, 500) : null, consumable ? 1 : 0, Date.now());
  return { id, replaced: !!exists };
}
export function removeItem(ctx, id) {
  const r = ctx.sql.run('DELETE FROM economy_shop WHERE guild_id = ? AND id = ?', ctx.guildId, id);
  if (!r.changes) throw new UserError('There is no item like that in the shop.');
}

export const inventory = (ctx, userId) => ctx.sql.all(`SELECT i.item_id AS id, i.qty, s.name, s.emoji, s.message, s.consumable FROM economy_items i LEFT JOIN economy_shop s ON s.guild_id = i.guild_id AND s.id = i.item_id
  WHERE i.guild_id = ? AND i.user_id = ? AND i.qty > 0 ORDER BY s.name`, ctx.guildId, userId)
  .map((x) => (x.id === 'padlock' ? { ...x, name: 'Padlock', emoji: '🔒', message: 'Your padlock is on. It stops the next robbery.', builtin: true }
    : STARTERS[x.id] ? { ...x, name: STARTERS[x.id].name, emoji: STARTERS[x.id].emoji, builtin: true, consumable: 1 } : x));

/**
 * Buys one of an item. h: { debit, member, wallet }. Returns { text } to show. Roles are given here; an item goes to the
 * inventory. Roles bought "for N hours" are written down and taken away by the shop task.
 */
export async function buy(ctx, userId, itemId, h) {
  if (STARTERS[itemId]) {
    const it = starters(ctx).find((x) => x.id === itemId);
    if (it.off) throw new UserError('That item is not for sale in this server.');
    ctx.sql.transaction(() => {
      h.debit(userId, it.price, `bought ${it.name}`);
      if (itemId === 'ticket') ctx.sql.run(`INSERT INTO economy_lottery (guild_id, week, user_id, count, spent, drawn) VALUES (?, ?, ?, 1, ?, 0)
        ON CONFLICT(guild_id, week, user_id) DO UPDATE SET count = count + 1, spent = spent + excluded.spent`, ctx.guildId, lottery(ctx).week, userId, it.price);
      else ctx.sql.run('INSERT INTO economy_items (guild_id, user_id, item_id, qty) VALUES (?, ?, ?, 1) ON CONFLICT(guild_id, user_id, item_id) DO UPDATE SET qty = qty + 1', ctx.guildId, userId, itemId);
    });
    if (itemId === 'ticket') { const l = lottery(ctx, userId); return { text: `🎟️ You're in this week's draw with **${l.mine}** ticket${l.mine === 1 ? '' : 's'}. The prize is up to **${l.pool.toLocaleString('en-US')}** coins and grows with every ticket. The winner is drawn on Monday.` }; }
    return { text: `${it.emoji} You bought a **${it.name}**. Use it from your inventory when you want it.` };
  }
  if (itemId === 'padlock') {
    if (!ctx.config.get('robbing')) throw new UserError('Robbing is off in this server, so you don\'t need a padlock.');
    const price = Math.max(1, Math.round(ctx.config.get('dailyBase') * 2));
    ctx.sql.transaction(() => { h.debit(userId, price, 'bought a Padlock'); ctx.sql.run("INSERT INTO economy_items (guild_id, user_id, item_id, qty) VALUES (?, ?, 'padlock', 1) ON CONFLICT(guild_id, user_id, item_id) DO UPDATE SET qty = qty + 1", ctx.guildId, userId); });
    return { text: '🔒 You bought a **Padlock**. It stops the next person who tries to rob you (and they pay you a fine).' };
  }
  if (itemId === SHIELD_ID) {
    const w = h.wallet(userId);
    if (w.shields >= MAX_SHIELDS) throw new UserError(`You already have ${MAX_SHIELDS} Streak Shields, the most you can hold.`);
    ctx.sql.transaction(() => { h.debit(userId, shieldPrice(ctx), 'bought a Streak Shield'); ctx.sql.run('UPDATE economy_wallets SET shields = shields + 1 WHERE guild_id = ? AND user_id = ?', ctx.guildId, userId); });
    return { text: `🛡️ You bought a **Streak Shield** (${w.shields + 1}/${MAX_SHIELDS}). It saves your daily streak if you miss a day.` };
  }
  const it = ctx.sql.get('SELECT * FROM economy_shop WHERE guild_id = ? AND id = ?', ctx.guildId, itemId);
  if (!it) throw new UserError('That item is no longer in the shop.');
  if (it.stock === 0) throw new UserError('That item is sold out.');
  if (it.role_id) {
    const member = h.member;
    if (!member) throw new UserError('You need to be in the server to buy a role.');
    const role = ctx.guild?.roles.cache.get(it.role_id);
    if (!role) throw new UserError('That role was deleted. Tell an admin to fix the shop.');
    if (member.roles.cache.has(it.role_id) && !it.hours) throw new UserError('You already have that role.');
    const me = ctx.guild?.members?.me;
    if (me && (role.managed || role.position >= (me.roles?.highest?.position ?? Infinity))) throw new UserError("I can't give that role (my role must be above it). Tell an admin.");
  }
  ctx.sql.transaction(() => {
    h.debit(userId, it.price, `bought ${it.name}`);
    if (it.stock != null) { const r = ctx.sql.run('UPDATE economy_shop SET stock = stock - 1 WHERE guild_id = ? AND id = ? AND stock > 0', ctx.guildId, itemId); if (!r.changes) throw new UserError('That item just sold out.'); }
    if (!it.role_id) ctx.sql.run('INSERT INTO economy_items (guild_id, user_id, item_id, qty) VALUES (?, ?, ?, 1) ON CONFLICT(guild_id, user_id, item_id) DO UPDATE SET qty = qty + 1', ctx.guildId, userId, itemId);
  });
  if (it.role_id) {
    await h.member.roles.add(it.role_id, `Bought in the shop: ${it.name}`).catch((e) => { h.move(userId, it.price, `refund: ${it.name}`); throw new UserError(`I couldn't give you the role, so you got your coins back. (${e.message})`); });
    if (it.hours) {
      const key = `shoprole:${userId}:${it.role_id}`;
      const until = Math.max(Date.now(), ctx.data.get(key) ?? 0) + it.hours * 3600000; // buying again adds time
      ctx.data.set(key, until);
      return { text: `${it.emoji ?? '🎁'} You bought **${it.name}**: you have <@&${it.role_id}> until <t:${Math.floor(until / 1000)}:f>.` };
    }
    return { text: `${it.emoji ?? '🎁'} You bought **${it.name}** and got <@&${it.role_id}>.` };
  }
  return { text: `${it.emoji ?? '🎁'} You bought **${it.name}**. It's in your inventory${it.message ? ': use it from `/shop`' : ''}.` };
}
/** Uses an inventory item: shows its message, and uses it up if it's consumable. */
export function useItem(ctx, userId, itemId, now = Date.now()) {
  const row = inventory(ctx, userId).find((x) => x.id === itemId);
  if (!row) throw new UserError("You don't have that item.");
  if (BOOSTS[itemId] || itemId === 'treat') {
    let text;
    if (itemId === 'treat') {
      const pet = ctx.sql.get('SELECT * FROM economy_pets WHERE guild_id = ? AND user_id = ?', ctx.guildId, userId);
      if (!pet) throw new UserError('You need a pet for that. Adopt one with `/pet adopt`.');
      const hrs = Math.max(0, (now - pet.updated_at) / 3600000);
      const hunger = Math.min(100, Math.max(0, Math.round(pet.hunger - hrs * 1.2)) + 20), happy = Math.min(100, Math.max(0, Math.round(pet.happy - hrs * 0.8)) + 40);
      ctx.sql.run('UPDATE economy_pets SET hunger = ?, happy = ?, xp = xp + 6, updated_at = ? WHERE guild_id = ? AND user_id = ?', hunger, happy, now, ctx.guildId, userId);
      text = `🦴 **${pet.name}** loves the treat! (happy ${happy}, fed ${hunger})`;
    } else {
      const b = BOOSTS[itemId], until = Math.max(now, ctx.data.get(`boost:${itemId}:${userId}`) ?? 0) + b.ms; // using another adds more time
      ctx.data.set(`boost:${itemId}:${userId}`, until);
      text = `${STARTERS[itemId].emoji} **${b.label}** until <t:${Math.floor(until / 1000)}:t>.`;
    }
    ctx.sql.run('UPDATE economy_items SET qty = qty - 1 WHERE guild_id = ? AND user_id = ? AND item_id = ?', ctx.guildId, userId, itemId);
    return { text: `${text}\n-# ${row.qty - 1} left.` };
  }
  if (!row.name) throw new UserError('That item was taken out of the shop, so it does nothing now.');
  if (row.consumable) ctx.sql.run('UPDATE economy_items SET qty = qty - 1 WHERE guild_id = ? AND user_id = ? AND item_id = ?', ctx.guildId, userId, itemId);
  return { text: `${row.emoji ?? '🎁'} ${row.message ? row.message.replace(/\{user\}/g, `<@${userId}>`) : `You looked at your **${row.name}**. Nice.`}${row.consumable ? `\n-# ${row.name} was used up (${row.qty - 1} left).` : ''}` };
}
/** Takes away shop roles whose time is up. */
export async function expireShopRoles(ctx, now = Date.now()) {
  let n = 0;
  for (const { key, value: until } of ctx.data.list('shoprole:')) {
    if (until > now) continue;
    const [, userId, roleId] = key.split(':');
    ctx.data.delete(key);
    const m = ctx.guild?.members.cache.get(userId) ?? await ctx.guild?.members.fetch(userId).catch(() => null);
    if (m?.roles.cache.has(roleId)) { await m.roles.remove(roleId, 'Shop role ran out').catch(() => {}); n++; }
  }
  return n;
}

// ------------------------------------------------------------------ work
/** Does a job if the cooldown is over. Returns { ok, coins, text, nextAt }. rand returns [0, 1). */
export function work(ctx, userId, h, now = Date.now(), rand = Math.random) {
  const every = Math.max(1, ctx.config.get('workCooldownMinutes')) * 60000;
  const w = h.wallet(userId);
  if (w.last_work && now - w.last_work < every) return { ok: false, nextAt: w.last_work + every };
  const lo = ctx.config.get('workMin'), hi = Math.max(lo, ctx.config.get('workMax'));
  const coins = lo + Math.floor(rand() * (hi - lo + 1));
  const [job, emoji] = JOBS[Math.floor(rand() * JOBS.length)];
  ctx.sql.transaction(() => { ctx.sql.run('UPDATE economy_wallets SET last_work = ? WHERE guild_id = ? AND user_id = ?', now, ctx.guildId, userId); h.credit(userId, coins, 'work'); });
  return { ok: true, coins, text: `${emoji} You ${job.replace('{n}', String(2 + Math.floor(rand() * 9)))}`, nextAt: now + every };
}

// ------------------------------------------------------------------ bank
/** Daily interest owed since it was last paid: rate% of the bank per full day, at most cap per day. */
export function interestDue(bank, lastPaid, now, ratePct, cap) {
  if (!bank || !lastPaid || ratePct <= 0) return { coins: 0, days: 0 };
  const days = Math.floor((now - lastPaid) / 86400000);
  if (days <= 0) return { coins: 0, days: 0 };
  let total = 0, b = bank;
  for (let d = 0; d < Math.min(days, 30); d++) { const add = Math.min(Math.floor((b * ratePct) / 100), cap > 0 ? cap : Infinity); total += add; b += add; }
  return { coins: total, days };
}
/** Pays any interest owed (into the bank) and returns the wallet row. */
export function settleBank(ctx, userId, h, now = Date.now()) {
  const w = h.wallet(userId);
  if (!w.bank_paid_at) { ctx.sql.run('UPDATE economy_wallets SET bank_paid_at = ? WHERE guild_id = ? AND user_id = ?', now, ctx.guildId, userId); return { ...w, bank_paid_at: now, interest: 0 }; }
  const due = interestDue(w.bank, w.bank_paid_at, now, ctx.config.get('bankInterest'), ctx.config.get('bankInterestCap'));
  if (!due.days) return { ...w, interest: 0 };
  ctx.sql.run('UPDATE economy_wallets SET bank = bank + ?, bank_paid_at = bank_paid_at + ? WHERE guild_id = ? AND user_id = ?', due.coins, due.days * 86400000, ctx.guildId, userId);
  return { ...h.wallet(userId), interest: due.coins };
}
export function deposit(ctx, userId, amount, h) {
  settleBank(ctx, userId, h);
  ctx.sql.transaction(() => { h.debit(userId, amount, 'bank deposit'); ctx.sql.run('UPDATE economy_wallets SET bank = bank + ? WHERE guild_id = ? AND user_id = ?', amount, ctx.guildId, userId); });
}
export function withdraw(ctx, userId, amount, h) {
  const w = settleBank(ctx, userId, h);
  if (amount > w.bank) throw new UserError(`You only have ${w.bank.toLocaleString('en-US')} in the bank.`);
  ctx.sql.transaction(() => { ctx.sql.run('UPDATE economy_wallets SET bank = bank - ? WHERE guild_id = ? AND user_id = ? AND bank >= ?', amount, ctx.guildId, userId, amount); h.move(userId, amount, 'bank withdrawal'); });
}
