/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Run with: npm test
 * Exercises the platform with fake Discord objects - no token or network needed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits as P } from 'discord.js';
// The older game tests read the text look; the 3.0.4 picture tests switch pictures on themselves.
globalThis[Symbol.for('goodboy.games.art')] = false;
import { Database } from '../src/db.js';
import { Permissions } from '../src/permissions.js';
import { ApiQueue } from '../src/queue.js';
import { ModuleManager } from '../src/moduleManager.js';
import { firstButtonId, modalInfo, fakeFields } from './pipe-helpers.js';
import { parseDuration, formatDuration, isPrivateIp, hierarchyError, fillTemplate, normalizeHex, sanitizeName, UserError } from '../src/util.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${process.env.DBG ? e.stack.split("\n").slice(0, 6).join("\n       ") : e.message}`); }
}
const rejectsWith = async (fn, re) => {
  try { await fn(); } catch (e) { assert.match(e.message, re); return; }
  assert.fail('expected an error but none was thrown');
};

// quiet logger for the manager under test
const quiet = { info() {}, warn() {}, error(...a) { if (process.env.DBG) console.log('ERR', ...a.map((x) => x?.stack ?? JSON.stringify(x)).slice(0, 3)); }, debug() {} };

// ---- fakes ---------------------------------------------------------------
const calls = [];
globalThis.__calls = calls;
function fakeGuild(id) {
  return { id, ownerId: 'owner', channels: { cache: new Map([['111111111111111111', {}]]) }, roles: { cache: new Map([['222222222222222222', {}], ['333333333333333333', {}]]) } };
}
const guilds = new Map([['1', fakeGuild('1')], ['2', fakeGuild('2')]]);
const synced = [];
const fakeClient = { guilds: { cache: guilds }, application: { commands: { set: async (list, gid) => { synced.push({ gid, names: list.map((c) => c.name) }); } } } };
function member(id, { bits = [], roles = [], guildId = '1' } = {}) {
  const set = new Set(bits);
  return { id, guild: { id: guildId, ownerId: 'owner' }, permissions: { has: (b) => set.has(b) }, roles: { cache: new Map(roles.map((r) => [r, {}])) } };
}
function interaction(over = {}) {
  const out = { replies: [] };
  return Object.assign(out, {
    guildId: '1', commandName: 'hostcmd', customId: 'host:x', member: member('u1'), user: { id: 'u1', tag: 'u1#0' },
    replied: false, deferred: false,
    reply: async (p) => { out.replies.push(p); out.replied = true; },
    followUp: async (p) => { out.replies.push(p); }, editReply: async (p) => { out.replies.push(p); },
  }, over);
}

// ---- generated test modules -----------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-test-'));
const write = (name, src) => { fs.mkdirSync(path.join(tmp, name), { recursive: true }); fs.writeFileSync(path.join(tmp, name, 'index.js'), src); };

write('host', `export default {
  name: 'host', version: '1.0.0', description: 'host module',
  settings: [
    { key: 'on', type: 'toggle', label: 'On', default: true },
    { key: 'n', type: 'number', label: 'N', min: 1, max: 10, default: 3 },
    { key: 'ch', type: 'channel', label: 'Channel' },
    { key: 'words', type: 'list', label: 'Words' },
    { key: 'mode', type: 'select', label: 'Mode', options: ['a', 'b'], default: 'a' },
  ],
  permissions: [{ key: 'host.use', label: 'Use it', default: 'moderator' }],
  commands: [{ data: { name: 'hostcmd', description: 'x' }, permission: 'host.use', execute: async (ctx, i) => { __calls.push(['hostcmd', ctx.guildId]); await i.reply({ content: 'ok' }); } }],
  events: { messageCreate: async (ctx, m) => { __calls.push(['host-msg', ctx.guildId, m.content]); } },
  components: [{ prefix: 'host:', execute: async (ctx, i) => { __calls.push(['host-comp', ctx.guildId]); } }],
  tasks: [{ name: 't', everyMs: 10000, runOnEnable: true, run: async (ctx) => { __calls.push(['task', ctx.guildId]); } }],
  api: { hello: () => 'hi' },
  async init(ctx) { __calls.push(['init', 'host', ctx.guildId]); },
  async destroy(ctx) { __calls.push(['destroy', 'host', ctx.guildId]); },
  async update(ctx, from) { __calls.push(['update', 'host', from]); },
};`);
write('addon-a', `export default {
  name: 'addon-a', version: '1.0.0', type: 'addon', requires: { module: 'host', version: '>=1.0.0' },
  async init(ctx) { __calls.push(['addon-init', ctx.hostApi.hello()]); },
  async destroy(ctx) { __calls.push(['destroy', 'addon-a', ctx.guildId]); },
};`);
write('addon-future', `export default { name: 'addon-future', version: '1.0.0', type: 'addon', requires: { module: 'host', version: '>=2.0.0' } };`);
write('crashy', `export default {
  name: 'crashy', version: '1.0.0',
  events: { messageCreate: async () => { throw new Error('boom'); } },
  commands: [{ data: { name: 'crashcmd', description: 'x' }, execute: async () => { throw new Error('cmd boom'); } }],
};`);
write('badinit', `export default { name: 'badinit', version: '1.0.0', async init() { throw new Error('cannot start'); } };`);
write('Bad_Name', `export default { name: 'Bad_Name', version: '1.0.0' };`);
write('mismatch', `export default { name: 'other', version: '1.0.0' };`);
write('zdupcmd', `export default { name: 'zdupcmd', version: '1.0.0', commands: [{ data: { name: 'hostcmd', description: 'x' }, execute: async () => {} }] };`);
write('reloadme', `export default { name: 'reloadme', version: '1.0.0', async init() {} };`);

