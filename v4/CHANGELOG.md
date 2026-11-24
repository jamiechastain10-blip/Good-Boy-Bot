# Good Boy 4 changes

## 4.1.0
**Server setup: Good Boy can build a new server, and tidy one that exists.** `/setup start` (admins) offers four layouts: Community, Gaming, Support and product, and Small group of friends. Pick one and you see exactly which roles, categories and channels it would add, then press Build. Only what is missing is made, nothing you already have is changed or deleted. It then connects the bot to what it made: the welcome, introductions, moderation log, server log, ticket log and suggestions channels, the ticket category and staff role. It turns on the modules the layout needs, posts the server rules, and posts the ticket buttons. Staff areas are hidden from everyone, and info channels are read only. `/setup scan` (or **Check my server** on the new Server setup page of the app and dashboard) looks at a server that is already set up and reports: powers @everyone should not have, too many Administrator roles, empty categories, channels with no messages for three months, channels and roles with the same name, channels the bot is not using yet (a channel called #welcome or #mod-logs is found and can be connected in one press), a missing moderation log, and basic features that are off. Each finding that can be fixed has its own Fix button, and nothing changes until it is pressed.

**Eclipse ID picks up what you play, moves with a code, and finds players.** Good Boy now reads the game a member is playing from their Discord status and shows it on their card as *picked up automatically*, with the kind of device (PC or phone). It is off by switch at two levels: the server owner's **Pick up what members play** on the Eclipse ID page, and each member's own `/id auto` (on, off, or forget: off also erases what was picked up). Members can also hide it with `/id privacy`. `/id export` gives a code (with a check so a bad copy is refused) that carries the whole card to another Good Boy, and `/id import` brings one in, keeping a code of the old card so nothing is lost. `/id find game:Minecraft` lists members of this server who play it, only counting people who use Eclipse ID here, share their card, and let games be seen. The module page in the app and dashboard now has its own Eclipse ID card with the switches, numbers and a list of what members can do. Picking up games needs the Presence Intent turned on for the bot on Discord's developer page.

**Casino: losses feed the jackpot, and you can go all in.** Every lost bet in the games (blackjack, coin flip and the arcade games, and slots when a spin loses more than the usual cut) now puts a share into the slots jackpot. The share is a setting, **Share of every lost bet that goes into the jackpot**, and starts at 100%. **All in** bets everything you have, even above the biggest bet: type `all in` (or `all`) as the bet, or press the new **All in** button under slots, coin flip and blackjack. Servers can turn it off with **Let players go all in**.

**Coins can be added to the treasury.** The dashboard's Economy page has a new **Add coins to the treasury** card (with a note that is kept in the record), and admins can use the **Add coins** button on `/money` → treasury in Discord, not only the server owner. Members can still give coins from their own wallet.

**Modules are sorted into 10 categories.** The Modules page groups all 35 modules under Safety & support, Welcome & members, Levels & stats, Money, Games & fun, Social & profiles, Roles & messages, Music & voice, Connections and Tools & backup. A row of category buttons above the list shows just one category, and it works together with the search and the On/Off/Needs setup filters.

**A real command guide, and a much more detailed /help.** `/help command:` takes a command, a group or a module (for example `/help command:images`, `/help command:mod` or `/help command:music`) and explains it: how to reach it, who can use it, what each part does and what every box takes, with a few written lines for the commands that need more than a summary. If you type a word that is not exact it shows the closest matches. The same guide is in the app and the dashboard: **Help → Commands** lists all 100 commands by module, searchable, written from the bot's own command list so it can never fall behind.

**The menu on the left folds into sections.** People, Safety, Money, Fun, Tools and Bot open and close, remember what you chose, and the section you are in stays open.

**Welcome and goodbye designer.** The Welcome module page now has a designer with a live preview of exactly what a new member will see. Pick **Words** (as before, with your picture if you added one) or **Picture card**: one picture with the member's profile picture, their name, a big line and a smaller line, in a colour theme or on your own background picture. Change the words (`{user}`, `{username}`, `{server}`, `{count}`), the ring and bar colour, or the theme, and the preview redraws. Nothing changes for members until you press Save. Goodbye has its own look. The upload button is at the top of the designer.

**Images gallery.** Every picture you upload for the bot is now kept in a gallery for the server, so it is saved and can be used again. The new **Images** page in the app and the dashboard shows them as thumbnails: add many at once, rename, delete, and **Use for…** the welcome message, the goodbye message or the **rank card background for everyone** who has not picked their own. The tags on each picture show where it is in use. In Discord, staff get `/images list`, `/images add` (a form that takes up to 10 pictures), `/images use`, `/images stop` and `/images remove`, so everything can be uploaded from either side. A server keeps up to 60 pictures. Using a picture copies it, so deleting it from the gallery never breaks a welcome picture already in use.

**Level-ups can be quiet, or show the member's rank card.** Levels has a new setting, **Level-up style**: `ping` (the message that pings the member, as before and still the default), `quiet` (the same message with no ping, so it says someone levelled up without a notification) or `card` (the member's own rank card, drawn as a picture with their theme, colours and background and moving if their profile picture moves, posted in the channel with a View rank button and no ping). If the picture cannot be drawn the text version is posted instead. With server rank pictures switched off, `card` falls back to the text version. Turning level-up announcements off still works as before.

