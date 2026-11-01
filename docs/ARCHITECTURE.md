# Architecture

```
                 ┌────────────── Discord Gateway / REST ──────────────┐
                 │                         │                          │
        slash commands, buttons,      events (members,            outbound calls
        modals, autocomplete          messages, reactions…)       (via fairness queue)
                 │                         │                          ▲
        ┌────────▼─────────────────────────▼──────────────────────────┴───────┐
        │  src/index.js   client + intent fallback + event wiring             │
        │  ┌───────────────────────────────────────────────────────────────┐  │
        │  │ ModuleManager  discover · validate · enable/disable per server │  │
        │  │ dispatch events/commands/components → ONLY enabled modules     │  │
        │  │ health · error isolation · hot reload + rollback · tasks       │  │
        │  └──────────┬──────────────┬──────────────┬──────────────────────┘  │
        │   Permissions        ApiQueue          Database (SQLite)            │
        │   (role mapping)   (priority + per-    guilds · module_state ·      │
        │                     module caps)       config · module_data ·       │
        │                                        permissions · logs · backups │
        └──────────────────────────────┬───────────────────────────────────────┘
                                       │ loads
             modules/  moderation · member-management · roles · support
                       (+ support-html-transcripts add-on) · engagement ·
                       community · voice · reminders · integrations · quotes ·
                       stats · achievements · eclipseid · tempvoice · partyfinder
        src/          pure logic shared by modules and tests: tickets · automod · gif · forms · util
        src/dashboard/  web UI (Discord OAuth, liquid-glass design) → same ModuleManager API
```

## Principles
- **The core has no feature logic.** It never says "if tickets…": it routes to whatever modules are enabled in that server.
- **Per-server everything.** Enabled state, settings, permissions and data are keyed by server; one server's configuration can never leak into another's.
- **One source of truth.** Slash commands (`/config`, `/module`, `/permissions`) and the dashboard call the same `ModuleManager` methods, so validation and logging are identical.
- **Failure isolation.** Every handler runs inside a guard. Errors are logged, counted into module health, and the user sees a generic message. A module that fails 15 times in 2 minutes is automatically reloaded (rate-limited). A module that fails to start never becomes active.
- **Commands are registered per server, only for enabled modules** (instant updates, tidy command lists, and it stays under Discord's 100-command limit).

## Mapping to the original specification
| Spec item | Where |
|---|---|
| Custom module system, lifecycle, no module limit | `ModuleManager` (install = folder present; enable/disable per server; update hook; reload; unload on disable; uninstall = remove folder) |
| Add-ons with version & dependency checks, removal warning | `type: 'addon'`, `requires`, cascade-disable rule |
| Module SDK | the module contract + `ctx` ([`MODULES.md`](MODULES.md)) |
| Discord API manager (limits, queue, priorities) | discord.js enforces Discord's real rate limits; `ApiQueue` adds priority and per-module fairness caps |
| Update system | DB migrations (auto, with backup), per-module `update()` hook on version change, hot reload with rollback, **plus** signed whole-bot updates through a supervisor with a trial period and automatic rollback ([`UPDATES.md`](UPDATES.md)). Off unless configured; installs only on a click |
| Desktop app | `desktop/` Electron control panel that runs the supervisor ([`DESKTOP.md`](DESKTOP.md)); written, not yet built or run |
| Web app, Discord OAuth, dynamic module forms | `src/dashboard/` renders settings straight from each module's `settings` definition. Two access levels, checked live with Discord on every request: **admin** (Manage Server) and **panel** (`dashboard.access` + the panel's own permission). Design: `glass.css` holds the whole liquid-glass look and every animation; `style.css` is layout only |
| Per-server config, permissions | `module_config`, `permissions` tables; `/permissions`, dashboard tab |
| Database | SQLite (`node:sqlite`), versioned migrations, namespaced module data |
| Security | central permission checks, hierarchy checks, dangerous-role refusal, SSRF-safe fetch, CSRF + origin checks, localhost-only dashboard by default (see `HOSTING.md`), panel permissions enforced server-side, security log |
| Health display | `/health`, dashboard Logs tab |
| Marketplace / sandboxing of third-party code | **not built**: modules are trusted code |

## Data
`data/eclipse.db` (+ `-wal`/`-shm` while running). Backups in `data/backups/` (last 10) are taken before schema migrations, module version upgrades and reloads.

## Notes on newer parts
- **Tickets** (`modules/support`, rules in `src/tickets.js`): `support_history` is one row per ticket (opened, first reply, closed, how it was closed, resolution, staff-only reason/action/notes, outcome); `support_watch` is the staff-only watch log. Staff-only text is only ever sent to the watch/log channels and the dashboard, never into the member's ticket channel.
- **AutoMod** (`modules/moderation`, rules in `src/automod.js`): all rule settings are ordinary module settings, so `/config`, `/automod` and the dashboard share one validated path; exemptions and the recent-activity list (capped at 200) are module data.
- **Animated quotes** (`modules/quotes`, codec in `src/gif.js`): a dependency-free GIF reader/writer; frames are painted with the canvas library and re-encoded, thinning frames until the file fits Discord's limit, otherwise falling back to the still image.
- **Popups**: `src/forms.js` (see `MODULES.md`).
- **Supervisor and updates** (`src/supervisor.js`, `src/update/*`, `src/ipc.js`): the supervisor starts `src/index.js` as a child with `GOODBOY_SUPERVISED`, `GOODBOY_DATA_DIR` and `GOODBOY_BASE_DIR`. Releases unpack to `releases/<version>/` beside the data folder, `current.json` says which one runs (`trial` until the bot reports `ready` over IPC, then `ok`), and a failed trial rolls back and is remembered. The bot talks to the supervisor only through `src/ipc.js`; the dashboard's Updates page (bot owner only) goes through that link.
- **Statistics and achievements** (`modules/stats`, `modules/achievements`, helpers in `src/activity.js` / `src/achievements.js`): counts are buffered in memory and flushed every 10 seconds; message text is never stored. Achievements read the same events with their own throttles, and `eclipseid` shows them through `ctx.api('achievements')` when that module is on.
- **Temporary voice and party finder** (`modules/tempvoice`, `modules/partyfinder`, rules in `src/tempvoice.js` / `src/party.js`): both keep a small record per room/post in module data and run a `sweep` task to clean up what Discord no longer has.
- **Notification categories** (`src/notifications.js`): every DM or ping a module sends goes through `ctx.notify.allowed(userId, category)`; members choose with `/notifications`. Recaps are off by default.
