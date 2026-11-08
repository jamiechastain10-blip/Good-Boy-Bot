/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Media links for music (3.0.6), an opt-in add-on: OFF unless the bot owner turns it on themselves. When on, links from
 * YouTube, SoundCloud and the other sites yt-dlp understands play in voice, and Spotify track links are matched to the
 * same song on YouTube (Spotify's own audio can't be played by anything outside Spotify).
 *
 * Playing audio from these sites breaks their terms of service. That is why this is off by default, why only the bot
 * owner can switch it on, and why they see a warning first. It uses yt-dlp, a separate free program that Good Boy only
 * downloads after the owner agrees. Sites change often, so links can stop working until yt-dlp is updated.
 *
 * Direct links to audio files (.mp3, .ogg ...) are always fine and need none of this.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { UserError } from './util.js';

export const AUDIO_EXT = /\.(mp3|ogg|oga|opus|wav|flac|m4a|aac|webm)(\?.*)?$/i;
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[::1\])/i;

/** A web link that is safe to fetch (http or https, not a private address). */
export function cleanLink(raw) {
  let u; try { u = new URL(String(raw ?? '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || PRIVATE.test(u.hostname)) return null;
  return u;
}
/** A direct link to an audio file. Always allowed. */
export const isDirectAudio = (raw) => { const u = cleanLink(raw); return !!u && AUDIO_EXT.test(u.pathname); };
/** A Spotify track link: open.spotify.com/track/<id> (with or without the intl-xx part). */
export const spotifyTrackId = (raw) => { const u = cleanLink(raw); if (!u || !/(^|\.)spotify\.com$/i.test(u.hostname)) return null; return /\/track\/([A-Za-z0-9]{10,30})/.exec(u.pathname)?.[1] ?? null; };
export const isSpotify = (raw) => { const u = cleanLink(raw); return !!u && /(^|\.)spotify\.(com|link)$/i.test(u.hostname); };

const decode = (s) => String(s ?? '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const meta = (html, prop) => decode(new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, 'i').exec(html)?.[1] ?? new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${prop}"`, 'i').exec(html)?.[1]);
/** Song and artist from a Spotify track page's public preview tags. */
export function parseSpotifyPage(html) {
  const title = meta(html, 'og:title');
  const desc = meta(html, 'og:description'); // e.g. "Artist · Album · Song · 2021" or "Listen to X on Spotify. Song · Artist · 2021."
  const music = meta(html, 'music:musician_description');
  let artist = music || '';
  if (!artist && desc) {
    const parts = desc.replace(/^Listen to .*? on Spotify\.\s*/i, '').split(/\s+·\s+/).map((x) => x.trim()).filter(Boolean);
    artist = parts[0]?.toLowerCase() === 'song' ? (parts[1] ?? '') : (parts[0] ?? '');
  }
  return title ? { title, artist } : null;
}
export async function spotifyTrack(raw, { fetchFn = globalThis.fetch } = {}) {
  const id = spotifyTrackId(raw);
  if (!id) throw new UserError('Only Spotify song links work (open.spotify.com/track/...). Albums and playlists are not supported yet.');
  const r = await fetchFn(`https://open.spotify.com/track/${id}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GoodBoyBot)' }, signal: AbortSignal.timeout(10000) }).catch(() => null);
  const info = r?.ok ? parseSpotifyPage(await r.text()) : null;
  if (!info) throw new UserError("Couldn't read that Spotify link. Check it's a song link and try again.");
  return { ...info, link: `https://open.spotify.com/track/${id}` };
}

// ------------------------------------------------------------------ yt-dlp
const exe = (platform = process.platform) => (platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const DOWNLOAD = { win32: 'yt-dlp.exe', darwin: 'yt-dlp_macos', linux: 'yt-dlp_linux' };
/** Runs a program and collects its output. */
function run(bin, args, { spawnFn = realSpawn, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', child;
    try { child = spawnFn(bin, args, { windowsHide: true }); } catch (e) { resolve({ code: -1, out, err: e.message }); return; }
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d; if (out.length > 5e6) child.kill(); });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}
/** Where yt-dlp is: YTDLP_PATH, the bot's own copy, or one installed on the computer. Null if none works. */
export async function findYtDlp(toolDir, { spawnFn, env = process.env } = {}) {
  const tries = [env.YTDLP_PATH, toolDir && path.join(toolDir, exe()), exe()].filter(Boolean);
  for (const bin of tries) {
    if (bin.includes(path.sep) && !fs.existsSync(bin)) continue;
    const r = await run(bin, ['--version'], { spawnFn, timeoutMs: 15000 });
    if (r.code === 0) return { bin, version: r.out.trim() };
  }
  return null;
}
/** Downloads yt-dlp's official single-file program into the bot's tools folder. */
export async function downloadYtDlp(toolDir, { fetchFn = globalThis.fetch, platform = process.platform } = {}) {
  const name = DOWNLOAD[platform];
  if (!name) throw new UserError('yt-dlp has no ready-made program for this computer. Install it yourself and restart.');
  const r = await fetchFn(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${name}`, { signal: AbortSignal.timeout(120000) }).catch(() => null);
  if (!r?.ok) throw new UserError("Couldn't download yt-dlp from GitHub. Check the bot's internet connection and try again.");
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 500000) throw new UserError('The yt-dlp download looks broken. Try again in a minute.');
  fs.mkdirSync(toolDir, { recursive: true });
  const file = path.join(toolDir, exe(platform));
  fs.writeFileSync(file, buf, { mode: 0o755 });
  return file;
}
/**
 * Looks up a link (or a search) with yt-dlp. Returns { title, artist, seconds, page, site }. Throws a plain message
 * when the site can't be played (private video, age-restricted, live, not supported...).
 */
export async function lookup(bin, input, { spawnFn, maxSeconds = 3 * 3600 } = {}) {
  const r = await run(bin, ['-J', '--no-playlist', '--no-warnings', '--skip-download', '-f', 'bestaudio/best', input], { spawnFn, timeoutMs: 45000 });
  if (r.code !== 0) {
    const why = /Unsupported URL/i.test(r.err) ? "That site isn't supported." : /Private|unavailable|removed/i.test(r.err) ? 'That video is private or was removed.' : /Sign in|age/i.test(r.err) ? 'That one needs signing in (age-restricted or members only).' : 'It might be blocked right now; sites change often.';
    throw new UserError(`Couldn't play that link. ${why}`);
  }
  let j; try { j = JSON.parse(r.out); } catch { throw new UserError("Couldn't read that link's details."); }
  if (Array.isArray(j.entries)) j = j.entries.find(Boolean);
  if (!j) throw new UserError('Nothing was found for that.');
  if (j.is_live) throw new UserError("Live streams can't be played. Add it as a radio station instead.");
  const seconds = Number(j.duration) || null;
  if (seconds && seconds > maxSeconds) throw new UserError(`That's too long (over ${Math.round(maxSeconds / 3600)} hours).`);
  return { title: String(j.track ?? j.title ?? 'Song').slice(0, 200), artist: String(j.artist ?? j.uploader ?? j.channel ?? '').slice(0, 100), seconds, page: j.webpage_url ?? input, site: String(j.extractor_key ?? j.extractor ?? 'web').replace(/:.*/, '') };
}
/** Starts streaming the audio of a looked-up page. Returns { stream, stop }. */
export function stream(bin, page, { spawnFn = realSpawn } = {}) {
  const child = spawnFn(bin, ['-f', 'bestaudio/best', '--no-playlist', '--no-warnings', '-q', '-o', '-', page], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  return { stream: child.stdout, stop: () => { try { child.kill(); } catch { /* gone */ } } };
}
