/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Verification captcha (3.1): a short code drawn wobbly over noise, so a person can read it and a simple bot can't.
 * Letters that look alike (0/O, 1/I/l, 5/S, 2/Z, 8/B) are left out. Without the optional picture library the code is
 * shown as spaced-out text instead.
 */
import { randomInt } from 'node:crypto';
import { canvasLib } from './gameart.js';

const ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
export const CODE_LENGTH = 5;
export function makeCode(rand = (n) => randomInt(n)) {
  let s = ''; for (let k = 0; k < CODE_LENGTH; k++) s += ALPHABET[rand(ALPHABET.length)]; return s;
}
/** Is the typed answer the code? Ignores case and spaces. */
export const codeMatches = (typed, code) => String(typed ?? '').replace(/\s+/g, '').toUpperCase() === String(code);
/** The code as text, for when there's no picture library: spaced out with full-width letters. */
export const codeText = (code) => [...code].map((c) => String.fromCodePoint(c.codePointAt(0) + 0xfee0)).join(' ');

/** A PNG of the code, or null without the picture library. rand returns [0, 1). */
export async function captchaImage(code, rand = Math.random) {
  const C = await canvasLib();
  if (!C) return null;
  const W = 300, H = 110;
  const cv = C.createCanvas(W, H), g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#1d2433'); grad.addColorStop(1, '#2b2140');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  const hue = () => `hsl(${Math.floor(rand() * 360)}, 70%, ${55 + Math.floor(rand() * 20)}%)`;
  // Noise: dots and curves behind the letters.
  for (let k = 0; k < 220; k++) { g.fillStyle = `rgba(255,255,255,${0.05 + rand() * 0.2})`; g.fillRect(rand() * W, rand() * H, 2, 2); }
  for (let k = 0; k < 5; k++) {
    g.strokeStyle = hue(); g.globalAlpha = 0.45; g.lineWidth = 1 + rand() * 2.5;
    g.beginPath(); g.moveTo(0, rand() * H); g.bezierCurveTo(W * 0.3, rand() * H, W * 0.7, rand() * H, W, rand() * H); g.stroke();
  }
  g.globalAlpha = 1;
  const step = (W - 40) / code.length;
  [...code].forEach((ch, k) => {
    g.save();
    g.translate(28 + k * step + rand() * 8, H / 2 + (rand() - 0.5) * 22);
    g.rotate((rand() - 0.5) * 0.7);
    g.font = `bold ${44 + Math.floor(rand() * 12)}px "GB Display", "GB Figtree", sans-serif`;
    g.fillStyle = hue(); g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 4;
    g.fillText(ch, 0, 0);
    g.restore();
  });
  // One line across the letters, so they can't simply be cut apart.
  g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(10, H * (0.3 + rand() * 0.4)); g.quadraticCurveTo(W / 2, H * rand(), W - 10, H * (0.3 + rand() * 0.4)); g.stroke();
  return cv.toBuffer('image/png');
}
