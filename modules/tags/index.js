/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Custom commands and auto-replies (2.3): what Carl-bot tags and YAGPDB custom commands did.
 *
 *   command     typed with a prefix: "?rules" or "!ip" (the prefixes are a setting, so old habits keep working)
 *   exact       the whole message is the trigger: "ip"
 *   starts      the message starts with it: "how do i join"
 *   contains    the trigger appears as a word or phrase anywhere in the message
 *
 * Replies can use {user} {username} {server} {channel} {args}, and since 3.1 {arg1}..{arg9}, {uses}, {membercount},
 * {date}, {random: a | b}, {number: 1-100} and {if: {arg1} = yes | then | else} (see src/tagscript.js).
 * Replies never ping anyone (no @everyone tricks).
 * Each one has a cooldown per channel, and can be limited to some channels.
 */
import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { UserError, truncate } from '../../src/util.js';
import { runTagScript, argVars } from '../../src/tagscript.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const MAX = 200;
const TRIGGERS = ['command', 'exact', 'starts', 'contains'];
const TRIGGER_WORDS = { command: 'command (?name)', exact: 'whole message', starts: 'message starts with', contains: 'message contains' };
const NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;

const keyOf = (name) => `cc:${String(name).toLowerCase()}`;
export const allCommands = (ctx) => ctx.data.list('cc:').map((r) => r.value);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Which custom command a message sets off, and the words after it ({args}), or null. */
export function matchMessage(text, list, prefixes) {
  const msg = String(text ?? '').trim();
  if (!msg) return null;
  const lower = msg.toLowerCase();
  for (const p of prefixes) {
    if (!p || !lower.startsWith(p.toLowerCase())) continue;
    const [word, ...rest] = msg.slice(p.length).split(/\s+/);
    const hit = list.find((c) => c.trigger === 'command' && c.name.toLowerCase() === word.toLowerCase());
    if (hit) return { cmd: hit, args: rest.join(' ') };
  }
  for (const c of list) {
    const t = String(c.phrase ?? c.name).toLowerCase();
    if (c.trigger === 'exact' && lower === t) return { cmd: c, args: '' };
    if (c.trigger === 'starts' && lower.startsWith(t)) return { cmd: c, args: msg.slice(t.length).trim() };
    if (c.trigger === 'contains' && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}($|[^\\p{L}\\p{N}])`, 'u').test(lower)) return { cmd: c, args: '' };
  }
  return null;
}

export function render(c, vars, rand = Math.random) {
  const text = runTagScript(c.response, vars, rand) || '\u200b';
  if (!c.title) return { content: truncate(text, 2000), allowedMentions: NOPING };
  const e = new EmbedBuilder().setTitle(truncate(runTagScript(c.title, vars, rand), 256) || '\u200b').setDescription(truncate(text, 4000));
  if (c.color) e.setColor(c.color);
  return { embeds: [e], allowedMentions: NOPING };
}

const cooldowns = new Map(); // `${guild}:${name}:${channel}` -> until
function onCooldown(ctx, c, channelId) {
  if (!c.cooldown) return false;
  const k = `${ctx.guildId}:${c.name}:${channelId}`;
  if ((cooldowns.get(k) ?? 0) > Date.now()) return true;
  cooldowns.set(k, Date.now() + c.cooldown * 1000);
  return false;
}

const varsFor = (ctx, member, user, channel, args, uses = 0) => ({ user: `<@${user.id}>`, username: member?.displayName ?? user.username, server: ctx.guild?.name ?? '', channel: channel ? `<#${channel.id}>` : '',
  membercount: ctx.guild?.memberCount ?? '', date: new Date().toISOString().slice(0, 10), uses, ...argVars(args) });

async function onMessage(ctx, m) {
  if (!m.guildId || m.author?.bot || m.webhookId) return;
  const hit = matchMessage(m.content, allCommands(ctx), ctx.config.get('prefixes') ?? []);
  if (!hit) return;
  const c = hit.cmd;
  if (c.channels?.length && !c.channels.includes(m.channelId) && !c.channels.includes(m.channel?.parentId)) return;
  if (onCooldown(ctx, c, m.channelId)) return;
  const uses = (c.uses ?? 0) + 1;
  ctx.data.set(keyOf(c.name), { ...c, uses });
  if (c.deleteTrigger && c.trigger === 'command') await m.delete().catch(() => {});
  await ctx.queue(() => m.channel.send(render(c, varsFor(ctx, m.member, m.author, m.channel, hit.args, uses)))).catch((e) => ctx.log.warn(`Custom command ${c.name}: ${e.message}`));
}

