/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Announcements (including scheduled/repeating), ONE shared voting engine for polls and suggestions,
 * and a fully configurable starboard. Slash commands and the dashboard write the same settings.
 */
import {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ChannelType,
} from 'discord.js';
import { UserError, parseDuration, parseWhen, pingProblem as sharedPingProblem, normalizeHex, hexToInt, truncate, progressBar, ts, SNOWFLAKE, getChannelOption, describeDiscordError } from '../../src/util.js';
import { formStore } from '../../src/forms.js';
import { PermissionFlagsBits as P } from 'discord.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const need = (ctx, i, key) => { if (!ctx.perms.check(i.member, key)) throw new UserError(`You don't have permission for that (\`${key}\`).`); };
const DAY = 86400000;
const MAX_SCHEDULES = 25;
const starLocks = new Set();

const textChannel = (ctx, id) => { const c = id ? ctx.guild?.channels.cache.get(id) : null; return c?.isTextBased?.() ? c : null; };
const unescapeNl = (s) => String(s).replace(/\\n/g, '\n');

// ------------------------------------------------------------------ announcements
function announceEmbed(text, title, color) {
  const e = new EmbedBuilder().setColor(color ?? 0x5865f2).setDescription(truncate(unescapeNl(text), 3800));
  if (title) e.setTitle(truncate(title, 250));
  return e;
}

/**
 * What actually gets posted. By default an announcement is a normal message: the pings are real message text,
 * followed by what you wrote. Giving a title or color switches to an embed, but the pings still go in the message text
 * (pings inside an embed never notify anyone).
 */
export function announcePayload({ text, title, color, ping = 'none', roleIds = [] }) {
  const everyone = ping === 'everyone' || ping === 'here';
  const pings = everyone ? [`@${ping}`] : ping === 'role' ? roleIds.map((r) => `<@&${r}>`) : [];
  const allowedMentions = everyone ? { parse: ['everyone'] } : pings.length ? { roles: roleIds } : NOPING;
  if (title || color) return { content: pings.join(' ') || undefined, embeds: [announceEmbed(text, title, color ? hexToInt(color) : undefined)], allowedMentions };
  return { content: truncate([pings.join(' '), unescapeNl(text)].filter(Boolean).join('\n'), 2000), allowedMentions };
}

/** Why a ping would be ignored by Discord in this channel, or null when it will work. */
export function pingProblem(ctx, ch, ping, roleIds = []) { return sharedPingProblem(ctx.guild, ch, ping, roleIds, P); }


const forms = formStore('announce');

function roleIdsFrom(i, ping) {
  if (ping !== 'role') return [];
  const ids = ['role', 'role2', 'role3'].map((n) => i.options.getRole(n)?.id).filter(Boolean);
  if (!ids.length) throw new UserError('Choose which role to ping with the `role` option.');
  return [...new Set(ids)];
}

function announceModal(token, sub, presetTitle) {
  return new ModalBuilder().setCustomId(`announce:form:${token}`).setTitle(sub === 'send' ? 'New announcement' : 'Schedule an announcement').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text').setLabel('Message').setStyle(TextInputStyle.Paragraph).setMaxLength(1800).setRequired(true).setPlaceholder('Write it exactly as it should appear. New lines work.')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title (optional, makes it a fancy embed)').setStyle(TextInputStyle.Short).setMaxLength(250).setRequired(false).setValue(presetTitle ?? '')));
}

/**
 * The one-popup announcement: message, title (or when, for a schedule), channel, who to notify and which roles,
 * all in a single Discord form. Uses Discord's newer popup parts (labels with dropdowns and pickers).
 */
export function richAnnounceModal(token, sub, { channelId = null } = {}) {
  const text = new TextInputBuilder().setCustomId('text').setStyle(TextInputStyle.Paragraph).setMaxLength(1800).setRequired(true).setPlaceholder('Write it exactly as it should appear. New lines work.');
  const second = sub === 'send'
    ? new LabelBuilder().setLabel('Title (optional)').setDescription('Adds a coloured box with a heading').setTextInputComponent(new TextInputBuilder().setCustomId('title').setStyle(TextInputStyle.Short).setMaxLength(250).setRequired(false))
    : new LabelBuilder().setLabel('When').setDescription('For example: 2h, 1d, or 2026-12-31 18:30').setTextInputComponent(new TextInputBuilder().setCustomId('when').setStyle(TextInputStyle.Short).setMaxLength(40).setRequired(true).setPlaceholder('2h'));
  const channel = new ChannelSelectMenuBuilder().setCustomId('channel').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1).setPlaceholder('Choose a channel');
  if (channelId) channel.setDefaultChannels(channelId);
  const notify = new StringSelectMenuBuilder().setCustomId('notify').setMinValues(1).setMaxValues(1).addOptions(
    new StringSelectMenuOptionBuilder().setLabel('Nobody').setDescription('Post quietly').setValue('none').setDefault(true),
    new StringSelectMenuOptionBuilder().setLabel('@here').setDescription('People who are online').setValue('here'),
    new StringSelectMenuOptionBuilder().setLabel('@everyone').setDescription('Everyone in the server').setValue('everyone'));
  const roles = new RoleSelectMenuBuilder().setCustomId('roles').setMinValues(0).setMaxValues(5).setRequired(false).setPlaceholder('No roles');
  return new ModalBuilder().setCustomId(`announce:form:${token}`).setTitle(sub === 'send' ? 'New announcement' : 'Schedule an announcement').addLabelComponents(
    new LabelBuilder().setLabel('Message').setTextInputComponent(text),
    second,
    new LabelBuilder().setLabel('Channel').setChannelSelectMenuComponent(channel),
    new LabelBuilder().setLabel('Notify').setStringSelectMenuComponent(notify),
    new LabelBuilder().setLabel('Also ping these roles (optional)').setRoleSelectMenuComponent(roles));
}

