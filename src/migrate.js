/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * /migrate (2.3): move from other bots to Good Boy without setting everything up again.
 *
 * Other bots keep their settings on their own servers and none of them let another bot read them. So Good Boy looks
 * at what they left behind in this server, which Discord does let it read:
 *
 *   reaction-role messages   messages from the old bot with reactions, where the text pairs each emoji with a role
 *   log channels             where the old bot posts "Message deleted", "Member joined", "Roles updated"... boxes
 *   starboard                the channel where the old bot reposts starred messages
 *   welcome / goodbye        the channel and wording of the old bot's welcome messages
 *   auto roles               roles the old bot gave people within a minute of joining (from the audit log)
 *   counter channels         channel names like "Members: 1,234"
 *   bans                     the server's ban list and reasons, copied into moderation history
 *
 * Nothing changes during the scan. Staff see a report, pick what to import, and only that is applied. Custom
 * commands (tags) can't be read from Discord at all, so /migrate tags takes them pasted in.
 */
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, PermissionFlagsBits, MessageFlags, ChannelType, AuditLogEvent } from 'discord.js';
import { UserError, truncate } from './util.js';
import { saveCommand } from '../modules/tags/index.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const NS = 'mig';

// Bots this replaces (by their public ids, with a name fallback). Medal is left alone on purpose.
export const KNOWN_BOTS = { '235148962103951360': 'Carl-bot', '204255221017214977': 'YAGPDB', '491769129318088714': 'Statbot', '513423712582762502': 'TTS Bot' };
const NAME_RE = /carl|yagpdb|statbot|tts/i;

export function oldBots(guild) {
  return [...(guild.members?.cache?.values?.() ?? [])].filter((m) => m.user?.bot && m.id !== guild.members?.me?.id && (KNOWN_BOTS[m.id] || (NAME_RE.test(m.user.username ?? '') && !/medal/i.test(m.user.username ?? ''))))
    .map((m) => ({ id: m.id, name: KNOWN_BOTS[m.id] ?? m.user.username }));
}

const EMOJI_RE = /<a?:\w+:(\d+)>|(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)/u;
/** Lines like "🎮 : @Gamer" or "<:valo:123> Valorant players - <@&456>" -> [{ emojiKey, roleId }]. */
export function parseRolePairs(text, guild) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const em = EMOJI_RE.exec(line);
    if (!em) continue;
    const key = em[1] ?? em[2];
    let roleId = /<@&(\d{17,20})>/.exec(line)?.[1];
    if (!roleId) {
      const rest = line.replace(EMOJI_RE, '').replace(/[-:=→>|*_]/g, ' ').trim().toLowerCase();
      roleId = [...(guild.roles?.cache?.values?.() ?? [])].find((r) => r.name && rest && rest.split(/\s{2,}|,/)[0].trim() === r.name.toLowerCase())?.id;
    }
    if (key && roleId) out.push({ emojiKey: key, roleId });
  }
  return out;
}

const textOf = (msg) => [msg.content, ...(msg.embeds ?? []).flatMap((e) => [e.title, e.description, ...(e.fields ?? []).map((f) => `${f.name}\n${f.value}`), e.footer?.text].map((x) => x ?? ''))].join('\n');
const LOG_KINDS = [
  { key: 'logMessages', re: /message (was )?(deleted|edited|updated)|deleted message|edited message/i },
  { key: 'logJoins', re: /member (joined|left)|user (joined|left)|joined the server|left the server/i },
  { key: 'logRoles', re: /roles? (added|removed|updated|changed)|role (given|taken)/i },
  { key: 'logNicknames', re: /nickname/i },
  { key: 'logVoice', re: /(joined|left|moved|switched).{0,12}voice|voice (join|leave|move)/i },
];