**Music: a second queue for a second call.** Every player now has a **Start mine** button. Press it while you are in a voice channel with no music bot and Good Boy finds a free music bot, joins your call and opens the Add popup, so you get your own queue without touching anyone else's. Controls (Pause, Skip, Back, Stop) now belong to the people in that player's call: someone listening in a different call is told the player is not theirs and to press Start mine, instead of being able to stop another call's music. (A music bot can only be in one voice channel at a time, so two calls at once needs a second music bot: the bot's owner adds one under Music bots. With none free, Start mine says so.)

**Eclipse ID is now one card per person.** Your card (about me, favourite games, platforms, availability, region and linked game names) is no longer kept separately in each server: edit it once and it goes with you to every server this bot is in. A new card is shown in every server until you choose otherwise, and `/id share` lets you show or hide it in this server or in every server (you always see your own). Cards made in the old per-server version are combined into one (the newest wins) and keep showing only in the servers they were made in; nothing from the old version is deleted. Your Eclipse ID is now made from your Discord user ID, so it is the same on every server (it looks like EID-7K3Q9-ZMD4X). `/id delete` now erases your card everywhere.

**Fix: the menu was cut off on tall and wide screens.** In the pixel look the menu on the left is taller than many windows, and it did not scroll, so Settings, Help, the mascot and the status line ran off the bottom of the screen (every page, worst on an ultrawide monitor). The menu now scrolls when the window is shorter than it, and gets tighter as the window gets shorter, so on a tall screen it fits whole. On very wide screens the page also uses more of the width instead of sitting in a narrow strip in the middle.

## 4.0.1
**The version is shown on the bot's profile again.** The bot's description on Discord ends with "Good Boy v4.0.1 · Basic Ghost Labs" (as in Good Boy 3), and the number is refreshed after each update. Bots with a licence keep their own words; only the credit line at the end is brought up to date (a minute after Good Boy starts, and again after each update).

**Good Boy 4 has an installer.** Download Good-Boy-4-Setup.exe from the releases page and run it. It installs for you only (no administrator password), adds a Start menu entry and an optional desktop shortcut, shows up in Windows' installed apps, and uninstalls cleanly, keeping your data unless you choose to delete it. Running it over an older copy updates that copy in place, even while Good Boy is open. It installs in a folder the program can write to, so self-updates keep working, and Windows' installed-apps list stays on the right version. The same installer script will package the recording software and the Minecraft launcher later, side by side with Good Boy. The plain Good-Boy-4.exe and the no-window program for web hosts are still published.

