/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Messages (2.3): post as the bot, edit what the bot posted, and sticky messages (what Carl-bot's embeds and
 * sticky notes did).
 *
 *   /say send     channel, text, optional box (title, colour, picture). Posts as Good Boy. Never pings.
 *   /say edit     paste a link to a Good Boy message and change its text or box.
 *   /sticky       a message that always stays at the bottom of a channel: when people talk, it is reposted under
 *                 them (after a short pause, at most once per cooldown), and the old copy is removed.
 */
import { SlashCommandBuilder, EmbedBuilder, MessageFlags, ChannelType } from 'discord.js';
import { UserError, truncate } from '../../src/util.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const LINK_RE = /discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})/;

/** The message to post: plain text, or a box when there is a title, colour or picture. */
export function buildPost({ text, title, color, image }) {
  text = String(text ?? '').trim();
  let hex = null;
  if (color) { const h = String(color).replace('#', ''); if (!/^[0-9a-f]{6}$/i.test(h)) throw new UserError('The colour must be a hex code like #5865F2.'); hex = parseInt(h, 16); }
  if (image && !/^https:\/\/\S+$/i.test(String(image))) throw new UserError('The picture must be an https:// link.');
  if (!title && !hex && !image) {
    if (!text) throw new UserError('Write something to post.');
    return { content: truncate(text, 2000), embeds: [], allowedMentions: NOPING };
  }
  const e = new EmbedBuilder();
  if (title) e.setTitle(truncate(title, 256));
  if (text) e.setDescription(truncate(text, 4000));
  if (hex !== null) e.setColor(hex);
  if (image) e.setImage(String(image));
  return { content: null, embeds: [e], allowedMentions: NOPING };
}

const writable = (ctx, ch) => {
  if (!ch?.isTextBased?.()) throw new UserError('Pick a text channel.');
  const me = ctx.guild?.members?.me;
  const p = me && ch.permissionsFor?.(me);
  if (p && !(p.has?.('SendMessages') && p.has?.('ViewChannel'))) throw new UserError(`I can't post in <#${ch.id}>. Give me View Channel and Send Messages there.`);
  return ch;
};

async function sayCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  if (sub === 'send') {
    const picked = i.options.getChannel('channel');
    const ch = writable(ctx, picked ? ctx.guild.channels.cache.get(picked.id) ?? picked : i.channel);
    const post = buildPost({ text: i.options.getString('message'), title: i.options.getString('title'), color: i.options.getString('color'), image: i.options.getString('image') });
    const sent = await ctx.queue(() => ch.send(post));
    return i.reply({ content: `✅ Posted in <#${ch.id}>. [Open it](${sent?.url ?? ''}). To change it later: \`/say edit\` with that message's link.`, flags: EPH, allowedMentions: NOPING });
  }
  if (sub === 'edit') {
    const m = LINK_RE.exec(i.options.getString('link', true));
    if (!m || m[1] !== ctx.guildId) throw new UserError('Paste a link to a message in this server (right-click the message → Copy Message Link).');
    const ch = ctx.guild.channels.cache.get(m[2]);
    const msg = await ch?.messages?.fetch(m[3]).catch(() => null);
    if (!msg) throw new UserError("I can't find that message.");
    if (msg.author?.id !== ctx.client?.user?.id) throw new UserError('I can only edit messages I posted.');
    const post = buildPost({ text: i.options.getString('message'), title: i.options.getString('title'), color: i.options.getString('color'), image: i.options.getString('image') });
    await ctx.queue(() => msg.edit(post));
    return i.reply({ content: '✅ Message updated.', flags: EPH });
  }
  throw new UserError('Unknown subcommand.');
}

// ------------------------------------------------------------------ sticky messages
const timers = new Map(); // channelId -> timeout
const stickyKey = (channelId) => `sticky:${channelId}`;

export async function repostSticky(ctx, channelId) {
  const s = ctx.data.get(stickyKey(channelId));
  const ch = ctx.guild?.channels.cache.get(channelId);
  if (!s || !ch?.isTextBased?.()) return false;
  if (s.lastId) await ch.messages?.delete?.(s.lastId).catch(() => {});
  const sent = await ctx.queue(() => ch.send(buildPost(s.post))).catch(() => null);
  ctx.data.set(stickyKey(channelId), { ...s, lastId: sent?.id ?? null, lastAt: Date.now() });
  return !!sent;
}

