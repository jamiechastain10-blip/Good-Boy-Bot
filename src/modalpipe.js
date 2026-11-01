/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * The modal pipeline (2.2): every command that needs typed input goes trigger -> button -> popup -> submit.
 *
 *   /warn                 -> private message with one button ("Configure warning")
 *   click the button      -> the popup opens (fields are built at THIS moment, so they can show fresh data)
 *   submit the popup      -> the form's submit() runs with plain values
 *
 * Everything a step needs travels inside the button's / popup's customId as a signed token, so nothing is kept in
 * memory between steps. A hot reload, or even a full restart, between any two steps does not break the flow:
 *
 *   <ns>:m1:<step>:<form>:<owner>:<issued>:<nonce>:<args>:<sig>
 *   e.g. mpm:m1:o:warn:123456789012345678:t3k9zq:x7q2:987654321098765432:4f1a0c9be2
 *
 *   ns      which module owns it (each module has its own short prefix, so the core routes it like any other button)
 *   m1      token FORMAT version. It is NOT the bot version: an update from 2.2.0 to 2.2.1 must not break buttons
 *           people already have open. Only a change to this layout bumps it (and m1 can keep being read alongside).
 *   step    o = open the popup (a button), s = submit (the popup itself)
 *   form    which form in that module
 *   owner   the user who ran the command. Nobody else can press their button or submit their popup
 *   issued  when the step was created (seconds, base 36). Old tokens expire
 *   nonce   4 random characters, so two forms opened in the same second are still different forms
 *   args    context from the command: a target user, a channel, a game session... ids only, comma separated
 *   sig     HMAC-SHA256 of everything before it, keyed by a secret kept in the database. A changed id, owner,
 *           target or form name no longer matches, so a modified client cannot aim a form at someone else.
 *
 * Permissions are checked again on every step: someone who loses a role after opening a form cannot submit it.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { formModal, readForm, checkSpec } from './modalkit.js';
import { UserError } from './util.js';

export const TOKEN_FORMAT = 'm1';
export const MAX_CUSTOM_ID = 100;
export const DEFAULT_MAX_AGE_MS = 15 * 60000;
const EPH = MessageFlags.Ephemeral;
const PART = /^[A-Za-z0-9_-]{1,32}$/;
const ARG = /^[A-Za-z0-9_-]{0,24}$/;
const SECRET = Symbol.for('goodboy.modalpipe.secret');
const LAST = Symbol.for('goodboy.modalpipe.last');
const USED = Symbol.for('goodboy.modalpipe.used');

/** The signing key. The core sets it from the database at start-up; tests and tools get a random one. */
export function setSecret(secret) { globalThis[SECRET] = Buffer.from(String(secret), 'hex'); }
export function getSecret() { return (globalThis[SECRET] ??= randomBytes(32)); }
/** Reads the key from the database, creating it on first run. */
export function loadSecret(db) {
  let hex = db?.metaGet?.('modalpipe.secret');
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) { hex = randomBytes(32).toString('hex'); db?.metaSet?.('modalpipe.secret', hex); }
  setSecret(hex);
}

const sign = (body) => createHmac('sha256', getSecret()).update(body).digest('hex').slice(0, 10);
const now36 = (ms) => Math.floor(ms / 1000).toString(36);

/** Builds a token. Throws (a programming error, caught by tests) when a part is malformed or the id is too long. */
export function packToken({ ns, step, form, owner, args = [], at = Date.now() }) {
  for (const [k, v] of Object.entries({ ns, step, form, owner })) if (!PART.test(String(v ?? ''))) throw new Error(`modalpipe: bad ${k} "${v}"`);
  for (const a of args) if (!ARG.test(String(a ?? ''))) throw new Error(`modalpipe: bad argument "${a}" (ids and short words only)`);
  const nonce = randomBytes(3).readUIntBE(0, 3).toString(36).padStart(4, '0').slice(-4);
  const body = [ns, TOKEN_FORMAT, step, form, owner, now36(at), nonce, args.join(',')].join(':');
  const id = `${body}:${sign(body)}`;
  if (id.length > MAX_CUSTOM_ID) throw new Error(`modalpipe: customId is ${id.length} characters (Discord allows ${MAX_CUSTOM_ID})`);
  return id;
}

