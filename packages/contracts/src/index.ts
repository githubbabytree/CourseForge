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

export const PROJECT_DATA_POLICY_MODES = ["offline", "internal", "public-only"] as const;
export const ProjectDataPolicyModeSchema = z.enum(PROJECT_DATA_POLICY_MODES);
export const ProjectDataPolicyV1Schema = Versioned.extend({
  mode: ProjectDataPolicyModeSchema.default("offline"),
  classification: z.enum(["private", "internal", "public"]).default("private")
}).strict().superRefine((value, context) => {
  if (value.mode === "offline" && value.classification !== "private") context.addIssue({ code: z.ZodIssueCode.custom, path: ["classification"], message: "offline projects must remain private" });
  if (value.mode === "public-only" && value.classification !== "public") context.addIssue({ code: z.ZodIssueCode.custom, path: ["classification"], message: "public-only projects must use public classification" });
});
export type ProjectDataPolicyV1 = z.infer<typeof ProjectDataPolicyV1Schema>;
export const DEFAULT_PROJECT_DATA_POLICY: ProjectDataPolicyV1 = { schemaVersion: "1", mode: "offline", classification: "private" };

export const StrongPasswordSchema = z.string().min(12).max(1_024).superRefine((value, context) => {
  const requirements = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9]/u];
  if (!requirements.every((pattern) => pattern.test(value))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Password must contain upper-case, lower-case, number, and symbol characters" });
  }
});

export const ManagedUserV1Schema = SessionUserV1Schema.extend({
  disabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
export type ManagedUserV1 = z.infer<typeof ManagedUserV1Schema>;

export const CreateManagedUserRequestSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  displayName: z.string().trim().min(1).max(120),
  role: UserRoleSchema,
  ["password"]: StrongPasswordSchema
}).strict();
export type CreateManagedUserRequest = z.infer<typeof CreateManagedUserRequestSchema>;

export const UpdateManagedUserRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  role: UserRoleSchema.optional(),
  disabled: z.boolean().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "At least one user field is required");
export type UpdateManagedUserRequest = z.infer<typeof UpdateManagedUserRequestSchema>;

export const ResetManagedUserPasswordRequestSchema = z.object({ ["password"]: StrongPasswordSchema }).strict();
export type ResetManagedUserPasswordRequest = z.infer<typeof ResetManagedUserPasswordRequestSchema>;

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

export const BriefAssistanceRequestSchema=z.object({snapshotId:z.string().uuid(),idea:z.string().trim().min(1).max(20_000),dataPolicy:ProjectDataPolicyV1Schema.default(DEFAULT_PROJECT_DATA_POLICY),partial:z.object({title:z.string().trim().max(160).optional(),audience:z.string().trim().max(500).optional(),durationMinutes:z.number().int().min(5).max(240).optional(),objectives:z.array(z.string().trim().min(1).max(500)).max(20).optional(),background:z.string().trim().max(5_000).optional()}).strict().default({})}).strict();
export const BriefOptionV1Schema=z.object({optionId:z.string().regex(/^option-[a-z0-9-]+$/),label:z.string().trim().min(1).max(100),description:z.string().trim().min(1).max(500),brief:CourseBriefV1Schema.omit({sourceArtifactIds:true}).extend({sourceArtifactIds:z.array(z.string().uuid()).length(0)})}).strict();
export const BriefAssistanceV1Schema=Versioned.extend({assistanceId:z.string().uuid(),snapshotId:z.string().uuid(),suggestion:CourseBriefV1Schema.omit({sourceArtifactIds:true}).extend({sourceArtifactIds:z.array(z.string().uuid()).length(0)}),options:z.array(BriefOptionV1Schema).min(2).max(3),createdAt:z.string().datetime()}).strict().superRefine((v,c)=>{const ids=new Set(v.options.map(o=>o.optionId));if(ids.size!==v.options.length)c.addIssue({code:z.ZodIssueCode.custom,path:["options"],message:"options must be mutually identifiable"})});
export type BriefAssistanceV1=z.infer<typeof BriefAssistanceV1Schema>;

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

export const ImageAssetV1Schema = Versioned.extend({
  assetId: z.string().uuid(),
  projectId: z.string().uuid(),
  artifactId: z.string().regex(/^artifact-[a-f0-9]{64}$/),
  metadataArtifactId: z.string().regex(/^artifact-[a-f0-9]{64}$/),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
  byteSize: z.number().int().positive().max(10 * 1024 * 1024),
  displayName: z.string().trim().min(1).max(255),
  source: z.object({
    kind: z.enum(["upload", "search-import"]),
    originalFilename: z.string().trim().min(1).max(255),
    sourceUrl: z.string().url().startsWith("https://").max(2_000).optional()
  }).strict(),
  licensing: z.object({
    status: z.enum(["company-owned", "licensed", "cc0", "unknown"]),
    attribution: z.string().trim().min(1).max(1_000).optional(),
    usage: z.string().trim().min(1).max(1_000).optional()
  }).strict(),
  createdAt: z.string().datetime(),
  createdBy: z.string().uuid()
}).strict().superRefine((value, context) => { if (value.source.kind === "search-import" && (!value.source.sourceUrl || value.licensing.status === "unknown" || !value.licensing.attribution || !value.licensing.usage)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["licensing"], message: "search imports require verified source, author, license and usage" }); });
export type ImageAssetV1 = z.infer<typeof ImageAssetV1Schema>;

