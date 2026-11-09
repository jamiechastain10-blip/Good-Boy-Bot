/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * The little language custom commands can use (3.1). Everything is a {block}; blocks inside blocks work.
 *
 *   {user} {username} {server} {channel} {membercount} {date}   the usual placeholders
 *   {args}  everything typed after the command      {arg1} ... {arg9}  one word each      {argcount}
 *   {uses}  how many times this command was used
 *   {random: pizza | tacos | sushi}                 one of them, picked at random
 *   {number: 1-100}                                  a random whole number
 *   {if: {arg1} = yes | Great! | Oh no}             = != contains, or just {if: {args} | typed something | typed nothing}
 *
 * What members type is data, never code: braces and bars in it are kept as plain text.
 */
const OPEN = '\u0001', CLOSE = '\u0002', BAR = '\u0003';
/** Makes typed text inert: its braces and bars can't start or split a block. */
const inert = (v) => String(v ?? '').replace(/\{/g, OPEN).replace(/\}/g, CLOSE).replace(/\|/g, BAR);
const restore = (s) => s.replace(new RegExp(OPEN, 'g'), '{').replace(new RegExp(CLOSE, 'g'), '}').replace(new RegExp(BAR, 'g'), '|');

function test(cond) {
  const m = /^([\s\S]*?)\s*(!=|=|\bcontains\b)\s*([\s\S]*)$/i.exec(cond);
  if (!m) return cond.trim() !== '';
  const a = m[1].trim().toLowerCase(), b = m[3].trim().toLowerCase();
  return m[2] === '=' ? a === b : m[2] === '!=' ? a !== b : a.includes(b);
}

/** Fills in a custom command's text. vars: plain values (made inert). rand returns [0, 1). */
export function runTagScript(tpl, vars = {}, rand = Math.random) {
  const safe = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), inert(v)]));
  const resolve = (inner) => {
    const word = inner.trim().toLowerCase();
    if (/^\w+$/.test(word)) return word in safe ? safe[word] : null;
    let m;
    if ((m = /^\s*random\s*:([\s\S]*)$/i.exec(inner))) { const opts = m[1].split('|').map((x) => x.trim()); return opts[Math.floor(rand() * opts.length)] ?? ''; }
    if ((m = /^\s*number\s*:\s*(-?\d{1,9})\s*-\s*(-?\d{1,9})\s*$/i.exec(inner))) { const lo = Math.min(+m[1], +m[2]), hi = Math.max(+m[1], +m[2]); return String(lo + Math.floor(rand() * (hi - lo + 1))); }
    if ((m = /^\s*if\s*:([\s\S]*)$/i.exec(inner))) { const [cond, yes = '', no = ''] = m[1].split('|'); return (test(restore(cond)) ? yes : no).trim(); }
    return null; // not ours: left as typed
  };
  let s = String(tpl ?? '').slice(0, 4000);
  for (let pass = 0; pass < 25; pass++) {
    let changed = false;
    s = s.replace(/\{([^{}]*)\}/g, (all, inner) => { const r = resolve(inner); if (r == null) return OPEN + inner + CLOSE; changed = true; return r; });
    if (!changed) break;
  }
  return restore(s);
}

/** The placeholders for a message: args split into arg1..arg9. */
export function argVars(args) {
  const words = String(args ?? '').trim().split(/\s+/).filter(Boolean);
  return { args: words.join(' '), argcount: words.length, ...Object.fromEntries(Array.from({ length: 9 }, (_, k) => [`arg${k + 1}`, words[k] ?? ''])) };
}
