/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Temporary voice rooms ("join to create").
 *   Staff: /voicehub add|remove|list - choose which voice channels are lobbies.
 *   Members: join a lobby and a room of your own appears and you are moved into it. /room controls it:
 *   name, limit, lock, hide, invite, kick, ban, permit, transfer, claim, info.
 * Rooms are deleted when empty. They are remembered in the database, so a restart picks them up again.
 *
 * Event hubs (/voicehub event): an admin fills in one popup (event name, team size, most teams, where the panel goes)
 * and the bot posts a panel with buttons. Members press Join solo (matched with others), Join with friends (pick them,
 * they press Accept), or Make a team room (others fill it). Each team gets its own voice room, "<Event> - Team N",
 * which only the team can join, and anyone already in voice is moved straight in. A team room that nobody joins is
 * removed after a grace time; once people have been in it, it is removed a few seconds after the last one leaves.
 */
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { UserError } from '../../src/util.js';
import { roomName, sanitizeName, checkRename, nextOwner, privacyOverwrite, PRIVACY } from '../../src/tempvoice.js';
import { formModal, readForm } from '../../src/modalkit.js';
import { formStore } from '../../src/forms.js';
import * as EH from '../../src/eventhub.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const OWNER_ALLOW = [P.ViewChannel, P.Connect, P.Speak, P.Stream, P.UseVAD];
const renames = new Map();   // roomId -> [timestamps]
const creating = new Set();  // userId:guildId, stops a double join from making two rooms
const lastMade = new Map();  // userId:guildId -> time
const joinedAt = new Map();  // roomId -> { userId: time }
const emptyTimers = new Map(); // roomId -> timeout: deletes a room exactly when its empty time is up

const need = (ctx, i, key) => { if (!ctx.perms.check(i.member, key)) throw new UserError(`You don't have permission for that (\`${key}\`).`); };
const lobbies = (ctx) => ctx.data.list('lobby:').map((x) => x.value);
const roomOf = (ctx, id) => (id ? ctx.data.get(`room:${id}`) : null);
const rooms = (ctx) => ctx.data.list('room:').map((x) => x.value);
const humans = (ch) => [...(ch?.members?.values?.() ?? [])].filter((m) => !m.user?.bot);

async function makeRoom(ctx, member, lobby, state) {
  const guild = ctx.guild;
  const key = `${member.id}:${guild.id}`;
  if (creating.has(key)) return;
  const existing = rooms(ctx).find((r) => r.owner === member.id && guild.channels.cache.get(r.id));
  if (existing) { await state.setChannel(guild.channels.cache.get(existing.id)).catch(() => {}); return; }
  if (Date.now() - (lastMade.get(key) ?? 0) < 10000) return; // too fast: ignore the join
  if (rooms(ctx).length >= ctx.config.get('maxRooms')) {
    await member.send?.({ content: `Sorry, ${guild.name} has too many temporary rooms right now. Try again soon.`, allowedMentions: NOPING }).catch(() => {});
    return;
  }
  creating.add(key);
  try {
    const lobbyCh = guild.channels.cache.get(lobby.id);
    const n = ctx.data.update('counter', (x) => x + 1, 0);
    const parentId = lobby.categoryId || lobbyCh?.parentId || undefined;
    const parent = parentId ? guild.channels.cache.get(parentId) : null;
    const inherited = [...((parent ?? lobbyCh)?.permissionOverwrites?.cache?.values?.() ?? [])]
      .filter((o) => o.id !== member.id && o.id !== ctx.client.user.id).map((o) => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));
    const limit = Number(lobby.limit ?? ctx.config.get('defaultLimit')) || 0;
    const ch = await guild.channels.create({
      name: roomName(lobby.template || ctx.config.get('nameTemplate'), { user: member.displayName, n }),
      type: ChannelType.GuildVoice, parent: parentId || undefined, userLimit: limit,
      permissionOverwrites: [...inherited, { id: member.id, allow: OWNER_ALLOW }, { id: ctx.client.user.id, allow: [...OWNER_ALLOW, P.ManageChannels, P.MoveMembers] }],
      reason: `Temporary room for ${member.user.tag}`,
    }).catch(() => { throw new UserError("I couldn't create the room (I need Manage Channels and Move Members, and the category needs space)."); });
    ctx.data.set(`room:${ch.id}`, { id: ch.id, owner: member.id, lobby: lobby.id, createdAt: Date.now(), privacy: 'public', n });
    lastMade.set(key, Date.now());
    const moved = await state.setChannel(ch).then(() => true).catch(() => false);
    if (!moved) { await ch.delete('Could not move the creator in').catch(() => {}); ctx.data.delete(`room:${ch.id}`); }
  } catch (e) {
    ctx.log.warn(`Temporary room for ${member.user?.tag}: ${e.message}`);
  } finally { creating.delete(key); }
}

