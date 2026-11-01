/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Interactive first-time setup. Run: npm run setup
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { clientIdFromToken, inviteUrl } from './inviteLib.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
// Buffer lines so pasted/piped input is never lost between questions.
const queue = [], waiters = [];
let closed = false;
rl.on('line', (l) => (waiters.length ? waiters.shift()(l) : queue.push(l)));
rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(''); });
async function ask(q) {
  process.stdout.write(q);
  const line = queue.length ? queue.shift() : closed ? '' : await new Promise((r) => waiters.push(r));
  return line.trim();
}

console.log('\n=== Good Boy setup ===\n');
if (fs.existsSync(envPath) && (await ask('A .env file already exists. Replace it? (y/N) ')).toLowerCase() !== 'y') { console.log('Left it alone.'); rl.close(); process.exit(0); }

console.log('1) In the Discord Developer Portal (https://discord.com/developers/applications):');
console.log('   New Application > Bot > "Reset Token" > copy it. Then, on the same Bot page, turn ON all three');
console.log('   "Privileged Gateway Intents" (Presence, Server Members, Message Content) and save.\n');
let token = '';
while (!token) {
  token = await ask('Paste your bot token: ');
  if (!token && closed) { console.log('\nNo input received - run "npm run setup" again.'); process.exit(1); }
  if (token.split('.').length !== 3 || !clientIdFromToken(token)) { console.log('   That does not look like a bot token (it has three parts separated by dots). Try again.'); token = ''; }
}

console.log('\n2) OPTIONAL - web dashboard login. Skip this (press Enter) if you just want to use slash commands.');
console.log('   OAuth2 page > copy "Client Secret"; and add this Redirect: http://localhost:3000/callback');
const secret = await ask('Client Secret (or Enter to skip): ');

fs.writeFileSync(envPath, `DISCORD_TOKEN=${token}\n${secret ? `DISCORD_CLIENT_SECRET=${secret}\n` : '# DISCORD_CLIENT_SECRET=\n'}DASHBOARD_PORT=3000\nDASHBOARD_BASE_URL=http://localhost:3000\n`, { mode: 0o600 });
console.log('\nSaved .env (keep this file private - anyone with the token controls your bot).');
console.log('\n3) Add the bot to your server:\n\n' + inviteUrl(clientIdFromToken(token)) + '\n');
console.log('4) Start it with:  npm start\n');
rl.close();
