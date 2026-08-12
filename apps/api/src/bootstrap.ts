import { CONTRACT_VERSION } from "@courseforge/contracts";
import type { CourseForgeRepository } from "./repositories.js";
import { hashPassword } from "./security.js";

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