async function announceCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  if (sub === 'list') {
    const rows = ctx.data.list('sched:').map(({ value: s }) => `**#${s.id}** ${ts(s.nextAt, 'f')} → <#${s.channelId}>${s.repeat !== 'none' ? ` (${s.repeat})` : ''} - ${truncate(s.text, 60)}`);
    return i.reply({ content: rows.join('\n') || 'Nothing scheduled.', flags: EPH, allowedMentions: NOPING });
  }
  if (sub === 'cancel') {
    const id = i.options.getInteger('id', true);
    if (!ctx.data.get(`sched:${id}`)) throw new UserError('No scheduled announcement with that number.');
    ctx.data.delete(`sched:${id}`);
    return i.reply({ content: `Cancelled #${id}.`, flags: EPH });
  }

  // Nothing typed: everything in one popup.
  if (!i.options.getChannel('channel') && !i.options.getString('message')) {
    if (sub === 'schedule' && ctx.data.list('sched:').length >= MAX_SCHEDULES) throw new UserError(`You can keep up to ${MAX_SCHEDULES} scheduled announcements.`);
    const colorRaw0 = i.options.getString('color'); const color0 = colorRaw0 ? normalizeHex(colorRaw0) : null;
    if (colorRaw0 && !color0) throw new UserError('Colors look like `#5865F2`.');
    const form = { sub, rich: true, by: i.user.id, color: color0, title: i.options.getString('title') ?? undefined, repeat: i.options.getString('repeat') ?? 'none' };
    return i.showModal(richAnnounceModal(forms.put(form), sub, { channelId: i.channelId }));
  }
  const ch = await getChannelOption(i, 'channel', true);
  if (!ch?.isTextBased()) throw new UserError('Pick a text channel.');
  const colorRaw = i.options.getString('color');
  const color = colorRaw ? normalizeHex(colorRaw) : null;
  if (colorRaw && !color) throw new UserError('Colors look like `#5865F2`.');
  const ping = i.options.getString('ping') ?? 'none';
  const form = { sub, channelId: ch.id, color, ping, roleIds: roleIdsFrom(i, ping), by: i.user.id, title: i.options.getString('title') ?? undefined };
  if (sub === 'schedule') {
    if (ctx.data.list('sched:').length >= MAX_SCHEDULES) throw new UserError(`You can keep up to ${MAX_SCHEDULES} scheduled announcements.`);
    const whenRaw = i.options.getString('when');
    if (!whenRaw) throw new UserError('Say when with the `when` option, or run `/announce schedule` with nothing filled in to use the popup.');
    form.at = parseWhen(whenRaw, ctx.config.get('timezoneOffset'));
    if (form.at < Date.now() + 30000) throw new UserError('That time is in the past (or too soon). Pick at least a minute ahead.');
    if (form.at > Date.now() + 366 * DAY) throw new UserError('Schedule within the next year.');
    form.repeat = i.options.getString('repeat') ?? 'none';
  }

  const text = i.options.getString('message');
  if (text) return finishAnnouncement(ctx, i, form, text, form.title);

  // No text typed in the command: ask for it in a popup (Discord has no way to type a line break in a slash option).
  return i.showModal(announceModal(forms.put(form), sub, form.title));
}

async function announceForm(ctx, i) {
  const form = forms.take(i.customId.split(':')[2], i.user.id);
  const text = i.fields.getTextInputValue('text').trim();
  if (!text) throw new UserError('The message cannot be empty.');
  if (form.rich) {
    const chosen = [...(i.fields.getSelectedChannels('channel', false)?.values?.() ?? [])][0] ?? null;
    form.channelId = chosen?.id ?? i.channelId;
    const notify = (i.fields.getStringSelectValues('notify') ?? [])[0] ?? 'none';
    const roleIds = [...(i.fields.getSelectedRoles('roles', false)?.keys?.() ?? [])].filter((id) => id !== ctx.guild.id);
    form.ping = notify !== 'none' ? notify : roleIds.length ? 'role' : 'none';
    form.roleIds = form.ping === 'role' ? roleIds : [];
    if (form.sub === 'schedule') {
      form.at = parseWhen(i.fields.getTextInputValue('when'), ctx.config.get('timezoneOffset'));
      if (form.at < Date.now() + 30000) throw new UserError('That time is in the past (or too soon). Pick at least a minute ahead.');
      if (form.at > Date.now() + 366 * DAY) throw new UserError('Schedule within the next year.');
      return finishAnnouncement(ctx, i, form, text, form.title);
    }
    return finishAnnouncement(ctx, i, form, text, i.fields.getTextInputValue('title').trim() || form.title);
  }
  return finishAnnouncement(ctx, i, form, text, i.fields.getTextInputValue('title').trim() || undefined);
}

async function finishAnnouncement(ctx, i, form, text, title) {
  const ch = textChannel(ctx, form.channelId);
  if (!ch) throw new UserError('That channel no longer exists.');
  const problem = pingProblem(ctx, ch, form.ping, form.roleIds);
  const warn = problem ? `\n⚠️ **It was posted without the ping.** ${problem}` : '';

  if (form.sub === 'send') {
    const payload = announcePayload({ text, title, color: form.color, ping: problem ? 'none' : form.ping, roleIds: form.roleIds });
    try { await ch.send(payload); }
    catch (e) { throw new UserError(describeDiscordError(e, `post in <#${ch.id}>`)); }
    return i.reply({ content: `Announcement sent to <#${ch.id}>.${warn}`, flags: EPH });
  }

  const id = ctx.data.update('schedCounter', (n) => n + 1, 0);
  ctx.data.set(`sched:${id}`, { id, channelId: ch.id, text, title, color: form.color, ping: form.ping, roleIds: form.roleIds, repeat: form.repeat, nextAt: form.at, by: form.by });
  const heads = problem ? `\n⚠️ **Right now it would post without the ping.** ${problem}` : '';
  return i.reply({ content: `Scheduled **#${id}** for ${ts(form.at, 'f')} (${ts(form.at)}).${heads}`, flags: EPH });
}

async function schedulerTask(ctx) {
  const now = Date.now();
  for (const { key, value: s } of ctx.data.list('sched:')) {
    if (s.nextAt > now) continue;
    const ch = textChannel(ctx, s.channelId);
    if (!ch) { ctx.log.warn(`Scheduled announcement #${s.id} dropped: channel is gone`); ctx.data.delete(key); continue; }
    const roleIds = s.roleIds ?? (s.roleId ? [s.roleId] : []); // older entries stored a single role
    const problem = pingProblem(ctx, ch, s.ping, roleIds);
    if (problem) ctx.log.warn(`Scheduled announcement #${s.id} will post without its ping: ${problem}`);
    const payload = announcePayload({ text: s.text, title: s.title, color: s.color, ping: problem ? 'none' : s.ping, roleIds });
    const sent = await ctx.queue(() => ch.send(payload)).then(() => true).catch((e) => { ctx.log.warn(`Scheduled announcement #${s.id} failed: ${e.message}`); return false; });
    // Make "posted without the ping" visible in Discord too, not only in the console: tell whoever scheduled it.
    if (sent && problem && s.by) {
      const u = await ctx.client.users.fetch(s.by).catch(() => null);
      await u?.send({ content: `⚠️ Scheduled announcement **#${s.id}** was posted in <#${ch.id}> **without its ping.** ${problem}`, allowedMentions: { parse: [] } }).catch(() => {});
    }
    if (s.repeat === 'none') ctx.data.delete(key);
    else { const step = s.repeat === 'weekly' ? 7 * DAY : DAY; while (s.nextAt <= now) s.nextAt += step; ctx.data.set(key, s); }
  }
}

// ------------------------------------------------------------------ shared voting engine
// Polls and suggestions use the same pieces: vote records, bars, one-vote-per-person toggling,
// status/closing, embeds + buttons, and the same results view. Old suggestion records (moved here
// from the support module by database migration) keep working: same shape, same "sugg:" buttons.
const choicesOf = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
const signed = (n) => (n >= 0 ? `+${n}` : String(n));