async function removeIfEmpty(ctx, room, { force = false, ignoreGrace = false } = {}) {
  const ch = ctx.guild.channels.cache.get(room.id);
  if (ch && humans(ch).length) { cancelRemoval(room.id); return false; }
  if (!ch) { forgetRoom(ctx, room); return true; }
  if (humans(ch).length) return false;
  if (!ignoreGrace && room.graceUntil && Date.now() < room.graceUntil) return false; // a new team room: give the team time to join
  const wait = ctx.config.get('emptyDelaySeconds') * 1000;
  if (!force && wait) {
    if (!room.emptySince) { room.emptySince = Date.now(); ctx.data.set(`room:${room.id}`, room); }
    if (Date.now() - room.emptySince < wait) return false;
  }
  await ctx.queue(() => ch.delete('Temporary room is empty')).catch((e) => ctx.log.warn(`Could not delete room ${room.id}: ${e.message}`));
  forgetRoom(ctx, room);
  return true;
}

/** The room is gone: forget it, and if it was an event team's room, take the team off the event. */
function forgetRoom(ctx, room) {
  ctx.data.delete(`room:${room.id}`); renames.delete(room.id); joinedAt.delete(room.id); cancelRemoval(room.id);
  if (room.event) teamRoomGone(ctx, room.event, room.team).catch((e) => ctx.log.warn(`Event ${room.event}: ${e.message}`));
}

/** Delete the room as soon as its empty time is up (not at the next sweep), unless someone comes back first. */
function scheduleRemoval(ctx, roomId) {
  clearTimeout(emptyTimers.get(roomId));
  const wait = ctx.config.get('emptyDelaySeconds') * 1000;
  const t = setTimeout(async () => {
    emptyTimers.delete(roomId);
    const room = roomOf(ctx, roomId);
    if (room) await removeIfEmpty(ctx, room, { force: true }).catch((e) => ctx.log.warn(`Could not delete room ${roomId}: ${e.message}`));
  }, wait + 50);
  t.unref?.();
  emptyTimers.set(roomId, t);
}
const cancelRemoval = (roomId) => { clearTimeout(emptyTimers.get(roomId)); emptyTimers.delete(roomId); };

async function setOwner(ctx, ch, room, newOwner) {
  if (room.owner) await ch.permissionOverwrites.delete(room.owner).catch(() => {});
  await ch.permissionOverwrites.edit(newOwner, Object.fromEntries(OWNER_ALLOW.map((f) => [Object.keys(P).find((k) => P[k] === f), true]))).catch(() => {});
  room.owner = newOwner; ctx.data.set(`room:${room.id}`, room);
}

async function onVoice(ctx, oldS, newS) {
  const member = newS.member ?? oldS.member;
  if (!member || member.user?.bot) return;
  if (oldS.channelId === newS.channelId) return;
  // left a room
  if (oldS.channelId) {
    const room = roomOf(ctx, oldS.channelId);
    if (room) {
      const ch = ctx.guild.channels.cache.get(room.id);
      if (joinedAt.has(room.id)) delete joinedAt.get(room.id)[member.id];
      if (room.emptySince) { delete room.emptySince; }
      if (ch && humans(ch).length === 0) { room.emptySince = Date.now(); ctx.data.set(`room:${room.id}`, room); if (!(await removeIfEmpty(ctx, room))) scheduleRemoval(ctx, room.id); }
      else if (ch && room.owner === member.id && ctx.config.get('ownerLeaves') === 'transfer') {
        const next = nextOwner(humans(ch).map((m) => m.id), member.id, joinedAt.get(room.id));
        if (next) await setOwner(ctx, ch, room, next);
      }
    }
  }
  // joined something
  if (newS.channelId) {
    const room = roomOf(ctx, newS.channelId);
    if (room) {
      const j = joinedAt.get(room.id) ?? {}; j[member.id] = Date.now(); joinedAt.set(room.id, j);
      cancelRemoval(room.id);
      if (room.emptySince || room.graceUntil) { delete room.emptySince; delete room.graceUntil; ctx.data.set(`room:${room.id}`, room); }
      return;
    }
    const lobby = ctx.data.get(`lobby:${newS.channelId}`);
    if (lobby) await makeRoom(ctx, member, lobby, newS);
  }
}

// ------------------------------------------------------------------ commands
function myRoom(ctx, i, { owner = true } = {}) {
  const chId = i.member.voice?.channelId;
  const room = roomOf(ctx, chId);
  if (!room) throw new UserError('Join one of your temporary rooms first, then use this command.');
  const ch = ctx.guild.channels.cache.get(room.id);
  if (!ch) throw new UserError('That room no longer exists.');
  if (owner && room.owner !== i.user.id && !ctx.perms.check(i.member, 'tempvoice.manage')) throw new UserError(`Only the room's owner can do that. The owner is <@${room.owner}>${ctx.config.get('ownerLeaves') === 'claim' ? ', or use `/room claim` if they have left' : ''}.`);
  return { room, ch };
}