**Good Boy 4 now updates itself.** It checks GitHub for a newer Good Boy 4 a little after it opens and every six hours. Home shows a card when one is ready, and the new Updates page has an Update now button. The file is downloaded, checked against its sha256 checksum and size (a mismatch is refused and nothing changes), the bot is stopped, the program is swapped for the new one and reopened. If the new one cannot start, the old one is put back. Settings, data and the token are never touched. Only releases of this project are accepted, test builds are skipped, and a bot on a web host with the window-less program gets the window-less update. **Anyone on 4.0.0 has to install 4.0.1 by hand once** (download Good-Boy-4.exe from the releases page); from then on updates come by themselves.

**Fix: moving from Good Boy 3 now always brings Good Boy 3's data.** If an earlier Good Boy 4 test build had left its own data on the computer (old levels and coins), the move used to keep that instead of copying Good Boy 3's. Now Good Boy 3's data wins, and what was there is kept in a dated `before-the-move` folder inside the data folder, never deleted. If you were affected, open Settings, Your data, and press "Copy Good Boy 3's data again".

## 4.0.0
**Good Boy, rebuilt.** Good Boy 4 is the same bot, written again from scratch for speed and for running on your own computer or a host: one program, one window that is also the dashboard, a phone web app, and the same data. Your settings, levels, coins, tickets, licence and bot token came with you from Good Boy 3 (it was a one-time move, because the whole bot was rebuilt). Everything Good Boy 3 did is here, plus what is listed below.

<!-- members -->
Good Boy got rebuilt from the ground up, so it should be quicker and steadier. Everything you had (levels, coins, tickets) is still here, and there are some new things to try: a /help command, better image quotes with different looks, and a party finder that pings roles and joins your voice call 🎉
<!-- /members -->


## Guide and setup wording
- The "What is in this test build" page is now "What is in this version" and says what Good Boy 4 really does. Setup and the guide no longer tell you to use a separate test bot or say that phone sign-in, games and the shop are still to come.

## Music: it joins the call you are in
- The Music page now knows which voice call you are in (the person who runs the bot in the app, or whoever is signed in on the web). Press play and Good Boy joins that call; no channel to pick. If you choose another channel yourself the page keeps your choice. If the bot is playing somewhere else, **Move to my call** brings it to you.

