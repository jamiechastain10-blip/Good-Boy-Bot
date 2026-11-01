/**
 * Basic Ghost Labs - Project Eclipse
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */


export * from "./types";
import { ModuleManifest, AddonManifest } from "./types";

/** Thin identity helper so module authors get autocomplete + type checking. */
export function defineModule(manifest: ModuleManifest): ModuleManifest {
  return manifest;
}

export function defineAddon(manifest: AddonManifest): AddonManifest {
  return manifest;
}
