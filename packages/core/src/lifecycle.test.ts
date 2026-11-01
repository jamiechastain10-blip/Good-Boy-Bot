/**
 * Basic Ghost Labs - Project Eclipse
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */


/**
 * Phase 1 acceptance test: install -> enable -> use -> disable -> unload -> re-enable.
 * Run with your test runner of choice (vitest/jest); written framework-agnostic below.
 */
import { ModuleManager } from "./ModuleManager";
import testModule from "../../../modules/test-module/src/index";

const noopContext = {
  logger: { info() {}, warn() {}, error() {} },
  config: { get: async () => undefined, set: async () => {} },
  db: { get: async () => undefined, set: async () => {}, delete: async () => {} },
  discord: { request: async () => ({}) },
  permissions: { check: async () => true },
};

async function run() {
  const manager = new ModuleManager(
    () => noopContext,
    { info: console.log, warn: console.warn, error: console.error }
  );

  await manager.install(testModule);
  console.assert(manager.getState("test-module") === "validated", "expected validated state");

  await manager.enable("test-module", "guild-1");
  console.assert(manager.getState("test-module") === "running", "expected running state");

  await manager.disable("test-module", "guild-1");
  console.assert(manager.getState("test-module") === "disabled", "expected disabled state");

  await manager.enable("test-module", "guild-1"); // re-enable
  console.assert(manager.getState("test-module") === "running", "expected running state again");

  await manager.uninstall("test-module");

  console.log("Lifecycle acceptance test passed.");
}

run().catch((err) => {
  console.error("Lifecycle acceptance test FAILED:", err);
  process.exit(1);
});