function pollEmbed(p) {
  const voters = Object.keys(p.votes).length;
  const counts = p.options.map((_, n) => Object.values(p.votes).filter((v) => choicesOf(v).includes(n)).length);
  const lines = p.options.map((o, n) => `**${n + 1}. ${truncate(o, 100)}**\n${progressBar(counts[n], Math.max(voters, 1), 14)} ${counts[n]} (${voters ? Math.round((counts[n] / voters) * 100) : 0}%)`);
  const e = new EmbedBuilder().setColor(p.closed ? 0x95a5a6 : 0x5865f2).setTitle(`📊 ${truncate(p.question, 250)}`).setDescription(lines.join('\n\n'))
    .setFooter({ text: `${voters} voter(s)${p.multi ? ' · pick several' : ''} · ${p.closed ? 'Poll closed' : p.endsAt ? 'Ends' : 'Open until ended'}` });
  if (!p.closed && p.endsAt) e.setTimestamp(p.endsAt);
  return e;
}
const pollRows = (p, off) => {
  const rows = [];
  for (let n = 0; n < p.options.length; n += 5) {
    const row = new ActionRowBuilder();
    p.options.slice(n, n + 5).forEach((_, k) => row.addComponents(new ButtonBuilder().setCustomId(`poll:vote:${n + k}`).setLabel(`${n + k + 1}`).setStyle(ButtonStyle.Primary).setDisabled(off)));
    rows.push(row);
  }
  return rows;
};

async function closePoll(ctx, key, p) {
  p.closed = true;
  ctx.data.set(key, p);
  const ch = textChannel(ctx, p.channelId);
  const msg = await ch?.messages.fetch(p.messageId).catch(() => null);
  await msg?.edit({ embeds: [pollEmbed(p)], components: pollRows(p, true) }).catch(() => {});
  await ch?.send({ content: `📊 The poll **${truncate(p.question, 100)}** has ended.`, reply: msg ? { messageReference: msg.id, failIfNotExists: false } : undefined, allowedMentions: NOPING }).catch(() => {});
}

// ------------------------------------------------------------------ popups for polls and suggestions
const engForms = formStore('engagement');
const field = (id, label, style, { required = true, max = 100, value, placeholder } = {}) => {
  const t = new TextInputBuilder().setCustomId(id).setLabel(label.slice(0, 45)).setStyle(style).setRequired(required).setMaxLength(max);
  if (value) t.setValue(String(value).slice(0, max));
  if (placeholder) t.setPlaceholder(placeholder.slice(0, 100));
  return new ActionRowBuilder().addComponents(t);
};
export function pollModal(token, { question, options = [], durRaw, multi } = {}) {
  return new ModalBuilder().setCustomId(`engform:poll:${token}`).setTitle('New poll').addComponents(
    field('question', 'Question', TextInputStyle.Short, { max: 250, value: question }),
    field('options', 'Choices - one per line (2 to 5)', TextInputStyle.Paragraph, { max: 600, value: options.join('\n'), placeholder: 'Pizza\nTacos\nSushi' }),
    field('duration', 'Closes after (optional) e.g. 2h, 3d', TextInputStyle.Short, { required: false, max: 10, value: durRaw }),
    field('multiple', 'Allow several choices? yes / no', TextInputStyle.Short, { required: false, max: 3, value: multi ? 'yes' : '' }));
}
const ideaModal = (token) => new ModalBuilder().setCustomId(`engform:idea:${token}`).setTitle('New suggestion').addComponents(
  field('idea', 'Your suggestion', TextInputStyle.Paragraph, { max: 1000, placeholder: 'What should we add or change, and why?' }));
const editModal = (token, text) => new ModalBuilder().setCustomId(`engform:edit:${token}`).setTitle('Edit your suggestion').addComponents(
  field('idea', 'Your suggestion', TextInputStyle.Paragraph, { max: 1000, value: text }));

async function engagementForm(ctx, i) {
  const [, kind, token] = i.customId.split(':');
  const form = engForms.take(token, i.user.id);
  const text = (id) => { try { return (i.fields.getTextInputValue(id) ?? '').trim(); } catch { return ''; } };
  if (kind === 'poll') {
    need(ctx, i, 'engagement.poll');
    const options = text('options').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    return createPoll(ctx, i, { question: text('question'), options, durRaw: text('duration') || null, multi: /^(y|yes|true|1)$/i.test(text('multiple')) });
  }
  if (kind === 'idea') return submitSuggestion(ctx, i, text('idea'), form.anonymous);
  if (kind === 'edit') {
    const s = getSugg(ctx, form.id);
    if (s.author !== i.user.id && !ctx.perms.check(i.member, 'engagement.suggestions')) throw new UserError('You can only edit your own suggestions.');
    return saveSuggestionEdit(ctx, i, s, text('idea'));
  }
}

async function pollCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  if (sub === 'end') {
    const id = i.options.getString('message_id', true).trim();
    const p = ctx.data.get(`poll:${id}`);
    if (!p || p.closed) throw new UserError('No open poll with that message ID.');
    if (p.author !== i.user.id && !ctx.perms.check(i.member, 'engagement.announce')) throw new UserError('Only the poll creator or an announcer can end it.');
    await closePoll(ctx, `poll:${id}`, p);
    return i.reply({ content: 'Poll ended.', flags: EPH });
  }
  need(ctx, i, 'engagement.poll');
  const options = [];
  for (let n = 1; n <= 5; n++) { const o = i.options.getString(`option${n}`); if (o) options.push(o.trim()); }
  const question = i.options.getString('question');
  const durRaw = i.options.getString('duration');
  const multi = !!i.options.getBoolean('multiple');
  // Missing the question or the choices: ask for them in a popup (one choice per line).
  if (!question || options.length < 2) {
    return i.showModal(pollModal(engForms.put({ kind: 'poll', by: i.user.id, channelId: i.channelId }), { question, options, durRaw, multi }));
  }
  return createPoll(ctx, i, { question, options, durRaw, multi });
}

async function createPoll(ctx, i, { question, options, durRaw, multi }) {
  question = String(question).trim();
  if (!question) throw new UserError('A poll needs a question.');
  if (options.length < 2) throw new UserError('Give at least two choices, one per line.');
  if (options.length > 5) throw new UserError('Polls can have up to 5 choices.');
  if (options.some((o) => o.length > 100)) throw new UserError('Each choice can be at most 100 characters.');
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw new UserError('Each option must be different.');
  const dur = durRaw ? parseDuration(durRaw) : null;
  if (durRaw && (!dur || dur > 30 * DAY)) throw new UserError('Use a duration like `30m`, `2h` or `3d` (max 30 days).');
  const p = { question, options, votes: {}, author: i.user.id, channelId: i.channelId, endsAt: dur ? Date.now() + dur : null, closed: false, multi };
  await i.reply({ embeds: [pollEmbed(p)], components: pollRows(p, false) });
  const msg = await i.fetchReply();
  p.messageId = msg.id;
  ctx.data.set(`poll:${msg.id}`, p);
}

