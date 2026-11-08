/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Support suite. Members pick what their ticket is about (each category has its own urgency), fill in a popup, and
 * get a private channel. Staff claim, set priority and close with a required popup (resolution, reason, action taken,
 * notes). Reports about a member go on a staff-only watch log, and later tickets that mention or come from a logged
 * person are flagged to staff. Every ticket - including ones whose channel was simply deleted - ends up in the history.
 *
 * The rules (categories, report parsing, watch-log matching, close form) live in src/tickets.js so they can be tested alone.
 * Add-ons can register extra transcript formats via the module API.
 */
import {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, AttachmentBuilder, ChannelType, PermissionFlagsBits as P, MessageFlags,
} from 'discord.js';
import { UserError, truncate, ts, getChannelOption, describeDiscordError } from '../../src/util.js';
import { formStore } from '../../src/forms.js';
import { formModal, readForm } from '../../src/modalkit.js';
import {
  URGENCY, CATEGORIES, CLOSE_FIELDS, CLOSE_KINDS, findCategory, questionsFor, parseReported, matchWatch, describeMatches,
  outcomeLabel, readCloseForm, inactive, summarize, normalizeName, reportedFrom, accountCreated, ageText,
} from '../../src/tickets.js';
import fs from 'node:fs';
import path from 'node:path';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const TICKET_PERMS = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];
const DAY = 86400000;
const forms = formStore('support');

// ------------------------------------------------------------------ transcript formats (extensible by add-ons)
const formats = new Map();
/** What a message's boxes (embeds) say, as plain text. The ticket's own reason lives in one, so it must not be dropped. */
export const embedText = (m) => (m.embeds ?? []).map((e) => {
  const d = e.data ?? e;
  return [d.title, d.description, ...(d.fields ?? []).map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join('\n');
}).filter(Boolean);
/**
 * Why the ticket was opened, for the top of every transcript (2.3.3: transcripts didn't say why). Only what the member
 * entered and what they can already see in the ticket; staff-only notes stay out because transcripts are DMed to them.
 */
export function ticketSummary(ticket) {
  const rows = [
    ['Type', ticket.typeLabel],
    ['Urgency', ticket.priority ? (URGENCY[ticket.priority]?.label ?? ticket.priority) : null],
    ['Opened by', ticket.openerTag],
    ['Opened', ticket.createdAt ? new Date(ticket.createdAt).toUTCString() : null],
    ['About', ticket.report?.name || ticket.report?.id || null],
    ...(ticket.answers ?? []).filter((a) => a.a).map((a) => [a.q, a.a]),
  ];
  if (ticket.status === 'closed') rows.push(['Closed', ticket.closedAt ? new Date(ticket.closedAt).toUTCString() : 'yes'], ['Close reason', ticket.closeReason ?? null]);
  return rows.filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '').map(([label, value]) => ({ label, value: String(value) }));
}
const lines = (messages) => messages.map((m) => {
  const when = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 16);
  const boxes = embedText(m).map((t) => `\n    ${t.replace(/\n/g, '\n    ')}`).join('');
  const files = [...m.attachments.values()].map((a) => a.url);
  return `[${when}] ${m.author.tag}: ${m.cleanContent}${files.length ? ' ' + files.join(' ') : ''}${boxes}`;
});
formats.set('txt', { owner: null, fn: ({ ticket, messages, guild, summary = ticketSummary(ticket) }) => ({
  name: `ticket-${String(ticket.number).padStart(3, '0')}.txt`,
  data: [`Ticket #${ticket.number} (${ticket.typeLabel}) - ${guild.name}`, '', 'WHY THIS TICKET WAS OPENED', ...summary.map((r) => `${r.label}: ${r.value}`), '-'.repeat(60), ...lines(messages), ''].join('\n'),
}) });

const ctxs = (globalThis[Symbol.for('goodboy.support.ctxs')] ??= new Map());
const api = {
  /** Is this channel an open or closed ticket? Other modules use it (Levels gives no XP in tickets). */
  isTicket(guildId, channelId) { return !!ctxs.get(guildId)?.data.get(`ticket:${channelId}`); },
  /** `owner` is the add-on's module name; the format only applies in servers where that add-on is enabled. */
  registerTranscriptFormat(name, fn, owner) { if (!/^[a-z0-9-]{2,20}$/.test(name) || typeof fn !== 'function') throw new Error('bad format'); formats.set(name, { fn, owner }); },
  formats,
};

// ------------------------------------------------------------------ helpers
const isStaff = (ctx, m) => ctx.perms.check(m, 'support.staff') || (!!ctx.config.get('staffRole') && m.roles.cache.has(ctx.config.get('staffRole')));
const need = (ctx, i, key) => { if (!ctx.perms.check(i.member, key)) throw new UserError(`You don't have permission for that (\`${key}\`).`); };
const staffRoleIds = (ctx) => [...new Set([...ctx.perms.rolesFor('support.staff'), ctx.config.get('staffRole')].filter((r) => r && ctx.guild.roles.cache.has(r)))];
const customTypes = (ctx) => ctx.data.get('types') ?? [];
const getTicket = (ctx, channelId) => ctx.data.get(`ticket:${channelId}`);
const saveTicket = (ctx, channelId, t) => ctx.data.set(`ticket:${channelId}`, t);
const slug = (s, max = 24) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);
const hidden = (ctx) => new Set(ctx.config.get('hiddenCategories') ?? []);
const catOf = (ctx, t) => findCategory(t.category ?? t.type, customTypes(ctx));
const urgencyOf = (t) => URGENCY[t.priority ?? 'normal'] ?? URGENCY.normal;
const numberTag = (t) => `#${String(t.number).padStart(3, '0')}`;

// Which channels are tickets, in memory, so the busy message event does not hit the database for every message in the server.
const ticketChannels = (globalThis[Symbol.for('goodboy.support.channels')] ??= new Map());
const chans = (ctx) => { let s = ticketChannels.get(ctx.guildId); if (!s) { s = new Set(ctx.data.list('ticket:').map((t) => t.key.slice(7))); ticketChannels.set(ctx.guildId, s); } return s; };

/** Where staff-only notices go (watch flags, close details): the watch channel, else the ticket log. */
function staffChannel(ctx) {
  for (const id of [ctx.config.get('watchChannel'), ctx.config.get('logChannel')]) {
    const ch = id && ctx.guild.channels.cache.get(id);
    if (ch?.isTextBased()) return ch;
  }
  return null;
}
async function logTo(ctx, payload, { staffOnly = false } = {}) {
  const ch = staffOnly ? staffChannel(ctx) : (ctx.guild.channels.cache.get(ctx.config.get('logChannel')) ?? null);
  if (ch?.isTextBased()) await ctx.queue(() => ch.send({ allowedMentions: NOPING, ...payload })).catch(() => {});
}

