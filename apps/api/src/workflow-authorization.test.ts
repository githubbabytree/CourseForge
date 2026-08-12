import assert from "node:assert/strict";
import test from "node:test";
import {InMemoryCourseForgeRepository} from "./repositories.js";
import {requireWorkflowActor} from "./workflow-authorization.js";

const actorId="11111111-1111-4111-8111-111111111111",projectId="22222222-2222-4222-8222-222222222222";
test("durable executor reconstruction rejects revoked actors before provider construction",async()=>{
  const repository=new InMemoryCourseForgeRepository();
  const user={schemaVersion:"1" as const,userId:actorId,email:"worker@example.test",displayName:"Worker",role:"course_editor" as const,passwordHash:"fixture-hash",disabled:false,createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString()};
  await repository.createUser(user);await repository.grantProjectAccess(projectId,actorId);
  assert.equal((await requireWorkflowActor(repository,projectId,actorId)).userId,actorId);
  await repository.updateUser({...user,disabled:true});
  await assert.rejects(requireWorkflowActor(repository,projectId,actorId),/workflow_actor_unavailable/);
});
