/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * A small .tar.gz reader and writer with no dependencies.
 * The reader is deliberately strict because it unpacks downloaded files: it accepts only plain files and folders,
 * refuses any path that could leave the target folder, and enforces size limits. The writer exists so releases can
 * be built and tested without any external tool.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BLOCK = 512;
export const LIMITS = { maxEntries: 20000, maxFileBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 };

export class TarError extends Error { constructor(m) { super(m); this.name = 'TarError'; } }

/** Returns a clean relative path with forward slashes, or throws if it could escape or is odd. */
export function safeRelPath(name) {
  let p = String(name);
  if (p.includes('\0') || p.includes('\\')) throw new TarError(`unsafe path "${p.replace(/[^\x20-\x7e]/g, '?')}"`);
  p = p.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!p || p === '.') throw new TarError('empty path');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new TarError(`absolute path "${p}"`);
  for (const part of p.split('/')) if (part === '..' || part === '' || part === '.') throw new TarError(`unsafe path "${p}"`);
  return p;
}

const cstr = (buf, from, len) => { const s = buf.subarray(from, from + len); const z = s.indexOf(0); return s.subarray(0, z === -1 ? len : z).toString('utf8'); };
function octal(buf, from, len) {
  if (buf[from] & 0x80) throw new TarError('base-256 numbers are not supported');
  const s = cstr(buf, from, len).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError('bad number in header');
  return parseInt(s, 8);
}
function checksumOk(h) {
  const stored = octal(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  return sum === stored;
}
function parsePax(data) {
  const out = {}; let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i); if (sp < 0) break;
    const len = parseInt(data.subarray(i, sp).toString(), 10);
    if (!Number.isInteger(len) || len <= 0 || i + len > data.length) throw new TarError('bad pax header');
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Parse a .tar.gz buffer into [{ path, type: 'file'|'dir', mode, data }]. Throws TarError on anything unusual. */
export function readTarGz(gz, limits = LIMITS) {
  let buf;
  try { buf = zlib.gunzipSync(gz, { maxOutputLength: limits.maxTotalBytes + 64 * BLOCK * 1024 }); } catch (e) { throw new TarError(`not a valid .tar.gz (${e.code ?? e.message})`); }
  const entries = []; let off = 0; let total = 0; let longName = null; let pax = null;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    if (!checksumOk(h)) throw new TarError('corrupt archive (bad header checksum)');
    const size = octal(h, 124, 12); const type = String.fromCharCode(h[156] || 0x30); const mode = octal(h, 100, 8);
    off += BLOCK;
    if (size > limits.maxFileBytes) throw new TarError('a file in the archive is too large');
    if (off + size > buf.length) throw new TarError('archive is cut short');
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') { pax = parsePax(data); continue; }
    if (type === 'g') continue;
    if (type === 'L') { longName = cstr(data, 0, data.length); continue; }
    let name = longName ?? pax?.path ?? ((cstr(h, 345, 155) ? `${cstr(h, 345, 155)}/` : '') + cstr(h, 0, 100));
    longName = null; pax = null;
    if (type !== '0' && type !== '5') throw new TarError(`unsupported entry type "${type}" for "${name}" (links and devices are not allowed)`);
    if (entries.length >= limits.maxEntries) throw new TarError('too many entries');
    const rel = safeRelPath(name);
    total += size;
    if (total > limits.maxTotalBytes) throw new TarError('archive is too large when unpacked');
    entries.push({ path: rel, type: type === '5' ? 'dir' : 'file', mode, data: type === '5' ? Buffer.alloc(0) : Buffer.from(data) });
  }
  return entries;
}

/** Unpack into an existing, empty-ish folder. Returns the list of written file paths (relative). */
export function extractTarGz(gz, dest, { strip = 0, limits = LIMITS } = {}) {
  const root = path.resolve(dest);
  const written = [];
  for (const e of readTarGz(gz, limits)) {
    const parts = e.path.split('/').slice(strip);
    if (!parts.length) continue;
    const target = path.resolve(root, ...parts);
    if (target !== root && !target.startsWith(root + path.sep)) throw new TarError(`path escapes the target folder: ${e.path}`);
    if (e.type === 'dir') { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.data, { mode: e.mode & 0o111 ? 0o755 : 0o644 });
    written.push(parts.join('/'));
  }
  return written;
}

const put = (h, s, from, len) => { const b = Buffer.from(s, 'utf8'); if (b.length > len) throw new TarError(`value too long for header: ${s}`); b.copy(h, from); };
const putOct = (h, n, from, len) => { const s = n.toString(8).padStart(len - 1, '0'); put(h, `${s}\0`, from, len); };

/** Build a .tar.gz. entries: [{ path, data (string|Buffer), mode? }]. */
export function createTarGz(entries) {
  const parts = [];
  for (const e of entries) {
    const rel = safeRelPath(e.path);
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8');
    let name = rel; let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      let at = -1;
      for (let i = rel.indexOf('/'); i !== -1; i = rel.indexOf('/', i + 1)) if (Buffer.byteLength(rel.slice(0, i)) <= 155 && Buffer.byteLength(rel.slice(i + 1)) <= 100) at = i;
      if (at < 0) throw new TarError(`path too long: ${rel}`);
      prefix = rel.slice(0, at); name = rel.slice(at + 1);
    }
    const h = Buffer.alloc(BLOCK);
    put(h, name, 0, 100); putOct(h, e.mode ?? 0o644, 100, 8); putOct(h, 0, 108, 8); putOct(h, 0, 116, 8);
    putOct(h, data.length, 124, 12); putOct(h, Math.floor((e.mtime ?? 0) / 1000), 136, 12);
    h.fill(0x20, 148, 156); h[156] = 0x30; put(h, 'ustar\0', 257, 6); put(h, '00', 263, 2); put(h, prefix, 345, 155);
    let sum = 0; for (let i = 0; i < BLOCK; i++) sum += h[i];
    put(h, `${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    parts.push(h, data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}
