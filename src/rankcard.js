/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Rank cards (3.1): /rank as a picture with the member's avatar, level, server rank and an XP bar. Needs the optional
 * canvas package; returns null without it (or if anything fails), and /rank shows its text version instead.
 */
import { canvasLib } from './gameart.js';

/** 3.1: card themes members can pick. bg = gradient, text = main text, soft = secondary text, track = empty bar. */
export const THEMES = {
  dark: { label: 'Dark', bg: ['#151a26', '#0f131c'], text: '#e9edf5', soft: '#8b97ab', track: '#1b2130' },
  light: { label: 'Light', bg: ['#f6f8fc', '#e4e9f2'], text: '#1b2130', soft: '#5b667a', track: '#d5dbe6' },
  midnight: { label: 'Midnight', bg: ['#0b1030', '#1d0b33'], text: '#eef0ff', soft: '#9aa3d6', track: '#1d2250' },
  sunset: { label: 'Sunset', bg: ['#3b1630', '#5c2a14'], text: '#fff1e6', soft: '#e0b49a', track: '#4a2030' },
  forest: { label: 'Forest', bg: ['#0e2a1b', '#17331f'], text: '#eafbef', soft: '#93c4a2', track: '#1d3d29' },
  ocean: { label: 'Ocean', bg: ['#0a2338', '#063a40'], text: '#e8f8ff', soft: '#8ec3d6', track: '#123548' },
  candy: { label: 'Candy', bg: ['#3a1838', '#24194a'], text: '#fff0fb', soft: '#d9a6d2', track: '#46224a' },
};
/** Only pictures uploaded to Discord can be card backgrounds (nothing from random sites). */
export const okBackground = (url) => /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\/[\w/.\-%]+?\.(png|jpe?g|webp|gif)(\?[\w=&.\-%]*)?$/i.test(String(url ?? ''));
export const okHex = (v) => /^#?[0-9a-f]{6}$/i.test(String(v ?? '').trim());
const hex = (v, fallback) => (okHex(v) ? `#${String(v).trim().replace('#', '').toLowerCase()}` : fallback);

export async function rankCard({ name, avatarUrl = null, level, into, needed, rank = null, xp = 0, messages = 0, accent = '#6b93ff', accent2 = '#b07cff', theme = 'dark', background = null, fetchFn = globalThis.fetch }) {
  const L = await canvasLib(); if (!L) return null;
  try {
    const T = THEMES[theme] ?? THEMES.dark;
    accent = hex(accent, '#6b93ff'); accent2 = hex(accent2, '#b07cff');
    const W = 760, H = 220, cv = L.createCanvas(W, H), g = cv.getContext('2d');
    const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, T.bg[0]); bg.addColorStop(1, T.bg[1]);
    g.fillStyle = bg; g.beginPath(); g.roundRect(0, 0, W, H, 24); g.fill();
    // A member's own background picture, dimmed so the text stays readable.
    if (background && okBackground(background)) {
      try {
        const r = await fetchFn(background, { signal: AbortSignal.timeout(6000) });
        if (r.ok) {
          const pic = await L.loadImage(Buffer.from(await r.arrayBuffer()));
          const scale = Math.max(W / pic.width, H / pic.height), pw = pic.width * scale, ph = pic.height * scale;
          g.save(); g.beginPath(); g.roundRect(0, 0, W, H, 24); g.clip(); g.drawImage(pic, (W - pw) / 2, (H - ph) / 2, pw, ph);
          g.fillStyle = theme === 'light' ? 'rgba(246,248,252,0.72)' : 'rgba(10,12,20,0.62)'; g.fillRect(0, 0, W, H); g.restore();
        }
      } catch { /* the theme alone, then */ }
    }
    g.save(); g.beginPath(); g.roundRect(0, 0, W, H, 24); g.clip(); const top = g.createLinearGradient(0, 0, W, 0); top.addColorStop(0, accent); top.addColorStop(1, accent2); g.fillStyle = top; g.fillRect(0, 0, W, 5); g.restore();
    // avatar
    const ax = 110, ay = 110, ar = 70;
    g.fillStyle = T.track; g.beginPath(); g.arc(ax, ay, ar + 6, 0, Math.PI * 2); g.fill();
    g.strokeStyle = accent; g.lineWidth = 5; g.beginPath(); g.arc(ax, ay, ar + 3, 0, Math.PI * 2); g.stroke();
    let img = null;
    if (avatarUrl) { try { const r = await fetchFn(avatarUrl, { signal: AbortSignal.timeout(6000) }); if (r.ok) img = await L.loadImage(Buffer.from(await r.arrayBuffer())); } catch { /* initials */ } }
    g.save(); g.beginPath(); g.arc(ax, ay, ar, 0, Math.PI * 2); g.clip();
    if (img) g.drawImage(img, ax - ar, ay - ar, ar * 2, ar * 2);
    else { g.fillStyle = accent; g.fillRect(ax - ar, ay - ar, ar * 2, ar * 2); g.fillStyle = '#0b1020'; g.font = '800 48px "GB Display", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(name).slice(0, 2).toUpperCase(), ax, ay + 2); }
    g.restore();
    // name, level, rank
    const x0 = 210;
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillStyle = T.text; g.font = '700 30px "GB Display", "GB Figtree", sans-serif';
    let nm = String(name); while (g.measureText(nm).width > 330 && nm.length > 3) nm = nm.slice(0, -2); if (nm !== String(name)) nm += '…';
    g.fillText(nm, x0, 72);
    g.textAlign = 'right';
    g.fillStyle = T.soft; g.font = '600 16px "GB Figtree", sans-serif'; g.fillText('LEVEL', W - 130, 46);
    g.fillStyle = accent; g.font = '800 44px "GB Display", sans-serif'; g.fillText(String(level), W - 40, 72);
    if (rank) { g.fillStyle = T.soft; g.font = '600 16px "GB Figtree", sans-serif'; g.fillText(`RANK #${rank}`, W - 40, 104); }
    // bar
    const bx = x0, by = 140, bw = W - x0 - 40, bh = 26, pct = Math.max(0, Math.min(1, into / Math.max(1, needed)));
    g.fillStyle = T.track; g.beginPath(); g.roundRect(bx, by, bw, bh, bh / 2); g.fill();
    if (pct > 0) { const fill = g.createLinearGradient(bx, 0, bx + bw, 0); fill.addColorStop(0, accent); fill.addColorStop(1, accent2); g.fillStyle = fill; g.beginPath(); g.roundRect(bx, by, Math.max(bh, bw * pct), bh, bh / 2); g.fill(); }
    g.textAlign = 'left'; g.fillStyle = T.text; g.font = '600 15px "GB Figtree", sans-serif'; g.fillText(`${into.toLocaleString('en-US')} / ${needed.toLocaleString('en-US')} XP to level ${level + 1}`, bx, by + bh + 24);
    g.textAlign = 'right'; g.fillStyle = T.soft; g.fillText(`${xp.toLocaleString('en-US')} XP · ${messages.toLocaleString('en-US')} messages`, bx + bw, by + bh + 24);
    return cv.toBuffer('image/png');
  } catch { return null; }
}
