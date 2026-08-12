# CourseForge 目标主机部署交接

本文只描述运维人员在目标主机执行的步骤。代码交付方不连接目标主机，也不代填任何真实账号、API Key、模型凭据或内部接口地址。

## 1. 部署前准备

1. 从已审核的 Git revision 获取源码，并确认 `git status --short` 为空。
2. 将 `infra/.env.example` 复制为 Git 已忽略的 `infra/.env`，权限设为 `0600`。
3. 替换所有示例值。数据库、MinIO、管理员、TTS/Video worker token 使用不同的随机值；任何曾出现在聊天、日志或历史提交中的凭据必须先轮换。
4. 生产环境必须同时设置 production profile、HTTPS 站点地址、HTTPS public origin 和 secure cookies。缺少其中任一项时不得对外开放。
5. 当前内置 resolver 只支持 `env://...`。Provider 凭据只放入目标主机的 Secret 管理系统并以运行时环境变量注入，后台配置只保存对应 `env://...` 引用；`secret://...` 必须在另行接入 SecretResolver 后才能使用，当前 Compose 不得配置它。
6. TTS 模型、音色、浏览器、FFmpeg 和字体文件不得提交到 Git；上线前记录来源、许可证、revision/digest 和 SHA-256。

## 2. 构建与启动

```bash
docker compose --env-file infra/.env -f infra/compose.yaml config --quiet
docker compose --env-file infra/.env -f infra/compose.yaml build --pull
docker compose --env-file infra/.env -f infra/compose.yaml up -d --wait --wait-timeout 300
```

Compose 只允许 Caddy gateway 发布宿主机端口。API、Web、PostgreSQL、MinIO、文档解析、TTS 和视频 worker 必须留在私有网络。

启动后先检查：

- `/api/health`、`/api/ready` 返回健康，且 backend 状态与实际 PostgreSQL、S3、durable workflow 一致；
- `/api/version` 中部署 revision 与目标 Git revision 一致；
- `schema_migrations` 包含仓库中全部 migration，名称和 checksum 均匹配；
- 公网 `/api/metrics` 返回 404，私网采集端点可读；
- 浏览器收到 HTTPS、Secure/HttpOnly/SameSite session cookie，非允许 Origin 被拒绝。

## 3. 首次后台配置

使用 bootstrap 管理员登录后，按顺序完成：

1. 创建 Provider 版本：text、multimodal、search、design、tts、video。text/multimodal 使用平台内置 capability probe；其他类型按对应 Worker/Adapter 文档完成健康、版本和真实请求验收。当前快照创建不会自动强制 probe，管理员只能发布并选用已经留存验收证据的 Provider。
2. 创建并发布提示词版本。当前关键键包括 `brief.assistant`、`course.research`、`course.material`、`course.design-directions`、`course.deck`、`revision.patch`、`visual.analysis` 和 `tts.duration-revision`。
3. 发布 TTS 发音词典；确认 snapshot 固定词典 ID、版本和内容哈希，sidecar 返回相同 hash proof。
4. 配置 QA policy、设计模板、素材许可策略和项目数据策略，再创建 immutable runtime snapshot。
5. Search、multimodal、design、TTS、video endpoint 必须是经批准的精确 origin；worker 不得拥有用户 session、数据库凭据或 MinIO root 凭据。

## 4. 功能验收顺序

建议用一门 6 页、约 5 分钟的中文信息安全课程完成闭环：

1. 登录、角色和项目隔离；审计时间在 UI 显示为 UTC+8。
2. 在调用外部模型前选择数据策略；导入 TXT/Markdown/PDF/DOCX/PPTX，验证危险文档、超限和凭据内容均 fail closed。
3. Brief AI 补全、研究证据、基础材料、三套设计方向、模板与素材选择。
4. 生成 Reveal WebPPT，检查翻页、speaker notes、局部修订、锁定、撤销和脏页复用。
5. 使用真实 CPU TTS 生成逐句音频和 VTT/SRT，检查词典 proof、实际时长、修订闭环与断点续跑。
6. 使用真实 Chromium/FFmpeg 生成 MP4，检查固定字体、帧数、音画误差、转场、Range 播放和重启后持久化。
7. 运行机器 QA、三类人工审批和异步发布任务；任务未完成时下载入口必须不可用。
8. 下载 WebPPT ZIP、MP4、VTT/SRT 和 release manifest，逐项验证 artifact ID、SHA-256 和 provider/renderer provenance。
9. 撤回发布后，所有发布下载均返回 410；保留/GC 先 dry-run，再用独立 DeleteObject 身份执行。
10. 完成 PostgreSQL+MinIO 备份和隔离空目标恢复演练。

## 5. 性能与发布门

- 在目标 CPU 上用不少于 30 分钟中文安全语料运行 TTS benchmark：P95 RTF、冷启动、峰值 RSS、失败率和术语盲测全部达标后才能标记该 voice 可用。
- 运行 `scripts/video-worker-evidence.sh`，证明 Chromium sandbox、字体 hash、FFmpeg revision 和真实 MP4 渲染。
- 运行 `scripts/container-smoke.sh` 或等价的隔离栈验收，证明迁移、登录、生成、Artifact、PostgreSQL/MinIO 重启持久性和 gateway-only ingress。
- 运行 `scripts/backup.sh` 与 `scripts/restore.sh` 的显式执行模式，在隔离环境留下 manifest/checksum/RTO 证据。

任一目标主机门未完成时，只能标记为“代码就绪、部署待验收”，不能标记为生产发布完成。
