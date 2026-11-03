/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Add-on for the Support module: adds a styled HTML transcript format.
 * Select it with /config (or /modules): support > Edit settings > transcript format = html
 * Demonstrates the add-on system: it declares which module/version it needs, and the
 * platform refuses to enable it unless that host is installed, compatible and enabled.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function render({ ticket, messages, guild, summary = [], embedText = () => [] }) {
  const rows = messages.map((m) => {
    const when = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 16);
    const files = [...m.attachments.values()].map((a) => `<div class="att">📎 <a href="${esc(a.url)}">${esc(a.name)}</a></div>`).join('');
    const embeds = embedText(m).map((t) => `<div class="box">${esc(t)}</div>`).join('');
    return `<div class="msg"><img src="${esc(m.author.displayAvatarURL?.({ extension: 'png', size: 64 }) ?? '')}" alt=""><div><b>${esc(m.author.tag)}</b> <span class="t">${when} UTC</span><div class="c">${esc(m.cleanContent)}</div>${files}${embeds}</div></div>`;
  }).join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Ticket #${ticket.number}</title><style>
body{background:#1e1f22;color:#dbdee1;font:14px system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px}
h1{font-size:20px}.meta{color:#949ba4;margin-bottom:16px}.msg{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #2b2d31}
.msg img{width:36px;height:36px;border-radius:50%;background:#2b2d31}.t{color:#949ba4;font-size:12px}.c{white-space:pre-wrap;word-break:break-word}
.att{font-size:13px;margin-top:4px}a{color:#00a8fc}
.box{white-space:pre-wrap;border-left:3px solid #5865f2;background:#2b2d31;border-radius:4px;padding:8px 10px;margin-top:6px}
.why{background:#2b2d31;border-radius:8px;padding:12px 16px;margin-bottom:18px}.why h2{font-size:15px;margin:0 0 8px}
.why dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}.why dt{color:#949ba4}.why dd{margin:0;white-space:pre-wrap;word-break:break-word}</style></head><body>
<h1>Ticket #${ticket.number} · ${esc(ticket.typeLabel)}</h1>
<div class="meta">${esc(guild.name)} · opened by ${esc(ticket.openerTag)} · ${messages.length} message(s)</div>
${summary.length ? `<section class="why"><h2>Why this ticket was opened</h2><dl>${summary.map((r) => `<dt>${esc(r.label)}</dt><dd>${esc(r.value)}</dd>`).join('')}</dl></section>` : ''}
${rows}
</body></html>`;
  return { name: `ticket-${String(ticket.number).padStart(3, '0')}.html`, data: html };
}

export default {
  name: 'support-html-transcripts',
  version: '1.1.0',
  type: 'addon',
  requires: { module: 'support', version: '>=1.0.0' },
  description: 'Adds styled HTML transcripts to the Support module.',
  async init(ctx) {
    ctx.hostApi.registerTranscriptFormat('html', render, 'support-html-transcripts');
  },
};
