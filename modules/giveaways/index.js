/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Giveaways (3.1). /giveaway start opens a form (prize, how long, how many winners, channel, a role people need).
 * The post has an Enter button (press again to leave) with a live entry count. When time is up the bot draws winners
 * fairly (crypto random, everyone has the same chance), skips people who left or don't have the role, and announces
 * them. A prize like "5000 coins" is paid automatically when the economy module is on. End early, reroll and list.
 * Prizes are things in the server (coins, roles, a shout-out): nothing here is for real money.
 */
import { randomInt } from 'node:crypto';
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { createPipeline } from '../../src/modalpipe.js';
import { UserError, parseDuration, truncate } from '../../src/util.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const GOLD = 0xf2b33d, DONE = 0x95a5a6;
const MIN_MS = 60000, MAX_MS = 30 * 86400000;

/** Picks `count` different winners from `pool` fairly. Exported for tests. pick(n) returns 0..n-1. */
export function drawWinners(pool, count, pick = (n) => randomInt(n)) {
  const left = [...new Set(pool)], out = [];
  while (out.length < count && left.length) out.push(left.splice(pick(left.length), 1)[0]);
  return out;
}
/** "5000 coins" -> 5000 (null if the prize isn't coins). */
export const coinPrize = (prize) => { const m = /^\s*([\d,]+)\s*(coins?|🪙)\s*$/i.exec(String(prize ?? '')); return m ? Number(m[1].replace(/,/g, '')) || null : null; };

const getG = (ctx, id) => ctx.sql.get('SELECT * FROM giveaways_list WHERE guild_id = ? AND id = ?', ctx.guildId, id);
const entries = (ctx, id) => ctx.sql.all('SELECT user_id FROM giveaways_entries WHERE guild_id = ? AND giveaway_id = ?', ctx.guildId, id).map((r) => r.user_id);
const count = (ctx, id) => ctx.sql.get('SELECT COUNT(*) AS n FROM giveaways_entries WHERE guild_id = ? AND giveaway_id = ?', ctx.guildId, id).n;

function embedFor(ctx, g) {
  const ended = !!g.ended_at, winners = JSON.parse(g.winners ?? '[]');
  const e = new EmbedBuilder().setColor(ended ? DONE : GOLD).setTitle(`🎉 ${truncate(g.prize, 200)}`)
    .setDescription([
      ended ? (winners.length ? `**Winner${winners.length > 1 ? 's' : ''}:** ${winners.map((w) => `<@${w}>`).join(', ')}` : '**No winner:** nobody eligible entered.') : `Press **Enter** to join. Ends <t:${Math.floor(g.ends_at / 1000)}:R>.`,
      `Hosted by <@${g.host_id}> · ${g.winner_count} winner${g.winner_count > 1 ? 's' : ''}`,
      g.role_id ? `You need <@&${g.role_id}> to win.` : null,
      coinPrize(g.prize) ? '🪙 Coins are paid to the winner automatically.' : null,
    ].filter(Boolean).join('\n'))
    .setFooter({ text: `Giveaway #${g.id} · ${count(ctx, g.id)} ${count(ctx, g.id) === 1 ? 'entry' : 'entries'}${ended ? ' · ended' : ''}` });
  return e;
}
const enterRow = (g, ended) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`gw:enter:${g.id}`).setLabel(ended ? 'Ended' : 'Enter').setEmoji('🎉').setStyle(ButtonStyle.Success).setDisabled(ended));
async function refresh(ctx, g) {
  const ch = ctx.guild?.channels.cache.get(g.channel_id);
  const msg = await ch?.messages?.fetch?.(g.message_id).catch(() => null);
  await msg?.edit?.({ embeds: [embedFor(ctx, g)], components: [enterRow(g, !!g.ended_at)], allowedMentions: NOPING }).catch(() => {});
}

