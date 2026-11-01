/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * /modules: the module control panel inside Discord, with nothing to type.
 *
 *   /modules                    private panel: every module with its status, and a "Choose a module" dropdown
 *   pick a module               its card: what it does, its commands, every setting and its current value,
 *                               a Turn on / Turn off button and an "Edit settings" dropdown
 *   pick a group of settings    a popup with up to 5 of them, built from the module's own setting list:
 *                               on/off and choices are dropdowns, channels and roles are pickers,
 *                               numbers and text are fields, lists are one entry per line
 *   submit                      every changed value is saved through the same validated path as /config and the
 *                               dashboard, and the card updates in place
 *
 *   /module                     a popup: pick a module and what to do (turn on, turn off, see details and settings,
 *                               reload); the answer is the same card as above
 *   /config                     a popup: pick a module; the answer is its card, whose "Edit settings" opens the
 *                               settings popups
 *
 * It works for every module, including ones written later, because it only reads `settings`.
 * Buttons carry signed tokens (src/modalpipe.js), so they keep working across hot reloads and restarts.
 */
import {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ChannelType,
} from 'discord.js';
import { packToken, unpackToken } from './modalpipe.js';
import { formModal, readForm, MAX_FIELDS, MAX_LABEL } from './modalkit.js';
import { UserError, truncate } from './util.js';

const EPH = 64;
const NO_PINGS = { parse: [] };
const NS = 'gbm';
const STATUS = { healthy: '🟢', warning: '🟡', failing: '🔴' };
const ALL_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildCategory, ChannelType.GuildForum];

const tok = (i, form, args = []) => packToken({ ns: NS, step: 'p', form, owner: i.user.id, args });
const pagesOf = (settings) => { const out = []; for (let k = 0; k < settings.length; k += MAX_FIELDS) out.push(settings.slice(k, k + MAX_FIELDS)); return out; };

export function showValue(s, v) {
  if (v === null || v === undefined || v === '') return '*not set*';
  if (s.type === 'toggle') return v ? '✅ On' : '⬜ Off';
  if (s.type === 'channel') return `<#${v}>`;
  if (s.type === 'role') return `<@&${v}>`;
  if (s.type === 'list') return v.length ? truncate(v.join(', '), 120) : '*empty*';
  return truncate(String(v), 120);
}

/** A popup field for one setting. Long labels are shortened to Discord's 45 characters, the full text goes underneath. */
export function fieldFor(s, value) {
  let label = s.label, desc = s.description ? truncate(s.description, 100) : undefined;
  if (label.length > MAX_LABEL) { desc = truncate(s.label, 100); label = `${label.slice(0, MAX_LABEL - 1).replace(/\s+\S*$/, '')}…`; }
  const base = { id: s.key, label, desc, required: false };
  switch (s.type) {
    case 'toggle': return { ...base, kind: 'select', required: true, value: value ? 'on' : 'off', options: [{ label: 'On', value: 'on' }, { label: 'Off', value: 'off' }] };
    case 'select': return { ...base, kind: 'select', required: true, value: String(value ?? s.default ?? s.options[0]), options: s.options.slice(0, 25).map((o) => ({ label: String(o), value: String(o) })) };
    case 'number': return { ...base, kind: 'text', required: true, value: value ?? '', max: 15, placeholder: `${s.min ?? ''} to ${s.max ?? ''}`.trim() };
    case 'channel': return { ...base, kind: 'channel', value: value || undefined, channelTypes: ALL_CHANNELS, placeholder: 'Not set' };
    case 'role': return { ...base, kind: 'role', value: value || undefined, placeholder: 'Not set' };
    case 'list': return { ...base, kind: 'paragraph', value: (value ?? []).join('\n'), max: 4000, placeholder: 'One entry per line' };
    default: return { ...base, kind: s.maxLength && s.maxLength <= 100 ? 'text' : 'paragraph', value: value ?? '', max: Math.min(s.maxLength ?? 2000, 4000) };
  }
}