console.log('\nUtilities');
await test('parseDuration / formatDuration', () => {
  assert.equal(parseDuration('10m'), 600000);
  assert.equal(parseDuration('1h30m'), 5400000);
  assert.equal(parseDuration('2d'), 172800000);
  assert.equal(parseDuration('banana'), null);
  assert.equal(parseDuration('10x'), null);
  assert.equal(formatDuration(5400000), '1h 30m');
});
await test('fillTemplate / normalizeHex / sanitizeName', () => {
  assert.equal(fillTemplate('Hi {user} in {server} {nope}', { user: 'A', server: 'B' }), 'Hi A in B {nope}');
  assert.equal(normalizeHex('ff69b4'), '#FF69B4');
  assert.equal(normalizeHex('#zzzzzz'), null);
  assert.equal(sanitizeName('  @everyone\n  `hey` '), 'everyone hey');
});
await test('SSRF guard recognises private addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.1.1', '::1', 'fd00::1']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1']) assert.ok(!isPrivateIp(ip), ip);
});
await test('hierarchyError blocks owner, self, bot and higher roles', () => {
  const m = (id, pos) => ({ id, roles: { highest: { position: pos } } });
  const guild = { ownerId: 'owner' };
  assert.match(hierarchyError(guild, m('mod', 5), m('owner', 1), m('bot', 9)), /owner/);
  assert.match(hierarchyError(guild, m('mod', 5), m('mod', 5), m('bot', 9)), /yourself/);
  assert.match(hierarchyError(guild, m('mod', 5), m('x', 6), m('bot', 9)), /equal to or above yours/);
  assert.match(hierarchyError(guild, m('mod', 12), m('x', 10), m('bot', 9)), /above mine/);
  assert.equal(hierarchyError(guild, m('mod', 7), m('x', 3), m('bot', 9)), null);
});

console.log('\nQueue');
await test('priority order and per-module cap', async () => {
  const q = new ApiQueue({ concurrency: 2, perModule: 1 });
  const order = [];
  const gates = [];
  const job = (label) => () => new Promise((r) => { gates.push(() => { order.push(label); r(); }); });
  const p1 = q.run('a', job('a1'));
  const p2 = q.run('a', job('a2'));   // blocked by perModule cap while a1 runs
  const p3 = q.run('b', job('b1'));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(gates.length, 2, 'a1 and b1 should run, a2 should wait');
  gates.shift()(); gates.shift()();
  await new Promise((r) => setTimeout(r, 10));
  gates.shift()();
  await Promise.all([p1, p2, p3]);
  assert.equal(order.length, 3);
});

