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
 * The one dashboard link (3.0.6): the hub's own address is a dashboard home page like other bots have. People sign in
 * with Discord, see every server they're in that has a Good Boy bot, and "Manage" opens that bot's dashboard on that
 * server (the bot's dashboard signs them in through Discord again, which is instant because Discord remembers them).
 *   GET /           sign-in page, or the server list when signed in
 *   GET /login      -> Discord;  GET /callback <- Discord;  GET /logout
 * Needs DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET (wrangler secret put ...) and the redirect <hub>/callback added to
 * that Discord application. Sessions live in KV for 7 days and hold only the user's name, picture and server list.
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
  if (request.method === 'GET' && path === '/v1') return json({ ok: true, service: 'Good Boy hub' });
  if (request.method === 'GET' && ['/', '/login', '/callback', '/logout', '/servers'].includes(path)) return web(request, env, path, { fetchFn, now });
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
// ------------------------------------------------------------------ the one dashboard link (web pages)
const SESSION_TTL = 7 * 86400;
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cookies = (req) => Object.fromEntries((req.headers.get('cookie') ?? '').split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
const cookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
const MANAGE = 0x20n, ADMIN = 0x8n;
const canManage = (g) => g.owner || ((BigInt(g.permissions ?? '0') & (MANAGE | ADMIN)) !== 0n);

function page(title, body, { status = 200, headers = {} } = {}) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#0f131c;--panel:#151a26;--panel2:#1b2130;--line:rgba(160,180,230,.12);--text:#e9edf5;--muted:#8b97ab;--accent:#6b93ff;--good:#3ba55d;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 "Segoe UI",system-ui,-apple-system,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:14px max(20px,env(safe-area-inset-left));border-bottom:1px solid var(--line)}
header img{width:30px;height:30px;border-radius:8px}header b{font-size:16px}header .sp{flex:1}header a{color:var(--muted);text-decoration:none;font-size:14px}
.av{width:28px;height:28px;border-radius:50%;vertical-align:middle;margin-right:8px}
main{max-width:1040px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:28px;margin:0 0 6px;letter-spacing:-.01em}.sub{color:var(--muted);margin:0 0 22px}
.btn{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:#0b1020;font-weight:700;text-decoration:none;border-radius:10px;padding:12px 20px}
.btn.ghost{background:transparent;color:var(--text);border:1px solid var(--line);font-weight:600}
.hero{text-align:center;padding:70px 0 40px}.hero img{width:84px;height:84px;border-radius:22px;margin-bottom:14px}.hero p{color:var(--muted);max-width:520px;margin:8px auto 26px}
input[type=search]{width:100%;max-width:420px;background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 14px;font:inherit;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px;min-width:0}
.card .top{display:flex;align-items:center;gap:12px;min-width:0}.card .top div{min-width:0}
.gi{width:48px;height:48px;border-radius:14px;background:var(--panel2);display:grid;place-items:center;font-weight:800;color:var(--accent);flex:none;object-fit:cover}
.card b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.card small{color:var(--muted)}
.card .btn{justify-content:center;padding:9px 14px}.tag{font-size:12px;color:var(--good)}
h2{font-size:15px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:34px 0 12px}
.empty{background:var(--panel);border:1px dashed var(--line);border-radius:14px;padding:22px;color:var(--muted)}
footer{color:var(--muted);font-size:13px;text-align:center;margin-top:40px}footer a{color:var(--muted)}
</style></head><body>${body}</body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; img-src https://cdn.discordapp.com data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'", ...headers } });
}
const LOGO = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#6b93ff"/><text x="32" y="43" font-size="32" text-anchor="middle" font-family="Segoe UI,sans-serif" font-weight="800" fill="#0b1020">GB</text></svg>');
const head = (user) => `<header><img src="${LOGO}" alt=""><b>Good Boy</b><span class="sp"></span>${user ? `<span>${user.avatar ? `<img class="av" src="https://cdn.discordapp.com/avatars/${esc(user.id)}/${esc(user.avatar)}.png?size=64" alt="">` : ''}${esc(user.name)}</span> <a href="/logout">Log out</a>` : ''}</header>`;

async function web(request, env, path, { fetchFn, now }) {
  const kv = env.HUB, origin = new URL(request.url).origin, redirect = `${origin}/callback`;
  const ready = !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);
  const sid = cookies(request).gbh;
  const sess = sid ? JSON.parse((await kv.get(`sess:${sid}`)) ?? 'null') : null;

  if (path === '/logout') { if (sid) await kv.delete(`sess:${sid}`); return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': cookie('gbh', '', 0) } }); }
  if (path === '/login') {
    if (!ready) return page('Good Boy', `${head()}<main><div class="empty">Sign-in isn't set up on this hub yet. The hub owner adds DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET (see hub/README.md).</div></main>`, { status: 503 });
    const state = crypto.randomUUID();
    const q = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: 'code', redirect_uri: redirect, scope: 'identify guilds', state });
    return new Response(null, { status: 302, headers: { Location: `https://discord.com/oauth2/authorize?${q}`, 'Set-Cookie': cookie('gbh_state', state, 600) } });
  }
  if (path === '/callback') {
    const u = new URL(request.url), code = u.searchParams.get('code'), state = u.searchParams.get('state');
    if (u.searchParams.get('error')) return new Response(null, { status: 302, headers: { Location: '/' } });
    if (!code || !state || state !== cookies(request).gbh_state) return page('Sign-in expired', `${head()}<main><h1>That sign-in expired</h1><p class="sub">Start again and finish within 10 minutes, in the same browser.</p><a class="btn" href="/login">Sign in with Discord</a></main>`, { status: 400 });
    const tok = await fetchFn('https://discord.com/api/v10/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: redirect }) }).catch(() => null);
    const t = tok?.ok ? await tok.json() : null;
    if (!t?.access_token) return page('Sign-in failed', `${head()}<main><h1>Discord didn't finish the sign-in</h1><p class="sub">If this keeps happening, check that ${esc(redirect)} is in the Discord application's Redirects.</p><a class="btn" href="/login">Try again</a></main>`, { status: 502 });
    const auth = { Authorization: `Bearer ${t.access_token}` };
    const [me, gs] = await Promise.all([fetchFn('https://discord.com/api/v10/users/@me', { headers: auth }).then((r) => r.json()), fetchFn('https://discord.com/api/v10/users/@me/guilds', { headers: auth }).then((r) => r.json())]);
    if (!me?.id || !Array.isArray(gs)) return page('Sign-in failed', `${head()}<main><h1>Couldn't read your Discord account</h1><a class="btn" href="/login">Try again</a></main>`, { status: 502 });
    const id = crypto.randomUUID().replace(/-/g, '');
    const data = { user: { id: me.id, name: me.global_name ?? me.username, avatar: me.avatar ?? null }, guilds: gs.slice(0, 200).map((g) => ({ id: g.id, name: String(g.name).slice(0, 100), icon: g.icon ?? null, manage: canManage(g) })), at: now };
    await kv.put(`sess:${id}`, JSON.stringify(data), { expirationTtl: SESSION_TTL });
    const hd = new Headers({ Location: '/' }); hd.append('Set-Cookie', cookie('gbh', id, SESSION_TTL)); hd.append('Set-Cookie', cookie('gbh_state', '', 0));
    return new Response(null, { status: 302, headers: hd });
  }

  if (!sess) {
    return page('Good Boy', `${head()}<main><section class="hero"><img src="${LOGO}" alt=""><h1>Good Boy dashboard</h1>
<p>Sign in with Discord to see every server you're in that runs a Good Boy bot, and manage it from here.</p>
${ready ? '<a class="btn" href="/login">Sign in with Discord</a>' : '<div class="empty">Sign-in isn\'t set up on this hub yet.</div>'}</section>
<footer>Good Boy only sees your name, picture and server list. Each server is managed on its own bot's dashboard.</footer></main>`);
  }

  // Which of their servers have a Good Boy bot (and where its dashboard is).
  const found = new Map(), apps = new Map();
  for (const g of sess.guilds) {
    for (const appId of JSON.parse((await kv.get(`guild:${g.id}`)) ?? '[]')) {
      if (!apps.has(appId)) apps.set(appId, JSON.parse((await kv.get(`app:${appId}`)) ?? 'null'));
      const a = apps.get(appId);
      if (a && now - a.updatedAt < STALE_MS && a.guilds.includes(g.id)) (found.get(g.id) ?? found.set(g.id, []).get(g.id)).push(a);
    }
  }
  const icon = (g) => (g.icon ? `<img class="gi" src="https://cdn.discordapp.com/icons/${esc(g.id)}/${esc(g.icon)}.png?size=96" alt="">` : `<span class="gi">${esc(g.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase())}</span>`);
  const withBot = sess.guilds.filter((g) => found.has(g.id)).sort((a, b) => Number(b.manage) - Number(a.manage) || a.name.localeCompare(b.name));
  const card = (g) => found.get(g.id).map((a) => `<div class="card" data-name="${esc(g.name.toLowerCase())}"><div class="top">${icon(g)}<div><b>${esc(g.name)}</b><small>${esc(a.name)}${g.manage ? ' · <span class="tag">you can manage</span>' : ''}</small></div></div><a class="btn${g.manage ? '' : ' ghost'}" href="${esc(a.url)}/?guild=${esc(g.id)}">${g.manage ? 'Manage' : 'Open'}</a></div>`).join('');
  const others = sess.guilds.filter((g) => !found.has(g.id) && g.manage);
  return page('Good Boy · your servers', `${head(sess.user)}<main><h1>Your servers</h1><p class="sub">Servers you're in that run a Good Boy bot. <a href="/login" style="color:var(--accent)">Refresh the list</a></p>
${withBot.length > 6 ? '<input type="search" id="q" placeholder="Find a server" aria-label="Find a server">' : ''}
${withBot.length ? `<div class="grid" id="list">${withBot.map(card).join('')}</div>` : '<div class="empty">None of your servers run a Good Boy bot that has joined this hub yet. A bot joins once its owner turns on its public dashboard link.</div>'}
${others.length ? `<h2>Servers you manage without Good Boy</h2><div class="grid">${others.slice(0, 24).map((g) => `<div class="card"><div class="top">${icon(g)}<div><b>${esc(g.name)}</b><small>No Good Boy bot here yet</small></div></div></div>`).join('')}</div>` : ''}
<footer>Signed in as ${esc(sess.user.name)}. Your server list is from when you signed in; refresh it after joining new servers.</footer></main>
<script>const q=document.getElementById('q');if(q)q.addEventListener('input',()=>{const v=q.value.trim().toLowerCase();document.querySelectorAll('#list .card').forEach((c)=>{c.hidden=v&&!c.dataset.name.includes(v);});});</script>`);
}

async function index(kv, g, appId) { const l = JSON.parse((await kv.get(`guild:${g}`)) ?? '[]'); if (!l.includes(appId)) { l.push(appId); await kv.put(`guild:${g}`, JSON.stringify(l.slice(-20))); } }
async function unindex(kv, g, appId) { const l = JSON.parse((await kv.get(`guild:${g}`)) ?? '[]').filter((x) => x !== appId); if (l.length) await kv.put(`guild:${g}`, JSON.stringify(l)); else await kv.delete(`guild:${g}`); }

export default { fetch: (request, env) => handle(request, env) };
