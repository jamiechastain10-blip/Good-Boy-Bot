/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * The live channel (2.3): one place where the bot announces "something changed in this server", so every open
 * dashboard, phone and desktop window can update straight away instead of waiting for a reload.
 *
 *   publish(guildId, 'modules')                                   a module was turned on or off
 *   publish(guildId, 'settings', { module, key })                 a setting changed (from anywhere)
 *   publish(guildId, 'data', { module })                          that module's numbers changed: refresh its panels
 *   publish(guildId, 'activity', { module, icon, text })          a line for the live activity feed
 *   publish(guildId, 'feedback', { ... })                         a tester sent feedback
 *
 * Activity lines never contain message text, only what happened ("AutoMod removed a message in #general").
 * Kept on a global so a hot reload keeps the listeners (the dashboard's open connections).
 */
import { EventEmitter } from 'node:events';

const bus = (globalThis[Symbol.for('goodboy.live')] ??= new EventEmitter().setMaxListeners(500));

// The last activity lines per server, so a dashboard that opens now can show what just happened.
const recent = (globalThis[Symbol.for('goodboy.live.recent')] ??= new Map());
export const RECENT_MAX = 30;

export function publish(guildId, type, data = {}) {
  if (!guildId || !type) return;
  const event = { guildId: String(guildId), type, data, at: Date.now() };
  if (type === 'activity') {
    const list = recent.get(event.guildId) ?? [];
    list.unshift({ ...data, at: event.at });
    if (list.length > RECENT_MAX) list.length = RECENT_MAX;
    recent.set(event.guildId, list);
  }
  bus.emit('event', event);
}

export const recentActivity = (guildId) => [...(recent.get(String(guildId)) ?? [])];

/** Listen to one server's events. Returns the function that stops listening. */
export function subscribe(guildId, fn) {
  const handler = (e) => { if (e.guildId === String(guildId)) fn(e); };
  bus.on('event', handler);
  return () => bus.off('event', handler);
}
