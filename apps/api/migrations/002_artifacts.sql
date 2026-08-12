CREATE TABLE artifacts (
  artifact_id text PRIMARY KEY CHECK (artifact_id ~ '^artifact-[a-f0-9]{64}$'),
  project_id uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  configuration_version text NOT NULL,
  provider_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('deck-spec','reveal-html','render-manifest')),
  media_type text NOT NULL CHECK (
    (kind = 'reveal-html' AND media_type = 'text/html; charset=utf-8') OR
    (kind IN ('deck-spec','render-manifest') AND media_type = 'application/json')
  ),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  byte_length integer NOT NULL CHECK (byte_length >= 0 AND byte_length <= 10485760),
  source_artifact_ids text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL
);
CREATE INDEX artifacts_project_created_idx ON artifacts (project_id, created_at DESC);
CREATE INDEX artifacts_job_idx ON artifacts (job_id);