function listMessage(i, m, note) {
  const mods = m.describeForGuild(i.guildId);
  const lines = mods.map((d) => `${d.enabled ? (STATUS[d.status] ?? '🟢') : '⬜'} **${d.name}**${d.description ? ` · ${truncate(d.description, 70)}` : ''}`);
  const e = new EmbedBuilder().setColor(0x5865f2).setTitle('🧩 Modules').setDescription(truncate([note, lines.join('\n') || 'No modules installed.'].filter(Boolean).join('\n\n'), 4000))
    .setFooter({ text: 'Pick a module to turn it on or off and change its settings. Only you can see this.' });
  const pick = new StringSelectMenuBuilder().setCustomId(tok(i, 'pick')).setPlaceholder('Choose a module...')
    .addOptions(mods.slice(0, 25).map((d) => new StringSelectMenuOptionBuilder().setLabel(d.name).setValue(d.name)
      .setDescription(truncate(`${d.enabled ? 'On' : 'Off'}${d.description ? ` · ${d.description}` : ''}`, 100)).setEmoji(d.enabled ? '🟢' : '⬜')));
  return { embeds: [e], components: mods.length ? [new ActionRowBuilder().addComponents(pick)] : [], flags: EPH, allowedMentions: NO_PINGS };
}

function cardMessage(i, m, name, note) {
  const d = m.describeForGuild(i.guildId).find((x) => x.name === name);
  if (!d) throw new UserError(`There is no module called **${name}** any more.`);
  const def = m.defs.get(name).def;
  const values = m.getSettingValues(i.guildId, name);
  const settings = def.settings ?? [];
  const e = new EmbedBuilder().setColor(d.enabled ? 0x22c38e : 0x8b97ab)
    .setTitle(`${d.enabled ? (STATUS[d.status] ?? '🟢') : '⬜'} ${d.name} · v${d.version}`)
    .setDescription([note, d.description || null, d.type === 'addon' ? `*Add-on for **${d.requires.module}**.*` : null].filter(Boolean).join('\n\n') || null)
    .addFields({ name: 'Status', value: d.enabled ? `On (${d.status})` : 'Off', inline: true },
      { name: 'Commands', value: d.commands.length ? truncate(d.commands.map((c) => (/^[a-z0-9-]+$/.test(c) ? `/${c}` : c)).join(' '), 1000) : '*none*', inline: true });
  if (settings.length) e.addFields({ name: `Settings (${settings.length})`, value: truncate(settings.map((s) => `**${s.label}**: ${showValue(s, values[s.key])}`).join('\n'), 1024) });
  const toggle = new ButtonBuilder().setCustomId(tok(i, d.enabled ? 'off' : 'on', [name]))
    .setLabel(d.enabled ? 'Turn off' : 'Turn on').setStyle(d.enabled ? ButtonStyle.Secondary : ButtonStyle.Success).setEmoji(d.enabled ? '⏹️' : '▶️');
  const back = new ButtonBuilder().setCustomId(tok(i, 'list')).setLabel('All modules').setEmoji('↩️').setStyle(ButtonStyle.Secondary);
  const rows = [new ActionRowBuilder().addComponents(toggle, back)];
  const pages = pagesOf(settings);
  if (pages.length) {
    rows.unshift(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(tok(i, 'edit', [name])).setPlaceholder('✏️ Edit settings...')
      .addOptions(pages.slice(0, 25).map((p, k) => new StringSelectMenuOptionBuilder().setValue(String(k))
        .setLabel(pages.length === 1 ? 'All settings' : `Settings ${k * MAX_FIELDS + 1}–${k * MAX_FIELDS + p.length}`)
        .setDescription(truncate(p.map((s) => s.label).join(', '), 100))))));
  }
  return { embeds: [e], components: rows, flags: EPH, allowedMentions: NO_PINGS };
}

