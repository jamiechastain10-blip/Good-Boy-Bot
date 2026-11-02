/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Good Boy desktop app (Windows and macOS). The bot and its own copy of Node ship inside the app: install, open,
 * set up once, done. The token and other bot settings are kept encrypted by the operating system (safeStorage),
 * never in a plain .env file. Running from the source folder (no bundle) still works with a chosen Good Boy folder.
 */
import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, safeStorage, clipboard, powerSaveBlocker, Notification, nativeTheme } from 'electron';
import QRCode from 'qrcode';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize } from './lib/settings.js';
import { checkBotDir, findNode, isSafeDashboardUrl, isDashboardWindowUrl, dashboardUrl, dashboardPort } from './lib/checks.js';
import { BotRunner } from './lib/runner.js';
import { Vault, SecretFile } from './lib/vault.js';
import { parseEnv, safeBotSettings, looksLikeToken } from './lib/envfile.js';
import { readEdition } from './lib/edition.js';
import { ensureBotCode, seedData } from './lib/botinstall.js';
import { runTool } from './lib/tools.js';
import { verifyToken, verifySecret, addRedirectUri, linkFor, isSnowflake, appIdFromToken, redirectUriFor } from './lib/discord.js';
import { takeControl } from './lib/takeover.js';
import { Share, shareSettings, isTailscaleLink } from './lib/share.js';
import { updateMode, channelFor, readLatest, latestApi, releasesPage, restartPlan } from './lib/updater.js';
import { brandStatus, applyBrand, applyCustom } from './lib/brand.js';
import { createLicense, verifyLicense, generateKeyPair, hasFeature, FEATURES } from './lib/license.js';
import { signModule, verifyModule, moduleNameOf } from './lib/modsign.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const startHidden = process.argv.includes('--hidden');
const log = (m) => globalThis.gbLog?.(m);

// One copy of the app at a time: a second launch just brings the first one forward.
if (!app.requestSingleInstanceLock()) { log('another copy is running, quitting'); app.quit(); process.exit(0); }
log('single-instance lock taken');

const smokeDir = process.env.GOODBOY_SMOKE_DIR || ''; // set only by the automated build check
if (smokeDir) { fs.mkdirSync(smokeDir, { recursive: true }); app.setPath('userData', path.join(smokeDir, 'user-data')); }

let edition = readEdition(null);
try { edition = readEdition(JSON.parse(fs.readFileSync(path.join(here, 'edition.json'), 'utf8'))); } catch { /* consumer */ }

// ---- where things live
const res = app.isPackaged ? process.resourcesPath : path.join(here, 'bundle');
const bundled = fs.existsSync(path.join(res, 'bot', 'package.json'));
const P = {
  bundledBot: path.join(res, 'bot'),
  bundledNode: path.join(res, 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
  ownerSeed: path.join(res, 'owner-seed', 'eclipse.db'),
  botHome: () => path.join(app.getPath('userData'), 'bot'),
  dataDir: () => path.join(app.getPath('userData'), 'bot-data'),
  settings: () => path.join(app.getPath('userData'), 'settings.json'),
  vault: () => path.join(app.getPath('userData'), 'secrets.bin'),
  licenseKey: () => path.join(app.getPath('userData'), 'licence-signing-key.bin'),
  issued: () => path.join(app.getPath('userData'), 'licences-issued.json'),
  publicKey: path.join(here, 'license-public-key.pem'),
  extraModules: () => path.join(app.getPath('userData'), 'bot-modules'),
};

let win = null, splash = null, tray = null, runner = null, quitting = false, vault = null;
let settings = normalize(null);
let folder = { ok: false, problems: [], port: 3000 };
let nodeInfo = { found: false, version: null, ok: false, path: '' };
let prep = { done: !bundled, error: '', action: '' };
const allowedImport = new Set(); // folders the person picked or that were found on this computer, this session
let knownAppId = null; // from the last successful token check, for the setup's links
let redirectUri = 'http://localhost:3000/callback';
let licence = { ok: false };
const U = { mode: 'off', phase: 'off', version: null, percent: null, error: null, url: null, checkedAt: null }; // app updates
let autoUpdater = null;
const publicKey = (() => { try { return fs.readFileSync(P.publicKey, 'utf8'); } catch { return null; } })();
const whiteLabel = () => edition.id === 'owner' || hasFeature(licence, 'whitelabel');

function loadSettings() { try { settings = normalize(JSON.parse(fs.readFileSync(P.settings(), 'utf8'))); } catch { settings = normalize(null); } }
function saveSettings() { fs.mkdirSync(path.dirname(P.settings()), { recursive: true }); fs.writeFileSync(P.settings(), JSON.stringify(settings, null, 2)); }

const botDir = () => (bundled ? P.botHome() : settings.botDir);
const dataDir = () => (bundled ? P.dataDir() : path.join(settings.botDir || '.', 'data'));
const nodePath = () => (bundled ? P.bundledNode : nodeInfo.path || 'node');

/** Environment for the bot: the computer's basics plus the saved bot settings. Nothing from Electron leaks in. */
function childEnv() {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ELECTRON_|NODE_OPTIONS$|GOODBOY_SMOKE)/i.test(k)));
  const brandEnv = whiteLabel() && edition.id !== 'owner' ? { GOODBOY_WHITELABEL: '1', GOODBOY_VERSION_IN_DESCRIPTION: 'false' } : {};
  return bundled ? { ...base, ...vault.read(), ...brandEnv, GOODBOY_DATA_DIR: P.dataDir(), GOODBOY_EXTRA_MODULES: P.extraModules() } : base;
}

function recheck() {
  if (bundled) {
    nodeInfo = findNode(undefined, P.bundledNode, { candidates: [], exists: () => false });
    const v = vault.read();
    redirectUri = redirectUriFor(v);
    if (!knownAppId) knownAppId = appIdFromToken(v.DISCORD_TOKEN);
    licence = settings.license ? verifyLicense(settings.license, publicKey, { appId: appIdFromToken(v.DISCORD_TOKEN) }) : { ok: false };
    const problems = [];
    if (!prep.done) problems.push(prep.error || 'Getting the bot ready...');
    if (!v.DISCORD_TOKEN) problems.push('Finish setup: Good Boy needs your bot token.');
    folder = { ok: prep.done && !prep.error && !!v.DISCORD_TOKEN, problems, port: dashboardPort(v.DASHBOARD_PORT ? `DASHBOARD_PORT=${v.DASHBOARD_PORT}` : '') };
  } else {
    nodeInfo = findNode(undefined, settings.nodePath);
    folder = checkBotDir(settings.botDir);
  }
  // Keep the same runner: replacing it while the bot runs would lose track of the running bot (it would keep going
  // in the background with no way to stop it from the app). New settings apply the next time it starts.
  if (runner) { Object.assign(runner, { botDir: botDir(), script: path.join(botDir(), 'scripts', 'supervise.js'), nodePath: nodePath(), env: childEnv() }); return; }
  runner = new BotRunner({ botDir: botDir(), nodePath: nodePath(), env: childEnv() });
  runner.on('state', (s) => { send('state', snapshot()); refreshTray(); keepAwake(s.state); if (s.state === 'running' && settings.dashboardOnStart && !runner.openedDashboard) { runner.openedDashboard = true; openDashboard(); } });
  runner.on('log', (line) => send('log', line));
}