/** Add or replace one (also used by /migrate). */
export function saveCommand(ctx, input, by) {
  const name = String(input.name ?? '').trim().replace(/^[?!.\-$]+/, '');
  if (!NAME_RE.test(name)) throw new UserError('The name can be up to 32 letters, numbers, - or _ (no spaces).');
  const trigger = TRIGGERS.includes(input.trigger) ? input.trigger : 'command';
  const response = String(input.response ?? '').trim();
  if (!response) throw new UserError('Write what the bot should reply.');
  const existing = ctx.data.get(keyOf(name));
  if (!existing && allCommands(ctx).length >= MAX) throw new UserError(`You can have up to ${MAX} custom commands.`);
  let color = null;
  if (input.color) { const hex = String(input.color).replace('#', ''); if (!/^[0-9a-f]{6}$/i.test(hex)) throw new UserError('The colour must be a hex code like #5865F2.'); color = parseInt(hex, 16); }
  const cmd = { name, trigger, phrase: input.phrase ? String(input.phrase).trim().slice(0, 100) : null, response: response.slice(0, 2000), title: input.title ? String(input.title).slice(0, 256) : null, color,
    cooldown: Math.max(0, Math.min(3600, Number(input.cooldown) || 0)), channels: input.channels ?? existing?.channels ?? [], deleteTrigger: !!input.deleteTrigger,
    uses: existing?.uses ?? 0, by: by ?? existing?.by ?? null, at: Date.now(), from: input.from ?? existing?.from ?? null };
  ctx.data.set(keyOf(name), cmd);
  ctx.live('data');
  return { cmd, replaced: !!existing };
}

async function tagsCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  const prefixes = ctx.config.get('prefixes') ?? [];
  if (sub === 'list') {
    const list = allCommands(ctx).sort((a, b) => a.name.localeCompare(b.name));
    const line = (c) => (c.trigger === 'command' ? `\`${prefixes[0] ?? '?'}${c.name}\`` : `**${c.phrase ?? c.name}** · ${TRIGGER_WORDS[c.trigger]}`) + ` · used ${c.uses ?? 0}×`;
    const e = new EmbedBuilder().setColor(0x5865f2).setTitle(`📝 Custom commands · ${list.length}`)
      .setDescription(list.length ? truncate(list.map(line).join('\n'), 4000) : 'None yet. Staff can add one with `/tags add`.');
    return i.reply({ embeds: [e], flags: EPH, allowedMentions: NOPING });
  }
  if (sub === 'use') {
    const c = ctx.data.get(keyOf(i.options.getString('name', true)));
    if (!c) throw new UserError('There is no custom command with that name. See `/tags list`.');
    const uses = (c.uses ?? 0) + 1;
    ctx.data.set(keyOf(c.name), { ...c, uses });
    return i.reply(render(c, varsFor(ctx, i.member, i.user, i.channel, i.options.getString('args') ?? '', uses)));
  }
  if (!ctx.perms.check(i.member, 'tags.manage')) throw new UserError("You don't have permission for that (`tags.manage`).");
  if (sub === 'add') {
    const { cmd, replaced } = saveCommand(ctx, { name: i.options.getString('name', true), trigger: i.options.getString('trigger') ?? 'command', phrase: i.options.getString('phrase'),
      response: i.options.getString('response', true), title: i.options.getString('embed_title'), cooldown: i.options.getInteger('cooldown') }, i.user.id);
    const how = cmd.trigger === 'command' ? `Type \`${prefixes[0] ?? '?'}${cmd.name}\`` : `It replies when a ${TRIGGER_WORDS[cmd.trigger]} **${cmd.phrase ?? cmd.name}**`;
    return i.reply({ content: `✅ ${replaced ? 'Updated' : 'Added'} **${cmd.name}**. ${how}.`, flags: EPH, allowedMentions: NOPING });
  }
  if (sub === 'remove') {
    const name = i.options.getString('name', true);
    if (!ctx.data.get(keyOf(name))) throw new UserError('There is no custom command with that name.');
    ctx.data.delete(keyOf(name)); ctx.live('data');
    return i.reply({ content: `🗑️ Removed **${name}**.`, flags: EPH });
  }
  throw new UserError('Unknown subcommand.');
}

