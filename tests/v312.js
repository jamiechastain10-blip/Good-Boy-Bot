/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * 3.1.2 tests: music volume, the dashboard music player, and playlists. Voice is a fake (no Discord, no ffmpeg).
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

const tick = () => new Promise((r) => setImmediate(r));
/** Jamendo search answers from `songs`, and each song's address downloads as a small file (with its size, like a real file). */
const stubFetch = (songs, hits = []) => async (u) => {
  const url = new URL(u);
  if (url.hostname === 'jam.example') { hits.push(url.pathname); return new Response(new Uint8Array(2048), { headers: { 'content-length': '2048', 'content-type': 'audio/mpeg' } }); }
  return { ok: true, json: async () => ({ results: songs[url.searchParams.get('search')] ?? [] }) };
};
const argsOf = (r) => r.input.args.join(' ');
const settle = async () => { for (let k = 0; k < 6; k++) await tick(); await new Promise((r) => setTimeout(r, 5)); for (let k = 0; k < 6; k++) await tick(); };

/** A pretend @discordjs/voice: a player that goes idle when stopped, and resources that remember their volume. */
function fakeVoice() {
  const made = [];
  class Player extends EventEmitter {
    play(r) { this.r = r; }
    pause() { this.isPaused = true; }
    unpause() { this.isPaused = false; }
    stop() { setImmediate(() => this.emit('idle')); return true; }
  }
  const voice = {
    VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'disconnected', Signalling: 'signalling', Connecting: 'connecting' },
    AudioPlayerStatus: { Idle: 'idle' }, NoSubscriberBehavior: { Pause: 'pause' }, StreamType: { Raw: 'raw', Arbitrary: 'arbitrary', OggOpus: 'ogg/opus' },
    joinVoiceChannel: (o) => ({ o, state: { status: 'ready' }, subscribe() {}, on() {}, destroy() { this.state.status = 'destroyed'; } }),
    entersState: async () => {},
    createAudioPlayer: () => new Player(),
    createAudioResource: (input, o = {}) => { const r = { input, type: o.inputType, playbackDuration: 0, volume: o.inlineVolume ? { v: null, setVolume(x) { this.v = x; } } : null }; made.push(r); return r; },
  };
  const prism = { FFmpeg: class { constructor(o) { this.args = o.args; } destroy() {} } };
  return { lib: { voice, prism }, made };
}

