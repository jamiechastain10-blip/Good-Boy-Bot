/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
// Which of the three builds this is. Hiding a feature is for tidiness only: the real protection for publishing is the
// signing key, which is never inside the app.
export const EDITIONS = Object.freeze({
  owner: { name: 'Owner', features: ['bot', 'levels', 'modules', 'updates', 'publish', 'import', 'seed', 'licenses'] },
  consumer: { name: '', features: ['bot', 'levels', 'modules', 'updates', 'import'] },
  developer: { name: 'Developer', features: ['bot', 'levels', 'modules', 'updates', 'import', 'devtools'] },
});
export function readEdition(raw) {
  const id = raw && typeof raw === 'object' && Object.hasOwn(EDITIONS, raw.edition) ? raw.edition : 'consumer';
  return { id, ...EDITIONS[id] };
}
