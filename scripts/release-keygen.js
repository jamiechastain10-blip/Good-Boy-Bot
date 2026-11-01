/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Makes the signing keys for updates. Run once, on the computer you publish releases from.
 *   node scripts/release-keygen.js <folder for the private key>
 * - release-private.pem  STAYS SECRET. Whoever has it can publish updates your bot will install. Keep it out of the project folder.
 * - update-public-key.pem  goes next to .env on every computer that runs the bot (this script also saves a copy there).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair } from '../src/update/manifest.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) { console.error('\nUsage: node scripts/release-keygen.js <folder to keep the PRIVATE key in>\nChoose a folder outside this project, for example a USB drive or a private folder.\n'); process.exit(1); }
if (dir === root || dir.startsWith(root + path.sep)) { console.error('\nRefusing: that folder is inside the project, so the private key could end up in a release or a zip. Pick a folder outside it.\n'); process.exit(1); }
const privFile = path.join(dir, 'release-private.pem'); const pubFile = path.join(root, 'update-public-key.pem');
if (fs.existsSync(privFile)) { console.error(`\n${privFile} already exists. Not overwriting it.\n`); process.exit(1); }
const { publicKey, privateKey } = generateKeyPair();
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(privFile, privateKey, { mode: 0o600 });
fs.writeFileSync(pubFile, publicKey);
console.log(`\nPrivate key (keep secret, back it up): ${privFile}\nPublic key (installed here, copy it to every computer that runs the bot): ${pubFile}\n`);
