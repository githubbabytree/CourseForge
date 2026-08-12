CREATE TABLE provider_probe_results(probe_id UUID PRIMARY KEY,config_id UUID NOT NULL REFERENCES provider_config_versions(config_id),document JSONB NOT NULL,checked_at TIMESTAMPTZ NOT NULL);
CREATE INDEX provider_probe_results_config_idx ON provider_probe_results(config_id,checked_at DESC);
CREATE TABLE pronunciation_lexicons(lexicon_id UUID PRIMARY KEY,name TEXT NOT NULL,version TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('draft','published','inactive')),content_hash TEXT NOT NULL,document JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL,created_by UUID NOT NULL REFERENCES users(user_id),published_at TIMESTAMPTZ,inactive_at TIMESTAMPTZ,UNIQUE(name,version));
CREATE UNIQUE INDEX pronunciation_lexicons_one_published ON pronunciation_lexicons(name) WHERE status='published';
ALTER TABLE runtime_config_snapshots ADD COLUMN pronunciation_lexicon_id UUID REFERENCES pronunciation_lexicons(lexicon_id);
