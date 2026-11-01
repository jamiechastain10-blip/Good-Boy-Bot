/**
 * Basic Ghost Labs - Project Eclipse
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */


import Fastify from "fastify";

/**
 * The Web API talks to Postgres directly (via @platform/database) as the
 * source of truth for config. It does NOT reach into the running Bot
 * process. Live state changes are propagated to the Bot via a Redis
 * pub/sub channel (see docs/ARCHITECTURE.md, section "Web App <-> Bot").
 */
const app = Fastify({ logger: true });

// --- Auth -------------------------------------------------------------
// TODO Phase 2: wire up @fastify/oauth2 with Discord's OAuth endpoints,
// scopes ["identify", "guilds"], and a session store (Redis-backed).
app.get("/auth/discord/callback", async (_req, reply) => {
  reply.send({ todo: "exchange code for token, create session" });
});

// --- Guild + module routes ---------------------------------------------
app.get("/api/guilds/:guildId/modules", async (req) => {
  const { guildId } = req.params as { guildId: string };
  // TODO: fetch GuildModuleConfig rows from @platform/database
  return { guildId, modules: [] };
});

app.post("/api/guilds/:guildId/modules/:moduleName/enable", async (req) => {
  const { guildId, moduleName } = req.params as { guildId: string; moduleName: string };
  // TODO: write enabled=true to DB, then publish { type: "module.enable", guildId, moduleName }
  // to Redis so the running Bot picks it up.
  return { guildId, moduleName, enabled: true };
});

app.post("/api/guilds/:guildId/modules/:moduleName/config", async (req) => {
  const { guildId, moduleName } = req.params as { guildId: string; moduleName: string };
  const body = req.body as Record<string, unknown>;
  // TODO: validate `body` against the module's dashboard/config schema
  // before writing — never trust client-submitted config as-is.
  return { guildId, moduleName, config: body };
});

const port = Number(process.env.PORT ?? 3001);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
