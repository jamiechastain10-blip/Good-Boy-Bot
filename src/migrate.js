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
import { postRoleMenu } from '../modules/roles/index.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const NS = 'mig';

// Bots this replaces (by their public ids, with a name fallback). Medal is left alone on purpose.
export const KNOWN_BOTS = {
  '235148962103951360': 'Carl-bot', '204255221017214977': 'YAGPDB', '491769129318088714': 'Statbot', '513423712582762502': 'TTS Bot',
  // 3.0
  '368521195940741122': 'Lawliet', '159985870458322944': 'MEE6', '155149108183695360': 'Dyno', '437808476106784770': 'Arcane', '172002275412279296': 'Tatsu', '282859044593598464': 'ProBot',
};
export const MEE6_ID = '159985870458322944';
const NAME_RE = /carl|yagpdb|statbot|tts|lawliet|mee6|dyno|arcane|tatsu|probot/i;

// ------------------------------------------------------------------ role menus made of buttons or dropdowns (3.0)
const emojiText = (e) => (!e ? null : e.id ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : e.name ?? null);
/** The role a button or dropdown option stands for: a role ID inside its custom id or value, or a role with the same name as its label. */
export function roleFromComponent(guild, id, label) {
  for (const x of String(id ?? '').match(/\d{17,20}/g) ?? []) { const r = guild.roles?.cache?.get(x); if (r) return r; }
  const byName = label ? findRoleByName(guild, label) : null;
  return byName ? guild.roles?.cache?.get(byName) ?? { id: byName } : null;
}
/** Pairs from a message's buttons and dropdowns (Lawliet, Arcane and newer Carl-bot menus are built this way). */
export function componentRolePairs(msg, guild) {
  const pairs = [];
  for (const row of msg.components ?? []) for (const c of row.components ?? []) {
    const type = c.type ?? c.data?.type;
    if (type === 2) { const r = roleFromComponent(guild, c.customId ?? c.custom_id, c.label); if (r) pairs.push({ roleId: r.id, emoji: emojiText(c.emoji), emojiKey: c.emoji?.id ?? c.emoji?.name ?? r.id }); }
    if (type === 3) for (const o of c.options ?? []) { const r = roleFromComponent(guild, o.value, o.label); if (r) pairs.push({ roleId: r.id, emoji: emojiText(o.emoji), emojiKey: o.emoji?.id ?? o.emoji?.name ?? r.id }); }
  }
  return pairs.filter((p, i, all) => all.findIndex((x) => x.roleId === p.roleId) === i && p.roleId !== guild.id);
}

/**
 * MEE6 levels, from its public leaderboard (only works when the server's leaderboard is public). MEE6 and Good Boy
 * use the same XP formula, so levels carry over exactly. fetchFn is for tests.
 */
export async function mee6Levels(guildId, { fetchFn = globalThis.fetch, pages = 10 } = {}) {
  const players = [];
  for (let page = 0; page < pages; page++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetchFn(`https://mee6.xyz/api/plugins/levels/leaderboard/${guildId}?limit=1000&page=${page}`, { signal: ctl.signal, headers: { Accept: 'application/json' } });
      if (!r.ok) return { players, error: r.status === 401 || r.status === 403 || r.status === 404 ? 'private' : `HTTP ${r.status}` };
      const d = await r.json();
      const list = Array.isArray(d.players) ? d.players : [];
      for (const p of list) if (/^\d{17,20}$/.test(String(p.id)) && Number.isFinite(Number(p.xp))) players.push({ id: String(p.id), name: String(p.username ?? '').slice(0, 40), xp: Math.max(0, Math.floor(Number(p.xp))), level: Number(p.level) || 0, messages: Number(p.message_count) || 0 });
      if (list.length < 1000) break;
    } catch (e) { return { players, error: e.name === 'AbortError' ? 'timeout' : e.message }; } finally { clearTimeout(t); }
  }
  return { players };
}

export function oldBots(guild) {
  return [...(guild.members?.cache?.values?.() ?? [])].filter((m) => m.user?.bot && m.id !== guild.members?.me?.id && (KNOWN_BOTS[m.id] || (NAME_RE.test(m.user.username ?? '') && !/medal/i.test(m.user.username ?? ''))))
    .map((m) => ({ id: m.id, name: KNOWN_BOTS[m.id] ?? m.user.username }));
}