export default async function runV312Tests({ test }) {
  const { makeWorld } = await import('./features.js');
  const { PermissionFlagsBits: P, ChannelType } = await import('discord.js');
  const M = await import('../modules/music/index.js');
  const ML = await import('../src/medialinks.js');

  console.log('\n3.1.2 music: volume, dashboard player, playlists');
  await test('music rules: volume limits, moving songs, what a playlist keeps, safe cover pictures', () => {
    assert.equal(M.clampVolume(150), 100); assert.equal(M.clampVolume(-5), 0); assert.equal(M.clampVolume('42.4'), 42);
    assert.throws(() => M.clampVolume('loud'), /0 to 100/);
    const q = [{ uid: 'a' }, { uid: 'b' }, { uid: 'c' }];
    assert.deepEqual(M.moveTrack(q, 'c', 0).map((t) => t.uid), ['c', 'a', 'b']);
    assert.deepEqual(M.moveTrack(q, 'c', 99).map((t) => t.uid), ['a', 'b', 'c']);
    assert.throws(() => M.moveTrack(q, 'zz', 0), /already played/);
    assert.equal(M.savable({ source: 'upload', title: 'Mine', file: '/tmp/x.mp3' }), null, 'uploads are deleted once played, so they cannot be kept');
    const kept = M.savable({ source: 'link', title: 'Rain', url: 'https://a.example/rain.mp3', by: '123', uid: 'q1', startAt: 40, resumes: 2, file: undefined });
    assert.deepEqual(kept, { title: 'Rain', source: 'link', url: 'https://a.example/rain.mp3' });
    assert.ok(!('by' in kept) && !('uid' in kept) && !('startAt' in kept), 'nothing about who queued it or where it stopped');
    assert.equal(M.savable({ source: 'link', title: 'Bad', url: 'file:///etc/passwd' }), null, 'only web addresses');
    assert.equal(M.savable({ source: 'link', title: 'BandLab', url: 'https://x.bandlab.com/a.m4a', page: 'https://www.bandlab.com/track/1', site: 'BandLab' }).relink, 'bandlab');
    assert.equal(ML.safeArt('https://i.ytimg.com/vi/x/hqdefault.jpg'), 'https://i.ytimg.com/vi/x/hqdefault.jpg');
    assert.equal(ML.safeArt('https://evil.example/x.png'), null); assert.equal(ML.safeArt('http://i.ytimg.com/x.jpg'), null);
    assert.equal(M.cleanPlaylistName('  Late   night\n vibes '), 'Late night vibes'); assert.throws(() => M.cleanPlaylistName('   '), /name/);
    const pl = { tracks: [] };
    assert.deepEqual(M.addToPlaylist(pl, [{ source: 'link', title: 'A', url: 'https://a/a.mp3' }, { source: 'upload', file: 'x' }]), { added: 1, skipped: 1 });
  });

  await test('dashboard player: join a voice channel, search, play, volume slider (also from settings), queue order, seek, skip and back, live updates', async () => {
    const { lib, made } = fakeVoice();
    globalThis[Symbol.for('goodboy.music.lib')] = lib;
    const realFetch = globalThis.fetch; const realKey = process.env.JAMENDO_CLIENT_ID;
    process.env.JAMENDO_CLIENT_ID = 'test';
    const songs = { rain: [{ name: 'Rain', artist_name: 'Mira', audio: 'https://jam.example/rain.mp3', duration: 200, image: 'https://usercontent.jamendo.com?type=album&id=1' }],
      sun: [{ name: 'Sun', artist_name: 'Odo', audio: 'https://jam.example/sun.mp3', duration: 180 }, { name: 'Moon', artist_name: 'Odo', audio: 'https://jam.example/moon.mp3', duration: 240 }] };
    const hits = [];
    globalThis.fetch = stubFetch(songs, hits);
    globalThis[Symbol.for('goodboy.music.settleMs')] = 0;
    const { subscribe } = await import('../src/live.js');
    const events = []; const stop = subscribe('1', (e) => { if (e.type === 'music') events.push(e.data.state); });
    try {
      const w = await makeWorld(['music']).load();
      const lounge = w.channel('Lounge'); lounge.type = ChannelType.GuildVoice; lounge.members = new (w.g.members.cache.constructor)();
      const act = (name, body = {}) => w.mm.runAction('1', 'music', name, body, { userId: 'dj1', username: 'DJ One' });
      let v = await w.mm.runView('1', 'music', 'player');
      assert.equal(v.connected, false); assert.deepEqual(v.voiceChannels.map((c) => c.name), ['Lounge']); assert.deepEqual(v.playlists, []);
      assert.equal(v.sources.jamendo, true);
      await assert.rejects(act('add', { tokens: [] }), /Pick a song/);
      const found = await act('search', { q: 'rain' });
      assert.equal(found.results[0].title, 'Rain'); assert.ok(found.results[0].token); assert.equal(found.results[0].art, 'https://usercontent.jamendo.com/?type=album&id=1');
      assert.ok(!JSON.stringify(found).includes('jam.example'), 'the page never sees the audio address, only a token');
      await assert.rejects(act('add', { tokens: [found.results[0].token] }), /Pick a voice channel/, 'not in voice and nothing picked');
      const r = await act('add', { tokens: [found.results[0].token], channelId: lounge.id });
      assert.equal(r.state.connected, true); assert.equal(r.state.current.title, 'Rain'); assert.equal(r.state.channelName, 'Lounge');
      // smooth playback: downloaded first, played from the file, as Opus made by ffmpeg with the volume in it
      const uploads = w.mm.ctx('1', 'music').fileDir('uploads');
      const files = () => fs.readdirSync(uploads).filter((f) => /^(play|dl)-/.test(f));
      assert.deepEqual(hits, ['/rain.mp3'], 'the song was downloaded before it played');
      assert.equal(made.at(-1).type, 'ogg/opus', 'Opus straight to Discord: no sound work in the bot');
      assert.ok(made.at(-1).input.args.includes(path.join(uploads, files()[0])), 'plays from the downloaded file');
      assert.match(argsOf(made.at(-1)), /volume=0\.70 .*-c:a libopus/, 'starts at the saved volume (70%)');
      // the slider: the song carries on from the same spot at the new volume
      made.at(-1).playbackDuration = 30000;
      v = await act('volume', { value: 35 }); await settle(); await settle();
      assert.equal(v.volume, 35); assert.match(argsOf(made.at(-1)), /-ss 30 .*volume=0\.35/, 'quieter straight away, from where it was');
      assert.equal(w.mm.ctx('1', 'music').config.get('volume'), 35, 'and it is remembered');
      assert.deepEqual(hits, ['/rain.mp3'], 'no second download: it plays on from the same file');
      w.mm.setSetting('1', 'music', 'volume', 80); await settle(); await settle();
      assert.match(argsOf(made.at(-1)), /volume=0\.80/, 'changing it on the settings page changes the song playing too');
      // paused: the volume waits and is put on when it plays again
      await act('control', { do: 'pause' }); const n = made.length;
      await act('volume', { value: 60 }); await settle(); await settle();
      assert.equal(made.length, n, 'nothing restarts while paused');
      await act('control', { do: 'resume' }); await settle(); await settle();
      assert.match(argsOf(made.at(-1)), /volume=0\.60/, 'the new volume is used as it plays again');
      await act('volume', { value: 80 }); await settle(); await settle();
      // more songs: Sun and Moon at the end, then Moon moved to the front
      const two = await act('search', { q: 'sun' });
      await act('add', { tokens: two.results.map((x) => x.token) });
      await settle(); await settle();
      v = await w.mm.runView('1', 'music', 'player');
      assert.deepEqual(v.queue.map((t) => t.title), ['Sun', 'Moon']);
      assert.deepEqual(hits.slice(-2).sort(), ['/moon.mp3', '/sun.mp3'], 'the next songs are got ready while this one plays');
      assert.equal(files().length, 3);
      v = await act('queue', { op: 'move', uid: v.queue[1].uid, to: 0 });
      assert.deepEqual(v.queue.map((t) => t.title), ['Moon', 'Sun']);
      // seek inside Rain: it starts again 60 seconds in
      assert.equal(v.canSeek, true);
      await act('seek', { seconds: 60 }); await settle();
      v = await w.mm.runView('1', 'music', 'player');
      assert.equal(v.current.title, 'Rain'); assert.equal(v.elapsed, 60); assert.deepEqual(v.queue.map((t) => t.title), ['Moon', 'Sun'], 'seeking keeps the queue as it was');
      assert.ok(made.at(-1).input.args.join(' ').includes('-ss 60'), 'ffmpeg starts part way in');
      assert.match(argsOf(made.at(-1)), /volume=0\.80/, 'a new part keeps the volume');
      // skip, then back
      await act('control', { do: 'skip' }); await settle();
      v = await w.mm.runView('1', 'music', 'player');
      assert.equal(v.current.title, 'Moon'); assert.equal(v.hasBack, true);
      await act('control', { do: 'back' }); await settle();
      v = await w.mm.runView('1', 'music', 'player');
      assert.equal(v.current.title, 'Rain', 'back in the first seconds plays the song before');
      assert.deepEqual(v.queue.map((t) => t.title), ['Moon', 'Sun'], 'and the skipped song comes next again');
      // pause, repeat, play a queued song now
      v = await act('control', { do: 'toggle' }); assert.equal(v.paused, true);
      v = await act('control', { do: 'toggle' }); assert.equal(v.paused, false);
      v = await act('control', { do: 'repeat' }); assert.equal(v.repeat, 'one');
      v = await act('control', { do: 'repeat', value: 'off' }); assert.equal(v.repeat, 'off');
      await act('queue', { op: 'play', uid: v.queue[1].uid }); await settle();
      v = await w.mm.runView('1', 'music', 'player');
      assert.equal(v.current.title, 'Sun'); assert.deepEqual(v.queue.map((t) => t.title), ['Moon']);
      assert.ok(events.length >= 5 && events.at(-1).current.title === 'Sun', 'open dashboards hear every change');
      assert.ok(!JSON.stringify(events).includes('jam.example'), 'live updates never carry audio addresses');
      assert.match(argsOf(made.at(-1)), /volume=0\.80/, 'every song plays at the volume it was left at');
      // stop: every downloaded song is deleted
      v = await act('control', { do: 'stop' }); assert.equal(v.connected, false);
      await settle(); await settle();
      assert.deepEqual(files(), [], 'no songs are left on the computer');
      await assert.rejects(act('control', { do: 'skip' }), /Nothing is playing/);
    } finally {
      stop(); delete globalThis[Symbol.for('goodboy.music.settleMs')]; globalThis.fetch = realFetch; if (realKey === undefined) delete process.env.JAMENDO_CLIENT_ID; else process.env.JAMENDO_CLIENT_ID = realKey;
      delete globalThis[Symbol.for('goodboy.music.lib')];
    }
  });

  await test('playlists: save the queue, add from search, reorder, rename, play (replaces the queue), play from Discord, delete; volume buttons on the Discord player', async () => {
    const { lib, made } = fakeVoice();
    globalThis[Symbol.for('goodboy.music.lib')] = lib;
    const realFetch = globalThis.fetch; const realKey = process.env.JAMENDO_CLIENT_ID;
    process.env.JAMENDO_CLIENT_ID = 'test';
    const songs = { ab: [{ name: 'Alpha', artist_name: 'X', audio: 'https://jam.example/a.mp3', duration: 100 }, { name: 'Beta', artist_name: 'X', audio: 'https://jam.example/b.mp3', duration: 100 }],
      gamma: [{ name: 'Gamma', artist_name: 'Y', audio: 'https://jam.example/c.mp3', duration: 100 }] };
    globalThis.fetch = stubFetch(songs);
    globalThis[Symbol.for('goodboy.music.settleMs')] = 0;
    try {
      const w = await makeWorld(['music']).load();
      const lounge = w.channel('Lounge'); lounge.type = ChannelType.GuildVoice; lounge.members = new (w.g.members.cache.constructor)();
      const act = (name, body = {}) => w.mm.runAction('1', 'music', name, body, { userId: 'dj1', username: 'DJ One' });
      const view = (name, q) => w.mm.runView('1', 'music', name, q);
      await assert.rejects(act('playlist', { op: 'create', name: 'Q', fromQueue: true }), /Nothing is playing/);
      const ab = await act('search', { q: 'ab' });
      await act('add', { tokens: ab.results.map((x) => x.token), channelId: lounge.id });
      // save what's playing as a playlist
      const saved = await act('playlist', { op: 'create', name: 'Friday night', fromQueue: true });
      assert.equal(saved.added, 2); assert.deepEqual(saved.playlist.tracks.map((t) => t.title), ['Alpha', 'Beta']);
      // a second one, filled from search
      const g = await act('search', { q: 'gamma' });
      const mine = (await act('playlist', { op: 'create', name: 'Chill' })).playlist;
      assert.equal(mine.count, 0);
      let pl = (await act('playlist', { op: 'add', id: mine.id, tokens: [g.results[0].token, ab.results[0].token] })).playlist;
      assert.deepEqual(pl.tracks.map((t) => t.title), ['Gamma', 'Alpha']);
      pl = (await act('playlist', { op: 'move', id: mine.id, trackId: pl.tracks[1].id, to: 0 })).playlist;
      assert.deepEqual(pl.tracks.map((t) => t.title), ['Alpha', 'Gamma']);
      pl = (await act('playlist', { op: 'rename', id: mine.id, name: 'Chill mix' })).playlist; assert.equal(pl.name, 'Chill mix');
      pl = (await act('playlist', { op: 'remove', id: mine.id, trackId: pl.tracks[0].id })).playlist; assert.deepEqual(pl.tracks.map((t) => t.title), ['Gamma']);
      // the song playing can be saved with one click (the heart)
      const playing = await view('player');
      pl = (await act('playlist', { op: 'add', id: mine.id, uid: playing.current.uid })).playlist; assert.deepEqual(pl.tracks.map((t) => t.title), ['Gamma', 'Alpha']);
      let v = await view('player');
      assert.deepEqual(v.playlists.map((p) => p.name), ['Chill mix', 'Friday night'], 'newest change first');
      assert.equal(v.playlists[0].seconds, 200);
      assert.deepEqual((await view('playlist', { id: mine.id })).tracks.map((t) => t.title), ['Gamma', 'Alpha']);
      // play it: it replaces the queue and starts now
      const r = await act('playlist', { op: 'play', id: mine.id }); await settle();
      v = await view('player');
      assert.equal(r.added, 2); assert.equal(v.current.title, 'Gamma'); assert.deepEqual(v.queue.map((t) => t.title), ['Alpha']);
      // From Discord: the Add music popup offers saved playlists
      const dj = w.person('900000000000000777', { bits: [P.ManageChannels, P.ModerateMembers, P.ManageMessages, P.KickMembers], pos: 5 });
      dj.voice = { channel: lounge, channelId: lounge.id };
      const room = w.channel('music');
      await w.mm.handleCommand(w.ix({ command: 'music', member: dj, channel: room }));
      const add = w.ix({ customId: 'music:add', member: dj, channel: room }); await w.mm.handleComponent(add);
      assert.match(JSON.stringify(add.modal), /Or play a saved playlist/); assert.match(JSON.stringify(add.modal), /Friday night/);
      const submit = w.ix({ customId: 'music:form', member: dj, channel: room }); submit.isModalSubmit = () => true;
      submit.fields = { getTextInputValue: () => '', getStringSelectValues: (k) => (k === 'playlist' ? [saved.playlist.id] : []), getUploadedFiles: () => new Map(), fields: new Map() };
      await w.mm.handleComponent(submit);
      assert.match(JSON.stringify(submit.edits), /Added \*\*2\*\* songs from the playlist \*\*Friday night\*\*/);
      // Volume buttons on the Discord player, with the volume shown
      const player = room.sent.at(-1);
      assert.match(JSON.stringify(player), /Quieter/); assert.match(JSON.stringify(player), /Louder/);
      const before = (await view('player')).volume;
      const up = w.ix({ customId: 'music:volup', member: dj, channel: room }); await w.mm.handleComponent(up);
      assert.equal((await view('player')).volume, Math.min(100, before + 10));
      assert.match(JSON.stringify(up.updated), new RegExp(`${Math.min(100, before + 10)}%`));
      await settle(); await settle();
      assert.match(argsOf(made.at(-1)), new RegExp(`volume=${(Math.min(100, before + 10) / 100).toFixed(2).replace('.', '\\.')}`), 'the song playing gets louder');
      // someone else, with others listening, can't
      const guest = w.person('900000000000000778'); guest.voice = { channel: lounge, channelId: lounge.id };
      lounge.members.set(dj.id, dj); lounge.members.set(guest.id, guest);
      const down = w.ix({ customId: 'music:voldown', member: guest, channel: room }); await w.mm.handleComponent(down);
      assert.match(JSON.stringify(down.replies), /Only the DJ role or staff can change the volume/);
      // delete
      await act('playlist', { op: 'delete', id: mine.id });
      await assert.rejects(view('playlist', { id: mine.id }), /deleted/);
      await act('control', { do: 'stop' });
    } finally {
      delete globalThis[Symbol.for('goodboy.music.settleMs')];
      globalThis.fetch = realFetch; if (realKey === undefined) delete process.env.JAMENDO_CLIENT_ID; else process.env.JAMENDO_CLIENT_ID = realKey;
      delete globalThis[Symbol.for('goodboy.music.lib')];
    }
  });
  await test('Add music: type a song name and pick from what was found; YouTube playlists queue every song; songs are downloaded by yt-dlp before they play', async () => {
    const { lib, made } = fakeVoice();
    globalThis[Symbol.for('goodboy.music.lib')] = lib;
    const calls = [];
    // a pretend yt-dlp: search, playlists, looking up one song, and downloading one to a file
    const spawnFn = (bin, args) => {
      calls.push(args); const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {};
      let a;
      if (args[0] === '--version') a = { out: '2026.10.01\n' };
      else if (args.includes('--flat-playlist') && /^ytsearch/.test(args.at(-1))) a = { out: JSON.stringify({ entries: [{ id: 'aaa', title: 'Never Gonna Give You Up', channel: 'Rick Astley', duration: 213 }, { id: 'bbb', title: 'Never Gonna (Live)', channel: 'Fan', duration: 250 }] }) };
      else if (args.includes('--flat-playlist')) a = { out: JSON.stringify({ title: 'Road trip mix', entries: [{ id: 'p1', title: 'One', channel: 'A', duration: 100 }, { id: 'p2', title: 'Two', channel: 'B', duration: 120 }, { id: 'p3', title: '[Deleted video]' }] }) };
      else if (args.includes('--print')) { const out = args[args.indexOf('-o') + 1].replace('%(ext)s', 'webm'); fs.writeFileSync(out, 'audio'); a = { out: `${out}\n` }; }
      else a = { out: JSON.stringify({ title: 'Song', uploader: 'Chan', duration: 200, webpage_url: 'https://youtu.be/x', extractor_key: 'Youtube' }) };
      setImmediate(() => { if (a.out) c.stdout.emit('data', a.out); c.emit('close', a.code ?? 0); }); return c;
    };
    globalThis[Symbol.for('goodboy.music.spawn')] = spawnFn;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u) => (String(u).startsWith('https://api.deezer.com/playlist/77')
      ? { ok: true, json: async () => ({ title: 'Deezer faves', tracks: { data: [{ title: 'Alpha', artist: { name: 'X' }, duration: 200 }, { title: 'Beta', artist: { name: 'Y' }, duration: 180 }] } }) }
      : { ok: false, status: 404 });
    try {
      assert.deepEqual(ML.listLink('https://www.youtube.com/playlist?list=PL123'), { site: 'YouTube', kind: 'playlist' });
      assert.equal(ML.listLink('https://www.youtube.com/watch?v=a&list=PL1'), null, 'a video in a playlist plays just that video');
      assert.deepEqual(ML.listLink('https://www.youtube.com/watch?v=a&list=PL1', { andVideos: true }), { site: 'YouTube', kind: 'playlist' }, '...but importing takes the playlist');
      assert.deepEqual(ML.listLink('https://music.youtube.com/playlist?list=PL9'), { site: 'YouTube', kind: 'playlist' });
      assert.deepEqual(ML.listLink('https://soundcloud.com/band/sets/summer'), { site: 'SoundCloud', kind: 'playlist' });
      assert.deepEqual(ML.listLink('https://band.bandcamp.com/album/first'), { site: 'Bandcamp', kind: 'album' });
      assert.deepEqual(ML.listLink('https://www.deezer.com/fr/playlist/77'), { site: 'Deezer', kind: 'playlist' });
      assert.equal(ML.listLink('https://soundcloud.com/band/one-song'), null);
      const w = await makeWorld(['music']).load();
      const lounge = w.channel('Lounge'); lounge.type = ChannelType.GuildVoice; lounge.members = new (w.g.members.cache.constructor)();
      const room = w.channel('music');
      const me = w.person('900000000000000801'); me.voice = { channel: lounge, channelId: lounge.id };
      const act = (name, body = {}) => w.mm.runAction('1', 'music', name, body, { userId: 'dj1', username: 'DJ One' });
      // media links off: Deezer can still be imported to keep; YouTube can't be read
      const dz = await act('playlist', { op: 'import', link: 'https://www.deezer.com/fr/playlist/77' });
      assert.equal(dz.added, 2); assert.equal(dz.site, 'Deezer'); assert.equal(dz.playlist.name, 'Deezer faves'); assert.match(dz.note, /media links/);
      await assert.rejects(act('playlist', { op: 'import', link: 'https://www.youtube.com/playlist?list=PL123' }), /turned off/);
      await assert.rejects(act('playlist', { op: 'import', link: 'https://example.com/song.mp3' }), /Paste a link to a playlist/);
      w.mm.ctx('1', 'music').data.set('mediaLinks', { on: true });
      const yt = await act('playlist', { op: 'import', link: 'https://www.youtube.com/playlist?list=PL123', name: 'Trip' });
      assert.equal(yt.playlist.name, 'Trip'); assert.deepEqual(yt.playlist.tracks.map((t) => t.title), ['One', 'Two'], 'deleted videos are left out');
      // the popup: one box for a song name or a link
      const add = w.ix({ customId: 'music:add', member: me, channel: room }); await w.mm.handleComponent(add);
      assert.match(JSON.stringify(add.modal), /Song name or link/);
      const submit = (text) => { const i = w.ix({ customId: 'music:form', member: me, channel: room }); i.isModalSubmit = () => true;
        i.fields = { getTextInputValue: (k) => (k === 'link' ? text : ''), getStringSelectValues: () => [], getUploadedFiles: () => new Map(), fields: new Map() }; return i; };
      const s1 = submit('never gonna'); await w.mm.handleComponent(s1);
      const menu = s1.edits.at(-1);
      assert.match(menu.content, /2\*\* found for “never gonna”/);
      const options = menu.components[0].toJSON().components[0].options;
      assert.deepEqual(options.map((o) => o.label), ['Never Gonna Give You Up', 'Never Gonna (Live)']);
      assert.match(options[0].description, /Rick Astley · 3:33/);
      const pick = w.ix({ customId: 'music:pick', member: me, channel: room }); pick.values = [options[0].value]; await w.mm.handleComponent(pick);
      assert.match(pick.updated.content, /Playing \*\*Never Gonna Give You Up\*\*/);
      assert.ok(calls.some((a) => a.includes('--print') && a.includes('https://www.youtube.com/watch?v=aaa')), 'yt-dlp downloaded the song first');
      assert.match(argsOf(made.at(-1)), /dl-\d+-\w+\.webm/, 'and it plays from that file');
      // a YouTube playlist link queues every song
      const s2 = submit('https://www.youtube.com/playlist?list=PL123'); await w.mm.handleComponent(s2);
      assert.match(s2.edits.at(-1).content, /Added \*\*2\*\* songs from the YouTube playlist \*\*Road trip mix\*\*/);
      const v = await w.mm.runView('1', 'music', 'player');
      assert.deepEqual(v.queue.map((t) => t.title), ['One', 'Two']);
      // the dashboard search box takes a playlist link too, ready to save
      const sr = await act('search', { q: 'https://www.deezer.com/fr/playlist/77' });
      assert.equal(sr.list.site, 'Deezer'); assert.equal(sr.results.length, 2);
      await act('control', { do: 'stop' });
    } finally {
      globalThis.fetch = realFetch;
      delete globalThis[Symbol.for('goodboy.music.spawn')]; delete globalThis[Symbol.for('goodboy.music.lib')];
    }
  });
  await test('live every 5 seconds: an open Discord queue list follows the queue, the player shows a moving progress bar, dashboards get the state', async () => {
    const { lib, made } = fakeVoice();
    globalThis[Symbol.for('goodboy.music.lib')] = lib;
    globalThis[Symbol.for('goodboy.music.tickMs')] = 25;
    const realFetch = globalThis.fetch; const realKey = process.env.JAMENDO_CLIENT_ID;
    process.env.JAMENDO_CLIENT_ID = 'test';
    globalThis.fetch = stubFetch({ ab: [{ name: 'Alpha', artist_name: 'X', audio: 'https://jam.example/a.mp3', duration: 100 }, { name: 'Beta', artist_name: 'X', audio: 'https://jam.example/b.mp3', duration: 100 }], gamma: [{ name: 'Gamma', artist_name: 'Y', audio: 'https://jam.example/c.mp3', duration: 100 }] });
    const { subscribe } = await import('../src/live.js');
    let pushes = 0; const stop = subscribe('1', (e) => { if (e.type === 'music') pushes++; });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      const M2 = await import('../modules/music/index.js');
      assert.equal(M2.progressBar(50, 100, 10), '`0:50` ▬▬▬▬▬🔘▬▬▬▬ `1:40`');
      const w = await makeWorld(['music']).load();
      const lounge = w.channel('Lounge'); lounge.type = ChannelType.GuildVoice; lounge.members = new (w.g.members.cache.constructor)();
      const room = w.channel('music');
      const dj = w.person('900000000000000901', { bits: [P.ManageChannels, P.ModerateMembers, P.ManageMessages, P.KickMembers], pos: 5 }); dj.voice = { channel: lounge, channelId: lounge.id };
      const act = (name, body = {}) => w.mm.runAction('1', 'music', name, body, { userId: 'dj1', username: 'DJ One' });
      await w.mm.handleCommand(w.ix({ command: 'music', member: dj, channel: room }));
      await act('add', { tokens: (await act('search', { q: 'ab' })).results.map((r) => r.token), channelId: lounge.id });
      const q = w.ix({ customId: 'music:queue', member: dj, channel: room }); await w.mm.handleComponent(q);
      assert.match(JSON.stringify(q.replies[0]), /Beta/);
      // a song is added from the dashboard: the open queue list shows it within one tick
      await act('add', { tokens: (await act('search', { q: 'gamma' })).results.map((r) => r.token) });
      await wait(90);
      assert.match(JSON.stringify(q.edits.at(-1)), /Gamma/, 'the open queue list updated by itself');
      const edits = q.edits.length; await wait(90);
      assert.equal(q.edits.length, edits, 'and is left alone while nothing changes');
      // the player message's progress bar moves
      made.at(-1).playbackDuration = 42000; await wait(90);
      const msg = [...room.messages.store.values()].at(-1);
      assert.match(JSON.stringify(msg.edited), /`0:42` ▬+🔘▬+ `1:40`/);
      assert.ok(pushes >= 4, 'dashboards hear the state on every tick');
      await act('control', { do: 'stop' });
      assert.match(JSON.stringify(q.edits.at(-1)), /music stopped/);
    } finally {
      stop(); globalThis.fetch = realFetch; if (realKey === undefined) delete process.env.JAMENDO_CLIENT_ID; else process.env.JAMENDO_CLIENT_ID = realKey;
      delete globalThis[Symbol.for('goodboy.music.lib')]; delete globalThis[Symbol.for('goodboy.music.tickMs')];
    }
  });
}