export const ImageSearchCandidateV1Schema = Versioned.extend({
  candidateId: z.string().uuid(), projectId: z.string().uuid(), snapshotId: z.string().uuid(),
  query: z.string().trim().min(1).max(2_000), title: z.string().trim().min(1).max(1_000),
  sourcePageUrl: z.string().url().startsWith("https://").max(2_000), previewImageUrl: z.string().url().startsWith("https://").max(2_000).optional(),
  snippet: z.string().max(5_000), providerId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  status: z.literal("candidate-unverified"), discoveredAt: z.string().datetime()
}).strict();
export type ImageSearchCandidateV1 = z.infer<typeof ImageSearchCandidateV1Schema>;

export const ImageSearchCandidateSetV1Schema = Versioned.extend({
  searchId: z.string().uuid(), projectId: z.string().uuid(), snapshotId: z.string().uuid(), query: z.string().trim().min(1).max(2_000),
  candidates: z.array(ImageSearchCandidateV1Schema).max(20), createdAt: z.string().datetime(), createdBy: z.string().uuid()
}).strict();
export type ImageSearchCandidateSetV1 = z.infer<typeof ImageSearchCandidateSetV1Schema>;

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

export const SOURCE_V2_MEDIA_TYPES = [
  "text/plain",
  "text/markdown",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation"
] as const;
export const SourceMediaTypeV2Schema = z.enum(SOURCE_V2_MEDIA_TYPES);
export type SourceMediaTypeV2 = z.infer<typeof SourceMediaTypeV2Schema>;

const OffsetLocatorV2 = z.object({
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive()
});

export const SourceLocatorV2Schema = z.union([
  OffsetLocatorV2.extend({ kind: z.literal("text"), startLine: z.number().int().positive(), endLine: z.number().int().positive() })
    .refine((value) => value.endOffset > value.startOffset && value.endLine >= value.startLine, { message: "text locator range is invalid" }),
  OffsetLocatorV2.extend({
    kind: z.literal("pdf"), pageNumber: z.number().int().positive(),
    itemStart: z.number().int().nonnegative(), itemEnd: z.number().int().positive()
  }).refine((value) => value.endOffset > value.startOffset && value.itemEnd > value.itemStart, { message: "PDF locator range is invalid" }),
  OffsetLocatorV2.extend({
    kind: z.literal("docx"), partPath: z.literal("word/document.xml"),
    paragraphIndex: z.number().int().nonnegative(), xmlStartOffset: z.number().int().nonnegative(),
    xmlEndOffset: z.number().int().positive()
  }).refine((value) => value.endOffset > value.startOffset && value.xmlEndOffset > value.xmlStartOffset, { message: "DOCX locator range is invalid" }),
  OffsetLocatorV2.extend({
    kind: z.literal("pptx"), slideNumber: z.number().int().positive(),
    partPath: z.string().regex(/^ppt\/(?:slides|notesSlides)\/[A-Za-z0-9._-]+\.xml$/),
    shapeIndex: z.number().int().nonnegative(), source: z.enum(["slide", "notes"])
  }).refine((value) => value.endOffset > value.startOffset, { message: "PPTX locator range is invalid" })
]);
export type SourceLocatorV2 = z.infer<typeof SourceLocatorV2Schema>;

export const ExtractedSectionV2Schema = z.object({
  schemaVersion: z.literal("2"),
  sectionId: z.string().regex(/^section-[a-f0-9]{16}$/),
  ordinal: z.number().int().nonnegative(),
  heading: z.string().trim().min(1).max(500).optional(),
  text: z.string().trim().min(1).max(100_000),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  locator: SourceLocatorV2Schema
});
export type ExtractedSectionV2 = z.infer<typeof ExtractedSectionV2Schema>;

export const SourceSecurityInspectionV2Schema = z.object({
  status: z.literal("passed"),
  checks: z.array(z.string().trim().min(1).max(100)).min(1).max(100),
  warnings: z.array(z.string().trim().min(1).max(500)).max(100).default([])
});
export type SourceSecurityInspectionV2 = z.infer<typeof SourceSecurityInspectionV2Schema>;

export const SourceExtractionMethodV2Schema = z.enum(["plain-text-v2", "pdf-text-v1", "docx-wordprocessingml-v1", "pptx-openxml-v1"]);

export const SourceRevisionV2Schema = z.object({
  schemaVersion: z.literal("2"),
  sourceRevisionId: z.string().uuid(),
  sourceArtifactId: z.string().uuid(),
  revision: z.number().int().positive(),
  filename: z.string().trim().min(1).max(255),
  mediaType: SourceMediaTypeV2Schema,
  byteSize: z.number().int().positive().max(20 * 1024 * 1024),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  rawBlobId: z.string().regex(/^artifact-[a-f0-9]{64}$/),
  importedAt: z.string().datetime(),
  parser: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/), version: z.string().min(1).max(100) }),
  extractionMethod: SourceExtractionMethodV2Schema,
  securityInspection: SourceSecurityInspectionV2Schema,
  sections: z.array(ExtractedSectionV2Schema).min(1).max(10_000)
}).superRefine((value, context) => {
  const ids = new Set<string>();
  value.sections.forEach((section, index) => {
    if (section.ordinal !== index) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", index, "ordinal"], message: "section ordinals must be contiguous" });
    if (ids.has(section.sectionId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sections", index, "sectionId"], message: "sectionId must be unique" });
    ids.add(section.sectionId);
  });
});
export type SourceRevisionV2 = z.infer<typeof SourceRevisionV2Schema>;
export const AnySourceRevisionSchema = z.union([SourceRevisionV1Schema, SourceRevisionV2Schema]);
export type AnySourceRevision = z.infer<typeof AnySourceRevisionSchema>;

export const DocumentExtractionV2Schema = z.object({
  schemaVersion: z.literal("2"),
  mediaType: SourceMediaTypeV2Schema,
  parser: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/), version: z.string().min(1).max(100) }),
  extractionMethod: SourceExtractionMethodV2Schema,
  normalizedText: z.string().trim().min(1).max(2 * 1024 * 1024),
  securityInspection: SourceSecurityInspectionV2Schema,
  sections: z.array(ExtractedSectionV2Schema).min(1).max(10_000)
});
export type DocumentExtractionV2 = z.infer<typeof DocumentExtractionV2Schema>;

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

