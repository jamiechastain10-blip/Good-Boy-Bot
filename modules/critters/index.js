/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Critters (3.1): Good Boy's own collecting game (src/critters.js has the creatures).
 *   - While people chat, a wild critter sometimes appears (every ~30 messages, at most one every 90 seconds, in the
 *     channels staff pick or anywhere). The first to press Catch and type its name keeps it. Hint shows a few letters.
 *   - Your buddy critter gains XP as you chat. /critters battle pits buddies against each other; trade swaps two
 *     critters (both people agree); release lets one go for coins (with the economy module).
 * One slash command, /critters, for everything.
 */
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { randomBytes } from 'node:crypto';
import { UserError, truncate } from '../../src/util.js';
import * as CR from '../../src/critters.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const SPAWN_MS = 3 * 60000, SPAWN_GAP = 90000, TRADE_MS = 5 * 60000, BUDDY_COOLDOWN = 60000;
const spawns = (globalThis[Symbol.for('goodboy.critters.spawns')] ??= new Map()); // guild -> { id, species, iv, sparkly, channelId, messageId, at, hints, by }
const counts = (globalThis[Symbol.for('goodboy.critters.counts')] ??= new Map()); // guild -> { n, need, last }
const pending = (globalThis[Symbol.for('goodboy.critters.pending')] ??= new Map()); // token -> trade or battle offer
const buddyAt = (globalThis[Symbol.for('goodboy.critters.buddyAt')] ??= new Map()); // guild:user -> time
const rand = () => (globalThis[Symbol.for('goodboy.critters.rand')] ?? Math.random)();
const token = () => randomBytes(5).toString('hex');

const rowOf = (r) => ({ ...r, iv: { hp: r.iv_hp, atk: r.iv_atk, def: r.iv_def, spd: r.iv_spd } });
const getOwned = (ctx, id) => { const r = ctx.sql.get('SELECT * FROM critters_owned WHERE guild_id = ? AND id = ?', ctx.guildId, id); return r ? rowOf(r) : null; };
const mine = (ctx, userId, id) => { const c = getOwned(ctx, id); if (!c || c.user_id !== userId) throw new UserError(`You don't have a critter #${id}. See \`/critters list\`.`); return c; };
const buddyOf = (ctx, userId) => { const p = ctx.sql.get('SELECT buddy_id FROM critters_profile WHERE guild_id = ? AND user_id = ?', ctx.guildId, userId); const c = p?.buddy_id ? getOwned(ctx, p.buddy_id) : null; return c && c.user_id === userId ? c : null; };
const label = (c) => { const sp = CR.speciesById(c.species); return `${c.sparkly ? '✨ ' : ''}**${c.nickname ? `${c.nickname} (${sp.name})` : sp.name}** · Lv ${c.level}`; };
const elementTag = (sp) => `${CR.ELEMENTS[sp.element].emoji} ${CR.ELEMENTS[sp.element].label}`;

async function withPicture(e, speciesId, opts, name = 'critter.png') {
  const png = await CR.critterImage(speciesId, opts).catch(() => null);
  if (!png) return { embeds: [e], files: [] };
  e.setThumbnail?.(null); e.setImage(`attachment://${name}`);
  return { embeds: [e], files: [{ attachment: png, name }] };
}

