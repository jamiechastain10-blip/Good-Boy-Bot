/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Server backup (3.1): a snapshot of the server's roles, categories, channels and channel permissions, kept in the
 * bot's database (the last 10), and an optional automatic weekly one.
 *   /backup create        take one now
 *   /backup list          the saved ones
 *   /backup restore id    shows what is missing compared to that backup, then (after you confirm) puts back only what's
 *                         missing: it never deletes or changes anything that is still there
 *   /backup download id   the backup as a file
 * Messages and members are not backed up (Discord doesn't let bots restore those). Restoring needs Administrator.
 */
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits as P, ChannelType } from 'discord.js';
import { UserError, truncate } from '../../src/util.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
export const KEEP = 10;
const KINDS = [ChannelType.GuildCategory, ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum];

/** A plain copy of the server's layout. Exported for tests. Permission overwrites keep role names (ids change on restore). */
export function snapshot(guild) {
  const everyone = guild.id;
  const roles = [...guild.roles.cache.values()].filter((r) => r.id !== everyone && !r.managed).sort((a, b) => b.position - a.position)
    .map((r) => ({ name: r.name, color: r.color ?? 0, hoist: !!r.hoist, mentionable: !!r.mentionable, permissions: String(r.permissions?.bitfield ?? 0n), position: r.position }));
  const roleName = (id) => (id === everyone ? '@everyone' : guild.roles.cache.get(id)?.name ?? null);
  const overwrites = (c) => [...(c.permissionOverwrites?.cache?.values?.() ?? [])].filter((o) => o.type === 0 && roleName(o.id))
    .map((o) => ({ role: roleName(o.id), allow: String(o.allow?.bitfield ?? 0n), deny: String(o.deny?.bitfield ?? 0n) }));
  const channels = [...guild.channels.cache.values()].filter((c) => KINDS.includes(c.type)).sort((a, b) => (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0))
    .map((c) => ({ name: c.name, type: c.type, parent: c.parentId ? guild.channels.cache.get(c.parentId)?.name ?? null : null, position: c.rawPosition ?? c.position ?? 0,
      topic: c.topic ?? null, nsfw: !!c.nsfw, slowmode: c.rateLimitPerUser ?? 0, bitrate: c.bitrate ?? null, userLimit: c.userLimit ?? null, overwrites: overwrites(c) }));
  const ev = guild.roles.cache.get(everyone);
  return { version: 1, guildName: guild.name, at: Date.now(), everyone: String(ev?.permissions?.bitfield ?? 0n), roles, channels };
}
/** What restoring would add: roles and channels in the backup that the server doesn't have (matched by name and kind). */
export function plan(data, guild) {
  const haveRoles = new Set([...guild.roles.cache.values()].map((r) => r.name));
  const key = (name, type, parent) => `${type}|${name}|${parent ?? ''}`;
  const haveCh = new Set([...guild.channels.cache.values()].map((c) => key(c.name, c.type, c.parentId ? guild.channels.cache.get(c.parentId)?.name : null)));
  return {
    roles: data.roles.filter((r) => !haveRoles.has(r.name)),
    channels: data.channels.filter((c) => !haveCh.has(key(c.name, c.type, c.parent))),
  };
}
/** Puts back what plan() found. Categories first, so channels can go inside them. Returns { roles, channels, failed }. */
export async function restore(guild, data, todo, reason = 'Restoring a Good Boy backup') {
  const out = { roles: 0, channels: 0, failed: [] };
  for (const r of [...todo.roles].reverse()) { // lowest first, so the order ends up close to the original
    try { await guild.roles.create({ name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: BigInt(r.permissions), reason }); out.roles++; }
    catch (e) { out.failed.push(`role ${r.name}: ${e.message}`); }
  }
  const roleId = (name) => (name === '@everyone' ? guild.id : [...guild.roles.cache.values()].find((r) => r.name === name)?.id ?? null);
  const ows = (c) => c.overwrites.map((o) => ({ id: roleId(o.role), allow: BigInt(o.allow), deny: BigInt(o.deny) })).filter((o) => o.id);
  const ordered = [...todo.channels.filter((c) => c.type === ChannelType.GuildCategory), ...todo.channels.filter((c) => c.type !== ChannelType.GuildCategory)];
  for (const c of ordered) {
    const parent = c.parent ? [...guild.channels.cache.values()].find((x) => x.type === ChannelType.GuildCategory && x.name === c.parent)?.id ?? null : null;
    try {
      await guild.channels.create({ name: c.name, type: c.type, parent, topic: c.topic ?? undefined, nsfw: c.nsfw, rateLimitPerUser: c.slowmode || undefined,
        bitrate: c.bitrate ?? undefined, userLimit: c.userLimit ?? undefined, permissionOverwrites: ows(c), reason });
      out.channels++;
    } catch (e) { out.failed.push(`#${c.name}: ${e.message}`); }
  }
  return out;
}

