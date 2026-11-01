/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Activity statistics and recaps.
 *   Counts messages, voice time (connected, not necessarily talking) and reactions per day, per member and per channel.
 *   Message TEXT is never stored: only counts. Members can opt out (/stats optout) or erase their numbers (/stats forget).
 *   /stats me | server | top | coverage | recap | backfill | optout | optin | forget
 * Honest history: live tracking starts the day the module is enabled. /stats backfill can count older messages
 * from channel history; those counts are kept apart ("backfilled") and /stats coverage says exactly what they cover.
 * Voice time and reactions cannot be recovered from the past.
 */
import { SlashCommandBuilder, EmbedBuilder, ChannelType, MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { UserError, truncate, ts, describeDiscordError } from '../../src/util.js';
import { dayKey, weekStartKey, addDays, periodStart, VoiceTracker, hours } from '../../src/activity.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const need = (ctx, i, key) => { if (!ctx.perms.check(i.member, key)) throw new UserError(`You don't have permission for that (\`${key}\`).`); };
const tz = (ctx) => ctx.config.get('timezoneOffset');
const periodChoices = [{ name: 'last 7 days', value: '7d' }, { name: 'last 30 days', value: '30d' }, { name: 'since tracking began', value: 'all' }];
const PERIOD_WORDS = { '7d': 'last 7 days', '30d': 'last 30 days', all: 'all tracked time' };

// ------------------------------------------------------------------ live counting (buffered, flushed every few seconds)
const buffers = new Map();   // guildId -> { user: Map, chan: Map, guild: Map }
const voice = new Map();     // guildId -> VoiceTracker
const optedOut = new Map();  // guildId -> Set(userId)
const buf = (g) => { let b = buffers.get(g); if (!b) buffers.set(g, b = { user: new Map(), chan: new Map(), guild: new Map() }); return b; };
const bump = (map, key, field, n = 1) => { const row = map.get(key) ?? {}; row[field] = (row[field] ?? 0) + n; map.set(key, row); };
const tracker = (g) => { let t = voice.get(g); if (!t) voice.set(g, t = new VoiceTracker()); return t; };
const out = (g) => { let s = optedOut.get(g); if (!s) optedOut.set(g, s = new Set()); return s; };

export function flush(ctx) {
  const b = buffers.get(ctx.guildId);
  if (!b || (!b.user.size && !b.chan.size && !b.guild.size)) return;
  buffers.delete(ctx.guildId);
  ctx.sql.transaction(() => {
    for (const [k, r] of b.user) {
      const [uid, day] = k.split('|');
      ctx.sql.run(`INSERT INTO stats_user_day (guild_id, user_id, day, messages, voice_seconds, reactions) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id, day) DO UPDATE SET messages = messages + excluded.messages, voice_seconds = voice_seconds + excluded.voice_seconds, reactions = reactions + excluded.reactions`,
      ctx.guildId, uid, day, r.messages ?? 0, r.voice ?? 0, r.reactions ?? 0);
    }
    for (const [k, r] of b.chan) {
      const [cid, day] = k.split('|');
      ctx.sql.run(`INSERT INTO stats_channel_day (guild_id, channel_id, day, messages) VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, channel_id, day) DO UPDATE SET messages = messages + excluded.messages`, ctx.guildId, cid, day, r.messages ?? 0);
    }
    for (const [day, r] of b.guild) {
      ctx.sql.run(`INSERT INTO stats_guild_day (guild_id, day, joins, leaves) VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, day) DO UPDATE SET joins = joins + excluded.joins, leaves = leaves + excluded.leaves`, ctx.guildId, day, r.joins ?? 0, r.leaves ?? 0);
    }
  });
}

const ignored = (ctx, channelId, parentId) => { const l = ctx.config.get('ignoredChannels') ?? []; return l.includes(channelId) || (parentId && l.includes(parentId)); };

function onMessage(ctx, m) {
  if (!m.guildId || m.author?.bot || m.webhookId || out(ctx.guildId).has(m.author.id)) return;
  if (ignored(ctx, m.channelId, m.channel?.parentId)) return;
  const day = dayKey(m.createdTimestamp ?? Date.now(), tz(ctx));
  const b = buf(ctx.guildId);
  bump(b.user, `${m.author.id}|${day}`, 'messages');
  bump(b.chan, `${m.channelId}|${day}`, 'messages');
}

