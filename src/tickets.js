/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * The rules of the ticket system that need no Discord: what members can open a ticket about (and how urgent each
 * is), how a report's "who" is read and checked, and how a new ticket is matched against the staff watch log.
 * Kept apart from the module so every rule can be tested on its own.
 *
 * A watch-log entry is an ACCUSATION, not a finding. Matches are labelled "exact" (a user ID matched) or "possible"
 * (a name matched - names are not unique), and every flag shows the entry's outcome so staff are never told
 * more than is known.
 */
import { UserError, SNOWFLAKE } from './util.js';

export const URGENCY = {
  urgent: { label: '🔴 urgent', rank: 3, color: 0xed4245 },
  high: { label: '🟠 high', rank: 2, color: 0xfaa61a },
  normal: { label: '🔵 normal', rank: 1, color: 0x5865f2 },
  low: { label: '🟢 low', rank: 0, color: 0x57f287 },
};

/**
 * What a member can open a ticket about. `report`: 'required' = the reported person must be named, 'optional' = asked for
 * but may be unknown (a hacked account, a stranger's DM), undefined = not a report. `appeal` tickets get approve/deny buttons.
 */
export const CATEGORIES = [
  { id: 'scam', emoji: '🚨', label: 'Scam, phishing or hacked account', urgency: 'urgent', report: 'optional', description: 'Fake links, stolen accounts, someone trying to trick people' },
  { id: 'safety', emoji: '🛡️', label: 'Harassment, threats or safety concern', urgency: 'urgent', report: 'optional', description: 'Someone is threatening, targeting or putting someone at risk' },
  { id: 'report', emoji: '📣', label: 'Report a member', urgency: 'high', report: 'required', description: 'Someone broke the rules' },
  { id: 'appeal', emoji: '⚖️', label: 'Ban, mute or warning appeal', urgency: 'normal', appeal: true, description: 'Ask staff to review a punishment' },
  { id: 'bot', emoji: '🛠️', label: 'Problem with the bot or a channel', urgency: 'normal', description: 'Something is broken or not working' },
  { id: 'access', emoji: '🔑', label: 'Role, verification or access help', urgency: 'normal', description: "Can't see a channel, missing a role, stuck verifying" },
  { id: 'partner', emoji: '🤝', label: 'Partnership or business', urgency: 'low', description: 'Collaborations, sponsorships, promotions' },
  { id: 'other', emoji: '❓', label: 'Question or other', urgency: 'low', description: 'Anything else' },
];

/** Looks a category up by id. `custom` are the server's own ticket types from before categories existed (they stay "normal"). */
export function findCategory(id, custom = []) {
  const built = CATEGORIES.find((c) => c.id === id);
  if (built) return built;
  const t = custom.find((c) => c.id === id);
  return t ? { id: t.id, emoji: t.emoji ?? '🎫', label: t.label, urgency: 'normal', custom: true, questions: t.questions ?? [], categoryId: t.categoryId } : null;
}

/** The popup a member sees for a category. Fields: { id, label, style: 'short'|'paragraph', required, max, placeholder }. */
export function questionsFor(cat) {
  if (cat.custom) {
    return (cat.questions ?? []).slice(0, 5).map((q, n) => ({ id: `q${n}`, label: q, style: n === 0 ? 'paragraph' : 'short', required: true, max: 1000 }));
  }
  if (cat.report) {
    const must = cat.report === 'required';
    return [
      { id: 'username', label: must ? 'Their username' : 'Their username (if you know it)', style: 'short', required: false, max: 40, placeholder: 'e.g. coolguy123 - no spaces' },
      { id: 'userid', label: must ? 'Their user ID' : 'Their user ID (if you know it)', style: 'short', required: false, max: 25, placeholder: 'Right-click them with Developer Mode on > Copy User ID' },
      { id: 'details', label: 'What happened?', style: 'paragraph', required: true, max: 1000, placeholder: 'Say what they did, where, and roughly when.' },
      { id: 'evidence', label: 'Evidence (message links, screenshots)', style: 'paragraph', required: false, max: 800, placeholder: 'Paste message links or image links. Nothing here is shown to them.' },
    ];
  }
  if (cat.appeal) {
    return [
      { id: 'what', label: 'What are you appealing?', style: 'short', required: true, max: 200, placeholder: 'e.g. 7 day ban on 12 March for spam' },
      { id: 'why', label: 'Why should it be reviewed?', style: 'paragraph', required: true, max: 1000 },
      { id: 'extra', label: 'Anything else staff should know', style: 'paragraph', required: false, max: 800 },
    ];
  }
  return [
    { id: 'details', label: 'How can we help?', style: 'paragraph', required: true, max: 1000, placeholder: 'Give as much detail as you can.' },
    { id: 'extra', label: 'Links or extra details (optional)', style: 'paragraph', required: false, max: 800 },
  ];
}

