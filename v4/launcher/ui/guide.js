// Basic Ghost Labs - Good Boy 4. Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
// The user guide. Each topic is plain data: a title and blocks. Blocks are ['p', text], ['h', text],
// ['steps', [text...]], ['list', [text...]], ['note', text] or ['go', label, page] (a button that opens a page).
'use strict';
window.GBGuide = [
  { id: 'start', title: 'Getting started', blocks: [
    ['p', 'Good Boy is a Discord bot you run yourself. This app is where you start it, stop it and choose what it does in each server.'],
    ['steps', ['Make a bot on Discord\'s developer page and copy its token (see "Make a bot and get its token").', 'Paste the token in Settings. Good Boy checks it with Discord before saving it.', 'Invite the bot to your server from the Modules page.', 'Press Start on the Home page. The light at the bottom left turns green when the bot is online.']],
    ['note', 'The bot is online only while it is running. If this app is closed or the PC is off, the bot is offline.'],
    ['go', 'Open Settings', 'bot'],
  ] },
  { id: 'token', title: 'Make a bot and get its token', blocks: [
    ['p', 'The token is the bot\'s password. Anyone who has it can control your bot, so never post it or send it to anyone.'],
    ['steps', ['Open the Discord developer page (the button is in Settings).', 'Press New Application, give it a name and press Create.', 'Open the Bot page on the left.', 'Press Reset Token, then Copy.', 'Come back here, open Settings, press Add token and paste it.']],
    ['p', 'Good Boy keeps the token in your computer\'s own credential store. It is never written to a file and this app never shows it again.'],
    ['go', 'Open Settings', 'bot'],
  ] },
  { id: 'reset', title: 'Reset or replace the token', blocks: [
    ['p', 'Reset the token if you think someone else has seen it, or if Discord says it is no longer valid.'],
    ['steps', ['On the Discord developer page, open your application, then Bot.', 'Press Reset Token and copy the new one. The old token stops working straight away.', 'In this app, open Settings and press Replace token.', 'Paste the new token and press Check and save.']],
    ['p', 'If the bot is running it restarts on the new token by itself. A token Discord refuses is not saved, so a working bot is never swapped for a broken one.'],
    ['h', 'Remove the token'],
    ['p', 'Remove token stops the bot and deletes the token from this computer. Your servers, levels and settings are not touched.'],
  ] },
  { id: 'secret', title: 'The client secret', blocks: [
    ['p', 'The client secret is a second password for your application. It is used for "Sign in with Discord" on the phone and web dashboard. The bot itself runs without it.'],
    ['steps', ['On the Discord developer page, open your application, then OAuth2.', 'Press Reset Secret and copy it.', 'In this app, open Settings and press Add client secret (or Replace).', 'Paste it and press Save.']],
    ['note', 'With the secret saved, turn the web app on in Settings to sign in from a phone or another computer. The web address you give there must be added as a Redirect in the same OAuth2 page.'],
  ] },
  { id: 'invite', title: 'Invite the bot to a server', blocks: [
    ['steps', ['Open the Modules page.', 'Press Invite to a server. Your browser opens Discord\'s own invite page.', 'Pick the server and press Authorise. You need the Manage Server permission there.']],
    ['p', 'The server appears on the Modules page a moment after the bot joins, while the bot is running.'],
    ['go', 'Open Modules', 'servers'],
  ] },
  { id: 'modules', title: 'Modules and settings', blocks: [
    ['p', 'A module is one thing the bot does, such as Levels or Money. Each server chooses its own.'],
    ['list', ['Turn a module on or off with its switch. It takes effect straight away; no restart.', 'Press Settings to change how it works. Each change is saved as you make it.', 'Reset puts one setting back to how it came.']],
    ['p', 'Pickers for channels fill in while the bot is online. When it is stopped you can still paste a channel\'s ID.'],
  ] },
  { id: 'levels', title: 'Levels', blocks: [
    ['p', 'Members earn XP for chatting and level up. Each message gives a random amount between the minimum and maximum, at most once per cooldown, so spamming does not help.'],
    ['list', ['/rank shows a member\'s level, XP and place.', '/leaderboard shows the members with the most XP.', 'Level-up messages can go where the member chatted or to one channel. In the message, {user} is the member and {level} is the new level.']],
  ] },
  { id: 'money', title: 'Money', blocks: [
    ['p', 'Each server has its own coins. Coins are earned in the server and are never sold for real money.'],
    ['list', ['/money reset (admins) resets one member\'s wallet, or the whole server\'s economy. Modules > Money has a Reset button too. Both ask first and make a backup before anything is cleared; the shop and settings are kept.', '/money balance shows a wallet, streak and place.', '/money daily gives the daily reward. Claiming every day builds a streak that pays more.', '/money work does a job for coins, with a cooldown.', '/money pay sends coins to another member. Amounts can be written as 500, 2.5k, half or all.', '/money top shows the richest members.']],
  ] },
  { id: 'moderation', title: 'Moderation', blocks: [
    ['p', 'Tools for your moderators. Every action is saved as a numbered case in the member\'s history.'],
    ['list', ['/warn gives a warning. Enough warnings time a member out by themselves; you can also set a number that kicks or bans.', '/timeout and /untimeout stop a member talking for a while (up to 28 days).', '/kick removes a member; /ban bans them, for good or for a length such as 7d. A timed ban is lifted by itself.', '/unban lifts a ban by user ID.', '/purge deletes the newest messages in a channel (up to 100, optionally one member\'s). Pinned messages are kept.', '/modhistory shows a member\'s cases.']],
    ['p', 'Who can use each command follows Discord\'s own permissions: Moderate Members for warnings and timeouts, Kick Members, Ban Members, and Manage Messages for /purge.'],
    ['note', 'The bot can only act on members whose highest role is below its own. If Discord refuses, the moderator is told and nothing is added to the history. In Server Settings > Roles, drag Good Boy\'s role above the roles it should moderate.'],
    ['p', 'Set a mod log channel in the module\'s settings to get a card there for every case. Raid protection and anti-nuke are not in this build yet.'],
    ['h', 'Server logs'],
    ['list', ['/logs setup picks the mod log channel (cases, AutoMod, deleted and edited messages) and a server log channel, and switches each kind of log on or off. Run it with nothing filled in to see the current setup.', 'Deleted and edited messages: on by default. The bot keeps a copy of messages for a week so it can show what a deleted message said.', 'Members joining and leaving, role changes, nickname changes and voice joins, leaves and moves: off until you switch them on.', '/logs off stops the mod log, the server log or both.']],
    ['note', 'Joins, leaves, roles and nicknames need Server Members switched on on the bot\'s page. A role or nickname change is described from the second change the bot sees for that member after it starts.'],
    ['h', 'Your own strike ladder'],
    ['p', 'Every warning is a strike. Out of the box, every 3 strikes time a member out for an hour. To use your own rules, open Moderation\'s settings, then "Warnings and strikes", and write one step per line in the strike ladder:'],
    ['list', ['2 timeout 1d  (2 strikes: a 1 day timeout)', '4 timeout 1w  (4 strikes: a 1 week timeout)', '6 ban 30d  (6 strikes: a 30 day ban, lifted by itself)', '10 ban  (a ban for good)  ·  8 kick  (a kick)']],
    ['p', 'Between steps nothing happens; past the last step, the last step repeats. "Strikes start again from" lets a member come back from a ban on a lower count: set it to 3 and their next strike after the ban is the 4th.'],
    ['list', ['/strikes view shows a member\'s strikes and what the next one does. /strikes ladder shows the ladder, and any line it could not read.', '/unwarn takes a warning back after an appeal (their newest, or one case number). It is kept in their history as taken back.']],
    ['h', 'AutoMod'],
    ['p', 'AutoMod removes messages that break a rule, tells the member why, and (by default) gives a warning. Scam links are caught from the start; the other rules are off until you switch them on.'],
    ['list', ['The rules: scam links, spam, a word filter, links and invites, mass mentions, repeated messages, capital letters and emoji.', 'Each rule can use the AutoMod action or its own: delete only, delete and warn, or delete and time out.', '/automod status shows every rule and how often it caught something this week. /automod rule switches one on or off and changes its action or number.', '/automod word and /automod domain edit the banned words and the links that are always allowed. /automod exempt lets chosen roles or channels skip a rule.', '/automod recent lists what was removed.']],
    ['note', 'Moderators are never checked by AutoMod. AutoMod needs Message Content switched on to read messages, and Manage Messages to remove them.'],
  ] },
  { id: 'welcome', title: 'Welcome and goodbye', blocks: [
    ['steps', ['Open Modules, pick the server and open Welcome\'s settings.', 'Switch on "Send welcome messages" and pick the welcome channel. Do the same for goodbye messages if you want them.', 'Change the wording if you like. {user} mentions the member, {username} is their name, {server} is the server and {count} is the number of members.']],
    ['p', 'To hold new members back until they verify, set both "Role given after verifying" and "Role new members get until verified". New members are given the waiting role when they join.'],
    ['note', 'These messages need the bot to see members join. On Discord\'s developer page open your application, then Bot, and switch on Server Members Intent, then restart the bot. Home tells you when it is off. Welcome pictures, the verification panel, profile roles and birthdays are not in this build yet.'],
  ] },
  { id: 'roles', title: 'Role menus', blocks: [
    ['p', 'Let members pick their own roles: colours, pings, games and so on.'],
    ['list', ['/rolemenu create posts a menu in the channel with up to 10 roles, as buttons or a dropdown list. Members tap a role to add it and tap again to take it off.', 'Options: "only one" swaps roles instead of adding them; "max" limits how many one person can hold; "needs" makes the menu work only for members with a role; "hours" takes the roles away again after that long.', '/rolemenu limits changes those on a menu that is already posted; /rolemenu delete removes one. Both take the menu message\'s ID.', '/reactionrole add gives a role when someone reacts on a message with an emoji, and takes it away when they remove the reaction.', '/autorole add gives a role to everyone who joins (or to every bot that joins).']],
    ['note', 'For safety the bot never hands out a role with powerful permissions (such as Administrator, ban or delete messages), a role above its own, or a role at or above the highest role of the person setting it up. Drag Good Boy\'s role above the roles it should hand out. Menus from Good Boy 3 keep working; member counts on menus and game-activity roles are not in this build yet.'],
  ] },
  { id: 'tickets', title: 'Tickets', blocks: [
    ['p', 'A member presses a button, fills in a short form, and gets a private channel that only they and your staff can see.'],
    ['h', 'Set it up'],
    ['steps', ['Run /ticket setup and pick the category tickets open in, a staff-only log channel and the staff role. The same three are in the module\'s settings here.', 'Run /ticket panel in the channel where members should find the buttons.', 'To hide a kind of ticket, add its id to "Ticket categories to switch off" in the settings and post the panel again.']],
    ['h', 'Working a ticket'],
    ['list', ['Claim shows who is handling it. Press it again to let go.', 'Close: the member can close their own ticket. When staff close one, a form asks for the outcome (the member sees it) and staff notes (only the log gets them).', 'A closed ticket can be reopened or deleted. The member can still read a closed ticket but not write in it.', '/ticket add and /ticket remove bring someone in or take them out; /ticket rename renames the channel.', 'Tickets nobody writes in can close by themselves: set the hours in the settings (0 means never).']],
    ['note', 'The bot needs Manage Channels to make ticket channels. Tickets opened in Good Boy 3 carry on here. The watch log, evidence uploads, transcripts, ratings, priority changes and your own ticket types are not in this build yet.'],
  ] },
  { id: 'reminders', title: 'Reminders', blocks: [
    ['list', ['/remind me sets a private reminder. It arrives by DM, or in the channel if DMs are closed.', '/remind team posts a reminder in a channel and notifies up to three roles. It can repeat daily or weekly.', '/remind list shows your reminders; /remind cancel removes one by its number.']],
    ['p', 'Times can be a delay such as 30m, 2h or 1d, or a date such as 2026-12-31 18:30. Dates use the timezone offset in the module\'s settings.'],
    ['note', 'Reminders are checked every half minute while the bot is running. One that came due while the bot was off is sent when it starts, marked as late.'],
  ] },
  { id: 'giveaways', title: 'Giveaways', blocks: [
    ['list', ['/giveaway start posts a card with an Enter button. Give it a prize and how long it runs (1 minute to 30 days); winners, channel and a required role are optional.', 'Members press Enter to join and again to leave. The card shows the number of entries.', 'When time is up the winners are drawn at random and named in the channel. /giveaway end draws straight away.', '/giveaway reroll picks new winners from the people who have not won.', 'Write the prize as an amount of coins, such as 5000 coins, and each winner is paid by the bot.']],
    ['p', 'Starting, ending and rerolling is for admins (Manage Server) unless you hand it to other roles.'],
    ['note', 'A giveaway that asks for a role checks it when the member presses Enter. It is not checked again at the draw in this build.'],
  ] },
  { id: 'tags', title: 'Custom commands', blocks: [
    ['p', 'Your own commands and automatic replies. Staff add them with /tags add; everyone can see them with /tags list.'],
    ['list', ['A command is typed with a prefix, such as ?rules or !ip. The prefixes are in the module\'s settings; with none set, ? and ! are used.', 'An auto-reply answers when a message is exactly a phrase, starts with it, or contains it as a whole word.', 'A cooldown stops one from replying again in the same channel for a number of seconds.', '/tags use posts one without typing its prefix; /tags remove deletes one.']],
    ['h', 'What a reply can contain'],
    ['list', ['{user} {username} {server} {channel} {membercount} {date} {uses}', '{args} is everything typed after the command; {arg1} to {arg9} are single words.', '{random: pizza | tacos | sushi} picks one. {number: 1-100} picks a number.', '{if: {arg1} = yes | Great! | Oh no} chooses between two replies. It also understands != and contains.']],
    ['note', 'Replies never ping anyone. Custom commands need the bot to read messages: switch on Message Content Intent on the bot\'s page (Home tells you when it is off). Commands made in Good Boy 3 carry over.'],
  ] },
  { id: 'counting', title: 'Counting and word chain', blocks: [
    ['p', 'Two channel games. An admin starts one in a channel with /counting here (counting) or /counting words-here (word chain); the same command turns it off.'],
    ['list', ['Counting: count up one at a time. Small sums such as 12+1 count. A wrong number starts again from 1.', 'Word chain: each word starts with the last letter of the one before, and no word twice.', '/counting stats shows current runs, records and top players.']],
    ['note', 'These games need the bot to read messages. On Discord\'s developer page open your application, then Bot, and switch on Message Content Intent, then restart the bot. Home tells you when it is off. Counting is off for a server until you switch the module on.'],
  ] },
  { id: 'fun', title: 'Fun commands', blocks: [
    ['list', ['/fun 8ball answers a yes-or-no question.', '/fun dice rolls up to 10 dice.', '/fun ship says how well two members match. The answer is always the same for the same two.', '/fun topic gives the chat something to talk about.']],
  ] },
  { id: 'music', title: 'Music', blocks: [
    ['p', 'Join a voice channel, then use /music play with a link, a radio station\'s name or a song\'s name. /music player posts a player with buttons: pause, skip, back, stop, add, volume, repeat, shuffle, the queue, playlists and lyrics.'],
    ['list', ['Links straight to an audio file (ending in .mp3, .ogg and so on) and the radio stations you add in Music settings always work.', 'YouTube, SoundCloud and similar sites, and searching by name, are off until the bot\'s owner presses 🔗 Media links on the player. Those sites\' rules forbid it, so the owner decides. Good Boy then downloads a free program called yt-dlp into its tools folder.', 'Whoever added a song can skip it. So can the DJ role, anyone with Manage Channels, or anyone alone with the bot.', '/music save keeps the queue as a playlist. Playlists from Good Boy 3 are kept and show up in /music playlists.', 'Lyrics come from LRCLIB, a free lyrics library. Only the person who asked sees them.']],
    ['note', 'With smooth playback on (the default), each song is downloaded before it plays, so the first song takes a few seconds to start. Downloaded songs are deleted once they have played.'],
  ] },
  { id: 'data', title: 'Your data and backups', blocks: [
    ['p', 'Everything the bot knows is in one folder on this computer. Settings shows where it is.'],
    ['list', ['Back up now makes a full copy in the backups folder. It is safe while the bot is running.', 'To move to another PC, copy the whole data folder across, then add the token there.']],
  ] },
  { id: 'from3', title: 'Coming from Good Boy 3', blocks: [
    ['p', 'On first run Good Boy 4 looks for Good Boy 3 on this computer and offers to copy its data: servers, levels, coins, settings and your own art.'],
    ['list', ['Good Boy 3\'s data is only read, never changed. Good Boy 3 keeps working exactly as before.', 'Modules that Good Boy 4 has not rebuilt yet keep their settings and data, ready for when they arrive.']],
    ['p', 'Most people never do this by hand: Good Boy 3 shows a card when Good Boy 4 is out, then moves your server over by itself (backup, download, hand over the bot and licence, start Good Boy 4, remove Good Boy 3). If Good Boy 4 does not come up, Good Boy 3 is put back as it was. The backup is kept for 14 days.'],
    ['note', 'Two programs cannot run the same bot at once. If Good Boy 3 is still running this bot, close it first.'],
  ] },
  { id: 'phone', title: 'Using Good Boy on your phone', blocks: [
    ['p', 'The same dashboard works in a browser and installs as an app on iPhone and Android. You and anyone with Manage Server in a server the bot is in can sign in with Discord (they only see their own servers). Tokens and the move from Good Boy 3 stay in the app on the computer.'],
    ['steps', ['Settings > Phone and web: write the public https link that leads to this computer, and switch the web app on.', 'In the Discord Developer Portal, open your bot, go to OAuth2 and add that link followed by /auth/callback under Redirects. Make sure the client secret is saved in Settings.', 'Open the link on your phone and press Sign in with Discord.', 'iPhone: in Safari press Share, then Add to Home Screen. Android: in Chrome press the menu, then Install app.']],
    ['note', 'The phone can only reach the bot while the computer (or web host) running it is on. Tailscale Funnel or Cloudflare Tunnel give a free https link to a computer at home.'],
  ] },
  { id: 'host', title: 'Running on a web host', blocks: [
    ['p', 'A web host keeps the bot online when your PC is off. The same Good Boy 4 runs there as a small program with no window.'],
    ['steps', ['Put the goodboy program and your data folder on the host.', 'Set DISCORD_TOKEN in the host\'s secrets or environment page. The token is never typed on a command line.', 'Set the start command to: goodboy run <data folder>']],
    ['note', 'This app manages a bot that runs on this PC. To manage a hosted bot, turn on the web app on the host (Settings, Web app) and sign in to it from your phone or browser.'],
  ] },
  { id: 'trouble', title: 'If something is wrong', blocks: [
    ['h', 'The bot will not start'],
    ['list', ['"Discord says this token is not valid": reset the token and replace it in Settings.', '"Discord could not be reached": check this computer\'s internet connection, then press Start again.', 'Good Boy 3 is running the same bot: stop it there, or use a separate test bot.']],
    ['h', 'A kick, ban or timeout "did not go through"'],
    ['p', 'Good Boy\'s role is below the member\'s highest role, or it lacks the permission. Drag its role higher in Server Settings > Roles, or invite it again from the Modules page to give it the permissions this build uses.'],
    ['h', 'Commands do not show in Discord'],
    ['p', 'New commands can take a minute to appear. Close and reopen Discord (Ctrl+R) to refresh the list.'],
    ['h', 'A command says the module is turned off'],
    ['p', 'Open Modules, pick the server and switch the module on.'],
  ] },
  { id: 'pages', title: 'The pages in this app', blocks: [
    ['p', 'The same names and order as the Good Boy 3 dashboard. Pick the server at the top of a page. Names are shown instead of numbers, and wherever you choose a member you type part of their name.'],
    ['list', [
      'Home: start, stop and restart the bot.',
      'Modules: switch each module on or off and change its settings.',
      'Tickets: every ticket, with Claim, Reply and Close on open ones.',
      'Members: the server at a glance, the level and coin boards, the latest cases.',
      'Inactive: find members who have gone quiet. Scan, filter, keep the ones that matter, remove the rest. The bot must be running to scan.',
      'Leavers: who left in the last 60 days, how they went (left, kicked or banned) and anything that stood out. Forget removes one person completely.',
      'Moderation: every case, and warn, time out, kick or ban from here.',
      'AutoMod: every automatic rule on one page.',
      'Economy: the treasury, taxes and the second currency, with payouts and a record.',
      'Lists: giveaways (end now, pick another winner), custom commands (delete), top inviters, counting games and backups.',
      'Permissions: pick which roles may use each command, in plain words.',
      'Role menus: the menus members pick roles from, and Delete to take one away.',
      'Shop: the roles and items members buy with coins.',
      'Music: the player, search, playlists and the queue.',
      'Check-up: finds what would stop the bot working (token, data, modules, permissions, problems) in plain words.',
      'Logs: what the bot has just seen, live.',
      'Settings: the token, colours, and how long private messages stay before they are taken down.']],
    ['note', 'Pages that act in Discord (moderation, tickets, music, inactive scans and removals) need the bot to be running.'],
  ] },
  { id: 'build', title: 'What is in this version', blocks: [
    ['p', 'Good Boy 4 is Good Boy rebuilt from the ground up. It is the same bot: your settings, levels, coins, tickets, licence and token carried over from Good Boy 3.'],
    ['h', 'What it does'],
    ['list', ['Levels with rank cards, Money with a shop, pets, treasury and exchange, and games (slots, blackjack, the arcade, fishing, critters)', 'Moderation with AutoMod, the strike ladder, server logs and appeals; Tickets with search and transcripts', 'Welcome, Role menus, Reminders, Giveaways, Custom commands, Counting, Fun, Family, Parties and image Quotes', 'Music with playlists, a sound filter, autoplay and vote skip, and a Music page that joins the call you are in', 'The dashboard in this window, and a phone web app (turn it on in Settings)', 'Your bot\'s token and client secret are kept by the operating system, not in a file']],
    ['h', 'Good to know'],
    ['list', ['Two programs cannot run the same bot at once, so Good Boy 3 is switched off when Good Boy 4 starts.', 'A backup of your Good Boy 3 data is kept for 14 days after the move.', 'Good Boy 4 is installed with Good-Boy-4-Setup.exe (for you only, no administrator password) and can be removed in Windows Settings, Apps; your data stays unless you choose to delete it. It updates itself. It looks for a new version a little after it opens and every six hours, and Home shows a card when one is ready. Press Update now on the Updates page: the file is checked against its checksum first, the bot stops for a moment, and Good Boy reopens on the new version. Your data, settings and token stay where they are.']],
    ['h', 'Still to come'],
    ['list', ['Running on Linux and in Docker', 'The clipping and broadcast software']],
  ] },
];

