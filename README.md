<div align="center">

# Luc1ferxx Archive RAG

**可信文档智能体工作台：上传 PDF，围绕证据提问、对比、审查，并保留完整执行轨迹。**

它不是一个简单的“PDF 聊天框”。核心目标是让每个重要回答都能回到页级引用、检索记录、claim self-check、gap analysis 和质量门控，方便排查、复现和持续迭代。

<p>
  <img alt="React 18" src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=111111" />
  <img alt="Create React App" src="https://img.shields.io/badge/CRA-workbench-09D3AC?logo=react&logoColor=111111" />
  <img alt="Node.js ESM" src="https://img.shields.io/badge/Node.js-ESM-339933?logo=node.js&logoColor=ffffff" />
  <img alt="Express API" src="https://img.shields.io/badge/Express-API-000000?logo=express&logoColor=ffffff" />
  <img alt="OpenAI" src="https://img.shields.io/badge/OpenAI-GPT--5-412991?logo=openai&logoColor=ffffff" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-docs%20%7C%20runs%20%7C%20tasks-4169E1?logo=postgresql&logoColor=ffffff" />
  <img alt="Vector Store" src="https://img.shields.io/badge/Vector-local%20%7C%20Qdrant-FF4F00" />
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
| 文档工作台 | React 三栏式工作台，包含上传、文档列表、PDF 预览、聊天、sources、trace、Agent Run Center 和 quality 面板。 |
| PDF ingestion | 支持直接上传和分片上传；解析页文本，生成 document profile，写入 PostgreSQL 文档表和向量索引。 |
| 文档 RAG | Structured chunking、query decomposition、dense retrieval、可选 sparse hybrid、可选 rerank、confidence gate 和页级 citation。 |
| 多文档对比 | Compare 请求走 per-document retrieval，每份文档独立召回和 rerank，再做 evidence alignment、近重复保护和结构化差异输出。 |
| AgentRAG | LLM/deterministic planner 可配置，执行前校验 access scope；支持 clarification gate、approval gate、白名单 skill chain、self-check、gap analysis、follow-up retrieval、finalizer、research_task/dossier 流程、agent task 产物交付，以及 contract-only connector/MCP adapter 和 sandbox/secret boundary 层。 |
| Skills 和 capabilities | 内置 `document_rag`、`web_search`、`arxiv_import`、`inventory`、`document_discovery`、`research_brief`；custom skills 只从白名单加载。Capability registry 暴露 `report.export` 和 action capabilities 的统一 contract，不让模型调用任意工具。 |
| arXiv enrichment | 基于已上传文档 profile 生成清理后的 arXiv topic，返回可签名确认的候选论文；用户选择后通过异步 task runner 导入，并按 arXiv ID / PDF URL / title hash 去重。 |
| 执行持久化 | PostgreSQL-backed task store 和 agent run store 保存 task/run snapshot、公开 goal plan、goal deliverables、steps、events、approval gates 和 recovery 状态；没有持久化后端的 task/run 可回落内存实现。 |
| 记忆 | Session memory 用于追问改写；long memory 和 agent experience memory 在 PostgreSQL 配置后默认启用。Experience memory 只进入 planner hints，不作为 citation 或答案证据。 |
| 可观测性 | `/chat` 返回 `agentTrace`、`agentObservability`、`agentWorkingMemory`；可选写 JSONL trace，前端可展示 planner、skills、queries、gaps 和 removed claims。 |
| 质量体系 | 覆盖 synthetic、real、feedback、trajectory、planner、recovery observability、rerank、param sweep、coverage gate、Ragas 辅助评测和 GitHub Actions quality gate。 |
| 访问隔离 | `API_AUTH_ENABLED` 配合 `API_AUTH_TOKEN` 或 `API_AUTH_TOKENS` 后，文档列表、上传、chat、删除、PDF 文件、memory、feedback、quality 等接口按 `userId/workspaceId` scope 过滤。 |

## 系统架构

