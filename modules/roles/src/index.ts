/**
 * Basic Ghost Labs - Project Eclipse
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Button roles rather than reaction roles — reactions are a deprecated UX
 * pattern at this point and buttons give us a real interaction to route
 * through the Core's component dispatcher.
 *
 * Game-detection roles (presence activity -> auto role) are intentionally
 * NOT in this build. They need Discord's privileged Presence intent, which
 * must be manually enabled in the Developer Portal — if it's requested in
 * code but not enabled there, the bot fails to log in entirely, not just
 * that one feature. Not a risk worth taking on a same-day release.
 */

import { defineModule } from "@platform/module-sdk";
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChatInputCommandInteraction,
  ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
} from "discord.js";

interface RoleMenuEntry {
  roleId: string;
  label: string;
}

const CUSTOM_ID_PREFIX = "rolemenu:";

export default defineModule({
  name: "roles",
  version: "1.0.0",
  type: "module",
  description: "Button-based self-service role menus — click a button to toggle a role.",
  permissions: [{ key: "roles.manage", label: "Create role menus", defaultRoles: "admin" }],
  commands: [
    {
      name: "rolemenu",
      description: "Post a self-service role menu (up to 5 roles)",
      data: new SlashCommandBuilder()
        .setName("rolemenu")
        .setDescription("Post a self-service role menu (up to 5 roles)")
        .addStringOption((o) => o.setName("title").setDescription("Title shown above the buttons").setRequired(true))
        .addRoleOption((o) => o.setName("role1").setDescription("First role").setRequired(true))
        .addStringOption((o) => o.setName("label1").setDescription("Button label for role1 (defaults to role name)").setRequired(false))
        .addRoleOption((o) => o.setName("role2").setDescription("Second role").setRequired(false))
        .addStringOption((o) => o.setName("label2").setDescription("Button label for role2").setRequired(false))
        .addRoleOption((o) => o.setName("role3").setDescription("Third role").setRequired(false))
        .addStringOption((o) => o.setName("label3").setDescription("Button label for role3").setRequired(false))
        .addRoleOption((o) => o.setName("role4").setDescription("Fourth role").setRequired(false))
        .addStringOption((o) => o.setName("label4").setDescription("Button label for role4").setRequired(false))
        .addRoleOption((o) => o.setName("role5").setDescription("Fifth role").setRequired(false))
        .addStringOption((o) => o.setName("label5").setDescription("Button label for role5").setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
        .toJSON(),
      async execute(rawInteraction, context) {
        const interaction = rawInteraction as ChatInputCommandInteraction;
        const title = interaction.options.getString("title", true);

        const entries: RoleMenuEntry[] = [];
        for (let i = 1; i <= 5; i++) {
          const role = interaction.options.getRole(`role${i}`);
          if (!role) continue;
          const label = interaction.options.getString(`label${i}`) ?? role.name;
          entries.push({ roleId: role.id, label });
        }

        if (entries.length === 0) {
          await interaction.reply({ content: "Add at least one role.", ephemeral: true });
          return;
        }

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          entries.map((e) =>
            new ButtonBuilder()
              .setCustomId(`${CUSTOM_ID_PREFIX}${e.roleId}`)
              .setLabel(e.label)
              .setStyle(ButtonStyle.Secondary)
          )
        );

        await interaction.reply({ content: `**${title}**`, components: [row] });
        context.logger.info("Role menu posted", { roleCount: entries.length });
      },
    },
  ],
  components: [
    {
      customIdPrefix: CUSTOM_ID_PREFIX,
      async execute(rawInteraction, context) {
        const interaction = rawInteraction as ButtonInteraction;
        const roleId = interaction.customId.slice(CUSTOM_ID_PREFIX.length);
        const guild = interaction.guild!;
        const member = interaction.member as GuildMember;

        const role = guild.roles.cache.get(roleId);
        if (!role) {
          await interaction.reply({ content: "That role no longer exists.", ephemeral: true });
          return;
        }

        try {
          if (member.roles.cache.has(roleId)) {
            await member.roles.remove(role);
            await interaction.reply({ content: `Removed **${role.name}**.`, ephemeral: true });
          } else {
            await member.roles.add(role);
            await interaction.reply({ content: `Gave you **${role.name}**.`, ephemeral: true });
          }
        } catch (err) {
          context.logger.error("Role toggle failed", { error: (err as Error).message, roleId });
          await interaction.reply({
            content: "Couldn't toggle that role — the bot's role needs to be positioned above it.",
            ephemeral: true,
          });
        }
      },
    },
  ],
  async init(context) {
    context.logger.info("roles module initialized", { guildId: context.guildId });
  },
  async destroy(context) {
    context.logger.info("roles module destroyed", { guildId: context.guildId });
  },
});
