# Changelog

## 2.1.2
**App updates from GitHub:** the installed Windows app checks the public Good-Boy-Bot repository, downloads new versions by itself (each file is checked against its SHA-512 before installing) and installs them when you restart. The Updates page shows what is happening and has Check now and Restart and update buttons. The portable app, the Mac app and the Owner build tell you a new version is out instead. Your settings, token and server data are kept.
**Take control:** re-running setup no longer loses track of a running bot. If an older copy is still running in the background, or another Good Boy app on this computer runs the same bot, the app says so and offers Take control, which stops the old copy safely (only if it really is the bot) and starts fresh. Two installs on one computer can no longer run the same bot at once.
**Client Secret check:** setup and Settings ask Discord whether the Client Secret is right before saving it, and Open dashboard warns you before a login that would fail with "invalid_client". Settings has a Change client secret field.
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
