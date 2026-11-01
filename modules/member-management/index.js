/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Welcome/goodbye messages, verification, custom profile roles (name + color),
 * introductions, birthdays and AFK.
 */
import {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder,
  TextInputBuilder, TextInputStyle, MessageFlags, PermissionFlagsBits as P,
} from 'discord.js';
import { formModal, readForm } from '../../src/modalkit.js';
import { formStore } from '../../src/forms.js';
import { UserError, fillTemplate, normalizeHex, hexToInt, sanitizeName, truncate, ts, roleGrantProblem, getChannelOption, describeDiscordError } from '../../src/util.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const afkNoticeAt = new Map();

const vars = (m) => ({ user: `<@${m.id}>`, username: m.user.username, server: m.guild.name, count: m.guild.memberCount });
const channelOf = (ctx, key) => { const id = ctx.config.get(key); const c = id ? ctx.guild?.channels.cache.get(id) : null; return c?.isTextBased?.() ? c : null; };

// ------------------------------------------------------------------ welcome / goodbye
async function onJoin(ctx, member) {
  const unverified = ctx.config.get('unverifiedRole');
  if (unverified && ctx.config.get('verificationRole')) await member.roles.add(unverified, 'Awaiting verification').catch((e) => ctx.log.warn(`Could not add unverified role: ${e.message}`));
  if (!ctx.config.get('welcomeEnabled')) return;
  const ch = channelOf(ctx, 'welcomeChannel');
  if (!ch) return;
  const text = truncate(fillTemplate(ctx.config.get('welcomeMessage'), vars(member)), 1900);
  await ctx.queue(() => ch.send({ content: text, allowedMentions: { users: [member.id] } }));
}

async function onLeave(ctx, member) {
  const prof = ctx.data.get(`profile:${member.id}`);
  if (prof?.roleId) { await member.guild.roles.cache.get(prof.roleId)?.delete('Member left').catch(() => {}); ctx.data.delete(`profile:${member.id}`); }
  ctx.data.delete(`afk:${member.id}`);
  if (!ctx.config.get('goodbyeEnabled') || !member.user) return;
  const ch = channelOf(ctx, 'goodbyeChannel');
  if (!ch) return;
  const text = truncate(fillTemplate(ctx.config.get('goodbyeMessage'), vars(member)), 1900);
  await ctx.queue(() => ch.send({ content: text, allowedMentions: NOPING }));
}

// ------------------------------------------------------------------ profiles
function checkProfileRules(ctx, { name, color }, ownRoleId, guild) {
  if (name !== undefined) {
    if (!ctx.config.get('profileAllowName')) throw new UserError('Name changes are turned off in this server.');
    if (!name) throw new UserError('That name has nothing usable in it. Letters, numbers and spaces work best.');
    const clash = guild.roles.cache.find((r) => r.name.toLowerCase() === name.toLowerCase() && r.id !== ownRoleId);
    if (clash) throw new UserError('A role with that name already exists - pick another so nobody is confused.');
  }
  if (color !== undefined) {
    if (!ctx.config.get('profileAllowColor')) throw new UserError('Color changes are turned off in this server.');
    const allowed = (ctx.config.get('profileAllowedColors') ?? []).map(normalizeHex).filter(Boolean);
    if (allowed.length && !allowed.includes(color)) throw new UserError(`Pick one of the allowed colors: ${allowed.join(', ')}`);
  }
}

function parseProfileInput(i) {
  const rawName = i.options.getString('name');
  const rawColor = i.options.getString('color');
  const name = rawName === null ? undefined : sanitizeName(rawName, 32);
  let color;
  if (rawColor !== null) { color = normalizeHex(rawColor); if (!color) throw new UserError('Colors look like `#FF69B4`.'); }
  return { name, color };
}

