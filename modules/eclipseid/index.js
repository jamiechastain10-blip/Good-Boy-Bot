/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Eclipse ID: a member-controlled gaming profile.
 *   /id show [member]     - the card: about me, favourite games, platforms, availability, region, linked accounts, achievements
 *   /id edit              - fill in the card in a popup
 *   /id privacy           - per field: public, staff only, or only me
 *   /id link / unlink     - gaming account names (format-checked only, NOT verified)
 *   /id roblox            - optional lookup that a Roblox username exists (off by default)
 *   /id delete            - erase everything about you in this server
 * Each server keeps its own profile text. The ID number (EID-000123) is the same everywhere the bot is.
 */
import { SlashCommandBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } from 'discord.js';
import { UserError, truncate } from '../../src/util.js';
import { FIELDS, VISIBILITY, PLATFORMS, LINK_PLATFORMS, cleanField, parsePlatforms, canSee, eidLabel, normalizeLink, lookupRoblox } from '../../src/eclipseid.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const fetchHook = () => globalThis[Symbol.for('goodboy.eclipseid.fetch')] ?? fetch;

const eidOf = (ctx, userId) => {
  const have = ctx.sql.get('SELECT eid FROM eclipseid_ids WHERE user_id = ?', userId);
  if (have) return have.eid;
  ctx.sql.run('INSERT OR IGNORE INTO eclipseid_ids (user_id, created_at) VALUES (?, ?)', userId, Date.now());
  return ctx.sql.get('SELECT eid FROM eclipseid_ids WHERE user_id = ?', userId).eid;
};
const profile = (ctx, userId) => {
  const r = ctx.sql.get('SELECT * FROM eclipseid_profile WHERE guild_id = ? AND user_id = ?', ctx.guildId, userId);
  return r ? { ...r, vis: JSON.parse(r.vis || '{}') } : { bio: '', games: '', platforms: '', availability: '', region: '', vis: {} };
};
const saveProfile = (ctx, userId, p) => ctx.sql.run(`INSERT INTO eclipseid_profile (guild_id, user_id, bio, games, platforms, availability, region, vis, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET bio = excluded.bio, games = excluded.games, platforms = excluded.platforms, availability = excluded.availability, region = excluded.region, vis = excluded.vis, updated_at = excluded.updated_at`,
ctx.guildId, userId, p.bio, p.games, p.platforms, p.availability, p.region, JSON.stringify(p.vis ?? {}), Date.now());
const visOf = (p, f) => p.vis?.[f] ?? FIELDS[f].default;
const linksOf = (ctx, userId) => ctx.sql.all('SELECT platform, value, visibility FROM eclipseid_link WHERE guild_id = ? AND user_id = ? ORDER BY platform', ctx.guildId, userId);

export function cardFor(ctx, user, viewer, { self = false, staff = false } = {}) {
  const p = profile(ctx, user.id); const see = (f) => canSee(visOf(p, f), { self, staff });
  const e = new EmbedBuilder().setTitle(`🪪 ${ctx.guild.members.cache.get(user.id)?.displayName ?? user.username ?? user.id}`).setColor(0x7c8cff);
  if (user.displayAvatarURL) e.setThumbnail(user.displayAvatarURL());
  const hidden = [];
  const line = (f) => {
    if (!p[f]) return null;
    if (self && visOf(p, f) !== 'public') hidden.push(FIELDS[f].label.toLowerCase());
    return see(f) ? p[f] : null;
  };
  const bio = line('bio'); if (bio) e.setDescription(truncate(bio, 300));
  for (const [f, name] of [['games', 'Favourite games'], ['platforms', 'Platforms'], ['availability', 'Play style & availability'], ['region', 'Region']]) {
    const v = line(f);
    if (v) e.addFields({ name, value: truncate(f === 'platforms' ? v.split(',').map((x) => x.trim()).join(' · ') : v, 200), inline: f !== 'games' });
  }
  const allLinks = linksOf(ctx, user.id);
  if (self && allLinks.some((l) => l.visibility !== 'public')) hidden.push('linked accounts');
  const links = allLinks.filter((l) => canSee(l.visibility, { self, staff }));
  if (links.length) e.addFields({ name: 'Linked accounts (not verified)', value: truncate(links.map((l) => `**${LINK_PLATFORMS[l.platform]?.label ?? l.platform}** ${l.value}${l.visibility !== 'public' ? ` *(${l.visibility === 'staff' ? 'staff only' : 'only you'})*` : ''}`).join('\n'), 1000) });
  if (ctx.isActive('achievements')) {
    const s = ctx.api('achievements')?.summary?.(ctx, user.id);
    if (s?.visible && s.count) e.addFields({ name: `Achievements ${s.count}/${s.total}`, value: s.recent.map((r) => `${r.emoji} ${r.name}`).join(' · ') });
  }
  if (!e.data.description && !(e.data.fields ?? []).length) e.setDescription(self ? 'Your card is empty. Use `/id edit` to fill it in.' : '*This member has not shared anything yet.*');
  e.setFooter({ text: `${eidLabel(eidOf(ctx, user.id))} · members choose what to share · linked accounts are not verified${self && hidden.length ? ` · hidden from others: ${hidden.join(', ')}` : ''}` });
  return e;
}

