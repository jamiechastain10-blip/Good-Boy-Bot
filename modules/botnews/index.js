/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Bot news (2.3): tells the server when the bot changes.
 *
 *   Admin channel (staff)          every update with its full notes, new modules that became available,
 *                                  and modules being turned on or off
 *   Announcements (everyone)       only what matters to members: the "for members" part of an update, and a short
 *                                  intro the first time a member-facing feature (games, economy...) is turned on
 *
 * Nothing is posted twice: the last announced version and the features already introduced are remembered per server.
 * Turning the module on for the first time posts nothing about the past; it starts from the current version.
 *
 * The member part of an update is the text between <!-- members --> and <!-- /members --> in that version's
 * CHANGELOG.md section (hidden on GitHub, shown here). A module's member intro is its `memberIntro` field (title: `memberIntroTitle`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SlashCommandBuilder, EmbedBuilder, ChannelType, MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { readChangelog, sectionForDiscord } from '../../src/about.js';
import { subscribe } from '../../src/live.js';
import { pingProblem, truncate } from '../../src/util.js';
import semver from 'semver';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EPH = MessageFlags.Ephemeral;
const RELEASES = 'https://github.com/jamiechastain10-blip/Good-Boy-Bot/releases';
const currentVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch { return null; } };

/** The members-only part of a changelog section, or null when it has none. */
export function memberNotes(body) {
  const m = /<!--\s*members\s*-->([\s\S]*?)<!--\s*\/members\s*-->/i.exec(String(body ?? ''));
  const text = m?.[1].trim();
  return text ? text : null;
}

/** Versions newer than `since` (oldest first), up to and including `current`. */
export function versionsBetween(sections, since, current) {
  return sections.filter((s) => semver.valid(s.version) && (!since || semver.gt(s.version, since)) && (!current || semver.lte(s.version, current)))
    .sort((a, b) => semver.compare(a.version, b.version));
}

// Open subscriptions to the live channel, per server, kept on a global so a hot reload replaces them cleanly.
const listeners = (globalThis[Symbol.for('goodboy.botnews.listeners')] ??= new Map());

function channel(ctx, key) {
  const ch = ctx.guild?.channels.cache.get(ctx.config.get(key));
  return ch?.isTextBased?.() ? ch : null;
}
async function post(ctx, key, payload) {
  const ch = channel(ctx, key);
  if (!ch) return false;
  return ctx.queue(() => ch.send({ allowedMentions: { parse: [] }, ...payload })).then(() => true).catch((e) => { ctx.log.warn(`Bot news could not post in #${ch.name}: ${e.message}`); return false; });
}
function pingFor(ctx) {
  const roleId = ctx.config.get('pingRole');
  const ch = channel(ctx, 'announceChannel');
  if (!roleId || !ch || pingProblem(ctx.guild, ch, 'role', [roleId], P)) return {};
  return { content: `<@&${roleId}>`, allowedMentions: { roles: [roleId] } };
}

/** Bot updated since the last time this server heard about it: full notes to admins, member notes to everyone. */
export async function announceUpdates(ctx, { version = currentVersion(), sections = readChangelog(root) } = {}) {
  if (!version) return 0;
  const last = ctx.data.get('lastVersion');
  if (!last) { ctx.data.set('lastVersion', version); return 0; } // first run: start from now, don't replay history
  if (!semver.valid(last) || !semver.gt(version, last)) return 0;
  const news = versionsBetween(sections, last, version);
  ctx.data.set('lastVersion', version); // before posting: a failed post must not repeat on every restart
  for (const s of news) {
    if (ctx.config.get('adminUpdates')) {
      await post(ctx, 'adminChannel', { embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`🆙 Good Boy updated to ${s.version}`).setURL(`${RELEASES}/tag/v${s.version}`)
        .setDescription(sectionForDiscord(s)).setFooter({ text: `Updated from ${last}` })] });
    }
    const members = memberNotes(s.body);
    if (members && ctx.config.get('communityUpdates')) {
      await post(ctx, 'announceChannel', { ...pingFor(ctx), embeds: [new EmbedBuilder().setColor(0xf2a93b).setTitle(`✨ What's new in Good Boy ${s.version}`).setDescription(truncate(members, 3800))] });
    }
  }
  if (news.length) ctx.live('activity', { icon: '🆙', text: `Good Boy was updated to ${version}` });
  return news.length;
}

/** Modules that exist now but did not last time: tell the admins they can turn them on. */
export async function announceNewModules(ctx, available) {
  const known = ctx.data.get('knownModules');
  ctx.data.set('knownModules', available.map((d) => d.name));
  if (!known || !ctx.config.get('adminModules')) return 0; // first run remembers what exists without posting
  const fresh = available.filter((d) => !known.includes(d.name));
  if (fresh.length) {
    await post(ctx, 'adminChannel', { embeds: [new EmbedBuilder().setColor(0x22c38e).setTitle(fresh.length === 1 ? '🧩 A new module is available' : `🧩 ${fresh.length} new modules are available`)
      .setDescription(fresh.map((d) => `**${d.name}** · ${d.description || 'no description'}`).join('\n')).setFooter({ text: 'Turn them on with /module or /modules.' })] });
  }
  return fresh.length;
}