const ArtifactIdSchema = z.string().regex(/^artifact-[a-f0-9]{64}$/);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

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
  designBinding: z.object({
    planArtifactId: ArtifactIdSchema,
    planContentHash: Sha256Schema,
    directionId: z.string().min(1).max(100),
    templateId: z.string().uuid().nullable(),
    templateContentHash: Sha256Schema.nullable(),
    brandAssetIds: z.array(z.string().uuid()).max(100),
    brandAssetContentHashes: z.record(z.string().uuid(), Sha256Schema),
    usedDefaultDirection: z.boolean()
  }).strict().optional(),
  slides: z.array(SlideSpecV1Schema).min(1).max(200)
});
export type DeckSpecV1 = z.infer<typeof DeckSpecV1Schema>;
export const DesignDirectionV1Schema = z.object({ directionId: z.string().min(1).max(100), name: z.string().min(1).max(200), rationale: z.string().min(1).max(2_000), themeTokens: z.record(z.string(), z.string()).refine(v => Object.keys(v).length <= 64) }).strict();
export const DesignPlanV1Schema = Versioned.extend({ planId: z.string().uuid(), projectId: z.string().uuid(), snapshotId: z.string().uuid(), materialArtifactId: ArtifactIdSchema, materialContentHash: Sha256Schema, directions: z.array(DesignDirectionV1Schema).min(1).max(3), defaultDirectionId: z.string().min(1).max(100), createdAt: z.string().datetime() }).strict();
export type DesignPlanV1 = z.infer<typeof DesignPlanV1Schema>;
export const CreateDesignTemplateRequestSchema=z.object({name:z.string().min(1).max(160),version:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/),themeTokens:z.record(z.string(),z.string()).refine(v=>Object.keys(v).length<=64),layoutConstraints:z.object({allowedLayouts:z.array(z.enum(["title","content","split","quote","summary"])).min(1),maxBlocksPerSlide:z.number().int().min(1).max(12)}).strict()}).strict();
export const DesignTemplateVersionV1Schema=Versioned.extend({templateId:z.string().uuid(),...CreateDesignTemplateRequestSchema.shape,status:z.enum(["draft","published","inactive"]),contentHash:Sha256Schema,createdAt:z.string().datetime(),createdBy:z.string().uuid(),publishedAt:z.string().datetime().nullable(),inactiveAt:z.string().datetime().nullable()}).strict();export type DesignTemplateVersionV1=z.infer<typeof DesignTemplateVersionV1Schema>;

export const RevisionDocumentKindSchema = z.enum(["deck", "material"]);
export type RevisionDocumentKind = z.infer<typeof RevisionDocumentKindSchema>;

export const RevisionLockV1Schema = z.object({
  path: z.string().regex(/^\/(?:title|themeId|audience|objective|slides\/\d+(?:\/[A-Za-z0-9_-]+(?:\/\d+)?)?|sections\/\d+(?:\/[A-Za-z0-9_-]+(?:\/\d+)?)?)$/),
  locked: z.boolean()
}).strict();
export type RevisionLockV1 = z.infer<typeof RevisionLockV1Schema>;

export const RevisionRecordV1Schema = Versioned.extend({
  revisionId: z.string().uuid(),
  projectId: z.string().uuid(),
  kind: RevisionDocumentKindSchema,
  revision: z.number().int().positive(),
  parentRevisionId: z.string().uuid().nullable(),
  artifactId: ArtifactIdSchema,
  contentHash: Sha256Schema,
  configurationSnapshotId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  createdBy: z.string().uuid(),
  reason: z.enum(["generated", "manual", "ai", "restore"]),
  locks: z.array(RevisionLockV1Schema).max(2_000),
  slideHashes: z.record(z.string().regex(/^slide-[a-z0-9-]+$/), Sha256Schema).default({}),
  dirtySlideIds: z.array(z.string().regex(/^slide-[a-z0-9-]+$/)).max(200).default([]),
  reusedSlideIds: z.array(z.string().regex(/^slide-[a-z0-9-]+$/)).max(200).default([]),
  mediaState: z.enum(["not_applicable", "stale_requires_regeneration"]).default("not_applicable")
}).strict();
export type RevisionRecordV1 = z.infer<typeof RevisionRecordV1Schema>;

export const JsonPatchOperationV1Schema = z.object({
  op: z.enum(["add", "remove", "replace"]),
  path: z.string().min(1).max(500),
  value: z.unknown().optional()
}).strict().superRefine((operation, context) => {
  if (operation.op !== "remove" && operation.value === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "add and replace require a value" });
  if (operation.op === "remove" && operation.value !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "remove cannot include a value" });
});
export type JsonPatchOperationV1 = z.infer<typeof JsonPatchOperationV1Schema>;

export const CreateRevisionProposalRequestSchema = z.object({
  kind: RevisionDocumentKindSchema,
  baseRevisionId: z.string().uuid(),
  baseContentHash: Sha256Schema,
  mode: z.enum(["manual", "ai"]),
  patch: z.array(JsonPatchOperationV1Schema).min(1).max(100).optional(),
  instruction: z.string().trim().min(1).max(20_000).optional(),
  configurationSnapshotId: z.string().uuid().optional()
}).strict().superRefine((value, context) => {
  if (value.mode === "manual" && !value.patch) context.addIssue({ code: z.ZodIssueCode.custom, path: ["patch"], message: "manual mode requires patch" });
  if (value.mode === "ai" && (!value.instruction || !value.configurationSnapshotId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["instruction"], message: "AI mode requires instruction and configuration snapshot" });
});
export type CreateRevisionProposalRequest = z.infer<typeof CreateRevisionProposalRequestSchema>;

