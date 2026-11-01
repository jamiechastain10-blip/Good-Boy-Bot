/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * node scripts/bundle-bot.js
 * Puts a copy of the bot into desktop/bundle/bot, the same files a signed release would contain (never .env, data,
 * keys or the desktop app itself), minus tests. Then run "npm install --omit=dev" inside it on the target system so
 * the right Windows or Mac packages are installed, and copy that system's node binary into desktop/bundle/node.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFiles } from '../../src/update/release.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const out = path.resolve(here, '..', 'bundle', 'bot');
export function bundleFiles(projectRoot) {
  return collectFiles(projectRoot).filter((f) => !/^(tests|docs)\//.test(f.path) && !f.path.startsWith('.github/'));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.rmSync(out, { recursive: true, force: true });
  const files = bundleFiles(root);
  for (const f of files) { const dest = path.join(out, f.path); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, f.data, { mode: f.mode }); }
  for (const d of ['node', 'owner-seed']) fs.mkdirSync(path.resolve(here, '..', 'bundle', d), { recursive: true });
  fs.writeFileSync(path.resolve(here, '..', 'bundle', 'owner-seed', 'README.txt'), 'The Owner build puts eclipse.db here (the owner\'s server data). It is never committed to the repository.\n');
  console.log(`Bundled ${files.length} bot files into ${path.relative(process.cwd(), out)}`);
}
