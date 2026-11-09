/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * XP & leveling with role rewards, reputation (positive AND negative, with admin tools and an audit trail),
 * leaderboards, server statistics.
 * XP only needs message events (not message content). A member's XP record is deleted when they leave.
 * Voice XP (2.3.3): once a minute, members talking with at least one other person earn XP.
 * XP balance (2.3.3 defaults), per minute of someone actively taking part:
 *   chatting  15-25 XP for the first message each minute (about 20)
 *   voice     12 XP a minute with others, up to 5 hours a day (members spend far longer in voice than typing)
 *   reactions 2 XP, at most once a minute (a small bonus, not a way to level)
 */
import crypto from 'node:crypto';
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits as P, MessageFlags, ChannelType } from 'discord.js';
import { UserError, fillTemplate, progressBar, truncate, ts, SNOWFLAKE } from '../../src/util.js';
import { formModal, readForm } from '../../src/modalkit.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const DANGEROUS = [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.BanMembers, P.KickMembers, P.ManageWebhooks, P.ModerateMembers, P.MentionEveryone];
const fresh = () => ({ xp: 0, messages: 0, rep: 0, lastXp: 0, lastRep: 0 });

// xp needed to go from `level` to `level + 1`
const need = (level) => 5 * level * level + 50 * level + 100;
export function levelOf(totalXp) {
  let level = 0, rem = totalXp;
  while (level < 1000 && rem >= need(level)) { rem -= need(level); level++; }
  return { level, into: rem, needed: need(level) };
}
const userKey = (id) => `user:${id}`;
const rec = (ctx, id) => ({ ...fresh(), ...(ctx.data.get(userKey(id)) ?? {}) });

// ------------------------------------------------------------------ where XP counts
/**
 * No XP (and no level-up messages) in channels the server switched off, in channels inside a switched-off category,
 * and never in support tickets (2.3.3: level-ups were being posted into tickets).
 */
export function xpAllowed(ctx, channel) {
  if (!channel) return true;
  const off = new Set(ctx.config.get('noXpChannels') ?? []);
  const parentOf = (c) => c?.parentId ?? c?.parent?.id ?? null;
  // threads count as their parent channel
  const base = channel.isThread?.() ? (ctx.guild?.channels?.cache?.get(channel.parentId) ?? channel) : channel;
  if (off.has(channel.id) || off.has(base.id) || off.has(parentOf(base))) return false;
  if (ctx.api?.('support')?.isTicket?.(ctx.guildId, base.id)) return false;
  return true;
}

// ------------------------------------------------------------------ XP boosts (3.1)
/**
 * Boosts multiply XP: the best role boost a member has, times the boost of the channel (or its category, or a thread's
 * channel). Stored as [{ kind: 'role'|'channel', id, mult }]. Exported for tests.
 */
export function xpBoost(boosts, { roleIds = [], channelIds = [] } = {}) {
  const list = Array.isArray(boosts) ? boosts : [];
  const roles = list.filter((b) => b.kind === 'role' && roleIds.includes(b.id)).map((b) => b.mult);
  const r = roles.length ? Math.max(...roles) : 1;
  // The most specific place wins: a channel's own boost, else its category's.
  const c = channelIds.map((id) => list.find((b) => b.kind === 'channel' && b.id === id)?.mult).find((m) => m != null) ?? 1;
  return Math.round(r * c * 100) / 100;
}
/** The ids that count as "where": the channel, a thread's channel, and the category. Most specific first. */
function placeIds(ctx, channel) {
  if (!channel) return [];
  const base = channel.isThread?.() ? (ctx.guild?.channels?.cache?.get(channel.parentId) ?? channel) : channel;
  return [...new Set([channel.id, base.id, base.parentId ?? base.parent?.id].filter(Boolean))];
}
const memberRoles = (m) => [...(m?.roles?.cache?.keys?.() ?? [])];
const boostFor = (ctx, member, channel) => xpBoost(ctx.data.get('xpBoosts'), { roleIds: memberRoles(member), channelIds: placeIds(ctx, channel) });
const boosted = (n, mult) => Math.max(0, Math.round(n * mult));

// ------------------------------------------------------------------ XP from messages
async function onMessage(ctx, message) {
  if (!message.guild || message.author.bot || message.system || !message.member) return;
  if (!xpAllowed(ctx, message.channel)) return;
  const cooldown = ctx.config.get('xpCooldownSeconds') * 1000;
  const lo = ctx.config.get('xpMin'), hi = Math.max(lo, ctx.config.get('xpMax'));
  const gained = boosted(lo + Math.floor(Math.random() * (hi - lo + 1)), boostFor(ctx, message.member, message.channel));
  let before = null, after = null, counted = false;

  ctx.data.update(userKey(message.author.id), (r) => {
    const cur = { ...fresh(), ...r };
    cur.messages++;
    if (Date.now() - cur.lastXp < cooldown) return cur;
    before = levelOf(cur.xp).level;
    cur.xp += gained; cur.lastXp = Date.now();
    after = levelOf(cur.xp).level;
    counted = true;
    return cur;
  }, fresh());

  if (counted) ctx.live?.('data', { panel: 'levels' });
  if (counted && after > before) {
    ctx.live?.('activity', { icon: '⭐', text: `${message.member?.displayName ?? message.author.username} reached level ${after}` });
    await levelUp(ctx, message.member, message.channel, before, after);
  }
}

// ------------------------------------------------------------------ XP from reactions (2.3.3)
/**
 * Reacting to someone else's message gives a little XP, at most once per cooldown. Reacting to your own message, bots
 * and switched-off channels (and tickets) give nothing. Removing and re-adding a reaction doesn't help: the cooldown
 * counts from the last XP given.
 */
async function onReaction(ctx, reaction, user, now = Date.now()) {
  if (!ctx.config.get('reactionXp') || !user || user.bot) return;
  const msg = reaction?.message;
  if (!msg?.guildId) return;
  if (msg.author?.id && msg.author.id === user.id) return; // your own message
  if (!xpAllowed(ctx, msg.channel ?? ctx.guild?.channels?.cache?.get(msg.channelId))) return;
  const reactMember = ctx.guild?.members?.cache?.get(user.id);
  const amount = boosted(Number(ctx.config.get('reactionXpAmount')) || 0, boostFor(ctx, reactMember, msg.channel ?? ctx.guild?.channels?.cache?.get(msg.channelId)));
  const cooldown = (Number(ctx.config.get('reactionXpCooldownSeconds')) || 60) * 1000;
  if (amount <= 0) return;
  let before = null, after = null;
  ctx.data.update(userKey(user.id), (r) => {
    const cur = { ...fresh(), ...r };
    if (now - (cur.lastReactXp ?? 0) < cooldown) return cur;
    before = levelOf(cur.xp).level;
    cur.xp += amount; cur.lastReactXp = now; cur.reactions = (cur.reactions ?? 0) + 1;
    after = levelOf(cur.xp).level;
    return cur;
  }, fresh());
  if (before === null) return;
  ctx.live?.('data', { panel: 'levels' });
  if (after > before) {
    const member = ctx.guild?.members?.cache?.get(user.id) ?? await ctx.guild?.members?.fetch(user.id).catch(() => null);
    if (!member) return;
    ctx.live?.('activity', { icon: '⭐', text: `${member.displayName ?? user.username} reached level ${after}` });
    await levelUp(ctx, member, msg.channel, before, after);
  }
}

/** Announces a level-up (in the level-up channel, else `here`) and hands out level roles. */
async function levelUp(ctx, member, here, from, to) {
  if (ctx.config.get('levelUpEnabled')) {
    const target = ctx.guild.channels.cache.get(ctx.config.get('levelUpChannel')) ?? here;
    if (target?.isTextBased?.()) {
      const text = fillTemplate(ctx.config.get('levelUpMessage'), { user: `<@${member.id}>`, username: member.user?.username ?? member.displayName, level: to });
      await ctx.queue(() => target.send({ content: truncate(text, 1900), allowedMentions: { users: [member.id] } })).catch(() => {});
    }
  }
  await applyRewards(ctx, member, to);
}