function onReaction(ctx, reaction, user) {
  if (user?.bot || out(ctx.guildId).has(user.id)) return;
  bump(buf(ctx.guildId).user, `${user.id}|${dayKey(Date.now(), tz(ctx))}`, 'reactions');
}

function onVoice(ctx, oldS, newS) {
  if (!ctx.config.get('trackVoice')) return;
  const member = newS.member ?? oldS.member;
  if (!member || member.user?.bot || out(ctx.guildId).has(member.id)) return;
  const afk = ctx.guild?.afkChannelId;
  const was = oldS.channelId && oldS.channelId !== afk && !ignored(ctx, oldS.channelId);
  const now = newS.channelId && newS.channelId !== afk && !ignored(ctx, newS.channelId);
  const t = tracker(ctx.guildId); const at = Date.now();
  if (was && !now) { const s = t.leave(member.id, at); if (s) bump(buf(ctx.guildId).user, `${member.id}|${dayKey(at, tz(ctx))}`, 'voice', s); }
  else if (!was && now) t.enter(member.id, at);
}

const onJoin = (ctx) => bump(buf(ctx.guildId).guild, dayKey(Date.now(), tz(ctx)), 'joins');
const onLeave = (ctx) => bump(buf(ctx.guildId).guild, dayKey(Date.now(), tz(ctx)), 'leaves');

function closeVoice(ctx) {
  const at = Date.now();
  for (const [uid, s] of tracker(ctx.guildId).checkpoint(at)) if (s) bump(buf(ctx.guildId).user, `${uid}|${dayKey(at, tz(ctx))}`, 'voice', s);
}

// ------------------------------------------------------------------ queries
const startDay = (ctx, period) => periodStart(period, Date.now(), tz(ctx)) ?? '0000-00-00';
const sumRow = (ctx, userId, from) => ctx.sql.get(
  `SELECT COALESCE(SUM(messages + messages_bf), 0) AS messages, COALESCE(SUM(messages_bf), 0) AS bf, COALESCE(SUM(voice_seconds), 0) AS voice, COALESCE(SUM(reactions), 0) AS reactions,
          COUNT(DISTINCT CASE WHEN messages + messages_bf + voice_seconds + reactions > 0 THEN day END) AS days
     FROM stats_user_day WHERE guild_id = ? AND user_id = ? AND day >= ?`, ctx.guildId, userId, from);

export function topMembers(ctx, metric, from, to = '9999-99-99', limit = 10) {
  const col = { messages: 'SUM(messages + messages_bf)', voice: 'SUM(voice_seconds)', reactions: 'SUM(reactions)' }[metric];
  if (!col) throw new UserError('Pick messages, voice or reactions.');
  return ctx.sql.all(`SELECT user_id AS id, ${col} AS n FROM stats_user_day WHERE guild_id = ? AND day >= ? AND day < ? GROUP BY user_id HAVING n > 0 ORDER BY n DESC, user_id LIMIT ?`, ctx.guildId, from, to, limit);
}
const topChannels = (ctx, from, to = '9999-99-99', limit = 5) =>
  ctx.sql.all('SELECT channel_id AS id, SUM(messages + messages_bf) AS n FROM stats_channel_day WHERE guild_id = ? AND day >= ? AND day < ? GROUP BY channel_id HAVING n > 0 ORDER BY n DESC, channel_id LIMIT ?', ctx.guildId, from, to, limit);

export function serverTotals(ctx, from, to = '9999-99-99') {
  const u = ctx.sql.get(`SELECT COALESCE(SUM(messages + messages_bf), 0) AS messages, COALESCE(SUM(voice_seconds), 0) AS voice, COALESCE(SUM(reactions), 0) AS reactions, COUNT(DISTINCT user_id) AS people
    FROM stats_user_day WHERE guild_id = ? AND day >= ? AND day < ?`, ctx.guildId, from, to);
  const g = ctx.sql.get('SELECT COALESCE(SUM(joins), 0) AS joins, COALESCE(SUM(leaves), 0) AS leaves FROM stats_guild_day WHERE guild_id = ? AND day >= ? AND day < ?', ctx.guildId, from, to);
  return { ...u, ...g };
}

