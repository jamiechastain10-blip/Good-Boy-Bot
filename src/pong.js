/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Turn-based Pong as plain functions. Discord can only change a message about once a second, so this Pong moves in
 * turns: the ball always travels towards one player, and that player moves their paddle (up, stay, down). Then the
 * ball flies two squares. Good Boy plays its own paddle when it is your opponent. Everything comes from the saved
 * state and a seed, so a restart in the middle of a rally changes nothing.
 *
 *   ⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛
 *   🟦⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛
 *   🟦⬛⬛⬛⬛⚪⬛⬛⬛⬛⬛⬛🟥
 *   🟦⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛🟥
 *   ⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛🟥
 */
import { seeded } from './fishing.js';

export const W = 13, H = 7, PADDLE = 3, TO = 3, STEPS = 2;
export const MOVES = { up: -1, stay: 0, down: 1 };

/** right: a user id, or 'bot' for Good Boy. */
export function newGame({ left, right, seed = 1, to = TO }) {
  const s = { left: { id: left, y: 2 }, right: { id: right, y: 2 }, score: [0, 0], to, seed: seed >>> 0, n: 0, status: 'playing', last: null, rally: 0 };
  serve(s, 'left');
  return s;
}
/** Puts the ball in the middle, flying towards `towards`. */
function serve(s, towards) {
  const r = seeded(s.seed + s.n * 9973)();
  s.ball = { x: Math.floor(W / 2), y: 1 + Math.floor(r * (H - 2)), dx: towards === 'left' ? -1 : 1, dy: r < 0.5 ? -1 : 1 };
  s.rally = 0;
}
/** Whose move it is: the side the ball is flying towards. */
export const turn = (s) => (s.ball.dx < 0 ? 'left' : 'right');
export const turnId = (s) => s[turn(s)].id;
const clampPaddle = (y) => Math.max(0, Math.min(H - PADDLE, y));

/** Good Boy's paddle: heads for where the ball will be, but sometimes misjudges (seeded, so it plays the same). */
function botMove(s) {
  const r = seeded(s.seed ^ (s.n * 7919))();
  let target = s.ball.y;
  // Predict the arrival row with bounces.
  let { x, y, dy } = s.ball;
  while (x > 0 && x < W - 1) { x += s.ball.dx; y += dy; if (y < 0 || y > H - 1) { dy = -dy; y += 2 * dy; } }
  target = y;
  if (r < 0.3) target += r < 0.15 ? 2 : -2; // a miss now and then
  const centre = s.right.y + 1;
  return target < centre ? 'up' : target > centre ? 'down' : 'stay';
}

/** One step of the ball. Returns 'left' or 'right' when that side scores. */
function stepBall(s) {
  const b = s.ball;
  b.x += b.dx; b.y += b.dy;
  if (b.y < 0) { b.y = 1; b.dy = 1; }
  if (b.y > H - 1) { b.y = H - 2; b.dy = -1; }
  const side = b.x <= 0 ? 'left' : b.x >= W - 1 ? 'right' : null;
  if (!side) return null;
  const p = s[side];
  if (b.y >= p.y && b.y < p.y + PADDLE) {
    // Hit: bounce back; where it hits the paddle sets the angle.
    b.x = side === 'left' ? 1 : W - 2; b.dx = -b.dx;
    const spot = b.y - p.y; b.dy = spot === 0 ? -1 : spot === PADDLE - 1 ? 1 : b.dy;
    s.rally += 1;
    return null;
  }
  return side === 'left' ? 'right' : 'left';
}

/**
 * The player whose turn it is moves (up, stay or down), then the ball flies STEPS squares. If it is then Good Boy's
 * turn, Good Boy moves at once and the ball flies on, until it is a person's turn again or someone scores.
 * Returns the same (changed) state. Throws if it is not this player's turn.
 */
export function play(s, userId, move) {
  if (s.status !== 'playing') return s;
  if (!(move in MOVES)) throw new Error('Unknown move.');
  if (turnId(s) !== userId) throw new Error(s.left.id === userId || s.right.id === userId ? 'It is not your turn yet. The ball is flying the other way.' : 'This is not your game.');
  let mover = turn(s), m = move;
  for (let guard = 0; guard < 50; guard++) {
    s[mover].y = clampPaddle(s[mover].y + MOVES[m]);
    s.n += 1; s.last = null;
    for (let k = 0; k < STEPS; k++) {
      const scorer = stepBall(s);
      if (!scorer) continue;
      s.score[scorer === 'left' ? 0 : 1] += 1; s.last = scorer;
      if (Math.max(...s.score) >= s.to) { s.status = 'over'; return s; }
      serve(s, scorer === 'left' ? 'right' : 'left'); // the side that lost the point receives
      break;
    }
    if (s[turn(s)].id !== 'bot') return s;
    mover = turn(s); m = botMove(s);
  }
  return s;
}

export const winner = (s) => (s.status !== 'over' ? null : s.score[0] > s.score[1] ? s.left.id : s.right.id);

/** The court as emoji rows. ball: the emoji to use for the ball. */
export function court(s, ball = '⚪') {
  const rows = [];
  for (let y = 0; y < H; y++) {
    let line = '';
    for (let x = 0; x < W; x++) {
      if (x === 0 && y >= s.left.y && y < s.left.y + PADDLE) line += '🟦';
      else if (x === W - 1 && y >= s.right.y && y < s.right.y + PADDLE) line += '🟥';
      else if (s.status === 'playing' && x === s.ball.x && y === s.ball.y) line += ball;
      else line += x === Math.floor(W / 2) && y % 2 === 0 ? '▫️' : '⬛';
    }
    rows.push(line);
  }
  return rows.join('\n');
}
