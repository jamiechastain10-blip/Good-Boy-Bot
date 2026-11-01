/**
 * Basic Ghost Labs - Project Eclipse
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Events,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import pino from "pino";
import { ModuleContext } from "@platform/module-sdk";
import { ModuleManager } from "./ModuleManager";
import { DiscordApiManager } from "./DiscordApiManager";
import { modules } from "./modules";
import {
  ensureGuild,
  ensureModuleRecord,
  getEnabledModulesForGuild,
  getModuleConfig,
  setModuleConfig,
  getModuleData,
  setModuleData,
  deleteModuleData,
  setModuleEnabledInDb,
} from "@platform/database";

const logger = pino({ name: "core" });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN ?? "");

// Not yet wired into per-request calls below — modules currently call
// discord.js directly (still rate-limited correctly by discord.js itself).
// This is the fairness layer we add back once multiple modules are
// actually competing for API budget; see docs/ARCHITECTURE.md.
const apiManager = new DiscordApiManager(
  async (req) => rest.request({ method: req.method as any, fullRoute: req.route as any, body: req.body }),
  logger
);

function makeContext(guildId: string | undefined, moduleName: string): ModuleContext {
  return {
    guildId,
    logger: {
      info: (msg, meta) => logger.info({ module: moduleName, ...meta }, msg),
      warn: (msg, meta) => logger.warn({ module: moduleName, ...meta }, msg),
      error: (msg, meta) => logger.error({ module: moduleName, ...meta }, msg),
    },
    config: {
      get: async (key) => {
        if (!guildId) return undefined;
        const config = await getModuleConfig(guildId, moduleName);
        return config[key] as any;
      },
      set: async (key, value) => {
        if (!guildId) return;
        await setModuleConfig(guildId, moduleName, { [key]: value });
      },
    },
    db: {
      get: async (key) => (guildId ? getModuleData(guildId, moduleName, key) : undefined),
      set: async (key, value) => {
        if (guildId) await setModuleData(guildId, moduleName, key, value);
      },
      delete: async (key) => {
        if (guildId) await deleteModuleData(guildId, moduleName, key);
      },
    },
    discord: {
      request: (req) => apiManager.request(moduleName, req) as any,
    },
    permissions: {
      // Native Discord role permissions are checked directly at the command
      // level for beta (see moderation module). This hook is reserved for
      // the custom per-permission-key system once the dashboard exists.
      check: async () => true,
    },
  };
}

export const moduleManager = new ModuleManager(makeContext, logger);

// ---- Built-in admin command: control the module lifecycle live ----------
const moduleAdminCommand = new SlashCommandBuilder()
  .setName("module")
  .setDescription("Manage which modules are active in this server")
  .addSubcommand((sc) => sc.setName("list").setDescription("List modules and their status"))
  .addSubcommand((sc) =>
    sc
      .setName("enable")
      .setDescription("Enable a module for this server")
      .addStringOption((o) => o.setName("name").setDescription("Module name").setRequired(true))
  )
  .addSubcommand((sc) =>
    sc
      .setName("disable")
      .setDescription("Disable a module for this server")
      .addStringOption((o) => o.setName("name").setDescription("Module name").setRequired(true))
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .toJSON();

async function handleModuleAdminCommand(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId!;
  const sub = interaction.options.getSubcommand();

  if (sub === "list") {
    const lines = modules.map((m) => {
      const enabled = moduleManager.isEnabledForGuild(m.name, guildId);
      return `${enabled ? "✅" : "⬜"} ${m.name}@${m.version}`;
    });
    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
    return;
  }

  const name = interaction.options.getString("name", true);
  const manifest = modules.find((m) => m.name === name);
  if (!manifest) {
    await interaction.reply({ content: `No module named "${name}".`, ephemeral: true });
    return;
  }

  if (sub === "enable") {
    try {
      await moduleManager.enable(name, guildId);
      await setModuleEnabledInDb(guildId, name, manifest.version, true);
      await interaction.reply({ content: `Enabled **${name}**.`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: `Failed to enable **${name}**: ${(err as Error).message}`, ephemeral: true });
    }
    return;
  }

  if (sub === "disable") {
    try {
      await moduleManager.disable(name, guildId);
      await setModuleEnabledInDb(guildId, name, manifest.version, false);
      await interaction.reply({ content: `Disabled **${name}**.`, ephemeral: true });
    } catch (err) {
      await interaction.reply({ content: `Failed to disable **${name}**: ${(err as Error).message}`, ephemeral: true });
    }
  }
}

// ---- Startup: install every known module, register commands -------------
async function registerCommands(guildId: string) {
  const commandBodies = [
    moduleAdminCommand,
    ...modules.flatMap((m) => (m.commands ?? []).map((c) => c.data)),
  ];
  await rest.put(Routes.applicationGuildCommands(client.user!.id, guildId), { body: commandBodies });
  logger.info(`Registered ${commandBodies.length} commands for guild ${guildId}`);
}

client.once(Events.ClientReady, async () => {
  logger.info(`Logged in as ${client.user?.tag}`);

  for (const manifest of modules) {
    await ensureModuleRecord(manifest.name, manifest.type, manifest.version);
    await moduleManager.install(manifest);
  }

  for (const [, guild] of client.guilds.cache) {
    await ensureGuild(guild.id, guild.name, guild.ownerId);
    await registerCommands(guild.id);

    const enabledModules = await getEnabledModulesForGuild(guild.id);
    for (const name of enabledModules) {
      try {
        await moduleManager.enable(name, guild.id);
      } catch (err) {
        logger.error(`Failed to re-enable "${name}" for guild ${guild.id} on startup`, {
          error: (err as Error).message,
        });
      }
    }
  }
});

client.on(Events.GuildCreate, async (guild) => {
  await ensureGuild(guild.id, guild.name, guild.ownerId);
  await registerCommands(guild.id);
});

client.on(Events.InteractionCreate, async (interaction) => {
  const guildId = interaction.guildId;
  if (!guildId) return;

  // ---- Slash commands + context menu commands share the same lookup ----
  if (interaction.isChatInputCommand() || interaction.isMessageContextMenuCommand() || interaction.isUserContextMenuCommand()) {
    if (interaction.commandName === "module") {
      if (interaction.isChatInputCommand()) await handleModuleAdminCommand(interaction);
      return;
    }

    const manifest = moduleManager.findModuleForCommand(interaction.commandName);
    if (!manifest) return;

    if (!moduleManager.isEnabledForGuild(manifest.name, guildId)) {
      await interaction.reply({
        content: `The **${manifest.name}** module is disabled in this server. An admin can run \`/module enable name:${manifest.name}\`.`,
        ephemeral: true,
      });
      return;
    }

    const command = manifest.commands?.find((c) => c.name === interaction.commandName);
    if (!command) return;

    try {
      const context = makeContext(guildId, manifest.name);
      await command.execute(interaction, context);
    } catch (err) {
      logger.error(`Command "${interaction.commandName}" failed`, { error: (err as Error).message });
      if (!interaction.replied) {
        await interaction.reply({ content: "Something went wrong running that command.", ephemeral: true });
      }
    }
    return;
  }

  // ---- Buttons / select menus, routed by customId prefix ----
  if (interaction.isButton() || interaction.isAnySelectMenu()) {
    const manifest = moduleManager.findModuleForComponent(interaction.customId);
    if (!manifest) return;

    if (!moduleManager.isEnabledForGuild(manifest.name, guildId)) {
      await interaction.reply({ content: `The **${manifest.name}** module is disabled in this server.`, ephemeral: true });
      return;
    }

    const component = manifest.components?.find((c) => interaction.customId.startsWith(c.customIdPrefix));
    if (!component) return;

    try {
      const context = makeContext(guildId, manifest.name);
      await component.execute(interaction, context);
    } catch (err) {
      logger.error(`Component "${interaction.customId}" failed`, { error: (err as Error).message });
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Something went wrong with that.", ephemeral: true });
      }
    }
  }
});

/** Fans a Discord event out to every enabled module listening for it,
 * isolating one module's failure from the rest. */
async function dispatchEvent(eventName: string, guildId: string, payload: unknown) {
  for (const manifest of moduleManager.findModulesForEvent(eventName)) {
    if (!moduleManager.isEnabledForGuild(manifest.name, guildId)) continue;
    const handler = manifest.events?.find((e) => e.event === eventName)?.handler;
    if (!handler) continue;

    try {
      const context = makeContext(guildId, manifest.name);
      await handler(payload, context);
    } catch (err) {
      logger.error(`Module "${manifest.name}" failed handling ${eventName}`, { error: (err as Error).message });
      // One module's event handler failing must not stop the others from running.
    }
  }
}

client.on(Events.GuildMemberAdd, async (member) => {
  await dispatchEvent("guildMemberAdd", member.guild.id, member);
});

client.on(Events.GuildMemberRemove, async (member) => {
  await dispatchEvent("guildMemberRemove", member.guild.id, member);
});

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  logger.error("Failed to log in", { error: (err as Error).message });
  process.exit(1);
});
