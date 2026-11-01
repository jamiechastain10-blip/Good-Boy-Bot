/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Integration framework. Ships with providers that need no API keys: RSS/Atom, YouTube
 * channels, GitHub releases/commits/tags, Reddit subreddits. Also a Minecraft server status
 * command and inbound webhooks. Other services (Twitch, Steam, Roblox, Spotify...) are
 * meant to be separate add-ons that call api.registerProvider().
 *
 * Every outbound request goes through fetchText(), which blocks private/loopback addresses
 * (SSRF protection), caps the response size and enforces a timeout.
 */
import crypto from 'node:crypto';
import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { UserError, fetchText, truncate, fillTemplate, SNOWFLAKE, getChannelOption } from '../../src/util.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const MAX_SUBS = 15;
const MAX_HOOKS = 10;

// ------------------------------------------------------------------ minimal feed parsing
const decode = (s) => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();
const tag = (block, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block); return m ? decode(m[1]) : ''; };

function atomLink(block) {
  for (const t of block.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /rel=["']([^"']+)["']/i.exec(t)?.[1];
    const href = /href=["']([^"']+)["']/i.exec(t)?.[1];
    if (href && (!rel || rel === 'alternate')) return decode(href);
  }
  return '';
}

export function parseFeed(xml) {
  const atom = /<feed[\s>]/i.test(xml);
  const blocks = xml.match(atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  return blocks.map((b) => {
    const url = atom ? atomLink(b) : tag(b, 'link');
    return { id: tag(b, atom ? 'id' : 'guid') || url, title: tag(b, 'title') || '(untitled)', url, author: tag(b, 'name') || tag(b, 'dc:creator') || tag(b, 'author') };
  }).filter((x) => x.id && /^https?:\/\//i.test(x.url));
}

const feedItems = async (url, maxBytes) => {
  const xml = await fetchText(url, { maxBytes });
  const items = parseFeed(xml);
  if (!items.length && !/<(rss|feed|rdf)/i.test(xml)) throw new UserError("That doesn't look like an RSS/Atom feed.");
  return items;
};

// ------------------------------------------------------------------ providers
const providers = new Map();
providers.set('rss', {
  owner: null, label: 'RSS / Atom feed URL',
  async resolve(raw) { try { return new URL(raw.trim()).href; } catch { throw new UserError('That is not a valid URL.'); } },
  items: (target) => feedItems(target),
});
providers.set('youtube', {
  owner: null, label: 'YouTube channel (ID, URL or @handle)',
  async resolve(raw) {
    raw = raw.trim();
    const direct = /(UC[\w-]{22})/.exec(raw);
    if (direct) return direct[1];
    const handle = /^(?:https?:\/\/(?:www\.)?youtube\.com\/)?(@[\w.-]{3,40})\/?$/i.exec(raw);
    if (!handle) throw new UserError('Give a channel ID (UC…), a channel URL, or an @handle.');
    const html = await fetchText(`https://www.youtube.com/${handle[1]}`, { maxBytes: 6_000_000 });
    const id = /"channelId":"(UC[\w-]{22})"/.exec(html)?.[1] ?? /channel\/(UC[\w-]{22})/.exec(html)?.[1];
    if (!id) throw new UserError("I couldn't find that channel. Try its channel ID instead.");
    return id;
  },
  items: (target) => feedItems(`https://www.youtube.com/feeds/videos.xml?channel_id=${target}`),
});
providers.set('github', {
  owner: null, label: 'GitHub repo: owner/name[:releases|commits|tags]',
  async resolve(raw) {
    const m = /^([\w.-]{1,39})\/([\w.-]{1,100})(?::(releases|commits|tags))?$/.exec(raw.trim());
    if (!m) throw new UserError('Use `owner/repo` or `owner/repo:commits`.');
    return `${m[1]}/${m[2]}:${m[3] ?? 'releases'}`;
  },
  items(target) { const [repo, kind] = target.split(':'); return feedItems(`https://github.com/${repo}/${kind}.atom`); },
});
providers.set('reddit', {
  owner: null, label: 'Subreddit: r/name',
  async resolve(raw) {
    const m = /^(?:\/?r\/)?([A-Za-z0-9_]{2,21})$/.exec(raw.trim());
    if (!m) throw new UserError('Use a subreddit like `r/gaming`.');
    return m[1];
  },
  items: (target) => feedItems(`https://www.reddit.com/r/${target}/new/.rss`),
});

const api = {
  /** Add-ons call this to add a service. def = { label, resolve(raw) -> target, items(target) -> [{id,title,url,author}] } */
  registerProvider(name, def, owner) {
    if (!/^[a-z0-9-]{2,20}$/.test(name) || typeof def?.resolve !== 'function' || typeof def?.items !== 'function') throw new Error('bad provider');
    providers.set(name, { label: def.label ?? name, resolve: def.resolve, items: def.items, owner });
  },
  providers,
  async handleWebhook(ctx, token, body) {
    const hook = ctx.data.get(`hook:${sha(token)}`);
    if (!hook) return false;
    const ch = ctx.guild?.channels.cache.get(hook.channelId);
    if (!ch?.isTextBased() || typeof body !== 'object' || body === null) return false;
    const payload = { allowedMentions: NOPING };
    if (body.content) payload.content = truncate(String(body.content), 1900);
    if (body.title || body.description) {
      const e = new EmbedBuilder().setColor(Number.isInteger(body.color) && body.color >= 0 && body.color <= 0xffffff ? body.color : 0x5865f2);
      if (body.title) e.setTitle(truncate(String(body.title), 250));
      if (body.description) e.setDescription(truncate(String(body.description), 3800));
      if (typeof body.url === 'string' && /^https?:\/\//i.test(body.url) && body.title) e.setURL(body.url);
      e.setFooter({ text: truncate(hook.name, 80) });
      payload.embeds = [e];
    }
    if (!payload.content && !payload.embeds) return false;
    await ctx.queue(() => ch.send(payload));
    return true;
  },
};

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const available = (ctx, p) => !p.owner || ctx.isActive(p.owner);

// ------------------------------------------------------------------ polling
async function postItem(ctx, sub, item) {
  const ch = ctx.guild.channels.cache.get(sub.channelId);
  if (!ch?.isTextBased()) throw new Error('channel missing');
  const text = fillTemplate(sub.template || '**{title}**\n{url}', { title: truncate(item.title, 200), url: item.url, author: item.author || '', provider: sub.provider });
  await ctx.queue(() => ch.send({ content: truncate(text, 1900), allowedMentions: NOPING }));
}

async function pollSub(ctx, key, sub, { announce = true } = {}) {
  const prov = providers.get(sub.provider);
  if (!prov || !available(ctx, prov)) return;
  try {
    const items = await prov.items(sub.target);
    const seen = new Set(sub.seen);
    const fresh = items.filter((x) => !seen.has(x.id));
    if (announce && sub.seen.length) for (const item of fresh.slice(0, 5).reverse()) await postItem(ctx, sub, item);
    sub.seen = [...new Set([...items.map((x) => x.id), ...sub.seen])].slice(0, 60);
    sub.failures = 0;
    sub.lastPoll = Date.now();
  } catch (err) {
    sub.failures = (sub.failures ?? 0) + 1;
    sub.lastPoll = Date.now() + Math.min(sub.failures, 6) * 300000; // back off up to 30 min
    ctx.log.warn(`Feed #${sub.id} (${sub.provider}:${sub.target}) failed: ${err.message}`);
    if (sub.failures >= 30) { ctx.data.delete(key); ctx.log.warn(`Feed #${sub.id} removed after repeated failures`); return; }
  }
  ctx.data.set(key, sub);
}

async function pollTask(ctx) {
  const every = ctx.config.get('pollMinutes') * 60000;
  for (const { key, value: sub } of ctx.data.list('sub:')) if (Date.now() - (sub.lastPoll ?? 0) >= every) await pollSub(ctx, key, sub);
}

// ------------------------------------------------------------------ commands
async function feedCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  if (sub === 'list') {
    const rows = ctx.data.list('sub:').map(({ value: s }) => `**#${s.id}** ${s.provider} · \`${truncate(s.target, 60)}\` → <#${s.channelId}>${s.failures ? ` ⚠️ ${s.failures} failure(s)` : ''}`);
    return i.reply({ content: rows.join('\n') || 'No feeds yet. Add one with `/feed add`.', flags: EPH, allowedMentions: NOPING });
  }
  if (sub === 'remove') {
    const id = i.options.getInteger('id', true);
    if (!ctx.data.get(`sub:${id}`)) throw new UserError('No feed with that number.');
    ctx.data.delete(`sub:${id}`);
    return i.reply({ content: `Removed feed #${id}.`, flags: EPH });
  }
  if (sub === 'check') {
    await i.deferReply({ flags: EPH });
    let n = 0;
    for (const { key, value } of ctx.data.list('sub:')) { await pollSub(ctx, key, value); n++; }
    return i.editReply({ content: `Checked ${n} feed(s).` });
  }
  // add
  const name = i.options.getString('provider', true).toLowerCase();
  const prov = providers.get(name);
  if (!prov || !available(ctx, prov)) throw new UserError(`Unknown provider. Available: ${[...providers].filter(([, p]) => available(ctx, p)).map(([n]) => n).join(', ')}`);
  if (ctx.data.list('sub:').length >= MAX_SUBS) throw new UserError(`Up to ${MAX_SUBS} feeds per server.`);
  const ch = await getChannelOption(i, 'channel', true);
  if (!ch?.isTextBased()) throw new UserError('Pick a text channel.');
  await i.deferReply({ flags: EPH });
  const target = await prov.resolve(i.options.getString('target', true));
  const id = ctx.data.update('subCounter', (n) => n + 1, 0);
  const record = { id, provider: name, target, channelId: ch.id, template: i.options.getString('message') ?? undefined, seen: [], failures: 0, lastPoll: 0, by: i.user.id };
  const items = await prov.items(target); // validates the target works right now
  record.seen = items.map((x) => x.id).slice(0, 60);
  record.lastPoll = Date.now();
  ctx.data.set(`sub:${id}`, record);
  await i.editReply({ content: `Following **${name}** \`${truncate(target, 80)}\` in <#${ch.id}> (feed #${id}). New items only - I won't repost old ones.` });
}

async function feedAutocomplete(ctx, i) {
  const focused = i.options.getFocused(true);
  if (focused.name !== 'provider') return i.respond([]);
  const q = String(focused.value).toLowerCase();
  await i.respond([...providers].filter(([n, p]) => available(ctx, p) && n.includes(q)).slice(0, 25).map(([n, p]) => ({ name: truncate(`${n} - ${p.label}`, 100), value: n })));
}

async function minecraftCmd(ctx, i) {
  const addr = i.options.getString('address', true).trim();
  if (!/^[a-zA-Z0-9.-]{3,253}(:\d{1,5})?$/.test(addr)) throw new UserError('That does not look like a server address.');
  await i.deferReply();
  const data = JSON.parse(await fetchText(`https://api.mcsrvstat.us/3/${encodeURIComponent(addr)}`));
  const e = new EmbedBuilder().setTitle(truncate(addr, 100)).setColor(data.online ? 0x57f287 : 0xed4245);
  if (!data.online) e.setDescription('🔴 Offline (or not reachable).');
  else e.setDescription(`🟢 Online\n${truncate((data.motd?.clean ?? []).join('\n'), 300)}`).addFields(
    { name: 'Players', value: `${data.players?.online ?? 0} / ${data.players?.max ?? '?'}`, inline: true }, { name: 'Version', value: truncate(data.version ?? '?', 60), inline: true });
  await i.editReply({ embeds: [e], allowedMentions: NOPING });
}

async function webhookCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  const list = () => ctx.data.list('hook:').map((h) => h.value);
  if (sub === 'list') {
    return i.reply({ content: list().map((h) => `**#${h.id}** ${h.name} → <#${h.channelId}>`).join('\n') || 'No webhooks.', flags: EPH, allowedMentions: NOPING });
  }
  if (sub === 'delete') {
    const id = i.options.getInteger('id', true);
    const h = ctx.data.list('hook:').find((x) => x.value.id === id);
    if (!h) throw new UserError('No webhook with that number.');
    ctx.data.delete(h.key);
    return i.reply({ content: `Deleted webhook #${id}.`, flags: EPH });
  }
  if (list().length >= MAX_HOOKS) throw new UserError(`Up to ${MAX_HOOKS} webhooks per server.`);
  const ch = await getChannelOption(i, 'channel', true);
  if (!ch?.isTextBased()) throw new UserError('Pick a text channel.');
  const token = crypto.randomBytes(24).toString('base64url');
  const id = ctx.data.update('hookCounter', (n) => n + 1, 0);
  ctx.data.set(`hook:${sha(token)}`, { id, name: truncate(i.options.getString('name', true), 60), channelId: ch.id, by: i.user.id });
  const base = (process.env.DASHBOARD_BASE_URL || `http://localhost:${process.env.DASHBOARD_PORT || 3000}`).replace(/\/$/, '');
  await i.reply({ content: `Webhook **#${id}** created. **Copy this now - it is never shown again:**\n\`${base}/hooks/${ctx.guildId}/${token}\`\nPOST JSON like \`{"title":"Hi","description":"Hello"}\` or \`{"content":"text"}\`.\n*This address only works from this computer unless you expose the dashboard port to the internet.*`, flags: EPH });
}

export default {
  name: 'integrations',
  version: '1.0.0',
  description: 'Follow RSS, YouTube, GitHub and Reddit feeds; Minecraft status; inbound webhooks. Add-ons can add more services.',
  api,
  settings: [{ key: 'pollMinutes', type: 'number', label: 'Check feeds every N minutes', default: 10, min: 5, max: 120 }],
  permissions: [
    { key: 'integrations.manage', label: 'Add feeds and webhooks', default: 'admin' },
    { key: 'integrations.use', label: 'Use status commands', default: 'everyone' },
  ],
  commands: [
    {
      permission: 'integrations.manage',
      data: new SlashCommandBuilder().setName('feed').setDescription('Follow feeds in a channel')
        .addSubcommand((s) => s.setName('add').setDescription('Follow something')
          .addStringOption((o) => o.setName('provider').setDescription('rss, youtube, github, reddit…').setRequired(true).setAutocomplete(true))
          .addStringOption((o) => o.setName('target').setDescription('URL, channel, owner/repo or r/subreddit').setRequired(true))
          .addChannelOption((o) => o.setName('channel').setDescription('Where to post').setRequired(true))
          .addStringOption((o) => o.setName('message').setDescription('Template: {title} {url} {author}').setMaxLength(300)))
        .addSubcommand((s) => s.setName('remove').setDescription('Stop following').addIntegerOption((o) => o.setName('id').setDescription('Feed number').setRequired(true)))
        .addSubcommand((s) => s.setName('list').setDescription('Show feeds'))
        .addSubcommand((s) => s.setName('check').setDescription('Check all feeds now')),
      execute: feedCmd,
      autocomplete: feedAutocomplete,
    },
    {
      permission: 'integrations.use',
      data: new SlashCommandBuilder().setName('minecraft').setDescription('Minecraft server status').addStringOption((o) => o.setName('address').setDescription('e.g. play.example.com').setRequired(true)),
      execute: minecraftCmd,
    },
    {
      permission: 'integrations.manage',
      data: new SlashCommandBuilder().setName('webhook').setDescription('Inbound webhooks that post into a channel')
        .addSubcommand((s) => s.setName('create').setDescription('Create a webhook URL')
          .addStringOption((o) => o.setName('name').setDescription('Label shown in the footer').setRequired(true).setMaxLength(60))
          .addChannelOption((o) => o.setName('channel').setDescription('Where it posts').setRequired(true)))
        .addSubcommand((s) => s.setName('list').setDescription('Show webhooks'))
        .addSubcommand((s) => s.setName('delete').setDescription('Delete a webhook').addIntegerOption((o) => o.setName('id').setDescription('Webhook number').setRequired(true))),
      execute: webhookCmd,
    },
  ],
  tasks: [{ name: 'poll-feeds', everyMs: 60000, run: pollTask }],
};
