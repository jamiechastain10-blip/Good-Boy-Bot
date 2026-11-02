/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Clips (2.3): a game-clips channel that runs itself.
 *
 *   A clip arrives      a member uploads a video file (from Steam, NVIDIA, AMD, Xbox Game Bar, OBS, a phone), pastes a
 *                       clip link (Medal, YouTube, Twitch, Streamable, Outplayed, Allstar...), or Medal's own bot posts
 *                       it ("@Member shared a clip", from Medal's Send to Discord button).
 *                       The member is credited either way: Medal's post names them with an @mention.
 *   Voting              Good Boy adds the vote emoji. Members vote by reacting; the clip's owner and bots don't count.
 *   Best clips          enough votes reposts the clip (with its video) in the Best clips channel, once.
 *   Clip of the week    every Monday the most-voted clip of last week is announced, and its owner gets coins.
 *   Rewards             a few coins for each clip shared (with a daily cap), when the economy module is on.
 *   Leaderboards        "Clips shared" and "Clip votes" in /top.
 *
 * Only clip messages are touched; normal chat in the channel is left alone. Message text is never stored, only the
 * clip link, its title and who shared it.
 */
import { SlashCommandBuilder, EmbedBuilder, MessageFlags, ChannelType } from 'discord.js';
import { UserError, truncate } from '../../src/util.js';
import { weekStartKey, addDays } from '../../src/activity.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const CLIP_HOSTS = ['medal.tv', 'youtube.com/shorts', 'youtube.com/watch', 'youtu.be', 'clips.twitch.tv', 'twitch.tv/', 'streamable.com', 'outplayed.tv', 'allstar.gg', 'tiktok.com'];
const URL_RE = /https?:\/\/[^\s<>()]+/gi;

/** The first clip link in some text, or null. */
export function findClipUrl(text, hosts = CLIP_HOSTS) {
  for (const url of String(text ?? '').match(URL_RE) ?? []) {
    const clean = url.replace(/[)>.,!?]+$/, '');
    if (hosts.some((h) => clean.toLowerCase().includes(h))) return clean;
  }
  return null;
}

/** Medal's bot: "<@123> shared a clip". Returns the member's id, or null if this isn't one. */
export function medalSharer(message) {
  if (!message.author?.bot) return null;
  const text = String(message.content ?? '');
  if (!/shared a clip/i.test(text)) return null;
  return message.mentions?.users?.first?.()?.id ?? /<@!?(\d{17,20})>/.exec(text)?.[1] ?? null;
}

/** Who a clip message belongs to and its link, or null if the message isn't a clip. */
export function clipFrom(message) {
  const embed = message.embeds?.[0];
  const embedUrl = embed?.url ?? embed?.data?.url ?? null;
  const fromMedal = medalSharer(message);
  if (fromMedal) return { userId: fromMedal, url: findClipUrl(message.content) ?? embedUrl, title: embed?.title ?? embed?.data?.title ?? null, via: 'medal' };
  if (message.author?.bot || message.webhookId) return null;
  const url = findClipUrl(message.content);
  if (url) return { userId: message.author.id, url, title: embed?.title ?? embed?.data?.title ?? null, via: 'link' };
  // An uploaded video file (from Steam, NVIDIA, AMD, Xbox Game Bar, OBS, a phone...). Discord's file links expire, so
  // only the name is kept; the file itself is read from the message when it is needed.
  const video = videoOf(message);
  return video ? { userId: message.author.id, url: null, title: video.name ?? null, via: 'upload' } : null;
}

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i;
/** The first video attached to a message, or null. */
export function videoOf(message) {
  for (const a of message.attachments?.values?.() ?? []) if (String(a.contentType ?? '').startsWith('video/') || VIDEO_EXT.test(a.name ?? '')) return a;
  return null;
}
/** Only Discord's own file servers are downloaded from. */
export function isDiscordFile(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(u.hostname); } catch { return false; }
}
/** The biggest file the bot may upload here (Discord: 10 MB, more on boosted servers). */
const uploadLimit = (guild) => ({ 2: 50, 3: 100 }[guild?.premiumTier] ?? 10) * 1024 * 1024;

const clipsChannel = (ctx) => ctx.config.get('clipsChannel');
const textCh = (ctx, id) => { const c = id && ctx.guild?.channels.cache.get(id); return c?.isTextBased?.() ? c : null; };
const emojiMatches = (reaction, want) => reaction.emoji?.name === want || reaction.emoji?.toString?.() === want;
const eco = (ctx) => ctx.api?.('economy') ?? null;
const getClip = (ctx, id) => ctx.sql.get('SELECT * FROM clips_list WHERE guild_id = ? AND message_id = ?', ctx.guildId, id);

