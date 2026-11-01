/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Helper the desktop app runs with its bundled Node. It reads the bot's database (never writes to a live one) and
 * prints one line of JSON. Commands:
 *   selftest                 can this Node run the bot? (built-in SQLite, discord.js, optional image support)
 *   summary <dataDir>        server name, members with XP and their levels, modules on or off
 *   import <dbFile> <dataDir> copy a database (including its -wal side file) into dataDir as one clean file,
 *                            keeping a backup of what was there
 *   export <dataDir> <file>  write the bot's data as one file (a .goodboy data file) that import can read back,
 *                            safe while the bot is running
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); };

// Same curve as the community module (tests check they agree).
const need = (level) => 5 * level * level + 50 * level + 100;
export function levelOf(totalXp) {
  let level = 0, rem = Math.max(0, Number(totalXp) || 0);
  while (level < 1000 && rem >= need(level)) { rem -= need(level); level++; }
  return { level, into: rem, needed: need(level) };
}

async function openReadOnly(file) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

export async function summary(dataDir, { top = 50 } = {}) {
  const file = path.join(dataDir, 'eclipse.db');
  if (!fs.existsSync(file)) return { ok: true, empty: true, guilds: [], members: [], modules: [] };
  const db = await openReadOnly(file);
  try {
    const guilds = db.prepare('SELECT id, name FROM guilds').all().map((g) => ({ id: g.id, name: g.name }));
    const gid = guilds[0]?.id ?? null;
    const rows = gid ? db.prepare("SELECT key, value FROM module_data WHERE guild_id = ? AND module = 'community' AND key LIKE 'user:%'").all(gid) : [];
    const members = rows.map((r) => {
      let v = {}; try { v = JSON.parse(r.value); } catch { /* skip bad row */ }
      const xp = Number(v.xp) || 0;
      return { id: r.key.slice(5), xp, messages: Number(v.messages) || 0, rep: Number(v.rep) || 0, ...levelOf(xp) };
    }).filter((m) => m.xp > 0).sort((a, b) => b.xp - a.xp);
    const modules = gid ? db.prepare('SELECT module, enabled FROM module_state WHERE guild_id = ? ORDER BY module').all(gid).map((m) => ({ name: m.module, enabled: !!m.enabled })) : [];
    return { ok: true, empty: false, guilds, guild: guilds[0] ?? null, memberCount: members.length, members: members.slice(0, top), modules };
  } finally { db.close(); }
}

/** Refuses anything that is not a healthy Good Boy database (a random file renamed .db, or a damaged one). */
function checkGoodBoyDb(db) {
  let tables;
  try { tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name)); }
  catch { throw new Error('That file is not a Good Boy data file.'); }
  if (!['guilds', 'module_state', 'module_data'].every((t) => tables.has(t))) throw new Error('That file is not a Good Boy data file.');
  const ok = db.prepare('PRAGMA integrity_check').get();
  if (Object.values(ok)[0] !== 'ok') throw new Error('That data file is damaged (it failed its integrity check), so nothing was changed.');
}

/** The bot's data as one file. Reads a consistent snapshot, so the bot can keep running. */
export async function exportDb(dataDir, destFile) {
  const src = path.join(dataDir, 'eclipse.db');
  if (!fs.existsSync(src)) throw new Error('There is no bot data yet to export.');
  if (fs.existsSync(destFile)) fs.rmSync(destFile);
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(src, { readOnly: true });
  try { checkGoodBoyDb(db); db.exec(`VACUUM INTO '${destFile.replace(/'/g, "''")}'`); } finally { db.close(); }
  const s = await summary(dataDir);
  return { ok: true, file: destFile, bytes: fs.statSync(destFile).size, guild: s.guild, memberCount: s.memberCount };
}

/** One clean copy of a database, WAL changes included. The source is opened read-only and never changed. */
export async function importDb(srcFile, dataDir) {
  if (!fs.existsSync(srcFile)) throw new Error(`There is no database at ${srcFile}.`);
  fs.mkdirSync(dataDir, { recursive: true });
  const dest = path.join(dataDir, 'eclipse.db');
  let backup = null;
  if (fs.existsSync(dest)) {
    backup = path.join(dataDir, `eclipse.before-import-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    fs.copyFileSync(dest, backup);
    for (const s of ['-wal', '-shm']) fs.rmSync(dest + s, { force: true });
    fs.rmSync(dest);
  }
  // Read-only connections cannot write, but VACUUM INTO only writes the NEW file, which is what we want.
  const { DatabaseSync } = await import('node:sqlite');
  const src = new DatabaseSync(srcFile, { readOnly: true });
  try {
    checkGoodBoyDb(src);
    src.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } catch (e) {
    fs.rmSync(dest, { force: true });
    if (backup) fs.copyFileSync(backup, dest); // put the old data back
    throw e;
  } finally { src.close(); }
  const s = await summary(dataDir);
  return { ok: true, dest, backup, guild: s.guild, memberCount: s.memberCount };
}

export async function selftest() {
  const r = { ok: false, node: process.versions.node, platform: process.platform, sqlite: false, discord: false, canvas: false, voice: false };
  try { await import('node:sqlite'); r.sqlite = true; } catch (e) { r.sqliteError = e.message; }
  try { const d = await import('discord.js'); r.discord = typeof d.Client === 'function'; r.discordVersion = d.version ?? null; } catch (e) { r.discordError = e.message; }
  try { await import('@napi-rs/canvas'); r.canvas = true; } catch { /* optional */ }
  try { await import('@discordjs/voice'); r.voice = true; } catch { /* optional */ }
  try { r.version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch { /* ignore */ }
  r.ok = r.sqlite && r.discord;
  return r;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'selftest') out(await selftest());
    else if (cmd === 'summary') out(await summary(a));
    else if (cmd === 'import') out(await importDb(a, b));
    else if (cmd === 'export') out(await exportDb(a, b));
    else { out({ ok: false, error: 'Use: selftest | summary <dataDir> | import <dbFile> <dataDir> | export <dataDir> <file>' }); process.exitCode = 2; }
  } catch (e) { out({ ok: false, error: e.message }); process.exitCode = 1; }
}
