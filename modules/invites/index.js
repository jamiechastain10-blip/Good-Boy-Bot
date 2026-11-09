/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Invite tracking (3.1): who invited each new member, worked out by comparing invite use counts before and after a
 * join (Discord does not say directly). Counts per member: joined, still here, left, and brand-new accounts (often
 * alts). /invites user [member], /invites top, and an optional "joined, invited by" line in a channel.
 * Needs the bot's Manage Server permission to read the invite list.
 */
import { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits as P } from 'discord.js';
import { UserError, truncate } from '../../src/util.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const cache = (globalThis[Symbol.for('goodboy.invites.cache')] ??= new Map()); // guild id -> Map(code -> { uses, inviter, max })

/**
 * Which invite was used, from the counts before and after a join. Exported for tests.
 * before/after: Map(code -> { uses, inviter, max }). Returns { code, inviter } or null.
 */
export function usedInvite(before, after) {
  for (const [code, a] of after) { const b = before.get(code); if (a.uses > (b?.uses ?? 0)) return { code, inviter: a.inviter ?? b?.inviter ?? null }; }
  // An invite with a use limit disappears when its last use is taken.
  const gone = [...before].filter(([code, b]) => !after.has(code) && b.max && b.uses + 1 >= b.max);
  return gone.length === 1 ? { code: gone[0][0], inviter: gone[0][1].inviter ?? null } : null;
}
const snapshot = (invites) => new Map([...invites.values()].map((i) => [i.code, { uses: i.uses ?? 0, inviter: i.inviter?.id ?? i.inviterId ?? null, max: i.maxUses ?? 0 }]));
async function readInvites(guild) {
  const me = guild.members?.me;
  if (me && !me.permissions?.has?.(P.ManageGuild)) return null;
  const list = await guild.invites?.fetch?.().catch(() => null);
  return list ? snapshot(list) : null;
}
async function refresh(ctx) { const g = ctx.guild; if (!g) return; const s = await readInvites(g); if (s) cache.set(ctx.guildId, s); }

async function onJoin(ctx, member) {
  if (member.user?.bot) return;
  const before = cache.get(ctx.guildId) ?? new Map();
  const after = await readInvites(member.guild);
  if (after) cache.set(ctx.guildId, after);
  let used = after ? usedInvite(before, after) : null;
  if (!used && member.guild.vanityURLCode) used = { code: member.guild.vanityURLCode, inviter: null, vanity: true };
  const ageDays = (Date.now() - (member.user?.createdTimestamp ?? Date.now())) / 86400000;
  const fresh = ageDays < ctx.config.get('newAccountDays') ? 1 : 0;
  ctx.sql.run('INSERT OR REPLACE INTO invites_joins (guild_id, member_id, inviter_id, code, joined_at, left_at, new_account) VALUES (?, ?, ?, ?, ?, NULL, ?)',
    ctx.guildId, member.id, used?.inviter ?? null, used?.code ?? null, Date.now(), fresh);
  const ch = ctx.guild?.channels.cache.get(ctx.config.get('logChannel'));
  if (ch?.send) {
    const total = used?.inviter ? stats(ctx, used.inviter) : null;
    const line = used?.inviter ? `👋 <@${member.id}> joined, invited by <@${used.inviter}> (${total.here} invite${total.here === 1 ? '' : 's'})${fresh ? ' · ⚠️ new account' : ''}`
      : used?.vanity ? `👋 <@${member.id}> joined with the server's custom link (discord.gg/${used.code})` : `👋 <@${member.id}> joined (couldn't tell which invite)`;
    await ch.send({ content: line, allowedMentions: NOPING }).catch(() => {});
  }
}
function onLeave(ctx, member) {
  ctx.sql.run('UPDATE invites_joins SET left_at = ? WHERE guild_id = ? AND member_id = ? AND left_at IS NULL', Date.now(), ctx.guildId, member.id);
}
/** An inviter's numbers: joined (everyone they brought in), here (still in the server), left, fresh (new accounts). */
export function stats(ctx, inviterId) {
  const r = ctx.sql.get(`SELECT COUNT(*) AS joined, SUM(CASE WHEN left_at IS NULL THEN 1 ELSE 0 END) AS here, SUM(CASE WHEN left_at IS NOT NULL THEN 1 ELSE 0 END) AS left,
    SUM(new_account) AS fresh FROM invites_joins WHERE guild_id = ? AND inviter_id = ?`, ctx.guildId, inviterId);
  return { joined: r.joined ?? 0, here: r.here ?? 0, left: r.left ?? 0, fresh: r.fresh ?? 0 };
}

