# Good Boy 4: what to test, in order

Use a separate test bot in a test server, with Server Members and Message Content turned on at Discord's
developer page. Do not run Good Boy 3 on the same bot at the same time. Tick things off as you go.

## 1. Start it
- [ ] Launcher > Check-up: press it after the bot is online. Anything marked red or amber is explained there (token, data, modules, permissions, problems).
- [ ] The launcher opens. Settings: add the bot token. Home: Start. The light turns green.
- [ ] Modules: your test server is listed. Switch a module off and on.
- [ ] Invite link from the launcher works.

## 2. Slash commands in Discord
Commands in the same area are behind one command that opens a private menu: `/money`, `/games`, `/mod`, `/community`, `/roles`, `/me`, `/social`, `/voice`, `/server`. Where this list says `/ban`, use `/mod` and pick Ban; `/daily` is `/money` > Daily; `/fish` is `/games` > Fish; `/backup create` is `/server` > Backup > Create. `/rank`, `/leaderboard`, `/music`, `/ticket`, `/remind`, `/giveaway`, `/poll`, `/suggest`, `/time`, `/xp`, `/levels`, `/starboard` and `/achievements` are still typed as they are.
- [ ] Each of the nine group commands opens a menu; picking an item opens its popup (or a second menu when it has several parts, such as Backup).
- [ ] `/balance`, `/daily` (twice: the second says wait), `/work`, `/pay` (form opens), `/top`, `/bank` (deposit and withdraw).
- [ ] `/shop` and buying something. `/rob` (turn robbing on first).
- [ ] `/treasury` and `/exchange` (turn the second currency on in the launcher first).
- [ ] `/rank`, `/leaderboard`. Chat for a bit and check XP goes up.
- [ ] `/warn`, `/timeout`, `/kick`, `/ban`: each opens its form and writes a case. `/modhistory`.
- [ ] `/ticket` panel: open a ticket, claim, close with notes, transcript.
- [ ] `/rolemenu create`, press the buttons: member counts show and refresh.
- [ ] `/reactionrole add` with a wrong message ID: it refuses and saves nothing.
- [ ] `/verify setup`, `/verify status`.
- [ ] `/remind me` and `/remind team` (pick a role that cannot be pinged: it warns).
- [ ] `/giveaway start`, `/counting`, `/fun`, `/trivia` (all categories), `/hangman`, `/tower`, `/wires`, `/bingo`, `/memory`, `/pong`, `/slots`, `/blackjack`, `/coinflip`, `/fish`.
- [ ] `/stats inactive`, `/stats keep`.
- [ ] `/music sound filter` (Bass boost, Nightcore, Slowed): the next downloaded song sounds different; Off brings it back. Radio is never filtered. The launcher's Music page has the same menu.
- [ ] Radio: add a station, play it, cut your connection for a moment: it picks the stream up again by itself.
- [ ] `/suggest`: a thread opens under the suggestion. `/announce` or a party with a role that can't be pinged: you get a private warning.
- [ ] A giveaway entrant who leaves the server before the draw cannot win.
- [ ] Private messages (only you see them) disappear after about 3 minutes untouched. Pressing a button on one keeps it.

## 3. Launcher pages (bot running)
- [ ] Members: numbers and boards show names, not numbers.
- [ ] Inactive: Scan the server, filter, Keep someone, remove one test account (asks twice).
- [ ] Leavers: have a test account leave, then check it appears with the right "how". Kick and ban one too.
- [ ] Moderation: pick a member by typing their name, warn them. Case shows in Discord's mod log.
- [ ] Tickets: Claim, Reply, Close from the launcher.
- [ ] AutoMod: switch a rule on, trigger it.
- [ ] Economy: set a tax, pay someone, see the treasury and record update. Pay out from the treasury.
- [ ] Shop: add a role item and an item, buy them in Discord.
- [ ] Music: join a voice channel, add an audio link or a radio station, controls, volume, seek, playlists. Search and playlist import need media links turned on with `/music` in Discord.
- [ ] Permissions: give a role a permission (for example Warn members) and check the command follows. Lists: end a giveaway, delete a custom command.
- [ ] Logs: events appear live and do not repeat.
- [ ] Settings: the private message timing option.
- [ ] If a command says the bot can't respond: Logs > filter Problems shows why, and Check-up lists anything missing.

