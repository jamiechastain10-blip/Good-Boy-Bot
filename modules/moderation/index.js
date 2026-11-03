/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Moderation suite: warn / timeout / kick / ban / unban / purge / history,
 * AutoMod (spam, words, links, mass mentions), raid protection, anti-nuke, logging.
 */
import { SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType, ChannelType, EmbedBuilder, AuditLogEvent, PermissionFlagsBits as P, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonStyle, ButtonBuilder } from 'discord.js';
import { UserError, hierarchyError, parseDuration, formatDuration, truncate, escapeRegex, ts, SNOWFLAKE } from '../../src/util.js';
import { formStore } from '../../src/forms.js';
import { createPipeline } from '../../src/modalpipe.js';
import { RULES, RULE_IDS, ACTIONS, ruleById, ruleEnabled, actionFor, isExempt, editExempt, countEmoji, capsRatio, recordRepeat, snippet, activityCounts } from '../../src/automod.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const COLOR = { warn: 0xfaa61a, timeout: 0xe67e22, untimeout: 0x2ecc71, kick: 0xe74c3c, ban: 0x992d22, unban: 0x2ecc71, purge: 0x95a5a6, automod: 0x3498db, alert: 0xed4245, info: 0x5865f2 };
const MAX_TIMEOUT = 28 * 86400000;
const DANGEROUS = [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.BanMembers, P.KickMembers, P.ManageWebhooks];

// in-memory sliding windows (reset on restart - that's fine for rate limiting)
const spam = new Map();   // guild:user -> [{t,id,ch}]
const joins = new Map();  // guild -> [{t,id}]
const raidUntil = new Map();
const nuke = new Map();   // guild:executor -> [t]
const regexCache = new Map();

const prune = (arr, windowMs, now = Date.now()) => arr.filter((e) => now - (e.t ?? e) < windowMs);

function addCase(ctx, { type, user, modId, reason, extra }) {
  const id = ctx.data.update('counter', (n) => n + 1, 0);
  const entry = { id, type, targetId: user.id, targetTag: user.tag ?? user.username ?? user.id, modId, reason, at: Date.now(), ...extra };
  ctx.data.update(`hist:${user.id}`, (arr) => [entry, ...arr].slice(0, 100), []);
  const words = { warn: 'was warned', timeout: 'was timed out', untimeout: 'had a timeout lifted', kick: 'was kicked', ban: 'was banned', unban: 'was unbanned' };
  if (modId && words[type]) ctx.live?.('activity', { icon: '🛡️', text: `${entry.targetTag} ${words[type]}` });
  ctx.live?.('data');
  return entry;
}

// ---- server logs (2.3): joins, leaves, role and nickname changes, voice. Off unless turned on; their own channel or the mod log.
async function serverLog(ctx, kind, embed) {
  if (!ctx.config.get(kind)) return;
  const id = ctx.config.get('serverLogChannel') || ctx.config.get('logChannel');
  const ch = id && ctx.guild?.channels.cache.get(id);
  if (!ch?.isTextBased?.()) return;
  await ctx.queue(() => ch.send({ embeds: [embed.setTimestamp()], allowedMentions: NOPING })).catch(() => {});
}
const who = (m) => `<@${m.id}> · ${m.user?.username ?? m.id} (${m.id})`;
const ageText = (ms) => { const d = Math.floor((Date.now() - ms) / 86400000); return d < 1 ? 'today' : d < 60 ? `${d} days ago` : `${Math.floor(d / 30)} months ago`; };
async function logJoin(ctx, m) {
  await serverLog(ctx, 'logJoins', new EmbedBuilder().setColor(0x22c38e).setTitle('📥 Member joined').setDescription(`${who(m)}\nAccount created ${ageText(m.user?.createdTimestamp ?? Date.now())}`).setFooter({ text: `Members: ${m.guild?.memberCount ?? '?'}` }));
}
async function logLeave(ctx, m) {
  const roles = [...(m.roles?.cache?.values?.() ?? [])].filter((r) => r.id !== m.guild?.id).map((r) => `<@&${r.id}>`);
  await serverLog(ctx, 'logJoins', new EmbedBuilder().setColor(0x8b97ab).setTitle('📤 Member left').setDescription(`${who(m)}${m.joinedTimestamp ? `\nJoined ${ageText(m.joinedTimestamp)}` : ''}${roles.length ? `\nRoles: ${roles.slice(0, 20).join(' ')}` : ''}`));
}
async function logMemberUpdate(ctx, before, after) {
  if (!before || before.partial) return;
  const had = new Set(before.roles?.cache?.keys?.() ?? []), has = new Set(after.roles?.cache?.keys?.() ?? []);
  const added = [...has].filter((r) => !had.has(r)), removed = [...had].filter((r) => !has.has(r));
  if (added.length || removed.length) {
    await serverLog(ctx, 'logRoles', new EmbedBuilder().setColor(0x5865f2).setTitle('🎭 Roles changed').setDescription([who(after), added.length ? `Added: ${added.map((r) => `<@&${r}>`).join(' ')}` : null, removed.length ? `Removed: ${removed.map((r) => `<@&${r}>`).join(' ')}` : null].filter(Boolean).join('\n')));
  }
  if (before.nickname !== after.nickname) {
    await serverLog(ctx, 'logNicknames', new EmbedBuilder().setColor(0xf2a93b).setTitle('🏷️ Nickname changed').setDescription(`${who(after)}\n**Before:** ${before.nickname ?? '*none*'}\n**After:** ${after.nickname ?? '*none*'}`));
  }
}
async function logVoice(ctx, before, after) {
  const m = after.member ?? before.member;
  if (!m || m.user?.bot || before.channelId === after.channelId) return;
  const text = !before.channelId ? `joined 🔊 <#${after.channelId}>` : !after.channelId ? `left 🔊 <#${before.channelId}>` : `moved 🔊 <#${before.channelId}> → <#${after.channelId}>`;
  await serverLog(ctx, 'logVoice', new EmbedBuilder().setColor(0x3ba7a0).setDescription(`${who(m)} ${text}`));
}

// ---- purge (2.3.1): no 100 and no 14-day limit.
// Discord only bulk-deletes messages younger than 14 days, so those go 100 at a time, and older ones are deleted one by
// one (Discord allows about one a second: big purges take a while and run in the background, with progress and Stop).
// "Recreate" clones the channel (same permissions, topic, category, position) and deletes the old one: instant,
// everything gone. Good Boy's own settings that pointed at the old channel are moved to the new one.
const purges = (globalThis[Symbol.for('goodboy.moderation.purges')] ??= new Map()); // channelId -> job
const FOURTEEN_DAYS = 14 * 86400000 - 60000;

export async function runPurge(ctx, ch, { amount = Infinity, userId = null, keepPinned = true, onProgress, job = { stop: false } } = {}) {
  let before, deleted = 0, scanned = 0;
  const done = () => deleted >= amount || job.stop;
  while (!done()) {
    const page = await ctx.queue(() => ch.messages.fetch({ limit: 100, ...(before ? { before } : {}) })).catch(() => null);
    const list = [...(page?.values?.() ?? [])];
    if (!list.length) break;
    scanned += list.length;
    before = list.reduce((a, m) => (m.createdTimestamp < a.createdTimestamp ? m : a), list[0]).id;
    const pick = list.filter((m) => (!userId || m.author?.id === userId) && !(keepPinned && m.pinned)).slice(0, amount - deleted);
    const young = pick.filter((m) => Date.now() - m.createdTimestamp < FOURTEEN_DAYS);
    const old = pick.filter((m) => !young.includes(m));
    if (young.length > 1) { const r = await ctx.queue(() => ch.bulkDelete(young.map((m) => m.id), true)).catch(() => null); deleted += r?.size ?? 0; }
    else if (young.length === 1) { if (await ctx.queue(() => young[0].delete()).then(() => true).catch(() => false)) deleted++; }
    for (const m of old) { if (job.stop) break; if (await ctx.queue(() => m.delete()).then(() => true).catch(() => false)) deleted++; onProgress?.({ deleted, scanned }); }
    onProgress?.({ deleted, scanned });
    if (list.length < 100) break;
  }
  return { deleted, scanned, stopped: job.stop };
}

/** Clone the channel, put it where the old one was, delete the old one, and point Good Boy's settings at the new one. */
export async function recreateChannel(ctx, ch, by) {
  const fresh = await ch.clone({ reason: `Purge all by ${by}` });
  await fresh.setPosition?.(ch.position).catch(() => {});
  await ch.delete(`Purge all by ${by} (recreated as #${fresh.name})`);
  const like = `%${ch.id}%`;
  ctx.sql.run('UPDATE module_config SET value = REPLACE(value, ?, ?) WHERE guild_id = ? AND value LIKE ?', ch.id, fresh.id, ctx.guildId, like);
  ctx.sql.run('UPDATE module_data SET value = REPLACE(value, ?, ?) WHERE guild_id = ? AND value LIKE ?', ch.id, fresh.id, ctx.guildId, like);
  ctx.sql.run('UPDATE OR IGNORE module_data SET key = REPLACE(key, ?, ?) WHERE guild_id = ? AND key LIKE ?', ch.id, fresh.id, ctx.guildId, like);
  return fresh;
}