/**
 * Reads and checks a token. Every failure is a UserError with a message that is safe to show, so a stale or
 * tampered button just tells the person to run the command again.
 */
export function unpackToken(customId, { ns, userId, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const parts = String(customId ?? '').split(':');
  if (parts.length !== 9 || parts[0] !== ns) throw new UserError('That button is not from this feature. Run the command again.');
  const [, ver, step, form, owner, issued, , rawArgs, sig] = parts;
  if (ver !== TOKEN_FORMAT) throw new UserError('That button is from an older version. Run the command again.');
  const expect = Buffer.from(sign(parts.slice(0, 8).join(':')));
  const got = Buffer.from(String(sig));
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) throw new UserError('That button could not be verified. Run the command again.');
  const at = parseInt(issued, 36) * 1000;
  if (!Number.isFinite(at) || now - at > maxAgeMs) throw new UserError('That form expired. Run the command again.');
  if (userId && owner !== userId) throw new UserError('That form belongs to someone else. Run the command yourself to get your own.');
  return { step, form, owner, at, args: rawArgs ? rawArgs.split(',') : [] };
}

/**
 * Submitted popups, so the same popup cannot be submitted twice (a double click, a replayed request).
 * Kept on a global so a hot reload keeps it; entries are only needed until the token expires anyway.
 */
function usedTokens() { return (globalThis[USED] ??= new Map()); }
function markUsed(customId, maxAgeMs) {
  const m = usedTokens(), now = Date.now();
  if (m.size > 5000) for (const [k, exp] of m) if (exp < now) m.delete(k);
  if (m.has(customId) && m.get(customId) > now) return false;
  m.set(customId, now + maxAgeMs);
  return true;
}

/** Last answers per person and form, kept on a global so a hot reload keeps them. Used to pre-fill "Try again". */
function lastAnswers() { return (globalThis[LAST] ??= new Map()); }
function remember(key, values) {
  const m = lastAnswers();
  if (m.size > 2000) for (const k of [...m.keys()].slice(0, 500)) m.delete(k);
  m.set(key, { values, at: Date.now() });
}
export function recall(key, maxAgeMs = 30 * 60000) {
  const r = lastAnswers().get(key);
  return r && Date.now() - r.at < maxAgeMs ? r.values : null;
}

/**
 * One pipeline per module.
 *
 *   const pipe = createPipeline({ ns: 'mpm', forms: {
 *     warn: {
 *       title: 'Warn a member', permission: 'moderation.warn',
 *       button: { label: 'Configure warning', emoji: '⚠️' },
 *       intro: (ctx, i, args) => 'Fill in the warning. Nothing is recorded until you submit.',
 *       precheck: async (ctx, i, args) => {},              // optional, runs before the button AND before the popup
 *       fields: (ctx, i, args) => [{ id: 'reason', label: 'Reason', kind: 'paragraph' }],   // see modalkit.js
 *       submit: async (ctx, i, values, args) => {},
 *     },
 *   } });
 *   // in a command:  return pipe.launch(ctx, i, 'warn', [targetId]);
 *   // in the module: components: [pipe.component]
 *
 * trigger: 'button' (default, the 2.2 rule) shows the private button first. 'direct' opens the popup straight from
 * the command: Discord does allow that for slash commands, context menus and buttons, so it is one setting away.
 */
