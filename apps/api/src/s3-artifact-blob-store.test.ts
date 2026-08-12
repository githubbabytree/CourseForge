import assert from "node:assert/strict";
import test from "node:test";
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { InvalidArtifactError } from "./artifacts.js";
import {
  ArtifactBlobStoreUnavailableError,
  S3ArtifactBlobStore,
  createArtifactBlobStoreFromEnv,
  type S3CommandClient
} from "./s3-artifact-blob-store.js";

const ARTIFACT_ID = `artifact-${"a".repeat(64)}`;
const OTHER_ID = `artifact-${"b".repeat(64)}`;

class FakeS3Client implements S3CommandClient {
  readonly commands: Array<PutObjectCommand | GetObjectCommand | HeadBucketCommand | CreateBucketCommand> = [];
  readonly responses: Array<Record<string, unknown> | Error> = [];
  destroyed = false;
  async send(command: PutObjectCommand | GetObjectCommand | HeadBucketCommand | CreateBucketCommand): Promise<Record<string, unknown>> {
    this.commands.push(command);
    const response = this.responses.shift() ?? {};
    if (response instanceof Error) throw response;
    return response;
  }
  destroy() { this.destroyed = true; }
}

const notFound = (): Error => Object.assign(new Error("object location must not escape"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });

test("S3 store derives a fixed bucket/key and returns defensive bytes", async () => {
  const client = new FakeS3Client();
  const store = new S3ArtifactBlobStore(client, "courseforge-artifacts");
  const original = Uint8Array.from([1, 2, 3]);
  await store.put(ARTIFACT_ID, original);
  original[0] = 9;
  const put = client.commands[0];
  assert.ok(put instanceof PutObjectCommand);
  assert.deepEqual(put.input, {
    Bucket: "courseforge-artifacts", Key: `artifacts/${ARTIFACT_ID}`,
    Body: Uint8Array.from([1, 2, 3]), ContentLength: 3, ContentType: "application/octet-stream"
  });

  async function* body() { yield Uint8Array.from([4]); yield Uint8Array.from([5, 6]); }
  client.responses.push({ Body: body(), ContentLength: 3 });
  assert.deepEqual(await store.get(OTHER_ID), Uint8Array.from([4, 5, 6]));
  const get = client.commands[1];
  assert.ok(get instanceof GetObjectCommand);
  assert.deepEqual(get.input, { Bucket: "courseforge-artifacts", Key: `artifacts/${OTHER_ID}` });
});

test("S3 store rejects arbitrary keys and content over 10 MB", async () => {
  const client = new FakeS3Client();
  const store = new S3ArtifactBlobStore(client, "courseforge-artifacts");
  await assert.rejects(() => store.put("../other", Uint8Array.of(1)), InvalidArtifactError);
  await assert.rejects(() => store.get("s3://other/private"), InvalidArtifactError);
  await assert.rejects(() => store.put(ARTIFACT_ID, new Uint8Array(10 * 1024 * 1024 + 1)), InvalidArtifactError);
  client.responses.push({ Body: { transformToByteArray: async () => new Uint8Array() }, ContentLength: 10 * 1024 * 1024 + 1 });
  await assert.rejects(() => store.get(ARTIFACT_ID), InvalidArtifactError);
  assert.equal(client.commands.length, 1);
});

test("S3 store maps not found to undefined and sanitizes provider errors", async () => {
  const client = new FakeS3Client();
  const store = new S3ArtifactBlobStore(client, "courseforge-artifacts");
  client.responses.push(notFound());
  assert.equal(await store.get(ARTIFACT_ID), undefined);
  const privateDetail = ["credential", "must-not-leak"].join(":");
  client.responses.push(new Error(privateDetail));
  await assert.rejects(() => store.put(ARTIFACT_ID, Uint8Array.of(1)), (error: unknown) => {
    assert.ok(error instanceof ArtifactBlobStoreUnavailableError);
    assert.doesNotMatch(String(error), /must-not-leak/);
    return true;
  });
});

test("bucket readiness is fail-closed and optional creation is explicit", async () => {
  const client = new FakeS3Client();
  const store = new S3ArtifactBlobStore(client, "courseforge-artifacts", true);
  client.responses.push(notFound(), {}, {});
  await store.initialize();
  assert.ok(client.commands[0] instanceof HeadBucketCommand);
  assert.ok(client.commands[1] instanceof CreateBucketCommand);
  assert.ok(client.commands[2] instanceof HeadBucketCommand);
  await store.close();
  assert.equal(client.destroyed, true);

  const noCreateClient = new FakeS3Client();
  noCreateClient.responses.push(notFound());
  await assert.rejects(() => new S3ArtifactBlobStore(noCreateClient, "courseforge-artifacts").initialize(), ArtifactBlobStoreUnavailableError);
  assert.equal(noCreateClient.commands.length, 1);
});

test("environment factory is all-or-none and defaults to in-memory", () => {
  const memory = createArtifactBlobStoreFromEnv({});
  assert.equal(memory.configured, false);
  assert.equal(memory.store.backend, "in-memory");
  assert.throws(() => createArtifactBlobStoreFromEnv({ ARTIFACT_S3_ENDPOINT: "http://object-store:9000" }), /incomplete/);
  assert.throws(() => createArtifactBlobStoreFromEnv({
    ARTIFACT_S3_ENDPOINT: "http://user:pass@object-store:9000", ARTIFACT_S3_BUCKET: "courseforge-artifacts",
    ARTIFACT_S3_REGION: "local", ARTIFACT_S3_ACCESS_KEY: "local-user", ARTIFACT_S3_SECRET_KEY: "local-pass"
  }), /without credentials/);
  assert.throws(() => createArtifactBlobStoreFromEnv({
    ARTIFACT_S3_ENDPOINT: "http://object-store:9000", ARTIFACT_S3_BUCKET: "courseforge-artifacts",
    ARTIFACT_S3_REGION: "local", ARTIFACT_S3_ACCESS_KEY: "local-user", ARTIFACT_S3_SECRET_KEY: "local-pass",
    ARTIFACT_S3_FORCE_PATH_STYLE: "sometimes"
  }), /must be true or false/);
});
