/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Text-to-speech in voice channels with a queue (messages never overlap), auto-leave,
 * per-member voice/language choice, playback controls and a diagnostic command.
 *
 * Why speech used to fail silently: errors were only logged. Now every stage reports to chat
 * (the same message that says "queued" is edited to show the problem), and /tts diagnose tests each stage.
 *
 * Speech providers:
 *   windows - Windows' built-in offline voices (System.Speech). Default on Windows. Needs no internet and
 *             no ffmpeg: it produces raw 48 kHz audio that Discord can use directly.
 *   google  - the unofficial Google Translate speech endpoint (google-tts-api). Needs internet and ffmpeg;
 *             Google can rate-limit or change it at any time.
 *
 * Voice libraries load lazily: if they are missing, only enabling this module fails (with a clear message).
 */
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits as P, MessageFlags } from 'discord.js';
import { UserError, truncate } from '../../src/util.js';

const EPH = MessageFlags.Ephemeral;
const NOPING = { parse: [] };
const LANGS = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ja', 'ko', 'zh-CN', 'hi', 'ar', 'nl', 'pl', 'tr', 'sv', 'da', 'fi', 'cs', 'el', 'id', 'th', 'vi', 'uk', 'ro'];
const MAX_QUEUE = 20, MAX_PER_USER = 5;

// ------------------------------------------------------------------ pure helpers (unit-tested)
/** Extracts raw PCM from a RIFF/WAVE buffer. Throws if it isn't PCM. */
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12, fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === 'data') {
      if (!fmt) throw new Error('WAV has no format header');
      if (fmt.format !== 1) throw new Error(`WAV is not PCM (format ${fmt.format})`);
      if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body; // streamed files leave the size unset
      return { ...fmt, pcm: buf.subarray(body, body + size) };
    }
    off = body + size + (size % 2);
  }
  throw new Error('WAV has no audio data');
}

