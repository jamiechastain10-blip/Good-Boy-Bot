<div align="center">

<img src="src/dashboard/public/good-boy-logo.png" alt="Good Boy logo" width="110">

# Good Boy
**Basic Ghost Labs** · modular Discord bot platform

### ⬇️ Download

[![Download for Windows](https://img.shields.io/badge/Download_for_Windows-Installer-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/jamiechastain10-blip/Good-Boy-Bot/releases/latest/download/Good-Boy-Setup.exe)

[![Windows portable](https://img.shields.io/badge/Windows-Portable_.exe-3A6EA5?style=flat-square&logo=windows&logoColor=white)](https://github.com/jamiechastain10-blip/Good-Boy-Bot/releases/latest/download/Good-Boy-Portable.exe)
[![Mac](https://img.shields.io/badge/Mac-.dmg_(Apple_silicon)-555555?style=flat-square&logo=apple&logoColor=white)](https://github.com/jamiechastain10-blip/Good-Boy-Bot/releases/latest/download/Good-Boy-Mac.dmg)
[![Android](https://img.shields.io/badge/Android-phone_app-3DDC84?style=flat-square&logo=android&logoColor=white)](https://github.com/jamiechastain10-blip/Good-Boy-Bot/releases/latest/download/Good-Boy-Android.apk)
[![All downloads](https://img.shields.io/github/v/release/jamiechastain10-blip/Good-Boy-Bot?style=flat-square&label=latest&color=F2A93B)](https://github.com/jamiechastain10-blip/Good-Boy-Bot/releases/latest)

The **installer** is the one to pick on Windows: it sets everything up and updates itself when a new version comes out.
The portable `.exe` runs without installing (and tells you about updates instead). The Mac app is not signed yet:
right-click it and choose **Open** the first time.

**Can't update, or the app opens to a blank window?** Download the installer again from the button above and run it.
Your bot, settings and data are kept. See [Troubleshooting](#troubleshooting) below.

</div>

---

### What's new in 3.0

- **A new dashboard and Windows app**: one clean dark design, a Home page with what needs attention and charts for the
  last 14 days, a server switcher, channel and role pickers, and right-click menus.
- **Moderation from the dashboard**: warn, time out, kick or ban from a ticket, a member's name or the Moderation page,
  with the full case history and search. The bot checks the same permissions as the commands.
- **Tickets rebuilt**: pick a type, pick the member, drop screenshots straight into the form, and a searchable archive
  that reads like the original chat.
- **Fishing expansion**: 24 places, 2,000 fish, levels up to 4,000, strike timing and quick-time events.
- **Animated games** (being tested in 3.0.4: real cards, spinning reels, a moving fishing lake), **Pong**, **music**, **pictures in welcome and leave messages**, and **What's new** in every app.
- **Licences**: a licensed bot can use its own name, picture, banner and description in the Windows app (the Good Boy
  credit always stays).

Every change, version by version: [`CHANGELOG.md`](CHANGELOG.md).

---

### Older versions

| Version | Where to find it |
|---|---|
| **3.0.x** (latest) | `main` and the [releases page](https://github.com/jamiechastain10-blip/Good-Boy-Bot/releases/latest) |
| 2.3.x | the [`v2.3.3` release](https://github.com/jamiechastain10-blip/Good-Boy-Bot/releases/tag/v2.3.3) and earlier 2.3 releases |
| 2.2.0 | the [`v2.2.0` tag and release](https://github.com/jamiechastain10-blip/Good-Boy-Bot/releases/tag/v2.2.0) (no branch, see below) |
| 2.1.3, 2.1.2, 2.1.1 | the `v2.1.3`, `v2.1.2` and `v2.1.1` branches |
| 1.0 | the `v1.0` branch (the original version) |

**Why is there no 2.2 branch?** 2.2 was a short test build, made to check that the new update system could install,
roll back and reload a big update safely. It was never meant to be used for long: 2.3 replaced it a day later and
includes everything 2.2 had, plus fixes. So 2.2 only has a tag and a release page, kept so that apps still on 2.2 can
update themselves. If you're starting fresh, use the latest version; there's no reason to install 2.2.

---

**Prefer to run it from the code?** That works too, as described below.

Moderation, member management, roles, tickets, polls, leveling, voice TTS, feeds and image quotes, built as
independent **modules** you switch on or off per server. It runs on your own computer: **`npm install`, `npm start`, nothing else** (no Docker, no database server, no build step).

---

## 1. One-time setup (about 10 minutes)

**You need:** a computer that stays on while the bot should be online, and [Node.js](https://nodejs.org) **22.13 or newer** (install the current "LTS").

### a) Create the bot on Discord
1. Go to <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy it (you'll paste it in a moment).
3. Same page, scroll to **Privileged Gateway Intents** and turn **all three ON**, then Save:
   - *Server Members* (welcome/goodbye, auto-roles, raid protection)
   - *Message Content* (AutoMod word/link filters, AFK, image quotes)
   - *Presence* (game roles)
   
   The bot still starts if you skip these, but the features above are reduced. `/health` and `npm run check` tell you exactly which are off.

### b) Install and start
Open a terminal in this folder (Windows: open the folder, type `cmd` in the address bar, press Enter), then:
```
npm install
npm run setup      # asks for your token, writes .env, prints your invite link
npm start
```
Open the **invite link** that `npm run setup` printed (or run `npm run invite` any time), add the bot to your server, then in Server Settings → Roles **drag the bot's role near the top**. Discord only lets a bot manage roles/members *below* its own role.

Run `npm run check` at any time to test your install. It verifies Node, packages, token, and which intents are on. `npm test` runs the automated test-suite.

### c) Optional: web dashboard
A browser control panel at <http://localhost:3000>, reachable only from your own computer unless you choose to host it ([`docs/HOSTING.md`](docs/HOSTING.md)).
1. Developer Portal → your app → **OAuth2** → copy the **Client Secret**; under **Redirects** add `http://localhost:3000/callback`.
2. Put `DISCORD_CLIENT_SECRET=...` in `.env` (or re-run `npm run setup`) and restart.

**Who can use it** (checked live against Discord on every click):
- **Admins** (server owner, Administrator, Manage Server): everything: module switches, settings, permissions, logs and all the panels.
- **Moderators / staff**: give their role the **`dashboard.access`** permission (`/permissions allow permission:dashboard.access role:@Moderators`, or the dashboard's Permissions page). They then see a *limited* dashboard with only the panels they also hold the panel's own permission for (for example `support.staff` for tickets, `support.watch` for the watch log, `moderation.automod` for AutoMod). They never see settings, role lists, permissions or logs, and the server refuses those requests even if someone tries them by hand.

**Testers:** the dashboard's overview has a **Testers** card. Pick your testers' role, click **Let them open the dashboard** (or **…and see every read-only box**; boxes with buttons or private information are given out on the Permissions page), and send them the link. They sign in with their own Discord account and report anything with the **💬 Feedback** button; reports show up live under **Tester feedback**. For people outside your house, turn on the app's **Settings > Dashboard link** first.

**Desktop app:** the **Dashboard** page shows the whole dashboard inside the app, already signed in, with no Client Secret needed. The dashboard updates live everywhere: changes, numbers and the activity feed appear as they happen.

**Home** shows what needs attention, your tools, live activity, and charts for members, people in voice and messages over the last 14 days (the bot keeps hourly counts only, no names or message text, and deletes them after 14 days).

**Moderation:** Warn, Time out, Kick and Ban are on the ticket side panel and in the right-click menu on any member. The **Moderation** page lists every warning, timeout, kick and ban (from Discord, the dashboard and AutoMod) with search and an **Act** button, and AutoMod's settings underneath. Each action needs the same permission as its command (`moderation.warn`, `moderation.timeout`, `moderation.kick`, `moderation.ban`), and role order is respected.

Everything the dashboard does is also available through slash commands.

---

## 2. Using it in Discord

Nothing is on until you turn it on, per server (needs the **Manage Server** permission):
```
/modules            control panel: every module, Turn on / Turn off buttons, Edit settings popups
/module             a popup: pick a module and turn it on, off, or see its settings
/config             a popup: pick a module, then Edit settings opens its settings in popups
/permissions list   who can do what
```
Nothing needs typing anywhere: every command opens a popup (on/off and choices are dropdowns, members, channels and roles are pickers). The commands in the table below are written as before for reference; in Discord you only pick the command, and the popup asks for the rest.
**Quick recipes**

| Goal | Do this |
|---|---|
| Mod log + AutoMod | `/modules` → moderation → Turn on → Edit settings → Log channel → `/automod rule rule:Word filter enabled:true` → `/automod word add word:badword` → `/automod status` |
| Welcome messages | `/modules` → member-management → Turn on → Edit settings → welcome on + welcome channel |
| Verification gate | enable `member-management` → set `verificationRole` (+ optional `unverifiedRole`) → `/verify panel` |
| Tickets | enable `support` → set `staffRole`, `ticketCategory`, `logChannel` and (recommended) `watchChannel` (staff only) → `/ticket panel` |
| Live leaderboard | enable `community` → `/liveboard setup channel:#leaderboard` |
| Read a no-mic text channel aloud | enable `voice` → `/tts setup channel:#no-mic` → members in the voice channel just type there |
| Let staff use the dashboard | `/permissions allow permission:dashboard.access role:@Moderators` |
| Self-service roles | enable `roles` → `/rolemenu create title:"Pick roles" role1:@A role2:@B` |
| Let moderators (not admins) ban | `/permissions allow permission:moderation.ban role:@Moderators` |

### Modules and commands

**Coming from Carl-bot, YAGPDB, Statbot or TTS Bot?** Run `/migrate scan` and Good Boy offers to set up what they left behind (reaction roles, logs, starboard, welcome, join roles, counters, bans). Step by step: [`docs/REPLACING-OTHER-BOTS.md`](docs/REPLACING-OTHER-BOTS.md).

| Module | Commands and features |
|---|---|
| **moderation** | `/warn` (no options: a private **Configure warning** button opens a popup with member, reason, severity and notes; or right-click a member → Apps → **Warn member**) · `/timeout` `/untimeout` `/kick` `/ban` `/unban` (leave out the reason and a popup asks for it) · `/purge` `/modhistory` · **AutoMod**: spam, word filter, links and invites, mass mentions, repeated messages, capital letters, emoji, each with its own action, exemptions by role/channel/category, and a recent-activity list (`/automod status\|rule\|exempt\|recent\|word\|domain`, plus a dashboard panel) · raid protection · anti-nuke · edit/delete logging |
| **member-management** | `/profile setup\|edit\|remove\|view` · `/verify setup\|panel\|repost\|status\|reset` · `/introduce` · `/birthday set\|remove\|upcoming` · `/afk` · welcome and goodbye messages |
| **roles** | `/rolemenu create\|delete` · `/reactionrole add\|remove\|list` · `/autorole add\|remove\|list` · `/gamerole add\|remove\|list` |
| **support** | **Tickets with 8 categories** (scam/phishing, safety, report a member, ban appeal, bot problem, access, partnership, other), each with an urgency level and its own popup · reports ask who, user ID, what happened and evidence · a staff-only **watch log** that flags later tickets mentioning a reported person (exact ID matches and "possible" name matches, shown with the earlier outcome, never to the member) · required close popup (resolution, reason, action taken, notes) with notes kept staff-only · appeals approved or denied with a reason · priority changes with a reason · optional auto-close after inactivity · history and `/ticket stats` · `/ticket panel\|type\|watch\|close\|add\|remove\|rename\|priority\|info\|transcript\|stats` |
| **support-html-transcripts** | *add-on for support:* styled HTML transcripts |
| **engagement** | `/announce send\|schedule` (no options: a **Configure Announcement** button opens one popup for channel, title, text, colour and pings) · `/announce list` (cancel with a picker) · `/poll create\|end` · `/suggest` and `/suggestion …` · `/starboard …` (popups for the long text) |
| **community** | `/rank` `/leaderboard` `/rep …` `/serverstats` `/xp set\|reset` `/levels reward …` · **`/liveboard setup\|refresh\|remove`** (a leaderboard message the bot keeps editing) · member-count channel · voice XP (only when not alone, never AFK or deafened, daily limit) and reaction XP · `/xp ignore` to switch XP off in channels or categories (tickets never give XP) |
| **voice** | `/tts say\|join\|leave\|skip\|stop\|queue\|voices\|voice\|setup\|reading\|diagnose` · a **no-mic channel** whose messages are read aloud as "Name says …" |
| **music** | `/music` posts a shared player · add songs you upload, radio stations your admins added, or free Creative Commons music (Jamendo) · pause, skip and stop for whoever added it, the DJ role or staff |
| **reminders** | `/remind me\|team\|list\|cancel` · team reminders can notify several roles |
| **integrations** | `/feed add\|remove\|list\|check` (RSS, YouTube, GitHub, Reddit) · `/minecraft` · `/webhook create\|list\|delete` |
| **tempvoice** | `/voicehub add\|remove\|list` (pick "join to create" lobbies) · members get their own voice room, deleted when empty · `/room name\|limit\|privacy\|invite\|permit\|kick\|ban\|transfer\|claim\|info` |
| **partyfinder** | `/party create\|list\|close\|kick` · a post with Join / Leave / Close buttons, spots left, start time, optional voice room and role ping · expires on its own, DMs go through the *party-invites* notification setting |
| **stats** | `/stats member\|me\|server\|top\|coverage\|recap\|backfill\|inactive\|optout\|optin\|forget` · right-click a member → **Message stats** (this month, last month, month by month) · `/counter add\|remove\|list` (live counter channels) · activity charts on the dashboard · counts messages, voice time and reactions (never message text), weekly recap, optional history backfill, dashboard overview |
| **achievements** | `/achievements show\|list\|privacy\|optout\|optin` · 17 built-in achievements plus your own (`/achievements custom create\|delete\|grant\|revoke`) · announcements to a channel and/or DM |
| **eclipseid** | `/id show\|edit\|privacy\|link\|unlink\|roblox\|delete` · a member card with an ID, about text, linked game accounts (shown as *not verified*), per-field public / staff / private visibility |
| **economy** | `/balance` `/daily` `/pay` `/top` `/economy-admin` · right-click → **View wallet** / **Pay member** · daily streaks with Streak Shields and milestone bonuses · a live, paginated leaderboard (coins, streaks, fishing, casino) for the server or across servers that opt in. Every amount is typed in a popup |
| **games** | `/slots` (progressive server jackpot) `/blackjack` `/coinflip` `/fish` `/arcade` · each game opens a bet popup from a button · **fishing**: places unlocked by level, fish from Common to Mythical, daily and weekly challenges with a streak bonus, Mutated and Corrupted variants, rods, bait and tackle, a reeling mini-game played with buttons, a bag and a collection log. Since 3.0: 24 places, 2,000 fish, levels up to 4,000, strike timing, quick-time events and choosing exactly which fish to sell. Needs **economy**. Play money only · player guide: [Fishing Wiki](docs/FISHING-WIKI.md) |
| **tags** | custom commands and auto-replies: `?rules` / `!ip` style commands, or replies when a message is, starts with or contains a phrase · `/tags add\|list\|use\|remove` · variables, cooldowns, never pings · import with `/migrate tags` |
| **messages** | `/say send\|edit` (post or change a message as the bot, plain or in a box) · `/sticky set\|remove\|list` (a message that stays at the bottom of a channel) |
| **clips** | `/clips setup` (clips channel, Best clips channel, votes needed) · `/clips top` · uploaded videos from any clipping app, pasted clip links, and Medal's **Send to Discord** button (MedalBot's post is credited to the member it mentions) · 🔥 votes (not the owner's or bots'), enough votes reposts to Best clips with the video, **clip of the week** every Monday wins coins, coins for sharing, "Clips shared" and "Clip votes" boards in `/top` |
| **botnews** | `/botnews setup` (popup: admin channel, announcements channel, optional role to ping) · `/botnews test` · every bot update posts its full notes to the **admin channel** and only the part for members to **announcements**; new modules and modules turned on or off are posted to the admin channel; the first time a member feature (economy, games, dead chat) is turned on, members get a short intro. Nothing is posted twice, and each kind of post can be switched off |
| **deadchat** | `/deadchat` (button → popup: channel, role to ping, quiet minutes, cooldown) · when the channel has been quiet that long, the bot posts a random conversation starter and pings the opt-in **@deadchat** role (created for you; members join or leave with a **Ping me** button), once per quiet spell. Starters are editable in the dashboard. Uses message times only, never message text |
| **quotes** | right-click a message → Apps → **Quote Image** (black & white) / **Quote Image (Color)**, or `/quote`. Members with an animated (GIF) avatar get an **animated GIF quote**; the picture falls back to a still image if anything goes wrong or the file would be too big |

Always available: **`/modules`** (control panel with buttons and popups) `/module` `/config` `/permissions` `/notifications` `/health` `/help`.

### Custom profile roles (name + color)
`/profile setup name:Jamie color:#FF69B4` creates a role **only for that member**, shown separately in the member list.
`/profile edit` changes it later. The bot only ever edits the exact role it created for that person, refuses names that clash with existing roles (no impersonating staff), and deletes the role if they leave. Admins control it with `/config` (turn it off, lock name or color changes, restrict to an allowed color list).

---

## 3. Keeping it running

The bot is online only while `npm start` is running. Close the window → it goes offline (saved data is kept).
- **Windows:** leave the terminal open, or later use a tool like `pm2` (`npm i -g pm2`, then `pm2 start src/index.js --name good-boy`) or Task Scheduler to start it at login.
- **Moving it later:** the whole bot is just this folder. Copy it (including `data/`) to any machine or host with Node 22.13+ and run `npm install && npm start`.

**Supervisor and self-updates (optional):** `npm run supervised` runs the bot under a watcher that restarts it after a crash and can install signed updates with automatic rollback. Updates are **off** until you publish signed releases and set `UPDATE_MANIFEST_URL`; see [`docs/UPDATES.md`](docs/UPDATES.md). **Desktop app** (Windows/macOS control panel): built by GitHub Actions, and the built Windows app is started and checked on each build. See [`docs/DESKTOP.md`](docs/DESKTOP.md). The legal pages are served at `/terms` and `/privacy` on the dashboard address (set `LEGAL_OPERATOR` and `LEGAL_CONTACT` in `.env`).

**Licences (Windows app):** a licence key unlocks a bot's own name, picture, banner and description in the Windows app; the Good Boy credit always stays. Keys are made by Basic Ghost Labs for one bot each. Paste yours in the app under **Settings → Licence**.

**Updating by hand:** replace the project files (keep `.env` and `data/`), run `npm install`, restart. The database upgrades itself and a backup is saved to `data/backups/` first. To update one module without restarting: replace its folder, then `/module` → pick it → **Reload from disk** (bot owner only). If the new code is broken, it **rolls back automatically** and keeps running the old version.

---

## 4. How it works (short)
Each feature is a folder in `modules/` with an `index.js`. The core loads them, and per server it can enable/disable, configure, and permission-gate them. Logic that does not need Discord (ticket rules, AutoMod rules, the GIF codec) lives in `src/` as plain functions so it can be tested directly. Every module's failure is isolated: a crash is logged, shown in `/health`, and never takes the bot down. Modules can have **add-ons** that declare which module and version they need. Details and a how-to for writing your own: [`docs/MODULES.md`](docs/MODULES.md), design notes: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## 5. Honest status & limits

**What was verified, and how.** Good Boy was built and tested against *simulated* Discord: 410 automated tests (module lifecycle, permissions, AutoMod rules, tickets and the watch log, popups, polls and suggestions, the live leaderboard, no-mic reading rules, the GIF codec, dashboard access control and design assets, and for the newer parts: temporary voice, party finder, statistics, achievements, member IDs, the update system with real child processes and a local update server, and the desktop app's logic). The same suite also passes on a PC with the real `discord.js`. Key rules were checked by *breaking the code on purpose* to make sure a test fails. The GIF reader and writer were compared against an independent library (Pillow); real animated quotes were rendered with the real canvas library. The dashboard was opened in a real browser to check the layout, themes and animations.

**Not verified on real Discord yet** (please try these first, see "First-run checklist" below): everything new in 2.2 (the button-then-popup flow, popups with pickers and dropdowns, the leaderboard buttons, the games and the fishing mini-game; see [`docs/V2.2-TEST-PLAN.md`](docs/V2.2-TEST-PLAN.md)), temporary voice rooms (moving members, permissions), the party finder buttons and DMs, the member ID popup, achievement announcements, the statistics weekly recap and history backfill, the popups (modals), a full ticket from open to close, the watch-log flags, the live leaderboard message editing itself, animated quotes as uploaded to Discord, and the dashboard login with your own Client Secret. **Text-to-speech audio** (including the no-mic channel) can only be proven on a machine with a voice channel and speakers: the rules for *what* gets read are tested, the sound is not.

**Known limits**
- **Modules are trusted code.** They run inside the bot with full access. Only install modules you wrote or reviewed. There is no sandbox and no marketplace.
- **Watch-log matches are hints, not proof.** A name match is only "possible", names shorter than 3 characters match by ID only, and a report is an accusation until staff record an outcome. The log is staff-only and entries expire (default: a year, unfounded ones after 30 days; both adjustable).
- **Tickets closed before this version are not copied into the new history/stats.** They stay readable as before; the history starts from the upgrade.
- **Animated quotes** use a 256-colour palette like all GIFs, so smooth colour fades can look slightly banded. Animation is for real animated Discord avatars only; anything else, or any failure, gives the normal still picture.
- **Privileged intents** (Members / Message Content / Presence) must be switched on in the portal, and Discord requires app verification once a bot is in 100+ servers. The no-mic reading channel needs Message Content.
- **Announcement and reminder pings** need the bot to have "Mention @everyone, @here and All Roles". Bots invited before this version should be re-invited (`npm run invite`) or given that permission.
- **Voice/TTS** uses an unofficial Google text-to-speech endpoint (it can change or rate-limit) or, on Windows, offline voices. Voice libraries are optional; if they fail to install only voice is unavailable.
- **Image quotes** need the optional `@napi-rs/canvas` package.
- **Dashboard** listens on `127.0.0.1` only by default. Reaching it from elsewhere is explained in [`docs/HOSTING.md`](docs/HOSTING.md). Inbound webhooks follow the same rule.
- **Goodbye messages** can't tell a leave from a kick/ban (Discord doesn't say); the moderation log covers kicks and bans.
- **Roblox lookup** (`/id roblox`, off by default) was written from memory of Roblox's public API and has never been run against it. Linked game accounts are only format-checked and always shown as *not verified*.
- **The bot's own signed updates** (`npm run supervised`) are tested against a local update server only, and the supervisor has not been run on Windows. The **desktop app** is built, started and checked by GitHub for every release and published under Releases; installed Windows apps update themselves from there.
- **Statistics** start counting when the module is turned on; `/stats backfill` can count older messages (all time, in the background) and those counts are labelled as such.
- **Not built:** Twitch/Steam/Spotify integrations, a module marketplace, achievement role rewards, the Minecraft launcher and server manager. **Deliberately excluded:** giveaways, AI, anything that sells coins for real money.
- One SQLite file (`data/eclipse.db`, the name is kept so existing data carries over) is plenty for personal and mid-sized communities.

### First-run checklist (about 15 minutes)
1. `npm install`, `npm test` (should say 0 failed), `npm start`, then `/health` in Discord.
2. Dashboard: open it, log in, check the Overview. If login fails, open `/auth/diagnose`.
3. `/automod status`; switch on the caps rule, post some SHOUTING in a test channel, then `/automod recent`.
4. Open a test ticket from each kind of category, close one as staff (popup), and check that the staff log has the notes and the member's channel does not.
5. `/liveboard setup`, then post a few messages and wait for the next refresh.
6. `/tts diagnose`, then `/tts setup channel:#no-mic`, join a voice channel and type in it.
7. `npm run quote:test`, open `data/quote-test-animated.gif`, then quote a message from someone with an animated avatar.
8. `/voicehub add` a "join to create" channel, join it, rename and lock your room with `/room`, then leave and check the room is deleted.
9. `/party create`, join from a second account, fill it, close it.
10. `/stats coverage`, post a few messages, then `/stats me`; try `/achievements show` and `/id edit`.
11. Optional: `npm run supervised` and open Dashboard → Updates (as the bot owner); it should say updates are off.

## Troubleshooting

**The Windows app opens to a blank window, or won't update.** Download the installer again from the [latest release](https://github.com/jamiechastain10-blip/Good-Boy-Bot/releases/latest/download/Good-Boy-Setup.exe) and run it over the top; your bot, settings and data stay. Since 3.0.3 the app recovers by itself: if the graphics driver crashes it restarts without hardware acceleration, the built-in dashboard only appears once it has loaded, and if the window can't draw it shows the reason with **Reload window**. **Ctrl+R** reloads the window at any time.
- Still blank? Quit from the tray icon, then start Good Boy from a shortcut with ` --disable-gpu` added after the closing quote in **Target** (right-click the shortcut → Properties).
- The app keeps a log at `%APPDATA%\Good Boy\app.log` (under 1 MB). Send it along with any bug report.

**Starting the bot without the app.** In the bot's folder: `npm install` once, then `npm start` (or `npm run supervised` to restart it after crashes). Close the window and the bot goes offline.

**The dashboard won't log in.** Open `/auth/diagnose` on the dashboard address; it checks your Client Secret and redirect address.

## Security notes
Secrets live only in `.env` (never commit it; it's in `.gitignore`). Permissions are enforced centrally by the core (the bot also checks role hierarchy, so a moderator can't act on someone above them). The bot refuses to hand out roles that carry dangerous permissions through menus/rewards/auto-roles. `@everyone`/role pings are off unless a feature explicitly needs them. Outbound feed fetches block private/internal addresses. The dashboard re-checks the person's rights with Discord on every request, and panels are enforced on the server, not just hidden in the page. Settings changes and permission edits are written to the security log.

---
© 2026 Basic Ghost Labs. All rights reserved. · Good Boy
