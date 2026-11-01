/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * The signed release manifest. A manifest is an envelope { payload, signature }: `payload` is a JSON string and
 * `signature` an Ed25519 signature of exactly those bytes. The matching PUBLIC key is kept by the person who runs the
 * bot (update-public-key.pem next to .env), never taken from the download, so only whoever holds the private key can
 * publish an update the bot will accept.
 */
import crypto from 'node:crypto';
import semver from 'semver';

export class ManifestError extends Error { constructor(m) { super(m); this.name = 'ManifestError'; } }
export const CHANNELS = ['stable', 'beta', 'development'];
const MAX_PACKAGE_BYTES = 150 * 1024 * 1024;

export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ type: 'spki', format: 'pem' }), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

export function signManifest(payload, privateKeyPem) {
  const text = JSON.stringify(payload);
  return { payload: text, signature: crypto.sign(null, Buffer.from(text, 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64') };
}

const isHex64 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

function checkEntry(name, e) {
  if (!e || typeof e !== 'object') throw new ManifestError(`channel "${name}" is malformed`);
  if (!semver.valid(e.version)) throw new ManifestError(`channel "${name}" has an invalid version`);
  if (typeof e.url !== 'string' || !e.url || e.url.length > 2000) throw new ManifestError(`channel "${name}" has no download address`);
  if (!isHex64(e.sha256)) throw new ManifestError(`channel "${name}" has no valid sha256`);
  if (!Number.isInteger(e.size) || e.size < 1 || e.size > MAX_PACKAGE_BYTES) throw new ManifestError(`channel "${name}" has an invalid size`);
  if (e.minNode !== undefined && !semver.validRange(e.minNode)) throw new ManifestError(`channel "${name}" has an invalid minNode`);
  return { version: e.version, url: e.url, sha256: e.sha256, size: e.size, notes: String(e.notes ?? '').slice(0, 4000), publishedAt: e.publishedAt ? String(e.publishedAt).slice(0, 40) : null, minNode: e.minNode ?? null };
}

/** Verify the signature and shape. Returns { channels: { name: entry } }. */
export function verifyManifest(envelope, publicKeyPem) {
  if (!publicKeyPem) throw new ManifestError('No update signing key is set up, so updates cannot be trusted. See docs/UPDATES.md.');
  if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new ManifestError('The update manifest is not in the expected format.');
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(envelope.payload, 'utf8'), crypto.createPublicKey(publicKeyPem), Buffer.from(envelope.signature, 'base64')); }
  catch { throw new ManifestError('The update signing key could not be read.'); }
  if (!ok) throw new ManifestError('The update manifest signature is wrong. It was not signed with your key, or it was changed. Nothing was installed.');
  let p;
  try { p = JSON.parse(envelope.payload); } catch { throw new ManifestError('The update manifest is damaged.'); }
  if (p?.product !== 'good-boy' || p.schema !== 1) throw new ManifestError('The update manifest is for something else, or a newer format.');
  const channels = {};
  for (const [name, e] of Object.entries(p.channels ?? {})) { if (!CHANNELS.includes(name)) continue; channels[name] = checkEntry(name, e); }
  return { channels, issuedAt: p.issuedAt ?? null };
}

/** Which channels a person on `channel` may take releases from: beta also sees stable, development sees all. */
export const allowedChannels = (channel) => ({ stable: ['stable'], beta: ['stable', 'beta'], development: ['stable', 'beta', 'development'] }[channel] ?? ['stable']);

/** The newest release newer than `current`, or null. Also says when this computer can't run it. */
export function pickRelease(manifest, { channel = 'stable', current, nodeVersion = process.versions.node }) {
  let best = null;
  for (const name of allowedChannels(channel)) {
    const e = manifest.channels[name];
    if (!e || !semver.gt(e.version, current, { includePrerelease: true })) continue;
    if (!best || semver.gt(e.version, best.version, { includePrerelease: true })) best = { ...e, channel: name };
  }
  if (!best) return null;
  if (best.minNode && !semver.satisfies(nodeVersion, best.minNode, { includePrerelease: true })) best.blocked = `needs Node.js ${best.minNode} (you have ${nodeVersion})`;
  return best;
}