export const RevisionProposalV1Schema = Versioned.extend({
  proposalId: z.string().uuid(), projectId: z.string().uuid(), kind: RevisionDocumentKindSchema,
  baseRevisionId: z.string().uuid(), baseContentHash: Sha256Schema,
  mode: z.enum(["manual", "ai"]), patch: z.array(JsonPatchOperationV1Schema).min(1).max(100),
  changedPaths: z.array(z.string().min(1).max(500)).min(1).max(100),
  configurationSnapshotId: z.string().uuid().nullable(), createdAt: z.string().datetime(), createdBy: z.string().uuid(),
  status: z.enum(["pending", "applied"])
}).strict();
export type RevisionProposalV1 = z.infer<typeof RevisionProposalV1Schema>;

export const RestoreRevisionRequestSchema = z.object({ revisionId: z.string().uuid(), baseRevisionId: z.string().uuid(), baseContentHash: Sha256Schema }).strict();

export const SpeechSentenceV1Schema = Versioned.extend({
  sentenceId: z.string().regex(/^sentence-[a-f0-9]{16}$/),
  order: z.number().int().nonnegative(),
  text: z.string().trim().min(1).max(5_000),
  textSha256: Sha256Schema,
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  speed: z.number().min(0.9).max(1.1)
}).refine((value) => value.endMs > value.startMs && value.endMs - value.startMs === value.durationMs, {
  message: "sentence timing must match its measured duration"
});
export type SpeechSentenceV1 = z.infer<typeof SpeechSentenceV1Schema>;

export const SpeechSlideV1Schema = Versioned.extend({
  slideId: z.string().regex(/^slide-[a-z0-9-]+$/),
  order: z.number().int().nonnegative(),
  /** Hash of the immutable deck speaker notes before any duration revision. */
  sourceNarrationSha256: Sha256Schema.optional(),
  /** Hash of the narration that was actually synthesized and bound to this audio. */
  narrationSha256: Sha256Schema,
  revisionCount: z.number().int().min(0).max(2).default(0),
  durationRevisionPromptVersionId: z.string().uuid().nullable().default(null),
  targetDurationMs: z.number().int().positive().max(1_800_000),
  measuredDurationMs: z.number().int().positive().max(1_800_000),
  audioArtifactId: ArtifactIdSchema,
  sampleRateHz: z.number().int().min(8_000).max(192_000),
  channels: z.number().int().min(1).max(2),
  bitsPerSample: z.literal(16),
  sentences: z.array(SpeechSentenceV1Schema).min(1).max(1_000),
  timingStatus: z.enum(["within-tolerance", "requires-script-revision"])
}).superRefine((value, context) => {
  if (value.revisionCount > 0 && (!value.sourceNarrationSha256 || !value.durationRevisionPromptVersionId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["revisionCount"], message: "revised narration must retain source hash and prompt provenance" });
  }
  if (value.revisionCount === 0 && value.durationRevisionPromptVersionId !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["durationRevisionPromptVersionId"], message: "unchanged narration cannot claim duration revision prompt provenance" });
  }
  let cursor = 0;
  value.sentences.forEach((sentence, index) => {
    if (sentence.order !== index || sentence.startMs !== cursor) context.addIssue({ code: z.ZodIssueCode.custom, path: ["sentences", index], message: "sentence order and timing must be contiguous" });
    cursor = sentence.endMs;
  });
  if (cursor !== value.measuredDurationMs) context.addIssue({ code: z.ZodIssueCode.custom, path: ["measuredDurationMs"], message: "slide duration must equal sentence timeline" });
});
export type SpeechSlideV1 = z.infer<typeof SpeechSlideV1Schema>;

export const SpeechManifestV1Schema = Versioned.extend({
  manifestId: z.string().uuid(),
  projectId: z.string().uuid(),
  jobId: z.string().uuid(),
  deckArtifactId: ArtifactIdSchema,
  configurationSnapshotId: z.string().uuid(),
  providerConfigId: z.string().uuid(),
  providerId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  engineRevision: z.string().trim().min(1).max(200),
  engineImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  modelSha256: Sha256Schema,
  modelLicenseId: z.string().trim().min(1).max(200),
  voiceId: z.string().trim().min(1).max(200),
  lexiconId: z.string().uuid().nullable().default(null),
  lexiconContentHash: Sha256Schema.nullable().default(null),
  format: z.literal("wav"),
  totalMeasuredDurationMs: z.number().int().positive(),
  slides: z.array(SpeechSlideV1Schema).min(1).max(200),
  vttArtifactId: ArtifactIdSchema,
  srtArtifactId: ArtifactIdSchema,
  createdAt: z.string().datetime()
}).superRefine((value, context) => {
  if ((value.lexiconId === null) !== (value.lexiconContentHash === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["lexiconContentHash"], message: "lexicon id and content hash must be pinned together" });
  }
  let total = 0;
  value.slides.forEach((slide, index) => {
    if (slide.order !== index) context.addIssue({ code: z.ZodIssueCode.custom, path: ["slides", index, "order"], message: "slide order must be contiguous" });
    total += slide.measuredDurationMs;
  });
  if (total !== value.totalMeasuredDurationMs) context.addIssue({ code: z.ZodIssueCode.custom, path: ["totalMeasuredDurationMs"], message: "manifest duration must equal slide durations" });
});
export type SpeechManifestV1 = z.infer<typeof SpeechManifestV1Schema>;

