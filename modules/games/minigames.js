/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * The 3.1 arcade games on Discord: Tower, Wires, Bingo, Memory, Hangman and Trivia. The rules live in
 * src/minigames.js; this file draws them and handles the buttons. Each game is a saved session (like blackjack), so a
 * restart doesn't lose it. Buttons: gm:mg:<session>:<action>. Hangman's guess popup: gm:mgh:<session>.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { UserError } from '../../src/util.js';
import * as MG from '../../src/minigames.js';

export const GAMES = {
  tower: { emoji: '🗼', label: 'Tower', blurb: `climb ${MG.TOWER_FLOORS} floors, cash out up to ${MG.towerMultiplier(MG.TOWER_FLOORS)}x` },
  wires: { emoji: '💣', label: 'Wires', blurb: `cut the safe wires, up to ${MG.wiresMultiplier(MG.WIRES.length - 1)}x` },
  bingo: { emoji: '🔢', label: 'Bingo', blurb: 'a line in 5 draws pays 4x' },
  memory: { emoji: '🃏', label: 'Memory', blurb: 'match the pairs, up to 2x' },
  hangman: { emoji: '🪢', label: 'Hangman', blurb: `guess the word, up to ${MG.hangmanMultiplier(0)}x` },
  trivia: { emoji: '❓', label: 'Trivia', blurb: `answer right for ${MG.TRIVIA_PAYOUT}x (anime too)` },
};
const COLOR = { play: 0x6b93ff, win: 0x57f287, lose: 0xed4245 };
const NOPING = { parse: [] };

