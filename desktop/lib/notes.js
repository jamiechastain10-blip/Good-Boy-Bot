/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * What's new in the Windows app (3.0.1): reads the bot's CHANGELOG.md and splits each version into the short note
 * for members and the full list (the same rules as src/about.js, kept here because the app ships without that file).
 */
import fs from 'node:fs';
import path from 'node:path';

export function readNotes(botDir, limit = 6) {
  let text = '';
  try { text = fs.readFileSync(path.join(botDir, 'CHANGELOG.md'), 'utf8'); } catch { return []; }
  const sections = [];
  let cur = null;
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const h = /^##\s+(\S+)\s*$/.exec(raw);
    if (h) { cur = { version: h[1], lines: [] }; sections.push(cur); continue; }
    if (cur) cur.lines.push(raw);
  }
  return sections.slice(0, limit).map((s) => {
    const body = s.lines.join('\n').trim();
    const m = /<!--\s*members\s*-->([\s\S]*?)<!--\s*\/members\s*-->/i.exec(body);
    let notes = body.replace(/<!--\s*members\s*-->[\s\S]*?<!--\s*\/members\s*-->\n?/i, '').trim();
    const headline = (/^\*\*(.+?)\*\*$/m.exec(notes) ?? [])[1] ?? null;
    if (headline) notes = notes.replace(/^\*\*.+?\*\*$\n?/m, '').trim();
    return { version: s.version, headline, members: m ? m[1].trim() : null, notes };
  });
}
