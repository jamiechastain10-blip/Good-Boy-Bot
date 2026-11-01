/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Each entry runs once, in order. Append new entries to change the schema - never edit old ones.
const MIGRATIONS = [
  `
  CREATE TABLE guilds (id TEXT PRIMARY KEY, name TEXT, joined_at INTEGER);
  CREATE TABLE module_state (
    guild_id TEXT NOT NULL, module TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, version TEXT,
    PRIMARY KEY (guild_id, module)
  );
  CREATE TABLE module_config (
    guild_id TEXT NOT NULL, module TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
    PRIMARY KEY (guild_id, module, key)
  );
  CREATE TABLE module_data (
    guild_id TEXT NOT NULL, module TEXT NOT NULL, key TEXT NOT NULL, value TEXT,
    PRIMARY KEY (guild_id, module, key)
  );
  CREATE TABLE permissions (
    guild_id TEXT NOT NULL, perm_key TEXT NOT NULL, role_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, perm_key, role_id)
  );
  CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, guild_id TEXT, module TEXT,
    level TEXT NOT NULL, message TEXT NOT NULL
  );
  CREATE INDEX idx_logs_guild ON logs (guild_id, id);
  `,
  `
  CREATE TABLE notification_prefs (
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL, category TEXT NOT NULL, enabled INTEGER NOT NULL, updated_at INTEGER,
    PRIMARY KEY (guild_id, user_id, category)
  );
  CREATE TABLE module_migrations (module TEXT NOT NULL, id INTEGER NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (module, id));
  -- Suggestions moved from the support module into the unified voting system (engagement).
  INSERT OR IGNORE INTO module_data (guild_id, module, key, value)
    SELECT guild_id, 'engagement', key, value FROM module_data WHERE module = 'support' AND (key LIKE 'sugg:%' OR key = 'suggCounter');
  DELETE FROM module_data WHERE module = 'support' AND (key LIKE 'sugg:%' OR key = 'suggCounter');
  INSERT OR IGNORE INTO module_config (guild_id, module, key, value)
    SELECT guild_id, 'engagement', key, value FROM module_config WHERE module = 'support' AND key = 'suggestionChannel';
  DELETE FROM module_config WHERE module = 'support' AND key = 'suggestionChannel';
  `,
];

const likeEscape = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);
const parse = (s) => { if (s == null) return undefined; try { return JSON.parse(s); } catch { return undefined; } };

export class Database {
  constructor(file) {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.stmts = new Map();
    this.#migrate();
  }

