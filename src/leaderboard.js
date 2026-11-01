/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Paginated leaderboards. The message stores nothing: every button carries who owns the board, which board, which
 * scope and which page, and every click reads the database again before drawing the page. So a click always shows
 * the current numbers, and a hot reload or restart between clicks changes nothing for the person browsing.
 *
 *   <prefix>:<owner>:<board>:<scope>:<page>:<action>
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from 'discord.js';

export const PER_PAGE = 10;
const MEDALS = ['🥇', '🥈', '🥉'];

export const pageCount = (total, per = PER_PAGE) => Math.max(1, Math.ceil(Math.max(0, total) / per));
/** Keeps a requested page inside the board, which matters when the board shrank since the button was drawn. */
export const clampPage = (page, total, per = PER_PAGE) => Math.min(Math.max(0, Math.trunc(Number(page) || 0)), pageCount(total, per) - 1);

export function rankLabel(rank) { return MEDALS[rank - 1] ?? `\`#${String(rank).padStart(2, ' ')}\``; }

/** Lines like "🥇 **Name** · 12,345 🪙". Short on purpose so a line never wraps on a phone. */
export function renderRows(rows, offset, format) {
  if (!rows.length) return '*Nobody here yet. Be the first!*';
  return rows.map((r, k) => `${rankLabel(offset + k + 1)} ${format(r)}`).join('\n');
}

export function packNav(prefix, { owner, board, scope, page }, action) { return `${prefix}${owner}:${board}:${scope}:${page}:${action}`; }
export function unpackNav(prefix, customId) {
  const p = String(customId).split(':');
  if (p.length !== 6 || `${p[0]}:` !== prefix) return null;
  const [, owner, board, scope, page, action] = p;
  return { owner, board, scope, page: Math.max(0, parseInt(page, 10) || 0), action };
}

/**
 * The buttons and the board picker. Previous is disabled on the first page and Next on the last, so there is
 * no click that leads nowhere.
 */
export function navComponents(prefix, { owner, board, scope, page, pages, boards, scopes = ['server', 'global'] }) {
  const s = { owner, board, scope, page };
  const prev = new ButtonBuilder().setCustomId(packNav(prefix, s, 'prev')).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0);
  const label = new ButtonBuilder().setCustomId(packNav(prefix, s, 'noop')).setLabel(`${page + 1} / ${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true);
  const next = new ButtonBuilder().setCustomId(packNav(prefix, s, 'next')).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1);
  const refresh = new ButtonBuilder().setCustomId(packNav(prefix, s, 'refresh')).setEmoji('🔄').setStyle(ButtonStyle.Secondary);
  const row1 = new ActionRowBuilder().addComponents(prev, label, next, refresh);
  if (scopes.length > 1) {
    const other = scopes[(scopes.indexOf(scope) + 1) % scopes.length];
    row1.addComponents(new ButtonBuilder().setCustomId(packNav(prefix, { ...s, scope: other, page: 0 }, 'scope'))
      .setLabel(other === 'global' ? 'Global' : 'This server').setEmoji(other === 'global' ? '🌍' : '🏠').setStyle(ButtonStyle.Primary));
  }
  const rows = [row1];
  if (boards?.length > 1) {
    rows.unshift(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(packNav(prefix, s, 'board')).setPlaceholder('Choose a leaderboard')
      .addOptions(boards.slice(0, 25).map((b) => new StringSelectMenuOptionBuilder().setLabel(b.label).setValue(b.id).setEmoji(b.emoji ?? '🏆').setDefault(b.id === board)))));
  }
  return rows;
}

/** Works out the page to show after a click. */
export function nextPage(action, page) {
  if (action === 'prev') return page - 1;
  if (action === 'next') return page + 1;
  return page;
}
