/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Party Finder (looking for group).
 *   /party create  - post a party: game, slots, optional start time and description, optional voice channel
 *   Join / Leave / Close buttons on the post; the post updates as people come and go.
 *   /party list, /party close, /party kick
 * Parties expire on their own. Members who opted in to "Party invitations" get a DM when a party fills and
 * shortly before it starts.
 */
import {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits as P,
} from 'discord.js';
import { UserError, parseWhen, truncate, ts, getChannelOption, describeDiscordError, pingProblem } from '../../src/util.js';
import { formModal, readForm } from '../../src/modalkit.js';
import { formStore } from '../../src/forms.js';
import { cleanText, join as joinParty, leave as leaveParty, isFull, spotsLeft, expiryFor, dueReminders, MIN_SLOTS, MAX_SLOTS } from '../../src/party.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const MIN = 60000;
const need = (ctx, i, key) => { if (!ctx.perms.check(i.member, key)) throw new UserError(`You don't have permission for that (\`${key}\`).`); };
const all = (ctx) => ctx.data.list('p:').map((x) => x.value);
const textChannel = (ctx, id) => { const c = id ? ctx.guild?.channels.cache.get(id) : null; return c?.isTextBased?.() ? c : null; };

// ------------------------------------------------------------------ the post
export function partyMessage(p) {
  const closed = p.status === 'closed';
  const title = `🎮 ${p.game}${closed ? ' · closed' : p.status === 'full' ? ' · FULL' : ''}`;
  const e = new EmbedBuilder().setTitle(title).setColor(closed ? 0x6b7280 : p.status === 'full' ? 0xf59e0b : 0x22c55e)
    .addFields(
      { name: `Players (${p.members.length}/${p.slots})`, value: p.members.map((id, n) => `${n === 0 ? '👑 ' : ''}<@${id}>`).join('\n') || '-' },
    );
  if (p.description) e.setDescription(p.description);
  const meta = [`Host <@${p.owner}>`];
  if (p.startAt) meta.push(`Starts ${ts(p.startAt, 'f')} (${ts(p.startAt)})`);
  if (p.voiceId && !closed) meta.push(`Voice <#${p.voiceId}>`);
  if (!closed) meta.push(spotsLeft(p) ? `${spotsLeft(p)} spot${spotsLeft(p) === 1 ? '' : 's'} left` : 'No spots left');
  e.addFields({ name: 'Details', value: meta.join('\n') });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`party:join:${p.id}`).setLabel('Join').setStyle(ButtonStyle.Success).setDisabled(closed || isFull(p)),
    new ButtonBuilder().setCustomId(`party:leave:${p.id}`).setLabel('Leave').setStyle(ButtonStyle.Secondary).setDisabled(closed),
    new ButtonBuilder().setCustomId(`party:close:${p.id}`).setLabel('Close').setStyle(ButtonStyle.Danger).setDisabled(closed),
  );
  return { embeds: [e], components: closed ? [] : [row], allowedMentions: NOPING };
}

async function refresh(ctx, p) {
  const ch = textChannel(ctx, p.channelId);
  const msg = ch && await ch.messages.fetch(p.messageId).catch(() => null);
  if (!msg) return false;
  await ctx.queue(() => msg.edit(partyMessage(p))).catch((e) => ctx.log.warn(`Party #${p.id}: could not update the post: ${describeDiscordError(e, 'edit it')}`));
  return true;
}

async function dm(ctx, userId, content) {
  if (!ctx.notify.allowed(userId, 'party-invites')) return;
  const user = await ctx.client.users.fetch(userId).catch(() => null);
  await user?.send({ content: truncate(content, 1900), allowedMentions: NOPING }).catch(() => {});
}

async function closeParty(ctx, p, why) {
  if (p.status === 'closed') return;
  p.status = 'closed'; p.closedAt = Date.now(); p.closedWhy = why;
  ctx.data.set(`p:${p.id}`, p);
  await refresh(ctx, p);
}

async function dropVoice(ctx, p, { onlyEmpty = true } = {}) {
  if (!p.voiceId) return true;
  const v = ctx.guild.channels.cache.get(p.voiceId);
  if (!v) { p.voiceId = null; return true; }
  if (onlyEmpty && v.members?.size) return false;
  await ctx.queue(() => v.delete('Party finished')).catch(() => {});
  p.voiceId = null; return true;
}

