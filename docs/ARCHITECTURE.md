# Architecture

## 1. Technology stack
- TypeScript across all packages.
- Bot: Node.js + discord.js v14.
- Database: PostgreSQL via Prisma.
- Cache / queue / pub-sub: Redis.
- Web API: Fastify.
- Web App: Next.js (Phase 2).
- Monorepo: npm workspaces (`packages/*`, `modules/*`).

## 2. Repository structure
```
discord-platform/
  packages/
    module-sdk/   # Types + contracts every module/add-on is built against
    core/         # Bot process: ModuleManager, DiscordApiManager, event wiring
    database/     # Prisma schema + generated client
    web-api/      # REST API, Discord OAuth, config validation
    web-app/      # (Phase 2) Next.js dashboard
  modules/
    test-module/  # Phase 1 acceptance module
  docs/
```

## 3. Core/Module interface
See `packages/module-sdk/src/types.ts`. A module exports a `ModuleManifest`
(`name`, `version`, `type`, optional `commands`/`events`/`permissions`/
`dashboard`, and `init`/`destroy`/`update` lifecycle hooks). The Core never
imports feature-specific logic — it only calls these hook functions.

## 4. Module lifecycle
`INSTALL -> VALIDATE -> ENABLE -> LOAD -> RUN -> UPDATE -> RELOAD -> DISABLE -> UNLOAD -> UNINSTALL`,
implemented in `ModuleManager`. Each guild has independent enable/disable
state; a module can be `running` for guild A and `disabled` for guild B
simultaneously. Errors during `init`/`update` are caught, logged, and do not
propagate to crash the bot process.

## 5. Add-on / dependency model
Add-ons declare `requires: { module, version }` (a semver range). The
`ModuleManager` verifies the required module is installed and
version-compatible before allowing install. Dependency edges are also
persisted in `ModuleDependency` rows so "N add-ons depend on this module"
warnings survive a restart, not just an in-memory check.

## 6. Web App <-> Bot communication
- **Config writes** go Web App -> Web API -> Postgres. Postgres is the single
  source of truth.
- **Propagation to the running bot** happens over Redis pub/sub
  (`module.enable`, `module.config.updated`, etc.) — the bot subscribes and
  reloads only the affected module/guild.
- **Status reads** (health, request rates) are published by the bot to Redis
  on an interval; the Web API reads from Redis, never calls into the bot
  process directly.
- The Web API never holds the Discord bot token; only the Core process does.

## 7. Database architecture
See `packages/database/prisma/schema.prisma`: `Guild`, `User`, `Module`,
`ModuleDependency`, `GuildModuleConfig` (per-guild enable state + JSON
config), `ModuleData` (namespaced per-module key-value storage so modules
can't see each other's rows), `GuildPermission`, `AuditLog`.

## 8. Discord API Manager
`DiscordApiManager` is a **fairness/priority queue in front of discord.js**,
not a reimplementation of Discord's rate limits — discord.js's REST manager
already implements Discord's documented per-route and global limits
correctly. This layer adds: request priority (`high`/`normal`/`low`), and a
per-module concurrency cap so one module flooding requests can't starve
others' requests from ever being sent.

## 9. Security model
- Modules never receive the raw discord.js `Client`, database connection, or
  another module's data — everything goes through `ModuleContext`, which the
  Core controls.
- Phase 1–5 modules are first-party/trusted, loaded like normal packages.
- **Open item, deliberately deferred**: true sandboxing of arbitrary
  third-party marketplace code (Phase 6) is a separate design problem
  (process isolation, static analysis on submission, a much narrower
  `ModuleContext` surface for untrusted code) and should get its own design
  pass before Phase 6 starts, not be assumed to fall out of the Phase 1
  loader.
- Config submitted from the Web App is validated against each module's own
  `validateConfig` before being persisted — the Web API does not trust
  client input as-is.

## 10. Updates and rollback
`ModuleManager.update()`:
1. Refuses the update if the new version isn't semver-greater.
2. For each guild the module is active in: `destroy()` old version ->
   `update()` hook (if provided) -> `init()` new version.
3. If any step throws, the manager reverts its in-memory manifest reference
   to the previous version and re-raises — the module keeps running on the
   old code. Phase 3 adds file-system snapshotting so a full binary/package
   rollback (not just the in-memory reference) is possible after a
   catastrophic update.

## Deliberate deviations from a literal reading of the spec
- The Discord API Manager wraps discord.js's rate limiting rather than
  reimplementing it, to avoid two independent rate-limit calculators
  disagreeing (see section 8 above).
- The marketplace's "arbitrary third-party code" security model is
  explicitly called out as unsolved by the Phase 1 loader and deferred to
  its own design pass before Phase 6.
