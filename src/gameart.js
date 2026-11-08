/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Animated pictures for the games (3.0.4): blackjack with real-looking cards that slide in and flip, the fishing scene
 * with rolling waves, a bobbing float, the reel meter and the catch card, spinning slot reels and a flipping coin.
 * Drawn with the optional @napi-rs/canvas package and saved as GIFs (Discord plays them in the message). Each function
 * returns { file, name } or null; null (no canvas installed, or drawing failed) means the game keeps its text look.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeGif } from './gif.js';

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard', 'public', 'fonts');
let lib; // undefined = not tried yet, null = not available
/** The canvas library with Good Boy's fonts, or null. */
export async function canvasLib() {
  if (lib !== undefined) return lib;
  try {
    const m = await import('@napi-rs/canvas');
    const L = m.default?.createCanvas ? m.default : m;
    try {
      L.GlobalFonts?.registerFromPath(path.join(FONT_DIR, 'Figtree.woff2'), 'GB Figtree');
      L.GlobalFonts?.registerFromPath(path.join(FONT_DIR, 'BricolageGrotesque.woff2'), 'GB Display');
    } catch { /* system fonts then */ }
    lib = typeof L.createCanvas === 'function' ? L : null;
  } catch { lib = null; }
  return lib;
}
/** Tests can switch the pictures off (or back on) to check the text fallback. */
export function _setCanvas(v) { lib = v; }

const UI = '"GB Figtree", "Segoe UI", sans-serif';
const DISPLAY = '"GB Display", "GB Figtree", "Segoe UI", sans-serif';
const C = { bg: '#1e2129', panel: '#16191f', line: 'rgba(255,255,255,.08)', text: '#f2f4f8', muted: '#9aa3b2', accent: '#6b93ff', good: '#3ba55d', bad: '#ed4245', coin: '#f2b33d', red: '#d6404b', ink: '#1c1f26', card: '#f6f3ec' };

function rr(g, x, y, w, h, r) { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h); }
function make(L, w, h, bg = C.bg) {
  const cv = L.createCanvas(w, h);
  const g = cv.getContext('2d');
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
  return { cv, g };
}
/**
 * Draws frames into a GIF. draw(g, k) paints frame k on a fresh background. delays: one per frame (ms).
 * loop: 0 = forever, -1 = play once and stay on the last frame.
 */
async function animate(L, W, H, delays, draw, { loop = 0, name = 'game' } = {}) {
  try {
    const frames = [];
    for (let k = 0; k < delays.length; k++) {
      const { g } = make(L, W, H);
      draw(g, k);
      frames.push({ rgba: g.getImageData(0, 0, W, H).data, delay: delays[k] });
    }
    return { file: await encodeGif({ width: W, height: H, loop, frames }), name: `${name}.gif` };
  } catch { return null; } // a drawing problem must never stop a game
}
const ease = (t) => 1 - (1 - t) ** 3;
// Play-once games stop on the result. If an app ignores "play once" and loops, the result frame still stays up for 10 minutes.
const HOLD = 600000;
function text(g, s, x, y, { size = 14, weight = 600, color = C.text, font = UI, align = 'left', base = 'alphabetic' } = {}) {
  g.font = `${weight} ${size}px ${font}`; g.fillStyle = color; g.textAlign = align; g.textBaseline = base; g.fillText(String(s), x, y);
}
function coin(g, x, y, r = 9) {
  const gr = g.createLinearGradient(x - r, y - r, x + r, y + r); gr.addColorStop(0, '#ffd877'); gr.addColorStop(1, '#d9901c');
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(120,70,0,.45)'; g.lineWidth = 1.2; g.beginPath(); g.arc(x, y, r - 2.5, 0, Math.PI * 2); g.stroke();
  text(g, 'G', x, y + 0.5, { size: r * 1.05, weight: 800, color: '#8a5200', align: 'center', base: 'middle' });
}

