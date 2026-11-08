/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
// Puts the Good Boy look on the person's own bot through Discord's API: name, profile picture, banner, app icon and
// description. Each part is tried on its own, so one refusal (for example Discord's limit of two name changes an hour)
// never stops the rest.
const API = 'https://discord.com/api/v10';
export const BRAND = Object.freeze({
  name: 'Good Boy',
  description: 'Good Boy by Basic Ghost Labs. A friendly all-in-one community bot: levels, moderation, tickets, announcements and more.',
});

/** What already matches. `applied` remembers the picture IDs Discord gave back the last time we set them. */
export function brandStatus(v, applied = {}) {
  if (!v?.ok) return null;
  const items = {
    name: v.bot.username === BRAND.name || v.bot.name === BRAND.name,
    avatar: !!v.bot.avatarHash && v.bot.avatarHash === applied.avatar,
    banner: !!v.bot.bannerHash && v.bot.bannerHash === applied.banner,
    icon: !!v.app.icon && v.app.icon === applied.icon,
    description: String(v.app.description ?? '').startsWith(BRAND.description.slice(0, 40)),
  };
  return { items, done: Object.values(items).every(Boolean) };
}

const dataUri = (buf) => `data:image/png;base64,${Buffer.from(buf).toString('base64')}`;
function plain(status, body) {
  const msg = String(body?.message ?? '');
  if (status === 429 || /too fast|rate/i.test(msg) || body?.errors?.username) return 'Discord only allows two name changes an hour. Try again later.';
  if (status === 401) return 'The saved token no longer works. Run setup again.';
  if (status === 403) return 'Discord did not allow this change for this bot.';
  return msg ? `Discord said: ${msg.slice(0, 140)}` : `Discord answered ${status}.`;
}

/** files: { avatar, banner, icon } as Buffers. Returns { results: {part: {ok, error?}}, applied: {avatar, banner, icon} }. */
export async function applyBrand(token, files, current, fetchFn = fetch, { parts = null } = {}) {
  const want = (p) => !parts || parts.includes(p);
  const t = String(token ?? '').trim();
  const call = async (path, body) => {
    const r = await fetchFn(`${API}${path}`, { method: 'PATCH', headers: { Authorization: `Bot ${t}`, 'Content-Type': 'application/json', 'User-Agent': 'GoodBoy (https://basicghostlabs.com, 2.1)' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    let json = null; try { json = await r.json(); } catch { /* empty */ }
    if (!r.ok) { const e = new Error(plain(r.status, json)); e.status = r.status; throw e; }
    return json;
  };
  const results = {}, applied = {};
  const attempt = async (part, fn) => { try { await fn(); results[part] = { ok: true }; } catch (e) { results[part] = { ok: false, error: e.message === 'fetch failed' || e.name === 'TimeoutError' ? 'Could not reach Discord.' : e.message }; } };
  if (want('avatar')) await attempt('avatar', async () => { const u = await call('/users/@me', { avatar: dataUri(files.avatar) }); applied.avatar = u?.avatar ?? null; });
  if (want('banner')) await attempt('banner', async () => { const u = await call('/users/@me', { banner: dataUri(files.banner) }); applied.banner = u?.banner ?? null; });
  if (want('name')) { if (current?.bot?.username !== BRAND.name) await attempt('name', () => call('/users/@me', { username: BRAND.name })); else results.name = { ok: true, skipped: true }; }
  if (want('icon')) await attempt('icon', async () => { const a = await call('/applications/@me', { icon: dataUri(files.icon) }); applied.icon = a?.icon ?? null; });
  if (want('description')) await attempt('description', () => call('/applications/@me', { description: BRAND.description }));
  return { results, applied };
}

/** Licensed (white-label) bots only: their own name and picture. */
const DESCRIPTION_MAX = 400;
const CREDIT_RE = /^Good Boy v[0-9A-Za-z.+-]+ · Basic Ghost Labs$/;
/** The owner's description with the Good Boy credit line kept at the end (the same rule the bot uses). */
export function describeWithCredit(text, version) {
  const line = `Good Boy v${version} · Basic Ghost Labs`;
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && (lines.at(-1).trim() === '' || CREDIT_RE.test(lines.at(-1).trim()))) lines.pop();
  let mine = lines.join('\n').trim();
  const room = DESCRIPTION_MAX - line.length - (mine ? 2 : 0);
  if (mine.length > room) mine = mine.slice(0, Math.max(0, room - 1)).trimEnd() + '…';
  return mine ? `${mine}\n\n${line}` : line;
}

/**
 * A licensed bot's own look: name, picture and banner (the bot's profile) and description (the application).
 * The description always keeps the Good Boy credit line at the end.
 */
export async function applyCustom(token, { name = null, image = null, mime = 'image/png', banner = null, bannerMime = 'image/png', description = null, version = '0.0.0' } = {}, fetchFn = fetch) {
  const auth = { Authorization: `Bot ${String(token ?? '').trim()}`, 'Content-Type': 'application/json' };
  const body = {};
  if (name != null) {
    const n = String(name).trim();
    if (n.length < 2 || n.length > 32) return { ok: false, error: 'A bot name is 2 to 32 characters.' };
    body.username = n;
  }
  if (image) body.avatar = `data:${mime};base64,${Buffer.from(image).toString('base64')}`;
  if (banner) body.banner = `data:${bannerMime};base64,${Buffer.from(banner).toString('base64')}`;
  const send = async (url, payload) => {
    const r = await fetchFn(url, { method: 'PATCH', headers: auth, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) }).catch(() => null);
    if (!r) return { ok: false, error: 'Could not reach Discord.' };
    let json = null; try { json = await r.json(); } catch { /* empty */ }
    return r.ok ? { ok: true } : { ok: false, error: plain(r.status, json) };
  };
  if (Object.keys(body).length) { const r = await send(`${API}/users/@me`, body); if (!r.ok) return r; }
  if (description != null) {
    const r = await send(`${API}/applications/@me`, { description: describeWithCredit(description, version) });
    if (!r.ok) return r;
  }
  return { ok: true };
}
