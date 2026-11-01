/**
 * Basic Ghost Labs - Good Boy
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */
import { PermissionFlagsBits as P } from 'discord.js';

/** Permissions that belong to the platform itself rather than a module. */
export const CORE_PERMISSIONS = [
  { key: 'dashboard.access', label: 'Use the web dashboard (only the panels whose own permission they also hold)', default: 'admin' },
];

const MOD_BITS = [P.ModerateMembers, P.KickMembers, P.BanMembers, P.ManageMessages];

/**
 * Permission keys are declared by modules (e.g. "moderation.ban") with a default level.
 * Server owners can map any key to specific roles, which then REPLACES the default for that key.
 * The server owner and anyone with Administrator always pass; Manage Server passes everything except 'owner' keys.
 */
export class Permissions {
  constructor(db) {
    this.db = db;
    this.registry = new Map(); // key -> { key, label, default, module }
    this.register('core', CORE_PERMISSIONS);
  }

  register(moduleName, list = []) {
    for (const p of list) this.registry.set(p.key, { key: p.key, label: p.label ?? p.key, default: p.default ?? 'admin', discordPerm: p.discordPerm, module: moduleName });
  }

  unregister(moduleName) {
    for (const [k, v] of this.registry) if (v.module === moduleName) this.registry.delete(k);
  }

  isOwner(member) { return !!member && member.id === member.guild.ownerId; }

  /** Server owner, Administrator or Manage Server. */
  isAdmin(member) {
    if (!member?.permissions) return false;
    return this.isOwner(member) || member.permissions.has(P.Administrator) || member.permissions.has(P.ManageGuild);
  }

  isModerator(member) {
    if (!member?.permissions) return false;
    return this.isAdmin(member) || MOD_BITS.some((b) => member.permissions.has(b));
  }

  rolesFor(guildId, key) { return this.db.permRoles(guildId, key); }

  check(member, key) {
    if (!member?.guild) return false;
    if (this.isOwner(member) || member.permissions?.has(P.Administrator)) return true;
    const roles = this.db.permRoles(member.guild.id, key);
    const level = this.registry.get(key)?.default ?? 'admin';
    // Server managers can always use everything except owner-only keys (they could re-map it anyway).
    if (roles.length) return roles.some((r) => member.roles.cache.has(r)) || (level !== 'owner' && this.isAdmin(member));
    if (level === 'everyone') return true;
    if (level === 'moderator') {
      // A key can name the native Discord permission it corresponds to (e.g. BanMembers).
      const dp = this.registry.get(key)?.discordPerm;
      const need = dp ? P[dp] : undefined;
      if (need) return member.permissions.has(need) || this.isAdmin(member);
      return this.isModerator(member);
    }
    if (level === 'admin') return this.isAdmin(member);
    return false; // 'owner'
  }

  describeDefault(key) {
    return ({ everyone: 'everyone', moderator: 'moderators', admin: 'admins (Manage Server)', owner: 'server owner only' })[this.registry.get(key)?.default ?? 'admin'];
  }
}
