/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Good Boy's own roleplay animations (3.1): two little pups acting out hugs, pats, boops, bonks and the rest, drawn
 * with the optional canvas package and saved as small looping GIFs. Each action is drawn once and kept in memory.
 * Returns null if the canvas package is missing (the message then has no picture, or a Tenor GIF if set up).
 */
import { canvasLib } from './gameart.js';
import { encodeGif } from './gif.js';

const W = 260, H = 150, FRAMES = 12;
const COL = { bg: '#1b2130', a: '#f2c38b', b: '#9ec4ff', ear: 'rgba(0,0,0,.18)', ink: '#2a2230', heart: '#ff6b9a', star: '#ffd34d', tear: '#7cc8ff', blush: 'rgba(255,107,154,.45)' };

/** What each action looks like: a motion and what floats around. */
export const ACTIONS = {
  hug: { verb: 'hugged', solo: false, motion: 'together', fx: 'hearts', emoji: '🤗' },
  cuddle: { verb: 'cuddled', solo: false, motion: 'together', fx: 'hearts', emoji: '🥰' },
  kiss: { verb: 'kissed', solo: false, motion: 'kiss', fx: 'hearts', emoji: '😘' },
  handhold: { verb: 'held hands with', solo: false, motion: 'near', fx: 'sparkle', emoji: '🤝' },
  highfive: { verb: 'high-fived', solo: false, motion: 'near', fx: 'stars', emoji: '🙌' },
  pat: { verb: 'patted', solo: false, motion: 'pat', fx: 'sparkle', emoji: '🫳' },
  boop: { verb: 'booped', solo: false, motion: 'poke', fx: 'sparkle', emoji: '👉' },
  poke: { verb: 'poked', solo: false, motion: 'poke', fx: 'none', emoji: '👉' },
  tickle: { verb: 'tickled', solo: false, motion: 'poke', fx: 'laugh', emoji: '🤭' },
  feed: { verb: 'fed', solo: false, motion: 'poke', fx: 'hearts', emoji: '🍪' },
  bonk: { verb: 'bonked', solo: false, motion: 'bonk', fx: 'stars', emoji: '🔨' },
  slap: { verb: 'slapped', solo: false, motion: 'slap', fx: 'stars', emoji: '✋' },
  bite: { verb: 'bit', solo: false, motion: 'kiss', fx: 'stars', emoji: '😬' },
  wave: { verb: 'waved at', solo: true, motion: 'wave', fx: 'sparkle', emoji: '👋' },
  dance: { verb: 'is dancing', solo: true, motion: 'dance', fx: 'notes', emoji: '💃' },
  cry: { verb: 'is crying', solo: true, motion: 'still', fx: 'tears', emoji: '😢' },
  blush: { verb: 'is blushing', solo: true, motion: 'still', fx: 'blush', emoji: '😊' },
  smile: { verb: 'is smiling', solo: true, motion: 'bounce', fx: 'sparkle', emoji: '😄' },
  laugh: { verb: 'is laughing', solo: true, motion: 'shake', fx: 'laugh', emoji: '😂' },
  sleep: { verb: 'fell asleep', solo: true, motion: 'still', fx: 'zzz', emoji: '😴' },
};