/** Text that is safe and pleasant to speak: no links, mentions, markdown, or custom-emoji ids. */
export const cleanForSpeech = (s) => String(s)
  .replace(/https?:\/\/\S+/gi, ' link ')
  .replace(/<a?:(\w+):\d+>/g, ' $1 ')
  .replace(/<[@#&!]+\d+>/g, ' ')
  .replace(/[*_~`|>]/g, '')
  .replace(/\s+/g, ' ').trim();

export function chooseProvider(setting, platform = process.platform) {
  if (setting === 'windows' || setting === 'google') return setting;
  return platform === 'win32' ? 'windows' : 'google';
}

// The text is passed through environment variables, never spliced into the script, so it cannot inject commands.
export const PS_SPEAK = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  'if ($env:GB_TTS_VOICE) { try { $s.SelectVoice($env:GB_TTS_VOICE) } catch {} }',
  '$s.Rate = [int]$env:GB_TTS_RATE',
  '$s.Volume = 100',
  '$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Stereo)',
  '$s.SetOutputToWaveFile($env:GB_TTS_OUT, $f)',
  '$s.Speak($env:GB_TTS_TEXT)',
  '$s.Dispose()',
].join('; ');
export const PS_VOICES = 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }';

function runPowerShell(script, env, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { env: { ...process.env, ...env }, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Windows speech timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`could not start PowerShell: ${e.message}`)); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`Windows speech failed: ${truncate(err.trim() || `exit ${code}`, 200)}`)); });
  });
}

let voiceCache = null;
async function windowsVoices() {
  if (voiceCache) return voiceCache;
  try { voiceCache = (await runPowerShell(PS_VOICES, {}, 15000)).split(/\r?\n/).map((v) => v.trim()).filter(Boolean); }
  catch { voiceCache = []; }
  return voiceCache;
}

async function synthWindows(text, { voice, rate }) {
  const file = path.join(os.tmpdir(), `goodboy-tts-${crypto.randomBytes(6).toString('hex')}.wav`);
  try {
    await runPowerShell(PS_SPEAK, { GB_TTS_TEXT: text, GB_TTS_OUT: file, GB_TTS_VOICE: voice ?? '', GB_TTS_RATE: String(rate ?? 0) });
    const wav = await fs.readFile(file);
    const { pcm, rate: hz, channels, bits } = parseWav(wav);
    if (hz === 48000 && channels === 2 && bits === 16) return { kind: 'raw', data: pcm };
    return { kind: 'file', data: wav }; // unusual format: let ffmpeg convert it
  } finally { fs.rm(file, { force: true }).catch(() => {}); }
}

// ------------------------------------------------------------------ library loading
let lib = null;
async function load() {
  lib ??= globalThis[Symbol.for('goodboy.voice.lib')] ?? null; // test seam: tests supply a stand-in for the voice libraries
  if (lib) return lib;
  try {
    const voice = await import('@discordjs/voice');
    await import('@snazzah/davey').catch(() => {}); // Discord's mandatory E2EE voice protocol (DAVE)
    const ff = await import('ffmpeg-static').then((m) => m.default ?? m).catch(() => null);
    if (ff && !process.env.FFMPEG_PATH) process.env.FFMPEG_PATH = ff;
    const ttsMod = await import('google-tts-api').catch(() => null);
    lib = { voice, tts: ttsMod ? (ttsMod.default ?? ttsMod) : null };
    return lib;
  } catch (e) {
    throw new UserError('Voice support is not installed on this bot. On the PC running it: `npm install`, then restart. ' +
      `(Needs @discordjs/voice, @snazzah/davey and opusscript. Details: ${truncate(e.message, 120)})`);
  }
}

async function synthGoogle(text, lang, slow) {
  if (!lib?.tts) throw new Error('google-tts-api is not installed');
  const urls = lib.tts.getAllAudioUrls(text, { lang, slow, host: 'https://translate.google.com', splitPunct: ',.?!;:' });
  const parts = [];
  for (const u of urls) {
    const res = await fetch(u.url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Google's speech service answered ${res.status}`);
    parts.push(Buffer.from(await res.arrayBuffer()));
  }
  return { kind: 'file', data: Buffer.concat(parts) };
}

/** Produces audio with the configured provider, falling back to the other one if the first fails. */
async function synthesize(ctx, item) {
  const first = chooseProvider(ctx.config.get('ttsProvider'));
  const order = first === 'windows' ? ['windows', 'google'] : ['google', 'windows'];
  let lastError;
  for (const provider of order) {
    if (provider === 'windows' && process.platform !== 'win32') continue;
    try {
      if (provider === 'windows') return { provider, ...(await synthWindows(item.text, { voice: item.voice, rate: ctx.config.get('ttsRate') })) };
      return { provider, ...(await synthGoogle(item.text, item.lang, ctx.config.get('ttsSlow'))) };
    } catch (e) { lastError = e; ctx.log.warn(`TTS provider ${provider} failed: ${e.message}`); }
  }
  throw lastError ?? new Error('no speech provider is available on this system');
}

// ------------------------------------------------------------------ playback
// guildId -> state. Kept on a global so a reloaded copy of this module still sees (and can close) open connections.
const states = (globalThis[Symbol.for('goodboy.voice.states')] ??= new Map());

function cleanup(guildId) {
  const st = states.get(guildId);
  if (!st) return;
  clearTimeout(st.idleTimer); clearTimeout(st.aloneTimer);
  try { st.player.stop(true); } catch { /* ignore */ }
  try { if (st.connection.state.status !== 'destroyed') st.connection.destroy(); } catch { /* ignore */ }
  states.delete(guildId);
}

function armIdle(ctx, st) {
  clearTimeout(st.idleTimer);
  st.idleTimer = setTimeout(() => { ctx.log.info('TTS idle - leaving voice'); cleanup(ctx.guildId); }, ctx.config.get('autoLeaveMinutes') * 60000);
  st.idleTimer.unref?.();
}

/** Shows the problem in chat by editing the member's own reply, so failures are never silent. */
async function report(item, text) {
  await item?.reply?.(`⚠️ ${truncate(text, 300)}`).catch(() => {});
}

async function pump(ctx, st) {
  if (st.busy) return;
  st.busy = true;
  try {
    while (st.queue.length && st.player.state.status === lib.voice.AudioPlayerStatus.Idle) {
      const item = st.queue.shift();
      st.current = item;
      try {
        const audio = await synthesize(ctx, item);
        if (!audio.data?.length) throw new Error('the speech engine produced no audio');
        const resource = lib.voice.createAudioResource(Readable.from(audio.data), { inputType: audio.kind === 'raw' ? lib.voice.StreamType.Raw : lib.voice.StreamType.Arbitrary, inlineVolume: true });
        resource.volume?.setVolume(ctx.config.get('ttsVolume') / 100);
        st.player.play(resource);
        await item.reply?.(`🔊 Speaking: ${truncate(item.text, 150)}`).catch(() => {});
        break; // wait for Idle to continue
      } catch (e) {
        ctx.log.warn(`TTS item failed: ${e.message}`);
        await report(item, `I couldn't speak that: ${e.message}. An admin can run \`/tts diagnose\`.`);
        st.current = null;
      }
    }
    if (!st.queue.length && st.player.state.status === lib.voice.AudioPlayerStatus.Idle) { st.current = null; armIdle(ctx, st); }
  } finally { st.busy = false; }
}

async function ensureConnected(ctx, i, { create }) {
  const { voice } = await load();
  const vc = i.member.voice?.channel;
  let st = states.get(ctx.guildId);
  if (st) {
    if (!vc || vc.id !== st.channelId) throw new UserError(`Join <#${st.channelId}> to use TTS with me.`);
    return st;
  }
  if (!create) throw new UserError("I'm not in a voice channel.");
  if (!vc) throw new UserError('Join a voice channel first.');
  const perms = vc.permissionsFor(i.guild.members.me);
  if (!perms?.has(P.Connect) || !perms.has(P.Speak) || (vc.full && !perms.has(P.MoveMembers))) throw new UserError("I can't join or speak in that channel (I need Connect and Speak).");

  const connection = voice.joinVoiceChannel({ channelId: vc.id, guildId: ctx.guildId, adapterCreator: i.guild.voiceAdapterCreator, selfDeaf: true });
  try { await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, 15000); }
  catch { connection.destroy(); throw new UserError("I couldn't connect to voice in time. Run `/tts diagnose` - an outdated voice library (no DAVE encryption) is the usual cause."); }

  const player = voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause } });
  connection.subscribe(player);
  st = { connection, player, channelId: vc.id, queue: [], current: null, busy: false };
  states.set(ctx.guildId, st);
  player.on(voice.AudioPlayerStatus.Idle, () => { st.current?.reply?.(`✅ ${truncate(st.current.text, 150)}`).catch(() => {}); pump(ctx, st).catch(() => {}); });
  player.on('error', (e) => { ctx.log.warn(`Audio player error: ${e.message}`); report(st.current, `Playback failed: ${e.message}. Run \`/tts diagnose\`.`); });
  connection.on(voice.VoiceConnectionStatus.Disconnected, async () => {
    try { await Promise.race([voice.entersState(connection, voice.VoiceConnectionStatus.Signalling, 5000), voice.entersState(connection, voice.VoiceConnectionStatus.Connecting, 5000)]); }
    catch { cleanup(ctx.guildId); }
  });
  armIdle(ctx, st);
  return st;
}