// ------------------------------------------------------------------ history (one row per ticket, kept after the channel is gone)
function historyEnsure(ctx, t, channelId) {
  ctx.sql.run(`INSERT OR IGNORE INTO support_history (guild_id, number, channel_id, opener_id, opener_tag, category, category_label, urgency, opened_at, first_response_at, claimed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ctx.guildId, t.number, channelId, t.opener, t.openerTag, t.category ?? t.type ?? 'other', t.typeLabel, t.priority ?? 'normal', t.createdAt, t.firstResponseAt ?? null, t.claimedBy ?? null);
}
/** Who the ticket is about, the answers and the kept files, for the archive. */
function historyDetails(ctx, t) {
  ctx.sql.run('UPDATE support_history SET reported_id = ?, reported_name = ?, details = ? WHERE guild_id = ? AND number = ?',
    t.report?.id ?? null, t.report?.name ?? t.people?.about?.name ?? null, JSON.stringify({ answers: t.answers ?? [], people: t.people ?? null, files: t.files ?? [] }), ctx.guildId, t.number);
}
function historyClose(ctx, t, channelId, f) {
  historyEnsure(ctx, t, channelId);
  ctx.sql.run(`UPDATE support_history SET closed_at = ?, closed_by = ?, close_kind = ?, resolution = ?, reason = ?, action_taken = ?, notes = ?, follow_up = ?, outcome = ?,
    urgency = ?, claimed_by = ?, first_response_at = ?, decision = ?, decision_reason = ? WHERE guild_id = ? AND number = ?`,
  f.at, f.by ?? null, f.kind, f.resolution ?? null, f.reason ?? null, f.action ?? null, f.notes ?? null, f.followup ?? null, f.outcome ?? null,
  t.priority ?? 'normal', t.claimedBy ?? null, t.firstResponseAt ?? null, t.decision?.result ?? null, t.decision?.reason ?? null, ctx.guildId, t.number);
}

// ------------------------------------------------------------------ watch log
const watchRows = (ctx) => ctx.sql.all('SELECT * FROM support_watch WHERE guild_id = ? ORDER BY id', ctx.guildId);
function watchAdd(ctx, e) {
  const r = ctx.sql.run(`INSERT INTO support_watch (guild_id, target_id, target_name, target_alias, reporter_id, ticket_number, category, summary, evidence, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`, ctx.guildId, e.targetId ?? null, e.targetName ?? null, e.alias ?? null, e.reporterId, e.ticketNumber ?? null, e.category ?? null,
  e.summary ? truncate(e.summary, 500) : null, e.evidence ? truncate(e.evidence, 500) : null, Date.now());
  return Number(r.lastInsertRowid);
}
async function realUsername(ctx, id) {
  const u = id ? await ctx.client.users.fetch(id).catch(() => null) : null;
  return u ? normalizeName(u.username) : null;
}
const watchLabel = (e) => `${e.target_id ? `<@${e.target_id}> (\`${e.target_id}\`)` : `**${e.target_name}**`}`;

// ------------------------------------------------------------------ the ticket message
const controlEmbed = (t) => {
  const u = urgencyOf(t);
  const e = new EmbedBuilder().setColor(u.color).setTitle(`Ticket ${numberTag(t)} · ${t.typeLabel}`)
    .setDescription(`Opened by <@${t.opener}> ${ts(t.createdAt)}\nStaff will be with you shortly.`)
    .addFields({ name: 'Status', value: t.claimedBy ? `Claimed by <@${t.claimedBy}>` : 'Waiting for staff', inline: true }, { name: 'Urgency', value: u.label, inline: true });
  for (const a of t.answers ?? []) if (a.a) e.addFields({ name: truncate(a.q, 250), value: truncate(a.a, 1000) });
  if (t.decision) e.addFields({ name: `Appeal ${t.decision.result}`, value: truncate(t.decision.message || 'The staff team has made a decision.', 500) });
  return e;
};
const controlRows = (t, cat) => {
  const rows = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:claim').setLabel(t.claimedBy ? 'Unclaim' : 'Claim').setStyle(ButtonStyle.Primary).setEmoji('🙋'),
    new ButtonBuilder().setCustomId('ticket:close').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
    new ButtonBuilder().setCustomId('ticket:prio').setLabel('Priority').setStyle(ButtonStyle.Secondary).setEmoji('🚦'),
    new ButtonBuilder().setCustomId('ticket:transcript').setLabel('Transcript').setStyle(ButtonStyle.Secondary).setEmoji('📄'),
  )];
  if (cat?.appeal && !t.decision) rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:appeal:approve').setLabel('Approve appeal').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId('ticket:appeal:deny').setLabel('Deny appeal').setStyle(ButtonStyle.Danger).setEmoji('⛔'),
  ));
  return rows;
};
const closedRow = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('ticket:reopen').setLabel('Reopen').setStyle(ButtonStyle.Success).setEmoji('🔓'),
  new ButtonBuilder().setCustomId('ticket:delete').setLabel('Delete').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
);
const refreshControl = async (ctx, channel, t) => {
  const cat = catOf(ctx, t);
  const msg = t.controlMessageId ? await channel.messages.fetch(t.controlMessageId).catch(() => null) : null;
  await msg?.edit({ embeds: [controlEmbed(t)], components: controlRows(t, cat) }).catch(() => {});
};

async function makeTranscript(ctx, channel, ticket) {
  const messages = [];
  let before;
  for (let n = 0; n < 10; n++) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    messages.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  messages.reverse();
  const want = ctx.config.get('transcriptFormat');
  let entry = formats.get(want);
  if (!entry || (entry.owner && !ctx.isActive(entry.owner))) {
    if (want !== 'txt') ctx.log.warn(`Transcript format "${want}" isn't available (is its add-on enabled?) - using txt`);
    entry = formats.get('txt');
  }
  const out = await entry.fn({ ticket, messages, guild: ctx.guild, channel, summary: ticketSummary(ticket), embedText });
  return new AttachmentBuilder(Buffer.from(out.data), { name: out.name });
}

// ------------------------------------------------------------------ popups
const STYLE = { short: TextInputStyle.Short, paragraph: TextInputStyle.Paragraph };
function modalFrom(customId, title, fields) {
  const m = new ModalBuilder().setCustomId(customId).setTitle(truncate(title, 45));
  for (const f of fields) {
    const t = new TextInputBuilder().setCustomId(f.id).setLabel(truncate(f.label, 45)).setStyle(STYLE[f.style]).setRequired(f.required).setMaxLength(f.max);
    if (f.placeholder) t.setPlaceholder(truncate(f.placeholder, 100));
    m.addComponents(new ActionRowBuilder().addComponents(t));
  }
  return m;
}
const getter = (i) => (id) => { try { return i.fields.getTextInputValue(id); } catch { return ''; } };
const REASON = (label = 'Reason (kept in the staff log)') => ({ id: 'reason', label, style: 'paragraph', required: true, max: 800 });

// ------------------------------------------------------------------ opening a ticket
function checkLimit(ctx, user) {
  const max = ctx.config.get('maxOpenPerUser');
  const mine = ctx.data.list('ticket:').filter((t) => t.value.opener === user.id && t.value.status === 'open');
  if (mine.length >= max) throw new UserError(`You already have ${mine.length} open ticket(s): ${mine.map((t) => `<#${t.key.slice(7)}>`).join(' ')}`);
}

// ------------------------------------------------------------------ evidence, member cards and the archive
const MAX_FILE = 25 * 1024 * 1024, MAX_REPOST = 10 * 1024 * 1024, MAX_TOTAL = 60 * 1024 * 1024;
const safeName = (n) => String(n ?? 'file').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'file';
/** Downloads files straight away: Discord's links to uploads stop working after about a day. Returns { name, buf, contentType, size, error }. */
async function download(files, fetchFn = globalThis.fetch) {
  const out = [];
  let total = 0;
  for (const f of files.slice(0, 10)) {
    if (!/^https:\/\//.test(f.url)) { out.push({ ...f, error: 'not a Discord file link' }); continue; }
    if (f.size > MAX_FILE || total + (f.size ?? 0) > MAX_TOTAL) { out.push({ ...f, error: 'too big to keep' }); continue; }
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetchFn(f.url, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_FILE) throw new Error('too big to keep');
      total += buf.length;
      out.push({ name: safeName(f.name), buf, contentType: f.contentType, size: buf.length });
    } catch (e) { out.push({ ...f, error: e.name === 'AbortError' ? 'took too long to download' : e.message }); } finally { clearTimeout(t); }
  }
  return out;
}
/** Keeps a ticket file on this computer. Returns the stored name. */
function keepFile(ctx, number, prefix, name, buf) {
  const stored = `${prefix}-${safeName(name)}`;
  fs.writeFileSync(path.join(ctx.fileDir('tickets', number), stored), buf);
  return stored;
}

/** A member's card: name, id, account age and when they joined (or that they are not in the server). */
async function personCard(ctx, id, fallbackName = null) {
  if (!id) return { id: null, name: fallbackName, lines: [`**${fallbackName ?? 'Unknown'}** · no user ID given`], avatar: null, inServer: false };
  const member = await ctx.guild?.members.fetch(id).catch(() => null);
  const user = member?.user ?? await ctx.client?.users?.fetch?.(id).catch(() => null);
  const name = user?.username ?? fallbackName ?? id;
  let made = null; try { made = accountCreated(id); } catch { /* not an id */ }
  const lines = [`**${member?.displayName && member.displayName !== name ? `${member.displayName} (@${name})` : `@${name}`}** · \`${id}\``];
  if (made) lines.push(`Account made <t:${Math.floor(made / 1000)}:D> (${ageText(made)} ago)`);
  lines.push(member?.joinedTimestamp ? `Joined <t:${Math.floor(member.joinedTimestamp / 1000)}:D> (${ageText(member.joinedTimestamp)} ago)` : member ? 'In the server' : 'Not in the server');
  return { id, name, lines, avatar: user?.displayAvatarURL?.({ size: 128 }) ?? null, inServer: !!member, created: made, joined: member?.joinedTimestamp ?? null };
}

/** What staff should know about someone: their moderation history, reports about them and their earlier tickets. Staff only. */
function staffFacts(ctx, id) {
  if (!id) return null;
  const hist = ctx.api('moderation')?.history?.(ctx.guildId, id) ?? [];
  const count = (t) => hist.filter((e) => e.type === t).length;
  const reports = ctx.sql.all('SELECT status, ticket_number, created_at FROM support_watch WHERE guild_id = ? AND target_id = ? ORDER BY id DESC', ctx.guildId, id);
  const tickets = ctx.sql.get('SELECT COUNT(*) AS n FROM support_history WHERE guild_id = ? AND opener_id = ?', ctx.guildId, id).n;
  const last = hist.slice(0, 3).map((e) => `· ${e.type} <t:${Math.floor(e.at / 1000)}:d>${e.reason ? `: ${truncate(e.reason, 60)}` : ''}`);
  return {
    warnings: count('warn'), timeouts: count('timeout'), kicks: count('kick'), bans: count('ban'), reports: reports.length,
    confirmed: reports.filter((r) => r.status === 'confirmed').length, tickets,
    text: [`Warnings **${count('warn')}** · timeouts **${count('timeout')}** · kicks **${count('kick')}** · bans **${count('ban')}**`,
      `Reported **${reports.length}** time${reports.length === 1 ? '' : 's'} before${reports.length ? ` (${reports.filter((r) => r.status === 'confirmed').length} confirmed)` : ''} · opened **${tickets}** ticket${tickets === 1 ? '' : 's'}`,
      ...last].join('\n'),
  };
}

/** Saves one ticket message in the archive (and its attachments on this computer). */
async function archiveMessage(ctx, number, message, { fetchFn } = {}) {
  const files = [...(message.attachments?.values?.() ?? [])].map((a) => ({ name: a.name, url: a.url, size: a.size, contentType: a.contentType }));
  const kept = [];
  if (files.length) {
    for (const [k, f] of (await download(files, fetchFn)).entries()) kept.push(f.error ? { name: safeName(f.name), error: f.error } : { name: f.name, stored: keepFile(ctx, number, `${message.id}-${k}`, f.name, f.buf), size: f.size, contentType: f.contentType ?? null });
  }
  const embeds = (message.embeds ?? []).map((e) => { const d = e.toJSON?.() ?? e.data ?? e; return { title: d.title ?? null, description: d.description ?? null, fields: (d.fields ?? []).map((x) => ({ name: x.name, value: x.value })), color: d.color ?? null }; });
  ctx.sql.run(`INSERT OR REPLACE INTO support_archive (guild_id, number, message_id, channel_id, author_id, author_name, author_avatar, bot, content, embeds, attachments, created_at, edited_at, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`, ctx.guildId, number, message.id, message.channelId, message.author?.id ?? null,
  message.member?.displayName ?? message.author?.globalName ?? message.author?.username ?? 'Unknown', message.author?.displayAvatarURL?.({ size: 64 }) ?? null,
  message.author?.bot ? 1 : 0, String(message.content ?? ''), JSON.stringify(embeds), JSON.stringify(kept), message.createdTimestamp ?? Date.now());
  const text = [message.content, ...embeds.flatMap((e) => [e.title, e.description, ...e.fields.map((x) => `${x.name} ${x.value}`)])].filter(Boolean).join('\n');
  ctx.sql.run('DELETE FROM support_archive_fts WHERE guild_id = ? AND message_id = ?', ctx.guildId, message.id);
  if (text) ctx.sql.run('INSERT INTO support_archive_fts (content, guild_id, number, message_id) VALUES (?, ?, ?, ?)', text, ctx.guildId, number, message.id);
}

async function openTicket(ctx, i, cat, answers, reported, files = []) {
  await i.deferReply({ flags: EPH });
  const guild = i.guild;
  checkLimit(ctx, i.user);
  const evidence = files.length ? await download(files) : [];

  const number = ctx.data.update('counter', (n) => n + 1, 0);
  const staffIds = staffRoleIds(ctx);
  const catId = cat.categoryId || ctx.config.get('ticketCategory');
  const parent = catId && guild.channels.cache.get(catId)?.type === ChannelType.GuildCategory ? catId : undefined;
  const channel = await guild.channels.create({
    name: `ticket-${slug(i.user.username, 16) || 'user'}-${String(number).padStart(3, '0')}`,
    type: ChannelType.GuildText, parent,
    topic: `Ticket #${number} · ${i.user.tag} · ${cat.label} · ${URGENCY[cat.urgency].label}`,
    permissionOverwrites: [
      { id: guild.id, deny: [P.ViewChannel] },
      { id: i.user.id, allow: TICKET_PERMS },
      ...staffIds.map((id) => ({ id, allow: [...TICKET_PERMS, P.ManageMessages] })),
      { id: ctx.client.user.id, allow: [...TICKET_PERMS, P.ManageChannels] },
    ],
    reason: `Ticket #${number} for ${i.user.tag}`,
  }).catch(() => { throw new UserError("I couldn't create the ticket channel - I need **Manage Channels** (and the category must have room: Discord caps categories at 50 channels)."); });

  const now = Date.now();
  const ticket = {
    number, opener: i.user.id, openerTag: i.user.tag, type: cat.id, category: cat.id, typeLabel: cat.label, status: 'open', claimedBy: null,
    priority: cat.urgency, createdAt: now, lastActivity: now, answers, report: reported?.id || reported?.name ? { id: reported.id, name: reported.name } : null,
    files: evidence.map((f, k) => (f.error ? { name: safeName(f.name), error: f.error } : { name: f.name, stored: keepFile(ctx, number, `evidence-${k}`, f.name, f.buf), size: f.size })),
  };

  // Does this ticket touch anyone already on the watch log? (Checked before this ticket's own report is added.)
  const earlier = watchRows(ctx);
  const matches = matchWatch({
    openerId: i.user.id, openerNames: [i.user.username, i.user.globalName, i.member?.displayName].filter(Boolean),
    reported: { id: reported?.id ?? null, name: reported?.name ?? null }, text: answers.map((a) => a.a).join('\n'),
  }, earlier);

  if (ticket.report && ticket.report.id !== i.user.id) {
    const real = await realUsername(ctx, ticket.report.id); // the account's real username, so later tickets can match it too
    ticket.report.watchId = watchAdd(ctx, {
      targetId: ticket.report.id, targetName: ticket.report.name ?? real, alias: real && real !== (ticket.report.name ?? real) ? real : null,
      reporterId: i.user.id, ticketNumber: number, category: cat.id, summary: answers.find((a) => /happened/i.test(a.q))?.a, evidence: answers.find((a) => /evidence/i.test(a.q))?.a,
    });
  }
  ticket.flagCount = new Set(matches.map((m) => m.entry.id)).size;
  saveTicket(ctx, channel.id, ticket);
  chans(ctx).add(channel.id);
  ctx.data.update('stats', (s) => ({ ...s, opened: (s.opened ?? 0) + 1 }), {});
  historyEnsure(ctx, ticket, channel.id);

  const sent = await channel.send({ content: `<@${i.user.id}> ${staffIds.map((r) => `<@&${r}>`).join(' ')}`, embeds: [controlEmbed(ticket)], components: controlRows(ticket, cat), allowedMentions: { users: [i.user.id], roles: staffIds } });
  ticket.controlMessageId = sent.id; saveTicket(ctx, channel.id, ticket);

  // Who is involved, filled in automatically (public details only; the staff log gets the history).
  const opener = await personCard(ctx, i.user.id);
  const about = ticket.report ? await personCard(ctx, ticket.report.id, ticket.report.name) : null;
  const cards = new EmbedBuilder().setColor(urgencyOf(ticket).color).setTitle('Who is involved')
    .addFields({ name: 'Opened by', value: opener.lines.join('\n'), inline: true }, ...(about ? [{ name: cat.report ? 'About' : 'Mentioned', value: about.lines.join('\n'), inline: true }] : []));
  if (about?.avatar) cards.setThumbnail(about.avatar);
  await channel.send({ embeds: [cards], allowedMentions: NOPING }).catch(() => {});
  ticket.people = { opener: { id: opener.id, name: opener.name, created: opener.created, joined: opener.joined }, about: about ? { id: about.id, name: about.name, created: about.created ?? null, joined: about.joined ?? null, inServer: about.inServer } : null };
  // Evidence: posted in the ticket so staff can see it, and kept on this computer for the archive.
  const okFiles = evidence.filter((f) => !f.error);
  const repost = okFiles.filter((f) => f.size <= MAX_REPOST);
  const missed = evidence.filter((f) => f.error).map((f) => `${f.name} (${f.error})`);
  if (okFiles.length || missed.length) {
    await channel.send({ content: [`📎 Evidence from <@${i.user.id}>`, okFiles.length > repost.length ? `${okFiles.length - repost.length} large file(s) are kept in the ticket archive on the bot's computer.` : null, missed.length ? `Could not keep: ${missed.join(', ')}` : null].filter(Boolean).join('\n'),
      files: repost.map((f) => new AttachmentBuilder(f.buf, { name: f.name })), allowedMentions: NOPING }).catch(() => {});
  }
  saveTicket(ctx, channel.id, ticket);
  historyDetails(ctx, ticket);
  const facts = staffFacts(ctx, ticket.report?.id ?? null);
  const openerFacts = staffFacts(ctx, i.user.id);
  if (facts || ticket.report || openerFacts?.reports) {
    const staffInfo = new EmbedBuilder().setColor(urgencyOf(ticket).color).setTitle(`Ticket ${numberTag(ticket)} · background`).setDescription(`<#${channel.id}> · only staff see this.`);
    if (about) staffInfo.addFields({ name: `About ${about.name ? `@${about.name}` : 'them'}`, value: [about.lines.slice(1).join(' · '), facts?.text ?? 'No user ID, so no history to look up.'].filter(Boolean).join('\n').slice(0, 1024) });
    if (openerFacts) staffInfo.addFields({ name: `Opened by @${opener.name}`, value: openerFacts.text.slice(0, 1024) });
    if (about?.avatar) staffInfo.setThumbnail(about.avatar);
    await logTo(ctx, { embeds: [staffInfo] }, { staffOnly: true });
  }

  await logTo(ctx, { embeds: [new EmbedBuilder().setColor(urgencyOf(ticket).color).setTitle(`${cat.urgency === 'urgent' ? '🚨 ' : ''}Ticket opened`).setDescription(`${numberTag(ticket)} (${cat.label}) · ${URGENCY[cat.urgency].label} · by <@${i.user.id}> → <#${channel.id}>`).setTimestamp()] });
  if (matches.length) {
    await logTo(ctx, {
      content: staffIds.map((r) => `<@&${r}>`).join(' ') || undefined, allowedMentions: { roles: staffIds },
      embeds: [new EmbedBuilder().setColor(0xfaa61a).setTitle(`⚠️ Watch-log match · ticket ${numberTag(ticket)}`).setDescription(`${describeMatches(matches, earlier)}\n\nTicket: <#${channel.id}> - this is only shown to staff.`).setTimestamp()],
    }, { staffOnly: true });
  }
  await i.editReply({ content: `Your ticket is ready: <#${channel.id}>` });
}

// ------------------------------------------------------------------ closing
/**
 * kind: 'staff' (with the required `form`), 'owner' (the member closed their own ticket), 'auto' (inactivity).
 * Staff notes, reasons and actions go to the staff log and the history - never into the ticket channel the member can read.
 */
async function closeTicket(ctx, channel, ticket, closer, { kind, form = null, outcome = null, reason = null }) {
  const at = Date.now();
  ticket.status = 'closed'; ticket.closedBy = closer.id; ticket.closedAt = at; ticket.closeKind = kind;
  const resolution = form?.resolution ?? (kind === 'auto' ? 'Auto-closed (inactive)' : kind === 'owner' ? 'Closed by the member' : null);
  const why = form?.reason ?? reason ?? (kind === 'auto' ? `No activity for ${ctx.config.get('autoCloseHours')} hours.` : null);
  ticket.closeReason = why;
  saveTicket(ctx, channel.id, ticket);
  ctx.data.update('stats', (s) => ({ ...s, closed: (s.closed ?? 0) + 1 }), {});
  historyClose(ctx, ticket, channel.id, { at, by: kind === 'auto' ? null : closer.id, kind, resolution, reason: why, action: form?.action, notes: form?.notes, followup: form?.followup, outcome });

  if (ticket.report?.watchId && (outcome === 'confirmed' || outcome === 'unfounded')) {
    ctx.sql.run('UPDATE support_watch SET status = ?, outcome_by = ?, outcome_note = ?, outcome_at = ? WHERE id = ? AND guild_id = ?', outcome, closer.id, why ? truncate(why, 500) : null, at, ticket.report.watchId, ctx.guildId);
  }

  await channel.permissionOverwrites.edit(ticket.opener, { SendMessages: false }, { reason: 'Ticket closed' }).catch(() => {});
  const publicNote = kind === 'auto'
    ? `This ticket was **closed automatically** after ${ctx.config.get('autoCloseHours')} hours without activity. Press Reopen if you still need help.`
    : `Closed by <@${closer.id}>${resolution ? `\nResolution: ${truncate(resolution, 200)}` : ''}${kind === 'owner' && why ? `\nReason: ${truncate(why, 500)}` : ''}`;
  await channel.send({ embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('Ticket closed').setDescription(publicNote)], components: [closedRow()], allowedMentions: NOPING }).catch(() => {});

  const file = await makeTranscript(ctx, channel, ticket).catch((e) => { ctx.log.error(`Transcript failed: ${e.message}`); return null; });
  const e = new EmbedBuilder().setColor(0xed4245).setTitle(`Ticket ${numberTag(ticket)} closed · ${CLOSE_KINDS[kind]}`)
    .setDescription(`${ticket.typeLabel} · opened by <@${ticket.opener}> · ${kind === 'auto' ? 'closed automatically' : `closed by <@${closer.id}>`}`).setTimestamp();
  if (resolution) e.addFields({ name: 'Resolution', value: truncate(resolution, 300) });
  if (form) e.addFields({ name: 'Reason', value: truncate(form.reason, 900) }, { name: 'Action taken', value: truncate(form.action, 700) }, { name: 'Notes', value: truncate(form.notes, 900) });
  else if (why) e.addFields({ name: 'Reason', value: truncate(why, 900) });
  if (form?.followup) e.addFields({ name: '⏭️ Follow-up needed', value: truncate(form.followup, 300) });
  if (outcome) e.addFields({ name: 'Report outcome', value: outcome === 'inconclusive' ? 'Inconclusive - the watch-log entry stays open' : `Marked **${outcome}** on the watch log`, inline: true });
  if (ticket.decision) e.addFields({ name: `Appeal ${ticket.decision.result}`, value: truncate(ticket.decision.reason, 500), inline: true });
  await logTo(ctx, { embeds: [e], files: file ? [file] : [] });
  if (file && ctx.config.get('dmTranscript')) {
    const user = await ctx.client.users.fetch(ticket.opener).catch(() => null);
    await user?.send({ content: `Transcript of your ticket ${numberTag(ticket)} in **${truncate(ctx.guild.name, 60)}**:`, files: [file] }).catch(() => {});
  }
}

/** The popup staff must fill in to close a ticket. Report tickets pick an outcome first (a button), so it is never typed. */
const closeModal = (token) => modalFrom(`ticket:cf:${token}`, 'Close ticket', CLOSE_FIELDS);
const OUTCOMES = [['confirmed', 'The report was right', ButtonStyle.Danger], ['unfounded', 'The report was wrong', ButtonStyle.Success], ['inconclusive', 'Not enough to say', ButtonStyle.Secondary]];
const outcomePrompt = () => ({ content: '**How did the report turn out?** This is recorded on the staff watch log.', flags: EPH, components: [new ActionRowBuilder().addComponents(
  ...OUTCOMES.map(([id, label, style]) => new ButtonBuilder().setCustomId(`ticket:outcome:${id}`).setLabel(label).setStyle(style)))] });

/** Staff pressing Close (button or command): outcome buttons for reports, otherwise straight to the popup. First response either way. */
async function startStaffClose(ctx, i, ticket) {
  if (ticket.status !== 'open') throw new UserError('This ticket is already closed.');
  if (catOf(ctx, ticket)?.report && ticket.report?.watchId) return i.reply(outcomePrompt());
  return i.showModal(closeModal(forms.put({ by: i.user.id, kind: 'close', channelId: i.channelId, outcome: null })));
}

// ------------------------------------------------------------------ component router (buttons + popups)
async function onComponent(ctx, i) {
  const [, action, arg] = i.customId.split(':');

  if (action === 'open') {
    const cat = findCategory(arg, customTypes(ctx));
    if (!cat || hidden(ctx).has(cat.id)) throw new UserError('That kind of ticket is not available any more.');
    checkLimit(ctx, i.user);
    return i.showModal(formModal(`ticket:form:${cat.id}`, cat.label, questionsFor(cat)));
  }
  if (action === 'form') {
    const cat = findCategory(arg, customTypes(ctx));
    if (!cat || hidden(ctx).has(cat.id)) throw new UserError('That kind of ticket is not available any more.');
    const qs = questionsFor(cat);
    const v = readForm(i, qs);
    const asked = qs.filter((q) => (q.kind === 'text' || q.kind === 'paragraph') && q.id !== 'outside');
    const answers = asked.map((q) => ({ q: q.label.replace(/ \(.*\)$/, ''), a: String(v[q.id] ?? '').trim() })).filter((a, n) => a.a || asked[n].required);
    const reported = cat.report ? reportedFrom({ who: v.who, outside: v.outside }, { required: cat.report === 'required' }) : null;
    return openTicket(ctx, i, cat, answers, reported, v.files ?? []);
  }

  // ---- watch-log popups (not inside a ticket channel)
  if (action === 'wf') return watchForm(ctx, i, arg);

  const ticket = i.channel ? getTicket(ctx, i.channelId) : null;
  if (!ticket) throw new UserError("This isn't a ticket channel anymore.");
  const staff = isStaff(ctx, i.member);
  const owner = i.user.id === ticket.opener;
  const cat = catOf(ctx, ticket);

  if (action === 'claim') {
    if (!staff) throw new UserError('Only staff can claim tickets.');
    if (ticket.claimedBy && ticket.claimedBy !== i.user.id && !ctx.perms.isAdmin(i.member)) throw new UserError(`Already claimed by <@${ticket.claimedBy}>.`);
    ticket.claimedBy = ticket.claimedBy === i.user.id ? null : i.user.id;
    saveTicket(ctx, i.channelId, ticket);
    await i.update({ embeds: [controlEmbed(ticket)], components: controlRows(ticket, cat) });
    return i.channel.send({ content: ticket.claimedBy ? `🙋 <@${i.user.id}> claimed this ticket.` : `<@${i.user.id}> released this ticket.`, allowedMentions: NOPING });
  }

  if (action === 'close') {
    if (staff) return startStaffClose(ctx, i, ticket);
    if (!owner) throw new UserError('Only staff or the ticket owner can close this.');
    if (ticket.status !== 'open') throw new UserError('This ticket is already closed.');
    return i.reply({ content: 'Close this ticket?', flags: EPH, components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket:confirm').setLabel('Yes, close it').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('ticket:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary))] });
  }
  if (action === 'outcome') {
    if (!staff) throw new UserError('Only staff can close tickets.');
    if (ticket.status !== 'open') throw new UserError('This ticket is already closed.');
    return i.showModal(closeModal(forms.put({ by: i.user.id, kind: 'close', channelId: i.channelId, outcome: arg })));
  }
  if (action === 'cf') {
    const f = forms.take(arg, i.user.id);
    if (!staff) throw new UserError('Only staff can close tickets.');
    if (f.channelId !== i.channelId || ticket.status !== 'open') throw new UserError('This ticket is already closed.');
    const form = readCloseForm(getter(i));
    await i.deferReply({ flags: EPH });
    await closeTicket(ctx, i.channel, ticket, i.user, { kind: 'staff', form, outcome: f.outcome });
    return i.editReply({ content: 'Ticket closed. Your notes are in the staff log.' });
  }
  if (action === 'cancel') return i.update({ content: 'Cancelled.', components: [] });
  if (action === 'confirm') {
    if (staff || !owner) throw new UserError(staff ? 'Staff close tickets with the Close button (it asks for notes).' : 'Only staff or the ticket owner can close this.');
    if (ticket.status !== 'open') return i.update({ content: 'Already closed.', components: [] });
    await i.update({ content: 'Closing…', components: [] });
    return closeTicket(ctx, i.channel, ticket, i.user, { kind: 'owner' });
  }
  if (action === 'reopen') {
    if (!staff && !owner) throw new UserError('Only staff or the ticket owner can reopen this.');
    if (ticket.status !== 'closed') throw new UserError('This ticket is already open.');
    ticket.status = 'open'; ticket.lastActivity = Date.now(); delete ticket.closedAt; delete ticket.closeKind;
    saveTicket(ctx, i.channelId, ticket);
    ctx.sql.run('UPDATE support_history SET closed_at = NULL, closed_by = NULL, close_kind = NULL, reopened = reopened + 1 WHERE guild_id = ? AND number = ?', ctx.guildId, ticket.number);
    await i.channel.permissionOverwrites.edit(ticket.opener, { SendMessages: true }).catch(() => {});
    await i.update({ components: [] });
    return i.channel.send({ content: `🔓 Reopened by <@${i.user.id}>.`, components: controlRows(ticket, cat), allowedMentions: NOPING });
  }
  if (action === 'delete') {
    if (!staff) throw new UserError('Only staff can delete tickets.');
    const secs = ctx.config.get('deleteDelaySeconds');
    await i.update({ components: [] });
    await i.channel.send({ content: `🗑️ Deleting this channel in ${secs} seconds.` });
    historyEnsure(ctx, ticket, i.channelId);
    ctx.data.delete(`ticket:${i.channelId}`); chans(ctx).delete(i.channelId);
    const ch = i.channel;
    setTimeout(() => ch.delete(`Ticket deleted by ${i.user.tag}`).catch(() => {}), secs * 1000).unref?.();
    return;
  }
  if (action === 'transcript') {
    if (!staff) throw new UserError('Only staff can pull transcripts.');
    await i.deferReply({ flags: EPH });
    return i.editReply({ files: [await makeTranscript(ctx, i.channel, ticket)] });
  }

  // ---- priority: pick a level, then say why (required)
  if (action === 'prio') {
    if (!staff) throw new UserError('Only staff can change priority.');
    return i.reply({ content: 'New priority?', flags: EPH, components: [new ActionRowBuilder().addComponents(
      ...Object.entries(URGENCY).map(([k, u]) => new ButtonBuilder().setCustomId(`ticket:level:${k}`).setLabel(u.label.replace(/^\S+ /, '')).setEmoji(u.label.split(' ')[0]).setStyle(ButtonStyle.Secondary)))] });
  }
  if (action === 'level') return askPriorityReason(ctx, i, ticket, arg);
  if (action === 'pf') {
    const f = forms.take(arg, i.user.id);
    if (!staff) throw new UserError('Only staff can change priority.');
    return applyPriority(ctx, i, ticket, f.level, readReason(i));
  }

  // ---- appeal decisions (required reason)
  if (action === 'appeal') {
    if (!staff) throw new UserError('Only staff can decide appeals.');
    if (!cat?.appeal) throw new UserError('This is not an appeal.');
    if (ticket.decision) throw new UserError('A decision has already been made.');
    return i.showModal(modalFrom(`ticket:af:${forms.put({ by: i.user.id, kind: 'appeal', result: arg === 'approve' ? 'approved' : 'denied', channelId: i.channelId })}`,
      arg === 'approve' ? 'Approve this appeal' : 'Deny this appeal', [REASON('Why? (kept in the staff log)'), { id: 'message', label: 'Message to the member (optional)', style: 'paragraph', required: false, max: 600 }]));
  }
  if (action === 'af') {
    const f = forms.take(arg, i.user.id);
    if (!staff) throw new UserError('Only staff can decide appeals.');
    if (ticket.decision) throw new UserError('A decision has already been made.');
    const get = getter(i);
    const reason = String(get('reason')).trim();
    if (!reason) throw new UserError('A reason is required for an appeal decision.');
    ticket.decision = { result: f.result, reason: truncate(reason, 800), message: String(get('message')).trim() || null, by: i.user.id, at: Date.now() };
    saveTicket(ctx, i.channelId, ticket);
    await i.reply({ content: `Appeal ${f.result}. Your reason is in the staff log.`, flags: EPH });
    await i.channel.send({ content: `<@${ticket.opener}>`, embeds: [new EmbedBuilder().setColor(f.result === 'approved' ? 0x57f287 : 0xed4245).setTitle(`Appeal ${f.result}`)
      .setDescription(ticket.decision.message ? truncate(ticket.decision.message, 1500) : 'The staff team has reviewed your appeal.').setFooter({ text: `Decided by ${i.user.tag}` })], allowedMentions: { users: [ticket.opener] } });
    await refreshControl(ctx, i.channel, ticket);
    return logTo(ctx, { embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`Appeal ${f.result} · ticket ${numberTag(ticket)}`).setDescription(`By <@${i.user.id}> for <@${ticket.opener}>\n**Reason:** ${truncate(reason, 900)}`).setTimestamp()] }, { staffOnly: true });
  }
}

