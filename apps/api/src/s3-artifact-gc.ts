import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ArtifactGarbageCollector } from "./retention.js";

const ARTIFACT_ID=/^artifact-[a-f0-9]{64}$/;const BUCKET=/^(?=.{3,63}$)(?!.*\.\.)(?!\d{1,3}(?:\.\d{1,3}){3}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/;
const endpoint=(value:string)=>{const parsed=new URL(value);if(!["http:","https:"].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error("GC S3 endpoint is invalid");return parsed.toString().replace(/\/$/,"");};

/** Uses a separately configured credential whose only required object permission is DeleteObject. */
export class S3ArtifactGarbageCollector implements ArtifactGarbageCollector{
  readonly backend="s3-gc" as const;
  constructor(private readonly client:S3Client,private readonly bucket:string){if(!BUCKET.test(bucket))throw new Error("GC S3 bucket is invalid");}
  async delete(artifactId:string){if(!ARTIFACT_ID.test(artifactId))throw new Error("invalid_artifact_id");await this.client.send(new DeleteObjectCommand({Bucket:this.bucket,Key:`artifacts/${artifactId}`}));}
}

export const createArtifactGcFromEnv=(env:NodeJS.ProcessEnv=process.env):ArtifactGarbageCollector|undefined=>{
  const names=["ARTIFACT_GC_S3_ENDPOINT","ARTIFACT_GC_S3_BUCKET","ARTIFACT_GC_S3_REGION","ARTIFACT_GC_S3_ACCESS_KEY","ARTIFACT_GC_S3_SECRET_KEY"] as const;const values=names.map((name)=>env[name]?.trim()??"");
  if(values.every((value)=>!value))return undefined;if(values.some((value)=>!value))throw new Error("All ARTIFACT_GC_S3_* values are required; API storage credentials are never reused for deletion");
  const client=new S3Client({endpoint:endpoint(values[0]!),region:values[2]!,forcePathStyle:true,credentials:{accessKeyId:values[3]!,secretAccessKey:values[4]!}});return new S3ArtifactGarbageCollector(client,values[1]!);
};
