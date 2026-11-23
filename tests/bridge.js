/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * The bridge to Good Boy 4 (desktop/lib/bridge.js): finding the release, backing up, the checked download, the handover,
 * and putting Good Boy 3 back when Good Boy 4 does not start. Run with: node tests/bridge.js
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BRIDGE, digestOf, pickRelease, findV4, backup, pruneBackups, download, writeHandoff, Migration } from '../desktop/lib/bridge.js';

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); } }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gb-bridge-'));
const bytes = Buffer.from('pretend this is Good-Boy-4.exe'.repeat(50));
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
const asset = (over = {}) => ({ name: 'Good-Boy-4.exe', size: bytes.length, state: 'uploaded', digest: `sha256:${sha}`, browser_download_url: `https://github.com/${BRIDGE.owner}/${BRIDGE.repo}/releases/download/v4.0.0/Good-Boy-4.exe`, ...over });
const release = (over = {}) => ({ tag_name: 'v4.0.0', draft: false, prerelease: false, body: 'Good Boy 4', assets: [asset()], ...over });
const stream = (buf, ok = true) => async () => ({ ok, status: ok ? 200 : 500, body: { getReader() { let sent = false; return { read: async () => (sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(buf) })) }; } } });

console.log('Good Boy 4 bridge');
await test('picks the newest real release of version 4 with a recorded checksum', () => {
  assert.equal(digestOf(asset()), sha);
  assert.equal(digestOf({ digest: 'md5:abc' }), null);
  const pick = pickRelease([release({ tag_name: 'v4.0.0' }), release({ tag_name: 'v4.1.0' }), release({ tag_name: 'v3.9.0' }), release({ tag_name: 'v4.2.0', draft: true }), release({ tag_name: 'v4.3.0', prerelease: true })]);
  assert.equal(pick.version, '4.1.0');
  assert.equal(pickRelease([release({ tag_name: 'v4.3.0', prerelease: true })], { allowTest: true }).version, '4.3.0');
  assert.equal(pickRelease([release({ assets: [asset({ digest: null })] })]), null, 'no checksum, no move');
  assert.equal(pickRelease([release({ assets: [asset({ browser_download_url: 'https://evil.example/Good-Boy-4.exe' })] })]), null, 'only the project\'s own downloads');
  assert.equal(pickRelease([release({ assets: [asset({ name: 'something-else.exe' })] })]), null);
  assert.equal(pickRelease(null), null);
});
await test('asking GitHub returns null when it cannot be reached', async () => {
  assert.equal(await findV4(async () => { throw new Error('offline'); }), null);
  assert.equal(await findV4(async () => ({ ok: false })), null);
  assert.equal((await findV4(async () => ({ ok: true, json: async () => [release()] }))).version, '4.0.0');
});
await test('the backup keeps data and settings, and old backups are pruned after 14 days', () => {
  const root = tmp(), data = path.join(root, 'bot-data'), settings = path.join(root, 'settings.json');
  fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'eclipse.db'), 'db'); fs.writeFileSync(settings, '{"license":"GB1.x.y"}');
  const now = Date.UTC(2026, 10, 22);
  const dir = backup({ dataDir: data, settingsFile: settings, root, now });
  assert.equal(fs.readFileSync(path.join(dir, 'bot-data', 'eclipse.db'), 'utf8'), 'db');
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{"license":"GB1.x.y"}');
  assert.deepEqual(pruneBackups(root, 14, now + 13 * 86400000), []);
  assert.equal(pruneBackups(root, 14, now + 15 * 86400000).length, 1);
  assert.equal(fs.existsSync(dir), false);
  assert.ok(fs.existsSync(data), 'only backups are removed');
});
await test('a download that matches its checksum is kept; a changed one is refused and removed', async () => {
  const root = tmp(), dest = path.join(root, 'v4', 'Good-Boy-4.exe');
  const file = { url: asset().browser_download_url, size: bytes.length, sha256: sha };
  const seen = []; await download({ file, dest, fetchFn: stream(bytes), onProgress: (p) => seen.push(p) });
  assert.deepEqual(fs.readFileSync(dest), bytes); assert.equal(seen.at(-1), 100);
  const bad = path.join(root, 'bad.exe');
  await assert.rejects(download({ file, dest: bad, fetchFn: stream(Buffer.from(bytes).fill(1)) }), /checksum/);
  assert.equal(fs.existsSync(bad), false); assert.equal(fs.existsSync(`${bad}.part`), false);
  await assert.rejects(download({ file, dest: bad, fetchFn: stream(Buffer.concat([bytes, bytes])) }), /bigger than expected/);
  await assert.rejects(download({ file, dest: bad, fetchFn: stream(bytes, false) }), /failed/);
  await assert.rejects(download({ file: { ...file, url: 'http://github.com/x' }, dest: bad, fetchFn: stream(bytes) }), /trusts/);
});