async function profileCmd(ctx, i) {
  if (!ctx.config.get('profilesEnabled')) throw new UserError('Custom profiles are turned off in this server.');
  const sub = i.options.getSubcommand();
  const guild = i.guild;
  const stored = ctx.data.get(`profile:${i.user.id}`);
  const role = stored?.roleId ? guild.roles.cache.get(stored.roleId) : null;

  if (sub === 'view') {
    const who = i.options.getUser('user') ?? i.user;
    const prof = ctx.data.get(`profile:${who.id}`);
    const r = prof && guild.roles.cache.get(prof.roleId);
    if (!r) return i.reply({ content: `${who.username} has no custom profile.`, flags: EPH, allowedMentions: NOPING });
    return i.reply({ embeds: [new EmbedBuilder().setColor(r.color || 0x99aab5).setTitle(r.name).setDescription(`Profile of <@${who.id}>\nColor: \`${r.hexColor}\``)], flags: EPH, allowedMentions: NOPING });
  }

  if (sub === 'remove') {
    if (!role) throw new UserError("You don't have a profile role.");
    await role.delete('Profile removed by member').catch(() => {});
    ctx.data.delete(`profile:${i.user.id}`);
    return i.reply({ content: 'Your profile role was removed.', flags: EPH });
  }

  const { name, color } = parseProfileInput(i);
  if (sub === 'setup') {
    if (role) throw new UserError('You already have a profile - use `/profile edit`.');
    const finalName = name ?? sanitizeName(i.member.displayName, 32);
    checkProfileRules(ctx, { name: finalName, color }, null, guild);
    let created;
    try {
      created = await guild.roles.create({ name: finalName, color: color ? hexToInt(color) : undefined, hoist: ctx.config.get('profileHoist'), mentionable: false, permissions: [], reason: `Profile role for ${i.user.tag}` });
    } catch { throw new UserError("I couldn't create a role. An admin needs to give me **Manage Roles** and move my role up the list."); }
    try {
      const me = await guild.members.fetchMe();
      const anchorId = ctx.config.get('profileAnchorRole');
      const anchor = anchorId && guild.roles.cache.get(anchorId);
      const target = Math.max(1, Math.min((anchor ? anchor.position : me.roles.highest.position) - 1, me.roles.highest.position - 1));
      await created.setPosition(target);
    } catch (e) { ctx.log.warn(`Could not position profile role: ${e.message}`); }
    await i.member.roles.add(created).catch(() => { throw new UserError("I made the role but couldn't give it to you - move my role higher."); });
    ctx.data.set(`profile:${i.user.id}`, { roleId: created.id, at: Date.now() });
    return i.reply({ content: `Your profile **${created.name}** is ready. Change it any time with \`/profile edit\`.`, flags: EPH, allowedMentions: NOPING });
  }

  // edit
  if (!role) throw new UserError('You don\'t have a profile yet - use `/profile setup`.');
  if (name === undefined && color === undefined) throw new UserError('Tell me what to change: `name` and/or `color`.');
  checkProfileRules(ctx, { name, color }, role.id, guild);
  // Only ever the exact role id we created and stored for THIS user - never a role the user names.
  if (name !== undefined) await role.setName(name, 'Profile edit');
  if (color !== undefined) await role.setColor(hexToInt(color), 'Profile edit');
  return i.reply({ content: `Updated **${role.name}**.`, flags: EPH, allowedMentions: NOPING });
}

// ------------------------------------------------------------------ verification
// The panel's button is stateless (its customId is just "verify:go"), so it keeps working across restarts.
// The panel's location is also stored so it can be checked, reposted or reset without losing any configuration.
const PANEL_KEY = 'verify:panel';
const lastClick = new Map();
const NEEDED = ['ViewChannel', 'SendMessages', 'EmbedLinks'];

const panelPayload = (ctx) => ({
  embeds: [new EmbedBuilder().setColor(0x57f287).setTitle('Verify to enter').setDescription(truncate(ctx.config.get('verifyMessage'), 1500))],
  components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('verify:go').setLabel('Verify me').setStyle(ButtonStyle.Success).setEmoji('✅'))],
});

function verifyProblems(ctx, guild, channel) {
  const out = [];
  const roleId = ctx.config.get('verificationRole');
  const role = roleId && guild.roles.cache.get(roleId);
  if (!roleId) out.push('No verification role is set (`/verify setup`).');
  else if (!role) out.push('The verification role was deleted - run `/verify setup` again.');
  else { const p = roleGrantProblem(guild, role, null, P); if (p) out.push(p); }
  const un = ctx.config.get('unverifiedRole');
  if (un) { const r = guild.roles.cache.get(un); if (!r) out.push('The "unverified" role was deleted.'); else { const p = roleGrantProblem(guild, r, null, P); if (p) out.push(`Unverified role: ${p}`); } }
  if (channel) {
    const perms = channel.permissionsFor?.(guild.members.me);
    const missing = NEEDED.filter((n) => !perms?.has(P[n]));
    if (missing.length) out.push(`I'm missing **${missing.join(', ')}** in <#${channel.id}>.`);
  }
  if (!guild.members.me?.permissions?.has(P.ManageRoles)) out.push('I need the **Manage Roles** permission.');
  return out;
}

