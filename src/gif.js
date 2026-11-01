/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * A small, dependency-free GIF reader and writer, used to keep animated profile pictures moving in image quotes.
 *  - decodeGif: any GIF89a/GIF87a (local and global palettes, transparency, interlacing, all disposal modes) into
 *    fully composited RGBA frames. Very long animations are thinned out, keeping the overall timing.
 *  - encodeGif: frames (or sub-rectangles of frames) of RGBA pixels into an animated GIF with a looping header.
 * Everything is bounds-checked, because the input is a file downloaded from the internet.
 */

export class GifError extends Error {}

// ---------------------------------------------------------------- reading
const MAX_PIXELS = 1024 * 1024; // refuse absurd canvases (a 512x512 avatar is 262144)

function lzwDecode(minSize, data, count) {
  const clear = 1 << minSize, eoi = clear + 1;
  const out = new Uint8Array(count);
  const prefix = new Uint16Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097);
  let size = minSize + 1, next = eoi + 1, prev = -1, first = 0;
  let bits = 0, nbits = 0, pos = 0, op = 0;
  while (op < count) {
    while (nbits < size) { if (pos >= data.length) return out.subarray(0, op); bits |= data[pos++] << nbits; nbits += 8; }
    const code = bits & ((1 << size) - 1);
    bits >>>= size; nbits -= size;
    if (code === clear) { size = minSize + 1; next = eoi + 1; prev = -1; continue; }
    if (code === eoi) break;
    if (prev === -1) {
      if (code >= clear) throw new GifError('Corrupt GIF data.');
      out[op++] = code; prev = code; first = code; continue;
    }
    if (code > next) throw new GifError('Corrupt GIF data.');
    let sp = 0, cur = code;
    if (code === next) { stack[sp++] = first; cur = prev; }
    while (cur >= clear) { stack[sp++] = suffix[cur]; cur = prefix[cur]; }
    stack[sp++] = cur; first = cur;
    while (sp > 0 && op < count) out[op++] = stack[--sp];
    if (next < 4096) {
      prefix[next] = prev; suffix[next] = first; next++;
      if (next === (1 << size) && size < 12) size++;
    }
    prev = code;
  }
  return out.subarray(0, op);
}

/**
 * @param {Uint8Array} buf
 * @param {{maxFrames?: number}} opts
 * @returns {{width: number, height: number, frames: {rgba: Uint8ClampedArray, delay: number}[], totalFrames: number}}
 *  `delay` is in milliseconds. `totalFrames` is how many the file really had.
 */
