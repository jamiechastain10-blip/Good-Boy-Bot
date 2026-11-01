# Project Eclipse — Discord Bot Platform
**Basic Ghost Labs**

A single-process Discord bot with the module lifecycle system live and
testable, backed by Postgres. This is the version meant to ship today —
everything listed below has been checked for internal consistency (every
import resolves, every DB key name matches the schema, every command
builder is properly serialized). It has **not** been run against live
Discord yet, since this environment has no network access — the first
real test happens when you run it.

See `docs/ARCHITECTURE.md` for the full design writeup.

## What's live in this build

- **Moderation**: `/warn`, `/timeout`, `/kick`, `/ban`, `/unban`, `/purge`,
  `/modhistory` — all logged per-guild.
- **Member Management**: `/welcome-config`, `/goodbye-config` for join/leave
  messages, plus **custom profiles** — `/profile setup` and `/profile edit`
  let each member set a personal display name and role color on a role the
  bot creates and tracks by ID (never an arbitrary role a user could point
  it at). `/profile-config` (admin) controls whether profiles are enabled
  and whether name/color changes are allowed.
- **Roles & Self-Service**: `/rolemenu` posts a button-based role menu (up
  to 5 roles) — click a button to toggle that role on yourself.
- **`/module list | enable | disable`**: admin-only, turns a module on/off
  for a server live, without restarting the bot.
- **test-module** (`/ping`): a zero-risk module to exercise the lifecycle
  against first, before touching anything real.

## Explicitly NOT in today's build

- **Voice & TTS** — code exists in `staged-for-later/voice/`, outside the
  npm workspace on purpose. Its dependencies (`ffmpeg-static`,
  `opusscript`, `@discordjs/voice`) are unverified in this environment; a
  bad install there could break `npm install` for the whole project. Not
  a risk worth taking on a same-day release. Move it back into `modules/`
  and add it to `packages/core/src/modules.ts` once you've verified it
  installs and runs cleanly.
- **Game-detection roles** — needs Discord's privileged Presence intent.
  If that intent is requested in code but not manually enabled in the
  Developer Portal, the bot fails to log in *entirely* — not a partial
  feature failure, a total one. Deliberately left out.
- **Dashboard, OAuth, marketplace, update rollback beyond in-memory** —
  correctly deferred per the phased plan; see Known Limitations below.

## Setup

1. Create a Discord application at discord.com/developers/applications,
   add a Bot user, copy the **bot token** and the **application (client) ID**.
   Under OAuth2 > URL Generator, check `bot` and `applications.commands`
   scopes, and at least `Send Messages`, `Kick Members`, `Ban Members`,
   `Manage Guild`, `Manage Roles` permissions — use the generated URL to
   invite it to your test server. **For `/profile` and `/rolemenu`:** after
   inviting, drag the bot's own role near the top of your server's role
   list in Server Settings > Roles — Discord only lets a bot manage roles
   positioned below its own highest role.

2. Install dependencies and start Postgres:
   ```bash
   npm install
   docker compose up -d
   cp packages/database/.env.example packages/database/.env
   npm run db:generate
   npm run db:migrate
   ```

3. Run the bot:
   ```bash
   DISCORD_TOKEN=your-bot-token npm run dev:core
   ```
   Commands are registered per-guild on startup (near-instant).

4. In Discord, as a server admin:
   ```
   /module list
   /module enable name:moderation
   /module enable name:member-management
   /module enable name:roles
   /welcome-config channel:#general message:Welcome {user}!
   /profile setup name:Jamie color:#FF69B4
   /rolemenu title:"Pick your roles" role1:@Gamer role2:@Artist
   ```

## Deploying without installing anything locally

Push this repo to GitHub, connect it to Railway, add a Postgres plugin,
set `DATABASE_URL` and `DISCORD_TOKEN` as environment variables, and set
the start command to:
```
npm run build --workspace=@platform/core && node packages/core/dist/bot.js
```
Railway runs it continuously — nothing runs on your machine.

## Known limitations in this build (by design, not oversights)

- Module updates roll out immediately to every guild using a module, with
  automatic per-guild rollback if `init`/`update` throws — no staged
  rollout or admin approval step yet.
- Permissions are checked via native Discord role permissions per command,
  not the custom per-permission-key system in the SDK — that wires up once
  the dashboard exists.
- Modules are a fixed list in `packages/core/src/modules.ts`, not
  dynamically installed — add a module by adding it there and redeploying.
- Custom profile roles aren't cleaned up automatically if a member leaves.
- The `DiscordApiManager` fairness queue exists but isn't wired into
  module calls yet — modules call discord.js directly, which is still
  correctly rate-limited, just without the added fairness layer.

## Status

- [x] Module SDK, lifecycle, fairness queue (unwired), DB schema
- [x] Real Postgres-backed `ModuleContext`
- [x] Live `/module enable|disable` exercising the lifecycle in production
- [x] Moderation, Member Management (+ profiles), Roles (button menus)
- [x] Full cross-file consistency check (imports, DB keys, command JSON)
- [ ] Voice & TTS — built, held out of workspace pending real testing
- [ ] Game-detection roles — deferred, needs privileged intent
- [ ] Dashboard, OAuth, marketplace, update rollback — post-beta
