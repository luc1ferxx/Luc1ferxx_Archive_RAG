<div align="center">

# Luc1ferxx Archive RAG

**一个面向多 PDF 档案的可信文档智能体系统：上传、检索、对比、引用验证、AgentRAG 执行轨迹和质量门控。**

<p>
  <img alt="React 18" src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=111111" />
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-ESM-339933?logo=node.js&logoColor=ffffff" />
  <img alt="Express" src="https://img.shields.io/badge/Express-API-000000?logo=express&logoColor=ffffff" />
  <img alt="OpenAI" src="https://img.shields.io/badge/OpenAI-GPT--5-412991?logo=openai&logoColor=ffffff" />
  <img alt="Vector Store" src="https://img.shields.io/badge/Vector-local%20%7C%20Qdrant-ff4f00" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-persistence-4169E1?logo=postgresql&logoColor=ffffff" />
</p>

[当前进度](#当前进度) · [快速启动](#快速启动) · [系统架构](#系统架构) · [质量与评测](#质量与评测) · [API](#api)

</div>

## 项目定位

Luc1ferxx Archive RAG 已经不只是“上传 PDF 然后聊天”的 demo。当前项目更接近一个本地可运行的文档分析工作台，核心目标是让文档回答可验证、可追踪、可回归：

- 回答必须尽量回到页级 citation 和 citation excerpt。
- 对比多份文档时，检索阶段保留文档边界，避免单份强匹配文档垄断 top-k。
- AgentRAG 会先规划任务和 skill，再执行文档检索、自检、缺口分析、必要的 follow-up retrieval，以及最终答案过滤。
- 证据不足时，系统优先返回 clarification 或 evidence-limited answer，而不是硬编完整答案。
- 评测、feedback、trajectory trace、coverage gate 和 CI quality gate 都围绕“少幻觉、有出处、可复现”推进。

适合政策手册、合同、研究论文、知识库 PDF、归档资料等需要多文档对比和可验证引用的场景。

## 当前进度

| 模块 | 状态 |
| --- | --- |
| React 工作台 | 已完成三栏式上传、PDF 预览、问答和 citation 跳页体验。 |
| PDF 上传 | 已完成直接上传和 2 MB 默认分片上传，支持断点续传。 |
| 文档 RAG | 已完成 structured chunking、query decomposition、confidence gate、page citation 和 evidence summary。 |
| 多文档对比 | 已完成 per-document retrieval、证据对齐、近重复保护和结构化比较回答。 |
| AgentRAG planner | 已完成请求分类、skill 选择、白名单 skill chain、执行前 clarification gate。 |
| Agent execution loop | 已完成 `document_rag -> self_check -> gap_analysis -> follow_up_retrieval -> finalizer` 初版。 |
| Working memory | 已完成 run-scoped working memory，记录检索 query、supported/unsupported claims 和 gaps。 |
| Custom skills | 已完成 `extract_timeline`、`summarize_contract`、`risk_review`、`compare_documents` 白名单技能。 |
| Observability | 已完成 RAG JSONL trace、AgentRAG per-skill trace 和可读汇总报告。 |
| Feedback loop | 已完成答案反馈记录、feedback corpus 生成和 feedback regression eval。 |
| Rerank 评测 | 已完成离线 ranking eval、rerank sweep、arXiv real-paper corpus 草稿和 cross-encoder endpoint 适配。 |
| Quality gate | 已完成后端测试聚合、trajectory eval、feedback gate、coverage gate 和 GitHub Actions 初版。 |
| Auth / scope | 已完成 token 鉴权，以及按 `userId/workspaceId` 过滤文档、chat、删除和文件访问。 |

## 可信回答闭环

这个项目现在的主线不是单次生成，而是一条可观测的回答闭环：

```mermaid
flowchart LR
  Q["User question"] --> P["Agent planner"]
  P --> S["Skill selection / chain"]
  S --> R["Document retrieval"]
  R --> A["Grounded answer draft"]
  A --> C["Claim-level self-check"]
  C -->|supported| F["Answer finalizer"]
  C -->|gap found| G["Gap analysis"]
  G --> B["Budget check"]
  B -->|budget left| FR["Follow-up retrieval"]
  FR --> C
  B -->|budget exhausted| CL["Clarification gate"]
  F --> T["Trace + feedback + quality gate"]
  CL --> T
```

关键设计点：

- **Plan before retrieval**：AgentRAG 先判断任务类型、文档数量、access scope 和是否需要 custom skill。
- **Retrieve with boundaries**：普通 QA 用全局检索；compare 按文档独立检索，保留覆盖面。
- **Check claims**：self-check 会把回答拆成 claims，并用 citation excerpts 做数字、日期、专有名词和 code-like anchors 的支持检查。
- **Retry with focus**：unsupported claim 会进入 gap analysis，再生成 focused retrieval plan。
- **Finalize conservatively**：finalizer 会删除或降级最终仍没有 citation 支持的 claim。
- **Explain the run**：`/chat` 返回 `agentTrace`、`agentObservability` 和 `agentWorkingMemory`，前端会展示 skill、检索 query、证据缺口和 finalizer 删除内容。

## 核心能力

| 能力 | 当前实现 |
| --- | --- |
| 多 PDF 工作区 | 上传、列表、删除、清空、内嵌 PDF 预览、引用跳页。 |
| 可恢复分片上传 | `/upload/init`、`/upload/status`、`/upload/chunk`、`/upload/complete`，状态落在 `server/upload-sessions/`。 |
| 文档问答 | 基于页级 chunk 检索，返回 `ragAnswer`、`ragSources`、证据摘要和 AgentRAG trace。 |
| 公平多文档对比 | 对每份文档独立召回和 rerank，再做 evidence alignment 和结构化差异分析。 |
| 网页补充答案 | 通过本地 MCP search server 和 SerpAPI 生成独立 web answer，方便核对外部信息。 |
| 会话记忆 | PostgreSQL 保存最近会话，用于追问改写和指代消解。 |
| 长期偏好记忆 | 可选开启，用于保存回答语言、详略等长期偏好。 |
| 白名单技能 | 内置 document/web/discovery/research skills，加 custom contract/timeline/risk/compare skills。 |
| 可观测性 | RAG trace、AgentRAG trace、observability report、feedback metadata 和 quality report。 |
| 回归评测 | Synthetic、real-corpus、trajectory、feedback、rerank ranking、param sweep、ragas supplement。 |

## 产品界面

应用首屏就是工作台，不是落地页：

- 左侧：上传 PDF、查看相关文档、管理工作区文档。
- 中间：PDF 预览，点击 citation 后定位到相关页。
- 右侧：对话记录，展示 document answer、citations、gap plan、Agent trace 和 web answer。
- 底部：文本提问或 voice mode 语音提问。

## 快速启动

### 1. 准备环境

建议环境：

- Node.js 18+
- npm
- PostgreSQL，并准备一个可连接数据库
- OpenAI API key
- SerpAPI key，用于网页补充答案；只跑文档 RAG 时可以先不配
- Qdrant 可选，默认使用本地 JSON vector store

### 2. 安装依赖

```bash
npm install
cd server
npm install
cd ..
```

### 3. 创建数据库

如果本机有 PostgreSQL，可以直接创建默认数据库：

```bash
createdb agentai
```

如果使用远程 PostgreSQL，跳过这一步，在 `server/.env` 中配置 `POSTGRES_DATABASE_URL`。

### 4. 配置环境变量

```bash
cp .env.example .env
cp server/.env.example server/.env
```

最小可用后端配置示例：

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
RAG_QUERY_DECOMPOSITION_ENABLED=true

STARTUP_HEALTH_STRICT=false
```

前端默认请求 `http://localhost:5001`。如需修改后端地址，编辑根目录 `.env`：

```env
REACT_APP_DOMAIN=http://localhost:5001
REACT_APP_API_AUTH_TOKEN=
```

### 5. 启动

```bash
npm run dev
```

默认端口：

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
| `npm run dev` | 从根目录同时启动前端和后端。 |
| `npm start` | 只启动 React 前端。 |
| `npm run server` | 从根目录启动 Express 后端。 |
| `cd server && npm run start` | 在 `server/` 下启动后端。 |
| `npm run build` | 构建前端生产包。 |
| `CI=true npm test -- --watchAll=false` | 非 watch 模式运行前端测试。 |
| `cd server && npm test` | 运行后端聚合测试，并验证 quality gate workflow contract。 |
| `cd server && npm run coverage:gate` | 运行后端 coverage minimum gate，并输出目标阈值差距。 |
| `cd server && npm run coverage:targets` | 把目标覆盖率作为硬门控运行。 |
| `cd server && npm run eval:synthetic` | 运行默认 synthetic RAG eval。 |
| `cd server && npm run eval:trajectory` | 评测 AgentRAG skill、follow-up、clarification、access scope 和 budget。 |
| `cd server && npm run eval:rerank` | 运行离线 rerank ranking eval。 |
| `cd server && npm run eval:rerank:sweep` | 批量对比 topK、候选池、hybrid、OpenAI embedding 和 cross-encoder rerank。 |
| `cd server && npm run corpus:arxiv` | 按固定 manifest 生成 arXiv real-paper corpus 草稿。 |
| `cd server && npm run eval:param-sweep` | 批量测试 topK、chunk overlap、rerank、hybrid 权重。 |
| `cd server && npm run feedback:corpus` | 从负反馈生成 synthetic 评测语料。 |
| `cd server && npm run eval:feedback` | 用 feedback corpus 运行回归评测。 |
| `cd server && npm run quality:gate` | 检查 synthetic、feedback 和 trajectory 质量门控。 |
| `cd server && npm run eval:real -- evaluation/real-corpus.json` | 运行真实语料评测。 |
| `cd server && npm run eval:ragas -- --input evaluation/results/latest.json` | 对保存的 Node eval payload 运行可选 ragas 评测。 |
| `cd server && npm run observability:report` | 汇总 RAG / AgentRAG JSONL trace 为可读报告。 |

## 系统架构

```mermaid
flowchart LR
  U["User"] --> UI["React 18 / Ant Design"]
  UI --> API["Express API"]

  API --> Upload["Resumable PDF upload"]
  API --> Chat["/chat"]
  API --> Health["/health / /ready"]
  API --> Quality["Quality routes"]

  Upload --> PDF["PDF parsing"]
  PDF --> Chunker["Structured chunker"]
  Chunker --> Embed["OpenAI embeddings"]
  Embed --> Vector["Local JSON vector store or Qdrant"]
  Chunker --> Sparse["BM25 sparse store"]
  Upload --> PGDocs["PostgreSQL documents"]

  Chat --> Auth["Auth / access scope"]
  Chat --> Memory["Session memory / optional long memory"]
  Chat --> Agent["AgentRAG planner"]
  Agent --> Skills["Built-in + custom skills"]
  Skills --> Retriever["Global or per-document retrieval"]
  Retriever --> Rerank["Optional rerank"]
  Rerank --> Confidence["Confidence gate"]
  Confidence --> Writer["Grounded answer"]
  Writer --> SelfCheck["Claim support self-check"]
  SelfCheck --> Finalizer["Answer finalizer"]

  Chat --> MCP["Local MCP search server"]
  MCP --> Web["SerpAPI web search"]

  Finalizer --> UI
  Web --> UI
  Agent --> Trace["Agent trace / observability"]
  Trace --> Quality
```

## 技术栈

| 层 | 技术 |
| --- | --- |
| Frontend | React 18, Create React App, Ant Design, axios, speech recognition, speak-tts |
| Backend | Node.js ESM, Express, multer, zod |
| RAG 基础设施 | LangChain PDFLoader, OpenAI embeddings, OpenAI chat model |
| 自定义 RAG | chunker, query planner, query router, retrievers, confidence gate, reranker, evidence aligner, comparison engine |
| AgentRAG | planner, skill registry, skill chains, run context, working memory, self-check, finalizer, trace |
| Vector store | 默认 local JSON store；可切换 Qdrant |
| Sparse retrieval | 本地 BM25 sparse store；Qdrant provider 下使用 Qdrant sparse search |
| Persistence | PostgreSQL document bytes, session memory, optional long memory |
| Web answer | MCP stdio client/server + SerpAPI |
| Evaluation | Node custom harness, optional Python ragas, optional cross-encoder reranker |

## RAG 与 AgentRAG 设计

### QA 路径

1. 结合会话记忆把追问改写成独立检索问题。
2. 对复杂问题拆分 evidence requirements，例如时间、生效范围、适用地区。
3. 生成 query embedding，并按选中文档检索。
4. 可选启用 dense + sparse hybrid retrieval，融合方式支持 weighted score 或 RRF。
5. 可选启用 rerank，位置在 retrieval/hybrid 之后、confidence gate 之前。
6. 使用置信度门控过滤低相关或缺少 anchor coverage 的证据。
7. 生成 grounded answer、citations、evidence summary 和 AgentRAG observability。

### Compare 路径

普通全局 top-k 很容易让最匹配的一份文档挤掉其他文档。这里的 compare pipeline 从检索阶段就保留文档边界：

1. 识别显式对比、比较级问题、跨文档一致性等信号。
2. 对每份文档分别检索 `RAG_COMPARE_TOP_K_PER_DOC` 条证据。
3. 对每份文档独立 rerank。
4. 对齐证据，分析 shared terms、近重复、数值差异和显式冲突。
5. 如果证据高度近似且无冲突，走 deterministic no-difference guard。
6. 否则生成结构化 comparison answer：Summary、Per document、Agreements、Differences、Gaps。

### AgentRAG skills

AgentRAG 的工具能力通过 `server/rag/skills/registry.js` 注册。内置 skills 位于 `server/rag/skills/built-ins.js`，当前包括：

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

### Trace 与 observability

`/chat` 响应会返回：

- `agentSkills`：本轮候选和实际选中的 skills。
- `agentTrace`：plan、query planner、skill chain、document RAG、self-check、gap analysis、follow-up、finalizer 等步骤。
- `agentObservability`：per-skill attempts、duration、citations、abstain、retry/follow-up、budget、error 和 working memory。
- `agentWorkingMemory`：本次 run 内的检索 query、supported/unsupported claims、resolved/unresolved gaps。

当 `RAG_OBSERVABILITY_ENABLED=true` 时，后端会写 JSONL trace 到 `server/data/rag-observability/`。默认只保存 metadata、score、`excerptHash` 和短 preview；只有本地调试且能接受完整 chunk 文本落盘时，才建议设置：

```env
RAG_OBSERVABILITY_INCLUDE_CONTEXT=true
```

生成汇总报告：

```bash
cd server
npm run observability:report
```

## 配置指南

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 无 | 生成 embeddings 和回答所需。 |
| `SERPAPI_KEY` | 无 | MCP web answer 的搜索能力所需。 |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | 文档 chunk 与 query 的 embedding 模型。 |
| `OPENAI_CHAT_MODEL` | `gpt-5` | 文档答案、对比答案、网页摘要使用的模型。 |
| `RAG_PROMPT_VERSION` | `v3` | prompt 版本；`server/.env.example` 当前显式设置为 `v2`。 |
| `VECTOR_STORE_PROVIDER` | `local` | `local` 或 `qdrant`。 |
| `QDRANT_URL` | `http://127.0.0.1:6333` | Qdrant provider 地址。 |
| `QDRANT_COLLECTION` | `rag_chunks` | Qdrant collection 名称。 |
| `POSTGRES_DATABASE_URL` | 空 | 文档、会话记忆和长期记忆共用连接。 |
| `RAG_CHUNK_STRATEGY` | `structured` | `structured` 或 `simple`。 |
| `RAG_CHUNK_SIZE` | `900` | chunk 最大长度。 |
| `RAG_CHUNK_OVERLAP` | `180` | structured/simple chunk overlap。 |
| `RAG_RETRIEVAL_TOP_K` | `6` | QA 路径召回数量。 |
| `RAG_COMPARE_TOP_K_PER_DOC` | `3` | compare 路径每份文档保留证据数。 |
| `RAG_QUERY_DECOMPOSITION_ENABLED` | `true` | 是否把复杂问题拆成多个 evidence requirements。 |
| `RAG_HYBRID_ENABLED` | `false` | 是否启用 dense + sparse fusion。 |
| `RAG_HYBRID_FUSION` | `weighted` | `weighted` 或 `rrf`。 |
| `RAG_RERANK_ENABLED` | `false` | 是否启用 rerank。 |
| `RAG_RERANK_PROVIDER` | `heuristic` | `heuristic`、`cross-encoder` 或代码内注入的 `custom` provider。 |
| `RAG_CROSS_ENCODER_ENDPOINT` | 空 | `RAG_RERANK_PROVIDER=cross-encoder` 时调用的 HTTP endpoint。 |
| `RAG_MIN_RELEVANCE_SCORE` | `0.32` | 置信度门控最低相关分。 |
| `RAG_MIN_QUERY_TERM_COVERAGE` | `0.51` | query term coverage 门槛。 |
| `RAG_NEAR_DUPLICATE_GUARD_ENABLED` | `true` | 近重复且无冲突时避免编造差异。 |
| `RAG_OBSERVABILITY_ENABLED` | `false` | 是否写入 RAG JSONL trace。 |
| `API_AUTH_ENABLED` | `false` | 是否启用 API token 鉴权。 |
| `API_AUTH_TOKEN` | 空 | 单用户/本地开发鉴权 token。 |
| `API_AUTH_TOKENS` | 空 | 多用户 token 映射，JSON object 或 array。 |
| `REACT_APP_API_AUTH_TOKEN` | 空 | 前端通过 `x-api-key` 发送的 token。 |
| `FEEDBACK_DIRECTORY` | `server/data/feedback` | 答案反馈 JSONL 存储目录。 |
| `STARTUP_HEALTH_STRICT` | `false` | 健康检查失败时是否阻止启动。 |

多人部署时优先使用 `API_AUTH_TOKENS`，让 token 映射到独立用户和工作区：

```env
API_AUTH_ENABLED=true
API_AUTH_TOKENS={"alice-token":{"userId":"alice","workspaceId":"workspace-a"},"bob-token":{"userId":"bob","workspaceId":"workspace-b"}}
```

启用带 `userId/workspaceId` 的 token 后，上传文档会保存 owner/workspace 元数据；后续 `/documents`、`/chat`、删除和 PDF 文件流都会按访问范围过滤。

## 质量与评测

项目把 Node 自定义评测作为主回归，因为它能覆盖实际产品行为：是否该拒答、页级引用是否命中、compare 是否覆盖多文档、答案关键片段是否出现、上传恢复是否成功。`ragas` 只作为语义相关性和 grounding 的补充观察。

### 当前追踪报告

| 报告 | 结果摘要 |
| --- | --- |
| `evaluation/results/latest.*` | Synthetic near-duplicate corpus：overall pass rate `1.0`，QA page hit rate `1.0`，compare doc coverage `1.0`，abstain accuracy `1.0`。 |
| `evaluation/results/latest-trajectory.*` | AgentRAG trajectory eval：`5/5` cases passed，`20/20` checks passed。 |
| `evaluation/results/latest-rerank.*` | Near-duplicate rerank eval：baseline 已满分，heuristic rerank 无额外 lift。 |
| `evaluation/results/arxiv-rerank-sweep-latest.*` | arXiv real-paper quick sweep 当前最佳 variant 为 `broad_topk`，NDCG `0.5831`，Recall `0.8177`，MRR `0.5891`。 |
| `evaluation/results/compare-hard-ragas.*` | Ragas supplement：faithfulness `0.8939`，context precision `1.0`，compare rubric `0.9333`。 |

说明：`latest.*` synthetic 报告来自 near-duplicate corpus，报告内 run id 为 `2026-04-21T20-42-35-142Z`；rerank 和 trajectory 报告来自 2026-06-09 到 2026-06-10 的开发进度。

### Synthetic regression

```bash
cd server
npm run eval:synthetic
npm run eval:synthetic -- evaluation/synthetic-corpus-near-duplicate.json
npm run eval:synthetic -- evaluation/synthetic-corpus-compare-hard.json
```

默认报告写入 `server/evaluation/results/latest.json` 和 `.md`。质量门控读取该报告，并在存在 feedback / trajectory 报告时一起检查。

### Trajectory eval

Trajectory eval 检查 AgentRAG 行为，而不是只看答案文本：

- skill / chain 是否选对
- 证据不足时是否 follow-up
- 该澄清时是否 clarification
- custom skill 是否传递 `accessScope`
- budget 是否阻止无限重试

```bash
cd server
npm run eval:trajectory
npm run quality:gate
```

### Coverage gate

后端 coverage gate 使用 Node 内置 test coverage，并按职责分组。默认命令执行所有后端测试文件，排除聚合入口 `run.test.mjs`，并检查当前可稳定执行的 minimum gate：

```bash
cd server
npm run coverage:gate
```

目标阈值分组：

| 分组 | 目标 |
| --- | --- |
| RAG / AgentRAG core | line 95%+, branch 80%+, funcs 90%+ |
| Rerank / retrieval | line 95%+, branch 85%+, funcs 95%+ |
| API routes | line 85%+, branch 70%+, funcs 85%+ |
| DB / OpenAI / CLI scripts | line 70%+, branch 70%+, funcs 70%，report-only，不硬拦 |
| Global backend | line 85%+, branch 75%+, funcs 90%+ |

如需把目标阈值作为硬门控运行：

```bash
cd server
npm run coverage:targets
```

### Feedback regression

用户反馈中的负样本可以转成回归语料：

```bash
cd server
npm run feedback:corpus
npm run eval:feedback
```

`feedback:corpus` 默认读取 `server/data/feedback/feedback.jsonl`，收集 `citation_error`、`incomplete` 和 `hallucination` 三类负反馈。`quality:gate` 会读取 `latest-feedback.json`；如果 feedback eval 有失败 case 或 unsupported claim，gate 会失败，并按 `skillId@skillVersion` 汇总问题。

### Rerank ranking eval

离线 rerank eval 只评估候选 chunk 排序，不调用回答生成模型。默认使用 near-duplicate corpus 的 `expectedEvidence` 作为页级相关性标注，并用确定性 embedding 生成可复跑结果：

```bash
cd server
npm run eval:rerank
```

指定语料和输出名：

```bash
cd server
npm run eval:rerank -- evaluation/synthetic-corpus-compare-hard.json --latest-name compare-hard-rerank
npm run eval:rerank -- evaluation/synthetic-corpus-rerank-hard-cs.json --latest-name rerank-hard-cs
npm run eval:rerank -- evaluation/generated/arxiv-corpus.json --embedding-provider openai --rerank-provider heuristic --latest-name arxiv-openai-rerank
npm run eval:rerank -- evaluation/generated/arxiv-corpus.json --rerank-provider cross-encoder --cross-encoder-endpoint http://localhost:8081/rerank --latest-name arxiv-cross-encoder-rerank
```

报告包含 baseline 粗排与 rerank 后的 `NDCG@k`、`Precision@k`、`Recall@k`、`MRR`、`Noise rate@k` 和排序提升率。

### arXiv real-paper corpus

真实论文 rerank 评测采用固定 manifest，避免每次评测实时搜索导致语料漂移：

```bash
cd server
npm run corpus:arxiv
npm run eval:rerank -- evaluation/generated/arxiv-corpus.json --latest-name arxiv-rerank
```

当前 manifest 固定 8 篇计算机方向论文：RAG、DPR、ColBERT、HNSW、Transformer、ReAct、Toolformer、Self-RAG。当前 seed 包含 16 个标注 case，覆盖精确问答、hard negative 和跨论文比较。

批量 sweep：

```bash
cd server
npm run eval:rerank:sweep
npm run eval:rerank:sweep -- --profile full
npm run eval:rerank:sweep -- --include-openai
npm run eval:rerank:sweep -- --include-openai --include-cross-encoder
```

本地神经 cross-encoder reranker：

```bash
cd server
npm run rerank:cross-encoder:setup
npm run rerank:cross-encoder
```

默认监听 `http://127.0.0.1:8081/rerank`，实现 `RAG_RERANK_PROVIDER=cross-encoder` 所需的 `POST /rerank` 协议。只想验证 HTTP 协议链路时，可以运行：

```bash
cd server
npm run rerank:cross-encoder:local
```

### CI quality gate

GitHub Actions 的 `Quality Gate` workflow 会在 PR 和 `main` push 时执行：

1. `cd server && npm test`
2. `npm run eval:trajectory`
3. `npm run quality:gate -- --fail-on-warn`
4. 如果存在 `server/data/feedback/feedback.jsonl`，再运行 `npm run eval:feedback` 和一次 quality gate

提交前建议至少运行：

```bash
cd server
npm test
npm run eval:trajectory
npm run quality:gate
```

## API

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 返回 OpenAI、auth、vector store、PostgreSQL、long memory 等健康状态。 |
| `GET` | `/ready` | readiness check，整体异常时返回 `503`。 |
| `GET` | `/documents` | 列出当前访问范围内的持久化文档。 |
| `DELETE` | `/documents/:docId` | 删除单份文档及其向量索引。 |
| `POST` | `/documents/clear` | 清空工作区文档。 |
| `GET` | `/documents/:docId/file` | 以内联 PDF 方式流式返回文档，支持 range request。 |
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
│   │   ├── agent*.js            # Planner, run context, self-check, finalizer, trace, working memory
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
└── README.md
```

运行时和生成路径一般不需要手动编辑：

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

## 开发注意

- RAG 变更优先放在 `server/rag/`，路由/API 行为放在 `server/app.js`。
- Agent planner、run context、document loop、skill runners、observability、synthesis、finalization 已拆成独立模块；不要把这些细节重新堆回 `server/rag/agent.js`。
- 新增 custom skill 必须走白名单注册，并确认 `accessScope` 传递到文档读取和 RAG chat。
- `/chat` response shape 会被前端 trace UI、feedback metadata 和 evaluation 使用，改字段时需要同步测试。
- Working memory 是 run-scoped，不应写入长期记忆，除非用户明确要求。
- `VECTOR_STORE_PROVIDER=local` 适合小规模本地工作区；大规模语料建议切到 Qdrant。
- 不要提交 `server/.env`、私有 PDF、`server/data/`、上传会话文件、生成语料或 timestamped eval 结果。

## 当前限制

- Intent classifier 仍是轻量规则/权重模型，不是训练好的语义分类器。
- 多文档真实冲突场景需要 GPT-5 生成结构化比较，响应会比普通 QA 慢。
- local JSON vector store 适合本地和小规模语料，不适合大型长期知识库。
- arXiv corpus 目前是 rerank/排序评测语料，不等同于完整真实业务评测集。
- `ragas` 对 compare 的判断只能作为辅助，compare 正确性仍以自定义 harness 为主。

## 推荐下一步

- 增加 Docker Compose，把 PostgreSQL、可选 Qdrant 和 app 一次拉起。
- 为 README 增加真实 UI 截图或短 GIF。
- 扩充 real-corpus eval，加入更多真实合同、政策和论文 case。
- 把配置、评测和 AgentRAG skill 开发细节拆成 `docs/`，让 README 保持项目门面和快速入口。
