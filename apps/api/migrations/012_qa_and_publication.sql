ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_kind_check;
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_media_type_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_check CHECK (kind IN (
  'research-json','material-json','deck-spec','reveal-html','render-manifest','narration-manifest','tts-manifest',
  'audio-wav','subtitles-vtt','subtitles-srt','video-render-input','video-manifest','video-mp4','image-asset','image-metadata',
  'visual-analysis','qa-report','qa-approval','published-course'
));
ALTER TABLE artifacts ADD CONSTRAINT artifacts_media_type_check CHECK (
  (kind='reveal-html' AND media_type='text/html; charset=utf-8') OR (kind='audio-wav' AND media_type='audio/wav') OR
  (kind='video-mp4' AND media_type='video/mp4') OR (kind='image-asset' AND media_type IN ('image/png','image/jpeg','image/webp')) OR
  (kind='subtitles-vtt' AND media_type='text/vtt; charset=utf-8') OR (kind='subtitles-srt' AND media_type='application/x-subrip; charset=utf-8') OR
  (kind NOT IN ('reveal-html','audio-wav','video-mp4','image-asset','subtitles-vtt','subtitles-srt') AND media_type='application/json')
);

CREATE TABLE course_publications (
  published_course_id UUID PRIMARY KEY, project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision > 0), qa_report_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id) ON DELETE RESTRICT,
  artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(artifact_id) ON DELETE RESTRICT, document JSONB NOT NULL,
  published_at TIMESTAMPTZ NOT NULL, published_by UUID NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  UNIQUE(project_id, revision), UNIQUE(project_id, qa_report_artifact_id)
);