const lastSay = new Map();

async function say(ctx, i) {
  const text = cleanForSpeech(i.options.getString('text', true)).slice(0, ctx.config.get('maxChars'));
  if (!text) throw new UserError('There is nothing speakable in that.');
  const wait = ctx.config.get('userCooldownSeconds') * 1000;
  const key = `${ctx.guildId}:${i.user.id}`;
  if (Date.now() - (lastSay.get(key) ?? 0) < wait) throw new UserError('One moment between TTS messages.');
  const echo = ctx.config.get('ttsEcho');
  await i.deferReply(echo ? {} : { flags: EPH });
  const st = await ensureConnected(ctx, i, { create: true });
  if (st.queue.length >= MAX_QUEUE) throw new UserError('The TTS queue is full - try again in a moment.');
  if (st.queue.filter((q) => q.by === i.user.id).length >= MAX_PER_USER) throw new UserError(`You can have ${MAX_PER_USER} messages waiting at once.`);
  lastSay.set(key, Date.now());
  const pref = ctx.data.get(`pref:${i.user.id}`) ?? {};
  st.queue.push({
    text, by: i.user.id, lang: pref.lang ?? ctx.config.get('ttsLanguage'), voice: pref.voice ?? (ctx.config.get('ttsVoice') || undefined),
    reply: (content) => i.editReply({ content: `<@${i.user.id}> ${content}`.slice(0, 1900), allowedMentions: NOPING }),
  });
  clearTimeout(st.idleTimer);
  await i.editReply({ content: `🔊 <@${i.user.id}> queued (${st.queue.length + (st.current ? 1 : 0)} in line): ${truncate(text, 150)}`, allowedMentions: NOPING });
  pump(ctx, st).catch((e) => ctx.log.warn(`pump: ${e.message}`));
}