// ------------------------------------------------------------------ XP from voice
const today = (now) => new Date(now).toISOString().slice(0, 10);
const deafened = (vs) => !!(vs.selfDeaf || vs.serverDeaf);
const muted = (vs) => !!(vs.selfMute || vs.serverMute);

/**
 * Who earns voice XP right now: members in a voice channel (not the AFK one) with at least one other person who is
 * not a bot and not deafened. Deafened members never earn; muted members only if the server allows it.
 */
export function voiceEarners(guild, { countMuted = false, skip = null } = {}) {
  const rooms = new Map();
  for (const vs of guild?.voiceStates?.cache?.values?.() ?? []) {
    if (!vs.channelId || vs.channelId === guild.afkChannelId || !vs.member || vs.member.user?.bot) continue;
    if (skip?.has(vs.channelId) || skip?.has(vs.channel?.parentId)) continue;
    if (deafened(vs)) continue;
    if (!rooms.has(vs.channelId)) rooms.set(vs.channelId, []);
    rooms.get(vs.channelId).push(vs);
  }
  const out = [];
  for (const list of rooms.values()) {
    if (list.length < 2) continue; // alone (or only with bots / deafened people)
    for (const vs of list) if (countMuted || !muted(vs)) out.push(vs);
  }
  return out;
}

/** One minute of voice XP. Returns how many members earned. */
export { onReaction as reactionXp };
export async function voiceTick(ctx, now = Date.now()) {
  if (!ctx.config.get('voiceXp') || !ctx.guild) return 0;
  const per = Number(ctx.config.get('voiceXpPerMinute')) || 0;
  const cap = Number(ctx.config.get('voiceXpDailyMinutes')) || 0;
  if (per <= 0) return 0;
  let earned = 0;
  for (const vs of voiceEarners(ctx.guild, { countMuted: !!ctx.config.get('voiceXpCountMuted'), skip: new Set(ctx.config.get('noXpChannels') ?? []) })) {
    let before = null, after = null;
    ctx.data.update(userKey(vs.id), (r) => {
      const cur = { ...fresh(), ...r };
      const day = today(now);
      if (cur.voiceDay !== day) { cur.voiceDay = day; cur.voiceToday = 0; }
      if (cap > 0 && cur.voiceToday >= cap) return cur; // reached today's limit
      before = levelOf(cur.xp).level;
      cur.xp += boosted(per, boostFor(ctx, vs.member, vs.channel ?? ctx.guild?.channels?.cache?.get(vs.channelId))); cur.voiceToday += 1; cur.voiceMinutes = (cur.voiceMinutes ?? 0) + 1;
      after = levelOf(cur.xp).level;
      return cur;
    }, fresh());
    if (before === null) continue;
    earned++;
    if (after > before) {
      ctx.live?.('activity', { icon: '⭐', text: `${vs.member.displayName ?? vs.member.user?.username} reached level ${after}` });
      await levelUp(ctx, vs.member, vs.channel, before, after);
    }
  }
  if (earned) ctx.live?.('data', { panel: 'levels' });
  return earned;
}

async function applyRewards(ctx, member, level) {
  const guild = member.guild;
  const rewards = ctx.data.list('reward:').map(({ key, value }) => ({ level: Number(key.slice(7)), roleId: value })).sort((a, b) => a.level - b.level);
  const earned = rewards.filter((r) => r.level <= level);
  const stack = ctx.config.get('stackRewards');
  const keep = stack ? earned : earned.slice(-1);
  const drop = stack ? [] : rewards.filter((r) => !keep.includes(r));
  const me = guild.members.me;
  const ok = (id) => { const r = guild.roles.cache.get(id); return r && !r.managed && me && r.position < me.roles.highest.position ? r : null; };
  for (const r of keep) { const role = ok(r.roleId); if (role && !member.roles.cache.has(role.id)) await member.roles.add(role, `Level ${r.level} reward`).catch(() => {}); }
  for (const r of drop) { const role = ok(r.roleId); if (role && member.roles.cache.has(role.id)) await member.roles.remove(role, 'Replaced by a higher reward').catch(() => {}); }
}

// ------------------------------------------------------------------ views
function ranking(ctx, field) {
  return ctx.data.list('user:').map(({ key, value }) => ({ id: key.slice(5), ...fresh(), ...value }))
    .sort((a, b) => (b[field] - a[field]) || (b.xp - a.xp));
}

async function rankCmd(ctx, i) {
  const user = i.options.getUser('user') ?? i.user;
  if (user.bot) throw new UserError('Bots don\'t earn XP.');
  const r = rec(ctx, user.id);
  const { level, into, needed } = levelOf(r.xp);
  const pos = ranking(ctx, 'xp').findIndex((x) => x.id === user.id) + 1;
  // 3.1: a rank card picture when the canvas package is there (text below otherwise).
  if (ctx.config.get('rankCards') !== false) {
    const { rankCard } = await import('../../src/rankcard.js');
    const style = ctx.data.get(`card:${user.id}`) ?? {};
    const png = await rankCard({ name: i.guild?.members?.cache?.get(user.id)?.displayName ?? user.globalName ?? user.username, avatarUrl: user.displayAvatarURL?.({ extension: 'png', size: 256, forceStatic: true }), level, into, needed, rank: pos || null, xp: r.xp, messages: r.messages,
      accent: style.accent, accent2: style.accent2, theme: style.theme, background: ctx.config.get('cardBackgrounds') !== false ? style.background : null }).catch(() => null);
    if (png) return i.reply({ files: [{ attachment: png, name: 'rank.png' }], allowedMentions: NOPING,
      components: user.id === i.user.id ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`rankstyle:open:${i.user.id}`).setLabel('Customise').setEmoji('🎨').setStyle(ButtonStyle.Secondary))] : [] });
  }
  const e = new EmbedBuilder().setColor(0x5865f2).setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
    .setTitle(`Level ${level}`)
    .setDescription(`${progressBar(into, needed, 16)}\n${into} / ${needed} XP to level ${level + 1}`)
    .addFields({ name: 'Rank', value: pos ? `#${pos}` : '—', inline: true }, { name: 'Total XP', value: String(r.xp), inline: true }, { name: 'Messages', value: String(r.messages), inline: true }, { name: 'Reputation', value: String(r.rep), inline: true });
  await i.reply({ embeds: [e], allowedMentions: NOPING });
}

// 3.1: members style their own rank card.
async function rankStyle(ctx, i) {
  const [, step, owner] = i.customId.split(':');
  if (owner && owner !== i.user.id) throw new UserError('That is someone else\'s card. Run `/rank` for your own.');
  const { THEMES, okBackground, okHex } = await import('../../src/rankcard.js');
  const cur = ctx.data.get(`card:${i.user.id}`) ?? {};
  const fields = [
    { id: 'theme', kind: 'select', label: 'Theme', value: cur.theme ?? 'dark', options: Object.entries(THEMES).map(([value, t]) => ({ label: t.label, value })) },
    { id: 'accent', label: 'Main colour (hex, like #6b93ff)', required: false, max: 7, value: cur.accent ?? '' },
    { id: 'accent2', label: 'Second colour (hex, like #b07cff)', required: false, max: 7, value: cur.accent2 ?? '' },
    ...(ctx.config.get('cardBackgrounds') !== false ? [{ id: 'background', label: 'Background picture link (optional)', required: false, max: 400, value: cur.background ?? '', placeholder: 'Upload a picture in Discord, then Copy Link' }] : []),
  ];
  if (step === 'open') return i.showModal(formModal(`rankstyle:save:${i.user.id}`, 'Your rank card', fields));
  const v = readForm(i, fields);
  for (const k of ['accent', 'accent2']) if (v[k] && !okHex(v[k])) throw new UserError(`"${v[k]}" isn't a colour. Use a hex code like #6b93ff.`);
  if (v.background && !okBackground(v.background)) throw new UserError('The background has to be a picture uploaded to Discord (right-click it, Copy Link). Links from other sites are not allowed.');
  const next = { theme: v.theme || 'dark', accent: v.accent || null, accent2: v.accent2 || null, background: v.background || null };
  ctx.data.set(`card:${i.user.id}`, next);
  return i.reply({ content: '🎨 Saved! Run `/rank` to see your new card.', flags: MessageFlags.Ephemeral });
}

