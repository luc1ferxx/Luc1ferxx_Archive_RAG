# Development Notes

这份文档放 API、目录结构和开发约束。README 只保留项目入口。

## API

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 返回 OpenAI、auth、vector store、PostgreSQL、long memory、task store、agent run store、workspace artifact store 等健康状态。 |
| `GET` | `/ready` | Readiness check，整体异常时返回 `503`。 |
| `GET` | `/documents` | 列出当前访问范围内的持久化文档；外部导入文档会在 `profile.source` / `source` 暴露 provenance。 |
| `GET` | `/tasks` | 列出当前访问范围内的 task log；可用 `type` 查询参数过滤，例如 `external_recommendation`。 |
| `GET` | `/tasks/:taskId` | 读取当前访问范围内的单个 task；响应不暴露 runner 内部 `payload`。 |
| `POST` | `/tasks/:taskId/actions/:action` | 对等待用户输入的 task 执行动作，例如 `confirm` 或 `cancel`；动作由 task 的 `runnerId` 分发给对应 runner。 |
| `POST` | `/agent-tasks` | 创建 durable AgentRAG goal task，后台通过现有 job orchestrator 运行，并在 blocked 时转成 `waiting_for_user` task；内部 task memory 只作为 planner context。 |
| `GET` | `/agent-triggers` | 列出公开 automation trigger contract；响应不暴露 question template、default input 或 raw payload。 |
| `POST` | `/agent-triggers/:triggerId/dispatch` | 通过 trigger dispatcher 创建 scoped durable AgentRAG goal task；请求应提供 `x-idempotency-key` 或 `request.id`，执行仍走现有 agent task runner。 |
| `GET` | `/agent-runs` | 列出当前访问范围内的 AgentRAG run snapshots；可用 `status` 查询参数过滤。 |
| `GET` | `/agent-runs/recovery` | 列出当前访问范围内等待人工恢复或失败重试的 agent runs，并返回可执行 recovery actions 以及从 replay safety matrix 派生的 step safety reasons。 |
| `GET` | `/agent-runs/:runId` | 读取单个 agent run 的 goal、plan、steps、observations、decisions、approval gates、result/error 和 event log。 |
| `POST` | `/agent-runs/:runId/actions/:action` | 对等待用户确认的 agent run 执行 `approve` / `deny`；approve 会恢复被暂停的 capability step，不重放整条 `/chat`。 |
| `POST` | `/agent-runs/:runId/recovery/actions/:action` | 执行 recovery 操作：`resume_from_step`、`retry_failed_step` 或 `cancel`；具体 step 安全性由 replay safety matrix 和 step executor 控制。 |
| `POST` | `/agent-runs/:runId/steps/:stepId/actions/retry` | 为单个已持久化 run step 排队 retry step，便于后续只重试失败步骤。 |
| `GET` | `/capabilities` | 列出已注册 capability contract，不暴露具体执行函数。 |
| `GET` | `/artifacts` | 列出当前访问范围内的生成结果；支持 `artifactType=report|summary|document_collection`、`status=active|archived`、`limit` 和 `offset` 过滤。 |
| `GET` | `/artifacts/:artifactId` | 读取 scoped artifact 的安全详情；不存在和跨 scope 访问统一返回 `404`。 |
| `GET` | `/artifacts/:artifactId/download` | 下载 report/summary 正文或 document collection JSON；返回 attachment `Content-Disposition`、正确 `Content-Type` 和 range headers。 |
| `POST` | `/artifacts/:artifactId/archive` | 将 artifact 幂等归档；重复归档返回同一个 archived 结果。 |
| `DELETE` | `/documents/:docId` | 删除单份文档及其向量索引。 |
| `POST` | `/documents/clear` | 清空工作区文档。 |
| `GET` | `/documents/:docId/file` | 以内联 PDF 方式流式返回文档，支持 range request。 |
| `GET` | `/documents/:docId/arxiv/suggestions` | 基于文档 profile 的本地 keyphrase 排名和 relevance check 返回相关 arXiv 候选和确认导入用的签名 token，并保存可稍后查看的 recommendation snapshot，同时记录 `external_recommendation` task。 |
| `GET` | `/documents/arxiv/suggestions` | 列出当前访问范围内保存的 arXiv recommendation snapshots。 |
| `GET` | `/documents/:docId/arxiv/suggestions/saved` | 读取单份文档当前保存的 arXiv recommendation snapshot；没有保存项时返回空候选和原因。 |
| `POST` | `/documents/:docId/arxiv/import` | 兼容旧同步确认导入；新前端流程优先通过 `/tasks/:taskId/actions/confirm` 触发异步 runner。两条路径都会复检所选候选相关性，并按 arXiv ID / PDF URL / title hash 跳过已索引论文。 |
| `POST` | `/upload/init` | 初始化分片上传会话。 |
| `GET` | `/upload/status` | 查询分片上传进度。 |
| `POST` | `/upload/chunk` | 上传单个文件分片。 |
| `POST` | `/upload/complete` | 合并分片、解析 PDF、写入索引。 |
| `POST` | `/upload` | 旧版直接上传接口，限制 50 MB。 |
| `GET` / `POST` | `/chat` | 对选中文档提问，返回 RAG answer、sources、web answer 和 AgentRAG observability。 |
| `POST` | `/chat/stream` | 与 `/chat` 同参数的 Server-Sent Events 版本：agent 每记录一步 trace 就推送一个 `trace_step` 事件（只含 id/type/label/status/summary，不含 detail），主文档答案生成时，每写完一句就用 finalizer 同一套 claim 校验检查已生成的部分，通过的句子以 `answer_draft` 事件推送（`{ draft: { index, text } }`），模型调用重试或切换备用模型时推送 `answer_draft_reset`，客户端应清空草稿；原始 token 不会发出。草稿是临时的：最终答案经 finalizer 校验后以 `result` 事件发送，内容与 `/chat` 的 status 和 body 完全一致，客户端用它替换草稿，随后是 `done`；失败时发送 `error`。客户端断开后 run 仍会完成。前端入口是 `src/archiveApi.js` 的 `streamChatAnswer`（聊天界面在用）和底层的 `streamChat`。 |
| `DELETE` | `/sessions/:sessionId` | 清理指定会话记忆。 |
| `GET` | `/memory` | 查询长期记忆。 |
| `POST` | `/memory` | 写入长期记忆。 |
| `DELETE` | `/memory/:memoryId` | 删除单条长期记忆。 |
| `DELETE` | `/memory` | 清空某用户长期记忆。 |
| `GET` | `/feedback` | 查询当前用户/工作区最近答案反馈。 |
| `POST` | `/feedback` | 保存当前回答的反馈类型、备注、答案摘要和引用摘要。 |
| `GET` | `/quality/latest` | 读取历史质量快照摘要；响应明确标记 `verification.scope=historical`，不能作为当前 commit 证据。 |
| `GET` | `/quality/history` | 查询历史 quality run，并返回非 current-commit 的 verification marker。 |
| `GET` | `/admin/status` | 读取 compact admin snapshot。 |
| `POST` | `/admin/actions/:action` | 执行受控 admin action：`recover-tasks`、`recovery-scan` 或刷新历史质量 metrics 的 `quality-refresh`。`quality-refresh` 需要 `admin.actions.quality_refresh` 权限，只接受注册的 `corpusId`，并以 single-flight、固定 deterministic provider 和有限超时运行。 |
| `GET` | `/admin/audit` | 读取 compact admin authorization audit events，支持 `limit`、`offset`、`userId`、`workspaceId`、`actionId`、`permissionId` 和 `result` 过滤；不包含 token、payload、prompt 或 raw trace。 |