  #migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)');
    const row = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get();
    let version = row ? Number(row.value) : 0;
    if (version < MIGRATIONS.length && version > 0) this.backup('pre-migration');
    for (; version < MIGRATIONS.length; version++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[version]);
        this.db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)").run(String(version + 1));
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw new Error(`Database migration ${version + 1} failed: ${err.message}`);
      }
    }
  }

  q(sql) {
    let s = this.stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); }
    return s;
  }

  // ---- guilds ----
  upsertGuild(id, name) {
    this.q('INSERT INTO guilds (id, name, joined_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name')
      .run(id, name ?? '', Date.now());
  }

  // ---- module state ----
  setModuleState(guildId, module, enabled, version) {
    this.q(`INSERT INTO module_state (guild_id, module, enabled, version) VALUES (?, ?, ?, ?)
            ON CONFLICT(guild_id, module) DO UPDATE SET enabled = excluded.enabled, version = excluded.version`)
      .run(guildId, module, enabled ? 1 : 0, version ?? null);
  }
  getModuleState(guildId, module) {
    const r = this.q('SELECT module, enabled, version FROM module_state WHERE guild_id = ? AND module = ?').get(guildId, module);
    return r ? { module: r.module, enabled: !!r.enabled, version: r.version } : undefined;
  }
  getModuleStates(guildId) {
    return this.q('SELECT module, enabled, version FROM module_state WHERE guild_id = ?').all(guildId)
      .map((r) => ({ module: r.module, enabled: !!r.enabled, version: r.version }));
  }

  // ---- config (dashboard / admin editable settings) ----
  getConfig(guildId, module, key) {
    return parse(this.q('SELECT value FROM module_config WHERE guild_id = ? AND module = ? AND key = ?').get(guildId, module, key)?.value);
  }
  getConfigAll(guildId, module) {
    const out = {};
    for (const r of this.q('SELECT key, value FROM module_config WHERE guild_id = ? AND module = ?').all(guildId, module)) out[r.key] = parse(r.value);
    return out;
  }
  setConfig(guildId, module, key, value) {
    this.q(`INSERT INTO module_config (guild_id, module, key, value) VALUES (?, ?, ?, ?)
            ON CONFLICT(guild_id, module, key) DO UPDATE SET value = excluded.value`)
      .run(guildId, module, key, JSON.stringify(value));
  }
  deleteConfig(guildId, module, key) {
    this.q('DELETE FROM module_config WHERE guild_id = ? AND module = ? AND key = ?').run(guildId, module, key);
  }

  // ---- module-private data (namespaced: a module can only ever address its own rows) ----
  dataGet(guildId, module, key) {
    return parse(this.q('SELECT value FROM module_data WHERE guild_id = ? AND module = ? AND key = ?').get(guildId, module, key)?.value);
  }
  dataSet(guildId, module, key, value) {
    this.q(`INSERT INTO module_data (guild_id, module, key, value) VALUES (?, ?, ?, ?)
            ON CONFLICT(guild_id, module, key) DO UPDATE SET value = excluded.value`)
      .run(guildId, module, key, JSON.stringify(value));
  }
  dataDelete(guildId, module, key) {
    this.q('DELETE FROM module_data WHERE guild_id = ? AND module = ? AND key = ?').run(guildId, module, key);
  }
  dataList(guildId, module, prefix = '', limit = 100000) {
    return this.q(`SELECT key, value FROM module_data WHERE guild_id = ? AND module = ? AND key LIKE ? ESCAPE '\\' ORDER BY key LIMIT ?`)
      .all(guildId, module, likeEscape(prefix) + '%', limit)
      .map((r) => ({ key: r.key, value: parse(r.value) }));
  }
  dataDeletePrefix(guildId, module, prefix) {
    this.q(`DELETE FROM module_data WHERE guild_id = ? AND module = ? AND key LIKE ? ESCAPE '\\'`).run(guildId, module, likeEscape(prefix) + '%');
  }
  /** Atomic read-modify-write (SQLite access is synchronous, so this cannot interleave). */
  dataUpdate(guildId, module, key, fn, fallback) {
    const current = this.dataGet(guildId, module, key);
    const next = fn(current === undefined ? fallback : current);
    this.dataSet(guildId, module, key, next);
    return next;
  }

  // ---- permissions ----
  permRoles(guildId, key) {
    return this.q('SELECT role_id FROM permissions WHERE guild_id = ? AND perm_key = ?').all(guildId, key).map((r) => r.role_id);
  }
  permAll(guildId) {
    const out = {};
    for (const r of this.q('SELECT perm_key, role_id FROM permissions WHERE guild_id = ?').all(guildId)) (out[r.perm_key] ??= []).push(r.role_id);
    return out;
  }
  permAdd(guildId, key, roleId) {
    this.q('INSERT OR IGNORE INTO permissions (guild_id, perm_key, role_id) VALUES (?, ?, ?)').run(guildId, key, roleId);
  }
  permRemove(guildId, key, roleId) {
    this.q('DELETE FROM permissions WHERE guild_id = ? AND perm_key = ? AND role_id = ?').run(guildId, key, roleId);
  }
  permClear(guildId, key) {
    this.q('DELETE FROM permissions WHERE guild_id = ? AND perm_key = ?').run(guildId, key);
  }

  // ---- logs ----
  addLog(guildId, module, level, message) {
    this.q('INSERT INTO logs (ts, guild_id, module, level, message) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), guildId ?? null, module ?? null, level, String(message).slice(0, 1500));
    // keep the table bounded
    if (Math.random() < 0.01) this.db.exec('DELETE FROM logs WHERE id < (SELECT MAX(id) FROM logs) - 5000');
  }
  recentLogs(guildId, limit = 100) {
    return this.q('SELECT ts, module, level, message FROM logs WHERE guild_id = ? ORDER BY id DESC LIMIT ?').all(guildId, limit);
  }

  // ---- transactions (nestable via savepoints) ----
  transaction(fn) {
    this.txDepth = this.txDepth ?? 0;
    const name = `sp${this.txDepth}`;
    this.db.exec(this.txDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
    this.txDepth++;
    try {
      const result = fn();
      this.txDepth--;
      this.db.exec(this.txDepth === 0 ? 'COMMIT' : `RELEASE ${name}`);
      return result;
    } catch (err) {
      this.txDepth--;
      this.db.exec(this.txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
      throw err;
    }
  }

  // ---- module-owned tables ----
  /**
   * Modules may declare `migrations: [{ id, sql }]`. Every object they create or touch must be
   * named `<module_name_with_underscores>_...` so a module can never alter core or other modules' tables.
   * Migrations are applied once, in order, each in its own transaction, after a backup.
   */
  static checkMigrationSql(moduleName, sql) {
    const prefix = moduleName.replace(/-/g, '_') + '_';
    if (/\b(ATTACH|DETACH|PRAGMA|load_extension)\b/i.test(sql)) throw new Error('forbidden statement in module migration');
    const names = [];
    const grab = (re) => { for (const m of sql.matchAll(re)) names.push(m[m.length - 1]); };
    grab(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi);
    grab(/ALTER\s+TABLE\s+(\w+)/gi);
    grab(/DROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)\s+(?:IF\s+EXISTS\s+)?(\w+)/gi);
    grab(/\bON\s+(\w+)\s*\(/gi);
    grab(/\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REFERENCES)\s+(\w+)/gi);
    const bad = names.filter((n) => !n.toLowerCase().startsWith(prefix));
    if (bad.length) throw new Error(`migration touches "${bad[0]}" - module tables must start with "${prefix}"`);
  }

  moduleMigrate(moduleName, migrations = []) {
    const pending = migrations.filter((m) => !this.q('SELECT 1 FROM module_migrations WHERE module = ? AND id = ?').get(moduleName, m.id));
    if (!pending.length) return 0;
    for (const m of pending) Database.checkMigrationSql(moduleName, m.sql);
    this.backup(`before-${moduleName}-migration`);
    for (const m of pending.sort((a, b) => a.id - b.id)) {
      this.transaction(() => {
        this.db.exec(m.sql);
        this.q('INSERT INTO module_migrations (module, id, applied_at) VALUES (?, ?, ?)').run(moduleName, m.id, Date.now());
      });
    }
    return pending.length;
  }

  // ---- notification preferences (user_id "*" = the server's default) ----
  getNotifyPref(guildId, userId, category) {
    const r = this.q('SELECT enabled FROM notification_prefs WHERE guild_id = ? AND user_id = ? AND category = ?').get(guildId, userId, category);
    return r ? !!r.enabled : undefined;
  }
  setNotifyPref(guildId, userId, category, enabled) {
    this.q(`INSERT INTO notification_prefs (guild_id, user_id, category, enabled, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(guild_id, user_id, category) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`)
      .run(guildId, userId, category, enabled ? 1 : 0, Date.now());
  }
  listNotifyPrefs(guildId, userId) {
    return this.q('SELECT category, enabled FROM notification_prefs WHERE guild_id = ? AND user_id = ?').all(guildId, userId);
  }

  // ---- backups ----
  backup(label = 'manual') {
    if (this.file === ':memory:') return null;
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    const dir = path.join(path.dirname(this.file), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const dest = path.join(dir, `goodboy-${stamp}-${label}.db`);
    fs.copyFileSync(this.file, dest);
    const all = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 10))) fs.rmSync(path.join(dir, old), { force: true });
    return dest;
  }

  close() { try { this.db.close(); } catch { /* ignore */ } }
}
