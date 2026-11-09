/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Economy (2.2): wallets, daily streaks with Streak Shields, paying other members, and the live paginated
 * leaderboard (/top). 3.1 adds /shop (roles and items), an inventory, /work and /bank (modules/economy/shop.js). Every command that needs input goes through the modal pipeline (src/modalpipe.js):
 * no command here takes a typed option.
 *
 * Other modules (games) use the wallet through ctx.api('economy') and can add their own leaderboards.
 * Coins are play money: they cannot be bought, sold or cashed out.
 */
import { SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { createPipeline } from '../../src/modalpipe.js';
import { claimDaily, fmtNum, parseAmount, CLAIM_EVERY } from '../../src/economy.js';
import { PER_PAGE, pageCount, clampPage, renderRows, navComponents, unpackNav, nextPage } from '../../src/leaderboard.js';
import { UserError, ts, sanitizeName, truncate } from '../../src/util.js';
import { StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import * as SHOP from './shop.js';
import * as X from './extras.js';
import { randomBytes } from 'node:crypto';

const EPH = MessageFlags.Ephemeral;
// /daily, /balance and /top answer privately by default, so using them does not notify the whole channel.
const quiet = (ctx) => (ctx.config.get('privateReplies') ? { flags: EPH } : {});
const NOPING = { parse: [] };
const LB = 'econlb:';
const GOLD = 0xf1c40f;
const LEDGER_DAYS = 30;

// Per-server ctx for the api (filled in init). Kept on a global so a hot reload swaps it in place.
const ctxs = (globalThis[Symbol.for('goodboy.economy.ctxs')] ??= new Map());
// Leaderboards other modules registered (games adds fishing boards). id -> board
const boards = (globalThis[Symbol.for('goodboy.economy.boards')] ??= new Map());

// ------------------------------------------------------------------ wallet storage
const cfg = (ctx) => ({ name: ctx.config.get('currencyName'), emoji: ctx.config.get('currencyEmoji') });
export const money = (ctx, n) => `**${fmtNum(n)}** ${cfg(ctx).emoji}`;
const displayName = (u, member) => sanitizeName(member?.displayName ?? u?.globalName ?? u?.username ?? 'someone', 32) || 'someone';

function ensure(ctx, userId, name) {
  ctx.sql.run(`INSERT INTO economy_wallets (guild_id, user_id, name, coins, created_at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(guild_id, user_id) DO UPDATE SET name = COALESCE(excluded.name, economy_wallets.name)`,
  ctx.guildId, userId, name ?? null, ctx.config.get('startingCoins'), Date.now());
  return ctx.sql.get('SELECT * FROM economy_wallets WHERE guild_id = ? AND user_id = ?', ctx.guildId, userId);
}
const ledger = (ctx, userId, delta, reason) => ctx.sql.run('INSERT INTO economy_ledger (guild_id, user_id, delta, reason, at) VALUES (?, ?, ?, ?, ?)', ctx.guildId, userId, delta, String(reason).slice(0, 80), Date.now());

function credit(ctx, userId, amount, reason) {
  amount = Math.floor(amount);
  if (!(amount > 0)) return ensure(ctx, userId).coins;
  ensure(ctx, userId);
  ctx.sql.run('UPDATE economy_wallets SET coins = coins + ?, earned = earned + ? WHERE guild_id = ? AND user_id = ?', amount, amount, ctx.guildId, userId);
  ledger(ctx, userId, amount, reason);
  ctx.live?.('data');
  return ctx.sql.get('SELECT coins FROM economy_wallets WHERE guild_id = ? AND user_id = ?', ctx.guildId, userId).coins;
}
/** Takes coins only if they are there, in ONE statement, so two quick clicks can never spend the same coins twice. */
function debit(ctx, userId, amount, reason) {
  amount = Math.floor(amount);
  if (!(amount > 0)) throw new UserError('The amount must be more than zero.');
  ensure(ctx, userId);
  const r = ctx.sql.run('UPDATE economy_wallets SET coins = coins - ? WHERE guild_id = ? AND user_id = ? AND coins >= ?', amount, ctx.guildId, userId, amount);
  if (!r.changes) {
    const have = ctx.sql.get('SELECT coins FROM economy_wallets WHERE guild_id = ? AND user_id = ?', ctx.guildId, userId).coins;
    throw new UserError(`You only have ${money(ctx, have)}.`);
  }
  ledger(ctx, userId, -amount, reason);
  ctx.live?.('data');
  return ctx.sql.get('SELECT coins FROM economy_wallets WHERE guild_id = ? AND user_id = ?', ctx.guildId, userId).coins;
}

/** Adds coins without counting them as "earned" (bank withdrawals, refunds). */
function move(ctx, userId, amount, reason) {
  ensure(ctx, userId);
  ctx.sql.run('UPDATE economy_wallets SET coins = coins + ? WHERE guild_id = ? AND user_id = ?', Math.floor(amount), ctx.guildId, userId);
  ledger(ctx, userId, Math.floor(amount), reason);
  ctx.live?.('data');
}
const helpers = (ctx, member = null) => ({ wallet: (u) => ensure(ctx, u), debit: (u, n, r) => debit(ctx, u, n, r), credit: (u, n, r) => credit(ctx, u, n, r), move: (u, n, r) => move(ctx, u, n, r), member });

// ------------------------------------------------------------------ 3.1 shop, inventory, work, bank
function shopMessage(ctx, i, note) {
  const items = SHOP.shopItems(ctx);
  const staff = ctx.perms.check(i.member, 'economy.admin');
  const line = (it) => `${it.emoji ?? '🎁'} **${it.name}** · ${money(ctx, it.price)}${it.role_id ? ` · gives <@&${it.role_id}>${it.hours ? ` for ${it.hours} h` : ''}` : ''}${it.stock != null ? ` · ${it.stock ? `${it.stock} left` : '**sold out**'}` : ''}${it.description ? `\n-# ${truncate(it.description, 150)}` : ''}`;
  const e = new EmbedBuilder().setColor(GOLD).setTitle('🛍️ Shop')
    .setDescription([note, `You have ${money(ctx, ensure(ctx, i.user.id).coins)}.`, '', `🛡️ **Streak Shield** · ${money(ctx, SHOP.shieldPrice(ctx))}\n-# Saves your daily streak if you miss a day (hold up to 3).`,
      ctx.config.get('robbing') ? `🔒 **Padlock** · ${money(ctx, X.padlockPrice(ctx))}\n-# Stops the next robbery, and the robber pays you a fine.` : null,
      ...SHOP.starters(ctx).filter((x) => !x.off).map((x) => `${x.emoji} **${x.name}** · ${money(ctx, x.price)}\n-# ${x.id === 'ticket' ? `${x.desc} This week: ${money(ctx, SHOP.lottery(ctx).pool)} from ${SHOP.lottery(ctx).tickets} tickets.` : x.desc}`),
      ...items.map(line),
      !items.length ? `\n-# ${staff ? 'Add roles or items with **Add item** below.' : 'Staff can add roles and items here.'}` : null].filter((x) => x != null).join('\n'));
  const opts = [{ label: `Streak Shield (${fmtNum(SHOP.shieldPrice(ctx))})`, value: SHOP.SHIELD_ID, emoji: '🛡️' }, ...(ctx.config.get('robbing') ? [{ label: `Padlock (${fmtNum(X.padlockPrice(ctx))})`, value: X.PADLOCK_ID, emoji: '🔒' }] : []),
    ...SHOP.starters(ctx).filter((x) => !x.off).map((x) => ({ label: `${x.name} (${fmtNum(x.price)})`, value: x.id, emoji: x.emoji })), ...items.filter((it) => it.stock !== 0).map((it) => ({ label: truncate(`${it.name} (${fmtNum(it.price)})`, 100), value: it.id, emoji: it.emoji }))].slice(0, 25);
  const rows = [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`econ:buy:${i.user.id}`).setPlaceholder('Buy something...')
    .addOptions(opts.map((o) => { const b = new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value); if (o.emoji && !/^<a?:/.test(o.emoji)) b.setEmoji(o.emoji); return b; })))];
  const buttons = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`econ:inv:${i.user.id}`).setEmoji('🎒').setLabel('Inventory').setStyle(ButtonStyle.Secondary));
  if (staff) {
    buttons.addComponents(pipe.button(i, 'shopadd', [], { label: 'Add item', emoji: '➕', style: ButtonStyle.Success }));
    buttons.addComponents(new ButtonBuilder().setCustomId(`econ:rmlist:${i.user.id}`).setEmoji('🗑️').setLabel('Remove item').setStyle(ButtonStyle.Danger));
  }
  rows.push(buttons);
  return { embeds: [e], components: rows, allowedMentions: NOPING };
}
function inventoryMessage(ctx, i, note) {
  const inv = SHOP.inventory(ctx, i.user.id);
  const e = new EmbedBuilder().setColor(GOLD).setTitle('🎒 Inventory')
    .setDescription([note, inv.length ? inv.map((x) => `${x.emoji ?? '🎁'} **${x.name ?? `${x.id} (no longer in the shop)`}** × ${x.qty}`).join('\n') : 'Nothing yet. Buy something in the shop!'].filter(Boolean).join('\n\n'));
  const usable = inv.filter((x) => x.name);
  const rows = [];
  if (usable.length) rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`econ:use:${i.user.id}`).setPlaceholder('Use an item...')
    .addOptions(usable.slice(0, 25).map((x) => new StringSelectMenuOptionBuilder().setLabel(truncate(`${x.name} × ${x.qty}`, 100)).setValue(x.id)))));
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`econ:shop:${i.user.id}`).setEmoji('🛍️').setLabel('Shop').setStyle(ButtonStyle.Secondary)));
  return { embeds: [e], components: rows, allowedMentions: NOPING };
}
function bankMessage(ctx, i, note) {
  const w = SHOP.settleBank(ctx, i.user.id, helpers(ctx));
  const rate = ctx.config.get('bankInterest'), cap = ctx.config.get('bankInterestCap');
  const e = new EmbedBuilder().setColor(GOLD).setTitle('🏦 Bank')
    .setDescription([note, w.interest ? `💹 You earned ${money(ctx, w.interest)} interest since you last looked.` : null].filter(Boolean).join('\n') || null)
    .addFields({ name: 'Wallet', value: money(ctx, w.coins), inline: true }, { name: 'Bank', value: money(ctx, w.bank), inline: true },
      { name: 'Interest', value: rate > 0 ? `${rate}% a day${cap ? `, up to ${money(ctx, cap)} a day` : ''}` : 'Off in this server', inline: true })
    .setFooter({ text: 'Bets and purchases use your wallet, so coins in the bank are safe from them.' });
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(
    pipe.button(i, 'deposit', [], { label: 'Deposit', emoji: '📥', style: ButtonStyle.Success }),
    pipe.button(i, 'withdraw', [], { label: 'Withdraw', emoji: '📤' }))], allowedMentions: NOPING };
}
async function workCmd(ctx, i) {
  ensure(ctx, i.user.id, displayName(i.user, i.member));
  const r = SHOP.work(ctx, i.user.id, helpers(ctx));
  if (!r.ok) return i.reply({ content: `😴 You're tired. You can work again ${ts(r.nextAt)}.`, flags: EPH });
  const pet = X.getPet(ctx, i.user.id), boosted = SHOP.boostUntil(ctx, i.user.id, 'workboost') > 0, pct = X.petBonus(pet) + (boosted ? 50 : 0), extra = Math.floor((r.coins * pct) / 100);
  if (extra > 0) credit(ctx, i.user.id, extra, 'work (bonus)');
  const e = new EmbedBuilder().setColor(GOLD).setDescription(`${r.text} and earned ${money(ctx, r.coins)}${extra ? ` + ${money(ctx, extra)} (${[boosted ? '💼 work boost' : null, pet && X.petBonus(pet) ? `${pet.name} cheered you on` : null].filter(Boolean).join(', ')}: +${pct}%)` : ''}.\n-# You can work again ${ts(r.nextAt)}.`);
  return i.reply({ embeds: [e], allowedMentions: NOPING, ...quiet(ctx) });
}
async function robCmd(ctx, i) {
  const target = i.options.getUser('member', true);
  ensure(ctx, i.user.id, displayName(i.user, i.member));
  const o = await X.rob(ctx, i.user.id, target, helpers(ctx));
  const text = o.outcome === 'stole' ? `🦹 <@${i.user.id}> robbed <@${target.id}> and got away with ${money(ctx, o.coins)}!`
    : o.outcome === 'padlock' ? `🔒 <@${target.id}>'s padlock stopped <@${i.user.id}>! The padlock broke, and the robber paid ${money(ctx, o.coins)} as a fine.`
      : `🚓 <@${i.user.id}> got caught trying to rob <@${target.id}> and paid them ${money(ctx, o.coins)}.`;
  return i.reply({ content: text, allowedMentions: { users: [target.id] } });
}
function petCard(ctx, p, note) {
  const n = X.petNow(p), k = X.PETS[p.kind], bar = (v) => `${'█'.repeat(Math.round(v / 10))}${'░'.repeat(10 - Math.round(v / 10))} ${v}`;
  return new EmbedBuilder().setColor(GOLD).setTitle(`${k.emoji} ${p.name} · level ${X.petLevel(p.xp)}`)
    .setDescription([note, `🍖 Fed  \`${bar(n.hunger)}\``, `💖 Happy \`${bar(n.happy)}\``, `💼 Adds **+${X.petBonus(p)}%** to /work`].filter(Boolean).join('\n'))
    .setFooter({ text: 'Feed (50 coins) and play every 30 minutes. A fed, happy pet helps more.' });
}
async function petCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  ensure(ctx, i.user.id, displayName(i.user, i.member));
  if (sub === 'adopt') { const p = X.adopt(ctx, i.user.id, i.options.getString('kind', true), i.options.getString('name'), helpers(ctx)); return i.reply({ embeds: [petCard(ctx, p, `🎉 Welcome home, **${p.name}**!`)], allowedMentions: NOPING, ...quiet(ctx) }); }
  if (sub === 'feed' || sub === 'play') { const r = X.care(ctx, i.user.id, sub, helpers(ctx)); return i.reply({ embeds: [petCard(ctx, r.pet, r.text)], allowedMentions: NOPING, ...quiet(ctx) }); }
  const who = i.options.getUser('member') ?? i.user;
  const p = X.getPet(ctx, who.id);
  if (!p) throw new UserError(who.id === i.user.id ? "You don't have a pet yet. Adopt one with `/pet adopt`." : "They don't have a pet.");
  return i.reply({ embeds: [petCard(ctx, p)], allowedMentions: NOPING, ...quiet(ctx) });
}
// Chat events: every so many messages (and at most one every 10 minutes per server).
const evCounts = (globalThis[Symbol.for('goodboy.economy.evCounts')] ??= new Map());
const evLive = (globalThis[Symbol.for('goodboy.economy.evLive')] ??= new Map()); // id -> { kind, prize, takers:Set, done, guildId }
async function onMessage(ctx, m) {
  if (!m.guildId || m.author?.bot || m.webhookId || !ctx.config.get('events')) return;
  const c = evCounts.get(ctx.guildId) ?? { n: 0, need: 0, last: 0 };
  const every = ctx.config.get('eventEvery');
  if (!c.need) c.need = Math.max(10, Math.round(every * (0.6 + Math.random() * 0.8)));
  c.n += 1; evCounts.set(ctx.guildId, c);
  if (c.n < c.need || Date.now() - c.last < 10 * 60000) return;
  evCounts.set(ctx.guildId, { n: 0, need: 0, last: Date.now() });
  await startEvent(ctx, m.channel);
}
/** Posts a chat event. Exported through the module for tests. */
export async function startEvent(ctx, channel, ev = X.EVENTS[Math.floor(Math.random() * X.EVENTS.length)], prize = X.eventPrize(ctx)) {
  const id = randomBytes(5).toString('hex');
  evLive.set(id, { kind: ev.kind, prize, takers: new Set(), done: false, guildId: ctx.guildId });
  const e = new EmbedBuilder().setColor(GOLD).setTitle(`${ev.emoji} ${ev.title}`).setDescription(`It holds ${money(ctx, prize)}. ${ev.text}`);
  const msg = await channel.send({ embeds: [e], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`econ:ev:${id}`).setLabel(ev.button).setEmoji(ev.emoji).setStyle(ButtonStyle.Success))] }).catch(() => null);
  if (!msg) { evLive.delete(id); return null; }
  const finish = async () => {
    const st = evLive.get(id); if (!st || st.done) return; st.done = true; evLive.delete(id);
    if (st.kind === 'split') {
      const who = [...st.takers], parts = X.shares(prize, who.length);
      who.forEach((u, k) => credit(ctx, u, parts[k], 'chat event'));
      await msg.edit({ embeds: [EmbedBuilder.from(e).setDescription(who.length ? `${who.length} ${who.length === 1 ? 'person' : 'people'} shared ${money(ctx, prize)}: ${who.map((u) => `<@${u}>`).join(', ')}` : 'Nobody took a share. It washed away...')], components: [], allowedMentions: NOPING }).catch(() => {});
    } else await msg.edit({ embeds: [EmbedBuilder.from(e).setDescription('Nobody grabbed it in time. It\'s gone!')], components: [] }).catch(() => {});
  };
  const t = setTimeout(finish, ev.kind === 'split' ? 30000 : 120000); t.unref?.();
  evLive.get(id).finish = finish; evLive.get(id).msg = msg;
  return id;
}
async function eventClick(ctx, i, id) {
  const st = evLive.get(id);
  if (!st || st.done) throw new UserError('Too late, that one is over.');
  ensure(ctx, i.user.id, displayName(i.user, i.member));
  if (st.kind === 'split') { st.takers.add(i.user.id); return i.reply({ content: `You're in! ${st.takers.size} so far. The coins are shared when time runs out.`, flags: EPH }); }
  st.done = true; evLive.delete(id);
  credit(ctx, i.user.id, st.prize, 'chat event');
  return i.update({ embeds: [new EmbedBuilder().setColor(GOLD).setDescription(`🏃 <@${i.user.id}> got there first and won ${money(ctx, st.prize)}!`)], components: [], allowedMentions: NOPING });
}