// ------------------------------------------------------------------ cards
/** Suit shapes drawn as paths, so no font needs the ♠♥♦♣ characters. */
function suit(g, s, cx, cy, size, color) {
  const k = size / 2; g.fillStyle = color; g.beginPath();
  if (s === '♦') { g.moveTo(cx, cy - k); g.lineTo(cx + k * 0.75, cy); g.lineTo(cx, cy + k); g.lineTo(cx - k * 0.75, cy); g.closePath(); g.fill(); return; }
  if (s === '♥') {
    g.moveTo(cx, cy + k * 0.9);
    g.bezierCurveTo(cx - k * 1.2, cy + k * 0.1, cx - k * 0.95, cy - k * 1.05, cx, cy - k * 0.35);
    g.bezierCurveTo(cx + k * 0.95, cy - k * 1.05, cx + k * 1.2, cy + k * 0.1, cx, cy + k * 0.9); g.fill(); return;
  }
  if (s === '♠') {
    g.moveTo(cx, cy - k * 0.95);
    g.bezierCurveTo(cx + k * 1.2, cy - k * 0.1, cx + k * 0.95, cy + k * 0.95, cx, cy + k * 0.3);
    g.bezierCurveTo(cx - k * 0.95, cy + k * 0.95, cx - k * 1.2, cy - k * 0.1, cx, cy - k * 0.95); g.fill();
  } else { // ♣
    const r = k * 0.42;
    for (const [dx, dy] of [[0, -0.45], [-0.48, 0.12], [0.48, 0.12]]) { g.beginPath(); g.arc(cx + dx * k, cy + dy * k, r, 0, Math.PI * 2); g.fill(); }
  }
  g.beginPath(); g.moveTo(cx, cy + k * 0.1); g.lineTo(cx + k * 0.32, cy + k); g.lineTo(cx - k * 0.32, cy + k); g.closePath(); g.fill();
}
function cardFace(g, card, x, y, w, h) {
  const rank = card.slice(0, -1), s = card.slice(-1), col = s === '♥' || s === '♦' ? C.red : C.ink;
  g.save(); g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 8; g.shadowOffsetY = 3;
  g.fillStyle = C.card; rr(g, x, y, w, h, 7); g.fill(); g.restore();
  text(g, rank === 'T' ? '10' : rank, x + w / 2, y + h * 0.42, { size: h * 0.36, weight: 800, color: col, font: DISPLAY, align: 'center', base: 'middle' });
  suit(g, s, x + w / 2, y + h * 0.76, h * 0.24, col);
}
function cardBack(g, x, y, w, h) {
  g.save(); g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 8; g.shadowOffsetY = 3;
  g.fillStyle = '#f6f3ec'; rr(g, x, y, w, h, 7); g.fill(); g.restore();
  g.save(); rr(g, x + 3, y + 3, w - 6, h - 6, 5); g.clip();
  g.fillStyle = '#3f63d8'; g.fillRect(x, y, w, h);
  g.strokeStyle = 'rgba(255,255,255,.28)'; g.lineWidth = 3;
  for (let d = -h; d < w + h; d += 9) { g.beginPath(); g.moveTo(x + d, y); g.lineTo(x + d - h, y + h); g.stroke(); }
  g.restore();
}
const CW = 50, CH = 70;
function slotX(x, k, n, maxW = 260) { const gap = Math.min(8, (maxW - CW * n) / Math.max(1, n - 1)); return x + k * (n > 1 ? Math.min(CW + 8, CW + gap) : 0); }
/** One hand. from: cards at or after this index slide in (t 0..1); flipT: the hidden card turning over (0..1). */
function hand(g, label, cards, total, x, y, { hide = false, from = cards.length, t = 1, flipT = null, W = 560 } = {}) {
  text(g, label, x, y, { size: 13, weight: 700, color: C.text });
  const n = cards.length;
  cards.forEach((c, k) => {
    let cx = slotX(x, k, n), cy = y + 10;
    if (k >= from) { const e = ease(Math.max(0, Math.min(1, t * 1.6 - (k - from) * 0.6))); cx = W + 10 + (cx - W - 10) * e; cy = -CH + (cy + CH) * e; }
    if (k === 1 && flipT != null) {
      const sx = Math.abs(Math.cos(flipT * Math.PI)), showFace = flipT >= 0.5;
      g.save(); g.translate(cx + CW / 2, cy); g.scale(Math.max(0.04, sx), 1);
      if (showFace) cardFace(g, c, -CW / 2, 0, CW, CH); else cardBack(g, -CW / 2, 0, CW, CH);
      g.restore(); return;
    }
    if (hide && k === 1) cardBack(g, cx, cy, CW, CH); else cardFace(g, c, cx, cy, CW, CH);
  });
  text(g, total, x, y + 10 + CH + 20, { size: 13, weight: 600, color: C.muted });
}
function resultBar(g, W, y, result) {
  g.fillStyle = C.panel; rr(g, 16, y, W - 32, 42, 8); g.fill();
  coin(g, 38, y + 21, 9);
  text(g, result.text, 56, y + 26, { size: 14, weight: 600, color: C.text, font: '"Consolas", "DejaVu Sans Mono", monospace' });
  if (result.net) text(g, `${result.net > 0 ? '+' : ''}${Number(result.net).toLocaleString('en-US')}`, W - 30, y + 26, { size: 15, weight: 800, color: result.net > 0 ? '#57d68d' : '#ff7b7f', align: 'right' });
}

