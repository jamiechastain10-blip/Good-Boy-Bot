/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Custom art (3.1.1): the bot owner's own pictures and GIFs in place of Good Boy's built-in ones, for every server the
 * bot is in. Files live in the bot's data folder:
 *
 *   data/art/rp/<action>/        any number of pictures or GIFs for a roleplay action (one is picked at random)
 *   data/art/critters/<critter>/ the critter's picture; <critter>-sparkly/ for its Sparkly version
 *
 * They can be added with /art (bot owner only) or by copying files into those folders. PNG, JPG, GIF and WEBP, up to
 * 8 MB each. Your art is used first, then Tenor GIFs (roleplay, when set up), then Good Boy's own.
 * New kinds can be added to KINDS later (fishing places, game cards...) without changing how this works.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ACTIONS } from './rpart.js';
import { ALL as CRITTERS } from './critters.js';

export const MAX_BYTES = 8 * 1024 * 1024;
export const MAX_PER_NAME = 20;
/** What can have custom art, and the names inside each kind. */
export const KINDS = {
  rp: { label: 'Roleplay action', names: () => Object.keys(ACTIONS), help: 'one or more GIFs per action, picked at random' },
  critters: { label: 'Critter', names: () => CRITTERS.flatMap((c) => [c.id, `${c.id}-sparkly`]), help: 'one picture per critter (and one for its Sparkly version)' },
};
const root = { dir: process.env.GOODBOY_DATA_DIR ? path.join(process.env.GOODBOY_DATA_DIR, 'art') : path.resolve('data', 'art') };
/** The bot's data folder decides where art lives (the module manager sets it at start). */
export function setArtRoot(dataDir) { if (dataDir) root.dir = path.join(dataDir, 'art'); }
export const artRoot = () => root.dir;

const safe = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '');
function folder(kind, name) {
  const k = KINDS[kind];
  if (!k) throw new Error('unknown kind');
  const n = safe(name);
  if (!k.names().includes(n)) return null;
  return path.join(root.dir, kind, n);
}
/** What a file's first bytes say it is (never trusts the name). */
export function imageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 6).toString('latin1') === 'GIF87a' || buf.slice(0, 6).toString('latin1') === 'GIF89a') return 'gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
/** The art files for one name, oldest first. */
export function listArt(kind, name) {
  const dir = folder(kind, name);
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f)).sort().map((f) => path.join(dir, f))
    .filter((f) => { try { const st = fs.statSync(f); return st.isFile() && st.size <= MAX_BYTES; } catch { return false; } });
}
/** Every name in a kind that has custom art, with how many files. */
export function summary(kind) {
  return KINDS[kind].names().map((n) => ({ name: n, count: listArt(kind, n).length })).filter((x) => x.count);
}
/** One file to show (random when there are several): { file: Buffer, name } or null. */
export function pickArt(kind, name, rand = Math.random) {
  const files = listArt(kind, name);
  if (!files.length) return null;
  const f = files[Math.floor(rand() * files.length)];
  try { const buf = fs.readFileSync(f); const t = imageType(buf); return t ? { file: buf, name: `${safe(name)}.${t}` } : null; } catch { return null; }
}
/** Saves a picture. Checks it really is an image and not too big. Returns its path. */
export function saveArt(kind, name, buf) {
  const dir = folder(kind, name);
  if (!dir) throw new Error(`"${name}" isn't one of the ${KINDS[kind]?.label.toLowerCase() ?? kind} names.`);
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error('That file is empty.');
  if (buf.length > MAX_BYTES) throw new Error('That file is over 8 MB.');
  const t = imageType(buf);
  if (!t) throw new Error('That isn\'t a picture. Use PNG, JPG, GIF or WEBP.');
  fs.mkdirSync(dir, { recursive: true });
  if (listArt(kind, name).length >= MAX_PER_NAME) throw new Error(`That already has ${MAX_PER_NAME} pictures. Remove some first.`);
  const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${t}`);
  fs.writeFileSync(file, buf);
  return file;
}
/** Removes all of a name's art (back to the built-in look). Returns how many files went. */
export function clearArt(kind, name) {
  const files = listArt(kind, name);
  for (const f of files) fs.rmSync(f, { force: true });
  return files.length;
}
