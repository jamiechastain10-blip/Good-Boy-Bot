// Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// Starts the app (main.js is an ES module). If it cannot start, the person sees why instead of nothing happening.
// The step log goes to the build check's folder (GOODBOY_SMOKE_DIR), or else to app.log in the app's data folder
// (%APPDATA%\\Good Boy on Windows), kept under 1 MB, so a problem on someone's computer can be looked into.
const fs = require('node:fs');
const path = require('node:path');

const dir = process.env.GOODBOY_SMOKE_DIR || (() => { try { return require('electron').app.getPath('userData'); } catch { return ''; } })();
const file = dir ? path.join(dir, process.env.GOODBOY_SMOKE_DIR ? 'boot.log' : 'app.log') : '';
try { if (file && fs.statSync(file).size > 1000000) fs.renameSync(file, `${file}.old`); } catch { /* no log yet */ }
const log = (m) => { if (!file) return; try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(file, `${new Date().toISOString()} ${String(m).slice(0, 2000)}\n`); } catch { /* best effort */ } };
globalThis.gbLog = log;
log(`boot: electron ${process.versions.electron}, node ${process.versions.node}, ${process.platform}`);
process.on('uncaughtException', (e) => log(`uncaught: ${e?.stack ?? e}`));
process.on('unhandledRejection', (e) => log(`unhandled: ${e?.stack ?? e}`));

import('./main.js').then(() => log('main.js loaded'), (e) => {
  log(`main.js failed: ${e?.stack ?? e}`);
  const { app, dialog } = require('electron');
  app.whenReady().then(() => {
    if (!process.env.GOODBOY_SMOKE_DIR) dialog.showErrorBox('Good Boy could not start', String(e?.stack ?? e).slice(0, 1500));
    app.exit(1);
  });
});