function pup(g, x, y, color, { flip = false, eyes = 'open', blush = false, tilt = 0, paw = null } = {}) {
  g.save(); g.translate(x, y); g.rotate(tilt); if (flip) g.scale(-1, 1);
  g.fillStyle = color;
  g.beginPath(); g.ellipse(0, 26, 26, 18, 0, 0, Math.PI * 2); g.fill();            // body
  g.beginPath(); g.arc(0, 0, 24, 0, Math.PI * 2); g.fill();                         // head
  g.fillStyle = COL.ear;
  g.beginPath(); g.ellipse(-18, -14, 8, 13, -0.5, 0, Math.PI * 2); g.fill();        // ears
  g.beginPath(); g.ellipse(18, -14, 8, 13, 0.5, 0, Math.PI * 2); g.fill();
  g.fillStyle = COL.ink; g.strokeStyle = COL.ink; g.lineWidth = 2.2; g.lineCap = 'round';
  if (eyes === 'open') { g.beginPath(); g.arc(-8, -3, 3, 0, Math.PI * 2); g.arc(8, -3, 3, 0, Math.PI * 2); g.fill(); }
  else if (eyes === 'happy') { g.beginPath(); g.arc(-8, -2, 4, Math.PI * 1.1, Math.PI * 1.9); g.moveTo(12, -3.5); g.arc(8, -2, 4, Math.PI * 1.1, Math.PI * 1.9); g.stroke(); }
  else { g.beginPath(); g.moveTo(-12, -2); g.lineTo(-4, -2); g.moveTo(4, -2); g.lineTo(12, -2); g.stroke(); }
  g.beginPath(); g.arc(0, 5, 3, 0, Math.PI * 2); g.fill();                           // nose
  g.beginPath(); g.arc(0, 8, 5, 0.2, Math.PI - 0.2); g.stroke();                    // smile
  if (blush) { g.fillStyle = COL.blush; g.beginPath(); g.ellipse(-14, 6, 5, 3, 0, 0, Math.PI * 2); g.ellipse(14, 6, 5, 3, 0, 0, Math.PI * 2); g.fill(); }
  if (paw) { g.fillStyle = color; g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 1.5; g.beginPath(); g.arc(paw[0], paw[1], 7, 0, Math.PI * 2); g.fill(); g.stroke(); }
  g.restore();
}
function heart(g, x, y, s, a = 1) {
  g.save(); g.globalAlpha = a; g.fillStyle = COL.heart; g.translate(x, y); g.scale(s, s);
  g.beginPath(); g.moveTo(0, 6); g.bezierCurveTo(-10, -2, -6, -10, 0, -4); g.bezierCurveTo(6, -10, 10, -2, 0, 6); g.fill(); g.restore();
}
function star(g, x, y, r, a = 1) {
  g.save(); g.globalAlpha = a; g.fillStyle = COL.star; g.beginPath();
  for (let k = 0; k < 10; k++) { const rr = k % 2 ? r / 2.4 : r, t = -Math.PI / 2 + k * Math.PI / 5; g.lineTo(x + Math.cos(t) * rr, y + Math.sin(t) * rr); }
  g.closePath(); g.fill(); g.restore();
}
function label(g, s, x, y, a = 1, size = 14, color = '#e9edf5') { g.save(); g.globalAlpha = a; g.fillStyle = color; g.font = `700 ${size}px "GB Figtree", sans-serif`; g.textAlign = 'center'; g.fillText(s, x, y); g.restore(); }