## Friendlier AutoMod, word lists you type, and pick where it works
- **AutoMod** is now one card per rule in plain words (scam links, spam, banned words, links and invites, mass mentions, repeated messages, shouting, emoji): what it does, a switch, what happens when someone breaks it, and the numbers under **Fine-tune** with sentences instead of setting names. The usual response is at the top.
- **Word lists** (banned words, allowed websites, the strike ladder) are chips: type a word and press Enter, click × to remove one. Pasting a list splits it into separate entries: commas, new lines, bullets and numbering are understood, a pasted line of plain words becomes one entry per word, and a long run of letters with no space is refused instead of kept as one big word. Typing a phrase and pressing Enter keeps it whole. Websites are tidied (`https://www.YouTube.com/x` becomes `youtube.com`).
- **Where it works** now asks where a module *does* work: Every channel, or Only channels I pick, with the channels listed under their categories, with All / None for each category.
- Pages that had no icon (Arcade, Fishing, What's new) have one, and a missing icon no longer prints an error.

## Your bot's name, picture and banner
- As in Good Boy 3: without a licence, the bot wears the Good Boy name, picture, banner, app icon and description, and any part that is missing or was changed is put back in the background (a little after start, then every six hours). With a `whitelabel` licence the owner sets their own name, picture, banner and description in Settings, Good Boy never touches them, and the description keeps a short "Good Boy · Basic Ghost Labs" credit line. Each part is tried on its own, so Discord's two-name-changes-an-hour limit never blocks the rest.

## Transcripts, Logs and What's new
- **Save transcript** on a ticket saves the same styled page Good Boy 3's transcripts used (or plain text with **As text**).
- The **Logs** page starts with whether anything went wrong in the last 10 minutes and what the last problem was.
- New **What's new** page lists what changed in each update.
- Test and debug builds keep line numbers but not full debug information, so the build folder is several times smaller.

## Restarts: open windows are warned, and servers can be told first
- When the bot stops or restarts, every private window still open (a game, a form) is changed to "Good Boy is restarting, this window is closing", then taken down a few seconds later, instead of being left with buttons that no longer work.
- New **Warn servers** button on the Home page (next to Restart): posts a heads-up ("restarting in 5 minutes, private windows will close") in each server's announcements channel from Bot news. Servers without one are skipped.

## Ticket search and transcripts
- The Tickets page has a search box: it finds tickets by any words said in the conversation (from the ticket archive), by ticket number (`#8`), or by who opened it, who it is about, or its category.
- **Save transcript** on an open ticket saves the whole conversation as a text file.

## Colour pickers
- **Dashboard:** every colour setting (the custom quote colours for now) has a real colour picker next to its code. Any common spelling of a code works (`#5865F2`, `5865f2`, `#58f`) and is saved as `#rrggbb`.
- **Discord:** popups cannot have a picker, so colours are chosen from a dropdown of 24 named swatches, each with a coloured square. This is now how the rank card colours (main and second, with "keep my current colour" and "default"), and the announcement box colour work. `/say send`, `/say edit`, `/sticky set` and `/profile setup|edit` keep their typed code and gain a **colour** option to pick from the same list (a typed code wins).
- Colours typed in the rank card popup are gone; an exact code saved earlier still works and is offered as "Keep my current colour".

## Image quotes: the classic look is back, with styles to pick from
- Quotes go back to Good Boy 3's look (the speaker's picture fading into the dark, their words beside it) by default. The pixel quote is still there as one of the choices.
- New setting **Look of image quotes** (Quotes module in the dashboard): Classic, Midnight blue, Paper, Sunset, Forest, Pixel, or Custom.
- **Custom** (servers with a licence): pick your own background, text and accent colours (`#rrggbb`) and a font (sans, serif, mono). Without a licence, or with a colour that is not `#rrggbb`, quotes use the classic look.
- The "pixel pictures" switch now only affects rank cards and family trees (and the pixel quote).

## Pages keep their place; Arcade and Fishing pages
- The page no longer jumps back to the top while you use it, most of all on Music. Rebuilding the music player used to read its scroll position from the empty new copy; now the page, the sidebar, the music library and its list all keep their place. The Music page is also no longer rebuilt every few seconds by the status check.
- New **Arcade** and **Fishing** pages (under Fun), like Good Boy 3's: the games module's settings split in two, with a link to the full Games page.

## Panels from Good Boy 3 keep working
- The arcade panel Good Boy 3 posted (`gm:ar:<game>` buttons) now opens the same games in Good Boy 4, so nobody has to repost it after the move. Other old buttons (a finished blackjack hand, say) still say they are from an older message.

