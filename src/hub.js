/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * The bot's side of the Good Boy hub (hub/worker.js): tells the hub which servers this bot is in and where its
 * dashboard is, and asks it which Good Boy bots run the other servers a person is in. Off unless GOODBOY_HUB_URL is set
 * (and GOODBOY_HUB is not "off"), and only when the dashboard has a public https link, since nobody else could open it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The official Good Boy hub, built in so every bot (Windows app ones included) joins without any setting. Empty until it is online. */
export const DEFAULT_HUB_URL = 'https://goodboyhub.pages.dev';
export const hubUrl = (env = process.env) => (String(env.GOODBOY_HUB ?? '').toLowerCase() === 'off' ? null : (String(env.GOODBOY_HUB_URL ?? DEFAULT_HUB_URL).replace(/\/+$/, '') || null));
export const signedText = (b) => JSON.stringify({ appId: b.appId, url: b.url ?? null, guilds: b.guilds ?? null, at: b.at, leave: !!b.leave });
const PROOF_RE = /\n?gb-hub:[0-9a-f]{20}/g;

/** This bot's hub key (made once, kept in the data folder). */
export function hubKey(dataDir) {
  const file = path.join(dataDir, 'hub-key.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* make one */ }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const k = { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(k), { mode: 0o600 });
  return k;
}
const sign = (key, body) => crypto.sign(null, Buffer.from(signedText(body)), crypto.createPrivateKey(key.privateKey)).toString('base64');

export class Hub {
  /** app: client.application (edit + description), url(): the dashboard's public link, guilds(): server ids. */
  constructor({ base, dataDir, app, url, guilds, log = () => {}, fetchFn = globalThis.fetch, now = () => Date.now() }) {
    Object.assign(this, { base, dataDir, app, url, guilds, log, fetchFn, now });
    this.cache = new Map(); // guild id -> { at, bots }
  }
  async post(p, body) {
    const r = await this.fetchFn(`${this.base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }
  /** Joins or updates. Proves control of the bot the first time, through a short-lived line in its description. */
  async register() {
    const url = this.url?.();
    if (!url || !/^https:\/\//.test(url)) return { ok: false, skipped: 'no public dashboard link' };
    const key = hubKey(this.dataDir);
    const body = () => { const b = { appId: this.app.id, publicKey: key.publicKey, url, guilds: this.guilds(), at: this.now() }; b.sig = sign(key, b); return b; };
    let r = await this.post('/v1/register', body());
    if (r.ok) return { ok: true };
    if (!r.data?.needsProof) { this.log(`Hub: ${r.data?.error ?? `HTTP ${r.status}`}`); return { ok: false, error: r.data?.error }; }
    const c = await this.post('/v1/challenge', { appId: this.app.id });
    if (!c.ok || !/^[0-9a-f]{20}$/.test(c.data?.nonce ?? '')) return { ok: false, error: 'no code from the hub' };
    const before = String(this.app.description ?? '').replace(PROOF_RE, '');
    try {
      await this.app.edit({ description: `${before}\ngb-hub:${c.data.nonce}`.slice(0, 400) });
      r = await this.post('/v1/register', { ...body(), nonce: c.data.nonce });
    } finally {
      await this.app.edit({ description: before }).catch((e) => this.log(`Hub: could not tidy the description (${e.message})`));
    }
    if (!r.ok) this.log(`Hub: ${r.data?.error ?? `HTTP ${r.status}`}`);
    return { ok: r.ok, error: r.data?.error };
  }
  async leave() {
    const key = hubKey(this.dataDir);
    const b = { appId: this.app.id, at: this.now(), leave: true };
    b.sig = sign(key, b);
    return (await this.post('/v1/leave', b)).ok;
  }
  /** Which Good Boy bots run these servers (other than this one). Cached for 10 minutes. */
  async lookup(guildIds) {
    const want = guildIds.filter((g) => { const c = this.cache.get(g); return !c || this.now() - c.at > 600000; }).slice(0, 200);
    if (want.length) {
      const r = await this.post('/v1/lookup', { guilds: want }).catch(() => null);
      for (const g of want) this.cache.set(g, { at: this.now(), bots: [] });
      for (const x of r?.data?.bots ?? []) if (x.appId !== this.app.id) this.cache.get(x.guildId)?.bots.push(x);
    }
    return guildIds.flatMap((g) => this.cache.get(g)?.bots ?? []);
  }
}
