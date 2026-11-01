/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Games (2.2): slots with a progressive server jackpot, blackjack, coin flip and a fishing progression game.
 * Every bet and every fishing setup is entered in a popup (src/modalpipe.js); no command takes a typed option.
 *
 * Built for hot reloads:
 *   - the outcome of a spin or flip is decided and paid BEFORE the animation starts; the animation only reveals it
 *   - blackjack hands and fishing fights live in games_sessions (database), not in memory, and every button
 *     carries only the session id, so a reload or restart in the middle of a hand changes nothing
 *   - "again" buttons that carry a bet are signed with the same key as popup tokens
 * Coins are play money (see the economy module). Nothing here can be bought with real money.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';
import { createPipeline, packToken, unpackToken } from '../../src/modalpipe.js';
import { parseAmount, fmtNum } from '../../src/economy.js';
import * as C from '../../src/casino.js';
import * as F from '../../src/fishing.js';
import { UserError, sleep } from '../../src/util.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const SESSION_MAX_MS = 10 * 60000;
const COLORS = { slots: 0xe91e63, blackjack: 0x2ecc71, coinflip: 0xf1c40f, fish: 0x1abc9c, lose: 0xed4245, push: 0x95a5a6 };
/** Delay between animation frames. Tests set the global to 0. */
const frameMs = () => globalThis[Symbol.for('goodboy.games.frameMs')] ?? 750;

const eco = (ctx) => {
  const api = ctx.api('economy');
  if (!api) throw new UserError('Games need the **economy** module. An admin can turn it on with `/module` or `/modules`.');
  return api;
};
const money = (ctx, n) => eco(ctx).format(ctx.guildId, n);
const enabled = (ctx, game) => { if (!ctx.config.get(`${game}Enabled`)) throw new UserError('That game is turned off in this server.'); };
const sid = () => randomBytes(5).toString('hex');

/** Checks and takes a bet. Returns the amount. */
function takeBet(ctx, userId, raw, reason) {
  const have = eco(ctx).wallet(ctx.guildId, userId).coins;
  const amt = parseAmount(raw, { have, min: ctx.config.get('minBet'), max: Math.min(ctx.config.get('maxBet'), Math.max(have, ctx.config.get('minBet'))) });
  if (amt.error) throw new UserError(amt.error);
  eco(ctx).debit(ctx.guildId, userId, amt.value, reason);
  return amt.value;
}
function record(ctx, userId, game, wagered, returned) {
  ctx.sql.run(`INSERT INTO games_stats (guild_id, user_id, game, played, won, wagered, returned) VALUES (?, ?, ?, 1, ?, ?, ?)
               ON CONFLICT(guild_id, user_id, game) DO UPDATE SET played = played + 1, won = won + excluded.won, wagered = wagered + excluded.wagered, returned = returned + excluded.returned`,
  ctx.guildId, userId, game, returned > wagered ? 1 : 0, wagered, returned);
}

// ------------------------------------------------------------------ sessions (blackjack hands, fishing fights)
function saveSession(ctx, id, userId, kind, state) {
  ctx.sql.run(`INSERT INTO games_sessions (id, guild_id, user_id, kind, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`, id, ctx.guildId, userId, kind, JSON.stringify(state), Date.now(), Date.now());
}
function loadSession(ctx, id, userId, kind) {
  const row = ctx.sql.get('SELECT * FROM games_sessions WHERE id = ? AND guild_id = ?', id, ctx.guildId);
  if (!row || row.kind !== kind) throw new UserError('That game has finished. Start a new one!');
  if (row.user_id !== userId) throw new UserError('That is someone else\'s game. Start your own!');
  return JSON.parse(row.state);
}
const dropSession = (ctx, id) => ctx.sql.run('DELETE FROM games_sessions WHERE id = ?', id);
function activeSession(ctx, userId, kind) {
  return ctx.sql.get('SELECT id FROM games_sessions WHERE guild_id = ? AND user_id = ? AND kind = ? AND updated_at > ?', ctx.guildId, userId, kind, Date.now() - SESSION_MAX_MS);
}

// Signed "again" buttons: they carry a bet, so they use the same signature as popup tokens.
const againId = (i, game, args) => packToken({ ns: 'gmx', step: 'a', form: game, owner: i.user.id, args: args.map(String) });

// ------------------------------------------------------------------ jackpot
const pool = (ctx) => ctx.sql.get('SELECT pool FROM games_jackpot WHERE guild_id = ?', ctx.guildId)?.pool ?? ctx.config.get('jackpotSeed');
function feedPool(ctx, bet) {
  const cut = Math.floor(bet * ctx.config.get('jackpotPercent') / 100);
  ctx.sql.run('INSERT INTO games_jackpot (guild_id, pool) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET pool = pool + ?', ctx.guildId, ctx.config.get('jackpotSeed') + cut, cut);
}
function winPool(ctx) {
  const won = pool(ctx);
  ctx.sql.run('INSERT INTO games_jackpot (guild_id, pool) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET pool = excluded.pool', ctx.guildId, ctx.config.get('jackpotSeed'));
  return won;
}

// ------------------------------------------------------------------ slots
function playSlots(ctx, userId, bet) {
  let result;
  eco(ctx).transaction(ctx.guildId, () => {
    feedPool(ctx, bet);
    const spin = C.spinSlots();
    const jackpot = spin.jackpot ? winPool(ctx) : 0;
    const payout = Math.floor(bet * spin.multiplier) + jackpot;
    if (payout) eco(ctx).credit(ctx.guildId, userId, payout, spin.jackpot ? 'slots JACKPOT' : 'slots win');
    record(ctx, userId, 'slots', bet, payout);
    result = { ...spin, payout, jackpotWon: jackpot, bet, balance: eco(ctx).wallet(ctx.guildId, userId).coins };
  });
  return result;
}