function frame(g, action, k) {
  const t = k / FRAMES, s = Math.sin(t * Math.PI * 2), up = Math.abs(Math.sin(t * Math.PI * 2));
  const A = ACTIONS[action];
  g.fillStyle = COL.bg; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,255,255,.05)'; g.beginPath(); g.ellipse(W / 2, H - 22, 110, 10, 0, 0, Math.PI * 2); g.fill();
  const baseY = 82;
  let ax = 85, bx = 175, ay = baseY, by = baseY, aOpt = {}, bOpt = { flip: true };
  switch (A.motion) {
    case 'together': { const c = up * 26; ax += c; bx -= c; aOpt = { eyes: up > 0.6 ? 'happy' : 'open' }; bOpt = { flip: true, eyes: up > 0.6 ? 'happy' : 'open', blush: up > 0.5 }; break; }
    case 'kiss': { const c = up * 32; ax += c; bx -= c; aOpt = { eyes: 'closed' }; bOpt = { flip: true, blush: true, eyes: up > 0.7 ? 'closed' : 'open' }; break; }
    case 'near': { ax += 18; bx -= 18; aOpt = { paw: [24, 8 - up * 18], eyes: 'happy' }; bOpt = { flip: true, paw: [24, 8 - up * 18], eyes: 'happy' }; break; }
    case 'pat': { ax += 24; by += up * 4; aOpt = { paw: [26, -26 + up * 10] }; bOpt = { flip: true, eyes: 'happy', blush: true }; break; }
    case 'poke': { ax += 12; aOpt = { paw: [24 + up * 22, 6] }; bOpt = { flip: true, tilt: -up * 0.12, eyes: up > 0.7 ? 'closed' : 'open' }; break; }
    case 'bonk': { ax += 16; aOpt = { paw: [30, -34 + up * 22] }; by += up * 6; bOpt = { flip: true, eyes: up > 0.6 ? 'closed' : 'open', tilt: up * 0.08 }; break; }
    case 'slap': { ax += 18; aOpt = { paw: [20 + up * 30, -2] }; bOpt = { flip: true, tilt: -up * 0.3, eyes: up > 0.5 ? 'closed' : 'open' }; bx += up * 6; break; }
    case 'wave': { ax = W / 2; aOpt = { paw: [26, -10 + s * 10], eyes: 'happy' }; bx = null; break; }
    case 'dance': { ax = W / 2 + s * 18; ay = baseY - up * 14; aOpt = { tilt: s * 0.25, eyes: 'happy' }; bx = null; break; }
    case 'bounce': { ax = W / 2; ay = baseY - up * 8; aOpt = { eyes: 'happy' }; bx = null; break; }
    case 'shake': { ax = W / 2 + s * 4; aOpt = { eyes: 'happy', tilt: s * 0.08 }; bx = null; break; }
    default: { ax = W / 2; aOpt = { eyes: A.fx === 'zzz' ? 'closed' : A.fx === 'tears' ? 'closed' : 'open', blush: A.fx === 'blush' }; ay = baseY + (A.fx === 'zzz' ? s * 1.5 : 0); bx = null; }
  }
  if (bx != null) pup(g, bx, by, COL.b, bOpt);
  pup(g, ax, ay, COL.a, aOpt);
  const mid = bx != null ? (ax + bx) / 2 : ax;
  switch (A.fx) {
    case 'hearts': for (let j = 0; j < 3; j++) { const p = (t + j / 3) % 1; heart(g, mid - 20 + j * 20, baseY - 40 - p * 40, 0.9 + j * 0.15, 1 - p); } break;
    case 'stars': if (up > 0.55) for (let j = 0; j < 4; j++) star(g, (bx ?? ax) - 6 + Math.cos(j * 1.6 + t * 6) * 26, baseY - 30 + Math.sin(j * 1.6 + t * 6) * 10, 6); break;
    case 'sparkle': for (let j = 0; j < 3; j++) { const p = (t + j / 3) % 1; star(g, mid - 30 + j * 30, baseY - 46 - p * 18, 4 + 2 * Math.sin(p * Math.PI), 1 - p); } break;
    case 'tears': for (const side of [-1, 1]) { const p = (t * 2) % 1; g.fillStyle = COL.tear; g.globalAlpha = 1 - p; g.beginPath(); g.ellipse(ax + side * 9, ay + 2 + p * 30, 3, 4.5, 0, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1; } break;
    case 'zzz': for (let j = 0; j < 3; j++) { const p = (t + j / 3) % 1; label(g, 'z', ax + 26 + p * 22, ay - 24 - p * 30, 1 - p, 12 + j * 3, '#aab6cc'); } break;
    case 'notes': for (let j = 0; j < 2; j++) { const p = (t + j / 2) % 1; label(g, '♪', ax - 34 + j * 68, ay - 30 - p * 30, 1 - p, 18, '#b07cff'); } break;
    case 'laugh': label(g, up > 0.5 ? 'ha ha!' : 'hehe', mid, baseY - 46, 1, 14, '#ffd34d'); break;
    default: break;
  }
}

const cache = new Map();
/** The animation for an action: { file, name } or null. */
export async function rpGif(action) {
  if (!ACTIONS[action]) return null;
  if (cache.has(action)) return cache.get(action);
  const L = await canvasLib(); if (!L) return null;
  try {
    const frames = [];
    for (let k = 0; k < FRAMES; k++) { const cv = L.createCanvas(W, H), g = cv.getContext('2d'); frame(g, action, k); frames.push({ rgba: g.getImageData(0, 0, W, H).data, delay: 90 }); }
    const out = { file: await encodeGif({ width: W, height: H, loop: 0, frames }), name: `${action}.gif` };
    cache.set(action, out);
    return out;
  } catch { return null; }
}
