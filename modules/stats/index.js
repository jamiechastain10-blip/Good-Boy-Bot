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
import { SlashCommandBuilder, EmbedBuilder, ChannelType, MessageFlags, PermissionFlagsBits as P, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { UserError, truncate, ts, describeDiscordError } from '../../src/util.js';
import { dayKey, weekStartKey, addDays, periodStart, VoiceTracker, hours } from '../../src/activity.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const need = (ctx, i, key) => { if (!ctx.perms.check(i.member, key)) throw new UserError(`You don't have permission for that (\`${key}\`).`); };
const tz = (ctx) => ctx.config.get('timezoneOffset');
const periodChoices = [{ name: 'last 7 days', value: '7d' }, { name: 'last 30 days', value: '30d' }, { name: 'last 90 days', value: '90d' }, { name: 'last year', value: '365d' }, { name: 'all time (includes counted history)', value: 'all' }];
const PERIOD_WORDS = { '7d': 'last 7 days', '30d': 'last 30 days', '90d': 'last 90 days', '365d': 'last year', all: 'all time' };

// ------------------------------------------------------------------ live counting (buffered, flushed every few seconds)
const buffers = new Map();   // guildId -> { user: Map, chan: Map, guild: Map }
const voice = new Map();     // guildId -> VoiceTracker
const optedOut = new Map();  // guildId -> Set(userId)
const buf = (g) => { let b = buffers.get(g); if (!b) buffers.set(g, b = { user: new Map(), chan: new Map(), guild: new Map(), hour: new Map() }); return b; };
const bump = (map, key, field, n = 1) => { const row = map.get(key) ?? {}; row[field] = (row[field] ?? 0) + n; map.set(key, row); };
const tracker = (g) => { let t = voice.get(g); if (!t) voice.set(g, t = new VoiceTracker()); return t; };
const out = (g) => { let s = optedOut.get(g); if (!s) optedOut.set(g, s = new Set()); return s; };

