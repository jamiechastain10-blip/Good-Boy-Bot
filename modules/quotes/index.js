/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Image quotes. Three ways in:
 *   - right-click a message > Apps > "Quote Image" (black & white) or "Quote Image (Color)"
 *   - /quote message:<link or ID> [style]
 * Needs the optional @napi-rs/canvas package (loaded lazily, so a missing install never blocks the bot).
 * Reading message text needs the Message Content intent.
 * Self-test without Discord:  npm run quote:test
 */
import { ContextMenuCommandBuilder, SlashCommandBuilder, ApplicationCommandType, AttachmentBuilder, MessageFlags } from 'discord.js';
import { UserError, truncate, SNOWFLAKE, describeDiscordError } from '../../src/util.js';
import { decodeGif, encodeGif } from '../../src/gif.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const W = 1200, H = 630;
const lastUse = new Map();
const MAX_UPLOAD = 8 * 1024 * 1024; // Discord's smallest upload limit is 10 MB; stay well under it
// Drawing an animation is the heaviest thing the bot does, so only one is drawn at a time.
let animationQueue = Promise.resolve();
const animationLock = (fn) => { const run = animationQueue.then(fn); animationQueue = run.catch(() => {}); return run; };
let canvasLib = null;

async function load() {
  if (canvasLib) return canvasLib;
  let mod;
  try { mod = await import('@napi-rs/canvas'); }
  catch (e) { throw new UserError(`Image quotes need the \`@napi-rs/canvas\` package, and it didn't load (${truncate(e.message, 100)}). On the PC running the bot run \`npm install\`, then restart.`); }
  // CommonJS packages expose their API on `default` when imported from ESM; named exports are not guaranteed.
  const lib = typeof mod.createCanvas === 'function' ? mod : (mod.default ?? mod);
  if (typeof lib.createCanvas !== 'function' || typeof lib.loadImage !== 'function') throw new UserError("The canvas package loaded but doesn't look right. Try `npm install @napi-rs/canvas` again.");
  canvasLib = lib;
  return lib;
}

/** Word-wraps `text` to `maxWidth` using `measure(str) -> width`. Splits words that are wider than a line. Pure, so it is unit-tested. */
export function wrapText(measure, text, maxWidth) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (measure(w) > maxWidth && w.length > 1) {
        let cut = w.length;
        while (cut > 1 && measure(w.slice(0, cut)) > maxWidth) cut--;
        if (line) { lines.push(line); line = ''; }
        lines.push(w.slice(0, cut)); w = w.slice(cut);
      }
      const test = line ? `${line} ${w}` : w;
      if (measure(test) <= maxWidth) line = test; else { if (line) lines.push(line); line = w; }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Largest font size (from `max` down to `min`) at which the wrapped text fits in maxHeight. */
export function fitText(measureAt, text, maxWidth, maxHeight, { max = 54, min = 24, lineHeight = 1.25 } = {}) {
  let size = max, lines = [];
  for (; size >= min; size -= 2) {
    lines = wrapText((s) => measureAt(size, s), text, maxWidth);
    if (lines.length * size * lineHeight <= maxHeight) return { size, lines };
  }
  return { size: min, lines: lines.slice(0, Math.floor(maxHeight / (min * lineHeight))) };
}

/** The dark tile on the left: the avatar (or an initial), black & white unless `color`, fading into the black behind the text. */
const TILE_W = Math.ceil(H * 1.02); // the part of the picture the avatar can touch; the words start further right
function paintTile(g, tmp, drawSource, { name, color }) {
  const t = tmp.getContext('2d');
  t.clearRect(0, 0, H, H);
  const drewAvatar = drawSource ? drawSource(t) : false;
  if (!drewAvatar) { // no avatar available: a plain dark tile with the initial, so the quote still renders
    t.fillStyle = '#23272f'; t.fillRect(0, 0, H, H);
    t.fillStyle = '#5865f2'; t.font = 'bold 260px sans-serif'; t.textAlign = 'center'; t.textBaseline = 'middle';
    t.fillText(String(name).slice(0, 1).toUpperCase() || '?', H / 2, H / 2); t.textAlign = 'left';
  }
  if (!color) {
    const d = t.getImageData(0, 0, H, H);
    for (let p = 0; p < d.data.length; p += 4) { const y = 0.299 * d.data[p] + 0.587 * d.data[p + 1] + 0.114 * d.data[p + 2]; d.data[p] = d.data[p + 1] = d.data[p + 2] = y; }
    t.putImageData(d, 0, 0);
  }
  g.fillStyle = '#000'; g.fillRect(0, 0, TILE_W, H);
  g.drawImage(tmp, 0, 0);
  const fade = g.createLinearGradient(H * 0.45, 0, H * 1.02, 0);
  fade.addColorStop(0, 'rgba(0,0,0,0)'); fade.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = fade; g.fillRect(0, 0, TILE_W, H);
}