const reelLine = (shown) => `┃ ${shown.join(' ┃ ')} ┃`;
function slotsEmbed(ctx, r, stopped) {
  const shown = r.reels.map((x, k) => (k < stopped ? C.slotEmoji(x) : '🌀'));
  const e = new EmbedBuilder().setColor(COLORS.slots).setTitle('🎰 Slots').setDescription(`# ${reelLine(shown)}`)
    .setFooter({ text: `Bet ${fmtNum(r.bet)} · jackpot pool ${fmtNum(pool(ctx))}` });
  if (stopped < 3) return e;
  const net = r.payout - r.bet;
  const line = r.jackpotWon ? `💥 **JACKPOT!** You won ${money(ctx, r.payout)}!` : r.payout >= r.bet * 5 ? `🎉 **Big win!** ${C.slotMultiplier(r.reels)}x - you won ${money(ctx, r.payout)}`
    : r.payout > r.bet ? `✅ You won ${money(ctx, r.payout)} (${C.slotMultiplier(r.reels)}x)` : r.payout > 0 ? `😮 Close! ${money(ctx, r.payout)} back` : '❌ No luck this time.';
  return e.setColor(net > 0 ? COLORS.slots : COLORS.lose).setDescription(`# ${reelLine(shown)}\n${line}\nWallet: ${money(ctx, r.balance)}`);
}
function againRow(i, game, bet, label) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(againId(i, game, [bet])).setEmoji('🔁').setLabel(`${label} (${fmtNum(bet)})`).setStyle(ButtonStyle.Success),
    pipe.button(i, game, [], { label: 'Change bet', emoji: '✏️' }));
}
async function runSlots(ctx, i, bet, { update = false } = {}) {
  const r = playSlots(ctx, i.user.id, bet); // decided and paid now; the animation below only reveals it
  const first = { embeds: [slotsEmbed(ctx, r, 0)], components: [], allowedMentions: NOPING };
  if (update) await i.update(first); else await i.reply(first);
  for (const stopped of [1, 2]) { await sleep(frameMs()); await i.editReply({ embeds: [slotsEmbed(ctx, r, stopped)] }).catch(() => {}); }
  await sleep(frameMs());
  await i.editReply({ embeds: [slotsEmbed(ctx, r, 3)], components: [againRow(i, 'slots', bet, 'Spin again')] }).catch(() => {});
}

// ------------------------------------------------------------------ coin flip
async function runFlip(ctx, i, bet, side, { update = false } = {}) {
  let res;
  eco(ctx).transaction(ctx.guildId, () => {
    const landed = C.flipCoin();
    const payout = landed === side ? Math.floor(bet * C.COINFLIP_PAYOUT) : 0;
    if (payout) eco(ctx).credit(ctx.guildId, i.user.id, payout, 'coin flip win');
    record(ctx, i.user.id, 'coinflip', bet, payout);
    res = { landed, payout, balance: eco(ctx).wallet(ctx.guildId, i.user.id).coins };
  });
  const spinning = new EmbedBuilder().setColor(COLORS.coinflip).setTitle('🪙 Coin flip').setDescription(`You called **${side}** for ${money(ctx, bet)}...\n# 🪙 *flipping*`);
  if (update) await i.update({ embeds: [spinning], components: [] }); else await i.reply({ embeds: [spinning], allowedMentions: NOPING });
  await sleep(frameMs() * 1.5);
  const won = res.payout > 0;
  const done = new EmbedBuilder().setColor(won ? COLORS.coinflip : COLORS.lose).setTitle('🪙 Coin flip')
    .setDescription(`It landed on **${res.landed}**!\n${won ? `✅ You won ${money(ctx, res.payout)}` : `❌ You lost ${money(ctx, bet)}`}\nWallet: ${money(ctx, res.balance)}`);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(againId(i, 'coinflip', [bet, 'heads'])).setLabel('Heads again').setEmoji('🙂').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(againId(i, 'coinflip', [bet, 'tails'])).setLabel('Tails again').setEmoji('🪙').setStyle(ButtonStyle.Success),
    pipe.button(i, 'coinflip', [], { label: 'Change bet', emoji: '✏️' }));
  await i.editReply({ embeds: [done], components: [row] }).catch(() => {});
}

