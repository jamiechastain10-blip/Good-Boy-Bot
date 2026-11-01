/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
// The bot ships inside the app (read-only). It is copied to a writable folder so the bot's own updater can work,
// and refreshed only when the app brings a different version. The bot's data lives in a separate folder and is never
// touched here.
import fs from 'node:fs';
import path from 'node:path';

const MARK = '.bundled-version';
const versionOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { return null; } };

export function installedVersion(dest) { try { return fs.readFileSync(path.join(dest, MARK), 'utf8').trim(); } catch { return null; } }

/** Returns { action: 'none'|'installed'|'updated', version }. Copies to a temp folder first so a failure never leaves half a bot. */
export function ensureBotCode(src, dest, fsx = fs) {
  const want = versionOf(src);
  if (!want) throw new Error('The bot is missing from this app. Please reinstall Good Boy.');
  const have = installedVersion(dest);
  if (have === want && fsx.existsSync(path.join(dest, 'src', 'index.js'))) return { action: 'none', version: want };
  const tmp = `${dest}.incoming`;
  fsx.rmSync(tmp, { recursive: true, force: true });
  fsx.cpSync(src, tmp, { recursive: true });
  fsx.writeFileSync(path.join(tmp, MARK), want);
  // Keep the bot's own downloaded updates (releases/ and current.json) when refreshing the bundled code.
  for (const keep of ['releases', 'current.json', 'downloads', 'backups']) {
    if (fsx.existsSync(path.join(dest, keep)) && !fsx.existsSync(path.join(tmp, keep))) fsx.renameSync(path.join(dest, keep), path.join(tmp, keep));
  }
  fsx.rmSync(dest, { recursive: true, force: true });
  fsx.renameSync(tmp, dest);
  return { action: have ? 'updated' : 'installed', version: want };
}

/** Put the owner's server data in place on first run only. Never overwrites existing data. */
export function seedData(seedFile, dataDir, fsx = fs) {
  const dest = path.join(dataDir, 'eclipse.db');
  if (!seedFile || !fsx.existsSync(seedFile) || fsx.existsSync(dest)) return false;
  fsx.mkdirSync(dataDir, { recursive: true });
  fsx.copyFileSync(seedFile, dest);
  return true;
}
