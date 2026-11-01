/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Command-line updates, for when the supervisor is NOT running (stop the bot first).
 *   npm run update -- status        what version is running, and what is installed
 *   npm run update -- check         ask the update server
 *   npm run update -- install       download, verify, back up your data and switch to the newest version
 *   npm run update -- rollback      go back to the previous version
 * Then start the bot again with: npm run supervised   (or npm start for the bundled code)
 * With the supervisor running, use the dashboard's Updates page instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeUpdater } from '../src/update/config.js';

const base = path.resolve(process.env.GOODBOY_BASE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const dataDir = process.env.GOODBOY_DATA_DIR || path.join(base, 'data');
const { cfg, store, updater } = makeUpdater(base);
const cmd = process.argv[2] ?? 'status';

function supervisorRunning() {
  try { const l = JSON.parse(fs.readFileSync(path.join(base, 'supervisor.lock'), 'utf8')); process.kill(l.pid, 0); return l.pid; } catch (e) { return e.code === 'EPERM' ? 1 : null; }
}
const fail = (m) => { console.error(`\n${m}\n`); process.exit(1); };

if (cmd === 'status') {
  const cur = store.current();
  console.log(`\nRunning code: ${store.runningVersion(cur)} (${cur.version === 'bundled' ? 'the files in this folder' : `release ${cur.version}, ${cur.status}`})`);
  console.log(`Updates: ${cfg.manifestUrl && cfg.publicKey ? `on (${cfg.channel} channel)` : 'off'}${cfg.problems.length ? `\n  ${cfg.problems.join('\n  ')}` : ''}`);
  if (cur.failed.length) console.log(`Rolled back before: ${cur.failed.join(', ')}`);
  console.log('');
} else if (cmd === 'check' || cmd === 'install') {
  try {
    const r = await updater.check();
    if (!r.release) { console.log(`\nYou have the newest version (${r.current}) on the ${r.channel} channel.\n`); process.exit(0); }
    console.log(`\nVersion ${r.release.version} is available (you have ${r.current}).\n${r.release.notes || ''}\n`);
    if (cmd === 'check') process.exit(0);
    if (supervisorRunning()) fail('The supervisor is running. Stop it first, or use the dashboard Updates page.');
    if (r.release.previouslyFailed) fail(`Version ${r.release.version} was rolled back on this computer before. Not installing it again.`);
    const p = await updater.prepare(r.release);
    if (p.needsInstall?.length) fail(`Version ${r.release.version} needs new packages (${p.needsInstall.join(', ')}). Run npm install with the new version's package.json first. Not applied.`);
    store.backupData(dataDir, `before-${r.release.version}`);
    store.activate(r.release.version);
    console.log(`Installed ${r.release.version}. Your data was copied to backups/ first.\nStart it with "npm run supervised". If it does not report ready in time it is rolled back automatically.\n`);
  } catch (e) { fail(e.message); }
} else if (cmd === 'rollback') {
  if (supervisorRunning()) fail('The supervisor is running. Stop it first.');
  const r = store.rollback('manual'); console.log(`\nRolled back${r.from ? ` from ${r.from}` : ' (nothing to roll back)'} to ${r.rolledBackTo}.\n`);
} else fail('Use one of: status, check, install, rollback.');