```mermaid
flowchart TB
  subgraph Frontend["React 18 / Create React App"]
    Workspace["Archive workspace"]
    Upload["PDF uploader"]
    Chat["Chat composer"]
    TraceUI["Trace / Sources / Tasks / Quality panels"]
  end

  subgraph API["Node ESM Express API"]
    Routes["server/app.js"]
    Auth["auth + accessScope"]
    UploadRoutes["upload routes"]
    ChatRoute["/chat"]
    TaskRoutes["tasks / agent-runs / quality"]
  end

  subgraph RAG["server/rag"]
    Ingest["PDF ingest + chunker + profiler"]
    Planner["Agent planner"]
    Skills["Skill registry + capability registry"]
    Retrieval["retrievers + vector store + reranker"]
    Loop["document loop + self-check + gap analysis"]
    Finalizer["answer synthesis + finalizer"]
    Runs["task store + agent run store + recovery"]
  end

  subgraph Storage["Storage"]
    Postgres["PostgreSQL documents, memories, tasks, runs"]
    Vector["Local JSON vector store or Qdrant"]
    UploadSessions["upload sessions"]
    TraceFiles["optional JSONL traces"]
  end

  Workspace --> Upload
  Workspace --> Chat
  Workspace --> TraceUI
  Upload --> UploadRoutes
  Chat --> ChatRoute
  TraceUI --> TaskRoutes
  Routes --> Auth
  UploadRoutes --> Ingest
  ChatRoute --> Planner
  Planner --> Skills
  Skills --> Retrieval
  Retrieval --> Loop
  Loop --> Finalizer
  Finalizer --> ChatRoute
  TaskRoutes --> Runs
  Ingest --> Postgres
  Ingest --> Vector
  Retrieval --> Vector
  Runs --> Postgres
  Loop --> TraceFiles
```

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
- 文档读取、skill 执行、task 和 agent run 都携带 `accessScope`。
- Working memory 是 run-scoped，只记录本轮 queries、claims、gaps 和 loop counters。
- Agent experience memory 是规划提示，不是事实来源；答案证据仍必须来自 citations。
- 对外部工具调用先经过 query policy 和 approval policy，避免把敏感实体直接带出工作区。

## 关键调用链

| 场景 | 谁调用 | 谁决定 | 谁执行 |
| --- | --- | --- | --- |
| 上传 PDF | `src/components/PdfUploader.js` 调 `/upload` 或分片上传接口 | `server/app.js` 校验文件、session 和 access scope | `server/rag/index.js` 解析 PDF，`chunker.js` 切块，`doc-registry.js` 写 PostgreSQL，`vector-store*.js` 写索引 |
| 普通问答 | `src/components/ChatComponent.js` 调 `/chat` | `server/rag/agent.js` 编排 bootstrap、planner、clarification 和 execution plan | `agent-document-loop.js`、`document-rag-execution.js`、retrievers、self-check、finalization flow |
| 多文档对比 | 同一个 `/chat` 请求传入多个 `docIds` | `agent-planner.js` 和 compare intent 判断是否需要对比路径 | `retrievers/per-doc-retriever.js`、`comparison-engine.js`、`evidence-aligner.js` 保留文档边界 |
| arXiv 推荐导入 | 前端 arXiv panel 调 suggestion / task action | `arxiv-enrichment.js` 生成清理后的 topic 和签名候选，task service 记录等待确认 | `job-orchestrator.js` 派发 runner，`arxiv-importer.js` 下载、去重并复用 ingestion |
| Agent goal task | `/agent-tasks` 创建 durable goal，前端 Agent Run Center 消费 `/tasks` 返回的公开 plan | `agent-tasks.js` 驱动多轮 task loop，`agent-goal-plan.js` 生成公开计划合同 | `job-orchestrator.js` 调 runner，`runAgentRag()` 执行每轮 `/chat` 路径，task action 可继续或批准 |
| Agent run 恢复 | 前端 recovery controls 调 `/agent-runs/*` | `agent-run-recovery.js` 和 replay safety matrix 判断能否自动恢复 | `agent-run-step-executor.js` 只恢复安全 step、审批后的 capability step 或显式 retry step |
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
SERPAPI_KEY=your_serpapi_key

