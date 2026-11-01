/**
 * Basic Ghost Labs - Project Eclipse
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */


/**
 * These are the contracts every Module and Add-on is built against.
 * The Core depends on these types; modules depend on these types.
 * Neither depends on the other's internals.
 */

export type ModuleState =
  | "installed"
  | "validated"
  | "enabled"
  | "loaded"
  | "running"
  | "updating"
  | "disabled"
  | "unloaded"
  | "uninstalled"
  | "errored";

export interface DashboardField {
  type: "toggle" | "channel" | "role" | "text" | "number" | "select" | "multi-select";
  key: string;
  label: string;
  description?: string;
  options?: { label: string; value: string }[]; // for select / multi-select
  default?: unknown;
}

export interface DashboardDefinition {
  settings: DashboardField[];
}

export interface CommandDefinition {
  name: string;
  description: string;
  /**
   * The full REST command body, e.g. from a discord.js
   * `new SlashCommandBuilder()....toJSON()`. Kept as `unknown` here so the
   * SDK's type doesn't hard-pin a discord.js version — the Core casts it
   * when registering commands with Discord.
   */
  data: unknown;
  execute: (interaction: unknown, context: ModuleContext) => Promise<void>;
}

export interface EventHandlerDefinition {
  event: string; // e.g. "guildMemberAdd"
  handler: (payload: unknown, context: ModuleContext) => Promise<void>;
}

export interface ComponentHandlerDefinition {
  /** Matches if the interaction's customId starts with this prefix, e.g. "rolemenu:" */
  customIdPrefix: string;
  execute: (interaction: unknown, context: ModuleContext) => Promise<void>;
}

export interface PermissionDefinition {
  key: string; // e.g. "moderation.warn"
  label: string;
  description?: string;
  defaultRoles?: "admin" | "everyone" | "none";
}

export interface ModuleDependency {
  module: string;
  version: string; // semver range, e.g. ">=2.0.0"
}

export interface BaseManifest {
  name: string;
  version: string; // semver
  description?: string;
  author?: string;
  commands?: CommandDefinition[];
  events?: EventHandlerDefinition[];
  components?: ComponentHandlerDefinition[];
  permissions?: PermissionDefinition[];
  dashboard?: DashboardDefinition;

  init(context: ModuleContext): Promise<void>;
  destroy(context: ModuleContext): Promise<void>;
  update?(context: ModuleContext, fromVersion: string): Promise<void>;

  /** Optional per-guild config validator, run before saving dashboard changes. */
  validateConfig?(config: Record<string, unknown>): { valid: boolean; errors?: string[] };
}

export interface ModuleManifest extends BaseManifest {
  type: "module";
  dependencies?: ModuleDependency[]; // dependencies on OTHER modules (rare, but allowed)
}

export interface AddonManifest extends BaseManifest {
  type: "addon";
  requires: ModuleDependency; // the single module this add-on extends
}

export type AnyManifest = ModuleManifest | AddonManifest;

/**
 * The ModuleContext is the ONLY way a module touches the outside world.
 * It never receives the raw discord.js Client, the database connection,
 * or other modules' internals directly — everything is mediated so the
 * Core can enforce permissions, logging, and rate limiting centrally.
 */
export interface ModuleContext {
  guildId?: string; // present when context is scoped to a single guild
  logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
  config: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };
  db: {
    // Scoped to this module's own namespace — see PermissionManager notes.
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  discord: {
    // All outbound Discord calls go through here, never a raw client.
    request<T = unknown>(op: DiscordApiRequest): Promise<T>;
  };
  permissions: {
    check(userId: string, permissionKey: string): Promise<boolean>;
  };
}

export interface DiscordApiRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  route: string; // e.g. "/channels/{channel.id}/messages"
  body?: unknown;
  priority?: "low" | "normal" | "high";
}
