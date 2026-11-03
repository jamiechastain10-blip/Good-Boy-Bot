/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Economy (2.2): wallets, daily streaks with Streak Shields, paying other members, and the live paginated
 * leaderboard (/top). Every command that needs input goes through the modal pipeline (src/modalpipe.js):
 * no command here takes a typed option.
 *
 * Other modules (games) use the wallet through ctx.api('economy') and can add their own leaderboards.
 * Coins are play money: they cannot be bought, sold or cashed out.
 */
import { SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { createPipeline } from '../../src/modalpipe.js';
import { claimDaily, fmtNum, parseAmount, CLAIM_EVERY } from '../../src/economy.js';
import { PER_PAGE, pageCount, clampPage, renderRows, navComponents, unpackNav, nextPage } from '../../src/leaderboard.js';
import { UserError, ts, sanitizeName } from '../../src/util.js';

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
      permission: 'economy.admin',
      data: new SlashCommandBuilder().setName('economy-admin').setDescription('(Admins) Give, take or set a member\'s coins (opens a form)'),
      execute: (ctx, i) => pipe.launch(ctx, i, 'adjust'),
    },
  ],
  components: [pipe.component, { prefix: LB, execute: boardClick }, { prefix: 'econ:', execute: quickClick }],
  tasks: [{
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
  },
  views: {
    async wallets(ctx) {
      return { rows: ctx.sql.all('SELECT user_id AS id, name, coins, streak, earned FROM economy_wallets WHERE guild_id = ? ORDER BY coins DESC LIMIT 200', ctx.guildId) };
    },
  },
  panels: [{ id: 'wallets', title: 'Wallets', view: 'wallets', permission: 'economy.admin',
    columns: [{ key: 'name', label: 'Member' }, { key: 'coins', label: 'Coins' }, { key: 'streak', label: 'Streak' }, { key: 'earned', label: 'Earned' }] }],
  async init(ctx) { ctxs.set(ctx.guildId, ctx); },
  async destroy(ctx) { ctxs.delete(ctx.guildId); },
};

function need(guildId) {
  const c = ctxs.get(guildId);
  if (!c) throw new UserError('The economy module is not enabled in this server.');
  return c;
}
