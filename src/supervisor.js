/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * The supervisor runs the bot as a child process and looks after it:
 *   - restarts it when it crashes (with growing pauses), and gives up if it keeps crashing right away
 *   - installs updates the person approved: stop the bot, copy the database, switch release, start it, and
 *     if the new release does not report "ready" in time (or crashes first) go back to the previous one
 * It is kept small and has no dependencies on purpose: it must keep working when a release is broken.
 */
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { ReleaseStore, BUNDLED } from './update/store.js';

export const DEFAULTS = {
  restartDelays: [1000, 2000, 5000, 10000, 30000, 60000],
  crashLoop: { count: 5, windowMs: 120000 },
  healthyAfterMs: 60000,        // a run this long counts as healthy: earlier crashes are forgiven
  healthTimeoutMs: 120000,      // a release under trial must report ready within this time
  stopTimeoutMs: 15000,
  autoCheckHours: 24,
  applyDelayMs: 750,            // after answering "accepted", wait so the bot can finish replying to the browser before it is stopped
};

/** The bot's application ID, read from the first part of its token (no secret in it). */
export function botIdOf(token) {
  try { const id = Buffer.from(String(token ?? '').split('.')[0], 'base64').toString('utf8'); return /^\d{17,20}$/.test(id) ? id : null; } catch { return null; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export class Supervisor extends EventEmitter {
  constructor({ base, dataDir = path.join(base, 'data'), updater = null, nodeArgs = ['--disable-warning=ExperimentalWarning'], env = process.env, spawnFn = spawn, log = () => {}, ...opts } = {}) {
    super();
    this.base = path.resolve(base); this.dataDir = path.resolve(dataDir); this.updater = updater; this.nodeArgs = nodeArgs; this.env = env; this.spawnFn = spawnFn; this.log = log;
    this.opts = { ...DEFAULTS, ...opts };
    this.store = updater?.store ?? new ReleaseStore(this.base);
    this.state = 'stopped'; this.child = null; this.startedAt = null; this.readyAt = null; this.restarts = 0; this.lastExit = null; this.botStatus = null;
    this.crashes = []; this.lastCheck = null; this.lastError = null; this.trialTimer = null; this.checkTimer = null; this.expected = false; this.update = { phase: 'idle' };
    this.lockFile = path.join(this.base, 'supervisor.lock');
    // A second lock per Discord bot (not per folder), so two installs on one computer cannot run the same bot at once.
    const appId = botIdOf(env.DISCORD_TOKEN);
    this.botLockFile = appId ? path.join(opts.lockDir ?? path.join(os.tmpdir(), 'good-boy-locks'), `${appId}.lock`) : null;
    this.instance = crypto.randomBytes(6).toString('hex');
  }

  status() {
    const cur = this.store.current();
    return {
      state: this.state, pid: this.child?.pid ?? null, version: this.store.runningVersion(cur), release: cur.version, trial: cur.status === 'trial',
      startedAt: this.startedAt, readyAt: this.readyAt, restarts: this.restarts, lastExit: this.lastExit, bot: this.botStatus,
      update: { ...this.update, configured: !!this.updater?.configured, channel: this.updater?.channel ?? null, lastCheck: this.lastCheck, lastError: this.lastError, failed: cur.failed },
    };
  }
  #set(state) { if (this.state !== state) { this.state = state; this.emit('state', state); } }

  #takeLock() {
    let other = null;
    try { other = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')); } catch { /* no lock, or an unreadable one: take it */ }
    if (other?.pid && other.id !== this.instance && alive(other.pid)) throw new Error(`Another supervisor (process ${other.pid}) is already running this install.`);
    let bot = null;
    if (this.botLockFile) try { bot = JSON.parse(fs.readFileSync(this.botLockFile, 'utf8')); } catch { /* none */ }
    if (bot?.pid && bot.id !== this.instance && bot.base !== this.base && alive(bot.pid)) throw new Error(`This bot is already running from another Good Boy install on this computer (process ${bot.pid}).`);
    const mine = JSON.stringify({ pid: process.pid, id: this.instance, base: this.base });
    fs.writeFileSync(this.lockFile, mine);
    if (this.botLockFile) try { fs.mkdirSync(path.dirname(this.botLockFile), { recursive: true }); fs.writeFileSync(this.botLockFile, mine); } catch { /* best effort */ }
  }
  #dropLock() {
    for (const f of [this.lockFile, this.botLockFile].filter(Boolean)) try { if (JSON.parse(fs.readFileSync(f, 'utf8')).id === this.instance) fs.rmSync(f, { force: true }); } catch { /* already gone */ }
  }

  async start() {
    if (this.child || ['starting', 'running', 'backoff', 'updating'].includes(this.state)) return;
    this.#takeLock();
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.crashes = [];
    this.#spawn();
    const hours = this.opts.autoCheckHours;
    if (this.updater?.configured && hours > 0) { this.checkTimer = setInterval(() => this.checkForUpdate().catch(() => {}), hours * 3600000); this.checkTimer.unref?.(); setTimeout(() => this.checkForUpdate().catch(() => {}), 5000).unref?.(); }
  }

  #spawn() {
    const cur = this.store.current();
    const entry = this.store.entryFor(cur.version);
    if (!fs.existsSync(entry)) { this.lastError = `The release ${cur.version} is missing its start file.`; this.#giveUp(this.lastError); return; }
    const envFile = path.join(this.base, '.env');
    const args = [...(fs.existsSync(envFile) ? [`--env-file=${envFile}`] : []), ...this.nodeArgs, entry];
    this.expected = false; this.readyAt = null; this.botStatus = null;
    this.#set('starting');
    const child = this.spawnFn(process.execPath, args, {
      cwd: this.base, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true,
      env: { ...this.env, GOODBOY_SUPERVISED: '1', GOODBOY_DATA_DIR: this.dataDir, GOODBOY_BASE_DIR: this.base },
    });
    this.child = child; this.startedAt = Date.now();
    this.log(`Started release ${cur.version} (pid ${child.pid})`);
    this.emit('spawn', { release: cur.version, pid: child.pid });
    clearTimeout(this.trialTimer);
    if (cur.status === 'trial') this.trialTimer = setTimeout(() => this.#trialFailed('it did not report ready in time'), this.opts.healthTimeoutMs);
    child.on('message', (m) => this.#onMessage(child, m));
    child.on('error', (e) => { this.lastError = `Could not start the bot: ${e.message}`; });
    child.on('exit', (code, signal) => this.#onExit(child, code, signal));
  }

  #onMessage(child, m) {
    if (child !== this.child || !m) return;
    if (m.type === 'ready') {
      this.readyAt = Date.now(); this.#set('running'); clearTimeout(this.trialTimer);
      if (this.store.current().status === 'trial') { this.store.confirm(); this.store.prune(); this.update = { phase: 'idle', lastResult: { ok: true, version: this.store.runningVersion(), at: Date.now() } }; }
      this.emit('ready');
    } else if (m.type === 'status') this.botStatus = m;
    else if (m.type === 'update-request') this.#handleRequest(child, m);
    else if (m.type === 'control-reply') this.emit('control-reply', m);
  }

  /** A request from the desktop app for the running bot. Answered with the 'control-reply' event. */
  control(m) {
    const fail = (error) => this.emit('control-reply', { type: 'control-reply', id: m?.id, result: { ok: false, error } });
    if (!m || m.id == null) return;
    if (!this.child || this.state !== 'running') return fail('The bot is not running. Start it first.');
    try { this.child.send({ type: 'control', id: m.id, action: m.action, payload: m.payload ?? {} }); } catch { fail('The bot is not reachable right now.'); }
  }

  async #handleRequest(child, m) {
    const reply = (result) => { try { child.send({ type: 'update-reply', id: m.id, result }); } catch { /* the bot may already be stopping */ } };
    try {
      if (m.action === 'status') return reply({ ok: true, status: this.status() });
      if (m.action === 'check') { const r = await this.checkForUpdate(); return reply({ ok: true, status: this.status(), check: r }); }
      if (m.action === 'apply') {
        const r = await this.prepareUpdate();
        reply({ ok: true, accepted: true, version: r.version });
        setTimeout(() => this.applyUpdate(r.version).catch((e) => { this.lastError = e.message; }), this.opts.applyDelayMs);
        return undefined;
      }
      return reply({ ok: false, error: 'Unknown request.' });
    } catch (e) { return reply({ ok: false, error: e.message }); }
  }

  /** Ask the update server. Remembers the answer for status(). */
  async checkForUpdate() {
    if (!this.updater) throw new Error('Updates are not set up.');
    this.update = { ...this.update, phase: this.update.phase === 'idle' ? 'checking' : this.update.phase };
    try {
      const r = await this.updater.check();
      this.lastCheck = { at: r.checkedAt, current: r.current, release: r.release ? { version: r.release.version, channel: r.release.channel, notes: r.release.notes, publishedAt: r.release.publishedAt, blocked: r.release.blocked ?? null, previouslyFailed: r.release.previouslyFailed } : null };
      this.lastError = null; return this.lastCheck;
    } catch (e) { this.lastError = e.message; throw e; } finally { if (this.update.phase === 'checking') this.update = { ...this.update, phase: 'idle' }; }
  }

  /** Download and unpack the newest release, ready to apply. Returns { version }. */
  async prepareUpdate() {
    if (!this.updater) throw new Error('Updates are not set up.');
    this.update = { ...this.update, phase: 'downloading' };
    try {
      const { release } = await this.updater.check();
      if (!release) throw new Error('You already have the newest version.');
      const r = await this.updater.prepare(release);
      if (r.needsInstall?.length) throw new Error(`Version ${release.version} needs new packages (${r.needsInstall.join(', ')}). Install it by hand with npm install; it was not applied.`);
      this.update = { ...this.update, phase: 'ready', pending: release.version };
      return { version: release.version };
    } catch (e) { this.update = { ...this.update, phase: 'idle' }; this.lastError = e.message; throw e; }
  }

  /** Switch to an unpacked release. Resolves { ok } once it is running, or after going back if it failed. */
  async applyUpdate(version) {
    if (!this.store.has(version)) throw new Error(`Release ${version} has not been downloaded.`);
    this.update = { phase: 'applying', pending: version };
    this.#set('updating');
    await this.#stopChild();
    try { this.store.backupData(this.dataDir, `before-${version}`); } catch (e) { this.log(`Could not back up data: ${e.message}`); }
    this.store.activate(version);
    const outcome = new Promise((resolve) => {
      const done = (r) => { this.off('ready', onReady); this.off('rolledback', onBack); this.off('gaveup', onGave); resolve(r); };
      const onReady = () => done({ ok: true, version });
      const onBack = (info) => done({ ok: false, rolledBack: true, reason: info.reason });
      const onGave = (reason) => done({ ok: false, rolledBack: false, reason });
      this.once('ready', onReady); this.once('rolledback', onBack); this.once('gaveup', onGave);
    });
    this.#spawn();
    const r = await outcome;
    this.update = { phase: 'idle', lastResult: { ...r, at: Date.now() } };
    return r;
  }

  #trialFailed(reason) {
    clearTimeout(this.trialTimer);
    const cur = this.store.current();
    if (cur.status !== 'trial') return false;
    this.log(`Release ${cur.version} failed its trial (${reason}); going back`);
    const doBack = () => { const r = this.store.rollback(reason); this.emit('rolledback', { ...r, reason }); this.crashes = []; this.#spawn(); };
    if (this.child) { this.#stopChild().then(doBack); } else doBack();
    return true;
  }

  #onExit(child, code, signal) {
    if (child !== this.child) return;
    this.child = null; clearTimeout(this.trialTimer);
    const ranFor = Date.now() - (this.startedAt ?? Date.now());
    this.lastExit = { code, signal, at: Date.now(), ranMs: ranFor };
    this.emit('exit', this.lastExit);
    if (this.expected) { this.emit('stopped'); return; }
    if (this.store.current().status === 'trial') { this.#trialFailed(`it stopped (code ${code ?? signal}) before it was ready`); return; }
    if (code === 0) { this.#set('stopped'); this.#dropLock(); this.log('The bot exited normally; not restarting.'); this.emit('gaveup', 'The bot exited by itself.'); return; }
    const now = Date.now();
    if (ranFor >= this.opts.healthyAfterMs) this.crashes = [];
    this.crashes = [...this.crashes.filter((t) => now - t < this.opts.crashLoop.windowMs), now];
    if (this.crashes.length >= this.opts.crashLoop.count) { this.#giveUp(`The bot stopped ${this.crashes.length} times in a row right after starting (last exit: ${code ?? signal}). Fix the problem shown above and start again.`); return; }
    const delay = this.opts.restartDelays[Math.min(this.crashes.length - 1, this.opts.restartDelays.length - 1)];
    this.restarts++; this.#set('backoff');
    this.log(`The bot stopped (${code ?? signal}). Restarting in ${Math.round(delay / 1000)}s.`);
    this.emit('backoff', { delay });
    // Not unref'd on purpose: while waiting to restart, this timer is what keeps the supervisor process alive.
    clearTimeout(this.backoffTimer);
    this.backoffTimer = setTimeout(() => { if (this.state === 'backoff') this.#spawn(); }, delay);
  }

  #giveUp(reason) { this.lastError = reason; this.#set('failed'); this.#dropLock(); this.log(reason); this.emit('gaveup', reason); }

  #stopChild() {
    const child = this.child;
    if (!child) return Promise.resolve();
    this.expected = true;
    return new Promise((resolve) => {
      const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, this.opts.stopTimeoutMs);
      child.once('exit', () => { clearTimeout(kill); resolve(); });
      try { child.send({ type: 'shutdown' }); } catch { try { child.kill(); } catch { /* gone */ } }
    });
  }

  async restart() { this.#set('starting'); await this.#stopChild(); this.crashes = []; this.#spawn(); }

  async stop() {
    clearInterval(this.checkTimer); clearTimeout(this.trialTimer); clearTimeout(this.backoffTimer);
    this.#set('stopping'); await this.#stopChild();
    this.#set('stopped'); this.#dropLock();
  }
}

export { BUNDLED };
