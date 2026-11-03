# Changelog

## 2.3.3
**A big fishing expansion (level cap 100, four new places, twice as many fish, daily and weekly challenges, new rods and bait) and voice XP for Levels.**

<!-- members -->
new update just dropped

fishing goes up to level 100 now. there's 4 new places to unlock (stormglass reef, the sunken spire, aurora trench and starfall abyss) and the fish list is more than triple what it was, 108 total. new rods and bait in the shop too

there's daily and weekly fishing challenges now. finish all 3 dailies in a day and you keep a streak going, the bonus gets bigger the longer you keep it up

you get xp for being in vc now (someone else has to be in there with you) and a little bit for reacting to people's messages. tickets don't give xp anymore so no more random level ups in there

all quotes are gifs now, even if your pfp isn't animated

if something's broken let us know
<!-- /members -->

**Fishing expansion**
- The top fishing level is now **100** (it was open-ended, but nothing new unlocked after level 32).
- Levels past 32 take much more XP, and each one more than the last (level 40 is about 28k XP, level 100 about 529k). Levels up to 32 cost exactly what they did, so nobody lost a level.
- Four new places: ⛈️ **Stormglass Reef** (level 40), 🏛️ **The Sunken Spire** (55), 🌌 **Aurora Trench** (70) and ✨ **Starfall Abyss** (85).
- Catches in the new places give **1.5×, 2×, 2.5× and 3× XP**, but their fish fight harder: they move further, pull harder on the line and take more catch away when you miss.
- New rods: **Stormglass Rod** (level 42), **Spirebone Rod** (58) and **Starforged Rod** (75). New baits: **Stormfly** and **Starlure** (draws corruption).
- **Twice the fish:** every place has a second fish of every rarity, so 12 fish per place and 108 in all (there were 30). Fish you already caught keep their names.
- **Collection** has a summary of every place (🏆 when a place is complete) and a page per place with your best weight and how many you've caught.
- Reaching level 100 shows "(max)" in the fishing menu.

**Fishing challenges**
- New **📜 Challenges** button in `/fish`: **3 daily challenges** (new at midnight UTC) and **1 weekly** (new on Mondays), different for every member and always picked from places they've unlocked.
- Dailies like: catch 12 fish, catch 7 at a place, catch 2 Rare or rarer, catch a certain fish, land a fish over a weight, sell fish worth some coins, catch 5 different kinds. Weeklies like: catch a Mutated or Corrupted fish, a Legendary, a Giant, or 75 fish.
- Rewards grow with level: coins plus XP worth about 12% of your next level (60% for the weekly), paid the moment you finish. The catch message shows it.
- **🔥 Streak:** finish all 3 dailies for a bonus (coins and 3 bait). Each day in a row adds 25% to the bonus, up to 7 days.
- Admins can turn challenges off in the Games settings ("Fishing challenges"). The Fishing Wiki covers all of it, including the new fish tables and the level table up to 100.

**Fixes from the community**
- **Levels:** tickets never give XP or post level-up messages any more. `/xp ignore add|remove|list` switches XP off in any other channel or a whole category (the voice XP skips them too).
- **Tickets:** new `/ticket setup` sets the category tickets open in, the log channel and the staff role in one command. With nothing filled in it shows the current setup, and `move_open_tickets` moves tickets that are already open into the category.
- **Ticket transcripts say why the ticket was opened.** Both the text and HTML transcripts start with a "Why this ticket was opened" section: the ticket type, urgency, who opened it, who it's about, every answer from the form, and how it was closed. Messages from the bot now show what their boxes say instead of "[1 embed(s)]". Staff-only close notes stay out, because the transcript is also sent to the member.
- **Logs:** new `/logs setup` chooses the mod log and server log channels and turns each event on or off (message edits, joins and leaves, roles, nicknames, voice). Empty shows what is logged where; `/logs off` stops a log. It warns you when an event is on but has nowhere to go.

**Windows app**
- **The dashboard is built in.** It is now the first page of the app (Dashboard), already signed in, with no separate window and no "Open dashboard" step. The app's sidebar shrinks to icons while you are on it so the dashboard has the room. If the bot is stopped, the page offers a Start button.
- Fixed the Modules page: switches sat right against the module names instead of lining up on the right, and the buttons ran into the list.

**Dashboard**
- The 💬 Feedback button moved to the bottom-right; on the left it covered the sidebar menu (Logs and Appearance). Pages have room at the bottom so nothing stays stuck under it.
- The Modules page header no longer cuts off the filter buttons in narrow windows.

