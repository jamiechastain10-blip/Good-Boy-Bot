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
import * as PONG from '../../src/pong.js';
import * as CH from '../../src/fishchallenges.js';
import { makeMinigames, GAMES as MINI } from './minigames.js';
import { TRIVIA_CATEGORIES } from '../../src/minigames.js';
import { UserError, sleep, truncate } from '../../src/util.js';
import { emoji as EM, emojiRef } from '../../src/emojis.js';
import * as ART from '../../src/gameart.js';

const EPH = MessageFlags.Ephemeral;
// Game results are private to the player by default: a public message per play notified everyone following the channel.
const vis = (ctx) => (ctx.config.get('privateGames') ? { flags: EPH } : {});
/** One public line for a big moment (jackpot, huge win, rare fish). Names only, never a ping. */
// Big-win lines are off by default (2.3.2): a public line per rare fish turned into channel spam for active fishers.
// When an admin turns them on, only the chosen moments count, each member gets at most one line every 10 minutes
// (jackpots always), and the lines can go to their own channel.
const shoutAt = new Map(); // guild:user -> last shout time
const SHOUT_LEVELS = { jackpots: ['jackpot'], mythical: ['jackpot', 'mythical'], rare: ['jackpot', 'mythical', 'legendary', 'mutated', 'bigwin'] };
export function shouldShout(cfg, kind, last, now = Date.now()) {
  if (!cfg.announceBigWins) return false;
  if (!(SHOUT_LEVELS[cfg.bigWinLevel] ?? SHOUT_LEVELS.mythical).includes(kind)) return false;
  return kind === 'jackpot' || !last || now - last > 10 * 60000;
}
function shout(ctx, i, text, kind) {
  const key = `${ctx.guildId}:${i.user.id}`;
  if (!shouldShout({ announceBigWins: ctx.config.get('announceBigWins'), bigWinLevel: ctx.config.get('bigWinLevel') }, kind, shoutAt.get(key))) return;
  const ch = ctx.guild?.channels.cache.get(ctx.config.get('bigWinChannel')) ?? i.channel;
  if (!ch?.send) return;
  shoutAt.set(key, Date.now());
  ctx.queue(() => ch.send({ content: text, allowedMentions: NOPING })).catch(() => {});
}
const nameOf = (i) => `**${String(i.member?.displayName ?? i.user.globalName ?? i.user.username).replace(/[*_`~|>@]/g, '')}**`;
const NOPING = { parse: [] };
const SESSION_MAX_MS = 10 * 60000;
const COLORS = { slots: 0xe91e63, blackjack: 0x2ecc71, coinflip: 0xf1c40f, fish: 0x1abc9c, lose: 0xed4245, push: 0x95a5a6 };
/** Delay between animation frames. Tests set the global to 0. */
const frameMs = () => globalThis[Symbol.for('goodboy.games.frameMs')] ?? 750;
// 3.0.4: games are drawn as animated pictures when the canvas package is installed and the server has not turned them off.
const artOn = (ctx) => globalThis[Symbol.for('goodboy.games.art')] !== false && ctx.config.get('gamePictures') !== false;
/** A message with the game's picture in the embed (or just the embed when there is no picture). edit: replace old files. */
function withArt(embed, art, { edit = false } = {}) {
  if (!art) return { embeds: [embed], ...(edit ? { files: [], attachments: [] } : {}) };
  embed.setImage(`attachment://${art.name}`);
  // 3.0.4: the pictures are new, so players are told they are being tested.
  const foot = embed.data.footer?.text;
  embed.setFooter({ text: foot ? `🧪 Being tested · ${foot}` : '🧪 Animated games are being tested. Tell staff if something looks wrong.' });
  return { embeds: [embed], files: [{ attachment: art.file, name: art.name }], ...(edit ? { attachments: [] } : {}) };
}

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

// 3.1 arcade games (Tower, Wires, Bingo, Memory, Hangman, Trivia): modules/games/minigames.js
const mini = makeMinigames({ saveSession, loadSession, dropSession, activeSession, eco: (ctx) => eco(ctx), money: (ctx, n) => money(ctx, n), record, sid, vis: (ctx) => vis(ctx) });

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
  const who = eco(ctx).wallet(ctx.guildId, userId).name ?? 'Someone';
  if (result.jackpotWon) ctx.live('activity', { icon: '💥', text: `${who} hit the slots JACKPOT` });
  else if (result.payout >= bet * 20) ctx.live('activity', { icon: '🎰', text: `${who} won ${result.multiplier}x on slots` });
  return result;
}

const reelLine = (shown) => `┃ ${shown.join(' ┃ ')} ┃`;
function slotsEmbed(ctx, r, stopped) {
  const shown = r.reels.map((x, k) => (k < stopped ? C.slotEmoji(x) : EM('slot')));
  const e = new EmbedBuilder().setColor(COLORS.slots).setTitle(`${EM('slot')} Slots · ${EM('coin')} ${fmtNum(r.bet)}`).setDescription(`# ${reelLine(shown)}`)
    .setFooter({ text: `Bet ${fmtNum(r.bet)} · jackpot pool ${fmtNum(pool(ctx))}` });
  if (stopped < 3) return e;
  const net = r.payout - r.bet;
  const line = r.jackpotWon ? `${EM('win')} **JACKPOT!** You won ${money(ctx, r.payout)}! ${EM('coins')}` : r.payout >= r.bet * 5 ? `${EM('win')} **Big win!** ${C.slotMultiplier(r.reels)}x - you won ${money(ctx, r.payout)}`
    : r.payout > r.bet ? `${EM('coins')} You won ${money(ctx, r.payout)} (${C.slotMultiplier(r.reels)}x)` : r.payout > 0 ? `😮 Close! ${money(ctx, r.payout)} back` : `${EM('lose')} No luck this time.`;
  return e.setColor(net > 0 ? COLORS.slots : COLORS.lose).setDescription(`# ${reelLine(shown)}\n${line}\nWallet: ${money(ctx, r.balance)}`);
}
function againRow(i, game, bet, label) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(againId(i, game, [bet])).setEmoji('🔁').setLabel(`${label} (${fmtNum(bet)})`).setStyle(ButtonStyle.Success),
    pipe.button(i, game, [], { label: 'Change bet', emoji: '✏️' }));
}
async function slotsArt(ctx, r) {
  if (!artOn(ctx)) return null;
  const mult = C.slotMultiplier(r.reels);
  const note = r.jackpotWon ? `JACKPOT! +${fmtNum(r.payout - r.bet)}` : r.payout > r.bet ? `${mult}x · +${fmtNum(r.payout - r.bet)}` : r.payout > 0 ? `Close! ${fmtNum(r.payout)} back` : 'No luck this time';
  return ART.slotsImage({ symbols: r.reels.map((x) => C.slotEmoji(x)), note, win: r.payout > r.bet });
}
async function runSlots(ctx, i, bet, { update = false } = {}) {
  const r = playSlots(ctx, i.user.id, bet); // decided and paid now; the animation below only reveals it
  const art = await slotsArt(ctx, r);
  if (art) {
    // One message: the picture spins the reels, stops them one by one and shows the result.
    const e = new EmbedBuilder().setColor(r.payout > r.bet ? COLORS.slots : COLORS.lose).setTitle(`${EM('slot')} Slots · ${EM('coin')} ${fmtNum(r.bet)}`)
      .setDescription(`Wallet: ${money(ctx, r.balance)}`).setFooter({ text: `Bet ${fmtNum(r.bet)} · jackpot pool ${fmtNum(pool(ctx))}` });
    const msg = { ...withArt(e, art, { edit: update }), components: [againRow(i, 'slots', bet, 'Spin again')], allowedMentions: NOPING };
    if (update) await i.update(msg); else await i.reply({ ...msg, ...vis(ctx) });
    if (r.jackpotWon) shout(ctx, i, `💥 ${nameOf(i)} hit the slots **JACKPOT** and won ${money(ctx, r.payout)}!`, 'jackpot');
    else if (r.payout >= bet * 20) shout(ctx, i, `🎰 ${nameOf(i)} won **${r.multiplier}x** on slots (${money(ctx, r.payout)})!`, 'bigwin');
    return;
  }
  const first = { embeds: [slotsEmbed(ctx, r, 0)], components: [], allowedMentions: NOPING };
  if (update) await i.update(first); else await i.reply({ ...first, ...vis(ctx) });
  for (const stopped of [1, 2]) { await sleep(frameMs()); await i.editReply({ embeds: [slotsEmbed(ctx, r, stopped)] }).catch(() => {}); }
  await sleep(frameMs());
  await i.editReply({ embeds: [slotsEmbed(ctx, r, 3)], components: [againRow(i, 'slots', bet, 'Spin again')] }).catch(() => {});
  if (r.jackpotWon) shout(ctx, i, `💥 ${nameOf(i)} hit the slots **JACKPOT** and won ${money(ctx, r.payout)}!`, 'jackpot');
  else if (r.payout >= bet * 20) shout(ctx, i, `🎰 ${nameOf(i)} won **${r.multiplier}x** on slots (${money(ctx, r.payout)})!`, 'bigwin');
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
  const row0 = () => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(againId(i, 'coinflip', [bet, 'heads'])).setLabel('Heads again').setEmoji('🙂').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(againId(i, 'coinflip', [bet, 'tails'])).setLabel('Tails again').setEmoji('🪙').setStyle(ButtonStyle.Success),
    pipe.button(i, 'coinflip', [], { label: 'Change bet', emoji: '✏️' }));
  const art = artOn(ctx) ? await ART.coinImage({ side: res.landed, won: res.payout > 0, note: res.payout > 0 ? `You called ${side} · +${fmtNum(res.payout - bet)}` : `You called ${side} · -${fmtNum(bet)}` }) : null;
  if (art) {
    const e = new EmbedBuilder().setColor(res.payout > 0 ? COLORS.coinflip : COLORS.lose).setTitle(`${EM('coin')} Coin flip · ${EM('coin')} ${fmtNum(bet)}`).setDescription(`Wallet: ${money(ctx, res.balance)}`);
    const msg = { ...withArt(e, art, { edit: update }), components: [row0()], allowedMentions: NOPING };
    return update ? i.update(msg) : i.reply({ ...msg, ...vis(ctx) });
  }
  const spinning = new EmbedBuilder().setColor(COLORS.coinflip).setTitle(`${EM('coin')} Coin flip`).setDescription(`You called **${side}** for ${money(ctx, bet)}...\n# ${EM('coin')} *flipping*`);
  if (update) await i.update({ embeds: [spinning], components: [] }); else await i.reply({ embeds: [spinning], allowedMentions: NOPING, ...vis(ctx) });
  await sleep(frameMs() * 1.5);
  const won = res.payout > 0;
  const done = new EmbedBuilder().setColor(won ? COLORS.coinflip : COLORS.lose).setTitle(`${EM('coin')} Coin flip`)
    .setDescription(`# ${won ? EM('win') : EM('lose')} ${res.landed === 'heads' ? 'Heads' : 'Tails'}\n${won ? `${EM('coins')} You won ${money(ctx, res.payout)}` : `You lost ${money(ctx, bet)}`}\nWallet: ${money(ctx, res.balance)}`);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(againId(i, 'coinflip', [bet, 'heads'])).setLabel('Heads again').setEmoji('🙂').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(againId(i, 'coinflip', [bet, 'tails'])).setLabel('Tails again').setEmoji('🪙').setStyle(ButtonStyle.Success),
    pipe.button(i, 'coinflip', [], { label: 'Change bet', emoji: '✏️' }));
  await i.editReply({ embeds: [done], components: [row] }).catch(() => {});
}