const readReason = (i) => {
  const r = String(getter(i)('reason') ?? '').trim();
  if (!r) throw new UserError('A reason is required.');
  return truncate(r, 800);
};
async function askPriorityReason(ctx, i, ticket, level) {
  if (!URGENCY[level]) throw new UserError('Unknown priority.');
  if (level === (ticket.priority ?? 'normal')) throw new UserError(`It is already ${URGENCY[level].label}.`);
  return i.showModal(modalFrom(`ticket:pf:${forms.put({ by: i.user.id, kind: 'prio', level, channelId: i.channelId })}`, `Priority → ${level}`, [REASON('Why change it? (kept in the staff log)')]));
}
async function applyPriority(ctx, i, ticket, level, reason) {
  if (!getTicket(ctx, i.channelId)) throw new UserError('This ticket no longer exists.');
  const from = ticket.priority ?? 'normal';
  ticket.priority = level;
  (ticket.priorityLog ??= []).push({ from, to: level, by: i.user.id, reason, at: Date.now() });
  ticket.priorityLog = ticket.priorityLog.slice(-20);
  saveTicket(ctx, i.channelId, ticket);
  await i.reply({ content: `Priority changed to ${URGENCY[level].label}.`, flags: EPH });
  await i.channel.send({ content: `🚦 Priority changed from ${URGENCY[from].label} to ${URGENCY[level].label} by <@${i.user.id}>.`, allowedMentions: NOPING });
  await refreshControl(ctx, i.channel, ticket);
  await logTo(ctx, { embeds: [new EmbedBuilder().setColor(URGENCY[level].color).setTitle(`Priority changed · ticket ${numberTag(ticket)}`)
    .setDescription(`${URGENCY[from].label} → ${URGENCY[level].label} by <@${i.user.id}>\n**Reason:** ${truncate(reason, 900)}`).setTimestamp()] }, { staffOnly: true });
}

