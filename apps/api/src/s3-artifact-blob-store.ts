import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { InMemoryArtifactBlobStore, InvalidArtifactError, type ArtifactBlobStore } from "./artifacts.js";

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const ARTIFACT_ID = /^artifact-[a-f0-9]{64}$/;
const BUCKET = /^(?=.{3,63}$)(?!.*\.\.)(?!\d{1,3}(?:\.\d{1,3}){3}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/;

type S3Command = PutObjectCommand | GetObjectCommand | HeadBucketCommand | CreateBucketCommand;
export interface S3CommandClient {
  send(command: S3Command): Promise<Record<string, unknown>>;
  destroy?(): void;
}

export interface S3ArtifactBlobStoreConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  createBucketIfMissing?: boolean;
}

export class ArtifactBlobStoreUnavailableError extends Error {
  constructor() { super("Artifact blob storage is unavailable"); }
}

const safeEndpoint = (value: string): string => {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("S3_ENDPOINT must be a valid HTTP(S) URL"); }
  if (!(["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("S3_ENDPOINT must be an HTTP(S) URL without credentials, query, or fragment");
  }
  return parsed.toString().replace(/\/$/, "");
};

const isNotFound = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return value.name === "NotFound" || value.name === "NoSuchKey" || value.name === "NoSuchBucket" || value.$metadata?.httpStatusCode === 404;
};

const asBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return Buffer.from(value);
  throw new ArtifactBlobStoreUnavailableError();
};

const readBodyLimited = async (body: unknown): Promise<Uint8Array> => {
  if (!body) throw new ArtifactBlobStoreUnavailableError();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function") {
    for await (const chunk of body as AsyncIterable<unknown>) {
      const bytes = asBytes(chunk);
      total += bytes.byteLength;
      if (total > MAX_ARTIFACT_BYTES) throw new InvalidArtifactError("Artifact exceeds 10 MB");
      chunks.push(bytes);
    }
    return Uint8Array.from(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total));
  }
  const transform = (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray;
  if (typeof transform !== "function") throw new ArtifactBlobStoreUnavailableError();
  const bytes = await transform.call(body);
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new InvalidArtifactError("Artifact exceeds 10 MB");
  return Uint8Array.from(bytes);
};

export class S3ArtifactBlobStore implements ArtifactBlobStore {
  readonly backend = "s3" as const;
  constructor(
    private readonly client: S3CommandClient,
    private readonly bucket: string,
    private readonly createBucketIfMissing = false
  ) {
    if (!BUCKET.test(bucket)) throw new Error("S3_BUCKET is invalid");
  }

  private key(artifactId: string): string {
    if (!ARTIFACT_ID.test(artifactId)) throw new InvalidArtifactError("Invalid artifact id");
    return `artifacts/${artifactId}`;
  }

  async initialize(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (!this.createBucketIfMissing || !isNotFound(error)) throw new ArtifactBlobStoreUnavailableError();
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch {
        throw new ArtifactBlobStoreUnavailableError();
      }
    }
  }

  async checkReadiness(): Promise<void> {
    try { await this.client.send(new HeadBucketCommand({ Bucket: this.bucket })); }
    catch { throw new ArtifactBlobStoreUnavailableError(); }
  }

  async put(artifactId: string, content: Uint8Array): Promise<void> {
    const Key = this.key(artifactId);
    if (content.byteLength > MAX_ARTIFACT_BYTES) throw new InvalidArtifactError("Artifact exceeds 10 MB");
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key,
        Body: Uint8Array.from(content),
        ContentLength: content.byteLength,
        ContentType: "application/octet-stream"
      }));
    } catch { throw new ArtifactBlobStoreUnavailableError(); }
  }

  async get(artifactId: string): Promise<Uint8Array | undefined> {
    const Key = this.key(artifactId);
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key }));
      const contentLength = result.ContentLength;
      if (typeof contentLength === "number" && contentLength > MAX_ARTIFACT_BYTES) throw new InvalidArtifactError("Artifact exceeds 10 MB");
      return await readBodyLimited(result.Body);
    } catch (error) {
      if (error instanceof InvalidArtifactError) throw error;
      if (isNotFound(error)) return undefined;
      if (error instanceof ArtifactBlobStoreUnavailableError) throw error;
      throw new ArtifactBlobStoreUnavailableError();
    }
  }

  async close(): Promise<void> { this.client.destroy?.(); }
}

export interface ArtifactBlobStoreSelection {
  store: ArtifactBlobStore;
  configured: boolean;
  initialize(): Promise<void>;
}

const optionalBoolean = (name: string, value: string | undefined): boolean => {
  if (value === undefined || value === "") return false;
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
  return value === "true";
};

export const createArtifactBlobStoreFromEnv = (env: NodeJS.ProcessEnv = process.env): ArtifactBlobStoreSelection => {
  const preferredNames = ["ARTIFACT_S3_ENDPOINT", "ARTIFACT_S3_BUCKET", "ARTIFACT_S3_REGION", "ARTIFACT_S3_ACCESS_KEY", "ARTIFACT_S3_SECRET_KEY"] as const;
  const legacyNames = ["S3_ENDPOINT", "S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY"] as const;
  const preferredValues = preferredNames.map((name) => env[name]?.trim() ?? "");
  const legacyValues = legacyNames.map((name) => env[name]?.trim() ?? "");
  const hasPreferred = preferredValues.some(Boolean);
  const hasLegacy = legacyValues.some(Boolean);
  if (hasPreferred && hasLegacy) throw new Error("Use only ARTIFACT_S3_* configuration names");
  const values = hasPreferred ? preferredValues : legacyValues;
  if (values.every((value) => value === "")) {
    const store = new InMemoryArtifactBlobStore();
    return { store, configured: false, initialize: async () => {} };
  }
  if (values.some((value) => value === "")) throw new Error("S3 artifact storage configuration is incomplete");
  const [endpoint, bucket, region, accessKeyId, secretAccessKey] = values as [string, string, string, string, string];
  if (!region || region.length > 100) throw new Error("S3_REGION is invalid");
  const createBucketIfMissing = optionalBoolean("ARTIFACT_S3_CREATE_BUCKET", env.ARTIFACT_S3_CREATE_BUCKET ?? env.S3_CREATE_BUCKET);
  const forcePathStyleValue = env.ARTIFACT_S3_FORCE_PATH_STYLE ?? env.S3_FORCE_PATH_STYLE;
  const forcePathStyle = forcePathStyleValue === undefined || forcePathStyleValue === ""
    ? true
    : optionalBoolean("ARTIFACT_S3_FORCE_PATH_STYLE", forcePathStyleValue);
  const client = new S3Client({
    endpoint: safeEndpoint(endpoint),
    region,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey }
  });
  const store = new S3ArtifactBlobStore(client as S3CommandClient, bucket, createBucketIfMissing);
  return { store, configured: true, initialize: () => store.initialize() };
};