// ------------------------------------------------------------------ blackjack
const RESULT_TEXT = { win: 'You win', blackjack: 'Blackjack! Pays 3 to 2', lose: 'Dealer wins', bust: 'Bust, over 21', push: 'Push, your bet is back', expired: 'Table timed out, you stood' };
const BJ_TIPS = ['Doubling on 11 wins more often than not.', 'The dealer must draw to 16 and stand on 17.', 'A soft hand has an ace counted as 11: it cannot bust on the next card.', 'Standing on 12 against a dealer 4, 5 or 6 is usually right.', 'Blackjack pays 3 to 2; a push gives your bet back.'];
/** Cards as text: each card in a tile; the dealer's face-down card is Good Boy's animated card back. */
const cardTiles = (cards, hideSecond = false) => cards.map((c, k) => (hideSecond && k === 1 ? EM('card') : `\`${c}\``)).join(' ');
function bjEmbed(ctx, s, balance, { dealerShown = null } = {}) {
  const pv = C.handValue(s.player);
  const dealer = dealerShown ?? s.dealer, hide = !s.done && dealerShown == null, dv = C.handValue(dealer);
  const won = s.done && s.payout > s.bet, push = s.done && s.payout === s.bet;
  const e = new EmbedBuilder().setColor(s.done ? (won ? COLORS.blackjack : push ? COLORS.push : COLORS.lose) : COLORS.blackjack)
    .setTitle(`${EM('cardflip')} Blackjack`)
    .setDescription(`${EM('coin')} Bet **${fmtNum(s.bet)}**${s.doubled ? ' · doubled' : ''}`)
    .addFields(
      { name: `Your hand · ${pv.total}${pv.soft && pv.total < 21 ? ' soft' : ''}`, value: cardTiles(s.player), inline: true },
      { name: `Dealer · ${hide ? '?' : dv.total}`, value: cardTiles(dealer, hide), inline: true },
    );
  if (s.done && dealerShown == null) {
    const net = s.payout - s.bet;
    e.addFields({ name: '\u200b', value: `${won ? EM('win') : push ? '🤝' : EM('lose')} \`${pv.total} vs ${dv.total} · ${RESULT_TEXT[s.result]}${net ? ` · ${net > 0 ? '+' : ''}${fmtNum(net)}` : ''}\`\n${EM('coins')} Wallet: ${money(ctx, balance)}` });
  } else if (dealerShown != null) e.addFields({ name: '\u200b', value: `${EM('cardflip')} *Dealer's turn...*` });
  e.setFooter({ text: `Tip: ${BJ_TIPS[(s.player.length + s.dealer.length + s.bet) % BJ_TIPS.length]}` });
  return e;
}
/** The table picture. move: what just happened ('deal' | 'hit' | 'reveal'), so the new cards slide in / turn over. */
async function bjArt(ctx, s, move) {
  if (!artOn(ctx)) return null;
  const pv = C.handValue(s.player), hide = !s.done, dv = C.handValue(hide ? s.dealer.slice(0, 1) : s.dealer);
  const net = s.done ? s.payout - s.bet : 0;
  return ART.blackjackImage({
    player: s.player, dealer: s.dealer, hide, playerTotal: `${pv.total}${pv.soft && pv.total < 21 ? ' soft' : ''}`, dealerTotal: dv.total,
    newPlayer: move === 'deal' ? 0 : move === 'hit' ? s.player.length - 1 : s.player.length,
    newDealer: move === 'deal' ? 0 : move === 'reveal' ? 2 : s.dealer.length,
    flip: move === 'reveal' || (s.done && move === 'hit'),
    result: s.done ? { text: `${pv.total} vs ${C.handValue(s.dealer).total} · ${RESULT_TEXT[s.result]}`, net } : null,
  });
}
/** With a picture the embed only holds the bet, the wallet and a tip; the cards are in the picture. */
function bjArtEmbed(ctx, s, balance) {
  const won = s.done && s.payout > s.bet, push = s.done && s.payout === s.bet;
  return new EmbedBuilder().setColor(s.done ? (won ? COLORS.blackjack : push ? COLORS.push : COLORS.lose) : COLORS.blackjack)
    .setTitle(`${EM('cardflip')} Blackjack · ${EM('coin')} ${fmtNum(s.bet)}${s.doubled ? ' · doubled' : ''}`)
    .setDescription(s.done ? `Wallet: ${money(ctx, balance)}` : null)
    .setFooter({ text: `Tip: ${BJ_TIPS[(s.player.length + s.dealer.length + s.bet) % BJ_TIPS.length]}` });
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
  const art = await bjArt(ctx, s, 'deal');
  const msg = { ...(art ? withArt(bjArtEmbed(ctx, s, balance), art, { edit: update }) : { embeds: [bjEmbed(ctx, s, balance)] }), components: bjButtons(i, id, s, bet), allowedMentions: NOPING };
  return update ? i.update(msg) : i.reply({ ...msg, ...vis(ctx) });
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
  const art = await bjArt(ctx, s, action === 'stand' || (action === 'double' && s.result !== 'bust') ? 'reveal' : 'hit');
  if (art) return i.update({ ...withArt(bjArtEmbed(ctx, s, balance), art, { edit: true }), components: bjButtons(i, id, s, s.origBet ?? s.bet) });
  // The hand is already settled and paid; when the dealer played, show the cards turning over one by one.
  if (s.done && s.result !== 'bust' && s.dealer.length >= 2 && frameMs() > 0) {
    await i.update({ embeds: [bjEmbed(ctx, s, balance, { dealerShown: s.dealer.slice(0, 2) })], components: [] });
    for (let k = 3; k <= s.dealer.length; k++) { await sleep(frameMs()); await i.editReply({ embeds: [bjEmbed(ctx, s, balance, { dealerShown: s.dealer.slice(0, k) })] }).catch(() => {}); }
    await sleep(frameMs());
    return i.editReply({ embeds: [bjEmbed(ctx, s, balance)], components: bjButtons(i, id, s, s.origBet ?? s.bet) }).catch(() => {});
  }
  return i.update({ embeds: [bjEmbed(ctx, s, balance)], components: bjButtons(i, id, s, s.origBet ?? s.bet) });
}

