/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Draws a sample image quote WITHOUT Discord, so you can check the image library works on this PC.
 * Run: npm run quote:test      Output: data/quote-test-bw.png, data/quote-test-color.png and data/quote-test-animated.gif
 */
import fs from 'node:fs';
import path from 'node:path';

let lib;
try { const m = await import('@napi-rs/canvas'); lib = typeof m.createCanvas === 'function' ? m : (m.default ?? m); }
catch (e) { console.error(`\n❌ Could not load @napi-rs/canvas: ${e.message}\n   Try: npm install @napi-rs/canvas\n`); process.exit(1); }

// make a stand-in avatar (a coloured gradient circle) so no network is needed
const av = lib.createCanvas(512, 512); const g = av.getContext('2d');
const grad = g.createLinearGradient(0, 0, 512, 512); grad.addColorStop(0, '#ff6b6b'); grad.addColorStop(1, '#4d96ff');
g.fillStyle = grad; g.fillRect(0, 0, 512, 512);
const avatarBuf = typeof av.encode === 'function' ? await av.encode('png') : av.toBuffer('image/png');

const { render } = await import('../modules/quotes/index.js');
fs.mkdirSync('data', { recursive: true });
for (const color of [false, true]) {
  try {
    const buf = await render({ text: 'Anyone who has never made a mistake has never tried anything new, and that is a pretty good reason to keep trying.', name: 'Sample Person', handle: 'sample', avatarBuf, when: 'Jan 1, 2026', color });
    const file = path.join('data', `quote-test-${color ? 'color' : 'bw'}.png`);
    fs.writeFileSync(file, buf);
    console.log(`✅ wrote ${file} (${buf.length} bytes)`);
  } catch (e) { console.error(`❌ rendering failed: ${e.stack ?? e.message}`); process.exit(1); }
}
// The animated version (what members with an animated profile picture get): a made-up moving avatar, no network needed.
try {
  const { encodeGif } = await import('../src/gif.js');
  const { renderAnimated } = await import('../modules/quotes/index.js');
  const frames = [];
  for (let n = 0; n < 16; n++) {
    const c = lib.createCanvas(256, 256); const x = c.getContext('2d');
    const gr = x.createLinearGradient(0, 0, 256, 256); gr.addColorStop(0, '#ff6b6b'); gr.addColorStop(1, '#4d96ff'); x.fillStyle = gr; x.fillRect(0, 0, 256, 256);
    x.fillStyle = '#ffe66d'; x.beginPath(); x.arc(40 + n * 11, 128 + Math.sin(n / 2) * 60, 40, 0, Math.PI * 2); x.fill();
    frames.push({ rgba: x.getImageData(0, 0, 256, 256).data, delay: 80 });
  }
  const gifBuf = await encodeGif({ width: 256, height: 256, frames });
  const t0 = Date.now();
  const out = await renderAnimated({ text: 'Moving profile pictures stay moving.', name: 'Sample Person', handle: 'sample', when: 'today', gifBuf, color: true });
  const file = path.join('data', 'quote-test-animated.gif');
  fs.writeFileSync(file, out);
  console.log(`✅ wrote ${file} (${out.length} bytes, ${Date.now() - t0} ms) - open it in a browser to see the circle move`);
} catch (e) { console.error(`❌ animated rendering failed: ${e.stack ?? e.message}`); process.exit(1); }
console.log('\nOpen the images in data/ to check they look right. If both exist, image quotes will work in Discord.\n');
