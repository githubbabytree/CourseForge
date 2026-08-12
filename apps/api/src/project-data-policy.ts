import { createHash } from "node:crypto";
import { DEFAULT_PROJECT_DATA_POLICY, type ProjectV1, type ProviderConfigVersionV1 } from "@courseforge/contracts";

export type ProviderPayloadClass = "internal-content" | "public-query";

const strings=(value:unknown):string[]=>Array.isArray(value)&&value.every((item)=>typeof item==="string")?value:[];

/** Fail-closed gate. It must run before secret resolution, process spawn or fetch. */
export function enforceProjectDataPolicy(project:ProjectV1,config:ProviderConfigVersionV1,payloadClass:ProviderPayloadClass):void{
  const policy=project.dataPolicy??DEFAULT_PROJECT_DATA_POLICY;
  if(policy.mode==="offline")throw new Error("data_policy_offline_external_provider_forbidden");
  if(policy.mode==="public-only"){
    if(payloadClass!=="public-query"||config.kind!=="search")throw new Error("data_policy_public_only_content_forbidden");
    return;
  }
  if(config.settings.dataBoundary!=="internal")throw new Error("data_policy_internal_provider_not_marked");
  if(config.endpoint){const origin=new URL(config.endpoint).origin;if(!strings(config.settings.internalAllowedOrigins).includes(origin))throw new Error("data_policy_internal_origin_not_exact");}
  const executable=config.settings.executable;if(typeof executable==="string"&&!strings(config.settings.internalAllowedExecutables).includes(executable))throw new Error("data_policy_internal_executable_not_exact");
}

export const projectDataPolicyAuditMetadata=(project:ProjectV1)=>{const policy=project.dataPolicy??DEFAULT_PROJECT_DATA_POLICY;return{dataPolicyMode:policy.mode,dataPolicyHash:createHash("sha256").update(JSON.stringify(policy)).digest("hex")};};