async function purgeCmd(ctx, i) {
  const ch = i.channel;
  if (!ch?.messages?.fetch) throw new UserError("I can't purge in this kind of channel.");
  const amount = i.options.getInteger('amount') ?? null;
  const user = i.options.getUser('user');
  const method = i.options.getString('method') ?? 'delete';
  const keepPinned = i.options.getBoolean('keep_pinned') ?? true;
  if (purges.has(ch.id)) throw new UserError('A purge is already running in this channel.');
  if (method === 'recreate') {
    if (amount || user) throw new UserError('Recreate removes everything, so leave amount and user empty (or pick "Delete the messages").');
    ctx.data.set(`purge:${i.user.id}`, { channelId: ch.id, method, at: Date.now() });
    return i.reply({ content: `⚠️ **Recreate <#${ch.id}>?** Every message is gone at once, including pins. Permissions, topic, slowmode and position stay the same. Webhooks in this channel are removed.`, flags: EPH, allowedMentions: NOPING,
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mpurge:yes:${i.user.id}`).setLabel('Yes, recreate it').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`mpurge:no:${i.user.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))] });
  }
  // Up to 100 recent messages: straight away, like before. Anything bigger asks first and runs in the background.
  if (amount && amount <= 100) {
    await i.deferReply({ flags: EPH });
    const r = await runPurge(ctx, ch, { amount, userId: user?.id, keepPinned });
    await modLog(ctx, new EmbedBuilder().setColor(COLOR.purge).setTitle('Purge').setDescription(`<@${i.user.id}> deleted **${r.deleted}** message(s) in <#${ch.id}>${user ? ` from <@${user.id}>` : ''}.`).setTimestamp());
    return i.editReply({ content: `🧹 Deleted ${r.deleted} message(s).` });
  }
  ctx.data.set(`purge:${i.user.id}`, { channelId: ch.id, method, amount, userId: user?.id ?? null, keepPinned, at: Date.now() });
  const what = `${amount ? `up to **${amount.toLocaleString('en-US')}**` : '**every**'} message${user ? ` from <@${user.id}>` : ''} in <#${ch.id}>${keepPinned ? ' (pins are kept)' : ''}`;
  return i.reply({ content: `⚠️ Delete ${what}? Messages older than 14 days are deleted one by one, about one a second, so a big purge takes a while. It runs in the background and you can stop it.`, flags: EPH, allowedMentions: NOPING,
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mpurge:yes:${i.user.id}`).setLabel('Yes, delete them').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`mpurge:no:${i.user.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))] });
}

async function purgeClick(ctx, i) {
  const [, kind, owner] = i.customId.split(':');
  if (owner !== i.user.id) throw new UserError('That belongs to someone else.');
  if (!ctx.perms.check(i.member, 'moderation.purge')) throw new UserError("You don't have permission for that (`moderation.purge`).");
  const p = ctx.data.get(`purge:${owner}`);
  if (kind === 'stop') { const job = purges.get(p?.channelId ?? i.channelId); if (job) job.stop = true; return i.update({ content: '⏹️ Stopping…', components: [] }); }
  ctx.data.delete(`purge:${owner}`);
  if (kind === 'no') return i.update({ content: 'Cancelled. Nothing was deleted.', components: [] });
  if (!p || Date.now() - p.at > 10 * 60000) throw new UserError('That confirmation expired. Run `/purge` again.');
  const ch = ctx.guild.channels.cache.get(p.channelId);
  if (!ch) throw new UserError('That channel is gone.');
  if (p.method === 'recreate') {
    await i.update({ content: '⏳ Recreating…', components: [] });
    const fresh = await recreateChannel(ctx, ch, i.user.username);
    await modLog(ctx, new EmbedBuilder().setColor(COLOR.purge).setTitle('Purge all (channel recreated)').setDescription(`<@${i.user.id}> recreated **#${fresh.name}**: every message removed.`).setTimestamp());
    await ctx.queue(() => fresh.send({ content: `🧹 This channel was cleared by a moderator.`, allowedMentions: NOPING })).catch(() => {});
    return;
  }
  const job = { stop: false };
  purges.set(ch.id, job);
  await i.update({ content: '🧹 Purging… 0 deleted so far.', components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`mpurge:stop:${owner}`).setLabel('Stop').setStyle(ButtonStyle.Secondary))] });
  ctx.data.set(`purge:${owner}`, { channelId: ch.id, at: Date.now() }); // so Stop can find it
  const until = Date.now() + 14 * 60000; let last = 0;
  const r = await runPurge(ctx, ch, { amount: p.amount ?? Infinity, userId: p.userId, keepPinned: p.keepPinned, job,
    onProgress: ({ deleted }) => { if (Date.now() - last > 5000 && Date.now() < until) { last = Date.now(); i.editReply({ content: `🧹 Purging… ${deleted.toLocaleString('en-US')} deleted so far.` }).catch(() => {}); } } }).finally(() => purges.delete(ch.id));
  ctx.data.delete(`purge:${owner}`);
  await modLog(ctx, new EmbedBuilder().setColor(COLOR.purge).setTitle('Purge').setDescription(`<@${i.user.id}> deleted **${r.deleted}** message(s) in <#${ch.id}>${p.userId ? ` from <@${p.userId}>` : ''}${r.stopped ? ' (stopped early)' : ''}.`).setTimestamp());
  const text = `${r.stopped ? '⏹️ Stopped' : '✅ Done'}: deleted ${r.deleted.toLocaleString('en-US')} message(s) in <#${ch.id}>.`;
  if (Date.now() < until) await i.editReply({ content: text, components: [] }).catch(() => {});
  else await i.user.send({ content: text, allowedMentions: NOPING }).catch(() => {});
}

async function modLog(ctx, embed) {
  const id = ctx.config.get('logChannel');
  const ch = id && ctx.guild?.channels.cache.get(id);
  if (!ch?.isTextBased()) return;
  await ctx.queue(() => ch.send({ embeds: [embed], allowedMentions: NOPING })).catch(() => {});
}

function caseEmbed(type, c, user, mod) {
  const e = new EmbedBuilder().setColor(COLOR[type] ?? COLOR.info).setTitle(`${type[0].toUpperCase() + type.slice(1)} · case #${c.id}`)
    .addFields({ name: 'User', value: `${user.tag ?? user.username} (${user.id})`, inline: true }, { name: 'Moderator', value: mod ? `<@${mod}>` : 'AutoMod', inline: true },
      { name: 'Reason', value: truncate(c.reason, 1000) }).setTimestamp();
  if (c.severity) e.addFields({ name: 'Severity', value: SEVERITY[c.severity]?.label ?? c.severity, inline: true });
  if (c.notes) e.addFields({ name: 'Duration / notes', value: truncate(c.notes, 500), inline: true });
  return e;
}

async function tellUser(ctx, user, guild, text) {
  if (!ctx.config.get('dmOnAction')) return;
  await user.send({ content: `**${truncate(guild.name, 60)}**: ${text}`, allowedMentions: NOPING }).catch(() => {});
}

async function fetchTarget(i, user) {
  const member = await i.guild.members.fetch(user.id).catch(() => null);
  return member;
}

function guardTarget(i, member) {
  const err = hierarchyError(i.guild, i.member, member, i.guild.members.me);
  if (err) throw new UserError(err);
}

async function doTimeout(ctx, member, ms, reason, modId, type = 'timeout') {
  if (!member.moderatable) throw new UserError("I can't time out that member (their role is above mine, or they're an admin).");
  await member.timeout(Math.min(ms, MAX_TIMEOUT - 60000), truncate(reason, 400)); // stay safely inside Discord's 28-day cap
  const c = addCase(ctx, { type, user: member.user, modId, reason, extra: { durationMs: ms } });
  await modLog(ctx, caseEmbed('timeout', c, member.user, modId));
  return c;
}

// ------------------------------------------------------------------ AutoMod
function wordRegex(words) {
  const key = words.join('\u0000');
  let r = regexCache.get(key);
  if (!r) {
    r = words.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(escapeRegex).join('|')})(?![\\p{L}\\p{N}])`, 'iu') : null;
    regexCache.set(key, r);
    if (regexCache.size > 50) regexCache.delete(regexCache.keys().next().value);
  }
  return r;
}

function domainAllowed(host, allowed) {
  host = host.toLowerCase();
  return allowed.some((a) => { a = a.toLowerCase().replace(/^www\./, ''); return host === a || host.endsWith('.' + a); });
}

const AUTOMOD_CFG_KEYS = ['automodAction', ...RULES.flatMap((r) => [r.on, r.limit, r.action].filter(Boolean)), 'spamWindowSeconds', 'repeatWindowSeconds', 'capsMinLetters'];
const automodCfg = (ctx) => Object.fromEntries(AUTOMOD_CFG_KEYS.map((k) => [k, ctx.config.get(k)]));
const RECENT_MAX = 200;
const repeats = new Map(); // guild:user -> [{t,id,ch,key}]

/** First rule this message breaks (words, links, mentions, caps, emoji, repeats, spam), or null. */
function detect(ctx, message, where = {}) {
  const text = message.content ?? '';
  const cfg = automodCfg(ctx);
  const ex = ctx.data.get('automod:exempt') ?? {};
  const live = (rule) => ruleEnabled(cfg, rule) && !isExempt(ex, rule.id, where);
  const R = (id) => ruleById(id);

  if (text && live(R('words'))) {
    const re = wordRegex(ctx.config.get('bannedWords') ?? []);
    if (re?.test(text)) return { rule: 'words', name: 'word filter', msg: 'that word is not allowed here.' };
  }
  if (text && live(R('links'))) {
    const allowed = ctx.config.get('allowedDomains') ?? [];
    for (const m of text.matchAll(/\b(?:https?:\/\/|www\.)([^\s/?#<>]+)/gi)) {
      if (!domainAllowed(m[1], allowed)) return { rule: 'links', name: 'link filter', msg: "links aren't allowed here." };
    }
    if (/\b(?:discord\.gg|discord(?:app)?\.com\/invite)\/\w+/i.test(text) && !domainAllowed('discord.gg', allowed)) return { rule: 'links', name: 'invite filter', msg: "invites aren't allowed here." };
  }
  if (live(R('mentions')) && message.mentions.users.size + message.mentions.roles.size >= cfg.maxMentions) return { rule: 'mentions', name: 'mass mention', msg: 'too many mentions in one message.' };
  if (text && live(R('caps')) && capsRatio(text, { minLetters: cfg.capsMinLetters }) >= cfg.capsPercent) return { rule: 'caps', name: 'too many capitals', msg: 'please do not shout - too many capital letters.' };
  if (text && live(R('emoji')) && countEmoji(text) > cfg.emojiMax) return { rule: 'emoji', name: 'too many emoji', msg: 'too many emoji in one message.' };
  const key = `${ctx.guildId}:${message.author.id}`;
  if (text && live(R('repeat'))) {
    const r = recordRepeat(repeats.get(key) ?? [], { text, id: message.id, ch: message.channelId, now: Date.now(), windowMs: cfg.repeatWindowSeconds * 1000 });
    repeats.set(key, r.list);
    if (r.count >= cfg.repeatMax) { repeats.delete(key); return { rule: 'repeat', name: 'repeated message', msg: 'please do not repeat the same message.', bulk: r.hits }; }
  }
  if (live(R('spam'))) {
    const windowMs = cfg.spamWindowSeconds * 1000;
    const list = prune(spam.get(key) ?? [], windowMs);
    list.push({ t: Date.now(), id: message.id, ch: message.channelId });
    spam.set(key, list);
    if (list.length >= cfg.spamMaxMessages) { spam.delete(key); return { rule: 'spam', name: 'spam', msg: 'slow down - you are sending messages too fast.', bulk: list }; }
  }
  return null;
}

function remember(ctx, message, v, action, c) {
  const entry = { at: Date.now(), userId: message.author.id, tag: truncate(message.author.tag ?? message.author.username ?? message.author.id, 40), channelId: message.channelId, rule: v.rule, name: v.name, action, caseId: c?.id ?? null };
  if (ctx.config.get('automodKeepSnippets')) entry.snippet = snippet(message.content, 80);
  ctx.data.update('automod:recent', (arr) => [entry, ...arr].slice(0, RECENT_MAX), []);
  ctx.live?.('data', { panel: 'automod' });
  ctx.live?.('activity', { icon: '🤖', text: `AutoMod caught a message in #${ctx.guild?.channels.cache.get(message.channelId)?.name ?? 'a channel'} (${v.name})` });
}

