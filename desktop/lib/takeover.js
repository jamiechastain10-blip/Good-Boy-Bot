/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * "Take control": when an older copy of the bot is still running in the background (left behind, or started by
 * another Good Boy install on this computer), the app can stop it and start fresh. Safety first: a process is only
 * stopped if it really is Node (the bot), because a lock file can name a process ID that Windows has since reused.
 */
import { execFile as realExecFile } from 'node:child_process';
import fs from 'node:fs';

/** Reads the supervisor's "someone else is running" line. other = a different install on this computer. */
export function blockedBy(line) {
  const m = /Another supervisor \(process (\d+)\) is already running this install|This bot is already running from another Good Boy install on this computer \(process (\d+)\)/.exec(String(line));
  if (!m) return null;
  return { pid: Number(m[1] ?? m[2]), other: !!m[2] };
}

const run = (execFile, cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? '') }));
});

/** Name of the program running as `pid`, or null if nothing is. */
export async function processName(pid, { platform = process.platform, execFile = realExecFile } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'win32') {
    const r = await run(execFile, 'tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const m = /^"([^"]+)","(\d+)"/m.exec(r.out);
    return m && Number(m[2]) === pid ? m[1] : null;
  }
  const r = await run(execFile, 'ps', ['-p', String(pid), '-o', 'comm=']);
  const name = r.out.trim().split('/').pop();
  return r.ok && name ? name : null;
}
export const isNodeName = (name) => /^node(\.exe)?$/i.test(String(name ?? ''));

/** Stops the process and everything it started (the bot under the supervisor). */
export async function stopTree(pid, { platform = process.platform, execFile = realExecFile, kill = process.kill.bind(process) } = {}) {
  if (platform === 'win32') return (await run(execFile, 'taskkill', ['/PID', String(pid), '/T', '/F'])).ok;
  try { kill(pid, 'SIGTERM'); return true; } catch { return false; }
}

/** Removes lock files that name `pid`, so the next start is not blocked by them. */
export function clearLocks(files, pid) {
  const removed = [];
  for (const f of files.filter(Boolean)) {
    try { if (JSON.parse(fs.readFileSync(f, 'utf8')).pid === pid) { fs.rmSync(f, { force: true }); removed.push(f); } } catch { /* none */ }
  }
  return removed;
}

/**
 * The whole "Take control" step. Returns { ok, stopped, stale } or { ok: false, error }.
 * stale = the lock named a process that is gone or is not Node, so nothing was stopped; the lock is just cleared.
 */
export async function takeControl(pid, { lockFiles = [], platform = process.platform, execFile = realExecFile, kill, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const name = await processName(pid, { platform, execFile });
  if (!name || !isNodeName(name)) { clearLocks(lockFiles, pid); return { ok: true, stopped: false, stale: true }; }
  await stopTree(pid, { platform, execFile, kill });
  for (let i = 0; i < 20; i++) { if (!(await processName(pid, { platform, execFile }))) break; await wait(500); }
  if (await processName(pid, { platform, execFile })) return { ok: false, error: `The old copy (process ${pid}) would not stop. Restart your computer, then open Good Boy again.` };
  clearLocks(lockFiles, pid);
  return { ok: true, stopped: true, stale: false };
}