// ------------------------------------------------------------------ "no mic" reading
// A text channel whose messages are read aloud while the bot is in a voice channel: for people who are in voice
// but can't (or don't want to) talk. Nobody types a command; the bot says "Name says <message>".
/** Test seam: a test can replace `pump` (the real one needs the voice libraries and a live connection). */
export const hooks = (globalThis[Symbol.for('goodboy.voice.hooks')] ??= {});
const runPump = (ctx, st) => (hooks.pump ?? pump)(ctx, st);

const CODE_PREFIXES = (ctx) => String(ctx.config.get('noMicSkipPrefixes') ?? '').split(/\s+/).filter(Boolean);

/** Looks like a command for another bot ("!play x", "/help")? A prefix followed by a letter or digit; "..." and "!!" are just words. */
export function looksLikeCommand(text, prefixes) {
  const t = text.trim();
  return prefixes.some((p) => t.startsWith(p) && /[\p{L}\p{N}]/u.test(t.charAt(p.length) || ' '));
}

/** What to say for a message in the no-mic channel, or why it is skipped. Pure apart from reading settings. */
export function noMicPlan(ctx, message, st) {
  if (!st) return { skip: 'not-in-voice' };
  if (message.author?.bot || message.webhookId || message.system) return { skip: 'bot' };
  if (ctx.data.get(`pref:${message.author.id}`)?.noMic === false) return { skip: 'opted-out' };
  if (ctx.config.get('noMicRequireVoice') && message.member?.voice?.channelId !== st.channelId) return { skip: 'not-in-same-voice' };
  const raw = String(message.cleanContent ?? message.content ?? '');
  if (looksLikeCommand(raw, CODE_PREFIXES(ctx))) return { skip: 'command' };
  const text = cleanForSpeech(raw.replace(/@/g, '')).slice(0, ctx.config.get('maxChars'));
  if (!/[\p{L}\p{N}]/u.test(text)) return { skip: 'nothing-to-say' };
  const who = cleanForSpeech(message.member?.displayName ?? message.author.globalName ?? message.author.username).slice(0, 40);
  const spoken = ctx.config.get('noMicAnnounceName') && who ? `${who} says ${text}` : text;
  return { text: spoken, who };
}

async function onNoMicMessage(ctx, message) {
  if (!message.guild || message.channelId !== ctx.config.get('noMicChannel')) return;
  const plan = noMicPlan(ctx, message, states.get(ctx.guildId));
  if (plan.skip) return;
  const st = states.get(ctx.guildId);
  const key = `${ctx.guildId}:${message.author.id}`;
  if (Date.now() - (lastSay.get(key) ?? 0) < ctx.config.get('userCooldownSeconds') * 1000) return;
  if (st.queue.length >= MAX_QUEUE || st.queue.filter((q) => q.by === message.author.id).length >= MAX_PER_USER) return;
  lastSay.set(key, Date.now());
  const pref = ctx.data.get(`pref:${message.author.id}`) ?? {};
  st.queue.push({
    text: plan.text, by: message.author.id, lang: pref.lang ?? ctx.config.get('ttsLanguage'), voice: pref.voice ?? (ctx.config.get('ttsVoice') || undefined),
    // no chat echo here (the channel is for reading); a problem shows as a ⚠️ on the member's own message
    reply: async (content) => { if (String(content).startsWith('⚠️')) await message.react('⚠️'); },
  });
  clearTimeout(st.idleTimer);
  runPump(ctx, st).catch((e) => ctx.log.warn(`pump: ${e.message}`));
}

