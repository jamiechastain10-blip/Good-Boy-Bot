/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Checks for updates and prepares them (download, verify, unpack). It never starts or stops the bot: the supervisor
 * does that, so a bad update can never take down the thing that would roll it back.
 *
 * Trust chain: signed manifest (your key) -> sha256 and size of the package -> strict unpacking -> health check.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyManifest, pickRelease, ManifestError } from './manifest.js';
import { StoreError } from './store.js';

export class UpdateError extends Error { constructor(m) { super(m); this.name = 'UpdateError'; } }
const MANIFEST_MAX = 256 * 1024;

export function assertFetchable(url) {
  let u;
  try { u = new URL(url); } catch { throw new UpdateError('The update address is not a valid web address.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new UpdateError('Updates must be downloaded over https.');
  if (u.username || u.password) throw new UpdateError('The update address must not contain a password.');
  return u;
}

async function fetchBytes(fetchImpl, url, { maxBytes, timeoutMs }) {
  assertFetchable(url);
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'good-boy-updater', Accept: '*/*' } });
    if (res.url) assertFetchable(res.url); // a redirect must not downgrade to plain http either
    if (!res.ok) throw new UpdateError(`The update server answered ${res.status}.`);
    const declared = Number(res.headers?.get?.('content-length'));
    if (declared > maxBytes) throw new UpdateError('The download is larger than expected, so it was refused.');
    const chunks = []; let total = 0;
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) { ctl.abort(); throw new UpdateError('The download is larger than expected, so it was refused.'); }
        chunks.push(Buffer.from(value));
      }
    } else { const b = Buffer.from(await res.arrayBuffer()); if (b.length > maxBytes) throw new UpdateError('The download is larger than expected, so it was refused.'); chunks.push(b); }
    return Buffer.concat(chunks);
  } catch (e) {
    if (e instanceof UpdateError) throw e;
    throw new UpdateError(e?.name === 'AbortError' ? 'The update server did not answer in time.' : `Could not reach the update server (${e?.cause?.code ?? e?.code ?? e?.message ?? 'network error'}).`);
  } finally { clearTimeout(timer); }
}

export class Updater {
  constructor({ store, manifestUrl, channel = 'stable', publicKey, fetchImpl = fetch, nodeVersion = process.versions.node, timeoutMs = 20000 }) {
    Object.assign(this, { store, manifestUrl, channel, publicKey, fetchImpl, nodeVersion, timeoutMs });
  }

  get configured() { return !!this.manifestUrl; }

  /** Ask the server what is newest. Returns { current, release } where release is null when up to date. */
  async check() {
    if (!this.manifestUrl) throw new UpdateError('No update address is set (UPDATE_MANIFEST_URL), so updates are switched off.');
    if (!this.publicKey) throw new UpdateError('No update signing key is installed (update-public-key.pem). Without it updates cannot be trusted. See docs/UPDATES.md.');
    const raw = await fetchBytes(this.fetchImpl, this.manifestUrl, { maxBytes: MANIFEST_MAX, timeoutMs: this.timeoutMs });
    let manifest;
    try { manifest = verifyManifest(JSON.parse(raw.toString('utf8')), this.publicKey); }
    catch (e) { if (e instanceof ManifestError) throw new UpdateError(e.message); throw new UpdateError('The update manifest could not be read.'); }
    const current = this.store.runningVersion();
    let release = pickRelease(manifest, { channel: this.channel, current, nodeVersion: this.nodeVersion });
    if (release) {
      release.url = new URL(release.url, this.manifestUrl).toString();
      assertFetchable(release.url);
      release.previouslyFailed = this.store.failedVersions().includes(release.version);
    }
    return { current, channel: this.channel, release, checkedAt: Date.now() };
  }

  /** Download, verify and unpack a release returned by check(). Returns { needsInstall }. */
  async prepare(release) {
    if (!release) throw new UpdateError('There is nothing to install.');
    if (release.blocked) throw new UpdateError(`This version ${release.blocked}.`);
    if (this.store.has(release.version)) return { needsInstall: [], alreadyUnpacked: true };
    const data = await fetchBytes(this.fetchImpl, release.url, { maxBytes: release.size, timeoutMs: Math.max(this.timeoutMs, 120000) });
    if (data.length !== release.size) throw new UpdateError('The download is not the size the signed manifest promised. Nothing was installed.');
    const sum = crypto.createHash('sha256').update(data).digest('hex');
    if (sum !== release.sha256) throw new UpdateError('The download does not match its signed checksum. Nothing was installed.');
    fs.mkdirSync(this.store.downloads, { recursive: true });
    fs.writeFileSync(path.join(this.store.downloads, `good-boy-${release.version}.tar.gz`), data);
    try { return { ...this.store.stage(data, release.version), alreadyUnpacked: false }; }
    catch (e) { if (e instanceof StoreError) throw new UpdateError(e.message); throw e; }
  }
}
