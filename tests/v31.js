/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * 3.1 tests: families, roleplay, giveaways, invites and the other "replace any bot" features.
 */
import assert from 'node:assert/strict';

export default async function runV31Tests({ test }) {
  const { makeWorld } = await import('./features.js');
  const json = (x) => (x?.toJSON ? x.toJSON() : x);
  const text = (i) => JSON.stringify([...i.replies, ...i.edits, ...i.follow, i.updated].filter(Boolean).map((r) => ({ c: r.content, e: (r.embeds ?? []).map(json) })));
  const btnIds = (r) => (r?.components ?? []).flatMap((row) => (json(row).components ?? []).map((c) => c.custom_id)).filter(Boolean);

  console.log('\n3.1 families');
  await test('family rules: no marrying yourself or family, one partner by default, one parent per child, no adopting relatives; trees and text', async () => {
    const FT = await import('../src/familytree.js');
    const g = FT.buildGraph([{ a: 'a', b: 'b' }, { a: 'c', b: 'd' }], [{ parent: 'a', child: 'c' }, { parent: 'c', child: 'e' }]);
    assert.match(FT.marryProblem(g, 'a', 'a'), /yourself/);
    assert.match(FT.marryProblem(g, 'a', 'x'), /already married/);
    assert.equal(FT.marryProblem(g, 'a', 'x', { maxPartners: 2 }), null, 'more partners when the server allows');
    assert.match(FT.marryProblem(g, 'e', 'b', { maxPartners: 3 }), /same family/);
    assert.equal(FT.marryProblem(g, 'x', 'y'), null);
    assert.match(FT.adoptProblem(g, 'x', 'c'), /already have a parent/);
    assert.match(FT.adoptProblem(g, 'e', 'a'), /already in your family/, 'no adopting your grandparent');
    assert.match(FT.adoptProblem(g, 'x', 'y', { maxChildren: 0 }), /already have 0 children/);
    assert.equal(FT.rootOf(g, 'e'), 'a');
    const t = FT.treeFrom(g, 'a');
    assert.deepEqual(t.people, ['a', 'b']); assert.deepEqual(t.children[0].people, ['c', 'd']); assert.deepEqual(t.children[0].children[0].people, ['e']);
    assert.equal(FT.countPeople(t), 5);
    assert.match(FT.treeText(t, (id) => id.toUpperCase(), { highlight: 'e' }), /👑 A ❤️ B[\s\S]*C ❤️ D[\s\S]*\*\*E\*\*/);
  });

  await test('/marry and /family: propose, only they can accept, married; adopt; info; divorce, disown and leave need a confirm press', async () => {
    const w = await makeWorld(['family']).load();
    const A = w.person('910000000000000001', { username: 'ann' }), B = w.person('910000000000000002', { username: 'ben' }), C = w.person('910000000000000003', { username: 'cat' });
    const run = async (command, member, opts = {}, sub = null) => { const i = w.ix({ command, member, opts, sub }); await w.mm.handleCommand(i); return i; };
    const press = async (customId, member) => { const i = w.ix({ customId, member }); await w.mm.handleComponent(i); return i; };
    const prop = await run('marry', A, { member: B.user });
    const [yes, no] = btnIds(prop.replies[0]);
    assert.match(yes, /^fam:yes:/); assert.match(no, /^fam:no:/);
    assert.match(text(await press(yes, C)), /Only <@910000000000000002> can answer/);
    assert.match(text(await press(yes, B)), /Just married/);
    assert.match(text(await run('marry', A, { member: C.user })), /already married/);
    const ad = await run('family', A, { member: C.user }, 'adopt');
    assert.match(text(await press(btnIds(ad.replies[0])[0], C)), /Welcome to the family/);
    const info = await run('family', C, {}, 'info');
    assert.match(text(info), /Parent[\s\S]*910000000000000001/);
    w.mm.setSetting('1', 'family', 'maxPartners', '3');
    assert.match(text(await run('marry', C, { member: B.user })), /same family/, 'no marrying your parent\'s partner');
    w.mm.setSetting('1', 'family', 'maxPartners', '1');
    const div = await run('family', A, {}, 'divorce');
    const [confirm] = btnIds(div.replies[0]);
    assert.match(text(await press(confirm, B)), /for someone else/);
    assert.match(text(await press(confirm, A)), /Divorced/);
    const lv = await run('family', C, {}, 'leave');
    assert.match(text(await press(btnIds(lv.replies[0])[0], C)), /Done/);
    assert.match(text(await run('family', C, {}, 'tree')), /don't have a family yet/);
  });

  console.log('\n3.1 roleplay');
  await test('roleplay: /rp hug @member posts the animation, counts each pair, "hug back" only for them; solo actions; Tenor is used when set up and falls back', async () => {
    const R = await import('../modules/roleplay/index.js');
    const w = await makeWorld(['roleplay']).load();
    const A = w.person('920000000000000001', { username: 'ann' }), B = w.person('920000000000000002', { username: 'ben' });
    const run = async (opts, member = A) => { const i = w.ix({ command: 'rp', member, opts }); await w.mm.handleCommand(i); return i; };
    const press = async (customId, member) => { const i = w.ix({ customId, member }); await w.mm.handleComponent(i); return i; };
    const hug = await run({ action: 'hug', member: B.user });
    const msg = hug.replies[0];
    assert.match(json(msg.embeds[0]).description, /🤗 <@920000000000000001> hugged <@920000000000000002>!/);
    assert.match(json(msg.embeds[0]).footer.text, /first time/);
    const ART = await import('../src/gameart.js');
    if (await ART.canvasLib()) { assert.equal(msg.files[0].name, 'hug.gif'); assert.equal(Buffer.from(msg.files[0].attachment).subarray(0, 6).toString(), 'GIF89a'); }
    assert.match(json((await run({ action: 'hug', member: B.user })).replies[0].embeds[0]).footer.text, /2 times now/);
    const back = btnIds(msg)[0];
    assert.match(text(await press(back, A)), /Only <@920000000000000002>/);
    assert.match(json((await press(back, B)).replies[0].embeds[0]).description, /<@920000000000000002> hugged <@920000000000000001>/);
    assert.match(text(await run({ action: 'hug' })), /Pick who to hug/);
    assert.match(text(await run({ action: 'hug', member: A.user })), /can't hug yourself/);
    assert.match(json((await run({ action: 'dance' })).replies[0].embeds[0]).description, /💃 <@920000000000000001> is dancing/);
    assert.match(text(await run({ action: 'tenor-setup' })), /Only the person who runs this bot/);
    // Tenor: picks one of the results; refuses non-Tenor links; null on failure.
    const fake = async () => ({ ok: true, json: async () => ({ results: [{ media_formats: { gif: { url: 'https://media.tenor.com/a.gif' } } }, { media_formats: { gif: { url: 'https://evil.example/x.gif' } } }] }) });
    assert.equal(await R.tenorGif('k'.repeat(30), 'hug', { fetchFn: fake }), 'https://media.tenor.com/a.gif');
    assert.equal(await R.tenorGif('k'.repeat(30), 'hug', { fetchFn: async () => ({ ok: false }) }), null);
    assert.equal(await R.tenorGif(null, 'hug'), null);
  });

  console.log('\n3.1 giveaways');
  await test('giveaways: fair draw helper, coin prizes, Enter toggles, role requirement, ending pays coins and announces, reroll skips earlier winners, dashboard actions', async () => {
    const G = await import('../modules/giveaways/index.js');
    assert.deepEqual(G.drawWinners(['a', 'b', 'c', 'd'], 2, () => 0), ['a', 'b']);
    assert.equal(G.drawWinners(['a', 'a', 'b'], 5).length, 2, 'no one wins twice');
    assert.equal(G.coinPrize('5,000 coins'), 5000); assert.equal(G.coinPrize('Nitro'), null);
    const { PermissionFlagsBits: P } = await import('discord.js');
    const w = await makeWorld(['economy', 'giveaways']).load();
    const host = w.person('930000000000000001', { bits: [P.Administrator], pos: 9 });
    const ppl = ['930000000000000002', '930000000000000003', '930000000000000004'].map((id) => w.person(id));
    const ch = w.channel('giveaways'); const ctx = w.mm.ctx('1', 'giveaways');
    const now = Date.now();
    ctx.sql.run('INSERT INTO giveaways_list (guild_id, id, channel_id, message_id, host_id, prize, winner_count, role_id, created_at, ends_at) VALUES (?, 1, ?, NULL, ?, ?, 1, NULL, ?, ?)', '1', ch.id, host.id, '500 coins', now, now + 60000);
    const press = async (member) => { const i = w.ix({ customId: 'gw:enter:1', member, channel: ch }); i.followUp = async (p) => { i.follow.push(p); }; await w.mm.handleComponent(i); return i; };
    for (const m of ppl) await press(m);
    assert.match(text(await press(ppl[0])), /left the giveaway/, 'pressing again leaves');
    await press(ppl[0]);
    assert.match(json((await press(ppl[1])).updated.embeds[0]).footer.text, /2 entries/);
    await press(ppl[1]);
    const won = await G.finish(ctx, 1);
    assert.equal(won.length, 1); assert.ok(ppl.map((p) => p.id).includes(won[0]));
    const eco = w.mm.ctx('1', 'economy');
    const ecoApi = w.mm.ctx('1', 'giveaways').api('economy'), start = ecoApi.wallet('1', '930000000000000077').coins;
    assert.equal(ecoApi.wallet('1', won[0]).coins, start + 500, 'coins paid to the winner');
    assert.match(JSON.stringify(ch.sent.at(-1)), /Congratulations[\s\S]*500 coins/);
    assert.match(text(await press(ppl[2])), /has ended/);
    const again = await G.finish(ctx, 1, { reroll: 1 });
    assert.notEqual(again[0], won[0], 'reroll picks someone else');
    // a role requirement keeps others out
    const role = w.role('930000000000000099');
    ctx.sql.run('INSERT INTO giveaways_list (guild_id, id, channel_id, message_id, host_id, prize, winner_count, role_id, created_at, ends_at) VALUES (?, 2, ?, NULL, ?, ?, 1, ?, ?, ?)', '1', ch.id, host.id, 'VIP', role.id, now, now + 60000);
    const i2 = w.ix({ customId: 'gw:enter:2', member: ppl[0], channel: ch }); await w.mm.handleComponent(i2);
    assert.match(text(i2), /need the <@&930000000000000099> role/);
    assert.deepEqual((await w.mm.runView('1', 'giveaways', 'list')).rows.map((r) => r.id), [2, 1]);
    await w.mm.runAction('1', 'giveaways', 'end', { id: 2 }, { userId: host.id });
    assert.match((await w.mm.runView('1', 'giveaways', 'list')).rows[0].status, /Ended/);
    void eco;
  });

  console.log('\n3.1 invites');
  await test('invites: works out which invite was used (including a last use that deletes it), records joins and leaves, counts per inviter, top list and log line', async () => {
    const IV = await import('../modules/invites/index.js');
    const m = (o) => new Map(Object.entries(o));
    assert.deepEqual(IV.usedInvite(m({ a: { uses: 1, inviter: 'x' }, b: { uses: 3, inviter: 'y' } }), m({ a: { uses: 1, inviter: 'x' }, b: { uses: 4, inviter: 'y' } })), { code: 'b', inviter: 'y' });
    assert.deepEqual(IV.usedInvite(m({ c: { uses: 4, inviter: 'z', max: 5 } }), m({})), { code: 'c', inviter: 'z' }, 'last use of a limited invite');
    assert.equal(IV.usedInvite(m({ a: { uses: 1 } }), m({ a: { uses: 1 } })), null);
    const { PermissionFlagsBits: P } = await import('discord.js');
    const w = await makeWorld(['invites']).load();
    const inviter = w.person('940000000000000001', { username: 'host' });
    const log = w.channel('joins'); w.mm.setSetting('1', 'invites', 'logChannel', log.id);
    let uses = 0;
    w.g.invites = { fetch: async () => new Map([['abc', { code: 'abc', uses, inviter: { id: inviter.id }, maxUses: 0 }]]) };
    w.bot.permissions = { has: () => true };
    const ctx = w.mm.ctx('1', 'invites');
    await w.mm.dispatch('guildMemberAdd', '1', w.person('940000000000000009')); // first join just seeds the counts
    uses = 1;
    const joiner = w.person('940000000000000002', { username: 'newbie' });
    joiner.user.createdTimestamp = Date.now() - 2 * 86400000;
    await w.mm.dispatch('guildMemberAdd', '1', joiner);
    assert.match(log.sent.at(-1).content, /<@940000000000000002> joined, invited by <@940000000000000001> \(1 invite\) · ⚠️ new account/);
    assert.deepEqual(IV.stats(ctx, inviter.id), { joined: 1, here: 1, left: 0, fresh: 1 });
    await w.mm.dispatch('guildMemberRemove', '1', joiner);
    assert.deepEqual(IV.stats(ctx, inviter.id), { joined: 1, here: 0, left: 1, fresh: 1 });
    const i = w.ix({ command: 'invites', sub: 'user', member: inviter, opts: {} }); await w.mm.handleCommand(i);
    assert.match(json(i.replies[0].embeds[0]).description, /\*\*0\*\* still here · 1 joined · 1 left/);
    const top = await w.mm.runView('1', 'invites', 'top');
    assert.equal(top.rows[0].id, inviter.id);
  });

  console.log('\n3.1 modmail');
  await test('modmail: a DM opens a staff thread, staff replies go back as DMs, // notes stay, close ends it and the next DM opens a new thread, block stops DMs', async () => {
    const { PermissionFlagsBits: P } = await import('discord.js');
    const MM = await import('../modules/modmail/index.js');
    const w = await makeWorld(['modmail']).load();
    const staff = w.person('950000000000000001', { bits: [P.ModerateMembers, P.ManageMessages, P.KickMembers], pos: 5, username: 'staffy' });
    const member = w.person('950000000000000002', { username: 'mel' });
    const inbox = w.channel('modmail'); w.mm.setSetting('1', 'modmail', 'channel', inbox.id);
    const threads = [];
    const realSend = inbox.send;
    inbox.send = async (p) => { const m = await realSend(p); m.startThread = async ({ name }) => { const t = { id: `95000000000000010${threads.length}`, name, sent: [], archived: false, isThread: () => true, send: async (x) => { t.sent.push(x); return x; }, setArchived: async (v) => { t.archived = v; } }; threads.push(t); w.g.channels.cache.set(t.id, t); return t; }; return m; };
    member.user.createdTimestamp = Date.now() - 86400000 * 400; member.user.displayAvatarURL = () => null;
    const dms = []; member.user.send = async (p) => { dms.push(p); };
    w.client.users.fetch = async (id) => (id === member.id ? member.user : null);
    const replies = [];
    const dm = (content) => ({ author: member.user, content, attachments: new Map(), reply: async (p) => { replies.push(p); }, react: async () => {} });
    const ctx = w.mm.ctx('1', 'modmail');
    assert.equal(await MM.fromDM(ctx, dm('hi, someone is spamming me')), true);
    assert.equal(threads.length, 1); assert.match(JSON.stringify(threads[0].sent), /someone is spamming me/);
    assert.match(String(replies[0]?.content ?? replies[0]), /went to the staff/);
    await MM.fromDM(ctx, dm('they did it again'));
    assert.equal(threads.length, 1, 'same conversation, same thread');
    const staffMsg = (content) => ({ author: staff.user, member: staff, content, attachments: new Map(), channelId: threads[0].id, channel: threads[0], react: async () => {}, reply: async () => {} });
    await w.mm.dispatch('messageCreate', '1', staffMsg('// looks like an alt, check their invites'));
    assert.equal(dms.length, 0, 'notes stay with staff');
    await w.mm.dispatch('messageCreate', '1', staffMsg('Thanks, we banned them.'));
    assert.match(JSON.stringify(dms[0]), /Staff · Test Guild[\s\S]*Thanks, we banned them/);
    const close = w.ix({ customId: `mmail:close:${member.id}`, member: staff, channel: inbox }); close.message = { embeds: [] }; await w.mm.handleComponent(close);
    assert.equal(threads[0].archived, true); assert.match(JSON.stringify(dms.at(-1)), /was closed/);
    await MM.fromDM(ctx, dm('one more thing'));
    assert.equal(threads.length, 2, 'a new conversation after closing');
    const nope = w.ix({ customId: `mmail:block:${member.id}`, member, channel: inbox }); await w.mm.handleComponent(nope);
    assert.match(text(nope), /Only staff/);
    const block = w.ix({ customId: `mmail:block:${member.id}`, member: staff, channel: inbox }); await w.mm.handleComponent(block);
    assert.equal(await MM.fromDM(ctx, dm('let me in')), false);
  });

  console.log('\n3.1 highlights and translate');
  await test('highlights: whole-word matches, DM with a jump link, not for your own messages, not while you are chatting there, cooldown; translate reads Google\'s answer', async () => {
    const U = await import('../modules/utility/index.js');
    assert.deepEqual(U.matches('Is Pizza night on?', ['pizza', 'night', 'zza']), ['pizza', 'night']);
    assert.deepEqual(U.matches('pizzas', ['pizza']), []);
    const w = await makeWorld(['utility']).load();
    const fan = w.person('960000000000000001', { username: 'fan' }), talker = w.person('960000000000000002', { username: 'talker' });
    const ch = w.channel('general'); ch.permissionsFor = () => ({ has: () => true });
    const dms = []; fan.send = async (p) => { dms.push(p); };
    const hl = w.ix({ command: 'highlight', sub: 'add', member: fan, opts: { word: 'Pizza' } }); await w.mm.handleCommand(hl);
    assert.match(text(hl), /DM you when someone says \*\*pizza\*\*/);
    const say = (member, content, id) => w.mm.dispatch('messageCreate', '1', { author: member.user, member, guild: w.g, channel: ch, channelId: ch.id, content, url: `https://discord.com/channels/1/${ch.id}/${id}` });
    await say(fan, 'I love pizza', 'm1');
    assert.equal(dms.length, 0, 'not for your own message');
    U.matches('', []); // keep the import used
    const key = `1:${ch.id}:${fan.id}`; globalThis[Symbol.for('goodboy.utility.lastSaid')].set(key, Date.now() - 10 * 60000);
    await say(talker, 'pizza tonight?', 'm2');
    assert.equal(dms.length, 1); assert.match(JSON.stringify(dms[0]), /pizza[\s\S]*Jump to the message/);
    await say(talker, 'more pizza', 'm3');
    assert.equal(dms.length, 1, 'cooldown');
    const r = await U.translate('hola', 'en', { fetchFn: async () => ({ ok: true, json: async () => [[['hello', 'hola']], null, 'es'] }) });
    assert.deepEqual(r, { text: 'hello', from: 'es' });
  });

  console.log('\n3.1 Twitch alerts');
  await test('Twitch live alerts: need the owner\'s keys, get a token, a live stream becomes one new item, nothing when offline; only the owner sets keys', async () => {
    const IN = await import('../modules/integrations/index.js');
    const tw = globalThis[Symbol.for('goodboy.twitch')];
    const saved = { ...tw };
    try {
      Object.assign(tw, { id: null, secret: null, token: null, until: 0 });
      await assert.rejects(IN.twitchToken(async () => ({ ok: true })), /twitch-keys/);
      Object.assign(tw, { id: 'cid', secret: 'sec' });
      let live = true;
      const fake = async (url) => (url.includes('oauth2/token') ? { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) }
        : { ok: true, status: 200, json: async () => ({ data: live ? [{ id: '42', user_name: 'Ninja', user_login: 'ninja', title: 'Late night games', game_name: 'Fortnite' }] : [] }) });
      assert.deepEqual(await IN.twitchLive('ninja', fake), [{ id: 'live-42', title: '🔴 Ninja is live: Late night games', url: 'https://twitch.tv/ninja', author: 'Fortnite' }]);
      live = false;
      assert.deepEqual(await IN.twitchLive('ninja', fake), []);
      const w = await makeWorld(['integrations']).load();
      const { PermissionFlagsBits: P } = await import('discord.js');
      const admin = w.person('970000000000000001', { username: 'admin', bits: [P.Administrator, P.ManageGuild], pos: 9 });
      const i = w.ix({ command: 'feed', sub: 'twitch-keys', member: admin, opts: {} }); await w.mm.handleCommand(i);
      assert.match(text(i), /Only the person who runs this bot/);
    } finally { Object.assign(tw, saved); }
  });

  console.log('\n3.1 music queue');
  await test('music queue: songs get ids, play next, remove, shuffle keeps every song, repeat one replays, repeat all goes to the back; the player has a Queue button', async () => {
    const M = await import('../modules/music/index.js');
    const q = [];
    for (const [title, by] of [['A', 'u1'], ['B', 'u2'], ['C', 'u1']]) M.enqueue(q, { title, by });
    assert.ok(q.every((t) => t.uid));
    M.moveToFront(q, q[2].uid); assert.deepEqual(q.map((t) => t.title), ['C', 'A', 'B']);
    assert.equal(M.removeTrack(q, q[1].uid).title, 'A'); assert.deepEqual(q.map((t) => t.title), ['C', 'B']);
    assert.throws(() => M.removeTrack(q, 'nope'), /already played/);
    const big = Array.from({ length: 10 }, (_, k) => ({ title: String(k), uid: String(k) }));
    M.shuffle(big, () => 0.3); assert.deepEqual(big.map((t) => t.title).sort(), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    assert.deepEqual(M.afterSong(['x'], 'done', 'one'), ['done', 'x']); assert.deepEqual(M.afterSong(['x'], 'done', 'all'), ['x', 'done']); assert.deepEqual(M.afterSong(['x'], 'done', 'off'), ['x']);
    assert.equal(M.REPEAT_NEXT.off, 'one'); assert.equal(M.REPEAT_NEXT.all, 'off');
    const w = await makeWorld(['music']).load();
    const { PermissionFlagsBits: P } = await import('discord.js');
    const mod = w.person('980000000000000001', { bits: [P.ModerateMembers, P.ManageMessages, P.KickMembers], pos: 5 }); const room = w.channel('music');
    const cmd = w.ix({ command: 'music', member: mod, channel: room }); await w.mm.handleCommand(cmd);
    assert.match(JSON.stringify(room.sent.at(-1)), /music:queue/);
  });

  await test('music links: BandLab posts and songs play from BandLab\'s own file; other pages are searched for their audio; audio files without .mp3 in the name play', async () => {
    const ML = await import('../src/medialinks.js');
    assert.ok(ML.isBandLab('https://www.bandlab.com/post/fc99fa23-1d66-48f0-854d-3438f04b6da3'));
    assert.deepEqual(ML.bandlabTargets('https://www.bandlab.com/post/fc99fa23-1d66-48f0-854d-3438f04b6da3?sharedKey=x'), ['https://www.bandlab.com/api/v1.3/posts/fc99fa23-1d66-48f0-854d-3438f04b6da3']);
    assert.deepEqual(ML.bandlabTargets('https://bandlab.com/track/75d92019-a58f-4544-aa1b-4f1c02b9511f?revId=1'), ['https://www.bandlab.com/api/v1.3/songs/75d92019-a58f-4544-aa1b-4f1c02b9511f', 'https://www.bandlab.com/api/v1.3/posts/75d92019-a58f-4544-aa1b-4f1c02b9511f']);
    assert.deepEqual(ML.bandlabTargets('https://www.bandlab.com/explore'), []);
    const post = { revision: { song: { name: 'SONG SONG' }, creator: { name: 'Maker' }, mixdown: { duration: 141.2, file: 'https://static.bandlab.com/revisions-formatted/a/a.m4a' } } };
    const seen = [];
    const fetchFn = async (u) => { seen.push(u); return /posts/.test(u) ? { ok: true, status: 200, json: async () => post } : { ok: false, status: 404 }; };
    const t = await ML.bandlabTrack('https://bandlab.com/track/75d92019-a58f-4544-aa1b-4f1c02b9511f', { fetchFn });
    assert.deepEqual([t.title, t.artist, t.seconds, t.url, t.site], ['SONG SONG', 'Maker', 141, 'https://static.bandlab.com/revisions-formatted/a/a.m4a', 'BandLab']);
    assert.equal(seen.length, 2, 'tries the song, then the post');
    assert.equal(ML.parseBandLab({ revision: { mixdown: { file: 'https://evil.example/x.m4a' } } }), null, 'only plays BandLab\'s own files');
    await assert.rejects(ML.bandlabTrack('https://www.bandlab.com/post/fc99fa23-1d66-48f0-854d-3438f04b6da3', { fetchFn: async () => ({ ok: false, status: 406 }) }), /busy/);
    // Any page: preview tags, audio tags, JSON-LD, plain links.
    assert.equal(ML.audioFromPage('<meta property="og:audio" content="https://cdn.site.com/s/123"><meta property="og:title" content="Tune">', 'https://site.com/x').url, 'https://cdn.site.com/s/123');
    assert.equal(ML.audioFromPage('<audio controls src="/media/song.mp3"></audio>', 'https://site.com/p/1').url, 'https://site.com/media/song.mp3');
    assert.equal(ML.audioFromPage('<script>{"contentUrl":"https:\\/\\/a.b\\/c.m4a"}</script>', 'https://site.com').url, 'https://a.b/c.m4a');
    assert.equal(ML.audioFromPage('<a href="https://x.com/page">no</a>', 'https://site.com'), null);
    assert.equal(ML.audioFromPage('<audio src="http://localhost/a.mp3">', 'https://site.com'), null, 'never a private address');
    const res = (type, body = '', url) => ({ ok: true, url, headers: { get: () => type }, text: async () => body, body: { cancel: async () => {} } });
    assert.deepEqual(await ML.probeLink('https://files.site.com/download?id=9', { fetchFn: async () => res('audio/mpeg', '', 'https://files.site.com/download?id=9'), onlyAudioFiles: true }), { audio: true, type: 'audio/mpeg', url: 'https://files.site.com/download?id=9', title: 'download' });
    assert.equal(await ML.probeLink('https://site.com/p', { fetchFn: async () => res('text/html', '<audio src="a.mp3">'), onlyAudioFiles: true }), null, 'with media links off, pages are not read');
    assert.equal((await ML.probeLink('https://site.com/p', { fetchFn: async () => res('text/html', '<audio src="a.mp3">', 'https://site.com/p') })).url, 'https://site.com/a.mp3');
    assert.equal(await ML.probeLink('https://short.link/x', { fetchFn: async () => res('audio/mpeg', '', 'http://192.168.1.4/a.mp3') }), null, 'a redirect into a private address is refused');
    const M = await import('../modules/music/index.js');
    assert.ok(M.needsWhole({ url: 'https://static.bandlab.com/r/a.m4a' }) && M.needsWhole({ url: 'https://x.com/a', whole: true }), '.m4a songs are downloaded before playing');
    assert.ok(!M.needsWhole({ url: 'https://x.com/a.mp3' }) && !M.needsWhole({ url: 'https://radio.example/stream' }), 'mp3 and radio still stream');
    assert.deepEqual(await ML.probeLink('https://bnd.lb/x', { fetchFn: async () => res('text/html', '<p>app</p>', 'https://www.bandlab.com/post/fc99fa23-1d66-48f0-854d-3438f04b6da3') }), { redirect: 'https://www.bandlab.com/post/fc99fa23-1d66-48f0-854d-3438f04b6da3' });
  });

  await test('music: Spotify playlists and albums queue every song (as many as the limits allow); each is found on YouTube when its turn comes', async () => {
    const ML = await import('../src/medialinks.js');
    assert.deepEqual(ML.spotifyListId('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc'), { kind: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' });
    assert.deepEqual(ML.spotifyListId('https://open.spotify.com/intl-fr/album/4aawyAB9vmqN3uQ7FjRGTy'), { kind: 'album', id: '4aawyAB9vmqN3uQ7FjRGTy' });
    assert.equal(ML.spotifyListId('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'), null);
    const data = { props: { pageProps: { state: { data: { entity: { type: 'playlist', name: 'Hits', trackList: [
      { title: 'One', subtitle: 'Ashe', duration: 198840, isPlayable: true, entityType: 'track' },
      { title: 'Two', subtitle: 'Pitbull,\u00a0Sensato', duration: 85400, entityType: 'track' },
      { title: 'Gone', subtitle: 'X', isPlayable: false, entityType: 'track' },
      { title: 'A show', subtitle: 'Pod', entityType: 'episode' }] } } } } } };
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;
    assert.deepEqual(ML.parseSpotifyEmbed(html), { name: 'Hits', tracks: [{ title: 'One', artist: 'Ashe', seconds: 199 }, { title: 'Two', artist: 'Pitbull', seconds: 85 }] });
    assert.equal(ML.parseSpotifyEmbed('<html>nothing</html>'), null);
    const seen = [];
    const list = await ML.spotifyList('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', { fetchFn: async (u) => { seen.push(u); return { ok: true, text: async () => html }; } });
    assert.equal(seen[0], 'https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M');
    assert.equal(list.tracks.length, 2); assert.equal(list.kind, 'playlist');
    await assert.rejects(ML.spotifyList('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy', { fetchFn: async () => ({ ok: false }) }), /Couldn't read that Spotify album/);
    assert.equal(ML.spotifySearch({ title: 'One', artist: 'Ashe' }), 'ytsearch1:Ashe One audio');
    await assert.rejects(ML.spotifyTrack('https://open.spotify.com/artist/0du5cEVh5yTK9QJze8zA0C'), /song, playlist or album/);
  });

  await test('fishing: casting while an old cast is still open shows that fish again; one that already swam off is cleared, never "on the line" with nothing showing', async () => {
    globalThis[Symbol.for('goodboy.games.frameMs')] = 0; globalThis[Symbol.for('goodboy.games.biteMs')] = 0; globalThis[Symbol.for('goodboy.games.surges')] = false;
    const w = await makeWorld(['economy', 'games']).load();
    const room = w.channel('games'); const alice = w.person('alice');
    w.mm.setSetting('1', 'games', 'gamePictures', false);
    const press = async (customId) => { const i = w.ix({ customId, member: alice, channel: room }); await w.mm.handleComponent(i); return i; };
    const g = w.mm.ctx('1', 'games');
    const open = () => g.sql.all("SELECT * FROM games_sessions WHERE user_id = 'alice' AND kind = 'fish'");
    const first = await press('gm:fh:alice:again');
    assert.equal(open().length, 1, 'cast 1 is on the line');
    assert.ok(JSON.stringify(first.replies[0]).includes('gm:fr:'), 'the fight shows');
    // The message was dismissed: casting again brings the same fish back instead of an error.
    const again = await press('gm:fh:alice:again');
    assert.match(again.replies[0].content ?? '', /still have a fish on the line/);
    assert.ok(JSON.stringify(again.replies[0]).includes(`gm:fr:${open()[0].id}:reel`), 'with working buttons for that fish');
    assert.equal(open().length, 1);
    // Left alone after the bite: it swam off, so the next cast just starts.
    const row = open()[0]; const st = JSON.parse(row.state); st.lastAt = st.biteAt = Date.now() - 60000;
    g.sql.run('UPDATE games_sessions SET state = ? WHERE id = ?', JSON.stringify(st), row.id);
    const third = await press('gm:fh:alice:again');
    assert.doesNotMatch(third.replies[0].content ?? '', /still have/);
    assert.equal(open().length, 1); assert.notEqual(open()[0].id, row.id, 'a fresh cast');
  });

  await test('music: a song keeps playing past the "site must answer" time limit (it used to be cut off after 15 seconds); downloads that stall, and sites that never answer, are given up on', async () => {
    const M = await import('../modules/music/index.js');
    const http = await import('node:http');
    const srv = http.createServer((q, r) => {
      if (q.url === '/silent') return; // never answers
      r.writeHead(200, { 'content-type': 'audio/mpeg' });
      if (q.url === '/stall') { r.write(Buffer.alloc(100)); return; } // sends a little, then nothing
      const t = setInterval(() => r.write(Buffer.alloc(1000)), 50); r.on('close', () => clearInterval(t));
    });
    await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
      const o = await M.openStream(`${base}/song`, { answerMs: 200 });
      let bytes = 0; const start = Date.now();
      for await (const c of o.stream) { bytes += c.length; if (Date.now() - start > 700) break; }
      o.stop();
      assert.ok(bytes >= 8000, `still playing well past the 200 ms limit (${bytes} bytes)`);
      await assert.rejects(M.openStream(`${base}/silent`, { answerMs: 200 }), /too long to answer/);
      const st = await M.openStream(`${base}/stall`, { answerMs: 200, stallMs: 300 });
      await assert.rejects((async () => { for await (const c of st.stream) void c; })(), /stopped sending/);
    } finally { srv.closeAllConnections?.(); srv.close(); }
  });

  await test('music: long songs survive long pauses (ffmpeg reconnects to the site) and a song that stops early carries on from where it stopped; skips, radio and repeats are left alone', async () => {
    const M = await import('../modules/music/index.js');
    const ML = await import('../src/medialinks.js');
    const web = M.ffmpegArgs('https://cdn.example/a.mp3', { start: 61.7, headers: { 'User-Agent': 'X' } });
    assert.ok(web.includes('-reconnect') && web.includes('-reconnect_on_network_error'), 'reconnects to web addresses');
    assert.equal(web[web.indexOf('-ss') + 1], '61'); assert.equal(web[web.indexOf('-headers') + 1], 'User-Agent: X\r\n');
    assert.ok(web.indexOf('-ss') < web.indexOf('-i'), 'seeks the input');
    const file = M.ffmpegArgs('/songs/a.m4a');
    assert.ok(!file.includes('-reconnect') && !file.includes('-ss'), 'files: no reconnect, starts at the top');
    const t = { resumable: true, seconds: 8520 };
    assert.equal(M.resumePoint(t, 6000 * 1000), 5998, 'stopped 1:40:00 into a 2:22:00 video: carry on just before');
    assert.equal(M.resumePoint({ ...t, startAt: 5998 }, 1000 * 1000), 6996, 'counts from where the last resume started');
    assert.equal(M.resumePoint(t, 8510 * 1000), null, 'the last few seconds are just the end');
    assert.equal(M.resumePoint(t, 3000), null, 'one that never really started is not retried');
    assert.equal(M.resumePoint(t, 6000 * 1000, { skipping: true }), null, 'a skip is a skip');
    assert.equal(M.resumePoint({ ...t, source: 'radio' }, 6000 * 1000), null);
    assert.equal(M.resumePoint({ ...t, resumes: 5 }, 6000 * 1000), null, 'gives up after 5 tries');
    assert.equal(M.resumePoint({ seconds: 8520 }, 6000 * 1000), null, 'only when it can start part way in');
    // yt-dlp gives the audio's own address, with the headers the site wants.
    const { EventEmitter } = await import('node:events');
    const fake = (out, code = 0) => () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}; setImmediate(() => { c.stdout.emit('data', out); c.emit('close', code); }); return c; };
    const d = await ML.directAudio('yt-dlp', 'https://youtu.be/x', { spawnFn: fake(JSON.stringify({ url: 'https://rr1.example/videoplayback?x=1', protocol: 'https', duration: 8520, http_headers: { 'User-Agent': 'Moz', 'Bad\nHeader': 'x', Accept: 'a\r\nInjected: 1' } })) });
    assert.deepEqual(d, { url: 'https://rr1.example/videoplayback?x=1', headers: { 'User-Agent': 'Moz' }, seconds: 8520 });
    assert.equal(await ML.directAudio('yt-dlp', 'x', { spawnFn: fake(JSON.stringify({ url: 'https://a/b', protocol: 'http_dash_segments' })) }), null, 'pieces ffmpeg can\'t open: stream through yt-dlp instead');
    assert.equal(await ML.directAudio('yt-dlp', 'x', { spawnFn: fake('', 1) }), null);
  });

  await test('automod: scam and phishing links are caught (look-alike Discord/Steam sites, free-Nitro bait); real Discord, Steam and ordinary links are not; on by default with delete + timeout', async () => {
    const A = await import('../src/automod.js');
    for (const t of ['@everyone free nitro https://dlscord-gift.com/claim', 'https://discord-nitro.gift/x', 'https://steamcommunlty.com/tradeoffer/new', 'https://steancommunity.ru/id/a', 'https://disc0rd.app/login', 'https://discordapp.co/gifts/a', 'Claim your free gift here https://bit.ly/abc', 'https://dicsord.com/nitro', 'https://steampowered-help.com'])
      assert.ok(A.scamReason(t), `caught: ${t}`);
    for (const t of ['https://discord.com/channels/1/2', 'https://discord.gg/abc', 'https://cdn.discordapp.com/attachments/x.png', 'https://store.steampowered.com/app/730', 'https://steamcommunity.com/id/me', 'https://youtube.com/watch?v=x', 'https://www.recorder.com', 'https://discourse.org', 'nitro is cool, see https://example.com', 'https://github.com/discord/discord-api-docs', 'free nitro please'])
      assert.equal(A.scamReason(t), null, `left alone: ${t}`);
    assert.equal(A.RULES[0].id, 'scams');
    const w = await makeWorld(['moderation']).load();
    const g = w.mm.ctx('1', 'moderation');
    assert.equal(g.config.get('automodScams'), true, 'on by default');
    assert.equal(g.config.get('scamsAction'), 'delete-timeout');
    const M = await import('../modules/moderation/index.js');
    const r = M.testMessage(g, 'gift for you https://dlscord.gift/abc').find((x) => x.id === 'scams');
    assert.ok(r.hit && /fake site pretending to be Discord/.test(r.why));
  });

  await test('warnings escalate: timeout every N, kick and ban at set counts (off by default); works for dashboard warnings too', async () => {
    const M = await import('../modules/moderation/index.js');
    assert.equal(M.warnStep(3, { timeoutEvery: 3 }), 'timeout'); assert.equal(M.warnStep(4, { timeoutEvery: 3 }), null);
    assert.equal(M.warnStep(5, { timeoutEvery: 3, kickAt: 5, banAt: 7 }), 'kick'); assert.equal(M.warnStep(6, { timeoutEvery: 3, kickAt: 5, banAt: 7 }), 'kick', 'came back and kept going: kicked again');
    assert.equal(M.warnStep(7, { timeoutEvery: 3, kickAt: 5, banAt: 7 }), 'ban'); assert.equal(M.warnStep(9, { kickAt: 0, banAt: 0 }), null);
    const { PermissionFlagsBits: P } = await import('discord.js');
    const w = await makeWorld(['moderation']).load();
    const MOD = '320000000000000001', TGT = '320000000000000002';
    w.person(MOD, { bits: [P.Administrator], pos: 10, username: 'moddy' });
    const t = w.person(TGT, { pos: 1, username: 'target' });
    t.timeout = async () => {}; t.moderatable = true; t.kickable = true; t.bannable = true; let kicked = 0; t.kick = async () => { kicked++; };
    const bans = []; w.g.members.ban = async (id) => { bans.push(id); };
    assert.equal(w.mm.ctx('1', 'moderation').config.get('warnKickAt'), 0, 'off by default');
    w.mm.setSetting('1', 'moderation', 'warnTimeoutThreshold', 0); w.mm.setSetting('1', 'moderation', 'warnKickAt', 2); w.mm.setSetting('1', 'moderation', 'warnBanAt', 3);
    const act = (body) => w.mm.runAction('1', 'moderation', 'member-action', body, { userId: MOD, username: MOD });
    await act({ userId: TGT, action: 'warn', reason: 'one' }); assert.equal(kicked, 0);
    await act({ userId: TGT, action: 'warn', reason: 'two' }); assert.equal(kicked, 1, 'kicked at 2 warnings');
    await act({ userId: TGT, action: 'warn', reason: 'three' }); assert.deepEqual(bans, [TGT], 'banned at 3');
    const { rows } = await w.mm.runView('1', 'moderation', 'cases');
    assert.ok(rows.some((r) => r.type === 'Kicked') && rows.some((r) => r.type === 'Banned'), 'both in the history');
  });

  await test('XP boosts: best role boost times the channel (or category) boost; /xp boost add, list, remove', async () => {
    const C = await import('../modules/community/index.js');
    const B = [{ kind: 'role', id: 'booster', mult: 1.5 }, { kind: 'role', id: 'vip', mult: 2 }, { kind: 'channel', id: 'cat', mult: 3 }, { kind: 'channel', id: 'general', mult: 0.5 }];
    assert.equal(C.xpBoost(B, { roleIds: ['booster', 'vip'] }), 2, 'the best role, not both');
    assert.equal(C.xpBoost(B, { roleIds: ['booster'], channelIds: ['general', 'cat'] }), 0.75, 'the channel\'s own boost beats its category');
    assert.equal(C.xpBoost(B, { roleIds: ['booster'], channelIds: ['other', 'cat'] }), 4.5, 'the category\'s boost for its other channels');
    assert.equal(C.xpBoost([], { roleIds: ['x'] }), 1); assert.equal(C.xpBoost(undefined, {}), 1);
    const { PermissionFlagsBits: P } = await import('discord.js');
    const w = await makeWorld(['community']).load();
    const admin = w.person('330000000000000001', { bits: [P.Administrator], pos: 10 });
    const room = w.channel('chat');
    const g = w.mm.ctx('1', 'community');
    const run = async (sub, opts) => { const i = w.ix({ command: 'xp', member: admin, channel: room }); i.options.getSubcommandGroup = () => 'boost'; i.options.getSubcommand = () => sub;
      i.options.getChannel = (n) => (n === 'channel' ? opts.channel ?? null : null); i.options.getRole = () => opts.role ?? null; i.options.getNumber = () => opts.mult; await w.mm.handleCommand(i); return i; };
    await run('add', { channel: room, mult: 2 });
    assert.deepEqual(g.data.get('xpBoosts'), [{ kind: 'channel', id: room.id, mult: 2 }]);
    const bad = await run('add', { channel: room, mult: 9 }); assert.match(JSON.stringify(bad.replies), /0\.1 to 5/);
    const list = await run('list', {}); assert.match(list.replies[0].content, /×2/);
    await run('remove', { channel: room }); assert.deepEqual(g.data.get('xpBoosts'), []);
  });

  await test('custom commands: {random}, {number}, {if}, {arg1}..{arg9}, {uses}; blocks inside blocks; what members type is never run as code', async () => {
    const T = await import('../src/tagscript.js');
    const fixed = (n) => () => n;
    const v = { username: 'Bo', ...T.argVars('yes please') };
    assert.equal(T.runTagScript('{random: a | b | c}', v, fixed(0.5)), 'b');
    assert.equal(T.runTagScript('{number: 1-6}', v, fixed(0.999)), '6'); assert.equal(T.runTagScript('{number: 1-6}', v, fixed(0)), '1');
    assert.equal(T.runTagScript('{if: {arg1} = yes | Great {username}! | Oh no}', v), 'Great Bo!');
    assert.equal(T.runTagScript('{if: {arg1} != yes | A | B}', v), 'B');
    assert.equal(T.runTagScript('{if: {args} contains PLEASE | polite | rude}', v), 'polite');
    assert.equal(T.runTagScript('{if: {arg3} | has three | {random: x | y}}', v, fixed(0.9)), 'y', 'blocks inside blocks');
    assert.equal(T.runTagScript('{argcount} words: {arg2}', v), '2 words: please');
    assert.equal(T.runTagScript('{nope} and {', v), '{nope} and {', 'anything unknown is left as written');
    const evil = { ...T.argVars('{random: hacked | hacked} | {if: x | y | z}') };
    assert.equal(T.runTagScript('You said: {args}', evil), 'You said: {random: hacked | hacked} | {if: x | y | z}', 'typed blocks stay plain text');
    assert.equal(T.runTagScript('{if: {arg1} = x | A | B}', T.argVars('x|y')), 'B', 'a typed bar cannot split an if');
    const C = await import('../modules/tags/index.js');
    const out = C.render({ response: 'Hi {username}, you rolled {number: 1-6} ({uses}x)', title: null }, { username: 'Bo', uses: 3, ...T.argVars('') }, fixed(0));
    assert.equal(out.content, 'Hi Bo, you rolled 1 (3x)'); assert.deepEqual(out.allowedMentions, { parse: [] });
  });

  await test('role menus: most roles at once, a role needed to use it, and temporary roles that are taken away when their time is up', async () => {
    const R = await import('../modules/roles/index.js');
    const menu = { roleIds: ['a', 'b', 'c'], mode: 'toggle', max: 2, needs: null };
    assert.equal(R.limitProblem(menu, { roleIds: ['a'], wanted: new Set(['a', 'b']) }), null);
    assert.match(R.limitProblem(menu, { roleIds: ['a', 'b'], wanted: new Set(['a', 'b', 'c']) }), /up to 2 roles/);
    assert.equal(R.limitProblem(menu, { roleIds: ['a', 'b', 'c'], wanted: new Set(['a', 'b']) }), null, 'taking one off is always fine (even if over the limit)');
    assert.match(R.limitProblem({ ...menu, needs: 'lvl10' }, { roleIds: ['a'], wanted: new Set(['a']) }), /need the <@&lvl10> role/);
    assert.equal(R.limitProblem({ ...menu, needs: 'lvl10' }, { roleIds: ['lvl10'], wanted: new Set(['a']) }), null);
    const w = await makeWorld(['roles']).load();
    const r1 = w.role('940000000000000001'); r1.name = 'Event';
    const guild = w.person('940000000000000009').guild;
    const msg = R.buildMenu(guild, { roleIds: [r1.id], title: 'T', mode: 'toggle', type: 'dropdown', max: 1, hours: 24, needs: '940000000000000002' });
    assert.match(msg.embeds[0].data.footer.text, /up to 1.*last 24 hours/);
    assert.match(msg.embeds[0].data.description, /Only for members with/);
    assert.equal(msg.components[0].components[0].data.max_values, 1);
    // Temporary roles: a past time is taken off, a future one stays.
    const g = w.mm.ctx('1', 'roles');
    const m = w.person('940000000000000010'); m.roles.cache.set(r1.id, r1);
    const removed = []; m.roles.remove = async (id) => { removed.push(id); m.roles.cache.delete(id); };
    g.data.set(`temp:${m.id}:${r1.id}`, Date.now() - 1000);
    g.data.set(`temp:${m.id}:940000000000000003`, Date.now() + 3600000);
    assert.equal(await R.expireTempRoles(g), 1);
    assert.deepEqual(removed, [r1.id]);
    assert.equal(g.data.get(`temp:${m.id}:${r1.id}`), undefined); assert.ok(g.data.get(`temp:${m.id}:940000000000000003`), 'the one not yet due stays');
  });

  await test('rods (3.1): every rod has a perk and home places; stars and home places make it stronger; perks change the fight; endgame rods reach level 4000', async () => {
    const F = await import('../src/fishing.js');
    assert.ok(F.RODS.every((r) => F.PERKS[r.perk]), 'every rod has a perk');
    assert.deepEqual(F.RODS.filter((r) => !r.earn).slice(-4).map((r) => r.level), [2800, 3200, 3600, 4000]);
    assert.equal(F.rodById('leviathan').perk, 'mythic');
    const plain = F.rodStats('cinderspine'), home = F.rodStats('cinderspine', { biome: 'vents' }), five = F.rodStats('cinderspine', { stars: 5 });
    assert.ok(home.home && home.luck > plain.luck && home.power > plain.power && home.line > plain.line, 'stronger at home');
    assert.ok(five.power > plain.power && five.control === plain.control + 2 && five.luck > plain.luck, 'stars add power, luck and 2 zone');
    assert.ok(F.rodStats('leviathan', { biome: 'bay' }).home && F.rodStats('grandangler', { biome: 'eclipse' }).home, 'mythic and wanderer: home everywhere');
    assert.deepEqual(F.upgradeCost('cinderspine', 1), { coins: 22500, rarity: 'common', fish: 15 }); assert.equal(F.upgradeCost('cinderspine', 5), null);
    // Heatproof: never snaps at home, snaps elsewhere.
    const fight = (rod, biome) => { const s = F.startReel({ rod, tackle: 'none', fish: { rarity: 'mythical' }, seed: 3, now: 0, biteMs: 0, surges: false, biome }); s.struck = false; s.tension = 10000; F.reelStep(s, 'slack', 10); return s.status; };
    assert.equal(fight('cinderspine', 'bay'), 'snapped');
    assert.notEqual(fight('cinderspine', 'vents'), 'snapped', 'Heatproof at home');
    // Quick bite: the fish bites much sooner.
    const wait = (rod) => { const s = F.startReel({ rod, tackle: 'none', fish: { rarity: 'common' }, seed: 9, now: 0 }); return s.biteAt; };
    assert.ok(wait('quicksilver') < wait('mainspring') * 0.5);
    // Tamer: legendary fish pull less (less tension per bad reel).
    const tension = (rod) => { const s = F.startReel({ rod, tackle: 'none', fish: { rarity: 'legendary' }, seed: 4, now: 0, biteMs: 0, surges: false }); s.struck = false; s.pos = 0; s.zone = 12; F.reelStep(s, 'reel', 10); return s.tension; };
    assert.ok(tension('wyrmspine') < tension('quicksilver'));
    // Earned rods: what's due.
    assert.deepEqual(F.challengeRodsDue({ streak: 7, weeklies: 10, owned: [] }).map((r) => r.id).sort(), ['streakline', 'taskmaster']);
    assert.deepEqual(F.challengeRodsDue({ streak: 30, owned: ['streakline'] }).map((r) => r.id), ['grandangler']);
    assert.equal(F.nextSunken([]).id, 'barnacle'); assert.equal(F.nextSunken(['barnacle']).id, 'captain'); assert.equal(F.nextSunken(['barnacle', 'captain', 'drownedking']), null);
    assert.equal(F.RODS.filter((r) => r.earn?.kind === 'collection').length, F.BIOMES.length, 'a Keepsake rod for every place');
  });

  await test('rods in the game: the Rods page, upgrading to ★2 with coins and common fish (never mutated ones), a Keepsake rod for completing a place, a sunken rod in Ironwreck Graveyard', async () => {
    globalThis[Symbol.for('goodboy.games.frameMs')] = 0; globalThis[Symbol.for('goodboy.games.biteMs')] = 0; globalThis[Symbol.for('goodboy.games.surges')] = false;
    const F = await import('../src/fishing.js');
    const w = await makeWorld(['economy', 'games']).load();
    const room = w.channel('games'); const alice = w.person('alice');
    w.mm.setSetting('1', 'games', 'gamePictures', false); w.mm.setSetting('1', 'games', 'fishChallenges', false);
    const g = w.mm.ctx('1', 'games');
    const press = async (customId, values) => { const i = w.ix({ customId, member: alice, channel: room }); if (values) { i.values = values; i.isStringSelectMenu = () => true; } await w.mm.handleComponent(i); return i; };
    const hub = await press('gm:fh:alice:hub').catch(() => null);
    await press('gm:fh:alice:again'); // makes the profile
    g.sql.run("DELETE FROM games_sessions WHERE user_id = 'alice'");
    const rods = await press('gm:fh:alice:rods');
    assert.match(JSON.stringify(rods.updated), /Driftwood Rod/);
    // Upgrade: needs coins and 15 common fish.
    const eco = w.mm.moduleApi('1', 'economy'); eco.wallet('1', 'alice'); w.mm.ctx('1', 'economy').sql.run("UPDATE economy_wallets SET coins = 100000 WHERE user_id = 'alice'");
    const add = (rarity, mutation = null, n = 1) => { for (let k = 0; k < n; k++) g.sql.run("INSERT INTO games_fish_bag (guild_id, user_id, species, rarity, mutation, weight, value, biome, caught_at) VALUES ('1', 'alice', 'bay-0', ?, ?, 1, 5, 'bay', 0)", rarity, mutation); };
    add('common', null, 14); add('common', 'mutated', 5);
    assert.match(JSON.stringify((await press('gm:fh:alice:up-driftwood')).replies), /need 15 Common fish/);
    add('common', null, 1);
    await press('gm:fh:alice:up-driftwood');
    const prof = g.sql.get("SELECT rod_stars FROM games_fish_profile WHERE user_id = 'alice'");
    assert.deepEqual(JSON.parse(prof.rod_stars), { driftwood: 2 });
    assert.equal(g.sql.get("SELECT COUNT(*) AS n FROM games_fish_bag WHERE user_id = 'alice' AND sold = 0 AND mutation IS NOT NULL").n, 5, 'mutated fish kept');
    assert.equal(g.sql.get("SELECT COUNT(*) AS n FROM games_fish_bag WHERE user_id = 'alice' AND sold = 0 AND mutation IS NULL").n, 0);
    // The next cast uses the stars.
    await press('gm:fh:alice:again');
    const sess = JSON.parse(g.sql.get("SELECT state FROM games_sessions WHERE user_id = 'alice'").state);
    assert.equal(sess.gear.stars, 2);
    g.sql.run("DELETE FROM games_sessions WHERE user_id = 'alice'");
    // Keepsake: every bay fish but one in the collection, then catch the last.
    const bay = F.fishIn('bay');
    for (const f of bay.slice(1)) g.sql.run("INSERT INTO games_fish_dex (guild_id, user_id, species, count, best_weight, first_at) VALUES ('1', 'alice', ?, 1, 1, 0)", f.id);
    const M = await import('../modules/games/index.js');
    void M;
    // Land the missing fish by playing a cast whose fish is forced.
    const castState = (species, biome = 'bay') => { const s = F.startReel({ rod: 'driftwood', tackle: 'none', fish: { species, rarity: F.FISH[species].rarity, weight: 1, giant: false, mutation: null, value: 5 }, seed: 1, now: Date.now(), biteMs: 0, surges: false, biome }); s.biome = biome; s.bait = 'none'; s.progress = 99; s.struck = true; s.zone = 0; s.gear = { ...s.gear, control: F.TRACK, power: 50 }; return s; };
    const play = async (s) => { g.sql.run("INSERT INTO games_sessions (id, guild_id, user_id, kind, state, created_at, updated_at) VALUES ('t1', '1', 'alice', 'fish', ?, ?, ?)", JSON.stringify(s), Date.now(), Date.now()); const i = await press('gm:fr:t1:reel'); g.sql.run("DELETE FROM games_sessions WHERE id = 't1'"); return JSON.stringify([i.updated, i.replies]); };
    const out = await play(castState(bay[0].id));
    assert.match(out, /New rod: Lantern Bay Keepsake Rod/);
    assert.ok(JSON.parse(g.sql.get("SELECT rods FROM games_fish_profile WHERE user_id = 'alice'").rods).includes('keep-bay'));
    // Sunken rod: force the roll.
    globalThis[Symbol.for('goodboy.games.sunkenRoll')] = () => 0;
    try {
      const wreckFish = F.fishIn('wreck')[0];
      const out2 = await play(castState(wreckFish.id, 'wreck'));
      assert.match(out2, /old rod/); assert.match(out2, /Barnacled Rod/);
    } finally { delete globalThis[Symbol.for('goodboy.games.sunkenRoll')]; }
    void hub;
  });

  await test('arcade games (rules): tower, wires, bingo, memory, hangman and trivia play by their rules; payouts stay under fair odds for the luck games', async () => {
    const MG = await import('../src/minigames.js');
    const seq = (...v) => { let k = 0; return () => v[k++ % v.length]; };
    // Tower: traps from the roll; a safe door climbs, the trap ends it.
    const t = MG.towerStart(() => 0); // every trap behind door 0
    MG.towerPick(t, 1); MG.towerPick(t, 2); assert.equal(t.floor, 2); assert.equal(t.status, 'climbing');
    MG.towerPick(t, 0); assert.equal(t.status, 'trapped');
    assert.ok(MG.towerMultiplier(1) < 1.5 && MG.towerMultiplier(8) > 15, 'under the fair 1.5x per floor');
    // Wires: 4 safe cuts clears it.
    const w = MG.wiresStart(() => 0.99); assert.equal(w.bomb, 4);
    for (const k of [0, 1, 2]) MG.wiresCut(w, k); assert.equal(w.status, 'cutting'); MG.wiresCut(w, 3); assert.equal(w.status, 'cleared');
    const w2 = MG.wiresStart(() => 0); MG.wiresCut(w2, 0); assert.equal(w2.status, 'boom');
    for (let c = 1; c <= 4; c++) assert.ok(MG.wiresMultiplier(c) < 5 / (5 - c), 'under fair odds');
    // Bingo: card and draws differ; a line ends it.
    const b = MG.bingoStart(Math.random);
    assert.equal(new Set(b.card).size, 9); assert.equal(b.order.length, 10);
    b.order = [...b.card.slice(0, 3), ...b.order.filter((n) => !b.card.slice(0, 3).includes(n))].slice(0, 10);
    MG.bingoDraw(b); MG.bingoDraw(b); assert.equal(b.status, 'drawing'); MG.bingoDraw(b); assert.equal(b.status, 'bingo');
    assert.equal(MG.bingoMultiplier(3), 4); assert.equal(MG.bingoMultiplier(7), 2); assert.equal(MG.bingoMultiplier(10), 1.1); assert.equal(MG.bingoMultiplier(0), 0);
    // Memory: pairs, mistakes.
    const m = MG.memoryStart(() => 0.5);
    const first = m.cards[0], pair = m.cards.indexOf(first, 1), other = m.cards.findIndex((c) => c !== first);
    MG.memoryFlip(m, 0); MG.memoryFlip(m, other); assert.equal(m.mistakes, 1);
    MG.memoryFlip(m, 0); MG.memoryFlip(m, pair); assert.deepEqual(m.found.sort(), [0, pair].sort());
    assert.equal(MG.memoryMultiplier(5), 2); assert.equal(MG.memoryMultiplier(15), 0);
    // Hangman.
    const h = MG.hangmanStart(() => 0); assert.equal(h.word, 'puppy');
    assert.match(MG.hangmanGuess(h, 'p').note, /some P/); assert.equal(MG.hangmanShown(h), 'P _ P P _');
    assert.match(MG.hangmanGuess(h, 'p').note, /already/); assert.match(MG.hangmanGuess(h, 'z').note, /No Z/); assert.equal(h.wrong, 1);
    MG.hangmanGuess(h, 'kitten'); assert.equal(h.wrong, 3, 'a wrong word costs 2');
    MG.hangmanGuess(h, 'puppy'); assert.equal(h.status, 'won');
    assert.match(MG.hangmanGuess(MG.hangmanStart(() => 0), '7').note, /letters only/);
    // Trivia: the right answer is tracked through the shuffle.
    for (let k = 0; k < 20; k++) { const q = MG.triviaPick('anime', Math.random); const row = MG.TRIVIA.anime.find((r) => r[0] === q.q); assert.equal(q.answers[q.right], row[1]); assert.equal(q.answers.length, 4); }
    assert.ok(Object.values(MG.TRIVIA).every((list) => list.every((r) => r.length === 5 && new Set(r.slice(1)).size === 4)), 'every question has 4 different answers');
    // /fun helpers.
    assert.equal(MG.shipPercent('1', '2'), MG.shipPercent('2', '1'), 'same both ways'); assert.ok(MG.shipPercent('a', 'b') <= 100);
    assert.deepEqual(MG.rollDice(3, 6, seq(0, 0.5, 0.99)), [1, 4, 6]);
  });

  await test('arcade games (in Discord): the arcade shows them; a Tower game takes the bet, a cash-out pays it back with the multiplier; a trapped game pays nothing; stats are recorded', async () => {
    const w = await makeWorld(['economy', 'games']).load();
    const room = w.channel('games'); const bob = w.person('bob');
    const eco = w.mm.moduleApi('1', 'economy'); eco.wallet('1', 'bob'); w.mm.ctx('1', 'economy').sql.run("UPDATE economy_wallets SET coins = 1000 WHERE user_id = 'bob'");
    const coins = () => w.mm.ctx('1', 'economy').sql.get("SELECT coins FROM economy_wallets WHERE user_id = 'bob'").coins;
    const g = w.mm.ctx('1', 'games');
    const press = async (customId, fields) => { const i = w.ix({ customId, member: bob, channel: room }); if (fields) { i.isModalSubmit = () => true; i.fields = { getTextInputValue: (k) => fields[k] ?? '', getStringSelectValues: (k) => [].concat(fields[k] ?? []) }; } await w.mm.handleComponent(i); return i; };
    const panel = await press('gm:ar:tower');
    assert.ok(panel.modal || panel.replies.length, 'the Tower button opens the bet form');
    globalThis[Symbol.for('goodboy.games.rand')] = () => 0; // every trap behind door 1
    try {
      const M = await import('../modules/games/index.js'); void M;
      const form = panel.modal ? panel : null;
      const id = form ? form.modal.data.custom_id : null;
      let started;
      if (id) started = await press(id, { bet: '100' });
      else { const open = await press(JSON.stringify(panel.replies).match(/mpg[^"]+/)[0]); started = await press(open.modal.data.custom_id, { bet: '100' }); }
      assert.equal(coins(), 900, 'the bet is taken');
      const sess = g.sql.get("SELECT id FROM games_sessions WHERE user_id = 'bob' AND kind = 'tower'");
      assert.ok(sess, 'a Tower game is saved');
      await press(`gm:mg:${sess.id}:d1`); await press(`gm:mg:${sess.id}:d2`);
      const cash = await press(`gm:mg:${sess.id}:cash`);
      assert.equal(coins(), 900 + Math.floor(100 * 1.45 ** 2), 'cash out after 2 floors pays 2.1x');
      assert.match(JSON.stringify(cash.updated), /You took/);
      assert.ok(!g.sql.get("SELECT 1 FROM games_sessions WHERE id = ?", sess.id), 'the game is over');
      const st = g.sql.get("SELECT * FROM games_stats WHERE user_id = 'bob' AND game = 'tower'");
      assert.equal(st.played, 1); assert.equal(st.won, 1);
    } finally { delete globalThis[Symbol.for('goodboy.games.rand')]; }
  });

  await test('/fun: 8-ball answers, dice add up, ship is the same both ways, topic gives a question', async () => {
    const w = await makeWorld(['fun']).load();
    const room = w.channel('chat'); const a = w.person('950000000000000001'); const b = w.person('950000000000000002');
    const run = async (sub, opts = {}) => { const i = w.ix({ command: 'fun', sub, member: a, channel: room, opts }); await w.mm.handleCommand(i); return JSON.stringify(i.replies); };
    assert.match(await run('8ball', { question: 'Will it rain?' }), /The 8-ball says/);
    assert.match(await run('dice', { count: 2, sides: 6 }), /2d6: \*\*\d\*\* \+ \*\*\d\*\* = \*\*\d+\*\*/);
    const s1 = await run('ship', { a: b.user, b: a.user }), s2 = await run('ship', { a: a.user, b: b.user });
    assert.equal(s1.match(/(\d+)%/)[1], s2.match(/(\d+)%/)[1]);
    assert.match(await run('topic'), /Topic:/);
  });

  await test('shop: roles (for good or for hours), items with a message (used up if consumable), stock, the Streak Shield; /work has a cooldown; the bank pays capped daily interest', async () => {
    const SHOP = await import('../modules/economy/shop.js');
    const w = await makeWorld(['economy']).load();
    const room = w.channel('shop'); const m = w.person('960000000000000001'); const admin = w.person('960000000000000009', { bits: [(await import('discord.js')).PermissionFlagsBits.Administrator], pos: 10 });
    void admin;
    const g = w.mm.ctx('1', 'economy');
    const api = w.mm.moduleApi('1', 'economy'); api.wallet('1', m.id);
    const setCoins = (n) => g.sql.run('UPDATE economy_wallets SET coins = ? WHERE user_id = ?', n, m.id);
    const coins = () => g.sql.get('SELECT coins FROM economy_wallets WHERE user_id = ?', m.id).coins;
    const vip = w.role('960000000000000100'); vip.name = 'VIP';
    const added = []; m.roles.add = async (id) => { added.push(id); m.roles.cache.set(id, { id }); };
    const removed = []; m.roles.remove = async (id) => { removed.push(id); m.roles.cache.delete(id); };
    const H = { wallet: (u) => api.wallet('1', u), debit: (u, n, r) => api.debit('1', u, n, r), credit: (u, n, r) => api.credit('1', u, n, r), move: (u, n) => g.sql.run('UPDATE economy_wallets SET coins = coins + ? WHERE user_id = ?', n, u), member: m };
    SHOP.addItem(g, { name: 'VIP', price: 1000, roleId: vip.id, hours: 24 });
    SHOP.addItem(g, { name: 'Golden Bone', price: 300, emoji: '🦴', message: '{user} chews the golden bone happily', consumable: true, stock: 1 });
    assert.equal(SHOP.shopItems(g).length, 2);
    setCoins(500);
    await assert.rejects(SHOP.buy(g, m.id, 'vip', H), /only have/, 'not enough coins');
    setCoins(5000);
    const r1 = await SHOP.buy(g, m.id, 'vip', H);
    assert.deepEqual(added, [vip.id]); assert.match(r1.text, /until/); assert.equal(coins(), 4000);
    const until = g.data.get(`shoprole:${m.id}:${vip.id}`); assert.ok(until > Date.now() + 23 * 3600000);
    await SHOP.buy(g, m.id, 'golden-bone', H);
    await assert.rejects(SHOP.buy(g, m.id, 'golden-bone', H), /sold out/, 'stock of 1');
    assert.deepEqual(SHOP.inventory(g, m.id).map((x) => [x.id, x.qty]), [['golden-bone', 1]]);
    assert.match(SHOP.useItem(g, m.id, 'golden-bone').text, new RegExp(`<@${m.id}> chews the golden bone`));
    assert.deepEqual(SHOP.inventory(g, m.id), [], 'used up');
    assert.throws(() => SHOP.useItem(g, m.id, 'golden-bone'), /don't have/);
    // Shield.
    const before = api.wallet('1', m.id).shields;
    await SHOP.buy(g, m.id, 'shield', H); assert.equal(api.wallet('1', m.id).shields, before + 1);
    // Temporary role runs out.
    g.data.set(`shoprole:${m.id}:${vip.id}`, Date.now() - 1);
    assert.equal(await SHOP.expireShopRoles(g), 1); assert.deepEqual(removed, [vip.id]);
    // Work: pays within the range, then waits.
    const t0 = Date.now();
    const wk = SHOP.work(g, m.id, H, t0, () => 0.5); assert.ok(wk.ok && wk.coins >= 50 && wk.coins <= 200);
    assert.equal(SHOP.work(g, m.id, H, t0 + 60000).ok, false, 'cooldown');
    assert.ok(SHOP.work(g, m.id, H, t0 + 61 * 60000).ok, 'after an hour');
    // Bank: interest per full day, compounded, capped.
    assert.deepEqual(SHOP.interestDue(10000, 0, 5, 1, 1000), { coins: 0, days: 0 }, 'never deposited: nothing');
    assert.deepEqual(SHOP.interestDue(10000, 1, 1 + 2 * 86400000, 1, 0), { coins: 100 + 101, days: 2 });
    assert.equal(SHOP.interestDue(1e9, 1, 1 + 3 * 86400000, 1, 1000).coins, 3000, 'capped per day');
    setCoins(2000);
    SHOP.deposit(g, m.id, 1500, H);
    assert.equal(coins(), 500); assert.equal(api.wallet('1', m.id).bank, 1500);
    assert.throws(() => SHOP.withdraw(g, m.id, 5000, H), /only have/);
    SHOP.withdraw(g, m.id, 1000, H); assert.equal(coins(), 1500); assert.equal(api.wallet('1', m.id).bank, 500);
    // The commands answer.
    const run = async (command) => { const i = w.ix({ command, member: m, channel: room }); await w.mm.handleCommand(i); return JSON.stringify(i.replies); };
    assert.match(await run('shop'), /Streak Shield/); assert.match(await run('bank'), /Bank/);
  });

  await test('critters (rules): 52 of Good Boy\'s own critters; wild rolls; levels; element advantage matters but upsets happen; hints', async () => {
    const CR = await import('../src/critters.js');
    assert.equal(CR.ALL.length, 52); assert.equal(new Set(CR.ALL.map((s) => s.name)).size, 52, 'all names different');
    assert.equal(CR.ALL.filter((s) => s.rarity === 'legendary').length, 4);
    const w = CR.rollWild(() => 0); assert.equal(CR.speciesById(w.species).rarity, 'common'); assert.deepEqual(w.iv, { hp: 0, atk: 0, def: 0, spd: 0 }); assert.equal(w.sparkly, true, 'a roll of 0 is sparkly');
    assert.equal(CR.quality({ hp: 31, atk: 31, def: 31, spd: 31 }), 100);
    assert.deepEqual(CR.addXp(1, 0, CR.xpToNext(1) + CR.xpToNext(2)), { level: 3, xp: 0, ups: 2 });
    assert.equal(CR.addXp(99, 0, 1e9).level, 100);
    assert.equal(CR.advantage('water', 'fire'), 1.2); assert.equal(CR.advantage('fire', 'water'), 0.83); assert.equal(CR.advantage('fire', 'sky'), 1);
    const L = (sp, level) => ({ species: sp, level, iv: { hp: 15, atk: 15, def: 15, spd: 15 } });
    let up = 0; for (let k = 0; k < 400; k++) up += CR.battle(L('emberpup', 20), L('puddlepaw', 20)).winner === 0 ? 1 : 0;
    assert.ok(up > 20 && up < 200, `the underdog sometimes wins (${up}/400)`);
    let hi = 0; for (let k = 0; k < 200; k++) hi += CR.battle(L('emberpup', 40), L('puddlepaw', 15)).winner === 0 ? 1 : 0;
    assert.ok(hi > 180, 'a much higher level nearly always wins');
    assert.equal(CR.hint('Emberpup', 1), 'E _ _ _ _ _ _ _');
    assert.ok(CR.nameMatches('  emberPUP ', 'Emberpup')); assert.ok(!CR.nameMatches('ember', 'Emberpup'));
  });

  await test('critters in Discord: a spawn after enough messages; a wrong name fails, the right one catches it and makes it your buddy; buddy XP; trade both ways; battle; release pays coins', async () => {
    const C = await import('../modules/critters/index.js');
    const CR = await import('../src/critters.js');
    const w = await makeWorld(['economy', 'critters']).load();
    const room = w.channel('general'); const a = w.person('970000000000000001'); const b = w.person('970000000000000002');
    const g = w.mm.ctx('1', 'critters');
    globalThis[Symbol.for('goodboy.critters.rand')] = () => 0.5;
    try {
      w.mm.setSetting('1', 'critters', 'spawnEvery', 5);
      for (let k = 0; k < 6; k++) await w.mm.dispatch('messageCreate', '1', { guildId: '1', channelId: room.id, channel: room, author: a.user, member: a, content: 'hi' });
      const spawned = globalThis[Symbol.for('goodboy.critters.spawns')].get('1');
      assert.ok(spawned, 'a critter appeared after enough messages');
      assert.match(JSON.stringify(room.sent.at(-1)), /crit:catch/);
      const name = CR.speciesById(spawned.species).name;
      const press = async (member, customId, typed) => { const i = w.ix({ customId, member, channel: room }); if (typed != null) { i.isModalSubmit = () => true; i.fields = { getTextInputValue: () => typed }; } await w.mm.handleComponent(i); return i; };
      assert.ok((await press(b, `crit:catch:${spawned.id}`)).modal, 'Catch asks for the name');
      assert.match(JSON.stringify((await press(b, `crit:name:${spawned.id}`, 'wrongname')).replies), /not its name/);
      const got = await press(a, `crit:name:${spawned.id}`, name.toLowerCase());
      assert.match(JSON.stringify(got.replies), /caught/);
      assert.match(JSON.stringify((await press(b, `crit:name:${spawned.id}`, name)).replies), /Too late/, 'only the first');
      const mineA = g.sql.get('SELECT * FROM critters_owned WHERE user_id = ?', a.id);
      assert.equal(g.sql.get('SELECT buddy_id FROM critters_profile WHERE user_id = ?', a.id).buddy_id, mineA.id, 'the first catch becomes your buddy');
      // Buddy XP from chatting.
      await w.mm.dispatch('messageCreate', '1', { guildId: '1', channelId: room.id, channel: room, author: a.user, member: a, content: 'hello' });
      const after = g.sql.get('SELECT level, xp FROM critters_owned WHERE id = ?', mineA.id);
      assert.ok(after.xp > mineA.xp || after.level > mineA.level, 'the buddy gained XP');
      // B catches one too (forced), then they trade.
      await C.spawn(g, room, { species: 'bubblet', iv: { hp: 1, atk: 1, def: 1, spd: 1 }, sparkly: false });
      const s2 = globalThis[Symbol.for('goodboy.critters.spawns')].get('1');
      await press(b, `crit:name:${s2.id}`, 'Bubblet');
      const mineB = g.sql.get('SELECT * FROM critters_owned WHERE user_id = ?', b.id);
      const cmd = async (member, sub, opts) => { const i = w.ix({ command: 'critters', sub, member, channel: room, opts }); await w.mm.handleCommand(i); return i; };
      const offer = await cmd(a, 'trade', { member: b.user, give: mineA.id, get: mineB.id });
      const tok = JSON.stringify(offer.replies).match(/crit:trade:([0-9a-f]+):yes/)[1];
      assert.match(JSON.stringify((await press(a, `crit:trade:${tok}:yes`)).replies), /someone else/, 'only the other person can accept');
      await press(b, `crit:trade:${tok}:yes`);
      assert.equal(g.sql.get('SELECT user_id FROM critters_owned WHERE id = ?', mineA.id).user_id, b.id);
      assert.equal(g.sql.get('SELECT user_id FROM critters_owned WHERE id = ?', mineB.id).user_id, a.id);
      // Battle: both pick buddies.
      await cmd(a, 'buddy', { id: mineB.id }); await cmd(b, 'buddy', { id: mineA.id });
      const fight = await cmd(a, 'battle', { member: b.user });
      const btok = JSON.stringify(fight.replies).match(/crit:battle:([0-9a-f]+):yes/)[1];
      const res = await press(b, `crit:battle:${btok}:yes`);
      assert.match(JSON.stringify(res.updated), /wins!/);
      // Release for coins.
      const eco = w.mm.moduleApi('1', 'economy'); const before = eco.wallet('1', a.id).coins;
      await press(a, `crit:release:${a.id}:${mineB.id}`);
      assert.equal(g.sql.get('SELECT 1 FROM critters_owned WHERE id = ?', mineB.id), undefined);
      assert.ok(eco.wallet('1', a.id).coins > before, 'paid in coins');
      assert.ok(C.releaseValue({ species: 'solarion', level: 1, sparkly: 1 }) > C.releaseValue({ species: 'emberpup', level: 1, sparkly: 0 }) * 100);
    } finally { delete globalThis[Symbol.for('goodboy.critters.rand')]; globalThis[Symbol.for('goodboy.critters.spawns')].delete('1'); }
  });

  await test('dashboard pages for 3.1: shop items (add, price, stock, remove), XP boosts (add, change, remove), role menu limits, critter spawns, ticket ratings', async () => {
    const w = await makeWorld(['economy', 'community', 'roles', 'critters', 'support']).load();
    const by = { userId: '980000000000000009', username: 'admin' };
    const run = (mod, action, body) => w.mm.runAction('1', mod, action, body, by);
    const view = (mod, v) => w.mm.runView('1', mod, v);
    const vip = w.role('980000000000000100'); vip.name = 'VIP';
    // Shop.
    await run('economy', 'shop-add', { name: 'VIP pass', price: 5000, role: vip.id, hours: 24, stock: null, emoji: '🎟️', message: 'Shiny', consumable: 'no' });
    await run('economy', 'shop-add', { name: 'Golden Bone', price: 300, role: '', hours: null, stock: 3, emoji: '', message: '{user} chews it', consumable: 'yes' });
    let shop = (await view('economy', 'shop')).rows.filter((r) => !r.id.startsWith('builtin:'));
    assert.deepEqual(shop.map((r) => [r.id, r.gives, r.stock]), [['golden-bone', 'Item (used up)', '3'], ['vip-pass', '@VIP for 24 h', 'Unlimited']]);
    await run('economy', 'shop-price', { id: 'golden-bone', price: 450 });
    await run('economy', 'shop-stock', { id: 'golden-bone', stock: '' });
    shop = (await view('economy', 'shop')).rows.filter((r) => !r.id.startsWith('builtin:')); assert.equal(shop.find((r) => r.id === 'golden-bone').priceRaw, 450); assert.equal(shop.find((r) => r.id === 'golden-bone').stock, 'Unlimited');
    await assert.rejects(run('economy', 'shop-price', { id: 'golden-bone', price: 0 }), /at least 1/);
    await run('economy', 'shop-remove', { id: 'vip-pass' });
    assert.equal((await view('economy', 'shop')).rows.filter((r) => !r.id.startsWith('builtin:')).length, 1);
    // XP boosts.
    await run('community', 'boost-add', { role: vip.id, channel: '', mult: 1.5 });
    await assert.rejects(run('community', 'boost-add', { role: '', channel: '', mult: 2 }), /role or a channel/);
    await assert.rejects(run('community', 'boost-add', { role: vip.id, mult: 9 }), /0\.1 to 5/);
    await run('community', 'boost-set', { id: `role:${vip.id}`, mult: 2 });
    assert.deepEqual((await view('community', 'boosts')).rows.map((r) => [r.name, r.mult]), [['@VIP', '×2']]);
    await run('community', 'boost-remove', { id: `role:${vip.id}` });
    assert.equal((await view('community', 'boosts')).rows.length, 0);
    // Role menus.
    const R = await import('../modules/roles/index.js');
    const room = w.channel('roles');
    const msg = await R.postRoleMenu(w.mm.ctx('1', 'roles'), room, { title: 'Games', roles: [{ id: vip.id }] });
    await run('roles', 'menu-max', { id: msg.id, max: 2 });
    await run('roles', 'menu-hours', { id: msg.id, hours: 12 });
    const menus = (await view('roles', 'menus')).rows;
    assert.deepEqual([menus[0].max, menus[0].hours, menus[0].channel], ['2', '12 h', '#roles']);
    await assert.rejects(run('roles', 'menu-max', { id: msg.id, max: 99 }), /0 to 25/);
    // Critters: a spawn from the dashboard.
    await run('critters', 'critter-spawn', { channel: room.id });
    assert.ok(globalThis[Symbol.for('goodboy.critters.spawns')].get('1'), 'a critter appeared'); globalThis[Symbol.for('goodboy.critters.spawns')].delete('1');
    // Ratings.
    w.mm.ctx('1', 'support').data.set('rating:7', { stars: 5, by: '1', staff: '2', at: Date.now() });
    const rt = await view('support', 'ratings');
    assert.equal(rt.rows[0].stars, '⭐⭐⭐⭐⭐'); assert.match(rt.charts[0].title, /5 average from 1/);
    // Every new Add form is an allowed action for people with that page's permission.
    const panels = w.mm.describeForGuild('1').flatMap((d) => d.panels ?? []);
    for (const id of ['shop', 'boosts', 'tools']) assert.ok(panels.find((p) => p.id === id)?.addForm, `${id} has an Add form`);
  });

  await test('counting and word chain: numbers and small sums count, no double turns, a mistake resets (record kept), a deleted number is announced; word chain checks letters and repeats', async () => {
    const C = await import('../modules/counting/index.js');
    assert.equal(C.readNumber('12'), 12); assert.equal(C.readNumber('10+2'), 12); assert.equal(C.readNumber('(3x4)'), 12); assert.equal(C.readNumber('24/2 nice'), 12);
    assert.equal(C.readNumber('hello'), null); assert.equal(C.readNumber('process.exit()'), null); assert.equal(C.readNumber('1+'), null);
    assert.deepEqual(C.checkCount({ n: 4, last: 'a' }, 'b', '5'), { ok: true, value: 5 });
    assert.match(C.checkCount({ n: 4, last: 'a' }, 'a', '5').why, /twice/);
    assert.match(C.checkCount({ n: 4, last: 'a' }, 'b', '6').why, /\*\*5\*\*/);
    assert.ok(C.checkCount({ n: 4 }, 'b', 'lol').skip, 'chat that is not a number is ignored');
    assert.deepEqual(C.checkWord({ word: 'apple', lastUser: 'a', used: ['apple'] }, 'b', 'Egg'), { ok: true, word: 'egg' });
    assert.match(C.checkWord({ word: 'apple', used: ['apple'] }, 'b', 'banana').why, /start with \*\*E\*\*/);
    assert.match(C.checkWord({ word: 'tree', used: ['egg', 'tree'] }, 'b', 'egg').why, /already used/);
    const w = await makeWorld(['counting']).load();
    const room = w.channel('count'); const a = w.person('990000000000000001'); const b = w.person('990000000000000002');
    const { PermissionFlagsBits: P } = await import('discord.js');
    const admin = w.person('990000000000000009', { bits: [P.Administrator], pos: 10 });
    const cmd = async (member, sub) => { const i = w.ix({ command: 'counting', sub, member, channel: room }); await w.mm.handleCommand(i); return i; };
    await cmd(admin, 'here');
    let mid = 0;
    const say = async (member, content) => { const m = { id: `m${++mid}`, guildId: '1', channelId: room.id, channel: room, author: member.user, member, content, reactions: [], react: async (e) => { m.reactions.push(e); } }; await w.mm.dispatch('messageCreate', '1', m); return m; };
    const g = w.mm.ctx('1', 'counting');
    assert.deepEqual((await say(a, '1')).reactions, ['✅']);
    await say(b, '1+1');
    assert.deepEqual((await say(b, '3')).reactions, ['❌'], 'no counting twice in a row');
    assert.equal(g.data.get(`count:${room.id}`).n, 0); assert.equal(g.data.get(`count:${room.id}`).record, 2);
    assert.match(JSON.stringify(room.sent.at(-1)), /broke the count at \*\*2\*\*/);
    await say(a, '1'); const two = await say(b, '2');
    await w.mm.dispatch('messageDelete', '1', { id: two.id, guildId: '1', channelId: room.id, channel: room });
    assert.match(JSON.stringify(room.sent.at(-1)), /next number is \*\*3\*\*/);
    assert.match(JSON.stringify((await cmd(a, 'stats')).replies), /best \*\*2\*\*/);
    assert.match(JSON.stringify((await cmd(a, 'here')).replies), /permission/, 'only staff start games');
  });

  await test('backup: a snapshot of roles, channels and role permissions; restore adds back only what is missing, categories before their channels; keeps the last 10', async () => {
    const B = await import('../modules/backup/index.js');
    const { PermissionFlagsBits: P } = await import('discord.js');
    const w = await makeWorld(['backup']).load();
    const g = w.g;
    const mod = w.role('991000000000000001'); Object.assign(mod, { name: 'Mods', color: 0xff0000, hoist: true, mentionable: false, permissions: { bitfield: P.KickMembers }, position: 5 });
    const cat = { id: '991000000000000010', name: 'Staff', type: 4, parentId: null, rawPosition: 0, permissionOverwrites: { cache: new Map() } };
    const chan = { id: '991000000000000011', name: 'mod-chat', type: 0, parentId: cat.id, rawPosition: 1, topic: 'secret', permissionOverwrites: { cache: new Map([[mod.id, { id: mod.id, type: 0, allow: { bitfield: P.ViewChannel }, deny: { bitfield: 0n } }], [g.id, { id: g.id, type: 0, allow: { bitfield: 0n }, deny: { bitfield: P.ViewChannel } }]]) } };
    g.channels.cache.set(cat.id, cat); g.channels.cache.set(chan.id, chan);
    const snap = B.snapshot(g);
    const mc = snap.channels.find((c) => c.name === 'mod-chat');
    assert.equal(mc.parent, 'Staff'); assert.equal(mc.topic, 'secret');
    assert.deepEqual(mc.overwrites.map((o) => o.role).sort(), ['@everyone', 'Mods'], 'permissions keep role names');
    assert.ok(snap.roles.some((r) => r.name === 'Mods' && r.permissions === String(P.KickMembers)));
    // Delete the role and both channels, then plan + restore.
    g.roles.cache.delete(mod.id); g.channels.cache.delete(cat.id); g.channels.cache.delete(chan.id);
    const todo = B.plan(snap, g);
    assert.deepEqual(todo.roles.map((r) => r.name), ['Mods']); assert.deepEqual(todo.channels.map((c) => c.name).sort(), ['Staff', 'mod-chat']);
    const made = [];
    g.roles.create = async (o) => { const r = { id: `r-${o.name}`, name: o.name, position: 1 }; g.roles.cache.set(r.id, r); made.push(['role', o.name]); return r; };
    g.channels.create = async (o) => { const c = { id: `c-${o.name}`, name: o.name, type: o.type, parentId: o.parent ?? null }; g.channels.cache.set(c.id, c); made.push(['channel', o.name, o.parent, o.permissionOverwrites?.length ?? 0]); return c; };
    const res = await B.restore(g, snap, todo);
    assert.deepEqual([res.roles, res.channels, res.failed], [1, 2, []]);
    assert.deepEqual(made, [['role', 'Mods'], ['channel', 'Staff', null, 0], ['channel', 'mod-chat', 'c-Staff', 2]], 'the category first, then its channel inside it, with both permissions');
    assert.deepEqual(B.plan(snap, g), { roles: [], channels: [] }, 'nothing missing now');
    // Keeps the last 10.
    const ctx = w.mm.ctx('1', 'backup');
    for (let k = 0; k < 12; k++) await w.mm.runAction('1', 'backup', 'backup-now', {}, { userId: 'x', username: 'x' });
    assert.equal(ctx.sql.get('SELECT COUNT(*) AS n FROM backup_snapshots WHERE guild_id = ?', '1').n, B.KEEP);
  });

  await test('rank cards: members pick a theme, two colours and a Discord-uploaded background; bad colours and outside links are refused; only your own card has the button', async () => {
    const R = await import('../src/rankcard.js');
    assert.ok(R.okBackground('https://cdn.discordapp.com/attachments/1/2/bg.png?ex=1') && R.okBackground('https://media.discordapp.net/attachments/1/2/a.jpg'));
    assert.ok(!R.okBackground('https://evil.example/x.png') && !R.okBackground('http://cdn.discordapp.com/attachments/1/2/a.png'));
    assert.ok(R.okHex('#6B93FF') && R.okHex('6b93ff') && !R.okHex('blue'));
    assert.ok(Object.keys(R.THEMES).length >= 7);
    const w = await makeWorld(['community']).load();
    const room = w.channel('chat'); const m = w.person('992000000000000001');
    const press = async (customId, fields) => { const i = w.ix({ customId, member: m, channel: room }); if (fields) { i.isModalSubmit = () => true; i.fields = { getTextInputValue: (k) => fields[k] ?? '', getStringSelectValues: (k) => [].concat(fields[k] ?? []) }; } await w.mm.handleComponent(i); return i; };
    assert.ok((await press(`rankstyle:open:${m.id}`)).modal, 'the Customise popup opens');
    assert.match(JSON.stringify((await press(`rankstyle:save:${m.id}`, { theme: 'forest', accent: 'green', accent2: '', background: '' })).replies), /isn't a colour/);
    assert.match(JSON.stringify((await press(`rankstyle:save:${m.id}`, { theme: 'forest', accent: '#5fcf6a', accent2: '', background: 'https://evil.example/x.png' })).replies), /uploaded to Discord/);
    await press(`rankstyle:save:${m.id}`, { theme: 'forest', accent: '#5fcf6a', accent2: '#c6f36b', background: '' });
    assert.deepEqual(w.mm.ctx('1', 'community').data.get(`card:${m.id}`), { theme: 'forest', accent: '#5fcf6a', accent2: '#c6f36b', background: null });
    assert.match(JSON.stringify((await press('rankstyle:open:someone-else')).replies), /someone else/);
  });

  await test('economy extras: robbing is off by default; when on it steals or fines, respects cooldowns, padlocks stop it; pets need care and boost /work; coin events pay the first grabber or share between everyone', async () => {
    const X = await import('../modules/economy/extras.js');
    const E = await import('../modules/economy/index.js');
    assert.equal(X.robOutcome({ robberCoins: 1000, targetCoins: 10000, padlock: false, maxSteal: 50000 }, () => 0).outcome, 'stole');
    assert.equal(X.robOutcome({ robberCoins: 1000, targetCoins: 10000, padlock: false, maxSteal: 50000 }, () => 0.9).outcome, 'caught');
    assert.equal(X.robOutcome({ robberCoins: 1000, targetCoins: 10000, padlock: true, maxSteal: 50000 }, () => 0).outcome, 'padlock');
    assert.equal(X.robOutcome({ robberCoins: 1000, targetCoins: 1e9, padlock: false, maxSteal: 500 }, () => 0).coins, 500, 'capped');
    assert.deepEqual(X.shares(10, 3), [4, 3, 3]); assert.deepEqual(X.shares(10, 0), []);
    const w = await makeWorld(['economy']).load();
    const room = w.channel('chat'); const a = w.person('993000000000000001'); const b = w.person('993000000000000002');
    const g = w.mm.ctx('1', 'economy'); const api = w.mm.moduleApi('1', 'economy');
    api.wallet('1', a.id); api.wallet('1', b.id);
    const set = (id, n) => g.sql.run('UPDATE economy_wallets SET coins = ? WHERE user_id = ?', n, id);
    const coins = (id) => g.sql.get('SELECT coins FROM economy_wallets WHERE user_id = ?', id).coins;
    const H = { wallet: (u) => api.wallet('1', u), debit: (u, n, r) => api.debit('1', u, n, r), credit: (u, n, r) => api.credit('1', u, n, r), move: (u, n) => g.sql.run('UPDATE economy_wallets SET coins = coins + ? WHERE user_id = ?', n, u) };
    await assert.rejects(X.rob(g, a.id, b.user, H), /turned off/, 'off by default');
    w.mm.setSetting('1', 'economy', 'robbing', true);
    set(a.id, 1000); set(b.id, 10000);
    const t0 = Date.now();
    const o = await X.rob(g, a.id, b.user, H, t0, () => 0);
    assert.equal(o.outcome, 'stole'); assert.equal(coins(a.id), 1000 + o.coins); assert.equal(coins(b.id), 10000 - o.coins);
    await assert.rejects(X.rob(g, a.id, b.user, H, t0 + 60000), /Lay low/);
    const c = w.person('993000000000000003'); api.wallet('1', c.id); set(c.id, 1000);
    await assert.rejects(X.rob(g, c.id, b.user, H, t0 + 60000), /robbed not long ago/);
    // Padlock: bought in the shop, stops one robbery, the robber pays.
    const SHOP = await import('../modules/economy/shop.js');
    set(b.id, 20000);
    await SHOP.buy(g, b.id, 'padlock', H);
    const before = coins(c.id);
    const o2 = await X.rob(g, c.id, b.user, H, t0 + 3 * 3600000, () => 0);
    assert.equal(o2.outcome, 'padlock'); assert.ok(coins(c.id) < before, 'the robber paid a fine');
    assert.equal(g.sql.get("SELECT qty FROM economy_items WHERE user_id = ? AND item_id = 'padlock'", b.id).qty, 0, 'the padlock broke');
    // Pets.
    set(a.id, 10000);
    const p = X.adopt(g, a.id, 'puppy', 'Biscuit', H);
    assert.equal(p.name, 'Biscuit'); assert.equal(coins(a.id), 8000);
    assert.throws(() => X.adopt(g, a.id, 'kitten', null, H), /already have a pet/);
    const fed = X.care(g, a.id, 'feed', H); assert.match(fed.text, /Biscuit/); assert.ok(fed.pet.hunger > 80);
    assert.throws(() => X.care(g, a.id, 'feed', H), /isn't hungry/);
    assert.ok(X.petBonus(fed.pet) >= 4, 'a cared-for pet helps /work');
    assert.equal(X.petBonus({ ...fed.pet, updated_at: Date.now() - 200 * 3600000 }), 0, 'a neglected pet stops helping');
    // Events.
    const g2 = w.mm.ctx('1', 'economy');
    const id = await E.startEvent(g2, room, X.EVENTS[0], 500);
    const press = async (member) => { const i = w.ix({ customId: `econ:ev:${id}`, member, channel: room }); await w.mm.handleComponent(i); return i; };
    const before2 = coins(b.id);
    await press(b); assert.equal(coins(b.id), before2 + 500, 'first press wins it');
    assert.match(JSON.stringify((await press(a)).replies), /Too late/);
    const id2 = await E.startEvent(g2, room, X.EVENTS[1], 301);
    for (const m of [a, b, c]) { const i = w.ix({ customId: `econ:ev:${id2}`, member: m, channel: room }); await w.mm.handleComponent(i); }
    const live = globalThis[Symbol.for('goodboy.economy.evLive')].get(id2);
    const ca = coins(a.id), cb = coins(b.id), cc = coins(c.id);
    await live.finish();
    assert.equal(coins(a.id) - ca + coins(b.id) - cb + coins(c.id) - cc, 301, 'everyone who pressed shares it exactly');
  });

  await test('feeds: Bluesky posts (no replies or reposts), Kick live alerts (nothing when offline), Mastodon addresses', async () => {
    const I = await import('../modules/integrations/index.js');
    const feed = { feed: [
      { post: { uri: 'at://did/app.bsky.feed.post/aaa', author: { handle: 'me.bsky.social', displayName: 'Me' }, record: { text: 'hello world' } } },
      { reason: { $type: 'repost' }, post: { uri: 'at://did/app.bsky.feed.post/bbb', author: { handle: 'other.bsky.social' }, record: { text: 'theirs' } } },
    ] };
    const items = await I.blueskyPosts('me.bsky.social', async () => ({ ok: true, json: async () => feed }));
    assert.deepEqual(items, [{ id: 'at://did/app.bsky.feed.post/aaa', title: 'hello world', url: 'https://bsky.app/profile/me.bsky.social/post/aaa', author: 'Me' }]);
    await assert.rejects(I.blueskyPosts('nope.bsky.social', async () => ({ ok: false, status: 400 })), /doesn't exist/);
    const live = await I.kickLive('streamer', async () => ({ ok: true, json: async () => ({ slug: 'streamer', user: { username: 'Streamer' }, livestream: { id: 9, is_live: true, session_title: 'Speedruns', categories: [{ name: 'Minecraft' }] } }) }));
    assert.deepEqual(live, [{ id: 'kick-9', title: '🟢 Streamer is live on Kick: Speedruns', url: 'https://kick.com/streamer', author: 'Minecraft' }]);
    assert.deepEqual(await I.kickLive('streamer', async () => ({ ok: true, json: async () => ({ livestream: null }) })), []);
    const P = I.default.api.providers;
    assert.equal(await P.get('mastodon').resolve('@Gargron@Mastodon.social'), 'Gargron@mastodon.social');
    assert.equal(await P.get('mastodon').resolve('https://fosstodon.org/@someone'), 'someone@fosstodon.org');
    await assert.rejects(P.get('mastodon').resolve('not an address'), /Mastodon address/);
    assert.equal(await P.get('kick').resolve('https://kick.com/XQC'), 'xqc');
  });

  await test('always online: the Linux install script is valid, installs a service that runs the supervisor and restarts by itself; Docker keeps data outside and the dashboard local', async () => {
    const fs = await import('node:fs'); const { execFileSync } = await import('node:child_process');
    const root = new URL('../', import.meta.url);
    execFileSync('bash', ['-n', new URL('deploy/install-linux.sh', root).pathname]);
    const unit = fs.readFileSync(new URL('deploy/goodboy.service', root), 'utf8');
    assert.match(unit, /ExecStart=__NODE__ .*scripts\/supervise\.js/); assert.match(unit, /Restart=always/); assert.match(unit, /WantedBy=multi-user\.target/);
    assert.match(unit, /ReadWritePaths=__DIR__/, 'it can only write to its own folder');
    const sh = fs.readFileSync(new URL('deploy/install-linux.sh', root), 'utf8');
    assert.match(sh, /systemctl enable --now goodboy/); assert.match(sh, /app-tools\.js import/); assert.match(sh, /data\/eclipse\.db/, 'checks the real database file'); assert.match(sh, /Only run ONE copy/);
    const docker = fs.readFileSync(new URL('Dockerfile', root), 'utf8'), compose = fs.readFileSync(new URL('docker-compose.yml', root), 'utf8');
    assert.match(docker, /scripts\/supervise\.js/); assert.match(docker, /USER node/);
    assert.match(compose, /127\.0\.0\.1:3000:3000/, 'the dashboard is not opened to the internet by default'); assert.match(compose, /\.\/data:\/app\/data/);
    assert.match(fs.readFileSync(new URL('.dockerignore', root), 'utf8'), /^\.env$/m, 'the token never goes into the image');
    const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
    assert.equal(pkg.scripts['import-data'], 'node scripts/app-tools.js import');
  });

  await test('starter shop items: lucky charm and work boost last a set time, the pet treat cheers up a pet, lottery tickets pay the whole pool to one winner each week; staff can change prices, remove and bring them back', async () => {
    const SHOP = await import('../modules/economy/shop.js');
    const X = await import('../modules/economy/extras.js');
    const F = await import('../src/fishing.js');
    const w = await makeWorld(['economy']).load();
    const g = w.mm.ctx('1', 'economy'); const api = w.mm.moduleApi('1', 'economy');
    const ids = ['994000000000000001', '994000000000000002'];
    for (const id of ids) { api.wallet('1', id); g.sql.run('UPDATE economy_wallets SET coins = 100000 WHERE user_id = ?', id); }
    const [a, b] = ids;
    const H = { wallet: (u) => api.wallet('1', u), debit: (u, n, r) => api.debit('1', u, n, r), credit: (u, n, r) => api.credit('1', u, n, r), move: (u, n) => g.sql.run('UPDATE economy_wallets SET coins = coins + ? WHERE user_id = ?', n, u) };
    assert.deepEqual(SHOP.starters(g).map((x) => x.id), ['luck', 'workboost', 'ticket', 'treat']);
    await SHOP.buy(g, a, 'luck', H); await SHOP.buy(g, a, 'workboost', H);
    assert.deepEqual(SHOP.inventory(g, a).map((x) => x.id).sort(), ['luck', 'workboost']);
    const t0 = Date.now();
    assert.match(SHOP.useItem(g, a, 'luck', t0).text, /fishing luck/);
    assert.ok(api.boostUntil('1', a, 'luck') >= t0 + 3590000, 'lasts about an hour');
    SHOP.useItem(g, a, 'workboost', t0); assert.ok(SHOP.boostUntil(g, a, 'workboost') > t0 + 86000000);
    assert.equal(SHOP.inventory(g, a).length, 0, 'used up');
    // The lucky charm really shifts the catch odds.
    const rare = (bonus) => { let n = 0; for (let k = 0; k < 4000; k++) if (F.rollCatch({ biome: 'bay', rod: 'driftwood', bait: 'none', tackle: 'none', bonusLuck: bonus }, F.seeded(k)).rarity !== 'common') n++; return n; };
    assert.ok(rare(0.3) > rare(0), 'more rare fish with the charm');
    // Pet treat.
    X.adopt(g, a, 'puppy', 'Biscuit', H);
    g.sql.run('UPDATE economy_pets SET happy = 20, hunger = 20 WHERE user_id = ?', a);
    await SHOP.buy(g, a, 'treat', H);
    assert.match(SHOP.useItem(g, a, 'treat').text, /Biscuit\*\* loves the treat/);
    assert.ok(X.getPet(g, a).happy >= 60);
    await SHOP.buy(g, b, 'treat', H); assert.throws(() => SHOP.useItem(g, b, 'treat'), /need a pet/);
    // Lottery: tickets this week, drawn next week, the whole pool to one winner, once.
    await SHOP.buy(g, a, 'ticket', H); await SHOP.buy(g, a, 'ticket', H); await SHOP.buy(g, b, 'ticket', H);
    const l = SHOP.lottery(g, a); assert.equal(l.tickets, 3); assert.equal(l.mine, 2); assert.equal(l.pool, 3 * SHOP.starters(g).find((x) => x.id === 'ticket').price);
    assert.deepEqual(SHOP.drawLotteries(g, H), [], 'not drawn while the week is still running');
    const before = api.wallet('1', b).coins;
    const res = SHOP.drawLotteries(g, H, Date.now() + 8 * 86400000, () => 0.99);
    assert.equal(res.length, 1); assert.equal(res[0].winner, b); assert.equal(api.wallet('1', b).coins, before + l.pool);
    assert.deepEqual(SHOP.drawLotteries(g, H, Date.now() + 8 * 86400000), [], 'a week is only drawn once');
    // Staff: price, remove, bring back.
    await w.mm.runAction('1', 'economy', 'shop-price', { id: 'builtin:luck', price: 999 }, { userId: 'x', username: 'x' });
    assert.equal(SHOP.starters(g).find((x) => x.id === 'luck').price, 999);
    await w.mm.runAction('1', 'economy', 'shop-remove', { id: 'builtin:luck' }, { userId: 'x', username: 'x' });
    await assert.rejects(SHOP.buy(g, a, 'luck', H), /not for sale/);
    await w.mm.runAction('1', 'economy', 'shop-restore', {}, { userId: 'x', username: 'x' });
    assert.equal(SHOP.starters(g).find((x) => x.id === 'luck').off, false);
  });
}
