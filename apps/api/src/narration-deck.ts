import { DeckSpecV1Schema, type SessionUserV1 } from "@courseforge/contracts";
import { InMemoryArtifactStore, canonicalJson, createDeckArtifactBuilder } from "@courseforge/deck";
import { persistDeckArtifactBundle, type ArtifactBlobStore } from "./artifacts.js";
import type { CourseForgeRepository } from "./repositories.js";
import type { RevisionRepository } from "./revision-repository.js";
import { RevisionService } from "./revision-service.js";

/**
 * Converts duration-revised narration into a real immutable Deck revision before
 * any speech manifest can reference it. This keeps Reveal notes, audio, captions,
 * video inputs and release provenance on one content-addressed source of truth.
 */
export const createNarrationDeckFinalizer = (
  repository: CourseForgeRepository,
  blobs: ArtifactBlobStore,
  revisions: RevisionRepository,
  actorId: string,
) => async (input: {
  projectId: string;
  jobId: string;
  snapshotId: string;
  sourceDeckArtifact: { artifactId: string };
  sourceDeck: ReturnType<typeof DeckSpecV1Schema.parse>;
  narrations: ReadonlyMap<string, string>;
}) => {
  const user = await repository.findUserById(actorId);
  if (!user || user.disabled || (user.role !== "platform_admin" && !await repository.hasProjectAccess(input.projectId, actorId))) throw new Error("workflow_actor_unavailable");
  const actor: SessionUserV1 = { schemaVersion: "1", userId: user.userId, email: user.email, displayName: user.displayName, role: user.role };
  const service = new RevisionService(repository, blobs, revisions);
  const active = await service.ensureActive(input.projectId, "deck", actor);
  const applyNarrations = (revision: number) => DeckSpecV1Schema.parse({ ...input.sourceDeck, revision,
    slides: input.sourceDeck.slides.map((slide) => ({ ...slide, speakerNotes: input.narrations.get(slide.slideId) ?? slide.speakerNotes })) });

  // A durable retry may arrive after the bundle and revision head were committed but
  // before the speech artifacts were checkpointed. Reuse only the byte-equivalent head.
  if (active.artifactId !== input.sourceDeckArtifact.artifactId) {
    const alreadyFinalized = applyNarrations(active.revision);
    if (canonicalJson(active.document) !== canonicalJson(alreadyFinalized)) throw new Error("stale_base_revision");
    const metadata = await repository.findArtifactMetadata(active.artifactId);
    if (!metadata) throw new Error("finalized_deck_artifact_unavailable");
    return { deckArtifact: metadata, deck: alreadyFinalized };
  }

  for (const [index, slide] of input.sourceDeck.slides.entries()) {
    if ((input.narrations.get(slide.slideId) ?? slide.speakerNotes) !== slide.speakerNotes
      && active.locks.some((lock) => lock.locked && lock.path === `/slides/${index}/speakerNotes`)) throw new Error("narration_notes_locked");
  }
  const deck = applyNarrations(active.revision + 1);
  const sourceStore = new InMemoryArtifactStore();
  const bundle = await createDeckArtifactBuilder(sourceStore)(deck, { projectId: input.projectId, jobId: input.jobId,
    revision: deck.revision, configurationVersion: input.snapshotId, providerId: "tts-duration-revision",
    deckSourceArtifactIds: [input.sourceDeckArtifact.artifactId] });
  const persisted = await persistDeckArtifactBundle(repository, blobs, sourceStore, bundle);
  const deckArtifact = persisted.find((artifact) => artifact.kind === "deck-spec");
  if (!deckArtifact) throw new Error("finalized_deck_artifact_unavailable");
  const revision = await service.adoptGeneratedDeck(input.projectId, actor, deckArtifact.artifactId, deckArtifact.contentHash, deck, input.snapshotId);
  if (revision.artifactId !== deckArtifact.artifactId) throw new Error("finalized_deck_revision_mismatch");
  return { deckArtifact, deck };
};
