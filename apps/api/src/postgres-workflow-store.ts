import { JobV1Schema, type JobEventV1 } from "@courseforge/contracts";
import type { DurableJobDescriptor, DurableWorkflowRecord, DurableWorkflowStore, JobStage } from "@courseforge/workflow";
import type { SqlQueryClient } from "./postgres-repository.js";

type WorkflowRow = {
  document: unknown;
  descriptor: DurableJobDescriptor;
  stages: JobStage[];
  artifact_hashes: Partial<Record<JobStage, string>>;
  cancel_requested: boolean;
  lease_token: string | null;
};

const mapRow = (row: WorkflowRow): DurableWorkflowRecord => ({
  job: JobV1Schema.parse(row.document),
  descriptor: structuredClone(row.descriptor),
  stages: [...row.stages],
  artifactHashes: { ...row.artifact_hashes },
  cancelRequested: row.cancel_requested,
  ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
});

const COLUMNS = "document, descriptor, stages, artifact_hashes, cancel_requested, lease_token";

/** PostgreSQL adapter with atomic claims and checkpoint/event writes. */
export class PostgresWorkflowStore implements DurableWorkflowStore {
  constructor(private readonly client: SqlQueryClient) {}

  async create(record: DurableWorkflowRecord): Promise<void> {
    await this.client.query(
      `INSERT INTO workflow_jobs (job_id, project_id, kind, descriptor, stages, document, artifact_hashes, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5::text[],$6::jsonb,$7::jsonb,$8,$9,$10)
       ON CONFLICT (job_id) DO NOTHING`,
      [record.job.jobId, record.job.projectId, record.descriptor.kind, JSON.stringify(record.descriptor), record.stages,
        JSON.stringify(record.job), JSON.stringify(record.artifactHashes), record.job.status, record.job.startedAt, record.job.updatedAt],
    );
  }

  async load(jobId: string): Promise<DurableWorkflowRecord | undefined> {
    const result = await this.client.query<WorkflowRow>(`SELECT ${COLUMNS} FROM workflow_jobs WHERE job_id=$1`, [jobId]);
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async claim(jobId: string, leaseToken: string, leaseUntil: string): Promise<DurableWorkflowRecord | undefined> {
    const result = await this.client.query<WorkflowRow>(
      `UPDATE workflow_jobs SET lease_token=$2, lease_expires_at=$3, updated_at=now()
       WHERE job_id=$1 AND status IN ('queued','running','failed')
         AND (lease_token IS NULL OR lease_expires_at <= now())
       RETURNING ${COLUMNS}`,
      [jobId, leaseToken, leaseUntil],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async heartbeat(jobId: string, leaseToken: string, leaseUntil: string): Promise<boolean> {
    const result = await this.client.query(
      "UPDATE workflow_jobs SET lease_expires_at=$3, updated_at=now() WHERE job_id=$1 AND lease_token=$2",
      [jobId, leaseToken, leaseUntil],
    );
    return result.rowCount === 1;
  }

  async save(record: DurableWorkflowRecord, leaseToken: string, event?: JobEventV1): Promise<boolean> {
    const result = await this.client.query(
      `WITH inserted_event AS (
         INSERT INTO workflow_job_events (event_id, job_id, sequence, document, occurred_at)
         SELECT $3::uuid,$1,$4,$5::jsonb,$6 WHERE $3::uuid IS NOT NULL
         ON CONFLICT (job_id, sequence) DO NOTHING
       )
       UPDATE workflow_jobs SET document=$7::jsonb, artifact_hashes=$8::jsonb, status=$9, updated_at=$10
       WHERE job_id=$1 AND lease_token=$2`,
      [record.job.jobId, leaseToken, event?.eventId ?? null, event?.sequence ?? null, event ? JSON.stringify(event) : null,
        event?.occurredAt ?? null, JSON.stringify(record.job), JSON.stringify(record.artifactHashes), record.job.status, record.job.updatedAt],
    );
    return result.rowCount === 1;
  }

  async release(jobId: string, leaseToken: string): Promise<void> {
    await this.client.query(
      "UPDATE workflow_jobs SET lease_token=NULL, lease_expires_at=NULL WHERE job_id=$1 AND lease_token=$2",
      [jobId, leaseToken],
    );
  }

  async requestCancel(jobId: string): Promise<boolean> {
    const result = await this.client.query(
      `UPDATE workflow_jobs SET cancel_requested=true, updated_at=now()
       WHERE job_id=$1 AND status NOT IN ('completed','cancelled')`, [jobId],
    );
    return result.rowCount === 1;
  }

  async listRunnable(limit: number): Promise<string[]> {
    const result = await this.client.query<{ job_id: string }>(
      `SELECT job_id FROM workflow_jobs
       WHERE status IN ('queued','running') AND (lease_token IS NULL OR lease_expires_at <= now())
       ORDER BY created_at ASC LIMIT $1`, [Math.max(1, Math.min(limit, 100))],
    );
    return result.rows.map((row) => row.job_id);
  }
}
