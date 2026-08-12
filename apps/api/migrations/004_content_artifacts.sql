ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_kind_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_check
  CHECK (kind IN ('research-json','material-json','deck-spec','reveal-html','render-manifest'));

-- PostgreSQL names the original inline media check `artifacts_check`; older
-- development databases may already have the explicit name below.
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_check;
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_media_type_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_media_type_check CHECK (
  (kind = 'reveal-html' AND media_type = 'text/html; charset=utf-8') OR
  (kind IN ('research-json','material-json','deck-spec','render-manifest') AND media_type = 'application/json')
);
