/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Roleplay actions (3.1): /rp action:hug member:@someone, with an animated GIF, a "hug back" button and a count of
 * how many times one member did it to another. Twenty actions in one command (Discord allows 100 commands per server,
 * so they share one). GIFs come from Good Boy's own drawn set (src/rpart.js); if the bot owner adds a free Tenor key,
 * real GIFs from Tenor are used instead (safe-search on), falling back to Good Boy's own when Tenor doesn't answer.
 */
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { UserError } from '../../src/util.js';
import { ACTIONS, rpGif } from '../../src/rpart.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const SETUP = 'tenor-setup';
const tenorKey = (ctx) => process.env.TENOR_API_KEY || ctx.botData?.get('tenorKey') || null;

/** A random safe GIF from Tenor for the action, or null. fetchFn is for tests. */
export async function tenorGif(key, action, { fetchFn = globalThis.fetch } = {}) {
  if (!key) return null;
  const q = encodeURIComponent(`anime ${action === 'handhold' ? 'hold hands' : action === 'highfive' ? 'high five' : action}`);
  try {
    const r = await fetchFn(`https://tenor.googleapis.com/v2/search?q=${q}&key=${encodeURIComponent(key)}&client_key=goodboy&limit=24&media_filter=gif&contentfilter=medium`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const list = ((await r.json()).results ?? []).map((x) => x.media_formats?.gif?.url).filter((u) => /^https:\/\/media\d*\.tenor\.com\//.test(u ?? ''));
    return list.length ? list[Math.floor(Math.random() * list.length)] : null;
  } catch { return null; }
}

function bump(ctx, from, to, action) {
  ctx.sql.run(`INSERT INTO roleplay_counts (guild_id, from_id, to_id, action, n) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT (guild_id, from_id, to_id, action) DO UPDATE SET n = n + 1`, ctx.guildId, from, to ?? '', action);
  return ctx.sql.get('SELECT n FROM roleplay_counts WHERE guild_id = ? AND from_id = ? AND to_id = ? AND action = ?', ctx.guildId, from, to ?? '', action).n;
}
const times = (n) => (n === 1 ? 'for the first time' : `${n} times now`);

/** Builds and sends one action. from/to are user ids; to may be null for solo actions. */
async function perform(ctx, i, action, fromId, toId, { update = false } = {}) {
  const A = ACTIONS[action];
  if (!A) throw new UserError('Pick an action from the list.');
  if (!A.solo && !toId) throw new UserError(`Pick who to ${action === 'handhold' ? 'hold hands with' : action}.`);
  if (toId === fromId && !A.solo) throw new UserError(`You can't ${action} yourself. Try someone else!`);
  const n = bump(ctx, fromId, toId, action);
  const line = A.solo
    ? (toId ? `<@${fromId}> ${A.verb} <@${toId}>` : `<@${fromId}> ${A.verb}`)
    : `<@${fromId}> ${A.verb} <@${toId}>`;
  const e = new EmbedBuilder().setColor(0xff8fb3).setDescription(`${A.emoji} ${line}!`).setFooter({ text: toId && !A.solo ? `That's ${times(n)}.` : n > 1 ? `${n} times so far.` : 'First time!' });
  const files = [];
  const tenor = ctx.config.get('useTenor') !== false ? await tenorGif(tenorKey(ctx), action) : null;
  if (tenor) e.setImage(tenor).setFooter({ text: `${e.data.footer.text} · via Tenor` });
  else if (ctx.config.get('pictures') !== false) { const art = await rpGif(action); if (art) { e.setImage(`attachment://${art.name}`); files.push({ attachment: art.file, name: art.name }); } }
  const back = toId && !A.solo && toId !== ctx.client?.user?.id
    ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`rp:back:${action}:${fromId}:${toId}`).setLabel(`${action === 'highfive' ? 'High-five' : action[0].toUpperCase() + action.slice(1)} back`).setEmoji(A.emoji).setStyle(ButtonStyle.Secondary))]
    : [];
  const msg = { embeds: [e], files, components: back, allowedMentions: ctx.config.get('pingTarget') && toId ? { users: [toId] } : NOPING };
  if (update) return i.reply(msg); // "do it back" posts a new message so both stay in the chat
  return i.reply(msg);
}