// ------------------------------------------------------------------ spawning
/** Makes a wild critter appear in a channel. Exported for tests (and /critters spawn). */
export async function spawn(ctx, channel, wild = CR.rollWild(rand)) {
  const old = spawns.get(ctx.guildId);
  if (old) await expire(ctx, old, true);
  const sp = CR.speciesById(wild.species), id = token();
  const s = { id, ...wild, channelId: channel.id, at: Date.now(), hints: 1, messageId: null };
  spawns.set(ctx.guildId, s);
  const e = new EmbedBuilder().setColor(wild.sparkly ? 0xf1c40f : CR.RARITIES[sp.rarity].color).setTitle(`${wild.sparkly ? '✨ A sparkly' : 'A wild'} critter appeared!`)
    .setDescription(`It's a ${CR.RARITIES[sp.rarity].label.toLowerCase()} ${elementTag(sp)} critter. Press **Catch** and type its name to keep it!\n\`${CR.hint(sp.name, 1)}\``).setFooter({ text: 'It runs away in 3 minutes.' });
  const msg = await channel.send({ ...(await withPicture(e, sp.id, { sparkly: wild.sparkly })), components: [spawnRow(id)] }).catch(() => null);
  if (!msg) { spawns.delete(ctx.guildId); return null; }
  s.messageId = msg.id;
  const t = setTimeout(() => { if (spawns.get(ctx.guildId)?.id === id) expire(ctx, s).catch(() => {}); }, SPAWN_MS); t.unref?.();
  return s;
}
const spawnRow = (id, done = false) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`crit:catch:${id}`).setLabel('Catch').setEmoji('🫳').setStyle(ButtonStyle.Success).setDisabled(done),
  new ButtonBuilder().setCustomId(`crit:hint:${id}`).setLabel('Hint').setEmoji('💡').setStyle(ButtonStyle.Secondary).setDisabled(done));
async function expire(ctx, s, replaced = false) {
  if (spawns.get(ctx.guildId)?.id === s.id) spawns.delete(ctx.guildId);
  const ch = ctx.guild?.channels.cache.get(s.channelId);
  const msg = s.messageId ? await ch?.messages?.fetch?.(s.messageId).catch(() => null) : null;
  await msg?.edit({ embeds: [new EmbedBuilder().setColor(0x95a5a6).setTitle(`The ${CR.speciesById(s.species).name} ${replaced ? 'wandered off' : 'ran away'}...`)], components: [], attachments: [] }).catch(() => {});
}

async function onMessage(ctx, m) {
  if (!m.guildId || m.author?.bot || m.webhookId) return;
  // Buddy XP for chatting.
  if (ctx.config.get('buddyXp')) {
    const k = `${ctx.guildId}:${m.author.id}`, now = Date.now();
    if (now - (buddyAt.get(k) ?? 0) >= BUDDY_COOLDOWN) {
      const b = buddyOf(ctx, m.author.id);
      if (b) {
        buddyAt.set(k, now);
        const r = CR.addXp(b.level, b.xp, 5 + Math.floor(rand() * 6));
        ctx.sql.run('UPDATE critters_owned SET level = ?, xp = ? WHERE id = ?', r.level, r.xp, b.id);
      }
    }
  }
  // Spawns.
  if (!ctx.config.get('spawns')) return;
  const where = ctx.data.get('channels') ?? [];
  if (where.length && !where.includes(m.channelId)) return;
  const c = counts.get(ctx.guildId) ?? { n: 0, need: 0, last: 0 };
  const every = ctx.config.get('spawnEvery');
  if (!c.need) c.need = Math.max(3, Math.round(every * (0.6 + rand() * 0.8)));
  c.n += 1;
  counts.set(ctx.guildId, c);
  if (c.n < c.need || Date.now() - c.last < SPAWN_GAP) return;
  counts.set(ctx.guildId, { n: 0, need: 0, last: Date.now() });
  await spawn(ctx, m.channel);
}

