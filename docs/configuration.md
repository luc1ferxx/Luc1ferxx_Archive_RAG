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

VECTOR_STORE_PROVIDER=pgvector
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
| `VITE_DOMAIN` | `http://localhost:5001` | 后端 API 地址。 |
| `VITE_API_AUTH_TOKEN` | 空 | 启用 API auth 时，前端通过 `x-api-key` 发送的 token。 |

## 后端基础配置

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 无 | 生成 embeddings 和回答所需。 |
| `SERPAPI_KEY` | 无 | Web answer 搜索所需；只跑文档 RAG 可先不配。 |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | 文档 chunk 与 query 的 embedding 模型。 |
| `OPENAI_CHAT_MODEL` | `gpt-5` | 文档答案、对比答案、网页摘要使用的模型。 |
| `RAG_INJECTION_SCREEN` | `on` | 检索切块、上传文件名和网页结果进入 prompt 前，是否筛掉对 AI 说话的句子（`on` / `off`，无法识别的值按 `on` 处理）。`off` 只作为生产环境出现误判时的紧急开关；答案 prompt 里的不可信证据规则和输出链接守卫不受影响。见 `docs/agent-rag.md` 的“Prompt 注入防护”。 |
| `RAG_CLAIM_JUDGE` | `off` | 词法 claim 校验拒绝的 claim 是否交给 LLM 评审复核（`llm` / `off`）。只作用于文档问答的自检和 finalizer；评审只能把"无支持"改成"有支持"，不能反过来，引用错误、证据里没有的数字、对比答案都不送评审，评审失败则保留词法结论。每个答案多一次模型调用，结论按 claim + 证据缓存。评审用的是同一个 chat 模型，还没有用人工标注的真实答案校准，见 [evaluation.md](evaluation.md)。 |
| `RAG_STRUCTURED_OUTPUT_ENABLED` | `true` | intent / execution / DAG planner 调用是否发送按请求生成的 JSON Schema `response_format`（strict）。schema 由运行时白名单生成：可选 step、候选 intent、Skill 的 typed 输入输出和已授权文档都写成枚举，自由文本和数组都有长度上限。它只收窄模型能输出什么，validator 仍是最终裁决。仅当 OpenAI 兼容端点拒绝 `response_format` 时设为 `false`，此时回到纯 prompt JSON 和容错解析。 |
| `OPENAI_CHAT_FALLBACK_MODEL` | 无 | 可选的备用 chat 模型。chat、intent planner、execution planner 路由上，主模型在重试用尽后仍返回可重试错误（429、5xx、超时）时切到它；400/401、策略或预算拦截不会切换。它经模型注册表登记，与主模型共用 workspace 策略标签，被策略禁用的主模型不会通过备用模型绕过。LLMOps 会分别记录主模型失败事件和备用模型成功事件，返回的 `modelRoute.modelId` 是实际作答的模型，`status` 为 `failover`。 |
| `RAG_LLM_REQUEST_TIMEOUT_MS` | `120000` | 单次模型请求（含读取响应体）的超时。超时按可重试错误处理。重试采用带抖动的指数退避（窗口 500/1000/2000ms），服务端 `retry-after-ms` / `Retry-After` 作为下限并再分散最多一半，超过 10 秒的等待直接放弃重试；空 completion 重试一次，因长度截断而为空的不重试。 |
| `RAG_LLM_MAX_CONCURRENCY` | `8` | 每个模型端点（base URL + 模型名）同时在途的请求上限，按进程计；`0` 不限。只在请求真正发出期间占用名额，重试的退避等待不占。它防的是自托管服务（Ollama、vLLM）排队过长：队列超过请求超时后，客户端超时重试、服务端还在处理已放弃的请求，负载越积越多。它不是按每分钟请求数或 token 数的限流。 |
| `RAG_LLM_CIRCUIT_FAILURE_THRESHOLD` | `5` | 同一端点和模型连续多少次"不可用"错误（5xx、408、超时、连接失败）后熔断；`0` 关闭。429、其他 4xx 和空响应不计入：429 说明服务在线，交给退避处理。熔断期间请求不发出、也不重试，直接以 `CIRCUIT_OPEN`（503）失败，chat 路由有备用模型时立即切换。 |
| `RAG_LLM_CIRCUIT_COOLDOWN_MS` | `30000` | 熔断持续时间。到期后放行一个探测请求：成功则恢复，失败则再熔断一个周期。熔断状态默认按进程保存；`RAG_SHARED_STATE=redis` 时由所有实例共享。 |
| `RAG_SHARED_STATE` | `memory` | 熔断器、模型并发上限和 claim 评审缓存的状态存在哪里。`memory` 按进程保存，适合单实例；`redis` 让所有指向同一 `REDIS_URL` 的实例共享：一个实例打开的熔断对所有实例生效，并发上限按整个部署计算，评审结论跨实例复用。Redis 不可达时每个实例退回进程内状态，不会让模型调用失败，健康检查的 `checks.sharedState` 会报 `error`。 |
| `REDIS_URL` | `redis://127.0.0.1:6379` | `RAG_SHARED_STATE=redis` 时使用的 Redis。本地可用 `docker compose --profile shared-state up -d` 启动。 |
| `RAG_SHARED_STATE_PREFIX` | `archive_rag:` | 共享状态的 key 前缀，让多个部署或测试共用一个 Redis 时互不干扰。 |
| `AGENT_RUN_MAX_TOKENS` | `100000` | 每次 Agent 运行的模型 token 上限（chat、embedding、rerank 合计，按 LLMOps metric 计）。用完后下一个工具被跳过并写 `budget_limit` trace，运行降级而不报错；`0` 关闭，空值保留默认。见 [agent-rag.md](agent-rag.md#运行预算次数之外的-token成本和时长)。 |
| `AGENT_RUN_MAX_COST_USD` | `0.5` | 每次运行的估算成本上限，只约束有定价的模型；无定价调用记入 `unpricedModelCalls`。 |
| `AGENT_RUN_MAX_DURATION_MS` | `300000` | 每次运行的总时长上限，在步骤边界检查：不再开始新工具，不中断进行中的调用。审批续跑从续跑时重新计时。 |
| `AGENT_PLANNER_ROLLOUT` | `llm` | AgentRAG planner 灰度模式；`configured` 使用下面两个显式 planner 变量，`shadow` 执行 deterministic 主路径并把 LLM intent/execution proposal 记录到 `agentObservability.*Planner.shadow`，`guarded_llm` 让 LLM 作为主 planner 但继续由 validator/fallback 兜底，`llm`/`deterministic` 会同时覆盖 intent 和 execution planner。 |
| `AGENT_INTENT_PLANNER` | `llm` | AgentRAG intent 选择器；`deterministic` 使用规则候选首选项，`llm` 让 LLM 在白名单候选 intent 中选择并由 validator 兜底。 |
| `AGENT_EXECUTION_PLANNER` | `llm` | AgentRAG execution step 规划器；`deterministic` 使用固定 step schema，`llm` 让 LLM 在白名单 step 中排序并由 validator 兜底。 |
| `AGENT_SKILL_GRAPH_ROLLOUT` | `guarded` | 仅控制 custom Skill 阶段用哪个执行器：`guarded` 由 V2 typed DAG 执行，`off` 回到 V1 chain（无法识别的取值也按 `off` 处理），`shadow` 仍由 V1 出答案、旁路规划/校验 DAG。DAG 由谁规划跟随 `AGENT_EXECUTION_PLANNER`，LLM 规划失败退回确定性图。V2 候选来自经 `accessScope` / `docIds` 核验、且有显式 typed contract 的已注册原子 Skill catalog，不由 V1 intent/组合 chain 独占；graph 只在执行任何 node 之前整体被拒时才能回落 V1。不会将 built-in/document/Web/capability 阶段纳入同一张 DAG。详见 [agent-rag.md](agent-rag.md#custom-skill-执行v1-chain-与-v2-typed-dag)。 |
| `AGENT_UNIFIED_GRAPH_ROLLOUT` | `off` | 异构 v3 全阶段图目前仅支持 `off` / `shadow`。`shadow` 在注入统一图 planner adapter 时旁路生成并校验候选图，只记录精简的 `unified_graph_planned` run event，真实答案仍走现有外层流程；没有 adapter 会记录 rejected。`guarded` 尚不可选，误设会回到 `off`，不能据此声称生产已执行统一 DAG。 |
| `RAG_PROMPT_VERSION` | `v3` | Prompt 版本；`server/.env.example` 当前显式设置为 `v2`。实际用到的模板以 `id@version#fingerprint` 记录在 LLMOps 事件、`agentObservability.promptTemplates` 和评测报告里（见 `docs/agent-rag.md` 的“Prompt 模板版本”）。 |
| `STARTUP_HEALTH_STRICT` | `false` | 健康检查失败时是否阻止启动。 |

arXiv topic 导入使用公开 Atom API，不需要额外 API key；后端需要能访问 `https://export.arxiv.org/api/query` 和对应 PDF URL。

## Evaluation evidence 配置

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `EVAL_TARGET_COMMIT_SHA` | 当前 `HEAD` | CI 可显式绑定评测 target SHA；若设置值与 checkout 的 `HEAD` 不一致，runner 会失败而不是生成错误 lineage。 |
| `EVAL_EVIDENCE_PROFILE` | 各 runner 的默认 profile | 写入公开 `evidence.profile`；完整发布 workflow 固定为 `release`。 |

`eval:robust-suite` 会在同一次运行内自行传递 suite ID、run ID 和 config hash，不需要手工设置 suite 环境变量。严格发布 freshness 默认是 `24` 小时，可用 `npm run release:gate -- --max-age-hours <hours>` 临时覆盖；target commit 也可通过 `--target-commit <sha>` 显式指定。完整 CLI 和 lineage 合同见 [evaluation.md](evaluation.md#release-evidence-gate)。

把 Skill graph 设为 `guarded` 只改变运行路径，不等于通过上线门禁。`rollout:readiness` 会同时要求运行环境为 `guarded`、真实模型的 `planner_dynamic_skill_graph` case 通过，以及两次真实 HTTP `/chat` 的 guarded DAG smoke 通过；`release:gate` 还校验同一目标提交的报告 lineage。默认值不会由评测命令自动改成 `guarded`。

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
| `POSTGRES_ROW_LEVEL_SECURITY` | `enforce` | 行级安全。`enforce` 让带访问范围的请求和后台任务在租户角色下执行，数据库拒绝其他租户的行；`off` 保持 owner 连接（策略仍在，但 owner 绕过）。无法识别的值按 `enforce` 处理。 |
| `POSTGRES_TENANT_ROLE` | `archive_rag_tenant` | 行级安全使用的租户角色名（小写标识符）。迁移会创建它，并把它授予应用登录角色。 |
| `DOCUMENTS_POSTGRES_TABLE` | `rag_documents` | 文档表。 |
| `SESSION_MEMORY_POSTGRES_TABLE` | `rag_session_memory` | 会话记忆表。 |
| `LONG_MEMORY_POSTGRES_TABLE` | `long_memory_items` | 长期记忆表。 |
| `RAG_LONG_MEMORY_ENABLED` | PostgreSQL configured -> `true`，否则 `false` | 是否启用长期记忆；显式设为 `false` 会覆盖 PostgreSQL 默认开启。 |
| `RAG_AGENT_EXPERIENCE_MEMORY_ENABLED` | long memory enabled -> `true`，否则 `false` | 是否启用 Agent experience memory；只作为规划提示，不作为文档证据，依赖 long memory。 |
| `TASK_STORE_PROVIDER` | `auto` | task/job 存储；`auto` 在 PostgreSQL 配好时使用 `postgres`，否则使用 `memory`。 |
| `TASKS_POSTGRES_TABLE` | `rag_tasks` | task/job 当前快照表。 |
| `TASK_EVENTS_POSTGRES_TABLE` | `rag_task_events` | task/job 审计事件表。 |
| `AGENT_RUN_STORE_PROVIDER` | `auto` | Agent run 存储；`auto` 在 PostgreSQL 配好时使用 `postgres`，否则使用 `memory`。 |
| `AGENT_RUN_RECOVERY_MODE` | PostgreSQL-backed run store 时为 `auto`，否则 `manual` | Agent run 启动恢复模式；PostgreSQL-backed run store 默认尝试恢复 replay matrix 允许的安全 step，非持久化 run store 默认 `manual`。`document_rag`、`follow_up_retrieval`、`research_question` 调用真实 `ragService.chat` 时可能写入会话和长期记忆，包括旧记录未持久化 replay metadata 的情况，都不自动重放；显式 `manual` 只标记 recoverable run 等待人工处理，`auto` 遇到审批或不安全 step 会回落人工，`off` 跳过启动恢复。失败步骤仍可显式 `retry_failed_step`，但可能重复这些写入，不保证 exactly-once。 |
| `AGENT_RUNS_POSTGRES_TABLE` | `rag_agent_runs` | Agent run 当前快照表。 |
| `AGENT_RUN_EVENTS_POSTGRES_TABLE` | `rag_agent_run_events` | Agent run 审计事件表。 |
| `WORKSPACE_ARTIFACT_STORE_PROVIDER` | `auto` | Workspace artifact 存储；`auto` 在 PostgreSQL 配好时使用 `postgres`，否则回退到 `memory`。 |
| `WORKSPACE_ARTIFACTS_POSTGRES_TABLE` | `rag_workspace_artifacts` | 生成报告、摘要和文档集合 artifact 的持久化表。 |
| `ADMIN_AUDIT_STORE_PROVIDER` | `auto` | Admin audit 存储；`auto` 在 PostgreSQL 配好时使用 append-only PostgreSQL event store，否则使用内存 ring buffer。 |
| `ADMIN_AUDIT_EVENTS_POSTGRES_TABLE` | `rag_admin_audit_events` | Admin authorization audit append-only 事件表。 |
| `ADMIN_AUDIT_RETENTION_DAYS` | `90` | PostgreSQL admin audit retention；设为 `0` 可关闭自动裁剪。 |

Agent experience memory 只进入 planner hints，不进入 citations/evidence。写入策略集中在后端：成功 run 只有在完成、未等待审批/澄清、且有文档证据或 claim support 时才会写入规划经验；负反馈只把 `citation_error`、`hallucination`、`incomplete` 写成严格核验证据的提示；普通 helpful feedback 不写。每个 user/workspace 最多保留 40 条经验，旧记录会在新写入后裁剪。`/chat` 的 `agentObservability.experienceMemory.write` 和 `/feedback` 的 `agentExperienceMemory` 会报告 `status`、`writeAttempted`、`skippedReason`、`storedCount`、`prunedCount` 和已脱敏的 `storedRecords`。

### 数据库行级安全

各个 store 在应用层按 user/workspace 过滤。迁移 `013_enable_tenant_row_level_security.sql` 让 PostgreSQL 也执行同样的规则，这样即使某条查询漏写了过滤条件，也读不到、写不进其他租户的行。

- **覆盖的表**（9 张）：文档、切块、任务、任务事件、Agent run、run 事件、审批快照、workspace artifacts、长期记忆。文档和切块沿用 `documentMatchesAccessScope` 的规则（owner 和 workspace 都为空的行对任何租户不可见）；其余表按 `(user, workspace)` 精确匹配；长期记忆只按用户匹配。
- **不覆盖**：会话记忆（只有 session id，没有 owner 列）；admin audit（workspace 管理员需要跨用户读取，由 admin 权限检查控制）。
- **生效方式**：鉴权之后的中间件把请求的访问范围放进 `AsyncLocalStorage`。`rag/postgres.js` 看到租户时，把这条语句放进一个短事务：`SET LOCAL ROLE` 切到租户角色，并设置 `archive_rag.user_id` / `archive_rag.workspace_id`，事务结束后自动恢复，不会残留在连接池里。
- **后台任务**：任务执行和启动时的 Agent run 恢复，都以该记录自己的范围作为租户。
- **以 owner 身份执行的工作**（`runAsDatabaseSystem`）：迁移、进程级缓存加载（文档 registry）、pgvector 表结构检查和状态统计、跨租户的恢复扫描。
- **不带范围的请求**：鉴权关闭且没有 `x-user-id` / `x-workspace-id` 的请求没有租户，仍以 owner 身份执行，与之前一样。
- **权限要求**：应用登录角色需要 `CREATEROLE`（或由 DBA 预先创建租户角色并授予它）。表的 owner 不受策略约束（`ENABLE`，而不是 `FORCE ROW LEVEL SECURITY`）。
- **新表**：新增的应用表必须在迁移里 `GRANT` 给租户角色；需要隔离的表还要加 `tenant_isolation` 策略。否则租户请求访问它会报权限错误，即失败时拒绝访问。
- **健康检查**：`checks.rowLevelSecurity` 以一个探测租户真实执行一次，确认能切到租户角色、9 张表都带策略；任一条件不满足即报 `error`。

已知边界：

- 租户靠异步上下文传递。如果某个中间件从流回调里继续请求链（例如 multer 的内存存储），上下文会丢失，查询回落到 owner 身份，也就是只剩应用层过滤；上传路由在 multer 之后重新绑定了租户。要做到上下文丢失时也拒绝访问，需要一个没有表权限的独立登录角色，owner 连接只留给显式的系统操作。
- 这层防护针对“漏写过滤条件”这类应用 bug，不防 SQL 注入：注入的语句可以执行 `RESET ROLE`。
- 开启后每条带范围的语句要 4 次往返（BEGIN、租户设置、语句本身、COMMIT），原来是 1 次。

Workspace artifacts 是 agent 生成结果的独立存储层，不进入文档 registry、向量索引或 RAG evidence。PostgreSQL migration `009_create_workspace_artifacts.sql` 为 `userId/workspaceId/idempotencyKey` 建立唯一约束；memory provider 只适合本地开发，进程重启后数据会丢失。单个 artifact 限制为：正文 512 KiB、结构化 payload 256 KiB、100 条 citation manifest、500 个 docIds；列表接口默认返回 50 条，最大 100 条。

## Vector store

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `VECTOR_STORE_PROVIDER` | `pgvector` | 严格白名单：`pgvector`（默认，chunk 与向量存在 PostgreSQL）、`local`（本地 JSON 索引，显式 opt-in）、`qdrant`（显式 opt-in）。其他值在启动健康检查、ingest 和检索时都直接报错，不会静默回落到 `local`。 |
| `DOCUMENT_CHUNKS_POSTGRES_TABLE` | `rag_document_chunks` | pgvector chunk/向量表；外键级联到 `DOCUMENTS_POSTGRES_TABLE`。 |
| `RAG_EMBEDDING_DIMENSIONS` | 由模型推导 | pgvector 列宽。留空时按 `OPENAI_EMBEDDING_MODEL` 推导（`text-embedding-3-small`=1536、`-large`=3072、`ada-002`=1536，未知模型 1536）。列宽或模型与库中已有 chunk 不一致时 ingest/检索明确失败并要求 `npm run vector:reindex`。 |
| `RAG_PGVECTOR_TEXT_SEARCH_CONFIG` | `simple` | 稀疏路（PostgreSQL FTS）使用的 text search configuration。chunk 文本先用应用内 tokenizer 切分（CJK 逐字、ASCII 小写去停用词）再建 tsvector，因此默认 `simple`。排序用 `ts_rank_cd`，不是 BM25。 |
| `RAG_PGVECTOR_INDEX_TYPE` | `hnsw` | `hnsw` 或 `ivfflat`，都用 cosine 距离。 |
| `RAG_PGVECTOR_HNSW_M` / `RAG_PGVECTOR_HNSW_EF_CONSTRUCTION` | `16` / `64` | HNSW 建索引参数。 |
| `RAG_PGVECTOR_IVFFLAT_LISTS` | `100` | IVFFlat `lists`。 |
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
| `RAG_HYBRID_ENABLED` | `true` | 文档 RAG 默认真正跑两路召回：dense（pgvector cosine / local / qdrant）与 sparse（PostgreSQL FTS / local BM25 / qdrant sparse）各自独立检索后融合。设为 `false` 只跑 dense 一路，这是 opt-out。 |
| `RAG_HYBRID_FUSION` | `rrf` | `rrf`（默认，RRF 分数按 `(k+1)` 归一到 0–1 以匹配 `RAG_MIN_RELEVANCE_SCORE`）或 `weighted`。rerank 始终在 fusion 之后。 |
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

启用带 `userId/workspaceId` 的 principal 后，文档列表、chat、删除和 PDF 文件流都会按访问范围过滤。使用 PostgreSQL 时，数据库行级安全会再检查一遍（见下文“数据库行级安全”）。`workspaceId` / `workspace_id` 表示固定 workspace；`allowedWorkspaceIds` 或 JWT `workspaces` 表示允许的 workspace 列表，请求里的 `x-workspace-id` / `workspaceId` 必须落在该列表内。旧的无 scope 文档不会出现在 scoped 用户视图中，需要重新上传或迁移 owner/workspace 元数据。

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
| `RAG_OBSERVABILITY_EVENTS_PATH` | 空 | 把 trace 写到指定的 JSONL 文件，而不是默认的 `server/data/rag-observability/events.jsonl`；评测用它把一次运行的事件单独保存。 |
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

### OpenTelemetry trace

JSONL trace 适合离线汇总；要在界面里看"一次请求里每一步花了多久"，打开 OpenTelemetry：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `OTEL_TRACING_ENABLED` | `false` | 为 `true` 时 `server.js` 启动 OpenTelemetry SDK（`server/otel.js`）并按 OTLP/HTTP 导出。关闭时代码里的 span 调用是空操作，`/chat` 响应不变。 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `http://localhost:4318` | 标准 OTLP 变量，由导出器自己读取。前者是基地址（自动追加 `/v1/traces`），后者是完整地址。 |
| `OTEL_EXPORTER_OTLP_HEADERS` | 无 | 标准 OTLP 变量，例如认证头。 |
| `OTEL_EXPORTER_OTLP_PROTOCOL` / `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | `http/protobuf` | `http/protobuf` 或 `http/json`。Phoenix 的 `/v1/traces` 只接受 protobuf，对 JSON 返回 415；gRPC 未接入，会回落到 `http/protobuf` 并打印警告。 |
| `OTEL_SERVICE_NAME` | `luc1ferxx-archive-rag` | trace 后端里显示的服务名。 |

一次 `/chat` 是一条 trace：根 span `invoke_agent archive_rag`，下面是 `agent.plan intent` / `agent.plan execution` / `agent.plan skill_graph` 三个规划 span、每个 Skill 一个 `execute_tool <skillId>` span，Skill 发出的每次模型调用是它下面的 `chat <model>` 或 `embeddings <model>` span（CLIENT，带 `gen_ai.usage.input_tokens` / `output_tokens`、LLMOps 估算成本和重试事件）。Agent 步骤是 `agent.step` 事件，只有类型、标签和状态。属性遵循 OpenTelemetry GenAI 语义约定，**不记录问题、prompt、模型输出或文档内容**。开启后 `agentObservability.traceId` 给出这次请求的 trace id，根 span 上有 `agent.run.id`，可以从运行记录找到 trace，也可以反过来。

接 Phoenix（本地，镜像需自行拉取）：

```bash
docker run -p 6006:6006 arizephoenix/phoenix
```

```env
OTEL_TRACING_ENABLED=true
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:6006/v1/traces
```

接 Langfuse（云或自托管；接受 protobuf 和 JSON，不支持 gRPC；认证是 `public key:secret key` 的 base64）：

```env
OTEL_TRACING_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.langfuse.com/api/public/otel
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(pk-lf-...:sk-lf-...)>
```

不接后端也能看：`cd server && npm run trace:demo` 在内存里跑一次合同审查请求并把 span 树打印出来；加 `-- --real` 用配置好的模型端点（例如本地 Ollama），加 `-- --otlp` 同时导出到上面配置的后端。
