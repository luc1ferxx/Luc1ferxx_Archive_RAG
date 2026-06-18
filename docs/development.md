# Development Notes

这份文档放 API、目录结构和开发约束。README 只保留项目入口。

## API

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 返回 OpenAI、auth、vector store、PostgreSQL、long memory、task store、agent run store 等健康状态。 |
| `GET` | `/ready` | Readiness check，整体异常时返回 `503`。 |
| `GET` | `/documents` | 列出当前访问范围内的持久化文档；外部导入文档会在 `profile.source` / `source` 暴露 provenance。 |
| `GET` | `/tasks` | 列出当前访问范围内的 task log；可用 `type` 查询参数过滤，例如 `external_recommendation`。 |
| `GET` | `/tasks/:taskId` | 读取当前访问范围内的单个 task；响应不暴露 runner 内部 `payload`。 |
| `POST` | `/tasks/:taskId/actions/:action` | 对等待用户输入的 task 执行动作，例如 `confirm` 或 `cancel`；动作由 task 的 `runnerId` 分发给对应 runner。 |
| `GET` | `/agent-runs` | 列出当前访问范围内的 AgentRAG run snapshots；可用 `status` 查询参数过滤。 |
| `GET` | `/agent-runs/recovery` | 列出当前访问范围内等待人工恢复或失败重试的 agent runs，并返回可执行 recovery actions。 |
| `GET` | `/agent-runs/:runId` | 读取单个 agent run 的 goal、plan、steps、observations、decisions、approval gates、result/error 和 event log。 |
| `POST` | `/agent-runs/:runId/actions/:action` | 对等待用户确认的 agent run 执行 `approve` / `deny`；approve 会恢复被暂停的 capability step，不重放整条 `/chat`。 |
| `POST` | `/agent-runs/:runId/recovery/actions/:action` | 执行 recovery 操作：`resume_from_step`、`retry_failed_step` 或 `cancel`；具体 step 安全性由 replay safety matrix 和 step executor 控制。 |
| `POST` | `/agent-runs/:runId/steps/:stepId/actions/retry` | 为单个已持久化 run step 排队 retry step，便于后续只重试失败步骤。 |
| `GET` | `/capabilities` | 列出已注册 capability contract，不暴露具体执行函数。 |
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
| `DELETE` | `/sessions/:sessionId` | 清理指定会话记忆。 |
| `GET` | `/memory` | 查询长期记忆。 |
| `POST` | `/memory` | 写入长期记忆。 |
| `DELETE` | `/memory/:memoryId` | 删除单条长期记忆。 |
| `DELETE` | `/memory` | 清空某用户长期记忆。 |
| `GET` | `/feedback` | 查询当前用户/工作区最近答案反馈。 |
| `POST` | `/feedback` | 保存当前回答的反馈类型、备注、答案摘要和引用摘要。 |
| `GET` | `/quality/latest` | 读取最新质量报告摘要。 |
| `POST` | `/quality/synthetic` | 触发 synthetic quality run。 |
| `GET` | `/quality/history` | 查询历史 quality run。 |

只有 `/health` 和 `/ready` 是公开健康检查。文档列表、上传、chat、memory、quality、feedback 和 `/documents/:docId/file` 在 `API_AUTH_ENABLED=true` 时都需要 `x-api-key` 或 `Authorization: Bearer <token>`。

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

## Development rules

- RAG 变更优先放在 `server/rag/`，route/API 行为放在 `server/app.js`。
- Agent planner、run context、document loop、skill runners、observability、synthesis、finalization 已拆成独立模块；不要把这些细节重新堆回 `server/rag/agent.js`。
- 新增 custom skill 必须走白名单注册，并确认 `accessScope` 传递到文档读取和 RAG chat。
- `/chat` response shape 会被前端 trace UI、feedback metadata 和 evaluation 使用，改字段时需要同步测试。
- Working memory 是 run-scoped，不应写入长期记忆，除非用户明确要求。
- `VECTOR_STORE_PROVIDER=local` 适合小规模本地工作区；大规模语料建议切到 Qdrant。
- 不要提交 `server/.env`、私有 PDF、`server/data/`、上传会话文件、生成语料或 timestamped eval 结果。

## Backend test entry

`server/test/run.test.mjs` 聚合后端测试，包括 app、RAG、AgentRAG、feedback、quality report、observability report、CI workflow、param sweep、rerank 和 trajectory 相关测试。

常用入口：

```bash
cd server
npm test
npm run coverage:gate
npm run eval:trajectory
npm run eval:recovery-observability
npm run rollout:readiness
npm run quality:gate
```