const own = (i, owner) => { if (owner !== i.user.id) throw new UserError('That menu belongs to someone else. Run the command for your own.'); };

// ------------------------------------------------------------------ leaderboards
const globalGuilds = (ctx) => ctx.sql.all("SELECT guild_id FROM module_config WHERE module = 'economy' AND key = 'globalBoard' AND value = 'true'").map((r) => r.guild_id);

function registerBoard(b) {
  if (!/^[a-z0-9-]{1,12}$/.test(b.id) || !b.source || !b.label || typeof b.format !== 'function') throw new Error(`economy: bad leaderboard "${b.id}"`);
  boards.set(b.id, b);
}
registerBoard({ id: 'coins', label: 'Richest', emoji: '🪙', source: 'SELECT guild_id, user_id, name, coins AS value FROM economy_wallets WHERE coins > 0', format: (ctx, v) => money(ctx, v) });
registerBoard({ id: 'streak', label: 'Daily streak', emoji: '🔥', source: 'SELECT guild_id, user_id, name, streak AS value FROM economy_wallets WHERE streak > 0 AND last_daily > 0', format: (ctx, v) => `**${fmtNum(v)}** day${v === 1 ? '' : 's'}` });

/** Reads one page straight from the database. Global = one line per person (their best server), opted-in servers only. */
export function boardPage(ctx, boardId, scope, page, viewerId) {
  const b = boards.get(boardId) ?? boards.get('coins');
  const ids = scope === 'global' ? globalGuilds(ctx) : [ctx.guildId];
  if (!ids.length) return { board: b, rows: [], total: 0, page: 0, pages: 1, me: null };
  const marks = ids.map(() => '?').join(',');
  const base = scope === 'global'
    ? `SELECT user_id, MAX(name) AS name, MAX(value) AS value FROM (${b.source}) WHERE guild_id IN (${marks}) GROUP BY user_id`
    : `SELECT user_id, name, value FROM (${b.source}) WHERE guild_id IN (${marks})`;
  const total = ctx.sql.get(`SELECT COUNT(*) AS n FROM (${base})`, ...ids).n;
  const p = clampPage(page, total);
  const rows = ctx.sql.all(`SELECT * FROM (${base}) ORDER BY value DESC, user_id ASC LIMIT ? OFFSET ?`, ...ids, PER_PAGE, p * PER_PAGE);
  const mine = ctx.sql.get(`SELECT value FROM (${base}) WHERE user_id = ?`, ...ids, viewerId);
  const me = mine ? { value: mine.value, rank: ctx.sql.get(`SELECT COUNT(*) AS n FROM (${base}) WHERE value > ?`, ...ids, mine.value).n + 1 } : null;
  return { board: b, rows, total, page: p, pages: pageCount(total), me };
}

