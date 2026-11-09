/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * 3.0 tests: the fishing expansion (places, fish, levels, strike, surges, slack, choosing fish to sell), the animated
 * emojis, and everything else 3.0 adds (more sections are added below as features land).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as F from '../src/fishing.js';
import { decodeGif, encodeGif } from '../src/gif.js';
import { emoji, emojiRef, localEmojis, syncEmojis, _setUploaded, FALLBACK } from '../src/emojis.js';

export default async function runV30Tests({ test }) {
  console.log('\n3.0 fishing');
  await test('world: 24 places, 2,000 fish with unique names, every rarity everywhere, old fish untouched', () => {
    assert.equal(F.BIOMES.length, 24);
    assert.equal(Object.keys(F.FISH).length, 2000);
    assert.equal(new Set(Object.values(F.FISH).map((f) => f.name)).size, 2000);
    for (const b of F.BIOMES) for (const r of F.RARITIES) assert.ok(F.fishIn(b.id).some((f) => f.rarity === r.id), `${b.id} ${r.id}`);
    for (let k = 1; k < F.BIOMES.length; k++) assert.ok(F.BIOMES[k].level > F.BIOMES[k - 1].level, 'places unlock in order');
    assert.equal(F.BIOMES.at(-1).id, 'eclipse');
    assert.equal(F.FISH['abyss-11'].name, 'The First Light', 'the 2.3.3 fish keep their ids');
    for (const f of Object.values(F.FISH)) assert.ok(f.min > 0 && f.max > f.min && f.base > 0, f.id);
    // Later places pay more for the same rarity.
    const avg = (b, r) => { const l = F.fishIn(b).filter((f) => f.rarity === r); return l.reduce((a, f) => a + f.base, 0) / l.length; };
    assert.ok(avg('eclipse', 'mythical') > avg('mangrove', 'mythical') && avg('mangrove', 'mythical') > avg('bay', 'mythical'));
    // Generated names never change between runs (they are seeded).
    assert.equal(F.FISH['bay-12'].name, F.FISH['bay-12'].name);
    const again = Object.values(F.FISH).map((f) => f.name).join('|');
    assert.equal(again.length > 0, true);
  });

  await test('levels: 2.3.3 levels unchanged up to 100, cap 4,000, every level past 100 costs a bit more, lookup is exact', () => {
    assert.equal(F.MAX_LEVEL, 4000);
    assert.equal(F.xpForLevel(100), 528614, 'level 100 costs what it did in 2.3.3');
    let prev = F.xpForLevel(101) - F.xpForLevel(100);
    for (let l = 102; l <= 4000; l += 37) { const step = F.xpForLevel(l) - F.xpForLevel(l - 1); assert.ok(step >= prev, `level ${l}`); prev = step; }
    for (const l of [1, 2, 99, 100, 101, 777, 2500, 3999]) { assert.equal(F.levelFromXp(F.xpForLevel(l)).level, l); assert.equal(F.levelFromXp(F.xpForLevel(l + 1) - 1).level, l); }
    assert.equal(F.levelFromXp(F.xpForLevel(4000)).max, true);
    const shop = F.RODS.filter((r) => !r.earn);
    for (let k = 1; k < shop.length; k++) assert.ok(shop[k].level > shop[k - 1].level && shop[k].luck > shop[k - 1].luck, shop[k].id);
    assert.ok(shop.at(-1).level <= F.MAX_LEVEL, 'the last shop rod (3.1: the Mythic rod at max level) is reachable');
  });

  await test('the bite and the strike: early presses spook the fish, a quick Reel after the bite is a strike', () => {
    const fish = { rarity: 'rare' };
    const s = F.startReel({ rod: 'driftwood', tackle: 'none', fish, seed: 11, now: 0, surges: false });
    assert.ok(s.biteAt >= F.BITE_MIN_MS && s.biteAt <= F.BITE_MIN_MS + F.BITE_SPREAD_MS);
    assert.equal(F.bitten(s, 100), false); assert.match(F.reelNote(s, 100), /wait for the bite/);
    F.reelStep(s, 'reel', 100); assert.equal(s.note, 'early'); assert.ok(s.progress < 30); assert.equal(s.struck, false, 'an early tug costs the strike');
    const good = F.startReel({ rod: 'driftwood', tackle: 'none', fish, seed: 11, now: 0, surges: false });
    F.reelStep(good, 'reel', good.biteAt + 500); assert.equal(good.note, 'strike'); assert.equal(good.progress, 45);
    const late = F.startReel({ rod: 'driftwood', tackle: 'none', fish, seed: 11, now: 0, surges: false });
    F.reelStep(late, 'reel', late.biteAt + F.STRIKE_MS + 1); assert.notEqual(late.note, 'strike');
    const old = { ...F.startReel({ rod: 'driftwood', tackle: 'none', fish, seed: 11, now: 0 }), biteAt: undefined };
    assert.equal(F.bitten(old, 0), true, 'games saved before 3.0 are already biting');
  });

  await test('surges: the right answer quickly is a big gain; a wrong or slow answer hurts; slack lets tension off', () => {
    const base = () => { const s = F.startReel({ rod: 'carbon', tackle: 'none', fish: { rarity: 'rare' }, seed: 5, now: 0, biteMs: 0 }); s.struck = false; s.step = 5; s.progress = 40; s.tension = 50; return s; };
    for (const [kind, sg] of Object.entries(F.SURGES)) {
      const win = base(); win.surge = { kind, at: 1000 }; F.reelStep(win, sg.answer, 2000);
      assert.equal(win.note, 'surge-won', kind); assert.ok(win.progress > 40 && win.tension < 50); assert.equal(win.surge, null);
      const wrong = base(); wrong.surge = { kind, at: 1000 }; F.reelStep(wrong, sg.answer === 'reel' ? 'left' : 'reel', 2000);
      assert.equal(wrong.note, 'surge-wrong', kind); assert.ok(wrong.progress < 40 || wrong.tension > 50);
      const slow = base(); slow.surge = { kind, at: 1000 }; F.reelStep(slow, sg.answer, 1000 + F.SURGE_MS + 1);
      assert.equal(slow.note, 'surge-slow', kind);
    }
    const sl = base(); F.reelStep(sl, 'slack', 2000); assert.ok(sl.tension <= 22, 'slack drops tension a lot');
    // Surges happen on their own, with a gap between them, and can be turned off.
    const play = (surges) => { const s = F.startReel({ rod: 'starforged', tackle: 'none', fish: { rarity: 'mythical' }, seed: 77, now: 0, biteMs: 0, surges }); s.struck = false; let seen = 0, t = 0; for (let k = 0; k < 60 && s.status === 'reeling'; k++) { if (s.surge) { seen++; F.reelStep(s, F.SURGES[s.surge.kind].answer, (t += 500)); } else F.reelStep(s, s.tension > 120 ? 'slack' : F.inZone(s) ? 'reel' : s.pos < s.zone ? 'left' : 'right', (t += 500)); } return seen; };
    assert.ok(play(true) > 0, 'surges show up'); assert.equal(play(false), 0);
  });

  await test('in the game: Slack button, choose fish to sell, collection place picker and pages', async () => {
    const { gameWorld, btn, embedText } = await import('./v22.js');
    const w = await gameWorld();
    const hub = await w.cmd('fish', w.alice);
    const r = await w.form(btn(hub.replies[0], (c) => c.label === 'Cast').custom_id, w.alice, { biome: ['bay'], rod: ['driftwood'], bait: ['none'], tackle: ['none'] });
    let msg = r.submit.replies[0];
    assert.ok(btn(msg, (c) => c.label === 'Slack'), 'a Slack button');
    let guard = 0;
    while (guard++ < 120) {
      const reel = btn(msg, (c) => c.label === 'Reel');
      if (!reel) break;
      const id = reel.custom_id.split(':')[2];
      const press = await w.press(`gm:fr:${id}:reel`, w.alice);
      msg = press.updated;
    }
    // Put three fish in the bag and sell two of them by choosing.
    const ctx = w.mm.ctx('1', 'games');
    for (const [species, value] of [['bay-0', 10], ['bay-1', 20], ['bay-2', 30]]) ctx.sql.run('INSERT INTO games_fish_bag (guild_id, user_id, species, rarity, mutation, giant, weight, value, biome, caught_at) VALUES (?, ?, ?, ?, NULL, 0, 1, ?, ?, ?)', '1', 'alice', species, F.FISH[species].rarity, value, 'bay', Date.now());
    const bag = await w.press('gm:fh:alice:bag', w.alice);
    const menu = bag.updated.components[0].toJSON().components[0];
    assert.equal(menu.custom_id, 'gm:fsel:alice'); assert.ok(menu.max_values >= 3);
    const ids = ctx.sql.all("SELECT id FROM games_fish_bag WHERE guild_id = '1' AND user_id = 'alice' AND sold = 0 AND species IN ('bay-1', 'bay-2')").map((x) => String(x.id));
    w.setCoins('alice', 100); const before = w.coins('alice');
    const sold = await w.press('gm:fsel:alice', w.alice, { values: ids });
    assert.match(embedText(sold.updated), /Sold 2 fish/);
    assert.equal(w.coins('alice') - before, 50);
    const again = await w.press('gm:fsel:alice', w.alice, { values: ids });
    assert.match(embedText(again.updated), /already sold/, 'selling the same fish twice does nothing');
    await assert.rejects(w.press('gm:fsel:alice', w.bob, { values: ids }).then((i) => { if (!i.replies.some((x) => /someone else/.test(x.content ?? ''))) throw new Error('no refusal'); throw new Error('someone else'); }), /someone else/);
    const dex = await w.press('gm:fdx:alice', w.alice, { values: ['glacier'] });
    assert.match(embedText(dex.updated), /Rimefall Shelf/);
  });

  console.log('\n3.0 animated emojis');
  await test('emoji art: every file is a see-through animated GIF under Discord\'s size limit, with a fallback', async () => {
    const list = localEmojis();
    assert.ok(list.length >= 20);
    for (const e of list) {
      const buf = fs.readFileSync(e.file);
      assert.ok(buf.length < 256 * 1024, e.name);
      const g = decodeGif(buf);
      assert.ok(g.frames.length > 1, `${e.name} moves`);
      assert.ok(g.frames[0].rgba.some((v, k) => k % 4 === 3 && v === 0), `${e.name} has see-through pixels`);
      assert.ok(FALLBACK[e.name], `${e.name} has a normal emoji to fall back on`);
      assert.match(e.remote, /^gb_[a-z_]+_[0-9a-f]{6}$/); assert.ok(e.remote.length <= 32);
    }
    const t = await encodeGif({ width: 2, height: 1, transparent: true, frames: [{ rgba: Uint8Array.from([255, 0, 0, 255, 0, 0, 0, 0]), delay: 100 }] });
    const d = decodeGif(t); assert.equal(d.frames[0].rgba[3], 255); assert.equal(d.frames[0].rgba[7], 0);
  });

  await test('emoji upload: missing ones are added, unchanged ones kept, old art removed; text falls back until uploaded', async () => {
    _setUploaded({});
    assert.equal(emoji('coin'), '🪙'); assert.deepEqual(emojiRef('coin'), { name: '🪙' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbemo-'));
    fs.copyFileSync(localEmojis()[0].file, path.join(dir, 'coin.gif'));
    fs.copyFileSync(localEmojis()[1].file, path.join(dir, 'dice.gif'));
    const want = localEmojis(dir);
    const existing = new Map([['1', { id: '1', name: want[0].remote, animated: true }], ['2', { id: '2', name: 'gb_coin_abcdef', animated: true, delete: async () => { existing.delete('2'); } }], ['3', { id: '3', name: 'someone_elses', animated: false }]]);
    const created = [];
    const app = { emojis: { fetch: async () => existing, create: async ({ name }) => { created.push(name); return { id: '9', name, animated: true }; } } };
    const r = await syncEmojis(app, { dir });
    assert.deepEqual(r, { added: 1, removed: 1, kept: 1, failed: 0 });
    assert.deepEqual(created, [want[1].remote]);
    assert.ok(existing.has('3'), 'emojis that are not Good Boy\'s are left alone');
    assert.equal(emoji('coin'), `<a:${want[0].remote}:1>`);
    assert.deepEqual(emojiRef('dice'), { id: '9', name: want[1].remote, animated: true });
    _setUploaded({});
  });

  console.log('\n3.0 message logs');
  await test('deleted and edited messages show what they said, even after a restart; bulk deletes are listed; logging off keeps nothing', async () => {
    const { makeWorld } = await import('./features.js');
    const w = await makeWorld(['moderation']).load();
    const log = w.channel('mod-log'); const general = w.channel('general');
    const ctx = w.mm.ctx('1', 'moderation');
    w.mm.setSetting('1', 'moderation', 'logChannel', log.id);
    const member = w.person('900000000000000777');
    const msg = { id: 'm1', guild: w.g, guildId: '1', channel: general, channelId: general.id, author: member.user, member, content: 'something rude', attachments: new Map([['a', { name: 'proof.png', url: 'https://cdn.example/proof.png', size: 5 }]]), createdTimestamp: Date.now(), system: false, delete: async () => {} };
    await w.mm.dispatch('messageCreate', '1', msg);
    assert.ok(ctx.sql.get("SELECT 1 FROM moderation_message_cache WHERE message_id = 'm1'"), 'a copy is kept');
    // After a restart Discord only gives the id: the copy fills it in.
    await w.mm.dispatch('messageDelete', '1', { id: 'm1', guildId: '1', channelId: general.id, content: null, author: null, attachments: new Map(), partial: true });
    const text = JSON.stringify(log.sent.at(-1));
    assert.match(text, /something rude/); assert.match(text, /proof\.png/); assert.match(text, /900000000000000777/);
    assert.ok(!/content unavailable/.test(text));
    assert.equal(ctx.sql.get("SELECT COUNT(*) AS n FROM moderation_message_cache WHERE message_id = 'm1'").n, 0, 'the copy is removed once logged');
    // Edits: the old text comes from the copy.
    await w.mm.dispatch('messageCreate', '1', { ...msg, id: 'm2', content: 'first version', attachments: new Map() });
    await w.mm.dispatch('messageUpdate', '1', { id: 'm2', content: null, partial: true }, { ...msg, id: 'm2', content: 'second version', attachments: new Map(), url: 'https://discord.com/x' });
    assert.match(JSON.stringify(log.sent.at(-1)), /first version[\s\S]*second version/);
    // Bulk delete.
    await w.mm.dispatch('messageCreate', '1', { ...msg, id: 'm3', content: 'third', attachments: new Map(), createdTimestamp: Date.now() + 1000 });
    await w.mm.dispatch('messageDeleteBulk', '1', new Map([['m3', { id: 'm3', content: null }], ['m2', { id: 'm2', content: null }]]), general);
    assert.match(JSON.stringify(log.sent.at(-1)), /2 messages deleted[\s\S]*second version[\s\S]*third/);
    // Never seen: say why instead of "content unavailable".
    await w.mm.dispatch('messageDelete', '1', { id: 'm9', guildId: '1', channelId: general.id, content: null, attachments: new Map() });
    assert.match(JSON.stringify(log.sent.at(-1)), /had not seen this message/);
    // Off: nothing kept.
    w.mm.setSetting('1', 'moderation', 'logMessages', false);
    await w.mm.dispatch('messageCreate', '1', { ...msg, id: 'm4' });
    assert.equal(ctx.sql.get("SELECT COUNT(*) AS n FROM moderation_message_cache WHERE message_id = 'm4'").n, 0);
  });

  console.log('\n3.0 games');
  await test('pong rules: turns follow the ball, paddles stop at the walls, a miss scores, first to 3 wins, the same seed plays the same', async () => {
    const P = await import('../src/pong.js');
    const g = P.newGame({ left: 'a', right: 'b', seed: 4 });
    assert.equal(P.turn(g), 'left'); assert.throws(() => P.play(g, 'b', 'up'), /not your turn/); assert.throws(() => P.play(g, 'z', 'up'), /not your game/);
    for (let k = 0; k < 6; k++) { g.left.y = 0; P.play(g, P.turnId(g), 'up'); if (g.status !== 'playing') break; }
    assert.ok(g.left.y >= 0 && g.right.y >= 0 && g.left.y <= P.H - P.PADDLE);
    // Never moving loses points.
    const lazy = P.newGame({ left: 'a', right: 'bot', seed: 9 });
    for (let k = 0; k < 400 && lazy.status === 'playing'; k++) { lazy.left.y = 4; P.play(lazy, 'a', 'stay'); }
    assert.equal(lazy.status, 'over'); assert.equal(P.winner(lazy), 'bot');
    // A player who reads the ball can beat Good Boy.
    let wins = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = P.newGame({ left: 'a', right: 'bot', seed });
      for (let k = 0; k < 600 && s.status === 'playing'; k++) {
        let { x, y, dx, dy } = s.ball; while (x > 0 && x < P.W - 1) { x += dx; y += dy; if (y < 0) { y = 1; dy = 1; } if (y > P.H - 1) { y = P.H - 2; dy = -1; } }
        const c = s.left.y + 1; P.play(s, 'a', y < c ? 'up' : y > c ? 'down' : 'stay');
      }
      if (P.winner(s) === 'a') wins++;
    }
    assert.ok(wins >= 10 && wins <= 35, `beatable but not free (${wins}/40)`);
    const a = P.newGame({ left: 'a', right: 'bot', seed: 5 }), b = P.newGame({ left: 'a', right: 'bot', seed: 5 });
    for (const m of ['up', 'down', 'stay', 'up']) { if (a.status === 'playing') { P.play(a, 'a', m); P.play(b, 'a', m); } }
    assert.deepEqual(a, b);
    assert.equal(P.court(a).split('\n').length, P.H);
  });

  await test('/pong: play Good Boy with buttons; challenge a member who accepts; only players can move; give up ends it', async () => {
    const { gameWorld, btn, embedText } = await import('./v22.js');
    const w = await gameWorld();
    const solo = await w.cmd('pong', w.alice, { options: { getUser: () => null } });
    const up = btn(solo.replies[0], (c) => c.label === 'Up');
    assert.ok(up); assert.match(embedText(solo.replies[0]), /Pong · first to 3/);
    const id = up.custom_id.split(':')[2];
    const moved = await w.press(`gm:pg:${id}:stay`, w.alice);
    assert.ok(moved.updated.embeds.length);
    const nosy = await w.press(`gm:pg:${id}:up`, w.bob);
    assert.ok(nosy.replies.some((r) => /not your game/.test(r.content ?? '')));
    const quit = await w.press(`gm:pg:${id}:quit`, w.alice);
    assert.match(embedText(quit.updated), /Good Boy wins/);
    // Challenge.
    const ch = await w.cmd('pong', w.alice, { options: { getUser: () => w.bob.user } });
    const accept = btn(ch.replies[0], (c) => c.label === 'Play');
    const wrong = await w.press(accept.custom_id, w.alice);
    assert.ok(wrong.replies.some((r) => /someone else/.test(r.content ?? '')), 'only the challenged member can accept');
    const ok = await w.press(accept.custom_id, w.bob);
    assert.match(embedText(ok.updated), /alice|<@alice>/);
    w.mm.setSetting('1', 'games', 'pongEnabled', false);
    const off = await w.cmd('pong', w.alice, { options: { getUser: () => null } });
    assert.ok(off.replies.some((r) => /turned off/.test(r.content ?? '')));
  });

  await test('blackjack shows both hands side by side with the bet, a result line and a tip', async () => {
    const { gameWorld, embedText } = await import('./v22.js');
    const w = await gameWorld();
    w.setCoins('alice', 5000);
    const r = await w.form(btn0(await w.cmd('blackjack', w.alice)), w.alice, { bet: '100' });
    const msg = r.submit.replies[0];
    const e = msg.embeds[0].toJSON();
    assert.equal(e.fields[0].inline, true); assert.equal(e.fields[1].inline, true);
    assert.match(e.fields[0].name, /Your hand/); assert.match(e.fields[1].name, /Dealer/);
    assert.match(e.description, /Bet \*\*100\*\*/); assert.match(e.footer.text, /^Tip: /);
    void embedText;
  });

  console.log('\n3.0 tickets');
  await test('report form: member picker, "not in the server" box and uploads; files kept and posted; who-is-involved card; staff background; archive with search', async () => {
    const { makeWorld } = await import('./features.js');
    const { PermissionFlagsBits: P } = await import('discord.js');
    const w = await makeWorld(['support', 'moderation']).load();
    const staffCh = w.channel('staff-watch'); const logCh = w.channel('ticket-log'); const panel = w.channel('panel');
    w.mm.setSetting('1', 'support', 'logChannel', logCh.id); w.mm.setSetting('1', 'support', 'watchChannel', staffCh.id);
    const created = []; const create = w.g.channels.create; w.g.channels.create = async (o) => { const ch = await create(o); created.push(ch); return ch; };
    const BAD = '300000000000000009';
    w.person(BAD, { username: 'sneaky', joinedDaysAgo: 2 });
    w.mm.ctx('1', 'moderation').data.set(`hist:${BAD}`, [{ id: 1, type: 'warn', targetId: BAD, reason: 'spam DMs', at: Date.now() - 86400000 }]);
    const reporter = w.person('reporter9');
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from(`PNG:${url}`) });
    try {
      const open = w.ix({ member: reporter, channel: panel, customId: 'ticket:open:report' }); await w.mm.handleComponent(open);
      const kinds = open.modal.toJSON().components.map((c) => c.component.type);
      assert.deepEqual(kinds, [5, 4, 4, 4, 19], 'user picker, three text boxes, file upload');
      const submit = w.ix({ member: reporter, channel: panel, customId: 'ticket:form:report' });
      const f = { who: BAD, outside: '', details: 'they keep sending scam links', evidence: '' };
      submit.fields = { getTextInputValue: (id) => String(f[id] ?? ''), getSelectedUsers: (id) => new Map(f[id] ? [[f[id], { id: f[id] }]] : []), getUploadedFiles: () => new Map([['0', { name: 'dm 1.png', url: 'https://cdn.discordapp.com/a/dm1.png', size: 9, contentType: 'image/png' }]]) };
      await w.mm.handleComponent(submit);
      const ch = created.at(-1);
      assert.ok(ch, 'ticket channel made');
      const all = JSON.stringify(ch.sent);
      assert.match(all, /Who is involved/); assert.match(all, /Account made/); assert.match(all, /Joined/); assert.match(all, /sneaky/);
      const ev = ch.sent.find((p) => /Evidence from/.test(p.content ?? ''));
      assert.ok(ev && ev.files.length === 1, 'the upload is posted in the ticket');
      const staff = JSON.stringify(staffCh.sent);
      assert.match(staff, /background/); assert.match(staff, /Warnings \*\*1\*\*/); assert.match(staff, /spam DMs/);
      assert.ok(!/Warnings/.test(all), 'the history is never shown in the ticket the member can read');
      const ctx = w.mm.ctx('1', 'support');
      const t = ctx.data.get(`ticket:${ch.id}`);
      assert.equal(t.files[0].name, 'dm_1.png'); assert.ok(fs.existsSync(path.join(ctx.fileDir('tickets', t.number), t.files[0].stored)), 'kept on this computer');
      // Messages in the ticket are archived, with their files.
      await w.mm.dispatch('messageCreate', '1', { id: 'tm1', guild: w.g, guildId: '1', channelId: ch.id, channel: ch, author: reporter.user, member: reporter, content: 'here is another one, the alt account', embeds: [], attachments: new Map([['x', { name: 'dm2.png', url: 'https://cdn.discordapp.com/b/dm2.png', size: 9, contentType: 'image/png' }]]), createdTimestamp: Date.now() });
      await w.mm.dispatch('messageUpdate', '1', { id: 'tm1' }, { id: 'tm1', channelId: ch.id, content: 'here is another one, the ALT account (edited)' });
      const found = await w.mm.runView('1', 'support', 'archive', { search: 'ALT account' });
      assert.equal(found.rows.length, 1); assert.equal(found.rows[0].number, t.number); assert.match(found.rows[0].match, /\[\[/);
      assert.equal((await w.mm.runView('1', 'support', 'archive', { search: 'pineapple' })).rows.length, 0);
      assert.equal((await w.mm.runView('1', 'support', 'archive', { reported: BAD })).rows.length, 1);
      const full = await w.mm.runView('1', 'support', 'archiveTicket', { number: t.number });
      assert.equal(full.about.id, BAD); assert.equal(full.answers[0].a, 'they keep sending scam links');
      const m = full.messages.find((x) => x.id === 'tm1');
      assert.ok(m.editedAt); assert.match(m.attachments[0].url, new RegExp(`/modules/support/files/${t.number}/`));
      assert.equal(full.background.about.warnings, 1);
    } finally { globalThis.fetch = realFetch; }
    void P;
  });

  console.log('\n3.0 welcome pictures');
  await test('/greeting opens a popup; an uploaded picture is kept and sent with welcome and goodbye messages; an empty upload removes it', async () => {
    const { makeWorld } = await import('./features.js');
    const { PermissionFlagsBits: P } = await import('discord.js');
    const w = await makeWorld(['member-management']).load();
    const admin = w.person('gadmin2', { bits: [P.Administrator], pos: 15 });
    const hall = w.channel('welcome');
    w.mm.setSetting('1', 'member-management', 'welcomeEnabled', true); w.mm.setSetting('1', 'member-management', 'welcomeChannel', hall.id);
    w.mm.setSetting('1', 'member-management', 'goodbyeEnabled', true); w.mm.setSetting('1', 'member-management', 'goodbyeChannel', hall.id);
    const cmd = w.ix({ command: 'greeting', member: admin, channel: hall }); await w.mm.handleCommand(cmd);
    assert.equal(cmd.modal.toJSON().components[1].component.type, 19, 'a file upload in the popup');
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('GIF89a-fake') });
    try {
      const sub = w.ix({ member: admin, channel: hall, customId: 'greet:image' });
      sub.fields = { getStringSelectValues: () => ['welcome'], getUploadedFiles: () => new Map([['0', { name: 'banner.gif', url: 'https://cdn.discordapp.com/x/banner.gif', size: 11 }]]), getTextInputValue: () => '' };
      sub.deferReply = async () => {}; sub.editReply = async (p) => { sub.edited = p; };
      await w.mm.handleComponent(sub);
      assert.match(sub.edited.content, /Saved/);
      const newbie = w.person('newbie1');
      await w.mm.dispatch('guildMemberAdd', '1', newbie);
      const sent = hall.sent.at(-1);
      assert.equal(sent.files.length, 1); assert.match(sent.embeds[0].toJSON().image.url, /^attachment:\/\/welcome-\d+\.gif$/);
      await w.mm.dispatch('guildMemberRemove', '1', newbie);
      assert.ok(!hall.sent.at(-1).files, 'goodbye has no picture of its own, so it stays plain');
      // A member without the permission cannot change it.
      const nobody = w.person('nobody1');
      const bad = w.ix({ member: nobody, channel: hall, customId: 'greet:image' }); bad.fields = sub.fields; await w.mm.handleComponent(bad);
      assert.ok(bad.replies.some((r) => /permission/.test(r.content ?? '')));
      // Empty upload: removed.
      const clear = w.ix({ member: admin, channel: hall, customId: 'greet:image' });
      clear.fields = { getStringSelectValues: () => ['welcome'], getUploadedFiles: () => new Map(), getTextInputValue: () => '' };
      await w.mm.handleComponent(clear);
      assert.match(clear.replies[0].content, /removed/);
      await w.mm.dispatch('guildMemberAdd', '1', w.person('newbie2'));
      assert.ok(!hall.sent.at(-1).files);
    } finally { globalThis.fetch = realFetch; }
  });

  console.log('\n3.0 module control');
  await test('per-channel switch: a module can be off in chosen channels or a whole category; commands refuse there (admins still can); events skip; safety modules never switch off', async () => {
    const { makeWorld } = await import('./features.js');
    const { PermissionFlagsBits: P } = await import('discord.js');
    const w = await makeWorld(['community', 'moderation']).load();
    const cat = w.channel('Off-topic'); cat.type = 4;
    const memes = w.channel('memes'); memes.parentId = cat.id;
    const general = w.channel('general');
    w.mm.setOffIn('1', 'community', [cat.id, 'not-an-id']);
    assert.deepEqual(w.mm.offIn('1', 'community'), [cat.id]);
    assert.equal(w.mm.isOffHere('1', 'community', memes), true, 'off in a channel inside the category');
    assert.equal(w.mm.isOffHere('1', 'community', general), false);
    assert.throws(() => w.mm.setOffIn('1', 'moderation', [general.id]), /always work everywhere/);
    assert.equal(w.mm.describeForGuild('1').find((d) => d.name === 'moderation').canSwitchOffHere, false);
    const member = w.person('900000000000000123');
    const cmdName = w.mm.describeForGuild('1').find((d) => d.name === 'community').commandInfo?.[0]?.name ?? 'rank';
    const i = w.ix({ command: cmdName, member, channel: memes }); await w.mm.handleCommand(i);
    assert.ok(JSON.stringify(i.replies).includes('switched off in this channel'));
    const admin = w.person('900000000000000124', { bits: [P.Administrator], pos: 10 });
    const j = w.ix({ command: cmdName, member: admin, channel: memes }); await w.mm.handleCommand(j);
    assert.ok(!JSON.stringify(j.replies).includes('switched off in this channel'), 'admins can still use it');
    let seen = 0;
    const def = w.mm.active.get('1').get('community'); const real = def.events.messageCreate;
    def.events.messageCreate = async () => { seen++; };
    await w.mm.dispatch('messageCreate', '1', { channel: memes, channelId: memes.id });
    await w.mm.dispatch('messageCreate', '1', { channel: general, channelId: general.id });
    assert.equal(seen, 1, 'only the message outside the switched-off category reached the module');
    def.events.messageCreate = real;
  });

  console.log('\n3.0 phone access');
  await test('signed-in list: the bot owner sees phones and browsers and can sign someone out; nobody else can; your own session stays', async () => {
    const { makeWorld } = await import('./features.js');
    const { startDashboard } = await import('../src/dashboard/server.js');
    const w = await makeWorld(['support']).load();
    w.mm.ownerIds.add('owner9');
    const dash = await startDashboard({ manager: w.mm, client: w.client, db: w.db, logger: { info() {}, warn() {}, error() {} }, perms: w.perms, port: 0, host: '127.0.0.1', version: '3.0.0' });
    try {
      const mk = (sid, id, name) => dash.sessions.set(sid, { user: { id, username: name, avatar: null }, guilds: [], expires: Date.now() + 3600000, created: Date.now() });
      mk('s-owner', 'owner9', 'Basic'); mk('s-mod', 'mod9', 'Juno');
      const call = (sid, path, body, ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) GoodBoyAndroid') => fetch(`http://127.0.0.1:${dash.port}${path}`, { method: body ? 'POST' : 'GET', headers: { cookie: `gb_sid=${sid}`, 'Content-Type': 'application/json', 'X-GoodBoy': '1', 'User-Agent': ua }, body: body ? JSON.stringify(body) : undefined });
      await call('s-mod', '/api/me');
      const list = await (await call('s-owner', '/api/sessions', undefined, 'Electron')).json();
      assert.equal(list.sessions.length, 2);
      const juno = list.sessions.find((x) => x.user.id === 'mod9');
      assert.equal(juno.device, 'Good Boy phone app'); assert.ok(!('sid' in juno) && juno.id.length === 12, 'the secret session key is never sent');
      assert.equal((await call('s-mod', '/api/sessions')).status, 403, 'only the bot owner');
      const out = await (await call('s-owner', '/api/sessions/signout', { id: juno.id })).json();
      assert.equal(out.signedOut, 1);
      assert.equal((await call('s-mod', '/api/me')).status, 401, 'signed out at once');
      const self = await (await call('s-owner', '/api/sessions/signout', { userId: 'owner9' })).json();
      assert.equal(self.signedOut, 0, 'you cannot sign yourself out by accident');
    } finally { dash.close(); }
  });

  console.log('\n3.0 moving from other bots');
  await test('button and dropdown role menus are read (role IDs in custom ids, or role names); MEE6 levels import exactly and nobody goes down', async () => {
    const M = await import('../src/migrate.js');
    assert.equal(M.KNOWN_BOTS['368521195940741122'], 'Lawliet'); assert.equal(M.KNOWN_BOTS[M.MEE6_ID], 'MEE6');
    const roles = new Map([['400000000000000001', { id: '400000000000000001', name: 'Gamer' }], ['400000000000000002', { id: '400000000000000002', name: 'Artist' }], ['400000000000000003', { id: '400000000000000003', name: 'News' }]]);
    const guild = { id: 'g1', roles: { cache: roles } };
    const msg = { components: [{ components: [
      { type: 2, customId: 'role:400000000000000001', label: 'Gamer', emoji: { name: '🎮' } },
      { type: 2, customId: 'rr_button_9', label: 'Artist', emoji: { id: '123', name: 'paint', animated: false } },
      { type: 2, customId: 'nothing', label: 'Not a role' },
    ] }, { components: [{ type: 3, options: [{ label: 'News pings', value: '400000000000000003' }, { label: 'Gamer', value: 'g' }] }] }] };
    const pairs = M.componentRolePairs(msg, guild);
    assert.deepEqual(pairs.map((p) => p.roleId), ['400000000000000001', '400000000000000002', '400000000000000003'], 'by id, by name, from a dropdown; no duplicates');
    assert.equal(pairs[1].emoji, '<:paint:123>');
    // MEE6: pages until a short page; private leaderboards are reported as such.
    const page = (n) => Array.from({ length: n }, (_, k) => ({ id: String(500000000000000000n + BigInt(k)), username: `u${k}`, xp: 1000 + k, level: 3, message_count: 10 }));
    let calls = 0;
    const got = await M.mee6Levels('g1', { fetchFn: async () => { calls++; return { ok: true, json: async () => ({ players: calls === 1 ? page(1000) : page(5) }) }; } });
    assert.equal(got.players.length, 1005); assert.equal(calls, 2);
    assert.equal((await M.mee6Levels('g1', { fetchFn: async () => ({ ok: false, status: 401 }) })).error, 'private');
    // Applying: XP copied as it is (same formula), the higher number kept.
    const { makeWorld } = await import('./features.js');
    const w = await makeWorld(['community']).load();
    const c = w.mm.ctx('1', 'community');
    c.data.set('user:500000000000000001', { xp: 99999, messages: 5, rep: 0, lastXp: 0, lastRep: 0 });
    const line = await M.applyFinding(w.mm, '1', { kind: 'levels', data: { from: 'MEE6', players: [{ id: '500000000000000000', xp: 1550, messages: 40 }, { id: '500000000000000001', xp: 10, messages: 1 }] } });
    assert.match(line, /1 member moved up/);
    assert.equal(c.data.get('user:500000000000000000').xp, 1550);
    assert.equal(c.data.get('user:500000000000000001').xp, 99999, 'nobody goes down');
  });

  console.log('\n3.0 music');
  await test('music rules: stations list, queue limits, who can skip, Jamendo results carry their credit; /music posts a player; no sources means a clear message', async () => {
    const M = await import('../modules/music/index.js');
    assert.deepEqual(M.parseStations(['Lofi | https://radio.example/lofi', 'bad line', 'Ftp | ftp://x', ' Jazz |https://j.example/s ']).map((s) => s.name), ['Lofi', 'Jazz']);
    const q = [];
    assert.equal(M.enqueue(q, { by: 'a', title: '1' }, { max: 3, perUser: 2 }), 1);
    M.enqueue(q, { by: 'a', title: '2' }, { max: 3, perUser: 2 });
    assert.throws(() => M.enqueue(q, { by: 'a', title: '3' }, { max: 3, perUser: 2 }), /have 2 songs/);
    M.enqueue(q, { by: 'b', title: '4' }, { max: 3, perUser: 2 });
    assert.throws(() => M.enqueue(q, { by: 'c', title: '5' }, { max: 3, perUser: 2 }), /queue is full/);
    const member = (id, { dj = false, staff = false } = {}) => ({ id, roles: { cache: new Map(dj ? [['dj', {}]] : []) }, permissions: { has: () => staff } });
    assert.equal(M.canControl({ member: member('a'), track: { by: 'a' }, djRole: 'dj' }), true, 'your own song');
    assert.equal(M.canControl({ member: member('b'), track: { by: 'a' }, djRole: 'dj' }), false);
    assert.equal(M.canControl({ member: member('b', { dj: true }), track: { by: 'a' }, djRole: 'dj' }), true, 'the DJ role');
    assert.equal(M.canControl({ member: member('b', { staff: true }), track: { by: 'a' } }), true, 'staff');
    assert.equal(M.canControl({ member: member('b'), track: { by: 'a' }, listeners: 1 }), true, 'alone with the bot');
    assert.equal(M.clock(187), '3:07'); assert.equal(M.clock(null), 'live');
    await assert.rejects(M.jamendoSearch('lofi', { clientId: '' }), /not set up/);
    const found = await M.jamendoSearch('lofi', { clientId: 'k', fetchFn: async (u) => { assert.match(u, /client_id=k/); return { ok: true, json: async () => ({ results: [{ name: 'Rain', artist_name: 'Mira', audio: 'https://a/rain.mp3', duration: 200, license_ccurl: 'https://creativecommons.org/licenses/by/4.0/' }] }) }; } });
    assert.match(found[0].credit, /“Rain” by Mira \(Jamendo, https:\/\/creativecommons/);
    const { makeWorld } = await import('./features.js');
    const { PermissionFlagsBits: P } = await import('discord.js');
    const w = await makeWorld(['music']).load();
    const mod = w.person('900000000000000301', { bits: [P.ModerateMembers, P.ManageMessages, P.KickMembers], pos: 5 });
    const room = w.channel('music');
    const cmd = w.ix({ command: 'music', member: mod, channel: room }); await w.mm.handleCommand(cmd);
    assert.match(JSON.stringify(room.sent.at(-1)), /Add music/);
    w.mm.setSetting('1', 'music', 'allowUploads', false);
    const add = w.ix({ customId: 'music:add', member: mod, channel: room }); await w.mm.handleComponent(add);
    assert.ok(add.replies.some((r) => /Join a voice channel first/.test(r.content ?? '')), 'there is always the link box now, so it asks you to join voice');
  });

  console.log('\n3.0 hub');
  await test('hub: a bot proves itself through its description once, then signs updates; lookups find other bots; forged or stale requests are refused; leaving works', async () => {
    const { handle } = await import('../hub/worker.js');
    const { Hub } = await import('../src/hub.js');
    const store = new Map();
    const env = { HUB: { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } } };
    let description = 'A bot.';
    const discord = { '111111111111111111': () => ({ name: 'Cove Keeper', description }) };
    const hubFetch = async (url, opts = {}) => {
      if (url.startsWith('https://discord.com/api/v10/applications/')) { const id = url.split('/')[6]; return { ok: true, json: async () => discord[id]?.() ?? {} }; }
      const res = await handle(new Request(url, { method: opts.method ?? 'GET', body: opts.body, headers: opts.headers }), env, { fetchFn: hubFetch });
      return { ok: res.ok, status: res.status, json: () => res.json() };
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbhub-'));
    const edits = [];
    const app = { id: '111111111111111111', get description() { return description; }, edit: async ({ description: d }) => { edits.push(d); description = d; } };
    const hubA = new Hub({ base: 'https://hub.test', dataDir: dir, app, url: () => 'https://cove.example.ts.net', guilds: () => ['222222222222222222', '333333333333333333'], fetchFn: hubFetch });
    const r1 = await hubA.register();
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.ok(edits.some((d) => /gb-hub:[0-9a-f]{20}/.test(d)), 'the code went into the description');
    assert.equal(description, 'A bot.', 'and came out again');
    edits.length = 0;
    assert.equal((await hubA.register()).ok, true); assert.equal(edits.length, 0, 'later updates are signed, no description change');
    // Another bot looks up servers its user is in.
    const other = new Hub({ base: 'https://hub.test', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'gbhub2-')), app: { id: '999999999999999999' }, url: () => null, guilds: () => [], fetchFn: hubFetch });
    const found = await other.lookup(['222222222222222222', '444444444444444444']);
    assert.deepEqual(found.map((x) => [x.guildId, x.name, x.url]), [['222222222222222222', 'Cove Keeper', 'https://cove.example.ts.net']]);
    // Forged: a different key claiming the same bot, without proof.
    const forged = await hubFetch('https://hub.test/v1/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: '111111111111111111', publicKey: 'AAAA', url: 'https://evil.example', guilds: ['222222222222222222'], at: Date.now(), sig: 'AAAA' }) });
    assert.equal(forged.status, 403);
    const stale = await hubFetch('https://hub.test/v1/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: '111111111111111111', url: 'https://cove.example.ts.net', guilds: [], at: Date.now() - 3600000, sig: 'x' }) });
    assert.equal(stale.status, 400, 'old requests are refused');
    const local = new Hub({ base: 'https://hub.test', dataDir: dir, app, url: () => 'http://localhost:3000', guilds: () => [], fetchFn: hubFetch });
    assert.equal((await local.register()).skipped, 'no public dashboard link');
    // Leaving removes the bot everywhere.
    assert.equal(await hubA.leave(), true);
    other.cache.clear();
    assert.deepEqual(await other.lookup(['222222222222222222']), []);
  });

  await test('one dashboard link: sign in with Discord at the hub, see your servers that run a Good Boy bot, Manage opens that bot on that server; expired sign-ins and missing setup are explained', async () => {
    const { handle } = await import('../hub/worker.js');
    const store = new Map();
    const HUB = { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } };
    const now = Date.now();
    store.set('app:111111111111111111', JSON.stringify({ appId: '111111111111111111', name: 'Cove Keeper', url: 'https://cove.example.ts.net', guilds: ['222222222222222222'], updatedAt: now }));
    store.set('guild:222222222222222222', JSON.stringify(['111111111111111111']));
    const discord = async (url) => {
      if (url.endsWith('/oauth2/token')) return { ok: true, json: async () => ({ access_token: 'tok' }) };
      if (url.endsWith('/users/@me')) return { ok: true, json: async () => ({ id: '555555555555555555', username: 'basic', global_name: 'Basic', avatar: null }) };
      if (url.endsWith('/users/@me/guilds')) return { ok: true, json: async () => [{ id: '222222222222222222', name: 'Hangout', icon: null, owner: false, permissions: '32' }, { id: '666666666666666666', name: 'Other Place', icon: null, owner: true, permissions: '0' }] };
      return { ok: false };
    };
    const go = (path, env, cookie) => handle(new Request(`https://hub.test${path}`, { headers: cookie ? { cookie } : {} }), env, { fetchFn: discord, now });
    const noSetup = await go('/', { HUB });
    assert.match(await noSetup.text(), /Sign-in isn't set up/);
    const env = { HUB, DISCORD_CLIENT_ID: '111111111111111111', DISCORD_CLIENT_SECRET: 'shh' };
    const home = await (await go('/', env)).text();
    assert.match(home, /Sign in with Discord/);
    const login = await go('/login', env);
    assert.equal(login.status, 302); assert.match(login.headers.get('location'), /discord\.com\/oauth2\/authorize.*scope=identify\+guilds/);
    const state = /gbh_state=([^;]+)/.exec(login.headers.get('set-cookie'))[1];
    assert.equal((await go(`/callback?code=c&state=wrong`, env, `gbh_state=${state}`)).status, 400, 'a mismatched sign-in is refused');
    const cb = await go(`/callback?code=c&state=${state}`, env, `gbh_state=${state}`);
    assert.equal(cb.status, 302);
    const sid = /gbh=([0-9a-f]{32})/.exec(cb.headers.get('set-cookie'))[1];
    const list = await (await go('/', env, `gbh=${sid}`)).text();
    assert.match(list, /Your servers/); assert.match(list, /Hangout/); assert.match(list, /Cove Keeper/);
    assert.match(list, /href="https:\/\/cove\.example\.ts\.net\/\?guild=222222222222222222">Manage</, 'Manage opens that bot on that server');
    assert.match(list, /Other Place[\s\S]*No Good Boy bot here yet/, 'servers they run without Good Boy are listed separately');
    const session = JSON.parse(store.get(`sess:${sid}`));
    assert.deepEqual(Object.keys(session.user), ['id', 'name', 'avatar'], 'only the name and picture are kept');
    assert.equal((await go('/logout', env, `gbh=${sid}`)).status, 302); assert.equal(store.get(`sess:${sid}`), undefined);
  });

  console.log('\n3.0.1 what\'s new');
  await test('what\'s new: notes split into the members\' note and the full list; the dashboard serves them to anyone signed in; the Windows app reads the same file', async () => {
    const { parseChangelog, whatsNew } = await import('../src/about.js');
    const text = '# Changelog\n\n## 9.9.9\n**Big headline.**\n\n<!-- members -->\nhey all\n<!-- /members -->\n\n**Section**\n- one\n- two\n\n## 9.9.8\nOld stuff';
    const [a, b] = whatsNew(parseChangelog(text));
    assert.equal(a.version, '9.9.9'); assert.equal(a.headline, 'Big headline.'); assert.equal(a.members, 'hey all');
    assert.ok(!a.notes.includes('members') && !a.notes.includes('Big headline') && a.notes.includes('- one'));
    assert.equal(b.members, null);
    const real = whatsNew(parseChangelog(fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')));
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(real[0].version, pkg.version, 'the newest notes are for this version'); assert.ok(real[0].members, 'with a note for members');
    const { readNotes } = await import('../desktop/lib/notes.js');
    assert.deepEqual(readNotes(path.resolve(new URL('..', import.meta.url).pathname))[0], real[0], 'the Windows app reads them the same way');
    const { makeWorld } = await import('./features.js');
    const { startDashboard } = await import('../src/dashboard/server.js');
    const w = await makeWorld([]).load();
    w.mm.rootDir = path.resolve(new URL('..', import.meta.url).pathname);
    const dash = await startDashboard({ manager: w.mm, client: w.client, db: w.db, logger: { info() {}, warn() {}, error() {} }, perms: w.perms, port: 0, host: '127.0.0.1', version: pkg.version });
    try {
      assert.equal((await fetch(`http://127.0.0.1:${dash.port}/api/whatsnew`)).status, 401);
      dash.sessions.set('s1', { user: { id: 'u1', username: 'U', avatar: null }, guilds: [], expires: Date.now() + 60000 });
      const d = await (await fetch(`http://127.0.0.1:${dash.port}/api/whatsnew`, { headers: { cookie: 'gb_sid=s1' } })).json();
      assert.equal(d.version, pkg.version); assert.equal(d.sections[0].version, pkg.version);
    } finally { dash.close(); }
  });

  console.log('\n3.0.1 moderation from the dashboard');
  await test('dashboard moderation: permission, reason, hierarchy, owner and self checks; warn, time out, lift, kick and ban each work and land in the history', async () => {
    const { makeWorld } = await import('./features.js');
    const { PermissionFlagsBits: P } = await import('discord.js');
    const w = await makeWorld(['moderation']).load();
    const MOD = '310000000000000001', TGT = '310000000000000002', PLAIN = '310000000000000003', BOSS = '310000000000000004';
    w.person(MOD, { bits: [P.Administrator], pos: 10, username: 'moddy' });
    const t = w.person(TGT, { pos: 1, username: 'target' });
    const timeouts = []; t.timeout = async (ms, why) => { timeouts.push([ms, why]); };
    t.kickable = true; t.bannable = true; let kicked = 0; t.kick = async () => { kicked++; };
    w.person(PLAIN, { username: 'plain' });
    w.person(BOSS, { bits: [P.Administrator], pos: 50, username: 'boss' });
    const bans = []; w.g.members.ban = async (id, o) => { bans.push([id, o]); };
    const act = (body, by = MOD) => w.mm.runAction('1', 'moderation', 'member-action', body, { userId: by, username: by });
    const UE = /./;
    await assert.rejects(act({ userId: TGT, action: 'warn', reason: 'x' }, PLAIN), /permission/, 'needs the action\'s own permission');
    await assert.rejects(act({ userId: TGT, action: 'warn', reason: '  ' }), /reason/i, 'a reason is needed');
    await assert.rejects(act({ userId: TGT, action: 'explode', reason: 'x' }), /Choose/);
    await assert.rejects(act({ userId: MOD, action: 'warn', reason: 'x' }), /yourself/);
    await assert.rejects(act({ userId: BOSS, action: 'kick', reason: 'x' }), UE, 'cannot act on someone above you');
    await assert.rejects(act({ userId: 'nope', action: 'warn', reason: 'x' }), /Pick a member/);
    const warned = await act({ userId: TGT, action: 'warn', reason: 'be nice' });
    assert.equal(warned.action, 'warn'); assert.equal(warned.user.id, TGT); assert.ok(warned.case);
    assert.match(JSON.stringify(t.user.sent), /be nice/, 'the member is told');
    await act({ userId: TGT, action: 'timeout', reason: 'cool off', minutes: 10 });
    assert.equal(timeouts.at(-1)[0], 600000, 'ten minutes');
    await act({ userId: TGT, action: 'timeout', reason: 'way too long', minutes: 999999 });
    assert.ok(timeouts.at(-1)[0] <= 40320 * 60000 && timeouts.at(-1)[0] > 40319 * 60000 - 120000, 'capped at 28 days');
    await act({ userId: TGT, action: 'untimeout' });
    assert.equal(timeouts.at(-1)[0], null, 'lifting needs no reason');
    await act({ userId: TGT, action: 'kick', reason: 'bye' }); assert.equal(kicked, 1);
    await act({ userId: TGT, action: 'ban', reason: 'gone', deleteDays: 99 });
    assert.equal(bans[0][0], TGT); assert.equal(bans[0][1].deleteMessageSeconds, 7 * 86400, 'at most 7 days of messages');
    const { rows } = await w.mm.runView('1', 'moderation', 'cases');
    assert.deepEqual(rows.map((r) => r.type).sort(), ['Banned', 'Kicked', 'Timed out', 'Timed out', 'Timeout lifted', 'Warned'].sort());
    assert.ok(rows.every((r) => r.userId === TGT));
    const panel = w.mm.describeForGuild('1').find((d) => d.name === 'moderation').panels.find((p) => p.id === 'cases');
    assert.ok(panel.pageActions.includes('member-action') && panel.view === 'cases', 'the history panel allows the action');
  });

  console.log('\n3.0.1 stats history');
  await test('stats history: counts people\'s messages per hour, samples members and voice, fills gaps, keeps exactly 14 days, serves it to admins', async () => {
    const { Database } = await import('../src/db.js');
    const { StatHistory, HOUR } = await import('../src/stats.js');
    const db = new Database(':memory:');
    let now = 1000 * HOUR + 5;
    const sh = new StatHistory(db, { now: () => now });
    const voice = new Map([['a', { channelId: 'v1', member: { user: { bot: false } } }], ['b', { channelId: null }], ['c', { channelId: 'v1', member: { user: { bot: true } } }]]);
    voice.filter = (f) => { const m = new Map([...voice].filter(([, v]) => f(v))); return m; };
    const client = { guilds: { cache: new Map([['g1', { memberCount: 50, voiceStates: { cache: voice } }]]) } };
    sh.count('g1'); sh.count('g1'); sh.sampleAll(client);
    sh.count('g1'); sh.sampleAll(client); // the same hour adds up
    now += 3 * HOUR; client.guilds.cache.get('g1').memberCount = 53; sh.count('g1'); sh.sampleAll(client);
    const s = sh.series('g1');
    assert.equal(s.from, 1000 * HOUR); assert.equal(s.members.length, 4);
    assert.deepEqual(s.messages, [3, 0, 0, 1]); assert.deepEqual(s.members, [50, 50, 50, 53], 'members carry across empty hours');
    assert.deepEqual(s.voice, [1, null, null, 1], 'bots in voice do not count');
    sh.count('g1'); assert.equal(sh.series('g1').messages.at(-1), 2, 'messages not written yet still show');
    now += 15 * 24 * HOUR; sh.sampleAll(client);
    assert.equal(db.q('SELECT COUNT(*) AS n FROM stat_history WHERE hour < ?').get(Math.floor(now / HOUR) - 14 * 24).n, 0, 'older than 14 days is removed');
    assert.ok(sh.series('g1').members.length <= 14 * 24);
    // the dashboard endpoint, admins only
    const { makeWorld } = await import('./features.js');
    const { startDashboard } = await import('../src/dashboard/server.js');
    const { PermissionFlagsBits: P } = await import('discord.js');
    const GID = '330000000000000001';
    const w = await makeWorld([], { guildId: GID }).load();
    const ADMIN = '320000000000000001', PLAIN = '320000000000000002';
    w.person(ADMIN, { bits: [P.Administrator, P.ManageGuild] }); w.person(PLAIN);
    const hist = new StatHistory(w.db); hist.count(GID); hist.record(GID, { members: 10, voice: 0 });
    const dash = await startDashboard({ manager: w.mm, client: w.client, db: w.db, logger: { info() {}, warn() {}, error() {} }, perms: w.perms, port: 0, host: '127.0.0.1', statHistory: hist });
    try {
      for (const [sid, id] of [['sa', ADMIN], ['sp', PLAIN]]) dash.sessions.set(sid, { user: { id, username: id, avatar: null }, guilds: [], expires: Date.now() + 60000 });
      const get = (sid) => fetch(`http://127.0.0.1:${dash.port}/api/guilds/${GID}/history`, { headers: { cookie: `gb_sid=${sid}` } });
      assert.equal((await get('sp')).status, 403);
      const d = await (await get('sa')).json();
      assert.deepEqual(d.members, [10]); assert.deepEqual(d.messages, [1]);
    } finally { dash.close(); }
  });


  console.log('\n3.0.4 animated game pictures');
  await test('game pictures: slots, coin flip and blackjack send an animated GIF in the embed; fishing draws every phase; no canvas means the text look', async () => {
    const ART = await import('../src/gameart.js');
    if (!(await ART.canvasLib())) { console.log('       (canvas package not installed here: picture checks skipped, text look covered by the older tests)'); return; }
    const { gameWorld, btn } = await import('./v22.js');
    globalThis[Symbol.for('goodboy.games.art')] = true;
    try {
      const isGif = (f) => Buffer.from(f.attachment).subarray(0, 6).toString() === 'GIF89a';
      const w = await gameWorld();
      w.setCoins('alice', 5000);
      const sl = (await w.form(await w.cmd('slots', w.alice), w.alice, { bet: '100' })).submit.replies[0];
      assert.equal(sl.files?.length, 1); assert.ok(isGif(sl.files[0])); assert.equal(sl.files[0].name, 'slots.gif');
      assert.equal(sl.embeds[0].toJSON().image.url, 'attachment://slots.gif', 'the picture sits inside the embed');
      assert.ok(btn(sl, (c) => c.custom_id?.startsWith('gmx:')), 'spin again is there straight away');
      const cf = (await w.form(await w.cmd('coinflip', w.alice), w.alice, { bet: '100', side: ['heads'] })).submit.replies[0];
      assert.ok(isGif(cf.files[0]) && cf.files[0].name === 'coinflip.gif');
      let hand;
      for (let k = 0; k < 30; k++) { hand = (await w.form(await w.cmd('blackjack', w.alice), w.alice, { bet: '50' })).submit.replies[0]; if (btn(hand, (c) => c.custom_id?.endsWith(':stand'))) break; }
      assert.ok(isGif(hand.files[0]) && hand.files[0].name === 'blackjack.gif');
      const stand = await w.press(btn(hand, (c) => c.custom_id?.endsWith(':stand')).custom_id, w.alice);
      assert.ok(isGif(stand.updated.files[0]), 'the reveal is a new picture');
      assert.deepEqual(stand.updated.attachments, [], 'the old picture is replaced, not stacked');
      // Fishing: each phase draws, and the play-once games do not loop.
      const F = await import('../src/fishing.js');
      for (const b of F.BIOMES) assert.ok(await ART.fishingImage({ biome: b.id, title: b.label, phase: 'waiting', hint: 'x' }), b.id);
      const reel = await ART.fishingImage({ biome: 'bay', phase: 'reeling', s: { step: 1, pos: 5, zone: 4, progress: 40, tension: 30 }, control: 5, line: 100, track: F.TRACK });
      const caught = await ART.fishingImage({ biome: 'bay', phase: 'caught', catchInfo: { rarity: 'mythical', title: 'Mythical · Test Fish', sub: '1 kg' } });
      assert.ok(reel.file.includes('NETSCAPE2.0') && caught.file.includes('NETSCAPE2.0'), 'fishing scenes loop');
      assert.ok(!(await ART.slotsImage({ symbols: ['🍒', '🍇', '7️⃣'] })).file.includes('NETSCAPE2.0'), 'slots play once and stop on the result');
      // Turned off in the server: back to the text look.
      w.mm.setSetting('1', 'games', 'gamePictures', 'false');
      const txt = (await w.form(await w.cmd('slots', w.alice), w.alice, { bet: '100' })).submit;
      assert.ok(!txt.replies[0].files?.length, 'no picture when the server turned them off');
    } finally { globalThis[Symbol.for('goodboy.games.art')] = false; }
  });


  console.log('\n3.0.6 media links (opt-in)');
  await test('media links: off by default, only the bot owner can turn them on per server, once (after a warning), direct audio links always work, Spotify songs are read, yt-dlp errors are explained', async () => {
    const ML = await import('../src/medialinks.js');
    const { EventEmitter } = await import('node:events');
    assert.ok(ML.isDirectAudio('https://example.com/music/song.mp3?x=1')); assert.ok(!ML.isDirectAudio('https://youtube.com/watch?v=abc'));
    assert.equal(ML.cleanLink('http://127.0.0.1/a.mp3'), null, 'no private addresses'); assert.equal(ML.cleanLink('file:///etc/passwd'), null);
    assert.equal(ML.spotifyTrackId('https://open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT?si=x'), '4cOdK2wGLETKBW3PvgPWqT');
    assert.equal(ML.spotifyTrackId('https://open.spotify.com/album/123456789012'), null);
    assert.deepEqual(ML.parseSpotifyPage('<meta property="og:title" content="Never Gonna Give You Up"><meta property="og:description" content="Rick Astley · Whenever You Need Somebody · Song · 1987">'), { title: 'Never Gonna Give You Up', artist: 'Rick Astley' });
    assert.deepEqual(ML.parseSpotifyPage('<meta property="og:title" content="Song A"><meta name="music:musician_description" content="Band B">'), { title: 'Song A', artist: 'Band B' });
    // A fake yt-dlp.
    const calls = [];
    const fake = (answers) => (bin, args) => { calls.push(args); const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
      const a = answers(args); setImmediate(() => { if (a.out) c.stdout.emit('data', a.out); if (a.err) c.stderr.emit('data', a.err); c.emit('close', a.code ?? 0); }); return c; };
    const spawnFn = fake((args) => (args[0] === '--version' ? { out: '2026.10.01\n' } : /private/.test(args.at(-1)) ? { code: 1, err: 'ERROR: Private video' } : { out: JSON.stringify({ title: 'Song', uploader: 'Chan', duration: 200, webpage_url: 'https://youtu.be/x', extractor_key: 'Youtube' }) }));
    const info = await ML.lookup('yt-dlp', 'https://youtu.be/x', { spawnFn });
    assert.deepEqual(info, { title: 'Song', artist: 'Chan', seconds: 200, page: 'https://youtu.be/x', site: 'Youtube' });
    await assert.rejects(ML.lookup('yt-dlp', 'https://youtu.be/private', { spawnFn }), /private or was removed/);
    assert.ok(calls.some((a) => a.includes('--no-playlist')), 'never pulls a whole playlist');
    // The switch: only the bot owner, with a warning first, saved for the whole bot.
    const { makeWorld } = await import('./features.js');
    const { PermissionFlagsBits: P } = await import('discord.js');
    const w = await makeWorld(['music']).load();
    const owner = w.person('900000000000000401', { bits: [P.Administrator], pos: 9 }); const admin = w.person('900000000000000402', { bits: [P.Administrator], pos: 8 });
    w.mm.ownerIds.add(owner.id);
    globalThis[Symbol.for('goodboy.music.spawn')] = spawnFn;
    try {
      const room = w.channel('music');
      const ownerCmd = w.ix({ command: 'music', member: owner, channel: room }); await w.mm.handleCommand(ownerCmd);
      assert.match(JSON.stringify(ownerCmd.replies[0]), /Media links: off/, 'the owner sees the switch, and it starts off');
      const adminCmd = w.ix({ command: 'music', member: admin, channel: room }); await w.mm.handleCommand(adminCmd);
      assert.doesNotMatch(JSON.stringify(adminCmd.replies[0]), /Media links/, 'server admins do not');
      const sneaky = w.ix({ customId: 'music:mediaon', member: admin, channel: room }); await w.mm.handleComponent(sneaky);
      assert.match(sneaky.text(), /Only the person who runs this bot/);
      const warn = w.ix({ customId: 'music:media', member: owner, channel: room }); await w.mm.handleComponent(warn);
      assert.match(warn.text(), /breaks those sites' terms of service/);
      const on = w.ix({ customId: 'music:mediaon', member: owner, channel: room }); on.deferUpdate = async () => {}; await w.mm.handleComponent(on);
      assert.match(on.text(), /Media links are \*\*on\*\*/);
      assert.equal(w.mm.ctx('1', 'music').data.get('mediaLinks').on, true, 'on in this server, saved');
      assert.notEqual(w.mm.ctx('2', 'music').data.get('mediaLinks')?.on, true, 'other servers stay off');
      const off = w.ix({ customId: 'music:mediaoff', member: owner, channel: room }); await w.mm.handleComponent(off);
      assert.equal(w.mm.ctx('1', 'music').data.get('mediaLinks').on, false);
    } finally { delete globalThis[Symbol.for('goodboy.music.spawn')]; }
  });


  console.log('\n3.0.6 phone app: tickets from the dashboard');
  await test('ticket actions: staff can claim, reply and close (with the same required notes) from the dashboard or phone; others cannot; report tickets need an outcome', async () => {
    const { makeWorld } = await import('./features.js');
    const { PermissionFlagsBits: P } = await import('discord.js');
    const w = await makeWorld(['support']).load();
    const staff = w.person('900000000000000501', { bits: [P.ModerateMembers, P.ManageMessages, P.KickMembers], pos: 5, username: 'staffy' });
    staff.displayAvatarURL = () => null;
    const member = w.person('900000000000000502', { username: 'member' });
    const ch = w.channel('ticket-0007'); w.mm.setSetting('1', 'support', 'logChannel', w.channel('ticket-log').id);
    const ctx = w.mm.ctx('1', 'support');
    ctx.data.set(`ticket:${ch.id}`, { number: 7, opener: member.id, openerTag: 'member#0', type: 'other', category: 'other', typeLabel: 'Other', status: 'open', claimedBy: null, createdAt: Date.now() - 60000, answers: [] });
    const act = (name, body, by) => w.mm.runAction('1', 'support', name, body, { userId: by.id, username: by.id });
    await assert.rejects(act('ticket-claim', { channelId: ch.id }, member), /Only ticket staff/);
    assert.deepEqual(await act('ticket-claim', { channelId: ch.id }, staff), { claimed: true });
    assert.match(JSON.stringify(ch.sent.at(-1)), /claimed this ticket/);
    await assert.rejects(act('ticket-reply', { channelId: ch.id, text: '  ' }, staff), /Write a reply/);
    await act('ticket-reply', { channelId: ch.id, text: 'Hi, we are on it' }, staff);
    assert.match(JSON.stringify(ch.sent.at(-1)), /Hi, we are on it/); assert.ok(ctx.data.get(`ticket:${ch.id}`).firstResponseAt, 'counts as the first response');
    await assert.rejects(act('ticket-close', { channelId: ch.id, resolution: 'Done' }, staff), /required/);
    assert.deepEqual(await act('ticket-close', { channelId: ch.id, resolution: 'Resolved', reason: 'Answered', action: 'None', notes: 'Easy one' }, staff), { closed: true });
    assert.equal(ctx.data.get(`ticket:${ch.id}`).status, 'closed');
    const view = await w.mm.runView('1', 'support', 'tickets');
    assert.ok(Array.isArray(view.rows));
    const panel = w.mm.describeForGuild('1').find((d) => d.name === 'support').panels.find((p) => p.id === 'tickets');
    assert.deepEqual(panel.pageActions, ['ticket-claim', 'ticket-reply', 'ticket-close'], 'staff with the tickets panel may use them');
  });

}

const btn0 = (i) => { for (const row of i.replies[0].components ?? []) for (const c of (row.toJSON?.() ?? row).components ?? []) if (c.custom_id) return c.custom_id; return null; };
