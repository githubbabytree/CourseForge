ALTER TABLE workflow_jobs DROP CONSTRAINT IF EXISTS workflow_jobs_kind_check;
ALTER TABLE workflow_jobs ADD CONSTRAINT workflow_jobs_kind_check CHECK (kind IN (
  'demo','content','design-plan','deck-build','release-package','tts','video'
));

ALTER TABLE workflow_jobs ADD CONSTRAINT workflow_jobs_descriptor_v2_check CHECK (
  jsonb_typeof(descriptor) = 'object'
  AND NOT (descriptor ?| ARRAY['prompt','text','apiKey','secret','credential','token','password'])
  AND descriptor->>'projectId' = project_id::text
  AND (
    kind NOT IN ('design-plan','deck-build','release-package')
    OR descriptor->>'inputHash' ~ '^[a-f0-9]{64}$'
  )
);

CREATE INDEX workflow_jobs_descriptor_input_idx
  ON workflow_jobs (project_id, kind, ((descriptor->>'inputHash')))
  WHERE kind IN ('design-plan','deck-build','release-package');