只有 `/health` 和 `/ready` 是公开健康检查。文档列表、artifacts、上传、chat、memory、quality、feedback、admin status/actions/audit 和 `/documents/:docId/file` 在 `API_AUTH_ENABLED=true` 时都需要 `x-api-key` 或 `Authorization: Bearer <token>`；token 可以来自 `API_AUTH_TOKEN`、`API_AUTH_TOKENS` 或启用 `API_AUTH_JWT_ENABLED=true` 后的 HS256 JWT。admin status/actions/audit 还需要 principal 携带匹配的 `roles` 或 `permissions`。

分片上传会话按 `(userId, workspaceId, fileId)` 隔离；单个会话最多 100 MiB、100 个分片，单片最多 5 MiB，并严格校验声明的文件大小、分片几何和可选 SHA-256。完成阶段使用会话级原子 claim 和稳定的 session 文档 ID，避免并发完成或崩溃恢复重放生成重复文档；服务启动时会回收已退出进程或损坏的 claim，使中断的完成操作可以重试。物理临时文件只使用服务端 UUID 命名，客户端文件名仅作受限 display metadata。安全格式升级前创建的未分域 v1 会话不会自动认领或迁移，客户端需重新初始化上传。

Admin audit 默认 `ADMIN_AUDIT_STORE_PROVIDER=auto`：PostgreSQL 配好时写入 append-only `rag_admin_audit_events` 表并按 `ADMIN_AUDIT_RETENTION_DAYS` 裁剪，未配置 PostgreSQL 时回退到内存 ring buffer。

