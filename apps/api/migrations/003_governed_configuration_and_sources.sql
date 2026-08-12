CREATE TABLE source_artifacts (
  source_artifact_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL,
  current_revision_id uuid
);

CREATE TABLE source_revisions (
  source_revision_id uuid PRIMARY KEY,
  source_artifact_id uuid NOT NULL REFERENCES source_artifacts(source_artifact_id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  filename text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('text/plain','text/markdown')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 2097152),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  imported_at timestamptz NOT NULL,
  extraction_method text NOT NULL CHECK (extraction_method = 'plain-text-v1'),
  sections jsonb NOT NULL,
  normalized_text text NOT NULL CHECK (octet_length(normalized_text) <= 2097152),
  UNIQUE (source_artifact_id, revision)
);
ALTER TABLE source_artifacts ADD CONSTRAINT source_artifacts_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES source_revisions(source_revision_id);
CREATE FUNCTION update_source_current_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE source_artifacts SET current_revision_id = NEW.source_revision_id
  WHERE source_artifact_id = NEW.source_artifact_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER source_revision_updates_current AFTER INSERT ON source_revisions
  FOR EACH ROW EXECUTE FUNCTION update_source_current_revision();
CREATE INDEX source_artifacts_project_idx ON source_artifacts (project_id, created_at DESC);

CREATE TABLE provider_config_versions (
  config_id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('text','multimodal','search','design','tts','deck','video')),
  provider_id text NOT NULL,
  version text NOT NULL,
  display_name text NOT NULL,
  endpoint text,
  model text,
  capabilities jsonb NOT NULL DEFAULT '[]',
  settings jsonb NOT NULL DEFAULT '{}',
  secret_refs jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('draft','published','inactive')),
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES users(user_id),
  published_at timestamptz,
  inactive_at timestamptz,
  UNIQUE (kind, provider_id, version)
);
CREATE UNIQUE INDEX provider_config_one_published_per_kind
  ON provider_config_versions (kind) WHERE status = 'published';

CREATE TABLE prompt_versions (
  prompt_version_id uuid PRIMARY KEY,
  prompt_key text NOT NULL,
  version text NOT NULL,
  description text NOT NULL DEFAULT '',
  template text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','published','inactive')),
  created_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES users(user_id),
  published_at timestamptz,
  inactive_at timestamptz,
  UNIQUE (prompt_key, version)
);
CREATE UNIQUE INDEX prompt_version_one_published_per_key
  ON prompt_versions (prompt_key) WHERE status = 'published';

CREATE TABLE runtime_config_snapshots (
  snapshot_id uuid PRIMARY KEY,
  captured_at timestamptz NOT NULL,
  captured_by uuid NOT NULL REFERENCES users(user_id),
  provider_bindings jsonb NOT NULL,
  prompt_bindings jsonb NOT NULL
);