// ------------------------------------------------------------------ blackjack
const RESULT_TEXT = { win: '✅ You win!', blackjack: '🃏 **Blackjack!** Pays 3 to 2.', lose: '❌ Dealer wins.', bust: '💥 Bust! Over 21.', push: '🤝 Push - your bet is returned.', expired: '⌛ Table timed out - you stood automatically.' };
function bjEmbed(ctx, s, balance) {
  const pv = C.handValue(s.player), dv = C.handValue(s.dealer);
  const e = new EmbedBuilder().setColor(s.done ? (s.payout > s.bet ? COLORS.blackjack : s.payout === s.bet ? COLORS.push : COLORS.lose) : COLORS.blackjack)
    .setTitle(`🃏 Blackjack · bet ${fmtNum(s.bet)}${s.doubled ? ' (doubled)' : ''}`)
    .addFields(
      { name: `Dealer${s.done ? ` · ${dv.total}` : ''}`, value: C.cardsText(s.dealer, !s.done) },
      { name: `You · ${pv.total}${pv.soft && pv.total < 21 ? ' (soft)' : ''}`, value: C.cardsText(s.player) },
    );
  if (s.done) e.setDescription(`${RESULT_TEXT[s.result]}${s.payout ? ` ${money(ctx, s.payout)} back.` : ''}\nWallet: ${money(ctx, balance)}`);
  else e.setFooter({ text: 'Hit = another card · Stand = keep your hand · Double = double the bet, one card' });
  return e;
}
function bjButtons(i, id, s, bet) {
  if (s.done) return [againRow(i, 'blackjack', bet, 'Deal again')];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gm:bj:${id}:hit`).setLabel('Hit').setEmoji('➕').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gm:bj:${id}:stand`).setLabel('Stand').setEmoji('✋').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gm:bj:${id}:double`).setLabel('Double').setEmoji('💰').setStyle(ButtonStyle.Secondary).setDisabled(!C.bjCanDouble(s)))];
}
/** Pays a finished hand and removes the session in one transaction, so a double click can never pay twice. */
function bjFinish(ctx, id, userId, s) {
  if (s.payout) eco(ctx).credit(ctx.guildId, userId, s.payout, `blackjack ${s.result}`);
  record(ctx, userId, 'blackjack', s.bet, s.payout);
  dropSession(ctx, id);
}
async function startBlackjack(ctx, i, bet, { update = false } = {}) {
  if (activeSession(ctx, i.user.id, 'blackjack')) throw new UserError('You already have a hand in play. Finish it first!');
  const id = sid();
  let s, balance;
  eco(ctx).transaction(ctx.guildId, () => {
    takeBet(ctx, i.user.id, String(bet), 'blackjack bet');
    s = C.bjStart(bet);
    s.origBet = bet;
    if (s.done) bjFinish(ctx, id, i.user.id, s); else saveSession(ctx, id, i.user.id, 'blackjack', s);
    balance = eco(ctx).wallet(ctx.guildId, i.user.id).coins;
  });
  const msg = { embeds: [bjEmbed(ctx, s, balance)], components: bjButtons(i, id, s, bet), allowedMentions: NOPING };
  return update ? i.update(msg) : i.reply(msg);
}
async function blackjackClick(ctx, i, id, action) {
  let s, balance;
  eco(ctx).transaction(ctx.guildId, () => {
    s = loadSession(ctx, id, i.user.id, 'blackjack');
    if (action === 'double') {
      if (!C.bjCanDouble(s)) throw new UserError('You can only double on your first two cards.');
      eco(ctx).debit(ctx.guildId, i.user.id, s.bet, 'blackjack double');
      C.bjDouble(s);
    } else if (action === 'hit') C.bjHit(s);
    else if (action === 'stand') C.bjStand(s);
    else throw new UserError('Unknown move.');
    if (s.done) bjFinish(ctx, id, i.user.id, s); else saveSession(ctx, id, i.user.id, 'blackjack', s);
    balance = eco(ctx).wallet(ctx.guildId, i.user.id).coins;
  });
  return i.update({ embeds: [bjEmbed(ctx, s, balance)], components: bjButtons(i, id, s, s.origBet ?? s.bet) });
}

// ------------------------------------------------------------------ fishing: storage
function profile(ctx, userId) {
  ctx.sql.run('INSERT OR IGNORE INTO games_fish_profile (guild_id, user_id) VALUES (?, ?)', ctx.guildId, userId);
  const p = ctx.sql.get('SELECT * FROM games_fish_profile WHERE guild_id = ? AND user_id = ?', ctx.guildId, userId);
  return { ...p, rods: JSON.parse(p.rods), tackle: JSON.parse(p.tackle) };
}
const baitStock = (ctx, userId) => Object.fromEntries(ctx.sql.all('SELECT bait, qty FROM games_fish_bait WHERE guild_id = ? AND user_id = ? AND qty > 0', ctx.guildId, userId).map((r) => [r.bait, r.qty]));
function useBait(ctx, userId, bait) {
  if (bait === 'none') return;
  const r = ctx.sql.run('UPDATE games_fish_bait SET qty = qty - 1 WHERE guild_id = ? AND user_id = ? AND bait = ? AND qty > 0', ctx.guildId, userId, bait);
  if (!r.changes) throw new UserError(`You are out of ${F.baitById(bait).label}. Buy more in the shop, or fish without bait.`);
}

// ------------------------------------------------------------------ fishing: casting and reeling
function checkSetup(ctx, userId, { biome, rod, bait, tackle }) {
  const p = profile(ctx, userId);
  const { level } = F.levelFromXp(p.xp);
  const b = F.biomeById(biome);
  if (b.level > level) throw new UserError(`${b.label} unlocks at fishing level ${b.level}. You are level ${level}.`);
  if (!p.rods.includes(rod)) throw new UserError('You do not own that rod.');
  if (tackle !== 'none' && !p.tackle.includes(tackle)) throw new UserError('You do not own that tackle.');
  if (bait !== 'none' && !(baitStock(ctx, userId)[bait] > 0)) throw new UserError(`You are out of ${F.baitById(bait).label}.`);
  return p;
}
async function cast(ctx, i, setup, { update = false } = {}) {
  enabled(ctx, 'fishing');
  if (activeSession(ctx, i.user.id, 'fish')) throw new UserError('You already have a fish on the line. Finish reeling it in first!');
  const id = sid();
  let s;
  ctx.sql.transaction(() => {
    checkSetup(ctx, i.user.id, setup);
    useBait(ctx, i.user.id, setup.bait);
    const seed = randomInt(2 ** 31);
    const fish = F.rollCatch(setup, F.seeded(seed ^ 0x5bd1e995));
    s = F.startReel({ rod: setup.rod, tackle: setup.tackle, fish, seed });
    s.biome = setup.biome; s.bait = setup.bait;
    ctx.sql.run('UPDATE games_fish_profile SET casts = casts + 1, last_biome = ?, last_rod = ?, last_bait = ?, last_tackle = ? WHERE guild_id = ? AND user_id = ?',
      setup.biome, setup.rod, setup.bait, setup.tackle, ctx.guildId, i.user.id);
    saveSession(ctx, id, i.user.id, 'fish', s);
  });
  const msg = { embeds: [reelEmbed(ctx, s)], components: reelButtons(id), allowedMentions: NOPING };
  return update ? i.update(msg) : i.reply(msg);
}

const rarityHint = (r) => ({ legendary: '✨ Something **huge** is fighting back!', mythical: '🌟 The water is glowing... this is no ordinary fish.' }[r] ?? '🐟 Something bit!');
function reelEmbed(ctx, s) {
  const b = F.biomeById(s.biome);
  return new EmbedBuilder().setColor(COLORS.fish).setTitle(`${b.emoji} ${b.label} · reeling`)
    .setDescription(`${rarityHint(s.fish.rarity)}\n${F.reelPanel(s)}`)
    .setFooter({ text: `${F.rodById(s.rod).label} · ${F.baitById(s.bait).label} · ${F.tackleById(s.tackle).label} · keep the ◆ inside your ■ zone, then Reel` });
}
function reelButtons(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gm:fr:${id}:left`).setEmoji('◀️').setLabel('Pull').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gm:fr:${id}:reel`).setEmoji('🎣').setLabel('Reel').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gm:fr:${id}:right`).setEmoji('▶️').setLabel('Pull').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gm:fr:${id}:cut`).setEmoji('✂️').setStyle(ButtonStyle.Danger))];
}

/** Records a caught fish: bag, collection log, XP and profile records. Returns the level before and after. */
function landFish(ctx, userId, s) {
  const c = s.fish, sp = F.FISH[c.species];
  const before = F.levelFromXp(profile(ctx, userId).xp).level;
  const xp = F.catchXp(c);
  ctx.sql.run('INSERT INTO games_fish_bag (guild_id, user_id, species, rarity, mutation, giant, weight, value, biome, caught_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ctx.guildId, userId, c.species, c.rarity, c.mutation, c.giant ? 1 : 0, c.weight, c.value, sp.biome, Date.now());
  ctx.sql.run(`INSERT INTO games_fish_dex (guild_id, user_id, species, count, best_weight, first_at) VALUES (?, ?, ?, 1, ?, ?)
               ON CONFLICT(guild_id, user_id, species) DO UPDATE SET count = count + 1, best_weight = MAX(best_weight, excluded.best_weight)`, ctx.guildId, userId, c.species, c.weight, Date.now());
  ctx.sql.run('UPDATE games_fish_profile SET xp = xp + ?, caught = caught + 1, best_weight = MAX(best_weight, ?) WHERE guild_id = ? AND user_id = ?', xp, c.weight, ctx.guildId, userId);
  const after = F.levelFromXp(profile(ctx, userId).xp).level;
  return { xp, before, after };
}

function fishLine(c) {
  const sp = F.FISH[c.species], r = F.rarityById(c.rarity);
  const tags = [c.mutation && `${F.MUTATIONS[c.mutation].emoji} ${F.MUTATIONS[c.mutation].label}`, c.giant && '📏 Giant'].filter(Boolean).join(' · ');
  return `**${sp.name}** · ${r.label}${tags ? ` · ${tags}` : ''} · ${c.weight} kg`;
}

async function reelClick(ctx, i, id, action) {
  let s, landed;
  ctx.sql.transaction(() => {
    s = loadSession(ctx, id, i.user.id, 'fish');
    if (action === 'cut') Object.assign(s, { status: 'escaped', reason: 'cut' });
    else F.reelStep(s, action);
    if (s.status === 'reeling') return saveSession(ctx, id, i.user.id, 'fish', s);
    if (s.status === 'caught') landed = landFish(ctx, i.user.id, s);
    dropSession(ctx, id);
  });
  if (s.status === 'reeling') return i.update({ embeds: [reelEmbed(ctx, s)], components: reelButtons(id) });

  const b = F.biomeById(s.biome);
  const e = new EmbedBuilder().setTitle(`${b.emoji} ${b.label}`);
  if (s.status === 'caught') {
    const r = F.rarityById(s.fish.rarity);
    e.setColor(s.fish.mutation === 'corrupted' ? 0x2c2f33 : r.color)
      .setDescription([`🎉 You caught a ${fishLine(s.fish)}!`, `Worth ${money(ctx, s.fish.value)} · +${landed.xp} XP`,
        landed.after > landed.before ? `⬆️ **Fishing level ${landed.after}!**${unlockText(landed.before, landed.after)}` : null].filter(Boolean).join('\n'));
  } else {
    const why = { snapped: '💥 **Snap!** The line broke. Watch the tension bar, or fit a Steel Leader.', cut: '✂️ You cut the line.', idle: '⌛ You waited too long and it swam off.', tired: '😮‍💨 It tired you out and got away.' };
    e.setColor(COLORS.lose).setDescription(`${why[s.status === 'snapped' ? 'snapped' : s.reason] ?? '🐟 It got away!'}\nIt was a **${F.rarityById(s.fish.rarity).label}** fish.`);
  }
  return i.update({ embeds: [e], components: [afterCastRow(i)] });
}
function unlockText(before, after) {
  const unlocked = F.BIOMES.filter((x) => x.level > before && x.level <= after);
  return unlocked.length ? ` New place unlocked: ${unlocked.map((x) => `${x.emoji} **${x.label}**`).join(', ')}` : '';
}
function afterCastRow(i) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:again`).setEmoji('🎣').setLabel('Cast again').setStyle(ButtonStyle.Success),
    pipe.button(i, 'cast', [], { label: 'Change setup', emoji: '⚙️' }),
    new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:bag`).setEmoji('🎒').setLabel('Bag').setStyle(ButtonStyle.Secondary));
}
const lastSetup = (p) => ({ biome: p.last_biome ?? 'bay', rod: p.last_rod ?? 'driftwood', bait: p.last_bait ?? 'none', tackle: p.last_tackle ?? 'none' });

// ------------------------------------------------------------------ fishing: hub, bag, shop, collection
function hubMessage(ctx, i) {
  const p = profile(ctx, i.user.id);
  const lv = F.levelFromXp(p.xp);
  const bag = ctx.sql.get('SELECT COUNT(*) AS n, COALESCE(SUM(value), 0) AS v FROM games_fish_bag WHERE guild_id = ? AND user_id = ? AND sold = 0', ctx.guildId, i.user.id);
  const setup = lastSetup(p);
  const e = new EmbedBuilder().setColor(COLORS.fish).setTitle('🎣 Fishing')
    .setDescription(`Level **${lv.level}** ${F.meter((lv.into / lv.needed) * 100)} ${fmtNum(lv.into)}/${fmtNum(lv.needed)} XP`)
    .addFields(
      { name: 'Last setup', value: `${F.biomeById(setup.biome).emoji} ${F.biomeById(setup.biome).label}\n🎣 ${F.rodById(setup.rod).label} · 🪱 ${F.baitById(setup.bait).label} · 🧰 ${F.tackleById(setup.tackle).label}` },
      { name: 'Bag', value: `${fmtNum(bag.n)} fish worth ${money(ctx, bag.v)}`, inline: true },
      { name: 'Caught', value: `${fmtNum(p.caught)} of ${fmtNum(p.casts)} casts`, inline: true },
    ).setFooter({ text: 'Cast opens a form to pick where to fish, your rod, bait and tackle.' });
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(
    pipe.button(i, 'cast', [], { label: 'Cast', emoji: '🎣', style: ButtonStyle.Success }),
    new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:bag`).setEmoji('🎒').setLabel('Bag').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:shop`).setEmoji('🛒').setLabel('Shop').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:dex`).setEmoji('📖').setLabel('Collection').setStyle(ButtonStyle.Secondary))], flags: EPH, allowedMentions: NOPING };
}

