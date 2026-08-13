import { CONTRACT_VERSION } from "@courseforge/contracts";
import type { PromptVersionV1 } from "@courseforge/contracts";
import type { CourseForgeRepository } from "./repositories.js";
import { hashPassword } from "./security.js";
import { initializeMissingPrompts } from "./prompt-catalog.js";

/** Actor id used for platform-initiated writes that have no logged-in user context. */
export const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

export const bootstrapAdministrator = async (
  repository: CourseForgeRepository,
  email: string,
  password: string
): Promise<void> => {
  const normalizedEmail = email.trim().toLowerCase();
  if (password.length < 12) throw new Error("BOOTSTRAP_ADMIN_PASSWORD must contain at least 12 characters");
  const existing = await repository.findUserByEmail(normalizedEmail);
  if (!existing) {
    await repository.saveUser({
      schemaVersion: CONTRACT_VERSION,
      userId: crypto.randomUUID(),
      email: normalizedEmail,
      displayName: "Platform Administrator",
      role: "platform_admin",
      passwordHash: await hashPassword(password),
      disabled: false
    });
  }
  const effective = await repository.findUserByEmail(normalizedEmail);
  if (!effective || effective.role !== "platform_admin") {
    throw new Error("BOOTSTRAP_ADMIN_EMAIL is already assigned to a non-administrator account");
  }
};

/**
 * Creates draft versions for every editable business prompt that has no
 * version of any status in the store. Idempotent by design: keys that already
 * have a version (draft, published or inactive) are never overwritten and
 * nothing is auto-published, preserving the immutable governance lifecycle.
 * Returns the prompts created by this call.
 */
export const bootstrapMissingPromptDrafts = async (
  repository: CourseForgeRepository,
  actorId: string,
  version: string
): Promise<PromptVersionV1[]> => initializeMissingPrompts(repository, actorId, version);