// ------------------------------------------------------------------ commands
async function partyCmd(ctx, i) {
  const sub = i.options.getSubcommand();

  if (sub === 'list') {
    const open = all(ctx).filter((p) => p.status !== 'closed').sort((a, b) => (a.startAt ?? a.createdAt) - (b.startAt ?? b.createdAt));
    const rows = open.map((p) => `**#${p.id}** ${p.game} · ${p.members.length}/${p.slots} · host <@${p.owner}>${p.startAt ? ` · ${ts(p.startAt)}` : ''} · [open](https://discord.com/channels/${ctx.guildId}/${p.channelId}/${p.messageId})`);
    return i.reply({ content: truncate(rows.join('\n') || 'No open parties. Start one with `/party create`.', 1900), flags: EPH, allowedMentions: NOPING });
  }

  if (sub === 'close' || sub === 'kick') {
    const p = ctx.data.get(`p:${i.options.getInteger('id', true)}`);
    if (!p || p.status === 'closed') throw new UserError('No open party with that number.');
    if (p.owner !== i.user.id) need(ctx, i, 'partyfinder.manage');
    if (sub === 'close') {
      await closeParty(ctx, p, 'host');
      await dropVoice(ctx, p); ctx.data.set(`p:${p.id}`, p);
      return i.reply({ content: `Closed party #${p.id}.`, flags: EPH });
    }
    const u = i.options.getUser('member', true);
    if (u.id === p.owner) throw new UserError('The host cannot be removed. Close the party instead.');
    const r = leaveParty(p, u.id);
    if (r.error) throw new UserError('They are not in that party.');
    ctx.data.set(`p:${p.id}`, r.party); await refresh(ctx, r.party);
    return i.reply({ content: `Removed <@${u.id}> from party #${p.id}.`, flags: EPH, allowedMentions: NOPING });
  }

  // create: with nothing filled in, one popup asks for it all
  if (!i.options.getString('game') && i.options.getInteger('slots') == null) {
    checkLimits(ctx, i);
    return i.showModal(formModal(`party:form:${forms.put({ by: i.user.id })}`, 'Find players', partyFields(ctx)));
  }
  if (!i.options.getString('game') || i.options.getInteger('slots') == null) throw new UserError('Fill in `game` and `slots`, or leave everything empty to use the popup.');
  return createParty(ctx, i, { game: i.options.getString('game'), slots: i.options.getInteger('slots'), when: i.options.getString('when'), description: i.options.getString('description'), voice: i.options.getBoolean('voice') ?? false, channel: await getChannelOption(i, 'channel', false) });
}

const forms = formStore('party');
export const partyFields = (ctx) => [
  { id: 'game', label: 'Game', max: 60, placeholder: 'Fortnite, Valorant, Minecraft...' },
  { id: 'slots', label: 'Players, including you', kind: 'number', max: 2, min: MIN_SLOTS, maxNum: MAX_SLOTS, placeholder: '4' },
  { id: 'when', label: 'Start time (optional)', desc: 'Empty means now. Or 30m, 2h, 2026-12-31 18:30', max: 40, required: false },
  { id: 'description', label: 'Details (optional)', kind: 'paragraph', max: 300, required: false, placeholder: 'Rank, mode, mics, anything else' },
  ...(ctx.config.get('allowVoice') ? [{ id: 'voice', label: 'Voice channel for the party', kind: 'select', value: 'no', options: [{ label: 'No', value: 'no' }, { label: 'Yes, make one', value: 'yes' }] }] : []),
];
function checkLimits(ctx, i) {
  const mine = all(ctx).filter((p) => p.owner === i.user.id && p.status !== 'closed');
  const maxMine = ctx.config.get('maxOpenPerUser');
  if (mine.length >= maxMine) throw new UserError(`You already have ${mine.length} open part${mine.length === 1 ? 'y' : 'ies'} (most allowed: ${maxMine}). Close one with \`/party close\`.`);
  if (all(ctx).filter((p) => p.status !== 'closed').length >= ctx.config.get('maxOpen')) throw new UserError('There are too many open parties right now. Try again in a little while.');
}
async function partyForm(ctx, i) {
  forms.take(i.customId.split(':')[2], i.user.id);
  const fields = partyFields(ctx);
  const v = readForm(i, fields);
  if (v.slots == null) throw new UserError('Say how many players, including you.');
  return createParty(ctx, i, { game: v.game, slots: v.slots, when: v.when || null, description: v.description || null, voice: v.voice === 'yes', channel: null });
}

