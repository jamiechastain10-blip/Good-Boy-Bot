/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Achievement definitions and the rules for earning them. Pure functions.
 * Built-in achievements are earned automatically from a member's progress counters; server-specific ones are
 * created by staff and granted by hand.
 */
import { bar } from './activity.js';

/** metric -> how to read it from a progress row. */
export const METRICS = {
  messages: { label: 'messages', get: (p) => p.messages ?? 0 },
  voice_hours: { label: 'hours in voice', get: (p) => Math.floor((p.voice_seconds ?? 0) / 3600) },
  reactions: { label: 'reactions given', get: (p) => p.reactions ?? 0 },
  active_days: { label: 'days active', get: (p) => p.active_days ?? 0 },
  best_streak: { label: 'day streak', get: (p) => p.best_streak ?? 0 },
  member_days: { label: 'days in the server', get: (p, x) => x?.memberDays ?? 0 },
};

export const BUILTIN = [
  { id: 'first-words', name: 'First Words', emoji: '💬', metric: 'messages', target: 1 },
  { id: 'regular', name: 'Regular', emoji: '🗨️', metric: 'messages', target: 100 },
  { id: 'chatterbox', name: 'Chatterbox', emoji: '📣', metric: 'messages', target: 1000 },
  { id: 'legend', name: 'Legend of the Chat', emoji: '👑', metric: 'messages', target: 10000 },
  { id: 'hello-mic', name: 'Hello, Mic', emoji: '🎙️', metric: 'voice_hours', target: 1 },
  { id: 'good-company', name: 'Good Company', emoji: '🎧', metric: 'voice_hours', target: 10 },
  { id: 'always-online', name: 'Always Online', emoji: '📡', metric: 'voice_hours', target: 100 },
  { id: 'reactor', name: 'Reactor', emoji: '😄', metric: 'reactions', target: 50 },
  { id: 'hype-machine', name: 'Hype Machine', emoji: '🎉', metric: 'reactions', target: 500 },
  { id: 'week-around', name: 'A Week Around', emoji: '📅', metric: 'active_days', target: 7 },
  { id: 'monthly-regular', name: 'Monthly Regular', emoji: '🗓️', metric: 'active_days', target: 30 },
  { id: 'centurion', name: 'Centurion', emoji: '💯', metric: 'active_days', target: 100 },
  { id: 'three-in-a-row', name: 'Three in a Row', emoji: '🔥', metric: 'best_streak', target: 3 },
  { id: 'week-streak', name: 'Week Streak', emoji: '⚡', metric: 'best_streak', target: 7 },
  { id: 'month-streak', name: 'Month Streak', emoji: '🌟', metric: 'best_streak', target: 30 },
  { id: 'one-month-in', name: 'One Month In', emoji: '🌱', metric: 'member_days', target: 30 },
  { id: 'one-year-in', name: 'One Year In', emoji: '🎂', metric: 'member_days', target: 365 },
].map((a) => ({ ...a, description: `${a.target.toLocaleString('en-US')} ${METRICS[a.metric].label}`, kind: 'builtin' }));

export const CUSTOM_ID = /^[a-z0-9][a-z0-9-]{1,29}$/;
export const slugify = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

export const valueOf = (def, progress, extras) => METRICS[def.metric].get(progress, extras);

/** Built-in achievements the progress now satisfies. */
export function reached(progress, extras, defs = BUILTIN) {
  return defs.filter((d) => valueOf(d, progress, extras) >= d.target).map((d) => d.id);
}

/** The next few goals: for each metric, the nearest unreached target. Sorted by how close the member is. */
export function nextUp(progress, extras, unlocked, n = 4, defs = BUILTIN) {
  const have = new Set(unlocked);
  const byMetric = new Map();
  for (const d of defs) {
    if (have.has(d.id)) continue;
    const cur = byMetric.get(d.metric);
    if (!cur || d.target < cur.target) byMetric.set(d.metric, d);
  }
  return [...byMetric.values()]
    .map((d) => { const v = valueOf(d, progress, extras); return { def: d, value: Math.min(v, d.target), ratio: Math.min(1, v / d.target) }; })
    .sort((a, b) => b.ratio - a.ratio || a.def.target - b.def.target).slice(0, n);
}

export const progressLine = ({ def, value }) => `${def.emoji} **${def.name}** ${bar(value, def.target)} ${value.toLocaleString('en-US')}/${def.target.toLocaleString('en-US')} ${METRICS[def.metric].label}`;
