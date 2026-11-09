/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Families (3.1): marry, divorce, adopt, disown, leave your family, and a family tree picture.
 *   /marry @member                 proposes; they press Accept or Decline (10 minutes)
 *   /family tree [member]          the family tree as a picture (text if pictures can't be drawn)
 *   /family info [member]          partner(s), parent, children and siblings
 *   /family adopt @member          asks them to join your family as your child
 *   /family divorce [partner]      ends a marriage (with a confirm button)
 *   /family disown @child          removes a child from your family (with a confirm button)
 *   /family leave                  leave your parent's family
 * Families are per server. The rules (no marrying family, one parent per child, limits) live in src/familytree.js.
 */
import { randomBytes } from 'node:crypto';
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, AttachmentBuilder } from 'discord.js';
import { UserError, truncate } from '../../src/util.js';
import * as FT from '../../src/familytree.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const PROPOSAL_MS = 10 * 60000;
const PINK = 0xff6b9a, BLUE = 0x6b93ff;

const pairKey = (a, b) => (a < b ? [a, b] : [b, a]);
function graph(ctx) {
  return FT.buildGraph(ctx.sql.all('SELECT a, b FROM family_partners WHERE guild_id = ?', ctx.guildId), ctx.sql.all('SELECT parent, child FROM family_children WHERE guild_id = ?', ctx.guildId));
}
const nameOf = (ctx, id) => ctx.guild?.members.cache.get(id)?.displayName ?? ctx.client?.users?.cache?.get(id)?.globalName ?? ctx.client?.users?.cache?.get(id)?.username ?? 'Someone';
const limits = (ctx) => ({ maxPartners: ctx.config.get('maxPartners'), maxChildren: ctx.config.get('maxChildren') });
function checkTarget(user, self) {
  if (!user) throw new UserError('Pick a member.');
  if (user.bot) throw new UserError("Bots can't join families.");
  if (user.id === self) throw new UserError("That's you!");
}
const since = (t) => `<t:${Math.floor(t / 1000)}:D>`;

// ------------------------------------------------------------------ proposals (marry / adopt)
function propose(ctx, kind, from, to) {
  const token = randomBytes(5).toString('hex');
  ctx.data.set(`prop:${token}`, { kind, from, to, at: Date.now() });
  return token;
}
const proposalRow = (token) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`fam:yes:${token}`).setLabel('Accept').setEmoji('💍').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`fam:no:${token}`).setLabel('Decline').setStyle(ButtonStyle.Secondary));

