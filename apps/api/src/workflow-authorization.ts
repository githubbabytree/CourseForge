import type { CourseForgeRepository } from "./repositories.js";

/** Revalidates durable-job authority on every executor reconstruction. */
export async function requireWorkflowActor(repository:CourseForgeRepository,projectId:string,actorId:string){
  const actor=await repository.findUserById(actorId);
  if(!actor||actor.disabled||(actor.role!=="platform_admin"&&!await repository.hasProjectAccess(projectId,actorId)))throw new Error("workflow_actor_unavailable");
  return actor;
}