async function setupNoMic(ctx, i) {
  if (!ctx.perms.check(i.member, 'voice.control')) throw new UserError('You need the `voice.control` permission for that.');
  const picked = i.options.getChannel('channel', true);
  const ch = i.guild.channels.cache.get(picked.id) ?? picked;
  if (!ch.isTextBased?.() || !ch.messages) throw new UserError('Pick a text channel.');
  const perms = ch.permissionsFor?.(i.guild.members.me);
  const missing = ['ViewChannel', 'ReadMessageHistory'].filter((n) => !perms?.has(P[n]));
  if (missing.length) throw new UserError(`I'm missing **${missing.join(', ')}** in <#${ch.id}>.`);
  await ctx.settings.set('noMicChannel', ch.id);
  const note = ctx.hasIntent('MessageContent') ? '' : '\n⚠️ I can\'t read message text yet: turn on **Message Content Intent** in the Developer Portal (Bot > Privileged Gateway Intents) and restart me.';
  return i.reply({ content: `Messages typed in <#${ch.id}> will be read aloud while I'm in a voice channel. Use \`/tts join\` from a voice channel to start.${note}`, flags: EPH });
}

async function readingPref(ctx, i) {
  const on = i.options.getBoolean('enabled', true);
  const pref = { ...(ctx.data.get(`pref:${i.user.id}`) ?? {}), noMic: on };
  ctx.data.set(`pref:${i.user.id}`, pref);
  return i.reply({ content: on ? 'Your messages in the no-mic channel will be read aloud.' : 'Your messages will no longer be read aloud.', flags: EPH });
}

async function diagnose(ctx, i) {
  if (!ctx.perms.check(i.member, 'voice.control')) throw new UserError('You need the `voice.control` permission for that.');
  await i.deferReply({ flags: EPH });
  const lines = [];
  try { await load(); lines.push('✅ voice libraries loaded'); } catch (e) { return i.editReply({ content: `❌ ${e.message}` }); }
  try { lines.push(`\`\`\`\n${truncate(lib.voice.generateDependencyReport(), 1100)}\n\`\`\``); } catch { /* optional */ }
  const provider = chooseProvider(ctx.config.get('ttsProvider'));
  lines.push(`Provider: **${provider}** (setting: ${ctx.config.get('ttsProvider')}, platform: ${process.platform})`);
  if (process.platform === 'win32') { const v = await windowsVoices(); lines.push(v.length ? `Windows voices: ${truncate(v.join(', '), 300)}` : '⚠️ no Windows voices found (or PowerShell is blocked)'); }
  const t0 = Date.now();
  try { const a = await synthesize(ctx, { text: 'Testing one two three.', lang: ctx.config.get('ttsLanguage'), voice: ctx.config.get('ttsVoice') || undefined }); lines.push(`✅ speech test OK via **${a.provider}**: ${a.data.length} bytes in ${Date.now() - t0} ms (${a.kind})`); }
  catch (e) { lines.push(`❌ speech test FAILED: ${e.message}`); }
  const st = states.get(ctx.guildId);
  lines.push(st ? `Connection: ${st.connection.state.status}, queue ${st.queue.length}` : 'Not connected to a voice channel right now.');
  lines.push(`FFmpeg: ${process.env.FFMPEG_PATH ? 'bundled/ configured' : 'not configured (only needed for the google provider)'}`);
  await i.editReply({ content: lines.join('\n') });
}