export const VideoRenderManifestV1Schema = Versioned.extend({
  videoManifestId: z.string().uuid(),
  projectId: z.string().uuid(),
  jobId: z.string().uuid(),
  deckArtifactId: ArtifactIdSchema,
  revealArtifactId: ArtifactIdSchema,
  speechManifestArtifactId: ArtifactIdSchema,
  deckContentHash: Sha256Schema,
  revealContentHash: Sha256Schema,
  speechManifestContentHash: Sha256Schema,
  renderInputArtifactId: ArtifactIdSchema,
  renderInputContentHash: Sha256Schema,
  configurationSnapshotId: z.string().uuid(),
  providerConfigId: z.string().uuid(),
  providerId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  rendererRevision: z.string().trim().min(1).max(200),
  rendererImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  browserRevision: z.string().trim().min(1).max(200),
  ffmpegRevision: z.string().trim().min(1).max(200),
  fontBundleSha256: Sha256Schema,
  width: z.literal(1920),
  height: z.literal(1080),
  fps: z.literal(30),
  videoCodec: z.literal("h264"),
  pixelFormat: z.literal("yuv420p"),
  audioCodec: z.literal("aac"),
  renderMode: z.literal("final-static-xfade-v1"),
  evidenceClass: z.enum(["preview-only", "deterministic-final"]),
  transitionPolicyVersion: z.literal("xfade-v1"),
  transitions: z.array(Versioned.extend({
    boundaryOrder: z.number().int().nonnegative(),
    fromSlideId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    toSlideId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    kind: z.enum(["fade", "slideleft"]),
    durationMs: z.number().positive().min(250).max(500),
    firstFrame: z.number().int().nonnegative(),
    frameCount: z.number().int().positive()
  })).max(199),
  speechDurationMs: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  frameCount: z.number().int().positive(),
  segments: z.array(Versioned.extend({
    slideId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    order: z.number().int().nonnegative(),
    audioArtifactId: ArtifactIdSchema,
    audioContentHash: Sha256Schema,
    durationMs: z.number().int().positive(),
    frameCount: z.number().int().positive()
  })).min(1).max(200),
  mp4ArtifactId: ArtifactIdSchema,
  createdAt: z.string().datetime()
}).superRefine((value, context) => {
  if (Math.abs(value.durationMs - value.frameCount / value.fps * 1_000) > 1_000 / value.fps) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["durationMs"], message: "video duration must be within one frame of encoded frame count" });
  }
  let durationMs = 0; let frameCount = 0;
  value.segments.forEach((segment, index) => {
    if (segment.order !== index) context.addIssue({ code: z.ZodIssueCode.custom, path: ["segments", index, "order"], message: "video segment order must be contiguous" });
    durationMs += segment.durationMs; frameCount += segment.frameCount;
    if (segment.frameCount !== Math.ceil(segment.durationMs / 1_000 * value.fps)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["segments", index, "frameCount"], message: "segment frames must ceil measured narration duration" });
  });
  if (durationMs !== value.speechDurationMs) context.addIssue({ code: z.ZodIssueCode.custom, path: ["speechDurationMs"], message: "speech duration must equal segment measured durations" });
  if (frameCount !== value.frameCount) context.addIssue({ code: z.ZodIssueCode.custom, path: ["frameCount"], message: "video frame count must equal segment frames" });
  const transitionBoundaries=new Set<number>();
  value.transitions.forEach((transition,index)=>{
    const from=value.segments[transition.boundaryOrder],to=value.segments[transition.boundaryOrder+1];
    if(!from||!to||transition.fromSlideId!==from.slideId||transition.toSlideId!==to.slideId||transitionBoundaries.has(transition.boundaryOrder))context.addIssue({code:z.ZodIssueCode.custom,path:["transitions",index],message:"transition must bind one unique adjacent slide boundary"});
    transitionBoundaries.add(transition.boundaryOrder);
    const expectedFirstFrame=value.segments.slice(0,transition.boundaryOrder+1).reduce((sum,item)=>sum+item.frameCount,0);
    if(transition.firstFrame!==expectedFirstFrame||transition.frameCount!==Math.ceil(transition.durationMs/1000*value.fps))context.addIssue({code:z.ZodIssueCode.custom,path:["transitions",index],message:"transition frames must match its boundary and duration"});
  });
});
export type VideoRenderManifestV1 = z.infer<typeof VideoRenderManifestV1Schema>;

export const VisualAnalysisV1Schema = Versioned.extend({
  analysisId: z.string().uuid(), projectId: z.string().uuid(), snapshotId: z.string().uuid(), providerConfigId: z.string().uuid(),
  providerId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/), model: z.string().trim().min(1).max(200),
  assetInputs: z.array(z.object({ assetId: z.string().uuid(), artifactId: ArtifactIdSchema, contentSha256: Sha256Schema }).strict()).min(1).max(8),
  result: z.object({ summary: z.string().trim().min(1).max(10_000), ocrHints: z.array(z.string().min(1).max(1_000)).max(100), chartInsights: z.array(z.string().min(1).max(1_000)).max(100), risks: z.array(z.string().min(1).max(1_000)).max(100) }).strict(),
  authority: z.literal("non-authoritative-ai-assistance"), createdAt: z.string().datetime()
}).strict();
export type VisualAnalysisV1 = z.infer<typeof VisualAnalysisV1Schema>;