async function pollVote(ctx, i) {
  const key = `poll:${i.message.id}`;
  const p = ctx.data.get(key);
  if (!p || p.closed) throw new UserError('This poll has ended.');
  const n = Number(i.customId.split(':')[2]);
  if (!(n >= 0 && n < p.options.length)) throw new UserError('Invalid option.');
  if (p.multi) {
    const mine = new Set(choicesOf(p.votes[i.user.id]));
    if (!mine.delete(n)) mine.add(n);
    if (mine.size) p.votes[i.user.id] = [...mine].sort((a, b) => a - b); else delete p.votes[i.user.id];
  } else if (p.votes[i.user.id] === n) delete p.votes[i.user.id]; else p.votes[i.user.id] = n;
  ctx.data.set(key, p);
  await i.update({ embeds: [pollEmbed(p)] });
}

async function pollTask(ctx) {
  const now = Date.now();
  for (const { key, value: p } of ctx.data.list('poll:')) if (!p.closed && p.endsAt && p.endsAt <= now) await closePoll(ctx, key, p);
}

// ------------------------------------------------------------------ suggestions (same engine, with statuses)
const STATUS = {
  open: { color: 0xfee75c, label: 'Open', voting: true },
  considering: { color: 0x3498db, label: 'Under consideration', voting: true },
  approved: { color: 0x57f287, label: 'Approved', voting: false },
  implemented: { color: 0x9b59b6, label: 'Implemented', voting: false },
  denied: { color: 0xed4245, label: 'Denied', voting: false },
};
const net = (s) => s.up.length - s.down.length;
const stat = (s) => STATUS[s.status] ?? STATUS.open;

function suggEmbed(s) {
  const e = new EmbedBuilder().setColor(stat(s).color).setTitle(`Suggestion #${s.id}`).setDescription(truncate(s.text, 1800))
    .addFields({ name: 'Votes', value: `👍 ${s.up.length}   👎 ${s.down.length}   (net ${signed(net(s))})`, inline: true }, { name: 'Status', value: stat(s).label, inline: true })
    .setFooter({ text: s.anonymous ? 'Anonymous suggestion' : `by ${s.authorTag}${s.edited ? ' · edited' : ''}` });
  if (s.note) e.addFields({ name: 'Staff note', value: truncate(s.note, 500) });
  return e;
}
const suggRow = (s) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`sugg:up:${s.id}`).setEmoji('👍').setStyle(ButtonStyle.Secondary).setDisabled(!stat(s).voting),
  new ButtonBuilder().setCustomId(`sugg:down:${s.id}`).setEmoji('👎').setStyle(ButtonStyle.Secondary).setDisabled(!stat(s).voting));

async function refreshSuggestion(ctx, s) {
  const ch = textChannel(ctx, s.channelId);
  const msg = await ch?.messages.fetch(s.messageId).catch(() => null);
  await msg?.edit({ embeds: [suggEmbed(s)], components: [suggRow(s)] }).catch(() => {});
}

const getSugg = (ctx, id) => { const s = ctx.data.get(`sugg:${id}`); if (!s) throw new UserError('No suggestion with that number.'); return s; };

async function suggestCmd(ctx, i) {
  const ch = textChannel(ctx, ctx.config.get('suggestionChannel'));
  if (!ch) throw new UserError('Suggestions are not set up here yet. An admin can run `/suggestion setup channel:#suggestions`.');
  checkSuggestionCooldown(ctx, i);
  const idea = i.options.getString('idea');
  const anonymous = !!i.options.getBoolean('anonymous');
  if (!idea) return i.showModal(ideaModal(engForms.put({ kind: 'idea', by: i.user.id, anonymous })));
  return submitSuggestion(ctx, i, idea, anonymous);
}

function checkSuggestionCooldown(ctx, i) {
  const cooldown = ctx.config.get('suggestionCooldownSeconds') * 1000;
  const last = ctx.data.get(`cool:${i.user.id}`) ?? 0;
  if (Date.now() - last < cooldown) throw new UserError(`Please wait ${Math.ceil((cooldown - (Date.now() - last)) / 1000)}s before another suggestion.`);
}

async function submitSuggestion(ctx, i, idea, anonymousWanted) {
  const ch = textChannel(ctx, ctx.config.get('suggestionChannel'));
  if (!ch) throw new UserError('Suggestions are not set up here yet. An admin can run `/suggestion setup channel:#suggestions`.');
  checkSuggestionCooldown(ctx, i);
  idea = String(idea ?? '').trim();
  if (!idea) throw new UserError('A suggestion cannot be empty.');
  await i.deferReply({ flags: EPH });
  const id = ctx.data.update('suggCounter', (n) => n + 1, 0);
  const s = { id, text: idea, author: i.user.id, authorTag: i.user.tag, anonymous: !!anonymousWanted && ctx.config.get('suggestionAllowAnonymous'),
    up: [], down: [], status: 'open', channelId: ch.id, createdAt: Date.now(), history: [] };
  let msg;
  try { msg = await ch.send({ embeds: [suggEmbed(s)], components: [suggRow(s)], allowedMentions: NOPING }); }
  catch (e) { ctx.data.update('suggCounter', (n) => n - 1, 0); throw new UserError(describeDiscordError(e, 'post your suggestion')); }
  s.messageId = msg.id;
  if (ctx.config.get('suggestionThreads')) {
    try { const th = await msg.startThread({ name: `Suggestion #${id}`, autoArchiveDuration: 1440 }); s.threadId = th.id; } catch { /* threads are optional */ }
  }
  ctx.data.set(`sugg:${id}`, s);
  ctx.data.set(`cool:${i.user.id}`, Date.now());
  await i.editReply({ content: `Thanks! Your suggestion is **#${id}**: ${msg.url}` });
}

async function suggestionVote(ctx, i) {
  const [, dir, id] = i.customId.split(':');
  const s = ctx.data.get(`sugg:${id}`);
  if (!s || !stat(s).voting) throw new UserError('Voting on this suggestion is closed.');
  const mine = dir === 'up' ? 'up' : 'down', other = mine === 'up' ? 'down' : 'up';
  s[other] = s[other].filter((u) => u !== i.user.id);
  s[mine] = s[mine].includes(i.user.id) ? s[mine].filter((u) => u !== i.user.id) : [...s[mine], i.user.id];
  ctx.data.set(`sugg:${id}`, s);
  await i.update({ embeds: [suggEmbed(s)], components: [suggRow(s)] });
}