async function invitesCommand(ctx, i) {
  const sub = i.options.getSubcommand();
  if (sub === 'top') {
    const rows = ctx.sql.all(`SELECT inviter_id AS id, SUM(CASE WHEN left_at IS NULL THEN 1 ELSE 0 END) AS here, COUNT(*) AS joined FROM invites_joins
      WHERE guild_id = ? AND inviter_id IS NOT NULL GROUP BY inviter_id ORDER BY here DESC, joined DESC LIMIT 10`, ctx.guildId);
    if (!rows.length) return i.reply({ content: "Nobody's invites have been tracked yet. They count from when invite tracking was turned on.", flags: EPH });
    const medal = ['🥇', '🥈', '🥉'];
    const e = new EmbedBuilder().setColor(0x6b93ff).setTitle('📨 Top inviters').setDescription(rows.map((r, k) => `${medal[k] ?? `**${k + 1}.**`} <@${r.id}> · **${r.here}** here (${r.joined} joined)`).join('\n'));
    return i.reply({ embeds: [e], allowedMentions: NOPING });
  }
  const who = i.options.getUser('member') ?? i.user;
  const s = stats(ctx, who.id);
  const by = ctx.sql.get('SELECT inviter_id, code FROM invites_joins WHERE guild_id = ? AND member_id = ?', ctx.guildId, who.id);
  const e = new EmbedBuilder().setColor(0x6b93ff).setTitle(`📨 ${truncate(ctx.guild?.members.cache.get(who.id)?.displayName ?? who.username, 60)}'s invites`)
    .setDescription(`**${s.here}** still here · ${s.joined} joined · ${s.left} left${s.fresh ? ` · ${s.fresh} new account${s.fresh === 1 ? '' : 's'}` : ''}`)
    .setFooter({ text: by?.inviter_id ? 'Invited by someone in the server' : by?.code ? `Joined with discord.gg/${by.code}` : 'Counted since invite tracking was turned on' });
  if (by?.inviter_id) e.addFields({ name: 'Invited by', value: `<@${by.inviter_id}>`, inline: true });
  return i.reply({ embeds: [e], allowedMentions: NOPING });
}

export default {
  name: 'invites',
  version: '1.0.0',
  description: 'Tracks who invited each new member, with counts and a leaderboard',
  settings: [
    { key: 'logChannel', type: 'channel', label: 'Post "joined, invited by…" here (optional)' },
    { key: 'newAccountDays', type: 'number', label: 'Count accounts younger than this many days as new', default: 7, min: 0, max: 90 },
  ],
  permissions: [{ key: 'invites.view', label: 'See invite counts', default: 'everyone' }],
  migrations: [{ id: 1, sql: `
    CREATE TABLE IF NOT EXISTS invites_joins (guild_id TEXT NOT NULL, member_id TEXT NOT NULL, inviter_id TEXT, code TEXT, joined_at INTEGER NOT NULL, left_at INTEGER, new_account INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, member_id));
    CREATE INDEX IF NOT EXISTS invites_joins_inviter ON invites_joins (guild_id, inviter_id);
  ` }],
  commands: [{
    permission: 'invites.view', defer: 'public',
    data: new SlashCommandBuilder().setName('invites').setDescription('Who invited whom')
      .addSubcommand((s) => s.setName('user').setDescription("Someone's invite count").addUserOption((o) => o.setName('member').setDescription('Who (you if empty)')))
      .addSubcommand((s) => s.setName('top').setDescription('Top inviters')),
    execute: invitesCommand,
  }],
  events: {
    guildMemberAdd: onJoin,
    guildMemberRemove: onLeave,
    inviteCreate: (ctx, inv) => { const m = cache.get(ctx.guildId) ?? cache.set(ctx.guildId, new Map()).get(ctx.guildId); m.set(inv.code, { uses: inv.uses ?? 0, inviter: inv.inviter?.id ?? inv.inviterId ?? null, max: inv.maxUses ?? 0 }); },
    inviteDelete: (ctx, inv) => { setTimeout(() => cache.get(ctx.guildId)?.delete(inv.code), 3000).unref?.(); }, // a join may still need it
  },
  panels: [{ id: 'top', title: 'Top inviters', view: 'top', permission: 'invites.view', empty: 'No invites tracked yet.',
    columns: [{ key: 'name', label: 'Member' }, { key: 'here', label: 'Still here' }, { key: 'joined', label: 'Joined' }, { key: 'left', label: 'Left' }, { key: 'fresh', label: 'New accounts' }] }],
  views: {
    async top(ctx) {
      return { rows: ctx.sql.all(`SELECT inviter_id AS id, COUNT(*) AS joined, SUM(CASE WHEN left_at IS NULL THEN 1 ELSE 0 END) AS here, SUM(CASE WHEN left_at IS NOT NULL THEN 1 ELSE 0 END) AS left, SUM(new_account) AS fresh
        FROM invites_joins WHERE guild_id = ? AND inviter_id IS NOT NULL GROUP BY inviter_id ORDER BY here DESC LIMIT 50`, ctx.guildId).map((r) => ({ ...r, name: ctx.guild?.members.cache.get(r.id)?.displayName ?? r.id })) };
    },
  },
  tasks: [{ name: 'refresh', everyMs: 15 * 60000, runOnEnable: true, run: refresh }],
};
