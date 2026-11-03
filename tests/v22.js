/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * 2.2 tests: the modal pipeline, economy, live leaderboards, games and fishing, and hot reloads in the middle of
 * all of them. Uses the fake Discord world from features.js.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { Database } from '../src/db.js';
import { packToken, unpackToken, loadSecret, getSecret, createPipeline, MAX_CUSTOM_ID } from '../src/modalpipe.js';
import { claimDaily, parseAmount, CLAIM_EVERY, STREAK_GRACE } from '../src/economy.js';
import * as C from '../src/casino.js';
import * as F from '../src/fishing.js';
import { clampPage, pageCount, unpackNav } from '../src/leaderboard.js';
import { makeWorld } from './features.js';
import { customIds, firstButtonId, modalInfo, fakeFields } from './pipe-helpers.js';

globalThis[Symbol.for('goodboy.games.frameMs')] = 0; // no animation pauses in tests

const H = 3600000;
const json = (x) => (typeof x?.toJSON === 'function' ? x.toJSON() : x);
const btn = (payload, pred) => {
  for (const row of payload?.components ?? []) for (const c of json(row).components ?? []) if (pred(c)) return c;
  return null;
};
const embedText = (p) => (p?.embeds ?? []).map((e) => { const d = json(e); return [d.title, d.description, ...(d.fields ?? []).map((f) => `${f.name} ${f.value}`)].filter(Boolean).join(' '); }).join(' ');
const allText = (i) => [...i.replies, ...i.edits, ...i.follow, i.updated].filter(Boolean).map((r) => (typeof r === 'string' ? r : `${r.content ?? ''} ${embedText(r)}`)).join(' | ');

async function gameWorld() {
  const w = await makeWorld(['economy', 'games']).load();
  w.room = w.channel('games');
  w.admin = w.person('gadmin', { bits: [P.ManageGuild, P.Administrator], pos: 15 });
  w.alice = w.person('alice'); w.bob = w.person('bob');
  w.eco = () => w.mm.ctx('1', 'economy');
  w.coins = (id) => w.eco().sql.get('SELECT coins FROM economy_wallets WHERE guild_id = ? AND user_id = ?', '1', id)?.coins;
  w.setCoins = (id, n) => { w.mm.moduleApi('1', 'economy').wallet('1', id); w.eco().sql.run('UPDATE economy_wallets SET coins = ? WHERE guild_id = ? AND user_id = ?', n, '1', id); };
  w.cmd = async (command, member, extra = {}) => { const i = w.ix({ command, member, channel: w.room }); Object.assign(i, extra); await w.mm.handleCommand(i); return i; };
  w.press = async (customId, member, extra = {}) => { const i = w.ix({ customId, member, channel: w.room }); Object.assign(i, extra); await w.mm.handleComponent(i); return i; };
  /** command (or a button) -> launcher button -> popup -> submit */
  w.form = async (start, member, values) => {
    const bid = typeof start === 'string' ? start : firstButtonId(start.replies[0]);
    const click = await w.press(bid, member);
    if (!click.modal) return { click, submit: click };
    const info = modalInfo(click.modal);
    const submit = await w.press(info.customId, member, { fields: fakeFields(values) });
    return { click, info, submit };
  };
  return w;
}

