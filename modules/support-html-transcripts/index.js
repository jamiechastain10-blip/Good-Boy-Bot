/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Add-on for the Support module: adds a styled HTML transcript format.
 * Select it with: /config set module:support key:transcriptFormat value:html
 * Demonstrates the add-on system: it declares which module/version it needs, and the
 * platform refuses to enable it unless that host is installed, compatible and enabled.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function render({ ticket, messages, guild }) {
  const rows = messages.map((m) => {
    const when = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 16);
    const files = [...m.attachments.values()].map((a) => `<div class="att">📎 <a href="${esc(a.url)}">${esc(a.name)}</a></div>`).join('');
    const embeds = m.embeds.length ? `<div class="att">[${m.embeds.length} embed(s)]</div>` : '';
    return `<div class="msg"><img src="${esc(m.author.displayAvatarURL?.({ extension: 'png', size: 64 }) ?? '')}" alt=""><div><b>${esc(m.author.tag)}</b> <span class="t">${when} UTC</span><div class="c">${esc(m.cleanContent)}</div>${files}${embeds}</div></div>`;
  }).join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Ticket #${ticket.number}</title><style>
body{background:#1e1f22;color:#dbdee1;font:14px system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px}
h1{font-size:20px}.meta{color:#949ba4;margin-bottom:16px}.msg{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #2b2d31}
.msg img{width:36px;height:36px;border-radius:50%;background:#2b2d31}.t{color:#949ba4;font-size:12px}.c{white-space:pre-wrap;word-break:break-word}
.att{font-size:13px;margin-top:4px}a{color:#00a8fc}</style></head><body>
<h1>Ticket #${ticket.number} · ${esc(ticket.typeLabel)}</h1>
<div class="meta">${esc(guild.name)} · opened by ${esc(ticket.openerTag)} · ${messages.length} message(s)</div>
${rows}
</body></html>`;
  return { name: `ticket-${String(ticket.number).padStart(3, '0')}.html`, data: html };
}

export default {
  name: 'support-html-transcripts',
  version: '1.0.0',
  type: 'addon',
  requires: { module: 'support', version: '>=1.0.0' },
  description: 'Adds styled HTML transcripts to the Support module.',
  async init(ctx) {
    ctx.hostApi.registerTranscriptFormat('html', render, 'support-html-transcripts');
  },
};
