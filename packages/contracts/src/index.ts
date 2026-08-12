import { z } from "zod";

export const CONTRACT_VERSION = "1" as const;

const Versioned = z.object({ schemaVersion: z.literal(CONTRACT_VERSION) });

export const USER_ROLES = ["platform_admin", "course_editor", "viewer", "auditor"] as const;
export const UserRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  ["password"]: z.string().min(12).max(1_024)
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const SessionUserV1Schema = Versioned.extend({
  userId: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().min(1).max(120),
  role: UserRoleSchema
});
export type SessionUserV1 = z.infer<typeof SessionUserV1Schema>;

export const CourseBriefV1Schema = Versioned.extend({
  title: z.string().trim().min(1).max(160),
  idea: z.string().trim().min(1).max(20_000),
  audience: z.string().trim().min(1).max(500).default("大型互联网公司全体员工"),
  durationMinutes: z.number().int().min(5).max(240).default(20),
  objectives: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  background: z.string().trim().max(5_000).default(""),
  locale: z.literal("zh-CN").default("zh-CN"),
  sourceArtifactIds: z.array(z.string().uuid()).default([])
});
export type CourseBriefV1 = z.infer<typeof CourseBriefV1Schema>;

export const SUPPORTED_SOURCE_MEDIA_TYPES = ["text/plain", "text/markdown"] as const;
export const SourceMediaTypeSchema = z.enum(SUPPORTED_SOURCE_MEDIA_TYPES);
export type SourceMediaType = z.infer<typeof SourceMediaTypeSchema>;

export const SourceLocatorV1Schema = Versioned.extend({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive()
}).superRefine((value, context) => {
  if (value.endLine < value.startLine) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endLine"], message: "endLine must not precede startLine" });
  }
  if (value.endOffset <= value.startOffset) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endOffset"], message: "endOffset must follow startOffset" });
  }
});
export type SourceLocatorV1 = z.infer<typeof SourceLocatorV1Schema>;

export const ExtractedSectionV1Schema = Versioned.extend({
  sectionId: z.string().regex(/^section-[a-f0-9]{16}$/),
  ordinal: z.number().int().nonnegative(),
  heading: z.string().trim().min(1).max(500).optional(),
  text: z.string().trim().min(1).max(100_000),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  locator: SourceLocatorV1Schema
});
export type ExtractedSectionV1 = z.infer<typeof ExtractedSectionV1Schema>;

export const SourceArtifactV1Schema = Versioned.extend({
  sourceArtifactId: z.string().uuid(),
  projectId: z.string().uuid(),
  displayName: z.string().trim().min(1).max(255),
  createdAt: z.string().datetime(),
  currentRevisionId: z.string().uuid().nullable().default(null)
});
export type SourceArtifactV1 = z.infer<typeof SourceArtifactV1Schema>;

export const SourceRevisionV1Schema = Versioned.extend({
  sourceRevisionId: z.string().uuid(),
  sourceArtifactId: z.string().uuid(),
  revision: z.number().int().positive(),
  filename: z.string().trim().min(1).max(255),
  mediaType: SourceMediaTypeSchema,
  byteSize: z.number().int().positive().max(2 * 1024 * 1024),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  importedAt: z.string().datetime(),
  extractionMethod: z.literal("plain-text-v1"),
  sections: z.array(ExtractedSectionV1Schema).min(1).max(10_000)
}).superRefine((value, context) => {
  const ids = new Set<string>();
  value.sections.forEach((section, index) => {
    if (section.ordinal !== index) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", index, "ordinal"], message: "section ordinals must be contiguous" });
    }
    if (ids.has(section.sectionId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", index, "sectionId"], message: "sectionId must be unique" });
    }
    ids.add(section.sectionId);
  });
});
export type SourceRevisionV1 = z.infer<typeof SourceRevisionV1Schema>;

export const CitationV1Schema = Versioned.extend({
  citationId: z.string().regex(/^citation-[a-f0-9]{16}$/),
  sourceArtifactId: z.string().uuid(),
  sourceRevisionId: z.string().uuid(),
  sectionId: z.string().regex(/^section-[a-f0-9]{16}$/),
  locator: SourceLocatorV1Schema,
  quote: z.string().trim().min(1).max(2_000),
  quoteSha256: z.string().regex(/^[a-f0-9]{64}$/)
});
export type CitationV1 = z.infer<typeof CitationV1Schema>;

export const MaterialRevisionV1Schema = Versioned.extend({
  materialRevisionId: z.string().uuid(),
  projectId: z.string().uuid(),
  revision: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  markdown: z.string().trim().min(1).max(1_000_000),
  sourceRevisionIds: z.array(z.string().uuid()).min(1).max(1_000),
  citations: z.array(CitationV1Schema).max(20_000),
  createdAt: z.string().datetime()
}).superRefine((value, context) => {
  const sourceRevisionIds = new Set(value.sourceRevisionIds);
  value.citations.forEach((citation, index) => {
    if (!sourceRevisionIds.has(citation.sourceRevisionId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["citations", index, "sourceRevisionId"],
        message: "citation must reference one of sourceRevisionIds"
      });
    }
  });
});
export type MaterialRevisionV1 = z.infer<typeof MaterialRevisionV1Schema>;

