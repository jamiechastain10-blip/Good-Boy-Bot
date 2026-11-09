/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * /art (3.1.1, bot owner only): put your own pictures and GIFs in place of Good Boy's built-in ones, for every server.
 *   /art add      a popup: what to replace (roleplay action or critter), its name, and the picture or GIF to upload
 *                 (roleplay actions can have many, picked at random)
 *   /art remove   a popup: what to put back to the built-in look
 *   /art list     what you have replaced
 * Or copy files into data/art/<kind>/<name>/ on the computer running the bot (see docs/CUSTOM-ART.md).
 */
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { UserError, truncate } from './util.js';
import { formModal, readForm } from './modalkit.js';
import * as ART from './customart.js';

const EPH = 64;
// No typed options: like every Good Boy command, it asks in a popup (with a file upload for the picture).
const fields = (adding) => [
  { id: 'kind', kind: 'select', label: 'What to replace', value: 'rp', options: Object.entries(ART.KINDS).map(([value, k]) => ({ label: k.label, value, description: k.help })) },
  { id: 'name', label: 'Which one', max: 40, placeholder: 'e.g. hug, or emberpup, or emberpup-sparkly (see /art list)' },
  ...(adding ? [{ id: 'file', kind: 'files', label: 'Your picture or GIF', desc: 'PNG, JPG, GIF or WEBP, up to 8 MB.', maxValues: 1 }] : []),
];

export const artCommand = {
  // Bot owner only (checked in execute), from any server, even one where they aren't an admin.
  data: new SlashCommandBuilder().setName('art').setDescription('(Bot owner) Use your own pictures and GIFs for roleplay and critters')
    .addSubcommand((s) => s.setName('add').setDescription('Add your own picture or GIF (opens a form)'))
    .addSubcommand((s) => s.setName('remove').setDescription('Go back to the built-in look (opens a form)'))
    .addSubcommand((s) => s.setName('list').setDescription('What you have replaced, and every name you can use')),
  components: [{
    prefix: 'gbart:',
    async execute(i, m) {
      if (!m.isBotOwner(i.user.id)) throw new UserError('Only the person who runs this bot can change its art.');
      const adding = i.customId === 'gbart:add';
      const v = readForm(i, fields(adding));
      const kind = v.kind ?? 'rp', name = String(v.name ?? '').trim().toLowerCase();
      if (!ART.KINDS[kind]?.names().includes(name)) throw new UserError(`"${truncate(name, 40)}" isn't a ${ART.KINDS[kind]?.label.toLowerCase() ?? 'name'} I know. \`/art list\` shows every name.`);
      if (!adding) {
        const n = ART.clearArt(kind, name);
        return i.reply({ content: n ? `Removed ${n} picture${n === 1 ? '' : 's'}. **${name}** uses the built-in look again.` : `**${name}** already uses the built-in look.`, flags: EPH });
      }
      const att = v.file?.[0];
      if (!att?.url) throw new UserError('Add the picture or GIF in the form.');
      if (att.size > ART.MAX_BYTES) throw new UserError('That file is over 8 MB.');
      await i.deferReply({ flags: EPH });
      const r = await fetch(att.url, { signal: AbortSignal.timeout(20000) }).catch(() => null);
      if (!r?.ok) throw new UserError("I couldn't download that file from Discord. Try again.");
      try { ART.saveArt(kind, name, Buffer.from(await r.arrayBuffer())); } catch (e) { throw new UserError(e.message); }
      const count = ART.listArt(kind, name).length;
      return i.editReply({ content: `🎨 Saved! **${name}** now uses your art${count > 1 ? ` (${count} pictures, one picked at random each time)` : ''}, in every server.` });
    },
  }],
  async execute(i, m) {
    if (!m.isBotOwner(i.user.id)) throw new UserError('Only the person who runs this bot can change its art.');
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
      const parts = Object.entries(ART.KINDS).flatMap(([kind, k]) => { const s = ART.summary(kind); return [
        { name: `Your ${k.label.toLowerCase()} art (${s.length})`, value: truncate(s.map((x) => `\`${x.name}\`${x.count > 1 ? ` ×${x.count}` : ''}`).join(', ') || 'None yet: all built-in.', 1000) },
        { name: `${k.label} names you can use`, value: truncate(k.names().filter((n) => !n.endsWith('-sparkly')).join(', ') + (kind === 'critters' ? '\n-# Add -sparkly to a name for its Sparkly version (emberpup-sparkly).' : ''), 1000) }]; });
      const e = new EmbedBuilder().setColor(0x6b93ff).setTitle('🎨 Your art').addFields(parts)
        .setFooter({ text: `Files are in ${truncate(ART.artRoot(), 120)}. You can also copy pictures into those folders.` });
      return i.reply({ embeds: [e], flags: EPH });
    }
    return i.showModal(formModal(sub === 'add' ? 'gbart:add' : 'gbart:remove', sub === 'add' ? 'Use your own art' : 'Back to the built-in look', fields(sub === 'add')));
  },
};
