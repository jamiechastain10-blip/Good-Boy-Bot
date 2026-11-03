/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * 2.3 tests: the live channel, the live dashboard stream, tester access, feedback, and the desktop app's one-time
 * sign-in link.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { PermissionFlagsBits as P } from 'discord.js';
import { startDashboard } from '../src/dashboard/server.js';
import { publish, subscribe, recentActivity } from '../src/live.js';
import { makeWorld } from './features.js';
import { memberNotes, versionsBetween, announceUpdates, announceNewModules } from '../modules/botnews/index.js';
import { sectionForDiscord } from '../src/about.js';
import { findClipUrl, medalSharer, clipFrom, videoOf, isDiscordFile } from '../modules/clips/index.js';

const G = '900000000000000700';

async function world(mods = ['community', 'moderation']) {
  const w = await makeWorld(mods, { guildId: G }).load();
  w.logs = [];
  w.dash = await startDashboard({ manager: w.mm, client: w.client, db: w.db, logger: { info: (m) => w.logs.push(m), warn: (m) => w.logs.push(m), error: (m) => w.logs.push(m) }, perms: w.perms, port: 0, host: '127.0.0.1', version: '2.3.0' });
  w.admin = w.person('900000000000000701', { bits: [P.ManageGuild] });
  w.tester = w.person('900000000000000702');
  w.session = (m) => { const sid = `sid-${m.id}`; w.dash.sessions.set(sid, { user: { id: m.id, username: `user${m.id.slice(-3)}`, avatar: null }, guilds: [{ id: G, name: 'Test Guild', icon: null, owner: false, permissions: '0' }], expires: Date.now() + 3600000 }); return `gb_sid=${sid}`; };
  w.req = (method, p, { cookie, body } = {}) => new Promise((resolve, reject) => {
    const h = {}; if (cookie) h.cookie = cookie; if (method === 'POST') h['x-goodboy'] = '1';
    const r = http.request({ host: '127.0.0.1', port: w.dash.port, path: p, method, headers: h }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString('utf8'), json() { return JSON.parse(this.text); } })); });
    r.on('error', reject); if (body !== undefined) r.write(JSON.stringify(body)); r.end();
  });
  /** Opens the live stream and collects events until `until(events)` is true. */
  w.stream = (cookie, until, during = async () => {}) => new Promise((resolve, reject) => {
    const events = [];
    const r = http.request({ host: '127.0.0.1', port: w.dash.port, path: `/api/guilds/${G}/live`, method: 'GET', headers: cookie ? { cookie } : {} }, (res) => {
      let buf = '';
      if (res.statusCode !== 200) { res.resume(); return resolve({ status: res.statusCode, events }); }
      let started = false;
      res.on('data', async (d) => {
        buf += d.toString('utf8');
        let k;
        while ((k = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, k); buf = buf.slice(k + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.+)$/m.exec(block)?.[1];
          if (type) events.push({ type, data: JSON.parse(data) });
        }
        if (!started && events.some((e) => e.type === 'pulse')) { started = true; await during(); }
        if (until(events)) { r.destroy(); resolve({ status: 200, events }); }
      });
    });
    r.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    r.end();
    setTimeout(() => { r.destroy(); resolve({ status: 'timeout', events }); }, 3000).unref();
  });
  return w;
}

