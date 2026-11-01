/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Tests for the update system: package reader, signed manifest, release store, updater and supervisor.
 * Everything runs in temporary folders with a fake update server; supervisor tests start real child processes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createTarGz, readTarGz, extractTarGz, safeRelPath, TarError } from '../src/update/tar.js';
import { generateKeyPair, signManifest, verifyManifest, pickRelease, allowedChannels, ManifestError } from '../src/update/manifest.js';
import { ReleaseStore, BUNDLED } from '../src/update/store.js';
import { Updater, UpdateError, assertFetchable } from '../src/update/updater.js';
import { Supervisor } from '../src/supervisor.js';
import { connectSupervisor } from '../src/ipc.js';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildRelease, collectFiles } from '../src/update/release.js';
import { updateConfig } from '../src/update/config.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gb-upd-'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** A minimal but valid release package for a given version. */
export function releaseFiles(version, extra = {}, deps = { semver: '^7.6.0' }) {
  return [
    { path: 'package.json', data: JSON.stringify({ name: 'good-boy', version, type: 'module', dependencies: deps }) },
    { path: 'src/index.js', data: `// release ${version}\n` },
    { path: 'modules/hello/index.js', data: 'export default {};\n' },
    ...Object.entries(extra).map(([p, data]) => ({ path: p, data })),
  ];
}

/** An install folder like the one the user has: package.json, node_modules/semver, src/index.js. */
function makeInstall(version = '2.1.0') {
  const base = tmpdir();
  fs.mkdirSync(path.join(base, 'src'), { recursive: true });
  fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ name: 'good-boy', version, type: 'module', dependencies: { semver: '^7.6.0' } }));
  fs.writeFileSync(path.join(base, 'src', 'index.js'), '// bundled\n');
  fs.mkdirSync(path.join(base, 'node_modules', 'semver'), { recursive: true });
  fs.writeFileSync(path.join(base, 'node_modules', 'semver', 'package.json'), JSON.stringify({ name: 'semver', version: '7.7.1' }));
  return base;
}

