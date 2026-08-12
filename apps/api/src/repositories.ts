import type {
  AnySourceRevision, AuditEventV1, ManagedUserV1, ProjectV1, PromptVersionV1, ProviderConfigVersionV1,
  RuntimeConfigSnapshotRecordV1, SessionUserV1, SourceArtifactV1, UserRole, QaPolicyVersionV1
  , PublishedCourseV1, PublicationWithdrawalV1, ArtifactTombstoneV1, ArtifactGcPlanV1
} from "@courseforge/contracts";
import type { ArtifactMetadataRecord } from "./artifacts.js";

export interface StoredUser extends SessionUserV1 {
  passwordHash: string;
  disabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
export interface UserPageQuery { page: number; pageSize: number }
export interface AuditPageQuery extends UserPageQuery {
  resourceId?: string; action?: string; outcome?: "success" | "failure"; actorId?: string; from?: string; to?: string;
}

export interface StoredSession {
  sessionId: string;
  tokenHash: string;
  userId: string;
  expiresAt: string;
}

export interface ImportedSourceRecord {
  artifact: SourceArtifactV1;
  revision: AnySourceRevision;
  normalizedText: string;
}

export interface CourseForgeRepository {
  readonly persistenceBackend: "in-memory" | "postgres";
  checkReadiness(): Promise<void>;
  findUserByEmail(email: string): Promise<StoredUser | undefined>;
  findUserById(userId: string): Promise<StoredUser | undefined>;
  saveUser(user: StoredUser): Promise<void>;
  createUser(user: StoredUser): Promise<boolean>;
  listUsers(query: UserPageQuery): Promise<Page<ManagedUserV1>>;
  countEnabledAdministrators(): Promise<number>;
  updateUser(user: StoredUser): Promise<void>;
  saveSession(session: StoredSession): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<StoredSession | undefined>;
  deleteSessionByTokenHash(tokenHash: string): Promise<void>;
  deleteSessionsForUser(userId: string): Promise<void>;
  deleteExpiredSessions(now: string): Promise<void>;
  saveProject(project: ProjectV1): Promise<void>;
  findProject(projectId: string): Promise<ProjectV1 | undefined>;
  listProjectsForUser(userId: string, includeAll: boolean): Promise<ProjectV1[]>;
  grantProjectAccess(projectId: string, userId: string): Promise<void>;
  hasProjectAccess(projectId: string, userId: string): Promise<boolean>;
  bindJob(jobId: string, projectId: string): Promise<void>;
  findJobProject(jobId: string): Promise<string | undefined>;
  saveArtifactMetadata(metadata: ArtifactMetadataRecord): Promise<void>;
  saveArtifactMetadataBatch(metadata: readonly ArtifactMetadataRecord[]): Promise<void>;
  findArtifactMetadata(artifactId: string): Promise<ArtifactMetadataRecord | undefined>;
  listArtifactMetadata(projectId: string): Promise<ArtifactMetadataRecord[]>;
  createPublication(course: PublishedCourseV1, artifactId: string): Promise<boolean>;
  findPublicationByQa(projectId: string, qaReportArtifactId: string): Promise<PublishedCourseV1 | undefined>;
  listPublications(projectId: string): Promise<PublishedCourseV1[]>;
  findPublication(projectId: string, publishedCourseId: string): Promise<PublishedCourseV1 | undefined>;
  savePublicationWithdrawal(withdrawal: PublicationWithdrawalV1): Promise<boolean>;
  findPublicationWithdrawal(projectId: string, publishedCourseId: string): Promise<PublicationWithdrawalV1 | undefined>;
  saveArtifactTombstone(tombstone: ArtifactTombstoneV1): Promise<boolean>;
  findArtifactTombstone(projectId: string, artifactId: string): Promise<ArtifactTombstoneV1 | undefined>;
  listArtifactTombstones(projectId?: string): Promise<ArtifactTombstoneV1[]>;
  restoreArtifactTombstone(projectId: string, artifactId: string, restoredAt: string, restoredBy: string): Promise<boolean>;
  markArtifactPurged(artifactId: string, purgedAt: string, purgedBy: string): Promise<boolean>;
  saveArtifactGcPlan(plan: ArtifactGcPlanV1): Promise<boolean>;
  findArtifactGcPlan(planId: string): Promise<ArtifactGcPlanV1 | undefined>;
  markArtifactGcPlanExecuted(planId: string, executedAt: string, executedBy: string): Promise<boolean>;
  saveImportedSource(input: ImportedSourceRecord): Promise<void>;
  saveImportedSourceAndBind(input: ImportedSourceRecord, project: ProjectV1): Promise<void>;
  listSourceRevisions(projectId: string): Promise<AnySourceRevision[]>;
  findSourceRevision(projectId: string, sourceRevisionId: string): Promise<AnySourceRevision | undefined>;
  findImportedSource(projectId: string, sourceRevisionId: string): Promise<ImportedSourceRecord | undefined>;
  createProviderConfig(config: ProviderConfigVersionV1): Promise<boolean>;
  listProviderConfigs(): Promise<ProviderConfigVersionV1[]>;
  findProviderConfig(configId: string): Promise<ProviderConfigVersionV1 | undefined>;
  publishProviderConfig(configId: string, occurredAt: string): Promise<ProviderConfigVersionV1 | undefined>;
  deactivateProviderConfig(configId: string, occurredAt: string): Promise<ProviderConfigVersionV1 | undefined>;
  createPromptVersion(prompt: PromptVersionV1): Promise<boolean>;
  listPromptVersions(): Promise<PromptVersionV1[]>;
  findPromptVersion(promptVersionId: string): Promise<PromptVersionV1 | undefined>;
  publishPromptVersion(promptVersionId: string, occurredAt: string): Promise<PromptVersionV1 | undefined>;
  deactivatePromptVersion(promptVersionId: string, occurredAt: string): Promise<PromptVersionV1 | undefined>;
  createQaPolicyVersion(policy: QaPolicyVersionV1): Promise<boolean>;
  listQaPolicyVersions(): Promise<QaPolicyVersionV1[]>;
  findQaPolicyVersion(qaPolicyId: string): Promise<QaPolicyVersionV1 | undefined>;
  publishQaPolicyVersion(qaPolicyId: string, occurredAt: string): Promise<QaPolicyVersionV1 | undefined>;
  deactivateQaPolicyVersion(qaPolicyId: string, occurredAt: string): Promise<QaPolicyVersionV1 | undefined>;
  captureRuntimeConfigSnapshot(snapshotId: string, capturedAt: string, capturedBy: string): Promise<RuntimeConfigSnapshotRecordV1>;
  findRuntimeConfigSnapshot(snapshotId: string): Promise<RuntimeConfigSnapshotRecordV1 | undefined>;
  listRuntimeConfigSnapshots(query: UserPageQuery): Promise<Page<RuntimeConfigSnapshotRecordV1>>;
  appendAudit(event: AuditEventV1): Promise<void>;
  listAudits(resourceId?: string): Promise<AuditEventV1[]>;
  queryAudits(query: AuditPageQuery): Promise<Page<AuditEventV1>>;
}

/** Development/test implementation. Production must use a durable adapter. */
export class InMemoryCourseForgeRepository implements CourseForgeRepository {
  readonly persistenceBackend = "in-memory" as const;
  private readonly users = new Map<string, StoredUser>();
  private readonly usersByEmail = new Map<string, string>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly projects = new Map<string, ProjectV1>();
  private readonly projectMembers = new Map<string, Set<string>>();
  private readonly jobProjects = new Map<string, string>();
  private readonly artifacts = new Map<string, ArtifactMetadataRecord>();
  private readonly publications = new Map<string, { course: PublishedCourseV1; artifactId: string }>();
  private readonly publicationWithdrawals = new Map<string, PublicationWithdrawalV1>();
  private readonly artifactTombstones = new Map<string, ArtifactTombstoneV1>();
  private readonly artifactGcPlans = new Map<string, ArtifactGcPlanV1>();
  private readonly importedSources = new Map<string, ImportedSourceRecord>();
  private readonly providerConfigs = new Map<string, ProviderConfigVersionV1>();
  private readonly promptVersions = new Map<string, PromptVersionV1>();
  private readonly qaPolicyVersions = new Map<string, QaPolicyVersionV1>();
  private readonly configSnapshots = new Map<string, RuntimeConfigSnapshotRecordV1>();
  private readonly audits: AuditEventV1[] = [];

