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

/** Jamendo search (free CC music). Returns tracks with their attribution. fetchFn is for tests. */
export async function jamendoSearch(query, { clientId = process.env.JAMENDO_CLIENT_ID, fetchFn = globalThis.fetch, limit = 5 } = {}) {
  if (!clientId) throw new UserError('Jamendo search is not set up on this bot. The bot owner adds a free JAMENDO_CLIENT_ID (developer.jamendo.com).');
  const u = `https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(clientId)}&format=json&limit=${limit}&audioformat=mp32&include=licenses&search=${encodeURIComponent(String(query).slice(0, 100))}`;
  const r = await fetchFn(u, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (!r?.ok) throw new UserError('Jamendo did not answer. Try again in a minute.');
  const d = await r.json();
  return (d.results ?? []).filter((t) => t.audio).map((t) => ({ source: 'jamendo', title: String(t.name ?? 'Song'), artist: String(t.artist_name ?? ''), url: t.audio, seconds: Number(t.duration) || null, credit: `“${t.name}” by ${t.artist_name} (Jamendo${t.license_ccurl ? `, ${t.license_ccurl}` : ''})`, link: t.shareurl ?? null }));
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
  for (const t of [st.current, ...st.queue]) if (t?.file) fs.rm(t.file, { force: true }, () => {});
  st.stopStream?.(); dropTemp(st);
  states.delete(guildId);
}
function armIdle(ctx, st) {
  clearTimeout(st.idleTimer);
  st.idleTimer = setTimeout(() => { cleanup(ctx.guildId); refreshPlayer(ctx).catch(() => {}); }, ctx.config.get('idleMinutes') * 60000);
  st.idleTimer.unref?.();
}
async function connect(ctx, member) {
  const { voice } = await load();
  const vc = member.voice?.channel;
  let st = states.get(ctx.guildId);
  if (st) { if (vc?.id !== st.channelId) throw new UserError(`Join <#${st.channelId}> to control the music.`); return st; }
  if (!vc) throw new UserError('Join a voice channel first.');
  if (ttsBusy(ctx.guildId)) throw new UserError('Good Boy is reading text aloud in voice right now. Use `/tts leave` first; music and speech share one voice connection.');
  const perms = vc.permissionsFor(member.guild.members.me);
  if (!perms?.has(P.Connect) || !perms.has(P.Speak)) throw new UserError("I can't join or speak in that channel (I need Connect and Speak).");
  const connection = voice.joinVoiceChannel({ channelId: vc.id, guildId: ctx.guildId, adapterCreator: member.guild.voiceAdapterCreator, selfDeaf: true });
  try { await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, 15000); } catch { connection.destroy(); throw new UserError("I couldn't connect to voice in time. Try again, or check the bot's voice packages are up to date."); }
  const player = voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause } });
  connection.subscribe(player);
  st = { connection, player, channelId: vc.id, queue: [], current: null, paused: false, textChannelId: null, messageId: null };
  states.set(ctx.guildId, st);
  player.on(voice.AudioPlayerStatus.Idle, () => {
    st.stopStream?.(); st.stopStream = null; dropTemp(st);
    const done = st.current; st.current = null;
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
async function downloadWhole(ctx, url) {
  const o = await openStream(url, { stallMs: 60000 });
  const r = { headers: o.headers };
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
/**
 * ffmpeg reading a song by address or file, so it can start part way in (start, seconds) and, for web addresses,
 * reconnect when the site drops the connection: long pauses and long songs do that.
 */
export function ffmpegArgs(src, { start = 0, headers = null } = {}) {
  const web = /^https?:\/\//i.test(src);
  const h = headers && Object.keys(headers).length ? Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n' : null;
  return [
    ...(web ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5', '-rw_timeout', '15000000'] : []),
    ...(h ? ['-headers', h] : []),
    ...(start > 0 ? ['-ss', String(Math.floor(start))] : []),
    '-i', src, '-analyzeduration', '0', '-loglevel', '0', '-f', 's16le', '-ar', '48000', '-ac', '2',
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
    let input, raw = false;
    const start = track.startAt ?? 0;
    track.resumable = false;
    // Our own ffmpeg: it can start part way in and reconnect. Without prism (tests), the voice library's ffmpeg is used.
    const ff = (src, opts) => { const f = new prism.FFmpeg({ args: ffmpegArgs(src, { start, ...opts }) }); st.stopStream = () => f.destroy(); raw = true; track.resumable = true; return f; };
    // A path, not a stream: .m4a songs keep their index at the end, which ffmpeg can only reach in a file.
    if (track.file) input = prism ? ff(track.file) : track.file;
    else if (track.url && needsWhole(track)) { st.tempFile = await downloadWhole(ctx, track.url); input = prism ? ff(st.tempFile) : st.tempFile; }
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
    const resource = voice.createAudioResource(input, { inputType: raw ? voice.StreamType.Raw : voice.StreamType.Arbitrary, inlineVolume: true });
    st.resource = resource;
    resource.volume?.setVolume(ctx.config.get('volume') / 100);
    st.player.play(resource);
  } catch (e) {
    ctx.log.warn(`Could not play ${track.title}: ${e.message}`);
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
    e.setDescription([t ? `${st.paused ? '⏸️' : '▶️'} **${truncate(t.title, 120)}**${t.artist ? ` · ${truncate(t.artist, 60)}` : ''} · ${clock(t.seconds)}\nAdded by <@${t.by}>` : '*Nothing playing right now.*',
      t?.credit ? `-# ${truncate(t.credit, 300)}` : null, t?.page ? `-# [Open on ${truncate(t.site ?? 'the site', 30)}](${t.page})` : null, `In <#${st.channelId}>`].filter(Boolean).join('\n'));
    if (st.queue.length) e.addFields({ name: `Up next (${st.queue.length})`, value: st.queue.slice(0, 8).map((x, k) => `${k + 1}. ${truncate(x.title, 70)} · <@${x.by}>`).join('\n') + (st.queue.length > 8 ? `\n…and ${st.queue.length - 8} more` : '') });
  }
  e.setFooter({ text: mediaOn(ctx) ? 'Paste a link (YouTube, Spotify, SoundCloud, BandLab and more), upload a song, or pick a station.' : 'Uploads, audio links, radio stations and Creative Commons music from Jamendo.' });
  const on = !!st;
  return { embeds: [e], allowedMentions: NOPING, components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music:add').setLabel('Add music').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('music:pause').setLabel(st?.paused ? 'Resume' : 'Pause').setEmoji(st?.paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Secondary).setDisabled(!st?.current),
    new ButtonBuilder().setCustomId('music:skip').setLabel('Skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(!st?.current),
    new ButtonBuilder().setCustomId('music:stop').setLabel('Stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger).setDisabled(!on),
    new ButtonBuilder().setCustomId('music:queue').setLabel(st?.repeat && st.repeat !== 'off' ? `Queue · ${st.repeat === 'one' ? '🔂' : '🔁'}` : 'Queue').setEmoji('📜').setStyle(ButtonStyle.Secondary).setDisabled(!on))] };
}
async function refreshPlayer(ctx) {
  const st = states.get(ctx.guildId);
  const saved = ctx.data.get('player');
  if (!saved) return;
  const ch = ctx.guild?.channels.cache.get(saved.channelId);
  const msg = await ch?.messages?.fetch?.(saved.messageId).catch(() => null);
  await msg?.edit?.(playerPayload(ctx)).catch(() => {});
  void st;
}

// ------------------------------------------------------------------ the form
function addFields(ctx) {
  const stations = parseStations(ctx.config.get('stations'));
  const fields = [];
  fields.push(mediaOn(ctx)
    ? { id: 'link', kind: 'text', label: 'Paste a link', required: false, max: 300, placeholder: 'YouTube, Spotify song or playlist, SoundCloud, BandLab, or any audio link' }
    : { id: 'link', kind: 'text', label: 'Paste a link to an audio file', required: false, max: 300, placeholder: 'https://.../song.mp3' });
  if (process.env.JAMENDO_CLIENT_ID) fields.push({ id: 'search', kind: 'text', label: 'Search free music (Jamendo)', required: false, max: 100, placeholder: 'Song or artist, e.g. lofi' });
  if (stations.length) fields.push({ id: 'station', kind: 'select', label: 'Or a radio station', required: false, options: stations.map((s) => ({ label: s.name, value: s.id })) });
  if (ctx.config.get('allowUploads')) fields.push({ id: 'file', kind: 'files', label: 'Or upload a song', desc: 'MP3, OGG, WAV, FLAC or M4A, under 25 MB.', required: false, maxValues: 1 });
  return fields;
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
  } else if (v.link?.trim()) {
    const link = v.link.trim();
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
        if (ML.spotifyListId(link)) {
          if (!y) throw new UserError('Media links are on, but the yt-dlp program is missing. The bot owner can fix it with `/music` → Media links.');
          return addSpotifyList(ctx, i, st, base, await ML.spotifyList(link));
        }
        let input = link, credit = null, info = null, failed = null;
        if (ML.isSpotify(link)) {
          const sp = await ML.spotifyTrack(link);
          input = `ytsearch1:${sp.artist} ${sp.title} audio`;
          credit = `Spotify: “${sp.title}”${sp.artist ? ` by ${sp.artist}` : ''}, played from YouTube`;
        }
        if (y) info = await ML.lookup(y.bin, input, { spawnFn: spawnSeam() }).catch((e) => { failed = e; return null; });
        if (info) track = { ...base, source: 'media', title: info.title, artist: info.artist, seconds: info.seconds, page: info.page, site: info.site, credit };
        else {
          const p = input === link ? await probe() : null;
          if (p?.redirect && ML.isBandLab(p.redirect)) { const b = await ML.bandlabTrack(p.redirect); track = { ...base, source: 'link', title: b.title, artist: b.artist, seconds: b.seconds, url: b.url, page: b.page, site: 'BandLab', whole: true }; }
          else if (p?.url) track = fromPage(p);
          else if (failed) throw failed;
          else throw new UserError('Media links are on, but the yt-dlp program is missing. The bot owner can fix it with `/music` → Media links.');
        }
      }
    }
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

/** Queues a Spotify playlist or album: each song is found on YouTube when its turn comes. */
async function addSpotifyList(ctx, i, st, base, list) {
  const limits = { max: ctx.config.get('maxQueue'), perUser: ctx.config.get('maxPerMember') };
  let added = 0, stop = null;
  for (const t of list.tracks) {
    const track = { ...base, source: 'media', title: t.title, artist: t.artist, seconds: t.seconds, page: null, search: ML.spotifySearch(t), site: 'Spotify', credit: `From the Spotify ${list.kind} “${truncate(list.name, 80)}”, played from YouTube` };
    try { enqueue(st.queue, track, limits); added++; } catch (e) { stop = e.message; break; }
  }
  if (!added) throw new UserError(stop ?? 'Nothing on that playlist can be played.');
  if (!st.current) await next(ctx, st); else await refreshPlayer(ctx);
  const left = list.tracks.length - added;
  return i.editReply({ content: `🎶 Added **${added}** song${added === 1 ? '' : 's'} from **${truncate(list.name, 80)}**.${left ? `\n-# ${left} more didn't fit: ${stop} Staff can raise the limits in the music settings.` : ''}${list.tracks.length >= 100 ? '\n-# Spotify only shares the first 100 songs of a playlist.' : ''}` });
}

async function onButton(ctx, i) {
  const action = i.customId.split(':')[1];
  if (action === 'form') return onAddSubmit(ctx, i);
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
  if (!canControl({ member: i.member, track: st.current, djRole: ctx.config.get('djRole'), listeners: listenersOf(ctx, st) })) throw new UserError('Only the person who added this song, the DJ role or staff can do that while others are listening.');
  if (action === 'pause') { if (st.paused) st.player.unpause(); else st.player.pause(); st.paused = !st.paused; }
  if (action === 'skip') { st.paused = false; st.skipping = true; st.player.stop(true); }
  if (action === 'stop') { cleanup(ctx.guildId); }
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
  if (action === 'queue') return i.reply({ ...queuePayload(ctx, st), flags: EPH });
  if (action === 'qpage') return i.update(queuePayload(ctx, st, Number(parts[2]) || 0));
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
  if (action === 'qdel') { const t = st.queue.find((x) => x.uid === parts[2]); if (t && t.by !== i.user.id && !isDJ(ctx, i.member)) throw new UserError('You can only remove your own songs.'); const gone = removeTrack(st.queue, parts[2]); if (gone?.file) fs.rm(gone.file, { force: true }, () => {}); }
  if (action === 'qshuffle') { if (!isDJ(ctx, i.member) && listenersOf(ctx, st) > 1) throw new UserError('Only the DJ role or staff can shuffle while others are listening.'); shuffle(st.queue); }
  if (action === 'qrepeat') { if (!isDJ(ctx, i.member) && listenersOf(ctx, st) > 1) throw new UserError('Only the DJ role or staff can change repeat while others are listening.'); st.repeat = REPEAT_NEXT[st.repeat ?? 'off']; }
  await refreshPlayer(ctx);
  if (action === 'qtop' || action === 'qdel') return i.update({ content: action === 'qtop' ? '⏫ It plays next.' : '🗑️ Removed.', components: [] });
  return i.update(queuePayload(ctx, st));
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

export default {
  name: 'music',
  version: '1.1.0',
  description: 'Music in voice: member uploads, audio links, radio stations you choose and free Creative Commons music, with a shared player. YouTube and Spotify links are an opt-in the bot owner can turn on.',
  settings: [
    { key: 'allowUploads', type: 'toggle', label: 'Members can upload songs to play', default: true },
    { key: 'stations', type: 'list', label: 'Radio stations (Name | stream link). Only add stations that allow it.' },
    { key: 'djRole', type: 'role', label: 'DJ role: can skip and stop anyone\'s songs' },
    { key: 'volume', type: 'number', label: 'Volume (%)', default: 70, min: 10, max: 100 },
    { key: 'maxQueue', type: 'number', label: 'Most songs in the queue', default: 50, min: 5, max: 200 },
    { key: 'maxPerMember', type: 'number', label: 'Most songs one member can queue', default: 10, min: 1, max: 50 },
    { key: 'idleMinutes', type: 'number', label: 'Leave voice after this many minutes with nothing playing', default: 5, min: 1, max: 60 },
  ],
  permissions: [{ key: 'music.player', label: 'Post the music player', default: 'moderator' }],
  commands: [{
    permission: 'music.player', defer: false,
    data: new SlashCommandBuilder().setName('music').setDescription('Post the music player in this channel'),
    execute: musicCommand,
  }],
  components: [{ prefix: 'music:', execute: onButton }],
  async destroy(ctx) { cleanup(ctx.guildId); },
};
