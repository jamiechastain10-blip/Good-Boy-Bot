/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Achievements and badges.
 *   Built-in achievements are earned from activity (messages, voice time, reactions, days active, streaks, time in the server).
 *   Staff can create server-specific achievements and grant or revoke them: /achievements custom create|delete|grant|revoke
 *   /achievements [member] | list | privacy | optout | optin
 * Counting is rate-limited (one message every 20 seconds counts) so spamming cannot farm progress. Members can opt out
 * or hide their achievements. Announcements respect the "Achievement announcements" notification choice.
 * Other modules (Eclipse ID) read a member's summary through this module's `api`.
 */
import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { UserError, truncate, ts } from '../../src/util.js';
import { dayKey, advanceStreak, Throttle, VoiceTracker } from '../../src/activity.js';
import { BUILTIN, CUSTOM_ID, slugify, reached, nextUp, progressLine } from '../../src/achievements.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const MAX_CUSTOM = 25;
const throttles = new Map(); const voice = new Map();
const thr = (g) => { let t = throttles.get(g); if (!t) throttles.set(g, t = new Throttle()); return t; };
const vt = (g) => { let t = voice.get(g); if (!t) voice.set(g, t = new VoiceTracker()); return t; };
const need = (ctx, i, key) => { if (!ctx.perms.check(i.member, key)) throw new UserError(`You don't have permission for that (\`${key}\`).`); };
const tzOf = (ctx) => ctx.config.get('timezoneOffset');

const optedOut = (ctx, userId) => !!ctx.sql.get('SELECT 1 AS x FROM achievements_optout WHERE guild_id = ? AND user_id = ?', ctx.guildId, userId);
const row = (ctx, userId) => ctx.sql.get('SELECT * FROM achievements_progress WHERE guild_id = ? AND user_id = ?', ctx.guildId, userId)
  ?? { messages: 0, voice_seconds: 0, reactions: 0, active_days: 0, streak: 0, best_streak: 0, last_day: null };
const customs = (ctx) => ctx.sql.all('SELECT * FROM achievements_custom WHERE guild_id = ? ORDER BY created_at', ctx.guildId).map((c) => ({ id: c.id, name: c.name, description: c.description, emoji: c.emoji, kind: 'custom' }));
const unlocked = (ctx, userId) => ctx.sql.all('SELECT achievement, at, source FROM achievements_unlock WHERE guild_id = ? AND user_id = ? ORDER BY at', ctx.guildId, userId);
const catalog = (ctx) => [...BUILTIN, ...customs(ctx)];
const memberDays = (member) => (member?.joinedTimestamp ? Math.floor((Date.now() - member.joinedTimestamp) / 86400000) : 0);

// ------------------------------------------------------------------ earning
async function announce(ctx, member, def) {
  const mode = ctx.config.get('announce');
  if (mode === 'off' || !ctx.notify.allowed(member.id, 'achievements')) return;
  const what = `${def.emoji} **${def.name}** — ${def.description}`;
  if (mode === 'channel' || mode === 'both') {
    const ch = ctx.guild.channels.cache.get(ctx.config.get('announceChannel'));
    if (ch?.isTextBased()) await ctx.queue(() => ch.send({ content: `🏆 <@${member.id}> unlocked ${what}`, allowedMentions: { users: [member.id] } })).catch(() => {});
  }
  if ((mode === 'dm' || mode === 'both') && ctx.notify.allowed(member.id, 'dms')) await member.user?.send({ content: truncate(`🏆 You unlocked ${what} (in ${ctx.guild.name})`, 1900), allowedMentions: NOPING }).catch(() => {});
}

/** Insert the unlock; true only the first time. */
export function unlock(ctx, userId, id, source = 'auto') {
  return ctx.sql.run('INSERT OR IGNORE INTO achievements_unlock (guild_id, user_id, achievement, at, source) VALUES (?, ?, ?, ?, ?)', ctx.guildId, userId, id, Date.now(), source).changes > 0;
}

export async function award(ctx, member, progress) {
  const have = new Set(unlocked(ctx, member.id).map((u) => u.achievement));
  const defs = catalog(ctx);
  for (const id of reached(progress, { memberDays: memberDays(member) }, BUILTIN)) {
    if (have.has(id)) continue;
    if (unlock(ctx, member.id, id)) await announce(ctx, member, defs.find((d) => d.id === id));
  }
}