async function removeOldPanel(ctx, guild) {
  const old = ctx.data.get(PANEL_KEY);
  if (!old) return;
  const ch = guild.channels.cache.get(old.channelId);
  await ch?.messages?.delete(old.messageId).catch(() => {});
  ctx.data.delete(PANEL_KEY);
}

async function postPanel(ctx, i, channel) {
  const problems = verifyProblems(ctx, i.guild, channel);
  if (problems.length) throw new UserError(`Verification isn't ready:\n- ${problems.join('\n- ')}`);
  let msg;
  try { msg = await channel.send(panelPayload(ctx)); }
  catch (e) { ctx.log.warn(`Verification panel post failed in ${channel.id}: code=${e.code} ${e.message}`); throw new UserError(describeDiscordError(e, 'post the verification panel')); }
  await removeOldPanel(ctx, i.guild);
  ctx.data.set(PANEL_KEY, { channelId: channel.id, messageId: msg.id, postedBy: i.user.id, postedAt: Date.now() });
  ctx.config.set('verifyChannel', channel.id);
  return msg;
}

async function verifyCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  const guild = i.guild;
  const stored = ctx.data.get(PANEL_KEY);

  if (sub === 'setup') {
    if (!i.options.getRole('role')) return i.showModal(formModal(`verify:form:${verifyForms.put({ by: i.user.id })}`, 'Set up verification', verifyFields(ctx, i.channelId)));
    return verifySetup(ctx, i, { role: i.options.getRole('role'), unverified: i.options.getRole('unverified'), message: i.options.getString('message'), channel: await getChannelOption(i, 'channel') });
  }

  return verifyRest(ctx, i, sub, stored);
}

const verifyForms = formStore('verify');
export const verifyFields = (ctx, channelId) => [
  { id: 'role', label: 'Role members get after verifying', kind: 'role' },
  { id: 'unverified', label: 'Role new members hold until then (optional)', kind: 'role', required: false },
  { id: 'channel', label: 'Channel for the Verify button', kind: 'channel', value: channelId },
  { id: 'message', label: 'Text on the panel (optional)', kind: 'paragraph', max: 1500, required: false, value: ctx.config.get('verifyMessage') ?? '' },
];
async function verifyForm(ctx, i) {
  verifyForms.take(i.customId.split(':')[2], i.user.id);
  const v = readForm(i, verifyFields(ctx, null));
  const role = i.guild.roles.cache.get(v.role);
  if (!role) throw new UserError('Choose the role members get after verifying.');
  return verifySetup(ctx, i, { role, unverified: v.unverified ? i.guild.roles.cache.get(v.unverified) : null, message: v.message || null, channel: v.channel ? i.guild.channels.cache.get(v.channel) : null });
}

async function verifySetup(ctx, i, { role, unverified, message, channel: picked }) {
  const guild = i.guild;
  {
    const p1 = roleGrantProblem(guild, role, i.member, P);
    if (p1) throw new UserError(p1);
    if (unverified) { const p2 = roleGrantProblem(guild, unverified, i.member, P); if (p2) throw new UserError(`Unverified role: ${p2}`); }
    ctx.config.set('verificationRole', role.id);
    if (unverified) ctx.config.set('unverifiedRole', unverified.id);
    if (message) ctx.config.set('verifyMessage', truncate(message, 1500));
    const channel = picked ?? (ctx.config.get('verifyChannel') && guild.channels.cache.get(ctx.config.get('verifyChannel'))) ?? i.channel;
    if (!channel?.isTextBased?.()) throw new UserError('Pick a text channel for the panel.');
    await i.deferReply({ flags: EPH });
    const msg = await postPanel(ctx, i, channel);
    return i.editReply({ content: `✅ Verification is set up. Panel posted in <#${channel.id}>: ${msg.url}\nMembers who press the button get **${role.name}**${unverified ? ` and lose **${unverified.name}**` : ''}.\n⚠️ Remember to hide your other channels from @everyone and show them to **${role.name}**, otherwise verification isn't a gate.`, allowedMentions: NOPING });
  }
}