async function control(ctx, i) {
  const sub = i.options.getSubcommand();
  const st = states.get(ctx.guildId);
  if (sub === 'queue') {
    if (!st || (!st.current && !st.queue.length)) return i.reply({ content: 'The queue is empty.', flags: EPH });
    const rows = [st.current && `▶️ <@${st.current.by}>: ${truncate(st.current.text, 60)}`, ...st.queue.map((q, n) => `${n + 1}. <@${q.by}>: ${truncate(q.text, 60)}`)].filter(Boolean);
    return i.reply({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('TTS queue').setDescription(rows.join('\n'))], flags: EPH, allowedMentions: NOPING });
  }
  if (sub === 'join') {
    await i.deferReply({ flags: EPH });
    const s = await ensureConnected(ctx, i, { create: true });
    const nm = ctx.config.get('noMicChannel');
    const reading = nm ? `Anything typed in <#${nm}> is now read aloud - no command needed.${ctx.hasIntent('MessageContent') ? '' : ' ⚠️ But I can\'t read message text until **Message Content Intent** is on in the Developer Portal.'}` : 'Use `/tts say`, or set a no-mic channel with `/tts setup`.';
    return i.editReply({ content: `Joined <#${s.channelId}>. ${reading}` });
  }
  if (!st) throw new UserError("I'm not in a voice channel.");
  const mayControl = ctx.perms.check(i.member, 'voice.control');
  if (sub === 'skip') {
    if (!mayControl && st.current?.by !== i.user.id) throw new UserError('Only the person who queued it (or a moderator) can skip.');
    st.player.stop(true);
    return i.reply({ content: '⏭️ Skipped.', flags: EPH });
  }
  if (!mayControl) throw new UserError('You need the `voice.control` permission for that.');
  if (sub === 'stop') { st.queue.length = 0; st.player.stop(true); return i.reply({ content: '⏹️ Cleared the queue.', flags: EPH }); }
  if (sub === 'leave') { cleanup(ctx.guildId); return i.reply({ content: '👋 Left the voice channel.', flags: EPH }); }
}

