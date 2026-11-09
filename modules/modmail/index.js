/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Modmail (3.1): members DM the bot, staff answer in a private thread.
 *   - A member's DM opens (or continues) a thread in the staff channel set in the settings, with a header card,
 *     Close and Block buttons. Their files come across as links.
 *   - Whatever staff write in that thread goes back to the member as a DM, as "Staff" (or with their name if the
 *     server chose that). Lines starting with // stay in the thread as notes for other staff.
 *   - Close ends the conversation (the member is told); their next DM opens a new one. Block stops a member's DMs.
 * DMs reach this module from src/index.js through api.fromDM (Discord DMs belong to no server).
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from 'discord.js';
import { UserError, truncate } from '../../src/util.js';

const NOPING = { parse: [] };
const ctxs = (globalThis[Symbol.for('goodboy.modmail.ctxs')] ??= new Map());
const BLUE = 0x6b93ff, DONE = 0x95a5a6;

const headerRow = (userId) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`mmail:close:${userId}`).setLabel('Close').setEmoji('✅').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`mmail:block:${userId}`).setLabel('Block').setEmoji('⛔').setStyle(ButtonStyle.Danger));
const attachmentsText = (m) => [...(m.attachments?.values?.() ?? [])].map((a) => `📎 [${truncate(a.name ?? 'file', 60)}](${a.url})`).join('\n');

/** The open thread for a member, or a new one. */
async function threadFor(ctx, user) {
  const open = ctx.data.get(`open:${user.id}`);
  if (open) {
    const t = ctx.guild?.channels.cache.get(open) ?? await ctx.guild?.channels.fetch(open).catch(() => null);
    if (t && !t.archived) return t;
    ctx.data.delete(`open:${user.id}`); ctx.data.delete(`thread:${open}`);
  }
  const ch = ctx.guild?.channels.cache.get(ctx.config.get('channel'));
  if (!ch) throw new UserError('Modmail is not set up in this server yet.');
  const name = truncate(`📬 ${user.globalName ?? user.username}`, 90);
  const member = await ctx.guild.members.fetch(user.id).catch(() => null);
  const head = new EmbedBuilder().setColor(BLUE).setTitle(`📬 Modmail from ${user.globalName ?? user.username}`).setThumbnail(user.displayAvatarURL?.() ?? null)
    .setDescription(`<@${user.id}> (\`${user.id}\`)\nAccount made <t:${Math.floor((user.createdTimestamp ?? Date.now()) / 1000)}:R>${member?.joinedTimestamp ? ` · joined <t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : ''}`)
    .setFooter({ text: 'Write here to answer them. Start a line with // for a note only staff see.' });
  let thread;
  const role = ctx.config.get('pingRole');
  if (ch.type === ChannelType.GuildForum) {
    thread = await ch.threads.create({ name, message: { content: role ? `<@&${role}>` : undefined, embeds: [head], components: [headerRow(user.id)], allowedMentions: role ? { roles: [role] } : NOPING } });
  } else {
    const starter = await ch.send({ content: role ? `<@&${role}>` : undefined, embeds: [head], components: [headerRow(user.id)], allowedMentions: role ? { roles: [role] } : NOPING });
    thread = await starter.startThread({ name, autoArchiveDuration: 10080 });
  }
  ctx.data.set(`open:${user.id}`, thread.id);
  ctx.data.set(`thread:${thread.id}`, { userId: user.id, at: Date.now() });
  ctx.live?.('activity', { icon: '📬', text: `New modmail from ${user.globalName ?? user.username}` });
  return { thread, isNew: true };
}

/** A DM from a member to this server's staff. Returns true when it was delivered. */
export async function fromDM(ctx, message) {
  const user = message.author;
  if (ctx.data.get(`blocked:${user.id}`)) { await message.reply('You can\'t message the staff of this server through me.').catch(() => {}); return false; }
  const got = await threadFor(ctx, user);
  const thread = got.thread ?? got;
  const body = [message.content ? truncate(message.content, 3900) : null, attachmentsText(message)].filter(Boolean).join('\n') || '*(empty message)*';
  await thread.send({ embeds: [new EmbedBuilder().setColor(BLUE).setAuthor({ name: user.globalName ?? user.username, iconURL: user.displayAvatarURL?.() ?? undefined }).setDescription(body).setTimestamp()], allowedMentions: NOPING });
  if (got.isNew) {
    const hello = ctx.config.get('greeting') || `Thanks for your message! It went to the staff of **${ctx.guild?.name ?? 'the server'}**. They'll answer here.`;
    await message.reply({ content: hello, allowedMentions: NOPING }).catch(() => {});
  } else await message.react?.('✅').catch(() => {});
  return true;
}