export const QaCheckV1Schema = z.object({
  checkId: z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/),
  status: z.enum(["passed", "warning", "blocked"]),
  message: z.string().trim().min(1).max(1_000),
  artifactIds: z.array(ArtifactIdSchema).max(20).default([])
}).strict();
export const QA_VIDEO_EVIDENCE_LEVELS = ["preview-only", "deterministic-final"] as const;
export const QaPolicyRulesV1Schema = z.object({
  minimumCitationCoveragePercent: z.number().int().min(0).max(100),
  minimumSpeakerNotesCoveragePercent: z.number().int().min(0).max(100),
  requiredApprovalTypes: z.array(z.enum(["blind-listening", "target-cpu-benchmark", "copyright-review"])).min(1).max(3),
  allowedImageLicenseStatuses: z.array(z.enum(["company-owned", "licensed", "cc0"])).min(1).max(3),
  durationTolerancePercent: z.number().min(0).max(100),
  requiredVideoEvidenceLevel: z.enum(QA_VIDEO_EVIDENCE_LEVELS)
}).strict().superRefine((value, context) => {
  if (new Set(value.requiredApprovalTypes).size !== value.requiredApprovalTypes.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["requiredApprovalTypes"], message: "approval types must be unique" });
  if (new Set(value.allowedImageLicenseStatuses).size !== value.allowedImageLicenseStatuses.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["allowedImageLicenseStatuses"], message: "image license statuses must be unique" });
});
export const CreateQaPolicyVersionRequestSchema = z.object({
  name: z.string().trim().min(1).max(160),
  version: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/),
  description: z.string().trim().max(500).default(""),
  rules: QaPolicyRulesV1Schema
}).strict();
export const QaPolicyVersionV1Schema = Versioned.extend({
  qaPolicyId: z.string().uuid(), ...CreateQaPolicyVersionRequestSchema.shape,
  status: z.enum(["draft", "published", "inactive"]), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(), createdBy: z.string().uuid(), publishedAt: z.string().datetime().nullable(), inactiveAt: z.string().datetime().nullable()
}).strict();
export type QaPolicyVersionV1 = z.infer<typeof QaPolicyVersionV1Schema>;
export const QaReportV1Schema = Versioned.extend({
  qaReportId: z.string().uuid(), projectId: z.string().uuid(), deckArtifactId: ArtifactIdSchema,
  speechManifestArtifactId: ArtifactIdSchema, videoManifestArtifactId: ArtifactIdSchema,
  configurationSnapshotId: z.string().uuid(), qaPolicy: z.object({ qaPolicyId: z.string().uuid(), version: z.string().min(1).max(100), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), checks: z.array(QaCheckV1Schema).min(1).max(1_000),
  blockerCount: z.number().int().nonnegative(), warningCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(), createdBy: z.string().uuid()
}).strict().superRefine((value, context) => {
  if (value.blockerCount !== value.checks.filter((check) => check.status === "blocked").length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["blockerCount"], message: "blocker count must match checks" });
  if (value.warningCount !== value.checks.filter((check) => check.status === "warning").length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["warningCount"], message: "warning count must match checks" });
});
export type QaReportV1 = z.infer<typeof QaReportV1Schema>;

export const QA_APPROVAL_TYPES = ["blind-listening", "target-cpu-benchmark", "copyright-review"] as const;
export const QaApprovalTypeSchema = z.enum(QA_APPROVAL_TYPES);
export type QaApprovalType = z.infer<typeof QaApprovalTypeSchema>;
export const QaApprovalV1Schema = Versioned.extend({
  approvalId: z.string().uuid(), projectId: z.string().uuid(), qaReportArtifactId: ArtifactIdSchema,
  type: QaApprovalTypeSchema, evidenceArtifactId: ArtifactIdSchema, evidenceSha256: Sha256Schema, note: z.string().trim().min(1).max(2_000),
  approvedAt: z.string().datetime(), approvedBy: z.string().uuid()
}).strict();
export type QaApprovalV1 = z.infer<typeof QaApprovalV1Schema>;

export const PublishedCourseV1Schema = Versioned.extend({
  publishedCourseId: z.string().uuid(), projectId: z.string().uuid(), revision: z.number().int().positive(),
  qaReportArtifactId: ArtifactIdSchema, deckArtifactId: ArtifactIdSchema, speechManifestArtifactId: ArtifactIdSchema,
  videoManifestArtifactId: ArtifactIdSchema, mp4ArtifactId: ArtifactIdSchema,
  approvalArtifactIds: z.array(ArtifactIdSchema).min(1).max(QA_APPROVAL_TYPES.length),
  publishedAt: z.string().datetime(), publishedBy: z.string().uuid()
}).strict();
export type PublishedCourseV1 = z.infer<typeof PublishedCourseV1Schema>;

export const PublicationWithdrawalV1Schema = Versioned.extend({
  withdrawalId: z.string().uuid(), publishedCourseId: z.string().uuid(), projectId: z.string().uuid(),
  reason: z.string().trim().min(4).max(2_000), withdrawnAt: z.string().datetime(), withdrawnBy: z.string().uuid()
}).strict();
export type PublicationWithdrawalV1 = z.infer<typeof PublicationWithdrawalV1Schema>;

export const PublishedCourseRecordV1Schema = z.object({
  course: PublishedCourseV1Schema,
  status: z.enum(["published", "withdrawn"]),
  withdrawal: PublicationWithdrawalV1Schema.nullable()
}).strict();
export type PublishedCourseRecordV1 = z.infer<typeof PublishedCourseRecordV1Schema>;

