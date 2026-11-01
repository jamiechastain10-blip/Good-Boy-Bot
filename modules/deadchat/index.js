/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Dead chat ping (2.2): when a chosen channel has been quiet for a while, the bot pings a role with a
 * conversation starter. It pings at most once per quiet spell (someone has to talk before it can ping again)
 * and never more often than the cooldown.
 *
 * People choose to get the pings: the bot makes a mentionable @deadchat role (or uses one an admin picks) and every
 * ping, plus a small panel posted at setup, has a "Ping me" button that adds or removes that role for whoever clicks.
 *
 * Set up with /deadchat (button -> popup, no typed options) or in the dashboard: everything is a normal setting.
 * Only message times are used, never message text, so it needs no privileged intent.
 */
import { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits as P, ButtonStyle, ActionRowBuilder, ButtonBuilder } from 'discord.js';
import { createPipeline } from '../../src/modalpipe.js';
import { UserError, pingProblem, roleGrantProblem } from '../../src/util.js';

const EPH = MessageFlags.Ephemeral;
const MIN = 60000;
const SAVE_EVERY = 30000;
export const ROLE_NAME = 'deadchat'; // write the "last message" time at most this often, so busy chats don't hammer the database

export const DEFAULT_STARTERS = [
  'What game have you been playing lately?',
  'Best snack of all time? Wrong answers only.',
  'What is something small that made your week better?',
  'If you could instantly master one skill, what would it be?',
  'Drop the last photo in your camera roll you are allowed to share.',
  'What is a hot take you will defend to the end?',
  'What are you looking forward to this week?',
  'Recommend one song everyone here should hear.',
];

// The last time someone talked, per server, kept on a global so a hot reload does not forget it.
const lastSeen = (globalThis[Symbol.for('goodboy.deadchat.last')] ??= new Map());

/** Pure rule: should we ping now? Exported for tests. */
export function shouldPing({ now, lastMessageAt, lastPingAt = 0, quietMs, cooldownMs }) {
  if (!lastMessageAt) return false;                 // nothing seen yet since start-up: wait for a baseline
  if (now - lastMessageAt < quietMs) return false;  // not quiet long enough
  if (lastPingAt >= lastMessageAt) return false;    // already pinged this quiet spell; wait for someone to talk
  if (now - lastPingAt < cooldownMs) return false;  // pinged too recently
  return true;
}

function starter(ctx) {
  const list = (ctx.config.get('starters') ?? []).filter(Boolean);
  const pool = list.length ? list : DEFAULT_STARTERS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** The opt-in button shown under every ping and on the setup panel. Anyone can press it for themselves. */
const optRow = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('deadchat:toggle').setEmoji('🔔').setLabel('Ping me when chat dies / stop').setStyle(ButtonStyle.Secondary));

/** Finds the @deadchat role or makes it (mentionable, no permissions). */
async function ensureRole(ctx) {
  const existing = [...(ctx.guild?.roles.cache.values() ?? [])].find((r) => r.name.toLowerCase() === ROLE_NAME && !r.managed);
  if (existing) return existing;
  try {
    return await ctx.guild.roles.create({ name: ROLE_NAME, mentionable: true, permissions: [], reason: 'Dead chat ping: members who want to be pinged when chat goes quiet' });
  } catch (e) { throw new UserError(`I couldn't create the @${ROLE_NAME} role (${e.message}). Give me **Manage Roles**, or pick a role yourself.`); }
}