/** Add to a member's counters, move the streak, and award anything newly earned. */
export async function record(ctx, member, { messages = 0, voice_seconds = 0, reactions = 0 }) {
  if (!member || member.user?.bot || optedOut(ctx, member.id)) return;
  const p = row(ctx, member.id);
  const today = dayKey(Date.now(), tzOf(ctx));
  const s = advanceStreak({ last: p.last_day, streak: p.streak, best: p.best_streak }, today);
  const next = {
    messages: p.messages + messages, voice_seconds: p.voice_seconds + voice_seconds, reactions: p.reactions + reactions,
    active_days: p.active_days + (s.newDay && (messages || reactions || voice_seconds) ? 1 : 0), streak: s.streak, best_streak: s.best, last_day: s.last,
  };
  ctx.sql.run(`INSERT INTO achievements_progress (guild_id, user_id, messages, voice_seconds, reactions, active_days, streak, best_streak, last_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET messages = excluded.messages, voice_seconds = excluded.voice_seconds, reactions = excluded.reactions, active_days = excluded.active_days,
      streak = excluded.streak, best_streak = excluded.best_streak, last_day = excluded.last_day`,
  ctx.guildId, member.id, next.messages, next.voice_seconds, next.reactions, next.active_days, next.streak, next.best_streak, next.last_day);
  await award(ctx, member, next);
}

const memberOf = (ctx, id, hint) => hint ?? ctx.guild.members.cache.get(id);

async function onMessage(ctx, m) {
  if (!m.guildId || m.author?.bot || m.webhookId) return;
  if (!thr(ctx.guildId).allow(`m:${m.author.id}`, Date.now(), 20000)) return;
  await record(ctx, memberOf(ctx, m.author.id, m.member), { messages: 1 });
}
async function onReaction(ctx, reaction, user) {
  if (user?.bot || !thr(ctx.guildId).allow(`r:${user.id}`, Date.now(), 5000)) return;
  await record(ctx, memberOf(ctx, user.id), { reactions: 1 });
}
async function onVoice(ctx, oldS, newS) {
  const member = newS.member ?? oldS.member;
  if (!member || member.user?.bot) return;
  const afk = ctx.guild?.afkChannelId;
  const was = oldS.channelId && oldS.channelId !== afk; const now = newS.channelId && newS.channelId !== afk;
  const t = vt(ctx.guildId);
  if (was && !now) { const s = t.leave(member.id, Date.now()); if (s) await record(ctx, member, { voice_seconds: s }); }
  else if (!was && now) t.enter(member.id, Date.now());
}

// ------------------------------------------------------------------ commands
const visibility = (ctx, userId) => ctx.sql.get('SELECT visibility FROM achievements_privacy WHERE guild_id = ? AND user_id = ?', ctx.guildId, userId)?.visibility ?? 'public';

export function summary(ctx, userId) {
  if (optedOut(ctx, userId) || visibility(ctx, userId) === 'private') return { visible: false };
  const defs = new Map(catalog(ctx).map((d) => [d.id, d]));
  const got = unlocked(ctx, userId).filter((u) => defs.has(u.achievement));
  return { visible: true, count: got.length, total: defs.size, recent: got.slice(-3).reverse().map((u) => ({ name: defs.get(u.achievement).name, emoji: defs.get(u.achievement).emoji, at: u.at })) };
}

