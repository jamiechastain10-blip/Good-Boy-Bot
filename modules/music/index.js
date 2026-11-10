/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Music in voice channels, from sources that are allowed to be played:
 *   uploads   members upload a song in the form (MP3, OGG, WAV, FLAC, M4A). Good Boy keeps it until it has played.
 *   radio     stations an admin adds (Name | stream link). Only add stations that allow being relayed.
 *   Jamendo   free, Creative Commons music, if the bot owner sets JAMENDO_CLIENT_ID (free key from developer.jamendo.com).
 *             Each song shows its artist and licence, as Jamendo asks.
 *   links     direct links to audio files always work. Links from YouTube, Spotify, SoundCloud, BandLab and other sites only work
 *             if the bot owner turns on "media links" (3.0.6, off by default): those sites' terms forbid playing their
 *             audio in a bot, so the owner sees a warning and decides. See src/medialinks.js.
 *
 * One command, /music, posts the player in the channel. Everything else is buttons and one form, so nothing is typed
 * into a command box. Voice libraries load lazily; the queue rules below are plain functions so they are tested alone.
 */
import { Readable, Transform, pipeline } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits as P, StringSelectMenuBuilder } from 'discord.js';
import { UserError, truncate } from '../../src/util.js';
import { formModal, readForm } from '../../src/modalkit.js';
import * as ML from '../../src/medialinks.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
export const AUDIO_TYPES = ['mp3', 'ogg', 'oga', 'opus', 'wav', 'flac', 'm4a', 'aac', 'webm'];
const MAX_UPLOAD = 25 * 1024 * 1024;

// ------------------------------------------------------------------ pure rules (tested)
/** Admin station list lines, "Name | https://stream". Bad lines are skipped. */
export function parseStations(lines) {
  return (lines ?? []).map((l) => String(l).split('|').map((x) => x.trim())).filter(([n, u]) => n && /^https?:\/\/[^\s]+$/i.test(u ?? ''))
    .slice(0, 25).map(([name, url], k) => ({ id: `s${k}`, name: name.slice(0, 80), url }));
}
/** Adds a track to the queue, keeping the limits: queue size and songs per member. Returns the position (1 = next). */
export function enqueue(queue, track, { max = 50, perUser = 10 } = {}) {
  if (queue.length >= max) throw new UserError(`The queue is full (${max} songs). Wait for some to play.`);
  if (queue.filter((t) => t.by === track.by).length >= perUser) throw new UserError(`You already have ${perUser} songs waiting. Let others have a turn.`);
  track.uid ??= Math.random().toString(36).slice(2, 10);
  queue.push(track);
  return queue.length;
}
/** 3.1 queue tools, kept pure for tests. Each returns the queue (changed in place). */
export function moveToFront(queue, uid) { const k = queue.findIndex((t) => t.uid === uid); if (k < 0) throw new UserError('That song already played or was removed.'); queue.unshift(...queue.splice(k, 1)); return queue; }
export function removeTrack(queue, uid) { const k = queue.findIndex((t) => t.uid === uid); if (k < 0) throw new UserError('That song already played or was removed.'); return queue.splice(k, 1)[0]; }
export function shuffle(queue, rand = Math.random) { for (let k = queue.length - 1; k > 0; k--) { const j = Math.floor(rand() * (k + 1)); [queue[k], queue[j]] = [queue[j], queue[k]]; } return queue; }
export const REPEAT_NEXT = { off: 'one', one: 'all', all: 'off' };
/** What happens to the song that just finished: repeat one = play it again, repeat all = back of the queue. */
export function afterSong(queue, finished, repeat) {
  if (!finished) return queue;
  if (repeat === 'one') queue.unshift(finished); else if (repeat === 'all') queue.push(finished);
  return queue;
}
/** Who may skip or stop: the person who added the song, the DJ role, or someone with Manage Channels. Anyone if they're alone with the bot. */
export function canControl({ member, track, djRole, listeners = 2 }) {
  if (listeners <= 1) return true;
  if (track?.by && member.id === track.by) return true;
  if (djRole && member.roles?.cache?.has?.(djRole)) return true;
  return !!member.permissions?.has?.(P.ManageChannels);
}
/** "3:07" */
export const clock = (sec) => (Number.isFinite(sec) && sec > 0 ? `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}` : 'live');

// ------------------------------------------------------------------ 3.1.2: volume, reordering, playlists (pure, tested)
/** 0 to 100, in whole numbers. */
export const clampVolume = (v) => { const n = Math.round(Number(v)); if (!Number.isFinite(n)) throw new UserError('The volume must be a number from 0 to 100.'); return Math.max(0, Math.min(100, n)); };
export const VOLUME_STEP = 10;
/** Moves a queued song to another place (0 = next). */
export function moveTrack(queue, uid, to) {
  const k = queue.findIndex((t) => t.uid === uid); if (k < 0) throw new UserError('That song already played or was removed.');
  const [t] = queue.splice(k, 1); queue.splice(Math.max(0, Math.min(queue.length, Math.floor(Number(to) || 0))), 0, t); return queue;
}
export const MAX_PLAYLISTS = 50, MAX_PLAYLIST_SONGS = 300;
/**
 * What a playlist keeps of a song: enough to find it again, nothing about who added it or where it was in a queue.
 * Uploaded songs can't be kept (their file is deleted once played), so they give null.
 */
