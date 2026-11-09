/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Button & dropdown role menus, reaction roles, automatic roles, game-activity roles.
 * Safety: the bot refuses to hand out roles that carry dangerous permissions, and a
 * user can only publish roles that sit below their own highest role.
 */
import {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  PermissionFlagsBits as P, MessageFlags,
} from 'discord.js';
import { UserError, SNOWFLAKE, truncate, chunk, roleGrantProblem, getChannelOption } from '../../src/util.js';
import { formModal, readForm } from '../../src/modalkit.js';
import { formStore } from '../../src/forms.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const roleProblem = (guild, role, actor) => roleGrantProblem(guild, role, actor, P);
const must = (guild, role, actor) => { const p = roleProblem(guild, role, actor); if (p) throw new UserError(p); };

// ------------------------------------------------------------------ role menus
const menuForms = formStore('rolemenu');
export const menuFields = [
  { id: 'title', label: 'Title', max: 200, placeholder: 'Pick your roles' },
  { id: 'description', label: 'Text under the title (optional)', kind: 'paragraph', max: 1500, required: false },
  { id: 'roles', label: 'Roles people can pick', kind: 'roles', maxValues: 10 },
  { id: 'style', label: 'Look', kind: 'select', value: 'buttons', options: [{ label: 'Buttons', value: 'buttons' }, { label: 'Dropdown list', value: 'dropdown' }] },
  { id: 'mode', label: 'How many can each person have', kind: 'select', value: 'toggle', options: [{ label: 'Several', description: 'Click to add or remove each role', value: 'toggle' }, { label: 'Only one', description: 'Choosing another swaps it', value: 'unique' }] },
];

async function menuCreate(ctx, i) {
  const picked = [];
  for (let n = 1; n <= 10; n++) { const r = i.options.getRole(`role${n}`); if (r && !picked.some((x) => x.id === r.id)) picked.push(r); }
  if (!i.options.getString('title') && !picked.length) return i.showModal(formModal(`rolemenu:form:${menuForms.put({ by: i.user.id })}`, 'New role menu', menuFields));
  if (!i.options.getString('title') || !picked.length) throw new UserError('Fill in a title and at least one role, or leave everything empty to use the popup.');
  return postMenu(ctx, i, { title: i.options.getString('title'), description: i.options.getString('description'), roles: picked, type: i.options.getString('style') ?? 'buttons', mode: i.options.getString('mode') ?? 'toggle' });
}
/** 3.1 limits from the command's options: most roles at once, a role needed to use it, how long roles last. */
function limitsFrom(i) {
  return { max: i.options.getInteger?.('max') ?? 0, needs: i.options.getRole?.('needs')?.id ?? null, hours: i.options.getInteger?.('hours') ?? 0 };
}
/** Checks a member's choice against a menu's limits. Returns an error message, or null. Exported for tests. */
export function limitProblem(menu, { roleIds = [], wanted = new Set() } = {}) {
  if (menu.needs && !roleIds.includes(menu.needs)) return `You need the <@&${menu.needs}> role to use this menu.`;
  const before = menu.roleIds.filter((r) => roleIds.includes(r)).length;
  if (menu.max && menu.mode !== 'unique' && wanted.size > menu.max && wanted.size > before) return `You can have up to ${menu.max} role${menu.max === 1 ? '' : 's'} from this menu. Take one off first.`;
  return null;
}
async function menuLimits(ctx, i) {
  const id = i.options.getString('message_id', true).trim();
  const menu = ctx.data.get(`menu:${id}`);
  if (!menu) throw new UserError('No menu with that message ID.');
  const l = limitsFrom(i);
  if (l.needs) { const r = i.guild.roles.cache.get(l.needs); if (!r) throw new UserError('That role is gone.'); }
  const next = { ...menu, max: l.max, needs: l.needs, hours: l.hours };
  ctx.data.set(`menu:${id}`, next);
  const msg = await i.channel.messages.fetch(id).catch(() => null);
  if (msg) await ctx.queue(() => msg.edit(buildMenu(i.guild, next))).catch(() => {});
  return i.reply({ content: `Saved. ${[l.max ? `Up to **${l.max}** at once` : 'No limit on how many', l.needs ? `only for <@&${l.needs}>` : 'open to everyone', l.hours ? `roles last **${l.hours} h**` : 'roles stay'].join(' · ')}.${msg ? '' : '\n-# Run this in the menu\'s channel to refresh the message itself.'}`, flags: EPH, allowedMentions: NOPING });
}