// ------------------------------------------------------------------ catching
async function onComponent(ctx, i) {
  const [, kind, id, extra] = i.customId.split(':');
  if (kind === 'catch' || kind === 'hint') {
    const s = spawns.get(ctx.guildId);
    if (!s || s.id !== id) throw new UserError('Too late, that critter is gone.');
    if (kind === 'hint') {
      s.hints = Math.min(s.hints + 1, Math.ceil(CR.speciesById(s.species).name.length * 0.6));
      return i.reply({ content: `💡 \`${CR.hint(CR.speciesById(s.species).name, s.hints)}\``, flags: EPH });
    }
    return i.showModal(new ModalBuilder().setCustomId(`crit:name:${id}`).setTitle('Catch it!').addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('name').setLabel("What's its name?").setStyle(TextInputStyle.Short).setMaxLength(30).setRequired(true))));
  }
  if (kind === 'name') {
    const s = spawns.get(ctx.guildId);
    if (!s || s.id !== id) throw new UserError('Too late, that critter is gone.');
    const sp = CR.speciesById(s.species);
    if (!CR.nameMatches(i.fields.getTextInputValue('name'), sp.name)) throw new UserError("That's not its name! Try again (the Hint button shows some letters).");
    spawns.delete(ctx.guildId); // first right answer wins, even if two arrive together
    const r = ctx.sql.run('INSERT INTO critters_owned (guild_id, user_id, species, level, xp, iv_hp, iv_atk, iv_def, iv_spd, sparkly, caught_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)',
      ctx.guildId, i.user.id, sp.id, 1 + Math.floor(rand() * 10), s.iv.hp, s.iv.atk, s.iv.def, s.iv.spd, s.sparkly ? 1 : 0, Date.now());
    const newId = Number(r.lastInsertRowid);
    ctx.sql.run('INSERT INTO critters_profile (guild_id, user_id, buddy_id, caught) VALUES (?, ?, ?, 1) ON CONFLICT(guild_id, user_id) DO UPDATE SET caught = caught + 1, buddy_id = COALESCE(buddy_id, excluded.buddy_id)', ctx.guildId, i.user.id, newId);
    const first = ctx.sql.get('SELECT COUNT(*) AS n FROM critters_owned WHERE guild_id = ? AND user_id = ? AND species = ?', ctx.guildId, i.user.id, sp.id).n === 1;
    const c = getOwned(ctx, newId);
    ctx.live?.('activity', { icon: '🫳', text: `${i.member?.displayName ?? i.user.username} caught ${s.sparkly ? 'a sparkly ' : 'a '}${sp.name}` });
    const ch = ctx.guild?.channels.cache.get(s.channelId);
    const msg = s.messageId ? await ch?.messages?.fetch?.(s.messageId).catch(() => null) : null;
    await msg?.edit({ components: [spawnRow(id, true)] }).catch(() => {});
    return i.reply({ content: `🎉 <@${i.user.id}> caught ${label(c)} (#${newId}, ${CR.quality(c.iv)}% quality)!${first ? ' ✨ New to your collection!' : ''}`, allowedMentions: NOPING });
  }
  if (kind === 'trade' || kind === 'battle') return answerOffer(ctx, i, kind, id, extra);
  if (kind === 'release') {
    const [userId, critterId] = [id, Number(extra)];
    if (i.user.id !== userId) throw new UserError('That is not your critter.');
    const c = mine(ctx, userId, critterId);
    const coins = releaseValue(c);
    ctx.sql.run('DELETE FROM critters_owned WHERE id = ?', c.id);
    ctx.sql.run('UPDATE critters_profile SET buddy_id = NULL WHERE guild_id = ? AND user_id = ? AND buddy_id = ?', ctx.guildId, userId, c.id);
    const eco = ctx.api('economy');
    if (eco) eco.credit(ctx.guildId, userId, coins, `released ${CR.speciesById(c.species).name}`);
    return i.update({ content: `👋 ${label(c)} went back to the wild.${eco ? ` You got ${eco.format(ctx.guildId, coins)}.` : ''}`, components: [], allowedMentions: NOPING });
  }
  throw new UserError('That button is no longer active.');
}
/** Coins for releasing a critter: more for rarer, higher-level and sparkly ones. */
export const releaseValue = (c) => Math.round(CR.RARITIES[CR.speciesById(c.species).rarity].value * (1 + c.level / 20) * (c.sparkly ? 10 : 1));

