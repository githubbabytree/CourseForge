ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_kind_check;
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_media_type_check;
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_byte_length_check;

ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_check CHECK (kind IN (
  'research-json','material-json','deck-spec','reveal-html','render-manifest',
  'narration-manifest','tts-manifest','audio-wav','subtitles-vtt','subtitles-srt'
));
ALTER TABLE artifacts ADD CONSTRAINT artifacts_media_type_check CHECK (
  (kind = 'reveal-html' AND media_type = 'text/html; charset=utf-8') OR
  (kind = 'audio-wav' AND media_type = 'audio/wav') OR
  (kind = 'subtitles-vtt' AND media_type = 'text/vtt; charset=utf-8') OR
  (kind = 'subtitles-srt' AND media_type = 'application/x-subrip; charset=utf-8') OR
  (kind IN ('research-json','material-json','deck-spec','render-manifest','narration-manifest','tts-manifest') AND media_type = 'application/json')
);
ALTER TABLE artifacts ADD CONSTRAINT artifacts_byte_length_check CHECK (
  byte_length >= 0 AND byte_length <= 20971520
);