async function menuForm(ctx, i) {
  menuForms.take(i.customId.split(':')[2], i.user.id);
  const v = readForm(i, menuFields);
  const roles = [...new Set(v.roles)].map((id) => i.guild.roles.cache.get(id)).filter(Boolean);
  if (!roles.length) throw new UserError('Choose at least one role.');
  return postMenu(ctx, i, { title: v.title, description: v.description, roles, type: v.style ?? 'buttons', mode: v.mode ?? 'toggle' });
}

/**
 * The role menu message (2.3.2): a box listing each role with its emoji and how many members have it, and a button per
 * role (or a dropdown). Counts are refreshed after people click. Used by /rolemenu and by /migrate when it replaces
 * another bot's reaction-role message.
 */
export function buildMenu(guild, menu) {
  const roles = menu.roleIds.map((id) => guild.roles.cache.get(id)).filter(Boolean);
  const em = menu.emojis ?? {};
  const count = (r) => r.members?.size ?? 0;
  const lines = roles.map((r) => `${em[r.id] ? `${em[r.id]} ` : ''}<@&${r.id}> · **${count(r).toLocaleString('en-US')}** ${count(r) === 1 ? 'member' : 'members'}`);
  const embed = new EmbedBuilder().setColor(menu.color ?? 0x4cc3ff).setTitle(truncate(menu.title || 'Pick your roles', 200))
    .setDescription(truncate([menu.description, lines.join('\n')].filter(Boolean).join('\n\n'), 4000))
    .setFooter({ text: [menu.mode === 'unique' ? 'Pick one. Choosing another swaps it.' : menu.max ? `Pick up to ${menu.max}. Tap again to take one off.` : 'Tap a button to add or remove a role. Tap again to take it off.',
      menu.hours ? `Roles last ${menu.hours} hour${menu.hours === 1 ? '' : 's'}.` : null].filter(Boolean).join(' ') });
  if (menu.needs) embed.setDescription(truncate(`${embed.data.description ?? ''}\n\n🔒 Only for members with <@&${menu.needs}>.`, 4000));
  let components;
  if (menu.type === 'dropdown') {
    components = [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('rolemenu:sel').setPlaceholder('Choose your roles')
      .setMinValues(0).setMaxValues(menu.mode === 'unique' ? 1 : Math.max(1, Math.min(25, roles.length, menu.max || 25)))
      .addOptions(roles.slice(0, 25).map((r) => { const o = { label: truncate(r.name, 100), value: r.id, description: `${count(r)} ${count(r) === 1 ? 'member' : 'members'}` }; if (em[r.id]) o.emoji = em[r.id]; return o; })))];
  } else {
    components = chunk(roles.slice(0, 25), 5).map((row) => new ActionRowBuilder().addComponents(row.map((r) => {
      const b = new ButtonBuilder().setCustomId(`rolemenu:btn:${r.id}`).setLabel(truncate(r.name, 80)).setStyle(ButtonStyle.Secondary);
      if (em[r.id]) { const custom = /<(a?):(\w+):(\d+)>/.exec(em[r.id]); b.setEmoji(custom ? { id: custom[3], name: custom[2], animated: !!custom[1] } : em[r.id]); }
      return b;
    })));
  }
  return { embeds: [embed], components, allowedMentions: NOPING };
}

/** Posts a role menu in a channel and remembers it. roles: [{ id, emoji? }] */
export async function postRoleMenu(ctx, channel, { title, description, roles, type = 'buttons', mode = 'toggle', from = null, max = 0, needs = null, hours = 0 }) {
  const menu = { roleIds: roles.map((r) => r.id), emojis: Object.fromEntries(roles.filter((r) => r.emoji).map((r) => [r.id, r.emoji])), mode, type, title, description, from, max, needs, hours };
  const msg = await ctx.queue(() => channel.send(buildMenu(channel.guild, menu)));
  ctx.data.set(`menu:${msg.id}`, { ...menu, channelId: channel.id });
  return msg;
}