// ------------------------------------------------------------------ trades and battles
async function answerOffer(ctx, i, kind, tok, answer) {
  const o = pending.get(tok);
  if (!o || Date.now() - o.at > TRADE_MS) { pending.delete(tok); throw new UserError('That offer ran out.'); }
  if (i.user.id !== o.to && !(answer === 'no' && i.user.id === o.from)) throw new UserError('That offer is for someone else.');
  pending.delete(tok);
  if (answer === 'no') return i.update({ content: `${kind === 'trade' ? 'Trade' : 'Battle'} ${i.user.id === o.from ? 'called off' : 'declined'}.`, embeds: [], components: [] });
  if (kind === 'trade') {
    let a, b;
    ctx.sql.transaction(() => {
      a = mine(ctx, o.from, o.give); b = mine(ctx, o.to, o.get);
      ctx.sql.run('UPDATE critters_owned SET user_id = ? WHERE id = ?', o.to, a.id);
      ctx.sql.run('UPDATE critters_owned SET user_id = ? WHERE id = ?', o.from, b.id);
      ctx.sql.run('UPDATE critters_profile SET buddy_id = NULL WHERE guild_id = ? AND ((user_id = ? AND buddy_id = ?) OR (user_id = ? AND buddy_id = ?))', ctx.guildId, o.from, a.id, o.to, b.id);
    });
    return i.update({ content: `🤝 Trade done! <@${o.from}> got ${label(b)} and <@${o.to}> got ${label(a)}.`, embeds: [], components: [], allowedMentions: NOPING });
  }
  const A = buddyOf(ctx, o.from), B = buddyOf(ctx, o.to);
  if (!A || !B) throw new UserError('Both of you need a buddy critter (`/critters buddy`).');
  const r = CR.battle(A, B, rand);
  const win = r.winner === 0 ? [o.from, A] : [o.to, B], lose = r.winner === 0 ? [o.to, B] : [o.from, A];
  const gain = 20 + 5 * lose[1].level;
  const up = CR.addXp(win[1].level, win[1].xp, gain);
  ctx.sql.run('UPDATE critters_owned SET level = ?, xp = ? WHERE id = ?', up.level, up.xp, win[1].id);
  const e = new EmbedBuilder().setColor(0xf1c40f).setTitle(`⚔️ ${CR.speciesById(A.species).name} vs ${CR.speciesById(B.species).name}`)
    .setDescription([...r.log.slice(0, 8), '', `🏆 <@${win[0]}>'s ${label(win[1])} wins! +${gain} XP${up.ups ? ` · ⬆️ now level ${up.level}` : ''}`].join('\n'));
  return i.update({ content: null, embeds: [e], components: [], allowedMentions: NOPING });
}
const offerRow = (kind, tok) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`crit:${kind}:${tok}:yes`).setLabel(kind === 'trade' ? 'Accept trade' : 'Fight!').setEmoji(kind === 'trade' ? '🤝' : '⚔️').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`crit:${kind}:${tok}:no`).setLabel('No thanks').setStyle(ButtonStyle.Secondary));

