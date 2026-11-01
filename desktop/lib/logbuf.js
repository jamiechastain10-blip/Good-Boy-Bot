/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
// Keeps the last lines of the bot's output for the window, with secrets removed before anything is stored.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// Discord bot tokens look like <id>.<time>.<hmac>; also hide anything after "token"/"secret" style labels.
const TOKEN = /[A-Za-z0-9_-]{23,30}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/g;
const LABELLED = /((?:token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi;

export function clean(line) {
  return String(line).replace(ANSI, '').replace(TOKEN, '[hidden]').replace(LABELLED, '$1[hidden]').replace(/\r/g, '').slice(0, 2000);
}

export class LogBuffer {
  constructor(max = 500) { this.max = max; this.lines = []; this.partial = ''; }
  /** Feed raw output (any chunking). Returns the new complete lines that were added. */
  push(chunk) {
    const text = this.partial + String(chunk);
    const parts = text.split('\n');
    this.partial = parts.pop();
    if (this.partial.length > 4000) { parts.push(this.partial); this.partial = ''; }
    const added = parts.map(clean).filter((l) => l.trim() !== '');
    this.lines.push(...added);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
    return added;
  }
  all() { return [...this.lines]; }
  clear() { this.lines = []; this.partial = ''; }
}