async function postMenu(ctx, i, o) {
  for (const r of o.roles) must(i.guild, r, i.member);
  await postRoleMenu(ctx, i.channel, { title: o.title, description: o.description, roles: o.roles.map((r) => ({ id: r.id })), type: o.type, mode: o.mode, ...limitsFrom(i) });
  await i.reply({ content: `Role menu posted in <#${i.channelId}>.`, flags: EPH });
}

// Member counts on a menu are refreshed a few seconds after people click (at most once every 5 seconds per menu).
const countTimers = new Map();
function refreshCounts(ctx, message) {
  if (countTimers.has(message.id)) return;
  countTimers.set(message.id, setTimeout(async () => {
    countTimers.delete(message.id);
    const menu = ctx.data.get(`menu:${message.id}`);
    if (menu) await ctx.queue(() => message.edit(buildMenu(message.guild, menu))).catch(() => {});
  }, 5000));
  countTimers.get(message.id).unref?.();
}

async function applyChoice(ctx, i, menu, wanted) {
  const member = i.member;
  const guild = i.guild;
  const adds = [], removes = [], skipped = [];
  for (const id of menu.roleIds) {
    const role = guild.roles.cache.get(id);
    const has = member.roles.cache.has(id);
    const want = wanted.has(id);
    if (want === has) continue;
    const problem = roleProblem(guild, role, null);
    if (problem) { skipped.push(problem); continue; }
    (want ? adds : removes).push(role);
  }
  if (adds.length) await member.roles.add(adds, 'Role menu');
  if (menu.hours) for (const r of adds) ctx.data.set(`temp:${member.id}:${r.id}`, Date.now() + menu.hours * 3600000);
  for (const r of removes) ctx.data.delete(`temp:${member.id}:${r.id}`);
  if (removes.length) await member.roles.remove(removes, 'Role menu');
  const parts = [];
  if (adds.length) parts.push(`Added ${adds.map((r) => `**${r.name}**`).join(', ')}${menu.hours ? ` for ${menu.hours} hour${menu.hours === 1 ? '' : 's'}` : ''}`);
  if (removes.length) parts.push(`Removed ${removes.map((r) => `**${r.name}**`).join(', ')}`);
  if (skipped.length) parts.push(skipped[0]);
  return parts.join('\n') || 'No changes.';
}

async function menuClick(ctx, i) {
  const menu = ctx.data.get(`menu:${i.message.id}`);
  if (!menu) throw new UserError('This menu is no longer active.');
  let wanted;
  if (i.isStringSelectMenu()) {
    wanted = new Set(i.values.filter((v) => menu.roleIds.includes(v)));
  } else {
    const id = i.customId.slice('rolemenu:btn:'.length);
    if (!menu.roleIds.includes(id)) throw new UserError('That role is not part of this menu.');
    const has = i.member.roles.cache.has(id);
    wanted = new Set(menu.mode === 'unique' ? (has ? [] : [id]) : [...menu.roleIds.filter((r) => i.member.roles.cache.has(r) && r !== id), ...(has ? [] : [id])]);
  }
  const problem = limitProblem(menu, { roleIds: [...i.member.roles.cache.keys()], wanted });
  if (problem) throw new UserError(problem);
  await i.deferReply({ flags: EPH });
  await i.editReply({ content: await applyChoice(ctx, i, menu, wanted), allowedMentions: NOPING });
  refreshCounts(ctx, i.message);
}

/** Saves new limits for a menu and redraws its message when the channel is known. */
async function setLimits(ctx, id, patch) {
  const menu = ctx.data.get(`menu:${id}`);
  if (!menu) throw new UserError('That menu is gone.');
  const next = { ...menu, ...patch };
  ctx.data.set(`menu:${id}`, next);
  const ch = menu.channelId ? ctx.guild?.channels.cache.get(menu.channelId) : null;
  const msg = ch ? await ch.messages?.fetch?.(id).catch(() => null) : null;
  if (msg) await ctx.queue(() => msg.edit(buildMenu(ctx.guild, next))).catch(() => {});
  return { id, ...patch };
}
const intOrZero = (v, max) => { const n = String(v ?? '').trim() === '' ? 0 : Math.floor(Number(v)); if (!Number.isFinite(n) || n < 0 || n > max) throw new UserError(`Use a whole number from 0 to ${max} (0 = no limit).`); return n; };