async function marryCommand(ctx, i) {
  const target = i.options.getUser('member');
  checkTarget(target, i.user.id);
  const why = FT.marryProblem(graph(ctx), i.user.id, target.id, limits(ctx));
  if (why) throw new UserError(why);
  const token = propose(ctx, 'marry', i.user.id, target.id);
  const e = new EmbedBuilder().setColor(PINK).setTitle('💍 A proposal!').setDescription(`<@${i.user.id}> is asking <@${target.id}> to marry them.\n<@${target.id}>, will you say yes?`).setFooter({ text: 'This proposal ends in 10 minutes.' });
  return i.reply({ content: `<@${target.id}>`, embeds: [e], components: [proposalRow(token)], allowedMentions: { users: [target.id] } });
}
async function adopt(ctx, i, target) {
  checkTarget(target, i.user.id);
  const why = FT.adoptProblem(graph(ctx), i.user.id, target.id, limits(ctx));
  if (why) throw new UserError(why);
  const token = propose(ctx, 'adopt', i.user.id, target.id);
  const e = new EmbedBuilder().setColor(BLUE).setTitle('🏡 An adoption request').setDescription(`<@${i.user.id}> would like to adopt <@${target.id}>.\n<@${target.id}>, do you want to join their family?`).setFooter({ text: 'This request ends in 10 minutes.' });
  return i.reply({ content: `<@${target.id}>`, embeds: [e], components: [proposalRow(token)], allowedMentions: { users: [target.id] } });
}
async function answer(ctx, i, token, yes) {
  const p = ctx.data.get(`prop:${token}`);
  if (!p || Date.now() - p.at > PROPOSAL_MS) { ctx.data.delete(`prop:${token}`); return i.update({ components: [], embeds: [new EmbedBuilder().setColor(0x95a5a6).setDescription('This request has ended.')] }); }
  if (i.user.id !== p.to) {
    if (i.user.id === p.from && !yes) { ctx.data.delete(`prop:${token}`); return i.update({ components: [], embeds: [new EmbedBuilder().setColor(0x95a5a6).setDescription(`<@${p.from}> took the ${p.kind === 'marry' ? 'proposal' : 'request'} back.`)], content: null }); }
    throw new UserError(`Only <@${p.to}> can answer this.`);
  }
  ctx.data.delete(`prop:${token}`);
  if (!yes) return i.update({ content: null, components: [], embeds: [new EmbedBuilder().setColor(0x95a5a6).setDescription(p.kind === 'marry' ? `💔 <@${p.to}> said no to <@${p.from}>.` : `<@${p.to}> said no thanks to joining <@${p.from}>'s family.`)], allowedMentions: NOPING });
  const g = graph(ctx), now = Date.now();
  if (p.kind === 'marry') {
    const why = FT.marryProblem(g, p.from, p.to, limits(ctx));
    if (why) throw new UserError(`It can't happen any more: ${why}`);
    const [a, b] = pairKey(p.from, p.to);
    ctx.sql.run('INSERT OR IGNORE INTO family_partners (guild_id, a, b, since) VALUES (?, ?, ?, ?)', ctx.guildId, a, b, now);
    ctx.live?.('activity', { icon: '💍', text: `${nameOf(ctx, p.from)} and ${nameOf(ctx, p.to)} got married` });
    return i.update({ content: null, components: [], embeds: [new EmbedBuilder().setColor(PINK).setTitle('💒 Just married!').setDescription(`<@${p.from}> and <@${p.to}> are now married. Congratulations! 🎉`)], allowedMentions: NOPING });
  }
  const why = FT.adoptProblem(g, p.from, p.to, limits(ctx));
  if (why) throw new UserError(`It can't happen any more: ${why}`);
  ctx.sql.run('INSERT OR IGNORE INTO family_children (guild_id, child, parent, since) VALUES (?, ?, ?, ?)', ctx.guildId, p.to, p.from, now);
  ctx.live?.('activity', { icon: '🏡', text: `${nameOf(ctx, p.from)} adopted ${nameOf(ctx, p.to)}` });
  return i.update({ content: null, components: [], embeds: [new EmbedBuilder().setColor(BLUE).setTitle('🏡 Welcome to the family!').setDescription(`<@${p.from}> adopted <@${p.to}>.`)], allowedMentions: NOPING });
}