async function roomCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  const done = (content) => i.reply({ content, flags: EPH, allowedMentions: NOPING });

  if (sub === 'info') {
    const { room, ch } = myRoom(ctx, i, { owner: false });
    return done(`**${ch.name}** · owner <@${room.owner}> · ${humans(ch).length}${ch.userLimit ? `/${ch.userLimit}` : ''} inside · ${room.privacy}${room.banned?.length ? ` · ${room.banned.length} banned` : ''}`);
  }
  if (sub === 'claim') {
    const { room, ch } = myRoom(ctx, i, { owner: false });
    if (room.owner === i.user.id) throw new UserError('You already own this room.');
    if (ch.members?.has?.(room.owner)) throw new UserError('The owner is still here.');
    await setOwner(ctx, ch, room, i.user.id);
    return done('You now own this room.');
  }

  const { room, ch } = myRoom(ctx, i);
  const save = () => ctx.data.set(`room:${room.id}`, room);
  const target = () => { const u = i.options.getUser('member', true); if (u.id === i.user.id) throw new UserError('Pick someone else.'); if (u.bot) throw new UserError('Pick a person.'); return u; };
  const allowOnly = (id, p) => ch.permissionOverwrites.edit(id, p);

  if (sub === 'name') {
    const r = checkRename(renames.get(room.id), Date.now());
    if (!r.ok) throw new UserError(`Discord only lets a room be renamed twice every 10 minutes. Try again <t:${Math.ceil(r.retryAt / 1000)}:R>.`);
    const name = sanitizeName(i.options.getString('name', true), ch.name);
    await ch.setName(name); renames.set(room.id, r.list);
    return done(`Renamed to **${name}**.`);
  }
  if (sub === 'limit') {
    const n = i.options.getInteger('people', true);
    if (n < 0 || n > 99) throw new UserError('Pick 0 (no limit) to 99.');
    await ch.setUserLimit(n);
    return done(n ? `Limit set to ${n}.` : 'Limit removed.');
  }
  if (sub === 'privacy') {
    const mode = i.options.getString('mode', true);
    if (!PRIVACY.includes(mode)) throw new UserError('Choose public, locked or hidden.');
    await ch.permissionOverwrites.edit(ctx.guild.id, privacyOverwrite(mode));
    room.privacy = mode; save();
    return done({ public: 'Anyone can see and join the room.', locked: 'The room is visible but only people you invite can join.', hidden: 'The room is hidden. Only people you invite can see and join it.' }[mode]);
  }
  if (sub === 'invite' || sub === 'permit') {
    const u = target();
    await allowOnly(u.id, { ViewChannel: true, Connect: true });
    room.banned = (room.banned ?? []).filter((x) => x !== u.id); save();
    return done(`<@${u.id}> can join.`);
  }
  if (sub === 'kick') {
    const u = target();
    const m = ch.members?.get?.(u.id);
    if (!m) throw new UserError('They are not in your room.');
    await m.voice.disconnect('Removed by the room owner');
    return done(`Removed <@${u.id}> from the room. They can come back unless you ban them.`);
  }
  if (sub === 'ban') {
    const u = target();
    await allowOnly(u.id, { Connect: false, ViewChannel: false });
    const m = ch.members?.get?.(u.id); if (m) await m.voice.disconnect('Banned from the room');
    room.banned = [...new Set([...(room.banned ?? []), u.id])]; save();
    return done(`<@${u.id}> can't join this room.`);
  }
  if (sub === 'transfer') {
    const u = target();
    if (!ch.members?.has?.(u.id)) throw new UserError('They need to be in the room.');
    await setOwner(ctx, ch, room, u.id);
    return done(`<@${u.id}> now owns the room.`);
  }
}

