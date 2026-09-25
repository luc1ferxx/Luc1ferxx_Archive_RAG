<div align="center">

# Luc1ferxx Archive RAG

**可信文档智能体工作台：上传 PDF，围绕证据提问、对比、审查，并保留完整执行轨迹。**

它不是一个简单的“PDF 聊天框”。核心目标是让每个重要回答都能回到页级引用、检索记录、claim self-check、gap analysis 和质量门控，方便排查、复现和持续迭代。

<p>
  <img alt="React 18" src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=111111" />
  <img alt="Vite" src="https://img.shields.io/badge/Vite-7-646CFF?logo=vite&logoColor=ffffff" />
  <img alt="Vitest" src="https://img.shields.io/badge/Vitest-3-6E9F18?logo=vitest&logoColor=ffffff" />
  <img alt="Node.js ESM" src="https://img.shields.io/badge/Node.js-ESM-339933?logo=node.js&logoColor=ffffff" />
  <img alt="Express API" src="https://img.shields.io/badge/Express-API-000000?logo=express&logoColor=ffffff" />
  <img alt="OpenAI" src="https://img.shields.io/badge/OpenAI-GPT--5-412991?logo=openai&logoColor=ffffff" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-docs%20%7C%20runs%20%7C%20tasks-4169E1?logo=postgresql&logoColor=ffffff" />
  <img alt="Vector Store" src="https://img.shields.io/badge/Vector-pgvector%20%7C%20local%20%7C%20Qdrant-FF4F00" />
</p>

