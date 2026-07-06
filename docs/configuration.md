# Configuration

这份文档只放配置细节。快速启动入口见 [README](../README.md)。

## 环境文件

```bash
cp .env.example .env
cp server/.env.example server/.env
```

前端读取根目录 `.env`，后端读取 `server/.env`。

## 最小后端配置

```env
OPENAI_API_KEY=your_openai_api_key
SERPAPI_KEY=your_serpapi_key

POSTGRES_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/agentai
POSTGRES_SSL_ENABLED=false

VECTOR_STORE_PROVIDER=local
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_CHAT_MODEL=gpt-5

RAG_CHUNK_STRATEGY=structured
RAG_CHUNK_SIZE=900
RAG_CHUNK_OVERLAP=180
RAG_RETRIEVAL_TOP_K=6
RAG_COMPARE_TOP_K_PER_DOC=3

STARTUP_HEALTH_STRICT=false
```

## 前端配置

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `REACT_APP_DOMAIN` | `http://localhost:5001` | 后端 API 地址。 |
| `REACT_APP_API_AUTH_TOKEN` | 空 | 启用 API auth 时，前端通过 `x-api-key` 发送的 token。 |

## 后端基础配置

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 无 | 生成 embeddings 和回答所需。 |
| `SERPAPI_KEY` | 无 | Web answer 搜索所需；只跑文档 RAG 可先不配。 |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | 文档 chunk 与 query 的 embedding 模型。 |
| `OPENAI_CHAT_MODEL` | `gpt-5` | 文档答案、对比答案、网页摘要使用的模型。 |
| `AGENT_PLANNER_ROLLOUT` | `llm` | AgentRAG planner 灰度模式；`configured` 使用下面两个显式 planner 变量，`shadow` 执行 deterministic 主路径并把 LLM intent/execution proposal 记录到 `agentObservability.*Planner.shadow`，`guarded_llm` 让 LLM 作为主 planner 但继续由 validator/fallback 兜底，`llm`/`deterministic` 会同时覆盖 intent 和 execution planner。 |
| `AGENT_INTENT_PLANNER` | `llm` | AgentRAG intent 选择器；`deterministic` 使用规则候选首选项，`llm` 让 LLM 在白名单候选 intent 中选择并由 validator 兜底。 |
| `AGENT_EXECUTION_PLANNER` | `llm` | AgentRAG execution step 规划器；`deterministic` 使用固定 step schema，`llm` 让 LLM 在白名单 step 中排序并由 validator 兜底。 |
| `RAG_PROMPT_VERSION` | `v3` | Prompt 版本；`server/.env.example` 当前显式设置为 `v2`。 |
| `STARTUP_HEALTH_STRICT` | `false` | 健康检查失败时是否阻止启动。 |

arXiv topic 导入使用公开 Atom API，不需要额外 API key；后端需要能访问 `https://export.arxiv.org/api/query` 和对应 PDF URL。

## Model/provider registry

`server/rag/model-providers/` 是 provider/model registry 和 runtime route resolver。`server/rag/openai.js` 通过它选择 chat/embedding model name；LLM intent/execution planner 会把公开 `modelRoute` 写入 observability；LLMOps metrics 也复用同一份公开 `modelRoute` 作为 completion/embedding/rerank 的聚合维度；cross-encoder rerank 在 `RAG_CROSS_ENCODER_MODEL` 未显式配置时，可以从 registry route 读取 model name。

默认 registry 从现有变量生成 OpenAI routes：

| Route | Capability | 默认模型来源 |
| --- | --- | --- |
| `chat.default` | `chat` | `OPENAI_CHAT_MODEL` |
| `embedding.default` | `embedding` | `OPENAI_EMBEDDING_MODEL` |
| `planner.intent.default` | `intent_planner` | `OPENAI_CHAT_MODEL` |
| `planner.execution.default` | `execution_planner` | `OPENAI_CHAT_MODEL` |

每个 model contract 记录 stable model id、provider model name、capabilities、latency、pricing 和 workspace policy tags。Route resolution 支持 primary/fallback model，以及 workspace policy 的 allowed/blocked model/provider ids 和 required policy tags。后续接线多 provider 或 fallback 时，应复用这个 registry，而不是在 OpenAI、planner、embedding、rerank 模块各自解析一套模型配置。

