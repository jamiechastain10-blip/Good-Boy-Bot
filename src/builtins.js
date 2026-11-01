/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { UserError, formatDuration, truncate } from './util.js';
import { EPHEMERAL, cmdJson } from './moduleManager.js';
import { CATEGORIES } from './notifications.js';
import { readChangelog, sectionForDiscord } from './about.js';

const STATUS_ICON = { healthy: '🟢', warning: '🟡', failing: '🔴' };
const NO_PINGS = { parse: [] };

const eph = (content) => ({ content, flags: EPHEMERAL, allowedMentions: NO_PINGS });

function fmtValue(s, v) {
  if (v === null || v === undefined || v === '') return '*not set*';
  if (s.type === 'toggle') return v ? '✅ on' : '❌ off';
  if (s.type === 'channel') return `<#${v}>`;
  if (s.type === 'role') return `<@&${v}>`;
  if (s.type === 'list') return v.length ? truncate(v.join(', '), 300) : '*empty*';
  return truncate(String(v), 300);
}

const moduleOption = (o) => o.setName('module').setDescription('Which module').setRequired(true).setAutocomplete(true);
const keyOption = (o) => o.setName('key').setDescription('Which setting').setRequired(true).setAutocomplete(true);

// ---------------------------------------------------------------- /module
const moduleCommand = {
  access: 'admin',
  data: new SlashCommandBuilder()
    .setName('module').setDescription('Turn bot features on or off for this server')
    .addSubcommand((s) => s.setName('list').setDescription('Show every module and whether it is on'))
    .addSubcommand((s) => s.setName('info').setDescription('Details about one module')
      .addStringOption((o) => o.setName('name').setDescription('Module').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('enable').setDescription('Turn a module on')
      .addStringOption((o) => o.setName('name').setDescription('Module').setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('disable').setDescription('Turn a module off')
      .addStringOption((o) => o.setName('name').setDescription('Module').setRequired(true).setAutocomplete(true))
      .addBooleanOption((o) => o.setName('cascade').setDescription('Also turn off add-ons that need it')))
    .addSubcommand((s) => s.setName('reload').setDescription('Reload a module from disk after an update (bot owner only)')
      .addStringOption((o) => o.setName('name').setDescription('Module').setRequired(true).setAutocomplete(true)))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(i, m) {
    const sub = i.options.getSubcommand();
    const gid = i.guildId;

    if (sub === 'list') {
      const rows = m.describeForGuild(gid).map((d) => {
        const icon = d.enabled ? (STATUS_ICON[d.status] ?? '🟢') : '⬜';
        const tag = d.type === 'addon' ? ` *(add-on for ${d.requires.module})*` : '';
        return `${icon} **${d.name}** v${d.version}${tag}\n${d.description ? '> ' + truncate(d.description, 120) : ''}`;
      });
      const e = new EmbedBuilder().setTitle('Modules').setColor(0x5865f2)
        .setDescription(truncate(rows.join('\n') || 'No modules installed.', 4000))
        .setFooter({ text: '/module enable name:<module> • /module info name:<module>' });
      if (m.loadErrors.size) e.addFields({ name: 'Failed to load', value: truncate([...m.loadErrors].map(([k, v]) => `**${k}**: ${v}`).join('\n'), 1000) });
      return i.reply({ embeds: [e], flags: EPHEMERAL });
    }

    const name = i.options.getString('name', true).toLowerCase();

    if (sub === 'info') {
      const d = m.describeForGuild(gid).find((x) => x.name === name);
      if (!d) throw new UserError(`There is no module called **${name}**.`);
      const e = new EmbedBuilder().setTitle(`${d.name} v${d.version}`).setColor(0x5865f2)
        .setDescription(d.description || 'No description.')
        .addFields(
          { name: 'Status', value: d.enabled ? `${STATUS_ICON[d.status]} enabled (${d.status})` : '⬜ disabled', inline: true },
          { name: 'Type', value: d.type === 'addon' ? `add-on (needs ${d.requires.module} ${d.requires.version})` : 'module', inline: true },
          { name: 'Commands', value: d.commands.length ? d.commands.map((c) => `/${c}`).join(' ') : '*none*' },
          { name: 'Settings', value: d.settings.length ? d.settings.map((s) => `\`${s.key}\``).join(' ') : '*none*' },
        );
      return i.reply({ embeds: [e], flags: EPHEMERAL });
    }

    if (sub === 'enable') {
      await i.deferReply({ flags: EPHEMERAL });
      await m.enable(gid, name);
      const d = m.describeForGuild(gid).find((x) => x.name === name);
      return i.editReply({ content: `✅ **${name}** is now on. ${d.commands.length ? 'Commands will appear within a few seconds: ' + d.commands.map((c) => `/${c}`).join(' ') : ''}`, allowedMentions: NO_PINGS });
    }

    if (sub === 'disable') {
      await i.deferReply({ flags: EPHEMERAL });
      await m.disable(gid, name, { cascade: i.options.getBoolean('cascade') ?? false });
      return i.editReply({ content: `⬜ **${name}** is now off. Your saved settings and data are kept.`, allowedMentions: NO_PINGS });
    }

    if (sub === 'reload') {
      if (!m.isBotOwner(i.user.id)) throw new UserError('Only the bot owner can reload modules.');
      await i.deferReply({ flags: EPHEMERAL });
      const r = await m.reload(name);
      return i.editReply({ content: `🔄 Reloaded **${name}** ${r.from} → ${r.to} for ${r.guilds} server(s).`, allowedMentions: NO_PINGS });
    }
  },

  async autocomplete(i, m) {
    const q = i.options.getFocused().toLowerCase();
    const opts = m.describeForGuild(i.guildId).filter((d) => d.name.includes(q)).slice(0, 25).map((d) => ({ name: `${d.name} (${d.enabled ? 'on' : 'off'})`, value: d.name }));
    await i.respond(opts);
  },
};

// ---------------------------------------------------------------- /config
const configCommand = {
  access: 'admin',
  data: new SlashCommandBuilder()
    .setName('config').setDescription('View or change a module\'s settings')
    .addSubcommand((s) => s.setName('view').setDescription('Show a module\'s settings')
      .addStringOption(moduleOption))
    .addSubcommand((s) => s.setName('set').setDescription('Change a text, number, on/off or choice setting')
      .addStringOption(moduleOption).addStringOption(keyOption)
      .addStringOption((o) => o.setName('value').setDescription('New value').setRequired(true)))
    .addSubcommand((s) => s.setName('channel').setDescription('Pick a channel for a setting')
      .addStringOption(moduleOption).addStringOption(keyOption)
      .addChannelOption((o) => o.setName('channel').setDescription('The channel').setRequired(true)))
    .addSubcommand((s) => s.setName('role').setDescription('Pick a role for a setting')
      .addStringOption(moduleOption).addStringOption(keyOption)
      .addRoleOption((o) => o.setName('role').setDescription('The role').setRequired(true)))
    .addSubcommand((s) => s.setName('add').setDescription('Add an entry to a list setting')
      .addStringOption(moduleOption).addStringOption(keyOption)
      .addStringOption((o) => o.setName('value').setDescription('Entry (separate several with commas)').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove an entry from a list setting')
      .addStringOption(moduleOption).addStringOption(keyOption)
      .addStringOption((o) => o.setName('value').setDescription('Entry to remove').setRequired(true)))
    .addSubcommand((s) => s.setName('reset').setDescription('Reset a setting to its default')
      .addStringOption(moduleOption).addStringOption(keyOption))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(i, m) {
    const sub = i.options.getSubcommand();
    const gid = i.guildId;
    const mod = i.options.getString('module', true).toLowerCase();
    const def = m.defs.get(mod)?.def;
    if (!def) throw new UserError(`There is no module called **${mod}**.`);

    if (sub === 'view') {
      const values = m.getSettingValues(gid, mod);
      if (!def.settings?.length) return i.reply(eph(`**${mod}** has no settings.`));
      const e = new EmbedBuilder().setTitle(`${mod} settings`).setColor(0x5865f2)
        .setDescription(def.settings.map((s) => `**${s.label}** (\`${s.key}\`)\n${fmtValue(s, values[s.key])}`).join('\n\n').slice(0, 4000))
        .setFooter({ text: m.isActive(gid, mod) ? 'Change with /config set|channel|role|add|remove' : 'This module is currently off' });
      return i.reply({ embeds: [e], flags: EPHEMERAL, allowedMentions: NO_PINGS });
    }

    const key = i.options.getString('key', true);
    const s = def.settings?.find((x) => x.key === key);
    if (!s) throw new UserError(`**${mod}** has no setting called \`${key}\`.`);

    let value;
    if (sub === 'set') value = m.setSetting(gid, mod, key, i.options.getString('value', true), 'set');
    else if (sub === 'channel') {
      if (s.type !== 'channel') throw new UserError(`\`${key}\` is not a channel setting.`);
      value = m.setSetting(gid, mod, key, i.options.getChannel('channel', true).id, 'set');
    } else if (sub === 'role') {
      if (s.type !== 'role') throw new UserError(`\`${key}\` is not a role setting.`);
      value = m.setSetting(gid, mod, key, i.options.getRole('role', true).id, 'set');
    } else if (sub === 'add' || sub === 'remove') value = m.setSetting(gid, mod, key, i.options.getString('value', true), sub);
    else if (sub === 'reset') value = m.setSetting(gid, mod, key, null, 'reset');

    m.db.addLog(gid, 'core', 'security', `${i.user.tag} changed ${mod}.${key} (${sub})`);
    return i.reply(eph(`Saved. **${s.label}** is now: ${fmtValue(s, value)}`));
  },

  async autocomplete(i, m) {
    const focused = i.options.getFocused(true);
    const q = String(focused.value).toLowerCase();
    if (focused.name === 'module') {
      return i.respond(m.describeForGuild(i.guildId).filter((d) => d.settings.length && d.name.includes(q)).slice(0, 25).map((d) => ({ name: d.name, value: d.name })));
    }
    const def = m.defs.get((i.options.getString('module') ?? '').toLowerCase())?.def;
    const sub = i.options.getSubcommand();
    const want = { channel: 'channel', role: 'role', add: 'list', remove: 'list' }[sub];
    const list = (def?.settings ?? []).filter((s) => (!want || s.type === want) && (s.key.toLowerCase().includes(q) || s.label.toLowerCase().includes(q)));
    await i.respond(list.slice(0, 25).map((s) => ({ name: truncate(`${s.label} (${s.key})`, 100), value: s.key })));
  },
};

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
    if (!mods.length) e.setDescription('No features are turned on yet. An admin can run `/module list`.');
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

export const builtins = [moduleCommand, configCommand, permissionsCommand, notificationsCommand, healthCommand, helpCommand, aboutCommand, whatsNewCommand];
export { cmdJson };
