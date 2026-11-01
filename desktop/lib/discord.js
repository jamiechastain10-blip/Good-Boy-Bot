/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
// What the setup needs from Discord: is this token real, what is the bot called, which privileged intents are on,
// and the links people need. Only discord.com is ever contacted, and the token is only sent there.
const API = 'https://discord.com/api/v10';

// Same permissions as scripts/inviteLib.js (tests check they match): only what the modules use, no Administrator.
const BITS = [1, 2, 4, 6, 7, 10, 11, 17, 13, 14, 15, 16, 20, 21, 28, 40];
export const PERMISSIONS = BITS.reduce((n, b) => n | (1n << BigInt(b)), 0n).toString();

export const isSnowflake = (s) => /^\d{17,20}$/.test(String(s ?? ''));
export function inviteUrl(appId) {
  if (!isSnowflake(appId)) return null;
  return `https://discord.com/oauth2/authorize?client_id=${appId}&scope=${encodeURIComponent('bot applications.commands')}&permissions=${PERMISSIONS}`;
}
/** The only outside pages the setup opens. Built here from an app ID, never taken from the window. */
export function linkFor(kind, appId) {
  const app = isSnowflake(appId) ? `https://discord.com/developers/applications/${appId}` : null;
  switch (kind) {
    case 'portal': return 'https://discord.com/developers/applications';
    case 'bot': return app ? `${app}/bot` : 'https://discord.com/developers/applications';
    case 'oauth': return app ? `${app}/oauth2` : 'https://discord.com/developers/applications';
    case 'invite': return inviteUrl(appId);
    default: return null;
  }
}

// Application flags for the privileged intents (each has a full and a "limited" bit).
const FLAG = { presence: [1 << 12, 1 << 13], members: [1 << 14, 1 << 15], messageContent: [1 << 18, 1 << 19] };
export function intentsFrom(flags) {
  const f = Number(flags) || 0;
  return Object.fromEntries(Object.entries(FLAG).map(([k, bits]) => [k, bits.some((b) => (f & b) !== 0)]));
}

export function avatarUrl(user) {
  if (!user?.id) return null;
  return user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(user.id) >> 22n) % 6n)}.png`;
}

/** Checks a bot token with Discord. Returns plain-English results; never returns the token. */
export async function verifyToken(token, fetchFn = fetch) {
  const t = String(token ?? '').trim();
  if (!t) return { ok: false, kind: 'empty', error: 'Paste your Discord bot token.' };
  const call = async (p) => {
    const r = await fetchFn(`${API}${p}`, { headers: { Authorization: `Bot ${t}`, 'User-Agent': 'GoodBoy (https://basicghostlabs.com, 2.1)' }, signal: AbortSignal.timeout(10000) });
    if (r.status === 401) { const e = new Error('invalid'); e.kind = 'invalid'; throw e; }
    if (r.status === 429) { const e = new Error('slow'); e.kind = 'slow'; throw e; }
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.kind = 'other'; throw e; }
    return r.json();
  };
  try {
    const me = await call('/users/@me');
    if (!me?.bot) return { ok: false, kind: 'notbot', error: 'That is a user account token, not a bot token. Use the token from the Bot page.' };
    const [app, guilds] = await Promise.all([call('/applications/@me').catch(() => null), call('/users/@me/guilds?limit=200').catch(() => null)]);
    return {
      ok: true,
      bot: { id: me.id, name: me.global_name || me.username, username: me.username, avatar: avatarUrl(me), avatarHash: me.avatar ?? null, bannerHash: me.banner ?? null },
      app: { id: app?.id ?? me.id, name: app?.name ?? me.username, icon: app?.icon ?? null, description: String(app?.description ?? '').slice(0, 400), redirectUris: Array.isArray(app?.redirect_uris) ? app.redirect_uris.map(String) : null },
      intents: app ? intentsFrom(app.flags) : null,
      guilds: Array.isArray(guilds) ? guilds.map((g) => ({ id: g.id, name: String(g.name ?? '').slice(0, 100) })) : null,
    };
  } catch (e) {
    if (e.kind === 'invalid') return { ok: false, kind: 'invalid', error: 'Discord says this token is not valid. Reset it in the Developer Portal and paste the new one.' };
    if (e.kind === 'slow') return { ok: false, kind: 'slow', error: 'Discord asked us to slow down. Try again in a few seconds.' };
    if (e.kind === 'other') return { ok: false, kind: 'other', error: `Discord could not check the token right now (${e.message}). Try again in a moment.` };
    return { ok: false, kind: 'network', error: 'Could not reach Discord. Check your internet connection and try again.' };
  }
}

/** A bot token's first part is the bot's ID in base64 (the same as its application ID). */
export function appIdFromToken(token) {
  try { const id = Buffer.from(String(token ?? '').split('.')[0], 'base64').toString('utf8'); return isSnowflake(id) ? id : null; } catch { return null; }
}

/** The address Discord must send people back to after the dashboard login (same rule as the dashboard itself). */
export function redirectUriFor(settings = {}) {
  const port = Number(settings.DASHBOARD_PORT) > 0 && Number(settings.DASHBOARD_PORT) < 65536 ? Number(settings.DASHBOARD_PORT) : 3000;
  let base = `http://localhost:${port}`;
  try {
    const u = new URL(String(settings.DASHBOARD_BASE_URL ?? '').trim().replace(/^["']|["']$/g, ''));
    if (['http:', 'https:'].includes(u.protocol)) base = u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''));
  } catch { /* default */ }
  return `${base}/callback`;
}
