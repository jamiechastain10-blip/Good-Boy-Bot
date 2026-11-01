/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Builds a release package and its signed manifest from a project folder. Used by scripts/release.js.
 * It only ever includes the bot's own code and docs: never .env, data, node_modules, keys, logs or earlier releases.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import semver from 'semver';
import { createTarGz } from './tar.js';
import { signManifest, CHANNELS } from './manifest.js';

/** Top-level names that are never shipped. */
export const EXCLUDE_TOP = new Set([
  'node_modules', 'data', '.env', '.git', '.github', 'dist', 'releases', 'downloads', 'backups', '_to_delete', 'desktop', 'android',
  'current.json', 'update.log', 'supervisor.lock', 'update-public-key.pem', 'package-lock.json',
]);
const EXCLUDE_ANYWHERE = [/\.pem$/i, /\.key$/i, /^\.env(\..*)?$/i, /\.log$/i, /\.zip$/i, /\.db(-wal|-shm)?$/i, /\.tmp$/i, /^\.DS_Store$/, /^Thumbs\.db$/i];

export function collectFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && EXCLUDE_TOP.has(e.name)) continue;
      if (EXCLUDE_ANYWHERE.some((re) => re.test(e.name))) continue;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) {
        const mode = fs.statSync(path.join(dir, e.name)).mode;
        out.push({ path: r, data: fs.readFileSync(path.join(dir, e.name)), mode: mode & 0o111 ? 0o755 : 0o644 });
      }
    }
  };
  walk(root, '');
  return out;
}

/**
 * root: project folder. channel: stable|beta|development. previous: an earlier manifest envelope, to keep the other channels.
 * Returns { tarball, version, entry, envelope, files }.
 */
export function buildRelease({ root, channel = 'stable', privateKey, notes = '', previous = null, packageName = null, now = Date.now() }) {
  if (!CHANNELS.includes(channel)) throw new Error(`Unknown channel "${channel}". Use: ${CHANNELS.join(', ')}.`);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'good-boy') throw new Error('This folder is not the Good Boy project.');
  if (!semver.valid(pkg.version)) throw new Error(`package.json has an invalid version "${pkg.version}".`);
  if (channel === 'stable' && semver.prerelease(pkg.version)) throw new Error(`Version ${pkg.version} is a pre-release; publish it on the beta or development channel.`);
  const files = collectFiles(root);
  for (const need of ['package.json', 'src/index.js']) if (!files.some((f) => f.path === need)) throw new Error(`The project has no ${need}.`);
  const tarball = createTarGz(files.map((f) => ({ ...f, mtime: 0 })));
  const name = packageName ?? `good-boy-${pkg.version}.tar.gz`;
  const entry = { version: pkg.version, url: name, sha256: crypto.createHash('sha256').update(tarball).digest('hex'), size: tarball.length, notes: String(notes).slice(0, 4000), publishedAt: new Date(now).toISOString() };
  let channels = {};
  if (previous?.payload) { try { channels = JSON.parse(previous.payload).channels ?? {}; } catch { /* start fresh */ } }
  channels[channel] = entry;
  const envelope = signManifest({ product: 'good-boy', schema: 1, issuedAt: new Date(now).toISOString(), channels }, privateKey);
  return { tarball, version: pkg.version, entry, envelope, files: files.map((f) => f.path), name };
}