// ------------------------------------------------------------------ fishing: storage
function profile(ctx, userId) {
  ctx.sql.run('INSERT OR IGNORE INTO games_fish_profile (guild_id, user_id) VALUES (?, ?)', ctx.guildId, userId);
  const p = ctx.sql.get('SELECT * FROM games_fish_profile WHERE guild_id = ? AND user_id = ?', ctx.guildId, userId);
  return { ...p, rods: JSON.parse(p.rods), tackle: JSON.parse(p.tackle), stars: JSON.parse(p.rod_stars ?? '{}') };
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
  // An older cast still open: if the fish already swam off (left alone after the bite), clear it and cast again;
  // if it is really still on the line, show it again, since its message may have been dismissed or never arrived.
  const open = activeSession(ctx, i.user.id, 'fish');
  if (open) {
    let old = null; try { old = loadSession(ctx, open.id, i.user.id, 'fish'); } catch { /* gone */ }
    const now = Date.now();
    if (!old || old.status !== 'reeling' || (F.bitten(old, now) && now - Math.max(old.lastAt ?? 0, old.biteAt ?? 0) > F.IDLE_MS)) dropSession(ctx, open.id);
    else {
      const msg = { ...(await reelMsg(ctx, old, open.id, { edit: update })), content: `${EM('bobber')} You still have a fish on the line from your last cast. Here it is, reel it in!`, allowedMentions: NOPING };
      await (update ? i.update(msg) : i.reply({ ...msg, flags: EPH }));
      scheduleBite(ctx, i, open.id, old);
      return;
    }
  }
  const id = sid();
  let s;
  ctx.sql.transaction(() => {
    checkSetup(ctx, i.user.id, setup);
    useBait(ctx, i.user.id, setup.bait);
    const seed = randomInt(2 ** 31);
    const stars = profile(ctx, i.user.id).stars[setup.rod] ?? 1;
    const lucky = (ctx.api('economy')?.boostUntil?.(ctx.guildId, i.user.id, 'luck') ?? 0) > Date.now(); // 3.1: the shop's lucky charm
    const fish = F.rollCatch({ ...setup, stars, bonusLuck: lucky ? 0.3 : 0 }, F.seeded(seed ^ 0x5bd1e995));
    s = F.startReel({ rod: setup.rod, tackle: setup.tackle, fish, seed, stars, biome: setup.biome, biteMs: globalThis[Symbol.for('goodboy.games.biteMs')], surges: globalThis[Symbol.for('goodboy.games.surges')] ?? true });
    s.biome = setup.biome; s.bait = setup.bait;
    ctx.sql.run('UPDATE games_fish_profile SET casts = casts + 1, last_biome = ?, last_rod = ?, last_bait = ?, last_tackle = ? WHERE guild_id = ? AND user_id = ?',
      setup.biome, setup.rod, setup.bait, setup.tackle, ctx.guildId, i.user.id);
    saveSession(ctx, id, i.user.id, 'fish', s);
  });
  const msg = { ...(await reelMsg(ctx, s, id, { edit: update })), allowedMentions: NOPING };
  await (update ? i.update(msg) : i.reply({ ...msg, flags: EPH })); // fishing menus were already private
  scheduleBite(ctx, i, id, s);
}
/**
 * Shows the bite when it happens (one edit). Only a nicety: if the bot restarts in between, the next press still
 * works, because whether the fish has bitten is worked out from the time saved in the game.
 */
function scheduleBite(ctx, i, id, s) {
  const wait = Math.max(0, (s.biteAt ?? 0) - Date.now());
  setTimeout(() => {
    let cur;
    try { cur = loadSession(ctx, id, i.user.id, 'fish'); } catch { return; }
    if (cur.status !== 'reeling' || cur.struck != null || cur.step > 0) return; // they already pressed something
    reelMsg(ctx, cur, id, { edit: true }).then((m) => i.editReply(m)).catch(() => {});
  }, wait).unref?.();
}

const rarityHint = (r) => ({ legendary: `${EM('shimmer')} Something **huge** is fighting back!`, mythical: `${EM('shimmer')} The water is glowing... this is no ordinary fish.` }[r] ?? `${EM('bite')} Something bit!`);
/** The fishing picture for a cast in progress: waiting (waves and a bobbing float) or reeling (the meter). */
async function reelArt(ctx, s, now = Date.now()) {
  if (!artOn(ctx)) return null;
  const b = F.biomeById(s.biome), rd = F.rodById(s.rod), waiting = !F.bitten(s, now);
  return ART.fishingImage({ biome: s.biome, title: `${b.label} · ${waiting ? 'waiting for a bite' : 'reeling'}`, phase: waiting ? 'waiting' : 'reeling', s, control: rd.control, line: rd.line, track: F.TRACK,
    hint: waiting ? 'Waiting for a bite… press Reel the moment it bites for a strike bonus.' : 'Keep the fish in the green and press Reel. Slack lets tension off.' });
}
/** With a picture, the embed keeps the notes (strike, surge, rarity hint) and the gear; the meter is in the picture. */
async function reelMsg(ctx, s, id, { edit = false } = {}) {
  const art = await reelArt(ctx, s);
  if (!art) return { embeds: [reelEmbed(ctx, s)], components: reelButtons(id), ...(edit ? { files: [], attachments: [] } : {}) };
  const now = Date.now(), waiting = !F.bitten(s, now), note = F.reelNote(s, now), b = F.biomeById(s.biome);
  const top = waiting ? null : [s.surge ? `${EM('surge')} ${note}` : note, rarityHint(s.fish.rarity)].filter(Boolean).join('\n');
  const e = new EmbedBuilder().setColor(s.surge ? 0xf1c40f : COLORS.fish).setTitle(`${b.emoji} ${b.label}`).setDescription(top || null)
    .setFooter({ text: `${F.rodById(s.rod).label} · ${F.baitById(s.bait).label} · ${F.tackleById(s.tackle).label}` });
  return { ...withArt(e, art, { edit }), components: reelButtons(id) };
}
function reelEmbed(ctx, s, now = Date.now()) {
  const b = F.biomeById(s.biome);
  const waiting = !F.bitten(s, now);
  const note = F.reelNote(s, now);
  const top = waiting ? `${EM('bobber')} ${note}` : [s.surge ? `${EM('surge')} ${note}` : note, rarityHint(s.fish.rarity)].filter(Boolean).join('\n');
  return new EmbedBuilder().setColor(s.surge ? 0xf1c40f : COLORS.fish).setTitle(`${b.emoji} ${b.label} · ${waiting ? 'waiting for a bite' : 'reeling'}`)
    .setDescription(waiting ? top : `${top}\n${F.reelPanel(s)}`)
    .setFooter({ text: `${F.rodById(s.rod).label} · ${F.baitById(s.bait).label} · ${F.tackleById(s.tackle).label} · keep the ◆ inside your ■ zone and Reel · Slack lets tension off` });
}
function reelButtons(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gm:fr:${id}:left`).setEmoji('◀️').setLabel('Pull').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gm:fr:${id}:reel`).setEmoji(emojiRef('reel')).setLabel('Reel').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gm:fr:${id}:right`).setEmoji('▶️').setLabel('Pull').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gm:fr:${id}:slack`).setEmoji('🪢').setLabel('Slack').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gm:fr:${id}:cut`).setEmoji('✂️').setStyle(ButtonStyle.Danger))];
}

// ------------------------------------------------------------------ 3.1 rods: earning, stars
/** Gives a member a rod they don't have. Returns a line to show, or null if they already had it. */
function awardRod(ctx, userId, rodId) {
  const p = profile(ctx, userId);
  if (p.rods.includes(rodId)) return null;
  ctx.sql.run('UPDATE games_fish_profile SET rods = ? WHERE guild_id = ? AND user_id = ?', JSON.stringify([...p.rods, rodId]), ctx.guildId, userId);
  const r = F.rodById(rodId), pk = F.PERKS[r.perk];
  ctx.live?.('activity', { icon: '🎁', text: `Someone earned the ${r.label}` });
  return `🎁 **New rod: ${r.label}!** ${pk ? `${pk.emoji} ${pk.label}: ${pk.desc}.` : ''} Pick it when you cast.`;
}
/** Keepsake rod: when this catch completes a place's collection. */
function collectionRod(ctx, userId, biome) {
  const total = F.fishIn(biome).length;
  const have = ctx.sql.get(`SELECT COUNT(*) AS n FROM games_fish_dex WHERE guild_id = ? AND user_id = ? AND species IN (${F.fishIn(biome).map(() => '?').join(',')})`, ctx.guildId, userId, ...F.fishIn(biome).map((f) => f.id)).n;
  return have >= total ? awardRod(ctx, userId, `keep-${biome}`) : null;
}
/** Challenge rods due after a streak or weekly challenge. */
function challengeRods(ctx, userId) {
  const p = profile(ctx, userId);
  return F.challengeRodsDue({ streak: liveStreak(p), weeklies: p.weeklies ?? 0, owned: p.rods }).map((r) => awardRod(ctx, userId, r.id)).filter(Boolean);
}
const sunkenRoll = () => (globalThis[Symbol.for('goodboy.games.sunkenRoll')] ?? Math.random)();

/** Records a caught fish: bag, collection log, XP and profile records. Returns the level before and after. */
function landFish(ctx, userId, s) {
  const c = s.fish, sp = F.FISH[c.species];
  const before = F.levelFromXp(profile(ctx, userId).xp).level;
  const xp = F.catchXp(c, sp.biome, F.gearOf(s).perk);
  const isNew = !ctx.sql.get('SELECT 1 FROM games_fish_dex WHERE guild_id = ? AND user_id = ? AND species = ?', ctx.guildId, userId, c.species);
  ctx.sql.run('INSERT INTO games_fish_bag (guild_id, user_id, species, rarity, mutation, giant, weight, value, biome, caught_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ctx.guildId, userId, c.species, c.rarity, c.mutation, c.giant ? 1 : 0, c.weight, c.value, sp.biome, Date.now());
  ctx.sql.run(`INSERT INTO games_fish_dex (guild_id, user_id, species, count, best_weight, first_at) VALUES (?, ?, ?, 1, ?, ?)
               ON CONFLICT(guild_id, user_id, species) DO UPDATE SET count = count + 1, best_weight = MAX(best_weight, excluded.best_weight)`, ctx.guildId, userId, c.species, c.weight, Date.now());
  ctx.sql.run('UPDATE games_fish_profile SET xp = xp + ?, caught = caught + 1, best_weight = MAX(best_weight, ?) WHERE guild_id = ? AND user_id = ?', xp, c.weight, ctx.guildId, userId);
  const challenges = progressChallenges(ctx, userId, { type: 'catch', fish: c });
  if (isNew) { const keep = collectionRod(ctx, userId, sp.biome); if (keep) challenges.push(keep); }
  const after = F.levelFromXp(profile(ctx, userId).xp).level;
  return { xp, before, after, challenges };
}

// ------------------------------------------------------------------ fishing: challenges
const dailyPeriod = (now) => `d:${CH.dayKey(now)}`;
const weeklyPeriod = (now) => `w:${CH.weekKey(now)}`;
/** Today's and this week's challenges for a member, made the first time they are needed (from their level then). */
function challenges(ctx, userId, now = Date.now()) {
  const lv = F.levelFromXp(profile(ctx, userId).xp).level;
  const make = (period, list) => {
    if (ctx.sql.get('SELECT 1 FROM games_fish_challenges WHERE guild_id = ? AND user_id = ? AND period = ?', ctx.guildId, userId, period)) return;
    list.forEach((spec, slot) => ctx.sql.run('INSERT OR IGNORE INTO games_fish_challenges (guild_id, user_id, period, slot, spec) VALUES (?, ?, ?, ?, ?)', ctx.guildId, userId, period, slot, JSON.stringify(spec)));
  };
  const seed = `${ctx.guildId}:${userId}`;
  make(dailyPeriod(now), CH.makeDailies(lv, `${seed}:${CH.dayKey(now)}`));
  make(weeklyPeriod(now), [CH.makeWeekly(lv, `${seed}:${CH.weekKey(now)}`)]);
  const rows = ctx.sql.all('SELECT * FROM games_fish_challenges WHERE guild_id = ? AND user_id = ? AND period IN (?, ?) ORDER BY period, slot', ctx.guildId, userId, dailyPeriod(now), weeklyPeriod(now));
  const parsed = rows.map((r) => ({ ...r, spec: JSON.parse(r.spec), seen: JSON.parse(r.seen) }));
  return { daily: parsed.filter((r) => r.period.startsWith('d:')), weekly: parsed.filter((r) => r.period.startsWith('w:')) };
}
/** Moves challenges along after a catch or a sale and pays any that finish. Returns lines to show the player. */
function progressChallenges(ctx, userId, event, now = Date.now()) {
  const lines = [];
  if (!ctx.config.get('fishChallenges')) return lines;
  const { daily, weekly } = challenges(ctx, userId, now);
  const fmt = (n) => money(ctx, n);
  let dailyFinished = false;
  for (const row of [...daily, ...weekly]) {
    if (row.done_at) continue;
    const next = CH.advance(row.spec, row.progress, row.seen, event);
    if (next.progress === row.progress && next.seen === row.seen) continue;
    const done = next.progress >= row.spec.goal;
    ctx.sql.run('UPDATE games_fish_challenges SET progress = ?, seen = ?, done_at = ? WHERE guild_id = ? AND user_id = ? AND period = ? AND slot = ?',
      next.progress, JSON.stringify(next.seen), done ? now : null, ctx.guildId, userId, row.period, row.slot);
    if (!done) continue;
    const { coins, xp } = row.spec.reward;
    if (coins) eco(ctx).credit(ctx.guildId, userId, coins, 'fishing challenge');
    if (xp) ctx.sql.run('UPDATE games_fish_profile SET xp = xp + ? WHERE guild_id = ? AND user_id = ?', xp, ctx.guildId, userId);
    lines.push(`📜 **${row.period.startsWith('w:') ? 'Weekly challenge' : 'Challenge'} done:** ${CH.describe(row.spec, fmt)} · +${fmt(coins)}${xp ? ` · +${fmtNum(xp)} XP` : ''}`);
    if (row.period.startsWith('d:')) dailyFinished = true;
    if (row.period.startsWith('w:')) { ctx.sql.run('UPDATE games_fish_profile SET weeklies = weeklies + 1 WHERE guild_id = ? AND user_id = ?', ctx.guildId, userId); lines.push(...challengeRods(ctx, userId)); }
  }
  if (dailyFinished && ctx.sql.get('SELECT COUNT(*) AS n FROM games_fish_challenges WHERE guild_id = ? AND user_id = ? AND period = ? AND done_at IS NULL', ctx.guildId, userId, dailyPeriod(now)).n === 0) {
    const p = profile(ctx, userId);
    const streak = p.streak_day === CH.yesterdayKey(now) ? p.streak + 1 : 1;
    const bonus = CH.streakBonus(F.levelFromXp(p.xp).level, streak);
    ctx.sql.run('UPDATE games_fish_profile SET streak = ?, streak_day = ? WHERE guild_id = ? AND user_id = ?', streak, CH.dayKey(now), ctx.guildId, userId);
    eco(ctx).credit(ctx.guildId, userId, bonus.coins, 'fishing challenge streak');
    ctx.sql.run('INSERT INTO games_fish_bait (guild_id, user_id, bait, qty) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, user_id, bait) DO UPDATE SET qty = qty + excluded.qty', ctx.guildId, userId, bonus.bait, bonus.baitQty);
    lines.push(`🔥 **All of today's challenges done!** Streak: ${streak} day${streak === 1 ? '' : 's'} · +${fmt(bonus.coins)} · +${bonus.baitQty} ${F.baitById(bonus.bait).label}`);
    lines.push(...challengeRods(ctx, userId));
  }
  return lines;
}
/** The streak still counts if it was kept up yesterday or today. */
const liveStreak = (p, now = Date.now()) => ([CH.dayKey(now), CH.yesterdayKey(now)].includes(p.streak_day) ? p.streak : 0);

