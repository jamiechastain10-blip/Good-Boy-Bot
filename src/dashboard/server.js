/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Local web dashboard. Binds to 127.0.0.1 by default so only this computer can reach it.
 * Every API call re-verifies, against the live server, that the logged-in user may manage that server.
 *
 * Login diagnostics: failures never show a blank page. Each failure stage maps to a readable
 * message and a retry link, and a sanitized line (stage, HTTP status, Discord error code - never
 * secrets, codes or tokens) is written to the log. Visit /auth/diagnose to see the exact values to configure.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNOWFLAKE, UserError } from '../util.js';
import { renderLegal } from '../legal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/glass.css': ['glass.css', 'text/css; charset=utf-8'],
  '/good-boy-logo.png': ['good-boy-logo.png', 'image/png'],
  '/favicon.ico': ['good-boy-logo.png', 'image/png'],
};
// Files that never change between releases can be cached by the browser; the rest are re-checked every load.
const CACHEABLE = new Set(['/good-boy-logo.png', '/favicon.ico']);
const MANAGE_GUILD = 0x20n, ADMIN = 0x8n;
const SESSION_MS = 12 * 3600 * 1000;
const STATE_MS = 10 * 60 * 1000;
const DISCORD = 'https://discord.com/api/v10';
const SCOPES = ['identify', 'guilds'];
const MAX_SESSIONS = 500;