[快速启动](#快速启动) · [架构](#系统架构) · [能力](#核心能力) · [命令](#常用命令) · [文档](#文档入口)

</div>

## 项目定位

Luc1ferxx Archive RAG 是一个本地优先的多 PDF 档案分析系统。它适合处理合同、政策、研究论文、知识库导出、归档资料这类需要“可追溯回答”的文档集合。

用户在前端工作台上传文档后，可以：

- 在选中文档、已上传文档或整个工作区范围内提问。
- 获得带页码、excerpt 和来源文件的回答。
- 对多份文档做结构化比较，避免单个高相关文档垄断检索结果。
- 让 AgentRAG 自动选择白名单 skill、补充检索、请求澄清或降级回答。
- 查看 planner、skill chain、检索 query、unsupported claims、resolved gaps 和 finalizer 删除记录。
- 通过反馈、synthetic eval、trajectory eval、planner gate、recovery gate 和 quality gate 持续防回退。

## 核心能力

| 方向 | 当前能力 |
| --- | --- |
| 文档工作台 | React 三栏式工作台，包含上传、文档列表、PDF 预览、聊天、sources、trace、Agent Run Center、quality 面板，以及与源文档分离的 Drive 生成结果列表。 |
| PDF ingestion | 支持直接上传和分片上传；文件名与 `%PDF` 魔数双重校验；解析页文本，生成 document profile，在同一个 PostgreSQL 事务里写入文档表和 pgvector chunk/向量表（embedding 在事务外计算）。 |
| 文档 RAG | Structured chunking、query decomposition，默认两路独立召回——pgvector cosine dense 检索 + PostgreSQL FTS lexical 检索——用 RRF 融合（weighted 可选），可选 rerank 位于 fusion 之后，confidence gate 和页级 citation。每个候选带 route/rank/score/query provenance。查询 embedding 走 LRU 缓存。 |
| 多文档对比 | Compare 请求走 per-document retrieval，每份文档独立召回和 rerank，再做 evidence alignment、近重复保护和结构化差异输出。 |
| AgentRAG | LLM/deterministic planner 可配置，执行前校验 access scope；支持 clarification gate、approval gate、白名单 skill chain、self-check、gap analysis、follow-up retrieval、finalizer、research_task/dossier 流程、agent task 产物交付，以及显式注入的 connector/MCP adapter、sandbox/secret boundary、runtime model/provider registry 和 LLMOps policy/admin health surface。 |
| Skills 和 capabilities | 内置 `document_rag`、`web_search`、`arxiv_import`、`inventory`、`document_discovery`、`research_brief`；custom skills 只从白名单加载。Capability registry 暴露 `report.export` 和 action capabilities 的统一 contract，不让模型调用任意工具。 |
| arXiv enrichment | 基于已上传文档 profile 生成清理后的 arXiv topic，返回可签名确认的候选论文；用户选择后通过异步 task runner 导入，并按 arXiv ID / PDF URL / title hash 去重。 |
| 执行持久化 | PostgreSQL-backed task store、agent run store 和 workspace artifact store 保存 task/run snapshot、公开 goal plan、真实 goal deliverables、steps、events、approval gates 和 recovery 状态；本地开发可回落内存实现。 |
| 记忆 | Session memory 用于追问改写；long memory 和 agent experience memory 在 PostgreSQL 配置后默认启用。Experience memory 只进入 planner hints，不作为 citation 或答案证据。 |
| 可观测性 | `/chat` 返回 `agentTrace`、`agentObservability`、`agentWorkingMemory`；可选写 JSONL trace，前端可展示 planner、skills、queries、gaps 和 removed claims。可选 OpenTelemetry trace（GenAI 语义约定，OTLP 导出到 Phoenix / Langfuse），一次运行里每个规划器、Skill 和模型调用各是一个 span，带 token 和耗时；`npm run trace:demo` 可直接打印。 |
| 质量体系 | 覆盖 synthetic、real、feedback、trajectory、planner、recovery observability、rerank、param sweep、coverage gate、Ragas 辅助评测和 GitHub Actions quality gate。 |
| 访问隔离 | `API_AUTH_ENABLED` 配合 `API_AUTH_TOKEN`、`API_AUTH_TOKENS` 或 HS256 JWT 后，文档、artifacts、上传、chat、删除、文件、memory、feedback、quality 等接口按 `userId/workspaceId` scope 过滤；Admin status/actions/audit 额外按 roles/permissions 授权，audit 在 PostgreSQL 配好时写入 append-only event store。CORS 白名单、helmet 和分级限流默认开启。 |

## 系统架构

```mermaid
flowchart TB
  subgraph Frontend["React 18 / Vite"]
    Workspace["Archive workspace"]
    Upload["PDF uploader"]
    Chat["Chat composer"]
    TraceUI["Trace / Sources / Tasks / Quality / Artifacts panels"]
  end

  subgraph API["Node ESM Express API"]
    Composition["app.js composition root + app-services.js"]
    Auth["auth + accessScope + rate limits"]
    Routers["server/routes/ feature routers (zod validated)"]
  end

  subgraph RAG["server/rag"]
    Ingest["pdf-loader + chunker + profiler"]
    Planner["Agent planner"]
    Skills["Skill registry + capability registry"]
    Retrieval["retrievers + vector store + reranker"]
    Loop["document loop + self-check + gap analysis"]
    Finalizer["answer synthesis + finalizer"]
    Runs["task / agent run / artifact stores + recovery"]
  end

  subgraph Storage["Storage"]
    Postgres["PostgreSQL documents, memories, tasks, runs, artifacts"]
    Vector["pgvector chunks + FTS (default) | local JSON | Qdrant"]
    UploadSessions["upload sessions"]
    TraceFiles["optional JSONL traces"]
  end

  Workspace --> Upload
  Workspace --> Chat
  Workspace --> TraceUI
  Upload --> Routers
  Chat --> Routers
  TraceUI --> Routers
  Composition --> Auth
  Auth --> Routers
  Routers --> Ingest
  Routers --> Planner
  Planner --> Skills
  Skills --> Retrieval
  Retrieval --> Loop
  Loop --> Finalizer
  Finalizer --> Routers
  Routers --> Runs
  Ingest --> Postgres
  Ingest --> Vector
  Retrieval --> Vector
  Runs --> Postgres
  Loop --> TraceFiles
```

后端分层遵循“组合根 + 特性 Router + 领域模块”的结构：

- `server/app.js` 是 171 行的组合根：解析配置，交给 `app-services.js` 装配全部服务，按序执行启动恢复（storage → registries → memories → tasks → runs → recovery → health），然后先挂载 `/health`、`/ready`，再套限流和鉴权，最后挂载 `server/routes/` 下的特性 Router（documents、uploads、chat、tasks、arxiv、memory、quality、artifacts、admin）。
- 路由入参统一经 `routes/validation.js` 的 zod schema 校验；错误消息和状态码保持稳定 contract。
- LLM 接入不依赖任何框架：`server/lib/prompt-template.js`（f-string 模板渲染）、`server/rag/openai-client.js`（OpenAI 兼容 fetch client，支持 `OPENAI_BASE_URL` 代理端点、错误 status 传播和真实 token usage 上报）、`server/rag/pdf-loader.js`（页级 PDF 提取，ingestion 和评测共用同一条管线）。后端直接依赖仅 13 个。
- Claim self-check 拆分在 `server/rag/self-check/`（patterns、text、modality、attribution、claims、support、evaluate、gaps），`agent-self-check.js` 作为稳定的对外出口。
- 文本归一化收敛在 `server/lib/normalize-text.js` 三个变体（collapse / trim / clamp），全仓复用。

## AgentRAG 闭环

```mermaid
flowchart LR
  Q["User question"] --> P["Intent + execution planner"]
  P --> C{"Needs clarification or approval?"}
  C -->|yes| G["Clarification / approval gate"]
  C -->|no| S["Whitelisted skill or skill chain"]
  S --> R["Scoped retrieval"]
  R --> A["Grounded draft with citations"]
  A --> V["Claim support self-check"]
  V -->|supported| F["Finalizer"]
  V -->|gap found| GP["Gap analysis"]
  GP --> B{"Budget left?"}
  B -->|yes| FR["Focused follow-up retrieval"]
  FR --> V
  B -->|no| L["Evidence-limited answer"]
  F --> O["Trace + feedback metadata + quality gates"]
  L --> O
  G --> O
```

关键规则：

- Planner 只在已注册 intent、skill、capability 和 step schema 里选择。
- 在 custom skill 的 V2 DAG 模式下，模型看到的是 runtime 从已注册、显式 typed contract、已核验 `accessScope` / `docIds` 构造的原子 Skill catalog，不受 V1 复合 intent/chain 限死。例如上游只选了 `compare_documents` intent，DAG planner 仍可在授权候选中规划 `compare_documents -> risk_review`；没有选中文档或文档无法按 scope 核验时不会扩大候选范围。V1 与默认 `off` 行为不变。
- Planner 不决定权限、`docIds`、审批、secret、预算、并发和重试上限；这些由 runtime 拥有。custom skill 的 typed DAG 也一样：模型只产出节点和依赖，validator 整体接受或整体拒绝，非法图不会部分执行；runner 在执行前、把真实或恢复的输出交给下游前再次校验 typed contract。当前 typed 输出仍是 `text` / `citations` / `abstained` 的答案封套，不是已做语义验证的差异或风险对象。
- 文档读取、skill 执行、task 和 agent run 都携带 `accessScope`。
- Working memory 是 run-scoped，只记录本轮 queries、claims、gaps 和 loop counters。
- Agent experience memory 是规划提示，不是事实来源；答案证据仍必须来自 citations。
- Workspace artifact 是生成结果而非 RAG 来源；不会进入文档 registry、向量索引、citation、claim support 或 evidence。
- 对外部工具调用先经过 query policy 和 approval policy，避免把敏感实体直接带出工作区。

## 关键调用链

| 场景 | 谁调用 | 谁决定 | 谁执行 |
| --- | --- | --- | --- |
| 上传 PDF | `src/components/PdfUploader.jsx` 调 `/upload` 或分片上传接口 | `server/routes/uploads.js` 校验文件名、魔数、session 和 access scope | `server/rag/index.js` 用 `pdf-loader.js` 解析 PDF，`chunker.js` 切块，`doc-registry.js` 写 PostgreSQL，`vector-store*.js` 写索引 |
| 普通问答 | `src/components/ChatComponent.jsx` 调 `/chat` | `server/routes/chat.js` 接请求，`server/rag/agent.js` 编排 bootstrap、planner、clarification 和 execution plan | `agent-document-loop.js`、`document-rag-execution.js`、retrievers、self-check、finalization flow |
| 多文档对比 | 同一个 `/chat` 请求传入多个 `docIds` | `agent-planner.js` 和 compare intent 判断是否需要对比路径 | `retrievers/per-doc-retriever.js`、`comparison-engine.js`、`evidence-aligner.js` 保留文档边界 |
| arXiv 推荐导入 | 前端 arXiv panel 调 suggestion / task action | `arxiv-enrichment.js` 生成清理后的 topic 和签名候选，task service 记录等待确认 | `job-orchestrator.js` 派发 runner，`arxiv-importer.js` 下载、去重并复用 ingestion |
| Agent goal task | `/agent-tasks` 创建 durable goal，前端 Agent Run Center 消费 `/tasks` 返回的公开 plan | `agent-tasks.js` 驱动多轮 task loop，`agent-goal-plan.js` 生成公开计划合同 | `job-orchestrator.js` 调 runner，`runAgentRag()` 执行每轮 `/chat` 路径，task action 可继续或批准 |
| Agent run 恢复 | 前端 recovery controls 调 `/agent-runs/*`，启动时也扫描 recoverable run | `agent-run-recovery.js` 和 replay safety matrix 判断能否自动恢复；guarded graph 还需私有 checkpoint 与 step 对账、无待审批且外层 plan 只有 `custom_skills` | `agent-run-step-executor.js` 恢复安全 step / 审批后的 capability step；符合上述窄条件的 graph-only run 用专用续跑路径复用已完成 node，未知 in-flight 或不一致时转人工 |
| 质量门控 | CLI、前端 Quality 面板或 CI 调 eval/gate | `server/evaluation/quality-*.js` 组合各类报告 | synthetic、trajectory、planner、recovery、feedback、rerank、coverage 等 runner 执行 |

## 快速启动

### 1. 安装依赖

```bash
npm install
cd server
npm install
cd ..
```

### 2. 配置环境变量

```bash
cp .env.example .env
cp server/.env.example server/.env
```

常用最小配置：

```env
# server/.env
OPENAI_API_KEY=your_openai_api_key
# 可选：OpenAI 兼容代理 / 自建端点
# OPENAI_BASE_URL=
SERPAPI_KEY=your_serpapi_key

POSTGRES_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/agentai
POSTGRES_SSL_ENABLED=false
WORKSPACE_ARTIFACT_STORE_PROVIDER=auto
WORKSPACE_ARTIFACTS_POSTGRES_TABLE=rag_workspace_artifacts

VECTOR_STORE_PROVIDER=pgvector
RAG_HYBRID_ENABLED=true
RAG_HYBRID_FUSION=rrf
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_CHAT_MODEL=gpt-5

AGENT_PLANNER_ROLLOUT=llm
AGENT_INTENT_PLANNER=llm
AGENT_EXECUTION_PLANNER=llm
AGENT_SKILL_GRAPH_ROLLOUT=guarded
AGENT_UNIFIED_GRAPH_ROLLOUT=off

RAG_CHUNK_STRATEGY=structured
RAG_CHUNK_SIZE=900
RAG_CHUNK_OVERLAP=180
RAG_RETRIEVAL_TOP_K=6
RAG_COMPARE_TOP_K_PER_DOC=3

RAG_LLMOPS_POLICY_ENABLED=true
RAG_LLMOPS_ENFORCEMENT_MODE=record
# Optional: set these only when you want per-event budget gates.
RAG_LLMOPS_MAX_COST_USD_PER_EVENT=
RAG_LLMOPS_MAX_TOKENS_PER_EVENT=

ALLOWED_ORIGINS=http://localhost:3000
RATE_LIMIT_ENABLED=true

STARTUP_HEALTH_STRICT=false
```

```env
# .env
VITE_DOMAIN=http://localhost:5001
VITE_API_AUTH_TOKEN=
```

说明：

- PostgreSQL 是当前文档持久化、PDF 文件流、task、agent run、workspace artifact、long memory 的主路径；本地可用 `createdb agentai` 创建默认库。
- Workspace artifact 的 `auto` provider 在 PostgreSQL 可用时持久化到 `rag_workspace_artifacts`；回退的 memory adapter 仅适合本地开发，重启后会丢失生成结果。
- `VECTOR_STORE_PROVIDER=pgvector` 是默认值：chunk、向量和 FTS tsvector 都在 PostgreSQL 的 `rag_document_chunks` 表里，需要带 pgvector 扩展的实例——仓库根目录 `docker compose up -d` 会起一个 `pgvector/pgvector:pg16`。`local`（JSON 索引写到 `server/data/rag/`）和 `qdrant` 仍可显式选择；白名单之外的值直接报错，不会回落。
- 从 `local` / Qdrant 切到 pgvector 后索引是空的，健康检查会报错；先跑 `cd server && npm run vector:reindex`（默认 dry-run，`-- --apply` 才写入；`--from documents` 会用库里的 PDF 重新切块和 embedding）。
- `RAG_HYBRID_ENABLED=true` + `RAG_HYBRID_FUSION=rrf` 是默认值：dense 与 sparse 两路各自独立检索后融合。pgvector 的 sparse 路是 PostgreSQL FTS，用 `ts_rank_cd` 排序，不是 BM25。
- 只做文档 RAG 时 `SERPAPI_KEY` 可以先留空；web search 能力需要它。
- `AGENT_SKILL_GRAPH_ROLLOUT=guarded` 是默认值：custom skill 阶段由 typed DAG 运行时执行，V1 顺序链只在整张图被拒、尚无节点执行时兜底。`off` 是回到 V1 链的显式开关，`shadow` 让 V1 出答案、旁路规划一张图做比对；无法识别的取值按 `off` 处理。三种模式都不改变 `/chat` 响应结构。谁来规划这张图是另一个开关：DAG 规划器跟随 `AGENT_EXECUTION_PLANNER`，LLM 规划失败时先退回确定性图，确定性图也被拒才回落 V1 链。`rollout:readiness` 衡量的是纯 LLM 规划能否零降级，不再是执行器默认值的门禁。见 [docs/agent-rag.md](docs/agent-rag.md#custom-skill-执行v1-chain-与-v2-typed-dag)。
- `AGENT_UNIFIED_GRAPH_ROLLOUT=off` 单独控制全阶段 v3 图迁移，目前只开放 `shadow`：必须注入统一图 planner adapter 才会旁路产出有效候选；真实 `/chat` 和后台 task 仍按现有外层流程执行，run event 仅记录精简规划结果。`guarded` 尚未开放，设置它会回到 `off`。见 [迁移决策与验收清单](docs/unified-agent-dag-migration.md)。
- 前端 dev server 固定跑在 `3000` 端口，与 `ALLOWED_ORIGINS` 的 CORS 白名单一致；改端口时两边要同步。
- 完整配置见 [docs/configuration.md](docs/configuration.md)。

### 3. 启动

```bash
npm run dev
```

默认地址：

| 服务 | 地址 |
| --- | --- |
| Frontend | `http://localhost:3000` |
| Backend | `http://localhost:5001` |

健康检查：

```bash
curl http://localhost:5001/health
curl http://localhost:5001/ready
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 从根目录同时启动 React 前端和 Express 后端。 |
| `npm start` | 只启动前端（Vite dev server，端口 3000）。 |
| `npm run server` | 从根目录启动后端，等价于进入 `server/` 后运行 `npm run start`。 |
| `npm run build` | 构建前端生产包（Vite，输出 `build/`）。 |
| `npm test` | 运行前端测试（Vitest，单次运行约 7s）。 |
| `npm run test:watch` | 前端测试 watch 模式。 |
| `cd server && npm test` | 运行后端聚合测试（每个测试文件独立进程并行，约 4s）。 |
| `cd server && npm run coverage:gate` | 检查后端覆盖率最低门槛。 |
| `cd server && npm run eval:synthetic` | 运行默认 synthetic RAG eval。 |
| `cd server && npm run eval:synthetic -- evaluation/synthetic-corpus-near-duplicate.json` | 运行 legacy near-duplicate corpus；它不再是 hard/real robust signal 的主入口。 |
| `cd server && npm run eval:trajectory` | 检查 skill selection、follow-up retrieval、clarification、access scope 和 budget 行为。 |
| `cd server && npm run eval:feedback` | 从 seed + runtime 反馈生成回归语料并运行 deterministic latest-feedback eval。 |
| `cd server && npm run eval:robust-suite` | 手动运行 compare-hard synthetic、hard-CS rerank 和 arXiv real-paper rerank；每周由 Release Evidence Gate 复用同一 suite。 |
| `cd server && npm run robust:gate -- --fail-on-warn` | 只校验三份 robust suite 最新报告，不混入历史 quality 状态。 |
| `cd server && npm run eval:planner` | 评测 planner mock provider；`-- --provider real` 生成真实 provider 报告。 |
| `cd server && npm run planner:gate -- --provider real` | 检查 real planner report、fallback rate 和 mock/real divergence。 |
| `cd server && npm run eval:recovery-observability` | 检查 recovery/replay observability。 |
| `cd server && npm run trace:demo` | 跑一次 Agent 请求并打印它的 OpenTelemetry span 树；`-- --real` 用配置的模型端点，`-- --otlp` 同时导出。 |
| `cd server && npm run rollout:readiness` | 汇总 planner、trajectory、recovery、fallback 和 divergence rollout signal。 |
| `cd server && npm run runtime:smoke` | 用真实 planner 和 PostgreSQL smoke `/health`、`/chat` runtime。 |
| `cd server && npm run eval:rerank` | 运行离线 rerank ranking eval。 |
| `cd server && npm run eval:param-sweep` | 跑 topK、overlap、rerank、hybrid 参数扫描；`-- --profile full` 扩大矩阵。 |
| `cd server && npm run vector:reindex` | 把 local JSON / Qdrant 里的 chunk 与向量回填到 pgvector，或用库里的 PDF 重新 embedding（`--from documents`）；默认 dry-run，`-- --apply` 才写入。 |
| `cd server && npm run test:pgvector` | 单独跑真实数据库集成测试；需要 `PGVECTOR_TEST_DATABASE_URL`，否则报告为 skipped。 |
| `cd server && npm run quality:gate` | 查看兼容旧 payload 的历史 metrics；即使输出 PASS，也不代表当前 commit 已验证。 |
| `cd server && npm run quality:current` | 校验 PR 轻量评测是否全部来自当前 commit、24 小时内且由 clean worktree 生成；证据未验证时 metrics 只保留诊断值并标记为 unverified。 |
| `cd server && npm run release:gate` | 严格检查当前 commit 的 8 份发布证据，包括 freshness、clean worktree、corpus/provider 和 source lineage。 |

`quality:gate` 保留为兼容旧 payload 的历史 metrics 查看器，输出 PASS 不再代表当前 commit 已通过。默认 PR 入口是 `quality:current`：CI 会重新生成独立的 deterministic `latest-quality.*`，要求 synthetic、feedback、trajectory、planner-mock 和 recovery 报告自身通过并绑定同一 SHA；存在 planner-real 时也必须通过逐报告校验。门禁还会用版本化 suite manifest 固定必需 case/check IDs、关键 case 语义、语料页、事实 claim/来源归属、拒答输出和 deterministic 上传身份；citation 必须对应本次 raw retrieval，recovery cases 从原始 recovery summary 独立重算，planner/trajectory 必须匹配稳定 response projection，其中高风险 trajectory 另持久化 privacy-safe `case.response.observed` 原始观测，避免把 `check.detail` 或 `check.passed` 当证据。再由门禁独立重算 claim support、断点续传不变量和汇总指标，防止删减覆盖面、伪造 raw verdict 或用 summary 掩盖 failure；只要 worktree、lineage、报告契约或 baseline 任一证据检查失败，对外 metrics 状态就是 `unverified`，原始 metrics 判断只作为 diagnostics 保留。回归比较只使用受版本控制的 `server/evaluation/baselines/quality-near-duplicate-deterministic-v1.json`，旧 `latest.json` 或残留 timestamped 报告不能替换 baseline。`release:gate` 仍是更完整、也更昂贵的发布入口；current gate 校验报告契约与 current-SHA lineage，自身不构成 runner 执行证明、完整内部事件重放或密码学来源证明，实际运行 provenance 仍由 CI 步骤顺序与 artifact 提供。

CI 侧，`quality-gate.yml` 把前端测试/构建、后端测试/覆盖率和 current eval+gate 拆成三个并行 job；所有 producer 失败后仍会继续生成可用诊断，最后上传 current gate JSON/Markdown 与原始报告。planner real gate 和 release evidence 保留独立的定时 workflow；standalone Robust Eval Suite 仅供手动运行，每周 Release Evidence Gate 会先运行同一 robust suite 和 scoped `robust:gate`，再执行严格发布门禁。robust workflow 不再调用历史 `quality:gate`，因此旧 synthetic、feedback、planner、trajectory 或 recovery 状态不会制造无关失败通知。周期 suite 直接读取受版本控制的 arXiv corpus，并在运行前校验固定 SHA-256/manifest identity；联网刷新只通过显式 `corpus:arxiv` 命令生成候选文件，不再把 arXiv 瞬时网络故障当作代码失败。

## 真实模型评测结果

下表用本地 Ollama 上的真实模型（`nomic-embed-text` + `qwen2.5:7b`）测得，不是 GPT 级模型或生产流量；评测集较小，未标"显著"的差异不能说成更好。命令、版本和完整表格见 [server/docs/interview/CURRENT-TRUTH.md](server/docs/interview/CURRENT-TRUTH.md) 和 [docs/evaluation.md](docs/evaluation.md)。

| 方面 | 结果 |
| --- | --- |
| 检索（48 条用例，Recall@5） | hybrid RRF 0.712，dense 0.654，BM25 0.658，hybrid + 启发式 rerank 0.663；全量差异的 95% 置信区间跨 0，tuning 子集上 hybrid 比 BM25 显著更好。伪 embedding 下 hybrid 反而最差（0.543），所以效果结论只来自真实模型。 |
| 端到端质量（`verify:quality`） | 16/18 → 18/18：修复了两个让对比答案全部被拒的校验器 bug（逗号分隔的多来源引用、`vendor-a` 类文件名不被当作文档名）。 |
| 规划器（5 轮、25 次 LLM 规划） | 按请求生成的 strict JSON Schema 约束解码：降级率 56% → 8%，用例通过率 47% → 80%，每轮耗时 14.1s → 14.2s。 |
| LLM 调用容错（故障注入） | 限流成功率 79% → 100%，请求挂起 87.5% → 100%（p95 15s → 3.4s），空响应 62.5% → 91.7%，主模型宕机 0% → 100%；代价是限流时 p95 约 2.5s → 4.7s。 |

## 评测优化结果

优化前，主 synthetic `latest.*` 和 legacy rerank 报告长期依赖 near-duplicate 小语料。旧 `latest-rerank.md` 只有 `6` 个 ranking cases，NDCG、Recall、MRR 都是 `1.0000 -> 1.0000`，lift 为 `0.0000`，无法证明 rerank 对困难检索有真实收益。

这次优化把 robust 评测统一到 `eval:robust-suite`：用 compare-hard 刷新主 synthetic regression，把 hard-CS rerank 和 arXiv real-paper rerank 写成独立 latest reports，并交给 scoped `robust:gate -- --fail-on-warn` 强制检查。standalone workflow 负责手动诊断，固定周期由 Release Evidence Gate 运行同一命令并继续执行 strict release gate。suite 定义集中在 `server/evaluation/eval-suite.js`，runner 只消费配置；suite lineage 同时绑定 pinned arXiv corpus 的内容 hash/identity，release gate 还要求三份 robust 正文的 runId/createdAt 与 evidence envelope 一致并固定 schema/generator。质量门通过 `quality-robust-suite-gate.js` 统一检查 report 是否存在、语料是否匹配、case 数量是否非空、NDCG/Recall 是否不回退，以及 NDCG lift 是否退化成 `0`。

前后对比如下：

| 评测层 | 优化前 | 优化后 | 变化 |
| --- | --- | --- | --- |
| 主 synthetic regression | `latest.*` 长期追踪 near-duplicate，小语料容易满分饱和。 | `eval:robust-suite` 用 compare-hard corpus 刷新 `latest.*`。 | 主报告从容易饱和的近重复集，切到更难的 compare 回归集。 |
| Legacy rerank signal | near-duplicate `latest-rerank.md`：NDCG `1.0000 -> 1.0000`，Recall `1.0000 -> 1.0000`，MRR `1.0000 -> 1.0000`，lift `0.0000`。 | hard-CS rerank probe：NDCG `0.9385 -> 1.0`，MRR `0.9167 -> 1.0`。 | baseline 不再满分，rerank 在困难 CS 语料上有可见 lift。 |
| Real-paper rerank coverage | legacy 小语料不覆盖长论文、跨论文比较和 hard negative。 | arXiv real-paper rerank probe：NDCG `0.4698 -> 0.5394`，Recall `0.6215 -> 0.6771`，MRR `0.476 -> 0.5615`。 | 固定 gate 开始覆盖真实论文语料，能观察长文档排序收益。 |

## 工程化基线

代码库经过四级系统性优化（安全 → 性能 → 架构 → 工程化），当前基线：

| 层级 | 落点 |
| --- | --- |
| 安全 | CORS 白名单（`ALLOWED_ORIGINS`）、helmet、分级限流（全局/chat/upload/destructive）、上传会话按 principal/workspace 分域、文件名 + `%PDF` 魔数双重校验、无静态 `/uploads` 暴露。 |
| 性能与可靠性 | 存储层异步原子写 + 写锁 + 增量 BM25 统计；embedding LRU 缓存；外部 fetch 全部带超时；上传 session TTL 清扫；store `list()` 分页；前端 `/chat` AbortController + 组件 memo 化。 |
| 架构 | `app.js` 组合根（171 行）+ `app-services.js` 服务装配 + `server/routes/` 特性 Router + zod 校验；`agent-self-check` 拆为 `self-check/` 8 个模块；`normalizeText` 收敛到 `server/lib/normalize-text.js`；langchain 替换为 `prompt-template.js` / `openai-client.js` / `pdf-loader.js` 三个自有模块，后端直接依赖 18 → 13。 |
| 工程化 | 前端 CRA → Vite 7 + Vitest 3（测试 97s → ~7s，构建 ~8s）；后端测试并行化（24s → ~4s，含 Windows 全平台通过）；CI 后端测试与 eval gate 拆并行 job；评测脚本共享 helper 收敛到 `eval-cli.js` / `eval-case-helpers.js`。 |

前后端测试基线（`99af0019`）：后端 1687 个用例（2 个需要 PostgreSQL 的集成测试在无数据库时跳过）、前端 102 个用例全绿，覆盖率门禁通过。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [docs/configuration.md](docs/configuration.md) | 环境变量、auth、PostgreSQL、vector store、retrieval、rerank、observability 配置。 |
| [docs/agent-rag.md](docs/agent-rag.md) | AgentRAG 闭环、QA/compare 路径、skill registry、custom skill 的 V1 chain / V2 typed DAG 与灰度、关键模块和 `/chat` observability。 |
| [docs/evaluation.md](docs/evaluation.md) | Synthetic、trajectory、feedback、planner、recovery、rerank、Ragas、coverage 和 CI gate。 |
| [docs/development.md](docs/development.md) | 完整 API 表、目录结构、runtime paths 和开发约束。 |

## API 摘要

完整接口表维护在 [docs/development.md#api](docs/development.md#api)。首页只保留能力分组：

| 能力 | Endpoint 组 |
| --- | --- |
| 健康检查 | `GET /health`, `GET /ready` |
| 文档管理 | `/documents`, `/documents/:docId/file`, `/documents/clear` |
| 生成结果 | `GET /artifacts`, `GET /artifacts/:artifactId`, download 和 archive actions |
| 上传 | `/upload/init`, `/upload/status`, `/upload/chunk`, `/upload/complete`, `/upload` |
| 问答 | `GET /chat`, `POST /chat`, `POST /chat/stream`（SSE 进度事件） |
| Tasks | `/tasks`, `/agent-tasks`, `/agent-triggers`, `/tasks/:taskId`, `/tasks/:taskId/actions/:action` |
| Agent runs | `/agent-runs`, `/agent-runs/recovery`, `/agent-runs/:runId`, approval/recovery/retry actions |
| Capabilities | `GET /capabilities` |
| arXiv | `/arxiv/search`, `/arxiv/import`, `/documents/*/arxiv/*` |
| Memory | `/sessions/:sessionId`, `/memory` |
| Feedback / quality | `/feedback`, `/quality/latest`, `/quality/history` |
| Admin / governance | `/admin/status`, `/admin/actions/:action`（含受控的 `quality-refresh`）, `/admin/audit` |

## 仓库结构

```text
.
├── index.html                   # Vite 入口 HTML
├── vite.config.js               # Vite + Vitest 配置（端口 3000、outDir build/）
├── src/                         # React workspace UI
│   ├── components/              # 上传、聊天、PDF 预览、trace、Agent Run Center、quality（.jsx）
│   ├── hooks/                   # workspace、selection、task、recovery、arXiv、chat scope 等状态
│   ├── styles/                  # App.css 的 11 个有序样式切片
│   └── archiveApi.js            # 前端 API client surface
├── server/
│   ├── server.js                # 进程入口（加载 dotenv 后启动 app）
│   ├── app.js                   # 组合根：中间件、限流、启动序列、挂载 Router
│   ├── app-services.js          # createAppServices 服务装配
│   ├── routes/                  # 特性 Router（documents/uploads/chat/tasks/...）+ zod 校验
│   ├── auth.js                  # API token 和 accessScope 处理
│   ├── health.js                # 启动/就绪检查
│   ├── lib/                     # normalize-text、prompt-template 等共享工具
│   ├── rag/                     # RAG、AgentRAG、skills、capabilities、stores
│   │   ├── self-check/          # claim/evidence 自检模块
│   │   └── workspace-artifacts/ # Scoped 生成结果持久化
│   ├── evaluation/              # Eval runners、共享 helper、quality gates
│   ├── test/                    # 后端聚合测试（并行执行）
│   └── db/migrations/           # PostgreSQL 表
├── docs/                        # 深入文档
└── README.md                    # 项目入口页
```

运行时和生成路径通常不要手改或提交：`node_modules/`、`build/`、`server/node_modules/`、`server/data/`、`server/uploads/`、`server/upload-sessions/`、`server/evaluation/generated/`、timestamped `server/evaluation/results/`。

## AgentRAG 优化路线

当前主线遵循低耦合、避免重复代码、复用现有模块边界的原则：

| 顺序 | 主题 | 当前落点 |
| --- | --- | --- |
| 1 | Planner eval gate | 已接入 `eval:planner`、`planner:gate`、`rollout:readiness` 和 `quality:gate`。 |
| 2 | 持久化主执行路径 | Task store、agent run store、step snapshots/events 已通过 PostgreSQL-backed adapter 持久化。 |
| 3 | Agent run recovery | 已有 startup recovery、manual/auto recovery、approval resume、step retry 和 replay safety matrix；guarded graph 增加同 run 私有 checkpoint 与受限的 graph-only startup auto resume，不会重跑已完成 node，也不宣称外层混合阶段可自动续跑。 |
| 4 | PostgreSQL restart 覆盖 | 已补 HTTP/API 级 paused document resume、failed step retry 和 blocked approval safety 覆盖，继续复用 replay safety matrix 和 step executor。 |
| 5 | 真实/困难语料评测 | 已用 `eval:robust-suite` 把 compare-hard、hard-CS rerank 和 arXiv real-paper rerank 纳入固定周期 gate，替代只看 near-duplicate 饱和分数。 |
| 6 | Agent task 目标产物 | 已把 `report.export`、`document.organize`、`summary.create`、`task.create` 接成 task-level goal deliverables；批准后前三类会真实写入 scoped workspace artifact 并只向 task 暴露 compact refs，写入失败时目标不会误报完成。 |
| 7 | Research task / dossier | 已加 task-level research flow：本地 `research_brief` -> web supplement -> arXiv supplement -> compare/risk review -> citation self-check -> final dossier -> report deliverables。流程由 declarative `research_dossier` workflow spec 渲染，只生成下一步问题、公开 phase 状态和 workflow lifecycle snapshot，实际执行仍复用现有 planner、skills、approval gates 和 capability registry。 |
| 8 | 目标完成自检 | 已加 task-level `goalCompletion` contract：统一检查 public plan steps、unresolved gaps / unsupported claims、goal deliverables、pending approval / user action、research phases 和 workflow lifecycle contract；默认 trajectory eval 覆盖从等待批准到产物创建后的完整目标生命周期。 |
| 9 | Plan-and-Execute typed DAG | 已在 custom skill 阶段内部加授权原子 Skill catalog、typed skill contract、版本化 `ExecutionGraph`、纯函数 validator、运行时输入/输出 gate、拓扑 scheduler、持久化 graph checkpoint 和一次有界 replan；执行器由 `AGENT_SKILL_GRAPH_ROLLOUT`（`guarded`/`shadow`/`off`，默认 `guarded`）选择，V1 顺序链只作为整图被拒时的兜底和运维的显式回退，组合 intent 和 deterministic planner 保留。四个 trajectory case 钉住 DAG 行为，planner eval 另有 compare-only intent 下动态组合 compare+risk 的 guarded case；real provider、runtime smoke 和 rollout/release gate 为真实模型灰度提供额外门禁。 |

## 当前限制

- 这是本地优先的工程型工作台，不是完整 SaaS 权限系统；多人部署应使用 `API_AUTH_TOKENS` 或 JWT auth，并补齐外围身份提供方、审计和网络隔离。
- Connector / MCP adapter 默认不会加载任意外部工具；只有显式注册 connector spec、注入 executor，并提供 required secret refs / 可选 sandbox runner 后才会执行，且仍走 capability approval、replay safety、input filtering 和 refs-only secret boundary。
- Model/provider registry 已接管 chat、embedding、LLM planner 和可选 cross-encoder model name 的选择；LLMOps metrics contract + policy engine + observability/admin reader 已覆盖 completion、embedding 和 cross-encoder rerank 的 route/status/latency/error、token usage/source、estimated cost/pricing source、latency SLO、annotation、alert 和 per-event budget verdict / block mode。模型调用在 HTTP 客户端层有每端点并发上限和熔断器（`server/rag/model-call-guard.js`，按进程计），每次 Agent 运行有 token/成本/时长上限；账号级长期 quota 和告警外发仍应接同一 policy contract 继续扩展。
- PostgreSQL（含 pgvector 扩展）是文档、chunk 和向量的持久化主路径；`STARTUP_HEALTH_STRICT=false` 可以让服务在依赖异常时启动，但完整上传/检索工作流仍需要数据库和 OpenAI key。
- pgvector 的 lexical 路用 PostgreSQL FTS + `ts_rank_cd`，语义上不是 BM25；embedding 模型或维度变更需要显式 `vector:reindex`，不会自动迁移。Local JSON 索引和 Qdrant 只作为显式 opt-in 兼容后端保留，local 只适合单进程小规模工作区。
- Web search 和 arXiv 导入依赖外部网络；web search 需要 SerpAPI key，arXiv 使用公开 Atom/PDF 地址。
- Ragas eval 只是辅助信号；多文档 compare 和 citation 正确性主要依赖自定义 harness、trajectory 和 quality gate。
- Custom skill 阶段默认由 typed DAG 执行（`AGENT_SKILL_GRAPH_ROLLOUT=guarded`），但 LLM 规划 DAG 在本地 7B 模型上仍有降级，由确定性图兜底；DAG 也只覆盖 custom skill 阶段，built-in skill、document RAG 主循环、Web 和 capability 调用仍走各自既有路径，不能称为全工具统一 DAG。Typed output gate 校验字段形状，不证明差异/风险内容的语义正确；有界 replan 上限初始为 1。