function boardMessage(ctx, owner, boardId, scope, page) {
  const d = boardPage(ctx, boardId, scope, page, owner);
  const who = (r) => (scope === 'global' ? `**${r.name ?? 'someone'}**` : `<@${r.user_id}>`);
  const optedIn = scope !== 'global' || ctx.config.get('globalBoard');
  const e = new EmbedBuilder().setColor(GOLD)
    .setTitle(`${d.board.emoji ?? '🏆'} ${d.board.label} · ${scope === 'global' ? 'Global' : ctx.guild?.name ?? 'This server'}`)
    .setDescription(renderRows(d.rows, d.page * PER_PAGE, (r) => `${who(r)} · ${d.board.format(ctx, r.value)}`))
    .addFields({ name: 'You', value: d.me ? `#${fmtNum(d.me.rank)} · ${d.board.format(ctx, d.me.value)}` : optedIn ? '*Not on this board yet*' : '*This server is not on the global board. Admins can turn it on in `/config` > economy.*' })
    .setFooter({ text: `${fmtNum(d.total)} ${d.total === 1 ? 'entry' : 'entries'} · page ${d.page + 1} of ${d.pages} · live` }).setTimestamp();
  const list = [...boards.values()].filter((b) => !b.module || ctx.isActive(b.module));
  return { embeds: [e], components: navComponents(LB, { owner, board: d.board.id, scope, page: d.page, pages: d.pages, boards: list }), allowedMentions: NOPING };
}