const BOARD_TITLES = { xp: 'XP', rep: 'Reputation', messages: 'Messages' };
/** One leaderboard page as an embed + the page count. Shared by /leaderboard and the live board. */
export function buildBoard(ctx, type, page = 1, size = 10) {
  const all = ranking(ctx, type).filter((x) => (type === 'rep' ? x.rep !== 0 : x[type] > 0));
  const pages = Math.max(1, Math.ceil(all.length / size));
  const medals = ['🥇', '🥈', '🥉'];
  const rows = all.slice((page - 1) * size, page * size).map((x, n) => {
    const idx = (page - 1) * size + n;
    const val = type === 'xp' ? `level ${levelOf(x.xp).level} · ${x.xp} XP` : type === 'rep' ? `${x.rep} rep` : `${x.messages} messages`;
    return `${medals[idx] ?? `**${idx + 1}.**`} <@${x.id}> - ${val}`;
  });
  const text = rows.join('\n') || 'Nobody yet - start chatting!';
  return { pages, text, title: `Leaderboard · ${BOARD_TITLES[type]}` };
}

async function leaderboardCmd(ctx, i) {
  const type = i.options.getString('type') ?? 'xp';
  const page = i.options.getInteger('page') ?? 1;
  const { pages, text, title } = buildBoard(ctx, type, page);
  if (page > pages) throw new UserError(`There ${pages === 1 ? 'is only 1 page' : `are only ${pages} pages`}.`);
  const e = new EmbedBuilder().setColor(0xfee75c).setTitle(title).setDescription(text).setFooter({ text: `Page ${page}/${pages}` });
  await i.reply({ embeds: [e], allowedMentions: NOPING });
}

// ------------------------------------------------------------------ live leaderboard
// One message that the bot keeps editing. Where it lives is remembered in `liveboard`, so a restart carries on with the same message.
const liveSize = (ctx) => Math.min(25, Math.max(3, Number(ctx.config.get('liveBoardSize')) || 10));
function liveEmbed(ctx) {
  const type = BOARD_TITLES[ctx.config.get('liveBoardType')] ? ctx.config.get('liveBoardType') : 'xp';
  const { text, title } = buildBoard(ctx, type, 1, liveSize(ctx));
  return { text, embed: new EmbedBuilder().setColor(0xfee75c).setTitle(`${title} · live`).setDescription(text).setFooter({ text: 'Updates automatically' }).setTimestamp() };
}

/** Post or refresh the live board. Returns 'off' | 'posted' | 'updated' | 'same' | 'no-channel'. Never throws on Discord errors it can recover from. */
export async function refreshLiveBoard(ctx, { force = false } = {}) {
  const saved = ctx.data.get('liveboard') ?? {};
  const chId = ctx.config.get('liveBoardChannel');
  if (!chId) {
    if (saved.messageId) { await dropLiveBoard(ctx, saved); ctx.data.delete('liveboard'); }
    return 'off';
  }
  const ch = ctx.guild.channels.cache.get(chId);
  if (!ch?.isTextBased?.() || !ch.send) return 'no-channel';
  const { text, embed } = liveEmbed(ctx);
  const fingerprint = `${chId}|${ctx.config.get('liveBoardType')}|${text}`;
  let msg = null;
  if (saved.messageId && saved.channelId === chId) msg = await ch.messages.fetch(saved.messageId).catch(() => null);
  if (saved.messageId && saved.channelId !== chId) await dropLiveBoard(ctx, saved);
  if (msg) {
    if (!force && saved.fingerprint === fingerprint) { ctx.data.set('liveboard', { ...saved, at: Date.now() }); return 'same'; }
    await ctx.queue(() => msg.edit({ embeds: [embed], allowedMentions: NOPING }));
    ctx.data.set('liveboard', { ...saved, fingerprint, at: Date.now() });
    return 'updated';
  }
  const sent = await ctx.queue(() => ch.send({ embeds: [embed], allowedMentions: NOPING }));
  ctx.data.set('liveboard', { channelId: chId, messageId: sent.id, fingerprint, at: Date.now() });
  return 'posted';
}
async function dropLiveBoard(ctx, saved) {
  const old = ctx.guild.channels.cache.get(saved.channelId);
  const m = old?.messages ? await old.messages.fetch(saved.messageId).catch(() => null) : null;
  if (m) await m.delete().catch(() => {});
}

async function liveBoardCmd(ctx, i) {
  if (!ctx.perms.check(i.member, 'community.manage')) throw new UserError('You need the `community.manage` permission for that.');
  const sub = i.options.getSubcommand();
  await i.deferReply({ flags: EPH });
  if (sub === 'setup') {
    const picked = i.options.getChannel('channel', true);
    const ch = i.guild.channels.cache.get(picked.id) ?? picked;
    if (!ch.isTextBased?.() || !ch.send) throw new UserError('Pick a text channel.');
    const me = i.guild.members.me;
    const need = [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory];
    if (ch.permissionsFor && me && !ch.permissionsFor(me)?.has(need)) throw new UserError(`I need View Channel, Send Messages, Embed Links and Read Message History in <#${ch.id}>.`);
    await ctx.settings.set('liveBoardChannel', ch.id);
    const type = i.options.getString('type');
    if (type) await ctx.settings.set('liveBoardType', type);
  }
  if (sub === 'remove') {
    await ctx.settings.set('liveBoardChannel', '');
  }
  const r = await refreshLiveBoard(ctx, { force: sub !== 'remove' });
  const note = { off: 'The live leaderboard is off.', posted: 'Posted the live leaderboard.', updated: 'Refreshed the live leaderboard.', same: 'It is already up to date.', 'no-channel': 'I can\'t see that channel any more - pick it again with `/liveboard setup`.' }[r];
  await i.editReply({ content: note, allowedMentions: NOPING });
}

// ------------------------------------------------------------------ reputation
// Scores live in the same per-member record as before (so existing points are untouched) and may be negative.
// Every change is written to community_rep_history, which is the audit trail for /rep history and the dashboard.
const REP_RESET_MS = 60000;
const needRep = (ctx, i) => { if (!ctx.perms.check(i.member, 'community.rep-admin')) throw new UserError('You need the `community.rep-admin` permission for that.'); };
const fmtRep = (n) => (n > 0 ? `+${n}` : String(n));