async function onMessage(ctx, message) {
  if (!message.guild || message.author.bot || message.system || !message.member) return;
  if (ctx.perms.check(message.member, 'moderation.bypass')) return;
  const ch = message.channel;
  const v = detect(ctx, message, {
    roleIds: [...(message.member.roles?.cache?.keys?.() ?? [])],
    channelId: message.channelId, parentId: ch?.isThread?.() ? ch.parentId : null, categoryId: ch?.isThread?.() ? ch.parent?.parentId : ch?.parentId,
  });
  if (!v) return;

  const action = actionFor(automodCfg(ctx), ruleById(v.rule));
  if (v.bulk) {
    // earlier messages from the same burst, in bulk (best effort); the triggering message is always attempted directly
    const byChannel = new Map();
    for (const e of v.bulk) if (e.id !== message.id) (byChannel.get(e.ch) ?? byChannel.set(e.ch, []).get(e.ch)).push(e.id);
    for (const [chId, ids] of byChannel) await message.guild.channels.cache.get(chId)?.bulkDelete?.(ids, true).catch(() => {});
  }
  await message.delete().catch(() => {});

  const reason = `AutoMod: ${v.name}`;
  let c;
  if (action === 'delete-warn') c = addCase(ctx, { type: 'warn', user: message.author, modId: null, reason });
  if (action === 'delete-timeout') c = await doTimeout(ctx, message.member, ctx.config.get('automodTimeoutMinutes') * 60000, reason, null, 'timeout').catch(() => null);
  remember(ctx, message, v, action, c);

  const notice = await message.channel.send({ content: `<@${message.author.id}>, ${v.msg}`, allowedMentions: { users: [message.author.id] } }).catch(() => null);
  if (notice) setTimeout(() => notice.delete().catch(() => {}), 6000).unref?.();
  await tellUser(ctx, message.author, message.guild, `your message was removed by AutoMod (${v.name}).`);
  await modLog(ctx, new EmbedBuilder().setColor(COLOR.automod).setTitle('AutoMod').setDescription(`<@${message.author.id}> in <#${message.channelId}> - **${v.name}**${c ? ` (case #${c.id})` : ''}`).setTimestamp());
}

// ------------------------------------------------------------------ raid protection
async function onJoin(ctx, member) {
  const g = member.guild;
  const ageDays = ctx.config.get('minAccountAgeDays');
  if (ageDays > 0 && Date.now() - member.user.createdTimestamp < ageDays * 86400000) {
    const act = ctx.config.get('newAccountAction');
    await modLog(ctx, new EmbedBuilder().setColor(COLOR.alert).setTitle('New account joined').setDescription(`<@${member.id}> - account created ${ts(member.user.createdTimestamp)}`).setTimestamp());
    if (act === 'kick' && member.kickable) await member.kick(`Account younger than ${ageDays} day(s)`).catch(() => {});
  }
  if (!ctx.config.get('raidProtection')) return;
  const now = Date.now();
  const list = prune(joins.get(g.id) ?? [], ctx.config.get('raidWindowSeconds') * 1000, now);
  list.push({ t: now, id: member.id });
  joins.set(g.id, list);
  const inRaid = (raidUntil.get(g.id) ?? 0) > now;
  if (!inRaid && list.length >= ctx.config.get('raidJoinThreshold')) {
    raidUntil.set(g.id, now + 300000);
    ctx.security(`Raid detected: ${list.length} joins in ${ctx.config.get('raidWindowSeconds')}s`);
    await modLog(ctx, new EmbedBuilder().setColor(COLOR.alert).setTitle('🚨 Possible raid').setDescription(`${list.length} members joined within ${ctx.config.get('raidWindowSeconds')} seconds. Raid mode is active for 5 minutes (action: **${ctx.config.get('raidAction')}**).`).setTimestamp());
    for (const j of list.slice(0, -1)) { const m = g.members.cache.get(j.id); if (m) await raidAct(ctx, m); }
  }
  if (inRaid || list.length >= ctx.config.get('raidJoinThreshold')) await raidAct(ctx, member);
}

async function raidAct(ctx, member) {
  const act = ctx.config.get('raidAction');
  try {
    if (act === 'timeout' && member.moderatable) await member.timeout(600000, 'Raid protection');
    else if (act === 'kick' && member.kickable) await member.kick('Raid protection');
  } catch { /* best effort */ }
}

// ------------------------------------------------------------------ anti-nuke
const WATCHED = () => new Set([AuditLogEvent.ChannelDelete, AuditLogEvent.RoleDelete, AuditLogEvent.MemberBanAdd, AuditLogEvent.MemberKick]);

async function onAudit(ctx, entry, guild) {
  if (!ctx.config.get('antiNuke') || !WATCHED().has(entry.action)) return;
  const execId = entry.executorId;
  if (!execId || execId === ctx.client.user.id || execId === guild.ownerId) return;
  const member = await guild.members.fetch(execId).catch(() => null);
  const immune = ctx.perms.rolesFor('moderation.antinuke-immune');
  if (member && immune.some((r) => member.roles.cache.has(r))) return;

  const key = `${guild.id}:${execId}`;
  const list = prune(nuke.get(key) ?? [], ctx.config.get('nukeWindowSeconds') * 1000);
  list.push(Date.now());
  nuke.set(key, list);
  if (list.length < ctx.config.get('nukeThreshold')) return;
  nuke.delete(key);

  const action = ctx.config.get('nukeAction');
  let result = 'alert only';
  try {
    if (member && action === 'strip-roles') {
      const risky = member.roles.cache.filter((r) => !r.managed && r.id !== guild.id && DANGEROUS.some((p) => r.permissions.has(p)));
      await member.roles.remove(risky, 'Anti-nuke: mass destructive actions');
      result = `removed ${risky.size} dangerous role(s)`;
    } else if (action === 'ban') { await guild.members.ban(execId, { reason: 'Anti-nuke: mass destructive actions' }); result = 'banned'; }
  } catch (err) { result = `could not act (${err.message}) - check my role position`; }

  ctx.security(`Anti-nuke triggered by ${execId}: ${result}`);
  const embed = new EmbedBuilder().setColor(COLOR.alert).setTitle('🛡️ Anti-nuke triggered')
    .setDescription(`<@${execId}> performed **${list.length}** destructive actions within ${ctx.config.get('nukeWindowSeconds')}s.\nResponse: **${result}**.`).setTimestamp();
  await modLog(ctx, embed);
  const owner = await guild.fetchOwner().catch(() => null);
  await owner?.send({ embeds: [embed] }).catch(() => {});
}

// ------------------------------------------------------------------ message logging
async function onDelete(ctx, message) {
  if (!ctx.config.get('logMessages') || message.author?.bot) return;
  if (message.channelId === ctx.config.get('logChannel')) return;
  await modLog(ctx, new EmbedBuilder().setColor(COLOR.purge).setTitle('Message deleted')
    .setDescription(`In <#${message.channelId}>${message.author ? ` by <@${message.author.id}>` : ''}\n${message.content ? truncate(message.content, 1500) : '*content unavailable*'}`).setTimestamp());
}

async function onEdit(ctx, oldM, newM) {
  if (!ctx.config.get('logMessages') || newM.author?.bot || !oldM.content || !newM.content || oldM.content === newM.content) return;
  if (newM.channelId === ctx.config.get('logChannel')) return;
  await modLog(ctx, new EmbedBuilder().setColor(COLOR.info).setTitle('Message edited')
    .setDescription(`In <#${newM.channelId}> by <@${newM.author.id}> - [jump](${newM.url})`)
    .addFields({ name: 'Before', value: truncate(oldM.content, 1000) }, { name: 'After', value: truncate(newM.content, 1000) }).setTimestamp());
}

// ------------------------------------------------------------------ popups
// Warn / timeout / kick / ban / unban collect their details in a popup. Typing the details into the command still works
// (handy for quick use); anything missing is asked for. The popup submit re-checks the permission, because a popup
// can be opened by a command and submitted later.
const forms = formStore('modaction');
const FIELD = {
  reason: (value) => ({ id: 'reason', label: 'Reason (shown in the log and to the member)', style: TextInputStyle.Paragraph, required: true, max: 500, value }),
  duration: (value) => ({ id: 'duration', label: 'How long? e.g. 10m, 2h, 1d (max 28d)', style: TextInputStyle.Short, required: true, max: 10, value }),
  days: (value) => ({ id: 'days', label: 'Delete their messages from the last N days (0-7)', style: TextInputStyle.Short, required: false, max: 1, value: value ?? '0' }),
};
const TITLES = { warn: 'Warn a member', timeout: 'Time out a member', kick: 'Kick a member', ban: 'Ban a user', unban: 'Unban a user' };
const PERMS = { warn: 'moderation.warn', timeout: 'moderation.timeout', kick: 'moderation.kick', ban: 'moderation.ban', unban: 'moderation.ban' };

export function actionModal(token, action, fields) {
  return new ModalBuilder().setCustomId(`modq:${token}`).setTitle(TITLES[action]).addComponents(
    ...fields.map((f) => {
      const t = new TextInputBuilder().setCustomId(f.id).setLabel(f.label.slice(0, 45)).setStyle(f.style).setRequired(f.required).setMaxLength(f.max);
      if (f.value) t.setValue(String(f.value).slice(0, f.max));
      return new ActionRowBuilder().addComponents(t);
    }));
}
const askFor = (i, action, data, fields) => i.showModal(actionModal(forms.put({ action, by: i.user.id, ...data }), action, fields));

async function modPopupSubmit(ctx, i) {
  const form = forms.take(i.customId.split(':')[1], i.user.id);
  if (!ctx.perms.check(i.member, PERMS[form.action])) throw new UserError(`You need the \`${PERMS[form.action]}\` permission for that.`);
  const text = (id) => i.fields.fields?.has?.(id) || i.fields.getTextInputValue ? (i.fields.getTextInputValue(id) ?? '').trim() : '';
  const reason = text('reason');
  if (!reason) throw new UserError('Please give a reason - it goes in the log.');
  await i.deferReply();
  const user = await i.client.users.fetch(form.userId).catch(() => null);
  if (!user) throw new UserError('I can\'t find that user any more.');
  if (form.action === 'warn') return runWarn(ctx, i, user, reason);
  if (form.action === 'kick') return runKick(ctx, i, user, reason);
  if (form.action === 'unban') return runUnban(ctx, i, user.id, reason);
  if (form.action === 'timeout') return runTimeout(ctx, i, user, parseTimeoutInput(text('duration')), reason);
  if (form.action === 'ban') return runBan(ctx, i, user, reason, parseDays(text('days')));
}
function parseTimeoutInput(raw) {
  const ms = parseDuration(raw);
  if (!ms) throw new UserError('Use a duration like `10m`, `2h` or `1d`.');
  if (ms > MAX_TIMEOUT) throw new UserError('Discord limits timeouts to 28 days.');
  return ms;
}
function parseDays(raw) {
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 7) throw new UserError('Days of messages to delete must be a whole number from 0 to 7.');
  return n;
}


async function memberFor(i, user) {
  const member = await fetchTarget(i, user);
  if (!member) throw new UserError('That user is not in this server.');
  guardTarget(i, member);
  return member;
}

async function runWarn(ctx, i, user, reason, details = {}) {
  const member = await memberFor(i, user);
  const c = addCase(ctx, { type: 'warn', user, modId: i.user.id, reason, extra: details });
  await tellUser(ctx, user, i.guild, `you were warned: ${reason}`);
  await modLog(ctx, caseEmbed('warn', c, user, i.user.id));
  const warns = (ctx.data.get(`hist:${user.id}`) ?? []).filter((e) => e.type === 'warn').length;
  const threshold = ctx.config.get('warnTimeoutThreshold');
  let extra = '';
  if (threshold > 0 && warns % threshold === 0) {
    const mins = ctx.config.get('warnTimeoutMinutes');
    await doTimeout(ctx, member, mins * 60000, `Automatic: ${warns} warnings`, null).then(() => { extra = `\nReached ${warns} warnings - timed out for ${mins} minutes.`; }).catch(() => {});
  }
  await i.editReply({ embeds: [caseEmbed('warn', c, user, i.user.id).setFooter({ text: `${warns} warning(s) total` })], content: extra || undefined, allowedMentions: NOPING });
}

export const SEVERITY = {
  low: { label: '🟢 Low', desc: 'A friendly reminder' },
  medium: { label: '🟡 Medium', desc: 'A clear rule break' },
  high: { label: '🟠 High', desc: 'Serious, next step is a timeout' },
  critical: { label: '🔴 Critical', desc: 'Final warning before a ban' },
};

/** Checks that can run before the popup opens (a popup cannot be re-opened after a failed submit). */
async function warnTargetCheck(i, targetId) {
  if (!targetId) return null;
  if (targetId === i.user.id) throw new UserError('You cannot warn yourself.');
  const member = await i.guild.members.fetch(targetId).catch(() => null);
  if (!member) throw new UserError('That user is not in this server.');
  if (member.user?.bot) throw new UserError('Bots cannot be warned.');
  guardTarget(i, member);
  return member;
}

const modPipe = createPipeline({
  ns: 'mpm',
  forms: {
    warn: {
      title: 'Warn a member', permission: 'moderation.warn', color: COLOR.warn,
      button: { label: 'Configure warning', emoji: '⚠️', style: ButtonStyle.Danger },
      intro: (ctx, i, [target]) => `${target ? `Warning <@${target}>. ` : ''}Nothing is recorded until you submit the form.
The member is told the reason${ctx.config.get('dmOnAction') ? ' by DM' : ' (DMs are off in settings)'}.`,
      precheck: (ctx, i, [target]) => warnTargetCheck(i, target),
      fields: (ctx, i, [target]) => [
        ...(target ? [] : [{ id: 'user', kind: 'user', label: 'Member to warn' }]),
        { id: 'reason', kind: 'paragraph', label: 'Warning reason', desc: 'Shown in the log and to the member', max: 500 },
        { id: 'severity', kind: 'select', label: 'Severity', value: 'medium', options: Object.entries(SEVERITY).map(([value, v]) => ({ label: v.label, value, description: v.desc })) },
        { id: 'notes', kind: 'paragraph', label: 'Duration / severity notes', desc: 'Optional, staff only. e.g. "counts for 30 days"', required: false, max: 300 },
      ],
      async submit(ctx, i, v, [target]) {
        const targetId = target ?? v.user;
        if (!targetId) throw new UserError('Pick a member to warn.');
        if (!v.reason) throw new UserError('Please give a reason - it goes in the log.');
        await warnTargetCheck(i, targetId); // again at submit: roles may have changed while the form was open
        await i.deferReply();
        const user = await i.client.users.fetch(targetId).catch(() => null);
        if (!user) throw new UserError('I can\'t find that user any more.');
        return runWarn(ctx, i, user, v.reason, { severity: SEVERITY[v.severity] ? v.severity : 'medium', notes: v.notes || undefined });
      },
    },
  },
});

async function runTimeout(ctx, i, user, ms, reason) {
  const member = await memberFor(i, user);
  const c = await doTimeout(ctx, member, ms, reason, i.user.id);
  await tellUser(ctx, user, i.guild, `you were timed out for ${formatDuration(ms)}: ${reason}`);
  await i.editReply({ embeds: [caseEmbed('timeout', c, user, i.user.id).addFields({ name: 'Duration', value: formatDuration(ms), inline: true })], allowedMentions: NOPING });
}

async function runKick(ctx, i, user, reason) {
  const member = await memberFor(i, user);
  if (!member.kickable) throw new UserError("I can't kick that member - move my role above theirs.");
  await tellUser(ctx, user, i.guild, `you were kicked: ${reason}`);
  await member.kick(`${i.user.tag}: ${truncate(reason, 400)}`);
  const c = addCase(ctx, { type: 'kick', user, modId: i.user.id, reason });
  await modLog(ctx, caseEmbed('kick', c, user, i.user.id));
  await i.editReply({ embeds: [caseEmbed('kick', c, user, i.user.id)], allowedMentions: NOPING });
}

async function runBan(ctx, i, user, reason, days) {
  const member = await fetchTarget(i, user);
  if (member) { guardTarget(i, member); if (!member.bannable) throw new UserError("I can't ban that member - move my role above theirs."); }
  else if (user.id === i.guild.ownerId || user.id === i.user.id) throw new UserError("You can't do that.");
  await tellUser(ctx, user, i.guild, `you were banned: ${reason}`);
  await i.guild.members.ban(user.id, { reason: `${i.user.tag}: ${truncate(reason, 400)}`, deleteMessageSeconds: days * 86400 });
  const c = addCase(ctx, { type: 'ban', user, modId: i.user.id, reason });
  await modLog(ctx, caseEmbed('ban', c, user, i.user.id));
  await i.editReply({ embeds: [caseEmbed('ban', c, user, i.user.id)], allowedMentions: NOPING });
}

async function runUnban(ctx, i, id, reason) {
  await i.guild.bans.remove(id, `${i.user.tag}: ${truncate(reason, 400)}`).catch(() => { throw new UserError("That user isn't banned (or I can't unban them)."); });
  const c = addCase(ctx, { type: 'unban', user: { id, tag: id }, modId: i.user.id, reason });
  await modLog(ctx, caseEmbed('unban', c, { id, tag: id }, i.user.id));
  await i.editReply({ content: `Unbanned \`${id}\`.`, allowedMentions: NOPING });
}

// ------------------------------------------------------------------ commands
const userOpt = (o, d = 'The user') => o.setName('user').setDescription(d).setRequired(true);
const reasonOpt = (o) => o.setName('reason').setDescription('Reason - leave empty to type it in a popup').setMaxLength(500);

// ------------------------------------------------------------------ AutoMod: shared by /automod and the dashboard
const ACTION_WORDS = { default: 'server default', delete: 'delete only', 'delete-warn': 'delete + warn', 'delete-timeout': 'delete + timeout' };

const cap = (t) => String(t).charAt(0).toUpperCase() + String(t).slice(1);
function ruleRow(ctx, rule, counts) {
  const cfg = automodCfg(ctx);
  const on = ruleEnabled(cfg, rule);
  const own = cfg[rule.action] ?? 'default';
  const ex = ctx.data.get('automod:exempt') ?? {};
  const exNum = (ex[rule.id]?.roles?.length ?? 0) + (ex[rule.id]?.channels?.length ?? 0);
  return {
    id: rule.id, name: rule.label, on, state: on ? '● On' : '○ Off',
    action: own === 'default' ? `Server default (${ACTION_WORDS[cfg.automodAction] ?? cfg.automodAction})` : cap(ACTION_WORDS[own] ?? own), ownAction: own,
    limit: rule.limit ? cfg[rule.limit] : null, last7: counts[rule.id] ? `${counts[rule.id]} caught` : 'None', exemptions: exNum ? `${exNum} role${exNum === 1 ? '' : 's'}/channel${exNum === 1 ? '' : 's'}` : 'None',
  };
}

/** Switch a rule on or off, set its action and/or its threshold. Goes through the validated settings path, like /config. */
// ---- AutoMod page (2.3.2): presets, plain descriptions, units, a safe "test a message", list editing ----
export const RULE_INFO = {
  spam: { desc: 'Someone sends lots of messages in a few seconds.', unit: 'messages', min: 2, max: 30 },
  words: { desc: 'A message contains a word from your list.' },
  links: { desc: 'A message has a link to a site that is not on your allowed list, or a server invite.' },
  mentions: { desc: 'One message pings lots of people or roles at once.', unit: 'mentions', min: 0, max: 50 },
  repeat: { desc: 'Someone sends the same message again and again.', unit: 'repeats', min: 2, max: 20 },
  caps: { desc: 'A message is mostly CAPITAL LETTERS.', unit: '% capitals', min: 40, max: 100 },
  emoji: { desc: 'A message is stuffed with emoji.', unit: 'emoji', min: 2, max: 50 },
};
export const PRESETS = {
  off: { automodSpam: false, automodWords: false, automodLinks: false, maxMentions: 0, automodRepeat: false, automodCaps: false, automodEmoji: false, raidProtection: false, antiNuke: false, minAccountAgeDays: 0 },
  relaxed: { automodSpam: true, spamMaxMessages: 8, spamWindowSeconds: 6, automodWords: true, automodLinks: false, maxMentions: 10, automodRepeat: false, automodCaps: false, automodEmoji: false, raidProtection: true, raidAction: 'alert', antiNuke: true, minAccountAgeDays: 0 },
  balanced: { automodSpam: true, spamMaxMessages: 5, spamWindowSeconds: 6, automodWords: true, automodLinks: true, maxMentions: 6, automodRepeat: true, repeatMax: 3, repeatWindowSeconds: 60, automodCaps: false, automodEmoji: true, emojiMax: 12, raidProtection: true, raidAction: 'alert', antiNuke: true, minAccountAgeDays: 0 },
  strict: { automodSpam: true, spamMaxMessages: 4, spamWindowSeconds: 6, automodWords: true, automodLinks: true, maxMentions: 4, automodRepeat: true, repeatMax: 2, repeatWindowSeconds: 60, automodCaps: true, capsPercent: 70, automodEmoji: true, emojiMax: 8, raidProtection: true, raidAction: 'timeout', antiNuke: true, minAccountAgeDays: 3, newAccountAction: 'alert' },
};
const PAGE_KEYS = new Set(['automodAction', 'spamWindowSeconds', 'repeatWindowSeconds', 'raidProtection', 'raidJoinThreshold', 'raidWindowSeconds', 'raidAction', 'minAccountAgeDays', 'newAccountAction', 'antiNuke', 'nukeAction', 'automodTimeoutMinutes']);
export function currentPreset(ctx) {
  for (const [name, p] of Object.entries(PRESETS)) if (Object.entries(p).every(([k, v]) => ctx.config.get(k) === v)) return name;
  return 'custom';
}
/** Which rules a message would break, checked one by one, without deleting or recording anything. */
export function testMessage(ctx, text) {
  const cfg = automodCfg(ctx);
  const out = [];
  const add = (id, hit, why) => { const rule = ruleById(id); out.push({ id, label: rule.label, on: ruleEnabled(cfg, rule), hit, why }); };
  const re = wordRegex(ctx.config.get('bannedWords') ?? []);
  const word = re ? (String(text).match(re) ?? [])[0] : null;
  add('words', !!word, word ? `contains "${word}"` : 'no blocked words');
  const allowed = ctx.config.get('allowedDomains') ?? [];
  const bad = [...String(text).matchAll(/\b(?:https?:\/\/|www\.)([^\s/?#<>]+)/gi)].map((m) => m[1]).find((d) => !domainAllowed(d, allowed));
  const invite = /\b(?:discord\.gg|discord(?:app)?\.com\/invite)\/\w+/i.test(text) && !domainAllowed('discord.gg', allowed);
  add('links', !!(bad || invite), bad ? `link to ${bad}` : invite ? 'a server invite' : 'no blocked links');
  const pings = (String(text).match(/<@[!&]?\d+>|@everyone|@here/g) ?? []).length;
  add('mentions', cfg.maxMentions > 0 && pings >= cfg.maxMentions, `${pings} mention${pings === 1 ? '' : 's'} (limit ${cfg.maxMentions || 'off'})`);
  const caps = capsRatio(text, { minLetters: cfg.capsMinLetters });
  add('caps', caps >= cfg.capsPercent, `${Math.round(caps)}% capitals (limit ${cfg.capsPercent}%)`);
  const em = countEmoji(text);
  add('emoji', em > cfg.emojiMax, `${em} emoji (limit ${cfg.emojiMax})`);
  return out;
}

function applyRule(ctx, ruleId, { enabled, action, limit } = {}) {
  const rule = ruleById(ruleId);
  if (!rule) throw new UserError(`Unknown rule. Choose one of: ${RULE_IDS.join(', ')}.`);
  if (action !== undefined && action !== null) {
    if (!ACTIONS.includes(action)) throw new UserError(`The action must be one of: ${ACTIONS.join(', ')}.`);
    ctx.settings.set(rule.action, action);
  }
  if (limit !== undefined && limit !== null) {
    if (!rule.limit) throw new UserError(`The ${rule.label.toLowerCase()} rule has no number to set.`);
    ctx.settings.set(rule.limit, limit);
  }
  if (enabled !== undefined && enabled !== null) {
    if (rule.on) ctx.settings.set(rule.on, enabled);
    else if (!enabled) ctx.settings.set(rule.limit, 0);
    else if (!(Number(ctx.config.get(rule.limit)) > 0)) ctx.settings.set(rule.limit, 6);
  }
  return ruleRow(ctx, rule, activityCounts(ctx.data.get('automod:recent') ?? [], Date.now()));
}

function exemptionLines(ctx) {
  const ex = ctx.data.get('automod:exempt') ?? {};
  const lines = [];
  for (const key of ['all', ...RULE_IDS]) {
    const s = ex[key]; if (!s) continue;
    const bits = [...(s.roles ?? []).map((r) => `<@&${r}>`), ...(s.channels ?? []).map((c) => `<#${c}>`)];
    if (bits.length) lines.push(`**${key === 'all' ? 'Every rule' : ruleById(key).label}:** ${bits.join(' ')}`);
  }
  return lines;
}

const when = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
const RULE_CHOICES = RULES.map((r) => ({ name: r.label.slice(0, 100), value: r.id }));
const ACTION_CHOICES = ACTIONS.map((a) => ({ name: ACTION_WORDS[a], value: a }));
const automodNeed = (ctx, i, key) => { if (!ctx.perms.check(i.member, key)) throw new UserError(`You don't have permission for that (\`${key}\`).`); };

const automodCommand = {
  permission: 'moderation.history',
  data: new SlashCommandBuilder().setName('automod').setDescription('See and change AutoMod: rules, actions, exemptions')
    .addSubcommand((s) => s.setName('status').setDescription('Every rule: on or off, its action, and how often it fired this week'))
    .addSubcommand((s) => s.setName('rule').setDescription('Turn a rule on or off, or change its action or number')
      .addStringOption((o) => o.setName('rule').setDescription('Which rule').setRequired(true).addChoices(...RULE_CHOICES))
      .addBooleanOption((o) => o.setName('enabled').setDescription('On or off'))
      .addStringOption((o) => o.setName('action').setDescription('What happens when it triggers').addChoices(...ACTION_CHOICES))
      .addIntegerOption((o) => o.setName('limit').setDescription('The rule\'s number (messages, mentions, percent, emoji...)').setMinValue(0).setMaxValue(1000)))
    .addSubcommand((s) => s.setName('exempt').setDescription('Roles and channels AutoMod should ignore')
      .addStringOption((o) => o.setName('what').setDescription('Add, remove or list').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }))
      .addStringOption((o) => o.setName('rule').setDescription('One rule, or every rule (default)').addChoices({ name: 'every rule', value: 'all' }, ...RULE_CHOICES))
      .addRoleOption((o) => o.setName('role').setDescription('A role to ignore'))
      .addChannelOption((o) => o.setName('channel').setDescription('A channel or category to ignore')))
    .addSubcommand((s) => s.setName('recent').setDescription('The latest things AutoMod removed')
      .addIntegerOption((o) => o.setName('count').setDescription('How many (default 10)').setMinValue(1).setMaxValue(25)))
    .addSubcommand((s) => s.setName('word').setDescription('Banned words')
      .addStringOption((o) => o.setName('what').setDescription('Add, remove or list').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }))
      .addStringOption((o) => o.setName('word').setDescription('The word or phrase')))
    .addSubcommand((s) => s.setName('domain').setDescription('Link domains that are always allowed')
      .addStringOption((o) => o.setName('what').setDescription('Add, remove or list').setRequired(true).addChoices({ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }))
      .addStringOption((o) => o.setName('domain').setDescription('For example youtube.com'))),
  async execute(ctx, i) {
    const sub = i.options.getSubcommand();
    const reply = (content) => i.reply({ content, flags: EPH, allowedMentions: NOPING });
    if (sub === 'status') {
      const counts = activityCounts(ctx.data.get('automod:recent') ?? [], Date.now());
      const lines = RULES.map((r) => { const x = ruleRow(ctx, r, counts); return `${x.on ? '🟢' : '⚫'} **${r.label}**${x.limit ? ` · limit ${x.limit}` : ''}\n   ${x.action}${x.exemptions ? ` · ${x.exemptions} exemption(s)` : ''} · ${x.last7} this week`; });
      const ex = exemptionLines(ctx);
      const e = new EmbedBuilder().setColor(COLOR.automod).setTitle('AutoMod').setDescription(lines.join('\n')).setFooter({ text: 'Change a rule with /automod rule. Staff with the bypass permission are never checked.' });
      if (ex.length) e.addFields({ name: 'Ignored', value: truncate(ex.join('\n'), 1000) });
      return i.reply({ embeds: [e], flags: EPH, allowedMentions: NOPING });
    }
    if (sub === 'recent') {
      const n = i.options.getInteger('count') ?? 10;
      const rows = (ctx.data.get('automod:recent') ?? []).slice(0, n);
      if (!rows.length) return reply('AutoMod has not removed anything yet.');
      return reply(rows.map((e) => `\`${when(e.at)}\` <@${e.userId}> in <#${e.channelId}> · **${e.name}** · ${ACTION_WORDS[e.action] ?? e.action}${e.caseId ? ` · case #${e.caseId}` : ''}${e.snippet ? `\n   > ${e.snippet}` : ''}`).join('\n'));
    }
    if (sub === 'word' || sub === 'domain') {
      const key = sub === 'word' ? 'bannedWords' : 'allowedDomains';
      const what = i.options.getString('what', true);
      if (what !== 'list') {
        automodNeed(ctx, i, 'moderation.automod');
        let v = (i.options.getString(sub) ?? '').trim();
        if (sub === 'domain') v = v.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[/?#].*$/, '').toLowerCase();
        if (!v) throw new UserError(`Say which ${sub}.`);
        ctx.settings.set(key, v, what);
        return reply(`${what === 'add' ? 'Added' : 'Removed'} **${truncate(v, 80)}**.`);
      }
      const list = ctx.config.get(key) ?? [];
      return reply(list.length ? `**${sub === 'word' ? 'Banned words' : 'Allowed domains'}** (${list.length}): ${truncate(list.join(', '), 1700)}` : 'The list is empty.');
    }
    if (sub === 'rule') {
      automodNeed(ctx, i, 'moderation.automod');
      const row = applyRule(ctx, i.options.getString('rule', true), { enabled: i.options.getBoolean('enabled'), action: i.options.getString('action'), limit: i.options.getInteger('limit') });
      return reply(`**${row.name}** is now ${row.on ? 'on' : 'off'} · ${row.action}${row.limit ? ` · limit ${row.limit}` : ''}.`);
    }
    // exempt
    const what = i.options.getString('what', true);
    if (what === 'list') { const ex = exemptionLines(ctx); return reply(ex.length ? ex.join('\n') : 'Nothing is exempt. (Members with the bypass permission are always ignored.)'); }
    automodNeed(ctx, i, 'moderation.automod');
    const role = i.options.getRole('role'), channel = i.options.getChannel('channel');
    if (!role && !channel) throw new UserError('Pick a role or a channel.');
    const rule = i.options.getString('rule') ?? 'all';
    let ex = ctx.data.get('automod:exempt') ?? {}, changed = false;
    for (const [kind, thing] of [['roles', role], ['channels', channel]]) {
      if (!thing) continue;
      const r = editExempt(ex, rule, kind, thing.id, what === 'add'); ex = r.ex; changed ||= r.changed;
    }
    ctx.data.set('automod:exempt', ex);
    const label = rule === 'all' ? 'every rule' : ruleById(rule).label;
    return reply(changed ? `${what === 'add' ? 'Now ignoring' : 'No longer ignoring'} ${[role && `<@&${role.id}>`, channel && `<#${channel.id}>`].filter(Boolean).join(' and ')} for **${label}**.` : 'Nothing changed - it was already that way.');
  },
};

// ---- /logs (2.3.3): set log channels and what gets logged with one command
const LOG_EVENTS = [['message_edits', 'logMessages', 'Message edits and deletes'], ['joins', 'logJoins', 'Members joining and leaving'], ['roles', 'logRoles', 'Role changes'], ['nicknames', 'logNicknames', 'Nickname changes'], ['voice', 'logVoice', 'Voice joins, leaves and moves']];
export function logsStatus(ctx) {
  const ch = (id) => (id ? `<#${id}>` : '*not set*');
  const mod = ctx.config.get('logChannel'), server = ctx.config.get('serverLogChannel');
  return [
    `**Mod log** (warnings, timeouts, kicks, bans, AutoMod): ${ch(mod)}`,
    `**Server log** (the events below): ${server ? ch(server) : mod ? `${ch(mod)} (same as the mod log)` : '*not set*'}`,
    '',
    ...LOG_EVENTS.map(([, key, label]) => `${ctx.config.get(key) ? '✅' : '▫️'} ${label}`),
    '',
    'Ticket transcripts have their own channel: `/ticket setup`.',
  ].join('\n');
}
async function logsCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  if (sub === 'off') {
    const which = i.options.getString('which', true);
    if (which === 'mod' || which === 'all') ctx.settings.set('logChannel', null);
    if (which === 'server' || which === 'all') { ctx.settings.set('serverLogChannel', null); for (const [, key] of LOG_EVENTS.slice(1)) ctx.settings.set(key, false); }
    return i.reply({ content: `Logging turned off for: **${which === 'all' ? 'everything' : which === 'mod' ? 'the mod log' : 'the server log'}**.\n\n${logsStatus(ctx)}`, flags: EPH, allowedMentions: NOPING });
  }
  const mod = i.options.getChannel('mod_channel'), server = i.options.getChannel('server_channel');
  const changed = [];
  if (mod) { ctx.settings.set('logChannel', mod.id); changed.push('mod log channel'); }
  if (server) { ctx.settings.set('serverLogChannel', server.id); changed.push('server log channel'); }
  for (const [opt, key, label] of LOG_EVENTS) {
    const v = i.options.getBoolean(opt);
    if (v !== null && v !== undefined) { ctx.settings.set(key, v); changed.push(`${label.toLowerCase()} ${v ? 'on' : 'off'}`); }
  }
  // Turning an event on with nowhere to send it: say so instead of silently logging nothing.
  const anyOn = LOG_EVENTS.slice(1).some(([, key]) => ctx.config.get(key));
  const warn = anyOn && !ctx.config.get('serverLogChannel') && !ctx.config.get('logChannel') ? '\n\n⚠️ Pick a channel (`server_channel` or `mod_channel`) or nothing will be logged.' : '';
  return i.reply({ content: `${changed.length ? `✅ Saved: ${changed.join(', ')}.\n\n` : ''}${logsStatus(ctx)}${warn}`, flags: EPH, allowedMentions: NOPING });
}

const commands = [
  {
    permission: 'moderation.logs',
    ownPopup: true,
    data: new SlashCommandBuilder().setName('logs').setDescription('(Admins) Choose log channels and what gets logged')
      .addSubcommand((s) => {
        s.setName('setup').setDescription('Set log channels and turn events on or off (empty = show the current setup)')
          .addChannelOption((o) => o.setName('mod_channel').setDescription('Warnings, timeouts, kicks, bans and AutoMod').addChannelTypes(ChannelType.GuildText))
          .addChannelOption((o) => o.setName('server_channel').setDescription('Joins, leaves, roles, nicknames, voice (empty = the mod log)').addChannelTypes(ChannelType.GuildText));
        for (const [opt, , label] of LOG_EVENTS) s.addBooleanOption((o) => o.setName(opt).setDescription(`Log ${label.toLowerCase()}`));
        return s;
      })
      .addSubcommand((s) => s.setName('off').setDescription('Stop logging')
        .addStringOption((o) => o.setName('which').setDescription('Which log').setRequired(true).addChoices({ name: 'Mod log', value: 'mod' }, { name: 'Server log', value: 'server' }, { name: 'Everything', value: 'all' }))),
    execute: logsCmd,
  },
  {
    // 2.2: no typed options. The command only serves the private "Configure warning" button (src/modalpipe.js).
    permission: 'moderation.warn',
    data: new SlashCommandBuilder().setName('warn').setDescription('Warn a member (opens a form)'),
    execute: (ctx, i) => modPipe.launch(ctx, i, 'warn'),
  },
  {
    // Right-click a member > Apps > Warn member: the target travels in the signed button token.
    permission: 'moderation.warn',
    data: new ContextMenuCommandBuilder().setName('Warn member').setType(ApplicationCommandType.User),
    execute: (ctx, i) => modPipe.launch(ctx, i, 'warn', [i.targetUser.id]),
  },
  {
    permission: 'moderation.timeout',
    data: new SlashCommandBuilder().setName('timeout').setDescription('Time out a member')
      .addUserOption((o) => userOpt(o, 'Who to time out'))
      .addStringOption((o) => o.setName('duration').setDescription('e.g. 10m, 2h, 1d (max 28d) - leave empty to use a popup'))
      .addStringOption(reasonOpt),
    async execute(ctx, i) {
      const user = i.options.getUser('user', true);
      const dur = i.options.getString('duration');
      const reason = i.options.getString('reason');
      if (!dur || !reason) return askFor(i, 'timeout', { userId: user.id }, [FIELD.duration(dur), FIELD.reason(reason)]);
      const ms = parseTimeoutInput(dur);
      await i.deferReply();
      return runTimeout(ctx, i, user, ms, reason);
    },
  },
  {
    permission: 'moderation.timeout',
    data: new SlashCommandBuilder().setName('untimeout').setDescription('Remove a member\'s timeout').addUserOption((o) => userOpt(o)),
    async execute(ctx, i) {
      await i.deferReply();
      const user = i.options.getUser('user', true);
      const member = await memberFor(i, user);
      await member.timeout(null, `Removed by ${i.user.tag}`);
      const c = addCase(ctx, { type: 'untimeout', user, modId: i.user.id, reason: 'Timeout removed' });
      await modLog(ctx, caseEmbed('untimeout', c, user, i.user.id));
      await i.editReply({ content: `Timeout removed for **${truncate(user.tag, 40)}**.`, allowedMentions: NOPING });
    },
  },
  {
    permission: 'moderation.kick',
    data: new SlashCommandBuilder().setName('kick').setDescription('Kick a member').addUserOption((o) => userOpt(o, 'Who to kick')).addStringOption(reasonOpt),
    async execute(ctx, i) {
      const user = i.options.getUser('user', true);
      const reason = i.options.getString('reason');
      if (!reason) return askFor(i, 'kick', { userId: user.id }, [FIELD.reason()]);
      await i.deferReply();
      return runKick(ctx, i, user, reason);
    },
  },
  {
    permission: 'moderation.ban',
    data: new SlashCommandBuilder().setName('ban').setDescription('Ban a user')
      .addUserOption((o) => userOpt(o, 'Who to ban')).addStringOption(reasonOpt)
      .addIntegerOption((o) => o.setName('delete_days').setDescription('Also delete their messages from the last N days (0-7)').setMinValue(0).setMaxValue(7)),
    async execute(ctx, i) {
      const user = i.options.getUser('user', true);
      const reason = i.options.getString('reason');
      const days = i.options.getInteger('delete_days');
      if (!reason) return askFor(i, 'ban', { userId: user.id }, [FIELD.reason(), FIELD.days(days)]);
      await i.deferReply();
      return runBan(ctx, i, user, reason, days ?? 0);
    },
  },
  {
    permission: 'moderation.ban',
    data: new SlashCommandBuilder().setName('unban').setDescription('Unban a user by ID')
      .addStringOption((o) => o.setName('user_id').setDescription('The user\'s ID').setRequired(true)).addStringOption(reasonOpt),
    async execute(ctx, i) {
      const id = i.options.getString('user_id', true).trim();
      if (!SNOWFLAKE.test(id)) throw new UserError('That is not a valid user ID.');
      const reason = i.options.getString('reason');
      if (!reason) return askFor(i, 'unban', { userId: id }, [FIELD.reason()]);
      await i.deferReply();
      return runUnban(ctx, i, id, reason);
    },
  },
  {
    permission: 'moderation.purge',
    data: new SlashCommandBuilder().setName('purge').setDescription('Delete messages in this channel: a number, one member\'s, or everything')
      .addIntegerOption((o) => o.setName('amount').setDescription('How many (empty = all of them)').setMinValue(1).setMaxValue(100000))
      .addUserOption((o) => o.setName('user').setDescription('Only this member\'s messages'))
      .addStringOption((o) => o.setName('method').setDescription('How').addChoices({ name: 'Delete the messages (keeps the channel)', value: 'delete' }, { name: 'Recreate the channel: everything gone at once', value: 'recreate' }))
      .addBooleanOption((o) => o.setName('keep_pinned').setDescription('Keep pinned messages (default yes)')),
    execute: purgeCmd,
  },
  {
    permission: 'moderation.history',
    data: new SlashCommandBuilder().setName('modhistory').setDescription('See a user\'s moderation history').addUserOption((o) => userOpt(o)),
    async execute(ctx, i) {
      const user = i.options.getUser('user', true);
      const hist = ctx.data.get(`hist:${user.id}`) ?? [];
      if (!hist.length) return i.reply({ content: `No history for **${truncate(user.tag, 40)}**.`, flags: EPH, allowedMentions: NOPING });
      const lines = hist.slice(0, 12).map((e) => `**#${e.id}** ${e.type} - ${truncate(e.reason, 80)} (${ts(e.at)}${e.modId ? `, <@${e.modId}>` : ', AutoMod'})`);
      const e = new EmbedBuilder().setColor(COLOR.info).setTitle(`History for ${truncate(user.tag, 40)}`).setDescription(lines.join('\n'))
        .setFooter({ text: `${hist.length} total entries` });
      await i.reply({ embeds: [e], flags: EPH, allowedMentions: NOPING });
    },
  },
  automodCommand,
];

export default {
  name: 'moderation',
  version: '1.3.0',
  description: 'Warn, timeout, kick, ban, purge, history, AutoMod (spam, words, links, mentions, repeats, caps, emoji), raid protection and anti-nuke.',
  settings: [
    { key: 'logChannel', type: 'channel', label: 'Mod log channel' },
    { key: 'dmOnAction', type: 'toggle', label: 'DM users when action is taken', default: true },
    { key: 'logMessages', type: 'toggle', label: 'Log message edits & deletes', default: true },
    { key: 'serverLogChannel', type: 'channel', label: 'Server log channel for joins, roles, nicknames, voice (empty = the mod log)' },
    { key: 'logJoins', type: 'toggle', label: 'Log members joining and leaving', default: false },
    { key: 'logRoles', type: 'toggle', label: 'Log role changes', default: false },
    { key: 'logNicknames', type: 'toggle', label: 'Log nickname changes', default: false },
    { key: 'logVoice', type: 'toggle', label: 'Log voice joins, leaves and moves', default: false },
    { key: 'warnTimeoutThreshold', type: 'number', label: 'Auto-timeout every N warnings (0 = off)', default: 3, min: 0, max: 20 },
    { key: 'warnTimeoutMinutes', type: 'number', label: 'Auto-timeout length (minutes)', default: 60, min: 1, max: 40320 },
    { key: 'automodAction', type: 'select', label: 'AutoMod action', options: ['delete', 'delete-warn', 'delete-timeout'], default: 'delete-warn' },
    { key: 'automodTimeoutMinutes', type: 'number', label: 'AutoMod timeout (minutes)', default: 5, min: 1, max: 1440 },
    { key: 'automodSpam', type: 'toggle', label: 'Spam protection', default: false },
    { key: 'spamMaxMessages', type: 'number', label: 'Spam: messages allowed...', default: 5, min: 2, max: 30 },
    { key: 'spamWindowSeconds', type: 'number', label: '...within N seconds', default: 6, min: 2, max: 60 },
    { key: 'automodWords', type: 'toggle', label: 'Word filter', default: false },
    { key: 'bannedWords', type: 'list', label: 'Banned words' },
    { key: 'automodLinks', type: 'toggle', label: 'Link & invite filter', default: false },
    { key: 'allowedDomains', type: 'list', label: 'Allowed link domains' },
    { key: 'maxMentions', type: 'number', label: 'Max mentions per message (0 = off)', default: 6, min: 0, max: 50 },
    { key: 'automodRepeat', type: 'toggle', label: 'Repeated-message filter', default: false },
    { key: 'repeatMax', type: 'number', label: 'Repeats: identical messages allowed...', default: 3, min: 2, max: 20 },
    { key: 'repeatWindowSeconds', type: 'number', label: '...within N seconds', default: 60, min: 5, max: 600 },
    { key: 'automodCaps', type: 'toggle', label: 'Capital-letters filter', default: false },
    { key: 'capsPercent', type: 'number', label: 'Caps: percent of letters in capitals', default: 70, min: 40, max: 100 },
    { key: 'capsMinLetters', type: 'number', label: 'Caps: ignore messages with fewer letters than', default: 12, min: 5, max: 100 },
    { key: 'automodEmoji', type: 'toggle', label: 'Emoji filter', default: false },
    { key: 'emojiMax', type: 'number', label: 'Emoji: most allowed in one message', default: 10, min: 2, max: 50 },
    ...RULES.map((r) => ({ key: r.action, type: 'select', label: `${r.label}: action`, options: ACTIONS, default: 'default' })),
    { key: 'automodKeepSnippets', type: 'toggle', label: 'Keep a short preview of removed messages in the AutoMod activity list', default: true },
    { key: 'raidProtection', type: 'toggle', label: 'Raid protection', default: false },
    { key: 'raidJoinThreshold', type: 'number', label: 'Raid: joins...', default: 8, min: 3, max: 100 },
    { key: 'raidWindowSeconds', type: 'number', label: '...within N seconds', default: 10, min: 3, max: 120 },
    { key: 'raidAction', type: 'select', label: 'Raid action', options: ['alert', 'timeout', 'kick'], default: 'alert' },
    { key: 'minAccountAgeDays', type: 'number', label: 'Flag accounts younger than N days (0 = off)', default: 0, min: 0, max: 365 },
    { key: 'newAccountAction', type: 'select', label: 'Young account action', options: ['alert', 'kick'], default: 'alert' },
    { key: 'antiNuke', type: 'toggle', label: 'Anti-nuke', default: false },
    { key: 'nukeThreshold', type: 'number', label: 'Anti-nuke: destructive actions...', default: 3, min: 2, max: 20 },
    { key: 'nukeWindowSeconds', type: 'number', label: '...within N seconds', default: 30, min: 5, max: 300 },
    { key: 'nukeAction', type: 'select', label: 'Anti-nuke response', options: ['strip-roles', 'ban', 'alert'], default: 'strip-roles' },
  ],
  permissions: [
    { key: 'moderation.warn', label: 'Warn members', default: 'moderator', discordPerm: 'ModerateMembers' },
    { key: 'moderation.timeout', label: 'Time out members', default: 'moderator', discordPerm: 'ModerateMembers' },
    { key: 'moderation.kick', label: 'Kick members', default: 'moderator', discordPerm: 'KickMembers' },
    { key: 'moderation.ban', label: 'Ban / unban', default: 'moderator', discordPerm: 'BanMembers' },
    { key: 'moderation.purge', label: 'Bulk delete messages', default: 'moderator', discordPerm: 'ManageMessages' },
    { key: 'moderation.history', label: 'View moderation history', default: 'moderator' },
    { key: 'moderation.automod', label: 'Change AutoMod rules and exemptions', default: 'admin' },
    { key: 'moderation.bypass', label: 'Ignored by AutoMod', default: 'moderator' },
    { key: 'moderation.logs', label: 'Choose log channels with /logs', default: 'admin' },
    { key: 'moderation.antinuke-immune', label: 'Trusted: not watched by anti-nuke (owner always is)', default: 'owner' },
  ],
  views: {
    async automodpage(ctx) {
      const recent = ctx.data.get('automod:recent') ?? [];
      const counts = activityCounts(recent, Date.now());
      const cfg = automodCfg(ctx);
      const name = (id, map) => map?.cache?.get(id)?.name ?? id;
      return {
        preset: currentPreset(ctx), defaultAction: ctx.config.get('automodAction'),
        rules: RULES.map((r) => ({ id: r.id, label: r.label, ...RULE_INFO[r.id], on: ruleEnabled(cfg, r), limit: r.limit ? cfg[r.limit] : null, action: cfg[r.action] || 'default', caught: counts[r.id] ?? 0 })),
        spamWindow: ctx.config.get('spamWindowSeconds'), repeatWindow: ctx.config.get('repeatWindowSeconds'),
        protect: { raidProtection: ctx.config.get('raidProtection'), raidJoinThreshold: ctx.config.get('raidJoinThreshold'), raidWindowSeconds: ctx.config.get('raidWindowSeconds'), raidAction: ctx.config.get('raidAction'),
          minAccountAgeDays: ctx.config.get('minAccountAgeDays'), newAccountAction: ctx.config.get('newAccountAction'), antiNuke: ctx.config.get('antiNuke'), nukeAction: ctx.config.get('nukeAction') },
        words: ctx.config.get('bannedWords') ?? [], domains: ctx.config.get('allowedDomains') ?? [],
        exemptions: exemptionLines(ctx).map((l) => l.replace(/<@&(\d+)>/g, (_, id) => `@${name(id, ctx.guild?.roles)}`).replace(/<#(\d+)>/g, (_, id) => `#${name(id, ctx.guild?.channels)}`).replace(/\*\*/g, '')),
        recent: recent.slice(0, 30).map((e) => ({ when: when(e.at), member: e.tag, channel: `#${name(e.channelId, ctx.guild?.channels)}`, rule: e.name, action: ACTION_WORDS[e.action] ?? e.action, preview: e.snippet ?? '' })),
      };
    },
    async automod(ctx) {
      const recent = ctx.data.get('automod:recent') ?? [];
      const counts = activityCounts(recent, Date.now());
      return {
        rows: RULES.map((r) => ruleRow(ctx, r, counts)),
        exemptions: exemptionLines(ctx).map((l) => ({ line: l.replace(/<@&(\d+)>/g, (_, id) => `@${ctx.guild?.roles.cache.get(id)?.name ?? id}`).replace(/<#(\d+)>/g, (_, id) => `#${ctx.guild?.channels.cache.get(id)?.name ?? id}`).replace(/\*\*/g, '') })),
        recent: recent.slice(0, 25).map((e) => ({ when: when(e.at), member: e.tag, channel: `#${ctx.guild?.channels.cache.get(e.channelId)?.name ?? e.channelId}`, rule: e.name, action: ACTION_WORDS[e.action] ?? e.action, preview: e.snippet ?? '' })),
      };
    },
  },
  actions: {
    async 'automod-preset'(ctx, body) {
      const p = PRESETS[String(body.preset ?? body.value)];
      if (!p) throw new UserError('Choose Off, Relaxed, Balanced or Strict.');
      for (const [k, v] of Object.entries(p)) ctx.settings.set(k, v);
      return { preset: String(body.preset ?? body.value) };
    },
    async 'automod-rule'(ctx, body) {
      const rule = ruleById(String(body.rule));
      if (!rule) throw new UserError('Unknown rule.');
      return applyRule(ctx, rule.id, { enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined, action: body.action ?? undefined, limit: body.limit ?? undefined });
    },
    async 'automod-set'(ctx, body) {
      if (!PAGE_KEYS.has(String(body.key))) throw new UserError('That setting is not on this page.');
      ctx.settings.set(String(body.key), body.value);
      return { ok: true };
    },
    async 'automod-list'(ctx, body) {
      const key = body.list === 'domains' ? 'allowedDomains' : body.list === 'words' ? 'bannedWords' : null;
      if (!key) throw new UserError('Unknown list.');
      const value = String(body.value ?? '').trim().toLowerCase().slice(0, 100);
      if (!value) throw new UserError('Type something to add.');
      ctx.settings.set(key, value, body.op === 'remove' ? 'remove' : 'add');
      return { list: ctx.config.get(key) ?? [] };
    },
    async 'automod-test'(ctx, body) {
      const text = String(body.text ?? '').slice(0, 2000);
      if (!text.trim()) throw new UserError('Type a message to test.');
      return { results: testMessage(ctx, text) };
    },
    async 'automod-toggle'(ctx, body) {
      const rule = ruleById(String(body.id ?? body.userId));
      if (!rule) throw new UserError('Unknown rule.');
      return applyRule(ctx, rule.id, { enabled: !ruleEnabled(automodCfg(ctx), rule) });
    },
    async 'automod-action'(ctx, body) {
      const rule = ruleById(String(body.id ?? body.userId));
      if (!rule) throw new UserError('Unknown rule.');
      return applyRule(ctx, rule.id, { action: String(body.value ?? '').trim().toLowerCase() });
    },
  },
  panels: [{
    id: 'automod', title: 'AutoMod', view: 'automod', permission: 'moderation.automod', page: 'automod',
    pageViews: ['automodpage'], pageActions: ['automod-preset', 'automod-rule', 'automod-set', 'automod-list', 'automod-test'],
    description: 'Rules that check every message. Turn a rule on, then choose what happens when someone breaks it.',
    empty: 'No AutoMod rules are available.',
    columns: [{ key: 'name', label: 'Rule' }, { key: 'state', label: 'State' },
      { key: 'action', label: 'What happens', hint: 'What the bot does to a message that breaks the rule. "Server default" follows the AutoMod action setting.' },
      { key: 'limit', label: 'Limit', hint: 'How much is allowed before the rule acts, e.g. messages in a few seconds or mentions in one message. "—" means the rule has no limit.' },
      { key: 'last7', label: 'This week', hint: 'Messages this rule caught in the last 7 days.' },
      { key: 'exemptions', label: 'Exemptions', hint: 'Roles and channels this rule ignores. Set them with /automod exempt.' }],
    rowActions: [
      { action: 'automod-toggle', label: 'Turn on/off', confirm: 'Switch this rule on or off?', danger: false, done: 'Rule updated' },
      { action: 'automod-action', label: 'Set action', prompt: 'select', field: 'value', current: 'ownAction', hint: 'What should happen to a message that breaks this rule?',
        options: [{ value: 'default', label: 'Server default' }, { value: 'delete', label: 'Delete it' }, { value: 'delete-warn', label: 'Delete + warn the member' }, { value: 'delete-timeout', label: 'Delete + time the member out' }], done: 'Action saved' },
    ],
    recentTitle: 'Recently caught',
    recentEmpty: 'Nothing has been caught yet. When a rule removes a message it shows up here.',
    recentColumns: [{ key: 'when', label: 'When' }, { key: 'member', label: 'Member' }, { key: 'channel', label: 'Channel' }, { key: 'rule', label: 'Rule' }, { key: 'action', label: 'What happened' }, { key: 'preview', label: 'Message' }],
  }],
  commands,
  components: [{ prefix: 'modq:', execute: modPopupSubmit }, { prefix: 'mpurge:', execute: purgeClick }, modPipe.component],
  events: {
    messageCreate: onMessage,
    messageDelete: onDelete,
    messageUpdate: onEdit,
    guildMemberAdd: async (ctx, m) => { await onJoin(ctx, m); await logJoin(ctx, m); },
    guildMemberRemove: logLeave,
    guildMemberUpdate: logMemberUpdate,
    voiceStateUpdate: logVoice,
    guildAuditLogEntryCreate: onAudit,
  },
  tasks: [{
    name: 'cleanup', everyMs: 60000,
    async run() {
      const now = Date.now();
      for (const [k, v] of spam) if (!prune(v, 120000, now).length) spam.delete(k);
      for (const [k, v] of repeats) if (!prune(v, 300000, now).length) repeats.delete(k);
      for (const [k, v] of joins) if (!prune(v, 300000, now).length) joins.delete(k);
      for (const [k, v] of nuke) if (!prune(v, 600000, now).length) nuke.delete(k);
    },
  }],
};
