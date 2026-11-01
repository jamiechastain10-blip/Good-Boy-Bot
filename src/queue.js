/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */

const RANK = { high: 0, normal: 1, low: 2 };

/**
 * Fairness layer in front of Discord calls. discord.js already obeys Discord's real
 * rate limits internally; this queue adds what it doesn't: priorities, a global
 * concurrency cap, and a per-module cap so one noisy module can't starve the others.
 */
export class ApiQueue {
  constructor({ concurrency = 6, perModule = 3 } = {}) {
    this.concurrency = concurrency;
    this.perModule = perModule;
    this.running = 0;
    this.byModule = new Map();
    this.items = [];
    this.stats = { done: 0, failed: 0 };
  }

  run(moduleName, fn, { priority = 'normal' } = {}) {
    return new Promise((resolve, reject) => {
      const item = { moduleName, fn, resolve, reject, rank: RANK[priority] ?? 1, seq: this.stats.done + this.items.length + this.running };
      const at = this.items.findIndex((i) => i.rank > item.rank);
      if (at === -1) this.items.push(item); else this.items.splice(at, 0, item);
      this.#pump();
    });
  }

  #pump() {
    while (this.running < this.concurrency) {
      const idx = this.items.findIndex((i) => (this.byModule.get(i.moduleName) ?? 0) < this.perModule);
      if (idx === -1) return;
      const [item] = this.items.splice(idx, 1);
      this.running++;
      this.byModule.set(item.moduleName, (this.byModule.get(item.moduleName) ?? 0) + 1);
      Promise.resolve().then(item.fn).then(
        (v) => { this.stats.done++; item.resolve(v); },
        (e) => { this.stats.failed++; item.reject(e); },
      ).finally(() => {
        this.running--;
        this.byModule.set(item.moduleName, (this.byModule.get(item.moduleName) ?? 1) - 1);
        this.#pump();
      });
    }
  }

  snapshot() { return { running: this.running, waiting: this.items.length, ...this.stats }; }
}
