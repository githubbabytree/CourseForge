import {
  AuditEventV1Schema,
  AnySourceRevisionSchema,
  PromptVersionV1Schema,
  ProjectV1Schema,
  ProviderConfigVersionV1Schema,
  RuntimeConfigSnapshotRecordV1Schema,
  ManagedUserV1Schema,
  PublishedCourseV1Schema,
  PublicationWithdrawalV1Schema,
  ArtifactTombstoneV1Schema,
  ArtifactGcPlanV1Schema,
  SessionUserV1Schema,
  SourceRevisionV1Schema,
  QaPolicyVersionV1Schema,
  type AnySourceRevision,
  type AuditEventV1,
  type PromptVersionV1,
  type ProjectV1,
  type ProviderConfigVersionV1,
  type RuntimeConfigSnapshotRecordV1,
  type ManagedUserV1,
  type PublishedCourseV1,
  type PublicationWithdrawalV1,
  type ArtifactTombstoneV1,
  type ArtifactGcPlanV1,
  type UserRole
  , type QaPolicyVersionV1
} from "@courseforge/contracts";
import type { AuditPageQuery, CourseForgeRepository, ImportedSourceRecord, Page, StoredSession, StoredUser, UserPageQuery } from "./repositories.js";
import type { ArtifactKind, ArtifactMediaType, ArtifactMetadataRecord } from "./artifacts.js";

export interface SqlQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}
export interface SqlTransactionRunner {
  run<T>(operation: (client: SqlQueryClient) => Promise<T>): Promise<T>;
}

/** Narrow query port so repository tests never require a live PostgreSQL server. */
export interface SqlQueryClient {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>>;
}

type UserRow = {
  user_id: string;
  email: string;
  display_name: string;
  role: UserRole;
  password_hash: string;
  disabled: boolean;
  created_at?: Date | string;
  updated_at?: Date | string;
};

type SessionRow = { session_id: string; token_hash: string; user_id: string; expires_at: Date | string };
type ProjectRow = { document: unknown };
type JobRow = { project_id: string };
type BooleanRow = { allowed: boolean };
const isoNullable=(value:Date|string|null):string|null=>value instanceof Date?value.toISOString():value;
type AuditRow = {
  audit_id: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  outcome: "success" | "failure";
  occurred_at: Date | string;
  request_id: string;
  metadata: Record<string, string | number | boolean | null>;
};
type ArtifactRow = {
  artifact_id: string;
  project_id: string;
  job_id: string;
  revision: number;
  configuration_version: string;
  provider_id: string;
  kind: ArtifactKind;
  media_type: ArtifactMediaType;
  content_hash: string;
  byte_length: number;
  source_artifact_ids: string[];
  created_at: Date | string;
};
type SourceRevisionRow = { document: unknown; imported_at: Date | string };
type ProviderConfigRow = {
  config_id: string; kind: ProviderConfigVersionV1["kind"]; provider_id: string; version: string;
  display_name: string; endpoint: string | null; model: string | null; capabilities: string[];
  settings: ProviderConfigVersionV1["settings"]; secret_refs: ProviderConfigVersionV1["secretRefs"];
  status: ProviderConfigVersionV1["status"]; created_at: Date | string; created_by: string;
  published_at: Date | string | null; inactive_at: Date | string | null;
};
type PromptVersionRow = {
  prompt_version_id: string; prompt_key: string; version: string; description: string; template: string;
  status: PromptVersionV1["status"]; created_at: Date | string; created_by: string;
  published_at: Date | string | null; inactive_at: Date | string | null;
};
type SnapshotRow = { snapshot_id: string; captured_at: Date | string; captured_by: string; provider_bindings: unknown; prompt_bindings: unknown; lexicon_document?: Record<string,unknown>|null; qa_policy_document?: unknown };
type QaPolicyRow = { document: unknown };

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const mapUser = (row: UserRow): StoredUser => ({
  ...SessionUserV1Schema.parse({
    schemaVersion: "1", userId: row.user_id, email: row.email,
    displayName: row.display_name, role: row.role
  }),
  passwordHash: row.password_hash,
  disabled: row.disabled,
  createdAt: row.created_at ? iso(row.created_at) : undefined, updatedAt: row.updated_at ? iso(row.updated_at) : undefined
});

const mapManagedUser = (row: UserRow): ManagedUserV1 => ManagedUserV1Schema.parse({
  schemaVersion: "1", userId: row.user_id, email: row.email, displayName: row.display_name, role: row.role,
  disabled: row.disabled, createdAt: iso(row.created_at ?? "1970-01-01T00:00:00.000Z"), updatedAt: iso(row.updated_at ?? row.created_at ?? "1970-01-01T00:00:00.000Z")
});

const mapSession = (row: SessionRow): StoredSession => ({
  sessionId: row.session_id,
  tokenHash: row.token_hash,
  userId: row.user_id,
  expiresAt: iso(row.expires_at)
});

const mapAudit = (row: AuditRow): AuditEventV1 => AuditEventV1Schema.parse({
  schemaVersion: "1", auditId: row.audit_id, actorId: row.actor_id,
  action: row.action, resourceType: row.resource_type, resourceId: row.resource_id,
  outcome: row.outcome, occurredAt: iso(row.occurred_at), requestId: row.request_id,
  metadata: row.metadata
});

