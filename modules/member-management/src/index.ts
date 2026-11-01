/**
 * Basic Ghost Labs - Project Eclipse
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Welcome and Goodbye were separate modules; merged here because they're
 * the same pattern (a channel + a message template, ManageGuild-gated) and
 * the original spec groups both under "Member Management" as one feature
 * set, not two. One enable/disable toggle covers both instead of two.
 */

import { defineModule } from "@platform/module-sdk";
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChatInputCommandInteraction,
  GuildMember,
  TextChannel,
} from "discord.js";

interface GreetingConfig {
  channelId?: string;
  message?: string;
}

interface ProfileSettings {
  enabled?: boolean; // default true
  allowNameChange?: boolean; // default true
  allowColorChange?: boolean; // default true
  allowedColors?: string[]; // hex codes, e.g. ["#FF69B4", "#00A2FF"]; empty/undefined = any valid hex
}

const HEX_COLOR_RE = /^#?[0-9A-Fa-f]{6}$/;

function normalizeHex(input: string): string | null {
  if (!HEX_COLOR_RE.test(input)) return null;
  return input.startsWith("#") ? input.toUpperCase() : `#${input.toUpperCase()}`;
}

async function sendGreeting(context: any, configKey: string, member: GuildMember, replaceWith: string) {
  const config = (await context.config.get<GreetingConfig>(configKey)) ?? {};
  if (!config.channelId || !config.message) return;

  const channel = member.guild.channels.cache.get(config.channelId) as TextChannel | undefined;
  if (!channel?.isTextBased()) {
    context.logger.warn(`${configKey} channel missing or not text-based`, { guildId: member.guild.id });
    return;
  }

  await channel.send({ content: config.message.replace("{user}", replaceWith) });
}