// ------------------------------------------------------------------ /critters
async function crittersCommand(ctx, i) {
  const sub = i.options.getSubcommand();
  if (sub === 'list') {
    const page = Math.max(1, i.options.getInteger('page') ?? 1);
    const total = ctx.sql.get('SELECT COUNT(*) AS n FROM critters_owned WHERE guild_id = ? AND user_id = ?', ctx.guildId, i.user.id).n;
    if (!total) return i.reply({ content: "You haven't caught any critters yet. Keep chatting: wild ones appear now and then!", flags: EPH });
    const rows = ctx.sql.all('SELECT * FROM critters_owned WHERE guild_id = ? AND user_id = ? ORDER BY sparkly DESC, level DESC, id ASC LIMIT 15 OFFSET ?', ctx.guildId, i.user.id, (page - 1) * 15).map(rowOf);
    const buddy = buddyOf(ctx, i.user.id);
    const e = new EmbedBuilder().setColor(0x6b93ff).setTitle(`🫳 Your critters · ${total}`)
      .setDescription(rows.map((c) => `\`#${c.id}\` ${label(c)} · ${elementTag(CR.speciesById(c.species))} · ${CR.quality(c.iv)}%${buddy?.id === c.id ? ' · 🐾 buddy' : ''}`).join('\n') || 'Nothing on this page.')
      .setFooter({ text: `Page ${page} of ${Math.ceil(total / 15)} · /critters info id:<number> for one critter` });
    return i.reply({ embeds: [e], flags: EPH, allowedMentions: NOPING });
  }
  if (sub === 'info') {
    const id = i.options.getInteger('id');
    const c = id ? getOwned(ctx, id) : buddyOf(ctx, i.user.id);
    if (!c) throw new UserError(id ? `There's no critter #${id}.` : "You don't have a buddy yet. Pick one with `/critters buddy`.");
    const sp = CR.speciesById(c.species), st = CR.stats(c);
    const e = new EmbedBuilder().setColor(CR.RARITIES[sp.rarity].color).setTitle(`${c.sparkly ? '✨ ' : ''}${sp.name} #${c.id}${c.nickname ? ` · "${c.nickname}"` : ''}`)
      .setDescription(`${elementTag(sp)} · ${CR.RARITIES[sp.rarity].label} · owned by <@${c.user_id}>\nLevel **${c.level}**${c.level < CR.MAX_LEVEL ? ` · ${c.xp}/${CR.xpToNext(c.level)} XP` : ' (max)'} · quality **${CR.quality(c.iv)}%**`)
      .addFields({ name: 'Stats', value: `❤️ ${st.hp} · ⚔️ ${st.atk} · 🛡️ ${st.def} · 💨 ${st.spd}` }, { name: 'Strong against', value: CR.BEATS[sp.element].map((x) => CR.ELEMENTS[x].label).join(', '), inline: true });
    return i.reply({ ...(await withPicture(e, sp.id, { sparkly: !!c.sparkly })), flags: EPH, allowedMentions: NOPING });
  }
  if (sub === 'buddy') {
    const c = mine(ctx, i.user.id, i.options.getInteger('id', true));
    ctx.sql.run('INSERT INTO critters_profile (guild_id, user_id, buddy_id) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET buddy_id = excluded.buddy_id', ctx.guildId, i.user.id, c.id);
    return i.reply({ content: `🐾 ${label(c)} is your buddy now. It gains XP while you chat and fights in your battles.`, flags: EPH, allowedMentions: NOPING });
  }
  if (sub === 'rename') {
    const c = mine(ctx, i.user.id, i.options.getInteger('id', true));
    const name = String(i.options.getString('name') ?? '').trim().replace(/[*_`~|<>@#]/g, '').slice(0, 20) || null;
    ctx.sql.run('UPDATE critters_owned SET nickname = ? WHERE id = ?', name, c.id);
    return i.reply({ content: name ? `✏️ #${c.id} is now called **${name}**.` : `✏️ #${c.id}'s nickname was removed.`, flags: EPH });
  }
  if (sub === 'dex') {
    const have = new Set(ctx.sql.all('SELECT DISTINCT species FROM critters_owned WHERE guild_id = ? AND user_id = ?', ctx.guildId, i.user.id).map((r) => r.species));
    const lines = Object.entries(CR.ELEMENTS).map(([el, x]) => {
      const list = CR.ALL.filter((s) => s.element === el);
      return `${x.emoji} **${x.label}** ${list.filter((s) => have.has(s.id)).length}/${list.length}: ${list.map((s) => (have.has(s.id) ? s.name : '???')).join(', ')}`;
    });
    const e = new EmbedBuilder().setColor(0x6b93ff).setTitle(`📖 Critter collection · ${have.size}/${CR.ALL.length}`).setDescription(truncate(lines.join('\n'), 4000));
    return i.reply({ embeds: [e], flags: EPH });
  }
  if (sub === 'release') {
    const c = mine(ctx, i.user.id, i.options.getInteger('id', true));
    const eco = ctx.api('economy');
    return i.reply({ content: `Let ${label(c)} go?${eco ? ` You get ${eco.format(ctx.guildId, releaseValue(c))}.` : ''} This can't be undone.`, flags: EPH, allowedMentions: NOPING,
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`crit:release:${i.user.id}:${c.id}`).setLabel('Let it go').setStyle(ButtonStyle.Danger))] });
  }
  if (sub === 'trade' || sub === 'battle') {
    const other = i.options.getUser('member', true);
    if (other.bot || other.id === i.user.id) throw new UserError('Pick another member.');
    const tok = token();
    if (sub === 'trade') {
      const a = mine(ctx, i.user.id, i.options.getInteger('give', true));
      const b = getOwned(ctx, i.options.getInteger('get', true));
      if (!b || b.user_id !== other.id) throw new UserError(`<@${other.id}> doesn't have that critter. Ask them for its number (from \`/critters list\`).`);
      pending.set(tok, { kind: 'trade', from: i.user.id, to: other.id, give: a.id, get: b.id, at: Date.now() });
      return i.reply({ content: `<@${other.id}>, <@${i.user.id}> wants to trade their ${label(a)} for your ${label(b)}.`, components: [offerRow('trade', tok)], allowedMentions: { users: [other.id] } });
    }
    if (!buddyOf(ctx, i.user.id)) throw new UserError('Pick a buddy first with `/critters buddy`.');
    if (!buddyOf(ctx, other.id)) throw new UserError(`<@${other.id}> doesn't have a buddy critter yet.`);
    pending.set(tok, { kind: 'battle', from: i.user.id, to: other.id, at: Date.now() });
    return i.reply({ content: `⚔️ <@${other.id}>, <@${i.user.id}>'s ${label(buddyOf(ctx, i.user.id))} challenges your ${label(buddyOf(ctx, other.id))}!`, components: [offerRow('battle', tok)], allowedMentions: { users: [other.id] } });
  }
  // Staff: where they appear, and a spawn right now.
  if (!ctx.perms.check(i.member, 'critters.admin')) throw new UserError("You don't have permission for that (`critters.admin`).");
  if (sub === 'here') {
    const list = ctx.data.get('channels') ?? [];
    const on = !list.includes(i.channelId);
    ctx.data.set('channels', on ? [...list, i.channelId] : list.filter((x) => x !== i.channelId));
    const now = ctx.data.get('channels');
    return i.reply({ content: on ? `✅ Critters now appear in <#${i.channelId}>${now.length > 1 ? ` (and ${now.length - 1} other channel${now.length === 2 ? '' : 's'})` : ' (only here)'}.` : `Critters no longer appear here.${now.length ? '' : ' With no channels picked, they can appear in any channel.'}`, flags: EPH });
  }
  if (sub === 'spawn') {
    await i.reply({ content: 'Here comes one!', flags: EPH });
    await spawn(ctx, i.channel);
    return;
  }
  throw new UserError('Unknown option.');
}

