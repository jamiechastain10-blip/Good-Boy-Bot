// Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// Reads a member's level record back with Good Boy 3's own code, to prove 3.x understands what v4 wrote.
//   node read-3x.mjs <data folder> <server id> <member id>
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// on Windows an absolute path must be given to import() as a file:// address
const load = (file) => import(pathToFileURL(file).href);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { Database } = await load(path.join(root, 'src/db.js'));
const { levelOf } = await load(path.join(root, 'modules/community/index.js'));
const [dir, guild, user] = process.argv.slice(2);
const db = new Database(path.join(dir, 'eclipse.db'));
const rec = db.dataGet(guild, 'community', `user:${user}`);
console.log(JSON.stringify({ rec, level: levelOf(rec?.xp ?? 0), volume: db.getConfig(guild, 'music', 'volume') }));
process.exit(0);
