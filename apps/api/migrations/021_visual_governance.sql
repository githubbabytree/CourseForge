ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_kind_check;
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_media_type_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_check CHECK (kind IN (
  'research-json','research-evidence','material-json','deck-spec','reveal-html','render-manifest','narration-manifest','tts-manifest',
  'audio-wav','subtitles-vtt','subtitles-srt','video-render-input','video-manifest','video-mp4','image-asset','image-metadata',
  'design-plan','visual-analysis','visual-style-profile','slide-render-png','visual-review','visual-confirmation',
  'qa-report','qa-approval','published-course','image-search-candidates','webppt-package','release-manifest'
));
ALTER TABLE artifacts ADD CONSTRAINT artifacts_media_type_check CHECK (
  (kind='reveal-html' AND media_type='text/html; charset=utf-8') OR (kind='audio-wav' AND media_type='audio/wav') OR
  (kind='video-mp4' AND media_type='video/mp4') OR (kind='webppt-package' AND media_type='application/zip') OR
  (kind IN ('image-asset','slide-render-png') AND media_type IN ('image/png','image/jpeg','image/webp')) OR
  (kind='subtitles-vtt' AND media_type='text/vtt; charset=utf-8') OR (kind='subtitles-srt' AND media_type='application/x-subrip; charset=utf-8') OR
  (kind NOT IN ('reveal-html','audio-wav','video-mp4','webppt-package','image-asset','slide-render-png','subtitles-vtt','subtitles-srt') AND media_type='application/json')
);