export function savable(t) {
  if (!t || t.file || t.source === 'upload') return null;
  const https = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u.slice(0, 1000) : null);
  const out = { title: String(t.title ?? 'Song').slice(0, 200), artist: t.artist ? String(t.artist).slice(0, 100) : null, seconds: Number(t.seconds) || null, source: t.source,
    url: https(t.url) ?? (t.source === 'radio' && /^http:\/\//i.test(t.url ?? '') ? String(t.url).slice(0, 1000) : null), page: https(t.page), search: t.search ? String(t.search).slice(0, 300) : null,
    site: t.site ? String(t.site).slice(0, 40) : null, credit: t.credit ? String(t.credit).slice(0, 300) : null, art: ML.safeArt(t.art), whole: t.whole ? true : undefined };
  if (out.site === 'BandLab' && out.page) out.relink = 'bandlab'; // BandLab's audio addresses expire: look it up again when it plays
  if (!out.url && !out.page && !out.search) return null;
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}
/** Total length of a list of songs, in seconds (radio and unknown lengths count as 0). */
export const totalSeconds = (tracks) => tracks.reduce((n, t) => n + (Number(t.seconds) || 0), 0);
export function cleanPlaylistName(raw) {
  const n = String(raw ?? '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!n) throw new UserError('Give the playlist a name.');
  return n;
}

/** Jamendo search (free CC music). Returns tracks with their attribution. fetchFn is for tests. */
export async function jamendoSearch(query, { clientId = process.env.JAMENDO_CLIENT_ID, fetchFn = globalThis.fetch, limit = 5 } = {}) {
  if (!clientId) throw new UserError('Jamendo search is not set up on this bot. The bot owner adds a free JAMENDO_CLIENT_ID (developer.jamendo.com).');
  const u = `https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(clientId)}&format=json&limit=${limit}&audioformat=mp32&include=licenses&search=${encodeURIComponent(String(query).slice(0, 100))}`;
  const r = await fetchFn(u, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (!r?.ok) throw new UserError('Jamendo did not answer. Try again in a minute.');
  const d = await r.json();
  return (d.results ?? []).filter((t) => t.audio).map((t) => ({ source: 'jamendo', title: String(t.name ?? 'Song'), artist: String(t.artist_name ?? ''), url: t.audio, seconds: Number(t.duration) || null, credit: `“${t.name}” by ${t.artist_name} (Jamendo${t.license_ccurl ? `, ${t.license_ccurl}` : ''})`, link: t.shareurl ?? null, art: ML.safeArt(t.image ?? t.album_image) }));
}

// ------------------------------------------------------------------ media links (opt-in, bot owner only)
// 3.0.6: switched on per server, once, by the bot owner. It stays on in that server until they turn it off.
const MEDIA_OFF = 'Links from YouTube, Spotify, BandLab and similar sites are turned off in this server (their terms forbid it). The bot owner turns them on once with `/music` → 🔗 Media links. Links straight to an audio file always work.';
const mediaOn = (ctx) => ctx.data.get('mediaLinks')?.on === true;
const ytdlp = (ctx) => ML.findYtDlp(ctx.botDir ? ctx.botDir('tools') : null, { spawnFn: globalThis[Symbol.for('goodboy.music.spawn')] });
const spawnSeam = () => globalThis[Symbol.for('goodboy.music.spawn')];
const MEDIA_WARNING = [
  '**Turn on media links?**',
  'Members will be able to paste links from **YouTube, Spotify, SoundCloud, BandLab** and most other sites, and Good Boy plays them in voice.',
  '',
  '⚠️ **This breaks those sites\' terms of service.** Big music bots that did this were shut down. The risk is yours as the person who runs this bot.',
  '• It\'s turned on for **this server** only, once. It stays on here; other servers stay off until you turn them on.',
  '• Good Boy downloads a free program called **yt-dlp** to do it.',
  '• Spotify songs are played from YouTube (Spotify\'s own audio can\'t be played by any bot).',
  '• Sites change often, so links can stop working for a while.',
  '• You can turn it off again any time with `/music` in this server.',
].join('\n');

// ------------------------------------------------------------------ voice
let lib = null;
async function load() {
  lib ??= globalThis[Symbol.for('goodboy.music.lib')] ?? null; // test seam
  if (lib) return lib;
  try {
    const voice = await import('@discordjs/voice');
    await import('@snazzah/davey').catch(() => {});
    const ff = await import('ffmpeg-static').then((m) => m.default ?? m).catch(() => null);
    if (ff && !process.env.FFMPEG_PATH) process.env.FFMPEG_PATH = ff;
    const prism = await import('prism-media').then((m) => m.default ?? m).catch(() => null);
    lib = { voice, prism };
    return lib;
  } catch (e) {
    throw new UserError(`Music needs the voice packages. On the PC running the bot: \`npm install\`, then restart. (${truncate(e.message, 100)})`);
  }
}
const states = (globalThis[Symbol.for('goodboy.music.states')] ??= new Map());
const ttsBusy = (guildId) => globalThis[Symbol.for('goodboy.voice.states')]?.has?.(guildId);

function cleanup(guildId) {
  const st = states.get(guildId);
  if (!st) return;
  clearTimeout(st.idleTimer);
  try { st.player.stop(true); } catch { /* ignore */ }
  try { if (st.connection.state.status !== 'destroyed') st.connection.destroy(); } catch { /* ignore */ }
  for (const t of [st.current, ...st.queue]) { if (t?.file) fs.rm(t.file, { force: true }, () => {}); forget(t); }
  st.stopStream?.(); dropTemp(st);
  clearTimeout(st.volTimer); clearInterval(st.tick);
  for (const v of st.queueViews?.values() ?? []) v.i.editReply?.({ content: '⏹️ The music stopped.', embeds: [], components: [] }).catch(() => {});
  states.delete(guildId);
}
function armIdle(ctx, st) {
  clearTimeout(st.idleTimer);
  st.idleTimer = setTimeout(() => { cleanup(ctx.guildId); refreshPlayer(ctx).catch(() => {}); }, ctx.config.get('idleMinutes') * 60000);
  st.idleTimer.unref?.();
}
async function connect(ctx, member, { channelId = null } = {}) {
  const { voice } = await load();
  // 3.1.2: the dashboard has no member in voice, so it names the voice channel instead.
  const vc = channelId ? ctx.guild?.channels.cache.get(channelId) : member.voice?.channel;
  let st = states.get(ctx.guildId);
  if (st) {
    if (vc?.id !== st.channelId) throw new UserError(channelId ? `Good Boy is already playing in <#${st.channelId}>. Stop the music first to move it.` : `Join <#${st.channelId}> to control the music.`);
    return st;
  }
  if (!vc) throw new UserError(channelId ? 'That voice channel is gone. Pick another one.' : 'Join a voice channel first.');
  if (![2, 13].includes(vc.type)) throw new UserError('Pick a voice channel.');
  const guild = ctx.guild ?? member.guild;
  if (ttsBusy(ctx.guildId)) throw new UserError('Good Boy is reading text aloud in voice right now. Use `/tts leave` first; music and speech share one voice connection.');
  const perms = vc.permissionsFor(guild.members.me);
  if (!perms?.has(P.Connect) || !perms.has(P.Speak)) throw new UserError("I can't join or speak in that channel (I need Connect and Speak).");
  const connection = voice.joinVoiceChannel({ channelId: vc.id, guildId: ctx.guildId, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true });
  try { await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, 15000); } catch { connection.destroy(); throw new UserError("I couldn't connect to voice in time. Try again, or check the bot's voice packages are up to date."); }
  const player = voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause } });
  connection.subscribe(player);
  st = { connection, player, channelId: vc.id, queue: [], current: null, paused: false, textChannelId: null, messageId: null, history: [], queueViews: new Map() };
  states.set(ctx.guildId, st);
  // 3.1.2: every 5 seconds, everything showing the music catches up (dashboards, the player's progress bar, open queues).
  st.tick = setInterval(() => liveTick(ctx, st).catch(() => {}), globalThis[Symbol.for('goodboy.music.tickMs')] ?? 5000);
  st.tick.unref?.();
  player.on(voice.AudioPlayerStatus.Idle, () => {
    st.stopStream?.(); st.stopStream = null; dropTemp(st);
    const done = st.current; st.current = null;
    // 3.1.2: jumping (seek, back): whoever stopped it already put the song where it plays next.
    if (st.requeue) { st.requeue = false; st.resource = null; st.skipping = false; next(ctx, st).catch(() => {}); return; }
    // Stopped well before its end (the site dropped the connection, a network blip): carry on from there.
    const at = resumePoint(done, st.resource?.playbackDuration ?? 0, { skipping: st.skipping });
    st.resource = null;
    if (at != null) {
      done.startAt = at; done.resumes = (done.resumes ?? 0) + 1;
      ctx.log.info(`${done.title} stopped at ${clock(Math.round(at))} of ${clock(done.seconds)}; carrying on from there.`);
      st.queue.unshift(done);
      next(ctx, st).catch(() => {});
      return;
    }
    const keep = st.repeat && st.repeat !== 'off' && !st.skipping;
    if (done) { done.startAt = 0; done.resumes = 0; } // a repeat starts from the top
    if (done && !done.file) { st.history.push({ ...done, local: null, fetching: null, gone: false }); if (st.history.length > 20) st.history.shift(); } // for ⏮ Back
    if (!(keep && st.repeat === 'one')) forget(done); // repeat one plays the same file again
    if (keep) afterSong(st.queue, done, st.repeat); else if (done?.file) fs.rm(done.file, { force: true }, () => {});
    st.skipping = false;
    next(ctx, st).catch(() => {});
  });
  player.on('error', (e) => { ctx.log.warn(`Music player error: ${e.message}`); });
  connection.on(voice.VoiceConnectionStatus.Disconnected, async () => {
    try { await Promise.race([voice.entersState(connection, voice.VoiceConnectionStatus.Signalling, 5000), voice.entersState(connection, voice.VoiceConnectionStatus.Connecting, 5000)]); }
    catch { cleanup(ctx.guildId); refreshPlayer(ctx).catch(() => {}); }
  });
  return st;
}
/** .m4a/.mp4 songs (BandLab's are) can't be played while they stream in; they are downloaded first, then deleted. */
const WHOLE_EXT = /\.(m4a|m4b|mp4|3gp)(\?.*)?$/i;
const MAX_WHOLE = 80 * 1024 * 1024;
export const needsWhole = (t) => !!t.whole || (() => { try { return WHOLE_EXT.test(new URL(t.url).pathname); } catch { return false; } })();
/**
 * Opens a song or station. The time limit only covers the site answering: a timer on the whole request would cut the
 * song off mid-play once it ran out (radio after a few seconds, long songs part way through). While the song plays,
 * a download that stops sending for stallMs ends instead.
 */
export async function openStream(url, { answerMs = 15000, stallMs = 0, fetchFn = fetch } = {}) {
  const ac = new AbortController();
  let timer = setTimeout(() => ac.abort(new Error('the source took too long to answer')), answerMs);
  let r;
  try { r = await fetchFn(url, { signal: ac.signal }); } finally { clearTimeout(timer); }
  if (!r.ok || !r.body) throw new Error(`the source answered ${r.status}`);
  const src = Readable.fromWeb(r.body);
  // Downloads watch for a stall. Playing streams don't: a paused player stops reading, which isn't a stall.
  if (stallMs) {
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(new Error('the source stopped sending')), stallMs); timer.unref?.(); };
    arm(); const pass = new Transform({ transform(chunk, enc, cb) { arm(); cb(null, chunk); } });
    pipeline(src, pass, () => clearTimeout(timer));
    return { stream: pass, headers: r.headers, stop: () => { clearTimeout(timer); ac.abort(); } };
  }
  return { stream: src, headers: r.headers, stop: () => { clearTimeout(timer); ac.abort(); } };
}
async function downloadWhole(ctx, url, { needSize = false } = {}) {
  const o = await openStream(url, { stallMs: 60000 });
  const r = { headers: o.headers };
  if (needSize && !(Number(r.headers.get('content-length')) > 0)) { o.stop(); return null; } // no size: a live stream, so it plays as it comes
  if (Number(r.headers.get('content-length')) > MAX_WHOLE) { o.stop(); throw new Error('the song is over 80 MB'); }
  const file = path.join(ctx.fileDir('uploads'), `play-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.m4a`);
  const out = fs.createWriteStream(file);
  let size = 0;
  try {
    for await (const chunk of o.stream) { size += chunk.length; if (size > MAX_WHOLE) throw new Error('the song is over 80 MB'); if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok)); }
    await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())));
  } catch (e) { o.stop(); out.destroy(); fs.rm(file, { force: true }, () => {}); throw e; }
  return file;
}
function dropTemp(st) { if (st.tempFile) fs.rm(st.tempFile, { force: true }, () => {}); st.tempFile = null; }

// ------------------------------------------------------------------ 3.1.2: download first, then play (smooth playback)
// Each song is saved to a file before it plays (and the next one while this one plays), then played from the file and
// deleted when it's done. A slow or dropped connection can't make it skip, jumping around is instant, and the next song
// is usually ready before this one ends. Radio is live, so it still plays as it comes.
const smoothOn = (ctx) => ctx.config.get('smooth') !== false;
/** Deletes a song's downloaded file (not an upload: that's deleted by the code that owns it). */
function forget(t) {
  if (!t) return;
  t.gone = true;
  if (t.local) fs.rm(t.local, { force: true }, () => {});
  t.local = null;
}
/** The song as a file on this computer, downloading it if needed. Null when it should stream instead (radio, live). */
function fetchLocal(ctx, t) {
  if (!t) return Promise.resolve(null);
  if (t.file) return Promise.resolve(t.file);
  if (t.local && fs.existsSync(t.local)) return Promise.resolve(t.local);
  if (t.fetching) return t.fetching;
  const whole = !!t.url && needsWhole(t);
  if (t.source === 'radio' || (!smoothOn(ctx) && !whole)) return Promise.resolve(null);
  t.gone = false;
  const dir = ctx.fileDir('uploads');
  t.fetching = (async () => {
    if (t.relink === 'bandlab' && t.page) { const b = await ML.bandlabTrack(t.page); t.url = b.url; t.whole = true; }
    if (t.source === 'media') {
      if (!mediaOn(ctx)) throw new Error('media links were turned off');
      const y = await ytdlp(ctx);
      if (!y) throw new Error('yt-dlp is missing');
      if (!t.page && t.search) { const info = await ML.lookup(y.bin, t.search, { spawnFn: spawnSeam() }); t.page = info.page; t.seconds ??= info.seconds; t.site = info.site; if (info.art) t.art ??= info.art; }
      ML.sweepDownloads(dir);
      return ML.downloadAudio(y.bin, t.page, dir, { spawnFn: spawnSeam() });
    }
    if (t.url) return downloadWhole(ctx, t.url, { needSize: !(t.url && needsWhole(t)) });
    return null;
  })().then((f) => { if (t.gone && f) { fs.rm(f, { force: true }, () => {}); return null; } t.local = f ?? null; return t.local; })
    .finally(() => { t.fetching = null; });
  return t.fetching;
}
/** Gets the next song or two ready while this one plays. */
function prefetch(ctx, st) {
  if (!st || !smoothOn(ctx)) return;
  for (const t of st.queue.slice(0, 2)) fetchLocal(ctx, t).catch((e) => { ctx.log.info(`Couldn't get ${t.title} ready early (${e.message}); it will stream instead.`); });
}
/**
 * ffmpeg reading a song by address or file, so it can start part way in (start, seconds) and, for web addresses,
 * reconnect when the site drops the connection: long pauses and long songs do that.
 */