// ------------------------------------------------------------------ leaving
const confirmRow = (id, label) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId('fam:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary));
async function divorceAsk(ctx, i, target) {
  const mine = [...(graph(ctx).partners.get(i.user.id) ?? [])];
  if (!mine.length) throw new UserError("You're not married.");
  const who = target?.id ?? (mine.length === 1 ? mine[0] : null);
  if (!who) throw new UserError('You have more than one partner. Say which one: `/family divorce partner:@them`.');
  if (!mine.includes(who)) throw new UserError("You're not married to them.");
  return i.reply({ content: `Divorce <@${who}>? This can't be undone (you'd have to marry again).`, components: [confirmRow(`fam:div:${who}:${i.user.id}`, 'Divorce')], flags: EPH, allowedMentions: NOPING });
}
async function disownAsk(ctx, i, target) {
  if (!target) throw new UserError('Pick the child to disown.');
  if (graph(ctx).parentOf.get(target.id) !== i.user.id) throw new UserError("They're not your child.");
  return i.reply({ content: `Disown <@${target.id}>? Their own children stay with them.`, components: [confirmRow(`fam:dis:${target.id}:${i.user.id}`, 'Disown')], flags: EPH, allowedMentions: NOPING });
}
async function leaveAsk(ctx, i) {
  const parent = graph(ctx).parentOf.get(i.user.id);
  if (!parent) throw new UserError("You don't have a parent here.");
  return i.reply({ content: `Leave <@${parent}>'s family? Your partner and children stay with you.`, components: [confirmRow(`fam:lv:${parent}:${i.user.id}`, 'Leave the family')], flags: EPH, allowedMentions: NOPING });
}

// ------------------------------------------------------------------ looking
async function peopleMap(ctx, ids) {
  const m = new Map();
  for (const id of ids) {
    const mem = ctx.guild?.members.cache.get(id) ?? await ctx.guild?.members.fetch(id).catch(() => null);
    const user = mem?.user ?? await ctx.client?.users?.fetch?.(id).catch(() => null);
    m.set(id, { name: mem?.displayName ?? user?.globalName ?? user?.username ?? 'Someone', avatarUrl: user?.displayAvatarURL?.({ extension: 'png', size: 64, forceStatic: true }) ?? null });
  }
  return m;
}
async function treeCommand(ctx, i, target) {
  const who = target ?? i.user;
  const g = graph(ctx);
  const fam = FT.familyOf(g, who.id);
  if (fam.size === 1) throw new UserError(who.id === i.user.id ? "You don't have a family yet. Try `/marry` or `/family adopt`." : `${nameOf(ctx, who.id)} doesn't have a family yet.`);
  await i.deferReply();
  const tree = FT.treeFrom(g, FT.rootOf(g, who.id));
  const ids = [];
  (function collect(u) { if (!u) return; ids.push(...u.people); u.children.forEach(collect); })(tree);
  const people = await peopleMap(ctx, ids);
  const name = (id) => people.get(id)?.name ?? 'Someone';
  const title = `${name(who.id)}'s family`;
  const png = ctx.config.get('pictures') !== false && FT.countPeople(tree) <= 60 ? await FT.treeImage(tree, people, { highlight: who.id, title }).catch(() => null) : null;
  const e = new EmbedBuilder().setColor(PINK).setTitle(`🌳 ${title}`).setFooter({ text: `${FT.countPeople(tree)} people · ${fam.size > FT.countPeople(tree) ? 'too big to show everyone' : 'the whole family'}` });
  if (png) { e.setImage('attachment://family.png'); return i.editReply({ embeds: [e], files: [new AttachmentBuilder(png, { name: 'family.png' })], allowedMentions: NOPING }); }
  e.setDescription(truncate(FT.treeText(tree, name, { highlight: who.id }), 4000));
  return i.editReply({ embeds: [e], allowedMentions: NOPING });
}
async function infoCommand(ctx, i, target) {
  const who = target ?? i.user, g = graph(ctx);
  const partners = ctx.sql.all('SELECT a, b, since FROM family_partners WHERE guild_id = ? AND (a = ? OR b = ?)', ctx.guildId, who.id, who.id);
  const parentRow = ctx.sql.get('SELECT parent, since FROM family_children WHERE guild_id = ? AND child = ?', ctx.guildId, who.id);
  const kids = [...(g.childrenOf.get(who.id) ?? [])], siblings = parentRow ? [...(g.childrenOf.get(parentRow.parent) ?? [])].filter((x) => x !== who.id) : [];
  const e = new EmbedBuilder().setColor(PINK).setTitle(`👪 ${nameOf(ctx, who.id)}`).addFields(
    { name: partners.length > 1 ? 'Partners' : 'Partner', value: partners.length ? partners.map((p) => `<@${p.a === who.id ? p.b : p.a}> since ${since(p.since)}`).join('\n') : 'Single', inline: false },
    { name: 'Parent', value: parentRow ? `<@${parentRow.parent}> since ${since(parentRow.since)}` : 'None', inline: true },
    { name: `Children (${kids.length})`, value: kids.length ? kids.slice(0, 15).map((k) => `<@${k}>`).join(' ') : 'None', inline: true },
    { name: `Siblings (${siblings.length})`, value: siblings.length ? siblings.slice(0, 15).map((k) => `<@${k}>`).join(' ') : 'None', inline: true },
  ).setFooter({ text: `Family size: ${FT.familyOf(g, who.id).size}` });
  return i.reply({ embeds: [e], allowedMentions: NOPING });
}

async function familyCommand(ctx, i) {
  const sub = i.options.getSubcommand();
  const target = i.options.getUser('member');
  if (sub === 'tree') return treeCommand(ctx, i, target);
  if (sub === 'info') return infoCommand(ctx, i, target);
  if (sub === 'adopt') return adopt(ctx, i, target);
  if (sub === 'divorce') return divorceAsk(ctx, i, i.options.getUser('partner'));
  if (sub === 'disown') return disownAsk(ctx, i, target);
  if (sub === 'leave') return leaveAsk(ctx, i);
  throw new UserError('Unknown option.');
}

async function onButton(ctx, i) {
  const [, action, a, b] = i.customId.split(':');
  if (action === 'yes' || action === 'no') return answer(ctx, i, a, action === 'yes');
  if (action === 'cancel') return i.update({ content: 'Cancelled.', components: [] });
  if (b !== i.user.id) throw new UserError('That button is for someone else.');
  if (action === 'div') {
    const [x, y] = pairKey(a, b);
    const r = ctx.sql.run('DELETE FROM family_partners WHERE guild_id = ? AND a = ? AND b = ?', ctx.guildId, x, y);
    if (!r.changes) return i.update({ content: "You're not married to them any more.", components: [] });
    await i.channel?.send?.({ content: `💔 <@${b}> and <@${a}> are divorced.`, allowedMentions: NOPING }).catch(() => {});
    return i.update({ content: 'Divorced.', components: [] });
  }
  if (action === 'dis' || action === 'lv') {
    const child = action === 'dis' ? a : b, parent = action === 'dis' ? b : a;
    const r = ctx.sql.run('DELETE FROM family_children WHERE guild_id = ? AND child = ? AND parent = ?', ctx.guildId, child, parent);
    if (!r.changes) return i.update({ content: 'That already changed.', components: [] });
    await i.channel?.send?.({ content: action === 'dis' ? `<@${parent}> disowned <@${child}>.` : `<@${child}> left <@${parent}>'s family.`, allowedMentions: NOPING }).catch(() => {});
    return i.update({ content: 'Done.', components: [] });
  }
  throw new UserError('Unknown button.');
}

export default {
  name: 'family',
  version: '1.0.0',
  description: 'Marry, adopt and build a family tree with other members',
  memberIntroTitle: 'families',
  memberIntro: 'you can marry people and adopt them now 💍 use /marry, then /family tree to see your whole family as a picture',
  settings: [
    { key: 'maxPartners', type: 'number', label: 'How many partners one person can have', default: 1, min: 1, max: 5 },
    { key: 'maxChildren', type: 'number', label: 'How many children one person can adopt', default: 10, min: 1, max: 30 },
    { key: 'pictures', type: 'toggle', label: 'Show family trees as pictures (text otherwise)', default: true },
  ],
  permissions: [{ key: 'family.use', label: 'Marry, adopt and see family trees', default: 'everyone' }],
  migrations: [{ id: 1, sql: `
    CREATE TABLE IF NOT EXISTS family_partners (guild_id TEXT NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (guild_id, a, b));
    CREATE TABLE IF NOT EXISTS family_children (guild_id TEXT NOT NULL, child TEXT NOT NULL, parent TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (guild_id, child));
    CREATE INDEX IF NOT EXISTS family_children_parent ON family_children (guild_id, parent);
  ` }],
  commands: [
    { permission: 'family.use', defer: 'public', data: new SlashCommandBuilder().setName('marry').setDescription('Ask someone to marry you').addUserOption((o) => o.setName('member').setDescription('Who to propose to').setRequired(true)), execute: marryCommand },
    {
      permission: 'family.use', defer: 'public',
      data: new SlashCommandBuilder().setName('family').setDescription('Your family: tree, adopt, divorce and more')
        .addSubcommand((s) => s.setName('tree').setDescription('See a family tree').addUserOption((o) => o.setName('member').setDescription('Whose family (you if empty)')))
        .addSubcommand((s) => s.setName('info').setDescription('Partner, parent, children and siblings').addUserOption((o) => o.setName('member').setDescription('Who (you if empty)')))
        .addSubcommand((s) => s.setName('adopt').setDescription('Ask someone to join your family as your child').addUserOption((o) => o.setName('member').setDescription('Who to adopt').setRequired(true)))
        .addSubcommand((s) => s.setName('divorce').setDescription('End a marriage').addUserOption((o) => o.setName('partner').setDescription('Only needed if you have more than one partner')))
        .addSubcommand((s) => s.setName('disown').setDescription('Remove one of your children from your family').addUserOption((o) => o.setName('member').setDescription('Which child').setRequired(true)))
        .addSubcommand((s) => s.setName('leave').setDescription("Leave your parent's family")),
      execute: familyCommand,
    },
  ],
  components: [{ prefix: 'fam:', execute: onButton }],
  tasks: [{ name: 'expire', everyMs: 600000, run: (ctx) => { for (const { key, value } of ctx.data.list('prop:')) if (Date.now() - (value?.at ?? 0) > PROPOSAL_MS) ctx.data.delete(key); } }],
};
