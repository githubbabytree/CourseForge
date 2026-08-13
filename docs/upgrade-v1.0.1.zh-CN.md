# CourseForge v0.2.0-alpha.2 → v1.0.1 升级说明

本说明只适用于保留 `v0.2.0-alpha.2` PostgreSQL 与 MinIO 数据的原地升级。全新安装继续使用默认 Compose 项目名 `courseforge`。

## 高危兼容点

Alpha 版本使用项目名 `courseforge-alpha`，正式版本默认使用 `courseforge`。Compose 项目名会成为命名卷前缀；直接用新名称启动时，旧卷通常没有被删除，而是新栈挂载了另一组空卷，表现为用户、项目和 Artifact“消失”。

禁止使用 `docker compose down -v`，也不要通过 `sed` 修改 release 中的 `infra/compose.yaml`。升级时在未纳入 Git 的 `infra/.env` 中设置：

```dotenv
COURSEFORGE_COMPOSE_PROJECT_NAME=courseforge-alpha
```

## 标准升级流程

1. 保持旧栈运行，使用 `scripts/backup.sh --execute` 完成 PostgreSQL+MinIO 备份，并在隔离空目标做恢复演练。
2. 获取 v1.0.1 源码，复制旧部署的随机密码和身份配置到新的 `infra/.env`，补充所有新增必填变量；不要复制聊天或日志中出现过的凭据。
3. 在新 `.env` 中设置 `COURSEFORGE_COMPOSE_PROJECT_NAME=courseforge-alpha`。
4. 对已完成的备份运行只读预检：

```bash
COURSEFORGE_ENV_FILE="$PWD/infra/.env" \
  scripts/upgrade-preflight.sh \
  --from-project courseforge-alpha \
  --backup-dir /absolute/path/to/verified-backup
```

5. 预检通过后，从旧 release 目录停止旧栈，不加 `-v`；再从 v1.0.1 仓库根目录构建并启动：

```bash
docker compose --env-file infra/.env -f infra/compose.yaml build --pull
docker compose --env-file infra/.env -f infra/compose.yaml up -d --wait --wait-timeout 300
```

6. 验证 `/api/version`、`/api/ready`、全部 migration、用户/项目/Artifact 数量及抽样内容哈希。
7. 验证 CORS、Provider、Prompt、Search、WebPPT、TTS/视频和发布下载。首次配置清单见[目标主机部署交接](operator-deployment-handoff.zh-CN.md)。

## Fail-closed 情况

升级预检在以下任一情况拒绝继续：备份 Manifest 缺失或哈希错误、旧 PostgreSQL/MinIO 卷不完整、目标项目名与旧项目名不一致、旧卷与新卷同时存在。脚本只读，不启动服务、不修改或删除卷；歧义必须由运维先确定正确数据集并完成备份。
