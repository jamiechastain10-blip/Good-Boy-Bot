/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Eclipse ID rules: profile fields, who may see what, and checks for gaming account names.
 * Pure functions, plus one network helper (Roblox) that takes an injectable fetch so tests never touch the network.
 *
 * IMPORTANT: a linked game account is only the name a member typed, checked for the right SHAPE for that platform.
 * Nothing here proves the member owns the account.
 */

export const VISIBILITY = ['public', 'staff', 'private'];
export const FIELDS = {
  bio: { label: 'About me', max: 300, default: 'public' },
  games: { label: 'Favourite games', max: 200, default: 'public' },
  platforms: { label: 'Platforms', max: 80, default: 'public' },
  availability: { label: 'Play style and availability', max: 120, default: 'public' },
  region: { label: 'Region or timezone', max: 40, default: 'public' },
  links: { label: 'Linked game accounts', max: 0, default: 'private' },
};
export const PLATFORMS = ['pc', 'playstation', 'xbox', 'switch', 'mobile', 'vr'];

/** Remove pings and control characters; keep it one tidy block of text. */
export const cleanField = (text, max) => String(text ?? '')
  .replace(/<@[&!]?\d+>|@(everyone|here)/gi, '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ')
  .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

export function parsePlatforms(text) {
  const raw = String(text ?? '').toLowerCase().split(/[,;\n]+|\s{2,}/).map((s) => s.trim()).filter(Boolean);
  const aliases = { ps: 'playstation', ps4: 'playstation', ps5: 'playstation', playstation: 'playstation', pc: 'pc', computer: 'pc', xbox: 'xbox', switch: 'switch', nintendo: 'switch', mobile: 'mobile', phone: 'mobile', vr: 'vr' };
  const out = []; const bad = [];
  for (const r of raw) { const k = aliases[r.replace(/\s+/g, '')]; if (!k) bad.push(r); else if (!out.includes(k)) out.push(k); }
  return { platforms: out, unknown: bad };
}

/** Who sees a field: its owner always; staff for "staff" and "public"; everyone for "public". */
export function canSee(visibility, { self = false, staff = false } = {}) {
  if (self) return true;
  if (visibility === 'public') return true;
  if (visibility === 'staff') return staff;
  return false;
}

export const eidLabel = (n) => `EID-${String(n).padStart(6, '0')}`;

// ------------------------------------------------------------------ gaming account links (format checks only)
export const LINK_PLATFORMS = {
  steam: { label: 'Steam', hint: 'profile name (vanity) or 17-digit Steam ID', test: (v) => /^(\d{17}|[A-Za-z0-9_-]{2,32})$/.test(v), url: (v) => (/^\d{17}$/.test(v) ? `https://steamcommunity.com/profiles/${v}` : `https://steamcommunity.com/id/${v}`) },
  xbox: { label: 'Xbox', hint: 'gamertag', test: (v) => /^[A-Za-z0-9][A-Za-z0-9 ]{0,14}$/.test(v) },
  playstation: { label: 'PlayStation', hint: 'PSN ID', test: (v) => /^[A-Za-z][A-Za-z0-9_-]{2,15}$/.test(v) },
  nintendo: { label: 'Nintendo Switch', hint: 'friend code like SW-1234-5678-9012', test: (v) => /^SW-\d{4}-\d{4}-\d{4}$/.test(v), normalize: (v) => v.toUpperCase() },
  epic: { label: 'Epic Games', hint: 'display name', test: (v) => /^[\w .-]{3,32}$/.test(v) },
  riot: { label: 'Riot ID', hint: 'Name#TAG', test: (v) => /^[^#\n]{3,16}#[A-Za-z0-9]{3,5}$/.test(v) },
  battlenet: { label: 'Battle.net', hint: 'BattleTag like Name#1234', test: (v) => /^[\p{L}][\p{L}\p{N}]{2,11}#\d{4,5}$/u.test(v) },
  roblox: { label: 'Roblox', hint: 'username', test: (v) => /^[A-Za-z0-9_]{3,20}$/.test(v) },
  minecraft: { label: 'Minecraft (Java)', hint: 'username', test: (v) => /^[A-Za-z0-9_]{3,16}$/.test(v) },
};

export function normalizeLink(platform, value) {
  const p = LINK_PLATFORMS[platform];
  if (!p) return { error: `Unknown platform. Choose one of: ${Object.keys(LINK_PLATFORMS).join(', ')}.` };
  let v = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/<@[&!]?\d+>|@(everyone|here)/gi, '').trim();
  if (p.normalize) v = p.normalize(v);
  if (!p.test(v)) return { error: `That doesn't look like a ${p.label} ${p.hint}.` };
  return { value: v, url: p.url?.(v) ?? null };
}

/**
 * Look a Roblox username up. UNVERIFIED: written from memory of Roblox's public users API, not tested against it.
 * Any failure (network, status, unexpected shape) returns { error } and nothing is stored.
 */
export async function lookupRoblox(name, fetchImpl = fetch, timeoutMs = 6000) {
  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetchImpl('https://users.roblox.com/v1/usernames/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ usernames: [name], excludeBannedUsers: true }), signal: ctl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return { error: `Roblox answered ${res.status}.` };
    const body = await res.json();
    const hit = Array.isArray(body?.data) ? body.data[0] : null;
    if (!hit) return { found: false };
    if (typeof hit.id !== 'number' && typeof hit.id !== 'string') return { error: 'Roblox sent an answer I did not understand.' };
    return { found: true, id: String(hit.id), name: String(hit.name ?? name), displayName: String(hit.displayName ?? '') };
  } catch (e) { return { error: e?.name === 'AbortError' ? 'Roblox did not answer in time.' : 'I could not reach Roblox.' }; }
}