async function toggle(ctx, i) {
  const roleId = ctx.config.get('role');
  const role = roleId ? ctx.guild?.roles.cache.get(roleId) : null;
  if (!ctx.config.get('enabled') || !role) throw new UserError('The dead chat ping is not set up right now.');
  const problem = roleGrantProblem(ctx.guild, role, null, P);
  if (problem) throw new UserError(`I can't hand out that role: ${problem}`);
  const member = i.member;
  const has = member.roles.cache.has(role.id);
  try { if (has) await member.roles.remove(role.id, 'Dead chat ping: opted out'); else await member.roles.add(role.id, 'Dead chat ping: opted in'); }
  catch (e) { throw new UserError(`I couldn't change your roles (${e.message}). Ask an admin to move my role above @${role.name}.`); }
  return i.reply({ content: has ? `🔕 You won't be pinged when chat dies any more.` : `🔔 You'll be pinged with <@&${role.id}> when chat goes quiet. Press the button again to stop.`, flags: EPH, allowedMentions: { parse: [] } });
}

function onMessage(ctx, message) {
  if (message.author?.bot || message.system) return;
  if (message.channelId !== ctx.config.get('channel')) return;
  const now = Date.now();
  lastSeen.set(ctx.guildId, now);
  const saved = ctx.data.get('lastMessageAt') ?? 0;
  if (now - saved > SAVE_EVERY) ctx.data.set('lastMessageAt', now);
}

export async function check(ctx, now = Date.now()) {
  if (!ctx.config.get('enabled')) return;
  const ch = ctx.guild?.channels.cache.get(ctx.config.get('channel'));
  if (!ch?.isTextBased?.()) return;
  let last = Math.max(lastSeen.get(ctx.guildId) ?? 0, ctx.data.get('lastMessageAt') ?? 0);
  if (!last) { ctx.data.set('lastMessageAt', now); lastSeen.set(ctx.guildId, now); return; } // first run: start the clock
  const lastPingAt = ctx.data.get('lastPingAt') ?? 0;
  if (!shouldPing({ now, lastMessageAt: last, lastPingAt, quietMs: ctx.config.get('quietMinutes') * MIN, cooldownMs: ctx.config.get('cooldownMinutes') * MIN })) return;
  const roleId = ctx.config.get('role');
  const problem = roleId ? pingProblem(ctx.guild, ch, 'role', [roleId], P) : null;
  if (problem) ctx.log.warn(`Dead chat ping posted without the role ping: ${problem}`);
  const mins = Math.round((now - last) / MIN);
  const content = `${roleId && !problem ? `<@&${roleId}> ` : ''}💬 **Chat has been quiet for ${mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`}!**\n${starter(ctx)}`;
  ctx.data.set('lastPingAt', now); // set first: a failed send must not turn into a ping every minute
  await ctx.queue(() => ch.send({ content, components: roleId ? [optRow()] : [], allowedMentions: roleId && !problem ? { roles: [roleId] } : { parse: [] } }))
    .catch((e) => ctx.log.warn(`Dead chat ping failed: ${e.message}`));
}

const pipe = createPipeline({
  ns: 'mpd',
  forms: {
    setup: {
      title: 'Dead chat ping', permission: 'deadchat.manage', color: 0x5865f2,
      button: { label: 'Configure dead chat ping', emoji: '💬', style: ButtonStyle.Primary },
      intro: (ctx) => ctx.config.get('enabled')
        ? `On: <#${ctx.config.get('channel')}> after **${ctx.config.get('quietMinutes')} min** of quiet, at most every **${ctx.config.get('cooldownMinutes')} min**${ctx.config.get('role') ? `, pinging <@&${ctx.config.get('role')}>` : ''}.`
        : 'Off. Pick a channel, who to ping and how long the chat must be quiet.',
      fields: (ctx, i) => [
        { id: 'enabled', kind: 'select', label: 'Turn it on?', value: 'on', options: [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }] },
        { id: 'channel', kind: 'channel', label: 'Channel to watch', value: ctx.config.get('channel') ? [ctx.config.get('channel')] : (i.channelId ? [i.channelId] : undefined) },
        { id: 'role', kind: 'role', label: 'Role to ping (optional)', desc: `Leave empty and I'll make a @${ROLE_NAME} role people can opt into`, required: false },
        { id: 'quiet', kind: 'number', label: 'Quiet for how many minutes?', value: ctx.config.get('quietMinutes'), min: 10, maxNum: 10080, max: 5 },
        { id: 'cooldown', kind: 'number', label: 'At most once every N minutes', value: ctx.config.get('cooldownMinutes'), min: 30, maxNum: 10080, max: 5 },
      ],
      async submit(ctx, i, v) {
        if (!v.channel) throw new UserError('Pick a channel to watch.');
        if (v.quiet == null || v.cooldown == null) throw new UserError('Fill in both numbers.');
        // Through the validated settings path, exactly like the dashboard.
        ctx.settings.set('channel', v.channel);
        const role = v.role ? ctx.guild?.roles.cache.get(v.role) : await ensureRole(ctx);
        if (!role) throw new UserError('That role no longer exists.');
        const grant = roleGrantProblem(ctx.guild, role, i.member, P);
        if (grant) throw new UserError(`Members can't opt into that role: ${grant}`);
        ctx.settings.set('role', role.id);
        ctx.settings.set('quietMinutes', String(v.quiet));
        ctx.settings.set('cooldownMinutes', String(v.cooldown));
        ctx.settings.set('enabled', v.enabled === 'off' ? 'false' : 'true');
        if (!ctx.data.get('lastMessageAt')) ctx.data.set('lastMessageAt', Date.now());
        const ch = ctx.guild?.channels.cache.get(v.channel);
        const problem = ch ? pingProblem(ctx.guild, ch, 'role', [role.id], P) : null;
        if (v.enabled !== 'off' && ch?.send) {
          await ch.send({ content: `💬 **Dead chat ping is on here.** When this channel goes quiet for ${v.quiet} minutes, <@&${role.id}> gets a ping and a conversation starter. Want in?`, components: [optRow()], allowedMentions: { parse: [] } })
            .catch((e) => ctx.log.warn(`Could not post the dead chat panel: ${e.message}`));
        }
        const e = new EmbedBuilder().setColor(v.enabled === 'off' ? 0x95a5a6 : 0x2ecc71).setTitle(v.enabled === 'off' ? '💬 Dead chat ping is off' : '💬 Dead chat ping is on')
          .setDescription(`Watching <#${v.channel}>. After **${v.quiet} min** without a message the bot posts a conversation starter and pings <@&${role.id}>, at most every **${v.cooldown} min**. Members opt in with the **Ping me** button I posted there.${problem ? `\n⚠️ ${problem}` : ''}\nConversation starters can be edited in the dashboard or with \`/config\`.`);
        return i.reply({ embeds: [e], flags: EPH, allowedMentions: { parse: [] } });
      },
    },
  },
});

