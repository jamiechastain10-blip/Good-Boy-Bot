/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * The Core never contains feature logic. It discovers module folders, validates them,
 * moves them through a lifecycle per server, routes Discord events/commands/components
 * to whichever modules are enabled in that server, and isolates their failures.
 *
 * Module code is TRUSTED: it runs in this process with full access to discord.js.
 * Only install modules you wrote or have reviewed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { logger } from './logger.js';
import { UserError, SNOWFLAKE } from './util.js';
import { Notifications } from './notifications.js';
import { Database } from './db.js';
import { CORE_PERMISSIONS } from './permissions.js';
import { loadSecret, packToken } from './modalpipe.js';
import * as AP from './autopopup.js';
import { publish } from './live.js';

export const EPHEMERAL = 64; // MessageFlags.Ephemeral

/** Events modules may subscribe to, and how to find which guild an event belongs to. */
export const EVENT_GUILD = {
  guildMemberAdd: (m) => m.guild?.id,
  guildMemberRemove: (m) => m.guild?.id,
  guildMemberUpdate: (o, n) => n?.guild?.id ?? o?.guild?.id,
  messageCreate: (m) => m.guildId,
  messageDelete: (m) => m.guildId,
  messageDeleteBulk: (msgs, ch) => ch?.guild?.id,
  messageUpdate: (o, n) => n?.guildId ?? o?.guildId,
  messageReactionAdd: (r) => r.message?.guildId,
  messageReactionRemove: (r) => r.message?.guildId,
  presenceUpdate: (o, n) => n?.guild?.id,
  voiceStateUpdate: (o, n) => n?.guild?.id,
  channelDelete: (c) => c.guild?.id,
  roleDelete: (r) => r.guild?.id,
  guildBanAdd: (b) => b.guild?.id,
  guildAuditLogEntryCreate: (e, g) => g?.id,
  inviteCreate: (inv) => inv.guild?.id, // 3.1: invite tracking
  inviteDelete: (inv) => inv.guild?.id,
};

const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const LEVELS = ['everyone', 'moderator', 'admin', 'owner'];
const SETTING_TYPES = ['toggle', 'text', 'number', 'channel', 'role', 'select', 'list'];
const LIFECYCLE_TIMEOUT = 30000;

export class RequirementError extends UserError {
  constructor(message) { super(message); this.code = 'REQUIREMENT'; }
}

const OFF_KEY = '__offChannels';
const NEVER_OFF_HERE = new Set(['moderation', 'support', 'support-html-transcripts']);
/** Events that happen in a channel: where they happened, for the per-channel switch. */
const msgWhere = (m) => m?.channel ?? (m?.channelId ? { id: m.channelId } : null);
const CHANNEL_EVENTS = {
  messageCreate: msgWhere, messageUpdate: (o, n) => msgWhere(n ?? o), messageDelete: msgWhere,
  messageReactionAdd: (r) => msgWhere(r?.message), messageReactionRemove: (r) => msgWhere(r?.message),
};
export const cmdJson = (c) => (typeof c?.data?.toJSON === 'function' ? c.data.toJSON() : c?.data);