async function hubCmd(ctx, i) {
  need(ctx, i, 'tempvoice.manage');
  const sub = i.options.getSubcommand();
  if (sub === 'event') return i.showModal(formModal(`tvev:new:${evForms.put({ by: i.user.id })}`, 'Start an event hub', eventFields(i.channelId)));
  if (sub === 'list') {
    const rows = lobbies(ctx).map((l) => {
      const limit = l.limit ?? ctx.config.get('defaultLimit');
      return `<#${l.id}> · name "${l.template || ctx.config.get('nameTemplate')}" · limit ${limit || 'none'}${l.categoryId ? ` · in <#${l.categoryId}>` : ''}`;
    });
    const empty = 'No lobbies yet. Add one with /voicehub add.';
    const evs = events(ctx).filter((e) => !e.ended).map((e) => `**${e.name}** · teams of ${e.size} · ${e.teams.length}/${e.maxTeams} teams · panel in <#${e.channelId}>${e.locked ? ' · locked' : ''}`);
    return i.reply({ content: `${rows.join('\n') || empty}\n\nOpen rooms: ${rooms(ctx).length}${evs.length ? `\n\n**Event hubs**\n${evs.join('\n')}` : ''}`, flags: EPH, allowedMentions: NOPING });
  }
  const id = i.options.getChannel('lobby', true)?.id;
  if (sub === 'remove') {
    if (!ctx.data.get(`lobby:${id}`)) throw new UserError('That channel is not a lobby.');
    ctx.data.delete(`lobby:${id}`);
    return i.reply({ content: `<#${id}> is no longer a lobby. Rooms already open stay until they empty.`, flags: EPH });
  }
  const ch = ctx.guild.channels.cache.get(id);
  if (!ch || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(ch.type)) throw new UserError('The lobby must be a voice channel.');
  const me = ch.permissionsFor?.(ctx.client.user.id);
  const missing = [['ManageChannels', P.ManageChannels], ['MoveMembers', P.MoveMembers], ['Connect', P.Connect], ['ViewChannel', P.ViewChannel]].filter(([, b]) => me && !me.has(b)).map(([n]) => n);
  if (missing.length) throw new UserError(`I'm missing these permissions on that channel: ${missing.join(', ')}.`);
  const cat = i.options.getChannel('category');
  const lobby = { id, template: i.options.getString('name')?.slice(0, 80) || null, limit: i.options.getInteger('limit') ?? null, categoryId: cat?.id ?? null };
  ctx.data.set(`lobby:${id}`, lobby);
  return i.reply({ content: `<#${id}> is now a lobby. Joining it creates a room.`, flags: EPH });
}

// ------------------------------------------------------------------ event hubs
const evForms = formStore('tvev');
const evLocks = new Map(); // guild:event -> promise chain, so two button presses never change the same event at once
const events = (ctx) => ctx.data.list('ev:').map((x) => x.value);
const SIZE_NAMES = { 2: 'Duos', 3: 'Trios', 4: 'Squads' };
const sizeLabel = (n) => SIZE_NAMES[n] ? `${SIZE_NAMES[n]} (${n})` : `Teams of ${n}`;

export const eventFields = (channelId) => [
  { id: 'name', label: 'Event name', max: 60, placeholder: 'Fortnite Battle Duos' },
  { id: 'size', label: 'Players per team', kind: 'select', value: '2', options: EH.SIZES.map((n) => ({ label: sizeLabel(n), value: String(n) })) },
  { id: 'maxTeams', label: 'Most teams (optional)', kind: 'number', max: 2, min: 1, maxNum: 50, required: false, placeholder: '10', desc: 'Empty means 10. Players past this wait in a queue.' },
  { id: 'channel', label: 'Post the sign-up panel in', kind: 'channel', value: channelId },
  { id: 'category', label: 'Category for team rooms (optional)', kind: 'channel', required: false, channelTypes: [ChannelType.GuildCategory], desc: 'Empty means the panel channel\'s category.' },
];
export const friendFields = (ev) => [
  { id: 'friends', label: ev.size === 2 ? 'Your teammate' : `Your teammates (up to ${ev.size - 1})`, kind: 'user', maxValues: ev.size - 1 },
  ...(ev.size > 2 ? [{ id: 'fill', label: 'Empty spots', kind: 'select', value: 'yes', options: [{ label: 'Let solo players fill them', value: 'yes' }, { label: 'Keep them for us', value: 'no' }] }] : []),
];

function withEvent(ctx, id, fn) {
  const key = `${ctx.guild.id}:${id}`;
  const run = (evLocks.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const ev = ctx.data.get(`ev:${id}`);
    if (!ev) throw new UserError('That event is gone.');
    const out = await fn(ev);
    ctx.data.set(`ev:${id}`, ev);
    return out;
  });
  evLocks.set(key, run.finally(() => { if (evLocks.get(key) === run) evLocks.delete(key); }));
  return run;
}