/** A module was turned on or off in this server. */
export async function onModuleChange(ctx, { module, enabled }, def) {
  if (!module || module === 'botnews') return;
  if (ctx.config.get('adminModules')) {
    await post(ctx, 'adminChannel', { embeds: [new EmbedBuilder().setColor(enabled ? 0x22c38e : 0x8b97ab).setDescription(`${enabled ? '🟢' : '⬜'} **${module}** was turned ${enabled ? 'on' : 'off'}.`)] });
  }
  // Members hear about a feature once, the first time it is switched on, and only if it has something for them.
  if (enabled && def?.memberIntro && ctx.config.get('communityModules') && !ctx.data.get(`introduced:${module}`)) {
    ctx.data.set(`introduced:${module}`, Date.now());
    await post(ctx, 'announceChannel', { ...pingFor(ctx), embeds: [new EmbedBuilder().setColor(0xf2a93b).setTitle(`🎉 New: ${def.memberIntroTitle ?? module}`).setDescription(truncate(def.memberIntro, 3800))] });
  }
}

export default {
  name: 'botnews',
  version: '1.0.0',
  description: 'Posts bot updates and new modules: everything to the admin channel, member news to announcements',
  settings: [
    { key: 'adminChannel', type: 'channel', label: 'Admin channel (full update notes, modules on/off)' },
    { key: 'announceChannel', type: 'channel', label: 'Announcements channel (news for members only)' },
    { key: 'pingRole', type: 'role', label: 'Role to ping with member news (optional)' },
    { key: 'adminUpdates', type: 'toggle', label: 'Admin channel: post every update with its full notes', default: true },
    { key: 'adminModules', type: 'toggle', label: 'Admin channel: new modules and modules turned on/off', default: true },
    { key: 'communityUpdates', type: 'toggle', label: 'Announcements: what is new for members in each update', default: true },
    { key: 'communityModules', type: 'toggle', label: 'Announcements: introduce member features when first turned on', default: true },
  ],
  permissions: [{ key: 'botnews.manage', label: 'Set up bot news', default: 'admin' }],
  commands: [{
    permission: 'botnews.manage',
    data: new SlashCommandBuilder().setName('botnews').setDescription('Bot news: where updates and new modules are posted')
      .addSubcommand((s) => s.setName('setup').setDescription('Choose the admin channel and the announcements channel')
        .addChannelOption((o) => o.setName('admin_channel').setDescription('Staff channel: every update with full notes, module changes').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addChannelOption((o) => o.setName('announce_channel').setDescription('Everyone: only news for members').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addRoleOption((o) => o.setName('ping_role').setDescription('Role to ping with member news (optional)')))
      .addSubcommand((s) => s.setName('test').setDescription('Post a test message to both channels')),
    async execute(ctx, i) {
      const sub = i.options.getSubcommand();
      if (sub === 'test') {
        const a = await post(ctx, 'adminChannel', { content: '🧪 Bot news test: full updates and module changes will be posted here.' });
        const b = await post(ctx, 'announceChannel', { content: '🧪 Bot news test: news for members will be posted here.' });
        return i.reply({ content: `${a ? '✅' : '❌'} Admin channel · ${b ? '✅' : '❌'} Announcements${!a || !b ? '\nPick the channels with `/botnews setup`, and check I can post there.' : ''}`, flags: EPH });
      }
      // setup: the core turns these options into a popup (see src/autopopup.js) - here they arrive filled in.
      const admin = i.options.getChannel('admin_channel');
      const announce = i.options.getChannel('announce_channel');
      const role = i.options.getRole('ping_role');
      for (const ch of [admin, announce]) if (ch && ctx.guild?.channels.cache.get(ch.id)?.isTextBased?.() === false) return i.reply({ content: `<#${ch.id}> is not a text channel.`, flags: EPH, allowedMentions: { parse: [] } });
      if (admin) ctx.settings.set('adminChannel', admin.id);
      if (announce) ctx.settings.set('announceChannel', announce.id);
      if (role) ctx.settings.set('pingRole', role.id);
      return i.reply({ content: `✅ Admin channel: ${admin ? `<#${admin.id}>` : '*not set*'} · Announcements: ${announce ? `<#${announce.id}>` : '*not set*'}${role ? ` · pinging <@&${role.id}>` : ''}\nChoose what gets posted with \`/modules\` → botnews → Edit settings. Try it with \`/botnews test\`.`, flags: EPH, allowedMentions: { parse: [] } });
    },
  }],
  async init(ctx) {
    // Updates and new modules since the last start (quietly remembered on the very first start).
    listeners.get(ctx.guildId)?.();
    listeners.set(ctx.guildId, subscribe(ctx.guildId, (e) => {
      if (e.type !== 'modules') return;
      const def = ctx.moduleDef(e.data.module);
      onModuleChange(ctx, e.data, def).catch((err) => ctx.log.warn(`Bot news: ${err.message}`));
    }));
    await announceUpdates(ctx).catch((err) => ctx.log.warn(`Bot news: ${err.message}`));
    await announceNewModules(ctx, ctx.availableModules()).catch((err) => ctx.log.warn(`Bot news: ${err.message}`));
  },
  async destroy(ctx) { listeners.get(ctx.guildId)?.(); listeners.delete(ctx.guildId); },
};