function logRep(ctx, { target, actor, delta, balance, kind, reason }) {
  ctx.sql.run('INSERT INTO community_rep_history (guild_id, target_id, actor_id, delta, balance_after, kind, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ctx.guildId, target, actor, delta, balance, kind, reason ? String(reason).slice(0, 300) : null, Date.now());
}
function changeRep(ctx, { target, actor, delta, kind, reason }) {
  const r = ctx.data.update(userKey(target), (x) => ({ ...fresh(), ...x, rep: (x?.rep ?? 0) + delta }), fresh());
  logRep(ctx, { target, actor, delta, balance: r.rep, kind, reason });
  return r.rep;
}
function setRepValue(ctx, { target, actor, value, kind, reason }) {
  let before = 0;
  ctx.data.update(userKey(target), (x) => { before = x?.rep ?? 0; return { ...fresh(), ...x, rep: value }; }, fresh());
  logRep(ctx, { target, actor, delta: value - before, balance: value, kind, reason });
  return { before, after: value };
}
async function repAudit(ctx, text) {
  const ch = ctx.guild?.channels.cache.get(ctx.config.get('repLogChannel'));
  if (ch?.isTextBased()) await ctx.queue(() => ch.send({ content: truncate(text, 1900), allowedMentions: NOPING })).catch(() => {});
}
function intIn(v, min, max, what) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${what} must be a whole number between ${min} and ${max}.`);
  return n;
}

async function repGive(ctx, i) {
  if (!ctx.config.get('repEnabled')) throw new UserError('Reputation is turned off in this server.');
  const target = i.options.getUser('user', true);
  const negative = i.options.getString('type') === 'negative';
  if (negative && !ctx.config.get('repAllowNegative')) throw new UserError('Negative reputation is turned off in this server.');
  if (target.bot) throw new UserError("Bots don't take part in reputation.");
  if (target.id === i.user.id) throw new UserError("You can't give reputation to yourself.");
  const member = await i.guild.members.fetch(target.id).catch(() => null);
  if (!member) throw new UserError('That user is not in this server.');

  const now = Date.now();
  const minDays = ctx.config.get('repMinMemberDays');
  if (minDays > 0 && i.member.joinedTimestamp && now - i.member.joinedTimestamp < minDays * 86400000) throw new UserError(`You need to have been in this server for ${minDays} day(s) before giving reputation.`);
  const cooldown = ctx.config.get('repCooldownHours') * 3600000;
  const mine = rec(ctx, i.user.id);
  if (now - mine.lastRep < cooldown) throw new UserError(`You can give reputation again ${ts(mine.lastRep + cooldown)}.`);
  const today = ctx.sql.get("SELECT COUNT(*) AS n FROM community_rep_history WHERE guild_id = ? AND actor_id = ? AND kind = 'give' AND created_at > ?", ctx.guildId, i.user.id, now - 86400000).n;
  if (today >= ctx.config.get('repDailyLimit')) throw new UserError(`You've reached today's limit of ${ctx.config.get('repDailyLimit')} reputation gifts.`);
  const pair = ctx.sql.get("SELECT MAX(created_at) AS t FROM community_rep_history WHERE guild_id = ? AND actor_id = ? AND target_id = ? AND kind = 'give'", ctx.guildId, i.user.id, target.id).t;
  const pairMs = ctx.config.get('repPairCooldownHours') * 3600000;
  if (pair && now - pair < pairMs) throw new UserError(`You already rated <@${target.id}> recently. You can rate them again ${ts(pair + pairMs)}.`);
  if (negative) {
    const negs = ctx.sql.get("SELECT COUNT(*) AS n FROM community_rep_history WHERE guild_id = ? AND target_id = ? AND kind = 'give' AND delta < 0 AND created_at > ?", ctx.guildId, target.id, now - 86400000).n;
    if (negs >= ctx.config.get('repNegativeDailyPerTarget')) {
      ctx.security(`Negative reputation limit hit for ${target.id} (possible brigading)`);
      await repAudit(ctx, `⚠️ Possible reputation brigading: <@${target.id}> has already received ${negs} negative votes in 24h. Further negatives are blocked.`);
      throw new UserError('That member has received a lot of negative reputation today, so more are paused. A moderator can look into it.');
    }
  }
  const reason = i.options.getString('reason');
  const balance = changeRep(ctx, { target: target.id, actor: i.user.id, delta: negative ? -1 : 1, kind: 'give', reason });
  ctx.data.update(userKey(i.user.id), (x) => ({ ...fresh(), ...x, lastRep: now }), fresh());
  await repAudit(ctx, `${negative ? '👎' : '⭐'} <@${i.user.id}> gave <@${target.id}> ${negative ? '-1' : '+1'}${reason ? `: ${truncate(reason, 200)}` : ''} (now ${fmtRep(balance)})`);
  await i.reply({ content: `${negative ? '👎' : '⭐'} <@${i.user.id}> gave <@${target.id}> **${negative ? '-1' : '+1'}** reputation${reason ? `: ${truncate(reason, 200)}` : ''} (now **${fmtRep(balance)}**).`, allowedMentions: { users: [target.id] } });
}

async function repCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  if (sub === 'give') return repGive(ctx, i);
  if (sub === 'check' || sub === 'view') {
    const u = i.options.getUser('user') ?? i.user;
    return i.reply({ content: `**${truncate(u.username, 40)}** has **${fmtRep(rec(ctx, u.id).rep)}** reputation.`, allowedMentions: NOPING });
  }
  if (sub === 'history') {
    const u = i.options.getUser('user') ?? i.user;
    if (u.id !== i.user.id) needRep(ctx, i);
    const rows = ctx.sql.all('SELECT actor_id, delta, balance_after, kind, reason, created_at FROM community_rep_history WHERE guild_id = ? AND target_id = ? ORDER BY id DESC LIMIT ?', ctx.guildId, u.id, i.options.getInteger('limit') ?? 10);
    const lines = rows.map((r) => `${ts(r.created_at)} **${r.kind}** ${fmtRep(r.delta)} → ${fmtRep(r.balance_after ?? 0)} by <@${r.actor_id}>${r.reason ? ` - ${truncate(r.reason, 80)}` : ''}`);
    return i.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`Reputation history · ${truncate(u.username, 40)}`).setDescription(lines.join('\n') || 'No reputation activity yet.')], flags: EPH, allowedMentions: NOPING });
  }
  needRep(ctx, i);
  if (sub === 'reset-all') {
    const affected = ctx.data.list('user:').filter((x) => (x.value.rep ?? 0) !== 0).length;
    const token = crypto.randomBytes(8).toString('hex');
    ctx.data.set(`repReset:${token}`, { by: i.user.id, exp: Date.now() + REP_RESET_MS });
    return i.reply({ content: `⚠️ This sets **${affected}** member(s)' reputation to **0** for the whole server. A database backup is taken first, but this can't be undone from Discord. Confirm within 60 seconds.`, flags: EPH, components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rep:resetall:${token}`).setLabel('Yes, reset everyone').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`rep:cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))] });
  }
  const target = i.options.getUser('user', true);
  if (target.bot) throw new UserError("Bots don't take part in reputation.");
  const reason = i.options.getString('reason');
  if (sub === 'remove') {
    const amount = i.options.getInteger('amount') ?? 1;
    const balance = changeRep(ctx, { target: target.id, actor: i.user.id, delta: -amount, kind: 'remove', reason });
    await repAudit(ctx, `🛠️ <@${i.user.id}> removed ${amount} reputation from <@${target.id}> (now ${fmtRep(balance)})${reason ? `: ${truncate(reason, 200)}` : ''}`);
    return i.reply({ content: `Removed **${amount}** from <@${target.id}>. They are now at **${fmtRep(balance)}**.`, flags: EPH, allowedMentions: NOPING });
  }
  if (sub === 'set') {
    const r = setRepValue(ctx, { target: target.id, actor: i.user.id, value: intIn(i.options.getInteger('value', true), -100000, 100000, 'The score'), kind: 'set', reason });
    await repAudit(ctx, `🛠️ <@${i.user.id}> set <@${target.id}> from ${fmtRep(r.before)} to ${fmtRep(r.after)}${reason ? `: ${truncate(reason, 200)}` : ''}`);
    return i.reply({ content: `<@${target.id}> went from **${fmtRep(r.before)}** to **${fmtRep(r.after)}**.`, flags: EPH, allowedMentions: NOPING });
  }
  // reset
  const r = setRepValue(ctx, { target: target.id, actor: i.user.id, value: 0, kind: 'reset', reason });
  await repAudit(ctx, `🛠️ <@${i.user.id}> reset <@${target.id}> (was ${fmtRep(r.before)})${reason ? `: ${truncate(reason, 200)}` : ''}`);
  return i.reply({ content: `Reset <@${target.id}> (was **${fmtRep(r.before)}**).`, flags: EPH, allowedMentions: NOPING });
}

async function repComponent(ctx, i) {
  const [, action, token] = i.customId.split(':');
  const pending = ctx.data.get(`repReset:${token}`);
  if (!pending || pending.by !== i.user.id || pending.exp < Date.now()) throw new UserError('That confirmation expired or belongs to someone else. Run `/rep reset-all` again.');
  ctx.data.delete(`repReset:${token}`);
  if (action === 'cancel') return i.update({ content: 'Cancelled. Nothing was changed.', components: [] });
  needRep(ctx, i);
  const result = resetEveryone(ctx, i.user.id);
  await repAudit(ctx, `🧹 <@${i.user.id}> reset ALL reputation (${result.affected} members).`);
  await i.update({ content: `✅ Reset **${result.affected}** member(s) to 0. Backup saved${result.backup ? ` (\`${result.backup.split(/[\\/]/).pop()}\`)` : ''}.`, components: [] });
}

/** Changes one member's XP through `fn(oldXp) -> newXp` and applies level rewards. Used by the dashboard. */
async function changeXp(ctx, userId, fn) {
  if (!SNOWFLAKE.test(String(userId))) throw new UserError('Pick a member.');
  let before = 0, after = 0;
  ctx.data.update(userKey(userId), (r) => { const cur = { ...fresh(), ...r }; before = cur.xp; after = Math.max(0, Math.round(fn(cur.xp))); return { ...cur, xp: after }; }, fresh());
  const member = await ctx.guild?.members.fetch(userId).catch(() => null);
  if (member) await applyRewards(ctx, member, levelOf(after).level);
  return { before, after, level: levelOf(after).level };
}

function resetEveryone(ctx, actor) {
  const backup = ctx.backup('before-rep-reset-all');
  let affected = 0;
  ctx.sql.transaction(() => {
    for (const { key, value } of ctx.data.list('user:')) {
      if ((value.rep ?? 0) === 0) continue;
      ctx.data.set(key, { ...value, rep: 0 });
      logRep(ctx, { target: key.slice(5), actor, delta: -value.rep, balance: 0, kind: 'reset_all', reason: 'server-wide reset' });
      affected++;
    }
  });
  return { affected, backup };
}

async function statsCmd(ctx, i) {
  const g = i.guild;
  const tracked = ctx.data.list('user:');
  const totalMessages = tracked.reduce((n, x) => n + (x.value.messages ?? 0), 0);
  const e = new EmbedBuilder().setColor(0x5865f2).setTitle(g.name).setThumbnail(g.iconURL())
    .addFields(
      { name: 'Members', value: String(g.memberCount), inline: true },
      { name: 'Channels', value: String(g.channels.cache.size), inline: true },
      { name: 'Roles', value: String(g.roles.cache.size), inline: true },
      { name: 'Boosts', value: `${g.premiumSubscriptionCount ?? 0} (tier ${g.premiumTier})`, inline: true },
      { name: 'Created', value: ts(g.createdTimestamp, 'D'), inline: true },
      { name: 'Messages tracked', value: String(totalMessages), inline: true },
      { name: 'Most active', value: ranking(ctx, 'messages').slice(0, 3).map((x, n) => `${n + 1}. <@${x.id}> (${x.messages})`).join('\n') || '—' },
    );
  await i.reply({ embeds: [e], allowedMentions: NOPING });
}

async function xpBoostCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  const list = [...(ctx.data.get('xpBoosts') ?? [])];
  const label = (b) => (b.kind === 'role' ? `<@&${b.id}>` : ctx.guild.channels.cache.get(b.id)?.type === ChannelType.GuildCategory ? `📁 ${ctx.guild.channels.cache.get(b.id).name}` : `<#${b.id}>`);
  if (sub === 'list') {
    return i.reply({ content: `**XP boosts**\n${list.map((b) => `${label(b)} · **×${b.mult}**`).join('\n') || 'None yet. Add one with `/xp boost add`.'}\n-# A member gets their best role boost, times the boost of the channel they're in.`, flags: EPH, allowedMentions: NOPING });
  }
  const role = i.options.getRole('role'), ch = i.options.getChannel('channel');
  if (!role === !ch) throw new UserError('Pick a role or a channel (one of them).');
  const kind = role ? 'role' : 'channel', id = (role ?? ch).id;
  const rest = list.filter((b) => !(b.kind === kind && b.id === id));
  if (sub === 'remove') {
    if (rest.length === list.length) throw new UserError('That has no boost.');
    ctx.data.set('xpBoosts', rest);
    return i.reply({ content: `Removed the boost for ${label({ kind, id })}.`, flags: EPH, allowedMentions: NOPING });
  }
  const mult = Math.round(Number(i.options.getNumber('multiplier', true)) * 100) / 100;
  if (!(mult >= 0.1 && mult <= 5)) throw new UserError('Use a multiplier from 0.1 to 5 (for example 1.5 for 50% more XP).');
  if (rest.length >= 25) throw new UserError('You can have up to 25 boosts.');
  ctx.data.set('xpBoosts', [...rest, { kind, id, mult }]);
  return i.reply({ content: `🚀 ${label({ kind, id })} now earns **×${mult}** XP.`, flags: EPH, allowedMentions: NOPING });
}