## 3b. Phone and web app
- [ ] Settings > Phone and web: write your public https link, switch it on. Add `<link>/auth/callback` under OAuth2 > Redirects in the Discord Developer Portal, and make sure the client secret is saved.
- [ ] Open the link on your phone: Sign in with Discord. Home, Members, Moderation, Economy, Music, Lists, Permissions work and the bar of pages along the bottom scrolls.
- [ ] iPhone: Safari > Share > Add to Home Screen. Android: Chrome > Install app. It opens like an app, with no browser bars.
- [ ] A friend with Manage Server in one of your servers signs in and sees only that server. Someone without it is refused.
- [ ] Sign out, and check you are asked to sign in again. Close the app for a day: you are still signed in.
- [ ] Tokens, Check-up and From Good Boy 3 are not on the phone (they stay in the app on the computer).

## 3c. New since the last test
- [ ] The whole program looks like the pixel design. Settings > Look switches to Classic and back. Every page and menu from before is still there.
- [ ] Modules > Welcome > Setup: choose a welcome and a goodbye picture (try a GIF); the preview shows the message with the picture. Remove one. Have a test account join and leave.
- [ ] Modules > Critters > Setup: add a character with a picture from your computer, edit it (the picture stays), remove it.
- [ ] Commands page: search for `starboard`, open it, pick Setup, choose a channel, run. Run a command with a member box (search by name). A command whose module is off says so.
- [ ] Level up in chat, press the level-up message's rank button: the card shows your profile picture (not initials). Try an account with an animated profile picture: the card moves.
- [ ] Music: with media links on for the server (Music page has the switch), add a Spotify song link, a Spotify playlist link, an Apple Music song link, a Deezer playlist link and a Pandora song link. Each is added; songs are found on YouTube when they play. Add to a playlist from the search results.
- [ ] `/me` > Time zone: set yours, set a friend's. `/time` shows their time; `/time` with `at` 8pm shows a time in everyone's own zone. `/me` > Time zone list.
- [ ] Alt detector: Modules > Alt detector, set a channel. Ban a test account, then have an account with the same profile picture join: staff are told in the channel. `/mod` > Altcheck on a member.
- [ ] Plural proxy: give the bot Manage Webhooks and turn the module on. `/me` > Plural > Add a member with the prefix `k:`; type `k: hello`: the message is replaced by one from that member. `/me` > Plural > Autoproxy, `\` at the start to skip, Who.

## 3d. Tickets on the dashboard
- [ ] Tickets page: each row shows the urgency tag, who opened it, who it is about (reports) and which moderator has it.
- [ ] Open a ticket: the conversation shows; Claim it, then write a reply and Send. In Discord the ticket channel says who claimed it (from the dashboard) and shows "Staff reply from <your name>"; the person who opened it is pinged.
- [ ] Close it from the dashboard with a resolution; the list now says who closed it.
- [ ] Phone/web: set a ticket staff role (Modules > Tickets > Setup). Sign in with Discord as a moderator who has that role but not Manage Server: only the Tickets page is there, and only for that server. Try claiming and replying.

## 3e. Pixel pictures and image quotes
- [ ] Right-click a message > Apps > Quote Image: the card is a pixel frame with the speaker's picture as pixel art on the left and the words in a pixel font. Try Quote Image (Color) too.
- [ ] Quote a message with a fancy-letter name (like 𝓚𝓪𝓲), another script (Japanese, Cyrillic, Arabic), symbols and emoji: every character shows. A custom server emoji reads as `:name:`.
- [ ] Quote a message that has a picture: the picture shows as pixel art under the words.
- [ ] Quote your own message: you are told to ask someone else. Modules > Quotes > "Let members quote their own messages" on: it works.
- [ ] Someone with an animated profile picture: their quote moves. A normal picture gets a light band stepping across.
- [ ] `/rank` and `/family tree`: profile pictures are pixel art. Modules > Community (rank cards), Family and Quotes each have a "pixel art" switch; turn one off and that picture goes back to the original.

## 3e0. Rank card and the phone web app
- [ ] Level up, press **View rank** on the level-up message: the card shows your name and profile picture (not `<@…>`).
- [ ] `/rank` > Customise: there is a **Background picture** upload box. Upload a picture from your phone or computer, press Submit, wait a few seconds, run `/rank`: the picture is behind the card. Open Customise again: pick **Remove it**: the card goes back to normal. Try a file that is not a picture: it is refused.
- [ ] Phone web app, with a single server: no "null" under any page title; Permissions reads normally; Shop, Role menus, Leavers and Lists fit the screen; the menu labels at the bottom do not overlap; the top of every page is clear of the status bar.

## 3e1. /help and the plural proxy
- [ ] `/help` shows a private list; switch a module off and its commands disappear from it.
- [ ] Plural: Modules > Plural on, give the bot **Manage Webhooks** and Message Content. `/me` > Plural > Add a member with the prefix `k:`, then type `k: hello` in a channel: the message is replaced by one from that member. Without Manage Webhooks in the channel, a short note says what to give it.

## 3e2. Games and private windows
- [ ] Play every arcade game and press its buttons quickly, several people at once: no "The application did not respond", and no button waits behind someone else's.
- [ ] A private game window shows a **Close** button; pressing it removes the window.
- [ ] Leave a private game window alone for 5 minutes: it disappears. Press a button on it at 4 minutes: it stays another 5.
- [ ] A transcript or an export you asked for in a private message does not disappear.

## 3f. Licence and the move from Good Boy 3
- [ ] Settings > Licence: with a Good Boy 3 licence key in Good Boy 3's settings, it shows "Licence active" for the right person. With a key for a different bot it says so. Paste a made-up key: it is refused. Remove it, restart: it is not taken over again.
- [ ] The menu has no "From Good Boy 3" page.
- [ ] **The move (needs the last Good Boy 3 and a Good Boy 4 release on the public releases page, so it cannot be tried before both are published; use a test bot first):** open Good Boy 3 and wait: the card "Good Boy 4 is here" shows with a countdown. Press **Download Good Boy 4**: progress shows, the bot goes offline for a moment, Good Boy 4 opens, comes online with the same name, levels and coins, and Good Boy 3 is removed.
- [ ] Break it on purpose (turn off the internet during the download): nothing changes and Good Boy 3 keeps running. Block Good Boy 4 from starting: Good Boy 3 comes back and the card says it will try tomorrow.
- [ ] The bot's token is not left on disk afterwards (no `handoff-v4.json` next to Good Boy 3's settings).

## 4. Move your real data (last)
- [ ] Launcher > From Good Boy 3: Copy my Good Boy 3 data, then Check the copy. Everything from Good Boy 3 should be in it.
- [ ] Copy again later and check that your earlier copy is kept in a `before-recopy` folder.
- [ ] Open the launcher on the copied data and repeat a few of the checks above on a test server.
- [ ] Switch: stop Good Boy 3, tick both boxes on the page, Start Good Boy 4 now. To go back, stop it and open Good Boy 3.

### 3g. Parties and the treasury
- `/party create` with `when` = `8pm` (with your time zone set in `/me`) shows the right start time; a clock time with no zone asks you to set it.
- On a party post, press 📣 Ping as the host: pick a role, it pings once; a second press within 10 minutes is refused; another member is refused.
- Join a voice channel, start a party: the post shows your channel; a friend already in another voice channel who presses Join is moved to yours. Close the party: your channel stays.
- `/treasury`: only the server owner sees **Add coins**; an admin who isn't the owner does not.

### 3h. Quote looks
- `/quote` or right-click > Quote Image: with the default setting it is the classic look (black, picture fading in on the left).
- Dashboard > Modules > Quotes: change **Look of image quotes** to midnight, paper, sunset, forest and pixel; each new quote follows.
- Choose **custom** with no licence: quotes stay classic. Add a licence, set the three colours and the font: quotes use them. Type a bad colour (`red`): quotes fall back to classic.

### 3i. Colour pickers
- Dashboard > Modules > Quotes > Settings: the three custom colours show a picker and a code box; choose with the picker (it saves when you close it) or type `#f0a`; refresh and it shows `#ff00aa`.
- `/rank` > Customise: the two colours are dropdowns of swatches; pick one, save, `/rank` uses it. Open it again: the first choice is "Keep my current colour".
- `/say send` with `colour` picked from the list; with both `color` typed and `colour` picked the typed one is used.
- An announcement (Announce > send): the colour box is a dropdown with "No colour".

