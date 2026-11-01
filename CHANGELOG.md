# Changelog

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