export default async function runUpdateTests({ test, rejectsWith }) {
  console.log('\nUpdates: packages, signed manifest, release store');

  await test('tar: files round-trip, including long paths, and unpack with the right modes', () => {
    const long = `${'deep/'.repeat(30)}file.txt`;
    const gz = createTarGz([{ path: 'a.txt', data: 'hello' }, { path: 'dir/b.js', data: Buffer.from([1, 2, 3]), mode: 0o755 }, { path: long, data: 'x'.repeat(1000) }, { path: 'empty', data: '' }]);
    const entries = readTarGz(gz);
    assert.deepEqual(entries.map((e) => e.path), ['a.txt', 'dir/b.js', long, 'empty']);
    assert.equal(entries[0].data.toString(), 'hello'); assert.deepEqual([...entries[1].data], [1, 2, 3]); assert.equal(entries[2].data.length, 1000);
    const dest = tmpdir();
    extractTarGz(gz, dest);
    assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'hello');
    assert.equal(fs.readFileSync(path.join(dest, long), 'utf8').length, 1000);
    if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(dest, 'dir/b.js')).mode & 0o100, 'executable bit kept');
    fs.rmSync(dest, { recursive: true, force: true });
  });

  await test('tar: paths that could escape the target are refused, both when reading and when writing', () => {
    for (const bad of ['../evil', 'a/../../evil', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', '..']) assert.throws(() => safeRelPath(bad), TarError, bad);
    assert.throws(() => createTarGz([{ path: '../x', data: 'x' }]), TarError);
    // hand-made archive with a hostile name (the writer refuses to make one, so patch the header)
    const gz = createTarGz([{ path: 'aaaa', data: 'x' }]);
    const raw = zlib.gunzipSync(gz); raw.write('../up', 0); // overwrite name
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : raw[i];
    raw.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    assert.throws(() => readTarGz(zlib.gzipSync(raw)), /unsafe path/);
    assert.throws(() => extractTarGz(zlib.gzipSync(raw), tmpdir()), TarError);
  });

  await test('tar: links, damage and oversize archives are refused', () => {
    const base = zlib.gunzipSync(createTarGz([{ path: 'a', data: 'x' }]));
    const withType = (t) => { const b = Buffer.from(base); b[156] = t.charCodeAt(0); let s = 0; for (let i = 0; i < 512; i++) s += i >= 148 && i < 156 ? 32 : b[i]; b.write(`${s.toString(8).padStart(6, '0')}\0 `, 148); return zlib.gzipSync(b); };
    assert.throws(() => readTarGz(withType('2')), /unsupported entry type/);
    assert.throws(() => readTarGz(withType('1')), /unsupported entry type/);
    assert.throws(() => readTarGz(withType('3')), /unsupported entry type/);
    const broken = Buffer.from(base); broken[10] ^= 0xff;
    assert.throws(() => readTarGz(zlib.gzipSync(broken)), /checksum/);
    assert.throws(() => readTarGz(Buffer.from('not gzip at all')), /not a valid/);
    assert.throws(() => readTarGz(createTarGz([{ path: 'big', data: Buffer.alloc(5000) }]), { maxEntries: 10, maxFileBytes: 1000, maxTotalBytes: 100000 }), /too large/);
    assert.throws(() => readTarGz(createTarGz([{ path: 'a', data: 'x' }, { path: 'b', data: 'y' }]), { maxEntries: 1, maxFileBytes: 1000, maxTotalBytes: 100000 }), /too many/);
    assert.throws(() => readTarGz(createTarGz([{ path: 'a', data: Buffer.alloc(800) }, { path: 'b', data: Buffer.alloc(800) }]), { maxEntries: 10, maxFileBytes: 1000, maxTotalBytes: 1000 }), /too large when unpacked/);
  });

  const { publicKey, privateKey } = generateKeyPair();
  const entry = (version, extra = {}) => ({ version, url: `good-boy-${version}.tar.gz`, sha256: 'a'.repeat(64), size: 1000, notes: 'Fixes things', ...extra });
  const payload = (channels) => ({ product: 'good-boy', schema: 1, issuedAt: '2026-10-29T00:00:00Z', channels });

  await test('manifest: only the holder of the private key can publish; tampering and other keys are rejected', () => {
    const env = signManifest(payload({ stable: entry('2.2.0') }), privateKey);
    assert.equal(verifyManifest(env, publicKey).channels.stable.version, '2.2.0');
    assert.throws(() => verifyManifest({ ...env, payload: env.payload.replace('2.2.0', '9.9.9') }, publicKey), /signature is wrong/);
    assert.throws(() => verifyManifest(env, generateKeyPair().publicKey), /signature is wrong/);
    assert.throws(() => verifyManifest({ ...env, signature: 'AAAA' }, publicKey), ManifestError);
    assert.throws(() => verifyManifest(env, ''), /No update signing key/);
    assert.throws(() => verifyManifest({ nope: 1 }, publicKey), /expected format/);
    assert.throws(() => verifyManifest(signManifest({ product: 'other', schema: 1, channels: {} }, privateKey), publicKey), /for something else/);
    assert.throws(() => verifyManifest(signManifest(payload({ stable: entry('2.2.0', { sha256: 'xyz' }) }), privateKey), publicKey), /sha256/);
    assert.throws(() => verifyManifest(signManifest(payload({ stable: entry('latest') }), privateKey), publicKey), /invalid version/);
    assert.throws(() => verifyManifest(signManifest(payload({ stable: entry('2.2.0', { size: -1 }) }), privateKey), publicKey), /invalid size/);
    assert.deepEqual(Object.keys(verifyManifest(signManifest(payload({ stable: entry('2.2.0'), nightly: entry('3.0.0') }), privateKey), publicKey).channels), ['stable'], 'unknown channels ignored');
  });

  await test('manifest: channels, newer-only, prerelease ordering and Node requirements', () => {
    const m = verifyManifest(signManifest(payload({ stable: entry('2.2.0'), beta: entry('2.3.0-beta.1'), development: entry('2.3.0-dev.5') }), privateKey), publicKey);
    assert.equal(pickRelease(m, { channel: 'stable', current: '2.1.0' }).version, '2.2.0');
    assert.equal(pickRelease(m, { channel: 'beta', current: '2.1.0' }).version, '2.3.0-beta.1');
    assert.equal(pickRelease(m, { channel: 'development', current: '2.1.0' }).version, '2.3.0-dev.5', 'dev > beta alphabetically in semver');
    assert.equal(pickRelease(m, { channel: 'stable', current: '2.2.0' }), null, 'same version is not an update');
    assert.equal(pickRelease(m, { channel: 'stable', current: '3.0.0' }), null, 'never offers a downgrade');
    assert.equal(pickRelease(m, { channel: 'bogus', current: '2.1.0' }).channel, 'stable', 'unknown channel falls back to stable');
    assert.deepEqual(allowedChannels('beta'), ['stable', 'beta']);
    const old = verifyManifest(signManifest(payload({ stable: entry('2.2.0', { minNode: '>=99.0.0' }) }), privateKey), publicKey);
    assert.match(pickRelease(old, { channel: 'stable', current: '2.1.0', nodeVersion: '22.13.0' }).blocked, /needs Node\.js >=99\.0\.0/);
    assert.equal(pickRelease(old, { channel: 'stable', current: '2.1.0', nodeVersion: '100.0.0' }).blocked, undefined);
  });

  await test('store: stage unpacks safely, links node_modules, and refuses wrong or dangerous packages', () => {
    const base = makeInstall(); const store = new ReleaseStore(base);
    const ok = store.stage(createTarGz(releaseFiles('2.2.0')), '2.2.0');
    assert.deepEqual(ok.needsInstall, []);
    assert.ok(store.has('2.2.0')); assert.ok(fs.existsSync(path.join(base, 'releases', '2.2.0', 'node_modules', 'semver', 'package.json')), 'node_modules is shared');
    assert.throws(() => store.stage(createTarGz(releaseFiles('2.2.0')), '2.2.0'), /already unpacked/);
    assert.throws(() => store.stage(createTarGz(releaseFiles('2.9.0')), '2.3.0'), /says it is 2\.9\.0/);
    assert.throws(() => store.stage(createTarGz(releaseFiles('2.4.0', { '.env': 'DISCORD_TOKEN=x' })), '2.4.0'), /must never be shipped/);
    assert.throws(() => store.stage(createTarGz(releaseFiles('2.4.0', { 'node_modules/x/index.js': '' })), '2.4.0'), /must never be shipped/);
    assert.throws(() => store.stage(createTarGz([{ path: 'package.json', data: '{"name":"other","version":"2.5.0"}' }]), '2.5.0'), /not a Good Boy release/);
    assert.throws(() => store.stage(createTarGz([{ path: 'package.json', data: '{"name":"good-boy","version":"2.5.0"}' }]), '2.5.0'), /missing parts/);
    assert.throws(() => store.stage(Buffer.from('junk'), '2.6.0'), /not safe to unpack/);
    assert.throws(() => store.dirFor('../../etc'), /not a valid version/);
    assert.deepEqual(fs.readdirSync(path.join(base, 'releases')).filter((n) => n.includes('partial')), [], 'failed attempts leave nothing behind');
    const dep = store.stage(createTarGz(releaseFiles('2.7.0', {}, { semver: '^7.6.0', 'left-pad': '^1.0.0' })), '2.7.0');
    assert.deepEqual(dep.needsInstall, ['left-pad@^1.0.0'], 'a new dependency is reported');
    const old = store.stage(createTarGz(releaseFiles('2.8.0', {}, { semver: '^9.0.0' })), '2.8.0');
    assert.deepEqual(old.needsInstall, ['semver@^9.0.0'], 'an unsatisfied version range is reported');
  });

  await test('store: activate -> trial -> confirm; rollback goes back and remembers the bad version; bundled is the fallback', () => {
    const base = makeInstall(); const store = new ReleaseStore(base);
    assert.deepEqual([store.current().version, store.runningVersion()], [BUNDLED, '2.1.0']);
    store.stage(createTarGz(releaseFiles('2.2.0')), '2.2.0'); store.stage(createTarGz(releaseFiles('2.3.0')), '2.3.0');
    store.activate('2.2.0');
    assert.deepEqual([store.current().version, store.current().previous, store.current().status], ['2.2.0', BUNDLED, 'trial']);
    assert.equal(store.entryFor('2.2.0'), path.join(base, 'releases', '2.2.0', 'src', 'index.js'));
    store.confirm(); assert.equal(store.current().status, 'ok');
    store.activate('2.3.0'); assert.equal(store.current().previous, '2.2.0');
    assert.deepEqual(store.rollback('did not start'), { rolledBackTo: '2.2.0', from: '2.3.0' });
    assert.deepEqual([store.current().version, store.current().status], ['2.2.0', 'ok']);
    assert.deepEqual(store.failedVersions(), ['2.3.0']);
    assert.deepEqual(store.rollback(), { rolledBackTo: BUNDLED, from: '2.2.0' });
    assert.equal(store.current().version, BUNDLED); assert.deepEqual(store.failedVersions(), ['2.3.0', '2.2.0']);
    assert.equal(store.entryFor(BUNDLED), path.join(base, 'src', 'index.js'));
    assert.throws(() => store.activate('9.9.9'), /not unpacked/);
    fs.writeFileSync(path.join(base, 'current.json'), '{ this is damaged');
    assert.equal(store.current().version, BUNDLED, 'a damaged pointer falls back to the bundled code');
    assert.match(fs.readFileSync(path.join(base, 'update.log'), 'utf8'), /"event":"rolled-back"/);
  });

  await test('store: backups copy only the database files, and pruning keeps current, previous and the newest', () => {
    const base = makeInstall(); const store = new ReleaseStore(base);
    const data = path.join(base, 'data'); fs.mkdirSync(data);
    for (const f of ['eclipse.db', 'eclipse.db-wal', 'eclipse.db-shm', '.keep', 'secret.txt']) fs.writeFileSync(path.join(data, f), f);
    const b = store.backupData(data, 'before 2.2.0/x');
    assert.equal(b.copied, 3); assert.deepEqual(fs.readdirSync(b.dir).sort(), ['eclipse.db', 'eclipse.db-shm', 'eclipse.db-wal']);
    for (const v of ['2.2.0', '2.3.0', '2.4.0', '2.5.0', '2.6.0']) store.stage(createTarGz(releaseFiles(v)), v);
    store.activate('2.3.0'); store.confirm(); store.activate('2.4.0');
    fs.mkdirSync(path.join(base, 'releases', '2.9.9.partial-abcd'));
    const removed = store.prune(1);
    assert.deepEqual(removed.sort(), ['2.2.0', '2.5.0']);
    assert.deepEqual(fs.readdirSync(path.join(base, 'releases')).sort(), ['2.3.0', '2.4.0', '2.6.0']);
  });

  // ---------------------------------------------------------------- updater with a fake server
  const server = ({ channels, privKey = privateKey, packages = {}, manifestUrl = 'https://updates.example/latest.json', status = {}, bigBody = null }) => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (status[url]) return new Response('nope', { status: status[url] });
      if (url === manifestUrl) return new Response(JSON.stringify(signManifest(payload(channels), privKey)));
      if (bigBody && url in bigBody) return new Response(bigBody[url]);
      if (url in packages) return new Response(packages[url]);
      return new Response('missing', { status: 404 });
    };
    return { fetchImpl, calls, manifestUrl };
  };
  const pack = (v, deps) => createTarGz(releaseFiles(v, {}, deps));

  await test('updater: check finds a newer signed release, resolves its address, and flags a version that was rolled back before', async () => {
    const base = makeInstall(); const store = new ReleaseStore(base);
    const gz = pack('2.2.0');
    const s = server({ channels: { stable: entry('2.2.0', { sha256: sha(gz), size: gz.length }) }, packages: { 'https://updates.example/good-boy-2.2.0.tar.gz': gz } });
    const u = new Updater({ store, manifestUrl: s.manifestUrl, publicKey, fetchImpl: s.fetchImpl });
    const r = await u.check();
    assert.deepEqual([r.current, r.release.version, r.release.url], ['2.1.0', '2.2.0', 'https://updates.example/good-boy-2.2.0.tar.gz']);
    assert.equal(r.release.previouslyFailed, false);
    const up2 = new Updater({ store: new ReleaseStore(base), manifestUrl: s.manifestUrl, publicKey, fetchImpl: s.fetchImpl });
    fs.writeFileSync(path.join(base, 'current.json'), JSON.stringify({ version: 'bundled', failed: ['2.2.0'] }));
    assert.equal((await up2.check()).release.previouslyFailed, true);
  });

  await test('updater: not configured, no key, wrong key, offline and bad server answers all give plain errors', async () => {
    const store = new ReleaseStore(makeInstall());
    const s = server({ channels: { stable: entry('2.2.0') } });
    await rejectsWith(() => new Updater({ store, manifestUrl: '', publicKey, fetchImpl: s.fetchImpl }).check(), /switched off/);
    await rejectsWith(() => new Updater({ store, manifestUrl: s.manifestUrl, publicKey: '', fetchImpl: s.fetchImpl }).check(), /No update signing key/);
    await rejectsWith(() => new Updater({ store, manifestUrl: s.manifestUrl, publicKey: generateKeyPair().publicKey, fetchImpl: s.fetchImpl }).check(), /signature is wrong/);
    await rejectsWith(() => new Updater({ store, manifestUrl: s.manifestUrl, publicKey, fetchImpl: async () => { throw Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } }); } }).check(), /Could not reach the update server \(ENOTFOUND\)/);
    await rejectsWith(() => new Updater({ store, manifestUrl: s.manifestUrl, publicKey, fetchImpl: server({ channels: {}, status: { 'https://updates.example/latest.json': 503 } }).fetchImpl }).check(), /answered 503/);
    await rejectsWith(() => new Updater({ store, manifestUrl: 'http://evil.example/latest.json', publicKey, fetchImpl: s.fetchImpl }).check(), /over https/);
    await rejectsWith(() => new Updater({ store, manifestUrl: 'https://user:pw@updates.example/x', publicKey, fetchImpl: s.fetchImpl }).check(), /password/);
    assert.doesNotThrow(() => assertFetchable('http://127.0.0.1:8080/latest.json'), 'plain http is fine for this computer only');
    await rejectsWith(() => new Updater({ store, manifestUrl: s.manifestUrl, publicKey, fetchImpl: async () => new Response('x'.repeat(300 * 1024)) }).check(), /larger than expected/);
  });

  await test('updater: prepare verifies size and checksum before unpacking, and reports packages that need npm install', async () => {
    const base = makeInstall(); const store = new ReleaseStore(base);
    const gz = pack('2.2.0'); const url = 'https://updates.example/good-boy-2.2.0.tar.gz';
    const build = (over = {}, pkgs = { [url]: gz }) => {
      const s = server({ channels: { stable: entry('2.2.0', { sha256: sha(gz), size: gz.length, ...over }) }, packages: pkgs });
      return new Updater({ store, manifestUrl: s.manifestUrl, publicKey, fetchImpl: s.fetchImpl });
    };
    let u = build({ sha256: 'b'.repeat(64) });
    await rejectsWith(async () => u.prepare((await u.check()).release), /does not match its signed checksum/);
    u = build({ size: gz.length + 5 });
    await rejectsWith(async () => u.prepare((await u.check()).release), /not the size|larger than expected/);
    u = build({}, { [url]: Buffer.concat([gz, Buffer.from('X')]) });
    await rejectsWith(async () => u.prepare((await u.check()).release), /larger than expected|not the size/);
    assert.ok(!store.has('2.2.0'), 'nothing was installed by the failures');
    u = build();
    const ok = await u.prepare((await u.check()).release);
    assert.deepEqual(ok.needsInstall, []); assert.ok(store.has('2.2.0')); assert.ok(fs.existsSync(path.join(base, 'downloads', 'good-boy-2.2.0.tar.gz')));
    assert.equal((await u.prepare((await u.check()).release ?? { version: '2.2.0' })).alreadyUnpacked, true);
    const blocked = build({ minNode: '>=99.0.0' });
    await rejectsWith(async () => blocked.prepare({ ...(await blocked.check()).release, version: '2.3.0' }), /needs Node\.js/);
    const gz2 = pack('2.4.0', { semver: '^7.6.0', extra: '^1.0.0' });
    const s2 = server({ channels: { stable: entry('2.4.0', { sha256: sha(gz2), size: gz2.length }) }, packages: { 'https://updates.example/good-boy-2.4.0.tar.gz': gz2 } });
    const u2 = new Updater({ store, manifestUrl: s2.manifestUrl, publicKey, fetchImpl: s2.fetchImpl });
    assert.deepEqual((await u2.prepare((await u2.check()).release)).needsInstall, ['extra@^1.0.0']);
  });

  // ---------------------------------------------------------------- supervisor, with real child processes
  console.log('\nSupervisor: restarts, trial releases, rollback, IPC');
  const FAKE_BOT = `
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = fs.readFileSync(path.join(dir, 'mode.txt'), 'utf8').trim();
const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
fs.appendFileSync(path.join(process.env.GOODBOY_DATA_DIR, 'starts.log'), version + ' ' + mode + ' supervised=' + process.env.GOODBOY_SUPERVISED + ' cwd=' + path.basename(process.cwd()) + '\\n');
process.on('message', (m) => { if (m.type === 'shutdown') process.exit(0); });
const ready = () => { try { process.send({ type: 'ready' }); } catch { /* parent gone */ } };
if (mode === 'ready') { setTimeout(ready, 30); setInterval(() => {}, 1000); }
else if (mode === 'crash') setTimeout(() => process.exit(1), 30);
else if (mode === 'ready-then-crash') { setTimeout(ready, 30); setTimeout(() => process.exit(1), 150); }
else if (mode === 'never-ready') setInterval(() => {}, 1000);
else if (mode === 'ipc') {
  const { connectSupervisor } = await import(process.env.IPC_MODULE);
  const link = connectSupervisor({ version, onShutdown: () => process.exit(0), heartbeatMs: 50 });
  link.ready();
  const check = await link.request('check');
  fs.writeFileSync(path.join(process.env.GOODBOY_DATA_DIR, 'ipc-check.json'), JSON.stringify(check));
  if (process.env.IPC_APPLY && check.ok && check.check?.release) fs.writeFileSync(path.join(process.env.GOODBOY_DATA_DIR, 'ipc-apply.json'), JSON.stringify(await link.request('apply')));
  setInterval(() => {}, 1000);
}
`;
  const fakeRelease = (version, mode) => createTarGz([
    { path: 'package.json', data: JSON.stringify({ name: 'good-boy', version, type: 'module', dependencies: { semver: '^7.6.0' } }) },
    { path: 'src/index.js', data: FAKE_BOT }, { path: 'modules/hello/index.js', data: 'export default {};\n' }, { path: 'mode.txt', data: mode },
  ]);
  const IPC_MODULE = fileURLToPath(new URL('../src/ipc.js', import.meta.url));
  const supInstall = (mode = 'ready') => {
    const base = makeInstall('2.1.0');
    fs.writeFileSync(path.join(base, 'src', 'index.js'), FAKE_BOT); fs.writeFileSync(path.join(base, 'mode.txt'), mode);
    return base;
  };
  const until = async (cond, ms = 8000, what = 'condition') => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error(`timed out waiting for ${what}`); };
  const startsLog = (base) => fs.readFileSync(path.join(base, 'data', 'starts.log'), 'utf8').trim().split('\n');
  const fast = { applyDelayMs: 300, restartDelays: [30, 30, 30], crashLoop: { count: 3, windowMs: 10000 }, healthTimeoutMs: 1500, stopTimeoutMs: 3000, autoCheckHours: 0 };
  const running = (sup) => until(() => sup.state === 'running', 8000, 'running');
  const made = [];
  const newSup = (o) => { const x = new Supervisor(o); made.push(x); return x; };
  const supTest = (name, fn) => test(name, async () => { try { await fn(); } finally { await Promise.all(made.splice(0).map((x) => x.stop().catch(() => {}))); } });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  await supTest('supervisor: starts the bot with the right environment, and stops it cleanly, removing its lock', async () => {
    const base = supInstall('ready'); const sup = newSup({ base, ...fast, env: { ...process.env } });
    await sup.start(); await running(sup);
    const pid = sup.status().pid;
    assert.match(startsLog(base)[0], /^2\.1\.0 ready supervised=1 cwd=/);
    assert.ok(fs.existsSync(path.join(base, 'supervisor.lock')));
    const dup = newSup({ base, ...fast });
    await assert.rejects(() => dup.start(), /Another supervisor/);
    await sup.stop();
    assert.equal(sup.state, 'stopped'); assert.ok(!alive(pid), 'no orphan process'); assert.ok(!fs.existsSync(path.join(base, 'supervisor.lock')));
  });

  await supTest('supervisor: a bot that keeps crashing is restarted with pauses, then given up on with a clear reason', async () => {
    const base = supInstall('crash'); const sup = newSup({ base, ...fast });
    const gave = new Promise((r) => sup.once('gaveup', r));
    await sup.start();
    const reason = await gave;
    assert.match(reason, /stopped 3 times in a row/); assert.equal(sup.state, 'failed'); assert.equal(startsLog(base).length, 3);
    assert.ok(!fs.existsSync(path.join(base, 'supervisor.lock')), 'lock released so you can start again');
    assert.match(sup.status().update.lastError, /Fix the problem/);
  });

  await supTest('supervisor: a crash after running is restarted and counted', async () => {
    const base = supInstall('ready-then-crash'); const sup = newSup({ base, ...fast, crashLoop: { count: 50, windowMs: 10000 } });
    await sup.start(); await until(() => sup.restarts >= 2 && startsLog(base).length >= 3, 8000, 'two restarts');
    assert.ok(sup.restarts >= 2); await sup.stop();
  });

  const signedServer = (store, releases, ch = 'stable') => {
    const entries = {};
    const packages = {};
    for (const [v, gz] of Object.entries(releases)) { packages[`https://updates.example/good-boy-${v}.tar.gz`] = gz; entries[ch] = { version: v, url: `good-boy-${v}.tar.gz`, sha256: sha(gz), size: gz.length, notes: `Notes for ${v}` }; }
    const fetchImpl = async (url) => {
      if (url === 'https://updates.example/latest.json') return new Response(JSON.stringify(signManifest(payload(entries), privateKey)));
      if (url in packages) return new Response(packages[url]);
      return new Response('missing', { status: 404 });
    };
    return new Updater({ store, manifestUrl: 'https://updates.example/latest.json', publicKey, fetchImpl });
  };

  await supTest('supervisor: a bot that exits cleanly by itself is not restarted', async () => {
    const base = supInstall('ready'); const sup = newSup({ base, ...fast });
    await sup.start(); await running(sup);
    const gave = new Promise((r) => sup.once('gaveup', r));
    sup.child.send({ type: 'shutdown' }); // the fake bot exits with code 0 on this, without the supervisor having asked
    assert.match(await gave, /exited by itself/);
    assert.deepEqual([sup.state, sup.restarts], ['stopped', 0]);
    assert.ok(!fs.existsSync(path.join(base, 'supervisor.lock')));
    assert.equal(startsLog(base).length, 1, 'not started again');
  });

  await supTest('update: a healthy new release is installed with a data backup, confirmed once ready, and the old process is gone', async () => {
    const base = supInstall('ready'); const store = new ReleaseStore(base);
    fs.mkdirSync(path.join(base, 'data'), { recursive: true }); fs.writeFileSync(path.join(base, 'data', 'eclipse.db'), 'DB');
    const updater = signedServer(store, { '2.2.0': fakeRelease('2.2.0', 'ready') });
    const sup = newSup({ base, ...fast, updater });
    await sup.start(); await running(sup); const oldPid = sup.status().pid;
    const check = await sup.checkForUpdate();
    assert.equal(check.release.version, '2.2.0'); assert.equal(check.release.notes, 'Notes for 2.2.0');
    const { version } = await sup.prepareUpdate();
    const out = await sup.applyUpdate(version);
    assert.deepEqual(out, { ok: true, version: '2.2.0' });
    assert.ok(!alive(oldPid), 'the old bot was stopped first');
    assert.deepEqual([store.current().version, store.current().status], ['2.2.0', 'ok']);
    assert.match(startsLog(base).at(-1), /^2\.2\.0 ready/);
    const backups = fs.readdirSync(path.join(base, 'backups')); assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(base, 'backups', backups[0], 'eclipse.db'), 'utf8'), 'DB');
    assert.equal(sup.status().version, '2.2.0'); assert.equal(sup.status().trial, false);
    await sup.stop();
  });

  await supTest('update: a release that crashes on start is rolled back automatically and remembered as bad', async () => {
    const base = supInstall('ready'); const store = new ReleaseStore(base);
    const sup = newSup({ base, ...fast, updater: signedServer(store, { '2.3.0': fakeRelease('2.3.0', 'crash') }) });
    await sup.start(); await running(sup);
    const { version } = await sup.prepareUpdate();
    const out = await sup.applyUpdate(version);
    assert.equal(out.ok, false); assert.equal(out.rolledBack, true); assert.match(out.reason, /stopped .* before it was ready/);
    await running(sup);
    assert.equal(store.current().version, 'bundled'); assert.deepEqual(store.failedVersions(), ['2.3.0']);
    assert.equal(sup.status().version, '2.1.0');
    assert.deepEqual(startsLog(base).map((l) => l.split(' ')[0]), ['2.1.0', '2.3.0', '2.1.0']);
    const again = await sup.checkForUpdate(); assert.equal(again.release.previouslyFailed, true, 'the dashboard can warn before trying it again');
    await sup.stop();
  });

  await supTest('update: a release that starts but never reports ready is rolled back when the health timeout passes', async () => {
    const base = supInstall('ready'); const store = new ReleaseStore(base);
    const sup = newSup({ base, ...fast, healthTimeoutMs: 500, updater: signedServer(store, { '2.4.0': fakeRelease('2.4.0', 'never-ready') }) });
    await sup.start(); await running(sup);
    const out = await sup.applyUpdate((await sup.prepareUpdate()).version);
    assert.deepEqual([out.ok, out.rolledBack], [false, true]); assert.match(out.reason, /did not report ready in time/);
    await running(sup); assert.equal(store.current().version, 'bundled');
    await sup.stop();
  });

  await supTest('update: a second update rolls back to the first (not to the original) when it fails', async () => {
    const base = supInstall('ready'); const store = new ReleaseStore(base);
    let updater = signedServer(store, { '2.2.0': fakeRelease('2.2.0', 'ready') });
    const sup = newSup({ base, ...fast, updater });
    await sup.start(); await running(sup);
    assert.equal((await sup.applyUpdate((await sup.prepareUpdate()).version)).ok, true);
    sup.updater = signedServer(store, { '2.5.0': fakeRelease('2.5.0', 'crash') });
    const out = await sup.applyUpdate((await sup.prepareUpdate()).version);
    assert.equal(out.rolledBack, true); await running(sup);
    assert.deepEqual([store.current().version, sup.status().version], ['2.2.0', '2.2.0']);
    await sup.stop();
  });

  await supTest('update: a release that needs new npm packages is downloaded but never applied', async () => {
    const base = supInstall('ready'); const store = new ReleaseStore(base);
    const gz = createTarGz([...releaseFiles('2.6.0', {}, { semver: '^7.6.0', 'brand-new-dep': '^1.0.0' })]);
    const sup = newSup({ base, ...fast, updater: signedServer(store, { '2.6.0': gz }) });
    await sup.start(); await running(sup);
    await assert.rejects(() => sup.prepareUpdate(), /needs new packages \(brand-new-dep@\^1\.0\.0\)/);
    assert.equal(store.current().version, 'bundled'); assert.equal(sup.state, 'running');
    await sup.stop();
  });

  await supTest('the bot asks the supervisor over IPC: check, then apply; the dashboard-facing reply says what was found', async () => {
    const base = supInstall('ipc'); const store = new ReleaseStore(base);
    const sup = newSup({ base, ...fast, updater: signedServer(store, { '2.7.0': fakeRelease('2.7.0', 'ready') }), env: { ...process.env, IPC_MODULE, IPC_APPLY: '1' } });
    await sup.start();
    await until(() => fs.existsSync(path.join(base, 'data', 'ipc-apply.json')), 8000, 'the apply request');
    const check = JSON.parse(fs.readFileSync(path.join(base, 'data', 'ipc-check.json'), 'utf8'));
    assert.equal(check.ok, true); assert.equal(check.check.release.version, '2.7.0'); assert.equal(check.status.state, 'running');
    assert.deepEqual({ ok: true, accepted: true, version: '2.7.0' }, JSON.parse(fs.readFileSync(path.join(base, 'data', 'ipc-apply.json'), 'utf8')));
    await until(() => store.current().version === '2.7.0' && store.current().status === 'ok' && sup.state === 'running', 10000, 'the new release to be confirmed');
    await sup.stop();
  });

  await test('ipc: not supervised means no link; a lost supervisor stops the bot; requests time out politely', async () => {
    assert.equal(connectSupervisor({ proc: { on() {} } }), null);
    const proc = Object.assign(new EventEmitter(), { sent: [], connected: true, pid: 7, send(m) { this.sent.push(m); } });
    let stopped = null;
    const link = connectSupervisor({ proc, version: '1.0.0', onShutdown: (why) => { stopped = why; }, getStatus: () => ({ guilds: 3 }), heartbeatMs: 20, requestTimeoutMs: 60 });
    assert.deepEqual(proc.sent[0], { type: 'hello', pid: 7, version: '1.0.0' });
    link.ready(); assert.ok(proc.sent.some((m) => m.type === 'ready'));
    await until(() => proc.sent.some((m) => m.type === 'status' && m.guilds === 3), 1000, 'a heartbeat');
    const keepAlive = setInterval(() => {}, 1000); // the link's own timers are unref'd on purpose (the real bot has other work keeping it alive)
    try { var slow = await link.request('check'); } finally { clearInterval(keepAlive); }
    assert.equal(slow.ok, false); assert.match(slow.error, /did not answer/);
    const asked = link.request('status'); const id = proc.sent.find((m) => m.type === 'update-request' && m.action === 'status').id;
    proc.emit('message', { type: 'update-reply', id, result: { ok: true, hello: 1 } });
    assert.deepEqual(await asked, { ok: true, hello: 1 });
    proc.emit('message', { type: 'shutdown' }); assert.match(stopped, /asked the bot to stop/);
    proc.connected = false; proc.emit('disconnect'); assert.match(stopped, /disconnected/);
    link.close();
  });

  // ---------------------------------------------------------------- building releases, config, and the command line
  console.log('\nReleases: building, settings, command line');
  const fakeProject = (version = '2.2.0') => {
    const root = tmpdir();
    const put = (rel, data) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), data); };
    put('package.json', JSON.stringify({ name: 'good-boy', version, type: 'module', dependencies: { semver: '^7.6.0' } }));
    put('src/index.js', '// bot\n'); put('modules/a/index.js', 'export default {};\n'); put('docs/README.md', '# docs\n'); put('scripts/x.js', '// x\n');
    // things that must never be shipped
    put('.env', 'DISCORD_TOKEN=secret-token'); put('data/eclipse.db', 'DB'); put('node_modules/semver/package.json', '{}'); put('release-private.pem', 'PRIVATE'); put('src/old.log', 'log');
    put('backup.zip', 'zip'); put('releases/1.0.0/x', 'x'); put('current.json', '{}'); put('modules/a/.env.local', 'SECRET'); put('desktop/main.js', '// desktop app'); put('update-public-key.pem', 'pub');
    return root;
  };

  await test('release builder: ships the code and nothing private, and the result verifies, unpacks and activates', () => {
    const root = fakeProject('2.2.0');
    const r = buildRelease({ root, channel: 'stable', privateKey, notes: 'Hello' });
    assert.deepEqual(r.files, ['docs/README.md', 'modules/a/index.js', 'package.json', 'scripts/x.js', 'src/index.js']);
    for (const bad of ['.env', 'data', 'node_modules', '.pem', '.log', '.zip', 'releases', 'current.json', 'desktop', 'secret']) assert.ok(!r.files.some((f) => f.includes(bad)), `must not contain ${bad}`);
    assert.ok(!Buffer.from(JSON.stringify(readTarGz(r.tarball).map((e) => e.data.toString()))).includes('secret-token'));
    const m = verifyManifest(r.envelope, publicKey);
    assert.equal(m.channels.stable.sha256, sha(r.tarball)); assert.equal(m.channels.stable.size, r.tarball.length); assert.equal(m.channels.stable.notes, 'Hello');
    const base = makeInstall('2.1.0'); const store = new ReleaseStore(base);
    assert.deepEqual(store.stage(r.tarball, '2.2.0').needsInstall, []); store.activate('2.2.0'); assert.equal(store.runningVersion(), '2.2.0');
    assert.equal(sha(buildRelease({ root, privateKey }).tarball), sha(r.tarball), 'building twice gives the identical package');
  });

  await test('release builder: other channels are kept, prereleases cannot go to stable, bad projects are refused', () => {
    const root = fakeProject('2.3.0-beta.1');
    assert.throws(() => buildRelease({ root, channel: 'stable', privateKey }), /pre-release/);
    const beta = buildRelease({ root, channel: 'beta', privateKey });
    const root2 = fakeProject('2.2.0');
    const both = buildRelease({ root: root2, channel: 'stable', privateKey, previous: beta.envelope });
    assert.deepEqual(Object.keys(verifyManifest(both.envelope, publicKey).channels).sort(), ['beta', 'stable']);
    assert.throws(() => buildRelease({ root: root2, channel: 'nightly', privateKey }), /Unknown channel/);
    fs.writeFileSync(path.join(root2, 'package.json'), JSON.stringify({ name: 'other', version: '1.0.0' }));
    assert.throws(() => buildRelease({ root: root2, privateKey }), /not the Good Boy project/);
    assert.ok(collectFiles(fakeProject()).every((f) => !Buffer.isBuffer(f.path)));
  });

  await test('update settings: off by default, read from .env or the environment, key must be present, bad values fall back', () => {
    const base = tmpdir();
    assert.deepEqual([updateConfig(base, {}).manifestUrl, updateConfig(base, {}).channel, updateConfig(base, {}).checkHours], ['', 'stable', 24]);
    fs.writeFileSync(path.join(base, '.env'), 'DISCORD_TOKEN=x\nUPDATE_MANIFEST_URL="https://example.com/latest.json"\nUPDATE_CHANNEL=beta\nUPDATE_CHECK_HOURS=6\n');
    let c = updateConfig(base, {});
    assert.deepEqual([c.manifestUrl, c.channel, c.checkHours], ['https://example.com/latest.json', 'beta', 6]);
    assert.match(c.problems.join(' '), /update-public-key\.pem is missing/);
    fs.writeFileSync(path.join(base, 'update-public-key.pem'), publicKey);
    c = updateConfig(base, { UPDATE_CHANNEL: 'nightly', UPDATE_CHECK_HOURS: '0' });
    assert.deepEqual([c.channel, c.checkHours, c.publicKey === publicKey], ['stable', 0, true]); assert.match(c.problems.join(' '), /not one of/);
    assert.equal(updateConfig(base, { UPDATE_MANIFEST_URL: 'https://other.example/x.json' }).manifestUrl, 'https://other.example/x.json', 'the environment wins over .env');
  });

  await test('command line: check, install, status and rollback work end to end against a local update server', async () => {
    const run = promisify(execFile);
    const root = fakeProject('2.2.0');
    const built = buildRelease({ root, privateKey, notes: 'CLI notes' });
    const srv = http.createServer((req, res) => {
      if (req.url === '/latest.json') res.end(JSON.stringify(built.envelope));
      else if (req.url === `/${built.name}`) res.end(built.tarball);
      else { res.statusCode = 404; res.end('no'); }
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const base = makeInstall('2.1.0');
      fs.mkdirSync(path.join(base, 'data')); fs.writeFileSync(path.join(base, 'data', 'eclipse.db'), 'DB');
      fs.writeFileSync(path.join(base, 'update-public-key.pem'), publicKey);
      const env = { ...process.env, GOODBOY_BASE_DIR: base, UPDATE_MANIFEST_URL: `http://127.0.0.1:${srv.address().port}/latest.json` };
      const cli = (...a) => run(process.execPath, [fileURLToPath(new URL('../scripts/update.js', import.meta.url)), ...a], { env }).then((r) => r.stdout, (e) => { throw new Error(e.stderr || e.message); });
      assert.match(await cli('status'), /Running code: 2\.1\.0[\s\S]*Updates: on \(stable channel\)/);
      assert.match(await cli('check'), /Version 2\.2\.0 is available[\s\S]*CLI notes/);
      assert.match(await cli('install'), /Installed 2\.2\.0/);
      const store = new ReleaseStore(base);
      assert.deepEqual([store.current().version, store.current().status], ['2.2.0', 'trial']);
      assert.equal(fs.readdirSync(path.join(base, 'backups')).length, 1);
      assert.match(await cli('status'), /Running code: 2\.2\.0/);
      assert.match(await cli('check'), /newest version \(2\.2\.0\)/);
      assert.match(await cli('rollback'), /Rolled back from 2\.2\.0 to bundled/);
      await assert.rejects(() => cli('install'), /rolled back on this computer before/);
      fs.writeFileSync(path.join(base, 'supervisor.lock'), JSON.stringify({ pid: process.pid, id: 'x' }));
      await assert.rejects(() => cli('rollback'), /supervisor is running/);
    } finally { srv.close(); }
  });
}