export const SlideBlockV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), body: z.string().min(1).max(10_000) }),
  z.object({ kind: z.literal("bullets"), items: z.array(z.string().min(1).max(1_000)).min(1).max(12) }),
  z.object({ kind: z.literal("quote"), body: z.string().min(1).max(2_000), attribution: z.string().max(500).optional() }),
  z.object({ kind: z.literal("image"), assetId: z.string().uuid(), alt: z.string().min(1).max(500) })
]);

export const SlideSpecV1Schema = Versioned.extend({
  slideId: z.string().regex(/^slide-[a-z0-9-]+$/),
  title: z.string().min(1).max(200),
  layout: z.enum(["title", "content", "split", "quote", "summary"]),
  blocks: z.array(SlideBlockV1Schema).max(12),
  speakerNotes: z.string().max(20_000),
  targetDurationSeconds: z.number().int().positive().max(1_800),
  learningObjectiveIds: z.array(z.string().min(1).max(100)).default([]),
  sourceIds: z.array(z.string().min(1).max(200)).default([]),
  transition: z.enum(["none", "fade", "slide", "convex"]).default("fade")
});
export type SlideSpecV1 = z.infer<typeof SlideSpecV1Schema>;

export const DeckSpecV1Schema = Versioned.extend({
  deckId: z.string().uuid(),
  revision: z.number().int().positive(),
  title: z.string().min(1).max(200),
  themeId: z.string().min(1).max(100),
  aspectRatio: z.literal("16:9"),
  slides: z.array(SlideSpecV1Schema).min(1).max(200)
});
export type DeckSpecV1 = z.infer<typeof DeckSpecV1Schema>;

export const ProviderBindingV1Schema = z.object({
  providerId: z.string().min(1).max(100),
  configVersion: z.string().min(1).max(100),
  model: z.string().min(1).max(200).optional(),
  capabilities: z.array(z.string().min(1).max(100)).default([])
});
export const ProviderConfigSnapshotV1Schema = Versioned.extend({
  snapshotId: z.string().uuid(),
  capturedAt: z.string().datetime(),
  bindings: z.record(z.enum(["text", "multimodal", "search", "design", "tts", "deckRenderer", "videoRenderer"]), ProviderBindingV1Schema),
  promptVersions: z.record(z.string(), z.string().min(1)),
  secretRefs: z.record(
    z.string(),
    z.string().regex(/^(secret|env):\/\/[A-Za-z0-9._/-]+$/, "Only secret:// or env:// references are allowed")
  ).default({})
});
export type ProviderConfigSnapshotV1 = z.infer<typeof ProviderConfigSnapshotV1Schema>;

export const JOB_STAGES = ["intake", "research", "material", "deck", "narration", "tts", "render", "qa", "publish"] as const;
export const JobStageSchema = z.enum(JOB_STAGES);
export const JobStatusSchema = z.enum(["queued", "running", "retrying", "failed", "cancelled", "completed"]);
export const JobEventV1Schema = Versioned.extend({
  eventId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  jobId: z.string().uuid(),
  projectId: z.string().uuid(),
  stage: JobStageSchema,
  status: JobStatusSchema,
  progressPercent: z.number().int().min(0).max(100),
  occurredAt: z.string().datetime(),
  elapsedMs: z.number().int().nonnegative(),
  message: z.string().min(1).max(500),
  attempt: z.number().int().positive()
});
export type JobEventV1 = z.infer<typeof JobEventV1Schema>;

export const AuditEventV1Schema = Versioned.extend({
  auditId: z.string().uuid(),
  actorId: z.string().min(1).max(200),
  action: z.string().min(1).max(200),
  resourceType: z.string().min(1).max(100),
  resourceId: z.string().min(1).max(200),
  outcome: z.enum(["success", "failure"]),
  occurredAt: z.string().datetime(),
  requestId: z.string().uuid(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({})
});
export type AuditEventV1 = z.infer<typeof AuditEventV1Schema>;

export const CreateProjectRequestSchema = z.object({ brief: CourseBriefV1Schema });
export const ProjectV1Schema = Versioned.extend({
  projectId: z.string().uuid(),
  ownerId: z.string().uuid(),
  brief: CourseBriefV1Schema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type ProjectV1 = z.infer<typeof ProjectV1Schema>;

export const JobV1Schema = Versioned.extend({
  jobId: z.string().uuid(),
  projectId: z.string().uuid(),
  status: JobStatusSchema,
  stage: JobStageSchema,
  progressPercent: z.number().int().min(0).max(100),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedStageKeys: z.array(z.string()),
  events: z.array(JobEventV1Schema)
});
export type JobV1 = z.infer<typeof JobV1Schema>;
