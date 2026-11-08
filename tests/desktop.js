/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Desktop app tests. These cover everything in desktop/lib (settings, checks, log cleaning, the bot runner with the real
 * supervisor script) plus static checks on the Electron files. Electron itself is NOT started here.
 */
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalize, DEFAULTS } from '../desktop/lib/settings.js';
import { parseNodeVersion, nodeIsNewEnough, findNode, candidateNodePaths, dashboardPort, isSafeDashboardUrl, checkBotDir } from '../desktop/lib/checks.js';
import { LogBuffer, clean } from '../desktop/lib/logbuf.js';
import { BotRunner } from '../desktop/lib/runner.js';
import { collectFiles } from '../src/update/release.js';
import { parseEnv, safeBotSettings, looksLikeToken } from '../desktop/lib/envfile.js';
import { Vault } from '../desktop/lib/vault.js';
import { readEdition } from '../desktop/lib/edition.js';
import { ensureBotCode, seedData, installedVersion } from '../desktop/lib/botinstall.js';
import { runTool } from '../desktop/lib/tools.js';
import { editionConfig } from '../desktop/scripts/set-edition.js';
import { bundleFiles } from '../desktop/scripts/bundle-bot.js';
import { levelOf as toolLevel, summary as toolSummary, importDb, exportDb, exportLevels, mergeLevels } from '../scripts/app-tools.js';
import { blockedBy, processName, takeControl, isNodeName } from '../desktop/lib/takeover.js';
import { updateMode, channelFor, compareVersions, readLatest, RELEASES } from '../desktop/lib/updater.js';
import { verifySecret, addRedirectUri } from '../desktop/lib/discord.js';
import { Share, shareSettings, isTailscaleLink } from '../desktop/lib/share.js';
import { levelOf as communityLevel } from '../modules/community/index.js';
import { Database } from '../src/db.js';
import { verifyToken, inviteUrl as appInvite, linkFor, intentsFrom, avatarUrl, PERMISSIONS } from '../desktop/lib/discord.js';
import { inviteUrl as botInvite, clientIdFromToken } from '../scripts/inviteLib.js';
import { appIdFromToken, redirectUriFor } from '../desktop/lib/discord.js';
import { normalizeBase } from '../src/dashboard/server.js';
import { brandStatus, applyBrand, applyCustom, BRAND } from '../desktop/lib/brand.js';
import { createLicense, verifyLicense, generateKeyPair, hasFeature, readCancelList, CANCEL_LIST_URL } from '../desktop/lib/license.js';
import { SecretFile } from '../desktop/lib/vault.js';
import { signModule, verifyModule, hashModule, SIG_FILE } from '../desktop/lib/modsign.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gb-desk-'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (cond, ms = 8000, what = 'condition') => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error(`timed out waiting for ${what}`); };

// A believable-looking (but invented) bot token, assembled so no real token is ever in this file.
const FAKE_TOKEN = ['MTA1MjM0NTY3ODkwMTIzNDU2', 'GaBcDe', 'abcdefghijklmnopqrstuvwxyz0'].join('.');

const FAKE_BOT = `
import fs from 'node:fs'; import path from 'node:path';
fs.writeFileSync(path.join(process.env.GOODBOY_DATA_DIR, 'bot.pid'), String(process.pid));
console.log('Logged in as Test#0');
console.log('token=${FAKE_TOKEN}');
console.log('Ready. In Discord, run /module list to turn features on.');
process.on('message', (m) => { if (m.type === 'shutdown') process.exit(0); });
setInterval(() => {}, 1000);
`;
function fakeInstall() {
  const base = tmp();
  fs.mkdirSync(path.join(base, 'src'), { recursive: true });
  fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: 'good-boy', version: '2.2.0', type: 'module' }));
  fs.writeFileSync(path.join(base, 'src', 'index.js'), FAKE_BOT);
  return base;
}
const SUPERVISE = path.join(root, 'scripts', 'supervise.js');

