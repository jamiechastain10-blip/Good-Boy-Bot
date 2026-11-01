/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
const ring = [];
const MAX = 300;

function fmt(level, msg, meta) {
  const t = new Date().toISOString().slice(11, 19);
  let extra = '';
  if (meta && Object.keys(meta).length) {
    try { extra = ' ' + JSON.stringify(meta); } catch { extra = ''; }
  }
  return `[${t}] ${level.toUpperCase().padEnd(5)} ${msg}${extra}`;
}

function emit(level, msg, meta) {
  const line = fmt(level, msg, meta);
  ring.push({ ts: Date.now(), level, line });
  if (ring.length > MAX) ring.shift();
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

export const logger = {
  debug: (m, meta) => { if (process.env.DEBUG) emit('debug', m, meta); },
  info: (m, meta) => emit('info', m, meta),
  warn: (m, meta) => emit('warn', m, meta),
  error: (m, meta) => emit('error', m, meta),
  recent: (n = 100) => ring.slice(-n),
};