/** The words, name and date. Drawn once; they never overlap the tile. */
function paintCaption(g, { text, name, handle, when }) {
  const x = 660, maxW = W - x - 60, maxH = 380;
  const family = '"Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif';
  const { size, lines } = fitText((sz, s) => { g.font = `italic ${sz}px ${family}`; return g.measureText(s).width; }, `“${text}”`, maxW, maxH);
  g.font = `italic ${size}px ${family}`;
  const lh = size * 1.25;
  const top = 70 + (maxH - lines.length * lh) / 2;
  g.fillStyle = '#fff'; g.textBaseline = 'top'; g.textAlign = 'left';
  lines.forEach((l, n) => g.fillText(l, x, top + n * lh));
  g.font = `bold 30px ${family}`; g.fillStyle = '#fff';
  g.fillText(`— ${truncate(name, 28)}`, x, 490);
  g.font = `22px ${family}`; g.fillStyle = '#9a9a9a';
  g.fillText(`@${truncate(handle, 32)}  ·  ${when}`, x, 534);
}

export async function render({ text, name, handle, avatarBuf, when, color }) {
  const { createCanvas, loadImage } = await load();
  const canvas = createCanvas(W, H);
  const g = canvas.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  let img = null;
  if (avatarBuf) { try { img = await loadImage(avatarBuf); } catch { /* fall back to the initial */ } }
  paintTile(g, createCanvas(H, H), img ? (t) => { t.drawImage(img, 0, 0, H, H); return true; } : null, { name, color });
  paintCaption(g, { text, name, handle, when });
  return typeof canvas.encode === 'function' ? canvas.encode('png') : canvas.toBuffer('image/png'); // encode() runs off the main thread
}

const tick = () => new Promise((r) => setImmediate(r)); // lets the bot answer other people between frames
export const GIF_FRAMES = 60;

/**
 * The same picture with a moving avatar. Only the left tile changes from frame to frame, so the first frame is the
 * whole picture and every later frame is just that tile - a much smaller file. Returns null when the avatar has only
 * one picture (the caller then draws the normal still image).
 */
export async function renderAnimated({ text, name, handle, gifBuf, when, color }, { maxBytes = MAX_UPLOAD } = {}) {
  // Too big for Discord? Draw it again with fewer frames (same speed overall) before giving up.
  let out = null;
  for (const frames of [GIF_FRAMES, GIF_FRAMES / 2, GIF_FRAMES / 4]) {
    out = await drawAnimation({ text, name, handle, gifBuf, when, color }, frames);
    if (!out || out.length <= maxBytes) return out;
  }
  return out;
}

async function drawAnimation({ text, name, handle, gifBuf, when, color }, maxFrames) {
  const anim = decodeGif(gifBuf, { maxFrames });
  if (anim.frames.length < 2) return null;
  const { createCanvas } = await load();
  const canvas = createCanvas(W, H);
  const g = canvas.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  paintCaption(g, { text, name, handle, when });
  const tmp = createCanvas(H, H);
  const src = createCanvas(anim.width, anim.height);
  const sg = src.getContext('2d');
  const frames = [];
  for (let n = 0; n < anim.frames.length; n++) {
    const f = anim.frames[n];
    const px = sg.createImageData(anim.width, anim.height);
    px.data.set(f.rgba);
    sg.clearRect(0, 0, anim.width, anim.height);
    sg.putImageData(px, 0, 0);
    paintTile(g, tmp, (t) => { t.drawImage(src, 0, 0, H, H); return true; }, { name, color });
    const whole = n === 0;
    const w = whole ? W : TILE_W;
    const d = g.getImageData(0, 0, w, H);
    frames.push({ x: 0, y: 0, w, h: H, rgba: d.data, delay: f.delay });
    await tick();
  }
  return encodeGif({ width: W, height: H, frames }, { onFrame: tick });
}

