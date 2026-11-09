/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Fun (3.1): small things people ask a bot for, in one command so it costs one of Discord's 100 slots.
 *   /fun 8ball question:...   the magic 8-ball
 *   /fun dice [count] [sides] roll some dice (1-10 dice, 2-1000 sides)
 *   /fun ship a:@ b:@          how well two people match (always the same answer for the same two)
 *   /fun topic                 something to talk about
 */
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { truncate, progressBar } from '../../src/util.js';
import { EIGHT_BALL, TOPICS, shipPercent, shipName, rollDice } from '../../src/minigames.js';

const NOPING = { parse: [] };
const pick = (list) => list[Math.floor(Math.random() * list.length)];
export const shipVerdict = (p) => (p >= 90 ? 'A perfect match! 💞' : p >= 70 ? 'Made for each other 💕' : p >= 50 ? 'There\'s something there 💗' : p >= 30 ? 'Could be friends first 🤝' : p >= 10 ? 'Not looking great 😬' : 'Never going to happen 💔');

async function funCommand(ctx, i) {
  const sub = i.options.getSubcommand();
  if (sub === '8ball') {
    const q = i.options.getString('question', true);
    const e = new EmbedBuilder().setColor(0x2b2d31).setTitle('🎱 Magic 8-ball').addFields({ name: 'You asked', value: truncate(q, 1000) }, { name: 'The 8-ball says', value: `**${pick(EIGHT_BALL)}**` });
    return i.reply({ embeds: [e], allowedMentions: NOPING });
  }
  if (sub === 'dice') {
    const count = i.options.getInteger('count') ?? 1, sides = i.options.getInteger('sides') ?? 6;
    const rolls = rollDice(count, sides);
    const total = rolls.reduce((a, b) => a + b, 0);
    return i.reply({ content: `🎲 ${count}d${sides}: ${rolls.map((r) => `**${r}**`).join(' + ')}${count > 1 ? ` = **${total}**` : ''}`, allowedMentions: NOPING });
  }
  if (sub === 'ship') {
    const a = i.options.getUser('a', true), b = i.options.getUser('b') ?? i.user;
    const nameA = i.guild?.members.cache.get(a.id)?.displayName ?? a.username, nameB = i.guild?.members.cache.get(b.id)?.displayName ?? b.username;
    const p = a.id === b.id ? 100 : shipPercent(a.id, b.id);
    const e = new EmbedBuilder().setColor(0xff6b9a).setTitle(`💘 ${truncate(nameA, 40)} × ${truncate(nameB, 40)}`)
      .setDescription(`Ship name: **${truncate(shipName(nameA, nameB), 60)}**\n${progressBar(p, 100, 14)} **${p}%**\n${a.id === b.id ? 'Self-love is important 💖' : shipVerdict(p)}`);
    return i.reply({ embeds: [e], allowedMentions: NOPING });
  }
  return i.reply({ content: `💬 **Topic:** ${pick(TOPICS)}`, allowedMentions: NOPING });
}

export default {
  name: 'fun',
  version: '1.0.0',
  description: 'Magic 8-ball, dice, ship two members, and conversation topics',
  memberIntroTitle: 'fun commands',
  memberIntro: 'there\'s /fun now: ask the magic 8-ball, roll dice, ship two people, or get a topic when chat is quiet',
  permissions: [{ key: 'fun.use', label: 'Use /fun', default: 'everyone' }],
  commands: [{
    permission: 'fun.use',
    data: new SlashCommandBuilder().setName('fun').setDescription('8-ball, dice, ship and topics')
      .addSubcommand((s) => s.setName('8ball').setDescription('Ask the magic 8-ball').addStringOption((o) => o.setName('question').setDescription('A yes-or-no question').setRequired(true).setMaxLength(300)))
      .addSubcommand((s) => s.setName('dice').setDescription('Roll dice').addIntegerOption((o) => o.setName('count').setDescription('How many (1-10)').setMinValue(1).setMaxValue(10))
        .addIntegerOption((o) => o.setName('sides').setDescription('Sides on each (2-1000, default 6)').setMinValue(2).setMaxValue(1000)))
      .addSubcommand((s) => s.setName('ship').setDescription('How well two people match').addUserOption((o) => o.setName('a').setDescription('Someone').setRequired(true)).addUserOption((o) => o.setName('b').setDescription('Someone else (you if empty)')))
      .addSubcommand((s) => s.setName('topic').setDescription('Something to talk about')),
    execute: funCommand,
  }],
};
