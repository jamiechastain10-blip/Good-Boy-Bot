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
 *   export-levels <dataDir> <file>   a small .goodboy file with ONLY members' XP and message counts
 *   merge-levels <file> <dataDir>    add the levels from a .goodboy file (levels-only or a full one) to the bot's data:
 *                            each member keeps the higher XP and message count, nothing else changes. The bot
 *                            must be stopped first (the desktop app does that); a backup is made.
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
    if (exportKind(src) === 'levels') throw new Error('That file only holds levels. Use "Merge levels" instead, so the rest of your data is kept.');
    src.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } catch (e) {
    fs.rmSync(dest, { force: true });
    if (backup) fs.copyFileSync(backup, dest); // put the old data back
    throw e;
  } finally { src.close(); }
  const s = await summary(dataDir);
  return { ok: true, dest, backup, guild: s.guild, memberCount: s.memberCount };
}

const exportKind = (db) => { try { return db.prepare("SELECT value FROM goodboy_export WHERE key = 'kind'").get()?.value ?? 'full'; } catch { return 'full'; } };
const parseRow = (v) => { try { return JSON.parse(v) ?? {}; } catch { return {}; } };

/** A small .goodboy file with only levels: the server, and each member's XP and message count. */
export async function exportLevels(dataDir, destFile) {
  const src = path.join(dataDir, 'eclipse.db');
  if (!fs.existsSync(src)) throw new Error('There is no bot data yet to export.');
  const from = await openReadOnly(src);
  let guild, rows;
  try {
    checkGoodBoyDb(from);
    guild = from.prepare('SELECT id, name FROM guilds LIMIT 1').get();
    if (!guild) throw new Error('The bot has not joined a server yet, so there are no levels to export.');
    rows = from.prepare("SELECT key, value FROM module_data WHERE guild_id = ? AND module = 'community' AND key LIKE 'user:%'").all(guild.id)
      .map((r) => { const v = parseRow(r.value); return { key: r.key, xp: Math.max(0, Number(v.xp) || 0), messages: Math.max(0, Number(v.messages) || 0) }; })
      .filter((r) => r.xp > 0 || r.messages > 0);
  } finally { from.close(); }
  if (fs.existsSync(destFile)) fs.rmSync(destFile);
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const out = new DatabaseSync(destFile);
  try {
    // The same core tables as a full file (so it is recognised), holding only what levels need.
    out.exec(`CREATE TABLE guilds (id TEXT PRIMARY KEY, name TEXT, joined_at INTEGER);
              CREATE TABLE module_state (guild_id TEXT, module TEXT, enabled INTEGER, version TEXT, PRIMARY KEY (guild_id, module));
              CREATE TABLE module_data (guild_id TEXT, module TEXT, key TEXT, value TEXT, PRIMARY KEY (guild_id, module, key));
              CREATE TABLE goodboy_export (key TEXT PRIMARY KEY, value TEXT);`);
    out.prepare('INSERT INTO guilds (id, name, joined_at) VALUES (?, ?, ?)').run(guild.id, guild.name, Date.now());
    const put = out.prepare("INSERT INTO module_data (guild_id, module, key, value) VALUES (?, 'community', ?, ?)");
    for (const r of rows) put.run(guild.id, r.key, JSON.stringify({ xp: r.xp, messages: r.messages }));
    out.prepare("INSERT INTO goodboy_export (key, value) VALUES ('kind', 'levels'), ('exportedAt', ?)").run(String(Date.now()));
  } finally { out.close(); }
  return { ok: true, file: destFile, bytes: fs.statSync(destFile).size, guild, memberCount: rows.filter((r) => r.xp > 0).length };
}

/**
 * Adds levels from a .goodboy file to the bot's data. Each member keeps the HIGHER XP and message count, so merging
 * the same file twice changes nothing and nobody loses progress. Works with levels-only and full files. If the file
 * is from another server, its levels go to the bot's server (moving a community to a new server is the main use).
 */
export async function mergeLevels(srcFile, dataDir) {
  if (!fs.existsSync(srcFile)) throw new Error(`There is no file at ${srcFile}.`);
  const dest = path.join(dataDir, 'eclipse.db');
  if (!fs.existsSync(dest)) throw new Error('Start the bot once first, so there is data to merge the levels into.');
  const from = await openReadOnly(srcFile);
  let incoming;
  try {
    checkGoodBoyDb(from);
    const g = from.prepare('SELECT id FROM guilds LIMIT 1').get();
    incoming = g ? from.prepare("SELECT key, value FROM module_data WHERE guild_id = ? AND module = 'community' AND key LIKE 'user:%'").all(g.id) : [];
  } finally { from.close(); }
  const { DatabaseSync } = await import('node:sqlite');
  const backup = path.join(dataDir, `eclipse.before-merge-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  { const live = new DatabaseSync(dest, { readOnly: true }); try { live.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`); } finally { live.close(); } }
  const db = new DatabaseSync(dest);
  let added = 0, raised = 0, unchanged = 0, guild;
  try {
    checkGoodBoyDb(db);
    guild = db.prepare('SELECT id, name FROM guilds LIMIT 1').get();
    if (!guild) throw new Error('The bot has not joined a server yet, so there is nowhere to put the levels.');
    const get = db.prepare("SELECT value FROM module_data WHERE guild_id = ? AND module = 'community' AND key = ?");
    const set = db.prepare(`INSERT INTO module_data (guild_id, module, key, value) VALUES (?, 'community', ?, ?)
                            ON CONFLICT(guild_id, module, key) DO UPDATE SET value = excluded.value`);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of incoming) {
        if (!/^user:\d{17,20}$/.test(r.key)) continue;
        const v = parseRow(r.value), xp = Math.max(0, Number(v.xp) || 0), messages = Math.max(0, Number(v.messages) || 0);
        if (!xp && !messages) continue;
        const cur = get.get(guild.id, r.key);
        if (!cur) { set.run(guild.id, r.key, JSON.stringify({ xp, messages, rep: 0, lastXp: 0, lastRep: 0 })); added++; continue; }
        const old = parseRow(cur.value);
        const next = { ...old, xp: Math.max(Number(old.xp) || 0, xp), messages: Math.max(Number(old.messages) || 0, messages) };
        if (next.xp === (Number(old.xp) || 0) && next.messages === (Number(old.messages) || 0)) { unchanged++; continue; }
        set.run(guild.id, r.key, JSON.stringify(next)); raised++;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally { db.close(); }
  return { ok: true, guild, added, raised, unchanged, backup };
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
    else if (cmd === 'export-levels') out(await exportLevels(a, b));
    else if (cmd === 'merge-levels') out(await mergeLevels(a, b));
    else { out({ ok: false, error: 'Use: selftest | summary <dataDir> | import <dbFile> <dataDir> | export <dataDir> <file> | export-levels <dataDir> <file> | merge-levels <file> <dataDir>' }); process.exitCode = 2; }
  } catch (e) { out({ ok: false, error: e.message }); process.exitCode = 1; }
}
