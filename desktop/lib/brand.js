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
export async function applyCustom(token, { name = null, image = null, mime = 'image/png' } = {}, fetchFn = fetch) {
  const body = {};
  if (name != null) {
    const n = String(name).trim();
    if (n.length < 2 || n.length > 32) return { ok: false, error: 'A bot name is 2 to 32 characters.' };
    body.username = n;
  }
  if (image) body.avatar = `data:${mime};base64,${Buffer.from(image).toString('base64')}`;
  if (!Object.keys(body).length) return { ok: true };
  const r = await fetchFn(`${API}/users/@me`, { method: 'PATCH', headers: { Authorization: `Bot ${String(token ?? '').trim()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }).catch(() => null);
  if (!r) return { ok: false, error: 'Could not reach Discord.' };
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return r.ok ? { ok: true } : { ok: false, error: plain(r.status, json) };
}
