/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
// Reads a bot .env file into plain settings the app can keep in its encrypted vault. Pure functions, tested.

/** Settings that must never come from a .env file, because they would change how the app or Node itself runs. */
const BLOCKED = /^(NODE_|ELECTRON_|GOODBOY_(DATA|BASE)_DIR$|GOODBOY_SUPERVISED$|PATH$|PATHEXT$|COMSPEC$|SYSTEMROOT$|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$|TEMP$|TMP$|LD_|DYLD_)/i;

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

/** Only ordinary bot settings, uppercase names, sane lengths. */
export function safeBotSettings(map) {
  const out = {};
  for (const [k, v] of Object.entries(map ?? {})) {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(k) || BLOCKED.test(k)) continue;
    if (typeof v !== 'string' || v.length > 4096 || /[\r\n\0]/.test(v)) continue;
    out[k] = v;
  }
  return out;
}

/** A Discord bot token has three dot-separated parts. This only checks the shape, never the value with Discord. */
export const looksLikeToken = (t) => /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/.test(String(t ?? '').trim());