export function ffmpegArgs(src, { start = 0, headers = null, opus = false, volume = 100 } = {}) {
  const web = /^https?:\/\//i.test(src);
  const h = headers && Object.keys(headers).length ? Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n' : null;
  return [
    ...(web ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5', '-rw_timeout', '15000000'] : []),
    ...(h ? ['-headers', h] : []),
    ...(start > 0 ? ['-ss', String(Math.floor(start))] : []),
    '-i', src, '-analyzeduration', '0', '-loglevel', '0',
    // 3.1.2: ffmpeg makes Discord's audio (Opus) itself, with the volume, so the bot does no sound work of its own
    // while it plays. That work, done in JavaScript, is what made songs skip for a moment when the bot was busy.
    ...(opus ? ['-vn', '-af', `volume=${(clampVolume(volume) / 100).toFixed(2)}`, '-ar', '48000', '-ac', '2', '-c:a', 'libopus', '-b:a', '128k', '-frame_duration', '20', '-application', 'audio', '-f', 'ogg']
      : ['-f', 's16le', '-ar', '48000', '-ac', '2']),
  ];
}
/** A song that stops this far (or more) before its end is picked up again from where it stopped, up to 5 times. */
const RESUME_GAP = 15, MAX_RESUMES = 5;
export function resumePoint(track, playedMs, { skipping = false } = {}) {
  if (!track || skipping || !track.resumable || track.source === 'radio' || !track.seconds) return null;
  if ((track.resumes ?? 0) >= MAX_RESUMES) return null;
  const at = (track.startAt ?? 0) + playedMs / 1000;
  return at > 5 && at < track.seconds - RESUME_GAP ? Math.max(0, at - 2) : null;
}

async function next(ctx, st) {
  const { voice, prism } = await load();
  const track = st.queue.shift();
  if (!track) { st.current = null; armIdle(ctx, st); return refreshPlayer(ctx); }
  clearTimeout(st.idleTimer);
  st.current = track;
  try {
    let input, kind = 'arbitrary';
    const start = track.startAt ?? 0;
    track.resumable = false;
    // Our own ffmpeg: it can start part way in and reconnect, and makes Opus itself with the volume (3.1.2).
    // Without prism (tests), the voice library's ffmpeg is used.
    const ff = (src, opts) => { const f = new prism.FFmpeg({ args: ffmpegArgs(src, { start, opus: true, volume: volumeOf(ctx), ...opts }) }); st.stopStream = () => f.destroy(); kind = 'opus'; track.resumable = true; return f; };
    // 3.1.2: download first (unless it was got ready while the last song played).
    let local = null;
    if (!track.file) {
      st.preparing = !(track.local && fs.existsSync(track.local)); if (st.preparing) announce(ctx);
      local = await fetchLocal(ctx, track).catch((e) => { if (needsWhole(track)) throw e; ctx.log.info(`Couldn't download ${track.title} first (${e.message}); streaming it instead.`); return null; });
      st.preparing = false;
      if (states.get(ctx.guildId) !== st) { forget(track); return; } // stopped while it was getting ready
      if (st.current !== track) return; // skipped or jumped while it was getting ready
    }
    // A path, not a stream: .m4a songs keep their index at the end, which ffmpeg can only reach in a file.
    if (track.file || local) input = prism ? ff(track.file ?? local) : (track.file ?? local);
    else if (track.relink === 'bandlab' && track.page) { const b = await ML.bandlabTrack(track.page); track.url = b.url; input = prism ? ff(track.url) : track.url; }
    else if (track.source === 'media') {
      if (!mediaOn(ctx)) throw new Error('media links were turned off');
      const y = await ytdlp(ctx);
      if (!y) throw new Error('yt-dlp is missing');
      if (!track.page && track.search) { const info = await ML.lookup(y.bin, track.search, { spawnFn: spawnSeam() }); track.page = info.page; track.seconds ??= info.seconds; track.site = info.site; }
      const d = prism ? await ML.directAudio(y.bin, track.page, { spawnFn: spawnSeam() }).catch(() => null) : null;
      if (d) { track.seconds ??= d.seconds; input = ff(d.url, { headers: d.headers }); }
      else { const s2 = ML.stream(y.bin, track.page, { spawnFn: spawnSeam() }); st.stopStream = s2.stop; input = s2.stream; }
    } else if (prism) input = ff(track.url);
    else {
      const o = await openStream(track.url);
      st.stopStream = o.stop; input = o.stream;
    }
    // Opus from our ffmpeg goes straight to Discord; anything else is turned into Opus by the voice library, with the volume.
    const resource = kind === 'opus' ? voice.createAudioResource(input, { inputType: voice.StreamType.OggOpus ?? 'ogg/opus' })
      : voice.createAudioResource(input, { inputType: voice.StreamType.Arbitrary, inlineVolume: true });
    st.resource = resource; st.kind = kind; st.playingVolume = volumeOf(ctx);
    resource.volume?.setVolume(volumeOf(ctx) / 100);
    st.player.play(resource);
  } catch (e) {
    st.preparing = false;
    ctx.log.warn(`Could not play ${track.title}: ${e.message}`);
    forget(track);
    if (st.current !== track) return;
    st.current = null;
    return next(ctx, st);
  }
  return refreshPlayer(ctx);
}

// ------------------------------------------------------------------ the player message
const listenersOf = (ctx, st) => ctx.guild?.channels.cache.get(st?.channelId)?.members?.filter?.((m) => !m.user.bot).size ?? 2;
function playerPayload(ctx) {
  const st = states.get(ctx.guildId);
  const e = new EmbedBuilder().setColor(0x6b93ff).setTitle('🎵 Music');
  if (!st) e.setDescription('Not playing. Join a voice channel and press **Add music**.');
  else {
    const t = st.current;
    e.setDescription([t ? `${st.preparing ? '⏳' : st.paused ? '⏸️' : '▶️'} **${truncate(t.title, 120)}**${t.artist ? ` · ${truncate(t.artist, 60)}` : ''} · ${clock(t.seconds)}\nAdded by <@${t.by}>` : '*Nothing playing right now.*',
      t && t.seconds && !st.preparing ? progressBar(elapsedOf(st), t.seconds) : null,
      t?.credit ? `-# ${truncate(t.credit, 300)}` : null, t?.page ? `-# [Open on ${truncate(t.site ?? 'the site', 30)}](${t.page})` : null, `In <#${st.channelId}> · ${volumeIcon(volumeOf(ctx))} ${volumeOf(ctx)}%`].filter(Boolean).join('\n'));
    if (st.queue.length) e.addFields({ name: `Up next (${st.queue.length})`, value: st.queue.slice(0, 8).map((x, k) => `${k + 1}. ${truncate(x.title, 70)} · <@${x.by}>`).join('\n') + (st.queue.length > 8 ? `\n…and ${st.queue.length - 8} more` : '') });
  }
  e.setFooter({ text: mediaOn(ctx) ? 'Paste a link (YouTube, Spotify, SoundCloud, BandLab and more), upload a song, or pick a station.' : 'Uploads, audio links, radio stations and Creative Commons music from Jamendo.' });
  const on = !!st;
  return { embeds: [e], allowedMentions: NOPING, components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music:add').setLabel('Add music').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('music:pause').setLabel(st?.paused ? 'Resume' : 'Pause').setEmoji(st?.paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Secondary).setDisabled(!st?.current),
    new ButtonBuilder().setCustomId('music:skip').setLabel('Skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(!st?.current),
    new ButtonBuilder().setCustomId('music:stop').setLabel('Stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger).setDisabled(!on),
    new ButtonBuilder().setCustomId('music:queue').setLabel(st?.repeat && st.repeat !== 'off' ? `Queue · ${st.repeat === 'one' ? '🔂' : '🔁'}` : 'Queue').setEmoji('📜').setStyle(ButtonStyle.Secondary).setDisabled(!on)),
  // 3.1.2: back, and the volume (DJs and staff, or anyone alone with the bot).
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music:prev').setLabel('Back').setEmoji('⏮️').setStyle(ButtonStyle.Secondary).setDisabled(!st?.current),
    new ButtonBuilder().setCustomId('music:voldown').setLabel('Quieter').setEmoji('🔉').setStyle(ButtonStyle.Secondary).setDisabled(!on || volumeOf(ctx) <= 0),
    new ButtonBuilder().setCustomId('music:volup').setLabel('Louder').setEmoji('🔊').setStyle(ButtonStyle.Secondary).setDisabled(!on || volumeOf(ctx) >= 100))] };
}
const volumeIcon = (v) => (v <= 0 ? '🔇' : v < 40 ? '🔈' : v < 75 ? '🔉' : '🔊');
/** The volume for this server (0-100). It is remembered, so the next song and the next session start at it too. */
const volumeOf = (ctx) => { try { return clampVolume(ctx.config.get('volume') ?? 70); } catch { return 70; } };
/** Changes the volume of the song playing now, and remembers it. Saved quietly: dashboards hear about it through the player state. */
function setVolume(ctx, value) {
  const v = clampVolume(value);
  ctx.config.set('volume', v);
  applyVolume(ctx);
  return v;
}
/**
 * Puts the saved volume on the song playing. Songs Good Boy encodes itself (most) carry the volume inside the sound,
 * so the song picks up again at the same spot with the new volume, a moment after the last click.
 */
