<div align="center">

# Luc1ferxx Archive RAG

**一个面向 PDF 档案的多文档 RAG 工作台：上传、问答、对比、引用预览、网页补充和评测，一套跑通。**

<p>
  <img alt="React 18" src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=111111" />
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-ESM-339933?logo=node.js&logoColor=ffffff" />
  <img alt="Express" src="https://img.shields.io/badge/Express-API-000000?logo=express&logoColor=ffffff" />
  <img alt="OpenAI" src="https://img.shields.io/badge/OpenAI-GPT--5-412991?logo=openai&logoColor=ffffff" />
  <img alt="Vector Store" src="https://img.shields.io/badge/Vector-local%20%7C%20Qdrant-ff4f00" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-persistence-4169E1?logo=postgresql&logoColor=ffffff" />
</p>

[功能亮点](#功能亮点) · [系统架构](#系统架构) · [快速启动](#快速启动) · [评测结果](#评测结果) · [API](#api)

</div>

## 项目定位

Luc1ferxx Archive RAG 不是普通的“上传 PDF 然后聊天”。它更像一个本地可运行的文档分析台：

- 问单份或多份 PDF，并返回可点开的页级引用。
- 对比多份文档时，不让某一份文档垄断检索结果。
- 同时给出“文档内答案”和“实时网页答案”，方便核对内外部信息。
- 用结构化 chunking、置信度门控、近重复保护和评测集，压低 RAG 在多文档对比里的幻觉风险。
- AgentRAG self-check 会做 claim-level citation support 检查；回答中的关键结论需要被 citation excerpt 支持，否则触发 retry 并在 trace/feedback/eval 中记录。

适合用来做政策手册、合同、研究报告、知识库 PDF、归档资料等需要“有出处地回答”和“认真比较差异”的场景。

## 功能亮点

| 能力 | 说明 |
| --- | --- |
| 多 PDF 工作区 | 支持一次上传多份 PDF，前端维护当前工作区、文档列表和页数统计。 |
| 可恢复分片上传 | 默认 2 MB 分片上传，断点续传状态落到 `server/upload-sessions/`。 |
| 文档问答 | 基于上传文档检索证据，回答时附带文件名、页码、chunk 和摘录。 |
| 公平多文档对比 | compare 路由使用 per-document retrieval，每份文档独立取证，避免全局 top-k 偏向单一文档。 |
| 引用页预览 | 点击 citation 后，右侧内嵌 PDF 预览直接定位到相关页。 |
| 网页补充答案 | Express API 并行调用本地 MCP search server，通过 SerpAPI 获取网页证据并生成单独 web answer。 |
| 会话记忆 | PostgreSQL 保存最近会话，用于改写追问里的“它”“上一份”“第二个”等指代。 |
| 长期偏好记忆 | 可选开启长期记忆，例如默认回答语言、回答详略偏好。 |
| 答案反馈闭环 | 每轮回答可标记有帮助、引用错误、答案不完整或疑似幻觉，后端按用户/工作区保存反馈样本。 |
| 检索可观测性 | 可选 JSONL trace，记录 retrieval、rerank、confidence、comparison diagnostics 和 source bundle。 |
| 评测体系 | Node synthetic/real eval 是主回归；`ragas` 作为语义与 grounding 补充评估。 |

## 产品界面

应用首屏就是工作台，不是落地页：

- 左侧：上传 PDF、查看相关文档、管理工作区文档。
- 中间：PDF 预览，点击引用后跳到对应页。
- 右侧：对话记录，展示 document answer、citations、gap plan 和 web answer。
- 底部：文本提问或 voice mode 语音提问。

## 系统架构

```mermaid
flowchart LR
  U["User"] --> UI["React 18 / Ant Design"]
  UI --> API["Express API"]

  API --> Upload["Resumable PDF upload"]
  API --> Chat["Chat endpoint"]
  API --> Health["Health / readiness"]

  Upload --> PDF["PDFLoader"]
  PDF --> Chunker["Structured chunker"]
  Chunker --> Embed["OpenAI embeddings"]
  Embed --> Vector["Local JSON vector store or Qdrant"]
  Upload --> PGDocs["PostgreSQL document store"]

  Chat --> Memory["Session memory / optional long memory"]
  Chat --> Router["QA or Compare router"]
  Router --> QA["Global retrieval for QA"]
  Router --> Compare["Per-document retrieval for compare"]
  QA --> Confidence["Confidence gate"]
  Compare --> Alignment["Evidence alignment + compare analysis"]
  Confidence --> Writer["GPT-5 grounded answer"]
  Alignment --> Writer

  Chat --> MCP["Local MCP search server"]
  MCP --> Web["SerpAPI web search"]
  Web --> WebWriter["GPT-5 web answer"]

  Writer --> UI
  WebWriter --> UI
```

## RAG 设计

### QA 路径

1. 将用户问题结合会话记忆改写成独立检索问题。
2. 对复杂问题拆分 evidence requirements，例如时间、生效范围、适用地区等分别检索。
3. 生成 query embedding。
4. 在选中文档内做全局检索，并合并原问题与拆分需求的证据。
5. 可选 hybrid dense + sparse fusion，融合方式支持 weighted score 或 RRF。
6. 可选 rerank，位置在 retrieval/hybrid 之后、confidence gate 之前；默认 heuristic，也支持 cross-encoder endpoint 或注入 custom provider。
7. 置信度门控过滤低相关或缺少 anchor coverage 的证据。
8. 使用证据包生成带引用的 grounded answer，并返回 evidence summary 解释检索数量、可用证据、文档覆盖和分数范围。

### Compare 路径

1. 通过轻量 intent classifier 识别显式对比、比较级问题、跨文档一致性等信号。
2. 对复杂比较问题拆分 evidence requirements。
3. 对每份文档分别检索 `RAG_COMPARE_TOP_K_PER_DOC` 条证据。
4. 对每份文档独立 rerank，避免强文档挤掉弱文档。
5. 对齐证据，分析 shared terms、近重复、数值差异和显式冲突。
6. 如果证据高度近似且无冲突，走 deterministic no-difference guard。
7. 否则生成结构化 comparison answer：Summary、Per document、Agreements、Differences、Gaps。

这套设计的重点是“对比要公平”。普通 RAG 的全局 top-k 很容易把所有证据都给到最匹配的一份文档，导致比较结果看似完整，实际漏掉其他文档。这里的 compare pipeline 从检索阶段就保留文档边界。

## 技术栈

| 层 | 技术 |
| --- | --- |
| Frontend | React 18, Create React App, Ant Design, axios, speech recognition, speak-tts |
| Backend | Node.js ESM, Express, multer, zod |
| RAG 基础设施 | LangChain PDFLoader, OpenAI embeddings, OpenAI chat model |
| 自定义 RAG | chunker, query router, retrievers, confidence gate, reranker, evidence aligner, comparison engine |
| Vector store | 默认 local JSON store；可切换 Qdrant |
| Sparse retrieval | 本地 BM25 sparse store；Qdrant provider 下使用 Qdrant sparse search |
| Persistence | PostgreSQL document bytes, session memory, optional long memory |
| Web answer | MCP stdio client/server + SerpAPI |
| Evaluation | Node custom harness, optional Python `ragas` |

## 快速启动

### 1. 准备环境

建议环境：

- Node.js 18+
- npm
- PostgreSQL，并准备一个可连接的数据库。
- OpenAI API key
- SerpAPI key，用于网页答案；只跑文档 RAG 时可以先不配，但 web answer 会不可用。
- Qdrant 可选，默认使用本地 JSON vector store。

### 2. 安装依赖

```bash
npm install
cd server
npm install
cd ..
```

### 3. 创建数据库

如果你本机已经安装 PostgreSQL，可以直接创建默认数据库：

```bash
createdb agentai
```

如果使用远程 PostgreSQL，跳过这一步，稍后把 `POSTGRES_DATABASE_URL` 指向你的实例即可。

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
RAG_QUERY_DECOMPOSITION_MAX_REQUIREMENTS=4
RAG_HYBRID_ENABLED=true
RAG_HYBRID_FUSION=rrf
RAG_RRF_K=60
RAG_RERANK_ENABLED=true
RAG_RERANK_PROVIDER=heuristic
RAG_RERANK_CANDIDATE_MULTIPLIER=3

STARTUP_HEALTH_STRICT=false
```

前端默认会请求 `http://localhost:5001`。如需改后端地址，修改根目录 `.env`：

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
| `cd server && npm test` | 运行后端测试入口。 |
| `cd server && npm run eval:synthetic` | 运行默认 synthetic RAG eval。 |
| `cd server && npm run feedback:corpus` | 从已收集的负反馈生成 synthetic 评测语料。 |
| `cd server && npm run eval:feedback` | 用反馈语料运行 synthetic eval，输出 `latest-feedback.*`。 |
| `cd server && npm run quality:gate` | 检查主线 synthetic regression；如果存在 `latest-feedback.json`，同时检查 feedback eval 并按 skill 汇总失败。 |
| `cd server && npm run eval:real -- evaluation/real-corpus.json` | 运行真实语料评测。 |
| `cd server && npm run eval:ragas -- --input evaluation/results/latest.json` | 对保存的 Node eval payload 运行 `ragas`。 |

说明：`server/test/run.test.mjs` 已纳入 `app.test.mjs`、`rag.test.mjs`、`answer-match.test.mjs`、`feedback-corpus.test.mjs`、`agent-skills.test.mjs`、`quality-report.test.mjs` 和 `claim-support.test.mjs`。

`ragas` 是可选 Python 评测，需要额外安装依赖：

```bash
cd server
python3 -m venv evaluation/.venv-ragas
evaluation/.venv-ragas/bin/python -m pip install -r evaluation/ragas-requirements.txt
cd ..
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
| `POSTGRES_DATABASE_URL` | 示例值 | 文档、会话记忆和长期记忆共用连接。 |
| `RAG_CHUNK_STRATEGY` | `structured` | `structured` 或 `simple`。 |
| `RAG_CHUNK_SIZE` | `900` | chunk 最大长度。 |
| `RAG_CHUNK_OVERLAP` | `180` | structured/simple chunk overlap。 |
| `RAG_HYBRID_ENABLED` | `false` | 是否启用 dense + sparse fusion。 |
| `RAG_HYBRID_FUSION` | `weighted` | hybrid 融合方式；`weighted` 使用分数加权，`rrf` 使用 Reciprocal Rank Fusion。 |
| `RAG_RRF_K` | `60` | RRF 平滑常数，值越小越强调榜单前排。 |
| `RAG_RERANK_ENABLED` | `false` | 是否启用 rerank；启用后会先召回 `topK * RAG_RERANK_CANDIDATE_MULTIPLIER` 个候选。 |
| `RAG_RERANK_PROVIDER` | `heuristic` | rerank provider；支持 `heuristic`、`cross-encoder` 和代码内注入的 `custom` provider。 |
| `RAG_RERANK_CANDIDATE_MULTIPLIER` | `3` | rerank 候选放大倍数。 |
| `RAG_RERANK_WEIGHT` | `0.6` | rerank 分数与粗排原始分数混合时的 rerank 权重。 |
| `RAG_CROSS_ENCODER_ENDPOINT` | 空 | `RAG_RERANK_PROVIDER=cross-encoder` 时调用的 HTTP endpoint，POST JSON：`query` 和 `texts`。 |
| `RAG_CROSS_ENCODER_MODEL` | 空 | 传给 cross-encoder endpoint 的可选模型名。 |
| `RAG_COMPARE_TOP_K_PER_DOC` | `3` | compare 路由中每份文档保留的证据数。 |
| `RAG_QUERY_DECOMPOSITION_ENABLED` | `true` | 是否把复杂问题拆成多个 evidence requirements 分别检索。 |
| `RAG_QUERY_DECOMPOSITION_MAX_REQUIREMENTS` | `4` | 单次问题最多拆出的 evidence requirements 数。 |
| `RAG_MIN_RELEVANCE_SCORE` | `0.32` | 置信度门控最低相关分。 |
| `RAG_MIN_QUERY_TERM_COVERAGE` | `0.51` | query term coverage 门槛。 |
| `RAG_NEAR_DUPLICATE_GUARD_ENABLED` | `true` | 近重复且无冲突时避免编造差异。 |
| `RAG_OBSERVABILITY_ENABLED` | `false` | 是否写入 RAG JSONL trace。 |
| `RAG_OBSERVABILITY_INCLUDE_CONTEXT` | `false` | trace 是否记录完整 chunk 文本。 |
| `API_AUTH_ENABLED` | `false` | 是否启用 API token 鉴权。 |
| `API_AUTH_TOKEN` | `change-me-for-local-dev` | 单用户/本地开发鉴权 token。 |
| `API_AUTH_TOKENS` | 空 | 多用户 token 映射，JSON object 或 array；配置后 token 可绑定 `userId` 和 `workspaceId`。 |
| `REACT_APP_API_AUTH_TOKEN` | 空 | 前端通过 `x-api-key` 发送的 token。 |
| `FEEDBACK_DIRECTORY` | `server/data/feedback` | 答案反馈 JSONL 存储目录。 |
| `STARTUP_HEALTH_STRICT` | `false` | 健康检查失败时是否阻止启动。 |

可观测性默认只保存 metadata、score、`excerptHash` 和短 preview。只有在本地调试且能接受完整 chunk 文本落盘时，才建议设置：

```env
RAG_OBSERVABILITY_INCLUDE_CONTEXT=true
```

## 评测结果

项目把 Node 自定义评测作为主回归，因为它能覆盖 RAG 产品真正关心的行为：是否该拒答、页级引用是否命中、compare 是否覆盖多文档、答案关键片段是否出现、上传恢复是否成功。

### Latest synthetic

当前追踪的 `latest.*` 来自 `evaluation/synthetic-corpus-near-duplicate.json`：

| 指标 | 结果 |
| --- | ---: |
| Overall pass rate | `1.0` |
| QA page hit rate | `1.0` |
| Compare doc coverage | `1.0` |
| Compare page hit rate | `1.0` |
| Abstain accuracy | `1.0` |
| Answer content hit rate | `1.0` |
| Upload resume success rate | `1.0` |
| Avg response time | `6254.63 ms` |
| Avg citation count | `1.63` |

### Hard compare

`evaluation/synthetic-corpus-compare-hard.json` 用来压测更难的多文档差异场景：

| 指标 | 结果 |
| --- | ---: |
| Overall pass rate | `1.0` |
| QA page hit rate | `1.0` |
| Compare doc coverage | `1.0` |
| Compare page hit rate | `1.0` |
| Abstain accuracy | `1.0` |
| Answer content hit rate | `1.0` |
| Upload resume success rate | `1.0` |
| Avg response time | `16158.75 ms` |
| Avg citation count | `1.88` |

### Feedback corpus

用户在答案下标记的负反馈可以转成回归评测语料，让线上/多人使用中发现的问题进入质量门控：

```bash
cd server
npm run feedback:corpus
npm run eval:feedback
```

`feedback:corpus` 默认读取 `server/data/feedback/feedback.jsonl`，只收集 `citation_error`、`incomplete` 和 `hallucination` 三类负反馈，输出到 `server/evaluation/generated/feedback-corpus.json`。`eval:feedback` 会先重建该语料，再运行 synthetic eval，并把最新报告写到 `server/evaluation/results/latest-feedback.json` 和 `server/evaluation/results/latest-feedback.md`，不会覆盖主线 `latest.*` 报告。

`quality:gate` 会读取已生成的 `latest-feedback.json`。如果 feedback eval 存在失败 case 或当前 eval 回答出现 unsupported claim，gate 会失败，并输出类似 `document_rag@1.0.0: 2 citation errors, 1 incomplete answer, 1 unsupported claim` 的 skill 级统计；如果还没有 feedback eval 报告，则 feedback gate 会标记为 skipped，不阻塞主线 synthetic regression gate。

如需从临时文件构建语料，可直接传入路径：

```bash
cd server
node evaluation/build-feedback-corpus.mjs --input /path/to/feedback.jsonl --output /path/to/feedback-corpus.json
```

### Ragas supplement

`ragas` 不替代自定义 compare harness，但适合补充观察语义相关性和 grounding：

| 报告 | Answer relevancy | Faithfulness | Context utilization | Context precision | Context recall | Compare rubric |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `latest-ragas.*` overall | `0.6171` | `0.8` | `1.0` | `1.0` | `0.8333` | `0.95` |
| `compare-hard-ragas.*` overall | `0.6658` | `0.8939` | `0.9286` | `1.0` | `0.8571` | `0.9333` |

### Chunking benchmark

结构化 chunking 是这个项目最明显的质量提升之一：

| Metric | Simple `900/0` | Structured `900/180` |
| --- | ---: | ---: |
| Overall pass rate | `0.5` | `1.0` |
| QA page hit rate | `0.3333` | `1.0` |
| Compare doc coverage | `0.3333` | `1.0` |
| Compare page hit rate | `0.3333` | `1.0` |
| Answer content hit rate | `0.3333` | `1.0` |
| Avg response time | `1310.63 ms` | `3649.63 ms` |

结论很直接：structured chunker 更慢，但显著改善页级证据命中和多文档对比质量。

## API

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 返回 OpenAI、auth、vector store、PostgreSQL、long memory 等健康状态。 |
| `GET` | `/ready` | readiness check，整体异常时返回 `503`。 |
| `GET` | `/documents` | 列出当前持久化文档。 |
| `DELETE` | `/documents/:docId` | 删除单份文档及其向量索引。 |
| `POST` | `/documents/clear` | 清空工作区文档。 |
| `GET` | `/documents/:docId/file` | 以内联 PDF 方式流式返回文档，支持 range request。 |
| `POST` | `/upload/init` | 初始化分片上传会话。 |
| `GET` | `/upload/status` | 查询分片上传进度。 |
| `POST` | `/upload/chunk` | 上传单个文件分片。 |
| `POST` | `/upload/complete` | 合并分片、解析 PDF、写入索引。 |
| `POST` | `/upload` | 旧版直接上传接口，限制 50 MB。 |
| `GET` / `POST` | `/chat` | 对选中文档提问，返回 `ragAnswer`、`ragSources`、`mcpAnswer` 等。 |
| `DELETE` | `/sessions/:sessionId` | 清理指定会话记忆。 |
| `GET` | `/memory` | 查询长期记忆。 |
| `POST` | `/memory` | 写入长期记忆。 |
| `DELETE` | `/memory/:memoryId` | 删除单条长期记忆。 |
| `DELETE` | `/memory` | 清空某用户长期记忆。 |
| `GET` | `/feedback` | 查询当前用户/工作区最近答案反馈。 |
| `POST` | `/feedback` | 保存当前回答的反馈类型、备注、答案摘要和引用摘要。 |

只有 `/health` 和 `/ready` 是公开健康检查；文档列表、上传、chat、memory、quality 和 `/documents/:docId/file` 在 `API_AUTH_ENABLED=true` 时都需要 `x-api-key` 或 `Authorization: Bearer <token>`。

多人部署时优先使用 `API_AUTH_TOKENS`，让 token 映射到独立用户和工作区：

```env
API_AUTH_ENABLED=true
API_AUTH_TOKENS={"alice-token":{"userId":"alice","workspaceId":"workspace-a"},"bob-token":{"userId":"bob","workspaceId":"workspace-b"}}
```

上传的文档会保存当前 token 对应的 `userId/workspaceId`，后续 `/documents`、`/chat`、删除和 PDF 文件流都会按该访问范围过滤。
启用带 `userId/workspaceId` 的 token 后，旧的无访问范围文档不会出现在 scoped 用户视图中；需要重新上传或通过迁移补齐 owner/workspace 元数据。

## AgentRAG skills

AgentRAG 的工具能力通过 `server/rag/skills/registry.js` 注册。当前内置 skills 包括 `document_rag`、`web_search`、`inventory`、`document_discovery` 和 `research_brief`。`server/rag/agent.js` 仍负责确定性 planner、budget、self-check 和 synthesis，具体工具执行由 registry 选择。

每个 skill 都需要稳定的 `id`、`version`、`label`、`match()` 和 `execute()`；涉及文档或工作区数据时必须接收并传递 `accessScope`。`/chat` 响应会返回 `agentSkills`，反馈记录和 feedback corpus 会保留 `skillId/skillVersion`，方便把负反馈定位到具体能力版本。

Document RAG 的 self-check 会把回答拆成 claims，用 citation excerpts 做规则匹配；数字、日期和 code-like anchors 必须能在引用里对齐。未被支持的 claim 会进入 `agentTrace[].detail.claimSupport`，并随反馈样本进入 feedback eval。

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
│   ├── rag/                     # Custom RAG pipeline
│   │   ├── chunker.js
│   │   ├── query-router.js
│   │   ├── skills/              # AgentRAG skill registry and built-ins
│   │   ├── retrievers/
│   │   ├── confidence.js
│   │   ├── evidence-aligner.js
│   │   ├── comparison-engine.js
│   │   └── answer-writer.js
│   ├── evaluation/              # Synthetic, real-corpus, ragas evaluation
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

## 运行注意

- `VECTOR_STORE_PROVIDER=local` 会把 dense vector index 写到 `server/data/rag/vector-index.json`。
- 本地 sparse index 写到 `server/data/rag/sparse-index.json`。
- PDF 原始字节持久化在 PostgreSQL 的 document table 中，上传目录里的临时合并文件会在 ingest 后清理。
- `STARTUP_HEALTH_STRICT=false` 只表示健康检查报错时不主动阻止启动；当前文档和会话存储初始化、上传、会话记忆仍依赖可用的 PostgreSQL。
- `RAG_LONG_MEMORY_ENABLED=false` 时长期记忆 API 会返回空或 no-op；会话记忆仍用于追问改写。
- 不要提交 `server/.env`、私有 PDF、`server/data/` 或上传会话文件。

## 当前限制

- intent classifier 仍是轻量规则/权重模型，不是训练好的语义分类器。
- 多文档真实冲突场景需要 GPT-5 生成结构化比较，响应会比普通 QA 慢。
- local JSON vector store 适合小规模本地工作区；大规模语料建议切到 Qdrant。
- 真实文档评测需要自行准备 `evaluation/real-corpus.json`。
- `ragas` 对 compare 的判断只能作为辅助，compare 正确性仍以自定义 harness 为主。

## 推荐下一步

- 加一个 Docker Compose，把 PostgreSQL、可选 Qdrant 和 app 一次拉起。
- 在 README 增加真实 UI 截图或短 GIF。
