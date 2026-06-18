# AgentRAG Design

这份文档说明 RAG 和 AgentRAG 的执行路径。配置见 [configuration.md](configuration.md)，评测见 [evaluation.md](evaluation.md)。

## 回答闭环

```mermaid
flowchart LR
  Q["Question"] --> P["Planner"]
  P --> S["Skill selection"]
  S --> R["Retrieval"]
  R --> A["Grounded answer draft"]
  A --> C["Claim support self-check"]
  C -->|supported| F["Finalizer"]
  C -->|unsupported| G["Gap analysis"]
  G --> B["Budget guard"]
  B -->|retry| FR["Focused retrieval"]
  FR --> C
  B -->|stop| CL["Clarification"]
  F --> O["Trace / observability"]
  CL --> O
```

核心目标是让回答过程可解释、可回归：

- Planner 先判断任务类型、文档数量、access scope 和是否需要 skill chain。
- Retrieval 保留文档边界，尤其是 compare 请求。
- Self-check 检查关键 claim 是否能被 citation excerpt 支持。
- Gap analysis 把 unsupported claim 转成 focused retrieval plan。
- Budget guard 阻止无限 follow-up。
- Finalizer 删除或降级仍未被 citation 支持的 claim。

## QA 路径

1. 结合会话记忆把追问改写成独立检索问题。
2. 对复杂问题拆分 evidence requirements，例如时间、生效范围、适用地区。
3. 生成 query embedding，并按选中文档检索。
4. 可选启用 dense + sparse hybrid retrieval，融合方式支持 weighted score 或 RRF。
5. 可选启用 rerank，位置在 retrieval/hybrid 之后、confidence gate 之前。
6. 使用置信度门控过滤低相关或缺少 anchor coverage 的证据。
7. 生成 grounded answer、citations、evidence summary 和 AgentRAG observability。

## Compare 路径

普通全局 top-k 很容易让最匹配的一份文档挤掉其他文档。Compare pipeline 从检索阶段保留文档边界：

1. 识别显式对比、比较级问题、跨文档一致性等信号。
2. 对每份文档分别检索 `RAG_COMPARE_TOP_K_PER_DOC` 条证据。
3. 对每份文档独立 rerank。
4. 对齐证据，分析 shared terms、近重复、数值差异和显式冲突。
5. 如果证据高度近似且无冲突，走 deterministic no-difference guard。
6. 否则生成结构化 comparison answer：Summary、Per document、Agreements、Differences、Gaps。

## Skill registry

AgentRAG 的工具能力通过 `server/rag/skills/registry.js` 注册。

内置 skills 位于 `server/rag/skills/built-ins.js`：

- `arxiv_import`
- `document_rag`
- `web_search`
- `inventory`
- `document_discovery`
- `research_brief`

白名单 custom skills 位于 `server/rag/skills/custom/`：

- `extract_timeline`：从选中文档中提取带 citation 的时间线。
- `summarize_contract`：输出带 citation 的合同摘要。
- `risk_review`：生成带 citation 的风险、缺口、冲突和例外审查。
- `compare_documents`：生成结构化文档对比。

当前白名单 skill chain：

- `summarize_contract -> risk_review`
- `compare_documents -> risk_review`
- `extract_timeline -> compare_documents`

新增 skill 需要稳定的 `id`、`version`、`label`、`budgetKey`、`requiresAccessScope`、确定性的 `match()`，以及接收 `accessScope` 的 `execute()`。Custom skills 只通过 `server/rag/skills/custom/index.js` 白名单加载，不允许模型调用任意未注册工具。

## 关键模块

