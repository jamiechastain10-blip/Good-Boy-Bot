/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * /channel (3.1.1): what Good Boy does in one channel. A private panel lists every module that is on, and dropdowns
 * pick the ones to keep quiet there. A module that is off in a channel ignores everything that happens there (no
 * critter spawns, coin drops, XP, counting, auto-replies...), and its commands don't work there (admins still can).
 * It is the same switch as the dashboard's "Where it works" tab. Moderation and tickets always work everywhere.
 */
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ChannelType } from 'discord.js';
import { UserError, truncate } from './util.js';

const EPH = 64;
const NO_PINGS = { parse: [] };
/** What switching a module off in a channel stops, in words, for the ones people ask about most. */
const STOPS = {
  critters: 'no wild critters appear', economy: 'no coin drops; /shop, /work and the rest don\'t work here', community: 'no XP and no level-up messages from here',
  games: 'no game commands here', counting: 'no counting or word chain', tags: 'no custom commands or auto-replies', utility: 'no highlights from here',
  fun: 'no /fun here', roleplay: 'no /rp here', music: 'no music player here', engagement: 'no polls or suggestions here', stats: 'messages here aren\'t counted',
  family: 'no /marry or /family here', giveaways: 'no giveaways started here', quotes: 'no quotes made here', achievements: 'nothing here counts towards achievements',
  deadchat: 'no dead-chat pings', clips: 'clips posted here are ignored', voice: 'no text-to-speech from here', partyfinder: 'no party posts here',
};
const pretty = (n) => n.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const switchable = (m, guildId) => m.describeForGuild(guildId).filter((d) => d.enabled && d.canSwitchOffHere).sort((a, b) => a.name.localeCompare(b.name));

/** Modules that are off where `channel` is: by the channel itself, or by its category. */
export function offHere(m, guildId, channel) {
  return switchable(m, guildId).map((d) => ({ name: d.name, direct: d.offChannels.includes(channel.id), viaCategory: !!channel.parentId && d.offChannels.includes(channel.parentId) }));
}

export function channelPanel(m, guildId, channel, note) {
  const rows = offHere(m, guildId, channel);
  const off = rows.filter((r) => r.direct || r.viaCategory);
  const kind = channel.type === ChannelType.GuildCategory ? 'category' : 'channel';
  const e = new EmbedBuilder().setColor(0x6b93ff).setTitle(`What Good Boy does in ${kind === 'category' ? '📁 ' : '#'}${truncate(channel.name ?? 'this channel', 80)}`)
    .setDescription([note,
      off.length ? `**Quiet here:**\n${off.map((r) => `🔕 **${pretty(r.name)}**${r.viaCategory && !r.direct ? ' (off for the whole category)' : ''}${STOPS[r.name] ? ` · ${STOPS[r.name]}` : ''}`).join('\n')}`
        : 'Every module works here.',
      `\nPick the modules to keep quiet in this ${kind} below. ${kind === 'category' ? 'It counts for every channel inside it.' : 'To do a whole category, run `/channel` with the category picked.'} Moderation, logs and tickets always work everywhere.`].filter(Boolean).join('\n'))
    .setFooter({ text: 'Admins can still use any command here. The same switch is on the dashboard (a module\'s "Where it works" tab).' });
  const groups = []; for (let k = 0; k < rows.length; k += 25) groups.push(rows.slice(k, k + 25));
  const components = groups.slice(0, 4).map((g, n) => new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`gbch:set:${channel.id}:${n}`).setPlaceholder(groups.length > 1 ? `Modules ${g[0].name[0].toUpperCase()}–${g.at(-1).name[0].toUpperCase()}: quiet in here…` : 'Modules to keep quiet in here…')
    .setMinValues(0).setMaxValues(g.length)
    .addOptions(g.map((r) => ({ label: pretty(r.name), value: r.name, description: truncate(STOPS[r.name] ?? 'switched off in this channel', 100), default: r.direct })))));
  components.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`gbch:all:${channel.id}`).setLabel('Everything on here').setEmoji('🔔').setStyle(ButtonStyle.Secondary).setDisabled(!rows.some((r) => r.direct))));
  return { embeds: [e], components, flags: EPH, allowedMentions: NO_PINGS };
}

const adminOnly = (i, m) => { if (!m.perms.isAdmin(i.member)) throw new UserError('Only server admins can change where modules work.'); };

export const channelCommand = {
  access: 'admin',
  data: new SlashCommandBuilder().setName('channel').setDescription('Choose which modules stay quiet in a channel (no pop-ups there)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) => o.setName('channel').setDescription('Which channel or category (this one if empty)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildCategory)),
  async execute(i, m) {
    adminOnly(i, m);
    const picked = i.options.getChannel?.('channel');
    const ch = (picked && i.guild?.channels.cache.get(picked.id)) ?? picked ?? i.channel;
    if (!ch?.id) throw new UserError('Pick a channel.');
    return i.reply(channelPanel(m, i.guildId, ch));
  },
  components: [{
    prefix: 'gbch:',
    async execute(i, m) {
      adminOnly(i, m);
      const [, what, chId, group] = i.customId.split(':');
      const ch = i.guild?.channels.cache.get(chId) ?? { id: chId, name: 'that channel' };
      const rows = offHere(m, i.guildId, ch);
      const groups = []; for (let k = 0; k < rows.length; k += 25) groups.push(rows.slice(k, k + 25));
      const inGroup = what === 'all' ? rows : groups[Number(group)] ?? [];
      const want = what === 'all' ? new Set() : new Set(i.values ?? []);
      const changed = [];
      for (const r of inGroup) {
        const shouldBeOff = want.has(r.name);
        if (shouldBeOff === r.direct) continue;
        const list = m.offIn(i.guildId, r.name);
        m.setOffIn(i.guildId, r.name, shouldBeOff ? [...list, chId] : list.filter((x) => x !== chId));
        changed.push(`${shouldBeOff ? '🔕' : '🔔'} ${pretty(r.name)}`);
      }
      if (changed.length) m.db.addLog(i.guildId, 'core', 'security', `${i.user.tag ?? i.user.username} changed what works in #${ch.name ?? chId}: ${changed.join(', ')}`);
      return i.update(channelPanel(m, i.guildId, ch, changed.length ? `✅ Saved: ${changed.join(', ')}` : 'Nothing changed.'));
    },
  }],
};