export default async function runV23Tests({ test }) {
  console.log('\n2.3 live channel');
  await test('the live bus: per-server events, the activity list keeps the latest 30, unsubscribing stops delivery', () => {
    const got = [];
    const stop = subscribe('g1', (e) => got.push(e.type));
    publish('g1', 'data', { module: 'x' }); publish('g2', 'data', { module: 'x' });
    for (let k = 0; k < 35; k++) publish('g1', 'activity', { icon: '•', text: `line ${k}` });
    stop(); publish('g1', 'data');
    assert.equal(got.length, 36, 'only g1, and nothing after unsubscribing');
    const list = recentActivity('g1');
    assert.equal(list.length, 30); assert.equal(list[0].text, 'line 34');
  });

  await test('the core announces modules switching, setting changes and panel actions; modules add activity lines', async () => {
    const w = await makeWorld(['community'], { guildId: G }).load();
    const got = [];
    const stop = subscribe(G, (e) => got.push(`${e.type}:${e.data.module ?? ''}`));
    await w.mm.enable(G, 'moderation');
    w.mm.setSetting(G, 'community', 'xpMin', '20');
    w.mm.ctx(G, 'community').data.set('user:900000000000000799', { xp: 0 });
    await w.mm.runAction(G, 'community', 'xp-give', { userId: '900000000000000799', value: 10 }, { userId: 'a', username: 'a' });
    await w.mm.disable(G, 'moderation');
    stop();
    for (const want of ['modules:moderation', 'settings:community', 'data:community', 'activity:moderation']) assert.ok(got.includes(want), `${want} in ${got.join(' ')}`);
  });

  console.log('\n2.3 live dashboard');
  await test('the live stream: signed-in only, starts with recent activity and a pulse, then forwards changes as they happen', async () => {
    const w = await world();
    assert.equal((await w.stream(undefined, () => true)).status, 401);
    publish(G, 'activity', { module: 'x', icon: '⭐', text: 'Earlier thing' });
    const r = await w.stream(w.session(w.admin), (ev) => ev.some((e) => e.type === 'settings'), async () => { w.mm.setSetting(G, 'community', 'xpMin', '30'); });
    assert.equal(r.status, 200);
    const types = r.events.map((e) => e.type);
    assert.equal(types[0], 'hello'); assert.ok(types.includes('pulse'));
    assert.ok(r.events[0].data.activity.some((a) => a.text === 'Earlier thing'), 'recent activity comes first');
    const pulse = r.events.find((e) => e.type === 'pulse').data;
    assert.ok('members' in pulse && 'modulesOn' in pulse && 'uptimeSeconds' in pulse);
    assert.deepEqual(r.events.find((e) => e.type === 'settings').data.module, 'community');
    w.dash.close();
  });

  await test('the dashboard page listens live: EventSource, change highlighting, no browser popups, motion only in the glass layer', () => {
    const js = fs.readFileSync(new URL('../src/dashboard/public/app.js', import.meta.url), 'utf8');
    for (const need of ["new EventSource(`/api/guilds/${state.gid}/live`)", "on('data'", "on('activity'", "on('pulse'", 'softReload', "'flash'", "'enter'", 'data-stat', 'feedbackButton', 'testersCard']) assert.ok(js.includes(need), need);
    assert.doesNotMatch(js, /window\.(prompt|confirm|alert)\(/);
    const css = fs.readFileSync(new URL('../src/dashboard/public/style.css', import.meta.url), 'utf8');
    const glass = fs.readFileSync(new URL('../src/dashboard/public/glass.css', import.meta.url), 'utf8');
    assert.ok(!/animation|@keyframes/.test(css));
    for (const need of ['@keyframes rowflash', '@keyframes enter', '@keyframes bump', '.motion-off tr.flash td']) assert.ok(glass.includes(need), need);
  });

  console.log('\n2.3 testers and feedback');
  await test('admins give a role tester access in one click; "every read-only box" never includes buttons or private boxes', async () => {
    const w = await world(['community', 'moderation', 'stats', 'support']);
    const role = w.role('900000000000000711');
    const cookie = w.session(w.admin);
    assert.equal((await w.req('POST', `/api/guilds/${G}/testers`, { cookie: w.session(w.tester), body: { roleId: role.id } })).status, 403, 'testers cannot hand out access');
    const r1 = await w.req('POST', `/api/guilds/${G}/testers`, { cookie, body: { roleId: role.id } });
    assert.match(r1.json().message, /can now open the dashboard/);
    assert.deepEqual(w.db.permRoles(G, 'dashboard.access'), [role.id]);
    await w.req('POST', `/api/guilds/${G}/testers`, { cookie, body: { roleId: role.id, everything: true } });
    assert.deepEqual(w.db.permRoles(G, 'stats.manage'), [role.id], 'read-only activity boxes are included');
    for (const key of ['community.manage', 'moderation.automod', 'stats.prune', 'support.staff', 'support.watch']) assert.deepEqual(w.db.permRoles(G, key), [], `${key} is never given in one click`);
    assert.deepEqual(w.db.permRoles(G, 'dashboard.access'), [role.id], 'not added twice');
    assert.equal((await w.req('POST', `/api/guilds/${G}/testers`, { cookie, body: { roleId: G } })).status, 400, '@everyone is refused');
    w.dash.close();
  });

  await test('security: server-wide destructive buttons are admin-only even for roles given that box', async () => {
    const w = await world(['community']);
    const role = w.role('900000000000000713');
    w.tester.roles.cache.set(role.id, role); w.db.permAdd(G, 'dashboard.access', role.id); w.db.permAdd(G, 'community.manage', role.id);
    const cookie = w.session(w.tester);
    w.mm.ctx(G, 'community').data.set('user:900000000000000799', { xp: 50 });
    const give = await w.req('POST', `/api/guilds/${G}/modules/community/actions/xp-give`, { cookie, body: { userId: '900000000000000799', value: 5 } });
    assert.equal(give.status, 200, 'the box itself works for them');
    const all = await w.req('POST', `/api/guilds/${G}/modules/community/actions/xp-reset-all`, { cookie, body: { confirm: 'RESET' } });
    assert.equal(all.status, 403, 'Reset everyone is for admins only');
    assert.equal(w.mm.ctx(G, 'community').data.get('user:900000000000000799').xp, 55);
    w.dash.close();
  });

  await test('security: the AutoMod page works for roles given AutoMod access, and nobody else', async () => {
    const w = await world(['moderation']);
    const role = w.role('900000000000000714');
    const testCookie = w.session(w.tester);
    const path = `/api/guilds/${G}/modules/moderation/actions/automod-test`;
    w.db.permAdd(G, 'dashboard.access', role.id); w.tester.roles.cache.set(role.id, role);
    assert.equal((await w.req('POST', path, { cookie: testCookie, body: { text: 'hi' } })).status, 403, 'dashboard access alone is not enough');
    w.db.permAdd(G, 'moderation.automod', role.id);
    const ok = await w.req('POST', path, { cookie: testCookie, body: { text: 'hi' } });
    assert.equal(ok.status, 200); assert.ok(Array.isArray(ok.json().result.results));
    assert.equal((await w.req('GET', `/api/guilds/${G}/modules/moderation/views/automodpage`, { cookie: testCookie })).status, 200);
    w.dash.close();
  });

  await test('security: the desktop sign-in link is refused when it arrives through a proxy or the shared link', async () => {
    const w = await world();
    w.mm.ownerIds.add(w.admin.id);
    for (const header of ['x-forwarded-for', 'tailscale-funnel-request', 'forwarded']) {
      const l = await w.dash.localLogin();
      const path = new URL(l.url).pathname + new URL(l.url).search;
      const r = await new Promise((resolve, reject) => {
        const q = http.request({ host: '127.0.0.1', port: w.dash.port, path, method: 'GET', headers: { [header]: '1.2.3.4' } }, (res) => { res.resume(); resolve(res.statusCode); });
        q.on('error', reject); q.end();
      });
      assert.equal(r, 403, header);
    }
    w.dash.close();
  });

  await test('testers send feedback; admins see it (and it is announced live); spam is limited', async () => {
    const w = await world();
    const role = w.role('900000000000000712');
    w.tester.roles.cache.set(role.id, role); w.db.permAdd(G, 'dashboard.access', role.id);
    const cookie = w.session(w.tester);
    const heard = []; const stop = subscribe(G, (e) => heard.push(e.type));
    assert.equal((await w.req('POST', `/api/guilds/${G}/feedback`, { cookie, body: { kind: 'bug', text: 'x' } })).status, 400, 'too short');
    assert.equal((await w.req('POST', `/api/guilds/${G}/feedback`, { cookie, body: { kind: 'bug', text: 'Levels did not update', page: 'tool:community' } })).status, 200);
    stop();
    assert.ok(heard.includes('feedback') && heard.includes('activity'));
    assert.equal((await w.req('GET', `/api/guilds/${G}/feedback`, { cookie })).status, 403, 'only admins read the list');
    const rows = (await w.req('GET', `/api/guilds/${G}/feedback`, { cookie: w.session(w.admin) })).json().rows;
    assert.deepEqual([rows[0].kind, rows[0].text, rows[0].page, rows[0].version], ['bug', 'Levels did not update', 'tool:community', '2.3.0']);
    for (let k = 0; k < 9; k++) await w.req('POST', `/api/guilds/${G}/feedback`, { cookie, body: { kind: 'idea', text: `idea ${k}` } });
    assert.equal((await w.req('POST', `/api/guilds/${G}/feedback`, { cookie, body: { kind: 'idea', text: 'one more' } })).status, 429);
    w.dash.close();
  });

  console.log('\n2.3 desktop app sign-in');
  await test('the desktop app gets a one-time link that signs in as the bot owner: works once, expires, and needs no Discord login', async () => {
    const w = await world();
    assert.equal((await w.dash.localLogin()).ok, false, 'no owner known yet');
    w.mm.ownerIds.add(w.admin.id);
    const l = await w.dash.localLogin();
    assert.ok(l.ok); const path = new URL(l.url).pathname + new URL(l.url).search;
    const r = await w.req('GET', path);
    assert.equal(r.status, 302); assert.equal(r.headers.location, '/');
    const cookie = r.headers['set-cookie'][0].split(';')[0];
    const me = (await w.req('GET', '/api/me', { cookie })).json();
    assert.equal(me.user.id, w.admin.id); assert.equal(me.botOwner, true); assert.equal(me.local, true);
    assert.equal(me.guilds[0].access, 'admin');
    assert.equal((await w.req('GET', path)).status, 403, 'the same link does not work twice');
    assert.equal((await w.req('GET', '/login/local?t=made-up')).status, 403);
    w.dash.close();
  });

  console.log('\n2.3 bot news');
  const SECTIONS = [
    { version: '2.4.0', body: 'Staff stuff 2.4\n<!-- members -->\nFishing tournaments!\n<!-- /members -->' },
    { version: '2.3.1', body: 'Only fixes, nothing for members' },
    { version: '2.3.0', body: 'Old news\n<!-- members -->\nOld member news\n<!-- /members -->' },
  ];
  async function newsWorld(mods = ['botnews']) {
    const w = await makeWorld(mods, { guildId: G }).load();
    w.staff = w.channel('staff'); w.news = w.channel('announcements');
    w.mm.setSetting(G, 'botnews', 'adminChannel', w.staff.id);
    w.mm.setSetting(G, 'botnews', 'announceChannel', w.news.id);
    // the 2.3 tests below check posting itself; the 2.3.3 review step and plain style have their own test
    w.mm.setSetting(G, 'botnews', 'reviewAnnouncements', false); w.mm.setSetting(G, 'botnews', 'announceStyle', 'box');
    w.ctx = () => w.mm.ctx(G, 'botnews');
    w.titles = (ch) => ch.sent.map((p) => p.embeds?.[0]?.data?.title ?? p.embeds?.[0]?.data?.description ?? p.content);
    return w;
  }
  const settle = () => new Promise((r) => setTimeout(r, 30));

  await test('bot news: the member part of an update is found, and its markers never show in Discord', () => {
    assert.equal(memberNotes(SECTIONS[0].body), 'Fishing tournaments!');
    assert.equal(memberNotes(SECTIONS[1].body), null);
    assert.doesNotMatch(sectionForDiscord(SECTIONS[0]), /<!--/);
    assert.deepEqual(versionsBetween(SECTIONS, '2.3.0', '2.4.0').map((s) => s.version), ['2.3.1', '2.4.0'], 'oldest first, only the new ones');
    const real = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    assert.ok(/## 2\.3\.0[\s\S]*?<!-- members -->[\s\S]*?<!-- \/members -->/.test(real), '2.3.0 has notes for members');
  });

  await test('bot news: first start is silent; an update posts full notes to admins and only member news to announcements, once', async () => {
    const w = await newsWorld();
    await settle();
    assert.equal(w.staff.sent.length + w.news.sent.length, 0, 'turning it on posts nothing about the past');
    w.ctx().data.set('lastVersion', '2.3.0');
    assert.equal(await announceUpdates(w.ctx(), { version: '2.4.0', sections: SECTIONS }), 2);
    assert.deepEqual(w.titles(w.staff).filter((t) => /updated to/.test(t)), ['🆙 Good Boy updated to 2.3.1', '🆙 Good Boy updated to 2.4.0']);
    assert.equal(w.news.sent.length, 1, '2.3.1 had nothing for members');
    assert.equal(w.news.sent[0].embeds[0].data.description, 'Fishing tournaments!');
    assert.doesNotMatch(JSON.stringify(w.news.sent), /Staff stuff/, 'staff notes stay out of announcements');
    assert.equal(await announceUpdates(w.ctx(), { version: '2.4.0', sections: SECTIONS }), 0, 'never twice');
    w.mm.setSetting(G, 'botnews', 'communityUpdates', false);
    w.ctx().data.set('lastVersion', '2.3.0');
    await announceUpdates(w.ctx(), { version: '2.4.0', sections: SECTIONS });
    assert.equal(w.news.sent.length, 1, 'member posts can be switched off');
  });

  await test('bot news (2.3.3): member news goes to admins as a draft first; Edit posts your own words, Post as it is and Skip work once; plain style is a normal message', async () => {
    const { announce, splitMessage } = await import('../modules/botnews/index.js');
    const w = await newsWorld();
    w.mm.setSetting(G, 'botnews', 'reviewAnnouncements', true); w.mm.setSetting(G, 'botnews', 'announceStyle', 'plain');
    const admin = w.person('900000000000000741', { bits: [P.ManageGuild, P.Administrator], pos: 15 });
    w.ctx().data.set('lastVersion', '2.3.0');
    await announceUpdates(w.ctx(), { version: '2.4.0', sections: SECTIONS });
    assert.equal(w.news.sent.length, 0, 'nothing reaches members before someone checks it');
    const draft = w.staff.sent.find((p) => p.components?.length);
    assert.match(draft.embeds[0].data.title, /Draft/); assert.equal(draft.embeds[0].data.description, 'Fishing tournaments!');
    // Edit: a popup filled with the draft, and what you type is what gets posted
    const edit = w.ix({ customId: 'botnews:edit:v2.4.0', member: admin, channel: w.staff });
    await w.mm.handleComponent(edit);
    assert.ok(edit.modal, 'opens the editor');
    const submit = w.ix({ customId: 'botnews:submit:v2.4.0', member: admin, channel: w.staff });
    submit.isModalSubmit = () => true; submit.fields = { getTextInputValue: () => 'yo, fishing tournaments are here. go catch something big' };
    await w.mm.handleComponent(submit);
    assert.equal(w.news.sent.length, 1);
    assert.equal(w.news.sent[0].content, 'yo, fishing tournaments are here. go catch something big', 'plain message, your words');
    assert.ok(!w.news.sent[0].embeds?.length, 'no card, no emoji title');
    const again = w.ix({ customId: 'botnews:post:v2.4.0', member: admin, channel: w.staff });
    await w.mm.handleComponent(again);
    assert.equal(w.news.sent.length, 1, 'a draft is only posted once');
    // members who don't manage bot news can't press the buttons
    await announce(w.ctx(), 'mtest', 'Something new', 'Test');
    const member = w.person('900000000000000742');
    const nope = w.ix({ customId: 'botnews:post:mtest', member, channel: w.staff });
    await w.mm.handleComponent(nope);
    assert.equal(w.news.sent.length, 1);
    const skip = w.ix({ customId: 'botnews:skip:mtest', member: admin, channel: w.staff });
    await w.mm.handleComponent(skip);
    assert.equal(w.ctx().data.get('draft:mtest').status, 'skipped');
    // long posts are split between paragraphs
    const parts = splitMessage(`${'a'.repeat(1500)}\n\n${'b'.repeat(1500)}`);
    assert.equal(parts.length, 2); assert.ok(parts.every((x) => x.length <= 2000));
  });

  await test('bot news: new modules are told to admins; turning a member feature on introduces it to members once', async () => {
    const w = await newsWorld(['botnews', 'economy']);
    await settle();
    assert.equal(await announceNewModules(w.ctx(), [{ name: 'economy' }, { name: 'shiny', description: 'A new thing' }]), 1, 'only what was not there at the last start');
    assert.match(JSON.stringify(w.staff.sent.at(-1)), /shiny/);
    await w.mm.enable(G, 'games'); await settle();
    assert.ok(w.titles(w.staff).some((t) => /\*\*games\*\* was turned on/.test(t)), 'admins hear about modules switching');
    assert.equal(w.news.sent.length, 1); assert.equal(w.news.sent[0].embeds[0].data.title, 'games are open');
    await w.mm.disable(G, 'games'); await w.mm.enable(G, 'games'); await settle();
    assert.equal(w.news.sent.length, 1, 'members are introduced once');
    await w.mm.enable(G, 'moderation'); await settle();
    assert.equal(w.news.sent.length, 1, 'staff-only modules are not announced to members');
  });

  await test('bot news: /botnews setup saves the channels picked in the popup', async () => {
    const w = await newsWorld();
    const admin = w.person('900000000000000731', { bits: [P.ManageGuild] });
    const a = w.channel('mods'); const b = w.channel('news2');
    await w.run(w.ix({ command: 'botnews', sub: 'setup', member: admin, opts: { admin_channel: a, announce_channel: b } }));
    assert.equal(w.ctx().config.get('adminChannel'), a.id); assert.equal(w.ctx().config.get('announceChannel'), b.id);
  });

  console.log('\n2.3 clips');
  const MEDAL_POST = (userId, id = '700000000000000001') => ({
    id, guildId: G, author: { id: '674264430937489408', bot: true, username: 'Medal' }, createdTimestamp: Date.now(),
    content: `<@${userId}> shared a clip\n\n[View on Medal](https://medal.tv/games/cs2/clips/abc123?invite=cr-x)`,
    mentions: { users: { first: () => ({ id: userId }) } },
    embeds: [{ title: 'Powerpoint - Clipped Counter-Strike 2 with Medal.tv', url: 'https://medal.tv/games/cs2/clips/abc123' }],
  });
  await test('clips: Medal\'s "shared a clip" post is credited to the member it mentions; pasted links to the poster; chat is ignored', () => {
    const post = MEDAL_POST('900000000000000901');
    assert.equal(medalSharer(post), '900000000000000901');
    assert.deepEqual(clipFrom(post), { userId: '900000000000000901', url: 'https://medal.tv/games/cs2/clips/abc123?invite=cr-x', title: 'Powerpoint - Clipped Counter-Strike 2 with Medal.tv', via: 'medal' });
    assert.equal(findClipUrl('look https://youtu.be/xyz!'), 'https://youtu.be/xyz');
    assert.equal(findClipUrl('no he ran away'), null);
    assert.equal(clipFrom({ author: { id: '9', bot: false }, content: 'no he ran away', embeds: [] }), null);
    assert.equal(clipFrom({ author: { id: '8', bot: true }, content: 'some other bot https://medal.tv/x', embeds: [] }), null, 'other bots are not clips');
    assert.equal(clipFrom({ author: { id: '9', bot: false }, content: 'my play https://medal.tv/games/x/clips/1', embeds: [] }).userId, '9');
  });

  await test('clips: vote reaction added, owner and bots do not count, enough votes reposts once with the video, coins per clip, clip of the week pays', async () => {
    const w = await makeWorld(['economy', 'clips'], { guildId: G }).load();
    const clipsCh = w.channel('game-clips'), best = w.channel('best-clips');
    w.mm.setSetting(G, 'clips', 'clipsChannel', clipsCh.id); w.mm.setSetting(G, 'clips', 'bestChannel', best.id); w.mm.setSetting(G, 'clips', 'bestVotes', '2');
    const owner = '900000000000000901';
    const post = { ...MEDAL_POST(owner), channelId: clipsCh.id, reacted: [], react: async (e) => { post.reacted.push(e); } };
    await w.mm.dispatch('messageCreate', G, post);
    assert.deepEqual(post.reacted, ['🔥'], 'Good Boy adds the vote button');
    const eco = w.mm.ctx(G, 'economy');
    assert.equal(eco.sql.get('SELECT coins FROM economy_wallets WHERE guild_id = ? AND user_id = ?', G, owner).coins, 500 + 25, 'coins for sharing');
    const voters = [];
    const react = () => w.mm.dispatch('messageReactionAdd', G, { emoji: { name: '🔥' }, message: post, users: { fetch: async () => { const m = new Map(voters.map((u) => [u.id, u])); m.filter = (fn) => { const o = new Map([...m].filter(([, v]) => fn(v))); return o; }; return m; } } }, voters.at(-1));
    voters.push({ id: 'bot', bot: true }, { id: owner, bot: false }, { id: '900000000000000902', bot: false }); await react();
    assert.equal(best.sent.length, 0, 'bot and owner votes do not count: 1 real vote');
    voters.push({ id: '900000000000000903', bot: false }); await react();
    assert.equal(best.sent.length, 1, 'reposted at 2 votes');
    assert.match(best.sent[0].content, /🔥 \*\*2\*\* · clip by <@900000000000000901> · Powerpoint/);
    assert.match(best.sent[0].content, /https:\/\/medal\.tv\/games\/cs2\/clips\/abc123/, 'the link is in the text so the video plays');
    assert.deepEqual(best.sent[0].allowedMentions, { parse: [] });
    voters.push({ id: '900000000000000904', bot: false }); await react();
    assert.equal(best.sent.length, 1, 'only once');
    // chat in the channel is left alone
    const chat = { id: '700000000000000002', guildId: G, channelId: clipsCh.id, author: { id: '900000000000000902', bot: false }, content: 'no he ran away', embeds: [], react: async () => { throw new Error('should not react'); } };
    await w.mm.dispatch('messageCreate', G, chat);
    // clip of the week: first run starts the clock, the next week pays and announces
    const task = w.mm.active.get(G).get('clips').tasks[0];
    const ctx = w.mm.ctx(G, 'clips');
    ctx.sql.run('UPDATE clips_list SET at = ? WHERE guild_id = ?', Date.now() - 7 * 86400000, G);
    await task.run(ctx); assert.equal(best.sent.length, 1, 'first run only starts the clock');
    ctx.data.set('lastWeek', '2000-01-03');
    const realNow = Date.now; Date.now = () => realNow() ; await task.run(ctx); Date.now = realNow;
    const win = best.sent.at(-1).content;
    assert.match(win, /Clip of the week\*\* goes to <@900000000000000901>/);
    assert.equal(eco.sql.get('SELECT coins FROM economy_wallets WHERE guild_id = ? AND user_id = ?', G, owner).coins, 500 + 25 + 1000, 'weekly prize paid');
    const top = await w.mm.runView(G, 'clips', 'top');
    assert.equal(top.rows[0].votes, 3); assert.equal(top.rows[0].best, '🏆'); assert.equal(top.rows[0].week, '🎬');
  });

  await test('clips: an uploaded video counts (from any clipping app), and Best clips uploads the file again since Discord file links expire', async () => {
    const w = await makeWorld(['clips'], { guildId: G }).load();
    const clipsCh = w.channel('game-clips'), best = w.channel('best-clips');
    w.mm.setSetting(G, 'clips', 'clipsChannel', clipsCh.id); w.mm.setSetting(G, 'clips', 'bestChannel', best.id); w.mm.setSetting(G, 'clips', 'bestVotes', '1');
    const file = { name: 'ace.mp4', contentType: 'video/mp4', size: 3 * 1024 * 1024, url: 'https://cdn.discordapp.com/attachments/1/2/ace.mp4?ex=1' };
    const up = { id: '700000000000000011', guildId: G, channelId: clipsCh.id, author: { id: '900000000000000911', bot: false }, content: 'clutch', embeds: [], attachments: new Map([['a', file]]), react: async () => {} };
    assert.equal(videoOf(up), file);
    assert.ok(isDiscordFile(file.url)); assert.ok(!isDiscordFile('http://169.254.169.254/latest')); assert.ok(!isDiscordFile('https://cdn.discordapp.com.evil.example/x.mp4'));
    assert.deepEqual(clipFrom(up), { userId: '900000000000000911', url: null, title: 'ace.mp4', via: 'upload' });
    assert.equal(clipFrom({ ...up, attachments: new Map([['a', { name: 'meme.png', contentType: 'image/png' }]]) }), null, 'pictures are not clips');
    await w.mm.dispatch('messageCreate', G, up);
    const realFetch = globalThis.fetch; let asked;
    globalThis.fetch = async (url) => { asked = url; return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; };
    try {
      const voters = [{ id: '900000000000000912', bot: false }];
      await w.mm.dispatch('messageReactionAdd', G, { emoji: { name: '🔥' }, message: up, users: { fetch: async () => { const m = new Map(voters.map((u) => [u.id, u])); m.filter = (fn) => new Map([...m].filter(([, v]) => fn(v))); return m; } } }, voters[0]);
    } finally { globalThis.fetch = realFetch; }
    assert.equal(asked, file.url, 'the fresh file link from the message is used');
    assert.equal(best.sent.length, 1);
    assert.equal(best.sent[0].files[0].name, 'ace.mp4');
    assert.match(best.sent[0].content, /clip by <@900000000000000911> · ace\.mp4/);
  });
}
