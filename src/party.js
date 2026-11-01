/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Party Finder rules: pure functions over a plain party object, so they can be tested without Discord.
 * A party is { id, owner, game, slots, members: [userIds, owner first], startAt|null, expiresAt, status }.
 */

export const MIN_SLOTS = 2;
export const MAX_SLOTS = 99;

export const cleanText = (t, max) => String(t ?? '').replace(/<@[&!]?\d+>|@(everyone|here)/gi, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export const isFull = (p) => p.members.length >= p.slots;
export const spotsLeft = (p) => Math.max(0, p.slots - p.members.length);

/** Join. Returns { party } or { error } with a short reason code the module turns into text. */
export function join(p, userId, now = Date.now()) {
  if (p.status === 'closed') return { error: 'closed' };
  if (p.expiresAt <= now) return { error: 'expired' };
  if (p.members.includes(userId)) return { error: 'already' };
  if (isFull(p)) return { error: 'full' };
  const next = { ...p, members: [...p.members, userId] };
  next.status = isFull(next) ? 'full' : 'open';
  return { party: next, filled: next.status === 'full' };
}

/** Leave. The host cannot leave (they close the party instead). Freed spots reopen a full party. */
export function leave(p, userId) {
  if (p.status === 'closed') return { error: 'closed' };
  if (userId === p.owner) return { error: 'owner' };
  if (!p.members.includes(userId)) return { error: 'notin' };
  return { party: { ...p, members: p.members.filter((m) => m !== userId), status: 'open' } };
}

/** When does the party stop accepting people? A start time wins; otherwise a fixed window after creation. */
export function expiryFor({ startAt, createdAt, expireMinutes, graceMinutes = 30 }) {
  return startAt ? startAt + graceMinutes * 60000 : createdAt + expireMinutes * 60000;
}

/** Parties due for a "starting soon" reminder: start within `lead` ms, not yet reminded. */
export function dueReminders(parties, now, lead = 10 * 60000) {
  return parties.filter((p) => p.status !== 'closed' && p.startAt && !p.reminded && p.startAt - now <= lead && p.startAt > now - 5 * 60000);
}
