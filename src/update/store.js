/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Where releases live on disk and which one is current.
 *
 *   <base>/                    the install folder (has .env, node_modules, and the release the bot was installed as)
 *     releases/<version>/      downloaded releases, unpacked
 *     current.json             { version, previous, status: 'trial' | 'ok', appliedAt, failed: [] }
 *     downloads/               verified packages
 *     backups/                 database copies taken before each switch
 *
 * "bundled" means the code in <base> itself (what you installed by hand). Data and settings are never inside a release.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import semver from 'semver';
import { extractTarGz, TarError } from './tar.js';

export class StoreError extends Error { constructor(m) { super(m); this.name = 'StoreError'; } }
export const BUNDLED = 'bundled';

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

export class ReleaseStore {
  constructor(base) {
    this.base = path.resolve(base);
    this.releases = path.join(this.base, 'releases');
    this.downloads = path.join(this.base, 'downloads');
    this.backups = path.join(this.base, 'backups');
    this.currentFile = path.join(this.base, 'current.json');
    this.logFile = path.join(this.base, 'update.log');
  }

  log(event, extra = {}) {
    try { fs.appendFileSync(this.logFile, `${JSON.stringify({ at: new Date().toISOString(), event, ...extra })}\n`); } catch { /* logging must never break an update */ }
  }

  dirFor(version) {
    if (!semver.valid(version)) throw new StoreError(`"${version}" is not a valid version`);
    return path.join(this.releases, semver.clean(version));
  }
  has(version) { try { return fs.statSync(path.join(this.dirFor(version), 'src', 'index.js')).isFile(); } catch { return false; } }

  /** The release the supervisor should run. Falls back to the bundled code if the pointer is missing or broken. */
  current() {
    const c = readJson(this.currentFile);
    if (!c || !semver.valid(c.version) || !this.has(c.version)) return { version: BUNDLED, previous: null, status: 'ok', failed: Array.isArray(c?.failed) ? c.failed : [] };
    return { version: semver.clean(c.version), previous: c.previous ?? BUNDLED, status: c.status === 'trial' ? 'trial' : 'ok', appliedAt: c.appliedAt ?? null, failed: Array.isArray(c.failed) ? c.failed : [] };
  }
  entryFor(version) { return version === BUNDLED ? path.join(this.base, 'src', 'index.js') : path.join(this.dirFor(version), 'src', 'index.js'); }
  /** The version number of the bundled code. */
  bundledVersion() { return readJson(path.join(this.base, 'package.json'))?.version ?? '0.0.0'; }
  runningVersion(c = this.current()) { return c.version === BUNDLED ? this.bundledVersion() : c.version; }