前端 Chat scope 控制通过不同 `docIds` 调用同一个 `/chat` endpoint；后端 RAG 仍只检索请求传入且通过 `accessScope` 校验的文档。

## 仓库结构

```text
.
├── src/                         # React frontend
│   ├── components/              # Uploader, chat, answer renderer, PDF preview
│   ├── App.js                   # Three-column archive workspace
│   └── config.js                # API domain and auth header helper
├── server/
│   ├── app.js                   # Express routes and upload/chat orchestration
│   ├── chat-mcp.js              # MCP web-answer client
│   ├── mcp-server.js            # SerpAPI-backed local MCP search server
│   ├── health.js                # Startup/readiness health checks
│   ├── db/migrations/           # PostgreSQL tables
│   ├── rag/                     # Custom RAG + AgentRAG pipeline
│   │   ├── agent*.js            # Planner, run context, run steps/handlers, self-check, finalizer, trace, working memory
│   │   ├── workspace-artifacts/ # Scoped artifact schema, service, stores and projections
│   │   ├── skills/              # Built-ins and whitelisted custom skills
│   │   ├── retrievers/          # Global and per-document retrievers
│   │   ├── chunker.js
│   │   ├── confidence.js
│   │   ├── evidence-aligner.js
│   │   ├── comparison-engine.js
│   │   ├── reranker.js
│   │   └── vector-store*.js
│   ├── evaluation/              # Synthetic, trajectory, feedback, rerank, ragas evaluation
│   └── test/                    # Backend tests
├── docs/
└── README.md
```

## 本地 PostgreSQL + pgvector

默认检索后端需要带 `vector` 扩展的 PostgreSQL 16。仓库根目录提供了 Compose：

```bash
docker compose up -d          # pgvector/pgvector:pg16，healthcheck + 持久化 volume pgdata
cd server && cp .env.example .env
npm run start                 # 启动时跑 migration，/health 的 vectorStore 会报告扩展、表、索引、列宽
```

`server/.env.example` 的 `POSTGRES_DATABASE_URL` 已指向这个实例。迁移文件 `server/db/migrations/012_create_rag_document_chunks.sql` 可重复执行：`CREATE EXTENSION IF NOT EXISTS vector`、`rag_document_chunks`（外键级联到 `rag_documents`、`(doc_id, chunk_index)` 唯一、access scope 索引、HNSW/IVFFlat cosine 索引、GIN tsvector 索引）。列宽在首次迁移时按 `RAG_EMBEDDING_DIMENSIONS`（或模型推导值）渲染；之后模型/维度变化，空表会自动改列宽，非空表会明确报错并要求 reindex。

从 local JSON 或 Qdrant 迁移：

```bash
cd server
npm run vector:reindex                       # dry-run：逐文档列出 copy / reembed / skip 计划
npm run vector:reindex -- --apply            # 复用已有向量（维度一致时）写入 pgvector，每份文档一个事务
npm run vector:reindex -- --from qdrant --apply
npm run vector:reindex -- --from documents --apply   # 换 embedding 模型后：用库里的 PDF 重新切块、重新 embedding
```

真实数据库集成测试只在 `PGVECTOR_TEST_DATABASE_URL` 存在时运行（会清空该库的文档，只指向一次性库）：

```bash
PGVECTOR_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/agentai npm run test:pgvector
```

没有该变量时 `npm test` 把它报告为 skipped，不会当作通过。行级安全的集成测试（`test/postgres-row-level-security.integration.test.mjs`）会自己建一个一次性数据库和两个临时角色，结束后删除，因此这个连接还需要 `CREATEROLE` 和 `CREATEDB` 权限。`scripts/run-pgvector-integration.sh` 创建的超级用户满足要求。

## Runtime paths

这些路径是运行时或生成内容，一般不手动编辑，也不提交：

```text
node_modules/
build/
server/node_modules/
server/data/
server/uploads/
server/upload-sessions/
server/evaluation/generated/
server/evaluation/results/<timestamped-files>
```

## 工程化基线

代码库经过四级系统性优化（安全 → 性能 → 架构 → 工程化），当前基线：