export default defineModule({
  name: "member-management",
  version: "1.0.0",
  type: "module",
  description: "Welcome/goodbye messages and self-service custom profile roles (name + color).",
  dashboard: {
    settings: [
      { type: "channel", key: "welcomeConfig.channelId", label: "Welcome Channel" },
      { type: "text", key: "welcomeConfig.message", label: "Welcome Message (use {user} for a mention)" },
      { type: "channel", key: "goodbyeConfig.channelId", label: "Goodbye Channel" },
      { type: "text", key: "goodbyeConfig.message", label: "Goodbye Message (use {user} for the username)" },
      { type: "toggle", key: "profileSettings.enabled", label: "Enable Custom Profiles", default: true },
      { type: "toggle", key: "profileSettings.allowNameChange", label: "Allow name changes", default: true },
      { type: "toggle", key: "profileSettings.allowColorChange", label: "Allow color changes", default: true },
    ],
  },
  commands: [
    {
      name: "welcome-config",
      description: "Set the welcome channel and message",
      data: new SlashCommandBuilder()
        .setName("welcome-config")
        .setDescription("Set the welcome channel and message")
        .addChannelOption((o) => o.setName("channel").setDescription("Channel to post welcomes in").setRequired(false))
        .addStringOption((o) =>
          o.setName("message").setDescription("Welcome message, use {user} for a mention").setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .toJSON(),
      async execute(rawInteraction, context) {
        const interaction = rawInteraction as ChatInputCommandInteraction;
        const channel = interaction.options.getChannel("channel");
        const message = interaction.options.getString("message");

        const update: GreetingConfig = {};
        if (channel) update.channelId = channel.id;
        if (message) update.message = message;
        if (Object.keys(update).length > 0) await context.config.set("welcomeConfig", update);

        const current = (await context.config.get<GreetingConfig>("welcomeConfig")) ?? {};
        await interaction.reply({
          content: `Welcome config:\nChannel: ${current.channelId ? `<#${current.channelId}>` : "not set"}\nMessage: ${current.message ?? "not set"}`,
          ephemeral: true,
        });
      },
    },
    {
      name: "goodbye-config",
      description: "Set the goodbye channel and message",
      data: new SlashCommandBuilder()
        .setName("goodbye-config")
        .setDescription("Set the goodbye channel and message")
        .addChannelOption((o) => o.setName("channel").setDescription("Channel to post goodbyes in").setRequired(false))
        .addStringOption((o) =>
          o.setName("message").setDescription("Goodbye message, use {user} for the username").setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .toJSON(),
      async execute(rawInteraction, context) {
        const interaction = rawInteraction as ChatInputCommandInteraction;
        const channel = interaction.options.getChannel("channel");
        const message = interaction.options.getString("message");

        const update: GreetingConfig = {};
        if (channel) update.channelId = channel.id;
        if (message) update.message = message;
        if (Object.keys(update).length > 0) await context.config.set("goodbyeConfig", update);

        const current = (await context.config.get<GreetingConfig>("goodbyeConfig")) ?? {};
        await interaction.reply({
          content: `Goodbye config:\nChannel: ${current.channelId ? `<#${current.channelId}>` : "not set"}\nMessage: ${current.message ?? "not set"}`,
          ephemeral: true,
        });
      },
    },
    {
      name: "profile",
      description: "Set up or edit your personal display name and role color",
      data: new SlashCommandBuilder()
        .setName("profile")
        .setDescription("Set up or edit your personal display name and role color")
        .addSubcommand((sc) =>
          sc
            .setName("setup")
            .setDescription("Create your personal profile role")
            .addStringOption((o) => o.setName("name").setDescription("Display name for your role").setRequired(false))
            .addStringOption((o) => o.setName("color").setDescription("Hex color, e.g. #FF69B4").setRequired(false))
        )
        .addSubcommand((sc) =>
          sc
            .setName("edit")
            .setDescription("Edit your existing profile role")
            .addStringOption((o) => o.setName("name").setDescription("New display name").setRequired(false))
            .addStringOption((o) => o.setName("color").setDescription("New hex color, e.g. #FF69B4").setRequired(false))
        )
        .toJSON(),
      async execute(rawInteraction, context) {
        const interaction = rawInteraction as ChatInputCommandInteraction;
        const sub = interaction.options.getSubcommand();
        const settings = (await context.config.get<ProfileSettings>("profileSettings")) ?? {};

        if (settings.enabled === false) {
          await interaction.reply({ content: "Custom profiles are disabled in this server.", ephemeral: true });
          return;
        }

        const guild = interaction.guild!;
        const member = interaction.member as GuildMember;
        const existingRoleId = (await context.db.get(`profileRole:${interaction.user.id}`)) as string | undefined;

        const requestedName = interaction.options.getString("name") ?? undefined;
        const requestedColorRaw = interaction.options.getString("color") ?? undefined;

        if (requestedColorRaw && !normalizeHex(requestedColorRaw)) {
          await interaction.reply({ content: "That's not a valid hex color. Try something like #FF69B4.", ephemeral: true });
          return;
        }
        const requestedColor = requestedColorRaw ? normalizeHex(requestedColorRaw)! : undefined;

        if (requestedColor && settings.allowedColors?.length && !settings.allowedColors.includes(requestedColor)) {
          await interaction.reply({
            content: `That color isn't in the allowed list for this server: ${settings.allowedColors.join(", ")}`,
            ephemeral: true,
          });
          return;
        }

        if (sub === "setup") {
          if (existingRoleId && guild.roles.cache.has(existingRoleId)) {
            await interaction.reply({ content: "You already have a profile role — use `/profile edit` instead.", ephemeral: true });
            return;
          }

          try {
            const role = await guild.roles.create({
              name: requestedName ?? interaction.user.username,
              color: (requestedColor as any) ?? undefined,
              mentionable: false,
              permissions: [], // deliberately zero permissions — this role is display-only
              reason: `Profile role for ${interaction.user.tag}`,
            });

            // Best-effort: place it just under the bot's own top role so the
            // color actually shows. If this fails, the role still works —
            // an admin may just need to drag it up manually.
            try {
              const botMember = await guild.members.fetchMe();
              await role.setPosition(Math.max(botMember.roles.highest.position - 1, 1));
            } catch (err) {
              context.logger.warn("Could not reposition profile role", { error: (err as Error).message });
            }

            await member.roles.add(role);
            await context.db.set(`profileRole:${interaction.user.id}`, role.id);

            await interaction.reply({ content: `Profile role created: **${role.name}**. Use \`/profile edit\` to change it later.`, ephemeral: true });
          } catch (err) {
            context.logger.error("Profile setup failed", { error: (err as Error).message });
            await interaction.reply({ content: "Couldn't create your profile role — check the bot's role permissions.", ephemeral: true });
          }
          return;
        }

        // sub === "edit"
        if (!existingRoleId || !guild.roles.cache.has(existingRoleId)) {
          await interaction.reply({ content: "You don't have a profile role yet — run `/profile setup` first.", ephemeral: true });
          return;
        }
        const role = guild.roles.cache.get(existingRoleId)!;

        // This bot will ONLY ever modify the exact role ID it created and
        // stored for this user — never a role name match, never a role
        // picked by the user. That's what keeps /profile edit from being
        // usable to touch anyone else's role.
        try {
          if (requestedName) {
            if (settings.allowNameChange === false) {
              await interaction.reply({ content: "Name changes are disabled in this server.", ephemeral: true });
              return;
            }
            await role.setName(requestedName);
          }
          if (requestedColor) {
            if (settings.allowColorChange === false) {
              await interaction.reply({ content: "Color changes are disabled in this server.", ephemeral: true });
              return;
            }
            await role.setColor(requestedColor as any);
          }
          await interaction.reply({ content: `Updated your profile role: **${role.name}**.`, ephemeral: true });
        } catch (err) {
          context.logger.error("Profile edit failed", { error: (err as Error).message });
          await interaction.reply({ content: "Couldn't update your profile role — check the bot's role permissions.", ephemeral: true });
        }
      },
    },
    {
      name: "profile-config",
      description: "Configure custom profile behavior for this server",
      data: new SlashCommandBuilder()
        .setName("profile-config")
        .setDescription("Configure custom profile behavior for this server")
        .addBooleanOption((o) => o.setName("enabled").setDescription("Allow members to create profile roles").setRequired(false))
        .addBooleanOption((o) => o.setName("allow_name_change").setDescription("Allow members to rename their role").setRequired(false))
        .addBooleanOption((o) => o.setName("allow_color_change").setDescription("Allow members to recolor their role").setRequired(false))
        .addStringOption((o) =>
          o.setName("allowed_colors").setDescription("Comma-separated hex codes, or 'any' to clear the restriction").setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .toJSON(),
      async execute(rawInteraction, context) {
        const interaction = rawInteraction as ChatInputCommandInteraction;
        const update: ProfileSettings = {};

        const enabled = interaction.options.getBoolean("enabled");
        const allowName = interaction.options.getBoolean("allow_name_change");
        const allowColor = interaction.options.getBoolean("allow_color_change");
        const colorsRaw = interaction.options.getString("allowed_colors");

        if (enabled !== null) update.enabled = enabled;
        if (allowName !== null) update.allowNameChange = allowName;
        if (allowColor !== null) update.allowColorChange = allowColor;
        if (colorsRaw !== null) {
          if (colorsRaw.trim().toLowerCase() === "any") {
            update.allowedColors = [];
          } else {
            const parsed = colorsRaw.split(",").map((c) => normalizeHex(c.trim())).filter(Boolean) as string[];
            update.allowedColors = parsed;
          }
        }

        if (Object.keys(update).length > 0) await context.config.set("profileSettings", update);

        const current = (await context.config.get<ProfileSettings>("profileSettings")) ?? {};
        await interaction.reply({
          content:
            `Profile settings:\n` +
            `Enabled: ${current.enabled === false ? "no" : "yes"}\n` +
            `Name changes: ${current.allowNameChange === false ? "no" : "yes"}\n` +
            `Color changes: ${current.allowColorChange === false ? "no" : "yes"}\n` +
            `Allowed colors: ${current.allowedColors?.length ? current.allowedColors.join(", ") : "any"}`,
          ephemeral: true,
        });
      },
    },
  ],
  events: [
    {
      event: "guildMemberAdd",
      async handler(rawMember, context) {
        const member = rawMember as GuildMember;
        await sendGreeting(context, "welcomeConfig", member, `<@${member.id}>`);
      },
    },
    {
      // Fires for voluntary leaves and kicks/bans alike — distinguishing
      // them needs an audit-log lookup shortly after, left as a fast-follow.
      event: "guildMemberRemove",
      async handler(rawMember, context) {
        const member = rawMember as GuildMember;
        await sendGreeting(context, "goodbyeConfig", member, member.user.tag);
      },
    },
  ],
  async init(context) {
    context.logger.info("member-management module initialized", { guildId: context.guildId });
  },
  async destroy(context) {
    context.logger.info("member-management module destroyed", { guildId: context.guildId });
  },
});