export function decodeGif(buf, { maxFrames = 80 } = {}) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const sig = String.fromCharCode(...b.subarray(0, 6));
  if (sig !== 'GIF89a' && sig !== 'GIF87a') throw new GifError('That is not a GIF.');
  const u16 = (p) => b[p] | (b[p + 1] << 8);
  const need = (p, n) => { if (p + n > b.length) throw new GifError('The GIF is cut short.'); };
  need(0, 13);
  const width = u16(6), height = u16(8);
  if (!width || !height || width * height > MAX_PIXELS) throw new GifError('That GIF has an unusable size.');
  let pos = 13;
  let globalTable = null;
  if (b[10] & 0x80) { const n = 3 << ((b[10] & 7) + 1); need(pos, n); globalTable = b.subarray(pos, pos + n); pos += n; }

  const skipBlocks = () => { for (;;) { need(pos, 1); const n = b[pos++]; if (!n) return; need(pos, n); pos += n; } };

  // Pass 1: find the frames.
  const raw = [];
  let gce = null;
  for (;;) {
    need(pos, 1);
    const t = b[pos++];
    if (t === 0x3b) break;
    if (t === 0x21) {
      need(pos, 1);
      const label = b[pos++];
      if (label === 0xf9) {
        need(pos, 6);
        const flags = b[pos + 1];
        gce = { disposal: (flags >> 2) & 7, transparent: flags & 1 ? b[pos + 4] : -1, delay: u16(pos + 2) * 10 };
        pos += 6; // size byte + 4 data + terminator
      } else skipBlocks();
      continue;
    }
    if (t !== 0x2c) throw new GifError('Corrupt GIF structure.');
    need(pos, 9);
    const f = { x: u16(pos), y: u16(pos + 2), w: u16(pos + 4), h: u16(pos + 6), flags: b[pos + 8], gce };
    gce = null; pos += 9;
    let table = globalTable;
    if (f.flags & 0x80) { const n = 3 << ((f.flags & 7) + 1); need(pos, n); table = b.subarray(pos, pos + n); pos += n; }
    need(pos, 1);
    f.minSize = b[pos++];
    if (f.minSize < 1 || f.minSize > 11) throw new GifError('Corrupt GIF data.');
    const chunks = []; let total = 0;
    for (;;) { need(pos, 1); const n = b[pos++]; if (!n) break; need(pos, n); chunks.push(b.subarray(pos, pos + n)); total += n; pos += n; }
    f.data = new Uint8Array(total);
    let o = 0; for (const c of chunks) { f.data.set(c, o); o += c.length; }
    f.table = table;
    raw.push(f);
    if (raw.length > 5000) throw new GifError('That GIF has too many frames.');
  }
  if (!raw.length) throw new GifError('That GIF has no pictures.');

  // Pass 2: composite. A frame is only kept every `step` frames, and the skipped delays are added to the kept one.
  const step = Math.max(1, Math.ceil(raw.length / maxFrames));
  const canvas = new Uint8ClampedArray(width * height * 4);
  const frames = [];
  let restore = null, lastRect = null, lastDisposal = 0;
  raw.forEach((f, n) => {
    if (lastDisposal === 2 && lastRect) clearRect(canvas, width, height, lastRect);
    else if (lastDisposal === 3 && restore) canvas.set(restore);
    const disposal = f.gce?.disposal ?? 0;
    restore = disposal === 3 ? canvas.slice() : null;

    const x0 = Math.min(f.x, width), y0 = Math.min(f.y, height);
    const w = Math.min(f.w, width - x0), h = Math.min(f.h, height - y0);
    if (f.table && w > 0 && h > 0) {
      const idx = lzwDecode(f.minSize, f.data, f.w * f.h);
      const rows = deinterlaceRows(f.h, !!(f.flags & 0x40));
      const t = f.gce?.transparent ?? -1;
      for (let r = 0; r < f.h; r++) {
        const y = y0 + rows[r];
        if (rows[r] >= h || y >= height) continue;
        for (let c = 0; c < w; c++) {
          const k = r * f.w + c;
          if (k >= idx.length) break;
          const ci = idx[k];
          if (ci === t) continue;
          const p = ci * 3, q = (y * width + x0 + c) * 4;
          if (p + 2 >= f.table.length) continue;
          canvas[q] = f.table[p]; canvas[q + 1] = f.table[p + 1]; canvas[q + 2] = f.table[p + 2]; canvas[q + 3] = 255;
        }
      }
    }
    lastRect = { x: x0, y: y0, w, h }; lastDisposal = disposal;
    const d = Math.max(f.gce?.delay ?? 0, 20); // browsers treat tiny delays as 100ms; 20ms is the shortest worth keeping
    if (n % step === 0) frames.push({ rgba: canvas.slice(), delay: d }); else frames[frames.length - 1].delay += d;
  });
  return { width, height, frames, totalFrames: raw.length };
}

function clearRect(canvas, width, height, r) {
  for (let y = r.y; y < Math.min(height, r.y + r.h); y++) canvas.fill(0, (y * width + r.x) * 4, (y * width + Math.min(width, r.x + r.w)) * 4);
}

function deinterlaceRows(h, interlaced) {
  const rows = new Array(h);
  if (!interlaced) { for (let i = 0; i < h; i++) rows[i] = i; return rows; }
  let n = 0;
  for (const [start, inc] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < h; y += inc) rows[n++] = y;
  return rows;
}

// ---------------------------------------------------------------- colour reduction
/**
 * Reduces RGBA pixels (alpha is ignored; paint onto a solid background first) to at most 256 colours with median cut
 * on a 15-bit histogram - fast enough for hundreds of thousands of pixels, and much better than a fixed palette.
 * @returns {{palette: Uint8Array, indices: Uint8Array, colors: number}}
 */
export function quantize(rgba, maxColors = 256) {
  const n = rgba.length >> 2;
  // Black & white pictures: use the grey levels as they are (the histogram below only has 32 levels per channel).
  let grey = true;
  for (let p = 0; p < rgba.length; p += 4) if (rgba[p] !== rgba[p + 1] || rgba[p] !== rgba[p + 2]) { grey = false; break; }
  if (grey && maxColors >= 256) {
    const palette = new Uint8Array(256 * 3), indices = new Uint8Array(n);
    for (let v = 0; v < 256; v++) palette[v * 3] = palette[v * 3 + 1] = palette[v * 3 + 2] = v;
    for (let i = 0; i < n; i++) indices[i] = rgba[i * 4];
    return { palette, indices, colors: 256 };
  }
  const bin = new Uint16Array(n);
  const counts = new Uint32Array(32768);
  const sums = new Float64Array(32768 * 3);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p], g = rgba[p + 1], bl = rgba[p + 2];
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (bl >> 3);
    bin[i] = k; counts[k]++;
    sums[k * 3] += r; sums[k * 3 + 1] += g; sums[k * 3 + 2] += bl;
  }
  const present = [];
  for (let k = 0; k < 32768; k++) if (counts[k]) present.push(k);
  const comp = (k, c) => (c === 0 ? k >> 10 : c === 1 ? (k >> 5) & 31 : k & 31);

  let boxes = [present];
  while (boxes.length < maxColors) {
    // split the box with the widest colour range (weighted by nothing but range - cheap and good enough)
    let best = -1, bestRange = 0, bestC = 0;
    boxes.forEach((box, bi) => {
      if (box.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 31, hi = 0;
        for (const k of box) { const v = comp(k, c); if (v < lo) lo = v; if (v > hi) hi = v; }
        if (hi - lo > bestRange) { bestRange = hi - lo; best = bi; bestC = c; }
      }
    });
    if (best < 0) break;
    const box = boxes[best].sort((a, b) => comp(a, bestC) - comp(b, bestC));
    // split at the pixel-count median so common colours get more palette entries
    let total = 0; for (const k of box) total += counts[k];
    let acc = 0, cut = 1;
    for (let j = 0; j < box.length - 1; j++) { acc += counts[box[j]]; cut = j + 1; if (acc * 2 >= total) break; }
    boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
  }

  const palette = new Uint8Array(256 * 3);
  const toIndex = new Uint8Array(32768);
  boxes.forEach((box, bi) => {
    let r = 0, g = 0, bl = 0, c = 0;
    for (const k of box) { r += sums[k * 3]; g += sums[k * 3 + 1]; bl += sums[k * 3 + 2]; c += counts[k]; toIndex[k] = bi; }
    palette[bi * 3] = Math.round(r / c); palette[bi * 3 + 1] = Math.round(g / c); palette[bi * 3 + 2] = Math.round(bl / c);
  });
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = toIndex[bin[i]];
  return { palette, indices, colors: boxes.length };
}

