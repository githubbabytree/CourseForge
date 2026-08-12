ALTER TABLE source_revisions ADD COLUMN schema_version text NOT NULL DEFAULT '1';
ALTER TABLE source_revisions ADD COLUMN raw_blob_id text;
ALTER TABLE source_revisions ADD COLUMN parser_id text;
ALTER TABLE source_revisions ADD COLUMN parser_version text;
ALTER TABLE source_revisions ADD COLUMN security_inspection jsonb;
ALTER TABLE source_revisions ADD COLUMN revision_document jsonb;

ALTER TABLE source_revisions DROP CONSTRAINT IF EXISTS source_revisions_media_type_check;
ALTER TABLE source_revisions DROP CONSTRAINT IF EXISTS source_revisions_byte_size_check;
ALTER TABLE source_revisions DROP CONSTRAINT IF EXISTS source_revisions_extraction_method_check;

ALTER TABLE source_revisions ADD CONSTRAINT source_revisions_schema_version_check CHECK (schema_version IN ('1','2'));
ALTER TABLE source_revisions ADD CONSTRAINT source_revisions_media_type_check CHECK (media_type IN (
  'text/plain', 'text/markdown', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
));
ALTER TABLE source_revisions ADD CONSTRAINT source_revisions_byte_size_check CHECK (byte_size > 0 AND byte_size <= 20971520);
ALTER TABLE source_revisions ADD CONSTRAINT source_revisions_extraction_method_check CHECK (extraction_method IN (
  'plain-text-v1', 'plain-text-v2', 'pdf-text-v1', 'docx-wordprocessingml-v1', 'pptx-openxml-v1'
));
ALTER TABLE source_revisions ADD CONSTRAINT source_revisions_raw_blob_id_check CHECK (
  raw_blob_id IS NULL OR raw_blob_id ~ '^artifact-[a-f0-9]{64}$'
);
ALTER TABLE source_revisions ADD CONSTRAINT source_revisions_v2_fields_check CHECK (
  (schema_version = '1' AND raw_blob_id IS NULL AND parser_id IS NULL AND parser_version IS NULL AND security_inspection IS NULL AND revision_document IS NULL)
  OR
  (schema_version = '2' AND raw_blob_id IS NOT NULL AND parser_id IS NOT NULL AND parser_version IS NOT NULL AND security_inspection IS NOT NULL AND revision_document IS NOT NULL)
);