async function createParty(ctx, i, o) {
  const mine = all(ctx).filter((p) => p.owner === i.user.id && p.status !== 'closed');
  const maxMine = ctx.config.get('maxOpenPerUser');
  if (mine.length >= maxMine) throw new UserError(`You already have ${mine.length} open part${mine.length === 1 ? 'y' : 'ies'} (most allowed: ${maxMine}). Close one with \`/party close\`.`);
  if (all(ctx).filter((p) => p.status !== 'closed').length >= ctx.config.get('maxOpen')) throw new UserError('There are too many open parties right now. Try again in a little while.');
  const slots = o.slots;
  if (slots < MIN_SLOTS || slots > MAX_SLOTS) throw new UserError(`Parties need ${MIN_SLOTS} to ${MAX_SLOTS} slots (you count as one).`);
  const game = cleanText(o.game, 60);
  if (!game) throw new UserError('Say which game this is for.');
  const whenText = o.when;
  const now = Date.now();
  let startAt = null;
  if (whenText) {
    startAt = parseWhen(whenText, ctx.config.get('timezoneOffset'));
    if (startAt < now + 60000) throw new UserError('The start time is in the past. Use something like `30m`, `2h`, or `2026-12-31 18:30`.');
    if (startAt > now + 14 * 86400000) throw new UserError('Parties can be planned up to two weeks ahead.');
  }
  const target = o.channel ?? textChannel(ctx, ctx.config.get('partyChannel')) ?? i.channel;
  if (!target?.isTextBased?.()) throw new UserError('Pick a text channel for the post.');
  const wantVoice = o.voice ?? false;
  if (wantVoice && !ctx.config.get('allowVoice')) throw new UserError('Voice channels for parties are turned off on this server.');

  const id = ctx.data.update('counter', (n) => n + 1, 0);
  const p = {
    id, owner: i.user.id, game, description: cleanText(o.description, 300), slots, members: [i.user.id], startAt,
    channelId: target.id, messageId: null, voiceId: null, status: slots <= 1 ? 'full' : 'open', createdAt: now,
    expiresAt: expiryFor({ startAt, createdAt: now, expireMinutes: ctx.config.get('expireMinutes') }), reminded: false,
  };

  await i.deferReply({ flags: EPH });
  if (wantVoice) {
    const cat = ctx.guild.channels.cache.get(ctx.config.get('voiceCategory'));
    const v = await ctx.guild.channels.create({
      name: truncate(`${game} · party ${id}`, 100), type: ChannelType.GuildVoice, userLimit: slots, parent: cat?.type === ChannelType.GuildCategory ? cat.id : undefined,
      reason: `Party #${id}`,
    }).catch(() => null);
    if (v) p.voiceId = v.id; else await i.followUp?.({ content: "I couldn't create the voice channel (I need Manage Channels). The party was created without one.", flags: EPH });
  }
  const roleId = ctx.config.get('pingRole');
  const ping = roleId && ctx.guild.roles.cache.has(roleId) && !pingProblem(ctx.guild, target, 'role', [roleId], P) ? `<@&${roleId}>` : null;
  const payload = partyMessage(p);
  if (ping) { payload.content = ping; payload.allowedMentions = { roles: [roleId] }; }
  const msg = await ctx.queue(() => target.send(payload)).catch((e) => { throw new UserError(`I couldn't post in <#${target.id}>: ${describeDiscordError(e, 'post there')}`); });
  p.messageId = msg.id;
  ctx.data.set(`p:${id}`, p);
  return i.editReply({ content: `Party **#${id}** posted in <#${target.id}>.${p.voiceId ? ` Voice: <#${p.voiceId}>.` : ''}` });
}

async function partyButton(ctx, i) {
  const [, action, idText] = i.customId.split(':');
  const p = ctx.data.get(`p:${idText}`);
  if (!p) return i.reply({ content: 'That party is gone.', flags: EPH });

  if (action === 'close') {
    if (p.owner !== i.user.id && !ctx.perms.check(i.member, 'partyfinder.manage')) throw new UserError('Only the host (or a moderator) can close this party.');
    await closeParty(ctx, p, 'host'); await dropVoice(ctx, p); ctx.data.set(`p:${p.id}`, p);
    return i.reply({ content: 'Party closed.', flags: EPH });
  }
  if (action === 'join') {
    const r = joinParty(p, i.user.id);
    if (r.error) {
      const text = { closed: 'This party is closed.', expired: 'This party has expired.', already: "You're already in this party.", full: 'This party is full.' }[r.error];
      return i.reply({ content: text, flags: EPH });
    }
    ctx.data.set(`p:${p.id}`, r.party);
    await i.update(partyMessage(r.party)).catch(() => refresh(ctx, r.party));
    if (r.filled) for (const m of r.party.members) await dm(ctx, m, `🎮 Your **${r.party.game}** party in **${ctx.guild.name}** is full! ${r.party.voiceId ? `Voice: <#${r.party.voiceId}>` : ''}`);
    return;
  }
  if (action === 'leave') {
    const r = leaveParty(p, i.user.id);
    if (r.error) return i.reply({ content: { closed: 'This party is closed.', owner: "You're the host. Use **Close** to end the party.", notin: "You're not in this party." }[r.error], flags: EPH });
    ctx.data.set(`p:${p.id}`, r.party);
    return i.update(partyMessage(r.party)).catch(() => refresh(ctx, r.party));
  }
}

async function sweep(ctx) {
  const now = Date.now();
  for (const p of all(ctx)) {
    if (p.status !== 'closed' && p.expiresAt <= now) { await closeParty(ctx, p, 'expired'); }
    if (p.status === 'closed') {
      const freed = await dropVoice(ctx, p);
      if (freed || now - (p.closedAt ?? now) > 6 * 3600000) { await dropVoice(ctx, p, { onlyEmpty: false }); ctx.data.delete(`p:${p.id}`); }
      else ctx.data.set(`p:${p.id}`, p);
      continue;
    }
    // the post was deleted by someone: nothing left to join, so end the party
    if (!(await refresh(ctx, p))) { await closeParty(ctx, p, 'post-deleted'); }
  }
  for (const p of dueReminders(all(ctx), now)) {
    p.reminded = true; ctx.data.set(`p:${p.id}`, p);
    for (const m of p.members) await dm(ctx, m, `⏰ Your **${p.game}** party in **${ctx.guild.name}** starts ${ts(p.startAt)}.${p.voiceId ? ` Voice: <#${p.voiceId}>` : ''}`);
  }
}

export default {
  name: 'partyfinder',
  version: '1.0.0',
  description: 'Looking-for-group posts with Join/Leave buttons, slots, start times, optional voice channels, and opt-in reminders.',
  settings: [
    { key: 'partyChannel', type: 'channel', label: 'Channel for party posts (default: where /party create is used)', default: '' },
    { key: 'pingRole', type: 'role', label: 'Role pinged when a party is posted (optional)', default: '' },
    { key: 'allowVoice', type: 'toggle', label: 'Let hosts ask for a voice channel', default: false },
    { key: 'voiceCategory', type: 'channel', label: 'Category for party voice channels', default: '' },
    { key: 'expireMinutes', type: 'number', label: 'Minutes a party without a start time stays open', default: 180, min: 15, max: 1440 },
    { key: 'maxOpenPerUser', type: 'number', label: 'Open parties per member', default: 2, min: 1, max: 5 },
    { key: 'maxOpen', type: 'number', label: 'Open parties on the server', default: 30, min: 1, max: 100 },
    { key: 'timezoneOffset', type: 'number', label: 'Server timezone offset from UTC, in hours (for dates like 2026-12-31 18:30)', default: 0, min: -12, max: 14 },
  ],
  permissions: [
    { key: 'partyfinder.create', label: 'Post parties', default: 'everyone' },
    { key: 'partyfinder.manage', label: 'Close or edit anyone\'s party', default: 'moderator' },
  ],
  commands: [{
    permission: 'partyfinder.create',
    data: new SlashCommandBuilder().setName('party').setDescription('Find players for a game')
      .addSubcommand((s) => s.setName('create').setDescription('Post a party')
        .addStringOption((o) => o.setName('game').setDescription('Which game (leave everything empty for a popup)').setMaxLength(60))
        .addIntegerOption((o) => o.setName('slots').setDescription('Total players wanted, including you').setMinValue(MIN_SLOTS).setMaxValue(MAX_SLOTS))
        .addStringOption((o) => o.setName('when').setDescription('Start time: 30m, 2h, or 2026-12-31 18:30 (empty = now)'))
        .addStringOption((o) => o.setName('description').setDescription('Rank, mode, mics, anything else').setMaxLength(300))
        .addBooleanOption((o) => o.setName('voice').setDescription('Also make a voice channel for the party'))
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post it')))
      .addSubcommand((s) => s.setName('list').setDescription('Open parties'))
      .addSubcommand((s) => s.setName('close').setDescription('Close a party').addIntegerOption((o) => o.setName('id').setDescription('Party number').setRequired(true).setMinValue(1)))
      .addSubcommand((s) => s.setName('kick').setDescription('Remove someone from a party')
        .addIntegerOption((o) => o.setName('id').setDescription('Party number').setRequired(true).setMinValue(1))
        .addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true))),
    execute: partyCmd,
  }],
  components: [{ prefix: 'party:', execute: (ctx, i) => (i.customId.startsWith('party:form:') ? partyForm(ctx, i) : partyButton(ctx, i)) }],
  tasks: [{ name: 'sweep', everyMs: 60000, run: sweep }],
};