function bagMessage(ctx, i, note) {
  const rows = ctx.sql.all('SELECT * FROM games_fish_bag WHERE guild_id = ? AND user_id = ? AND sold = 0 ORDER BY value DESC LIMIT 10', ctx.guildId, i.user.id);
  const tot = ctx.sql.get(`SELECT COUNT(*) AS n, COALESCE(SUM(value), 0) AS v,
      COALESCE(SUM(CASE WHEN rarity IN ('legendary', 'mythical') OR mutation IS NOT NULL THEN 0 ELSE value END), 0) AS cheap
      FROM games_fish_bag WHERE guild_id = ? AND user_id = ? AND sold = 0`, ctx.guildId, i.user.id);
  const e = new EmbedBuilder().setColor(COLORS.fish).setTitle('🎒 Your bag')
    .setDescription([note, rows.length ? rows.map((c) => `${fishLine(c)} · ${money(ctx, c.value)}`).join('\n') : '*Empty. Go catch something!*'].filter(Boolean).join('\n\n'))
    .setFooter({ text: `${fmtNum(tot.n)} fish · worth ${fmtNum(tot.v)} in total${tot.n > 10 ? ' · showing the 10 most valuable' : ''}` });
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:sellcommon`).setLabel(`Sell all but rare finds (${fmtNum(tot.cheap)})`).setEmoji('💰').setStyle(ButtonStyle.Success).setDisabled(!tot.cheap),
    new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:sellall`).setLabel(`Sell everything (${fmtNum(tot.v)})`).setEmoji('💰').setStyle(ButtonStyle.Danger).setDisabled(!tot.v),
    new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:hub`).setEmoji('↩️').setLabel('Back').setStyle(ButtonStyle.Secondary))], allowedMentions: NOPING };
}
function sellFish(ctx, userId, all) {
  let total = 0;
  ctx.sql.transaction(() => {
    const filter = all ? '' : "AND rarity NOT IN ('legendary', 'mythical') AND mutation IS NULL";
    total = ctx.sql.get(`SELECT COALESCE(SUM(value), 0) AS v FROM games_fish_bag WHERE guild_id = ? AND user_id = ? AND sold = 0 ${filter}`, ctx.guildId, userId).v;
    ctx.sql.run(`UPDATE games_fish_bag SET sold = 1 WHERE guild_id = ? AND user_id = ? AND sold = 0 ${filter}`, ctx.guildId, userId);
    if (total) eco(ctx).credit(ctx.guildId, userId, total, 'sold fish');
  });
  return total;
}

function shopMessage(ctx, i, note) {
  const p = profile(ctx, i.user.id);
  const lv = F.levelFromXp(p.xp).level;
  const stock = baitStock(ctx, i.user.id);
  const coins = eco(ctx).wallet(ctx.guildId, i.user.id).coins;
  const rodLines = F.RODS.filter((r) => r.price).map((r) => `${p.rods.includes(r.id) ? '✅' : r.level > lv ? '🔒' : '▫️'} **${r.label}** · ${fmtNum(r.price)} · lv ${r.level} · luck +${Math.round(r.luck * 100)}% · zone ${r.control}`);
  const tackleLines = F.TACKLE.filter((t) => t.price).map((t) => `${p.tackle.includes(t.id) ? '✅' : '▫️'} **${t.label}** · ${fmtNum(t.price)} · ${t.desc}`);
  const baitLines = F.BAITS.filter((b) => b.price).map((b) => `🪱 **${b.label}** · ${fmtNum(b.price)} each · luck +${Math.round(b.luck * 100)}%${b.corruption ? ' · draws corruption' : ''} · you have ${stock[b.id] ?? 0}`);
  const e = new EmbedBuilder().setColor(COLORS.fish).setTitle('🛒 Tackle shop').setDescription([note, `You have ${money(ctx, coins)}`].filter(Boolean).join('\n'))
    .addFields({ name: 'Rods', value: rodLines.join('\n') }, { name: 'Tackle (kept forever)', value: tackleLines.join('\n') }, { name: 'Bait (one per cast)', value: baitLines.join('\n') });
  const options = [
    ...F.RODS.filter((r) => r.price && !p.rods.includes(r.id) && r.level <= lv).map((r) => ({ label: `${r.label} (${fmtNum(r.price)})`, value: `rod-${r.id}`, emoji: '🎣' })),
    ...F.TACKLE.filter((t) => t.price && !p.tackle.includes(t.id)).map((t) => ({ label: `${t.label} (${fmtNum(t.price)})`, value: `tackle-${t.id}`, emoji: '🧰' })),
    ...F.BAITS.filter((b) => b.price).map((b) => ({ label: `${b.label} (${fmtNum(b.price)} each)`, value: `bait-${b.id}`, emoji: '🪱', description: 'Choose how many in a form' })),
  ];
  const rows = [];
  if (options.length) {
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`gm:fs:${i.user.id}`).setPlaceholder('Buy something...')
      .addOptions(options.slice(0, 25).map((o) => { const b = new StringSelectMenuOptionBuilder().setLabel(o.label).setValue(o.value).setEmoji(o.emoji); if (o.description) b.setDescription(o.description); return b; }))));
  }
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:hub`).setEmoji('↩️').setLabel('Back').setStyle(ButtonStyle.Secondary)));
  return { embeds: [e], components: rows, allowedMentions: NOPING };
}
function buyItem(ctx, userId, value, qty = 1) {
  const [kind, id] = value.split('-');
  const p = profile(ctx, userId);
  let label;
  ctx.sql.transaction(() => {
    if (kind === 'rod') {
      const r = F.RODS.find((x) => x.id === id && x.price);
      if (!r) throw new UserError('That rod is not for sale.');
      if (p.rods.includes(id)) throw new UserError('You already own that rod.');
      if (r.level > F.levelFromXp(p.xp).level) throw new UserError(`That rod needs fishing level ${r.level}.`);
      eco(ctx).debit(ctx.guildId, userId, r.price, `bought ${r.label}`);
      ctx.sql.run('UPDATE games_fish_profile SET rods = ?, last_rod = ? WHERE guild_id = ? AND user_id = ?', JSON.stringify([...p.rods, id]), id, ctx.guildId, userId);
      label = r.label;
    } else if (kind === 'tackle') {
      const t = F.TACKLE.find((x) => x.id === id && x.price);
      if (!t) throw new UserError('That tackle is not for sale.');
      if (p.tackle.includes(id)) throw new UserError('You already own that.');
      eco(ctx).debit(ctx.guildId, userId, t.price, `bought ${t.label}`);
      ctx.sql.run('UPDATE games_fish_profile SET tackle = ? WHERE guild_id = ? AND user_id = ?', JSON.stringify([...p.tackle, id]), ctx.guildId, userId);
      label = t.label;
    } else if (kind === 'bait') {
      const b = F.BAITS.find((x) => x.id === id && x.price);
      if (!b) throw new UserError('That bait is not for sale.');
      eco(ctx).debit(ctx.guildId, userId, b.price * qty, `bought ${qty} ${b.label}`);
      ctx.sql.run('INSERT INTO games_fish_bait (guild_id, user_id, bait, qty) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, user_id, bait) DO UPDATE SET qty = qty + excluded.qty', ctx.guildId, userId, id, qty);
      label = `${qty} × ${b.label}`;
    } else throw new UserError('That is not for sale.');
  });
  return label;
}