export function panelFor(ev) {
  const sum = EH.summary(ev);
  const lines = ev.teams.map((t) => {
    const who = t.members.map((u) => `<@${u}>`).join(' ');
    const inv = t.invited.length ? ` · invited ${t.invited.map((u) => `<@${u}>`).join(' ')}` : '';
    const space = ev.size - t.members.length - t.invited.length;
    return `**Team ${t.n}** ${who}${inv}${space > 0 ? (t.open ? ` · ${space} open` : ` · ${space} kept`) : ''}${t.roomId ? ` · <#${t.roomId}>` : ''}`;
  });
  let list = '';
  for (const [k, l] of lines.entries()) { if (list.length + l.length > 3000) { list += `\n…and ${lines.length - k} more teams`; break; } list += `${list ? '\n' : ''}${l}`; }
  const state = ev.ended ? 'This event has ended.' : ev.locked ? 'Sign-ups are locked.' : '**Join solo** to be matched, **Join with friends** to pick your team, or **Make a team room** and let others fill it.';
  const e = new EmbedBuilder().setTitle(`${ev.name} · ${sizeLabel(ev.size)}`).setColor(ev.ended ? 0x6b7280 : ev.locked ? 0xf59e0b : 0x5865f2)
    .setDescription(`${state}\n\n${list || '_No teams yet._'}${ev.queue.length ? `\n\nWaiting for a team: ${ev.queue.map((u) => `<@${u}>`).join(' ')}` : ''}`)
    .setFooter({ text: `${sum.teams}/${ev.maxTeams} teams · ${sum.players} players${sum.openSpots ? ` · ${sum.openSpots} open spots` : ''}` });
  if (ev.ended) return { embeds: [e], components: [], allowedMentions: NOPING };
  const b = (id, label, style, disabled = false) => new ButtonBuilder().setCustomId(`tvev:${id}:${ev.id}`).setLabel(label).setStyle(style).setDisabled(disabled);
  const full = ev.locked || ev.teams.length >= ev.maxTeams;
  return {
    embeds: [e], allowedMentions: NOPING,
    components: [
      new ActionRowBuilder().addComponents(b('solo', 'Join solo', ButtonStyle.Success, ev.locked), b('friends', 'Join with friends', ButtonStyle.Primary, full), b('make', 'Make a team room', ButtonStyle.Secondary, full), b('leave', 'Leave', ButtonStyle.Secondary)),
      new ActionRowBuilder().addComponents(b('lock', ev.locked ? 'Unlock sign-ups' : 'Lock sign-ups', ButtonStyle.Secondary), b('end', 'End event', ButtonStyle.Danger)),
    ],
  };
}

async function refreshPanel(ctx, ev) {
  const ch = ctx.guild.channels.cache.get(ev.channelId);
  if (ch && ev.messageId) await ch.messages?.edit?.(ev.messageId, panelFor(ev)).catch((e) => ctx.log.warn(`Event panel ${ev.id}: ${e.message}`));
}
const say = (ctx, ev, content, users = []) => ctx.guild.channels.cache.get(ev.channelId)?.send?.({ content, allowedMentions: { users } }).catch(() => {});

const ROOM_ALLOW = { ViewChannel: true, Connect: true, Speak: true, Stream: true, UseVAD: true };

