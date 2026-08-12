ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_kind_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_check CHECK (kind IN (
  'research-json','material-json','deck-spec','reveal-html','render-manifest','narration-manifest','tts-manifest','audio-wav',
  'subtitles-vtt','subtitles-srt','video-render-input','video-manifest','video-mp4','image-asset','image-metadata','visual-analysis',
  'qa-report','qa-approval','published-course','image-search-candidates'
));