// ------------------------------------------------------------------ watch-log commands
async function watchCommand(ctx, i, sub) {
  need(ctx, i, 'support.watch');
  if (sub === 'list') {
    const q = (i.options.getString('search') ?? '').trim().toLowerCase();
    let rows = watchRows(ctx).reverse();
    if (q) rows = rows.filter((e) => e.target_id === q || (e.target_name ?? '').includes(q) || (e.target_alias ?? '').includes(q));
    const text = rows.slice(0, 15).map((e) => `**#${e.id}** ${watchLabel(e)} · ${outcomeLabel(e.status)} · ticket ${e.ticket_number ? `#${e.ticket_number}` : 'n/a'} · ${ts(e.created_at, 'd')}`).join('\n');
    return i.reply({ content: text || 'The watch log is empty.', flags: EPH, allowedMentions: NOPING });
  }
  if (sub === 'view') {
    const e = ctx.sql.get('SELECT * FROM support_watch WHERE id = ? AND guild_id = ?', i.options.getInteger('id', true), ctx.guildId);
    if (!e) throw new UserError('No watch-log entry with that number.');
    return i.reply({ flags: EPH, allowedMentions: NOPING, embeds: [new EmbedBuilder().setColor(0xfaa61a).setTitle(`Watch log #${e.id}`).setDescription(`${watchLabel(e)}${e.target_alias ? ` · account name \`${e.target_alias}\`` : ''}`)
      .addFields({ name: 'Outcome', value: `${outcomeLabel(e.status)}${e.outcome_by ? ` by <@${e.outcome_by}>` : ''}${e.outcome_note ? `\n${truncate(e.outcome_note, 500)}` : ''}` },
        { name: 'Reported by', value: `<@${e.reporter_id}> ${ts(e.created_at)}`, inline: true }, { name: 'Ticket', value: e.ticket_number ? `#${e.ticket_number}` : 'added by staff', inline: true },
        { name: 'What was reported', value: truncate(e.summary || '—', 900) }, { name: 'Evidence', value: truncate(e.evidence || '—', 900) })
      .setFooter({ text: 'A report is an accusation, not proof.' })] });
  }
  if (sub === 'outcome') {
    const id = i.options.getInteger('id', true), status = i.options.getString('status', true);
    if (!ctx.sql.get('SELECT id FROM support_watch WHERE id = ? AND guild_id = ?', id, ctx.guildId)) throw new UserError('No watch-log entry with that number.');
    return i.showModal(modalFrom(`ticket:wf:${forms.put({ by: i.user.id, kind: 'outcome', id, status })}`, `Mark #${id} ${status}`, [REASON('Why? (kept with the entry)')]));
  }
  if (sub === 'add') {
    const user = i.options.getUser('user');
    const username = i.options.getString('username'), rawId = i.options.getString('user_id');
    const who = parseReported({ username: username ?? user?.username, userid: rawId ?? user?.id }, { required: true });
    return i.showModal(modalFrom(`ticket:wf:${forms.put({ by: i.user.id, kind: 'add', who })}`, 'Add to the watch log', [REASON('Why are they being watched?')]));
  }
  if (sub === 'remove') {
    need(ctx, i, 'support.manage');
    const id = i.options.getInteger('id', true);
    const r = ctx.sql.run('DELETE FROM support_watch WHERE id = ? AND guild_id = ?', id, ctx.guildId);
    if (!r.changes) throw new UserError('No watch-log entry with that number.');
    return i.reply({ content: `Removed watch-log entry #${id}.`, flags: EPH });
  }
}

