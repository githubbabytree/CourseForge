import { rm } from "node:fs/promises";

// Next can retain a locked/incomplete cache after an interrupted concurrent
// build. `.next` is fully reproducible and must never be treated as user data.
await rm(new URL("../.next", import.meta.url), {
  recursive: true,
  force: true,
  maxRetries: 8,
  retryDelay: 250,
});