async function verifyRest(ctx, i, sub, stored) {
  const guild = i.guild;
  if (sub === 'panel' || sub === 'repost') {
    const channel = (await getChannelOption(i, 'channel')) ?? (sub === 'repost' && stored ? guild.channels.cache.get(stored.channelId) : null) ?? i.channel;
    if (!channel?.isTextBased?.()) throw new UserError('Pick a text channel for the panel.');
    await i.deferReply({ flags: EPH });
    const msg = await postPanel(ctx, i, channel);
    return i.editReply({ content: `✅ Panel ${sub === 'repost' ? 'reposted' : 'posted'} in <#${channel.id}>: ${msg.url}\nYour role settings were not changed.`, allowedMentions: NOPING });
  }

  if (sub === 'status') {
    await i.deferReply({ flags: EPH });
    const roleId = ctx.config.get('verificationRole'), unId = ctx.config.get('unverifiedRole');
    let panelState = '*no panel posted*';
    let channel = null;
    if (stored) {
      channel = guild.channels.cache.get(stored.channelId) ?? null;
      const msg = channel ? await channel.messages.fetch(stored.messageId).catch(() => null) : null;
      panelState = msg ? `✅ [live panel](${msg.url}) in <#${stored.channelId}>` : '⚠️ the panel message is gone - run `/verify repost`';
    }
    const problems = verifyProblems(ctx, guild, channel);
    const e = new EmbedBuilder().setColor(problems.length ? 0xfaa61a : 0x57f287).setTitle('Verification status')
      .addFields({ name: 'Verified role', value: roleId ? `<@&${roleId}>` : '*not set*', inline: true }, { name: 'Unverified role', value: unId ? `<@&${unId}>` : '*none*', inline: true },
        { name: 'Panel', value: panelState }, { name: 'Members verified', value: String(ctx.data.get('verify:count') ?? 0), inline: true },
        { name: 'Checks', value: problems.length ? truncate(problems.map((p) => `❌ ${p}`).join('\n'), 1000) : '✅ everything looks right' });
    return i.editReply({ embeds: [e], allowedMentions: NOPING });
  }

  // reset
  if (!i.options.getBoolean('confirm')) throw new UserError('This removes the verification panel. Run it again with `confirm:true`. Add `settings:true` to also forget the roles and channel.');
  await removeOldPanel(ctx, guild);
  if (i.options.getBoolean('settings')) for (const k of ['verificationRole', 'unverifiedRole', 'verifyChannel']) ctx.config.set(k, null);
  ctx.log.info(`Verification reset by ${i.user.id}`);
  return i.reply({ content: `Panel removed.${i.options.getBoolean('settings') ? ' Roles and channel were cleared too.' : ' Your role settings were kept - use `/verify panel` to post a new one.'}`, flags: EPH });
}

async function verifyClick(ctx, i) {
  if (Date.now() - (lastClick.get(i.user.id) ?? 0) < 3000) throw new UserError('Easy - one moment between clicks.');
  lastClick.set(i.user.id, Date.now());
  const roleId = ctx.config.get('verificationRole');
  const role = roleId && i.guild.roles.cache.get(roleId);
  if (!role) throw new UserError('Verification is not set up right now. Tell an admin to run `/verify status`.');
  if (i.member.roles.cache.has(roleId)) return i.reply({ content: "You're already verified.", flags: EPH });
  const problem = roleGrantProblem(i.guild, role, null, P);
  if (problem) { ctx.log.warn(`Verification blocked: ${problem}`); throw new UserError('Verification is misconfigured right now. Tell an admin to run `/verify status`.'); }
  await i.member.roles.add(role, 'Verified via button').catch((e) => { ctx.log.warn(`Verify role add failed: code=${e.code}`); throw new UserError("I couldn't give you the role - an admin needs to move my role above it (`/verify status` shows what's wrong)."); });
  const un = ctx.config.get('unverifiedRole');
  if (un && i.member.roles.cache.has(un)) await i.member.roles.remove(un).catch(() => {});
  ctx.data.update('verify:count', (n) => n + 1, 0);
  await i.reply({ content: '✅ You are verified. Welcome!', flags: EPH });
}