async function boardClick(ctx, i) {
  const nav = unpackNav(LB, i.customId);
  if (!nav) throw new UserError('That leaderboard button is broken. Run `/top` again.');
  // Session lock: only the person who opened this board can page it. Everyone else gets their own private copy.
  if (nav.owner !== i.user.id) {
    return i.reply({ ...boardMessage(ctx, i.user.id, nav.board, nav.scope, 0), content: 'That board belongs to someone else, so here is your own copy.', flags: EPH });
  }
  const board = nav.action === 'board' ? (i.values?.[0] ?? nav.board) : nav.board;
  const page = nav.action === 'board' ? 0 : nextPage(nav.action, nav.page);
  return i.update(boardMessage(ctx, nav.owner, board, nav.scope, page)); // fresh data on every click
}

// ------------------------------------------------------------------ cards
function walletCard(ctx, user, member) {
  const w = ensure(ctx, user.id, displayName(user, member));
  const rank = w.coins > 0 ? ctx.sql.get('SELECT COUNT(*) AS n FROM economy_wallets WHERE guild_id = ? AND coins > ?', ctx.guildId, w.coins).n + 1 : null;
  const ready = !w.last_daily || Date.now() - w.last_daily >= CLAIM_EVERY;
  return new EmbedBuilder().setColor(GOLD).setAuthor({ name: displayName(user, member), iconURL: user.displayAvatarURL?.() })
    .addFields(
      { name: 'Wallet', value: money(ctx, w.coins), inline: true },
      { name: 'Rank', value: rank ? `#${fmtNum(rank)}` : '—', inline: true },
      { name: 'Daily streak', value: `🔥 ${w.streak} (best ${w.best_streak})  ·  🛡️ ${w.shields}`, inline: false },
      { name: 'Next daily', value: ready ? '✅ Ready now' : ts(w.last_daily + CLAIM_EVERY), inline: true },
      { name: 'Earned in total', value: money(ctx, w.earned), inline: true },
    );
}

async function claim(ctx, i) {
  ensure(ctx, i.user.id, displayName(i.user, i.member));
  let out;
  ctx.sql.transaction(() => {
    const w = ctx.sql.get('SELECT * FROM economy_wallets WHERE guild_id = ? AND user_id = ?', ctx.guildId, i.user.id);
    out = claimDaily({ streak: w.streak, lastDaily: w.last_daily, shields: w.shields, bestStreak: w.best_streak }, ctx.config.get('dailyBase'));
    if (!out.ok) return;
    ctx.sql.run('UPDATE economy_wallets SET streak = ?, best_streak = ?, shields = ?, last_daily = ? WHERE guild_id = ? AND user_id = ?', out.streak, out.bestStreak, out.shields, out.lastDaily, ctx.guildId, i.user.id);
    credit(ctx, i.user.id, out.total, `daily (streak ${out.streak})`);
  });
  if (!out.ok) return i.reply({ content: `⏳ You already claimed. Your next daily is ready ${ts(out.nextAt)}.`, flags: EPH });
  ctx.live('activity', { icon: '🔥', text: `${displayName(i.user, i.member)} claimed their daily (day ${out.streak})` });
  const lines = [`You got ${money(ctx, out.reward)}${out.bonus ? ` + ${money(ctx, out.bonus)} **day ${out.streak} bonus!**` : ''}`];
  if (out.usedShield) lines.push('🛡️ A Streak Shield saved your streak.');
  if (out.lost) lines.push('💔 You missed a day, so your streak started again.');
  if (out.shieldEarned) lines.push(`🛡️ You earned a Streak Shield (${out.shields}/3). It saves your streak if you miss a day.`);
  lines.push(`Next daily ${ts(out.nextAt)}.`);
  const e = new EmbedBuilder().setColor(GOLD).setTitle(`🔥 Day ${out.streak} streak`).setDescription(lines.join('\n'))
    .setFooter({ text: `Streak bonus: +${Math.round((out.reward / ctx.config.get('dailyBase') - 1) * 100)}% · it grows every day you come back` });
  return i.reply({ embeds: [e], components: [quickRow(ctx, i, { daily: false })], allowedMentions: NOPING, ...quiet(ctx) });
}

function quickRow(ctx, i, { daily = true } = {}) {
  const row = new ActionRowBuilder();
  if (daily) row.addComponents(new ButtonBuilder().setCustomId(`econ:daily:${i.user.id}`).setEmoji('🎁').setLabel('Daily').setStyle(ButtonStyle.Success));
  row.addComponents(new ButtonBuilder().setCustomId(`econ:top:${i.user.id}`).setEmoji('🏆').setLabel('Leaderboard').setStyle(ButtonStyle.Secondary));
  row.addComponents(pipe.button(i, 'pay', [], { label: 'Pay someone', emoji: '💸' }));
  return row;
}

