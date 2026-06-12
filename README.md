<div align="center">

# Luc1ferxx Archive RAG

**一个面向多 PDF 档案的可信文档智能体系统。**

上传文档，提出问题，获得带页级引用的回答；对比多份文档时保留文档边界；证据不足时让 AgentRAG 继续检索、澄清或降级回答，而不是硬编结论。

<p>
  <img alt="React 18" src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=111111" />
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-ESM-339933?logo=node.js&logoColor=ffffff" />
  <img alt="Express" src="https://img.shields.io/badge/Express-API-000000?logo=express&logoColor=ffffff" />
  <img alt="OpenAI" src="https://img.shields.io/badge/OpenAI-GPT--5-412991?logo=openai&logoColor=ffffff" />
  <img alt="Vector Store" src="https://img.shields.io/badge/Vector-local%20%7C%20Qdrant-ff4f00" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-persistence-4169E1?logo=postgresql&logoColor=ffffff" />
</p>

[快速启动](#快速启动) · [当前状态](#当前状态) · [核心设计](#核心设计) · [文档入口](#文档入口) · [常用命令](#常用命令)

</div>

## 这是什么

Luc1ferxx Archive RAG 是一个本地可运行的文档分析工作台，重点不是“让模型读 PDF”，而是让回答能被检查：

- 每个关键结论尽量回到 citation excerpt 和 PDF 页码。
- 多文档对比使用 per-document retrieval，避免某一份文档垄断检索结果。
- AgentRAG 会记录规划、skill 选择、检索 query、self-check、gap analysis、follow-up retrieval 和 finalizer。
- 证据不足时返回 clarification 或 evidence-limited answer。
- Synthetic eval、trajectory eval、feedback eval、rerank eval、coverage gate 和 CI quality gate 用来防止质量回退。

适合政策手册、合同、研究论文、知识库 PDF、归档资料等需要“有出处地回答”和“认真比较差异”的场景。

## 当前状态

| 方向 | 状态 |
| --- | --- |
| 工作台体验 | React 三栏式上传、PDF 预览、对话、citation 跳页和 Chat scope 控制已完成。 |
| 文档处理 | 直接上传和分片上传已完成，默认 2 MB 分片，支持断点续传。 |
| arXiv 导入 | 上传后基于本地 profile keyphrase 和 relevance check 推荐相关 arXiv 论文，用户勾选确认后按签名候选 token 下载，按 arXiv ID / PDF URL / title hash 去重并带 provenance 导入索引。 |
| 文档 RAG | Structured chunking、query decomposition、confidence gate、page citation 已接入。 |
| 多文档对比 | Per-document retrieval、证据对齐、近重复保护、结构化比较回答已接入。 |
| AgentRAG | Planner、白名单 skill chain、self-check、gap analysis、follow-up retrieval、finalizer 已完成初版。 |
| 可观测性 | `/chat` 返回 `agentTrace`、`agentObservability`、`agentWorkingMemory`；可写 JSONL trace。 |
| 评测与门控 | Synthetic、trajectory、feedback、rerank、coverage gate 和 GitHub Actions quality gate 已接入。 |
| 数据隔离 | API token 可绑定 `userId/workspaceId`，文档、chat、删除和文件访问按 scope 过滤。 |

## 核心设计

```mermaid
flowchart LR
  U["User question"] --> P["Agent planner"]
  P --> S["Skill or skill chain"]
  S --> R["Document retrieval"]
  R --> D["Draft answer with citations"]
  D --> C["Claim self-check"]
  C -->|supported| F["Finalizer"]
  C -->|gap found| G["Gap analysis"]
  G --> B["Budget guard"]
  B -->|retry| R2["Follow-up retrieval"]
  R2 --> C
  B -->|stop| Q["Clarification / evidence-limited answer"]
  F --> T["Trace, feedback, quality gate"]
  Q --> T
```

核心原则：

- **先规划再检索**：AgentRAG 先判断任务、文档数量、access scope 和是否需要 custom skill。
- **对比保留边界**：compare 请求按文档独立召回和 rerank，再做证据对齐。
- **答案要自检**：self-check 用 citation excerpt 检查数字、日期、专有名词和关键 claim。
- **失败要可解释**：回答会带 trace、working memory、unsupported claims 和 finalizer 删除记录。

更细的 AgentRAG 设计见 [docs/agent-rag.md](docs/agent-rag.md)。

## 快速启动

### 1. 安装依赖

```bash
npm install
cd server
npm install
cd ..
```

### 2. 准备环境变量

```bash
cp .env.example .env
cp server/.env.example server/.env
```

最小后端配置：

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

前端默认请求 `http://localhost:5001`：

```env
REACT_APP_DOMAIN=http://localhost:5001
REACT_APP_API_AUTH_TOKEN=
```

完整配置说明见 [docs/configuration.md](docs/configuration.md)。

### 3. 准备数据库

本机 PostgreSQL 可直接创建默认数据库：

```bash
createdb agentai
```

如果使用远程 PostgreSQL，把 `POSTGRES_DATABASE_URL` 指向你的实例即可。

### 4. 启动

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
| `npm run dev` | 同时启动前端和后端。 |
| `npm start` | 只启动 React 前端。 |
| `npm run server` | 从根目录启动 Express 后端。 |
| `npm run build` | 构建前端生产包。 |
| `CI=true npm test -- --watchAll=false` | 非 watch 模式运行前端测试。 |
| `cd server && npm test` | 运行后端聚合测试。 |
| `cd server && npm run coverage:gate` | 运行后端 coverage minimum gate。 |
| `cd server && npm run eval:synthetic` | 运行默认 synthetic RAG eval。 |
| `cd server && npm run eval:trajectory` | 评测 AgentRAG 执行轨迹。 |
| `cd server && npm run eval:planner` | 用 mock LLM provider 评测 execution planner 和 fallback。 |
| `cd server && npm run eval:rerank` | 运行离线 rerank ranking eval。 |
| `cd server && npm run quality:gate` | 检查主线、feedback、trajectory 和 planner 质量门控。 |

完整评测命令见 [docs/evaluation.md](docs/evaluation.md)。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [docs/configuration.md](docs/configuration.md) | 环境变量、auth、vector store、observability 配置。 |
| [docs/agent-rag.md](docs/agent-rag.md) | QA/compare 路径、AgentRAG loop、skills、trace 字段。 |
| [docs/evaluation.md](docs/evaluation.md) | Synthetic、trajectory、feedback、rerank、arXiv corpus、coverage 和 CI gate。 |
| [docs/development.md](docs/development.md) | API、目录结构、运行时路径、开发注意。 |

## API 概览

| 能力 | Endpoint |
| --- | --- |
| 健康检查 | `GET /health`, `GET /ready` |
| 文档管理 | `GET /documents`, `DELETE /documents/:docId`, `POST /documents/clear` |
| PDF 文件 | `GET /documents/:docId/file` |
| 分片上传 | `POST /upload/init`, `GET /upload/status`, `POST /upload/chunk`, `POST /upload/complete` |
| 直接上传 | `POST /upload` |
| 问答 | `GET /chat`, `POST /chat` |
| 会话和长期记忆 | `DELETE /sessions/:sessionId`, `GET/POST/DELETE /memory` |
| 反馈和质量 | `GET/POST /feedback`, `GET/POST /quality/*` |

完整 API 说明见 [docs/development.md](docs/development.md#api)。

## 仓库结构

```text
.
├── src/               # React frontend
├── server/
│   ├── app.js         # Express routes
│   ├── rag/           # RAG + AgentRAG pipeline
│   ├── evaluation/    # Evaluation and benchmark scripts
│   └── test/          # Backend tests
├── docs/              # Project docs
└── README.md
```

## 当前限制

- Intent classifier 仍是轻量规则/权重模型。
- 多文档真实冲突场景会比普通 QA 慢。
- Local JSON vector store 适合本地和小规模语料，大规模语料建议切到 Qdrant。
- arXiv corpus 目前主要服务 rerank/排序评测，不等同于完整真实业务评测集。
- `ragas` 对 compare 的判断只能作为辅助，compare 正确性仍以自定义 harness 为主。