function challengesMessage(ctx, i, now = Date.now()) {
  if (!ctx.config.get('fishChallenges')) throw new UserError('Fishing challenges are turned off in this server.');
  const { daily, weekly } = challenges(ctx, i.user.id, now);
  const p = profile(ctx, i.user.id);
  const fmt = (n) => money(ctx, n);
  const line = (r) => {
    const g = r.spec.goal, pr = Math.min(r.progress, g);
    const shown = r.spec.kind === 'sell' ? `${fmtNum(pr)}/${fmtNum(g)}` : `${pr}/${g}`;
    return `${r.done_at ? '✅' : '▫️'} ${CH.describe(r.spec, fmt)}
   ${F.meter((pr / g) * 100, 8)} ${shown} · ${fmt(r.spec.reward.coins)}${r.spec.reward.xp ? ` + ${fmtNum(r.spec.reward.xp)} XP` : ''}`;
  };
  const streak = liveStreak(p, now);
  const doneToday = daily.filter((r) => r.done_at).length;
  const bonus = CH.streakBonus(F.levelFromXp(p.xp).level, p.streak_day === CH.dayKey(now) ? streak : streak + 1);
  const unix = (ms) => Math.floor(ms / 1000);
  const e = new EmbedBuilder().setColor(COLORS.fish).setTitle('📜 Fishing challenges')
    .setDescription(`Challenges count every fish you land (and fish you sell). Rewards are paid the moment you finish one.
🔥 Streak: **${streak}** day${streak === 1 ? '' : 's'}${doneToday === 3 ? ' · all done today!' : ` · finish all 3 today for +${fmt(bonus.coins)} and ${bonus.baitQty} ${F.baitById(bonus.bait).label}`}`)
    .addFields(
      { name: `Today · ${doneToday}/3 · new <t:${unix(CH.nextDayAt(now))}:R>`, value: daily.map(line).join('\n') },
      { name: `This week · new <t:${unix(CH.nextWeekAt(now))}:R>`, value: weekly.map(line).join('\n') },
    );
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(
    pipe.button(i, 'cast', [], { label: 'Cast', emoji: '🎣', style: ButtonStyle.Success }),
    new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:hub`).setEmoji('↩️').setLabel('Back').setStyle(ButtonStyle.Secondary))], allowedMentions: NOPING };
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
    else if (['left', 'right', 'reel', 'slack'].includes(action)) F.reelStep(s, action);
    if (s.status === 'reeling') return saveSession(ctx, id, i.user.id, 'fish', s);
    // 3.1: in Ironwreck Graveyard a catch can be an old rod instead of a fish.
    if (s.status === 'caught' && s.biome === 'wreck') {
      const next = F.nextSunken(profile(ctx, i.user.id).rods);
      if (next && sunkenRoll() < F.SUNKEN_CHANCE * (F.gearOf(s).perk === 'sunken' ? 3 : 1)) { s.status = 'salvaged'; s.salvage = awardRod(ctx, i.user.id, next.id); }
    }
    if (s.status === 'caught') landed = landFish(ctx, i.user.id, s);
    dropSession(ctx, id);
  });
  if (s.status === 'reeling') return i.update(await reelMsg(ctx, s, id, { edit: true }));

  const b = F.biomeById(s.biome);
  const e = new EmbedBuilder().setTitle(`${b.emoji} ${b.label}`);
  if (s.status === 'salvaged') {
    e.setColor(0xc9a227).setDescription(`# ⚓\nYour line snagged on something heavy... it's not a fish, it's an **old rod** from one of the wrecks!\n${s.salvage}`);
    return i.update({ ...withArt(e, null, { edit: true }), components: [afterCastRow(i)] });
  }
  if (s.status === 'caught') {
    const r = F.rarityById(s.fish.rarity);
    if (['legendary', 'mythical'].includes(s.fish.rarity) || s.fish.mutation) {
      ctx.live('activity', { icon: '🎣', text: `${i.member?.displayName ?? i.user.username} caught a ${s.fish.mutation ? `${F.MUTATIONS[s.fish.mutation].label} ` : ''}${F.FISH[s.fish.species].name} (${r.label})` });
      shout(ctx, i, `🎣 ${nameOf(i)} caught a ${s.fish.mutation ? `${F.MUTATIONS[s.fish.mutation].label} ` : ''}**${F.FISH[s.fish.species].name}** (${r.label})!`, s.fish.rarity === 'mythical' ? 'mythical' : s.fish.rarity === 'legendary' ? 'legendary' : 'mutated');
    }
    ctx.live('data');
    const big = ['legendary', 'mythical'].includes(s.fish.rarity) || s.fish.mutation;
    const skill = [s.struck && '⚡ strike', s.surges?.won && `🙌 ${s.surges.won} surge${s.surges.won === 1 ? '' : 's'} nailed`].filter(Boolean).join(' · ');
    e.setColor(s.fish.mutation === 'corrupted' ? 0x2c2f33 : r.color)
      .setDescription([`# ${EM('splash')} ${EM(`fish_${s.fish.rarity}`)}${big ? ` ${EM('shimmer')}` : ''}`, `🎉 You caught a ${fishLine(s.fish)}!`, `Worth ${money(ctx, s.fish.value)} · +${landed.xp} XP${skill ? ` · ${skill}` : ''}`,
        ...landed.challenges,
        landed.after > landed.before ? `⬆️ **Fishing level ${landed.after}${landed.after >= F.MAX_LEVEL ? ' (max)' : ''}!**${unlockText(landed.before, landed.after)}` : null].filter(Boolean).join('\n'));
  } else {
    const why = { snapped: `${EM('snap')} **Snap!** The line broke. Watch the tension bar, press Slack, or fit a Steel Leader.`, cut: '✂️ You cut the line.', idle: '⌛ You waited too long and it swam off.', tired: '😮‍💨 It tired you out and got away.' };
    e.setColor(COLORS.lose).setDescription(`${why[s.status === 'snapped' ? 'snapped' : s.reason] ?? '🐟 It got away!'}\nIt was a **${F.rarityById(s.fish.rarity).label}** fish.`);
  }
  let art = null;
  if (artOn(ctx)) {
    if (s.status === 'caught') {
      const r = F.rarityById(s.fish.rarity), mut = s.fish.mutation ? `${F.MUTATIONS[s.fish.mutation].label} ` : '';
      art = await ART.fishingImage({ biome: s.biome, title: b.label, phase: 'caught', catchInfo: { rarity: s.fish.rarity, mutation: s.fish.mutation, title: `${r.label} · ${mut}${F.FISH[s.fish.species].name}`, sub: `${s.fish.weight} kg · +${fmtNum(s.fish.value)} coins · +${landed.xp} XP` } });
    } else art = await ART.fishingImage({ biome: s.biome, title: b.label, phase: 'escaped', hint: s.status === 'snapped' ? 'Snap! The line broke.' : 'It got away.' });
  }
  return i.update({ ...withArt(e, art, { edit: true }), components: [afterCastRow(i)] });
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
  const quest = ctx.config.get('fishChallenges') ? challenges(ctx, i.user.id) : null;
  const e = new EmbedBuilder().setColor(COLORS.fish).setTitle('🎣 Fishing')
    .setDescription(lv.max ? `Level **${lv.level}** (max) ${F.meter(100)} ${fmtNum(p.xp)} XP` : `Level **${lv.level}** ${F.meter((lv.into / lv.needed) * 100)} ${fmtNum(lv.into)}/${fmtNum(lv.needed)} XP`)
    .addFields(
      { name: 'Last setup', value: `${F.biomeById(setup.biome).emoji} ${F.biomeById(setup.biome).label}\n🎣 ${F.rodById(setup.rod).label} · 🪱 ${F.baitById(setup.bait).label} · 🧰 ${F.tackleById(setup.tackle).label}` },
      { name: 'Bag', value: `${fmtNum(bag.n)} fish worth ${money(ctx, bag.v)}`, inline: true },
      { name: 'Caught', value: `${fmtNum(p.caught)} of ${fmtNum(p.casts)} casts`, inline: true },
      ...(quest ? [{ name: 'Challenges', value: `📜 ${quest.daily.filter((r) => r.done_at).length}/3 today${quest.weekly[0]?.done_at ? ' · weekly ✅' : ''}${liveStreak(p) ? ` · 🔥 ${liveStreak(p)}` : ''}`, inline: true }] : []),
    ).setFooter({ text: 'Cast opens a form to pick where to fish, your rod, bait and tackle.' });
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(
    pipe.button(i, 'cast', [], { label: 'Cast', emoji: '🎣', style: ButtonStyle.Success }),
    new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:bag`).setEmoji('🎒').setLabel('Bag').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:shop`).setEmoji('🛒').setLabel('Shop').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:rods`).setEmoji('🎣').setLabel('Rods').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:dex`).setEmoji('📖').setLabel('Collection').setStyle(ButtonStyle.Secondary),
    ...(quest ? [new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:quests`).setEmoji('📜').setLabel('Challenges').setStyle(ButtonStyle.Secondary)] : []))], flags: EPH, allowedMentions: NOPING };
}

function bagMessage(ctx, i, note) {
  const rows = ctx.sql.all('SELECT * FROM games_fish_bag WHERE guild_id = ? AND user_id = ? AND sold = 0 ORDER BY value DESC LIMIT 10', ctx.guildId, i.user.id);
  const tot = ctx.sql.get(`SELECT COUNT(*) AS n, COALESCE(SUM(value), 0) AS v,
      COALESCE(SUM(CASE WHEN rarity IN ('legendary', 'mythical') OR mutation IS NOT NULL THEN 0 ELSE value END), 0) AS cheap
      FROM games_fish_bag WHERE guild_id = ? AND user_id = ? AND sold = 0`, ctx.guildId, i.user.id);
  const e = new EmbedBuilder().setColor(COLORS.fish).setTitle('🎒 Your bag')
    .setDescription([note, rows.length ? rows.map((c) => `${fishLine(c)} · ${money(ctx, c.value)}`).join('\n') : '*Empty. Go catch something!*'].filter(Boolean).join('\n\n'))
    .setFooter({ text: `${fmtNum(tot.n)} fish · worth ${fmtNum(tot.v)} in total${tot.n > 10 ? ' · showing the 10 most valuable' : ''}` });
  const pick = ctx.sql.all('SELECT * FROM games_fish_bag WHERE guild_id = ? AND user_id = ? AND sold = 0 ORDER BY value DESC LIMIT 25', ctx.guildId, i.user.id);
  const chooser = pick.length ? [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`gm:fsel:${i.user.id}`)
    .setPlaceholder('Choose fish to sell...').setMinValues(1).setMaxValues(pick.length)
    .addOptions(pick.map((c) => ({ label: `${F.FISH[c.species]?.name ?? 'Fish'} · ${c.weight} kg`.slice(0, 100), value: String(c.id), emoji: emojiRef(`fish_${c.rarity}`),
      description: `${F.rarityById(c.rarity).label}${c.mutation ? ` · ${F.MUTATIONS[c.mutation].label}` : ''}${c.giant ? ' · Giant' : ''} · ${fmtNum(c.value)} coins`.slice(0, 100) }))))] : [];
  return { embeds: [e], components: [...chooser, new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:sellcommon`).setLabel(`Sell all but rare finds (${fmtNum(tot.cheap)})`).setEmoji('💰').setStyle(ButtonStyle.Success).setDisabled(!tot.cheap),
    new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:sellall`).setLabel(`Sell everything (${fmtNum(tot.v)})`).setEmoji('💰').setStyle(ButtonStyle.Danger).setDisabled(!tot.v),
    new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:hub`).setEmoji('↩️').setLabel('Back').setStyle(ButtonStyle.Secondary))], allowedMentions: NOPING };
}
/** Sells the chosen fish (by bag row). Fish already sold, or someone else's, are skipped. */
function sellChosen(ctx, userId, ids) {
  let total = 0, count = 0, lines = [];
  const clean = [...new Set(ids.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 25);
  ctx.sql.transaction(() => {
    for (const id of clean) {
      const row = ctx.sql.get('SELECT value FROM games_fish_bag WHERE id = ? AND guild_id = ? AND user_id = ? AND sold = 0', id, ctx.guildId, userId);
      if (!row) continue;
      ctx.sql.run('UPDATE games_fish_bag SET sold = 1 WHERE id = ?', id);
      total += row.value; count++;
    }
    if (total) eco(ctx).credit(ctx.guildId, userId, total, 'sold fish');
    if (total) lines = progressChallenges(ctx, userId, { type: 'sell', coins: total });
  });
  return { total, count, lines };
}
async function sellSelect(ctx, i, owner) {
  if (owner !== i.user.id) throw new UserError('That bag belongs to someone else. Run `/fish` for your own.');
  const got = sellChosen(ctx, i.user.id, i.values ?? []);
  return i.update(bagMessage(ctx, i, got.total ? [`${EM('coins')} Sold ${got.count} fish for ${money(ctx, got.total)}.`, ...got.lines].join('\n') : 'Those fish were already sold.'));
}
function sellFish(ctx, userId, all) {
  let total = 0, lines = [];
  ctx.sql.transaction(() => {
    const filter = all ? '' : "AND rarity NOT IN ('legendary', 'mythical') AND mutation IS NULL";
    total = ctx.sql.get(`SELECT COALESCE(SUM(value), 0) AS v FROM games_fish_bag WHERE guild_id = ? AND user_id = ? AND sold = 0 ${filter}`, ctx.guildId, userId).v;
    ctx.sql.run(`UPDATE games_fish_bag SET sold = 1 WHERE guild_id = ? AND user_id = ? AND sold = 0 ${filter}`, ctx.guildId, userId);
    if (total) eco(ctx).credit(ctx.guildId, userId, total, 'sold fish');
    if (total) lines = progressChallenges(ctx, userId, { type: 'sell', coins: total });
  });
  return { total, lines };
}

const starText = (n) => '★'.repeat(n) + '☆'.repeat(F.MAX_STARS - n);
const homeText = (r) => (r.perk === 'mythic' || r.perk === 'wanderer' ? 'every place' : (r.home ?? []).map((h) => `${F.biomeById(h).emoji} ${F.biomeById(h).label}`).join(', ') || 'none');
/** Your rods: perks, home places, stars; and the rods you can still earn. */
function rodsMessage(ctx, i) {
  const p = profile(ctx, i.user.id);
  const owned = F.RODS.filter((r) => p.rods.includes(r.id)).sort((a, b) => F.rodStats(b.id).power - F.rodStats(a.id).power);
  const line = (r) => { const pk = F.PERKS[r.perk]; return `**${r.label}** ${starText(p.stars[r.id] ?? 1)}${pk ? ` · ${pk.emoji} ${pk.label}` : ''}`; };
  const toEarn = F.RODS.filter((r) => r.earn && !p.rods.includes(r.id));
  const keepsLeft = toEarn.filter((r) => r.earn.kind === 'collection').length;
  const other = toEarn.filter((r) => r.earn.kind !== 'collection').map((r) => `🔒 **${r.label}** · ${F.earnText(r)}`);
  const e = new EmbedBuilder().setColor(COLORS.fish).setTitle('🎣 Your rods')
    .setDescription(truncate(owned.map(line).join('\n'), 3000))
    .addFields({ name: 'Rods to earn', value: truncate([...other, keepsLeft ? `🏅 **${keepsLeft} Keepsake rods** · catch every fish in a place to earn its rod` : null].filter(Boolean).join('\n') || 'You have earned them all!', 1000) })
    .setFooter({ text: 'Every rod has a perk and home places where it is stronger. Upgrade your favourites to ★5 with coins and fish.' });
  const opts = owned.slice(0, 25).map((r) => new StringSelectMenuOptionBuilder().setLabel(truncate(r.label, 100)).setValue(r.id).setDescription(truncate(`${starText(p.stars[r.id] ?? 1)} · ${F.PERKS[r.perk]?.label ?? ''}`, 100)));
  return { embeds: [e], components: [
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`gm:frod:${i.user.id}`).setPlaceholder('Look at a rod or upgrade it...').addOptions(opts)),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:hub`).setEmoji('↩️').setLabel('Back').setStyle(ButtonStyle.Secondary))], allowedMentions: NOPING };
}
/** One rod: what it does, where it's strong, and what the next star costs. */
function rodMessage(ctx, i, rodId, note) {
  const p = profile(ctx, i.user.id);
  if (!p.rods.includes(rodId)) throw new UserError('You don\'t own that rod.');
  const r = F.rodById(rodId), stars = p.stars[rodId] ?? 1, st = F.rodStats(rodId, { stars }), pk = F.PERKS[r.perk];
  const home = F.rodStats(rodId, { stars, biome: (r.home ?? [])[0] ?? (r.perk === 'mythic' || r.perk === 'wanderer' ? 'bay' : null) });
  const cost = F.upgradeCost(rodId, stars);
  const have = cost ? ctx.sql.get('SELECT COUNT(*) AS n FROM games_fish_bag WHERE guild_id = ? AND user_id = ? AND sold = 0 AND rarity = ? AND mutation IS NULL', ctx.guildId, i.user.id, cost.rarity).n : 0;
  const coins = eco(ctx).wallet(ctx.guildId, i.user.id).coins;
  const e = new EmbedBuilder().setColor(COLORS.fish).setTitle(`🎣 ${r.label} ${starText(stars)}`)
    .setDescription([note, pk ? `${pk.emoji} **${pk.label}:** ${pk.desc}` : null, `🏠 **Home:** ${homeText(r)}`, `-# ${F.earnText(r)}`].filter(Boolean).join('\n'))
    .addFields(
      { name: 'Anywhere', value: `Luck +${Math.round(st.luck * 100)}% · zone ${st.control} · power ${st.power} · line ${st.line}` },
      ...(home.home ? [{ name: 'At home', value: `Luck +${Math.round(home.luck * 100)}% · zone ${home.control} · power ${home.power} · line ${home.line}` }] : []),
      { name: cost ? `Next: ${starText(stars + 1)}` : 'Fully upgraded', value: cost ? `${money(ctx, cost.coins)} (you have ${money(ctx, coins)})\n${cost.fish} ${F.rarityById(cost.rarity).label} fish from your bag (you have ${have}; mutated fish are never used)` : 'This rod is at ★5.' });
  const row = new ActionRowBuilder().addComponents(
    ...(cost ? [new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:up-${rodId}`).setEmoji('⬆️').setLabel(`Upgrade to ★${stars + 1}`).setStyle(ButtonStyle.Success).setDisabled(coins < cost.coins || have < cost.fish)] : []),
    new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:rods`).setEmoji('↩️').setLabel('All rods').setStyle(ButtonStyle.Secondary));
  return { embeds: [e], components: [row], allowedMentions: NOPING };
}
/** Spends coins and the cheapest matching fish to add a star. Returns a line to show. */
function upgradeRod(ctx, userId, rodId) {
  let out;
  ctx.sql.transaction(() => {
    const p = profile(ctx, userId);
    if (!p.rods.includes(rodId)) throw new UserError('You don\'t own that rod.');
    const stars = p.stars[rodId] ?? 1, cost = F.upgradeCost(rodId, stars);
    if (!cost) throw new UserError('That rod is already at ★5.');
    const fish = ctx.sql.all('SELECT id FROM games_fish_bag WHERE guild_id = ? AND user_id = ? AND sold = 0 AND rarity = ? AND mutation IS NULL ORDER BY value ASC LIMIT ?', ctx.guildId, userId, cost.rarity, cost.fish);
    if (fish.length < cost.fish) throw new UserError(`You need ${cost.fish} ${F.rarityById(cost.rarity).label} fish in your bag (not mutated). You have ${fish.length}.`);
    eco(ctx).debit(ctx.guildId, userId, cost.coins, `upgraded ${F.rodById(rodId).label}`);
    ctx.sql.run(`UPDATE games_fish_bag SET sold = 1 WHERE id IN (${fish.map(() => '?').join(',')})`, ...fish.map((f) => f.id));
    ctx.sql.run('UPDATE games_fish_profile SET rod_stars = ? WHERE guild_id = ? AND user_id = ?', JSON.stringify({ ...p.stars, [rodId]: stars + 1 }), ctx.guildId, userId);
    out = `⬆️ **Upgraded to ${starText(stars + 1)}!**`;
  });
  return out;
}

function shopMessage(ctx, i, note) {
  const p = profile(ctx, i.user.id);
  const lv = F.levelFromXp(p.xp).level;
  const stock = baitStock(ctx, i.user.id);
  const coins = eco(ctx).wallet(ctx.guildId, i.user.id).coins;
  // Only the rods that matter now: the best one owned, the ones for sale, and the next two to unlock.
  const SHOP = F.RODS.filter((r) => !r.earn);
  const best = Math.max(...SHOP.map((r, k) => (p.rods.includes(r.id) ? k : 0)));
  const locked = SHOP.filter((r) => r.level > lv).slice(0, 2).map((r) => r.id);
  const rodLines = SHOP.filter((r, k) => r.price && (k === best || (!p.rods.includes(r.id) && r.level <= lv) || locked.includes(r.id))).slice(-8).map((r) => `${p.rods.includes(r.id) ? '✅' : r.level > lv ? '🔒' : '▫️'} **${r.label}** · ${fmtNum(r.price)} · lv ${r.level} · luck +${Math.round(r.luck * 100)}% · zone ${r.control}${F.PERKS[r.perk] ? ` · ${F.PERKS[r.perk].emoji} ${F.PERKS[r.perk].label}` : ''}`);
  const tackleLines = F.TACKLE.filter((t) => t.price).map((t) => `${p.tackle.includes(t.id) ? '✅' : '▫️'} **${t.label}** · ${fmtNum(t.price)} · ${t.desc}`);
  const baitLines = F.BAITS.filter((b) => b.price).map((b) => `🪱 **${b.label}** · ${fmtNum(b.price)} each · luck +${Math.round(b.luck * 100)}%${b.corruption ? ' · draws corruption' : ''} · you have ${stock[b.id] ?? 0}`);
  const e = new EmbedBuilder().setColor(COLORS.fish).setTitle('🛒 Tackle shop').setDescription([note, `You have ${money(ctx, coins)}`].filter(Boolean).join('\n'))
    .addFields({ name: 'Rods', value: rodLines.join('\n') }, { name: 'Tackle (kept forever)', value: tackleLines.join('\n') }, { name: 'Bait (one per cast)', value: baitLines.join('\n') });
  const options = [
    ...F.RODS.filter((r) => r.price && !r.earn && !p.rods.includes(r.id) && r.level <= lv).map((r) => ({ label: `${r.label} (${fmtNum(r.price)})`, value: `rod-${r.id}`, emoji: '🎣' })),
    ...F.TACKLE.filter((t) => t.price && !p.tackle.includes(t.id)).map((t) => ({ label: `${t.label} (${fmtNum(t.price)})`, value: `tackle-${t.id}`, emoji: '🧰' })),
    ...F.BAITS.filter((b) => b.price).map((b) => ({ label: `${b.label} (${fmtNum(b.price)} each)`, value: `bait-${b.id}`, emoji: '🪱', description: 'Choose how many in a form' })),
  ].slice(-25);
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
      const r = F.RODS.find((x) => x.id === id && x.price && !x.earn);
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

/** Collection: an overview of every place, or one place's fish (`biome`). A button per place switches between them. */
const DEX_PAGE = 21;
function dexMessage(ctx, i, view = null) {
  const seen = Object.fromEntries(ctx.sql.all('SELECT species, count, best_weight FROM games_fish_dex WHERE guild_id = ? AND user_id = ?', ctx.guildId, i.user.id).map((r) => [r.species, r]));
  const total = Object.keys(F.FISH).length, found = Object.keys(seen).filter((id) => F.FISH[id]).length;
  const lv = F.levelFromXp(profile(ctx, i.user.id).xp).level;
  const e = new EmbedBuilder().setColor(COLORS.fish);
  const [biome, pageRaw] = String(view ?? '').split('.');
  const place = biome && F.BIOMES.find((b) => b.id === biome);
  const rows = [];
  if (place) {
    const list = F.fishIn(place.id), have = list.filter((f) => seen[f.id]).length;
    const pages = Math.ceil(list.length / DEX_PAGE), page = Math.min(Math.max(Number(pageRaw) || 0, 0), pages - 1);
    e.setTitle(`📖 ${place.emoji} ${place.label} · ${have}/${list.length}`)
      .setDescription([place.level > lv ? `🔒 Unlocks at fishing level ${fmtNum(place.level)}.` : place.blurb, '',
        ...list.slice(page * DEX_PAGE, (page + 1) * DEX_PAGE).map((f) => (seen[f.id] ? `✅ **${f.name}** · ${F.rarityById(f.rarity).label} · best ${seen[f.id].best_weight} kg · caught ${fmtNum(seen[f.id].count)}` : `❔ ${F.rarityById(f.rarity).label} fish`))].join('\n'))
      .setFooter({ text: `Page ${page + 1} of ${pages}` });
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:dex-${place.id}.${page - 1}`).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:dex-${place.id}.${page + 1}`).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1)));
  } else {
    e.setTitle(`📖 Collection · ${fmtNum(found)}/${fmtNum(total)}`)
      .setDescription(`${F.meter((found / total) * 100, 15)} Catch every fish in every place. Pick a place below to see its fish.`);
    for (const b of F.BIOMES) {
      const list = F.fishIn(b.id), have = list.filter((f) => seen[f.id]).length;
      e.addFields({ name: `${b.emoji} ${b.label}`, value: b.level > lv ? `🔒 Level ${fmtNum(b.level)}` : `${have === list.length ? '🏆' : F.meter((have / list.length) * 100, 6)} ${have}/${list.length}`, inline: true });
    }
  }
  rows.unshift(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`gm:fdx:${i.user.id}`).setPlaceholder('Pick a place...')
    .addOptions(F.BIOMES.map((b) => ({ label: b.label, value: b.id, emoji: b.emoji, default: b.id === biome, description: b.level > lv ? `Unlocks at level ${fmtNum(b.level)}` : `${F.fishIn(b.id).filter((f) => seen[f.id]).length}/${F.fishIn(b.id).length} found` })))));
  rows.push(new ActionRowBuilder().addComponents(
    ...(place ? [new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:dex`).setEmoji('📖').setLabel('All places').setStyle(ButtonStyle.Secondary)] : []),
    new ButtonBuilder().setCustomId(`gm:fh:${i.user.id}:hub`).setEmoji('↩️').setLabel('Back').setStyle(ButtonStyle.Secondary)));
  return { embeds: [e], components: rows, allowedMentions: NOPING };
}

async function hubClick(ctx, i, owner, view) {
  if (owner !== i.user.id) return i.reply({ ...hubMessage(ctx, i), content: 'That menu belongs to someone else, so here is your own.', flags: EPH });
  if (view === 'again') return cast(ctx, i, lastSetup(profile(ctx, i.user.id)), { update: false });
  if (view === 'bag') return i.update(bagMessage(ctx, i));
  if (view === 'shop') return i.update(shopMessage(ctx, i));
  if (view === 'dex') return i.update(dexMessage(ctx, i));
  if (view.startsWith('dex-')) return i.update(dexMessage(ctx, i, view.slice(4)));
  if (view === 'quests') return i.update(challengesMessage(ctx, i));
  if (view === 'rods') return i.update(rodsMessage(ctx, i));
  if (view.startsWith('rod-')) return i.update(rodMessage(ctx, i, view.slice(4)));
  if (view.startsWith('up-')) { const note = upgradeRod(ctx, i.user.id, view.slice(3)); return i.update(rodMessage(ctx, i, view.slice(3), note)); }
  if (view === 'hub') { const { flags, ...m } = hubMessage(ctx, i); return i.update(m); }
  if (view === 'sellall' || view === 'sellcommon') {
    const got = sellFish(ctx, i.user.id, view === 'sellall');
    return i.update(bagMessage(ctx, i, got.total ? [`💰 Sold for ${money(ctx, got.total)}.`, ...got.lines].join('\n') : 'Nothing to sell.'));
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
    ...Object.fromEntries(Object.entries(MINI).map(([game, g]) => [game, {
      title: `${g.label}: set your bet`, permission: 'games.play', color: 0x6b93ff,
      button: { label: 'Set bet', emoji: g.emoji, style: ButtonStyle.Success },
      precheck: (ctx, i) => { enabled(ctx, game); if (activeSession(ctx, i.user.id, game)) throw new UserError(`You already have a ${g.label} game going. Finish it first!`); },
      intro: (ctx, i) => betIntro(ctx, i, `\n${g.emoji} **${g.label}:** ${g.blurb}.`),
      fields: (ctx) => [betField(ctx), ...(game === 'trivia' ? [{ id: 'category', kind: 'select', label: 'Category', value: 'any', options: Object.entries(TRIVIA_CATEGORIES).map(([value, label]) => ({ label, value })) }] : [])],
      async submit(ctx, i, v) { return mini.start(ctx, i, game, takeBet(ctx, i.user.id, v.bet, `${g.label} bet`), { category: v.category }); },
    }])),
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
            // Discord shows 25 options at most: your last rod and your strongest ones.
            options: F.RODS.filter((r) => p.rods.includes(r.id)).sort((a, b) => (b.id === last.rod) - (a.id === last.rod) || F.rodStats(b.id, { stars: p.stars[b.id] }).power - F.rodStats(a.id, { stars: p.stars[a.id] }).power).slice(0, 25)
              .map((r) => ({ label: `${r.label} ${'★'.repeat(p.stars[r.id] ?? 1)}`.slice(0, 100), value: r.id, description: `${F.PERKS[r.perk] ? `${F.PERKS[r.perk].emoji} ${F.PERKS[r.perk].label} · ` : ''}home: ${homeText(r)}`.slice(0, 100) })) },
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
  if (kind === 'frod') { if (a !== i.user.id) throw new UserError('Those rods belong to someone else. Run `/fish` for your own.'); return i.update(rodMessage(ctx, i, i.values?.[0])); }
  if (kind === 'fsel') return sellSelect(ctx, i, a);
  if (kind === 'fdx') { if (a !== i.user.id) throw new UserError('That collection belongs to someone else. Run `/fish` for your own.'); return i.update(dexMessage(ctx, i, i.values?.[0] ?? null)); }
  if (kind === 'ar') return arcadeClick(ctx, i, a);
  if (kind === 'mg') return mini.click(ctx, i, a, b);
  if (kind === 'mgh') return mini.guess(ctx, i, a);
  if (kind === 'pg') return pongClick(ctx, i, a, b);
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

// ------------------------------------------------------------------ pong (turn-based)
function pongEmbed(ctx, s) {
  const name = (id) => (id === 'bot' ? 'Good Boy' : `<@${id}>`);
  const e = new EmbedBuilder().setColor(0x6b93ff).setTitle(`${EM('paddle')} Pong · first to ${s.to}`)
    .setDescription(`🟦 ${name(s.left.id)} **${s.score[0]}** : **${s.score[1]}** ${name(s.right.id)} 🟥\n\n${PONG.court(s, EM('ball'))}`);
  if (s.status === 'over') e.addFields({ name: '\u200b', value: `${EM('win')} ${name(PONG.winner(s))} wins!` });
  else e.addFields({ name: '\u200b', value: `${s.last ? `${name(s[s.last].id)} scored! ` : ''}Your move, ${name(PONG.turnId(s))}: the ball is coming to you.` });
  return e.setFooter({ text: 'Move your paddle so the ball hits it. Up, stay or down; then the ball flies two squares.' });
}
function pongButtons(id, s) {
  if (s.status === 'over') return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gm:pg:${id}:up`).setEmoji('⬆️').setLabel('Up').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gm:pg:${id}:stay`).setEmoji('⏺️').setLabel('Stay').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gm:pg:${id}:down`).setEmoji('⬇️').setLabel('Down').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gm:pg:${id}:quit`).setLabel('Give up').setStyle(ButtonStyle.Danger))];
}
/** Pong sessions are shared by two people, so they are loaded without the owner check. */
function loadPong(ctx, id) {
  const row = ctx.sql.get("SELECT * FROM games_sessions WHERE id = ? AND guild_id = ? AND kind = 'pong'", id, ctx.guildId);
  if (!row) throw new UserError('That game of Pong has finished. Start a new one with /pong!');
  return JSON.parse(row.state);
}
async function startPong(ctx, i) {
  enabled(ctx, 'pong');
  const rival = i.options?.getUser?.('opponent');
  if (rival && (rival.bot || rival.id === i.user.id)) throw new UserError(rival.bot ? 'Bots can\'t play. Leave the opponent empty to play Good Boy.' : 'Pick someone else, or leave it empty to play Good Boy.');
  const id = sid();
  if (rival) {
    saveSession(ctx, id, i.user.id, 'pong-invite', { from: i.user.id, to: rival.id });
    return i.reply({ content: `${EM('paddle')} <@${rival.id}>, <@${i.user.id}> challenges you to Pong!`, allowedMentions: { users: [rival.id] },
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gm:pg:${id}:accept`).setLabel('Play').setEmoji('🏓').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`gm:pg:${id}:decline`).setLabel('No thanks').setStyle(ButtonStyle.Secondary))] });
  }
  const s = PONG.newGame({ left: i.user.id, right: 'bot', seed: randomInt(2 ** 31) });
  saveSession(ctx, id, i.user.id, 'pong', s);
  return i.reply({ embeds: [pongEmbed(ctx, s)], components: pongButtons(id, s), allowedMentions: NOPING, ...vis(ctx) });
}
async function pongClick(ctx, i, id, action) {
  if (action === 'accept' || action === 'decline') {
    const row = ctx.sql.get("SELECT * FROM games_sessions WHERE id = ? AND guild_id = ? AND kind = 'pong-invite'", id, ctx.guildId);
    if (!row) throw new UserError('That challenge has expired.');
    const inv = JSON.parse(row.state);
    if (i.user.id !== inv.to) throw new UserError('That challenge is for someone else.');
    dropSession(ctx, id);
    if (action === 'decline') return i.update({ content: `<@${inv.to}> passed on Pong this time.`, components: [], allowedMentions: NOPING });
    const s = PONG.newGame({ left: inv.from, right: inv.to, seed: randomInt(2 ** 31) });
    saveSession(ctx, id, inv.from, 'pong', s);
    return i.update({ content: '', embeds: [pongEmbed(ctx, s)], components: pongButtons(id, s), allowedMentions: NOPING });
  }
  const s = loadPong(ctx, id);
  if (![s.left.id, s.right.id].includes(i.user.id)) throw new UserError('This is not your game. Start your own with /pong!');
  if (action === 'quit') {
    s.status = 'over'; s.score = s.left.id === i.user.id ? [0, s.to] : [s.to, 0];
    dropSession(ctx, id);
    return i.update({ embeds: [pongEmbed(ctx, s)], components: [] });
  }
  try { PONG.play(s, i.user.id, action); } catch (e) { throw new UserError(e.message); }
  if (s.status === 'over') {
    dropSession(ctx, id);
    record(ctx, i.user.id, 'pong', 0, PONG.winner(s) === i.user.id ? 1 : 0);
  } else saveSession(ctx, id, s.left.id, 'pong', s);
  return i.update({ embeds: [pongEmbed(ctx, s)], components: pongButtons(id, s) });
}

