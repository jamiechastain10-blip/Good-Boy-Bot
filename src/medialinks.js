/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Media links for music (3.0.6), an opt-in add-on: OFF unless the bot owner turns it on themselves. When on, links from
 * YouTube, SoundCloud, BandLab and the other sites yt-dlp or a page read understands play in voice, and Spotify track links are matched to the
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
  if (!id) throw new UserError('Use a Spotify song, playlist or album link (open.spotify.com/track/..., /playlist/... or /album/...). Artists, podcasts and liked songs are not supported.');
  const r = await fetchFn(`https://open.spotify.com/track/${id}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GoodBoyBot)' }, signal: AbortSignal.timeout(10000) }).catch(() => null);
  const info = r?.ok ? parseSpotifyPage(await r.text()) : null;
  if (!info) throw new UserError("Couldn't read that Spotify link. Check it's a song link and try again.");
  return { ...info, link: `https://open.spotify.com/track/${id}` };
}

// ------------------------------------------------------------------ Spotify playlists and albums
/** A Spotify playlist or album link: { kind, id } or null. */
export function spotifyListId(raw) {
  const u = cleanLink(raw); if (!u || !/(^|\.)spotify\.com$/i.test(u.hostname)) return null;
  const m = /\/(playlist|album)\/([A-Za-z0-9]{10,40})/.exec(u.pathname);
  return m ? { kind: m[1], id: m[2] } : null;
}
/** The songs on Spotify's public embed page: { name, tracks: [{ title, artist, seconds }] } or null. */
export function parseSpotifyEmbed(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(String(html ?? ''));
  let e; try { e = JSON.parse(m?.[1] ?? '').props.pageProps.state.data.entity; } catch { return null; }
  const tracks = (Array.isArray(e?.trackList) ? e.trackList : [])
    .filter((t) => t?.title && t.isPlayable !== false && (t.entityType ?? 'track') === 'track')
    .map((t) => ({ title: String(t.title).slice(0, 200), artist: String(t.subtitle ?? '').replace(/ /g, ' ').split(/,\s*/)[0].slice(0, 100), seconds: Math.round(Number(t.duration) / 1000) || null }));
  return tracks.length ? { name: String(e.name ?? e.title ?? 'Spotify playlist').slice(0, 100), tracks } : null;
}
export async function spotifyList(raw, { fetchFn = globalThis.fetch } = {}) {
  const l = spotifyListId(raw); if (!l) return null;
  const r = await fetchFn(`https://open.spotify.com/embed/${l.kind}/${l.id}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GoodBoyBot)' }, signal: AbortSignal.timeout(10000) }).catch(() => null);
  const list = r?.ok ? parseSpotifyEmbed(await r.text()) : null;
  if (!list) throw new UserError(`Couldn't read that Spotify ${l.kind}. Check it's public and try again.`);
  return { ...list, kind: l.kind, link: `https://open.spotify.com/${l.kind}/${l.id}` };
}
/** The YouTube search used to play a Spotify song. */
export const spotifySearch = (t) => `ytsearch1:${t.artist} ${t.title} audio`;

// ------------------------------------------------------------------ BandLab
// BandLab pages are drawn in the browser, so neither yt-dlp nor a page read always finds the song. BandLab's own public
// API (the one its website uses) gives each song's mixdown as a plain .m4a file, which plays like any audio link.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export const isBandLab = (raw) => { const u = cleanLink(raw); return !!u && /(^|\.)bandlab\.com$/i.test(u.hostname); };
/** API addresses to try for a BandLab link: /post/<id>, /track/<id>, /embed/?id=<id>, ?revId= ... */
export function bandlabTargets(raw) {
  const u = cleanLink(raw); if (!u || !isBandLab(raw)) return [];
  const api = 'https://www.bandlab.com/api/v1.3/';
  const id = UUID.exec(u.pathname)?.[0] ?? UUID.exec(u.searchParams.get('id') ?? '')?.[0];
  if (!id) return [];
  const kind = /^\/post\//i.test(u.pathname) ? ['posts'] : /^\/(track|song)s?\//i.test(u.pathname) ? ['songs', 'posts'] : ['posts', 'songs'];
  return kind.map((k) => `${api}${k}/${id}`);
}
/** The song in a BandLab post or song reply: { title, artist, seconds, url } or null. */
export function parseBandLab(d) {
  const rev = d?.revision ?? null;
  const file = rev?.mixdown?.file;
  if (!file || !/^https:\/\/[^/]*bandlab\.com\//i.test(file)) return null;
  const title = rev.song?.name ?? d.name ?? rev.title ?? 'BandLab song';
  const artist = rev.creator?.name ?? d.author?.name ?? d.creator?.name ?? '';
  return { title: String(title).slice(0, 200), artist: String(artist).slice(0, 100), seconds: Math.round(Number(rev.mixdown.duration)) || null, url: file };
}
export async function bandlabTrack(raw, { fetchFn = globalThis.fetch } = {}) {
  const targets = bandlabTargets(raw);
  if (!targets.length) throw new UserError('Use a BandLab song or post link (bandlab.com/post/... or bandlab.com/track/...). Albums and playlists are not supported yet.');
  let busy = false;
  for (const t of targets) {
    const r = await fetchFn(t, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GoodBoyBot)', Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (r?.status === 406 || r?.status === 429) busy = true;
    if (!r?.ok) continue;
    const song = parseBandLab(await r.json().catch(() => null));
    if (song) return { ...song, page: cleanLink(raw).href, site: 'BandLab' };
  }
  throw new UserError(busy ? 'BandLab is busy right now. Try again in a minute.' : "Couldn't find a song in that BandLab link. Check it's public and it's a song (not a video or text post).");
}

// ------------------------------------------------------------------ any other page
const attr = (tag, name) => decode(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1]);
/**
 * Finds a playable audio file in a web page: the audio tags sites add for link previews (og:audio, twitter:player:stream),
 * a JSON-LD contentUrl, an <audio>/<source> tag, or any link to an audio file. Returns { url, title } or null.
 */
export function audioFromPage(html, base) {
  const h = String(html ?? '');
  const abs = (x) => { try { const u = new URL(decode(x), base); return /^https?:$/.test(u.protocol) && !PRIVATE.test(u.hostname) ? u.href : null; } catch { return null; } };
  const found = [];
  for (const p of ['og:audio:secure_url', 'og:audio:url', 'og:audio', 'twitter:player:stream']) { const v = meta(h, p); if (v) found.push(v); }
  for (const m of h.matchAll(/"contentUrl"\s*:\s*"([^"]+)"/gi)) found.push(m[1].replace(/\\\//g, '/'));
  for (const m of h.matchAll(/<(?:audio|source)\b[^>]*>/gi)) { const v = attr(m[0], 'src'); if (v) found.push(v); }
  for (const m of h.matchAll(/https?:(?:\\?\/){2}[^\s"'<>()]+?\.(?:mp3|ogg|oga|opus|wav|flac|m4a|aac)(?:\?[^\s"'<>()]*)?(?=["'<>\s)])/gi)) found.push(m[0].replace(/\\\//g, '/'));
  const url = found.map(abs).find((u) => u && (AUDIO_EXT.test(new URL(u).pathname) || /og:audio|twitter:player:stream/.test(h)));
  if (!url) return null;
  const title = meta(h, 'og:title') || decode(/<title[^>]*>([^<]*)<\/title>/i.exec(h)?.[1]) || null;
  return { url, title: title ? title.slice(0, 200) : null };
}
/**
 * Opens a link and works out what to play. { audio: true, url } when the link itself is an audio file (even without
 * .mp3 in its name); { url, title } when the page has one; null otherwise. Redirects are followed (share links),
 * but never into a private address. onlyAudioFiles skips reading pages.
 */
export async function probeLink(raw, { fetchFn = globalThis.fetch, onlyAudioFiles = false } = {}) {
  const u = cleanLink(raw); if (!u) return null;
  const r = await fetchFn(u.href, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GoodBoyBot)', Accept: 'text/html,audio/*;q=0.9,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (!r?.ok) return null;
  const final = cleanLink(r.url || u.href); if (!final) { r.body?.cancel?.().catch?.(() => {}); return null; }
  const type = String(r.headers?.get?.('content-type') ?? '').toLowerCase();
  if (/^audio\/|^application\/ogg/.test(type)) { r.body?.cancel?.().catch?.(() => {}); return { audio: true, type, url: final.href, title: decodeURIComponent(final.pathname.split('/').pop() || '').replace(AUDIO_EXT, '') || null }; }
  if (onlyAudioFiles || !/html|xml/.test(type)) { r.body?.cancel?.().catch?.(() => {}); return null; }
  const html = (await r.text().catch(() => '')).slice(0, 3e6);
  const hit = audioFromPage(html, final.href);
  return hit ? { ...hit, page: final.href } : (final.href !== u.href ? { redirect: final.href } : null);
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
  return { title: String(j.track ?? j.title ?? 'Song').slice(0, 200), artist: String(j.artist ?? j.uploader ?? j.channel ?? '').slice(0, 100), seconds, page: j.webpage_url ?? input, site: String(j.extractor_key ?? j.extractor ?? 'web').replace(/:.*/, ''), ...(safeArt(j.thumbnail ?? bestThumb(j.thumbnails)) ? { art: safeArt(j.thumbnail ?? bestThumb(j.thumbnails)) } : {}) };
}
/**
 * Cover pictures the dashboard may show (3.1.2). Only these picture servers are allowed, and the dashboard's page rules
 * list the same ones, so a song can never make the dashboard load something from anywhere else.
 */
