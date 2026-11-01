/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Every command is a popup (2.2). Commands are registered with Discord WITHOUT their typed options, so the command
 * box never asks for text. When a command that has options runs, the core opens a popup built from those options
 * instead, then runs the command with the answers exactly as if they had been typed:
 *
 *   text options        -> text fields (long ones as paragraphs), with the option's length limits
 *   options with choices, and yes/no options -> dropdowns
 *   whole numbers       -> number fields, checked against the option's min and max
 *   members / channels / roles -> Discord's pickers
 *
 * Subcommands stay (picking one is not typing). Commands that already open their own popup when run with nothing
 * filled in declare `ownPopup: ['subcommand', ...]` (or `true`) and are left alone.
 *
 * A Discord popup holds at most 5 fields, so a command with more is asked in parts: part 1 is submitted, the answers
 * are kept for 15 minutes (on a global, so a hot reload keeps them), a "Continue" button opens part 2, and so on.
 * The command runs once the last part is in.
 *
 * The popup's customId is a signed token (src/modalpipe.js): owner-locked, expiring, and it survives hot reloads.
 */
import { randomBytes } from 'node:crypto';
import { packToken, unpackToken } from './modalpipe.js';
import { formModal, readForm, MAX_FIELDS, MAX_LABEL } from './modalkit.js';
import { UserError, truncate } from './util.js';

export const NS = 'gbc';
const SUB = 1, GROUP = 2, STRING = 3, INTEGER = 4, BOOLEAN = 5, USER = 6, CHANNEL = 7, ROLE = 8, MENTIONABLE = 9, NUMBER = 10;
const TYPED = new Set([STRING, INTEGER, BOOLEAN, USER, CHANNEL, ROLE, MENTIONABLE, NUMBER]);
// Text options under these names get a big paragraph box.
const LONG = /^(reason|message|text|content|description|idea|note|notes|bio|body|summary|details|question)$/;

/** The command JSON Discord gets: every typed option removed, subcommands kept. */
export function stripOptions(json) {
  const strip = (opts) => (opts ?? []).filter((o) => !TYPED.has(o.type)).map((o) => ({ ...o, options: strip(o.options) }));
  if (json.type && json.type !== 1) return json;
  return { ...json, options: strip(json.options) };
}

/** The typed options of the subcommand that ran (or of the command itself). */
export function leafOptions(json, group, sub) {
  let opts = json.options ?? [];
  if (group) opts = opts.find((o) => o.type === GROUP && o.name === group)?.options ?? [];
  if (sub) opts = opts.find((o) => o.type === SUB && o.name === sub)?.options ?? [];
  return opts.filter((o) => TYPED.has(o.type));
}

/** Leaf paths ("group sub", "sub" or "") with more than 5 typed options. The loader uses it. */
export function oversized(json) {
  const out = [];
  const walk = (opts, path) => {
    const leaf = (opts ?? []).filter((o) => TYPED.has(o.type));
    if (leaf.length > MAX_FIELDS) out.push(path.join(' '));
    for (const o of opts ?? []) if (o.type === SUB || o.type === GROUP) walk(o.options, [...path, o.name]);
  };
  walk(json.options, []);
  return out;
}

export const ownsPopup = (cmd, sub) => cmd.ownPopup === true || (Array.isArray(cmd.ownPopup) && cmd.ownPopup.includes(sub ?? ''));

const humanize = (n) => n.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Popup fields for a list of options. */
export function fieldsFor(opts) {
  return opts.map((o) => {
    let label = humanize(o.name);
    let desc = o.description && o.description !== label ? truncate(o.description, 100) : undefined;
    if (label.length > MAX_LABEL) label = label.slice(0, MAX_LABEL);
    const required = !!o.required;
    const base = { id: o.name, label, desc, required };
    if (o.choices?.length) return { ...base, kind: 'select', options: o.choices.slice(0, 25).map((c) => ({ label: truncate(c.name, 100), value: String(c.value) })) };
    switch (o.type) {
      case BOOLEAN: return { ...base, kind: 'select', options: [{ label: 'Yes', value: 'true' }, { label: 'No', value: 'false' }] };
      case INTEGER: case NUMBER: return { ...base, kind: 'text', max: 20, placeholder: [o.min_value, o.max_value].every((x) => x != null) ? `${o.min_value} to ${o.max_value}` : 'A number' };
      case USER: case MENTIONABLE: return { ...base, kind: 'user' };
      case CHANNEL: return { ...base, kind: 'channel', ...(o.channel_types?.length ? { channelTypes: o.channel_types } : { channelTypes: [0, 2, 4, 5, 13, 15] }) };
      case ROLE: return { ...base, kind: 'role' };
      default: {
        const long = LONG.test(o.name) || (o.max_length ?? 0) > 200;
        return { ...base, kind: long ? 'paragraph' : 'text', max: Math.min(o.max_length ?? 4000, 4000), placeholder: o.autocomplete ? 'Type it exactly' : undefined };
      }
    }
  });
}

export const pageCount = (opts) => Math.max(1, Math.ceil(opts.length / MAX_FIELDS));
export const pageOf = (opts, page) => opts.slice(page * MAX_FIELDS, page * MAX_FIELDS + MAX_FIELDS);
export const tokenFor = (i, json, group, sub, step, page = 0, draft = '-') =>
  packToken({ ns: NS, step, form: json.name, owner: i.user.id, args: [group ?? '-', sub ?? '-', String(page), draft] });