/**
 * Blackjack table, animated once: new cards slide in from the shoe, and the dealer's face-down card turns over when it
 * is revealed. player/dealer: card strings like "K♠" ("T" is ten). hide: the dealer's second card is face down.
 * newPlayer/newDealer: index of the first card that was just dealt. flip: the hidden card was just revealed.
 * result: { text, net } once the hand is over.
 */
export async function blackjackImage({ player, dealer, hide = false, playerTotal, dealerTotal, result = null, newPlayer = player.length, newDealer = dealer.length, flip = false }) {
  const L = await canvasLib(); if (!L) return null;
  const W = 560, H = result ? 210 : 160;
  const moving = newPlayer < player.length || newDealer < dealer.length;
  const flipFrames = flip ? 6 : 0, slideFrames = moving ? 7 : 0;
  const delays = [...Array(flipFrames).fill(55), ...Array(slideFrames).fill(45), HOLD];
  return animate(L, W, H, delays, (g, k) => {
    const flipT = flip ? (k < flipFrames ? (k + 1) / flipFrames : null) : null;
    const t = k < flipFrames ? 0 : moving ? Math.min(1, (k - flipFrames + 1) / slideFrames) : 1;
    const last = k === delays.length - 1;
    hand(g, 'Your hand', player, String(playerTotal), 18, 24, { from: newPlayer, t: last ? 1 : t, W });
    hand(g, 'Dealer', dealer, hide ? `${dealerTotal} + ?` : String(dealerTotal), 296, 24, { hide, from: flip && k < flipFrames ? dealer.length : newDealer, t: last ? 1 : t, flipT: last ? null : flipT, W });
    if (result && last) resultBar(g, W, 152, result);
  }, { loop: -1, name: 'blackjack' });
}