### 3j. Ticket search
- Tickets page: type a word someone said in a ticket; only those tickets stay. Type `#12` for one ticket, a member's name for theirs. Clear the box and all come back.
- Open a ticket > **Save transcript**: a `ticket-<number>.txt` is saved with every message.

### 3k. Restarts
- Open a game window (`/arcade` → a game) or a form, leave it open, press **Restart** on the Home page: the window changes to the restart notice and disappears a few seconds later.
- With Bot news set up (`/botnews setup`), press **Warn servers**: the announcements channel gets the heads-up, and the toast says how many servers were told.

### 3l. AutoMod, word lists and where it works
- Dashboard > AutoMod: each rule is a card. Switch **Banned words** on, type `spam` and press Enter: a chip appears. Paste `one, two, three` or a column of words copied from a document: separate chips. Paste `these are separate words` as plain text: one chip per word. Paste a 60-letter word with no spaces: refused with a message.
- Type `https://www.YouTube.com/watch?v=1` in the allowed websites box: it becomes `youtube.com`.
- AutoMod > **Where it works** > Only channels I pick: tick two channels; post a banned word in a ticked channel (removed) and in an unticked one (left alone). Switch back to Every channel.

### 3m. Bot name, picture and banner
- No licence: Settings > Bot name, picture and banner says whether the Good Boy look is in place. Change the bot's picture in the Developer Portal, press **Check and put back now**: it returns. (Name changes are limited to two an hour.)
- With a licence that has `whitelabel`: choose a name, a picture and a banner and Save; they show on Discord and stay after a restart. The description ends with the Good Boy credit line.
- Moving from Good Boy 3 with a licensed bot that has its own look: after the move the look is unchanged.