async function rpCommand(ctx, i) {
  const action = i.options.getString('action');
  if (action === SETUP) {
    if (!ctx.isBotOwner?.(i.user.id)) throw new UserError('Only the person who runs this bot can set up Tenor.');
    const m = new ModalBuilder().setCustomId('rp:tenor').setTitle('Tenor GIFs (optional)').addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('key').setLabel('Tenor API key (empty to switch Tenor off)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100).setPlaceholder('From developers.google.com/tenor')));
    return i.showModal(m);
  }
  const member = i.options.getUser('member');
  if (member?.bot && member.id !== ctx.client?.user?.id) throw new UserError('Pick a member, not a bot.');
  return perform(ctx, i, action, i.user.id, member?.id ?? null);
}

async function onComponent(ctx, i) {
  const [, kind, action, fromId, toId] = i.customId.split(':');
  if (kind === 'tenor') {
    if (!ctx.isBotOwner?.(i.user.id)) throw new UserError('Only the person who runs this bot can set up Tenor.');
    const key = String(i.fields.getTextInputValue('key') ?? '').trim();
    if (key && !/^[A-Za-z0-9_-]{20,100}$/.test(key)) throw new UserError("That doesn't look like a Tenor API key.");
    if (key && !(await tenorGif(key, 'hug'))) throw new UserError("Tenor didn't accept that key. Check it at developers.google.com/tenor and try again.");
    ctx.botData.set('tenorKey', key || null);
    return i.reply({ content: key ? '✅ Tenor is on: roleplay actions use Tenor GIFs in every server (Good Boy\'s own animations when Tenor doesn\'t answer).' : 'Tenor is off. Roleplay actions use Good Boy\'s own animations.', flags: EPH });
  }
  if (kind === 'back') {
    if (i.user.id !== toId) throw new UserError(`Only <@${toId}> can do that back.`);
    return perform(ctx, i, action, toId, fromId, { update: true });
  }
  throw new UserError('Unknown button.');
}

const CHOICES = Object.keys(ACTIONS).map((k) => ({ name: `${ACTIONS[k].emoji} ${k === 'handhold' ? 'hold hands' : k === 'highfive' ? 'high five' : k}`, value: k }));

export default {
  name: 'roleplay',
  version: '1.0.0',
  description: 'Hug, pat, boop, bonk and more, with animated GIFs and counts',
  memberIntroTitle: 'roleplay actions',
  memberIntro: 'you can hug, pat, boop and bonk each other now 🤗 use /rp, pick an action and a member. they can hit the button to do it back',
  settings: [
    { key: 'pictures', type: 'toggle', label: "Show Good Boy's own animations", default: true },
    { key: 'useTenor', type: 'toggle', label: 'Use Tenor GIFs when the bot owner has set them up', default: true },
    { key: 'pingTarget', type: 'toggle', label: 'Ping the member who receives the action', default: false },
  ],
  permissions: [{ key: 'roleplay.use', label: 'Use roleplay actions', default: 'everyone' }],
  migrations: [{ id: 1, sql: 'CREATE TABLE IF NOT EXISTS roleplay_counts (guild_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, action TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, from_id, to_id, action));' }],
  commands: [{
    permission: 'roleplay.use', defer: 'public',
    data: new SlashCommandBuilder().setName('rp').setDescription('Hug, pat, boop and more')
      .addStringOption((o) => o.setName('action').setDescription('What to do').setRequired(true).addChoices(...CHOICES, { name: '⚙️ Tenor GIFs (bot owner)', value: SETUP }))
      .addUserOption((o) => o.setName('member').setDescription('Who to do it to')),
    execute: rpCommand,
  }],
  components: [{ prefix: 'rp:', execute: onComponent }],
};
