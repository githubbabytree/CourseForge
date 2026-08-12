# CourseForge v1.0.0 发布验收门

本文件保留历史路径以兼容既有链接。代码测试通过只代表源代码发布门通过，不能代替目标主机和真实 Provider 验收。

## 身份与授权

- 匿名请求不能读取项目、任务、Provider 配置或审计事件。
- 服务端只从 HttpOnly Session 推导操作人，忽略客户端伪造的 actor header。
- 编辑者只能创建和运行有权限的项目；只读用户不能写入；审计查询仅限管理员和审计员。
- 登录、失败登录、项目创建、生成和特权读取产生不含凭据的追加式审计记录。

## 耐久数据

- PostgreSQL 全部迁移可在空库执行，并以文件名和 SHA-256 幂等记录。
- API/Worker 重启后，用户、项目、任务、检查点和审计仍然存在。
- 备份和恢复后，revision 链、Artifact ID 和内容哈希保持一致。

## Provider 边界

- 文本、多模态、搜索、设计、TTS、Deck 和视频 Provider 均由固定的运行快照解析。
- HTTP/命令适配器只通过运行时 resolver 取得密钥；请求 DTO、日志、错误、追踪和审计不得包含密钥。
- 已发布 Provider 版本的变更只影响新任务。
- Huashu Design 和所有 TTS 引擎保持可替换模块，不直接耦合业务工作流。

## 端到端行为

- 浏览器完成登录、课程创建、材料导入、生成，并显示服务端任务进度和耗时。
- `DeckSpec` 编译成自托管 Reveal WebPPT，并包含不可见于观众视图的逐页讲稿。
- SpeechManifest 使用实测音频时长，任务可以从已验证检查点恢复。
- Demo/内存回退必须显著标识，不能冒充持久化在线数据。
- QA 和发布验证 Deck、讲稿、音频、视频及交付包的精确 Artifact/哈希链。

## 源代码发布门

- 从锁文件干净安装后，`npm run verify` 全部通过。
- Git index、当前候选文件和可达历史不存在真实凭据、内部地址、材料、生成媒体或模型权重。
- package、lockfile、API `/version` 源和示例部署 revision 一致。
- Pull Request CI 通过，合并提交与 `v1.0.0` 标签指向同一 commit。

## 目标环境门

- 镜像在目标主机成功构建，全部服务健康，只有网关暴露端口。
- `/health`、`/ready`、`/version` 报告目标 revision 和实际耐久后端。
- 真实 Provider、中文 TTS、Chromium/FFmpeg、备份恢复和受保护浏览器/API 闭环通过。
- 任何曾出现在聊天或日志中的凭据已经撤销并轮换。

目标环境门由部署方留存证据；GitHub v1.0.0 源代码 Release 不表示这些环境门已经完成。