console.log('\nPermissions');
const db = new Database(':memory:');
const perms = new Permissions(db);
await test('defaults, role mapping replaces defaults, admins always pass', () => {
  perms.register('host', [{ key: 'host.use', label: 'u', default: 'moderator' }, { key: 'host.any', label: 'a', default: 'everyone' }, { key: 'host.own', label: 'o', default: 'owner' }]);
  const plain = member('p'), mod = member('m', { bits: [P.KickMembers] }), admin = member('a', { bits: [P.ManageGuild] }), owner = member('owner'), withRole = member('r', { roles: ['222222222222222222'] });
  assert.equal(perms.check(plain, 'host.use'), false);
  assert.equal(perms.check(mod, 'host.use'), true);
  assert.equal(perms.check(plain, 'host.any'), true);
  assert.equal(perms.check(admin, 'host.own'), false);
  assert.equal(perms.check(owner, 'host.own'), true);
  db.permAdd('1', 'host.use', '222222222222222222');
  assert.equal(perms.check(withRole, 'host.use'), true);
  assert.equal(perms.check(mod, 'host.use'), false, 'mapping REPLACES the default');
  assert.equal(perms.check(admin, 'host.use'), true, 'admins still pass');
  db.permClear('1', 'host.use');
});

console.log('\nModule manager');
const manager = new ModuleManager({ db, perms, queue: new ApiQueue(), builtins: [{ access: 'admin', data: { name: 'module', description: 'm' }, execute: async (i) => i.reply({ content: 'builtin' }) }], log: quiet });
manager.attach(fakeClient, ['Guilds']);
await manager.discover(tmp);

await test('discovery loads valid modules and reports invalid ones without crashing', () => {
  for (const ok of ['host', 'addon-a', 'crashy', 'badinit', 'reloadme']) assert.ok(manager.defs.has(ok), `${ok} did not load: ${manager.loadErrors.get(ok)}`);
  for (const bad of ['Bad_Name', 'mismatch', 'zdupcmd']) assert.ok(manager.loadErrors.has(bad), `${bad} should be rejected`);
  assert.match(manager.loadErrors.get('zdupcmd'), /already provided|reserved/);
});

await test('enable runs init, registers commands for that server only', async () => {
  calls.length = 0;
  await manager.enable('1', 'host');
  assert.deepEqual(calls[0], ['init', 'host', '1']);
  assert.ok(manager.isActive('1', 'host') && !manager.isActive('2', 'host'));
  assert.ok(manager.commandList('1').some((c) => c.name === 'hostcmd'));
  assert.ok(!manager.commandList('2').some((c) => c.name === 'hostcmd'));
  await manager.syncCommands('1');
  assert.ok(synced.at(-1).names.includes('hostcmd') && synced.at(-1).names.includes('module'));
});

await test('events only reach servers where the module is enabled', async () => {
  calls.length = 0;
  await manager.dispatch('messageCreate', '1', { content: 'a' });
  await manager.dispatch('messageCreate', '2', { content: 'b' });
  assert.deepEqual(calls.filter((c) => c[0] === 'host-msg'), [['host-msg', '1', 'a']]);
});