  async checkReadiness() { return; }

  async findUserByEmail(email: string) { const id = this.usersByEmail.get(email.toLowerCase()); return id ? this.users.get(id) : undefined; }
  async findUserById(userId: string) { return this.users.get(userId); }
  async saveUser(user: StoredUser) { this.users.set(user.userId, user); this.usersByEmail.set(user.email.toLowerCase(), user.userId); }
  async createUser(user: StoredUser) {
    if (this.usersByEmail.has(user.email.toLowerCase()) || this.users.has(user.userId)) return false;
    await this.saveUser({ ...user, createdAt: user.createdAt ?? new Date().toISOString(), updatedAt: user.updatedAt ?? new Date().toISOString() }); return true;
  }
  async listUsers(query: UserPageQuery) {
    const values = [...this.users.values()].sort((a, b) => a.email.localeCompare(b.email));
    const items = values.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map(publicManagedUser);
    return { items, total: values.length, ...query };
  }
  async countEnabledAdministrators() { return [...this.users.values()].filter((user) => user.role === "platform_admin" && !user.disabled).length; }
  async updateUser(user: StoredUser) { await this.saveUser({ ...user, updatedAt: user.updatedAt ?? new Date().toISOString() }); }
  async saveSession(session: StoredSession) { this.sessions.set(session.tokenHash, session); }
  async findSessionByTokenHash(tokenHash: string) { return this.sessions.get(tokenHash); }
  async deleteSessionByTokenHash(tokenHash: string) { this.sessions.delete(tokenHash); }
  async deleteSessionsForUser(userId: string) { for (const [key, session] of this.sessions) if (session.userId === userId) this.sessions.delete(key); }
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
  async saveArtifactMetadataBatch(values: readonly ArtifactMetadataRecord[]) {
    const next = new Map(this.artifacts);
    for (const metadata of values) if (!next.has(metadata.artifactId)) next.set(metadata.artifactId, structuredClone(metadata));
    this.artifacts.clear();
    for (const [key, value] of next) this.artifacts.set(key, value);
  }
  async findArtifactMetadata(artifactId: string) { const value = this.artifacts.get(artifactId); return value ? structuredClone(value) : undefined; }
  async listArtifactMetadata(projectId: string) {
    return [...this.artifacts.values()].filter((item) => item.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.artifactId.localeCompare(right.artifactId))
      .map((item) => structuredClone(item));
  }
  async createPublication(course: PublishedCourseV1, artifactId: string) { const qaKey=`${course.projectId}:${course.qaReportArtifactId}`; if ([...this.publications.values()].some((item)=>`${item.course.projectId}:${item.course.qaReportArtifactId}`===qaKey || item.course.projectId===course.projectId&&item.course.revision===course.revision)) return false; this.publications.set(course.publishedCourseId,{course:structuredClone(course),artifactId}); return true; }
  async findPublicationByQa(projectId:string,qaReportArtifactId:string){const item=[...this.publications.values()].find((value)=>value.course.projectId===projectId&&value.course.qaReportArtifactId===qaReportArtifactId);return item?structuredClone(item.course):undefined;}
  async listPublications(projectId:string){return [...this.publications.values()].map((item)=>item.course).filter((course)=>course.projectId===projectId).sort((a,b)=>b.revision-a.revision).map((course)=>structuredClone(course));}
  async findPublication(projectId:string,publishedCourseId:string){const item=this.publications.get(publishedCourseId);return item?.course.projectId===projectId?structuredClone(item.course):undefined;}
  async savePublicationWithdrawal(value:PublicationWithdrawalV1){if(this.publicationWithdrawals.has(value.publishedCourseId))return false;this.publicationWithdrawals.set(value.publishedCourseId,structuredClone(value));return true;}
  async findPublicationWithdrawal(projectId:string,publishedCourseId:string){const value=this.publicationWithdrawals.get(publishedCourseId);return value?.projectId===projectId?structuredClone(value):undefined;}
  async saveArtifactTombstone(value:ArtifactTombstoneV1){const existing=this.artifactTombstones.get(value.artifactId);if(existing&&!existing.restoredAt)return false;this.artifactTombstones.set(value.artifactId,structuredClone(value));return true;}
  async findArtifactTombstone(projectId:string,artifactId:string){const value=this.artifactTombstones.get(artifactId);return value?.projectId===projectId?structuredClone(value):undefined;}
  async listArtifactTombstones(projectId?:string){return [...this.artifactTombstones.values()].filter((item)=>!projectId||item.projectId===projectId).map((item)=>structuredClone(item));}
  async restoreArtifactTombstone(projectId:string,artifactId:string,restoredAt:string,restoredBy:string){const value=this.artifactTombstones.get(artifactId);if(!value||value.projectId!==projectId||value.restoredAt||value.purgedAt)return false;this.artifactTombstones.set(artifactId,{...value,restoredAt,restoredBy});return true;}
  async markArtifactPurged(artifactId:string,purgedAt:string,purgedBy:string){const value=this.artifactTombstones.get(artifactId);if(!value||value.restoredAt||value.purgedAt)return false;this.artifactTombstones.set(artifactId,{...value,purgedAt,purgedBy});return true;}
  async saveArtifactGcPlan(value:ArtifactGcPlanV1){if(this.artifactGcPlans.has(value.planId))return false;this.artifactGcPlans.set(value.planId,structuredClone(value));return true;}
  async findArtifactGcPlan(planId:string){const value=this.artifactGcPlans.get(planId);return value?structuredClone(value):undefined;}
  async markArtifactGcPlanExecuted(planId:string,executedAt:string,executedBy:string){const value=this.artifactGcPlans.get(planId);if(!value||value.executedAt)return false;this.artifactGcPlans.set(planId,{...value,executedAt,executedBy});return true;}
  async saveImportedSource(input: ImportedSourceRecord) {
    if (this.importedSources.has(input.revision.sourceRevisionId)) return;
    this.importedSources.set(input.revision.sourceRevisionId, structuredClone(input));
  }
  async saveImportedSourceAndBind(input: ImportedSourceRecord, project: ProjectV1) {
    if (!this.importedSources.has(input.revision.sourceRevisionId)) this.importedSources.set(input.revision.sourceRevisionId, structuredClone(input));
    this.projects.set(project.projectId, structuredClone(project));
  }
  async listSourceRevisions(projectId: string) {
    return [...this.importedSources.values()].filter((item) => item.artifact.projectId === projectId)
      .sort((left, right) => right.revision.importedAt.localeCompare(left.revision.importedAt))
      .map((item) => structuredClone(item.revision));
  }
  async findSourceRevision(projectId: string, sourceRevisionId: string) {
    const item = this.importedSources.get(sourceRevisionId);
    return item?.artifact.projectId === projectId ? structuredClone(item.revision) : undefined;
  }
  async findImportedSource(projectId: string, sourceRevisionId: string) {
    const item = this.importedSources.get(sourceRevisionId);
    return item?.artifact.projectId === projectId ? structuredClone(item) : undefined;
  }
  async createProviderConfig(config: ProviderConfigVersionV1) {
    if ([...this.providerConfigs.values()].some((item) => item.kind === config.kind && item.providerId === config.providerId && item.version === config.version)) return false;
    this.providerConfigs.set(config.configId, structuredClone(config)); return true;
  }
  async listProviderConfigs() { return [...this.providerConfigs.values()].map((item) => structuredClone(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async findProviderConfig(configId: string) { const item = this.providerConfigs.get(configId); return item ? structuredClone(item) : undefined; }
  async publishProviderConfig(configId: string, occurredAt: string) {
    const target = this.providerConfigs.get(configId); if (!target || target.status !== "draft") return undefined;
    for (const [id, item] of this.providerConfigs) if (item.kind === target.kind && item.status === "published") this.providerConfigs.set(id, { ...item, status: "inactive", inactiveAt: occurredAt });
    const published = { ...target, status: "published" as const, publishedAt: occurredAt };
    this.providerConfigs.set(configId, published); return structuredClone(published);
  }
  async deactivateProviderConfig(configId: string, occurredAt: string) {
    const target = this.providerConfigs.get(configId); if (!target || target.status !== "published") return undefined;
    const inactive = { ...target, status: "inactive" as const, inactiveAt: occurredAt };
    this.providerConfigs.set(configId, inactive); return structuredClone(inactive);
  }
  async createPromptVersion(prompt: PromptVersionV1) {
    if ([...this.promptVersions.values()].some((item) => item.promptKey === prompt.promptKey && item.version === prompt.version)) return false;
    this.promptVersions.set(prompt.promptVersionId, structuredClone(prompt)); return true;
  }
  async listPromptVersions() { return [...this.promptVersions.values()].map((item) => structuredClone(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  async findPromptVersion(id: string) { const item = this.promptVersions.get(id); return item ? structuredClone(item) : undefined; }
  async publishPromptVersion(id: string, occurredAt: string) {
    const target = this.promptVersions.get(id); if (!target || target.status !== "draft") return undefined;
    for (const [key, item] of this.promptVersions) if (item.promptKey === target.promptKey && item.status === "published") this.promptVersions.set(key, { ...item, status: "inactive", inactiveAt: occurredAt });
    const published = { ...target, status: "published" as const, publishedAt: occurredAt };
    this.promptVersions.set(id, published); return structuredClone(published);
  }
  async deactivatePromptVersion(id: string, occurredAt: string) {
    const target = this.promptVersions.get(id); if (!target || target.status !== "published") return undefined;
    const inactive = { ...target, status: "inactive" as const, inactiveAt: occurredAt };
    this.promptVersions.set(id, inactive); return structuredClone(inactive);
  }
  async createQaPolicyVersion(policy: QaPolicyVersionV1) { if ([...this.qaPolicyVersions.values()].some((item) => item.name === policy.name && item.version === policy.version)) return false; this.qaPolicyVersions.set(policy.qaPolicyId, structuredClone(policy)); return true; }
  async listQaPolicyVersions() { return [...this.qaPolicyVersions.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map((item)=>structuredClone(item)); }
  async findQaPolicyVersion(id: string) { const item=this.qaPolicyVersions.get(id); return item?structuredClone(item):undefined; }
  async publishQaPolicyVersion(id: string, occurredAt: string) { const target=this.qaPolicyVersions.get(id); if(!target||target.status!=="draft")return undefined; for(const [key,item] of this.qaPolicyVersions)if(item.status==="published")this.qaPolicyVersions.set(key,{...item,status:"inactive",inactiveAt:occurredAt});const published={...target,status:"published" as const,publishedAt:occurredAt};this.qaPolicyVersions.set(id,published);return structuredClone(published); }
  async deactivateQaPolicyVersion(id: string, occurredAt: string) { const target=this.qaPolicyVersions.get(id);if(!target||target.status!=="published")return undefined;const inactive={...target,status:"inactive" as const,inactiveAt:occurredAt};this.qaPolicyVersions.set(id,inactive);return structuredClone(inactive); }
  async captureRuntimeConfigSnapshot(snapshotId: string, capturedAt: string, capturedBy: string) {
    const qaPolicy=[...this.qaPolicyVersions.values()].filter((item)=>item.status==="published").sort((a,b)=>(b.publishedAt??b.createdAt).localeCompare(a.publishedAt??a.createdAt))[0];
    const snapshot: RuntimeConfigSnapshotRecordV1 = {
      schemaVersion: "1", snapshotId, capturedAt, capturedBy,
      providerBindings: [...this.providerConfigs.values()].filter((item) => item.status === "published").map((item) => ({ kind: item.kind, configId: item.configId, providerId: item.providerId, version: item.version })),
      promptBindings: [...this.promptVersions.values()].filter((item) => item.status === "published").map((item) => ({ promptKey: item.promptKey, promptVersionId: item.promptVersionId, version: item.version })), pronunciationLexiconBinding:null,
      qaPolicyBinding:qaPolicy?{qaPolicyId:qaPolicy.qaPolicyId,version:qaPolicy.version,contentHash:qaPolicy.contentHash}:null
    };
    this.configSnapshots.set(snapshotId, structuredClone(snapshot)); return snapshot;
  }
  async findRuntimeConfigSnapshot(snapshotId: string) { const item = this.configSnapshots.get(snapshotId); return item ? structuredClone(item) : undefined; }
  async listRuntimeConfigSnapshots(query: UserPageQuery) { const values=[...this.configSnapshots.values()].sort((a,b)=>b.capturedAt.localeCompare(a.capturedAt)||b.snapshotId.localeCompare(a.snapshotId));return{items:values.slice((query.page-1)*query.pageSize,query.page*query.pageSize).map(item=>structuredClone(item)),total:values.length,page:query.page,pageSize:query.pageSize}; }
  async appendAudit(event: AuditEventV1) { this.audits.push(event); }
  async listAudits(resourceId?: string) { return (resourceId ? this.audits.filter((event) => event.resourceId === resourceId || event.metadata.projectId === resourceId) : [...this.audits]).map((item) => structuredClone(item)); }
  async queryAudits(query: AuditPageQuery) {
    const filtered = this.audits.filter((event) =>
      (!query.resourceId || event.resourceId === query.resourceId || event.metadata.projectId === query.resourceId) &&
      (!query.action || event.action === query.action) && (!query.outcome || event.outcome === query.outcome) &&
      (!query.actorId || event.actorId === query.actorId) && (!query.from || Date.parse(event.occurredAt) >= Date.parse(query.from)) && (!query.to || Date.parse(event.occurredAt) <= Date.parse(query.to)))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.auditId.localeCompare(b.auditId));
    return { items: filtered.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map((item) => structuredClone(item)), total: filtered.length, page: query.page, pageSize: query.pageSize };
  }
}

const publicManagedUser = (user: StoredUser): ManagedUserV1 => ({
  schemaVersion: "1", userId: user.userId, email: user.email, displayName: user.displayName, role: user.role,
  disabled: user.disabled, createdAt: user.createdAt ?? "1970-01-01T00:00:00.000Z", updatedAt: user.updatedAt ?? user.createdAt ?? "1970-01-01T00:00:00.000Z"
});

export const canCreateProjects = (role: UserRole): boolean => role === "platform_admin" || role === "course_editor";
export const canStartGeneration = canCreateProjects;