// Custom emojis, keycaps (1️⃣ is a digit + U+FE0F + U+20E3) and normal emojis (with skin tones and joined sequences).
const EMOJI_RE = /<a?:\w+:(\d+)>|([0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic})*)/u;
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
/** The role a piece of text names: exact (ignoring case, spaces and symbols), then one name containing the other. */
export function findRoleByName(guild, text) {
  const t = norm(text);
  if (t.length < 2) return null;
  const roles = [...(guild.roles?.cache?.values?.() ?? [])].filter((r) => r.id !== guild.id && !r.managed);
  const exact = roles.find((r) => norm(r.name) === t);
  if (exact) return exact.id;
  const close = roles.filter((r) => { const n = norm(r.name); return n.length >= 3 && (t.includes(n) || n.includes(t)); });
  if (close.length === 1) return close[0].id;
  // Small typos ("Seige" for "Siege"): at most 2 letters different, for names of 6 letters or more.
  const near = roles.filter((r) => { const n = norm(r.name); return n.length >= 6 && Math.abs(n.length - t.length) <= 2 && editDistance(n, t) <= 2; });
  return near.length === 1 ? near[0].id : null;
}
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// Commands the old bots answered: learned from the chat history, so custom commands come across without pasting.
// Built-in commands of those bots are not custom commands, so they are skipped (Good Boy has its own versions).
const BUILTIN = new Set(('help commands ping rank level levels xp leaderboard lb top daily balance bal pay warn warnings ban unban kick mute unmute timeout untimeout '
  + 'purge clear prune remind reminder reminders poll suggest suggestion giveaway gstart tag tags t tagcreate avatar av userinfo whois serverinfo info say embed rr reactionrole role roles '
  + 'afk slowmode lock unlock nick nickname play skip stop queue np pause resume join leave tts voice rep cases modlogs case note notes reason starboard automod config prefix settings setup').split(' '));
const COMMAND_MAP = { rank: '/rank', level: '/rank', levels: '/leaderboard', leaderboard: '/leaderboard', lb: '/leaderboard', top: '/top', daily: '/daily', balance: '/balance', bal: '/balance', pay: '/pay',
  warn: '/warn', warnings: '/modhistory', cases: '/modhistory', modlogs: '/modhistory', ban: '/ban', unban: '/unban', kick: '/kick', mute: '/timeout', timeout: '/timeout', unmute: '/untimeout',
  purge: '/purge', clear: '/purge', prune: '/purge', remind: '/remind me', reminder: '/remind me', poll: '/poll create', suggest: '/suggest', afk: '/afk', say: '/say send', embed: '/say send',
  rr: '/rolemenu', reactionrole: '/rolemenu', rep: '/rep', tts: '/tts', join: '/tts join', leave: '/tts leave', skip: '/tts skip', starboard: '/starboard', tag: 'custom commands (?name)', tags: '/tags list',
  avatar: null, serverinfo: '/serverstats', userinfo: '/id show', giveaway: null, play: null, stats: '/stats member', counter: '/counter' };
const CMD_RE = /^([?!.\-$+;~>])([\p{L}\p{N}_-]{1,32})(?:\s+(.*))?$/u;
const replyText = (m) => { const e = m.embeds?.[0]; return [m.content, e?.title ? `**${e.title}**` : null, e?.description].filter(Boolean).join('\n').trim(); };

/** The old message's own heading and text (everything that isn't an emoji-to-role line), to keep on the new menu. */
export function headerOf(msg) {
  const e = msg.embeds?.[0];
  const lines = `${msg.content ?? ''}\n${e?.description ?? ''}`.split('\n').map((l) => l.trim()).filter((l) => l && !(EMOJI_RE.test(l) && l.replace(EMOJI_RE, '').trim().length < 60 && /[\p{L}]/u.test(l)));
  const title = (e?.title ?? lines.shift() ?? 'Pick your roles').replace(/\*\*/g, '').slice(0, 200);
  return { title, description: lines.join('\n').slice(0, 1500) || null };
}

