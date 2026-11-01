/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
import { spawn as realSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { LogBuffer } from './logbuf.js';

/**
 * Runs the bot's supervisor (scripts/supervise.js) as a child process using the computer's own Node.
 * States: stopped | starting | running | stopping | failed.
 * Stopping sends a "shutdown" message over the child's IPC channel (works the same on Windows, where signals do not),
 * waits for the supervisor to stop the bot cleanly, and only kills it after stopTimeoutMs.
 */
export class BotRunner extends EventEmitter {
  constructor({ botDir, script, nodePath = 'node', env = process.env, spawnFn = realSpawn, stopTimeoutMs = 20000 } = {}) {
    super();
    this.botDir = botDir; this.script = script ?? path.join(botDir, 'scripts', 'supervise.js');
    this.nodePath = nodePath; this.env = env; this.spawnFn = spawnFn; this.stopTimeoutMs = stopTimeoutMs;
    this.state = 'stopped'; this.child = null; this.logs = new LogBuffer(); this.lastError = ''; this.startedAt = null;
  }

  /** Ask the running bot to do something (through the supervisor). Resolves with its answer, or a plain error. */
  control(action, payload = {}, timeoutMs = 20000) {
    const child = this.child;
    if (!child || this.state !== 'running') return Promise.resolve({ ok: false, error: 'The bot is not running. Start it first.' });
    return new Promise((resolve) => {
      const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const done = (r) => { clearTimeout(t); child.off?.('message', onMsg); resolve(r); };
      const onMsg = (m) => { if (m?.type === 'control-reply' && m.id === id) done(m.result ?? { ok: false, error: 'No answer.' }); };
      const t = setTimeout(() => done({ ok: false, error: 'The bot did not answer in time.' }), timeoutMs);
      child.on('message', onMsg);
      try { child.send({ type: 'control', id, action, payload }); } catch { done({ ok: false, error: 'The bot is not reachable right now.' }); }
    });
  }

  #set(s) { if (this.state !== s) { this.state = s; this.emit('state', this.status()); } }
  status() { return { state: this.state, pid: this.child?.pid ?? null, startedAt: this.startedAt, error: this.lastError }; }

  #onOutput(chunk) {
    for (const line of this.logs.push(chunk)) {
      this.emit('log', line);
      if (/Ready\. In Discord/.test(line)) this.#set('running');
      else if (/^\[supervisor [^\]]*\] Stopped:/.test(line)) this.lastError = line.replace(/^\[supervisor [^\]]*\] Stopped:\s*/, '');
    }
  }

  start() {
    if (this.child) return false;
    if (!fs.existsSync(this.script)) { this.lastError = 'The supervisor script was not found. Is the folder right?'; this.#set('failed'); return false; }
    this.lastError = ''; this.#set('starting');
    // Read .env ourselves is not needed: the bot loads it (--env-file-if-exists) from its own folder.
    const args = ['--disable-warning=ExperimentalWarning'];
    if (fs.existsSync(path.join(this.botDir, '.env'))) args.unshift('--env-file=.env');
    args.push(this.script);
    let child;
    try {
      child = this.spawnFn(this.nodePath, args, { cwd: this.botDir, env: { ...this.env, GOODBOY_BASE_DIR: this.botDir }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    } catch (e) { this.lastError = `Could not start: ${e.message}`; this.#set('failed'); return false; }
    this.child = child; this.startedAt = Date.now();
    child.stdout?.on('data', (d) => this.#onOutput(d));
    child.stderr?.on('data', (d) => this.#onOutput(d));
    child.once('error', (e) => { this.lastError = /ENOENT/.test(e.message) ? 'Node.js was not found on this computer.' : e.message; this.child = null; this.#set('failed'); });
    child.once('exit', (code, signal) => {
      const expected = this.state === 'stopping';
      this.child = null; this.startedAt = null;
      if (expected || code === 0) this.#set('stopped');
      else { this.lastError ||= `The bot stopped unexpectedly (${code ?? signal}). See the log.`; this.#set('failed'); }
    });
    return true;
  }

  stop() {
    const child = this.child;
    if (!child) { if (this.state !== 'stopped') this.#set('stopped'); return Promise.resolve(); }
    this.#set('stopping');
    return new Promise((resolve) => {
      const kill = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, this.stopTimeoutMs);
      child.once('exit', () => { clearTimeout(kill); resolve(); });
      try { child.send({ type: 'shutdown' }); } catch { try { child.kill(); } catch { /* gone */ } }
    });
  }

  async restart() { await this.stop(); this.lastError = ''; return this.start(); }
}