// ------------------------------------------------------------------ the reported person
/** A user name as people type it: lower case, no leading @, no "#0" / "#1234" tail. */
export function normalizeName(raw) {
  return String(raw ?? '').trim().replace(/^@+/, '').replace(/#\d{1,4}$/, '').trim().toLowerCase().slice(0, 40);
}

/** Reads the "who" part of a report. Throws a UserError a member can act on. */
export function parseReported({ username, userid }, { required = false } = {}) {
  const rawId = String(userid ?? '').trim();
  let id = null;
  if (rawId) {
    const m = /^<@!?(\d{17,20})>$/.exec(rawId) ?? /^(\d{17,20})$/.exec(rawId);
    if (!m) throw new UserError("That doesn't look like a user ID. It's a long number (17-20 digits): turn on Developer Mode in Discord's settings (Advanced), right-click the person and choose Copy User ID. Leave it empty if you don't have it.");
    id = m[1];
  }
  const name = normalizeName(username);
  if (required && !id && !name) throw new UserError('Tell us who you are reporting: their username, their user ID, or both.');
  return { id, name: name || null };
}

// ------------------------------------------------------------------ matching against the watch log
const W1 = '[\\p{L}\\p{N}_]'; // a character that continues a name; a dot only does when a name character follows it ("bob." ends a sentence, "bob.smith" is another name)
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MIN_NAME = 3; // shorter names ("al", "x") appear everywhere; they only ever match on a user ID

/** User IDs written anywhere in some text (plain or as a mention). */
export function idsIn(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(/(?<!\d)(\d{17,20})(?!\d)/g)) if (SNOWFLAKE.test(m[1])) out.add(m[1]);
  return out;
}

/**
 * Which watch-log entries a new ticket touches.
 * @param {{openerId: string, openerNames: string[], reported?: {id: string|null, name: string|null}, text: string}} ticket
 * @param {{id: number, target_id: string|null, target_name: string|null}[]} entries
 * @returns {{entry: object, how: 'opener'|'id'|'opener-name'|'name', exact: boolean}[]}
 *   exact = a user ID matched. Everything else is "possible".
 */
export function matchWatch({ openerId, openerNames = [], reported = {}, text = '' }, entries) {
  const ids = idsIn(text);
  if (reported.id) ids.add(reported.id);
  const names = new Set(openerNames.map(normalizeName).filter(Boolean));
  const haystack = String(text ?? '').toLowerCase();
  const out = [];
  for (const entry of entries) {
    const tid = entry.target_id;
    if (tid && tid === openerId) { out.push({ entry, how: 'opener', exact: true }); continue; }
    if (tid && ids.has(tid)) { out.push({ entry, how: 'id', exact: true }); continue; }
    // the name the reporter typed, and the real username Discord had for the ID when it was logged
    for (const tname of [entry.target_name, entry.target_alias]) {
      if (!tname || tname.length < MIN_NAME) continue;
      if (names.has(tname)) { out.push({ entry, how: 'opener-name', exact: false }); break; }
      if (reported.name === tname) { out.push({ entry, how: 'name', exact: false }); break; }
      if (new RegExp(`(?<!${W1})(?<!${W1}\\.)${escapeRe(tname)}(?!${W1})(?!\\.${W1})`, 'iu').test(haystack)) { out.push({ entry, how: 'name', exact: false }); break; }
    }
  }
  return out;
}