// One public panel for everyone: each button opens that game's popup for whoever clicked (the click is the trigger).
const ARCADE = [['slots', '🎰', 'Slots'], ['blackjack', '🃏', 'Blackjack'], ['coinflip', '🪙', 'Coin flip'], ['fish', '🎣', 'Fishing'], ['pong', '🏓', 'Pong']];
async function arcadeClick(ctx, i, game) {
  if (game === 'fish') { enabled(ctx, 'fishing'); return i.reply(hubMessage(ctx, i)); }
  if (game === 'pong') return startPong(ctx, i);
  if (game in MINI) return pipe.open(ctx, i, game);
  if (!ARCADE.some(([g]) => g === game)) throw new UserError('That game is not available.');
  return pipe.open(ctx, i, game);
}
function arcadePanel(ctx) {
  const e = new EmbedBuilder().setColor(COLORS.slots).setTitle('🕹️ Arcade')
    .setDescription(`Pick a game. Each button opens a private form just for you.\n\n🎰 **Slots** · jackpot pool ${money(ctx, pool(ctx))}\n🃏 **Blackjack** · pays 3 to 2\n🪙 **Coin flip** · ${C.COINFLIP_PAYOUT}x\n🎣 **Fishing** · ${F.BIOMES.length} places, ${Object.keys(F.FISH).length} fish to collect`)
    .setFooter({ text: 'Play money only. Coins cannot be bought or cashed out.' });
  const games = new ActionRowBuilder().addComponents(ARCADE.map(([g, emoji, label]) => new ButtonBuilder().setCustomId(`gm:ar:${g}`).setEmoji(emoji).setLabel(label).setStyle(ButtonStyle.Primary)));
  const minis = Object.entries(MINI).filter(([g]) => ctx.config.get(`${g}Enabled`)).map(([g, m]) => new ButtonBuilder().setCustomId(`gm:ar:${g}`).setEmoji(m.emoji).setLabel(m.label).setStyle(ButtonStyle.Primary));
  const extra = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('econ:daily:panel').setEmoji('🎁').setLabel('Daily').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('econ:top:panel').setEmoji('🏆').setLabel('Leaderboard').setStyle(ButtonStyle.Secondary));
  const miniRows = []; for (let k = 0; k < minis.length; k += 5) miniRows.push(new ActionRowBuilder().addComponents(minis.slice(k, k + 5)));
  if (minis.length) e.setDescription(`${e.data.description}\n${Object.entries(MINI).filter(([g]) => ctx.config.get(`${g}Enabled`)).map(([, m]) => `${m.emoji} **${m.label}** · ${m.blurb}`).join('\n')}`);
  return { embeds: [e], components: [games, ...miniRows, extra].slice(0, 5), allowedMentions: NOPING };
}

