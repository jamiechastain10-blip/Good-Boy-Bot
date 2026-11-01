/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Reminders.
 *   /remind me    - a personal reminder, by DM (or in the channel if DMs are closed or turned off)
 *   /remind team  - a reminder posted in a channel that notifies one or more roles; each role is shown on its own line
 *   /remind list / cancel
 * Team reminders can repeat daily or weekly. The long text of a team reminder is typed in a popup.
 */
import {
  SlashCommandBuilder, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, PermissionFlagsBits as P,
} from 'discord.js';
import { UserError, parseWhen, pingProblem, truncate, ts, getChannelOption, describeDiscordError } from '../../src/util.js';
import { formStore } from '../../src/forms.js';
import { formModal, readForm } from '../../src/modalkit.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const DAY = 86400000;
const MAX_ROLES = 5;
const LATE_AFTER = 5 * 60000; // later than this and the reminder says it is late (the bot was offline)
const forms = formStore('remind');
const need = (ctx, i, key) => { if (!ctx.perms.check(i.member, key)) throw new UserError(`You don't have permission for that (\`${key}\`).`); };
const unescapeNl = (s) => String(s).replace(/\\n/g, '\n');
const textChannel = (ctx, id) => { const c = id ? ctx.guild?.channels.cache.get(id) : null; return c?.isTextBased?.() ? c : null; };

/** What a team reminder looks like: a title line, every role on a line of its own, then the text. */
export function reminderPayload({ text, roleIds = [], late = false }) {
  const lines = ['⏰ **Reminder**', ...roleIds.map((id) => `<@&${id}>`), '', unescapeNl(text)];
  if (late) lines.push('', '*(sent late: the bot was offline at the scheduled time)*');
  return { content: truncate(lines.join('\n'), 2000), allowedMentions: roleIds.length ? { roles: roleIds } : NOPING };
}

const rolesOf = (i) => [...new Set(['role', 'role2', 'role3', 'role4', 'role5'].map((n) => i.options.getRole(n)?.id).filter(Boolean))];
const nextId = (ctx) => ctx.data.update('counter', (n) => n + 1, 0);
const all = (ctx) => ctx.data.list('r:').map((x) => x.value);

function remindModal(token) {
  return new ModalBuilder().setCustomId(`remind:form:${token}`).setTitle('Team reminder').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('text').setLabel('What should the reminder say?').setStyle(TextInputStyle.Paragraph).setMaxLength(1500).setRequired(true).setPlaceholder('New lines work.')));
}

function checkWhen(ctx, input) {
  const at = parseWhen(input, ctx.config.get('timezoneOffset'));
  if (at < Date.now() + 30000) throw new UserError('That time is in the past (or too soon). Pick at least a minute ahead.');
  if (at > Date.now() + 366 * DAY) throw new UserError('Set reminders within the next year.');
  return at;
}

async function remindCmd(ctx, i) {
  const sub = i.options.getSubcommand();

  if (sub === 'list') {
    const staff = ctx.perms.check(i.member, 'reminders.manage');
    const rows = all(ctx).filter((r) => staff || r.by === i.user.id).sort((a, b) => a.nextAt - b.nextAt).map((r) => {
      const where = r.kind === 'team' ? `<#${r.channelId}> · ${r.roleIds.map((id) => `<@&${id}>`).join(' ')}` : r.delivery === 'dm' ? 'DM' : `<#${r.channelId}>`;
      return `**#${r.id}** ${ts(r.nextAt, 'f')} → ${where}${r.repeat !== 'none' ? ` (${r.repeat})` : ''}${staff && r.by !== i.user.id ? ` · by <@${r.by}>` : ''}\n> ${truncate(unescapeNl(r.text).replace(/\n/g, ' '), 80)}`;
    });
    return i.reply({ content: truncate(rows.join('\n') || 'No reminders.', 1900), flags: EPH, allowedMentions: NOPING });
  }

  if (sub === 'cancel') {
    const id = i.options.getInteger('id', true);
    const r = ctx.data.get(`r:${id}`);
    if (!r) throw new UserError('No reminder with that number.');
    if (r.by !== i.user.id) need(ctx, i, 'reminders.manage');
    ctx.data.delete(`r:${id}`);
    return i.reply({ content: `Cancelled reminder #${id}.`, flags: EPH });
  }

  if (sub === 'me') {
    const mine = all(ctx).filter((r) => r.by === i.user.id);
    const max = ctx.config.get('maxPersonal');
    if (mine.length >= max) throw new UserError(`You can keep ${max} reminders at a time. Cancel one with \`/remind cancel\`.`);
    const at = checkWhen(ctx, i.options.getString('when', true));
    const id = nextId(ctx);
    ctx.data.set(`r:${id}`, { id, kind: 'me', by: i.user.id, channelId: i.channelId, text: i.options.getString('message', true), nextAt: at, repeat: 'none', delivery: i.options.getString('where') ?? 'dm', roleIds: [] });
    return i.reply({ content: `Okay, I'll remind you ${ts(at)} (${ts(at, 'f')}).`, flags: EPH });
  }

  // team
  need(ctx, i, 'reminders.team');
  // Nothing filled in: one popup asks for everything.
  if (!i.options.getChannel('channel') && !i.options.getString('when') && !i.options.getRole('role')) {
    const teamCount0 = all(ctx).filter((r) => r.kind === 'team').length;
    if (teamCount0 >= ctx.config.get('maxTeam')) throw new UserError(`The server can keep ${ctx.config.get('maxTeam')} team reminders. Cancel one first.`);
    return i.showModal(formModal(`remind:team:${forms.put({ by: i.user.id, rich: true })}`, 'Team reminder', teamFields(i.channelId)));
  }
  const ch = await getChannelOption(i, 'channel', true);
  if (!ch?.isTextBased()) throw new UserError('Pick a text channel.');
  const roleIds = rolesOf(i);
  if (!roleIds.length) throw new UserError('Choose at least one role.');
  if (!i.options.getString('when')) throw new UserError('Say when with the `when` option, or leave everything empty to use the popup.');
  const teamCount = all(ctx).filter((r) => r.kind === 'team').length;
  if (teamCount >= ctx.config.get('maxTeam')) throw new UserError(`The server can keep ${ctx.config.get('maxTeam')} team reminders. Cancel one first.`);
  const form = { by: i.user.id, channelId: ch.id, roleIds, at: checkWhen(ctx, i.options.getString('when')), repeat: i.options.getString('repeat') ?? 'none' };
  const text = i.options.getString('message');
  if (text) return saveTeam(ctx, i, form, text);
  return i.showModal(remindModal(forms.put(form)));
}