async function xpIgnoreCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  const list = [...(ctx.config.get('noXpChannels') ?? [])];
  if (sub === 'list') {
    const lines = list.map((id) => { const c = ctx.guild.channels.cache.get(id); return c ? (c.type === ChannelType.GuildCategory ? `📁 ${c.name} (whole category)` : `<#${id}>`) : `\`${id}\` (deleted)`; });
    return i.reply({ content: `**No XP in:**\n${lines.join('\n') || 'Nowhere yet.'}\n\nSupport tickets never give XP.`, flags: EPH, allowedMentions: NOPING });
  }
  const picked = i.options.getChannel('channel', true);
  const ch = ctx.guild.channels.cache.get(picked.id) ?? picked;
  const next = sub === 'add' ? [...new Set([...list, ch.id])] : list.filter((x) => x !== ch.id);
  ctx.settings.set('noXpChannels', next);
  const what = ch.type === ChannelType.GuildCategory ? `every channel in **${ch.name}**` : `<#${ch.id}>`;
  return i.reply({ content: sub === 'add' ? `🔕 No more XP or level-up messages in ${what}.` : `🔔 ${what} gives XP again.`, flags: EPH, allowedMentions: NOPING });
}

// ------------------------------------------------------------------ definition
export default {
  name: 'community',
  version: '1.3.0',
  description: 'XP & levels with role rewards, reputation (can go negative), leaderboards and server stats.',
  settings: [
    { key: 'rankCards', type: 'toggle', label: '/rank shows a picture card (text if pictures are off)', default: true },
    { key: 'cardBackgrounds', type: 'toggle', label: 'Members can put their own picture behind their rank card', default: true },
    { key: 'xpMin', type: 'number', label: 'XP per message (min)', default: 15, min: 1, max: 500 },
    { key: 'xpMax', type: 'number', label: 'XP per message (max)', default: 25, min: 1, max: 500 },
    { key: 'xpCooldownSeconds', type: 'number', label: 'Seconds between XP gains', default: 60, min: 5, max: 3600 },
    { key: 'reactionXp', type: 'toggle', label: 'Reaction XP: members earn a little XP for reacting to other people\'s messages', default: true },
    { key: 'reactionXpAmount', type: 'number', label: 'Reaction XP per reaction', default: 2, min: 1, max: 50 },
    { key: 'reactionXpCooldownSeconds', type: 'number', label: 'Reaction XP: seconds between XP gains', default: 60, min: 5, max: 3600 },
    { key: 'voiceXp', type: 'toggle', label: 'Voice XP: members earn XP while talking in voice', description: 'Only when someone else is in the channel too. Never in the AFK channel or while deafened.', default: true },
    { key: 'voiceXpPerMinute', type: 'number', label: 'Voice XP per minute', default: 12, min: 1, max: 100 },
    { key: 'voiceXpDailyMinutes', type: 'number', label: 'Voice XP: most minutes that count per member per day (0 = no limit)', default: 300, min: 0, max: 1440 },
    { key: 'voiceXpCountMuted', type: 'toggle', label: 'Voice XP: muted members earn too', default: false },
    { key: 'noXpChannels', type: 'list', label: 'No XP in these channels or categories', description: 'Use /xp ignore to add or remove them. Tickets never give XP.' },
    { key: 'levelUpEnabled', type: 'toggle', label: 'Announce level-ups', default: true },
    { key: 'levelUpChannel', type: 'channel', label: 'Level-up channel (empty = where they chatted, or the voice channel chat)' },
    { key: 'levelUpMessage', type: 'text', label: 'Level-up message', description: '{user} {username} {level}', default: '🎉 {user} reached **level {level}**!' },
    { key: 'stackRewards', type: 'toggle', label: 'Keep earlier level rewards (off = only the newest)', default: true },
    { key: 'repEnabled', type: 'toggle', label: 'Reputation on', default: true },
    { key: 'repAllowNegative', type: 'toggle', label: 'Members may give negative reputation', default: true },
    { key: 'repCooldownHours', type: 'number', label: 'Hours between giving reputation', default: 24, min: 1, max: 720 },
    { key: 'repDailyLimit', type: 'number', label: 'Max reputation gifts per member per day', default: 5, min: 1, max: 50 },
    { key: 'repPairCooldownHours', type: 'number', label: 'Hours before rating the same member again', default: 168, min: 1, max: 8760 },
    { key: 'repNegativeDailyPerTarget', type: 'number', label: 'Max negative votes one member can receive per day', default: 5, min: 1, max: 50 },
    { key: 'repMinMemberDays', type: 'number', label: 'Days in the server before a member can give reputation', default: 0, min: 0, max: 365 },
    { key: 'repLogChannel', type: 'channel', label: 'Reputation audit-log channel' },
    { key: 'liveBoardChannel', type: 'channel', label: 'Live leaderboard channel (empty = off)' },
    { key: 'liveBoardType', type: 'select', label: 'Live leaderboard ranks by', default: 'xp', options: ['xp', 'rep', 'messages'] },
    { key: 'liveBoardSize', type: 'number', label: 'Live leaderboard size (members)', default: 10, min: 3, max: 25 },
    { key: 'liveBoardMinutes', type: 'number', label: 'Minutes between live leaderboard refreshes', default: 5, min: 1, max: 120 },
    { key: 'statsChannel', type: 'channel', label: 'Voice channel to show the member count' },
    { key: 'statsFormat', type: 'text', label: 'Member counter name', description: '{count} {humans} {bots}', default: 'Members: {count}', maxLength: 90 },
  ],
  permissions: [
    { key: 'community.manage', label: 'Edit XP, set level rewards', default: 'admin' },
    { key: 'community.rep-admin', label: 'Remove, set and reset reputation; view anyone\'s history', default: 'admin' },
  ],
  migrations: [{ id: 1, sql: `
    CREATE TABLE IF NOT EXISTS community_rep_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, target_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      delta INTEGER NOT NULL, balance_after INTEGER, kind TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS community_rep_history_target ON community_rep_history (guild_id, target_id, created_at);
    CREATE INDEX IF NOT EXISTS community_rep_history_actor ON community_rep_history (guild_id, actor_id, created_at);
  ` }],
  commands: [
    { data: new SlashCommandBuilder().setName('rank').setDescription('Show your level').addUserOption((o) => o.setName('user').setDescription('Someone else')), execute: rankCmd },
    {
      data: new SlashCommandBuilder().setName('leaderboard').setDescription('Top members')
        .addStringOption((o) => o.setName('type').setDescription('What to rank').addChoices({ name: 'XP', value: 'xp' }, { name: 'Reputation', value: 'rep' }, { name: 'Messages', value: 'messages' }))
        .addIntegerOption((o) => o.setName('page').setDescription('Page').setMinValue(1)),
      execute: leaderboardCmd,
    },
    {
      data: new SlashCommandBuilder().setName('liveboard').setDescription('A leaderboard message that keeps itself up to date')
        .addSubcommand((x) => x.setName('setup').setDescription('Post it in a channel')
          .addChannelOption((o) => o.setName('channel').setDescription('Where').setRequired(true))
          .addStringOption((o) => o.setName('type').setDescription('What to rank').addChoices({ name: 'XP', value: 'xp' }, { name: 'Reputation', value: 'rep' }, { name: 'Messages', value: 'messages' })))
        .addSubcommand((x) => x.setName('refresh').setDescription('Update it right now'))
        .addSubcommand((x) => x.setName('remove').setDescription('Turn it off and delete the message')),
      execute: liveBoardCmd,
    },
    {
      data: new SlashCommandBuilder().setName('rep').setDescription('Reputation')
        .addSubcommand((x) => x.setName('give').setDescription('Give someone reputation')
          .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true))
          .addStringOption((o) => o.setName('type').setDescription('Positive (default) or negative').addChoices({ name: 'positive (+1)', value: 'positive' }, { name: 'negative (-1)', value: 'negative' }))
          .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(200)))
        .addSubcommand((x) => x.setName('check').setDescription('See someone\'s reputation').addUserOption((o) => o.setName('user').setDescription('Who (default: you)')))
        .addSubcommand((x) => x.setName('view').setDescription('Same as check').addUserOption((o) => o.setName('user').setDescription('Who (default: you)')))
        .addSubcommand((x) => x.setName('history').setDescription('Reputation changes (yours, or anyone\'s for admins)')
          .addUserOption((o) => o.setName('user').setDescription('Whose')).addIntegerOption((o) => o.setName('limit').setDescription('How many (1-25)').setMinValue(1).setMaxValue(25)))
        .addSubcommand((x) => x.setName('remove').setDescription('(Admins) Take reputation away')
          .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)).addIntegerOption((o) => o.setName('amount').setDescription('How much (default 1)').setMinValue(1).setMaxValue(1000)).addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(200)))
        .addSubcommand((x) => x.setName('set').setDescription('(Admins) Set an exact score (can be negative)')
          .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)).addIntegerOption((o) => o.setName('value').setDescription('New score').setRequired(true).setMinValue(-100000).setMaxValue(100000)).addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(200)))
        .addSubcommand((x) => x.setName('reset').setDescription('(Admins) Reset one member to 0')
          .addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)).addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(200)))
        .addSubcommand((x) => x.setName('reset-all').setDescription('(Admins) Reset EVERYONE to 0 (asks you to confirm)')),
      execute: repCmd,
    },
    { data: new SlashCommandBuilder().setName('serverstats').setDescription('Statistics about this server'), execute: statsCmd },
    {
      permission: 'community.manage',
      data: new SlashCommandBuilder().setName('xp').setDescription('Edit someone\'s XP')
        .addSubcommand((s) => s.setName('set').setDescription('Set total XP').addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)).addIntegerOption((o) => o.setName('amount').setDescription('XP').setRequired(true).setMinValue(0).setMaxValue(100000000)))
        .addSubcommand((s) => s.setName('reset').setDescription('Reset a member').addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
        .addSubcommandGroup((g) => g.setName('ignore').setDescription('Channels or categories where nobody earns XP')
          .addSubcommand((s) => s.setName('add').setDescription('No XP in a channel or a whole category')
            .addChannelOption((o) => o.setName('channel').setDescription('A channel or a category').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildCategory, ChannelType.GuildForum)))
          .addSubcommand((s) => s.setName('remove').setDescription('Give XP there again')
            .addChannelOption((o) => o.setName('channel').setDescription('A channel or a category').setRequired(true)))
          .addSubcommand((s) => s.setName('list').setDescription('Where XP is switched off')))
        .addSubcommandGroup((g) => g.setName('boost').setDescription('More (or less) XP for some roles or channels')
          .addSubcommand((s) => s.setName('add').setDescription('Set a boost (e.g. 1.5 for Boosters)')
            .addNumberOption((o) => o.setName('multiplier').setDescription('1.5 = 50% more XP, 2 = double, 0.5 = half').setRequired(true).setMinValue(0.1).setMaxValue(5))
            .addRoleOption((o) => o.setName('role').setDescription('A role (or pick a channel)'))
            .addChannelOption((o) => o.setName('channel').setDescription('A channel or category (or pick a role)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildCategory, ChannelType.GuildForum)))
          .addSubcommand((s) => s.setName('remove').setDescription('Remove a boost')
            .addRoleOption((o) => o.setName('role').setDescription('The role'))
            .addChannelOption((o) => o.setName('channel').setDescription('The channel or category')))
          .addSubcommand((s) => s.setName('list').setDescription('All XP boosts'))),
      async execute(ctx, i) {
        if (i.options.getSubcommandGroup(false) === 'ignore') return xpIgnoreCmd(ctx, i);
        if (i.options.getSubcommandGroup(false) === 'boost') return xpBoostCmd(ctx, i);
        const user = i.options.getUser('user', true);
        if (user.bot) throw new UserError('Bots have no XP.');
        const amount = i.options.getSubcommand() === 'set' ? i.options.getInteger('amount', true) : 0;
        ctx.data.update(userKey(user.id), (r) => ({ ...fresh(), ...r, xp: amount }), fresh());
        const member = await i.guild.members.fetch(user.id).catch(() => null);
        if (member) await applyRewards(ctx, member, levelOf(amount).level);
        await i.reply({ content: `<@${user.id}> is now level **${levelOf(amount).level}** (${amount} XP).`, flags: EPH, allowedMentions: NOPING });
      },
    },
    {
      permission: 'community.manage',
      data: new SlashCommandBuilder().setName('levels').setDescription('Level rewards')
        .addSubcommandGroup((g) => g.setName('reward').setDescription('Role rewards')
          .addSubcommand((s) => s.setName('add').setDescription('Give a role at a level').addIntegerOption((o) => o.setName('level').setDescription('Level').setRequired(true).setMinValue(1).setMaxValue(200)).addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
          .addSubcommand((s) => s.setName('remove').setDescription('Remove a reward').addIntegerOption((o) => o.setName('level').setDescription('Level').setRequired(true)))
          .addSubcommand((s) => s.setName('list').setDescription('Show rewards'))),
      async execute(ctx, i) {
        const sub = i.options.getSubcommand();
        if (sub === 'list') {
          const rows = ctx.data.list('reward:').map(({ key, value }) => ({ l: Number(key.slice(7)), r: value })).sort((a, b) => a.l - b.l).map((x) => `Level **${x.l}** → <@&${x.r}>`);
          return i.reply({ content: rows.join('\n') || 'No rewards yet.', flags: EPH, allowedMentions: NOPING });
        }
        const level = i.options.getInteger('level', true);
        if (sub === 'remove') { ctx.data.delete(`reward:${String(level).padStart(4, '0')}`); return i.reply({ content: 'Removed.', flags: EPH }); }
        const role = i.options.getRole('role', true);
        const me = i.guild.members.me;
        if (role.managed || role.id === i.guild.id) throw new UserError("That role can't be used.");
        if (DANGEROUS.some((p) => role.permissions.has(p))) throw new UserError('That role has powerful permissions - I won\'t hand it out automatically.');
        if (role.position >= me.roles.highest.position) throw new UserError('Move my role above that role first.');
        if (i.user.id !== i.guild.ownerId && role.position >= i.member.roles.highest.position) throw new UserError('You can only reward roles below your own highest role.');
        ctx.data.set(`reward:${String(level).padStart(4, '0')}`, role.id);
        await i.reply({ content: `Reaching level **${level}** now grants **${role.name}**.`, flags: EPH, allowedMentions: NOPING });
      },
    },
  ],
  components: [{ prefix: 'rep:', execute: repComponent }, { prefix: 'rankstyle:', execute: rankStyle }],
  views: {
    async boosts(ctx) {
      return { rows: (ctx.data.get('xpBoosts') ?? []).map((b) => {
        const name = b.kind === 'role' ? `@${ctx.guild?.roles.cache.get(b.id)?.name ?? 'deleted role'}` : `${ctx.guild?.channels.cache.get(b.id)?.type === 4 ? '📁 ' : '#'}${ctx.guild?.channels.cache.get(b.id)?.name ?? 'deleted channel'}`;
        return { id: `${b.kind}:${b.id}`, name, kind: b.kind === 'role' ? 'Role' : 'Channel', mult: `×${b.mult}`, multRaw: b.mult };
      }) };
    },
    /** For the phone app: the leaderboard with names and pictures. */
    async levels(ctx) {
      const all = ranking(ctx, 'xp').filter((x) => x.xp > 0);
      const rows = all.slice(0, 100).map((x, n) => {
        const m = ctx.guild?.members.cache.get(x.id);
        const l = levelOf(x.xp);
        return { rank: n + 1, id: x.id, name: m?.displayName ?? `Member …${x.id.slice(-4)}`, avatar: m?.displayAvatarURL?.({ size: 64, extension: 'png' }) ?? null, xp: x.xp, level: l.level, into: l.into, needed: l.needed, xpText: x.xp.toLocaleString('en-US'), progress: `${l.into.toLocaleString('en-US')} / ${l.needed.toLocaleString('en-US')}` };
      });
      return { total: all.length, rows };
    },
    async reputation(ctx) {
      const name = (id) => ctx.guild?.members.cache.get(id)?.displayName ?? id;
      const rows = ranking(ctx, 'rep').filter((x) => x.rep !== 0).slice(0, 100).map((x) => ({ id: x.id, name: name(x.id), rep: x.rep }));
      const recent = ctx.sql.all('SELECT target_id, actor_id, delta, kind, reason, created_at FROM community_rep_history WHERE guild_id = ? ORDER BY id DESC LIMIT 15', ctx.guildId)
        .map((r) => ({ when: new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 16), kind: r.kind, change: fmtRep(r.delta), target: name(r.target_id), by: name(r.actor_id), reason: r.reason ?? '' }));
      return { rows, recent };
    },
  },
  actions: {
    async 'boost-add'(ctx, body) {
      const role = body.role || null, ch = body.channel || null;
      if (!role === !ch) throw new UserError('Pick a role or a channel (one of them).');
      const mult = Math.round(Number(body.mult) * 100) / 100;
      if (!(mult >= 0.1 && mult <= 5)) throw new UserError('Use a multiplier from 0.1 to 5.');
      const kind = role ? 'role' : 'channel', id = role ?? ch;
      const rest = (ctx.data.get('xpBoosts') ?? []).filter((b) => !(b.kind === kind && b.id === id));
      if (rest.length >= 25) throw new UserError('You can have up to 25 boosts.');
      ctx.data.set('xpBoosts', [...rest, { kind, id, mult }]);
      return { kind, id, mult };
    },
    async 'boost-set'(ctx, body) {
      const [kind, id] = String(body.id).split(':');
      const mult = Math.round(Number(body.mult) * 100) / 100;
      if (!(mult >= 0.1 && mult <= 5)) throw new UserError('Use a multiplier from 0.1 to 5.');
      ctx.data.set('xpBoosts', (ctx.data.get('xpBoosts') ?? []).map((b) => (b.kind === kind && b.id === id ? { ...b, mult } : b)));
      return { kind, id, mult };
    },
    async 'boost-remove'(ctx, body) {
      const [kind, id] = String(body.id).split(':');
      ctx.data.set('xpBoosts', (ctx.data.get('xpBoosts') ?? []).filter((b) => !(b.kind === kind && b.id === id)));
      return { kind, id };
    },
    // Levels box in the dashboard: give, take or reset XP, then hand out any level rewards that now apply.
    async 'xp-give'(ctx, body) { return changeXp(ctx, body.userId, (xp) => xp + intIn(body.value, 1, 10000000, 'The XP to give')); },
    async 'xp-take'(ctx, body) { return changeXp(ctx, body.userId, (xp) => Math.max(0, xp - intIn(body.value, 1, 10000000, 'The XP to take'))); },
    async 'xp-reset'(ctx, body) { return changeXp(ctx, body.userId, () => 0); },
    async 'xp-reset-all'(ctx, body) {
      if (body.confirm !== 'RESET') throw new UserError('Type RESET to confirm a server-wide reset.');
      const backup = ctx.backup('before-xp-reset-all');
      let affected = 0;
      ctx.sql.transaction(() => {
        for (const { key, value } of ctx.data.list('user:')) { if (!value.xp) continue; ctx.data.set(key, { ...value, xp: 0 }); affected++; }
      });
      return { affected, backup };
    },
    async 'rep-set'(ctx, body, actor) {
      if (!SNOWFLAKE.test(String(body.userId))) throw new UserError('Pick a member.');
      const r = setRepValue(ctx, { target: body.userId, actor: actor.userId, value: intIn(body.value, -100000, 100000, 'The score'), kind: 'set', reason: `via dashboard (${actor.username})` });
      return { before: r.before, after: r.after };
    },
    async 'rep-reset'(ctx, body, actor) {
      if (!SNOWFLAKE.test(String(body.userId))) throw new UserError('Pick a member.');
      return setRepValue(ctx, { target: body.userId, actor: actor.userId, value: 0, kind: 'reset', reason: `via dashboard (${actor.username})` });
    },
    async 'rep-reset-all'(ctx, body, actor) {
      if (body.confirm !== 'RESET') throw new UserError('Type RESET to confirm a server-wide reset.');
      return resetEveryone(ctx, actor.userId);
    },
  },
  panels: [{
    id: 'levels', title: 'Levels', view: 'levels', permission: 'community.manage',
    description: 'Members earn XP for chatting (once a minute at most). More XP means a higher level, and level rewards hand out roles.',
    empty: 'Nobody has earned XP yet. XP starts counting from the first message after Community was turned on.',
    columns: [{ key: 'rank', label: '#', kind: 'rank' }, { key: 'name', label: 'Member', kind: 'member' }, { key: 'level', label: 'Level' },
      { key: 'xpText', label: 'XP', hint: 'Total XP. The level comes from it: each level needs a bit more than the last.' }, { key: 'progress', label: 'Next level', hint: 'XP gathered towards the next level.' }],
    rowActions: [
      { action: 'xp-give', label: 'Give XP', prompt: 'number', field: 'value', hint: 'How much XP to add?', placeholder: 'e.g. 500', done: 'XP given' },
      { action: 'xp-take', label: 'Take XP', prompt: 'number', field: 'value', hint: 'How much XP to take away? It never goes below 0.', placeholder: 'e.g. 500', done: 'XP taken' },
      { action: 'xp-reset', label: 'Reset', confirm: 'Set this member back to 0 XP (level 0)? Roles they already earned are kept.', danger: true, done: 'Reset' },
    ],
    globalActions: [{ action: 'xp-reset-all', label: 'Reset everyone', confirmWord: 'RESET', confirm: 'Set every member back to 0 XP. A backup of the database is made first.' }],
  }, {
    id: 'reputation', title: 'Reputation', view: 'reputation',
    description: 'Points members give each other with /rep. Staff can set or reset a score here.',
    empty: 'Nobody has any reputation yet.', recentEmpty: 'No reputation changes yet.',
    columns: [{ key: 'name', label: 'Member' }, { key: 'rep', label: 'Score' }],
    rowActions: [{ action: 'rep-set', label: 'Set', prompt: 'number', field: 'value', hint: 'The new score (can be negative).', current: 'rep', done: 'Score saved' },
      { action: 'rep-reset', label: 'Reset', confirm: 'Set this member\'s reputation back to 0?', danger: true, done: 'Reset' }],
    globalActions: [{ action: 'rep-reset-all', label: 'Reset everyone', confirmWord: 'RESET', confirm: 'Set everyone\'s reputation back to 0. A backup is made first.' }],
    recentColumns: [{ key: 'when', label: 'When' }, { key: 'kind', label: 'Type' }, { key: 'change', label: 'Change' }, { key: 'target', label: 'Member' }, { key: 'by', label: 'By' }, { key: 'reason', label: 'Reason' }],
  }, {
    id: 'boosts', title: 'XP boosts', view: 'boosts', permission: 'community.manage',
    description: 'More (or less) XP for some roles or channels. A member gets their best role boost, times the boost of the channel they are in.',
    empty: 'No boosts yet. For example, give server Boosters ×1.5.',
    columns: [{ key: 'name', label: 'Role or channel' }, { key: 'kind', label: 'Kind' }, { key: 'mult', label: 'Boost' }],
    rowActions: [{ action: 'boost-set', label: 'Change', prompt: 'number', field: 'mult', current: 'multRaw', hint: 'From 0.1 to 5 (1.5 = 50% more XP).', done: 'Boost saved' },
      { action: 'boost-remove', label: 'Remove', confirm: 'Remove this boost?', danger: true, done: 'Removed' }],
    addForm: { action: 'boost-add', label: 'Add boost', hint: 'Pick a role or a channel (not both).', done: 'Boost added', fields: [
      { key: 'role', label: 'Role', type: 'role', optional: true }, { key: 'channel', label: 'Or a channel / category', type: 'channel', optional: true },
      { key: 'mult', label: 'Boost (0.1 to 5, e.g. 1.5)', type: 'number' }] },
  }],
  events: {
    messageCreate: onMessage,
    messageReactionAdd: (ctx, reaction, user) => onReaction(ctx, reaction, user),
    guildMemberRemove: async (ctx, member) => { ctx.data.delete(userKey(member.id)); },
  },
  tasks: [{
    name: 'voice-xp', everyMs: 60000, run: (ctx) => voiceTick(ctx),
  }, {
    name: 'live-leaderboard', everyMs: 60000, runOnEnable: true,
    async run(ctx) {
      const saved = ctx.data.get('liveboard');
      const gap = Math.max(1, Number(ctx.config.get('liveBoardMinutes')) || 5) * 60000;
      if (saved?.at && Date.now() - saved.at < gap && saved.channelId === ctx.config.get('liveBoardChannel')) return;
      await refreshLiveBoard(ctx);
    },
  }, {
    name: 'member-counter', everyMs: 600000, runOnEnable: true,
    async run(ctx) {
      const ch = ctx.guild.channels.cache.get(ctx.config.get('statsChannel'));
      if (!ch?.setName) return;
      const bots = ctx.guild.members.cache.filter((m) => m.user.bot).size;
      const name = truncate(fillTemplate(ctx.config.get('statsFormat'), { count: ctx.guild.memberCount, bots, humans: ctx.guild.memberCount - bots }), 100);
      if (ch.name !== name) await ctx.queue(() => ch.setName(name, 'Member counter'));
    },
  }],
};