export default {
  name: 'deadchat',
  version: '1.0.0',
  description: 'Pings a role with a conversation starter when a channel goes quiet',
  settings: [
    { key: 'enabled', type: 'toggle', label: 'Dead chat ping on', default: false },
    { key: 'channel', type: 'channel', label: 'Channel to watch' },
    { key: 'role', type: 'role', label: 'Role to ping (members opt in with a button; /deadchat can create @deadchat)' },
    { key: 'quietMinutes', type: 'number', label: 'Ping after this many quiet minutes', default: 60, min: 10, max: 10080 },
    { key: 'cooldownMinutes', type: 'number', label: 'At most one ping every N minutes', default: 240, min: 30, max: 10080 },
    { key: 'starters', type: 'list', label: 'Conversation starters (one picked at random)' },
  ],
  permissions: [{ key: 'deadchat.manage', label: 'Set up the dead chat ping', default: 'admin' }],
  commands: [{
    permission: 'deadchat.manage',
    data: new SlashCommandBuilder().setName('deadchat').setDescription('Set up the dead chat ping (opens a form)'),
    execute: (ctx, i) => pipe.launch(ctx, i, 'setup'),
  }],
  events: { messageCreate: onMessage },
  components: [pipe.component, { prefix: 'deadchat:toggle', execute: toggle }],
  tasks: [{ name: 'check', everyMs: 60000, run: (ctx) => check(ctx) }],
};
