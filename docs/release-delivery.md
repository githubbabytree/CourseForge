# Reproducible release delivery

Publishing enqueues durable release packaging and returns HTTP 202 with the job.
After that job completes, published courses expose project-authorized downloads
for WebPPT ZIP, MP4, VTT, SRT, and a versioned release manifest. Download GETs
only read resources named by a completed, verified manifest; they never build a
ZIP or persist artifacts. A withdrawal is checked before any manifest or blob
read; every new download returns HTTP 410 after withdrawal.

The WebPPT ZIP is store-only and deterministic: entries are sorted, use a fixed
DOS epoch and permissions, and have bounded safe relative names. Each entry is
limited to 20 MiB, the archive to 128 MiB and 512 entries. It includes the exact
DeckSpec, offline Reveal HTML/runtime, only referenced same-project licensed
images, speaker notes, Reveal's MIT license, NOTICE, manifest, and SHA256SUMS.
Building the same inputs twice must produce the same SHA-256. Zip-slip names,
duplicates, arbitrary filesystem paths, remote/internal URLs, missing images,
unknown image rights, hash drift, and oversized content fail closed.

The release manifest binds exact Deck/Reveal/Speech/Video artifact IDs and
hashes plus the immutable configuration snapshot, provider and renderer,
browser, FFmpeg, image, and font revisions. It never contains secrets,
endpoints, prompt bodies, model request bodies, or uploaded source content.
Storage and manifests remain UTC ISO timestamps; the Web UI formats time in
UTC+8 only.

Downloads use `Content-Disposition: attachment`, `nosniff`, a sandbox CSP,
private/no-store caching, and authenticated project membership. MP4 and ZIP
reuse bounded single-range delivery with integrity verification; VTT, SRT and
manifest are complete downloads. Migration 017 adds the `webppt-package` and
`release-manifest` artifact kinds. Migration 019 adds durable design and release
descriptors and must follow the independently owned migration 018.
