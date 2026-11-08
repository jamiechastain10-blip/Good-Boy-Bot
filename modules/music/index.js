/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Music in voice channels, from sources that are allowed to be played:
 *   uploads   members upload a song in the form (MP3, OGG, WAV, FLAC, M4A). Good Boy keeps it until it has played.
 *   radio     stations an admin adds (Name | stream link). Only add stations that allow being relayed.
 *   Jamendo   free, Creative Commons music, if the bot owner sets JAMENDO_CLIENT_ID (free key from developer.jamendo.com).
 *             Each song shows its artist and licence, as Jamendo asks.
 *   links     direct links to audio files always work. Links from YouTube, Spotify, SoundCloud and other sites only work
 *             if the bot owner turns on "media links" (3.0.6, off by default): those sites' terms forbid playing their
 *             audio in a bot, so the owner sees a warning and decides. See src/medialinks.js.
 *
 * One command, /music, posts the player in the channel. Everything else is buttons and one form, so nothing is typed
 * into a command box. Voice libraries load lazily; the queue rules below are plain functions so they are tested alone.
 */
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits as P } from 'discord.js';
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
  queue.push(track);
  return queue.length;
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
const mediaOn = (ctx) => ctx.data.get('mediaLinks')?.on === true;
const ytdlp = (ctx) => ML.findYtDlp(ctx.botDir ? ctx.botDir('tools') : null, { spawnFn: globalThis[Symbol.for('goodboy.music.spawn')] });
const spawnSeam = () => globalThis[Symbol.for('goodboy.music.spawn')];
const MEDIA_WARNING = [
  '**Turn on media links?**',
  'Members will be able to paste links from **YouTube, Spotify, SoundCloud** and most other sites, and Good Boy plays them in voice.',
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
    lib = { voice };
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
  st.stopStream?.();
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
  player.on(voice.AudioPlayerStatus.Idle, () => { st.stopStream?.(); st.stopStream = null; if (st.current?.file) fs.rm(st.current.file, { force: true }, () => {}); st.current = null; next(ctx, st).catch(() => {}); });
  player.on('error', (e) => { ctx.log.warn(`Music player error: ${e.message}`); });
  connection.on(voice.VoiceConnectionStatus.Disconnected, async () => {
    try { await Promise.race([voice.entersState(connection, voice.VoiceConnectionStatus.Signalling, 5000), voice.entersState(connection, voice.VoiceConnectionStatus.Connecting, 5000)]); }
    catch { cleanup(ctx.guildId); refreshPlayer(ctx).catch(() => {}); }
  });
  return st;
}
async function next(ctx, st) {
  const { voice } = await load();
  const track = st.queue.shift();
  if (!track) { st.current = null; armIdle(ctx, st); return refreshPlayer(ctx); }
  clearTimeout(st.idleTimer);
  st.current = track;
  try {
    let input;
    if (track.file) input = fs.createReadStream(track.file);
    else if (track.source === 'media') {
      if (!mediaOn(ctx)) throw new Error('media links were turned off');
      const y = await ytdlp(ctx);
      if (!y) throw new Error('yt-dlp is missing');
      const s2 = ML.stream(y.bin, track.page, { spawnFn: spawnSeam() });
      st.stopStream = s2.stop; input = s2.stream;
    } else {
      const r = await fetch(track.url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok || !r.body) throw new Error(`the source answered ${r.status}`);
      input = Readable.fromWeb(r.body);
    }
    const resource = voice.createAudioResource(input, { inputType: voice.StreamType.Arbitrary, inlineVolume: true });
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
  e.setFooter({ text: mediaOn(ctx) ? 'Paste a link (YouTube, Spotify, SoundCloud and more), upload a song, or pick a station.' : 'Uploads, audio links, radio stations and Creative Commons music from Jamendo.' });
  const on = !!st;
  return { embeds: [e], allowedMentions: NOPING, components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music:add').setLabel('Add music').setEmoji('➕').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('music:pause').setLabel(st?.paused ? 'Resume' : 'Pause').setEmoji(st?.paused ? '▶️' : '⏸️').setStyle(ButtonStyle.Secondary).setDisabled(!st?.current),
    new ButtonBuilder().setCustomId('music:skip').setLabel('Skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(!st?.current),
    new ButtonBuilder().setCustomId('music:stop').setLabel('Stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger).setDisabled(!on))] };
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
    ? { id: 'link', kind: 'text', label: 'Paste a link', required: false, max: 300, placeholder: 'YouTube, Spotify song, SoundCloud, or an .mp3 link' }
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
    else if (!mediaOn(ctx)) throw new UserError('Links from YouTube, Spotify and similar sites are turned off on this bot (their terms forbid it). The bot owner can turn them on with `/music`. Links straight to an audio file, like .mp3, always work.');
    else {
      const y = await ytdlp(ctx);
      if (!y) throw new UserError('Media links are on, but the yt-dlp program is missing. The bot owner can fix it with `/music` → Media links.');
      let input = link, credit = null;
      if (ML.isSpotify(link)) {
        const sp = await ML.spotifyTrack(link);
        input = `ytsearch1:${sp.artist} ${sp.title} audio`;
        credit = `Spotify: “${sp.title}”${sp.artist ? ` by ${sp.artist}` : ''}, played from YouTube`;
      }
      const info = await ML.lookup(y.bin, input, { spawnFn: spawnSeam() });
      track = { ...base, source: 'media', title: info.title, artist: info.artist, seconds: info.seconds, page: info.page, site: info.site, credit };
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
  const st = states.get(ctx.guildId);
  if (!st) throw new UserError('Nothing is playing.');
  if (i.member.voice?.channel?.id !== st.channelId) throw new UserError(`Join <#${st.channelId}> to control the music.`);
  if (!canControl({ member: i.member, track: st.current, djRole: ctx.config.get('djRole'), listeners: listenersOf(ctx, st) })) throw new UserError('Only the person who added this song, the DJ role or staff can do that while others are listening.');
  if (action === 'pause') { if (st.paused) st.player.unpause(); else st.player.pause(); st.paused = !st.paused; }
  if (action === 'skip') { st.paused = false; st.player.stop(true); }
  if (action === 'stop') { cleanup(ctx.guildId); }
  return i.update(playerPayload(ctx));
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
