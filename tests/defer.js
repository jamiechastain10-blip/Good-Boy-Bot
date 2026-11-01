/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * The shared "slow command" safety net in the router, and the ping-permission check.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PermissionFlagsBits as P } from 'discord.js';
import { Database } from '../src/db.js';
import { Permissions } from '../src/permissions.js';
import { ApiQueue } from '../src/queue.js';
import { ModuleManager } from '../src/moduleManager.js';
import { pingProblem } from '../src/util.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function runDeferTests({ test }) {
  console.log('\nSlow-command safety net');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-defer-'));
  fs.mkdirSync(path.join(dir, 'slowmod'));
  fs.writeFileSync(path.join(dir, 'slowmod', 'index.js'), `
    const slow = (ms) => new Promise((r) => setTimeout(r, ms));
    export default { name: 'slowmod', version: '1.0.0', commands: [
      { data: { name: 'slowreply', description: 'x' }, execute: async (ctx, i) => { await slow(150); await i.reply({ content: 'late answer' }); } },
      { data: { name: 'slowdefer', description: 'x' }, execute: async (ctx, i) => { await slow(150); await i.deferReply({ flags: 64 }); await i.editReply({ content: 'deferred answer' }); } },
      { data: { name: 'slowmodal', description: 'x' }, execute: async (ctx, i) => { await i.showModal({ title: 'x' }); await slow(150); } },
      { data: { name: 'fastreply', description: 'x' }, execute: async (ctx, i) => { await i.reply({ content: 'quick' }); } },
      { data: { name: 'slowpublic', description: 'x' }, defer: 'public', execute: async (ctx, i) => { await slow(150); await i.reply({ content: 'for everyone' }); } },
      { data: { name: 'slownone', description: 'x' }, defer: 'none', execute: async (ctx, i) => { await slow(150); await i.reply({ content: 'on my own' }); } },
      { data: { name: 'slowtwice', description: 'x' }, execute: async (ctx, i) => { await slow(150); await i.reply({ content: 'one' }); await i.followUp({ content: 'two' }); } },
    ] };`);
  const db = new Database(':memory:');
  const mm = new ModuleManager({ db, perms: new Permissions(db), queue: new ApiQueue(), builtins: [], log: quiet });
  mm.deferAfterMs = 40;
  mm.attach({ guilds: { cache: new Map([['1', { id: '1', ownerId: 'o', members: { me: null, cache: new Map() }, roles: { cache: new Map() }, channels: { cache: new Map() } }]]) }, application: { commands: { set: async () => {} } }, user: { id: 'bot' } }, []);
  await mm.discover(dir);
  await mm.enable('1', 'slowmod');

  const ix = (commandName) => {
    const o = { log: [], deferred: false, replied: false, id: `i-${commandName}-${Math.random()}` };
    return Object.assign(o, {
      guildId: '1', commandName, member: { id: 'u', permissions: { has: () => true }, roles: { cache: new Map() } }, user: { id: 'u' },
      deferReply: async (opts) => { if (o.deferred || o.replied) throw new Error('already acknowledged'); o.deferred = true; o.log.push(['defer', opts?.flags ? 'ephemeral' : 'public']); },
      reply: async (p) => { if (o.deferred || o.replied) throw new Error('already acknowledged'); o.replied = true; o.log.push(['reply', p.content]); },
      editReply: async (p) => { if (!o.deferred && !o.replied) throw new Error('nothing to edit'); o.log.push(['edit', p.content]); },
      followUp: async (p) => { o.log.push(['follow', p.content]); },
      showModal: async () => { if (o.deferred || o.replied) throw new Error('already acknowledged'); o.replied = true; o.log.push(['modal']); },
    });
  };
  const go = async (name) => { const i = ix(name); await mm.handleCommand(i); return i.log; };

  await test('a slow command that replies late is deferred privately, and its reply becomes the answer', async () => {
    assert.deepEqual(await go('slowreply'), [['defer', 'ephemeral'], ['edit', 'late answer']]);
  });
  await test('a slow command that defers on its own after the net fired does not crash', async () => {
    assert.deepEqual(await go('slowdefer'), [['defer', 'ephemeral'], ['edit', 'deferred answer']]);
  });
  await test('popup commands are exempt: the popup is the first and only response', async () => {
    assert.deepEqual(await go('slowmodal'), [['modal']]);
  });
  await test('a fast command is untouched', async () => {
    assert.deepEqual(await go('fastreply'), [['reply', 'quick']]);
  });
  await test('a command can ask for a public defer, or turn the net off', async () => {
    assert.deepEqual(await go('slowpublic'), [['defer', 'public'], ['edit', 'for everyone']]);
    const i = ix('slownone'); await mm.handleCommand(i);
    assert.deepEqual(i.log, [['reply', 'on my own']], 'with the net off nothing is deferred for it');
  });
  await test('a second message after a late first one goes out as a follow-up', async () => {
    assert.deepEqual(await go('slowtwice'), [['defer', 'ephemeral'], ['edit', 'one'], ['follow', 'two']]);
  });
  await test('the timer is cleaned up when a command finishes', async () => {
    const i = ix('fastreply'); await mm.handleCommand(i); await wait(100);
    assert.deepEqual(i.log, [['reply', 'quick']], 'no late defer after the command already answered');
  });
  await mm.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log('\nPing permission check');
  const chan = (has) => ({ id: 'c1', permissionsFor: () => ({ has: (b) => has && b === P.MentionEveryone }) });
  await test('pingProblem: missing permission is reported, present permission is not', () => {
    const guild = { members: { me: { id: 'bot' }, cache: new Map() }, roles: { cache: new Map() } };
    assert.match(pingProblem(guild, chan(false), 'everyone', [], P), /Mention @everyone, @here, and All Roles/);
    assert.equal(pingProblem(guild, chan(true), 'everyone', [], P), null);
    assert.equal(pingProblem(guild, chan(false), 'none', [], P), null);
  });
  await test('pingProblem: a bot that cannot identify itself is not falsely blamed', () => {
    const guild = { members: { me: null, cache: new Map() }, roles: { cache: new Map() } };
    assert.equal(pingProblem(guild, chan(false), 'everyone', [], P), null);
    const found = { members: { me: null, cache: new Map([['bot', { id: 'bot' }]]) }, roles: { cache: new Map() } };
    assert.match(pingProblem(found, { ...chan(false), client: { user: { id: 'bot' } } }, 'everyone', [], P), /missing/);
  });
}