const mapArtifact = (row: ArtifactRow): ArtifactMetadataRecord => ({
  artifactId: row.artifact_id, projectId: row.project_id, jobId: row.job_id,
  revision: row.revision, configurationVersion: row.configuration_version,
  providerId: row.provider_id, kind: row.kind, mediaType: row.media_type,
  contentHash: row.content_hash, byteLength: row.byte_length,
  sourceArtifactIds: [...row.source_artifact_ids], createdAt: iso(row.created_at)
});

const nullableIso = (value: Date | string | null): string | null => value === null ? null : iso(value);
const mapProviderConfig = (row: ProviderConfigRow): ProviderConfigVersionV1 => ProviderConfigVersionV1Schema.parse({
  schemaVersion: "1", configId: row.config_id, kind: row.kind, providerId: row.provider_id,
  version: row.version, displayName: row.display_name, endpoint: row.endpoint ?? undefined,
  model: row.model ?? undefined, capabilities: row.capabilities, settings: row.settings, secretRefs: row.secret_refs,
  status: row.status, createdAt: iso(row.created_at), createdBy: row.created_by,
  publishedAt: nullableIso(row.published_at), inactiveAt: nullableIso(row.inactive_at)
});
const mapPromptVersion = (row: PromptVersionRow): PromptVersionV1 => PromptVersionV1Schema.parse({
  schemaVersion: "1", promptVersionId: row.prompt_version_id, promptKey: row.prompt_key,
  version: row.version, description: row.description, template: row.template, status: row.status,
  createdAt: iso(row.created_at), createdBy: row.created_by,
  publishedAt: nullableIso(row.published_at), inactiveAt: nullableIso(row.inactive_at)
});
const mapSnapshot = (row: SnapshotRow): RuntimeConfigSnapshotRecordV1 => RuntimeConfigSnapshotRecordV1Schema.parse({
  schemaVersion: "1", snapshotId: row.snapshot_id, capturedAt: iso(row.captured_at), capturedBy: row.captured_by,
  providerBindings: row.provider_bindings, promptBindings: row.prompt_bindings, pronunciationLexiconBinding:row.lexicon_document?{lexiconId:row.lexicon_document.lexiconId,name:row.lexicon_document.name,version:row.lexicon_document.version,contentHash:row.lexicon_document.contentHash}:null,
  qaPolicyBinding:row.qa_policy_document?{qaPolicyId:(row.qa_policy_document as Record<string,unknown>).qaPolicyId,version:(row.qa_policy_document as Record<string,unknown>).version,contentHash:(row.qa_policy_document as Record<string,unknown>).contentHash}:null
});
const mapSourceRevision = (row: SourceRevisionRow): AnySourceRevision => AnySourceRevisionSchema.parse({
  ...(row.document as Record<string, unknown>),
  importedAt: iso(row.imported_at)
});

const PROVIDER_COLUMNS = `config_id, kind, provider_id, version, display_name, endpoint, model, capabilities,
  settings, secret_refs, status, created_at, created_by, published_at, inactive_at`;
const PROMPT_COLUMNS = `prompt_version_id, prompt_key, version, description, template, status, created_at,
  created_by, published_at, inactive_at`;
const SOURCE_DOCUMENT_SQL = `COALESCE(sr.revision_document, jsonb_build_object(
  'schemaVersion','1','sourceRevisionId',sr.source_revision_id,'sourceArtifactId',sr.source_artifact_id,
  'revision',sr.revision,'filename',sr.filename,'mediaType',sr.media_type,'byteSize',sr.byte_size,
  'contentSha256',sr.content_sha256,'extractionMethod',sr.extraction_method,'sections',sr.sections))`;

export class PostgresCourseForgeRepository implements CourseForgeRepository {
  readonly persistenceBackend = "postgres" as const;

  constructor(private readonly client: SqlQueryClient, private readonly transactions?: SqlTransactionRunner) {}

  async checkReadiness(): Promise<void> { await this.client.query("SELECT 1 AS ready"); }

  async findUserByEmail(email: string): Promise<StoredUser | undefined> {
    const result = await this.client.query<UserRow>(
      "SELECT user_id, email, display_name, role, password_hash, disabled, created_at, updated_at FROM users WHERE email = $1",
      [email.trim().toLowerCase()]
    );
    return result.rows[0] ? mapUser(result.rows[0]) : undefined;
  }

  async findUserById(userId: string): Promise<StoredUser | undefined> {
    const result = await this.client.query<UserRow>(
      "SELECT user_id, email, display_name, role, password_hash, disabled, created_at, updated_at FROM users WHERE user_id = $1",
      [userId]
    );
    return result.rows[0] ? mapUser(result.rows[0]) : undefined;
  }

  async saveUser(user: StoredUser): Promise<void> {
    await this.client.query(
      `INSERT INTO users (user_id, email, display_name, role, password_hash, disabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         role = EXCLUDED.role,
         password_hash = EXCLUDED.password_hash,
         disabled = EXCLUDED.disabled`,
      [user.userId, user.email.trim().toLowerCase(), user.displayName, user.role, user.passwordHash, user.disabled]
    );
  }

  async createUser(user: StoredUser): Promise<boolean> {
    const result = await this.client.query(
      `INSERT INTO users (user_id, email, display_name, role, password_hash, disabled, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (email) DO NOTHING`,
      [user.userId, user.email.trim().toLowerCase(), user.displayName, user.role, user.passwordHash, user.disabled, user.createdAt ?? new Date().toISOString()]);
    return (result.rowCount ?? 0) > 0;
  }