async function quickClick(ctx, i) {
  const [, what] = i.customId.split(':');
  if (what === 'daily') return claim(ctx, i);
  if (what === 'top') return i.reply({ ...boardMessage(ctx, i.user.id, 'coins', 'server', 0), flags: EPH });
  const owner = i.customId.split(':')[2];
  if (what === 'ev') return eventClick(ctx, i, owner);
  if (what === 'buy') { own(i, owner); const r = await SHOP.buy(ctx, i.user.id, i.values?.[0], helpers(ctx, i.member)); return i.update(shopMessage(ctx, i, `✅ ${r.text}`)); }
  if (what === 'inv') { own(i, owner); return i.update(inventoryMessage(ctx, i)); }
  if (what === 'shop') { own(i, owner); return i.update(shopMessage(ctx, i)); }
  if (what === 'use') { own(i, owner); const r = SHOP.useItem(ctx, i.user.id, i.values?.[0]); await i.update(inventoryMessage(ctx, i)); return i.followUp({ content: r.text, allowedMentions: { users: [i.user.id] } }); }
  if (what === 'rmlist') {
    own(i, owner);
    if (!ctx.perms.check(i.member, 'economy.admin')) throw new UserError('Only staff can change the shop.');
    return i.reply({ content: 'Which item should go?', flags: EPH, components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`econ:rm:${i.user.id}`).setPlaceholder('Pick an item to remove')
      .addOptions([...SHOP.starters(ctx).filter((x) => !x.off).map((x) => ({ name: `${x.name} (built-in)`, id: `builtin:${x.id}` })), ...SHOP.shopItems(ctx)].slice(0, 25).map((it) => new StringSelectMenuOptionBuilder().setLabel(truncate(it.name, 100)).setValue(it.id))))] });
  }
  if (what === 'rm') {
    own(i, owner);
    if (!ctx.perms.check(i.member, 'economy.admin')) throw new UserError('Only staff can change the shop.');
    const v = i.values?.[0] ?? '';
    if (v.startsWith('builtin:')) SHOP.setStarter(ctx, v.slice(8), { off: true }); else SHOP.removeItem(ctx, v);
    return i.update({ content: `Removed from the shop. Members who bought it keep what they have.${v.startsWith('builtin:') ? ' Built-in items can be brought back on the dashboard\'s Shop page.' : ''}`, components: [] });
  }
  throw new UserError('That button is no longer active.');
}

// ------------------------------------------------------------------ popups
const pipe = createPipeline({
  ns: 'mpx',
  forms: {
    pay: {
      title: 'Pay a member', permission: 'economy.use', color: GOLD,
      button: { label: 'Configure payment', emoji: '💸' },
      intro: (ctx, i) => `You have ${money(ctx, ensure(ctx, i.user.id).coins)}. Pick who to pay and how much in the form.`,
      fields: (ctx, i, [target]) => [
        ...(target ? [] : [{ id: 'to', kind: 'user', label: 'Who to pay' }]),
        { id: 'amount', label: 'Amount', placeholder: 'e.g. 500, 2.5k, half or all', max: 20 },
        { id: 'note', label: 'Note (optional)', required: false, max: 100, placeholder: 'What it is for' },
      ],
      async submit(ctx, i, v, [target]) {
        const to = target ?? v.to;
        if (!to) throw new UserError('Pick who to pay.');
        if (to === i.user.id) throw new UserError('You cannot pay yourself.');
        const member = await ctx.guild?.members.fetch(to).catch(() => null);
        if (!member) throw new UserError('That person is not in this server.');
        if (member.user?.bot) throw new UserError('Bots do not need coins.');
        const have = ensure(ctx, i.user.id, displayName(i.user, i.member)).coins;
        const amt = parseAmount(v.amount, { have, max: ctx.config.get('maxPay') });
        if (amt.error) throw new UserError(amt.error);
        ensure(ctx, to, displayName(member.user, member));
        ctx.sql.transaction(() => { debit(ctx, i.user.id, amt.value, `pay to ${to}`); credit(ctx, to, amt.value, `pay from ${i.user.id}`); });
        const e = new EmbedBuilder().setColor(GOLD).setDescription(`💸 <@${i.user.id}> paid <@${to}> ${money(ctx, amt.value)}${v.note ? `\n> ${sanitizeName(v.note, 100)}` : ''}`);
        return i.reply({ embeds: [e], allowedMentions: { users: [to] }, content: `<@${to}>` });
      },
    },
    shopadd: {
      title: 'Add to the shop', permission: 'economy.admin', color: GOLD,
      button: { label: 'Add item', emoji: '➕', style: ButtonStyle.Success },
      intro: 'Sell a role (pick one) or a collectible item (leave the role empty). Using the same name again replaces that item.',
      fields: () => [
        { id: 'name', label: 'Name', max: 60, placeholder: 'e.g. VIP or Golden Bone' },
        { id: 'price', label: 'Price', max: 15, placeholder: 'e.g. 5000 or 5k' },
        { id: 'role', kind: 'role', label: 'Role it gives (empty for an item)', required: false },
        { id: 'details', label: 'Hours | stock | emoji (all optional)', max: 60, required: false, placeholder: 'e.g. 24 | 10 | 🦴  (24 h role, 10 for sale)' },
        { id: 'message', label: 'Description, or what using the item says', kind: 'paragraph', max: 500, required: false, placeholder: 'Items: {user} is replaced with the buyer. Start with ! to use it up when used.' },
      ],
      async submit(ctx, i, v) {
        const price = parseAmount(v.price, { min: 1, max: 1e12 });
        if (price.error) throw new UserError(price.error);
        const [hours, stock, emoji] = String(v.details ?? '').split('|').map((x) => x.trim());
        if (hours && !/^\d+$/.test(hours)) throw new UserError('Hours must be a whole number (or empty).');
        if (stock && !/^\d+$/.test(stock)) throw new UserError('Stock must be a whole number (or empty for unlimited).');
        const text = String(v.message ?? '').trim();
        const consumable = text.startsWith('!');
        const r = SHOP.addItem(ctx, { name: v.name, price: price.value, roleId: v.role || null, hours: v.role ? Number(hours || 0) : 0, stock: stock === '' || stock == null ? null : Number(stock), emoji: emoji || null,
          description: v.role ? text || null : null, message: v.role ? null : (consumable ? text.slice(1).trim() : text) || null, consumable });
        return i.reply({ content: `✅ ${r.replaced ? 'Updated' : 'Added'} **${truncate(v.name, 60)}** for ${money(ctx, price.value)}. Members buy it with \`/shop\`.`, flags: EPH, allowedMentions: NOPING });
      },
    },
    deposit: {
      title: 'Put coins in the bank', permission: 'economy.use', color: GOLD,
      button: { label: 'Deposit', emoji: '📥', style: ButtonStyle.Success },
      intro: (ctx, i) => `You have ${money(ctx, ensure(ctx, i.user.id).coins)} in your wallet.`,
      fields: () => [{ id: 'amount', label: 'How much', placeholder: 'e.g. 500, 2.5k, half or all', max: 20 }],
      async submit(ctx, i, v) {
        const amt = parseAmount(v.amount, { have: ensure(ctx, i.user.id).coins });
        if (amt.error) throw new UserError(amt.error);
        SHOP.deposit(ctx, i.user.id, amt.value, helpers(ctx));
        return i.reply({ ...bankMessage(ctx, i, `📥 Put ${money(ctx, amt.value)} in the bank.`), flags: EPH });
      },
    },
    withdraw: {
      title: 'Take coins out of the bank', permission: 'economy.use', color: GOLD,
      button: { label: 'Withdraw', emoji: '📤' },
      intro: (ctx, i) => `You have ${money(ctx, SHOP.settleBank(ctx, i.user.id, helpers(ctx)).bank)} in the bank.`,
      fields: () => [{ id: 'amount', label: 'How much', placeholder: 'e.g. 500, 2.5k, half or all', max: 20 }],
      async submit(ctx, i, v) {
        const amt = parseAmount(v.amount, { have: SHOP.settleBank(ctx, i.user.id, helpers(ctx)).bank });
        if (amt.error) throw new UserError(amt.error);
        SHOP.withdraw(ctx, i.user.id, amt.value, helpers(ctx));
        return i.reply({ ...bankMessage(ctx, i, `📤 Took ${money(ctx, amt.value)} out of the bank.`), flags: EPH });
      },
    },
    adjust: {
      title: 'Adjust a wallet', permission: 'economy.admin', color: GOLD,
      button: { label: 'Configure adjustment', emoji: '🛠️', style: ButtonStyle.Danger },
      intro: 'Give, take or set coins for one member. Every change is written to the ledger with your reason.',
      fields: () => [
        { id: 'who', kind: 'user', label: 'Member' },
        { id: 'op', kind: 'select', label: 'Action', value: 'give', options: [{ label: 'Give coins', value: 'give' }, { label: 'Take coins', value: 'take' }, { label: 'Set balance to', value: 'set' }] },
        { id: 'amount', label: 'Amount', placeholder: 'e.g. 1000 or 10k', max: 20 },
        { id: 'reason', label: 'Reason (kept in the ledger)', kind: 'paragraph', max: 200 },
      ],
      async submit(ctx, i, v) {
        const amt = parseAmount(v.amount, { min: 0, max: 1e12 });
        if (amt.error) throw new UserError(amt.error);
        const member = await ctx.guild?.members.fetch(v.who).catch(() => null);
        const w = ensure(ctx, v.who, member ? displayName(member.user, member) : null);
        const reason = `admin ${i.user.id}: ${v.reason}`;
        let now;
        ctx.sql.transaction(() => {
          if (v.op === 'give') now = credit(ctx, v.who, amt.value, reason);
          else if (v.op === 'take') { const take = Math.min(amt.value, w.coins); now = take > 0 ? debit(ctx, v.who, take, reason) : w.coins; }
          else { ctx.sql.run('UPDATE economy_wallets SET coins = ? WHERE guild_id = ? AND user_id = ?', amt.value, ctx.guildId, v.who); ledger(ctx, v.who, amt.value - w.coins, reason); now = amt.value; }
        });
        ctx.log.info(`Wallet of ${v.who} adjusted by ${i.user.id}: ${v.op} ${amt.value} (${v.reason})`);
        return i.reply({ content: `✅ <@${v.who}> now has ${money(ctx, now)}.`, flags: EPH, allowedMentions: NOPING });
      },
    },
  },
});