export const ReleaseResourceV1Schema = z.object({
  kind: z.enum(["webppt", "video", "vtt", "srt"]), artifactId: ArtifactIdSchema,
  mediaType: z.enum(["application/zip", "video/mp4", "text/vtt; charset=utf-8", "application/x-subrip; charset=utf-8"]),
  contentSha256: Sha256Schema, byteLength: z.number().int().positive().max(268_435_456),
  filename: z.string().regex(/^course-r[1-9][0-9]*(?:-webppt\.zip|\.mp4|\.vtt|\.srt)$/)
}).strict();
export const ReleaseManifestV1Schema = Versioned.extend({
  publishedCourseId: z.string().uuid(), projectId: z.string().uuid(), revision: z.number().int().positive(),
  packageFormat: z.literal("courseforge-release-v1"),
  inputs: z.object({
    deckArtifactId: ArtifactIdSchema, deckContentSha256: Sha256Schema, revealArtifactId: ArtifactIdSchema, revealContentSha256: Sha256Schema,
    speechManifestArtifactId: ArtifactIdSchema, speechManifestContentSha256: Sha256Schema,
    videoManifestArtifactId: ArtifactIdSchema, videoManifestContentSha256: Sha256Schema
  }).strict(),
  provenance: z.object({
    configurationSnapshotId: z.string().uuid(), providerId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
    speechEngineRevision: z.string().trim().min(1).max(200), modelLicenseId: z.string().trim().min(1).max(200), voiceId: z.string().trim().min(1).max(200),
    rendererRevision: z.string().trim().min(1).max(200), browserRevision: z.string().trim().min(1).max(200),
    ffmpegRevision: z.string().trim().min(1).max(200), rendererImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    fontBundleSha256: Sha256Schema
  }).strict(),
  resources: z.array(ReleaseResourceV1Schema).length(4), createdAt: z.string().datetime()
}).strict().superRefine((value, context) => {
  if (new Set(value.resources.map((item) => item.kind)).size !== 4 || new Set(value.resources.map((item) => item.artifactId)).size !== 4) context.addIssue({ code: z.ZodIssueCode.custom, path: ["resources"], message: "release resources must contain four unique kinds and artifacts" });
});
export type ReleaseManifestV1 = z.infer<typeof ReleaseManifestV1Schema>;

export const ArtifactTombstoneV1Schema = Versioned.extend({
  tombstoneId: z.string().uuid(), artifactId: ArtifactIdSchema, projectId: z.string().uuid(),
  reason: z.string().trim().min(4).max(2_000), tombstonedAt: z.string().datetime(), tombstonedBy: z.string().uuid(),
  restoreDeadline: z.string().datetime(), restoredAt: z.string().datetime().nullable(), restoredBy: z.string().uuid().nullable(),
  purgedAt: z.string().datetime().nullable(), purgedBy: z.string().uuid().nullable()
}).strict();
export type ArtifactTombstoneV1 = z.infer<typeof ArtifactTombstoneV1Schema>;

export const ArtifactGcPlanV1Schema = Versioned.extend({
  planId: z.string().uuid(), artifactIds: z.array(ArtifactIdSchema).min(1).max(10_000),
  candidateCount: z.number().int().positive(), totalBytes: z.number().int().nonnegative(),
  confirmationSha256: Sha256Schema, createdAt: z.string().datetime(), createdBy: z.string().uuid(),
  expiresAt: z.string().datetime(), executedAt: z.string().datetime().nullable(), executedBy: z.string().uuid().nullable()
}).strict().superRefine((value, context) => {
  if (value.candidateCount !== value.artifactIds.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidateCount"], message: "candidate count must match artifact ids" });
});
export type ArtifactGcPlanV1 = z.infer<typeof ArtifactGcPlanV1Schema>;

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

export const PROVIDER_KINDS = ["text", "multimodal", "search", "design", "tts", "deck", "video"] as const;
export const ProviderKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const SecretReferenceSchema = z.string()
  .regex(/^(secret|env):\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/, "Only secret:// or env:// references are allowed");
export type SecretReference = z.infer<typeof SecretReferenceSchema>;

const ConfigurationValueSchema = z.union([
  z.string().max(2_000), z.number().finite(), z.boolean(), z.null(),
  z.array(z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()])).max(100)
]);

export const CreateProviderConfigVersionRequestSchema = z.object({
  kind: ProviderKindSchema,
  providerId: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  version: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/),
  displayName: z.string().trim().min(1).max(160),
  endpoint: z.string().url().max(2_000).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  capabilities: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  settings: z.record(z.string().min(1).max(100), ConfigurationValueSchema).default({}),
  secretRefs: z.record(z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/), SecretReferenceSchema).default({})
}).strict().superRefine((value, context) => {
  for (const key of Object.keys(value.settings)) {
    if (/(?:api[-_]?key|authorization|credential|password|secret|token)/i.test(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["settings", key], message: "Secrets must use secretRefs" });
    }
  }
  if (value.endpoint) {
    const endpoint = new URL(value.endpoint);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") context.addIssue({ code: z.ZodIssueCode.custom, path: ["endpoint"], message: "Endpoint must use HTTP or HTTPS" });
    if (endpoint.username || endpoint.password) context.addIssue({ code: z.ZodIssueCode.custom, path: ["endpoint"], message: "Endpoint credentials are forbidden" });
  }
});
export type CreateProviderConfigVersionRequest = z.infer<typeof CreateProviderConfigVersionRequestSchema>;

export const ConfigLifecycleStatusSchema = z.enum(["draft", "published", "inactive"]);
export const ProviderConfigVersionV1Schema = Versioned.extend({
  configId: z.string().uuid(),
  kind: ProviderKindSchema,
  providerId: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  version: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/),
  displayName: z.string().trim().min(1).max(160),
  endpoint: z.string().url().max(2_000).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  capabilities: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  settings: z.record(z.string().min(1).max(100), ConfigurationValueSchema).default({}),
  secretRefs: z.record(z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/), SecretReferenceSchema).default({}),
  status: ConfigLifecycleStatusSchema,
  createdAt: z.string().datetime(),
  createdBy: z.string().uuid(),
  publishedAt: z.string().datetime().nullable(),
  inactiveAt: z.string().datetime().nullable()
});
export type ProviderConfigVersionV1 = z.infer<typeof ProviderConfigVersionV1Schema>;

