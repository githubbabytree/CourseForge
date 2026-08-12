CREATE TABLE IF NOT EXISTS document_revisions (
  revision_id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('deck', 'material')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  parent_revision_id UUID REFERENCES document_revisions(revision_id),
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  configuration_snapshot_id UUID,
  document JSONB NOT NULL,
  locks JSONB NOT NULL DEFAULT '[]'::jsonb,
  slide_hashes JSONB NOT NULL DEFAULT '{}'::jsonb,
  dirty_slide_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  reused_slide_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  media_state TEXT NOT NULL CHECK (media_state IN ('not_applicable', 'stale_requires_regeneration')),
  reason TEXT NOT NULL CHECK (reason IN ('generated', 'manual', 'ai', 'restore')),
  created_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES users(user_id),
  UNIQUE(project_id, kind, revision)
);

CREATE TABLE IF NOT EXISTS document_revision_heads (
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('deck', 'material')),
  revision_id UUID NOT NULL REFERENCES document_revisions(revision_id),
  PRIMARY KEY(project_id, kind)
);

CREATE TABLE IF NOT EXISTS document_revision_proposals (
  proposal_id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('deck', 'material')),
  base_revision_id UUID NOT NULL REFERENCES document_revisions(revision_id),
  base_content_hash TEXT NOT NULL CHECK (base_content_hash ~ '^[a-f0-9]{64}$'),
  mode TEXT NOT NULL CHECK (mode IN ('manual', 'ai')),
  patch JSONB NOT NULL,
  changed_paths JSONB NOT NULL,
  configuration_snapshot_id UUID,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied')) DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES users(user_id)
);

CREATE INDEX IF NOT EXISTS document_revisions_project_kind_idx ON document_revisions(project_id, kind, revision DESC);
CREATE INDEX IF NOT EXISTS document_revision_proposals_project_idx ON document_revision_proposals(project_id, created_at DESC);
