import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { parseS3ArtifactRef } from "./protocol.js";

export interface ArtifactReader { read(ref: string, maximumBytes: number): Promise<Uint8Array> }

function endpoint(value: string): string {
  const parsed = new URL(value);
  if (!(["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("invalid_s3_endpoint");
  return parsed.toString().replace(/\/$/u, "");
}

async function boundedBody(body: unknown, maximumBytes: number): Promise<Uint8Array> {
  if (!body || typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") throw new Error("invalid_artifact_body");
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of body as AsyncIterable<unknown>) {
    if (!(chunk instanceof Uint8Array)) throw new Error("invalid_artifact_body");
    total += chunk.byteLength; if (total > maximumBytes) throw new Error("artifact_too_large"); chunks.push(Buffer.from(chunk));
  }
  return Uint8Array.from(Buffer.concat(chunks, total));
}

export function createS3ArtifactReader(config: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle?: boolean }): ArtifactReader {
  if (!config.region || !config.accessKeyId || !config.secretAccessKey || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(config.bucket)) throw new Error("invalid_s3_configuration");
  const client = new S3Client({ endpoint: endpoint(config.endpoint), region: config.region, forcePathStyle: config.forcePathStyle ?? true, credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } });
  return { read: async (ref, maximumBytes) => {
    const { bucket, key } = parseS3ArtifactRef(ref, config.bucket);
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (typeof result.ContentLength === "number" && result.ContentLength > maximumBytes) throw new Error("artifact_too_large");
    return await boundedBody(result.Body, maximumBytes);
  } };
}