function world(over = {}) {
  const root = tmp(), data = path.join(root, 'bot-data'), settings = path.join(root, 'settings.json');
  fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'eclipse.db'), 'db'); fs.writeFileSync(settings, '{}');
  const log = [];
  const paths = { dataDir: data, settingsFile: settings, root, exe: path.join(root, 'v4', 'Good-Boy-4.exe'), handoff: path.join(root, 'handoff-v4.json'), marker: path.join(root, 'v4-started.json') };
  const deps = {
    fetchFn: stream(bytes), release: { version: '4.0.0', file: { url: asset().browser_download_url, size: bytes.length, sha256: sha } }, paths,
    readToken: () => 'TOKEN', license: () => 'GB1.a.b',
    stopBot: async () => { log.push('stop'); }, startBot: async () => { log.push('start'); },
    launch: (exe, args) => { log.push(`launch ${path.basename(exe)} ${args[0]}`); if (over.writeMarker !== false) fs.writeFileSync(paths.marker, '1'); return { kill: () => log.push('kill') }; },
    sleep: async () => {}, pollMs: 1, waitSeconds: 0.005, finish: async () => { log.push('finish'); }, ...over,
  };
  return { deps, log, paths, root };
}
await test('the whole move: backup, download, stop, handover, start, wait, remove Good Boy 3', async () => {
  const w = world(); const phases = [];
  const m = new Migration(w.deps); m.on('state', (s) => phases.push(s.phase));
  const r = await m.run();
  assert.equal(r.ok, true);
  assert.deepEqual(phases.filter((p, i) => phases.indexOf(p) === i), ['backup', 'download', 'stop', 'launch', 'done']);
  assert.deepEqual(w.log, ['stop', 'launch Good-Boy-4.exe --from-v3', 'finish']);
  const handoff = JSON.parse(fs.readFileSync(w.paths.handoff, 'utf8'));
  assert.equal(handoff.token, 'TOKEN'); assert.equal(handoff.license, 'GB1.a.b'); assert.equal(handoff.from, '4.0.0'); assert.equal(handoff.marker, w.paths.marker, 'Good Boy 4 is told where to say it is running');
  assert.ok(fs.existsSync(path.join(handoff.backup, 'bot-data', 'eclipse.db')), 'the data is backed up first');
});
await test('a bad download changes nothing: the bot is never stopped', async () => {
  const w = world({ fetchFn: stream(Buffer.from(bytes).fill(2)) });
  const r = await new Migration(w.deps).run();
  assert.equal(r.ok, false); assert.equal(r.rolledBack, false); assert.deepEqual(w.log, []);
});
await test('an unreadable token changes nothing', async () => {
  const w = world({ readToken: () => '' });
  const r = await new Migration(w.deps).run();
  assert.equal(r.ok, false); assert.deepEqual(w.log, []);
});
await test('Good Boy 4 that never starts is stopped, the handover deleted, and Good Boy 3 started again', async () => {
  const w = world({ writeMarker: false });
  const r = await new Migration(w.deps).run();
  assert.equal(r.ok, false); assert.equal(r.rolledBack, true);
  assert.deepEqual(w.log, ['stop', 'launch Good-Boy-4.exe --from-v3', 'kill', 'start']);
  assert.equal(fs.existsSync(w.paths.handoff), false, 'the token handover does not stay on disk');
});
await test('a program that cannot be started rolls back too, and a second run is refused while one is going', async () => {
  const w = world({ launch: () => { throw new Error('blocked by antivirus'); } });
  const m = new Migration(w.deps);
  const first = m.run(), second = await m.run();
  assert.equal(second.ok, false);
  const r = await first;
  assert.equal(r.ok, false); assert.equal(r.rolledBack, true); assert.deepEqual(w.log, ['stop', 'start']);
  assert.equal(fs.existsSync(w.paths.handoff), false);
});
await test('the handover file is for this user only', () => {
  const root = tmp(); const f = path.join(root, 'h.json');
  writeHandoff({ file: f, token: 't', license: '', dataDir: 'd', backupDir: 'b', version: '4.0.0' });
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o077, 0);
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
