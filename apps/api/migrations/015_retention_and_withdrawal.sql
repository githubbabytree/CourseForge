CREATE TABLE publication_withdrawals (
  withdrawal_id UUID PRIMARY KEY,
  published_course_id UUID NOT NULL UNIQUE REFERENCES course_publications(published_course_id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 4 AND 2000),
  withdrawn_at TIMESTAMPTZ NOT NULL,
  withdrawn_by UUID NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  document JSONB NOT NULL
);

CREATE TABLE artifact_tombstones (
  tombstone_id UUID PRIMARY KEY,
  artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 4 AND 2000),
  tombstoned_at TIMESTAMPTZ NOT NULL,
  tombstoned_by UUID NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  restore_deadline TIMESTAMPTZ NOT NULL,
  restored_at TIMESTAMPTZ,
  restored_by UUID REFERENCES users(user_id) ON DELETE RESTRICT,
  purged_at TIMESTAMPTZ,
  purged_by UUID REFERENCES users(user_id) ON DELETE RESTRICT,
  document JSONB NOT NULL,
  CHECK(NOT (restored_at IS NOT NULL AND purged_at IS NOT NULL))
);
CREATE INDEX artifact_tombstones_gc_idx ON artifact_tombstones(restore_deadline)
  WHERE restored_at IS NULL AND purged_at IS NULL;

CREATE TABLE artifact_gc_plans (
  plan_id UUID PRIMARY KEY,
  artifact_ids TEXT[] NOT NULL CHECK(cardinality(artifact_ids) > 0),
  candidate_count INTEGER NOT NULL CHECK(candidate_count = cardinality(artifact_ids)),
  total_bytes BIGINT NOT NULL CHECK(total_bytes >= 0),
  confirmation_sha256 TEXT NOT NULL CHECK(confirmation_sha256 ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  expires_at TIMESTAMPTZ NOT NULL,
  executed_at TIMESTAMPTZ,
  executed_by UUID REFERENCES users(user_id) ON DELETE RESTRICT,
  document JSONB NOT NULL
);
