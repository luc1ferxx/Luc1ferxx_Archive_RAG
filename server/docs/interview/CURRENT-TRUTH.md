# 现状与数据

> 面试里说出口的每个数字都应该能在这里找到出处：是什么命令、在哪个版本、用什么模型跑出来的。数字更新时先更新这里，再改讲述稿和 FAQ。
>
> 模型说明：下面的"真实模型"指本地 Ollama 上的 `nomic-embed-text`（embedding）和 `qwen2.5:7b`（chat），不是 GPT 级模型，也不是生产流量。评测集较小，凡是没有标注"显著"的差异都不能说成"更好"。

## 1. 系统能做什么

- 上传 PDF，在选定文档、全部文档或整个工作区范围内提问，回答带页码、摘录和来源文件。
- 多文档对比：每份文档独立召回，逐文档绑定数值，识别"没有实质差异"的情况。
- 证据不足时补检索、请求澄清或明确拒答。
- 后台 Agent 任务、审批门、运行记录、崩溃后恢复。
- 以 MCP server 形式暴露给其它 Agent（`archive-mcp-server.js`），也可以无数据库单机运行。

## 2. Agent 架构要点（都能在代码里指出来）

| 设计 | 事实 | 位置 |
| --- | --- | --- |
| 模型只提议、运行时决定 | 意图规划器在白名单候选里选意图；执行规划器在白名单步骤里排序；权限、`docIds`、预算、审批、并发、重试上限都由运行时决定 | `rag/agent-intent-llm-adapter.js`、`rag/agent-llm-planner-adapter.js`、`rag/agent-execution-plan.js` |
| Typed DAG | 自定义 Skill 阶段由模型输出节点、依赖和输入绑定；校验器整图接受或整图拒绝；节点输入只能绑定请求字段或上游输出；上限 12 个节点、深度 5、并发 3 | `rag/agent-execution-graph.js`、`rag/agent-execution-graph-runner.js`、`rag/agent-dag-planner-adapter.js` |
| 有界重规划 | 最多 1 次，只能打补丁，同样经过校验器 | `rag/agent-replanner.js` |
| 自检与补检索 | 逐条 claim 核对引用支持；有缺口时补检索一轮，最多 3 条查询；finalizer 删除无证据内容 | `rag/agent-document-loop.js`、`rag/self-check/`、`rag/agent-finalizer.js` |
| 结构化输出 | 规划器调用发送按请求从白名单生成的 strict JSON Schema；自由文本和数组都有上限；校验器仍是最终裁决 | `rag/structured-output.js` |
| 持久化与恢复 | 运行、步骤、事件存在 PostgreSQL；guarded 图的 checkpoint 只能在节点边界续跑；认领、节点开始、完成都用运行版本号 CAS 防止旧 worker 重复执行；有副作用的步骤不会被自动重放 | `rag/agent-execution-graph-checkpoint.js`、`rag/agent-run-step-replay-safety.js`、`rag/agent-runs.js` |
| 预算 | 每次运行：文档 RAG 2 次、自定义 Skill 2 次、Web 搜索 1 次、trace 16 步 | `rag/agent-budget.js` |
| LLM 调用容错 | 带抖动的指数退避、遵守 `retry-after-ms` / `Retry-After`、可重试的超时、空响应重试一次、经模型注册表切换备用模型 | `rag/openai.js`、`rag/openai-client.js`、`rag/model-providers/` |
| 流式进度 | `POST /chat/stream` 以 SSE 推送每一步 trace 摘要，经校验的最终答案整体发送；不流式输出 token | `routes/chat.js`、`rag/agent-event-stream.js` |

默认配置：hybrid 检索（pgvector 余弦 + PostgreSQL 全文检索，RRF 融合），rerank 关闭，规划器用 LLM，typed DAG 灰度开关默认 `off`。

## 3. 实测数字

### 3.1 检索：伪 embedding 与真实 embedding

`npm run eval:retrieval-comparison`，8 篇 arXiv 论文、48 条用例，Top-5，报告版本 `f7f6690c`，工作区干净。

| 配置 | 伪 embedding（哈希词频）Recall@5 | 真实 embedding（nomic）Recall@5 |
| --- | --- | --- |
| dense | 0.625 | 0.654 |
| BM25 | 0.658 | 0.658 |
| hybrid RRF | 0.543 | **0.712** |
| hybrid + 启发式 rerank | 0.585 | 0.663 |

配对 bootstrap 95% 置信区间（真实 embedding）：

- 全量：hybrid 比 dense +0.057 [−0.031, +0.156]，比 BM25 +0.054 [−0.038, +0.149]，都**不显著**。
- tuning 子集：hybrid 比 BM25 Recall +0.097 [+0.021, +0.188]，**显著**。
- held-out 子集（预先指定的主指标）：没有任何一组差异显著。
- 启发式 rerank 比 hybrid：全量 −0.049 [−0.115, +0.014]，不显著，但三个子集里都没有带来提升。