function applyVolume(ctx) {
  const st = states.get(ctx.guildId);
  if (!st) return;
  const v = volumeOf(ctx);
  st.resource?.volume?.setVolume(v / 100);
  if (st.kind !== 'opus') return;
  clearTimeout(st.volTimer);
  st.volTimer = setTimeout(() => {
    const cur = st.current;
    if (!cur || st.preparing || st.playingVolume === volumeOf(ctx) || states.get(ctx.guildId) !== st) return;
    if (cur.source !== 'radio' && !canSeek(cur)) return; // can't pick up at the same spot: the next song gets it
    if (st.paused) return; // paused: it gets the new volume when it plays again (see resume())
    jumpTo(ctx, st, cur, cur.source === 'radio' ? 0 : elapsedOf(st));
  }, globalThis[Symbol.for('goodboy.music.settleMs')] ?? 350);
  st.volTimer.unref?.();
}
/** Pause or play. A volume changed while paused is put on the song as it plays again. */
function setPaused(ctx, st, pause) {
  if (pause === st.paused) return;
  if (pause) st.player.pause(); else st.player.unpause();
  st.paused = pause;
  if (!pause && st.kind === 'opus' && st.playingVolume !== volumeOf(ctx)) applyVolume(ctx);
}
/**
 * Ends the song playing now: skipped (it goes to history), or put back to play again (requeue: seek, back, volume).
 * A song still downloading has nothing playing yet, so the next one is started straight away.
 */
function stopCurrent(ctx, st, { requeue = false } = {}) {
  st.paused = false; try { st.player.unpause?.(); } catch { /* not paused */ }
  if (st.preparing || !st.resource) {
    const t = st.current; st.current = null; st.preparing = false;
    if (t && !requeue) forget(t);
    next(ctx, st).catch(() => {});
    return;
  }
  if (requeue) st.requeue = true; else st.skipping = true;
  st.player.stop(true);
}
/** Puts a song back where it plays next and stops the one playing, so it starts again (from `at` seconds). */
function jumpTo(ctx, st, track, at = 0) {
  track.startAt = at; track.resumes = 0;
  st.queue.unshift(track);
  stopCurrent(ctx, st, { requeue: true });
}
/** ⏮: back to the start of this song, or (in the first few seconds) the song before it. */
function goBack(ctx, st) {
  const cur = st.current;
  if (!cur) throw new UserError('Nothing is playing.');
  const prev = st.history.at(-1);
  if (elapsedOf(st) > 5 || !prev) {
    if (!canSeek(cur)) throw new UserError(prev ? "This song can't be started again part way, so Back only works in its first 5 seconds." : "There's no song before this one.");
    return jumpTo(ctx, st, cur, 0);
  }
  st.history.pop();
  cur.startAt = 0; cur.resumes = 0;
  st.queue.unshift(cur);
  return jumpTo(ctx, st, { ...prev, uid: Math.random().toString(36).slice(2, 10) }, 0);
}
const canSeek = (t) => !!t && t.source !== 'radio' && !!t.seconds && !!t.resumable;
const elapsedOf = (st) => (st?.current ? (st.current.startAt ?? 0) + (st.resource?.playbackDuration ?? 0) / 1000 : 0);
/** `1:23 ▬▬▬▬🔘▬▬▬▬▬ 3:34` for the Discord player (moved on every 5 seconds). */
export function progressBar(at, total, width = 14) {
  const p = Math.max(0, Math.min(1, total ? at / total : 0)), k = Math.min(width - 1, Math.floor(p * width));
  return `\`${clock(at) === 'live' ? '0:00' : clock(at)}\` ${'▬'.repeat(k)}🔘${'▬'.repeat(width - 1 - k)} \`${clock(total)}\``;
}
/** What an open view shows, so it's only edited when that changes. */
const queueSig = (st, page) => JSON.stringify([st.current?.uid, st.paused, st.repeat, page, st.queue.map((t) => t.uid)]);
async function liveTick(ctx, st) {
  if (states.get(ctx.guildId) !== st) return clearInterval(st.tick);
  announce(ctx);
  // the player message: its progress bar moves while a song plays
  if (st.current?.seconds && !st.paused && !st.preparing) await refreshPlayer(ctx, { quiet: true });
  // open queue lists (each person's own, for 10 minutes)
  for (const [who, v] of st.queueViews) {
    if (Date.now() > v.until) { st.queueViews.delete(who); continue; }
    const sig = queueSig(st, v.page);
    if (sig === v.sig) continue;
    v.sig = sig;
    await v.i.editReply(queuePayload(ctx, st, v.page)).catch(() => st.queueViews.delete(who));
  }
}
/** Keeps someone's open queue list up to date (it was opened or moved to another page). */
function watchQueue(st, i, page) {
  st.queueViews.set(i.user.id, { i, page, until: Date.now() + 10 * 60000, sig: queueSig(st, page) });
  if (st.queueViews.size > 25) st.queueViews.delete(st.queueViews.keys().next().value);
}
async function refreshPlayer(ctx, { quiet = false } = {}) {
  const st = states.get(ctx.guildId);
  if (!quiet) { prefetch(ctx, st); announce(ctx); }
  const saved = ctx.data.get('player');
  if (!saved) return;
  const ch = ctx.guild?.channels.cache.get(saved.channelId);
  const msg = await ch?.messages?.fetch?.(saved.messageId).catch(() => null);
  await msg?.edit?.(playerPayload(ctx)).catch(() => {});
  void st;
}
/** Every open dashboard gets the new player state (3.1.2). */
function announce(ctx) { try { ctx.live('music', { state: snapshot(ctx) }); } catch { /* no dashboards */ } }

// ------------------------------------------------------------------ the form
function addFields(ctx) {
  const stations = parseStations(ctx.config.get('stations'));
  const fields = [];
  // 3.1.2: one box for a song name (searched) or a link
  const canSearch = mediaOn(ctx) || !!process.env.JAMENDO_CLIENT_ID;
  fields.push(mediaOn(ctx)
    ? { id: 'link', kind: 'text', label: 'Song name or link', required: false, max: 300, placeholder: 'e.g. Blinding Lights, or a YouTube, Spotify or SoundCloud link' }
    : canSearch ? { id: 'link', kind: 'text', label: 'Song name or link', required: false, max: 300, placeholder: 'Search free music (e.g. lofi), or a link to an audio file' }
      : { id: 'link', kind: 'text', label: 'Paste a link to an audio file', required: false, max: 300, placeholder: 'https://.../song.mp3' });
  if (stations.length) fields.push({ id: 'station', kind: 'select', label: 'Or a radio station', required: false, options: stations.map((s) => ({ label: s.name, value: s.id })) });
  const lists = allPlaylists(ctx).filter((pl) => pl.tracks.length).slice(0, 25);
  if (lists.length) fields.push({ id: 'playlist', kind: 'select', label: 'Or play a saved playlist', required: false, options: lists.map((pl) => ({ label: truncate(pl.name, 100), value: pl.id, description: `${pl.tracks.length} song${pl.tracks.length === 1 ? '' : 's'}` })) });
  if (ctx.config.get('allowUploads')) fields.push({ id: 'file', kind: 'files', label: 'Or upload a song', desc: 'MP3, OGG, WAV, FLAC or M4A, under 25 MB.', required: false, maxValues: 1 });
  return fields;
}
/**
 * A pasted link as something to play (3.1.2: shared by the Add music form and the dashboard).
 * Returns { track } for one song, or { list } for a Spotify playlist or album.
 */
async function resolveLink(ctx, link, base) {
  let track = null;
  // 3.1.2: a whole playlist or album from Spotify, Deezer, YouTube, SoundCloud or Bandcamp
  if (!ML.isDirectAudio(link) && ML.listLink(link)) {
    if (!mediaOn(ctx)) throw new UserError(MEDIA_OFF);
    return { list: await readList(ctx, link) };
  }
  if (ML.isDirectAudio(link)) {
    const u = ML.cleanLink(link);
    track = { ...base, source: 'link', title: decodeURIComponent(u.pathname.split('/').pop()).replace(ML.AUDIO_EXT, '').slice(0, 120) || 'Song', url: u.href, seconds: null, site: u.hostname };
  } else if (!ML.cleanLink(link)) throw new UserError("That doesn't look like a link.");
  else if (ML.isBandLab(link)) {
    if (!mediaOn(ctx)) throw new UserError(MEDIA_OFF);
    const b = await ML.bandlabTrack(link);
    track = { ...base, source: 'link', title: b.title, artist: b.artist, seconds: b.seconds, url: b.url, page: b.page, site: 'BandLab', whole: true };
  } else {
    // A link to an audio file without .mp3 in its name, or a page that names its audio, plays without yt-dlp.
    const probe = () => ML.probeLink(link, { onlyAudioFiles: !mediaOn(ctx) }).catch(() => null);
    const fromPage = (p) => ({ ...base, source: 'link', title: p.title || ML.cleanLink(p.url).hostname, url: p.url, page: p.page ?? link, seconds: null, whole: /mp4|m4a/.test(p.type ?? ''), site: ML.cleanLink(p.page ?? link).hostname.replace(/^www\./, '') });
    if (!mediaOn(ctx)) {
      const p = await probe();
      if (!p?.audio) throw new UserError(MEDIA_OFF);
      track = fromPage(p);
    } else {
      const y = await ytdlp(ctx);
      let input = link, credit = null, info = null, failed = null;
      if (ML.isSpotify(link)) {
        const sp = await ML.spotifyTrack(link);
        input = `ytsearch1:${sp.artist} ${sp.title} audio`;
        credit = `Spotify: “${sp.title}”${sp.artist ? ` by ${sp.artist}` : ''}, played from YouTube`;
      }
      if (y) info = await ML.lookup(y.bin, input, { spawnFn: spawnSeam() }).catch((e) => { failed = e; return null; });
      if (info) track = { ...base, source: 'media', title: info.title, artist: info.artist, seconds: info.seconds, page: info.page, site: info.site, credit, art: info.art };
      else {
        const p = input === link ? await probe() : null;
        if (p?.redirect && ML.isBandLab(p.redirect)) { const b = await ML.bandlabTrack(p.redirect); track = { ...base, source: 'link', title: b.title, artist: b.artist, seconds: b.seconds, url: b.url, page: b.page, site: 'BandLab', whole: true }; }
        else if (p?.url) track = fromPage(p);
        else if (failed) throw failed;
        else throw new UserError('Media links are on, but the yt-dlp program is missing. The bot owner can fix it with `/music` → Media links.');
      }
    }
  }
  return { track };
}

