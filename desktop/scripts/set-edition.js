/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * node scripts/set-edition.js owner|consumer|developer
 * Chooses which build to make: writes edition.json and gives each build its own name and app ID, so all three can be
 * installed side by side with separate settings. Run on the build machine only; the change is not meant to be committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const NAMES = { owner: 'Good Boy Owner', consumer: 'Good Boy', developer: 'Good Boy Developer' };
export function editionConfig(pkg, id) {
  if (!Object.hasOwn(NAMES, id)) throw new Error('Use: owner, consumer or developer');
  const slug = NAMES[id].replace(/\s+/g, '-');
  const b = structuredClone(pkg.build);
  b.appId = id === 'consumer' ? 'com.basicghostlabs.goodboy' : `com.basicghostlabs.goodboy.${id}`;
  b.productName = NAMES[id];
  b.nsis = { ...b.nsis, artifactName: `${slug}-Setup-\${version}.\${ext}`, shortcutName: NAMES[id] };
  b.portable = { ...b.portable, artifactName: `${slug}-Portable-\${version}.\${ext}` };
  // Each edition has its own update feed in the releases repository (latest.yml for Good Boy, developer.yml, owner.yml).
  b.publish = (b.publish ?? []).map((x) => ({ ...x, channel: id === 'consumer' ? 'latest' : id }));
  b.mac = { ...b.mac, artifactName: `${slug}-\${version}-\${arch}.\${ext}` };
  return { ...pkg, productName: NAMES[id], build: b };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = process.argv[2];
  const file = path.resolve(here, '..', 'package.json');
  const pkg = editionConfig(JSON.parse(fs.readFileSync(file, 'utf8')), id);
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(path.resolve(here, '..', 'edition.json'), JSON.stringify({ edition: id }) + '\n');
  console.log(`Building: ${NAMES[id]}`);
}