// ---------------------------------------------------------------- motion quotes (2.3.3)
// Members with a normal profile picture get a GIF too: the picture slowly zooms in and out on a loop and a soft light
// sweeps across it. Only the left tile moves, so frames stay small.
export const MOTION_FRAMES = 28;
const MOTION_LOOP_MS = 2800;
export async function renderMotion(details, { maxBytes = MAX_UPLOAD } = {}) {
  let out = null;
  for (const frames of [MOTION_FRAMES, MOTION_FRAMES / 2]) {
    out = await drawMotion(details, frames);
    if (out.length <= maxBytes) return out;
  }
  return out;
}
/** One frame's zoom, sideways drift and shine position for a point in the loop (0..1). Pure, so it is unit-tested. */
export function motionAt(phase) {
  const wave = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase); // 0 -> 1 -> 0, so the loop has no jump
  return { zoom: 1 + 0.075 * wave, drift: Math.sin(2 * Math.PI * phase) * 0.012, shine: phase < 0.5 ? phase / 0.5 : null };
}
async function drawMotion({ text, name, handle, avatarBuf, when, color }, count) {
  const { createCanvas, loadImage } = await load();
  let img = null;
  if (avatarBuf) { try { img = await loadImage(avatarBuf); } catch { /* the initial tile still gets the shine */ } }
  const canvas = createCanvas(W, H);
  const g = canvas.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  paintCaption(g, { text, name, handle, when });
  const tmp = createCanvas(H, H);
  const frames = [];
  const delay = Math.round(MOTION_LOOP_MS / count);
  for (let n = 0; n < count; n++) {
    const { zoom, drift, shine } = motionAt(n / count);
    paintTile(g, tmp, img ? (t) => { const sz = H * zoom; t.drawImage(img, (H - sz) / 2 + drift * H, (H - sz) / 2, sz, sz); return true; } : null, { name, color });
    if (shine !== null) {
      const x = -H * 0.35 + shine * (TILE_W + H * 0.7);
      g.save();
      g.beginPath(); g.rect(0, 0, TILE_W, H); g.clip();
      g.transform(1, 0, -0.35, 1, 0, 0); // a slanted band
      const band = g.createLinearGradient(x - 90, 0, x + 90, 0);
      band.addColorStop(0, 'rgba(255,255,255,0)'); band.addColorStop(0.5, 'rgba(255,255,255,0.16)'); band.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = band; g.fillRect(x - 90, 0, 180 + H * 0.4, H);
      g.restore();
    }
    const w = n === 0 ? W : TILE_W;
    frames.push({ x: 0, y: 0, w, h: H, rgba: g.getImageData(0, 0, w, H).data, delay });
    await tick();
  }
  return encodeGif({ width: W, height: H, frames }, { onFrame: tick });
}

async function fetchAvatar(user) {
  try {
    const res = await fetch(user.displayAvatarURL({ extension: 'png', size: 512, forceStatic: true }), { signal: AbortSignal.timeout(10000) });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
  } catch { /* render without an avatar */ }
  return null;
}

