/**
 * Basic Ghost Labs - Project Eclipse
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */

import { defineModule } from "@platform/module-sdk";
import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChatInputCommandInteraction,
  TextChannel,
} from "discord.js";

interface LogEntry {
  type: string;
  targetId: string;
  targetTag: string;
  moderatorId: string;
  reason: string;
  at: number;
}

const MAX_LOG_ENTRIES = 200;

async function logAction(context: any, entry: LogEntry) {
  const existing = ((await context.db.get("actionLog")) as LogEntry[] | undefined) ?? [];
  const updated = [entry, ...existing].slice(0, MAX_LOG_ENTRIES);
  await context.db.set("actionLog", updated);
}

export default defineModule({
  name: "moderation",
  version: "1.1.0",
  type: "module",
  description: "Warn, timeout, kick, ban, unban, purge, with per-server action logging.",
  permissions: [
    { key: "moderation.warn", label: "Warn members", defaultRoles: "admin" },
    { key: "moderation.timeout", label: "Timeout members", defaultRoles: "admin" },
    { key: "moderation.kick", label: "Kick members", defaultRoles: "admin" },
    { key: "moderation.ban", label: "Ban / unban members", defaultRoles: "admin" },
    { key: "moderation.purge", label: "Bulk delete messages", defaultRoles: "admin" },
  ],
  commands: [
    {
      name: "warn",
      description: "Warn a member",
      data: new SlashCommandBuilder()
        .setName("warn")
        .setDescription("Warn a member")
        .addUserOption((o) => o.setName("user").setDescription("User to warn").setRequired(true))
        .addStringOption((o) => o.setName("reason").setDescription("Reason for the warning").setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .toJSON(),
      async execute(rawInteraction, context) {
        const interaction = rawInteraction as ChatInputCommandInteraction;
        const target = interaction.options.getUser("user", true);
        const reason = interaction.options.getString("reason") ?? "No reason provided";

        await logAction(context, {
          type: "warn",
          targetId: target.id,
          targetTag: target.tag,
          moderatorId: interaction.user.id,
          reason,
          at: Date.now(),
        });
        context.logger.info("Member warned", { targetId: target.id, moderatorId: interaction.user.id });
        await interaction.reply({ content: `⚠️ ${target.tag} has been warned. Reason: ${reason}` });
      },
    },
    {
      name: "timeout",
      description: "Time out a member",
      data: new SlashCommandBuilder()
        .setName("timeout")
        .setDescription("Time out a member")
        .addUserOption((o) => o.setName("user").setDescription("User to time out").setRequired(true))
        .addIntegerOption((o) =>
          o.setName("minutes").setDescription("Duration in minutes (max 40320 / 28 days)").setRequired(true)
        )
        .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .toJSON(),
      async execute(rawInteraction, context) {
        const interaction = rawInteraction as ChatInputCommandInteraction;
        const target = interaction.options.getUser("user", true);
        const minutes = interaction.options.getInteger("minutes", true);
        const reason = interaction.options.getString("reason") ?? "No reason provided";

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
          await interaction.reply({ content: "You don't have permission to time out members.", ephemeral: true });
          return;
        }

        try {
          const member = await interaction.guild?.members.fetch(target.id);
          await member?.timeout(minutes * 60 * 1000, reason);
          await logAction(context, {
            type: "timeout",
            targetId: target.id,
            targetTag: target.tag,
            moderatorId: interaction.user.id,
            reason: `${reason} (${minutes}m)`,
            at: Date.now(),
          });
          await interaction.reply({ content: `⏱️ ${target.tag} timed out for ${minutes} minute(s). Reason: ${reason}` });
        } catch (err) {
          context.logger.error("Timeout failed", { error: (err as Error).message });
          await interaction.reply({ content: "Couldn't time out that member — check my role permissions.", ephemeral: true });
        }
      },
    },
    {
      name: "kick",
      description: "Kick a member",
      data: new SlashCommandBuilder()
        .setName("kick")
        .setDescription("Kick a member")
        .addUserOption((o) => o.setName("user").setDescription("User to kick").setRequired(true))
        .addStringOption((o) => o.setName("reason").setDescription("Reason for the kick").setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
        .toJSON(),
      async execute(rawInteraction, context) {
        const interaction = rawInteraction as ChatInputCommandInteraction;
        const target = interaction.options.getUser("user", true);
        const reason = interaction.options.getString("reason") ?? "No reason provided";

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.KickMembers)) {
          await interaction.reply({ content: "You don't have permission to kick members.", ephemeral: true });
          return;
        }

        try {
          await interaction.guild?.members.kick(target.id, reason);
          await logAction(context, {
            type: "kick",
            targetId: target.id,
            targetTag: target.tag,
            moderatorId: interaction.user.id,
            reason,
            at: Date.now(),
          });
          await interaction.reply({ content: `👢 ${target.tag} was kicked. Reason: ${reason}` });
        } catch (err) {
          context.logger.error("Kick failed", { error: (err as Error).message });
          await interaction.reply({ content: "Couldn't kick that member — check my role permissions.", ephemeral: true });
        }
      },
    },
    {
      name: "ban",
      description: "Ban a member",
      data: new SlashCommandBuilder()
        .setName("ban")
        .setDescription("Ban a member")
        .addUserOption((o) => o.setName("user").setDescription("User to ban").setRequired(true))
        .addStringOption((o) => o.setName("reason").setDescription("Reason for the ban").setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .toJSON(),
      async execute(rawInteraction, context) {
        const interaction = rawInteraction as ChatInputCommandInteraction;
        const target = interaction.options.getUser("user", true);
        const reason = interaction.options.getString("reason") ?? "No reason provided";

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers)) {
          await interaction.reply({ content: "You don't have permission to ban members.", ephemeral: true });
          return;
        }

        try {
          await interaction.guild?.members.ban(target.id, { reason });
          await logAction(context, {
            type: "ban",
            targetId: target.id,
            targetTag: target.tag,
            moderatorId: interaction.user.id,
            reason,
            at: Date.now(),
          });
          await interaction.reply({ content: `🔨 ${target.tag} was banned. Reason: ${reason}` });
        } catch (err) {
          context.logger.error("Ban failed", { error: (err as Error).message });
          await interaction.reply({ content: "Couldn't ban that member — check my role permissions.", ephemeral: true });
        }
      },
    },
    {
      name: "unban",
      description: "Unban a user by ID",
      data: new SlashCommandBuilder()
        .setName("unban")
        .setDescription("Unban a user")
        .addStringOption((o) => o.setName("userid").setDescription("User ID to unban").setRequired(true))
        .addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .toJSON(),
      async execute(rawInteraction, context) {
        const interaction = rawInteraction as ChatInputCommandInteraction;
        const userId = interaction.options.getString("userid", true);
        const reason = interaction.options.getString("reason") ?? "No reason provided";

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers)) {
          await interaction.reply({ content: "You don't have permission to unban members.", ephemeral: true });
          return;
        }

        try {
          await interaction.guild?.members.unban(userId, reason);
          await logAction(context, {
            type: "unban",
            targetId: userId,
            targetTag: userId,
            moderatorId: interaction.user.id,
            reason,
            at: Date.now(),
          });
          await interaction.reply({ content: `✅ Unbanned <@${userId}>. Reason: ${reason}` });
        } catch (err) {
          context.logger.error("Unban failed", { error: (err as Error).message });
          await interaction.reply({ content: "Couldn't unban that user — check the ID and my permissions.", ephemeral: true });
        }
      },
    },
    {
      name: "purge",
      description: "Bulk delete recent messages in this channel",
      data: new SlashCommandBuilder()
        .setName("purge")
        .setDescription("Bulk delete recent messages in this channel")
        .addIntegerOption((o) =>
          o.setName("amount").setDescription("Number of messages to delete (1-100)").setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .toJSON(),
      async execute(rawInteraction, context) {
        const interaction = rawInteraction as ChatInputCommandInteraction;
        const amount = interaction.options.getInteger("amount", true);

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
          await interaction.reply({ content: "You don't have permission to purge messages.", ephemeral: true });
          return;
        }
        if (amount < 1 || amount > 100) {
          await interaction.reply({ content: "Amount must be between 1 and 100.", ephemeral: true });
          return;
        }

        try {
          const channel = interaction.channel as TextChannel;
          const deleted = await channel.bulkDelete(amount, true);
          await logAction(context, {
            type: "purge",
            targetId: channel.id,
            targetTag: channel.name,
            moderatorId: interaction.user.id,
            reason: `${deleted.size} messages`,
            at: Date.now(),
          });
          await interaction.reply({ content: `🧹 Deleted ${deleted.size} message(s).`, ephemeral: true });
        } catch (err) {
          context.logger.error("Purge failed", { error: (err as Error).message });
          await interaction.reply({
            content: "Couldn't delete those messages — Discord only allows bulk-deleting messages under 14 days old.",
            ephemeral: true,
          });
        }
      },
    },
    {
      name: "modhistory",
      description: "View recent moderation actions for a user",
      data: new SlashCommandBuilder()
        .setName("modhistory")
        .setDescription("View recent moderation actions for a user")
        .addUserOption((o) => o.setName("user").setDescription("User to look up").setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .toJSON(),
      async execute(rawInteraction, context) {
        const interaction = rawInteraction as ChatInputCommandInteraction;
        const target = interaction.options.getUser("user", true);

        const log = ((await context.db.get("actionLog")) as LogEntry[] | undefined) ?? [];
        const matches = log.filter((e) => e.targetId === target.id).slice(0, 10);

        if (matches.length === 0) {
          await interaction.reply({ content: `No moderation history for ${target.tag}.`, ephemeral: true });
          return;
        }

        const lines = matches.map(
          (e) => `**${e.type}** — ${e.reason} (<t:${Math.floor(e.at / 1000)}:R>, by <@${e.moderatorId}>)`
        );
        await interaction.reply({ content: `Moderation history for ${target.tag}:\n${lines.join("\n")}`, ephemeral: true });
      },
    },
  ],
  async init(context) {
    context.logger.info("moderation module initialized", { guildId: context.guildId });
  },
  async destroy(context) {
    context.logger.info("moderation module destroyed", { guildId: context.guildId });
  },
});
