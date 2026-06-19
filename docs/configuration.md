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
| `AGENT_PLANNER_ROLLOUT` | `configured` | AgentRAG planner 灰度模式；`configured` 使用下面两个显式 planner 变量，`shadow` 执行 deterministic 主路径并把 LLM intent/execution proposal 记录到 `agentObservability.*Planner.shadow`，`guarded_llm` 让 LLM 作为主 planner 但继续由 validator/fallback 兜底，`llm`/`deterministic` 会同时覆盖 intent 和 execution planner。 |
| `AGENT_INTENT_PLANNER` | `deterministic` | AgentRAG intent 选择器；`deterministic` 使用规则候选首选项，`llm` 让 LLM 在白名单候选 intent 中选择并由 validator 兜底。 |
| `AGENT_EXECUTION_PLANNER` | `deterministic` | AgentRAG execution step 规划器；`deterministic` 使用固定 step schema，`llm` 让 LLM 在白名单 step 中排序并由 validator 兜底。 |
| `RAG_PROMPT_VERSION` | `v3` | Prompt 版本；`server/.env.example` 当前显式设置为 `v2`。 |
| `STARTUP_HEALTH_STRICT` | `false` | 健康检查失败时是否阻止启动。 |

arXiv topic 导入使用公开 Atom API，不需要额外 API key；后端需要能访问 `https://export.arxiv.org/api/query` 和对应 PDF URL。

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
| `AGENT_RUN_RECOVERY_MODE` | `manual` | Agent run 启动恢复模式；`manual` 只标记 recoverable run 等待人工处理，`auto` 仅自动恢复安全的 RAG-only pending/running/paused step，遇到审批或不安全 step 会回落人工，`off` 跳过启动恢复。 |
| `AGENT_RUNS_POSTGRES_TABLE` | `rag_agent_runs` | Agent run 当前快照表。 |
| `AGENT_RUN_EVENTS_POSTGRES_TABLE` | `rag_agent_run_events` | Agent run 审计事件表。 |

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

多人部署优先使用 `API_AUTH_TOKENS`：

```env
API_AUTH_ENABLED=true
API_AUTH_TOKENS={"alice-token":{"userId":"alice","workspaceId":"workspace-a"},"bob-token":{"userId":"bob","workspaceId":"workspace-b"}}
```

启用带 `userId/workspaceId` 的 token 后，文档列表、chat、删除和 PDF 文件流都会按访问范围过滤。旧的无 scope 文档不会出现在 scoped 用户视图中，需要重新上传或迁移 owner/workspace 元数据。

## Observability

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `RAG_OBSERVABILITY_ENABLED` | `false` | 是否写入 RAG / AgentRAG JSONL trace。 |
| `RAG_OBSERVABILITY_INCLUDE_CONTEXT` | `false` | Trace 是否记录完整 chunk 文本。 |
| `FEEDBACK_DIRECTORY` | `server/data/feedback` | 答案反馈 JSONL 存储目录。 |

默认 trace 只保存 metadata、score、`excerptHash` 和短 preview。只有本地调试且能接受完整 chunk 文本落盘时，才建议设置：

```env
RAG_OBSERVABILITY_INCLUDE_CONTEXT=true
```

生成可读汇总报告：

```bash
cd server
npm run observability:report
```