export function flush(ctx) {
  const b = buffers.get(ctx.guildId);
  if (!b || (!b.user.size && !b.chan.size && !b.guild.size && !b.hour?.size)) return;
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
    for (const [hour, r] of b.hour ?? []) {
      ctx.sql.run(`INSERT INTO stats_hour (guild_id, hour, messages) VALUES (?, ?, ?) ON CONFLICT(guild_id, hour) DO UPDATE SET messages = messages + excluded.messages`, ctx.guildId, Number(hour), r.messages ?? 0);
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
  bump(b.hour ??= new Map(), String(hourOf(m.createdTimestamp ?? Date.now(), tz(ctx))), 'messages');
}
const hourOf = (ms, offset = 0) => new Date(ms + offset * 3600000).getUTCHours();

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
  if (jobs.has(ctx.guildId)) parts.push(progressText(jobs.get(ctx.guildId)));
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

/** Every thread the bot can find: active ones, plus archived ones in each channel and forum. Unreadable lists are skipped. */
async function allThreads(ctx, channels) {
  const found = new Map();
  const active = await ctx.queue(() => ctx.guild.channels.fetchActiveThreads?.()).catch(() => null);
  for (const t of active?.threads?.values?.() ?? []) found.set(t.id, t);
  const parents = [...channels, ...[...ctx.guild.channels.cache.values()].filter((c) => c.type === ChannelType.GuildForum || c.type === ChannelType.GuildMedia)];
  for (const parent of parents) {
    if (!parent.threads?.fetchArchived || ignored(ctx, parent.id)) continue;
    for (const type of ['public', 'private']) {
      let before;
      for (let page = 0; page < 200; page++) {
        const r = await ctx.queue(() => parent.threads.fetchArchived({ type, limit: 100, ...(before ? { before } : {}) })).catch(() => null);
        const list = [...(r?.threads?.values?.() ?? [])];
        for (const t of list) found.set(t.id, t);
        if (!r?.hasMore || !list.length) break;
        before = list.at(-1).id;
      }
    }
  }
  return [...found.values()].filter((t) => t.messages?.fetch);
}

// ------------------------------------------------------------------ backfill as a background job
// A whole server's history can take hours (Discord hands out 100 messages per request), far longer than the 15 minutes
// a command may answer in. So /stats backfill starts a job and answers straight away; the job reports progress, survives
// a hot reload, starts again by itself after a restart, and messages whoever started it when it is done.
const jobs = (globalThis[Symbol.for('goodboy.stats.backfill')] ??= new Map()); // guildId -> live progress
export const backfillRunning = (guildId) => jobs.get(guildId) ?? null;

function progressText(p) {
  if (!p) return '';
  const where = p.current ? ` · now reading <#${p.current}>` : '';
  const back = p.oldest ? `, back to ${ts(p.oldest, 'D')}` : '';
  return `⏳ Counting history: **${(p.messages ?? 0).toLocaleString('en-US')}** messages so far${back} · channel ${p.index ?? 0} of ${p.channelsTotal ?? '?'}${where}`;
}

export function startBackfill(ctx, { days = null, by = null, channelId = null, resumed = false } = {}) {
  if (jobs.has(ctx.guildId)) return { started: false, progress: jobs.get(ctx.guildId) };
  const job = { days, by, channelId, startedAt: Date.now() };
  ctx.data.set('backfillJob', job);
  const live = { messages: 0, index: 0, channelsTotal: null, startedAt: job.startedAt, days };
  jobs.set(ctx.guildId, live);
  const done = (async () => {
    let text;
    try {
      const r = await backfill(ctx, { days, perChannel: Infinity, total: Infinity, threads: true, onProgress: (p) => Object.assign(live, p) });
      const span = days ? `the last ${days.toLocaleString('en-US')} days` : 'all time';
      text = `✅ **Message history counted** (${span}) in **${ctx.guild?.name ?? 'your server'}**: ${r.messages.toLocaleString('en-US')} messages in ${r.channels} channels and threads.\n\n${coverageText(ctx)}`;
      ctx.live('activity', { icon: '📊', text: `Message history counted: ${r.messages.toLocaleString('en-US')} messages` });
      ctx.live('data');
    } catch (e) {
      text = `❌ Counting message history in **${ctx.guild?.name ?? 'your server'}** stopped: ${describeDiscordError(e, 'read the history')}. Run \`/stats backfill\` to try again.`;
      ctx.log.warn(`Backfill failed: ${e.message}`);
    } finally {
      jobs.delete(ctx.guildId);
      ctx.data.delete('backfillJob');
    }
    await tellOwner(ctx, job, text);
  })();
  return { started: true, resumed, done };
}

/** DM whoever started it; if their DMs are closed, post in the channel they used (never a ping). */
async function tellOwner(ctx, job, text) {
  const content = truncate(text, 1900);
  const user = job.by ? await ctx.client?.users?.fetch?.(job.by).catch(() => null) : null;
  if (user && await user.send({ content, allowedMentions: NOPING }).then(() => true).catch(() => false)) return;
  const ch = ctx.guild?.channels.cache.get(job.channelId);
  if (ch?.isTextBased?.()) await ctx.queue(() => ch.send({ content, allowedMentions: NOPING })).catch(() => {});
}

/** Count older messages from channel history. `limits.perChannel` / `limits.total` keep it bounded. */
export async function backfill(ctx, { days, perChannel = 5000, total = 50000, threads = false, onProgress } = {}) {
  const since = days ? Date.now() - days * 86400000 : 0; // no days = all time
  const cov = ctx.data.get('coverage') ?? { trackingSince: Date.now() };
  const cutoff = cov.trackingSince;
  const result = { ranAt: Date.now(), days, messages: 0, channels: 0, skipped: [], truncated: [], oldest: null, perChannel, total };
  const rows = new Map(); const chans = new Map(); const hoursBf = new Map();
  const me = ctx.guild.members.me;
  const channels = [...ctx.guild.channels.cache.values()].filter((c) => c.isTextBased?.() && !c.isVoiceBased?.() && c.messages?.fetch && c.type !== ChannelType.GuildCategory);
  if (threads) channels.push(...await allThreads(ctx, channels));
  result.channelsTotal = channels.length;
  let left = total;
  let index = 0;
  for (const ch of channels) {
    index++;
    onProgress?.({ ...result, index, current: ch.id });
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
          bump(rows, `${m.author.id}|${day}`, 'bf'); bump(chans, `${ch.id}|${day}`, 'bf'); bump(hoursBf, String(hourOf(m.createdTimestamp, tz(ctx))), 'bf');
          result.messages++;
          if (!result.oldest || m.createdTimestamp < result.oldest) result.oldest = m.createdTimestamp;
        }
      }
      before = list.reduce((a, m) => (m.createdTimestamp < a.createdTimestamp ? m : a), list[0]).id;
      if (hitLimit || reachedOld || list.length < 100) break;
      if (scanned % 2000 === 0) onProgress?.({ ...result, index, current: ch.id });
    }
    if (!readable && !got) { result.skipped.push(ch.id); continue; }
    result.channels++;
    if (hitLimit) result.truncated.push(ch.id);
  }
  ctx.sql.transaction(() => {
    ctx.sql.run('UPDATE stats_user_day SET messages_bf = 0 WHERE guild_id = ?', ctx.guildId);
    ctx.sql.run('UPDATE stats_channel_day SET messages_bf = 0 WHERE guild_id = ?', ctx.guildId);
    ctx.sql.run('UPDATE stats_hour SET messages_bf = 0 WHERE guild_id = ?', ctx.guildId);
    for (const [hour, r] of hoursBf) ctx.sql.run(`INSERT INTO stats_hour (guild_id, hour, messages_bf) VALUES (?, ?, ?) ON CONFLICT(guild_id, hour) DO UPDATE SET messages_bf = excluded.messages_bf`, ctx.guildId, Number(hour), r.bf);
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

  if (sub === 'inactive') {
    need(ctx, i, 'stats.prune');
    const days = i.options.getInteger('days') || ctx.config.get('inactiveDays');
    await i.deferReply({ flags: EPH });
    return i.editReply(inactiveMessage(ctx, i.user.id, await inactiveMembers(ctx, days)));
  }

  if (sub === 'backfill') {
    need(ctx, i, 'stats.manage');
    const days = i.options.getInteger('days') || null; // empty = all time
    const job = startBackfill(ctx, { days, by: i.user.id, channelId: i.channelId });
    if (!job.started) return reply(`Already counting.\n${progressText(job.progress)}\n\nI'll message you when it's done.`);
    const head = `📊 Started counting message history (${days ? `the last ${days.toLocaleString('en-US')} days` : '**all time**'}, including threads). Big servers can take a while: Discord hands out 100 messages at a time.\nI'll **message you when it's done**. Check on it any time with \`/stats coverage\`.`;
    await reply(head);
    // Keep this private reply ticking for as long as Discord lets it be edited (15 minutes).
    const until = Date.now() + 14 * 60000;
    const timer = setInterval(() => {
      const p = jobs.get(ctx.guildId);
      if (!p || Date.now() > until) { clearInterval(timer); if (!p) i.editReply({ content: '✅ Done. I sent you the results.' }).catch(() => {}); return; }
      i.editReply({ content: `${head}\n\n${progressText(p)}`, allowedMentions: NOPING }).catch(() => clearInterval(timer));
    }, 10000);
    timer.unref?.();
    return;
  }

  const period = i.options.getString('period') ?? (ctx.data.get('coverage')?.backfill ? 'all' : '7d'); // with counted history, show it
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
/** Every member with any activity: when they were last active and how much, live and backfilled together. */
export function memberActivity(ctx, limit = 200) {
  const d30 = startDay(ctx, '30d');
  return ctx.sql.all(`SELECT user_id AS id, MAX(day) AS last, SUM(messages + messages_bf) AS total,
      SUM(CASE WHEN day >= ? THEN messages + messages_bf ELSE 0 END) AS recent,
      SUM(CASE WHEN day >= ? THEN voice_seconds ELSE 0 END) AS voice
    FROM stats_user_day WHERE guild_id = ? AND (messages + messages_bf + voice_seconds + reactions) > 0
    GROUP BY user_id ORDER BY last DESC, total DESC LIMIT ?`, d30, d30, ctx.guildId, limit);
}

// ------------------------------------------------------------------ inactive members (monthly clean-up)
// Who has not sent a message, been in voice or reacted for N days. Bots, the owner, staff (Kick/Ban/Manage Server/Admin),
// exempt roles and anyone who joined less than N days ago are never listed. Kicking always asks first, and the member
// can be told why (with "you're welcome back").
const STAFF_BITS = [P.Administrator, P.ManageGuild, P.KickMembers, P.BanMembers];
const PAGE = 15;

/** The earliest moment the numbers cover: tracking start, or further back when history was counted. */
export function coverageStart(ctx) {
  const c = ctx.data.get('coverage') ?? {};
  let start = c.trackingSince ?? Date.now();
  const bf = c.backfill;
  if (bf) start = Math.min(start, bf.days ? bf.ranAt - bf.days * 86400000 : (ctx.guild?.createdTimestamp ?? 0));
  return start;
}

export async function inactiveMembers(ctx, days = ctx.config.get('inactiveDays')) {
  flush(ctx);
  if (ctx.guild?.members.fetch) await ctx.guild.members.fetch().catch(() => null); // everyone, not only those seen lately
  const now = Date.now();
  const since = dayKey(now - days * 86400000, tz(ctx));
  const exempt = new Set((ctx.config.get('inactiveExemptRoles') ?? []).map(String));
  const last = new Map(ctx.sql.all(`SELECT user_id AS id, MAX(day) AS last, SUM(messages + messages_bf) AS total FROM stats_user_day
    WHERE guild_id = ? AND (messages + messages_bf + voice_seconds + reactions) > 0 GROUP BY user_id`, ctx.guildId).map((r) => [r.id, r]));
  const out = [];
  for (const m of ctx.guild?.members.cache.values() ?? []) {
    if (m.user?.bot || m.id === ctx.guild.ownerId) continue;
    if (STAFF_BITS.some((b) => m.permissions?.has?.(b))) continue;
    if ([...(m.roles?.cache?.keys?.() ?? [])].some((r) => exempt.has(r))) continue;
    if (m.joinedTimestamp && now - m.joinedTimestamp < days * 86400000) continue; // too new to judge
    const a = last.get(m.id);
    if (a && a.last >= since) continue;
    out.push({ id: m.id, name: m.displayName ?? m.user?.username ?? m.id, last: a?.last ?? null, total: a?.total ?? 0, joined: m.joinedTimestamp ?? null, kickable: m.kickable !== false });
  }
  // never active first, then the longest quiet
  out.sort((x, y) => (x.last ?? '') < (y.last ?? '') ? -1 : (x.last ?? '') > (y.last ?? '') ? 1 : (x.joined ?? 0) - (y.joined ?? 0));
  const coveredDays = Math.floor((now - coverageStart(ctx)) / 86400000);
  return { days, list: out, coveredDays, short: coveredDays < days };
}

const lastText = (r) => (r.last ? `last active ${r.last}` : 'no activity on record');
function coverageWarning(res) {
  return res.short ? `⚠️ Activity has only been tracked for **${res.coveredDays} days**, less than ${res.days}. "No activity on record" may just mean before tracking began. Run \`/stats backfill\` to count older messages.` : null;
}

/** Kick a list of members for inactivity. Re-checks each one, so nobody active, staff or exempt is kicked by a stale list. */
export async function kickInactive(ctx, ids, actorId) {
  const res = await inactiveMembers(ctx);
  const still = new Map(res.list.map((r) => [r.id, r]));
  const done = [], skipped = [];
  const dm = ctx.config.get('inactiveDm');
  const text = String(ctx.config.get('inactiveDmText') || '').replaceAll('{server}', ctx.guild?.name ?? 'the server').replaceAll('{days}', String(res.days));
  for (const id of ids) {
    const m = ctx.guild?.members.cache.get(id);
    if (!m || !still.has(id) || m.kickable === false) { skipped.push(id); continue; }
    if (dm && text) await m.user?.send?.({ content: truncate(text, 1900), allowedMentions: NOPING }).catch(() => {});
    const ok = await ctx.queue(() => m.kick(`Inactive for ${res.days}+ days (removed by ${actorId ?? 'staff'})`)).then(() => true).catch(() => false);
    (ok ? done : skipped).push(id);
  }
  if (done.length) {
    const log = ctx.data.get('pruneLog') ?? [];
    log.unshift({ at: Date.now(), by: actorId, count: done.length, days: res.days });
    ctx.data.set('pruneLog', log.slice(0, 24));
    ctx.live('activity', { icon: '🧹', text: `${done.length} inactive member${done.length === 1 ? '' : 's'} removed` });
    ctx.live('data');
  }
  return { kicked: done.length, skipped: skipped.length };
}

function inactiveMessage(ctx, owner, res, page = 0) {
  const pages = Math.max(1, Math.ceil(res.list.length / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = res.list.slice(page * PAGE, page * PAGE + PAGE);
  const lines = slice.map((r, k) => `**${page * PAGE + k + 1}.** <@${r.id}> · ${lastText(r)}${r.total ? ` · ${r.total.toLocaleString('en-US')} msgs` : ''}${r.joined ? ` · joined ${ts(r.joined, 'D')}` : ''}${r.kickable ? '' : ' · 🔒 can\'t kick'}`);
  const e = new EmbedBuilder().setColor(0xe67e22).setTitle(`🧹 Inactive for ${res.days}+ days · ${res.list.length} member${res.list.length === 1 ? '' : 's'}`)
    .setDescription([coverageWarning(res), lines.join('\n') || '*Everyone has been active. Nothing to clean up.*'].filter(Boolean).join('\n\n'))
    .setFooter({ text: `Page ${page + 1}/${pages} · not listed: bots, staff, exempt roles, members who joined in the last ${res.days} days` });
  const rows = [];
  const kickable = slice.filter((r) => r.kickable);
  if (kickable.length) rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`st:ik:${owner}:${res.days}`)
    .setPlaceholder('Pick members to kick (asks first)').setMinValues(1).setMaxValues(kickable.length)
    .addOptions(kickable.map((r) => ({ label: truncate(r.name, 90), value: r.id, description: truncate(lastText(r), 90) })))));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`st:ip:${owner}:${res.days}:${page - 1}`).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`st:ip:${owner}:${res.days}:${page + 1}`).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    new ButtonBuilder().setCustomId(`st:ia:${owner}:${res.days}`).setLabel(`Kick all ${res.list.filter((r) => r.kickable).length}`).setEmoji('🧹').setStyle(ButtonStyle.Danger).setDisabled(!res.list.some((r) => r.kickable))));
  return { embeds: [e], components: rows, allowedMentions: NOPING };
}

