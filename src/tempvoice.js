/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Temporary voice rooms: pure logic (names, rename limits, who becomes owner). No Discord objects.
 */

/** Make text safe to use as a channel name: no control characters, no pings, one line, at most 100 characters. */
export function sanitizeName(text, fallback = 'Room') {
  const t = String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/<[@#][^>]*>/g, '')
    .replace(/@(everyone|here)/gi, '$1')
    .replace(/\s+/g, ' ').trim();
  return (t.length > 100 ? t.slice(0, 100).trim() : t) || fallback;
}

/** Fill a lobby's name template. {user} is the creator's display name, {n} a running room number. */
export function roomName(template, { user, n }) {
  const filled = String(template || "{user}'s room").replace(/\{user\}/gi, () => sanitizeName(user, 'Someone')).replace(/\{n\}/gi, String(n));
  return sanitizeName(filled);
}

export const RENAME_LIMIT = 2;           // Discord allows two renames per channel ...
export const RENAME_WINDOW = 10 * 60000; // ... in ten minutes.

/** Sliding window for renames. Returns the new list and, when blocked, when the next rename is possible. */
export function checkRename(list, now) {
  const kept = (list ?? []).filter((t) => now - t < RENAME_WINDOW);
  if (kept.length >= RENAME_LIMIT) return { ok: false, list: kept, retryAt: kept[0] + RENAME_WINDOW };
  return { ok: true, list: [...kept, now], retryAt: 0 };
}

/** The member who takes over when the owner leaves a room that still has people: whoever has been there longest. */
export function nextOwner(memberIds, ownerId, joinedAt = {}) {
  const others = memberIds.filter((id) => id !== ownerId);
  if (!others.length) return null;
  return [...others].sort((a, b) => (joinedAt[a] ?? Infinity) - (joinedAt[b] ?? Infinity) || a.localeCompare(b))[0];
}

export const PRIVACY = ['public', 'locked', 'hidden'];
/** What @everyone may do in each privacy mode (null = inherit). */
export function privacyOverwrite(mode) {
  if (mode === 'locked') return { Connect: false, ViewChannel: null };
  if (mode === 'hidden') return { Connect: false, ViewChannel: false };
  return { Connect: null, ViewChannel: null };
}