function editModal(p) {
  const f = (id, label, style, max, value, hint) => {
    const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(false);
    if (hint) input.setPlaceholder(hint);
    if (value) input.setValue(String(value).slice(0, max));
    return new ActionRowBuilder().addComponents(input);
  };
  return new ModalBuilder().setCustomId('eid:edit').setTitle('Your Eclipse ID').addComponents(
    f('bio', FIELDS.bio.label, TextInputStyle.Paragraph, FIELDS.bio.max, p.bio),
    f('games', FIELDS.games.label, TextInputStyle.Short, FIELDS.games.max, p.games),
    f('platforms', 'Platforms', TextInputStyle.Short, FIELDS.platforms.max, p.platforms, 'pc, playstation, xbox, switch, mobile, vr'),
    f('availability', FIELDS.availability.label, TextInputStyle.Short, FIELDS.availability.max, p.availability),
    f('region', FIELDS.region.label, TextInputStyle.Short, FIELDS.region.max, p.region),
  );
}

async function onSubmit(ctx, i) {
  const get = (id) => i.fields.getTextInputValue(id);
  const plat = parsePlatforms(get('platforms'));
  if (plat.unknown.length) throw new UserError(`I don't know these platforms: ${plat.unknown.join(', ')}. Use: ${PLATFORMS.join(', ')}.`);
  const old = profile(ctx, i.user.id);
  saveProfile(ctx, i.user.id, { ...old, bio: cleanField(get('bio'), FIELDS.bio.max), games: cleanField(get('games'), FIELDS.games.max), platforms: plat.platforms.join(', '), availability: cleanField(get('availability'), FIELDS.availability.max), region: cleanField(get('region'), FIELDS.region.max) });
  return i.reply({ content: 'Saved. See it with `/id show`. Change who can see each part with `/id privacy`.', flags: EPH });
}

async function idCmd(ctx, i) {
  const sub = i.options.getSubcommand();
  const reply = (p) => i.reply({ ...(typeof p === 'string' ? { content: p } : p), flags: EPH, allowedMentions: NOPING });

  if (sub === 'edit') return i.showModal(editModal(profile(ctx, i.user.id)));

  if (sub === 'show') {
    const u = i.options.getUser('member') ?? i.user;
    if (u.bot) throw new UserError('Bots do not have an Eclipse ID.');
    const staff = ctx.perms.check(i.member, 'eclipseid.staff');
    return reply({ embeds: [cardFor(ctx, u, i.user, { self: u.id === i.user.id, staff })] });
  }

  if (sub === 'privacy') {
    const field = i.options.getString('field', true); const v = i.options.getString('who', true);
    if (!(field in FIELDS) || !VISIBILITY.includes(v)) throw new UserError('Pick a field and who may see it.');
    if (field === 'links') {
      const platform = i.options.getString('platform');
      if (platform) ctx.sql.run('UPDATE eclipseid_link SET visibility = ? WHERE guild_id = ? AND user_id = ? AND platform = ?', v, ctx.guildId, i.user.id, platform);
      else ctx.sql.run('UPDATE eclipseid_link SET visibility = ? WHERE guild_id = ? AND user_id = ?', v, ctx.guildId, i.user.id);
    }
    const p = profile(ctx, i.user.id); p.vis[field] = v; saveProfile(ctx, i.user.id, p);
    return reply(`**${FIELDS[field].label}** can be seen by: ${{ public: 'everyone in the server', staff: 'you and server staff', private: 'only you' }[v]}.`);
  }

  if (sub === 'link') {
    const platform = i.options.getString('platform', true);
    const r = normalizeLink(platform, i.options.getString('name', true));
    if (r.error) throw new UserError(r.error);
    const vis = i.options.getString('who') ?? 'private';
    ctx.sql.run(`INSERT INTO eclipseid_link (guild_id, user_id, platform, value, visibility, added_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id, platform) DO UPDATE SET value = excluded.value, visibility = excluded.visibility, added_at = excluded.added_at`, ctx.guildId, i.user.id, platform, r.value, vis, Date.now());
    return reply(`Saved your ${LINK_PLATFORMS[platform].label} name **${r.value}** (${vis === 'public' ? 'everyone can see it' : vis === 'staff' ? 'staff only' : 'only you can see it'}). It is shown as *not verified*: I only checked that it looks right.`);
  }
  if (sub === 'unlink') {
    const platform = i.options.getString('platform', true);
    const r = ctx.sql.run('DELETE FROM eclipseid_link WHERE guild_id = ? AND user_id = ? AND platform = ?', ctx.guildId, i.user.id, platform);
    if (!r.changes) throw new UserError('You have nothing linked for that platform.');
    return reply('Removed.');
  }
  if (sub === 'delete') {
    ctx.sql.run('DELETE FROM eclipseid_profile WHERE guild_id = ? AND user_id = ?', ctx.guildId, i.user.id);
    ctx.sql.run('DELETE FROM eclipseid_link WHERE guild_id = ? AND user_id = ?', ctx.guildId, i.user.id);
    return reply('Your Eclipse ID card and linked accounts in this server were erased.');
  }
  if (sub === 'roblox') {
    if (!ctx.config.get('robloxLookup')) throw new UserError('Roblox lookup is turned off on this server.');
    const name = String(i.options.getString('name', true)).trim();
    const n = normalizeLink('roblox', name); if (n.error) throw new UserError(n.error);
    await i.deferReply({ flags: EPH });
    const r = await lookupRoblox(n.value, fetchHook());
    if (r.error) return i.editReply({ content: `I couldn't check that: ${r.error}` });
    if (!r.found) return i.editReply({ content: `Roblox says there is no account named **${n.value}**.` });
    return i.editReply({ content: `Roblox has an account **${r.name}** (id ${r.id}${r.displayName ? `, display name ${r.displayName}` : ''}). That only shows the name exists, not that it is yours. Add it with \`/id link platform:roblox\`.`, allowedMentions: NOPING });
  }
}