/** Takes away temporary roles whose time is up. Exported for tests. */
export async function expireTempRoles(ctx, now = Date.now()) {
  let n = 0;
  for (const { key, value: until } of ctx.data.list('temp:')) {
    if (until > now) continue;
    const [, userId, roleId] = key.split(':');
    ctx.data.delete(key);
    const m = ctx.guild?.members.cache.get(userId) ?? await ctx.guild?.members.fetch(userId).catch(() => null);
    if (m?.roles.cache.has(roleId)) { await m.roles.remove(roleId, 'Temporary role ran out').catch(() => {}); n++; }
  }
  return n;
}

// ------------------------------------------------------------------ reaction roles
const emojiKey = (s) => { const m = /<a?:\w+:(\d+)>/.exec(s); return m ? m[1] : s.trim(); };

async function reactionAdd(ctx, i) {
  const guild = i.guild;
  const mid = i.options.getString('message_id', true).trim();
  if (!SNOWFLAKE.test(mid)) throw new UserError('That is not a message ID. Right-click the message > Copy Message ID.');
  const role = i.options.getRole('role', true);
  must(guild, role, i.member);
  const emojiInput = i.options.getString('emoji', true);
  const msg = await i.channel.messages.fetch(mid).catch(() => { throw new UserError('I could not find that message in this channel.'); });
  await msg.react(emojiInput.trim()).catch(() => { throw new UserError("I couldn't use that emoji (is it from another server?)."); });
  ctx.data.set(`rr:${mid}:${emojiKey(emojiInput)}`, role.id);
  await i.reply({ content: `Reacting with ${emojiInput} on that message now gives **${role.name}**.`, flags: EPH, allowedMentions: NOPING });
}

async function onReaction(ctx, reaction, user, add) {
  if (user.bot) return;
  const roleId = ctx.data.get(`rr:${reaction.message.id}:${reaction.emoji.id ?? reaction.emoji.name}`);
  if (!roleId) return;
  const guild = reaction.message.guild;
  const role = guild.roles.cache.get(roleId);
  if (roleProblem(guild, role, null)) return;
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;
  if (add) await member.roles.add(role, 'Reaction role'); else await member.roles.remove(role, 'Reaction role');
}

// ------------------------------------------------------------------ auto roles & game roles
async function onJoin(ctx, member) {
  const ids = ctx.data.get(member.user.bot ? 'autorole:bots' : 'autorole:members') ?? [];
  for (const id of ids) {
    const role = member.guild.roles.cache.get(id);
    const problem = roleProblem(member.guild, role, null);
    if (problem) { ctx.log.warn(`Auto role skipped: ${problem}`); continue; }
    await member.roles.add(role, 'Automatic role').catch((e) => ctx.log.warn(`Auto role failed: ${e.message}`));
  }
}

const playing = (presence) => new Set((presence?.activities ?? []).filter((a) => a.type === 0).map((a) => String(a.name).toLowerCase()));

async function onPresence(ctx, oldP, newP) {
  if (!ctx.hasIntent('GuildPresences')) return;
  const before = playing(oldP), now = playing(newP);
  if (before.size === now.size && [...now].every((g) => before.has(g))) return;
  const maps = ctx.data.list('game:');
  if (!maps.length) return;
  const guild = newP.guild;
  const member = newP.member ?? await guild.members.fetch(newP.userId).catch(() => null);
  if (!member || member.user.bot) return;
  for (const { key, value: roleId } of maps) {
    const game = key.slice(5);
    const role = guild.roles.cache.get(roleId);
    if (roleProblem(guild, role, null)) continue;
    if (now.has(game) && !before.has(game)) await member.roles.add(role, `Playing ${game}`).catch(() => {});
    else if (!now.has(game) && before.has(game) && ctx.config.get('gameRoleRemove')) await member.roles.remove(role, `Stopped playing ${game}`).catch(() => {});
  }
}