/** Mirrors Discord's rules so a bad command is rejected at load time with a clear message, not at registration. */
function checkCommandShape(j, fail) {
  const isChat = j.type === undefined || j.type === 1;
  if (typeof j.name !== 'string' || !j.name) fail('every command needs a name');
  if (isChat && !/^[\p{Ll}\p{Lo}\p{N}_-]{1,32}$/u.test(j.name)) fail(`command name "${j.name}" must be 1-32 lowercase letters, numbers, - or _`);
  if (isChat && !(j.description && j.description.length <= 100)) fail(`command "/${j.name}" needs a description of 1-100 characters`);
  const walk = (opts, label) => {
    opts = opts ?? [];
    if (opts.length > 25) fail(`${label} has more than 25 options`);
    const hasSub = opts.some((o) => o.type === 1 || o.type === 2);
    if (hasSub && opts.some((o) => o.type !== 1 && o.type !== 2)) fail(`${label} mixes subcommands with plain options (Discord forbids that)`);
    if (!hasSub) {
      let optional = false;
      for (const o of opts) {
        if (o.required) { if (optional) fail(`${label}: required option "${o.name}" must come before optional ones`); }
        else optional = true;
      }
    }
    for (const o of opts) {
      if (o.type === 1 || o.type === 2) walk(o.options, `${label} ${o.name}`);
      if (o.type === 2 && (o.options ?? []).some((x) => x.type !== 1)) fail(`${label} ${o.name}: groups may only contain subcommands`);
    }
  };
  walk(j.options, `/${j.name}`);
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

export class ModuleManager {
  constructor({ db, perms, queue, builtins = [], log = logger, dataDir = null }) {
    this.db = db;
    /** Where modules keep files (ticket archives). Tests without one get a temporary folder. */
    this.dataDir = dataDir ?? process.env.GOODBOY_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'goodboy-data-'));
    this.perms = perms;
    this.queue = queue;
    this.log = log;
    this.builtins = new Map(builtins.map((b) => [cmdJson(b).name, b]));
    this.defs = new Map();       // name -> { def, dir }
    this.loadErrors = new Map(); // folder -> message
    this.active = new Map();     // guildId -> Map(name -> def)
    this.health = new Map();     // name -> { errors: [ts], last, lastRecovery }
    this.ctxCache = new Map();
    this.lastTask = new Map();
    this.runningTasks = new Set();
    this.syncTimers = new Map();
    this.backedUp = new Set();
    this.client = null;
    this.intents = new Set();
    this.ownerIds = new Set();
    this.taskTimer = null;
    this.importSeq = 0;
    this.notifications = new Notifications(db);
    this.syncStatus = new Map();   // guildId -> { ok, at, count, failed[], bulkError }
    this.seenInteractions = new Map();
    loadSecret(db); // popup tokens (src/modalpipe.js) are signed with a key that survives restarts
  }

  attach(client, intents = []) { this.client = client; this.intents = new Set(intents); }
  isBotOwner(userId) { return this.ownerIds.has(userId); }

  // ------------------------------------------------------------------ discovery & validation
  async discover(dir) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const full = path.join(dir, ent.name);
      if (!fs.existsSync(path.join(full, 'index.js'))) continue;
      try {
        this.#register(await this.#importDef(full), full);
        this.loadErrors.delete(ent.name);
      } catch (err) {
        this.loadErrors.set(ent.name, err.message);
        this.log.error(`Module "${ent.name}" failed to load and was skipped: ${err.message}`);
      }
    }
  }

  /**
   * Load modules from `dir` that are not loaded yet (used when someone adds a module while the bot runs).
   * Modules already loaded are left alone. Returns { added: [names], errors: {folder: message} }.
   */
  async loadNew(dir) {
    const added = [], errors = {};
    if (!fs.existsSync(dir)) return { added, errors };
    const loadedDirs = new Set([...this.defs.values()].map((r) => path.resolve(r.dir)));
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (!ent.isDirectory() || loadedDirs.has(path.resolve(full)) || !fs.existsSync(path.join(full, 'index.js'))) continue;
      try { const def = await this.#importDef(full); this.#register(def, full); this.loadErrors.delete(ent.name); added.push(def.name); }
      catch (err) { errors[ent.name] = err.message; this.loadErrors.set(ent.name, err.message); }
    }
    return { added, errors };
  }

  /** Check a module folder the way loading would, without loading it. Returns { ok, name, version, description, commands } or { ok:false, error }. */
  async inspect(dir) {
    try {
      const def = await this.#importDef(dir);
      if (this.defs.has(def.name)) return { ok: false, error: `A module called "${def.name}" is already installed.`, name: def.name };
      for (const c of def.commands ?? []) {
        const name = cmdJson(c).name;
        if (this.builtins.has(name)) return { ok: false, error: `Its command /${name} is reserved by Good Boy.` };
        for (const [other, rec] of this.defs) if ((rec.def.commands ?? []).some((x) => cmdJson(x).name === name)) return { ok: false, error: `Its command /${name} is already used by "${other}".` };
      }
      for (const m of def.migrations ?? []) Database.checkMigrationSql(def.name, m.sql);
      return { ok: true, name: def.name, version: def.version, description: def.description ?? '', commands: (def.commands ?? []).map((c) => cmdJson(c).name) };
    } catch (err) { return { ok: false, error: err.message }; }
  }

  async #importDef(dir) {
    const mod = await import(pathToFileURL(path.join(dir, 'index.js')).href + `?v=${Date.now()}-${++this.importSeq}`);
    const def = mod.default;
    if (!def || typeof def !== 'object') throw new Error('index.js must export a default module object');
    this.validate(def, path.basename(dir));
    return def;
  }

  validate(def, folder) {
    const fail = (m) => { throw new Error(`${def?.name ?? folder}: ${m}`); };
    if (!NAME_RE.test(def.name ?? '')) fail('name must be lowercase letters, numbers and dashes');
    if (folder && def.name !== folder) fail(`name must match its folder name "${folder}"`);
    if (!semver.valid(def.version)) fail('version must be valid semver, e.g. 1.0.0');
    def.type ??= 'module';
    if (!['module', 'addon'].includes(def.type)) fail('type must be "module" or "addon"');
    if (def.type === 'addon') {
      const r = def.requires;
      if (!r || !NAME_RE.test(r.module ?? '') || !semver.validRange(r.version)) fail('add-ons must declare requires: { module, version }');
    }
    for (const d of def.dependencies ?? []) if (!NAME_RE.test(d.module ?? '') || !semver.validRange(d.version)) fail('invalid dependency entry');

    const keys = new Set();
    for (const s of def.settings ?? []) {
      if (!KEY_RE.test(s.key ?? '')) fail(`invalid setting key "${s.key}"`);
      if (keys.has(s.key)) fail(`duplicate setting key "${s.key}"`);
      keys.add(s.key);
      if (!SETTING_TYPES.includes(s.type)) fail(`setting "${s.key}" has unknown type "${s.type}"`);
      if (!s.label) fail(`setting "${s.key}" needs a label`);
      if (s.type === 'select' && !(Array.isArray(s.options) && s.options.length)) fail(`select setting "${s.key}" needs options`);
    }
    const permKeys = new Set();
    for (const p of def.permissions ?? []) {
      if (!String(p.key).startsWith(def.name + '.')) fail(`permission "${p.key}" must start with "${def.name}."`);
      if (!LEVELS.includes(p.default ?? 'admin')) fail(`permission "${p.key}" has invalid default level`);
      permKeys.add(p.key);
    }
    const cmdNames = new Set();
    for (const c of def.commands ?? []) {
      const j = cmdJson(c);
      if (!j?.name || typeof j.name !== 'string') fail('every command needs data with a name');
      checkCommandShape(j, fail);
      if (cmdNames.has(j.name)) fail(`duplicate command "${j.name}"`);
      cmdNames.add(j.name);
      if (typeof c.execute !== 'function') fail(`command "${j.name}" needs an execute function`);
      if (c.permission && !permKeys.has(c.permission)) fail(`command "${j.name}" uses undeclared permission "${c.permission}"`);
    }
    for (const [ev, fn] of Object.entries(def.events ?? {})) {
      if (!EVENT_GUILD[ev]) fail(`unsupported event "${ev}"`);
      if (typeof fn !== 'function') fail(`event "${ev}" must be a function`);
    }
    for (const c of def.components ?? []) if (!c.prefix || typeof c.execute !== 'function') fail('components need a prefix and execute function');
    for (const t of def.tasks ?? []) if (!t.name || !(t.everyMs >= 10000) || typeof t.run !== 'function') fail('tasks need a name, everyMs >= 10000 and a run function');
    if (def.migrations !== undefined) {
      if (!Array.isArray(def.migrations)) fail('migrations must be an array');
      const ids = new Set();
      for (const m of def.migrations) {
        if (!Number.isInteger(m?.id) || m.id < 1 || typeof m.sql !== 'string' || ids.has(m.id)) fail('each migration needs a unique integer id and an sql string');
        ids.add(m.id);
        try { Database.checkMigrationSql(def.name, m.sql); } catch (e) { fail(e.message); }
      }
    }
    for (const [kind, obj] of [['actions', def.actions], ['views', def.views]]) {
      if (obj === undefined) continue;
      if (typeof obj !== 'object' || Object.entries(obj).some(([k, f]) => !KEY_RE.test(k.replace(/-/g, '_')) || typeof f !== 'function')) fail(`${kind} must be an object of named functions`);
    }
    for (const pn of def.panels ?? []) if (!pn.id || !pn.title || !def.views?.[pn.view]) fail('each panel needs id, title and a matching view');
    for (const hook of ['init', 'destroy', 'update']) if (def[hook] && typeof def[hook] !== 'function') fail(`${hook} must be a function`);
    return def;
  }

  #register(def, dir, { replace = false } = {}) {
    if (this.defs.has(def.name) && !replace) throw new Error(`duplicate module name "${def.name}"`);
    for (const c of def.commands ?? []) {
      const name = cmdJson(c).name;
      if (this.builtins.has(name)) throw new Error(`command "/${name}" is reserved by the core`);
      for (const [other, rec] of this.defs) {
        if (other !== def.name && (rec.def.commands ?? []).some((x) => cmdJson(x).name === name)) {
          throw new Error(`command "/${name}" is already provided by module "${other}"`);
        }
      }
    }
    if (def.migrations?.length) this.db.moduleMigrate(def.name, def.migrations);
    this.defs.set(def.name, { def, dir });
    this.perms.unregister(def.name);
    this.perms.register(def.name, def.permissions);
    if (!this.health.has(def.name)) this.health.set(def.name, { errors: [], last: null, lastRecovery: 0 });
  }

  // ------------------------------------------------------------------ context given to modules
  ctx(guildId, name) {
    const cacheKey = `${guildId}:${name}`;
    const cached = this.ctxCache.get(cacheKey);
    if (cached) return cached;
    const self = this;
    const tag = (m) => `[${name}] ${m}`;
    const ctx = {
      guildId,
      module: name,
      get client() { return self.client; },
      get guild() { return self.client?.guilds.cache.get(guildId) ?? null; },
      hasIntent: (n) => self.intents.has(n),
      /** 3.0.6: whether this user runs the bot (owner or team member). */
      isBotOwner: (userId) => self.isBotOwner(String(userId ?? '')),
      /** 3.0.6: settings for the whole bot, the same in every server (only the bot owner should change them). */
      botData: {
        get: (k) => self.db.dataGet('_bot', name, k),
        set: (k, v) => self.db.dataSet('_bot', name, k, v),
      },
      /** 3.0.6: a folder for the whole bot's tools and files (not per server). */
      botDir: (...parts) => { const d = path.join(self.dataDir, 'files', name, '_bot', ...parts.map((x) => String(x).replace(/[^\w.-]/g, '_'))); fs.mkdirSync(d, { recursive: true }); return d; },
      /** A folder for this module's files in this server (made when first asked for). */
      fileDir: (...parts) => { const d = path.join(self.dataDir, 'files', name, guildId, ...parts.map((x) => String(x).replace(/[^\w.-]/g, '_'))); fs.mkdirSync(d, { recursive: true }); return d; },
      log: {
        info: (m, meta) => self.log.info(tag(m), { guild: guildId, ...meta }),
        warn: (m, meta) => { self.log.warn(tag(m), { guild: guildId, ...meta }); self.db.addLog(guildId, name, 'warn', m); },
        error: (m, meta) => { self.log.error(tag(m), { guild: guildId, ...meta }); self.db.addLog(guildId, name, 'error', m); },
      },
      security: (m) => { self.log.warn(`[SECURITY]${tag(m)}`, { guild: guildId }); self.db.addLog(guildId, name, 'security', m); },
      config: {
        get(key, fallback) {
          const v = self.db.getConfig(guildId, name, key);
          if (v !== undefined) return v;
          const s = self.defs.get(name)?.def.settings?.find((x) => x.key === key);
          if (s && s.default !== undefined) return s.default;
          if (s?.type === 'list') return [];
          return fallback;
        },
        set: (key, value) => self.db.setConfig(guildId, name, key, value),
        all: () => self.getSettingValues(guildId, name),
      },
      data: {
        get: (k) => self.db.dataGet(guildId, name, k),
        set: (k, v) => self.db.dataSet(guildId, name, k, v),
        delete: (k) => self.db.dataDelete(guildId, name, k),
        list: (prefix, limit) => self.db.dataList(guildId, name, prefix, limit),
        deletePrefix: (p) => self.db.dataDeletePrefix(guildId, name, p),
        update: (k, fn, fallback) => self.db.dataUpdate(guildId, name, k, fn, fallback),
      },
      perms: {
        check: (member, key) => self.perms.check(member, key),
        rolesFor: (key) => self.perms.rolesFor(guildId, key),
        isAdmin: (m) => self.perms.isAdmin(m),
        isModerator: (m) => self.perms.isModerator(m),
      },
      queue: (fn, opts) => self.queue.run(name, fn, opts),
      backup: (label) => self.db.backup(`${name}-${label}`),
      // Tell open dashboards something changed: ctx.live('data') refreshes this module's panels,
      // ctx.live('activity', { icon, text }) adds a line to the live feed (never put message text in it).
      live: (type = 'data', data = {}) => publish(guildId, type, { module: name, ...data }),
      // Read-only facts about the installed modules (used by Bot news): a module's definition, and every module's name.
      moduleDef: (other) => self.defs.get(other)?.def ?? null,
      availableModules: () => [...self.defs.values()].map(({ def }) => ({ name: def.name, description: def.description ?? '' })),
      // Validated settings writes: the SAME path the dashboard and /config use, so commands and dashboard never disagree.
      settings: { set: (key, value, op = 'set') => self.setSetting(guildId, name, key, value, op) },
      sql: {
        run: (q, ...p) => self.db.q(q).run(...p),
        get: (q, ...p) => self.db.q(q).get(...p),
        all: (q, ...p) => self.db.q(q).all(...p),
        transaction: (fn) => self.db.transaction(fn),
      },
      notify: {
        allowed: (userId, category) => self.notifications.allowed(guildId, userId, category),
        filter: (userIds, category) => self.notifications.filter(guildId, userIds, category),
      },
      api: (other) => self.moduleApi(guildId, other),
      isActive: (other) => self.isActive(guildId, other),
      get hostApi() {
        const d = self.defs.get(name)?.def;
        return d?.type === 'addon' ? self.moduleApi(guildId, d.requires.module) : undefined;
      },
    };
    this.ctxCache.set(cacheKey, ctx);
    return ctx;
  }

  moduleApi(guildId, name) { return this.active.get(guildId)?.get(name)?.api; }
  isActive(guildId, name) { return !!this.active.get(guildId)?.has(name); }
  activeNames(guildId) { return [...(this.active.get(guildId)?.keys() ?? [])]; }

  // ------------------------------------------------------------------ settings (shared by /config and the dashboard)
  getSettingValues(guildId, name) {
    const def = this.defs.get(name)?.def;
    if (!def) return {};
    const stored = this.db.getConfigAll(guildId, name);
    const out = {};
    for (const s of def.settings ?? []) {
      out[s.key] = stored[s.key] !== undefined ? stored[s.key] : s.default !== undefined ? s.default : s.type === 'list' ? [] : null;
    }
    return out;
  }

  setSetting(guildId, name, key, raw, op = 'set') {
    const def = this.defs.get(name)?.def;
    if (!def) throw new UserError(`No module named "${name}".`);
    const s = (def.settings ?? []).find((x) => x.key === key);
    if (!s) throw new UserError(`"${name}" has no setting called "${key}".`);

    if (op === 'reset') { this.db.deleteConfig(guildId, name, key); publish(guildId, 'settings', { module: name, key }); return this.getSettingValues(guildId, name)[key]; }

    let value;
    if (s.type === 'list') {
      const current = this.getSettingValues(guildId, name)[key] ?? [];
      const items = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
        .map((x) => String(x).trim()).filter(Boolean);
      if (items.some((x) => x.length > 200)) throw new UserError('List entries must be 200 characters or fewer.');
      if (op === 'add') value = [...new Set([...current, ...items])];
      else if (op === 'remove') value = current.filter((x) => !items.map((i) => i.toLowerCase()).includes(String(x).toLowerCase()));
      else value = [...new Set(items)];
      if (value.length > 100) throw new UserError('Lists are limited to 100 entries.');
    } else {
      if (op !== 'set') throw new UserError(`"${key}" is not a list, so it can't be added to or removed from.`);
      value = this.#normalize(s, raw);
      if ((s.type === 'channel' || s.type === 'role') && value) {
        const guild = this.client?.guilds.cache.get(guildId);
        const coll = s.type === 'channel' ? guild?.channels?.cache : guild?.roles?.cache;
        if (guild && coll && !coll.has(value)) throw new UserError(`That ${s.type} doesn't exist in this server.`);
      }
    }
    this.db.setConfig(guildId, name, key, value);
    publish(guildId, 'settings', { module: name, key });
    return value;
  }

  #normalize(s, raw) {
    switch (s.type) {
      case 'toggle': {
        if (typeof raw === 'boolean') return raw;
        const t = String(raw).toLowerCase();
        if (['true', 'on', 'yes', '1', 'enable', 'enabled'].includes(t)) return true;
        if (['false', 'off', 'no', '0', 'disable', 'disabled'].includes(t)) return false;
        throw new UserError(`"${s.label}" must be on or off.`);
      }
      case 'number': {
        const n = Number(raw);
        if (raw === '' || raw === null || !Number.isFinite(n)) throw new UserError(`"${s.label}" must be a number.`);
        const min = s.min ?? -1e9, max = s.max ?? 1e9;
        if (n < min || n > max) throw new UserError(`"${s.label}" must be between ${min} and ${max}.`);
        return n;
      }
      case 'text': {
        const str = String(raw ?? '');
        if (str.length > (s.maxLength ?? 2000)) throw new UserError(`"${s.label}" is limited to ${s.maxLength ?? 2000} characters.`);
        return str;
      }
      case 'channel':
      case 'role': {
        if (raw === null || raw === '' || String(raw).toLowerCase() === 'none') return null;
        const id = String(raw).replace(/[<>#@&!]/g, '');
        if (!SNOWFLAKE.test(id)) throw new UserError(`That is not a valid ${s.type}.`);
        return id;
      }
      case 'select': {
        const v = String(raw);
        if (!s.options.includes(v)) throw new UserError(`Choose one of: ${s.options.join(', ')}`);
        return v;
      }
      default: throw new UserError('Unsupported setting type.');
    }
  }

  // ------------------------------------------------------------------ lifecycle (per server)
  #check(guildId, def) {
    const need = [];
    if (def.type === 'addon') need.push({ module: def.requires.module, version: def.requires.version, why: 'add-on' });
    for (const d of def.dependencies ?? []) need.push({ module: d.module, version: d.version, why: 'dependency' });
    for (const r of need) {
      const host = this.defs.get(r.module)?.def;
      if (!host) throw new RequirementError(`**${def.name}** needs the module **${r.module}**, which isn't installed.`);
      if (!semver.satisfies(host.version, r.version, { includePrerelease: true })) {
        throw new RequirementError(`**${def.name}** needs **${r.module}** ${r.version}, but ${host.version} is installed.`);
      }
      if (!this.isActive(guildId, r.module)) throw new RequirementError(`**${def.name}** needs **${r.module}** enabled first. Turn it on with \`/module\` or \`/modules\`.`);
    }
  }

  async #start(guildId, def, previousVersion) {
    const ctx = this.ctx(guildId, def.name);
    await withTimeout(Promise.resolve(def.init?.(ctx)), LIFECYCLE_TIMEOUT, `${def.name} init`);
    if (previousVersion && previousVersion !== def.version && semver.valid(previousVersion) && semver.gt(def.version, previousVersion)) {
      const tag = `${def.name}-${previousVersion}-to-${def.version}`;
      if (!this.backedUp.has(tag)) { this.backedUp.add(tag); this.db.backup(`before-${tag}`); }
      await withTimeout(Promise.resolve(def.update?.(ctx, previousVersion)), LIFECYCLE_TIMEOUT, `${def.name} update`);
      this.log.info(`Module "${def.name}" updated ${previousVersion} -> ${def.version} in guild ${guildId}`);
    }
  }

  async enable(guildId, name, { sync = true } = {}) {
    const rec = this.defs.get(name);
    if (!rec) throw new UserError(`There is no module called **${name}**.`);
    if (!this.client?.guilds.cache.has(guildId)) throw new UserError("I'm not in that server.");
    if (this.isActive(guildId, name)) throw new UserError(`**${name}** is already enabled.`);
    this.#check(guildId, rec.def);
    const previous = this.db.getModuleState(guildId, name)?.version;
    try {
      await this.#start(guildId, rec.def, previous);
    } catch (err) {
      this.ctxCache.delete(`${guildId}:${name}`);
      try { await rec.def.destroy?.(this.ctx(guildId, name)); } catch { /* best effort cleanup */ }
      this.recordError(name, guildId, 'enable', err);
      throw new UserError(`**${name}** failed to start: ${err.message}`);
    }
    if (!this.active.has(guildId)) this.active.set(guildId, new Map());
    this.active.get(guildId).set(name, rec.def);
    this.db.setModuleState(guildId, name, true, rec.def.version);
    if (sync) this.scheduleSync(guildId);
    publish(guildId, 'modules', { module: name, enabled: true });
    publish(guildId, 'activity', { module: name, icon: '🟢', text: `${name} was turned on` });
  }

  dependentsOf(guildId, name) {
    return [...(this.active.get(guildId)?.entries() ?? [])]
      .filter(([, d]) => (d.type === 'addon' && d.requires.module === name) || (d.dependencies ?? []).some((x) => x.module === name))
      .map(([n]) => n);
  }

  async disable(guildId, name, { cascade = false, sync = true } = {}) {
    const act = this.active.get(guildId);
    if (!act?.has(name)) {
      if (!this.defs.has(name) && !this.db.getModuleState(guildId, name)) throw new UserError(`There is no module called **${name}**.`);
      this.db.setModuleState(guildId, name, false, this.defs.get(name)?.def.version);
      return;
    }
    const dependents = this.dependentsOf(guildId, name);
    if (dependents.length) {
      if (!cascade) {
        throw new UserError(`Can't disable **${name}** yet: ${dependents.map((d) => `**${d}**`).join(', ')} depend${dependents.length === 1 ? 's' : ''} on it. Disable ${dependents.length === 1 ? 'that' : 'those'} first.`);
      }
      for (const d of dependents) await this.disable(guildId, d, { cascade: true, sync: false });
    }
    const def = act.get(name);
    try { await withTimeout(Promise.resolve(def.destroy?.(this.ctx(guildId, name))), LIFECYCLE_TIMEOUT, `${name} destroy`); }
    catch (err) { this.recordError(name, guildId, 'destroy', err); }
    act.delete(name);
    this.ctxCache.delete(`${guildId}:${name}`);
    for (const k of this.lastTask.keys()) if (k.startsWith(`${guildId}:${name}:`)) this.lastTask.delete(k);
    this.db.setModuleState(guildId, name, false, def.version);
    if (sync) this.scheduleSync(guildId);
    publish(guildId, 'modules', { module: name, enabled: false });
    publish(guildId, 'activity', { module: name, icon: '⬜', text: `${name} was turned off` });
  }

  /** Re-enable everything that was enabled before the bot last stopped, hosts before add-ons. */
  async restoreGuild(guildId) {
    let pending = this.db.getModuleStates(guildId).filter((s) => s.enabled && this.defs.has(s.module)).map((s) => s.module);
    for (let pass = 0; pass < 6 && pending.length; pass++) {
      const next = [];
      for (const name of pending) {
        try { await this.enable(guildId, name, { sync: false }); }
        catch (err) {
          if (err.code === 'REQUIREMENT') next.push(name);
          else this.log.error(`Could not restore "${name}" in guild ${guildId}: ${err.message}`);
        }
      }
      if (next.length === pending.length) { pending = next; break; }
      pending = next;
    }
    for (const name of pending) this.log.warn(`Could not restore "${name}" in guild ${guildId}: requirements not met`);
  }

  /** Stop a guild's modules without touching saved state (bot removed / shutting down). */
  async unloadGuild(guildId) {
    const act = this.active.get(guildId);
    if (!act) return;
    for (const [name, def] of [...act]) {
      try { await withTimeout(Promise.resolve(def.destroy?.(this.ctx(guildId, name))), 10000, `${name} destroy`); } catch { /* ignore */ }
      this.ctxCache.delete(`${guildId}:${name}`);
    }
    this.active.delete(guildId);
  }

  /**
   * Hot-reload a module's code from disk for every server using it.
   * If the new code is invalid or fails to start anywhere, everything is rolled back to the previous version.
   */
  async reload(name) {
    const rec = this.defs.get(name);
    if (!rec) throw new UserError(`There is no module called **${name}**.`);
    const old = rec.def;
    this.db.backup(`before-reload-${name}`);

    let fresh;
    try { fresh = await this.#importDef(rec.dir); }
    catch (err) { throw new UserError(`Reload aborted - the new code is invalid (${err.message}). **${name}** v${old.version} is still running.`); }
    try { this.#register(fresh, rec.dir, { replace: true }); }
    catch (err) { this.#register(old, rec.dir, { replace: true }); throw new UserError(`Reload aborted: ${err.message}`); }

    const guilds = [...this.active.entries()].filter(([, m]) => m.has(name)).map(([g]) => g);
    const switched = [];
    let failedGuild = null;
    try {
      for (const g of guilds) {
        failedGuild = g;
        try { await withTimeout(Promise.resolve(old.destroy?.(this.ctx(g, name))), LIFECYCLE_TIMEOUT, 'destroy'); } catch { /* ignore */ }
        this.ctxCache.delete(`${g}:${name}`);
        await this.#start(g, fresh, old.version);
        this.active.get(g).set(name, fresh);
        this.db.setModuleState(g, name, true, fresh.version);
        switched.push(g);
      }
    } catch (err) {
      this.#register(old, rec.dir, { replace: true });
      for (const g of [...switched, failedGuild]) {
        try { if (switched.includes(g)) await fresh.destroy?.(this.ctx(g, name)); } catch { /* ignore */ }
        this.ctxCache.delete(`${g}:${name}`);
        try { await old.init?.(this.ctx(g, name)); this.active.get(g).set(name, old); this.db.setModuleState(g, name, true, old.version); }
        catch (e2) { this.active.get(g)?.delete(name); this.log.error(`Rollback of "${name}" failed in guild ${g}: ${e2.message}`); }
      }
      throw new UserError(`Reload failed (${err.message}). Rolled back to **${name}** v${old.version}.`);
    }
    for (const g of guilds) this.scheduleSync(g);
    this.log.info(`Reloaded "${name}" ${old.version} -> ${fresh.version} for ${guilds.length} server(s)`);
    return { from: old.version, to: fresh.version, guilds: guilds.length };
  }

  // ------------------------------------------------------------------ dispatch
  async #guard(name, guildId, what, fn) {
    try { return await fn(); }
    catch (err) { if (!(err instanceof UserError)) this.recordError(name, guildId, what, err); else this.log.debug?.(`${name} ${what}: ${err.message}`); }
  }

  // ------------------------------------------------------------------ per-channel switch (3.0)
  /** Channels or categories where a module is switched off. Safety modules never are. */
  offIn(guildId, name) {
    if (NEVER_OFF_HERE.has(name)) return [];
    const v = this.db.getConfig(guildId, name, OFF_KEY);
    return Array.isArray(v) ? v.filter((x) => SNOWFLAKE.test(String(x))) : [];
  }
  setOffIn(guildId, name, ids) {
    if (NEVER_OFF_HERE.has(name)) throw new UserError('Moderation, logs and tickets always work everywhere, so they cannot be switched off in a channel.');
    const clean = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter((x) => SNOWFLAKE.test(x)))].slice(0, 100);
    this.db.setConfig(guildId, name, OFF_KEY, clean);
    return clean;
  }
  /** Is the module switched off where this happened? channel: a channel object or { id, parentId }. */
  isOffHere(guildId, name, channel) {
    if (!channel) return false;
    const list = this.offIn(guildId, name);
    if (!list.length) return false;
    const parent = channel.parentId ?? null, grand = channel.isThread?.() ? channel.parent?.parentId ?? null : null;
    return !!(list.includes(channel.id) || (parent && list.includes(parent)) || (grand && list.includes(grand)));
  }

  async dispatch(eventName, guildId, ...args) {
    const act = this.active.get(guildId);
    if (!act) return;
    const jobs = [];
    const where = CHANNEL_EVENTS[eventName]?.(...args) ?? null;
    for (const [name, def] of act) {
      const handler = def.events?.[eventName];
      if (handler && where && this.isOffHere(guildId, name, where)) continue;
      if (handler) jobs.push(this.#guard(name, guildId, `event ${eventName}`, () => handler(this.ctx(guildId, name), ...args)));
    }
    await Promise.all(jobs);
  }

  #findCommand(guildId, commandName) {
    for (const [, def] of this.active.get(guildId) ?? []) {
      const cmd = (def.commands ?? []).find((c) => cmdJson(c).name === commandName);
      if (cmd) return { def, cmd };
    }
    return null;
  }

  async reply(interaction, content) {
    const base = { content, allowedMentions: { parse: [] } };
    try {
      if (interaction.deferred && !interaction.replied && interaction.ephemeral === false && interaction.deleteReply && interaction.followUp) {
        await interaction.deleteReply().catch(() => {});
        await interaction.followUp({ ...base, flags: EPHEMERAL });
      } else if (interaction.deferred && !interaction.replied) await interaction.editReply(base);
      else if (interaction.replied || interaction.deferred) await interaction.followUp({ ...base, flags: EPHEMERAL });
      else await interaction.reply({ ...base, flags: EPHEMERAL });
    } catch { /* interaction expired */ }
  }

  async #fail(interaction, owner, err) {
    if (err instanceof UserError) return this.reply(interaction, err.message);
    this.recordError(owner, interaction.guildId, `interaction ${interaction.commandName ?? interaction.customId}`, err);
    return this.reply(interaction, 'Something went wrong while running that. The error was logged.');
  }

  /** Discord can redeliver an interaction after a slow response; never run the same one twice. */
  #duplicate(interaction) {
    const id = interaction.id;
    if (!id) return false;
    const now = Date.now();
    if (this.seenInteractions.size > 500) for (const [k, t] of this.seenInteractions) if (now - t > 300000) this.seenInteractions.delete(k);
    if (this.seenInteractions.has(id)) return true;
    this.seenInteractions.set(id, now);
    return false;
  }

  /**
   * Safety net for Discord's 3-second rule, shared by every command. If a command has not answered
   * after `afterMs`, it is deferred for it (a "thinking..." state), and the command's later
   * reply()/deferReply() calls are quietly turned into the right follow-up so nothing throws.
   *
   * Popup (modal) commands are exempt by construction: showModal must be the FIRST response, and it
   * marks the interaction as answered, so the net sees it and stands down. A command that is slow
   * AND wants a public answer declares `defer: 'public'` (default is private/ephemeral, because a
   * defer fixes who can see the reply). `defer: 'none'` turns the net off for that command.
   */
  #deferNet(interaction, mode, afterMs = this.deferAfterMs ?? 2000) {
    if (mode === 'none') return () => {};
    const timer = setTimeout(async () => {
      if (interaction.deferred || interaction.replied) return;
      try {
        await interaction.deferReply(mode === 'public' ? {} : { flags: EPHEMERAL });
      } catch { return; } // already answered in the meantime, or the interaction expired
      const asEdit = (orig) => async (opts) => {
        const o = typeof opts === 'string' ? { content: opts } : { ...(opts ?? {}) };
        delete o.flags; delete o.ephemeral; // visibility was fixed by the defer
        return interaction.editReply(o);
      };
      const realFollowUp = interaction.followUp?.bind(interaction);
      let edited = false;
      interaction.reply = async (opts) => { if (edited) return realFollowUp(opts); edited = true; return asEdit()(opts); };
      interaction.deferReply = async () => {};
      if (interaction.editReply) { const realEdit = interaction.editReply.bind(interaction); interaction.editReply = async (o) => { edited = true; return realEdit(o); }; }
    }, afterMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  }

  /**
   * 2.2: commands reach Discord without typed options (see src/autopopup.js). When one that has options runs with
   * nothing typed, answer with a popup built from its options instead of running it. Returns true when it did.
   */
  async #autoPopup(interaction, cmd) {
    if (!interaction.isChatInputCommand?.() && interaction.isChatInputCommand !== undefined) return false;
    if (AP.typedValueCount(interaction) !== 0) return false; // values were typed (an older client) or a test passed them
    const json = cmdJson(cmd);
    const group = interaction.options.getSubcommandGroup?.(false) ?? null;
    const sub = interaction.options.getSubcommand?.(false) ?? null;
    if (AP.ownsPopup(cmd, sub)) return false;
    const opts = AP.leafOptions(json, group, sub);
    if (!opts.length) return false;
    await interaction.showModal(AP.popupFor(interaction, json, group, sub, opts));
    return true;
  }

  /** The popup from #autoPopup was submitted (or its "Try again" button pressed): run the command with the answers. */
  async #autoPopupSubmit(interaction) {
    const t = AP.readToken(interaction.customId, interaction.user.id);
    const guildId = interaction.guildId;
    const builtin = this.builtins.get(t.name);
    const found = builtin ? null : this.#findCommand(guildId, t.name);
    if (!builtin && !found) return this.reply(interaction, 'That command is not enabled in this server any more.');
    const cmd = builtin ?? found.cmd;
    if (builtin?.access === 'admin' && !this.perms.isAdmin(interaction.member)) return this.reply(interaction, 'You need the **Manage Server** permission to use this.');
    if (found && cmd.permission && !this.perms.check(interaction.member, cmd.permission)) return this.reply(interaction, `You don't have permission for that. (\`${cmd.permission}\`)`);
    const json = cmdJson(cmd);
    const opts = AP.leafOptions(json, t.group, t.sub);
    const pages = AP.pageCount(opts);
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
    const button = (label, emoji, page, draft) => new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(AP.tokenFor(interaction, json, t.group, t.sub, 'o', page, draft)).setLabel(label).setEmoji(emoji).setStyle(ButtonStyle.Primary));
    if (t.step === 'o') return interaction.showModal(AP.popupFor(interaction, json, t.group, t.sub, opts, t.page, t.draft));
    let options;
    try {
      const raw = AP.readPage(interaction, opts, t.page);
      if (t.page < pages - 1) {
        // Not the last part yet: keep these answers and offer the next part.
        const draft = AP.saveDraft(t.draft, interaction.user.id, raw);
        return interaction.reply({ content: `✅ Part ${t.page + 1} of ${pages} saved. Press **Continue** for the rest.`, components: [button(`Continue (part ${t.page + 2} of ${pages})`, '➡️', t.page + 1, draft)], flags: EPHEMERAL, allowedMentions: { parse: [] } });
      }
      options = await AP.optionsFrom(interaction, opts, t, { ...AP.takeDraft(t.draft, interaction.user.id), ...raw });
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      return interaction.reply({ content: `❌ ${err.message}`, components: [button('Try again', '✏️', 0, '-')], flags: EPHEMERAL, allowedMentions: { parse: [] } });
    }
    // Make the popup look like the slash command it stands in for, so the command's code runs unchanged.
    Object.defineProperty(interaction, 'options', { value: options, configurable: true });
    Object.defineProperty(interaction, 'commandName', { value: t.name, configurable: true });
    // A command that would ask for more in a second popup can't (Discord forbids a popup after a popup): say what to fill in.
    Object.defineProperty(interaction, 'showModal', { value: async () => { throw new UserError('This needs one more thing filled in (usually the reason). Run the command again and fill in every field.'); }, configurable: true });
    let stopNet = () => {};
    try {
      stopNet = this.#deferNet(interaction, cmd.defer ?? 'ephemeral');
      if (builtin) await builtin.execute(interaction, this);
      else await cmd.execute(this.ctx(guildId, found.def.name), interaction);
    } finally { stopNet(); }
  }

  async handleCommand(interaction) {
    if (this.#duplicate(interaction)) return;
    const guildId = interaction.guildId;
    const name = interaction.commandName;
    const builtin = this.builtins.get(name);
    let owner = 'core';
    let stopNet = () => {};
    try {
      if (builtin) {
        if (builtin.access === 'admin' && !this.perms.isAdmin(interaction.member)) return await this.reply(interaction, 'You need the **Manage Server** permission to use this.');
        if (await this.#autoPopup(interaction, builtin)) return;
        stopNet = this.#deferNet(interaction, builtin.defer ?? 'ephemeral');
        return await builtin.execute(interaction, this);
      }
      const found = this.#findCommand(guildId, name);
      if (!found) return await this.reply(interaction, 'That command is not enabled in this server.');
      owner = found.def.name;
      const { cmd, def } = found;
      if (cmd.permission && !this.perms.check(interaction.member, cmd.permission)) {
        return await this.reply(interaction, `You don't have permission for that. (\`${cmd.permission}\` - by default: ${this.perms.describeDefault(cmd.permission)})`);
      }
      if (this.isOffHere(guildId, def.name, interaction.channel) && !this.perms.isAdmin(interaction.member)) return await this.reply(interaction, 'That is switched off in this channel. Try it in another one.');
      if (await this.#autoPopup(interaction, cmd)) return;
      stopNet = this.#deferNet(interaction, cmd.defer ?? 'ephemeral');
      await cmd.execute(this.ctx(guildId, def.name), interaction);
    } catch (err) { await this.#fail(interaction, owner, err); }
    finally { stopNet(); }
  }

  async handleComponent(interaction) {
    if (this.#duplicate(interaction)) return;
    const id = interaction.customId;
    if (id.startsWith(`${AP.NS}:`)) {
      const owner = (() => { try { const t = AP.readToken(id, interaction.user.id); return this.builtins.has(t.name) ? 'core' : (this.#findCommand(interaction.guildId, t.name)?.def.name ?? 'core'); } catch { return 'core'; } })();
      try { await this.#autoPopupSubmit(interaction); } catch (err) { await this.#fail(interaction, owner, err); }
      return;
    }
    // Core panels (/modules) own a few prefixes too; they are checked first and do not depend on any module.
    for (const b of this.builtins.values()) {
      const comp = (b.components ?? []).find((c) => id.startsWith(c.prefix));
      if (!comp) continue;
      try { await comp.execute(interaction, this); } catch (err) { await this.#fail(interaction, 'core', err); }
      return;
    }
    for (const [name, def] of this.active.get(interaction.guildId) ?? []) {
      const comp = (def.components ?? []).find((c) => id.startsWith(c.prefix));
      if (!comp) continue;
      try { await comp.execute(this.ctx(interaction.guildId, name), interaction); }
      catch (err) { await this.#fail(interaction, name, err); }
      return;
    }
    await this.reply(interaction, 'That control is no longer active.');
  }

  async handleAutocomplete(interaction) {
    try {
      const builtin = this.builtins.get(interaction.commandName);
      if (builtin?.autocomplete) return await builtin.autocomplete(interaction, this);
      const found = this.#findCommand(interaction.guildId, interaction.commandName);
      if (found?.cmd.autocomplete) await found.cmd.autocomplete(this.ctx(interaction.guildId, found.def.name), interaction);
    } catch { try { await interaction.respond([]); } catch { /* ignore */ } }
  }

  // ------------------------------------------------------------------ dashboard actions & views
  async runView(guildId, name, view, query = {}) {
    const def = this.active.get(guildId)?.get(name);
    const fn = def?.views?.[view];
    if (!fn) throw new UserError('That view is not available.');
    return fn(this.ctx(guildId, name), query);
  }

  async runAction(guildId, name, action, body, actor) {
    const def = this.active.get(guildId)?.get(name);
    const fn = def?.actions?.[action];
    if (!fn) throw new UserError('That action is not available.');
    try { const r = await fn(this.ctx(guildId, name), body ?? {}, actor); publish(guildId, 'data', { module: name }); return r; }
    catch (err) { if (!(err instanceof UserError)) this.recordError(name, guildId, `action ${action}`, err); throw err instanceof UserError ? err : new UserError('That action failed. The error was logged.'); }
  }

  // ------------------------------------------------------------------ slash command registration
  commandList(guildId) {
    const out = [];
    const seen = new Set();
    for (const b of this.builtins.values()) { const j = cmdJson(b); seen.add(j.name); out.push(j); }
    for (const [, def] of this.active.get(guildId) ?? []) {
      for (const c of def.commands ?? []) { const j = cmdJson(c); if (!seen.has(j.name)) { seen.add(j.name); out.push(j); } }
    }
    return out;
  }

  /** What Discord is told: the same commands without typed options, so every input happens in a popup. */
  discordCommandList(guildId) { return this.commandList(guildId).map((j) => AP.stripOptions(j)); }

  scheduleSync(guildId) {
    clearTimeout(this.syncTimers.get(guildId));
    const t = setTimeout(() => this.syncCommands(guildId).catch((e) => this.log.error(`Command sync failed for ${guildId}: ${e.message}`)), 1500);
    t.unref?.();
    this.syncTimers.set(guildId, t);
  }

  async syncCommands(guildId) {
    if (!this.client?.application) return;
    const list = this.discordCommandList(guildId).slice(0, 120);
    const chat = list.filter((c) => !c.type || c.type === 1).length;
    if (chat > 100) this.log.error(`Guild ${guildId}: ${chat} slash commands enabled, Discord allows 100. Disable a module.`);
    const summarize = (e) => `${e.message}${e.rawError?.errors ? ' ' + JSON.stringify(e.rawError.errors).slice(0, 400) : ''}`;
    try {
      await this.client.application.commands.set(list, guildId);
      this.syncStatus.set(guildId, { ok: true, at: Date.now(), count: list.length, failed: [] });
    } catch (err) {
      // One invalid command makes Discord reject the WHOLE list. Register the core commands, then each module command
      // on its own so one bad definition can't hide the rest, and record exactly which one Discord refused.
      this.log.error(`Bulk command registration failed for ${guildId}: ${summarize(err)} - retrying one by one`);
      const failed = [];
      try { await this.client.application.commands.set(list.filter((c) => this.builtins.has(c.name)), guildId); } catch { /* keep going */ }
      for (const c of list) {
        if (this.builtins.has(c.name)) continue;
        try { await this.client.application.commands.create(c, guildId); }
        catch (e) { failed.push({ name: c.name, error: summarize(e).slice(0, 300) }); this.log.error(`Discord rejected command "${c.name}": ${summarize(e)}`); }
      }
      this.syncStatus.set(guildId, { ok: failed.length === 0, at: Date.now(), count: list.length - failed.length, failed, bulkError: summarize(err).slice(0, 300) });
    }
  }

  // ------------------------------------------------------------------ health & recovery
  recordError(name, guildId, what, err) {
    const h = this.health.get(name) ?? { errors: [], last: null, lastRecovery: 0 };
    this.health.set(name, h);
    h.errors.push(Date.now());
    if (h.errors.length > 200) h.errors.shift();
    h.last = { message: err.message, at: Date.now(), what };
    this.log.error(`[${name}] ${what} failed: ${err.message}`, { guild: guildId, stack: String(err.stack ?? '').split('\n').slice(1, 3).join(' | ') });
    this.db.addLog(guildId, name, 'error', `${what}: ${err.message}`);
    this.#maybeRecover(name);
  }

  #maybeRecover(name) {
    const h = this.health.get(name);
    const now = Date.now();
    const recent = h.errors.filter((t) => now - t < 120000).length;
    if (recent >= 15 && now - h.lastRecovery > 600000 && this.defs.has(name)) {
      h.lastRecovery = now;
      this.log.warn(`Module "${name}" is failing repeatedly - attempting automatic reload`);
      this.reload(name).catch((e) => this.log.error(`Automatic recovery of "${name}" failed: ${e.message}`));
    }
  }

  status(name) {
    const h = this.health.get(name);
    const n = h ? h.errors.filter((t) => Date.now() - t < 600000).length : 0;
    return n === 0 ? 'healthy' : n < 10 ? 'warning' : 'failing';
  }

  getHealth() {
    return [...this.defs.values()].map(({ def }) => ({
      name: def.name, version: def.version, type: def.type, status: this.status(def.name),
      errorsLast10Min: (this.health.get(def.name)?.errors ?? []).filter((t) => Date.now() - t < 600000).length,
      lastError: this.health.get(def.name)?.last ?? null,
      servers: [...this.active.values()].filter((m) => m.has(def.name)).length,
    }));
  }

  describeForGuild(guildId) {
    return [...this.defs.values()].map(({ def }) => ({
      name: def.name, version: def.version, type: def.type, description: def.description ?? '',
      requires: def.requires ?? null, dependencies: def.dependencies ?? [],
      enabled: this.isActive(guildId, def.name), status: this.status(def.name), offChannels: this.offIn(guildId, def.name), canSwitchOffHere: !NEVER_OFF_HERE.has(def.name),
      settings: (def.settings ?? []).map((s) => ({ ...s })),
      values: this.getSettingValues(guildId, def.name),
      permissions: (def.permissions ?? []).map((p) => ({ key: p.key, label: p.label, default: p.default ?? 'admin', roles: this.db.permRoles(guildId, p.key) })),
      commands: (def.commands ?? []).map((c) => cmdJson(c).name),
      commandInfo: (def.commands ?? []).map((c) => { const j = cmdJson(c); return { name: j.name, description: j.description ?? '', subs: (j.options ?? []).filter((o) => o.type === 1).map((o) => ({ name: o.name, description: o.description })) }; }),
      panels: def.panels ?? [],
    }));
  }

  /** Every permission that can be assigned to roles here: the platform's own, plus those of modules that are on. */
  permissionList(guildId) {
    const core = CORE_PERMISSIONS.map((p) => ({ key: p.key, label: p.label, default: p.default ?? 'admin', roles: this.db.permRoles(guildId, p.key), module: 'core' }));
    const fromModules = this.describeForGuild(guildId).filter((d) => d.enabled).flatMap((d) => d.permissions.map((p) => ({ ...p, module: d.name })));
    return [...core, ...fromModules];
  }

  // ------------------------------------------------------------------ scheduled tasks
  startTasks() {
    this.taskTimer = setInterval(() => this.runTasks().catch(() => {}), 10000);
    this.taskTimer.unref?.();
  }

  async runTasks(now = Date.now()) {
    const jobs = [];
    for (const [guildId, mods] of this.active) {
      for (const [name, def] of mods) {
        for (const t of def.tasks ?? []) {
          const key = `${guildId}:${name}:${t.name}`;
          if (this.runningTasks.has(key)) continue;
          if (!this.lastTask.has(key)) this.lastTask.set(key, t.runOnEnable ? 0 : now);
          if (now - this.lastTask.get(key) < t.everyMs) continue;
          this.lastTask.set(key, now);
          this.runningTasks.add(key);
          jobs.push(this.#guard(name, guildId, `task ${t.name}`, () => t.run(this.ctx(guildId, name))).finally(() => this.runningTasks.delete(key)));
        }
      }
    }
    await Promise.all(jobs);
  }

  async shutdown() {
    clearInterval(this.taskTimer);
    for (const t of this.syncTimers.values()) clearTimeout(t);
    for (const g of [...this.active.keys()]) await this.unloadGuild(g);
  }
}