公开 `modelRoute` metadata 只包含 route/model/provider id、状态、candidate/fallback/rejected model ids，不包含 API key、secret ref value、transport、prompt、pricing rate 或内部 model name。当前 registry 负责模型选择，LLMOps metric contract 负责把公开 route、latency、status、输入/输出规模、token usage/source、estimated cost/pricing source 和 report-only latency SLO 写入 observability；annotation、alerts 和 budget enforcement 属于后续集成。

## 存储配置

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `POSTGRES_DATABASE_URL` | 空 | 文档、会话记忆和长期记忆共用连接。 |
| `POSTGRES_SSL_ENABLED` | `false` | PostgreSQL 是否启用 SSL。 |
| `DOCUMENTS_POSTGRES_TABLE` | `rag_documents` | 文档表。 |
| `SESSION_MEMORY_POSTGRES_TABLE` | `rag_session_memory` | 会话记忆表。 |
| `LONG_MEMORY_POSTGRES_TABLE` | `long_memory_items` | 长期记忆表。 |
| `RAG_LONG_MEMORY_ENABLED` | PostgreSQL configured -> `true`，否则 `false` | 是否启用长期记忆；显式设为 `false` 会覆盖 PostgreSQL 默认开启。 |
| `RAG_AGENT_EXPERIENCE_MEMORY_ENABLED` | long memory enabled -> `true`，否则 `false` | 是否启用 Agent experience memory；只作为规划提示，不作为文档证据，依赖 long memory。 |
| `TASK_STORE_PROVIDER` | `auto` | task/job 存储；`auto` 在 PostgreSQL 配好时使用 `postgres`，否则使用 `memory`。 |
| `TASKS_POSTGRES_TABLE` | `rag_tasks` | task/job 当前快照表。 |
| `TASK_EVENTS_POSTGRES_TABLE` | `rag_task_events` | task/job 审计事件表。 |
| `AGENT_RUN_STORE_PROVIDER` | `auto` | Agent run 存储；`auto` 在 PostgreSQL 配好时使用 `postgres`，否则使用 `memory`。 |
| `AGENT_RUN_RECOVERY_MODE` | PostgreSQL-backed run store 时为 `auto`，否则 `manual` | Agent run 启动恢复模式；不显式设置时，PostgreSQL-backed agent run store 会默认自动恢复安全的 RAG-only pending/running/paused step，非持久化 run store 仍默认 `manual`；显式 `manual` 只标记 recoverable run 等待人工处理，`auto` 遇到审批或不安全 step 会回落人工，`off` 跳过启动恢复。 |
| `AGENT_RUNS_POSTGRES_TABLE` | `rag_agent_runs` | Agent run 当前快照表。 |
| `AGENT_RUN_EVENTS_POSTGRES_TABLE` | `rag_agent_run_events` | Agent run 审计事件表。 |
| `ADMIN_AUDIT_STORE_PROVIDER` | `auto` | Admin audit 存储；`auto` 在 PostgreSQL 配好时使用 append-only PostgreSQL event store，否则使用内存 ring buffer。 |
| `ADMIN_AUDIT_EVENTS_POSTGRES_TABLE` | `rag_admin_audit_events` | Admin authorization audit append-only 事件表。 |
| `ADMIN_AUDIT_RETENTION_DAYS` | `90` | PostgreSQL admin audit retention；设为 `0` 可关闭自动裁剪。 |

Agent experience memory 只进入 planner hints，不进入 citations/evidence。写入策略集中在后端：成功 run 只有在完成、未等待审批/澄清、且有文档证据或 claim support 时才会写入规划经验；负反馈只把 `citation_error`、`hallucination`、`incomplete` 写成严格核验证据的提示；普通 helpful feedback 不写。每个 user/workspace 最多保留 40 条经验，旧记录会在新写入后裁剪。`/chat` 的 `agentObservability.experienceMemory.write` 和 `/feedback` 的 `agentExperienceMemory` 会报告 `status`、`writeAttempted`、`skippedReason`、`storedCount`、`prunedCount` 和已脱敏的 `storedRecords`。