/** Lines like "🎮 : @Gamer" or "<:valo:123> Valorant players - <@&456>" -> [{ emojiKey, roleId }]. */
export function parseRolePairs(text, guild) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const em = EMOJI_RE.exec(line);
    if (!em) continue;
    const key = em[1] ?? em[2];
    let roleId = /<@&(\d{17,20})>/.exec(line)?.[1];
    if (!roleId) roleId = findRoleByName(guild, line.replace(EMOJI_RE, '').replace(/[-:=→>|*_~`]/g, ' ').trim());
    if (key && roleId) out.push({ emojiKey: key, emoji: em[0], roleId });
  }
  return out;
}

const embedText = (msg) => (msg.embeds ?? []).flatMap((e) => [e.author?.name, e.title, e.description, ...(e.fields ?? []).map((f) => `${f.name}\n${f.value}`), e.footer?.text].map((x) => x ?? '')).join('\n');
const textOf = (msg) => `${msg.content ?? ''}\n${embedText(msg)}`;
const LOG_KINDS = [
  { key: 'logMessages', re: /message (was )?(deleted|edited|updated)|deleted message|edited message|(deleted|edited) in (<#\d+>|#)/i },
  { key: 'logJoins', re: /member (joined|left)|user (joined|left)|joined the server|left the server/i },
  { key: 'logRoles', re: /roles? (added|removed|updated|changed)|role (given|taken)/i },
  { key: 'logNicknames', re: /nickname/i },
  { key: 'logVoice', re: /(joined|left|moved|switched).{0,12}voice|voice (join|leave|move)/i },
];

/** Looks through the server. Read-only. */
export async function scanServer(guild, { perChannel = 1000, timeBudgetMs = 12 * 60000, onProgress } = {}) {
  const bots = oldBots(guild);
  const botIds = new Set(bots.map((b) => b.id));
  const botName = new Map(bots.map((b) => [b.id, b.name]));
  const learned = new Map(), usage = new Map();
  const unreadable = [];
  const findings = [];
  const add = (f) => findings.push({ id: String(findings.length + 1), ...f });
  const channels = [...guild.channels.cache.values()].filter((c) => c.isTextBased?.() && !c.isVoiceBased?.() && c.messages?.fetch && c.type !== ChannelType.GuildCategory);
  // Active threads too (forum posts and threads hold role pickers and logs in some servers).
  const active = await guild.channels.fetchActiveThreads?.().catch(() => null);
  for (const t of active?.threads?.values?.() ?? []) if (t.messages?.fetch) channels.push(t);
  const started = Date.now();
  let scannedMessages = 0, done = 0, stoppedEarly = false;
  const logHits = new Map(); // logKind -> Map(channelId -> count)
  const welcome = new Map(), goodbye = new Map(), star = new Map();

  if (botIds.size) for (const ch of channels) {
    if (Date.now() - started > timeBudgetMs) { stoppedEarly = true; break; }
    onProgress?.({ done, total: channels.length, current: ch.id, scannedMessages });
    // Read up to perChannel messages, 100 at a time, going back in time.
    const msgs = []; let before; let readable = true;
    while (msgs.length < perChannel) {
      const page = await ch.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
      if (!page) { readable = msgs.length > 0; break; }
      const list = [...page.values()];
      if (!list.length) break;
      msgs.push(...list);
      before = list.reduce((a, m) => (m.createdTimestamp < a.createdTimestamp ? m : a), list[0]).id;
      if (list.length < 100) break;
    }
    done++; scannedMessages += msgs.length;
    const ordered = [...msgs].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (let k = 0; k < ordered.length; k++) {
      const um = ordered[k];
      const used = um.interaction?.commandName ?? um.interactionMetadata?.name;
      if (used && botIds.has(um.author?.id)) { const key = `${botName.get(um.author.id)}|/${used}`; usage.set(key, (usage.get(key) ?? 0) + 1); }
      if (um.author?.bot) continue;
      const cm = CMD_RE.exec(String(um.content ?? '').trim());
      if (!cm) continue;
      let name = cm[2].toLowerCase();
      if ((name === 'tag' || name === 't') && cm[3]) name = cm[3].split(/\s+/)[0].toLowerCase();
      else if (BUILTIN.has(name)) { const key = `prefix|${cm[1]}${name}`; usage.set(key, (usage.get(key) ?? 0) + 1); continue; }
      // the old bot's answer: a reply to this message, or its next message here within 15 seconds
      const ans = ordered.slice(k + 1, k + 6).find((r) => botIds.has(r.author?.id) && (r.reference?.messageId === um.id || r.createdTimestamp - um.createdTimestamp < 15000));
      const text = ans && replyText(ans);
      if (!text || text.length < 2) continue;
      const prev = learned.get(name);
      learned.set(name, { name, prefix: cm[1], response: text.slice(0, 2000), count: (prev?.count ?? 0) + 1, from: botName.get(ans.author.id) });
    }
    if (!readable) { unreadable.push(ch.id); continue; }
    for (const msg of msgs) {
      if (!botIds.has(msg.author?.id)) continue;
      const text = textOf(msg);
      // reaction roles
      const reacted = [...(msg.reactions?.cache?.values?.() ?? [])];
      if (reacted.length) {
        const pairs = parseRolePairs(text, guild).filter((p) => reacted.some((r) => (r.emoji?.id ?? r.emoji?.name) === p.emojiKey));
        if (pairs.length) {
          const head = headerOf(msg);
          add({ kind: 'reactionroles', title: `Role menu in #${ch.name} (${pairs.length} role${pairs.length === 1 ? '' : 's'})`, detail: `${pairs.map((p) => `${p.emoji} <@&${p.roleId}>`).join(' ')} → replaced by a Good Boy role menu in the same place`, data: { messageId: msg.id, channelId: ch.id, pairs, from: botName.get(msg.author.id), ...head } });
        }
      } else if (msg.components?.length) {
        const pairs = componentRolePairs(msg, guild);
        if (pairs.length) {
          const head = headerOf(msg);
          add({ kind: 'reactionroles', title: `Button role menu in #${ch.name} (${pairs.length} role${pairs.length === 1 ? '' : 's'})`, detail: `${pairs.map((p) => `${p.emoji ?? '•'} <@&${p.roleId}>`).join(' ')} → replaced by a Good Boy role menu in the same place`, data: { messageId: msg.id, channelId: ch.id, pairs, from: botName.get(msg.author.id), ...head } });
        }
      }
      // Logs are boxes (embeds) from a moderation bot; TTS Bot's voice messages are not logs.
      const box = embedText(msg);
      if (box && !/tts/i.test(botName.get(msg.author.id) ?? '')) for (const k of LOG_KINDS) if (k.re.test(box)) { const m = logHits.get(k.key) ?? new Map(); m.set(ch.id, (m.get(ch.id) ?? 0) + 1); logHits.set(k.key, m); }
      const starM = /(?:⭐|🌟|✨)\s*\**(\d+)\**/.exec(msg.content ?? '');
      if (starM && /<#\d+>/.test(msg.content ?? '')) { const s = star.get(ch.id) ?? { n: 0, min: 99 }; s.n++; s.min = Math.min(s.min, Number(starM[1])); star.set(ch.id, s); }
      const mention = /<@!?(\d{17,20})>/.exec(msg.content ?? '');
      if (mention && /welcome/i.test(text)) { const w = welcome.get(ch.id) ?? { n: 0, sample: msg.content }; w.n++; welcome.set(ch.id, w); }
      if (/(left|goodbye|has left|bye)/i.test(text) && !/voice/i.test(text) && !LOG_KINDS[1].re.test(text)) { const g = goodbye.get(ch.id) ?? { n: 0, sample: msg.content || msg.embeds?.[0]?.description || '' }; g.n++; goodbye.set(ch.id, g); }
    }
  }
  for (const [k, m] of logHits) { for (const [c, n] of m) if (n < 2) m.delete(c); if (!m.size) logHits.delete(k); }
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

  if (learned.size) {
    const list = [...learned.values()].sort((a, b) => b.count - a.count);
    add({ kind: 'tags', title: `Custom commands learned from chat (${list.length})`, detail: list.slice(0, 15).map((t) => `\`${t.prefix}${t.name}\``).join(' ') + (list.length > 15 ? ' …' : '') + ' → work the same in Good Boy', data: { tags: list } });
  }
  if (usage.size) {
    const rows = [...usage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => {
      const cmd = k.split('|')[1], word = cmd.replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase();
      const gb = Object.hasOwn(COMMAND_MAP, word) ? COMMAND_MAP[word] : undefined;
      return `\`${cmd}\` ${n}× → ${gb ? `**${gb}**` : gb === null ? '*no Good Boy version*' : '*check /help*'}`;
    });
    add({ kind: 'usage', info: true, title: 'Commands your members used', detail: rows.join(' · '), data: {} });
  }
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

  // MEE6 levels (its public leaderboard), if MEE6 is here.
  if (botIds.has(MEE6_ID)) {
    const got = await mee6Levels(guild.id).catch((e) => ({ players: [], error: e.message }));
    if (got.players.length) add({ kind: 'levels', title: `Levels from MEE6 (${got.players.length} members)`, detail: `Top: ${got.players.slice(0, 3).map((p) => `${p.name || p.id} level ${p.level}`).join(', ')} → the same levels in Good Boy (nobody goes down)`, data: { from: 'MEE6', players: got.players.slice(0, 10000) } });
    else if (got.error === 'private') add({ kind: 'levels-private', info: true, title: 'MEE6 levels', detail: 'MEE6\'s leaderboard for this server is private, so its levels can\'t be read. Make it public in MEE6\'s dashboard (Leaderboard, public), scan again, then make it private again.', data: {} });
  }
  const automod = await guild.autoModerationRules?.fetch?.().catch(() => null);
  const autoModCount = automod?.size ?? 0;
  return { bots, findings, autoModCount, scannedChannels: done, totalChannels: channels.length, scannedMessages, stoppedEarly, unreadable };
}

