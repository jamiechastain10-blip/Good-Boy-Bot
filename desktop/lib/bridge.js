/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * The bridge to Good Boy 4. The last Good Boy 3 shows a card (what Good Boy 4 is, a countdown), then moves the server
 * over by itself:
 *   1. back everything up (data and settings)           3. stop the bot (only one bot may use a token at a time)
 *   2. download Good Boy 4 and check it                  4. hand over the token and licence, start Good Boy 4
 *   5. wait for Good Boy 4 to say it is running          6. remove Good Boy 3 (data stays in the backup)
 * If anything goes wrong after the bot was stopped, Good Boy 4 is stopped, the handover is deleted and Good Boy 3 starts
 * again from where it was. Nothing here talks to Discord; the token never leaves this computer.
 *
 * Everything outside the program (files, the network, starting programs) is passed in, so each step is tested.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import nodeFs from 'node:fs';
import path from 'node:path';

/** Where Good Boy 4 is found: the Basic Ghost Labs site, which looks it up where it is released (no sign-in needed). */
export const BRIDGE = Object.freeze({
  releases: 'https://goodboyhub.pages.dev/v1/releases/goodboy',
  tagPrefix: 'v4', assetName: /^Good-Boy-4\.exe$/i,
  countdownSeconds: 300, keepBackupDays: 14, waitSeconds: 180,
});
const DAY = 86400000;
export const releasesApi = (b = BRIDGE) => b.releases;

/** The sha256 GitHub records for a release file ("sha256:abcd…"), or null. */
export function digestOf(asset) {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(asset?.digest ?? ''));
  return m ? m[1].toLowerCase() : null;
}
const versionOf = (tag) => String(tag).replace(/^v/i, '');
const parts = (v) => versionOf(v).split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
export function newer(a, b) { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; }

/**
 * The Good Boy 4 to move to, from GitHub's list of releases: the newest one that is published (not a draft, not a
 * test build unless `allowTest`), is a version 4, and has its program with a checksum GitHub recorded.
 */
export function pickRelease(releases, { bridge = BRIDGE, allowTest = false } = {}) {
  const ok = (Array.isArray(releases) ? releases : []).filter((r) => r && !r.draft && (allowTest || !r.prerelease)
    && new RegExp(`^${bridge.tagPrefix}\\.\\d+`).test(String(r.tag_name ?? '')));
  const found = ok.map((r) => {
    const asset = (r.assets ?? []).find((a) => bridge.assetName.test(String(a.name ?? '')) && a.state !== 'new');
    const sha256 = digestOf(asset);
    const url = String(asset?.browser_download_url ?? '');
    if (!asset || !sha256 || !url.startsWith(`${bridge.releases}/download/`) || !(asset.size > 0)) return null;
    return { tag: r.tag_name, version: versionOf(r.tag_name), notes: String(r.body ?? '').slice(0, 2000), file: { name: asset.name, url, size: asset.size, sha256 } };
  }).filter(Boolean).sort((a, b) => (newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0));
  return found[0] ?? null;
}

/** Asks the site which Good Boy 4 is out. Returns the release, or null when none is (or the site cannot be reached). */
export async function findV4(fetchFn, opts = {}) {
  try {
    const r = await fetchFn(releasesApi(opts.bridge), { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'good-boy-bridge' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    return pickRelease(await r.json(), opts);
  } catch { return null; }
}

const stamp = (now) => new Date(now).toISOString().replace(/[:.]/g, '-');
/** A copy of the bot's data and the app's settings, put aside so Good Boy 3 can always be put back. Returns its folder. */
export function backup({ dataDir, settingsFile, root, now = Date.now(), fs = nodeFs }) {
  const dest = path.join(root, `before-v4-${stamp(now)}`);
  fs.mkdirSync(dest, { recursive: true });
  const files = [];
  if (fs.existsSync(dataDir)) { fs.cpSync(dataDir, path.join(dest, 'bot-data'), { recursive: true }); files.push('bot-data'); }
  if (fs.existsSync(settingsFile)) { fs.copyFileSync(settingsFile, path.join(dest, 'settings.json')); files.push('settings.json'); }
  fs.writeFileSync(path.join(dest, 'backup.json'), JSON.stringify({ at: now, files }));
  return dest;
}
/** Deletes backups older than `days`. Returns the folders removed. */
export function pruneBackups(root, days = BRIDGE.keepBackupDays, now = Date.now(), fs = nodeFs) {
  const removed = [];
  let names = []; try { names = fs.readdirSync(root); } catch { return removed; }
  for (const name of names.filter((n) => /^before-v4-/.test(n))) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, name, 'backup.json'), 'utf8'));
      if (Number.isFinite(meta.at) && now - meta.at > days * DAY) { fs.rmSync(path.join(root, name), { recursive: true, force: true }); removed.push(name); }
    } catch { /* not one of ours */ }
  }
  return removed;
}

export class BridgeError extends Error { constructor(m) { super(m); this.name = 'BridgeError'; } }

