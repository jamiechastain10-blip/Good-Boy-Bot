/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */

export const SNOWFLAKE = /^\d{17,20}$/;

/** Error whose message is safe to show directly to a Discord user. */
export class UserError extends Error {
  constructor(message) { super(message); this.name = 'UserError'; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** "90s", "10m", "2h", "1d", "1w", "1h30m" -> milliseconds, or null if invalid. */
export function parseDuration(input) {
  const s = String(input ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  const re = /(\d+)(w|d|h|m|s)/g;
  const unit = { w: 604800000, d: 86400000, h: 3600000, m: 60000, s: 1000 };
  let total = 0, matched = '', m;
  while ((m = re.exec(s))) { total += Number(m[1]) * unit[m[2]]; matched += m[0]; }
  if (!total || matched !== s) return null;
  return total;
}

export function formatDuration(ms) {
  const parts = [];
  for (const [label, size] of [['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]]) {
    if (ms >= size) { parts.push(Math.floor(ms / size) + label); ms %= size; }
  }
  return parts.length ? parts.slice(0, 3).join(' ') : '0s';
}

/** Strips control characters and mention-forming characters from user supplied display text. */
export function sanitizeName(s, max = 32) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[@#`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function normalizeHex(input) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(input ?? '').trim());
  return m ? '#' + m[1].toUpperCase() : null;
}

export const hexToInt = (hex) => parseInt(hex.replace('#', ''), 16);

/** Replaces {key} placeholders. Unknown keys are left untouched. */
export function fillTemplate(tpl, vars) {
  return String(tpl ?? '').replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all));
}

export function progressBar(value, max, width = 12) {
  const filled = Math.max(0, Math.min(width, Math.round((value / Math.max(1, max)) * width)));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;

/**
 * Moderator-vs-target hierarchy check. Returns an error string, or null if allowed.
 * `botMember` is the bot's own GuildMember.
 */
export function hierarchyError(guild, moderator, target, botMember) {
  if (!target) return null;
  if (target.id === guild.ownerId) return "You can't do that to the server owner.";
  if (target.id === botMember?.id) return "I can't do that to myself.";
  if (target.id === moderator.id) return "You can't do that to yourself.";
  if (moderator.id !== guild.ownerId && target.roles.highest.position >= moderator.roles.highest.position) {
    return "That member's highest role is equal to or above yours.";
  }
  if (botMember && target.roles.highest.position >= botMember.roles.highest.position) {
    return "That member's highest role is equal to or above mine. Move my role higher in Server Settings > Roles.";
  }
  return null;
}

/** Blocks SSRF: only http(s), no loopback / private / link-local targets. */
export async function assertSafeUrl(urlString) {
  const { lookup } = await import('node:dns/promises');
  let u;
  try { u = new URL(urlString); } catch { throw new UserError('That is not a valid URL.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new UserError('Only http(s) URLs are allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new UserError('That address is not allowed.');
  }
  const addrs = await lookup(host, { all: true }).catch(() => { throw new UserError("I couldn't resolve that address."); });
  for (const { address } of addrs) if (isPrivateIp(address)) throw new UserError('That address is not allowed.');
  return u;
}

export function isPrivateIp(ip) {
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') ||
      l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb') || l.startsWith('::ffff:127.') ||
      l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168.');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** fetch with timeout and a hard response size cap. Returns text. */
export async function fetchText(url, { timeoutMs = 10000, maxBytes = 2_000_000, headers = {} } = {}) {
  await assertSafeUrl(url);
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'GoodBoy/3.0.3 (+Discord bot)', ...headers },
    redirect: 'follow',
  });
  if (!res.ok) throw new UserError(`The server answered ${res.status}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new UserError('That response is too large.');
  return buf.toString('utf8');
}

// ---------------------------------------------------------------- Discord helpers shared by modules

/** Turns a Discord API error into something an admin can act on. */
export function describeDiscordError(err, what = 'do that') {
  const code = err?.code ?? err?.rawError?.code;
  switch (code) {
    case 50013: return `I couldn't ${what}: I'm missing a permission there. Check the channel/role permissions for the bot (View Channel, Send Messages, Embed Links, Manage Roles as needed) and that my role is high enough.`;
    case 50001: return `I couldn't ${what}: I can't see that channel (Missing Access). Give me View Channel there.`;
    case 10003: return `I couldn't ${what}: that channel no longer exists.`;
    case 10008: return `I couldn't ${what}: that message no longer exists.`;
    case 10011: return `I couldn't ${what}: that role no longer exists.`;
    case 50035: return `I couldn't ${what}: Discord rejected the content as invalid (${String(err.message).slice(0, 120)}).`;
    case 30005: return `I couldn't ${what}: the server has reached Discord's role limit.`;
    case 30013: case 30034: return `I couldn't ${what}: Discord's limit was reached.`;
    default: return `I couldn't ${what} (${String(err?.message ?? err).slice(0, 140)}).`;
  }
}

/**
 * Slash-command channel options can arrive as raw API objects without methods (.send, .isTextBased).
 * Always resolve them through the guild so you get a real channel.
 */
export async function getChannelOption(interaction, name, required = false) {
  const raw = interaction.options.getChannel(name, required);
  if (!raw) return null;
  const guild = interaction.guild;
  return guild.channels.cache.get(raw.id) ?? (await guild.channels.fetch(raw.id).catch(() => null));
}

const DANGEROUS_BITS = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers', 'ManageWebhooks', 'ManageMessages', 'ModerateMembers', 'MentionEveryone'];

/**
 * Why the bot must NOT hand this role out automatically (null = fine). `actor` adds the
 * "must be below the person configuring it" rule. `P` is discord.js PermissionFlagsBits.
 */
export function roleGrantProblem(guild, role, actor, P) {
  if (!role) return 'That role no longer exists.';
  if (role.id === guild.id) return "@everyone can't be used here.";
  if (role.managed) return `**${role.name}** is managed by an integration.`;
  if (DANGEROUS_BITS.some((b) => role.permissions.has(P[b]))) return `**${role.name}** has powerful permissions (like Administrator, Manage Server/Roles/Channels, ban/kick, timeout, delete messages or @everyone). I won't hand that out automatically.`;
  const me = guild.members.me;
  if (me && role.position >= me.roles.highest.position) return `**${role.name}** is above my highest role - move my role up in Server Settings > Roles.`;
  if (actor && actor.id !== guild.ownerId && role.position >= actor.roles.highest.position) return `**${role.name}** is at or above your own highest role.`;
  return null;
}

// ------------------------------------------------------------------ scheduling & pings (shared by announcements and reminders)
/** "2h", "1d" or "2026-12-31 18:30" (read in the server's timezone offset, in hours) to a timestamp. */
export function parseWhen(input, offsetHours = 0) {
  const ms = parseDuration(input);
  if (ms) return Date.now() + ms;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(String(input).trim());
  if (!m) throw new UserError('Use a delay like `2h` or `1d`, or a date like `2026-12-31 18:30` (in the server\'s timezone offset setting).');
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - offsetHours * 3600000;
}

export const PING_PERMISSION_NAME = '**Mention @everyone, @here, and All Roles**';

/**
 * Why a ping would be silently ignored by Discord in this channel, or null when it will work.
 * ping: 'none' | 'everyone' | 'here' | 'role'.  P is discord.js's PermissionFlagsBits.
 */
export function pingProblem(guild, ch, ping, roleIds, P) {
  if (ping === 'none') return null;
  const me = guild.members.me ?? (ch.client?.user?.id ? guild.members.cache.get(ch.client.user.id) : null);
  // If we cannot work out who the bot is, do not claim a permission is missing: let Discord decide.
  if (!me) return null;
  const canMentionAll = !!ch.permissionsFor?.(me)?.has(P.MentionEveryone);
  if ((ping === 'everyone' || ping === 'here') && !canMentionAll) {
    return `I'm missing the ${PING_PERMISSION_NAME} permission in <#${ch.id}>, so @${ping} would not notify anyone. Give my role that permission (Server Settings > Roles), then post again.`;
  }
  if (ping === 'role') {
    const blocked = (roleIds ?? []).map((id) => guild.roles.cache.get(id)).filter((r) => r && !r.mentionable && !canMentionAll);
    if (blocked.length) return `I can't notify ${blocked.map((r) => `**${r.name}**`).join(', ')}: not mentionable, and I don't have ${PING_PERMISSION_NAME}. Turn on "Allow anyone to @mention this role" for it, or give me that permission.`;
  }
  return null;
}