  async listUsers(query: UserPageQuery): Promise<Page<ManagedUserV1>> {
    const offset = (query.page - 1) * query.pageSize;
    const [rows, count] = await Promise.all([
      this.client.query<UserRow>(`SELECT user_id,email,display_name,role,password_hash,disabled,created_at,updated_at
        FROM users ORDER BY email ASC, user_id ASC LIMIT $1 OFFSET $2`, [query.pageSize, offset]),
      this.client.query<{ total: number | string }>("SELECT count(*) AS total FROM users")
    ]);
    return { items: rows.rows.map(mapManagedUser), total: Number(count.rows[0]?.total ?? 0), page: query.page, pageSize: query.pageSize };
  }

  async countEnabledAdministrators(): Promise<number> {
    const result = await this.client.query<{ total: number | string }>("SELECT count(*) AS total FROM users WHERE role='platform_admin' AND disabled=false");
    return Number(result.rows[0]?.total ?? 0);
  }

  async updateUser(user: StoredUser): Promise<void> {
    await this.client.query(`UPDATE users SET display_name=$2,role=$3,password_hash=$4,disabled=$5,updated_at=$6 WHERE user_id=$1`,
      [user.userId, user.displayName, user.role, user.passwordHash, user.disabled, user.updatedAt ?? new Date().toISOString()]);
  }

  async saveSession(session: StoredSession): Promise<void> {
    await this.client.query(
      `INSERT INTO sessions (session_id, token_hash, user_id, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token_hash) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at`,
      [session.sessionId, session.tokenHash, session.userId, session.expiresAt]
    );
  }

  async findSessionByTokenHash(tokenHash: string): Promise<StoredSession | undefined> {
    const result = await this.client.query<SessionRow>(
      "SELECT session_id, token_hash, user_id, expires_at FROM sessions WHERE token_hash = $1",
      [tokenHash]
    );
    return result.rows[0] ? mapSession(result.rows[0]) : undefined;
  }

  async deleteSessionByTokenHash(tokenHash: string): Promise<void> {
    await this.client.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
  }

  async deleteSessionsForUser(userId: string): Promise<void> { await this.client.query("DELETE FROM sessions WHERE user_id = $1", [userId]); }

  async deleteExpiredSessions(now: string): Promise<void> {
    await this.client.query("DELETE FROM sessions WHERE expires_at <= $1", [now]);
  }

  async saveProject(project: ProjectV1): Promise<void> {
    await this.client.query(
      `INSERT INTO projects (project_id, owner_id, document, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (project_id) DO UPDATE
       SET owner_id = EXCLUDED.owner_id, document = EXCLUDED.document, updated_at = EXCLUDED.updated_at`,
      [project.projectId, project.ownerId, JSON.stringify(project), project.createdAt, project.updatedAt]
    );
  }

  async findProject(projectId: string): Promise<ProjectV1 | undefined> {
    const result = await this.client.query<ProjectRow>("SELECT document FROM projects WHERE project_id = $1", [projectId]);
    return result.rows[0] ? ProjectV1Schema.parse(result.rows[0].document) : undefined;
  }

  async listProjectsForUser(userId: string, includeAll: boolean): Promise<ProjectV1[]> {
    const result = includeAll
      ? await this.client.query<ProjectRow>("SELECT document FROM projects ORDER BY updated_at DESC")
      : await this.client.query<ProjectRow>(
          `SELECT p.document FROM projects p
           INNER JOIN project_members pm ON pm.project_id = p.project_id
           WHERE pm.user_id = $1
           ORDER BY p.updated_at DESC`,
          [userId]
        );
    return result.rows.map((row) => ProjectV1Schema.parse(row.document));
  }

  async grantProjectAccess(projectId: string, userId: string): Promise<void> {
    await this.client.query(
      "INSERT INTO project_members (project_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [projectId, userId]
    );
  }

  async hasProjectAccess(projectId: string, userId: string): Promise<boolean> {
    const result = await this.client.query<BooleanRow>(
      "SELECT EXISTS (SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2) AS allowed",
      [projectId, userId]
    );
    return result.rows[0]?.allowed ?? false;
  }

  async bindJob(jobId: string, projectId: string): Promise<void> {
    await this.client.query(
      `INSERT INTO job_projects (job_id, project_id) VALUES ($1, $2)
       ON CONFLICT (job_id) DO UPDATE SET project_id = EXCLUDED.project_id`,
      [jobId, projectId]
    );
  }

  async findJobProject(jobId: string): Promise<string | undefined> {
    const result = await this.client.query<JobRow>("SELECT project_id FROM job_projects WHERE job_id = $1", [jobId]);
    return result.rows[0]?.project_id;
  }