| 模块 | 职责 |
| --- | --- |
| `server/rag/agent-planner.js` | 请求分类、planner actions、skill/chain 选择、执行前 clarification 判断。 |
| `server/rag/arxiv-client.js` | arXiv Atom API 查询、feed 解析和 PDF 下载校验。 |
| `server/rag/arxiv-enrichment.js` | 从已上传文档的本地 profile keyphrases 生成 arXiv topic、过滤私密实体和内部术语、对候选做 relevance check、返回签名候选 token，保存 recommendation snapshot，并提供 arXiv recommendation import runner。 |
| `server/rag/arxiv-importer.js` | 按 topic 或已确认候选列表下载 arXiv PDF，导入前按 arXiv ID / PDF URL / title hash 去重，写入 `profile.source` provenance，通过现有文档 ingestion 写入索引，并通过可选 progress callback 汇报 per-paper 状态。 |
| `server/rag/arxiv-identity.js` | 规范化 arXiv ID、PDF URL 和 title hash，集中提供导入去重所需的身份匹配规则。 |
| `server/rag/external-query-policy.js` | 外部工具调用前的 query policy，统一清理 candidate query 中的私密实体、内部项目码和泛化敏感词；返回可记录的 sanitized query、redacted removed terms、risk flags 和 allow/deny 状态。 |
| `server/rag/recommendation-snapshots.js` | 保存 provider/doc/access-scope 维度的推荐 snapshot，供用户 dismiss 后从文档详情重新查看；当前 arXiv 使用该接口，未来外部 enrichment provider 可复用。 |
| `server/rag/tasks.js` | 定义 scope-aware task contract 和 async task service，接口只关心 task type/status/counts/subject/provider，不绑定具体 provider、数据库或执行方式。 |
| `server/rag/task-store.js` | 根据 `TASK_STORE_PROVIDER` 选择 task store adapter；默认 `auto` 会在 PostgreSQL 配好时使用持久化 store，否则使用内存 store。 |
| `server/rag/postgres-task-store.js` | PostgreSQL task store adapter，保存 task 当前快照和审计事件；内部 `payload` 只给 runner 使用，不从 API 暴露。 |
| `server/rag/agent-runs.js` | 定义 agent run contract 和 service，记录 goal、plan、steps、observations、decisions、approval gates、result/error 和审计 events。 |
| `server/rag/agent-run-step-executor.js` | 执行和恢复已持久化 run step；只负责 action/retry 编排和 step handler 派发，让 HTTP route 不绑定具体工具执行细节。 |
| `server/rag/agent-run-recovery.js` | 启动时扫描 recoverable run；默认只标记人工恢复，`AGENT_RUN_RECOVERY_MODE=auto` 时只通过 step executor 恢复安全 RAG-only step，审批和未知 step 回落人工。 |
| `server/rag/agent-run-step-replay-safety.js` | 固定 step replay safety matrix：每类 step 的必需 input、retry/resume action、审批要求、auto replay 安全性和幂等性说明；recovery policy 和 handler registry 复用同一份 contract。 |
| `server/rag/agent-run-step-handlers.js` | 定义可插拔 step handler registry；当前 capability/web/arXiv 通过 capability adapter 执行，`document_rag` handler 预留可注入 resumer，未接线时返回稳定 409。 |
| `server/rag/agent-run-store.js` | 根据 `AGENT_RUN_STORE_PROVIDER` 选择 agent run store adapter；默认 `auto` 跟随 PostgreSQL 可用性，否则使用内存 store。 |
| `server/rag/postgres-agent-run-store.js` | PostgreSQL agent run store adapter，保存 run 当前快照和 run event log，供 `/agent-runs` 审计接口读取。 |
| `server/rag/job-orchestrator.js` | 根据 task 的 `runnerId` 分发 `confirm/cancel` 等动作，调度 runner 执行，启动时恢复 queued/running task，并把 queued/running/completed/failed/canceled 生命周期写回 task log。 |
| `server/rag/recommendation-tasks.js` | 将外部推荐发现、等待确认、排队导入、per-paper progress、导入完成或失败映射成 `external_recommendation` task；当前 arXiv 使用该 adapter，未来异步 ingestion job 可复用同一 task contract。 |
| `server/rag/capabilities/` | 定义 capability registry 和第一批 built-in adapters；capability contract 包含 `id/version/inputSchema/accessScope/approvalPolicy/privacyPolicy/execute()`，当前覆盖 arXiv topic import、web search 和 workspace document discovery。 |
| `server/rag/arxiv-selection-token.js` | 对文档级 arXiv 推荐结果签名和验签，确保确认导入的是用户看到的候选。 |
| `server/rag/agent-query-planner.js` | 为 document/custom skill 生成 retrieval plan、动态 topK 和实际检索 queries。 |
| `server/rag/agent-document-loop.js` | Document RAG、self-check、gap analysis、follow-up retrieval、claim/gap 更新。 |
| `server/rag/agent-run-context.js` | Trace append、budget snapshot、agent trace 记录、clarification 响应 orchestration。 |
| `server/rag/agent-working-memory.js` | Run-scoped checked queries、supported/unsupported claims、resolved/unresolved gaps。 |
| `server/rag/agent-skill-observability.js` | Per-skill attempts、duration、citations、abstain、retry/follow-up、budget、error。 |
| `server/rag/agent-finalization-flow.js` | Agent mode resolution、source selection、synthesis、finalizer、最终响应组装。 |
| `server/rag/agent-response-builder.js` | `/chat` response fields、status code 行为、error wording。 |
| `server/rag/agent-trace.js` | Trace step summary 和 compact trace serialization。 |

`server/rag/agent.js` 应保留为主流程编排，不应重新堆入 planner、trace、working memory、observability 或 finalization 细节。

前端 Chat scope 控制只改变传给 `/chat` 的 `docIds`：默认 `Uploaded` 排除外部 arXiv 文档，`All` 包含工作区全部文档，`Selected` 使用用户在文档列表中勾选的文档。

## `/chat` observability

`/chat` 响应会返回：

- `agentSkills`：本轮候选和实际选中的 skills。
- `agentTrace`：plan、query planner、skill chain、document RAG、self-check、gap analysis、follow-up、finalizer 等步骤。
- `agentObservability`：execution planner selected/fallback 状态、per-skill attempts、duration、citations、abstain、retry/follow-up、budget、error 和 working memory。
- `agentWorkingMemory`：本次 run 内的检索 query、supported/unsupported claims、resolved/unresolved gaps。

前端 trace UI 位于 `src/components/RenderQA.js`，会展示选中的 skills、skill chains、retrieval queries、evidence gaps、unsupported claims 和 finalizer 删除内容。

## Clarification gate

普通 scope 问题不应该抛异常。Agent 需要用户输入时，返回：

- `agentMode: "clarification"`
- `clarification.reason`
- `clarification.question`
- `agentTrace` 中的 `clarification_gate`

常见触发原因：

- `missing_required_documents`
- `comparison_requires_multiple_documents`
- `too_many_documents`
- `document_follow_up_budget_exhausted`

## Working memory

Working memory 是一次 agent run 内的短期状态，不写入长期记忆。它记录：

- 本次目标
- 实际执行过的 retrieval queries
- Supported / unsupported claims
- Resolved / unresolved gaps
- Execution loop counters

Feedback record 和 feedback corpus metadata 会保留这些信息，方便把负反馈定位到具体 skill 和执行阶段。
