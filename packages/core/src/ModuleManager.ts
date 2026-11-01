/**
 * Basic Ghost Labs - Project Eclipse
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */


import semver from "semver";
import {
  AnyManifest,
  ModuleManifest,
  AddonManifest,
  ModuleState,
  ModuleContext,
} from "@platform/module-sdk";

interface LoadedModule {
  manifest: AnyManifest;
  state: ModuleState;
  guildScopes: Set<string>; // guilds where this module is currently enabled
}

/**
 * Central lifecycle authority. The Core never contains feature logic
 * ("if tickets enabled...") — it only knows how to move a module through
 * INSTALL -> VALIDATE -> ENABLE -> LOAD -> RUN -> UPDATE -> RELOAD ->
 * DISABLE -> UNLOAD -> UNINSTALL, and how to isolate failures.
 */
export class ModuleManager {
  private modules = new Map<string, LoadedModule>();

  constructor(
    private readonly makeContext: (guildId: string | undefined, moduleName: string) => ModuleContext,
    private readonly logger: { info: Function; warn: Function; error: Function }
  ) {}

  /** All installed manifests — used by the Core to register commands/events. */
  listManifests(): AnyManifest[] {
    return [...this.modules.values()].map((m) => m.manifest);
  }

  /** Which installed module owns a given slash command name, if any. */
  findModuleForCommand(commandName: string): AnyManifest | undefined {
    return this.listManifests().find((m) => m.commands?.some((c) => c.name === commandName));
  }

  /** Which installed modules are listening for a given Discord event name. */
  findModulesForEvent(eventName: string): AnyManifest[] {
    return this.listManifests().filter((m) => m.events?.some((e) => e.event === eventName));
  }

  /** Which installed module owns a button/select whose customId starts with a registered prefix. */
  findModuleForComponent(customId: string): AnyManifest | undefined {
    return this.listManifests().find((m) =>
      m.components?.some((c) => customId.startsWith(c.customIdPrefix))
    );
  }

  isEnabledForGuild(name: string, guildId: string): boolean {
    const entry = this.modules.get(name);
    return !!entry && entry.state === "running" && entry.guildScopes.has(guildId);
  }

  /** Step 1-2: INSTALL + VALIDATE */
  async install(manifest: AnyManifest): Promise<void> {
    this.validateManifestShape(manifest);

    if (manifest.type === "addon") {
      this.validateAddonDependency(manifest);
    }

    if (this.modules.has(manifest.name)) {
      throw new Error(`Module "${manifest.name}" is already installed.`);
    }

    this.modules.set(manifest.name, {
      manifest,
      state: "validated",
      guildScopes: new Set(),
    });

    this.logger.info(`Installed module "${manifest.name}"@${manifest.version}`);
  }

  /** Step 3-5: ENABLE -> LOAD -> RUN (for a specific guild) */
  async enable(name: string, guildId: string): Promise<void> {
    const entry = this.requireModule(name);

    try {
      const context = this.makeContext(guildId, name);
      await entry.manifest.init(context);
      entry.guildScopes.add(guildId);
      entry.state = "running";
      this.logger.info(`Module "${name}" enabled for guild ${guildId}`);
    } catch (err) {
      entry.state = "errored";
      this.logger.error(`Module "${name}" failed to init for guild ${guildId}`, {
        error: (err as Error).message,
      });
      // A module failing to start must not crash the platform.
      throw err;
    }
  }

  /** UPDATE -> RELOAD, with automatic rollback on failure. */
  async update(name: string, newManifest: AnyManifest): Promise<void> {
    const entry = this.requireModule(name);
    const previousManifest = entry.manifest;
    const previousVersion = previousManifest.version;

    if (!semver.gt(newManifest.version, previousVersion)) {
      throw new Error(
        `Refusing update: ${newManifest.version} is not newer than installed ${previousVersion}`
      );
    }

    entry.state = "updating";

    try {
      // RELOAD affected guilds one at a time so a bad update doesn't take
      // every guild down simultaneously.
      for (const guildId of entry.guildScopes) {
        const context = this.makeContext(guildId, name);
        await previousManifest.destroy(context);
        if (newManifest.update) {
          await newManifest.update(context, previousVersion);
        }
        await newManifest.init(context);
      }

      entry.manifest = newManifest;
      entry.state = "running";
      this.logger.info(`Module "${name}" updated ${previousVersion} -> ${newManifest.version}`);
    } catch (err) {
      this.logger.error(`Update failed for "${name}", rolling back to ${previousVersion}`, {
        error: (err as Error).message,
      });
      entry.manifest = previousManifest; // ROLLBACK
      entry.state = "running";
      throw err;
    }
  }

  /** DISABLE -> UNLOAD for a specific guild. */
  async disable(name: string, guildId: string): Promise<void> {
    const entry = this.requireModule(name);
    const context = this.makeContext(guildId, name);

    try {
      await entry.manifest.destroy(context);
    } finally {
      entry.guildScopes.delete(guildId);
      if (entry.guildScopes.size === 0) {
        entry.state = "disabled";
      }
    }
  }

  /** UNINSTALL — blocked if add-ons still depend on this module. */
  async uninstall(name: string, force = false): Promise<void> {
    const dependents = this.findDependentAddons(name);
    if (dependents.length > 0 && !force) {
      throw new Error(
        `Cannot remove "${name}". ${dependents.length} installed add-on(s) depend on this module.`
      );
    }

    for (const addon of dependents) {
      this.modules.delete(addon.manifest.name);
    }

    this.modules.delete(name);
    this.logger.info(`Uninstalled module "${name}"`);
  }

  getState(name: string): ModuleState {
    return this.requireModule(name).state;
  }

  private requireModule(name: string): LoadedModule {
    const entry = this.modules.get(name);
    if (!entry) throw new Error(`Module "${name}" is not installed.`);
    return entry;
  }

  private validateManifestShape(manifest: AnyManifest) {
    if (!manifest.name || !manifest.version || !manifest.init || !manifest.destroy) {
      throw new Error("Manifest missing required fields (name, version, init, destroy).");
    }
    if (!semver.valid(manifest.version)) {
      throw new Error(`Manifest version "${manifest.version}" is not valid semver.`);
    }
  }

  private validateAddonDependency(addon: AddonManifest) {
    const required = this.modules.get(addon.requires.module);
    if (!required) {
      throw new Error(
        `Add-on "${addon.name}" requires module "${addon.requires.module}", which is not installed.`
      );
    }
    if (!semver.satisfies(required.manifest.version, addon.requires.version)) {
      throw new Error(
        `Add-on "${addon.name}" requires "${addon.requires.module}" ${addon.requires.version}, ` +
          `but installed version is ${required.manifest.version}.`
      );
    }
  }

  private findDependentAddons(moduleName: string): LoadedModule[] {
    return [...this.modules.values()].filter(
      (m) => m.manifest.type === "addon" && (m.manifest as AddonManifest).requires.module === moduleName
    );
  }
}