能说的结论：hybrid 在真实 embedding 下数值最好、从不显著更差；48 条用例不足以证明它更好。伪 embedding 下的排序是错的，不能用来做架构决策。

### 3.2 端到端质量

`npm run verify:quality`（18 项检查：单文档问答的页码和数值、双文档对比的数值归属、完全相同文档的对照组、语料外问题拒答、跨进程读取）。

| 版本 | 结果 |
| --- | --- |
| 修复前 | 16/18，对比路径全部拒答 |
| `f7f6690c` 修复后 | **18/18**（真实模型），离线自测也是 18/18 |

原因和修复过程见 [NARRATIVE-CASES.md](NARRATIVE-CASES.md) 故事 1。注意：现在通过的对比答案来自引擎按证据拼出的模板，模型自己写的改写版本仍会被词法校验器拒绝。

### 3.3 规划器：结构化输出

`npm run eval:planner -- --provider real`（qwen2.5:7b），每组 5 轮，共 30 个用例、25 次 LLM 规划调用。

| 组别 | 用例通过 | LLM 规划降级 | 每轮耗时 |
| --- | --- | --- | --- |
| 改前 | 14/30（47%） | 14/25（56%） | 14.1s |
| 只修 prompt | 14/30（47%） | 15/25（60%） | 13.0s |
| 加 schema，不限长度 | 24/30（80%） | 4/25（16%） | 16.4s |
| `75628674` 最终版 | **24/30（80%）** | **2/25（8%）** | 14.2s |

改前的降级全是格式或越界错误：step 条件写错、输出了未选中的 step、DAG 输入绑定到不存在的请求字段。剩下的失败是规划选择问题（该先对比再做风险评估时只规划了对比），约束解码解决不了。

### 3.4 LLM 调用容错

`npm run eval:llm-resilience`，每个场景 24 次调用、并发 8、SLO 15 秒，三轮平均。改前 `75628674`，改后 `a2764083` 起。

| 场景 | 改前 | 改后 | 改后、无备用模型 |
| --- | --- | --- | --- |
| 429，精确 `retry-after-ms` | 79.2% | **100%** | 83.3% |
| 429，粗粒度 `Retry-After: 1` | 79.2% | **100%** | 94.4%（请求数从 2.63 降到 2.08） |
| 20% 请求挂起 | 87.5%，p95 15s | **100%，p95 3.4s** | 100% |
| 30% 空响应 | 62.5% | **91.7%** | 91.7% |
| 主模型宕机 | 0% | **100%** | 0% |

代价：限流场景 p95 从约 2.5 秒升到约 4.7 秒。评测里备用模型和主模型共用一个限流器，是 failover 的最坏情况。

### 3.5 工程基线（`99af0019`）

- 后端测试 1687 个，0 失败，2 个跳过（需要 PostgreSQL 的 pgvector 集成测试）。
- 前端测试 102 个全部通过，生产构建通过。
- 覆盖率门禁通过：后端全局行覆盖 91.3%，RAG/AgentRAG 核心 93.5%。

## 4. 边界（主动说，不要等被问）

- **模型**：只用本地 7B 模型验证过，没有 GPT 级模型或生产流量的数据；没有真实的单次查询成本数据。
- **评测规模**：检索 48 条、端到端 18 项检查，多数差异不显著。QASPER 导入脚本和 LLM 评审只有框架，还没跑过真实数据，评审也还没做人工校准。
- **校验器**：自检是词法规则，识别不了语义等价的改写，所以对比答案目前走模板兜底。
- **文档解析**：只读 PDF 文本层，没有 OCR、表格和版面解析；换行会把句子切断，导致模板答案出现半句话。
- **安全**：prompt 注入只有设计层防御（规划器看不到身份、范围由运行时决定、外部查询过滤），还没有对抗性测试集和攻击成功率数据。
- **架构**：V1 顺序链、V2 typed DAG、v3 统一图三代并存；v3 只在 shadow 模式下规划，执行阶段有测试但没接进生产路径。
- **流式输出**：后端 SSE 接口和前端 `streamChat` 已有，但聊天界面还没接上，也没有测试。

## 5. 复现

先 `ollama serve`，并 `ollama pull nomic-embed-text`、`ollama pull qwen2.5:7b`。

```bash
cd server
export OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://127.0.0.1:11434/v1
export OPENAI_EMBEDDING_MODEL=nomic-embed-text OPENAI_CHAT_MODEL=qwen2.5:7b RAG_EMBEDDING_DIMENSIONS=768
npm run eval:retrieval-comparison -- --embedding-provider openai --latest-name latest-retrieval-comparison-ollama
npm run verify:quality
npm run eval:planner -- --provider real
npm run eval:llm-resilience   # 不需要模型，用本地假服务注入故障
```

报告写在 `server/evaluation/results/`（已被 git 忽略）；想引用的数字要在干净工作区上重跑，报告头部会带提交号和 `dirty: false`。