export default {
  name: 'tags',
  version: '1.0.0',
  description: 'Custom commands and auto-replies: ?rules, !ip, or replies when someone says a word',
  settings: [
    { key: 'prefixes', type: 'list', label: 'Command prefixes (one per line)', default: ['?', '!'] },
  ],
  permissions: [
    { key: 'tags.use', label: 'Use custom commands', default: 'everyone' },
    { key: 'tags.manage', label: 'Add and remove custom commands', default: 'moderator' },
  ],
  commands: [{
    permission: 'tags.use',
    data: new SlashCommandBuilder().setName('tags').setDescription('Custom commands and auto-replies')
      .addSubcommand((s) => s.setName('list').setDescription('Every custom command'))
      .addSubcommand((s) => s.setName('use').setDescription('Post a custom command here').addStringOption((o) => o.setName('name').setDescription('Which one').setRequired(true)).addStringOption((o) => o.setName('args').setDescription('Words after the command, for {args} and {arg1}').setMaxLength(500)))
      .addSubcommand((s) => s.setName('add').setDescription('Add or change a custom command (staff)')
        .addStringOption((o) => o.setName('name').setDescription('Its name, e.g. rules (used as ?rules)').setRequired(true).setMaxLength(32))
        .addStringOption((o) => o.setName('response').setDescription('Reply. {user} {args} {arg1} {random: a | b} {number: 1-6} {if: {arg1} = x | yes | no}').setRequired(true).setMaxLength(2000))
        .addStringOption((o) => o.setName('trigger').setDescription('When it replies').addChoices({ name: 'command (?name)', value: 'command' }, { name: 'whole message is the phrase', value: 'exact' }, { name: 'message starts with the phrase', value: 'starts' }, { name: 'message contains the phrase', value: 'contains' }))
        .addStringOption((o) => o.setName('phrase').setDescription('The phrase for auto-replies (empty = the name)').setMaxLength(100))
        .addStringOption((o) => o.setName('embed_title').setDescription('Optional: reply in a box with this title').setMaxLength(256))
        .addIntegerOption((o) => o.setName('cooldown').setDescription('Seconds before it can reply again in the same channel').setMinValue(0).setMaxValue(3600)))
      .addSubcommand((s) => s.setName('remove').setDescription('Remove a custom command (staff)').addStringOption((o) => o.setName('name').setDescription('Which one').setRequired(true))),
    execute: tagsCmd,
  }],
  events: { messageCreate: onMessage },
  actions: {
    async 'tag-remove'(ctx, body) { const k = keyOf(body.userId ?? body.id ?? ''); if (!ctx.data.get(k)) throw new UserError('Not found.'); ctx.data.delete(k); return { ok: true }; },
  },
  views: {
    async list(ctx) {
      const p = (ctx.config.get('prefixes') ?? [])[0] ?? '?';
      return { rows: allCommands(ctx).sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ id: c.name, name: c.trigger === 'command' ? `${p}${c.name}` : c.phrase ?? c.name, when: TRIGGER_WORDS[c.trigger], reply: truncate(c.response, 80), uses: c.uses ?? 0, from: c.from ?? '' })) };
    },
  },
  panels: [{ id: 'list', title: 'Custom commands', view: 'list', permission: 'tags.manage', description: 'Add them with /tags add in Discord.', empty: 'No custom commands yet.',
    columns: [{ key: 'name', label: 'Command' }, { key: 'when', label: 'Replies when' }, { key: 'reply', label: 'Reply' }, { key: 'uses', label: 'Used' }, { key: 'from', label: 'Imported from' }],
    rowActions: [{ action: 'tag-remove', label: 'Remove', confirm: 'Remove this custom command?', danger: true, done: 'Removed' }] }],
};
