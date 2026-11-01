/**
 * Basic Ghost Labs - Project Eclipse
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */


import { defineModule } from "@platform/module-sdk";
import { SlashCommandBuilder } from "discord.js";

/**
 * Phase 1 acceptance module. Its only job is to prove the lifecycle works:
 *   install -> enable -> load -> use -> disable -> unload -> re-enable
 * It intentionally has near-zero real functionality.
 */
export default defineModule({
  name: "test-module",
  version: "1.0.0",
  type: "module",
  description: "Minimal module used to validate the Core lifecycle.",
  commands: [
    {
      name: "ping",
      description: "Replies with pong (proves command routing works end to end).",
      data: new SlashCommandBuilder().setName("ping").setDescription("Replies with pong").toJSON(),
      async execute(rawInteraction, context) {
        context.logger.info("Handling /ping", { guildId: context.guildId });
        const interaction = rawInteraction as import("discord.js").ChatInputCommandInteraction;
        await interaction.reply({ content: "🏓 pong", ephemeral: true });
      },
    },
  ],
  dashboard: {
    settings: [
      { type: "toggle", key: "enabled", label: "Enable Test Module" },
    ],
  },
  async init(context) {
    context.logger.info("test-module initialized", { guildId: context.guildId });
  },
  async destroy(context) {
    context.logger.info("test-module destroyed", { guildId: context.guildId });
  },
});
