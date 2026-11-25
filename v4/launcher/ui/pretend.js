// Basic Ghost Labs - Good Boy 4. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// A pretend bot for looking at the screens in a browser. Nothing here talks to Discord or saves anything.
// Add ?first to the address to see the first run, ?old to pretend Good Boy 3 data was found.
'use strict';
(function () {
  const q = new URLSearchParams(location.search);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = {
    roleMenus: [{ message: '555000000000000001', channel_name: 'roles', title: 'Pick your colour', type: 'buttons', mode: 'unique', max: 0, hours: 0, roles: [{ id: '1', name: 'Red', emoji: '🔴' }, { id: '2', name: 'Blue', emoji: '🔵' }] }, { message: '555000000000000002', channel_name: 'games', title: 'What do you play?', type: 'dropdown', mode: 'toggle', max: 3, hours: 0, roles: [{ id: '3', name: 'Gamers' }, { id: '4', name: 'Raiders' }] }],
    prefs: { setup_done: !q.has('first'), parts: 'bot', place: 'pc', start_with_app: true, theme: q.get('theme') || 'system', toured: !q.has('tour'), private_dismiss_seconds: 300, web_on: false, web_port: 47890, web_address: '', web_all: false, colours: { on: q.has('own'), accent: '#5ce1e6', bg: '#0c1824', panel: '#13243a', ink: '#e6f4ff' } },
    licence: q.has('supporter') ? 'GB1.preview.key' : '',
    data: q.has('first') ? null : { servers: 2, modules_on: 31, settings: 148, records: 12840 },
    old: q.has('old') ? { folder: 'C:\\Users\\you\\AppData\\Roaming\\Good Boy\\bot-data', servers: 2, records: 12840 } : null,
    token: !q.has('first'), secret: false,
    live: q.has('first') || q.has('stopped') ? { phase: 'stopped', name: null, servers: 0, online_since_ms: null, start_took_ms: null, problem: null }
      : q.has('problem') ? { phase: 'problem', name: null, servers: 0, online_since_ms: null, start_took_ms: null, problem: 'Discord says this token is not valid. Reset the token on the bot\'s page and paste the new one.' }
      : { phase: 'online', name: 'Good Boy Test', servers: 2, online_since_ms: Date.now() - 2 * 3600e3 - 14 * 60e3, start_took_ms: 1180, problem: null, notice: q.has('notice') ? 'Message Content is switched off on the bot\'s page, so counting cannot see numbers. Everything else works. Turn it on under Bot > Privileged Gateway Intents, then restart.' : null },
    modules: [
      { id: 'community', name: 'Levels', about: 'Members earn XP for chatting and level up. /rank and /leaderboard.' },
      { id: 'economy', name: 'Money', about: 'Coins, a daily reward with streaks, work, paying each other and the rich list. /money.' },
      { id: 'moderation', name: 'Moderation', about: 'Warn, time out, kick, ban (for good or for a while), bulk delete, each member\'s history, AutoMod, a strike ladder and server logs. Raid protection is still to come.' },
      { id: 'critters', name: 'Critters', about: 'Catch, collect, trade and battle characters from your own roster.', commands: [], },
      { id: 'eclipseid', name: 'Eclipse ID', about: 'A gaming profile members control, one card per person.', commands: [] },
      { id: 'member-management', name: 'Welcome', about: 'Welcome and goodbye messages, and a waiting role for new members. Needs Server Members on the bot\'s page. Verification, profile roles and birthdays are still to come.' },
      { id: 'roles', name: 'Role menus', about: 'Buttons or a dropdown for members to pick roles, reaction roles, roles given on join, and roles that run out. /rolemenu, /reactionrole, /autorole.' },
      { id: 'support', name: 'Tickets', about: 'Tickets with categories and urgency, popups, a staff watch log for reports, required close notes, transcripts, ratings and a history. /ticket.' },
      { id: 'reminders', name: 'Reminders', about: 'Private reminders and team reminders that notify roles, once or repeating. /remind.' },
      { id: 'giveaways', name: 'Giveaways', about: 'A card with an Enter button, winners drawn fairly when time is up, rerolls, and coin prizes paid by themselves. /giveaway.' },
      { id: 'tags', name: 'Custom commands', about: 'Your own commands such as ?rules, and replies when someone says a phrase. /tags. Needs Message Content.' },
      { id: 'counting', name: 'Counting', about: 'Counting channels and word chain, with records and top players. /counting. Needs Message Content.' },
      { id: 'fun', name: 'Fun', about: 'Magic 8-ball, dice, ship two members and conversation topics. /fun.' },
      { id: 'music', name: 'Music', about: 'A player with buttons in voice: a queue, repeat, shuffle, volume, playlists and lyrics. Audio file links and radio stations always work; YouTube and similar sites only once the bot\'s owner turns on media links. /music.' },
    ],
    servers: [
      { id: '100000000000000001', name: 'Ghost Town', on: { critters: true, community: true, economy: true, moderation: true, 'member-management': true, roles: true, support: true, reminders: true, giveaways: true, tags: true, fun: true, music: true }, waiting: 10 },
      { id: '100000000000000002', name: 'Pixel Cafe', on: { community: true, economy: false, moderation: true, fun: true }, waiting: 6 },
    ],
    values: {},
  };
  if (q.has('one')) S.servers = S.servers.slice(0, 1); // a person with a single server
  S.tkMsgs = S.tkMsgs || {};
  const LICENCE = () => S.licence ? { has_key: true, ok: true, error: null, expired: false, to: 'Kai', features: ['whitelabel'], ends: null, whitelabel: true } : { has_key: false };
  const TK = () => (S.tk ||= Array.from({ length: 57 }, (_, i) => { const kinds = ['report', 'help', 'appeal', 'partnership']; const k = kinds[i % 4]; const sev = k === 'report' ? (i % 8 === 0 ? 'urgent' : 'high') : k === 'partnership' ? 'low' : 'normal'; const names = ['kai', 'Rowan', 'Sam', 'pia', 'dex', 'ozzy', 'rue', 'Juno'];
    return { number: 57 - i, open: i < 3, channel: 'c' + i, opener: { id: '70000000000000000' + (i % 10), name: names[i % 8] }, about: k === 'report' ? { id: '9000000000000000' + (10 + i % 5), name: ['troublemaker', 'spambot42', 'RudeGuy'][i % 3] } : null,
      severity: { id: sev, label: { urgent: '🔴 urgent', high: '🟠 high', normal: '🔵 normal', low: '🟢 low' }[sev], rank: { urgent: 3, high: 2, normal: 1, low: 0 }[sev] }, category: k, category_label: { report: 'Report a member', help: 'Question or other', appeal: 'Ban, mute or warning appeal', partnership: 'Partnership or business' }[k],
      opened_at: Date.now() - i * 7 * 3600e3, closed_at: i < 3 ? null : Date.now() - i * 7 * 3600e3 + 2 * 3600e3, kind: i < 3 ? null : ['staff', 'staff', 'opener', 'idle'][i % 4], resolution: i < 3 ? null : 'Sorted out.', first_response_ms: i % 5 ? (4 + i % 30) * 60e3 : null,
      claimed_by: i % 3 ? { id: 'me', name: ['Mod Maya', 'Mod Theo'][i % 2] } : null, closed_by: i < 3 ? null : { id: 'me', name: ['Mod Maya', 'Mod Theo'][i % 2] } }; }));
  const DEFS = {
    community: [
      { key: 'xpMin', label: 'XP per message (min)', kind: 'number', min: 1, max: 500, default: 15 },
      { key: 'xpMax', label: 'XP per message (max)', kind: 'number', min: 1, max: 500, default: 25 },
      { key: 'xpCooldownSeconds', label: 'Seconds between XP gains', kind: 'number', min: 5, max: 3600, default: 60 },
      { key: 'noXpChannels', label: 'No XP in these channels or categories', kind: 'list', default: [] },
      { key: 'levelUpEnabled', label: 'Announce level-ups', kind: 'toggle', default: true },
      { key: 'levelUpChannel', label: 'Level-up channel (empty = where they chatted)', kind: 'channel', default: null },
      { key: 'levelUpMessage', label: 'Level-up message', kind: 'text', max: 2000, default: '🎉 {user} reached **level {level}**!' },
      { key: 'rankCards', label: '/rank shows a picture card (text if pictures are off)', kind: 'toggle', default: true },
      { key: 'cardBackgrounds', label: 'Members can put their own picture behind their rank card', kind: 'toggle', default: true },
      { key: 'stackRewards', label: 'Keep earlier level rewards (off = only the newest)', kind: 'toggle', default: true },
    ],
    economy: [
      { key: 'privateReplies', label: 'Only the member sees their balance, daily and the rich list', kind: 'toggle', default: true },
      { key: 'currencyName', label: 'Currency name', kind: 'text', max: 20, default: 'coins' },
      { key: 'currencyEmoji', label: 'Currency emoji', kind: 'text', max: 64, default: '🪙' },
      { key: 'startingCoins', label: 'Coins a new member starts with', kind: 'number', min: 0, max: 1000000, default: 500 },
      { key: 'dailyBase', label: 'Daily reward (before streak bonus)', kind: 'number', min: 1, max: 1000000, default: 250 },
      { key: 'maxPay', label: 'Most coins in one payment', kind: 'number', min: 1, max: 1000000000, default: 1000000 },
      { key: 'workMin', label: 'Work pays at least', kind: 'number', min: 0, max: 1000000, default: 50 },
      { key: 'workMax', label: 'Work pays at most', kind: 'number', min: 1, max: 1000000, default: 200 },
      { key: 'workCooldownMinutes', label: 'Minutes between work', kind: 'number', min: 1, max: 1440, default: 60 },
    ],
  };
  DEFS.moderation = [
    { key: 'logChannel', label: 'Mod log channel', kind: 'channel', default: null },
    { key: 'dmOnAction', label: 'DM users when action is taken', kind: 'toggle', default: true },
    { key: 'logMessages', label: 'Log message edits & deletes', kind: 'toggle', default: true },
    { key: 'serverLogChannel', label: 'Server log channel for joins, roles, nicknames, voice (empty = the mod log)', kind: 'channel', default: null },
    { key: 'logJoins', label: 'Log members joining and leaving', kind: 'toggle', default: false },
    { key: 'warnTimeoutThreshold', label: 'Auto-timeout every N warnings (0 = off)', kind: 'number', min: 0, max: 20, default: 3 },
    { key: 'warnTimeoutMinutes', label: 'Auto-timeout length (minutes)', kind: 'number', min: 1, max: 40320, default: 60 },
    { key: 'warnKickAt', label: 'Auto-kick at this many warnings (0 = off)', kind: 'number', min: 0, max: 50, default: 0 },
    { key: 'warnBanAt', label: 'Auto-ban at this many warnings (0 = off)', kind: 'number', min: 0, max: 50, default: 0 },
    { key: 'strikeLadder', label: 'Strike ladder: one step per line, such as "2 timeout 1d", "4 timeout 1w", "6 ban 30d" or "10 ban" (empty = use the three numbers above)', kind: 'list', default: [] },
    { key: 'strikeResetTo', label: 'After a ban from the strike ladder, strikes start again from (0 = keep counting)', kind: 'number', min: 0, max: 50, default: 0 },
  ];
  DEFS.reminders = [
    { key: 'timezoneOffset', label: 'Server timezone offset from UTC, in hours (for dates like 2026-12-31 18:30)', kind: 'number', min: -12, max: 14, default: 0 },
    { key: 'maxPersonal', label: 'Personal reminders each member can keep', kind: 'number', min: 1, max: 50, default: 10 },
    { key: 'maxTeam', label: 'Team reminders the server can keep', kind: 'number', min: 1, max: 100, default: 25 },
  ];
  DEFS.counting = [
    { key: 'oneAtATime', label: 'Nobody can go twice in a row', kind: 'toggle', default: true },
    { key: 'reactions', label: 'React ✅ to every right answer', kind: 'toggle', default: true },
  ];
  DEFS.fun = [];
  const CMDS = { community: [{ name: 'rank', about: 'See your level, or someone else\'s', subs: [] }, { name: 'leaderboard', about: 'The members with the most XP', subs: [] }],
    economy: [{ name: 'money', about: 'Your coins: balance, daily reward, work, pay and the rich list', subs: ['balance', 'daily', 'work', 'pay', 'top', 'reset'] }],
    support: [{ name: 'ticket', about: 'Support tickets', subs: ['setup', 'panel', 'type add', 'type remove', 'type list', 'watch list', 'watch view', 'close', 'add', 'remove', 'rename', 'priority', 'info', 'transcript', 'stats'] }],
    music: [{ name: 'music', about: 'Music in voice: the player, the queue, playlists and lyrics', subs: ['player', 'play', 'queue', 'skip', 'stop', 'volume', 'lyrics', 'playlists', 'save'] }] };
  DEFS.music = [
    { key: 'volume', label: 'Volume (%)', kind: 'number', min: 0, max: 100, default: 70 },
    { key: 'djRole', label: 'DJ role: can skip and stop anyone\'s songs', kind: 'role', default: null },
    { key: 'maxQueue', label: 'Most songs in the queue', kind: 'number', min: 5, max: 200, default: 50 },
    { key: 'maxPerMember', label: 'Most songs one member can queue', kind: 'number', min: 1, max: 50, default: 10 },
    { key: 'idleMinutes', label: 'Leave voice after this many minutes with nothing playing', kind: 'number', min: 1, max: 60, default: 5 },
    { key: 'smooth', label: 'Download each song before it plays (smoother sound; the first song takes a few seconds to start)', kind: 'toggle', default: true },
    { key: 'stations', label: 'Radio stations (Name | stream link). Only add stations that allow it.', kind: 'list', default: [] },
    { key: 'allowUploads', label: 'Members can upload songs to play', kind: 'toggle', default: true },
  ];
  DEFS.roles = [{ key: 'gameRoleRemove', label: 'Remove a game role when the member stops playing', kind: 'toggle', default: true }];
  DEFS.eclipseid = [
    { key: 'autoDetect', label: 'Pick up the games and platforms members play from their Discord status', kind: 'toggle', default: true },
    { key: 'robloxLookup', label: 'Let /id roblox check that a Roblox username exists', kind: 'toggle', default: false },
  ];
  DEFS['member-management'] = [
    { key: 'welcomeEnabled', label: 'Send welcome messages', kind: 'toggle', default: false },
    { key: 'welcomeChannel', label: 'Welcome channel', kind: 'channel', default: null },
    { key: 'welcomeMessage', label: 'Welcome message ({user} {username} {server} {count})', kind: 'text', max: 1900, default: 'Welcome {user} to **{server}**! You are member #{count}.' },
    { key: 'welcomeLook', label: 'Welcome message look', kind: 'select', options: ['plain', 'card'], default: 'plain' },
    { key: 'welcomeCardTitle', label: 'Welcome card: big words', kind: 'text', max: 120, default: 'Welcome, {username}!' },
    { key: 'welcomeCardLine', label: 'Welcome card: smaller words', kind: 'text', max: 160, default: 'You are member #{count} of {server}' },
    { key: 'welcomeCardAccent', label: 'Welcome card: ring and bar colour', kind: 'colour', default: '#6b93ff' },
    { key: 'welcomeCardTheme', label: 'Welcome card: colours behind your picture', kind: 'select', options: ['dark', 'light', 'midnight', 'sunset', 'forest', 'ocean', 'candy'], default: 'midnight' },
    { key: 'goodbyeLook', label: 'Goodbye message look', kind: 'select', options: ['plain', 'card'], default: 'plain' },
    { key: 'goodbyeCardTitle', label: 'Goodbye card: big words', kind: 'text', max: 120, default: 'Goodbye, {username}' },
    { key: 'goodbyeCardLine', label: 'Goodbye card: smaller words', kind: 'text', max: 160, default: 'We hope to see you again' },
    { key: 'goodbyeCardAccent', label: 'Goodbye card: ring and bar colour', kind: 'colour', default: '#b07cff' },
    { key: 'goodbyeCardTheme', label: 'Goodbye card: colours behind your picture', kind: 'select', options: ['dark', 'light', 'midnight', 'sunset', 'forest', 'ocean', 'candy'], default: 'dark' },
    { key: 'goodbyeEnabled', label: 'Send goodbye messages', kind: 'toggle', default: false },
    { key: 'goodbyeChannel', label: 'Goodbye channel', kind: 'channel', default: null },
    { key: 'goodbyeMessage', label: 'Goodbye message ({username} {server} {count})', kind: 'text', max: 1900, default: '**{username}** has left the server.' },
    { key: 'verificationRole', label: 'Role given after verifying', kind: 'role', default: null },
    { key: 'unverifiedRole', label: 'Role new members get until verified (optional)', kind: 'role', default: null },
  ];
  DEFS.tags = [{ key: 'prefixes', label: 'Command prefixes', kind: 'list', default: [] }];
  DEFS.support = [
    { key: 'ticketCategory', label: 'Category for ticket channels', kind: 'category', default: null },
    { key: 'staffRole', label: 'Staff role', kind: 'role', default: null },
    { key: 'logChannel', label: 'Ticket log channel (close notes go here - staff only!)', kind: 'channel', default: null },
    { key: 'maxOpenPerUser', label: 'Max open tickets per member', kind: 'number', min: 1, max: 10, default: 2 },
    { key: 'autoCloseHours', label: 'Auto-close tickets after N hours without a message (0 = never)', kind: 'number', min: 0, max: 720, default: 0 },
    { key: 'hiddenCategories', label: 'Ticket categories to switch off (ids: scam, safety, report, appeal, bot, access, partner, other)', kind: 'list', default: [] },
    { key: 'deleteDelaySeconds', label: 'Seconds before a deleted ticket vanishes', kind: 'number', min: 1, max: 60, default: 5 },
  ];
  DEFS.giveaways = [];
  DEFS.critters = [{ key: 'spawnChannel', label: 'Channel where critters appear', kind: 'channel', default: null }];
  const GROUP = (m, k) => {
    if (m === 'moderation') return ['logChannel', 'dmOnAction'].includes(k) ? 'Basics' : k.startsWith('log') || k === 'serverLogChannel' ? 'Server logs' : k.startsWith('warn') || k.startsWith('strike') ? 'Warnings and strikes' : k.startsWith('automod') || /^(spam|caps|emoji|repeat|maxMentions|banned|allowed|scams|words|links|mentions)/.test(k) ? 'AutoMod' : 'Other';
    if (m === 'economy') return k.startsWith('work') ? 'Work' : k === 'dailyBase' ? 'Daily reward' : 'Basics';
    if (m === 'community') return k.startsWith('xp') || k === 'noXpChannels' ? 'Earning XP' : ['rankCards', 'cardBackgrounds'].includes(k) ? 'Rank cards' : 'Level-ups';
    if (m === 'member-management') return k.startsWith('welcome') ? 'Welcome' : k.startsWith('goodbye') ? 'Goodbye' : 'Verification';
    if (m === 'music') return ['volume', 'smooth', 'idleMinutes'].includes(k) ? 'Sound' : ['djRole', 'maxQueue', 'maxPerMember'].includes(k) ? 'Who can do what' : 'Where songs come from';
    if (m === 'support') return ['ticketCategory', 'staffRole', 'logChannel'].includes(k) ? 'Basics' : 'Limits and clean-up';
    return '';
  };
  DEFS.moderation.push(
    { key: 'automodAction', label: 'AutoMod action', kind: 'select', options: ['delete', 'delete-warn', 'delete-timeout'], default: 'delete-warn' },
    { key: 'automodScams', label: 'Scam and phishing link filter', kind: 'toggle', default: true },
    { key: 'automodSpam', label: 'Spam protection', kind: 'toggle', default: false },
    { key: 'spamMaxMessages', label: 'Spam: messages allowed...', kind: 'number', min: 2, max: 30, default: 5 },
    { key: 'automodWords', label: 'Word filter', kind: 'toggle', default: false },
    { key: 'bannedWords', label: 'Banned words', kind: 'list', default: [] },
  );
  const CHANNELS = [{ id: '200000000000000001', name: 'general', kind: 'text' }, { id: '200000000000000002', name: 'bot-commands', kind: 'text' }, { id: '200000000000000003', name: 'level-ups', kind: 'text' }, { id: '200000000000000004', name: 'Staff', kind: 'category' }];
  const tokenLike = (t) => t.trim().split('.').length === 3 && t.trim().length > 30;
  const NAMES = ['kai', 'mo', 'juniper', 'ash', 'rue', 'tobi', 'lin', 'ozzy', 'pia', 'dex'];
  const CASES = Array.from({ length: 64 }, (_, i) => { const type = ['warn', 'timeout', 'warn', 'kick', 'warn', 'automod', 'timeout', 'ban', 'warn', 'unwarn'][i % 10]; return { id: 64 - i, type, targetId: '7000000000000000' + String((i * 7) % 13).padStart(2, '0'), targetTag: NAMES[((i * 7) % 13) % 10], modId: type === 'automod' || i % 9 === 4 ? null : ['900000000000000001', '900000000000000002', '900000000000000003'][i % 3], reason: ['Spam in #general', 'Link to a scam site', 'Harassing another member', 'Raid account', 'Being rude after a warning', 'Posted the same message 6 times in 10 seconds'][i % 6], at: Date.now() - Math.round(i * i * 0.55 * 3600e3 + i * 2.5 * 3600e3), ...(type === 'timeout' ? { durationMs: [10, 60, 1440][i % 3] * 6e4 } : {}), ...(i % 8 === 0 ? { notes: 'Second time this week. Talked to them in DMs first.' } : {}) }; });
  const BOARDS = (n) => ({ xp: NAMES.slice(0, n).map((u, i) => ({ user: '70000000000000000' + i, xp: 52000 - i * 6100, level: 42 - i * 3, name: u })), coins: NAMES.slice(0, n).map((u, i) => ({ user: '70000000000000000' + i, name: u, coins: 48210 - i * 5100 })) });
  const SONGS = [['Morning Song', 'Juniper', 184], ['Night Drive', 'The Quiet Hours', 241], ['Paper Boats', 'Lin', 203], ['Static', 'Ash & Rue', 167], ['Slow Rain', 'Tobi', 276], ['Glass Houses', 'Rue', 219], ['Low Tide', 'Pia', 198]];
  const song = (i, by) => ({ uid: 'u' + Math.random().toString(36).slice(2, 8), title: SONGS[i % 7][0], artist: SONGS[i % 7][1], seconds: SONGS[i % 7][2], source: 'media', site: 'YouTube', art: null, by: by || '700000000000000001', byName: ['kai', 'mo', 'juniper'][i % 3], canSave: true });
  const MS = { filter: 'off', on: true, channelId: '800000000000000001', paused: false, volume: 70, repeat: 'off', startedAt: Date.now() - 41e3, current: song(0), queue: [1, 2, 3, 4, 5].map((i) => song(i)),
    playlists: [{ id: 'p1', name: 'Late night', tracks: [0, 1, 2, 3].map((i) => Object.assign(song(i), { id: 'pt' + i })), by: 'Mo' }, { id: 'p2', name: 'Study beats', tracks: [4, 5, 6].map((i) => Object.assign(song(i), { id: 'ps' + i })), by: 'Kai' }] };
  const mState = () => ({ connected: MS.on, channelId: MS.channelId, channelName: 'Lounge', listeners: 3, paused: MS.paused, volume: MS.volume, filter: MS.filter, repeat: MS.repeat, current: MS.current, preparing: false, elapsed: (MS.paused ? MS.pausedAt : Date.now()) / 1000 - MS.startedAt / 1000, canSeek: true, hasBack: true, queue: MS.queue.slice(0, 100), queueLength: MS.queue.length, totalSeconds: MS.queue.reduce((a, t) => a + t.seconds, 0), at: Date.now() });
  const pSum = (p) => ({ id: p.id, name: p.name, count: p.tracks.length, seconds: p.tracks.reduce((a, t) => a + t.seconds, 0), art: [], byName: p.by, updatedAt: Date.now() });
  const pFull = (p) => Object.assign(pSum(p), { tracks: p.tracks });
  function MUSIC(kind, name, a) {
    if (kind === 'view' && name === 'player') return Object.assign(mState(), { voiceChannels: [{ id: '800000000000000001', name: 'Lounge', listeners: 3, canJoin: true }, { id: '800000000000000002', name: 'Gaming', listeners: 0, canJoin: true }], playlists: MS.playlists.map(pSum), limits: { maxQueue: 50, playlistSongs: 300, playlists: 50 }, sources: { media: true, jamendo: false, stations: [{ id: 'Lofi Radio', name: 'Lofi Radio' }] } });
    if (kind === 'view' && name === 'playlist') { const p = MS.playlists.find((x) => x.id === a.id); if (!p) throw new Error('That playlist was deleted.'); return pFull(p); }
    if (name === 'join') { MS.on = true; MS.channelId = a.channelId; return mState(); }
    if (name === 'media') { MS.media = !!a.on; return mState(); }
    if (name === 'filter') { MS.filter = a.value; return mState(); }
    if (name === 'control') {
      if (['pause', 'resume', 'toggle'].includes(a.do)) { if (MS.paused) { MS.startedAt += Date.now() - MS.pausedAt; MS.paused = false; } else { MS.paused = true; MS.pausedAt = Date.now(); } }
      else if (a.do === 'skip') { MS.current = MS.queue.shift() || null; MS.startedAt = Date.now(); }
      else if (a.do === 'repeat') MS.repeat = a.value || { off: 'one', one: 'all', all: 'off' }[MS.repeat];
      else if (a.do === 'shuffle') MS.queue.reverse();
      else if (a.do === 'stop') { MS.on = false; MS.current = null; MS.queue = []; }
      return mState();
    }
    if (name === 'volume') { MS.volume = a.value; return mState(); }
    if (name === 'seek') { MS.startedAt = Date.now() - a.seconds * 1000; return { ok: true }; }
    if (name === 'queue') { const k = MS.queue.findIndex((t) => t.uid === a.uid); if (a.op === 'clear') MS.queue = []; else if (k >= 0) { const [t] = MS.queue.splice(k, 1); if (a.op === 'top' || a.op === 'play') MS.queue.unshift(t); if (a.op === 'move') MS.queue.splice(a.to, 0, t); if (a.op === 'play') { MS.current = MS.queue.shift(); MS.startedAt = Date.now(); } } return mState(); }
    if (name === 'search') { if (String(a.q).trim().length < 2) throw new Error('Type at least 2 letters.'); return { results: SONGS.map((_, i) => Object.assign(song(i), { token: 't' + i })).filter((t) => (t.title + t.artist).toLowerCase().includes(String(a.q).toLowerCase()) || a.q.length < 3), list: null, note: null }; }
    if (name === 'add') { const n = (a.tokens || []).length || 1; for (let i = 0; i < n; i++) MS.queue.push(song(i + 2)); MS.on = true; if (!MS.current) MS.current = MS.queue.shift(); return { added: n, skipped: 0, note: null, state: mState() }; }
    if (name === 'playlist') {
      if (a.op === 'create') { const p = { id: 'p' + Date.now(), name: a.name || 'New playlist', tracks: a.fromQueue ? [MS.current, ...MS.queue].filter(Boolean).map((t, i) => Object.assign({}, t, { id: 'n' + i })) : [], by: 'The launcher' }; MS.playlists.unshift(p); return { added: p.tracks.length, skipped: 0, playlist: pFull(p) }; }
      const p = MS.playlists.find((x) => x.id === a.id); if (!p) throw new Error('That playlist was deleted.');
      if (a.op === 'rename') { p.name = a.name; return { playlist: pFull(p) }; }
      if (a.op === 'delete') { MS.playlists = MS.playlists.filter((x) => x !== p); return { deleted: true }; }
      if (a.op === 'remove') { p.tracks = p.tracks.filter((t) => t.id !== a.trackId); return { playlist: pFull(p) }; }
      if (a.op === 'add') { (a.tokens || []).forEach((_, i) => p.tracks.push(Object.assign(song(i), { id: 'a' + Date.now() + i }))); return { added: 1, skipped: 0, playlist: pFull(p) }; }
      if (a.op === 'play') { MS.on = true; MS.queue = p.tracks.slice(1).map((t) => Object.assign({}, t, { uid: 'q' + t.id })); MS.current = Object.assign({}, p.tracks[0]); MS.startedAt = Date.now(); return { added: p.tracks.length, skipped: 0, note: null, state: mState() }; }
      if (a.op === 'import') throw new Error('Importing a playlist from a music site is not in the launcher yet.');
    }
    throw new Error('The preview does not know that.');
  }
  const mkSnap = (days) => { const rows = Array.from({ length: 34 }, (_, i) => ({ id: String(750000000000000000 + i), name: NAMES[i % 10] + (i > 9 ? i : ''), last: i % 4 === 0 ? null : `2026-0${1 + (i % 8)}-1${i % 9}`, total: i % 4 === 0 ? 0 : (i * 37) % 900, joined: Date.now() - (60 + i * 11) * 864e5, kickable: i % 13 !== 5, why: i % 4 === 0 ? 'never' : i % 11 === 3 ? 'unverified' : 'quiet' })); return { at: Date.now(), days, covered: 400, short: false, tiers: { all: rows.length, d60: 28, d90: 21, never: rows.filter((r) => r.why === 'never').length, unverified: rows.filter((r) => r.why === 'unverified').length }, rows }; };
  const IN = { on: true, snapshot: null, keeps: [], log: [], rules: { days: 30, ghostDays: 7, protectMessages: 50, unverifiedDays: 3, warn: true, auto: 'kick', autoMax: 25, grace: 6, reviewChannel: '1' } };
  const EC = { on: true, wallets: 311, treasury: { balance: 18420, collected: 61200, paid_out: 42780 }, week: [['tax:pay', 3200], ['tax:income', 1840], ['fee:exchange', 600], ['grant', -2000]], month: [['tax:income', 9100], ['tax:pay', 7400], ['tax:winnings', 3900], ['shop', 2500], ['fee:exchange', 1800], ['grant', -6000]],
    log: [{ at: Date.now() - 36e5, delta: -2000, kind: 'grant', user: '700000000000000003', note: 'Event winner' }, { at: Date.now() - 5 * 36e5, delta: 120, kind: 'tax:pay', user: '700000000000000001', note: null }, { at: Date.now() - 9 * 36e5, delta: 48, kind: 'fee:exchange', user: '700000000000000002', note: null }, { at: Date.now() - 20 * 36e5, delta: 500, kind: 'donation', user: '700000000000000004', note: 'for the party' }],
    top_gems: [{ user: '700000000000000002', gems: 120 }, { user: '700000000000000005', gems: 64 }],
    rates: { taxPay: 5, taxIncome: 0, taxWithdraw: 2, taxWinnings: 10, shopToTreasury: true, gemsEnabled: true, gemName: 'gems', gemEmoji: '💎', exchangeRate: 100, exchangeFee: 5, currencyName: 'coins', currencyEmoji: '🪙' } };
  const PEOPLE = ['kai', 'mo', 'juniper', 'ash', 'rue', 'tobi', 'lin', 'ozzy', 'pia', 'dex', 'Kaitlyn B', 'Rowan'].map((name, i) => ({ id: String(700000000000000000 + i), name, avatar: null, bot: false })).concat([{ id: '700000000000000099', name: 'HelperBot', avatar: null, bot: true }]);
  const LEAVERS = [
    { id: 1, user: '710000000000000001', name: 'ShadowFox', avatar: null, left_at: Date.now() - 2 * 36e5, joined_at: Date.now() - 20 * 36e5, roles: [], how: 'left', by: null, reason: null, strikes: 0, cases: 0, flags: ['left within a day of joining'], returned_at: null },
    { id: 2, user: '710000000000000002', name: 'xX_raider_Xx', avatar: null, left_at: Date.now() - 30 * 36e5, joined_at: Date.now() - 400 * 36e5, roles: ['r1'], how: 'left', by: null, reason: null, strikes: 2, cases: 3, flags: ['was timed out when they left', 'had 2 warnings in the last 30 days', 'is on the staff watch list'], returned_at: null },
    { id: 3, user: '710000000000000003', name: 'Jamie', avatar: null, left_at: Date.now() - 4 * 864e5, joined_at: Date.now() - 200 * 864e5, roles: ['r1', 'r2'], how: 'kicked', by: '700000000000000001', reason: 'Raiding', strikes: 1, cases: 2, flags: ['had 1 warning in the last 30 days'], returned_at: Date.now() - 2 * 864e5 },
    { id: 4, user: '710000000000000004', name: 'Casey', avatar: null, left_at: Date.now() - 9 * 864e5, joined_at: Date.now() - 31 * 864e5, roles: ['r1'], how: 'banned', by: '700000000000000002', reason: 'Scam links', strikes: 0, cases: 1, flags: [], returned_at: null },
    { id: 5, user: '710000000000000005', name: 'Morgan', avatar: null, left_at: Date.now() - 22 * 864e5, joined_at: Date.now() - 300 * 864e5, roles: ['r1', 'r3'], how: 'left', by: null, reason: null, strikes: 0, cases: 0, flags: [], returned_at: null },
  ];
  const SHOP = { max: 25, roles: [{ id: 'r1', name: 'Member' }, { id: 'r2', name: 'VIP' }, { id: 'r3', name: 'Gamer' }], items: [{ id: 'vip', name: 'VIP', emoji: '⭐', price: 9000, role_id: 'r2', hours: 24, stock: null, description: 'Perks for a day', message: null, consumable: false }, { id: 'golden-bone', name: 'Golden Bone', emoji: '🦴', price: 5000, role_id: null, hours: 0, stock: 10, description: null, message: '{user} polished it', consumable: true }] };
  const online = () => ({ phase: 'online', name: 'Good Boy Test', servers: S.servers.length, online_since_ms: Date.now(), start_took_ms: 1180, problem: null, notice: q.has('notice') ? 'Message Content is switched off on the bot\'s page, so counting cannot see numbers. Everything else works. Turn it on under Bot > Privileged Gateway Intents, then restart.' : null });
  const stopped = () => ({ phase: 'stopped', name: null, servers: 0, online_since_ms: null, start_took_ms: null, problem: null });
  const FEED = {};
  const FEED_START = [['member', 'juniper joined the server'], ['command', 'kai used /rank in #bot-commands'], ['level', 'kai reached level 12'], ['command', 'mo used /music play in #bot-commands'], ['music', 'Now playing: Night Drive (added by mo)'],
    ['ticket', 'ash opened ticket #058 (Report a member)'], ['mod', 'tobi was warned by rue (case #42)'], ['command', 'lin used /daily in #general'], ['giveaway', 'Giveaway #7 (Nitro Classic) ended with 2 winners'],
    ['ticket', 'Ticket #057 was closed by rue'], ['mod', 'dex was timed out automatically (case #43)'], ['member', 'ozzy left the server'], ['command', 'pia used /fish in #bot-commands']];
  const PANELS = {
    giveaways: { id: 'giveaways', title: 'Giveaways', empty: 'No giveaways yet.', rows: [{ id: '7', title: '#7 Discord Nitro', lines: ['12 entries', 'ends 2026-11-20 18:00'], actions: [{ id: 'end', label: 'End now', ask: 'End it now?' }] }, { id: '6', title: '#6 5,000 coins', lines: ['40 entries', 'ended 2026-11-10 12:00', 'won by Kai'], actions: [{ id: 'reroll', label: 'Pick another winner' }] }] },
    commands: { id: 'commands', title: 'Custom commands', empty: 'No custom commands yet.', rows: [{ id: 'rules', title: 'rules', lines: ['command', 'used 41 times'], actions: [{ id: 'delete', label: 'Delete', ask: 'Delete?' }] }, { id: 'hello', title: 'hello', lines: ['message starts with', 'used 7 times'], actions: [{ id: 'delete', label: 'Delete', ask: 'Delete?' }] }] },
    inviters: { id: 'inviters', title: 'Top inviters', empty: 'None yet.', rows: [{ id: '1', title: '1. kai', lines: ['14 still here', '18 joined'], actions: [] }] },
    counting: { id: 'counting', title: 'Counting and word chain', empty: 'None yet.', rows: [{ id: '1', title: '#counting', lines: ['counting game', 'now at 212', 'best 480'], actions: [] }] },
    backups: { id: 'backups', title: 'Backups', empty: 'None yet.', rows: [{ id: '3', title: 'Backup #3', lines: ['2026-11-15 04:00', '24 roles, 31 channels', 'made automatically'], actions: [] }] },
  };
  const PERMS = { roles: [{ id: '1', name: 'Staff' }, { id: '2', name: 'Helpers' }, { id: '3', name: 'Gamers' }], permissions: [
    { key: 'moderation.warn', label: 'Warn members', default: 'moderator', group: 'moderation', roles: [] },
    { key: 'moderation.ban', label: 'Ban / unban', default: 'moderator', group: 'moderation', roles: ['1'] },
    { key: 'economy.use', label: 'Use the economy (balance, daily, pay, leaderboard)', default: 'everyone', group: 'economy', roles: [] },
    { key: 'giveaways.manage', label: 'Start, end and reroll giveaways', default: 'admin', group: 'giveaways', roles: [] }] };
  const A = {
    overview: () => ({ version: '4.0.0', prefs: S.prefs, data_folder: 'C:\\Users\\you\\AppData\\Roaming\\Good Boy 4\\data', data: S.data, old_data: S.data ? null : S.old,
      licence: LICENCE(), perks: { own_colours: !!S.licence },
      web_status: { on: S.prefs.web_on, running: S.prefs.web_on && !!S.prefs.web_address, error: S.prefs.web_on && !S.prefs.web_address ? 'Write the public address first (the link people will open).' : null, port: S.prefs.web_port, address: S.prefs.web_address, all: S.prefs.web_all }, token_saved: S.token, secret_saved: S.secret, keeps_secrets: true, secret_store: 'Windows Credential Manager', live: S.live, modules: S.modules }),
    prefs_set: ({ patch }) => { const { colours, ...rest } = patch; Object.assign(S.prefs, rest); if (colours) { if (!S.licence && !(colours.on === false && Object.keys(colours).length === 1)) throw new Error('Your own colours are a supporter perk. Add a Supporter licence in Settings to use them.'); Object.assign(S.prefs.colours, colours); delete S.prefs.colours.reset; } return S.prefs; },
    licence_set: ({ key }) => { const k = String(key || '').trim(); if (k && !/^GB1\.[\w-]+\.[\w-]+$/.test(k)) throw new Error('That is not a Good Boy licence key.'); S.licence = k; return LICENCE(); },
    licence_refresh: () => LICENCE(),
    setup_data: async ({ copy }) => { await wait(500); const c = copy && S.old; S.data = c ? { servers: 2, modules_on: 31, settings: 148, records: 12840 } : { servers: 0, modules_on: 0, settings: 0, records: 0 }; if (!c) S.servers = []; return Object.assign({ how: c ? 'copied' : 'fresh', files: c ? 12 : 0 }, S.data); },
    images_view: async () => { await wait(80); return { welcome: S.pics?.welcome ? { has: true, name: 'welcome-1.png', size: 12345, preview: S.pics.welcome } : { has: false }, goodbye: S.pics?.goodbye ? { has: true, name: 'goodbye-1.png', size: 12345, preview: S.pics.goodbye } : { has: false } }; },
    // an approximation of the picture (the real one is drawn by the program); enough to try the screen
    greeting_preview: async ({ guild, kind, tried }) => {
      await wait(60);
      const t = (x) => String(x || '').replace(/\{username\}/g, 'Alex').replace(/\{server\}/g, 'Ghost Town').replace(/\{count\}/g, '123').replace(/\{user\}/g, '@Alex');
      const bg = { dark: ['#151a26', '#0f131c'], light: ['#f6f8fc', '#e4e9f2'], midnight: ['#0b1030', '#1d0b33'], sunset: ['#3b1630', '#5c2a14'], forest: ['#0e2a1b', '#17331f'], ocean: ['#0a2338', '#063a40'], candy: ['#3a1838', '#24194a'] }[tried.theme] || ['#0b1030', '#1d0b33'];
      const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="360"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg[0]}"/><stop offset="1" stop-color="${bg[1]}"/></linearGradient></defs><rect width="1000" height="360" rx="28" fill="url(#g)"/><circle cx="500" cy="118" r="80" fill="${tried.accent || '#6b93ff'}"/><text x="500" y="252" font-size="46" font-weight="800" fill="#fff" text-anchor="middle" font-family="sans-serif">${esc(t(tried.title))}</text><text x="500" y="298" font-size="24" fill="#cbd" text-anchor="middle" font-family="sans-serif">${esc(t(tried.line))}</text><rect y="346" width="1000" height="14" fill="${tried.accent || '#6b93ff'}"/></svg>`;
      return { text: t(tried.message), image: tried.look === 'card' ? 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg))) : null, has_picture: !!(S.pics && S.pics[kind]) };
    },
    setup_view: async () => {
      await wait(80);
      const tree = (s) => s.map(([name, priv, ch]) => ({ name, private: priv, channels: ch.map(([n, v, ro, pr]) => ({ name: n, voice: !!v, read_only: !!ro, private: !!pr })) }));
      const community = tree([['Info', false, [['welcome', 0, 1], ['rules', 0, 1], ['announcements', 0, 1]]], ['Community', false, [['general'], ['introductions'], ['media'], ['bot-commands'], ['suggestions']]], ['Voice', false, [['General', 1], ['Music', 1], ['Chill', 1]]], ['Support', false, [['open-a-ticket', 0, 1]]], ['Staff', true, [['staff-chat', 0, 0, 1], ['mod-log', 0, 0, 1], ['server-log', 0, 0, 1], ['ticket-log', 0, 0, 1]]]]);
      return { fixes: [['connect', 'Connect these channels'], ['empty', 'Remove the empty categories'], ['everyone', 'Take these away from everyone'], ['logs', 'Add a logs area']], scan: S.scan || null, last: S.lastSetup || null,
        layouts: [{ id: 'community', name: 'Community', about: 'A friendly general server with info, chat, voice, tickets and a staff area.', roles: ['Admin', 'Moderator'], channels: 15, tree: community, modules: ['Moderation', 'Welcome', 'Levels', 'Tickets'] },
          { id: 'gaming', name: 'Gaming', about: 'Looking-for-group, clips, squad voice rooms and everything in Community.', roles: ['Admin', 'Moderator'], channels: 19, tree: community, modules: ['Moderation', 'Welcome', 'Levels', 'Tickets', 'Party finder'] },
          { id: 'small', name: 'Small group of friends', about: 'Just the basics, kept simple.', roles: ['Admin', 'Moderator'], channels: 6, tree: tree([['Text', false, [['general'], ['memes']]], ['Voice', false, [['Hangout', 1]]]]), modules: ['Moderation', 'Welcome', 'Levels'] }] };
    },
    setup_run: async ({ step, what }) => {
      await wait(150);
      if (step === 'scan') setTimeout(() => { S.scan = { at: Date.now(), channels: 24, roles: 9, findings: [
        { id: 'everyone', level: 'warn', title: 'Everyone has powers they should not', detail: 'The @everyone role can: Mention @everyone, Manage Messages. Anyone who joins gets these.', fix: 'everyone' },
        { id: 'logs', level: 'warn', title: 'No moderation log', detail: 'Warnings, bans and timeouts have nowhere to be written down. Add a staff-only logs area.', fix: 'logs' },
        { id: 'connect', level: 'tip', title: '2 channels the bot is not using yet', detail: '#welcome looks like the welcome channel; #introductions looks like the introductions channel. Connect them so the bot posts there.', fix: 'connect' },
        { id: 'empty', level: 'tip', title: '1 empty category', detail: 'Old Stuff has nothing in it. They only add clutter to the channel list.', fix: 'empty' },
        { id: 'quiet', level: 'tip', title: '2 channels with no messages for 3 months', detail: '#old-news, #test. Archive or delete the ones nobody uses.', fix: null }] }; }, 1200);
      else S.lastSetup = null, setTimeout(() => { S.lastSetup = { at: Date.now(), what: step, text: step === 'build' ? 'Added 2 roles and 15 channels. Welcome messages → #welcome; Moderation log → #mod-log; Turned on Moderation' : 'Done.' }; if (step === 'fix') { S.scan = { ...S.scan, at: Date.now(), findings: S.scan.findings.filter((f) => f.fix !== what) }; } }, 1200);
    },
    eclipse_view: async () => { await wait(60); return { cards: 14, here: 31, picked: 9, auto: true, presence: false }; },
    commands_guide: async () => ({ groups: [], modules: [
      { id: 'moderation', name: 'Moderation', about: 'Warn, time out, kick and ban, with a history for every member.', commands: [
        { name: 'ban', path: '/mod → ban', about: 'Ban a user', staff: false, note: null, options: [{ name: 'user', about: 'Who', required: true, takes: 'a member' }, { name: 'reason', about: 'Why', required: false, takes: 'text' }], subs: [] }] },
      { id: 'member-management', name: 'Welcome', about: 'Welcome and goodbye messages with a picture.', commands: [
        { name: 'images', path: '/server → images', about: "The server's picture gallery", staff: true, note: 'Every picture saved for the bot lives here so it can be used again.', options: [], subs: [{ name: 'list', about: 'See the saved pictures', staff: false, options: [] }, { name: 'use', about: 'Use a saved picture', staff: false, options: [{ name: 'number', about: 'Its number', required: true, takes: 'a whole number from 1 to 60' }] }] }] },
    ] }),
    gallery_view: async () => {
      await wait(80);
      const list = (S.gallery ||= []);
      const slots = [['welcome', 'Welcome message'], ['goodbye', 'Goodbye message'], ['rank', 'Rank card background for everyone']];
      return { max: 60, slots, pictures: list.map((p) => ({ id: p.id, name: p.name, size: p.size, at: p.at, preview: p.data, uses: slots.map((x) => x[0]).filter((k) => (k === 'rank' ? S.rankBg : S.pics?.[k]) === p.data) })) };
    },
    gallery_add: async ({ name, data }) => {
      await wait(120);
      if (!/\.(png|jpe?g|gif|webp)$/i.test(name)) throw new Error('Use a PNG, JPG, GIF or WebP picture.');
      const list = (S.gallery ||= []);
      if (list.length >= 60) throw new Error('The gallery is full (60 pictures). Remove one first.');
      const id = `${Date.now()}-${list.length}.png`;
      list.push({ id, name: name.replace(/\.[^.]+$/, ''), size: Math.round(data.length * 0.75), at: Date.now(), data });
      return id;
    },
    gallery_rename: async ({ id, name }) => { await wait(60); const p = (S.gallery || []).find((x) => x.id === id); if (!p) throw new Error('That picture is not in the gallery.'); p.name = name; },
    gallery_remove: async ({ id }) => { await wait(60); S.gallery = (S.gallery || []).filter((x) => x.id !== id); },
    gallery_use: async ({ id, slot }) => {
      await wait(80);
      const p = (S.gallery || []).find((x) => x.id === id); if (!p) throw new Error('That picture is not in the gallery.');
      if (slot === 'rank') S.rankBg = p.data; else (S.pics ||= {})[slot] = p.data;
    },
    gallery_stop: async ({ slot }) => { await wait(60); if (slot === 'rank') S.rankBg = null; else if (S.pics) delete S.pics[slot]; },
    greeting_image_set: async ({ kind, name, data }) => { await wait(150); if (!/\.(png|jpe?g|gif|webp)$/i.test(name)) throw new Error('Use a PNG, JPG, GIF or WebP picture.'); (S.pics ||= {})[kind] = data; },
    greeting_image_clear: async ({ kind }) => { await wait(80); (S.pics ||= {})[kind] = null; },
    critters_view: async () => { await wait(80); return { characters: (S.critters ||= [{ id: 'mister-nine', name: 'Mister Nine', element: 'fire', rarity: 'rare', hp: 80, atk: 70, def: 60, spd: 90, picture: null }]), types: [['🔥 Fire', 'fire'], ['💧 Water', 'water'], ['🍃 Leaf', 'leaf'], ['⚡ Spark', 'spark']], rarities: [['Common', 'common'], ['Rare', 'rare'], ['Legendary', 'legendary']], most: 200 }; },
    critter_save: async ({ editing, name, element, rarity, hp, atk, def, spd, picture, link, data }) => { await wait(150); const list = (S.critters ||= []); if (!String(name).trim()) throw new Error('Give it a name with letters or numbers.'); const id = editing || String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-'); const old = list.find((c) => c.id === id); const pic = picture === 'file' ? { kind: 'file', preview: data } : picture === 'link' ? { kind: 'link', preview: link, link } : picture === 'remove' ? null : (old ? old.picture : null); const one = { id, name: String(name).trim(), element, rarity, hp, atk, def, spd, picture: pic }; if (old) Object.assign(old, one); else list.push(one); return `Saved **${one.name}**. The roster has ${list.length} characters.`; },
    critter_remove: async ({ id }) => { await wait(80); S.critters = (S.critters || []).filter((c) => c.id !== id); return 'Removed.'; },
    pulse: async () => {
      const hourMs = 3600000, n = 14 * 24, from = Math.floor(Date.now() / hourMs) * hourMs - (n - 1) * hourMs;
      const members = [], voice = [], messages = [];
      for (let i = 0; i < n; i++) { members.push(i < 30 ? null : 1180 + Math.round(i / 6) + (i % 7)); voice.push(Math.max(0, Math.round(6 + 5 * Math.sin(i / 3.5) + (i % 5)))); messages.push(i < 30 ? null : Math.max(0, Math.round(40 + 35 * Math.sin(i / 3.8) + (i * 7919 % 23)))); }
      return { from, hourMs, members, voice, messages, now: { members: 1342, voice: 9 }, uptime_seconds: 5400 };
    },
    health: async () => { await wait(300); return { bad: 0, warn: 2, checks: [{ level: 'good', title: 'Bot token', detail: 'A token is saved.' }, { level: 'good', title: 'Connection', detail: 'Online as Good Boy Test in 2 servers.' }, { level: 'good', title: 'Data', detail: '2 servers, 12,840 saved records.' }, { level: 'warn', title: 'Ghost Town: modules', detail: 'The economy module is off, so coins, shop, fishing and the games say they need it. Switch it on in Modules.' }, { level: 'warn', title: 'Ghost Town: permissions', detail: 'The bot lacks: Manage Roles, Speak (music). Some commands will fail.' }] }; },
    v3_status: () => ({ found: true, folder: 'C:\\Users\\you\\AppData\\Roaming\\Good Boy\\bot-data', v3: { servers: 2, records: 12840, settings: 148 }, v4: S.data ? { servers: 2, records: 12840, settings: 148 } : null, running: !!(S.live && S.live.phase === 'online'), data_folder: 'C:\\Users\\you\\AppData\\Roaming\\Good Boy 4\\data' }),
    v3_folder_set: async ({ path }) => { await wait(200); if (!/eclipse|bot-data/i.test(path)) throw 'There is no eclipse.db in that folder.'; return A.v3_status(); },
    v3_recopy: async () => { await wait(700); const had = !!S.data; S.data = { servers: 2, modules_on: 31, settings: 148, records: 12840 }; return { servers: 2, settings: 148, records: 12840, kept: had ? 'C:\\Users\\you\\AppData\\Roaming\\Good Boy 4\\data\\before-recopy\\1794900000' : null }; },
    v3_check: async () => { await wait(500); return { rows: [{ table: 'levels', v3: 5120, v4: 5120, state: 'same' }, { table: 'economy_wallets', v3: 1900, v4: 1912, state: 'more' }, { table: 'mod_cases', v3: 240, v4: 240, state: 'same' }], problems: 0, v3_ok: true, v4_ok: true }; },
    token_test: async ({ token }) => { await wait(500); if (token && !tokenLike(token)) throw 'That does not look like a bot token (it has three parts separated by dots). Press Reset Token on the Bot page and copy it again.'; if (!token && !S.token) throw 'No bot token is saved yet.'; return { id: '300000000000000001', name: 'Good Boy Test' }; },
    token_save: async ({ token }) => { await wait(600); if (!tokenLike(token)) throw 'That does not look like a bot token (it has three parts separated by dots). Press Reset Token on the Bot page and copy it again.'; S.token = true; return { id: '300000000000000001', name: 'Good Boy Test', kept: true, restarted: S.live.phase === 'online' }; },
    helpers_list: async () => ({ helpers: S.helpers || [], most: 9 }),
    helper_add: async ({ token }) => { await wait(500); if (!tokenLike(token)) throw 'That does not look like a bot token (it has three parts separated by dots).'; S.helpers = S.helpers || []; const n = S.helpers.length + 1; const b = { slot: n, name: 'Music bot ' + n, id: '30000000000000010' + n, invite: 'https://discord.com/oauth2/authorize?client_id=30000000000000010' + n + '&scope=bot&permissions=3146752', problem: null }; S.helpers.push(b); return { ...b, kept: true, restarted: false }; },
    helper_remove: async ({ slot }) => { S.helpers = (S.helpers || []).filter((b) => b.slot !== slot); },
    token_forget: () => { S.token = false; S.live = stopped(); },
    secret_save: ({ secret }) => { if (secret.trim().length < 24 || secret.includes('.')) throw 'That does not look like a client secret. Copy it again from the OAuth2 page (press Reset Secret to get a new one).'; S.secret = true; },
    secret_forget: () => { S.secret = false; },
    bot_start: () => { if (!S.token) throw 'Add your bot\'s token first (Settings).'; S.live = Object.assign(stopped(), { phase: 'starting' }); setTimeout(() => { S.live = online(); }, 1200); },
    bot_stop: () => { S.live = stopped(); },
    bot_restart: () => { A.bot_start(); },
    update_status: async () => ({ current: '4.0.1', available: { version: '4.0.2', notes: '- A small fix.', size: 31457280 }, percent: null, can_install: true }),
    update_check: async () => { await wait(300); return { current: '4.0.1', available: { version: '4.0.2', notes: '- A small fix.', size: 31457280 }, percent: null, can_install: true }; },
    update_install: async () => { await wait(600); return { version: '4.0.2' }; },
    whatsnew: async () => { await wait(100); return { version: '4.0.0', sections: [{ title: 'Colour pickers', body: '- A real colour picker in the dashboard.\n- Swatches in Discord.' }, { title: 'Ticket search and transcripts', body: '- Search every ticket.' }] }; },
    announce_restart: async () => { await wait(200); return 2; },
    brand_status: async () => { await wait(150); return { licensed: false, name: 'Test Bot', description: '', missing: ['avatar', 'banner'], done: false, good_boy_name: 'Good Boy' }; },
    brand_keep: async () => { await wait(300); return { changed: ['avatar', 'banner'], problems: {} }; },
    brand_custom: async () => { await wait(300); return null; },
    panel_preview: async ({ module, title, text }) => {
      const cats = [['🚨', 'Scam, phishing or hacked account', 4, true], ['🛡️', 'Harassment, threats or safety concern', 4, true], ['📣', 'Report a member', 1], ['⚖️', 'Ban, mute or warning appeal', 2], ['🛠️', 'Problem with the bot or a channel', 2], ['🔑', 'Role, verification or access help', 2], ['🤝', 'Partnership or business', 2], ['❓', 'Question or other', 2]];
      if (module === 'music') return { components: [{ type: 17, accent_color: 0xeb459e, components: [{ type: 10, content: '### 🎵 Music\nNothing is playing. Press **Add** or use `/music play` while you\'re in a voice channel.\n-# 🔊 70% · Repeat off · 0 in queue' }, { type: 1, components: ['⏮️ Back', '⏸️ Pause', '⏭️ Skip', '⏹️ Stop', '➕ Add'].map((l, k) => ({ type: 2, style: k === 1 ? 1 : k === 3 ? 4 : k === 4 ? 3 : 2, label: l.slice(3), emoji: { name: l.slice(0, 2) } })) }] }] };
      return { components: [{ type: 17, accent_color: 0x7b9dff, components: [{ type: 10, content: `### ${title || 'Need help?'}\n${text || ''}\n\n${cats.map((c) => `${c[0]} **${c[1]}**${c[3] ? ' *(urgent)*' : ''}`).join('\n')}` },
        ...[cats.slice(0, 5), cats.slice(5)].map((row) => ({ type: 1, components: row.map((c) => ({ type: 2, style: c[2], label: c[1], emoji: { name: c[0] } })) }))] }] };
    },
    post_panel: async ({ channel }) => { await wait(400); if (S.live.phase !== 'online') throw new Error('Start the bot first: it posts this in Discord.'); return null; },
    dashboard: async ({ guild }) => { await wait(150); return { members: 1284, wallets: 311, ranked: 902, richest: 48210, tickets: { open: 3, total: 57 }, cases: 41, recent_cases: CASES.slice(0, 6), boards: BOARDS(5) }; },
    cases: async ({ limit }) => {
      await wait(150);
      // the same numbers the program works out (desk.rs case_stats)
      const now = Date.now(), DAY = 864e5, kinds = {}, days = Array.from({ length: 30 }, (_, ago) => ({ ago, counts: {} })), mods = {}, members = {};
      for (const c of CASES) {
        const ago = now - c.at, k = (kinds[c.type] = kinds[c.type] || { day: 0, week: 0, month: 0, all: 0 });
        k.all++; if (ago < DAY) k.day++; if (ago < 7 * DAY) k.week++; if (ago < 30 * DAY) { k.month++; const d = days[Math.floor(ago / DAY)].counts; d[c.type] = (d[c.type] || 0) + 1; }
        const m = (mods[c.modId || 'auto'] = mods[c.modId || 'auto'] || { id: c.modId || 'auto', count: 0, last: 0, kinds: {} }); m.count++; m.last = Math.max(m.last, c.at); m.kinds[c.type] = (m.kinds[c.type] || 0) + 1;
        const p = (members[c.targetId] = members[c.targetId] || { id: c.targetId, name: c.targetTag, count: 0, last: 0, warnings: 0 }); p.count++; p.last = Math.max(p.last, c.at); if (c.type === 'warn') p.warnings++;
      }
      const top = (o) => Object.values(o).sort((a, b) => b.count - a.count || b.last - a.last).slice(0, 10);
      return { total: CASES.length, cases: CASES.slice(0, limit || 50), stats: { kinds, days, mods: top(mods), members: top(members), people: Object.keys(members).length } };
    },
    staff_action: async ({ kind, user, reason }) => { await wait(300); if (!/^\d{15,}$/.test(user)) throw new Error('Use the member\'s Discord ID.'); CASES.unshift({ id: CASES.length + 1, type: kind, targetId: user, targetTag: 'new', modId: '1', reason, at: Date.now() }); return `Case #${CASES.length} recorded.`; },
    tickets: async ({ limit, find }) => { await wait(150); const q = (find || '').toLowerCase(); const T = TK().filter((t) => !q || JSON.stringify(t).toLowerCase().includes(q)); return { open: T.filter((t) => t.open).length, total: T.length, tickets: T.slice(0, limit || 100).map((t) => Object.assign({}, t)) }; },
    ticket_transcript: async ({ number, html }) => { await wait(150); return { file: `ticket-${String(number).padStart(3, '0')}.${html ? 'html' : 'txt'}`, content: html ? `<!doctype html><title>Ticket #${number}</title><p>Sample transcript</p>` : `Ticket #${number}\n\nSample transcript` }; },
    ticket_view: async ({ number }) => { await wait(120); const t = TK().find((x) => x.number === number); if (!t) throw new Error('There is no ticket with that number.'); return { ticket: Object.assign({}, t), messages: (S.tkMsgs[number] ||= [{ id: 'a', author: t.opener, bot: false, text: 'Hi, I need some help with this. Can someone look?', files: [], at: t.opened_at + 1000, deleted: false }, { id: 'b', author: { name: 'Good Boy' }, bot: true, text: 'Opened by ' + t.opener.name + '. Staff will be with you shortly.', files: [], at: t.opened_at + 2000, deleted: false }]).map((m) => Object.assign({}, m, { author: m.author })) }; },
    ticket_action: async ({ number, what, text }) => { await wait(150); const t = TK().find((x) => x.number === number); if (!t || !t.open) throw new Error('That ticket is already closed.'); const me = { id: 'me', name: 'Mod Maya' };
      if (what === 'claim') { const mine = t.claimed_by && t.claimed_by.id === 'me'; t.claimed_by = mine ? null : me; return mine ? 'Released.' : 'Claimed.'; }
      if (what === 'reply') { if (!String(text).trim()) throw new Error('Write something to send.'); (S.tkMsgs[number] ||= []).push({ id: 'r' + Date.now(), author: { name: me.name }, bot: true, text: '💬 Staff reply from ' + me.name + '\n' + text, files: [], at: Date.now(), deleted: false }); if (t.first_response_ms == null) t.first_response_ms = Date.now() - t.opened_at; return 'Sent.'; }
      if (what === 'close') { if (!String(text).trim()) throw new Error('Say how it was resolved: it is kept in the staff log.'); t.open = false; t.closed_at = Date.now(); t.kind = 'staff'; t.closed_by = me; t.resolution = text; return 'Closed.'; }
      throw new Error('That is not something a ticket can do from here.'); },
    commands_view: async () => { await wait(80); const f = (id, label, kind, extra = {}) => Object.assign({ id, label, desc: null, kind, required: false, long: false, max: 0, placeholder: null }, extra); return { commands: [
      { name: 'balance', about: 'See your coins', module: 'economy', module_name: 'Money', discord: '/money → balance', own_popup: false, fields: [f('member', 'Member', 'member')], subs: [] },
      { name: 'daily', about: 'Claim the daily reward', module: 'economy', module_name: 'Money', discord: '/money → daily', own_popup: false, fields: [], subs: [] },
      { name: 'ban', about: 'Ban a member', module: 'moderation', module_name: 'Moderation', discord: '/mod → ban', own_popup: false, fields: [f('member', 'Member', 'member', { required: true }), f('reason', 'Reason', 'text', { long: true, required: true })], subs: [] },
      { name: 'starboard', about: 'Starboard settings', module: 'engagement', module_name: 'Announcements, polls and suggestions', discord: '/starboard', own_popup: false, fields: [], subs: [
        { name: 'setup', about: 'Turn the starboard on', own_popup: false, fields: [f('channel', 'Channel', 'channel', { required: true, types: [0, 5] }), f('emoji', 'Emoji to count', 'text')] },
        { name: 'disable', about: 'Turn it off', own_popup: false, fields: [] }] },
      { name: 'greeting', about: 'Welcome and goodbye', module: 'member-management', module_name: 'Welcome', discord: '/server → greeting', own_popup: true, fields: [], subs: [] },
    ] }; },
    directory: async () => { await wait(40); return { channels: [{ id: '800000000000000001', name: 'general', kind: 'text' }, { id: '800000000000000002', name: 'Lounge', kind: 'voice' }, { id: '800000000000000009', name: 'Text', kind: 'category' }], roles: [{ id: 'r1', name: 'Member' }, { id: 'r2', name: 'Mod' }] }; },
    command_run: async ({ name, sub, values }) => { await wait(150); if (name === 'ban' && !values.member) throw new Error('Fill in **Member**.'); return { said: [name === 'daily' ? '🪙 You claimed 100 coins.' : name === 'starboard' && sub === 'setup' ? `⭐ Starboard is on: <#${values.channel}>.` : `Ran /${name}${sub ? ' ' + sub : ''}.`], note: name === 'ban' ? 'This also posts or changes something in Discord. That happens once the bot is running.' : null }; },
    music_api: async ({ kind, name, args }) => { await wait(120); return MUSIC(kind, name, args || {}); },
    inactive_scan: async ({ days }) => { await wait(900); IN.snapshot = mkSnap(days || 30); },
    inactive_view: async () => { await wait(100); return IN; },
    inactive_kick: async ({ ids }) => { await wait(300); const gone = IN.snapshot.rows.filter((r) => ids.includes(r.id)); IN.snapshot.rows = IN.snapshot.rows.filter((r) => !ids.includes(r.id)); IN.log.unshift({ at: Date.now(), by: '1', count: gone.length, how: 'launcher', members: gone.map((g) => ({ id: g.id, name: g.name })) }); return ids.length; },
    inactive_keep: async ({ user, keep }) => { await wait(100); if (keep) { IN.keeps.unshift({ id: user, at: Date.now() }); IN.snapshot.rows = IN.snapshot.rows.filter((r) => r.id !== user); } else IN.keeps = IN.keeps.filter((k) => k.id !== user); },
    economy: async () => { await wait(120); return EC; },
    treasury_add: async ({ amount, note }) => { await wait(200); if (!(amount > 0)) throw new Error('Type an amount from 1 to 1,000,000,000,000.'); EC.treasury.balance += amount; EC.treasury.collected += amount; EC.log.unshift({ at: Date.now(), delta: amount, kind: 'staff', note }); return EC.treasury.balance; },
    treasury_give: async ({ amount, reason }) => { await wait(200); if (!reason) throw new Error('Give a reason: it is kept in the treasury\'s record.'); if (amount > EC.treasury.balance) throw new Error('The treasury only has ' + EC.treasury.balance.toLocaleString() + ' 🪙.'); EC.treasury.balance -= amount; EC.treasury.paid_out += amount; EC.log.unshift({ at: Date.now(), delta: -amount, kind: 'grant', user: '700000000000000001', note: reason }); return EC.treasury.balance; },
    members_lookup: async ({ ids }) => { await wait(60); const out = {}; const MODS = { '900000000000000001': 'Kai', '900000000000000002': 'Juniper', '900000000000000003': 'Mo' }; for (const id of ids) { const m = PEOPLE.find((x) => x.id === id); if (m) out[id] = m.name; else if (MODS[id]) out[id] = MODS[id]; } return out; },
    members_search: async ({ q }) => { await wait(80); const s = String(q || '').toLowerCase(); return PEOPLE.filter((m) => !m.bot && m.name.toLowerCase().includes(s)).slice(0, 12); },
    leavers: async ({ days, q }) => { await wait(120); const s = String(q || '').toLowerCase(); return { keeps: true, days: 60, members: PEOPLE.length, roles: { r1: 'Member', r2: 'Gamer', r3: 'Mod' }, leavers: LEAVERS.filter((l) => Date.now() - l.left_at < days * 864e5 && (!s || l.name.toLowerCase().includes(s))) }; },
    leaver_forget: async ({ user }) => { await wait(100); const i = LEAVERS.findIndex((l) => l.user === user); if (i >= 0) LEAVERS.splice(i, 1); return 1; },
    panel: async ({ panel }) => { await wait(120); return PANELS[panel] ? JSON.parse(JSON.stringify(PANELS[panel])) : { id: panel, title: panel, empty: 'Nothing here.', rows: [] }; },
    panel_action: async ({ panel, row }) => { PANELS[panel].rows = PANELS[panel].rows.filter((r) => r.id !== row); },
    permissions: async () => { await wait(120); return PERMS; },
    permission_set: async ({ key, roles }) => { PERMS.permissions.find((p) => p.key === key).roles = roles; },
    role_menus: async () => { await wait(100); return { menus: S.roleMenus.slice() }; },
    role_menu_delete: async ({ message }) => { S.roleMenus = S.roleMenus.filter((m) => m.message !== message); },
    shop: async () => { await wait(100); return SHOP; },
    shop_save: async ({ name, price, emoji, role, hours, stock, text, consumable }) => { await wait(150); if (!name.trim()) throw new Error('Give the item a name with letters or numbers.'); if (price < 1) throw new Error('The price must be at least 1.'); const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-'); const it = { id, name, emoji, price, role_id: role, hours: role ? hours : 0, stock, description: role ? text : null, message: role ? null : text, consumable: !role && consumable }; const k = SHOP.items.findIndex((x) => x.id === id); if (k >= 0) SHOP.items[k] = it; else SHOP.items.push(it); return k >= 0 ? `Updated ${name}.` : `Added ${name} to the shop.`; },
    shop_remove: async ({ id }) => { await wait(80); SHOP.items = SHOP.items.filter((i) => i.id !== id); },
    boards: async ({ limit }) => { await wait(100); return BOARDS(limit || 10); },
    servers: () => S.servers.map((g) => ({ id: g.id, name: g.name, waiting: g.waiting, modules: S.modules.map((m) => Object.assign({ on: !!g.on[m.id], needs_setup: !!g.on[m.id] && ['moderation', 'support'].includes(m.id) && !S.values[g.id + m.id + 'logChannel'], commands: CMDS[m.id] || [] }, m)) })),
    module_set: ({ guild, module, on }) => { S.servers.find((g) => g.id === guild).on[module] = on; },
    settings: ({ guild, module }) => ({ settings: DEFS[module].map((d) => Object.assign({ value: S.values[guild + module + d.key] ?? d.default, group: GROUP(module, d.key) }, d)), channels: S.live.phase === 'online' ? CHANNELS : [], roles: [] , off_channels: (S.off ||= {})[guild + module] || [], permissions: PERMS.permissions.filter((p) => p.group === module).map((p) => JSON.parse(JSON.stringify(p))) }),
    off_channels_set: ({ guild, module, channels }) => { (S.off ||= {})[guild + module] = channels; return channels; },
    setting_set: ({ guild, module, key, value }) => { const d = DEFS[module].find((x) => x.key === key); if (d.kind === 'number') { const n = Number(value); if (!Number.isInteger(n) || n < d.min || n > d.max) throw `"${d.label}" must be a number between ${d.min} and ${d.max}.`; value = n; } S.values[guild + module + key] = value; return value; },
    activity: async ({ guild, sinceId }) => {
      const mine = (FEED[guild] = FEED[guild] || FEED_START.map((e, i) => ({ id: i + 1, at: Date.now() - (FEED_START.length - i) * 47e3, kind: e[0], text: e[1] })));
      // something new now and then while the bot is online, so the page can be seen updating
      if (S.live.phase === 'online' && sinceId > 0 && Math.random() < 0.6) { const e = FEED_START[Math.floor(Math.random() * FEED_START.length)]; mine.push({ id: mine[mine.length - 1].id + 1, at: Date.now(), kind: e[0], text: e[1] }); }
      while (mine.length > 200) mine.shift();
      return { entries: mine.filter((e) => e.id > (sinceId || 0)), last_id: mine[mine.length - 1].id };
    },
    economy_reset: async () => { await wait(400); return 128; },
    backup_now: async ({ stamp }) => { await wait(300); return `C:\\Users\\you\\AppData\\Roaming\\Good Boy 4\\data\\backups\\good-boy-${stamp}.db`; },
    open: () => {},
  };
  window.GBPretend = async (name, args) => { if (!A[name]) throw `The preview has no "${name}".`; return A[name](args); };
})();