async function onAddSubmit(ctx, i) {
  const fields = addFields(ctx);
  const v = readForm(i, fields);
  await i.deferReply({ flags: EPH });
  const st = await connect(ctx, i.member);
  const base = { by: i.user.id };
  let track = null;
  if (v.file?.length) {
    const f = v.file[0];
    const ext = String(f.name).split('.').pop().toLowerCase();
    if (!AUDIO_TYPES.includes(ext)) throw new UserError('That file is not a song. Use MP3, OGG, WAV, FLAC or M4A.');
    if (f.size > MAX_UPLOAD) throw new UserError('That song is too big. Use one under 25 MB.');
    const r = await fetch(f.url).catch(() => null);
    if (!r?.ok) throw new UserError('Could not download that file. Try uploading it again.');
    const file = path.join(ctx.fileDir('uploads'), `${Date.now()}-${String(f.name).replace(/[^\w.-]+/g, '_').slice(0, 60)}`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    track = { ...base, source: 'upload', title: String(f.name).replace(/\.[^.]+$/, ''), file, seconds: null };
  } else if (v.link?.trim() && !looksLikeLink(v.link)) {
    return offerSearch(ctx, i, v.link.trim());
  } else if (v.link?.trim()) {
    const r = await resolveLink(ctx, v.link.trim(), base);
    if (r.list) return addSpotifyList(ctx, i, st, base, r.list);
    track = r.track;
  } else if (v.playlist) {
    const pl = getPlaylist(ctx, v.playlist);
    const limits = { max: ctx.config.get('maxQueue'), perUser: isDJ(ctx, i.member) ? Infinity : ctx.config.get('maxPerMember') };
    let added = 0, stop = null, off = 0;
    for (const t of pl.tracks) {
      if (t.source === 'media' && !mediaOn(ctx)) { off++; continue; }
      try { enqueue(st.queue, { ...t, id: undefined, by: i.user.id }, limits); added++; } catch (e) { stop = e.message; break; }
    }
    if (!added) throw new UserError(stop ?? 'Nothing on that playlist can play here right now (YouTube and Spotify songs need media links on).');
    if (!st.current) await next(ctx, st); else await refreshPlayer(ctx);
    return i.editReply({ content: `🎶 Added **${added}** song${added === 1 ? '' : 's'} from the playlist **${truncate(pl.name, 80)}**.${stop ? `\n-# The rest didn't fit: ${stop}` : ''}${off ? `\n-# ${off} YouTube or Spotify song${off === 1 ? '' : 's'} skipped: media links are off.` : ''}`, allowedMentions: NOPING });
  } else if (v.station) {
    const s = parseStations(ctx.config.get('stations')).find((x) => x.id === v.station);
    if (!s) throw new UserError('That station was removed.');
    track = { ...base, source: 'radio', title: s.name, url: s.url, seconds: null };
  } else if (v.search) {
    const found = await jamendoSearch(v.search);
    if (!found.length) throw new UserError(`No free songs matched “${truncate(v.search, 40)}”.`);
    track = { ...base, ...found[0] };
  } else throw new UserError('Pick something: paste a link, search, pick a station, or upload a song.');
  const pos = enqueue(st.queue, track, { max: ctx.config.get('maxQueue'), perUser: ctx.config.get('maxPerMember') });
  if (!st.current) await next(ctx, st); else await refreshPlayer(ctx);
  return i.editReply({ content: st.current === track ? `▶️ Playing **${truncate(track.title, 100)}**.` : `➕ **${truncate(track.title, 100)}** is number ${pos} in the queue.` });
}

const looksLikeLink = (text) => /^\s*(https?:\/\/|www\.)/i.test(String(text ?? '')) || /^\s*[\w-]+(\.[\w-]+)+\/\S*/.test(String(text ?? ''));
/**
 * Searches every source this server has (YouTube when media links are on, Jamendo, the radio stations) for a song name.
 * Returns { results, note }. Shared by the Add music popup and the dashboard.
 */
async function searchSongs(ctx, q, { limit = 8 } = {}) {
  const results = [], notes = [];
  if (mediaOn(ctx)) {
    const y = await ytdlp(ctx);
    if (y) { try { results.push(...(await ML.searchMany(y.bin, q, { spawnFn: spawnSeam(), limit })).map((t) => ({ ...t, source: 'media' }))); } catch (e) { notes.push(e.message); } }
    else notes.push('Media links are on, but yt-dlp is missing. The bot owner can fix it with /music → Media links.');
  }
  if (process.env.JAMENDO_CLIENT_ID) { try { results.push(...await jamendoSearch(q, { limit })); } catch (e) { notes.push(e.message); } }
  const low = q.toLowerCase();
  for (const s of parseStations(ctx.config.get('stations'))) if (s.name.toLowerCase().includes(low)) results.push({ source: 'radio', title: s.name, url: s.url, seconds: null, site: 'Radio' });
  if (!results.length && !mediaOn(ctx) && !process.env.JAMENDO_CLIENT_ID) notes.push('Searching by name needs YouTube (the bot owner turns on media links with /music) or free Jamendo music. Your radio stations are searched too, and a link to an audio file always works.');
  return { results, note: notes[0] ?? null };
}
/** Add music with a song name: a menu of what was found (or straight in, when there's only one). */
async function offerSearch(ctx, i, q) {
  const { results, note } = await searchSongs(ctx, q, { limit: 10 });
  if (!results.length) throw new UserError(note ?? `Nothing found for “${truncate(q, 60)}”. Try other words, or paste a link.`);
  if (results.length === 1) return pickSong(ctx, i, { ...results[0] }, { edit: true });
  const opts = results.slice(0, 25).map((t) => ({ label: truncate(t.title, 100), value: remember(ctx, t), description: truncate([t.artist, t.seconds ? clock(t.seconds) : t.source === 'radio' ? 'live radio' : null, t.site].filter(Boolean).join(' · '), 100) || undefined }));
  return i.editReply({ content: `🔎 **${results.length}** found for “${truncate(q, 80)}”. Pick one:`, allowedMentions: NOPING,
    components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('music:pick').setPlaceholder('Pick a song to play').addOptions(opts))] });
}
/** Queues a picked song for a member (their usual limits; DJs have none). */
async function pickSong(ctx, i, track, { edit = false } = {}) {
  const st = await connect(ctx, i.member);
  const t = { ...track, by: i.user.id, uid: undefined };
  const pos = enqueue(st.queue, t, { max: ctx.config.get('maxQueue'), perUser: isDJ(ctx, i.member) ? Infinity : ctx.config.get('maxPerMember') });
  if (!st.current) await next(ctx, st); else await refreshPlayer(ctx);
  const text = st.current === t ? `▶️ Playing **${truncate(t.title, 100)}**.` : `➕ **${truncate(t.title, 100)}** is number ${pos} in the queue.`;
  return edit ? i.editReply({ content: text, components: [], allowedMentions: NOPING }) : i.update({ content: text, components: [], allowedMentions: NOPING });
}

/**
 * The songs on a playlist or album from another site (3.1.2), ready to queue or keep:
 * { name, kind, site, songs }. Spotify and Deezer songs are found on YouTube when their turn comes.
 */
async function readList(ctx, link, { andVideos = false } = {}) {
  const l = ML.listLink(link, { andVideos });
  if (!l) return null;
  const from = (list, t) => ({ source: 'media', title: t.title, artist: t.artist, seconds: t.seconds, page: null, search: ML.spotifySearch(t), site: l.site, credit: `From the ${l.site} ${list.kind} “${truncate(list.name, 80)}”, played from YouTube` });
  if (l.site === 'Spotify') { const list = await ML.spotifyList(link); return { name: list.name, kind: list.kind, site: l.site, songs: list.tracks.slice(0, ML.MAX_LIST).map((t) => from(list, t)) }; }
  if (l.site === 'Deezer') { const list = await ML.deezerList(link); return { name: list.name, kind: list.kind, site: l.site, songs: list.tracks.map((t) => from(list, t)) }; }
  if (!mediaOn(ctx)) throw new UserError(MEDIA_OFF);
  const y = await ytdlp(ctx);
  if (!y) throw new UserError('Media links are on, but the yt-dlp program is missing. The bot owner can fix it with `/music` → Media links.');
  const list = await ML.siteList(y.bin, link, { spawnFn: spawnSeam() });
  return { name: list.name, kind: list.kind, site: l.site, songs: list.tracks.map((t) => ({ source: 'media', ...t })) };
}
/** Queues a playlist or album from another site (as many songs as the limits allow). */
async function addSpotifyList(ctx, i, st, base, list) {
  const limits = { max: ctx.config.get('maxQueue'), perUser: isDJ(ctx, i.member) ? Infinity : ctx.config.get('maxPerMember') };
  let added = 0, stop = null;
  for (const t of list.songs) {
    try { enqueue(st.queue, { ...t, ...base }, limits); added++; } catch (e) { stop = e.message; break; }
  }
  if (!added) throw new UserError(stop ?? 'Nothing on that playlist can be played.');
  if (!st.current) await next(ctx, st); else await refreshPlayer(ctx);
  const left = list.songs.length - added;
  return i.editReply({ content: `🎶 Added **${added}** song${added === 1 ? '' : 's'} from the ${list.site} ${list.kind} **${truncate(list.name, 80)}**.${left ? `\n-# ${left} more didn't fit: ${stop} Staff can raise the limits in the music settings.` : ''}${list.site === 'Spotify' && list.songs.length >= 100 ? '\n-# Spotify only shares the first 100 songs of a playlist.' : ''}`, allowedMentions: NOPING });
}

async function onButton(ctx, i) {
  const action = i.customId.split(':')[1];
  if (action === 'form') return onAddSubmit(ctx, i);
  if (action === 'pick') {
    if (!i.member.voice?.channel) throw new UserError('Join a voice channel first.');
    return pickSong(ctx, i, recall(ctx, i.values?.[0])[0]);
  }
  if (['media', 'mediaon', 'mediaoff'].includes(action)) {
    if (!ctx.isBotOwner?.(i.user.id)) throw new UserError('Only the person who runs this bot can change media links.');
    if (action === 'media') return i.reply({ content: MEDIA_WARNING, flags: EPH, components: [mediaRow(ctx)] });
    if (action === 'mediaoff') { ctx.data.set('mediaLinks', { on: false, by: i.user.id, at: Date.now() }); await refreshPlayer(ctx); return i.update({ content: '🔇 Media links are **off** in this server. Members can still paste links straight to audio files.', components: [] }); }
    await i.deferUpdate();
    let y = await ytdlp(ctx);
    if (!y) { await ML.downloadYtDlp(ctx.botDir('tools')); y = await ytdlp(ctx); }
    if (!y) throw new UserError("yt-dlp was downloaded but won't start on this computer. Install it yourself (github.com/yt-dlp/yt-dlp) and try again.");
    ctx.data.set('mediaLinks', { on: true, by: i.user.id, at: Date.now() });
    ctx.security(`${i.user.username} turned on media links for music (yt-dlp ${y.version})`);
    await refreshPlayer(ctx);
    return i.editReply({ content: `✅ Media links are **on** in this server, and stay on (yt-dlp ${y.version}). Press **Add music** and paste a link.`, components: [] });
  }
  if (action === 'add') {
    const fields = addFields(ctx);
    if (!fields.length) throw new UserError('No music sources are set up. An admin adds radio stations or allows uploads in the music settings, or the bot owner sets up Jamendo.');
    if (!i.member.voice?.channel) throw new UserError('Join a voice channel first.');
    return i.showModal(formModal('music:form', 'Add music', fields));
  }
  if (['queue', 'qpage', 'qpick', 'qtop', 'qdel', 'qshuffle', 'qrepeat'].includes(action)) return queueAction(ctx, i, action);
  const st = states.get(ctx.guildId);
  if (!st) throw new UserError('Nothing is playing.');
  if (i.member.voice?.channel?.id !== st.channelId) throw new UserError(`Join <#${st.channelId}> to control the music.`);
  if (action === 'volup' || action === 'voldown') {
    if (!isDJ(ctx, i.member) && listenersOf(ctx, st) > 1) throw new UserError('Only the DJ role or staff can change the volume while others are listening.');
    setVolume(ctx, volumeOf(ctx) + (action === 'volup' ? VOLUME_STEP : -VOLUME_STEP));
    announce(ctx);
    return i.update(playerPayload(ctx));
  }
  if (!canControl({ member: i.member, track: st.current, djRole: ctx.config.get('djRole'), listeners: listenersOf(ctx, st) })) throw new UserError('Only the person who added this song, the DJ role or staff can do that while others are listening.');
  if (action === 'pause') setPaused(ctx, st, !st.paused);
  if (action === 'skip') stopCurrent(ctx, st);
  if (action === 'stop') { cleanup(ctx.guildId); }
  if (action === 'prev') goBack(ctx, st);
  announce(ctx);
  return i.update(playerPayload(ctx));
}

// ------------------------------------------------------------------ the queue (3.1)
const PAGE = 15;
const isDJ = (ctx, member) => !!(ctx.config.get('djRole') && member.roles?.cache?.has?.(ctx.config.get('djRole'))) || !!member.permissions?.has?.(P.ManageChannels);
function queuePayload(ctx, st, page = 0) {
  const pages = Math.max(1, Math.ceil(st.queue.length / PAGE));
  page = Math.max(0, Math.min(pages - 1, page));
  const slice = st.queue.slice(page * PAGE, page * PAGE + PAGE);
  const rep = st.repeat ?? 'off';
  const e = new EmbedBuilder().setColor(0x6b93ff).setTitle(`📜 Queue · ${st.queue.length} song${st.queue.length === 1 ? '' : 's'}`)
    .setDescription([st.current ? `**Now:** ${truncate(st.current.title, 80)} · <@${st.current.by}>` : null, '',
      slice.length ? slice.map((t, k) => `**${page * PAGE + k + 1}.** ${truncate(t.title, 70)} · ${clock(t.seconds)} · <@${t.by}>`).join('\n') : '*Nothing waiting. Press Add music on the player.*'].filter((x) => x !== null).join('\n'))
    .setFooter({ text: `Repeat: ${rep === 'one' ? 'this song' : rep === 'all' ? 'the whole queue' : 'off'} · page ${page + 1} of ${pages}` });
  const rows = [];
  if (slice.length) rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`music:qpick:${page}`).setPlaceholder('Pick a song to move or remove')
    .addOptions(slice.map((t, k) => ({ label: truncate(`${page * PAGE + k + 1}. ${t.title}`, 100), value: t.uid, description: truncate(t.artist || t.source || 'song', 100) })))));
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`music:qpage:${page - 1}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`music:qpage:${page + 1}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
    new ButtonBuilder().setCustomId('music:qshuffle').setLabel('Shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary).setDisabled(st.queue.length < 2),
    new ButtonBuilder().setCustomId('music:qrepeat').setLabel(rep === 'off' ? 'Repeat: off' : rep === 'one' ? 'Repeat: song' : 'Repeat: queue').setEmoji(rep === 'one' ? '🔂' : '🔁').setStyle(rep === 'off' ? ButtonStyle.Secondary : ButtonStyle.Primary)));
  return { embeds: [e], components: rows, allowedMentions: NOPING };
}
async function queueAction(ctx, i, action) {
  const st = states.get(ctx.guildId);
  if (!st) throw new UserError('Nothing is playing.');
  const parts = i.customId.split(':');
  if (action === 'queue') { await i.reply({ ...queuePayload(ctx, st), flags: EPH }); return watchQueue(st, i, 0); }
  if (action === 'qpage') { const page = Number(parts[2]) || 0; await i.update(queuePayload(ctx, st, page)); return watchQueue(st, i, page); }
  const inVoice = i.member.voice?.channel?.id === st.channelId;
  if (action === 'qpick') {
    const t = st.queue.find((x) => x.uid === i.values?.[0]);
    if (!t) throw new UserError('That song already played or was removed.');
    const mine = t.by === i.user.id;
    return i.reply({ content: `**${truncate(t.title, 90)}** · added by <@${t.by}>`, flags: EPH, allowedMentions: NOPING, components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`music:qtop:${t.uid}`).setLabel('Play next').setEmoji('⏫').setStyle(ButtonStyle.Primary).setDisabled(!isDJ(ctx, i.member) && !(mine && listenersOf(ctx, st) <= 1)),
      new ButtonBuilder().setCustomId(`music:qdel:${t.uid}`).setLabel('Remove').setEmoji('🗑️').setStyle(ButtonStyle.Danger).setDisabled(!mine && !isDJ(ctx, i.member)))] });
  }
  if (!inVoice) throw new UserError(`Join <#${st.channelId}> to change the queue.`);
  if (action === 'qtop') { if (!isDJ(ctx, i.member) && listenersOf(ctx, st) > 1) throw new UserError('Only the DJ role or staff can reorder the queue while others are listening.'); moveToFront(st.queue, parts[2]); }
  if (action === 'qdel') { const t = st.queue.find((x) => x.uid === parts[2]); if (t && t.by !== i.user.id && !isDJ(ctx, i.member)) throw new UserError('You can only remove your own songs.'); const gone = removeTrack(st.queue, parts[2]); if (gone?.file) fs.rm(gone.file, { force: true }, () => {}); forget(gone); }
  if (action === 'qshuffle') { if (!isDJ(ctx, i.member) && listenersOf(ctx, st) > 1) throw new UserError('Only the DJ role or staff can shuffle while others are listening.'); shuffle(st.queue); }
  if (action === 'qrepeat') { if (!isDJ(ctx, i.member) && listenersOf(ctx, st) > 1) throw new UserError('Only the DJ role or staff can change repeat while others are listening.'); st.repeat = REPEAT_NEXT[st.repeat ?? 'off']; }
  await refreshPlayer(ctx);
  if (action === 'qtop' || action === 'qdel') return i.update({ content: action === 'qtop' ? '⏫ It plays next.' : '🗑️ Removed.', components: [] });
  await i.update(queuePayload(ctx, st, st.queueViews.get(i.user.id)?.page ?? 0));
  return watchQueue(st, i, st.queueViews.get(i.user.id)?.page ?? 0);
}

