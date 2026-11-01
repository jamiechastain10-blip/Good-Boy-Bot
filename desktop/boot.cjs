// Basic Ghost Labs - Good Boy. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// Starts the app (main.js is an ES module). If it cannot start, the person sees why instead of nothing happening.
// The step log is written only during the automated build check (GOODBOY_SMOKE_DIR).
const fs = require('node:fs');
const path = require('node:path');

const dir = process.env.GOODBOY_SMOKE_DIR || '';
const log = (m) => { if (!dir) return; try { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, 'boot.log'), `${new Date().toISOString()} ${m}\n`); } catch { /* best effort */ } };
globalThis.gbLog = log;
log(`boot: electron ${process.versions.electron}, node ${process.versions.node}, ${process.platform}`);
process.on('uncaughtException', (e) => log(`uncaught: ${e?.stack ?? e}`));
process.on('unhandledRejection', (e) => log(`unhandled: ${e?.stack ?? e}`));

import('./main.js').then(() => log('main.js loaded'), (e) => {
  log(`main.js failed: ${e?.stack ?? e}`);
  const { app, dialog } = require('electron');
  app.whenReady().then(() => {
    if (!dir) dialog.showErrorBox('Good Boy could not start', String(e?.stack ?? e).slice(0, 1500));
    app.exit(1);
  });
});