export const ProviderProbeResultV1Schema = Versioned.extend({
  probeId:z.string().uuid(),configId:z.string().uuid(),providerId:z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),configVersion:z.string().min(1).max(100),
  checkedAt:z.string().datetime(),checkedBy:z.string().uuid(),capabilities:z.array(z.string().min(1).max(100)).max(100),healthy:z.boolean(),
  errorCode:z.enum(["unavailable","timeout","authentication","upstream","invalid_configuration"]).nullable(),detail:z.string().max(500).nullable()
}).strict();
export type ProviderProbeResultV1=z.infer<typeof ProviderProbeResultV1Schema>;

export const MAX_PRONUNCIATION_LEXICON_ENTRIES = 10_000;
export const PronunciationLexiconEntryV1Schema=z.object({term:z.string().trim().min(1).max(200),pronunciation:z.string().trim().min(1).max(500),locale:z.literal("zh-CN"),notes:z.string().trim().max(500).default("")}).strict();
export type PronunciationLexiconEntryV1=z.infer<typeof PronunciationLexiconEntryV1Schema>;
export const CreatePronunciationLexiconRequestSchema=z.object({name:z.string().trim().min(1).max(160),version:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/),entries:z.array(PronunciationLexiconEntryV1Schema).min(1).max(MAX_PRONUNCIATION_LEXICON_ENTRIES)}).strict();
export const PronunciationLexiconVersionV1Schema=Versioned.extend({lexiconId:z.string().uuid(),...CreatePronunciationLexiconRequestSchema.shape,status:ConfigLifecycleStatusSchema,contentHash:z.string().regex(/^[a-f0-9]{64}$/),createdAt:z.string().datetime(),createdBy:z.string().uuid(),publishedAt:z.string().datetime().nullable(),inactiveAt:z.string().datetime().nullable()}).strict();
export type PronunciationLexiconVersionV1=z.infer<typeof PronunciationLexiconVersionV1Schema>;

/** Immutable, content-addressed pronunciation data sent over the TTS sidecar v2 boundary. */
export const TtsPronunciationLexiconV2Schema=z.object({
  lexiconId:z.string().uuid(),version:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/),contentHash:Sha256Schema,
  entries:z.array(PronunciationLexiconEntryV1Schema).min(1).max(MAX_PRONUNCIATION_LEXICON_ENTRIES)
}).strict();
export type TtsPronunciationLexiconV2=z.infer<typeof TtsPronunciationLexiconV2Schema>;

export const CreatePromptVersionRequestSchema = z.object({
  promptKey: z.string().trim().regex(/^[a-z][a-z0-9._-]{0,99}$/),
  version: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/),
  description: z.string().trim().max(500).default(""),
  template: z.string().min(1).max(200_000)
}).strict();
export type CreatePromptVersionRequest = z.infer<typeof CreatePromptVersionRequestSchema>;

export const PromptVersionV1Schema = Versioned.extend({
  promptVersionId: z.string().uuid(),
  ...CreatePromptVersionRequestSchema.shape,
  status: ConfigLifecycleStatusSchema,
  createdAt: z.string().datetime(),
  createdBy: z.string().uuid(),
  publishedAt: z.string().datetime().nullable(),
  inactiveAt: z.string().datetime().nullable()
});
export type PromptVersionV1 = z.infer<typeof PromptVersionV1Schema>;

export const RuntimeProviderBindingV1Schema = z.object({
  kind: ProviderKindSchema,
  configId: z.string().uuid(),
  providerId: z.string().min(1).max(100),
  version: z.string().min(1).max(100)
});
export const RuntimePromptBindingV1Schema = z.object({
  promptKey: z.string().min(1).max(100),
  promptVersionId: z.string().uuid(),
  version: z.string().min(1).max(100)
});
export const RuntimeConfigSnapshotRecordV1Schema = Versioned.extend({
  snapshotId: z.string().uuid(),
  capturedAt: z.string().datetime(),
  capturedBy: z.string().uuid(),
  providerBindings: z.array(RuntimeProviderBindingV1Schema).max(PROVIDER_KINDS.length),
  promptBindings: z.array(RuntimePromptBindingV1Schema).max(1_000),
  pronunciationLexiconBinding:z.object({lexiconId:z.string().uuid(),name:z.string().min(1).max(160),version:z.string().min(1).max(100),contentHash:Sha256Schema}).nullable().default(null),
  qaPolicyBinding:z.object({qaPolicyId:z.string().uuid(),version:z.string().min(1).max(100),contentHash:Sha256Schema}).nullable().default(null)
});
export type RuntimeConfigSnapshotRecordV1 = z.infer<typeof RuntimeConfigSnapshotRecordV1Schema>;

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

export const CreateProjectRequestSchema = z.object({ brief: CourseBriefV1Schema, dataPolicy: ProjectDataPolicyV1Schema.default(DEFAULT_PROJECT_DATA_POLICY) }).strict();
export const UpdateProjectBriefRequestSchema = z.object({ brief: CourseBriefV1Schema, dataPolicy: ProjectDataPolicyV1Schema }).strict();
export const ProjectV1Schema = Versioned.extend({
  projectId: z.string().uuid(),
  ownerId: z.string().uuid(),
  brief: CourseBriefV1Schema,
  dataPolicy: ProjectDataPolicyV1Schema.default(DEFAULT_PROJECT_DATA_POLICY),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
/** Legacy constructors may omit dataPolicy; parsing materializes offline/private. */
export type ProjectV1 = Omit<z.output<typeof ProjectV1Schema>, "dataPolicy"> & { dataPolicy?: ProjectDataPolicyV1 };

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