function dexMessage(ctx, i) {
  const seen = Object.fromEntries(ctx.sql.all('SELECT species, count, best_weight FROM games_fish_dex WHERE guild_id = ? AND user_id = ?', ctx.guildId, i.user.id).map((r) => [r.species, r]));
  const total = Object.keys(F.FISH).length, found = Object.keys(seen).length;
  const e = new EmbedBuilder().setColor(COLORS.fish).setTitle(`📖 Collection · ${found}/${total}`)
    .setDescription(`${F.meter((found / total) * 100, 15)} Catch every fish in every place.`);
  for (const b of F.BIOMES) {
    const list = Object.values(F.FISH).filter((f) => f.biome === b.id);
    const have = list.filter((f) => seen[f.id]).length;
    e.addFields({ name: `${b.emoji} ${b.label} · ${have}/${list.length}`, value: list.map((f) => (seen[f.id] ? `✅ ${f.name} (best ${seen[f.id].best_weight} kg)` : `❔ ${F.rarityById(f.rarity).label} fish`)).join('\n'), inline: true });
  }
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:hub`).setEmoji('↩️').setLabel('Back').setStyle(ButtonStyle.Secondary))], allowedMentions: NOPING };
}

async function hubClick(ctx, i, owner, view) {
  if (owner !== i.user.id) return i.reply({ ...hubMessage(ctx, i), content: 'That menu belongs to someone else, so here is your own.' });
  if (view === 'again') return cast(ctx, i, lastSetup(profile(ctx, i.user.id)), { update: false });
  if (view === 'bag') return i.update(bagMessage(ctx, i));
  if (view === 'shop') return i.update(shopMessage(ctx, i));
  if (view === 'dex') return i.update(dexMessage(ctx, i));
  if (view === 'hub') { const { flags, ...m } = hubMessage(ctx, i); return i.update(m); }
  if (view === 'sellall' || view === 'sellcommon') {
    const got = sellFish(ctx, i.user.id, view === 'sellall');
    return i.update(bagMessage(ctx, i, got ? `💰 Sold for ${money(ctx, got)}.` : 'Nothing to sell.'));
  }
  throw new UserError('That button is no longer active.');
}
async function shopSelect(ctx, i, owner) {
  if (owner !== i.user.id) throw new UserError('That shop belongs to someone else. Run `/fish` for your own.');
  const value = i.values?.[0] ?? '';
  if (value.startsWith('bait-')) return pipe.open(ctx, i, 'buybait', [value.slice(5)]); // quantity is typed, so: popup
  const label = buyItem(ctx, i.user.id, value);
  return i.update(shopMessage(ctx, i, `✅ Bought **${label}**.`));
}

// ------------------------------------------------------------------ popups
const betField = (ctx, label = 'Bet') => ({ id: 'bet', label, placeholder: `${fmtNum(ctx.config.get('minBet'))} to ${fmtNum(ctx.config.get('maxBet'))}, or half / all`, max: 20 });
const betIntro = (ctx, i, extra = '') => `You have ${money(ctx, eco(ctx).wallet(ctx.guildId, i.user.id).coins)}. Bets go from ${money(ctx, ctx.config.get('minBet'))} to ${money(ctx, ctx.config.get('maxBet'))}.${extra}`;

const pipe = createPipeline({
  ns: 'mpg',
  forms: {
    slots: {
      title: 'Slots: set your bet', permission: 'games.play', color: COLORS.slots,
      button: { label: 'Set bet', emoji: '🎰', style: ButtonStyle.Success },
      precheck: (ctx) => enabled(ctx, 'slots'),
      intro: (ctx, i) => betIntro(ctx, i, `\nThe jackpot pool is ${money(ctx, pool(ctx))}. Three 7️⃣ wins it all.`),
      fields: (ctx) => [betField(ctx)],
      async submit(ctx, i, v) { return runSlots(ctx, i, takeBet(ctx, i.user.id, v.bet, 'slots bet')); },
    },
    coinflip: {
      title: 'Coin flip: set your bet', permission: 'games.play', color: COLORS.coinflip,
      button: { label: 'Set bet', emoji: '🪙', style: ButtonStyle.Success },
      precheck: (ctx) => enabled(ctx, 'coinflip'),
      intro: (ctx, i) => betIntro(ctx, i, `\nCall it right and win ${C.COINFLIP_PAYOUT}x your bet.`),
      fields: (ctx) => [betField(ctx), { id: 'side', kind: 'select', label: 'Your call', value: 'heads', options: [{ label: 'Heads', value: 'heads' }, { label: 'Tails', value: 'tails' }] }],
      async submit(ctx, i, v) { return runFlip(ctx, i, takeBet(ctx, i.user.id, v.bet, 'coin flip bet'), v.side === 'tails' ? 'tails' : 'heads'); },
    },
    blackjack: {
      title: 'Blackjack: set your bet', permission: 'games.play', color: COLORS.blackjack,
      button: { label: 'Set bet', emoji: '🃏', style: ButtonStyle.Success },
      precheck: (ctx, i) => { enabled(ctx, 'blackjack'); if (activeSession(ctx, i.user.id, 'blackjack')) throw new UserError('You already have a hand in play. Finish it first!'); },
      intro: (ctx, i) => betIntro(ctx, i, '\nBlackjack pays 3 to 2. Dealer stands on 17.'),
      fields: (ctx) => [betField(ctx)],
      async submit(ctx, i, v) {
        const have = eco(ctx).wallet(ctx.guildId, i.user.id).coins;
        const amt = parseAmount(v.bet, { have, min: ctx.config.get('minBet'), max: ctx.config.get('maxBet') });
        if (amt.error) throw new UserError(amt.error);
        return startBlackjack(ctx, i, amt.value);
      },
    },
    cast: {
      title: 'Cast your line', permission: 'games.play', color: COLORS.fish,
      button: { label: 'Choose setup', emoji: '🎣', style: ButtonStyle.Success },
      precheck: (ctx) => enabled(ctx, 'fishing'),
      intro: 'Pick where to fish, your rod, bait and tackle. Better rods catch rarer fish and make reeling easier.',
      fields(ctx, i) {
        const p = profile(ctx, i.user.id), last = lastSetup(p), lv = F.levelFromXp(p.xp).level, stock = baitStock(ctx, i.user.id);
        return [
          { id: 'biome', kind: 'select', label: 'Where to fish', value: F.biomeById(last.biome).level <= lv ? last.biome : 'bay',
            options: F.BIOMES.filter((b) => b.level <= lv).map((b) => ({ label: `${b.label}`, value: b.id, description: b.blurb })) },
          { id: 'rod', kind: 'select', label: 'Rod', value: last.rod,
            options: F.RODS.filter((r) => p.rods.includes(r.id)).map((r) => ({ label: r.label, value: r.id, description: `Luck +${Math.round(r.luck * 100)}% · zone ${r.control} · power ${r.power} · line ${r.line}` })) },
          { id: 'bait', kind: 'select', label: 'Bait', value: last.bait !== 'none' && stock[last.bait] ? last.bait : 'none',
            options: F.BAITS.filter((b) => b.id === 'none' || stock[b.id] > 0).map((b) => ({ label: b.id === 'none' ? b.label : `${b.label} (${stock[b.id]} left)`, value: b.id, description: b.id === 'none' ? 'Free, no bonus' : `Luck +${Math.round(b.luck * 100)}%` })) },
          { id: 'tackle', kind: 'select', label: 'Tackle', value: p.tackle.includes(last.tackle) ? last.tackle : 'none',
            options: F.TACKLE.filter((t) => t.id === 'none' || p.tackle.includes(t.id)).map((t) => ({ label: t.label, value: t.id, description: t.desc })) },
        ];
      },
      async submit(ctx, i, v) { return cast(ctx, i, { biome: v.biome ?? 'bay', rod: v.rod ?? 'driftwood', bait: v.bait ?? 'none', tackle: v.tackle ?? 'none' }); },
    },
    buybait: {
      title: 'Buy bait', permission: 'games.play', color: COLORS.fish,
      button: { label: 'Choose amount', emoji: '🪱' },
      fields: (ctx, i, [bait]) => [{ id: 'qty', label: `How many ${F.baitById(bait).label}?`.slice(0, 45), placeholder: `${fmtNum(F.baitById(bait).price)} coins each, up to 500`, max: 5, value: '10' }],
      async submit(ctx, i, v, [bait]) {
        const n = parseAmount(v.qty, { min: 1, max: 500 });
        if (n.error) throw new UserError(n.error);
        const label = buyItem(ctx, i.user.id, `bait-${bait}`, n.value);
        return i.reply({ content: `✅ Bought **${label}**.`, flags: EPH });
      },
    },
  },
});

// ------------------------------------------------------------------ buttons
async function gameClick(ctx, i) {
  const [, kind, a, b] = i.customId.split(':');
  if (kind === 'bj') return blackjackClick(ctx, i, a, b);
  if (kind === 'fr') return reelClick(ctx, i, a, b);
  if (kind === 'fh') return hubClick(ctx, i, a, b);
  if (kind === 'fs') return shopSelect(ctx, i, a);
  if (kind === 'ar') return arcadeClick(ctx, i, a);
  throw new UserError('That button is no longer active.');
}
/** Signed "again" buttons: same game, same bet, one click. */
async function againClick(ctx, i) {
  const tok = unpackToken(i.customId, { ns: 'gmx', userId: i.user.id, maxAgeMs: 60 * 60000 });
  if (!ctx.perms.check(i.member, 'games.play')) throw new UserError('You don\'t have permission to play.');
  const [bet, side] = tok.args;
  if (tok.form === 'slots') { enabled(ctx, 'slots'); return runSlots(ctx, i, takeBet(ctx, i.user.id, bet, 'slots bet'), { update: false }); }
  if (tok.form === 'coinflip') { enabled(ctx, 'coinflip'); return runFlip(ctx, i, takeBet(ctx, i.user.id, bet, 'coin flip bet'), side === 'tails' ? 'tails' : 'heads', { update: false }); }
  if (tok.form === 'blackjack') { enabled(ctx, 'blackjack'); return startBlackjack(ctx, i, Number(bet), { update: true }); }
  throw new UserError('That button is no longer active.');
}

// One public panel for everyone: each button opens that game's popup for whoever clicked (the click is the trigger).
const ARCADE = [['slots', '🎰', 'Slots'], ['blackjack', '🃏', 'Blackjack'], ['coinflip', '🪙', 'Coin flip'], ['fish', '🎣', 'Fishing']];
async function arcadeClick(ctx, i, game) {
  if (game === 'fish') { enabled(ctx, 'fishing'); return i.reply(hubMessage(ctx, i)); }
  if (!ARCADE.some(([g]) => g === game)) throw new UserError('That game is not available.');
  return pipe.open(ctx, i, game);
}
function arcadePanel(ctx) {
  const e = new EmbedBuilder().setColor(COLORS.slots).setTitle('🕹️ Arcade')
    .setDescription(`Pick a game. Each button opens a private form just for you.\n\n🎰 **Slots** · jackpot pool ${money(ctx, pool(ctx))}\n🃏 **Blackjack** · pays 3 to 2\n🪙 **Coin flip** · ${C.COINFLIP_PAYOUT}x\n🎣 **Fishing** · ${F.BIOMES.length} places, ${Object.keys(F.FISH).length} fish to collect`)
    .setFooter({ text: 'Play money only. Coins cannot be bought or cashed out.' });
  const games = new ActionRowBuilder().addComponents(ARCADE.map(([g, emoji, label]) => new ButtonBuilder().setCustomId(`gm:ar:${g}`).setEmoji(emoji).setLabel(label).setStyle(ButtonStyle.Primary)));
  const extra = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('econ:daily:panel').setEmoji('🎁').setLabel('Daily').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('econ:top:panel').setEmoji('🏆').setLabel('Leaderboard').setStyle(ButtonStyle.Secondary));
  return { embeds: [e], components: [games, extra], allowedMentions: NOPING };
}

// ------------------------------------------------------------------ module
const gameCommand = (name, description, form) => ({
  permission: 'games.play',
  data: new SlashCommandBuilder().setName(name).setDescription(description),
  execute: (ctx, i) => pipe.launch(ctx, i, form),
});

export default {
  name: 'games',
  version: '1.0.0',
  description: 'Slots, blackjack, coin flip and fishing, played with economy coins',
  dependencies: [{ module: 'economy', version: '>=1.0.0' }],
  settings: [
    { key: 'slotsEnabled', type: 'toggle', label: 'Slots', default: true },
    { key: 'blackjackEnabled', type: 'toggle', label: 'Blackjack', default: true },
    { key: 'coinflipEnabled', type: 'toggle', label: 'Coin flip', default: true },
    { key: 'fishingEnabled', type: 'toggle', label: 'Fishing', default: true },
    { key: 'minBet', type: 'number', label: 'Smallest bet', default: 10, min: 1, max: 1000000 },
    { key: 'maxBet', type: 'number', label: 'Biggest bet', default: 50000, min: 1, max: 100000000 },
    { key: 'jackpotSeed', type: 'number', label: 'Jackpot pool starts at', default: 5000, min: 0, max: 100000000 },
    { key: 'jackpotPercent', type: 'number', label: 'Share of each slots bet added to the jackpot (%)', default: 3, min: 0, max: 20 },
  ],
  permissions: [
    { key: 'games.play', label: 'Play games', default: 'everyone' },
    { key: 'games.admin', label: 'Post the arcade panel', default: 'admin' },
  ],
  migrations: [{
    id: 1,
    sql: `CREATE TABLE games_sessions (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
          CREATE INDEX games_sessions_user ON games_sessions (guild_id, user_id, kind);
          CREATE TABLE games_jackpot (guild_id TEXT PRIMARY KEY, pool INTEGER NOT NULL);
          CREATE TABLE games_stats (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, game TEXT NOT NULL, played INTEGER NOT NULL DEFAULT 0, won INTEGER NOT NULL DEFAULT 0,
            wagered INTEGER NOT NULL DEFAULT 0, returned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, user_id, game));
          CREATE TABLE games_fish_profile (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0, casts INTEGER NOT NULL DEFAULT 0, caught INTEGER NOT NULL DEFAULT 0,
            best_weight REAL NOT NULL DEFAULT 0, rods TEXT NOT NULL DEFAULT '["driftwood"]', tackle TEXT NOT NULL DEFAULT '[]',
            last_biome TEXT, last_rod TEXT, last_bait TEXT, last_tackle TEXT, PRIMARY KEY (guild_id, user_id));
          CREATE TABLE games_fish_bait (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, bait TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, user_id, bait));
          CREATE TABLE games_fish_bag (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, species TEXT NOT NULL, rarity TEXT NOT NULL, mutation TEXT,
            giant INTEGER NOT NULL DEFAULT 0, weight REAL NOT NULL, value INTEGER NOT NULL, biome TEXT NOT NULL, caught_at INTEGER NOT NULL, sold INTEGER NOT NULL DEFAULT 0);
          CREATE INDEX games_fish_bag_user ON games_fish_bag (guild_id, user_id, sold);
          CREATE TABLE games_fish_dex (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, species TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, best_weight REAL NOT NULL DEFAULT 0,
            first_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id, species));`,
  }],
  commands: [
    gameCommand('slots', 'Spin the slots (opens a bet form)', 'slots'),
    gameCommand('blackjack', 'Play a hand of blackjack (opens a bet form)', 'blackjack'),
    gameCommand('coinflip', 'Bet on a coin flip (opens a bet form)', 'coinflip'),
    {
      permission: 'games.play',
      data: new SlashCommandBuilder().setName('fish').setDescription('Go fishing: cast, reel, collect and upgrade your gear'),
      async execute(ctx, i) { enabled(ctx, 'fishing'); return i.reply(hubMessage(ctx, i)); },
    },
    {
      permission: 'games.admin',
      data: new SlashCommandBuilder().setName('arcade').setDescription('(Admins) Post a game panel in this channel that anyone can use'),
      async execute(ctx, i) {
        await i.channel.send(arcadePanel(ctx));
        return i.reply({ content: '✅ Arcade panel posted.', flags: EPH });
      },
    },
  ],
  components: [pipe.component, { prefix: 'gmx:', execute: againClick }, { prefix: 'gm:', execute: gameClick }],
  tasks: [{
    // Hands and fights nobody finished: blackjack stands automatically (and pays), fishing fights end.
    name: 'expire-sessions', everyMs: 60000,
    async run(ctx) {
      const old = ctx.sql.all('SELECT * FROM games_sessions WHERE guild_id = ? AND updated_at < ?', ctx.guildId, Date.now() - SESSION_MAX_MS);
      for (const row of old) {
        try {
          ctx.sql.transaction(() => {
            if (row.kind === 'blackjack') { const s = C.bjStand(JSON.parse(row.state)); bjFinish(ctx, row.id, row.user_id, s); }
            else dropSession(ctx, row.id);
          });
        } catch (e) { ctx.log.warn(`Could not close game session ${row.id}: ${e.message}`); }
      }
    },
  }],
  async init(ctx) {
    const api = ctx.api('economy');
    if (!api) return;
    // Registered on every start/reload so the newest code formats the rows.
    const name = 'LEFT JOIN economy_wallets w ON w.guild_id = x.guild_id AND w.user_id = x.user_id';
    api.registerBoard({ id: 'fish', module: 'games', label: 'Most fish caught', emoji: '🎣', source: `SELECT x.guild_id, x.user_id, w.name, x.caught AS value FROM games_fish_profile x ${name} WHERE x.caught > 0`, format: (c, v) => `**${fmtNum(v)}** fish` });
    api.registerBoard({ id: 'heaviest', module: 'games', label: 'Heaviest catch', emoji: '⚖️', source: `SELECT x.guild_id, x.user_id, w.name, x.best_weight AS value FROM games_fish_profile x ${name} WHERE x.best_weight > 0`, format: (c, v) => `**${v}** kg` });
    api.registerBoard({ id: 'fishlevel', module: 'games', label: 'Fishing level', emoji: '⭐', source: `SELECT x.guild_id, x.user_id, w.name, x.xp AS value FROM games_fish_profile x ${name} WHERE x.xp > 0`, format: (c, v) => `level **${F.levelFromXp(v).level}** · ${fmtNum(v)} XP` });
    api.registerBoard({ id: 'casino', module: 'games', label: 'Casino winnings', emoji: '🎰', source: `SELECT x.guild_id, x.user_id, w.name, SUM(x.returned - x.wagered) AS value FROM games_stats x ${name} GROUP BY x.guild_id, x.user_id HAVING SUM(x.returned - x.wagered) > 0`, format: (c, v) => `+${money(c, v)}` });
  },
};