  async saveArtifactMetadata(metadata: ArtifactMetadataRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO artifacts
       (artifact_id, project_id, job_id, revision, configuration_version, provider_id, kind,
        media_type, content_hash, byte_length, source_artifact_ids, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (artifact_id) DO NOTHING`,
      [metadata.artifactId, metadata.projectId, metadata.jobId, metadata.revision,
       metadata.configurationVersion, metadata.providerId, metadata.kind, metadata.mediaType,
       metadata.contentHash, metadata.byteLength, [...metadata.sourceArtifactIds], metadata.createdAt]
    );
  }

  async saveArtifactMetadataBatch(values: readonly ArtifactMetadataRecord[]): Promise<void> {
    if (!this.transactions) throw new Error("PostgreSQL transaction runner is required for artifact metadata batches");
    await this.transactions.run(async (client) => {
      const repository = new PostgresCourseForgeRepository(client);
      for (const metadata of values) await repository.saveArtifactMetadata(metadata);
    });
  }

  async findArtifactMetadata(artifactId: string): Promise<ArtifactMetadataRecord | undefined> {
    const result = await this.client.query<ArtifactRow>(
      `SELECT artifact_id, project_id, job_id, revision, configuration_version, provider_id, kind,
              media_type, content_hash, byte_length, source_artifact_ids, created_at
       FROM artifacts WHERE artifact_id = $1`,
      [artifactId]
    );
    return result.rows[0] ? mapArtifact(result.rows[0]) : undefined;
  }

  async listArtifactMetadata(projectId: string): Promise<ArtifactMetadataRecord[]> {
    const result = await this.client.query<ArtifactRow>(
      `SELECT artifact_id, project_id, job_id, revision, configuration_version, provider_id, kind,
              media_type, content_hash, byte_length, source_artifact_ids, created_at
       FROM artifacts WHERE project_id = $1 ORDER BY created_at DESC, artifact_id ASC`,
      [projectId]
    );
    return result.rows.map(mapArtifact);
  }
  async createPublication(course: PublishedCourseV1, artifactId: string): Promise<boolean> { const result=await this.client.query(`INSERT INTO course_publications(published_course_id,project_id,revision,qa_report_artifact_id,artifact_id,document,published_at,published_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT DO NOTHING RETURNING published_course_id`,[course.publishedCourseId,course.projectId,course.revision,course.qaReportArtifactId,artifactId,JSON.stringify(course),course.publishedAt,course.publishedBy]); return Boolean(result.rows[0]); }
  async findPublicationByQa(projectId:string,qaReportArtifactId:string){const result=await this.client.query<{document:unknown}>("SELECT document FROM course_publications WHERE project_id=$1 AND qa_report_artifact_id=$2",[projectId,qaReportArtifactId]);return result.rows[0]?PublishedCourseV1Schema.parse(result.rows[0].document):undefined;}
  async listPublications(projectId:string){const result=await this.client.query<{document:unknown}>("SELECT document FROM course_publications WHERE project_id=$1 ORDER BY revision DESC",[projectId]);return result.rows.map((row)=>PublishedCourseV1Schema.parse(row.document));}
  async findPublication(projectId:string,publishedCourseId:string){const result=await this.client.query<{document:unknown}>("SELECT document FROM course_publications WHERE project_id=$1 AND published_course_id=$2",[projectId,publishedCourseId]);return result.rows[0]?PublishedCourseV1Schema.parse(result.rows[0].document):undefined;}
  async savePublicationWithdrawal(value:PublicationWithdrawalV1){const result=await this.client.query("INSERT INTO publication_withdrawals(withdrawal_id,published_course_id,project_id,reason,withdrawn_at,withdrawn_by,document) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(published_course_id) DO NOTHING RETURNING withdrawal_id",[value.withdrawalId,value.publishedCourseId,value.projectId,value.reason,value.withdrawnAt,value.withdrawnBy,JSON.stringify(value)]);return Boolean(result.rows[0]);}
  async findPublicationWithdrawal(projectId:string,publishedCourseId:string){const result=await this.client.query<{document:unknown}>("SELECT document FROM publication_withdrawals WHERE project_id=$1 AND published_course_id=$2",[projectId,publishedCourseId]);return result.rows[0]?PublicationWithdrawalV1Schema.parse(result.rows[0].document):undefined;}
  async saveArtifactTombstone(value:ArtifactTombstoneV1){const result=await this.client.query("INSERT INTO artifact_tombstones(tombstone_id,artifact_id,project_id,reason,tombstoned_at,tombstoned_by,restore_deadline,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(artifact_id) DO UPDATE SET tombstone_id=EXCLUDED.tombstone_id,reason=EXCLUDED.reason,tombstoned_at=EXCLUDED.tombstoned_at,tombstoned_by=EXCLUDED.tombstoned_by,restore_deadline=EXCLUDED.restore_deadline,restored_at=NULL,restored_by=NULL,purged_at=NULL,purged_by=NULL,document=EXCLUDED.document WHERE artifact_tombstones.restored_at IS NOT NULL RETURNING tombstone_id",[value.tombstoneId,value.artifactId,value.projectId,value.reason,value.tombstonedAt,value.tombstonedBy,value.restoreDeadline,JSON.stringify(value)]);return Boolean(result.rows[0]);}
  async findArtifactTombstone(projectId:string,artifactId:string){const result=await this.client.query<{document:unknown;restored_at:Date|string|null;restored_by:string|null;purged_at:Date|string|null;purged_by:string|null}>("SELECT document,restored_at,restored_by,purged_at,purged_by FROM artifact_tombstones WHERE project_id=$1 AND artifact_id=$2",[projectId,artifactId]);const row=result.rows[0];return row?ArtifactTombstoneV1Schema.parse({...row.document as object,restoredAt:isoNullable(row.restored_at),restoredBy:row.restored_by,purgedAt:isoNullable(row.purged_at),purgedBy:row.purged_by}):undefined;}
  async listArtifactTombstones(projectId?:string){const result=await this.client.query<{document:unknown;restored_at:Date|string|null;restored_by:string|null;purged_at:Date|string|null;purged_by:string|null}>(`SELECT document,restored_at,restored_by,purged_at,purged_by FROM artifact_tombstones ${projectId?"WHERE project_id=$1":""} ORDER BY tombstoned_at`,projectId?[projectId]:[]);return result.rows.map((row)=>ArtifactTombstoneV1Schema.parse({...row.document as object,restoredAt:isoNullable(row.restored_at),restoredBy:row.restored_by,purgedAt:isoNullable(row.purged_at),purgedBy:row.purged_by}));}
  async restoreArtifactTombstone(projectId:string,artifactId:string,restoredAt:string,restoredBy:string){const result=await this.client.query("UPDATE artifact_tombstones SET restored_at=$3,restored_by=$4 WHERE project_id=$1 AND artifact_id=$2 AND restored_at IS NULL AND purged_at IS NULL RETURNING artifact_id",[projectId,artifactId,restoredAt,restoredBy]);return Boolean(result.rows[0]);}
  async markArtifactPurged(artifactId:string,purgedAt:string,purgedBy:string){const result=await this.client.query("UPDATE artifact_tombstones SET purged_at=$2,purged_by=$3 WHERE artifact_id=$1 AND restored_at IS NULL AND purged_at IS NULL RETURNING artifact_id",[artifactId,purgedAt,purgedBy]);return Boolean(result.rows[0]);}
  async saveArtifactGcPlan(value:ArtifactGcPlanV1){const result=await this.client.query("INSERT INTO artifact_gc_plans(plan_id,artifact_ids,candidate_count,total_bytes,confirmation_sha256,created_at,created_by,expires_at,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT DO NOTHING RETURNING plan_id",[value.planId,value.artifactIds,value.candidateCount,value.totalBytes,value.confirmationSha256,value.createdAt,value.createdBy,value.expiresAt,JSON.stringify(value)]);return Boolean(result.rows[0]);}
  async findArtifactGcPlan(planId:string){const result=await this.client.query<{document:unknown;executed_at:Date|string|null;executed_by:string|null}>("SELECT document,executed_at,executed_by FROM artifact_gc_plans WHERE plan_id=$1",[planId]);const row=result.rows[0];return row?ArtifactGcPlanV1Schema.parse({...row.document as object,executedAt:isoNullable(row.executed_at),executedBy:row.executed_by}):undefined;}
  async markArtifactGcPlanExecuted(planId:string,executedAt:string,executedBy:string){const result=await this.client.query("UPDATE artifact_gc_plans SET executed_at=$2,executed_by=$3 WHERE plan_id=$1 AND executed_at IS NULL RETURNING plan_id",[planId,executedAt,executedBy]);return Boolean(result.rows[0]);}

  async saveImportedSource(input: ImportedSourceRecord): Promise<void> {
    const v2 = input.revision.schemaVersion === "2" ? input.revision : undefined;
    await this.client.query(
      `WITH inserted_artifact AS (
         INSERT INTO source_artifacts (source_artifact_id, project_id, display_name, created_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (source_artifact_id) DO UPDATE
         SET display_name = source_artifacts.display_name RETURNING source_artifact_id
       )
       INSERT INTO source_revisions (source_revision_id, source_artifact_id, revision, filename, media_type,
           byte_size, content_sha256, imported_at, extraction_method, sections, normalized_text,
           schema_version, raw_blob_id, parser_id, parser_version, security_inspection, revision_document)
       SELECT $5, source_artifact_id, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14,
           $15, $16, $17, $18, $19::jsonb, $20::jsonb FROM inserted_artifact
       ON CONFLICT (source_revision_id) DO NOTHING`,
      [input.artifact.sourceArtifactId, input.artifact.projectId, input.artifact.displayName, input.artifact.createdAt,
       input.revision.sourceRevisionId, input.revision.revision, input.revision.filename, input.revision.mediaType,
       input.revision.byteSize, input.revision.contentSha256, input.revision.importedAt, input.revision.extractionMethod,
       JSON.stringify(input.revision.sections), input.normalizedText, input.revision.schemaVersion,
       v2?.rawBlobId ?? null, v2?.parser.id ?? null, v2?.parser.version ?? null,
       v2 ? JSON.stringify(v2.securityInspection) : null, v2 ? JSON.stringify(v2) : null]
    );
  }

  async saveImportedSourceAndBind(input: ImportedSourceRecord, project: ProjectV1): Promise<void> {
    const v2 = input.revision.schemaVersion === "2" ? input.revision : undefined;
    await this.client.query(
      `WITH inserted_artifact AS (
         INSERT INTO source_artifacts (source_artifact_id, project_id, display_name, created_at)
         VALUES ($1, $2, $3, $4) ON CONFLICT (source_artifact_id) DO UPDATE
         SET display_name = source_artifacts.display_name RETURNING source_artifact_id
       ), inserted_revision AS (
         INSERT INTO source_revisions (source_revision_id, source_artifact_id, revision, filename, media_type,
           byte_size, content_sha256, imported_at, extraction_method, sections, normalized_text,
           schema_version, raw_blob_id, parser_id, parser_version, security_inspection, revision_document)
         SELECT $5, source_artifact_id, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14,
           $15, $16, $17, $18, $19::jsonb, $20::jsonb FROM inserted_artifact
         ON CONFLICT (source_revision_id) DO NOTHING RETURNING source_revision_id
       )
       UPDATE projects SET document=$21::jsonb, updated_at=$22
       WHERE project_id=$2 AND (EXISTS (SELECT 1 FROM inserted_revision) OR EXISTS (SELECT 1 FROM source_revisions WHERE source_revision_id=$5))`,
      [input.artifact.sourceArtifactId, input.artifact.projectId, input.artifact.displayName, input.artifact.createdAt,
       input.revision.sourceRevisionId, input.revision.revision, input.revision.filename, input.revision.mediaType,
       input.revision.byteSize, input.revision.contentSha256, input.revision.importedAt, input.revision.extractionMethod,
       JSON.stringify(input.revision.sections), input.normalizedText, input.revision.schemaVersion,
       v2?.rawBlobId ?? null, v2?.parser.id ?? null, v2?.parser.version ?? null,
       v2 ? JSON.stringify(v2.securityInspection) : null, v2 ? JSON.stringify(v2) : null,
       JSON.stringify(project), project.updatedAt]
    );
  }

  async listSourceRevisions(projectId: string): Promise<AnySourceRevision[]> {
    const result = await this.client.query<SourceRevisionRow>(
      `SELECT ${SOURCE_DOCUMENT_SQL} AS document,
        sr.imported_at
       FROM source_revisions sr INNER JOIN source_artifacts sa ON sa.source_artifact_id = sr.source_artifact_id
       WHERE sa.project_id = $1 ORDER BY sr.imported_at DESC`, [projectId]);
    return result.rows.map(mapSourceRevision);
  }

  async findSourceRevision(projectId: string, sourceRevisionId: string): Promise<AnySourceRevision | undefined> {
    const result = await this.client.query<SourceRevisionRow>(
      `SELECT ${SOURCE_DOCUMENT_SQL} AS document,
        sr.imported_at
       FROM source_revisions sr INNER JOIN source_artifacts sa ON sa.source_artifact_id = sr.source_artifact_id
       WHERE sa.project_id = $1 AND sr.source_revision_id = $2`, [projectId, sourceRevisionId]);
    return result.rows[0] ? mapSourceRevision(result.rows[0]) : undefined;
  }

  async findImportedSource(projectId: string, sourceRevisionId: string): Promise<ImportedSourceRecord | undefined> {
    const result = await this.client.query<SourceRevisionRow & { project_id: string; display_name: string; created_at: Date | string; normalized_text: string }>(
      `SELECT ${SOURCE_DOCUMENT_SQL} AS document,
        sr.imported_at, sa.project_id, sa.display_name, sa.created_at, sr.normalized_text
       FROM source_revisions sr INNER JOIN source_artifacts sa ON sa.source_artifact_id = sr.source_artifact_id
       WHERE sa.project_id=$1 AND sr.source_revision_id=$2`, [projectId, sourceRevisionId]);
    const row = result.rows[0];
    if (!row) return undefined;
    const revision = mapSourceRevision(row);
    return {
      artifact: {
        schemaVersion: "1", sourceArtifactId: revision.sourceArtifactId, projectId: row.project_id,
        displayName: row.display_name, createdAt: iso(row.created_at), currentRevisionId: revision.sourceRevisionId,
      },
      revision,
      normalizedText: row.normalized_text,
    };
  }

  async createProviderConfig(config: ProviderConfigVersionV1): Promise<boolean> {
    const result = await this.client.query(
      `INSERT INTO provider_config_versions (${PROVIDER_COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15)
       ON CONFLICT (kind, provider_id, version) DO NOTHING`,
      [config.configId, config.kind, config.providerId, config.version, config.displayName, config.endpoint ?? null,
       config.model ?? null, JSON.stringify(config.capabilities), JSON.stringify(config.settings), JSON.stringify(config.secretRefs),
       config.status, config.createdAt, config.createdBy, config.publishedAt, config.inactiveAt]);
    return (result.rowCount ?? 0) > 0;
  }
  async listProviderConfigs() { const result = await this.client.query<ProviderConfigRow>(`SELECT ${PROVIDER_COLUMNS} FROM provider_config_versions ORDER BY created_at DESC`); return result.rows.map(mapProviderConfig); }
  async findProviderConfig(id: string) { const result = await this.client.query<ProviderConfigRow>(`SELECT ${PROVIDER_COLUMNS} FROM provider_config_versions WHERE config_id = $1`, [id]); return result.rows[0] ? mapProviderConfig(result.rows[0]) : undefined; }
  async publishProviderConfig(id: string, occurredAt: string) {
    const result = await this.client.query<ProviderConfigRow>(
      `WITH target AS (SELECT kind FROM provider_config_versions WHERE config_id = $1 AND status = 'draft'),
       retired AS (UPDATE provider_config_versions SET status='inactive', inactive_at=$2 WHERE kind IN (SELECT kind FROM target) AND status='published' RETURNING 1)
       UPDATE provider_config_versions SET status='published', published_at=$2
       WHERE config_id=$1 AND status='draft' AND (SELECT count(*) FROM retired) >= 0 RETURNING ${PROVIDER_COLUMNS}`,
      [id, occurredAt]); return result.rows[0] ? mapProviderConfig(result.rows[0]) : undefined;
  }
  async deactivateProviderConfig(id: string, occurredAt: string) {
    const result = await this.client.query<ProviderConfigRow>(`UPDATE provider_config_versions SET status='inactive', inactive_at=$2 WHERE config_id=$1 AND status = 'published' RETURNING ${PROVIDER_COLUMNS}`, [id, occurredAt]);
    return result.rows[0] ? mapProviderConfig(result.rows[0]) : undefined;
  }
  async createPromptVersion(prompt: PromptVersionV1): Promise<boolean> {
    const result = await this.client.query(`INSERT INTO prompt_versions (${PROMPT_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (prompt_key, version) DO NOTHING`,
      [prompt.promptVersionId, prompt.promptKey, prompt.version, prompt.description, prompt.template, prompt.status, prompt.createdAt, prompt.createdBy, prompt.publishedAt, prompt.inactiveAt]);
    return (result.rowCount ?? 0) > 0;
  }
  async listPromptVersions() { const result = await this.client.query<PromptVersionRow>(`SELECT ${PROMPT_COLUMNS} FROM prompt_versions ORDER BY created_at DESC`); return result.rows.map(mapPromptVersion); }
  async findPromptVersion(id: string) { const result = await this.client.query<PromptVersionRow>(`SELECT ${PROMPT_COLUMNS} FROM prompt_versions WHERE prompt_version_id=$1`, [id]); return result.rows[0] ? mapPromptVersion(result.rows[0]) : undefined; }
  async publishPromptVersion(id: string, occurredAt: string) {
    const result = await this.client.query<PromptVersionRow>(
      `WITH target AS (SELECT prompt_key FROM prompt_versions WHERE prompt_version_id=$1 AND status='draft'),
       retired AS (UPDATE prompt_versions SET status='inactive', inactive_at=$2 WHERE prompt_key IN (SELECT prompt_key FROM target) AND status='published' RETURNING 1)
       UPDATE prompt_versions SET status='published', published_at=$2
       WHERE prompt_version_id=$1 AND status='draft' AND (SELECT count(*) FROM retired) >= 0 RETURNING ${PROMPT_COLUMNS}`,
      [id, occurredAt]); return result.rows[0] ? mapPromptVersion(result.rows[0]) : undefined;
  }
  async deactivatePromptVersion(id: string, occurredAt: string) {
    const result = await this.client.query<PromptVersionRow>(`UPDATE prompt_versions SET status='inactive', inactive_at=$2 WHERE prompt_version_id=$1 AND status = 'published' RETURNING ${PROMPT_COLUMNS}`, [id, occurredAt]);
    return result.rows[0] ? mapPromptVersion(result.rows[0]) : undefined;
  }
  async createQaPolicyVersion(policy: QaPolicyVersionV1) { const result=await this.client.query("INSERT INTO qa_policy_versions(qa_policy_id,name,version,status,content_hash,document,created_at,created_by,published_at,inactive_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10) ON CONFLICT(name,version) DO NOTHING",[policy.qaPolicyId,policy.name,policy.version,policy.status,policy.contentHash,JSON.stringify(policy),policy.createdAt,policy.createdBy,policy.publishedAt,policy.inactiveAt]);return(result.rowCount??0)>0; }
  async listQaPolicyVersions(){const result=await this.client.query<QaPolicyRow>("SELECT document FROM qa_policy_versions ORDER BY created_at DESC");return result.rows.map((row)=>QaPolicyVersionV1Schema.parse(row.document));}
  async findQaPolicyVersion(id:string){const result=await this.client.query<QaPolicyRow>("SELECT document FROM qa_policy_versions WHERE qa_policy_id=$1",[id]);return result.rows[0]?QaPolicyVersionV1Schema.parse(result.rows[0].document):undefined;}
  async publishQaPolicyVersion(id:string,occurredAt:string){const result=await this.client.query<QaPolicyRow>(`WITH target AS (SELECT qa_policy_id FROM qa_policy_versions WHERE qa_policy_id=$1 AND status='draft'), retired AS (UPDATE qa_policy_versions SET status='inactive',inactive_at=$2,document=jsonb_set(jsonb_set(document,'{status}','"inactive"'::jsonb),'{inactiveAt}',to_jsonb($2::text)) WHERE status='published' AND EXISTS(SELECT 1 FROM target)) UPDATE qa_policy_versions SET status='published',published_at=$2,document=jsonb_set(jsonb_set(document,'{status}','"published"'::jsonb),'{publishedAt}',to_jsonb($2::text)) WHERE qa_policy_id=$1 AND status='draft' RETURNING document`,[id,occurredAt]);return result.rows[0]?QaPolicyVersionV1Schema.parse(result.rows[0].document):undefined;}
  async deactivateQaPolicyVersion(id:string,occurredAt:string){const result=await this.client.query<QaPolicyRow>(`UPDATE qa_policy_versions SET status='inactive',inactive_at=$2,document=jsonb_set(jsonb_set(document,'{status}','"inactive"'::jsonb),'{inactiveAt}',to_jsonb($2::text)) WHERE qa_policy_id=$1 AND status='published' RETURNING document`,[id,occurredAt]);return result.rows[0]?QaPolicyVersionV1Schema.parse(result.rows[0].document):undefined;}
  async captureRuntimeConfigSnapshot(snapshotId: string, capturedAt: string, capturedBy: string) {
    const result = await this.client.query<SnapshotRow>(
      `INSERT INTO runtime_config_snapshots (snapshot_id,captured_at,captured_by,provider_bindings,prompt_bindings,qa_policy_id)
       SELECT $1,$2,$3,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('kind',kind,'configId',config_id,'providerId',provider_id,'version',version) ORDER BY kind) FROM provider_config_versions WHERE status='published'),'[]'::jsonb),
         COALESCE((SELECT jsonb_agg(jsonb_build_object('promptKey',prompt_key,'promptVersionId',prompt_version_id,'version',version,'contentHash',encode(sha256(convert_to(prompt_key || ':' || version || ':' || template,'UTF8')),'hex')) ORDER BY prompt_key) FROM prompt_versions WHERE status='published'),'[]'::jsonb),
         (SELECT qa_policy_id FROM qa_policy_versions WHERE status='published' ORDER BY published_at DESC LIMIT 1)
       RETURNING snapshot_id,captured_at,captured_by,provider_bindings,prompt_bindings,(SELECT document FROM qa_policy_versions q WHERE q.qa_policy_id=runtime_config_snapshots.qa_policy_id) AS qa_policy_document`, [snapshotId, capturedAt, capturedBy]);
    return mapSnapshot(result.rows[0]!);
  }
  async findRuntimeConfigSnapshot(id: string) {
    const result = await this.client.query<SnapshotRow>("SELECT s.snapshot_id,s.captured_at,s.captured_by,s.provider_bindings,s.prompt_bindings,l.document AS lexicon_document,q.document AS qa_policy_document FROM runtime_config_snapshots s LEFT JOIN pronunciation_lexicons l ON l.lexicon_id=s.pronunciation_lexicon_id LEFT JOIN qa_policy_versions q ON q.qa_policy_id=s.qa_policy_id WHERE s.snapshot_id=$1", [id]);
    return result.rows[0] ? mapSnapshot(result.rows[0]) : undefined;
  }
  async listRuntimeConfigSnapshots(query: UserPageQuery) {
    const [rows,count]=await Promise.all([
      this.client.query<SnapshotRow>("SELECT s.snapshot_id,s.captured_at,s.captured_by,s.provider_bindings,s.prompt_bindings,l.document AS lexicon_document,q.document AS qa_policy_document FROM runtime_config_snapshots s LEFT JOIN pronunciation_lexicons l ON l.lexicon_id=s.pronunciation_lexicon_id LEFT JOIN qa_policy_versions q ON q.qa_policy_id=s.qa_policy_id ORDER BY s.captured_at DESC,s.snapshot_id DESC LIMIT $1 OFFSET $2",[query.pageSize,(query.page-1)*query.pageSize]),
      this.client.query<{total:string|number}>("SELECT count(*) AS total FROM runtime_config_snapshots")
    ]);
    return{items:rows.rows.map(mapSnapshot),total:Number(count.rows[0]?.total??0),page:query.page,pageSize:query.pageSize};
  }

  async appendAudit(event: AuditEventV1): Promise<void> {
    await this.client.query(
      `INSERT INTO audit_events
       (audit_id, actor_id, action, resource_type, resource_id, outcome, occurred_at, request_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [event.auditId, event.actorId, event.action, event.resourceType, event.resourceId,
       event.outcome, event.occurredAt, event.requestId, JSON.stringify(event.metadata)]
    );
  }

  async listAudits(resourceId?: string): Promise<AuditEventV1[]> {
    const result = resourceId ? await this.client.query<AuditRow>(`SELECT audit_id,actor_id,action,resource_type,resource_id,outcome,occurred_at,request_id,metadata FROM audit_events WHERE resource_id = $1 OR metadata->>'projectId' = $1 ORDER BY occurred_at ASC`, [resourceId])
      : await this.client.query<AuditRow>(`SELECT audit_id,actor_id,action,resource_type,resource_id,outcome,occurred_at,request_id,metadata FROM audit_events ORDER BY occurred_at ASC`);
    return result.rows.map(mapAudit);
  }

  async queryAudits(query: AuditPageQuery): Promise<Page<AuditEventV1>> {
    const values: unknown[] = []; const clauses: string[] = [];
    const add = (sql: (index: number) => string, value: unknown) => { values.push(value); clauses.push(sql(values.length)); };
    if (query.resourceId) add((i) => `(resource_id = $${i} OR metadata->>'projectId' = $${i})`, query.resourceId);
    if (query.action) add((i) => `action = $${i}`, query.action);
    if (query.outcome) add((i) => `outcome = $${i}`, query.outcome);
    if (query.actorId) add((i) => `actor_id = $${i}`, query.actorId);
    if (query.from) add((i) => `occurred_at >= $${i}`, query.from);
    if (query.to) add((i) => `occurred_at <= $${i}`, query.to);
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const count = await this.client.query<{ total: number | string }>(`SELECT count(*) AS total FROM audit_events${where}`, values);
    const limitIndex = values.length + 1; const offsetIndex = values.length + 2;
    const result = await this.client.query<AuditRow>(
      `SELECT audit_id,actor_id,action,resource_type,resource_id,outcome,occurred_at,request_id,metadata
       FROM audit_events${where} ORDER BY occurred_at ASC,audit_id ASC LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      [...values, query.pageSize, (query.page - 1) * query.pageSize]);
    return { items: result.rows.map(mapAudit), total: Number(count.rows[0]?.total ?? 0), page: query.page, pageSize: query.pageSize };
  }
}