POSTGRES_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/agentai
POSTGRES_SSL_ENABLED=false

VECTOR_STORE_PROVIDER=local
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_CHAT_MODEL=gpt-5

AGENT_PLANNER_ROLLOUT=llm
AGENT_INTENT_PLANNER=llm
AGENT_EXECUTION_PLANNER=llm

RAG_CHUNK_STRATEGY=structured
RAG_CHUNK_SIZE=900
RAG_CHUNK_OVERLAP=180
RAG_RETRIEVAL_TOP_K=6
RAG_COMPARE_TOP_K_PER_DOC=3

STARTUP_HEALTH_STRICT=false
```

```env
# .env
REACT_APP_DOMAIN=http://localhost:5001
REACT_APP_API_AUTH_TOKEN=
```

说明：

- PostgreSQL 是当前文档持久化、PDF 文件流、task、agent run、long memory 的主路径；本地可用 `createdb agentai` 创建默认库。
- `VECTOR_STORE_PROVIDER=local` 会把向量和 sparse index 写到 `server/data/rag/`；更大语料可以切到 Qdrant。
- 只做文档 RAG 时 `SERPAPI_KEY` 可以先留空；web search 能力需要它。
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
| `npm start` | 只启动前端。 |
| `npm run server` | 从根目录启动后端，等价于进入 `server/` 后运行 `npm run start`。 |
| `npm run build` | 构建前端生产包。 |
| `CI=true npm test -- --watchAll=false` | 非 watch 模式运行前端测试。 |
| `cd server && npm test` | 运行后端聚合测试。 |
| `cd server && npm run coverage:gate` | 检查后端覆盖率最低门槛。 |
| `cd server && npm run eval:synthetic` | 运行默认 synthetic RAG eval。 |
| `cd server && npm run eval:synthetic -- evaluation/synthetic-corpus-near-duplicate.json` | 运行 legacy near-duplicate corpus；它不再是 hard/real robust signal 的主入口。 |
| `cd server && npm run eval:trajectory` | 检查 skill selection、follow-up retrieval、clarification、access scope 和 budget 行为。 |
| `cd server && npm run eval:feedback` | 从 seed + runtime 反馈生成回归语料并运行 deterministic latest-feedback eval。 |
| `cd server && npm run eval:robust-suite` | 固定周期运行 compare-hard synthetic、hard-CS rerank 和 arXiv real-paper rerank。 |
| `cd server && npm run eval:planner` | 评测 planner mock provider；`-- --provider real` 生成真实 provider 报告。 |
| `cd server && npm run planner:gate -- --provider real` | 检查 real planner report、fallback rate 和 mock/real divergence。 |
| `cd server && npm run eval:recovery-observability` | 检查 recovery/replay observability。 |
| `cd server && npm run rollout:readiness` | 汇总 planner、trajectory、recovery、fallback 和 divergence rollout signal。 |
| `cd server && npm run runtime:smoke` | 用真实 planner 和 PostgreSQL smoke `/health`、`/chat` runtime。 |
| `cd server && npm run eval:rerank` | 运行离线 rerank ranking eval。 |
| `cd server && npm run eval:param-sweep` | 跑 topK、overlap、rerank、hybrid 参数扫描；`-- --profile full` 扩大矩阵。 |
| `cd server && npm run quality:gate` | 组合 feedback、trajectory、planner、recovery 等报告并执行质量门控；`-- --require-robust-suite` 会强制检查 hard/real suite。 |

## 评测优化结果

优化前，主 synthetic `latest.*` 和 legacy rerank 报告长期依赖 near-duplicate 小语料。旧 `latest-rerank.md` 只有 `6` 个 ranking cases，NDCG、Recall、MRR 都是 `1.0000 -> 1.0000`，lift 为 `0.0000`，无法证明 rerank 对困难检索有真实收益。

这次优化把固定周期入口改为 `eval:robust-suite`：用 compare-hard 刷新主 synthetic regression，把 hard-CS rerank 和 arXiv real-paper rerank 写成独立 latest reports，并交给 `quality:gate -- --require-robust-suite` 强制检查。suite 定义集中在 `server/evaluation/eval-suite.js`，runner 只消费配置；质量门通过 `quality-robust-suite-gate.js` 统一检查 report 是否存在、语料是否匹配、case 数量是否非空、NDCG/Recall 是否不回退，以及 NDCG lift 是否退化成 `0`。

前后对比如下：

| 评测层 | 优化前 | 优化后 | 变化 |
| --- | --- | --- | --- |
| 主 synthetic regression | `latest.*` 长期追踪 near-duplicate，小语料容易满分饱和。 | `eval:robust-suite` 用 compare-hard corpus 刷新 `latest.*`。 | 主报告从容易饱和的近重复集，切到更难的 compare 回归集。 |
| Legacy rerank signal | near-duplicate `latest-rerank.md`：NDCG `1.0000 -> 1.0000`，Recall `1.0000 -> 1.0000`，MRR `1.0000 -> 1.0000`，lift `0.0000`。 | hard-CS rerank probe：NDCG `0.9385 -> 1.0`，MRR `0.9167 -> 1.0`。 | baseline 不再满分，rerank 在困难 CS 语料上有可见 lift。 |
| Real-paper rerank coverage | legacy 小语料不覆盖长论文、跨论文比较和 hard negative。 | arXiv real-paper rerank probe：NDCG `0.4698 -> 0.5394`，Recall `0.6215 -> 0.6771`，MRR `0.476 -> 0.5615`。 | 固定 gate 开始覆盖真实论文语料，能观察长文档排序收益。 |

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [docs/configuration.md](docs/configuration.md) | 环境变量、auth、PostgreSQL、vector store、retrieval、rerank、observability 配置。 |
| [docs/agent-rag.md](docs/agent-rag.md) | AgentRAG 闭环、QA/compare 路径、skill registry、关键模块和 `/chat` observability。 |
| [docs/evaluation.md](docs/evaluation.md) | Synthetic、trajectory、feedback、planner、recovery、rerank、Ragas、coverage 和 CI gate。 |
| [docs/development.md](docs/development.md) | 完整 API 表、目录结构、runtime paths 和开发约束。 |

## API 摘要

完整接口表维护在 [docs/development.md#api](docs/development.md#api)。首页只保留能力分组：

| 能力 | Endpoint 组 |
| --- | --- |
| 健康检查 | `GET /health`, `GET /ready` |
| 文档管理 | `/documents`, `/documents/:docId/file`, `/documents/clear` |
| 上传 | `/upload/init`, `/upload/status`, `/upload/chunk`, `/upload/complete`, `/upload` |
| 问答 | `GET /chat`, `POST /chat` |
| Tasks | `/tasks`, `/agent-tasks`, `/tasks/:taskId`, `/tasks/:taskId/actions/:action` |
| Agent runs | `/agent-runs`, `/agent-runs/recovery`, `/agent-runs/:runId`, approval/recovery/retry actions |
| Capabilities | `GET /capabilities` |
| arXiv | `/arxiv/search`, `/arxiv/import`, `/documents/*/arxiv/*` |
| Memory | `/sessions/:sessionId`, `/memory` |
| Feedback / quality | `/feedback`, `/quality/latest`, `/quality/synthetic`, `/quality/history` |

## 仓库结构

```text
.
├── src/                         # React workspace UI
│   ├── components/              # Upload, chat, PDF preview, trace, Agent Run Center, quality
│   ├── hooks/                   # Workspace, selection, task, recovery, arXiv state
│   └── archiveApi.js            # Frontend API client surface
├── server/
│   ├── app.js                   # Express routes and API orchestration
│   ├── auth.js                  # API token and accessScope handling
│   ├── health.js                # Startup/readiness checks
│   ├── rag/                     # RAG, AgentRAG, skills, capabilities, stores
│   ├── evaluation/              # Eval runners, reports, quality gates
│   ├── test/                    # Backend aggregate tests
│   └── db/migrations/           # PostgreSQL tables
├── docs/                        # Deep documentation
└── README.md                    # Project entry page
```

运行时和生成路径通常不要手改或提交：`node_modules/`、`build/`、`server/node_modules/`、`server/data/`、`server/uploads/`、`server/upload-sessions/`、`server/evaluation/generated/`、timestamped `server/evaluation/results/`。

## AgentRAG 优化路线

当前主线遵循低耦合、避免重复代码、复用现有模块边界的原则：

| 顺序 | 主题 | 当前落点 |
| --- | --- | --- |
| 1 | Planner eval gate | 已接入 `eval:planner`、`planner:gate`、`rollout:readiness` 和 `quality:gate`。 |
| 2 | 持久化主执行路径 | Task store、agent run store、step snapshots/events 已通过 PostgreSQL-backed adapter 持久化。 |
| 3 | Agent run recovery | 已有 startup recovery、manual/auto recovery、approval resume、step retry 和 replay safety matrix。 |
| 4 | PostgreSQL restart 覆盖 | 已补 HTTP/API 级 paused document resume、failed step retry 和 blocked approval safety 覆盖，继续复用 replay safety matrix 和 step executor。 |
| 5 | 真实/困难语料评测 | 已用 `eval:robust-suite` 把 compare-hard、hard-CS rerank 和 arXiv real-paper rerank 纳入固定周期 gate，替代只看 near-duplicate 饱和分数。 |
| 6 | Agent task 目标产物 | 已把 `report.export`、`document.organize`、`summary.create`、`task.create` 接成 task-level goal deliverables；agent 完成回答后先进入 `approve_deliverables`，批准后复用 capability registry 创建 markdown report、保存 summary、整理文档和 follow-up task。 |
| 7 | Research task / dossier | 已加 task-level research flow：本地 `research_brief` -> web supplement -> arXiv supplement -> compare/risk review -> citation self-check -> final dossier -> report deliverables。流程由 declarative `research_dossier` workflow spec 渲染，只生成下一步问题、公开 phase 状态和 workflow lifecycle snapshot，实际执行仍复用现有 planner、skills、approval gates 和 capability registry。 |
| 8 | 目标完成自检 | 已加 task-level `goalCompletion` contract：统一检查 public plan steps、unresolved gaps / unsupported claims、goal deliverables、pending approval / user action、research phases 和 workflow lifecycle contract；默认 trajectory eval 覆盖从等待批准到产物创建后的完整目标生命周期。 |

## 当前限制

- 这是本地优先的工程型工作台，不是完整 SaaS 权限系统；多人部署应使用 `API_AUTH_TOKENS` 并补齐外围鉴权、审计和网络隔离。
- Connector / MCP adapter 和 sandbox/secret boundary 目前是 contract-only；默认不会加载真实外部工具或真实沙箱，未注入 executor 的 connector capability 即使获得批准也不会执行。
- PostgreSQL 是文档持久化主路径；`STARTUP_HEALTH_STRICT=false` 可以让服务在依赖异常时启动，但完整上传/检索工作流仍需要数据库和 OpenAI key。
- Local vector store 适合本地开发和小规模工作区；大规模语料建议切到 Qdrant 并单独压测。
- Web search 和 arXiv 导入依赖外部网络；web search 需要 SerpAPI key，arXiv 使用公开 Atom/PDF 地址。
- Ragas eval 只是辅助信号；多文档 compare 和 citation 正确性主要依赖自定义 harness、trajectory 和 quality gate。