/** Looks through the server. Read-only. */
export async function scanServer(guild, { perChannel = 100, maxChannels = 60 } = {}) {
  const bots = oldBots(guild);
  const botIds = new Set(bots.map((b) => b.id));
  const findings = [];
  const add = (f) => findings.push({ id: String(findings.length + 1), ...f });
  const channels = [...guild.channels.cache.values()].filter((c) => c.isTextBased?.() && !c.isVoiceBased?.() && c.messages?.fetch && c.type !== ChannelType.GuildCategory).slice(0, maxChannels);
  const logHits = new Map(); // logKind -> Map(channelId -> count)
  const welcome = new Map(), goodbye = new Map(), star = new Map();

  if (botIds.size) for (const ch of channels) {
    const batch = await ch.messages.fetch({ limit: perChannel }).catch(() => null);
    for (const msg of batch?.values?.() ?? []) {
      if (!botIds.has(msg.author?.id)) continue;
      const text = textOf(msg);
      // reaction roles
      const reacted = [...(msg.reactions?.cache?.values?.() ?? [])];
      if (reacted.length) {
        const pairs = parseRolePairs(text, guild).filter((p) => reacted.some((r) => (r.emoji?.id ?? r.emoji?.name) === p.emojiKey));
        if (pairs.length) add({ kind: 'reactionroles', title: `Reaction roles in #${ch.name}`, detail: pairs.map((p) => `${p.emojiKey.match(/^\d+$/) ? '(custom emoji)' : p.emojiKey} → <@&${p.roleId}>`).join(', '), data: { messageId: msg.id, pairs } });
      }
      for (const k of LOG_KINDS) if (k.re.test(text)) { const m = logHits.get(k.key) ?? new Map(); m.set(ch.id, (m.get(ch.id) ?? 0) + 1); logHits.set(k.key, m); }
      const starM = /(?:⭐|🌟|✨)\s*\**(\d+)\**/.exec(msg.content ?? '');
      if (starM && /<#\d+>/.test(msg.content ?? '')) { const s = star.get(ch.id) ?? { n: 0, min: 99 }; s.n++; s.min = Math.min(s.min, Number(starM[1])); star.set(ch.id, s); }
      const mention = /<@!?(\d{17,20})>/.exec(msg.content ?? '');
      if (mention && /welcome/i.test(text)) { const w = welcome.get(ch.id) ?? { n: 0, sample: msg.content }; w.n++; welcome.set(ch.id, w); }
      if (/(left|goodbye|has left|bye)/i.test(text) && !/voice/i.test(text) && !LOG_KINDS[1].re.test(text)) { const g = goodbye.get(ch.id) ?? { n: 0, sample: msg.content || msg.embeds?.[0]?.description || '' }; g.n++; goodbye.set(ch.id, g); }
    }
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const logKeys = [...logHits.keys()];
  if (logKeys.length) {
    const msgCh = top(logHits.get('logMessages') ?? new Map());
    const otherKeys = logKeys.filter((k) => k !== 'logMessages');
    const serverCh = otherKeys.length ? top(otherKeys.reduce((acc, k) => { for (const [c, n] of logHits.get(k)) acc.set(c, (acc.get(c) ?? 0) + n); return acc; }, new Map())) : null;
    add({ kind: 'logs', title: 'Logging', detail: [msgCh ? `message edits & deletes in <#${msgCh}>` : null, serverCh ? `${otherKeys.map((k) => ({ logJoins: 'joins/leaves', logRoles: 'roles', logNicknames: 'nicknames', logVoice: 'voice' }[k])).join(', ')} in <#${serverCh}>` : null].filter(Boolean).join(' · '), data: { msgCh, serverCh, kinds: otherKeys } });
  }
  const starCh = [...star.entries()].sort((a, b) => b[1].n - a[1].n)[0];
  if (starCh && starCh[1].n >= 2) add({ kind: 'starboard', title: 'Starboard', detail: `<#${starCh[0]}>, ${starCh[1].min} stars needed`, data: { channelId: starCh[0], threshold: Math.max(1, starCh[1].min) } });
  const toTemplate = (sample) => String(sample ?? '').replace(/<@!?\d{17,20}>/g, '{user}').replaceAll(guild.name, '{server}').replace(new RegExp(`\\b${guild.memberCount}\\b`, 'g'), '{count}').slice(0, 500);
  const wCh = [...welcome.entries()].sort((a, b) => b[1].n - a[1].n)[0];
  if (wCh && wCh[1].n >= 2) add({ kind: 'welcome', title: 'Welcome messages', detail: `<#${wCh[0]}>: “${truncate(toTemplate(wCh[1].sample), 120)}”`, data: { channelId: wCh[0], message: toTemplate(wCh[1].sample) } });
  const gCh = [...goodbye.entries()].sort((a, b) => b[1].n - a[1].n)[0];
  if (gCh && gCh[1].n >= 2) add({ kind: 'goodbye', title: 'Goodbye messages', detail: `<#${gCh[0]}>`, data: { channelId: gCh[0], message: toTemplate(gCh[1].sample).replace('{user}', '**{username}**') } });

  // auto roles: roles an old bot added within a minute of someone joining
  const logs = botIds.size ? await guild.fetchAuditLogs?.({ type: AuditLogEvent.MemberRoleUpdate, limit: 100 }).catch(() => null) : null;
  const autoCount = new Map();
  for (const e of logs?.entries?.values?.() ?? []) {
    if (!botIds.has(e.executorId ?? e.executor?.id)) continue;
    const member = guild.members.cache.get(e.targetId ?? e.target?.id);
    if (!member?.joinedTimestamp || Math.abs(e.createdTimestamp - member.joinedTimestamp) > 60000) continue;
    for (const ch of e.changes ?? []) if (ch.key === '$add') for (const r of ch.new ?? []) autoCount.set(r.id, (autoCount.get(r.id) ?? 0) + 1);
  }
  const autoroles = [...autoCount.entries()].filter(([, n]) => n >= 2).map(([id]) => id).filter((id) => guild.roles.cache.has(id));
  if (autoroles.length) add({ kind: 'autoroles', title: 'Roles given on join', detail: autoroles.map((r) => `<@&${r}>`).join(' '), data: { roles: autoroles } });

  // counter channels
  const counters = [];
  for (const c of guild.channels.cache.values()) {
    if (!(c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice) || !/\d/.test(c.name ?? '')) continue;
    const kind = /online/i.test(c.name) ? 'online' : /boost/i.test(c.name) ? 'boosts' : /bot/i.test(c.name) ? 'bots' : /human|people/i.test(c.name) ? 'humans' : /member|user|total/i.test(c.name) ? 'members' : null;
    if (kind) counters.push({ channelId: c.id, template: c.name.replace(/[\d,. ]*\d[\d,.]*/, (n) => `${n.startsWith(' ') ? ' ' : ''}{${kind}}`) });
  }
  if (counters.length) add({ kind: 'counters', title: 'Counter channels', detail: counters.map((c) => `<#${c.channelId}> → \`${c.template}\``).join(', '), data: { counters } });

  // bans with reasons, into moderation history
  const bans = await guild.bans?.fetch?.().catch(() => null);
  const banList = [...(bans?.values?.() ?? [])].map((b) => ({ id: b.user.id, tag: b.user.tag ?? b.user.username, reason: b.reason ?? null }));
  if (banList.length) add({ kind: 'bans', title: 'Ban list', detail: `${banList.length} ban${banList.length === 1 ? '' : 's'}${banList.filter((b) => b.reason).length ? `, ${banList.filter((b) => b.reason).length} with reasons` : ''} → copied into /modhistory`, data: { bans: banList.slice(0, 1000) } });

  const automod = await guild.autoModerationRules?.fetch?.().catch(() => null);
  const autoModCount = automod?.size ?? 0;
  return { bots, findings, autoModCount, scannedChannels: channels.length };
}

/** Applies one finding. Returns a short line for the report. */
export async function applyFinding(m, guildId, f) {
  const enable = async (name) => { if (!m.active.get(guildId)?.has(name)) await m.enable(guildId, name); };
  const set = (mod, key, value) => m.setSetting(guildId, mod, key, value);
  switch (f.kind) {
    case 'reactionroles': {
      await enable('roles');
      const ctx = m.ctx(guildId, 'roles');
      for (const p of f.data.pairs) ctx.data.set(`rr:${f.data.messageId}:${p.emojiKey}`, p.roleId);
      return `Reaction roles: ${f.data.pairs.length} on one message`;
    }
    case 'logs': {
      await enable('moderation');
      if (f.data.msgCh) { set('moderation', 'logChannel', f.data.msgCh); set('moderation', 'logMessages', true); }
      if (f.data.serverCh) { set('moderation', 'serverLogChannel', f.data.serverCh); for (const k of f.data.kinds) set('moderation', k, true); }
      return 'Logging channels';
    }
    case 'starboard':
      await enable('engagement');
      set('engagement', 'starboardChannel', f.data.channelId); set('engagement', 'starThreshold', f.data.threshold); set('engagement', 'starEnabled', true);
      return 'Starboard';
    case 'welcome':
      await enable('member-management');
      set('member-management', 'welcomeChannel', f.data.channelId); set('member-management', 'welcomeMessage', f.data.message); set('member-management', 'welcomeEnabled', true);
      return 'Welcome messages';
    case 'goodbye':
      await enable('member-management');
      set('member-management', 'goodbyeChannel', f.data.channelId); set('member-management', 'goodbyeMessage', f.data.message); set('member-management', 'goodbyeEnabled', true);
      return 'Goodbye messages';
    case 'autoroles': {
      await enable('roles');
      const ctx = m.ctx(guildId, 'roles');
      ctx.data.set('autorole:members', [...new Set([...(ctx.data.get('autorole:members') ?? []), ...f.data.roles])]);
      return `Join roles: ${f.data.roles.length}`;
    }
    case 'counters': {
      await enable('stats');
      const ctx = m.ctx(guildId, 'stats');
      for (const c of f.data.counters) ctx.data.set(`counter:${c.channelId}`, { template: c.template, by: 'migrate' });
      return `Counters: ${f.data.counters.length}`;
    }
    case 'bans': {
      await enable('moderation');
      const ctx = m.ctx(guildId, 'moderation');
      let n = 0;
      for (const b of f.data.bans) {
        const hist = ctx.data.get(`hist:${b.id}`) ?? [];
        if (hist.some((h) => h.type === 'ban' && h.imported)) continue;
        const id = ctx.data.update('counter', (x) => x + 1, 0);
        ctx.data.set(`hist:${b.id}`, [{ id, type: 'ban', targetId: b.id, targetTag: b.tag, modId: null, reason: b.reason ?? 'Imported (no reason recorded)', at: Date.now(), imported: true }, ...hist].slice(0, 100));
        n++;
      }
      return `Bans copied: ${n}`;
    }
    default: throw new UserError('Unknown item.');
  }
}

/** "/migrate tags": custom commands pasted as blocks: a name on the first line, the reply under it, blocks split by ---. */
export function parseTagPaste(text) {
  return String(text ?? '').split(/^\s*-{3,}\s*$/m).map((block) => block.trim()).filter(Boolean).map((block) => {
    const [first, ...rest] = block.split('\n');
    return { name: first.trim().replace(/^[?!.\-$]+/, '').split(/\s+/)[0], response: rest.join('\n').trim() };
  }).filter((t) => t.name && t.response);
}

// ------------------------------------------------------------------ the command
const scans = new Map(); // `${guild}:${user}` -> { result, at }

function reportMessage(i, result) {
  const { bots, findings, autoModCount } = result;
  const e = new EmbedBuilder().setColor(0x5865f2).setTitle('🔁 Move to Good Boy')
    .setDescription([
      bots.length ? `Found: ${bots.map((b) => `**${b.name}**`).join(', ')}.` : 'No Carl-bot, YAGPDB, Statbot or TTS Bot found in this server. (Medal is left alone.)',
      findings.length ? `Here is what they left behind that I can set up for you. **Nothing has changed yet.** Pick what to import:` : 'I found nothing to import automatically.',
      ...findings.map((f) => `**${f.id}. ${f.title}** · ${truncate(f.detail, 300)}`),
      autoModCount ? `ℹ️ ${autoModCount} Discord AutoMod rule${autoModCount === 1 ? '' : 's'} (Server Settings > AutoMod) keep working after the old bots are removed.` : null,
      '**Not readable from Discord:** custom commands/tags (paste them with `/migrate tags`), each bot\'s private settings, and Statbot\'s history (run `/stats backfill` with days empty instead). TTS Bot users pick their voice again with `/tts voice`.',
    ].filter(Boolean).join('\n\n').slice(0, 4000));
  const rows = [];
  if (findings.length) {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`${NS}:pick:${i.user.id}`).setPlaceholder('Choose what to import').setMinValues(1).setMaxValues(Math.min(25, findings.length))
      .addOptions(findings.slice(0, 25).map((f) => ({ label: truncate(`${f.id}. ${f.title}`, 100), value: f.id, description: truncate(f.detail.replace(/<[@#&!]+\d+>/g, '…'), 100) })))));
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${NS}:all:${i.user.id}`).setLabel('Import everything').setStyle(ButtonStyle.Success)));
  }
  return { embeds: [e], components: rows, allowedMentions: NOPING };
}

async function apply(i, m, ids) {
  const s = scans.get(`${i.guildId}:${i.user.id}`);
  if (!s || Date.now() - s.at > 30 * 60000) throw new UserError('That scan expired. Run `/migrate scan` again.');
  await i.update({ components: [], content: '⏳ Importing…' });
  const lines = [];
  for (const f of s.result.findings.filter((x) => ids.includes(x.id))) {
    try { lines.push(`✅ ${await applyFinding(m, i.guildId, f)}`); } catch (e) { lines.push(`❌ ${f.title}: ${e.message}`); }
  }
  m.db.addLog?.(i.guildId, 'core', 'security', `${i.user.username} imported settings from other bots: ${lines.length} item(s)`);
  return i.editReply({ content: `${lines.join('\n')}\n\n**Next:** check everything works, then remove the old bots (Server Settings > Integrations, or right-click the bot → Kick). Keep Medal.`, embeds: [], components: [] });
}

export const migrateCommand = {
  access: 'admin',
  data: new SlashCommandBuilder().setName('migrate').setDescription('Move from Carl-bot, YAGPDB, Statbot and TTS Bot to Good Boy')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName('scan').setDescription('Find what the other bots set up, and choose what to import (nothing changes until you pick)'))
    .addSubcommand((s) => s.setName('tags').setDescription('Paste custom commands from another bot').addStringOption((o) => o.setName('commands').setDescription('A name on its own line, the reply under it; split commands with ---').setRequired(true).setMaxLength(4000))),
  async execute(i, m) {
    const sub = i.options.getSubcommand();
    if (sub === 'tags') {
      const list = parseTagPaste(i.options.getString('commands', true));
      if (!list.length) throw new UserError('Paste each command as its name on one line and the reply underneath, with --- between commands.');
      if (!m.active.get(i.guildId)?.has('tags')) await m.enable(i.guildId, 'tags');
      const ctx = m.ctx(i.guildId, 'tags');
      const done = [], bad = [];
      for (const t of list) { try { saveCommand(ctx, { ...t, trigger: 'command', from: 'paste' }, i.user.id); done.push(t.name); } catch (e) { bad.push(`${t.name}: ${e.message}`); } }
      return i.reply({ content: truncate(`✅ Imported **${done.length}** custom command${done.length === 1 ? '' : 's'}: ${done.map((n) => `\`${n}\``).join(' ')}${bad.length ? `\n❌ ${bad.join('\n❌ ')}` : ''}\nMembers use them like before, e.g. \`?${done[0] ?? 'name'}\`.`, 1900), flags: EPH, allowedMentions: NOPING });
    }
    await i.deferReply({ flags: EPH });
    const result = await scanServer(i.guild);
    scans.set(`${i.guildId}:${i.user.id}`, { result, at: Date.now() });
    return i.editReply(reportMessage(i, result));
  },
  components: [{
    prefix: `${NS}:`,
    async execute(i, m) {
      const [, kind, owner] = i.customId.split(':');
      if (owner !== i.user.id) throw new UserError('That belongs to someone else. Run `/migrate scan` yourself.');
      const s = scans.get(`${i.guildId}:${i.user.id}`);
      if (kind === 'pick') return apply(i, m, [...(i.values ?? [])]);
      if (kind === 'all') return apply(i, m, (s?.result.findings ?? []).map((f) => f.id));
      throw new UserError('That button is no longer active.');
    },
  }],
};