/** Downloads the program and checks its size and sha256 before it is allowed to run. Returns the file's path. */
export async function download({ file, dest, fetchFn, fs = nodeFs, onProgress = () => {} }) {
  if (!String(file.url ?? '').startsWith(`${BRIDGE.releases}/download/`)) throw new BridgeError('The download address is not one Good Boy trusts.');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetchFn(file.url, { redirect: 'follow', headers: { 'User-Agent': 'good-boy-bridge' }, signal: AbortSignal.timeout(10 * 60000) });
  if (!res.ok) throw new BridgeError(`The download failed (${res.status}).`);
  const hash = crypto.createHash('sha256');
  const part = `${dest}.part`;
  const out = fs.openSync(part, 'w');
  let got = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > file.size) throw new BridgeError('The download is bigger than expected, so it was refused.');
      hash.update(value); fs.writeSync(out, value);
      onProgress(Math.min(100, Math.round((got / file.size) * 100)));
    }
  } catch (e) { fs.closeSync(out); fs.rmSync(part, { force: true }); throw e instanceof BridgeError ? e : new BridgeError('The download was interrupted.'); }
  fs.closeSync(out);
  if (got !== file.size || hash.digest('hex') !== file.sha256) { fs.rmSync(part, { force: true }); throw new BridgeError('The download does not match its checksum. Nothing was changed.'); }
  fs.renameSync(part, dest);
  return dest;
}

/** The handover Good Boy 4 reads once on its first start, then deletes. Only this user can read the file. */
export function writeHandoff({ file, token, license, dataDir, backupDir, marker, version, fs = nodeFs }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, token: token ?? '', license: license ?? '', data: dataDir, backup: backupDir, marker, from: version }), { mode: 0o600 });
  return file;
}

/**
 * The whole move. Emits `state` ({ phase, percent?, message? }) as it goes; resolves { ok: true } when Good Boy 4
 * is running, or { ok: false, error, rolledBack } after putting Good Boy 3 back.
 * deps: fetchFn, fs, now, release, paths { dataDir, settingsFile, root, exe, handoff, marker }, readToken(), license(),
 *       stopBot(), startBot(), launch(exe, args) -> { kill() }, sleep(ms), finish()
 */
export class Migration extends EventEmitter {
  constructor(deps) { super(); this.d = deps; this.running = false; }
  #say(phase, extra = {}) { this.emit('state', { phase, ...extra }); }

  async run() {
    if (this.running) return { ok: false, error: 'The move is already running.', rolledBack: false };
    this.running = true;
    const d = this.d, fs = d.fs ?? nodeFs;
    let stopped = false, child = null, backupDir = null;
    try {
      this.#say('backup', { message: 'Backing up your data…' });
      backupDir = backup({ dataDir: d.paths.dataDir, settingsFile: d.paths.settingsFile, root: d.paths.root, now: d.now?.() ?? Date.now(), fs });
      this.#say('download', { message: 'Downloading Good Boy 4…', percent: 0 });
      await download({ file: d.release.file, dest: d.paths.exe, fetchFn: d.fetchFn, fs, onProgress: (percent) => this.#say('download', { message: 'Downloading Good Boy 4…', percent }) });
      const token = d.readToken();
      if (!token) throw new BridgeError('The bot token could not be read, so nothing was changed.');
      this.#say('stop', { message: 'Stopping Good Boy 3…' });
      await d.stopBot();
      stopped = true;
      writeHandoff({ file: d.paths.handoff, token, license: d.license?.() ?? '', dataDir: d.paths.dataDir, backupDir, marker: d.paths.marker, version: d.release.version, fs });
      fs.rmSync(d.paths.marker, { force: true });
      this.#say('launch', { message: 'Starting Good Boy 4…' });
      child = d.launch(d.paths.exe, ['--from-v3', d.paths.handoff]);
      const ready = await this.#waitForMarker();
      if (!ready) throw new BridgeError('Good Boy 4 did not start in time.');
      this.#say('done', { message: 'Good Boy 4 is running.' });
      await d.finish?.();
      this.running = false;
      return { ok: true, backup: backupDir };
    } catch (e) {
      const error = e instanceof BridgeError ? e.message : `Something went wrong: ${e?.message ?? e}`;
      let rolledBack = false;
      if (stopped) {
        this.#say('rollback', { message: 'Putting Good Boy 3 back…' });
        try { child?.kill?.(); } catch { /* already gone */ }
        try { fs.rmSync(d.paths.handoff, { force: true }); } catch { /* none */ }
        try { await d.startBot(); rolledBack = true; } catch { /* reported below */ }
      }
      this.#say('error', { message: error, rolledBack });
      this.running = false;
      return { ok: false, error, rolledBack };
    }
  }
  async #waitForMarker() {
    const d = this.d, fs = d.fs ?? nodeFs;
    const tries = Math.ceil(((d.waitSeconds ?? BRIDGE.waitSeconds) * 1000) / (d.pollMs ?? 1000));
    for (let i = 0; i < tries; i++) {
      if (fs.existsSync(d.paths.marker)) return true;
      await (d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(d.pollMs ?? 1000);
    }
    return false;
  }
}