function onMessage(ctx, m) {
  if (!m.guildId || m.author?.id === ctx.client?.user?.id) return;
  const s = ctx.data.get(stickyKey(m.channelId));
  if (!s) return;
  clearTimeout(timers.get(m.channelId));
  // Wait for a pause in the chat, and never repost more often than the cooldown.
  const wait = Math.max(ctx.config.get('stickyDelaySeconds') * 1000, (s.lastAt ?? 0) + ctx.config.get('stickyCooldownSeconds') * 1000 - Date.now());
  const t = setTimeout(() => { timers.delete(m.channelId); repostSticky(ctx, m.channelId).catch(() => {}); }, wait);
  t.unref?.();
  timers.set(m.channelId, t);
}

async function stickyCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  if (sub === 'list') {
    const rows = ctx.data.list('sticky:').map(({ key, value }) => `<#${key.slice(7)}> · ${truncate(value.post.title || value.post.text || '(picture)', 80)}`);
    return i.reply({ content: rows.length ? rows.join('\n') : 'No sticky messages yet.', flags: EPH, allowedMentions: NOPING });
  }
  const picked = i.options.getChannel('channel');
  const ch = picked ? ctx.guild.channels.cache.get(picked.id) ?? picked : i.channel;
  if (sub === 'remove') {
    const s = ctx.data.get(stickyKey(ch.id));
    if (!s) throw new UserError(`<#${ch.id}> has no sticky message.`);
    if (s.lastId) await ch.messages?.delete?.(s.lastId).catch(() => {});
    ctx.data.delete(stickyKey(ch.id));
    clearTimeout(timers.get(ch.id)); timers.delete(ch.id);
    return i.reply({ content: `🗑️ Removed the sticky message from <#${ch.id}>.`, flags: EPH, allowedMentions: NOPING });
  }
  if (sub === 'set') {
    writable(ctx, ch);
    const post = { text: i.options.getString('message'), title: i.options.getString('title'), color: i.options.getString('color') };
    buildPost(post); // checks it
    const old = ctx.data.get(stickyKey(ch.id));
    ctx.data.set(stickyKey(ch.id), { post, lastId: old?.lastId ?? null, lastAt: 0, by: i.user.id });
    await repostSticky(ctx, ch.id);
    return i.reply({ content: `📌 <#${ch.id}> now has a sticky message. It moves back to the bottom when people talk.`, flags: EPH, allowedMentions: NOPING });
  }
  throw new UserError('Unknown subcommand.');
}

const postOptions = (s, required = true) => s
  .addStringOption((o) => o.setName('message').setDescription('The text').setRequired(required).setMaxLength(2000))
  .addStringOption((o) => o.setName('title').setDescription('Optional: put it in a box with this title').setMaxLength(256))
  .addStringOption((o) => o.setName('color').setDescription('Optional: box colour, like #5865F2').setMaxLength(7));

export default {
  name: 'messages',
  version: '1.0.0',
  description: 'Post and edit messages as the bot, and sticky messages that stay at the bottom of a channel',
  settings: [
    { key: 'stickyDelaySeconds', type: 'number', label: 'Sticky: wait this many seconds of quiet before reposting', default: 5, min: 2, max: 300 },
    { key: 'stickyCooldownSeconds', type: 'number', label: 'Sticky: repost at most once every N seconds', default: 30, min: 10, max: 3600 },
  ],
  permissions: [{ key: 'messages.post', label: 'Post as the bot and set sticky messages', default: 'admin' }],
  commands: [{
    permission: 'messages.post',
    data: new SlashCommandBuilder().setName('say').setDescription('Post or edit a message as the bot (staff)')
      .addSubcommand((s) => postOptions(s.setName('send').setDescription('Post a message as the bot'))
        .addChannelOption((o) => o.setName('channel').setDescription('Where (empty = here)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName('image').setDescription('Optional: a picture link (https://...)').setMaxLength(500)))
      .addSubcommand((s) => postOptions(s.setName('edit').setDescription('Change a message the bot posted')
        .addStringOption((o) => o.setName('link').setDescription('The message link (right-click → Copy Message Link)').setRequired(true)), false)
        .addStringOption((o) => o.setName('image').setDescription('Optional: a picture link (https://...)').setMaxLength(500))),
    execute: sayCmd,
  }, {
    permission: 'messages.post',
    data: new SlashCommandBuilder().setName('sticky').setDescription('A message that stays at the bottom of a channel (staff)')
      .addSubcommand((s) => postOptions(s.setName('set').setDescription('Set the sticky message for a channel'))
        .addChannelOption((o) => o.setName('channel').setDescription('Which channel (empty = here)').addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('remove').setDescription('Remove a channel\'s sticky message').addChannelOption((o) => o.setName('channel').setDescription('Which channel (empty = here)').addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('list').setDescription('Every sticky message')),
    execute: stickyCmd,
  }],
  events: { messageCreate: onMessage },
  async destroy() { for (const t of timers.values()) clearTimeout(t); timers.clear(); },
};