const snapshot = () => ({
  settings, folder, node: nodeInfo, bot: runner.status(), url: dashboardUrl(folder.port), platform: process.platform, version: app.getVersion(),
  edition: { id: edition.id, name: edition.name, features: edition.features }, bundled, prep,
  vault: bundled ? vault.describe() : null, redirectUri, whiteLabel: whiteLabel(),
  update: U,
  licence: settings.license ? { ok: licence.ok, error: licence.error ?? null, to: licence.payload?.to ?? null, features: licence.payload?.features ?? [], exp: licence.payload?.exp ?? null } : null, licencesOn: !!publicKey, setupNeeded: bundled && (!vault.has('DISCORD_TOKEN') || !settings.setupComplete), secure: bundled ? vault.available() : true,
});
const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
const ready = () => folder.ok && nodeInfo.ok;

function startBot() { if (!ready()) return false; runner.openedDashboard = false; return runner.start(); }
/**
 * 2.3: the full dashboard opens inside Good Boy, already signed in as the bot's owner. The running bot hands the app a
 * one-time link over its private channel, so no Discord login (and no Client Secret) is needed on this computer.
 * The window is sandboxed, has no access to the app's own functions, and only shows the dashboard: anything else
 * opens in the browser. If the bot cannot give a link (an older bot, or it is not running) the browser is used.
 */
