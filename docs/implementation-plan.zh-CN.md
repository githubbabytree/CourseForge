# CourseForge 详细落地方案

## 1. 产品目标与边界

CourseForge 面向大型互联网公司内部信息安全培训，将点子、制度、文档或既有演示材料转化为可审阅的培训基础材料、WebPPT、逐页讲稿、语音与视频。系统强调年轻化视觉、证据可追溯、过程可编辑、产物可复现以及企业级安全边界。

系统不让模型直接维护任意 HTML。唯一事实源按版本演进：

`CourseBrief → SourceRevision → ResearchBundle → MaterialRevision → Storyboard → DeckSpec → SpeechManifest → RenderManifest → PublishedCourse`

每次运行固定提示词版本、Provider 配置版本、模型/引擎版本、输入 revision 与素材哈希；管理员通过结构化 patch 修改内容，未受影响页面复用缓存。

## 2. 用户流程

1. 创建项目：输入点子，或上传制度、文档、PPT/PDF；选择受众、时长、目标、背景、风格与模板。
2. Brief 补全：AI 提问缺失信息；用户也可接受面向内部安全培训的默认值和最佳实践选项。
3. 研究补全：解析内部材料，按允许的联网策略检索公开资料，记录来源、许可、抓取时间与引用关系。
4. 基础材料：生成章节化详实材料；管理员在向导中修改、锁定、比较和恢复 revision。
5. 故事板与设计：生成多个设计方向，选择后形成稳定 `DeckSpec`。
6. WebPPT：编译为 Reveal.js；每页包含演讲备注、转场和受限的可导出动画，可局部重生成。
7. 讲稿与语音：按页/句切分，TTS 实测时长后压缩或扩写讲稿，小范围调语速，并生成 SRT/VTT。
8. 视频：草稿快速预览；终稿按确定性时间轴逐帧渲染，FFmpeg 编码并合并语音。
9. QA 与发布：检查事实引用、讲稿覆盖、时长、视觉溢出、术语读音、音频响度、产物哈希和许可后发布。

九个后台阶段固定为 `intake / research / material / deck / narration / tts / render / qa / publish`，每阶段持续输出百分比、已用时间、结构化事件、检查点和失败原因，并支持取消与续跑。

## 3. 模块化架构

### 3.1 核心服务

- Web：向导、编辑器、Reveal 预览、AI 对话、版本 diff、任务进度与管理后台。
- API：本地账号、RBAC、项目、revision、Provider/Prompt 配置、任务、产物和审计 API。
- Workflow：阶段 DAG、检查点、重试、取消、幂等和脏页增量构建；Alpha 先保持清晰端口，生产再接 Durable Workflow 实现。
- PostgreSQL：用户、会话、项目、成员、配置、revision、任务元数据和审计。
- 对象存储：源文件、标准化素材、WebPPT、音频、字幕、分段视频和最终 MP4。
- Worker：研究、Deck、TTS、Render 分池限流，任务容器无特权并有 CPU、内存、磁盘、时长与并发配额。

### 3.2 Provider 端口

业务层只依赖稳定接口，不依赖具体模型或仓库：

- `TextModelProvider`、`MultimodalModelProvider`
- `SearchProvider`
- `DesignProvider`（Huashu Design 是一个实现）
- `TTSProvider`（MeloTTS、Kokoro、Piper 是可替换实现）
- `DeckRenderer`（Reveal.js 是首选实现）
- `VideoRenderer`（确定性逐帧与快速草稿是不同实现）
- `ArtifactStore`、`SecretResolver`、`PromptRepository`

每个 Provider 必须声明 capability、版本、健康状态、输入输出 schema、超时/重试、许可信息和配置哈希。密钥只通过 `secret://` 或 `env://` 引用运行时解析，不进入项目、任务事件、日志或 Git。

### 3.3 Huashu Design 接入

Huashu Design 作为版本锁定的设计工作流和规则包接入，不作为 Reveal runtime。复用其设计推理、视觉质检、品牌资产协议和确定性 seek 思路；通过 `DesignProvider` 转换为平台自己的 `DeckSpec`。上游 commit、许可证和 NOTICE 固定归档，升级必须跑视觉回归。

### 3.4 WebPPT 与增量生成

`SlideSpec` 使用稳定 `slideId`，分别保存内容块、布局、主题 token、素材引用、讲稿、时间 cue 与转场。Reveal HTML 是可重复编译产物，每页写入 `<aside class="notes">`。编辑或 AI 对话产生字段级 patch，并先显示 diff；依赖哈希决定只重编译、重配音和重渲染脏页。

预览运行在独立 origin 的 sandbox iframe；生成内容不能访问主站 Cookie、Token、文件系统或外网。素材必须代理入库并校验 MIME、尺寸、哈希、来源和许可，终渲染时断网。

### 3.5 TTS 与时长闭环

首批同时评估 MeloTTS 与 Kokoro，Piper 作为速度降级；最终主引擎必须在目标 CPU 上通过中文盲测和性能门槛。逐句合成天然形成句级字幕：

1. 总时长分配到页面和句子。
2. 合成后用媒体探针读取真实时长。
3. 偏差优先通过讲稿压缩/扩写修正，再将语速限制在 0.90–1.10。
4. 最后仅允许很小的时域微调或静音补齐。
5. 保存引擎 revision、voice/model 哈希、原文哈希、语速、句级时间、重试与降级原因。

目标门槛：目标 CPU P95 RTF 不高于 0.8、关键术语无阻断错误、自然度至少 4.0/5、可懂度至少 4.5/5；单页时长误差不高于 `max(0.5 秒, 2%)`。