/** Applies one finding. Returns a short line for the report. */
export async function applyFinding(m, guildId, f) {
  const enable = async (name) => { if (!m.active.get(guildId)?.has(name)) await m.enable(guildId, name); };
  const set = (mod, key, value) => m.setSetting(guildId, mod, key, value);
  switch (f.kind) {
    case 'reactionroles': {
      // Post a Good Boy role menu where the old one was, then remove the old message. Members keep the roles they have.
      await enable('roles');
      const ctx = m.ctx(guildId, 'roles');
      const guild = m.client?.guilds?.cache?.get(guildId) ?? ctx.guild;
      const ch = guild?.channels.cache.get(f.data.channelId);
      if (!ch?.isTextBased?.()) throw new UserError('That channel is gone.');
      const roles = f.data.pairs.filter((p, i, all) => all.findIndex((x) => x.roleId === p.roleId) === i).map((p) => ({ id: p.roleId, emoji: p.emoji }));
      const fresh = await postRoleMenu(ctx, ch, { title: f.data.title, description: f.data.description, roles, from: f.data.from ?? 'another bot' });
      const old = await ch.messages.fetch(f.data.messageId).catch(() => null);
      let removed = !old;
      if (old) { try { await old.delete(); removed = true; } catch { removed = false; } }
      if (!removed) for (const p of f.data.pairs) ctx.data.set(`rr:${f.data.messageId}:${p.emojiKey}`, p.roleId); // keep the old one working until it's deleted
      return `Role menu in <#${ch.id}>: new menu posted with ${roles.length} role${roles.length === 1 ? '' : 's'}${removed ? ', old message removed' : ' (I couldn\'t delete the old message: give me Manage Messages there, or delete it yourself)'} · [open](${fresh.url ?? ''})`;
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
    case 'tags': {
      await enable('tags');
      const ctx = m.ctx(guildId, 'tags');
      let n = 0;
      for (const t of f.data.tags) { try { saveCommand(ctx, { name: t.name, response: t.response, trigger: 'command', from: t.from }, null); n++; } catch { /* name not allowed */ } }
      return `Custom commands: ${n} learned (try \`?${f.data.tags[0]?.name ?? 'name'}\`)`;
    }
    case 'usage': return 'Command report (nothing to import)';
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
    case 'levels': {
      // Same XP formula as MEE6, so the XP is copied as it is. Nobody loses XP: the higher number is kept.
      await enable('community');
      const ctx = m.ctx(guildId, 'community');
      let raised = 0;
      for (const p of f.data.players ?? []) {
        let up = false;
        ctx.data.update(`user:${p.id}`, (u) => { if ((u.xp ?? 0) >= p.xp) return u; up = true; return { ...u, xp: p.xp, messages: Math.max(u.messages ?? 0, p.messages ?? 0) }; }, { xp: 0, messages: 0, rep: 0, lastXp: 0, lastRep: 0 });
        if (up) raised++;
      }
      return `Levels from ${f.data.from ?? 'the old bot'}: ${raised} member${raised === 1 ? '' : 's'} moved up to their old level (${(f.data.players ?? []).length - raised} were already level with it or higher)`;
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
      `Read **${(result.scannedMessages ?? 0).toLocaleString('en-US')}** messages in ${result.scannedChannels ?? 0} of ${result.totalChannels ?? 0} channels and threads (up to 1,000 per channel).${result.stoppedEarly ? ' I stopped after 12 minutes; run the scan again to finish.' : ''}`,
      findings.length ? `Here is what they left behind that I can set up for you. **Nothing has changed yet.** Pick what to import:` : 'I found nothing to import automatically.',
      ...findings.map((f) => `**${f.id}. ${f.title}** · ${truncate(f.detail, 300)}`),
      result.unreadable?.length ? `⚠️ I couldn't read ${result.unreadable.length} channel${result.unreadable.length === 1 ? '' : 's'} (${result.unreadable.slice(0, 6).map((id) => `<#${id}>`).join(' ')}${result.unreadable.length > 6 ? ' …' : ''}). If old logs are there, give me View Channel and Read Message History there and scan again.` : null,
      autoModCount ? `ℹ️ ${autoModCount} Discord AutoMod rule${autoModCount === 1 ? '' : 's'} (Server Settings > AutoMod) keep working after the old bots are removed.` : null,
      '**Not readable from Discord:** custom commands/tags (paste them with `/migrate tags`), each bot\'s private settings, and Statbot\'s history (run `/stats backfill` with days empty instead). TTS Bot users pick their voice again with `/tts voice`.',
    ].filter(Boolean).join('\n\n').slice(0, 4000));
  const rows = [];
  if (findings.length) {
    const pickable = findings.filter((f) => !f.info);
    if (pickable.length) rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`${NS}:pick:${i.user.id}`).setPlaceholder('Choose what to import').setMinValues(1).setMaxValues(Math.min(25, pickable.length))
      .addOptions(pickable.slice(0, 25).map((f) => ({ label: truncate(`${f.id}. ${f.title}`, 100), value: f.id, description: truncate(f.detail.replace(/<[@#&!]+\d+>/g, '…'), 100) })))));
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
    // A full scan reads up to 1,000 messages in every channel, which takes a while: show where it is.
    let last = 0;
    const onProgress = (p) => {
      if (Date.now() - last < 5000) return;
      last = Date.now();
      i.editReply({ content: `🔍 Scanning… channel ${p.done + 1} of ${p.total} (<#${p.current}>) · ${p.scannedMessages.toLocaleString('en-US')} messages read so far.`, allowedMentions: NOPING }).catch(() => {});
    };
    const result = await scanServer(i.guild, { onProgress });
    scans.set(`${i.guildId}:${i.user.id}`, { result, at: Date.now() });
    return i.editReply({ content: null, ...reportMessage(i, result) });
  },
  components: [{
    prefix: `${NS}:`,
    async execute(i, m) {
      const [, kind, owner] = i.customId.split(':');
      if (owner !== i.user.id) throw new UserError('That belongs to someone else. Run `/migrate scan` yourself.');
      const s = scans.get(`${i.guildId}:${i.user.id}`);
      if (kind === 'pick') return apply(i, m, [...(i.values ?? [])]);
      if (kind === 'all') return apply(i, m, (s?.result.findings ?? []).filter((f) => !f.info).map((f) => f.id));
      throw new UserError('That button is no longer active.');
    },
  }],
};