function confirmMessage(owner, ids, days) {
  return { content: `Kick **${ids.length}** member${ids.length === 1 ? '' : 's'} for being inactive ${days}+ days? ${ids.slice(0, 20).map((id) => `<@${id}>`).join(' ')}${ids.length > 20 ? ` and ${ids.length - 20} more` : ''}\nThey can rejoin with an invite.`,
    embeds: [], allowedMentions: NOPING, components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`st:ic:${owner}`).setLabel(`Yes, kick ${ids.length}`).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`st:ix:${owner}:${days}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))] };
}

async function inactiveClick(ctx, i) {
  const [, kind, owner, a, b] = i.customId.split(':');
  if (owner !== i.user.id) throw new UserError('That list belongs to someone else. Run `/stats inactive` for your own.');
  need(ctx, i, 'stats.prune');
  if (kind === 'ip') return i.update(inactiveMessage(ctx, owner, await inactiveMembers(ctx, Number(a)), Number(b)));
  if (kind === 'ix') return i.update({ content: null, ...inactiveMessage(ctx, owner, await inactiveMembers(ctx, Number(a))) });
  if (kind === 'ik' || kind === 'ia') {
    const ids = kind === 'ik' ? [...(i.values ?? [])] : (await inactiveMembers(ctx, Number(a))).list.filter((r) => r.kickable).map((r) => r.id);
    if (!ids.length) throw new UserError('Nobody to kick.');
    ctx.data.set(`prune:pending:${owner}`, { ids, days: Number(a), at: Date.now() });
    return i.update(confirmMessage(owner, ids, Number(a)));
  }
  if (kind === 'ic') {
    const pending = ctx.data.get(`prune:pending:${owner}`);
    ctx.data.delete(`prune:pending:${owner}`);
    if (!pending || Date.now() - pending.at > 15 * 60000) throw new UserError('That confirmation expired. Run `/stats inactive` again.');
    await i.update({ content: `🧹 Kicking ${pending.ids.length}...`, components: [] });
    const r = await kickInactive(ctx, pending.ids, i.user.id);
    return i.editReply({ content: `✅ Kicked **${r.kicked}**${r.skipped ? ` · ${r.skipped} skipped (became active, left, or I can't kick them)` : ''}.`, components: [] });
  }
  throw new UserError('That button is no longer active.');
}

/**
 * A week before the monthly review, members on the inactive list get a friendly "we miss you" message, so they have
 * a chance to come back before anyone is kicked. Once a month; members who have their DMs closed are skipped.
 */
export async function missYouWarning(ctx, now = Date.now()) {
  if (!ctx.config.get('inactiveWarn')) return 0;
  const today = dayKey(now, tz(ctx));
  const [y, mo, d] = today.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d !== daysInMonth - 6 || ctx.data.get('lastWarnMonth') === today.slice(0, 7)) return 0;
  ctx.data.set('lastWarnMonth', today.slice(0, 7));
  const res = await inactiveMembers(ctx);
  const text = String(ctx.config.get('inactiveWarnText') || '').replaceAll('{server}', ctx.guild?.name ?? 'the server').replaceAll('{days}', String(res.days));
  let sent = 0;
  for (const r of res.list) {
    const m = ctx.guild?.members.cache.get(r.id);
    if (await m?.user?.send?.({ content: truncate(text, 1900), allowedMentions: NOPING }).then(() => true).catch(() => false)) sent++;
  }
  ctx.live('activity', { icon: '💌', text: `"We miss you" sent to ${sent} quiet member${sent === 1 ? '' : 's'}` });
  return sent;
}

/** On the 1st of each month: tell staff how many members have gone quiet. First run only starts the clock. */
async function monthlyReview(ctx) {
  const channelId = ctx.config.get('reviewChannel');
  const month = dayKey(Date.now(), tz(ctx)).slice(0, 7);
  const last = ctx.data.get('lastReviewMonth');
  if (!last) { ctx.data.set('lastReviewMonth', month); return; }
  if (last === month || !channelId) return;
  ctx.data.set('lastReviewMonth', month);
  const ch = ctx.guild?.channels.cache.get(channelId);
  if (!ch?.isTextBased?.()) return;
  const res = await inactiveMembers(ctx);
  const e = new EmbedBuilder().setColor(0xe67e22).setTitle('🧹 Monthly activity review')
    .setDescription([`**${res.list.length}** member${res.list.length === 1 ? ' has' : 's have'} not been active in the last ${res.days} days.`, coverageWarning(res),
      res.list.length ? 'Review and kick with `/stats inactive`, or in the dashboard under Stats > Inactive members.' : 'Nothing to clean up this month.'].filter(Boolean).join('\n\n'));
  await ctx.queue(() => ch.send({ embeds: [e], allowedMentions: NOPING })).catch((err) => ctx.log.warn(`Monthly review: ${describeDiscordError(err, 'post it')}`));
}

// ------------------------------------------------------------------ counter channels (2.3, what Statbot did)
// Voice channels whose names show live numbers. Discord allows a channel to be renamed twice per 10 minutes, so
// names are refreshed every 10 minutes and only when the number changed.
export const COUNTER_VARS = '{members} {humans} {bots} {online} {boosts} {voice}';
export async function counterValues(ctx) {
  const g = ctx.guild;
  const members = [...(g?.members.cache.values() ?? [])];
  const bots = members.filter((m) => m.user?.bot).length;
  let online = g?.presences?.cache?.filter?.((p) => p.status && p.status !== 'offline')?.size ?? 0;
  if (!online && ctx.client?.guilds?.fetch) online = (await ctx.client.guilds.fetch({ guild: g.id, withCounts: true, force: true }).catch(() => null))?.approximatePresenceCount ?? 0;
  const voice = g?.voiceStates?.cache?.filter?.((v) => v.channelId && !v.member?.user?.bot)?.size ?? 0;
  const total = g?.memberCount ?? members.length;
  return { members: total, humans: Math.max(0, total - bots), bots, online, boosts: g?.premiumSubscriptionCount ?? 0, voice };
}
export const counterName = (tpl, v) => String(tpl).replace(/\{(members|humans|bots|online|boosts|voice)\}/g, (_, k) => Number(v[k] ?? 0).toLocaleString('en-US')).slice(0, 100);

export async function refreshCounters(ctx) {
  const list = ctx.data.list('counter:');
  if (!list.length) return 0;
  const v = await counterValues(ctx);
  let changed = 0;
  for (const { key, value } of list) {
    const ch = ctx.guild?.channels.cache.get(key.slice(8));
    if (!ch) continue;
    const name = counterName(value.template, v);
    if (ch.name !== name) { await ctx.queue(() => ch.setName(name)).then(() => changed++).catch((e) => ctx.log.warn(`Counter: ${e.message}`)); }
  }
  return changed;
}

async function counterCmd(ctx, i) {
  need(ctx, i, 'stats.manage');
  const sub = i.options.getSubcommand();
  const reply = (content) => i.reply({ content, flags: EPH, allowedMentions: NOPING });
  if (sub === 'list') {
    const rows = ctx.data.list('counter:').map(({ key, value }) => `<#${key.slice(8)}> · \`${value.template}\``);
    return reply(rows.length ? rows.join('\n') : `No counters yet. Add one with \`/counter add\`. You can use ${COUNTER_VARS}.`);
  }
  const picked = i.options.getChannel('channel', true);
  const ch = ctx.guild.channels.cache.get(picked.id) ?? picked;
  if (sub === 'remove') { ctx.data.delete(`counter:${ch.id}`); return reply(`Removed the counter from <#${ch.id}>. (The channel stays; delete it in Discord if you want.)`); }
  const template = i.options.getString('text', true);
  if (!/\{(members|humans|bots|online|boosts|voice)\}/.test(template)) throw new UserError(`Put at least one number in the text: ${COUNTER_VARS}`);
  ctx.data.set(`counter:${ch.id}`, { template, by: i.user.id });
  const name = counterName(template, await counterValues(ctx));
  await ctx.queue(() => ch.setName(name)).catch((e) => { throw new UserError(`I couldn't rename <#${ch.id}>: ${describeDiscordError(e, 'rename it')}`); });
  return reply(`✅ <#${ch.id}> is now a counter: **${name}**. It updates every 10 minutes (Discord's limit for renaming channels).`);
}