/** Draws winners and announces them. reroll: draws new winners among the rest. Returns the winner ids. */
export async function finish(ctx, id, { reroll = 0 } = {}) {
  const g = getG(ctx, id);
  if (!g) throw new UserError('That giveaway does not exist.');
  const before = JSON.parse(g.winners ?? '[]');
  const eligible = [];
  for (const uid of entries(ctx, id)) {
    if (reroll && before.includes(uid)) continue;
    const m = ctx.guild?.members.cache.get(uid) ?? await ctx.guild?.members.fetch(uid).catch(() => null);
    if (!m || m.user?.bot) continue;
    if (g.role_id && !m.roles?.cache?.has(g.role_id)) continue;
    eligible.push(uid);
  }
  const won = drawWinners(eligible, reroll || g.winner_count);
  const winners = reroll ? [...before, ...won] : won;
  ctx.sql.run('UPDATE giveaways_list SET ended_at = COALESCE(ended_at, ?), winners = ? WHERE guild_id = ? AND id = ?', Date.now(), JSON.stringify(winners), ctx.guildId, id);
  const fresh = getG(ctx, id);
  await refresh(ctx, fresh);
  const coins = coinPrize(g.prize), eco = coins ? ctx.api?.('economy') : null;
  if (eco) for (const w of won) { try { eco.credit(ctx.guildId, w, coins, `giveaway #${id}`); } catch (e) { ctx.log.warn(`Giveaway coins: ${e.message}`); } }
  const ch = ctx.guild?.channels.cache.get(g.channel_id);
  const text = won.length
    ? `🎉 ${reroll ? 'New winner' : 'Congratulations'}${won.length > 1 ? 's' : ''} ${won.map((w) => `<@${w}>`).join(', ')}! You won **${truncate(g.prize, 200)}**.${eco ? ` 🪙 ${coins.toLocaleString()} coins were added to your wallet.` : ''}`
    : `Giveaway #${id} for **${truncate(g.prize, 200)}** ended with no ${reroll ? 'other ' : ''}eligible entries.`;
  await ch?.send?.({ content: text, allowedMentions: { users: won }, reply: g.message_id ? { messageReference: g.message_id, failIfNotExists: false } : undefined }).catch((e) => ctx.log.warn(`Giveaway announce: ${e.message}`));
  if (won.length) ctx.live?.('activity', { icon: '🎉', text: `Giveaway #${id} (${truncate(g.prize, 60)}) ${reroll ? 'rerolled' : 'won by'} ${won.length} member${won.length > 1 ? 's' : ''}` });
  return won;
}

async function enter(ctx, i, id) {
  const g = getG(ctx, Number(id));
  if (!g || g.ended_at) throw new UserError('This giveaway has ended.');
  if (g.role_id && !i.member.roles.cache.has(g.role_id)) throw new UserError(`You need the <@&${g.role_id}> role to enter this one.`);
  const was = ctx.sql.get('SELECT 1 FROM giveaways_entries WHERE guild_id = ? AND giveaway_id = ? AND user_id = ?', ctx.guildId, g.id, i.user.id);
  if (was) ctx.sql.run('DELETE FROM giveaways_entries WHERE guild_id = ? AND giveaway_id = ? AND user_id = ?', ctx.guildId, g.id, i.user.id);
  else ctx.sql.run('INSERT INTO giveaways_entries (guild_id, giveaway_id, user_id, at) VALUES (?, ?, ?, ?)', ctx.guildId, g.id, i.user.id, Date.now());
  await i.update({ embeds: [embedFor(ctx, g)], components: [enterRow(g, false)], allowedMentions: NOPING });
  return i.followUp({ content: was ? 'You left the giveaway.' : `🎉 You're in! Good luck. Press **Enter** again to leave.`, flags: EPH }).catch(() => {});
}

