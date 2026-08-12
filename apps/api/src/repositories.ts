import type { AuditEventV1, ProjectV1, SessionUserV1, UserRole } from "@courseforge/contracts";
import type { ArtifactMetadataRecord } from "./artifacts.js";

export interface StoredUser extends SessionUserV1 {
  passwordHash: string;
  disabled: boolean;
}

export interface StoredSession {
  sessionId: string;
  tokenHash: string;
  userId: string;
  expiresAt: string;
}

export interface CourseForgeRepository {
  readonly persistenceBackend: "in-memory" | "postgres";
  checkReadiness(): Promise<void>;
  findUserByEmail(email: string): Promise<StoredUser | undefined>;
  findUserById(userId: string): Promise<StoredUser | undefined>;
  saveUser(user: StoredUser): Promise<void>;
  saveSession(session: StoredSession): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<StoredSession | undefined>;
  deleteSessionByTokenHash(tokenHash: string): Promise<void>;
  deleteExpiredSessions(now: string): Promise<void>;
  saveProject(project: ProjectV1): Promise<void>;
  findProject(projectId: string): Promise<ProjectV1 | undefined>;
  listProjectsForUser(userId: string, includeAll: boolean): Promise<ProjectV1[]>;
  grantProjectAccess(projectId: string, userId: string): Promise<void>;
  hasProjectAccess(projectId: string, userId: string): Promise<boolean>;
  bindJob(jobId: string, projectId: string): Promise<void>;
  findJobProject(jobId: string): Promise<string | undefined>;
  saveArtifactMetadata(metadata: ArtifactMetadataRecord): Promise<void>;
  findArtifactMetadata(artifactId: string): Promise<ArtifactMetadataRecord | undefined>;
  listArtifactMetadata(projectId: string): Promise<ArtifactMetadataRecord[]>;
  appendAudit(event: AuditEventV1): Promise<void>;
  listAudits(resourceId?: string): Promise<AuditEventV1[]>;
}

/** Test/alpha implementation. Production must replace this with a durable adapter. */
export class InMemoryCourseForgeRepository implements CourseForgeRepository {
  readonly persistenceBackend = "in-memory" as const;
  private readonly users = new Map<string, StoredUser>();
  private readonly usersByEmail = new Map<string, string>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly projects = new Map<string, ProjectV1>();
  private readonly projectMembers = new Map<string, Set<string>>();
  private readonly jobProjects = new Map<string, string>();
  private readonly artifacts = new Map<string, ArtifactMetadataRecord>();
  private readonly audits: AuditEventV1[] = [];

  async checkReadiness() { return; }

  async findUserByEmail(email: string) { const id = this.usersByEmail.get(email.toLowerCase()); return id ? this.users.get(id) : undefined; }
  async findUserById(userId: string) { return this.users.get(userId); }
  async saveUser(user: StoredUser) { this.users.set(user.userId, user); this.usersByEmail.set(user.email.toLowerCase(), user.userId); }
  async saveSession(session: StoredSession) { this.sessions.set(session.tokenHash, session); }
  async findSessionByTokenHash(tokenHash: string) { return this.sessions.get(tokenHash); }
  async deleteSessionByTokenHash(tokenHash: string) { this.sessions.delete(tokenHash); }
  async deleteExpiredSessions(now: string) { for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key); }
  async saveProject(project: ProjectV1) { this.projects.set(project.projectId, project); }
  async findProject(projectId: string) { return this.projects.get(projectId); }
  async listProjectsForUser(userId: string, includeAll: boolean) {
    return [...this.projects.values()]
      .filter((project) => includeAll || (this.projectMembers.get(project.projectId)?.has(userId) ?? false))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  async grantProjectAccess(projectId: string, userId: string) {
    const members = this.projectMembers.get(projectId) ?? new Set<string>();
    members.add(userId); this.projectMembers.set(projectId, members);
  }
  async hasProjectAccess(projectId: string, userId: string) { return this.projectMembers.get(projectId)?.has(userId) ?? false; }
  async bindJob(jobId: string, projectId: string) { this.jobProjects.set(jobId, projectId); }
  async findJobProject(jobId: string) { return this.jobProjects.get(jobId); }
  async saveArtifactMetadata(metadata: ArtifactMetadataRecord) {
    const existing = this.artifacts.get(metadata.artifactId);
    if (!existing) this.artifacts.set(metadata.artifactId, structuredClone(metadata));
  }
  async findArtifactMetadata(artifactId: string) { const value = this.artifacts.get(artifactId); return value ? structuredClone(value) : undefined; }
  async listArtifactMetadata(projectId: string) {
    return [...this.artifacts.values()].filter((item) => item.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.artifactId.localeCompare(right.artifactId))
      .map((item) => structuredClone(item));
  }
  async appendAudit(event: AuditEventV1) { this.audits.push(event); }
  async listAudits(resourceId?: string) {
    return resourceId
      ? this.audits.filter((event) => event.resourceId === resourceId || event.metadata.projectId === resourceId)
      : [...this.audits];
  }
}

export const canCreateProjects = (role: UserRole): boolean => role === "platform_admin" || role === "course_editor";
export const canStartGeneration = canCreateProjects;
