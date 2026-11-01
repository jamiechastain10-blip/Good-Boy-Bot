/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Half-finished commands waiting for their popup. A command collects its simple options, shows a popup for the
 * long text, and the popup's submit finds the saved options again by a short token. Forms expire, belong to the
 * person who started them, and can be used once. Kept on a global so a hot reload does not drop forms in flight.
 */
import { randomBytes } from 'node:crypto';
import { UserError } from './util.js';

export function formStore(name, ttlMs = 15 * 60000) {
  const map = (globalThis[Symbol.for(`goodboy.forms.${name}`)] ??= new Map());
  return {
    /** Saves `data` (which must include `by`, the user id) and returns the token to put in the popup's customId. */
    put(data) {
      const now = Date.now();
      for (const [k, v] of map) if (v.exp < now) map.delete(k);
      const token = randomBytes(5).toString('hex');
      map.set(token, { ...data, exp: now + ttlMs });
      return token;
    },
    /** Returns the saved data once, or throws a message safe to show the member. */
    take(token, userId) {
      const f = map.get(token);
      if (!f || f.exp < Date.now()) throw new UserError('That form expired. Run the command again.');
      if (f.by !== userId) throw new UserError('That form belongs to someone else.');
      map.delete(token);
      return f;
    },
  };
}