## Parties and the treasury
- A party's start time is read in the host's own time zone (`/me` → Time zone): `8pm`, `tomorrow 8pm`, `2026-12-31 18:30`, or a delay like `2h`. With no zone saved, a clock time asks the host to set it first.
- New 📣 **Ping** button on a party: the host picks a role and an optional note, and Good Boy pings just that role. Only roles Discord lets anyone mention (or the server's party role) work; `@everyone` and other roles are for admins; once every 10 minutes per party.
- If the host is in a voice channel when they start a party, the party uses it: it is shown on the post, and members who join while in voice are moved there (Good Boy needs Move Members). Good Boy never deletes the host's own channel.
- The server owner (only) gets an **Add coins** button on `/treasury` to put new coins into the treasury.

## Rank cards: View rank fixed, and backgrounds are uploaded in the popup
- **View rank** on a level-up message showed a raw `<@1234…>` as the name and no profile picture when the member had not spoken since the bot started. It now uses the name and picture the bot already remembers for that member.
- **Background pictures are uploaded in the Customise popup** (a file box, from a phone or a computer), instead of pasting a link. The picture is copied onto the bot's computer when it is sent, because Discord's own picture links stop working after about a day. The popup shows a "Keep it / Remove it" choice once there is a picture. Backgrounds set by link before keep working.

## The phone web app
- The word **"null"** is gone from the top of every page for people with a single server (the server picker was empty and printed as text). Any empty value given to a page is now dropped instead of printed.
- **Permissions**: the description no longer runs one letter per line; the role picker sits under it.
- **Shop, Role menus, Leavers, Lists, Settings**: nothing runs off the right edge any more. Buttons wrap under an item's name instead of squeezing it.
- "How to set it up" in Settings is a normal numbered list (it was laid out as a row).
- The pixel look keeps the space under the iPhone's status bar, and the menu labels at the bottom no longer overlap.

## /help is back, and a plural proxy that cannot send says why
- **`/help`** was never brought over from Good Boy 3 and did nothing. It is back: a private list of what is switched on in the server, named the way members reach it (`/mod`, `/money`, `/me`... and the commands that stand alone).
- **Plural proxy.** When a proxied message cannot be sent (the bot lacks Manage Webhooks in that channel, a picture link Discord refuses, and so on), the channel now gets a short note saying why, at most once in five minutes, and the member's own message is left alone. Before, the reason only went to the Logs page and nothing visibly happened.

## Games: no more "didn't respond in time", and windows that go away
- Button presses are now worked out on a separate thread, so one slow game (drawing its picture) no longer holds up every other button. If a press does take longer than two seconds, Discord is told "one moment" straight away and the answer follows as an edit, so it is not refused after three seconds. A popup that cannot open after that comes as a "Continue" button instead.
- **Private game windows now go away.** Private messages were already taken down after a while with nobody pressing anything, but only if they had no file attached, and game windows carry their picture as a file, so they never went. Pictures no longer count; exports and transcripts still stay. The wait is now 5 minutes by default (Settings > Private messages go away) and each press starts it again.
- Private game windows have a **Close** button that takes them down at once.

## Licences carry over, and the move from Good Boy 3 happens by itself
- **Licences.** Good Boy 4 reads the same licence keys as Good Boy 3 (same public key, same rules: one bot, can be cancelled, can end). A key in Good Boy 3's settings is taken over once; Settings > Licence shows who it is for and what it unlocks, and lets you paste or remove one and check the cancelled list. Your bot's own name, picture and banner live on Discord and stay as they are because the bot and token stay the same.
- **The move.** The last Good Boy 3 shows a card, "Good Boy 4 is here", with what it is, a 5-minute countdown and a button to start sooner. Then it backs up your data, downloads Good Boy 4 and checks its checksum, stops the bot (only one program may use a token at a time), hands over the token and licence in a file that Good Boy 4 reads once and deletes, starts Good Boy 4, waits for it to say it is running, and removes Good Boy 3. If Good Boy 4 does not come up, it is stopped, the handover is deleted and Good Boy 3 starts again as it was, then tries again the next day. The backup is kept for 14 days.
- The "From Good Boy 3" page is gone from the menu; the move no longer needs anyone to open it.

## Pixel pictures and new image quotes
- **Image quotes were redrawn in the pixel look**: a pixel frame, the speaker's picture as pixel art fading into the dark, the words in a pixel font with a text cursor, and the name, handle and date. Still, "motion" (a light band steps across the picture) and animated-profile-picture quotes all keep working.
- **Every character shows.** The pixel fonts are used wherever they have the character; anything else (fancy-letter names like 𝓚𝓪𝓲, other scripts such as Chinese, Japanese, Korean, Cyrillic and Arabic, symbols and emoji) is drawn in the computer's own fonts, one run at a time, so one emoji never changes the font of the whole line. Custom server emoji read as `:name:`.
- **Pictures in quotes.** If the quoted message has a picture, it is shown as pixel art under the words.
- **No quoting yourself.** `/quote` and the right-click commands tell people to ask someone else. Settings > Quotes > "Let members quote their own messages" turns that around.
- **Pixel profile pictures everywhere the bot draws them**: rank cards (animated ones keep one set of colours so they do not shimmer) and family trees, as well as quotes. Colours are picked from each picture, so people stay recognisable. Each has a switch (Community > "Draw profile pictures as pixel art", Family, Quotes) so a server can keep its original pictures.

## The dashboard on phones
- A web version of the dashboard that also installs as an app on iPhone and Android (Settings > Phone and web). People sign in with Discord: the person who runs the bot, and anyone with Manage Server (their own servers only). Tokens and the move from Good Boy 3 stay on the computer. On a web host, set GOODBOY_WEB_ADDRESS (and GOODBOY_WEB_PORT).
- New pages: Permissions (who may use each command, by role) and Lists (giveaways, custom commands, top inviters, counting games, backups), plus Role menus, Check-up and From Good Boy 3.

## Tickets on the dashboard
- Each ticket shows who opened it, who it is about (for reports), how urgent it is (urgent, high, normal, low) and which moderator has it. Open one to read the conversation and answer from the page.
- A moderator who signs in with Discord can claim a ticket and reply from the dashboard. The ticket channel says who claimed it and that it was from the dashboard, and replies are sent under their name (Staff reply from Maya) and ping the person who opened it. The first reply counts for "first reply after".
- People who hold a server's ticket staff role can sign in with Discord even without Manage Server. They see only the Tickets page, for their own server.

## Set up from the dashboard
- New **Commands** page: every command, with the same boxes as its popup in Discord, filled in on the page (members searched by name, channels and roles picked from lists). What the command says comes back on the page. Anything that is set up with a command in Discord can be set up here too.

## A short command list
- Discord's command list went from 99 commands to about 22. Commands in the same area are now behind one command that opens a private menu: `/money`, `/games`, `/mod`, `/community`, `/roles`, `/me`, `/social`, `/voice` and `/server`. Pick what you want (Ban, Daily, Backup...) and its popup opens, or a second menu for commands with several parts. Nothing was removed: every command works exactly as before, with the same popups and permissions. `/rank`, `/leaderboard`, `/music`, `/ticket`, `/remind`, `/giveaway`, `/poll`, `/suggest`, `/time`, `/xp`, `/levels`, `/starboard` and `/achievements` stay on their own.
- The bot's help text and the in-app guide name commands the new way (`/mod` → ban).

## Bots your server runs next to Good Boy, now built in
- **Time zones** (Friend Time): `/timezone set`, `/time @member`, and `/time at:8pm` turns a time for them into a time everyone sees in their own zone.
- **Alt detector** (Alt Detect): on join, compares with banned members (profile picture, near-identical name, brand new account) and tells staff what matched; `/altcheck`. It only guesses, and by default only tells staff.
- **Plural proxy** (PluralKit): members with names, pictures and proxy tags; autoproxy; `/plural who`. Needs Manage Webhooks and Message Content.
- Birthdays (`/birthday`, with an upcoming list), polls, suggestions, the starboard, sticky messages, counters and tickets were already covered. A test keeps the command list inside Discord's limits.

## A new look
- The program, the phone web app and the website now wear a pixel look (chunky borders, hard shadows, pixel fonts, a mascot that barks when something is saved) with the mascot banner on Home. Every page, menu and tab is the same as before. Settings > Look switches back to the classic look.

## Set up from the dashboard
- Welcome and goodbye pictures, and every critter character's picture, can be added, changed and removed on the Welcome and Critters setup pages (from a file on your computer, or a link for critters), with a preview of the message. A moving GIF stays moving.
- Rank cards: the level-up "show rank" picture now waits for the member's profile picture instead of showing initials, and members with an animated profile picture get an animated card.
- The prototype notices and the "Project Patina" name are gone from the program, the window, the installer names and the bot's Discord status.

## More of Good Boy 3 (music, suggestions, giveaways)
- Music links from Spotify, Apple Music, Deezer, Pandora, Tidal, Amazon Music, Napster, Qobuz, Shazam and others now work, as songs, albums, playlists (and artists' top songs on Spotify/Deezer). Each song is found on YouTube when it plays. Share links (spotify.link, link.deezer.com, ...) are followed. Any other page that names a song is read too. YouTube, SoundCloud, Bandcamp and the rest still go through yt-dlp. Pandora pages are only readable from the words in the link, so Pandora playlists and stations are not supported.
- The launcher's Music page has a switch for music sites (the same setting as the 🔗 button in Discord). It is per server.
- Fixed: Add music in Discord ("the bot couldn't respond": a popup label over Discord's 45-character limit, now fitted everywhere) and adding a found song to a playlist in the launcher.
- Music sound filters (bass boost, nightcore, slowed) and radio reconnect. `/music volume` moved to `/music sound volume` next to `/music sound filter`.
- Suggestions open a discussion thread; announcements and parties warn when their role cannot be pinged; giveaways skip people who left.

## Moving over from Good Boy 3, safely
- New launcher page **From Good Boy 3**: copy your Good Boy 3 data (again any time; what Good Boy 4 had is set aside in `before-recopy`, never deleted), check the copy table by table, then switch over with two safety ticks. Going back is stopping Good Boy 4 and opening Good Boy 3.

## Launcher and tools (since 4.0.0-dev.7)

- **Launcher pages:** Members, Inactive, Moderation (with warn, time out, kick and ban), Tickets, AutoMod, Logs, Music, Modules, Settings and Help, in the same order and names as the Good Boy 3 dashboard.
- **Music** is the Spotify-style page from Good Boy 3.1: library, search, playlists, queue and player bar. It plays through the running bot, searches music sites and imports playlists with yt-dlp, and keeps the saved Good Boy 3 playlists.
- **Inactive members:** members who never spoke can be listed sooner, veterans wait twice as long, people stuck behind verification are caught, `/stats keep` protects someone, the list can be filtered and exported, and the monthly review can remove people by itself (off by default; only members already sent the "we miss you" message, never staff or kept members, never more than a set number). A record of who was removed is kept.
- **Trivia:** about 2,580 questions in 14 categories.
- Team reminders warn when a role cannot be pinged.
- **Private messages clean up after themselves:** replies only the member can see (balance, forms, lists, confirmations) are taken down after 3 minutes of nobody touching them (change it in Settings: never, 1, 2, 3, 5 or 10 minutes). Pressing a button on one starts the wait again. Files such as exports and transcripts stay. Discord only lets a bot take a private message down for 15 minutes after it was sent, so 10 minutes is the longest wait.
- **More from v3:** role menus show how many members hold each role (and refresh after every press), a reaction role on a message Discord can't find is refused and not saved, `/verify status` checks the bot may post the panel, a personal reminder goes to the channel when the member switched DMs off, music can autoplay earlier songs when the queue runs out, and the launcher has a Shop page and Claim, Reply and Close on open tickets.
- **Names, not numbers:** the launcher shows people by name everywhere. Where it asks for a member (take an action, pay out from the treasury, keep someone from the inactive list) you type part of their name and pick them; the number never shows.
- **Leavers:** the bot keeps a record of who leaves for 60 days (7 to 365, or switch it off): name, when they joined and left, their roles, how they went (left, kicked or banned, and who and why), whether they came back, and anything that stood out (left while timed out, with warnings, within a day of joining, or while on the staff watch list). The mod log is told when something stands out. A Leavers page in the launcher lists them, and one person can be forgotten completely. Nothing they wrote is kept.
- **Economy redo:** taxes (on payments, /daily and /work, bank withdrawals and game winnings; all off until a server sets them), a server treasury that collects them (members can give, admins pay out, every move is recorded), shop sales that can go to the treasury, and a second currency with `/exchange` (name, emoji, rate and fee are the server's). New `/treasury` and `/exchange` commands, an Economy page in the launcher, and gems in `/balance`.

Prototype, not for distribution. Bot news reads this file: the part between the members markers is posted for
members, the rest goes to the admin channel.

## 4.0.0-dev.7

**Good Boy 3, rebuilt to be faster**

<!-- members -->
the bot got a big under-the-hood upgrade. everything you know works the same, just quicker
<!-- /members -->

- Every Good Boy 3 module is being carried over one to one, with the same commands, wording and saved data.