let dashWin = null;
async function openDashboard() {
  if (runner?.status().state === 'running') {
    const r = await runner.control('dashboard-login', {}).catch(() => null);
    if (r?.ok && isDashboardWindowUrl(r.url)) return openDashboardWindow(r.url);
  }
  return openDashboardInBrowser();
}
function openDashboardWindow(url) {
  const allowed = new URL(url).origin;
  if (dashWin && !dashWin.isDestroyed()) { dashWin.loadURL(url); dashWin.show(); dashWin.focus(); return; }
  dashWin = new BrowserWindow({
    width: 1320, height: 880, minWidth: 420, minHeight: 560, title: 'Good Boy · Dashboard', show: false, autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#060C18' : '#EEF2F7', icon: path.join(here, 'renderer', 'brand', 'app-icon.png'),
    webPreferences: { partition: 'persist:dashboard', contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  const ses = dashWin.webContents.session;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false)); // the dashboard never needs camera, mic, location...
  const external = (u) => { if (/^https:\/\//.test(u)) shell.openExternal(u); };
  dashWin.webContents.setWindowOpenHandler(({ url: u }) => { external(u); return { action: 'deny' }; });
  dashWin.webContents.on('will-navigate', (e, u) => { if (new URL(u).origin !== allowed) { e.preventDefault(); external(u); } });
  dashWin.once('ready-to-show', () => dashWin.show());
  dashWin.on('closed', () => { dashWin = null; });
  dashWin.loadURL(url);
}
async function openDashboardInBrowser() {
  const u = dashboardUrl(folder.port);
  if (!isSafeDashboardUrl(u)) return;
  // Discord refuses the dashboard login unless this exact address is on the bot's Redirects list. Check first.
  if (bundled && vault.has('DISCORD_CLIENT_SECRET')) {
    const v = await verifyToken(savedToken()).catch(() => null);
    const sec = v?.ok ? await verifySecret(v.app.id, savedSecret()) : null;
    if (sec && !sec.ok && sec.kind === 'invalid') {
      const r = await dialog.showMessageBox(win, { type: 'warning', title: 'The dashboard login will not work yet', message: 'Your Client Secret is wrong', detail: 'Discord turned down the saved Client Secret, so logging in to the dashboard would fail ("invalid_client").\n\nOpen OAuth2 in the Developer Portal, click Reset Secret, copy it, then paste it in Good Boy: Settings > Change client secret.', buttons: ['Open the OAuth2 page', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true });
      if (r.response === 0) shell.openExternal(linkFor('oauth', v.app.id));
      return;
    }
    if (v?.ok && Array.isArray(v.app.redirectUris) && !v.app.redirectUris.includes(redirectUri)) {
      const r = await dialog.showMessageBox(win, { type: 'warning', title: 'One more step for the dashboard login', message: 'Add the dashboard address to your bot first', detail: `Discord only lets you log in if this address is on your bot's Redirects list:\n\n${redirectUri}\n\nCopy it, open the OAuth2 page, click Add Redirect, paste it, then click Save Changes.`, buttons: ['Copy address and open OAuth2 page', 'Open the dashboard anyway', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true });
      if (r.response === 0) { clipboard.writeText(redirectUri); shell.openExternal(linkFor('oauth', v.app.id)); return; }
      if (r.response === 2) return;
    }
  }
  shell.openExternal(u);
}
function showWindow() { if (!win) createWindow(); else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } if (process.platform === 'darwin') app.dock?.show(); }

/** Copy the bundled bot into place (first run or new version) and put the owner's data in on first run. */
async function prepare() {
  if (!bundled) return;
  try {
    const r = ensureBotCode(P.bundledBot, P.botHome());
    prep.action = r.action;
    log(`bot code: ${r.action} ${r.version}`);
    if (edition.features.includes('seed') && seedData(P.ownerSeed, P.dataDir())) log('owner server data put in place');
    prep = { ...prep, done: true, error: '' };
  } catch (e) { prep = { ...prep, done: false, error: `Could not set up the bot: ${e.message}` }; log(prep.error); }
  recheck(); send('state', snapshot()); refreshTray();
  if (settings.startBotWithApp && ready() && !smokeDir) startBot();
  if (!smokeDir && settings.shareAuto) { setTimeout(() => keepShared().catch((e) => log(`share: ${e.message}`)), 8000); setInterval(() => keepShared().catch(() => {}), 30 * 60000).unref?.(); }
  if (!smokeDir) { setTimeout(() => keepBrand().catch(() => {}), 20000); setInterval(() => keepBrand().catch(() => {}), 6 * 3600000).unref?.(); }
}

// ---- windows
function createSplash() {
  splash = new BrowserWindow({
    width: 440, height: 280, frame: false, resizable: false, movable: true, minimizable: false, maximizable: false, fullscreenable: false,
    show: false, skipTaskbar: true, title: 'Good Boy', backgroundColor: '#060C18',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  splash.setMenuBarVisibility(false);
  splash.loadFile(path.join(here, 'renderer', 'splash.html'));
  splash.once('ready-to-show', () => splash?.show());
  splash.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  splash.webContents.on('will-navigate', (e) => e.preventDefault());
  splash.on('closed', () => { splash = null; });
}
const closeSplash = () => { if (splash && !splash.isDestroyed()) splash.close(); };

function createWindow() {
  const launchedAt = Date.now();
  if (!startHidden) createSplash();
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 860, minHeight: 560, show: false, title: 'Good Boy', backgroundColor: '#EEF2F7', icon: path.join(here, 'renderer', 'good-boy-logo.png'),
    titleBarStyle: 'hidden', ...(mac ? { trafficLightPosition: { x: 16, y: 13 } } : { titleBarOverlay: { color: '#00000000', symbolColor: '#5E6E86', height: 38 } }),
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(here, 'renderer', 'index.html'));
  // Show once drawn; keep the launch window up for at least a second so it does not just flash.
  win.once('ready-to-show', () => {
    const wait = smokeDir ? 0 : Math.max(0, 1100 - (Date.now() - launchedAt));
    setTimeout(() => { if (!win || win.isDestroyed()) return; if (!startHidden) win.show(); if (!smokeDir) closeSplash(); }, wait);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  if (smokeDir) {
    win.webContents.once('did-finish-load', () => { log('page loaded'); setTimeout(() => smokeCheck().catch((e) => { log(`smoke error ${e.stack}`); app.exit(1); }), 1500); });
    win.webContents.on('did-fail-load', (_e, code, desc) => log(`page failed to load: ${code} ${desc}`));
    win.webContents.on('render-process-gone', (_e, d) => log(`page crashed: ${d.reason}`));
  }
  win.on('close', (e) => {
    if (quitting || settings.closeAction === 'quit') return;
    e.preventDefault(); win.hide();
    if (process.platform === 'darwin') app.dock?.hide();
  });
  win.on('closed', () => { win = null; });
}

/** Colours of the Windows caption buttons follow the page's light or dark look. */
function setChrome(dark) {
  // Native parts the page can't style (the open list of a dropdown, scrollbars, context menus) follow the app's theme.
  nativeTheme.themeSource = dark ? 'dark' : 'light'; if (process.platform !== 'darwin' && win && !win.isDestroyed()) try { win.setTitleBarOverlay({ color: '#00000000', symbolColor: dark ? '#9AA9C2' : '#5E6E86', height: 38 }); } catch { /* older systems */ } }

/** Only used by the automated build check (GOODBOY_SMOKE_DIR): walk every page, photograph it, save the facts, exit. */
async function smokeCheck() {
  const out = { ok: false, error: '', pages: {} };
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => fs.writeFileSync(path.join(smokeDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  out.splashOpen = !!splash && !splash.isDestroyed();
  if (out.splashOpen) fs.writeFileSync(path.join(smokeDir, 'splash.png'), (await splash.webContents.capturePage()).toPNG());
  closeSplash();
  for (let i = 0; i < 40 && !prep.done && !prep.error; i++) await wait(500);
  out.prep = prep;
  out.selftest = await runTool({ nodePath: nodePath(), botDir: botDir(), args: ['selftest'] });
  await wait(600);
  out.setupScreen = await js(`!!document.querySelector('[data-page="setup"]')`);
  await shot('setup-1-welcome');
  // walk the setup: a made-up token must be turned down by Discord with a plain message (the build machine is online)
  await js(`wgo('token')`); await wait(500);
  await js(`(() => { const i = document.getElementById('token-input'); i.value = ['MTAwMDAwMDAwMDAwMDAwMDAw', 'Smoke1', 'not-a-real-token-xxxxxxxxxxxxxxxxxxxxxx'].join('.'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  for (let i = 0; i < 24; i++) { await wait(500); if (await js(`!!document.querySelector('#token-status .err')`)) break; }
  out.tokenCheck = await js(`document.getElementById('token-status')?.innerText || ''`);
  out.nextBlocked = await js(`document.getElementById('token-next')?.disabled === true`);
  await shot('setup-2-token');
  for (const [step, name] of [['secret', 'setup-3-secret'], ['brand', 'setup-4-brand'], ['invite', 'setup-5-invite'], ['done', 'setup-6-done']]) { await js(`wgo('${step}')`); await wait(800); await shot(name); }
  // finish setup with a made-up token of the right shape so the main pages show (the bot is never started here)
  vault.merge({ DISCORD_TOKEN: ['MTAwMDAwMDAwMDAwMDAwMDAw', 'Smoke1', 'smoke-test-token-not-real-xxxxxxxxxx'].join('.') });
  if (process.env.GOODBOY_SMOKE_SEED) out.seed = await runTool({ nodePath: nodePath(), botDir: botDir(), args: ['import', process.env.GOODBOY_SMOKE_SEED, P.dataDir()] });
  await applySettings({ setupComplete: true, theme: 'light' });
  recheck(); send('state', snapshot()); await wait(900);
  for (const page of ['overview', 'levels', 'modules', 'log', 'updates', ...(edition.features.includes('licenses') ? ['licenses'] : []), 'settings']) {
    await js(`document.querySelector('[data-nav="${page}"]')?.click()`); await wait(900);
    out.pages[page] = await js(`(() => { const m = document.querySelector('main'); return { shown: m?.dataset.page, text: (m?.innerText || '').slice(0, 300), groups: document.querySelectorAll('main .group').length }; })()`);
    await shot(`page-${page}`);
  }
  await applySettings({ theme: 'dark' }); await js(`document.querySelector('[data-nav="overview"]')?.click()`); await wait(900); await shot('page-overview-dark');
  out.look = await js(`(() => { const g = document.querySelector('.group'); const s = g && getComputedStyle(g); const f = getComputedStyle(document.body).fontFamily; return { blur: s ? (s.backdropFilter || s.webkitBackdropFilter) : '', font: f, fontsReady: document.fonts.check('600 16px "Inter Display"') }; })()`);
  out.node = nodeInfo; out.platform = process.platform; out.version = app.getVersion(); out.electron = process.versions.electron; out.edition = edition.id; out.bundled = bundled;
  const pagesOk = Object.entries(out.pages).every(([k, v]) => v.shown === k);
  out.ok = out.setupScreen && pagesOk && out.splashOpen && out.nextBlocked && /not valid|reach Discord/.test(out.tokenCheck) && (!bundled || (out.selftest.ok && prep.done && !prep.error));
  fs.writeFileSync(path.join(smokeDir, 'smoke.json'), JSON.stringify(out, null, 2));
  app.exit(out.ok ? 0 : 1);
}

// ---- tray
function refreshTray() {
  if (!tray) return;
  const st = runner?.status().state ?? 'stopped';
  tray.setToolTip(`Good Boy - bot ${st}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Good Boy', click: showWindow },
    { label: 'Open dashboard', enabled: st === 'running', click: openDashboard },
    { type: 'separator' },
    { label: st === 'running' || st === 'starting' ? 'Stop bot' : 'Start bot', enabled: ready() && st !== 'stopping', click: () => (st === 'running' || st === 'starting' ? runner.stop() : startBot()) },
    { type: 'separator' },
    ...(U.phase === 'ready' ? [{ label: `Restart to update to ${U.version}`, click: () => { installUpdate().catch(() => {}); } }] : []),
    { label: 'Quit (stops the bot)', click: () => app.quit() },
  ]));
}
function createTray() {
  const icon = nativeImage.createFromPath(path.join(here, 'renderer', process.platform === 'darwin' ? 'good-boy-logo.png' : 'tray.png')).resize({ width: process.platform === 'darwin' ? 18 : 16, quality: 'best' });
  tray = new Tray(icon);
  tray.on('click', showWindow);
  refreshTray();
}

// ---- setup: find an existing Good Boy folder on this computer, or type the token
function folderInfo(dir) {
  try {
    const env = parseEnv(fs.readFileSync(path.join(dir, '.env'), 'utf8'));
    const db = path.join(dir, 'data', 'eclipse.db');
    return { dir, hasToken: looksLikeToken(env.DISCORD_TOKEN), hasClientSecret: !!env.DISCORD_CLIENT_SECRET, hasData: fs.existsSync(db), dataSize: fs.existsSync(db) ? fs.statSync(db).size : 0 };
  } catch { return null; }
}
function candidateFolders() {
  const home = os.homedir();
  const list = [settings.botDir, 'F:\\Discord Bot\\eclipse-bot-v2.1', 'F:\\Discord Bot\\good-boy-v2.1.1', 'F:\\Discord Bot\\eclipse-bot', path.join(home, 'good-boy'), path.join(home, 'Desktop', 'good-boy'), path.join(home, 'Documents', 'good-boy'), path.join(home, 'Downloads', 'good-boy-v2.1.1')];
  return [...new Set(list.filter(Boolean))].map(folderInfo).filter((f) => f && f.hasToken);
}
async function importFolder(dir) {
  if (!allowedImport.has(dir)) throw new Error('Pick the folder first.');
  const info = folderInfo(dir);
  if (!info?.hasToken) throw new Error('That folder has no bot token in its .env file.');
  const env = safeBotSettings(parseEnv(fs.readFileSync(path.join(dir, '.env'), 'utf8')));
  vault.merge(env);
  let data = null;
  if (info.hasData) data = await runTool({ nodePath: nodePath(), botDir: botDir(), args: ['import', path.join(dir, 'data', 'eclipse.db'), P.dataDir()] });
  recheck(); send('state', snapshot());
  return { ok: true, settings: Object.keys(env).length, data };
}

// ---- messages from the window (the preload exposes exactly these, nothing else)
ipcMain.handle('gb:state', () => ({ ...snapshot(), logs: runner.logs.all() }));
ipcMain.handle('gb:start', () => startBot());
ipcMain.handle('gb:stop', () => runner.stop());
ipcMain.handle('gb:restart', async () => { if (!ready()) return false; await runner.stop(); return startBot(); });
ipcMain.handle('gb:open-dashboard', () => openDashboard());
ipcMain.handle('gb:open-dashboard-browser', () => openDashboardInBrowser());
// The Levels page: names and pictures come from the running bot (the database only has member numbers).
ipcMain.handle('gb:levels', () => (runner?.status().state === 'running' ? runner.control('levels', {}) : { ok: false, error: 'The bot is not running.' }));
ipcMain.handle('gb:recheck', () => { recheck(); return snapshot(); });
ipcMain.handle('gb:summary', () => (prep.done ? runTool({ nodePath: nodePath(), botDir: botDir(), args: ['summary', dataDir()] }) : { ok: false, error: 'Still getting the bot ready.' }));
ipcMain.handle('gb:chrome', (_e, dark) => setChrome(!!dark));
ipcMain.handle('gb:choose-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose the Good Boy folder', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return snapshot();
  return applySettings({ botDir: r.filePaths[0] });
});
ipcMain.handle('gb:choose-node', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose node (node.exe on Windows)', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'node.exe', extensions: ['exe'] }] : [] });
  if (r.canceled || !r.filePaths[0]) return snapshot();
  const picked = normalize({ nodePath: r.filePaths[0] }).nodePath;
  if (!picked) { dialog.showErrorBox('That is not Node', 'Pick the file named node (node.exe on Windows).'); return snapshot(); }
  return applySettings({ nodePath: picked });
});
ipcMain.handle('gb:setup-find', () => { const found = candidateFolders(); for (const f of found) allowedImport.add(f.dir); return found; });
ipcMain.handle('gb:setup-pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose your existing Good Boy folder', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const info = folderInfo(r.filePaths[0]);
  if (info) allowedImport.add(info.dir);
  return info ?? { dir: r.filePaths[0], hasToken: false, hasData: false };
});
ipcMain.handle('gb:setup-import', async (_e, dir) => { try { return await importFolder(String(dir ?? '')); } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('gb:setup-save', (_e, form) => {
  const token = String(form?.token ?? '').trim(), secret = String(form?.clientSecret ?? '').trim();
  if (!looksLikeToken(token)) return { ok: false, error: 'That does not look like a bot token. Copy it from the Discord Developer Portal > your app > Bot > Reset Token.' };
  try { vault.merge({ DISCORD_TOKEN: token, ...(secret ? { DISCORD_CLIENT_SECRET: secret } : {}) }); } catch (e) { return { ok: false, error: e.message }; }
  recheck(); send('state', snapshot());
  return { ok: true };
});
/** The saved token, only ever sent to Discord to check it (never to the window). */
function savedToken() { return vault.read().DISCORD_TOKEN; }
/** The saved client secret, only ever sent to Discord to check it. */
function savedSecret() { return vault.read().DISCORD_CLIENT_SECRET; }
ipcMain.handle('gb:verify-token', async (_e, token) => {
  // The token typed in the window, or (with no argument) the saved one: used again on the invite step to see new servers.
  const t = token == null ? savedToken() : String(token);
  const r = await verifyToken(t);
  if (r.ok) knownAppId = r.app.id;
  return r;
});
ipcMain.handle('gb:open-link', (_e, kind) => {
  const url = linkFor(String(kind ?? ''), isSnowflake(knownAppId) ? knownAppId : null);
  if (url && url.startsWith('https://discord.com/')) shell.openExternal(url);
  return !!url;
});
ipcMain.handle('gb:setup-secret', async (_e, secret) => {
  const s = String(secret ?? '').trim();
  if (!s) return { ok: true };
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(s)) return { ok: false, error: 'That does not look like a client secret. Copy it from the Developer Portal > your app > OAuth2.' };
  // Ask Discord now, so a wrong secret is caught here and not later as a failed dashboard login.
  const check = await verifySecret(knownAppId ?? appIdFromToken(savedToken()), s);
  if (!check.ok && check.kind !== 'network' && check.kind !== 'slow' && check.kind !== 'other') return { ok: false, error: check.error };
  try { vault.merge({ DISCORD_CLIENT_SECRET: s }); } catch (e) { return { ok: false, error: e.message }; }
  send('state', snapshot());
  return { ok: true };
});
ipcMain.handle('gb:setup-finish', async (_e, start) => {
  await applySettings({ setupComplete: true });
  recheck(); send('state', snapshot());
  if (start && ready()) startBot();
  return snapshot();
});
ipcMain.handle('gb:copy', (_e, text) => { clipboard.writeText(String(text ?? '').slice(0, 8192)); return true; });

// ---- Good Boy look on the person's own bot
const brandFiles = () => ({ avatar: fs.readFileSync(path.join(here, 'renderer', 'brand', 'avatar.png')), banner: fs.readFileSync(path.join(here, 'renderer', 'brand', 'banner.png')), icon: fs.readFileSync(path.join(here, 'renderer', 'brand', 'app-icon.png')) });
ipcMain.handle('gb:brand-status', async () => {
  const v = await verifyToken(savedToken());
  return v.ok ? { ok: true, bot: v.bot, ...brandStatus(v, settings.brandApplied ?? {}) } : { ok: false, error: v.error };
});
/** Free versions keep the Good Boy look: put back any part that is missing or was changed, quietly, in the background. */
async function keepBrand() {
  if (!bundled || whiteLabel() || !vault?.has('DISCORD_TOKEN') || !settings.setupComplete) return;
  const v = await verifyToken(savedToken()).catch(() => null);
  if (!v?.ok) return;
  const st = brandStatus(v, settings.brandApplied ?? {});
  if (st.done) return;
  const parts = Object.entries(st.items).filter(([, ok]) => !ok).map(([k]) => k);
  const r = await applyBrand(savedToken(), brandFiles(), v, fetch, { parts });
  const keep = { ...(settings.brandApplied ?? {}) };
  for (const [k, val] of Object.entries(r.applied)) if (val) keep[k] = val;
  await applySettings({ brandApplied: keep });
  log(`Good Boy look kept up: ${parts.join(', ')}`);
}
ipcMain.handle('gb:brand-custom', async (_e, form) => {
  if (!whiteLabel()) return { ok: false, error: 'Your own name and picture come with a white-label licence.' };
  let image = null, mime = 'image/png';
  if (form?.pickImage) {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a profile picture', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'gif'] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
    const st = fs.statSync(r.filePaths[0]);
    if (st.size > 8 * 1024 * 1024) return { ok: false, error: 'That picture is too big. Discord takes up to 8 MB.' };
    image = fs.readFileSync(r.filePaths[0]); mime = /\.jpe?g$/i.test(r.filePaths[0]) ? 'image/jpeg' : /\.gif$/i.test(r.filePaths[0]) ? 'image/gif' : 'image/png';
  }
  return applyCustom(savedToken(), { name: form?.name ? String(form.name) : null, image, mime });
});
ipcMain.handle('gb:brand-apply', async () => {
  const current = await verifyToken(savedToken());
  if (!current.ok) return { ok: false, error: current.error };
  const r = await applyBrand(savedToken(), brandFiles(), current);
  const keep = { ...(settings.brandApplied ?? {}) };
  for (const [k, val] of Object.entries(r.applied)) if (val) keep[k] = val;
  await applySettings({ brandApplied: keep });
  const after = await verifyToken(savedToken());
  return { ok: true, results: r.results, ...(after.ok ? { bot: after.bot, ...brandStatus(after, keep) } : {}) };
});

// ---- licences: the Owner app makes them, every app can use one
const licenceKeys = () => new SecretFile(P.licenseKey(), safeStorage);
const readIssued = () => { try { return JSON.parse(fs.readFileSync(P.issued(), 'utf8')).issued ?? []; } catch { return []; } };
const writeIssued = (list) => { fs.mkdirSync(path.dirname(P.issued()), { recursive: true }); fs.writeFileSync(P.issued(), JSON.stringify({ issued: list }, null, 2)); };
const ownerOnly = () => { if (!edition.features.includes('licenses')) throw new Error('Only the Owner version can make licences.'); };
ipcMain.handle('gb:lic-state', () => {
  if (!edition.features.includes('licenses')) return { owner: false };
  const k = licenceKeys().read();
  return { owner: true, hasKey: !!k, publicKey: k?.publicKey ?? null, builtInKeyMatches: !!k && !!publicKey && k.publicKey.trim() === publicKey.trim(), issued: readIssued(), features: FEATURES };
});
ipcMain.handle('gb:lic-keygen', () => {
  try { ownerOnly(); if (licenceKeys().read()) return { ok: false, error: 'You already have a signing key. Making a new one would stop every licence you gave out.' }; licenceKeys().write(generateKeyPair()); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('gb:lic-create', (_e, form) => {
  try {
    ownerOnly();
    const k = licenceKeys().read();
    if (!k) return { ok: false, error: 'Make your signing key first.' };
    const f = form && typeof form === 'object' ? form : {};
    const { key, payload } = createLicense({ privateKey: k.privateKey, appId: String(f.appId ?? '').trim(), to: String(f.to ?? ''), days: f.days === 'lifetime' ? null : Number(f.days), until: f.until || null, features: Array.isArray(f.features) ? f.features.map(String) : [] });
    writeIssued([{ ...payload, key, revoked: false }, ...readIssued()]);
    return { ok: true, key, payload };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('gb:lic-revoke', (_e, id) => {
  try { ownerOnly(); writeIssued(readIssued().map((x) => (x.id === String(id) ? { ...x, revoked: true } : x))); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('gb:lic-apply', async (_e, key) => {
  const k = String(key ?? '').trim();
  if (!k) { await applySettings({ license: '' }); recheck(); send('state', snapshot()); return { ok: true, removed: true }; }
  const check = verifyLicense(k, publicKey, { appId: appIdFromToken(savedToken()) });
  if (!check.ok) return { ok: false, error: check.error };
  await applySettings({ license: k }); recheck(); send('state', snapshot());
  return { ok: true, payload: check.payload };
});
// ---- modules: switch them on and off, and add new ones
const canAddUnsigned = () => edition.id === 'owner' || edition.features.includes('devtools');
ipcMain.handle('gb:modules', async (_e, guildId) => runner.control('modules', guildId ? { guildId: String(guildId) } : {}));
ipcMain.handle('gb:module-set', async (_e, form) => runner.control('module-set', { guildId: form?.guildId ? String(form.guildId) : undefined, name: String(form?.name ?? ''), enabled: !!form?.enabled }));
ipcMain.handle('gb:module-add', async () => {
  if (!bundled) return { ok: false, error: 'Adding modules from the app works with the built-in bot.' };
  const r = await dialog.showOpenDialog(win, { title: 'Choose the module folder', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
  const src = r.filePaths[0];
  let name;
  try { name = moduleNameOf(src); } catch (e) { return { ok: false, error: e.message }; }
  // Safety first: the code is checked BEFORE anything from it is run or copied.
  const sig = verifyModule(src, publicKey);
  if (!sig.ok && !canAddUnsigned()) return { ok: false, error: sig.error };
  const dest = path.join(P.extraModules(), name);
  if (fs.existsSync(dest)) return { ok: false, error: `A module called ${name} was already added. Remove it first to replace it.` };
  fs.mkdirSync(P.extraModules(), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, filter: (f) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(f) });
  if (runner.status().state !== 'running') return { ok: true, name, signed: sig.ok, later: true };
  const check = await runner.control('module-inspect', { folder: name });
  if (!check.ok) { fs.rmSync(dest, { recursive: true, force: true }); return { ok: false, error: `That module has a problem: ${check.error}` }; }
  const loaded = await runner.control('modules-load', {});
  if (!loaded.ok || !loaded.added?.includes(name)) { fs.rmSync(dest, { recursive: true, force: true }); return { ok: false, error: loaded.errors?.[name] ?? loaded.error ?? 'The bot could not load it.' }; }
  return { ok: true, name, signed: sig.ok, version: check.version };
});
ipcMain.handle('gb:module-sign', async () => {
  try {
    ownerOnly();
    const k = licenceKeys().read();
    if (!k) return { ok: false, error: 'Make your signing key first (Licences page).' };
    const r = await dialog.showOpenDialog(win, { title: 'Choose the module folder to sign', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
    return { ok: true, ...signModule(r.filePaths[0], k.privateKey) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('gb:save-settings', (_e, patch) => applySettings(patch));

// ---- take control from an older copy of the bot that is still running in the background
ipcMain.handle('gb:takeover', async () => {
  const b = runner.status().blocked;
  if (!b?.pid) return { ok: false, error: 'Nothing is in the way. Press Start.' };
  if (b.pid === runner.child?.pid) return { ok: false, error: 'That is this app\'s own copy.' };
  const r = await takeControl(b.pid, { lockFiles: [path.join(botDir(), 'supervisor.lock'), ...lockFilesForBot()] });
  if (!r.ok) return r;
  runner.blocked = null; runner.lastError = '';
  await new Promise((res) => setTimeout(res, 1500));
  startBot();
  return { ...r, started: true };
});
function lockFilesForBot() { const id = appIdFromToken(savedToken()); return id ? [path.join(os.tmpdir(), 'good-boy-locks', `${id}.lock`)] : []; }

// ---- share the dashboard: a public https link (Tailscale Funnel) for phones and other computers
const share = new Share();
const restartIfRunning = async () => { if (['running', 'starting'].includes(runner.status().state)) await runner.restart(); };
ipcMain.handle('gb:share-state', async () => {
  if (!bundled) return { state: 'unsupported' };
  try { const st = await share.status(folder.port); return { ...st, redirectUri, auto: settings.shareAuto, qr: st.state === 'on' ? await qrFor(st.url) : null }; } catch (e) { return { state: 'error', error: e.message }; }
});
/** Link is on: the dashboard uses it, Discord's Redirects get it, the bot restarts to pick it up if it changed. */
async function useSharedLink(url) {
  const changed = vault.setting('DASHBOARD_BASE_URL') !== url;
  vault.merge(shareSettings(url)); recheck();
  const added = await addRedirectUri(savedToken(), redirectUri);
  if (changed) await restartIfRunning();
  send('state', snapshot());
  return { ok: true, url, redirectUri, redirectAdded: added.ok, appId: knownAppId, qr: await qrFor(url) };
}
/** What the phone scans: the phone page; the Android app picks the link up from there. */
const phoneLink = (url) => `${url}/app?pair=1`;
const qrFor = (url) => QRCode.toDataURL(phoneLink(url), { margin: 1, width: 360, errorCorrectionLevel: 'M' }).catch(() => null);
ipcMain.handle('gb:share-on', async () => {
  if (!bundled) return { ok: false, error: 'Sharing works with the built-in bot.' };
  const r = await share.on(folder.port);
  if (!r.ok) return r;
  return useSharedLink(r.url);
});

/**
 * One button for everything: install Tailscale, sign in, allow Funnel, turn the link on, add it to Discord. Each step
 * is shown in the window as it happens; the steps that need the person (Windows' "allow", the sign-in page, the Funnel
 * approval) open by themselves and the setup carries on when they are done.
 */
let shareSetup = null;
/** Opens a page only when it is one of Tailscale's own (sign-in, Funnel approval, download). */
function openTailscale(link) { const u = String(link ?? ''); if (isTailscaleLink(u)) shell.openExternal(u); }
const step = (id, state, text, extra = {}) => send('share-step', { id, state, text, ...extra });
ipcMain.handle('gb:share-setup', async () => {
  if (!bundled) return { ok: false, error: 'Sharing works with the built-in bot.' };
  if (shareSetup) return shareSetup;
  shareSetup = (async () => {
    const port = folder.port;
    step('install', 'busy', 'Checking for Tailscale...');
    const inst = await share.install({ onStep: (t) => step('install', 'busy', t) });
    if (!inst.ok) { step('install', 'error', inst.error, { link: inst.link }); return inst; }
    step('install', 'done', 'Tailscale is installed.');

    let st = await share.status(port);
    if (st.state === 'stopped') { await share.waitFor(async () => (st = await share.status(port)).state !== 'stopped', { seconds: 30, every: 2000 }); }
    if (st.state === 'login') {
      step('login', 'busy', 'Sign in to Tailscale in your browser. Good Boy carries on when you are done.');
      const l = await share.login();
      openTailscale(l.link ?? st.link);
      const ok = await share.waitFor(async () => !['login', 'stopped'].includes((st = await share.status(port)).state), { seconds: 600 });
      if (!ok) { step('login', 'error', 'Sign-in did not finish. Press Set up to try again.'); return { ok: false, error: 'Tailscale sign-in did not finish.' }; }
    }
    if (st.state === 'error' || st.state === 'stopped') { step('login', 'error', st.error); return { ok: false, error: st.error }; }
    step('login', 'done', 'Signed in to Tailscale.');

    step('funnel', 'busy', 'Turning on your dashboard link...');
    let on = await share.on(port);
    if (!on.ok && on.state === 'approve') {
      step('funnel', 'busy', 'Approve public links for your Tailscale account in your browser. Good Boy carries on when you do.');
      openTailscale(on.link);
      await share.waitFor(async () => (on = await share.on(port)).ok || on.state !== 'approve', { seconds: 600, every: 5000 });
    }
    if (!on.ok) { step('funnel', 'error', on.error, { link: on.link }); return on; }
    step('funnel', 'done', `Your link: ${on.url}`);

    step('discord', 'busy', 'Adding the link to your bot\'s login Redirects...');
    const r = await useSharedLink(on.url);
    step('discord', r.redirectAdded ? 'done' : 'manual', r.redirectAdded ? 'Discord login works from the link.' : 'Discord needs you to add the link once (below).');
    settings = normalize({ ...settings, shareAuto: true }); saveSettings();
    step('phone', 'done', 'Scan the code with your phone.');
    return r;
  })().finally(() => { shareSetup = null; });
  return shareSetup;
});

/** At every start (and now and then) put the link back if it went off, without asking anything. */
async function keepShared() {
  if (!bundled || !settings.shareAuto) return;
  const st = await share.status(folder.port);
  if (st.state === 'on') { if (vault.setting('DASHBOARD_BASE_URL') !== st.url) await useSharedLink(st.url); return; }
  if (st.state !== 'off') { log(`share: ${st.state}`); return; }
  const r = await share.on(folder.port);
  if (r.ok) { await useSharedLink(r.url); log('share: dashboard link is on'); }
}

let awakeId = null;
function keepAwake(state) {
  const want = settings.keepAwake && ['running', 'starting'].includes(state);
  if (want && awakeId == null) awakeId = powerSaveBlocker.start('prevent-app-suspension');
  if (!want && awakeId != null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
}
ipcMain.handle('gb:share-off', async () => {
  if (!bundled) return { ok: false, error: 'Sharing works with the built-in bot.' };
  const r = await share.off();
  settings = normalize({ ...settings, shareAuto: false }); saveSettings();
  vault.merge(shareSettings(null)); recheck();
  await restartIfRunning();
  send('state', snapshot());
  return r;
});
ipcMain.handle('gb:share-link', (_e, link) => { const u = String(link ?? ''); if (!isTailscaleLink(u)) return false; shell.openExternal(u); return true; });

// ---- data: one file to move the bot's data between computers or keep as a backup
ipcMain.handle('gb:data-export', async () => {
  if (!bundled) return { ok: false, error: 'Export works with the built-in bot.' };
  const day = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog(win, { title: 'Save the bot\'s data', defaultPath: path.join(app.getPath('documents'), `good-boy-data-${day}.goodboy`), filters: [{ name: 'Good Boy data', extensions: ['goodboy'] }] });
  if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
  return runTool({ nodePath: nodePath(), botDir: botDir(), args: ['export', P.dataDir(), r.filePath] });
});
ipcMain.handle('gb:data-import', async () => {
  if (!bundled) return { ok: false, error: 'Import works with the built-in bot.' };
  const r = await dialog.showOpenDialog(win, { title: 'Choose a Good Boy data file', properties: ['openFile'], filters: [{ name: 'Good Boy data', extensions: ['goodboy', 'db'] }] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
  const ask = await dialog.showMessageBox(win, { type: 'question', title: 'Replace the bot\'s data?', message: 'Load this data file?', detail: 'The bot stops for a moment, the data it has now is backed up, and the file\'s data takes its place. Then the bot starts again.', buttons: ['Load it', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true });
  if (ask.response !== 0) return { ok: false, cancelled: true };
  const wasOn = ['running', 'starting'].includes(runner.status().state);
  await runner.stop();
  const out = await runTool({ nodePath: nodePath(), botDir: botDir(), args: ['import', r.filePaths[0], P.dataDir()] });
  if (wasOn) startBot();
  send('state', snapshot());
  return out;
});

// ---- levels only: a small file with just members' XP, and a merge that keeps the higher level for everyone
ipcMain.handle('gb:levels-export', async () => {
  if (!bundled) return { ok: false, error: 'Export works with the built-in bot.' };
  const day = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog(win, { title: 'Save the levels', defaultPath: path.join(app.getPath('documents'), `good-boy-levels-${day}.goodboy`), filters: [{ name: 'Good Boy data', extensions: ['goodboy'] }] });
  if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
  return runTool({ nodePath: nodePath(), botDir: botDir(), args: ['export-levels', P.dataDir(), r.filePath] });
});
ipcMain.handle('gb:levels-merge', async () => {
  if (!bundled) return { ok: false, error: 'Merging works with the built-in bot.' };
  const r = await dialog.showOpenDialog(win, { title: 'Choose a Good Boy file with levels', properties: ['openFile'], filters: [{ name: 'Good Boy data', extensions: ['goodboy'] }] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true };
  const ask = await dialog.showMessageBox(win, { type: 'question', title: 'Merge levels?', message: 'Add the levels from this file?', detail: 'Everyone keeps their higher level: members in the file who are behind here are raised, nobody goes down, and nothing else changes. The bot stops for a moment and your data is backed up first.', buttons: ['Merge levels', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true });
  if (ask.response !== 0) return { ok: false, cancelled: true };
  const wasOn = ['running', 'starting'].includes(runner.status().state);
  await runner.stop();
  const out = await runTool({ nodePath: nodePath(), botDir: botDir(), args: ['merge-levels', r.filePaths[0], P.dataDir()] });
  if (wasOn) startBot();
  send('state', snapshot());
  return out;
});

// ---- app updates from GitHub (see lib/updater.js)
const setU = (patch) => { Object.assign(U, { error: null }, patch); send('state', snapshot()); };
const friendlyUpdateError = (e) => {
  const m = String(e?.message ?? e).split('\n')[0];
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::|getaddrinfo|network/i.test(m)) return 'No internet connection right now.';
  return m.slice(0, 160);
};
const noReleaseYet = (e) => /404|Cannot find .*\.yml|No published versions|Unable to find latest version/i.test(String(e?.message ?? e));
async function initUpdates() {
  U.mode = updateMode({ packaged: app.isPackaged, platform: process.platform, portable: !!process.env.PORTABLE_EXECUTABLE_DIR, edition: edition.id, smoke: !!smokeDir });
  U.phase = U.mode === 'off' ? 'off' : 'idle';
  if (U.mode === 'off') return;
  if (U.mode === 'auto') {
    try {
      const { default: eu } = await import('electron-updater');
      autoUpdater = eu.autoUpdater;
      autoUpdater.channel = channelFor(edition.id);
      autoUpdater.allowDowngrade = false; autoUpdater.allowPrerelease = false;
      autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true; autoUpdater.logger = null;
      autoUpdater.on('checking-for-update', () => setU({ phase: 'checking' }));
      autoUpdater.on('update-available', (i) => setU({ phase: 'downloading', version: i?.version ?? null, percent: 0 }));
      autoUpdater.on('update-not-available', () => setU({ phase: 'current', checkedAt: Date.now() }));
      autoUpdater.on('download-progress', (p) => setU({ phase: 'downloading', percent: p?.percent ?? null }));
      autoUpdater.on('update-downloaded', (i) => { setU({ phase: 'ready', version: i?.version ?? U.version }); refreshTray(); scheduleRestart(); });
      autoUpdater.on('error', (e) => setU(noReleaseYet(e) ? { phase: 'none', checkedAt: Date.now() } : { phase: 'error', error: friendlyUpdateError(e) }));
    } catch (e) { log(`updater unavailable: ${e.message}`); autoUpdater = null; U.mode = 'notify'; }
  }
  setTimeout(() => checkUpdates().catch(() => {}), 15000).unref?.();
  setInterval(() => checkUpdates().catch(() => {}), 6 * 3600000).unref?.();
}
async function checkUpdates() {
  if (U.mode === 'off' || U.phase === 'downloading' || U.phase === 'ready') return U;
  if (autoUpdater) { await autoUpdater.checkForUpdates().catch((e) => setU(noReleaseYet(e) ? { phase: 'none', checkedAt: Date.now() } : { phase: 'error', error: friendlyUpdateError(e) })); return U; }
  setU({ phase: 'checking' });
  try {
    const r = await fetch(latestApi(), { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'GoodBoy-desktop' }, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) { setU({ phase: 'none', checkedAt: Date.now() }); return U; }
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const l = readLatest(await r.json(), app.getVersion());
    setU(l.newer ? { phase: 'available', version: l.version, url: l.url, checkedAt: Date.now() } : { phase: 'current', checkedAt: Date.now() });
  } catch (e) { setU({ phase: 'error', error: friendlyUpdateError(e) }); }
  return U;
}
ipcMain.handle('gb:update-check', () => checkUpdates());
ipcMain.handle('gb:update-open', () => { const u = U.url && U.url.startsWith('https://github.com/') ? U.url : releasesPage(); shell.openExternal(u); return true; });
// Once an update has downloaded, warn for a minute and then restart by itself to install it (the bot is stopped
// cleanly first and starts again with the app). "Later" puts it off; it then installs when the app is closed.
let restartTimer = null;
function scheduleRestart() {
  clearTimeout(restartTimer);
  const delay = restartPlan({ mode: U.mode, phase: U.phase, autoRestart: settings.autoRestartForUpdates, postponed: U.postponed });
  if (delay == null) { setU({ restartAt: null }); return; }
  setU({ restartAt: Date.now() + delay });
  try {
    if (Notification.isSupported()) new Notification({ title: `Good Boy ${U.version} is ready`, body: 'Good Boy restarts in 1 minute to finish the update. The bot is back online right after.' }).show();
  } catch { /* notifications are optional */ }
  restartTimer = setTimeout(() => { installUpdate().catch((e) => log(`automatic update restart failed: ${e.message}`)); }, delay);
  restartTimer.unref?.();
}
ipcMain.handle('gb:update-later', () => { clearTimeout(restartTimer); setU({ restartAt: null, postponed: true }); return true; });

async function installUpdate() {
  clearTimeout(restartTimer);
  if (!autoUpdater || U.phase !== 'ready') return { ok: false, error: 'No update is ready yet.' };
  quitting = true;
  await runner?.stop();
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return { ok: true };
}
ipcMain.handle('gb:update-install', () => installUpdate());

async function applySettings(patch) {
  const before = settings;
  settings = normalize({ ...settings, ...(patch && typeof patch === 'object' ? patch : {}) });
  saveSettings();
  if (settings.startAtLogin !== before.startAtLogin) app.setLoginItemSettings({ openAtLogin: settings.startAtLogin, args: settings.startAtLogin ? ['--hidden'] : [] });
  if (settings.botDir !== before.botDir || settings.nodePath !== before.nodePath) { await runner?.stop(); recheck(); }
  if (settings.autoRestartForUpdates !== before.autoRestartForUpdates && U.phase === 'ready') { U.postponed = false; scheduleRestart(); }
  send('state', snapshot());
  return snapshot();
}

app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('window-all-closed', () => { /* stay in the tray; quitting is explicit */ });
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  if (runner?.child) { e.preventDefault(); runner.stop().finally(() => app.quit()); }
});

log('waiting for app ready');
await app.whenReady();
log(`app ready (${edition.id}, ${bundled ? 'bundled bot' : 'folder mode'})`);
vault = new Vault(P.vault(), safeStorage);
loadSettings();
recheck();
createWindow();
log('window created');
createTray();
log('tray created');
setImmediate(() => { prepare(); initUpdates().catch((e) => log(`updates: ${e.message}`)); });