export const teamFields = (channelId) => [
  { id: 'text', label: 'Message', kind: 'paragraph', max: 1500, placeholder: 'What should the reminder say?' },
  { id: 'when', label: 'When', desc: 'For example: 2h, 1d, or 2026-12-31 18:30', max: 40, placeholder: '1d' },
  { id: 'channel', label: 'Channel', kind: 'channel', value: channelId },
  { id: 'roles', label: 'Roles to notify', kind: 'roles', maxValues: 5 },
  { id: 'repeat', label: 'Repeat', kind: 'select', value: 'none', options: [{ label: 'No, just once', value: 'none' }, { label: 'Every day', value: 'daily' }, { label: 'Every week', value: 'weekly' }] },
];

async function remindForm(ctx, i) {
  if (i.customId.startsWith('remind:team:')) {
    const form = forms.take(i.customId.split(':')[2], i.user.id);
    const v = readForm(i, teamFields(null));
    if (!v.text) throw new UserError('The reminder cannot be empty.');
    const roleIds = v.roles.filter((id) => id !== ctx.guild.id);
    if (!roleIds.length) throw new UserError('Choose at least one role to notify.');
    return saveTeam(ctx, i, { by: form.by, channelId: v.channel ?? i.channelId, roleIds, at: checkWhen(ctx, v.when), repeat: v.repeat ?? 'none' }, v.text);
  }
  const form = forms.take(i.customId.split(':')[2], i.user.id);
  const text = i.fields.getTextInputValue('text').trim();
  if (!text) throw new UserError('The reminder cannot be empty.');
  return saveTeam(ctx, i, form, text);
}

async function saveTeam(ctx, i, form, text) {
  const ch = textChannel(ctx, form.channelId);
  if (!ch) throw new UserError('That channel no longer exists.');
  const id = nextId(ctx);
  ctx.data.set(`r:${id}`, { id, kind: 'team', by: form.by, channelId: ch.id, text, roleIds: form.roleIds, nextAt: form.at, repeat: form.repeat, delivery: 'channel' });
  const problem = pingProblem(ctx.guild, ch, 'role', form.roleIds, P);
  return i.reply({
    content: `Reminder **#${id}** set for ${ts(form.at, 'f')} (${ts(form.at)}) in <#${ch.id}>, for ${form.roleIds.map((r) => `<@&${r}>`).join(' ')}.${problem ? `\n⚠️ **The roles would not be notified right now.** ${problem}` : ''}`,
    flags: EPH, allowedMentions: NOPING,
  });
}

// ------------------------------------------------------------------ delivery
async function deliverTeam(ctx, r, late) {
  const ch = textChannel(ctx, r.channelId);
  if (!ch) throw new UserError('channel is gone');
  const problem = pingProblem(ctx.guild, ch, 'role', r.roleIds, P);
  if (problem) ctx.log.warn(`Reminder #${r.id} cannot notify its roles: ${problem}`);
  const payload = reminderPayload({ text: r.text, roleIds: r.roleIds, late });
  if (problem) payload.content = truncate(`${payload.content}\n\n⚠️ *The roles above were not notified: I'm missing a permission. A moderator can see the details in the log.*`, 2000);
  await ctx.queue(() => ch.send(payload));
}