async function saveSuggestionEdit(ctx, i, s, text) {
  text = String(text ?? '').trim();
  if (!text) throw new UserError('A suggestion cannot be empty.');
  const fresh = getSugg(ctx, s.id);
  if (!stat(fresh).voting) throw new UserError('That suggestion is closed.');
  fresh.text = text; fresh.edited = true;
  ctx.data.set(`sugg:${fresh.id}`, fresh);
  await refreshSuggestion(ctx, fresh);
  return i.reply({ content: 'Updated.', flags: EPH });
}

const line = (ctx, s) => `**#${s.id}** ${signed(net(s))} · ${stat(s).label} · ${truncate(s.text, 70)}${s.messageId ? ` ([jump](https://discord.com/channels/${ctx.guildId}/${s.channelId}/${s.messageId}))` : ''}`;

async function suggestionCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  if (sub === 'setup') {
    need(ctx, i, 'engagement.manage');
    const ch = await getChannelOption(i, 'channel', true);
    if (!ch?.isTextBased()) throw new UserError('Pick a text channel.');
    const perms = ch.permissionsFor?.(i.guild.members.me);
    const missing = ['ViewChannel', 'SendMessages', 'EmbedLinks'].filter((n) => !perms?.has(P[n]));
    if (missing.length) throw new UserError(`I'm missing **${missing.join(', ')}** in <#${ch.id}>.`);
    ctx.settings.set('suggestionChannel', ch.id);
    return i.reply({ content: `Suggestions will be posted in <#${ch.id}>. Members use \`/suggest\`.`, flags: EPH });
  }
  const staff = ctx.perms.check(i.member, 'engagement.suggestions');
  if (sub === 'status' || sub === 'delete') {
    if (!staff) throw new UserError('Only staff can do that (`engagement.suggestions`).');
    const s = getSugg(ctx, i.options.getInteger('id', true));
    if (sub === 'delete') {
      await textChannel(ctx, s.channelId)?.messages.delete(s.messageId).catch(() => {});
      ctx.data.delete(`sugg:${s.id}`);
      return i.reply({ content: `Deleted suggestion #${s.id}.`, flags: EPH });
    }
    const status = i.options.getString('status', true);
    if (!STATUS[status]) throw new UserError('Unknown status.');
    s.status = status; s.note = i.options.getString('note') ?? s.note;
    (s.history ??= []).push({ status, by: i.user.id, at: Date.now(), note: s.note ?? null });
    ctx.data.set(`sugg:${s.id}`, s);
    await refreshSuggestion(ctx, s);
    const th = s.threadId && ctx.guild.channels.cache.get(s.threadId);
    await th?.send({ content: `Status changed to **${stat(s).label}** by <@${i.user.id}>${s.note ? `: ${truncate(s.note, 300)}` : '.'}`, allowedMentions: NOPING }).catch(() => {});
    if (!stat(s).voting) await th?.setLocked?.(true).catch(() => {});
    if (ctx.notify.allowed(s.author, 'dms')) {
      const user = await ctx.client.users.fetch(s.author).catch(() => null);
      await user?.send({ content: `Your suggestion #${s.id} in **${truncate(i.guild.name, 60)}** is now **${stat(s).label}**${s.note ? `: ${truncate(s.note, 300)}` : '.'}`, allowedMentions: NOPING }).catch(() => {});
    }
    return i.reply({ content: `Suggestion #${s.id} is now **${stat(s).label}**.`, flags: EPH });
  }
  if (sub === 'edit') {
    const s = getSugg(ctx, i.options.getInteger('id', true));
    if (s.author !== i.user.id && !staff) throw new UserError('You can only edit your own suggestions.');
    if (!stat(s).voting) throw new UserError('That suggestion is closed.');
    const text = i.options.getString('text');
    if (!text) return i.showModal(editModal(engForms.put({ kind: 'edit', by: i.user.id, id: s.id }), s.text));
    return saveSuggestionEdit(ctx, i, s, text);
  }
  if (sub === 'info') {
    const s = getSugg(ctx, i.options.getInteger('id', true));
    const e = suggEmbed(s);
    if (staff) e.addFields({ name: 'Author (staff only)', value: `<@${s.author}>` });
    if (staff && s.history?.length) e.addFields({ name: 'History', value: truncate(s.history.slice(-5).map((h) => `${STATUS[h.status]?.label ?? h.status} by <@${h.by}> ${ts(h.at)}`).join('\n'), 900) });
    return i.reply({ embeds: [e], flags: EPH, allowedMentions: NOPING });
  }
  const all = ctx.data.list('sugg:').map((x) => x.value);
  if (sub === 'mine') {
    const mine = all.filter((s) => s.author === i.user.id).sort((a, b) => b.id - a.id).slice(0, 10);
    return i.reply({ content: mine.map((s) => line(ctx, s)).join('\n') || 'You have no suggestions yet.', flags: EPH, allowedMentions: NOPING });
  }
  // top
  const want = i.options.getString('status');
  const pool = all.filter((s) => (want ? s.status === want : stat(s).voting)).sort((a, b) => net(b) - net(a) || a.id - b.id).slice(0, 10);
  await i.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`Top suggestions${want ? ` · ${STATUS[want].label}` : ''}`).setDescription(pool.map((s) => line(ctx, s)).join('\n') || 'Nothing here yet.')], flags: EPH, allowedMentions: NOPING });
}

// ------------------------------------------------------------------ starboard
const EMOJI_RE = /^(?:<a?:\w{2,32}:\d{17,20}>|(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\u200d(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}))*\ufe0f?|[\u2b50\u2764\u2728])$/u;
const isStarEmoji = (reaction, want) => reaction.emoji.name === want || reaction.emoji.toString() === want;

export function starProblems(ctx, guild) {
  const out = [];
  const ch = textChannel(ctx, ctx.config.get('starboardChannel'));
  if (!ctx.config.get('starboardChannel')) out.push('No starboard channel is set (`/starboard setup`).');
  else if (!ch) out.push('The starboard channel was deleted or is not a text channel.');
  else {
    const perms = ch.permissionsFor?.(guild.members.me);
    const missing = ['ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'].filter((n) => !perms?.has(P[n]));
    if (missing.length) out.push(`Missing **${missing.join(', ')}** in <#${ch.id}>.`);
  }
  if (!ctx.hasIntent('GuildMessageReactions') && !ctx.hasIntent('Guilds')) out.push('Reaction events are unavailable.');
  return out;
}