const MAX_GIF_DOWNLOAD = 6 * 1024 * 1024;
/** The member's animated profile picture as GIF bytes, or null when they have a normal one (or it can't be fetched). */
async function fetchAnimatedAvatar(user) {
  if (!user?.avatar?.startsWith?.('a_')) return null;
  for (const size of [512, 256]) {
    try {
      const res = await fetch(user.avatarURL({ extension: 'gif', size, forceStatic: false }), { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_GIF_DOWNLOAD) continue; // too heavy: try the smaller size
      return buf.subarray(0, 4).toString('latin1') === 'GIF8' ? buf : null;
    } catch { return null; }
  }
  return null;
}

/**
 * Swappable pieces, so tests never touch the network or the canvas library. Shared through a global symbol
 * because the module manager loads its own copy of this file (a hot-reload-safe import), not the one a test imports.
 */
export const hooks = (globalThis[Symbol.for('goodboy.quotes.hooks')] ??= { render: (...a) => render(...a), renderAnimated: (...a) => renderAnimated(...a), fetchAvatar, fetchAnimatedAvatar });
hooks.renderMotion ??= (...a) => renderMotion(...a); // added in 2.3.3; kept on hot reloads of older hooks

/**
 * The channel quotes should be posted in, or null when they should stay where they were requested
 * (no channel configured, the channel is gone, or the member is already in it).
 */
export function quoteTarget(ctx, i) {
  const id = ctx.config.get('quoteChannel');
  const ch = id ? ctx.guild.channels.cache.get(id) : null;
  return ch?.isTextBased?.() && ch.id !== i.channelId ? ch : null;
}

/** Acknowledge within Discord's 3 seconds: privately when the quote is going to another channel, publicly otherwise. */
async function acknowledge(ctx, i) {
  if (i.deferred || i.replied) return;
  await i.deferReply(quoteTarget(ctx, i) ? { flags: EPH } : undefined);
}

async function quoteMessage(ctx, i, msg, color) {
  const last = lastUse.get(i.user.id) ?? 0;
  if (Date.now() - last < 8000) throw new UserError('Easy - wait a few seconds between quotes.');
  const text = truncate((msg.cleanContent ?? '').trim(), 420);
  if (!text) throw new UserError(ctx.hasIntent('MessageContent') ? 'That message has no text to quote.' : "I can't read message text yet. Turn on **Message Content Intent** in the Developer Portal (Bot > Privileged Gateway Intents) and restart me.");
  lastUse.set(i.user.id, Date.now());
  await acknowledge(ctx, i);
  const details = {
    text, name: msg.member?.displayName ?? msg.author.globalName ?? msg.author.username, handle: msg.author.username, color,
    when: new Date(msg.createdTimestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
  };

  // Nitro members with an animated profile picture get an animated quote. Anything that goes wrong (download, decode,
  // drawing, a file too big for Discord) quietly falls back to the normal still image - the quote is never refused.
  let buf = null, animated = false;
  if (ctx.config.get('animatedQuotes') && hooks.fetchAnimatedAvatar) {
    try {
      const gifBuf = await hooks.fetchAnimatedAvatar(msg.author);
      if (gifBuf) {
        const out = await animationLock(() => hooks.renderAnimated({ ...details, gifBuf }));
        if (out && out.length <= MAX_UPLOAD) { buf = out; animated = true; }
        else if (out) ctx.log.info(`Animated quote was ${out.length} bytes (over the ${MAX_UPLOAD} limit); sending the still image.`);
      }
    } catch (e) { ctx.log.warn(`Animated quote failed, using the still image: ${e.message}`); }
  }
  let avatarBuf = null;
  if (!buf) {
    avatarBuf = await hooks.fetchAvatar(msg.author);
    // Everyone else gets a moving quote too (a slow zoom and a shine); still image only if that fails or is too big.
    if (ctx.config.get('motionQuotes') && hooks.renderMotion) {
      try {
        const out = await animationLock(() => hooks.renderMotion({ ...details, avatarBuf }));
        if (out && out.length <= MAX_UPLOAD) { buf = out; animated = true; }
      } catch (e) { ctx.log.warn(`Motion quote failed, using the still image: ${e.message}`); }
    }
  }
  if (!buf) {
    try {
      buf = await hooks.render({ ...details, avatarBuf });
    } catch (e) {
      if (e instanceof UserError) throw e;
      ctx.log.error(`Quote render failed: ${e.stack ?? e.message}`);
      throw new UserError(`I couldn't draw that image (${truncate(e.message, 120)}). Run \`npm run quote:test\` on the bot's PC for details.`);
    }
  }
  const file = () => new AttachmentBuilder(buf, { name: animated ? 'quote.gif' : 'quote.png', description: truncate(`Quote by ${msg.author.username}: ${text}`, 900) });

  // A quote made in the wrong place is not refused: it is posted in the configured channel and the requester gets a private link.
  const target = quoteTarget(ctx, i);
  if (!target) return i.editReply({ files: [file()], allowedMentions: NOPING });
  try {
    const posted = await target.send({ content: `Quoted by <@${i.user.id}> · [original message](${msg.url})`, files: [file()], allowedMentions: NOPING });
    return i.editReply({ content: `Posted in <#${target.id}>: ${posted.url}`, allowedMentions: NOPING });
  } catch (e) {
    ctx.log.warn(`Quote could not be posted in ${target.id}: ${e.message}`);
    return i.editReply({ content: `${describeDiscordError(e, `post the quote in <#${target.id}>`)} Here it is privately instead.`, files: [file()], allowedMentions: NOPING });
  }
}

async function fetchByLinkOrId(i, raw) {
  const s = String(raw).trim();
  const link = /channels\/(\d+)\/(\d+)\/(\d+)/.exec(s);
  let channelId = i.channelId, messageId = s;
  if (link) {
    if (link[1] !== i.guildId) throw new UserError('That message is from a different server.');
    [, , channelId, messageId] = link;
  }
  if (!SNOWFLAKE.test(messageId)) throw new UserError('Give a message link (right-click > Copy Message Link) or a message ID from this channel.');
  const ch = i.guild.channels.cache.get(channelId) ?? (await i.guild.channels.fetch(channelId).catch(() => null));
  if (!ch?.isTextBased()) throw new UserError("I can't read that channel.");
  const perms = ch.permissionsFor(i.member);
  if (perms && !perms.has('ViewChannel')) throw new UserError("You can't see that channel, so I can't quote from it.");
  return ch.messages.fetch(messageId).catch(() => { throw new UserError("I couldn't find that message (check the link, and that I can read that channel)."); });
}

export default {
  name: 'quotes',
  version: '1.2.0',
  description: 'Turn any message into a shareable image quote (right-click a message > Apps, or /quote).',
  settings: [
    { key: 'motionQuotes', type: 'toggle', label: 'Make every quote a GIF (normal profile pictures get a slow zoom and a shine)', description: 'Falls back to a still image automatically if it fails or is too big.', default: true },
    { key: 'animatedQuotes', type: 'toggle', label: 'Animated quotes for members with an animated profile picture', description: 'Falls back to a still image automatically when the animation is too big or fails.', default: true },
    { key: 'quoteChannel', type: 'channel', label: 'Channel where image quotes are posted', description: 'Quotes made in any other channel are posted here automatically. Leave empty to post where the command was used.' },
  ],
  permissions: [{ key: 'quotes.use', label: 'Create image quotes', default: 'everyone' }],
  commands: [
    {
      permission: 'quotes.use',
      data: new SlashCommandBuilder().setName('quote').setDescription('Turn a message into an image quote')
        .addStringOption((o) => o.setName('message').setDescription('Message link (Copy Message Link) or ID from this channel').setRequired(true))
        .addStringOption((o) => o.setName('style').setDescription('Look').addChoices({ name: 'black & white', value: 'bw' }, { name: 'color', value: 'color' })),
      async execute(ctx, i) {
        await acknowledge(ctx, i);
        const msg = await fetchByLinkOrId(i, i.options.getString('message', true));
        return quoteMessage(ctx, i, msg, i.options.getString('style') === 'color');
      },
    },
    {
      permission: 'quotes.use',
      data: new ContextMenuCommandBuilder().setName('Quote Image').setType(ApplicationCommandType.Message),
      execute: (ctx, i) => quoteMessage(ctx, i, i.targetMessage, false),
    },
    {
      permission: 'quotes.use',
      data: new ContextMenuCommandBuilder().setName('Quote Image (Color)').setType(ApplicationCommandType.Message),
      execute: (ctx, i) => quoteMessage(ctx, i, i.targetMessage, true),
    },
  ],
  tasks: [{ name: 'cleanup', everyMs: 600000, async run() { const now = Date.now(); for (const [k, v] of lastUse) if (now - v > 60000) lastUse.delete(k); } }],
};