async function achCmd(ctx, i) {
  const group = i.options.getSubcommandGroup?.();
  const sub = i.options.getSubcommand();
  const reply = (p) => i.reply({ ...(typeof p === 'string' ? { content: p } : p), flags: EPH, allowedMentions: NOPING });

  if (group === 'custom') {
    need(ctx, i, 'achievements.manage');
    if (sub === 'create') {
      if (customs(ctx).length >= MAX_CUSTOM) throw new UserError(`A server can have ${MAX_CUSTOM} custom achievements. Delete one first.`);
      const name = String(i.options.getString('name', true)).replace(/[\r\n]+/g, ' ').trim().slice(0, 40);
      const id = slugify(name);
      if (!CUSTOM_ID.test(id)) throw new UserError('Give it a name with at least two letters or numbers.');
      if (catalog(ctx).some((d) => d.id === id)) throw new UserError('An achievement with that name already exists.');
      const description = String(i.options.getString('description', true)).replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
      const emoji = String(i.options.getString('emoji') ?? '🏅').trim().slice(0, 16) || '🏅';
      ctx.sql.run('INSERT INTO achievements_custom (guild_id, id, name, description, emoji, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ctx.guildId, id, name, description, emoji, i.user.id, Date.now());
      return reply(`Created ${emoji} **${name}** (id \`${id}\`). Give it with \`/achievements custom grant\`.`);
    }
    const id = String(i.options.getString('id', true)).toLowerCase();
    const c = customs(ctx).find((x) => x.id === id);
    if (!c) throw new UserError('No custom achievement with that id. Built-in ones are earned automatically and cannot be granted by hand.');
    if (sub === 'delete') {
      ctx.sql.run('DELETE FROM achievements_custom WHERE guild_id = ? AND id = ?', ctx.guildId, id);
      ctx.sql.run('DELETE FROM achievements_unlock WHERE guild_id = ? AND achievement = ?', ctx.guildId, id);
      return reply(`Deleted **${c.name}** and removed it from everyone who had it.`);
    }
    const user = i.options.getUser('member', true);
    if (user.bot) throw new UserError('Pick a person.');
    if (sub === 'grant') {
      if (!unlock(ctx, user.id, id, `granted by ${i.user.id}`)) throw new UserError('They already have it.');
      const m = ctx.guild.members.cache.get(user.id);
      if (m) await announce(ctx, m, c);
      return reply(`Gave ${c.emoji} **${c.name}** to <@${user.id}>.`);
    }
    if (sub === 'revoke') {
      const r = ctx.sql.run('DELETE FROM achievements_unlock WHERE guild_id = ? AND user_id = ? AND achievement = ?', ctx.guildId, user.id, id);
      if (!r.changes) throw new UserError('They do not have it.');
      return reply(`Took ${c.emoji} **${c.name}** from <@${user.id}>.`);
    }
  }

  if (sub === 'optout') { ctx.sql.run('INSERT OR IGNORE INTO achievements_optout (guild_id, user_id) VALUES (?, ?)', ctx.guildId, i.user.id); return reply('Your activity no longer counts toward achievements here, and your achievements are hidden. Earned ones are kept. `/achievements optin` turns it back on.'); }
  if (sub === 'optin') { ctx.sql.run('DELETE FROM achievements_optout WHERE guild_id = ? AND user_id = ?', ctx.guildId, i.user.id); return reply('Your activity counts toward achievements again.'); }
  if (sub === 'privacy') {
    const v = i.options.getString('who', true);
    ctx.sql.run('INSERT INTO achievements_privacy (guild_id, user_id, visibility) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET visibility = excluded.visibility', ctx.guildId, i.user.id, v === 'private' ? 'private' : 'public');
    return reply(v === 'private' ? 'Only you can see your achievements now.' : 'Everyone in the server can see your achievements.');
  }
  if (sub === 'list') {
    const lines = catalog(ctx).map((d) => `${d.emoji} **${d.name}** · ${d.kind === 'custom' ? `${d.description} *(server)*` : d.description}`);
    return reply({ embeds: [new EmbedBuilder().setTitle('🏆 Achievements').setColor(0xfbbf24).setDescription(truncate(lines.join('\n'), 3900))] });
  }

  // show
  const user = i.options.getUser('member') ?? i.user;
  const self = user.id === i.user.id;
  if (!self) {
    if (optedOut(ctx, user.id)) return reply('That member opted out of achievements.');
    if (visibility(ctx, user.id) === 'private') return reply('That member keeps their achievements private.');
  }
  const p = row(ctx, user.id);
  const m = ctx.guild.members.cache.get(user.id);
  const extras = { memberDays: memberDays(m) };
  const got = unlocked(ctx, user.id);
  const defs = new Map(catalog(ctx).map((d) => [d.id, d]));
  const earned = got.filter((u) => defs.has(u.achievement)).map((u) => `${defs.get(u.achievement).emoji} **${defs.get(u.achievement).name}** ${ts(u.at, 'd')}`);
  const e = new EmbedBuilder().setTitle(`🏆 ${m?.displayName ?? user.username ?? user.id} · ${earned.length}/${defs.size}`).setColor(0xfbbf24)
    .addFields(
      { name: 'Earned', value: truncate(earned.join('\n') || '*none yet*', 1000) },
      { name: 'Next up', value: truncate(nextUp(p, extras, got.map((u) => u.achievement)).map(progressLine).join('\n') || '*you have them all*', 1000) },
    );
  if (self && optedOut(ctx, user.id)) e.setFooter({ text: 'You opted out: progress is not being counted.' });
  return reply({ embeds: [e] });
}

export default {
  name: 'achievements',
  version: '1.0.0',
  description: 'Built-in achievements earned from activity, plus server-specific ones staff create and grant. Opt-out and privacy included.',
  settings: [
    { key: 'announce', type: 'select', label: 'How unlocks are announced', options: ['channel', 'dm', 'both', 'off'], default: 'channel' },
    { key: 'announceChannel', type: 'channel', label: 'Channel for unlock announcements' },
    { key: 'timezoneOffset', type: 'number', label: 'Server timezone offset from UTC, in hours (decides when a day starts for streaks)', default: 0, min: -12, max: 14 },
  ],
  permissions: [
    { key: 'achievements.use', label: 'See achievements', default: 'everyone' },
    { key: 'achievements.manage', label: 'Create, grant and revoke server achievements', default: 'admin' },
  ],
  commands: [{
    permission: 'achievements.use',
    data: new SlashCommandBuilder().setName('achievements').setDescription('Achievements and badges')
      .addSubcommand((s) => s.setName('show').setDescription('Your achievements (or someone else\'s)').addUserOption((o) => o.setName('member').setDescription('Whose')))
      .addSubcommand((s) => s.setName('list').setDescription('Every achievement and how to earn it'))
      .addSubcommand((s) => s.setName('privacy').setDescription('Who can see your achievements').addStringOption((o) => o.setName('who').setDescription('Who').setRequired(true).addChoices({ name: 'everyone in the server', value: 'public' }, { name: 'only me', value: 'private' })))
      .addSubcommand((s) => s.setName('optout').setDescription('Stop counting my activity'))
      .addSubcommand((s) => s.setName('optin').setDescription('Count my activity again'))
      .addSubcommandGroup((g) => g.setName('custom').setDescription('Server-specific achievements (staff)')
        .addSubcommand((s) => s.setName('create').setDescription('Make a new achievement')
          .addStringOption((o) => o.setName('name').setDescription('Name').setRequired(true).setMaxLength(40))
          .addStringOption((o) => o.setName('description').setDescription('What it is for').setRequired(true).setMaxLength(120))
          .addStringOption((o) => o.setName('emoji').setDescription('An emoji for it')))
        .addSubcommand((s) => s.setName('delete').setDescription('Delete one').addStringOption((o) => o.setName('id').setDescription('Its id').setRequired(true)))
        .addSubcommand((s) => s.setName('grant').setDescription('Give one to a member').addStringOption((o) => o.setName('id').setDescription('Its id').setRequired(true)).addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true)))
        .addSubcommand((s) => s.setName('revoke').setDescription('Take one back').addStringOption((o) => o.setName('id').setDescription('Its id').setRequired(true)).addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true)))),
    execute: achCmd,
  }],
  events: { messageCreate: onMessage, messageReactionAdd: onReaction, voiceStateUpdate: onVoice },
  tasks: [{ name: 'tidy', everyMs: 600000, run: (ctx) => thr(ctx.guildId).prune(Date.now()) }],
  api: { summary },
  migrations: [{ id: 1, sql: `
    CREATE TABLE IF NOT EXISTS achievements_progress (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, messages INTEGER NOT NULL DEFAULT 0, voice_seconds INTEGER NOT NULL DEFAULT 0,
      reactions INTEGER NOT NULL DEFAULT 0, active_days INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0, best_streak INTEGER NOT NULL DEFAULT 0, last_day TEXT,
      PRIMARY KEY (guild_id, user_id));
    CREATE TABLE IF NOT EXISTS achievements_unlock (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, achievement TEXT NOT NULL, at INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'auto',
      PRIMARY KEY (guild_id, user_id, achievement));
    CREATE TABLE IF NOT EXISTS achievements_custom (guild_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, emoji TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, id));
    CREATE TABLE IF NOT EXISTS achievements_optout (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (guild_id, user_id));
    CREATE TABLE IF NOT EXISTS achievements_privacy (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'public', PRIMARY KEY (guild_id, user_id));
  ` }],
  async init(ctx) { const t = vt(ctx.guildId); for (const [id, st] of ctx.guild?.voiceStates?.cache ?? []) if (st.channelId && st.channelId !== ctx.guild.afkChannelId && !st.member?.user?.bot) t.enter(id, Date.now()); },
  async destroy(ctx) { voice.delete(ctx.guildId); throttles.delete(ctx.guildId); },
};