export default async function runV22Tests({ test }) {
  // ================================================================ pipeline
  console.log('\n2.2 modal pipeline');
  await test('tokens: round trip, under 100 characters with two ids, expiry, owner lock, tamper and format checks', () => {
    const owner = '123456789012345678', a = '987654321098765432', b = '111111111111111111';
    const id = packToken({ ns: 'mpx', step: 'o', form: 'pay', owner, args: [a, b] });
    assert.ok(id.length <= MAX_CUSTOM_ID, `${id.length} characters`);
    const t = unpackToken(id, { ns: 'mpx', userId: owner });
    assert.deepEqual([t.step, t.form, t.owner, t.args], ['o', 'pay', owner, [a, b]]);
    assert.throws(() => unpackToken(id, { ns: 'mpx', userId: a }), /belongs to someone else/);
    assert.throws(() => unpackToken(id, { ns: 'mpx', userId: owner, now: Date.now() + 16 * 60000 }), /expired/);
    assert.throws(() => unpackToken(id.replace(a, b), { ns: 'mpx', userId: owner }), /could not be verified/, 'changing the target breaks the signature');
    assert.throws(() => unpackToken(id.replace(':m1:', ':m0:'), { ns: 'mpx', userId: owner }), /older version/);
    assert.throws(() => unpackToken(id, { ns: 'mpg', userId: owner }), /not from this feature/);
    assert.throws(() => packToken({ ns: 'mpx', step: 'o', form: 'pay', owner, args: ['has:colon'] }), /bad argument/);
    assert.notEqual(packToken({ ns: 'mpx', step: 'o', form: 'pay', owner }), packToken({ ns: 'mpx', step: 'o', form: 'pay', owner }), 'two forms in the same second differ');
  });

  await test('the signing key lives in the database, so open buttons survive a full restart', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gb22-')), 'k.db');
    const db1 = new Database(file); loadSecret(db1);
    const id = packToken({ ns: 'mpx', step: 'o', form: 'pay', owner: 'u1' });
    const k1 = getSecret().toString('hex'); db1.close();
    globalThis[Symbol.for('goodboy.modalpipe.secret')] = undefined; // "process restarted"
    const db2 = new Database(file); loadSecret(db2);
    assert.equal(getSecret().toString('hex'), k1);
    assert.equal(unpackToken(id, { ns: 'mpx', userId: 'u1' }).form, 'pay');
    db2.close();
  });

  await test('a form definition with a field label over 45 characters fails before it reaches Discord', async () => {
    const pipe = createPipeline({ ns: 'mpt', forms: { f: { title: 'T', fields: () => [{ id: 'a', label: 'x'.repeat(46) }], submit: async () => {} } } });
    const i = { user: { id: 'u' }, member: {}, guildId: '1', reply: async () => {}, showModal: async () => {} };
    await assert.rejects(pipe.open({ perms: { check: () => true } }, i, 'f'), /longer than 45/);
  });

  await test('new 2.2 modules declare no typed command options at all (the "everything is a popup" rule)', async () => {
    const w = await gameWorld();
    const names = ['balance', 'daily', 'pay', 'top', 'economy-admin', 'slots', 'blackjack', 'coinflip', 'fish', 'arcade', 'warn', 'announce'];
    const userMenus = [...w.mm.defs.values()].flatMap(({ def }) => (def.commands ?? []).map((c) => json(c.data))).filter((c) => c.type === 2);
    assert.ok(userMenus.length <= 5, `Discord allows 5 right-click member commands (have ${userMenus.length})`);
    const list = w.mm.commandList('1');
    for (const n of names.slice(0, 10)) {
      const c = list.find((x) => x.name === n);
      assert.ok(c, `/${n} registered`);
      assert.deepEqual(c.options ?? [], [], `/${n} has no options`);
    }
  });

  // ================================================================ economy
  console.log('\n2.2 economy');
  await test('daily streak: 20h cooldown, 48h grace, shields every 7 days, milestones, reset after a miss', () => {
    const t0 = Date.UTC(2026, 0, 1);
    let w = { streak: 0, lastDaily: 0, shields: 0, bestStreak: 0 };
    const c1 = claimDaily(w, 100, t0); assert.deepEqual([c1.ok, c1.streak, c1.total], [true, 1, 100]);
    assert.equal(claimDaily({ ...c1 }, 100, t0 + 19 * H).ok, false, 'too early');
    let s = c1;
    for (let d = 2; d <= 7; d++) s = claimDaily(s, 100, s.lastDaily + 24 * H);
    assert.deepEqual([s.streak, s.shields, s.shieldEarned, s.bonus], [7, 1, true, 200], 'day 7: shield + bonus');
    assert.equal(s.reward, Math.round(100 * 1.3));
    const saved = claimDaily(s, 100, s.lastDaily + STREAK_GRACE + H);
    assert.deepEqual([saved.streak, saved.usedShield, saved.shields], [8, true, 0], 'shield used after a missed day');
    const lost = claimDaily(saved, 100, saved.lastDaily + STREAK_GRACE + H);
    assert.deepEqual([lost.streak, lost.lost], [1, true]);
    assert.equal(lost.bestStreak, 8);
    assert.ok(CLAIM_EVERY < 24 * H);
  });

  await test('amounts: numbers, k/m, half and all, with limits', () => {
    assert.equal(parseAmount('1,500').value, 1500);
    assert.equal(parseAmount('2.5k').value, 2500);
    assert.equal(parseAmount('half', { have: 301 }).value, 150);
    assert.equal(parseAmount('all', { have: 42 }).value, 42);
    assert.match(parseAmount('0').error, /at least/);
    assert.match(parseAmount('lots').error, /whole number/);
    assert.match(parseAmount('99', { max: 50 }).error, /at most 50/);
  });

  await test('/balance and /daily: a new member starts with coins, daily pays once, buttons work for whoever clicks', async () => {
    const w = await gameWorld();
    const bal = await w.cmd('balance', w.alice);
    assert.match(embedText(bal.replies[0]), /\*\*500\*\*/);
    const d1 = await w.cmd('daily', w.alice);
    assert.match(embedText(d1.replies[0]), /Day 1 streak/);
    assert.equal(w.coins('alice'), 750);
    const d2 = await w.cmd('daily', w.alice);
    assert.match(allText(d2), /already claimed/);
    assert.equal(w.coins('alice'), 750);
  });

  await test('/pay: popup with recipient and amount, coins move atomically, bad input gets a retry button', async () => {
    const w = await gameWorld();
    w.setCoins('alice', 1000); w.setCoins('bob', 0);
    const cmd = await w.cmd('pay', w.alice);
    assert.equal(cmd.replies[0].flags, MessageFlags.Ephemeral);
    const ok = await w.form(cmd, w.alice, { to: ['bob'], amount: '300', note: 'for lunch' });
    assert.deepEqual(ok.info.fields, ['to', 'amount', 'note']);
    assert.deepEqual([w.coins('alice'), w.coins('bob')], [700, 300]);
    assert.match(embedText(ok.submit.replies[0]), /paid <@bob>/);
    const broke = await w.form(await w.cmd('pay', w.alice), w.alice, { to: ['bob'], amount: '5000', note: '' });
    assert.match(embedText(broke.submit.replies[0]), /only have \*\*700\*\*/);
    assert.ok(firstButtonId(broke.submit.replies[0]), 'Try again');
    const self = await w.form(await w.cmd('pay', w.alice), w.alice, { to: ['alice'], amount: '1', note: '' });
    assert.match(embedText(self.submit.replies[0]), /cannot pay yourself/);
    assert.deepEqual([w.coins('alice'), w.coins('bob')], [700, 300], 'failed payments move nothing');
  });

  await test('right-click "Pay member" carries the target in the token; the popup asks only for the amount', async () => {
    const w = await gameWorld();
    w.setCoins('alice', 100);
    const cmd = await w.cmd('Pay member', w.alice, { targetUser: w.bob.user });
    const r = await w.form(cmd, w.alice, { amount: 'all', note: '' });
    assert.deepEqual(r.info.fields, ['amount', 'note']);
    assert.deepEqual([w.coins('alice'), w.coins('bob')], [0, 600]);
  });

  await test('/economy-admin: admins only; give, take (never below zero) and set are written to the ledger', async () => {
    const w = await gameWorld();
    assert.match(allText(await w.cmd('economy-admin', w.alice)), /permission/);
    const go = async (op, amount) => w.form(await w.cmd('economy-admin', w.admin), w.admin, { who: ['bob'], op: [op], amount, reason: 'event prize' });
    await go('give', '1k'); assert.equal(w.coins('bob'), 1500);
    await go('take', '99999'); assert.equal(w.coins('bob'), 0);
    await go('set', '42'); assert.equal(w.coins('bob'), 42);
    const rows = w.eco().sql.all("SELECT delta FROM economy_ledger WHERE user_id = 'bob' AND reason LIKE 'admin%' ORDER BY id");
    assert.deepEqual(rows.map((r) => r.delta), [1000, -1500, 42]);
  });

  // ================================================================ leaderboard
  console.log('\n2.2 live leaderboards');
  await test('pagination: 10 per page, Previous off on page 1, Next off on the last page, pages clamp when the board shrinks', async () => {
    assert.equal(pageCount(0), 1); assert.equal(pageCount(25), 3); assert.equal(clampPage(9, 25), 2); assert.equal(clampPage(-3, 25), 0);
    const w = await gameWorld();
    for (let k = 1; k <= 25; k++) { const p = w.person(`p${k}`); w.setCoins(p.id, k * 100); }
    const top = await w.cmd('top', w.alice);
    const r = top.replies[0];
    assert.match(embedText(r), /🥇 <@p25>/);
    const prev = btn(r, (c) => c.custom_id?.endsWith(':prev')), next = btn(r, (c) => c.custom_id?.endsWith(':next'));
    assert.equal(prev.disabled, true); assert.equal(next.disabled, false);
    assert.match(btn(r, (c) => c.custom_id?.endsWith(':noop')).label, /1 \/ 3/);
    const p2 = await w.press(next.custom_id, w.alice);
    assert.match(embedText(p2.updated), /#11/);
    const last = await w.press(btn(p2.updated, (c) => c.custom_id?.endsWith(':next')).custom_id, w.alice);
    assert.equal(btn(last.updated, (c) => c.custom_id?.endsWith(':next')).disabled, true);
    assert.equal(btn(last.updated, (c) => c.custom_id?.endsWith(':prev')).disabled, false);
    w.eco().sql.run("DELETE FROM economy_wallets WHERE user_id LIKE 'p%' AND coins < 2000"); // board shrinks to 1 page
    const after = await w.press(btn(last.updated, (c) => c.custom_id?.endsWith(':refresh')).custom_id, w.alice);
    assert.match(btn(after.updated, (c) => c.custom_id?.endsWith(':noop')).label, /1 \/ 1/);
  });

  await test('every click reads fresh data, and only the person who opened the board can page it', async () => {
    const w = await gameWorld();
    w.setCoins('alice', 100); w.setCoins('bob', 50);
    const top = await w.cmd('top', w.alice);
    assert.match(embedText(top.replies[0]), /🥇 <@alice>/);
    w.setCoins('bob', 9999); // changes between clicks
    const refresh = btn(top.replies[0], (c) => c.custom_id?.endsWith(':refresh')).custom_id;
    const r = await w.press(refresh, w.alice);
    assert.match(embedText(r.updated), /🥇 <@bob>/, 'the refresh shows the new numbers');
    const hijack = await w.press(refresh, w.bob);
    assert.equal(hijack.updated, undefined, 'the owner\'s message is not touched');
    assert.equal(hijack.replies[0].flags, MessageFlags.Ephemeral);
    assert.match(hijack.replies[0].content, /belongs to someone else/);
    assert.equal(unpackNav('econlb:', firstButtonId(hijack.replies[0]) ?? customIds(hijack.replies[0]).find((x) => x.includes(':'))).owner, 'bob', 'bob gets his own copy');
  });

  await test('boards: the picker switches board, games add fishing boards, global shows only servers that opted in', async () => {
    const w = await gameWorld();
    w.setCoins('alice', 100);
    const top = await w.cmd('top', w.alice);
    const picker = btn(top.replies[0], (c) => c.type === 3);
    assert.ok(picker.options.some((o) => o.value === 'fish') && picker.options.some((o) => o.value === 'streak'));
    const s = await w.press(picker.custom_id, w.alice, { values: ['streak'] });
    assert.match(embedText(s.updated), /Daily streak/);
    const toGlobal = btn(top.replies[0], (c) => c.custom_id?.endsWith(':scope'));
    const g1 = await w.press(toGlobal.custom_id, w.alice);
    assert.match(embedText(g1.updated), /not on the global board/);
    w.mm.setSetting('1', 'economy', 'globalBoard', 'true');
    const g2 = await w.press(toGlobal.custom_id, w.alice);
    assert.match(embedText(g2.updated), /🥇 \*\*alice\*\*/, 'global uses stored names, not mentions');
  });

  // ================================================================ casino
  console.log('\n2.2 casino');
  await test('slots: the pay table returns 85-100% and every symbol has a triple payout', () => {
    const rtp = C.slotRtp();
    assert.ok(rtp > 0.85 && rtp < 1, `RTP ${rtp}`);
    for (const s of C.SLOT_SYMBOLS) assert.ok(C.SLOT_TRIPLE[s.id] > 1);
    assert.equal(C.slotMultiplier(['seven', 'seven', 'seven']), 500);
    assert.ok(C.isJackpot(['seven', 'seven', 'seven']));
    assert.equal(C.slotMultiplier(['cherry', 'lemon', 'cherry']), C.SLOT_TWO_CHERRIES);
    assert.equal(C.slotMultiplier(['bell', 'lemon', 'grape']), 0);
  });

  await test('/slots: bet in the popup, outcome paid before the animation, jackpot pool grows, "spin again" reuses the bet', async () => {
    const w = await gameWorld();
    w.setCoins('alice', 1000);
    const r = await w.form(await w.cmd('slots', w.alice), w.alice, { bet: '100' });
    assert.deepEqual(r.info.fields, ['bet']);
    const final = r.submit.edits.at(-1);
    assert.doesNotMatch(embedText(final), /🌀/, 'all reels stopped');
    const paid = w.mm.ctx('1', 'games').sql.get("SELECT returned FROM games_stats WHERE user_id = 'alice' AND game = 'slots'").returned;
    assert.equal(w.coins('alice'), 1000 - 100 + paid);
    assert.equal(w.mm.ctx('1', 'games').sql.get("SELECT pool FROM games_jackpot WHERE guild_id = '1'").pool, 5000 + 3, '3% of the bet joins the pool');
    const again = btn(final, (c) => c.custom_id?.startsWith('gmx:'));
    const before = w.coins('alice');
    const a2 = await w.press(again.custom_id, w.alice);
    assert.ok(a2.replies.length, 'a new spin');
    const paid2 = w.mm.ctx('1', 'games').sql.get("SELECT returned FROM games_stats WHERE user_id = 'alice' AND game = 'slots'").returned - paid;
    assert.equal(w.coins('alice'), before - 100 + paid2);
    const steal = await w.press(again.custom_id, w.bob);
    assert.match(allText(steal), /belongs to someone else/);
  });

  await test('games and /daily are private by default, so playing never notifies the channel; admins can make them public', async () => {
    const w = await gameWorld();
    w.setCoins('alice', 5000);
    const flagsOf = (m) => Number(m?.flags ?? 0);
    const r = await w.form(await w.cmd('slots', w.alice), w.alice, { bet: '100' });
    assert.ok(flagsOf(r.submit.replies[0]) & 64, 'slots result is only for the player');
    const f = await w.form(await w.cmd('coinflip', w.alice), w.alice, { bet: '100', side: ['heads'] });
    assert.ok(flagsOf(f.submit.replies[0]) & 64, 'coin flip result is only for the player');
    const d = await w.cmd('daily', w.alice);
    assert.ok(flagsOf(d.replies[0]) & 64, '/daily is only for the member');
    assert.ok(!w.room.sent.some((p) => /<@/.test(String(p.content ?? ''))), 'nothing in the channel mentions anyone');
    w.mm.setSetting('1', 'games', 'privateGames', 'false');
    const pub = await w.form(await w.cmd('slots', w.alice), w.alice, { bet: '100' });
    assert.equal(flagsOf(pub.submit.replies[0]) & 64, 0, 'public when the admin wants it');
  });

  await test('bets are checked: too small, more than you have, and a game turned off', async () => {
    const w = await gameWorld();
    w.setCoins('alice', 50);
    const small = await w.form(await w.cmd('slots', w.alice), w.alice, { bet: '5' });
    assert.match(embedText(small.submit.replies[0]), /at least 10/);
    const big = await w.form(await w.cmd('coinflip', w.alice), w.alice, { bet: '500', side: ['heads'] });
    assert.match(embedText(big.submit.replies[0]), /at most 50/);
    assert.equal(w.coins('alice'), 50);
    w.mm.setSetting('1', 'games', 'slotsEnabled', 'false');
    assert.match(allText(await w.cmd('slots', w.alice)), /turned off/);
  });

  await test('blackjack engine: soft aces, dealer stands on 17, payouts for win, push, bust, blackjack and doubling', () => {
    assert.deepEqual(C.handValue(['A♠', '6♥']), { total: 17, soft: true });
    assert.deepEqual(C.handValue(['A♠', '6♥', '9♦']), { total: 16, soft: false });
    assert.equal(C.handValue(['A♠', 'A♥', '9♦']).total, 21);
    const s = (player, dealer, deck = []) => ({ bet: 100, player, dealer, deck, doubled: false, done: false });
    assert.equal(C.bjStand(s(['10♠', '9♥'], ['10♦', '7♣'])).payout, 200);
    assert.equal(C.bjStand(s(['10♠', '7♥'], ['10♦', '7♣'])).result, 'push');
    assert.equal(C.bjHit(s(['10♠', '9♥'], ['10♦', '7♣'], ['5♦'])).result, 'bust');
    assert.equal(C.bjSettle(s(['A♠', 'K♥'], ['10♦', '7♣'])).payout, 250);
    assert.equal(C.bjStand(s(['10♠', '6♥'], ['10♦', '6♣'], ['K♠'])).result, 'win', 'dealer draws on 16 and busts');
    const d = C.bjDouble(s(['5♠', '6♥'], ['10♦', '7♣'], ['10♣']));
    assert.deepEqual([d.bet, d.result, d.payout], [200, 'win', 400]);
    assert.equal(C.newDeck().length, 52);
  });

  await test('/blackjack: hand lives in the database, only its owner can play it, it pays exactly once', async () => {
    const w = await gameWorld();
    w.setCoins('alice', 1000);
    let r, hand;
    for (let k = 0; k < 30; k++) { // keep dealing until a hand is not settled by a natural blackjack
      r = await w.form(await w.cmd('blackjack', w.alice), w.alice, { bet: '100' });
      hand = r.submit.replies[0];
      if (btn(hand, (c) => c.custom_id?.endsWith(':stand'))) break;
    }
    const stand = btn(hand, (c) => c.custom_id?.endsWith(':stand')).custom_id;
    const theft = await w.press(stand, w.bob);
    assert.match(allText(theft), /someone else's game/);
    const before = w.coins('alice');
    const done = await w.press(stand, w.alice);
    assert.match(embedText(done.updated), /Dealer · \d+/);
    const got = w.coins('alice') - before;
    assert.ok([0, 100, 200].includes(got), `paid ${got}`);
    const twice = await w.press(stand, w.alice);
    assert.match(allText(twice), /finished/);
    assert.equal(w.coins('alice') - before, got, 'a second click pays nothing');
    assert.equal(w.mm.ctx('1', 'games').sql.get("SELECT COUNT(*) AS n FROM games_sessions WHERE user_id = 'alice'").n, 0);
  });

  await test('blackjack: a hand left alone stands automatically and is paid by the clean-up task', async () => {
    const w = await gameWorld();
    w.setCoins('alice', 1000);
    const g = w.mm.ctx('1', 'games');
    g.sql.run("INSERT INTO games_sessions (id, guild_id, user_id, kind, state, created_at, updated_at) VALUES ('old1', '1', 'alice', 'blackjack', ?, 0, 0)",
      JSON.stringify({ bet: 100, player: ['10♠', '9♥'], dealer: ['10♦', '7♣'], deck: [], doubled: false, done: false }));
    await w.mm.runTasks(Date.now()); await w.mm.runTasks(Date.now() + 120000); // the first run only starts the task clock
    assert.equal(w.coins('alice'), 1200, '19 beats 17');
    assert.equal(g.sql.get("SELECT COUNT(*) AS n FROM games_sessions WHERE id = 'old1'").n, 0);
  });

  await test('/coinflip: heads or tails in the popup; a win pays 1.95x, a loss pays nothing', async () => {
    const w = await gameWorld();
    w.setCoins('alice', 1000);
    const r = await w.form(await w.cmd('coinflip', w.alice), w.alice, { bet: '100', side: ['tails'] });
    assert.deepEqual(r.info.fields, ['bet', 'side']);
    assert.ok([900, 1095].includes(w.coins('alice')), `wallet ${w.coins('alice')}`);
  });

  // ================================================================ fishing
  console.log('\n2.2 fishing');
  await test('fishing world: every place has one fish of each rarity, levels unlock places, luck shifts rarity odds', () => {
    for (const b of F.BIOMES) for (const r of F.RARITIES) assert.ok(Object.values(F.FISH).some((f) => f.biome === b.id && f.rarity === r.id), `${b.id} ${r.id}`);
    assert.equal(F.levelFromXp(0).level, 1);
    assert.ok(F.levelFromXp(F.xpForLevel(12)).level === 12);
    const plain = F.rarityWeights(0), lucky = F.rarityWeights(0.8);
    assert.ok(lucky.at(-1).weight / lucky[0].weight > plain.at(-1).weight / plain[0].weight);
    const c = F.rollCatch({ biome: 'deep', rod: 'voidreach', bait: 'voidlure', tackle: 'charm' }, F.seeded(42));
    assert.ok(F.FISH[c.species].biome === 'deep' && c.weight > 0 && c.value > 0);
    assert.deepEqual(F.rollCatch({ biome: 'bay' }, F.seeded(7)), F.rollCatch({ biome: 'bay' }, F.seeded(7)), 'same seed, same fish');
    const mutated = Array.from({ length: 4000 }, (_, k) => F.rollCatch({ biome: 'deep', bait: 'voidlure', tackle: 'charm' }, F.seeded(k))).filter((x) => x.mutation === 'corrupted').length;
    assert.ok(mutated > 200, `corruption is common in the Hollow Deep with a Void Lure and charm (${mutated}/4000)`);
  });

  await test('reeling: pulls move the zone, reeling inside the zone lands the fish, tension snaps lines, idling loses it', () => {
    const fish = { rarity: 'common' };
    const s = F.startReel({ rod: 'driftwood', tackle: 'none', fish, seed: 1, now: 0 });
    assert.match(F.trackLine(s), /^\[[░■◆◈]{20}\]$/);
    const z = s.zone; F.reelStep(s, 'right', 1000); assert.equal(s.zone, z + 2);
    let t = 1000;
    while (s.status === 'reeling') { t += 1000; F.reelStep(s, F.inZone(s) ? 'reel' : s.pos < s.zone ? 'left' : 'right', t); }
    assert.equal(s.status, 'caught');
    const snap = F.startReel({ rod: 'driftwood', tackle: 'none', fish: { rarity: 'mythical' }, seed: 3, now: 0 });
    snap.pos = 0; snap.zone = 15; // reel blindly while the fish is far away
    let u = 0; while (snap.status === 'reeling') F.reelStep(snap, 'reel', (u += 100));
    assert.ok(['snapped', 'escaped'].includes(snap.status));
    const idle = F.startReel({ rod: 'driftwood', tackle: 'none', fish, seed: 5, now: 0 });
    F.reelStep(idle, 'reel', F.IDLE_MS + 1);
    assert.equal(idle.status, 'escaped');
  });

  await test('/fish: hub -> Cast button -> setup popup (only owned gear) -> reel with buttons -> catch goes to bag and collection', async () => {
    const w = await gameWorld();
    const hub = await w.cmd('fish', w.alice);
    assert.equal(hub.replies[0].flags, MessageFlags.Ephemeral);
    const castId = btn(hub.replies[0], (c) => c.label === 'Cast').custom_id;
    const r = await w.form(castId, w.alice, { biome: ['bay'], rod: ['driftwood'], bait: ['none'], tackle: ['none'] });
    assert.deepEqual(r.info.fields, ['biome', 'rod', 'bait', 'tackle']);
    const opts = json(r.click.modal).components.map((c) => c.component.options?.map((o) => o.value));
    assert.deepEqual(opts[0], ['bay'], 'only unlocked places'); assert.deepEqual(opts[1], ['driftwood'], 'only owned rods');
    let msg = r.submit.replies[0];
    assert.match(embedText(msg), /\[[░■◆◈]{20}\]/, 'the slider is drawn');
    const g = w.mm.ctx('1', 'games');
    // play it like a person: move toward the fish, reel when it is in the zone
    for (let k = 0; k < 80; k++) {
      const row = g.sql.get("SELECT * FROM games_sessions WHERE user_id = 'alice' AND kind = 'fish'");
      if (!row) break;
      const s = JSON.parse(row.state);
      const action = F.inZone(s) && s.tension < F.rodById(s.rod).line - 30 ? 'reel' : s.pos < s.zone ? 'left' : s.pos >= s.zone + F.rodById(s.rod).control ? 'right' : 'left';
      const p = await w.press(`gm:fr:${row.id}:${action}`, w.alice);
      msg = p.updated;
    }
    const caught = g.sql.get("SELECT COUNT(*) AS n FROM games_fish_bag WHERE user_id = 'alice'").n;
    const prof = g.sql.get("SELECT * FROM games_fish_profile WHERE user_id = 'alice'");
    assert.equal(prof.casts, 1);
    if (caught) {
      assert.equal(prof.caught, 1); assert.ok(prof.xp > 0);
      assert.match(embedText(msg), /You caught/);
      assert.equal(g.sql.get("SELECT COUNT(*) AS n FROM games_fish_dex WHERE user_id = 'alice'").n, 1);
    } else assert.match(embedText(msg), /got away|Snap|cut|waited/);
    assert.ok(btn(msg, (c) => c.label === 'Cast again'), 'one click to cast again');
  });

  await test('fishing economy: sell keeps rare finds unless you sell everything; shop rods need coins and level; bait quantity is a popup', async () => {
    const w = await gameWorld();
    const g = w.mm.ctx('1', 'games');
    w.mm.moduleApi('1', 'economy').wallet('1', 'alice');
    w.mm.setSetting('1', 'games', 'fishChallenges', false); // exact coin totals below; challenges have their own test
    const add = (rarity, value, mutation = null) => g.sql.run("INSERT INTO games_fish_bag (guild_id, user_id, species, rarity, mutation, weight, value, biome, caught_at) VALUES ('1', 'alice', 'bay-0', ?, ?, 1, ?, 'bay', 0)", rarity, mutation, value);
    add('common', 10); add('rare', 40); add('legendary', 900); add('common', 50, 'mutated');
    w.setCoins('alice', 0);
    await w.press('gm:fh:alice:sellcommon', w.alice);
    assert.equal(w.coins('alice'), 50, 'common + rare sold, legendary and mutated kept');
    await w.press('gm:fh:alice:sellall', w.alice);
    assert.equal(w.coins('alice'), 1000);
    const shop = await w.press('gm:fh:alice:shop', w.alice);
    const picker = btn(shop.updated, (c) => c.type === 3);
    assert.ok(picker.options.some((o) => o.value === 'tackle-leader'));
    assert.ok(!picker.options.some((o) => o.value === 'rod-carbon'), 'locked rods are not offered at level 1');
    const poor = await w.press(picker.custom_id, w.alice, { values: ['tackle-charm'] });
    assert.match(allText(poor), /only have/);
    const rod = await w.press(picker.custom_id, w.alice, { values: ['rod-reedspring'] });
    assert.equal(rod.updated, undefined); assert.match(allText(rod), /only have|level/);
    w.setCoins('alice', 5000);
    const ok = await w.press(picker.custom_id, w.alice, { values: ['tackle-leader'] });
    assert.match(embedText(ok.updated), /Bought \*\*Steel Leader\*\*/);
    const bait = await w.press(picker.custom_id, w.alice, { values: ['bait-worm'] });
    assert.ok(bait.modal, 'how many? is asked in a popup');
    const sub = await w.press(modalInfo(bait.modal).customId, w.alice, { fields: fakeFields({ qty: '20' }) });
    assert.match(allText(sub), /20 × Earthworm/);
    assert.equal(g.sql.get("SELECT qty FROM games_fish_bait WHERE user_id = 'alice' AND bait = 'worm'").qty, 20);
    assert.equal(w.coins('alice'), 5000 - 4000 - 100);
  });

  // ================================================================ dead chat ping
  console.log('\n2.2 dead chat ping');
  await test('dead chat rule: only after the quiet time, once per quiet spell, never inside the cooldown', async () => {
    const { shouldPing } = await import('../modules/deadchat/index.js');
    const M = 60000, base = { quietMs: 60 * M, cooldownMs: 240 * M };
    assert.equal(shouldPing({ ...base, now: 1000 * M, lastMessageAt: 0 }), false, 'no baseline yet');
    assert.equal(shouldPing({ ...base, now: 1000 * M, lastMessageAt: 970 * M }), false, 'only 30 quiet minutes');
    assert.equal(shouldPing({ ...base, now: 1000 * M, lastMessageAt: 900 * M }), true);
    assert.equal(shouldPing({ ...base, now: 1000 * M, lastMessageAt: 900 * M, lastPingAt: 950 * M }), false, 'already pinged this quiet spell');
    assert.equal(shouldPing({ ...base, now: 1000 * M, lastMessageAt: 920 * M, lastPingAt: 910 * M }), false, 'someone talked, but the cooldown is not over');
    assert.equal(shouldPing({ ...base, now: 1300 * M, lastMessageAt: 1200 * M, lastPingAt: 1000 * M }), true);
  });

  await test('/deadchat: popup sets it up (same settings as the dashboard), then a quiet channel gets one ping with a starter', async () => {
    const w = await makeWorld(['deadchat']).load();
    const admin = w.person('dadmin', { bits: [P.ManageGuild], pos: 10 });
    const chat = w.channel('general'); const role = w.role('900000000000000001'); role.mentionable = true;
    const cmd = w.ix({ command: 'deadchat', member: admin, channel: chat }); await w.mm.handleCommand(cmd);
    assert.deepEqual(w.mm.commandList('1').find((c) => c.name === 'deadchat').options ?? [], []);
    const click = w.ix({ customId: firstButtonId(cmd.replies[0]), member: admin }); await w.mm.handleComponent(click);
    const info = modalInfo(click.modal);
    assert.deepEqual(info.fields, ['enabled', 'channel', 'role', 'quiet', 'cooldown']);
    const sub = w.ix({ customId: info.customId, member: admin }); sub.fields = fakeFields({ enabled: ['on'], channel: [chat.id], role: [role.id], quiet: '60', cooldown: '240' });
    await w.mm.handleComponent(sub);
    const vals = w.mm.getSettingValues('1', 'deadchat');
    assert.deepEqual([vals.enabled, vals.channel, vals.role, vals.quietMinutes, vals.cooldownMinutes], [true, chat.id, role.id, 60, 240]);
    const { check } = await import('../modules/deadchat/index.js');
    const ctx = w.mm.ctx('1', 'deadchat');
    const t0 = ctx.data.get('lastMessageAt');
    await check(ctx, t0 + 30 * 60000); assert.equal(chat.sent.length, 1, 'not quiet long enough (only the setup panel so far)');
    const before = chat.sent.length; // the opt-in panel posted at setup
    await check(ctx, t0 + 61 * 60000); assert.equal(chat.sent.length, before + 1);
    assert.match(chat.sent.at(-1).content, /^<@&900000000000000001> 💬 \*\*Chat has been quiet for 61 minutes!\*\*\n/);
    assert.deepEqual(chat.sent.at(-1).allowedMentions, { roles: [role.id] });
    await check(ctx, t0 + 400 * 60000); assert.equal(chat.sent.length, before + 1, 'nobody talked since, so no second ping');
    await w.mm.dispatch('messageCreate', '1', { channelId: chat.id, author: { bot: true } });
    await check(ctx, t0 + 500 * 60000); assert.equal(chat.sent.length, before + 1, 'bot messages do not count as talking');
  });

  await test('/deadchat with no role picked makes a mentionable @deadchat role; members opt in and out with the button', async () => {
    const w = await makeWorld(['deadchat']).load();
    const admin = w.person('dadmin2', { bits: [P.ManageGuild], pos: 10 });
    const member = w.person('chatty');
    const chat = w.channel('general');
    w.g.roles.create = async (o) => { const r = w.role('900000000000000077', { pos: 1 }); Object.assign(r, { name: o.name, mentionable: o.mentionable }); w.created = o; return r; };
    const cmd = w.ix({ command: 'deadchat', member: admin, channel: chat }); await w.mm.handleCommand(cmd);
    const click = w.ix({ customId: firstButtonId(cmd.replies[0]), member: admin }); await w.mm.handleComponent(click);
    const sub = w.ix({ customId: modalInfo(click.modal).customId, member: admin }); sub.fields = fakeFields({ enabled: ['on'], channel: [chat.id], role: [], quiet: '30', cooldown: '120' });
    await w.mm.handleComponent(sub);
    assert.deepEqual([w.created.name, w.created.mentionable], ['deadchat', true]);
    assert.equal(w.mm.getSettingValues('1', 'deadchat').role, '900000000000000077');
    const panel = chat.sent.at(-1);
    assert.match(panel.content, /Want in\?/);
    assert.equal(customIds(panel)[0], 'deadchat:toggle');
    const on = w.ix({ customId: 'deadchat:toggle', member }); await w.mm.handleComponent(on);
    assert.ok(member.roles.cache.has('900000000000000077')); assert.match(on.text(), /You'll be pinged/);
    const off = w.ix({ customId: 'deadchat:toggle', member }); await w.mm.handleComponent(off);
    assert.ok(!member.roles.cache.has('900000000000000077')); assert.match(off.text(), /won't be pinged/);
    const { check } = await import('../modules/deadchat/index.js');
    const ctx = w.mm.ctx('1', 'deadchat');
    await check(ctx, ctx.data.get('lastMessageAt') + 31 * 60000);
    assert.match(chat.sent.at(-1).content, /^<@&900000000000000077> /);
    assert.equal(customIds(chat.sent.at(-1))[0], 'deadchat:toggle', 'every ping carries the opt-in button');
  });

  // ================================================================ dashboard (2.2)
  console.log('\n2.2 dashboard');
  await test('dashboard page code: no browser prompt/confirm boxes, empty parts never reach the page as "null"', () => {
    const js = fs.readFileSync(new URL('../src/dashboard/public/app.js', import.meta.url), 'utf8');
    assert.doesNotMatch(js, /window\.(prompt|confirm|alert)\(/, 'all questions use the page\'s own dialog');
    assert.equal((js.match(/\.replaceChildren\(/g) ?? []).length, 3, 'only the null-safe put() helper, clear() and the sign-in line call replaceChildren');
    assert.match(js, /function put\(el, \.\.\.kids\) \{ el\.replaceChildren\(\.\.\.kids\.flat\(\)\.filter\(\(k\) => k != null/);
  });

  await test('every dashboard panel explains itself when empty, and choices are dropdowns, not typed words', async () => {
    const w = await makeWorld([]).load();
    for (const { def } of w.mm.defs.values()) {
      for (const pn of def.panels ?? []) {
        for (const a of pn.rowActions ?? []) {
          if (a.prompt === 'text') assert.ok(!/ or /.test(a.hint ?? ''), `${def.name}/${a.action}: a fixed list of words should be a dropdown`);
          if (a.prompt === 'select') assert.ok(a.options?.length >= 2, `${def.name}/${a.action}: dropdown needs options`);
        }
      }
    }
    const auto = w.mm.defs.get('moderation').def.panels.find((x) => x.id === 'automod');
    assert.equal(auto.rowActions.find((a) => a.action === 'automod-action').prompt, 'select');
    assert.ok(auto.recentEmpty && auto.columns.filter((c) => c.hint).length >= 3);
  });

  await test('Community has a Levels box: names, pictures, level and XP; give, take (never below 0), reset, reset everyone', async () => {
    const w = await makeWorld(['community']).load();
    const pn = w.mm.defs.get('community').def.panels;
    assert.equal(pn[0].id, 'levels'); assert.equal(pn[0].permission, 'community.manage');
    const ctx = w.mm.ctx('1', 'community');
    const a = w.person('900000000000000101'), b = w.person('900000000000000102');
    ctx.data.set(`user:${a.id}`, { xp: 15230, messages: 9 }); ctx.data.set(`user:${b.id}`, { xp: 900 });
    const v = await w.mm.runView('1', 'community', 'levels');
    assert.deepEqual([v.rows[0].id, v.rows[0].rank, v.rows[0].xpText], [a.id, 1, '15,230']);
    assert.ok('avatar' in v.rows[0] && v.rows[0].level > 0 && /\d+ \/ \d+/.test(v.rows[0].progress));
    const actor = { userId: 'admin', username: 'admin' };
    await w.mm.runAction('1', 'community', 'xp-give', { userId: b.id, value: 100 }, actor); assert.equal(ctx.data.get(`user:${b.id}`).xp, 1000);
    await w.mm.runAction('1', 'community', 'xp-take', { userId: b.id, value: 99999 }, actor); assert.equal(ctx.data.get(`user:${b.id}`).xp, 0);
    await w.mm.runAction('1', 'community', 'xp-reset', { userId: a.id }, actor); assert.equal(ctx.data.get(`user:${a.id}`).xp, 0);
    assert.equal(ctx.data.get(`user:${a.id}`).messages, 9, 'other numbers are kept');
    ctx.data.set(`user:${a.id}`, { xp: 50 });
    await assert.rejects(() => w.mm.runAction('1', 'community', 'xp-reset-all', { confirm: 'nope' }, actor), /RESET/);
    const r = await w.mm.runAction('1', 'community', 'xp-reset-all', { confirm: 'RESET' }, actor);
    assert.equal(r.affected, 1); assert.equal(ctx.data.get(`user:${a.id}`).xp, 0);
  });

  // ================================================================ /modules control panel
  console.log('\n2.2 /modules control panel');
  await test('every page of every module\'s settings builds a popup Discord accepts (5 fields, labels within 45 characters)', async () => {
    const { fieldFor } = await import('../src/modulepanel.js');
    const { formModal } = await import('../src/modalkit.js');
    const w = await makeWorld([]).load();
    let pages = 0;
    for (const { def } of w.mm.defs.values()) {
      const st = def.settings ?? [];
      for (let k = 0; k < st.length; k += 5) { formModal('x', 'T', st.slice(k, k + 5).map((x) => fieldFor(x, x.default))); pages++; }
    }
    assert.ok(pages >= 25, `${pages} popups checked`);
  });

  await test('/modules: pick a module, turn it on, edit its settings in a popup; only admins, only the person who opened it', async () => {
    const w = await makeWorld(['economy']).load();
    const admin = w.person('madmin', { bits: [P.ManageGuild], pos: 10 });
    const chat = w.channel('general'); const role = w.role('900000000000000201');
    const cmd = w.ix({ command: 'modules', member: admin }); await w.mm.handleCommand(cmd);
    assert.deepEqual(w.mm.commandList('1').find((c) => c.name === 'modules').options ?? [], [], 'nothing to type');
    const pickId = customIds(cmd.replies[0])[0];
    const pick = w.ix({ customId: pickId, member: admin }); pick.values = ['deadchat']; await w.mm.handleComponent(pick);
    assert.match(embedText(pick.updated), /deadchat/); assert.match(embedText(pick.updated), /Status Off/);
    const onId = btn(pick.updated, (c) => c.label === 'Turn on').custom_id;
    const on = w.ix({ customId: onId, member: admin }); await w.mm.handleComponent(on);
    assert.ok(w.mm.isActive('1', 'deadchat'), 'turned on from the button');
    assert.match(embedText(on.updated), /Turned on/);
    const editId = btn(on.updated, (c) => c.type === 3).custom_id;
    const edit = w.ix({ customId: editId, member: admin }); edit.values = ['0']; await w.mm.handleComponent(edit);
    const info = modalInfo(edit.modal);
    assert.deepEqual(info.fields, ['enabled', 'channel', 'role', 'quietMinutes', 'cooldownMinutes']);
    w.mm.setSetting('1', 'deadchat', 'role', role.id);
    const sub = w.ix({ customId: info.customId, member: admin });
    sub.fields = fakeFields({ enabled: ['on'], channel: [chat.id], role: [role.id], quietMinutes: '45', cooldownMinutes: 'lots' });
    await w.mm.handleComponent(sub);
    const v = w.mm.getSettingValues('1', 'deadchat');
    assert.deepEqual([v.enabled, v.channel, v.role, v.quietMinutes, v.cooldownMinutes], [true, chat.id, role.id, 45, 240], 'good values saved, the role kept, the bad number refused');
    assert.match(embedText(sub.updated), /Saved: .*Ping after/); assert.match(embedText(sub.updated), /must be a number/);
    const intruder = w.person('mintruder', { bits: [P.ManageGuild] });
    const steal = w.ix({ customId: onId, member: intruder }); await w.mm.handleComponent(steal);
    assert.match(steal.text(), /belongs to someone else/);
    admin.permissions = { has: () => false };
    const demoted = w.ix({ customId: pickId, member: admin }); demoted.values = ['economy']; await w.mm.handleComponent(demoted);
    assert.match(demoted.text(), /Manage Server/);
  });

  await test('/module and /config have no options: each opens a popup; /module turns modules on and off, /config leads to Edit settings', async () => {
    const w = await makeWorld(['economy']).load();
    const admin = w.person('cadmin', { bits: [P.ManageGuild], pos: 10 });
    for (const n of ['module', 'config']) assert.deepEqual(w.mm.commandList('1').find((c) => c.name === n).options ?? [], [], `/${n} has nothing to type`);
    const cmd = w.ix({ command: 'module', member: admin }); await w.mm.handleCommand(cmd);
    const info = modalInfo(cmd.modal);
    assert.deepEqual(info.fields, ['module', 'action']);
    assert.ok(json(cmd.modal).components[0].component.options.some((o) => o.value === 'games' && /Off/.test(o.label)));
    const on = w.ix({ customId: info.customId, member: admin }); on.fields = fakeFields({ module: ['games'], action: ['on'] });
    await w.mm.handleComponent(on);
    assert.ok(w.mm.isActive('1', 'games')); assert.match(embedText(on.edits.at(-1) ?? on.replies[0]), /Turned on/);
    const cmd2 = w.ix({ command: 'module', member: admin }); await w.mm.handleCommand(cmd2);
    const off = w.ix({ customId: modalInfo(cmd2.modal).customId, member: admin }); off.fields = fakeFields({ module: ['economy'], action: ['off'] });
    await w.mm.handleComponent(off);
    assert.ok(w.mm.isActive('1', 'economy'), 'economy stays on: games still needs it');
    assert.match(embedText(off.edits.at(-1) ?? off.replies[0]), /⚠️/);
    const cfg = w.ix({ command: 'config', member: admin }); await w.mm.handleCommand(cfg);
    const ci = modalInfo(cfg.modal); assert.deepEqual(ci.fields, ['module']);
    const pick = w.ix({ customId: ci.customId, member: admin }); pick.fields = fakeFields({ module: ['games'] }); await w.mm.handleComponent(pick);
    assert.ok(btn(pick.replies[0], (c) => c.type === 3 && /Edit settings/.test(c.placeholder)), 'the card offers Edit settings');
    const plain = w.person('cplain');
    const no = w.ix({ command: 'module', member: plain }); await w.mm.handleCommand(no);
    assert.equal(no.modal, null); assert.match(no.text(), /Manage Server/);
  });

  // ================================================================ every command is a popup
  console.log('\n2.2 every command is a popup');
  const AP = await import('../src/autopopup.js');
  const realIx = (w, { command, sub = null, group = null, member, channel }) => {
    const i = w.ix({ command, sub, group, member, channel });
    const none = () => null;
    i.options = { data: sub ? [{ type: 1, name: sub, options: [] }] : [], getSubcommand: () => sub, getSubcommandGroup: () => group, getString: none, getInteger: none, getNumber: none, getBoolean: none, getUser: none, getChannel: none, getRole: none };
    i.isChatInputCommand = () => true;
    return i;
  };

  await test('Discord gets every command without typed options; every leaf of every command builds a valid popup with tokens under 100 characters', async () => {
    const w = await makeWorld([]).load();
    for (const n of [...w.mm.defs.keys()]) await w.mm.enable('1', n).catch(() => {});
    const list = w.mm.discordCommandList('1');
    const typed = (opts) => (opts ?? []).some((o) => o.type > 2 || typed(o.options));
    assert.deepEqual(list.filter((c) => typed(c.options)).map((c) => c.name), [], 'nothing to type in any command box');
    let popups = 0;
    const fake = { user: { id: '123456789012345678' } };
    for (const json of w.mm.commandList('1')) {
      if (json.type && json.type !== 1) continue;
      const walk = (opts, path) => {
        const leaf = (opts ?? []).filter((o) => o.type > 2);
        if (leaf.length) for (let p = 0; p < AP.pageCount(leaf); p++) { AP.popupFor(fake, json, path[0] ?? null, path[1] ?? null, leaf, p, 'abcd1234'); popups++; }
        for (const o of opts ?? []) if (o.type <= 2) walk(o.options, o.type === 2 ? [o.name] : [path[0] ?? null, o.name].filter((x) => x !== undefined));
      };
      walk(json.options, []);
    }
    assert.ok(popups >= 120, `${popups} popups built`);
  });

  await test('running a command with options opens its popup; submitting runs the command with real members, channels and numbers', async () => {
    const w = await makeWorld(['community']).load();
    const admin = w.person('900000000000000301', { bits: [P.ManageGuild, P.Administrator], pos: 10 });
    const target = w.person('900000000000000302');
    const cmd = realIx(w, { command: 'xp', sub: 'set', member: admin }); await w.mm.handleCommand(cmd);
    const info = modalInfo(cmd.modal);
    assert.deepEqual(info.fields, ['user', 'amount']);
    assert.match(info.title, /\/xp set/);
    const bad = w.ix({ customId: info.customId, member: admin }); bad.fields = fakeFields({ user: [target.id], amount: '-5' });
    await w.mm.handleComponent(bad);
    assert.match(bad.text(), /at least 0/); assert.ok(customIds(bad.replies[0])[0].startsWith('gbc:'), 'Try again button');
    const ok = w.ix({ customId: info.customId, member: admin }); ok.fields = fakeFields({ user: [target.id], amount: '2,500' });
    await w.mm.handleComponent(ok);
    assert.equal(w.mm.ctx('1', 'community').data.get(`user:${target.id}`).xp, 2500);
    assert.match(ok.text(), /level/);
    const steal = w.ix({ customId: info.customId, member: target }); steal.fields = fakeFields({ user: [target.id], amount: '9' });
    await w.mm.handleComponent(steal); assert.match(steal.text(), /belongs to someone else/);
  });

  await test('own popups are left alone, and a command with more than 5 fields is asked in parts with a Continue button', async () => {
    const w = await makeWorld(['roles']).load();
    const admin = w.person('900000000000000401', { bits: [P.ManageGuild, P.Administrator, P.ManageRoles], pos: 10 });
    const own = realIx(w, { command: 'rolemenu', sub: 'create', member: admin, channel: w.channel('roles') }); await w.mm.handleCommand(own);
    assert.ok(own.modal && !modalInfo(own.modal).customId.startsWith('gbc:'), '/rolemenu create keeps its own popup');
    // A made-up 7-field command shows the paging.
    const json = { name: 'big', description: 'x', options: Array.from({ length: 7 }, (_, k) => ({ type: 3, name: `f${k}`, description: 'x', required: k === 6 })) };
    const fake = { user: { id: 'u1' }, guildId: '1' };
    assert.equal(AP.pageCount(json.options), 2);
    const p1 = modalInfo(AP.popupFor(fake, json, null, null, json.options, 0));
    assert.deepEqual(p1.fields, ['f0', 'f1', 'f2', 'f3', 'f4']); assert.match(p1.title, /\(1 of 2\)/);
    const p2 = modalInfo(AP.popupFor(fake, json, null, null, json.options, 1, 'dddd0000'));
    assert.deepEqual(p2.fields, ['f5', 'f6']);
    const d = AP.saveDraft('-', 'u1', { f0: 'a', f1: 'b' });
    assert.throws(() => AP.takeDraft(d, 'u2'), /someone else/);
    assert.deepEqual(AP.takeDraft(d, 'u1'), { f0: 'a', f1: 'b' });
    assert.throws(() => AP.takeDraft(d, 'u1'), /expired/, 'used once');
  });

  await test('the whole multi-part flow through the core: part 1, Continue, part 2, then the command runs with every answer', async () => {
    const w = await makeWorld([]).load();
    const ran = [];
    const big = { data: { name: 'bigform', description: 'x', options: Array.from({ length: 7 }, (_, k) => ({ type: 3, name: `f${k}`, description: 'x' })) },
      async execute(i) { ran.push(Array.from({ length: 7 }, (_, k) => i.options.getString(`f${k}`))); await i.reply({ content: 'ran' }); } };
    w.mm.builtins.set('bigform', big);
    const admin = w.person('900000000000000501', { bits: [P.ManageGuild], pos: 10 });
    const cmd = realIx(w, { command: 'bigform', member: admin }); await w.mm.handleCommand(cmd);
    const s1 = w.ix({ customId: modalInfo(cmd.modal).customId, member: admin }); s1.fields = fakeFields({ f0: 'a', f1: 'b', f2: 'c', f3: 'd', f4: 'e' });
    await w.mm.handleComponent(s1);
    assert.match(s1.text(), /Part 1 of 2 saved/);
    const cont = w.ix({ customId: customIds(s1.replies[0])[0], member: admin }); await w.mm.handleComponent(cont);
    const p2 = modalInfo(cont.modal); assert.deepEqual(p2.fields, ['f5', 'f6']);
    const s2 = w.ix({ customId: p2.customId, member: admin }); s2.fields = fakeFields({ f5: 'f', f6: 'g' });
    await w.mm.handleComponent(s2);
    assert.deepEqual(ran, [['a', 'b', 'c', 'd', 'e', 'f', 'g']]);
  });

  // ================================================================ hot reload (the point of the 2.2 test build)
  console.log('\n2.2 hot reload in the middle of a flow');
  await test('reloading games mid-hand and mid-fight: the same buttons keep working on the new code', async () => {
    const w = await gameWorld();
    w.setCoins('alice', 1000);
    let hand;
    for (let k = 0; k < 30; k++) {
      hand = (await w.form(await w.cmd('blackjack', w.alice), w.alice, { bet: '50' })).submit.replies[0];
      if (btn(hand, (c) => c.custom_id?.endsWith(':stand'))) break;
    }
    const castId = btn((await w.cmd('fish', w.bob)).replies[0], (c) => c.label === 'Cast').custom_id;
    const fight = (await w.form(castId, w.bob, { biome: ['bay'], rod: ['driftwood'], bait: ['none'], tackle: ['none'] })).submit.replies[0];
    const payOpen = firstButtonId((await w.cmd('pay', w.alice)).replies[0]);

    const res = await w.mm.reload('games');
    await w.mm.reload('economy');
    assert.equal(res.to, '1.1.0');

    const stand = await w.press(btn(hand, (c) => c.custom_id?.endsWith(':stand')).custom_id, w.alice);
    assert.match(embedText(stand.updated), /Dealer · \d+/, 'blackjack finished after the reload');
    const reel = await w.press(btn(fight, (c) => c.custom_id?.endsWith(':reel')).custom_id, w.bob);
    assert.ok(reel.updated, 'the fishing fight continued after the reload');
    const pay = await w.press(payOpen, w.alice);
    assert.ok(pay.modal, 'a launcher button made before the reload still opens its popup');
  });
}
export { gameWorld, btn, embedText, allText };
