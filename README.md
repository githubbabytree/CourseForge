# CourseForge

CourseForge 是面向大型互联网企业内部信息安全培训的一站式 AI 课程生产平台。它可以把一个培训点子、制度文档或既有课件，转化为可追溯的培训 Brief、研究材料、Reveal.js WebPPT、逐页讲稿、中文语音、字幕和培训视频。

当前源代码版本为 **v1.1.1**。外部模型、搜索、设计、TTS 与视频能力均通过版本化 Provider 接口接入，管理员可以替换 Huashu Design、文本/多模态模型、Agent-Reach、MeloTTS/Kokoro/Piper 和渲染器，而不改变工作流及审计语义。v1.1.x 起，平台以不可变运行快照为唯一真相源：Provider/Prompt/词典/设计模板/QA Policy 全部版本化、发布后绑定内容哈希，并经过发布后真实能力探针；`course-full` 运行就绪度门禁直接展示当前快照能否启动，缺失业务 Prompt 会在 API 启动时自动创建草稿，管理员发布并重建快照即可恢复可运行状态。

## 主要能力

- 向导式课程创建：培训点子、受众、时长、目标、背景、风格和模板逐步补全。
- 安全材料导入：支持 TXT、Markdown、文本型 PDF、DOCX、PPTX；保留原始文件哈希、定位信息和引用关系。
- 受治理的 AI 生成：Provider、Prompt、QA 策略、设计模板和发音词典均采用不可变版本与运行快照。
- 研究与证据：Agent-Reach 负责候选发现，网页证据必须经过 HTTPS、DNS/IP、重定向、大小和内容校验后才能引用。
- WebPPT：生成版本化 DeckSpec、Reveal HTML 和 RenderManifest，支持备注、局部修订、锁定、历史版本和安全预览。
- 中文语音与视频：模块化 TTS sidecar、实测 WAV 时长、VTT/SRT、讲稿时长闭环，以及 Playwright/FFmpeg 视频渲染链。
- 发布治理：机器 QA、人工审批、不可变发布、撤回、保留策略、WebPPT ZIP/MP4/字幕/Manifest 下载。
- 运行就绪度门禁：`course-full` 矩阵按不可变快照核验 Text/Search/Design/Multimodal/TTS/Video、十个业务 Prompt、发音词典、设计模板与 QA Policy，并要求发布后新鲜的真实能力探针；旧空快照保持只读并标记不可运行。
- Prompt 治理：代码侧 Prompt Definition Catalog 与安全内置只读 Prompt；缺失业务 Prompt 在 API 启动时自动创建草稿（`COURSEFORGE_AUTO_INIT_PROMPTS=0` 关闭），管理台可直接发布。
- 视觉治理：风格档案（StyleProfile）、逐页视觉复核（VisualReview）与人工确认；视频 Worker 输出逐页 1920×1080 PNG Artifact 并复用确定性检查与严格 Schema 多模态复核。
- 企业基础能力：本地账户、RBAC、项目级授权、审计、PostgreSQL 耐久任务、MinIO 私有产物、指标、备份与恢复。

## 工程结构

- `apps/web`：向导、预览、编辑和管理后台。
- `apps/api`：认证、项目、生成、治理、审计和发布 API。
- `packages/contracts`：版本化领域契约。
- `packages/providers`：模型、搜索、设计、TTS 和视频 Provider。
- `packages/workflow`：可恢复工作流、检查点和任务事件。
- `packages/deck`：Reveal.js 编译器、修订和渲染清单。
- `packages/ingestion`、`packages/document-worker`：受限文档解析。
- `packages/tts-worker`、`packages/video-worker`：隔离的媒体 sidecar。
- `infra`：Caddy、PostgreSQL、MinIO 和内部 Worker 的 Compose 拓扑。

## 本地验证

要求 Node.js 22、npm 10；容器验收还需要 Docker Compose v2。

```bash
npm ci
npm run verify
```

开发模式下，在未纳入 Git 的环境文件中配置临时管理员信息，然后分别启动：

```bash
npm run dev --workspace=@courseforge/web
npm run dev --workspace=@courseforge/api
```

- Web：`http://localhost:3000`
- API 健康检查：`http://localhost:3001/health`
- API 版本：`http://localhost:3001/version`