export default {
  name: 'critters',
  version: '1.0.0',
  description: 'Catch, collect, trade and battle Good Boy\'s own critters that appear while people chat',
  memberIntroTitle: 'critters',
  memberIntro: 'wild critters show up while we chat now 🐾 first to press Catch and type its name keeps it. /critters to see yours, pick a buddy, trade and battle',
  settings: [
    { key: 'spawns', type: 'toggle', label: 'Wild critters appear while people chat', default: true },
    { key: 'spawnEvery', type: 'number', label: 'About how many messages between critters', default: 30, min: 5, max: 1000 },
    { key: 'buddyXp', type: 'toggle', label: 'Buddy critters gain XP when their owner chats', default: true },
  ],
  permissions: [{ key: 'critters.use', label: 'Catch and collect critters', default: 'everyone' }, { key: 'critters.admin', label: 'Choose where critters appear, and make one appear', default: 'admin' }],
  migrations: [{ id: 1, sql: `
    CREATE TABLE IF NOT EXISTS critters_owned (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, species TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, xp INTEGER NOT NULL DEFAULT 0,
      iv_hp INTEGER NOT NULL, iv_atk INTEGER NOT NULL, iv_def INTEGER NOT NULL, iv_spd INTEGER NOT NULL, sparkly INTEGER NOT NULL DEFAULT 0, nickname TEXT, caught_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS critters_owned_user ON critters_owned (guild_id, user_id);
    CREATE TABLE IF NOT EXISTS critters_profile (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, buddy_id INTEGER, caught INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, user_id));
  ` }],
  commands: [{
    permission: 'critters.use',
    data: new SlashCommandBuilder().setName('critters').setDescription('Your critters: list, buddy, trade, battle and more')
      .addSubcommand((s) => s.setName('list').setDescription('The critters you caught').addIntegerOption((o) => o.setName('page').setDescription('Page').setMinValue(1)))
      .addSubcommand((s) => s.setName('info').setDescription('One critter, with its picture and stats').addIntegerOption((o) => o.setName('id').setDescription('Its number (your buddy if empty)').setMinValue(1)))
      .addSubcommand((s) => s.setName('buddy').setDescription('Pick your buddy (it levels up while you chat)').addIntegerOption((o) => o.setName('id').setDescription('Its number').setRequired(true).setMinValue(1)))
      .addSubcommand((s) => s.setName('rename').setDescription('Give a critter a nickname').addIntegerOption((o) => o.setName('id').setDescription('Its number').setRequired(true).setMinValue(1)).addStringOption((o) => o.setName('name').setDescription('Empty to remove it').setMaxLength(20)))
      .addSubcommand((s) => s.setName('dex').setDescription('Which critters you have found'))
      .addSubcommand((s) => s.setName('trade').setDescription('Swap one of yours for one of theirs').addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true))
        .addIntegerOption((o) => o.setName('give').setDescription('Your critter\'s number').setRequired(true).setMinValue(1)).addIntegerOption((o) => o.setName('get').setDescription('Their critter\'s number').setRequired(true).setMinValue(1)))
      .addSubcommand((s) => s.setName('battle').setDescription('Your buddy against theirs').addUserOption((o) => o.setName('member').setDescription('Who').setRequired(true)))
      .addSubcommand((s) => s.setName('release').setDescription('Let one go (for coins, with the economy)').addIntegerOption((o) => o.setName('id').setDescription('Its number').setRequired(true).setMinValue(1)))
      .addSubcommand((s) => s.setName('here').setDescription('(Staff) Turn critters on or off in this channel'))
      .addSubcommand((s) => s.setName('spawn').setDescription('(Staff) Make a critter appear here now')),
    execute: crittersCommand,
  }],
  components: [{ prefix: 'crit:', execute: onComponent }],
  views: {
    async collectors(ctx) {
      const rows = ctx.sql.all(`SELECT user_id AS id, COUNT(*) AS caught, COUNT(DISTINCT species) AS kinds, SUM(sparkly) AS sparkly, MAX(level) AS best FROM critters_owned WHERE guild_id = ? GROUP BY user_id ORDER BY kinds DESC, caught DESC LIMIT 50`, ctx.guildId);
      return { rows: rows.map((r) => ({ ...r, name: ctx.guild?.members.cache.get(r.id)?.displayName ?? r.id, kinds: `${r.kinds}/${CR.ALL.length}`, sparkly: String(r.sparkly ?? 0), best: `Lv ${r.best}` })),
        charts: [{ title: 'Critters caught, by rarity', bars: Object.entries(CR.RARITIES).map(([id, x]) => ({ label: x.label, value: ctx.sql.get(`SELECT COUNT(*) AS n FROM critters_owned o WHERE guild_id = ? AND species IN (${CR.ALL.filter((s) => s.rarity === id).map(() => '?').join(',')})`, ctx.guildId, ...CR.ALL.filter((s) => s.rarity === id).map((s) => s.id)).n })) }] };
    },
    async tools() { return { rows: [] }; },
  },
  actions: {
    async 'critter-spawn'(ctx, body) {
      const ch = ctx.guild?.channels.cache.get(String(body.channel ?? ''));
      if (!ch?.isTextBased?.()) throw new UserError('Pick a text channel.');
      const s = await spawn(ctx, ch);
      if (!s) throw new UserError("I couldn't post in that channel (check my permissions there).");
      return { channel: ch.id };
    },
  },
  panels: [
    { id: 'collectors', title: 'Critter collectors', view: 'collectors', permission: 'critters.use', empty: 'Nobody has caught a critter yet.',
      columns: [{ key: 'name', label: 'Member' }, { key: 'kinds', label: 'Kinds found' }, { key: 'caught', label: 'Caught' }, { key: 'sparkly', label: 'Sparkly' }, { key: 'best', label: 'Best level' }] },
    { id: 'tools', title: 'Make a critter appear', view: 'tools', permission: 'critters.admin', columns: [],
      description: 'For events: a wild critter appears in the channel you pick, right now.',
      addForm: { action: 'critter-spawn', label: 'Make one appear', done: 'A critter appeared!', fields: [{ key: 'channel', label: 'Channel', type: 'channel' }] } },
  ],
  events: { messageCreate: onMessage },
  async destroy(ctx) { spawns.delete(ctx.guildId); counts.delete(ctx.guildId); },
};