/** A voice room for the team that only the team can join; members already in voice are moved in. */
async function openTeamRoom(ctx, ev, team) {
  const panel = ctx.guild.channels.cache.get(ev.channelId);
  const parent = ev.categoryId || panel?.parentId || undefined;
  const ch = await ctx.guild.channels.create({
    name: `${ev.name} - Team ${team.n}`.slice(0, 100), type: ChannelType.GuildVoice, parent, userLimit: ev.size,
    permissionOverwrites: [
      { id: ctx.guild.id, deny: [P.Connect] },
      ...[...team.members, ...team.invited].map((id) => ({ id, allow: OWNER_ALLOW })),
      { id: ctx.client.user.id, allow: [...OWNER_ALLOW, P.ManageChannels, P.MoveMembers] },
    ],
    reason: `Event ${ev.name}: team ${team.n}`,
  }).catch(() => null);
  if (!ch) { ctx.log.warn(`Event ${ev.name}: could not create the room for team ${team.n} (needs Manage Channels and a category with space).`); return null; }
  team.roomId = ch.id;
  ctx.data.set(`room:${ch.id}`, { id: ch.id, owner: team.members[0], event: ev.id, team: team.n, createdAt: Date.now(), privacy: 'locked', graceUntil: Date.now() + ctx.config.get('eventGraceSeconds') * 1000 });
  await moveIn(ctx, ch, team.members);
  return ch;
}
async function moveIn(ctx, ch, ids) {
  for (const id of ids) {
    const m = ctx.guild.members.cache.get(id) ?? await ctx.guild.members.fetch?.(id).catch(() => null);
    if (m?.voice?.channelId && m.voice.channelId !== ch.id) await m.voice.setChannel(ch).catch(() => {});
  }
}
async function letIn(ctx, team, id) {
  const ch = team.roomId && ctx.guild.channels.cache.get(team.roomId);
  if (!ch) return;
  await ch.permissionOverwrites.edit(id, ROOM_ALLOW).catch(() => {});
  await moveIn(ctx, ch, [id]);
}
async function deleteTeamRoom(ctx, team, why) {
  const room = team.roomId && roomOf(ctx, team.roomId);
  if (!room) return;
  delete room.event; // the team is already off the event
  ctx.data.set(`room:${room.id}`, room);
  const ch = ctx.guild.channels.cache.get(room.id);
  if (ch) await ctx.queue(() => ch.delete(why)).catch(() => {});
  forgetRoom(ctx, room);
}
async function teamRoomGone(ctx, evId, n) {
  if (!ctx.data.get(`ev:${evId}`)) return;
  await withEvent(ctx, evId, async (ev) => { if (EH.dropTeam(ev, n)) { await fillFromQueue(ctx, ev); await refreshPanel(ctx, ev); } });
}
/** Spots opened up: give them to people waiting, open rooms for new teams and tell everyone where to go. */
async function fillFromQueue(ctx, ev) {
  const { added, formed } = EH.drainQueue(ev);
  for (const { team, uid } of added) { await letIn(ctx, team, uid); say(ctx, ev, `<@${uid}>, a spot opened: you're on **${ev.name} · Team ${team.n}**${team.roomId ? ` in <#${team.roomId}>` : ''}.`, [uid]); }
  for (const team of formed) { await openTeamRoom(ctx, ev, team); say(ctx, ev, `**${ev.name} · Team ${team.n}** is ready: ${team.members.map((u) => `<@${u}>`).join(' ')}.${team.roomId ? ` Hop in <#${team.roomId}>.` : ''}`, team.members); }
}

async function newEventForm(ctx, i) {
  need(ctx, i, 'tempvoice.manage');
  evForms.take(i.customId.split(':')[2], i.user.id);
  const v = readForm(i, eventFields(i.channelId));
  if (!v.name) throw new UserError('Give the event a name.');
  const panel = ctx.guild.channels.cache.get(v.channel ?? i.channelId);
  if (!panel?.isTextBased?.()) throw new UserError('Pick a text channel for the sign-up panel.');
  const id = String(ctx.data.update('evcounter', (x) => x + 1, 0));
  const ev = EH.newEvent({ id, name: v.name, size: Number(v.size ?? 2), maxTeams: v.maxTeams ?? 10, by: i.user.id, channelId: panel.id, categoryId: v.category ?? null });
  await i.deferReply({ flags: EPH });
  const msg = await panel.send(panelFor(ev)).catch(() => null);
  if (!msg) return i.editReply(`I can't post in <#${panel.id}>. I need View Channel, Send Messages and Embed Links there.`);
  ev.messageId = msg.id;
  ctx.data.set(`ev:${id}`, ev);
  return i.editReply(`**${ev.name}** is open in <#${panel.id}>. Teams of ${ev.size}, up to ${ev.maxTeams} teams. Use the panel's buttons to lock sign-ups or end the event.`);
}

async function eventComponent(ctx, i) {
  const [, action, id, ...rest] = i.customId.split(':');
  if (action === 'new') return newEventForm(ctx, i);
  need(ctx, i, 'tempvoice.use');
  const evNow = ctx.data.get(`ev:${id}`);
  if (!evNow) throw new UserError('That event is gone.');

  if (action === 'friends') { // the popup must be the first answer, so check what we can first
    if (evNow.ended || evNow.locked) throw new UserError(evNow.ended ? 'This event has ended.' : 'Sign-ups are locked.');
    if (EH.placeOf(evNow, i.user.id)) throw new UserError('You are already in this event. Press Leave first to change.');
    return i.showModal(formModal(`tvev:friendsform:${id}`, `Team up · ${evNow.name}`.slice(0, 45), friendFields(evNow)));
  }

  await i.deferReply({ flags: EPH });
  const done = (content) => i.editReply({ content, allowedMentions: NOPING });

  if (action === 'lock' || action === 'end') {
    if (!ctx.perms.check(i.member, 'tempvoice.manage') && evNow.by !== i.user.id) throw new UserError('Only the event host or staff can do that.');
    if (action === 'lock') {
      const locked = await withEvent(ctx, id, async (ev) => { ev.locked = !ev.locked; if (!ev.locked) await fillFromQueue(ctx, ev); await refreshPanel(ctx, ev); return ev.locked; });
      return done(locked ? 'Sign-ups are locked. Teams already made keep their rooms.' : 'Sign-ups are open again.');
    }
    const ended = await withEvent(ctx, id, async (ev) => { ev.ended = true; await refreshPanel(ctx, ev); return ev; });
    // rooms with people in them stay until they empty, like any temporary room; empty ones go now
    for (const t of ended.teams) {
      const room = t.roomId && roomOf(ctx, t.roomId);
      if (!room) continue;
      delete room.event; delete room.graceUntil; ctx.data.set(`room:${room.id}`, room);
      await removeIfEmpty(ctx, room, { force: true, ignoreGrace: true });
    }
    ctx.data.delete(`ev:${id}`);
    return done(`**${ended.name}** has ended. Empty team rooms were removed; the others go when their players leave.`);
  }

  if (action === 'solo' || action === 'make') {
    const r = await withEvent(ctx, id, async (ev) => {
      const res = action === 'solo' ? EH.joinSolo(ev, i.user.id) : EH.makeTeam(ev, i.user.id, { open: true });
      if (!res.ok) return res;
      if (res.team && !res.team.roomId) await openTeamRoom(ctx, ev, res.team);
      else if (res.action === 'added') await letIn(ctx, res.team, i.user.id);
      await refreshPanel(ctx, ev);
      return { ...res, ev };
    });
    if (!r.ok) throw new UserError(r.error);
    const room = r.team?.roomId ? ` Your room: <#${r.team.roomId}>.` : '';
    if (r.action === 'formed') say(ctx, r.ev, `**${r.ev.name} · Team ${r.team.n}** is ready: ${r.team.members.map((u) => `<@${u}>`).join(' ')}.${room.replace('Your room:', 'Hop in')}`, r.team.members);
    if (r.action === 'added' && !r.team.open) say(ctx, r.ev, `**${r.ev.name} · Team ${r.team.n}** is full: ${r.team.members.map((u) => `<@${u}>`).join(' ')}.${room.replace('Your room:', 'Hop in')}`, r.team.members);
    if (action === 'make') return done(`You made Team ${r.team.n}. Solo players will fill the other ${r.ev.size - 1} spot${r.ev.size === 2 ? '' : 's'}.${room}`);
    if (r.action === 'queued') return done(r.full ? `The event is full, so you're on the waiting list (number ${r.position}). You'll get a team if a spot opens.` : `You're in the queue. ${r.needed} more player${r.needed === 1 ? '' : 's'} needed for the next team, and I'll ping you when it's ready.`);
    return done(`You're on Team ${r.team.n}.${room}`);
  }

  if (action === 'friendsform') {
    const ev0 = ctx.data.get(`ev:${id}`);
    const v = readForm(i, friendFields(ev0));
    const friends = [].concat(v.friends ?? []).filter(Boolean);
    if (!friends.length) throw new UserError('Pick at least one friend.');
    for (const f of friends) { const m = ctx.guild.members.cache.get(f) ?? await ctx.guild.members.fetch?.(f).catch(() => null); if (!m) throw new UserError(`<@${f}> isn't in this server.`); if (m.user?.bot) throw new UserError('Pick people, not bots.'); }
    const r = await withEvent(ctx, id, async (ev) => {
      const res = EH.makeTeam(ev, i.user.id, { invited: friends, open: v.fill !== 'no' });
      if (!res.ok) return res;
      await openTeamRoom(ctx, ev, res.team);
      await refreshPanel(ctx, ev);
      return { ...res, ev };
    });
    if (!r.ok) throw new UserError(r.error);
    const panel = ctx.guild.channels.cache.get(r.ev.channelId);
    await panel?.send?.({
      content: `${r.team.invited.map((u) => `<@${u}>`).join(' ')}: <@${i.user.id}> wants you on their team for **${r.ev.name}**.`,
      allowedMentions: { users: r.team.invited },
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`tvev:accept:${id}:${r.team.n}`).setLabel('Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`tvev:decline:${id}:${r.team.n}`).setLabel('Decline').setStyle(ButtonStyle.Secondary))],
    }).catch(() => {});
    return done(`Team ${r.team.n} is yours. I asked ${r.team.invited.map((u) => `<@${u}>`).join(' ')} to accept.${r.team.roomId ? ` Your room: <#${r.team.roomId}>.` : ''}`);
  }

  if (action === 'accept' || action === 'decline') {
    const n = Number(rest[0]);
    const r = await withEvent(ctx, id, async (ev) => {
      const res = action === 'accept' ? EH.acceptInvite(ev, n, i.user.id) : EH.declineInvite(ev, n, i.user.id);
      if (!res.ok) return res;
      if (action === 'accept') await letIn(ctx, res.team, i.user.id);
      else if (res.team.roomId) await ctx.guild.channels.cache.get(res.team.roomId)?.permissionOverwrites?.delete?.(i.user.id).catch(() => {});
      await refreshPanel(ctx, ev);
      return res;
    });
    if (!r.ok) throw new UserError(r.error);
    return done(action === 'accept' ? `You're on Team ${n}.${r.team.roomId ? ` Your room: <#${r.team.roomId}>.` : ''}` : 'Invite declined.');
  }

  if (action === 'leave') {
    const r = await withEvent(ctx, id, async (ev) => {
      const res = EH.leave(ev, i.user.id);
      if (!res.ok) return res;
      if (res.emptied) await deleteTeamRoom(ctx, res.team, 'Everyone left the team');
      else if (res.team?.roomId) await ctx.guild.channels.cache.get(res.team.roomId)?.permissionOverwrites?.delete?.(i.user.id).catch(() => {});
      await fillFromQueue(ctx, ev);
      await refreshPanel(ctx, ev);
      return res;
    });
    if (!r.ok) throw new UserError(r.error);
    return done(r.from === 'queue' ? 'You left the queue.' : r.emptied ? `You left Team ${r.team.n}. Nobody was left, so its room was removed.` : `You left Team ${r.team.n}. Your spot is open for someone else.`);
  }
  throw new UserError('That button is no longer active.');
}

async function sweep(ctx) {
  for (const r of rooms(ctx)) await removeIfEmpty(ctx, r);
  for (const l of lobbies(ctx)) if (!ctx.guild.channels.cache.get(l.id)) ctx.data.delete(`lobby:${l.id}`);
}

export default {
  name: 'tempvoice',
  version: '1.1.0',
  description: 'Join-to-create voice rooms with full controls, plus event hubs that sort players into teams with their own voice rooms.',
  settings: [
    { key: 'nameTemplate', type: 'text', label: "Room name ({user} = creator, {n} = number)", default: "{user}'s room" },
    { key: 'defaultLimit', type: 'number', label: 'Default member limit (0 = none)', default: 0, min: 0, max: 99 },
    { key: 'maxRooms', type: 'number', label: 'Most temporary rooms at once', default: 40, min: 1, max: 100 },
    { key: 'emptyDelaySeconds', type: 'number', label: 'Seconds an empty room stays before it is deleted', default: 5, min: 0, max: 600 },
    { key: 'eventGraceSeconds', type: 'number', label: 'Event hubs: seconds a new team room waits for its team', default: 180, min: 30, max: 1800 },
    { key: 'ownerLeaves', type: 'select', label: 'When the owner leaves a room others are in (transfer = to who was there longest, claim = wait for /room claim)', default: 'transfer', options: ['transfer', 'claim'] },
  ],
  permissions: [
    { key: 'tempvoice.use', label: 'Own and control temporary rooms', default: 'everyone' },
    { key: 'tempvoice.manage', label: 'Set up lobbies and control any room', default: 'admin' },
  ],
  commands: [
    {
      permission: 'tempvoice.use',
      data: new SlashCommandBuilder().setName('room').setDescription('Control your temporary voice room')
        .addSubcommand((s) => s.setName('name').setDescription('Rename your room').addStringOption((o) => o.setName('name').setDescription('New name').setRequired(true).setMaxLength(100)))
        .addSubcommand((s) => s.setName('limit').setDescription('Set how many people fit').addIntegerOption((o) => o.setName('people').setDescription('0 = no limit').setRequired(true).setMinValue(0).setMaxValue(99)))
        .addSubcommand((s) => s.setName('privacy').setDescription('Who can see and join').addStringOption((o) => o.setName('mode').setDescription('Mode').setRequired(true).addChoices({ name: 'public - anyone', value: 'public' }, { name: 'locked - visible, invite only', value: 'locked' }, { name: 'hidden - invite only and unseen', value: 'hidden' })))
        .addSubcommand((s) => s.setName('invite').setDescription('Let someone in').addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true)))
        .addSubcommand((s) => s.setName('permit').setDescription('Let someone in (same as invite)').addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true)))
        .addSubcommand((s) => s.setName('kick').setDescription('Remove someone from the room').addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true)))
        .addSubcommand((s) => s.setName('ban').setDescription('Keep someone out of the room').addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true)))
        .addSubcommand((s) => s.setName('transfer').setDescription('Give the room to someone inside').addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true)))
        .addSubcommand((s) => s.setName('claim').setDescription('Take a room whose owner has left'))
        .addSubcommand((s) => s.setName('info').setDescription('About this room')),
      execute: roomCmd,
    },
    {
      permission: 'tempvoice.manage',
      data: new SlashCommandBuilder().setName('voicehub').setDescription('Set up join-to-create lobbies')
        .addSubcommand((s) => s.setName('add').setDescription('Make a voice channel a lobby')
          .addChannelOption((o) => o.setName('lobby').setDescription('The voice channel people join').setRequired(true).addChannelTypes(ChannelType.GuildVoice))
          .addChannelOption((o) => o.setName('category').setDescription('Where new rooms go (default: the lobby\'s category)').addChannelTypes(ChannelType.GuildCategory))
          .addStringOption((o) => o.setName('name').setDescription('Room name, e.g. {user}\'s squad').setMaxLength(80))
          .addIntegerOption((o) => o.setName('limit').setDescription('Member limit for rooms from this lobby').setMinValue(0).setMaxValue(99)))
        .addSubcommand((s) => s.setName('remove').setDescription('Stop using a channel as a lobby').addChannelOption((o) => o.setName('lobby').setDescription('The lobby').setRequired(true).addChannelTypes(ChannelType.GuildVoice)))
        .addSubcommand((s) => s.setName('list').setDescription('Show lobbies and open rooms'))
        .addSubcommand((s) => s.setName('event').setDescription('Start an event hub: teams get their own voice rooms (opens a popup)')),
      execute: hubCmd,
    },
  ],
  events: { voiceStateUpdate: onVoice, channelDelete: async (ctx, ch) => { const r = roomOf(ctx, ch.id); if (r) forgetRoom(ctx, r); if (ctx.data.get(`lobby:${ch.id}`)) ctx.data.delete(`lobby:${ch.id}`); } },
  components: [{ prefix: 'tvev:', execute: eventComponent }],
  tasks: [{ name: 'sweep', everyMs: 30000, runOnEnable: true, run: sweep }],
  async destroy(ctx) { for (const r of rooms(ctx)) cancelRemoval(r.id); },
};