async function starboardCmd(ctx, i) {
  const group = i.options.getSubcommandGroup(false);
  const sub = i.options.getSubcommand();
  if (sub !== 'top') need(ctx, i, 'engagement.manage');

  if (sub === 'setup') {
    const ch = await getChannelOption(i, 'channel', true);
    if (!ch?.isTextBased()) throw new UserError('Pick a text channel.');
    const perms = ch.permissionsFor?.(i.guild.members.me);
    const missing = ['ViewChannel', 'SendMessages', 'EmbedLinks'].filter((n) => !perms?.has(P[n]));
    if (missing.length) throw new UserError(`I'm missing **${missing.join(', ')}** in <#${ch.id}>.`);
    const emoji = i.options.getString('emoji');
    if (emoji && !EMOJI_RE.test(emoji.trim())) throw new UserError('That is not a single emoji (a normal emoji or a custom one like `<:name:123…>`).');
    ctx.settings.set('starboardChannel', ch.id);
    if (emoji) ctx.settings.set('starEmoji', emoji.trim());
    const t = i.options.getInteger('threshold');
    if (t) ctx.settings.set('starThreshold', t);
    ctx.settings.set('starEnabled', true);
    return i.reply({ content: `⭐ Starboard is on: <#${ch.id}>, ${ctx.config.get('starEmoji')} × ${ctx.config.get('starThreshold')}.`, flags: EPH });
  }
  if (sub === 'enable' || sub === 'disable') { ctx.settings.set('starEnabled', sub === 'enable'); return i.reply({ content: `Starboard ${sub}d.`, flags: EPH }); }
  if (sub === 'channel') {
    const ch = await getChannelOption(i, 'channel', true);
    if (!ch?.isTextBased()) throw new UserError('Pick a text channel.');
    ctx.settings.set('starboardChannel', ch.id);
    return i.reply({ content: `Starboard channel is now <#${ch.id}>. Existing starred posts stay where they are.`, flags: EPH });
  }
  if (sub === 'emoji') {
    const emoji = i.options.getString('emoji', true).trim();
    if (!EMOJI_RE.test(emoji)) throw new UserError('That is not a single emoji.');
    ctx.settings.set('starEmoji', emoji);
    return i.reply({ content: `Starboard emoji is now ${emoji}.`, flags: EPH });
  }
  if (sub === 'threshold') { ctx.settings.set('starThreshold', i.options.getInteger('count', true)); return i.reply({ content: `Messages need **${ctx.config.get('starThreshold')}** stars.`, flags: EPH }); }
  if (sub === 'options') {
    const map = { self_star: 'starSelf', ignore_bots: 'starIgnoreBots', remove_below: 'starRemoveBelow', allow_nsfw: 'starAllowNsfw' };
    let changed = 0;
    for (const [opt, key] of Object.entries(map)) { const v = i.options.getBoolean(opt); if (v !== null) { ctx.settings.set(key, v); changed++; } }
    if (!changed) throw new UserError('Choose at least one option to change.');
    return i.reply({ content: `Saved. Run \`/starboard status\` to review.`, flags: EPH });
  }
  if (group === 'ignore') {
    if (sub === 'list') return i.reply({ content: (ctx.config.get('starIgnoreChannels') ?? []).map((c) => `<#${c}>`).join(' ') || 'No channels are ignored.', flags: EPH, allowedMentions: NOPING });
    const ch = await getChannelOption(i, 'channel', true);
    ctx.settings.set('starIgnoreChannels', ch.id, sub === 'add' ? 'add' : 'remove');
    return i.reply({ content: `${sub === 'add' ? 'Now ignoring' : 'No longer ignoring'} <#${ch.id}>.`, flags: EPH });
  }
  if (sub === 'status') {
    const problems = starProblems(ctx, i.guild);
    const b = (k) => (ctx.config.get(k) ? '✅ yes' : '❌ no');
    const e = new EmbedBuilder().setColor(problems.length || !ctx.config.get('starEnabled') ? 0xfaa61a : 0x57f287).setTitle('Starboard status')
      .addFields({ name: 'Enabled', value: b('starEnabled'), inline: true }, { name: 'Channel', value: ctx.config.get('starboardChannel') ? `<#${ctx.config.get('starboardChannel')}>` : '*not set*', inline: true },
        { name: 'Emoji × threshold', value: `${ctx.config.get('starEmoji')} × ${ctx.config.get('starThreshold')}`, inline: true },
        { name: 'Behaviour', value: `Count author's own star: ${b('starSelf')}\nIgnore bot messages: ${b('starIgnoreBots')}\nRemove from board when below threshold: ${b('starRemoveBelow')}\nAllow NSFW channels: ${b('starAllowNsfw')}` },
        { name: 'Ignored channels', value: (ctx.config.get('starIgnoreChannels') ?? []).map((c) => `<#${c}>`).join(' ') || '*none*' },
        { name: 'Starred messages', value: String(ctx.data.list('star:').length), inline: true },
        { name: 'Checks', value: problems.length ? problems.map((p) => `❌ ${p}`).join('\n') : '✅ everything looks right' });
    return i.reply({ embeds: [e], flags: EPH, allowedMentions: NOPING });
  }
  // top
  const rows = ctx.data.list('star:').map((x) => x.value).filter((r) => r.count).sort((a, b) => b.count - a.count).slice(0, 10)
    .map((r, n) => `**${n + 1}.** ${ctx.config.get('starEmoji')} ${r.count} · <@${r.authorId}> · [jump](${r.url})`);
  await i.reply({ embeds: [new EmbedBuilder().setColor(0xfee75c).setTitle('Most starred').setDescription(rows.join('\n') || 'Nothing has been starred yet.')], allowedMentions: NOPING });
}

async function onStar(ctx, reaction, user) {
  if (!ctx.config.get('starEnabled')) return;
  const boardId = ctx.config.get('starboardChannel');
  const board = textChannel(ctx, boardId);
  if (!board) return;
  const want = ctx.config.get('starEmoji');
  if (!isStarEmoji(reaction, want)) return;
  const message = reaction.message;
  if (message.channelId === boardId || !message.author) return;
  const ignored = ctx.config.get('starIgnoreChannels') ?? [];
  if (ignored.includes(message.channelId) || (message.channel?.parentId && ignored.includes(message.channel.parentId))) return;
  if (message.channel?.nsfw && !ctx.config.get('starAllowNsfw')) return;
  if (message.author.bot && ctx.config.get('starIgnoreBots')) return;
  if (starLocks.has(message.id)) return;
  starLocks.add(message.id);
  try {
    const users = await reaction.users.fetch();
    const self = ctx.config.get('starSelf');
    const count = users.filter((u) => !u.bot && (self || u.id !== message.author.id)).size;
    const key = `star:${message.id}`;
    const rec = ctx.data.get(key);
    const threshold = ctx.config.get('starThreshold');
    const header = `${want} **${count}** · <#${message.channelId}>`;

    if (count >= threshold) {
      const img = [...message.attachments.values()].find((a) => a.contentType?.startsWith('image/'));
      const e = new EmbedBuilder().setColor(0xfee75c).setAuthor({ name: message.member?.displayName ?? message.author.username, iconURL: message.author.displayAvatarURL() })
        .setDescription(truncate(message.content || (img ? '' : '*(no text)*'), 1800)).addFields({ name: 'Source', value: `[Jump to message](${message.url})` }).setTimestamp(message.createdTimestamp);
      if (img) e.setImage(img.url);
      const existing = rec && await board.messages.fetch(rec.boardMessageId).catch(() => null);
      const info = { count, authorId: message.author.id, url: message.url, channelId: message.channelId };
      if (existing) { await existing.edit({ content: header, embeds: [e], allowedMentions: NOPING }); ctx.data.set(key, { ...rec, ...info }); }
      else { const sent = await board.send({ content: header, embeds: [e], allowedMentions: NOPING }); ctx.data.set(key, { boardMessageId: sent.id, ...info }); }
    } else if (rec && ctx.config.get('starRemoveBelow')) {
      await board.messages.delete(rec.boardMessageId).catch(() => {});
      ctx.data.delete(key);
    } else if (rec) ctx.data.set(key, { ...rec, count });
  } finally { starLocks.delete(message.id); }
}