/** Staff writing in a modmail thread: send it to the member (notes starting with // stay here). */
async function onStaffMessage(ctx, message) {
  if (message.author?.bot || !message.channel?.isThread?.()) return;
  const link = ctx.data.get(`thread:${message.channelId}`);
  if (!link || ctx.data.get(`open:${link.userId}`) !== message.channelId) return;
  if (!message.content && !message.attachments?.size) return;
  if (message.content?.trim().startsWith('//')) return;
  const user = await ctx.client.users.fetch(link.userId).catch(() => null);
  const from = ctx.config.get('showStaffNames') ? (message.member?.displayName ?? message.author.username) : 'Staff';
  const body = [message.content ? truncate(message.content, 3900) : null, attachmentsText(message)].filter(Boolean).join('\n');
  const ok = await user?.send({ embeds: [new EmbedBuilder().setColor(0x3ba55d).setAuthor({ name: `${from} · ${truncate(ctx.guild?.name ?? 'Server', 60)}`, iconURL: ctx.guild?.iconURL?.() ?? undefined }).setDescription(body).setTimestamp()] }).then(() => true).catch(() => false);
  await message.react(ok ? '📨' : '⚠️').catch(() => {});
  if (!ok) await message.reply({ content: "I couldn't DM them (they may have DMs from this server turned off).", allowedMentions: NOPING }).catch(() => {});
}

async function onButton(ctx, i) {
  const [, action, userId] = i.customId.split(':');
  if (!ctx.perms.check(i.member, 'modmail.reply')) throw new UserError('Only staff can do that.');
  if (action === 'close') {
    const open = ctx.data.get(`open:${userId}`);
    ctx.data.delete(`open:${userId}`);
    const user = await ctx.client.users.fetch(userId).catch(() => null);
    await user?.send({ content: `✅ Your conversation with the staff of **${ctx.guild?.name ?? 'the server'}** was closed. Message me again any time to start a new one.` }).catch(() => {});
    await i.update({ components: [], embeds: i.message.embeds.map((e) => EmbedBuilder.from(e).setColor(DONE).setFooter({ text: `Closed by ${i.member.displayName}` })) }).catch(() => {});
    const t = open ? ctx.guild?.channels.cache.get(open) : null;
    await t?.setArchived?.(true, 'Modmail closed').catch(() => {});
    return;
  }
  if (action === 'block') {
    const blocked = !ctx.data.get(`blocked:${userId}`);
    if (blocked) ctx.data.set(`blocked:${userId}`, { by: i.user.id, at: Date.now() }); else ctx.data.delete(`blocked:${userId}`);
    return i.reply({ content: blocked ? `⛔ <@${userId}> can no longer message staff through me. Press Block again to undo.` : `<@${userId}> can message staff again.`, allowedMentions: NOPING });
  }
  throw new UserError('Unknown button.');
}

export default {
  name: 'modmail',
  version: '1.0.0',
  description: 'Members DM the bot to reach staff; staff answer from a private thread',
  memberIntroTitle: 'modmail',
  memberIntro: 'need to talk to staff privately? just DM the bot and your message goes straight to them, their answers come back in your DMs',
  settings: [
    { key: 'channel', type: 'channel', label: 'Staff channel where modmail threads open (a text or forum channel staff can see)', channelTypes: [0, 15] },
    { key: 'pingRole', type: 'role', label: 'Ping this role when a new conversation starts (optional)' },
    { key: 'showStaffNames', type: 'toggle', label: 'Show staff names on replies (otherwise just "Staff")', default: false },
    { key: 'greeting', type: 'text', label: 'First reply members get (optional)' },
  ],
  permissions: [{ key: 'modmail.reply', label: 'Answer, close and block modmail', default: 'moderator' }],
  events: { messageCreate: onStaffMessage },
  components: [{ prefix: 'mmail:', execute: onButton }],
  api: {
    /** Servers that can take a DM from this user. */
    ready: (guildId) => { const c = ctxs.get(guildId); return !!(c && c.config.get('channel')); },
    hasOpen: (guildId, userId) => !!ctxs.get(guildId)?.data.get(`open:${userId}`),
    fromDM: (guildId, message) => { const c = ctxs.get(guildId); if (!c) throw new UserError('Modmail is off there.'); return fromDM(c, message); },
  },
  async init(ctx) { ctxs.set(ctx.guildId, ctx); },
  async destroy(ctx) { ctxs.delete(ctx.guildId); },
};