### 3.6 视频渲染

- Draft：浏览器实时录制或 screencast，追求快速反馈。
- Final：只允许 seek-safe 动画组件，通过 `CourseForgeRender.seek(ms)` 精确逐帧，固定 Chromium、字体、分辨率与帧率；不支持的动画降级为静帧和受控转场。
- 各页独立并行渲染，语音实测时长驱动停留时间，最后无损拼接分段并 mux AAC。
- 目标 MP4：1920×1080、30 fps、H.264 yuv420p、AAC、faststart；同镜像同输入的时间轴完全一致。

## 4. 安全、权限与审计

- 本地账号使用强密码哈希；会话 Token 只存哈希，Cookie 为 HttpOnly、SameSite=Strict，生产必须 Secure。
- 角色至少包含平台管理员、课程编辑、只读用户、审计员；所有项目/任务/产物均做对象级权限校验。
- 审计 actor 只来自服务端会话，覆盖登录、授权、配置、Prompt、生成、重试、下载、发布与删除。
- Provider URL 使用精确 origin allowlist、禁止 URL credentials 和自动重定向，并配合部署层 DNS/出口策略防止 SSRF 与 DNS 重绑定。
- 上传解析、预览与渲染分别在隔离容器；CSP、无特权用户、只读根文件系统和资源配额默认开启。
- 生产只暴露 HTTPS 网关；API、数据库、对象存储和管理界面不映射公网端口。
- Git 门禁包含任意层级 `.env`/证书/材料/媒体/模型忽略规则、pre-commit/pre-push 扫描、CI 安装前扫描和 GitHub push protection。用户提供的真实密钥必须轮换，永不写入仓库。

## 5. 提示词与配置治理

提示词、模型路由、搜索策略、设计规则、讲稿约束、TTS 发音词典和 QA rubric 都是后台可编辑的版本化资源。发布配置经过 schema 校验、diff、测试样例和回滚；运行任务只引用不可变版本。敏感配置只保存 SecretRef，管理 API 永不回显明文。

## 6. 优先级与里程碑

### P0：内部 Alpha 纵向链

- 登录/RBAC/审计、项目与 Brief、真实进度、PostgreSQL。
- 唯一 DeckSpec、Reveal HTML、备注和 RenderManifest。
- Provider Registry、OpenAI 兼容/Agent-Reach/TTS sidecar 安全端口。
- 密钥门禁、同源本地拓扑、单元与契约测试。

退出条件：不调用真实模型也能完整演练权限、项目、九阶段事件和真实 WebPPT artifact；UI 不声称已生成不存在的音频/视频。

### P1：可用培训生成

- 文档/PDF/PPT 解析与 SourceRevision；引用式研究和基础材料编辑。
- Prompt 管理、Provider 管理、SecretRef 管理与 capability probe。
- Huashu Design adapter、三种设计方向、Reveal 预览和逐页局部 patch。
- 对象存储、Artifact API、下载与版本恢复。
- MeloTTS/Kokoro sidecar A/B、句级字幕、术语词典和时长闭环。

退出条件：一份真实制度可生成可审阅 WebPPT 与逐页语音，来源、版本、时长和权限可追踪。

### P2：确定性视频与质量门禁

- Draft/Final renderer、seek-safe 组件库、FFmpeg 分段合成和失败续跑。
- 视觉回归、字体/素材离线、音频响度与时间轴 QA。
- 素材版权/肖像/授权台账、发布审批与可恢复删除。

退出条件：目标环境能稳定生成验收规格 MP4，断网终渲、同输入可复现、页面与音频不串页。

### P3：生产化与规模

- Durable Workflow、分池 Worker、限流、队列、公平调度、缓存与成本计量。
- SSO/OIDC 对接、企业密钥系统、备份恢复、可观测性与灾备演练。
- 生产 HTTPS 网关、安全基线、漏洞扫描、容量/故障注入和运维手册。

退出条件：远端构建成功、所有服务健康、版本端点报告目标 revision，并完成受保护 API、管理后台和真实培训任务验收。

## 7. 验收矩阵

- 功能：上传到材料、Deck、讲稿、语音、视频的可回溯链；任一页可局部修改和续跑。
- 内容：来源可点击、事实抽检通过、内部制度优先、敏感信息不会送往未批准 Provider。
- WebPPT：16:9、中文字体固定、备注不可见于观众视图、PDF 策略明确、断网可预览。
- TTS：中文术语 golden set、盲测、RTF、内存、稳定性、字幕单调无重叠。
- 视频：1080p/30fps、音视频时长、无黑帧/截断、过渡可见、重复构建一致。
- 安全：认证/RBAC/对象权限、SSRF/XSS/文件读取/超大资源负测、Secret 扫描与审计脱敏。
- 运维：迁移可回滚或前向修复、备份恢复、任务取消/重试、结构化告警和容量指标。

## 8. 当前实现映射

截至内部 Alpha，本地代码已经覆盖认证/RBAC、PostgreSQL、MinIO artifact、九阶段进度、安全 Provider 边界、TXT/Markdown SourceRevision、Prompt 版本治理、Deck 三类真实 artifact，以及固定版本、自托管、沙箱化的交互式 Reveal 预览；Caddy 是容器拓扑唯一入口。真实模型调用、联网检索、PDF/PPTX、Huashu 执行、TTS 音频、视频渲染和持久化任务队列仍未启用，也不得在 UI 或发布说明中表示为完成。实时状态以 `docs/implementation-status.md` 为准。
