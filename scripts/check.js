/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Health check for your install. Run: npm run check
 */
import fs from 'node:fs';
import { clientIdFromToken } from './inviteLib.js';

const ok = (m) => console.log(`  ✅ ${m}`);
const warn = (m) => console.log(`  ⚠️  ${m}`);
const bad = (m) => { console.log(`  ❌ ${m}`); failed = true; };
let failed = false;

console.log('\n=== Good Boy check ===\n');
const [major, minor] = process.versions.node.split('.').map(Number);
(major > 22 || (major === 22 && minor >= 13)) ? ok(`Node.js ${process.versions.node}`) : bad(`Node.js ${process.versions.node} is too old - install the current LTS from https://nodejs.org`);

for (const [name, why] of [['discord.js', 'required'], ['semver', 'required']]) {
  try { await import(name); ok(`${name} installed`); } catch { bad(`${name} is missing - run: npm install`); }
}
for (const [name, feature] of [['@napi-rs/canvas', 'image quotes'], ['@discordjs/voice', 'voice/TTS'], ['@snazzah/davey', 'voice encryption (required by Discord)'], ['opusscript', 'voice audio'], ['ffmpeg-static', 'voice audio'], ['google-tts-api', 'TTS speech']]) {
  try { await import(name); ok(`${name} installed (${feature})`); } catch { warn(`${name} not installed - ${feature} will be unavailable (the rest of the bot works). Try: npm install`); }
}
try { await import('node:sqlite'); ok('built-in SQLite available'); } catch { bad('this Node.js has no built-in SQLite - upgrade to 22.13 or newer'); }

const token = process.env.DISCORD_TOKEN?.trim();
if (!fs.existsSync('.env')) warn('No .env file yet - run: npm run setup');
if (!token) bad('DISCORD_TOKEN is not set');
else if (!clientIdFromToken(token)) bad('DISCORD_TOKEN does not look like a bot token');
else {
  ok('token has the right shape');
  try {
    const res = await fetch('https://discord.com/api/v10/applications/@me', { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(10000) });
    if (res.status === 401) bad('Discord rejected the token - reset it in the Developer Portal and run: npm run setup');
    else if (!res.ok) warn(`Could not ask Discord about the app (status ${res.status})`);
    else {
      const app = await res.json();
      ok(`connected to Discord as application "${app.name}"`);
      const flags = BigInt(app.flags ?? 0);
      const has = (a, b) => (flags & (1n << BigInt(a))) !== 0n || (flags & (1n << BigInt(b))) !== 0n;
      has(14, 15) ? ok('Server Members intent is ON') : warn('Server Members intent is OFF - welcome/goodbye, auto-roles and raid protection will not work');
      has(18, 19) ? ok('Message Content intent is ON') : warn('Message Content intent is OFF - AutoMod word/link filters, AFK and image quotes need it');
      has(12, 13) ? ok('Presence intent is ON') : warn('Presence intent is OFF - game-activity roles will not work');
      if (!has(14, 15) || !has(18, 19) || !has(12, 13)) console.log('     Fix: Developer Portal > your app > Bot > Privileged Gateway Intents, then restart the bot.');
    }
  } catch (e) { warn(`Could not reach Discord to verify (${e.message}) - are you online?`); }
}
if (!process.env.DISCORD_CLIENT_SECRET) warn('No DISCORD_CLIENT_SECRET - web dashboard login is disabled (slash commands still work)');
console.log(failed ? '\nFix the ❌ items above, then run this again.\n' : '\nLooks good. Start the bot with: npm start\n');
process.exit(failed ? 1 : 0);
