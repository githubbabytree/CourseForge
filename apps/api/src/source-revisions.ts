import { createHash } from "node:crypto";
import { SourceRevisionV2Schema, type AnySourceRevision, type DocumentExtractionV2, type SourceArtifactV1 } from "@courseforge/contracts";
import { IngestionError, assertSafeSourceText, importTextSource } from "@courseforge/ingestion";
import type { CourseForgeRepository, ImportedSourceRecord } from "./repositories.js";

export interface SourceRevisionStore {
  readonly backend: "in-memory" | "postgres";
  saveImportedSource(record: ImportedSourceRecord): Promise<void>;
  saveImportedSourceAndBind(record: ImportedSourceRecord, project: import("@courseforge/contracts").ProjectV1): Promise<void>;
  listSourceRevisions(projectId: string): Promise<AnySourceRevision[]>;
  findSourceRevision(projectId: string, sourceRevisionId: string): Promise<AnySourceRevision | undefined>;
}

export class RepositorySourceRevisionStore implements SourceRevisionStore {
  readonly backend;
  constructor(private readonly repository: CourseForgeRepository) { this.backend = repository.persistenceBackend; }
  saveImportedSource(record: ImportedSourceRecord) { return this.repository.saveImportedSource(record); }
  saveImportedSourceAndBind(record: ImportedSourceRecord, project: import("@courseforge/contracts").ProjectV1) { return this.repository.saveImportedSourceAndBind(record, project); }
  listSourceRevisions(projectId: string) { return this.repository.listSourceRevisions(projectId); }
  findSourceRevision(projectId: string, sourceRevisionId: string) { return this.repository.findSourceRevision(projectId, sourceRevisionId); }
}

export const publicSourceRevision = (revision: AnySourceRevision): AnySourceRevision => structuredClone(revision);

export function buildImportedSource(projectId: string, filename: string, mediaType: string, bytes: Uint8Array): ImportedSourceRecord {
  const sourceArtifactId = crypto.randomUUID();
  const sourceRevisionId = crypto.randomUUID();
  const importedAt = new Date().toISOString();
  const imported = importTextSource({
    sourceArtifactId,
    sourceRevisionId,
    revision: 1,
    filename,
    mediaType: mediaType as "text/plain" | "text/markdown",
    bytes,
    importedAt
  });
  return {
    artifact: {
      schemaVersion: "1", sourceArtifactId, projectId, displayName: filename,
      createdAt: importedAt, currentRevisionId: sourceRevisionId
    },
    revision: imported.revision,
    normalizedText: imported.normalizedText
  };
}

export function buildImportedDocumentSource(projectId: string, filename: string, bytes: Uint8Array, extraction: DocumentExtractionV2): ImportedSourceRecord {
  assertSafeSourceText(extraction.normalizedText);
  const sourceArtifactId = crypto.randomUUID(); const sourceRevisionId = crypto.randomUUID(); const importedAt = new Date().toISOString();
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  const rawBlobId = `artifact-${contentSha256}`;
  const revision = SourceRevisionV2Schema.parse({
    schemaVersion: "2", sourceRevisionId, sourceArtifactId, revision: 1, filename,
    mediaType: extraction.mediaType, byteSize: bytes.byteLength, contentSha256, rawBlobId, importedAt,
    parser: extraction.parser, extractionMethod: extraction.extractionMethod,
    securityInspection: extraction.securityInspection, sections: extraction.sections
  });
  return {
    artifact: { schemaVersion: "1", sourceArtifactId, projectId, displayName: filename, createdAt: importedAt, currentRevisionId: sourceRevisionId },
    revision, normalizedText: extraction.normalizedText
  };
}

export { IngestionError };
