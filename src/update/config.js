/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Reads the update settings for an install folder: UPDATE_MANIFEST_URL, UPDATE_CHANNEL, UPDATE_CHECK_HOURS from .env
 * (or the real environment), and the pinned public key from update-public-key.pem. Updates are off unless a manifest
 * address is set, and refuse to run without the key.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { Updater } from './updater.js';
import { ReleaseStore } from './store.js';
import { CHANNELS } from './manifest.js';

export function readEnvFile(base) {
  try { return parseEnv(fs.readFileSync(path.join(base, '.env'), 'utf8')); } catch { return {}; }
}

export function updateConfig(base, env = process.env) {
  const file = readEnvFile(base);
  const get = (k) => String(env[k] ?? file[k] ?? '').trim().replace(/^["']|["']$/g, '');
  let publicKey = '';
  try { publicKey = fs.readFileSync(path.join(base, 'update-public-key.pem'), 'utf8'); } catch { /* not installed */ }
  const channel = get('UPDATE_CHANNEL').toLowerCase();
  const hours = Number(get('UPDATE_CHECK_HOURS'));
  return {
    manifestUrl: get('UPDATE_MANIFEST_URL'),
    channel: CHANNELS.includes(channel) ? channel : 'stable',
    publicKey,
    checkHours: Number.isFinite(hours) && hours >= 0 && get('UPDATE_CHECK_HOURS') !== '' ? hours : 24,
    problems: [
      ...(get('UPDATE_CHANNEL') && !CHANNELS.includes(channel) ? [`UPDATE_CHANNEL "${get('UPDATE_CHANNEL')}" is not one of ${CHANNELS.join(', ')}; using stable.`] : []),
      ...(get('UPDATE_MANIFEST_URL') && !publicKey ? ['UPDATE_MANIFEST_URL is set but update-public-key.pem is missing, so updates stay off.'] : []),
    ],
  };
}

export function makeUpdater(base, env = process.env, fetchImpl = fetch) {
  const cfg = updateConfig(base, env);
  const store = new ReleaseStore(base);
  return { cfg, store, updater: new Updater({ store, manifestUrl: cfg.manifestUrl, channel: cfg.channel, publicKey: cfg.publicKey, fetchImpl }) };
}