const views = {
  async charts(ctx) {
    flush(ctx);
    const today = dayKey(Date.now(), tz(ctx));
    const from = addDays(today, -29);
    const perDay = new Map(ctx.sql.all('SELECT day, SUM(messages + messages_bf) AS n FROM stats_user_day WHERE guild_id = ? AND day >= ? GROUP BY day', ctx.guildId, from).map((r) => [r.day, r.n]));
    const joins = new Map(ctx.sql.all('SELECT day, joins, leaves FROM stats_guild_day WHERE guild_id = ? AND day >= ?', ctx.guildId, from).map((r) => [r.day, r]));
    const days = Array.from({ length: 30 }, (_, k) => addDays(from, k));
    const hours = new Map(ctx.sql.all('SELECT hour, messages + messages_bf AS n FROM stats_hour WHERE guild_id = ?', ctx.guildId).map((r) => [r.hour, r.n]));
    const off = tz(ctx);
    return {
      rows: [],
      charts: [
        { title: 'Messages per day (last 30 days)', bars: days.map((d, k) => ({ label: d, short: k % 5 === 0 ? d.slice(5) : '', value: perDay.get(d) ?? 0 })) },
        { title: `Busiest hours (all messages, UTC${off >= 0 ? '+' : ''}${off})`, bars: Array.from({ length: 24 }, (_, hr) => ({ label: `${String(hr).padStart(2, '0')}:00`, short: hr % 3 === 0 ? String(hr) : '', value: hours.get(hr) ?? 0 })) },
        { title: 'Members joining per day (last 30 days)', bars: days.map((d, k) => ({ label: `${d}: +${joins.get(d)?.joins ?? 0} / -${joins.get(d)?.leaves ?? 0}`, short: k % 5 === 0 ? d.slice(5) : '', value: joins.get(d)?.joins ?? 0 })) },
      ],
    };
  },
  async inactive(ctx) {
    const res = await inactiveMembers(ctx);
    const rows = res.list.map((r) => ({ id: r.id, member: r.name, last: r.last ?? 'never', total: r.total, joined: r.joined ? new Date(r.joined).toISOString().slice(0, 10) : '', kick: r.kickable ? '' : "can't kick" }));
    return { rows, note: [`Inactive for ${res.days}+ days (change it in settings). Not listed: bots, staff, exempt roles, members who joined in the last ${res.days} days.`, res.short ? `Activity has only been tracked for ${res.coveredDays} days: "never" may just mean before tracking began.` : ''].filter(Boolean).join(' ') };
  },
  async members(ctx) {
    flush(ctx); closeVoice(ctx); flush(ctx);
    const today = dayKey(Date.now(), tz(ctx));
    const ago = (day) => { const n = Math.round((Date.parse(today) - Date.parse(day)) / 86400000); return n <= 0 ? 'today' : n === 1 ? 'yesterday' : n < 60 ? `${n} days ago` : day; };
    const rows = memberActivity(ctx).map((r) => ({ id: r.id, member: name(ctx, r.id).replace(/^<@(\d+)>$/, '$1'), last: ago(r.last), recent: r.recent, voice: hours(r.voice), total: r.total, here: ctx.guild?.members.cache.has(r.id) ? 'yes' : 'left' }));
    return { rows, note: 'Live and backfilled messages together. Newest activity first. "Last active" counts messages, voice and reactions.' };
  },
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
    { key: 'inactiveDays', type: 'number', label: 'Inactive members: no activity for this many days', default: 30, min: 7, max: 365 },
    { key: 'inactiveExemptRoles', type: 'list', label: 'Inactive members: roles that are never listed (role IDs, one per line)' },
    { key: 'inactiveWarn', type: 'toggle', label: 'Inactive members: send a "we miss you" message a week before the monthly review', default: false },
    { key: 'inactiveWarnText', type: 'text', label: 'That message ({server}, {days})', default: "Hey! We haven't seen you in {server} for a while. Come say hi, members who stay quiet for {days} days are removed at the start of next month (you can always rejoin).", maxLength: 500 },
    { key: 'reviewChannel', type: 'channel', label: 'Staff channel for the monthly activity review (leave empty for none)' },
    { key: 'inactiveDm', type: 'toggle', label: 'Inactive members: send a message before kicking', default: true },
    { key: 'inactiveDmText', type: 'text', label: 'That message ({server}, {days})', default: "You were removed from {server} because you haven't been active for {days} days. You're welcome back any time!", maxLength: 500 },
    { key: 'timezoneOffset', type: 'number', label: 'Server timezone offset from UTC, in hours (decides where a day and a week start)', default: 0, min: -12, max: 14 },
  ],
  permissions: [
    { key: 'stats.view', label: 'See statistics', default: 'everyone' },
    { key: 'stats.manage', label: 'Backfill history and post recaps', default: 'admin' },
    { key: 'stats.prune', label: 'See inactive members and kick them', default: 'admin', discordPerm: 'KickMembers' },
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
      .addSubcommand((s) => s.setName('backfill').setDescription('Count older messages from channel history (staff)').addIntegerOption((o) => o.setName('days').setDescription('How many days back (leave empty for all time)').setMinValue(1).setMaxValue(36500)))
      .addSubcommand((s) => s.setName('inactive').setDescription('Members who have not been active lately, to clean up (staff)').addIntegerOption((o) => o.setName('days').setDescription('No activity for how many days (empty = the server setting)').setMinValue(7).setMaxValue(365)))
      .addSubcommand((s) => s.setName('optout').setDescription('Stop being counted'))
      .addSubcommand((s) => s.setName('optin').setDescription('Be counted again'))
      .addSubcommand((s) => s.setName('forget').setDescription('Erase your numbers in this server')),
    execute: statsCmd,
  }, {
    permission: 'stats.manage',
    data: new SlashCommandBuilder().setName('counter').setDescription('Voice channels that show live numbers in their name (staff)')
      .addSubcommand((s) => s.setName('add').setDescription('Make a channel a counter')
        .addChannelOption((o) => o.setName('channel').setDescription('A voice channel (members see the name, nobody needs to join)').addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setRequired(true))
        .addStringOption((o) => o.setName('text').setDescription(`The name, with ${COUNTER_VARS}`).setRequired(true).setMaxLength(90)))
      .addSubcommand((s) => s.setName('remove').setDescription('Stop updating a counter').addChannelOption((o) => o.setName('channel').setDescription('Which one').setRequired(true)))
      .addSubcommand((s) => s.setName('list').setDescription('Every counter')),
    execute: counterCmd,
  }],
  events: { messageCreate: onMessage, messageReactionAdd: onReaction, voiceStateUpdate: onVoice, guildMemberAdd: onJoin, guildMemberRemove: onLeave },
  tasks: [
    { name: 'flush', everyMs: 10000, run: (ctx) => flush(ctx) },
    { name: 'recap', everyMs: 600000, run: weeklyRecap },
    { name: 'review', everyMs: 600000, run: monthlyReview },
    { name: 'counters', everyMs: 600000, run: (ctx) => refreshCounters(ctx) },
    { name: 'miss-you', everyMs: 3600000, run: (ctx) => missYouWarning(ctx) },
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
  ` }, { id: 2, sql: `
    CREATE TABLE IF NOT EXISTS stats_hour (guild_id TEXT NOT NULL, hour INTEGER NOT NULL, messages INTEGER NOT NULL DEFAULT 0, messages_bf INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, hour));
  ` }],
  views,
  actions: {
    async 'inactive-kick'(ctx, body, actor) { return kickInactive(ctx, [String(body.userId)], actor?.username ?? actor?.userId); },
    async 'inactive-kick-all'(ctx, body, actor) {
      if (body.confirm !== 'KICK') throw new UserError('Type KICK to confirm.');
      const res = await inactiveMembers(ctx);
      return kickInactive(ctx, res.list.filter((r) => r.kickable).map((r) => r.id), actor?.username ?? actor?.userId);
    },
  },
  components: [{ prefix: 'st:i', execute: inactiveClick }],
  panels: [
    { id: 'inactive', title: 'Inactive members', view: 'inactive', permission: 'stats.prune',
      description: 'Your monthly clean-up list: members with no messages, voice or reactions for the set number of days.', empty: 'Everyone has been active. Nothing to clean up.',
      columns: [{ key: 'member', label: 'Member' }, { key: 'last', label: 'Last active' }, { key: 'total', label: 'Messages (all time)' }, { key: 'joined', label: 'Joined' }, { key: 'kick', label: '' }],
      rowActions: [{ action: 'inactive-kick', label: 'Kick', confirm: 'Kick this member for inactivity? They can rejoin with an invite.', danger: true, done: 'Kicked' }],
      globalActions: [{ action: 'inactive-kick-all', label: 'Kick everyone listed', confirmWord: 'KICK', confirm: 'Kick every member on this list? Each one is checked again first, and they can rejoin with an invite.' }] },
    { id: 'charts', title: 'Activity charts', view: 'charts', permission: 'stats.manage', columns: [], description: 'Live and backfilled messages together.' },
    { id: 'members', title: 'Active members', view: 'members', permission: 'stats.manage', columns: [{ key: 'member', label: 'Member' }, { key: 'last', label: 'Last active' }, { key: 'recent', label: 'Messages (30 days)' }, { key: 'voice', label: 'Voice hours (30 days)' }, { key: 'total', label: 'Messages (all time)' }, { key: 'here', label: 'Still here' }] },
    { id: 'overview', title: 'Activity (7 days)', view: 'overview', permission: 'stats.manage', columns: [{ key: 'member', label: 'Member' }, { key: 'messages', label: 'Messages' }, { key: 'voice', label: 'Voice hours' }] },
  ],
  async init(ctx) {
    out(ctx.guildId).clear();
    for (const r of ctx.sql.all('SELECT user_id FROM stats_optout WHERE guild_id = ?', ctx.guildId)) out(ctx.guildId).add(r.user_id);
    if (!ctx.data.get('coverage')) ctx.data.set('coverage', { trackingSince: Date.now() });
    // A count that was interrupted by a restart starts again (a hot reload keeps the running one).
    const pending = ctx.data.get('backfillJob');
    if (pending && !jobs.has(ctx.guildId)) startBackfill(ctx, { ...pending, resumed: true });
    const t = tracker(ctx.guildId);
    for (const [id, st] of ctx.guild?.voiceStates?.cache ?? []) if (st.channelId && st.channelId !== ctx.guild.afkChannelId && !st.member?.user?.bot) t.enter(id, Date.now());
  },
  async destroy(ctx) { closeVoice(ctx); flush(ctx); voice.delete(ctx.guildId); },
};