const choices = (obj) => Object.entries(obj).map(([value, o]) => ({ name: o.label, value }));

export default {
  name: 'eclipseid',
  version: '1.0.0',
  description: 'A member-controlled gaming profile: favourite games, platforms, availability, linked game account names, with per-field privacy.',
  settings: [
    { key: 'robloxLookup', type: 'toggle', label: 'Let /id roblox check that a Roblox username exists (contacts Roblox)', default: false },
  ],
  permissions: [
    { key: 'eclipseid.use', label: 'Have and view Eclipse ID cards', default: 'everyone' },
    { key: 'eclipseid.staff', label: 'See profile fields members shared with staff only', default: 'moderator' },
  ],
  commands: [{
    permission: 'eclipseid.use',
    ownPopup: ['edit'], // opens its own popup when run with nothing filled in
    data: new SlashCommandBuilder().setName('id').setDescription('Your Eclipse ID gaming profile')
      .addSubcommand((s) => s.setName('show').setDescription('Show a card').addUserOption((o) => o.setName('member').setDescription('Whose')))
      .addSubcommand((s) => s.setName('edit').setDescription('Fill in your card'))
      .addSubcommand((s) => s.setName('privacy').setDescription('Who can see a part of your card')
        .addStringOption((o) => o.setName('field').setDescription('Which part').setRequired(true).addChoices(...choices(FIELDS)))
        .addStringOption((o) => o.setName('who').setDescription('Who').setRequired(true).addChoices({ name: 'everyone in the server', value: 'public' }, { name: 'staff only', value: 'staff' }, { name: 'only me', value: 'private' }))
        .addStringOption((o) => o.setName('platform').setDescription('For linked accounts: just this one').addChoices(...choices(LINK_PLATFORMS))))
      .addSubcommand((s) => s.setName('link').setDescription('Add a game account name (not verified)')
        .addStringOption((o) => o.setName('platform').setDescription('Which game or platform').setRequired(true).addChoices(...choices(LINK_PLATFORMS)))
        .addStringOption((o) => o.setName('name').setDescription('Your name there').setRequired(true).setMaxLength(40))
        .addStringOption((o) => o.setName('who').setDescription('Who can see it (default: only me)').addChoices({ name: 'everyone in the server', value: 'public' }, { name: 'staff only', value: 'staff' }, { name: 'only me', value: 'private' })))
      .addSubcommand((s) => s.setName('unlink').setDescription('Remove a game account').addStringOption((o) => o.setName('platform').setDescription('Which one').setRequired(true).addChoices(...choices(LINK_PLATFORMS))))
      .addSubcommand((s) => s.setName('roblox').setDescription('Check that a Roblox username exists').addStringOption((o) => o.setName('name').setDescription('Username').setRequired(true).setMaxLength(20)))
      .addSubcommand((s) => s.setName('delete').setDescription('Erase your card and linked accounts in this server')),
    execute: idCmd,
  }],
  components: [{ prefix: 'eid:', execute: onSubmit }],
  migrations: [{ id: 1, sql: `
    CREATE TABLE IF NOT EXISTS eclipseid_ids (eid INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS eclipseid_profile (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', games TEXT NOT NULL DEFAULT '', platforms TEXT NOT NULL DEFAULT '',
      availability TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', vis TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
    CREATE TABLE IF NOT EXISTS eclipseid_link (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, platform TEXT NOT NULL, value TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'private', added_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id, platform));
  ` }],
};
