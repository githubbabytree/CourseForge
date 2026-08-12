import {
  InMemoryArtifactStore,
  createDeckArtifactBuilder,
  type InMemoryArtifactStore as GeneratedArtifactStore,
} from "@courseforge/deck";
import {
  DeterministicDeckStageProvider,
  DeterministicDemoStageExecutor,
  type StageExecutionInput,
  type StageExecutionResult,
  type StageExecutor,
} from "@courseforge/workflow";
import { persistDeckArtifactBundle, type ArtifactBlobStore } from "./artifacts.js";
import type { CourseForgeRepository } from "./repositories.js";

/**
 * Internal-alpha executor that makes the deck stage truthful while retaining
 * deterministic fixtures for stages whose real providers are not enabled.
 */
export class AlphaArtifactStageExecutor implements StageExecutor {
  readonly #fallback = new DeterministicDemoStageExecutor();

  constructor(
    readonly repository: CourseForgeRepository,
    readonly blobStore: ArtifactBlobStore,
  ) {}

  cacheKey(input: Omit<StageExecutionInput, "jobId" | "previousArtifactHash">): string {
    return input.stage === "deck"
      ? `alpha-deck-v1:${input.projectId}`
      : `alpha-fixture-v1:${input.projectId}:${input.stage}`;
  }

  async execute(input: StageExecutionInput): Promise<StageExecutionResult> {
    if (input.stage !== "deck") return this.#fallback.execute(input);
    const project = await this.repository.findProject(input.projectId);
    if (!project) throw new Error("Project not found while producing deck artifacts");

    const sourceStore: GeneratedArtifactStore = new InMemoryArtifactStore();
    const provider = new DeterministicDeckStageProvider(
      "alpha-deck-config-v1",
      {
        title: project.brief.title,
        audience: project.brief.audience,
        objective: project.brief.objectives[0] ?? project.brief.idea,
        sections: [
          {
            title: project.brief.title,
            keyPoints: [project.brief.idea, `受众：${project.brief.audience}`],
            speakerNotes: `本页介绍课程背景、受众与目标。${project.brief.background}`.trim(),
            sourceIds: project.brief.sourceArtifactIds,
          },
        ],
      },
      createDeckArtifactBuilder(sourceStore),
    );
    const generated = await provider.executeStage(input);
    const deckSpec = await sourceStore.get(generated.artifact.artifacts.deckSpec.artifactId);
    const revealHtml = await sourceStore.get(generated.artifact.artifacts.revealHtml.artifactId);
    const renderManifest = await sourceStore.get(generated.artifact.artifacts.renderManifest.artifactId);
    if (!deckSpec || !revealHtml || !renderManifest) throw new Error("Generated deck artifact bundle is incomplete");
    await persistDeckArtifactBundle(this.repository, this.blobStore, sourceStore, {
      artifacts: {
        deckSpec: deckSpec.metadata,
        revealHtml: revealHtml.metadata,
        renderManifest: renderManifest.metadata,
      },
    });
    return { artifactHash: generated.artifactHash };
  }
}
