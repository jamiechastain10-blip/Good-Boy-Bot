/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * npm run supervised
 * Runs the bot under the supervisor: restarts it if it crashes, and lets the dashboard's Updates page install new
 * versions with automatic rollback. Press Ctrl+C to stop both. Plain `npm start` still works as before.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Supervisor } from '../src/supervisor.js';
import { makeUpdater } from '../src/update/config.js';

const base = path.resolve(process.env.GOODBOY_BASE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const { cfg, updater } = makeUpdater(base);
const stamp = () => new Date().toLocaleTimeString();
const say = (m) => console.log(`[supervisor ${stamp()}] ${m}`);
for (const p of cfg.problems) say(`Note: ${p}`);
say(cfg.manifestUrl && cfg.publicKey ? `Updates are on (${cfg.channel} channel, checked every ${cfg.checkHours || 'no'} hours).` : 'Updates are off (set UPDATE_MANIFEST_URL and add update-public-key.pem to turn them on).');

const sup = new Supervisor({ base, dataDir: process.env.GOODBOY_DATA_DIR || path.join(base, 'data'), updater: cfg.manifestUrl && cfg.publicKey ? updater : null, autoCheckHours: cfg.checkHours, log: say });
sup.on('state', (s) => say(`State: ${s}`));
sup.on('gaveup', (why) => { say(`Stopped: ${why}`); process.exit(1); });
let closing = false;
const close = async (sig) => { if (closing) return; closing = true; say(`${sig} received, stopping the bot...`); await sup.stop(); process.exit(0); };
process.on('SIGINT', () => close('SIGINT')); process.on('SIGTERM', () => close('SIGTERM'));
// The desktop app stops us with a message (signals do not reach a child cleanly on Windows).
process.on('message', (m) => { if (m?.type === 'shutdown') close('shutdown request'); else if (m?.type === 'control') sup.control(m); });
sup.on('control-reply', (m) => { try { process.send?.(m); } catch { /* the app went away */ } });
process.on('disconnect', () => close('the desktop app went away'));
try { await sup.start(); } catch (e) { console.error(`\n${e.message}\n`); process.exit(1); }