**Bot news: you check announcements before they go out**
- News for members (update notes and new features being turned on) now goes to the admin channel first as a draft with three buttons: **Edit & post** (opens the text so you can say it in your own words), **Post as it is**, and **Skip**. Nothing reaches members until someone picks one, and each draft is only posted once. Only people who manage bot news can press them.
- Announcements now look like a normal message instead of a card with an emoji title. Long ones are split between paragraphs. The old card style is still a setting ("Announcements look like": plain or box).
- Turn the review step off with "send each one to the admin channel first" in the Bot news settings. Without an admin channel, news is posted straight away as before.

**Quotes**
- Every image quote is now a GIF. Members with an animated profile picture keep their own animation; everyone else gets a looping slow zoom on their picture with a soft light sweeping across it (black & white or colour, same as before).
- New setting "Make every quote a GIF" (on by default). If the GIF fails or would be too big for Discord, the normal still image is sent instead, so a quote is never refused.

**XP balance (Levels)**
Members spend far longer in voice than typing, so voice now counts as much as chatting. Defaults, per minute of someone taking part:

| Source | XP | Limit |
|---|---|---|
| Chatting | 15–25 for the first message each minute (about 20) | once a minute |
| Voice (with at least one other person) | 12 a minute | up to 5 hours a day |
| Reactions | 2 | once a minute |

All of these are settings in Community. Servers that changed a number keep their own value.

**Reaction XP (Levels)**
- Reacting to someone else's message gives a little XP (2 by default), at most once a minute. Both numbers are settings, and admins can turn it off.
- Reacting to your own message gives nothing, nor do bots, tickets or channels where XP is switched off. Removing and re-adding a reaction doesn't help: the cooldown counts from the last XP given.
- Reaction level-ups are announced and give level roles like chat level-ups.
- GIFs, stickers and pictures already count as messages for XP (once a minute, like any message).