export function popupFor(i, json, group, sub, opts, page = 0, draft = '-') {
  const pages = pageCount(opts);
  const title = truncate(`/${[json.name, group, sub].filter(Boolean).join(' ')}${pages > 1 ? ` (${page + 1} of ${pages})` : ''}`, 45);
  return formModal(tokenFor(i, json, group, sub, 's', page, draft), title, fieldsFor(pageOf(opts, page)));
}

// Answers from earlier parts of a long popup, until the last part is submitted.
const drafts = () => (globalThis[Symbol.for('goodboy.autopopup.drafts')] ??= new Map());
export function saveDraft(id, owner, raw) {
  const m = drafts(), now = Date.now();
  for (const [k, v] of m) if (v.exp < now) m.delete(k);
  const key = id === '-' ? randomBytes(4).toString('hex') : id;
  const cur = m.get(key);
  if (cur && cur.owner !== owner) throw new UserError('That form belongs to someone else.');
  m.set(key, { owner, raw: { ...(cur?.raw ?? {}), ...raw }, exp: now + 15 * 60000 });
  return key;
}
export function takeDraft(id, owner) {
  if (id === '-') return {};
  const d = drafts().get(id);
  if (!d || d.exp < Date.now()) throw new UserError('The earlier part of this form expired. Run the command again.');
  if (d.owner !== owner) throw new UserError('That form belongs to someone else.');
  drafts().delete(id);
  return d.raw;
}
export const readPage = (i, opts, page) => readForm(i, fieldsFor(pageOf(opts, page)));

export const readToken = (customId, userId) => {
  const t = unpackToken(customId, { ns: NS, userId });
  const [group, sub] = t.args.slice(0, 2).map((x) => (x === '-' ? null : x));
  return { name: t.form, group, sub, step: t.step, page: Number(t.args[2] ?? 0) || 0, draft: t.args[3] ?? '-' };
};

/**
 * Turns popup answers into an `options` object with the same methods discord.js gives a slash command, so the command
 * code runs unchanged. Members, channels and roles are looked up so the command gets real objects.
 */
export async function optionsFrom(i, opts, { group, sub }, raw) {
  const values = {};
  for (const o of opts) {
    let v = raw[o.name];
    if (v === '' || v === undefined) v = null;
    if (v === null) { if (o.required) throw new UserError(`Fill in **${humanize(o.name)}**.`); values[o.name] = null; continue; }
    if (o.choices?.length) v = o.type === STRING ? String(v) : Number(v);
    else if (o.type === BOOLEAN) v = v === 'true';
    else if (o.type === INTEGER || o.type === NUMBER) {
      const n = Number(String(v).replace(/[, _]/g, ''));
      if (!Number.isFinite(n) || (o.type === INTEGER && !Number.isInteger(n))) throw new UserError(`**${humanize(o.name)}** must be a whole number.`);
      if (o.min_value != null && n < o.min_value) throw new UserError(`**${humanize(o.name)}** must be at least ${o.min_value}.`);
      if (o.max_value != null && n > o.max_value) throw new UserError(`**${humanize(o.name)}** can be at most ${o.max_value}.`);
      v = n;
    } else if (o.type === STRING) {
      if (o.min_length != null && v.length < o.min_length) throw new UserError(`**${humanize(o.name)}** needs at least ${o.min_length} characters.`);
    } else if (o.type === USER || o.type === MENTIONABLE) {
      const user = await i.client.users.fetch(v).catch(() => null);
      if (!user) throw new UserError(`I can't find that member any more.`);
      v = user;
    } else if (o.type === CHANNEL) {
      v = i.guild?.channels.cache.get(v) ?? await i.guild?.channels.fetch?.(v).catch(() => null) ?? { id: v };
    } else if (o.type === ROLE) {
      v = i.guild?.roles.cache.get(v) ?? { id: v };
    }
    values[o.name] = v;
  }
  const get = (name, required) => {
    const v = values[name] ?? null;
    if (v === null && required) throw new UserError(`Fill in **${humanize(name)}**.`);
    return v;
  };
  return {
    data: [], _fromPopup: true,
    getSubcommand: () => sub, getSubcommandGroup: () => group,
    getString: get, getInteger: get, getNumber: get, getBoolean: get, getUser: get, getChannel: get, getRole: get, getMentionable: get,
    getMember: (name) => { const u = values[name]; return u ? i.guild?.members.cache.get(u.id) ?? null : null; },
    getAttachment: () => null, getFocused: () => '',
    get: (name) => (values[name] == null ? null : { name, value: values[name]?.id ?? values[name] }),
  };
}

/** How many typed values a real slash interaction carried (0 when Discord had no options to offer). */
export function typedValueCount(i) {
  const data = i.options?.data;
  if (!Array.isArray(data)) return null; // not a real discord.js interaction (tests pass options directly)
  let n = 0;
  const walk = (list) => { for (const o of list ?? []) { if (o.type === SUB || o.type === GROUP) walk(o.options); else n++; } };
  walk(data);
  return n;
}