/** h: the games module's helpers (sessions, coins, stats). */
export function makeMinigames(h) {
  const { saveSession, loadSession, dropSession, activeSession, eco, money, record, sid, vis, randomSeed } = h;
  const rand = () => (globalThis[Symbol.for('goodboy.games.rand')] ?? Math.random)();
  const btn = (id, action, label, style = ButtonStyle.Secondary, emoji = null, disabled = false) => { const b = new ButtonBuilder().setCustomId(`gm:mg:${id}:${action}`).setLabel(label).setStyle(style).setDisabled(disabled); if (emoji) b.setEmoji(emoji); return b; };
  const rows = (buttons) => { const out = []; for (let k = 0; k < buttons.length; k += 5) out.push(new ActionRowBuilder().addComponents(buttons.slice(k, k + 5))); return out; };
  const pay = (ctx, userId, s, mult) => {
    const back = Math.floor(s.bet * mult);
    if (back > 0) eco(ctx).credit(ctx.guildId, userId, back, `${s.game} win`);
    record(ctx, userId, s.game, s.bet, back);
    return back;
  };
  const head = (ctx, s, title, color = COLOR.play) => new EmbedBuilder().setColor(color).setTitle(`${GAMES[s.game].emoji} ${title}`).setFooter({ text: `Bet ${money(ctx, s.bet).replace(/\*\*/g, '')}` });

  // ---------------------------------------------------------------- drawing each game
  function view(ctx, id, s, note) {
    const g = s.game;
    if (g === 'tower') {
      const climbing = s.status === 'climbing';
      const floors = Array.from({ length: MG.TOWER_FLOORS }, (_, f) => MG.TOWER_FLOORS - 1 - f).map((f) => {
        const doors = Array.from({ length: MG.TOWER_DOORS }, (_, d) => (f < s.floor ? (d === s.picks[f] ? '🟩' : '⬛') : f === s.floor && s.status === 'trapped' ? (d === s.picks[f] ? '💥' : d === s.traps[f] ? '💀' : '⬛') : !climbing && d === s.traps[f] ? '💀' : f === s.floor && climbing ? '🚪' : '⬜'));
        return `${doors.join('')} ${f === s.floor && climbing ? '◀️' : ''} ${MG.towerMultiplier(f + 1)}x`;
      }).join('\n');
      const e = head(ctx, s, s.status === 'trapped' ? 'Tower · trapped!' : s.status === 'top' ? 'Tower · you reached the top!' : s.status === 'cashed' ? 'Tower · cashed out' : `Tower · floor ${s.floor + 1}`, s.status === 'trapped' ? COLOR.lose : climbing ? COLOR.play : COLOR.win)
        .setDescription([note, floors, climbing ? `Pick a door. One on each floor hides a trap. Cash out now for **${MG.towerMultiplier(s.floor)}x**.` : null].filter(Boolean).join('\n\n'));
      const comps = climbing ? rows([...Array.from({ length: MG.TOWER_DOORS }, (_, d) => btn(id, `d${d}`, `Door ${d + 1}`, ButtonStyle.Primary, '🚪')), btn(id, 'cash', `Cash out ${MG.towerMultiplier(s.floor)}x`, ButtonStyle.Success, '💰', s.floor === 0)]) : [];
      return { embeds: [e], components: comps };
    }
    if (g === 'wires') {
      const live = s.status === 'cutting';
      const line = MG.WIRES.map((w, k) => (s.cut.includes(k) ? (k === s.bomb ? '💥' : '✂️') : !live && k === s.bomb ? '💣' : w)).join(' ');
      const e = head(ctx, s, s.status === 'boom' ? 'Wires · BOOM!' : s.status === 'cleared' ? 'Wires · defused!' : s.status === 'cashed' ? 'Wires · cashed out' : 'Wires', s.status === 'boom' ? COLOR.lose : live ? COLOR.play : COLOR.win)
        .setDescription([note, `# ${line}`, live ? `One wire is the bomb. Next safe cut: **${MG.wiresMultiplier(s.cut.length + 1)}x** · cash out now: **${MG.wiresMultiplier(s.cut.length)}x**` : null].filter(Boolean).join('\n'));
      const comps = live ? rows([...MG.WIRES.map((w, k) => btn(id, `w${k}`, 'Cut', ButtonStyle.Secondary, w, s.cut.includes(k))), btn(id, 'cash', `Cash out ${MG.wiresMultiplier(s.cut.length)}x`, ButtonStyle.Success, '💰', !s.cut.length)]) : [];
      return { embeds: [e], components: comps };
    }
    if (g === 'bingo') {
      const m = MG.bingoMarked(s);
      const grid = [0, 3, 6].map((r) => s.card.slice(r, r + 3).map((n, k) => (m[r + k] ? '✅' : `\`${String(n).padStart(2, ' ')}\``)).join(' ')).join('\n');
      const drawn = s.order.slice(0, s.drawn).join(', ') || 'nothing yet';
      const e = head(ctx, s, s.status === 'bingo' ? `Bingo in ${s.drawn} draws!` : s.status === 'out' ? 'Bingo · no line' : `Bingo · draw ${s.drawn}/${MG.BINGO_DRAWS}`, s.status === 'out' ? COLOR.lose : s.status === 'bingo' ? COLOR.win : COLOR.play)
        .setDescription([note, grid, `Drawn: ${drawn}`, s.status === 'drawing' ? `A line by draw 5 pays **4x**, by 7 **2x**, by 10 **1.1x**.` : null].filter(Boolean).join('\n\n'));
      return { embeds: [e], components: s.status === 'drawing' ? rows([btn(id, 'draw', 'Draw a number', ButtonStyle.Primary, '🎱')]) : [] };
    }
    if (g === 'memory') {
      const live = s.status === 'playing';
      const e = head(ctx, s, live ? `Memory · ${s.found.length / 2}/8 pairs` : 'Memory · all pairs found!', live ? COLOR.play : COLOR.win)
        .setDescription([note, `Mistakes: **${s.mistakes}** · now paying **${MG.memoryMultiplier(s.mistakes)}x**`, '-# 6 or fewer mistakes: 2x · 10 or fewer: 1.4x · 14 or fewer: your bet back'].filter(Boolean).join('\n'));
      const cards = s.cards.map((face, k) => {
        const shown = s.found.includes(k) || s.open.includes(k) || !live;
        const b = new ButtonBuilder().setCustomId(`gm:mg:${id}:c${k}`).setStyle(s.found.includes(k) ? ButtonStyle.Success : s.open.includes(k) ? ButtonStyle.Primary : ButtonStyle.Secondary).setDisabled(!live || s.found.includes(k));
        return shown ? b.setEmoji(face) : b.setLabel('?');
      });
      return { embeds: [e], components: rows(cards) };
    }
    if (g === 'hangman') {
      const live = s.status === 'guessing';
      const e = head(ctx, s, live ? 'Hangman' : s.status === 'won' ? 'Hangman · you got it!' : 'Hangman · out of guesses', live ? COLOR.play : s.status === 'won' ? COLOR.win : COLOR.lose)
        .setDescription([note, `\`\`\`\n${MG.HANGMAN_ART[Math.min(s.wrong, 6)]}\n\`\`\``, `# ${MG.hangmanShown(s)}`, `Tried: ${s.guessed.map((c) => c.toUpperCase()).join(' ') || 'nothing yet'} · ${MG.HANGMAN_LIVES - s.wrong} wrong guesses left`,
          live ? `Winning now pays **${MG.hangmanMultiplier(s.wrong)}x**. A wrong whole-word guess costs 2.` : null].filter(Boolean).join('\n'));
      return { embeds: [e], components: live ? rows([btn(id, 'guess', 'Guess a letter or the word', ButtonStyle.Primary, '⌨️')]) : [] };
    }
    if (g === 'trivia') {
      const live = s.status === 'asking';
      const e = head(ctx, s, `Trivia · ${MG.TRIVIA_CATEGORIES[s.q.cat] ?? s.q.cat}`, live ? COLOR.play : s.status === 'right' ? COLOR.win : COLOR.lose)
        .setDescription([`**${s.q.q}**`, live ? `You have ${Math.round(MG.TRIVIA_MS / 1000)} seconds. Right pays **${MG.TRIVIA_PAYOUT}x**.` : note].filter(Boolean).join('\n\n'));
      const answers = s.q.answers.map((a, k) => {
        const style = live ? ButtonStyle.Secondary : k === s.q.right ? ButtonStyle.Success : k === s.pick ? ButtonStyle.Danger : ButtonStyle.Secondary;
        return new ButtonBuilder().setCustomId(`gm:mg:${id}:a${k}`).setLabel(String(a).slice(0, 80)).setStyle(style).setDisabled(!live);
      });
      return { embeds: [e], components: rows(answers) };
    }
    throw new UserError('That game is no longer active.');
  }

  // ---------------------------------------------------------------- starting
  async function start(ctx, i, game, bet, opts = {}) {
    if (activeSession(ctx, i.user.id, game)) throw new UserError(`You already have a ${GAMES[game].label} game going. Finish it first!`);
    const id = sid();
    const base = game === 'tower' ? MG.towerStart(rand) : game === 'wires' ? MG.wiresStart(rand) : game === 'bingo' ? MG.bingoStart(rand) : game === 'memory' ? MG.memoryStart(rand)
      : game === 'hangman' ? MG.hangmanStart(rand) : { q: MG.triviaPick(opts.category ?? 'any', rand), status: 'asking', askedAt: Date.now() };
    const s = { ...base, game, bet };
    saveSession(ctx, id, i.user.id, game, s);
    return i.reply({ ...view(ctx, id, s), ...vis(ctx), allowedMentions: NOPING });
  }

  // ---------------------------------------------------------------- buttons
  async function click(ctx, i, id, action) {
    const row = ctx.sql.get('SELECT kind FROM games_sessions WHERE id = ? AND guild_id = ?', id, ctx.guildId);
    if (!row) throw new UserError('That game has finished. Start a new one from `/arcade`!');
    const game = row.kind;
    if (game === 'hangman' && action === 'guess') {
      loadSession(ctx, id, i.user.id, game); // checks it's theirs
      return i.showModal(new ModalBuilder().setCustomId(`gm:mgh:${id}`).setTitle('Hangman').addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('guess').setLabel('A letter, or the whole word').setStyle(TextInputStyle.Short).setMinLength(1).setMaxLength(20).setRequired(true))));
    }
    let s, note = null, done = false;
    ctx.sql.transaction(() => {
      s = loadSession(ctx, id, i.user.id, game);
      if (game === 'tower') {
        if (action === 'cash') { if (s.floor > 0 && s.status === 'climbing') { s.status = 'cashed'; const back = pay(ctx, i.user.id, s, MG.towerMultiplier(s.floor)); note = `💰 You took **${money(ctx, back)}**.`; } }
        else if (/^d\d$/.test(action)) {
          MG.towerPick(s, Number(action.slice(1)));
          if (s.status === 'trapped') { pay(ctx, i.user.id, s, 0); note = '💀 A trap! You lost your bet.'; }
          if (s.status === 'top') { const back = pay(ctx, i.user.id, s, MG.towerMultiplier(MG.TOWER_FLOORS)); note = `🏆 The top! You won **${money(ctx, back)}**.`; }
        }
        done = s.status !== 'climbing';
      } else if (game === 'wires') {
        if (action === 'cash') { if (s.cut.length && s.status === 'cutting') { s.status = 'cashed'; const back = pay(ctx, i.user.id, s, MG.wiresMultiplier(s.cut.length)); note = `💰 You took **${money(ctx, back)}**.`; } }
        else if (/^w\d$/.test(action)) {
          MG.wiresCut(s, Number(action.slice(1)));
          if (s.status === 'boom') { pay(ctx, i.user.id, s, 0); note = '💥 That was the bomb! You lost your bet.'; }
          if (s.status === 'cleared') { const back = pay(ctx, i.user.id, s, MG.wiresMultiplier(s.cut.length)); note = `✅ Every safe wire cut! You won **${money(ctx, back)}**.`; }
        }
        done = s.status !== 'cutting';
      } else if (game === 'bingo') {
        if (action === 'draw') MG.bingoDraw(s);
        if (s.status === 'bingo') { const back = pay(ctx, i.user.id, s, MG.bingoMultiplier(s.drawn)); note = `🎉 You won **${money(ctx, back)}**.`; }
        if (s.status === 'out') { pay(ctx, i.user.id, s, 0); note = 'No line this time. You lost your bet.'; }
        done = s.status !== 'drawing';
      } else if (game === 'memory') {
        if (/^c\d+$/.test(action)) MG.memoryFlip(s, Number(action.slice(1)));
        if (s.status === 'done') { const mult = MG.memoryMultiplier(s.mistakes); const back = pay(ctx, i.user.id, s, mult); note = mult ? `🧠 Done with ${s.mistakes} mistakes! You got **${money(ctx, back)}**.` : `Done, but with ${s.mistakes} mistakes, so you lost your bet.`; }
        done = s.status !== 'playing';
      } else if (game === 'trivia') {
        if (/^a\d$/.test(action) && s.status === 'asking') {
          s.pick = Number(action.slice(1));
          const late = Date.now() - s.askedAt > MG.TRIVIA_MS;
          if (!late && s.pick === s.q.right) { s.status = 'right'; const back = pay(ctx, i.user.id, s, MG.TRIVIA_PAYOUT); note = `✅ Right! You won **${money(ctx, back)}**.`; }
          else { s.status = 'wrong'; pay(ctx, i.user.id, s, 0); note = late ? `⌛ Too slow! It was **${s.q.answers[s.q.right]}**.` : `❌ It was **${s.q.answers[s.q.right]}**.`; }
        }
        done = s.status !== 'asking';
      }
      if (done) dropSession(ctx, id); else saveSession(ctx, id, i.user.id, game, s);
    });
    return i.update({ ...view(ctx, id, s, note), allowedMentions: NOPING });
  }
  /** Hangman's popup answer. */
  async function guess(ctx, i, id) {
    let s, note;
    ctx.sql.transaction(() => {
      s = loadSession(ctx, id, i.user.id, 'hangman');
      ({ note } = MG.hangmanGuess(s, i.fields.getTextInputValue('guess')));
      if (s.status === 'won') { const back = pay(ctx, i.user.id, s, MG.hangmanMultiplier(s.wrong)); note = `🎉 It was **${s.word.toUpperCase()}**! You won **${money(ctx, back)}**.`; }
      if (s.status === 'lost') { pay(ctx, i.user.id, s, 0); note = `💀 The word was **${s.word.toUpperCase()}**. You lost your bet.`; }
      if (s.status === 'guessing') saveSession(ctx, id, i.user.id, 'hangman', s); else dropSession(ctx, id);
    });
    const msg = { ...view(ctx, id, s, note), allowedMentions: NOPING };
    return i.message ? i.update(msg) : i.reply({ ...msg, ...vis(ctx) });
  }
  void randomSeed;
  return { start, click, guess, view };
}
