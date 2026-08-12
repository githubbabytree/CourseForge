-- CourseForge internal-alpha persistence schema.
-- Applied transactionally by the migration runner.

CREATE TABLE users (
  user_id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('platform_admin','course_editor','viewer','auditor')),
  password_hash text NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  session_id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE projects (
  project_id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(user_id),
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE project_members (
  project_id uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE job_projects (
  job_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE
);

CREATE TABLE audit_events (
  audit_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(user_id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('success','failure')),
  occurred_at timestamptz NOT NULL,
  request_id uuid NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_occurred_idx ON audit_events (occurred_at DESC);
CREATE INDEX audit_events_resource_idx ON audit_events (resource_type, resource_id);