// ------------------------------------------------------------------ introductions
function introModal() {
  return new ModalBuilder().setCustomId('intro:submit').setTitle('Introduce yourself').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('about').setLabel('About you').setStyle(TextInputStyle.Paragraph).setMaxLength(800).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('interests').setLabel('Interests').setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(false)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('fun').setLabel('A fun fact').setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(false)),
  );
}

async function introSubmit(ctx, i) {
  if (!i.isModalSubmit()) return;
  const ch = channelOf(ctx, 'introChannel');
  if (!ch) throw new UserError('Introductions are not set up.');
  const e = new EmbedBuilder().setColor(0x5865f2).setAuthor({ name: i.member.displayName, iconURL: i.user.displayAvatarURL() })
    .setDescription(truncate(i.fields.getTextInputValue('about'), 1000)).setTimestamp();
  const interests = i.fields.getTextInputValue('interests'), fun = i.fields.getTextInputValue('fun');
  if (interests) e.addFields({ name: 'Interests', value: truncate(interests, 200) });
  if (fun) e.addFields({ name: 'Fun fact', value: truncate(fun, 200) });
  const prev = ctx.data.get(`intro:${i.user.id}`);
  let msg = null;
  if (prev) msg = await ch.messages.fetch(prev.messageId).catch(() => null);
  msg = msg ? await msg.edit({ embeds: [e] }) : await ch.send({ embeds: [e], allowedMentions: NOPING });
  ctx.data.set(`intro:${i.user.id}`, { messageId: msg.id });
  await i.reply({ content: `Posted in <#${ch.id}>!`, flags: EPH });
}

// ------------------------------------------------------------------ birthdays
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
function localNow(ctx) { return new Date(Date.now() + ctx.config.get('timezoneOffset') * 3600000); }

async function birthdayTask(ctx) {
  const d = localNow(ctx);
  const today = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
  if (ctx.data.get('bdayLast') === today) return;
  ctx.data.set('bdayLast', today);
  const guild = ctx.guild;
  const roleId = ctx.config.get('birthdayRole');
  if (roleId) for (const id of ctx.data.get('bdayHolders') ?? []) await guild.members.cache.get(id)?.roles.remove(roleId).catch(() => {});
  ctx.data.set('bdayHolders', []);

  const m = d.getUTCMonth() + 1, day = d.getUTCDate();
  const feb28NonLeap = m === 2 && day === 28 && !isLeap(d.getUTCFullYear());
  const todays = ctx.data.list('bday:').filter((e) => e.value.m === m && (e.value.d === day || (feb28NonLeap && e.value.d === 29)));
  const ch = channelOf(ctx, 'birthdayChannel');
  const holders = [];
  for (const { key } of todays) {
    const id = key.slice(5);
    const member = await guild.members.fetch(id).catch(() => null);
    if (!member) continue;
    if (roleId) { await member.roles.add(roleId).then(() => holders.push(id)).catch(() => {}); }
    if (ch) await ctx.queue(() => ch.send({ content: fillTemplate(ctx.config.get('birthdayMessage'), vars(member)), allowedMentions: { users: [id] } })).catch(() => {});
  }
  ctx.data.set('bdayHolders', holders);
}

async function birthdayCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  if (sub === 'set') {
    const m = i.options.getInteger('month', true), d = i.options.getInteger('day', true);
    if (d > DAYS[m - 1]) throw new UserError("That date doesn't exist.");
    ctx.data.set(`bday:${i.user.id}`, { m, d });
    return i.reply({ content: `🎂 Saved: **${m}/${d}**. Only the month and day are stored.`, flags: EPH });
  }
  if (sub === 'remove') { ctx.data.delete(`bday:${i.user.id}`); return i.reply({ content: 'Your birthday was removed.', flags: EPH }); }
  const now = localNow(ctx);
  const year = now.getUTCFullYear();
  const upcoming = ctx.data.list('bday:').map(({ key, value }) => {
    let t = Date.UTC(year, value.m - 1, value.d);
    if (t < Date.UTC(year, now.getUTCMonth(), now.getUTCDate())) t = Date.UTC(year + 1, value.m - 1, value.d);
    return { id: key.slice(5), t, value };
  }).sort((a, b) => a.t - b.t).slice(0, 10);
  const lines = upcoming.map((u) => `<@${u.id}> - ${u.value.m}/${u.value.d}`);
  await i.reply({ embeds: [new EmbedBuilder().setColor(0xeb459e).setTitle('Upcoming birthdays').setDescription(lines.join('\n') || 'No birthdays saved yet. Use `/birthday set`.')], flags: EPH, allowedMentions: NOPING });
}

