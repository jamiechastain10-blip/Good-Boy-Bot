/**
 * Basic Ghost Labs - Project Eclipse
 * Copyright (c) 2026 Basic Ghost Labs. All rights reserved.
 *
 * Adding a module to the beta means adding it here and redeploying.
 * The dynamic marketplace-style install flow is a later phase — this
 * registry exists so the lifecycle (enable/disable/update) underneath
 * it is still real and testable now.
 */
import testModule from "../../../modules/test-module/src/index";
import moderation from "../../../modules/moderation/src/index";
import memberManagement from "../../../modules/member-management/src/index";
import roles from "../../../modules/roles/src/index";
import { AnyManifest } from "@platform/module-sdk";

export const modules: AnyManifest[] = [testModule, moderation, memberManagement, roles];