  /** Which dependencies the release needs that this install doesn't have in a compatible version. */
  missingDependencies(pkg) {
    const out = [];
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      const have = readJson(path.join(this.base, 'node_modules', ...name.split('/'), 'package.json'))?.version;
      if (!have || !semver.satisfies(have, range, { includePrerelease: true })) out.push(`${name}@${range}`);
    }
    return out;
  }

  /** Unpack a verified package into releases/<version>. Returns { dir, needsInstall: [...] }. */
  stage(packageBuffer, version) {
    const target = this.dirFor(version);
    if (fs.existsSync(target)) throw new StoreError(`release ${version} is already unpacked`);
    fs.mkdirSync(this.releases, { recursive: true });
    const partial = `${target}.partial-${crypto.randomBytes(4).toString('hex')}`;
    try {
      try { extractTarGz(packageBuffer, partial); } catch (e) { if (e instanceof TarError) throw new StoreError(`The package is not safe to unpack: ${e.message}`); throw e; }
      const pkg = readJson(path.join(partial, 'package.json'));
      if (!pkg || pkg.name !== 'good-boy') throw new StoreError('The package is not a Good Boy release.');
      if (semver.clean(pkg.version) !== semver.clean(version)) throw new StoreError(`The package says it is ${pkg.version}, not ${version}.`);
      if (!fs.existsSync(path.join(partial, 'src', 'index.js')) || !fs.existsSync(path.join(partial, 'modules'))) throw new StoreError('The package is missing parts of the bot.');
      if (fs.existsSync(path.join(partial, 'node_modules')) || fs.existsSync(path.join(partial, '.env')) || fs.existsSync(path.join(partial, 'data'))) throw new StoreError('The package contains files that must never be shipped (node_modules, .env or data).');
      const needsInstall = this.missingDependencies(pkg);
      fs.renameSync(partial, target);
      const nm = path.join(this.base, 'node_modules');
      if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(target, 'node_modules'), 'junction');
      this.log('staged', { version, needsInstall });
      return { dir: target, needsInstall };
    } catch (e) { fs.rmSync(partial, { recursive: true, force: true }); throw e; }
  }

  /** Point the install at a staged release. It stays "trial" until the bot proves it works. */
  activate(version) {
    if (!this.has(version)) throw new StoreError(`release ${version} is not unpacked`);
    const cur = this.current();
    writeJsonAtomic(this.currentFile, { version: semver.clean(version), previous: cur.version, status: 'trial', appliedAt: new Date().toISOString(), failed: cur.failed });
    this.log('activated', { version, previous: cur.version });
  }
  confirm() {
    const cur = this.current();
    if (cur.version === BUNDLED || cur.status === 'ok') return;
    writeJsonAtomic(this.currentFile, { ...cur, status: 'ok' });
    this.log('confirmed', { version: cur.version });
  }
  /** Go back to the release before this one, and remember the bad one so it is not applied again by itself. */
  rollback(reason = 'unspecified') {
    const cur = this.current();
    if (cur.version === BUNDLED) return { rolledBackTo: BUNDLED, from: null };
    const back = cur.previous && (cur.previous === BUNDLED || this.has(cur.previous)) ? cur.previous : BUNDLED;
    writeJsonAtomic(this.currentFile, { version: back, previous: null, status: 'ok', appliedAt: new Date().toISOString(), failed: [...new Set([...cur.failed, cur.version])] });
    this.log('rolled-back', { from: cur.version, to: back, reason });
    return { rolledBackTo: back, from: cur.version };
  }
  failedVersions() { return this.current().failed; }

  /** Copy the database files (taken while the bot is stopped) to backups/<stamp>-<tag>/. */
  backupData(dataDir, tag) {
    const dir = path.join(this.backups, `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(tag).replace(/[^\w.-]/g, '_')}`);
    let copied = 0;
    if (fs.existsSync(dataDir)) {
      fs.mkdirSync(dir, { recursive: true });
      for (const f of fs.readdirSync(dataDir)) if (/^eclipse\.db(-wal|-shm)?$/.test(f)) { fs.copyFileSync(path.join(dataDir, f), path.join(dir, f)); copied++; }
    }
    this.log('backup', { dir, copied });
    return { dir, copied };
  }

  /** Keep the current release, its predecessor and the newest few; remove the rest. */
  prune(keep = 3) {
    if (!fs.existsSync(this.releases)) return [];
    const cur = this.current();
    const all = fs.readdirSync(this.releases).filter((n) => semver.valid(n)).sort((a, b) => semver.rcompare(a, b, { includePrerelease: true }));
    const protectedSet = new Set([cur.version, cur.previous, ...all.slice(0, keep)]);
    const removed = [];
    for (const n of all) if (!protectedSet.has(n)) { fs.rmSync(path.join(this.releases, n), { recursive: true, force: true }); removed.push(n); }
    for (const n of fs.readdirSync(this.releases)) if (n.includes('.partial-')) fs.rmSync(path.join(this.releases, n), { recursive: true, force: true });
    if (removed.length) this.log('pruned', { removed });
    return removed;
  }
}
