/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
// The desktop app's own settings (not the bot's). Pure functions so they can be tested without Electron.
export const DEFAULTS = Object.freeze({
  nodePath: '',            // full path to node (blank = look it up). A packaged app often cannot see the terminal's PATH.
  botDir: '',              // folder that holds the Good Boy files (the one with package.json and .env)
  startBotWithApp: true,   // start the bot when the app opens
  startAtLogin: false,     // open the app when you sign in to the computer
  closeAction: 'minimize', // 'minimize' = the X hides to the tray, 'quit' = the X quits (and stops the bot)
  dashboardOnStart: false, // open the dashboard in your browser once the bot is running
  setupComplete: false,    // the first-run setup was finished
  license: '',             // a licence key someone was given (checked every start; not a secret)
  brandApplied: null,      // picture IDs Discord returned when the Good Boy look was applied
  theme: 'system',         // 'system' follows Windows/macOS light or dark
});
const CLOSE = ['minimize', 'quit'];
const THEMES = ['system', 'light', 'dark'];

/** Turn whatever is on disk (or from the window) into a complete, safe settings object. Unknown keys are dropped. */
export function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  return {
    nodePath: typeof r.nodePath === 'string' && /(^|[\\/])node(\.exe)?$/i.test(r.nodePath.trim()) ? r.nodePath.trim().slice(0, 1024) : DEFAULTS.nodePath,
    botDir: typeof r.botDir === 'string' ? r.botDir.trim().slice(0, 1024) : DEFAULTS.botDir,
    startBotWithApp: bool(r.startBotWithApp, DEFAULTS.startBotWithApp),
    startAtLogin: bool(r.startAtLogin, DEFAULTS.startAtLogin),
    closeAction: CLOSE.includes(r.closeAction) ? r.closeAction : DEFAULTS.closeAction,
    dashboardOnStart: bool(r.dashboardOnStart, DEFAULTS.dashboardOnStart),
    setupComplete: bool(r.setupComplete, DEFAULTS.setupComplete),
    license: typeof r.license === 'string' && r.license.length <= 2048 && /^[A-Za-z0-9._-]*$/.test(r.license.trim()) ? r.license.trim() : DEFAULTS.license,
    brandApplied: r.brandApplied && typeof r.brandApplied === 'object' ? Object.fromEntries(['avatar', 'banner', 'icon'].map((k) => [k, typeof r.brandApplied[k] === 'string' && /^[a-z0-9_]{1,64}$/i.test(r.brandApplied[k]) ? r.brandApplied[k] : null])) : DEFAULTS.brandApplied,
    theme: THEMES.includes(r.theme) ? r.theme : DEFAULTS.theme,
  };
}