const pipe = createPipeline({
  ns: 'mpg',
  forms: {
    start: {
      title: 'Start a giveaway', permission: 'giveaways.manage', color: GOLD,
      button: { label: 'Set up the giveaway', emoji: '🎉', style: ButtonStyle.Success },
      intro: 'Pick the prize, how long it runs, how many win and where it goes. Write a prize like **5000 coins** and the coins are paid automatically.',
      fields: (ctx, i) => [
        { id: 'prize', kind: 'text', label: 'Prize', max: 200, placeholder: 'e.g. Nitro Basic, 5000 coins, VIP role for a month' },
        { id: 'duration', kind: 'text', label: 'How long? (e.g. 30m, 6h, 2d)', max: 10, value: '1d' },
        { id: 'winners', kind: 'number', label: 'How many winners?', value: 1, min: 1, maxNum: 20, max: 2 },
        { id: 'channel', kind: 'channel', label: 'Post it in', value: i.channelId ? [i.channelId] : undefined },
        { id: 'role', kind: 'role', label: 'Only members with this role can win (optional)', required: false },
      ],
      async submit(ctx, i, v) {
        const prize = String(v.prize ?? '').trim();
        if (!prize) throw new UserError('Write the prize.');
        const ms = parseDuration(v.duration);
        if (!ms || ms < MIN_MS || ms > MAX_MS) throw new UserError('Pick a time between 1 minute and 30 days, like 30m, 6h or 2d.');
        const ch = ctx.guild?.channels.cache.get(v.channel ?? i.channelId);
        if (!ch?.send) throw new UserError('Pick a text channel.');
        const me = ctx.guild.members.me, perms = me && ch.permissionsFor?.(me);
        if (perms && !perms.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) throw new UserError(`I can't post in <#${ch.id}>. I need View Channel, Send Messages and Embed Links there.`);
        const now = Date.now();
        const id = (ctx.sql.get('SELECT MAX(id) AS m FROM giveaways_list WHERE guild_id = ?', ctx.guildId)?.m ?? 0) + 1;
        ctx.sql.run('INSERT INTO giveaways_list (guild_id, id, channel_id, message_id, host_id, prize, winner_count, role_id, created_at, ends_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)',
          ctx.guildId, id, ch.id, i.user.id, prize, Math.max(1, Math.min(20, Number(v.winners) || 1)), v.role ?? null, now, now + ms);
        const g = getG(ctx, id);
        const msg = await ch.send({ embeds: [embedFor(ctx, g)], components: [enterRow(g, false)], allowedMentions: NOPING });
        ctx.sql.run('UPDATE giveaways_list SET message_id = ? WHERE guild_id = ? AND id = ?', msg.id, ctx.guildId, id);
        ctx.live?.('activity', { icon: '🎉', text: `Giveaway #${id} started: ${truncate(prize, 60)}` });
        return i.reply({ content: `🎉 Giveaway #${id} is live in <#${ch.id}>. It ends <t:${Math.floor((now + ms) / 1000)}:R>.`, flags: EPH });
      },
    },
  },
});

async function giveawayCommand(ctx, i) {
  const sub = i.options.getSubcommand();
  if (sub === 'start') return pipe.launch(ctx, i, 'start');
  if (sub === 'list') {
    const rows = ctx.sql.all('SELECT * FROM giveaways_list WHERE guild_id = ? ORDER BY id DESC LIMIT 15', ctx.guildId);
    if (!rows.length) return i.reply({ content: 'No giveaways yet. Start one with `/giveaway start`.', flags: EPH });
    const e = new EmbedBuilder().setColor(GOLD).setTitle('🎉 Giveaways').setDescription(rows.map((g) => `**#${g.id}** ${truncate(g.prize, 60)} · ${g.ended_at ? 'ended' : `ends <t:${Math.floor(g.ends_at / 1000)}:R>`} · ${count(ctx, g.id)} entries · <#${g.channel_id}>`).join('\n'));
    return i.reply({ embeds: [e], flags: EPH });
  }
  const id = i.options.getInteger('id');
  const g = getG(ctx, id);
  if (!g) throw new UserError(`There's no giveaway #${id}.`);
  if (sub === 'end') {
    if (g.ended_at) throw new UserError('That giveaway already ended. Use `/giveaway reroll` to pick someone else.');
    await i.deferReply({ flags: EPH });
    const won = await finish(ctx, id);
    return i.editReply({ content: won.length ? `Ended giveaway #${id}. Winner${won.length > 1 ? 's' : ''}: ${won.map((w) => `<@${w}>`).join(', ')}` : `Ended giveaway #${id}: nobody eligible entered.` });
  }
  if (sub === 'reroll') {
    if (!g.ended_at) throw new UserError("That giveaway hasn't ended yet.");
    await i.deferReply({ flags: EPH });
    const won = await finish(ctx, id, { reroll: Math.max(1, Math.min(20, i.options.getInteger('winners') ?? 1)) });
    return i.editReply({ content: won.length ? `New winner${won.length > 1 ? 's' : ''}: ${won.map((w) => `<@${w}>`).join(', ')}` : 'Nobody else is eligible.' });
  }
  throw new UserError('Unknown option.');
}

