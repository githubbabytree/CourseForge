# QA 与项目数据策略治理

所有管理时间由 Web 统一按 Asia/Shanghai（UTC+8）显示，API 仍保存 ISO-8601 UTC 时间。

## QA Policy

`QaPolicyVersion` 是不可变版本，状态只允许 `draft -> published -> inactive`。仅 `platform_admin` 可创建或变更状态，`platform_admin` 与 `auditor` 可读取。创建运行配置快照时绑定当时最新的已发布策略 `{qaPolicyId, version, contentHash}`；没有已发布策略时快照仍可用于非 QA 工作，但机器 QA 必须 fail closed。

机器 QA 从快照绑定版本读取引用覆盖率、讲稿覆盖率、图片许可白名单、总时长容差、视频证据等级和发布所需人工审批。QA Report 保存同一 provenance，后续策略发布不会改变历史报告的判定依据。

## Project data policy

项目创建和 Brief 更新必须持久化策略。缺省为 `offline/private`：

- `offline/private`：禁止外部 text、search、design、multimodal 调用。
- `internal/internal`：Provider 必须显式设置 `dataBoundary=internal`，并分别用 `internalAllowedOrigins` 或 `internalAllowedExecutables` 精确匹配。
- `public-only/public`：仅允许结构化公开搜索查询；SourceRevision 正文、内部 Brief 字段、设计及多模态载荷会明确拒绝，不会静默降级。

策略门在 Secret 解析、网络请求或进程执行之前运行。审计仅写策略 mode/hash 和输入 hash，不写 Brief 或 SourceRevision 正文。所有模型提示词仍必须来自运行快照绑定的已发布 PromptVersion。