// ------------------------------------------------------------------ commands
const roleOpts = (b) => { for (let n = 1; n <= 10; n++) b.addRoleOption((o) => o.setName(`role${n}`).setDescription(n === 1 ? 'Role 1 (leave everything empty for a popup)' : `Role ${n}`)); return b; };

export default {
  name: 'roles',
  version: '1.0.0',
  description: 'Button & dropdown role menus, reaction roles, automatic roles and game-activity roles.',
  settings: [
    { key: 'gameRoleRemove', type: 'toggle', label: 'Remove a game role when the member stops playing', default: true },
  ],
  permissions: [{ key: 'roles.manage', label: 'Create role menus, reaction roles, auto roles, game roles', default: 'moderator', discordPerm: 'ManageRoles' }],
  commands: [
    {
      permission: 'roles.manage',
      ownPopup: ['create'], // opens its own popup when run with nothing filled in
      data: new SlashCommandBuilder().setName('rolemenu').setDescription('Post a self-service role menu in this channel')
        .addSubcommand((s) => roleOpts(s.setName('create').setDescription('Create a menu (up to 10 roles)')
          .addStringOption((o) => o.setName('title').setDescription('Menu title')))
          .addStringOption((o) => o.setName('description').setDescription('Text under the title'))
          .addStringOption((o) => o.setName('style').setDescription('Buttons or a dropdown').addChoices({ name: 'buttons', value: 'buttons' }, { name: 'dropdown', value: 'dropdown' }))
          .addStringOption((o) => o.setName('mode').setDescription('Can members hold several?').addChoices({ name: 'several (toggle)', value: 'toggle' }, { name: 'only one', value: 'unique' }))
          .addIntegerOption((o) => o.setName('max').setDescription('Most roles one member can pick from this menu').setMinValue(1).setMaxValue(25))
          .addRoleOption((o) => o.setName('needs').setDescription('Only members with this role can use the menu'))
          .addIntegerOption((o) => o.setName('hours').setDescription('Roles from this menu are taken away after this many hours').setMinValue(1).setMaxValue(2160)))
        .addSubcommand((s) => s.setName('limits').setDescription('Change an existing menu\'s limits (run it in the menu\'s channel)')
          .addStringOption((o) => o.setName('message_id').setDescription('The menu message ID').setRequired(true))
          .addIntegerOption((o) => o.setName('max').setDescription('Most roles one member can pick (empty = no limit)').setMinValue(1).setMaxValue(25))
          .addRoleOption((o) => o.setName('needs').setDescription('Only members with this role can use it (empty = everyone)'))
          .addIntegerOption((o) => o.setName('hours').setDescription('Roles are taken away after this many hours (empty = they stay)').setMinValue(1).setMaxValue(2160)))
        .addSubcommand((s) => s.setName('delete').setDescription('Stop a menu working and delete it').addStringOption((o) => o.setName('message_id').setDescription('The menu message ID').setRequired(true))),
      async execute(ctx, i) {
        if (i.options.getSubcommand() === 'create') return menuCreate(ctx, i);
        if (i.options.getSubcommand() === 'limits') return menuLimits(ctx, i);
        const id = i.options.getString('message_id', true).trim();
        if (!ctx.data.get(`menu:${id}`)) throw new UserError('No menu with that message ID.');
        ctx.data.delete(`menu:${id}`);
        await i.channel.messages.delete(id).catch(() => {});
        await i.reply({ content: 'Menu removed.', flags: EPH });
      },
    },
    {
      permission: 'roles.manage',
      data: new SlashCommandBuilder().setName('reactionrole').setDescription('Roles from message reactions')
        .addSubcommand((s) => s.setName('add').setDescription('React on a message to get a role')
          .addStringOption((o) => o.setName('message_id').setDescription('Message ID (in this channel)').setRequired(true))
          .addStringOption((o) => o.setName('emoji').setDescription('The emoji').setRequired(true))
          .addRoleOption((o) => o.setName('role').setDescription('The role').setRequired(true)))
        .addSubcommand((s) => s.setName('remove').setDescription('Remove a reaction role')
          .addStringOption((o) => o.setName('message_id').setDescription('Message ID').setRequired(true))
          .addStringOption((o) => o.setName('emoji').setDescription('The emoji').setRequired(true)))
        .addSubcommand((s) => s.setName('list').setDescription('Show all reaction roles')),
      async execute(ctx, i) {
        const sub = i.options.getSubcommand();
        if (sub === 'add') return reactionAdd(ctx, i);
        if (sub === 'remove') {
          const key = `rr:${i.options.getString('message_id', true).trim()}:${emojiKey(i.options.getString('emoji', true))}`;
          if (ctx.data.get(key) === undefined) throw new UserError('No reaction role matches that.');
          ctx.data.delete(key);
          return i.reply({ content: 'Removed.', flags: EPH });
        }
        const rows = ctx.data.list('rr:').map(({ key, value }) => { const [, mid, em] = key.split(':'); return `message \`${mid}\` ${SNOWFLAKE.test(em) ? `(custom emoji ${em})` : em} → <@&${value}>`; });
        await i.reply({ content: rows.join('\n') || 'No reaction roles yet.', flags: EPH, allowedMentions: NOPING });
      },
    },
    {
      permission: 'roles.manage',
      data: new SlashCommandBuilder().setName('autorole').setDescription('Roles given automatically on join')
        .addSubcommand((s) => s.setName('add').setDescription('Add an automatic role').addRoleOption((o) => o.setName('role').setDescription('The role').setRequired(true))
          .addStringOption((o) => o.setName('for').setDescription('Who gets it').addChoices({ name: 'members', value: 'members' }, { name: 'bots', value: 'bots' })))
        .addSubcommand((s) => s.setName('remove').setDescription('Remove an automatic role').addRoleOption((o) => o.setName('role').setDescription('The role').setRequired(true))
          .addStringOption((o) => o.setName('for').setDescription('Who').addChoices({ name: 'members', value: 'members' }, { name: 'bots', value: 'bots' })))
        .addSubcommand((s) => s.setName('list').setDescription('Show automatic roles')),
      async execute(ctx, i) {
        const sub = i.options.getSubcommand();
        const key = `autorole:${i.options.getString('for') ?? 'members'}`;
        if (sub === 'list') {
          const f = (k) => (ctx.data.get(k) ?? []).map((r) => `<@&${r}>`).join(' ') || '*none*';
          return i.reply({ content: `Members: ${f('autorole:members')}\nBots: ${f('autorole:bots')}`, flags: EPH, allowedMentions: NOPING });
        }
        const role = i.options.getRole('role', true);
        if (sub === 'add') {
          must(i.guild, role, i.member);
          ctx.data.update(key, (a) => [...new Set([...a, role.id])].slice(0, 10), []);
        } else ctx.data.update(key, (a) => a.filter((r) => r !== role.id), []);
        await i.reply({ content: `Done. ${sub === 'add' ? 'New' : 'Future'} ${key.endsWith('bots') ? 'bots' : 'members'} ${sub === 'add' ? 'will get' : 'will no longer get'} **${role.name}**.`, flags: EPH, allowedMentions: NOPING });
      },
    },
    {
      permission: 'roles.manage',
      data: new SlashCommandBuilder().setName('gamerole').setDescription('Give a role while members play a game')
        .addSubcommand((s) => s.setName('add').setDescription('Link a game to a role')
          .addStringOption((o) => o.setName('game').setDescription('Game name exactly as Discord shows it, e.g. Minecraft').setRequired(true).setMaxLength(100))
          .addRoleOption((o) => o.setName('role').setDescription('Role to give').setRequired(true)))
        .addSubcommand((s) => s.setName('remove').setDescription('Unlink a game').addStringOption((o) => o.setName('game').setDescription('Game name').setRequired(true)))
        .addSubcommand((s) => s.setName('list').setDescription('Show linked games')),
      async execute(ctx, i) {
        const sub = i.options.getSubcommand();
        if (sub === 'list') {
          const rows = ctx.data.list('game:').map(({ key, value }) => `**${key.slice(5)}** → <@&${value}>`);
          return i.reply({ content: rows.join('\n') || 'No games linked yet.', flags: EPH, allowedMentions: NOPING });
        }
        const game = i.options.getString('game', true).trim().toLowerCase();
        if (sub === 'remove') { ctx.data.delete(`game:${game}`); return i.reply({ content: 'Unlinked.', flags: EPH }); }
        const role = i.options.getRole('role', true);
        must(i.guild, role, i.member);
        ctx.data.set(`game:${game}`, role.id);
        const warn = ctx.hasIntent('GuildPresences') ? '' : '\n⚠️ I can\'t see activities yet: enable **Presence Intent** in the Developer Portal (Bot > Privileged Gateway Intents) and restart me.';
        await i.reply({ content: `Members playing **${game}** will get **${role.name}**.${warn}`, flags: EPH, allowedMentions: NOPING });
      },
    },
  ],
  components: [{ prefix: 'rolemenu:', execute: (ctx, i) => (i.customId.startsWith('rolemenu:form:') ? menuForm(ctx, i) : menuClick(ctx, i)) }],
  tasks: [{ name: 'temp-roles', everyMs: 5 * 60000, run: expireTempRoles }],
  views: {
    async menus(ctx) {
      return { rows: ctx.data.list('menu:').map(({ key, value: m }) => ({ id: key.slice(5), name: m.title || 'Role menu', roles: String(m.roleIds?.length ?? 0), channel: m.channelId ? `#${ctx.guild?.channels.cache.get(m.channelId)?.name ?? '?'}` : '—',
        max: m.max ? String(m.max) : 'No limit', maxRaw: m.max || '', needs: m.needs ? `@${ctx.guild?.roles.cache.get(m.needs)?.name ?? 'deleted role'}` : 'Everyone', hours: m.hours ? `${m.hours} h` : 'For good', hoursRaw: m.hours || '' })) };
    },
  },
  actions: {
    async 'menu-max'(ctx, body) { return setLimits(ctx, String(body.id), { max: intOrZero(body.max, 25) }); },
    async 'menu-hours'(ctx, body) { return setLimits(ctx, String(body.id), { hours: intOrZero(body.hours, 2160) }); },
    async 'menu-needs'(ctx, body) { const r = String(body.needs ?? '').trim(); if (r && !ctx.guild?.roles.cache.get(r)) throw new UserError('That role is gone.'); return setLimits(ctx, String(body.id), { needs: r || null }); },
    async 'menu-delete'(ctx, body) {
      const id = String(body.id), menu = ctx.data.get(`menu:${id}`);
      if (!menu) throw new UserError('That menu is gone.');
      ctx.data.delete(`menu:${id}`);
      const ch = menu.channelId ? ctx.guild?.channels.cache.get(menu.channelId) : null;
      await ch?.messages?.delete?.(id).catch(() => {});
      return { id };
    },
  },
  panels: [{ id: 'menus', title: 'Role menus', view: 'menus', permission: 'roles.manage', empty: 'No role menus yet. Post one with /rolemenu create.',
    description: 'Every role menu, with its limits. Changes show on the menu message straight away.',
    columns: [{ key: 'name', label: 'Menu' }, { key: 'channel', label: 'Channel' }, { key: 'roles', label: 'Roles' }, { key: 'max', label: 'Most at once' }, { key: 'needs', label: 'Who can use it' }, { key: 'hours', label: 'Roles last' }],
    rowActions: [
      { action: 'menu-max', label: 'Most at once', prompt: 'number', field: 'max', current: 'maxRaw', hint: '0 = no limit', done: 'Saved' },
      { action: 'menu-hours', label: 'Roles last', prompt: 'number', field: 'hours', current: 'hoursRaw', hint: 'Hours before the role is taken away. 0 = for good.', done: 'Saved' },
      { action: 'menu-needs', label: 'Who can use it', prompt: 'text', field: 'needs', placeholder: 'A role ID, or empty for everyone', done: 'Saved' },
      { action: 'menu-delete', label: 'Delete', confirm: 'Stop this menu working and delete its message?', danger: true, done: 'Deleted' }] }],
  events: {
    guildMemberAdd: onJoin,
    presenceUpdate: onPresence,
    messageReactionAdd: (ctx, r, u) => onReaction(ctx, r, u, true),
    messageReactionRemove: (ctx, r, u) => onReaction(ctx, r, u, false),
  },
};
