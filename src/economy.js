/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Economy rules as plain functions (no Discord, no database), so they are easy to test and survive hot reloads.
 *
 * Daily streak (docs/ENGAGEMENT.md, recommendation 1):
 *   - claimable 20 hours after the last claim, so the time of day can drift instead of "be here at 9:00 exactly"
 *   - the streak survives up to 48 hours between claims; after that a Streak Shield is used if you have one
 *     (one shield is earned every 7 days of streak, at most 3 held), otherwise the streak starts again
 *   - reward = base x (1 + 5% per streak day, capped at +150% on day 30), plus a bonus on day 7, 14, 30 and every 30
 */

export const HOUR = 3600000;
export const CLAIM_EVERY = 20 * HOUR;
export const STREAK_GRACE = 48 * HOUR;
export const MAX_SHIELDS = 3;
export const STREAK_CAP = 30;

export function streakMultiplier(streak) { return 1 + Math.min(Math.max(streak, 1) - 1, STREAK_CAP) * 0.05; }

export function milestoneBonus(streak, base) {
  if (streak > 0 && streak % 30 === 0) return base * 10;
  if (streak === 14) return base * 4;
  if (streak === 7) return base * 2;
  return 0;
}

/**
 * What a daily claim does. Returns { ok:false, nextAt } when it is too early, otherwise the new wallet fields and
 * what to tell the member.
 */
export function claimDaily({ streak = 0, lastDaily = 0, shields = 0, bestStreak = 0 }, base, now = Date.now()) {
  if (lastDaily && now - lastDaily < CLAIM_EVERY) return { ok: false, nextAt: lastDaily + CLAIM_EVERY };
  let usedShield = false, lost = false;
  if (!lastDaily) streak = 1;
  else if (now - lastDaily <= STREAK_GRACE) streak += 1;
  else if (shields > 0) { shields -= 1; usedShield = true; streak += 1; }
  else { lost = streak > 1; streak = 1; }
  let shieldEarned = false;
  if (streak % 7 === 0 && shields < MAX_SHIELDS) { shields += 1; shieldEarned = true; }
  const reward = Math.round(base * streakMultiplier(streak));
  const bonus = milestoneBonus(streak, base);
  return {
    ok: true, reward, bonus, total: reward + bonus, streak, shields, usedShield, shieldEarned, lost,
    bestStreak: Math.max(bestStreak, streak), lastDaily: now, nextAt: now + CLAIM_EVERY,
  };
}

/** 12345 -> "12,345". Always whole coins. */
export const fmtNum = (n) => Math.trunc(Number(n) || 0).toLocaleString('en-US');

/** Parses an amount someone typed: "500", "1,500", "2.5k", "1m", or "all" / "half" of what they have. */
export function parseAmount(raw, { have = null, min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[, _]/g, '');
  let n;
  if (s === 'all' || s === 'max') n = have ?? NaN;
  else if (s === 'half') n = have != null ? Math.floor(have / 2) : NaN;
  else {
    const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(s);
    n = m ? Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1) : NaN;
  }
  if (!Number.isFinite(n)) return { error: 'Type a whole number like `500`, `2.5k`, `all` or `half`.' };
  n = Math.floor(n);
  if (n < min) return { error: `The amount must be at least ${fmtNum(min)}.` };
  if (n > max) return { error: `The amount can be at most ${fmtNum(max)}.` };
  return { value: n };
}