在线模式只访问真实受鉴权 API；离线 Demo 必须由用户显式选择，不会在 API 故障时静默回退。未配置 PostgreSQL 或对象存储时，开发环境会明确警告并使用不可持久化的内存实现；生产部署不得使用这些内存后端，必须通过 `/health`、`/ready` 和 `/version` 验证实际后端。API 启动时（含开发环境）会自动为代码 Catalog 中缺失的业务 Prompt 创建草稿，`COURSEFORGE_AUTO_INIT_PROMPTS=0` 或 `false` 可关闭；草稿不会自动发布。

## 容器部署

复制 `infra/.env.example` 为被 Git 忽略的 `infra/.env`，逐项替换占位符，然后参照[部署说明](docs/deployment-alpha.md)。生产部署必须启用 HTTPS、安全 Cookie、PostgreSQL、私有 MinIO 和耐久工作流，并确保只有 Caddy 暴露宿主机端口。

```bash
docker compose --env-file infra/.env -f infra/compose.yaml up -d --build --wait
```

从 `v0.2.0-alpha.2` 保留数据升级时，必须先阅读 [v1.0.1 升级说明](docs/upgrade-v1.0.1.zh-CN.md)并运行只读预检；不要修改受版本控制的 Compose 文件，也不要执行 `down -v`。

## 升级到 v1.1.x

- 升级部署时同步更新被忽略的 `infra/.env` 中的 `COURSEFORGE_VERSION=v1.1.1`（`/api/version` 的 `deploymentRevision` 与目标版本保持一致），并确认 Compose 项目名不变，避免数据卷隔离。
- 首次启动后，在管理台「Prompts」页发布十个业务 Prompt 草稿（缺失项可直接点「创建草稿」），并按需创建发布 QA Policy、发音词典与设计模板，配置并发布六类 Provider（发布后须通过真实能力探针）。
- 全部发布后在「就绪度」页点「创建当前快照」，重新检查即可看到 `course-full 可以启动`。旧空快照按设计只读保留、不可运行。

详细运维要求见[生产运维](docs/production-operations.md)，实际能力边界见[实现状态](docs/implementation-status.md)，目标主机交接步骤见[中文部署交接](docs/operator-deployment-handoff.zh-CN.md)。

## 敏感信息边界

仓库不得包含 API Key、Token、Cookie、私钥、生产密码、真实模型接口、内部培训材料、生成产物、模型权重或生产环境配置。Provider 配置只持久化 `env://...` 或由部署方实现的 `secret://...` 引用，不保存密钥值。

提交和推送前必须执行：

```bash
npm run check:secrets
git diff --cached
npm run verify
```

仓库内置 pre-commit、pre-push 和 CI 扫描；本地真实配置只能写入已忽略的 `.env`。任何曾出现在聊天、Issue、日志或提交历史中的密钥都必须先撤销并轮换，不能直接用于部署。

## 当前交付边界

平台代码、模块化适配器、耐久工作流、QA/发布链和容器拓扑均已实现，但不把环境相关能力冒充为已验收：

- Huashu Design 适配器已实现并固定上游版本/许可；仓库不分发 Huashu sidecar 镜像，design Provider 需部署方自备并启用（不允许降级为文本适配器）。
- 镜像包含受控 `mcporter` 可执行文件和无密钥 Exa 配置模板；Search Provider 的探针需要真实搜索任务验收，部署方仍须通过 SecretRef 注入凭据并配置受批准的 DNS/出网策略。
- 仓库不分发 MeloTTS、Kokoro 或 Piper 权重；tts-worker 默认不随 Compose 启动（`profiles: ["tts"]`），模型许可、中文盲听和目标 CPU 性能必须单独验收。
- Playwright/FFmpeg Worker 已实现；目标主机仍需完成镜像构建、字体/浏览器沙箱、真实 MP4 和资源占用验收。
- SSO/OIDC 与 Temporal 是可选的后续适配器；当前版本默认提供内部账户和 PostgreSQL lease queue。

版本变更见 [CHANGELOG.md](CHANGELOG.md)。安全问题请按照 [SECURITY.md](SECURITY.md) 私下报告，禁止在公开 Issue 中附带凭据或内部数据。
