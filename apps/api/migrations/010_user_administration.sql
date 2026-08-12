-- User administration invariants and audit-console indexes.
ALTER TABLE users ADD COLUMN updated_at timestamptz;
UPDATE users SET updated_at = created_at WHERE updated_at IS NULL;
ALTER TABLE users ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE users ALTER COLUMN updated_at SET NOT NULL;

CREATE OR REPLACE FUNCTION courseforge_protect_last_enabled_admin()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'platform_admin' AND OLD.disabled = false
     AND (NEW.role <> 'platform_admin' OR NEW.disabled = true) THEN
    PERFORM pg_advisory_xact_lock(204223551);
    IF NOT EXISTS (
      SELECT 1 FROM users
      WHERE user_id <> OLD.user_id AND role = 'platform_admin' AND disabled = false
    ) THEN
      RAISE EXCEPTION 'cannot remove the last enabled platform administrator'
        USING ERRCODE = '23514', CONSTRAINT = 'users_last_enabled_admin';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_protect_last_enabled_admin
BEFORE UPDATE OF role, disabled ON users
FOR EACH ROW EXECUTE FUNCTION courseforge_protect_last_enabled_admin();

CREATE INDEX audit_events_action_outcome_idx ON audit_events (action, outcome, occurred_at DESC);
CREATE INDEX audit_events_actor_occurred_idx ON audit_events (actor_id, occurred_at DESC);
