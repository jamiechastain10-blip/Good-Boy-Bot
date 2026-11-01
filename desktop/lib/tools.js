/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
// Runs scripts/app-tools.js with the bundled Node and returns its one line of JSON.
import { execFile as realExecFile } from 'node:child_process';
import path from 'node:path';

export function runTool({ nodePath, botDir, args, execFile = realExecFile, timeoutMs = 60000 }) {
  return new Promise((resolve) => {
    execFile(nodePath, ['--disable-warning=ExperimentalWarning', path.join(botDir, 'scripts', 'app-tools.js'), ...args],
      { cwd: botDir, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' } },
      (err, stdout) => {
        const line = String(stdout ?? '').trim().split(/\r?\n/).pop();
        try { return resolve(JSON.parse(line)); } catch { /* fall through */ }
        resolve({ ok: false, error: err ? (/ENOENT/.test(err.message) ? 'The bundled Node.js is missing. Please reinstall Good Boy.' : err.message.split('\n')[0]) : 'No answer from the helper.' });
      });
  });
}