/** After a slow change (turning a module on can take a moment) answer in the same message. */
async function updateSlow(i, work) {
  if (i.deferUpdate) { await i.deferUpdate(); const msg = await work(); const { flags, ...rest } = msg; return i.editReply(rest); }
  const msg = await work(); const { flags, ...rest } = msg; return i.update(rest);
}

async function onComponent(i, m) {
  const t = unpackToken(i.customId, { ns: NS, userId: i.user.id, maxAgeMs: 60 * 60000 });
  if (!m.perms.isAdmin(i.member)) throw new UserError('You need the **Manage Server** permission to change modules.');
  const [name, page] = t.args;
  const strip = (msg) => { const { flags, ...rest } = msg; return rest; };

  if (t.form === 'list') return i.update(strip(listMessage(i, m)));
  if (t.form === 'pick') return i.update(strip(cardMessage(i, m, i.values?.[0])));
  if (t.form === 'on' || t.form === 'off') {
    return updateSlow(i, async () => {
      if (t.form === 'on') await m.enable(i.guildId, name); else await m.disable(i.guildId, name);
      return cardMessage(i, m, name, t.form === 'on' ? '✅ Turned on. Its commands appear within a few seconds.' : '⬜ Turned off. Its settings and data are kept.');
    });
  }
  if (t.form === 'edit') {
    // A popup must be the first answer to this pick, so it is built straight away from the module's settings.
    const k = Number(i.values?.[0] ?? 0);
    const settings = pagesOf(m.defs.get(name)?.def.settings ?? [])[k];
    if (!settings) throw new UserError('Those settings are not there any more. Open /modules again.');
    const values = m.getSettingValues(i.guildId, name);
    const title = truncate(`${name} settings${pagesOf(m.defs.get(name).def.settings).length > 1 ? ` (${k + 1})` : ''}`, 45);
    return i.showModal(formModal(packToken({ ns: NS, step: 's', form: 'save', owner: i.user.id, args: [name, String(k)] }), title, settings.map((s) => fieldFor(s, values[s.key]))));
  }
  if (t.form === 'save') return save(i, m, name, Number(page));
  if (t.form === 'module') return moduleSubmit(i, m);
  if (t.form === 'config') return configSubmit(i, m);
  throw new UserError('That button is not recognised. Open /modules again.');
}

/** The module dropdown used by the /module and /config popups (Discord allows 25 choices in one dropdown). */
function moduleField(i, m, label = 'Module') {
  const mods = m.describeForGuild(i.guildId);
  return { id: 'module', kind: 'select', label, options: mods.slice(0, 25).map((d) => ({ label: `${d.name} · ${d.enabled ? 'On' : 'Off'}`, value: d.name, description: d.description ? truncate(d.description, 100) : undefined })) };
}
const ACTIONS = [
  { label: 'Show details and settings', value: 'show', description: 'See what it does and change its settings' },
  { label: 'Turn on', value: 'on', description: 'Start it in this server' },
  { label: 'Turn off', value: 'off', description: 'Stop it; its settings and data are kept' },
  { label: 'Reload from disk (bot owner)', value: 'reload', description: 'Load new code after an update' },
];

async function moduleSubmit(i, m) {
  const got = readForm(i, [moduleField(i, m), { id: 'action', kind: 'select', label: 'What to do', options: ACTIONS }]);
  const name = got.module, action = got.action ?? 'show';
  if (!name || !m.defs.has(name)) throw new UserError('Pick a module.');
  let note = null;
  try {
    if (action === 'on') { await i.deferReply?.({ flags: EPH }); await m.enable(i.guildId, name); note = '✅ Turned on. Its commands appear within a few seconds.'; }
    else if (action === 'off') { await i.deferReply?.({ flags: EPH }); await m.disable(i.guildId, name); note = '⬜ Turned off. Its settings and data are kept.'; }
    else if (action === 'reload') {
      if (!m.isBotOwner(i.user.id)) throw new UserError('Only the bot owner can reload modules.');
      await i.deferReply?.({ flags: EPH });
      const r = await m.reload(name); note = `🔄 Reloaded ${r.from} → ${r.to} for ${r.guilds} server(s).`;
    }
  } catch (e) { if (!(e instanceof UserError) && e.code !== 'REQUIREMENT') throw e; note = `⚠️ ${e.message}`; }
  const msg = cardMessage(i, m, name, note);
  if (i.deferred) { const { flags, ...rest } = msg; return i.editReply(rest); }
  return i.reply(msg);
}

