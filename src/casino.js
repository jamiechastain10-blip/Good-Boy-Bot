/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Casino rules as plain functions: slots, blackjack and coin flip. Randomness is passed in (`rng` returns an
 * integer in [0, n)), so tests can force any outcome and the real bot uses crypto.randomInt.
 *
 * The coins are play money that cannot be bought or cashed out. The house keeps a small edge on purpose: it is
 * the economy's main "coin sink", without which prices inflate and rewards stop feeling like rewards.
 */
import { randomInt } from 'node:crypto';

export const cryptoRng = (n) => randomInt(n);

// ------------------------------------------------------------------ slots
/** Reel strip. Weight = how many stops on each 32-stop reel show the symbol. */
export const SLOT_SYMBOLS = [
  { id: 'cherry', emoji: '🍒', weight: 10 },
  { id: 'lemon', emoji: '🍋', weight: 8 },
  { id: 'grape', emoji: '🍇', weight: 6 },
  { id: 'bell', emoji: '🔔', weight: 4 },
  { id: 'star', emoji: '⭐', weight: 2 },
  { id: 'diamond', emoji: '💎', weight: 1 },
  { id: 'seven', emoji: '7️⃣', weight: 1 },
];
export const REEL_STOPS = SLOT_SYMBOLS.reduce((a, s) => a + s.weight, 0);
/** Three of a kind pays bet x this. 7-7-7 pays the progressive jackpot on top. */
export const SLOT_TRIPLE = { cherry: 6, lemon: 10, grape: 18, bell: 40, star: 110, diamond: 280, seven: 500 };
/** Any two cherries anywhere pay a little back, so near-misses still feel alive. */
export const SLOT_TWO_CHERRIES = 1.5;
export const SLOT_PAIR = 0.2; // any other pair gives a fifth of the bet back (a "near miss")

export function spinReel(rng = cryptoRng) {
  let r = rng(REEL_STOPS);
  for (const s of SLOT_SYMBOLS) { if (r < s.weight) return s.id; r -= s.weight; }
  return SLOT_SYMBOLS[0].id;
}
export const slotEmoji = (id) => SLOT_SYMBOLS.find((s) => s.id === id)?.emoji ?? '❔';

/** Payout multiplier for three reels (not counting the jackpot pool). */
export function slotMultiplier([a, b, c]) {
  if (a === b && b === c) return SLOT_TRIPLE[a];
  const cherries = [a, b, c].filter((x) => x === 'cherry').length;
  if (cherries === 2) return SLOT_TWO_CHERRIES;
  if (a === b || b === c || a === c) return SLOT_PAIR;
  return 0;
}
export const isJackpot = (reels) => reels.every((r) => r === 'seven');

/** Exact return to player of the table above (jackpot pool excluded). About 94.6%; tests keep it between 85% and 100%. */
export function slotRtp() {
  let ev = 0;
  for (const a of SLOT_SYMBOLS) for (const b of SLOT_SYMBOLS) for (const c of SLOT_SYMBOLS) {
    ev += (a.weight * b.weight * c.weight) / REEL_STOPS ** 3 * slotMultiplier([a.id, b.id, c.id]);
  }
  return ev;
}

export function spinSlots(rng = cryptoRng) {
  const reels = [spinReel(rng), spinReel(rng), spinReel(rng)];
  return { reels, multiplier: slotMultiplier(reels), jackpot: isJackpot(reels) };
}

// ------------------------------------------------------------------ blackjack
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/** A shuffled single deck as short strings like "A♠" / "10♥" (stored as-is in the game session). */
export function newDeck(rng = cryptoRng) {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  for (let k = d.length - 1; k > 0; k--) { const j = rng(k + 1); [d[k], d[j]] = [d[j], d[k]]; }
  return d;
}
const rankOf = (card) => card.slice(0, -1);

/** Best total of a hand; `soft` when an ace still counts as 11. */
export function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    const r = rankOf(c);
    if (r === 'A') { aces++; total += 11; } else total += ['J', 'Q', 'K'].includes(r) ? 10 : Number(r);
  }
  while (total > 21 && aces) { total -= 10; aces--; }
  return { total, soft: aces > 0 };
}
export const isBlackjack = (cards) => cards.length === 2 && handValue(cards).total === 21;

/** A new round: player and dealer get two cards each. Natural blackjacks settle straight away. */
export function bjStart(bet, rng = cryptoRng) {
  const deck = newDeck(rng);
  const state = { bet, deck, player: [deck.pop(), deck.pop()], dealer: [deck.pop(), deck.pop()], doubled: false, done: false, result: null };
  if (isBlackjack(state.player) || isBlackjack(state.dealer)) return bjSettle(state);
  return state;
}
export const bjCanDouble = (s) => !s.done && s.player.length === 2 && !s.doubled;

export function bjHit(s) {
  if (s.done) return s;
  s.player.push(s.deck.pop());
  if (handValue(s.player).total > 21) return bjSettle(s);
  if (handValue(s.player).total === 21) return bjStand(s);
  return s;
}
/** Doubling: the bet is doubled (the caller takes the extra coins first), exactly one card, then the dealer plays. */
export function bjDouble(s) {
  if (!bjCanDouble(s)) return s;
  s.doubled = true; s.bet *= 2;
  s.player.push(s.deck.pop());
  return handValue(s.player).total > 21 ? bjSettle(s) : bjStand(s);
}
/** Dealer draws to 17 and stands on all 17s (including soft 17). */
export function bjStand(s) {
  if (s.done) return s;
  while (handValue(s.dealer).total < 17) s.dealer.push(s.deck.pop());
  return bjSettle(s);
}

/** Decides the round. `payout` is what goes back to the player (stake included): 0, bet, 2x bet, or 2.5x for blackjack. */
export function bjSettle(s) {
  const p = handValue(s.player).total, d = handValue(s.dealer).total;
  const pBJ = isBlackjack(s.player) && !s.doubled, dBJ = isBlackjack(s.dealer);
  let result;
  if (p > 21) result = 'bust';
  else if (pBJ && dBJ) result = 'push';
  else if (pBJ) result = 'blackjack';
  else if (dBJ) result = 'lose';
  else if (d > 21) result = 'win';
  else if (p > d) result = 'win';
  else if (p < d) result = 'lose';
  else result = 'push';
  const payout = result === 'blackjack' ? Math.floor(s.bet * 2.5) : result === 'win' ? s.bet * 2 : result === 'push' ? s.bet : 0;
  return Object.assign(s, { done: true, result, payout });
}

export const cardsText = (cards, hideSecond = false) => cards.map((c, k) => (hideSecond && k === 1 ? '🂠' : `\`${c}\``)).join(' ');

// ------------------------------------------------------------------ coin flip
/** Even odds; a win pays 1.95x (stake included). */
export const COINFLIP_PAYOUT = 1.95;
export function flipCoin(rng = cryptoRng) { return rng(2) === 0 ? 'heads' : 'tails'; }
