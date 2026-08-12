import assert from "node:assert/strict";
import test from "node:test";
import { parseProbe } from "./render.js";

const probeJson = (video: Record<string, unknown>) => JSON.stringify({
  format: { duration: "2.367" },
  streams: [
    { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1", pix_fmt: "yuv420p", ...video },
    { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 }
  ]
});

test("reads an explicit ffprobe nb_frames count", () => {
  const metadata = parseProbe(probeJson({ nb_frames: "71", duration_ts: "36352", time_base: "1/15360" }));
  assert.equal(metadata.frameCount, 71);
  assert.equal(metadata.durationMs, 2367);
});

test("derives a verifiable frame count from duration_ts and time_base when nb_frames is absent", () => {
  const metadata = parseProbe(probeJson({ duration_ts: "36352", time_base: "1/15360" }));
  assert.equal(metadata.frameCount, 71);
});

test("fails closed when ffprobe supplies neither frame count nor a verifiable stream duration", () => {
  assert.throws(() => parseProbe(probeJson({ nb_frames: "N/A" })), /frame_count/u);
});