async function deliverPersonal(ctx, r, late) {
  const note = late ? '\n*(sent late: the bot was offline at the scheduled time)*' : '';
  const body = `⏰ **Reminder**\n${unescapeNl(r.text)}${note}`;
  if (r.delivery === 'dm' && ctx.notify.allowed(r.by, 'dms')) {
    const user = await ctx.client.users.fetch(r.by).catch(() => null);
    const sent = await user?.send({ content: `${body}\n*(set in ${truncate(ctx.guild.name, 60)})*`, allowedMentions: NOPING }).then(() => true).catch(() => false);
    if (sent) return;
  }
  const ch = textChannel(ctx, r.channelId);
  if (!ch) throw new UserError('channel is gone');
  await ctx.queue(() => ch.send({ content: `<@${r.by}> ${body}`, allowedMentions: { users: [r.by] } }));
}

async function remindTask(ctx) {
  const now = Date.now();
  for (const r of all(ctx)) {
    if (r.nextAt > now) continue;
    const late = now - r.nextAt > LATE_AFTER;
    try { await (r.kind === 'team' ? deliverTeam(ctx, r, late) : deliverPersonal(ctx, r, late)); }
    catch (e) { ctx.log.warn(`Reminder #${r.id} could not be delivered: ${e instanceof UserError ? e.message : describeDiscordError(e, 'deliver it')}`); }
    if (r.repeat === 'none') { ctx.data.delete(`r:${r.id}`); continue; }
    const step = r.repeat === 'weekly' ? 7 * DAY : DAY;
    while (r.nextAt <= now) r.nextAt += step;
    ctx.data.set(`r:${r.id}`, r);
  }
}

const roleOption = (name, d, required = false) => (o) => o.setName(name).setDescription(d).setRequired(required);

export default {
  name: 'reminders',
  version: '1.0.0',
  description: 'Personal reminders, and team reminders that notify several roles (each on its own line).',
  settings: [
    { key: 'timezoneOffset', type: 'number', label: 'Server timezone offset from UTC, in hours (for dates like 2026-12-31 18:30)', default: 0, min: -12, max: 14 },
    { key: 'maxPersonal', type: 'number', label: 'Personal reminders each member can keep', default: 10, min: 1, max: 50 },
    { key: 'maxTeam', type: 'number', label: 'Team reminders the server can keep', default: 25, min: 1, max: 100 },
  ],
  permissions: [
    { key: 'reminders.me', label: 'Set personal reminders', default: 'everyone' },
    { key: 'reminders.team', label: 'Set reminders that notify roles', default: 'moderator' },
    { key: 'reminders.manage', label: 'See and cancel anyone\'s reminders', default: 'admin' },
  ],
  commands: [{
    permission: 'reminders.me',
    data: new SlashCommandBuilder().setName('remind').setDescription('Reminders')
      .addSubcommand((s) => s.setName('me').setDescription('Remind yourself')
        .addStringOption((o) => o.setName('when').setDescription('e.g. 30m, 2h, 1d, or 2026-12-31 18:30').setRequired(true))
        .addStringOption((o) => o.setName('message').setDescription('What to remind you of').setRequired(true).setMaxLength(500))
        .addStringOption((o) => o.setName('where').setDescription('Where to remind you').addChoices({ name: 'direct message (default)', value: 'dm' }, { name: 'this channel', value: 'channel' })))
      .addSubcommand((s) => s.setName('team').setDescription('Post a reminder that notifies one or more roles')
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post it (leave everything empty for a popup)'))
        .addStringOption((o) => o.setName('when').setDescription('e.g. 2h, 1d, or 2026-12-31 18:30'))
        .addRoleOption(roleOption('role', 'A role to notify'))
        .addRoleOption(roleOption('role2', 'Another role'))
        .addRoleOption(roleOption('role3', 'Another role'))
        .addRoleOption(roleOption('role4', 'Another role'))
        .addRoleOption(roleOption('role5', 'Another role'))
        .addStringOption((o) => o.setName('message').setDescription('The text. Leave empty to write it in a popup').setMaxLength(1500))
        .addStringOption((o) => o.setName('repeat').setDescription('Repeat?').addChoices({ name: 'no', value: 'none' }, { name: 'daily', value: 'daily' }, { name: 'weekly', value: 'weekly' })))
      .addSubcommand((s) => s.setName('list').setDescription('Show your reminders'))
      .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a reminder').addIntegerOption((o) => o.setName('id').setDescription('Its number').setRequired(true).setMinValue(1))),
    execute: remindCmd,
  }],
  components: [{ prefix: 'remind:', execute: remindForm }],
  tasks: [{ name: 'due', everyMs: 30000, run: remindTask }],
};