// The commands folded into groups (`/mod` opens a menu with ban, kick and the rest). A test keeps this list in step
// with the bot's own. The guide's text is shown with those commands named the way members reach them.
window.GBGroups = {
  money: ['balance', 'daily', 'work', 'pay', 'top', 'shop', 'rob', 'pet', 'bank', 'treasury', 'exchange', 'economy-admin'],
  games: ['slots', 'blackjack', 'coinflip', 'tower', 'wires', 'bingo', 'memory', 'hangman', 'trivia', 'pong', 'arcade', 'fun', 'fish', 'critters', 'counting'],
  mod: ['warn', 'unwarn', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'purge', 'modhistory', 'strikes', 'note', 'watch', 'appeal', 'report', 'lockdown', 'altcheck', 'automod'],
  community: ['stats', 'liveboard', 'serverstats', 'counter', 'xp', 'levels', 'rep'],
  roles: ['rolemenu', 'reactionrole', 'autorole', 'gamerole'],
  me: ['profile', 'introduce', 'birthday', 'afk', 'timezone', 'id', 'plural'],
  social: ['marry', 'family', 'rp', 'quote', 'party', 'highlight'],
  voice: ['tts', 'room', 'voicehub'],
  server: ['greeting', 'images', 'setup', 'verify', 'deadchat', 'announce', 'suggestion', 'starboard', 'feed', 'minecraft', 'webhook', 'notifications', 'backup', 'invites', 'logs', 'say', 'sticky', 'botnews', 'clips', 'tags'],
};
(function () {
  const group = {};
  for (const [g, members] of Object.entries(window.GBGroups)) for (const c of members) group[c] = g;
  const names = Object.keys(group).sort((a, b) => b.length - a.length);
  const re = new RegExp('(^|[^\\w/])/(' + names.join('|') + ')(?![\\w-])', 'g');
  const fix = (t) => (typeof t === 'string' ? t.replace(re, (all, before, c) => `${before}/${group[c]} → ${c}`) : Array.isArray(t) ? t.map(fix) : t);
  for (const topic of window.GBGuide) topic.blocks = topic.blocks.map(fix);
})();