// ------------------------------------------------------------------ AFK
async function onMessage(ctx, message) {
  if (!ctx.config.get('afkEnabled') || !message.guild || message.author.bot) return;
  const mine = ctx.data.get(`afk:${message.author.id}`);
  if (mine && Date.now() - mine.since > 10000) {
    ctx.data.delete(`afk:${message.author.id}`);
    const m = await message.channel.send({ content: `Welcome back <@${message.author.id}>, I removed your AFK.`, allowedMentions: { users: [message.author.id] } }).catch(() => null);
    if (m) setTimeout(() => m.delete().catch(() => {}), 8000).unref?.();
  }
  for (const user of [...message.mentions.users.values()].slice(0, 5)) {
    if (user.bot || user.id === message.author.id) continue;
    const afk = ctx.data.get(`afk:${user.id}`);
    if (!afk) continue;
    const key = `${message.channelId}:${user.id}`;
    if (Date.now() - (afkNoticeAt.get(key) ?? 0) < 60000) continue;
    afkNoticeAt.set(key, Date.now());
    await message.reply({ content: `**${truncate(user.username, 32)}** is AFK: ${truncate(afk.reason, 200)} (${ts(afk.since)})`, allowedMentions: NOPING }).catch(() => {});
  }
}

// ------------------------------------------------------------------ definition
export default {
  name: 'member-management',
  version: '1.0.0',
  description: 'Welcome & goodbye, verification, custom profile roles, introductions, birthdays, AFK.',
  settings: [
    { key: 'welcomeEnabled', type: 'toggle', label: 'Send welcome messages', default: false },
    { key: 'welcomeChannel', type: 'channel', label: 'Welcome channel' },
    { key: 'welcomeMessage', type: 'text', label: 'Welcome message', description: '{user} {username} {server} {count}', default: 'Welcome {user} to **{server}**! You are member #{count}.' },
    { key: 'goodbyeEnabled', type: 'toggle', label: 'Send goodbye messages', default: false },
    { key: 'goodbyeChannel', type: 'channel', label: 'Goodbye channel' },
    { key: 'goodbyeMessage', type: 'text', label: 'Goodbye message', description: '{username} {server} {count}', default: '**{username}** has left the server.' },
    { key: 'verificationRole', type: 'role', label: 'Role given after verifying' },
    { key: 'unverifiedRole', type: 'role', label: 'Role new members get until verified (optional)' },
    { key: 'verifyMessage', type: 'text', label: 'Verification panel text', default: 'Press the button below to verify and unlock the server.' },
    { key: 'verifyChannel', type: 'channel', label: 'Channel holding the verification panel' },
    { key: 'profilesEnabled', type: 'toggle', label: 'Custom profile roles', default: true },
    { key: 'profileAllowName', type: 'toggle', label: 'Members may set a name', default: true },
    { key: 'profileAllowColor', type: 'toggle', label: 'Members may set a color', default: true },
    { key: 'profileHoist', type: 'toggle', label: 'Show profile roles separately in the member list', default: true },
    { key: 'profileAllowedColors', type: 'list', label: 'Allowed colors (hex, empty = any)' },
    { key: 'profileAnchorRole', type: 'role', label: 'Place profile roles just below this role' },
    { key: 'introChannel', type: 'channel', label: 'Introductions channel' },
    { key: 'birthdayChannel', type: 'channel', label: 'Birthday announcements channel' },
    { key: 'birthdayRole', type: 'role', label: 'Role for the birthday person (optional)' },
    { key: 'birthdayMessage', type: 'text', label: 'Birthday message', default: 'Happy birthday {user}! 🎂' },
    { key: 'timezoneOffset', type: 'number', label: 'Server timezone offset from UTC (hours)', default: 0, min: -12, max: 14 },
    { key: 'afkEnabled', type: 'toggle', label: 'AFK status', default: true },
  ],
  permissions: [{ key: 'member-management.manage', label: 'Post verification panels', default: 'admin' }],
  commands: [
    {
      permission: 'member-management.manage',
      ownPopup: ['setup'], // opens its own popup when run with nothing filled in
      data: new SlashCommandBuilder().setName('verify').setDescription('Verification gate')
        .addSubcommand((s) => s.setName('setup').setDescription('Set the roles and post the verification panel')
          .addRoleOption((o) => o.setName('role').setDescription('Role members get after verifying (leave everything empty for a popup)'))
          .addRoleOption((o) => o.setName('unverified').setDescription('Role new members hold until verified (optional)'))
          .addChannelOption((o) => o.setName('channel').setDescription('Where to post the panel'))
          .addStringOption((o) => o.setName('message').setDescription('Text shown on the panel').setMaxLength(1500)))
        .addSubcommand((s) => s.setName('panel').setDescription('Post a verification panel').addChannelOption((o) => o.setName('channel').setDescription('Where to post it')))
        .addSubcommand((s) => s.setName('repost').setDescription('Replace the panel (keeps all settings)').addChannelOption((o) => o.setName('channel').setDescription('Move it to this channel')))
        .addSubcommand((s) => s.setName('status').setDescription('Check that verification is working'))
        .addSubcommand((s) => s.setName('reset').setDescription('Remove the panel')
          .addBooleanOption((o) => o.setName('confirm').setDescription('Required: yes, remove it'))
          .addBooleanOption((o) => o.setName('settings').setDescription('Also forget the roles and channel'))),
      execute: verifyCmd,
    },
    {
      data: new SlashCommandBuilder().setName('profile').setDescription('Your personal name and color role')
        .addSubcommand((s) => s.setName('setup').setDescription('Create your profile role')
          .addStringOption((o) => o.setName('name').setDescription('Name for your role').setMaxLength(32))
          .addStringOption((o) => o.setName('color').setDescription('Hex color, e.g. #FF69B4')))
        .addSubcommand((s) => s.setName('edit').setDescription('Change your profile role')
          .addStringOption((o) => o.setName('name').setDescription('New name').setMaxLength(32))
          .addStringOption((o) => o.setName('color').setDescription('New hex color')))
        .addSubcommand((s) => s.setName('remove').setDescription('Delete your profile role'))
        .addSubcommand((s) => s.setName('view').setDescription('Look at a profile').addUserOption((o) => o.setName('user').setDescription('Whose'))),
      execute: profileCmd,
    },
    {
      data: new SlashCommandBuilder().setName('introduce').setDescription('Post (or update) your introduction'),
      async execute(ctx, i) {
        if (!channelOf(ctx, 'introChannel')) throw new UserError('An admin needs to set the introductions channel first.');
        await i.showModal(introModal());
      },
    },
    {
      data: new SlashCommandBuilder().setName('birthday').setDescription('Birthdays')
        .addSubcommand((s) => s.setName('set').setDescription('Save your birthday')
          .addIntegerOption((o) => o.setName('month').setDescription('1-12').setRequired(true).setMinValue(1).setMaxValue(12))
          .addIntegerOption((o) => o.setName('day').setDescription('1-31').setRequired(true).setMinValue(1).setMaxValue(31)))
        .addSubcommand((s) => s.setName('remove').setDescription('Forget your birthday'))
        .addSubcommand((s) => s.setName('upcoming').setDescription('Next birthdays in this server')),
      execute: birthdayCmd,
    },
    {
      data: new SlashCommandBuilder().setName('afk').setDescription('Mark yourself away')
        .addStringOption((o) => o.setName('reason').setDescription('Why you are away').setMaxLength(200)),
      async execute(ctx, i) {
        if (!ctx.config.get('afkEnabled')) throw new UserError('AFK is turned off here.');
        const reason = (i.options.getString('reason') ?? 'AFK').replace(/[\r\n]+/g, ' ');
        ctx.data.set(`afk:${i.user.id}`, { reason, since: Date.now() });
        await i.reply({ content: `You're AFK: ${truncate(reason, 200)}`, flags: EPH, allowedMentions: NOPING });
      },
    },
  ],
  components: [
    { prefix: 'verify:', execute: (ctx, i) => (i.customId.startsWith('verify:form:') ? verifyForm(ctx, i) : verifyClick(ctx, i)) },
    { prefix: 'intro:', execute: introSubmit },
  ],
  events: { guildMemberAdd: onJoin, guildMemberRemove: onLeave, messageCreate: onMessage },
  tasks: [{ name: 'birthdays', everyMs: 600000, runOnEnable: true, run: birthdayTask }],
};
