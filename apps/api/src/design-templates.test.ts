import assert from "node:assert/strict";
import test from "node:test";
import { DesignTemplateVersionV1Schema } from "@courseforge/contracts";
import { InMemoryDesignTemplateStore, designTemplateHash } from "./design-templates.js";

const actor="11111111-1111-4111-8111-111111111111";
const create=(name="security")=>{const body={name,version:"v1",themeTokens:{primary:"#31d6a0"},layoutConstraints:{allowedLayouts:["title" as const,"content" as const],maxBlocksPerSlide:6}};return DesignTemplateVersionV1Schema.parse({schemaVersion:"1",templateId:crypto.randomUUID(),...body,status:"draft",contentHash:designTemplateHash(body),createdAt:new Date(0).toISOString(),createdBy:actor,publishedAt:null,inactiveAt:null});};

test("design templates are immutable lifecycle versions with one published version per name",async()=>{const store=new InMemoryDesignTemplateStore();const value=create();assert.equal(await store.create(value),true);assert.equal(await store.create({...value,templateId:crypto.randomUUID()}),false);const published=await store.transition(value.templateId,"publish",new Date(1).toISOString());assert.equal(published?.status,"published");assert.equal(await store.transition(value.templateId,"publish",new Date(2).toISOString()),undefined);const inactive=await store.transition(value.templateId,"deactivate",new Date(3).toISOString());assert.equal(inactive?.status,"inactive");assert.equal(inactive?.contentHash,value.contentHash);});
