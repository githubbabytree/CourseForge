import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { InMemoryArtifactBlobStore, type ArtifactMetadataRecord } from "./artifacts.js";
import { buildWebPptPackage, createDeterministicZip, loadWebPptRuntimeAssets, type WebPptRuntimeAssets } from "./release-packaging.js";
import { InMemoryCourseForgeRepository } from "./repositories.js";

const projectId="11111111-1111-4111-8111-111111111111",jobId="22222222-2222-4222-8222-222222222222";
const hash=(value:Uint8Array)=>createHash("sha256").update(value).digest("hex");
const save=async(repository:InMemoryCourseForgeRepository,blobs:InMemoryArtifactBlobStore,kind:"deck-spec"|"reveal-html",mediaType:"application/json"|"text/html; charset=utf-8",bytes:Uint8Array)=>{
  const metadata:ArtifactMetadataRecord={artifactId:`artifact-${hash(bytes)}`,projectId,jobId,revision:1,configurationVersion:"snapshot",providerId:"fixture",kind,mediaType,contentHash:hash(bytes),byteLength:bytes.byteLength,sourceArtifactIds:[],createdAt:new Date(0).toISOString()};await blobs.put(metadata.artifactId,bytes);await repository.saveArtifactMetadata(metadata);return metadata;
};
const runtime:WebPptRuntimeAssets={revealJs:Buffer.from("reveal"),revealCss:Buffer.from("css"),themeCss:Buffer.from("theme"),notesJs:Buffer.from("notes"),bootstrapJs:Buffer.from("bootstrap"),revealLicense:Buffer.from("MIT")};

test("deterministic ZIP has fixed ordering and identical bytes",()=>{
  const entries=[{path:"z.txt",content:Buffer.from("z")},{path:"a.txt",content:Buffer.from("a")}];const one=createDeterministicZip(entries),two=createDeterministicZip([...entries].reverse());
  assert.deepEqual(one,two);assert.equal(hash(one),hash(two));assert.equal(Buffer.from(one).readUInt32LE(0),0x04034b50);assert.ok(Buffer.from(one).indexOf("a.txt")<Buffer.from(one).indexOf("z.txt"));
  assert.throws(()=>createDeterministicZip([{path:"../secret",content:Buffer.from("x")}]),/zip_path_unsafe/);
  assert.throws(()=>createDeterministicZip([{path:"safe.txt",content:Buffer.alloc(20*1024*1024+1)}]),/zip_entry_too_large/);
});

test("fresh runtime contains every self-hosted Reveal and CourseForge asset",async()=>{
  const assets=await loadWebPptRuntimeAssets();for(const bytes of Object.values(assets))assert.ok(bytes.byteLength>0);
  assert.match(Buffer.from(assets.revealLicense).toString("utf8"),/Permission is hereby granted/);
});

test("WebPPT bundle is self-hosted, reproducible and contains no internal URL or secret",async()=>{
  const repository=new InMemoryCourseForgeRepository(),blobs=new InMemoryArtifactBlobStore();
  const deck=Buffer.from(JSON.stringify({schemaVersion:"1",deckId:"33333333-3333-4333-8333-333333333333",revision:1,title:"安全课",themeId:"dark",aspectRatio:"16:9",slides:[{schemaVersion:"1",slideId:"slide-intro",title:"开始",layout:"content",blocks:[{kind:"text",body:"正文"}],speakerNotes:"逐页讲稿",targetDurationSeconds:10,learningObjectiveIds:[],sourceIds:["source-private"],transition:"fade"}]}));
  const html=Buffer.from('<!doctype html><link rel="stylesheet" href="/vendor/reveal/reveal.css"><link rel="stylesheet" href="/vendor/reveal/theme/black.css"><main></main><script src="/vendor/reveal/reveal.js"></script><script src="/vendor/reveal/plugin/notes/notes.js"></script><script src="/courseforge/deck-bootstrap.js"></script>');
  const deckArtifact=await save(repository,blobs,"deck-spec","application/json",deck),revealArtifact=await save(repository,blobs,"reveal-html","text/html; charset=utf-8",html);
  const input={repository,blobs,projectId,publishedCourseId:"44444444-4444-4444-8444-444444444444",revision:1,publishedAt:new Date(0).toISOString(),deckArtifactId:deckArtifact.artifactId,revealArtifactId:revealArtifact.artifactId,runtime};
  const first=await buildWebPptPackage(input),second=await buildWebPptPackage(input);assert.equal(hash(first.bytes),hash(second.bytes));
  const text=Buffer.from(first.bytes).toString("latin1");assert.match(text,/speaker-notes\.json/);assert.match(text,/reveal\.js-LICENSE\.txt/);assert.match(text,/SHA256SUMS/);assert.doesNotMatch(text,/\/v1\/|https?:|env:\/\//);
});