## Vector store

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `VECTOR_STORE_PROVIDER` | `local` | `local` 或 `qdrant`。 |
| `QDRANT_URL` | `http://127.0.0.1:6333` | Qdrant 地址。 |
| `QDRANT_API_KEY` | 空 | Qdrant API key。 |
| `QDRANT_COLLECTION` | `rag_chunks` | Qdrant collection 名称。 |
| `QDRANT_DISTANCE` | `Cosine` | Qdrant 向量距离。 |

`local` provider 会把 dense vector index 写到 `server/data/rag/vector-index.json`，本地 sparse index 写到 `server/data/rag/sparse-index.json`。

## Retrieval 配置

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `RAG_CHUNK_STRATEGY` | `structured` | `structured` 或 `simple`。 |
| `RAG_CHUNK_SIZE` | `900` | Chunk 最大长度。 |
| `RAG_CHUNK_OVERLAP` | `180` | Chunk overlap。 |
| `RAG_RETRIEVAL_TOP_K` | `6` | QA 路径召回数量。 |
| `RAG_COMPARE_TOP_K_PER_DOC` | `3` | Compare 路径每份文档保留证据数。 |
| `RAG_QUERY_DECOMPOSITION_ENABLED` | `true` | 是否拆分复杂 evidence requirements。 |
| `RAG_QUERY_DECOMPOSITION_MAX_REQUIREMENTS` | `4` | 单次最多拆分需求数。 |
| `RAG_MIN_RELEVANCE_SCORE` | `0.32` | 置信度门控最低相关分。 |
| `RAG_MIN_QUERY_TERM_COVERAGE` | `0.51` | Query term coverage 门槛。 |
| `RAG_NEAR_DUPLICATE_GUARD_ENABLED` | `true` | 近重复且无冲突时避免编造差异。 |

## Hybrid 和 rerank

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `RAG_HYBRID_ENABLED` | `false` | 是否启用 dense + sparse fusion。 |
| `RAG_HYBRID_FUSION` | `weighted` | `weighted` 或 `rrf`。 |
| `RAG_HYBRID_DENSE_WEIGHT` | `0.65` | Weighted fusion 的 dense 权重。 |
| `RAG_HYBRID_SPARSE_WEIGHT` | `0.35` | Weighted fusion 的 sparse 权重。 |
| `RAG_RRF_K` | `60` | RRF 平滑常数。 |
| `RAG_RERANK_ENABLED` | `false` | 是否启用 rerank。 |
| `RAG_RERANK_PROVIDER` | `heuristic` | `heuristic`、`cross-encoder` 或代码内注入的 `custom`。 |
| `RAG_RERANK_CANDIDATE_MULTIPLIER` | `3` | Rerank 候选放大倍数。 |
| `RAG_RERANK_WEIGHT` | `0.6` | Rerank 分数与粗排分数混合权重。 |
| `RAG_CROSS_ENCODER_ENDPOINT` | 空 | Cross-encoder HTTP endpoint。 |
| `RAG_CROSS_ENCODER_MODEL` | 空 | 传给 cross-encoder endpoint 的可选模型名。 |

## Auth 和 access scope

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `API_AUTH_ENABLED` | `false` | 是否启用 API token 鉴权。 |
| `API_AUTH_TOKEN` | 空 | 单用户/本地开发 token。 |
| `API_AUTH_TOKENS` | 空 | 多用户 token 映射。 |
| `API_AUTH_REQUIRE_WORKSPACE` | `false` | 鉴权请求是否必须解析出 workspace scope；多租户部署建议设为 `true`。 |
| `API_AUTH_JWT_ENABLED` | `false` | 是否允许 `Authorization: Bearer <jwt>` 走 HS256 JWT 验证。静态 token 仍优先匹配。 |
| `API_AUTH_JWT_HS256_SECRET` / `API_AUTH_JWT_SECRET` | 空 | JWT HS256 secret；`API_AUTH_JWT_ENABLED=true` 时必须配置。 |
| `API_AUTH_JWT_ISSUER` | 空 | 可选 issuer 校验，对应 JWT `iss`。 |
| `API_AUTH_JWT_AUDIENCE` | 空 | 可选 audience 校验，对应 JWT `aud`。 |
| `API_AUTH_JWT_USER_CLAIM` | `sub` | 映射为 `accessScope.userId` 的 claim path。支持点号路径。 |
| `API_AUTH_JWT_WORKSPACE_CLAIM` | `workspace_id` | 映射为固定 `accessScope.workspaceId` 的 claim path。 |
| `API_AUTH_JWT_WORKSPACES_CLAIM` | `workspaces` | 映射为允许 workspace 列表的 claim path；请求 workspace 必须落在该列表内。 |
| `API_AUTH_JWT_ROLES_CLAIM` | `roles` | 映射为 admin role IDs 的 claim path。 |
| `API_AUTH_JWT_PERMISSIONS_CLAIM` | `permissions` | 映射为 admin permission IDs 的 claim path。 |
| `API_AUTH_REVOKED_TOKEN_HASHES` | 空 | 逗号分隔的 JWT SHA-256 token hash 撤销列表。 |
| `API_AUTH_REVOKED_JTIS` | 空 | 逗号分隔的 JWT `jti` 撤销列表。 |

