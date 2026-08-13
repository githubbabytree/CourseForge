# 更新日志

本项目遵循语义化版本。日期统一使用 UTC+8。

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
