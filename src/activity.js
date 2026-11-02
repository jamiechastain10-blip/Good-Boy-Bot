/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Shared helpers for activity statistics and achievements. Pure functions: days, streaks, voice sessions.
 * A "day" is a calendar date in the server's timezone offset, written YYYY-MM-DD.
 */

const DAY = 86400000;

export const dayKey = (ms, offsetHours = 0) => new Date(ms + offsetHours * 3600000).toISOString().slice(0, 10);
const dayNumber = (key) => Math.floor(Date.parse(`${key}T00:00:00Z`) / DAY);
export const daysBetween = (a, b) => dayNumber(b) - dayNumber(a);
export const addDays = (key, n) => new Date((dayNumber(key) + n) * DAY).toISOString().slice(0, 10);

/** The Monday (as a day key) of the week containing `ms`. */
export function weekStartKey(ms, offsetHours = 0) {
  const k = dayKey(ms, offsetHours);
  const dow = new Date(`${k}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(k, -((dow + 6) % 7));
}

/** Periods people can ask for. Returns the first day (inclusive) to count, or null for "all time". */
export const PERIODS = { '7d': 7, '30d': 30, '90d': 90, '365d': 365, all: null };
export function periodStart(period, now, offsetHours = 0) {
  if (!(period in PERIODS)) throw new Error(`Unknown period "${period}".`);
  return PERIODS[period] == null ? null : addDays(dayKey(now, offsetHours), -(PERIODS[period] - 1));
}

/** Move a member's streak forward for activity on `today`. State: { last, streak, best }. */
export function advanceStreak(state, today) {
  const s = { last: state?.last ?? null, streak: state?.streak ?? 0, best: state?.best ?? 0 };
  if (s.last === today) return { ...s, newDay: false };
  const gap = s.last ? daysBetween(s.last, today) : null;
  s.streak = gap === 1 ? s.streak + 1 : 1;
  s.best = Math.max(s.best, s.streak);
  s.last = today;
  return { ...s, newDay: true };
}

/** A streak that has already lapsed (no activity yesterday or today) shows as 0 when read. */
export function currentStreak(state, now, offsetHours = 0) {
  if (!state?.last) return 0;
  return daysBetween(state.last, dayKey(now, offsetHours)) <= 1 ? state.streak : 0;
}

/** Allow at most one event per `gapMs` for a key. Used so message-spam cannot farm counters. */
export class Throttle {
  constructor() { this.last = new Map(); }
  allow(key, now, gapMs) {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < gapMs) return false;
    this.last.set(key, now);
    return true;
  }
  prune(now, olderThanMs = 600000) { for (const [k, t] of this.last) if (now - t > olderThanMs) this.last.delete(k); }
}

export const MAX_SESSION_SECONDS = 12 * 3600;

/** Voice time is "connected", not "talking". Sessions live in memory; a restart loses the open ones. */
export class VoiceTracker {
  constructor() { this.open = new Map(); }
  enter(userId, now) { if (!this.open.has(userId)) this.open.set(userId, now); }
  /** Returns the seconds to credit (0 if no session was open). Capped, so a forgotten session can't inflate totals. */
  leave(userId, now) {
    const t = this.open.get(userId);
    if (t === undefined) return 0;
    this.open.delete(userId);
    return Math.max(0, Math.min(MAX_SESSION_SECONDS, Math.round((now - t) / 1000)));
  }
  /** Close every open session at `now` (used on shutdown) and start fresh ones. Returns [[userId, seconds]]. */
  checkpoint(now) {
    const out = [];
    for (const [id, t] of this.open) { out.push([id, Math.max(0, Math.min(MAX_SESSION_SECONDS, Math.round((now - t) / 1000)))]); this.open.set(id, now); }
    return out;
  }
}

export const hours = (seconds) => Math.round((seconds / 3600) * 10) / 10;
export const bar = (value, target, width = 10) => {
  const filled = Math.max(0, Math.min(width, Math.floor((value / Math.max(1, target)) * width)));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
};
