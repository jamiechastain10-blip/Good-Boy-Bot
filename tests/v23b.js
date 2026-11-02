/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * 2.3 "replace the other bots" tests: custom commands, /say and sticky messages, server logs, counters and charts,
 * welcome back roles, "we miss you", and /migrate.
 */
import assert from 'node:assert/strict';
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
    for (const ch of [roles, logs, stars, hello]) ch.messages.fetch = async () => new Coll((feeds.get(ch.id) ?? []).map((x) => [x.id, x]));
    const newbie = w.person('900000000000000509', { joinedDaysAgo: 0 }), newbie2 = w.person('900000000000000510', { joinedDaysAgo: 0 });
    guild.fetchAuditLogs = async () => ({ entries: new Coll([newbie, newbie2].map((n, k) => [String(k), { executorId: carl.id, targetId: n.id, createdTimestamp: n.joinedTimestamp + 2000, changes: [{ key: '$add', new: [{ id: artist.id }] }] }])) });
    const vc = w.channel('Members: 10'); vc.type = 2;
    guild.bans = { fetch: async () => new Coll([['x', { user: { id: '900000000000000511', tag: 'spammer#0' }, reason: 'Spam' }]]) };
    assert.deepEqual(parseRolePairs(`🎮 : <@&${gamer.id}>\n🎨 Artist`, guild), [{ emojiKey: '🎮', roleId: gamer.id }, { emojiKey: '🎨', roleId: artist.id }]);
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
    const rrMsg = res.findings.find((f) => f.kind === 'reactionroles').data.messageId;
    assert.equal(rr.data.get(`rr:${rrMsg}:🎮`), gamer.id);
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
}
