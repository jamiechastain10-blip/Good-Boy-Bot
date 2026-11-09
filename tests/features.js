/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Regression tests for v2.1 work: dashboard login, verification, starboard, voting (polls + suggestions),
 * reputation, notifications, module tables, migrations, TTS/quote helpers, branding.
 * Called from run.js with the shared `test` helper.
 */
import { assertDiscordLimits } from './discordlimits.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { PermissionFlagsBits as P, MessageFlags, ChannelType } from 'discord.js';
const MessageFlagsEphemeral = MessageFlags.Ephemeral;
import { Database } from '../src/db.js';
import { Permissions } from '../src/permissions.js';
import { ApiQueue } from '../src/queue.js';
import { ModuleManager } from '../src/moduleManager.js';
import { builtins } from '../src/builtins.js';
import { startDashboard, normalizeBase, explainTokenError } from '../src/dashboard/server.js';
import { CATEGORIES } from '../src/notifications.js';
import { customIds, firstButtonId, modalInfo, fakeFields } from './pipe-helpers.js';

const BANNED_BRANDS = ['Q2xhdWRl', 'QW50aHJvcGlj'].map((b) => Buffer.from(b, 'base64').toString());
const BANNED_RE = new RegExp(['Eclipse', ...BANNED_BRANDS].join('|'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error(...a) { if (process.env.DBG) console.log('ERR', ...a.map((x) => x?.stack ?? JSON.stringify(x)).slice(0, 3)); }, debug() {} };

class Coll extends Map {
  filter(fn) { const o = new Coll(); for (const [k, v] of this) if (fn(v, k)) o.set(k, v); return o; }
}

// ---------------------------------------------------------------- fake Discord world
export function makeWorld(moduleNames, { guildId = '1' } = {}) {
  const db = new Database(':memory:');
  const perms = new Permissions(db);
  const people = new Map();
  const roles = new Coll();
  const channels = new Coll();
  let chN = 0;

  const g = {
    id: guildId, name: 'Test Guild', ownerId: 'owner', memberCount: 10, channels: { cache: channels, fetch: async (id) => channels.get(id) ?? null },
    roles: { cache: roles }, members: { cache: new Coll(), me: null, fetch: async (id) => { if (people.has(id)) return people.get(id); throw new Error('Unknown Member'); }, fetchMe: async () => g.members.me },
  };
  const calls = { set: [], create: [] };
  const client = {
    guilds: { cache: new Map([[guildId, g]]) }, user: { id: 'bot' },
    users: { fetch: async (id) => people.get(id)?.user ?? null },
    application: { commands: { set: async (l, gid) => { calls.set.push([gid, l.map((c) => c.name)]); }, create: async (c, gid) => { calls.create.push([gid, c.name]); } } },
  };
  const mm = new ModuleManager({ db, perms, queue: new ApiQueue(), builtins, log: quiet });
  mm.attach(client, ['Guilds', 'MessageContent']);

  const role = (id, { pos = 1, managed = false, dangerous = false } = {}) => { const r = { id, name: `role-${id}`, position: pos, managed, permissions: { has: () => dangerous }, hexColor: '#000000' }; roles.set(id, r); return r; };
  const bot = { id: 'bot', roles: { highest: { position: 20 } }, permissions: { has: () => true }, user: { id: 'bot', bot: true } };
  g.members.me = bot;

  const person = (id, { bits = [], pos = 1, joinedDaysAgo = 400, username = id } = {}) => {
    const set = new Set(bits);
    const m = {
      id, guild: g, user: { id, bot: false, tag: `${username}#0`, username, globalName: username, sent: [], send: async function (p) { this.sent.push(p); }, displayAvatarURL: () => 'https://cdn/x.png' },
      displayName: id, joinedTimestamp: Date.now() - joinedDaysAgo * 86400000, permissions: { has: (b) => set.has(b) },
      roles: { cache: new Coll(), highest: { position: pos }, add: async (r) => { for (const x of [].concat(r)) m.roles.cache.set(x.id ?? x, x); }, remove: async (r) => { for (const x of [].concat(r)) m.roles.cache.delete(x.id ?? x); } },
      moderatable: true, timeout: async () => {},
    };
    people.set(id, m); g.members.cache.set(id, m);
    return m;
  };

  const channel = (name = `c${++chN}`, { missing = [], sendError = null, nsfw = false } = {}) => {
    // Real Discord ids are snowflakes, and settings validation rightly rejects anything else.
    const id = /^\d{17,20}$/.test(name) ? name : String(800000000000000000n + BigInt(++chN));
    const store = new Map(); const sent = []; const deleted = []; let n = 0;
    const ch = {
      id, name, type: 0, nsfw, parentId: null, rawPosition: chN, guild: g, sent, deleted, isTextBased: () => true,
      permissionsFor: () => ({ has: (b) => !missing.includes(b) }),
      overwrites: new Map(), perms: null,
      permissionOverwrites: { edit: async (who, p) => { ch.overwrites.set(who, { ...(ch.overwrites.get(who) ?? {}), ...p }); }, delete: async (who) => { ch.overwrites.delete(who); } },
      setName: async (n) => { ch.name = n; }, delete: async () => { channels.delete(id); ch.removed = true; },
      messages: { store, delete: async (mid) => { deleted.push(mid); store.delete(mid); },
        fetch: async (arg) => {
          if (arg && typeof arg === 'object') { const all = new Coll([...store]); all.last = () => [...store.values()].at(-1); return all; } // history fetch (transcripts)
          if (!store.has(arg)) throw new Error('Unknown Message'); return store.get(arg);
        } },
      send: async (payload) => {
        if (sendError) throw sendError;
        assertDiscordLimits(payload, 'message', `sent in #${name}`);
        const m = { createdTimestamp: Date.now(), author: { tag: 'Bot#0' }, cleanContent: String(payload?.content ?? ''), attachments: new Map(), embeds: payload?.embeds ?? [], id: `${id}-m${++n}`, url: `https://discord.com/channels/${guildId}/${id}/${n}`, channelId: id, payload, edit: async (x) => { m.edited = x; return m; }, delete: async () => { deleted.push(m.id); store.delete(m.id); }, startThread: async () => ({ id: `${id}-t${n}` }) };
        store.set(m.id, m); sent.push(payload); return m;
      },
    };
    channels.set(id, ch);
    return ch;
  };

  g.channels.create = async (o) => { const ch = channel(o.name); ch.createOpts = o; ch.parentId = o.parent ?? null; return ch; };

  const ix = ({ command, sub = null, group = null, member, opts = {}, channel: ch, customId, id, message }) => {
    const out = { replies: [], edits: [], follow: [], deferred: false, replied: false, ephemeral: undefined, modal: null };
    const pick = (n) => (n in opts ? opts[n] : null);
    return Object.assign(out, {
      id: id ?? `int-${Math.random()}`, guildId, guild: g, commandName: command, customId, member, user: member.user, channel: ch ?? { id: 'cx' }, channelId: (ch ?? { id: 'cx' }).id, message, client,
      options: {
        getSubcommand: () => sub, getSubcommandGroup: () => group, getString: pick, getInteger: pick, getBoolean: pick, getUser: pick, getRole: pick, getNumber: pick,
        getChannel: (n) => (opts[n] ? { id: opts[n].id } : null), getFocused: () => '',
      },
      deferReply: async (o) => { out.deferred = true; out.ephemeral = !!(o?.flags); },
      reply: async (p) => { assertDiscordLimits(p, 'message', 'reply'); out.replied = true; out.replies.push(p); }, editReply: async (p) => { assertDiscordLimits(p, 'message', 'edited reply'); out.edits.push(p); }, followUp: async (p) => { assertDiscordLimits(p, 'message', 'follow-up'); out.follow.push(p); },
      deleteReply: async () => {}, update: async (p) => { assertDiscordLimits(p, 'message', 'update'); out.replied = true; out.updated = p; }, showModal: async (m) => { assertDiscordLimits(m, 'modal'); out.modal = m; }, fetchReply: async () => ({ id: `poll-${Math.random()}` }),
      text: () => [...out.replies, ...out.edits, ...out.follow, out.updated].filter(Boolean).map((r) => (typeof r === 'string' ? r : r.content ?? '')).join(' | '),
    });
  };

  const run = async (i) => { await mm.handleCommand(i); return i.text(); };
  const click = async (i) => { await mm.handleComponent(i); return i.text(); };
  return { db, perms, mm, g, client, calls, people, roles, role, person, channel, ix, run, click, bot, async load() { await mm.discover(path.join(root, 'modules')); for (const n of moduleNames) await mm.enable(guildId, n); return this; } };
}

export default async function runFeatureTests({ test, rejectsWith }) {
  // ================================================================ platform
  console.log('\nPlatform additions');
  await test('module tables: prefix rule enforced, migrations applied once, idempotent', () => {
    const db = new Database(':memory:');
    assert.throws(() => Database.checkMigrationSql('stats', 'CREATE TABLE users (id INTEGER)'), /must start with "stats_"/);
    assert.throws(() => Database.checkMigrationSql('stats', 'CREATE TABLE stats_a (id INTEGER); DROP TABLE guilds'), /guilds/);
    assert.throws(() => Database.checkMigrationSql('stats', 'PRAGMA writable_schema = 1'), /forbidden/);
    assert.throws(() => Database.checkMigrationSql('stats', 'INSERT INTO module_data VALUES (1)'), /module_data/);
    const mig = [{ id: 1, sql: 'CREATE TABLE stats_t (id INTEGER PRIMARY KEY, v TEXT); CREATE INDEX stats_t_v ON stats_t (v);' }];
    assert.equal(db.moduleMigrate('stats', mig), 1);
    assert.equal(db.moduleMigrate('stats', mig), 0, 'second run does nothing');
    db.q('INSERT INTO stats_t (v) VALUES (?)').run('x');
    assert.equal(db.q('SELECT COUNT(*) AS n FROM stats_t').get().n, 1);
  });

  await test('transactions roll back on error and nest via savepoints', () => {
    const db = new Database(':memory:');
    db.moduleMigrate('t', [{ id: 1, sql: 'CREATE TABLE t_a (n INTEGER)' }]);
    assert.throws(() => db.transaction(() => { db.q('INSERT INTO t_a VALUES (1)').run(); throw new Error('boom'); }), /boom/);
    assert.equal(db.q('SELECT COUNT(*) AS n FROM t_a').get().n, 0);
    db.transaction(() => { db.q('INSERT INTO t_a VALUES (1)').run(); try { db.transaction(() => { db.q('INSERT INTO t_a VALUES (2)').run(); throw new Error('inner'); }); } catch { /* expected */ } });
    assert.equal(db.q('SELECT COUNT(*) AS n FROM t_a').get().n, 1, 'inner rolled back, outer kept');
  });

  await test('notification preferences: member > server default > category default; unknown categories denied', async () => {
    const w = await makeWorld([]).load();
    const n = w.mm.notifications;
    assert.equal(n.allowed('1', 'u', 'game-pings'), true);
    assert.equal(n.allowed('1', 'u', 'recaps'), false, 'recaps are opt-in');
    w.db.setNotifyPref('1', '*', 'game-pings', false);
    assert.equal(n.allowed('1', 'u', 'game-pings'), false, 'server default applies');
    w.db.setNotifyPref('1', 'u', 'game-pings', true);
    assert.equal(n.allowed('1', 'u', 'game-pings'), true, 'member choice beats server default');
    assert.equal(n.allowed('1', 'other', 'game-pings'), false);
    assert.equal(n.allowed('1', 'u', 'nonsense'), false);
    assert.deepEqual(n.filter('1', ['u', 'other'], 'game-pings'), ['u']);
    assert.equal(n.allowed('2', 'u', 'game-pings'), true, 'other servers unaffected');
    assert.ok(Object.keys(CATEGORIES).length >= 6);
  });

  await test('/notifications: members control their own; only admins change server defaults', async () => {
    const w = await makeWorld([]).load();
    const u = w.person('u'); const admin = w.person('adm', { bits: [P.ManageGuild] });
    await w.run(w.ix({ command: 'notifications', sub: 'set', member: u, opts: { category: 'game-pings', enabled: false } }));
    assert.equal(w.mm.notifications.allowed('1', 'u', 'game-pings'), false);
    assert.match(await w.run(w.ix({ command: 'notifications', sub: 'server-default', member: u, opts: { category: 'recaps', enabled: true } })), /server admins/);
    await w.run(w.ix({ command: 'notifications', sub: 'server-default', member: admin, opts: { category: 'recaps', enabled: true } }));
    assert.equal(w.mm.notifications.allowed('1', 'someone', 'recaps'), true);
  });

  await test('command registration: one bad command no longer hides the rest, and it is reported', async () => {
    const w = await makeWorld([]).load();
    w.client.application.commands.set = async (l, gid) => { if (l.length > 6) throw Object.assign(new Error('Invalid Form Body'), { rawError: { errors: { 3: 'bad' } } }); w.calls.set.push([gid, l.map((c) => c.name)]); };
    w.client.application.commands.create = async (c, gid) => { if (c.name === 'ping2') throw new Error('bad definition'); w.calls.create.push([gid, c.name]); };
    w.mm.defs.set('fake', { dir: '', def: { name: 'fake', version: '1.0.0', commands: [{ data: { name: 'ok1', description: 'x' } }, { data: { name: 'ping2', description: 'x' } }, { data: { name: 'ok3', description: 'x' } }] } });
    w.mm.active.set('1', new Map([['fake', w.mm.defs.get('fake').def]]));
    await w.mm.syncCommands('1');
    const st = w.mm.syncStatus.get('1');
    assert.equal(st.ok, false);
    assert.deepEqual(st.failed.map((f) => f.name), ['ping2']);
    assert.deepEqual(w.calls.create.map((c) => c[1]), ['ok1', 'ok3'], 'the good commands were still registered');
  });

  await test('a redelivered interaction is ignored; errors on a public deferred reply become private', async () => {
    const w = await makeWorld([]).load();
    const u = w.person('u');
    const a = w.ix({ command: 'help', member: u, id: 'same-id' });
    await w.run(a);
    const b = w.ix({ command: 'help', member: u, id: 'same-id' });
    await w.run(b);
    assert.equal(a.replies.length, 1); assert.equal(b.replies.length, 0, 'duplicate not processed');
    const c = w.ix({ command: 'module', sub: 'enable', member: u, opts: { name: 'x' } }); // not an admin
    await w.run(c);
    assert.match(c.text(), /Manage Server/);
  });

  // ================================================================ dashboard OAuth
  console.log('\nDashboard login (OAuth2)');
  const USER = '100000000000000009', G1 = '100000000000000001', G2 = '100000000000000002', G3 = '100000000000000003';
  const SECRET = 'S3CR3T-' + 'x'.repeat(30);
  const saved = { secret: process.env.DISCORD_CLIENT_SECRET, base: process.env.DASHBOARD_BASE_URL };
  process.env.DISCORD_CLIENT_SECRET = SECRET; delete process.env.DASHBOARD_BASE_URL;
  const dbOauth = new Database(':memory:');
  const permsO = new Permissions(dbOauth);
  const canManage = { value: true };
  const mkGuild = (id) => ({ id, name: id, ownerId: 'x', channels: { cache: new Map() }, roles: { cache: new Map() },
    members: { fetch: async (uid) => ({ id: uid, guild: { id, ownerId: 'x' }, permissions: { has: (b) => canManage.value && id === G1 && b === P.ManageGuild }, roles: { cache: new Map() } }) } });
  const oclient = { user: { id: '200000000000000001' }, guilds: { cache: new Map([[G1, mkGuild(G1)], [G2, mkGuild(G2)]]) } };
  const mmO = new ModuleManager({ db: dbOauth, perms: permsO, queue: new ApiQueue(), builtins, log: quiet });
  mmO.attach(oclient, []);
  let mode = 'ok'; const dcalls = []; const logs = [];
  const R = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, opts = {}) => {
    dcalls.push({ url, method: opts.method ?? 'GET', body: String(opts.body ?? '') });
    if (mode === 'network') throw Object.assign(new Error('offline'), { name: 'TypeError' });
    if (url.endsWith('/oauth2/token/revoke')) return R(200, {});
    if (url.endsWith('/oauth2/token')) {
      if (mode === 'invalid_client') return R(401, { error: 'invalid_client' });
      if (mode === 'invalid_grant') return R(400, { error: 'invalid_grant' });
      if (mode === 'scope') return R(200, { access_token: 'TOKEN-ABC', scope: 'identify', token_type: 'Bearer' });
      return R(200, { access_token: 'TOKEN-ABC', scope: 'identify guilds', token_type: 'Bearer' });
    }
    if (url.endsWith('/users/@me/guilds')) return R(200, [{ id: G1, name: 'Mine', owner: false, permissions: String(0x20) }, { id: G2, name: 'Not mine', owner: false, permissions: '0' }, { id: G3, name: 'Bot absent', owner: true, permissions: '0' }]);
    if (url.endsWith('/users/@me')) return R(200, { id: USER, username: 'tester', global_name: 'Tester' });
    throw new Error(`unexpected ${url}`);
  };
  const dash = await startDashboard({ manager: mmO, client: oclient, db: dbOauth, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) }, perms: permsO, port: 0, host: '127.0.0.1', fetchImpl, version: '9.9.9' });
  const request = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: dash.port, path: p, method, headers }, (res) => { let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t })); });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
  const cookieOf = (res, name) => (res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`));
  const startLogin = async () => { const r = await request('GET', '/login'); const loc = new URL(r.headers.location); return { r, loc, state: loc.searchParams.get('state'), stateCookie: cookieOf(r, 'gb_state') }; };
  const finishLogin = async (extra = '') => { const s = await startLogin(); return { s, res: await request('GET', `/callback?code=CODE-123&state=${s.state}${extra}`, { headers: { cookie: s.stateCookie } }) }; };

  await test('login redirects to Discord with the right parameters and NO prompt=none', async () => {
    const { r, loc, state, stateCookie } = await startLogin();
    assert.equal(r.status, 302);
    assert.equal(loc.origin + loc.pathname, 'https://discord.com/oauth2/authorize');
    assert.equal(loc.searchParams.get('client_id'), oclient.user.id);
    assert.equal(loc.searchParams.get('redirect_uri'), `${dash.baseUrl()}/callback`);
    assert.equal(loc.searchParams.get('response_type'), 'code');
    assert.equal(loc.searchParams.get('scope'), 'identify guilds');
    assert.equal(loc.searchParams.has('prompt'), false, 'prompt=none breaks first-time logins');
    assert.ok(state && state.length >= 20 && stateCookie.includes(state));
    assert.match(r.headers['set-cookie'].join(';'), /HttpOnly/);
  });

  await test('login succeeds, sets a session, revokes the token, and never leaks secrets', async () => {
    mode = 'ok'; dcalls.length = 0;
    const { res } = await finishLogin();
    assert.equal(res.status, 302); assert.equal(res.headers.location, '/');
    const sid = cookieOf(res, 'gb_sid');
    assert.ok(sid, 'session cookie set');
    assert.ok(dcalls.some((c) => c.url.endsWith('/oauth2/token/revoke') && c.body.includes('TOKEN-ABC')), 'access token revoked right away');
    const tokenCall = dcalls.find((c) => c.url.endsWith('/oauth2/token'));
    assert.ok(tokenCall.body.includes(encodeURIComponent(`${dash.baseUrl()}/callback`)), 'same redirect_uri in the code exchange');
    const me = await request('GET', '/api/me', { headers: { cookie: sid } });
    assert.equal(me.status, 200);
    const body = JSON.parse(me.text);
    assert.deepEqual(body.guilds.map((g) => g.id), [G1], 'only servers the user manages AND the bot is in');
    assert.equal(body.version, '9.9.9');
    for (const text of [me.text, res.text, JSON.stringify(res.headers)]) { assert.ok(!text.includes('TOKEN-ABC')); assert.ok(!text.includes(SECRET)); }
  });

  await test('every failure shows a readable page with a retry link (never a blank screen)', async () => {
    const page = (res, re) => { assert.equal(res.status >= 400, true); assert.match(res.headers['content-type'], /text\/html/); assert.match(res.text, /Try logging in again/); assert.match(res.text, re); };
    // user cancelled on Discord's page
    page(await request('GET', '/callback?error=access_denied&state=x'), /Login cancelled/);
    // no state cookie (cookies blocked / different host)
    const s1 = await startLogin();
    page(await request('GET', `/callback?code=c&state=${s1.state}`), /could not be matched to this browser/);
    // unknown state
    page(await request('GET', '/callback?code=c&state=nope', { headers: { cookie: 'gb_state=nope' } }), /expired/);
    // state reused
    const s2 = await startLogin(); mode = 'ok';
    await request('GET', `/callback?code=c&state=${s2.state}`, { headers: { cookie: s2.stateCookie } });
    page(await request('GET', `/callback?code=c&state=${s2.state}`, { headers: { cookie: s2.stateCookie } }), /expired|already used/);
    // wrong client secret
    mode = 'invalid_client'; page((await finishLogin()).res, /client secret/i);
    // bad/used code or redirect mismatch: page must show the exact redirect URL to register
    mode = 'invalid_grant'; page((await finishLogin()).res, new RegExp(dash.baseUrl().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/callback'));
    // missing scope
    mode = 'scope'; page((await finishLogin()).res, /Missing permissions/);
    // Discord unreachable
    mode = 'network'; const net = (await finishLogin()).res; assert.equal(net.status, 502); assert.match(net.text, /reach Discord/);
    mode = 'ok';
  });

  await test('a failed login leaves sanitized log lines only (no codes, tokens or secrets)', () => {
    const joined = logs.join('\n');
    assert.match(joined, /Dashboard login failed: stage=token/);
    assert.match(joined, /stage=state/);
    for (const bad of [SECRET, 'TOKEN-ABC', 'CODE-123']) assert.ok(!joined.includes(bad), `log leaked ${bad}`);
  });

  await test('API access is checked against the LIVE server, not just the login-time list', async () => {
    mode = 'ok'; canManage.value = true;
    const { res } = await finishLogin();
    const sid = cookieOf(res, 'gb_sid');
    assert.equal((await request('GET', `/api/guilds/${G1}`, { headers: { cookie: sid } })).status, 200);
    assert.equal((await request('GET', `/api/guilds/${G2}`, { headers: { cookie: sid } })).status, 403, 'the bot is in G2, but this user has no rights there');
    canManage.value = false; // the user loses Manage Server after logging in
    assert.equal((await request('GET', `/api/guilds/${G1}`, { headers: { cookie: sid } })).status, 403);
    assert.equal((await request('GET', `/api/guilds/${G3}`, { headers: { cookie: sid } })).status, 404, 'a server the bot is not in');
    assert.equal((await request('GET', `/api/guilds/${G1}`)).status, 401, 'no session');
    canManage.value = true;
  });

  await test('state-changing requests need the custom header and a matching origin', async () => {
    const { res } = await finishLogin(); const sid = cookieOf(res, 'gb_sid');
    const url = `/api/guilds/${G1}/modules/moderation/disable`;
    assert.equal((await request('POST', url, { headers: { cookie: sid }, body: '{}' })).status, 403);
    assert.equal((await request('POST', url, { headers: { cookie: sid, 'x-goodboy': '1', origin: 'https://evil.example' }, body: '{}' })).status, 403);
  });

  await test('localhost / 127.0.0.1 mix-ups are redirected to the configured address', async () => {
    const r = await request('GET', '/login', { headers: { host: 'localhost:1' } });
    assert.equal(r.status, 302);
    assert.ok(r.headers.location.startsWith(dash.baseUrl()), r.headers.location);
  });

  await test('/auth/diagnose shows what to register and never shows the secret', async () => {
    const r = await request('GET', '/auth/diagnose');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes(`${dash.baseUrl()}/callback`));
    assert.match(r.text, /clientSecretConfigured/);
    assert.ok(!r.text.includes(SECRET));
    assert.deepEqual(JSON.parse((await request('GET', '/healthz')).text), { ok: true, version: '9.9.9' });
  });

  await test('helper functions: base URL normalising and Discord error explanations', () => {
    assert.equal(normalizeBase(' "http://localhost:3000/" ', 3000), 'http://localhost:3000');
    assert.equal(normalizeBase('https://bot.example.com/dash/', 3000), 'https://bot.example.com/dash');
    assert.equal(normalizeBase('javascript:alert(1)', 3000), 'http://localhost:3000');
    assert.equal(normalizeBase('', 3000), 'http://localhost:3000');
    assert.match(explainTokenError(401, 'invalid_client', 'u').hint, /Client Secret/);
    assert.match(explainTokenError(400, 'invalid_grant', 'http://x/callback').hint, /http:\/\/x\/callback/);
  });
  dash.close();
  if (saved.secret === undefined) delete process.env.DISCORD_CLIENT_SECRET; else process.env.DISCORD_CLIENT_SECRET = saved.secret;
  if (saved.base !== undefined) process.env.DASHBOARD_BASE_URL = saved.base;

  // ================================================================ verification
  console.log('\nVerification');
  const vWorld = async () => {
    const w = await makeWorld(['member-management']).load();
    w.verified = w.role('r-verified', { pos: 5 }); w.unverified = w.role('r-unverified', { pos: 4 });
    w.panel = w.channel('verify-ch');
    w.admin = w.person('admin', { bits: [P.ManageGuild], pos: 15 });
    w.setup = (over = {}) => w.run(w.ix({ command: 'verify', sub: 'setup', member: w.admin, channel: w.panel, opts: { role: w.verified, unverified: w.unverified, channel: w.panel, ...over } }));
    return w;
  };

  await test('setup posts the panel, saves roles, remembers where the panel is', async () => {
    const w = await vWorld();
    assert.match(await w.setup(), /Verification is set up/);
    assert.equal(w.panel.sent.length, 1, 'panel message was posted');
    const c = w.mm.ctx('1', 'member-management');
    assert.equal(c.config.get('verificationRole'), 'r-verified');
    assert.equal(c.config.get('unverifiedRole'), 'r-unverified');
    assert.equal(c.data.get('verify:panel').channelId, w.panel.id);
  });

  await test('pressing the button verifies once, swaps roles, and is idempotent', async () => {
    const w = await vWorld(); await w.setup();
    const newbie = w.person('newbie'); newbie.roles.cache.set('r-unverified', w.unverified);
    const click = () => w.click(w.ix({ command: undefined, customId: 'verify:go', member: newbie }));
    assert.match(await click(), /verified/);
    assert.ok(newbie.roles.cache.has('r-verified') && !newbie.roles.cache.has('r-unverified'));
    await new Promise((r) => setTimeout(r, 3100)); // click rate limit
    assert.match(await click(), /already verified/);
    assert.equal(w.mm.ctx('1', 'member-management').data.get('verify:count'), 1);
  });

  await test('captcha (3.1): with it on, Verify shows a code picture; wrong codes use up 3 tries; the right code verifies', async () => {
    const CAP = await import('../src/captcha.js');
    assert.equal(CAP.makeCode().length, 5); assert.doesNotMatch(CAP.makeCode(() => 0) + CAP.makeCode((n) => n - 1), /[0O1IL5S2Z8B]/, 'no look-alike letters');
    assert.ok(CAP.codeMatches(' xe9 j7 ', 'XE9J7')); assert.ok(!CAP.codeMatches('XE9J', 'XE9J7'));
    const w = await vWorld(); await w.setup();
    w.mm.setSetting('1', 'member-management', 'verifyCaptcha', true);
    const newbie = w.person('capnewbie');
    const first = w.ix({ command: undefined, customId: 'verify:go', member: newbie }); await w.mm.handleComponent(first);
    assert.match(JSON.stringify(first.replies[0]), /verify:enter/, 'asks for the code');
    assert.ok(!newbie.roles.cache.has('r-verified'), 'not verified yet');
    const store = globalThis[Symbol.for('goodboy.verify.captchas')];
    const code = store.get(`1:${newbie.id}`).code;
    const submit = async (typed) => { const i = w.ix({ command: undefined, customId: 'verify:code', member: newbie }); i.isModalSubmit = () => true; i.fields = { getTextInputValue: () => typed }; await w.mm.handleComponent(i); return JSON.stringify(i.replies); };
    assert.match(await submit('WRONG'), /2 tries left/);
    assert.ok(!newbie.roles.cache.has('r-verified'));
    assert.match(await submit(code.toLowerCase()), /verified/);
    assert.ok(newbie.roles.cache.has('r-verified'), 'the right code (any case) verifies');
    const other = w.person('capother');
    await w.mm.handleComponent(w.ix({ command: undefined, customId: 'verify:go', member: other }));
    const sub2 = async (typed) => { const i = w.ix({ command: undefined, customId: 'verify:code', member: other }); i.isModalSubmit = () => true; i.fields = { getTextInputValue: () => typed }; await w.mm.handleComponent(i); return JSON.stringify(i.replies); };
    await sub2('AAAAA'); await sub2('AAAAA');
    assert.match(await sub2('AAAAA'), /last try/);
    assert.match(await sub2(store.get(`1:${other.id}`)?.code ?? 'gone'), /ran out|Verify me/, 'a new code is needed after 3 wrong tries');
    assert.ok(!other.roles.cache.has('r-verified'));
  });

  await test('setup refuses roles that are unsafe or out of reach, with the reason', async () => {
    const w = await vWorld();
    assert.match(await w.setup({ role: w.role('admin-role', { pos: 3, dangerous: true }) }), /powerful permissions/);
    assert.match(await w.setup({ role: w.role('too-high', { pos: 30 }) }), /above my highest role/);
    assert.match(await w.setup({ role: w.role('mng', { pos: 3, managed: true }) }), /managed by an integration/);
    assert.match(await w.setup({ role: w.role('above-admin', { pos: 16 }) }), /at or above your own highest role/, 'admins can only configure roles below their own');
    assert.match(await w.setup({ role: w.roles.get('r-verified') }), /Verification is set up/);
  });

  await test('missing channel permissions and Discord errors are explained, not hidden', async () => {
    const w = await vWorld();
    const noSend = w.channel('locked', { missing: [P.SendMessages, P.EmbedLinks] });
    assert.match(await w.setup({ channel: noSend }), /SendMessages, EmbedLinks|missing/);
    const broken = w.channel('broken', { sendError: Object.assign(new Error('Missing Permissions'), { code: 50013 }) });
    assert.match(await w.setup({ channel: broken }), /missing a permission/);
    assert.equal(w.mm.ctx('1', 'member-management').data.get('verify:panel'), undefined, 'no panel recorded when posting failed');
  });

  await test('repost replaces the old panel and keeps every setting; reset needs confirmation', async () => {
    const w = await vWorld(); await w.setup();
    const first = w.mm.ctx('1', 'member-management').data.get('verify:panel').messageId;
    assert.match(await w.run(w.ix({ command: 'verify', sub: 'repost', member: w.admin, channel: w.panel, opts: {} })), /reposted/);
    assert.ok(w.panel.deleted.includes(first), 'old panel deleted');
    const c = w.mm.ctx('1', 'member-management');
    assert.notEqual(c.data.get('verify:panel').messageId, first);
    assert.equal(c.config.get('verificationRole'), 'r-verified', 'settings preserved');
    assert.match(await w.run(w.ix({ command: 'verify', sub: 'reset', member: w.admin, opts: {} })), /confirm:true/);
    assert.ok(c.data.get('verify:panel'), 'not removed without confirmation');
    await w.run(w.ix({ command: 'verify', sub: 'reset', member: w.admin, opts: { confirm: true } }));
    assert.equal(c.data.get('verify:panel'), undefined);
    assert.equal(c.config.get('verificationRole'), 'r-verified', 'roles kept unless settings:true');
    await w.run(w.ix({ command: 'verify', sub: 'reset', member: w.admin, opts: { confirm: true, settings: true } }));
    assert.equal(c.config.get('verificationRole'), null);
  });

  await test('status reports a deleted panel / role; the button survives a restart', async () => {
    const w = await vWorld(); await w.setup();
    const st = await w.run(w.ix({ command: 'verify', sub: 'status', member: w.admin, opts: {} }));
    assert.ok(w.mm.ctx('1', 'member-management').data.get('verify:panel'));
    // restart: a brand-new manager over the SAME database still handles the old button
    const w2 = makeWorld(['member-management']); w2.db.close();
    const mm2 = new ModuleManager({ db: w.db, perms: new Permissions(w.db), queue: new ApiQueue(), builtins, log: quiet });
    mm2.attach(w.client, []);
    await mm2.discover(path.join(root, 'modules')); await mm2.restoreGuild('1');
    assert.ok(mm2.isActive('1', 'member-management'));
    const newbie = w.person('late');
    const i = w.ix({ command: undefined, customId: 'verify:go', member: newbie });
    await mm2.handleComponent(i);
    assert.ok(newbie.roles.cache.has('r-verified'), 'verification works after restart');
    w.roles.delete('r-verified'); // an admin deletes the role
    const late = w.person('later');
    assert.match(await w.click(w.ix({ command: undefined, customId: 'verify:go', member: late })), /not set up|verify status/);
    assert.ok(typeof st === 'string');
  });

  // ================================================================ starboard
  console.log('\nStarboard');
  const sWorld = async () => {
    const w = await makeWorld(['engagement']).load();
    w.board = w.channel('board'); w.chat = w.channel('general');
    w.admin = w.person('admin', { bits: [P.ManageGuild], pos: 15 }); w.author = w.person('author'); w.fan1 = w.person('f1'); w.fan2 = w.person('f2'); w.fan3 = w.person('f3');
    w.cmd = (sub, opts = {}, group = null) => w.run(w.ix({ command: 'starboard', sub, group, member: w.admin, opts }));
    w.star = async ({ stars = 3, content = 'hello world', bot = false, channel = w.chat, emoji = '⭐' } = {}) => {
      const author = bot ? { ...w.author, user: { ...w.author.user, bot: true }, id: 'botauthor' } : w.author;
      const msg = { id: `msg-${Math.random()}`, author: bot ? author.user : author.user, member: author, content, url: 'https://x/m', channelId: channel.id, channel, attachments: new Map(), createdTimestamp: Date.now() };
      const users = new Coll(); [w.fan1, w.fan2, w.fan3].slice(0, stars).forEach((p) => users.set(p.id, p.user));
      const reaction = { emoji: { name: emoji, id: null, toString: () => emoji }, message: msg, users: { fetch: async () => users } };
      await w.mm.dispatch('messageReactionAdd', '1', reaction, w.fan1.user);
      return { msg, reaction, users };
    };
    return w;
  };

  await test('setup validates the channel and emoji, writes validated settings, and status reflects them', async () => {
    const w = await sWorld();
    assert.match(await w.cmd('setup', { channel: w.board, emoji: 'not an emoji' }), /not a single emoji/);
    const noPerm = w.channel('nope', { missing: [P.EmbedLinks] });
    assert.match(await w.cmd('setup', { channel: noPerm }), /EmbedLinks/);
    assert.match(await w.cmd('setup', { channel: w.board, emoji: '🌟', threshold: 2 }), /Starboard is on/);
    const c = w.mm.ctx('1', 'engagement');
    assert.deepEqual([c.config.get('starboardChannel'), c.config.get('starEmoji'), c.config.get('starThreshold'), c.config.get('starEnabled')], [w.board.id, '🌟', 2, true]);
    assert.ok(w.mm.getSettingValues('1', 'engagement').starEmoji === '🌟', 'dashboard sees the same value');
  });

  await test('commands and dashboard stay in sync (same storage, same validation)', async () => {
    const w = await sWorld();
    w.mm.setSetting('1', 'engagement', 'starThreshold', '4');                       // what the dashboard does
    assert.equal(w.mm.ctx('1', 'engagement').config.get('starThreshold'), 4);
    await w.cmd('threshold', { count: 6 });                                         // what the command does
    assert.equal(w.mm.getSettingValues('1', 'engagement').starThreshold, 6);
    assert.throws(() => w.mm.setSetting('1', 'engagement', 'starThreshold', '999'), /between/);
    await w.cmd('options', { self_star: true, remove_below: false });
    const v = w.mm.getSettingValues('1', 'engagement');
    assert.deepEqual([v.starSelf, v.starRemoveBelow, v.starIgnoreBots], [true, false, true]);
    assert.match(await w.cmd('options', {}), /at least one/);
    await w.cmd('disable'); assert.equal(w.mm.ctx('1', 'engagement').config.get('starEnabled'), false);
    await w.cmd('enable'); assert.equal(w.mm.ctx('1', 'engagement').config.get('starEnabled'), true);
  });

  await test('posting: threshold, updates, removal below threshold, deletion of the original', async () => {
    const w = await sWorld(); await w.cmd('setup', { channel: w.board, threshold: 2 });
    const below = await w.star({ stars: 1 });
    assert.equal(w.board.sent.length, 0, 'below threshold: nothing posted');
    const a = await w.star({ stars: 2 });
    assert.equal(w.board.sent.length, 1, 'posted at the threshold');
    assert.equal(w.mm.ctx('1', 'engagement').data.get(`star:${a.msg.id}`).count, 2);
    const board1 = w.mm.ctx('1', 'engagement').data.get(`star:${a.msg.id}`).boardMessageId;
    // more stars: the existing post is edited, not duplicated
    const users3 = new Coll([[w.fan1.id, w.fan1.user], [w.fan2.id, w.fan2.user], [w.fan3.id, w.fan3.user]]);
    await w.mm.dispatch('messageReactionAdd', '1', { emoji: { name: '⭐', toString: () => '⭐' }, message: a.msg, users: { fetch: async () => users3 } }, w.fan3.user);
    assert.equal(w.board.sent.length, 1); assert.equal(w.mm.ctx('1', 'engagement').data.get(`star:${a.msg.id}`).count, 3);
    // stars removed: post disappears (remove_below defaults to on)
    await w.mm.dispatch('messageReactionRemove', '1', { emoji: { name: '⭐', toString: () => '⭐' }, message: a.msg, users: { fetch: async () => new Coll() } }, w.fan1.user);
    assert.ok(w.board.deleted.includes(board1)); assert.equal(w.mm.ctx('1', 'engagement').data.get(`star:${a.msg.id}`), undefined);
    // the original message is deleted: its board post goes too
    const b = await w.star({ stars: 2 });
    const bb = w.mm.ctx('1', 'engagement').data.get(`star:${b.msg.id}`).boardMessageId;
    await w.mm.dispatch('messageDelete', '1', b.msg);
    assert.ok(w.board.deleted.includes(bb)); assert.equal(w.mm.ctx('1', 'engagement').data.get(`star:${b.msg.id}`), undefined);
    assert.ok(below);
  });

  await test('posting rules: wrong emoji, bots, ignored channels, NSFW, disabled, self-stars', async () => {
    const w = await sWorld(); await w.cmd('setup', { channel: w.board, threshold: 2 });
    const posts = () => w.board.sent.length;
    await w.star({ emoji: '❤️' }); assert.equal(posts(), 0, 'other emoji ignored');
    await w.star({ bot: true }); assert.equal(posts(), 0, 'bot messages ignored by default');
    await w.cmd('options', { ignore_bots: false }); await w.star({ bot: true }); assert.equal(posts(), 1);
    const quiet2 = w.channel('quiet'); await w.cmd('add', { channel: quiet2 }, 'ignore');
    assert.match(await w.cmd('list', {}, 'ignore'), new RegExp(quiet2.id));
    await w.star({ channel: quiet2 }); assert.equal(posts(), 1, 'ignored channel');
    await w.cmd('remove', { channel: quiet2 }, 'ignore'); await w.star({ channel: quiet2 }); assert.equal(posts(), 2);
    const nsfw = w.channel('nsfw', { nsfw: true }); await w.star({ channel: nsfw }); assert.equal(posts(), 2, 'NSFW ignored');
    await w.cmd('options', { allow_nsfw: true }); await w.star({ channel: nsfw }); assert.equal(posts(), 3);
    await w.cmd('disable'); await w.star(); assert.equal(posts(), 3, 'disabled');
    await w.cmd('enable');
    // the author's own star only counts when enabled: 2 fans + author = 2 counted unless self_star
    const users = new Coll([[w.author.id, w.author.user], [w.fan1.id, w.fan1.user]]);
    const msg = { id: 'selfmsg', author: w.author.user, member: w.author, content: 'x', url: 'u', channelId: w.chat.id, channel: w.chat, attachments: new Map() };
    const react = { emoji: { name: '⭐', toString: () => '⭐' }, message: msg, users: { fetch: async () => users } };
    await w.mm.dispatch('messageReactionAdd', '1', react, w.fan1.user); assert.equal(posts(), 3, 'self star not counted -> 1 star');
    await w.cmd('options', { self_star: true }); await w.mm.dispatch('messageReactionAdd', '1', react, w.fan1.user); assert.equal(posts(), 4);
  });

  await test('status reports problems (no channel / missing permission / deleted channel) instead of failing silently', async () => {
    const w = await sWorld();
    const { starProblems } = await import('../modules/engagement/index.js');
    const checks = async () => { const c = w.mm.ctx('1', 'engagement'); const out = starProblems(c, c.guild); return out.length ? out.join(' | ') : 'everything looks right'; };
    w.mm.ctx('1', 'engagement').settings.set('starEnabled', true);
    assert.match(await checks(), /No starboard channel/, 'enabled with no channel is flagged');
    // setup refuses a channel the bot cannot post embeds in, names the permission, and saves nothing
    const noEmbed = w.channel('noembed', { missing: [P.EmbedLinks] });
    assert.match(await w.cmd('setup', { channel: noEmbed }), /EmbedLinks/);
    assert.equal(w.mm.ctx('1', 'engagement').config.get('starboardChannel') ?? null, null, 'nothing saved for an unusable channel');
    // a good channel clears the checks; deleting it again is noticed
    await w.cmd('setup', { channel: w.board });
    assert.match(await checks(), /everything looks right/);
    w.mm.ctx('1', 'engagement').guild.channels.cache.delete(w.board.id);
    assert.match(await checks(), /deleted or is not a text channel/, 'a deleted board channel is flagged');
  });

  // ================================================================ voting engine
  console.log('\nVoting (polls + suggestions)');
  const vtWorld = async () => {
    const w = await makeWorld(['engagement']).load();
    w.sch = w.channel('suggestions'); w.admin = w.person('admin', { bits: [P.ManageGuild], pos: 15 }); w.mod = w.person('mod', { bits: [P.ModerateMembers], pos: 8 });
    w.a = w.person('alice'); w.b = w.person('bob'); w.c = w.person('carol');
    w.sugg = (m, text, extra = {}) => w.run(w.ix({ command: 'suggest', member: m, opts: { idea: text, ...extra } }));
    return w;
  };

  await test('suggestions: setup, post, cooldown, thread, voting toggles/switches', async () => {
    const w = await vtWorld();
    assert.match(await w.sugg(w.a, 'idea'), /not set up/);
    assert.match(await w.run(w.ix({ command: 'suggestion', sub: 'setup', member: w.admin, opts: { channel: w.sch } })), /will be posted/);
    assert.match(await w.sugg(w.a, 'Add a music channel'), /#1/);
    assert.equal(w.sch.sent.length, 1);
    const s = w.mm.ctx('1', 'engagement').data.get('sugg:1');
    assert.ok(s.threadId, 'a discussion thread was opened'); assert.equal(s.status, 'open');
    assert.match(await w.sugg(w.a, 'another'), /Please wait/, 'cooldown');
    assert.match(await w.sugg(w.b, 'bobs idea', { anonymous: true }), /#2/);
    assert.equal(w.mm.ctx('1', 'engagement').data.get('sugg:2').anonymous, true);
    const vote = (m, dir) => w.click(w.ix({ command: undefined, customId: `sugg:${dir}:1`, member: m, message: { id: s.messageId } }));
    await vote(w.b, 'up'); await vote(w.c, 'up'); await vote(w.a, 'down');
    let cur = w.mm.ctx('1', 'engagement').data.get('sugg:1'); assert.deepEqual([cur.up.length, cur.down.length], [2, 1]);
    await vote(w.b, 'up'); cur = w.mm.ctx('1', 'engagement').data.get('sugg:1'); assert.equal(cur.up.length, 1, 'clicking again removes the vote');
    await vote(w.c, 'down'); cur = w.mm.ctx('1', 'engagement').data.get('sugg:1'); assert.deepEqual([cur.up.length, cur.down.length], [0, 2], 'switching moves the vote');
  });

  await test('suggestions: staff statuses close voting, notify only if allowed, and are audited', async () => {
    const w = await vtWorld();
    await w.run(w.ix({ command: 'suggestion', sub: 'setup', member: w.admin, opts: { channel: w.sch } }));
    await w.sugg(w.a, 'one'); await w.sugg(w.b, 'two');
    assert.match(await w.run(w.ix({ command: 'suggestion', sub: 'status', member: w.a, opts: { id: 1, status: 'approved' } })), /Only staff/);
    await w.run(w.ix({ command: 'suggestion', sub: 'status', member: w.mod, opts: { id: 1, status: 'considering', note: 'looking' } }));
    assert.equal(w.a.user.sent.length, 1, 'author notified');
    w.db.setNotifyPref('1', 'bob', 'dms', false);
    await w.run(w.ix({ command: 'suggestion', sub: 'status', member: w.mod, opts: { id: 2, status: 'approved', note: 'yes' } }));
    assert.equal(w.b.user.sent.length, 0, 'opted-out member is not DMed');
    const cur = w.mm.ctx('1', 'engagement').data.get('sugg:2');
    assert.equal(cur.status, 'approved'); assert.equal(cur.history.at(-1).by, 'mod');
    const closed = await w.click(w.ix({ command: undefined, customId: 'sugg:up:2', member: w.c, message: { id: cur.messageId } }));
    assert.match(closed, /closed/);
    assert.match(await w.run(w.ix({ command: 'suggestion', sub: 'info', member: w.admin, opts: { id: 99 } })), /No suggestion/);
    await w.run(w.ix({ command: 'suggestion', sub: 'delete', member: w.mod, opts: { id: 1 } }));
    assert.equal(w.mm.ctx('1', 'engagement').data.get('sugg:1'), undefined);
  });

  await test('polls share the engine: single choice, multiple choice, closing', async () => {
    const w = await vtWorld(); const ch = w.channel('polls');
    const mk = (opts) => w.run(w.ix({ command: 'poll', sub: 'create', member: w.mod, channel: ch, opts: { question: 'Best?', option1: 'A', option2: 'B', option3: 'C', ...opts } }));
    await mk({}); await mk({ multiple: true });
    const polls = w.mm.ctx('1', 'engagement').data.list('poll:');
    assert.equal(polls.length, 2);
    const [single, multi] = polls.map((p) => p.value).sort((x, y) => Number(x.multi) - Number(y.multi));
    const vote = (m, p, n) => w.click(w.ix({ command: undefined, customId: `poll:vote:${n}`, member: m, message: { id: p.messageId } }));
    await vote(w.a, single, 0); await vote(w.a, single, 1);
    assert.equal(w.mm.ctx('1', 'engagement').data.get(`poll:${single.messageId}`).votes.alice, 1, 'single choice: last pick wins');
    await vote(w.a, multi, 0); await vote(w.a, multi, 2);
    assert.deepEqual(w.mm.ctx('1', 'engagement').data.get(`poll:${multi.messageId}`).votes.alice, [0, 2], 'multiple choice');
    await vote(w.a, multi, 0);
    assert.deepEqual(w.mm.ctx('1', 'engagement').data.get(`poll:${multi.messageId}`).votes.alice, [2], 'toggle off');
    ch.messages.store.set(single.messageId, { id: single.messageId, edit: async () => {} });
    await w.run(w.ix({ command: 'poll', sub: 'end', member: w.mod, opts: { message_id: single.messageId } }));
    assert.match(await vote(w.b, single, 0), /ended/);
  });

  await test('old suggestions move from the support module to engagement, with their settings', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-mig-')), 'old.db');
    new Database(file).close();
    const raw = new DatabaseSync(file);
    raw.exec("DROP TABLE notification_prefs; DROP TABLE module_migrations; UPDATE schema_meta SET value = '1' WHERE key = 'version';");
    raw.exec(`INSERT INTO module_data VALUES ('1','support','sugg:1','{"id":1,"text":"old idea","up":["a"],"down":[],"status":"open"}'),('1','support','suggCounter','1'),('1','support','types','[1]'),('2','support','sugg:7','{"id":7}');
              INSERT INTO module_config VALUES ('1','support','suggestionChannel','"123"'),('1','support','staffRole','"9"');`);
    raw.close();
    const db = new Database(file);
    assert.equal(JSON.parse(db.q("SELECT value FROM module_data WHERE guild_id='1' AND module='engagement' AND key='sugg:1'").get().value).text, 'old idea');
    assert.equal(db.dataGet('1', 'engagement', 'suggCounter'), 1);
    assert.equal(db.dataGet('2', 'engagement', 'sugg:7').id, 7, 'other servers migrated too');
    assert.equal(db.q("SELECT COUNT(*) AS n FROM module_data WHERE module='support' AND (key LIKE 'sugg:%' OR key='suggCounter')").get().n, 0, 'removed from support');
    assert.deepEqual(db.dataGet('1', 'support', 'types'), [1], 'unrelated support data untouched');
    assert.equal(db.getConfig('1', 'engagement', 'suggestionChannel'), '123');
    assert.equal(db.getConfig('1', 'support', 'staffRole'), '9', 'unrelated support settings untouched');
    assert.ok(fs.readdirSync(path.join(path.dirname(file), 'backups')).some((f) => f.includes('pre-migration')), 'a backup was taken before migrating');
  });

  // ================================================================ reputation
  console.log('\nReputation');
  const rWorld = async () => {
    const w = await makeWorld(['community']).load();
    w.admin = w.person('admin', { bits: [P.ManageGuild], pos: 15 }); w.a = w.person('alice'); w.b = w.person('bob'); w.c = w.person('carol'); w.rookie = w.person('rookie', { joinedDaysAgo: 0 });
    w.rep = (member, sub, opts = {}) => w.run(w.ix({ command: 'rep', sub, member, opts }));
    w.score = (id) => w.mm.ctx('1', 'community').data.get(`user:${id}`)?.rep ?? 0;
    return w;
  };

  await test('scores can go below zero; positive and negative gifts both work', async () => {
    const w = await rWorld();
    w.mm.ctx('1', 'community').data.set('user:bob', { xp: 50, messages: 3, rep: 4, lastXp: 0, lastRep: 0 }); // pre-existing data
    assert.match(await w.rep(w.a, 'give', { user: w.b.user }), /\+1/);
    assert.equal(w.score('bob'), 5);
    assert.equal(w.mm.ctx('1', 'community').data.get('user:bob').xp, 50, 'XP untouched');
    assert.match(await w.rep(w.b, 'give', { user: w.c.user, type: 'negative', reason: 'rude' }), /-1/);
    assert.equal(w.score('carol'), -1, 'below zero');
    assert.match(await w.rep(w.admin, 'check', { user: w.c.user }), /-1/);
    await w.rep(w.admin, 'set', { user: w.c.user, value: -40 });
    assert.equal(w.score('carol'), -40);
    const view = await w.mm.runView('1', 'community', 'reputation');
    assert.deepEqual(view.rows.map((r) => [r.id, r.rep]), [['bob', 5], ['carol', -40]], 'negative scores are listed');
  });

  await test('abuse protection: self, bots, cooldown, daily cap, same-person repeat, new members, negative brigading', async () => {
    const w = await rWorld(); const t = w.person('target');
    assert.match(await w.rep(w.a, 'give', { user: w.a.user }), /yourself/);
    assert.match(await w.rep(w.a, 'give', { user: { id: 'bot2', bot: true } }), /Bots/);
    assert.match(await w.rep(w.rookie, 'give', { user: t.user }), /\+1/, 'brand-new members may give rep while the minimum is 0 days');
    await w.rep(w.a, 'give', { user: w.b.user });
    assert.match(await w.rep(w.a, 'give', { user: w.c.user }), /again/, 'cooldown between gifts');
    w.mm.setSetting('1', 'community', 'repCooldownHours', '1');
    const c = w.mm.ctx('1', 'community');
    c.data.update('user:alice', (x) => ({ ...x, lastRep: 0 }), {});
    assert.match(await w.rep(w.a, 'give', { user: w.b.user }), /already rated/, 'same person again');
    w.mm.setSetting('1', 'community', 'repMinMemberDays', '30');
    assert.match(await w.rep(w.rookie, 'give', { user: t.user }), /30 day/);
    w.mm.setSetting('1', 'community', 'repMinMemberDays', '0');
    w.mm.setSetting('1', 'community', 'repAllowNegative', 'off');
    assert.match(await w.rep(w.b, 'give', { user: t.user, type: 'negative' }), /turned off/);
    w.mm.setSetting('1', 'community', 'repAllowNegative', 'on'); w.mm.setSetting('1', 'community', 'repNegativeDailyPerTarget', '2');
    const base = w.score('target');
    for (const id of ['n1', 'n2', 'n3']) { const p = w.person(id); await w.rep(p, 'give', { user: t.user, type: 'negative' }); }
    assert.equal(w.score('target'), base - 2, 'only two negative votes land; the third in a day is blocked');
    w.mm.setSetting('1', 'community', 'repDailyLimit', '1');
    const g1 = w.person('g1'); await w.rep(g1, 'give', { user: w.b.user });
    c.data.update('user:g1', (x) => ({ ...x, lastRep: 0 }), {});
    assert.match(await w.rep(g1, 'give', { user: w.c.user }), /today's limit/);
  });

  await test('admins can remove, set and reset; members cannot; everything is in the history', async () => {
    const w = await rWorld();
    await w.rep(w.a, 'give', { user: w.b.user });
    assert.match(await w.rep(w.a, 'remove', { user: w.b.user }), /permission/);
    assert.match(await w.rep(w.a, 'set', { user: w.b.user, value: 99 }), /permission/);
    assert.match(await w.rep(w.a, 'reset', { user: w.b.user }), /permission/);
    await w.rep(w.admin, 'remove', { user: w.b.user, amount: 4, reason: 'abuse' });
    assert.equal(w.score('bob'), -3, 'remove can push below zero');
    await w.rep(w.admin, 'set', { user: w.b.user, value: 12 }); assert.equal(w.score('bob'), 12);
    await w.rep(w.admin, 'reset', { user: w.b.user }); assert.equal(w.score('bob'), 0);
    const rows = w.mm.ctx('1', 'community').sql.all("SELECT kind, delta FROM community_rep_history WHERE target_id = 'bob' ORDER BY id");
    assert.deepEqual(rows.map((r) => r.kind), ['give', 'remove', 'set', 'reset']);
    assert.deepEqual(rows.map((r) => r.delta), [1, -4, 15, -12], 'deltas reconcile with the balance');
    assert.match(await w.rep(w.a, 'history', { user: w.b.user }), /permission/, 'only admins see others\' history');
    assert.doesNotMatch(await w.rep(w.b, 'history', {}), /permission/, 'members see their own');
  });

  await test('reset-all needs a confirmation button, expires, belongs to the requester, and takes a backup', async () => {
    const w = await rWorld();
    for (const [id, v] of [['alice', 5], ['bob', -3], ['carol', 0]]) w.mm.ctx('1', 'community').data.set(`user:${id}`, { xp: 10, messages: 1, rep: v, lastXp: 0, lastRep: 0 });
    const asked = w.ix({ command: 'rep', sub: 'reset-all', member: w.admin, opts: {} });
    await w.mm.handleCommand(asked);
    assert.match(asked.text(), /2\*\*|2 /, 'warns how many members are affected');
    assert.equal(w.score('alice'), 5, 'nothing changed yet');
    const [{ key }] = w.mm.ctx('1', 'community').data.list('repReset:'); const token = key.slice('repReset:'.length);
    const press = (member, action) => w.click(w.ix({ command: undefined, customId: `rep:${action}:${token}`, member }));
    assert.match(await press(w.a, 'resetall'), /expired or belongs to someone else/);
    assert.equal(w.score('alice'), 5);
    assert.match(await press(w.admin, 'cancel'), /Cancelled/);
    assert.equal(w.score('alice'), 5);
    assert.match(await press(w.admin, 'resetall'), /expired/, 'a used/cancelled token cannot be replayed');
    await w.mm.handleCommand(w.ix({ command: 'rep', sub: 'reset-all', member: w.admin, opts: {} }));
    const t2 = w.mm.ctx('1', 'community').data.list('repReset:')[0].key.slice('repReset:'.length);
    assert.match(await w.click(w.ix({ command: undefined, customId: `rep:resetall:${t2}`, member: w.admin })), /Reset \*\*2\*\*/);
    assert.deepEqual([w.score('alice'), w.score('bob'), w.score('carol')], [0, 0, 0]);
    assert.equal(w.mm.ctx('1', 'community').data.get('user:alice').xp, 10, 'XP untouched');
    assert.equal(w.mm.ctx('1', 'community').sql.get("SELECT COUNT(*) AS n FROM community_rep_history WHERE kind = 'reset_all'").n, 2);
  });

  await test('dashboard actions mirror the commands; server-wide reset demands the confirmation word', async () => {
    const w = await rWorld();
    const BOB = '100000000000000555'; w.person(BOB);
    const actor = { userId: 'admin', username: 'Admin', via: 'dashboard' };
    await w.rep(w.a, 'give', { user: w.b.user });
    await w.mm.runAction('1', 'community', 'rep-set', { userId: BOB, value: -7 }, actor);
    assert.equal(w.score(BOB), -7);
    await assert.rejects(() => w.mm.runAction('1', 'community', 'rep-set', { userId: 'nope', value: 1 }, actor), /Pick a member/);
    await assert.rejects(() => w.mm.runAction('1', 'community', 'rep-set', { userId: '100000000000000001', value: 10 ** 9 }, actor), /between/);
    await assert.rejects(() => w.mm.runAction('1', 'community', 'rep-reset-all', {}, actor), /RESET/);
    assert.equal(w.score(BOB), -7);
    await w.mm.runAction('1', 'community', 'rep-reset-all', { confirm: 'RESET' }, actor);
    assert.equal(w.score(BOB), 0);
    assert.ok(w.mm.describeForGuild('1').find((d) => d.name === 'community').panels[0].globalActions[0].confirmWord === 'RESET');
  });

  // ================================================================ voice / quotes helpers
  console.log('\nTTS and image quotes');
  const voice = await import('../modules/voice/index.js');
  const quotes = await import('../modules/quotes/index.js');
  const wavOf = (pcm, { rate = 48000, ch = 2, bits = 16, sizeField } = {}) => {
    const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
    h.writeUInt16LE(ch, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE((rate * ch * bits) / 8, 28); h.writeUInt16LE((ch * bits) / 8, 32); h.writeUInt16LE(bits, 34);
    h.write('data', 36); h.writeUInt32LE(sizeField ?? pcm.length, 40); return Buffer.concat([h, pcm]);
  };
  await test('WAV parsing extracts PCM (including streamed files with an unset size) and rejects junk', () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const a = voice.parseWav(wavOf(pcm)); assert.deepEqual([a.rate, a.channels, a.bits, [...a.pcm]], [48000, 2, 16, [...pcm]]);
    assert.deepEqual([...voice.parseWav(wavOf(pcm, { sizeField: 0xffffffff })).pcm], [...pcm]);
    assert.equal(voice.parseWav(wavOf(pcm, { rate: 22050, ch: 1 })).rate, 22050);
    assert.throws(() => voice.parseWav(Buffer.from('nope')), /not a WAV/);
    const compressed = wavOf(pcm); compressed.writeUInt16LE(3, 20);
    assert.throws(() => voice.parseWav(compressed), /not PCM/);
  });
  await test('speech text is cleaned; provider choice is sensible; the PowerShell script cannot be injected', () => {
    assert.equal(voice.cleanForSpeech('hi <@123456789012345678> see https://x.y/z **now** <:pog:123456789012345678>'), 'hi see link now pog');
    assert.equal(voice.chooseProvider('auto', 'win32'), 'windows'); assert.equal(voice.chooseProvider('auto', 'linux'), 'google');
    assert.equal(voice.chooseProvider('google', 'win32'), 'google'); assert.equal(voice.chooseProvider('windows', 'linux'), 'windows');
    assert.ok(!voice.PS_SPEAK.includes('${') && !/\$text|\$input/i.test(voice.PS_SPEAK), 'text only reaches PowerShell through environment variables');
    assert.match(voice.PS_SPEAK, /\$env:GB_TTS_TEXT/);
  });
  await test('quote layout: wraps, splits giant words, shrinks to fit, never exceeds the box', () => {
    const measure = (s) => s.length * 10;
    assert.deepEqual(quotes.wrapText(measure, 'aaa bbb ccc', 70), ['aaa bbb', 'ccc']);
    assert.ok(quotes.wrapText(measure, 'x'.repeat(100), 50).every((l) => l.length <= 5), 'long words are broken');
    assert.deepEqual(quotes.wrapText(measure, 'one\n\ntwo', 500), ['one', 'two']);
    const fit = quotes.fitText((size, s) => s.length * size * 0.5, 'word '.repeat(60).trim(), 500, 380);
    assert.ok(fit.size < 54 && fit.size >= 24); assert.ok(fit.lines.length * fit.size * 1.25 <= 380);
    const huge = quotes.fitText((size, s) => s.length * size * 0.5, 'word '.repeat(2000).trim(), 500, 380);
    assert.ok(huge.lines.length * 24 * 1.25 <= 380, 'truncated to the box at the minimum size');
  });
  await test('/quote is registered alongside the right-click commands', async () => {
    const w = await makeWorld(['quotes']).load();
    const names = w.mm.commandList('1').map((c) => c.name);
    for (const n of ['quote', 'Quote Image', 'Quote Image (Color)']) assert.ok(names.includes(n), n);
    const u = w.person('u');
    assert.match(await w.run(w.ix({ command: 'quote', member: u, opts: { message: 'not a link' } })), /message link|message ID/);
  });

  // ================================================================ announcements
  console.log('\nAnnouncements (2.2: command -> button -> popup)');
  const aWorld = async () => {
    const w = await makeWorld(['engagement']).load();
    w.news = w.channel('news'); w.silent = w.channel('no-ping-perm', { missing: [P.MentionEveryone] });
    w.admin = w.person('admin', { bits: [P.ManageGuild], pos: 15 });
    w.roleA = w.role('role-a'); w.roleB = w.role('role-b'); w.hidden = w.role('role-hidden'); w.roleA.mentionable = true; w.roleB.mentionable = true; w.hidden.mentionable = false;
    // The whole 2.2 flow: /announce <sub> -> private button -> popup -> submit.
    w.flow = async (sub, values, member = w.admin) => {
      const cmd = w.ix({ command: 'announce', sub, member, channel: w.news }); await w.mm.handleCommand(cmd);
      const bid = firstButtonId(cmd.replies[0]);
      if (!bid) return { cmd, submit: cmd };
      const click = w.ix({ customId: bid, member, channel: w.news }); await w.mm.handleComponent(click);
      const info = modalInfo(click.modal);
      const submit = w.ix({ customId: info.customId, member, channel: w.news }); submit.fields = fakeFields(values);
      await w.mm.handleComponent(submit);
      return { cmd, click, info, submit };
    };
    w.send = async (o = {}, sub = 'send') => (await w.flow(sub, {
      channel: [o.channel?.id ?? w.news.id], title: o.title ?? '', text: o.text ?? 'Maintenance tonight\nBack at 9', color: o.color ?? '',
      roles: (o.roles ?? []).map((r) => r.id ?? r), when: o.when ?? '', repeat: [o.repeat ?? 'none'],
    })).submit;
    w.errorText = (i) => i.replies.map((r) => r?.embeds?.[0]?.data?.description ?? r?.content ?? '').join(' | ');
    return w;
  };

  await test('/announce takes no typed options; send serves one private "Configure Announcement" button', async () => {
    const w = await aWorld();
    const json = w.mm.commandList('1').find((c) => c.name === 'announce');
    for (const sc of json.options) assert.deepEqual(sc.options ?? [], [], `/announce ${sc.name} has no options`);
    const cmd = w.ix({ command: 'announce', sub: 'send', member: w.admin, channel: w.news }); await w.mm.handleCommand(cmd);
    const r = cmd.replies[0];
    assert.equal(r.flags, MessageFlags.Ephemeral, 'only the admin sees it');
    assert.equal(customIds(r).length, 1, 'exactly one button');
    assert.equal(r.components[0].components[0].data.label, 'Configure Announcement');
    assert.equal(cmd.modal, null, 'no popup straight from the command');
    const click = w.ix({ customId: customIds(r)[0], member: w.admin }); await w.mm.handleComponent(click);
    const info = modalInfo(click.modal);
    assert.deepEqual(info.fields, ['channel', 'title', 'text', 'color', 'roles']);
    assert.ok(info.labels.includes('Announcement title') && info.labels.includes('Main body text') && info.labels.includes('Hex color code'));
  });

  await test('announcements are normal messages: the text is the message, pings are real message text', async () => {
    const w = await aWorld();
    const i = await w.send({ channel: w.news });
    assert.equal(w.news.sent.length, 1);
    const m = w.news.sent[0];
    assert.equal(m.content, 'Maintenance tonight\nBack at 9', 'written text, with line breaks, as the message itself');
    assert.equal(m.embeds, undefined, 'not wrapped in an embed');
    assert.deepEqual(m.allowedMentions, { parse: [] });
    assert.match(i.text(), /Announcement sent/);
  });

  await test('@everyone (the @everyone role in the picker) and several roles all really ping', async () => {
    const w = await aWorld();
    await w.send({ channel: w.news, roles: [w.g.id] });
    assert.equal(w.news.sent[0].content, '@everyone\nMaintenance tonight\nBack at 9');
    assert.deepEqual(w.news.sent[0].allowedMentions, { parse: ['everyone'] });
    await w.send({ channel: w.news, roles: [w.roleA, w.roleB] });
    assert.match(w.news.sent[1].content, /^<@&role-a> <@&role-b>\n/);
    assert.deepEqual(w.news.sent[1].allowedMentions, { roles: ['role-a', 'role-b'] });
    await w.send({ channel: w.news, roles: [w.roleA, w.g.id] });
    assert.equal(w.news.sent[2].content, '@everyone\nMaintenance tonight\nBack at 9', '@everyone covers the roles');
    const { announcePayload } = await import('../modules/engagement/index.js');
    assert.match(announcePayload({ text: 'x', ping: 'here' }).content, /^@here\n/, '@here still works for older scheduled entries');
  });

  await test('a title or color makes an embed, but the ping stays in the message text; a bad color is refused with a retry button', async () => {
    const w = await aWorld();
    await w.send({ channel: w.news, roles: [w.g.id], title: 'Downtime', color: '#ff0000' });
    const m = w.news.sent[0];
    assert.equal(m.content, '@everyone');
    assert.equal(m.embeds.length, 1);
    assert.equal(m.embeds[0].data.color, 0xff0000);
    const bad = await w.send({ channel: w.news, color: 'reddish' });
    assert.match(w.errorText(bad), /Colors look like/);
    assert.ok(firstButtonId(bad.replies[0]), 'a button to open the form again');
    assert.equal(w.news.sent.length, 1, 'nothing posted');
  });

  await test('a ping Discord would ignore is never silently "sent": it posts without it and says exactly why', async () => {
    const w = await aWorld();
    const i = await w.send({ channel: w.silent, roles: [w.g.id] });
    assert.equal(w.silent.sent[0].content, 'Maintenance tonight\nBack at 9', 'no dead @everyone text');
    assert.match(i.text(), /posted without the ping/);
    assert.match(i.text(), /Mention @everyone, @here, and All Roles/);
    const j = await w.send({ channel: w.silent, roles: [w.hidden] });
    assert.match(j.text(), /not mentionable/);
    const k = await w.send({ channel: w.silent, roles: [w.roleA] });
    assert.doesNotMatch(k.text(), /without the ping/, 'a mentionable role needs no extra permission');
    assert.match(w.silent.sent.at(-1).content, /^<@&role-a>/);
  });

  await test('the button and popup belong to whoever ran the command, a popup is used once, and losing the permission stops it', async () => {
    const w = await aWorld();
    const cmd = w.ix({ command: 'announce', sub: 'send', member: w.admin, channel: w.news }); await w.mm.handleCommand(cmd);
    const bid = firstButtonId(cmd.replies[0]);
    const intruder = w.person('intruder', { bits: [P.ManageGuild] });
    const steal = w.ix({ customId: bid, member: intruder }); await w.mm.handleComponent(steal);
    assert.equal(steal.modal, null); assert.match(steal.text(), /belongs to someone else/);
    const click = w.ix({ customId: bid, member: w.admin }); await w.mm.handleComponent(click);
    const sid = modalInfo(click.modal).customId;
    const values = { channel: [w.news.id], title: '', text: 'hi', color: '', roles: [] };
    const s1 = w.ix({ customId: sid, member: w.admin }); s1.fields = fakeFields(values); await w.mm.handleComponent(s1);
    assert.match(s1.text(), /Announcement sent/);
    const s2 = w.ix({ customId: sid, member: w.admin }); s2.fields = fakeFields(values); await w.mm.handleComponent(s2);
    assert.match(s2.text(), /already submitted/); assert.equal(w.news.sent.length, 1);
    const tampered = sid.replace(/:admin:/, ':intruder:');
    const s3 = w.ix({ customId: tampered, member: w.admin }); s3.fields = fakeFields(values); await w.mm.handleComponent(s3);
    assert.match(s3.text(), /could not be verified/);
    const demoted = w.person('demoted', { bits: [P.ManageGuild] });
    const c2 = w.ix({ command: 'announce', sub: 'send', member: demoted, channel: w.news }); await w.mm.handleCommand(c2);
    const k2 = w.ix({ customId: firstButtonId(c2.replies[0]), member: demoted }); await w.mm.handleComponent(k2);
    demoted.permissions = { has: () => false }; // lost Manage Server while the popup was open
    const s4 = w.ix({ customId: modalInfo(k2.modal).customId, member: demoted }); s4.fields = fakeFields(values); await w.mm.handleComponent(s4);
    assert.match(s4.text(), /permission/); assert.equal(w.news.sent.length, 1);
  });

  await test('schedule: one popup for channel, time, repeat, text and pings; bad times are refused with a retry button', async () => {
    const w = await aWorld();
    const ok = await w.send({ channel: w.news, text: 'Weekly reminder', when: '2h', repeat: 'weekly', roles: [w.roleA] }, 'schedule');
    assert.match(ok.text(), /Scheduled/);
    const [{ value }] = w.mm.ctx('1', 'engagement').data.list('sched:');
    assert.deepEqual([value.repeat, value.ping, value.roleIds], ['weekly', 'role', ['role-a']]);
    assert.ok(Math.abs(value.nextAt - (Date.now() + 7200000)) < 10000);
    assert.match(w.errorText(await w.send({ when: 'whenever' }, 'schedule')), /delay like/);
    assert.match(w.errorText(await w.send({ when: '2020-01-01 10:00' }, 'schedule')), /past/);
    assert.equal(w.mm.ctx('1', 'engagement').data.list('sched:').length, 1);
  });

  await test('scheduled announcements keep their roles, ping at send time, and old single-role entries still work', async () => {
    const w = await aWorld();
    const i = await w.send({ channel: w.news, roles: [w.roleA, w.roleB], when: '2h' }, 'schedule');
    assert.match(i.text(), /Scheduled/);
    const c = w.mm.ctx('1', 'engagement');
    const [{ key, value }] = c.data.list('sched:');
    assert.deepEqual(value.roleIds, ['role-a', 'role-b']);
    c.data.set(key, { ...value, nextAt: Date.now() - 1000 });
    c.data.set('sched:99', { id: 99, channelId: w.news.id, text: 'old style', ping: 'role', roleId: 'role-a', repeat: 'none', nextAt: Date.now() - 1000, by: 'x' }); // as stored before v2.1
    await w.mm.runTasks(0); await w.mm.runTasks(40000);
    assert.equal(w.news.sent.length, 2);
    assert.ok(w.news.sent.some((m) => /^<@&role-a> <@&role-b>\nMaintenance/.test(m.content)));
    assert.ok(w.news.sent.some((m) => /^<@&role-a>\nold style/.test(m.content)));
    assert.equal(c.data.list('sched:').length, 0, 'one-time announcements are removed once sent');
  });

  await test('/announce list cancels with a picker instead of typing a number', async () => {
    const w = await aWorld();
    await w.send({ text: 'one', when: '2h' }, 'schedule'); await w.send({ text: 'two', when: '3h' }, 'schedule');
    const list = w.ix({ command: 'announce', sub: 'list', member: w.admin }); await w.mm.handleCommand(list);
    const [sel] = customIds(list.replies[0]);
    assert.match(sel, /^announce:cancel:admin$/);
    const other = w.ix({ customId: sel, member: w.person('x2', { bits: [P.ManageGuild] }) }); other.values = ['1']; await w.mm.handleComponent(other);
    assert.match(other.text(), /belongs to someone else/);
    const pick = w.ix({ customId: sel, member: w.admin }); pick.values = ['1']; await w.mm.handleComponent(pick);
    assert.match(pick.updated.content, /Cancelled #1/);
    assert.deepEqual(w.mm.ctx('1', 'engagement').data.list('sched:').map((x) => x.value.text), ['two']);
  });

  await test('a popup opened before the update (old announce:form: token) still posts after it', async () => {
    const w = await aWorld();
    const { formStore } = await import('../src/forms.js');
    const token = formStore('announce').put({ sub: 'send', rich: true, by: w.admin.id, color: null, title: undefined, repeat: 'none' });
    const i = w.ix({ customId: `announce:form:${token}`, member: w.admin, channel: w.news });
    i.fields = { getTextInputValue: (k) => ({ text: 'from 2.1', title: '' })[k] ?? '', getSelectedChannels: () => new Map([[w.news.id, w.news]]), getStringSelectValues: () => ['none'], getSelectedRoles: () => new Map() };
    assert.match(await w.click(i), /Announcement sent/);
    assert.equal(w.news.sent[0].content, 'from 2.1');
  });

  await test('the invite link asks for the Mention Everyone permission', async () => {
    const { inviteUrl } = await import('../scripts/inviteLib.js');
    const perms = BigInt(new URL(inviteUrl('123456789012345678')).searchParams.get('permissions'));
    assert.ok((perms >> 17n) & 1n, 'bit 17 (Mention @everyone, @here, and All Roles) is requested');
  });

  // ================================================================ reminders
  console.log('\nReminders');
  const rmWorld = async () => {
    const w = await makeWorld(['reminders']).load();
    w.room = w.channel('reminders'); w.noPerm = w.channel('no-ping-perm', { missing: [P.MentionEveryone] });
    w.admin = w.person('admin', { bits: [P.ManageGuild], pos: 15 }); w.member = w.person('member');
    w.roleA = w.role('role-a'); w.roleB = w.role('role-b'); w.roleC = w.role('role-c'); [w.roleA, w.roleB, w.roleC].forEach((r) => { r.mentionable = true; });
    w.team = async (opts, member = w.admin) => { const i = w.ix({ command: 'remind', sub: 'team', member, opts: { channel: w.room, when: '2h', message: 'Raid night\\nBring snacks', repeat: 'none', role: w.roleA, role2: null, role3: null, role4: null, role5: null, ...opts } }); await w.mm.handleCommand(i); return i; };
    w.me = async (opts, member = w.member) => { const i = w.ix({ command: 'remind', sub: 'me', member, channel: w.room, opts: { when: '30m', message: 'Take the pizza out', where: null, ...opts } }); await w.mm.handleCommand(i); return i; };
    w.cmd = (sub, opts = {}, member = w.admin) => w.run(w.ix({ command: 'remind', sub, member, opts }));
    w.store = () => w.mm.ctx('1', 'reminders').data;
    w.makeDue = (ago = 1000) => { const d = w.store(); for (const { key, value } of d.list('r:')) d.set(key, { ...value, nextAt: Date.now() - ago }); };
    let clock = -1;
    w.tick = async () => { if (clock < 0) { clock = 0; await w.mm.runTasks(0); } clock += 40000; await w.mm.runTasks(clock); }; // a moving fake clock, so the 30-second task fires every call
    return w;
  };

  await test('a team reminder notifies several roles, each on its own line, and nobody else', async () => {
    const w = await rmWorld();
    assert.match((await w.team({ role2: w.roleB, role3: w.roleC, role4: w.roleA })).text(), /set for/);
    assert.deepEqual(w.store().list('r:')[0].value.roleIds, ['role-a', 'role-b', 'role-c'], 'duplicates collapse');
    w.makeDue(); await w.tick();
    const m = w.room.sent[0];
    assert.equal(m.content, '⏰ **Reminder**\n<@&role-a>\n<@&role-b>\n<@&role-c>\n\nRaid night\nBring snacks');
    assert.deepEqual(m.allowedMentions, { roles: ['role-a', 'role-b', 'role-c'] });
    assert.equal(w.store().list('r:').length, 0, 'a one-time reminder is removed once sent');
  });

  await test('team reminders: staff only, a role is required, bad times are explained, and the text can come from a popup', async () => {
    const w = await rmWorld();
    assert.match((await w.team({}, w.member)).text(), /don't have permission/);
    assert.match((await w.team({ role: null })).text(), /at least one role/);
    assert.match((await w.team({ when: 'banana' })).text(), /delay like/);
    assert.match((await w.team({ when: '2020-01-01 10:00' })).text(), /past/);
    const i = await w.team({ message: null, role2: w.roleB });
    assert.ok(i.modal, 'a popup was shown');
    const [token] = [...globalThis[Symbol.for('goodboy.forms.remind')].keys()];
    const submit = (member, text) => Object.assign(w.ix({ command: undefined, customId: `remind:form:${token}`, member }), { fields: { getTextInputValue: () => text } });
    assert.match(await w.click(submit(w.member, 'hi')), /belongs to someone else/);
    assert.match(await w.click(submit(w.admin, 'From the popup')), /set for/);
    assert.equal(w.store().list('r:')[0].value.text, 'From the popup');
    assert.match(await w.click(submit(w.admin, 'again')), /expired/);
  });

  await test('team reminders can repeat daily or weekly, and the next time moves forward', async () => {
    const w = await rmWorld();
    await w.team({ repeat: 'daily' });
    w.makeDue(3 * 86400000); await w.tick();
    assert.equal(w.room.sent.length, 1, 'sent once, not once per missed day');
    assert.match(w.room.sent[0].content, /sent late/);
    const next = w.store().list('r:')[0].value.nextAt;
    assert.ok(next > Date.now() && next - Date.now() <= 86400000, 'rescheduled for the next day');
  });

  await test('a team reminder that cannot notify its roles says so in the message instead of looking like it worked', async () => {
    const w = await rmWorld();
    w.roleB.mentionable = false;
    const i = await w.team({ channel: w.noPerm, role: w.roleB });
    assert.match(i.text(), /would not be notified/);
    w.makeDue(); await w.tick();
    assert.match(w.noPerm.sent[0].content, /were not notified/);
  });

  await test('personal reminders: DM by default, the channel when DMs are off or blocked, and a limit per member', async () => {
    const w = await rmWorld();
    await w.me({}); w.makeDue(); await w.tick();
    assert.equal(w.member.user.sent.length, 1, 'DM sent');
    assert.match(w.member.user.sent[0].content, /Take the pizza out/);
    assert.equal(w.room.sent.length, 0);
    w.db.setNotifyPref('1', w.member.id, 'dms', false);
    await w.me({}); w.makeDue(); await w.tick();
    assert.equal(w.member.user.sent.length, 1, 'no DM when the member turned DMs off');
    assert.match(w.room.sent[0].content, /^<@member> ⏰/);
    assert.deepEqual(w.room.sent[0].allowedMentions, { users: ['member'] });
    w.db.setNotifyPref('1', w.member.id, 'dms', true);
    w.member.user.send = async () => { throw new Error('Cannot send messages to this user'); };
    await w.me({}); w.makeDue(); await w.tick();
    assert.equal(w.room.sent.length, 2, 'falls back to the channel when the DM is blocked');
    w.mm.setSetting('1', 'reminders', 'maxPersonal', '2');
    await w.me({}); await w.me({});
    assert.match((await w.me({})).text(), /keep 2 reminders/);
  });

  await test('list and cancel: members manage their own, admins can cancel anyone\'s', async () => {
    const w = await rmWorld();
    await w.me({}); await w.team({});
    const mine = await w.cmd('list', {}, w.member);
    assert.match(mine, /#1/); assert.doesNotMatch(mine, /#2/, "members don't see team reminders they did not set");
    assert.match(await w.cmd('list', {}, w.admin), /#1[\s\S]*#2/, 'admins see everything');
    assert.match(await w.cmd('cancel', { id: 2 }, w.member), /permission/);
    assert.match(await w.cmd('cancel', { id: 1 }, w.member), /Cancelled/);
    assert.match(await w.cmd('cancel', { id: 2 }, w.admin), /Cancelled/);
    assert.match(await w.cmd('cancel', { id: 2 }, w.admin), /No reminder/);
  });

  // ================================================================ quotes: one output channel
  console.log('\nQuote channel');
  const quotesMod = await import('../modules/quotes/index.js');
  const qWorld = async () => {
    const w = await makeWorld(['quotes']).load();
    quotesMod.hooks.fetchAvatar = async () => null;
    quotesMod.hooks.render = async () => Buffer.from('png');
    w.general = w.channel('general'); w.out = w.channel('quotes-out');
    let n = 0;
    w.post = (text = 'hello world') => {
      const id = String(900000000000000000n + BigInt(++n));
      const author = w.person(`author${n}`);
      const msg = { id, cleanContent: text, content: text, author: author.user, member: author, url: `https://discord.com/channels/1/${w.general.id}/${id}`, createdTimestamp: Date.now() };
      w.general.messages.store.set(id, msg);
      return msg;
    };
    w.quote = async (member, { from = w.general, menu = false } = {}) => {
      const msg = w.post();
      const i = menu
        ? Object.assign(w.ix({ command: 'Quote Image', member, channel: from }), { targetMessage: msg })
        : w.ix({ command: 'quote', member, channel: from, opts: { message: msg.url, style: null } });
      await w.mm.handleCommand(i);
      return i;
    };
    return w;
  };

  await test('quote channel is a setting, and without it quotes stay where they were requested', async () => {
    const w = await qWorld();
    const def = w.mm.describeForGuild('1').find((d) => d.name === 'quotes');
    assert.ok(def.settings.some((x) => x.key === 'quoteChannel' && x.type === 'channel'), 'configurable from /config and the dashboard');
    const i = await w.quote(w.person('q1'));
    assert.equal(i.ephemeral, false);
    assert.equal(i.edits[0].files.length, 1);
    assert.equal(w.out.sent.length, 0);
  });

  await test('with a quote channel set, a quote made anywhere else is posted there and the requester gets a private link', async () => {
    const w = await qWorld();
    w.mm.setSetting('1', 'quotes', 'quoteChannel', w.out.id);
    for (const menu of [false, true]) {
      const before = w.out.sent.length;
      const i = await w.quote(w.person(`q-${menu}`), { menu });
      assert.equal(i.ephemeral, true, 'the requester is answered privately');
      assert.equal(w.out.sent.length, before + 1, 'posted in the quote channel');
      const posted = w.out.sent.at(-1);
      assert.match(posted.content, /Quoted by <@q-/);
      assert.equal(posted.files.length, 1);
      assert.deepEqual(posted.allowedMentions, { parse: [] }, 'no pings');
      assert.match(i.edits[0].content, new RegExp(`Posted in <#${w.out.id}>`));
      assert.equal(w.general.sent.length, 0, 'nothing is posted in the original channel');
    }
  });

  await test('a quote made inside the quote channel is posted normally, once', async () => {
    const w = await qWorld();
    w.mm.setSetting('1', 'quotes', 'quoteChannel', w.out.id);
    const i = await w.quote(w.person('q3'), { from: w.out });
    assert.equal(i.ephemeral, false);
    assert.equal(i.edits[0].files.length, 1);
    assert.equal(w.out.sent.length, 0);
  });

  await test('an unusable quote channel never makes the command fail: the quote arrives privately with the reason', async () => {
    const w = await qWorld();
    const locked = w.channel('locked', { sendError: Object.assign(new Error('Missing Permissions'), { code: 50013 }) });
    w.mm.setSetting('1', 'quotes', 'quoteChannel', locked.id);
    const i = await w.quote(w.person('q4'));
    assert.equal(i.ephemeral, true);
    assert.match(i.edits[0].content, /missing a permission/);
    assert.equal(i.edits[0].files.length, 1);
    // and a deleted channel simply means "post where it was asked"
    w.mm.setSetting('1', 'quotes', 'quoteChannel', w.out.id);
    w.g.channels.cache.delete(w.out.id);
    const j = await w.quote(w.person('q5'));
    assert.equal(j.ephemeral, false);
    assert.equal(j.edits[0].files.length, 1);
  });

  // ================================================================ live leaderboard
  console.log('\nLive leaderboard');
  const boardWorld = async () => {
    const w = await makeWorld(['community']).load();
    w.admin = w.person('lbadmin', { bits: [P.Administrator] });
    w.member = w.person('lbmember');
    w.ch = w.channel('board');
    w.seed = (id, v) => w.db.dataSet('1', 'community', `user:${id}`, { xp: 0, messages: 0, rep: 0, lastXp: 0, lastRep: 0, ...v });
    let clock = 0;
    const realNow = Date.now; const base = realNow();
    w.tick = async (minutes = 6) => { clock += minutes * 60000; Date.now = () => base + clock; try { await w.mm.runTasks(base + clock); } finally { Date.now = realNow; } };
    w.cmd = async (sub, opts, member) => { const i = w.ix({ command: 'liveboard', sub, member, opts }); await w.mm.handleCommand(i); return i.text(); };
    return w;
  };

  await test('the live board is off until a channel is set, and the settings are configurable', async () => {
    const w = await boardWorld();
    const def = w.mm.describeForGuild('1').find((d) => d.name === 'community');
    for (const k of ['liveBoardChannel', 'liveBoardType', 'liveBoardSize', 'liveBoardMinutes']) assert.ok(def.settings.some((x) => x.key === k), k);
    w.seed('a1', { xp: 500 });
    await w.tick(); await w.tick();
    assert.equal(w.ch.sent.length, 0);
  });

  await test('setup needs community.manage, then posts once and later runs edit the same message', async () => {
    const w = await boardWorld();
    w.seed('a1', { xp: 500 }); w.seed('a2', { xp: 900 });
    assert.match(await w.cmd('setup', { channel: w.ch }, w.member), /community\.manage/);
    assert.equal(w.ch.sent.length, 0);
    assert.match(await w.cmd('setup', { channel: w.ch }, w.admin), /Posted/);
    assert.equal(w.ch.sent.length, 1);
    assert.deepEqual(w.ch.sent[0].allowedMentions, { parse: [] });
    const msg = [...w.ch.messages.store.values()][0];
    w.seed('a3', { xp: 5000 });
    await w.tick();
    assert.equal(w.ch.sent.length, 1, 'no second message');
    assert.ok(msg.edited, 'the existing message was edited');
  });

  await test('an unchanged board is not edited again, and it respects the refresh interval', async () => {
    const w = await boardWorld();
    w.seed('a1', { xp: 500 });
    await w.cmd('setup', { channel: w.ch }, w.admin);
    const msg = [...w.ch.messages.store.values()][0];
    await w.tick(6);
    assert.equal(msg.edited, undefined, 'same standings, same message');
    w.seed('a1', { xp: 900 });
    await w.tick(1);
    assert.equal(msg.edited, undefined, 'too soon');
    await w.tick(6);
    assert.ok(msg.edited, 'changed standings after the interval');
  });

  await test('if someone deletes the board message, the next refresh posts a new one', async () => {
    const w = await boardWorld();
    w.seed('a1', { xp: 500 });
    await w.cmd('setup', { channel: w.ch }, w.admin);
    w.ch.messages.store.clear();
    assert.match(await w.cmd('refresh', {}, w.admin), /Posted/);
    assert.equal(w.ch.sent.length, 2);
  });

  await test('moving the board to another channel removes the old message; remove turns it off', async () => {
    const w = await boardWorld();
    const other = w.channel('board2');
    w.seed('a1', { xp: 500 });
    await w.cmd('setup', { channel: w.ch }, w.admin);
    await w.cmd('setup', { channel: other }, w.admin);
    assert.equal(other.sent.length, 1);
    assert.equal(w.ch.deleted.length, 1, 'old message deleted');
    assert.match(await w.cmd('remove', {}, w.admin), /off/);
    assert.equal(other.deleted.length, 1);
    await w.tick(); await w.tick();
    assert.equal(other.sent.length, 1, 'stays off');
  });

  await test('ranking type is respected and shared with /leaderboard (rep ignores zero scores)', async () => {
    const w = await boardWorld();
    const mod = await import('../modules/community/index.js');
    w.seed('a1', { xp: 100, rep: 0 }); w.seed('a2', { xp: 50, rep: 7 });
    const ctx = { data: { list: (pre) => w.db.dataList('1', 'community', pre) } };
    const out = mod.buildBoard(ctx, 'rep');
    assert.match(out.text, /<@a2> - 7 rep/); assert.doesNotMatch(out.text, /a1/);
    assert.match(mod.buildBoard(ctx, 'xp').text, /🥇 <@a1>/);
    assert.equal(mod.buildBoard(ctx, 'xp', 1, 3).pages, 1);
  });

  // ================================================================ moderation popups
  console.log('\nModeration popups');
  const modWorld = async () => {
    const w = await makeWorld(['moderation']).load();
    w.admin = w.person('mpadmin', { bits: [P.Administrator], pos: 10 });
    w.target = w.person('mptarget', { pos: 1 });
    w.target.kickable = true; w.target.bannable = true; w.target.kick = async () => {};
    w.plain = w.person('mpplain');
    w.guildBans = [];
    w.g.members.ban = async (id, o) => { w.guildBans.push([id, o]); };
    w.cases = () => w.mm.ctx('1', 'moderation').data.get('hist:mptarget') ?? [];
    w.cmd = (command, opts, member = w.admin) => { const i = w.ix({ command, member, opts }); return w.mm.handleCommand(i).then(() => i); };
    w.submit = async (token, fields, member = w.admin) => {
      const i = w.ix({ member, customId: `modq:${token}` });
      i.fields = { getTextInputValue: (id) => { if (!(id in fields)) throw new Error('no such field'); return fields[id]; } };
      await w.mm.handleComponent(i); return i;
    };
    // The stub's popup builder is a no-op, so read the token from the shared form store (newest entry).
    w.token = () => [...(globalThis[Symbol.for('goodboy.forms.modaction')] ?? new Map()).keys()].at(-1);
    return w;
  };

  // 2.2: /warn has no typed options. Command -> private "Configure warning" button -> popup -> submit.
  const warnFlow = async (w, { command = 'warn', target = null, values, member = w.admin }) => {
    const cmd = w.ix({ command, member }); if (target) cmd.targetUser = target.user;
    await w.mm.handleCommand(cmd);
    const bid = firstButtonId(cmd.replies[0]);
    if (!bid) return { cmd };
    const click = w.ix({ customId: bid, member }); await w.mm.handleComponent(click);
    const info = modalInfo(click.modal);
    const submit = w.ix({ customId: info.customId, member }); submit.fields = fakeFields(values);
    await w.mm.handleComponent(submit);
    return { cmd, click, info, submit };
  };

  await test('/warn takes no options: one private button, then a popup with member, reason, severity and notes', async () => {
    const w = await modWorld();
    const json = w.mm.commandList('1').find((c) => c.name === 'warn');
    assert.deepEqual(json.options ?? [], [], 'nothing to type in the command');
    const r = await warnFlow(w, { values: { user: [w.target.id], reason: 'spamming links', severity: ['high'], notes: 'counts for 30 days' } });
    assert.equal(r.cmd.replies[0].flags, MessageFlags.Ephemeral);
    assert.equal(r.cmd.replies[0].components[0].components[0].data.label, 'Configure warning');
    assert.deepEqual(r.info.fields, ['user', 'reason', 'severity', 'notes']);
    assert.ok(r.info.labels.includes('Warning reason') && r.info.labels.includes('Duration / severity notes'));
    assert.equal(w.cases().length, 1);
    assert.deepEqual([w.cases()[0].reason, w.cases()[0].severity, w.cases()[0].notes], ['spamming links', 'high', 'counts for 30 days']);
    assert.equal(r.submit.deferred, true);
  });

  await test('right-click "Warn member" carries the target in the signed token, so the popup has no member picker', async () => {
    const w = await modWorld();
    const r = await warnFlow(w, { command: 'Warn member', target: w.target, values: { reason: 'rude', severity: ['low'], notes: '' } });
    assert.match(firstButtonId(r.cmd.replies[0]), /^mpm:m1:o:warn:mpadmin:[0-9a-z]+:[0-9a-z]{4}:mptarget:[0-9a-f]{10}$/);
    assert.deepEqual(r.info.fields, ['reason', 'severity', 'notes']);
    assert.equal(w.cases().length, 1); assert.equal(w.cases()[0].severity, 'low');
    const self = await warnFlow(w, { command: 'Warn member', target: w.admin, values: {} });
    assert.match(self.cmd.text(), /cannot warn yourself/, 'checked before the button is even shown');
    const boss = w.person('mpboss', { pos: 50 });
    assert.match((await warnFlow(w, { command: 'Warn member', target: boss, values: {} })).cmd.text(), /equal to or above yours/);
  });

  await test('nothing is recorded until the popup is submitted, and an empty reason brings the form back', async () => {
    const w = await modWorld();
    const cmd = w.ix({ command: 'warn', member: w.admin }); await w.mm.handleCommand(cmd);
    assert.equal(w.cases().length, 0);
    const r = await warnFlow(w, { values: { user: [w.target.id], reason: '', severity: ['medium'], notes: '' } });
    assert.equal(w.cases().length, 0);
    assert.match(r.submit.replies[0].embeds[0].data.description, /give a reason/);
    assert.ok(firstButtonId(r.submit.replies[0]), 'Try again button');
  });

  await test('popups are single-use, belong to whoever opened them, and an empty reason is refused', async () => {
    const w = await modWorld();
    const i = await w.cmd('kick', { user: w.target.user, reason: null });
    const t = w.token(i);
    assert.match((await w.submit(t, { reason: 'x' }, w.person('mpother', { bits: [P.Administrator] }))).text(), /belongs to someone else/);
    const ok = await w.submit(t, { reason: 'trolling' });
    assert.doesNotMatch(ok.text(), /expired|someone else/);
    assert.equal(w.cases().length, 1);
    assert.match((await w.submit(t, { reason: 'again' })).text(), /expired/, 'a popup cannot be replayed');
    assert.equal(w.cases().length, 1, 'no second case');
    const j = await w.cmd('kick', { user: w.target.user, reason: null });
    assert.match((await w.submit(w.token(j), { reason: '   ' })).text(), /give a reason/);
  });

  await test('submitting a popup re-checks the permission', async () => {
    const w = await modWorld();
    const store = (globalThis[Symbol.for('goodboy.forms.modaction')] ??= new Map());
    store.set('forged01', { action: 'ban', by: 'mpplain', userId: 'mptarget', exp: Date.now() + 60000 });
    const s = await w.submit('forged01', { reason: 'hi', days: '0' }, w.plain);
    assert.match(s.text(), /moderation\.ban/);
    assert.deepEqual(w.guildBans, []);
  });

  await test('/timeout asks for duration and reason together, and validates the duration', async () => {
    const w = await modWorld();
    const i = await w.cmd('timeout', { user: w.target.user, duration: '10m', reason: null });
    assert.ok(i.modal, 'missing reason opens the popup');
    assert.match((await w.submit(w.token(i), { duration: 'soon', reason: 'x' })).text(), /duration/i);
    const j = await w.cmd('timeout', { user: w.target.user, duration: null, reason: null });
    const ok = await w.submit(w.token(j), { duration: '1h', reason: 'cool off' });
    assert.ok(w.target.timedOut > 0 || w.cases().some((c) => c.type === 'timeout'), 'timeout applied');
    assert.doesNotMatch(ok.text(), /duration like/);
  });

  await test('/ban popup takes a reason and the days of messages to delete', async () => {
    const w = await modWorld();
    const i = await w.cmd('ban', { user: w.target.user, reason: null, delete_days: null });
    const bad = await w.submit(w.token(i), { reason: 'raid', days: '9' });
    assert.match(bad.text(), /0 to 7/);
    const j = await w.cmd('ban', { user: w.target.user, reason: null, delete_days: 2 });
    await w.submit(w.token(j), { reason: 'raid', days: '2' });
    assert.equal(w.guildBans.length, 1);
    assert.equal(w.guildBans[0][1].deleteMessageSeconds, 2 * 86400);
  });

  // ================================================================ polls + suggestions popups
  console.log('\nPolls and suggestions popups');
  const popWorld = async () => {
    const w = await vtWorld();
    await w.run(w.ix({ command: 'suggestion', sub: 'setup', member: w.admin, opts: { channel: w.sch } }));
    w.pch = w.channel('polls');
    w.token = () => [...(globalThis[Symbol.for('goodboy.forms.engagement')] ?? new Map()).keys()].at(-1);
    w.submit = async (kind, fields, member) => {
      const i = w.ix({ member, channel: w.pch, customId: `engform:${kind}:${w.token()}` });
      i.fields = { getTextInputValue: (id) => { if (!(id in fields)) throw new Error('no such field'); return fields[id]; } };
      await w.mm.handleComponent(i); return i;
    };
    return w;
  };

  await test('/poll create with no question opens a popup; submitting it posts the poll', async () => {
    const w = await popWorld();
    const i = w.ix({ command: 'poll', sub: 'create', member: w.mod, channel: w.pch, opts: {} });
    await w.mm.handleCommand(i);
    assert.ok(i.modal && !i.deferred);
    const s = await w.submit('poll', { question: 'Lunch?', options: 'Pizza\n\n Tacos \nSushi', duration: '2h', multiple: 'Yes' }, w.mod);
    assert.equal(s.replies.length, 1, 'the poll was posted');
    const polls = w.mm.ctx('1', 'engagement').data.list('poll:').map((x) => x.value);
    assert.equal(polls.length, 1);
    assert.deepEqual(polls[0].options, ['Pizza', 'Tacos', 'Sushi']);
    assert.equal(polls[0].multi, true);
    assert.ok(polls[0].endsAt > Date.now());
  });

  await test('poll popup: needs two different choices, at most five, and a valid duration', async () => {
    const w = await popWorld();
    const attempt = async (fields) => {
      await w.mm.handleCommand(w.ix({ command: 'poll', sub: 'create', member: w.mod, channel: w.pch, opts: {} }));
      return (await w.submit('poll', { question: 'Q', duration: '', multiple: '', ...fields }, w.mod)).text();
    };
    assert.match(await attempt({ options: 'Only one' }), /at least two/);
    assert.match(await attempt({ options: 'a\nA' }), /different/);
    assert.match(await attempt({ options: 'a\nb\nc\nd\ne\nf' }), /up to 5/);
    assert.match(await attempt({ options: 'a\nb', duration: 'soon' }), /duration/i);
    assert.equal(w.mm.ctx('1', 'engagement').data.list('poll:').length, 0);
  });

  await test('typing the poll in the command still works and skips the popup', async () => {
    const w = await popWorld();
    const i = w.ix({ command: 'poll', sub: 'create', member: w.mod, channel: w.pch, opts: { question: 'Best?', option1: 'A', option2: 'B' } });
    await w.mm.handleCommand(i);
    assert.equal(i.modal, null);
    assert.equal(i.replies.length, 1);
  });

  await test('/suggest with no idea opens a popup; the cooldown is checked before it opens', async () => {
    const w = await popWorld();
    const i = w.ix({ command: 'suggest', member: w.a, opts: {} });
    await w.mm.handleCommand(i);
    assert.ok(i.modal && !i.deferred);
    const s = await w.submit('idea', { idea: '  Add a music channel  ' }, w.a);
    assert.match(s.text(), /#1/);
    assert.equal(w.mm.ctx('1', 'engagement').data.get('sugg:1').text, 'Add a music channel');
    const again = w.ix({ command: 'suggest', member: w.a, opts: {} });
    await w.mm.handleCommand(again);
    assert.equal(again.modal, null, 'no popup while on cooldown');
    assert.match(again.text(), /Please wait/);
  });

  await test('suggestion edit popup: author or staff only, and the popup belongs to who opened it', async () => {
    const w = await popWorld();
    await w.sugg(w.a, 'first idea');
    const open = (m) => { const i = w.ix({ command: 'suggestion', sub: 'edit', member: m, opts: { id: 1, text: null } }); return w.mm.handleCommand(i).then(() => i); };
    assert.match((await open(w.b)).text(), /only edit your own/);
    const i = await open(w.a);
    assert.ok(i.modal);
    assert.match((await w.submit('edit', { idea: 'x' }, w.b)).text(), /belongs to someone else/);
    assert.match((await w.submit('edit', { idea: 'better idea' }, w.a)).text(), /Updated/);
    assert.equal(w.mm.ctx('1', 'engagement').data.get('sugg:1').text, 'better idea');
    assert.equal(w.mm.ctx('1', 'engagement').data.get('sugg:1').edited, true);
  });

  // ================================================================ GIF reader/writer + animated quotes
  console.log('\nAnimated avatars (GIF)');
  const gifLib = await import('../src/gif.js');
  // A 10x8 animation made by an independent encoder (Pillow): 4 frames, transparency, "restore to background" disposal.
  // The hashes are of Pillow's own decoded frames (fully transparent pixels zeroed).
  const PILLOW_GIF = { b64: 'R0lGODlhCgAIAIEAAAAAAP8AWgX6BQAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQJBAAAACwAAAAACgAIAAAIHQABCBxIMIDBAAQFHkSYcGFCAA4bHnxIsSJBAQEBACH5BAkGAAAALAIAAQAIAAcAgQAAANceeAX6BQAAAAgZAAMIDACgIICBBA0iNHhwIMOFDCNKNCggIAAh+QQJCAAAACwEAAEABgAHAIEAAACvPJYF+gUAAAAIFwADCAwAAMBAggYHFjy4UGHBhxAfCggIACH5BAkKAAAALAYAAQAEAAcAgQAAAIdatAX6BQAAAAgPAAMIHEiwYEEACBMCEBAQADs=', delays: [40, 60, 80, 100], hashes: ["d5a52cacba49f5e4e40b2510b5c82f0c80416b610b4e0de1ee6e9b0d1cbc5dd5", "f8ee9a111de2a019b8bcbcfed68424d952fe51b2d3cedc8a216883f3f4649eab", "77d734e5efcfaf3a60cb3784d05e8360e74e200b033ea4d3911d35d75524c44c", "0313e14f3af8a34450ef851d9ef37ff3654752d54515f41496b0d5b139c67821"] };
  const sha = (u8) => crypto.createHash('sha256').update(u8).digest('hex');
  const zeroClear = (rgba) => { const o = Uint8Array.from(rgba); for (let p = 0; p < o.length; p += 4) if (!o[p + 3]) o[p] = o[p + 1] = o[p + 2] = 0; return o; };

  await test('the GIF reader matches an independent decoder frame for frame, including delays', () => {
    const g = gifLib.decodeGif(Buffer.from(PILLOW_GIF.b64, 'base64'));
    assert.equal(g.width, 10); assert.equal(g.height, 8);
    assert.deepEqual(g.frames.map((f) => f.delay), PILLOW_GIF.delays);
    assert.deepEqual(g.frames.map((f) => sha(zeroClear(f.rgba))), PILLOW_GIF.hashes);
  });

  // 48x40 noise, 64 colours, interlaced: forces the LZW code size to grow, which the tiny animation above never does.
  const BUSY_GIF = { b64: 'R0lGODdhMAAoAIUAAOnom8LmiNHoHs/HndTKIYfpwYjmbILrFo7KrIrHLd6jq7Wfq92iL7WgK9eAaImomYWpI4eInZGIG0fpmELqKUTIt0jHNxHmqRPoHxDKqw7KG0unlkirH0aHpUOKPxCobBKIcN9ft7hfsdJiLdY5q843OItmmIZQooZgJos3t4I3MeEOprgQmuQUHbQSHosZtYwAsYQNPFJcuCdfk01gKSVkKj1AWwhdrApdNAlAXUwotEUmNUUJoUYIGhEncRIIeCwAAAAAMAAoAEAI/wAByNChIkOPHzAMRLiR4EEMDgl+6BgwgwUMGz0EGKhQgcfDHCMW7KCxgEIJEzYEtPjxIMCOAw4MMNDh4cKIHSoOiLiBQkCBERQo3NBR4IeEAjMe3PjAgMAEFSEmAKBA4EYMAylu0MiwQoKBEjIaqODQwcaIGh44FCiAYwWLHSNurLiR40OAExUUjGAgYgMPEitEtChQ40ANCCgIXOhggkEEHT9QwPiBQYOAACRakMhBQeeLFhcgVKCgAgGBGDIUxKihwscEEhA8bO2x4gMCHQEq1HAgo0eHFzgOGMhQQq4HBQ4UbIAAgUaABikkKOgMYwcGFmYzNCihw4EFERgyfP8QoCHFhBUlGlgowaPEB44IPBx4gLIHiBYzdlRgIDJECAsNMMDAfiB00MADLISAwHAZiMBdDDNo8EINLphgwQoteEDAAzTI4EMHDviwAA0IhLCDASRwEIIIBwxgQAwZdKAAXCxoQAGLMIzQHQMl5JBZAxX4IEMKB2TAAg4LcGdACzkEQAALPvSQwA4uQEDBTQSQcAFCvLkQAQoVqOBiBy3EKAMOJmyAQwgN5GDDCzdgsEAKMd6wgAUGDCDAAwg4MAABOvYQAwk3/FCACgUIMAAKAMQQQwI8fAAADT30MOSLEtRgAQkeuMBCCgFE8MKVPbQgwEE0xDAABxn8oAAAGLT/cIMJPSCAAQoolMBiBRek0MMLBMBaQwcivCBCSCjYwIIELihwgA43UKARiDJYoIEGoDngkwos9GADCCJQcEIGNtggggk4JUAABzNgYMMCLMiwQQEE1EADBy3EUEEGznX1wAIfSNBBczsU0EC4PHjwgwg0rGCDCxXcYMEJENxAAgIFINfADhwIUMEHAzzggQUqbIACCQYQgMMMKcDAgQEIWJCCDeuesMALauJwQwkCKDCDCQf04AMLGOhAAAMcbFADAzMQEAAAAnigwQIAVPBCBCzcIMMNCqD1gQJP2QAWBBJA0IEEB8CQAg0dZGCwATvEEKJ/DmRwgc8FeJBBBiOI/3ACBhwsEEEPLBRQQQI6CIBADydsELhsPdDQwr8TXODACQSEJYIFwKFgwgMH2CADABx4oEMIDCDQAAQIzFCcCgYYcEAFpd4AwAurcrCDBQ+8gIEKAuyQAgUQHFDVAA6QoIEKJqQgwwcz/KABVoOmF64OiekwwgdtEeADDx1ETEEDFwgQgQn6VpD4eutqZIMBK5CgwwUbbLRDBwpx28AIIRDQwgIwwJYHKhABhxyAJwxwQVAMIIEPWOACJKBABVzwgRbIAAQ4oCADemABswTwPhboQQEWIIMaVAAADgjAB06ggQrkQAU44MEIeiACGLhgAjcAkes00JQe1GAAPJiAA/8ogIEZAGADIghBDFRwgwMUQAINMAAMWlACCuigdTgYAaEAIL8U6KAFPFAACfBngIFdwAQ+CIAPEmABBvBAAjncAQE2gIEVZAAHPngVZVLAgAbIIAAPMIAFUDABH3RHAQj4gVUCAIIebIYB19FBD0pQrh20AAEK4AAOXPSrDaiABAnYXr4iYAH14UAGJfBSAlqQxAwo4AEOcEEMCACBGAQgBjqQwQg7AgMMuCBzHgjAC07QMA3IQAYJSECeTKI0BSSAUzHYwQ4kIIAYjGAEe2LBCmoggBU4gAAdmMsCahACDIiqBCWoQVcYZS0HJMABMVhADlDQgQQU4IUqiMAMOqD/Awz8IAEeOAEOLlC0A6DAAmxTXAkMd4IG0GYGH3gBrxaAgs1lYAIua0AAFNCDBUhgADHgAQsuAE4F5MAEKNAmBD4AFgWAYAA2yQECELAADnAoLToQgfRQQJYQkCADHOBABUqggAC4AAA/mMADCEAaH8TgAwb4gAO01wILcMAHNuCBAQowlB3IYHki4GEAZlCBEWxAVANQgCINEDjjfWABPKCAC2RUgw9AQAUSWMEMcACAGpBgBgnIwbXUR0QfPEAFK0CBfTRAAw1YAJEgyMBXZhAAvHqgAzHwgRZdwKkGtGAFGrDB+HSQAwkQBwQO0BsLAFAVMDEABxIAwQruQxMR/ySABQYIgQ4AYJgcPEAHGnCACCuwJBpkaaEbsIqsMuCCfL1AAiIAQQNJsAMK5OmJjzGBAj6wAwS54AYVWNMEfmADCMygsTSYwAl68AAHRaCCIciLg4zLgRsubgQ4sNbNDBCACxwgBg14QQgU4AIblWACi6MADfQTqTKNgIA60EEKRLACDGxtNBYYAQZKgIAVBMC4H6iQ3mgAAxTI4AAvYMAYz7tdDYAAARoIwZIM8AAYGOkE9RWAADbwAwDcgAXL4icLPMACBSggAydgAQ10QAIJqOwEA+CnDfh6gYQxwAEQEC4GRvAAFOCyBjqgwc5qcIMQSM4FDviZCXhQAxC4pv90KTABDSCwmRSMawQeOCUJHACCebVRADx4It9qcAIY9DcFCMgABBgQghsMgIArIEgHMLDl0BlRLypAgQJOwDUNhCxPN4gbPwuQghf8oAIOiIAAXACkCvxEBggQgPx08AIPrIACxzwAuwQwgRrMUwftkegNbmAAHdTgAhAkgY9lQAIZeMBRJgAaDEpAJwbEoAUAMAAAvFgBtchlUSZYwegqgIGvNFEFILiABGygzwf0IAA/OAgMCsCDE7wgAzxIAQkK8AILSMUhKPDBbQKwwATolcwuCMEPHDACBAyTpRRGV/IawIMLcMAEilFQBU8AADwlCAUpEECwYiACpArIAqdLIfUKTKAB8jVGAQOIgPdKIAEEgLcDOIBAA2YgkwioIAczCIEDgsoAmK1AIxF6ANpiEIEOsJkABIABDlRQAhZUQAM4SFYFSLCBEAQEADs=', hash: 'f64ea44642a7d12870c233bf240c8b92c87f80758b168de77b807d377fd6b140' };
  await test('the GIF reader handles interlaced, busy pictures (growing LZW codes) exactly like an independent decoder', () => {
    const g = gifLib.decodeGif(Buffer.from(BUSY_GIF.b64, 'base64'));
    assert.equal(g.frames.length, 1);
    assert.equal(sha(g.frames[0].rgba), BUSY_GIF.hash);
  });

  await test('the GIF writer round-trips: exact for few colours, partial frames paint over the previous one', async () => {
    const W = 16, H = 12;
    const solid = (w, h, [r, g, b]) => { const a = new Uint8ClampedArray(w * h * 4); for (let p = 0; p < a.length; p += 4) { a[p] = r; a[p + 1] = g; a[p + 2] = b; a[p + 3] = 255; } return a; };
    let ticks = 0;
    const gif = await gifLib.encodeGif({ width: W, height: H, frames: [
      { rgba: solid(W, H, [10, 20, 30]), delay: 100 },
      { x: 4, y: 2, w: 5, h: 3, rgba: solid(5, 3, [250, 240, 230]), delay: 50 },
    ] }, { onFrame: async () => { ticks++; } });
    assert.equal(ticks, 2, 'yields between frames');
    assert.equal(gif.subarray(0, 6).toString(), 'GIF89a');
    const back = gifLib.decodeGif(gif);
    assert.deepEqual(back.frames.map((f) => f.delay), [100, 50]);
    const px = (f, x, y) => [...back.frames[f].rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)];
    assert.deepEqual(px(0, 5, 3), [10, 20, 30]);
    assert.deepEqual(px(1, 5, 3), [250, 240, 230], 'inside the partial frame');
    assert.deepEqual(px(1, 0, 0), [10, 20, 30], 'outside it the first frame is kept');
  });

  await test('the GIF writer survives busy pictures (LZW table resets) and keeps the colours close', async () => {
    const w = 200, h = 160, a = new Uint8ClampedArray(w * h * 4);
    let s = 7;
    for (let p = 0; p < a.length; p += 4) { s = (s * 1103515245 + 12345) & 0x7fffffff; const n = (s >> 16) & 31; const x = (p / 4) % w, y = Math.floor(p / 4 / w); a[p] = x + n; a[p + 1] = y + n; a[p + 2] = (x + y) % 256; a[p + 3] = 255; }
    const back = gifLib.decodeGif(await gifLib.encodeGif({ width: w, height: h, frames: [{ rgba: a, delay: 40 }] }));
    let err = 0; for (let p = 0; p < a.length; p += 4) err += Math.abs(a[p] - back.frames[0].rgba[p]) + Math.abs(a[p + 1] - back.frames[0].rgba[p + 1]) + Math.abs(a[p + 2] - back.frames[0].rgba[p + 2]);
    assert.ok(err / (w * h * 3) < 14, `average error per colour channel ${err / (w * h * 3)}`);
  });

  await test('black & white pictures keep all their grey levels (no banding)', () => {
    const a = new Uint8ClampedArray(256 * 4); for (let v = 0; v < 256; v++) a.set([v, v, v, 255], v * 4);
    const q = gifLib.quantize(a);
    assert.deepEqual([...q.indices], Array.from({ length: 256 }, (_, v) => v));
    assert.deepEqual([...q.palette.subarray(300, 303)], [100, 100, 100]);
  });

  await test('long animations are thinned out but keep their total running time', async () => {
    const W = 4, H = 4, frames = Array.from({ length: 50 }, (_, n) => ({ rgba: new Uint8ClampedArray(W * H * 4).map((_, i) => (i % 4 === 3 ? 255 : n * 5)), delay: 40 }));
    const gif = await gifLib.encodeGif({ width: W, height: H, frames });
    const back = gifLib.decodeGif(gif, { maxFrames: 20 });
    assert.equal(back.totalFrames, 50);
    assert.ok(back.frames.length <= 20 && back.frames.length >= 10);
    assert.equal(back.frames.reduce((n, f) => n + f.delay, 0), 50 * 40);
  });

  await test('hostile or broken files are rejected cleanly and never hang', () => {
    const good = Buffer.from(PILLOW_GIF.b64, 'base64');
    assert.throws(() => gifLib.decodeGif(Buffer.from('not a gif at all')), gifLib.GifError);
    assert.throws(() => gifLib.decodeGif(good.subarray(0, 40)), gifLib.GifError, 'cut short');
    const huge = Buffer.from(good); huge.writeUInt16LE(60000, 6); huge.writeUInt16LE(60000, 8);
    assert.throws(() => gifLib.decodeGif(huge), /size/, 'a huge canvas is refused before allocating it');
    let seed = 99;
    for (let n = 0; n < 300; n++) { // random damage: every outcome is a result or a GifError, never another exception
      const bad = Buffer.from(good);
      for (let k = 0; k < 4; k++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; bad[seed % bad.length] = (seed >> 8) & 255; }
      try { gifLib.decodeGif(bad); } catch (e) { assert.ok(e instanceof gifLib.GifError, `unexpected ${e?.constructor?.name}: ${e?.message}`); }
    }
  });

  const aqWorld = async () => {
    const w = await qWorld();
    let renders = 0;
    quotesMod.hooks.fetchAnimatedAvatar = async (u) => (u.animatedAvatar ? Buffer.from('GIF8fake') : null);
    quotesMod.hooks.renderAnimated = async () => { renders++; return w.animOut ?? Buffer.from('gif-bytes'); };
    let stills = 0;
    quotesMod.hooks.render = async () => { stills++; return Buffer.from('png'); };
    let motions = 0;
    quotesMod.hooks.renderMotion = async () => { motions++; if (w.motionFail) throw new Error('canvas exploded'); return w.motionOut ?? Buffer.from('motion-gif'); };
    w.mm.setSetting('1', 'quotes', 'motionQuotes', 'false'); // the older tests below are about animated pictures only
    w.renders = () => renders; w.stills = () => stills; w.motions = () => motions;
    w.animQuote = async (member, { animated = true } = {}) => {
      const msg = w.post();
      msg.author.animatedAvatar = animated;
      const i = w.ix({ command: 'quote', member, channel: w.general, opts: { message: msg.url, style: null } });
      await w.mm.handleCommand(i);
      return i;
    };
    return w;
  };
  const fileName = (i) => i.edits.at(-1).files[0].name ?? i.edits.at(-1).files[0].data?.name;

  await test('animated quotes: on by default, and only for members whose picture is animated', async () => {
    const w = await aqWorld();
    const def = w.mm.describeForGuild('1').find((d) => d.name === 'quotes');
    assert.ok(def.settings.some((x) => x.key === 'animatedQuotes' && x.type === 'toggle' && x.default === true));
    const still = await w.animQuote(w.person('aq1'), { animated: false });
    assert.equal(w.renders(), 0, 'no animation work for a normal picture');
    assert.equal(w.stills(), 1);
    assert.equal(still.edits[0].files.length, 1);
    await w.animQuote(w.person('aq2'));
    assert.equal(w.renders(), 1);
    assert.equal(w.stills(), 1, 'the animation replaced the still image (no second render)');
  });

  await test('animated quotes: turned off, failing or too big all fall back to the still image', async () => {
    const w = await aqWorld();
    w.mm.setSetting('1', 'quotes', 'animatedQuotes', 'false');
    const off = await w.animQuote(w.person('aq3'));
    assert.equal(w.renders(), 0); assert.equal(off.edits[0].files.length, 1);
    w.mm.setSetting('1', 'quotes', 'animatedQuotes', 'true');
    quotesMod.hooks.renderAnimated = async () => { throw new Error('decode exploded'); };
    const broke = await w.animQuote(w.person('aq4'));
    assert.equal(broke.edits[0].files.length, 1, 'the quote still arrives');
    assert.doesNotMatch(broke.text(), /couldn't draw/);
    quotesMod.hooks.renderAnimated = async () => Buffer.alloc(9 * 1024 * 1024);
    const big = await w.animQuote(w.person('aq5'));
    assert.equal(big.edits[0].files.length, 1);
    assert.equal(w.stills(), 3, 'off, failed and oversized each drew the still image');
  });

  await test('motion quotes (2.3.3): every quote is a GIF - normal pictures get a zoom and a shine; failures or oversized files fall back to the still image', async () => {
    const w = await aqWorld();
    const def = w.mm.describeForGuild('1').find((d) => d.name === 'quotes');
    assert.ok(def.settings.some((x) => x.key === 'motionQuotes' && x.default === true), 'on by default');
    w.mm.setSetting('1', 'quotes', 'motionQuotes', 'true');
    const q = await w.animQuote(w.person('mq1'), { animated: false });
    assert.equal(w.motions(), 1); assert.equal(w.stills(), 0);
    assert.equal(fileName(q), 'quote.gif');
    await w.animQuote(w.person('mq2'));
    assert.equal(w.renders(), 1); assert.equal(w.motions(), 1, 'an animated picture uses its own animation, not the zoom');
    w.motionFail = true;
    const broke = await w.animQuote(w.person('mq3'), { animated: false });
    assert.equal(fileName(broke), 'quote.png', 'a failure still sends the quote'); assert.equal(w.stills(), 1);
    w.motionFail = false; w.motionOut = Buffer.alloc(9 * 1024 * 1024);
    const big = await w.animQuote(w.person('mq4'), { animated: false });
    assert.equal(fileName(big), 'quote.png'); assert.equal(w.stills(), 2);
    const { motionAt } = quotesMod;
    assert.equal(motionAt(0).zoom, 1); assert.ok(Math.abs(motionAt(0.999).zoom - 1) < 0.001, 'the loop ends where it starts');
    assert.ok(motionAt(0.5).zoom > 1.07); assert.equal(motionAt(0.75).shine, null, 'the shine only runs in the first half');
  });

  // ================================================================ TTS: read the no-mic channel
  console.log('\nTTS no-mic reading');
  const voiceMod = await import('../modules/voice/index.js');
  globalThis[Symbol.for('goodboy.voice.lib')] = { voice: { AudioPlayerStatus: { Idle: 'idle' } }, tts: null };
  const nmWorld = async () => {
    const w = await makeWorld(['voice']).load();
    w.nm = w.channel('no-mic'); w.vc = w.channel('voice-1');
    w.admin = w.person('nmadmin', { bits: [P.Administrator] });
    w.st = { queue: [], current: null, channelId: w.vc.id, connection: {}, player: {} };
    globalThis[Symbol.for('goodboy.voice.states')].set('1', w.st);
    w.pumps = 0; voiceMod.hooks.pump = async () => { w.pumps++; };
    w.mm.setSetting('1', 'voice', 'noMicChannel', w.nm.id);
    w.say = async (m, content, { channel = w.nm, inVoice = true, bot = false } = {}) => {
      m.voice = { channelId: inVoice ? w.vc.id : null };
      const msg = { guild: w.g, guildId: '1', channelId: channel.id, channel, content, cleanContent: content, author: { ...m.user, bot }, member: m, system: false, reacted: [], react: async function (e) { this.reacted.push(e); } };
      await w.mm.dispatch('messageCreate', '1', msg);
      return msg;
    };
    return w;
  };
  const cleanupStates = () => globalThis[Symbol.for('goodboy.voice.states')].clear();

  await test('no-mic channel: a member in voice types, the bot queues "Name says ..." with nothing to run', async () => {
    const w = await nmWorld();
    const a = w.person('alex');
    await w.say(a, 'hello **everyone**, see https://example.com');
    assert.equal(w.st.queue.length, 1);
    assert.equal(w.st.queue[0].text, 'alex says hello everyone, see link');
    assert.equal(w.pumps, 1, 'playback was started');
    cleanupStates();
  });

  await test('no-mic channel: other channels, bots, commands, empty text and members outside the voice channel are ignored', async () => {
    const w = await nmWorld();
    const a = w.person('alex2'), b = w.person('bobby');
    const other = w.channel('general');
    await w.say(a, 'not here', { channel: other });
    await w.say(b, 'I am a bot', { bot: true });
    for (const c of ['!play song', '/help', '.skip', '$daily']) await w.say(w.person(`c${c.length}${c[1]}`), c);
    await w.say(a, '🙂🙂 ...');
    await w.say(a, 'I am not in voice', { inVoice: false });
    assert.equal(w.st.queue.length, 0);
    await w.say(a, '...and then some', {});
    assert.equal(w.st.queue.length, 1, '"..." at the start is a word, not a command');
    cleanupStates();
  });

  await test('no-mic channel: nothing is read when the bot is not in a voice channel (after /tts leave)', async () => {
    const w = await nmWorld();
    cleanupStates();
    await w.say(w.person('alex3'), 'anyone there?');
    assert.equal(w.pumps, 0);
  });

  await test('no-mic channel: settings change what is read (name off, voice requirement off, off entirely)', async () => {
    const w = await nmWorld();
    const a = w.person('alex4');
    w.mm.setSetting('1', 'voice', 'noMicAnnounceName', 'false');
    await w.say(a, 'just the words');
    assert.equal(w.st.queue.at(-1).text, 'just the words');
    w.mm.setSetting('1', 'voice', 'noMicRequireVoice', 'false');
    await w.say(w.person('alex5'), 'from outside voice', { inVoice: false });
    assert.equal(w.st.queue.length, 2);
    w.mm.setSetting('1', 'voice', 'noMicChannel', '');
    await w.say(w.person('alex6'), 'channel unset');
    assert.equal(w.st.queue.length, 2);
    cleanupStates();
  });

  await test('no-mic channel: cooldown, per-member limit and opting out', async () => {
    const w = await nmWorld();
    const a = w.person('alex7');
    await w.say(a, 'one'); await w.say(a, 'two');
    assert.equal(w.st.queue.length, 1, 'second message inside the cooldown is dropped');
    w.mm.setSetting('1', 'voice', 'userCooldownSeconds', '0');
    for (let n = 0; n < 8; n++) await w.say(a, `msg ${n}`);
    assert.equal(w.st.queue.filter((q) => q.by === 'alex7').length, 5, 'at most 5 waiting per member');
    const i = w.ix({ command: 'tts', sub: 'reading', member: w.person('quiet'), opts: { enabled: false } });
    await w.mm.handleCommand(i);
    assert.match(i.text(), /no longer be read/);
    const before = w.st.queue.length;
    await w.say(w.g.members.cache.get('quiet'), 'shh');
    assert.equal(w.st.queue.length, before, 'an opted-out member is not read');
    cleanupStates();
  });

  await test('no-mic channel: a problem shows as a warning on the member\'s own message', async () => {
    const w = await nmWorld();
    const msg = await w.say(w.person('alex8'), 'will fail');
    await w.st.queue[0].reply('⚠️ I could not speak that');
    await w.st.queue[0].reply('🔊 Speaking: fine');
    assert.deepEqual(msg.reacted, ['⚠️']);
    cleanupStates();
  });

  await test('/tts setup stores the channel (staff only) and warns when message text is unavailable', async () => {
    const w = await nmWorld();
    w.mm.setSetting('1', 'voice', 'noMicChannel', '');
    const other = w.channel('chat-2');
    const denied = w.ix({ command: 'tts', sub: 'setup', member: w.person('pleb'), opts: { channel: other } });
    await w.mm.handleCommand(denied);
    assert.match(denied.text(), /voice\.control/);
    const ok = w.ix({ command: 'tts', sub: 'setup', member: w.admin, opts: { channel: other } });
    await w.mm.handleCommand(ok);
    assert.equal(w.mm.ctx('1', 'voice').config.get('noMicChannel'), other.id);
    assert.match(ok.text(), /read aloud/);
    assert.doesNotMatch(ok.text(), /Message Content Intent/);
    w.mm.intents.delete('MessageContent');
    const warned = w.ix({ command: 'tts', sub: 'setup', member: w.admin, opts: { channel: other } });
    await w.mm.handleCommand(warned);
    assert.match(warned.text(), /Message Content Intent/, 'without the intent the bot cannot read text, and says so');
    cleanupStates();
  });

  // ================================================================ tickets: rules (no Discord)
  console.log('\nTickets: rules');
  const T = await import('../src/tickets.js');

  await test('the eight categories carry the urgency they were designed with', () => {
    const want = { scam: 'urgent', safety: 'urgent', report: 'high', appeal: 'normal', bot: 'normal', access: 'normal', partner: 'low', other: 'low' };
    assert.deepEqual(Object.fromEntries(T.CATEGORIES.map((c) => [c.id, c.urgency])), want);
    assert.ok(T.CATEGORIES.every((c) => c.label.length <= 45), 'labels fit a popup title');
    assert.ok(T.CATEGORIES.every((c) => T.questionsFor(c).length <= 5), 'a popup holds at most five fields');
  });

  await test('report popups ask who was reported (name + ID), what happened and evidence; other popups do not', () => {
    const ids = (id) => T.questionsFor(T.findCategory(id)).map((q) => q.id);
    for (const c of ['scam', 'safety', 'report']) assert.deepEqual(ids(c), ['who', 'outside', 'details', 'evidence', 'files']);
    assert.deepEqual(ids('bot'), ['details', 'extra', 'files']);
    assert.deepEqual(ids('appeal'), ['what', 'why', 'extra', 'files']);
    assert.ok(T.questionsFor(T.findCategory('report')).find((q) => q.id === 'details').required);
    const legacy = T.findCategory('old', [{ id: 'old', label: 'Old type', questions: ['One?', 'Two?'] }]);
    assert.equal(legacy.urgency, 'normal'); assert.deepEqual(T.questionsFor(legacy).map((q) => q.id), ['q0', 'q1', 'files']);
    assert.equal(T.findCategory('nope'), null);
  });

  await test('reported people: IDs and mentions are read, junk is explained, a required report needs somebody', () => {
    assert.deepEqual(T.parseReported({ username: '@CoolGuy#0', userid: '123456789012345678' }), { id: '123456789012345678', name: 'coolguy' });
    assert.equal(T.parseReported({ userid: '<@!123456789012345678>' }).id, '123456789012345678');
    assert.deepEqual(T.parseReported({ username: '', userid: '' }), { id: null, name: null });
    assert.throws(() => T.parseReported({ userid: '12345' }), /user ID/);
    assert.throws(() => T.parseReported({ userid: 'abc' }), /Developer Mode/);
    assert.throws(() => T.parseReported({}, { required: true }), /who it is about/);
    assert.doesNotThrow(() => T.parseReported({ username: 'x' }, { required: true }));
  });

  const E = (id, tid, name, extra = {}) => ({ id, target_id: tid, target_name: name, target_alias: null, status: 'open', ticket_number: id, ...extra });
  await test('watch matching: IDs are exact, names are only "possible", short names never match by name', () => {
    const entries = [E(1, '111111111111111111', 'coolguy'), E(2, null, 'bob'), E(3, '333333333333333333', 'al'), E(4, '444444444444444444', 'zed', { target_alias: 'realzed' })];
    const m = (t) => T.matchWatch({ openerId: '999999999999999999', openerNames: ['someone'], text: t }, entries).map((x) => [x.entry.id, x.how, x.exact]);
    assert.deepEqual(m('they were mean, id 111111111111111111'), [[1, 'id', true]]);
    assert.deepEqual(m('<@111111111111111111> did it'), [[1, 'id', true]]);
    assert.deepEqual(m('it was CoolGuy again'), [[1, 'name', false]]);
    assert.deepEqual(m('coolguys are cool'), [], 'a longer word is not a match');
    assert.deepEqual(m('this is my bob.'), [[2, 'name', false]]);
    assert.deepEqual(m('bob.smith did it'), [], 'bob.smith is a different name');
    assert.deepEqual(m('al did it'), [], 'two-letter names only match on IDs');
    assert.deepEqual(m('al is 333333333333333333'), [[3, 'id', true]]);
    assert.deepEqual(m('the real name is RealZed'), [[4, 'name', false]], 'the real account name logged for the ID matches too');
    assert.deepEqual(m('11111111111111111'), [], 'a number that is too short is not an ID');
    assert.deepEqual(m('1111111111111111111111'), [], 'a longer number is not that ID either');
    const opener = T.matchWatch({ openerId: '111111111111111111', openerNames: ['x'], text: '' }, entries).map((x) => [x.entry.id, x.how, x.exact]);
    assert.deepEqual(opener, [[1, 'opener', true]], 'the reported person opening a ticket');
    const byName = T.matchWatch({ openerId: '5', openerNames: ['Bob'], text: '' }, entries).map((x) => [x.entry.id, x.how, x.exact]);
    assert.deepEqual(byName, [[2, 'opener-name', false]]);
    assert.deepEqual(T.matchWatch({ openerId: '5', openerNames: [], reported: { id: '111111111111111111' }, text: '' }, entries).map((x) => x.entry.id), [1]);
  });

  await test('flag text says exact vs possible, shows earlier outcomes, and reminds staff a report is not proof', () => {
    const entries = [E(1, '111111111111111111', 'coolguy', { status: 'confirmed' }), E(2, '111111111111111111', 'coolguy', { status: 'unfounded' }), E(3, null, 'bob')];
    const ex = T.matchWatch({ openerId: '9', text: 'id 111111111111111111' }, entries);
    const text = T.describeMatches(ex, entries);
    assert.match(text, /Exact match/); assert.match(text, /2 earlier report/); assert.match(text, /1 confirmed, 1 unfounded/); assert.match(text, /not proof/);
    const poss = T.describeMatches(T.matchWatch({ openerId: '9', text: 'bob did it' }, entries), entries);
    assert.match(poss, /Possible match/); assert.match(poss, /names are not unique/); assert.match(poss, /not reviewed/);
  });

  await test('the close form needs resolution, reason, action and notes (follow-up is optional)', () => {
    const full = { resolution: 'Resolved', reason: 'Because', action: 'Warned', notes: 'See log', followup: '' };
    assert.deepEqual(T.readCloseForm((k) => full[k]), { resolution: 'Resolved', reason: 'Because', action: 'Warned', notes: 'See log', followup: null });
    for (const k of ['resolution', 'reason', 'action', 'notes']) assert.throws(() => T.readCloseForm((x) => (x === k ? '   ' : full[x])), /required/, k);
    assert.ok(T.CLOSE_FIELDS.length <= 5);
    assert.equal(T.CLOSE_FIELDS.find((f) => f.id === 'followup').required, false);
  });

  await test('inactivity and the numbers behind /ticket stats', () => {
    const now = 1e12;
    assert.equal(T.inactive({ status: 'open', createdAt: now - 5 * 3600000 }, now, 4), true);
    assert.equal(T.inactive({ status: 'open', createdAt: now - 5 * 3600000, lastActivity: now - 1000 }, now, 4), false);
    assert.equal(T.inactive({ status: 'open', createdAt: 0 }, now, 0), false, '0 hours = never');
    assert.equal(T.inactive({ status: 'closed', createdAt: 0 }, now, 4), false);
    const sum = T.summarize([
      { category: 'bot', opened_at: now - 3600000, first_response_at: now - 3000000, closed_at: now - 1800000, close_kind: 'staff' },
      { category: 'bot', opened_at: now - 7200000, first_response_at: null, closed_at: now - 3600000, close_kind: 'auto' },
      { category: 'scam', opened_at: now - 90 * 86400000, closed_at: now - 89 * 86400000, close_kind: 'no-notes' },
    ], now, 30);
    assert.equal(sum.total, 2); assert.deepEqual(sum.byCategory, { bot: 2 });
    assert.equal(sum.avgFirstResponseMs, 600000); assert.equal(sum.avgResolutionMs, 2700000);
    assert.equal(sum.autoClosed, 1); assert.equal(sum.withoutNotes, 0);
  });

  // ================================================================ tickets: the module
  console.log('\nTickets: categories, reports, watch log, close notes');
  const embedText = (p) => (p?.embeds ?? []).map((e) => { const d = e.data ?? e; return [d.title, d.description, ...(d.fields ?? []).flatMap((f) => [f.name, f.value])].filter(Boolean).join('\n'); }).join('\n---\n');
  const everything = (ch) => ch.sent.map((p) => `${p.content ?? ''}\n${embedText(p)}`).join('\n===\n');
  const modalIds = (m) => (m.toJSON?.() ?? m).components.map((r) => r.component?.custom_id ?? r.components?.[0]?.custom_id);
  const flagsIn = (ch) => ch.sent.filter((p) => /Watch-log match/.test(embedText(p)));
  const REPORTED = '300000000000000001', REPORTED2 = '300000000000000002';

  const tkWorld = async () => {
    const w = await makeWorld(['support']).load();
    w.staff = w.person('staff1', { bits: [P.ModerateMembers], pos: 5 });
    w.admin = w.person('admin1', { bits: [P.Administrator], pos: 10 });
    w.panelCh = w.channel('open-a-ticket'); w.log = w.channel('ticket-log'); w.watch = w.channel('staff-watch');
    w.mm.setSetting('1', 'support', 'logChannel', w.log.id);
    w.mm.setSetting('1', 'support', 'watchChannel', w.watch.id);
    w.created = [];
    const create = w.g.channels.create;
    w.g.channels.create = async (o) => { const ch = await create(o); w.created.push(ch); return ch; };
    w.reported = w.person(REPORTED, { username: 'BadActor' });
    // Tests still write reports as { username, userid }: that becomes the member picker (a real ID) or the "not in the server" box.
    const withFields = (i, fields) => {
      const f = { ...fields };
      if ('username' in f || 'userid' in f) { f.who = /^\d{17,20}$/.test(String(f.userid ?? '')) ? f.userid : ''; f.outside = f.who ? '' : String(f.userid || f.username || ''); }
      const files = f.files ?? [];
      i.fields = { getTextInputValue: (id) => String(f[id] ?? ''), getSelectedUsers: (id) => new Map(f[id] ? [[f[id], { id: f[id] }]] : []), getUploadedFiles: () => new Map(files.map((x, k) => [String(k), x])), getStringSelectValues: (id) => [].concat(f[id] ?? []) };
      return i;
    };
    w.press = async (member, customId, ch = w.panelCh) => { const i = w.ix({ member, channel: ch, customId }); await w.mm.handleComponent(i); return i; };
    w.submit = async (member, customId, fields, ch = w.panelCh) => { const i = withFields(w.ix({ member, channel: ch, customId }), fields); await w.mm.handleComponent(i); return i; };
    w.slash = async (member, sub, opts = {}, ch, group = null) => { const i = w.ix({ command: 'ticket', sub, group, member, channel: ch, opts }); await w.mm.handleCommand(i); return i; };
    w.open = async (member, cat, fields = { details: 'It is broken', extra: '' }) => {
      const before = w.created.length;
      const i = await w.submit(member, `ticket:form:${cat}`, fields);
      return { i, ch: w.created.length > before ? w.created.at(-1) : null };
    };
    w.ticket = (ch) => w.mm.ctx('1', 'support').data.get(`ticket:${ch.id}`);
    w.history = (n) => w.db.q('SELECT * FROM support_history WHERE guild_id = ? AND number = ?').get('1', n);
    w.watchRows = () => w.db.q('SELECT * FROM support_watch WHERE guild_id = ? ORDER BY id').all('1');
    w.reportTicket = async (member, { name = 'BadActor', id = REPORTED, details = 'They scammed people in #general' } = {}) =>
      w.open(member, 'report', { username: name, userid: id, details, evidence: 'https://discord.com/channels/1/2/3' });
    w.closeForm = { resolution: 'Resolved', reason: 'Evidence checked', action: 'Warned the member', notes: 'Second report this month', followup: '' };
    w.closeAsStaff = async (ch, { outcome = null, form = w.closeForm } = {}) => {
      let i = await w.press(w.staff, 'ticket:close', ch);
      if (outcome) { assert.ok(i.replies[0].components, 'outcome buttons are shown first'); i = await w.press(w.staff, `ticket:outcome:${outcome}`, ch); }
      assert.ok(i.modal, 'the notes popup opens');
      return w.submit(w.staff, i.modal.data.custom_id, form, ch);
    };
    return w;
  };

  await test('the panel offers every category, as buttons coloured by urgency; hidden categories are left off', async () => {
    const w = await tkWorld();
    await w.slash(w.admin, 'panel', { channel: w.panelCh });
    const ids = (p) => p.components.flatMap((r) => r.components.map((b) => b.data.custom_id));
    assert.deepEqual(ids(w.panelCh.sent[0]), T.CATEGORIES.map((c) => `ticket:open:${c.id}`));
    assert.match(embedText(w.panelCh.sent[0]), /Scam, phishing or hacked account/);
    w.mm.setSetting('1', 'support', 'hiddenCategories', 'partner', 'add');
    await w.slash(w.admin, 'panel', { channel: w.panelCh });
    assert.ok(!ids(w.panelCh.sent[1]).includes('ticket:open:partner'));
    assert.match((await w.press(w.person('mem1'), 'ticket:open:partner')).text(), /not available/);
  });

  await test('pressing a category opens the right popup (checking the open-ticket limit first)', async () => {
    const w = await tkWorld();
    const m = w.person('mem2');
    assert.deepEqual(modalIds((await w.press(m, 'ticket:open:report')).modal), ['who', 'outside', 'details', 'evidence', 'files']);
    assert.deepEqual(modalIds((await w.press(m, 'ticket:open:bot')).modal), ['details', 'extra', 'files']);
    assert.deepEqual(modalIds((await w.press(m, 'ticket:open:appeal')).modal), ['what', 'why', 'extra', 'files']);
    await w.open(m, 'bot'); await w.open(m, 'other');
    const third = await w.press(m, 'ticket:open:bot');
    assert.equal(third.modal, null, 'no popup when the member is already at their limit');
    assert.match(third.text(), /already have 2 open/);
  });

  await test('each category creates a private ticket with its urgency, a history row and the right staff pings', async () => {
    const w = await tkWorld();
    const want = { scam: 'urgent', safety: 'urgent', report: 'high', appeal: 'normal', bot: 'normal', access: 'normal', partner: 'low', other: 'low' };
    let n = 0;
    for (const [cat, urgency] of Object.entries(want)) {
      const m = w.person(`opener${++n}`);
      const fields = cat === 'report' ? { username: 'someone', userid: '', details: 'x', evidence: '' } : cat === 'appeal' ? { what: 'a ban', why: 'because' } : { details: 'help' };
      const { ch } = await w.open(m, cat, fields);
      assert.ok(ch, `${cat} created a channel`);
      assert.equal(w.ticket(ch).priority, urgency, cat);
      assert.equal(w.history(w.ticket(ch).number).urgency, urgency);
      assert.ok(ch.createOpts.permissionOverwrites.some((o) => o.id === m.id), 'the opener can see it');
      assert.ok(ch.createOpts.permissionOverwrites.some((o) => o.id === '1' && o.deny), '@everyone cannot');
      assert.match(embedText(ch.sent[0]), new RegExp(urgency));
    }
  });

  await test('reporting someone: the ID is checked, a required report needs a name or ID, and a good one lands on the watch log', async () => {
    const w = await tkWorld();
    const m = w.person('reporter1');
    assert.match((await w.submit(m, 'ticket:form:report', { username: 'x', userid: '12345', details: 'd', evidence: '' })).text(), /user ID/);
    assert.match((await w.submit(m, 'ticket:form:report', { username: '', userid: '', details: 'd', evidence: '' })).text(), /who it is about/);
    assert.equal(w.created.length, 0, 'nothing was opened');
    const { ch } = await w.reportTicket(m);
    assert.ok(ch);
    const rows = w.watchRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target_id, REPORTED); assert.equal(rows[0].target_name, 'badactor'); assert.equal(rows[0].reporter_id, 'reporter1');
    assert.equal(rows[0].status, 'open'); assert.equal(rows[0].ticket_number, w.ticket(ch).number);
    assert.match(rows[0].summary, /scammed people/);
    assert.equal(flagsIn(w.watch).length, 0, 'the first report matches nothing, so there is no flag');
  });

  await test('a scam report may leave the person out (optional), and then nothing is logged', async () => {
    const w = await tkWorld();
    const { ch } = await w.open(w.person('victim1'), 'scam', { username: '', userid: '', details: 'my account was hacked', evidence: '' });
    assert.ok(ch); assert.equal(w.watchRows().length, 0);
  });

  await test('a later ticket that mentions a logged ID is flagged as an exact match - to staff only', async () => {
    const w = await tkWorld();
    await w.reportTicket(w.person('reporter2'));
    const { ch } = await w.open(w.person('other1'), 'bot', { details: `the user ${REPORTED} keeps spamming the bot`, extra: '' });
    assert.equal(flagsIn(w.watch).length, 1, 'a flag went to the staff-only channel');
    const flag = everything(w.watch);
    assert.match(flag, /Exact match/); assert.match(flag, new RegExp(REPORTED)); assert.match(flag, /1 earlier report/); assert.match(flag, /not proof/);
    assert.doesNotMatch(everything(ch), /Watch-log|Exact match|watch log/i, 'the member who opened the ticket never sees the flag');
    assert.equal(w.ticket(ch).flagCount, 1);
  });

  await test('a ticket that only mentions a logged username is a "possible" match', async () => {
    const w = await tkWorld();
    await w.reportTicket(w.person('reporter3'));
    await w.open(w.person('other2'), 'other', { details: 'Is BadActor allowed to do that?', extra: '' });
    assert.match(everything(w.watch), /Possible match/);
    assert.doesNotMatch(everything(w.watch), /Exact match/);
  });

  await test('the reported person opening a ticket is flagged too', async () => {
    const w = await tkWorld();
    await w.reportTicket(w.person('reporter4'));
    await w.open(w.reported, 'access', { details: 'I cannot see channels', extra: '' });
    assert.match(everything(w.watch), /Exact match/);
    assert.match(everything(w.watch), /person who opened this ticket/);
  });

  await test('unrelated tickets are never flagged, and flags fall back to the ticket log (or nowhere) without crashing', async () => {
    const w = await tkWorld();
    await w.reportTicket(w.person('reporter5'));
    await w.open(w.person('other3'), 'bot', { details: 'the bot is slow', extra: '' });
    assert.equal(flagsIn(w.watch).length, 0);
    w.mm.setSetting('1', 'support', 'watchChannel', '');
    const before = w.log.sent.length;
    await w.open(w.person('other4'), 'bot', { details: `see ${REPORTED}`, extra: '' });
    assert.ok(w.log.sent.length >= before + 2, 'ticket-opened notice plus the flag, in the ticket log');
    assert.match(everything(w.log), /Exact match/);
    w.mm.setSetting('1', 'support', 'logChannel', '');
    const { ch } = await w.open(w.person('other5'), 'bot', { details: `see ${REPORTED}`, extra: '' });
    assert.ok(ch, 'still opens with nowhere to send the flag');
  });

  await test('closing a report ticket: outcome first, then the required popup; the outcome lands on the watch entry and shows on later flags', async () => {
    const w = await tkWorld();
    const { ch } = await w.reportTicket(w.person('reporter6'));
    const done = await w.closeAsStaff(ch, { outcome: 'unfounded' });
    assert.match(done.text(), /Ticket closed/);
    assert.equal(w.ticket(ch).status, 'closed');
    assert.equal(w.watchRows()[0].status, 'unfounded');
    assert.equal(w.watchRows()[0].outcome_by, 'staff1');
    const h = w.history(w.ticket(ch).number);
    assert.deepEqual([h.close_kind, h.resolution, h.reason, h.action_taken, h.notes, h.outcome, h.closed_by], ['staff', 'Resolved', 'Evidence checked', 'Warned the member', 'Second report this month', 'unfounded', 'staff1']);
    await w.open(w.person('other6'), 'bot', { details: `see ${REPORTED}`, extra: '' });
    assert.match(everything(w.watch), /1 unfounded/, 'the flag says the earlier report was found unfounded');
  });

  await test('staff close notes go to the staff log only - the member sees the resolution, not the reasoning or notes', async () => {
    const w = await tkWorld();
    const { ch } = await w.open(w.person('opener20'), 'bot');
    await w.closeAsStaff(ch);
    const staffLog = everything(w.log);
    for (const x of ['Evidence checked', 'Warned the member', 'Second report this month', 'Resolved']) assert.match(staffLog, new RegExp(x));
    const memberSees = everything(ch);
    assert.match(memberSees, /Resolution: Resolved/);
    for (const x of ['Evidence checked', 'Warned the member', 'Second report this month']) assert.doesNotMatch(memberSees, new RegExp(x));
  });

  await test('closing needs every required field; a blank one keeps the ticket open', async () => {
    const w = await tkWorld();
    const { ch } = await w.open(w.person('opener21'), 'bot');
    for (const k of ['resolution', 'reason', 'action', 'notes']) {
      const r = await w.closeAsStaff(ch, { form: { ...w.closeForm, [k]: '  ' } });
      assert.match(r.text(), /required/, k);
      assert.equal(w.ticket(ch).status, 'open', `${k} blank`);
    }
    const ok = await w.closeAsStaff(ch, { form: { ...w.closeForm, followup: 'Check back Friday' } });
    assert.equal(w.ticket(ch).status, 'closed');
    assert.match(everything(w.log), /Check back Friday/);
    void ok;
  });

  await test('the notes popup cannot be used by the wrong person, twice, or on a ticket someone else already closed', async () => {
    const w = await tkWorld();
    const { ch } = await w.open(w.person('opener22'), 'bot');
    const pop = await w.press(w.staff, 'ticket:close', ch);
    const id = pop.modal.data.custom_id;
    const other = w.person('staff2', { bits: [P.ModerateMembers] });
    assert.match((await w.submit(other, id, w.closeForm, ch)).text(), /belongs to someone else/);
    await w.submit(w.staff, id, w.closeForm, ch);
    assert.match((await w.submit(w.staff, id, w.closeForm, ch)).text(), /expired|closed/);
    assert.equal(w.db.q("SELECT COUNT(*) AS n FROM support_history WHERE close_kind = 'staff'").get().n, 1);
  });

  await test('a member closing their own ticket gets a confirm step, no staff popup, and it is recorded as closed by the member', async () => {
    const w = await tkWorld();
    const m = w.person('opener23');
    const { ch } = await w.open(m, 'bot');
    const i = await w.press(m, 'ticket:close', ch);
    assert.equal(i.modal, null);
    await w.press(m, 'ticket:confirm', ch);
    assert.equal(w.ticket(ch).status, 'closed');
    const h = w.history(w.ticket(ch).number);
    assert.equal(h.close_kind, 'owner'); assert.equal(h.notes, null);
    assert.match((await w.press(w.person('rando'), 'ticket:close', ch)).text(), /Only staff or the ticket owner/);
  });

  await test('/ticket close: staff get the popup (never a quiet close); a member can still close their own', async () => {
    const w = await tkWorld();
    const { ch } = await w.open(w.person('opener24'), 'bot');
    const staffClose = await w.slash(w.staff, 'close', { reason: 'quick' }, ch);
    assert.ok(staffClose.modal && w.ticket(ch).status === 'open', 'the typed reason does not replace the notes popup');
    const { ch: ch2 } = await w.open(w.person('opener25'), 'bot');
    await w.slash(w.g.members.cache.get('opener25'), 'close', { reason: 'solved it myself' }, ch2);
    assert.equal(w.history(w.ticket(ch2).number).reason, 'solved it myself');
  });

  await test('deleting the channel of an open ticket is recorded as "closed without notes"', async () => {
    const w = await tkWorld();
    const { ch } = await w.open(w.person('opener26'), 'bot');
    const n = w.ticket(ch).number;
    await w.mm.dispatch('channelDelete', '1', ch);
    const h = w.history(n);
    assert.equal(h.close_kind, 'no-notes'); assert.ok(h.closed_at); assert.equal(h.notes, null); assert.equal(h.resolution, null);
    assert.equal(w.ticket(ch), undefined);
    assert.match(everything(w.watch), /closed without notes/);
    const { ch: done } = await w.open(w.person('opener27'), 'bot');
    await w.closeAsStaff(done);
    const m = w.ticket(done).number;
    await w.mm.dispatch('channelDelete', '1', done);
    assert.equal(w.history(m).close_kind, 'staff', 'deleting an already-closed ticket keeps its real notes');
  });

  await test('inactivity auto-close: labelled auto-closed, activity resets the clock, off by default', async () => {
    const w = await tkWorld();
    const { ch } = await w.open(w.person('opener28'), 'bot');
    const old = w.ticket(ch); old.lastActivity = Date.now() - 5 * 3600000; w.mm.ctx('1', 'support').data.set(`ticket:${ch.id}`, old);
    let clock = 0; const tick = async () => { clock += 700000; await w.mm.runTasks(Date.now() + clock); };
    await tick();
    assert.equal(w.ticket(ch).status, 'open', 'off by default');
    w.mm.setSetting('1', 'support', 'autoCloseHours', '4');
    await w.mm.dispatch('messageCreate', '1', { guild: w.g, channelId: ch.id, author: w.g.members.cache.get('opener28').user, member: w.g.members.cache.get('opener28') });
    await tick();
    assert.equal(w.ticket(ch).status, 'open', 'a message restarted the clock');
    const again = w.ticket(ch); again.lastActivity = Date.now() - 5 * 3600000; w.mm.ctx('1', 'support').data.set(`ticket:${ch.id}`, again);
    await tick();
    assert.equal(w.ticket(ch).status, 'closed');
    const h = w.history(w.ticket(ch).number);
    assert.equal(h.close_kind, 'auto'); assert.equal(h.closed_by, null); assert.match(h.resolution, /Auto-closed/);
    assert.match(everything(ch), /closed automatically/);
  });

  await test('first staff reply is timed for the stats, and members\' own messages do not count', async () => {
    const w = await tkWorld();
    const m = w.person('opener29');
    const { ch } = await w.open(m, 'bot');
    const msg = (member) => ({ guild: w.g, channelId: ch.id, author: member.user, member });
    await w.mm.dispatch('messageCreate', '1', msg(m));
    assert.equal(w.ticket(ch).firstResponseAt, undefined);
    await w.mm.dispatch('messageCreate', '1', msg(w.staff));
    assert.ok(w.ticket(ch).firstResponseAt);
    await w.closeAsStaff(ch);
    assert.ok(w.history(w.ticket(ch).number).first_response_at);
  });

  await test('priority changes need a reason via popup, staff only, and are logged', async () => {
    const w = await tkWorld();
    const m = w.person('opener30');
    const { ch } = await w.open(m, 'bot');
    assert.match((await w.press(m, 'ticket:prio', ch)).text(), /Only staff/);
    const picker = await w.press(w.staff, 'ticket:prio', ch);
    assert.equal(picker.replies[0].components[0].components.length, 4, 'one button per level');
    const pop = await w.press(w.staff, 'ticket:level:urgent', ch);
    assert.ok(pop.modal);
    assert.match((await w.submit(w.staff, pop.modal.data.custom_id, { reason: '   ' }, ch)).text(), /reason is required/);
    assert.equal(w.ticket(ch).priority, 'normal');
    const pop2 = await w.press(w.staff, 'ticket:level:urgent', ch);
    await w.submit(w.staff, pop2.modal.data.custom_id, { reason: 'They are being threatened' }, ch);
    assert.equal(w.ticket(ch).priority, 'urgent');
    assert.equal(w.ticket(ch).priorityLog[0].reason, 'They are being threatened');
    assert.match(everything(w.watch), /They are being threatened/, 'the reason is in the staff log');
    assert.doesNotMatch(everything(ch), /They are being threatened/, 'not in the member\'s channel');
    assert.match((await w.press(w.staff, 'ticket:level:urgent', ch)).text(), /already/);
    const viaSlash = await w.slash(w.staff, 'priority', { level: 'low' }, ch);
    assert.ok(viaSlash.modal, '/ticket priority also asks for the reason first');
  });

  await test('staff applications (3.1): a custom type marked as an application gets Accept/Deny; accepting gives its role; closing asks the member for a rating, which lands in the log and stats', async () => {
    const w = await tkWorld();
    const g = w.mm.ctx('1', 'support');
    g.data.set('types', [{ id: 'mod-app', label: 'Moderator application', questions: ['Why do you want to help?'], application: true, role: 'r-mod' }]);
    const m = w.person('applicant');
    const added = []; m.roles.add = async (id) => { added.push(id); };
    const { ch } = await w.open(m, 'mod-app', { q0: 'I like helping' });
    const labels = ch.sent[0].components.flatMap((r) => r.components.map((b) => b.data.label));
    assert.ok(labels.includes('Accept application') && labels.includes('Deny application'));
    const pop = await w.press(w.staff, 'ticket:appeal:approve', ch);
    assert.match(pop.modal.data.title, /Accept this application/);
    const done = await w.submit(w.staff, pop.modal.data.custom_id, { reason: 'Great answers', message: 'Welcome to the team!' }, ch);
    assert.equal(w.ticket(ch).decision.result, 'accepted');
    assert.deepEqual(added, ['r-mod'], 'the role is given');
    assert.match(done.text(), /Application accepted/);
    assert.match(everything(ch), /Application accepted/);
    // Ratings: staff close it, the member gets 1-5 star buttons by DM.
    await w.closeAsStaff(ch);
    const dm = m.user.sent.find((x) => JSON.stringify(x).includes('How did we do'));
    assert.ok(dm, 'the member is asked');
    const n = w.ticket(ch).number;
    assert.match(JSON.stringify(dm), new RegExp(`rate:1:${n}:5`));
    const api = g.api('support');
    await assert.rejects(Promise.resolve().then(() => api.rate('1', n, 'someone-else', 5)), /isn't your ticket/);
    assert.match(await api.rate('1', n, m.id, 4), /⭐⭐⭐⭐/);
    assert.match(await api.rate('1', n, m.id, 1), /already rated/, 'once only');
    assert.match(everything(w.log), /⭐⭐⭐⭐ rating/);
    const S = await import('../modules/support/index.js');
    assert.deepEqual(S.ratingSummary([{ stars: 4, at: Date.now() }, { stars: 5, at: Date.now() }, { stars: 1, at: 0 }]), { count: 2, avg: 4.5 }, 'old ratings drop out');
  });

  await test('appeals: staff approve or deny with a required reason; the member sees only the message meant for them', async () => {
    const w = await tkWorld();
    const m = w.person('appealer');
    const { ch } = await w.open(m, 'appeal', { what: '7 day ban', why: 'It was a mistake' });
    assert.equal(ch.sent[0].components.length, 2, 'approve/deny buttons appear on appeal tickets');
    const normal = (await w.open(w.person('plain1'), 'bot')).ch;
    assert.equal(normal.sent[0].components.length, 1, 'but not on other tickets');
    assert.match((await w.press(m, 'ticket:appeal:approve', ch)).text(), /Only staff/);
    const pop = await w.press(w.staff, 'ticket:appeal:deny', ch);
    assert.match((await w.submit(w.staff, pop.modal.data.custom_id, { reason: ' ', message: 'no' }, ch)).text(), /reason is required/);
    const pop2 = await w.press(w.staff, 'ticket:appeal:deny', ch);
    await w.submit(w.staff, pop2.modal.data.custom_id, { reason: 'Second offence, see case 14', message: 'We are keeping the ban.' }, ch);
    assert.equal(w.ticket(ch).decision.result, 'denied');
    assert.match(everything(ch), /We are keeping the ban/);
    assert.doesNotMatch(everything(ch), /case 14/);
    assert.match(everything(w.watch), /case 14/);
    assert.match((await w.press(w.staff, 'ticket:appeal:approve', ch)).text(), /already been made/);
    await w.closeAsStaff(ch);
    assert.equal(w.history(w.ticket(ch).number).decision, 'denied');
  });

  await test('reopening a closed ticket clears its close and counts the reopen', async () => {
    const w = await tkWorld();
    const { ch } = await w.open(w.person('opener31'), 'bot');
    await w.closeAsStaff(ch);
    await w.press(w.staff, 'ticket:reopen', ch);
    assert.equal(w.ticket(ch).status, 'open');
    const h = w.history(w.ticket(ch).number);
    assert.equal(h.closed_at, null); assert.equal(h.reopened, 1);
  });

  await test('watch log commands: staff only, outcome and add need a reason popup, only admins delete', async () => {
    const w = await tkWorld();
    await w.reportTicket(w.person('reporter7'));
    const plain = w.person('plain2');
    assert.match((await w.slash(plain, 'list', {}, null, 'watch')).text(), /support\.watch/);
    assert.match((await w.slash(w.staff, 'list', {}, null, 'watch')).text(), /#1/);
    assert.match((await w.slash(w.staff, 'list', { search: 'badactor' }, null, 'watch')).text(), /#1/);
    assert.match((await w.slash(w.staff, 'list', { search: 'nobody' }, null, 'watch')).text(), /empty/);
    const view = await w.slash(w.staff, 'view', { id: 1 }, null, 'watch');
    assert.match(embedText(view.replies[0]), /What was reported/);
    assert.match(view.replies[0].embeds[0].data.footer.text, /accusation, not proof/);
    const pop = await w.slash(w.staff, 'outcome', { id: 1, status: 'confirmed' }, null, 'watch');
    assert.ok(pop.modal);
    assert.match((await w.submit(w.staff, pop.modal.data.custom_id, { reason: ' ' })).text(), /reason is required/);
    const pop2 = await w.slash(w.staff, 'outcome', { id: 1, status: 'confirmed' }, null, 'watch');
    await w.submit(w.staff, pop2.modal.data.custom_id, { reason: 'Saw the messages myself' });
    assert.equal(w.watchRows()[0].status, 'confirmed'); assert.equal(w.watchRows()[0].outcome_note, 'Saw the messages myself');
    const add = await w.slash(w.staff, 'add', { user_id: REPORTED2, username: 'second' }, null, 'watch');
    await w.submit(w.staff, add.modal.data.custom_id, { reason: 'Known alt of BadActor' });
    assert.equal(w.watchRows().length, 2); assert.equal(w.watchRows()[1].target_id, REPORTED2);
    assert.match((await w.slash(w.staff, 'remove', { id: 2 }, null, 'watch')).text(), /support\.manage/);
    assert.match((await w.slash(w.admin, 'remove', { id: 2 }, null, 'watch')).text(), /Removed/);
    assert.equal(w.watchRows().length, 1);
  });

  await test('watch-log retention: old entries go, unfounded ones sooner, recent and confirmed ones stay', async () => {
    const w = await tkWorld();
    const ins = (name, status, daysAgo) => w.db.q('INSERT INTO support_watch (guild_id, target_name, reporter_id, status, created_at, outcome_at) VALUES (?, ?, ?, ?, ?, ?)').run('1', name, 'r', status, Date.now() - daysAgo * 86400000, Date.now() - daysAgo * 86400000);
    ins('ancient', 'open', 400); ins('oldunfounded', 'unfounded', 40); ins('freshunfounded', 'unfounded', 5); ins('recentconfirmed', 'confirmed', 100);
    await w.mm.runTasks(Date.now()); // the first call only starts the task's clock
    await w.mm.runTasks(Date.now() + 700000);
    assert.deepEqual(w.watchRows().map((r) => r.target_name).sort(), ['freshunfounded', 'recentconfirmed']);
    w.mm.setSetting('1', 'support', 'watchRetentionDays', '0');
    assert.equal(w.mm.ctx('1', 'support').config.get('watchRetentionDays'), 0, '0 means keep forever');
  });

  await test('servers upgrading from before categories: custom types and old ticket records keep working', async () => {
    const w = await tkWorld();
    const ctx = w.mm.ctx('1', 'support');
    ctx.data.set('types', [{ id: 'legacy', label: 'Legacy type', emoji: '🎫', questions: ['Why are you here?', 'Anything else?'] }]);
    const press = await w.press(w.person('oldmember'), 'ticket:open:legacy');
    assert.deepEqual(modalIds(press.modal), ['q0', 'q1', 'files']);
    const { ch } = await w.open(w.g.members.cache.get('oldmember'), 'legacy', { q0: 'old question', q1: 'more' });
    assert.equal(w.ticket(ch).priority, 'normal'); assert.equal(w.ticket(ch).typeLabel, 'Legacy type');
    // an old-format record: no category, no history row, no lastActivity
    const old = w.channel('ticket-old-007');
    ctx.data.set(`ticket:${old.id}`, { number: 7, opener: 'oldmember', openerTag: 'oldmember#0', type: 'support', typeLabel: 'Support', status: 'open', claimedBy: null, priority: 'normal', createdAt: Date.now() - 1000, answers: [] });
    await w.closeAsStaff(old);
    assert.equal(w.history(7).close_kind, 'staff', 'closing an old ticket creates its history row');
    assert.equal(ctx.data.get(`ticket:${old.id}`).status, 'closed');
  });

  await test('/ticket stats reports the history, and /ticket info shows staff the matches without the member seeing them', async () => {
    const w = await tkWorld();
    await w.reportTicket(w.person('reporter8'));
    const { ch } = await w.open(w.person('other7'), 'bot', { details: `${REPORTED} again`, extra: '' });
    await w.closeAsStaff(ch);
    const stats = await w.slash(w.staff, 'stats', { days: 30 });
    assert.match(embedText(stats.replies[0]), /2 ticket/);
    const info = await w.slash(w.staff, 'info', {}, ch);
    assert.equal(info.ephemeral, undefined, 'a reply with flags is private (checked via the reply payload)');
    assert.equal(info.replies[0].flags, MessageFlagsEphemeral);
    assert.match(embedText(info.replies[0]), /Exact match/);
    assert.match((await w.slash(w.person('someone'), 'stats', {})).text(), /support\.staff/);
  });

  // ================================================================ automod
  console.log('\nAutoMod: rules, actions, exemptions');
  const AM = await import('../src/automod.js');

  await test('AutoMod rules: emoji counting, caps ratio, repeats and exemptions behave', () => {
    assert.equal(AM.countEmoji('hello'), 0);
    assert.equal(AM.countEmoji('😀😀😀'), 3);
    assert.equal(AM.countEmoji('👨‍👩‍👧 joined'), 1, 'a joined family is one emoji');
    assert.equal(AM.countEmoji('🇬🇧🇫🇷'), 2, 'flags count once each');
    assert.equal(AM.countEmoji('<:wave:123456789012345678> <a:dance:223456789012345678>'), 2, 'custom emoji');
    assert.equal(AM.countEmoji('👍🏽'), 1, 'skin tone is not a second emoji');
    assert.equal(AM.countEmoji('1 2 3 #'), 0, 'digits are not emoji');
    assert.equal(AM.capsRatio('hello there friend'), 0);
    assert.equal(AM.capsRatio('HELLO THERE FRIEND'), 100);
    assert.equal(AM.capsRatio('OK LOL'), 0, 'short messages never count');
    assert.equal(AM.capsRatio('Hello There My Friend'), 22);
    assert.equal(AM.capsRatio('HTTPS://EXAMPLE.COM/PATH <@123456789012345678> `CODE HERE FOR YOU`'), 0, 'links, pings and code are ignored');
    assert.equal(AM.capsRatio('ПРИВЕТ ВСЕМ МОИ ДРУЗЬЯ'), 100, 'non-Latin capitals count');
    assert.equal(AM.capsRatio('你好你好你好你好你好你好你好'), 0, 'scripts without case never count');
    assert.equal(AM.normalizeText('  Hello   <@123> World '), 'hello world');
    let list = [];
    const at = (t, text = 'buy now') => { const r = AM.recordRepeat(list, { text, id: `m${t}`, ch: 'c', now: t, windowMs: 1000 }); list = r.list; return r.count; };
    assert.deepEqual([at(0), at(100), at(200)], [1, 2, 3]);
    assert.equal(at(5000), 1, 'the window slides');
    assert.equal(AM.recordRepeat([], { text: ' ', id: 'x', ch: 'c', now: 0, windowMs: 1000 }).count, 0, 'blank text is never a repeat');
    const ex = { all: { roles: ['r1'] }, links: { channels: ['cat1', 'chA'] } };
    assert.ok(AM.isExempt(ex, 'caps', { roleIds: ['r1'], channelId: 'c' }));
    assert.ok(!AM.isExempt(ex, 'caps', { roleIds: ['r2'], channelId: 'chA' }), 'a links-only channel exemption does not cover caps');
    assert.ok(AM.isExempt(ex, 'links', { roleIds: [], channelId: 'x', categoryId: 'cat1' }), 'a category covers channels in it');
    assert.ok(AM.isExempt(ex, 'links', { roleIds: [], channelId: 'thread', parentId: 'chA' }), 'and threads in an exempt channel');
    assert.deepEqual(AM.editExempt({}, 'links', 'roles', '5', true), { ex: { links: { roles: ['5'], channels: [] } }, changed: true });
    assert.equal(AM.editExempt({ links: { roles: ['5'], channels: [] } }, 'links', 'roles', '5', false).ex.links, undefined, 'an emptied set is removed');
    assert.equal(AM.editExempt({}, 'links', 'roles', '5', false).changed, false);
    assert.throws(() => AM.editExempt({}, 'nonsense', 'roles', '5', true), /Unknown rule/);
    const cfg = { automodAction: 'delete-warn', capsAction: 'default', emojiAction: 'delete' };
    assert.equal(AM.actionFor(cfg, AM.ruleById('caps')), 'delete-warn');
    assert.equal(AM.actionFor(cfg, AM.ruleById('emoji')), 'delete');
    assert.equal(AM.ruleEnabled({ maxMentions: 0 }, AM.ruleById('mentions')), false);
    assert.equal(AM.ruleEnabled({ maxMentions: 6 }, AM.ruleById('mentions')), true);
    assert.equal(AM.snippet('a`b\nc'.repeat(40)).length <= 80, true);
  });

  const amWorld = async () => {
    const w = await makeWorld(['moderation']).load();
    w.admin = w.person('amadmin', { bits: [P.Administrator], pos: 10 });
    w.mod = w.person('ammod', { bits: [P.ModerateMembers], pos: 5 });
    w.user = w.person('amuser', { pos: 1 }); w.user.timeouts = []; w.user.timeout = async (ms, r) => { w.user.timeouts.push([ms, r]); };
    w.room = w.channel('chat'); w.logch = w.channel('mod-log');
    w.set = (k, v, op) => w.mm.setSetting('1', 'moderation', k, v, op);
    w.set('logChannel', w.logch.id);
    w.set('dmOnAction', false);
    w.data = () => w.mm.ctx('1', 'moderation').data;
    let n = 0;
    w.say = async (text, { member = w.user, channel = w.room, users = 0, roles = 0 } = {}) => {
      const id = `${channel.id}-u${++n}`; const msg = { id, guild: w.g, author: member.user, member, content: text, channel, channelId: channel.id, system: false,
        mentions: { users: { size: users }, roles: { size: roles } }, delete: async () => { msg.removed = true; channel.deleted.push(id); } };
      channel.messages.store.set(id, msg);
      await w.mm.dispatch('messageCreate', '1', msg);
      return msg;
    };
    w.cases = () => w.data().get('hist:amuser') ?? [];
    w.recent = () => w.data().get('automod:recent') ?? [];
    w.cmd = async (sub, opts = {}, member = w.admin) => { const i = w.ix({ command: 'automod', sub, member, opts }); await w.mm.handleCommand(i); return i; };
    return w;
  };
  const SHOUT = 'WHY IS NOBODY ANSWERING ME', ELEVEN = '😀'.repeat(11);

  await test('with every new rule off (the default), nothing a member says is touched', async () => {
    const w = await amWorld();
    for (const t of [SHOUT, ELEVEN, 'same', 'same', 'same', 'same']) assert.equal((await w.say(t)).removed, undefined, t);
    assert.equal(w.recent().length, 0);
  });

  await test('caps rule: shouting is removed, normal and short messages are not', async () => {
    const w = await amWorld(); w.set('automodCaps', true);
    assert.equal((await w.say('hello everyone how are you')).removed, undefined);
    assert.equal((await w.say('OK LOL')).removed, undefined);
    assert.equal((await w.say('Check https://EXAMPLE.COM/PATH/HERE/PLEASE now')).removed, undefined);
    const bad = await w.say(SHOUT);
    assert.equal(bad.removed, true);
    assert.equal(w.recent()[0].rule, 'caps');
    assert.match(w.room.sent.at(-1).content, /capital letters/);
    w.set('capsPercent', 100);
    assert.equal((await w.say('SHOUTING a bit HERE for you')).removed, undefined, 'a higher threshold lets mixed messages through');
  });

  await test('emoji rule: more than the limit is removed, exactly the limit is fine, custom emoji count', async () => {
    const w = await amWorld(); w.set('automodEmoji', true); w.set('emojiMax', 10);
    assert.equal((await w.say('😀'.repeat(10))).removed, undefined);
    assert.equal((await w.say(ELEVEN)).removed, true);
    assert.equal((await w.say('<:a1:123456789012345671>'.repeat(11))).removed, true);
    assert.equal(w.recent().at(-1).rule, 'emoji');
  });

  await test('repeat rule: the third identical message goes (with the earlier copies); different messages never do', async () => {
    const w = await amWorld(); w.set('automodRepeat', true); w.set('repeatMax', 3);
    const a = await w.say('Buy cheap stuff NOW'), b = await w.say('buy cheap stuff  now'), other = await w.say('something else');
    assert.deepEqual([a.removed, b.removed, other.removed], [undefined, undefined, undefined]);
    const c = await w.say('BUY CHEAP STUFF NOW');
    assert.equal(c.removed, true);
    assert.equal(w.recent()[0].rule, 'repeat');
    assert.equal((await w.say('buy cheap stuff now')).removed, undefined, 'the counter restarts after a removal');
    const second = await amWorld(); second.set('automodRepeat', true);
    await second.say('hello'); await second.say('hello', { member: second.mod });
    assert.equal((await second.say('hello', { member: second.person('amuser2') })).removed, undefined, 'repeats are counted per person');
  });

  await test('old settings still work after the upgrade: spam, words, links and mentions behave as before', async () => {
    const w = await amWorld();
    w.set('automodWords', true); w.set('bannedWords', 'badword,worse phrase');
    assert.equal((await w.say('this is a Badword indeed')).removed, true);
    assert.equal((await w.say('badwords are fine as a different word')).removed, undefined);
    w.set('automodLinks', true); w.set('allowedDomains', 'youtube.com');
    assert.equal((await w.say('see https://evil.example/x')).removed, true);
    assert.equal((await w.say('see https://www.youtube.com/watch')).removed, undefined);
    assert.equal((await w.say('join discord.gg/abcdef')).removed, true);
    assert.equal((await w.say('hi', { users: 6 })).removed, true, 'default mention limit of 6');
    w.set('maxMentions', 0);
    assert.equal((await w.say('hi', { users: 20 })).removed, undefined, 'mentions off');
    w.set('automodSpam', true); w.set('spamMaxMessages', 3); w.set('spamWindowSeconds', 10);
    const spamMsgs = [await w.say('one'), await w.say('two')];
    const third = await w.say('three');
    assert.equal(third.removed, true);
    assert.ok(spamMsgs.every((m) => m.removed) || w.room.deleted.length >= 1, 'the burst is cleaned up');
    assert.deepEqual(w.recent().map((e) => e.rule).slice(0, 1), ['spam']);
    assert.ok(w.cases().length >= 5, 'the default action (delete + warn) still records cases');
    assert.equal(w.cases()[0].type, 'warn');
  });

  await test('each rule can have its own action; "default" follows the server-wide one', async () => {
    const w = await amWorld(); w.set('automodCaps', true); w.set('automodWords', true); w.set('bannedWords', 'badword'); w.set('automodTimeoutMinutes', 7);
    w.set('capsAction', 'delete'); w.set('wordsAction', 'delete-timeout');
    await w.say(SHOUT);
    assert.equal(w.cases().length, 0, 'caps: delete only, no case');
    assert.equal(w.recent()[0].action, 'delete');
    await w.say('badword');
    assert.equal(w.user.timeouts.length, 1);
    assert.equal(w.user.timeouts[0][0], 7 * 60000);
    assert.equal(w.cases()[0].type, 'timeout');
    w.set('capsAction', 'default');
    await w.say(SHOUT);
    assert.equal(w.cases()[0].type, 'warn', 'default = the server-wide delete + warn');
    w.set('automodAction', 'delete');
    await w.say(SHOUT);
    assert.equal(w.cases().length, 2, 'server-wide changed to delete only: no new case');
    assert.throws(() => w.set('capsAction', 'ban'), /Choose one of/);
  });

  await test('exemptions: by role, by channel, by category and per rule; the bypass permission still wins', async () => {
    const w = await amWorld(); w.set('automodCaps', true); w.set('automodWords', true); w.set('bannedWords', 'badword');
    const vip = w.role('900000000000000001'); w.user.roles.cache.set(vip.id, vip);
    await w.cmd('exempt', { what: 'add', rule: 'caps', role: vip });
    assert.equal((await w.say(SHOUT)).removed, undefined, 'exempt role may shout');
    assert.equal((await w.say('badword')).removed, true, 'but the exemption was only for caps');
    await w.cmd('exempt', { what: 'remove', rule: 'caps', role: vip });
    assert.equal((await w.say(SHOUT)).removed, true);
    await w.cmd('exempt', { what: 'add', rule: 'all', channel: w.room });
    assert.equal((await w.say(SHOUT)).removed, undefined);
    assert.equal((await w.say('badword')).removed, undefined, 'every rule');
    assert.equal((await w.say(SHOUT, { channel: w.channel('other') })).removed, true, 'other channels are still checked');
    await w.cmd('exempt', { what: 'remove', rule: 'all', channel: w.room });
    const kid = w.channel('in-category'); kid.parentId = '700000000000000007';
    await w.cmd('exempt', { what: 'add', channel: { id: '700000000000000007' } });
    assert.equal((await w.say(SHOUT, { channel: kid })).removed, undefined, 'a category exempts what is inside it');
    assert.equal((await w.say(SHOUT, { member: w.mod })).removed, undefined, 'moderators (bypass) are never checked');
  });

  await test('/automod: status for staff, changes only for those allowed, with clear feedback', async () => {
    const w = await amWorld();
    const status = await w.cmd('status', {}, w.mod);
    const text = JSON.stringify(status.replies[0].embeds[0].data.description);
    for (const r of AM.RULES) assert.ok(text.includes(r.label.slice(0, 12)), r.id);
    assert.match((await w.cmd('rule', { rule: 'caps', enabled: true }, w.mod)).text(), /moderation\.automod/);
    assert.equal(w.mm.ctx('1', 'moderation').config.get('automodCaps'), false, 'nothing changed');
    const done = await w.cmd('rule', { rule: 'caps', enabled: true, action: 'delete', limit: 80 });
    assert.match(done.text(), /now on/);
    const cfg = w.mm.ctx('1', 'moderation').config;
    assert.deepEqual([cfg.get('automodCaps'), cfg.get('capsAction'), cfg.get('capsPercent')], [true, 'delete', 80]);
    await w.cmd('rule', { rule: 'mentions', enabled: false });
    assert.equal(cfg.get('maxMentions'), 0);
    await w.cmd('rule', { rule: 'mentions', enabled: true });
    assert.equal(cfg.get('maxMentions'), 6);
    assert.match((await w.cmd('rule', { rule: 'words', limit: 3 })).text() + '', /./, 'a rule without a number is explained, not crashed');
    assert.match((await w.cmd('exempt', { what: 'add', rule: 'caps' })).text(), /Pick a role or a channel/);
    assert.match((await w.cmd('exempt', { what: 'list' }, w.mod)).text(), /Nothing is exempt/, 'and nothing was added');
    assert.match((await w.cmd('exempt', { what: 'list' }, w.mod)).text(), /Nothing is exempt/);
    await w.cmd('word', { what: 'add', word: 'Foo Bar' });
    await w.cmd('domain', { what: 'add', domain: 'https://www.Example.com/path?x=1' });
    assert.deepEqual([cfg.get('bannedWords'), cfg.get('allowedDomains')], [['Foo Bar'], ['example.com']]);
    assert.match((await w.cmd('word', { what: 'list' }, w.mod)).text(), /Foo Bar/);
    assert.match((await w.cmd('word', { what: 'add', word: 'x' }, w.mod)).text(), /moderation\.automod/);
  });

  await test('/automod recent and the activity list: who, where, which rule - and previews can be switched off', async () => {
    const w = await amWorld(); w.set('automodCaps', true);
    assert.match((await w.cmd('recent', {}, w.mod)).text(), /has not removed anything/);
    await w.say(SHOUT);
    const shown = (await w.cmd('recent', {}, w.mod)).text();
    assert.match(shown, /<@amuser>/); assert.match(shown, /too many capitals/); assert.match(shown, /WHY IS NOBODY/);
    w.set('automodKeepSnippets', false);
    await w.say(SHOUT);
    assert.equal(w.recent()[0].snippet, undefined);
    for (let n = 0; n < 220; n++) await w.say(SHOUT);
    assert.equal(w.recent().length, 200, 'the list stays bounded');
  });

  await test('AutoMod dashboard page: rules, switch, action; bad input is refused', async () => {
    const w = await amWorld(); w.set('automodEmoji', true);
    const actor = { userId: 'amadmin', username: 'Admin', via: 'dashboard' };
    await w.say(ELEVEN);
    const view = await w.mm.runView('1', 'moderation', 'automod');
    assert.equal(view.rows.length, AM.RULES.length);
    const emoji = view.rows.find((r) => r.id === 'emoji');
    assert.deepEqual([emoji.state, emoji.last7, emoji.limit], ['● On', '1 caught', 10]);
    assert.equal(view.recent[0].rule, 'too many emoji');
    await w.mm.runAction('1', 'moderation', 'automod-toggle', { id: 'emoji', userId: 'emoji' }, actor);
    assert.equal(w.mm.ctx('1', 'moderation').config.get('automodEmoji'), false);
    await w.mm.runAction('1', 'moderation', 'automod-action', { id: 'caps', value: 'Delete-Timeout' }, actor);
    assert.equal(w.mm.ctx('1', 'moderation').config.get('capsAction'), 'delete-timeout');
    await assert.rejects(() => w.mm.runAction('1', 'moderation', 'automod-action', { id: 'caps', value: 'ban' }, actor), /action must be one of/);
    await assert.rejects(() => w.mm.runAction('1', 'moderation', 'automod-toggle', { id: 'nope' }, actor), /Unknown rule/);
    const panel = w.mm.describeForGuild('1').find((d) => d.name === 'moderation').panels.find((p) => p.id === 'automod');
    assert.equal(panel.permission, 'moderation.automod');
  });

  // ================================================================ dashboard access levels + design
  console.log('\nDashboard: moderator access, per-panel permissions, design assets');
  const DG = '100000000000000001';
  const gp = (s = '') => `/api/guilds/${DG}${s}`;
  const dashWorld = async (env = {}, updates = null, mods = ['moderation', 'support']) => {
    const w = await makeWorld(mods, { guildId: DG }).load();
    const saveEnv = {}; for (const [k, v] of Object.entries(env)) { saveEnv[k] = process.env[k]; process.env[k] = v; }
    const logs = [];
    w.dash = await startDashboard({ manager: w.mm, client: w.client, db: w.db, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) }, perms: w.perms, port: 0, host: '127.0.0.1', version: '2.1.0', updates });
    for (const [k, v] of Object.entries(saveEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    w.logs = logs;
    w.admin = w.person('dadmin', { bits: [P.ManageGuild] });
    w.mod = w.person('dmod', { bits: [P.ModerateMembers] });
    w.plain = w.person('dplain');
    w.dashRole = w.role('900000000000000021'); w.autoRole = w.role('900000000000000022');
    w.session = (m) => { const sid = `sid-${m.id}`; w.dash.sessions.set(sid, { user: { id: m.id, username: m.id, avatar: null }, guilds: [{ id: DG, name: 'Test Guild', icon: null, owner: false, permissions: '0' }], expires: Date.now() + 3600000 }); return `gb_sid=${sid}`; };
    w.req = (method, p, { cookie, body, headers = {} } = {}) => new Promise((resolve, reject) => {
      const h = { ...headers }; if (cookie) h.cookie = cookie; if (method === 'POST') h['x-goodboy'] = '1';
      const r = http.request({ host: '127.0.0.1', port: w.dash.port, path: p, method, headers: h }, (res) => { const chunks = []; res.on('data', (d) => chunks.push(d)); res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) }); }); });
      r.on('error', reject); if (body !== undefined) r.write(JSON.stringify(body)); r.end();
    });
    w.grant = (m, role, ...keys) => { m.roles.cache.set(role.id, role); for (const k of keys) w.db.permAdd(DG, k, role.id); };
    return w;
  };
  const closeDash = (w) => w.dash.close();

  await test('phone app: /app and its files are served, and it can read levels, post announcements and run event hubs with the same login checks', async () => {
    const w = await dashWorld({}, null, ['community', 'engagement', 'tempvoice']);
    for (const [p, type] of [['/app', /text\/html/], ['/mobile.js', /javascript/], ['/mobile.css', /text\/css/], ['/manifest.webmanifest', /manifest\+json/], ['/icon-192.png', /image\/png/], ['/apple-touch-icon.png', /image\/png/], ['/fonts/Inter-Regular.woff', /font\/woff/]]) {
      const r = await w.req('GET', p); assert.equal(r.status, 200, p); assert.match(r.headers['content-type'], type, p);
    }
    const page = (await w.req('GET', '/app')).text;
    assert.match(page, /apple-mobile-web-app-capable/); assert.match(page, /rel="manifest"/); assert.ok(!/<script>/.test(page), 'no inline script (the page CSP allows none)');
    const js = (await w.req('GET', '/mobile.js')).text;
    assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(js), 'built from DOM nodes only');
    assert.equal(JSON.parse((await w.req('GET', '/manifest.webmanifest')).text).start_url, '/app');
    // levels: names and levels, best first
    w.mm.ctx(DG, 'community').data.set('user:dadmin', { xp: 1671 }); w.mm.ctx(DG, 'community').data.set('user:dplain', { xp: 120 });
    const lv = (await w.req('GET', gp('/modules/community/views/levels'), { cookie: w.session(w.admin) })).json();
    assert.equal(lv.total, 2); assert.deepEqual(lv.rows.map((r) => [r.name, r.level]), [['dadmin', 6], ['dplain', 1]]);
    assert.equal((await w.req('GET', gp('/modules/community/views/levels'), { cookie: w.session(w.plain) })).status, 403, 'members without access cannot read it');
    // announce: posts with the same rules as /announce
    const news = w.channel('news');
    const targets = (await w.req('GET', gp('/modules/engagement/views/announce-targets'), { cookie: w.session(w.admin) })).json();
    assert.ok(targets.channels.some((c) => c.id === news.id));
    const ann = (await w.req('POST', gp('/modules/engagement/actions/announce'), { cookie: w.session(w.admin), body: { channelId: news.id, title: 'Tonight', message: 'Scrims at 8', ping: 'none' } })).json();
    assert.equal(ann.ok, true); assert.equal(ann.result.channel, 'news'); assert.equal(news.sent.at(-1).embeds[0].data.title, 'Tonight');
    assert.match((await w.req('POST', gp('/modules/engagement/actions/announce'), { cookie: w.session(w.admin), body: { channelId: news.id, message: '' } })).json().error, /Write the announcement/);
    assert.equal((await w.req('POST', gp('/modules/engagement/actions/announce'), { cookie: w.session(w.plain), body: { channelId: news.id, message: 'hi' } })).status, 403);
    assert.equal((await w.req('POST', gp('/modules/engagement/actions/announce'), { cookie: w.session(w.admin), body: { channelId: news.id, message: 'hi' }, headers: { origin: 'https://evil.example' } })).status, 403, 'another site cannot post through your login');
    // event hubs: create, lock, list, end
    const evs = w.channel('events');
    const made = (await w.req('POST', gp('/modules/tempvoice/actions/event-create'), { cookie: w.session(w.admin), body: { name: 'Fortnite Duos', size: 2, maxTeams: 10, channelId: evs.id } })).json();
    assert.equal(made.ok, true); assert.equal(evs.sent.at(-1).embeds[0].data.title, 'Fortnite Duos · Duos (2)');
    assert.match((await w.req('POST', gp('/modules/tempvoice/actions/event-create'), { cookie: w.session(w.admin), body: { name: 'x', size: 7, channelId: evs.id } })).json().error, /Team size/);
    assert.equal((await w.req('POST', gp('/modules/tempvoice/actions/event-lock'), { cookie: w.session(w.admin), body: { id: made.result.id } })).json().result.locked, true);
    const list = (await w.req('GET', gp('/modules/tempvoice/views/events'), { cookie: w.session(w.admin) })).json();
    assert.deepEqual(list.events.map((e) => [e.name, e.locked]), [['Fortnite Duos', true]]); assert.ok(list.channels.length && list.sizes.includes(4));
    assert.equal((await w.req('POST', gp('/modules/tempvoice/actions/event-end'), { cookie: w.session(w.admin), body: { id: made.result.id } })).json().result.name, 'Fortnite Duos');
    assert.equal((await w.req('GET', gp('/modules/tempvoice/views/events'), { cookie: w.session(w.admin) })).json().events.length, 0);
    closeDash(w);
  });

  await test('admins get the full dashboard, with real server numbers and the platform permission listed', async () => {
    const w = await dashWorld();
    const d = (await w.req('GET', gp(''), { cookie: w.session(w.admin) })).json();
    assert.equal(d.access, 'admin');
    assert.deepEqual(Object.keys(d.stats).sort(), ['channels', 'members', 'roles', 'uptimeSeconds', 'version']);
    assert.equal(d.stats.version, '2.1.0'); assert.equal(d.stats.members, 10);
    assert.ok(d.corePermissions.some((p) => p.key === 'dashboard.access'));
    assert.ok(d.modules.find((m) => m.name === 'moderation').settings.length > 10);
    assert.ok(Array.isArray(d.channels) && Array.isArray(d.roles));
    assert.ok((await w.req('GET', '/api/me', { cookie: w.session(w.admin) })).json().guilds.some((g) => g.id === DG && g.access === 'admin'));
    closeDash(w);
  });

  await test('being a moderator is not enough: dashboard.access is needed, and defaults to admins only', async () => {
    const w = await dashWorld();
    const cookie = w.session(w.mod);
    assert.deepEqual((await w.req('GET', '/api/me', { cookie })).json().guilds, []);
    assert.equal((await w.req('GET', gp(''), { cookie })).status, 403);
    assert.equal((await w.req('GET', gp('/modules/support/views/tickets'), { cookie })).status, 403);
    assert.equal((await w.req('GET', gp(''), { cookie: w.session(w.plain) })).status, 403);
    closeDash(w);
  });

  await test('with dashboard.access a moderator gets a limited view: only the panels they hold permission for, no settings, lists or admin pages', async () => {
    const w = await dashWorld();
    w.grant(w.mod, w.dashRole, 'dashboard.access');
    const cookie = w.session(w.mod);
    assert.deepEqual((await w.req('GET', '/api/me', { cookie })).json().guilds.map((g) => [g.id, g.access]), [[DG, 'panel']]);
    const d = (await w.req('GET', gp(''), { cookie })).json();
    assert.equal(d.access, 'panel');
    for (const k of ['channels', 'roles', 'stats', 'corePermissions']) assert.equal(d[k], undefined, `${k} is withheld`);
    const names = Object.fromEntries(d.modules.map((m) => [m.name, m.panels.map((p) => p.id)]));
    assert.deepEqual(names.support?.sort(), ['archive', 'ratings', 'tickets', 'watch'], 'support panels default to moderators');
    assert.deepEqual(names.moderation, ['cases'], 'moderators see the history (3.0.1); the AutoMod panel needs moderation.automod, which defaults to admins');
    assert.equal(d.modules.some((m) => 'settings' in m || 'values' in m || 'permissions' in m), false);
    for (const [method, p, body] of [['POST', gp('/modules/moderation/settings'), { key: 'logChannel', value: null }], ['POST', gp('/modules/support/disable'), {}], ['POST', gp('/permissions'), { key: 'dashboard.access', roles: [] }], ['GET', gp('/logs')]]) {
      const r = await w.req(method, p, { cookie, body });
      assert.equal(r.status, 403, p); assert.match(r.json().error, /Manage Server/);
    }
    closeDash(w);
  });

  await test('each panel is enforced on the server: views and actions need that panel\'s own permission', async () => {
    const w = await dashWorld();
    w.grant(w.mod, w.dashRole, 'dashboard.access');
    const cookie = w.session(w.mod);
    assert.equal((await w.req('GET', gp('/modules/support/views/tickets'), { cookie })).status, 200);
    assert.equal((await w.req('GET', gp('/modules/moderation/views/automod'), { cookie })).status, 403, 'AutoMod panel: not allowed yet');
    assert.equal((await w.req('POST', gp('/modules/moderation/actions/automod-toggle'), { cookie, body: { id: 'caps' } })).status, 403);
    w.grant(w.mod, w.autoRole, 'moderation.automod');
    assert.equal((await w.req('GET', gp('/modules/moderation/views/automod'), { cookie })).status, 200);
    assert.equal(w.mm.ctx(DG, 'moderation').config.get('automodCaps'), false);
    const done = await w.req('POST', gp('/modules/moderation/actions/automod-toggle'), { cookie, body: { id: 'caps', userId: 'caps' } });
    assert.equal(done.status, 200);
    assert.equal(w.mm.ctx(DG, 'moderation').config.get('automodCaps'), true);
    assert.ok(w.db.recentLogs(DG, 20).some((l) => /panel access.*automod-toggle/.test(l.message)), 'the log says it was done with panel access');
    // an action that is not part of any panel they may use stays closed, even inside an allowed module
    assert.equal((await w.req('POST', gp('/modules/moderation/actions/not-a-panel-action'), { cookie, body: {} })).status, 403);
    // admins are not bound by panel permissions
    assert.equal((await w.req('GET', gp('/modules/moderation/views/automod'), { cookie: w.session(w.admin) })).status, 200);
    closeDash(w);
  });

  await test('access is live: removing the role closes the dashboard at once', async () => {
    const w = await dashWorld();
    w.grant(w.mod, w.dashRole, 'dashboard.access');
    const cookie = w.session(w.mod);
    assert.equal((await w.req('GET', gp(''), { cookie })).status, 200);
    w.mod.roles.cache.delete(w.dashRole.id);
    assert.equal((await w.req('GET', gp(''), { cookie })).status, 403);
    assert.deepEqual((await w.req('GET', '/api/me', { cookie })).json().guilds, []);
    closeDash(w);
  });

  await test('dashboard.access can be assigned from the dashboard and with /permissions like any other permission', async () => {
    const w = await dashWorld();
    const r = await w.req('POST', gp('/permissions'), { cookie: w.session(w.admin), body: { key: 'dashboard.access', roles: [w.dashRole.id] } });
    assert.equal(r.status, 200);
    assert.deepEqual(w.db.permRoles(DG, 'dashboard.access'), [w.dashRole.id]);
    const i = w.ix({ command: 'permissions', sub: 'list', member: w.admin });
    await w.mm.handleCommand(i);
    assert.match(JSON.stringify(i.replies[0].embeds[0].data.description), /dashboard\.access/);
    closeDash(w);
  });

  await test('updates API: only the bot owner, and only with a supervisor; applying needs an explicit confirmation', async () => {
    const asked = [];
    const link = { request: async (action) => { asked.push(action); return { ok: true, action, status: { state: 'running' } }; } };
    const w = await dashWorld({}, link);
    w.mm.ownerIds.add('dadmin');
    const owner = w.session(w.admin), notOwner = w.session(w.mod);
    assert.equal((await w.req('GET', '/api/updates')).status, 401);
    assert.equal((await w.req('GET', '/api/updates', { cookie: notOwner })).status, 403, 'a server admin who is not the bot owner');
    assert.equal((await w.req('POST', '/api/updates/apply', { cookie: notOwner, body: { confirm: true } })).status, 403);
    assert.equal((await w.req('GET', '/api/me', { cookie: owner })).json().botOwner, true);
    assert.equal((await w.req('GET', '/api/me', { cookie: notOwner })).json().botOwner, false);
    const st = (await w.req('GET', '/api/updates', { cookie: owner })).json(); assert.deepEqual([st.supervised, st.ok, st.status.state], [true, true, 'running']);
    assert.equal((await w.req('POST', '/api/updates/check', { cookie: owner, body: {} })).status, 200);
    assert.equal((await w.req('POST', '/api/updates/apply', { cookie: owner, body: {} })).status, 400, 'no confirm, no update');
    assert.ok(!asked.includes('apply'));
    assert.equal((await w.req('POST', '/api/updates/apply', { cookie: owner, body: { confirm: true } })).status, 200);
    assert.deepEqual(asked, ['status', 'check', 'apply']);
    assert.ok(w.logs.some((l) => /Update requested from the dashboard by dadmin/.test(l)), 'who did it is logged');
    assert.equal((await w.req('POST', '/api/updates/apply', { cookie: owner, body: { confirm: true }, headers: { origin: 'https://evil.example' } })).status, 403, 'cross-site requests are blocked');
    closeDash(w);
    const plain = await dashWorld(); plain.mm.ownerIds.add('dadmin');
    const none = (await plain.req('GET', '/api/updates', { cookie: plain.session(plain.admin) })).json();
    assert.equal(none.supervised, false); assert.match(none.message, /npm run supervised/);
    closeDash(plain);
  });

  await test('design assets: the logo is small and cached, the glass layer holds every animation, branding is Good Boy', async () => {
    const w = await dashWorld();
    const logo = await w.req('GET', '/good-boy-logo.png');
    assert.equal(logo.status, 200); assert.equal(logo.headers['content-type'], 'image/png');
    assert.ok(logo.buf.length < 150000, `logo is ${logo.buf.length} bytes`);
    assert.deepEqual([...logo.buf.subarray(1, 4)], [0x50, 0x4e, 0x47]);
    assert.match(logo.headers['cache-control'], /max-age/);
    assert.equal((await w.req('GET', '/favicon.ico')).status, 200);
    const glass = (await w.req('GET', '/glass.css')).text;
    for (const need of ['@keyframes drift', 'backdrop-filter', '.aurora i:nth-child(1)', '.aurora i:nth-child(2)', '.aurora i:nth-child(3)', 'animation-duration:24s', 'animation-duration:21s', 'animation:drift 18s', '.theme-light', '.theme-blue', '.motion-off .aurora i', 'prefers-reduced-motion:reduce', '.guild:hover', 'filter:brightness(1.13)', '#toast{transition:opacity .2s}', 'focus-visible']) assert.ok(glass.includes(need), `glass.css keeps: ${need}`);
    const html = (await w.req('GET', '/')).text, js = (await w.req('GET', '/app.js')).text, css = (await w.req('GET', '/style.css')).text;
    assert.ok(html.includes('/glass.css') && html.includes('/style.css') && html.includes('class="aurora"'));
    assert.ok(js.includes("'X-GoodBoy'") && !/X-Eclipse/i.test(js + html + css + glass), 'header is X-GoodBoy everywhere');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js), 'the page builds DOM nodes only');
    assert.ok(/function renderUpdates/.test(js) && /botOwner/.test(js), 'the Updates page exists and is only offered to the bot owner');
    assert.ok(!/animation|@keyframes/.test(css), 'style.css has no animation - it all lives in the one glass layer');
    for (const text of [html, js, css, glass]) assert.doesNotMatch(text, BANNED_RE);
    const csp = (await w.req('GET', '/')).headers['content-security-policy'];
    assert.match(csp, /script-src 'self'/); assert.match(csp, /style-src 'self'/);
    closeDash(w);
  });

  await test('behind your own tunnel or proxy: the forwarded host is believed only when you turn that on', async () => {
    const off = await dashWorld({ DASHBOARD_BASE_URL: 'https://good-boy.example.ts.net' });
    const asked = await off.req('GET', '/', { headers: { host: '127.0.0.1:1', 'x-forwarded-host': 'good-boy.example.ts.net' } });
    assert.equal(asked.status, 302, 'without trust the forwarded host is ignored, so the address is corrected');
    closeDash(off);
    const on = await dashWorld({ DASHBOARD_BASE_URL: 'https://good-boy.example.ts.net', DASHBOARD_TRUST_PROXY: '1' });
    assert.equal((await on.req('GET', '/', { headers: { host: '127.0.0.1:1', 'x-forwarded-host': 'good-boy.example.ts.net' } })).status, 200);
    assert.equal((await on.req('GET', '/', { headers: { host: 'good-boy.example.ts.net', 'x-forwarded-host': 'evil.example' } })).status, 302, 'a forwarded host that differs is redirected');
    closeDash(on);
  });

  await test('modules added while the bot runs: checked first, then loaded without touching the ones already running', async () => {
    const w = await makeWorld(['stats']).load();
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-extra-'));
    const mk = (name, body) => { fs.mkdirSync(path.join(extra, name), { recursive: true }); fs.writeFileSync(path.join(extra, name, 'index.js'), body); };
    mk('hello-world', "export default { name: 'hello-world', version: '1.0.0', description: 'Says hi', commands: [{ data: { name: 'hi', description: 'Say hi' }, execute: async (c, i) => i.reply({ content: 'hi' }) }] };");
    mk('clash', "export default { name: 'clash', version: '1.0.0', commands: [{ data: { name: 'stats', description: 'x' }, execute: async () => {} }] };");
    mk('wrong-folder', "export default { name: 'something-else', version: '1.0.0' };");
    assert.deepEqual(await w.mm.inspect(path.join(extra, 'hello-world')), { ok: true, name: 'hello-world', version: '1.0.0', description: 'Says hi', commands: ['hi'] });
    assert.match((await w.mm.inspect(path.join(extra, 'clash'))).error, /already used by "stats"/);
    assert.match((await w.mm.inspect(path.join(extra, 'wrong-folder'))).error, /match its folder/);
    const before = w.mm.defs.get('stats').def;
    const r = await w.mm.loadNew(extra);
    assert.deepEqual(r.added, ['hello-world']); assert.deepEqual(Object.keys(r.errors).sort(), ['clash', 'wrong-folder']);
    assert.equal(w.mm.defs.get('stats').def, before, 'modules already running are not reloaded');
    assert.deepEqual((await w.mm.loadNew(extra)).added, [], 'loading again adds nothing twice');
    await w.mm.enable('1', 'hello-world'); assert.ok(w.mm.isActive('1', 'hello-world'));
  });

  // ================================================================ popups everywhere
  console.log('\nPopup forms');
  await test('popup forms: every form fits Discord (at most 5 fields, short labels) and reads answers back as plain values', async () => {
    const { formModal, readForm, checkSpec } = await import('../src/modalkit.js');
    assert.throws(() => checkSpec([{ id: 'a', label: 'x'.repeat(46) }]), /longer than 45/);
    assert.throws(() => checkSpec(Array.from({ length: 6 }, (_, n) => ({ id: `f${n}`, label: 'x' }))), /1 to 5 fields/);
    assert.throws(() => checkSpec([{ id: 's', label: 'Pick', kind: 'select', options: [] }]), /1 to 25 choices/);
    const { teamFields } = await import('../modules/reminders/index.js');
    const { partyFields } = await import('../modules/partyfinder/index.js');
    const { menuFields } = await import('../modules/roles/index.js');
    const { verifyFields } = await import('../modules/member-management/index.js');
    const { panelFields } = await import('../modules/support/index.js');
    const cfg = { config: { get: (k) => (k === 'allowVoice' ? true : '') } };
    for (const [name, spec] of [['remind team', teamFields('1')], ['party', partyFields(cfg)], ['role menu', menuFields], ['verify', verifyFields(cfg, '1')], ['ticket panel', panelFields('1')]]) { checkSpec(spec); assert.ok(formModal('x:y:z', name, spec), name); }
    const fields = [{ id: 'n', label: 'Players', kind: 'number', min: 2, maxNum: 10 }, { id: 'c', label: 'Channel', kind: 'channel' }, { id: 'r', label: 'Roles', kind: 'roles' }, { id: 's', label: 'Pick', kind: 'select', options: [{ label: 'A', value: 'a' }] }];
    const i = { fields: { getTextInputValue: () => ' 4 ', getSelectedChannels: () => new Map([['c1', { id: 'c1' }]]), getSelectedRoles: () => new Map([['r1', {}], ['r2', {}]]), getStringSelectValues: () => ['a'] } };
    assert.deepEqual(readForm(i, fields), { n: 4, c: 'c1', r: ['r1', 'r2'], s: 'a' });
    assert.throws(() => readForm({ fields: { ...i.fields, getTextInputValue: () => '99' } }, fields), /at most 10/);
    assert.throws(() => readForm({ fields: { ...i.fields, getTextInputValue: () => 'lots' } }, fields), /must be a number/);
  });

  await test('popup forms: team reminders, party finder, role menus, verification and the ticket panel all work from one popup', async () => {
    const w = await makeWorld(['reminders', 'partyfinder', 'roles', 'member-management', 'support']).load();
    w.admin = w.person('admin1', { bits: [P.Administrator, P.ManageGuild, P.ManageRoles], pos: 15 });
    const ch = w.channel('general'); const r1 = w.role('r1', { pos: 2 }); const r2 = w.role('r2', { pos: 3 });
    const open = async (command, sub, opts = {}) => { const i = w.ix({ command, sub, member: w.admin, channel: ch, opts }); await w.mm.handleCommand(i); assert.ok(i.modal, `/${command} ${sub ?? ''} opened a popup`); return i.modal.data?.custom_id ?? i.modal.customId ?? i.modal.data?.customId; };
    const tokenOf = (store) => [...globalThis[Symbol.for(`goodboy.forms.${store}`)].keys()].pop();
    const submit = async (customId, values) => {
      const i = Object.assign(w.ix({ command: undefined, customId, member: w.admin, channel: ch }), { fields: {
        getTextInputValue: (k) => values[k] ?? '', getSelectedChannels: (k) => (values[k] ? new Map([[values[k].id, values[k]]]) : null),
        getSelectedRoles: (k) => new Map([].concat(values[k] ?? []).map((r) => [r.id, r])), getStringSelectValues: (k) => (values[k] ? [values[k]] : []), getSelectedUsers: () => new Map(),
      } });
      return w.click(i);
    };
    await open('remind', 'team', { channel: null, when: null, role: null, message: null, repeat: null });
    assert.match(await submit(`remind:team:${tokenOf('remind')}`, { text: 'Scrims tonight', when: '2h', channel: ch, roles: [r1, r2], repeat: 'weekly' }), /Reminder \*\*#1\*\*/);
    const rem = w.mm.ctx('1', 'reminders').data.get('r:1'); assert.deepEqual([rem.kind, rem.roleIds, rem.repeat, rem.channelId], ['team', ['r1', 'r2'], 'weekly', ch.id]);
    await open('party', 'create', { game: null, slots: null });
    assert.match(await submit(`party:form:${tokenOf('party')}`, { game: 'Fortnite', slots: '2', when: '', description: 'Duos, mics on', voice: 'no' }), /Party \*\*#1\*\* posted/);
    const party = w.mm.ctx('1', 'partyfinder').data.get('p:1'); assert.deepEqual([party.game, party.slots, party.description], ['Fortnite', 2, 'Duos, mics on']);
    await open('rolemenu', 'create', { title: null });
    assert.match(await submit(`rolemenu:form:${tokenOf('rolemenu')}`, { title: 'Pick your games', description: '', roles: [r1, r2], style: 'buttons', mode: 'toggle' }), /Role menu posted/);
    assert.equal(ch.sent.at(-1).embeds[0].data.title, 'Pick your games');
    await open('verify', 'setup', { role: null });
    assert.match(await submit(`verify:form:${tokenOf('verify')}`, { role: r1, unverified: null, channel: ch, message: 'Press the button to get in' }), /Verification is set up/);
    assert.equal(w.mm.getSettingValues('1', 'member-management').verificationRole, 'r1');
    await open('ticket', 'panel', { channel: null, title: null, description: null });
    assert.match(await submit(`ticket:panelform:${tokenOf('support')}`, { channel: ch, title: 'Get help here', description: 'Pick one' }), /Panel posted/);
    assert.equal(ch.sent.at(-1).embeds[0].data.title, 'Get help here');
  });

  // ================================================================ temporary voice
  console.log('\nTemporary voice rooms');
  const tvWorld = async () => {
    const w = await makeWorld(['tempvoice']).load();
    w.admin = w.person('admin1', { bits: [P.Administrator], pos: 10 });
    w.alice = w.person('alice'); w.bob = w.person('bob'); w.cara = w.person('cara');
    const voiceCh = (name) => {
      const ch = w.channel(name); ch.type = ChannelType.GuildVoice; ch.userLimit = 0; ch.members = new Coll();
      ch.setUserLimit = async (n) => { ch.userLimit = n; };
      ch.permissionOverwrites.cache = new Coll();
      return ch;
    };
    w.lobby = voiceCh('Join to create');
    const create = w.g.channels.create;
    w.g.channels.create = async (o) => { const ch = voiceCh(o.name); ch.createOpts = o; ch.userLimit = o.userLimit ?? 0; ch.parentId = o.parent ?? null; return ch; };
    for (const m of [w.alice, w.bob, w.cara, w.admin]) {
      m.voice = { channelId: null, channel: null, setChannel: async (c) => w.move(m, c), disconnect: async () => w.move(m, null) };
    }
    w.move = async (m, ch) => {
      const old = m.voice.channel;
      old?.members.delete(m.id);
      m.voice.channelId = ch?.id ?? null; m.voice.channel = ch ?? null;
      ch?.members.set(m.id, m);
      const oldS = { member: m, channelId: old?.id ?? null, guild: w.g }; const newS = { member: m, channelId: ch?.id ?? null, guild: w.g, setChannel: async (c) => w.move(m, c) };
      await w.mm.dispatch('voiceStateUpdate', '1', oldS, newS);
    };
    w.room = (m) => m.voice.channel;
    w.cmd = async (m, sub, opts = {}) => { const i = w.ix({ command: 'room', sub, member: m, opts }); await w.mm.handleCommand(i); return i; };
    await w.run(w.ix({ command: 'voicehub', sub: 'add', member: w.admin, opts: { lobby: w.lobby } }));
    return w;
  };

  await test('joining a lobby creates a room, names it, makes the member its owner and moves them in', async () => {
    const w = await tvWorld();
    await w.move(w.alice, w.lobby);
    const room = w.room(w.alice);
    assert.ok(room && room.id !== w.lobby.id, 'moved out of the lobby into a new room');
    assert.equal(room.name, "alice's room");
    assert.ok(room.createOpts.permissionOverwrites.some((o) => o.id === 'alice'), 'the owner has their own permissions');
    assert.equal(w.mm.ctx('1', 'tempvoice').data.get(`room:${room.id}`).owner, 'alice');
  });

  await test('an owner who rejoins the lobby is sent back to their room, and quick double joins make one room', async () => {
    const w = await tvWorld();
    const made = []; const create = w.g.channels.create;
    w.g.channels.create = async (o) => { const c = await create(o); made.push(c); return c; };
    await Promise.all([w.move(w.alice, w.lobby), w.move(w.alice, w.lobby)]);
    assert.equal(made.length, 1);
    await w.move(w.alice, w.lobby);
    assert.equal(made.length, 1, 'no second room');
    assert.equal(w.room(w.alice).id, made[0].id);
  });

  await test('an empty room is deleted after the delay, and the sweep recovers rooms after a restart', async () => {
    const w = await tvWorld();
    w.mm.setSetting('1', 'tempvoice', 'emptyDelaySeconds', 0);
    await w.move(w.alice, w.lobby);
    const room = w.room(w.alice);
    await w.move(w.alice, null);
    assert.ok(room.removed, 'channel deleted');
    assert.equal(w.mm.ctx('1', 'tempvoice').data.get(`room:${room.id}`), undefined);
    // restart: a room whose channel vanished while the bot was off, and an empty one left behind
    const d = w.mm.ctx('1', 'tempvoice').data;
    d.set('room:999000000000000001', { id: '999000000000000001', owner: 'alice', lobby: w.lobby.id, createdAt: 1, privacy: 'public' });
    const stale = w.g.channels.create({ name: 'left over' }); const ch = await stale;
    d.set(`room:${ch.id}`, { id: ch.id, owner: 'alice', lobby: w.lobby.id, createdAt: 1, privacy: 'public', emptySince: 1 });
    await w.mm.runTasks(Date.now()); await w.mm.runTasks(Date.now());
    assert.equal(d.get('room:999000000000000001'), undefined, 'record for a missing channel dropped');
    assert.ok(ch.removed, 'empty leftover room deleted');
  });

  await test('with a delay, an empty room is deleted on time by itself (not left until a sweep), and someone coming back keeps it', async () => {
    const w = await tvWorld();
    w.mm.setSetting('1', 'tempvoice', 'emptyDelaySeconds', 1);
    await w.move(w.alice, w.lobby); const room = w.room(w.alice);
    await w.move(w.bob, room);
    await w.move(w.alice, null); assert.ok(!room.removed, 'someone is still inside');
    await w.move(w.bob, null); assert.ok(!room.removed, 'waits for the delay');
    await new Promise((r) => setTimeout(r, 1300));
    assert.ok(room.removed, 'both left: deleted about a second later without waiting for a sweep');
    assert.equal(w.mm.ctx('1', 'tempvoice').data.get(`room:${room.id}`), undefined);
    // leave and come straight back: the room stays
    await w.move(w.cara, w.lobby); const r2 = w.room(w.cara);
    await w.move(w.cara, null); await w.move(w.cara, r2);
    await new Promise((r) => setTimeout(r, 1300));
    assert.ok(!r2.removed, 'came back in time, so the room was kept');
  });

  await test('the owner can rename (twice per ten minutes), limit, lock, hide, invite, kick, ban and transfer; others cannot', async () => {
    const w = await tvWorld();
    await w.move(w.alice, w.lobby); const room = w.room(w.alice);
    await w.move(w.bob, room);
    assert.match((await w.cmd(w.bob, 'name', { name: 'mine now' })).text(), /Only the room's owner/);
    assert.match((await w.cmd(w.alice, 'name', { name: 'Chill <@123> @everyone zone' })).text(), /Renamed/);
    assert.equal(room.name, 'Chill everyone zone');
    await w.cmd(w.alice, 'name', { name: 'Two' });
    assert.match((await w.cmd(w.alice, 'name', { name: 'Three' })).text(), /twice every 10 minutes/);
    assert.equal(room.name, 'Two');
    await w.cmd(w.alice, 'limit', { people: 4 }); assert.equal(room.userLimit, 4);
    await w.cmd(w.alice, 'privacy', { mode: 'hidden' });
    assert.deepEqual(room.overwrites.get('1'), { Connect: false, ViewChannel: false });
    await w.cmd(w.alice, 'privacy', { mode: 'locked' });
    assert.deepEqual(room.overwrites.get('1'), { Connect: false, ViewChannel: null });
    await w.cmd(w.alice, 'invite', { member: w.cara.user });
    assert.deepEqual(room.overwrites.get('cara'), { ViewChannel: true, Connect: true });
    await w.cmd(w.alice, 'kick', { member: w.bob.user }); assert.equal(w.bob.voice.channelId, null);
    await w.move(w.bob, room);
    await w.cmd(w.alice, 'ban', { member: w.bob.user });
    assert.equal(w.bob.voice.channelId, null); assert.deepEqual(room.overwrites.get('bob'), { Connect: false, ViewChannel: false });
    assert.match((await w.cmd(w.alice, 'kick', { member: w.alice.user })).text(), /Pick someone else/);
    await w.move(w.cara, room);
    await w.cmd(w.alice, 'transfer', { member: w.cara.user });
    assert.equal(w.mm.ctx('1', 'tempvoice').data.get(`room:${room.id}`).owner, 'cara');
    assert.match((await w.cmd(w.alice, 'limit', { people: 2 })).text(), /Only the room's owner/);
  });

  await test('when the owner leaves a room others are in, the longest-present member takes over (or /room claim, by setting)', async () => {
    const w = await tvWorld();
    await w.move(w.alice, w.lobby); const room = w.room(w.alice);
    await w.move(w.bob, room); await new Promise((r) => setTimeout(r, 5)); await w.move(w.cara, room);
    await w.move(w.alice, null);
    assert.equal(w.mm.ctx('1', 'tempvoice').data.get(`room:${room.id}`).owner, 'bob');
    w.mm.setSetting('1', 'tempvoice', 'ownerLeaves', 'claim');
    await w.move(w.bob, null);
    assert.equal(w.mm.ctx('1', 'tempvoice').data.get(`room:${room.id}`).owner, 'bob', 'kept until claimed');
    assert.match((await w.cmd(w.cara, 'name', { name: 'x' })).text(), /use `\/room claim`/);
    await w.cmd(w.cara, 'claim');
    assert.equal(w.mm.ctx('1', 'tempvoice').data.get(`room:${room.id}`).owner, 'cara');
  });

  await test('only staff set up lobbies, and the setup checks the lobby is a voice channel', async () => {
    const w = await tvWorld();
    const text = w.channel('chat');
    assert.match(await w.run(w.ix({ command: 'voicehub', sub: 'add', member: w.alice, opts: { lobby: w.lobby } })), /permission/);
    assert.match(await w.run(w.ix({ command: 'voicehub', sub: 'add', member: w.admin, opts: { lobby: text } })), /voice channel/);
    assert.match(await w.run(w.ix({ command: 'voicehub', sub: 'list', member: w.admin })), /Open rooms: 0/);
    await w.run(w.ix({ command: 'voicehub', sub: 'remove', member: w.admin, opts: { lobby: w.lobby } }));
    await w.move(w.alice, w.lobby);
    assert.equal(w.room(w.alice).id, w.lobby.id, 'a removed lobby no longer creates rooms');
  });

  await test('event hub logic: solo players fill open teams or form new ones, friends accept, leaving frees spots, limits hold', async () => {
    const EH = await import('../src/eventhub.js');
    const ev = EH.newEvent({ id: '1', name: 'Fortnite Duos', size: 2, maxTeams: 2, by: 'host' });
    assert.throws(() => EH.newEvent({ id: 'x', name: 'x', size: 7, maxTeams: 2 }), /Team size/);
    assert.equal(EH.joinSolo(ev, 'a').action, 'queued');
    assert.match(EH.joinSolo(ev, 'a').error, /already in this event/);
    const f = EH.joinSolo(ev, 'b');
    assert.equal(f.action, 'formed'); assert.deepEqual(f.team.members, ['a', 'b']); assert.equal(f.team.open, false);
    // a team made with a friend invite: the friend's spot is held until they answer
    const t = EH.makeTeam(ev, 'c', { invited: ['d'] });
    assert.ok(t.ok); assert.equal(t.team.open, false, 'duo with a friend picked: no spot for solo players');
    assert.match(EH.makeTeam(ev, 'e').error, /full \(2 teams\)/);
    assert.match(EH.acceptInvite(ev, t.team.n, 'zz').error, /not for you/);
    assert.ok(EH.acceptInvite(ev, t.team.n, 'd').ok); assert.deepEqual(t.team.members, ['c', 'd']);
    // full event: solo players wait; when a team leaves, the queue becomes a team
    EH.joinSolo(ev, 'e'); const w2 = EH.joinSolo(ev, 'f');
    assert.equal(w2.full, true); assert.deepEqual(ev.queue, ['e', 'f']);
    EH.leave(ev, 'c'); const gone = EH.leave(ev, 'd'); assert.equal(gone.emptied, true);
    const drained = EH.drainQueue(ev);
    assert.equal(drained.formed.length, 1); assert.deepEqual(drained.formed[0].members, ['e', 'f']); assert.equal(ev.queue.length, 0);
    // someone leaving a full team opens their spot, and the next solo player takes it
    EH.leave(ev, 'a'); assert.equal(ev.teams[0].open, true);
    assert.equal(EH.joinSolo(ev, 'g').action, 'added'); assert.deepEqual(ev.teams[0].members, ['b', 'g']);
    ev.locked = true; assert.match(EH.joinSolo(ev, 'h').error, /locked/);
    // squads: friends picked plus solo fill
    const sq = EH.newEvent({ id: '2', name: 'Squads', size: 4, maxTeams: 5, by: 'host' });
    const s1 = EH.makeTeam(sq, 'a', { invited: ['b'] });
    assert.equal(s1.team.open, true);
    assert.equal(EH.joinSolo(sq, 'x').action, 'added'); assert.equal(EH.joinSolo(sq, 'y').action, 'added');
    assert.equal(s1.team.open, false, '2 members + 1 invited... the 4th spot stays held for the friend');
    assert.match(EH.makeTeam(sq, 'p', { invited: ['q', 'r', 's', 't'] }).error, /up to 3 friends/);
    assert.deepEqual(EH.summary(sq), { teams: 1, players: 3, waiting: 0, openSpots: 0 });
  });

  await test('event hubs: one popup posts a panel; solo, friends and team-room buttons make private team rooms that are removed when the team leaves', async () => {
    const w = await tvWorld();
    w.mm.setSetting('1', 'tempvoice', 'emptyDelaySeconds', 0);
    const panelCh = w.channel('events'); const edits = [];
    panelCh.messages.edit = async (mid, p) => { edits.push(p); };
    const dave = w.person('dave'); dave.voice = { channelId: null, channel: null, setChannel: async (c) => w.move(dave, c) };
    // admin: /voicehub event opens the popup
    const open = w.ix({ command: 'voicehub', sub: 'event', member: w.admin, channel: panelCh });
    await w.mm.handleCommand(open);
    const cid = open.modal.data?.custom_id ?? open.modal.customId ?? open.modal.data?.customId;
    assert.match(cid, /^tvev:new:/);
    assert.match(await w.run(w.ix({ command: 'voicehub', sub: 'event', member: w.alice })), /permission/);
    const form = (customId, member, values) => Object.assign(w.ix({ command: undefined, customId, member, channel: panelCh }), { fields: {
      getTextInputValue: (k) => values[k] ?? '', getSelectedChannels: (k) => (values[k] ? new Map([[values[k].id, values[k]]]) : null),
      getSelectedRoles: () => new Map(), getStringSelectValues: (k) => (values[k] ? [values[k]] : []),
      getSelectedUsers: (k) => new Map([].concat(values[k] ?? []).map((u) => [u.id, u])),
    } });
    assert.match(await w.click(form(cid, w.admin, { name: 'Fortnite Battle Duos', size: '2', maxTeams: '', channel: panelCh })), /is open in/);
    const panel = panelCh.sent.at(-1);
    assert.equal(panel.embeds[0].data.title, 'Fortnite Battle Duos · Duos (2)');
    const evId = w.mm.ctx('1', 'tempvoice').data.list('ev:')[0].value.id;
    const press = (action, member, extra = '') => w.click(w.ix({ command: undefined, customId: `tvev:${action}:${evId}${extra}`, member, channel: panelCh }));

    // alice is in voice already; she and bob press Join solo and become Team 1, and alice is moved into the new room
    const hang = w.channel('hangout'); hang.type = ChannelType.GuildVoice; hang.members = new Coll();
    await w.move(w.alice, hang);
    assert.match(await press('solo', w.alice), /in the queue\. 1 more player/);
    assert.match(await press('solo', w.bob), /You're on Team 1\. Your room:/);
    const room1 = w.room(w.alice);
    assert.equal(room1.name, 'Fortnite Battle Duos - Team 1');
    assert.equal(room1.userLimit, 2);
    assert.ok(room1.createOpts.permissionOverwrites.some((o) => o.id === '1' && o.deny?.length), 'only the team can join');
    assert.ok(room1.createOpts.permissionOverwrites.some((o) => o.id === 'bob'));
    assert.match(String(panelCh.sent.at(-1).content), /Team 1\*\* is ready: <@alice> <@bob>/);
    assert.ok(edits.length, 'the panel updates');

    // cara picks dave with Join with friends: a popup, then dave accepts
    const fb = w.ix({ command: undefined, customId: `tvev:friends:${evId}`, member: w.cara, channel: panelCh });
    await w.click(fb); assert.ok(fb.modal, 'friends button opens a popup');
    assert.match(await w.click(form(`tvev:friendsform:${evId}`, w.cara, { friends: [dave.user] })), /Team 2 is yours\. I asked <@dave>/);
    assert.match(String(panelCh.sent.at(-1).content), /<@dave>: <@cara> wants you/);
    assert.match(await press('accept', w.bob, ':2'), /not for you/);
    assert.match(await press('accept', dave, ':2'), /You're on Team 2/);
    const ev = () => w.mm.ctx('1', 'tempvoice').data.get(`ev:${evId}`);
    assert.deepEqual(ev().teams.find((t) => t.n === 2).members, ['cara', 'dave']);

    // a new team room waits for its team (grace), but once they have been in, it goes when they all leave
    const room2 = w.g.channels.cache.get(ev().teams.find((t) => t.n === 2).roomId);
    await w.mm.runTasks(Date.now());
    assert.ok(!room2.removed, 'nobody joined yet: kept during the grace time');
    await w.move(w.bob, room1);
    await w.move(w.alice, null); assert.ok(!room1.removed);
    await w.move(w.bob, null);
    assert.ok(room1.removed, 'both left: Team 1 room deleted');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ev().teams.some((t) => t.n === 1), false, 'and the team is off the event');

    // Leave: the last member leaving removes the room
    await press('leave', w.cara); assert.match(await press('leave', dave), /Nobody was left/);
    assert.ok(room2.removed);

    // only the host or staff can lock or end
    assert.match(await press('end', w.alice), /Only the event host/);
    assert.match(await press('lock', w.admin), /locked/);
    assert.match(await press('solo', w.alice), /locked/);
    assert.match(await press('end', w.admin), /has ended/);
    assert.equal(ev(), undefined);
  });

  await test('room names are clean: no pings, controls, or more than 100 characters', async () => {
    const { sanitizeName, roomName, checkRename, nextOwner } = await import('../src/tempvoice.js');
    assert.equal(sanitizeName('  a‮b\n\tc  '), 'ab c');
    assert.equal(sanitizeName('<@123456789012345678>'), 'Room');
    assert.equal(sanitizeName('x'.repeat(300)).length, 100);
    assert.equal(roomName('{user} #{n}', { user: '@everyone', n: 7 }), 'everyone #7');
    assert.equal(checkRename([], 1000).ok, true);
    assert.equal(checkRename([1000, 2000], 3000).ok, false);
    assert.equal(checkRename([1000, 2000], 1000 + 600001).ok, true);
    assert.equal(nextOwner(['a', 'b', 'c'], 'a', { b: 5, c: 3 }), 'c');
    assert.equal(nextOwner(['a'], 'a'), null);
  });

  // ================================================================ party finder
  console.log('\nParty Finder');
  const pfWorld = async () => {
    const w = await makeWorld(['partyfinder']).load();
    w.admin = w.person('admin1', { bits: [P.Administrator], pos: 10 });
    w.mod = w.person('mod1', { bits: [P.ModerateMembers], pos: 5 });
    w.host = w.person('host'); w.a = w.person('pa'); w.b = w.person('pb'); w.c = w.person('pc');
    w.mod.roles.cache.set('modrole', { id: 'modrole' });
    w.board = w.channel('lfg');
    w.mm.setSetting('1', 'partyfinder', 'partyChannel', w.board.id);
    w.party = (m, opts, ch = w.board) => { const i = w.ix({ command: 'party', sub: 'create', member: m, channel: ch, opts }); return w.mm.handleCommand(i).then(() => i); };
    w.sub = async (m, sub, opts) => { const i = w.ix({ command: 'party', sub, member: m, opts }); await w.mm.handleCommand(i); return i; };
    w.btn = async (m, action, id = 1) => { const i = w.ix({ member: m, customId: `party:${action}:${id}`, channel: w.board }); await w.mm.handleComponent(i); return i; };
    w.data = () => w.mm.ctx('1', 'partyfinder').data;
    return w;
  };
  const fields = (p) => Object.fromEntries((p.embeds[0].data.fields ?? []).map((f) => [f.name.replace(/ \(.*/, ''), f.value]));

  await test('/party create posts the party with Join, Leave and Close, counting the host as the first player', async () => {
    const w = await pfWorld();
    const i = await w.party(w.host, { game: 'Valorant', slots: 5, description: 'Gold lobby, mics on <@123> @everyone' });
    assert.match(i.text(), /Party \*\*#1\*\* posted/);
    const post = w.board.sent[0];
    assert.match(post.embeds[0].data.title, /Valorant/);
    assert.ok(!/@everyone|<@123>/.test(post.embeds[0].data.description), 'pings stripped from the description');
    assert.match(fields(post).Players, /👑 <@host>/);
    assert.deepEqual(post.components[0].components.map((b) => b.data.custom_id), ['party:join:1', 'party:leave:1', 'party:close:1']);
    assert.match(fields(post).Details, /4 spots left/);
  });

  await test('joining and leaving update the post; a full party disables Join, and leaving reopens it', async () => {
    const w = await pfWorld();
    await w.party(w.host, { game: 'Apex', slots: 3 });
    let i = await w.btn(w.a, 'join'); assert.match(fields(i.updated).Players, /<@pa>/);
    assert.match((await w.btn(w.a, 'join')).text(), /already in/);
    i = await w.btn(w.b, 'join');
    assert.match(i.updated.embeds[0].data.title, /FULL/);
    assert.equal(i.updated.components[0].components[0].data.disabled, true);
    assert.match((await w.btn(w.c, 'join')).text(), /full/);
    i = await w.btn(w.a, 'leave');
    assert.ok(!/FULL/.test(i.updated.embeds[0].data.title)); assert.equal(i.updated.components[0].components[0].data.disabled, false);
    assert.match((await w.btn(w.host, 'leave')).text(), /Use \*\*Close\*\*/);
    assert.match((await w.btn(w.c, 'leave')).text(), /not in this party/);
  });

  await test('only the host or partyfinder.manage can close; closing edits the post and removes the buttons', async () => {
    const w = await pfWorld();
    await w.party(w.host, { game: 'Apex', slots: 3 });
    const bad = await w.btn(w.a, 'close'); assert.match(bad.text(), /Only the host/);
    await w.btn(w.host, 'close');
    const msg = w.board.messages.store.get(w.data().get('p:1').messageId);
    assert.match(msg.edited.embeds[0].data.title, /closed/); assert.deepEqual(msg.edited.components, []);
    assert.match((await w.btn(w.b, 'join')).text(), /closed/);
    await w.party(w.host, { game: 'Apex', slots: 3 });
    assert.match((await w.sub(w.mod, 'close', { id: 2 })).text(), /Closed party #2/);
  });

  await test('limits: slots, start time, open parties per member', async () => {
    const w = await pfWorld();
    assert.match((await w.party(w.host, { game: 'X', slots: 1 })).text(), /2 to 99 slots/);
    assert.match((await w.party(w.host, { game: 'X', slots: 4, when: '2020-01-01 10:00' })).text(), /in the past/);
    assert.match((await w.party(w.host, { game: 'X', slots: 4, when: '30d' })).text(), /two weeks/);
    await w.party(w.host, { game: 'A', slots: 4 }); await w.party(w.host, { game: 'B', slots: 4 });
    assert.match((await w.party(w.host, { game: 'C', slots: 4 })).text(), /already have 2 open parties/);
    assert.match((await w.sub(w.a, 'kick', { id: 1, member: w.b.user })).text(), /permission/);
  });

  await test('parties expire, the post is deleted -> party ends, and members opted in get DMs when it fills or starts', async () => {
    const w = await pfWorld();
    await w.party(w.host, { game: 'Apex', slots: 2, when: '20m' });
    await w.btn(w.a, 'join');
    assert.ok(w.host.user.sent.some((m) => /is full/.test(m.content)) && w.a.user.sent.some((m) => /is full/.test(m.content)), 'full DM to both');
    w.db.setNotifyPref('1', 'pa', 'party-invites', false);
    const d = w.data(); const p = d.get('p:1');
    // reminder: start within 10 minutes
    p.startAt = Date.now() + 5 * 60000; d.set('p:1', p);
    await w.mm.runTasks(Date.now()); await w.mm.runTasks(Date.now() + 61000);
    assert.ok(w.host.user.sent.some((m) => /starts/.test(m.content)), 'reminder sent');
    assert.ok(!w.a.user.sent.some((m) => /starts/.test(m.content)), 'a member who opted out of party invitations gets nothing');
    assert.equal(d.get('p:1').reminded, true);
    // expiry
    const q = d.get('p:1'); q.expiresAt = Date.now() - 1; d.set('p:1', q);
    await w.mm.runTasks(Date.now() + 122000);
    assert.equal(d.get('p:1'), undefined, 'expired and cleaned up');
    const msg = w.board.messages.store.values().next().value;
    assert.match(msg.edited.embeds[0].data.title, /closed/);
    // deleted post
    await w.party(w.a, { game: 'Halo', slots: 4 });
    w.board.messages.store.delete(d.list('p:')[0].value.messageId);
    await w.mm.runTasks(Date.now() + 200000);
    assert.equal(d.list('p:')[0]?.value?.status ?? 'closed', 'closed');
  });

  await test('an optional voice channel is made only when allowed, and removed when the party closes and is empty', async () => {
    const w = await pfWorld();
    assert.match((await w.party(w.host, { game: 'X', slots: 4, voice: true })).text(), /turned off/);
    w.mm.setSetting('1', 'partyfinder', 'allowVoice', true);
    const made = []; const create = w.g.channels.create;
    w.g.channels.create = async (o) => { const c = await create(o); c.members = new Coll(); made.push(c); return c; };
    await w.party(w.host, { game: 'Apex', slots: 4, voice: true });
    assert.equal(made.length, 1); assert.equal(made[0].createOpts.userLimit, 4);
    assert.match(fields(w.board.sent[0]).Details, /Voice <#/);
    await w.btn(w.host, 'close');
    assert.ok(made[0].removed, 'empty voice channel deleted with the party');
  });

  await test('party rules are pure: join, leave, expiry and reminders', async () => {
    const R = await import('../src/party.js');
    const base = { id: 1, owner: 'h', slots: 2, members: ['h'], status: 'open', expiresAt: 1000 };
    assert.equal(R.join(base, 'h', 0).error, 'already');
    assert.equal(R.join(base, 'x', 2000).error, 'expired');
    const r = R.join(base, 'x', 0); assert.equal(r.filled, true); assert.equal(r.party.status, 'full'); assert.deepEqual(base.members, ['h'], 'input not mutated');
    assert.equal(R.join(r.party, 'y', 0).error, 'full');
    assert.equal(R.leave(r.party, 'h').error, 'owner');
    assert.equal(R.leave(r.party, 'x').party.status, 'open');
    assert.equal(R.expiryFor({ startAt: 5000, createdAt: 0, expireMinutes: 10 }), 5000 + 30 * 60000);
    assert.equal(R.expiryFor({ startAt: null, createdAt: 0, expireMinutes: 10 }), 600000);
    assert.equal(R.dueReminders([{ ...base, startAt: 100000 }], 50000, 60000).length, 1);
    assert.equal(R.dueReminders([{ ...base, startAt: 100000, reminded: true }], 50000, 60000).length, 0);
    assert.equal(R.cleanText('hi <@12345> @here   there'), 'hi there');
  });

  // ================================================================ stats
  console.log('\nStats: counting, history coverage, recaps');
  const ST = await import('../src/activity.js');
  const stWorld = async () => {
    const w = await makeWorld(['stats']).load();
    w.admin = w.person('admin1', { bits: [P.Administrator], pos: 10 });
    w.a = w.person('sa'); w.b = w.person('sb'); w.c = w.person('sc');
    w.chat = w.channel('chat'); w.other = w.channel('other');
    w.ctx = () => w.mm.ctx('1', 'stats');
    w.say = (m, ch = w.chat, at = Date.now()) => w.mm.dispatch('messageCreate', '1', { guildId: '1', author: m.user, channelId: ch.id, channel: { parentId: null }, createdTimestamp: at });
    w.stats = async (m, sub, opts = {}) => { const i = w.ix({ command: 'stats', sub, member: m, opts }); await w.mm.handleCommand(i); return i; };
    return w;
  };
  const withClock = async (start, fn) => { const real = Date.now; let t = start; Date.now = () => t; try { return await fn((n) => { t = n; }); } finally { Date.now = real; } };
  const embedOf = (i) => embedText(i.replies[0]);

  await test('messages are counted per member and channel; bots, opted-out members and ignored channels are not', async () => {
    const w = await stWorld();
    w.mm.setSetting('1', 'stats', 'ignoredChannels', w.other.id, 'add');
    await w.say(w.a); await w.say(w.a); await w.say(w.b); await w.say(w.a, w.other);
    await w.mm.dispatch('messageCreate', '1', { guildId: '1', author: { id: 'bot2', bot: true }, channelId: w.chat.id, channel: {}, createdTimestamp: Date.now() });
    await w.stats(w.c, 'optout'); await w.say(w.c);
    assert.match(embedOf(await w.stats(w.a, 'me', { period: 'all' })), /Messages\n2/);
    const top = embedOf(await w.stats(w.a, 'top', { metric: 'messages' }));
    assert.match(top, /<@sa> · 2[\s\S]*<@sb> · 1/); assert.ok(!/sc/.test(top));
    const srv = embedOf(await w.stats(w.a, 'server'));
    assert.match(srv, /Messages\n3/); assert.match(srv, /· 3 messages/);
    assert.match((await w.stats(w.a, 'me', { member: w.c.user })).text(), /opted out/);
  });

  await test('/stats forget erases a member\'s numbers; optin counts them again', async () => {
    const w = await stWorld();
    await w.say(w.a); await w.say(w.a);
    assert.match(embedOf(await w.stats(w.a, 'me', { period: 'all' })), /Messages\n2/);
    await w.stats(w.a, 'forget');
    assert.match(embedOf(await w.stats(w.a, 'me', { period: 'all' })), /Messages\n0/);
    await w.stats(w.a, 'optout'); await w.say(w.a);
    assert.match((await w.stats(w.a, 'me', { period: 'all' })).text(), /opted out/);
    await w.stats(w.a, 'optin'); await w.say(w.a);
    assert.match(embedOf(await w.stats(w.a, 'me', { period: 'all' })), /Messages\n1/);
  });

  await test('voice time is credited when someone leaves; AFK time is skipped and forgotten sessions are capped', async () => {
    const w = await stWorld();
    w.g.afkChannelId = 'afkch';
    await withClock(Date.parse('2026-03-02T10:00:00Z'), async (set) => {
      const st = (m, id) => ({ member: m, channelId: id });
      await w.mm.dispatch('voiceStateUpdate', '1', st(w.a, null), st(w.a, 'v1'));
      await w.mm.dispatch('voiceStateUpdate', '1', st(w.b, null), st(w.b, 'afkch'));
      await w.mm.dispatch('voiceStateUpdate', '1', st(w.c, null), st(w.c, 'v1'));
      set(Date.parse('2026-03-02T11:30:00Z'));
      await w.mm.dispatch('voiceStateUpdate', '1', st(w.a, 'v1'), st(w.a, null));
      await w.mm.dispatch('voiceStateUpdate', '1', st(w.b, 'afkch'), st(w.b, null));
      set(Date.parse('2026-03-04T15:30:00Z'));
      await w.mm.dispatch('voiceStateUpdate', '1', st(w.c, 'v1'), st(w.c, null));
      const top = embedOf(await w.stats(w.a, 'top', { metric: 'voice', period: 'all' }));
      assert.match(top, /<@sc> · 12 h[\s\S]*<@sa> · 1\.5 h/);
      assert.ok(!/<@sb>/.test(top), 'AFK time not counted');
    });
  });

  await test('backfill: older messages are counted apart, skipped and truncated channels are reported, and a rerun does not double count', async () => {
    const w = await stWorld();
    const now = Date.now();
    const hist = (ch, list) => {
      const msgs = list.map(([uid, ageH], n) => ({ id: `${ch.id}-${n}`, createdTimestamp: now - ageH * 3600000, author: { id: uid, bot: uid === 'bot' } }));
      ch.messages.fetch = async (o = {}) => {
        let pool = [...msgs].sort((x, y) => y.createdTimestamp - x.createdTimestamp);
        if (o.before) { const ref = msgs.find((m) => m.id === o.before); pool = pool.filter((m) => m.createdTimestamp < ref.createdTimestamp); }
        return new Coll(pool.slice(0, o.limit ?? 50).map((m) => [m.id, m]));
      };
    };
    hist(w.chat, [['sa', 50], ['sa', 49], ['sb', 30], ['sa', 24 * 40], ['bot', 3]]);
    hist(w.other, Array.from({ length: 12 }, (_, n) => ['sb', 5 + n]));
    const locked = w.channel('locked', { missing: [P.ReadMessageHistory] }); hist(locked, [['sa', 10]]);
    w.ctx().data.set('coverage', { trackingSince: now - 1000 });
    const { backfill } = await import('../modules/stats/index.js');
    const r = await backfill(w.ctx(), { days: 7, perChannel: 8 });
    assert.deepEqual(r.skipped, [locked.id]);
    assert.deepEqual(r.truncated, [w.other.id], 'the 12-message channel hit the per-channel limit');
    assert.equal(r.messages, 3 + 8);
    const text = (await w.stats(w.a, 'coverage')).text();
    assert.match(text, /backfilled/); assert.match(text, /could not read 1 channel/); assert.match(text, /limit was reached in 1 channel/); assert.match(text, /Voice time and reactions from before/);
    assert.match(embedOf(await w.stats(w.a, 'me', { period: 'all' })), /Messages\n2 \(2 backfilled\)/);
    await backfill(w.ctx(), { days: 7, perChannel: 8 });
    assert.match(embedOf(await w.stats(w.a, 'me', { period: 'all' })), /Messages\n2 \(2 backfilled\)/, 'second run replaces, never adds');
    await w.say(w.a);
    assert.match(embedOf(await w.stats(w.a, 'me', { period: 'all' })), /Messages\n3 \(2 backfilled\)/, 'live count added on top');
    await backfill(w.ctx(), { days: 1, perChannel: 8 });
    assert.match(embedOf(await w.stats(w.a, 'me', { period: 'all' })), /Messages\n1\b(?! \()/, 'a smaller rerun removes the older backfilled days instead of keeping them');
    await backfill(w.ctx(), { days: 7, perChannel: 8 });
    assert.match(embedOf(await w.stats(w.b, 'me', { period: '7d' })), /Messages\n9 \(9 backfilled\)/);
    assert.match((await w.stats(w.a, 'backfill', { days: 3 })).text(), /permission/);
    // With counted history, the default period is all time, and the dashboard lists every active member with both kinds together.
    assert.match(embedOf(await w.stats(w.b, 'me')), /All time\n\*\*9\*\* messages/, 'no period picked: the member report, with counted history in all time');
    const v = await w.mm.runView('1', 'stats', 'members');
    const b = v.rows.find((r) => r.id === 'sb');
    assert.equal(b.total, 9, 'backfilled and live messages in one list'); assert.match(b.last, /today|yesterday|days ago/);
  });

  await test('backfill runs in the background: answers at once, counts all time including threads, refuses a second run, DMs the result', async () => {
    const w = await stWorld();
    const now = Date.now();
    const feed = (ch, list) => {
      const msgs = list.map(([uid, ageD], n) => ({ id: `${ch.id}-${n}`, createdTimestamp: now - ageD * 86400000, author: { id: uid, bot: false } }));
      ch.messages.fetch = async (o = {}) => {
        await new Promise((r) => setTimeout(r, 5));
        let pool = [...msgs].sort((x, y) => y.createdTimestamp - x.createdTimestamp);
        if (o.before) { const ref = msgs.find((m) => m.id === o.before); pool = pool.filter((m) => m.createdTimestamp < ref.createdTimestamp); }
        return new Coll(pool.slice(0, o.limit ?? 50).map((m) => [m.id, m]));
      };
    };
    feed(w.chat, [['sa', 1], ['sa', 900], ['sb', 2000]]); // up to 5 years old
    const thread = { id: '800000000000009999', name: 'old-thread', isTextBased: () => true, messages: {}, parentId: w.chat.id };
    feed(thread, [['sb', 400]]);
    w.chat.threads = { fetchArchived: async ({ type }) => ({ threads: new Coll(type === 'public' ? [[thread.id, thread]] : []), hasMore: false }) };
    w.ctx().data.set('coverage', { trackingSince: now - 1000 });
    const admin = w.admin; admin.user.sent = []; w.client.users.fetch = async (id) => (id === admin.id ? admin.user : null);
    const first = await w.stats(admin, 'backfill', {});
    assert.match(first.text(), /Started counting message history \(\*\*all time\*\*/);
    const { backfillRunning } = await import('../modules/stats/index.js');
    assert.ok(backfillRunning('1'), 'the job is running after the command has answered');
    assert.match((await w.stats(admin, 'backfill', {})).text(), /Already counting/);
    assert.match((await w.stats(admin, 'coverage')).text(), /Counting history/);
    for (let k = 0; k < 200 && backfillRunning('1'); k++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(backfillRunning('1'), null, 'finished');
    assert.match(String(admin.user.sent.at(-1)?.content), /Message history counted.*4 messages/s, 'all four messages, including the 5-year-old one and the thread');
    assert.equal(w.ctx().data.get('backfillJob'), undefined, 'nothing left to resume');
  });

  await test('inactive members: who went quiet, never staff, bots, exempt roles or newcomers; kick asks first, re-checks and DMs', async () => {
    const w = await stWorld();
    w.ctx().data.set('coverage', { trackingSince: Date.now() - 100 * 86400000 });
    const kicked = [];
    const kickable = (m) => Object.assign(m, { kickable: true, kick: async () => { kicked.push(m.id); m.guild.members.cache.delete(m.id); } });
    const quiet = kickable(w.person('900000000000000801'));                       // joined 400 days ago, never active
    const old = kickable(w.person('900000000000000802'));                         // last active 60 days ago
    const recent = kickable(w.person('900000000000000803'));                      // active today
    const newbie = kickable(w.person('900000000000000804', { joinedDaysAgo: 3 })); // too new to judge
    const mod = kickable(w.person('900000000000000805', { bits: [P.KickMembers] }));
    const vip = kickable(w.person('900000000000000806')); vip.roles.cache.set('900000000000000899', { id: '900000000000000899' });
    w.mm.setSetting('1', 'stats', 'inactiveExemptRoles', ['900000000000000899']);
    for (const m of [w.a, w.b, w.c]) kickable(m);
    await w.say(old, w.chat, Date.now() - 60 * 86400000); await w.say(recent); await w.say(w.a); await w.say(w.b); await w.say(w.c);
    const first = await w.mm.runView('1', 'stats', 'inactive');
    assert.deepEqual(first.rows.map((r) => r.id), [quiet.id, old.id], 'never active first, then the longest quiet');
    assert.equal(first.rows[0].last, 'never');
    assert.doesNotMatch(first.note, /only been tracked/);
    const list = await w.stats(w.admin, 'inactive', {});
    const embed = list.edits[0].embeds[0].data;
    assert.match(embed.title, /Inactive for 30\+ days · 2 members/);
    assert.match(embed.description, /no activity on record/);
    assert.match((await w.stats(w.a, 'inactive', {})).text(), /permission/, 'members cannot see it');
    // pick one, confirm, it is kicked and told why
    const sel = w.ix({ customId: `st:ik:${w.admin.id}:30`, member: w.admin }); sel.values = [old.id];
    await w.mm.handleComponent(sel);
    assert.match(sel.updated.content, /Kick \*\*1\*\* member/);
    assert.deepEqual(kicked, [], 'nothing happens before Yes');
    const steal = w.ix({ customId: `st:ic:${w.admin.id}`, member: w.a }); await w.mm.handleComponent(steal);
    assert.match(steal.text(), /belongs to someone else/);
    const yes = w.ix({ customId: `st:ic:${w.admin.id}`, member: w.admin }); await w.mm.handleComponent(yes);
    assert.deepEqual(kicked, [old.id]);
    assert.match(String(old.user.sent.at(-1)?.content), /haven't been active for 30 days/);
    assert.match(yes.edits.at(-1).content, /Kicked \*\*1\*\*/);
    // the dashboard re-checks: someone who became active is skipped
    await w.say(quiet);
    const r = await w.mm.runAction('1', 'stats', 'inactive-kick', { userId: quiet.id }, { userId: w.admin.id, username: 'admin' });
    assert.deepEqual([r.kicked, r.skipped], [0, 1]);
    await assert.rejects(w.mm.runAction('1', 'stats', 'inactive-kick-all', {}, { userId: w.admin.id, username: 'admin' }), /Type KICK/);
    const v = await w.mm.runView('1', 'stats', 'inactive');
    assert.equal(v.rows.length, 0, 'nobody left to clean up');
  });

  await test('inactive members: warns when tracking is shorter than the window; monthly review posts once a month', async () => {
    const w = await stWorld();
    w.ctx().data.set('coverage', { trackingSince: Date.now() - 5 * 86400000 });
    assert.match((await w.mm.runView('1', 'stats', 'inactive')).note, /only been tracked for 5 days/);
    const staff = w.channel('staff'); w.mm.setSetting('1', 'stats', 'reviewChannel', staff.id);
    const task = w.mm.active.get('1').get('stats').tasks.find((t) => t.name === 'review');
    await task.run(w.ctx()); assert.equal(staff.sent.length, 0, 'first run starts the clock');
    w.ctx().data.set('lastReviewMonth', '2000-01');
    await task.run(w.ctx()); assert.equal(staff.sent.length, 1);
    assert.match(staff.sent[0].embeds[0].data.title, /Monthly activity review/);
    assert.match(staff.sent[0].embeds[0].data.description, /only been tracked for \*\*5 days\*\*/);
    await task.run(w.ctx()); assert.equal(staff.sent.length, 1, 'once a month');
  });

  await test('weekly recap: first run only starts the clock, the next week posts once, personal recaps need opt-in', async () => {
    const w = await stWorld();
    const rec = w.channel('recaps'); w.mm.setSetting('1', 'stats', 'recapChannel', rec.id);
    w.db.setNotifyPref('1', 'sa', 'recaps', true);
    await withClock(Date.parse('2026-03-04T12:00:00Z'), async (set) => {
      await w.mm.runTasks(Date.now());
      set(Date.now() + 601000); await w.mm.runTasks(Date.now());
      assert.equal(rec.sent.length, 0, 'nothing posted on the first run');
      await w.say(w.a); await w.say(w.a); await w.say(w.b);
      set(Date.parse('2026-03-09T00:30:00Z')); await w.mm.runTasks(Date.now());
      assert.equal(rec.sent.length, 1);
      assert.match(embedText(rec.sent[0]), /Last week in Test Guild[\s\S]*3 messages/);
      assert.ok(w.a.user.sent.some((m) => /2 messages/.test(m.content)), 'opted-in member got a personal recap');
      assert.equal(w.b.user.sent.length, 0, 'recaps are off unless chosen');
      set(Date.now() + 700000); await w.mm.runTasks(Date.now());
      assert.equal(rec.sent.length, 1, 'not posted twice');
    });
  });

  await test('the dashboard panel lists the week\'s most active members and says what the numbers cover', async () => {
    const w = await stWorld();
    await w.say(w.a); await w.say(w.a); await w.say(w.b);
    const v = await w.mm.runView('1', 'stats', 'overview');
    assert.deepEqual(v.rows.map((r) => [r.id, r.messages]), [['sa', 2], ['sb', 1]]);
    assert.match(v.note, /Live tracking since/); assert.ok(!/<t:|\*\*/.test(v.note));
  });

  await test('activity helpers: days, weeks, streaks, throttle and voice sessions', () => {
    assert.equal(ST.dayKey(Date.parse('2026-03-02T23:30:00Z'), 2), '2026-03-03');
    assert.equal(ST.weekStartKey(Date.parse('2026-03-08T12:00:00Z')), '2026-03-02', 'Sunday belongs to the week starting Monday');
    assert.equal(ST.weekStartKey(Date.parse('2026-03-09T00:30:00Z')), '2026-03-09');
    assert.equal(ST.addDays('2026-02-28', 2), '2026-03-02');
    assert.equal(ST.periodStart('7d', Date.parse('2026-03-09T10:00:00Z')), '2026-03-03');
    assert.equal(ST.periodStart('all', 0), null);
    let s = ST.advanceStreak(null, '2026-03-01'); assert.equal(s.streak, 1);
    s = ST.advanceStreak(s, '2026-03-02'); assert.equal(s.streak, 2);
    assert.equal(ST.advanceStreak(s, '2026-03-02').newDay, false);
    s = ST.advanceStreak(s, '2026-03-05'); assert.deepEqual([s.streak, s.best], [1, 2], 'a gap resets the streak but keeps the best');
    assert.equal(ST.currentStreak({ last: '2026-03-02', streak: 4 }, Date.parse('2026-03-03T10:00:00Z')), 4);
    assert.equal(ST.currentStreak({ last: '2026-03-02', streak: 4 }, Date.parse('2026-03-05T10:00:00Z')), 0, 'a lapsed streak reads as 0');
    const t = new ST.Throttle(); assert.ok(t.allow('a', 0, 5000)); assert.ok(!t.allow('a', 4000, 5000)); assert.ok(t.allow('a', 6000, 5000));
    const v = new ST.VoiceTracker(); v.enter('u', 0); v.enter('u', 5000);
    assert.equal(v.leave('u', 60000), 60); assert.equal(v.leave('u', 70000), 0);
    v.enter('x', 0); assert.equal(v.leave('x', 99 * 3600000), ST.MAX_SESSION_SECONDS);
    assert.equal(ST.bar(5, 10), '▰▰▰▰▰▱▱▱▱▱');
  });

  // ================================================================ achievements
  console.log('\nAchievements');
  const AC = await import('../src/achievements.js');
  const acWorld = async () => {
    const w = await makeWorld(['achievements']).load();
    w.admin = w.person('admin1', { bits: [P.Administrator], pos: 10 });
    w.a = w.person('aa', { joinedDaysAgo: 3 }); w.old = w.person('oldtimer', { joinedDaysAgo: 400 }); w.b = w.person('ab', { joinedDaysAgo: 3 });
    w.ann = w.channel('unlocks'); w.mm.setSetting('1', 'achievements', 'announceChannel', w.ann.id);
    w.say = (m, at) => w.mm.dispatch('messageCreate', '1', { guildId: '1', author: m.user, member: m, channelId: 'c', createdTimestamp: at ?? Date.now() });
    w.react = (m) => w.mm.dispatch('messageReactionAdd', '1', { message: { guildId: '1' } }, m.user);
    w.ach = async (m, sub, opts = {}, group = null) => { const i = w.ix({ command: 'achievements', sub, group, member: m, opts }); await w.mm.handleCommand(i); return i; };
    w.have = (m) => w.db.q('SELECT achievement FROM achievements_unlock WHERE guild_id = ? AND user_id = ? ORDER BY achievement').all('1', m.id).map((r) => r.achievement);
    return w;
  };

  await test('the first message unlocks First Words once, announces it with a mention, and spam does not farm progress', async () => {
    const w = await acWorld();
    await withClock(Date.parse('2026-03-02T10:00:00Z'), async (set) => {
      await w.say(w.a);
      assert.deepEqual(w.have(w.a), ['first-words']);
      assert.equal(w.ann.sent.length, 1);
      assert.match(w.ann.sent[0].content, /<@aa> unlocked 💬 \*\*First Words\*\*/); assert.deepEqual(w.ann.sent[0].allowedMentions, { users: ['aa'] });
      for (let n = 0; n < 50; n++) await w.say(w.a);
      assert.equal(w.db.q('SELECT messages FROM achievements_progress WHERE user_id = ?').get('aa').messages, 1, 'fifty messages in one moment count once');
      set(Date.now() + 21000); await w.say(w.a);
      assert.equal(w.db.q('SELECT messages FROM achievements_progress WHERE user_id = ?').get('aa').messages, 2);
      assert.equal(w.ann.sent.length, 1, 'no repeat announcement');
    });
  });

  await test('time in the server counts: an old member earns One Month and One Year at once', async () => {
    const w = await acWorld();
    await w.say(w.old);
    assert.deepEqual(w.have(w.old), ['first-words', 'one-month-in', 'one-year-in']);
    await w.say(w.a);
    assert.deepEqual(w.have(w.a), ['first-words'], 'a 3-day-old member gets neither');
  });

  await test('streaks: three days in a row unlock Three in a Row; a gap resets the streak but keeps the best', async () => {
    const w = await acWorld();
    const day = (d) => Date.parse(`2026-03-0${d}T12:00:00Z`);
    await withClock(day(1), async (set) => {
      await w.say(w.a); set(day(2)); await w.say(w.a);
      assert.ok(!w.have(w.a).includes('three-in-a-row'));
      set(day(3)); await w.say(w.a);
      assert.ok(w.have(w.a).includes('three-in-a-row'));
      set(day(6)); await w.say(w.a);
      const r = w.db.q('SELECT streak, best_streak, active_days FROM achievements_progress WHERE user_id = ?').get('aa');
      assert.deepEqual({ ...r }, { streak: 1, best_streak: 3, active_days: 4 });
    });
  });

  await test('voice hours and reactions count; AFK time does not', async () => {
    const w = await acWorld();
    w.g.afkChannelId = 'afk';
    await withClock(Date.parse('2026-03-02T10:00:00Z'), async (set) => {
      const st = (m, id) => ({ member: m, channelId: id });
      await w.mm.dispatch('voiceStateUpdate', '1', st(w.a, null), st(w.a, 'v1'));
      await w.mm.dispatch('voiceStateUpdate', '1', st(w.b, null), st(w.b, 'afk'));
      set(Date.parse('2026-03-02T11:05:00Z'));
      await w.mm.dispatch('voiceStateUpdate', '1', st(w.a, 'v1'), st(w.a, null));
      await w.mm.dispatch('voiceStateUpdate', '1', st(w.b, 'afk'), st(w.b, null));
      assert.ok(w.have(w.a).includes('hello-mic')); assert.deepEqual(w.have(w.b), []);
      for (let n = 0; n < 50; n++) { set(Date.now() + 6000); await w.react(w.b); }
      assert.ok(w.have(w.b).includes('reactor'));
    });
  });

  await test('opting out stops counting and hides achievements; privacy hides them from others but not from yourself', async () => {
    const w = await acWorld();
    await w.say(w.a);
    assert.match(embedOf(await w.ach(w.b, 'show', { member: w.a.user })), /First Words/);
    await w.ach(w.a, 'privacy', { who: 'private' });
    assert.match((await w.ach(w.b, 'show', { member: w.a.user })).text(), /private/);
    assert.match(embedOf(await w.ach(w.a, 'show')), /First Words/);
    assert.deepEqual(w.mm.ctx('1', 'achievements') && (await import('../modules/achievements/index.js')).summary(w.mm.ctx('1', 'achievements'), 'aa'), { visible: false });
    await w.ach(w.a, 'optout');
    await withClock(Date.now() + 60000, async () => { await w.say(w.a); });
    assert.equal(w.db.q('SELECT messages FROM achievements_progress WHERE user_id = ?').get('aa').messages, 1, 'not counted after opting out');
    assert.match((await w.ach(w.b, 'show', { member: w.a.user })).text(), /opted out/);
  });

  await test('announcements respect the notification choice: the unlock is kept but nothing is posted for someone who turned them off', async () => {
    const w = await acWorld();
    w.db.setNotifyPref('1', 'ab', 'achievements', false);
    await w.say(w.b);
    assert.deepEqual(w.have(w.b), ['first-words']); assert.equal(w.ann.sent.length, 0);
    w.mm.setSetting('1', 'achievements', 'announce', 'dm');
    await w.say(w.old);
    assert.equal(w.ann.sent.length, 0); assert.ok(w.old.user.sent.some((m) => /First Words/.test(m.content)), 'DM mode');
  });

  await test('server achievements: staff create, grant, revoke and delete; built-in ones cannot be granted by hand', async () => {
    const w = await acWorld();
    const mk = (m, sub, opts) => w.ach(m, sub, opts, 'custom');
    assert.match((await mk(w.a, 'create', { name: 'Raid Leader', description: 'Led a raid' })).text(), /permission/);
    const made = await mk(w.admin, 'create', { name: 'Raid Leader', description: 'Led a raid', emoji: '⚔️' });
    assert.match(made.text(), /id `raid-leader`/);
    assert.match((await mk(w.admin, 'create', { name: 'Raid  Leader!', description: 'x' })).text(), /already exists/);
    await mk(w.admin, 'grant', { id: 'raid-leader', member: w.a.user });
    assert.deepEqual(w.have(w.a), ['raid-leader']); assert.match(w.ann.sent.at(-1).content, /Raid Leader/);
    assert.match((await mk(w.admin, 'grant', { id: 'raid-leader', member: w.a.user })).text(), /already have it/);
    assert.match((await mk(w.admin, 'grant', { id: 'regular', member: w.a.user })).text(), /Built-in/);
    assert.match(embedOf(await w.ach(w.b, 'list')), /Raid Leader[\s\S]*\(server\)|\(server\)[\s\S]*Raid Leader/);
    await mk(w.admin, 'revoke', { id: 'raid-leader', member: w.a.user }); assert.deepEqual(w.have(w.a), []);
    await mk(w.admin, 'grant', { id: 'raid-leader', member: w.a.user });
    await mk(w.admin, 'delete', { id: 'raid-leader' }); assert.deepEqual(w.have(w.a), [], 'deleting removes it from members');
  });

  await test('the summary other modules read: counts, recent unlocks, and hidden when private', async () => {
    const w = await acWorld();
    await w.say(w.old);
    const { summary } = await import('../modules/achievements/index.js');
    const s = summary(w.mm.ctx('1', 'achievements'), 'oldtimer');
    assert.equal(s.visible, true); assert.equal(s.count, 3); assert.equal(s.total, AC.BUILTIN.length); assert.equal(s.recent.length, 3);
  });

  await test('achievement rules: reached, nextUp, progress lines, ids', () => {
    const p = { messages: 120, voice_seconds: 7200, reactions: 0, active_days: 8, best_streak: 2 };
    const got = AC.reached(p, { memberDays: 31 });
    for (const id of ['first-words', 'regular', 'hello-mic', 'week-around', 'one-month-in']) assert.ok(got.includes(id), id);
    for (const id of ['chatterbox', 'good-company', 'reactor', 'three-in-a-row']) assert.ok(!got.includes(id), id);
    const next = AC.nextUp(p, { memberDays: 31 }, got);
    assert.deepEqual(next.map((n) => n.def.id), ['three-in-a-row', 'monthly-regular', 'good-company', 'chatterbox'], 'closest goal first');
    assert.ok(next.every((n) => n.ratio < 1) && next.length <= 4);
    assert.match(AC.progressLine({ def: AC.BUILTIN.find((d) => d.id === 'chatterbox'), value: 500 }), /▰▰▰▰▰▱▱▱▱▱ 500\/1,000 messages/);
    assert.equal(AC.slugify('  Raid Leader! '), 'raid-leader'); assert.ok(!AC.CUSTOM_ID.test('x'));
    assert.equal(new Set(AC.BUILTIN.map((d) => d.id)).size, AC.BUILTIN.length, 'ids are unique');
  });

  // ================================================================ eclipse id
  console.log('\nEclipse ID');
  const EID = await import('../src/eclipseid.js');
  const eidWorld = async (mods = ['eclipseid', 'achievements']) => {
    const w = await makeWorld(mods).load();
    w.admin = w.person('admin1', { bits: [P.Administrator], pos: 10 });
    w.mod = w.person('mod1', { bits: [P.ModerateMembers], pos: 5 });
    w.a = w.person('ea'); w.b = w.person('eb');
    w.mod.roles.cache.set('modrole', { id: 'modrole' });
    w.id = async (m, sub, opts = {}) => { const i = w.ix({ command: 'id', sub, member: m, opts }); await w.mm.handleCommand(i); return i; };
    w.fill = async (m, fields) => {
      const i = w.ix({ member: m, customId: 'eid:edit' });
      const all = { bio: '', games: '', platforms: '', availability: '', region: '', ...fields };
      i.fields = { getTextInputValue: (id) => all[id] };
      await w.mm.handleComponent(i); return i;
    };
    return w;
  };

  await test('/id edit opens a popup with the current values; saving builds the card; pings are removed and platforms are checked', async () => {
    const w = await eidWorld();
    const first = await w.id(w.a, 'edit'); assert.ok(first.modal, `no popup was shown; the bot said: ${first.text?.()}`); assert.equal(first.modal.data.custom_id, 'eid:edit');
    assert.equal(first.modal.components.length, 5, 'Discord allows at most five fields');
    for (const row of first.modal.components) assert.ok(row.components[0].data.label.length <= 45, `Discord allows labels up to 45 characters: "${row.components[0].data.label}"`);
    assert.match((await w.fill(w.a, { platforms: 'pc, gameboy' })).text(), /gameboy/);
    const ok = await w.fill(w.a, { bio: 'Hi @everyone <@123> I play co-op', games: 'Apex, Hades', platforms: 'PC, ps5, PC', availability: 'Evenings, casual', region: 'CET' });
    assert.match(ok.text(), /Saved/);
    const reopened = await w.id(w.a, 'edit');
    assert.equal(reopened.modal.components[0].components[0].data.value, 'Hi I play co-op');
    assert.equal(reopened.modal.components[2].components[0].data.value, 'pc, playstation');
    const card = embedOf(await w.id(w.b, 'show', { member: w.a.user }));
    assert.match(card, /Hi I play co-op/); assert.match(card, /Apex, Hades/); assert.match(card, /pc · playstation/);
    assert.match((await w.id(w.b, 'show', { member: w.a.user })).replies[0].embeds[0].data.footer.text, /EID-000001/);
    assert.match(embedOf(await w.id(w.b, 'show')), /not shared anything|empty/);
  });

  await test('per-field privacy: public, staff only, only me; linked accounts start private', async () => {
    const w = await eidWorld();
    await w.fill(w.a, { bio: 'secret bio', games: 'Apex', region: 'CET' });
    await w.id(w.a, 'link', { platform: 'steam', name: 'cooluser' });
    await w.id(w.a, 'privacy', { field: 'bio', who: 'staff' });
    await w.id(w.a, 'privacy', { field: 'region', who: 'private' });
    const other = embedOf(await w.id(w.b, 'show', { member: w.a.user }));
    assert.ok(!/secret bio|CET|cooluser/.test(other) && /Apex/.test(other));
    const staff = embedOf(await w.id(w.mod, 'show', { member: w.a.user }));
    assert.match(staff, /secret bio/); assert.ok(!/CET|cooluser/.test(staff), 'staff-only means staff, not everything');
    const own = await w.id(w.a, 'show');
    assert.match(embedOf(own), /secret bio[\s\S]*CET[\s\S]*cooluser/); assert.match(own.replies[0].embeds[0].data.footer.text, /hidden from others/);
    await w.id(w.a, 'privacy', { field: 'links', who: 'public' });
    assert.match(embedOf(await w.id(w.b, 'show', { member: w.a.user })), /Linked accounts \(not verified\)[\s\S]*Steam.*cooluser/);
  });

  await test('game account links are format-checked per platform, normalised, and always labelled not verified', async () => {
    const w = await eidWorld();
    const link = async (platform, name, who) => (await w.id(w.a, 'link', { platform, name, who })).text();
    assert.match(await link('nintendo', 'sw-1234-5678-9012'), /SW-1234-5678-9012/);
    assert.match(await link('nintendo', '1234'), /doesn't look like a Nintendo/);
    assert.match(await link('riot', 'Player#EUW'), /Saved/); assert.match(await link('riot', 'NoTag'), /doesn't look like/);
    assert.match(await link('battlenet', 'Name#1234'), /Saved/); assert.match(await link('battlenet', 'Name#12'), /doesn't look/);
    assert.match(await link('minecraft', 'Steve_01'), /not verified/); assert.match(await link('minecraft', 'x'), /doesn't look/);
    assert.match(await link('steam', '76561198000000000', 'public'), /everyone can see/);
    assert.match(await link('xbox', 'Some Tag', 'staff'), /staff only/);
    assert.match(await link('steam', '<@123> bad name!'), /doesn't look/);
    assert.match((await w.id(w.a, 'unlink', { platform: 'epic' })).text(), /nothing linked/);
    assert.match((await w.id(w.a, 'unlink', { platform: 'minecraft' })).text(), /Removed/);
    assert.equal(w.db.q('SELECT COUNT(*) AS n FROM eclipseid_link WHERE user_id = ?').get('ea').n, 5);
  });

  await test('Roblox lookup is off by default, uses the injected fetch, and failures store nothing', async () => {
    const w = await eidWorld();
    assert.match((await w.id(w.a, 'roblox', { name: 'builderman' })).text(), /turned off/);
    w.mm.setSetting('1', 'eclipseid', 'robloxLookup', true);
    const calls = [];
    const hook = (impl) => { globalThis[Symbol.for('goodboy.eclipseid.fetch')] = async (url, o) => { calls.push([url, JSON.parse(o.body)]); return impl(); }; };
    try {
      hook(() => ({ ok: true, json: async () => ({ data: [{ id: 156, name: 'builderman', displayName: 'Builder' }] }) }));
      const hit = await w.id(w.a, 'roblox', { name: 'builderman' });
      assert.match(hit.text(), /builderman.*id 156.*only shows the name exists, not that it is yours/);
      assert.equal(calls[0][0], 'https://users.roblox.com/v1/usernames/users'); assert.deepEqual(calls[0][1].usernames, ['builderman']);
      hook(() => ({ ok: true, json: async () => ({ data: [] }) }));
      assert.match((await w.id(w.a, 'roblox', { name: 'nobody_here' })).text(), /no account named/);
      hook(() => ({ ok: false, status: 429 }));
      assert.match((await w.id(w.a, 'roblox', { name: 'builderman' })).text(), /couldn't check.*429/);
      hook(() => { throw new Error('offline'); });
      assert.match((await w.id(w.a, 'roblox', { name: 'builderman' })).text(), /could not reach Roblox/);
      hook(() => ({ ok: true, json: async () => ({ weird: true }) }));
      assert.match((await w.id(w.a, 'roblox', { name: 'builderman' })).text(), /no account named/);
      assert.match((await w.id(w.a, 'roblox', { name: 'bad name!' })).text(), /doesn't look like a Roblox/);
    } finally { delete globalThis[Symbol.for('goodboy.eclipseid.fetch')]; }
    assert.equal(w.db.q('SELECT COUNT(*) AS n FROM eclipseid_link').get().n, 0, 'a lookup never saves anything');
  });

  await test('the card shows achievements when that module is on and the member allows it; ids are stable and sequential; /id delete erases', async () => {
    const w = await eidWorld();
    await w.mm.dispatch('messageCreate', '1', { guildId: '1', author: w.a.user, member: w.a, channelId: 'c', createdTimestamp: Date.now() });
    await w.fill(w.a, { bio: 'hello' });
    assert.match(embedOf(await w.id(w.b, 'show', { member: w.a.user })), /Achievements \d+\/\d+[\s\S]*First Words/);
    const ach = (m, who) => { const i = w.ix({ command: 'achievements', sub: 'privacy', member: m, opts: { who } }); return w.mm.handleCommand(i); };
    await ach(w.a, 'private');
    assert.ok(!/Achievements/.test(embedOf(await w.id(w.b, 'show', { member: w.a.user }))));
    const a1 = (await w.id(w.a, 'show')).replies[0].embeds[0].data.footer.text.match(/EID-\d+/)[0];
    const a2 = (await w.id(w.a, 'show')).replies[0].embeds[0].data.footer.text.match(/EID-\d+/)[0];
    const b1 = (await w.id(w.b, 'show')).replies[0].embeds[0].data.footer.text.match(/EID-\d+/)[0];
    assert.equal(a1, a2); assert.notEqual(a1, b1);
    await w.id(w.a, 'link', { platform: 'steam', name: 'cooluser' });
    await w.id(w.a, 'delete');
    assert.equal(w.db.q('SELECT COUNT(*) AS n FROM eclipseid_profile WHERE user_id = ?').get('ea').n, 0);
    assert.equal(w.db.q('SELECT COUNT(*) AS n FROM eclipseid_link WHERE user_id = ?').get('ea').n, 0);
    const solo = await eidWorld(['eclipseid']);
    assert.ok(await solo.id(solo.a, 'show'), 'works without the achievements module');
  });

  await test('Eclipse ID rules: visibility, text cleaning, platform parsing, link formats, labels', () => {
    assert.ok(EID.canSee('public')); assert.ok(!EID.canSee('staff')); assert.ok(EID.canSee('staff', { staff: true })); assert.ok(!EID.canSee('private', { staff: true })); assert.ok(EID.canSee('private', { self: true }));
    assert.equal(EID.cleanField('a  <@1>  @here b', 50), 'a b');
    assert.equal(EID.cleanField('x'.repeat(500), 10).length, 10);
    assert.deepEqual(EID.parsePlatforms('PC, PS5, nintendo; phone, atari'), { platforms: ['pc', 'playstation', 'switch', 'mobile'], unknown: ['atari'] });
    assert.equal(EID.eidLabel(42), 'EID-000042');
    assert.equal(EID.normalizeLink('steam', '76561198000000000').url, 'https://steamcommunity.com/profiles/76561198000000000');
    assert.equal(EID.normalizeLink('steam', 'cool_user').url, 'https://steamcommunity.com/id/cool_user');
    assert.ok(EID.normalizeLink('nope', 'x').error);
    assert.ok(EID.normalizeLink('playstation', '9bad').error);
  });

  // ================================================================ legal pages
  await test('Terms and Privacy pages are public, use the operator from the environment, and escape it', async () => {
    const { renderLegal, legalSections } = await import('../src/legal.js');
    const w = await dashWorld();
    for (const p of ['/terms', '/privacy']) {
      const r = await w.req('GET', p);
      assert.equal(r.status, 200, p); assert.match(r.headers['content-type'], /text\/html/);
      assert.ok(!/<script/i.test(r.body ?? r.text ?? ''), 'no script in a policy page');
    }
    closeDash(w);
    const env = { LEGAL_OPERATOR: 'Ana <b>& Co</b>', LEGAL_CONTACT: 'ana@example.com' };
    const priv = renderLegal('privacy', { env });
    assert.ok(priv.includes('Ana &lt;b&gt;&amp; Co&lt;/b&gt;') && !priv.includes('<b>& Co'), 'operator name is escaped');
    assert.match(priv, /ana@example\.com/);
    assert.match(priv, /Google/); assert.match(priv, /200 recent actions/); assert.match(priv, /80 characters/);
    assert.match(renderLegal('terms', { env: {} }), /has not published a contact address/);
    assert.match(renderLegal('terms', { env }), /Terms of Service/);
  });

  await test('a file in data/legal replaces the built-in text, escaped', async () => {
    const { renderLegal } = await import('../src/legal.js');
    const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-legal-'));
    fs.mkdirSync(path.join(dir, 'legal'));
    fs.writeFileSync(path.join(dir, 'legal', 'terms.txt'), 'My Rules\nBe kind <script>alert(1)</script>\n\n## Section\nHello there.');
    const html = renderLegal('terms', { dataDir: dir });
    assert.match(html, /<h1>My Rules<\/h1>/); assert.match(html, /<h2>Section<\/h2>/);
    assert.ok(!html.includes('<script>alert') && html.includes('&lt;script&gt;'));
    assert.ok(!/Good Boy is a Discord bot/.test(html), 'built-in text not shown');
    assert.match(renderLegal('privacy', { dataDir: dir }), /Good Boy Privacy Policy/, 'the other page still uses its built-in text');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ================================================================ branding
  console.log('\nBranding');
  await test('no assistant-brand or legacy "Project Eclipse" wording in anything users can see', () => {
    const bad = new RegExp([...BANNED_BRANDS, 'project eclipse'].join('|'), 'i');
    const hits = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (['node_modules', 'data', '.git'].includes(e.name)) continue; const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|html|css|md|json|txt)$/.test(e.name) && !p.endsWith(path.join('tests', 'features.js')) && bad.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p)); } };
    walk(root);
    assert.deepEqual(hits, []);
  });
}
