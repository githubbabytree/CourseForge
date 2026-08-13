import { createHash } from "node:crypto";
import { DesignTemplateVersionV1Schema, type DesignTemplateVersionV1 } from "@courseforge/contracts";

export interface DesignTemplateStore {
  create(value: DesignTemplateVersionV1): Promise<boolean>;
  list(): Promise<DesignTemplateVersionV1[]>;
  find(templateId: string): Promise<DesignTemplateVersionV1 | undefined>;
  transition(templateId: string, operation: "publish" | "deactivate", at: string): Promise<DesignTemplateVersionV1 | undefined>;
}

export const designTemplateHash = (value: Pick<DesignTemplateVersionV1, "name" | "version" | "themeTokens" | "layoutConstraints">): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class InMemoryDesignTemplateStore implements DesignTemplateStore {
  private readonly values = new Map<string, DesignTemplateVersionV1>();
  async create(value: DesignTemplateVersionV1) {
    if ([...this.values.values()].some(item => item.name === value.name && item.version === value.version)) return false;
    this.values.set(value.templateId, structuredClone(value)); return true;
  }
  async list() { return [...this.values.values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(value=>structuredClone(value)); }
  async find(id: string) { const value=this.values.get(id); return value ? structuredClone(value) : undefined; }
  async transition(id: string, operation: "publish" | "deactivate", at: string) {
    const current=this.values.get(id); const expected=operation === "publish" ? "draft" : "published";
    if (!current || current.status !== expected) return undefined;
    if (operation === "publish" && [...this.values.values()].some(item => item.name === current.name && item.status === "published")) return undefined;
    const next=DesignTemplateVersionV1Schema.parse({...current,status:operation === "publish" ? "published" : "inactive",publishedAt:operation === "publish" ? at : current.publishedAt,inactiveAt:operation === "deactivate" ? at : null});
    this.values.set(id,next); return structuredClone(next);
  }
}

interface Sql { query<R=Record<string,unknown>>(text:string,values?:readonly unknown[]):Promise<{rows:R[];rowCount?:number|null}> }
export class PostgresDesignTemplateStore implements DesignTemplateStore {
  constructor(private readonly sql: Sql) {}
  async create(value: DesignTemplateVersionV1) { const result=await this.sql.query("INSERT INTO design_template_versions(template_id,name,version,status,content_hash,document,created_at,created_by,published_at,inactive_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10) ON CONFLICT(name,version) DO NOTHING",[value.templateId,value.name,value.version,value.status,value.contentHash,JSON.stringify(value),value.createdAt,value.createdBy,value.publishedAt,value.inactiveAt]); return (result.rowCount??0)>0; }
  async list() { const result=await this.sql.query<{document:unknown}>("SELECT document FROM design_template_versions ORDER BY created_at DESC"); return result.rows.map(row=>DesignTemplateVersionV1Schema.parse(row.document)); }
  async find(id:string) { const result=await this.sql.query<{document:unknown}>("SELECT document FROM design_template_versions WHERE template_id=$1",[id]); return result.rows[0] ? DesignTemplateVersionV1Schema.parse(result.rows[0].document) : undefined; }
  async transition(id:string,operation:"publish"|"deactivate",at:string) { const from=operation === "publish" ? "draft" : "published"; const to=operation === "publish" ? "published" : "inactive"; const result=await this.sql.query<{document:unknown}>("UPDATE design_template_versions SET status=$2,published_at=CASE WHEN $2='published' THEN $3 ELSE published_at END,inactive_at=CASE WHEN $2='inactive' THEN $3 ELSE NULL END,document=jsonb_set(jsonb_set(jsonb_set(document,'{status}',to_jsonb($2::text)),'{publishedAt}',CASE WHEN $2='published' THEN to_jsonb($5) ELSE COALESCE(document->'publishedAt','null'::jsonb) END),'{inactiveAt}',CASE WHEN $2='inactive' THEN to_jsonb($5) ELSE COALESCE(document->'inactiveAt','null'::jsonb) END)) WHERE template_id=$1 AND status=$4 RETURNING document",[id,to,at,from,at]); return result.rows[0] ? DesignTemplateVersionV1Schema.parse(result.rows[0].document) : undefined; }
}