function save(ctx, data, by) {
  const json = JSON.stringify(data);
  const r = ctx.sql.run('INSERT INTO backup_snapshots (guild_id, created_at, by, data, roles, channels, size) VALUES (?, ?, ?, ?, ?, ?, ?)', ctx.guildId, data.at, by, json, data.roles.length, data.channels.length, json.length);
  const old = ctx.sql.all('SELECT id FROM backup_snapshots WHERE guild_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?', ctx.guildId, KEEP);
  for (const o of old) ctx.sql.run('DELETE FROM backup_snapshots WHERE id = ?', o.id);
  return Number(r.lastInsertRowid);
}
const load = (ctx, id) => { const r = ctx.sql.get('SELECT * FROM backup_snapshots WHERE guild_id = ? AND id = ?', ctx.guildId, id); if (!r) throw new UserError(`There's no backup #${id}. See \`/backup list\`.`); return { ...r, data: JSON.parse(r.data) }; };
const stamp = (ms) => `<t:${Math.floor(ms / 1000)}:f>`;

async function backupCommand(ctx, i) {
  const sub = i.options.getSubcommand();
  if (sub === 'create') {
    const id = save(ctx, snapshot(i.guild), i.user.id);
    const b = load(ctx, id);
    return i.reply({ content: `💾 Backup **#${id}** saved: ${b.roles} roles and ${b.channels} channels and categories, with their permissions. The last ${KEEP} are kept.`, flags: EPH });
  }
  if (sub === 'list') {
    const rows = ctx.sql.all('SELECT id, created_at, by, roles, channels FROM backup_snapshots WHERE guild_id = ? ORDER BY id DESC', ctx.guildId);
    const e = new EmbedBuilder().setColor(0x6b93ff).setTitle('💾 Backups')
      .setDescription(rows.map((r) => `**#${r.id}** · ${stamp(r.created_at)} · ${r.roles} roles, ${r.channels} channels · ${r.by === 'auto' ? 'automatic' : `by <@${r.by}>`}`).join('\n') || 'No backups yet. Make one with `/backup create`.');
    return i.reply({ embeds: [e], flags: EPH, allowedMentions: NOPING });
  }
  const b = load(ctx, i.options.getInteger('id', true));
  if (sub === 'download') return i.reply({ content: `Backup #${b.id} (${stamp(b.created_at)}).`, files: [{ attachment: Buffer.from(JSON.stringify(b.data, null, 1)), name: `good-boy-backup-${b.id}.json` }], flags: EPH });
  // restore: preview first
  if (!i.memberPermissions?.has?.(P.Administrator)) throw new UserError('Restoring a backup needs the Administrator permission in Discord.');
  const todo = plan(b.data, i.guild);
  if (!todo.roles.length && !todo.channels.length) return i.reply({ content: `✅ Nothing is missing compared to backup #${b.id}.`, flags: EPH });
  const e = new EmbedBuilder().setColor(0xf1c40f).setTitle(`Restore backup #${b.id}?`)
    .setDescription(`These are in the backup but not in the server, so they would be added back. **Nothing is deleted or changed.**`)
    .addFields(
      { name: `Roles (${todo.roles.length})`, value: truncate(todo.roles.map((r) => r.name).join(', ') || 'none', 1000) },
      { name: `Channels (${todo.channels.length})`, value: truncate(todo.channels.map((c) => `${c.type === 4 ? '📁' : '#'}${c.name}`).join(', ') || 'none', 1000) });
  return i.reply({ embeds: [e], flags: EPH, components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`backup:go:${b.id}:${i.user.id}`).setLabel('Put them back').setEmoji('♻️').setStyle(ButtonStyle.Danger))] });
}
async function onButton(ctx, i) {
  const [, , id, owner] = i.customId.split(':');
  if (i.user.id !== owner) throw new UserError('Only the person who asked can confirm.');
  if (!i.memberPermissions?.has?.(P.Administrator)) throw new UserError('Restoring a backup needs the Administrator permission in Discord.');
  const b = load(ctx, Number(id));
  await i.update({ content: '♻️ Restoring…', embeds: [], components: [] });
  const res = await restore(i.guild, b.data, plan(b.data, i.guild), `Backup #${b.id} restored by ${i.user.username}`);
  ctx.security?.(`${i.user.username} restored backup #${b.id} (${res.roles} roles, ${res.channels} channels)`);
  return i.editReply({ content: `✅ Added back ${res.roles} role${res.roles === 1 ? '' : 's'} and ${res.channels} channel${res.channels === 1 ? '' : 's'}.${res.failed.length ? `\n⚠️ Couldn't add ${res.failed.length}: ${truncate(res.failed.join('; '), 800)}\n-# My role must be above roles I create, and I need Manage Roles and Manage Channels.` : ''}` });
}

export default {
  name: 'backup',
  version: '1.0.0',
  description: 'Save the server\'s roles, channels and permissions, and put back anything that goes missing',
  settings: [{ key: 'weekly', type: 'toggle', label: 'Make a backup automatically once a week', default: true }],
  permissions: [{ key: 'backup.manage', label: 'Make, list and download backups (restoring also needs Administrator)', default: 'admin' }],
  migrations: [{ id: 1, sql: `CREATE TABLE IF NOT EXISTS backup_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, created_at INTEGER NOT NULL, by TEXT, data TEXT NOT NULL,
    roles INTEGER NOT NULL DEFAULT 0, channels INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS backup_snapshots_guild ON backup_snapshots (guild_id, id);` }],
  commands: [{
    permission: 'backup.manage',
    data: new SlashCommandBuilder().setName('backup').setDescription('Server backups: roles, channels and permissions')
      .addSubcommand((s) => s.setName('create').setDescription('Make a backup now'))
      .addSubcommand((s) => s.setName('list').setDescription('The saved backups'))
      .addSubcommand((s) => s.setName('restore').setDescription('Put back what is missing (shows you first)').addIntegerOption((o) => o.setName('id').setDescription('Backup number').setRequired(true).setMinValue(1)))
      .addSubcommand((s) => s.setName('download').setDescription('Get a backup as a file').addIntegerOption((o) => o.setName('id').setDescription('Backup number').setRequired(true).setMinValue(1))),
    execute: backupCommand,
  }],
  components: [{ prefix: 'backup:', execute: onButton }],
  tasks: [{ name: 'weekly', everyMs: 6 * 3600000, run: async (ctx) => {
    if (!ctx.config.get('weekly') || !ctx.guild) return;
    const last = ctx.sql.get("SELECT MAX(created_at) AS at FROM backup_snapshots WHERE guild_id = ? AND by = 'auto'", ctx.guildId)?.at ?? 0;
    if (Date.now() - last >= 7 * 86400000) save(ctx, snapshot(ctx.guild), 'auto');
  } }],
  views: {
    async backups(ctx) {
      return { rows: ctx.sql.all('SELECT id, created_at, by, roles, channels, size FROM backup_snapshots WHERE guild_id = ? ORDER BY id DESC', ctx.guildId)
        .map((r) => ({ id: String(r.id), name: `#${r.id}`, when: new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 16), what: `${r.roles} roles, ${r.channels} channels`, by: r.by === 'auto' ? 'Automatic' : ctx.guild?.members.cache.get(r.by)?.displayName ?? r.by })) };
    },
  },
  actions: { async 'backup-now'(ctx) { return { id: save(ctx, snapshot(ctx.guild), 'dashboard') }; } },
  panels: [{ id: 'backups', title: 'Backups', view: 'backups', permission: 'backup.manage', empty: 'No backups yet.',
    description: `Roles, channels and permissions. The last ${KEEP} are kept. Restore with /backup restore in Discord (it shows what would be added first).`,
    columns: [{ key: 'name', label: 'Backup' }, { key: 'when', label: 'When (UTC)' }, { key: 'what', label: 'Contains' }, { key: 'by', label: 'Made by' }],
    globalActions: [{ action: 'backup-now', label: 'Back up now', confirm: 'Save a backup of the roles, channels and permissions now?' }] }],
};
