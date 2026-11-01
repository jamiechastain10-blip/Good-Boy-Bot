/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Builds a release: dist/good-boy-<version>.tar.gz and dist/latest.json (the signed manifest).
 *   node scripts/release.js --key <path to release-private.pem> [--channel stable|beta|development] [--notes "text" | --notes-file file]
 * Upload BOTH files to the same web folder (https) and set UPDATE_MANIFEST_URL to the address of latest.json.
 * Running it again for another channel keeps the other channels in the manifest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRelease } from '../src/update/release.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : a), []));
if (!args.key) { console.error('\nUsage: node scripts/release.js --key <release-private.pem> [--channel stable] [--notes "what changed"]\nMake a key first with: node scripts/release-keygen.js <folder>\n'); process.exit(1); }
const out = path.join(root, 'dist'); fs.mkdirSync(out, { recursive: true });
const manifestFile = path.join(out, 'latest.json');
let previous = null; try { previous = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { /* first release */ }
const notes = args['notes-file'] ? fs.readFileSync(args['notes-file'], 'utf8') : (args.notes && args.notes !== 'true' ? args.notes : '');
const r = buildRelease({ root, channel: args.channel ?? 'stable', privateKey: fs.readFileSync(args.key, 'utf8'), notes, previous });
fs.writeFileSync(path.join(out, r.name), r.tarball);
fs.writeFileSync(manifestFile, JSON.stringify(r.envelope, null, 2));
console.log(`\nBuilt ${r.name} (${(r.entry.size / 1024).toFixed(0)} KB, ${r.files.length} files) for the ${args.channel ?? 'stable'} channel.\nsha256 ${r.entry.sha256}\n\nUpload both of these to your web folder:\n  ${path.join(out, r.name)}\n  ${manifestFile}\n`);