const parseCookies = (h = '') => Object.fromEntries(h.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Turns whatever is in the environment into a clean absolute base URL (no trailing slash, http/https only). */
export function normalizeBase(raw, port) {
  const fallback = `http://localhost:${port}`;
  try {
    const u = new URL(String(raw ?? '').trim().replace(/^["']|["']$/g, ''));
    if (!['http:', 'https:'].includes(u.protocol)) return fallback;
    return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''));
  } catch { return fallback; }
}

/** Maps Discord's OAuth error codes to what the operator should actually do. */
export function explainTokenError(status, code, redirectUri) {
  if (code === 'invalid_client' || status === 401) return { title: 'Discord rejected the client secret', hint: 'The DISCORD_CLIENT_SECRET in your .env does not match this application. In the Developer Portal open OAuth2, reset the Client Secret, paste the new one into .env, and restart. (Secrets are shown only once.)' };
  if (code === 'invalid_grant') return { title: 'The login code was not accepted', hint: `The code expired, was already used, or the redirect URL differs from the one used at the start. The redirect URL must match EXACTLY, character for character: ${redirectUri}. Just try logging in again.` };
  if (code === 'invalid_request' || code === 'invalid_scope') return { title: 'Discord rejected the login request', hint: `Discord reported "${code}". Make sure this redirect URL is listed under OAuth2 > Redirects exactly: ${redirectUri}` };
  if (status === 429) return { title: 'Discord is rate limiting logins', hint: 'Wait a minute and try again.' };
  return { title: 'Discord could not complete the login', hint: `Discord answered with status ${status}${code ? ` (${code})` : ''}. Try again; if it keeps happening, open /auth/diagnose.` };
}

export async function startDashboard({ manager, client, db, logger, perms, dataDir = null, updates = null, port: portOverride, host: hostOverride, fetchImpl = fetch, version = '0.0.0' }) {
  const port = portOverride ?? Number(process.env.DASHBOARD_PORT || 3000);
  const host = hostOverride ?? process.env.DASHBOARD_HOST ?? '127.0.0.1';
  // Only when the dashboard sits behind a tunnel or proxy you run yourself: believe the host it reports for the browser.
  const trustProxy = /^(1|true|yes|on)$/i.test(String(process.env.DASHBOARD_TRUST_PROXY ?? ''));
  const requestHost = (req) => (trustProxy && String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim()) || req.headers.host;
  const secret = process.env.DISCORD_CLIENT_SECRET?.trim().replace(/^["']|["']$/g, '');
  const legalDataDir = dataDir ?? process.env.GOODBOY_DATA_DIR ?? null;
  const sessions = new Map();
  const states = new Map();
  const hookHits = new Map();
  let base = normalizeBase(process.env.DASHBOARD_BASE_URL, port); // refined below if the OS picks the port
  const redirectUri = () => `${base}/callback`;
  const origin = () => new URL(base).origin;
  const secure = () => base.startsWith('https');

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
    for (const [k, v] of states) if (v < now) states.delete(k);
    hookHits.clear();
  }, 60000);
  cleanup.unref?.();

  const send = (res, status, body, headers = {}) => { res.writeHead(status, headers); res.end(body); };
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });

  /** A readable page for every login failure (never a blank screen). */
  function errorPage(res, status, title, message, hint) {
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Good Boy - ${esc(title)}</title>
<style>body{margin:0;background:#0f1117;color:#e8eaf0;font:16px/1.55 system-ui,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh}
main{max-width:560px;padding:28px;background:#181b24;border:1px solid #2a2f3d;border-radius:12px;margin:16px}h1{margin:0 0 8px;font-size:22px}p{margin:8px 0}
.hint{color:#aeb4c4;font-size:14px;background:#10131b;border-radius:8px;padding:10px 12px;word-break:break-word}a.b{display:inline-block;margin:14px 8px 0 0;background:#5865f2;color:#fff;padding:9px 16px;border-radius:7px;text-decoration:none}a.g{background:#2a2f3d}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p>${hint ? `<p class="hint">${esc(hint)}</p>` : ''}
<a class="b" href="/login">Try logging in again</a><a class="b g" href="/auth/diagnose">Login diagnostics</a><a class="b g" href="/">Back</a></main></body></html>`;
    send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
  }

  const authFail = (res, stage, status, title, message, hint, extra = '') => {
    logger.warn(`Dashboard login failed: stage=${stage} status=${status}${extra ? ' ' + extra : ''}`);
    errorPage(res, status >= 500 ? 502 : 400, title, message, hint);
  };

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > 100_000) throw new UserError('Request too large.'); chunks.push(c); }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new UserError('Invalid JSON.'); }
  }

  const session = (req) => {
    const sid = parseCookies(req.headers.cookie).gb_sid;
    const s = sid && sessions.get(sid);
    return s && s.expires > Date.now() ? s : null;
  };

  /**
   * What this person may do in this server, decided live from Discord every time:
   *   'admin' - owner, Administrator or Manage Server: everything.
   *   'panel' - holds the dashboard.access permission: only the panels whose own permission they also hold.
   *   null    - nothing.
   */
  const accessOf = (member) => (perms.isAdmin(member) ? 'admin' : perms.check(member, 'dashboard.access') ? 'panel' : null);

  /** `level: 'admin'` (default) for settings and anything that changes the setup; `'panel'` also lets panel users in. */
  async function authorize(req, res, guildId, { level = 'admin' } = {}) {
    const s = session(req);
    if (!s) { json(res, 401, { error: 'Not logged in.' }); return null; }
    if (!SNOWFLAKE.test(guildId)) { json(res, 400, { error: 'Bad server id.' }); return null; }
    const guild = client.guilds.cache.get(guildId);
    if (!guild) { json(res, 404, { error: "I'm not in that server." }); return null; }
    const member = await guild.members.fetch(s.user.id).catch(() => null);
    const access = member ? accessOf(member) : null;
    if (!access || (level === 'admin' && access !== 'admin')) {
      json(res, 403, { error: access === 'panel' ? 'That part of the dashboard needs Manage Server permission.' : 'You need Manage Server permission there, or the dashboard.access permission.' });
      return null;
    }
    return { s, guild, member, access };
  }

  /** Is this view or action part of a panel the person is allowed to use? (Admins are never asked.) */
  function panelAllows(a, moduleName, kind, name) {
    if (a.access === 'admin') return true;
    const mod = manager.describeForGuild(a.guild.id).find((d) => d.name === moduleName && d.enabled);
    return !!mod?.panels?.some((p) => p.permission && perms.check(a.member, p.permission) && (kind === 'view'
      ? p.view === name
      : [...(p.rowActions ?? []), ...(p.globalActions ?? [])].some((x) => x.action === name)));
  }

  const sameOrigin = (req) => {
    if (req.headers['x-goodboy'] !== '1') return false;
    const o = req.headers.origin;
    return !o || o === origin();
  };

  const timed = (url, opts = {}) => fetchImpl(url, { ...opts, signal: AbortSignal.timeout(10000) });

  /** Diagnostic values an operator needs, with NO secrets in them. */
  function diagnostics() {
    return {
      version,
      baseUrl: base,
      redirectUriToRegister: redirectUri(),
      scopes: SCOPES.join(' '),
      clientId: client.user?.id ?? null,
      clientSecretConfigured: !!secret,
      clientSecretLooksPlausible: !!secret && secret.length >= 24 && !/\s/.test(secret),
      cookiesMarkedSecure: secure(),
      listening: `${host}:${port}`,
      checklist: [
        `Developer Portal > OAuth2 > Redirects contains EXACTLY: ${redirectUri()}`,
        'DISCORD_CLIENT_SECRET in .env is the OAuth2 "Client Secret" (not the bot token, not the public key).',
        'Open the dashboard at the Base URL shown here (localhost and 127.0.0.1 are different sites to a browser).',
        'Behind an HTTPS reverse proxy: set DASHBOARD_BASE_URL to the public https URL and register that redirect.',
      ],
    };
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://placeholder');
    const p = url.pathname;

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https://cdn.discordapp.com data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");

    // Browsers treat localhost and 127.0.0.1 as different sites; keep everyone on the configured one so cookies line up.
    if (req.method === 'GET' && ['/', '/login', '/auth/diagnose'].includes(p) && requestHost(req) && requestHost(req) !== new URL(base).host) {
      return send(res, 302, '', { Location: `${base}${p}${url.search}` });
    }

    if (p === '/healthz') return json(res, 200, { ok: true, version });

    // Public policy pages: no login needed, so they can be given to Discord as the Terms and Privacy URLs.
    if (req.method === 'GET' && (p === '/terms' || p === '/privacy')) {
      return send(res, 200, renderLegal(p.slice(1), { dataDir: legalDataDir }), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    }

    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, file)), { 'Content-Type': type, 'Cache-Control': CACHEABLE.has(p) ? 'public, max-age=86400' : 'no-cache' });
    }

    if (p === '/auth/diagnose' && req.method === 'GET') {
      const d = diagnostics();
      const rows = Object.entries(d).filter(([k]) => k !== 'checklist').map(([k, v]) => `<tr><td>${esc(k)}</td><td><code>${esc(v)}</code></td></tr>`).join('');
      const body = `<!doctype html><meta charset="utf-8"><title>Good Boy - login diagnostics</title><style>body{background:#0f1117;color:#e8eaf0;font:15px/1.5 system-ui;max-width:760px;margin:30px auto;padding:0 16px}td{padding:5px 10px;border-bottom:1px solid #2a2f3d;vertical-align:top}code{color:#9ecbff;word-break:break-all}</style>
<h2>Login diagnostics</h2><table>${rows}</table><h3>Checklist</h3><ol>${d.checklist.map((c) => `<li>${esc(c)}</li>`).join('')}</ol><p><a style="color:#9ecbff" href="/login">Try logging in</a></p>`;
      return send(res, 200, body, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    }

    // ---- OAuth: start
    if (p === '/login' && req.method === 'GET') {
      if (!secret) return errorPage(res, 503, 'Dashboard login is not set up', 'No DISCORD_CLIENT_SECRET is configured, so Discord login is disabled. Slash commands still work.', 'Add the OAuth2 Client Secret to your .env file and restart. See /auth/diagnose for the exact values.');
      if (!client.user?.id) return errorPage(res, 503, 'The bot is still starting', 'Give it a few seconds and try again.');
      const state = crypto.randomBytes(24).toString('base64url');
      states.set(state, Date.now() + STATE_MS);
      const q = new URLSearchParams({ client_id: client.user.id, response_type: 'code', redirect_uri: redirectUri(), scope: SCOPES.join(' '), state });
      // No `prompt` parameter: `prompt=none` makes Discord refuse first-time logins. Discord shows its consent screen once, then remembers.
      return send(res, 302, '', {
        Location: `https://discord.com/oauth2/authorize?${q}`,
        'Set-Cookie': `gb_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${STATE_MS / 1000}${secure() ? '; Secure' : ''}`,
        'Cache-Control': 'no-store',
      });
    }

    // ---- OAuth: return from Discord
    if (p === '/callback' && req.method === 'GET') {
      const oauthError = url.searchParams.get('error');
      if (oauthError) {
        const denied = oauthError === 'access_denied';
        return authFail(res, 'authorize', 400, denied ? 'Login cancelled' : 'Discord refused the login',
          denied ? 'You chose not to authorise Good Boy, so nothing was changed.' : `Discord reported "${oauthError}"${url.searchParams.get('error_description') ? `: ${url.searchParams.get('error_description')}` : ''}.`,
          denied ? undefined : `If this mentions the redirect URL, register exactly: ${redirectUri()}`, `error=${oauthError.slice(0, 40)}`);
      }
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const cookieState = parseCookies(req.headers.cookie).gb_state;
      if (!code || !state) return authFail(res, 'callback', 400, 'Incomplete login response', 'Discord did not send back the information needed to finish logging in.', 'Start again from the login button.', 'missing code/state');
      if (!states.has(state) || states.get(state) < Date.now()) return authFail(res, 'state', 400, 'Login link expired', 'This login attempt is too old or was already used.', 'Start again; finish the login within 10 minutes. If you restarted the bot during login, that also invalidates it.', 'state unknown/expired');
      if (!cookieState || cookieState !== state) return authFail(res, 'state', 400, 'Login could not be matched to this browser', 'The browser that finished the login is not the one that started it, or it blocks cookies.', `Use the Base URL ${base} for the whole login (not 127.0.0.1 vs localhost), and allow cookies.`, 'state cookie mismatch');
      states.delete(state);

      let tokenRes, tokenBody;
      try {
        tokenRes = await timed(`${DISCORD}/oauth2/token`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: client.user.id, client_secret: secret ?? '', grant_type: 'authorization_code', code, redirect_uri: redirectUri() }),
        });
        tokenBody = await tokenRes.json().catch(() => ({}));
      } catch (e) {
        return authFail(res, 'token-network', 502, "Couldn't reach Discord", 'The login could not be completed because Discord did not answer.', 'Check your internet connection and try again.', `network=${e.name}`);
      }
      if (!tokenRes.ok) {
        const ex = explainTokenError(tokenRes.status, tokenBody.error, redirectUri());
        return authFail(res, 'token', tokenRes.status, ex.title, 'Your Discord login was not completed.', ex.hint, `error=${String(tokenBody.error ?? '').slice(0, 40)}`);
      }
      const granted = String(tokenBody.scope ?? '').split(/[\s,]+/);
      if (typeof tokenBody.access_token !== 'string' || !SCOPES.every((s) => granted.includes(s))) {
        return authFail(res, 'scope', 400, 'Missing permissions', `Good Boy needs these Discord scopes to identify you and list your servers: ${SCOPES.join(', ')}.`, 'Log in again and approve both.', `granted=${granted.join('+').slice(0, 60)}`);
      }

      const authHeader = { Authorization: `Bearer ${tokenBody.access_token}` };
      let user, guilds;
      try {
        const [ur, gr] = await Promise.all([timed(`${DISCORD}/users/@me`, { headers: authHeader }), timed(`${DISCORD}/users/@me/guilds`, { headers: authHeader })]);
        if (!ur.ok || !gr.ok) return authFail(res, 'profile', 502, 'Could not read your Discord profile', 'Discord logged you in but refused to share your account details.', 'Try again in a minute.', `users=${ur.status} guilds=${gr.status}`);
        user = await ur.json(); guilds = await gr.json();
      } catch (e) {
        return authFail(res, 'profile-network', 502, "Couldn't reach Discord", 'Logged in, but Discord stopped answering while loading your profile.', 'Try again.', `network=${e.name}`);
      } finally {
        // We never store the access token. Revoke it right away so it can't be reused anywhere.
        timed(`${DISCORD}/oauth2/token/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: client.user.id, client_secret: secret ?? '', token: tokenBody.access_token, token_type_hint: 'access_token' }) }).catch(() => {});
      }
      if (!SNOWFLAKE.test(String(user?.id)) || !Array.isArray(guilds)) return authFail(res, 'validate', 502, 'Unexpected answer from Discord', 'Discord returned account details in a format I did not expect.', 'Try again; if it repeats, report it with the diagnostics page.', 'bad shape');

      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      for (const [k, v] of sessions) if (v.user.id === user.id) sessions.delete(k); // one live session per person
      const sid = crypto.randomBytes(32).toString('hex');
      sessions.set(sid, {
        user: { id: user.id, username: String(user.global_name || user.username || 'unknown').slice(0, 64), avatar: user.avatar ?? null },
        guilds: guilds.filter((g) => SNOWFLAKE.test(String(g?.id))).map((g) => ({ id: g.id, name: String(g.name).slice(0, 100), icon: g.icon ?? null, owner: !!g.owner, permissions: String(g.permissions ?? 0) })),
        expires: Date.now() + SESSION_MS,
      });
      logger.info(`Dashboard login ok for user ${user.id}`);
      const attrs = `HttpOnly; SameSite=Lax; Path=/${secure() ? '; Secure' : ''}`;
      return send(res, 302, '', { Location: '/', 'Set-Cookie': [`gb_sid=${sid}; ${attrs}; Max-Age=${SESSION_MS / 1000}`, `gb_state=; ${attrs}; Max-Age=0`], 'Cache-Control': 'no-store' });
    }

    if (p === '/logout') {
      sessions.delete(parseCookies(req.headers.cookie).gb_sid);
      return send(res, 302, '', { Location: '/', 'Set-Cookie': 'gb_sid=; Max-Age=0; Path=/' });
    }

    // ---- inbound webhooks (integrations module)
    let m = p.match(/^\/hooks\/(\d{17,20})\/([A-Za-z0-9_-]{20,80})$/);
    if (m && req.method === 'POST') {
      const api = manager.moduleApi(m[1], 'integrations');
      if (!api?.handleWebhook) return json(res, 404, { error: 'Not found.' });
      const hits = (hookHits.get(m[2]) ?? 0) + 1;
      hookHits.set(m[2], hits);
      if (hits > 30) return json(res, 429, { error: 'Too many requests.' });
      const body = await readJson(req);
      const ok = await api.handleWebhook(manager.ctx(m[1], 'integrations'), m[2], body);
      return ok ? send(res, 204, '') : json(res, 404, { error: 'Not found.' });
    }

    // ---- API
    if (!p.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
    if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'Blocked (cross-site request).' });

    if (p === '/api/me') {
      const s = session(req);
      if (!s) return json(res, 401, { error: 'Not logged in.', loginReady: !!secret });
      // Only servers I am in. Each is checked live, so someone who just lost a role stops seeing it.
      const shared = s.guilds.filter((g) => client.guilds.cache.has(g.id)).slice(0, 100);
      const checked = await Promise.all(shared.map(async (g) => {
        const member = await client.guilds.cache.get(g.id).members.fetch(s.user.id).catch(() => null);
        const access = member ? accessOf(member) : null;
        return access ? { id: g.id, name: g.name, icon: g.icon, access } : null;
      }));
      return json(res, 200, { user: s.user, guilds: checked.filter(Boolean), version, botOwner: manager.isBotOwner(s.user.id) });
    }

    // Updating changes the bot for every server, so only the bot's owner may see or do this.
    if (p === '/api/updates' || p === '/api/updates/check' || p === '/api/updates/apply') {
      const s = session(req);
      if (!s) return json(res, 401, { error: 'Not logged in.' });
      if (!manager.isBotOwner(s.user.id)) return json(res, 403, { error: 'Only the bot owner can manage updates.' });
      if (!updates) return json(res, 200, { supervised: false, message: 'Updates need the bot to be started with the supervisor (npm run supervised) or the desktop app.' });
      if (p === '/api/updates' && req.method === 'GET') return json(res, 200, { supervised: true, ...(await updates.request('status')) });
      if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
      if (p === '/api/updates/apply') {
        const body = await readJson(req).catch(() => ({}));
        if (body?.confirm !== true) return json(res, 400, { error: 'Confirmation is required.' });
        logger.info(`Update requested from the dashboard by ${s.user.username} (${s.user.id})`);
      }
      return json(res, 200, { supervised: true, ...(await updates.request(p.endsWith('/apply') ? 'apply' : 'check')) });
    }

    m = p.match(/^\/api\/guilds\/(\d+)$/);
    if (m && req.method === 'GET') {
      const a = await authorize(req, res, m[1], { level: 'panel' });
      if (!a) return;
      const guildInfo = { id: a.guild.id, name: a.guild.name };
      const all = manager.describeForGuild(a.guild.id);
      if (a.access === 'panel') {
        // A limited view: only the panels they may use. No settings, no permissions, no member or channel lists.
        const modules = all.filter((d) => d.enabled).map((d) => ({ name: d.name, description: d.description, panels: (d.panels ?? []).filter((p) => p.permission && perms.check(a.member, p.permission)) }))
          .filter((d) => d.panels.length);
        return json(res, 200, { access: 'panel', guild: guildInfo, modules });
      }
      const channels = [...a.guild.channels.cache.values()].filter((c) => [0, 2, 4, 5].includes(c.type))
        .sort((x, y) => x.rawPosition - y.rawPosition).map((c) => ({ id: c.id, name: c.name, type: c.type }));
      const roles = [...a.guild.roles.cache.values()].filter((r) => r.id !== a.guild.id && !r.managed)
        .sort((x, y) => y.position - x.position).map((r) => ({ id: r.id, name: r.name, color: r.hexColor }));
      const stats = { members: a.guild.memberCount ?? null, channels: a.guild.channels.cache.size, roles: a.guild.roles.cache.size, uptimeSeconds: Math.round(process.uptime()), version };
      return json(res, 200, { access: 'admin', guild: guildInfo, stats, modules: all, corePermissions: manager.permissionList(a.guild.id).filter((x) => x.module === 'core'), channels, roles });
    }

    m = p.match(/^\/api\/guilds\/(\d+)\/modules\/([a-z0-9-]+)\/(enable|disable)$/);
    if (m && req.method === 'POST') {
      const a = await authorize(req, res, m[1]);
      if (!a) return;
      const body = await readJson(req);
      if (m[3] === 'enable') await manager.enable(a.guild.id, m[2]); else await manager.disable(a.guild.id, m[2], { cascade: body.cascade === true });
      db.addLog(a.guild.id, 'dashboard', 'security', `${a.s.user.username} ${m[3]}d module ${m[2]}`);
      return json(res, 200, { ok: true });
    }

    m = p.match(/^\/api\/guilds\/(\d+)\/modules\/([a-z0-9-]+)\/settings$/);
    if (m && req.method === 'POST') {
      const a = await authorize(req, res, m[1]);
      if (!a) return;
      const { key, value, op } = await readJson(req);
      if (!['set', 'add', 'remove', 'reset'].includes(op ?? 'set')) throw new UserError('Bad operation.');
      const saved = manager.setSetting(a.guild.id, m[2], String(key), value, op ?? 'set');
      db.addLog(a.guild.id, 'dashboard', 'security', `${a.s.user.username} changed ${m[2]}.${key}`);
      return json(res, 200, { ok: true, value: saved });
    }

    m = p.match(/^\/api\/guilds\/(\d+)\/permissions$/);
    if (m && req.method === 'POST') {
      const a = await authorize(req, res, m[1]);
      if (!a) return;
      const { key, roles } = await readJson(req);
      const known = manager.permissionList(a.guild.id).some((x) => x.key === key);
      if (!known) throw new UserError('Unknown permission, or its module is off.');
      if (!Array.isArray(roles) || roles.length > 25) throw new UserError('Bad role list.');
      for (const r of roles) if (!SNOWFLAKE.test(String(r)) || r === a.guild.id || !a.guild.roles.cache.has(r)) throw new UserError('That role does not exist here.');
      db.permClear(a.guild.id, key);
      for (const r of roles) db.permAdd(a.guild.id, key, r);
      db.addLog(a.guild.id, 'dashboard', 'security', `${a.s.user.username} set roles for ${key}`);
      return json(res, 200, { ok: true });
    }

    m = p.match(/^\/api\/guilds\/(\d+)\/modules\/([a-z0-9-]+)\/views\/([A-Za-z0-9_-]+)$/);
    if (m && req.method === 'GET') {
      const a = await authorize(req, res, m[1], { level: 'panel' });
      if (!a) return;
      if (!panelAllows(a, m[2], 'view', m[3])) return json(res, 403, { error: "You don't have permission for that panel." });
      return json(res, 200, await manager.runView(a.guild.id, m[2], m[3], Object.fromEntries(url.searchParams)));
    }

    m = p.match(/^\/api\/guilds\/(\d+)\/modules\/([a-z0-9-]+)\/actions\/([A-Za-z0-9_-]+)$/);
    if (m && req.method === 'POST') {
      const a = await authorize(req, res, m[1], { level: 'panel' });
      if (!a) return;
      if (!panelAllows(a, m[2], 'action', m[3])) return json(res, 403, { error: "You don't have permission for that action." });
      const result = await manager.runAction(a.guild.id, m[2], m[3], await readJson(req), { userId: a.s.user.id, username: a.s.user.username, via: 'dashboard' });
      db.addLog(a.guild.id, 'dashboard', 'security', `${a.s.user.username}${a.access === 'panel' ? ' (panel access)' : ''} ran ${m[2]}.${m[3]}`);
      return json(res, 200, { ok: true, result });
    }

    m = p.match(/^\/api\/guilds\/(\d+)\/logs$/);
    if (m && req.method === 'GET') {
      const a = await authorize(req, res, m[1]);
      if (!a) return;
      return json(res, 200, { logs: db.recentLogs(a.guild.id, 100), health: manager.getHealth().filter((h) => manager.isActive(a.guild.id, h.name)), commands: manager.syncStatus.get(a.guild.id) ?? null });
    }

    return json(res, 404, { error: 'Not found.' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof UserError) return json(res, 400, { error: err.message });
      logger.error(`Dashboard error: ${err.message}`);
      if (!res.headersSent) json(res, 500, { error: 'Something went wrong.' });
    });
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actualPort = server.address().port;
  if (portOverride === 0 && !process.env.DASHBOARD_BASE_URL) base = `http://${host}:${actualPort}`; // tests: let the OS choose a free port
  logger.info(`Dashboard: ${base}  ${secret ? '' : '(login disabled - add DISCORD_CLIENT_SECRET to .env)'}`);
  return { close: () => { clearInterval(cleanup); server.close(); server.closeAllConnections?.(); }, port: actualPort, baseUrl: () => base, sessions };
}