// ------------------------------------------------------------------ module
export default {
  name: 'economy',
  version: '1.0.0',
  description: 'Coins, daily streaks, paying members and live leaderboards',
  memberIntroTitle: 'coins are here',
  memberIntro: "everyone has a wallet now. do /daily every day for free coins (keep your streak going and you get more), /balance to see what you've got, /pay to send coins to someone, and /top to see who's richest",
  settings: [
    { key: 'privateReplies', type: 'toggle', label: 'Only the member sees /daily, /balance and /top (keeps the channel quiet)', default: true },
    { key: 'currencyName', type: 'text', label: 'Currency name', default: 'coins', maxLength: 20 },
    { key: 'currencyEmoji', type: 'text', label: 'Currency emoji', default: '🪙', maxLength: 64 },
    { key: 'startingCoins', type: 'number', label: 'Coins a new member starts with', default: 500, min: 0, max: 1000000 },
    { key: 'dailyBase', type: 'number', label: 'Daily reward (before streak bonus)', default: 250, min: 1, max: 1000000 },
    { key: 'maxPay', type: 'number', label: 'Most coins in one payment', default: 1000000, min: 1, max: 1000000000 },
    { key: 'workMin', type: 'number', label: '/work pays at least', default: 50, min: 0, max: 1000000 },
    { key: 'workMax', type: 'number', label: '/work pays at most', default: 200, min: 1, max: 1000000 },
    { key: 'workCooldownMinutes', type: 'number', label: 'Minutes between /work', default: 60, min: 1, max: 1440 },
    { key: 'bankInterest', type: 'number', label: 'Bank interest per day (%)', default: 1, min: 0, max: 10 },
    { key: 'bankInterestCap', type: 'number', label: 'Most interest one member earns per day (0 = no limit)', default: 1000, min: 0, max: 100000000 },
    { key: 'lotteryChannel', type: 'channel', label: 'Announce the weekly lottery winner here (optional)' },
    { key: 'robbing', type: 'toggle', label: 'Members can /rob each other (coins in the bank are safe; padlocks protect)', default: false },
    { key: 'robMax', type: 'number', label: 'Most coins one robbery can take', default: 50000, min: 1, max: 100000000 },
    { key: 'events', type: 'toggle', label: 'Coin events now and then while people chat (grab a bag, share a chest)', default: true },
    { key: 'eventEvery', type: 'number', label: 'About how many messages between coin events', default: 150, min: 20, max: 5000 },
    { key: 'globalBoard', type: 'toggle', label: 'Show this server\'s members on the global leaderboard', default: false },
  ],
  permissions: [
    { key: 'economy.use', label: 'Use the economy (balance, daily, pay, leaderboard)', default: 'everyone' },
    { key: 'economy.admin', label: 'Give, take or set coins', default: 'admin' },
  ],
  migrations: [{
    id: 1,
    sql: `CREATE TABLE economy_wallets (
            guild_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, coins INTEGER NOT NULL DEFAULT 0, earned INTEGER NOT NULL DEFAULT 0,
            streak INTEGER NOT NULL DEFAULT 0, best_streak INTEGER NOT NULL DEFAULT 0, shields INTEGER NOT NULL DEFAULT 0,
            last_daily INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
          CREATE INDEX economy_wallets_rich ON economy_wallets (guild_id, coins DESC);
          CREATE TABLE economy_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, delta INTEGER NOT NULL, reason TEXT, at INTEGER NOT NULL);
          CREATE INDEX economy_ledger_user ON economy_ledger (guild_id, user_id, at);`,
  }, {
    id: 2, // 3.1: shop, inventory, work, bank
    sql: `CREATE TABLE economy_shop (guild_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, emoji TEXT, price INTEGER NOT NULL, description TEXT, role_id TEXT, hours INTEGER NOT NULL DEFAULT 0,
            stock INTEGER, message TEXT, consumable INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, id));
          CREATE TABLE economy_items (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, item_id TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, user_id, item_id));
          ALTER TABLE economy_wallets ADD COLUMN bank INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE economy_wallets ADD COLUMN bank_paid_at INTEGER;
          ALTER TABLE economy_wallets ADD COLUMN last_work INTEGER NOT NULL DEFAULT 0;`,
  }, {
    id: 3, // 3.1: robbing, pets
    sql: `ALTER TABLE economy_wallets ADD COLUMN last_rob INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE economy_wallets ADD COLUMN robbed_at INTEGER NOT NULL DEFAULT 0;
          CREATE TABLE economy_pets (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, hunger INTEGER NOT NULL, happy INTEGER NOT NULL, xp INTEGER NOT NULL DEFAULT 0,
            adopted_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, fed_at INTEGER, played_at INTEGER, PRIMARY KEY (guild_id, user_id));`,
  }, {
    id: 4, // 3.1: the weekly lottery
    sql: `CREATE TABLE economy_lottery (guild_id TEXT NOT NULL, week TEXT NOT NULL, user_id TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, spent INTEGER NOT NULL DEFAULT 0,
            drawn INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, week, user_id));`,
  }],
  commands: [
    {
      permission: 'economy.use',
      data: new SlashCommandBuilder().setName('balance').setDescription('Your wallet, streak and rank'),
      async execute(ctx, i) { return i.reply({ embeds: [walletCard(ctx, i.user, i.member)], components: [quickRow(ctx, i)], allowedMentions: NOPING, ...quiet(ctx) }); },
    },
    {
      permission: 'economy.use',
      data: new ContextMenuCommandBuilder().setName('View wallet').setType(ApplicationCommandType.User),
      async execute(ctx, i) {
        const user = i.targetUser ?? i.options?.getUser?.('user');
        if (user?.bot) throw new UserError('Bots do not have wallets.');
        return i.reply({ embeds: [walletCard(ctx, user, i.targetMember)], flags: EPH, allowedMentions: NOPING });
      },
    },
    {
      permission: 'economy.use',
      data: new ContextMenuCommandBuilder().setName('Pay member').setType(ApplicationCommandType.User),
      async execute(ctx, i) {
        const user = i.targetUser;
        if (!user || user.bot || user.id === i.user.id) throw new UserError('Pick another member (not a bot, not yourself).');
        return pipe.launch(ctx, i, 'pay', [user.id]); // the target travels in the signed button token
      },
    },
    {
      permission: 'economy.use',
      data: new SlashCommandBuilder().setName('daily').setDescription('Claim your daily coins and grow your streak'),
      execute: claim,
    },
    {
      permission: 'economy.use',
      data: new SlashCommandBuilder().setName('pay').setDescription('Send coins to another member (opens a form)'),
      execute: (ctx, i) => pipe.launch(ctx, i, 'pay'),
    },
    {
      permission: 'economy.use',
      data: new SlashCommandBuilder().setName('top').setDescription('Live leaderboards: coins, streaks, fishing and more'),
      async execute(ctx, i) {
        ensure(ctx, i.user.id, displayName(i.user, i.member)); // keeps the name shown on the global board current
        return i.reply({ ...boardMessage(ctx, i.user.id, 'coins', 'server', 0), ...quiet(ctx) });
      },
    },
    {
      permission: 'economy.use',
      data: new SlashCommandBuilder().setName('shop').setDescription('Buy roles and items with your coins'),
      async execute(ctx, i) { ensure(ctx, i.user.id, displayName(i.user, i.member)); return i.reply({ ...shopMessage(ctx, i), flags: EPH }); },
    },
    {
      permission: 'economy.use',
      data: new SlashCommandBuilder().setName('work').setDescription('Do a job for some coins'),
      execute: workCmd,
    },
    {
      permission: 'economy.use',
      data: new SlashCommandBuilder().setName('rob').setDescription('Try to take some of a member\'s wallet (if the server allows it)').addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true)),
      execute: robCmd,
    },
    {
      permission: 'economy.use',
      data: new SlashCommandBuilder().setName('pet').setDescription('Your pet: adopt, feed, play')
        .addSubcommand((s) => s.setName('adopt').setDescription('Adopt a pet').addStringOption((o) => o.setName('kind').setDescription('Which').setRequired(true).addChoices(...Object.entries(X.PETS).map(([value, p]) => ({ name: `${p.emoji} ${p.label} (${fmtNum(p.price)})`, value }))))
          .addStringOption((o) => o.setName('name').setDescription('Its name').setMaxLength(20)))
        .addSubcommand((s) => s.setName('feed').setDescription('Feed your pet (50 coins)'))
        .addSubcommand((s) => s.setName('play').setDescription('Play with your pet'))
        .addSubcommand((s) => s.setName('info').setDescription('See a pet').addUserOption((o) => o.setName('member').setDescription('Whose (yours if empty)'))),
      execute: petCmd,
    },
    {
      permission: 'economy.use',
      data: new SlashCommandBuilder().setName('bank').setDescription('Keep coins safe and earn daily interest'),
      async execute(ctx, i) { ensure(ctx, i.user.id, displayName(i.user, i.member)); return i.reply({ ...bankMessage(ctx, i), flags: EPH }); },
    },
    {
      permission: 'economy.admin',
      data: new SlashCommandBuilder().setName('economy-admin').setDescription('(Admins) Give, take or set a member\'s coins (opens a form)'),
      execute: (ctx, i) => pipe.launch(ctx, i, 'adjust'),
    },
  ],
  components: [pipe.component, { prefix: LB, execute: boardClick }, { prefix: 'econ:', execute: quickClick }],
  tasks: [{ name: 'shop-roles', everyMs: 5 * 60000, run: (ctx) => SHOP.expireShopRoles(ctx) }, { name: 'lottery', everyMs: 30 * 60000, run: async (ctx) => {
    for (const w of SHOP.drawLotteries(ctx, helpers(ctx))) {
      const user = await ctx.client.users.fetch(w.winner).catch(() => null);
      await user?.send({ content: `🎟️ You won the **${truncate(ctx.guild?.name ?? 'server', 60)}** lottery! ${money(ctx, w.pool)} is in your wallet (${w.tickets} tickets from ${w.players} ${w.players === 1 ? 'person' : 'people'}).` }).catch(() => {});
      const ch = ctx.guild?.channels.cache.get(ctx.config.get('lotteryChannel'));
      await ch?.send?.({ content: `🎟️ <@${w.winner}> won this week's lottery: ${money(ctx, w.pool)} from ${w.tickets} tickets! Buy a ticket in \`/shop\` for next week's.`, allowedMentions: NOPING }).catch(() => {});
    }
  } }, {
    name: 'ledger-prune', everyMs: 6 * 3600000,
    run: async (ctx) => { ctx.sql.run('DELETE FROM economy_ledger WHERE guild_id = ? AND at < ?', ctx.guildId, Date.now() - LEDGER_DAYS * 86400000); },
  }],
  api: {
    /** All take the server id first: the api object is shared by every server. */
    wallet: (guildId, userId, name) => ensure(need(guildId), userId, name),
    credit: (guildId, userId, amount, reason) => credit(need(guildId), userId, amount, reason),
    debit: (guildId, userId, amount, reason) => debit(need(guildId), userId, amount, reason),
    format: (guildId, n) => money(need(guildId), n),
    transaction: (guildId, fn) => need(guildId).sql.transaction(fn),
    registerBoard: (b) => registerBoard(b),
    /** 3.1: when a member's shop boost ('luck' or 'workboost') runs out, or 0. */
    boostUntil: (guildId, userId, kind) => SHOP.boostUntil(need(guildId), userId, kind),
  },
  actions: {
    async 'shop-add'(ctx, body) {
      const price = Number(body.price);
      const r = SHOP.addItem(ctx, { name: String(body.name ?? '').trim(), price, roleId: body.role || null, hours: body.role ? Number(body.hours || 0) : 0, stock: body.stock == null || body.stock === '' ? null : Number(body.stock),
        emoji: String(body.emoji ?? '').trim() || null, description: body.role ? String(body.message ?? '').trim() || null : null, message: body.role ? null : String(body.message ?? '').trim() || null, consumable: !body.role && body.consumable === 'yes' });
      return r;
    },
    async 'shop-price'(ctx, body) {
      const price = Math.floor(Number(body.price));
      if (!(price >= 1)) throw new UserError('The price must be at least 1.');
      if (String(body.id).startsWith('builtin:')) { SHOP.setStarter(ctx, String(body.id).slice(8), { price }); return { id: body.id, price }; }
      const r = ctx.sql.run('UPDATE economy_shop SET price = ? WHERE guild_id = ? AND id = ?', price, ctx.guildId, String(body.id));
      if (!r.changes) throw new UserError('That item is gone.');
      return { id: body.id, price };
    },
    async 'shop-restore'(ctx) { for (const id of Object.keys(SHOP.STARTERS)) SHOP.setStarter(ctx, id, { off: false }); return { ok: true }; },
    async 'shop-stock'(ctx, body) {
      if (String(body.id).startsWith('builtin:')) throw new UserError('Built-in items never run out.');
      const v = String(body.stock ?? '').trim();
      const stock = v === '' || v === 'unlimited' ? null : Math.max(0, Math.floor(Number(v)));
      if (stock !== null && !Number.isFinite(stock)) throw new UserError('Use a whole number, or leave it empty for unlimited.');
      ctx.sql.run('UPDATE economy_shop SET stock = ? WHERE guild_id = ? AND id = ?', stock, ctx.guildId, String(body.id));
      return { id: body.id, stock };
    },
    async 'shop-remove'(ctx, body) { const id = String(body.id); if (id.startsWith('builtin:')) SHOP.setStarter(ctx, id.slice(8), { off: true }); else SHOP.removeItem(ctx, id); return { id }; },
  },
  views: {
    async shop(ctx) {
      return { rows: [...SHOP.starters(ctx).filter((x) => !x.off).map((x) => ({ id: `builtin:${x.id}`, name: `${x.emoji} ${x.name}`, price: fmtNum(x.price), priceRaw: x.price, gives: 'Built-in item', stock: 'Unlimited', stockRaw: '' })), ...SHOP.shopItems(ctx).map((it) => ({ id: it.id, name: `${it.emoji ? `${it.emoji} ` : ''}${it.name}`, price: fmtNum(it.price), priceRaw: it.price,
        gives: it.role_id ? `@${ctx.guild?.roles.cache.get(it.role_id)?.name ?? 'deleted role'}${it.hours ? ` for ${it.hours} h` : ''}` : it.consumable ? 'Item (used up)' : 'Item',
        stock: it.stock == null ? 'Unlimited' : String(it.stock), stockRaw: it.stock ?? '' }))] };
    },
    async wallets(ctx) {
      return { rows: ctx.sql.all('SELECT user_id AS id, name, coins, streak, earned FROM economy_wallets WHERE guild_id = ? ORDER BY coins DESC LIMIT 200', ctx.guildId) };
    },
  },
  panels: [{ id: 'shop', title: 'Shop', view: 'shop', permission: 'economy.admin', empty: 'Nothing for sale yet (the Streak Shield is always there). Add a role or an item.',
    description: 'What members can buy with /shop. A role can last for good or for some hours; an item goes in their inventory.',
    columns: [{ key: 'name', label: 'Item' }, { key: 'price', label: 'Price' }, { key: 'gives', label: 'Gives' }, { key: 'stock', label: 'Stock' }],
    rowActions: [{ action: 'shop-price', label: 'Price', prompt: 'number', field: 'price', current: 'priceRaw', okLabel: 'Save', done: 'Price saved', danger: false },
      { action: 'shop-stock', label: 'Stock', prompt: 'text', field: 'stock', current: 'stockRaw', placeholder: 'A number, or empty for unlimited', okLabel: 'Save', done: 'Stock saved', danger: false },
      { action: 'shop-remove', label: 'Remove', confirm: 'Take this out of the shop? Members keep what they bought.', danger: true, done: 'Removed' }],
    globalActions: [{ action: 'shop-restore', label: 'Bring back built-in items', confirm: 'Put the lucky charm, work boost, lottery ticket and pet treat back in the shop?' }],
    addForm: { action: 'shop-add', label: 'Add item', hint: 'Pick a role to sell a role. Leave it empty to sell an item.', done: 'Added to the shop', fields: [
      { key: 'name', label: 'Name', placeholder: 'VIP or Golden Bone' }, { key: 'price', label: 'Price', type: 'number' }, { key: 'role', label: 'Role it gives (optional)', type: 'role', optional: true },
      { key: 'hours', label: 'Role lasts this many hours (empty = for good)', type: 'number', optional: true }, { key: 'stock', label: 'How many for sale (empty = unlimited)', type: 'number', optional: true },
      { key: 'emoji', label: 'Emoji (optional)', optional: true }, { key: 'message', label: 'Description, or what using the item says ({user} = the buyer)', type: 'paragraph', optional: true },
      { key: 'consumable', label: 'Item is used up when used', type: 'select', options: [{ value: 'no', label: 'No, they keep it' }, { value: 'yes', label: 'Yes, used up' }] }] } },
  { id: 'wallets', title: 'Wallets', view: 'wallets', permission: 'economy.admin',
    columns: [{ key: 'name', label: 'Member' }, { key: 'coins', label: 'Coins' }, { key: 'streak', label: 'Streak' }, { key: 'earned', label: 'Earned' }] }],
  events: { messageCreate: onMessage },
  async init(ctx) { ctxs.set(ctx.guildId, ctx); },
  async destroy(ctx) { ctxs.delete(ctx.guildId); },
};

function need(guildId) {
  const c = ctxs.get(guildId);
  if (!c) throw new UserError('The economy module is not enabled in this server.');
  return c;
}