**Voice XP (Levels)**
- New setting on Community: members earn XP every minute they spend in voice. **On by default** (admins can turn it off).
- Only counts when at least one other person is in the channel (bots and deafened people don't count). Never in the AFK channel, never while deafened. Muted members only earn if you turn that on.
- XP per minute (default 12) and a daily limit (default 5 hours, 0 = no limit).
- Voice level-ups give level roles like chat level-ups do, and are announced in the level-up channel (or the voice channel's chat if none is set).

## 2.3.2
**A new look everywhere (liquid glass, a living aurora background and a Dynamic Island), migrate that replaces old role menus and learns custom commands, and a proper AutoMod page.**

<!-- members -->
- **A whole new look** for the dashboard and app: liquid glass, an aurora background and a Dynamic Island with live news.
- **Nicer role menus** that show how many people have each role.
- **Games are quiet again:** no more public lines for every rare fish.
<!-- /members -->

**The new look (dashboard, phone page and the Windows app)**
- One shared design system for all three, so they always match: deep dark theme by default (light still available), glass panels that bend the background behind them like water, a glossy highlight and a rim of light, and a slow aurora of colour drifting behind everything with a fine grain.
- Everything moves like liquid: switches whose thumb stretches as it slides, buttons that squish when pressed, a highlight that flows between sidebar items and tabs, cards that settle in, pages that blend into each other, and toasts that spring up. "Reduce motion" (Windows setting or Appearance) stops all of it.
- **Dynamic Island** at the top: your server's live status; live news (level-ups, jackpots, AutoMod catches) flows in and stretches the island open for a moment; tap it for quick jumps. On phones it sits at the bottom of the screen.
- **Dropdowns are dark**, including their open list (the white lists in the Windows app are gone), and in up-to-date browsers and the app the open list is fully styled to match.
- Toasts have **Undo** where a change can be undone.

**Modules, rebuilt**
- A grid of tiles grouped by category (Safety, Community, Fun & games, Messages & roles, Voice, Tools), each with its icon, a one-line description, a status light and a switch. Turning a module on never expands the page. Search, and filters for On, Off and Needs setup.
- Click a module for its own page: tabs for Setup (channels and roles), Settings (switches and choices), Advanced (numbers, lists, text) and Commands (every command explained). Every setting saves by itself with Undo; numbers have +/- buttons, lists are tags you add and remove, choices use plain words.
- Turning on a module that needs a channel (Clips, Bot news, Moderation, Tickets, Dead chat ping) opens a short setup sheet for it.
- Moderation's AutoMod settings live on the AutoMod page instead of being repeated.

**Windows app**
- Updated to a newer Electron (with security fixes and the styleable dropdowns).
- The app's native parts (dropdown lists, scrollbars, menus) follow the app's theme.

**Migrate, role menus, AutoMod and games**

- **Old reaction-role messages are replaced.** `/migrate scan` finds every role message from Carl-bot, YAGPDB and the others, posts a Good Boy role menu in the same channel with the same heading and text, and removes the old message (Good Boy needs Manage Messages there). Members keep the roles they already have.
- **Role menus look better**: each role is listed with its emoji and how many members have it, with a button per role (emojis included). Counts refresh a few seconds after people click. Listing roles never pings them.
- **Custom commands are learned from chat.** When someone typed `?ip` or `!rules` and the old bot answered, Good Boy learns that answer, so those commands keep working without pasting anything. The old bots' own built-in commands are skipped.
- **Command report**: the scan lists which commands your members used with the old bots and the Good Boy command that replaces each one.
- **Games are silent again by default.** The public "caught a Legendary…" lines from 2.3 spammed the channel for active fishers, so big-win announcements are now off unless an admin turns them on. When on: only the chosen wins (slots jackpots, plus Mythical fish by default), at most one line per member every 10 minutes (jackpots always), and optionally in their own channel.
- **New AutoMod page on the dashboard** (for admins, and for roles given AutoMod access): one-click presets (Off, Relaxed, Balanced, Strict), a card per rule with a plain explanation, its limit with units and what happens, word and allowed-site lists you add to and remove from, raid protection, new accounts and anti-nuke, recent catches updating live, and **Test a message**, which shows exactly which rules a message would break without posting or deleting anything.


## 2.3.1
**Purge without limits, member message stats, and `/migrate` fixes from the first real scan.**

- **Number-emoji role lists now work**: 1️⃣ to 9️⃣ weren't recognised as emojis (only 🔟 was), so most game roles were missed.
- **Role names are matched more loosely**: case, spaces and symbols are ignored, and small typos are forgiven ("Rainbow SIx Seige" still finds "Rainbow Six Siege").
- **The scan goes through everything**: every channel and active thread, up to 1,000 messages in each (it used to read 100 messages in at most 60 channels). It shows its progress while it works and says how much it read.
- **Log channels are found correctly**: TTS Bot's messages in the no-mic channel no longer look like logs, Carl-bot's "Message deleted in #…" logs are recognised, and a channel needs a few log messages before it counts.
- The report lists channels it couldn't read, so you can give Good Boy access and scan again.

**Purge without limits**
- `/purge` with no amount deletes **every** message in the channel, and amounts go up to 100,000. Messages older than 14 days are deleted too (Discord only bulk-deletes newer ones, so older ones go one by one, about one a second). Big purges ask first, run in the background with progress and a **Stop** button, and message you if they take longer than 15 minutes. Pinned messages are kept unless you say otherwise. Up to 100 recent messages still go straight away.
- **Recreate**: `/purge` with method "Recreate the channel" removes everything at once. The channel is cloned with the same permissions, topic, slowmode, category and position, the old one is deleted, and Good Boy's settings that pointed at it (clips channel, logs, sticky messages...) move to the new one.

**Member message stats**
- **`/stats member`** (or right-click a member → Apps → **Message stats**): messages **this month** and **last month** with their rank, all time, voice hours and active days, a month-by-month list of the last 6 months, when they were last active and when they joined.
- New periods everywhere in `/stats`: **this month** and **last month** (calendar months).
- The dashboard's Active members box shows this month and last month.

<!-- members -->
- **Your message stats:** `/stats member`, or right-click someone → Apps → **Message stats**, shows messages this month, last month, all time and month by month.
<!-- /members -->

## 2.3.0
**Everything is live, and other people can test the dashboard.**

<!-- members -->
- **Clips:** share your best plays in the clips channel (upload a video or paste a link). Vote with 🔥, the top clips go to Best clips, and every Monday the **clip of the week** wins coins. See the best ones with `/clips top`.
- **Quieter games:** slots, blackjack, coin flip, fishing, `/daily`, `/balance` and `/top` are now only shown to you, so playing no longer pings the channel. Jackpots and rare fish still get a shout-out.
- **Fishing Wiki:** every place, fish, rod, bait and tip, in one guide.
- **Live dashboard:** if you have been given access, changes show up as they happen, and the **💬 Feedback** button tells the admins what is broken, confusing or great.
<!-- /members -->

**The dashboard updates by itself**
- Open dashboards hear about changes the moment they happen: a module switched on or off, a setting changed (from Discord, the app or another dashboard), XP gained, coins moved, an AutoMod catch, a ticket, a moderation case.
- Changed rows in the tables light up, new ones slide in, and numbers give a little bump. A **Live** chip at the top shows the connection and the bot's response time.
- **Live activity** on the overview: level-ups, AutoMod catches, moderation actions, daily streaks, jackpots, rare fish and dead chat pings, as they happen. It never shows what anyone wrote.
- The member and voice counts and the uptime refresh every 15 seconds.
- If something changes while you are filling in a form, nothing is yanked away: a banner offers to show the latest instead.

**Testers**
- A **Testers** card on the overview: pick the testers' role and give it access to the dashboard (or access plus every tool) in one click, and copy the link to send them. If the link only works on your computer, it says so and points to Settings > Dashboard link in the app.
- Everyone gets a **💬 Feedback** button: "something is broken", "confusing", "idea" or "I like this", plus what happened. It records which page they were on.
- Admins see every report under **Tester feedback**, and new ones arrive live.

**Desktop app**
- **The full dashboard opens inside Good Boy**, already signed in as you: no Discord login and no Client Secret needed on your own computer. Every module's settings, every panel, permissions, live activity and tester feedback. **In my browser** is still there if you prefer it.
- The **Levels** and **Overview** pages show members' real **names and pictures** (from the running bot) instead of the end of their ID.
- **Updates finish by themselves.** Once a new version has downloaded, the app shows a one-minute countdown and a Windows notification, then restarts to install it. The bot is stopped cleanly and is back as soon as the app reopens. **Restart now** skips the wait, **Later** puts it off until you close Good Boy, and Settings > This computer can turn it off. (Updating to 2.3 itself still needs one restart, because 2.2 doesn't have this yet.)

**Replace your other bots (Carl-bot, YAGPDB, Statbot, TTS Bot)**
- **`/migrate scan`** looks at what the other bots left in your server and offers to set it up in Good Boy: reaction-role messages (Good Boy takes over the existing messages), log channels, starboard, welcome and goodbye messages (with their wording), roles given on join (from the audit log), counter channels and the ban list (copied into `/modhistory`). Nothing changes until you pick what to import. Step by step: `docs/REPLACING-OTHER-BOTS.md`.
- **`/migrate tags`**: paste custom commands from another bot and they work straight away.
- **Custom commands and auto-replies (new tags module)**: `?rules`, `!ip`, or replies when a message is, starts with or contains a phrase. Replies can use {user} {username} {server} {channel} {args}, never ping anyone, and have a cooldown per channel. `/tags add`, `/tags list`, `/tags remove`, and a dashboard list. The prefixes are a setting (`?` and `!` by default) so old habits keep working.
- **Server logs**: members joining and leaving (with account age and roles), role changes, nickname changes, voice joins/leaves/moves. Each can be turned on, in their own channel or the mod log.
- **`/say send` and `/say edit` (new messages module)**: post as Good Boy (plain or in a box with title, colour and picture) and change it later. Never pings.
- **Sticky messages**: `/sticky set` keeps a message at the bottom of a channel, reposted after a pause (at most every 30 seconds) with the old copy removed.
- **Counter channels**: `/counter add` turns a voice channel's name into a live number ({members} {humans} {bots} {online} {boosts} {voice}), updated every 10 minutes.
- **Activity charts** on the dashboard's Stats page: messages per day, busiest hours, members joining per day.
- **Welcome back**: roles are remembered when someone leaves (or is kicked) and given back if they rejoin within 180 days. Staff roles and anything powerful never come back automatically.
- **"We miss you"**: optional message a week before the monthly review to members who are about to be listed as inactive.

**Clips (new module)**
- Point it at your clips channel with **/clips setup**. Medal's **Send to Discord** button keeps working: MedalBot's "@Member shared a clip" post is credited to the member it mentions. Pasted clip links (Medal, YouTube, Twitch, Streamable, Outplayed, Allstar, TikTok) count too, credited to whoever pasted them. Normal chat in the channel is left alone.
- **Uploaded videos count too**, so you don't need Medal at all: clips saved with Steam, NVIDIA, AMD, Xbox Game Bar, OBS or a phone can be dropped straight into the channel. When one reaches Best clips, Good Boy uploads the file again (if it fits Discord's limit), because Discord's file links stop working after a while.
- Good Boy adds a 🔥 vote reaction to every clip. Votes from bots and the clip's owner don't count.
- With enough votes (5 by default), the clip is reposted to a **Best clips** channel with its playable video, once.
- **Clip of the week**: every Monday the most-voted clip of last week is announced and its owner wins 1,000 coins.
- 25 coins for sharing a clip (the first 3 a day), when the economy module is on.
- **/clips top** (this week, this month, all time); "Clips shared" and "Clip votes" boards in `/top`; a Top clips box in the dashboard. All amounts and the emoji can be changed.

**Bot news (new module)**
- Every time Good Boy is updated, the **admin channel** gets the full notes for each new version, and the **announcements** channel gets only the part meant for members (if that version has one). Several updates at once are posted oldest first.
- When an update brings a **new module**, the admin channel is told it is available. When a module is **turned on or off**, the admin channel hears about it.
- The first time a member feature is turned on (economy, games, dead chat ping), announcements get a short intro telling members how to use it. Only once per feature.
- Optional role ping for member news. Each of the four kinds of post can be switched off. Nothing is posted twice, and turning Bot news on posts nothing about the past.
- Set it up with **/botnews setup** (pick the two channels), check it with **/botnews test**, or change it from the dashboard.

**Quieter games**
- Slots, blackjack, coin flip, fishing, `/daily`, `/balance` and `/top` now answer privately: only the player sees them. Before, every play was a new public message, which notified everyone following the channel.
- Big moments still show: a jackpot, a 20x+ slots win or a legendary, mythical or mutated fish posts one short public line with the player's name (never a ping).
- Admins can switch either back in the games and economy settings.

**Message history (stats)**
- `/stats backfill` no longer gets stuck on "thinking". It used to count inside the command, and a big server took longer than the 15 minutes Discord allows. It now runs in the background: you get an answer straight away, the private reply shows live progress, and the bot **messages you when it's done** (or posts in the channel if your DMs are closed). `/stats coverage` shows the progress too.
- Leave **days** empty to count **all time**, back to the server's first message. The old 5,000-per-channel and 50,000-total caps are gone.
- Threads and forum posts are counted too, both active and archived.
- Counted history now shows up everywhere: pick **all time** in `/stats me`, `/stats top` or `/stats server` (it used to be called "since tracking began"), and once history has been counted that is the default. New periods: **last 90 days** and **last year**.
- New **Active members** box in the dashboard's Stats page: every member with activity, when they were last active, messages and voice in the last 30 days, all-time messages (live and counted history together), and whether they are still in the server.
- If the bot restarts mid-count, it starts the count again by itself. A second `/stats backfill` while one is running just shows the progress.

**Monthly inactive-member clean-up (stats)**
- **`/stats inactive`** lists members with no messages, voice time or reactions in the last 30 days (or any number you pick). Members who were never active come first, then whoever has been quiet longest, with when they joined. Live and backfilled history both count.
- Never listed: bots, the owner, staff (anyone who can kick, ban, manage the server or is an admin), roles you exempt, and anyone who joined less than the window ago.
- Kick from the list: pick members from a dropdown or press **Kick all**, then confirm. Every member is checked again just before the kick, so someone who spoke in the meantime is skipped. By default they get a friendly message first ("You're welcome back any time!"), which you can change or turn off.
- The same list is on the dashboard (Stats > **Inactive members**), with a Kick button per row and **Kick everyone listed** (type KICK to confirm).
- **Monthly activity review**: pick a staff channel and on the 1st of each month the bot posts how many members have gone quiet, with a link to the list.
- If activity has been tracked for less time than the window, the list says so, because "never active" might just mean "before tracking began". Run `/stats backfill` first for an accurate list.
- New permission "See inactive members and kick them" (admins by default).

**Safety**
- **Tester access, "every tool" is now "every read-only box".** One click only gives boxes that just show information. Boxes with buttons (kick, reset XP, AutoMod switches) or private information (tickets, the watch log) are never handed out in one click; admins can still give them on the Permissions page.
- **Server-wide destructive buttons are admin-only**, whatever roles have been given: the ones that ask you to type a word (Reset everyone, Kick everyone listed).
- **The desktop app's sign-in link is refused if it arrives through the shared dashboard link** or any proxy, not just from other computers.
- **Clips only downloads from Discord's own file servers** when reposting an uploaded video.
- The in-app dashboard window is sandboxed and can't reach the app's own functions. It only shows the dashboard; any other link opens in your browser.
- The desktop sign-in uses a one-time link (48 random characters, works once, for one minute) that only the running bot hands to the app.
- The live stream needs the same sign-in and permissions as the rest of the dashboard.

## 2.2.0
**The first test build for the update system.** 2.2 is a big change on purpose: two new modules, a new way commands collect input, and new database tables. Use it to check that an update can be installed, rolled back and hot-reloaded while people are in the middle of using the bot. Step-by-step: `docs/V2.2-TEST-PLAN.md`. Nothing here has been tried on real Discord yet.

**Every command is a popup**
- No command asks you to type anything in Discord's command box any more. Commands are sent to Discord without their typed options; running one opens a popup built from them: text fields, dropdowns for choices and yes/no, number fields with their limits, and member, channel and role pickers. Subcommands stay as they are (picking one is not typing).
- Commands that need more than 5 answers are asked in parts: submit part 1 and press **Continue** for the next. The command runs when the last part is in.
- A wrong answer (a number out of range, a member who left) is explained, with a **Try again** button.
- Commands that already had their own designed popup (polls, parties, team reminders, role menus, member IDs, verification, ticket panels, event voice hubs) keep it.
- Popups work in the Discord desktop app, in the browser and on phones.

**The modal pipeline (for new commands)**
- New core piece `src/modalpipe.js`: a command serves a private button, the button opens a popup, the popup does the work. Nothing is typed into slash command options.
- Each step carries a signed token (owner, form, target, expiry) in the button's ID, so nothing is held in memory between steps. Buttons and popups keep working across a hot reload **and** a full restart, nobody else can press your button, a changed ID is rejected, permissions are checked again on submit, and a popup can only be submitted once.
- A mistake in a popup (bad colour, not enough coins...) answers with the error and a **Try again** button that reopens the form already filled in.
- **`/warn`** has no options now: **Configure warning** opens a popup with member, warning reason, severity and duration/severity notes. Right-click a member → Apps → **Warn member** skips the member picker.
- **`/announce send`** and **`/announce schedule`** have no options now: **Configure Announcement** opens one popup (channel, title, main text, hex colour, pings; scheduling asks for when and repeat instead of title and colour). Pick the @everyone role to ping everyone. `/announce cancel` is gone: `/announce list` has a picker to cancel one. Popups opened on 2.1 still finish after the update.

**New: `/modules`, the module control panel in Discord**
- One command, nothing to type: a private panel lists every module with its status. Pick one to see what it does, its commands and every setting with its current value.
- **Turn on / Turn off** buttons, and **Edit settings** opens popups built from the module's own settings: on/off and choices are dropdowns, channels and roles are pickers, numbers and text are fields, lists are one entry per line. Big modules are split into pages of 5.
- Saves through the same checks as the dashboard, shows what was saved and what was refused, and works for every module, including ones added later.
- **`/module` and `/config` are popups now**, with nothing typed in the command. `/module` asks which module and what to do (turn on, turn off, show details and settings, reload). `/config` asks which module, then **Edit settings** opens its settings. The old typed forms (`/module enable name:…`, `/config set module:… key:… value:…`) are gone.

**New: economy module**
- `/balance`, `/daily`, `/pay`, `/top`, `/economy-admin`, right-click **View wallet** and **Pay member**.
- Daily streaks: claim every 20 hours, the streak survives 48 hours, +5% per day (up to +150%), bonuses on days 7, 14 and every 30, and a **Streak Shield** every 7 days that saves the streak once.
- **Live leaderboards** (`/top`): 10 per page, Previous/Next turn off at the ends, every click reads the database again, only the person who opened it can page it (anyone else gets their own copy), boards for coins, streaks and the games, and a global board for servers that opt in.

**New: games module (needs economy)**
- `/slots` with a server jackpot pool, `/blackjack` (hit, stand, double), `/coinflip`, and `/arcade` to post a panel anyone can play from. Every bet is typed in a popup; results have **again** and **change bet** buttons.
- `/fish`: pick a place, rod, bait and tackle in a popup, then reel with buttons while a slider shows the fish and your catch zone. 5 places unlocked by level, 30 fish from Common to Mythical, Mutated and Corrupted variants, a shop, a bag and a collection log.
- Outcomes are decided and paid before any animation starts, and hands and fights are saved in the database, so a reload or restart mid-game changes nothing.
- Coins are play money: they cannot be bought or cashed out.

**New: dead chat ping (deadchat module)**
- `/deadchat` opens a popup: which channel to watch, which role to ping, how many quiet minutes, and the shortest gap between pings. When the channel goes quiet, the bot posts a random conversation starter and pings the role, once per quiet spell (someone has to talk before it pings again).
- Conversation starters, and every other setting, can also be changed in the dashboard.
- Pings go to an opt-in **@deadchat** role: leave the role empty in the popup and the bot creates it. Every ping, and a panel posted at setup, has a **Ping me** button that adds or removes the role for whoever presses it.

**Dashboard**
- No more "null": empty sections say something useful, like "Nothing has been caught yet."
- **Levels box** in Community: everyone's rank, picture, level, XP and progress, with Give XP, Take XP, Reset and Reset everyone. Level rewards are handed out after each change.
- **Permissions in plain words**, grouped by feature. Each one shows its default, and you add roles from a picker instead of a wall of checkboxes. Divider roles (like "--- bots under -") and bot roles are hidden.
- Buttons open the page's own dialogs instead of browser boxes: AutoMod's action is a dropdown (Server default, Delete it, Delete + warn, Delete + time out), and big resets ask you to type RESET.
- Tables explain their columns (for example what "This week" and "Exemptions" mean) and say why they are empty.
- The whole dashboard now has the desktop app's look: Inter type, frosted grouped cards, pill buttons and iPhone-style switches, in light and dark.

**Desktop app**
- **Levels only**: Settings > Server data > Export levels saves just members' XP in a small .goodboy file. **Merge levels** adds a file's levels (from a levels file or a full data file): everyone keeps their higher level, new members are added, nothing else changes, and a backup is made first. A levels file can't be loaded by mistake with "Import data", which would replace everything.
- When no version has been published at all, the Updates page now says so instead of "You have the latest version".

**Also**
- Research notes and the reasons behind the economy design: `docs/ENGAGEMENT.md`. Game rules, data tables and flows: `docs/GAMES.md`.
- 335 automated tests (43 new), including hot reloads in the middle of a blackjack hand, a fishing fight and an open payment popup.

## 2.1.3
**Dashboard link in one button:** Settings > Dashboard link > Set up does everything. It installs Tailscale (through winget, or Tailscale's own installer, which is only run when Windows confirms it is signed by Tailscale Inc.), opens Tailscale's sign-in page, opens the page to allow public links, turns the link on and adds it to your bot's Discord login. Each step shows a check mark as it finishes, and the steps that need you open by themselves and carry on when you are done. After that the link turns itself back on whenever Good Boy starts.
**Pair your phone:** once the link is on, Settings shows a code to scan. On iPhone it opens the phone page with a reminder to add it to the Home Screen. On Android it offers "Open in the Good Boy app", and the app asks before connecting, showing the address.
**Keep awake:** a switch stops the computer sleeping while the bot runs, so the link keeps working.

## 2.1.2
**App updates from GitHub:** the installed Windows app checks the public Good-Boy-Bot repository, downloads new versions by itself (each file is checked against its SHA-512 before installing) and installs them when you restart. The Updates page shows what is happening and has Check now and Restart and update buttons. The portable app, the Mac app and the Owner build tell you a new version is out instead. Your settings, token and server data are kept.
**Take control:** re-running setup no longer loses track of a running bot. If an older copy is still running in the background, or another Good Boy app on this computer runs the same bot, the app says so and offers Take control, which stops the old copy safely (only if it really is the bot) and starts fresh. Two installs on one computer can no longer run the same bot at once.
**Client Secret check:** setup and Settings ask Discord whether the Client Secret is right before saving it, and Open dashboard warns you before a login that would fail with "invalid_client". Settings has a Change client secret field.
**Dashboard link (works from anywhere):** Settings > Dashboard link > Share dashboard gives the dashboard a public https link with Tailscale Funnel (free; no router changes, your home IP stays hidden). The app adds the link to your bot's login Redirects when Discord allows it, or shows exactly what to paste. Discord login still decides who can do anything.
**Phone app:** the dashboard has a phone page at /app: bot status, the levels leaderboard with names and pictures, announcements (channel, title, ping), event hubs (start, lock, end) and module switches. On iPhone, open your dashboard link + /app in Safari and choose Share > Add to Home Screen. On Android, install the Good Boy app (.apk) and paste your dashboard link once.
**Data files:** Settings > Server data can export everything to one .goodboy file and import one back (the current data is backed up first). The token is never included.

## 2.1.1
This is 2.1 with the later work folded in (there is no 2.2). Everything is tested against simulated Discord; nothing in this release has been tried on real Discord yet (see the README's first-run checklist), and the desktop app is **written but not built or run**.

**New modules**
- **tempvoice:** "join to create" voice rooms with `/room` controls (name, limit, privacy, invite, kick, ban, transfer, claim) and automatic cleanup.
- **partyfinder:** `/party` posts with Join/Leave/Close buttons, optional voice room and ping role, start reminders, automatic expiry.
- **stats:** message, voice and reaction counts (never text), `/stats`, weekly recap, history backfill, dashboard overview, per-member opt-out and erase.
- **achievements:** 17 built-in achievements plus custom ones, streaks, announcements, privacy controls.
- **eclipseid:** member cards with IDs, linked game accounts (never claimed as verified), per-field visibility. Optional Roblox name check (off, unverified against the real API).

**Updates and supervisor**
- `npm run supervised`: restarts after crashes, gives up with a clear reason after repeated ones.
- Signed updates (Ed25519), channels (stable/beta/development), sha256 + size checks, strict package unpacking, data backup before each switch, trial period with automatic rollback, bad versions remembered. Dashboard **Updates** page for the bot owner and `npm run update`. Off by default. See `docs/UPDATES.md`.
- Release tooling: `npm run release:keygen`, `npm run release`.

**Desktop app (built by GitHub, see docs/DESKTOP.md):** Electron control panel for Windows and macOS in `desktop/`, see `docs/DESKTOP.md`.

**Also**
- `/terms` and `/privacy` pages (built-in text, replaceable from `data/legal/`).
- The bot's data folder can be moved with `GOODBOY_DATA_DIR` (the supervisor sets it).
- Dashboard shows "Member ID" for the eclipseid module.

**Desktop app:** a setting for where Node is (a packaged app cannot see the terminal's PATH, so it also looks in the usual install folders), a launch window in the same liquid glass look as the dashboard, glass cards, icons, and a GitHub build that makes the Windows installer, a portable `.exe` and the Mac `.dmg`, then starts the built app and checks that its window really drew.
**Slow commands:** every command now has a safety net. If it has not answered after about 2 seconds, the bot defers it so Discord does not show "application did not respond". Popup commands are exempt (a popup must be the first response). A command can declare `defer: 'public'` or `'none'`.
**Pings:** a missing "Mention @everyone, @here, and All Roles" permission is now reported to whoever scheduled the announcement too, and a bot that cannot identify itself no longer claims the permission is missing.

**Event voice hubs:** `/voicehub event` opens one popup (event name, players per team, most teams, panel channel, room category) and posts a sign-up panel. Members press **Join solo** (matched with others; a spot that opens later goes to whoever is waiting), **Join with friends** (pick them in a popup; they press Accept), or **Make a team room** (solo players fill it). Each team gets its own voice room, "<Event> - Team N", that only the team can join, and anyone already in voice is moved in. A new team room waits a few minutes for its team; once people have been in, it is removed a few seconds after the last one leaves. The host or staff can lock sign-ups or end the event from the panel.
**Popups everywhere:** `/announce`, `/remind team`, `/party`, `/rolemenu`, `/verify setup` and `/ticket panel` open one popup with dropdowns and channel/role pickers when run with nothing filled in.
**Voice rooms:** empty rooms are removed on time (5 seconds by default), not at the next sweep.
**Fixed while testing:** the supervisor's restart timer no longer lets the process exit while waiting to restart the bot.
**Fixed:** a channel setting left empty no longer crashes reminders, the party finder, announcements and verification.
**Fixed on the PC run:** the `/id edit` popup had a field label over Discord's 45-character limit, so real Discord would have refused to open it; it now has a short label with the list in the placeholder, and a test checks every label length.

**Unchanged on purpose:** your database file name (`data/eclipse.db`), settings, permissions and data.

## 2.1.0-rc.1
Release candidate: everything below is tested against simulated Discord and on a PC with the real discord.js; real-Discord checks are listed in the README's first-run checklist.

**New**
- **AutoMod rebuilt:** rules for spam, words, links/invites, mass mentions, repeated messages, capital letters and emoji; an action per rule (delete, delete + warn, delete + timeout, or the server default); exemptions by role, channel or category, per rule or for all; a recent-activity list; `/automod`; a dashboard panel. Your existing AutoMod settings carry over unchanged.
- **Tickets rebuilt:** eight categories with urgency, popups, report details, a staff-only watch log with exact/possible match flags, required close notes kept staff-only, appeals with reasons, priority changes with reasons, auto-close, history and stats, dashboard panels.
- **Popups** for moderation actions, polls, suggestions and announcements (leave out the text and a popup asks).
- **Live leaderboard** message (`/liveboard`).
- **Animated quotes** for animated avatars.
- **No-mic text-to-speech channel** (`/tts setup`, `/tts reading`).
- **Reminders** module with team reminders for several roles; announcements post as plain messages with working pings.
- **Dashboard:** liquid-glass redesign, real server numbers, panels for AutoMod/tickets/watch log/reputation, and **moderator access** through the new `dashboard.access` permission with per-panel permissions enforced on the server.
- **Hosting guide** for reaching the dashboard without a domain (`docs/HOSTING.md`), `DASHBOARD_TRUST_PROXY`.

**Changed**
- The dashboard's request header is now `X-GoodBoy`.
- Quotes and announcements are posted to their configured channels.

**Unchanged on purpose:** your database file name (`data/eclipse.db`), settings, permissions and data.
