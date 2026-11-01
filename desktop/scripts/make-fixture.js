/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * node scripts/make-fixture.js <out.db>
 * A made-up server for the automated build check, so the app's pages can be photographed with data in them.
 * No real members: the IDs are invented.
 */
import fs from 'node:fs';
import { Database } from '../../src/db.js';

const out = process.argv[2];
if (!out) { console.error('Use: node scripts/make-fixture.js <out.db>'); process.exit(2); }
fs.rmSync(out, { force: true });
const db = new Database(out);
const g = '100000000000000001';
db.upsertGuild(g, 'Test Server');
for (const m of ['community', 'moderation', 'support', 'engagement', 'roles', 'voice']) db.setModuleState(g, m, m !== 'voice', '1.0.0');
const xp = [2400, 1671, 1470, 1388, 855, 831, 652, 395, 147, 90, 40, 12];
xp.forEach((x, i) => db.dataSet(g, 'community', `user:2000000000000000${String(i).padStart(2, '0')}`, { xp: x, messages: Math.round(x / 10), rep: i % 3 === 0 ? 1 : 0, lastXp: 0, lastRep: 0 }));
db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
console.log(`Wrote ${out}`);
