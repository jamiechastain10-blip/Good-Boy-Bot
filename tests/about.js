/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * /about, /whatsnew and the version line in the bot's description.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../src/db.js';
import { Permissions } from '../src/permissions.js';
import { ApiQueue } from '../src/queue.js';
import { ModuleManager } from '../src/moduleManager.js';
import { builtins } from '../src/builtins.js';
import { withVersionLine, parseChangelog, sectionForDiscord, DESCRIPTION_MAX } from '../src/about.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

export default async function runAboutTests({ test }) {
  console.log('\nAbout, what\'s new, and the description line');

  await test('description line: added, replaced not duplicated, owner text untouched, always within the limit', () => {
    assert.equal(withVersionLine('', '2.1.1'), 'Good Boy v2.1.1 · Basic Ghost Labs');
    assert.equal(withVersionLine(null, '2.1.1'), 'Good Boy v2.1.1 · Basic Ghost Labs');
    const mine = 'Our friendly server bot.\nSecond line stays.';
    const once = withVersionLine(mine, '2.1.1');
    assert.equal(once, `${mine}\n\nGood Boy v2.1.1 · Basic Ghost Labs`);
    assert.equal(withVersionLine(once, '2.1.1'), once, 'running it again changes nothing');
    assert.equal(withVersionLine(once, '2.1.2'), `${mine}\n\nGood Boy v2.1.2 · Basic Ghost Labs`, 'the old line is replaced');
    const long = withVersionLine('x'.repeat(900), '2.1.1');
    assert.ok(long.length <= DESCRIPTION_MAX, `${long.length}`); assert.ok(long.endsWith('Good Boy v2.1.1 · Basic Ghost Labs')); assert.match(long, /…\n\nGood Boy/);
    assert.equal(withVersionLine('Good Boy is great.', '2.1.1').startsWith('Good Boy is great.'), true, 'similar text of the owner is not mistaken for our line');
  });

  await test('changelog: the real file starts with the running version and each section has notes', () => {
    const log = parseChangelog(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(log[0].version, pkg.version, 'CHANGELOG.md must have an entry for the version in package.json');
    assert.ok(log.every((s) => s.body.length > 0), 'no empty sections');
    assert.ok(sectionForDiscord({ version: 'x', body: 'line\n'.repeat(2000) }).length < 4000, 'fits an embed');
    assert.deepEqual(parseChangelog('# t\n## 1.0.0\nA\n## 0.9.0\nB').map((s) => [s.version, s.body]), [['1.0.0', 'A'], ['0.9.0', 'B']]);
  });

  const db = new Database(':memory:');
  const mm = new ModuleManager({ db, perms: new Permissions(db), queue: new ApiQueue(), builtins, log: quiet });
  mm.version = '2.1.1'; mm.rootDir = root;
  const ix = (commandName, { admin = false, version = null } = {}) => {
    const o = { sent: [], deferred: false, replied: false, id: `a-${Math.random()}` };
    return Object.assign(o, {
      guildId: '1', commandName, user: { id: 'u', tag: 'u#0' },
      member: { id: 'u', guild: { id: '1', ownerId: 'owner' }, permissions: { has: () => admin }, roles: { cache: new Map() } },
      options: { getString: (n) => (n === 'version' ? version : null), getSubcommand: () => null },
      deferReply: async () => { o.deferred = true; }, reply: async (p) => { o.replied = true; o.sent.push(p); }, editReply: async (p) => { o.sent.push(p); }, followUp: async (p) => { o.sent.push(p); },
    });
  };
  const text = (i) => i.sent.map((p) => (typeof p === 'string' ? p : [p.content, ...(p.embeds ?? []).map((e) => `${e.data.title}\n${e.data.description ?? ''}\n${(e.data.fields ?? []).map((f) => f.name + ': ' + f.value).join('\n')}\n${e.data.footer?.text ?? ''}`)].join('\n'))).join('\n');

  await test('/about: anyone can use it and it shows the version', async () => {
    const i = ix('about'); await mm.handleCommand(i);
    assert.match(text(i), /Basic Ghost Labs/); assert.match(text(i), /Version: v2\.1\.1/);
  });
  await test('/whatsnew: admins only by default, shows the current notes, an older version on request, and a clear message for an unknown one', async () => {
    const denied = ix('whatsnew'); await mm.handleCommand(denied);
    assert.match(text(denied), /Manage Server/); assert.ok(!/What's new/.test(text(denied)));
    const now = ix('whatsnew', { admin: true }); await mm.handleCommand(now);
    assert.match(text(now), /What's new in 2\.1\.1/); assert.match(text(now), /Slow commands/);
    assert.equal(now.sent[0].flags, 64, 'private to the admin');
    const old = ix('whatsnew', { admin: true, version: 'v2.1.0-rc.1' }); await mm.handleCommand(old);
    assert.match(text(old), /What's new in 2\.1\.0-rc\.1/);
    const bad = ix('whatsnew', { admin: true, version: '9.9.9' }); await mm.handleCommand(bad);
    assert.match(text(bad), /no notes for version \*\*9\.9\.9\*\*/);
  });
  await test('both commands are registered with Discord-valid names and descriptions', () => {
    for (const n of ['about', 'whatsnew']) {
      const j = mm.commandList('1').find((c) => c.name === n) ?? builtins.map((b) => b.data.toJSON()).find((c) => c.name === n);
      assert.ok(j && j.description.length <= 100 && /^[a-z]+$/.test(j.name), n);
    }
  });
}
