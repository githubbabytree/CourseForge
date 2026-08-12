# CourseForge 生产运维手册

本手册覆盖可观测性、备份恢复、容量报告和生产 TLS 启动门。这里的命令不会把凭据写入日志或备份清单。部署密钥只存在于被忽略的运行时环境文件中。

## 时间约定

数据库、结构化日志、Prometheus 采样和备份 `manifest.json` 一律保存 UTC ISO 8601 时间（以 `Z` 结尾）。只有 Web UI 向用户展示时转换为 Asia/Shanghai（UTC+8）。不要在存储层写本地时区字符串。

## 日志、指标与健康检查

API 为每个响应返回 `X-Request-Id`，接受合法 UUID 请求 ID，否则生成新值。标准输出每个请求一行 JSON，只包含 UTC 时间、请求 ID、方法、归一化路由、状态码、耗时和稳定失败分类。日志和指标都不得包含项目标题、用户邮箱、提示词、请求正文、Cookie 或 Secret。

`/health`、`/ready` 和 `/version` 保留现有语义。Prometheus `/metrics` 只允许私有/回环来源。Caddy 对公共 `/api/metrics` 固定返回 404；采集器必须位于私有容器网络并直接采集 `api:3001/metrics`。指标提供：

- HTTP 请求数、耗时、稳定失败分类；
- 工作流终态、阶段转换、阶段耗时和失败分类；
- 所有标签均为低基数枚举或已归一化路由，不含项目或用户字段。

## TLS fail-closed 与单一入口

生产设置至少包括：

```dotenv
COURSEFORGE_DEPLOYMENT_PROFILE=production
COURSEFORGE_SITE_ADDRESS=https://training.example.invalid
SECURE_COOKIES=true
```

当站点地址使用 `https://`，或部署 profile 为 `production` 时，API 在 `SECURE_COOKIES` 不为精确值 `true` 时拒绝启动。Compose 只发布 gateway；Web、API、PostgreSQL、MinIO 和工作进程不得增加宿主机 `ports`。TLS 终止在 gateway，API 仍在私网使用 HTTP。

## PostgreSQL 与 MinIO 备份

备份目录固定在 `COURSEFORGE_BACKUP_ROOT`（默认 `/var/backups/courseforge`），必须为绝对且无 `..` 的路径。脚本默认 dry-run；真正执行必须显式传入 `--execute`：

```bash
COURSEFORGE_ENV_FILE=/path/to/ignored/runtime.env \
COURSEFORGE_BACKUP_ROOT=/var/backups/courseforge \
./scripts/backup.sh --execute
```

备份先写同一根目录下权限为 0700 的临时目录，全部完成后才原子移动到 UTC 命名的最终目录。内容包括 PostgreSQL custom-format dump、数据库实际迁移版本/校验和、MinIO 对象及 `manifest.json`。清单记录 CourseForge 版本、UTC 创建时间、对象数量/总字节以及每个文件的 SHA-256；不记录连接串或访问密钥。

## 恢复演练

恢复是破坏性运维动作，必须在隔离的空目标上演练。先停止 API 和所有写入者，准备全新空 PostgreSQL 数据库与空 MinIO bucket，再运行：

```bash
./scripts/restore.sh --backup-id 20260101T000000Z
./scripts/restore.sh --execute \
  --backup-id 20260101T000000Z \
  --confirm RESTORE_20260101T000000Z
```

第一条只打印计划。第二条先逐文件校验 manifest 哈希，再确认 PostgreSQL public schema 没有表、MinIO bucket 没有对象；任一条件不满足就拒绝恢复。恢复完成后再次验证备份哈希。随后启动应用，并验证 `/ready`、`/version`、目标迁移列表、抽样项目元数据与抽样 artifact 内容哈希。

建议每月至少完成一次隔离恢复演练并记录：备份 ID、开始/结束 UTC 时间、RTO、抽样 artifact ID、校验结论和执行人。不要把运行时环境文件或演练凭据附入记录。

## 容量、配额与保留

容量工具严格只读，默认也是 dry-run：

```bash
./scripts/capacity-report.sh
./scripts/capacity-report.sh --execute > /secure/report.json
```

报告包含项目数、artifact 数/声明字节/类型分布、数据库字节、工作流状态分布、活跃任务和失败任务。可通过 `COURSEFORGE_REPORT_ARTIFACT_QUOTA_BYTES`、`COURSEFORGE_REPORT_DATABASE_QUOTA_BYTES` 和 `COURSEFORGE_REPORT_FAILED_JOB_WARNING` 设置告警阈值。超过阈值只生成 warning；系统不自动删除项目、artifact、审计或任务记录。清理由管理员根据合规保留期单独审批和实施。

## 发布门

无 Docker 的 CI 仅验证 shell 语法、dry-run、安全路径和清单篡改检测。正式发布仍必须在目标容器环境完成：锁定镜像构建、仓库全部 migrations 及 checksum、gateway-only 端口、公共 metrics 404/私网 metrics 200、TLS/secure-cookie 拒绝启动测试、真实 PostgreSQL+MinIO 备份、隔离空目标恢复、对象抽样哈希和应用版本核对。静态 CI 通过不能替代这些门。
