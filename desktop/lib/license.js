/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
// Licence keys. The owner's app signs them with a private key that never leaves the owner's computer; every app checks
// them with the matching public key. A key names one bot (its application ID), what it unlocks and until when, so it
// cannot be moved to another bot or have its date changed.
import crypto from 'node:crypto';

export const FEATURES = Object.freeze({ whitelabel: 'Own name, picture, banner and description (the Good Boy credit stays)' });
const PREFIX = 'GB1';
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ type: 'spki', format: 'pem' }), privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

/** days: number of days, or null for lifetime. until: a date (overrides days). */
export function createLicense({ privateKey, appId, to = '', days = null, until = null, features = ['whitelabel'], now = Date.now() }) {
  if (!/^\d{17,20}$/.test(String(appId ?? ''))) throw new Error('Enter the bot\'s Application ID (17 to 20 digits). It is on the bot\'s General Information page.');
  const feats = [...new Set(features)].filter((f) => Object.hasOwn(FEATURES, f));
  if (!feats.length) throw new Error('Choose what the licence unlocks.');
  let exp = null;
  if (until) { exp = new Date(until).getTime(); if (!Number.isFinite(exp) || exp <= now) throw new Error('The end date must be in the future.'); }
  else if (days != null) { if (!(Number(days) > 0 && Number(days) <= 36500)) throw new Error('Choose how long the licence lasts.'); exp = now + Number(days) * 86400000; }
  const payload = { v: 1, id: crypto.randomBytes(6).toString('hex'), app: String(appId), to: String(to).trim().slice(0, 80), features: feats, iat: now, exp };
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.sign(null, Buffer.from(`${PREFIX}.${body}`), crypto.createPrivateKey(privateKey));
  return { key: `${PREFIX}.${body}.${b64u(sig)}`, payload };
}

/** Checks a key. appId: the bot this app runs (the key must be for it). revoked: IDs of keys the owner cancelled. */
export function verifyLicense(key, publicKey, { appId = null, now = Date.now(), revoked = [] } = {}) {
  const k = String(key ?? '').trim();
  const parts = k.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, error: 'That is not a Good Boy licence key.' };
  if (!publicKey) return { ok: false, error: 'Licences are not switched on in this version yet.' };
  let good = false;
  try { good = crypto.verify(null, Buffer.from(`${PREFIX}.${parts[1]}`), crypto.createPublicKey(publicKey), unb64u(parts[2])); } catch { good = false; }
  if (!good) return { ok: false, error: 'This licence key is not genuine, or it was changed.' };
  let p; try { p = JSON.parse(unb64u(parts[1]).toString('utf8')); } catch { return { ok: false, error: 'That is not a Good Boy licence key.' }; }
  if (p.v !== 1 || !/^\d{17,20}$/.test(p.app) || !Array.isArray(p.features)) return { ok: false, error: 'That is not a Good Boy licence key.' };
  if (revoked.includes(p.id)) return { ok: false, payload: p, error: 'This licence was cancelled by Basic Ghost Labs.' };
  if (appId && p.app !== String(appId)) return { ok: false, payload: p, error: 'This licence is for a different bot.' };
  if (p.exp != null && p.exp <= now) return { ok: false, payload: p, expired: true, error: `This licence ended on ${new Date(p.exp).toLocaleDateString()}.` };
  return { ok: true, payload: p };
}

/** Where Good Boy apps download the list of cancelled licences. Licence Studio makes and signs it. */
export const CANCEL_LIST_URL = 'https://raw.githubusercontent.com/jamiechastain10-blip/Good-Boy-Bot/main/licences/revoked.json';

/** Reads a cancel list from Licence Studio. Returns { at, revoked } only if it was signed with the owner's key. */
export function readCancelList(text, publicKey) {
  if (!publicKey) return null;
  try {
    const f = typeof text === 'string' ? JSON.parse(text) : text;
    if (typeof f?.body !== 'string' || typeof f?.sig !== 'string' || f.body.length > 500000) return null;
    if (!crypto.verify(null, Buffer.from(f.body), crypto.createPublicKey(publicKey), unb64u(f.sig))) return null;
    const b = JSON.parse(f.body);
    if (b.v !== 1 || !Number.isFinite(b.at) || !Array.isArray(b.revoked)) return null;
    return { at: b.at, revoked: b.revoked.filter((x) => typeof x === 'string' && /^[0-9a-f]{12}$/.test(x)) };
  } catch { return null; }
}

export const hasFeature = (check, f) => !!check?.ok && check.payload.features.includes(f);