// ------------------------------------------------------------------ module
const gameCommand = (name, description, form) => ({
  permission: 'games.play',
  data: new SlashCommandBuilder().setName(name).setDescription(description),
  execute: (ctx, i) => pipe.launch(ctx, i, form),
});

export default {
  name: 'games',
  version: '1.1.0',
  description: 'Slots, blackjack, coin flip and fishing, played with economy coins',
  memberIntroTitle: 'games are open',
  memberIntro: "you can play games with your coins now. there's /slots (the jackpot keeps growing until someone hits it), /blackjack and /coinflip. there's also /fish, go catch stuff in different spots, find rare and giant fish, fill up your collection and get better rods",
  dependencies: [{ module: 'economy', version: '>=1.0.0' }],
  settings: [
    { key: 'slotsEnabled', type: 'toggle', label: 'Slots', default: true },
    { key: 'blackjackEnabled', type: 'toggle', label: 'Blackjack', default: true },
    { key: 'coinflipEnabled', type: 'toggle', label: 'Coin flip', default: true },
    { key: 'fishingEnabled', type: 'toggle', label: 'Fishing', default: true },
    { key: 'pongEnabled', type: 'toggle', label: 'Pong', default: true },
    ...Object.entries(MINI).map(([g, m]) => ({ key: `${g}Enabled`, type: 'toggle', label: m.label, default: true })),
    { key: 'fishChallenges', type: 'toggle', label: 'Fishing challenges (3 daily and 1 weekly, with coin and XP rewards)', default: true },
    { key: 'minBet', type: 'number', label: 'Smallest bet', default: 10, min: 1, max: 1000000 },
    { key: 'maxBet', type: 'number', label: 'Biggest bet', default: 50000, min: 1, max: 100000000 },
    { key: 'gamePictures', type: 'toggle', label: 'Animated pictures for slots, blackjack, coin flip and fishing (needs the canvas package; text otherwise)', default: true },
    { key: 'privateGames', type: 'toggle', label: 'Only the player sees their game (keeps the channel quiet)', default: true },
    { key: 'announceBigWins', type: 'toggle', label: 'Announce big wins publicly (no pings, at most one per member every 10 minutes)', default: false },
    { key: 'bigWinLevel', type: 'select', label: 'Which wins are announced', options: ['jackpots', 'mythical', 'rare'], default: 'mythical', description: 'jackpots = slots jackpots only · mythical = jackpots and Mythical fish · rare = also Legendary, Mutated and 20x+ slots' },
    { key: 'bigWinChannel', type: 'channel', label: 'Channel for big-win announcements (empty = where they played)' },
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
  }, {
    id: 2, // 2.3.3: daily and weekly fishing challenges, and the challenge streak
    sql: `CREATE TABLE games_fish_challenges (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, period TEXT NOT NULL, slot INTEGER NOT NULL, spec TEXT NOT NULL,
            progress INTEGER NOT NULL DEFAULT 0, seen TEXT NOT NULL DEFAULT '[]', done_at INTEGER, PRIMARY KEY (guild_id, user_id, period, slot));
          ALTER TABLE games_fish_profile ADD COLUMN streak INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE games_fish_profile ADD COLUMN streak_day TEXT;`,
  }, {
    id: 3, // 3.1: rod stars, and weekly challenges finished (for the Taskmaster rod)
    sql: `ALTER TABLE games_fish_profile ADD COLUMN rod_stars TEXT NOT NULL DEFAULT '{}';
          ALTER TABLE games_fish_profile ADD COLUMN weeklies INTEGER NOT NULL DEFAULT 0;`,
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
      permission: 'games.play',
      data: new SlashCommandBuilder().setName('pong').setDescription('Play turn-based Pong against Good Boy or another member')
        .addUserOption((o) => o.setName('opponent').setDescription('Who to challenge (leave empty to play Good Boy)')),
      execute: startPong,
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
      // Challenges older than two weeks are no longer shown anywhere.
      ctx.sql.run('DELETE FROM games_fish_challenges WHERE guild_id = ? AND substr(period, 3) < ?', ctx.guildId, CH.dayKey(Date.now() - 15 * 86400000));
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
