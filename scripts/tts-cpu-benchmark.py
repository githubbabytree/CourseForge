#!/usr/bin/env python3
"""Run the mandatory 30-minute Chinese CPU TTS release gate without saving audio."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def request_json(url: str, token: str) -> dict:
    request = urllib.request.Request(url, headers={"authorization": f"Bearer {token}"})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def synthesize(url: str, token: str, health: dict, voice: str, sample_rate: int, channels: int, text: str) -> tuple[int, float]:
    body = json.dumps({"schemaVersion": "2", "engine": health["engine"], "engineRevision": health["engineRevision"],
                       "text": text, "voiceId": voice, "speed": 1,
                       "output": {"container": "wav", "sampleRateHz": sample_rate, "channels": channels},
                       "pronunciationLexicon": None},
                      ensure_ascii=False, separators=(",", ":")).encode()
    request = urllib.request.Request(url + "/v1/synthesize", data=body, method="POST",
                                     headers={"authorization": f"Bearer {token}", "content-type": "application/json", "accept": "audio/wav"})
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=300) as response:
        audio = response.read(32 * 1024 * 1024 + 1)
        elapsed = time.monotonic() - started
        expected_hash = response.headers["x-content-sha256"]
        if len(audio) > 32 * 1024 * 1024 or hashlib.sha256(audio).hexdigest() != expected_hash:
            raise RuntimeError("audio integrity check failed")
        if response.headers["x-tts-model-sha256"] != health["modelSha256"] or response.headers["x-tts-model-license"] != health["modelLicense"]:
            raise RuntimeError("runtime provenance drift")
        return int(response.headers["x-audio-duration-ms"]), elapsed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3030")
    parser.add_argument("--corpus", type=Path, default=Path("packages/tts-worker/benchmarks/zh-security-30min.json"))
    parser.add_argument("--sample-rate", type=int, default=24000)
    parser.add_argument("--channels", type=int, default=1)
    parser.add_argument("--max-rtf", type=float, default=0.8, help="maximum total and P95 case wall time / generated duration")
    args = parser.parse_args()
    token = os.environ.get("TTS_WORKER_AUTH_TOKEN", "")
    if len(token) < 32:
        raise RuntimeError("TTS_WORKER_AUTH_TOKEN is required")
    corpus = json.loads(args.corpus.read_text("utf-8"))
    health = request_json(args.url + "/health", token)
    if health.get("status") != "ok" or not health.get("ready"):
        raise RuntimeError("worker is not ready")
    voices = request_json(args.url + "/v1/voices", token)
    available = [voice for voice in voices.get("voices", []) if voice.get("available") is True and "zh-CN" in voice.get("languages", [])]
    if len(available) != 1:
        raise RuntimeError("exactly one pinned Chinese voice must be available")
    durations: list[int] = []
    wall_times: list[float] = []
    failures: list[str] = []
    started = time.monotonic()
    for _ in range(corpus["repetitions"]):
        for passage in corpus["passages"]:
            try:
                duration, wall = synthesize(args.url, token, health, available[0]["id"], args.sample_rate, args.channels, passage)
                durations.append(duration); wall_times.append(wall)
            except (KeyError, ValueError, RuntimeError, urllib.error.URLError) as error:
                failures.append(type(error).__name__)
    wall_total = time.monotonic() - started
    audio_seconds = sum(durations) / 1000
    if not durations or audio_seconds <= 0:
        raise RuntimeError("no successful synthesis cases")
    case_rtfs = [wall / (duration / 1000) for wall, duration in zip(wall_times, durations)]
    ordered_rtfs = sorted(case_rtfs); p95_rtf = ordered_rtfs[max(0, math.ceil(0.95 * len(ordered_rtfs)) - 1)]
    rtf = wall_total / audio_seconds
    total_cases = len(durations) + len(failures); failure_rate = len(failures) / total_cases
    final_health = request_json(args.url + "/health", token)
    passed = (corpus["minimumDurationSeconds"] <= audio_seconds <= corpus["maximumDurationSeconds"]
              and rtf <= args.max_rtf and p95_rtf <= args.max_rtf and failure_rate == 0)
    evidence = {"schemaVersion": "1", "passed": passed, "engine": health["engine"], "engineRevision": health["engineRevision"],
                "modelId": health["modelId"], "modelSha256": health["modelSha256"], "modelLicense": health["modelLicense"],
                "voiceId": available[0]["id"], "cases": len(durations), "audioDurationSeconds": round(audio_seconds, 3),
                "wallSeconds": round(wall_total, 3), "realTimeFactor": round(rtf, 4), "p95CaseRealTimeFactor": round(p95_rtf, 4),
                "p50CaseWallSeconds": round(statistics.median(wall_times), 3), "maxRtfGate": args.max_rtf,
                "coldFirstSynthesisSeconds": round(wall_times[0], 3), "failures": len(failures), "failureRate": round(failure_rate, 6),
                "workerPeakRssKiB": final_health.get("processPeakRssKiB"),
                "durationGateSeconds": [corpus["minimumDurationSeconds"], corpus["maximumDurationSeconds"]]}
    print(json.dumps(evidence, ensure_ascii=False, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (KeyError, ValueError, RuntimeError, urllib.error.URLError) as error:
        print(json.dumps({"schemaVersion": "1", "passed": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