| 层级 | 落点 |
| --- | --- |
| 安全 | CORS 白名单（`ALLOWED_ORIGINS`）、helmet、分级限流（全局/chat/upload/destructive）、上传会话按 principal/workspace 分域、文件名 + `%PDF` 魔数双重校验、无静态 `/uploads` 暴露。 |
| 性能与可靠性 | 存储层异步原子写 + 写锁 + 增量 BM25 统计；embedding LRU 缓存；外部 fetch 全部带超时；上传 session TTL 清扫；store `list()` 分页；前端 `/chat` AbortController + 组件 memo 化。 |
| 架构 | `app.js` 组合根（171 行）+ `app-services.js` 服务装配 + `server/routes/` 特性 Router + zod 校验；`agent-self-check` 拆为 `self-check/` 8 个模块；`normalizeText` 收敛到 `server/lib/normalize-text.js`；langchain 替换为 `prompt-template.js` / `openai-client.js` / `pdf-loader.js` 三个自有模块，后端直接依赖 18 → 13。 |
| 工程化 | 前端 CRA → Vite 7 + Vitest 3（测试 97s → ~7s，构建 ~8s）；后端测试并行化（24s → ~4s，含 Windows 全平台通过）；CI 后端测试与 eval gate 拆并行 job；评测脚本共享 helper 收敛到 `eval-cli.js` / `eval-case-helpers.js`。 |

当前测试基线：后端 1801 个用例（1797 通过；3 个需要 PostgreSQL 的集成测试文件和 1 个需要 Redis 的集成测试文件在无数据库时各报告 1 个跳过；用 `FULL_SUITE=1 bash scripts/run-pgvector-integration.sh` 在一次性集群上跑，PostgreSQL 部分全部通过；Redis 部分需另设 `REDIS_TEST_URL`，5 个用例）、前端 113 个用例全绿、生产构建通过，覆盖率门禁通过（后端全局行覆盖约 91%）。

## Development rules

- RAG 变更优先放在 `server/rag/`，route/API 行为放在 `server/app.js`。
- Agent planner、run context、document loop、skill runners、observability、synthesis、finalization 已拆成独立模块；不要把这些细节重新堆回 `server/rag/agent.js`。
- 新增 custom skill 必须走白名单注册，并确认 `accessScope` 传递到文档读取和 RAG chat。
- `/chat` response shape 会被前端 trace UI、feedback metadata 和 evaluation 使用，改字段时需要同步测试。
- Working memory 是 run-scoped，不应写入长期记忆，除非用户明确要求。
- `VECTOR_STORE_PROVIDER=pgvector` 是默认值，`local` / `qdrant` 只作显式 opt-in；provider 白名单之外的值必须 fail closed，不要加任何静默回落。pgvector 的 ingest/delete/clear 走 `rag/index.js` 里同一个 PostgreSQL 事务（embedding 在事务外算好），改动时保持这个边界。
- 文档 RAG 默认两路召回 + RRF；rerank 放在 fusion 之后，不能用 rerank 或任何单路 combined scorer 冒充多路召回。sparse 路在 pgvector 上是 PostgreSQL FTS（`ts_rank_cd`），文档和代码里都不要写成 BM25。
- 评测报告的 `evidence` 必须通过 `server/evaluation/eval-evidence.js` 统一生成；不要手写 commit、dirty、corpus hash、config hash 或 source lineage，也不要回填旧 `latest.*`。
- 不要提交 `server/.env`、私有 PDF、`server/data/`、上传会话文件、生成语料或 timestamped eval 结果。

## Backend test entry

`server/test/run.test.mjs` 在运行时发现 `server/test/*.test.mjs` 并逐文件用 `node --test` 跑，包括 app、RAG、AgentRAG、feedback、quality report、observability report、CI workflow、param sweep、rerank、trajectory，以及 vector store provider / hybrid provenance / pgvector（无库单测 + 真实库集成）相关测试。`test/rag.test.mjs` 和 `test/app.test.mjs` 自己钉 `VECTOR_STORE_PROVIDER=local`，因为它们测的是本地索引路径；不要把这个钉子扩散到 runner 层。

常用入口：

```bash
cd server
npm test
npm run coverage:gate
npm run eval:trajectory
npm run eval:recovery-observability
npm run rollout:readiness
npm run quality:gate
npm run quality:current
```

`quality:gate` 保留旧报告的 metrics 兼容语义，只适合查看历史结果；它的 PASS 不是当前 commit 证据。PR workflow 会重新生成 `latest-quality`、feedback、trajectory、planner 和 recovery 报告，再运行 `quality:current` 校验 target SHA、`quality-current` profile、freshness、report-time/gate-time clean worktree、corpus/provider/config lineage、版本化 case/check/corpus/response contract，并从 raw retrieval 与 corpus page 独立重算 claims、citations、upload resume、recovery cases 和 metrics。完整发布批次仍必须在同一 target SHA 上重新生成 compare-hard、Hard-CS、arXiv、trajectory、planner-real、recovery observability、runtime smoke 和 rollout readiness 8 份报告，再运行 `npm run release:gate`。