export const ART_HOSTS = ['i.ytimg.com', 'i1.sndcdn.com', 'usercontent.jamendo.com', 'i.scdn.co'];
export function safeArt(raw) {
  try { const u = new URL(String(raw ?? '')); return u.protocol === 'https:' && ART_HOSTS.includes(u.hostname) ? u.href.slice(0, 500) : null; } catch { return null; }
}
const bestThumb = (list) => (Array.isArray(list) ? [...list].filter((t) => t?.url).sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0)).find((t) => safeArt(t.url))?.url ?? null : null);
/** Search a site for songs (3.1.2, the dashboard's search box): the first few results, quickly, without opening each one. */
export async function searchMany(bin, query, { spawnFn, limit = 8 } = {}) {
  const q = String(query ?? '').replace(/[\r\n]/g, ' ').trim().slice(0, 100);
  if (!q) return [];
  const r = await run(bin, ['-J', '--flat-playlist', '--no-warnings', `ytsearch${limit}:${q}`], { spawnFn, timeoutMs: 30000 });
  if (r.code !== 0) throw new UserError('The search did not work right now. Try again in a minute.');
  let j; try { j = JSON.parse(r.out); } catch { return []; }
  return (j.entries ?? []).filter((e) => e?.id && !e.live_status?.includes?.('live')).slice(0, limit).map((e) => ({
    title: String(e.title ?? 'Song').slice(0, 200), artist: String(e.channel ?? e.uploader ?? '').slice(0, 100), seconds: Number(e.duration) || null,
    page: /^https:\/\//.test(e.url ?? '') ? e.url : `https://www.youtube.com/watch?v=${encodeURIComponent(e.id)}`, site: 'Youtube',
    art: safeArt(bestThumb(e.thumbnails)) ?? safeArt(`https://i.ytimg.com/vi/${encodeURIComponent(e.id)}/hqdefault.jpg`),
  }));
}
/**
 * The audio's own web address for a page (asked for when the song starts, because these addresses expire), so ffmpeg can
 * play it, reconnect when the site drops the connection (long pauses do that) and start part way in. Null when the site
 * only gives something ffmpeg can't open by address; then the song is streamed through yt-dlp instead.
 */