async function onMessageDelete(ctx, message) {
  const rec = ctx.data.get(`star:${message.id}`);
  if (!rec) return;
  await textChannel(ctx, ctx.config.get('starboardChannel'))?.messages.delete(rec.boardMessageId).catch(() => {});
  ctx.data.delete(`star:${message.id}`);
}

// ------------------------------------------------------------------ definition
const channelOpt = (o) => o.setName('channel').setDescription('Where to post').setRequired(true);
const announceOptions = (s, { schedule = false } = {}) => {
  // Everything is optional: with nothing filled in, one popup asks for it all.
  s.addChannelOption((o) => o.setName('channel').setDescription('Where to post (leave empty to choose in the popup)'));
  if (schedule) s.addStringOption((o) => o.setName('when').setDescription('e.g. 2h, 1d, or 2026-12-31 18:30 (or set it in the popup)'));
  s.addStringOption((o) => o.setName('message').setDescription('The text. Leave this empty to write it in a popup instead').setMaxLength(1800))
    .addStringOption((o) => o.setName('title').setDescription('Optional title (makes it an embed)').setMaxLength(250))
    .addStringOption((o) => o.setName('color').setDescription('Hex color for the embed, e.g. #5865F2'))
    .addStringOption((o) => o.setName('ping').setDescription('Notify people?').addChoices({ name: 'no ping', value: 'none' }, { name: '@everyone', value: 'everyone' }, { name: '@here', value: 'here' }, { name: 'role(s) chosen below', value: 'role' }))
    .addRoleOption((o) => o.setName('role').setDescription('Role to ping'))
    .addRoleOption((o) => o.setName('role2').setDescription('A second role to ping'))
    .addRoleOption((o) => o.setName('role3').setDescription('A third role to ping'));
  if (schedule) s.addStringOption((o) => o.setName('repeat').setDescription('Repeat?').addChoices({ name: 'no', value: 'none' }, { name: 'daily', value: 'daily' }, { name: 'weekly', value: 'weekly' }));
  return s;
};
const statusChoices = Object.entries(STATUS).map(([value, v]) => ({ name: v.label, value }));
const idOpt = (o) => o.setName('id').setDescription('Suggestion number').setRequired(true).setMinValue(1);