async function due(ctx) {
  for (const g of ctx.sql.all('SELECT id FROM giveaways_list WHERE guild_id = ? AND ended_at IS NULL AND ends_at <= ?', ctx.guildId, Date.now())) {
    await finish(ctx, g.id).catch((e) => ctx.log.warn(`Giveaway #${g.id} could not end: ${e.message}`));
  }
}

export default {
  name: 'giveaways',
  version: '1.0.0',
  description: 'Giveaways with an Enter button, fair winners, rerolls and automatic coin prizes',
  memberIntroTitle: 'giveaways',
  memberIntro: 'giveaways are here 🎉 when one is posted just hit Enter to join, winners get picked at random when the timer ends',
  settings: [],
  permissions: [{ key: 'giveaways.manage', label: 'Start, end and reroll giveaways', default: 'admin' }],
  migrations: [{ id: 1, sql: `
    CREATE TABLE IF NOT EXISTS giveaways_list (guild_id TEXT NOT NULL, id INTEGER NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, host_id TEXT NOT NULL, prize TEXT NOT NULL,
      winner_count INTEGER NOT NULL, role_id TEXT, created_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, ended_at INTEGER, winners TEXT, PRIMARY KEY (guild_id, id));
    CREATE TABLE IF NOT EXISTS giveaways_entries (guild_id TEXT NOT NULL, giveaway_id INTEGER NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (guild_id, giveaway_id, user_id));
  ` }],
  commands: [{
    permission: 'giveaways.manage', defer: 'none',
    data: new SlashCommandBuilder().setName('giveaway').setDescription('Start, end or reroll giveaways')
      .addSubcommand((s) => s.setName('start').setDescription('Start a giveaway (opens a form)'))
      .addSubcommand((s) => s.setName('end').setDescription('End a giveaway now and draw the winners').addIntegerOption((o) => o.setName('id').setDescription('Giveaway number').setRequired(true).setMinValue(1)))
      .addSubcommand((s) => s.setName('reroll').setDescription('Pick new winners for an ended giveaway').addIntegerOption((o) => o.setName('id').setDescription('Giveaway number').setRequired(true).setMinValue(1)).addIntegerOption((o) => o.setName('winners').setDescription('How many new winners (1 if empty)').setMinValue(1).setMaxValue(20)))
      .addSubcommand((s) => s.setName('list').setDescription('Recent giveaways')),
    execute: giveawayCommand,
  }],
  components: [pipe.component, { prefix: 'gw:enter:', execute: (ctx, i) => enter(ctx, i, i.customId.split(':')[2]) }],
  panels: [{ id: 'giveaways', title: 'Giveaways', view: 'list', permission: 'giveaways.manage', empty: 'No giveaways yet. Start one with /giveaway start in Discord.',
    columns: [{ key: 'id', label: '#' }, { key: 'prize', label: 'Prize' }, { key: 'status', label: 'Status' }, { key: 'entries', label: 'Entries' }, { key: 'winners', label: 'Winners' }],
    rowActions: [{ action: 'end', label: 'End now', confirm: 'End this giveaway now and draw the winners?', danger: false }, { action: 'reroll', label: 'Reroll', confirm: 'Pick one new winner?', danger: false }] }],
  views: {
    async list(ctx) {
      const name = (id) => ctx.guild?.members.cache.get(id)?.displayName ?? id;
      return { rows: ctx.sql.all('SELECT * FROM giveaways_list WHERE guild_id = ? ORDER BY id DESC LIMIT 50', ctx.guildId).map((g) => ({ id: g.id, prize: g.prize, status: g.ended_at ? 'Ended' : `Ends ${new Date(g.ends_at).toLocaleString()}`, entries: count(ctx, g.id), winners: JSON.parse(g.winners ?? '[]').map(name).join(', ') || '—' })) };
    },
  },
  actions: {
    async end(ctx, body) { const g = getG(ctx, Number(body.id)); if (!g) throw new UserError('No such giveaway.'); if (g.ended_at) throw new UserError('It already ended.'); return { winners: await finish(ctx, g.id) }; },
    async reroll(ctx, body) { const g = getG(ctx, Number(body.id)); if (!g) throw new UserError('No such giveaway.'); if (!g.ended_at) throw new UserError("It hasn't ended yet."); return { winners: await finish(ctx, g.id, { reroll: 1 }) }; },
  },
  tasks: [{ name: 'due', everyMs: 30000, run: due }],
};