### 3n. Transcripts, Logs, What's new
- Open a ticket > **Save transcript**: an `.html` page with each message and who said it; **As text**: a `.txt`.
- Logs: the top line says no problems (green) or how many in the last 10 minutes.
- What's new lists the changes.

### 3o. Music joins your call
- Join a voice channel on Discord, open the Music page: it says "You're in 🔊 <channel>. Press play and Good Boy joins you there." Press play on a song or playlist: the bot joins that call.
- With the bot playing in another channel, move to a different call: **Move to my call** appears and moves the bot.

### 3q. The installer (needs Windows)
1. Run Good-Boy-4-Setup.exe on a PC with no Good Boy 4: no password prompt, it installs under `%LOCALAPPDATA%\Programs\Basic Ghost Labs\Good Boy`, the Start menu entry works, and Good Boy shows in Settings, Apps with the right version.
2. Open Good Boy, then run the installer again without closing it: it finishes, the open copy keeps working, and the next start is the new version with no `.old` file left.
3. Update from inside the app (3p), then check Settings, Apps shows the new version.
4. Uninstall: shortcuts and the folder go; answer No to "delete your data" and confirm `%APPDATA%\Good Boy 4` is still there; install again and your levels are as they were.
5. Install while a portable Good-Boy-4.exe is in Downloads: both read the same data and neither damages it.

### 3p. Updating from inside the app (needs Windows and two real releases)
1. Install Good Boy 4 at version N (for example 4.0.1) and publish a newer release N+1 (non-test, `v4.x`, with `Good-Boy-4.exe`).
2. Open the app: within about 20 seconds Home shows "Good Boy N+1 is ready" and the Updates page shows the same. "Check again" works with no internet (a kind message, nothing changes).
3. Press Update now: a progress bar fills, the window closes, and the app reopens on N+1 with the bot online again. Settings, levels and the token are as they were.
4. Look in the folder holding the program: no `.part`, `.new` or `.old` files remain after the reopen.
5. Break it on purpose: serve a release whose checksum is wrong. The update is refused with "does not match its checksum" and the running program is untouched.
6. A web host running Good-Boy-4-no-window.exe gets the window-less file, not the launcher.