export default {
  name: 'engagement',
  version: '1.2.0',
  description: 'Announcements, polls and suggestions (one voting engine) and a configurable starboard.',
  settings: [
    { key: 'starEnabled', type: 'toggle', label: 'Starboard on', default: true },
    { key: 'starboardChannel', type: 'channel', label: 'Starboard channel' },
    { key: 'starThreshold', type: 'number', label: 'Stars needed', default: 3, min: 1, max: 50 },
    { key: 'starEmoji', type: 'text', label: 'Star emoji', default: '⭐', maxLength: 60 },
    { key: 'starSelf', type: 'toggle', label: 'Count the author\'s own star', default: false },
    { key: 'starIgnoreBots', type: 'toggle', label: 'Ignore messages from bots', default: true },
    { key: 'starRemoveBelow', type: 'toggle', label: 'Remove from the board if stars drop below the threshold', default: true },
    { key: 'starAllowNsfw', type: 'toggle', label: 'Allow messages from NSFW channels', default: false },
    { key: 'starIgnoreChannels', type: 'list', label: 'Channels (or categories) the starboard ignores - IDs' },
    { key: 'suggestionChannel', type: 'channel', label: 'Suggestions channel' },
    { key: 'suggestionCooldownSeconds', type: 'number', label: 'Seconds between a member\'s suggestions', default: 60, min: 0, max: 86400 },
    { key: 'suggestionThreads', type: 'toggle', label: 'Open a discussion thread for each suggestion', default: true },
    { key: 'suggestionAllowAnonymous', type: 'toggle', label: 'Allow anonymous suggestions', default: true },
    { key: 'timezoneOffset', type: 'number', label: 'Timezone offset from UTC for scheduled dates (hours)', default: 0, min: -12, max: 14 },
  ],
  permissions: [
    { key: 'engagement.announce', label: 'Send & schedule announcements, end any poll', default: 'admin' },
    { key: 'engagement.poll', label: 'Create polls', default: 'moderator' },
    { key: 'engagement.suggestions', label: 'Review, edit and delete suggestions', default: 'moderator' },
    { key: 'engagement.manage', label: 'Configure the starboard and suggestions', default: 'admin' },
  ],
  commands: [
    {
      permission: 'engagement.announce',
      data: new SlashCommandBuilder().setName('announce').setDescription('Announcements')
        .addSubcommand((s) => announceOptions(s.setName('send').setDescription('Post an announcement now')))
        .addSubcommand((s) => announceOptions(s.setName('schedule').setDescription('Post an announcement later'), { schedule: true }))
        .addSubcommand((s) => s.setName('list').setDescription('Show scheduled announcements'))
        .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a scheduled announcement').addIntegerOption((o) => o.setName('id').setDescription('Its number').setRequired(true))),
      execute: announceCmd,
    },
    {
      data: new SlashCommandBuilder().setName('poll').setDescription('Polls')
        .addSubcommand((s) => s.setName('create').setDescription('Start a poll in this channel')
          .addStringOption((o) => o.setName('question').setDescription('The question - leave empty to use a popup').setMaxLength(250))
          .addStringOption((o) => o.setName('option1').setDescription('First choice').setMaxLength(100))
          .addStringOption((o) => o.setName('option2').setDescription('Second choice').setMaxLength(100))
          .addStringOption((o) => o.setName('option3').setDescription('Third choice').setMaxLength(100))
          .addStringOption((o) => o.setName('option4').setDescription('Fourth choice').setMaxLength(100))
          .addStringOption((o) => o.setName('option5').setDescription('Fifth choice').setMaxLength(100))
          .addStringOption((o) => o.setName('duration').setDescription('Auto-close after, e.g. 30m, 2h, 3d'))
          .addBooleanOption((o) => o.setName('multiple').setDescription('Let people pick more than one option')))
        .addSubcommand((s) => s.setName('end').setDescription('End a poll early').addStringOption((o) => o.setName('message_id').setDescription('Poll message ID').setRequired(true))),
      execute: pollCmd,
    },
    {
      data: new SlashCommandBuilder().setName('suggest').setDescription('Suggest something for the server')
        .addStringOption((o) => o.setName('idea').setDescription('Your suggestion - leave empty to write it in a popup').setMaxLength(1000))
        .addBooleanOption((o) => o.setName('anonymous').setDescription('Hide your name from the post')),
      execute: suggestCmd,
    },
    {
      data: new SlashCommandBuilder().setName('suggestion').setDescription('Manage and browse suggestions')
        .addSubcommand((s) => s.setName('setup').setDescription('(Admins) Choose the suggestions channel').addChannelOption(channelOpt))
        .addSubcommand((s) => s.setName('status').setDescription('(Staff) Change a suggestion\'s status')
          .addIntegerOption(idOpt).addStringOption((o) => o.setName('status').setDescription('New status').setRequired(true).addChoices(...statusChoices)).addStringOption((o) => o.setName('note').setDescription('Note shown to everyone').setMaxLength(500)))
        .addSubcommand((s) => s.setName('info').setDescription('Details about a suggestion').addIntegerOption(idOpt))
        .addSubcommand((s) => s.setName('top').setDescription('Most popular suggestions').addStringOption((o) => o.setName('status').setDescription('Only this status').addChoices(...statusChoices)))
        .addSubcommand((s) => s.setName('mine').setDescription('Your suggestions'))
        .addSubcommand((s) => s.setName('edit').setDescription('Edit a suggestion while it is open').addIntegerOption(idOpt).addStringOption((o) => o.setName('text').setDescription('New text - leave empty to edit in a popup').setMaxLength(1000)))
        .addSubcommand((s) => s.setName('delete').setDescription('(Staff) Delete a suggestion').addIntegerOption(idOpt)),
      execute: suggestionCmd,
    },
    {
      data: new SlashCommandBuilder().setName('starboard').setDescription('Starboard settings')
        .addSubcommand((s) => s.setName('setup').setDescription('Turn the starboard on in one step')
          .addChannelOption(channelOpt).addStringOption((o) => o.setName('emoji').setDescription('Emoji to count (default ⭐)')).addIntegerOption((o) => o.setName('threshold').setDescription('Stars needed').setMinValue(1).setMaxValue(50)))
        .addSubcommand((s) => s.setName('status').setDescription('Show settings and check they work'))
        .addSubcommand((s) => s.setName('enable').setDescription('Turn the starboard on'))
        .addSubcommand((s) => s.setName('disable').setDescription('Turn the starboard off'))
        .addSubcommand((s) => s.setName('channel').setDescription('Change the starboard channel').addChannelOption(channelOpt))
        .addSubcommand((s) => s.setName('emoji').setDescription('Change the emoji').addStringOption((o) => o.setName('emoji').setDescription('The emoji').setRequired(true)))
        .addSubcommand((s) => s.setName('threshold').setDescription('Change how many stars are needed').addIntegerOption((o) => o.setName('count').setDescription('Stars').setRequired(true).setMinValue(1).setMaxValue(50)))
        .addSubcommand((s) => s.setName('options').setDescription('Posting behaviour')
          .addBooleanOption((o) => o.setName('self_star').setDescription('Count the author\'s own star'))
          .addBooleanOption((o) => o.setName('ignore_bots').setDescription('Ignore messages from bots'))
          .addBooleanOption((o) => o.setName('remove_below').setDescription('Remove from the board if stars drop below the threshold'))
          .addBooleanOption((o) => o.setName('allow_nsfw').setDescription('Allow NSFW channels')))
        .addSubcommandGroup((g) => g.setName('ignore').setDescription('Channels the starboard ignores')
          .addSubcommand((s) => s.setName('add').setDescription('Ignore a channel or category').addChannelOption(channelOpt))
          .addSubcommand((s) => s.setName('remove').setDescription('Stop ignoring a channel').addChannelOption(channelOpt))
          .addSubcommand((s) => s.setName('list').setDescription('Show ignored channels')))
        .addSubcommand((s) => s.setName('top').setDescription('Most starred messages')),
      execute: starboardCmd,
    },
  ],
  views: {
    /** For the phone app: where announcements can go. */
    async 'announce-targets'(ctx) {
      const channels = [...(ctx.guild?.channels.cache.values() ?? [])].filter((c) => [0, 5].includes(c.type)).sort((x, y) => x.rawPosition - y.rawPosition).map((c) => ({ id: c.id, name: c.name }));
      const roles = [...(ctx.guild?.roles.cache.values() ?? [])].filter((r) => r.id !== ctx.guildId && !r.managed).sort((x, y) => y.position - x.position).map((r) => ({ id: r.id, name: r.name }));
      return { channels, roles };
    },
  },
  actions: {
    /** Post an announcement from the phone app or dashboard. Same rules as /announce send. */
    async announce(ctx, body, actor) {
      const ch = textChannel(ctx, String(body.channelId ?? ''));
      if (!ch) throw new UserError('Pick a text channel.');
      const text = String(body.message ?? '').trim();
      if (!text) throw new UserError('Write the announcement.');
      if (text.length > 3800) throw new UserError('That is too long (3800 characters at most).');
      const ping = ['none', 'here', 'everyone', 'role'].includes(body.ping) ? body.ping : 'none';
      const roleIds = ping === 'role' ? [...new Set([].concat(body.roleIds ?? []).map(String).filter((r) => ctx.guild?.roles.cache.has(r)))].slice(0, 3) : [];
      if (ping === 'role' && !roleIds.length) throw new UserError('Pick a role to ping.');
      const problem = pingProblem(ctx, ch, ping, roleIds);
      const title = String(body.title ?? '').trim().slice(0, 250) || undefined;
      try { await ch.send(announcePayload({ text, title, ping: problem ? 'none' : ping, roleIds })); }
      catch (e) { throw new UserError(describeDiscordError(e, `post in #${ch.name}`)); }
      ctx.log.info(`Announcement posted in #${ch.name} by ${actor?.username ?? 'the dashboard'}`);
      return { channel: ch.name, warning: problem ? `Posted without the ping: ${problem}` : null };
    },
  },
  components: [{ prefix: 'poll:', execute: pollVote }, { prefix: 'sugg:', execute: suggestionVote }, { prefix: 'announce:', execute: announceForm }, { prefix: 'engform:', execute: engagementForm }],
  events: { messageReactionAdd: onStar, messageReactionRemove: onStar, messageDelete: onMessageDelete },
  tasks: [
    { name: 'scheduler', everyMs: 30000, run: schedulerTask },
    { name: 'polls', everyMs: 30000, run: pollTask },
  ],
};
