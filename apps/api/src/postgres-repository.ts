import {
  AuditEventV1Schema,
  ProjectV1Schema,
  SessionUserV1Schema,
  type AuditEventV1,
  type ProjectV1,
  type UserRole
} from "@courseforge/contracts";
import type { CourseForgeRepository, StoredSession, StoredUser } from "./repositories.js";
import type { ArtifactKind, ArtifactMediaType, ArtifactMetadataRecord } from "./artifacts.js";

export interface SqlQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
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
};

type SessionRow = { session_id: string; token_hash: string; user_id: string; expires_at: Date | string };
type ProjectRow = { document: unknown };
type JobRow = { project_id: string };
type BooleanRow = { allowed: boolean };
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

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const mapUser = (row: UserRow): StoredUser => ({
  ...SessionUserV1Schema.parse({
    schemaVersion: "1", userId: row.user_id, email: row.email,
    displayName: row.display_name, role: row.role
  }),
  passwordHash: row.password_hash,
  disabled: row.disabled
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

export class PostgresCourseForgeRepository implements CourseForgeRepository {
  readonly persistenceBackend = "postgres" as const;

  constructor(private readonly client: SqlQueryClient) {}

  async checkReadiness(): Promise<void> { await this.client.query("SELECT 1 AS ready"); }

  async findUserByEmail(email: string): Promise<StoredUser | undefined> {
    const result = await this.client.query<UserRow>(
      "SELECT user_id, email, display_name, role, password_hash, disabled FROM users WHERE email = $1",
      [email.trim().toLowerCase()]
    );
    return result.rows[0] ? mapUser(result.rows[0]) : undefined;
  }

  async findUserById(userId: string): Promise<StoredUser | undefined> {
    const result = await this.client.query<UserRow>(
      "SELECT user_id, email, display_name, role, password_hash, disabled FROM users WHERE user_id = $1",
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
    const result = resourceId
      ? await this.client.query<AuditRow>(
          `SELECT audit_id, actor_id, action, resource_type, resource_id, outcome, occurred_at, request_id, metadata
           FROM audit_events
           WHERE resource_id = $1 OR metadata->>'projectId' = $1
           ORDER BY occurred_at ASC`,
          [resourceId]
        )
      : await this.client.query<AuditRow>(
          `SELECT audit_id, actor_id, action, resource_type, resource_id, outcome, occurred_at, request_id, metadata
           FROM audit_events ORDER BY occurred_at ASC`
        );
    return result.rows.map(mapAudit);
  }
}