async function musicCommand(ctx, i) {
  const old = ctx.data.get('player');
  if (old) { const ch = ctx.guild?.channels.cache.get(old.channelId); const m = await ch?.messages?.fetch?.(old.messageId).catch(() => null); await m?.delete?.().catch(() => {}); }
  const msg = await i.channel.send(playerPayload(ctx));
  ctx.data.set('player', { channelId: i.channelId, messageId: msg.id });
  const owner = ctx.isBotOwner?.(i.user.id);
  return i.reply({ content: `The music player is posted. Join a voice channel and press **Add music**.${owner ? `\n-# Media links (YouTube, Spotify and more) are **${mediaOn(ctx) ? 'on' : 'off'}** in this server. Only you can change this.` : ''}`, flags: EPH,
    components: owner ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('music:media').setLabel(mediaOn(ctx) ? 'Media links: on' : 'Media links: off').setEmoji('🔗').setStyle(ButtonStyle.Secondary))] : [] });
}
function mediaRow(ctx) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music:mediaon').setLabel(mediaOn(ctx) ? 'Keep them on' : 'I understand, turn them on').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('music:mediaoff').setLabel(mediaOn(ctx) ? 'Turn them off' : 'Keep them off').setStyle(ButtonStyle.Secondary));
}

// ------------------------------------------------------------------ 3.1.2: the dashboard player and playlists
// The dashboard's Music page works like a music app: what's playing with a progress bar, play/pause/skip/back, a volume
// slider, the queue, a search box, and playlists kept on this server. People who hold "Control the music from the
// dashboard" use it like the DJ role. Every change is sent to open dashboards straight away (see announce()).
const rid = (n = 8) => crypto.randomBytes(n).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, n + 2) || Math.random().toString(36).slice(2, 10);
const memberName = (ctx, id) => { const m = ctx.guild?.members?.cache?.get?.(id); return m?.displayName ?? m?.user?.globalName ?? m?.user?.username ?? null; };
function publicTrack(ctx, t) {
  if (!t) return null;
  return { uid: t.uid ?? null, title: String(t.title ?? 'Song'), artist: t.artist ?? null, seconds: Number(t.seconds) || null, source: t.source ?? null, site: t.site ?? null,
    credit: t.credit ?? null, page: typeof t.page === 'string' && /^https:\/\//i.test(t.page) ? t.page : null, art: ML.safeArt(t.art), by: t.by ?? null, byName: t.by ? memberName(ctx, t.by) : null, canSave: !!savable(t) };
}
/** What's playing, for the dashboard (no file names, no stream addresses). */
export function snapshot(ctx) {
  const st = states.get(ctx.guildId);
  const volume = volumeOf(ctx);
  if (!st) return { connected: false, volume, repeat: 'off', queue: [], queueLength: 0, at: Date.now() };
  const ch = ctx.guild?.channels?.cache?.get(st.channelId);
  return { connected: true, channelId: st.channelId, channelName: ch?.name ?? null, listeners: listenersOf(ctx, st), paused: !!st.paused, volume, repeat: st.repeat ?? 'off',
    current: publicTrack(ctx, st.current), preparing: !!st.preparing, elapsed: Math.round(elapsedOf(st) * 10) / 10, canSeek: canSeek(st.current), hasBack: !!st.current && (canSeek(st.current) || st.history.length > 0),
    queue: st.queue.slice(0, 100).map((t) => publicTrack(ctx, t)), queueLength: st.queue.length, totalSeconds: totalSeconds(st.queue), at: Date.now() };
}

// playlists: one stored document each, "pl:<id>"
const plKey = (id) => `pl:${String(id ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)}`;
const allPlaylists = (ctx) => ctx.data.list('pl:', 500).map((r) => r.value).filter((p) => p?.id && Array.isArray(p.tracks)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
function getPlaylist(ctx, id) { const pl = ctx.data.get(plKey(id)); if (!pl?.tracks) throw new UserError('That playlist was deleted.'); return pl; }
function storePlaylist(ctx, pl) { pl.updatedAt = Date.now(); ctx.data.set(plKey(pl.id), pl); return pl; }
const playlistSummary = (ctx, pl) => ({ id: pl.id, name: pl.name, count: pl.tracks.length, seconds: totalSeconds(pl.tracks), art: [...new Set(pl.tracks.map((t) => ML.safeArt(t.art)).filter(Boolean))].slice(0, 4),
  byName: pl.by ? memberName(ctx, pl.by) ?? pl.byName ?? null : null, updatedAt: pl.updatedAt ?? null });
const playlistFull = (ctx, pl) => ({ ...playlistSummary(ctx, pl), tracks: pl.tracks.map((t) => ({ id: t.id, ...publicTrack(ctx, t), by: undefined, byName: undefined })) });
/** Adds songs to a playlist (as much as fits). Uploads can't be kept. */
export function addToPlaylist(pl, tracks) {
  const keep = tracks.map(savable).filter(Boolean);
  const room = MAX_PLAYLIST_SONGS - pl.tracks.length;
  if (room <= 0 && keep.length) throw new UserError(`A playlist holds up to ${MAX_PLAYLIST_SONGS} songs.`);
  const ok = keep.slice(0, room).map((t) => ({ ...t, id: Math.random().toString(36).slice(2, 10) }));
  pl.tracks.push(...ok);
  return { added: ok.length, skipped: tracks.length - ok.length };
}
function newPlaylist(ctx, name, actor) {
  if (allPlaylists(ctx).length >= MAX_PLAYLISTS) throw new UserError(`This server already has ${MAX_PLAYLISTS} playlists. Delete one first.`);
  return { id: rid(8), name: cleanPlaylistName(name), by: actor?.userId ?? null, byName: actor?.username ?? null, createdAt: Date.now(), tracks: [] };
}

// search results are kept here for half an hour, so the page only ever sends back a token, never a web address to play
const found = (globalThis[Symbol.for('goodboy.music.found')] ??= new Map());
function remember(ctx, track) {
  const now = Date.now();
  for (const [k, v] of found) if (now - v.at > 30 * 60000) found.delete(k);
  while (found.size > 3000) found.delete(found.keys().next().value);
  const token = rid(12);
  found.set(token, { at: now, guildId: ctx.guildId, track: { ...track, by: undefined, uid: undefined } });
  return token;
}
function recall(ctx, tokens) {
  const list = (Array.isArray(tokens) ? tokens : [tokens]).slice(0, MAX_PLAYLIST_SONGS).map((t) => found.get(String(t ?? '')));
  if (!list.length || list.some((f) => !f || f.guildId !== ctx.guildId)) throw new UserError('That search result expired. Search again.');
  return list.map((f) => ({ ...f.track }));
}
/** A song from the queue or the one playing, by its uid. */
function liveTrack(st, uid) {
  const t = st && [st.current, ...st.queue].find((x) => x?.uid === uid);
  if (!t) throw new UserError('That song already played or was removed.');
  return t;
}
/** Songs from what the page sent: search tokens, a pasted link, a station, or a song already in the queue. */
async function songsFrom(ctx, body) {
  if (body.tokens?.length || body.token) return recall(ctx, body.tokens ?? body.token);
  if (body.station) { const s = parseStations(ctx.config.get('stations')).find((x) => x.id === body.station); if (!s) throw new UserError('That station was removed.'); return [{ source: 'radio', title: s.name, url: s.url, seconds: null }]; }
  if (body.uid) return [{ ...liveTrack(states.get(ctx.guildId), String(body.uid)) }];
  const link = String(body.link ?? '').trim();
  if (link) { const r = await resolveLink(ctx, link, {}); return r.list ? r.list.songs : [r.track]; }
  throw new UserError('Pick a song first.');
}
/** Joins the picked voice channel, or the one the person is in, when Good Boy isn't in voice yet. */
async function ensureVoice(ctx, body, actor) {
  const st = states.get(ctx.guildId);
  if (st) {
    if (body.channelId && String(body.channelId) !== st.channelId) throw new UserError(`Good Boy is already playing in #${ctx.guild?.channels?.cache?.get(st.channelId)?.name ?? 'another channel'}. Stop the music first to move it.`);
    return st;
  }
  const channelId = String(body.channelId ?? '') || ctx.guild?.voiceStates?.cache?.get?.(actor?.userId)?.channelId;
  if (!channelId) throw new UserError('Pick a voice channel for Good Boy to play in.');
  return connect(ctx, null, { channelId });
}
/** Queues songs for someone using the dashboard: they count as a DJ, so only the queue size limits them. */
async function queueSongs(ctx, st, tracks, actor, { where = 'end' } = {}) {
  const max = ctx.config.get('maxQueue');
  let added = 0, offline = 0, full = null;
  const put = [];
  for (const t of tracks) {
    if (t.source === 'media' && !mediaOn(ctx)) { offline++; continue; }
    try { const track = { ...t, by: actor?.userId ?? null, uid: undefined, id: undefined }; enqueue(st.queue, track, { max, perUser: Infinity }); put.push(track); added++; } catch (e) { full = e.message; break; }
  }
  if (where !== 'end' && put.length) { st.queue.splice(st.queue.length - put.length, put.length); st.queue.unshift(...put); }
  if (where === 'now' && st.current && put.length) stopCurrent(ctx, st);
  else if (!st.current && put.length) await next(ctx, st);
  else await refreshPlayer(ctx);
  if (!added && (offline || full)) throw new UserError(full ?? 'Those songs are from YouTube or Spotify, and media links are off in this server.');
  return { added, skipped: tracks.length - added, note: [full, offline ? `${offline} song${offline === 1 ? '' : 's'} from YouTube or Spotify can't play while media links are off.` : null].filter(Boolean).join(' ') || null };
}
const playing = (ctx) => { const st = states.get(ctx.guildId); if (!st) throw new UserError('Nothing is playing. Pick a voice channel and play something first.'); return st; };

const dashboardViews = {
  player(ctx) {
    const g = ctx.guild;
    const me = g?.members?.me;
    const voiceChannels = [...(g?.channels?.cache?.values?.() ?? [])].filter((c) => c.type === 2 || c.type === 13).sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0)).slice(0, 100)
      .map((c) => ({ id: c.id, name: c.name, listeners: c.members?.filter?.((m) => !m.user?.bot)?.size ?? 0,
        canJoin: (() => { try { const p = me && c.permissionsFor?.(me); return p ? p.has(P.Connect) && p.has(P.Speak) : true; } catch { return true; } })() }));
    return { ...snapshot(ctx), voiceChannels, playlists: allPlaylists(ctx).map((pl) => playlistSummary(ctx, pl)), limits: { maxQueue: ctx.config.get('maxQueue'), playlistSongs: MAX_PLAYLIST_SONGS, playlists: MAX_PLAYLISTS },
      sources: { media: mediaOn(ctx), jamendo: !!process.env.JAMENDO_CLIENT_ID, stations: parseStations(ctx.config.get('stations')).map((s) => ({ id: s.id, name: s.name })) } };
  },
  playlist(ctx, q) { return playlistFull(ctx, getPlaylist(ctx, q.id)); },
};

