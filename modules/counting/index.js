/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Counting and word chain (3.1): two classic channel games.
 *   Counting     count up one number at a time (simple sums like 12+1 count too); the same person can't count twice in
 *                a row; a wrong number starts again from 1. The best run is kept, and so is how many each member counted.
 *   Word chain   each word starts with the last letter of the one before; no word twice in one chain; one word per
 *                message. A mistake starts a new chain.
 * Staff turn either game on in a channel with /counting here or /counting words-here.
 */
import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { UserError } from '../../src/util.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const MAX_USED = 3000;

/** Reads a number or a small sum (+ - * x / and brackets), safely. Null if it isn't one. Exported for tests. */
export function readNumber(text) {
  const src = String(text ?? '').trim().split(/\s+/)[0]?.replace(/×|x/gi, '*').replace(/÷/g, '/') ?? '';
  if (!/^[\d+\-*/().]{1,40}$/.test(src) || !/\d/.test(src)) return null;
  let k = 0;
  const peek = () => src[k];
  const num = () => { const m = /^\d+(\.\d+)?/.exec(src.slice(k)); if (!m) throw new Error('bad'); k += m[0].length; return Number(m[0]); };
  const factor = () => { if (peek() === '-') { k++; return -factor(); } if (peek() === '(') { k++; const v = expr(); if (src[k++] !== ')') throw new Error('bad'); return v; } return num(); };
  const term = () => { let v = factor(); while (peek() === '*' || peek() === '/') { const op = src[k++]; const r = factor(); v = op === '*' ? v * r : v / r; } return v; };
  const expr = () => { let v = term(); while (peek() === '+' || peek() === '-') { const op = src[k++]; const r = term(); v = op === '+' ? v + r : v - r; } return v; };
  try { const v = expr(); if (k !== src.length || !Number.isFinite(v)) return null; return Math.round(v * 1e9) / 1e9; } catch { return null; }
}
/** One counting message: { ok, why } given the state { n, last }. Exported for tests. */
export function checkCount(state, userId, text, { oneAtATime = true } = {}) {
  const v = readNumber(text);
  if (v === null) return { skip: true };
  if (oneAtATime && state.last === userId) return { ok: false, why: "you can't count twice in a row" };
  if (v !== state.n + 1) return { ok: false, why: `the next number was **${state.n + 1}**` };
  return { ok: true, value: v };
}
/** One word-chain message: { ok, why, word } given { word, lastUser, used }. Exported for tests. */
export function checkWord(state, userId, text, { oneAtATime = true } = {}) {
  const w = String(text ?? '').trim().toLowerCase();
  if (!/^[\p{L}'-]{2,30}$/u.test(w)) return { skip: true };
  if (oneAtATime && state.lastUser === userId) return { ok: false, why: "you can't go twice in a row" };
  const need = state.word ? [...state.word.replace(/[^\p{L}]/gu, '')].at(-1) : null;
  if (need && w[0] !== need) return { ok: false, why: `the word had to start with **${need.toUpperCase()}**` };
  if ((state.used ?? []).includes(w)) return { ok: false, why: `**${w}** was already used in this chain` };
  return { ok: true, word: w };
}

const games = (ctx) => ctx.data.get('channels') ?? {}; // channelId -> 'count' | 'words'
async function onMessage(ctx, m) {
  if (!m.guildId || m.author?.bot || m.webhookId) return;
  const kind = games(ctx)[m.channelId];
  if (!kind) return;
  const one = ctx.config.get('oneAtATime');
  if (kind === 'count') {
    const key = `count:${m.channelId}`, st = ctx.data.get(key) ?? { n: 0, last: null, record: 0, msg: null };
    const r = checkCount(st, m.author.id, m.content, { oneAtATime: one });
    if (r.skip) return;
    if (r.ok) {
      const record = Math.max(st.record, r.value);
      ctx.data.set(key, { n: r.value, last: m.author.id, record, msg: m.id, lastValue: r.value });
      ctx.data.update(`cu:${m.author.id}`, (n) => n + 1, 0);
      if (ctx.config.get('reactions')) await m.react(r.value === record && r.value > st.record && r.value % 100 === 0 ? '🎉' : '✅').catch(() => {});
      return;
    }
    ctx.data.set(key, { n: 0, last: null, record: st.record, msg: null });
    await m.react('❌').catch(() => {});
    await m.channel.send({ content: `💥 <@${m.author.id}> broke the count at **${st.n}**: ${r.why}. Start again from **1**!${st.n >= st.record && st.n > 0 ? ' (That was a new record!)' : ` Best: **${st.record}**.`}`, allowedMentions: NOPING }).catch(() => {});
    return;
  }
  const key = `chain:${m.channelId}`, st = ctx.data.get(key) ?? { word: null, lastUser: null, used: [], record: 0 };
  const r = checkWord(st, m.author.id, m.content, { oneAtATime: one });
  if (r.skip) return;
  if (r.ok) {
    const used = [...(st.used ?? []), r.word].slice(-MAX_USED);
    ctx.data.set(key, { word: r.word, lastUser: m.author.id, used, record: Math.max(st.record ?? 0, used.length) });
    ctx.data.update(`wu:${m.author.id}`, (n) => n + 1, 0);
    if (ctx.config.get('reactions')) await m.react('✅').catch(() => {});
    return;
  }
  ctx.data.set(key, { word: null, lastUser: null, used: [], record: st.record ?? 0 });
  await m.react('❌').catch(() => {});
  await m.channel.send({ content: `💥 <@${m.author.id}> broke the chain after **${(st.used ?? []).length}** words: ${r.why}. New chain: any word!`, allowedMentions: NOPING }).catch(() => {});
}
/** Someone deleted the latest number: say it, so the count doesn't get lost. */
async function onDelete(ctx, m) {
  if (games(ctx)[m.channelId] !== 'count') return;
  const st = ctx.data.get(`count:${m.channelId}`);
  if (!st || st.msg !== m.id) return;
  await m.channel?.send({ content: `👀 <@${st.last}> deleted their number (**${st.n}**). The next number is **${st.n + 1}**.`, allowedMentions: NOPING }).catch(() => {});
}

async function countingCommand(ctx, i) {
  const sub = i.options.getSubcommand();
  if (sub === 'stats') {
    const all = games(ctx);
    const lines = Object.entries(all).map(([ch, kind]) => {
      if (kind === 'count') { const st = ctx.data.get(`count:${ch}`) ?? { n: 0, record: 0 }; return `🔢 <#${ch}> · now **${st.n}** · best **${st.record}**`; }
      const st = ctx.data.get(`chain:${ch}`) ?? { used: [], record: 0 }; return `🔤 <#${ch}> · chain of **${(st.used ?? []).length}** · best **${st.record ?? 0}**`;
    });
    const top = (prefix) => ctx.data.list(prefix).sort((a, b) => b.value - a.value).slice(0, 5).map((r, k) => `${k + 1}. <@${r.key.slice(prefix.length)}> · ${r.value}`).join('\n') || 'Nobody yet.';
    const e = new EmbedBuilder().setColor(0x6b93ff).setTitle('🔢 Counting and word chain').setDescription(lines.join('\n') || 'No game channels yet. Staff can start one with `/counting here`.')
      .addFields({ name: 'Top counters', value: top('cu:'), inline: true }, { name: 'Top word chainers', value: top('wu:'), inline: true });
    return i.reply({ embeds: [e], allowedMentions: NOPING });
  }
  if (!ctx.perms.check(i.member, 'counting.manage')) throw new UserError("You don't have permission for that (`counting.manage`).");
  const all = { ...games(ctx) };
  if (sub === 'reset') {
    const kind = all[i.channelId];
    if (!kind) throw new UserError('There is no game in this channel.');
    if (kind === 'count') ctx.data.set(`count:${i.channelId}`, { ...(ctx.data.get(`count:${i.channelId}`) ?? {}), n: 0, last: null, msg: null });
    else ctx.data.set(`chain:${i.channelId}`, { word: null, lastUser: null, used: [], record: ctx.data.get(`chain:${i.channelId}`)?.record ?? 0 });
    await i.reply({ content: 'Reset.', flags: EPH });
    return i.channel.send({ content: kind === 'count' ? '🔄 The count was reset by staff. Start from **1**!' : '🔄 The word chain was reset by staff. Any word!' }).catch(() => {});
  }
  const kind = sub === 'here' ? 'count' : 'words';
  if (all[i.channelId] === kind) { delete all[i.channelId]; ctx.data.set('channels', all); return i.reply({ content: `${kind === 'count' ? 'Counting' : 'Word chain'} is off in this channel now.`, flags: EPH }); }
  all[i.channelId] = kind;
  ctx.data.set('channels', all);
  await i.reply({ content: `✅ ${kind === 'count' ? 'Counting' : 'Word chain'} is on here.`, flags: EPH });
  return i.channel.send({ content: kind === 'count' ? '🔢 **Counting** starts here! Count up one at a time, starting from **1**. One number each, no counting twice in a row.' : '🔤 **Word chain** starts here! Each word starts with the last letter of the one before. No repeats. Any word to begin!' }).catch(() => {});
}

export default {
  name: 'counting',
  version: '1.0.0',
  description: 'Counting channels and word chain',
  memberIntroTitle: 'counting',
  memberIntro: 'there\'s a counting channel now. count up one at a time, and don\'t count twice in a row or the count starts over',
  settings: [
    { key: 'oneAtATime', type: 'toggle', label: 'Nobody can go twice in a row', default: true },
    { key: 'reactions', type: 'toggle', label: 'React ✅ to every right answer', default: true },
  ],
  permissions: [{ key: 'counting.play', label: 'See counting stats', default: 'everyone' }, { key: 'counting.manage', label: 'Start, stop and reset counting and word chain channels', default: 'admin' }],
  commands: [{
    permission: 'counting.play',
    data: new SlashCommandBuilder().setName('counting').setDescription('Counting and word chain channels')
      .addSubcommand((s) => s.setName('stats').setDescription('Current runs, records and top players'))
      .addSubcommand((s) => s.setName('here').setDescription('(Staff) Turn counting on or off in this channel'))
      .addSubcommand((s) => s.setName('words-here').setDescription('(Staff) Turn the word chain on or off in this channel'))
      .addSubcommand((s) => s.setName('reset').setDescription('(Staff) Start this channel\'s game again')),
    execute: countingCommand,
  }],
  events: { messageCreate: onMessage, messageDelete: onDelete },
  views: {
    async channels(ctx) {
      return { rows: Object.entries(games(ctx)).map(([ch, kind]) => {
        const st = kind === 'count' ? ctx.data.get(`count:${ch}`) ?? { n: 0, record: 0 } : ctx.data.get(`chain:${ch}`) ?? { used: [], record: 0 };
        return { id: ch, name: `#${ctx.guild?.channels.cache.get(ch)?.name ?? 'deleted channel'}`, kind: kind === 'count' ? 'Counting' : 'Word chain', now: String(kind === 'count' ? st.n : (st.used ?? []).length), best: String(st.record ?? 0) };
      }) };
    },
  },
  panels: [{ id: 'channels', title: 'Counting and word chain', view: 'channels', permission: 'counting.manage', empty: 'No game channels yet. Use /counting here or /counting words-here in a channel.',
    columns: [{ key: 'name', label: 'Channel' }, { key: 'kind', label: 'Game' }, { key: 'now', label: 'Now' }, { key: 'best', label: 'Best' }] }],
};
