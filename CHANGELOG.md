# 更新日志

本项目遵循语义化版本。日期统一使用 UTC+8。

## [1.1.0] - 2026-08-13

### 新增

- 增加 `course-full` 运行就绪度门禁，按不可变快照核验 Text、Search、Design、Multimodal、TTS、Video、十个业务 Prompt、发音词典、设计模板、QA Policy 与真实能力探针。
- 增加代码侧 Prompt Definition Catalog、安全内置只读 Prompt，以及缺失业务 Prompt 的预览和 Draft 初始化。
- 增加 `StyleProfileV1`、`VisualReviewV1` 与人工视觉确认契约；风格令牌可固定绑定到设计计划和 Deck。
- 视频 Worker 输出逐页 1920×1080 PNG Artifact，并由确定性检查和严格 Schema 多模态复核复用。
- 增加风格档案、视觉复核、最新复核和人工确认 API；发布要求当前 Deck/截图哈希对应的视觉确认。

### 安全与可靠性

- Text 与 Multimodal 探针改为真实严格 JSON Schema 生成；多模态探针必须识别合成图片内容。
- Search、Design、TTS、Video 探针改为实际能力调用；Provider 只有在发布后新鲜健康探针通过时才能发布或进入新快照。
- TTS 固定模型 SHA-256 与许可证证明；Video 固定镜像、Chromium、FFmpeg、字体并执行最小真实渲染。
- Prompt 快照增加内容哈希；旧快照保持可读，但无哈希绑定时不可运行。
- 新增视觉治理 Artifact 的 PostgreSQL 约束迁移。

### 需要部署方验收

- 生产凭据、TTS 模型/音色/许可证、Video 镜像和字体仍须运维提供并人工审批，运行时不会下载模型。
- 只有备份 PostgreSQL/MinIO、运行全部真实探针、创建新快照并完成 6 页课程的 QA、人工确认、发布和下载后，才可宣称生产全流程跑通。

## [1.0.1] - 2026-08-13

### 修复

- 修复主容器构建阶段缺少 Python，导致 `tts-worker` 编译失败的问题。
- 修复 video-worker 镜像未按完整 workspace lockfile 安装嵌套生产依赖的问题。
- Compose 项目名改为显式可配置，并增加 Alpha 升级卷/备份只读预检，避免旧数据因卷前缀变化而不可见。
- 增加无明文凭据的 mcporter/Exa 配置模板和只读挂载入口。
- 增加独立多 Origin CORS 配置，并保留单一 Public Origin 的兼容回退。
- CI 增加主镜像及 video-worker 的真实构建、依赖导入和健康检查。

### 文档

- 增加 Alpha 到 v1.0.1 的中文升级流程、DNS 诊断、Provider 白名单、Search/Multimodal probe 和真实镜像 digest 说明。

## [1.0.0] - 2026-08-13

CourseForge 首个正式源代码版本，提供从培训需求输入到 WebPPT、中文语音、视频、QA 和发布交付的一站式平台底座。

### 新增

- 向导式 Brief、数据策略、受众/目标/时长补全与真实任务进度。
- TXT、Markdown、文本型 PDF、DOCX、PPTX 安全导入和可追溯引用。
- 文本、多模态、Agent-Reach、Huashu Design、TTS 与视频模块化 Provider。
- Reveal.js WebPPT、安全预览、备注、版本修订、字段锁与局部重生成。
- MeloTTS/Kokoro/Piper sidecar 协议、逐页 WAV、VTT/SRT 和时长修订闭环。
- Playwright/FFmpeg 视频 Worker、精确帧时间线、受控转场、MP4 完整性与 Range 下载。
- PostgreSQL 耐久任务、MinIO 私有产物、断点恢复、取消、审计和 UTC+8 展示。
- Provider/Prompt/模板/QA 策略/发音词典治理，以及用户、角色和审计管理。
- 机器 QA、人工审批、不可变发布、撤回、保留/GC、离线 WebPPT ZIP 与发布清单。
- Caddy 单入口容器拓扑、指标、备份恢复、容量报告和安全发布门禁。

### 安全

- 凭据只允许通过运行时引用注入，HTTP 响应、审计、任务和日志统一脱敏。
- 外部证据和图片下载采用 HTTPS、DNS/IP 固定、逐跳重定向复核、大小/MIME/哈希限制。
- 文档解析、TTS 和视频 Worker 使用私网、非 root、只读文件系统和资源限制。
- 提交、推送和 CI 均执行敏感信息扫描；模型权重、生产配置和用户材料默认被 Git 忽略。

### 需要部署方验收

- 真实模型/搜索/设计服务的凭据、许可、连通性和出网策略。
- 中文 TTS 盲听、目标 CPU RTF/内存/稳定性与术语词典。
- 目标主机 Chromium 沙箱、中文字体、FFmpeg、真实 MP4 和备份恢复演练。