多人部署可以继续使用 `API_AUTH_TOKENS`：

```env
API_AUTH_ENABLED=true
API_AUTH_REQUIRE_WORKSPACE=true
API_AUTH_TOKENS={"alice-token":{"userId":"alice","workspaceId":"workspace-a"},"ops-token":{"userId":"ops","allowedWorkspaceIds":["workspace-a","workspace-b"]}}
```

也可以接入外部身份服务签发的 HS256 JWT：

```env
API_AUTH_ENABLED=true
API_AUTH_REQUIRE_WORKSPACE=true
API_AUTH_JWT_ENABLED=true
API_AUTH_JWT_HS256_SECRET=replace-with-issuer-secret
API_AUTH_JWT_ISSUER=https://issuer.example
API_AUTH_JWT_AUDIENCE=archive-rag
```

启用带 `userId/workspaceId` 的 principal 后，文档列表、chat、删除和 PDF 文件流都会按访问范围过滤。`workspaceId` / `workspace_id` 表示固定 workspace；`allowedWorkspaceIds` 或 JWT `workspaces` 表示允许的 workspace 列表，请求里的 `x-workspace-id` / `workspaceId` 必须落在该列表内。旧的无 scope 文档不会出现在 scoped 用户视图中，需要重新上传或迁移 owner/workspace 元数据。

Admin 端点还会读取 token principal 或 JWT claims 上的 `roles` / `roleIds` 和 `permissions` / `permissionIds`。内置角色包括 `admin.viewer`、`admin.quality_operator`、`admin.recovery_operator`、`admin.operator`、`admin.owner`；也可以直接授予 `admin.status.read`、`admin.audit.read`、`admin.actions.recovery_scan`、`admin.actions.quality_refresh`、`admin.actions.recover_tasks` 等权限：

```env
API_AUTH_TOKENS={"admin-token":{"userId":"admin","workspaceId":"workspace-a","roles":["admin.operator"]}}
```

`GET /admin/audit` 默认只返回当前 token workspace 下的 compact authorization events；支持 `limit`、`offset`、`userId`、`workspaceId`、`actionId`、`permissionId`、`result=allowed|denied`、`from` 和 `to` 查询参数。事件只包含 compact principal、request 和 authorization decision，不保存 token、payload、prompt 或 raw trace。

## Observability

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `RAG_OBSERVABILITY_ENABLED` | `false` | 是否写入 RAG / AgentRAG JSONL trace。 |
| `RAG_OBSERVABILITY_INCLUDE_CONTEXT` | `false` | Trace 是否记录完整 chunk 文本。 |
| `FEEDBACK_DIRECTORY` | `server/data/feedback` | 答案反馈 JSONL 存储目录。 |

默认 trace 只保存 metadata、score、`excerptHash` 和短 preview。启用后，completion、embedding 和 cross-encoder rerank 还会写入 `llmops_metric` 事件，用于 `observability:report` 汇总 operation / model route 的 count、平均延迟和 error rate；这些事件不包含 prompt 原文或 secret。只有本地调试且能接受完整 chunk 文本落盘时，才建议设置：

```env
RAG_OBSERVABILITY_INCLUDE_CONTEXT=true
```

生成可读汇总报告：

```bash
cd server
npm run observability:report
```
