CREATE TABLE workflow_jobs (
  job_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('demo','content','tts','video')),
  descriptor jsonb NOT NULL,
  stages text[] NOT NULL,
  document jsonb NOT NULL,
  artifact_hashes jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
  cancel_requested boolean NOT NULL DEFAULT false,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (jsonb_typeof(descriptor) = 'object'),
  CHECK (NOT (descriptor ?| ARRAY['prompt','text','apiKey','secret','credential']))
);

CREATE INDEX workflow_jobs_runnable_idx ON workflow_jobs (created_at)
  WHERE status IN ('queued','running');

CREATE TABLE workflow_job_events (
  event_id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES workflow_jobs(job_id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence >= 0),
  document jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (job_id, sequence)
);

CREATE INDEX workflow_job_events_job_idx ON workflow_job_events (job_id, sequence);
