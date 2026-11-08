/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * The Good Boy hub: a tiny Cloudflare Worker that lets Good Boy bots find each other, so the server switcher can show
 * servers run by other people's Good Boy bots. It stores, for each bot: its Discord application ID, the IDs of the
 * servers it is in, its dashboard link and a public key. No members, no roles, no messages.
 *
 * Proving a bot is who it says: the first time, the hub hands out a one-time code, the bot puts "gb-hub:<code>" in its
 * Discord description for a moment, and the hub reads that description from Discord's public page for the app. That
 * proves control of the bot. From then on the bot signs every update with its own key.
 *
 *   POST /v1/challenge { appId }                          -> { nonce }
 *   POST /v1/register  { appId, publicKey, url, guilds, at, sig, nonce? }
 *   POST /v1/lookup    { guilds: [ids] }                  -> { bots: [{ guildId, appId, name, url }] }
 *   POST /v1/leave     { appId, at, sig }
 *
 * Deploy: see hub/README.md (needs a free Cloudflare account and one KV namespace bound as HUB).
 */
const ID = /^\d{17,20}$/;
const STALE_MS = 3 * 86400000, SKEW_MS = 10 * 60000, MAX_GUILDS = 2000, MAX_LOOKUP = 200;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** What gets signed: the same fields in the same order every time. */
export const signedText = (b) => JSON.stringify({ appId: b.appId, url: b.url ?? null, guilds: b.guilds ?? null, at: b.at, leave: !!b.leave });

async function verify(publicKey, text, sig) {
  try {
    const key = await crypto.subtle.importKey('spki', b64(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, b64(sig), new TextEncoder().encode(text));
  } catch { return false; }
}
const cleanUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(x.hostname) ? x.origin : null; } catch { return null; } };

export async function handle(request, env, { fetchFn = fetch, now = Date.now() } = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST' } });
  const path = new URL(request.url).pathname;
  if (request.method === 'GET' && path === '/') return json({ ok: true, service: 'Good Boy hub' });
  if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  let b; try { b = await request.json(); } catch { return json({ error: 'Bad JSON.' }, 400); }
  const kv = env.HUB;

  if (path === '/v1/challenge') {
    if (!ID.test(String(b.appId))) return json({ error: 'Bad application ID.' }, 400);
    const nonce = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    await kv.put(`nonce:${b.appId}`, nonce, { expirationTtl: 600 });
    return json({ nonce });
  }

  if (path === '/v1/register' || path === '/v1/leave') {
    const leave = path === '/v1/leave';
    if (!ID.test(String(b.appId))) return json({ error: 'Bad application ID.' }, 400);
    if (!Number.isFinite(b.at) || Math.abs(now - b.at) > SKEW_MS) return json({ error: 'The clock on the bot\'s computer is wrong, or this request is old.' }, 400);
    const known = JSON.parse((await kv.get(`app:${b.appId}`)) ?? 'null');
    if (leave) {
      if (!known || !(await verify(known.publicKey, signedText({ ...b, leave: true }), b.sig))) return json({ error: 'Not signed by this bot.' }, 403);
      for (const g of known.guilds) await unindex(kv, g, b.appId);
      await kv.delete(`app:${b.appId}`);
      return json({ ok: true });
    }
    const url = cleanUrl(b.url);
    if (!url) return json({ error: 'The dashboard link must be a public https link.' }, 400);
    const guilds = [...new Set((Array.isArray(b.guilds) ? b.guilds : []).map(String).filter((g) => ID.test(g)))].slice(0, MAX_GUILDS);
    let publicKey = known?.publicKey;
    if (!known || known.publicKey !== b.publicKey) {
      // New bot, or a new key: prove control of the bot through its Discord description.
      const nonce = await kv.get(`nonce:${b.appId}`);
      if (!nonce || b.nonce !== nonce) return json({ error: 'Ask for a code first (/v1/challenge).', needsProof: true }, 403);
      const r = await fetchFn(`https://discord.com/api/v10/applications/${b.appId}/rpc`).catch(() => null);
      const app = r?.ok ? await r.json() : null;
      if (!String(app?.description ?? '').includes(`gb-hub:${nonce}`)) return json({ error: 'The code was not in the bot\'s Discord description.', needsProof: true }, 403);
      await kv.delete(`nonce:${b.appId}`);
      publicKey = b.publicKey;
      b.name = app.name;
    }
    if (!(await verify(publicKey, signedText({ ...b, url: b.url, guilds: b.guilds }), b.sig))) return json({ error: 'Not signed by this bot.' }, 403);
    const before = new Set(known?.guilds ?? []);
    for (const g of before) if (!guilds.includes(g)) await unindex(kv, g, b.appId);
    for (const g of guilds) if (!before.has(g)) await index(kv, g, b.appId);
    await kv.put(`app:${b.appId}`, JSON.stringify({ appId: b.appId, name: String(b.name ?? known?.name ?? 'Good Boy').slice(0, 80), publicKey, url, guilds, updatedAt: now }));
    return json({ ok: true, guilds: guilds.length });
  }

  if (path === '/v1/lookup') {
    const ids = [...new Set((Array.isArray(b.guilds) ? b.guilds : []).map(String).filter((g) => ID.test(g)))].slice(0, MAX_LOOKUP);
    const bots = [];
    const apps = new Map();
    for (const g of ids) {
      for (const appId of JSON.parse((await kv.get(`guild:${g}`)) ?? '[]')) {
        if (!apps.has(appId)) apps.set(appId, JSON.parse((await kv.get(`app:${appId}`)) ?? 'null'));
        const a = apps.get(appId);
        if (a && now - a.updatedAt < STALE_MS && a.guilds.includes(g)) bots.push({ guildId: g, appId, name: a.name, url: a.url });
      }
    }
    return json({ bots });
  }
  return json({ error: 'Not found.' }, 404);
}
async function index(kv, g, appId) { const l = JSON.parse((await kv.get(`guild:${g}`)) ?? '[]'); if (!l.includes(appId)) { l.push(appId); await kv.put(`guild:${g}`, JSON.stringify(l.slice(-20))); } }
async function unindex(kv, g, appId) { const l = JSON.parse((await kv.get(`guild:${g}`)) ?? '[]').filter((x) => x !== appId); if (l.length) await kv.put(`guild:${g}`, JSON.stringify(l)); else await kv.delete(`guild:${g}`); }

export default { fetch: (request, env) => handle(request, env) };
