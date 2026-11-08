/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Draws Good Boy's own animated emojis (original art) into assets/emojis/*.gif.
 *   node scripts/make-emojis.js
 * The bot uploads them as application emojis on start (src/emojis.js), so they work in every server, no Nitro needed.
 * Everything is drawn with a tiny built-in rasteriser, so this needs no packages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeGif } from '../src/gif.js';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'emojis');
const N = 64, SS = 4, S = N * SS;          // 64x64 emojis, drawn at 4x and smoothed
const MATTE = [49, 51, 56];                 // half-covered edge pixels are blended onto Discord's dark grey
const TAU = Math.PI * 2;

const hex = (h, a = 1) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];

class Pic {
  constructor() { this.px = new Float32Array(S * S * 4); }
  /** Paints colour `c` wherever test(x, y) is true; x, y in emoji units (0..64). bbox limits the work. */
  fill(test, c, [x0, y0, x1, y1] = [0, 0, N, N]) {
    const [r, g, b, a] = c;
    const sx0 = Math.max(0, Math.floor(x0 * SS)), sy0 = Math.max(0, Math.floor(y0 * SS)), sx1 = Math.min(S, Math.ceil(x1 * SS)), sy1 = Math.min(S, Math.ceil(y1 * SS));
    for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
      if (!test((sx + 0.5) / SS, (sy + 0.5) / SS)) continue;
      const k = (sy * S + sx) * 4, da = this.px[k + 3], oa = a + da * (1 - a);
      if (oa <= 0) continue;
      this.px[k] = (r * a + this.px[k] * da * (1 - a)) / oa;
      this.px[k + 1] = (g * a + this.px[k + 1] * da * (1 - a)) / oa;
      this.px[k + 2] = (b * a + this.px[k + 2] * da * (1 - a)) / oa;
      this.px[k + 3] = oa;
    }
    return this;
  }
  circle(cx, cy, r, c) { return this.fill((x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r, c, [cx - r, cy - r, cx + r, cy + r]); }
  ellipse(cx, cy, rx, ry, c, rot = 0) {
    const co = Math.cos(rot), si = Math.sin(rot), m = Math.max(rx, ry);
    return this.fill((x, y) => { const dx = x - cx, dy = y - cy, u = dx * co + dy * si, v = -dx * si + dy * co; return (u / rx) ** 2 + (v / ry) ** 2 <= 1; }, c, [cx - m, cy - m, cx + m, cy + m]);
  }
  ring(cx, cy, r, w, c) { return this.fill((x, y) => { const d = Math.hypot(x - cx, y - cy); return d <= r && d >= r - w; }, c, [cx - r, cy - r, cx + r, cy + r]); }
  rect(x, y, w, h, rad, c) {
    return this.fill((px, py) => {
      const qx = Math.max(Math.abs(px - (x + w / 2)) - (w / 2 - rad), 0), qy = Math.max(Math.abs(py - (y + h / 2)) - (h / 2 - rad), 0);
      return qx * qx + qy * qy <= rad * rad;
    }, c, [x, y, x + w, y + h]);
  }
  poly(pts, c) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return this.fill((x, y) => {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }, c, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  line(x1, y1, x2, y2, w, c) {
    const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy || 1;
    return this.fill((x, y) => { const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)); return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) <= w / 2; },
      c, [Math.min(x1, x2) - w, Math.min(y1, y2) - w, Math.max(x1, x2) + w, Math.max(y1, y2) + w]);
  }
  star(cx, cy, r1, r2, points, rot, c) {
    const pts = [];
    for (let k = 0; k < points * 2; k++) { const r = k % 2 ? r2 : r1, a = rot + (k * Math.PI) / points - Math.PI / 2; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
    return this.poly(pts, c);
  }
  /** 64x64 RGBA: pixels under half covered are see-through; the rest are blended onto the matte at the edges. */
  rgba() {
    const out = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
        const k = ((y * SS + j) * S + x * SS + i) * 4, pa = this.px[k + 3];
        r += this.px[k] * pa; g += this.px[k + 1] * pa; b += this.px[k + 2] * pa; a += pa;
      }
      const o = (y * N + x) * 4, cover = a / (SS * SS);
      if (cover < 0.5) continue;
      const cr = r / a, cg = g / a, cb = b / a;
      out[o] = Math.round(cr * cover + MATTE[0] * (1 - cover));
      out[o + 1] = Math.round(cg * cover + MATTE[1] * (1 - cover));
      out[o + 2] = Math.round(cb * cover + MATTE[2] * (1 - cover));
      out[o + 3] = 255;
    }
    return out;
  }
}