export async function directAudio(bin, page, { spawnFn } = {}) {
  const r = await run(bin, ['-J', '--no-playlist', '--no-warnings', '-f', 'bestaudio/best', page], { spawnFn, timeoutMs: 45000 });
  if (r.code !== 0) return null;
  let j; try { j = JSON.parse(r.out); } catch { return null; }
  if (Array.isArray(j.entries)) j = j.entries.find(Boolean);
  const url = j?.url, protocol = String(j?.protocol ?? 'https');
  if (!/^https?:\/\//i.test(url ?? '') || !/^(https?|m3u8(_native)?)$/i.test(protocol)) return null;
  const headers = Object.fromEntries(Object.entries(j.http_headers ?? {}).filter(([k, v]) => /^[\w-]+$/.test(k) && typeof v === 'string' && !/[\r\n]/.test(v)));
  return { url, headers, seconds: Number(j.duration) || null };
}
/** Starts streaming the audio of a looked-up page. Returns { stream, stop }. */
export function stream(bin, page, { spawnFn = realSpawn } = {}) {
  const child = spawnFn(bin, ['-f', 'bestaudio/best', '--no-playlist', '--no-warnings', '-q', '-o', '-', page], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  return { stream: child.stdout, stop: () => { try { child.kill(); } catch { /* gone */ } } };
}

// ------------------------------------------------------------------ 3.1.2: playlists from other sites, and smooth playback
/**
 * A link to a whole playlist or album on a site Good Boy can read: { site, kind } or null.
 * Spotify and Deezer are read from their public pages; the others through yt-dlp.
 * A YouTube video link that also names a playlist (watch?v=...&list=...) counts only when `andVideos` is set (importing).
 */
export function listLink(raw, { andVideos = false } = {}) {
  const u = cleanLink(raw); if (!u) return null;
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (spotifyListId(raw)) return { site: 'Spotify', kind: spotifyListId(raw).kind };
  if (/(^|\.)deezer\.com$/.test(host) && /\/(playlist|album)\/\d+/.test(u.pathname)) return { site: 'Deezer', kind: /\/album\//.test(u.pathname) ? 'album' : 'playlist' };
  if ((host === 'youtube.com') && u.searchParams.get('list') && (u.pathname === '/playlist' || andVideos)) return { site: 'YouTube', kind: 'playlist' };
  if (host === 'soundcloud.com' && /^\/[^/]+\/sets\/[^/]+/.test(u.pathname)) return { site: 'SoundCloud', kind: 'playlist' };
  if (/\.bandcamp\.com$/.test(u.hostname) && /^\/album\//.test(u.pathname)) return { site: 'Bandcamp', kind: 'album' };
  return null;
}
export const MAX_LIST = 300;
/** Deezer's public API: { name, kind, tracks: [{ title, artist, seconds }] }. Played by finding each song on YouTube. */
export async function deezerList(raw, { fetchFn = globalThis.fetch } = {}) {
  const m = /\/(playlist|album)\/(\d+)/.exec(cleanLink(raw)?.pathname ?? '');
  if (!m) return null;
  const r = await fetchFn(`https://api.deezer.com/${m[1]}/${m[2]}`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  const j = r?.ok ? await r.json().catch(() => null) : null;
  if (!j || j.error || !Array.isArray(j.tracks?.data)) throw new UserError(`Couldn't read that Deezer ${m[1]}. Check it's public and try again.`);
  const tracks = j.tracks.data.filter((t) => t?.title).slice(0, MAX_LIST).map((t) => ({ title: String(t.title).slice(0, 200), artist: String(t.artist?.name ?? j.artist?.name ?? '').slice(0, 100), seconds: Number(t.duration) || null }));
  if (!tracks.length) throw new UserError('That Deezer list has no songs that can be played.');
  return { name: String(j.title ?? 'Deezer playlist').slice(0, 100), kind: m[1], tracks };
}
/** A YouTube, SoundCloud or Bandcamp playlist through yt-dlp, without opening every song: { name, kind, tracks: [{ title, artist, seconds, page }] }. */
export async function siteList(bin, raw, { spawnFn } = {}) {
  const l = listLink(raw, { andVideos: true });
  if (!l) return null;
  const r = await run(bin, ['-J', '--flat-playlist', '--no-warnings', '--playlist-end', String(MAX_LIST), cleanLink(raw).href], { spawnFn, timeoutMs: 90000 });
  if (r.code !== 0) throw new UserError(`Couldn't read that ${l.site} ${l.kind}. Check it's public and try again.`);
  let j; try { j = JSON.parse(r.out); } catch { throw new UserError(`Couldn't read that ${l.site} ${l.kind}.`); }
  const page = (e) => (/^https:\/\//.test(e.url ?? '') ? e.url : /^https:\/\//.test(e.webpage_url ?? '') ? e.webpage_url : l.site === 'YouTube' && e.id ? `https://www.youtube.com/watch?v=${encodeURIComponent(e.id)}` : null);
  const tracks = (j.entries ?? []).filter((e) => e && page(e) && !/\[(private|deleted) video\]/i.test(e.title ?? '')).slice(0, MAX_LIST)
    .map((e) => ({ title: String(e.title ?? 'Song').slice(0, 200), artist: String(e.channel ?? e.uploader ?? e.artist ?? '').slice(0, 100), seconds: Number(e.duration) || null, page: page(e), site: l.site === 'YouTube' ? 'Youtube' : l.site,
      art: safeArt(bestThumb(e.thumbnails)) ?? (l.site === 'YouTube' && e.id ? safeArt(`https://i.ytimg.com/vi/${encodeURIComponent(e.id)}/hqdefault.jpg`) : null) }));
  if (!tracks.length) throw new UserError(`That ${l.site} ${l.kind} has no songs that can be played.`);
  return { name: String(j.title ?? `${l.site} ${l.kind}`).slice(0, 100), kind: l.kind, tracks };
}
/**
 * Downloads a song's audio to a file before it plays (3.1.2), so a slow or dropped connection can't make it skip.
 * Returns the file's path. The caller deletes it once the song is done.
 */
export async function downloadAudio(bin, page, dir, { spawnFn, maxMB = 150, timeoutMs = 4 * 60000 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const r = await run(bin, ['-f', 'bestaudio/best', '--no-playlist', '--no-warnings', '--no-progress', '--no-part', '--max-filesize', `${maxMB}M`, '-o', `${base}.%(ext)s`, '--no-simulate', '--print', 'after_move:filepath', page], { spawnFn, timeoutMs });
  const file = r.out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).at(-1);
  if (r.code !== 0 || !file || !path.resolve(file).startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file)) {
    for (const f of fs.readdirSync(dir)) if (f.startsWith(path.basename(base))) fs.rm(path.join(dir, f), { force: true }, () => {});
    throw new Error(/File is larger|max-filesize/i.test(r.err + r.out) ? `the song is over ${maxMB} MB` : 'the download did not work');
  }
  return file;
}
/** Removes downloaded songs left behind (the bot was closed mid-song). */
export function sweepDownloads(dir, { olderThanMs = 6 * 3600000 } = {}) {
  try { for (const f of fs.readdirSync(dir)) { if (!/^(dl|play)-\d+/.test(f)) continue; const p = path.join(dir, f); if (Date.now() - fs.statSync(p).mtimeMs > olderThanMs) fs.rmSync(p, { force: true }); } } catch { /* no folder yet */ }
}
