import assert from "node:assert/strict";
import test from "node:test";
import {
  DeterministicDeckStageProvider,
  ProviderDrivenStageExecutor,
} from "../../workflow/src/index.ts";
import {
  InMemoryArtifactStore,
  createDeckArtifactBuilder,
} from "../src/index.ts";

test("provider-driven deck stage persists a real Reveal artifact bundle", async () => {
  const store = new InMemoryArtifactStore();
  const provider = new DeterministicDeckStageProvider("design-config-12", {
    title: "账号安全：三步保护工作账号",
    audience: "大型互联网公司员工",
    objective: "在常见账号风险场景中做出正确处置",
    sections: [
      { title: "看见异常", keyPoints: ["陌生登录", "异常 MFA 请求"], speakerNotes: "先从两个日常信号开始识别风险。", sourceIds: ["material-r4"] },
      { title: "立即核验", keyPoints: ["拒绝未知请求", "通过官方入口核验"], speakerNotes: "强调不要在来路不明的页面继续操作。", sourceIds: ["material-r4"] },
      { title: "完成上报", keyPoints: ["保留证据", "联系安全团队"], speakerNotes: "最后演示如何保留证据并上报。", sourceIds: ["material-r4"] },
    ],
  }, createDeckArtifactBuilder(store), 4);
  const executor = new ProviderDrivenStageExecutor({ resolve: () => provider });
  const result = await executor.execute({
    jobId: "22222222-2222-4222-8222-222222222222",
    projectId: "11111111-1111-4111-8111-111111111111",
    stage: "deck",
    previousArtifactHash: "deterministic-material-hash",
  });

  const artifacts = await store.list("11111111-1111-4111-8111-111111111111");
  assert.equal(artifacts.length, 3);
  assert.equal(artifacts.find((item) => item.kind === "deck-spec")?.contentHash, result.artifactHash);
  assert.ok(artifacts.every((item) => item.revision === 4 && item.configurationVersion === "design-config-12"));
  assert.equal(artifacts.some((item) => /audio|video|mp4|tts/i.test(item.kind)), false);

  const htmlMetadata = artifacts.find((item) => item.kind === "reveal-html");
  const html = htmlMetadata ? await store.get(htmlMetadata.artifactId) : undefined;
  assert.match(html?.content ?? "", /<aside class="notes">/);
  assert.equal((html?.content.match(/data-slide-id=/g) ?? []).length, 3);
});