// ---------------------------------------------------------------- palette
const C = {
  water: hex('#2f8fd8'), waterDark: hex('#1d5f9c'), foam: hex('#e8f6ff'), red: hex('#ff4d5e'), white: hex('#f6f7fb'), dark: hex('#1b1e27'),
  gold: hex('#ffc23d'), goldDark: hex('#c98512'), goldLight: hex('#ffe38f'), card: hex('#f6f2e9'), blue: hex('#6b93ff'), blueDark: hex('#4466cc'),
  green: hex('#3fd08f'), grey: hex('#8d97ae'), pink: hex('#ff74d4'), purple: hex('#9b6bff'), shadow: hex('#000000', 0.25),
};
const RARITY = { common: '#a7b1c2', uncommon: '#3fd08f', rare: '#4aa3ff', epic: '#a66bff', legendary: '#ffc23d', mythical: '#ff5fa2' };

// ---------------------------------------------------------------- the emojis
const frames = (n, draw, delay = 80) => Array.from({ length: n }, (_, k) => ({ draw: (p) => draw(p, k / n, k), delay }));
function bobber(p, t, dip = 0) {
  const y = 30 + Math.sin(t * TAU) * 3 + dip;
  p.line(32, 0, 32, y - 9, 1.5, hex('#ffffff', 0.7));
  p.ellipse(32, 47, 20 + Math.sin(t * TAU) * 2, 5, C.waterDark);
  p.ring(32, 47, 14 + ((t * 10) % 7), 1.4, hex('#e8f6ff', 0.6));
  p.circle(32, y, 10, C.white);
  p.fill((x, yy) => (x - 32) ** 2 + (yy - y) ** 2 <= 100 && yy < y, C.red, [22, y - 10, 42, y]);
  p.rect(30, y - 15, 4, 6, 1.5, C.dark);
  p.ellipse(28.5, y - 4, 2.5, 1.6, hex('#ffffff', 0.7));
}
function fish(p, color, t, { glow = false } = {}) {
  const swim = Math.sin(t * TAU) * 0.18, cx = 30 + Math.sin(t * TAU) * 2;
  if (glow) p.circle(32, 32, 26 + Math.sin(t * TAU * 2) * 2, hex(color, 0.22));
  p.poly([[cx + 14, 32], [cx + 27, 22 + swim * 20], [cx + 25, 32], [cx + 27, 42 - swim * 20]], hex(color));
  p.ellipse(cx, 32, 17, 11, hex(color), swim * 0.4);
  p.ellipse(cx - 2, 35, 12, 5, hex('#ffffff', 0.18), swim * 0.4);
  p.poly([[cx - 4, 22], [cx + 6, 15], [cx + 7, 23]], hex(color));
  p.circle(cx - 9, 29, 3, C.white); p.circle(cx - 9.6, 29, 1.6, C.dark);
}
const EMOJIS = {
  // fishing
  bobber: frames(12, (p, t) => bobber(p, t)),
  bite: frames(8, (p, t, k) => { bobber(p, 0, k % 4 < 2 ? 8 : 2); p.rect(48, 6 + (k % 2), 7, 20, 3, C.gold); p.circle(51.5, 32 + (k % 2), 3.5, C.gold); }, 90),
  splash: frames(10, (p, t) => {
    p.ellipse(32, 50, 22, 6, C.waterDark);
    for (let d = 0; d < 7; d++) { const a = -Math.PI / 2 + (d - 3) * 0.42, r = 4 + t * 26; p.circle(32 + Math.cos(a) * r, 46 + Math.sin(a) * r + t * t * 30, 4 * (1 - t) + 1.2, C.foam); }
    p.ring(32, 50, 6 + t * 18, 2, hex('#e8f6ff', 1 - t));
  }, 70),
  reel: frames(8, (p, t) => {
    p.circle(32, 32, 22, C.grey); p.circle(32, 32, 17, C.dark);
    for (let k = 0; k < 3; k++) { const a = t * TAU + (k * TAU) / 3; p.line(32, 32, 32 + Math.cos(a) * 15, 32 + Math.sin(a) * 15, 4, C.gold); }
    p.circle(32, 32, 5, C.goldLight); p.rect(50, 28, 10, 8, 3, C.red);
  }, 60),
  surge: frames(6, (p, t, k) => { p.circle(32, 32, 26, k % 2 ? C.red : C.gold); p.rect(28.5, 12, 7, 26, 3.5, C.white); p.circle(32, 47, 4.2, C.white); }, 120),
  snap: frames(8, (p, t) => {
    const g = t * 10;
    p.line(10, 6, 30 - g * 0.3, 30 - g * 0.2, 2, C.white); p.line(54, 6, 34 + g * 0.3, 30 - g * 0.2, 2, C.white);
    p.star(32, 32, 14 * (1 - t) + 4, 6 * (1 - t) + 2, 8, t, C.gold);
  }, 70),
  ...Object.fromEntries(Object.entries(RARITY).map(([id, col]) => [`fish_${id}`, frames(10, (p, t) => fish(p, col, t, { glow: id === 'legendary' || id === 'mythical' }), 90)])),
  shimmer: frames(10, (p, t) => { for (let k = 0; k < 4; k++) { const tt = (t + k / 4) % 1; p.star(12 + k * 13, 14 + ((k * 23) % 36), 9 * Math.sin(tt * Math.PI), 3 * Math.sin(tt * Math.PI), 4, 0, C.goldLight); } }, 80),
  // casino
  coin: frames(12, (p, t) => {
    const w = Math.abs(Math.cos(t * TAU)) * 20 + 1.5;
    p.ellipse(32, 55, 16, 3.5, C.shadow);
    p.ellipse(32, 30, w, 20, C.goldDark); p.ellipse(32, 30, Math.max(0.5, w - 3), 17, C.gold);
    if (w > 8) p.rect(32 - w * 0.25, 20, w * 0.5, 20, 2, C.goldDark);
    p.ellipse(32 - w * 0.4, 22, Math.max(0.5, w * 0.18), 5, hex('#ffffff', 0.55));
  }, 60),
  coins: frames(10, (p, t) => {
    for (let k = 0; k < 4; k++) { const y = 50 - k * 8 - (k === 3 ? Math.abs(Math.sin(t * TAU)) * 8 : 0); p.ellipse(32, y + 3, 18, 6, C.goldDark); p.ellipse(32, y, 18, 6, C.gold); p.ellipse(27, y - 1.5, 5, 1.5, hex('#ffffff', 0.5)); }
  }, 70),
  card: frames(10, (p, t) => {
    p.rect(14, 6, 36, 52, 6, C.card); p.rect(18, 10, 28, 44, 4, C.blue);
    p.fill((x, y) => x > 19 && x < 45 && y > 11 && y < 53 && ((x + y * 0.4) % 6) < 2, C.blueDark, [18, 10, 46, 54]);
    const sx = 12 + t * 50; p.fill((x, y) => x > 15 && x < 49 && y > 7 && y < 57 && x > sx - (y - 6) * 0.35 - 8 && x < sx - (y - 6) * 0.35, hex('#ffffff', 0.35), [14, 6, 50, 58]);
  }, 90),
  cardflip: frames(10, (p, t) => {
    const w = Math.abs(Math.cos(t * Math.PI)) * 18 + 1, face = t > 0.5;
    p.rect(32 - w, 6, w * 2, 52, Math.min(6, w), C.card);
    if (!face) p.rect(32 - w + 3, 10, Math.max(0, w * 2 - 6), 44, Math.min(4, w), C.blue);
    else if (w > 6) { p.poly([[32, 22], [32 + w * 0.5, 32], [32, 42], [32 - w * 0.5, 32]], C.red); }
  }, 70),
  dice: frames(8, (p, t, k) => {
    const rot = t * TAU, pips = [[1], [0, 2], [0, 1, 2], [0, 2, 3, 5], [0, 2, 1, 3, 5], [0, 2, 3, 5, 6, 8]][k % 6];
    const co = Math.cos(rot * 0.25), si = Math.sin(rot * 0.25);
    const pt = (x, y) => [32 + x * co - y * si, 30 + x * si + y * co];
    p.ellipse(32, 56, 16, 3, C.shadow);
    p.poly([pt(-18, -18), pt(18, -18), pt(18, 18), pt(-18, 18)], C.white);
    const spots = [[-9, -9], [0, 0], [9, 9], [9, -9], [0, 0], [-9, 9], [-9, 0], [0, 0], [9, 0]];
    for (const s of pips) { const [x, y] = pt(...spots[s]); p.circle(x, y, 3.4, C.dark); }
  }, 80),
  slot: frames(8, (p, t) => {
    p.rect(8, 4, 48, 56, 8, C.red); p.rect(14, 10, 36, 44, 5, C.white);
    const sym = [C.gold, C.green, C.pink, C.blue];
    for (let k = -1; k < 3; k++) { const y = 14 + k * 20 + t * 20; p.fill((x, yy) => yy > 10 && yy < 54 && (x - 32) ** 2 + (yy - y - 6) ** 2 < 49, sym[(k + 4) % 4], [22, y - 2, 42, y + 14]); }
    p.rect(14, 30, 36, 3, 1, hex('#1b1e27', 0.4));
  }, 50),
  win: frames(10, (p, t) => { for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU + t, r = 6 + t * 20; p.star(32 + Math.cos(a) * r, 32 + Math.sin(a) * r, 7 * (1 - t) + 2, 3 * (1 - t) + 1, 4, a, k % 2 ? C.gold : C.pink); } p.star(32, 32, 12, 5, 5, t, C.goldLight); }, 70),
  lose: frames(8, (p, t) => { for (let k = 0; k < 5; k++) p.circle(20 + k * 6, 40 - t * 18 - (k % 2) * 6, 7 * (1 - t * 0.5), hex('#8d97ae', 1 - t * 0.6)); }, 90),
  // pong
  ball: frames(10, (p, t) => { const y = 14 + Math.abs(Math.cos(t * Math.PI)) * 32; p.ellipse(32, 56, 12 - (46 - y) / 6, 3, C.shadow); p.circle(32, y, 9, C.white); p.ellipse(29, y - 3, 3, 2, hex('#ffffff', 0.9)); p.ring(32, y, 9, 1.5, C.grey); }, 60),
  paddle: frames(8, (p, t) => { const y = 32 + Math.sin(t * TAU) * 10; p.rect(26, y - 16, 12, 32, 5, C.blue); p.rect(28, y - 13, 3, 26, 1.5, hex('#ffffff', 0.4)); }, 80),
};

export async function makeAll(out = OUT) {
  fs.mkdirSync(out, { recursive: true });
  const made = [];
  for (const [name, list] of Object.entries(EMOJIS)) {
    const gif = await encodeGif({ width: N, height: N, transparent: true, frames: list.map((f) => { const p = new Pic(); f.draw(p); return { rgba: p.rgba(), delay: f.delay }; }) });
    if (gif.length > 256 * 1024) throw new Error(`${name} is too big for Discord (${gif.length} bytes)`);
    fs.writeFileSync(path.join(out, `${name}.gif`), gif);
    made.push({ name, bytes: gif.length });
  }
  return made;
}
export const EMOJI_NAMES = Object.keys(EMOJIS);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const made = await makeAll();
  console.log(made.map((m) => `${m.name} ${(m.bytes / 1024).toFixed(1)} KB`).join('\n'));
}