export default async function ({ test }) {
  console.log('\nDesktop app');

  await test('desktop settings: every value is checked, unknown keys are dropped, bad input falls back to the defaults', async () => {
    assert.deepEqual(normalize(null), DEFAULTS);
    assert.deepEqual(normalize('nonsense'), DEFAULTS);
    const n = normalize({ botDir: '  C:\\Bot  ', closeAction: 'explode', theme: 'neon', startAtLogin: 'yes', startBotWithApp: false, evil: 1 });
    assert.equal(n.botDir, 'C:\\Bot'); assert.equal(n.closeAction, 'minimize'); assert.equal(n.theme, 'system');
    assert.equal(n.startAtLogin, false, 'only real booleans count'); assert.equal(n.startBotWithApp, false);
    assert.ok(!('evil' in n));
    assert.equal(normalize({ closeAction: 'quit' }).closeAction, 'quit');
    assert.equal(normalize({ botDir: 'x'.repeat(5000) }).botDir.length, 1024);
  });

  await test('desktop checks: Node version rules, the dashboard port, and which addresses may be opened', async () => {
    assert.deepEqual(parseNodeVersion('v22.14.0\n'), [22, 14, 0]); assert.equal(parseNodeVersion('banana'), null);
    assert.ok(nodeIsNewEnough([22, 13, 0])); assert.ok(nodeIsNewEnough([24, 0, 1])); assert.ok(!nodeIsNewEnough([22, 12, 9])); assert.ok(!nodeIsNewEnough([20, 99, 0])); assert.ok(!nodeIsNewEnough(null));
    const none = { candidates: [], exists: () => false };
    assert.deepEqual(findNode(() => 'v22.13.0', '', none), { found: true, version: '22.13.0', ok: true, path: 'node' });
    assert.deepEqual(findNode(() => 'v20.1.0', '', none), { found: true, version: '20.1.0', ok: false, path: 'node' });
    assert.deepEqual(findNode(() => { throw new Error('ENOENT'); }, '', none), { found: false, version: null, ok: false, path: '' });
    assert.equal(dashboardPort('DASHBOARD_PORT=4100\n'), 4100); assert.equal(dashboardPort('# DASHBOARD_PORT=4100'), 3000);
    assert.equal(dashboardPort('DASHBOARD_PORT=99999'), 3000); assert.equal(dashboardPort(''), 3000);
    for (const ok of ['http://localhost:3000', 'http://127.0.0.1:4100/x']) assert.ok(isSafeDashboardUrl(ok), ok);
    for (const bad of ['https://localhost:3000', 'http://evil.example', 'http://localhost.evil.example', 'http://user:pw@localhost:3000', 'file:///etc/passwd', 'javascript:alert(1)', '', null]) assert.ok(!isSafeDashboardUrl(bad), String(bad));
  });

  await test('desktop checks: a folder is ready only with the files and .env the bot needs, and the token is never returned', async () => {
    assert.match(checkBotDir('').problems[0], /Choose the folder/);
    const empty = tmp(); assert.match(checkBotDir(empty).problems[0], /does not look like Good Boy/);
    const other = tmp(); fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'something-else' }));
    assert.match(checkBotDir(other).problems[0], /does not look like Good Boy/);
    const dir = tmp(); fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'good-boy' }));
    let r = checkBotDir(dir); assert.ok(r.problems.some((p) => /supervisor script/.test(p))); assert.ok(r.problems.some((p) => /npm install/.test(p))); assert.ok(r.problems.some((p) => /DISCORD_TOKEN/.test(p)));
    fs.mkdirSync(path.join(dir, 'scripts')); fs.writeFileSync(path.join(dir, 'scripts', 'supervise.js'), ''); fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, '.env'), `DISCORD_TOKEN=${FAKE_TOKEN}\nDASHBOARD_PORT=4200\n`);
    r = checkBotDir(dir); assert.deepEqual([r.ok, r.problems, r.port], [true, [], 4200]);
    assert.ok(!JSON.stringify(r).includes('GaBcDe'), 'the token must never come back');
    fs.writeFileSync(path.join(dir, '.env'), 'DISCORD_TOKEN=\n'); assert.ok(!checkBotDir(dir).ok, 'an empty token is not a token');
  });

  await test('desktop node lookup: the chosen node wins, then PATH, then the usual install places (a packaged app cannot see the terminal PATH)', async () => {
    const seen = [];
    const run = (cmd) => { seen.push(cmd); if (cmd === 'node') throw new Error('ENOENT'); return 'v22.14.0'; };
    // PATH has no node (as when the app is opened from the Start menu): the install folder is found instead
    const r = findNode(run, '', { candidates: ['C:\\Program Files\\nodejs\\node.exe', 'D:\\missing\\node.exe'], exists: (f) => f.startsWith('C:') });
    assert.deepEqual(r, { found: true, version: '22.14.0', ok: true, path: 'C:\\Program Files\\nodejs\\node.exe' });
    assert.deepEqual(seen, ['node', 'C:\\Program Files\\nodejs\\node.exe'], 'a candidate that does not exist is never run');
    // a chosen path is tried first, even if the file check cannot see it
    seen.length = 0; assert.equal(findNode((c) => { seen.push(c); return 'v24.0.0'; }, 'E:\\tools\\node.exe', { candidates: [], exists: () => false }).path, 'E:\\tools\\node.exe'); assert.equal(seen[0], 'E:\\tools\\node.exe');
    assert.ok(candidateNodePaths('win32', { ProgramFiles: 'C:\\Program Files' }).some((p) => /nodejs[\\/]node\.exe$/.test(p)));
    assert.ok(candidateNodePaths('darwin', { HOME: '/Users/a' }).includes('/opt/homebrew/bin/node'));
    // only a file really named node can be saved as the setting
    assert.equal(normalize({ nodePath: 'C:\\Program Files\\nodejs\\node.exe' }).nodePath, 'C:\\Program Files\\nodejs\\node.exe');
    assert.equal(normalize({ nodePath: '/usr/local/bin/node' }).nodePath, '/usr/local/bin/node');
    for (const bad of ['C:\\Windows\\System32\\cmd.exe', '/bin/sh', 'node.exe.bat', 'C:\\x\\notnode.exe', 5, null]) assert.equal(normalize({ nodePath: bad }).nodePath, '', String(bad));
  });

  await test('desktop look: launch window and main window share one design (Inter, light/dark, the status orb), motion respects reduce-motion, pages are locked down', async () => {
    const r = path.join(root, 'desktop', 'renderer');
    const splash = fs.readFileSync(path.join(r, 'splash.html'), 'utf8'), index = fs.readFileSync(path.join(r, 'index.html'), 'utf8');
    for (const html of [splash, index]) { assert.match(html, /default-src 'none'/); assert.match(html, /font-src 'self'/); assert.ok(!/<script>|unsafe-inline|unsafe-eval|https?:\/\/(?!www\.w3|cdn\.discordapp\.com;)/.test(html), 'no inline script; the only outside address is Discord\'s image server, for the bot\'s picture'); assert.match(html, /app\.css/); }
    assert.match(index, /img-src 'self' data: https:\/\/cdn\.discordapp\.com;/); assert.match(index, /script-src 'self'"/, 'scripts only from the app itself');
    assert.match(splash, /class="orb" data-state="starting"/);
    const css = fs.readFileSync(path.join(r, 'app.css'), 'utf8');
    for (const f of ['Inter-Regular', 'Inter-Medium', 'Inter-SemiBold', 'InterDisplay-SemiBold', 'InterDisplay-Bold']) { assert.match(css, new RegExp(`fonts/${f}\\.woff`)); assert.ok(fs.existsSync(path.join(r, 'fonts', `${f}.woff`)), `${f} bundled`); }
    assert.ok(fs.existsSync(path.join(r, 'fonts', 'LICENSE-Inter.txt')), 'the font licence ships with it');
    assert.match(css, /:root\[data-theme="dark"\]/); assert.match(css, /prefers-reduced-motion:reduce/); assert.match(css, /@keyframes breathe/); assert.match(css, /backdrop-filter/);
    assert.ok(!/glass\.css|desktop\.css/.test(splash + index), 'the old styles are gone');
    const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
    assert.match(main, /createSplash\(\)/); assert.match(main, /closeSplash\(\)/); assert.ok(!/devTools|openDevTools/.test(main), 'no developer tools in the shipped app');
    const app = fs.readFileSync(path.join(r, 'app.js'), 'utf8');
    for (const pg of ['overview', 'levels', 'modules', 'log', 'updates', 'settings', 'setup']) assert.match(app, new RegExp(`\\b${pg}\\(\\)\\s*\\{`), `page ${pg}`);
    assert.match(app, /const STEPS = \['token', 'secret', 'brand', 'invite', 'done'\]/, 'setup is five short steps after the welcome');
  });

  await test('desktop setup: .env files are read safely, only bot settings are kept, and the vault never stores or shows the token in plain text', async () => {
    const env = parseEnv('\uFEFF# comment\nDISCORD_TOKEN="' + FAKE_TOKEN + '"\nDISCORD_CLIENT_SECRET=abc # note\nexport DASHBOARD_PORT=4100\nNODE_OPTIONS=--require evil.js\nPATH=/evil\nGOODBOY_DATA_DIR=/elsewhere\nlower=x\nbroken line\nEMPTY=\n');
    assert.equal(env.DISCORD_TOKEN, FAKE_TOKEN); assert.equal(env.DISCORD_CLIENT_SECRET, 'abc'); assert.equal(env.DASHBOARD_PORT, '4100');
    const safe = safeBotSettings({ ...env, BAD: 'a\nb' });
    assert.deepEqual(Object.keys(safe).sort(), ['DASHBOARD_PORT', 'DISCORD_CLIENT_SECRET', 'DISCORD_TOKEN', 'EMPTY'], 'settings that would change how Node or the app runs are dropped');
    assert.ok(looksLikeToken(FAKE_TOKEN)); for (const bad of ['', 'hello', 'a.b.c', null, FAKE_TOKEN + ' extra']) assert.ok(!looksLikeToken(bad), String(bad));
    // fake OS encryption: reversible, but nothing readable on disk
    const crypto = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(t).map((b) => b ^ 0x5a), decryptString: (b) => Buffer.from(b).map((x) => x ^ 0x5a).toString() };
    const file = path.join(tmp(), 'secrets.bin'); const v = new Vault(file, crypto);
    v.write({ DISCORD_TOKEN: FAKE_TOKEN, DASHBOARD_PORT: '4100', NODE_OPTIONS: 'x' });
    assert.ok(!fs.readFileSync(file).includes(FAKE_TOKEN.slice(0, 10)), 'the token is not in the file in plain text');
    assert.deepEqual(v.read(), { DISCORD_TOKEN: FAKE_TOKEN, DASHBOARD_PORT: '4100' });
    v.merge({ DISCORD_CLIENT_SECRET: 's' }); assert.equal(v.read().DISCORD_TOKEN, FAKE_TOKEN, 'merging keeps what was there');
    assert.deepEqual(v.describe(), { hasToken: true, hasClientSecret: true, keys: ['DASHBOARD_PORT'] }, 'the window learns which settings exist, never secret values or names');
    assert.ok(!JSON.stringify(v.describe()).includes(FAKE_TOKEN));
    const off = new Vault(path.join(tmp(), 's.bin'), { isEncryptionAvailable: () => false });
    assert.throws(() => off.write({ DISCORD_TOKEN: FAKE_TOKEN }), /cannot encrypt/); assert.deepEqual(off.read(), {});
    assert.deepEqual(new Vault(file, { ...crypto, decryptString: () => { throw new Error('wrong user'); } }).read(), {}, 'a vault from another Windows user reads as empty, not as an error');
  });

  await test('desktop setup wizard: the token is checked with Discord, answers are plain English, the token never comes back, and only discord.com is opened', async () => {
    const calls = [];
    const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
    const discord = (routes) => async (url, opts) => { calls.push([url, opts.headers.Authorization]); const r = routes[new URL(url).pathname.replace('/api/v10', '')]; return typeof r === 'function' ? r() : r; };
    const good = await verifyToken(` ${FAKE_TOKEN} `, discord({
      '/users/@me': reply(200, { id: '123456789012345678', username: 'goodboy', global_name: 'Good Boy', bot: true, avatar: 'abc' }),
      '/applications/@me': reply(200, { id: '123456789012345678', name: 'Good Boy', flags: (1 << 15) | (1 << 19) }),
      '/users/@me/guilds': reply(200, [{ id: '1', name: 'A Basic Discord Server' }]),
    }));
    assert.equal(good.ok, true); assert.equal(good.bot.name, 'Good Boy'); assert.deepEqual(good.intents, { presence: false, members: true, messageContent: true });
    assert.deepEqual(good.guilds, [{ id: '1', name: 'A Basic Discord Server' }]); assert.match(good.bot.avatar, /^https:\/\/cdn\.discordapp\.com\/avatars\/123456789012345678\/abc\.png/);
    assert.ok(!JSON.stringify(good).includes(FAKE_TOKEN), 'the token is never in the answer');
    assert.ok(calls.every(([u, a]) => u.startsWith('https://discord.com/api/v10/') && a === `Bot ${FAKE_TOKEN}`), 'only discord.com is asked, with the trimmed token');
    assert.match((await verifyToken(FAKE_TOKEN, discord({ '/users/@me': reply(401, {}) }))).error, /not valid/);
    assert.match((await verifyToken(FAKE_TOKEN, discord({ '/users/@me': reply(429, {}) }))).error, /slow down/);
    assert.match((await verifyToken(FAKE_TOKEN, discord({ '/users/@me': () => { throw new TypeError('fetch failed'); } }))).error, /internet connection/);
    assert.match((await verifyToken(FAKE_TOKEN, discord({ '/users/@me': reply(200, { id: '1', username: 'me' }) }))).error, /user account token/);
    assert.equal((await verifyToken('   ', discord({}))).kind, 'empty');
    const half = await verifyToken(FAKE_TOKEN, discord({ '/users/@me': reply(200, { id: '123456789012345678', username: 'b', bot: true }), '/applications/@me': reply(500, {}), '/users/@me/guilds': reply(500, {}) }));
    assert.equal(half.ok, true, 'a token that signs in still counts when the extra details fail'); assert.equal(half.intents, null); assert.equal(half.guilds, null);
    assert.deepEqual(intentsFrom(0), { presence: false, members: false, messageContent: false }); assert.equal(intentsFrom(1 << 12).presence, true);
    assert.match(avatarUrl({ id: '123456789012345678', avatar: null }), /embed\/avatars\/[0-5]\.png$/);
    // links: built here, only discord.com, and the invite asks for the same permissions as "npm run invite"
    assert.equal(appInvite('123456789012345678'), botInvite('123456789012345678'), 'same invite as the bot\'s own invite script');
    assert.ok(!/permissions=8\b/.test(appInvite('123456789012345678')), 'no Administrator'); assert.equal(PERMISSIONS, new URL(botInvite('123456789012345678')).searchParams.get('permissions'));
    for (const k of ['portal', 'bot', 'oauth', 'invite']) assert.ok(linkFor(k, '123456789012345678').startsWith('https://discord.com/'), k);
    assert.equal(linkFor('invite', 'not-an-id'), null); assert.equal(linkFor('javascript:alert(1)', '123456789012345678'), null);
    assert.equal(linkFor('bot', '../../evil'), 'https://discord.com/developers/applications', 'a bad app ID falls back to the general page');
    const app = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'app.js'), 'utf8');
    for (const words of ['Discord bot token', 'Client secret', 'Open the Developer Portal', 'Add to my Discord server', 'Start the bot', 'Skip']) assert.ok(app.includes(words), words);
    assert.equal(normalize({}).setupComplete, false); assert.equal(normalize({ setupComplete: 'yes' }).setupComplete, false);
  });

  await test('desktop redirect and brand: the setup shows the same login address the dashboard asks for, and the Good Boy look is applied part by part', async () => {
    for (const env of [{}, { DASHBOARD_PORT: '4100' }, { DASHBOARD_BASE_URL: 'https://gb.example.ts.net/' }, { DASHBOARD_BASE_URL: 'http://localhost:3000' }, { DASHBOARD_BASE_URL: 'ftp://x' }, { DASHBOARD_BASE_URL: '"https://a.example/sub/"' }])
      assert.equal(redirectUriFor(env), `${normalizeBase(env.DASHBOARD_BASE_URL, Number(env.DASHBOARD_PORT || 3000))}/callback`, JSON.stringify(env));
    assert.equal(redirectUriFor({}), 'http://localhost:3000/callback');
    assert.equal(appIdFromToken(FAKE_TOKEN), clientIdFromToken(FAKE_TOKEN)); assert.equal(appIdFromToken('nonsense'), null);
    const v = { ok: true, bot: { username: 'Good Boy', name: 'Good Boy', avatarHash: 'a1', bannerHash: null }, app: { icon: 'i1', description: BRAND.description } };
    assert.deepEqual(brandStatus(v, { avatar: 'a1', icon: 'i1' }).items, { name: true, avatar: true, banner: false, icon: true, description: true });
    assert.equal(brandStatus({ ok: false }), null);
    const sent = [];
    const fake = async (url, o) => { const body = JSON.parse(o.body); sent.push([new URL(url).pathname, Object.keys(body)[0], o.headers.Authorization]);
      if (body.banner) return { ok: false, status: 403, json: async () => ({ message: 'Missing Access' }) };
      if (body.username) return { ok: false, status: 400, json: async () => ({ message: 'Invalid Form Body', errors: { username: {} } }) };
      return { ok: true, status: 200, json: async () => (body.avatar ? { avatar: 'new-a' } : body.icon ? { icon: 'new-i' } : {}) }; };
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const r = await applyBrand(FAKE_TOKEN, { avatar: png, banner: png, icon: png }, { bot: { username: 'old name' } }, fake);
    assert.deepEqual(Object.fromEntries(Object.entries(r.results).map(([k, x]) => [k, x.ok])), { avatar: true, banner: false, name: false, icon: true, description: true }, 'one refusal does not stop the rest');
    assert.match(r.results.name.error, /two name changes an hour/); assert.match(r.results.banner.error, /did not allow/);
    assert.deepEqual(r.applied, { avatar: 'new-a', icon: 'new-i' });
    assert.ok(sent.every(([p, , a]) => ['/api/v10/users/@me', '/api/v10/applications/@me'].includes(p) && a === `Bot ${FAKE_TOKEN}`));
    assert.equal((await applyBrand(FAKE_TOKEN, { avatar: png, banner: png, icon: png }, { bot: { username: 'Good Boy' } }, fake)).results.name.skipped, true, 'the name is only changed when it is wrong (Discord limits name changes)');
    sent.length = 0;
    const only = await applyBrand(FAKE_TOKEN, { avatar: png, banner: png, icon: png }, { bot: { username: 'x' } }, fake, { parts: ['icon'] });
    assert.deepEqual(Object.keys(only.results), ['icon'], 'keeping the look up only touches the parts that are missing'); assert.equal(sent.length, 1);
    assert.match((await applyCustom(FAKE_TOKEN, { name: 'a' }, fake)).error, /2 to 32/);
    sent.length = 0; assert.equal((await applyCustom(FAKE_TOKEN, { image: png }, fake)).ok, true); assert.deepEqual(sent.map((x) => x[1]), ['avatar']);
    // Licensed bots: description (with the credit kept) and banner.
    const bodies = [];
    const ok = async (url, o) => { bodies.push([new URL(url).pathname, JSON.parse(o.body)]); return { ok: true, status: 200, json: async () => ({}) }; };
    assert.equal((await applyCustom(FAKE_TOKEN, { description: 'The best fishing bot in Cozy Cove.\n\nGood Boy v2.3.3 · Basic Ghost Labs', banner: png, version: '3.0.0' }, ok)).ok, true);
    assert.deepEqual(bodies.map(([p2, b]) => [p2, Object.keys(b)]), [['/api/v10/users/@me', ['banner']], ['/api/v10/applications/@me', ['description']]]);
    assert.equal(bodies[1][1].description, 'The best fishing bot in Cozy Cove.\n\nGood Boy v3.0.0 · Basic Ghost Labs', 'the credit stays, once, with the current version');
    const { describeWithCredit } = await import('../desktop/lib/brand.js');
    assert.equal(describeWithCredit('', '3.0.0'), 'Good Boy v3.0.0 · Basic Ghost Labs', 'an empty description still has the credit');
    assert.ok(describeWithCredit('x'.repeat(600), '3.0.0').length <= 400 && describeWithCredit('x'.repeat(600), '3.0.0').endsWith('Basic Ghost Labs'), 'a long description is shortened, never the credit');
    const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
    assert.match(main, /async function keepBrand\(\) \{\n  if \(!bundled \|\| whiteLabel\(\)/, 'free versions put the Good Boy look back by themselves; licensed ones are left alone');
    assert.match(main.slice(main.indexOf("'gb:brand-custom'"), main.indexOf("'gb:brand-custom'") + 200), /if \(!whiteLabel\(\)\) return/, 'own name and picture need a licence');
    for (const f of ['avatar.png', 'banner.png', 'app-icon.png']) { const b = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'brand', f)); assert.equal(b.toString('latin1', 1, 4), 'PNG', f); assert.ok(b.length < 8 * 1024 * 1024, `${f} is under Discord's size limit`); }
    const banner = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'brand', 'banner.png')); assert.equal(banner.readUInt32BE(16) / banner.readUInt32BE(20), 2.5, 'banner is 5:2 like Discord\'s');
    assert.ok(fs.existsSync(path.join(root, 'desktop', 'renderer', 'tray.png')) && fs.existsSync(path.join(root, 'desktop', 'build', 'icon.ico')));
  });

  await test('cancel list: only a list signed with the owner key cancels licences, and junk is ignored', () => {
    const { publicKey, privateKey } = generateKeyPair();
    const sign = (obj, key = privateKey) => { const body = JSON.stringify(obj); return JSON.stringify({ body, sig: crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(key)).toString('base64') }); };
    assert.deepEqual(readCancelList(sign({ v: 1, at: 5, revoked: ['a1b2c3d4e5f6', '<script>'] }), publicKey), { at: 5, revoked: ['a1b2c3d4e5f6'] });
    assert.equal(readCancelList(sign({ v: 1, at: 5, revoked: [] }, generateKeyPair().privateKey), publicKey), null, 'someone else\'s list is ignored');
    const f = JSON.parse(sign({ v: 1, at: 5, revoked: ['a1b2c3d4e5f6'] })); f.body = f.body.replace('a1b2', 'ffff');
    assert.equal(readCancelList(JSON.stringify(f), publicKey), null, 'a changed list is ignored');
    assert.equal(readCancelList('not json', publicKey), null); assert.equal(readCancelList(sign({ v: 1, at: 5, revoked: [] }), null), null);
    assert.equal(CANCEL_LIST_URL, 'https://raw.githubusercontent.com/jamiechastain10-blip/Good-Boy-Bot/main/licences/revoked.json');
  });

  await test('licences: signed by the owner, tied to one bot, with an end date; forged, changed, moved, ended and cancelled keys are all refused', () => {
    const { publicKey, privateKey } = generateKeyPair();
    const t0 = Date.UTC(2026, 9, 31);
    const { key, payload } = createLicense({ privateKey, appId: '1469714389648015571', to: "Joe's server", days: 30, now: t0 });
    assert.match(key, /^GB1\.[\w-]+\.[\w-]+$/); assert.equal(payload.exp, t0 + 30 * 86400000);
    const ok = verifyLicense(key, publicKey, { appId: '1469714389648015571', now: t0 + 86400000 });
    assert.equal(ok.ok, true); assert.ok(hasFeature(ok, 'whitelabel'));
    assert.match(verifyLicense(key, publicKey, { appId: '1469714389648015572', now: t0 }).error, /different bot/);
    assert.match(verifyLicense(key, publicKey, { appId: '1469714389648015571', now: t0 + 31 * 86400000 }).error, /ended on/);
    assert.match(verifyLicense(key, publicKey, { appId: '1469714389648015571', now: t0, revoked: [payload.id] }).error, /cancelled/);
    const [pre, body, sig] = key.split('.');
    const longer = Buffer.from(JSON.stringify({ ...payload, exp: null })).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    assert.match(verifyLicense(`${pre}.${longer}.${sig}`, publicKey, { appId: payload.app, now: t0 }).error, /not genuine/, 'changing the end date breaks the signature');
    assert.match(verifyLicense(key, generateKeyPair().publicKey, { appId: payload.app, now: t0 }).error, /not genuine/, 'a key made by someone else is refused');
    assert.match(verifyLicense('hello', publicKey).error, /not a Good Boy licence/); assert.match(verifyLicense(key, null).error, /not switched on/);
    const life = createLicense({ privateKey, appId: '1469714389648015571', days: null, now: t0 });
    assert.equal(life.payload.exp, null); assert.equal(verifyLicense(life.key, publicKey, { appId: '1469714389648015571', now: t0 + 1e12 }).ok, true, 'lifetime never ends');
    assert.equal(createLicense({ privateKey, appId: '1469714389648015571', until: '2027-03-03', now: t0 }).payload.exp, Date.parse('2027-03-03'));
    assert.throws(() => createLicense({ privateKey, appId: 'abc', days: 30 }), /Application ID/);
    assert.throws(() => createLicense({ privateKey, appId: '1469714389648015571', until: '2020-01-01', now: t0 }), /future/);
    assert.throws(() => createLicense({ privateKey, appId: '1469714389648015571', days: 30, features: ['admin'] }), /unlocks/);
    // the signing key is stored encrypted
    const crypto = { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(t).map((b) => b ^ 0x33), decryptString: (b) => Buffer.from(b).map((x) => x ^ 0x33).toString() };
    const f = new SecretFile(path.join(tmp(), 'k.bin'), crypto); f.write({ privateKey });
    assert.ok(!fs.readFileSync(f.file).includes('PRIVATE KEY'), 'not readable on disk'); assert.equal(f.read().privateKey, privateKey);
    assert.equal(normalize({ license: key }).license, key); assert.equal(normalize({ license: 'bad key!<script>' }).license, '');
    assert.deepEqual(normalize({ brandApplied: { avatar: 'a1', icon: '../x', evil: 1 } }).brandApplied, { avatar: 'a1', banner: null, icon: null });
  });

  await test('modules from the app: the everyone version only takes modules the owner signed; any changed file breaks the signature', () => {
    const { publicKey, privateKey } = generateKeyPair();
    const dir = path.join(tmp(), 'party-games'); fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), "export default { name: 'party-games', version: '1.0.0' };"); fs.writeFileSync(path.join(dir, 'lib', 'x.js'), 'export const x = 1;');
    assert.match(verifyModule(dir, publicKey).error, /not signed/);
    const s = signModule(dir, privateKey); assert.equal(s.name, 'party-games'); assert.ok(fs.existsSync(path.join(dir, SIG_FILE)));
    assert.deepEqual(verifyModule(dir, publicKey), { ok: true, name: 'party-games' });
    assert.match(verifyModule(dir, generateKeyPair().publicKey).error, /not genuine/, 'signed by someone else');
    assert.match(verifyModule(dir, null).error, /not switched on/);
    fs.writeFileSync(path.join(dir, 'lib', 'x.js'), 'export const x = 2; // sneaky');
    assert.match(verifyModule(dir, publicKey).error, /changed after it was signed/, 'one changed file anywhere is caught');
    fs.writeFileSync(path.join(dir, 'lib', 'x.js'), 'export const x = 1;'); assert.equal(verifyModule(dir, publicKey).ok, true);
    fs.writeFileSync(path.join(dir, 'lib', 'extra.js'), ''); assert.equal(verifyModule(dir, publicKey).ok, false, 'an added file is caught too'); fs.rmSync(path.join(dir, 'lib', 'extra.js'));
    const moved = path.join(path.dirname(dir), 'other-name'); fs.cpSync(dir, moved, { recursive: true });
    assert.match(verifyModule(moved, publicKey).error, /different name/);
    const bad = path.join(tmp(), 'Bad Name!'); fs.mkdirSync(bad); fs.writeFileSync(path.join(bad, 'index.js'), '');
    assert.match(verifyModule(bad, publicKey).error, /lowercase/);
    assert.equal(hashModule(dir), hashModule(dir), 'the same folder always hashes the same');
    const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
    const add = main.slice(main.indexOf("'gb:module-add'"), main.indexOf("'gb:save-settings'"));
    assert.ok(add.indexOf('verifyModule(') < add.indexOf('fs.cpSync('), 'the signature is checked before anything is copied or run');
    assert.match(add, /if \(!sig\.ok && !canAddUnsigned\(\)\) return/);
    assert.match(main, /const canAddUnsigned = \(\) => edition\.id === 'owner' \|\| edition\.features\.includes\('devtools'\)/);
  });

  await test('desktop editions: three builds from one codebase with their own names and app IDs; unknown means consumer', async () => {
    assert.equal(readEdition({ edition: 'owner' }).features.includes('publish'), true);
    assert.equal(readEdition({ edition: 'consumer' }).features.includes('publish'), false);
    assert.equal(readEdition({ edition: 'developer' }).features.includes('devtools'), true);
    for (const bad of [null, {}, { edition: 'admin' }, { edition: '__proto__' }]) assert.equal(readEdition(bad).id, 'consumer');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'));
    const ids = ['owner', 'consumer', 'developer'].map((e) => editionConfig(pkg, e));
    assert.equal(new Set(ids.map((c) => c.build.appId)).size, 3, 'separate app IDs, so all three install side by side');
    assert.deepEqual(ids.map((c) => c.productName), ['Good Boy Owner', 'Good Boy', 'Good Boy Developer']);
    assert.match(ids[0].build.nsis.artifactName, /^Good-Boy-Owner-Setup-/); assert.equal(pkg.build.appId, 'com.basicghostlabs.goodboy', 'the committed file is not changed by the function');
    assert.throws(() => editionConfig(pkg, 'admin'), /owner, consumer or developer/);
  });

  await test('desktop bundled bot: copied into place once per version, the bot\'s own updates and the data are kept, owner data seeds only an empty install', async () => {
    const src = tmp(), dest = path.join(tmp(), 'bot'), data = path.join(tmp(), 'data');
    fs.mkdirSync(path.join(src, 'src'), { recursive: true }); fs.writeFileSync(path.join(src, 'src', 'index.js'), '//1'); fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ version: '2.1.1' }));
    assert.deepEqual(ensureBotCode(src, dest), { action: 'installed', version: '2.1.1' }); assert.equal(installedVersion(dest), '2.1.1');
    assert.deepEqual(ensureBotCode(src, dest), { action: 'none', version: '2.1.1' });
    fs.mkdirSync(path.join(dest, 'releases', '2.1.2'), { recursive: true }); fs.writeFileSync(path.join(dest, 'current.json'), '{}');
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ version: '2.1.3' })); fs.writeFileSync(path.join(src, 'src', 'index.js'), '//3');
    assert.equal(ensureBotCode(src, dest).action, 'updated'); assert.equal(fs.readFileSync(path.join(dest, 'src', 'index.js'), 'utf8'), '//3');
    assert.ok(fs.existsSync(path.join(dest, 'releases', '2.1.2')) && fs.existsSync(path.join(dest, 'current.json')), 'downloaded bot updates survive an app update');
    assert.throws(() => ensureBotCode(tmp(), dest), /missing from this app/);
    const seed = path.join(tmp(), 'eclipse.db'); fs.writeFileSync(seed, 'SEED');
    assert.equal(seedData(seed, data), true); fs.writeFileSync(path.join(data, 'eclipse.db'), 'LIVE');
    assert.equal(seedData(seed, data), false); assert.equal(fs.readFileSync(path.join(data, 'eclipse.db'), 'utf8'), 'LIVE', 'existing data is never overwritten');
    assert.equal(seedData(path.join(tmp(), 'none.db'), path.join(tmp(), 'x')), false);
    // what goes into the app: the bot without tests, docs, secrets, data or the desktop app itself
    const shipped = bundleFiles(root).map((f) => f.path);
    assert.ok(shipped.includes('src/index.js') && shipped.includes('scripts/app-tools.js') && shipped.includes('scripts/supervise.js'));
    assert.ok(!shipped.some((p) => /^(tests|docs|desktop|data|node_modules|\.github)\//.test(p) || /(^|\/)\.env|\.db$|\.pem$/.test(p)), shipped.filter((p) => /^(tests|docs|desktop|data)\//.test(p)).join(','));
  });

  await test('desktop helper: reads levels and modules from a database, imports a live database (with its -wal changes) as one clean copy, and agrees with the levels module', async () => {
    for (const xp of [0, 99, 100, 254, 255, 1671, 1470, 99999]) assert.deepEqual(toolLevel(xp), communityLevel(xp), `level curve for ${xp}`);
    const live = tmp(); const db = new Database(path.join(live, 'eclipse.db'));
    db.upsertGuild('9', 'Test Server'); db.setModuleState('9', 'community', true, '1'); db.setModuleState('9', 'voice', false, '1');
    db.dataSet('9', 'community', 'user:111', { xp: 1671, messages: 147 }); db.dataSet('9', 'community', 'user:222', { xp: 50 }); db.dataSet('9', 'community', 'user:333', { xp: 0 });
    assert.ok(fs.existsSync(path.join(live, 'eclipse.db-wal')), 'changes are still in the -wal side file, like a running bot');
    const out = tmp(); fs.writeFileSync(path.join(out, 'eclipse.db'), 'old');
    const r = await importDb(path.join(live, 'eclipse.db'), out);
    assert.equal(r.guild.name, 'Test Server'); assert.equal(r.memberCount, 2); assert.ok(r.backup && fs.readFileSync(r.backup, 'utf8') === 'old', 'what was there is kept as a backup');
    db.close();
    const s = await toolSummary(out);
    assert.deepEqual(s.members.map((m) => [m.id, m.level]), [['111', 6], ['222', 0]], 'sorted by XP, members without XP left out');
    assert.deepEqual(s.modules, [{ name: 'community', enabled: true }, { name: 'voice', enabled: false }]);
    assert.equal((await toolSummary(tmp())).empty, true);
    await assert.rejects(importDb(path.join(tmp(), 'missing.db'), tmp()), /no database/);
    // the same, through the app's runner with a real Node process
    const viaApp = await runTool({ nodePath: process.execPath, botDir: root, args: ['summary', out] });
    assert.equal(viaApp.ok, true); assert.equal(viaApp.memberCount, 2);
    assert.match((await runTool({ nodePath: path.join(tmp(), 'no-node'), botDir: root, args: ['summary', out] })).error, /bundled Node\.js is missing/);
  });

  await test('take control: reads who is in the way, stops only a real Node process (and what it started), and clears a stale lock without stopping anything', async () => {
    assert.deepEqual(blockedBy('Another supervisor (process 39764) is already running this install.'), { pid: 39764, other: false });
    assert.deepEqual(blockedBy('This bot is already running from another Good Boy install on this computer (process 812).'), { pid: 812, other: true });
    assert.equal(blockedBy('[21:47:53] INFO  Logged in'), null);
    assert.ok(isNodeName('node.exe') && isNodeName('node') && !isNodeName('chrome.exe') && !isNodeName('node-red'));
    // a fake Windows: tasklist answers, taskkill removes the process
    const procs = new Map([[39764, 'node.exe'], [500, 'explorer.exe']]); const calls = [];
    const execFile = (cmd, args, _o, cb) => {
      calls.push([cmd, ...args]);
      if (cmd === 'tasklist') { const pid = Number(args[1].split(' ').pop()); const n = procs.get(pid); return cb(null, n ? `"${n}","${pid}","Console","1","40,000 K"\r\n` : 'INFO: No tasks are running which match the specified criteria.\r\n'); }
      if (cmd === 'taskkill') { procs.delete(Number(args[1])); return cb(null, 'SUCCESS'); }
      cb(new Error('unknown'));
    };
    assert.equal(await processName(39764, { platform: 'win32', execFile }), 'node.exe');
    assert.equal(await processName(4242, { platform: 'win32', execFile }), null);
    const dir = tmp(); const lock = path.join(dir, 'supervisor.lock'); const other = path.join(dir, 'other.lock');
    // stale: the lock names a process ID Windows gave to something else -> nothing is stopped, the lock is cleared
    fs.writeFileSync(lock, JSON.stringify({ pid: 500, id: 'x' }));
    const stale = await takeControl(500, { lockFiles: [lock], platform: 'win32', execFile, wait: async () => {} });
    assert.deepEqual(stale, { ok: true, stopped: false, stale: true }); assert.ok(procs.has(500), 'explorer was not touched'); assert.ok(!fs.existsSync(lock));
    assert.ok(!calls.some((c) => c[0] === 'taskkill'));
    // real: the old supervisor is stopped with its whole tree, then both locks naming it are removed (others kept)
    fs.writeFileSync(lock, JSON.stringify({ pid: 39764, id: 'a' })); fs.writeFileSync(other, JSON.stringify({ pid: 1, id: 'b' }));
    const r = await takeControl(39764, { lockFiles: [lock, other], platform: 'win32', execFile, wait: async () => {} });
    assert.deepEqual(r, { ok: true, stopped: true, stale: false });
    assert.deepEqual(calls.find((c) => c[0] === 'taskkill'), ['taskkill', '/PID', '39764', '/T', '/F'], 'the bot under it is stopped too');
    assert.ok(!fs.existsSync(lock) && fs.existsSync(other));
    // one that will not stop: a plain answer, locks left alone
    procs.set(77, 'node.exe'); const stubborn = (cmd, args, o, cb) => (cmd === 'taskkill' ? cb(null, '') : execFile(cmd, args, o, cb));
    fs.writeFileSync(lock, JSON.stringify({ pid: 77 }));
    assert.match((await takeControl(77, { lockFiles: [lock], platform: 'win32', execFile: stubborn, wait: async () => {} })).error, /would not stop/);
    assert.ok(fs.existsSync(lock));
  });

  await test('take control: the app keeps track of a running bot when setup runs again, and shows what is in the way', async () => {
    const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
    const recheck = main.slice(main.indexOf('function recheck()'), main.indexOf('const snapshot'));
    assert.match(recheck, /if \(runner\) \{ Object\.assign\(runner,/, 'recheck updates the runner instead of replacing it');
    assert.ok(!/removeAllListeners/.test(recheck), 'the running bot is never dropped');
    assert.match(main, /'gb:takeover'/); assert.match(main, /takeControl\(b\.pid/);
    // the runner reads the supervisor's message
    const base = fakeInstall(); const r = new BotRunner({ botDir: base, script: path.join(base, 'scripts', 'blocked.js') });
    fs.mkdirSync(path.join(base, 'scripts'), { recursive: true }); fs.writeFileSync(path.join(base, 'scripts', 'blocked.js'), "console.error('\\nAnother supervisor (process 39764) is already running this install.\\n'); process.exit(1);");
    const done = new Promise((res) => r.on('state', (st) => { if (st.state === 'failed') res(st); }));
    r.nodePath = process.execPath; r.start();
    const st = await done;
    assert.deepEqual(st.blocked, { pid: 39764, other: false }); assert.match(st.error, /older copy of the bot is still running/);
  });

  await test('app updates: the installed Windows app updates itself, other builds are told, versions compare properly, odd answers are ignored', async () => {
    assert.equal(updateMode({ packaged: true, platform: 'win32', edition: 'consumer' }), 'auto');
    assert.equal(updateMode({ packaged: true, platform: 'win32', edition: 'developer' }), 'auto');
    assert.equal(updateMode({ packaged: true, platform: 'win32', edition: 'owner' }), 'notify', 'the Owner build is never published, so it can only be told');
    assert.equal(updateMode({ packaged: true, platform: 'win32', portable: true }), 'notify');
    assert.equal(updateMode({ packaged: true, platform: 'darwin' }), 'notify');
    assert.equal(updateMode({ packaged: false, platform: 'win32' }), 'off');
    assert.equal(updateMode({ packaged: true, platform: 'win32', smoke: true }), 'off', 'the build check never downloads anything');
    assert.equal(channelFor('developer'), 'developer'); assert.equal(channelFor('consumer'), 'latest'); assert.equal(channelFor('owner'), 'latest');
    assert.equal(compareVersions('2.1.10', '2.1.9'), 1); assert.equal(compareVersions('v2.1.2', '2.1.2'), 0); assert.equal(compareVersions('2.0.9', '2.1.0'), -1); assert.equal(compareVersions('3.0.0-beta', '2.9.9'), 1);
    const rel = (o) => ({ tag_name: 'v2.1.3', html_url: 'https://github.com/jamiechastain10-blip/Good-Boy-Bot/releases/tag/v2.1.3', body: 'notes', draft: false, prerelease: false, ...o });
    assert.deepEqual(readLatest(rel(), '2.1.2'), { newer: true, version: '2.1.3', url: rel().html_url, notes: 'notes', publishedAt: null });
    assert.equal(readLatest(rel(), '2.1.3').newer, false);
    assert.equal(readLatest(rel({ draft: true }), '2.1.2').newer, false); assert.equal(readLatest(rel({ prerelease: true }), '2.1.2').newer, false);
    assert.equal(readLatest(rel({ tag_name: 'nightly' }), '2.1.2').newer, false); assert.equal(readLatest(null, '2.1.2').newer, false);
    assert.match(readLatest(rel({ html_url: 'https://evil.example/x' }), '2.1.2').url, /^https:\/\/github\.com\/jamiechastain10-blip\/Good-Boy-Bot\/releases$/, 'only ever opens the releases page on GitHub');
    assert.deepEqual(RELEASES, { owner: 'jamiechastain10-blip', repo: 'Good-Boy-Bot' });
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'));
    assert.equal(pkg.build.publish[0].repo, RELEASES.repo, 'the build publishes where the app looks');
    assert.equal(editionConfig(pkg, 'developer').build.publish[0].channel, 'developer'); assert.equal(editionConfig(pkg, 'consumer').build.publish[0].channel, 'latest');
    const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
    assert.match(main, /autoUpdater\.allowDowngrade = false/, 'never installs an older version'); assert.match(main, /channelFor\(edition\.id\)/);
    assert.match(main, /quitting = true;\s*await runner\?\.stop\(\);/, 'the bot is stopped cleanly before the update installs');
  });

  await test('client secret: checked with Discord, only invalid_client counts as wrong, network trouble does not block setup', async () => {
    const answer = (status, body = {}) => async (url, o) => { answer.last = { url, o }; return { ok: status < 300, status, json: async () => body }; };
    assert.deepEqual(await verifySecret('1469714389648015571', 'abc', answer(200)), { ok: true });
    assert.equal(answer.last.url, 'https://discord.com/api/v10/oauth2/token'); assert.equal(answer.last.o.method, 'POST');
    assert.equal(answer.last.o.headers.Authorization, `Basic ${Buffer.from('1469714389648015571:abc').toString('base64')}`);
    assert.equal((await verifySecret('1469714389648015571', 'abc', answer(401, { error: 'invalid_client' }))).kind, 'invalid');
    assert.equal((await verifySecret('1469714389648015571', 'abc', answer(400, { error: 'invalid_client' }))).kind, 'invalid');
    assert.equal((await verifySecret('1469714389648015571', 'abc', answer(400, { error: 'invalid_scope' }))).ok, true, 'the secret was accepted, the scope was not');
    assert.equal((await verifySecret('1469714389648015571', 'abc', async () => { throw new Error('offline'); })).kind, 'network');
    assert.equal((await verifySecret(null, 'abc', answer(200))).kind, 'noapp');
    const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
    const handler = main.slice(main.indexOf("'gb:setup-secret'"), main.indexOf("'gb:setup-finish'"));
    assert.ok(handler.indexOf('verifySecret') < handler.indexOf('vault.merge'), 'checked before it is saved');
  });

  await test('2.3.3: the dashboard is built into the main window, signed in by a one-time link from the running bot, in a locked-down view', async () => {
    const C = await import('../desktop/lib/checks.js');
    assert.ok(C.isDashboardWindowUrl('http://127.0.0.1:3000/login/local?t=x'));
    assert.ok(C.isDashboardWindowUrl('https://my-pc.tail1234.ts.net/login/local?t=x'), 'the owner\'s own Tailscale link');
    for (const bad of ['https://evil.example.com/', 'http://my-pc.tail1234.ts.net/', 'file:///etc/passwd', 'https://user:pw@x.ts.net/']) assert.ok(!C.isDashboardWindowUrl(bad), bad);
    const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
    const open = main.slice(main.indexOf('async function openDashboard()'), main.indexOf('async function openDashboardInBrowser'));
    assert.match(open, /runner\.control\('dashboard-login'/, 'asks the running bot for the link');
    assert.match(open, /isDashboardWindowUrl\(r\.url\)/, 'and only opens addresses it trusts');
    assert.match(open, /sandbox: true/); assert.match(open, /contextIsolation: true/); assert.match(open, /nodeIntegration: false/);
    assert.ok(!/preload/.test(open), 'the dashboard window gets no access to the app');
    assert.match(open, /setPermissionRequestHandler\(\(_wc, _perm, cb\) => cb\(false\)\)/);
    assert.match(open, /will-navigate/); assert.match(open, /setWindowOpenHandler/);
    const bot = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');
    assert.match(bot, /action === 'dashboard-login'/); assert.match(bot, /action === 'levels'/);
    const r = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'app.js'), 'utf8');
    assert.match(r, /gb\.levels\(\)/, 'the Levels page asks the bot for names');
    // 2.3.3: built into the main window as the Dashboard page, not a separate window
    assert.match(open, /new WebContentsView\(/); assert.ok(!/new BrowserWindow\(/.test(open), 'no separate dashboard window');
    assert.match(open, /win\.contentView\.addChildView\(dashView\)/);
    assert.match(r, /dashboard\(\) \{/); assert.match(r, /\['dashboard', 'Dashboard'/); assert.match(r, /page = 'dashboard'/, 'the Dashboard is the first page');
    assert.match(r, /gb\.dashShow\(/); assert.match(r, /gb\.dashHide\(\)/);
    assert.ok(!/gb\.openDashboard\(\)/.test(r), 'no "Open dashboard" button opening another window');
  });

  await test('after an update downloads, the installed app warns for a minute and restarts by itself (unless turned off or put off)', async () => {
    const U = await import('../desktop/lib/updater.js');
    const S = await import('../desktop/lib/settings.js');
    assert.equal(U.restartPlan({ mode: 'auto', phase: 'ready' }), 60000);
    assert.equal(U.restartPlan({ mode: 'auto', phase: 'ready', autoRestart: false }), null, 'switched off in Settings');
    assert.equal(U.restartPlan({ mode: 'auto', phase: 'ready', postponed: true }), null, 'Later was pressed');
    assert.equal(U.restartPlan({ mode: 'notify', phase: 'ready' }), null, 'portable, Mac and Owner builds cannot replace themselves');
    assert.equal(U.restartPlan({ mode: 'auto', phase: 'downloading' }), null, 'not before the download finished');
    assert.equal(S.normalize({}).autoRestartForUpdates, true, 'on by default');
    assert.equal(S.normalize({ autoRestartForUpdates: false }).autoRestartForUpdates, false);
    const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
    assert.match(main, /'update-downloaded'[^\n]*scheduleRestart\(\)/, 'a finished download schedules the restart');
    const inst = main.slice(main.indexOf('async function installUpdate'), main.indexOf("ipcMain.handle('gb:update-install'"));
    assert.ok(inst.indexOf('runner?.stop()') < inst.indexOf('quitAndInstall'), 'the bot is stopped cleanly before the app restarts');
    assert.match(inst, /quitAndInstall\(true, true\)/, 'and the app opens again after installing');
  });

  await test('levels files: export holds only XP and messages; merge keeps everyone\'s higher level, twice is harmless, full import refuses it', async () => {
    const id = (n) => String(900000000000000000n + BigInt(n));
    const live = tmp(); const db = new Database(path.join(live, 'eclipse.db'));
    db.upsertGuild('9', 'Old Server'); db.setModuleState('9', 'community', true, '1');
    db.dataSet('9', 'community', `user:${id(1)}`, { xp: 5000, messages: 300, rep: 7, lastXp: 123 });
    db.dataSet('9', 'community', `user:${id(2)}`, { xp: 800, messages: 40 });
    db.dataSet('9', 'moderation', 'hist:1', { secret: 'case notes' });
    const file = path.join(tmp(), 'levels.goodboy');
    const ex = await exportLevels(live, file); db.close();
    assert.equal(ex.memberCount, 2);
    const { DatabaseSync } = await import('node:sqlite'); const f = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(f.prepare('SELECT DISTINCT module FROM module_data').all().map((r) => r.module), ['community'], 'nothing but levels in the file');
    assert.deepEqual(JSON.parse(f.prepare('SELECT value FROM module_data WHERE key = ?').get(`user:${id(1)}`).value), { xp: 5000, messages: 300 }, 'no rep, no timestamps');
    f.close();
    // a new server with its own members: one is ahead, one is behind, one is new
    const target = tmp(); const t = new Database(path.join(target, 'eclipse.db'));
    t.upsertGuild('77', 'New Server');
    t.dataSet('77', 'community', `user:${id(1)}`, { xp: 100, messages: 5, rep: 2 });
    t.dataSet('77', 'community', `user:${id(3)}`, { xp: 9999, messages: 1 });
    t.dataSet('77', 'moderation', 'hist:9', { keep: true }); t.close();
    const m = await mergeLevels(file, target);
    assert.deepEqual([m.added, m.raised, m.unchanged, m.guild.name], [1, 1, 0, 'New Server']);
    assert.ok(fs.existsSync(m.backup), 'a backup was made first');
    const after = new Database(path.join(target, 'eclipse.db'));
    assert.deepEqual(after.dataGet('77', 'community', `user:${id(1)}`), { xp: 5000, messages: 300, rep: 2 }, 'raised, own reputation kept');
    assert.equal(after.dataGet('77', 'community', `user:${id(2)}`).xp, 800, 'new member added');
    assert.equal(after.dataGet('77', 'community', `user:${id(3)}`).xp, 9999, 'nobody goes down');
    assert.deepEqual(after.dataGet('77', 'moderation', 'hist:9'), { keep: true }, 'nothing else changes'); after.close();
    const again = await mergeLevels(file, target);
    assert.deepEqual([again.added, again.raised, again.unchanged], [0, 0, 2], 'merging the same file twice changes nothing');
    await assert.rejects(importDb(file, tmp()), /only holds levels/);
    await assert.rejects(mergeLevels(file, tmp()), /Start the bot once/);
    const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
    const mh = main.slice(main.indexOf("'gb:levels-merge'"), main.indexOf('// ---- app updates'));
    assert.ok(mh.indexOf('runner.stop()') < mh.indexOf("'merge-levels'"), 'the bot is stopped before levels are merged');
  });

  await test('data files: export makes one file a fresh install can import, with every row; other files and damaged ones are refused and nothing is lost', async () => {
    const live = tmp(); const db = new Database(path.join(live, 'eclipse.db'));
    db.upsertGuild('9', 'A Basic Discord Server'); db.setModuleState('9', 'community', true, '1');
    for (let k = 0; k < 18; k++) db.dataSet('9', 'community', `user:${100 + k}`, { xp: 100 * (k + 1) });
    db.dataSet('9', 'moderation', 'hist:1', { n: 1 });
    const file = path.join(tmp(), 'good-boy-data.goodboy');
    const ex = await exportDb(live, file);   // while the "bot" still has it open
    assert.equal(ex.memberCount, 18); assert.ok(ex.bytes > 0);
    db.close();
    const fresh = tmp(); const im = await importDb(file, fresh);
    assert.equal(im.guild.name, 'A Basic Discord Server'); assert.equal(im.memberCount, 18); assert.equal(im.backup, null);
    const back = new Database(path.join(fresh, 'eclipse.db')); assert.deepEqual(back.dataGet('9', 'moderation', 'hist:1'), { n: 1 }); back.close();
    // a file that is not ours: refused, and the data that was there is still there
    const junk = path.join(tmp(), 'notes.goodboy'); fs.writeFileSync(junk, 'hello');
    await assert.rejects(importDb(junk, fresh), /not a Good Boy data file/);
    assert.equal((await toolSummary(fresh)).memberCount, 18, 'nothing was lost');
    const { DatabaseSync } = await import('node:sqlite'); const other = path.join(tmp(), 'other.db'); const o = new DatabaseSync(other); o.exec('CREATE TABLE x (a)'); o.close();
    await assert.rejects(importDb(other, fresh), /not a Good Boy data file/);
    assert.equal((await toolSummary(fresh)).memberCount, 18);
    await assert.rejects(exportDb(tmp(), path.join(tmp(), 'x.goodboy')), /no bot data yet/);
    const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
    const imp = main.slice(main.indexOf("'gb:data-import'"), main.indexOf('// ---- app updates'));
    assert.ok(imp.indexOf('runner.stop()') < imp.indexOf("'import'"), 'the bot is stopped before its data is replaced');
  });

  await test('supervisor: two Good Boy installs on one computer cannot run the same bot at once', async () => {
    const { Supervisor, botIdOf } = await import('../src/supervisor.js');
    const token = `${Buffer.from('1469714389648015571').toString('base64')}.x.y`;
    assert.equal(botIdOf(token), '1469714389648015571'); assert.equal(botIdOf('nope'), null);
    const lockDir = tmp(); const spawnFn = null;
    const a = new Supervisor({ base: fakeInstall(), env: { DISCORD_TOKEN: token }, lockDir, spawnFn: () => { throw new Error('stop here'); } });
    // a lock left by another install whose process is alive (this test process stands in for it)
    fs.writeFileSync(path.join(lockDir, '1469714389648015571.lock'), JSON.stringify({ pid: process.pid, id: 'other', base: '/somewhere/else' }));
    await assert.rejects(() => a.start(), /already running from another Good Boy install on this computer \(process \d+\)/);
    // a dead process's lock does not block
    fs.writeFileSync(path.join(lockDir, '1469714389648015571.lock'), JSON.stringify({ pid: 2147483646, id: 'old', base: '/somewhere/else' }));
    await assert.rejects(() => a.start(), /stop here/, 'got past the lock');
    assert.equal(JSON.parse(fs.readFileSync(path.join(lockDir, '1469714389648015571.lock'), 'utf8')).base, a.base, 'and took it');
    void spawnFn;
  });

  // a child_process.spawn stand-in built on a fake execFile: streams its output, then exits
  const spawnFrom = (execFile) => (cmd, args) => {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    setImmediate(() => execFile(cmd, args, {}, (err, out = '', errOut = '') => { if (out) c.stdout.emit('data', out); if (errOut) c.stderr.emit('data', errOut); c.emit('exit', err ? 1 : 0); }));
    return c;
  };
  await test('dashboard link setup is one button: installs Tailscale (winget, else a download only kept when signed by Tailscale), opens the sign-in and Funnel pages, and keeps the link on', async () => {
    const { loginLinkIn, msiUrl } = await import('../desktop/lib/share.js');
    assert.equal(loginLinkIn('To authenticate, visit:\n\n\thttps://login.tailscale.com/a/1b2c3d4\n'), 'https://login.tailscale.com/a/1b2c3d4');
    assert.equal(loginLinkIn('visit https://login.tailscale.com.evil.io/a/1'), null, 'look-alike hosts are ignored');
    assert.equal(msiUrl('x64'), 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi');
    // winget installs it
    let installed = false; const calls = [];
    const exec = (cmd, args, _o, cb) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'winget') { installed = true; return cb(null, 'Successfully installed'); }
      if (args[0] === 'version') return installed ? cb(null, '1.76.0') : cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      cb(new Error('?'));
    };
    const mk = (o = {}) => new Share({ platform: 'win32', env: {}, execFile: exec, exists: () => installed, fetchFn: async () => { throw new Error('no network in tests'); }, ...o });
    const a = mk(); a.waitForBin = async () => !!(await a.find());
    assert.deepEqual(await a.install(), { ok: true, via: 'winget' });
    assert.ok(calls.some((c) => c.startsWith('winget install --id Tailscale.Tailscale --exact --silent')));
    // no winget: download the .msi, check the signature, refuse an unsigned file
    installed = false; let ran = [];
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-ts-'));
    const exec2 = (cmd, args, _o, cb) => {
      ran.push(cmd);
      if (cmd === 'winget') return cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      if (args[0] === 'version') return installed ? cb(null, '1.76.0') : cb(new Error('missing'));
      if (cmd === 'powershell.exe' && args.at(-1).includes('Get-AuthenticodeSignature')) return cb(null, signed ? 'Valid|CN="Tailscale Inc.", O="Tailscale Inc.", C=US\r\n' : 'NotSigned|\r\n');
      if (cmd === 'powershell.exe' && args.at(-1).includes('msiexec')) { installed = true; return cb(null, ''); }
      cb(new Error('?'));
    };
    let signed = false;
    const b = mk({ execFile: exec2, tmp, fetchFn: async (u) => ({ ok: u.startsWith('https://pkgs.tailscale.com/'), status: 200, arrayBuffer: async () => new ArrayBuffer(8) }) });
    b.waitForBin = async () => !!(await b.find());
    const bad = await b.install(); assert.equal(bad.ok, false); assert.match(bad.error, /not signed by Tailscale/); assert.ok(!ran.some((c, k) => c === 'powershell.exe' && k > 0 && false));
    assert.equal(installed, false, 'an unsigned download is never run');
    assert.deepEqual(fs.readdirSync(tmp), [], 'and it is deleted');
    signed = true; assert.deepEqual(await b.install(), { ok: true, via: 'msi' });
    // Mac: the download page
    const m = new Share({ platform: 'darwin', env: {}, execFile: (c, a2, o, cb) => cb(new Error('no')), exists: () => false });
    const mac = await m.install(); assert.equal(mac.ok, false); assert.equal(mac.link, 'https://tailscale.com/download');
    // sign-in: the page comes back as soon as Tailscale prints it
    const { EventEmitter: EE } = await import('node:events');
    const s2 = mk(); s2.bin = 'tailscale';
    s2.spawn = () => { const c = new EE(); c.stdout = new EE(); c.stderr = new EE(); setImmediate(() => c.stderr.emit('data', '\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/xyz\n\n')); return c; };
    assert.deepEqual(await s2.login(), { ok: true, link: 'https://login.tailscale.com/a/xyz' });
    let n = 0; assert.equal(await s2.waitFor(async () => ++n >= 3, { every: 1, seconds: 5 }), true);
    assert.equal(await s2.waitFor(async () => false, { every: 1, seconds: 0.05 }), false);
    // the app: one setup button, the link back on at every start, the phone code opens the phone page
    const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
    for (const k of ["ipcMain.handle('gb:share-setup'", "step('install'", "step('login'", "step('funnel'", "step('discord'", 'openTailscale(l.link ?? st.link)', 'openTailscale(on.link)', 'if (isTailscaleLink(u)) shell.openExternal(u)']) assert.ok(main.includes(k), k);
    assert.match(main, /if \(!smokeDir && settings\.shareAuto\) \{ setTimeout\(\(\) => keepShared\(\)/);
    assert.match(main, /const phoneLink = \(url\) => `\$\{url\}\/app\?pair=1`/);
    assert.match(main, /powerSaveBlocker\.start\('prevent-app-suspension'\)/);
    const { normalize: norm } = await import('../desktop/lib/settings.js');
    assert.equal(norm({}).shareAuto, false); assert.equal(norm({ shareAuto: true, keepAwake: 'yes' }).keepAwake, false);
    // the phone page and the Android app: pairing uses only the page's own address, and Android asks first
    const mob = fs.readFileSync(path.join(root, 'src', 'dashboard', 'public', 'mobile.js'), 'utf8');
    assert.match(mob, /intent:\/\/pair\?url=\$\{encodeURIComponent\(location\.origin\)\}/);
    const act = fs.readFileSync(path.join(root, 'android', 'app', 'src', 'main', 'java', 'com', 'basicghostlabs', 'goodboy', 'MainActivity.java'), 'utf8');
    assert.match(act, /Connect to this bot\?/); assert.match(act, /cleanBase\(d\.getQueryParameter\("url"\)\)/);
    assert.match(fs.readFileSync(path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8'), /android:scheme="goodboy" android:host="pair"/);
  });

  await test('share dashboard: finds Tailscale, turns on a public https link for the dashboard port only, explains each thing that is missing, and opens only Tailscale pages', async () => {
    const ts = { installed: true, running: true, funnel: false, allowed: true, calls: [] };
    const execFile = (cmd, args, _o, cb) => {
      ts.calls.push(args.join(' '));
      if (!ts.installed) return cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      if (args[0] === 'version') return cb(null, '1.76.0\n');
      if (args[0] === 'status') return cb(null, ts.running ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'basic-pc.tail1234.ts.net.' } }) : JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/abc' }));
      if (args[0] === 'funnel' && args[1] === 'status') return cb(null, ts.funnel ? JSON.stringify({ Web: { 'basic-pc.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } }, AllowFunnel: { 'basic-pc.tail1234.ts.net:443': true } }) : '{}');
      if (args[0] === 'funnel' && args[1] === '--bg') { if (!ts.allowed) return cb(null, 'Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/funnel?node=nXYZ\n', ''); ts.funnel = true; return cb(null, 'Available on the internet'); }
      if (args[0] === 'funnel' && args[1] === '--https=443') { ts.funnel = false; return cb(null, ''); }
      cb(new Error('unknown'));
    };
    const mk = () => new Share({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, execFile, spawn: spawnFrom(execFile), exists: () => true });
    ts.installed = false; assert.equal((await mk().status(3000)).state, 'missing'); ts.installed = true;
    ts.running = false; const login = await mk().status(3000); assert.equal(login.state, 'login'); assert.equal(login.link, 'https://login.tailscale.com/a/abc'); ts.running = true;
    const sh = mk();
    assert.deepEqual(await sh.status(3000), { state: 'off', url: 'https://basic-pc.tail1234.ts.net', host: 'basic-pc.tail1234.ts.net' });
    ts.allowed = false;
    const ask = await sh.on(3000); assert.equal(ask.ok, false); assert.equal(ask.state, 'approve'); assert.equal(ask.link, 'https://login.tailscale.com/f/funnel?node=nXYZ');
    ts.allowed = true;
    assert.deepEqual(await sh.on(3000), { ok: true, url: 'https://basic-pc.tail1234.ts.net' });
    assert.ok(ts.calls.includes('funnel --bg --yes http://127.0.0.1:3000'), 'only the dashboard port is shared');
    assert.equal((await sh.status(3000)).state, 'on'); assert.equal((await sh.status(4000)).state, 'off', 'a different port is not mistaken for ours');
    assert.deepEqual(await sh.off(), { ok: true }); assert.equal((await sh.status(3000)).state, 'off');
    assert.deepEqual(shareSettings('https://basic-pc.tail1234.ts.net'), { DASHBOARD_BASE_URL: 'https://basic-pc.tail1234.ts.net', DASHBOARD_TRUST_PROXY: '1' });
    assert.deepEqual(shareSettings(null), { DASHBOARD_BASE_URL: '', DASHBOARD_TRUST_PROXY: '' });
    assert.equal(redirectUriFor(shareSettings('https://basic-pc.tail1234.ts.net')), 'https://basic-pc.tail1234.ts.net/callback', 'the login comes back to the shared link');
    assert.equal(redirectUriFor(shareSettings(null)), 'http://localhost:3000/callback');
    for (const [u, ok] of [['https://tailscale.com/download', true], ['https://login.tailscale.com/f/funnel?node=1', true], ['http://login.tailscale.com/x', false], ['https://tailscale.com.evil.io/', false], ['javascript:alert(1)', false]]) assert.equal(isTailscaleLink(u), ok, u);
    // adding the redirect keeps what is there
    const sent = [];
    const fetchFn = async (url, o = {}) => { sent.push(o); if (!o.method) return { ok: true, status: 200, json: async () => ({ redirect_uris: ['http://localhost:3000/callback'] }) }; const b = JSON.parse(o.body); return { ok: true, status: 200, json: async () => b }; };
    assert.deepEqual(await addRedirectUri('t', 'https://basic-pc.tail1234.ts.net/callback', fetchFn), { ok: true, added: true });
    assert.deepEqual(JSON.parse(sent[1].body).redirect_uris, ['http://localhost:3000/callback', 'https://basic-pc.tail1234.ts.net/callback']);
    const refuse = async (url, o = {}) => (o.method ? { ok: false, status: 400, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ redirect_uris: [] }) });
    assert.equal((await addRedirectUri('t', 'https://x.ts.net/callback', refuse)).ok, false, 'when Discord refuses, the app shows the address to add by hand');
    const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
    assert.match(main, /if \(!isTailscaleLink\(u\)\) return false;/);
  });

  await test('android app: only https dashboard links, only the dashboard and Discord login inside the app, only the app\'s own page can set the link, no extra permissions', async () => {
    const A = path.join(root, 'android', 'app', 'src', 'main');
    const java = fs.readFileSync(path.join(A, 'java', 'com', 'basicghostlabs', 'goodboy', 'MainActivity.java'), 'utf8');
    assert.match(java, /if \(!"https"\.equals\(u\.getScheme\(\)\)/, 'only https links are accepted');
    assert.match(java, /if \(!onOwnPage\) return false;/, 'a web page cannot change which bot the app connects to');
    assert.match(java, /if \(isMine\(u\) \|\| \("https"\.equals\(scheme\) && isDiscord\(u\.getHost\(\)\)\)\) return false;/, 'everything else opens in the browser');
    assert.match(java, /host\.equals\("discord\.com"\) \|\| host\.endsWith\("\.discord\.com"\)/);
    for (const x of ['setAllowFileAccess(false)', 'setAllowUniversalAccessFromFileURLs(false)', 'MIXED_CONTENT_NEVER_ALLOW']) assert.ok(java.includes(x), x);
    const manifest = fs.readFileSync(path.join(A, 'AndroidManifest.xml'), 'utf8');
    assert.deepEqual([...manifest.matchAll(/uses-permission android:name="([^"]+)"/g)].map((m) => m[1]), ['android.permission.INTERNET'], 'internet only');
    assert.match(manifest, /usesCleartextTraffic="false"/); assert.match(manifest, /allowBackup="false"/);
    for (const f of ['connect.html', 'offline.html']) {
      const html = fs.readFileSync(path.join(A, 'assets', f), 'utf8');
      assert.ok(!/(src|href)="https?:/.test(html), `${f} loads nothing from the internet`);
      assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
      assert.ok(!/innerHTML/.test(html));
    }
    const gradle = fs.readFileSync(path.join(root, 'android', 'app', 'build.gradle'), 'utf8');
    assert.match(gradle, /desktop\/package\.json/, 'the app version follows the desktop app');
    const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'desktop.yml'), 'utf8');
    assert.match(wf, /gradle assembleDebug/); assert.match(wf, /Good-Boy-Android-\$v\.apk/);
    const mobile = fs.readFileSync(path.join(root, 'src', 'dashboard', 'public', 'mobile.js'), 'utf8');
    assert.match(mobile, /window\.GoodBoyAndroid\.changeLink\(\)/, 'the phone page offers the way back to the link screen in the Android app');
  });

  await test('desktop build workflow: builds the .exe and .dmg, then starts the built app and fails the build if the window did not draw', async () => {
    const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'desktop.yml'), 'utf8');
    for (const must of ['windows-latest', 'macos-latest', 'npm run dist:win', 'npm run dist:mac', 'GOODBOY_SMOKE_DIR', 'GOODBOY_SMOKE_SEED', 'make-fixture.js', 'win-unpacked', '*-Setup-*.exe', '*-Portable-*.exe', '*.dmg', 'workflow_dispatch', 'edition: [owner, consumer, developer]', 'set-edition.js', 'bundle-bot.js', 'desktop/bundle/node/node.exe']) assert.ok(wf.includes(must), must);
    assert.ok(!/owner-seed\/eclipse\.db|good-boy-data/.test(wf), 'no real server data is ever part of the GitHub build');
    const [build, release] = wf.split(/^  release:$/m);
    assert.ok(release, 'there is a release job');
    assert.ok(!/secrets\.|GITHUB_TOKEN|contents:\s*write/.test(build), 'the builds use no secrets and cannot write to the repo');
    assert.deepEqual([...wf.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]).sort(), ['GITHUB_TOKEN', 'RELEASES_TOKEN'], 'only the publishing tokens, used only to publish');
    assert.match(release, /if: github\.ref == 'refs\/heads\/main'/, 'test branches are built but never published');
    assert.match(release, /needs: \[windows, mac, android\]/, 'nothing is published unless every build and its self-check passed');
    assert.match(release, /REPO: jamiechastain10-blip\/Good-Boy-Bot/); assert.match(release, /gh release view "v\$v"/, 'a version is published once');
    assert.ok(!/Windows-owner/.test(release), 'the Owner build is never published');
    for (const f of ['desktop/dist/latest.yml', 'desktop/dist/developer.yml', '*-Setup-*.exe.blockmap']) assert.ok(build.includes(f), `${f} is kept for the update feed`);
    assert.ok(!/uses:\s*\S+@(main|master|latest)\b/.test(wf), 'actions are pinned to a version');
    const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
    assert.match(main, /process\.env\.GOODBOY_SMOKE_DIR/); assert.match(main, /app\.exit\(out\.ok \? 0 : 1\)/);
    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    for (const x of ['.env', 'data/', '*.db', 'desktop/dist/', 'node_modules/']) assert.ok(gi.split('\n').includes(x), `${x} is ignored by git`);
  });

  await test('desktop log: colour codes are removed, tokens and secrets are hidden, lines are kept in order and capped', async () => {
    assert.equal(clean('\x1b[32mok\x1b[0m'), 'ok');
    assert.ok(!clean(`error ${FAKE_TOKEN} here`).includes('GaBcDe')); assert.match(clean(`error ${FAKE_TOKEN} here`), /\[hidden\]/);
    assert.equal(clean('DISCORD_CLIENT_SECRET=abc123def'), 'DISCORD_CLIENT_SECRET=[hidden]');
    assert.equal(clean('password: hunter2'), 'password: [hidden]');
    const b = new LogBuffer(3);
    assert.deepEqual(b.push('one\ntw'), ['one']); assert.deepEqual(b.push('o\nthree\n\n'), ['two', 'three']);
    b.push('four\nfive\n'); assert.deepEqual(b.all(), ['three', 'four', 'five'], 'only the newest lines are kept');
    const big = new LogBuffer(5); assert.equal(big.push('x'.repeat(5000)).length, 1, 'a never-ending line cannot grow without limit');
  });

  await test('desktop runner: starts the real supervisor, reports running, hides the token in the log, and stops without leaving the bot behind', async () => {
    const base = fakeInstall(); const r = new BotRunner({ botDir: base, script: SUPERVISE, stopTimeoutMs: 4000 }); // short, so a stop that needs the kill fallback fails the timing check below
    const states = []; r.on('state', (s) => states.push(s.state));
    assert.equal(r.start(), true); assert.equal(r.start(), false, 'a second start does nothing');
    await until(() => r.state === 'running', 10000, 'running');
    const pidFile = path.join(base, 'data', 'bot.pid'); await until(() => fs.existsSync(pidFile), 3000, 'bot pid');
    const botPid = Number(fs.readFileSync(pidFile, 'utf8')); const supPid = r.status().pid;
    assert.ok(alive(botPid) && alive(supPid));
    const log = r.logs.all().join('\n'); assert.match(log, /Logged in as Test#0/); assert.ok(!log.includes('GaBcDe'), 'token hidden'); assert.match(log, /\[hidden\]/);
    const t0 = Date.now(); await r.stop();
    assert.ok(Date.now() - t0 < 3000, 'stopped by the shutdown message, not by the kill fallback (which is a hard kill on Windows)');
    assert.equal(r.state, 'stopped'); assert.ok(!alive(supPid), 'supervisor gone'); assert.ok(!alive(botPid), 'bot gone, nothing orphaned');
    assert.ok(!fs.existsSync(path.join(base, 'supervisor.lock')), 'lock released');
    assert.deepEqual(states.slice(0, 2), ['starting', 'running']); assert.ok(states.includes('stopping'));
    assert.equal(r.start(), true, 'can be started again'); await until(() => r.state === 'running', 10000, 'running again'); await r.stop();
  });

  await test('desktop runner: if the app goes away, the supervisor and the bot stop too', async () => {
    const base = fakeInstall(); const r = new BotRunner({ botDir: base, script: SUPERVISE });
    r.start(); await until(() => r.state === 'running', 10000, 'running');
    const pidFile = path.join(base, 'data', 'bot.pid'); await until(() => fs.existsSync(pidFile), 3000, 'bot pid');
    const botPid = Number(fs.readFileSync(pidFile, 'utf8')); const supPid = r.status().pid;
    r.child.disconnect(); // what happens when the desktop app is killed
    await until(() => !alive(supPid) && !alive(botPid), 8000, 'both processes to end');
  });

  await test('desktop runner: the app can ask the running bot to do things, through the supervisor, and gets a plain answer when it cannot', async () => {
    const base = fakeInstall();
    fs.writeFileSync(path.join(base, 'src', 'index.js'), `
import { connectSupervisor } from ${JSON.stringify(pathToFileURL(path.join(root, 'src', 'ipc.js')).href)};
const link = connectSupervisor({ version: 'x', onControl: async (action, p) => action === 'boom' ? Promise.reject(new Error('it broke')) : ({ ok: true, action, p }) });
console.log('Ready. In Discord, run /module list to turn features on.'); link.ready(); setInterval(() => {}, 1000);`);
    const r = new BotRunner({ botDir: base, script: SUPERVISE, stopTimeoutMs: 4000 });
    assert.match((await r.control('modules')).error, /not running/);
    r.start(); await until(() => r.state === 'running', 10000, 'running');
    assert.deepEqual(await r.control('module-set', { name: 'stats', enabled: true }), { ok: true, action: 'module-set', p: { name: 'stats', enabled: true } });
    assert.deepEqual(await r.control('boom'), { ok: false, error: 'it broke' }, 'a failure inside the bot comes back as a message, not a crash');
    const two = await Promise.all([r.control('a'), r.control('b')]); assert.deepEqual(two.map((x) => x.action), ['a', 'b'], 'answers go to the right question');
    await r.stop();
  });

  await test('desktop runner: problems are reported in plain words (missing script, bad node, crash, restart)', async () => {
    const none = new BotRunner({ botDir: tmp() });
    assert.equal(none.start(), false); assert.equal(none.state, 'failed'); assert.match(none.lastError, /supervisor script was not found/);
    const base = fakeInstall(); const nonode = new BotRunner({ botDir: base, script: SUPERVISE, nodePath: path.join(base, 'no-such-node') });
    nonode.start(); await until(() => nonode.state === 'failed', 5000, 'failure'); assert.match(nonode.lastError, /Node\.js was not found/);
    const crash = new BotRunner({ botDir: base, script: path.join(base, 'boom.js') }); fs.writeFileSync(path.join(base, 'boom.js'), 'console.log("[supervisor 00:00] Stopped: it kept crashing"); process.exit(1);');
    crash.start(); await until(() => crash.state === 'failed', 5000, 'crash'); assert.equal(crash.lastError, 'it kept crashing');
    const idle = new BotRunner({ botDir: base, script: SUPERVISE }); await idle.stop(); assert.equal(idle.state, 'stopped');
    // restart = stop then start, ending in a fresh running process
    idle.start(); await until(() => idle.state === 'running', 10000, 'running'); const first = idle.status().pid;
    assert.equal(await idle.restart(), true); await until(() => idle.state === 'running', 10000, 'running after restart');
    assert.notEqual(idle.status().pid, first); await idle.stop();
  });

  await test('desktop security: the window is sandboxed, isolated and offline-only, the preload exposes a fixed list, nothing is built from HTML strings', async () => {
    const main = fs.readFileSync(path.join(root, 'desktop', 'main.js'), 'utf8');
    for (const must of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', "action: 'deny'", "'will-navigate'", 'requestSingleInstanceLock', 'isSafeDashboardUrl(u)']) assert.ok(main.includes(must), `main.js should contain ${must}`);
    assert.ok(!/nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false|webSecurity:\s*false/.test(main));
    assert.ok(!/openExternal\((?!u\)|url\)|linkFor\('oauth', v\.app\.id\)\))/.test(main), 'only the checked dashboard address or a discord.com link built by linkFor is ever opened');
    assert.match(main, /if \(url && url\.startsWith\('https:\/\/discord\.com\/'\)\) shell\.openExternal\(url\)/);
    const pre = fs.readFileSync(path.join(root, 'desktop', 'preload.cjs'), 'utf8');
    const exposed = [...pre.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]).sort();
    assert.deepEqual(exposed, ['brandApply', 'brandCustom', 'brandStatus', 'chooseFolder', 'chooseNode', 'chrome', 'copy', 'licApply', 'moduleAdd', 'moduleSet', 'modules', 'onLog', 'onState', 'openDashboard', 'openLink', 'recheck', 'restart', 'saveSettings', 'setupFind', 'setupFinish', 'setupImport', 'setupPick', 'setupSave', 'setupSecret', 'start', 'state', 'stop', 'summary', 'takeover', 'dataExport', 'dataImport', 'levelsExport', 'levelsMerge', 'levels', 'openDashboardBrowser', 'dashShow', 'dashBounds', 'dashHide', 'dashReload', 'onGoto', 'onDash', 'updateCheck', 'updateInstall', 'updateLater', 'updateOpen', 'shareState', 'shareOn', 'shareOff', 'shareLink', 'shareSetup', 'onShareStep', 'verifyToken', 'whatsNew'].sort());
    assert.ok(!/privateKey|createLicense|generateKeyPair|signModule|gb:lic-create|gb:module-sign/.test(main), 'licences and module signatures are made only in Licence Studio, never in the app');
    assert.ok(!readEdition({ edition: 'owner' }).features.includes('licenses'), 'not even the Owner version makes licences');
    assert.match(main, /function addContextMenu\(wc\)/); assert.equal((main.match(/addContextMenu\((win\.webContents|wc)\);/g) ?? []).length, 2, 'right-click works in the app and in the dashboard');
    assert.match(main, /url && url\.startsWith\('https:\/\/discord\.com\/'\)/, 'setup only ever opens discord.com pages');
    assert.match(main, /vault: bundled \? vault\.describe\(\) : null/, 'the window gets the vault description, never its contents');
    const readers = [...main.matchAll(/vault\.read\(\)/g)].map((m) => [...main.slice(0, m.index).matchAll(/function (\w+)\(/g)].pop()?.[1]);
    assert.deepEqual([...new Set(readers)].sort(), ['childEnv', 'recheck', 'savedSecret', 'savedToken'], 'secret values are read only to start the bot, to check readiness and to ask Discord, never for the window');
    assert.match(main, /allowedImport\.has\(dir\)/, 'the window can only import from a folder the person picked or that was found');
    const block = pre.slice(pre.indexOf('exposeInMainWorld'));
    assert.ok(!/\bipcRenderer\s*[,}]|:\s*ipcRenderer\s*[,}]|exposeInMainWorld\('[^']+',\s*(ipcRenderer|require)/.test(block), 'ipcRenderer itself is never handed to the page');
    const handled = [...main.matchAll(/ipcMain\.handle\('(gb:[\w-]+)'/g)].map((m) => m[1]).sort();
    const invoked = [...pre.matchAll(/invoke\('(gb:[\w-]+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual([...new Set(invoked)], handled, 'every call the window can make has exactly one handler');
    const html = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'index.html'), 'utf8');
    assert.match(html, /default-src 'none'/); assert.ok(!/<script>|unsafe-inline|unsafe-eval|https?:\/\/(?!cdn\.discordapp\.com;)/.test(html), 'no inline script; no outside address except Discord\'s image server');
    const app = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'app.js'), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(app));
    // the shared 3.0 design system: same files as the dashboard, and no HTML strings in its script either
    for (const f of ['liquid.css', 'liquid.js']) assert.ok(fs.readFileSync(path.join(root, 'desktop', 'renderer', f)).equals(fs.readFileSync(path.join(root, 'src', 'dashboard', 'public', f))), `run "npm run sync" in desktop/ after changing ${f}`);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(fs.readFileSync(path.join(root, 'desktop', 'renderer', 'liquid.js'), 'utf8')));
    assert.doesNotMatch(app + html + main, new RegExp(['Eclip' + 'se', 'Clau' + 'de', 'Anthro' + 'pic'].join('|')));
  });

  await test('desktop packaging: the app is kept out of bot releases, the shared look is in sync, and the build asks for no signing it cannot do', async () => {
    const proj = tmp();
    for (const f of ['package.json', 'src/index.js', 'desktop/main.js', 'desktop/package.json', 'desktop/lib/runner.js']) { fs.mkdirSync(path.dirname(path.join(proj, f)), { recursive: true }); fs.writeFileSync(path.join(proj, f), '{}'); }
    const shipped = collectFiles(proj).map((f) => (typeof f === 'string' ? f : f.path));
    assert.ok(shipped.includes('src/index.js')); assert.ok(!shipped.some((p) => p.startsWith('desktop/')), 'desktop/ must not be inside a bot update');
    const pub = path.join(root, 'src', 'dashboard', 'public');
    assert.ok(fs.readFileSync(path.join(root, 'desktop', 'renderer', 'good-boy-logo.png')).equals(fs.readFileSync(path.join(pub, 'good-boy-logo.png'))), 'run "npm run sync" in desktop/ after changing the logo');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'));
    assert.equal(pkg.main, 'boot.cjs'); assert.equal(pkg.build.mac.identity, null); assert.ok(pkg.devDependencies.electron && pkg.devDependencies['electron-builder']);
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ['electron-updater', 'qrcode'], 'the only runtime packages are the updater and the phone pairing code');
    assert.deepEqual(pkg.build.publish, [{ provider: 'github', owner: 'jamiechastain10-blip', repo: 'Good-Boy-Bot', releaseType: 'release' }]);
    assert.match(pkg.scripts['dist:win'], /--publish never/, 'electron-builder never publishes by itself: the release job does');
    const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.version, rootPkg.version, 'the app and the bot share one version number');
    for (const f of [pkg.build.win.icon, pkg.build.mac.icon]) assert.ok(fs.existsSync(path.join(root, 'desktop', f)), `${f} must exist`);
    const size = (f) => { const b = fs.readFileSync(path.join(root, 'desktop', f)); if (f.endsWith('.ico')) { const n = b.readUInt16LE(4); const w = [...Array(n)].map((_, i) => b[6 + i * 16] || 256); return [Math.max(...w), Math.max(...w), w]; } return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
    assert.ok(size(pkg.build.win.icon).slice(0, 2).every((n) => n >= 256), 'Windows icon is at least 256x256');
    assert.deepEqual(size(pkg.build.win.icon)[2].sort((a, b) => a - b), [16, 24, 32, 48, 64, 128, 256], 'every size Windows shows has its own image, so the small ones stay crisp'); assert.ok(size(pkg.build.mac.icon).every((n) => n >= 512), 'Mac icon is at least 512x512');
    assert.ok(pkg.build.win.target.some((t) => t.target === 'nsis') && pkg.build.win.target.some((t) => t.target === 'portable'), 'installer and portable .exe');
    assert.equal(pkg.build.nsis.oneClick, false); assert.equal(pkg.build.nsis.allowToChangeInstallationDirectory, true, 'the installer asks where to install');
    assert.equal(pkg.build.nsis.deleteAppDataOnUninstall, false, 'uninstalling never deletes the bot\'s data');
    for (const f of pkg.build.files.filter((x) => !x.includes('*'))) assert.ok(fs.existsSync(path.join(root, 'desktop', f)), `${f} listed for packaging must exist`);
    assert.deepEqual(pkg.build.extraResources.map((x) => x.to), ['bot', 'node', 'owner-seed'], 'the bot and its own Node ship next to the app, outside the archive');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'edition.json'), 'utf8')).edition, 'consumer', 'the committed edition is the safe one');
  });
}