async function watchForm(ctx, i, token) {
  const f = forms.take(token, i.user.id);
  need(ctx, i, 'support.watch');
  const reason = readReason(i);
  if (f.kind === 'outcome') {
    const r = ctx.sql.run('UPDATE support_watch SET status = ?, outcome_by = ?, outcome_note = ?, outcome_at = ? WHERE id = ? AND guild_id = ?', f.status, i.user.id, reason, Date.now(), f.id, ctx.guildId);
    if (!r.changes) throw new UserError('That entry no longer exists.');
    return i.reply({ content: `Entry #${f.id} is now **${outcomeLabel(f.status)}**.`, flags: EPH });
  }
  const alias = f.who.id ? await realUsername(ctx, f.who.id) : null;
  const id = watchAdd(ctx, { targetId: f.who.id, targetName: f.who.name, alias: alias && alias !== f.who.name ? alias : null, reporterId: i.user.id, category: 'staff', summary: reason });
  return i.reply({ content: `Added to the watch log as **#${id}**. New tickets that mention them (or come from them) will be flagged to staff.`, flags: EPH });
}

// ------------------------------------------------------------------ /ticket setup (2.3.3)
/** Where tickets go, where their logs go, and who staff are, in one command. With nothing filled in it shows the current setup. */
async function ticketSetup(ctx, i) {
  need(ctx, i, 'support.manage');
  const catOpt = i.options.getChannel('category');
  const cat = catOpt && (ctx.guild.channels.cache.get(catOpt.id) ?? catOpt), log = i.options.getChannel('log_channel'), role = i.options.getRole('staff_role');
  const move = i.options.getBoolean('move_open_tickets') ?? false;
  const done = [];
  if (cat) {
    if (cat.type !== ChannelType.GuildCategory) throw new UserError('Pick a **category** (the folders in your channel list), not a channel.');
    ctx.settings.set('ticketCategory', cat.id); done.push(`📁 New tickets open in **${cat.name}**`);
  }
  if (log) { ctx.settings.set('logChannel', log.id); done.push(`📝 Transcripts and close notes go to <#${log.id}>`); }
  if (role) { ctx.settings.set('staffRole', role.id); done.push(`🛡️ Staff role: <@&${role.id}>`); }
  let moved = 0, failed = 0;
  const target = ctx.config.get('ticketCategory');
  if (move && target) {
    await i.deferReply({ flags: EPH });
    for (const { key } of ctx.data.list('ticket:')) {
      const ch = ctx.guild.channels.cache.get(key.slice(7));
      if (!ch || ch.parentId === target) continue;
      const ok = await ctx.queue(() => ch.setParent(target, { lockPermissions: false, reason: 'Ticket setup: move tickets into the ticket category' })).then(() => true).catch(() => false);
      if (ok) moved++; else failed++;
    }
    if (moved || failed) done.push(`🚚 Moved ${moved} existing ticket${moved === 1 ? '' : 's'} into the category${failed ? ` (${failed} couldn't be moved: I need Manage Channels, and categories hold at most 50 channels)` : ''}`);
  }
  const now = (id, fmt) => (id ? fmt(id) : '*not set*');
  const catNow = ctx.config.get('ticketCategory');
  const summary = [
    done.length ? `**Saved:**\n${done.join('\n')}\n` : '**Ticket setup**',
    `Category: ${now(catNow, (id) => `📁 ${ctx.guild.channels.cache.get(id)?.name ?? 'deleted category'}`)}${catNow ? '' : ' (tickets appear at the top of the channel list)'}`,
    `Log channel: ${now(ctx.config.get('logChannel'), (id) => `<#${id}>`)}`,
    `Staff role: ${now(ctx.config.get('staffRole'), (id) => `<@&${id}>`)}`,
    done.length ? '' : '\nFill in the options to change any of these.',
  ].join('\n');
  return i.deferred ? i.editReply({ content: summary, allowedMentions: { parse: [] } }) : i.reply({ content: summary, flags: EPH, allowedMentions: { parse: [] } });
}

// ------------------------------------------------------------------ /ticket command
async function ticketCommand(ctx, i) {
  const group = i.options.getSubcommandGroup(false);
  const sub = i.options.getSubcommand();

  if (group === 'watch') return watchCommand(ctx, i, sub);

  if (group === 'type') {
    need(ctx, i, 'support.manage');
    const list = customTypes(ctx);
    if (sub === 'list') return i.reply({ content: list.map((t) => `${t.emoji ?? '🎫'} **${t.label}** (\`${t.id}\`)${t.questions?.length ? ` - ${t.questions.length} question(s)` : ''}`).join('\n') || 'No custom types. The built-in categories are always available; add your own with `/ticket type add`.', flags: EPH });
    if (sub === 'remove') {
      const id = i.options.getString('id', true);
      if (!list.some((t) => t.id === id)) throw new UserError('No such type.');
      ctx.data.set('types', list.filter((t) => t.id !== id));
      return i.reply({ content: 'Removed. Existing panels using it will say the type is gone - repost the panel.', flags: EPH });
    }
    const label = truncate(i.options.getString('label', true).trim(), 40);
    const id = slug(label, 20);
    if (!id) throw new UserError('Use letters or numbers in the name.');
    if (CATEGORIES.some((c) => c.id === id)) throw new UserError('That name is used by a built-in category.');
    if (list.length >= 10) throw new UserError('You can have up to 10 custom ticket types.');
    if (list.some((t) => t.id === id)) throw new UserError('A type with that name already exists.');
    const questions = (i.options.getString('questions') ?? '').split('|').map((q) => q.trim()).filter(Boolean).slice(0, 5).map((q) => truncate(q, 45));
    const catId = i.options.getChannel('category')?.id;
    if (catId && ctx.guild.channels.cache.get(catId)?.type !== ChannelType.GuildCategory) throw new UserError('That channel is not a category.');
    ctx.data.set('types', [...list, { id, label, emoji: i.options.getString('emoji')?.trim().slice(0, 40) || undefined, questions, categoryId: catId }]);
    return i.reply({ content: `Added ticket type **${label}**${questions.length ? ` with ${questions.length} form question(s)` : ''}. Post a panel with \`/ticket panel\`.`, flags: EPH });
  }

  if (sub === 'setup') return ticketSetup(ctx, i);

  if (sub === 'panel') {
    need(ctx, i, 'support.manage');
    // Nothing filled in: a popup with the channel and wording, already filled with sensible text.
    if (!i.options.getChannel('channel') && !i.options.getString('title') && !i.options.getString('description')) {
      return i.showModal(formModal(`ticket:panelform:${forms.put({ by: i.user.id, kind: 'panel' })}`, 'Ticket panel', panelFields(i.channelId)));
    }
    return postTicketPanel(ctx, i, { ch: (await getChannelOption(i, 'channel')) ?? i.channel, title: i.options.getString('title'), description: i.options.getString('description') });
  }

  if (sub === 'stats') {
    need(ctx, i, 'support.staff');
    const s = ctx.data.get('stats') ?? {};
    const open = ctx.data.list('ticket:').filter((t) => t.value.status === 'open').length;
    const days = i.options.getInteger('days') ?? 30;
    const sum = summarize(ctx.sql.all('SELECT * FROM support_history WHERE guild_id = ?', ctx.guildId), Date.now(), days);
    const dur = (ms) => (ms == null ? '—' : ms < 3600000 ? `${Math.round(ms / 60000)} min` : `${(ms / 3600000).toFixed(1)} h`);
    const cats = Object.entries(sum.byCategory).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${findCategory(k, customTypes(ctx))?.label ?? k}: ${n}`).join('\n');
    return i.reply({ flags: EPH, embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('Ticket stats').addFields(
      { name: 'Open now', value: String(open), inline: true }, { name: 'Opened (all time)', value: String(s.opened ?? 0), inline: true }, { name: 'Closed (all time)', value: String(s.closed ?? 0), inline: true },
      { name: `Last ${days} days`, value: `${sum.total} ticket(s) · first reply ${dur(sum.avgFirstResponseMs)} · to close ${dur(sum.avgResolutionMs)}\n${sum.autoClosed} auto-closed · ${sum.withoutNotes} closed without notes`, },
      ...(cats ? [{ name: 'By category', value: truncate(cats, 900) }] : []))] });
  }

  // everything below works inside a ticket channel
  const ticket = getTicket(ctx, i.channelId);
  if (!ticket) throw new UserError('Use this inside a ticket channel.');
  const staff = isStaff(ctx, i.member);

  if (sub === 'close') {
    if (staff) return startStaffClose(ctx, i, ticket);
    if (i.user.id !== ticket.opener) throw new UserError('Only staff or the ticket owner can close this.');
    if (ticket.status !== 'open') throw new UserError('Already closed.');
    await i.reply({ content: 'Closing…', flags: EPH });
    return closeTicket(ctx, i.channel, ticket, i.user, { kind: 'owner', reason: i.options.getString('reason') });
  }
  if (!staff) throw new UserError('Staff only.');

  if (sub === 'add' || sub === 'remove') {
    const user = i.options.getUser('user', true);
    if (user.id === ticket.opener) throw new UserError("That's the ticket owner.");
    if (sub === 'add') await i.channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true });
    else await i.channel.permissionOverwrites.delete(user.id);
    return i.reply({ content: `${sub === 'add' ? 'Added' : 'Removed'} <@${user.id}>.`, allowedMentions: NOPING });
  }
  if (sub === 'rename') {
    const name = slug(i.options.getString('name', true), 60);
    if (!name) throw new UserError('Use letters or numbers.');
    await i.channel.setName(`ticket-${name}`);
    return i.reply({ content: `Renamed to \`ticket-${name}\`.`, flags: EPH });
  }
  if (sub === 'priority') return askPriorityReason(ctx, i, ticket, i.options.getString('level', true));
  if (sub === 'transcript') {
    await i.deferReply({ flags: EPH });
    return i.editReply({ files: [await makeTranscript(ctx, i.channel, ticket)] });
  }
  if (sub === 'info') {
    const cat = catOf(ctx, ticket);
    const earlier = watchRows(ctx).filter((e) => e.ticket_number !== ticket.number);
    const matches = matchWatch({ openerId: ticket.opener, openerNames: [ticket.openerTag.split('#')[0]], reported: ticket.report ?? {}, text: (ticket.answers ?? []).map((a) => a.a).join('\n') }, earlier);
    const e = new EmbedBuilder().setColor(urgencyOf(ticket).color).setTitle(`Ticket ${numberTag(ticket)} · staff view`)
      .addFields({ name: 'Category', value: `${cat?.emoji ?? ''} ${ticket.typeLabel}`, inline: true }, { name: 'Urgency', value: urgencyOf(ticket).label, inline: true }, { name: 'Opened by', value: `<@${ticket.opener}> ${ts(ticket.createdAt)}`, inline: true });
    if (ticket.report) e.addFields({ name: 'Reported person', value: `${ticket.report.id ? `<@${ticket.report.id}> (\`${ticket.report.id}\`)` : ''} ${ticket.report.name ?? ''}`.trim() });
    if (ticket.priorityLog?.length) e.addFields({ name: 'Priority changes', value: truncate(ticket.priorityLog.slice(-5).map((p) => `${p.from} → ${p.to} by <@${p.by}>: ${truncate(p.reason, 120)}`).join('\n'), 900) });
    if (ticket.decision) e.addFields({ name: `Appeal ${ticket.decision.result}`, value: truncate(ticket.decision.reason, 500) });
    e.addFields({ name: 'Watch log', value: matches.length ? truncate(describeMatches(matches, earlier), 1000) : 'No matches.' });
    return i.reply({ embeds: [e], flags: EPH, allowedMentions: NOPING });
  }
}

// ------------------------------------------------------------------ housekeeping
async function onMessage(ctx, message) {
  if (!message.guild || !chans(ctx).has(message.channelId)) return;
  const t = getTicket(ctx, message.channelId);
  if (!t) return;
  if (ctx.config.get('archiveTickets')) await archiveMessage(ctx, t.number, message).catch((e) => ctx.log.warn(`Could not archive a ticket message: ${e.message}`));
  if (message.author?.bot || t.status !== 'open') return;
  const now = Date.now();
  let changed = false;
  if (now - (t.lastActivity ?? 0) > 60000) { t.lastActivity = now; changed = true; }
  if (!t.firstResponseAt && message.author.id !== t.opener && message.member && isStaff(ctx, message.member)) { t.firstResponseAt = now; changed = true; }
  if (changed) saveTicket(ctx, message.channelId, t);
}

async function onChannelDelete(ctx, channel) {
  const t = getTicket(ctx, channel.id);
  chans(ctx).delete(channel.id);
  if (!t) return;
  ctx.data.delete(`ticket:${channel.id}`);
  if (t.status !== 'open') return; // already closed with its notes (or deleted through the Delete button)
  // The channel was deleted while the ticket was open: nobody wrote notes. Record that honestly instead of losing the ticket.
  historyClose(ctx, t, channel.id, { at: Date.now(), by: null, kind: 'no-notes', resolution: null, reason: 'The channel was deleted while the ticket was open.' });
  ctx.data.update('stats', (s) => ({ ...s, closed: (s.closed ?? 0) + 1 }), {});
  await logTo(ctx, { embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle(`Ticket ${numberTag(t)} closed without notes`).setDescription(`${t.typeLabel} · opened by <@${t.opener}>\nIts channel was deleted while the ticket was still open, so there is no resolution, reason or notes.`).setTimestamp()] }, { staffOnly: true });
}

async function maintenance(ctx) {
  // inactivity auto-close
  const hours = ctx.config.get('autoCloseHours');
  if (hours > 0) {
    const now = Date.now();
    for (const { key, value: t } of ctx.data.list('ticket:')) {
      if (!inactive(t, now, hours)) continue;
      const channel = ctx.guild.channels.cache.get(key.slice(7));
      if (!channel) continue;
      await closeTicket(ctx, channel, t, ctx.client.user, { kind: 'auto' }).catch((e) => ctx.log.warn(`auto-close failed: ${e.message}`));
    }
  }
  // watch-log retention, at most once a day
  const last = ctx.data.get('lastPurge') ?? 0;
  if (Date.now() - last > DAY) {
    ctx.data.set('lastPurge', Date.now());
    const days = ctx.config.get('watchRetentionDays'), unf = ctx.config.get('unfoundedRetentionDays');
    if (days > 0) ctx.sql.run('DELETE FROM support_watch WHERE guild_id = ? AND created_at < ?', ctx.guildId, Date.now() - days * DAY);
    if (unf > 0) ctx.sql.run("DELETE FROM support_watch WHERE guild_id = ? AND status = 'unfounded' AND COALESCE(outcome_at, created_at) < ?", ctx.guildId, Date.now() - unf * DAY);
  }
}

// ------------------------------------------------------------------ dashboard
function setWatchStatus(ctx, body, actor, status) {
  const id = Number(body.userId ?? body.id);
  if (!Number.isInteger(id)) throw new UserError('Bad request.');
  const r = ctx.sql.run('UPDATE support_watch SET status = ?, outcome_by = ?, outcome_note = ?, outcome_at = ? WHERE id = ? AND guild_id = ?', status, actor.userId, `via dashboard (${actor.username})`, Date.now(), id, ctx.guildId);
  if (!r.changes) throw new UserError('That entry no longer exists.');
  return { id, status };
}
const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '');
const nameOf = (ctx, id) => ctx.guild?.members.cache.get(id)?.displayName ?? id ?? '';

// ------------------------------------------------------------------ definition

export const panelFields = (channelId) => [
  { id: 'channel', label: 'Channel for the panel', kind: 'channel', value: channelId },
  { id: 'title', label: 'Title', max: 200, value: 'Need help?' },
  { id: 'description', label: 'Text', kind: 'paragraph', max: 1500, value: 'Press the button that fits your problem. A private channel opens for you and our staff.' },
];
async function panelForm(ctx, i) {
  forms.take(i.customId.split(':')[2], i.user.id);
  const v = readForm(i, panelFields(null));
  return postTicketPanel(ctx, i, { ch: v.channel ? i.guild.channels.cache.get(v.channel) : i.channel, title: v.title || null, description: v.description || null });
}
async function postTicketPanel(ctx, i, { ch, title, description }) {
    if (!ch?.isTextBased()) throw new UserError('Pick a text channel.');
    const all = [...CATEGORIES, ...customTypes(ctx).map((t) => findCategory(t.id, customTypes(ctx)))].filter((c) => !hidden(ctx).has(c.id));
    if (!all.length) throw new UserError('Every category is hidden. Un-hide some in the settings first.');
    const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(truncate(title ?? 'Need help?', 200))
      .setDescription(truncate(`${description ?? 'Press the button that fits your problem. A private channel opens for you and our staff.'}\n\n${all.map((c) => `${c.emoji} **${c.label}**${URGENCY[c.urgency].rank >= 3 ? ' *(urgent)*' : ''}`).join('\n')}`, 3000));
    const style = (c) => (c.urgency === 'urgent' ? ButtonStyle.Danger : c.urgency === 'high' ? ButtonStyle.Primary : ButtonStyle.Secondary);
    const buttons = all.slice(0, 25).map((c) => { const b = new ButtonBuilder().setCustomId(`ticket:open:${c.id}`).setLabel(truncate(c.label, 80)).setStyle(style(c)); if (c.emoji) b.setEmoji(c.emoji); return b; });
    const rows = []; for (let n = 0; n < buttons.length; n += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(n, n + 5)));
    await ch.send({ embeds: [embed], components: rows }).catch((e) => { throw new UserError(describeDiscordError(e, 'post the panel')); });
    return i.reply({ content: `Panel posted in <#${ch.id}>.`, flags: EPH });
}

export default {
  name: 'support',
  version: '2.0.0',
  description: 'Tickets with categories and urgency, popups, a staff watch log for reports, required close notes and a history.',
  api,
  async init(ctx) { ctxs.set(ctx.guildId, ctx); },
  async destroy(ctx) { ctxs.delete(ctx.guildId); },
  settings: [
    { key: 'ticketCategory', type: 'channel', label: 'Category for ticket channels' },
    { key: 'staffRole', type: 'role', label: 'Staff role (more can be added with /permissions on support.staff)' },
    { key: 'logChannel', type: 'channel', label: 'Ticket log channel (transcripts and close notes go here - staff only!)' },
    { key: 'watchChannel', type: 'channel', label: 'Staff-only channel for watch-log flags (empty = the ticket log)' },
    { key: 'maxOpenPerUser', type: 'number', label: 'Max open tickets per member', default: 2, min: 1, max: 10 },
    { key: 'autoCloseHours', type: 'number', label: 'Auto-close tickets after N hours without a message (0 = never)', default: 0, min: 0, max: 720 },
    { key: 'hiddenCategories', type: 'list', label: 'Ticket categories to switch off (ids: scam, safety, report, appeal, bot, access, partner, other)' },
    { key: 'watchRetentionDays', type: 'number', label: 'Keep watch-log entries for N days (0 = forever)', default: 365, min: 0, max: 3650 },
    { key: 'unfoundedRetentionDays', type: 'number', label: 'Delete entries marked unfounded after N days (0 = same as above)', default: 30, min: 0, max: 3650 },
    { key: 'transcriptFormat', type: 'select', label: 'Transcript format', description: 'html needs the support-html-transcripts add-on', options: ['txt', 'html'], default: 'txt' },
    { key: 'dmTranscript', type: 'toggle', label: 'DM the transcript to the ticket owner', default: true },
    { key: 'deleteDelaySeconds', type: 'number', label: 'Seconds before a deleted ticket vanishes', default: 5, min: 1, max: 60 },
    { key: 'archiveTickets', type: 'toggle', label: 'Keep every ticket message and file in the archive on this computer', default: true },
  ],
  permissions: [
    { key: 'support.staff', label: 'Ticket staff: claim, close with notes, priority, appeals, transcripts', default: 'moderator' },
    { key: 'support.watch', label: 'Read and update the staff watch log', default: 'moderator' },
    { key: 'support.manage', label: 'Create panels and ticket types, delete watch-log entries', default: 'admin' },
  ],
  migrations: [{ id: 1, sql: `
    CREATE TABLE IF NOT EXISTS support_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, number INTEGER NOT NULL, channel_id TEXT,
      opener_id TEXT NOT NULL, opener_tag TEXT, category TEXT NOT NULL, category_label TEXT, urgency TEXT,
      opened_at INTEGER NOT NULL, first_response_at INTEGER, claimed_by TEXT,
      closed_at INTEGER, closed_by TEXT, close_kind TEXT, resolution TEXT, reason TEXT, action_taken TEXT, notes TEXT, follow_up TEXT,
      outcome TEXT, decision TEXT, decision_reason TEXT, reopened INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX IF NOT EXISTS support_history_ticket ON support_history (guild_id, number);
    CREATE INDEX IF NOT EXISTS support_history_opener ON support_history (guild_id, opener_id);
    CREATE TABLE IF NOT EXISTS support_watch (
      id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, target_id TEXT, target_name TEXT, target_alias TEXT,
      reporter_id TEXT NOT NULL, ticket_number INTEGER, category TEXT, summary TEXT, evidence TEXT,
      status TEXT NOT NULL DEFAULT 'open', outcome_by TEXT, outcome_note TEXT, outcome_at INTEGER, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS support_watch_target ON support_watch (guild_id, target_id);
    CREATE INDEX IF NOT EXISTS support_watch_name ON support_watch (guild_id, target_name);
  ` }, { id: 2, sql: `
    CREATE TABLE IF NOT EXISTS support_archive (
      guild_id TEXT NOT NULL, number INTEGER NOT NULL, message_id TEXT NOT NULL, channel_id TEXT, author_id TEXT, author_name TEXT, author_avatar TEXT,
      bot INTEGER NOT NULL DEFAULT 0, content TEXT NOT NULL DEFAULT '', embeds TEXT NOT NULL DEFAULT '[]', attachments TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, edited_at INTEGER, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, message_id));
    CREATE INDEX IF NOT EXISTS support_archive_ticket ON support_archive (guild_id, number, created_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS support_archive_fts USING fts5(content, guild_id UNINDEXED, number UNINDEXED, message_id UNINDEXED);
    ALTER TABLE support_history ADD COLUMN reported_id TEXT;
    ALTER TABLE support_history ADD COLUMN reported_name TEXT;
    ALTER TABLE support_history ADD COLUMN details TEXT;
  ` }],
  commands: [
    {
      ownPopup: ['panel', 'setup'], // opens its own popup when run with nothing filled in
      data: new SlashCommandBuilder().setName('ticket').setDescription('Support tickets')
        .addSubcommand((s) => s.setName('setup').setDescription('(Staff) Where tickets open, where logs go, and the staff role')
          .addChannelOption((o) => o.setName('category').setDescription('The category new ticket channels go in').addChannelTypes(ChannelType.GuildCategory))
          .addChannelOption((o) => o.setName('log_channel').setDescription('Staff-only channel for transcripts and close notes').addChannelTypes(ChannelType.GuildText))
          .addRoleOption((o) => o.setName('staff_role').setDescription('Who answers tickets'))
          .addBooleanOption((o) => o.setName('move_open_tickets').setDescription('Also move tickets that are already open into the category')))
        .addSubcommand((s) => s.setName('panel').setDescription('Post the "open a ticket" buttons')
          .addChannelOption((o) => o.setName('channel').setDescription('Where to post it'))
          .addStringOption((o) => o.setName('title').setDescription('Panel title'))
          .addStringOption((o) => o.setName('description').setDescription('Panel text')))
        .addSubcommandGroup((g) => g.setName('type').setDescription('Your own extra ticket types')
          .addSubcommand((s) => s.setName('add').setDescription('Add a ticket type')
            .addStringOption((o) => o.setName('label').setDescription('Name, e.g. Event help').setRequired(true).setMaxLength(40))
            .addStringOption((o) => o.setName('emoji').setDescription('Emoji for the button'))
            .addStringOption((o) => o.setName('questions').setDescription('Form questions separated by | (max 5)'))
            .addChannelOption((o) => o.setName('category').setDescription('Category for this type\'s channels')))
          .addSubcommand((s) => s.setName('remove').setDescription('Remove a type').addStringOption((o) => o.setName('id').setDescription('Type id (see list)').setRequired(true)))
          .addSubcommand((s) => s.setName('list').setDescription('List types')))
        .addSubcommandGroup((g) => g.setName('watch').setDescription('(Staff) The watch log of reported people')
          .addSubcommand((s) => s.setName('list').setDescription('Recent entries').addStringOption((o) => o.setName('search').setDescription('A user ID or part of a username')))
          .addSubcommand((s) => s.setName('view').setDescription('Everything about one entry').addIntegerOption((o) => o.setName('id').setDescription('Entry number').setRequired(true).setMinValue(1)))
          .addSubcommand((s) => s.setName('outcome').setDescription('Mark a report confirmed or unfounded (asks for a reason)')
            .addIntegerOption((o) => o.setName('id').setDescription('Entry number').setRequired(true).setMinValue(1))
            .addStringOption((o) => o.setName('status').setDescription('What staff found').setRequired(true).addChoices({ name: 'confirmed', value: 'confirmed' }, { name: 'unfounded', value: 'unfounded' }, { name: 'not reviewed', value: 'open' })))
          .addSubcommand((s) => s.setName('add').setDescription('Watch someone without a ticket (asks for a reason)')
            .addUserOption((o) => o.setName('user').setDescription('The member'))
            .addStringOption((o) => o.setName('user_id').setDescription('Their user ID, if they are not in the server').setMaxLength(25))
            .addStringOption((o) => o.setName('username').setDescription('Their username').setMaxLength(40)))
          .addSubcommand((s) => s.setName('remove').setDescription('(Admins) Delete an entry').addIntegerOption((o) => o.setName('id').setDescription('Entry number').setRequired(true).setMinValue(1))))
        .addSubcommand((s) => s.setName('close').setDescription('Close this ticket (staff: opens the notes popup)').addStringOption((o) => o.setName('reason').setDescription('Members: why you are closing it (optional)')))
        .addSubcommand((s) => s.setName('add').setDescription('Add someone to this ticket').addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
        .addSubcommand((s) => s.setName('remove').setDescription('Remove someone from this ticket').addUserOption((o) => o.setName('user').setDescription('Who').setRequired(true)))
        .addSubcommand((s) => s.setName('rename').setDescription('Rename this ticket').addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true)))
        .addSubcommand((s) => s.setName('priority').setDescription('Set priority (asks for a reason)').addStringOption((o) => o.setName('level').setDescription('Level').setRequired(true)
          .addChoices(...Object.keys(URGENCY).map((k) => ({ name: k, value: k })))))
        .addSubcommand((s) => s.setName('info').setDescription('Staff view: reported person, priority changes, watch-log matches'))
        .addSubcommand((s) => s.setName('transcript').setDescription('Get a transcript of this ticket'))
        .addSubcommand((s) => s.setName('stats').setDescription('Ticket statistics').addIntegerOption((o) => o.setName('days').setDescription('Look back this many days (default 30)').setMinValue(1).setMaxValue(365))),
      execute: ticketCommand,
    },
  ],
  components: [
    { prefix: 'ticket:', execute: (ctx, i) => (i.customId.startsWith('ticket:panelform:') ? panelForm(ctx, i) : onComponent(ctx, i)) },
  ],
  events: {
    messageCreate: onMessage,
    messageUpdate: async (ctx, oldM, newM) => {
      if (!chans(ctx).has(newM.channelId) || !ctx.config.get('archiveTickets')) return;
      const row = ctx.sql.get('SELECT number, content FROM support_archive WHERE guild_id = ? AND message_id = ?', ctx.guildId, newM.id);
      if (!row || newM.content == null || newM.content === row.content) return;
      ctx.sql.run('UPDATE support_archive SET content = ?, edited_at = ? WHERE guild_id = ? AND message_id = ?', newM.content, Date.now(), ctx.guildId, newM.id);
      ctx.sql.run('DELETE FROM support_archive_fts WHERE guild_id = ? AND message_id = ?', ctx.guildId, newM.id);
      ctx.sql.run('INSERT INTO support_archive_fts (content, guild_id, number, message_id) VALUES (?, ?, ?, ?)', newM.content, ctx.guildId, row.number, newM.id);
    },
    messageDelete: async (ctx, m) => { ctx.sql.run('UPDATE support_archive SET deleted = 1 WHERE guild_id = ? AND message_id = ?', ctx.guildId, m.id); },
    channelDelete: onChannelDelete,
  },
  tasks: [{ name: 'maintenance', everyMs: 600000, run: maintenance }],
  views: {
    /**
     * The ticket archive: every ticket, newest first. Query: search (words in any message), status (open|closed),
     * type, staff (who closed or claimed it), reported (an id), page.
     */
    async archive(ctx, q = {}) {
      const where = ['h.guild_id = ?'], args = [ctx.guildId];
      if (q.status === 'open') where.push('h.closed_at IS NULL'); else if (q.status === 'closed') where.push('h.closed_at IS NOT NULL');
      if (q.type) { where.push('h.category = ?'); args.push(String(q.type)); }
      if (q.staff) { where.push('(h.closed_by = ? OR h.claimed_by = ?)'); args.push(String(q.staff), String(q.staff)); }
      if (q.reported) { where.push('h.reported_id = ?'); args.push(String(q.reported)); }
      if (q.opener) { where.push('h.opener_id = ?'); args.push(String(q.opener)); }
      let hits = null;
      const words = String(q.search ?? '').trim().slice(0, 100);
      if (words) {
        const match = words.split(/\s+/).map((w) => `"${w.replace(/"/g, '""')}"`).join(' ');
        hits = new Map(ctx.sql.all(`SELECT number, snippet(support_archive_fts, 0, '[[', ']]', '…', 12) AS snip FROM support_archive_fts WHERE support_archive_fts MATCH ? AND guild_id = ? LIMIT 500`, match, ctx.guildId).map((r) => [Number(r.number), r.snip]));
        const nums = [...hits.keys()];
        where.push(`(h.number IN (${nums.map(() => '?').join(',') || 'NULL'}) OR h.opener_tag LIKE ? OR h.reported_name LIKE ? OR h.reason LIKE ? OR h.notes LIKE ? OR h.details LIKE ?)`);
        args.push(...nums, `%${words}%`, `%${words}%`, `%${words}%`, `%${words}%`, `%${words}%`);
      }
      const page = Math.max(0, Number(q.page) || 0), size = 50;
      const rows = ctx.sql.all(`SELECT h.*, (SELECT COUNT(*) FROM support_archive a WHERE a.guild_id = h.guild_id AND a.number = h.number) AS messages
        FROM support_history h WHERE ${where.join(' AND ')} ORDER BY h.opened_at DESC LIMIT ? OFFSET ?`, ...args, size + 1, page * size);
      return {
        page, more: rows.length > size,
        rows: rows.slice(0, size).map((h) => ({ number: h.number, type: h.category_label ?? h.category, category: h.category, urgency: h.urgency, opener: { id: h.opener_id, name: h.opener_tag },
          about: h.reported_id || h.reported_name ? { id: h.reported_id, name: h.reported_name } : null, openedAt: h.opened_at, closedAt: h.closed_at, closedBy: h.closed_by, claimedBy: h.claimed_by,
          status: h.closed_at ? 'closed' : 'open', resolution: h.resolution, messages: h.messages, match: hits?.get(h.number) ?? null })),
        types: [...CATEGORIES, ...customTypes(ctx)].map((c) => ({ id: c.id, label: c.label })),
      };
    },
    /** One ticket in full: details, who is involved, staff background, and every message (query: number). */
    async archiveTicket(ctx, q = {}) {
      const number = Number(q.number);
      const h = ctx.sql.get('SELECT * FROM support_history WHERE guild_id = ? AND number = ?', ctx.guildId, number);
      if (!h) throw new UserError('That ticket is not in the archive.');
      const details = (() => { try { return JSON.parse(h.details ?? '{}'); } catch { return {}; } })();
      const file = (stored) => `/api/guilds/${ctx.guildId}/modules/support/files/${number}/${encodeURIComponent(stored)}`;
      const messages = ctx.sql.all('SELECT * FROM support_archive WHERE guild_id = ? AND number = ? ORDER BY created_at, message_id', ctx.guildId, number).map((m) => ({
        id: m.message_id, author: { id: m.author_id, name: m.author_name, avatar: m.author_avatar, bot: !!m.bot }, content: m.content, embeds: JSON.parse(m.embeds), at: m.created_at, editedAt: m.edited_at, deleted: !!m.deleted,
        attachments: JSON.parse(m.attachments).map((a) => ({ ...a, url: a.stored ? file(a.stored) : null })),
      }));
      return {
        number, type: h.category_label ?? h.category, urgency: h.urgency, openedAt: h.opened_at, closedAt: h.closed_at, closedBy: h.closed_by, claimedBy: h.claimed_by,
        resolution: h.resolution, reason: h.reason, action: h.action_taken, notes: h.notes, outcome: h.outcome,
        opener: { id: h.opener_id, name: h.opener_tag, ...(details.people?.opener ?? {}) }, about: details.people?.about ?? (h.reported_id || h.reported_name ? { id: h.reported_id, name: h.reported_name } : null),
        answers: details.answers ?? [], files: (details.files ?? []).map((f) => ({ ...f, url: f.stored ? file(f.stored) : null })),
        background: { about: staffFacts(ctx, h.reported_id), opener: staffFacts(ctx, h.opener_id) },
        messages,
      };
    },
    async tickets(ctx) {
      const rows = ctx.data.list('ticket:').map(({ key, value: t }) => ({ id: key.slice(7), number: `#${t.number}`, category: t.typeLabel, urgency: urgencyOf(t).label, status: t.status, opener: nameOf(ctx, t.opener),
        claimed: t.claimedBy ? nameOf(ctx, t.claimedBy) : '—', opened: when(t.createdAt), rank: urgencyOf(t).rank })).sort((a, b) => b.rank - a.rank || 0);
      const recent = ctx.sql.all('SELECT * FROM support_history WHERE guild_id = ? AND closed_at IS NOT NULL ORDER BY closed_at DESC LIMIT 25', ctx.guildId).map((r) => ({
        number: `#${r.number}`, category: r.category_label, kind: CLOSE_KINDS[r.close_kind] ?? r.close_kind, resolution: r.resolution ?? '—', by: r.closed_by ? nameOf(ctx, r.closed_by) : '—', closed: when(r.closed_at) }));
      return { rows, recent };
    },
    async watch(ctx) {
      const rows = watchRows(ctx).reverse().slice(0, 100).map((e) => ({ id: String(e.id), number: `#${e.id}`, name: e.target_id ?? e.target_name, who: e.target_id ? `${e.target_name ?? e.target_alias ?? ''} ${e.target_id}`.trim() : e.target_name,
        status: outcomeLabel(e.status), ticket: e.ticket_number ? `#${e.ticket_number}` : 'staff', added: when(e.created_at), summary: truncate(e.summary ?? '', 80) }));
      return { rows, recent: [] };
    },
  },
  actions: {
    'watch-confirm': (ctx, body, actor) => setWatchStatus(ctx, body, actor, 'confirmed'),
    'watch-unfound': (ctx, body, actor) => setWatchStatus(ctx, body, actor, 'unfounded'),
    async 'watch-remove'(ctx, body) {
      const id = Number(body.userId ?? body.id);
      if (!Number.isInteger(id)) throw new UserError('Bad request.');
      const r = ctx.sql.run('DELETE FROM support_watch WHERE id = ? AND guild_id = ?', id, ctx.guildId);
      if (!r.changes) throw new UserError('That entry no longer exists.');
      return { id };
    },
  },
  panels: [
    { id: 'archive', title: 'Ticket archive', view: 'archive', pageViews: ['archiveTicket'], permission: 'support.staff', private: true, kind: 'ticket-archive',
      description: 'Every ticket with its messages and files, read like the Discord chat it came from.', empty: 'No tickets yet.',
      columns: [{ key: 'number', label: '#' }, { key: 'type', label: 'Type' }, { key: 'status', label: 'Status' }, { key: 'messages', label: 'Messages' }] },
    { id: 'tickets', title: 'Tickets', view: 'tickets', permission: 'support.staff', private: true,
      description: 'Open tickets, newest first. Staff work on them in their ticket channels.',
      empty: 'No tickets are open right now.', recentTitle: 'Recently closed', recentEmpty: 'No tickets have been closed yet.',
      columns: [{ key: 'number', label: '#' }, { key: 'category', label: 'Category' }, { key: 'urgency', label: 'Urgency' }, { key: 'status', label: 'Status' }, { key: 'opener', label: 'Opened by' }, { key: 'claimed', label: 'Claimed' }, { key: 'opened', label: 'Opened' }],
      rowActions: [],
      recentColumns: [{ key: 'number', label: '#' }, { key: 'category', label: 'Category' }, { key: 'kind', label: 'How it ended' }, { key: 'resolution', label: 'Resolution' }, { key: 'by', label: 'By' }, { key: 'closed', label: 'Closed' }] },
    { id: 'watch', title: 'Watch log (staff only)', view: 'watch', permission: 'support.watch', private: true,
      description: 'People named in reports. Later tickets that mention them are flagged for staff. A report is only an accusation until you record an outcome.',
      empty: 'Nobody is on the watch log.',
      columns: [{ key: 'number', label: '#' }, { key: 'who', label: 'Person' }, { key: 'status', label: 'Outcome' }, { key: 'ticket', label: 'Ticket' }, { key: 'added', label: 'Added' }, { key: 'summary', label: 'What was reported' }],
      rowActions: [{ action: 'watch-confirm', label: 'Confirmed', confirm: 'Mark this report as confirmed?', danger: false }, { action: 'watch-unfound', label: 'Unfounded', confirm: 'Mark this report as unfounded? Unfounded entries expire after 30 days.', danger: false }, { action: 'watch-remove', label: 'Remove', confirm: 'Remove this entry from the watch log?', danger: true }], recentColumns: [] },
  ],
};

