/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Handy extras (3.1):
 *   Highlights  /highlight add|remove|list|clear: get a DM when someone says one of your words, with a jump link.
 *               Not when you wrote it, can't see the channel, or were just chatting there; at most one DM per
 *               channel every 5 minutes. Needs the Message Content intent.
 *   Translate   right-click a message > Apps > Translate: the message in your Discord language, only you see it.
 *               Uses Google Translate's free public endpoint (the same kind the TTS uses); it can be slow or change.
 */
import { SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType, EmbedBuilder, MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { UserError, truncate, escapeRegex } from '../../src/util.js';

const EPH = MessageFlags.Ephemeral;
const MAX_WORDS = 20, COOLDOWN = 5 * 60000, ACTIVE = 5 * 60000;
const lastSaid = (globalThis[Symbol.for('goodboy.utility.lastSaid')] ??= new Map()); // `${guild}:${channel}:${user}` -> time
const lastPing = (globalThis[Symbol.for('goodboy.utility.lastPing')] ??= new Map()); // `${guild}:${channel}:${user}` -> time

/** Which of the words appear in the text as whole words (case-insensitive). Exported for tests. */
export function matches(text, words) {
  const t = String(text ?? '');
  return words.filter((w) => w && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(w)}($|[^\\p{L}\\p{N}])`, 'iu').test(t));
}
const wordsOf = (ctx, userId) => ctx.data.get(`hl:${userId}`) ?? [];

async function highlightCommand(ctx, i) {
  const sub = i.options.getSubcommand();
  const words = wordsOf(ctx, i.user.id);
  if (sub === 'list') return i.reply({ content: words.length ? `Your highlight words here: ${words.map((w) => `\`${w}\``).join(', ')}` : 'You have no highlight words here. Add one with `/highlight add`.', flags: EPH });
  if (sub === 'clear') { ctx.data.delete(`hl:${i.user.id}`); return i.reply({ content: 'Cleared your highlight words.', flags: EPH }); }
  const word = String(i.options.getString('word') ?? '').trim().toLowerCase().slice(0, 50);
  if (word.length < 2) throw new UserError('Use at least 2 characters.');
  if (sub === 'add') {
    if (words.includes(word)) throw new UserError('You already have that word.');
    if (words.length >= MAX_WORDS) throw new UserError(`You can have up to ${MAX_WORDS} words.`);
    ctx.data.set(`hl:${i.user.id}`, [...words, word]);
    return i.reply({ content: `🔔 I'll DM you when someone says **${word}** here.${ctx.hasIntent?.('MessageContent') === false ? '\n⚠️ The bot can\'t read messages yet (Message Content is off in the Developer Portal), so highlights won\'t fire until it\'s on.' : ''}`, flags: EPH });
  }
  if (sub === 'remove') {
    if (!words.includes(word)) throw new UserError("You don't have that word.");
    ctx.data.set(`hl:${i.user.id}`, words.filter((w) => w !== word));
    return i.reply({ content: `Removed **${word}**.`, flags: EPH });
  }
  throw new UserError('Unknown option.');
}

async function onMessage(ctx, message) {
  if (message.author?.bot || !message.guild || !message.content) return;
  const now = Date.now();
  lastSaid.set(`${ctx.guildId}:${message.channelId}:${message.author.id}`, now);
  if (!ctx.config.get('highlights')) return;
  for (const { key, value: words } of ctx.data.list('hl:')) {
    const userId = key.slice(3);
    if (userId === message.author.id || !Array.isArray(words) || !words.length) continue;
    const hit = matches(message.content, words);
    if (!hit.length) continue;
    const k = `${ctx.guildId}:${message.channelId}:${userId}`;
    if (now - (lastSaid.get(k) ?? 0) < ACTIVE || now - (lastPing.get(k) ?? 0) < COOLDOWN) continue;
    const member = message.guild.members.cache.get(userId) ?? await message.guild.members.fetch(userId).catch(() => null);
    if (!member || !message.channel.permissionsFor?.(member)?.has?.(P.ViewChannel)) continue;
    lastPing.set(k, now);
    const e = new EmbedBuilder().setColor(0xf2b33d).setTitle(`🔔 "${hit[0]}" was mentioned in #${message.channel.name ?? 'a channel'}`)
      .setDescription(`**${message.member?.displayName ?? message.author.username}:** ${truncate(message.content, 1500)}\n\n[Jump to the message](${message.url})`)
      .setFooter({ text: `${message.guild.name} · /highlight to change your words` }).setTimestamp();
    await member.send({ embeds: [e] }).catch(() => {});
  }
}

/** Translates text with Google's free endpoint. Returns { text, from } or throws a plain message. */
export async function translate(text, to, { fetchFn = globalThis.fetch } = {}) {
  const u = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(String(text).slice(0, 1800))}`;
  const r = await fetchFn(u, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r?.ok) throw new UserError('Translation is not answering right now. Try again in a minute.');
  const d = await r.json().catch(() => null);
  const out = (d?.[0] ?? []).map((x) => x?.[0] ?? '').join('');
  if (!out) throw new UserError("Couldn't translate that.");
  return { text: out, from: d?.[2] ?? null };
}
async function translateMenu(ctx, i) {
  const m = i.targetMessage;
  const text = [m?.content, ...(m?.embeds ?? []).map((e) => [e.title, e.description].filter(Boolean).join('\n'))].filter(Boolean).join('\n');
  if (!text.trim()) throw new UserError('That message has no text to translate.');
  const to = String(i.locale ?? 'en').split('-')[0] || 'en';
  const r = await translate(text, to);
  const e = new EmbedBuilder().setColor(0x6b93ff).setTitle(`🌐 Translated${r.from ? ` from ${r.from}` : ''} to ${to}`).setDescription(truncate(r.text, 4000)).setFooter({ text: 'Google Translate · only you can see this' });
  return i.reply({ embeds: [e], flags: EPH });
}

export default {
  name: 'utility',
  version: '1.0.0',
  description: 'Highlights (a DM when someone says your word) and Translate on any message',
  settings: [{ key: 'highlights', type: 'toggle', label: 'Highlights on (members get a DM when someone says their words)', default: true }],
  permissions: [{ key: 'utility.use', label: 'Use highlights and Translate', default: 'everyone' }],
  commands: [
    {
      permission: 'utility.use',
      data: new SlashCommandBuilder().setName('highlight').setDescription('Get a DM when someone says your words')
        .addSubcommand((s) => s.setName('add').setDescription('Add a word').addStringOption((o) => o.setName('word').setDescription('The word or phrase').setRequired(true).setMaxLength(50)))
        .addSubcommand((s) => s.setName('remove').setDescription('Remove a word').addStringOption((o) => o.setName('word').setDescription('The word or phrase').setRequired(true).setMaxLength(50)))
        .addSubcommand((s) => s.setName('list').setDescription('Your words here'))
        .addSubcommand((s) => s.setName('clear').setDescription('Remove all your words here')),
      execute: highlightCommand,
    },
    { permission: 'utility.use', data: new ContextMenuCommandBuilder().setName('Translate').setType(ApplicationCommandType.Message), execute: translateMenu },
  ],
  events: { messageCreate: onMessage },
};