async function onMessage(ctx, message) {
  if (!message.guildId || message.channelId !== clipsChannel(ctx)) return;
  const c = clipFrom(message);
  if (!c) return;
  ctx.sql.run(`INSERT OR IGNORE INTO clips_list (guild_id, message_id, channel_id, user_id, url, title, via, at, votes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ctx.guildId, message.id, message.channelId, c.userId, c.url, c.title ? truncate(c.title, 200) : null, c.via, message.createdTimestamp ?? Date.now());
  await ctx.queue(() => message.react(ctx.config.get('voteEmoji'))).catch(() => {});
  // A few coins per clip, at most N clips a day, so sharing is rewarded but spamming isn't.
  const coins = ctx.config.get('coinsPerClip'), api = eco(ctx);
  if (coins && api) {
    const today = ctx.sql.get('SELECT COUNT(*) AS n FROM clips_list WHERE guild_id = ? AND user_id = ? AND at >= ?', ctx.guildId, c.userId, Date.now() - 86400000).n;
    if (today <= ctx.config.get('rewardedClipsPerDay')) { try { api.credit(ctx.guildId, c.userId, coins, 'shared a clip'); } catch { /* member has no wallet yet: skip */ } }
  }
  ctx.live('activity', { icon: '🎬', text: `${ctx.guild?.members.cache.get(c.userId)?.displayName ?? 'Someone'} shared a clip` });
  ctx.live('data');
}

// Links pasted by members only get their title once Discord has looked the link up, a moment later.
async function onUpdate(ctx, _old, message) {
  if (message.channelId !== clipsChannel(ctx)) return;
  const title = message.embeds?.[0]?.title;
  if (title) ctx.sql.run('UPDATE clips_list SET title = ? WHERE guild_id = ? AND message_id = ? AND title IS NULL', truncate(title, 200), ctx.guildId, message.id);
}

const locks = new Set();
async function onReaction(ctx, reaction) {
  const message = reaction.message;
  if (message.channelId !== clipsChannel(ctx) || !emojiMatches(reaction, ctx.config.get('voteEmoji'))) return;
  const clip = getClip(ctx, message.id);
  if (!clip || locks.has(message.id)) return;
  locks.add(message.id);
  try {
    const users = await reaction.users.fetch();
    const votes = users.filter((u) => !u.bot && u.id !== clip.user_id).size;
    ctx.sql.run('UPDATE clips_list SET votes = ? WHERE guild_id = ? AND message_id = ?', votes, ctx.guildId, message.id);
    if (votes >= ctx.config.get('bestVotes') && !clip.best_message_id) await postBest(ctx, { ...clip, votes }, videoOf(message));
    ctx.live('data');
  } finally { locks.delete(message.id); }
}

function clipLine(ctx, c) {
  return `${ctx.config.get('voteEmoji')} **${c.votes}** · clip by <@${c.user_id}>${c.title ? ` · ${truncate(c.title, 120)}` : ''}`;
}
const jump = (ctx, c) => `https://discord.com/channels/${ctx.guildId}/${c.channel_id}/${c.message_id}`;

async function postBest(ctx, clip, video = null) {
  const ch = textCh(ctx, ctx.config.get('bestChannel'));
  if (!ch) return;
  // A link goes in the message text so Discord shows the playable video. An uploaded file is uploaded again (when it
  // fits), because Discord's file links stop working after a while.
  let files;
  if (!clip.url && isDiscordFile(video?.url) && (video.size ?? 0) <= uploadLimit(ctx.guild)) {
    const buf = await fetch(video.url, { signal: AbortSignal.timeout(60000) }).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
    if (buf) files = [{ attachment: Buffer.from(buf), name: video.name ?? 'clip.mp4' }];
  }
  const sent = await ctx.queue(() => ch.send({ content: `🏆 ${clipLine(ctx, clip)} · [jump](${jump(ctx, clip)})${clip.url ? `\n${clip.url}` : ''}`, ...(files ? { files } : {}), allowedMentions: NOPING })).catch((e) => { ctx.log.warn(`Best clips: ${e.message}`); return null; });
  if (sent) ctx.sql.run('UPDATE clips_list SET best_message_id = ? WHERE guild_id = ? AND message_id = ?', sent.id, ctx.guildId, clip.message_id);
}

/** Every Monday: last week's most-voted clip. The first run only starts the clock. */
export async function clipOfTheWeek(ctx) {
  const week = weekStartKey(Date.now(), 0);
  const last = ctx.data.get('lastWeek');
  if (!last) { ctx.data.set('lastWeek', week); return null; }
  if (last === week) return null;
  ctx.data.set('lastWeek', week);
  const from = Date.parse(`${addDays(week, -7)}T00:00:00Z`), to = Date.parse(`${week}T00:00:00Z`);
  const top = ctx.sql.get('SELECT * FROM clips_list WHERE guild_id = ? AND at >= ? AND at < ? AND votes > 0 ORDER BY votes DESC, at ASC LIMIT 1', ctx.guildId, from, to);
  if (!top) return null;
  ctx.sql.run('UPDATE clips_list SET weekly_win = 1 WHERE guild_id = ? AND message_id = ?', ctx.guildId, top.message_id);
  const prize = ctx.config.get('weeklyPrize'), api = eco(ctx);
  let paid = false;
  if (prize && api) { try { api.credit(ctx.guildId, top.user_id, prize, 'clip of the week'); paid = true; } catch { /* no wallet */ } }
  const ch = textCh(ctx, ctx.config.get('bestChannel')) ?? textCh(ctx, clipsChannel(ctx));
  if (ch) {
    await ctx.queue(() => ch.send({ content: `🎬 **Clip of the week** goes to <@${top.user_id}>!${paid ? ` (+${api.format(ctx.guildId, prize)})` : ''}\n${clipLine(ctx, top)} · [jump](${jump(ctx, top)})${top.url ? `\n${top.url}` : ''}`,
      allowedMentions: ctx.config.get('pingWinner') ? { users: [top.user_id] } : NOPING })).catch(() => {});
  }
  ctx.live('activity', { icon: '🎬', text: `Clip of the week: ${top.title ?? 'a clip'} (${top.votes} votes)` });
  return top;
}

function topClips(ctx, period, limit = 10) {
  const since = period === 'week' ? Date.now() - 7 * 86400000 : period === 'month' ? Date.now() - 30 * 86400000 : 0;
  return ctx.sql.all('SELECT * FROM clips_list WHERE guild_id = ? AND at >= ? AND votes > 0 ORDER BY votes DESC, at DESC LIMIT ?', ctx.guildId, since, limit);
}

async function clipsCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  if (sub === 'top') {
    const period = i.options.getString('period') ?? 'week';
    const rows = topClips(ctx, period);
    const words = { week: 'this week', month: 'this month', all: 'of all time' }[period];
    const e = new EmbedBuilder().setColor(0xff7a45).setTitle(`🎬 Top clips ${words}`)
      .setDescription(rows.length ? rows.map((c, k) => `**${k + 1}.** ${clipLine(ctx, c)} · [watch](${jump(ctx, c)})`).join('\n') : `No voted clips ${words} yet. Share one in <#${clipsChannel(ctx) ?? ''}>!`);
    return i.reply({ embeds: [e], flags: EPH, allowedMentions: NOPING });
  }
  if (sub === 'setup') {
    if (!ctx.perms.check(i.member, 'clips.manage')) throw new UserError("You don't have permission for that (`clips.manage`).");
    const clips = i.options.getChannel('clips_channel'), best = i.options.getChannel('best_channel'), votes = i.options.getInteger('votes_needed');
    if (clips) ctx.settings.set('clipsChannel', clips.id);
    if (best) ctx.settings.set('bestChannel', best.id);
    if (votes) ctx.settings.set('bestVotes', votes);
    return i.reply({ content: `✅ Clips are watched in <#${ctx.config.get('clipsChannel')}>. ${ctx.config.get('bestChannel') ? `Clips with **${ctx.config.get('bestVotes')}** ${ctx.config.get('voteEmoji')} votes go to <#${ctx.config.get('bestChannel')}>.` : 'Pick a Best clips channel to repost the top ones.'}\nMedal's **Send to Discord** button works: point MedalBot's Community Share at the same channel.`, flags: EPH, allowedMentions: NOPING });
  }
  throw new UserError('Unknown subcommand.');
}

const views = {
  async top(ctx) {
    return { rows: topClips(ctx, 'month', 25).map((c) => ({ id: c.user_id, member: ctx.guild?.members.cache.get(c.user_id)?.displayName ?? c.user_id, title: c.title ?? '(no title)', votes: c.votes, when: new Date(c.at).toISOString().slice(0, 10), best: c.best_message_id ? '🏆' : '', week: c.weekly_win ? '🎬' : '' })) };
  },
};

export default {
  name: 'clips',
  version: '1.0.0',
  description: 'Game clips channel: Medal clips and clip links get votes, the best are reposted, clip of the week wins coins',
  memberIntroTitle: 'Clips channel',
  memberIntro: 'Share your best plays! Upload a video or paste a clip link in the clips channel. Vote for clips you like with the reaction. The most-voted clips go to Best clips, and every Monday the **clip of the week** wins coins. See the top ones with **/clips top**.',
  settings: [
    { key: 'clipsChannel', type: 'channel', label: 'Clips channel (where Medal and members post clips)' },
    { key: 'bestChannel', type: 'channel', label: 'Best clips channel (top clips and clip of the week are reposted here)' },
    { key: 'voteEmoji', type: 'text', label: 'Vote emoji', default: '🔥', maxLength: 64 },
    { key: 'bestVotes', type: 'number', label: 'Votes needed for Best clips', default: 5, min: 1, max: 100 },
    { key: 'coinsPerClip', type: 'number', label: 'Coins for sharing a clip (needs economy, 0 = off)', default: 25, min: 0, max: 100000 },
    { key: 'rewardedClipsPerDay', type: 'number', label: 'Clips per member per day that earn coins', default: 3, min: 1, max: 50 },
    { key: 'weeklyPrize', type: 'number', label: 'Coins for clip of the week (needs economy, 0 = off)', default: 1000, min: 0, max: 10000000 },
    { key: 'pingWinner', type: 'toggle', label: 'Ping the clip of the week winner', default: true },
  ],
  permissions: [
    { key: 'clips.view', label: 'See top clips', default: 'everyone' },
    { key: 'clips.manage', label: 'Set up the clips channel', default: 'admin' },
  ],
  commands: [{
    permission: 'clips.view',
    data: new SlashCommandBuilder().setName('clips').setDescription('Game clips: top clips and setup')
      .addSubcommand((s) => s.setName('top').setDescription('The most-voted clips').addStringOption((o) => o.setName('period').setDescription('When').addChoices({ name: 'this week', value: 'week' }, { name: 'this month', value: 'month' }, { name: 'all time', value: 'all' })))
      .addSubcommand((s) => s.setName('setup').setDescription('Choose the clips channel, the Best clips channel and votes needed (staff)')
        .addChannelOption((o) => o.setName('clips_channel').setDescription('Where Medal and members post clips').addChannelTypes(ChannelType.GuildText).setRequired(true))
        .addChannelOption((o) => o.setName('best_channel').setDescription('Where the top clips are reposted').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addIntegerOption((o) => o.setName('votes_needed').setDescription('Votes needed for Best clips').setMinValue(1).setMaxValue(100))),
    execute: clipsCmd,
  }],
  events: { messageCreate: onMessage, messageUpdate: onUpdate, messageReactionAdd: onReaction, messageReactionRemove: onReaction },
  tasks: [{ name: 'weekly', everyMs: 600000, run: clipOfTheWeek }],
  views,
  panels: [{ id: 'top', title: 'Top clips (30 days)', view: 'top', permission: 'clips.manage', empty: 'No voted clips yet.',
    columns: [{ key: 'member', label: 'Shared by' }, { key: 'title', label: 'Clip' }, { key: 'votes', label: 'Votes' }, { key: 'when', label: 'When' }, { key: 'best', label: 'Best' }, { key: 'week', label: 'Week' }] }],
  migrations: [{ id: 1, sql: `
    CREATE TABLE IF NOT EXISTS clips_list (guild_id TEXT NOT NULL, message_id TEXT NOT NULL, channel_id TEXT NOT NULL, user_id TEXT NOT NULL, url TEXT, title TEXT,
      via TEXT NOT NULL, at INTEGER NOT NULL, votes INTEGER NOT NULL DEFAULT 0, best_message_id TEXT, weekly_win INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, message_id));
    CREATE INDEX IF NOT EXISTS clips_list_user ON clips_list (guild_id, user_id, at);` }],
  async init(ctx) {
    const api = eco(ctx);
    if (!api?.registerBoard) return;
    const name = 'LEFT JOIN economy_wallets w ON w.guild_id = x.guild_id AND w.user_id = x.user_id';
    api.registerBoard({ id: 'clips', module: 'clips', label: 'Clips shared', emoji: '🎬', source: `SELECT x.guild_id, x.user_id, w.name, COUNT(*) AS value FROM clips_list x ${name} GROUP BY x.guild_id, x.user_id`, format: (c, v) => `**${v}** clip${v === 1 ? '' : 's'}` });
    api.registerBoard({ id: 'clipvotes', module: 'clips', label: 'Clip votes', emoji: '🔥', source: `SELECT x.guild_id, x.user_id, w.name, SUM(x.votes) AS value FROM clips_list x ${name} GROUP BY x.guild_id, x.user_id HAVING SUM(x.votes) > 0`, format: (c, v) => `**${v}** vote${v === 1 ? '' : 's'}` });
  },
};
