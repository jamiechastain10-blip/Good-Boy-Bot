/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const MIN_NODE = [22, 13];

/** "v22.14.0" -> [22,14,0], or null. */
export function parseNodeVersion(text) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export const nodeIsNewEnough = (v) => !!v && (v[0] > MIN_NODE[0] || (v[0] === MIN_NODE[0] && v[1] >= MIN_NODE[1]));

/** Where Node usually lives. A packaged app opened from the Start menu or Finder does not inherit the terminal's PATH. */
export function candidateNodePaths(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean);
    return [...roots.map((r) => path.join(r, 'nodejs', 'node.exe')), env.NVM_SYMLINK && path.join(env.NVM_SYMLINK, 'node.exe'), env.VOLTA_HOME && path.join(env.VOLTA_HOME, 'bin', 'node.exe')].filter(Boolean);
  }
  const home = env.HOME || '';
  return ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', home && path.join(home, '.volta', 'bin', 'node'), home && path.join(home, '.local', 'bin', 'node')].filter(Boolean);
}

/**
 * Find a working Node: the one the person chose, then "node" on the PATH, then the usual install places.
 * Returns { found, version, ok, path }. `run` is injectable for tests; `exists` says whether a candidate file is there.
 */
export function findNode(run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000, windowsHide: true }), chosen = '', { candidates = candidateNodePaths(), exists = (f) => fs.existsSync(f) } = {}) {
  const tries = [chosen, 'node', ...candidates].filter((x, i, a) => x && a.indexOf(x) === i && (x === 'node' || x === chosen || exists(x)));
  for (const cmd of tries) {
    try {
      const v = parseNodeVersion(run(cmd, ['--version']));
      if (v) return { found: true, version: v.join('.'), ok: nodeIsNewEnough(v), path: cmd };
    } catch { /* try the next place */ }
  }
  return { found: false, version: null, ok: false, path: '' };
}

/** Read DASHBOARD_PORT from the text of a .env file (the token is never read). */
export function dashboardPort(envText) {
  const m = /^\s*DASHBOARD_PORT\s*=\s*"?(\d{2,5})"?\s*(#.*)?$/m.exec(String(envText ?? ''));
  const p = m ? Number(m[1]) : 3000;
  return p >= 1 && p <= 65535 ? p : 3000;
}
export const dashboardUrl = (port) => `http://localhost:${port}`;

/** Only our own dashboard (loopback, http) may be opened from the app. Anything else is refused. */
export function isSafeDashboardUrl(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === 'http:' && (x.hostname === 'localhost' || x.hostname === '127.0.0.1') && !x.username && !x.password;
  } catch { return false; }
}

/**
 * Is this folder a usable Good Boy folder? Returns plain-English problems (empty = ready) and the dashboard port.
 * It only checks that a DISCORD_TOKEN line exists; it never returns the token.
 */
export function checkBotDir(dir, fsx = fs) {
  const problems = []; let port = 3000;
  if (!dir) return { ok: false, problems: ['Choose the folder where Good Boy is installed.'], port };
  const has = (...p) => fsx.existsSync(path.join(dir, ...p));
  let pkg = null;
  try { pkg = JSON.parse(fsx.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* handled below */ }
  if (!pkg || pkg.name !== 'good-boy') problems.push('That folder does not look like Good Boy (no package.json named good-boy).');
  else {
    if (!has('scripts', 'supervise.js')) problems.push('This version has no supervisor script (needs Good Boy 2.1.1 or newer).');
    if (!has('node_modules')) problems.push('Dependencies are not installed. Open a terminal in that folder and run: npm install');
  }
  let env = '';
  try { env = fsx.readFileSync(path.join(dir, '.env'), 'utf8'); } catch { /* none */ }
  if (!/^\s*DISCORD_TOKEN\s*=\s*\S+/m.test(env)) problems.push('There is no DISCORD_TOKEN in that folder\'s .env file. Run "npm run setup" there first.');
  port = dashboardPort(env);
  return { ok: problems.length === 0, problems, port };
}