const dashboardActions = {
  async join(ctx, body, actor) { await ensureVoice(ctx, body, actor); await refreshPlayer(ctx); return snapshot(ctx); },
  async control(ctx, body) {
    const st = playing(ctx);
    const what = String(body.do ?? '');
    if (what === 'pause' || what === 'resume' || what === 'toggle') {
      const pause = what === 'toggle' ? !st.paused : what === 'pause';
      if (!st.current) throw new UserError('Nothing is playing.');
      setPaused(ctx, st, pause);
    } else if (what === 'skip') { if (!st.current) throw new UserError('Nothing is playing.'); stopCurrent(ctx, st); }
    else if (what === 'back') goBack(ctx, st);
    else if (what === 'stop') cleanup(ctx.guildId);
    else if (what === 'shuffle') shuffle(st.queue);
    else if (what === 'repeat') st.repeat = Object.hasOwn(REPEAT_NEXT, body.value) ? body.value : REPEAT_NEXT[st.repeat ?? 'off'];
    else throw new UserError('Unknown control.');
    await refreshPlayer(ctx);
    return snapshot(ctx);
  },
  async volume(ctx, body) { setVolume(ctx, body.value); await refreshPlayer(ctx); return snapshot(ctx); },
  async seek(ctx, body) {
    const st = playing(ctx);
    const cur = st.current;
    if (!canSeek(cur)) throw new UserError("You can't jump around in this one (radio, or a song whose length isn't known).");
    jumpTo(ctx, st, cur, Math.max(0, Math.min(cur.seconds - 1, Math.floor(Number(body.seconds) || 0))));
    return { ok: true };
  },
  async queue(ctx, body) {
    const st = playing(ctx);
    const uid = String(body.uid ?? '');
    if (body.op === 'remove') { const gone = removeTrack(st.queue, uid); if (gone?.file) fs.rm(gone.file, { force: true }, () => {}); forget(gone); }
    else if (body.op === 'top') moveToFront(st.queue, uid);
    else if (body.op === 'move') moveTrack(st.queue, uid, body.to);
    else if (body.op === 'play') { moveToFront(st.queue, uid); if (st.current) stopCurrent(ctx, st); else await next(ctx, st); }
    else if (body.op === 'clear') { for (const t of st.queue.splice(0)) { if (t.file) fs.rm(t.file, { force: true }, () => {}); forget(t); } }
    else throw new UserError('Unknown queue change.');
    await refreshPlayer(ctx);
    return snapshot(ctx);
  },
  async add(ctx, body, actor) {
    const tracks = await songsFrom(ctx, body);
    const st = await ensureVoice(ctx, body, actor);
    const r = await queueSongs(ctx, st, tracks, actor, { where: ['next', 'now'].includes(body.where) ? body.where : 'end' });
    return { ...r, state: snapshot(ctx) };
  },
  async search(ctx, body) {
    const q = String(body.q ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (q.length < 2) throw new UserError('Type at least 2 letters.');
    if (looksLikeLink(q)) {
      const link = /^https?:\/\//i.test(q) ? q : `https://${q}`;
      // a playlist can be read (and kept) even while media links are off; it plays once they're on
      const list = ML.listLink(link, { andVideos: true }) ? await readList(ctx, link, { andVideos: true }) : null;
      const tracks = list ? list.songs : [(await resolveLink(ctx, link, {})).track];
      return { results: tracks.map((t) => ({ token: remember(ctx, t), ...publicTrack(ctx, t) })), list: list ? { name: list.name, kind: list.kind, site: list.site, count: tracks.length } : null,
        note: list && !mediaOn(ctx) ? 'You can save these as a playlist now. They play once the bot owner turns on media links with /music in Discord.' : null };
    }
    const { results, note } = await searchSongs(ctx, q);
    return { results: results.map((t) => ({ token: remember(ctx, t), ...publicTrack(ctx, t) })), note };
  },
  async playlist(ctx, body, actor) {
    const op = String(body.op ?? '');
    if (op === 'import') {
      const link = String(body.link ?? '').trim();
      const list = await readList(ctx, /^https?:\/\//i.test(link) ? link : `https://${link}`, { andVideos: true });
      if (!list) throw new UserError('Paste a link to a playlist or album from Spotify, YouTube, YouTube Music, SoundCloud, Bandcamp or Deezer.');
      const pl = newPlaylist(ctx, String(body.name ?? '').trim() || list.name, actor);
      const r = addToPlaylist(pl, list.songs);
      storePlaylist(ctx, pl);
      ctx.live('activity', { icon: '🎶', text: `${actor?.username ?? 'Someone'} imported “${truncate(pl.name, 60)}” from ${list.site}` });
      return { ...r, site: list.site, playlist: playlistFull(ctx, pl), note: !mediaOn(ctx) ? 'These songs play once the bot owner turns on media links with /music in Discord.' : null };
    }
    if (op === 'create') {
      const pl = newPlaylist(ctx, body.name, actor);
      let r = { added: 0, skipped: 0 };
      if (body.fromQueue) { const st = playing(ctx); r = addToPlaylist(pl, [st.current, ...st.queue].filter(Boolean)); if (!r.added) throw new UserError('Nothing in the queue can be saved (uploaded songs are deleted once they play).'); }
      else if (body.tokens?.length || body.link || body.uid) r = addToPlaylist(pl, await songsFrom(ctx, body));
      storePlaylist(ctx, pl);
      ctx.live('activity', { icon: '🎶', text: `${actor?.username ?? 'Someone'} made the playlist “${truncate(pl.name, 60)}”` });
      return { ...r, playlist: playlistFull(ctx, pl) };
    }
    const pl = getPlaylist(ctx, body.id);
    if (op === 'rename') { pl.name = cleanPlaylistName(body.name); storePlaylist(ctx, pl); return { playlist: playlistFull(ctx, pl) }; }
    if (op === 'delete') { ctx.data.delete(plKey(pl.id)); return { deleted: true }; }
    if (op === 'add') { const r = addToPlaylist(pl, await songsFrom(ctx, body)); storePlaylist(ctx, pl); return { ...r, playlist: playlistFull(ctx, pl) }; }
    if (op === 'remove') { const k = pl.tracks.findIndex((t) => t.id === body.trackId); if (k < 0) throw new UserError('That song is not on the playlist any more.'); pl.tracks.splice(k, 1); storePlaylist(ctx, pl); return { playlist: playlistFull(ctx, pl) }; }
    if (op === 'move') {
      const k = pl.tracks.findIndex((t) => t.id === body.trackId); if (k < 0) throw new UserError('That song is not on the playlist any more.');
      const [t] = pl.tracks.splice(k, 1); pl.tracks.splice(Math.max(0, Math.min(pl.tracks.length, Math.floor(Number(body.to) || 0))), 0, t);
      storePlaylist(ctx, pl); return { playlist: playlistFull(ctx, pl) };
    }
    if (op === 'play') {
      let tracks = pl.tracks.map((t) => ({ ...t }));
      if (!tracks.length) throw new UserError('This playlist is empty. Add some songs first.');
      const from = body.trackId ? tracks.findIndex((t) => t.id === body.trackId) : 0;
      if (from > 0) tracks = [...tracks.slice(from), ...tracks.slice(0, from)];
      if (body.shuffle) shuffle(tracks);
      const st = await ensureVoice(ctx, body, actor);
      if (body.replace !== false) { for (const t of st.queue.splice(0)) { if (t.file) fs.rm(t.file, { force: true }, () => {}); forget(t); } }
      const r = await queueSongs(ctx, st, tracks, actor, { where: body.replace !== false ? 'now' : 'end' });
      ctx.live('activity', { icon: '🎶', text: `${actor?.username ?? 'Someone'} is playing “${truncate(pl.name, 60)}”` });
      return { ...r, state: snapshot(ctx) };
    }
    throw new UserError('Unknown playlist change.');
  },
};

export default {
  name: 'music',
  version: '1.1.0',
  description: 'Music in voice: member uploads, audio links, radio stations you choose and free Creative Commons music, with a shared player. YouTube and Spotify links are an opt-in the bot owner can turn on.',
  settings: [
    { key: 'allowUploads', type: 'toggle', label: 'Members can upload songs to play', default: true },
    { key: 'stations', type: 'list', label: 'Radio stations (Name | stream link). Only add stations that allow it.' },
    { key: 'djRole', type: 'role', label: 'DJ role: can skip and stop anyone\'s songs' },
    { key: 'volume', type: 'number', label: 'Volume (%)', default: 70, min: 0, max: 100 },
    { key: 'smooth', type: 'toggle', label: 'Download each song before it plays (smoother sound; the first song takes a few seconds to start)', default: true },
    { key: 'maxQueue', type: 'number', label: 'Most songs in the queue', default: 50, min: 5, max: 200 },
    { key: 'maxPerMember', type: 'number', label: 'Most songs one member can queue', default: 10, min: 1, max: 50 },
    { key: 'idleMinutes', type: 'number', label: 'Leave voice after this many minutes with nothing playing', default: 5, min: 1, max: 60 },
  ],
  permissions: [{ key: 'music.player', label: 'Post the music player', default: 'moderator' },
    { key: 'music.dj', label: 'Control the music and playlists from the dashboard', default: 'moderator' }],
  commands: [{
    permission: 'music.player', defer: false,
    data: new SlashCommandBuilder().setName('music').setDescription('Post the music player in this channel'),
    execute: musicCommand,
  }],
  components: [{ prefix: 'music:', execute: onButton }],
  // 3.1.2: the dashboard's Music page (a player, a volume slider, search and playlists).
  panels: [{ id: 'player', title: 'Music player', view: 'player', kind: 'music-player', page: 'music', permission: 'music.dj',
    pageViews: ['playlist'], pageActions: ['join', 'control', 'volume', 'seek', 'queue', 'add', 'search', 'playlist'],
    description: 'Play, pause, skip and change the volume, search for songs, and make playlists for this server.' }],
  views: dashboardViews,
  actions: dashboardActions,
  onSettingChange(ctx, key) {
    if (key !== 'volume') return;
    applyVolume(ctx);
    refreshPlayer(ctx).catch(() => {});
  },
  async destroy(ctx) { cleanup(ctx.guildId); },
};
