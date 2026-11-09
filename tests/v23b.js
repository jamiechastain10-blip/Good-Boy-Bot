/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * 2.3 "replace the other bots" tests: custom commands, /say and sticky messages, server logs, counters and charts,
 * welcome back roles, "we miss you", and /migrate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PermissionFlagsBits as P } from 'discord.js';
import { makeWorld } from './features.js';
import { matchMessage } from '../modules/tags/index.js';
import { buildPost } from '../modules/messages/index.js';
import { counterName } from '../modules/stats/index.js';
import { parseRolePairs, parseTagPaste, scanServer, applyFinding, findRoleByName } from '../src/migrate.js';

const G = '900000000000000500';
class Coll extends Map { filter(fn) { return new Coll([...this].filter(([k, v]) => fn(v, k))); } first() { return this.values().next().value; } }
const msg = (w, member, ch, content) => ({ id: `m${Math.random()}`, guildId: G, channelId: ch.id, channel: ch, author: member.user, member, content, embeds: [], createdTimestamp: Date.now(), delete: async () => {} });

export default async function runV23bTests({ test }) {
  console.log('\n2.3 custom commands');
  await test('custom commands: ?name and !name, whole-message, starts-with and word matches; no partial-word false alarms', () => {
    const list = [{ name: 'rules', trigger: 'command' }, { name: 'ip', trigger: 'exact' }, { name: 'join', trigger: 'starts', phrase: 'how do i join' }, { name: 'mc', trigger: 'contains', phrase: 'minecraft' }];
    assert.equal(matchMessage('?rules', list, ['?', '!']).cmd.name, 'rules');
    assert.equal(matchMessage('!RULES please', list, ['?', '!']).args, 'please');
    assert.equal(matchMessage('IP', list, ['?']).cmd.name, 'ip');
    assert.equal(matchMessage('ip address?', list, ['?']), null, 'exact means the whole message');
    assert.equal(matchMessage('How do I join the server', list, ['?']).cmd.name, 'join');
    assert.equal(matchMessage('anyone on minecraft tonight?', list, ['?']).cmd.name, 'mc');
    assert.equal(matchMessage('minecrafters unite', list, ['?']), null, 'whole words only');
    assert.equal(matchMessage('?nothing', list, ['?']), null);
  });

  await test('custom commands: added through /tags add, reply with variables and never ping, cooldown per channel, removable', async () => {
    const w = await makeWorld(['tags'], { guildId: G }).load();
    const mod = w.person('900000000000000501', { bits: [P.ModerateMembers, P.ManageMessages, P.KickMembers] });
    const member = w.person('900000000000000502');
    const ch = w.channel('general');
    const add = w.ix({ command: 'tags', sub: 'add', member: mod, opts: { name: 'rules', response: 'Hi {username}, read <#1> @everyone', cooldown: 30 } });
    await w.mm.handleCommand(add);
    assert.match(add.text(), /Added \*\*rules\*\*/);
    const denied = w.ix({ command: 'tags', sub: 'add', member, opts: { name: 'x', response: 'y' } }); await w.mm.handleCommand(denied);
    assert.match(denied.text(), /permission/);
    await w.mm.dispatch('messageCreate', G, msg(w, member, ch, '?rules'));
    assert.equal(ch.sent.length, 1);
    assert.match(ch.sent[0].content, /Hi 900000000000000502/);
    assert.deepEqual(ch.sent[0].allowedMentions, { parse: [] }, '@everyone in a reply never pings');
    await w.mm.dispatch('messageCreate', G, msg(w, member, ch, '?rules'));
    assert.equal(ch.sent.length, 1, 'cooldown');
    const rm = w.ix({ command: 'tags', sub: 'remove', member: mod, opts: { name: 'rules' } }); await w.mm.handleCommand(rm);
    assert.equal((await w.mm.runView(G, 'tags', 'list')).rows.length, 0);
  });

  console.log('\n2.3 messages');
  await test('/say: plain text or a box, colours and picture links checked; sticky messages repost and remove the old copy', async () => {
    assert.equal(buildPost({ text: 'hi' }).content, 'hi');
    assert.equal(buildPost({ text: 'hi', title: 'T', color: '#ff0000' }).embeds[0].data.color, 0xff0000);
    assert.throws(() => buildPost({ text: 'x', color: 'red' }), /hex/);
    assert.throws(() => buildPost({ text: 'x', image: 'javascript:alert(1)' }), /https/);
    const w = await makeWorld(['messages'], { guildId: G }).load();
    const admin = w.person('900000000000000503', { bits: [P.ManageGuild] });
    const ch = w.channel('clips');
    const set = w.ix({ command: 'sticky', sub: 'set', member: admin, channel: ch, opts: { message: 'Post clips here!' } });
    await w.mm.handleCommand(set);
    assert.equal(ch.sent.length, 1); assert.equal(ch.sent[0].content, 'Post clips here!');
    const { repostSticky } = await import('../modules/messages/index.js');
    await repostSticky(w.mm.ctx(G, 'messages'), ch.id);
    assert.equal(ch.sent.length, 2); assert.equal(ch.deleted.length, 1, 'the old copy is removed');
    const say = w.ix({ command: 'say', sub: 'send', member: admin, channel: ch, opts: { message: 'Hello', title: 'News' } });
    await w.mm.handleCommand(say);
    assert.equal(ch.sent.at(-1).embeds[0].data.title, 'News');
  });

  console.log('\n2.3 server logs');
  await test('server logs: joins, leaves, role and nickname changes and voice go to the server log only when turned on', async () => {
    const w = await makeWorld(['moderation'], { guildId: G }).load();
    const log = w.channel('server-log');
    const m = w.person('900000000000000504'); m.user.createdTimestamp = Date.now() - 86400000 * 3;
    await w.mm.dispatch('guildMemberAdd', G, m);
    assert.equal(log.sent.length, 0, 'off by default');
    w.mm.setSetting(G, 'moderation', 'serverLogChannel', log.id);
    for (const k of ['logJoins', 'logRoles', 'logNicknames', 'logVoice']) w.mm.setSetting(G, 'moderation', k, true);
    await w.mm.dispatch('guildMemberAdd', G, m);
    assert.match(log.sent.at(-1).embeds[0].data.title, /Member joined/);
    const r = w.role('900000000000000590');
    const before = { ...m, nickname: null, roles: { cache: new Coll() } };
    const after = { ...m, nickname: 'Ace', roles: { cache: new Coll([[r.id, r]]) } };
    await w.mm.dispatch('guildMemberUpdate', G, before, after);
    const titles = log.sent.map((p) => p.embeds[0].data.title);
    assert.ok(titles.includes('🎭 Roles changed') && titles.includes('🏷️ Nickname changed'));
    await w.mm.dispatch('voiceStateUpdate', G, { channelId: null, member: m }, { channelId: '900000000000000591', member: m, guild: m.guild });
    assert.match(log.sent.at(-1).embeds[0].data.description, /joined 🔊/);
    await w.mm.dispatch('guildMemberRemove', G, m);
    assert.match(log.sent.at(-1).embeds[0].data.title, /Member left/);
  });

  console.log('\n2.3 counters and charts');
  await test('counter channels show live numbers; the charts box has 30 days, 24 hours and joins', async () => {
    assert.equal(counterName('Members: {members}', { members: 1234 }), 'Members: 1,234');
    const w = await makeWorld(['stats'], { guildId: G }).load();
    const admin = w.person('900000000000000505', { bits: [P.ManageGuild] });
    const vc = w.channel('counter'); vc.type = 2;
    const add = w.ix({ command: 'counter', sub: 'add', member: admin, opts: { channel: vc, text: 'Members: {members}' } });
    await w.mm.handleCommand(add);
    assert.equal(vc.name, 'Members: 10');
    const bad = w.ix({ command: 'counter', sub: 'add', member: admin, opts: { channel: vc, text: 'no numbers' } }); await w.mm.handleCommand(bad);
    assert.match(bad.text(), /at least one number/);
    const charts = (await w.mm.runView(G, 'stats', 'charts')).charts;
    assert.deepEqual(charts.map((c) => c.bars.length), [30, 24, 30]);
  });

  console.log('\n2.3 welcome back');
  await test('welcome back: normal roles come back on rejoin, powerful ones never; "we miss you" goes out a week before the review', async () => {
    const w = await makeWorld(['member-management', 'stats'], { guildId: G }).load();
    const gamer = w.role('900000000000000592'), mod = w.role('900000000000000593', { dangerous: true });
    const m = w.person('900000000000000506');
    m.roles.cache.set(gamer.id, gamer); m.roles.cache.set(mod.id, mod);
    await w.mm.dispatch('guildMemberRemove', G, m);
    const back = w.person('900000000000000506');
    await w.mm.dispatch('guildMemberAdd', G, back);
    assert.ok(back.roles.cache.has(gamer.id), 'Gamer role is back');
    assert.ok(!back.roles.cache.has(mod.id), 'staff/powerful roles are never given back');
    const ctx = w.mm.ctx(G, 'stats');
    ctx.data.set('coverage', { trackingSince: Date.now() - 100 * 86400000 });
    w.mm.setSetting(G, 'stats', 'inactiveWarn', true);
    const { missYouWarning } = await import('../modules/stats/index.js');
    // simulate the day: last day of the month minus 6
    const now = new Date(); const y = now.getUTCFullYear(), mo = now.getUTCMonth();
    const day = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate() - 6;
    const at = Date.UTC(y, mo, day, 12);
    assert.equal(await missYouWarning(ctx, Date.UTC(y, mo, 1, 12)), 0, 'not on other days');
    const task = w.mm.active.get(G).get('stats').tasks.find((t) => t.name === 'miss-you');
    const realNow = Date.now; Date.now = () => at;
    try { await task.run(ctx); } finally { Date.now = realNow; }
    assert.match(String(back.user.sent.at(-1)?.content ?? ''), /haven't seen you/);
  });

  console.log('\n2.3 migrate');
  await test('/migrate tags: pasted blocks become custom commands', () => {
    const list = parseTagPaste('rules\nBe nice.\nNo spam.\n---\n?ip\nplay.example.com\n---\nempty');
    assert.deepEqual(list, [{ name: 'rules', response: 'Be nice.\nNo spam.' }, { name: 'ip', response: 'play.example.com' }]);
  });

  await test('/migrate scan finds what Carl-bot left (reaction roles, logs, starboard, welcome, join roles, counters, bans) and imports only what is picked', async () => {
    const w = await makeWorld(['moderation'], { guildId: G }).load();
    const carl = w.person('235148962103951360'); carl.user.bot = true; carl.user.username = 'Carl-bot';
    const guild = carl.guild;
    const gamer = w.role('900000000000000594'); gamer.name = 'Gamer';
    const artist = w.role('900000000000000595'); artist.name = 'Artist';
    const roles = w.channel('roles'), logs = w.channel('logs'), stars = w.channel('starboard'), hello = w.channel('welcome');
    const cm = (ch, content, extra = {}) => ({ id: `${ch.id}${Math.floor(Math.random() * 1e6)}`, author: carl.user, content, embeds: [], reactions: { cache: new Coll() }, ...extra });
    const feeds = new Map([
      [roles.id, [cm(roles, `Pick your roles!\n🎮 : <@&${gamer.id}>\n🎨 Artist`, { reactions: { cache: new Coll([['a', { emoji: { name: '🎮' } }], ['b', { emoji: { name: '🎨' } }]]) } })]],
      [logs.id, [cm(logs, '', { embeds: [{ title: 'Message Deleted', description: 'in #general' }] }), cm(logs, '', { embeds: [{ title: 'Message Deleted', description: 'in #memes' }] }), cm(logs, '', { embeds: [{ title: 'Member Joined' }] }), cm(logs, '', { embeds: [{ title: 'Member Joined' }] })]],
      [stars.id, [cm(stars, `⭐ **4** <#${hello.id}>`), cm(stars, `⭐ **7** <#${hello.id}>`)]],
      [hello.id, [cm(hello, 'Welcome <@900000000000000507> to Test Guild!'), cm(hello, 'Welcome <@900000000000000508> to Test Guild!')]],
    ]);
    for (const ch of [roles, logs, stars, hello]) {
      for (const x of feeds.get(ch.id) ?? []) x.delete = async () => { x.deleted = true; };
      ch.messages.fetch = async (o) => (typeof o === 'string' ? (feeds.get(ch.id) ?? []).find((x) => x.id === o) : new Coll((feeds.get(ch.id) ?? []).map((x) => [x.id, x])));
    }
    const newbie = w.person('900000000000000509', { joinedDaysAgo: 0 }), newbie2 = w.person('900000000000000510', { joinedDaysAgo: 0 });
    guild.fetchAuditLogs = async () => ({ entries: new Coll([newbie, newbie2].map((n, k) => [String(k), { executorId: carl.id, targetId: n.id, createdTimestamp: n.joinedTimestamp + 2000, changes: [{ key: '$add', new: [{ id: artist.id }] }] }])) });
    const vc = w.channel('Members: 10'); vc.type = 2;
    guild.bans = { fetch: async () => new Coll([['x', { user: { id: '900000000000000511', tag: 'spammer#0' }, reason: 'Spam' }]]) };
    assert.deepEqual(parseRolePairs(`🎮 : <@&${gamer.id}>\n🎨 Artist`, guild), [{ emojiKey: '🎮', emoji: '🎮', roleId: gamer.id }, { emojiKey: '🎨', emoji: '🎨', roleId: artist.id }]);
    const res = await scanServer(guild);
    assert.deepEqual(res.bots.map((b) => b.name), ['Carl-bot']);
    const kinds = res.findings.map((f) => f.kind);
    for (const k of ['reactionroles', 'logs', 'starboard', 'welcome', 'autoroles', 'counters', 'bans']) assert.ok(kinds.includes(k), `${k} in ${kinds}`);
    assert.equal(res.findings.find((f) => f.kind === 'welcome').data.message, 'Welcome {user} to {server}!');
    assert.equal(res.findings.find((f) => f.kind === 'starboard').data.threshold, 4);
    assert.equal(res.findings.find((f) => f.kind === 'counters').data.counters[0].template, 'Members: {members}');
    // nothing was changed by the scan
    assert.equal(w.mm.ctx(G, 'moderation').config.get('logChannel') ?? null, null);
    for (const f of res.findings) await applyFinding(w.mm, G, f);
    const rr = w.mm.ctx(G, 'roles');
    // the old reaction-role message is replaced by a Good Boy role menu in the same channel, keeping its heading
    const menuPost = roles.sent.at(-1);
    assert.equal(menuPost.embeds[0].data.title, 'Pick your roles!');
    assert.match(menuPost.embeds[0].data.description, new RegExp(`🎮 <@&${gamer.id}> · \\*\\*0\\*\\* members`));
    assert.equal(menuPost.components[0].components.length, 2, 'a button per role');
    assert.ok(feeds.get(roles.id)[0].deleted, 'the old message is removed');
    assert.deepEqual(rr.data.get('autorole:members'), [artist.id]);
    assert.equal(w.mm.ctx(G, 'moderation').config.get('logChannel'), logs.id);
    assert.equal(w.mm.ctx(G, 'engagement').config.get('starboardChannel'), stars.id);
    assert.equal(w.mm.ctx(G, 'member-management').config.get('welcomeMessage'), 'Welcome {user} to {server}!');
    assert.equal(w.mm.ctx(G, 'moderation').data.get('hist:900000000000000511')[0].reason, 'Spam');
    await applyFinding(w.mm, G, res.findings.find((f) => f.kind === 'bans'));
    assert.equal(w.mm.ctx(G, 'moderation').data.get('hist:900000000000000511').length, 1, 'bans are not copied twice');
  });

  await test('/migrate reads number-emoji role lists (1️⃣ to 🔟) with role names and small typos, and only counts real log boxes', async () => {
    const w = await makeWorld(['moderation'], { guildId: G }).load();
    const names = ['Roblox', 'VRChat', 'Overwatch', 'Rainbow Six Siege', 'Fortnite', 'Counter Strike 2', 'Minecraft', 'HELLDIVERS 2', 'Palworld', 'Zenless Zone Zero'];
    const roles = names.map((n, k) => { const r = w.role(`9000000000000006${String(k).padStart(2, '0')}`); r.name = n; return r; });
    const keys = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const text = 'Game Roles Below Pick any.\nPlease dont spam the roles\n' + keys.map((k, n) => `${k}${n === 3 ? 'Rainbow SIx Seige' : names[n]}`).join('\n');
    const carl = w.person('235148962103951360'); carl.user.bot = true; carl.user.username = 'Carl-bot';
    const guild = carl.guild;
    const pairs = parseRolePairs(text, guild);
    assert.deepEqual(pairs.map((p) => p.emojiKey), keys, 'all ten number emojis');
    assert.deepEqual(pairs.map((p) => p.roleId), roles.map((r) => r.id), 'each to the right role, typo included');
    assert.equal(findRoleByName(guild, 'nonsense words'), null);
    // logs: TTS Bot's messages in the no-mic channel are not logs; Carl-bot's boxes with "deleted in #" in the author line are
    const tts = w.person('513423712582762502'); tts.user.bot = true; tts.user.username = 'TTS Bot';
    const nomic = w.channel('no-mic'), logs = w.channel('logs');
    const box = (author, embed) => ({ id: `x${Math.random()}`, author: author.user, content: '', embeds: [embed], reactions: { cache: new Coll() } });
    nomic.messages.fetch = async () => new Coll([1, 2, 3].map((n) => [`n${n}`, box(tts, { description: 'Basic joined voice and changed nickname' })]));
    logs.messages.fetch = async () => new Coll([1, 2].map((n) => [`l${n}`, box(carl, { author: { name: 'Message deleted in #general' }, description: 'hi' })]));
    let progress = 0;
    const res = await scanServer(guild, { onProgress: () => progress++ });
    const log = res.findings.find((f) => f.kind === 'logs');
    assert.equal(log.data.msgCh, logs.id);
    assert.ok(!JSON.stringify(log.data).includes(nomic.id), 'the no-mic channel is not a log channel');
    assert.ok(progress > 0, 'progress is reported');
    assert.ok(res.scannedMessages >= 5);
  });

  console.log('\n2.3.1 purge and member stats');
  await test('purge: no 100 or 14-day limit; old messages go one by one, big purges ask first, pins are kept', async () => {
    const w = await makeWorld(['moderation'], { guildId: G }).load();
    const mod = w.person('900000000000000520', { bits: [P.ManageMessages, P.ModerateMembers, P.KickMembers] });
    const ch = w.channel('general');
    const now = Date.now();
    let msgs = Array.from({ length: 250 }, (_, k) => ({ id: String(1000 + k), createdTimestamp: now - k * 3600000 * 3, author: { id: k % 2 ? '900000000000000521' : '900000000000000522' }, pinned: k === 5 }));
    for (const m of msgs) m.delete = async () => { msgs = msgs.filter((x) => x !== m); };
    ch.messages.fetch = async ({ limit = 50, before } = {}) => { let pool = [...msgs].sort((a, b) => b.createdTimestamp - a.createdTimestamp); if (before) { const ref = Number(before); pool = pool.filter((m) => Number(m.id) > ref); } return new Coll(pool.slice(0, limit).map((m) => [m.id, m])); };
    ch.bulkDelete = async (ids) => { const set = new Set(ids); const gone = msgs.filter((m) => set.has(m.id) && now - m.createdTimestamp < 14 * 86400000); msgs = msgs.filter((m) => !gone.includes(m)); return new Coll(gone.map((m) => [m.id, m])); };
    const small = w.ix({ command: 'purge', member: mod, channel: ch, opts: { amount: 10 } }); await w.mm.handleCommand(small);
    assert.match(small.text(), /Deleted 10 message/);
    assert.equal(msgs.length, 240);
    const all = w.ix({ command: 'purge', member: mod, channel: ch, opts: {} }); await w.mm.handleCommand(all);
    assert.match(all.text(), /Delete \*\*every\*\* message/, 'everything asks first');
    assert.equal(msgs.length, 240, 'nothing yet');
    const yes = w.ix({ customId: `mpurge:yes:${mod.id}`, member: mod, channel: ch }); await w.mm.handleComponent(yes);
    assert.deepEqual(msgs.map((m) => m.id), ['1005'], 'everything gone, including messages older than 14 days, except the pin');
    assert.match(yes.edits.at(-1).content, /Done: deleted 239/);
  });

  await test('purge all by recreating: confirm first, then the new channel takes over the old one\'s settings', async () => {
    const w = await makeWorld(['moderation', 'clips'], { guildId: G }).load();
    const mod = w.person('900000000000000523', { bits: [P.ManageMessages, P.ModerateMembers] });
    const ch = w.channel('game-clips'); ch.position = 4;
    w.mm.setSetting(G, 'clips', 'clipsChannel', ch.id);
    const fresh = w.channel('game-clips-new');
    ch.clone = async () => fresh; fresh.setPosition = async (p) => { fresh.position = p; }; ch.delete = async () => { ch.deletedChannel = true; };
    const ask = w.ix({ command: 'purge', member: mod, channel: ch, opts: { method: 'recreate' } }); await w.mm.handleCommand(ask);
    assert.match(ask.text(), /Recreate/); assert.ok(!ch.deletedChannel);
    const yes = w.ix({ customId: `mpurge:yes:${mod.id}`, member: mod, channel: ch }); await w.mm.handleComponent(yes);
    assert.ok(ch.deletedChannel); assert.equal(fresh.position, 4);
    assert.equal(w.mm.ctx(G, 'clips').config.get('clipsChannel'), fresh.id, 'settings now point at the new channel');
  });

  await test('member stats: this month, last month, all time, month by month; right-click Message stats; calendar-month periods', async () => {
    const w = await makeWorld(['stats'], { guildId: G }).load();
    const m = w.person('900000000000000524');
    const ctx = w.mm.ctx(G, 'stats');
    const today = new Date(); const ym = (d) => d.toISOString().slice(0, 7);
    const prev = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 10));
    ctx.sql.run('INSERT INTO stats_user_day (guild_id, user_id, day, messages) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)', G, m.id, `${ym(today)}-01`, 7, G, m.id, `${ym(prev)}-10`, 20, G, m.id, '2024-01-05', 3);
    const r = w.ix({ command: 'stats', sub: 'member', member: m, opts: { member: m.user } }); await w.mm.handleCommand(r);
    const e = r.replies[0].embeds[0].data;
    const f = Object.fromEntries(e.fields.map((x) => [x.name, x.value]));
    assert.match(f['This month'], /\*\*7\*\* messages/); assert.match(f['Last month'], /\*\*20\*\* messages/); assert.match(f['All time'], /\*\*30\*\* messages/);
    assert.equal(f['Month by month'].split('\n').length, 3);
    const lm = w.ix({ command: 'stats', sub: 'member', member: m, opts: { member: m.user, period: 'lastmonth' } }); await w.mm.handleCommand(lm);
    assert.match(lm.replies[0].embeds[0].data.fields[0].value, /^20/);
    const menu = w.ix({ command: 'Message stats', member: m }); menu.targetUser = m.user; await w.mm.handleCommand(menu);
    assert.match(menu.replies[0].embeds[0].data.title, /900000000000000524/);
  });

  console.log('\n2.3.2 role menus, migrate learning, AutoMod page');
  await test('role menus: each role with its emoji and member count, a button per role, never pings', async () => {
    const w = await makeWorld(['roles'], { guildId: G }).load();
    const { buildMenu } = await import('../modules/roles/index.js');
    const r1 = w.role('900000000000000530'); r1.name = 'Roblox'; r1.members = new Map([['a', {}], ['b', {}]]);
    const r2 = w.role('900000000000000531'); r2.name = 'Fortnite'; r2.members = new Map([['a', {}]]);
    const guild = w.person('900000000000000532').guild;
    const msg = buildMenu(guild, { roleIds: [r1.id, r2.id], emojis: { [r1.id]: '1️⃣', [r2.id]: '<:fn:900000000000000533>' }, title: 'Game roles', description: 'Pick any', mode: 'toggle', type: 'buttons' });
    const d = msg.embeds[0].data;
    assert.equal(d.title, 'Game roles');
    assert.match(d.description, /Pick any\n\n1️⃣ <@&900000000000000530> · \*\*2\*\* members\n<:fn:900000000000000533> <@&900000000000000531> · \*\*1\*\* member$/);
    const buttons = msg.components[0].components.map((b) => b.data);
    assert.deepEqual(buttons.map((b) => b.label), ['Roblox', 'Fortnite']);
    assert.equal(buttons[1].emoji.id, '900000000000000533');
    assert.deepEqual(msg.allowedMentions, { parse: [] }, 'listing roles never pings them');
  });

  await test('/migrate learns custom commands from chat (?ip answered by Carl-bot) and reports which commands people used', async () => {
    const w = await makeWorld(['moderation'], { guildId: G }).load();
    const carl = w.person('235148962103951360'); carl.user.bot = true; carl.user.username = 'Carl-bot';
    const guild = carl.guild;
    const general = w.channel('general');
    const t0 = Date.now() - 86400000;
    const um = (id, content, at) => ({ id, author: { id: '900000000000000540', bot: false }, content, embeds: [], createdTimestamp: at, reactions: { cache: new Coll() } });
    const bm = (id, content, at, extra = {}) => ({ id, author: carl.user, content, embeds: [], createdTimestamp: at, reactions: { cache: new Coll() }, ...extra });
    const msgs = [um('1', '?ip', t0), bm('2', 'play.boxboyz.net', t0 + 900, { reference: { messageId: '1' } }), um('3', '!rules', t0 + 5000), bm('4', '', t0 + 6000, { embeds: [{ title: 'Rules', description: 'Be nice' }] }),
      um('5', '?rank', t0 + 9000), bm('6', 'You are level 5', t0 + 9500), bm('7', 'Your rank card', t0 + 20000, { interaction: { commandName: 'rank' } })];
    general.messages.fetch = async () => new Coll(msgs.map((m) => [m.id, m]));
    const res = await scanServer(guild);
    const tags = res.findings.find((f) => f.kind === 'tags');
    assert.deepEqual(tags.data.tags.map((t) => t.name).sort(), ['ip', 'rules'], 'learned ?ip and !rules, not the built-in ?rank');
    assert.equal(tags.data.tags.find((t) => t.name === 'rules').response, '**Rules**\nBe nice');
    const usage = res.findings.find((f) => f.kind === 'usage');
    assert.ok(usage.info, 'a report, not something to import');
    assert.match(usage.detail, /\/rank`? 1× → \*\*\/rank\*\*/);
    await applyFinding(w.mm, G, tags);
    const ctx = w.mm.ctx(G, 'tags');
    assert.equal(ctx.data.get('cc:ip').response, 'play.boxboyz.net');
    assert.equal(ctx.data.get('cc:ip').from, 'Carl-bot');
  });

  await test('AutoMod page: presets, one rule at a time, word and site lists, and a test that changes nothing', async () => {
    const w = await makeWorld(['moderation'], { guildId: G }).load();
    const actor = { userId: '900000000000000550', username: 'admin' };
    const run = (a, body) => w.mm.runAction(G, 'moderation', a, body, actor);
    await run('automod-preset', { preset: 'strict' });
    let page = await w.mm.runView(G, 'moderation', 'automodpage');
    assert.equal(page.preset, 'strict');
    assert.ok(page.rules.every((r) => r.desc), 'every rule explains itself');
    await run('automod-rule', { rule: 'caps', enabled: false });
    await run('automod-rule', { rule: 'spam', limit: 7 });
    page = await w.mm.runView(G, 'moderation', 'automodpage');
    assert.equal(page.preset, 'custom', 'changing a rule makes it custom');
    assert.equal(page.rules.find((r) => r.id === 'spam').limit, 7);
    assert.equal(page.rules.find((r) => r.id === 'caps').on, false);
    await run('automod-list', { list: 'words', op: 'add', value: 'freenitro' });
    await run('automod-list', { list: 'domains', op: 'add', value: 'medal.tv' });
    const t = (await run('automod-test', { text: 'get freenitro at https://scam.example and https://medal.tv/x' })).results;
    assert.ok(t.find((x) => x.id === 'words').hit); assert.match(t.find((x) => x.id === 'links').why, /scam\.example/);
    const clean = (await run('automod-test', { text: 'gg everyone, see https://medal.tv/clip' })).results;
    assert.ok(clean.every((x) => !x.hit || !x.on), 'a normal message passes');
    assert.equal((w.mm.ctx(G, 'moderation').data.get('automod:recent') ?? []).length, 0, 'testing records nothing');
    await run('automod-list', { list: 'words', op: 'remove', value: 'freenitro' });
    assert.ok(!(w.mm.ctx(G, 'moderation').config.get('bannedWords') ?? []).includes('freenitro'));
    await assert.rejects(run('automod-set', { key: 'logChannel', value: '1' }), /not on this page/);
  });

  await test('big-win announcements: off by default; when on, only the chosen wins, one per member every 10 minutes (jackpots always)', async () => {
    const { shouldShout } = await import('../modules/games/index.js');
    const w = await makeWorld(['economy', 'games'], { guildId: G }).load();
    const cfg = w.mm.ctx(G, 'games').config;
    assert.equal(cfg.get('announceBigWins'), false, 'off unless an admin turns it on');
    assert.equal(shouldShout({ announceBigWins: false, bigWinLevel: 'rare' }, 'jackpot', null), false);
    const on = { announceBigWins: true, bigWinLevel: 'mythical' };
    assert.equal(shouldShout(on, 'legendary', null), false, 'Legendary fish are not announced on the default level');
    assert.equal(shouldShout(on, 'mythical', null), true);
    const now = Date.now();
    assert.equal(shouldShout(on, 'mythical', now - 60000, now), false, 'one per member every 10 minutes');
    assert.equal(shouldShout(on, 'mythical', now - 11 * 60000, now), true);
    assert.equal(shouldShout(on, 'jackpot', now - 1000, now), true, 'jackpots always');
    assert.equal(shouldShout({ announceBigWins: true, bigWinLevel: 'jackpots' }, 'mythical', null), false);
  });

  console.log('\n2.3.2 design system');
  await test('new look: one shared design system for the dashboard, phone page and app; motion stops when asked; dark dropdowns; island and new Modules page', () => {
    const pub = (f) => fs.readFileSync(new URL(`../src/dashboard/public/${f}`, import.meta.url), 'utf8');
    const css = pub('liquid.css'), js = pub('liquid.js'), app = pub('app.js');
    for (const page of ['index.html', 'app.html']) { assert.match(pub(page), /liquid\.css/); assert.match(pub(page), /liquid\.js/); }
    assert.match(fs.readFileSync(new URL('../desktop/renderer/index.html', import.meta.url), 'utf8'), /liquid\.css[\s\S]*liquid\.js/);
    assert.match(css, /prefers-reduced-motion:reduce/); assert.match(css, /\.motion-off \*/);
    assert.match(css, /select option\{background:var\(--gb-solid\)/, 'the open list of a dropdown is dark too');
    assert.match(css, /@supports \(appearance: base-select\)/);
    assert.ok(!/innerHTML/.test(js), 'no HTML strings');
    for (const need of ['GB.island.mount', 'island.news(', 'renderModulePage', 'setupSheet', "'Needs setup'", 'Undo']) assert.ok(app.includes(need), need);
    assert.ok(!/animation|@keyframes/.test(pub('style.css')), 'motion stays out of the layout stylesheet');
  });

  console.log('\n2.3.3 fishing expansion and voice XP');
  await test('fishing expansion: the 2.3.3 places up to level 85 are unchanged, old levels unchanged, steeper past 32, late places pay more XP and fight harder', async () => {
    const F = await import('../src/fishing.js');
    assert.deepEqual(F.BIOMES.slice(5, 9).map((b) => b.level), [40, 55, 70, 85]);
    for (const b of F.BIOMES) for (const r of F.RARITIES) assert.ok(Object.values(F.FISH).some((f) => f.biome === b.id && f.rarity === r.id), `${b.id} ${r.id}`);
    // Old curve kept up to 32, so nobody's level moved.
    for (const l of [2, 12, 30, 32]) assert.equal(F.xpForLevel(l), Math.round(100 * (l - 1) ** 1.5), `level ${l}`);
    let prev = 0;
    for (let l = 2; l <= 100; l++) { const step = F.xpForLevel(l) - F.xpForLevel(l - 1); assert.ok(step > prev, `level ${l} costs more than the one before`); prev = step; }
    assert.ok(F.xpForLevel(60) - F.xpForLevel(59) > 3 * (F.xpForLevel(33) - F.xpForLevel(32)), 'much steeper later');
    const top = F.levelFromXp(1e12);
    assert.equal(top.level, F.MAX_LEVEL); assert.equal(top.max, true); assert.equal(top.needed, 0);
    assert.equal(F.levelFromXp(F.xpForLevel(100) - 1).level, 99);
    assert.equal(F.levelFromXp(F.xpForLevel(70)).level, 70);
    // Rods unlock in order and each new one is better.
    { const shop = F.RODS.filter((r) => !r.earn); for (let k = 1; k < shop.length; k++) assert.ok(shop[k].level > shop[k - 1].level && shop[k].luck > shop[k - 1].luck); }
    assert.ok(F.BAITS.find((b) => b.id === 'stormfly') && F.BAITS.find((b) => b.id === 'starlure'));
    // XP multiplier by place.
    const c = { rarity: 'epic', mutation: null, giant: false };
    assert.equal(F.catchXp(c), 100); assert.equal(F.catchXp(c, 'bay'), 100); assert.equal(F.catchXp(c, 'abyss'), 300);
    // Harder fish: the same fish, rod and presses lose more ground in the Abyss than in the Deep.
    const play = (biome) => { const s = F.startReel({ rod: 'voidreach', tackle: 'none', fish: { rarity: 'rare' }, seed: 9, now: 0, biteMs: 0, surges: false }); s.biome = biome; s.zone = 0; s.pos = 19; s.struck = false; F.reelStep(s, 'reel', 1); return s; };
    const easy = play('deep'), hard = play('abyss');
    assert.ok(hard.progress < easy.progress && hard.tension > easy.tension, 'late places fight harder');
  });

  await test('fishing expansion in the game: a catch in a late place gives its bonus XP; the hub shows max level', async () => {
    const F = await import('../src/fishing.js');
    const w = await makeWorld(['economy', 'games'], { guildId: G }).load();
    const ctx = w.mm.ctx(G, 'games');
    ctx.sql.run('INSERT OR IGNORE INTO games_fish_profile (guild_id, user_id) VALUES (?, ?)', G, 'u1');
    ctx.sql.run('UPDATE games_fish_profile SET xp = ? WHERE guild_id = ? AND user_id = ?', F.xpForLevel(100) + 50, G, 'u1');
    const p = ctx.sql.get('SELECT xp FROM games_fish_profile WHERE guild_id = ? AND user_id = ?', G, 'u1');
    assert.equal(F.levelFromXp(p.xp).level, 100);
    const src = fs.readFileSync(new URL('../modules/games/index.js', import.meta.url), 'utf8');
    assert.match(src, /F\.catchXp\(c, sp\.biome[,)]/, 'landing a fish uses the place it came from');
    assert.match(src, /lv\.max \?/, 'the hub has a max-level line instead of dividing by zero');
  });

  await test('voice XP: on by default, can be turned off; only members with someone else in the channel; never deafened, AFK or bots; muted is a setting; daily limit; level-ups announce and give roles', async () => {
    const { voiceEarners, voiceTick, levelOf } = await import('../modules/community/index.js');
    const w = await makeWorld(['community'], { guildId: G }).load();
    const ctx = w.mm.ctx(G, 'community');
    const vc = w.channel('lounge'), solo = w.channel('solo');
    w.g.afkChannelId = 'afk';
    const vs = (id, channel, extra = {}) => {
      const member = w.people.get(id) ?? w.person(id);
      return [id, { id, channelId: channel?.id ?? channel, channel: typeof channel === 'string' ? null : channel, member, selfDeaf: false, serverDeaf: false, selfMute: false, serverMute: false, ...extra }];
    };
    const botMember = { id: 'bot2', user: { id: 'bot2', bot: true } };
    w.g.voiceStates = { cache: new Map([
      vs('a', vc), vs('b', vc), vs('m', vc, { selfMute: true }), vs('d', vc, { selfDeaf: true }),
      vs('s', solo), ['bot2', { id: 'bot2', channelId: solo.id, member: botMember }],
      vs('z1', 'afk'), vs('z2', 'afk'),
    ]) };
    assert.deepEqual(voiceEarners(w.g).map((v) => v.id).sort(), ['a', 'b'], 'alone (with a bot), deafened, muted and AFK do not count');
    assert.deepEqual(voiceEarners(w.g, { countMuted: true }).map((v) => v.id).sort(), ['a', 'b', 'm']);

    assert.equal(ctx.config.get('voiceXp'), true, 'on by default (2.3.3)');
    w.mm.setSetting(G, 'community', 'voiceXp', false);
    assert.equal(await voiceTick(ctx), 0, 'admins can turn it off');
    w.mm.setSetting(G, 'community', 'voiceXp', true);
    w.mm.setSetting(G, 'community', 'voiceXpPerMinute', 10);
    w.mm.setSetting(G, 'community', 'voiceXpDailyMinutes', 3);
    assert.equal(await voiceTick(ctx), 2);
    assert.equal(ctx.data.get('user:a').xp, 10);
    assert.ok(!ctx.data.get('user:m'), 'muted members earn nothing by default');
    for (let k = 0; k < 5; k++) await voiceTick(ctx);
    assert.equal(ctx.data.get('user:a').xp, 30, 'stops at the daily limit');
    assert.equal(ctx.data.get('user:a').voiceToday, 3);
    assert.equal(await voiceTick(ctx, Date.now() + 86400000), 2, 'a new day starts again');

    // Level-up: announced in the voice channel chat (no level-up channel set), with the level role.
    w.role('lvl1', { pos: 2 });
    ctx.data.set('reward:1', 'lvl1');
    ctx.data.set('user:b', { xp: levelOf(0).needed - 5, messages: 0, rep: 0, lastXp: 0, lastRep: 0 });
    w.mm.setSetting(G, 'community', 'voiceXpDailyMinutes', 0);
    vc.sent.length = 0;
    await voiceTick(ctx);
    assert.equal(levelOf(ctx.data.get('user:b').xp).level, 1);
    assert.ok(vc.sent.some((m) => /level \*\*1\*\*|level 1/i.test(m.content ?? '')), 'level-up announced');
    assert.ok(w.people.get('b').roles.cache.has('lvl1'), 'level role given');
  });

  await test('more fish: the 2.3.3 fish keep their ids and names, both kinds bite', async () => {
    const F = await import('../src/fishing.js');
    assert.equal(F.FISH['bay-0'].name, 'Pier Minnow', 'saved catches keep pointing at the same fish');
    assert.equal(F.FISH['bay-6'].name, 'Dock Sprat');
    for (const b of F.BIOMES.slice(0, 9)) for (const r of F.RARITIES) assert.ok(F.fishIn(b.id).filter((f) => f.rarity === r.id).length >= 2, `${b.id} ${r.id}`);
    assert.equal(new Set(Object.values(F.FISH).map((f) => f.name)).size, Object.keys(F.FISH).length, 'every name is different');
    const got = new Set(Array.from({ length: 400 }, (_, k) => F.rollCatch({ biome: 'bay' }, F.seeded(k)).species));
    assert.ok(got.has('bay-0') && got.has('bay-6'), 'both commons bite');
  });

  await test('challenge rules: 3 different dailies and a weekly, always possible for the member, same every time; progress rules; rewards grow with level', async () => {
    const CH = await import('../src/fishchallenges.js');
    const F = await import('../src/fishing.js');
    for (const level of [1, 4, 5, 12, 25, 40, 60, 85, 100]) for (let k = 0; k < 30; k++) {
      const d = CH.makeDailies(level, `g:u:${k}`);
      assert.equal(d.length, 3); assert.equal(new Set(d.map((c) => c.kind)).size, 3, 'three different kinds');
      assert.deepEqual(d, CH.makeDailies(level, `g:u:${k}`), 'same seed, same challenges');
      for (const c of [...d, CH.makeWeekly(level, `g:u:${k}`)]) {
        assert.ok(c.goal >= 1 && c.reward.coins > 0, JSON.stringify(c));
        if (c.biome) assert.ok(F.biomeById(c.biome).level <= level, `place unlocked at level ${level}: ${c.biome}`);
        if (c.species) assert.ok(F.FISH[c.species].biome === c.biome && ['common', 'uncommon'].includes(F.FISH[c.species].rarity));
        assert.ok(CH.describe(c).length > 5);
      }
    }
    const step = (ch, events) => events.reduce((st, e) => CH.advance(ch, st.progress, st.seen, e), { progress: 0, seen: [] });
    const fish = (species, extra = {}) => ({ type: 'catch', fish: { species, rarity: F.FISH[species].rarity, weight: F.FISH[species].min, giant: false, mutation: null, ...extra } });
    assert.equal(step({ kind: 'catch', goal: 5 }, [fish('bay-0'), fish('marsh-1')]).progress, 2);
    assert.equal(step({ kind: 'place', biome: 'marsh', goal: 5 }, [fish('bay-0'), fish('marsh-1')]).progress, 1);
    assert.equal(step({ kind: 'rarity', rarity: 'rare', goal: 5 }, [fish('bay-1'), fish('bay-2'), fish('bay-5')]).progress, 2, 'rare or better');
    assert.equal(step({ kind: 'species', species: 'bay-6', goal: 2 }, [fish('bay-0'), fish('bay-6')]).progress, 1);
    assert.equal(step({ kind: 'heavy', biome: 'bay', weight: 2, goal: 1 }, [fish('bay-1', { weight: 1.5 }), fish('marsh-4', { weight: 50 })]).progress, 0);
    assert.equal(step({ kind: 'heavy', biome: 'bay', weight: 2, goal: 1 }, [fish('bay-2', { weight: 2.5 })]).progress, 1);
    const v = step({ kind: 'variety', goal: 5 }, [fish('bay-0'), fish('bay-0'), fish('bay-6')]);
    assert.equal(v.progress, 2); assert.deepEqual(v.seen, ['bay-0', 'bay-6']);
    assert.equal(step({ kind: 'sell', goal: 100 }, [{ type: 'sell', coins: 60 }, fish('bay-0'), { type: 'sell', coins: 60 }]).progress, 100, 'sales add up, capped at the goal');
    assert.equal(step({ kind: 'mutation', goal: 1 }, [fish('bay-0'), fish('bay-0', { mutation: 'mutated' })]).progress, 1);
    assert.equal(step({ kind: 'giant', goal: 1 }, [fish('bay-0', { giant: true })]).progress, 1);
    assert.equal(CH.advance({ kind: 'catch', goal: 1 }, 1, [], fish('bay-0')).progress, 1, 'a finished challenge stays finished');
    assert.ok(CH.rewards(60).daily.coins > CH.rewards(10).daily.coins && CH.rewards(10).daily.coins > CH.rewards(1).daily.coins);
    assert.equal(CH.rewards(F.MAX_LEVEL).daily.xp, 0, 'no XP at the max level, coins still');
    assert.equal(CH.streakBonus(30, 7).coins, CH.streakBonus(30, 50).coins, 'streak bonus stops growing after a week');
    assert.ok(CH.streakBonus(30, 3).coins > CH.streakBonus(30, 1).coins);
    assert.equal(CH.weekKey(Date.parse('2026-11-04T12:00:00Z')), '2026-11-02', 'weeks start on Monday');
    assert.equal(CH.weekKey(Date.parse('2026-11-08T23:00:00Z')), '2026-11-02');
    assert.equal(CH.nextDayAt(Date.parse('2026-11-04T12:00:00Z')), Date.parse('2026-11-05T00:00:00Z'));
    assert.equal(CH.yesterdayKey(Date.parse('2026-11-01T05:00:00Z')), '2026-10-31');
  });

  await test('challenges in the game: Challenges page; a catch and a sale finish challenges and pay; all 3 dailies pay a streak bonus with bait; the streak grows day to day; admins can turn them off', async () => {
    const { gameWorld, btn, embedText } = await import('./v22.js');
    const CH = await import('../src/fishchallenges.js');
    globalThis[Symbol.for('goodboy.games.frameMs')] = 0; globalThis[Symbol.for('goodboy.games.biteMs')] = 0; globalThis[Symbol.for('goodboy.games.surges')] = false;
    const w = await gameWorld();
    const g = w.mm.ctx('1', 'games');
    const hub = await w.cmd('fish', w.alice);
    assert.ok(btn(hub.replies[0], (c) => c.label === 'Challenges'));
    const page = await w.press('gm:fh:alice:quests', w.alice);
    assert.match(embedText(page.updated), /Today · 0\/3/); assert.match(embedText(page.updated), /This week/);
    assert.equal(g.sql.get("SELECT COUNT(*) AS n FROM games_fish_challenges WHERE user_id = 'alice'").n, 4);

    // Swap in known challenges for today.
    const today = `d:${CH.dayKey(Date.now())}`, week = `w:${CH.weekKey(Date.now())}`;
    const put = (period, slot, spec) => g.sql.run("INSERT OR REPLACE INTO games_fish_challenges (guild_id, user_id, period, slot, spec, progress, seen, done_at) VALUES ('1', 'alice', ?, ?, ?, 0, '[]', NULL)", period, slot, JSON.stringify({ ...spec, reward: { coins: 100, xp: 10 } }));
    put(today, 0, { kind: 'catch', goal: 1 }); put(today, 1, { kind: 'place', biome: 'bay', goal: 1 }); put(today, 2, { kind: 'sell', goal: 1 });
    put(week, 0, { kind: 'catch', goal: 1 });
    w.setCoins('alice', 0);
    let msg = null;
    for (let tries = 0; tries < 5 && !g.sql.get("SELECT COUNT(*) AS n FROM games_fish_bag WHERE user_id = 'alice'").n; tries++) {
      const castId = btn((await w.cmd('fish', w.alice)).replies[0], (c) => c.label === 'Cast').custom_id;
      await w.form(castId, w.alice, { biome: ['bay'], rod: ['driftwood'], bait: ['none'], tackle: ['none'] });
      for (let k = 0; k < 80; k++) {
        const row = g.sql.get("SELECT * FROM games_sessions WHERE user_id = 'alice' AND kind = 'fish'");
        if (!row) break;
        const s = JSON.parse(row.state); s.progress = Math.max(s.progress, 95); s.zone = Math.max(0, Math.min(20 - 5, s.pos - 2));
        g.sql.run('UPDATE games_sessions SET state = ? WHERE id = ?', JSON.stringify(s), row.id);
        msg = (await w.press(`gm:fr:${row.id}:left`, w.alice)).updated;
      }
    }
    assert.match(embedText(msg), /Challenge done:\*\* Catch 1 fish/);
    assert.match(embedText(msg), /Weekly challenge done/);
    assert.equal(w.coins('alice'), 300, 'three challenges paid');
    assert.equal(g.sql.get("SELECT streak FROM games_fish_profile WHERE user_id = 'alice'").streak, 0, 'no streak until all three are done');
    const sold = await w.press('gm:fh:alice:sellall', w.alice);
    assert.match(embedText(sold.updated), /All of today's challenges done/);
    const p = g.sql.get("SELECT streak, streak_day FROM games_fish_profile WHERE user_id = 'alice'");
    assert.deepEqual([p.streak, p.streak_day], [1, CH.dayKey(Date.now())]);
    assert.equal(g.sql.get("SELECT qty FROM games_fish_bait WHERE user_id = 'alice' AND bait = 'worm'").qty, 3, 'bonus bait');
    // Kept up yesterday: the streak grows.
    g.sql.run("UPDATE games_fish_profile SET streak = 4, streak_day = ? WHERE user_id = 'alice'", CH.yesterdayKey(Date.now()));
    g.sql.run("UPDATE games_fish_challenges SET progress = 0, done_at = NULL WHERE user_id = 'alice' AND period = ? AND slot = 2", today);
    g.sql.run("INSERT INTO games_fish_bag (guild_id, user_id, species, rarity, weight, value, biome, caught_at) VALUES ('1', 'alice', 'bay-0', 'common', 1, 50, 'bay', 0)");
    await w.press('gm:fh:alice:sellall', w.alice);
    assert.equal(g.sql.get("SELECT streak FROM games_fish_profile WHERE user_id = 'alice'").streak, 5);

    // Collection pages: an overview plus a page per place.
    const dex = await w.press('gm:fh:alice:dex', w.alice);
    assert.match(embedText(dex.updated), /Collection · 1\/2,000/);
    assert.equal(dex.updated.components.length, 2, 'a place picker and a back row');
    assert.equal(dex.updated.components[0].components[0].options.length, 24, 'every place is in the picker');
    const reef = await w.press('gm:fh:alice:dex-reef', w.alice);
    assert.match(embedText(reef.updated), /Unlocks at fishing level 40/);
    const bayPages = await Promise.all([0, 1, 2, 3].map(async (n) => embedText((await w.press(`gm:fh:alice:dex-bay.${n}`, w.alice)).updated)));
    assert.ok(bayPages.some((t) => /✅ \*\*[A-Z]/.test(t)), 'the caught fish is on one of the place pages');

    w.mm.setSetting('1', 'games', 'fishChallenges', false);
    assert.ok(!btn((await w.cmd('fish', w.alice)).replies[0], (c) => c.label === 'Challenges'), 'no button when turned off');
  });

  console.log('\n2.3.3 fixes: XP in tickets, ticket setup, /logs');
  await test('no XP or level-up messages in tickets or in switched-off channels and categories; /xp ignore manages the list', async () => {
    const w = await makeWorld(['community', 'support'], { guildId: G }).load();
    const ctx = w.mm.ctx(G, 'community');
    const admin = w.person('900000000000000701', { bits: [P.ManageGuild, P.Administrator], pos: 15 });
    const chat = w.channel('chat'), ticket = w.channel('ticket-0001'), quiet = w.channel('memes');
    const cat = w.channel('Off-topic'); cat.type = 4; quiet.parentId = cat.id;
    w.mm.ctx(G, 'support').data.set(`ticket:${ticket.id}`, { number: 1, opener: admin.id, status: 'open' });
    const { xpAllowed } = await import('../modules/community/index.js');
    assert.equal(xpAllowed(ctx, chat), true);
    assert.equal(xpAllowed(ctx, ticket), false, 'tickets never give XP');
    await w.run(w.ix({ command: 'xp', group: 'ignore', sub: 'add', member: admin, opts: { channel: cat } }));
    assert.equal(xpAllowed(ctx, quiet), false, 'a channel inside a switched-off category');
    const list = await w.run(w.ix({ command: 'xp', group: 'ignore', sub: 'list', member: admin }));
    assert.match(list, /Off-topic/);
    await w.run(w.ix({ command: 'xp', group: 'ignore', sub: 'remove', member: admin, opts: { channel: cat } }));
    assert.equal(xpAllowed(ctx, quiet), true);
    // a real message in a ticket gives nothing
    const m = w.person('900000000000000702');
    await w.mm.dispatch('messageCreate', G, { guild: w.g, guildId: G, author: m.user, member: m, channel: ticket, channelId: ticket.id, content: 'hi', system: false });
    assert.ok(!ctx.data.get(`user:${m.id}`)?.xp, 'no XP from a ticket message');
    await w.mm.dispatch('messageCreate', G, { guild: w.g, guildId: G, author: m.user, member: m, channel: chat, channelId: chat.id, content: 'hi', system: false });
    assert.ok(ctx.data.get(`user:${m.id}`).xp > 0, 'XP in normal chat');
  });

  await test('/ticket setup: picks the category, log channel and staff role, shows the setup when empty, and moves open tickets', async () => {
    const w = await makeWorld(['support'], { guildId: G }).load();
    const admin = w.person('900000000000000711', { bits: [P.ManageGuild, P.Administrator], pos: 15 });
    const land = w.channel('ticket land'); land.type = 4;
    const log = w.channel('ticket-logs');
    const open = w.channel('ticket-0007'); open.parentId = null; let movedTo = null;
    open.setParent = async (id) => { movedTo = id; open.parentId = id; };
    w.mm.ctx(G, 'support').data.set(`ticket:${open.id}`, { number: 7, opener: admin.id, status: 'open' });
    const empty = await w.run(w.ix({ command: 'ticket', sub: 'setup', member: admin }));
    assert.match(empty, /Category: \*not set\*/);
    const r = await w.run(w.ix({ command: 'ticket', sub: 'setup', member: admin, opts: { category: land, log_channel: log, move_open_tickets: true } }));
    assert.equal(w.mm.ctx(G, 'support').config.get('ticketCategory'), land.id);
    assert.equal(w.mm.ctx(G, 'support').config.get('logChannel'), log.id);
    assert.equal(movedTo, land.id, 'the open ticket moved into ticket land');
    assert.match(r, /Moved 1 existing ticket/);
    const notCat = await w.run(w.ix({ command: 'ticket', sub: 'setup', member: admin, opts: { category: log } }));
    assert.match(notCat, /Pick a \*\*category\*\*/);
  });

  await test('/logs: set the mod and server log channels and events in one command; empty shows the setup; off turns it off', async () => {
    const w = await makeWorld(['moderation'], { guildId: G }).load();
    const ctx = w.mm.ctx(G, 'moderation');
    const admin = w.person('900000000000000721', { bits: [P.ManageGuild, P.Administrator], pos: 15 });
    const modlog = w.channel('mod-log'), server = w.channel('server-log');
    const shown = await w.run(w.ix({ command: 'logs', sub: 'setup', member: admin }));
    assert.match(shown, /Mod log.*not set/);
    const warn = await w.run(w.ix({ command: 'logs', sub: 'setup', member: admin, opts: { joins: true } }));
    assert.match(warn, /Pick a channel/, 'warns when an event has nowhere to go');
    await w.run(w.ix({ command: 'logs', sub: 'setup', member: admin, opts: { mod_channel: modlog, server_channel: server, roles: true, voice: true } }));
    assert.equal(ctx.config.get('logChannel'), modlog.id); assert.equal(ctx.config.get('serverLogChannel'), server.id);
    assert.equal(ctx.config.get('logRoles'), true); assert.equal(ctx.config.get('logJoins'), true);
    const m = w.person('900000000000000722'); m.user.createdTimestamp = Date.now() - 86400000;
    await w.mm.dispatch('guildMemberAdd', G, m);
    assert.match(server.sent.at(-1).embeds[0].data.title, /Member joined/);
    await w.run(w.ix({ command: 'logs', sub: 'off', member: admin, opts: { which: 'server' } }));
    assert.equal(ctx.config.get('serverLogChannel'), null); assert.equal(ctx.config.get('logJoins'), false);
    const member = w.person('900000000000000723');
    const denied = await w.run(w.ix({ command: 'logs', sub: 'setup', member }));
    assert.doesNotMatch(denied, /Saved/, 'members cannot change logs');
  });

  await test('reaction XP: reacting to someone else\'s message gives a little XP once per cooldown; own messages, bots and tickets give nothing; GIF-only messages count as messages', async () => {
    const { reactionXp, levelOf } = await import('../modules/community/index.js');
    const w = await makeWorld(['community', 'support'], { guildId: G }).load();
    const ctx = w.mm.ctx(G, 'community');
    const a = w.person('900000000000000731'), b = w.person('900000000000000732');
    const chat = w.channel('chat'), ticket = w.channel('ticket-0003');
    w.mm.ctx(G, 'support').data.set(`ticket:${ticket.id}`, { number: 3, opener: a.id, status: 'open' });
    const msg = (author, channel) => ({ guildId: G, channelId: channel.id, channel, author: author.user });
    const t0 = Date.now();
    await reactionXp(ctx, { message: msg(b, chat) }, a.user, t0);
    assert.equal(ctx.data.get(`user:${a.id}`).xp, 2, 'default 2 XP');
    await reactionXp(ctx, { message: msg(b, chat) }, a.user, t0 + 30000);
    assert.equal(ctx.data.get(`user:${a.id}`).xp, 2, 'cooldown');
    await reactionXp(ctx, { message: msg(b, chat) }, a.user, t0 + 61000);
    assert.equal(ctx.data.get(`user:${a.id}`).xp, 4);
    await reactionXp(ctx, { message: msg(a, chat) }, a.user, t0 + 130000);
    assert.equal(ctx.data.get(`user:${a.id}`).xp, 4, 'reacting to your own message gives nothing');
    await reactionXp(ctx, { message: msg(b, ticket) }, a.user, t0 + 260000);
    assert.equal(ctx.data.get(`user:${a.id}`).xp, 4, 'no XP in tickets');
    await reactionXp(ctx, { message: msg(a, chat) }, { id: 'bot9', bot: true }, t0);
    assert.ok(!ctx.data.get('user:bot9'), 'bots get nothing');
    w.mm.setSetting(G, 'community', 'reactionXp', false);
    await reactionXp(ctx, { message: msg(b, chat) }, a.user, t0 + 400000);
    assert.equal(ctx.data.get(`user:${a.id}`).xp, 4, 'admins can turn it off');
    // reaction level-ups use the same announcement and level roles
    w.mm.setSetting(G, 'community', 'reactionXp', true);
    ctx.data.set(`user:${b.id}`, { xp: levelOf(0).needed - 1, messages: 0, rep: 0, lastXp: 0, lastRep: 0 });
    chat.sent.length = 0;
    await reactionXp(ctx, { message: msg(a, chat) }, b.user, t0);
    assert.equal(levelOf(ctx.data.get(`user:${b.id}`).xp).level, 1);
    assert.ok(chat.sent.some((m) => /level/i.test(m.content ?? '')), 'level-up announced');
    // a message that is only a GIF (link or attachment) gives message XP like any other message
    const c = w.person('900000000000000733');
    await w.mm.dispatch('messageCreate', G, { guild: w.g, guildId: G, author: c.user, member: c, channel: chat, channelId: chat.id, content: 'https://tenor.com/view/happy-dog-gif-123', system: false });
    assert.ok(ctx.data.get(`user:${c.id}`).xp > 0, 'GIF messages count');
  });

  await test('ticket transcripts say why the ticket was opened (type, urgency, form answers) and show what bot boxes say, in txt and html', async () => {
    const S = await import('../modules/support/index.js');
    const html = (await import('../modules/support-html-transcripts/index.js')).default;
    let renderHtml; html.init({ hostApi: { registerTranscriptFormat: (n, fn) => { renderHtml = fn; } } });
    const ticket = { number: 12, typeLabel: 'Report a member', priority: 'high', openerTag: 'ari_luvzz', createdAt: Date.UTC(2026, 10, 2, 19, 9),
      report: { name: 'spammer123' }, answers: [{ q: 'What happened?', a: 'They kept posting scam links in general' }, { q: 'Evidence', a: '' }], status: 'closed', closedAt: Date.UTC(2026, 10, 2, 20), closeReason: 'Banned the spammer' };
    const summary = S.ticketSummary(ticket);
    const get = (l) => summary.find((r) => r.label === l)?.value;
    assert.equal(get('Type'), 'Report a member'); assert.equal(get('What happened?'), 'They kept posting scam links in general');
    assert.equal(get('About'), 'spammer123'); assert.equal(get('Close reason'), 'Banned the spammer'); assert.ok(get('Urgency'));
    assert.ok(!summary.some((r) => r.label === 'Evidence'), 'empty answers are left out');
    const msgs = [{ createdTimestamp: ticket.createdAt, author: { tag: 'Good Boy#0000', displayAvatarURL: () => '' }, cleanContent: '', attachments: new Map(),
      embeds: [{ data: { title: 'Ticket #12 · Report a member', fields: [{ name: 'What happened?', value: 'They kept posting scam links in general' }] } }] }];
    const txt = S.default.api.formats.get('txt').fn({ ticket, messages: msgs, guild: { name: 'Server' } }).data;
    assert.match(txt, /WHY THIS TICKET WAS OPENED/); assert.match(txt, /What happened\?: They kept posting scam links/);
    assert.match(txt, /Ticket #12 · Report a member/, 'the bot box text is in the message list'); assert.doesNotMatch(txt, /\[1 embed\(s\)\]/);
    const page = renderHtml({ ticket, messages: msgs, guild: { name: 'Server' }, summary, embedText: S.embedText }).data;
    assert.match(page, /Why this ticket was opened/); assert.match(page, /They kept posting scam links in general/);
    assert.match(page, /<div class="box">/);
  });
}