const name = (ctx, id) => { const m = ctx.guild?.members.cache.get(id); return m?.displayName ?? `<@${id}>`; };
const lines = (ctx, rows, fmt) => rows.map((r, n) => `**${n + 1}.** <@${r.id}> · ${fmt(r.n)}`).join('\n') || '*nothing yet*';
const chanLines = (ctx, rows) => rows.map((r, n) => `**${n + 1}.** <#${r.id}> · ${r.n.toLocaleString('en-US')} messages`).join('\n') || '*nothing yet*';

// ------------------------------------------------------------------ coverage and backfill
export function coverageText(ctx) {
  const c = ctx.data.get('coverage');
  if (!c) return 'Live tracking has not started yet.';
  const parts = [`Live tracking since ${ts(c.trackingSince, 'f')}: messages, voice time (connected, not necessarily talking) and reactions.`];
  const bf = c.backfill;
  if (bf) {
    parts.push(`Message counts before that were **backfilled** on ${ts(bf.ranAt, 'f')} from channel history: ${bf.messages.toLocaleString('en-US')} messages in ${bf.channels} channel${bf.channels === 1 ? '' : 's'}${bf.oldest ? `, going back to ${ts(bf.oldest, 'D')}` : ''}.`);
    if (bf.skipped.length) parts.push(`I could not read ${bf.skipped.length} channel${bf.skipped.length === 1 ? '' : 's'} (${bf.skipped.slice(0, 5).map((id) => `<#${id}>`).join(' ')}${bf.skipped.length > 5 ? ' …' : ''}), so they are missing.`);
    if (bf.truncated.length) parts.push(`The limit was reached in ${bf.truncated.length} channel${bf.truncated.length === 1 ? '' : 's'} (${bf.truncated.slice(0, 5).map((id) => `<#${id}>`).join(' ')}${bf.truncated.length > 5 ? ' …' : ''}): older messages there are not counted.`);
    parts.push('Backfilled numbers cover messages only, and only members who were still in the server and not opted out are counted from the author on each message.');
  } else parts.push('No older history has been counted. Staff can run `/stats backfill`.');
  parts.push('Voice time and reactions from before tracking started cannot be recovered. Message text is never stored.');
  return parts.join('\n');
}

/** Count older messages from channel history. `limits.perChannel` / `limits.total` keep it bounded. */
export async function backfill(ctx, { days, perChannel = 5000, total = 50000, onProgress } = {}) {
  const since = Date.now() - days * 86400000;
  const cov = ctx.data.get('coverage') ?? { trackingSince: Date.now() };
  const cutoff = cov.trackingSince;
  const result = { ranAt: Date.now(), days, messages: 0, channels: 0, skipped: [], truncated: [], oldest: null, perChannel, total };
  const rows = new Map(); const chans = new Map();
  const me = ctx.guild.members.me;
  const channels = [...ctx.guild.channels.cache.values()].filter((c) => c.isTextBased?.() && !c.isVoiceBased?.() && c.messages?.fetch && c.type !== ChannelType.GuildCategory);
  let left = total;
  for (const ch of channels) {
    if (ignored(ctx, ch.id, ch.parentId)) continue;
    const perms = ch.permissionsFor?.(me ?? ctx.client.user.id);
    if (perms && !(perms.has(P.ViewChannel) && perms.has(P.ReadMessageHistory))) { result.skipped.push(ch.id); continue; }
    let before; let got = 0; let scanned = 0; let hitLimit = false; let readable = true;
    for (;;) {
      if (left <= 0 || scanned >= perChannel * 2 + 100) { hitLimit = true; break; }
      const batch = await ctx.queue(() => ch.messages.fetch({ limit: 100, ...(before ? { before } : {}) })).catch(() => { readable = false; return null; });
      if (!batch) break;
      const list = [...batch.values()];
      if (!list.length) break;
      scanned += list.length;
      let reachedOld = false;
      for (const m of list) {
        if (m.createdTimestamp < since) { reachedOld = true; continue; }
        if (m.createdTimestamp >= cutoff) continue; // live tracking already has these
        if (got >= perChannel || left <= 0) { hitLimit = true; break; }
        got++; left--;
        if (!m.author?.bot && !m.webhookId && !out(ctx.guildId).has(m.author?.id)) {
          const day = dayKey(m.createdTimestamp, tz(ctx));
          bump(rows, `${m.author.id}|${day}`, 'bf'); bump(chans, `${ch.id}|${day}`, 'bf');
          result.messages++;
          if (!result.oldest || m.createdTimestamp < result.oldest) result.oldest = m.createdTimestamp;
        }
      }
      before = list.reduce((a, m) => (m.createdTimestamp < a.createdTimestamp ? m : a), list[0]).id;
      if (hitLimit || reachedOld || list.length < 100) break;
    }
    if (!readable && !got) { result.skipped.push(ch.id); continue; }
    result.channels++;
    if (hitLimit) result.truncated.push(ch.id);
    onProgress?.(result);
  }
  ctx.sql.transaction(() => {
    ctx.sql.run('UPDATE stats_user_day SET messages_bf = 0 WHERE guild_id = ?', ctx.guildId);
    ctx.sql.run('UPDATE stats_channel_day SET messages_bf = 0 WHERE guild_id = ?', ctx.guildId);
    for (const [k, r] of rows) {
      const [uid, day] = k.split('|');
      ctx.sql.run(`INSERT INTO stats_user_day (guild_id, user_id, day, messages_bf) VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id, day) DO UPDATE SET messages_bf = excluded.messages_bf`, ctx.guildId, uid, day, r.bf);
    }
    for (const [k, r] of chans) {
      const [cid, day] = k.split('|');
      ctx.sql.run(`INSERT INTO stats_channel_day (guild_id, channel_id, day, messages_bf) VALUES (?, ?, ?, ?)
        ON CONFLICT(guild_id, channel_id, day) DO UPDATE SET messages_bf = excluded.messages_bf`, ctx.guildId, cid, day, r.bf);
    }
  });
  ctx.data.set('coverage', { ...cov, backfill: result });
  return result;
}

// ------------------------------------------------------------------ recaps
export function buildRecap(ctx, fromDay, toDay, label) {
  const t = serverTotals(ctx, fromDay, toDay);
  const e = new EmbedBuilder().setTitle(`📊 ${label}`).setColor(0x38bdf8)
    .setDescription(`${t.messages.toLocaleString('en-US')} messages · ${hours(t.voice)} voice hours · ${t.reactions.toLocaleString('en-US')} reactions · ${t.people} active member${t.people === 1 ? '' : 's'}\n+${t.joins} joined · −${t.leaves} left`)
    .addFields(
      { name: 'Most messages', value: lines(ctx, topMembers(ctx, 'messages', fromDay, toDay, 5), (n) => `${n.toLocaleString('en-US')}`) },
      { name: 'Most time in voice', value: lines(ctx, topMembers(ctx, 'voice', fromDay, toDay, 3), (n) => `${hours(n)} h`) },
      { name: 'Busiest channels', value: chanLines(ctx, topChannels(ctx, fromDay, toDay, 3)) },
    ).setFooter({ text: 'Counts only: message text is not stored. Members can opt out with /stats optout.' });
  return e;
}

async function weeklyRecap(ctx) {
  const channelId = ctx.config.get('recapChannel');
  const week = weekStartKey(Date.now(), tz(ctx));
  const last = ctx.data.get('lastRecapWeek');
  if (!last) { ctx.data.set('lastRecapWeek', week); return; }   // first run: start with next Monday, never post at once
  if (last === week) return;
  ctx.data.set('lastRecapWeek', week);
  flush(ctx);
  const from = addDays(week, -7);
  if (channelId) {
    const ch = ctx.guild.channels.cache.get(channelId);
    if (ch?.isTextBased()) await ctx.queue(() => ch.send({ embeds: [buildRecap(ctx, from, week, `Last week in ${ctx.guild.name}`)], allowedMentions: NOPING })).catch((e) => ctx.log.warn(`Weekly recap: ${describeDiscordError(e, 'post it')}`));
  }
  // personal recaps: only members who opted in (recaps is off unless the member or the server turns it on)
  const active = ctx.sql.all('SELECT user_id AS id FROM stats_user_day WHERE guild_id = ? AND day >= ? AND day < ? GROUP BY user_id HAVING SUM(messages + messages_bf + voice_seconds + reactions) > 0 LIMIT 500', ctx.guildId, from, week);
  let sent = 0;
  for (const { id } of active) {
    if (sent >= 200 || out(ctx.guildId).has(id) || !ctx.notify.allowed(id, 'recaps') || !ctx.notify.allowed(id, 'dms')) continue;
    const to = ctx.sql.get('SELECT COALESCE(SUM(messages + messages_bf), 0) AS m, COALESCE(SUM(voice_seconds), 0) AS v FROM stats_user_day WHERE guild_id = ? AND user_id = ? AND day >= ? AND day < ?', ctx.guildId, id, from, week);
    const user = await ctx.client.users.fetch(id).catch(() => null);
    if (await user?.send({ content: `📊 Your week in **${truncate(ctx.guild.name, 60)}**: ${to.m} messages, ${hours(to.v)} voice hours. (Turn these off with /notifications.)`, allowedMentions: NOPING }).then(() => true).catch(() => false)) sent++;
  }
}

// ------------------------------------------------------------------ commands
async function statsCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  flush(ctx); closeVoiceSnapshot(ctx);
  const reply = (p) => i.reply({ ...(typeof p === 'string' ? { content: p } : p), flags: EPH, allowedMentions: NOPING });

  if (sub === 'optout') { out(ctx.guildId).add(i.user.id); ctx.sql.run('INSERT OR IGNORE INTO stats_optout (guild_id, user_id, at) VALUES (?, ?, ?)', ctx.guildId, i.user.id, Date.now()); return reply('You are no longer counted in statistics or achievements progress here. Your existing numbers stay until you run `/stats forget`.'); }
  if (sub === 'optin') { out(ctx.guildId).delete(i.user.id); ctx.sql.run('DELETE FROM stats_optout WHERE guild_id = ? AND user_id = ?', ctx.guildId, i.user.id); return reply('You are counted again from now on.'); }
  if (sub === 'forget') {
    ctx.sql.run('DELETE FROM stats_user_day WHERE guild_id = ? AND user_id = ?', ctx.guildId, i.user.id);
    return reply('Your activity numbers in this server were erased. (Server-wide channel totals are anonymous counts and stay.) Use `/stats optout` to stop being counted.');
  }
  if (sub === 'coverage') return reply(coverageText(ctx));

  if (sub === 'backfill') {
    need(ctx, i, 'stats.manage');
    const days = i.options.getInteger('days', true);
    await i.deferReply({ flags: EPH });
    const r = await backfill(ctx, { days }).catch((e) => { throw new UserError(`Backfill failed: ${e.message}`); });
    return i.editReply({ content: truncate(`Done. ${r.messages.toLocaleString('en-US')} older messages counted from ${r.channels} channel${r.channels === 1 ? '' : 's'}.\n\n${coverageText(ctx)}`, 1900), allowedMentions: NOPING });
  }

  const period = i.options.getString('period') ?? '7d';
  const from = startDay(ctx, period);

  if (sub === 'recap') {
    need(ctx, i, 'stats.manage');
    const to = dayKey(Date.now() + 86400000, tz(ctx));
    return reply({ embeds: [buildRecap(ctx, from, to, `${PERIOD_WORDS[period]} in ${ctx.guild.name}`)] });
  }
  if (sub === 'server') {
    const t = serverTotals(ctx, from);
    const e = new EmbedBuilder().setTitle(`📊 ${ctx.guild.name} · ${PERIOD_WORDS[period]}`).setColor(0x38bdf8)
      .addFields(
        { name: 'Messages', value: t.messages.toLocaleString('en-US'), inline: true }, { name: 'Voice hours', value: String(hours(t.voice)), inline: true }, { name: 'Reactions', value: t.reactions.toLocaleString('en-US'), inline: true },
        { name: 'Active members', value: String(t.people), inline: true }, { name: 'Joined / left', value: `+${t.joins} / −${t.leaves}`, inline: true },
        { name: 'Busiest channels', value: chanLines(ctx, topChannels(ctx, from)) },
      ).setFooter({ text: 'See /stats coverage for what these numbers include.' });
    return reply({ embeds: [e] });
  }
  if (sub === 'top') {
    const metric = i.options.getString('metric', true);
    const fmt = metric === 'voice' ? (n) => `${hours(n)} h` : (n) => n.toLocaleString('en-US');
    return reply({ embeds: [new EmbedBuilder().setTitle(`🏆 Top ${metric} · ${PERIOD_WORDS[period]}`).setColor(0xfbbf24).setDescription(lines(ctx, topMembers(ctx, metric, from, undefined, 10), fmt))] });
  }
  // me
  const user = i.options.getUser('member') ?? i.user;
  if (out(ctx.guildId).has(user.id)) return reply(user.id === i.user.id ? 'You opted out of statistics. Use `/stats optin` to be counted again.' : 'That member opted out of statistics.');
  const r = sumRow(ctx, user.id, from);
  const rank = ctx.sql.get(`SELECT COUNT(*) + 1 AS n FROM (SELECT user_id, SUM(messages + messages_bf) AS m FROM stats_user_day WHERE guild_id = ? AND day >= ? GROUP BY user_id) WHERE m > ?`, ctx.guildId, from, r.messages).n;
  const e = new EmbedBuilder().setTitle(`📊 ${name(ctx, user.id)} · ${PERIOD_WORDS[period]}`).setColor(0x38bdf8)
    .addFields(
      { name: 'Messages', value: `${r.messages.toLocaleString('en-US')}${r.bf ? ` (${r.bf.toLocaleString('en-US')} backfilled)` : ''}`, inline: true },
      { name: 'Voice hours', value: String(hours(r.voice)), inline: true }, { name: 'Reactions given', value: r.reactions.toLocaleString('en-US'), inline: true },
      { name: 'Active days', value: String(r.days), inline: true }, { name: 'Message rank', value: r.messages ? `#${rank}` : '-', inline: true },
    ).setFooter({ text: 'Voice time = connected time. See /stats coverage.' });
  return reply({ embeds: [e] });
}

const closeVoiceSnapshot = (ctx) => { closeVoice(ctx); flush(ctx); };

// ------------------------------------------------------------------ dashboard
const views = {
  async overview(ctx) {
    flush(ctx); closeVoice(ctx); flush(ctx);
    const from = startDay(ctx, '7d');
    const rows = topMembers(ctx, 'messages', from, undefined, 15).map((r) => ({ id: r.id, member: name(ctx, r.id).replace(/^<@(\d+)>$/, '$1'), messages: r.n, voice: hours(ctx.sql.get('SELECT COALESCE(SUM(voice_seconds), 0) AS v FROM stats_user_day WHERE guild_id = ? AND user_id = ? AND day >= ?', ctx.guildId, r.id, from).v) }));
    return { rows, note: coverageText(ctx).replace(/<t:(\d+):[a-zA-Z]>/g, (_, s) => new Date(+s * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC').replace(/<#(\d+)>/g, (_, id) => `#${ctx.guild?.channels.cache.get(id)?.name ?? id}`).replace(/\*\*/g, '').replace(/`/g, '') };
  },
};

export default {
  name: 'stats',
  version: '1.0.0',
  description: 'Counts messages, voice time and reactions (never message text) for member stats, server stats, leaderboards and weekly recaps. Honest about what history it covers.',
  settings: [
    { key: 'trackVoice', type: 'toggle', label: 'Count time connected to voice channels', default: true },
    { key: 'ignoredChannels', type: 'list', label: 'Channels or categories that are not counted - IDs' },
    { key: 'recapChannel', type: 'channel', label: 'Where the weekly recap is posted (leave empty for none)' },
    { key: 'timezoneOffset', type: 'number', label: 'Server timezone offset from UTC, in hours (decides where a day and a week start)', default: 0, min: -12, max: 14 },
  ],
  permissions: [
    { key: 'stats.view', label: 'See statistics', default: 'everyone' },
    { key: 'stats.manage', label: 'Backfill history and post recaps', default: 'admin' },
  ],
  commands: [{
    permission: 'stats.view',
    data: new SlashCommandBuilder().setName('stats').setDescription('Activity statistics')
      .addSubcommand((s) => s.setName('me').setDescription('Your numbers (or someone else\'s)').addUserOption((o) => o.setName('member').setDescription('Whose')).addStringOption((o) => o.setName('period').setDescription('How far back').addChoices(...periodChoices)))
      .addSubcommand((s) => s.setName('server').setDescription('Server totals').addStringOption((o) => o.setName('period').setDescription('How far back').addChoices(...periodChoices)))
      .addSubcommand((s) => s.setName('top').setDescription('Leaderboard')
        .addStringOption((o) => o.setName('metric').setDescription('What to rank').setRequired(true).addChoices({ name: 'messages', value: 'messages' }, { name: 'voice time', value: 'voice' }, { name: 'reactions given', value: 'reactions' }))
        .addStringOption((o) => o.setName('period').setDescription('How far back').addChoices(...periodChoices)))
      .addSubcommand((s) => s.setName('coverage').setDescription('Exactly what the numbers cover'))
      .addSubcommand((s) => s.setName('recap').setDescription('Preview a recap (staff)').addStringOption((o) => o.setName('period').setDescription('How far back').addChoices(...periodChoices)))
      .addSubcommand((s) => s.setName('backfill').setDescription('Count older messages from channel history (staff)').addIntegerOption((o) => o.setName('days').setDescription('How many days back').setRequired(true).setMinValue(1).setMaxValue(3650)))
      .addSubcommand((s) => s.setName('optout').setDescription('Stop being counted'))
      .addSubcommand((s) => s.setName('optin').setDescription('Be counted again'))
      .addSubcommand((s) => s.setName('forget').setDescription('Erase your numbers in this server')),
    execute: statsCmd,
  }],
  events: { messageCreate: onMessage, messageReactionAdd: onReaction, voiceStateUpdate: onVoice, guildMemberAdd: onJoin, guildMemberRemove: onLeave },
  tasks: [
    { name: 'flush', everyMs: 10000, run: (ctx) => flush(ctx) },
    { name: 'recap', everyMs: 600000, run: weeklyRecap },
  ],
  migrations: [{ id: 1, sql: `
    CREATE TABLE IF NOT EXISTS stats_user_day (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, day TEXT NOT NULL,
      messages INTEGER NOT NULL DEFAULT 0, messages_bf INTEGER NOT NULL DEFAULT 0, voice_seconds INTEGER NOT NULL DEFAULT 0, reactions INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, day));
    CREATE INDEX IF NOT EXISTS stats_user_day_by_day ON stats_user_day (guild_id, day);
    CREATE TABLE IF NOT EXISTS stats_channel_day (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, day TEXT NOT NULL,
      messages INTEGER NOT NULL DEFAULT 0, messages_bf INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, channel_id, day));
    CREATE TABLE IF NOT EXISTS stats_guild_day (guild_id TEXT NOT NULL, day TEXT NOT NULL, joins INTEGER NOT NULL DEFAULT 0, leaves INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, day));
    CREATE TABLE IF NOT EXISTS stats_optout (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
  ` }],
  views,
  panels: [{ id: 'overview', title: 'Activity (7 days)', view: 'overview', permission: 'stats.manage', columns: [{ key: 'member', label: 'Member' }, { key: 'messages', label: 'Messages' }, { key: 'voice', label: 'Voice hours' }] }],
  async init(ctx) {
    out(ctx.guildId).clear();
    for (const r of ctx.sql.all('SELECT user_id FROM stats_optout WHERE guild_id = ?', ctx.guildId)) out(ctx.guildId).add(r.user_id);
    if (!ctx.data.get('coverage')) ctx.data.set('coverage', { trackingSince: Date.now() });
    const t = tracker(ctx.guildId);
    for (const [id, st] of ctx.guild?.voiceStates?.cache ?? []) if (st.channelId && st.channelId !== ctx.guild.afkChannelId && !st.member?.user?.bot) t.enter(id, Date.now());
  },
  async destroy(ctx) { closeVoice(ctx); flush(ctx); voice.delete(ctx.guildId); },
};
