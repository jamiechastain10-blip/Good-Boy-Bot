// Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// Makes a real Good Boy 3 data folder, written by Good Boy 3's own code, for the v4 tests to read.
//   node make-3x-data.mjs <folder>     prints what was written, as JSON
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// on Windows an absolute path must be given to import() as a file:// address
const load = (file) => import(pathToFileURL(file).href);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { Database } = await load(path.join(root, 'src/db.js'));
const { Permissions } = await load(path.join(root, 'src/permissions.js'));
const { ApiQueue } = await load(path.join(root, 'src/queue.js'));
const { ModuleManager } = await load(path.join(root, 'src/moduleManager.js'));
const { levelOf } = await load(path.join(root, 'modules/community/index.js'));

const dir = path.resolve(process.argv[2] ?? 'gb3-data');
fs.mkdirSync(dir, { recursive: true });
const G = '900000000000000900', KAI = '900000000000000001', ROWAN = '900000000000000002', DJ = '900000000000000950';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const db = new Database(path.join(dir, 'eclipse.db'));
const guild = { id: G, name: 'BoxBoyz', ownerId: KAI, memberCount: 3, channels: { cache: new Map() }, roles: { cache: new Map() }, members: { cache: new Map(), me: null } };
const client = { guilds: { cache: new Map([[G, guild]]) }, user: { id: 'bot' }, users: { fetch: async () => null }, application: { commands: { set: async () => {}, create: async () => {} } } };
const mm = new ModuleManager({ db, perms: new Permissions(db), queue: new ApiQueue(), builtins: [], log: quiet, dataDir: dir });
mm.attach(client, ['Guilds']);
await mm.discover(path.join(root, 'modules'));
db.upsertGuild(G, guild.name);
for (const m of ['community', 'economy', 'music']) await mm.enable(G, m);

// levels: the community module's own records
const community = mm.ctx(G, 'community');
community.data.set(`user:${KAI}`, { xp: 12345, messages: 800, rep: 4, lastXp: 0, lastRep: 0 });
community.data.set(`user:${ROWAN}`, { xp: 150, messages: 12, rep: 0, lastXp: 0, lastRep: 0 });
community.data.set('odd_key%with_wildcards', { note: 'keys are matched literally' });
// coins: the economy module's own table
const economy = mm.ctx(G, 'economy');
economy.sql.run('INSERT INTO economy_wallets (guild_id, user_id, name, coins, created_at) VALUES (?, ?, ?, ?, ?)', G, KAI, 'Kai', 1840, Date.now());
// settings, through the same path the dashboard uses
mm.setSetting(G, 'music', 'volume', 35);
mm.setSetting(G, 'music', 'stations', ['Lofi | https://radio.example/lofi']);
// a playlist, as the 3.1.2 music module stores it
mm.ctx(G, 'music').data.set('pl:abc12345', { id: 'abc12345', name: 'Late night vibes', by: KAI, tracks: [{ id: 't1', title: 'Midnight Drive', artist: 'Neon Coast', seconds: 214, source: 'jamendo', url: 'https://example.com/a.mp3' }], updatedAt: Date.now() });
// who may do what
db.permAdd(G, 'music.dj', DJ);
// the bot owner's own art (3.1.1)
fs.mkdirSync(path.join(dir, 'art', 'rp', 'boop'), { recursive: true });
fs.writeFileSync(path.join(dir, 'art', 'rp', 'boop', 'mine.gif'), Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
db.close?.();
console.log(JSON.stringify({ guild: G, kai: KAI, rowan: ROWAN, dj: DJ, kaiLevel: levelOf(12345), rowanLevel: levelOf(150) }));
process.exit(0);
