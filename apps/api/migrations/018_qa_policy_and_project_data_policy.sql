CREATE TABLE qa_policy_versions (
  qa_policy_id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published','inactive')),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  document JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  published_at TIMESTAMPTZ,
  inactive_at TIMESTAMPTZ,
  UNIQUE(name, version)
);

CREATE UNIQUE INDEX qa_policy_one_published ON qa_policy_versions(status) WHERE status='published';

ALTER TABLE runtime_config_snapshots
  ADD COLUMN qa_policy_id UUID REFERENCES qa_policy_versions(qa_policy_id) ON DELETE RESTRICT;

-- ProjectV1.document is authoritative for the versioned data policy. Existing
-- projects are upgraded explicitly to the fail-closed offline/private default.
UPDATE projects
SET document = jsonb_set(document, '{dataPolicy}', '{"schemaVersion":"1","mode":"offline","classification":"private"}'::jsonb, true)
WHERE document->'dataPolicy' IS NULL;
