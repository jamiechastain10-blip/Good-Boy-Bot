/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
// Signed modules. A module is code that runs with full access to the bot and the computer, so the version for everyone
// only accepts modules the owner signed (with the same key as licences). Signing covers every file in the folder:
// change one byte anywhere and the signature no longer matches.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SIG_FILE = 'goodboy-signature.json';
const SKIP = new Set([SIG_FILE, 'node_modules', '.git', '.DS_Store', 'Thumbs.db']);
const MAX_FILES = 500, MAX_BYTES = 20 * 1024 * 1024;

export function moduleFiles(dir) {
  const out = [];
  let total = 0;
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) throw new Error(`The module contains a link (${r}), which is not allowed.`);
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) {
        const size = fs.statSync(full).size; total += size;
        if (out.length >= MAX_FILES || total > MAX_BYTES) throw new Error('The module is too big (more than 500 files or 20 MB).');
        out.push(r);
      }
    }
  };
  walk(dir, '');
  return out;
}

export function hashModule(dir) {
  const h = crypto.createHash('sha256');
  for (const r of moduleFiles(dir)) { const b = fs.readFileSync(path.join(dir, ...r.split('/'))); h.update(`${r}\0${b.length}\0`); h.update(b); }
  return h.digest('hex');
}

/** The module's name without running its code: the folder name, which the bot also requires to match. */
export function moduleNameOf(dir) {
  const name = path.basename(dir);
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new Error('A module folder name is lowercase letters, numbers and dashes, like my-module.');
  if (!fs.existsSync(path.join(dir, 'index.js'))) throw new Error('That folder has no index.js, so it is not a Good Boy module.');
  return name;
}

export function signModule(dir, privateKey, now = Date.now()) {
  const name = moduleNameOf(dir);
  const hash = hashModule(dir);
  const body = JSON.stringify({ v: 1, name, hash, at: now });
  const sig = crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(privateKey)).toString('base64');
  fs.writeFileSync(path.join(dir, SIG_FILE), JSON.stringify({ body, sig }, null, 2));
  return { name, hash };
}

export function verifyModule(dir, publicKey) {
  try {
    const name = moduleNameOf(dir);
    if (!publicKey) return { ok: false, name, error: 'This version can only add modules signed by Basic Ghost Labs, and signing is not switched on yet.' };
    let s; try { s = JSON.parse(fs.readFileSync(path.join(dir, SIG_FILE), 'utf8')); } catch { return { ok: false, name, error: 'This module is not signed. For safety, only signed modules can be added.' }; }
    let good = false; try { good = crypto.verify(null, Buffer.from(String(s.body)), crypto.createPublicKey(publicKey), Buffer.from(String(s.sig), 'base64')); } catch { good = false; }
    if (!good) return { ok: false, name, error: 'This module\'s signature is not genuine.' };
    const b = JSON.parse(s.body);
    if (b.name !== name) return { ok: false, name, error: 'This module was signed under a different name.' };
    if (b.hash !== hashModule(dir)) return { ok: false, name, error: 'This module was changed after it was signed, so it was refused.' };
    return { ok: true, name };
  } catch (e) { return { ok: false, error: e.message }; }
}
