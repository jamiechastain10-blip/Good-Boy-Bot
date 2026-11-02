/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { UserError, formatDuration, truncate } from './util.js';
import { EPHEMERAL, cmdJson } from './moduleManager.js';
import { CATEGORIES } from './notifications.js';
import { readChangelog, sectionForDiscord } from './about.js';
import { modulesCommand, modulePopupCommand, configPopupCommand } from './modulepanel.js';
import { migrateCommand } from './migrate.js';

const STATUS_ICON = { healthy: '🟢', warning: '🟡', failing: '🔴' };
const NO_PINGS = { parse: [] };

const eph = (content) => ({ content, flags: EPHEMERAL, allowedMentions: NO_PINGS });

// /module and /config are popups now: see src/modulepanel.js.

// ---------------------------------------------------------------- /permissions
const permissionsCommand = {
  access: 'admin',
  data: new SlashCommandBuilder()
    .setName('permissions').setDescription('Choose which roles can use which features')
    .addSubcommand((s) => s.setName('list').setDescription('Show who can use what'))
    .addSubcommand((s) => s.setName('allow').setDescription('Let a role use a permission')
      .addStringOption((o) => o.setName('permission').setDescription('Permission').setRequired(true).setAutocomplete(true))
      .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Stop a role using a permission')
      .addStringOption((o) => o.setName('permission').setDescription('Permission').setRequired(true).setAutocomplete(true))
      .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand((s) => s.setName('reset').setDescription('Go back to the default for a permission')
      .addStringOption((o) => o.setName('permission').setDescription('Permission').setRequired(true).setAutocomplete(true)))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(i, m) {
    const sub = i.options.getSubcommand();
    const gid = i.guildId;
    const available = m.permissionList(gid);

    if (sub === 'list') {
      if (!available.length) return i.reply(eph('Enable a module first - no permissions to show yet.'));
      const lines = available.map((p) => {
        const who = p.roles.length ? p.roles.map((r) => `<@&${r}>`).join(' ') : `*default: ${m.perms.describeDefault(p.key)}*`;
        return `\`${p.key}\` - ${p.label}\n${who}`;
      });
      const e = new EmbedBuilder().setTitle('Permissions').setColor(0x5865f2).setDescription(truncate(lines.join('\n\n'), 4000))
        .setFooter({ text: 'Server owner and Administrators can always use everything.' });
      return i.reply({ embeds: [e], flags: EPHEMERAL, allowedMentions: NO_PINGS });
    }

    const key = i.options.getString('permission', true);
    if (!available.some((p) => p.key === key)) throw new UserError('Unknown permission, or its module is off in this server.');

    if (sub === 'allow') {
      const role = i.options.getRole('role', true);
      if (role.id === i.guild.id) throw new UserError('Choosing @everyone here would open this up to every member. Pick a specific role.');
      m.db.permAdd(gid, key, role.id);
      m.db.addLog(gid, 'core', 'security', `${i.user.tag} allowed role ${role.name} to use ${key}`);
      return i.reply(eph(`<@&${role.id}> can now use \`${key}\`.`));
    }
    if (sub === 'remove') {
      const role = i.options.getRole('role', true);
      m.db.permRemove(gid, key, role.id);
      m.db.addLog(gid, 'core', 'security', `${i.user.tag} removed role ${role.name} from ${key}`);
      return i.reply(eph(`<@&${role.id}> no longer has \`${key}\`.`));
    }
    m.db.permClear(gid, key);
    m.db.addLog(gid, 'core', 'security', `${i.user.tag} reset ${key} to default`);
    return i.reply(eph(`\`${key}\` is back to its default (${m.perms.describeDefault(key)}).`));
  },

  async autocomplete(i, m) {
    const q = String(i.options.getFocused()).toLowerCase();
    const opts = m.permissionList(i.guildId)
      .filter((p) => p.key.includes(q) || p.label.toLowerCase().includes(q)).slice(0, 25)
      .map((p) => ({ name: truncate(`${p.key} - ${p.label}`, 100), value: p.key }));
    await i.respond(opts);
  },
};

// ---------------------------------------------------------------- /health
const healthCommand = {
  access: 'admin',
  data: new SlashCommandBuilder().setName('health').setDescription('Bot and module health').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(i, m) {
    const mem = Math.round(process.memoryUsage().rss / 1048576);
    const q = m.queue.snapshot();
    const mods = m.getHealth().filter((h) => m.isActive(i.guildId, h.name));
    const wanted = ['MessageContent', 'GuildMembers', 'GuildPresences'];
    const intents = wanted.map((n) => `${m.intents.has(n) ? '✅' : '❌'} ${n}`).join('\n');
    const e = new EmbedBuilder().setTitle('Health').setColor(0x57f287).addFields(
      { name: 'Latency', value: `${Math.round(i.client.ws.ping)} ms`, inline: true },
      { name: 'Uptime', value: formatDuration(process.uptime() * 1000), inline: true },
      { name: 'Memory', value: `${mem} MB`, inline: true },
      { name: 'Servers', value: String(i.client.guilds.cache.size), inline: true },
      { name: 'API queue', value: `${q.running} running, ${q.waiting} waiting, ${q.failed} failed`, inline: true },
      { name: 'Privileged intents', value: intents + (wanted.some((n) => !m.intents.has(n)) ? '\n*Turn missing ones on in the Developer Portal > Bot.*' : '') },
      { name: 'Command registration', value: (() => { const st = m.syncStatus.get(i.guildId); if (!st) return '*not synced yet*'; return st.ok ? `✅ ${st.count} commands registered` : `⚠️ ${st.failed.length} command(s) rejected by Discord:\n${truncate(st.failed.map((f) => `**${f.name}**: ${f.error}`).join('\n'), 600)}`; })() },
      { name: 'Modules in this server', value: truncate(mods.map((h) => `${STATUS_ICON[h.status]} **${h.name}** - ${h.errorsLast10Min} error(s) in 10 min${h.lastError ? `\n> ${truncate(h.lastError.message, 100)}` : ''}`).join('\n') || '*none enabled*', 1000) },
    );
    return i.reply({ embeds: [e], flags: EPHEMERAL });
  },
};

// ---------------------------------------------------------------- /help
const helpCommand = {
  access: 'everyone',
  data: new SlashCommandBuilder().setName('help').setDescription('See what this bot can do in this server'),
  async execute(i, m) {
    const mods = m.describeForGuild(i.guildId).filter((d) => d.enabled && d.commands.length);
    const e = new EmbedBuilder().setTitle('Good Boy').setColor(0x5865f2);
    if (!mods.length) e.setDescription('No features are turned on yet. An admin can turn them on with `/modules`.');
    for (const d of mods.slice(0, 24)) e.addFields({ name: `${d.name}`, value: truncate(d.commands.map((c) => `\`/${c}\``).join(' '), 1000) });
    return i.reply({ embeds: [e], flags: EPHEMERAL });
  },
};

// ---------------------------------------------------------------- /about and /whatsnew
const aboutCommand = {
  access: 'everyone',
  data: new SlashCommandBuilder().setName('about').setDescription('Which version of Good Boy this is, and who makes it'),
  async execute(i, m) {
    const on = m.describeForGuild(i.guildId).filter((d) => d.enabled).length;
    const e = new EmbedBuilder().setTitle('Good Boy').setColor(0x5865f2)
      .setDescription('A modular community bot by **Basic Ghost Labs**. Server owners switch on only the features they want.')
      .addFields(
        { name: 'Version', value: `v${m.version ?? 'unknown'}`, inline: true },
        { name: 'Features on here', value: String(on), inline: true },
        { name: 'Uptime', value: formatDuration(Math.round(process.uptime()) * 1000), inline: true },
      )
      .setFooter({ text: '/help shows what you can use here' });
    return i.reply({ embeds: [e], flags: EPHEMERAL });
  },
};

const whatsNewCommand = {
  access: 'admin',
  data: new SlashCommandBuilder().setName('whatsnew').setDescription('What changed in this version of the bot (admins)')
    .addStringOption((o) => o.setName('version').setDescription('An older version, for example 2.1.1 (default: the current one)'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(i, m) {
    const log = readChangelog(m.rootDir ?? process.cwd());
    if (!log.length) throw new UserError('This copy of the bot has no CHANGELOG.md, so there is nothing to show.');
    const want = (i.options.getString('version') ?? m.version ?? '').trim().replace(/^v/i, '');
    const section = log.find((s) => s.version === want) ?? (i.options.getString('version') ? null : log[0]);
    if (!section) throw new UserError(`I have no notes for version **${truncate(want, 30)}**. Versions I know: ${log.slice(0, 8).map((s) => s.version).join(', ')}.`);
    const e = new EmbedBuilder().setTitle(`What's new in ${section.version}`).setColor(0x5865f2)
      .setDescription(sectionForDiscord(section) || '*No notes for this version.*')
      .setFooter({ text: `Running v${m.version ?? 'unknown'}${log.length > 1 ? ' • older: /whatsnew version:<number>' : ''}` });
    return i.reply({ embeds: [e], flags: EPHEMERAL });
  },
};

// ---------------------------------------------------------------- /notifications
const catChoices = Object.entries(CATEGORIES).map(([value, c]) => ({ name: value, value }));
const notificationsCommand = {
  access: 'everyone',
  data: new SlashCommandBuilder().setName('notifications').setDescription('Choose which optional pings and messages you get')
    .addSubcommand((s) => s.setName('view').setDescription('See your current choices'))
    .addSubcommand((s) => s.setName('set').setDescription('Turn a kind of notification on or off for yourself')
      .addStringOption((o) => o.setName('category').setDescription('What kind').setRequired(true).addChoices(...catChoices))
      .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)))
    .addSubcommand((s) => s.setName('server-default').setDescription('(Admins) Set this server\'s default for a kind of notification')
      .addStringOption((o) => o.setName('category').setDescription('What kind').setRequired(true).addChoices(...catChoices))
      .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true))),
  async execute(i, m) {
    const sub = i.options.getSubcommand();
    if (sub === 'view') {
      const rows = m.notifications.effective(i.guildId, i.user.id).map((r) => `${r.enabled ? '✅' : '❌'} **${r.category}** - ${CATEGORIES[r.category].label} *(${r.source})*`);
      return i.reply({ embeds: [new EmbedBuilder().setTitle('Your notifications').setColor(0x5865f2).setDescription(rows.join('\n')).setFooter({ text: 'Change with /notifications set' })], flags: EPHEMERAL });
    }
    const category = i.options.getString('category', true);
    const enabled = i.options.getBoolean('enabled', true);
    if (!(category in CATEGORIES)) throw new UserError('Unknown category.');
    if (sub === 'server-default') {
      if (!m.perms.isAdmin(i.member)) throw new UserError('Only server admins can change server defaults.');
      m.db.setNotifyPref(i.guildId, '*', category, enabled);
      m.db.addLog(i.guildId, 'core', 'security', `${i.user.tag} set server default ${category}=${enabled}`);
      return i.reply(eph(`Server default for **${category}** is now ${enabled ? 'on' : 'off'}. Members can still choose for themselves.`));
    }
    m.db.setNotifyPref(i.guildId, i.user.id, category, enabled);
    return i.reply(eph(`${enabled ? '✅' : '❌'} **${category}** is now ${enabled ? 'on' : 'off'} for you in this server.`));
  },
};

export const builtins = [modulePopupCommand, modulesCommand, configPopupCommand, permissionsCommand, notificationsCommand, healthCommand, helpCommand, aboutCommand, whatsNewCommand, migrateCommand];
export { cmdJson };
