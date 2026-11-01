/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * AutoMod rules: pure logic, no Discord objects, so it can be tested directly.
 * The moderation module feeds it plain values (text, ids, config) and acts on the answer.
 */

/** Every rule AutoMod knows. `on` / `limit` name the settings that hold each rule's switch and threshold. */
export const RULES = [
  { id: 'spam', label: 'Spam (too many messages too fast)', on: 'automodSpam', limit: 'spamMaxMessages', action: 'spamAction', limitLabel: 'messages allowed in the window' },
  { id: 'words', label: 'Word filter', on: 'automodWords', limit: null, action: 'wordsAction' },
  { id: 'links', label: 'Links and invites', on: 'automodLinks', limit: null, action: 'linksAction' },
  { id: 'mentions', label: 'Mass mentions', on: null, limit: 'maxMentions', action: 'mentionsAction', limitLabel: 'mentions in one message (0 = off)' },
  { id: 'repeat', label: 'Repeated messages', on: 'automodRepeat', limit: 'repeatMax', action: 'repeatAction', limitLabel: 'identical messages allowed in the window' },
  { id: 'caps', label: 'Too many capital letters', on: 'automodCaps', limit: 'capsPercent', action: 'capsAction', limitLabel: 'percent of letters in capitals' },
  { id: 'emoji', label: 'Too many emoji', on: 'automodEmoji', limit: 'emojiMax', action: 'emojiAction', limitLabel: 'emoji in one message' },
];
export const RULE_IDS = RULES.map((r) => r.id);
export const ACTIONS = ['default', 'delete', 'delete-warn', 'delete-timeout'];
export const ruleById = (id) => RULES.find((r) => r.id === id) ?? null;

/** Is this rule switched on? (Mass mentions has no switch of its own: a limit above 0 means on.) */
export function ruleEnabled(cfg, rule) {
  return rule.on ? !!cfg[rule.on] : Number(cfg[rule.limit]) > 0;
}

/** The action for a rule: its own choice, or the server-wide AutoMod action when it says "default". */
export function actionFor(cfg, rule) {
  const own = cfg[rule.action];
  return own && own !== 'default' ? own : (cfg.automodAction || 'delete-warn');
}

const idOf = (x) => String(x ?? '').replace(/[<>#@&!]/g, '').trim();

/**
 * Exemptions are lists of role and channel ids, either for every rule ("all") or for one rule.
 * A channel entry also covers everything inside that category, and a thread inside an exempt channel.
 */
export function isExempt(ex, ruleId, { roleIds = [], channelId, parentId, categoryId }) {
  const sets = [ex?.all, ex?.[ruleId]].filter(Boolean);
  const roles = new Set(roleIds.map(String));
  const chans = [channelId, parentId, categoryId].filter(Boolean).map(String);
  for (const s of sets) {
    if ((s.roles ?? []).some((r) => roles.has(idOf(r)))) return true;
    if ((s.channels ?? []).some((c) => chans.includes(idOf(c)))) return true;
  }
  return false;
}

/** Add or remove one id from an exemption set. Returns a fresh object (the stored one is never edited in place). */
export function editExempt(ex, ruleId, kind, id, add) {
  if (ruleId !== 'all' && !RULE_IDS.includes(ruleId)) throw new Error(`Unknown rule "${ruleId}".`);
  if (kind !== 'roles' && kind !== 'channels') throw new Error('Kind must be roles or channels.');
  const next = { ...(ex ?? {}) };
  const set = { roles: [], channels: [], ...(next[ruleId] ?? {}) };
  const list = new Set((set[kind] ?? []).map(idOf));
  const changed = add ? !list.has(id) : list.has(id);
  if (add) list.add(id); else list.delete(id);
  set[kind] = [...list];
  if (!set.roles.length && !set.channels.length) delete next[ruleId]; else next[ruleId] = set;
  return { ex: next, changed };
}

// ------------------------------------------------------------------ individual detectors

const EMOJI_UNICODE = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/gu;
const EMOJI_CUSTOM = /<a?:\w{2,32}:\d{15,25}>/g;
const FLAGS = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;

/** How many emoji (unicode, flags and custom server emoji) the text contains. A joined family counts once. */
export function countEmoji(text) {
  const t = String(text ?? '');
  return (t.match(EMOJI_CUSTOM)?.length ?? 0) + (t.replace(EMOJI_CUSTOM, '').match(EMOJI_UNICODE)?.length ?? 0) + (t.match(FLAGS)?.length ?? 0);
}

/** Share of letters that are capitals, ignoring mentions, links, emoji and code. Short messages never count. */
export function capsRatio(text, { minLetters = 12 } = {}) {
  const clean = String(text ?? '').replace(/```[\s\S]*?```|`[^`]*`|https?:\/\/\S+|<[@#:a][^>]*>/gi, ' ');
  const letters = clean.match(/\p{L}/gu) ?? [];
  if (letters.length < minLetters) return 0;
  const upper = letters.filter((c) => c !== c.toLowerCase() && c === c.toUpperCase()).length;
  return Math.round((upper / letters.length) * 100);
}

/** Lower-case, collapse spaces and strip pings so "Hello  @a" and "hello @b" count as the same message. */
export function normalizeText(text) {
  return String(text ?? '').toLowerCase().replace(/<[@#][^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/** Record a message in a sliding window and say how many times the same text appeared inside it. */
export function recordRepeat(list, { text, id, ch, now, windowMs }) {
  const key = normalizeText(text);
  const kept = list.filter((e) => now - e.t < windowMs);
  if (key.length < 2) return { list: kept, count: 0, hits: [] };
  kept.push({ t: now, id, ch, key });
  const hits = kept.filter((e) => e.key === key);
  return { list: kept, count: hits.length, hits };
}

/** Short, safe preview of a removed message for the staff activity list. */
export function snippet(text, max = 80) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/[`​]/g, "'");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Roll the recent-activity list up into counts per rule over the last N days. */
export function activityCounts(recent, now, days = 7) {
  const since = now - days * 86400000;
  const out = Object.fromEntries(RULE_IDS.map((r) => [r, 0]));
  for (const e of recent ?? []) if (e.at >= since && e.rule in out) out[e.rule]++;
  return out;
}