// ---------------------------------------------------------------- writing
function lzwEncode(minSize, indices) {
  const clear = 1 << minSize, eoi = clear + 1;
  const HS = 9973;
  const keys = new Int32Array(HS), vals = new Uint16Array(HS);
  const out = [];
  let acc = 0, nbits = 0, size = minSize + 1, next = eoi + 1;
  const emit = (code) => {
    acc |= code << nbits; nbits += size;
    while (nbits >= 8) { out.push(acc & 255); acc >>>= 8; nbits -= 8; }
  };
  keys.fill(-1);
  emit(clear);
  let cur = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i];
    const key = (cur << 8) | c;
    let h = Math.imul(key, 2654435761) >>> 0; h %= HS;
    while (keys[h] !== -1 && keys[h] !== key) h = (h + 1) % HS;
    if (keys[h] === key) { cur = vals[h]; continue; }
    emit(cur);
    if (next < 4096) {
      keys[h] = key; vals[h] = next;
      if (next === (1 << size) && size < 12) size++;
      next++;
    } else {
      emit(clear); keys.fill(-1); size = minSize + 1; next = eoi + 1;
    }
    cur = c;
  }
  emit(cur);
  emit(eoi);
  if (nbits > 0) out.push(acc & 255);
  return out;
}

/**
 * @param {{width: number, height: number, loop?: number, frames: {x?: number, y?: number, w?: number, h?: number, rgba: Uint8Array|Uint8ClampedArray, delay: number}[]}} gif
 *  Each frame is a rectangle (default: the whole picture) painted over the previous frame. `delay` is in milliseconds.
 *  `onFrame` (optional, async) is awaited between frames so a long encode does not freeze the bot.
 */
export async function encodeGif({ width, height, loop = 0, frames }, { onFrame } = {}) {
  if (!frames.length) throw new GifError('A GIF needs at least one frame.');
  const parts = [];
  const push = (...bytes) => parts.push(Uint8Array.from(bytes));
  const le = (n) => [n & 255, (n >> 8) & 255];
  parts.push(Uint8Array.from([...Buffer.from('GIF89a'), ...le(width), ...le(height), 0x70, 0, 0]));
  parts.push(Uint8Array.from([0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, ...le(loop), 0]));
  for (const f of frames) {
    const x = f.x ?? 0, y = f.y ?? 0, w = f.w ?? width, h = f.h ?? height;
    if (w < 1 || h < 1 || x + w > width || y + h > height || f.rgba.length !== w * h * 4) throw new GifError('A frame does not fit the picture.');
    const { palette, indices, colors } = quantize(f.rgba);
    let tb = 1; while ((1 << tb) < colors) tb++; // the palette holds 2^tb colours (GIF's smallest table is 2)
    const minSize = Math.max(2, tb);
    const delay = Math.max(2, Math.round(f.delay / 10));
    push(0x21, 0xf9, 4, 0x04, ...le(delay), 0, 0); // disposal 1: leave the picture, the next frame paints over it
    push(0x2c, ...le(x), ...le(y), ...le(w), ...le(h), 0x80 | (tb - 1));
    parts.push(palette.subarray(0, (1 << tb) * 3));
    push(minSize);
    const data = lzwEncode(minSize, indices);
    for (let p = 0; p < data.length; p += 255) { const chunk = data.slice(p, p + 255); push(chunk.length); parts.push(Uint8Array.from(chunk)); }
    push(0);
    if (onFrame) await onFrame();
  }
  push(0x3b);
  return Buffer.concat(parts);
}
