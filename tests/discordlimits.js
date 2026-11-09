/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Discord's own limits for messages and popups. The test world checks every message, reply, update and popup the bot
 * sends against these, so a message Discord would refuse (6 buttons in a row, a label that's too long...) fails the
 * test instead of failing in a real server. Numbers from Discord's API documentation.
 */
const toJSON = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);
export function discordProblems(payload, kind = 'message') {
  const out = [];
  if (!payload || typeof payload !== 'object') return out;
  const p = toJSON(payload);
  if (kind === 'modal') {
    if ((p.title ?? '').length > 45) out.push(`popup title over 45 characters: "${p.title}"`);
    if (!p.custom_id || p.custom_id.length > 100) out.push('popup custom id missing or over 100 characters');
    const rows = (p.components ?? []).map(toJSON);
    if (rows.length > 5) out.push(`popup has ${rows.length} rows (5 at most)`);
    for (const r of rows) for (const c of (r.components ?? (r.component ? [r.component] : [])).map(toJSON)) {
      const label = c.label ?? r.label;
      if (label && label.length > 45) out.push(`popup field label over 45 characters: "${label}"`);
      if (c.options && c.options.length > 25) out.push(`popup dropdown has ${c.options.length} options (25 at most)`);
      for (const o of c.options ?? []) { if ((o.label ?? '').length > 100) out.push(`popup option label over 100: "${o.label}"`); if ((o.description ?? '').length > 100) out.push(`popup option description over 100: "${o.description}"`); }
    }
    return out;
  }
  if (typeof p.content === 'string' && p.content.length > 2000) out.push(`message text is ${p.content.length} characters (2000 at most)`);
  const rows = (p.components ?? []).map(toJSON);
  if (rows.length > 5) out.push(`message has ${rows.length} rows of buttons/menus (5 at most)`);
  for (const r of rows) {
    const cs = (r.components ?? []).map(toJSON);
    const selects = cs.filter((c) => [3, 5, 6, 7, 8].includes(c.type));
    if (selects.length && cs.length > 1) out.push('a dropdown must be alone in its row');
    if (cs.length > 5) out.push(`a row has ${cs.length} buttons (5 at most): ${cs.map((c) => c.label ?? c.emoji?.name ?? '?').join(', ')}`);
    if (!cs.length) out.push('an empty row');
    for (const c of cs) {
      if (c.custom_id && c.custom_id.length > 100) out.push(`custom id over 100 characters: ${c.custom_id}`);
      if (c.label && c.label.length > 80) out.push(`button label over 80 characters: "${c.label}"`);
      if (c.type === 2 && !c.label && !c.emoji) out.push('a button with no label and no emoji');
      if (c.options) {
        if (c.options.length > 25 || !c.options.length) out.push(`a dropdown has ${c.options.length} options (1 to 25)`);
        for (const o of c.options) { if ((o.label ?? '').length > 100) out.push(`option label over 100: "${o.label}"`); if ((o.description ?? '').length > 100) out.push(`option description over 100: "${o.description}"`); if ((o.value ?? '').length > 100) out.push('option value over 100'); }
        if (new Set(c.options.map((o) => o.value)).size !== c.options.length) out.push('a dropdown has two options with the same value');
      }
      if (c.placeholder && c.placeholder.length > 150) out.push('dropdown placeholder over 150');
    }
  }
  const embeds = (p.embeds ?? []).map(toJSON);
  if (embeds.length > 10) out.push(`${embeds.length} embeds (10 at most)`);
  let total = 0;
  for (const e of embeds) {
    const t = e.title ?? '', d = e.description ?? '', f = e.footer?.text ?? '', a = e.author?.name ?? '';
    if (t.length > 256) out.push(`embed title over 256: "${t.slice(0, 40)}…"`);
    if (d.length > 4096) out.push(`embed description is ${d.length} characters (4096 at most)`);
    if (f.length > 2048) out.push('embed footer over 2048');
    if (a.length > 256) out.push('embed author over 256');
    if ((e.fields ?? []).length > 25) out.push(`embed has ${e.fields.length} fields (25 at most)`);
    for (const fl of e.fields ?? []) {
      if (!fl.name || fl.name.length > 256) out.push(`embed field name empty or over 256: "${String(fl.name).slice(0, 40)}"`);
      if (!fl.value || String(fl.value).length > 1024) out.push(`embed field "${fl.name}" value is ${String(fl.value ?? '').length} characters (1 to 1024)`);
    }
    total += t.length + d.length + f.length + a.length + (e.fields ?? []).reduce((s, x) => s + String(x.name).length + String(x.value).length, 0);
  }
  if (total > 6000) out.push(`embeds have ${total} characters in total (6000 at most)`);
  return out;
}
/** Every refusal seen during the run (the bot catches errors inside handlers, so they are also collected here). */
export const violations = (globalThis[Symbol.for('goodboy.tests.discordViolations')] ??= []);
/** Throws (and records) when a payload breaks Discord's limits. */
export function assertDiscordLimits(payload, kind = 'message', where = '') {
  const probs = discordProblems(payload, kind);
  if (!probs.length) return;
  const msg = `Discord would refuse this ${kind}${where ? ` (${where})` : ''}: ${probs.join('; ')}`;
  violations.push({ msg, stack: new Error().stack.split('\n').slice(2, 9).join('\n') });
  throw new Error(msg);
}