const HOW = {
  opener: 'The person who opened this ticket is on the watch log (user ID match).',
  id: 'A user ID written in this ticket is on the watch log.',
  'opener-name': 'The person who opened this ticket has the same username as someone on the watch log.',
  name: 'A username written in this ticket matches someone on the watch log.',
};
const OUTCOME = { open: 'not reviewed yet', confirmed: 'confirmed by staff', unfounded: 'marked unfounded by staff' };
export const outcomeLabel = (s) => OUTCOME[s] ?? s;

/**
 * Staff-facing text for the matches: one block per watched person with every earlier report and its outcome.
 * Always says what kind of match it is, and that a report is an accusation.
 */
export function describeMatches(matches, allEntries) {
  const byWho = new Map();
  for (const m of matches) {
    const key = m.entry.target_id ?? `name:${m.entry.target_name}`;
    const g = byWho.get(key) ?? { how: m.how, exact: m.exact, who: m.entry.target_id ? `<@${m.entry.target_id}> (\`${m.entry.target_id}\`)` : `**${m.entry.target_name}**`, entries: [] };
    if (m.exact) { g.exact = true; g.how = m.how; }
    byWho.set(key, g);
  }
  const blocks = [];
  for (const [key, g] of byWho) {
    const all = allEntries.filter((e) => (e.target_id ? `${e.target_id}` === key : `name:${e.target_name}` === key));
    const tally = ['confirmed', 'unfounded', 'open'].map((s) => [s, all.filter((e) => e.status === s).length]).filter(([, n]) => n);
    blocks.push(`${g.exact ? '**Exact match**' : '**Possible match** (names are not unique)'}: ${g.who}\n${HOW[g.how]}\n${all.length} earlier report(s): ${tally.map(([s, n]) => `${n} ${s === 'open' ? 'not reviewed' : s}`).join(', ')}`);
  }
  return `${blocks.join('\n\n')}\n\n*A report is an accusation, not proof. Check the outcomes before acting.*`;
}

// ------------------------------------------------------------------ closing a ticket
/** The required close form. Every field except follow-up must have something in it. */
export const CLOSE_FIELDS = [
  { id: 'resolution', label: 'Resolution', style: 'short', required: true, max: 100, placeholder: 'e.g. Resolved, No action needed, Referred to an admin' },
  { id: 'reason', label: 'Why did you decide this?', style: 'paragraph', required: true, max: 800 },
  { id: 'action', label: 'Action taken', style: 'paragraph', required: true, max: 600, placeholder: 'What you did (warned, banned, removed a message...). Write "None" if nothing.' },
  { id: 'notes', label: 'Notes for other staff', style: 'paragraph', required: true, max: 800 },
  { id: 'followup', label: 'Follow-up needed (optional)', style: 'short', required: false, max: 200 },
];

export function readCloseForm(get) {
  const out = {};
  for (const f of CLOSE_FIELDS) {
    const v = String(get(f.id) ?? '').trim();
    if (f.required && !v) throw new UserError(`"${f.label}" is required - closing a ticket needs a resolution, a reason, the action taken and notes.`);
    out[f.id] = v.slice(0, f.max) || null;
  }
  return out;
}

/** How a ticket ended, for the history. */
export const CLOSE_KINDS = {
  staff: 'closed by staff',
  owner: 'closed by the member who opened it (no staff notes)',
  auto: 'auto-closed after inactivity',
  'no-notes': 'closed without notes',
};

/** Open tickets that have been quiet longer than `hours` (0 = never). */
export function inactive(ticket, now, hours) {
  return hours > 0 && ticket.status === 'open' && now - (ticket.lastActivity ?? ticket.createdAt) >= hours * 3600000;
}

/** Numbers for /ticket stats and the dashboard, from history rows (closed_at / opened_at / first_response_at are ms). */
export function summarize(rows, now, days = 30) {
  const since = now - days * 86400000;
  const recent = rows.filter((r) => r.opened_at >= since);
  const byCategory = {};
  for (const r of recent) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return {
    total: recent.length,
    byCategory,
    avgFirstResponseMs: avg(recent.filter((r) => r.first_response_at).map((r) => r.first_response_at - r.opened_at)),
    avgResolutionMs: avg(recent.filter((r) => r.closed_at).map((r) => r.closed_at - r.opened_at)),
    withoutNotes: recent.filter((r) => r.close_kind === 'no-notes').length,
    autoClosed: recent.filter((r) => r.close_kind === 'auto').length,
  };
}
