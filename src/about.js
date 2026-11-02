/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Small pure helpers for /about, /whatsnew and the version line in the bot's Discord description.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Discord's limit for an application description. */
export const DESCRIPTION_MAX = 400;
const LINE = /^Good Boy v[0-9A-Za-z.+-]+ · Basic Ghost Labs$/;
export const versionLine = (version) => `Good Boy v${version} · Basic Ghost Labs`;

/**
 * Puts our version line on the LAST line of the description and leaves everything else exactly as the owner wrote it.
 * A line we added earlier is replaced, never duplicated. If the owner's text is too long, only the owner's text is
 * shortened (with "…") so the version line always fits.
 */
export function withVersionLine(current, version) {
  const line = versionLine(version);
  const lines = String(current ?? '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && (lines.at(-1).trim() === '' || LINE.test(lines.at(-1).trim()))) lines.pop();
  let mine = lines.join('\n');
  const room = DESCRIPTION_MAX - line.length - (mine ? 2 : 0);
  if (mine.length > room) mine = mine.slice(0, Math.max(0, room - 1)).trimEnd() + '…';
  return mine ? `${mine}\n\n${line}` : line;
}

/** CHANGELOG.md text -> [{ version, body }] newest first, in file order. */
export function parseChangelog(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const h = /^##\s+(\S+)\s*$/.exec(raw);
    if (h) { cur = { version: h[1], lines: [] }; out.push(cur); continue; }
    if (cur) cur.lines.push(raw);
  }
  return out.map((s) => ({ version: s.version, body: s.lines.join('\n').trim() }));
}

/** Markdown for one changelog section, trimmed to fit a Discord embed (max 4000 characters) without cutting a line in half. */
export function sectionForDiscord(section, max = 3800) {
  // The <!-- members --> markers are for Bot news; Discord would show them as text.
  const body = section.body.replace(/<!--\s*\/?members\s*-->\n?/gi, '').replace(/^\*\*(.+?)\*\*$/gm, '__**$1**__');
  if (body.length <= max) return body;
  const cut = body.slice(0, max);
  return cut.slice(0, cut.lastIndexOf('\n')).trimEnd() + '\n…\n*(Shortened. The full list is in CHANGELOG.md.)*';
}

export function readChangelog(root) {
  try { return parseChangelog(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')); } catch { return []; }
}
