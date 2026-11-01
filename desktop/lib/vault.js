/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
// The app's secret store: the bot token and other .env settings, encrypted by the operating system
// (Windows: DPAPI, macOS: Keychain) through Electron's safeStorage. Never written in plain text.
import fs from 'node:fs';
import path from 'node:path';
import { safeBotSettings } from './envfile.js';

export class Vault {
  /** crypto: { isEncryptionAvailable(), encryptString(s) -> Buffer, decryptString(Buffer) -> string } (Electron safeStorage) */
  constructor(file, crypto) { this.file = file; this.crypto = crypto; }
  available() { try { return !!this.crypto?.isEncryptionAvailable(); } catch { return false; } }
  read() {
    try {
      if (!fs.existsSync(this.file) || !this.available()) return {};
      return safeBotSettings(JSON.parse(this.crypto.decryptString(fs.readFileSync(this.file))));
    } catch { return {}; }
  }
  write(map) {
    if (!this.available()) throw new Error('This computer cannot encrypt saved secrets, so the token was not saved.');
    const clean = safeBotSettings(map);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, this.crypto.encryptString(JSON.stringify(clean)), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return clean;
  }
  merge(patch) { return this.write({ ...this.read(), ...patch }); }
  has(key) { return !!this.read()[key]; }
  /** A plain setting (never a token, secret, key or password). */
  setting(key) { return /TOKEN|SECRET|KEY|PASSWORD/i.test(key) ? undefined : this.read()[key]; }
  /** What the window may see: which settings exist, never their values. */
  describe() { const m = this.read(); return { hasToken: !!m.DISCORD_TOKEN, hasClientSecret: !!m.DISCORD_CLIENT_SECRET, keys: Object.keys(m).filter((k) => !/TOKEN|SECRET|KEY|PASSWORD/i.test(k)).sort() }; }
}

/** A small encrypted JSON file for things that are not bot settings (the licence signing key). Same OS encryption. */
export class SecretFile {
  constructor(file, crypto) { this.file = file; this.crypto = crypto; }
  available() { try { return !!this.crypto?.isEncryptionAvailable(); } catch { return false; } }
  read() { try { return fs.existsSync(this.file) && this.available() ? JSON.parse(this.crypto.decryptString(fs.readFileSync(this.file))) : null; } catch { return null; } }
  write(obj) {
    if (!this.available()) throw new Error('This computer cannot encrypt saved secrets.');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, this.crypto.encryptString(JSON.stringify(obj)), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}