// ------------------------------------------------------------------ fishing
const PALETTES = {
  bay: ['#ffb38a', '#ff8f6b', '#2f6f9f', '#123a5c', '#ffe9a8'], marsh: ['#a9c98b', '#6f9a5e', '#3d5f3a', '#1d3320', '#f3f0b0'],
  glacier: ['#cfe8ff', '#9ccaf0', '#4d8fc4', '#1b4d7a', '#ffffff'], vents: ['#ff9a5a', '#c2412b', '#5a2a2a', '#2a1212', '#ffd27a'],
  deep: ['#2b2f4a', '#161a2e', '#1a2340', '#070b18', '#8ea0ff'], reef: ['#7f8fb8', '#3b4a77', '#2a5c7a', '#0f2d44', '#e8f3ff'],
  spire: ['#d9c79b', '#a8916a', '#3e6f80', '#173845', '#fff1c4'], trench: ['#3a2d6b', '#1d1640', '#21486b', '#0a1a33', '#b8fff2'],
  abyss: ['#1b1638', '#0b0920', '#1a1f45', '#05061a', '#ffe58a'], mangrove: ['#bcd59a', '#7fa36a', '#3f5e3b', '#1b2e1c', '#fff4b8'],
  oasis: ['#ffd59a', '#f0a960', '#38a3a5', '#1d6670', '#fff3c2'], kelp: ['#8fd3c1', '#4e9e8c', '#1f6b62', '#0b3532', '#e9fff5'],
  caverns: ['#5b4b8a', '#2c2350', '#3c5aa6', '#152452', '#d2e1ff'], lotus: ['#ffc6dc', '#f39ac0', '#4a8fb3', '#1f4e6e', '#fff2f7'],
  wreck: ['#9aa6b2', '#5f6b78', '#38505f', '#16242e', '#e7edf2'], skyfall: ['#cfe4ff', '#9ec4ff', '#6fa0e8', '#2f5ea8', '#ffffff'],
  clockwork: ['#e2b77a', '#a8743c', '#4b5d6b', '#1f2a33', '#fff0c9'], caldera: ['#ff8a4c', '#b8322a', '#6b2b26', '#2e0f0e', '#ffd0a0'],
  fjord: ['#9fb8c9', '#5f7a8f', '#2d4a5f', '#0f2130', '#e6fbff'], shoals: ['#ffc2e2', '#ff8fc6', '#5bc8e8', '#1f86b0', '#fff6fb'],
  mirror: ['#d7dde8', '#aab4c6', '#8fa0bd', '#4d5e80', '#ffffff'], rift: ['#7a4a3a', '#3b211b', '#3d3550', '#141020', '#ffcf8a'],
  dreamtide: ['#3c2f7a', '#1b1545', '#2b3b8f', '#0d1440', '#fff0b8'],
};
const RARITY_COL = { common: '#a8b2bd', uncommon: '#4fd17e', rare: '#4aa3ff', epic: '#b07cff', legendary: '#ffd34d', mythical: '#ff5fa2' };
function fishShape(g, x, y, len, color, alpha = 1) {
  g.save(); g.globalAlpha = alpha; g.fillStyle = color; g.beginPath();
  g.ellipse(x, y, len / 2, len / 5.2, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(x + len / 2 - 3, y); g.lineTo(x + len / 2 + len / 4, y - len / 6); g.lineTo(x + len / 2 + len / 4, y + len / 6); g.closePath(); g.fill();
  g.restore();
}
function scene(g, W, H, pal, { bite = false, step = 0, tug = 0, phase = 0 }) {
  const [sky1, sky2, w1, w2, sun] = pal, horizon = H * 0.36;
  let gr = g.createLinearGradient(0, 0, 0, horizon); gr.addColorStop(0, sky1); gr.addColorStop(1, sky2); g.fillStyle = gr; g.fillRect(0, 0, W, horizon);
  g.fillStyle = sun; g.globalAlpha = 0.9; g.beginPath(); g.arc(W * 0.72, horizon - 8, 26, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
  gr = g.createLinearGradient(0, horizon, 0, H); gr.addColorStop(0, w1); gr.addColorStop(1, w2); g.fillStyle = gr; g.fillRect(0, horizon, W, H - horizon);
  g.fillStyle = 'rgba(255,255,255,.16)';
  for (let row = 0; row < 3; row++) {
    const y = horizon + 6 + row * 28, off = ((step * 9) + row * 23 + phase * 6 * (row % 2 ? -1 : 1)) % 60 + (row % 2 ? 60 : 0);
    for (let x = -60 + off; x < W; x += 60) g.fillRect(x, y, 22, 5);
  }
  const bob = bite ? Math.abs(Math.sin(phase * 1.3)) * 7 : Math.sin(phase * 0.8) * 2.2;
  const bx = W * 0.47 + tug + (bite ? Math.sin(phase * 2.1) * 3 : 0), by = horizon + 14 + bob;
  g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 1.4; g.beginPath(); g.moveTo(W - 6, 0); g.lineTo(bx, by - 7); g.stroke();
  { const grow = (phase % 4) / 4; g.strokeStyle = `rgba(255,255,255,${bite ? 0.6 * (1 - grow) : 0.3 * (1 - grow)})`; g.lineWidth = 1.5; for (const r of bite ? [10 + grow * 18, 20 + grow * 18] : [9 + grow * 12]) { g.beginPath(); g.ellipse(bx, horizon + 18, r, r / 3.2, 0, 0, Math.PI * 2); g.stroke(); } }
  g.fillStyle = '#ffffff'; g.beginPath(); g.arc(bx, by, 7, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#e8414b'; g.beginPath(); g.arc(bx, by, 7, Math.PI, 0); g.fill();
  if (bite && phase % 2 === 0) text(g, '!', bx + 2, by - 16, { size: 22, weight: 800, color: '#ffffff', align: 'center' });
  fishShape(g, W * 0.43 + tug * 1.5 + Math.sin(phase * 0.6) * (bite ? 10 : 18), H * 0.8 - (bite ? 10 : 0), 52, '#06121f', bite ? 0.55 : 0.35);
}
/**
 * The fishing message picture. s: the reel state (pos, zone, progress, tension...); control/line: the rod's values;
 * track: the track length. phase: 'waiting' | 'reeling' | 'caught' | 'escaped'. catchInfo for a landed fish.
 */
export async function fishingImage({ biome, title, phase, s = null, control = 4, line = 100, track = 20, hint = '', catchInfo = null }) {
  const L = await canvasLib(); if (!L) return null;
  const W = 560, SH = 220, below = phase === 'reeling' ? 74 : phase === 'caught' ? 78 : 34;
  const H = SH + below + 14;
  const pal = PALETTES[biome] ?? PALETTES.bay;
  const n = phase === 'escaped' ? 1 : 8;
  return animate(L, W, H, Array(n).fill(phase === 'reeling' ? 110 : 140), (g, k) => {
    g.save(); rr(g, 0, 0, W, SH, 10); g.clip();
    scene(g, W, SH, pal, { bite: phase === 'reeling', step: s?.step ?? 0, phase: k, tug: phase === 'reeling' && s ? ((s.pos - track / 2) / track) * 30 : 0 });
    g.restore();
    if (title) { g.font = `700 13px ${UI}`; const tw = g.measureText(title).width; g.fillStyle = 'rgba(10,14,22,.55)'; rr(g, 10, 10, tw + 24, 26, 13); g.fill(); text(g, title, 22, 28, { size: 13, weight: 700 }); }
    let y = SH + 14;
    if (phase === 'reeling' && s) {
      text(g, hint || 'Press Reel when the fish is in the green', 4, y + 10, { size: 13, weight: 500, color: C.muted });
      text(g, `Catch ${s.progress}%`, W - 4, y + 10, { size: 13, weight: 700, color: C.text, align: 'right' });
      y += 20;
      g.fillStyle = '#0f1218'; rr(g, 2, y, W - 4, 20, 5); g.fill();
      const cell = (W - 4) / track;
      g.fillStyle = 'rgba(59,165,93,.55)'; g.strokeStyle = '#3ba55d'; g.lineWidth = 1.5; rr(g, 2 + s.zone * cell, y, control * cell, 20, 4); g.fill(); g.stroke();
      const jitter = Math.sin(k * 1.7) * cell * 0.18;
      g.fillStyle = '#ffffff'; rr(g, 2 + (s.pos + 0.5) * cell - 3 + jitter, y - 3, 6, 26, 3); g.fill();
      y += 30;
      const pct = Math.max(0, Math.min(1, s.tension / line)), seg = 10, sw = (W - 4 - (seg - 1) * 6) / seg;
      for (let q = 0; q < seg; q++) { const on = (q + 1) / seg <= pct + 0.001; const hot = on && q >= 7; g.fillStyle = on ? (hot ? (k % 2 ? '#ff8a96' : '#ef5a6a') : '#f2b33d') : '#2a2f3a'; rr(g, 2 + q * (sw + 6), y, sw, 7, 3.5); g.fill(); }
      text(g, 'Tension', 4, y + 22, { size: 11, weight: 600, color: C.muted });
    } else if (phase === 'caught' && catchInfo) {
      const col = RARITY_COL[catchInfo.rarity] ?? '#ffffff';
      const gr = g.createLinearGradient(0, y, W, y); gr.addColorStop(0, 'rgba(120,90,200,.35)'); gr.addColorStop(1, 'rgba(40,44,58,.9)');
      g.fillStyle = gr; rr(g, 2, y, W - 4, 64, 10); g.fill();
      const special = ['legendary', 'mythical', 'epic'].includes(catchInfo.rarity) || catchInfo.mutation;
      if (special) { const sx = -120 + (k / (n - 1)) * (W + 240); const sh = g.createLinearGradient(sx, 0, sx + 120, 0); sh.addColorStop(0, 'rgba(255,255,255,0)'); sh.addColorStop(0.5, 'rgba(255,255,255,.25)'); sh.addColorStop(1, 'rgba(255,255,255,0)'); g.save(); rr(g, 2, y, W - 4, 64, 10); g.clip(); g.fillStyle = sh; g.fillRect(2, y, W - 4, 64); g.restore(); }
      fishShape(g, 40, y + 32 + Math.sin(k * 0.9) * 2, 34, col);
      text(g, catchInfo.title, 78, y + 27, { size: 15, weight: 800, color: col, font: DISPLAY });
      text(g, catchInfo.sub, 78, y + 48, { size: 12.5, weight: 500, color: '#c9d0dc' });
    } else {
      text(g, hint, 4, y + 14, { size: 13, weight: 500, color: C.muted });
    }
  }, { loop: 0, name: 'fishing' });
}

// ------------------------------------------------------------------ slots and the coin
const SLOT_ART = {
  '🍒': (g, x, y) => { g.strokeStyle = '#3f8f3a'; g.lineWidth = 3; g.beginPath(); g.moveTo(x - 8, y - 2); g.quadraticCurveTo(x, y - 26, x + 6, y - 24); g.moveTo(x + 9, y + 2); g.quadraticCurveTo(x + 6, y - 18, x + 6, y - 24); g.stroke(); for (const [dx, dy] of [[-9, 6], [10, 9]]) { g.fillStyle = '#e0313f'; g.beginPath(); g.arc(x + dx, y + dy, 11, 0, Math.PI * 2); g.fill(); g.fillStyle = 'rgba(255,255,255,.5)'; g.beginPath(); g.arc(x + dx - 4, y + dy - 4, 3, 0, Math.PI * 2); g.fill(); } },
  '🍋': (g, x, y) => { g.fillStyle = '#ffd43b'; g.beginPath(); g.ellipse(x, y, 22, 15, -0.3, 0, Math.PI * 2); g.fill(); g.fillStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.ellipse(x - 6, y - 5, 7, 3, -0.3, 0, Math.PI * 2); g.fill(); },
  '🍇': (g, x, y) => { g.fillStyle = '#8e5bd6'; for (const [dx, dy] of [[-10, -8], [0, -8], [10, -8], [-5, 2], [5, 2], [0, 12]]) { g.beginPath(); g.arc(x + dx, y + dy, 7, 0, Math.PI * 2); g.fill(); } g.fillStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.arc(x - 12, y - 10, 2.4, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#3f8f3a'; g.lineWidth = 3; g.beginPath(); g.moveTo(x, y - 15); g.lineTo(x + 4, y - 24); g.stroke(); },
  '🔔': (g, x, y) => { g.fillStyle = '#f2b33d'; g.beginPath(); g.moveTo(x - 20, y + 12); g.quadraticCurveTo(x - 16, y - 22, x, y - 22); g.quadraticCurveTo(x + 16, y - 22, x + 20, y + 12); g.closePath(); g.fill(); g.beginPath(); g.arc(x, y + 15, 5, 0, Math.PI * 2); g.fill(); },
  '💎': (g, x, y) => { g.fillStyle = '#59c7ff'; g.beginPath(); g.moveTo(x - 20, y - 6); g.lineTo(x - 10, y - 18); g.lineTo(x + 10, y - 18); g.lineTo(x + 20, y - 6); g.lineTo(x, y + 20); g.closePath(); g.fill(); g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x - 20, y - 6); g.lineTo(x + 20, y - 6); g.moveTo(x - 6, y - 18); g.lineTo(x, y + 20); g.lineTo(x + 6, y - 18); g.stroke(); },
  '7️⃣': (g, x, y) => text(g, '7', x, y + 2, { size: 46, weight: 800, color: '#ef4b5a', font: DISPLAY, align: 'center', base: 'middle' }),
  '⭐': (g, x, y) => { g.fillStyle = '#ffd43b'; g.beginPath(); for (let k = 0; k < 10; k++) { const r = k % 2 ? 9 : 22, a = -Math.PI / 2 + k * Math.PI / 5; g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); } g.closePath(); g.fill(); },
};
const SPIN_SYMBOLS = Object.keys(SLOT_ART);
/**
 * Slot reels, animated once: all three spin, then stop one by one on symbols, and the result note appears.
 * symbols: what each reel lands on (emoji strings from the game).
 */
export async function slotsImage({ symbols, note = null, win = false }) {
  const L = await canvasLib(); if (!L) return null;
  const W = 420, H = note ? 170 : 128;
  const stopAt = [6, 10, 14], total = 16;
  const delays = Array.from({ length: total }, (_, k) => (k === total - 1 ? HOLD : 70));
  return animate(L, W, H, delays, (g, k) => {
    const rw = 116, gap = 14, x0 = (W - (rw * 3 + gap * 2)) / 2;
    symbols.forEach((sym, r) => {
      const x = x0 + r * (rw + gap), stopped = k >= stopAt[r];
      const gr = g.createLinearGradient(0, 14, 0, 114); gr.addColorStop(0, '#d9dde6'); gr.addColorStop(0.5, '#ffffff'); gr.addColorStop(1, '#d9dde6');
      g.fillStyle = gr; rr(g, x, 14, rw, 100, 10); g.fill();
      g.save(); rr(g, x, 14, rw, 100, 10); g.clip();
      if (stopped) {
        const bounce = k === stopAt[r] ? 8 : 0;
        const art = SLOT_ART[sym];
        if (art) art(g, x + rw / 2, 64 + bounce); else text(g, sym, x + rw / 2, 66 + bounce, { size: 40, align: 'center', base: 'middle', color: C.ink });
      } else {
        const off = (k * 37 + r * 23) % 100;
        for (let q = -1; q < 2; q++) { const s2 = SPIN_SYMBOLS[(k + r + q + 3) % SPIN_SYMBOLS.length]; g.globalAlpha = 0.55; SLOT_ART[s2](g, x + rw / 2, 64 + q * 100 + off - 50); g.globalAlpha = 1; }
        g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(x, 14, rw, 100);
      }
      g.restore();
      if (win && k === total - 1) { g.strokeStyle = C.coin; g.lineWidth = 3; rr(g, x, 14, rw, 100, 10); g.stroke(); }
    });
    if (note && k === total - 1) { g.fillStyle = C.panel; rr(g, 14, 124, W - 28, 36, 8); g.fill(); coin(g, 34, 142, 8); text(g, note, 50, 147, { size: 13.5, weight: 600, color: win ? '#ffd877' : C.text }); }
  }, { loop: -1, name: 'slots' });
}
/** The coin flip, animated once: the coin spins in the air, lands on side ('heads' / 'tails'), then the note shows. */
export async function coinImage({ side, note = null, won = false }) {
  const L = await canvasLib(); if (!L) return null;
  const W = 320, H = note ? 190 : 150, spins = 12;
  const delays = [...Array(spins).fill(60), HOLD];
  return animate(L, W, H, delays, (g, k) => {
    const cx = W / 2, landed = k === spins;
    const up = landed ? 0 : Math.sin((k / spins) * Math.PI) * 40;
    const sy = landed ? 1 : Math.max(0.08, Math.abs(Math.cos(k * 0.9)));
    g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.ellipse(cx, 130, 40 - up / 3, 6, 0, 0, Math.PI * 2); g.fill();
    g.save(); g.translate(cx, 74 - up); g.scale(1, sy); coin(g, 0, 0, 48); g.restore();
    if (landed) {
      text(g, side === 'heads' ? 'Heads' : 'Tails', cx, 152, { size: 15, weight: 800, align: 'center', font: DISPLAY });
      if (note) text(g, note, cx, 178, { size: 13.5, weight: 700, color: won ? '#57d68d' : '#ff7b7f', align: 'center' });
    }
  }, { loop: -1, name: 'coinflip' });
}