async function configSubmit(i, m) {
  const got = readForm(i, [moduleField(i, m)]);
  if (!got.module || !m.defs.has(got.module)) throw new UserError('Pick a module.');
  return i.reply(cardMessage(i, m, got.module, (m.defs.get(got.module).def.settings ?? []).length ? 'Use **Edit settings** below to change them.' : 'This module has no settings.'));
}

async function save(i, m, name, k) {
  const settings = pagesOf(m.defs.get(name)?.def.settings ?? [])[k];
  if (!settings) throw new UserError('Those settings are not there any more. Open /modules again.');
  const fields = settings.map((s) => fieldFor(s, null));
  const got = readForm(i, fields);
  const before = m.getSettingValues(i.guildId, name);
  const saved = [], problems = [];
  for (const s of settings) {
    let v = got[s.key];
    if (s.type === 'list') v = String(v ?? '').split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean);
    if (s.type === 'toggle') v = v === 'on';
    if ((s.type === 'channel' || s.type === 'role') && !v) v = null;
    if (s.type === 'number' && (v === '' || v == null)) { problems.push(`**${s.label}** needs a number.`); continue; }
    if (JSON.stringify(v ?? null) === JSON.stringify(before[s.key] ?? (s.type === 'list' ? [] : null))) continue;
    try {
      if (v === null) m.setSetting(i.guildId, name, s.key, null, 'reset');
      else m.setSetting(i.guildId, name, s.key, s.type === 'list' ? v : String(v));
      saved.push(s.label);
    } catch (e) { problems.push(e instanceof UserError ? e.message : `**${s.label}** could not be saved.`); }
  }
  const note = [saved.length ? `✅ Saved: ${saved.join(', ')}.` : problems.length ? null : 'Nothing changed.', ...problems.map((p) => `⚠️ ${p}`)].filter(Boolean).join('\n');
  const msg = cardMessage(i, m, name, note);
  const { flags, ...rest } = msg;
  return i.update ? i.update(rest) : i.reply(msg);
}

/** /module: one popup to pick a module and what to do with it. */
export const modulePopupCommand = {
  access: 'admin',
  data: new SlashCommandBuilder().setName('module').setDescription('Turn a module on or off, or see its settings (opens a popup)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(i, m) {
    return i.showModal(formModal(packToken({ ns: NS, step: 's', form: 'module', owner: i.user.id }), 'Modules',
      [moduleField(i, m, 'Which module?'), { id: 'action', kind: 'select', label: 'What to do', value: 'show', options: ACTIONS }]));
  },
};

/** /config: a popup to pick a module, then its card with "Edit settings". */
export const configPopupCommand = {
  access: 'admin',
  data: new SlashCommandBuilder().setName('config').setDescription('Change a module\'s settings (opens a popup)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(i, m) {
    return i.showModal(formModal(packToken({ ns: NS, step: 's', form: 'config', owner: i.user.id }), 'Settings', [moduleField(i, m, 'Which module?')]));
  },
};

export const modulesCommand = {
  access: 'admin',
  data: new SlashCommandBuilder().setName('modules').setDescription('Module control panel: turn features on or off and change their settings')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(i, m) { return i.reply(listMessage(i, m)); },
  components: [{ prefix: `${NS}:`, execute: onComponent }],
};