export function createPipeline({ ns, forms, trigger = 'button', maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  if (!PART.test(ns)) throw new Error(`modalpipe: bad namespace "${ns}"`);
  for (const [name, f] of Object.entries(forms)) {
    if (!PART.test(name)) throw new Error(`modalpipe: bad form name "${name}"`);
    if (typeof f.fields !== 'function' || typeof f.submit !== 'function' || !f.title) throw new Error(`modalpipe: form "${name}" needs title, fields() and submit()`);
  }
  const prefix = `${ns}:`;

  const formOf = (name) => {
    const f = forms[name];
    if (!f) throw new UserError('That form is no longer available. Run the command again.');
    return f;
  };
  const allowed = (ctx, i, f) => {
    if (f.permission && !ctx.perms.check(i.member, f.permission)) throw new UserError(`You don't have permission for that (\`${f.permission}\`).`);
  };
  const resolveFields = async (ctx, i, f, args) => checkSpec(await f.fields(ctx, i, args));
  const modalFor = async (ctx, i, name, args, prefill) => {
    const f = formOf(name);
    const fields = (await resolveFields(ctx, i, f, args)).map((x) => (prefill && prefill[x.id] != null && x.value == null && ['text', 'paragraph', 'number', undefined].includes(x.kind) ? { ...x, value: prefill[x.id] } : x));
    const title = typeof f.title === 'function' ? f.title(ctx, i, args) : f.title;
    return formModal(packToken({ ns, step: 's', form: name, owner: i.user.id, args }), title, fields);
  };

  /** The private "configure" message: a short explanation and the one button. */
  const launcherMessage = async (ctx, i, name, args, { note } = {}) => {
    const f = formOf(name);
    const b = f.button ?? {};
    const btn = new ButtonBuilder().setCustomId(packToken({ ns, step: 'o', form: name, owner: i.user.id, args }))
      .setLabel(b.label ?? 'Open form').setStyle(b.style ?? ButtonStyle.Primary);
    if (b.emoji) btn.setEmoji(b.emoji);
    const intro = typeof f.intro === 'function' ? await f.intro(ctx, i, args) : f.intro;
    const embed = new EmbedBuilder().setColor(f.color ?? 0x5865f2).setTitle(typeof f.title === 'function' ? f.title(ctx, i, args) : f.title)
      .setDescription([note, intro ?? 'Press the button to fill in the form.'].filter(Boolean).join('\n\n'))
      .setFooter({ text: 'Only you can see this. The button works for 15 minutes.' });
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(btn)], flags: EPH, allowedMentions: { parse: [] } };
  };

  async function launch(ctx, i, name, args = []) {
    const f = formOf(name);
    allowed(ctx, i, f);
    await f.precheck?.(ctx, i, args);
    if ((f.trigger ?? trigger) === 'direct') return i.showModal(await modalFor(ctx, i, name, args, recall(`${i.guildId}:${i.user.id}:${ns}:${name}`)));
    return i.reply(await launcherMessage(ctx, i, name, args));
  }

  /** Opens a form from a button the module drew itself (an arcade panel, "Change bet"...). The click is the trigger. */
  async function open(ctx, i, name, args = []) {
    const f = formOf(name);
    allowed(ctx, i, f);
    await f.precheck?.(ctx, i, args);
    return i.showModal(await modalFor(ctx, i, name, args, recall(`${i.guildId}:${i.user.id}:${ns}:${name}`)));
  }

  /** A button that opens a form, for modules that build their own messages (e.g. "Change bet" under a result). */
  function button(i, name, args = [], { label = 'Open form', emoji, style = ButtonStyle.Secondary } = {}) {
    const b = new ButtonBuilder().setCustomId(packToken({ ns, step: 'o', form: name, owner: i.user.id, args })).setLabel(label).setStyle(style);
    if (emoji) b.setEmoji(emoji);
    return b;
  }

  async function execute(ctx, i) {
    const tok = unpackToken(i.customId, { ns, userId: i.user.id, maxAgeMs });
    const f = formOf(tok.form);
    allowed(ctx, i, f);
    const key = `${i.guildId}:${i.user.id}:${ns}:${tok.form}`;

    if (tok.step === 'o') {
      // A popup must be the FIRST response to this click, so nothing slow may run before showModal.
      await f.precheck?.(ctx, i, tok.args);
      return i.showModal(await modalFor(ctx, i, tok.form, tok.args, recall(key)));
    }
    if (tok.step !== 's') throw new UserError('That button is not recognised. Run the command again.');

    if (!markUsed(i.customId, maxAgeMs)) throw new UserError('That form was already submitted. Run the command again to make another.');
    let values;
    try {
      values = readForm(i, await resolveFields(ctx, i, f, tok.args));
      remember(key, Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === 'string' || typeof v === 'number')));
      return await f.submit(ctx, i, values, tok.args);
    } catch (err) {
      // A popup cannot be re-opened from its own submit, so offer a button that brings it back pre-filled.
      if (!i.replied && !i.deferred) usedTokens().delete(i.customId); // nothing happened, so the same form may be sent again
      if (!(err instanceof UserError) || i.replied || i.deferred) throw err;
      return i.reply(await launcherMessage(ctx, i, tok.form, tok.args, { note: `❌ ${err.message}` }));
    }
  }

  return { ns, prefix, forms, launch, open, button, component: { prefix, execute } };
}
