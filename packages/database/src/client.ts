/**
 * Basic Ghost Labs - Project Eclipse
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 */

import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

const moduleIdCache = new Map<string, string>();

/** Ensures a Module catalog row exists, returns its id. Cached in memory. */
export async function ensureModuleRecord(name: string, type: "module" | "addon", version: string): Promise<string> {
  const cached = moduleIdCache.get(name);
  if (cached) return cached;

  const record = await prisma.module.upsert({
    where: { name },
    update: { latestVersion: version },
    create: { name, type, latestVersion: version },
  });
  moduleIdCache.set(name, record.id);
  return record.id;
}

export async function ensureGuild(guildId: string, name: string, ownerId: string) {
  await prisma.guild.upsert({
    where: { id: guildId },
    update: { name },
    create: { id: guildId, name, ownerId },
  });
}

export async function getEnabledModulesForGuild(guildId: string): Promise<string[]> {
  const rows = await prisma.guildModuleConfig.findMany({
    where: { guildId, enabled: true },
    include: { module: true },
  });
  return rows.map((r) => r.module.name);
}

export async function isModuleEnabledInDb(guildId: string, moduleName: string): Promise<boolean> {
  const moduleId = await ensureModuleRecord(moduleName, "module", "0.0.0");
  const row = await prisma.guildModuleConfig.findUnique({
    where: { guildId_moduleId: { guildId, moduleId } },
  });
  return row?.enabled ?? false;
}

export async function setModuleEnabledInDb(
  guildId: string,
  moduleName: string,
  version: string,
  enabled: boolean
) {
  const moduleId = await ensureModuleRecord(moduleName, "module", version);
  await prisma.guildModuleConfig.upsert({
    where: { guildId_moduleId: { guildId, moduleId } },
    update: { enabled, version },
    create: { guildId, moduleId, enabled, version, config: {} },
  });
}

export async function getModuleConfig(guildId: string, moduleName: string): Promise<Record<string, unknown>> {
  const moduleId = await ensureModuleRecord(moduleName, "module", "0.0.0");
  const row = await prisma.guildModuleConfig.findUnique({
    where: { guildId_moduleId: { guildId, moduleId } },
  });
  return (row?.config as Record<string, unknown>) ?? {};
}

export async function setModuleConfig(guildId: string, moduleName: string, config: Record<string, unknown>) {
  const moduleId = await ensureModuleRecord(moduleName, "module", "0.0.0");
  const existing = await prisma.guildModuleConfig.findUnique({
    where: { guildId_moduleId: { guildId, moduleId } },
  });
  const merged = { ...(existing?.config as Record<string, unknown> | undefined), ...config };
  await prisma.guildModuleConfig.upsert({
    where: { guildId_moduleId: { guildId, moduleId } },
    update: { config: merged },
    create: { guildId, moduleId, enabled: false, version: "0.0.0", config: merged },
  });
}

/** Namespaced key-value storage — a module can never read another module's keys. */
export async function getModuleData(guildId: string, moduleName: string, key: string): Promise<unknown> {
  const row = await prisma.moduleData.findUnique({
    where: { guildId_moduleName_key: { guildId, moduleName, key } },
  });
  return row?.value;
}

export async function setModuleData(guildId: string, moduleName: string, key: string, value: unknown) {
  await prisma.moduleData.upsert({
    where: { guildId_moduleName_key: { guildId, moduleName, key } },
    update: { value: value as any },
    create: { guildId, moduleName, key, value: value as any },
  });
}

export async function deleteModuleData(guildId: string, moduleName: string, key: string) {
  await prisma.moduleData.deleteMany({ where: { guildId, moduleName, key } });
}