await test('settings: validation, defaults, lists, reset, isolation between servers', () => {
  assert.equal(manager.ctx('1', 'host').config.get('n'), 3);
  assert.equal(manager.setSetting('1', 'host', 'n', '7'), 7);
  assert.equal(manager.ctx('1', 'host').config.get('n'), 7);
  assert.equal(manager.ctx('2', 'host').config.get('n'), 3, 'other server untouched');
  assert.throws(() => manager.setSetting('1', 'host', 'n', '99'), /between/);
  assert.throws(() => manager.setSetting('1', 'host', 'n', 'abc'), /number/);
  assert.throws(() => manager.setSetting('1', 'host', 'mode', 'zzz'), /Choose one of/);
  assert.throws(() => manager.setSetting('1', 'host', 'nope', 'x'), /no setting/);
  assert.equal(manager.setSetting('1', 'host', 'on', 'off'), false);
  assert.equal(manager.setSetting('1', 'host', 'ch', '111111111111111111'), '111111111111111111');
  assert.throws(() => manager.setSetting('1', 'host', 'ch', '999999999999999999'), /doesn't exist/);
  assert.throws(() => manager.setSetting('1', 'host', 'ch', 'not-an-id'), /valid channel/);
  assert.deepEqual(manager.setSetting('1', 'host', 'words', 'foo, bar', 'add'), ['foo', 'bar']);
  assert.deepEqual(manager.setSetting('1', 'host', 'words', 'FOO', 'remove'), ['bar']);
  assert.throws(() => manager.setSetting('1', 'host', 'n', '1', 'add'), /not a list/);
  assert.equal(manager.setSetting('1', 'host', 'n', null, 'reset'), 3);
});

await test('module data is namespaced per module and per server', () => {
  const a = manager.ctx('1', 'host'), b = manager.ctx('1', 'crashy'), c = manager.ctx('2', 'host');
  a.data.set('k', 1); b.data.set('k', 2); c.data.set('k', 3);
  assert.deepEqual([a.data.get('k'), b.data.get('k'), c.data.get('k')], [1, 2, 3]);
});

await test('command permissions are enforced centrally', async () => {
  const plain = interaction();
  await manager.handleCommand(plain);
  assert.match(plain.replies[0].content, /permission/i);
  const mod = interaction({ member: member('m', { bits: [P.KickMembers] }) });
  await manager.handleCommand(mod);
  assert.equal(mod.replies[0].content, 'ok');
  const builtinDenied = interaction({ commandName: 'module' });
  await manager.handleCommand(builtinDenied);
  assert.match(builtinDenied.replies[0].content, /Manage Server/);
});

await test('commands of disabled modules are refused even if somehow invoked', async () => {
  const i = interaction({ guildId: '2' });
  await manager.handleCommand(i);
  assert.match(i.replies[0].content, /not enabled/);
});

await test('components route by prefix to the owning module', async () => {
  calls.length = 0;
  await manager.handleComponent(interaction({ customId: 'host:xyz' }));
  assert.deepEqual(calls, [['host-comp', '1']]);
  const gone = interaction({ guildId: '2', customId: 'host:xyz' });
  await manager.handleComponent(gone);
  assert.match(gone.replies[0].content, /no longer active/);
});

await test('add-ons: need their host enabled, version-checked, can use host API', async () => {
  await rejectsWith(() => manager.enable('2', 'addon-a'), /needs \*\*host\*\* enabled first/);
  calls.length = 0;
  await manager.enable('1', 'addon-a');
  assert.deepEqual(calls.find((c) => c[0] === 'addon-init'), ['addon-init', 'hi']);
});

await test('add-on requiring a newer host version is refused', async () => {
  const rec = manager.defs.get('addon-future');
  assert.ok(rec, 'addon-future should be installed');
  await rejectsWith(() => manager.enable('1', 'addon-future'), /needs \*\*host\*\* >=2.0.0/);
});

await test('cannot disable a module that active add-ons depend on, unless cascading', async () => {
  await rejectsWith(() => manager.disable('1', 'host'), /addon-a/);
  calls.length = 0;
  await manager.disable('1', 'host', { cascade: true });
  assert.ok(calls.some((c) => c[0] === 'destroy' && c[1] === 'addon-a'));
  assert.ok(calls.some((c) => c[0] === 'destroy' && c[1] === 'host'));
  assert.ok(!manager.isActive('1', 'host') && !manager.isActive('1', 'addon-a'));
  assert.ok(!manager.commandList('1').some((c) => c.name === 'hostcmd'));
});

await test('re-enable works and saved settings survived the disable', async () => {
  manager.setSetting('1', 'host', 'n', '9');
  await manager.enable('1', 'host');
  assert.equal(manager.ctx('1', 'host').config.get('n'), 9);
});

await test('a crashing module is isolated: others still run, health reflects it', async () => {
  await manager.enable('1', 'crashy');
  calls.length = 0;
  await manager.dispatch('messageCreate', '1', { content: 'x' });
  assert.ok(calls.some((c) => c[0] === 'host-msg'), 'host still got the event');
  assert.equal(manager.status('crashy'), 'warning');
  const i = interaction({ commandName: 'crashcmd', member: member('adm', { bits: [P.Administrator] }) });
  await manager.handleCommand(i);
  assert.match(i.replies[0].content, /went wrong/);
  assert.ok(!/boom/.test(i.replies[0].content), 'internal error text must not leak to users');
  assert.ok(db.recentLogs('1', 20).some((l) => /boom/.test(l.message)), 'error was logged');
});

await test('a module that fails to start does not become active and reports why', async () => {
  await rejectsWith(() => manager.enable('1', 'badinit'), /failed to start: cannot start/);
  assert.ok(!manager.isActive('1', 'badinit'));
});

await test('scheduled tasks run once per interval', async () => {
  calls.length = 0;
  const now = Date.now();
  await manager.runTasks(now);
  await manager.runTasks(now + 1000);
  assert.equal(calls.filter((c) => c[0] === 'task').length, 1);
  await manager.runTasks(now + 11000);
  assert.equal(calls.filter((c) => c[0] === 'task').length, 2);
});

await test('restoreGuild brings back enabled modules in dependency order after a restart', async () => {
  await manager.enable('1', 'addon-a');
  const m2 = new ModuleManager({ db, perms: new Permissions(db), queue: new ApiQueue(), log: quiet });
  m2.attach(fakeClient, []);
  await m2.discover(tmp);
  await m2.restoreGuild('1');
  assert.ok(m2.isActive('1', 'host') && m2.isActive('1', 'addon-a') && m2.isActive('1', 'crashy'));
  assert.ok(!m2.isActive('1', 'badinit'));
  await m2.shutdown();
});

await test('update hook runs when the installed version is newer than the saved one', async () => {
  await manager.disable('1', 'host', { cascade: true });
  db.setModuleState('1', 'host', true, '0.9.0');
  calls.length = 0;
  await manager.enable('1', 'host');
  assert.deepEqual(calls.find((c) => c[0] === 'update'), ['update', 'host', '0.9.0']);
  assert.equal(db.getModuleState('1', 'host').version, '1.0.0');
});

await test('reload: success, then failing init rolls back, then invalid code aborts', async () => {
  await manager.enable('1', 'reloadme');
  const file = path.join(tmp, 'reloadme', 'index.js');

  fs.writeFileSync(file, `export default { name: 'reloadme', version: '1.1.0', async init() {} };`);
  const r = await manager.reload('reloadme');
  assert.deepEqual([r.from, r.to], ['1.0.0', '1.1.0']);
  assert.equal(manager.defs.get('reloadme').def.version, '1.1.0');

  fs.writeFileSync(file, `export default { name: 'reloadme', version: '1.2.0', async init() { throw new Error('new code is broken'); } };`);
  await rejectsWith(() => manager.reload('reloadme'), /Rolled back/);
  assert.equal(manager.defs.get('reloadme').def.version, '1.1.0');
  assert.ok(manager.isActive('1', 'reloadme'), 'still running the old version');
  assert.equal(db.getModuleState('1', 'reloadme').version, '1.1.0');

  fs.writeFileSync(file, `export default { name: 'reloadme', version: 'not-semver' };`);
  await rejectsWith(() => manager.reload('reloadme'), /Reload aborted/);
  assert.equal(manager.defs.get('reloadme').def.version, '1.1.0');

  fs.writeFileSync(file, `export default { this is not javascript`);
  await rejectsWith(() => manager.reload('reloadme'), /Reload aborted/);
  assert.ok(manager.isActive('1', 'reloadme'));
});

await test('per-server enable state persists in the database', () => {
  assert.equal(db.getModuleState('1', 'host').enabled, true);
  assert.equal(db.getModuleState('2', 'host'), undefined);
});

await manager.shutdown();

console.log('\nBundled modules');
const real = new ModuleManager({ db: new Database(':memory:'), perms: new Permissions(new Database(':memory:')), queue: new ApiQueue(), builtins: [], log: quiet });
await real.discover(path.join(root, 'modules'));
await test('every bundled module loads and validates', () => {
  assert.deepEqual([...real.loadErrors], [], 'load errors: ' + JSON.stringify([...real.loadErrors]));
  const expected = ['achievements', 'backup', 'botnews', 'clips', 'community', 'counting', 'critters', 'deadchat', 'eclipseid', 'economy', 'engagement', 'family', 'fun', 'games', 'giveaways', 'integrations', 'invites', 'member-management', 'messages', 'moderation', 'modmail', 'music', 'partyfinder', 'quotes', 'reminders', 'roleplay', 'roles', 'stats', 'support', 'support-html-transcripts', 'tags', 'tempvoice', 'utility', 'voice'];
  assert.deepEqual([...real.defs.keys()].sort(), expected);
});
await test('bundled modules stay under Discord command limits when all enabled', () => {
  const names = [];
  for (const { def } of real.defs.values()) for (const c of def.commands ?? []) names.push((typeof c.data.toJSON === 'function' ? c.data.toJSON() : c.data).name);
  assert.equal(new Set(names).size, names.length, 'duplicate command names across modules');
  assert.ok(names.length <= 90, `${names.length} top-level commands (limit 100 incl. core)`);
});


console.log('\nBundled modules - behaviour with simulated Discord events');
{
  const { parseFeed } = await import('../modules/integrations/index.js');
  await test('feed parser handles RSS and Atom, rejects non-http links', () => {
    const rss = '<rss><channel><item><title>Hello &amp; welcome</title><link>https://ex.com/a</link><guid>g1</guid></item><item><title>Bad</title><link>javascript:alert(1)</link><guid>g2</guid></item></channel></rss>';
    const atom = '<feed><entry><id>tag:1</id><title><![CDATA[Release 1.2]]></title><link rel="alternate" href="https://ex.com/b?x=1&amp;y=2"/><author><name>Ann</name></author></entry></feed>';
    assert.deepEqual(parseFeed(rss).map((x) => [x.id, x.title, x.url]), [['g1', 'Hello & welcome', 'https://ex.com/a']]);
    const a = parseFeed(atom)[0];
    assert.deepEqual([a.id, a.title, a.url, a.author], ['tag:1', 'Release 1.2', 'https://ex.com/b?x=1&y=2', 'Ann']);
  });

  const mdb = new Database(':memory:');
  const roleMap = new Map([['222222222222222222', { id: '222222222222222222', position: 3 }]]);
  const people = new Map();
  const g = {
    id: '1', name: 'Test', ownerId: 'owner', memberCount: 10,
    channels: { cache: new Map(), fetch: async () => null }, roles: { cache: roleMap },
    members: { me: { id: 'bot', roles: { highest: { position: 10 } } }, cache: new Map(), fetch: async (id) => { if (people.has(id)) return people.get(id); throw new Error('Unknown Member'); } },
  };
  const mclient = { guilds: { cache: new Map([['1', g]]) }, application: { commands: { set: async () => {} } }, user: { id: 'bot' } };
  const mperms = new Permissions(mdb);
  const mm = new ModuleManager({ db: mdb, perms: mperms, queue: new ApiQueue(), builtins: [], log: quiet });
  mm.attach(mclient, ['Guilds', 'MessageContent']);
  await mm.discover(path.join(root, 'modules'));
  const person = (id, { bits = [], pos = 1 } = {}) => {
    const set = new Set(bits);
    const m = { id, guild: g, user: { id, bot: false, tag: `${id}#0`, username: id, send: async () => {}, displayAvatarURL: () => 'https://cdn.example.com/avatar.png' }, displayName: id,
      permissions: { has: (b) => set.has(b) }, roles: { cache: new Map(), highest: { position: pos } }, moderatable: true, kickable: true, bannable: true,
      timeout: async function (ms) { this.timedOut = ms; }, timedOut: null };
    people.set(id, m);
    return m;
  };
  const mod = person('mod', { bits: [P.ModerateMembers, P.KickMembers], pos: 5 });
  const victim = person('victim', { pos: 1 });
  const chat = (author, content, extra = {}) => {
    const sent = [], deleted = [];
    const m = { guild: g, guildId: '1', id: 'm' + Math.random(), channelId: 'c1', author: author.user, member: author, system: false, content, mentions: { users: { size: 0, values: () => [] }, roles: { size: 0 } },
      delete: async () => { deleted.push(1); }, channel: { isTextBased: () => true, send: async (p) => { sent.push(p); return { delete: async () => {} }; } }, ...extra };
    return { m, sent, deleted };
  };

  await mm.enable('1', 'moderation');
  await mm.enable('1', 'community');
  await mm.enable('1', 'engagement');

  await test('AutoMod word filter deletes, records a case, ignores moderators', async () => {
    mm.setSetting('1', 'moderation', 'automodWords', 'on');
    mm.setSetting('1', 'moderation', 'bannedWords', 'badword', 'add');
    const a = chat(victim, 'this is a BADWORD!');
    await mm.dispatch('messageCreate', '1', a.m);
    assert.equal(a.deleted.length, 1, 'message deleted');
    assert.equal(mm.ctx('1', 'moderation').data.get('hist:victim')[0].type, 'warn');
    const clean = chat(victim, 'perfectly fine message');
    await mm.dispatch('messageCreate', '1', clean.m);
    assert.equal(clean.deleted.length, 0);
    const substring = chat(victim, 'a badwordish thing'); // whole-word matching only
    await mm.dispatch('messageCreate', '1', substring.m);
    assert.equal(substring.deleted.length, 0, 'does not match inside other words');
    const exempt = chat(mod, 'badword');
    await mm.dispatch('messageCreate', '1', exempt.m);
    assert.equal(exempt.deleted.length, 0, 'moderators bypass AutoMod');
  });

  await test('AutoMod link filter honours the allow-list', async () => {
    mm.setSetting('1', 'moderation', 'automodLinks', 'on');
    mm.setSetting('1', 'moderation', 'allowedDomains', 'example.com', 'add');
    const bad = chat(victim, 'look https://evil.test/x'); await mm.dispatch('messageCreate', '1', bad.m);
    const ok = chat(victim, 'docs https://www.example.com/page'); await mm.dispatch('messageCreate', '1', ok.m);
    const sub = chat(victim, 'docs https://sub.example.com/page'); await mm.dispatch('messageCreate', '1', sub.m);
    const invite = chat(victim, 'join discord.gg/abc123'); await mm.dispatch('messageCreate', '1', invite.m);
    assert.deepEqual([bad.deleted.length, ok.deleted.length, sub.deleted.length, invite.deleted.length], [1, 0, 0, 1]);
  });

  await test('AutoMod spam protection triggers after N messages in the window', async () => {
    mm.setSetting('1', 'moderation', 'automodSpam', 'on');
    mm.setSetting('1', 'moderation', 'spamMaxMessages', '3');
    const msgs = [1, 2, 3].map((n) => chat(victim, `spam ${n}`));
    for (const x of msgs) await mm.dispatch('messageCreate', '1', x.m);
    assert.ok(msgs[2].deleted.length === 1, 'third message is removed');
  });

  await test('/warn records a case, auto-times-out at the threshold, and respects hierarchy', async () => {
    mm.setSetting('1', 'moderation', 'automodSpam', 'off'); mm.setSetting('1', 'moderation', 'automodWords', 'off'); mm.setSetting('1', 'moderation', 'automodLinks', 'off');
    mm.setSetting('1', 'moderation', 'warnTimeoutThreshold', '2');
    // 2.2: right-click > Warn member -> private button -> popup -> submit. The target travels in the signed token.
    const ix = (over) => { const replies = []; const i = { id: `w${Math.random()}`, guildId: '1', guild: g, member: mod, user: mod.user, replied: false, deferred: false, client: { users: { fetch: async (id) => people.get(id)?.user ?? null } },
      reply: async (p) => { replies.push(p); i.replied = true; }, deferReply: async () => { i.deferred = true; }, editReply: async (p) => { replies.push(p); }, showModal: async (m) => { i.modal = m; }, ...over }; i.replies = replies; return i; };
    const warn = async (target) => {
      const cmd = ix({ commandName: 'Warn member', targetUser: target.user, options: {} });
      await mm.handleCommand(cmd);
      const bid = firstButtonId(cmd.replies[0]);
      if (!bid) return cmd; // refused before any button (hierarchy etc.)
      const click = ix({ customId: bid }); await mm.handleComponent(click);
      const submit = ix({ customId: modalInfo(click.modal).customId, fields: fakeFields({ reason: 'being rude', severity: ['high'], notes: '' }) });
      await mm.handleComponent(submit);
      return submit;
    };
    victim.timedOut = null;
    const before = (mm.ctx('1', 'moderation').data.get('hist:victim') ?? []).filter((e) => e.type === 'warn').length;
    await warn(victim); await warn(victim);
    const hist = mm.ctx('1', 'moderation').data.get('hist:victim').filter((e) => e.type === 'warn');
    assert.equal(hist.length, before + 2);
    assert.equal(hist[0].severity, 'high', 'severity from the popup is kept on the case');
    assert.ok(victim.timedOut > 0, 'timed out once the threshold multiple was reached');
    const boss = person('boss', { pos: 9 });
    const w3 = await warn(boss);
    assert.match(w3.replies[0].content, /equal to or above yours/);
    people.set('owner', person('owner', { pos: 1 }));
    const w4 = await warn({ user: { id: 'owner', tag: 'o#0' } });
    assert.match(w4.replies[0].content, /owner/);
  });

  await test('XP: cooldown, level-up announcement, rank command', async () => {
    mm.setSetting('1', 'community', 'xpMin', '100'); mm.setSetting('1', 'community', 'xpMax', '100');
    const alice = person('alice', { pos: 1 });
    const first = chat(alice, 'hello');
    await mm.dispatch('messageCreate', '1', first.m);
    await mm.dispatch('messageCreate', '1', chat(alice, 'again').m); // within cooldown
    const r = mm.ctx('1', 'community').data.get('user:alice');
    assert.equal(r.xp, 100, 'second message inside the cooldown gives no XP');
    assert.equal(r.messages, 2);
    assert.ok(first.sent.some((p) => /level 1/.test(p.content)), 'level-up announced');
    const replies = [];
    await mm.handleCommand({ guildId: '1', commandName: 'rank', guild: g, member: alice, user: alice.user, replied: false, deferred: false, options: { getUser: () => null }, reply: async (p) => { replies.push(p); } });
    assert.ok(replies[0].embeds || replies[0].files?.[0]?.name === 'rank.png', 'rank replied with a card picture (or an embed without pictures)');
    mm.setSetting('1', 'community', 'rankCards', false);
    await mm.handleCommand({ guildId: '1', commandName: 'rank', guild: g, member: alice, user: alice.user, replied: false, deferred: false, options: { getUser: () => null }, reply: async (p) => { replies.push(p); } });
    assert.ok(replies[1].embeds, 'with rank cards off it is the text version');
  });

  await test('scheduling announcements: relative time accepted, junk and past times rejected', async () => {
    const ch = { id: '111111111111111111', isTextBased: () => true };
    g.channels.cache.set(ch.id, ch);
    const admin = person('owner2', { bits: [P.Administrator] });
    const ix = (over) => { const replies = []; const i = { id: `s${Math.random()}`, guildId: '1', guild: g, member: admin, user: admin.user, channelId: ch.id, replied: false, deferred: false,
      reply: async (p) => { replies.push(p); i.replied = true; }, showModal: async (m) => { i.modal = m; }, ...over }; i.replies = replies; return i; };
    const run = async (when) => {
      const cmd = ix({ commandName: 'announce', options: { getSubcommand: () => 'schedule' } }); await mm.handleCommand(cmd);
      const click = ix({ customId: firstButtonId(cmd.replies[0]) }); await mm.handleComponent(click);
      const sub = ix({ customId: modalInfo(click.modal).customId, fields: fakeFields({ channel: [ch.id], when, repeat: ['none'], text: 'Hello\nworld', roles: [] }) });
      await mm.handleComponent(sub);
      return sub.replies[0].content ?? sub.replies[0].embeds?.[0]?.data?.description;
    };
    assert.match(await run('2h'), /Scheduled/);
    const stored = mm.ctx('1', 'engagement').data.list('sched:');
    assert.equal(stored.length, 1);
    assert.ok(Math.abs(stored[0].value.nextAt - (Date.now() + 7200000)) < 5000);
    assert.match(await run('banana'), /delay like/);
    assert.match(await run('2020-01-01 10:00'), /past/);
  });

  await mm.shutdown();
}

await (await import('./features.js')).default({ test, rejectsWith });
await (await import('./v22.js')).default({ test, rejectsWith });
await (await import('./v23.js')).default({ test, rejectsWith });
await (await import('./v23b.js')).default({ test, rejectsWith });
await (await import('./v30.js')).default({ test, rejectsWith });
await (await import('./v31.js')).default({ test, rejectsWith });
await (await import('./update.js')).default({ test, rejectsWith });
await (await import('./desktop.js')).default({ test, rejectsWith });
await (await import('./defer.js')).default({ test, rejectsWith });
await (await import('./about.js')).default({ test, rejectsWith });

fs.rmSync(tmp, { recursive: true, force: true });
// Messages Discord would have refused anywhere in the run (even ones the bot caught and answered with "something went wrong").
const refused = globalThis[Symbol.for('goodboy.tests.discordViolations')] ?? [];
const kinds = [...new Map(refused.map((v) => [v.msg, v])).values()];
if (kinds.length) {
  console.log(`\nDiscord would refuse ${kinds.length} kind${kinds.length === 1 ? '' : 's'} of message the bot sends:`);
  for (const v of kinds) console.log(`  FAIL ${v.msg}\n${v.stack.replace(/^/gm, '       ')}`);
  failed += kinds.length;
}
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