export default {
  name: 'voice',
  version: '1.2.0',
  description: 'Text-to-speech in voice channels with a queue, offline Windows voices, auto-leave and diagnostics.',
  settings: [
    { key: 'ttsProvider', type: 'select', label: 'Speech provider', description: 'auto = Windows voices on Windows, Google elsewhere', options: ['auto', 'windows', 'google'], default: 'auto' },
    { key: 'ttsVoice', type: 'text', label: 'Default Windows voice name (see /tts voices)', maxLength: 100 },
    { key: 'ttsLanguage', type: 'select', label: 'Default language (Google provider)', options: LANGS, default: 'en' },
    { key: 'ttsRate', type: 'number', label: 'Speaking speed (-10 slow ... 10 fast, Windows)', default: 0, min: -10, max: 10 },
    { key: 'ttsVolume', type: 'number', label: 'Volume (%)', default: 100, min: 10, max: 100 },
    { key: 'ttsSlow', type: 'toggle', label: 'Speak slowly (Google)', default: false },
    { key: 'ttsEcho', type: 'toggle', label: 'Show what is being spoken in chat', default: true },
    { key: 'noMicChannel', type: 'channel', label: 'No-mic channel: messages typed here are read aloud', description: 'Empty = off. The bot must be in a voice channel (use /tts join).' },
    { key: 'noMicAnnounceName', type: 'toggle', label: 'No-mic: say who wrote each message ("Alex says ...")', default: true },
    { key: 'noMicRequireVoice', type: 'toggle', label: 'No-mic: only read members who are in the bot\'s voice channel', default: true },
    { key: 'noMicSkipPrefixes', type: 'text', label: 'No-mic: do not read messages that start like a bot command', description: 'Separate with spaces. "!play" is skipped; "..." is not.', default: '! / . ? $ ; ~ -', maxLength: 60 },
    { key: 'maxChars', type: 'number', label: 'Max characters per message', default: 300, min: 20, max: 1000 },
    { key: 'userCooldownSeconds', type: 'number', label: 'Seconds between a member\'s TTS messages', default: 3, min: 0, max: 600 },
    { key: 'autoLeaveMinutes', type: 'number', label: 'Leave after N idle minutes', default: 5, min: 1, max: 60 },
  ],
  permissions: [
    { key: 'voice.use', label: 'Use TTS', default: 'everyone' },
    { key: 'voice.control', label: 'Stop, skip anyone\'s message, make the bot leave, run diagnostics', default: 'moderator' },
  ],
  commands: [{
    permission: 'voice.use',
    data: new SlashCommandBuilder().setName('tts').setDescription('Text-to-speech in your voice channel')
      .addSubcommand((s) => s.setName('say').setDescription('Speak a message').addStringOption((o) => o.setName('text').setDescription('What to say').setRequired(true).setMaxLength(1000)))
      .addSubcommand((s) => s.setName('join').setDescription('Make me join your voice channel'))
      .addSubcommand((s) => s.setName('leave').setDescription('Make me leave'))
      .addSubcommand((s) => s.setName('skip').setDescription('Skip the current message'))
      .addSubcommand((s) => s.setName('stop').setDescription('Stop and clear the queue'))
      .addSubcommand((s) => s.setName('queue').setDescription('Show what is waiting'))
      .addSubcommand((s) => s.setName('voices').setDescription('List the voices installed on the bot\'s PC (Windows)'))
      .addSubcommand((s) => s.setName('voice').setDescription('Pick your own voice or language')
        .addStringOption((o) => o.setName('language').setDescription('Language (Google provider)').addChoices(...LANGS.map((l) => ({ name: l, value: l }))))
        .addStringOption((o) => o.setName('name').setDescription('Windows voice name from /tts voices').setMaxLength(100)))
      .addSubcommand((s) => s.setName('setup').setDescription('(Staff) Choose the no-mic channel whose messages are read aloud')
        .addChannelOption((o) => o.setName('channel').setDescription('Text channel').setRequired(true)))
      .addSubcommand((s) => s.setName('reading').setDescription('Choose whether your messages in the no-mic channel are read aloud')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)))
      .addSubcommand((s) => s.setName('diagnose').setDescription('Test every step of text-to-speech and show what is wrong')),
    async execute(ctx, i) {
      const sub = i.options.getSubcommand();
      if (sub === 'say') return say(ctx, i);
      if (sub === 'diagnose') return diagnose(ctx, i);
      if (sub === 'setup') return setupNoMic(ctx, i);
      if (sub === 'reading') return readingPref(ctx, i);
      if (sub === 'voices') {
        await i.deferReply({ flags: EPH });
        if (process.platform !== 'win32') return i.editReply({ content: 'Named voices are only available when the bot runs on Windows. Use `/tts voice language:…` instead.' });
        const v = await windowsVoices();
        return i.editReply({ content: v.length ? `Installed voices:\n${v.map((n) => `- ${n}`).join('\n')}\nPick one with \`/tts voice name:…\`.` : 'No voices found. Windows may have speech disabled.' });
      }
      if (sub === 'voice') {
        const lang = i.options.getString('language'), name = i.options.getString('name');
        if (!lang && !name) throw new UserError('Choose a language or a voice name.');
        const pref = { ...(ctx.data.get(`pref:${i.user.id}`) ?? {}) };
        if (lang) pref.lang = lang;
        if (name) {
          if (process.platform === 'win32') {
            const found = (await windowsVoices()).find((v) => v.toLowerCase() === name.trim().toLowerCase());
            if (!found) throw new UserError('That voice is not installed. See `/tts voices`.');
            pref.voice = found;
          } else pref.voice = name.trim();
        }
        ctx.data.set(`pref:${i.user.id}`, pref);
        return i.reply({ content: `Saved. Your TTS: ${pref.voice ? `voice **${pref.voice}**` : ''} ${pref.lang ? `language **${pref.lang}**` : ''}`.trim(), flags: EPH });
      }
      return control(ctx, i);
    },
  }],
  events: {
    messageCreate: onNoMicMessage,
    voiceStateUpdate: async (ctx, oldS, newS) => {
      const st = states.get(ctx.guildId);
      if (!st || (oldS.channelId !== st.channelId && newS.channelId !== st.channelId)) return;
      const ch = ctx.guild.channels.cache.get(st.channelId);
      const humans = ch?.members?.filter((m) => !m.user.bot).size ?? 0;
      clearTimeout(st.aloneTimer);
      if (!humans) { st.aloneTimer = setTimeout(() => cleanup(ctx.guildId), 30000); st.aloneTimer.unref?.(); }
    },
  },
  tasks: [{ name: 'cleanup', everyMs: 600000, async run() { const now = Date.now(); for (const [k, v] of lastSay) if (now - v > 60000) lastSay.delete(k); } }],
  async init() { await load(); },
  async destroy(ctx) { cleanup(ctx.guildId); },
};
