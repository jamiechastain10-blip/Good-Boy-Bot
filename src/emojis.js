/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Good Boy's own animated emojis (assets/emojis, drawn by scripts/make-emojis.js). On start they are uploaded as
 * application emojis: those belong to the bot, so they work in every server it is in, for everyone, without Nitro and
 * without using any server's emoji slots. Each name carries a short hash of the art, so changed art is uploaded again
 * and the old copy removed. Until they are uploaded (or if uploading fails) every emoji falls back to a normal one.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EMOJI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'emojis');
export const FALLBACK = {
  bobber: '🎣', bite: '❗', splash: '💦', reel: '🎣', surge: '⚠️', snap: '💥', shimmer: '✨',
  fish_common: '🐟', fish_uncommon: '🐟', fish_rare: '🐠', fish_epic: '🐠', fish_legendary: '🐡', fish_mythical: '🐉',
  coin: '🪙', coins: '💰', card: '🂠', cardflip: '🃏', dice: '🎲', slot: '🎰', win: '✨', lose: '💨', ball: '⚪', paddle: '🏓',
};
const uploaded = new Map(); // name -> { id, name, animated }

/** The emoji as message text: Good Boy's own once uploaded, otherwise a normal emoji. */
export function emoji(name) {
  const e = uploaded.get(name);
  return e ? `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>` : FALLBACK[name] ?? '';
}
/** For buttons and select options (setEmoji). */
export function emojiRef(name) {
  const e = uploaded.get(name);
  return e ? { id: e.id, name: e.name, animated: e.animated } : { name: FALLBACK[name] ?? '❔' };
}
export const hasCustom = (name) => uploaded.has(name);

/** The emojis that ship with this version: name, file, and the name used on Discord (gb_<name>_<hash>). */
export function localEmojis(dir = EMOJI_DIR) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.gif')).sort(); } catch { return []; }
  return files.map((f) => {
    const name = f.slice(0, -4), file = path.join(dir, f);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 6);
    return { name, file, remote: `gb_${name}_${hash}`.slice(0, 32) };
  });
}

/**
 * Uploads missing emojis and removes old copies. `app` is client.application. Returns { added, removed, kept, failed }.
 * Safe to call on every start: when nothing changed it only lists the emojis.
 */
export async function syncEmojis(app, { dir = EMOJI_DIR, log = () => {} } = {}) {
  const out = { added: 0, removed: 0, kept: 0, failed: 0 };
  if (!app?.emojis) return out;
  const want = localEmojis(dir);
  if (!want.length) return out;
  const have = await app.emojis.fetch();
  const byName = new Map([...have.values()].map((e) => [e.name, e]));
  for (const w of want) {
    let e = byName.get(w.remote);
    if (e) out.kept++;
    else {
      try { e = await app.emojis.create({ attachment: w.file, name: w.remote }); out.added++; } catch (err) { out.failed++; log(`emoji ${w.name} not uploaded: ${err.message}`); continue; }
    }
    uploaded.set(w.name, { id: e.id, name: e.name, animated: !!e.animated });
  }
  const current = new Set(want.map((w) => w.remote));
  for (const e of have.values()) {
    if (/^gb_[a-z_]+_[0-9a-f]{6}$/.test(e.name) && !current.has(e.name)) {
      try { await e.delete(); out.removed++; } catch { /* an old copy can stay */ }
    }
  }
  return out;
}
/** Tests: pretend these were uploaded. */
export function _setUploaded(map) { uploaded.clear(); for (const [k, v] of Object.entries(map)) uploaded.set(k, v); }
