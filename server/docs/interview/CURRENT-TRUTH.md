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
| Typed DAG | 自定义 Skill 阶段由模型输出节点、依赖和输入绑定；校验器整图接受或整图拒绝；节点输入只能绑定请求字段或上游输出；上限 12 个节点、深度 5、并发 3；默认预算（自定义 Skill 2 次）下实际最多 2 个 custom 节点：规划器看到的节点上限被压到预算内，模型提议的图超出预算就整图拒绝，换成确定性图；确定性图在规划时不按调用预算拒绝，执行器在每个节点启动时预留预算，付不起的节点跳过。这张图是自定义 Skill 唯一的执行方式：V1 顺序链 2026-11-13 已删除，整张图被拒时不执行任何 Skill、逐个记录原因（见 3.49） | `rag/agent-execution-graph.js`、`rag/agent-execution-graph-runner.js`、`rag/langgraph/run-execution-graph.js`、`rag/agent-dag-planner-adapter.js` |
| 有界重规划 | 最多 1 次，只能打补丁，同样经过校验器 | `rag/agent-replanner.js` |
| 自检与补检索 | 逐条 claim 核对引用支持；有缺口时补检索一轮，最多 3 条查询；finalizer 删除无证据内容 | `rag/agent-document-loop.js`、`rag/self-check/`、`rag/agent-finalizer.js` |
| 结构化输出 | 规划器调用发送按请求从白名单生成的 strict JSON Schema；自由文本和数组都有上限；校验器仍是最终裁决 | `rag/structured-output.js` |
| 持久化与恢复 | 运行、步骤、事件存在 PostgreSQL；custom-Skill 图的 checkpoint 是权威，只能在节点边界续跑，启动时自动续跑只剩一种情形，续跑的是整张图：外层计划恰好只有 `custom_skills` 一个阶段的 custom-Skill 图；在途节点转人工，没有图可续的 run 也都转人工，步骤不单独重放（以前还有两种，都删了：没有图 checkpoint 的 `custom_skill` 步骤整步重放，只有 V1 顺序链存下的 run 走得到，2026-11-13 阶段 9 删除，见 3.50；v3 统一图的 guarded run，2026-11-14 阶段 10 随 v3 统一图删除，已存的 v3 run 没结束的交给人、只能取消，见 3.51）；人在恢复面板上只能重试失败步骤或取消，哪类步骤能重试由重放安全矩阵按步骤类型登记，`custom_skill` 不能；LangGraph 线程只作次要记录写在同一个 run 行里（启动恢复时拿线程和 checkpoint 对账是 v3 才有的一步，随它删了）；认领、节点开始、完成和线程写都用运行版本号 CAS，挡住旧 worker 的状态写（挡不住它已经发出的副作用）；有副作用的步骤不会被自动重放，Capability 的审批门绑定审批对象哈希，批准后的写入带幂等键（图内审批还绑定图摘要、幂等键按 run + 节点，那是 v3 统一图的路径，现在没有生产调用方，下一步删，见 3.51）；取消走 drain，不把请求 signal 交给 LangGraph | `rag/agent-execution-graph-checkpoint.js`、`rag/agent-run-recovery.js`、`rag/agent-run-step-replay-safety.js`、`rag/agent-runs.js`、`rag/agent-removed-unified-graph.js`、`rag/langgraph/checkpointer.js`、`rag/langgraph/drain-bridge.js` |
| 预算 | 每次运行两层：次数（文档 RAG 2 次、自定义 Skill 2 次、Web 搜索 1 次、trace 16 步），以及用量（默认 10 万 token、0.5 美元、5 分钟）。用量按每次成功的模型调用计量，用完后下一个工具被跳过、运行降级而不报错；已开始的步骤会跑完，所以是软截止 | `rag/agent-budget.js`、`rag/run-usage.js` |
| LLM 调用容错 | 带抖动的指数退避、遵守 `retry-after-ms` / `Retry-After`、可重试的超时、空响应重试一次、经模型注册表切换备用模型；每个模型端点有并发上限（默认 8）和熔断器（连续 5 次不可用错误熔断 30 秒，429 不计）；多实例部署时二者和评审缓存可放进 Redis 共享（Lua 脚本原子更新，名额和探测都是租约，Redis 挂了退回进程内） | `rag/openai.js`、`rag/openai-client.js`、`rag/model-call-guard.js`、`rag/model-providers/` |
| 可观测性 | OpenTelemetry trace，遵循 GenAI 语义约定：一次运行一个 `invoke_agent` span，规划器、每个 Skill（`execute_tool`）、每次模型调用（`chat` / `embeddings`，带 token 和估算成本）逐层嵌套；步骤是 span 事件；不记录问题、prompt、输出和文档内容。默认关闭；OTLP 导出默认 protobuf（Phoenix 只收 protobuf），也能接 Langfuse。响应里的 `traceId` 和 span 上的 `agent.run.id` 互相可查 | `rag/tracing.js`、`otel.js` |
| Claim 校验 | 默认词法规则；可选 LLM 评审只复核被词法拒绝的 claim，只能升级不能降级，引用错误、证据中没有的数字、对比答案不送评审，失败时保留词法结论；结论缓存 | `rag/self-check/`、`rag/self-check/claim-judge.js` |
| Prompt 版本 | 14 个 prompt、24 个钉住的模板版本（`id@version`；2026-11-14 按代码数的，阶段 10 删掉 `unified_graph_planner@v1` 之后），每个模板有 `id@version#fingerprint`（模板原文的哈希）。每次模型调用带上它，进入 LLMOps 事件、模型 span、每次运行的 prompt 清单、LLM 规划器的决策和每份评测报告；测试把每个版本钉到 fingerprint，改模板不改版本号会失败；发布门要求所有发布报告用同一组 prompt | `rag/prompt-registry.js`、`rag/prompt-catalog.js`、`test/prompt-registry.test.mjs` |
| 提示注入防护 | 文档、文件名、网页结果进 prompt 前做确定性筛查（对 AI 说话的句子替换成标记，中英文都覆盖）；答案、网页回答、claim 评审的 prompt 写明证据是不可信数据；输出链接守卫删掉图片和模型没见过的链接。规划器本来就看不到文档正文 | `rag/prompt-injection-screen.js`、`evaluation/prompt-injection-cases.js` |
| 租户隔离 | 应用层每个 store 按 user/workspace 过滤；PostgreSQL 行级安全再兜一层：鉴权后的中间件把访问范围放进 `AsyncLocalStorage`，带范围的语句在短事务里 `SET LOCAL ROLE` 到租户角色并设置租户变量，17 张表（再加每个 live 索引版本的分块表和 BM25 统计表）的策略拒绝其他租户的行。后台任务和恢复以记录自己的范围执行；迁移用 owner 登录；进程级缓存加载、跨租户恢复扫描显式标成 system 工作，默认仍以 owner 登录执行，开角色拆分时切到 NOLOGIN 的 system 角色（迁移 035）。strict 上下文和角色拆分都是可选项，默认关（见 3.32） | `db/migrations/013_enable_tenant_row_level_security.sql`、`rag/postgres.js`、`rag/postgres-tenant.js`、`health.js`（`getRowLevelSecurityTables`） |
| 流式进度与草稿 | `POST /chat/stream` 以 SSE 推送每一步 trace 摘要；主文档答案按 token 生成，但只推送通过 finalizer 同一套 claim 校验的整句（草稿），原始 token 不出服务器；最终答案整体发送并替换草稿。聊天界面已接上 | `routes/chat.js`、`rag/langgraph/agent-stream.js`、`rag/agent-event-stream.js`、`rag/answer-drafts.js`、`src/components/ChatComponent.jsx` |

默认配置：hybrid 检索（pgvector 余弦 + PostgreSQL 全文检索匹配、Okapi BM25 打分，加权 RRF 融合：稠密 0.65、稀疏 0.35，k=60），rerank 关闭，规划器用 LLM，自定义 Skill 阶段只由 typed DAG 执行（V1 顺序链 2026-11-13 已删除；`AGENT_SKILL_GRAPH_ROLLOUT` 不再选择任何东西，只接受未设置、空值或 `guarded`，见 3.49）。回答一个请求只有外层执行计划这一种方式：v3 统一图（把整个请求规划成一张图，默认一直是 `off`）2026-11-14 已删除，`AGENT_UNIFIED_GRAPH_ROLLOUT` 不再选择任何东西，只接受未设置、空值或 `off`，见 3.51。

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

**放大到外部标注的 QASPER**（2026-09-25，281 篇论文，821 个可回答问题，按段落算 Top-5，nomic）：稠密 0.511、BM25 0.442、hybrid 0.517、hybrid + 启发式 rerank 0.510。hybrid 比 BM25 +0.074 [+0.048, +0.102]，**显著**；比稠密 +0.006 [−0.019, +0.031]，**不显著**；rerank 仍然没有帮助。所以面试里只能说"hybrid 比单用 BM25 好"，不能说"比稠密好"。

**embedding 任务前缀**（2026-09-26）：nomic-embed-text 官方要求查询加 `search_query: `、文档加 `search_document: `，之前没加。用 `eval:qasper-retrieval` 按问答路径逐题测证据段落是否进入候选（先 train 400 题决定，再 dev 821 题确认）：

- dev 上证据进入全部候选：0.648 → **0.692**，配对 +0.044 [+0.021, +0.067]；
- 第 1 名 +0.029，前 3 名 +0.033，都显著。

所以 nomic 默认加前缀。前缀属于索引标识，旧索引必须重建：pgvector 会直接报错，local 和 Qdrant 对旧分块不给向量分。另外修了 `vector:reindex`：以前表里有别的模型写的分块时，它连自己提示的修复都执行不了。

同一个评测还说明，**更大的损失在门控**：69% 的证据在候选里，默认门控只放行 24%。所以答案层面基本没变：同一组 200 题的 F1 0.231 → 0.235，配对 +0.004 [−0.013, +0.019]，不显著。面试里要说清楚：检索召回显著提高了，但端到端的收益被门控挡住了。

**门控：判定和上下文分开**（2026-09-26）：门控仍决定整道题答不答，但决定要答之后，模型看到的上下文补上其余候选段落，最多补到 `RAG_RETRIEVAL_TOP_K` 条（当时是 6，2026-10-29 起是 10，见 3.37）；近邻替换的段落不补。

- dev 821 题：证据进入模型上下文从 0.245 升到 **0.353**，配对 +0.108 [+0.088, +0.130]。
- 同一组 200 题：
  - 官方 F1 0.235 → **0.249**，配对 +0.014 [−0.000, +0.029]，下限贴 0，不说"显著"；
  - 作答时模型上下文里有证据段落：0.44 → 0.60，显著（2026-10-04 更正：以前写成"答案来源里有证据"，实际统计的是喂给模型的全部上下文，不是答案引用的来源，见 3.23）；
  - 拒答完全不变。
- `verify:quality` 18/18。
- 和本轮开始前比（加前缀之前）：F1 0.231 → 0.249。

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

并发上限与熔断（同一评测，三轮平均；改前 `d5623593`，改后加 `rag/model-call-guard.js`）：

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| 主模型宕机，有备用模型 | 每次调用 5.00 个请求，p50 2.6s | **1.33 个请求，p50 24ms** |
| 主模型宕机，无备用模型 | 等 2.6s 后失败 | **立即失败（<1ms）** |
| 自托管服务饱和（2 个工作线程，16 个并发调用方） | 1.42 个请求/调用，p95 5.2s，服务端峰值排队 16 | **1.00，p95 3.2s，峰值排队 8** |

成功率在这三个场景都没变：重试本来就能兜住，改进的是延迟和对故障端点、过载服务的无效请求。其他场景在噪声内不变，40% 返回 503 的场景没有误熔断。饱和场景是为这次改动新加的，改前改后跑的是同一份脚本。

### 3.5 执行器转正：typed DAG 设为默认

`AGENT_SKILL_GRAPH_ROLLOUT` 默认值从 `off` 改为 `guarded`。项目原有的 `rollout:readiness` 门禁要求真实 LLM 规划零降级、零 mock/real 分歧，它把两个决定绑在了一起：用哪个执行器（V1 链还是 DAG 运行时），以及由谁规划 DAG（LLM 还是确定性规划器）。LLM 规划失败时退回的是确定性 DAG，不是 V1 链，所以执行器转正只需要执行语义的证据：

（这一节是 2026-09-25 的记录，没有改写。2026-11-13 阶段 8 删除了 V1 顺序链和 `off`、`shadow` 两个取值，这个开关不再选择任何东西，见 3.49；下面"执行器 `off`"那一行现在跑不出来。表里轨迹评测的 17 个用例、71 项检查是当时的套件，和阶段 8 之后的 17 个、76 项不是同一套：中间加到过 19 个、84 项，阶段 8 删掉了两个。2026-11-14 阶段 10 又随 v3 统一图删掉两个，现在是 15 个、63 项，见 3.51。）

（表里恢复评测的 29 项检查也是当时的数字。2026-11-13 阶段 9 去掉了两项，现在是 8 个用例、27 项检查，见 3.50。）

| 证据 | 结果 |
| --- | --- |
| 后端全量测试（新默认值） | 1693 通过，0 失败，2 跳过（需要 PostgreSQL） |
| PostgreSQL 集成测试（一次性集群，PG 18.6 + pgvector 0.8.6） | 15/15，其中 5 个是图恢复的跨进程与 CAS 竞争测试 |
| 轨迹评测 | 17/17 用例，71/71 检查；合同审查用例确认真的走 DAG（下游收到类型化上游输出） |
| 恢复评测 | 8/8 用例，29/29 检查 |

真实模型规划器（qwen2.5:7b，各 5 轮，和 3.3 的最终版对比）：

| 组别 | 用例通过 | LLM 规划降级 | 每轮耗时 |
| --- | --- | --- | --- |
| 执行器 `off`（3.3 最终版） | 24/30 | 2/25 | 14.2s |
| 执行器 `guarded`（默认） | 27/30 | 0/25 | 14.2s |

- 差异在抽样噪声内：改前的 3 个失败里 2 个是 LLM 输出的 JSON 本身写错，和执行器无关，不能说成"变好了"。
- 行为变化的风险点：`guarded` 下执行规划器能看到已授权的原子 Skill，理论上可能给普通问答多加 `custom_skills` 阶段。文档问答用例里这个阶段是合法选项，5/5 都没有被加上。
- 没变的：动态组合用例（只选了对比，要求 LLM 规划出"对比 → 风险审查"）仍是 2/5，失败是规划选择问题：两次只规划了对比，一次选了时间线抽取并按文档拆成两个节点。所以纯 LLM 规划的 `rollout:readiness` 在 7B 上仍达不到，这不影响执行器默认值。

### 3.6 一条真实 trace

`npm run trace:demo -- --real`（qwen2.5:7b，本地 Ollama），一次两个 Skill 的合同审查。规划器在这个演示里是确定性的，所以只有两次模型调用：

```
invoke_agent archive_rag  5840ms  mode=skill_chain usage.tokens=740 usage.model_calls=2
  agent.plan intent  2ms
  agent.plan execution  0ms
  agent.plan skill_graph  1ms  graph.node_count=2
  execute_tool summarize_contract  3913ms
    chat qwen2.5:7b  3912ms  usage.input_tokens=171 usage.output_tokens=123 token_source=actual
  execute_tool risk_review  1860ms
    chat qwen2.5:7b  1859ms  usage.input_tokens=358 usage.output_tokens=88 token_source=actual
```

能看出的东西：延迟几乎全在模型调用上，编排本身是毫秒级；第一次调用可能包含模型加载时间；第二个 Skill 的输入 token 多了一倍，因为它带着上游输出（类型化的 `priorFindings`）。单次 trace 不是性能基准。`mode=skill_chain` 是响应里 `agentMode` 的取值，这个名字还在用，不是指 2026-11-13 删除的 V1 顺序链：这条 trace 里两个 Skill 是图的两个节点（`graph.node_count=2`）。

### 3.7 校验过的答案草稿

`npm run eval:answer-drafts`（qwen2.5:7b，确定性规划器）：合同和政策 7 题里 1 题产生草稿，草稿保留在最终答案里，比最终答案只早 7 毫秒（答案只有一句）；论文 12 题 0 题产生草稿。6/7 和 11/12 的最终答案是澄清。结论：流式本身工作正常，瓶颈是词法校验器，详见 `docs/evaluation.md`。

校验器 bug 修复后（`npm run eval:answer-drafts`，各 3 轮）：合同和政策题 2/21 → 4/21 得到回答，有草稿的运行 2 → 4 次，草稿全部保留；论文题不变。`verify:quality` 仍 18/18。

### 3.8 数据库行级安全

`npm run eval:tenant-isolation`（2026-09-25，PostgreSQL 18.6 + pgvector 0.8.6，本机一次性数据库，owner 是只有 `CREATEROLE` 的非超级用户）：20 个租户、10000 个切块，以其中一个租户身份执行。`off` 就是改动之前的连接路径。

| 探测 | 改前（off） | 改后（enforce） |
| --- | --- | --- |
| 漏写过滤条件的查询，泄露其他租户数据的表 | 9/9（9728 行） | **0/9（0 行）** |
| 被接受的越权写或越权读（伪造插入、upsert 抢占、跨租户更新、跨租户删除、store 拿错 scope） | 5/5 | **0/5** |
| 每条语句 p50 延迟 | 0.10–0.31 ms | 0.25–0.56 ms（+0.15–0.25 ms，多了 3 次往返；这是流水线优化之前的数字，2026-09-27 起单条租户语句一次往返，见 3.15 的"每次 `/chat` 的数据库往返"） |

- 查询计划两种模式都走索引，没有退化成顺序扫描。
- “off 下 9/9”量化的是这层防护能兜住的 bug 类型；现有 store 都带过滤条件，不代表现在就有泄露。
- 做的过程中发现并修掉的问题：进程级文档 registry 如果在租户请求里首次加载，会只装进这个租户的文档，现在改为以 owner 身份加载；multer 的内存存储会丢掉异步上下文，分片上传路由在 multer 之后重新绑定租户。
- 正确性：`test/postgres-row-level-security.integration.test.mjs` 9 个用例；PostgreSQL 集成测试共 24/24（当时的数字；这个套件后来加了会话记忆、审计、反馈、注册表等用例，最近一次全量见 3.32）。

### 3.9 Prompt 版本与归因

2026-09-25，本地 qwen2.5:7b，真实规划器评测一轮加答案草稿评测（打开 claim 评审）：35 个 completion 事件全部能归到具体模板，改前是 0 个（它们只能按 model route 分组，`chat.default` 一个桶里混着 QA 回答、claim 评审和问题改写 3 个 prompt）。按模板分组后能直接看出：QA 回答占 completion token 的 44%，claim 评审占 21%。样本小，只说明能归因，不是性能数据。详见 `docs/evaluation.md` 的“Prompt 模板归因”。

### 3.10 提示注入红队

`npm run eval:prompt-injection`（2026-09-25，qwen2.5:7b，每组 3 轮）：13 个攻击用例，7 类（指令覆盖、控制符、篡改事实、外泄链接、钓鱼链接、系统提示词泄露、直接注入），另有 4 个对照组。

| | 改前 | 只有 prompt 规则 + 链接守卫 | 三层全开 |
| --- | --- | --- | --- |
| 文档 RAG 答案（MCP 原样返回）：攻击进入答案 | 17/39 | 12/39 | **0/39** |
| 受攻击时仍给出正确事实 | 22/30 | 23/30 | **30/30** |
| 对照组正确 | 9/12 | 9/12 | 9/12 |
| Agent 路径：攻击进入答案 | 4/39 | 6/39 | **0/39** |

- 只加 prompt 规则，指令覆盖类仍 9/9；起决定作用的是确定性筛查。筛查在 16,001 句良性语料上误判 0 句。
- 刻意绕开模式的英文改写，改前改后都是 3/3 成功，这是已知盲区。
- claim 评审在注入证据下错误接受 0/18，改前也是 0/18，没测出漏洞。
- Agent 路径用 7B 模型时大多以澄清结束，它的 0/39 很大程度上是答案被扣下了，不能单独拿来说防护有效。

### 3.11 多实例共享状态

`npm run eval:shared-state`（2026-09-25，4 个实例进程，本机 Redis）：主模型宕机时，打到坏模型的请求从 21 次降到 8 次，p95 从 1.3 秒降到 0.46 秒；自托管服务饱和时，SLO 内成功率从 29.2% 升到 100%，服务端峰值排队从 42 降到 8，每次调用的请求数从 1.71 降到 1.00。第一版有启动竞态：连接建立前的请求全部退回进程内，结果和不共享一样；这是评测抓出来的。

### 3.12 QASPER 答案（外部标注，不用 LLM 评审）

`npm run eval:qasper-answers -- --cases 200`（qwen2.5:7b，文档 RAG 答案，就是 MCP 返回的那个）：官方答案 F1 0.206。可回答题拒答 41.7%，拒答精度只有 18.5%，不可回答题识别率 85%。给出的答案中位数 54 个词，只看回答了的题 F1 0.168。两个问题：置信度门控太严（检索 Recall@5 有 0.51，却拒了四成可回答题），以及答案太长，被 token F1 扣分。

**用 train 调门控、用 dev 验证的结果：默认值不改。**

- 门控里真正起作用的只有查询词覆盖下限，它区分可回答和不可回答的能力很弱（AUC 约 0.6），调它只是在两种错误之间交换。
- 把问答下限从 0.51 降到 0.2：dev 上拒答从 41.7% 降到 7.2%，但不可回答题的识别率从 85% 降到 15%，官方 F1 从 0.206 降到 0.153（配对区间 [−0.101, −0.009]，显著变差）。另外会有 5 个"相邻话题"行为测试翻转，比如问育儿假却拿年假条款回答。
- 所以只把问答和对比的阈值拆开，留给措辞多变的部署自己调。真正该改的是答案长度，以及区分"关键词缺失"和"只是换了说法"的信号。

面试里这是一个"调参的结论是不调"的例子：数据和回归测试都不支持改默认值。

**答案变短（qa_answer v2.2）**：QA prompt 从"最多五句"改成"先用最少的词给出直接答案，最多再补两句"。同一组 200 题：官方 F1 从 0.206 升到 **0.231**（配对 +0.025 [+0.013, +0.037]，显著），作答的答案中位数从 55 词降到 33 词，拒答不变，`verify:quality` 仍是 18/18。

**两段式拒答（`RAG_QA_ANSWER_VERDICT`，做了、测了，默认关闭）**：先用词面信号"近邻替换否决"把"讲的是相邻的东西"（问育儿假、段落讲年假）和"换了说法"分开，再让答案模型用 `NOT_IN_EVIDENCE:` 自己判断证据够不够。

- **离线测量**：只看"问题里的词在文中出现与否"的信号，AUC 都在 0.59–0.61。QASPER 的不可回答题大多是"论文没报告这个细节"，这是词面信号的天花板；近邻替换否决在 QASPER 上只决定 1–3% 的题。
- **同一组 dev 200 题**（qwen2.5:7b）：
  - 总 F1 0.231 → 0.242，配对 +0.010 [−0.027, +0.048]，不显著；
  - 门控误拒的可回答题从 75 降到 24；
  - 模型又拒了 69 题，其中只有 30% 的上下文里真有证据，所以可回答题拒答反而 +10 个百分点（显著）；
  - 作答题 F1 +0.065、作答时上下文里有证据的比例 0.42 → 0.67，都显著（同样是上下文指标，不是引用，见 3.23）。
- **结论**：7B 模型判的是"检索到的上下文里有没有答案"，瓶颈在检索召回。
- **扩大检索重试**：模型说"没有"后，检索到第 18 名，拿模型没看过的段落再答一次。
  - 上一轮被模型拒掉的 73 题中，28 题这次作答了，可回答题的拒答率回到 41.1%（基线 41.7%）。
  - 总 F1 0.247，配对 +0.015 [−0.026, +0.056]，不显著。
  - 作答时上下文里有证据：+0.18，显著（上下文指标，见 3.23）。
  - 打开开关时 `verify:quality` 18/18。
  - 但不可回答题识别从 85% 降到 70%，代价 0.467 高于基线 0.421。按事先定的三条规则，仍默认关闭，默认行为完全不变。

面试里这是第二个"测了、没上默认"的例子。先定位原因：模型拒答主要是检索没召回。再针对它做重试，把拒答率拉回基线。最后按事先定的规则判断，不可回答题识别变差，所以不采用。整个过程没有改标准。

### 3.14a 交叉编码器重排（2026-09-26）

- 模型用 BAAI/bge-reranker-v2-m3：从 18 个融合候选里重排出 6 个，混合权重 0.6。权重在 train 上选定。默认 topK 改为 10 后是 30 选 10，权重和概率门槛没在新值上重测。
- dev 检索（821 题）：证据进入模型上下文 0.353 → **0.417**，配对 +0.063 [+0.044, +0.085]。
- dev 答案（同一组 200 题）：
  - F1 0.249 → 0.257，+0.008，不显著；
  - 可回答题被拒答 42.2% → **37.8%**，−4.4 个百分点 [−7.7, −1.7]，显著；
  - 不可回答题识别不变（80%）。
- `verify:quality` 18/18。
- 需要单独的模型服务，所以作为推荐配置，不默认打开。服务挂了查询退回融合排序。
- 面试里的说法：交叉编码器单独给出的第 1 名并不比融合排序好，收益来自"更深的候选 + 重排"，而且第一次在不牺牲拒答准确性的前提下降低了拒答率。

### 3.14b 重排概率做拒答门控（2026-09-26）

- 开启交叉编码器重排后，"要不要回答"由重排模型的相关概率决定，不再看问题词覆盖率。
- train：
  - 重排概率的区分能力 AUC 0.641（词面 0.588）；
  - 在同样的拦截率下，放行的可回答题更多；
  - 按和词面门控调参相同的代价规则，选出阈值 0.02。
- dev（同一组 200 题）：
  - F1 0.257 → 0.261，不显著；
  - 可回答题被拒答 **37.8% → 13.9%**；
  - 但不可回答题的识别率 80% → 45%；
  - `verify:quality` 18/18。
- 事先定的规则都满足，所以开重排时默认用它；没开重排时行为不变。
- 面试里的说法：
  - 词面门控 AUC 只有 0.6，重排信号略好（0.64）；
  - 按规则选出的点更偏向"多答"，误拒大幅减少，但会多答错一些不可回答题；
  - 想更保守可以设 0.2，那一档在拦下率和放行率两边都优于词面门控。

### 3.14 版面解析、一键部署、真实模型 CI（2026-09-26）

- **Docling 版面解析**（`PDF_PARSER=docling`，接 docling-serve，默认仍用 pdf.js）：
  - 按阅读顺序输出多栏正文；
  - 表格每行写成"列名: 值"，多行表头会拼成列名；
  - 服务不可用时退回 pdf.js，健康检查会报错。
- **Docling 的效果**：30 篇 arXiv 论文、69 道"证据在表格里"的 QASPER 题：
  - F1 0.159 → 0.180，+0.020 [−0.011, +0.057]，不显著；对照组也没有变差；
  - pdf.js 其实也能抽出 91% 的表格答案原文，只是不带列名；
  - 解析耗时 350 秒对 1.4 秒。
  - 所以不改默认值。面试里的说法是"做了、测了、代价大且没有显著收益，所以作为可选项"。
- **一键部署**：`docker compose --profile app up -d --build`，一个镜像同时提供 API 和前端，和 pgvector 一起启动。本机实测：
  - 容器 healthy；
  - `/health` 各项都是 ok，包括行级安全；
  - 用 Docling 上传一篇论文并问表格里的数，答案正确（76.86）。
  - `--profile layout` 会加上 docling 服务，`--profile shared-state` 会加上 Redis。
- **真实模型 CI**：`real-model-eval.yml`，每周跑一次，也可手动触发。在 GitHub 的机器上用 Ollama 跑 `verify:quality` 和 QASPER 检索抽样（召回低于 0.6 就失败），不需要 API key。首次运行（2026-09-26，run 36229084695，约 63 分钟）通过：`verify:quality` 18/18，QASPER 候选召回 0.655，和本机测得的完全一致；10 道题的答案 F1 为 0.164，只作报告。

### 3.15 压测与规模（2026-09-26）

**API 压测**：`npm run eval:load-test:pgvector`。

- 环境：一次性 PostgreSQL 18.6 + pgvector 0.8.6，Apple M5 Pro；应用在子进程里启动；模型是假服务，按档位注入延迟；规划器是确定性的。
- 全程 0 个错误，每个回答都带引用。

| 场景（pgvector） | 结果 |
| --- | --- |
| `/chat`，模型 0 ms | 并发 1 时 p50 17 ms；吞吐停在约 91 req/s（并发 32 时 p50 347 ms）；每个请求约 12–13 ms 应用 CPU（claim 校验 memo 之前的数字；之后的数字见 3.24：行级安全路径、并发 32 约 239–258 req/s，每请求 CPU 4.6–4.9 ms；3.24 测于外层计划迁到 LangGraph 之前，之后每请求 CPU 约多 1 ms，没有重测，见 3.48） |
| `/chat`，模型 800 ms | 并发 16/32 时在途峰值正好是 8（`RAG_LLM_MAX_CONCURRENCY`）；吞吐约 9.9 req/s ≈ 8 / 0.8 s；并发 32 时 p50 3.2 s |
| `GET /documents` | 单实例、无租户，并发 32 约 12,500 req/s、p95 3.1 ms。pgvector 下每个请求先按租户重读一次文档表，这样别的实例上传或删除的文档能立即看到；同一租户的并发请求共用一次查询（每请求约 0.08 次）。多实例改动前只读内存，约 13,000 req/s |

面试里的说法：
- 单个 Node 进程的瓶颈是 CPU，约 90 req/s（2026-09-26 的数字；claim 校验 memo 之后行级安全路径、并发 32 约 239–258 req/s，见 3.24；外层计划迁到 LangGraph 之后每请求 CPU 约多 1 ms，吞吐没有重测，见 3.48）；
- 接真实模型后，容量由每个模型的并发上限决定，多出的请求排队；
- 生产默认的 LLM 规划器每个请求要多调 2 次模型，同样的上限下容量大约只有三分之一（按调用次数推算，没有实测）。

**多实例与异步入库**（2026-09-26，同一台机器、假模型；详见 `docs/evaluation.md` 的"多实例与异步入库"）：
- 多实例：`/chat` 1/2/4 个实例 88/161/240 req/s（2.72 倍，owner 路径）；按租户走行级安全时 1/4 个实例 79/201 req/s，当时每个 `/chat` 约 166 次数据库往返（后来降到 22 次，4 实例 283 req/s，见下）。4 实例时整机约 6.9 核，超过 5 个高性能核，扩展不到线性的一部分原因在机器。
- 统计信息：同一代码 4 实例，跑不跑 ANALYZE 是 230 对 185 req/s。
- Redis 共享的模型并发上限：整个集群严格 8 个在途，9.94 req/s = 8 / 0.8 s；不共享时是每进程 8 个、集群 32 个。
- 异步入库：PostgreSQL 任务表 + `FOR UPDATE SKIP LOCKED` + 租约和围栏 + `LISTEN/NOTIFY` 唤醒。64 篇并行度 8、3 次重复：从提交到入库完成 p50 同步 1,320 ms、异步 930–947 ms；独立 worker 吞吐 35.1 篇/秒，同步 24.9、进程内异步 23.2（后两者区间重叠）；上传请求从约 257 ms 变成几毫秒的 202。
- 两轮对抗审查找出并修掉的问题：第一轮测量设计无效（每个实例只收到一类问题、同步和异步并行度不同）；同步模式多实例互相看不到新文档（提问 404）；别的实例删除的文档在本实例仍可被问到；清空文档后刷新会"复活"文档；压测一直没走行级安全路径；重试时相信进程缓存会把没写进库的文档标为成功。

**每次 `/chat` 的数据库往返**（2026-09-27，详见 `docs/evaluation.md`）：`pg_stat_statements` 定位到两个来源——run 存储每个 `/chat` 回读 26 次（事件列表 15、run 行 11），每条租户语句单独一个 4 次往返的短事务。改成写入语句直接返回提交后的行和事件（请求内的 run cursor 只作 CAS 的乐观基准，冲突时照旧重读），租户设置和语句用扩展协议流水线一次往返发出。租户路径每个 `/chat` 往返 **167 → 22**，owner 路径 46 → 20；并发 32 吞吐租户 1 实例 +12.6%（受单进程 CPU 限制），**租户 4 实例 205 → 283 req/s（+37.9%）**，PostgreSQL 每请求 CPU 减半。审查找出并修掉：CAS 等锁期间并发追加的事件没出现在返回列表里（改为同一往返里先 `FOR NO KEY UPDATE`）、流水线失败时可能把处于事务中的连接放回连接池。面试里这是"先测量再优化"的例子：数字从压测报告的一个异常值（166 次往返）出发，用 `pg_stat_statements` 定位到具体语句。

**pgvector 规模**：`npm run bench:pgvector-scale`。一次性集群，走应用自己的迁移和检索代码，在行级安全 enforce 下以租户身份查询；合成的 768 维向量。

| 分块 | 总大小 | HNSW 构建 | 单文档 dense p95 | 100 篇 hybrid p95（热） | 100 篇首次读 p95 |
| --- | --- | --- | --- | --- | --- |
| 1 万 | 108 MB | 1 s | 0.89 ms | 11.6 ms | 1.4 ms |
| 10 万 | 1.1 GB | 10 s | 0.80 ms | 20.9 ms | 25.8 ms |
| 100 万 | 10.4 GB | 169 s | 0.91 ms | 21.2 ms | 111 ms |

面试里要说清楚的三点：
1. **100 篇文档的检索没有用 HNSW。** 10 万分块以上，优化器用 `doc_id` 索引取出 5,000 行再精确排序，所以 recall 为 1、延迟稳定在约 20 ms。这个 recall 说明的是精确检索，不说明 HNSW 索引的质量。
2. **HNSW 加过滤会少返回结果，已修。** 1 万分块、文档集占半张表时，优化器对带过滤的查询用了 HNSW：先取 `ef_search=40` 个近邻再按文档过滤，平均只返回 9.95/10 条，recall 0.994，最差一条只有 5/10。现在稠密检索每次查询都设置 `hnsw.iterative_scan=relaxed_order`，同一场景返回 10/10，recall 1.0（100 条查询全部检查），每次查询多 0.04–0.17 ms。10 万分块、文档集 1000 篇时，recall 0.898 → 0.912，在两次建图的波动范围内，不能算改进：剩下的损失来自 HNSW 近似本身，迭代扫描只解决"条数不够"的问题。
4. **行级安全让全文检索用不上 GIN，已修。** `@@` 不是 leakproof 函数，行级安全下不能当索引条件，租户查 1000 篇文档时要逐行解压 5 万个 `search_vector`，约 142 ms。迁移 014 加了一个以表所有者身份运行的排序函数：先以租户身份在文档表里过滤文档 id，函数用 GIN 找候选、打分，再以租户身份关联回分块表，由行级安全决定返回哪些行。10 万分块、1000 篇文档：sparse p50/p95 从 142/157 ms 降到 **19/58 ms**；1 万分块、100 篇：8.3 → 2.3 ms；全表时 p50 120 → 35 ms，p95 不变（常见词命中几乎所有行，只能逐行打分）；单文档不变。用户明确同意了"候选排序这一步绕过行级安全"的设计，三个方向的对抗审查找出并修掉了一个信息泄露通道（先截断后过滤会暴露别的租户的文档是否含某词）。面试里这是"行级安全与非 leakproof 运算符冲突"的真实案例。
3. **100 万分块时表放不进缓存。** 一个文档集的第一次读取 p95 为 111 ms，热缓存下是 20 ms。

审查时发现并修掉的测量问题：
- 过滤查询的 recall 原来只抽样 20 条，恰好没抽到少返回的那条，所以显示为 1；现在逐条检查。
- 原来总是 dense 系列先读冷数据、后面的系列白用缓存，所以 dense 在 100 万时显示 p95 104 ms，而 hybrid 只有 21 ms；现在首次读单独计时。
- 模型 0 ms 时的"在途峰值"是假服务同步回复造成的，没有意义，现在不显示。
- 事件循环延迟没有减去 10 ms 的采样间隔，现在减掉了。

### 3.51 LangGraph 迁移阶段 10：删除 v3 统一图（2026-11-14）

- **决定**：
  - 阶段 9（3.50）之后，agent 的每条路径都在 LangGraph 上，但回答一个请求还有两种方式。一种是默认的外层执行计划：文档、Web、内置 Skill、Capability 按固定顺序，custom Skill 阶段走图。另一种是开关 `AGENT_UNIFIED_GRAPH_ROLLOUT` 后面的 v3 统一图：把整个请求规划成一张图。v3 不是第二个运行时，是第二种回答方式；开关默认一直是 `off`，从来没有改成 `guarded`。
  - 用户先要方案（原话“先出方案”），看过清点结果和三个选项后选了方案 A（原话“按方案 A 做”）：删掉 v3 统一图，只留外层执行计划（ADR 0001“阶段 10 结果”）。
  - 理由三条：用户要 agent 只有一种回答请求的方式；让 v3 成为那一种，已有的数字不支持（见下面的清点）；把 v3 设成默认、留外层计划兜底，是两种方式同时在线上回答请求，和要求相反，所以没有列为选项。
  - 分两步做，这一节是第一步：删掉 v3 的入口、专属模块、开关、评测用例、测试和 golden。共用的图模块里只有 v3 用过的代码，这一步之后没有生产调用方，留到下一步删（见“留到下一步的”）。
  - 先冻结、再删除，在 main 的 21eae0c6 之上：冻结提交 0ce3d23c 把当时的行为写进测试，删除提交 9653dd60 删掉代码。
  - 没动的：外层执行计划、custom Skill 图和它的规划、执行器对 custom Skill 图的调度、启动恢复对 custom Skill 图的续跑、`/chat` 的响应契约、三个 planner 开关。
- **它做到过什么**（历史；经过和细节见 `docs/unified-agent-dag-migration.md`，当时的数字见 3.16、3.17）：
  - 整图准入：任何节点执行前对整图判定，被拒的请求原样交给外层执行计划。最重要的规则是数据边界：有外部副作用的节点只读用户自己的问题，文档派生的文本不会发给第三方搜索；外部节点的输出不进任何其他节点的输入，只进最终答案。
  - 外层固定顺序表达不了的编排：Skill 只在文档答案通过证据检查之后运行，并把已验证的答案作为类型化输入交给它。
  - 图内审批续跑：带审批门的 Capability 停在干净边界，批准或拒绝之后在同一张图上续跑，Capability 最多执行一次。
  - 跨进程恢复：共 7 个真实 PostgreSQL 上的跨进程用例。
  - 这些都有确定性测试，证据类型是注入提案加 mock：证明的是运行时契约，不是答案质量。
- **删除之前的清点**（在 main 的 21eae0c6 上数，脚本按静态 import 图计算）：
  - 只有 v3 走得到的代码：22 个文件、8,108 行（`server/rag` 下 17 个文件 6,599 行，评测 5 个文件 1,509 行）。另有 9 个共用文件 import 它们。
  - 入口：新请求进 v3 只有两处，都在 `rag/agent.js` 里、都在开关后面（`guarded` 执行，`shadow` 旁路规划）。开关是默认的 `off` 时，v3 的代码只在遇到已存的 v3 run 时运行，做的事是把它交给人。
  - 测试：17 个测试文件、138 个测试（其中跨进程的 PostgreSQL 文件本机跳过），44 份 golden（约 10.5 万行）。
  - 评测门：trajectory 17 个用例里 2 个（76 项检查里 13 项），planner 7 个用例里 1 个（27 项里 5 项），recovery 没有。
  - 反过来（让 v3 成为唯一方式）要付的：只有外层计划走得到的代码上限是 13 个文件、4,559 行，比 v3 少。v3 答不了六类请求，都要先补：research brief、arXiv 导入、没有常设授权的 Web 和文档发现、第二个审批门 Capability、不是意图本身动作的 Capability、外层计划所有的 run 的重入。
  - 已有的数字也不支持它：本地 7B 模型每次规划约 8 秒、自己的计划只被接受 3/15（3.17）；一次文档问答的 CPU 从约 1 ms 到 11–15 ms，带事件的写从 3 次到 10 次、另加 11 次无事件写（进程内微基准，内存 run store、mock RAG）；证据全是 mock，只证明编排契约。
- **新请求的变化**（按 `AGENT_UNIFIED_GRAPH_ROLLOUT` 的取值，四种）：
  - 未设置、`off`。之前：外层执行计划回答。现在：不变。
  - `shadow`。之前：外层执行计划回答，旁边规划一张 v3 图并记一条 `unified_graph_planned` 事件。现在：进程拒绝启动。
  - `guarded`。之前：通过准入的 v3 图回答整个请求，被拒的由外层执行计划回答。现在：进程拒绝启动。
  - 其他取值（例如拼错的 `gaurded`）。之前：当作 `off`。现在：进程拒绝启动。
  - “之前”由冻结提交写成字面期望（`server/test/agent-unified-graph-dial.test.mjs`）；这个文件在冻结提交和删除提交之间的 diff 就是上面四条。
- **已存的 v3 run 的变化**（只有开过 `guarded` 的部署才有这种 run；“之前”指删除之前、开关不是 `guarded` 时的处理）：
  - 启动恢复（`auto`），run 停在审批门、已批准但 Capability 没开始、在两个节点之间中断，或收据已写但 run 没完成。之前：转人工，原因 `unified_graph_rollout_not_guarded`。现在：转人工，原因 `unified_graph_removed`。
  - 启动恢复，节点步骤还在执行中。之前：转人工，原因 `unknown_in_flight_node`。现在：不变。
  - 启动恢复，图已 `partial` 而 run 还在跑。之前：转人工，原因 `graph_finalization_requires_recovery`。现在：转人工，原因 `unified_graph_removed`（独立复核之后补了夹具）。
  - 启动恢复，checkpoint 对不上账的其他情形（摘要不符、事件证明不了走过 guarded 路径）。之前：转人工，各有各的原因码。现在：转人工，原因 `unified_graph_removed`。这一条是读代码得出的，没有夹具。
  - 启动恢复，图被更早一次启动恢复领取过、之后没有落定（独立复核找出来的）。之前：跳过，`auto` 和 `manual` 两种模式都是；不进恢复列表，取消是 409，重入是 409，保留期清理也不删，永远停在 `running`。现在：转人工，原因 `unified_graph_removed`（`manual` 模式是 `server_startup_recovery`），之后可以取消。
  - 启动恢复，run 已经收尾成向用户提问。之前：`auto` 跳过，不动；`manual` 像所有在等的 run 一样列出。现在：不变。
  - 审批端点批准或拒绝停在门上的 run。之前：409 `unified_graph_rollout_not_guarded`，run 转人工。现在：409 `unified_graph_removed`，run 转人工；请求点名的不是这道门也一样，拒绝看的是 run，不看请求说的门。
  - 带 `agentRunId` 的请求重入停在门上的 run，带着这道门的决定（后台任务的批准或拒绝）。之前：409 `unified_graph_rollout_not_guarded`，run 转人工，任务 failed。现在：409 `unified_graph_removed`，run 转人工，任务 failed。
  - 同上，不带决定（后台任务的 `continue`）。之前：把待审批的内容原样再说一遍，什么都不写，任务继续等。现在：409 `unified_graph_removed`，run 转人工，任务 failed。
  - 同上，带的是别的门的决定。之前：409 `graph_approval_not_pending`，什么都不写。现在：409 `unified_graph_removed`，run 转人工。
  - 请求重入没结束的 run（中断的、被领取过的、图已 `partial` 而 run 还在跑的），不管有没有被标成人工恢复：之前和现在都是 409 `AGENT_GRAPH_EXECUTION_FENCED`，什么都不写。
  - 请求续接已完成的、图 `partial` 之后失败的、已提问的 run：之前和现在都是新建一个 run 回答，记 `run_continued`；新 run 现在由外层执行计划回答。
  - 请求续接失败或取消时图还在 `running` 阶段的 run（依赖故障、客户端断开、超过截止时间；独立复核找出来的）。之前：409 `AGENT_GRAPH_EXECUTION_FENCED`，每次都是，永远续不上。现在：新建一个 run 回答。
  - 请求续接被人取消的 run（独立复核找出来的）。之前：409（中断的是 `AGENT_GRAPH_EXECUTION_FENCED`，停在门上的是 `graph_approval_not_pending`）。现在：新建一个 run 回答。
  - 请求续接 `manual` 模式列出过的“向用户提问”（独立复核找出来的）。之前：409 `AGENT_GRAPH_EXECUTION_FENCED`。现在：新建一个 run 回答。
  - 审批端点批准或拒绝一个已经被取消的 run 上的门。现在：409 `AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY`，什么都不写。“之前”回哪个错误没有在接好审批续跑的代码上量过。
  - 重试一个 `graph_node` 步骤：之前和现在都是 409 `AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY`。
  - 人在恢复面板上能做的：之前和现在都只有取消，而且要等 run 被标成人工恢复之后。
  - 规则归成两条（`rag/agent-removed-unified-graph.js`）。已经收尾的：run 已结束（完成、失败、取消，不管当时图停在哪个阶段），或者已经收尾成向用户提问；这样的 run 不动，续接它的请求开一个新 run。没收尾的：续不了，启动恢复把它交给人，人只能取消；取消之后它就是已结束的。
  - 上面的 409 是进程内错误的 `code`。经 HTTP 返回时响应体只有 `{ "error": "<消息>" }`，没有 `code` 字段；`unified_graph_removed` 这个字符串对客户端只出现在 run 的 `result.recovery.reason` 和恢复列表里。
  - 已经收尾成向用户提问的 run 会一直停在 `waiting_for_user`：用户的回答开的是新 run；旧的那个在 `auto` 模式下不进恢复列表、不能取消，保留期清理只删已结束的 run，也不会删它。这是删除之前就有的行为，没有改。
  - 和开着 `guarded` 时相比，失去的是续跑本身：停在门上的 run 不能再批准或拒绝，中断的 run 不再自动续完，收据已写的 run 不再补完成。这些 run 都要人来取消。
  - 原因从好几个变成一个，是有意的：以前的原因码来自对 v2 checkpoint 的对账，对账代码下一步会删。保留 `unknown_in_flight_node`，因为它告诉人一件别的原因说不出的事：有一步可能已经写了东西。
  - “之前”同样由冻结提交写成字面期望（`server/test/agent-stored-unified-graph-runs.test.mjs`，服务是测试里手工接起来的，run store 是内存的；独立复核之后另加了一个经过建好的 app 走 HTTP 的测试），删除提交对这个文件的改动就是“现在”。测试里的 run 不是手造的：夹具 `test/fixtures/stored-unified-graph-runs.json` 是 21eae0c6 的 v3 代码在内存 run store 里写下的记录，8 种状态加一个停在门上的后台任务；独立复核之后又用同一份 v3 代码（冻结提交 0ce3d23c）补了 4 种状态，共 12 种。写夹具的脚本只存在于冻结提交里，随 v3 一起删了；v3 的代码不在了，这个测试照样能跑。
- **对自动续跑的影响**：启动时自动续跑只剩一种：外层计划恰好只有 `custom_skills` 一个阶段的 custom-Skill 图。3.50 里的第二种（走 guarded 路径的 v3 统一图）没有了：已存的 v3 run 不再续跑，没结束的交给人，人只能取消。
- **拒绝已删除的取值**：
  - `AGENT_UNIFIED_GRAPH_ROLLOUT` 进了 `rag/config.js` 的已删除开关表，是第四个（前三个是 `AGENT_RUNTIME`、`AGENT_OUTER_PLAN_RUNTIME`、`AGENT_SKILL_GRAPH_ROLLOUT`）。未设置、空、空白或 `off`（去首尾空白、不区分大小写）照常启动；其他任何值以 `AGENT_UNIFIED_GRAPH_ROLLOUT_REMOVED` 拒绝。
  - 它是四个里唯一一个“剩下的那个值就是默认值”的：从没开过 v3 的部署不需要改配置，`.env` 里照抄示例写着 `off` 的也照常启动。
  - 以前拼错的值会被当作 `off`，现在拒绝：写错的人要的是一个已经不存在的东西，照 `off` 回答等于不告诉他。
  - 检查位置和前三个开关相同：`server.js`、`startServiceRole`、`createAppServices`、外层计划入口、custom Skill stage、执行器。不建 app、直接调 `runAgentRag` 的评测 runner 在外层计划入口被拒：run 已经建了，以 failed 结束，没有读文档、没有规划、没有存图。在走到外层计划之前就结束的请求（例如直接向用户提问）碰不到这个检查，照常回答；经 `server.js` 或 `createAppServices` 起来的进程没有这种情况，它们根本起不来。
  - `eval:trajectory` 的 runner 以前把这个开关钉成 `off`，现在不钉了：环境里带着已删除的取值时，走到外层计划的用例都以 `case_error` 失败，而不是被 runner 盖住。
  - `AGENT_UNIFIED_GRAPH_CAPABILITIES`（v3 图可以直接调用的 Capability 白名单）不再读取，设了没有任何效果，也不拒绝。
  - `test/agent-runtime-removed.test.mjs` 按表驱动，加了第四个开关之后是 23 个测试（三个开关时是 19 个），包括真实执行 `node server.js` 的非 0 退出。
- **删了什么**：
  - `server/rag` 的 14 个模块：v3 的规划器和它的模型适配器与 prompt（`unified_graph_planner@v1`）、授权目录、准入规则、stage、结果与投影、答案与响应构建、文档循环状态重建、finalization 收据、恢复资格判断、shadow 观测、启动恢复的线程对账。
  - 入口和接线：`rag/agent.js` 的 guarded 和 shadow 分支、图内审批续跑、v2 checkpoint 的续跑分支；`app-services.js` 的统一图规划器适配器和审批续跑接线；`routes/chat.js` 的透传；配置里的两个读取函数。
  - 评测：两个 trajectory 用例、一个 planner 用例、`eval:unified-graph-planner` 脚本和它的 runner。
  - 测试：17 个测试文件、4 个测试支持文件、44 份 golden，以及规划器 golden 摘要里统一图规划器的 21 条。
  - 前端：聊天页不再处理“拒绝也带回一个答案”的响应（只有 v3 的图内拒绝会这样返回）。
  - 新增一个文件 `rag/agent-removed-unified-graph.js`（删除提交里 93 行，复核修正之后 136 行）：认出已存的 v3 run（看 checkpoint 版本），判断它是不是已经收尾，决定交给人时用什么原因，拒绝续跑。它不运行任何节点，也不决定任何审批门。
  - 代码量（删除提交相对冻结提交）：生产代码（`server/rag`、`app-services.js`、`routes`）+225 −6,717 行；评测 +14 −2,122 行；测试（不含 golden）+234 −12,069 行；golden −104,803 行。
- **留到下一步的**（还没做。这些代码只有 v3 用过，这一步之后没有生产调用方（任务级的 `deny` 例外），测试也大多随 v3 的套件删掉了）：
  - LangGraph 执行器里节点停在审批门（`interrupt()`）和在同一线程上续跑审批的部分，以及 `rag/langgraph/` 下的 `unified-graph-approval.js`、`unified-graph-resume.js`、`unified-graph-thread.js`（清点时数的 17 个文件里的 3 个，被共用的执行器 import）。
  - 图契约的 `v3` 版本、`graph_node` 步骤身份、`awaiting_approval` 状态、v2 checkpoint、`replayExecutionGraphRun`。
  - run store 的图审批门（暂停、决定、读取）和它的绑定校验。
  - `capabilities/graph-approval-preflight.js`、`capabilities/graph-contract.js`。
  - 任务级的 `deny` 动作：`POST /tasks/:taskId/actions/deny` 还接受它，所以它有调用方，只是不可能成功。它只对图审批门有效：对现在能产生的每一种门都回 409；对已存的图审批门，任务先入队、再以“已删除”失败。界面不发这个动作。
  - DAG 规划器适配器里为 v3 保留根字段的分支。
  - 在它们删掉之前，覆盖率里“RAG / AgentRAG core”一组的行覆盖从 96.13% 掉到 94.26%：低于这组 95% 的目标（报告里是 warn），高于 90% 的门槛（门通过）。掉的原因就是这些代码还在而测试没了。
- **评测套件的改动**（去掉的是随 v3 一起消失的用例）：
  - 套件 manifest 1.17.0 → 1.18.0。
  - `eval:trajectory`：17 → 15 个用例，76 → 63 项检查。删掉的是 `unified_graph_evidence_gated_skill_hand_off`（7 项）和 `unified_graph_approval_gated_action`（6 项），`unified_graph` 这个类别随之消失。
  - `eval:planner`：7 → 6 个用例，27 → 22 项检查。删掉的是 `planner_unified_graph`（5 项）。
  - `eval:recovery-observability`：不变，8 个用例、27 项检查。
  - prompt 目录少了 `unified_graph_planner@v1`，所以评测报告记录的 prompt 集合指纹变了（576a2ab93c4d → 93528afda45a），其余模板的指纹一个没变。trajectory 和 planner 报告的 `configHash` 也变了：它算的是用例 id 列表。
  - 之前各节（3.49、3.50）里的 trajectory 17 个用例、76 项检查，planner 7/7，manifest 1.17.0 是当时的数字，没有改写。
- **失去、且没有替代的**：
  - 两种编排。一是 Skill 只在文档答案通过证据检查之后运行，并拿到已验证的答案；外层计划里 Skill 先跑、无条件跑、不读文档答案。二是审批的任务内容来自已验证的文档答案；外层计划里来自原始问题。以后想要，得在外层计划里另做。
  - 图内审批：一张图停在审批门、决定之后在同一张图上续跑、Capability 恰好执行一次，以及它的 7 个跨进程 PostgreSQL 用例。外层计划的 Capability 审批还在，是另一条路径。
  - v3 的真实模型规划评测：和它 3/15 的结果一起成为历史记录（`docs/evaluation.md`）。
  - shadow 观测：不改变答案地看“这个请求 v3 会怎么规划”。
- **没有丢、换了地方测的**（两条规则原来只通过 v3 测到，但代码是外层计划和 custom Skill 图同样在用的）：
  - 会写工作区的 Capability 不被截止时间打断：规则在 Capability 注册表里，现在直接在注册表上测（`test/agent-cancellation.test.mjs`）。
  - 两个租户的图同时运行时，各自的租户、截止时间、事件流和用量到得了每一次 Skill 调用和每一次线程写入，互不串，而且 LangGraph 不发任何网络请求。原来测在 v3 图上（`langgraph-unified-graph`），现在测在 custom Skill 图上（`test/langgraph-request-context.test.mjs`）；把两个请求绑到同一个上下文上，这个测试会失败。
- **升级时已存的 run**：
  - 从没开过 `guarded` 的部署：库里没有 v3 run，升级没有任何要处理的。
  - 开过 `guarded` 的部署：升级前先把 `AGENT_UNIFIED_GRAPH_ROLLOUT` 去掉或改成 `off`，否则新版本拒绝启动。升级后第一次启动（`auto` 模式）会把没结束的 v3 run 交给人，已经结束的不动。想让停在审批门上的 run 得到决定，要在升级之前批准或拒绝。
  - 先停旧版本、再起新版本。新版本的启动恢复不看一个 v3 run 是不是还有旧版本的进程在跑：它会把旧进程正在执行的、连同旧进程的启动恢复正在续跑的（带 claim 的）v3 run 一起交给人。滚动发布、新旧版本同时在线没有测过，这一条是读代码得出的。
  - run 和 checkpoint 的格式没有变，没有数据迁移。
- **独立复核**（2026-11-14，只读；改动在复核修正提交 637593f3）：
  - 范围和做法：冻结和删除两个提交（21eae0c6..9653dd60）。它不跑测试套件、评测和覆盖率，只读代码和日志，加上内存 run store 上的六个探针：把删除之前的 `server` 解到仓库之外，同一个探针在两棵树上各跑一遍。
  - 结论：没有高级缺陷；默认配置下每个探针前后结果相同（七种请求的响应和落库的 run，十三种 custom Skill 图在启动恢复时的结果、事件和步骤）。问题在三处：夹具里没有的已存 v3 run 状态、比代码强的说法、随 v3 套件丢掉的测试。
  - 已存的 run，两条中级，都改了。一是被启动恢复领取过的 v3 run 没有人管：启动恢复看到 claim 就跳过，这一步排在“已删除的图交给人”之前；删除之前也是这样，删除之后没有进程能续跑它，就成了永久的。现在在它的 claim 下交给人。二是失败或取消时图还在 `running` 阶段的 v3 run 续不上：原来“已收尾”只认两种形状，这类 run 和人取消过的 run 每次续接都是 409。现在“已收尾”的规则是 run 已结束，或者已收尾成向用户提问。
  - 两条低级的一起改了：`manual` 模式列出过的“向用户提问”不再被围住；停在门上的拒绝不再对已结束的 run 生效。
  - 夹具从 8 种状态加到 12 种，`agent-stored-unified-graph-runs` 从 9 个测试到 12 个。五条规则各做过一次变异（去掉 `auto` 或 `manual` 分支里的 claim、把“已结束”收窄成“已完成”、让拒绝不跳过已结束的 run、让人工标记一律取消“提问”的资格），每一个都有测试失败。
  - 随 v3 套件丢掉、代码却还在用的测试，补了六个：自动续跑失败和续跑什么都没落定（`agent-run-recovery` 17 → 19）、校验器拒绝引用没有契约的 Skill 的输出（`agent-execution-graph` 46 → 47）、节点自己的输出契约检查（`agent-execution-graph-node` 16 → 17）、回放守卫拒绝没有终结事件的图之后的审批（`agent-run-step-executor` 22 → 23）、任务级 `deny` 对普通审批门回 409（`agent-tasks` 22 → 23）。
  - 比代码强的说法改了说法，上面各条已经是改过的：没收尾的 run“都交给人、人可以取消”、已失败的 run“算收尾”、带着已删除的取值“每个用例都失败”、原因只替换了一个、审批端点点名别的门、HTTP 返回错误码、测试“照 `app-services.js` 的接法”、留到下一步的代码“都没有生产调用方”。删除提交的说明不改，以 ADR 为准。
  - 没有改的一条：`evaluation/rollout-readiness-report.js` 只读 `AGENT_SKILL_GRAPH_ROLLOUT` 来判断环境起不起得来，不读新删的开关。它同样不读另外两个运行时开关，而带着被拒取值的环境本来就产不出它要读的运行时冒烟报告。
  - 复核顺带发现的两个老问题，默认配置，不在这次改动范围内，没有改。两个都和后台任务回到它暂停的 run 有关，各用一个探针在三棵树上复现过（现在的代码、21eae0c6、阶段 7 之前的 b8e4d2ed），结果相同。一是后台任务批准一个普通的 Capability 审批门会失败：Web 搜索执行一次，然后请求以 409 `AGENT_RUN_ACTIVE_STEP_CONFLICT` 失败，run 留在 `running`、门还是 pending；只在进程内复现，没有经过 HTTP，也没有用任务跑过；任务卡片上的 Approve 发的就是这个动作，聊天页走的 run 审批端点不受影响。二是重入一个带着 custom Skill 图 checkpoint 的 run 会被围住（409 `AGENT_GRAPH_EXECUTION_FENCED`），所以某一轮跑过 custom Skill 的任务很可能续不下去；后半句是读代码得出的。
  - 复核没能验证的：测试套件、评测和覆盖率（只读了日志）；PostgreSQL 上的 run store；真实执行 `node server.js` 的拒绝；前端测试；真实模型的规划器；滚动发布或多实例。
- **证据**（冻结提交 0ce3d23c，删除提交 9653dd60，本机 Node 24.21.0）：
  - 冻结：两个字面值测试文件在删除之前的代码上通过（13 个测试）。
  - 覆盖率闸门（`coverage:gate`）接一次性 PostgreSQL 18 + pgvector，在删除提交的干净 worktree 上：4,469 个测试，4,462 通过、7 跳过、0 失败；全局行覆盖 91.90%（门槛 78%、目标 85%，都通过）。阶段 9 是 4,607 个测试、92.53%。“RAG / AgentRAG core”一组 94.26%：过门槛 90%，没到目标 95%，原因见“留到下一步的”。
  - `quality:current` 按 CI 的 `quality-gate` 步骤在删除提交的干净 worktree 上运行：通过，八项检查全部 `pass`。
  - 三个确定性 agent 评测与 21eae0c6 比较（屏蔽 UUID、时间戳、耗时和 git 信息）：trajectory 共有的 15 个用例全部逐字节一致，少了两个 v3 用例；planner（mock）共有的 6 个用例全部逐字节一致，少了一个 v3 用例；recovery-observability 的用例和指标逐字节一致。用例之外的差异只有两处：prompt 集合（少一个模板，指纹随之变）和 trajectory、planner 的 `configHash`。
  - 不接数据库的全量：4,303 个测试，4,276 通过、27 跳过、0 失败。
  - 前端（`vitest run`）：28 个文件、242 个测试全部通过（少的 1 个是 v3 图内拒绝的那条），`vite build` 通过。
  - 单文件套件：`agent-stored-unified-graph-runs` 9/9、`agent-unified-graph-dial` 3/3、`agent-runtime-removed` 23/23、`agent-cancellation` 18/18、`langgraph-routes` 3/3、`langgraph-planner-model` 12/12、`agent-execution-graph-checkpoint` 32/32、`langgraph-request-context` 1/1（删除提交之后补的）。
  - 受影响的 22 个服务端测试文件另外用 Node 20.20.2 跑过（带上仓库 runner 预加载的 `keep-event-loop-alive.mjs`）：427 个测试全部通过。CI 用的是 Node 22，本机没有。
- **复核修正之后重跑**（复核修正提交 637593f3，本机 Node 24.21.0）：
  - 覆盖率闸门接一次性 PostgreSQL 18 + pgvector：4,479 个测试，4,472 通过、7 跳过、0 失败；全局行覆盖 91.92%。“RAG / AgentRAG core”一组 94.46%（复核之前 94.26%），仍是 warn，原因不变。
  - `quality:current` 按 CI 的 `quality-gate` 步骤：通过，八项检查全部 `pass`。
  - 三个确定性 agent 评测与 21eae0c6 的比较：和复核之前相同。
  - 不接数据库的全量：4,313 个测试，4,286 通过、27 跳过、0 失败。
- **没有验证的**：
  - 真实 PostgreSQL 上的已存 v3 run：夹具是内存 run store 的记录，跨进程用例随 v3 删了。
  - 真实浏览器。
  - 滚动发布、新旧版本同时在线。
  - CI 的 Node 22：合并之后看。
  - 存量数据里是否真有 v3 run。
- **回退**：没有开关能回到 v3，只能 `git revert` 删除提交 9653dd60。冻结提交里的两个测试文件会和 revert 之后的代码不一致，要一起 revert 到冻结时的内容。被新版本标成人工恢复的 run 不会因为 revert 而重新可以批准：审批的 CAS 拒绝已标人工的 run，这和删除之前把开关从 `guarded` 关掉再打开是同一个规则。
- **面试里的说法**：
  - 一句话：v3 统一图是我做出来、量过、然后删掉的第二种回答方式。它从来不是默认，开关一直是 `off`。
  - 被问“为什么删”：用户要 agent 只有一种回答请求的方式。不是性能优化，也不是 v3 出了故障。
  - 被问“为什么留下的是外层计划、不是 v3”：数字不支持 v3。本地 7B 模型的计划 15 次只被接受 3 次，每次规划约 8 秒；一次文档问答的 CPU 约 1 ms 对 11–15 ms（mock 微基准）；有六类请求它答不了，要先补；证据全是 mock，只证明编排契约。这些数字删除之前就有。
  - 被问“为什么不设成默认、留外层计划兜底”：那样两种方式同时在线上回答请求，和要求相反，所以没有列为选项。
  - 做法照顺序讲：先数（只有它走得到的代码 22 个文件、8,108 行，17 个测试文件、138 个测试，44 份 golden），带着数字出方案，由用户选；先冻结再删除，冻结的是调用真实服务代码（手工接线、内存 run store）的字面期望测试，删除提交对这两个文件的 diff 就是行为变了的地方；已存 run 的夹具是 v3 代码当时写下的记录，代码删了测试照样跑；原来只通过 v3 测到、代码却是共用的两条规则，换到注册表和 custom Skill 图上测。
  - 要主动说失去的：两种编排（证据检查通过之后才运行 Skill、审批内容来自已验证的答案）、图内审批和它的 7 个跨进程 PostgreSQL 用例、v3 的真实模型规划评测、shadow 观测。外层计划的 Capability 审批还在。
  - 要主动说没做完的：共用图模块里只有 v3 用过的代码还在，下一步删（除了任务级的 `deny`，接口还接受它、只是不可能成功，它们已经没有生产调用方）；在那之前“RAG / AgentRAG core”一组覆盖率是 94.46%，没到 95% 的目标，过了 90% 的门。没验证的：真实 PostgreSQL 上的已存 v3 run、真实浏览器。
  - 不要说“v3 失败了”，也不要说“删掉是优化”或“删掉之后行为没变”。能说的是：设计做出来了，运行时契约测过；删它是因为只要一种方式，而数字不支持它当那一种；开过 `guarded` 的部署里没结束的 v3 run 现在只能由人取消。
  - 被问“崩溃后哪些 run 能自动续跑”，现在答一种：外层计划恰好只有 `custom_skills` 一个阶段的 custom-Skill 图。3.50 的“两种”是阶段 9 当时的说法。
  - 评测现在的数：trajectory 15 个用例、63 项检查，planner 6 个、22 项，recovery 8 个、27 项。少的是随 v3 删掉的三个用例，共有的用例删除前后逐字节一致。

### 3.50 LangGraph 迁移阶段 9：custom Skill 步骤不再单独重放（2026-11-13）

- **决定**：
  - 阶段 8（3.49）把“只有旧 run 才走得到的重试和恢复代码”留了下来，并问了用户要不要删。用户的回答是“接着清理”（ADR 0001“阶段 9 结果”），这一阶段把它们删了。
  - 先冻结、再删除，在 main 的 a26eecd7 之上：冻结提交 7a2e3d99 把当时的行为写进测试，删除提交 be353b62 删掉代码，文档提交 264b1e5b，独立复核之后的修正提交 015f06a1。
- **规则**（四条）：
  - custom Skill 只作为图节点运行。`custom_skill` 步骤不能单独重试，启动时也不单独重放。
  - 启动恢复在 `auto` 模式下自己只做一件事：续跑中断的图（要先领到 claim）。其余中断的 run 交给人；照旧跳过、不改状态的有三种：已经标过人工恢复的 run、已被别的 worker 领取的图、停在审批门上的 v3 图。（阶段 10 删除 v3 统一图之后，第三种不再跳过：启动恢复把停在审批门上的 v3 run 交给人，原因 `unified_graph_removed`，见 3.51。）
  - 人在恢复面板上只有两个动作：重试失败步骤（`retry_failed_step`）和取消（`cancel`）。`resume_from_step` 不再是一个动作。
  - 重试按钮只在重放安全矩阵允许这类步骤重试时才给出，恢复面板和聊天答案里的 “Failed steps” 都一样。矩阵必须和步骤处理器一致：处理器一律拒绝的类型，矩阵不能列重试。矩阵现在允许重试的是四类：`document_rag`、`follow_up_retrieval`、`research_question`、审批绑定的 `capability_call`。
- **对自动续跑的影响**：启动时自动续跑的情形从三种变成两种：外层计划恰好只有 `custom_skills` 一个阶段的 guarded custom-Skill 图，和走 guarded 路径的 v3 统一图。第三种（没有图 checkpoint 的 `custom_skill` 步骤整步重放）没有了。（阶段 10 之后只剩前一种：v3 统一图 2026-11-14 已删除，见 3.51。）
- **为什么这些代码只有旧 run 走得到**（从代码读出来的，没有线上数据）：
  - 独立处理器只接不带 `nodeId` 的 `custom_skill` 步骤，带 `nodeId` 的先被回放守卫拒绝（409 `AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY`）。图节点写步骤时一定带 `nodeId`，不带的只有已删除的顺序链写得出来。
  - 矩阵里“可自动重放”的步骤类型只有 `custom_skill` 一个。启动恢复的单步重放和恢复面板的 `resume_from_step` 都只在矩阵允许时才调用 `resumeStep`，所以入口也只有旧链的步骤。
  - `resumeStep` 自己不看类型，但除了这两处没有别的调用方，路由上也没有。
- **行为的变化**（九种情形，最后两种是独立复核找到、复核修正提交改的；“旧链形状的步骤”指不带 `nodeId`、run 上没有图 checkpoint 的 `custom_skill` 步骤）：
  - 启动恢复（auto），旧链形状的步骤中断。之前：单独重跑这个 Skill，run 以它一个的答案完成。现在：交给人，run 是 `waiting_for_user`，原因 `graph_node_step`，步骤原样不动，只能取消。
  - 启动恢复（auto），图节点的步骤中断、run 上没有 checkpoint。之前：每次启动都尝试单独重放，被守卫拒绝，记一条 `auto_recovery_failed`；run 一直是 `running`，不进恢复列表。现在：第一次启动交给人，之后的启动不再动它。
  - 恢复面板，等待人工的 run 里有旧链形状的 paused 步骤。之前：给出“Resume step”，点了就单独跑这个 Skill。现在：只有“Cancel”；`resume_from_step` 返回 400。
  - 恢复面板，失败的旧链形状的步骤。之前：给出“Retry failed step”，点了就单独跑这个 Skill。现在：不给，run 不进恢复列表；重试路由返回 409。
  - 恢复面板，失败的图节点步骤。之前：给出“Retry failed step”，点了一定是 409。现在：不给。
  - 失败的 `document_rag` 步骤：之前可以手动重试，现在不变。
  - 中断的 `web_search` 步骤：之前交给人，原因 `requires_approval`，现在不变。
  - 恢复面板，失败的 `web_search` / `arxiv_import` 主步骤。之前：给出“Retry failed step”，点了一定是 409；run 已是终态、不能取消，所以一直留在恢复列表里。现在：不给，run 不进恢复列表；重试路由仍是 409。原因是矩阵原来列着这两类的重试，而它们的处理器一直拒绝直接重试（要重试的是审批后排进来的 `capability_call` 步骤）。
  - 聊天答案里的 “Failed steps”。之前：每个失败步骤都有 Retry 按钮，图节点和上面两类主步骤点了一定是 409。现在：失败步骤照旧列出，只有矩阵允许的四类有 Retry 按钮。
  - 第二种和第五种是顺带修掉的：前者是没人接手的死循环（每次启动失败一次，run 永远停在 `running`），后者是阶段 8 复核记下的“点了必 409 的按钮”（3.49）。最后两种是同一类按钮，这一阶段的独立复核找到的。
  - 随之发生、没有单列的变化：最后一个失败步骤不能重试的 completed / failed run 不再进恢复列表（admin status 的 `recoveryCount` 和 `agent_runs_need_recovery` 警告也不再算它们）；一个 `document_rag` 还在 running、旁边有 pending 旧链步骤的 run，以前启动会越过前者去重放后者，现在第一次启动就交给人。
  - “之前”由冻结提交写成字面期望（`server/test/agent-skill-step-replay.test.mjs`，冻结时 10 个测试，用真实的 run store、step executor、启动恢复和恢复动作服务）；删除提交对这个文件的改动就是“现在”。复核修正又加了两个测试（失败的 `web_search`、`arxiv_import`），现在 12 个。
- **删了什么**：
  - `custom_skill` 步骤的独立处理器（`rag/agent-run-step-handlers/custom-research-steps.js`，文件改名为 `research-steps.js`，只剩研究子问题的重试）。
  - `agentRunStepExecutor.resumeStep`：step executor 现在只有 `applyApprovalAction` 和 `retryStep`。
  - 启动恢复里的单步重放（`runAutoRecovery`、`findAutoRecoverableStep`）和恢复动作 `resume_from_step`。
  - 矩阵里的“可自动重放”一列（`autoReplaySafe`、`isAutoReplaySafeStepType`）、评估结果里的 `canAutoReplay`、没有策略再用的两个幂等类别（`read_only_rag`、`read_only_deterministic`）；前端的“Resume step”按钮。
- **改了什么**：
  - 矩阵（`rag/agent-run-step-replay-safety.js`）：`custom_skill` 的 `replayActions` 为空、`retryable: false`，幂等类别 `graph_owned`，原因码 `graph_node_step`。新增 `isStepRetryAllowed(stepType)`，恢复面板给不给“重试失败步骤”读它。
  - 回放守卫（`rag/agent-run-graph-replay-guard.js`）：凡是 `custom_skill` 步骤一律拒绝，不再看有没有 `nodeId`。它在三处无条件生效：step executor 重试前的预检，run store 的 `retryStep` 和 `updateRunStep`。图自己写节点步骤走步骤生命周期（`recordRunStep`），那里只在 run 上有 checkpoint、而这个步骤不是 checkpoint 里的节点时才问守卫，没有 checkpoint 的图运行就靠这条路写步骤。所以不要说“任何状态改写都被拒绝”，能说的是“没有哪条路径能把它当成独立步骤重跑或改写”。
  - 矩阵（复核修正）：`web_search`、`arxiv_import` 的 `replayActions` 也改成空、`retryable: false`；按步骤类型取策略只认矩阵自己的键（类型名是 `constructor` 这类原型属性名的步骤，原来会让恢复列表对整个 scope 抛错，只有数据损坏时遇得到）。
  - 前端聊天答案里的 Retry 按钮（`src/components/RenderQA.jsx`）：只对矩阵允许的四类步骤显示；前端自己那份类型清单由 `src/components/workbenchFormatters.test.js` 直接对着服务端矩阵核对。
  - 启动恢复（`rag/agent-run-recovery.js`）：没有图可续的 run 直接交给人，原因由 `explainInterruptedRun` 给出（有待审批项是 `pending_approval_gate`，否则是第一个中断步骤的第一个原因码，没有中断步骤是 `no_safe_recoverable_step`）。步骤上持久化的 Skill 契约继续进原因码，只是不再决定“能不能自动重放”。
- **故意留下的**：
  - `document_rag`、`follow_up_retrieval`、`research_question` 和审批绑定的 `capability_call` 四类步骤的手动重试，以及审批放行后执行 capability 步骤：它们不是 custom Skill，当前的 run 用得到。`web_search`、`arxiv_import` 的处理器也留着，作用只是用自己的报文拒绝直接重试。
  - `rag/langgraph/tools.js`：把 Skill 包成 LangChain tool 的适配器，能在图节点之外调用 Skill，但生产路径里没有任何地方用它，只有它自己的测试在用。所以准确的说法是“接了线的路径里，custom Skill 只在图里运行”。
  - 启动恢复 trace 和发布门里 `autoReplay*` 这组名字：名字没改（存量 trace、报告和前端都读它），含义变成“自动续跑中断的图”。
  - connector 清单自己的 `replaySafety.autoReplaySafe`（另一套 schema，和步骤矩阵无关）；报告里图回落的两个计数和 `graph_fallback_after_execution_zero`（“必须为 0”的守卫）。
  - 合成和响应构建里按 `customSkillGraphExecuted` 分的两条分支：没执行图的那一支服务于所有不含 custom Skill 的请求和整图被拒的请求，不是旧链专属。
- **评测套件和发布门的改动**（去掉的是随功能一起消失的检查，不是为了“通过”放宽门槛）：
  - `eval:recovery-observability`：8 个用例不变，检查项 29 → 27，去掉 `resume_after_partial_step_recorded` 和 `resume_step_recorded`；报告版本 1.1.0 → 1.2.0，不再有 `stepResumeCount`。之前各节（3.5、3.32）里的 29 项检查是当时的数字，没有改写。
  - 启动恢复的造数：原来是两个旧链形状的步骤被自动重放、一个 web search 转人工；现在是一个旧链形状的步骤和一个 web search，构建函数先断言两个都转了人工、步骤和事件没有被动过，再产出事件。
  - “自动恢复尝试过、成功率 100%、失败 0”三项检查原来由旧链形状的步骤喂数，现在只由图启动续跑探针（`skill_graph_startup_resume` 用的同一次运行）喂数。实际数值：可恢复的 run 4 → 3，转人工 1 → 2，手动动作 3 → 2，自动恢复尝试 3 → 1（成功率仍是 1）。
  - 发布门（`evaluation/quality-recovery-gate.js`）去掉 `recoveryStepResumeCount ≥ 1`，其余阈值没动；套件 manifest 1.16.0 → 1.17.0。trajectory 的用例和检查项没有变化（17 个、76 项）。
- **失去的，和升级时已存的 run**：
  - 失去：旧链留下的 run 的单步恢复和单步重试（上面前四种情形）。中断的只能取消，失败的不能单步重试，要得到答案只能重新提问。这些 run 只有在设过 `AGENT_SKILL_GRAPH_ROLLOUT=off` 或 `shadow`、或者整图被拒回落到链的时候才会产生。
  - 失去：`resumeStep` 这项通用能力（恢复一个 pending 的、有处理器的步骤）；存量 trace 里的 `resume_step` / `resume_from_step` 事件不再有单独的计数。
  - 图运行的 run：整图恢复不变，区别只在恢复面板：失败的 Skill 节点没有重试按钮，没有 checkpoint 的中断节点现在会进恢复列表。没有数据迁移，run 和 checkpoint 的格式没有变。
- **独立复核**（只读，不跑测试和评测，用内存探针对比改动前后的代码）：没有高级缺陷；两条中级意见，都不是这次改出来的（矩阵对 `web_search`、`arxiv_import` 的说法和处理器不符；`docs/agent-rag.md` 三处旧说法），几条低级意见。都处理了，逐条记录在 ADR 阶段 9 的“独立复核”。它用探针核对过：6 万个不含 `custom_skill` 的随机 run 上，转人工的原因和改动前 0 处不同；8 万个含 `custom_skill` 的随机 run 上，没有任何恢复动作指向 `custom_skill` 步骤。
- **证据**（复核修正之后、在 015f06a1 上的结果，本机 Node 24.21.0）：
  - 三个确定性 agent 评测，改动前（a26eecd7）和改动后各在一个干净的 worktree 里跑一次，屏蔽 UUID、时间戳、时长和 git 状态后比较：planner-mock（7/7）逐字节一致；trajectory（17/17，76 项检查）17 个用例全部逐字节一致；recovery-observability（8/8）有 51 处差异，都在上面“评测套件和发布门的改动”列出的范围内。
  - 覆盖率闸门接一次性 PostgreSQL 18 + pgvector（与 CI 的 `server-tests` 同一条命令，干净 worktree）：4,607 个测试，4,600 通过、7 跳过、0 失败；全局行覆盖 92.53%。阶段 8 是 4,598 个：冻结文件加 12 个，其余净减 3 个。不接数据库的全量：4,435 个测试，4,407 通过、28 跳过、0 失败。
  - `quality:current` 按 CI 的 `quality-gate` 步骤运行（干净 worktree、一次性 PostgreSQL + pgvector）：通过，八项检查全部 `pass`。前端（`vitest run`）：28 个文件、243 个测试全部通过，`vite build` 通过。受影响的 17 个服务端测试文件另外用 Node 20.20.2 跑过，340 个测试全部通过。
  - 单文件套件：`agent-skill-step-replay` 12/12、`agent-run-recovery` 17/17、`agent-run-recovery-actions` 7/7、`agent-run-step-executor` 22/22（原 26 个）、`agent-run-step-replay-safety` 9/9、`recovery-observability-eval` 9/9。
  - golden 改写 1 个（`langgraph-runtime-parity/recovery_observability_skill_graph_signal.json`）：事件从 37 条变成 33 条，其中 17 条图事件逐字节未变；其余 golden 未动。
  - CI 的 Node 22：合并提交 db3ed97b 的 Quality Gate 运行（43529876304，2026-11-13）三个任务全部通过。`server-tests` 在 Node 22.23.4 上跑完全量测试和覆盖率门：4,607 个测试，4,599 通过、8 跳过、0 失败，全局行覆盖 92.52%（比本机多跳过 1 个）。`quality-gate`：trajectory 17/17、planner 7/7、recovery-observability 8/8（27 项检查），`quality:current` 通过。`frontend-checks`：28 个文件、243 个测试通过，构建完成。
- **没有验证的**：
  - 真实浏览器里的恢复面板和聊天答案里的 Retry 按钮：前端只跑了组件测试，没有起应用看。
  - 真实 PostgreSQL 上的旧链 run：`postgres-agent-run-store` 用的是假的 pg 客户端，本机和 CI 的数据库里也没有这种存量 run。
- **回退**：没有运行时开关，只能 `git revert` 删除提交 be353b62。
- **面试里的说法**：
  - 这是阶段 8 的收尾：custom Skill 只走图之后，只有旧 run 才走得到的重试和恢复代码也删了。“只有旧 run 走得到”是从代码的调用关系读出来的，没有线上数据。
  - 被问“崩溃后哪些 run 能自动续跑”时答两种，都是续跑整张图。不要再说第三种，也不要说“只读的步骤会自动重放”：现在没有步骤被单独自动重放。（阶段 10 之后答一种：custom-Skill 图。v3 统一图已删除，见 3.51。）
  - 人能做的只有重试失败步骤和取消，失败的 custom Skill 节点不能重试；旧链留下的 run 中断了只能取消。这些要主动说。
  - 恢复评测的检查项从 29 变成 27，是随功能删掉的两项，阈值没改。本机 Node 24 和 CI 的 Node 22 上都通过。

### 3.49 LangGraph 迁移阶段 8：custom Skill 只走图，V1 顺序链删除（2026-11-13）

- **决定**：
  - 阶段 7（3.48）之后，自定义 Skill 阶段（`rag/agent-custom-skill-stage.js`）是 agent 里最后一处不走 LangGraph 的路径：V1 顺序链，一个接一个跑 Skill，把前面的答案拼进下一个 Skill 的问题。
  - 顺序链有两类入口。一类是 `AGENT_SKILL_GRAPH_ROLLOUT=off`，或 `shadow`（链回答，旁边规划一张图作比较）。另一类是默认的 `guarded` 下，整张图在任何节点运行之前被拒时回落到它。`guarded` 从 2026-09-25 起就是默认值（3.5），顺序链已经七周不在默认路径上。
  - 用户先要方案（原话"先出方案"），看过调查结果和三个方案后选了方案 A（原话"按方案 A 做"）：只走图；预算付不起的节点跳过；其他原因被拒时不执行任何 Skill，逐个记录校验器给的原因（ADR 0001"阶段 8 结果"）。
  - ADR 约束 12 的前半条（V1 顺序链和 `off` 保留到 LangGraph 成为默认后至少一个发布周期）到此结束。
  - 先冻结、再删除，分成两个提交，在 main 的 e11ced91 之上：冻结提交 2c1c6c06 把顺序链的回答写进测试，删除提交 3b3a8719 删掉顺序链。
- **删除之前的调查**（数字来自 main 上的 e11ced91）：
  - 在临时 worktree 里给这个阶段加记录点，跑全量测试和三个确定性 agent 评测（trajectory、planner-mock、recovery-observability）。阶段共被进入 188 次：133 次走图，27 次是显式的 `off`，12 次是 `shadow`，14 次是被拒后回落到顺序链，1 次检查点重放，1 次没有 Skill 的空跑。
  - 14 次回落全部在测试里：1 个专门测预算回落，1 个是空跑，12 个是因为测试用的假 RAG 服务没有 `getDocument`。三个评测里回落 0 次。
  - 按代码和默认配置，回落在生产里不会执行任何 Skill。依据四条：每个意图最多选 2 个 custom Skill；调用预算是 2 次，只能在代码里调低；`/chat` 在 agent 运行之前用同一个 `getDocument` 查询核实每个文档；四个 custom Skill 都声明了类型契约。
  - 这是从代码、默认配置和上面的计数推出来的，不是生产流量数据：项目没有生产流量。
- **被拒之后怎么办**（代替回落）：
  - 预算付不起全部选中的 Skill：确定性图（选中的 Skill 按顺序连起来，每个把结论作为类型化输入交给下一个）在规划时不再因调用预算被整张拒绝，改动是 `rag/agent-dag-planner-adapter.js` 的 `createAgentExecutionGraphResult` 里的一行。执行器在每个节点启动时预留预算，付不起的节点跳过。模型提议的图仍然按预算整张校验。
  - 其他原因被拒：不执行任何 Skill。每个选中的 Skill 得到一条失败结果（错误码 `AGENT_SKILL_GRAPH_REJECTED`），trace 里有一条 `skill_graph_rejected` 步骤说明原因。
  - 没选 Skill、模型的提议又不可用：返回空结果，和以前一样。
- **删了什么**：`runCustomSkills`（`rag/agent-custom-skill-runner.js`，173 行）、`buildChainedSkillQuestion`、阶段里 `off` 和 `shadow` 两条路径、被拒后的回落、`getAgentSkillGraphRollout()`。
- **留下什么**：
  - 单步重试和启动恢复里处理 `custom_skill` 步骤的处理器。新的 run 不再产生这种步骤（每个 custom Skill 步骤都是带 `nodeId` 的图节点），只有阶段 8 之前存下来的 run 里有。要不要删这些处理器，这一阶段没有决定。（同一天的阶段 9 把它们删了：用户的回答是“接着清理”，见 3.50。）
  - 合成和响应构建里按 `customSkillGraphExecuted` 分的两条分支。
  - 用例 id 和图事件 `mode` 里的 "guarded" 字样：它是这个变量唯一还接受的取值。
  - 没动的：图怎么规划、校验器的其他规则、执行器、图 checkpoint、启动恢复、replan、`/chat` 的响应契约；`AGENT_UNIFIED_GRAPH_ROLLOUT`（v3 默认仍是 off）和三个 planner 开关。（v3 统一图是阶段 8 当时没动，2026-11-14 阶段 10 已删除，这个开关现在只接受未设置、空值或 `off`，见 3.51。）
- **拒绝已删除的取值**：
  - `AGENT_SKILL_GRAPH_ROLLOUT` 不再选择任何东西。未设置、空值、空白或 `guarded` 可以。
  - 设成 `off`、`shadow` 或其他任何值，进程拒绝启动，进程内的每个 agent 入口也拒绝，错误码 `AGENT_SKILL_GRAPH_ROLLOUT_REMOVED`。
  - 检查的位置和另外两个已删除的运行时开关（`AGENT_RUNTIME`、`AGENT_OUTER_PLAN_RUNTIME`）相同：`rag/config.js` 的 `assertAgentRuntimeSupported` 现在三个变量都查。
  - 阶段 8 之前，拼错的取值会被悄悄当成 `off`，也就是顺序链。
- **用户看得到的差别**：冻结提交把顺序链在下面几种情形的回答写进了 `server/test/agent-custom-skill-budget.test.mjs`（合同审查请求，选中两个 Skill），删除提交改的就是其中变了的期望。
  - 默认预算（2 次调用）：答案和记录都不变。
  - 预算 1 次：答案不变（第一个 Skill 的答案、1 条引用、同样的 trace 步骤类型）。记录变了：被跳过的 Skill 没有结果，也不列在 `agentSkills` 里；预算提示多了"needed 1"；图事件从"被拒、回落 v1"变成"已执行、partial"。
  - 预算 0 次：同样的弃答。记录变了：预算提示从 2 条变 1 条，`agentSkills` 为空。
  - 第一个 Skill 失败：默认路径不变（第二个 Skill 不运行，弃答；图成为默认以来一直如此）。只有 `off` 下的链不同，它照样用原问题跑第二个 Skill、用它的结果回答，这条路随链一起没有了。这一条是独立复核指出的，冻结提交没有钉住它，之后补进了测试。
  - 只选中一个 Skill 的请求没有 Skill 产出时，回答是固定的一句 "The custom skill could not complete the request."，不是弃答；预算 0 次时这句回答不变，核实不了文档时回答从链跑出的结果变成这一句。
  - 阶段核实不了文档（RAG 桩没有 `getDocument`）：**答案变了**，从链跑出的两段结论变成弃答；两个 Skill 记为 failed，trace 多一条 `skill_graph_rejected`。只有直接调用 `runAgentRag` 的调用方走得到，仓库里只有测试；`/chat` 走不到。
- **评测套件的改动**：
  - 删了两个 trajectory 用例，连同 golden 和 manifest 条目：`custom_skill_retry`（它把开关设成 `off`，让链的一个步骤失败再单独重试）和 `skill_graph_shadow_comparison`（`shadow` 模式不存在了）。
  - trajectory 从 19 个用例、84 项检查变成 17 个、76 项，`retry` 分类没有了。之前各节（3.20、3.21、3.28、3.30、3.32、3.35、3.48）里的 19/19 和 84 项检查是当时的数字，没有改写。
  - 统一图用例 `unified_graph_evidence_gated_skill_hand_off` 里的 V1 对照原来跑 4 次（链和 DAG × 两种证据），现在 2 次；它的一份 golden 因此重写。（这个用例 2026-11-14 阶段 10 随 v3 统一图一起删了，见 3.51。）
  - 阈值没有改，没有新增用例。这不是"改评测让迁移通过"：这两个用例要靠已删除的顺序链才能跑。
  - 套件 manifest 版本随之从 1.15.0 升到 1.16.0（提交 9c3c3de8）。
- **失去、且没有替代的**：
  - 手动重试某个失败的 custom Skill 步骤。只有顺序链的步骤支持；图运行的步骤拒绝单独重试（409 `AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY`）。默认走图是 2026-09-25 起的事，所以默认配置下它已经七周不可用，现在彻底没有。图里的替代是有限 replan，只在模型规划器是主规划器时存在；确定性规划器下，失败的节点留下 partial 的图，没有重试。
  - `shadow` 对照（链回答，旁边规划一张图来比较）。规划器自己的 shadow（`AGENT_PLANNER_ROLLOUT=shadow`）不受影响。
  - 统一图用例里链和 DAG 的并排对照。
  - 没有类型契约的 custom Skill：以前靠顺序链照跑，现在不运行。仓库里的四个 custom Skill 都有契约。
  - 前一个 Skill 失败后照样跑后一个：只有链这样做；图里后一个节点依赖前一个，前一个失败它就被跳过。默认路径七周以来一直是图的表现，能用 `off` 换回链的表现这一点现在没有了。
- **独立复核**（只读，范围是冻结、删除、清单版本三个提交和当时的文档）：没有高、中级问题；七条低级意见。
  - 改了的：代码注释和文档里“确定性图就是顺序链的图版本”说过头了，改成写明差别并加了测试；七处检查点的注释补上第三个开关；一个评测脚本和两个测试里已经无效的 `mode` 参数删掉；`docs/agent-rag.md` 把“默认配置下基本走不到”的两种情形指错了行；测试里补上跳过原因、`skill_graph_rejected` 的归类、只选中一个 Skill 的请求。
  - 没改、记录在案的：预算被调低又开着模型规划器时，被预算跳过的确定性图会多问一次 replanner（默认配置走不到）；恢复接口和界面仍然对图 run 里失败的 Skill 节点给出“重试失败步骤”，点了一定是 409（图成为默认以来就这样）；恢复评测和发布门里的步骤级信号用的是链当年那种步骤，只说明旧 run 还能恢复；图被整张拒绝在报告里没有单独的计数。（其中“重试失败步骤”的按钮和步骤级信号这两条，阶段 9 已经处理，见 3.50；另外两条没有变。）
  - 没验证的：顺序链创建、停在审批门上的 run 升级之后重新进入，按代码读下来会以 `AGENT_GRAPH_EXECUTION_FENCED` 失败，没有端到端跑过。
- **证据**（删除之后，本机 Node 24。ADR 0001 阶段 8 的证据小节把这些结果记在提交 9c3c3de8 上：它排在删除提交 3b3a8719 之后，只改了 manifest 版本号）：
  - 覆盖率闸门接一次性 PostgreSQL + pgvector：4,595 个测试，4,588 通过、7 跳过、0 失败；全局行覆盖 92.54%，五组覆盖率门都通过。复核修正之后（提交 341ad5f3）重跑：4,598 个测试，4,591 通过、7 跳过、0 失败，92.55%；多出的 3 个是 `agent-custom-skill-budget` 新加的测试（5 个变 8 个）。
  - 三个确定性 agent 评测在删除前（e11ced91）和删除后各跑一次，屏蔽 UUID、时间戳、时长和 git 状态后比较：planner-mock（7/7）和 recovery-observability（8/8）逐字节一致；trajectory 从 19/19（84 项检查）变成 17/17（76 项），两边共有的 17 个用例里 16 个逐字节一致，第 17 个（`unified_graph_evidence_gated_skill_hand_off`）只差上面说的 V1 对照。
  - `agent-runtime-removed` 19 个测试（原 15 个），`agent-custom-skill-stage` 24 个测试。
  - 按 CI 步骤跑的 `quality:current`（提交 9c3c3de8，干净 worktree、一次性 PostgreSQL + pgvector）：通过，八项检查全部 `pass`；复核修正之后在 341ad5f3 上重跑，同样通过。
  - 合并和 CI：合并提交 7fbf8974（2026-11-13，已推送）。main 上的 CI（Quality Gate 运行 43517749419）三个任务全部通过，其中 `server-tests` 在 Node 22.23.4 上：4,598 个测试，4,590 通过、8 跳过、0 失败，全局行覆盖 92.53%。
- **没有验证的**：
  - 真实模型下的答案质量。链和图把第一个 Skill 的结论交给第二个 Skill 的方式不同（链拼进问题，图用类型化输入）。但默认路径七周以来一直是图，所以这不是这次带来的新变化。
  - 没有生产流量数据。"回落在生产里不会执行任何 Skill"是从代码、默认配置和上面的计数推出来的。
- **回退**：没有运行时开关，只能 `git revert` 删除提交 3b3a8719。图 checkpoint 的格式没有变，没有数据要处理。
- **面试里的说法**：
  - 起因是用户要 agent 只有一种运作方式，不是性能。没有量过性能，不要讲成性能改进。
  - 依据是调查：默认配置下顺序链作为兜底在生产里已经不会真正执行任何 Skill（只会空跑，或者在运行上限用完时把每个 Skill 记成跳过），188 次进入里被拒回落 14 次、全在测试里。
  - 做法是先冻结顺序链的回答，再删除，两个提交分开；删除提交里能看到哪些期望变了。
  - 要主动说随它一起没有的东西：手动重试失败的 Skill 步骤这一项能力，和两个评测用例。
  - 不要说"行为完全没变"：阶段核实不了文档时，答案从两段结论变成了弃答，只是 `/chat` 走不到。
  - 也不要说"确定性图等于原来的顺序链"：第一个 Skill 失败时，图不跑第二个，链会跑。

### 3.48 LangGraph 迁移阶段 7：外层计划也只走 LangGraph，原生循环删除（2026-11-13）

- **决定**：
  - 用户的原话是"我不希望 agent 有两种运作模式，我只希望用已经迁移了的 langgraph"（ADR 0001"阶段 7 结果"）。
  - 这取代了 2026-10-16"外层计划长期保持原生循环"的决定（3.29）。10% 的压测门没有重测，也没有通过，是明知不达标、接受代价。
  - 改之前：外层 V1 计划（固定阶段：内置 Skill、自定义 Skill、文档循环、Web 兜底）默认由原生循环 `runAgentExecutionPlan` 调度，生产走的就是它。LangGraph 的底层 Pregel 图只是 `AGENT_OUTER_PLAN_RUNTIME=langgraph` 后面的实验开关。`/chat/stream` 在路由里有原生和 LangGraph 转发两条分支。
  - 现在：整个 agent 只有一种运行时。外层计划、`/chat/stream`、guarded 的 custom-Skill DAG、guarded 的 v3 统一图都跑在 LangGraph 上。（写这一句时 custom Skill 阶段还留着一条不走 LangGraph 的路径，V1 顺序链；同一天的阶段 8 把它删了，见 3.49。v3 统一图 2026-11-14 阶段 10 也删了，见 3.51。）
- **删了什么**：原生调度循环；`resolveAgentExecutionPlanRunner` 和 `getAgentOuterPlanRuntime`；`routes/chat.js` 里 `/chat/stream` 的原生分支。
- **留下什么**：
  - `runAgentExecutionPlan` 这个名字（`rag/agent-execution-plan-runner.js`）留作唯一入口：懒加载图模块，把每个计划交给 `runAgentExecutionPlanOnLangGraph`。
  - 图在 `rag/langgraph/execution-plan-graph.js`：底层 Pregel，不带 checkpointer，按计划形状只编译一次，静态剪掉不起作用的内置阶段。阶段体（`createAgentExecutionPlanStages`）没改。
  - `/chat/stream` 只剩一条路径：`rag/langgraph/agent-stream.js` 的 `streamAgentRun` 生成器。SSE 字节不变。
  - 没动的：V1 顺序链（`AGENT_SKILL_GRAPH_ROLLOUT=off|shadow`，以及整图被拒时的兜底）、`AGENT_UNIFIED_GRAPH_ROLLOUT`（v3 默认仍是 off）、规划器、文档阶段内部的文档循环。（顺序链和 `off|shadow` 是阶段 7 当时没动，阶段 8 已删除，见 3.49；v3 统一图也是当时没动，阶段 10 已删除，见 3.51。）
  - 持久化也没动：外层计划仍靠 run 的步骤，LangGraph 只给 custom-Skill DAG 和 v3 图做 checkpoint。（阶段 10 之后只给 custom-Skill DAG 做，见 3.51。）
- **拒绝已删除的取值**：
  - `AGENT_OUTER_PLAN_RUNTIME` 不再选择任何东西。未设置、空值、空白或 `langgraph` 可以。
  - 设成 `native` 或其他任何值，进程拒绝启动，进程内的每个 agent 入口也拒绝，错误码 `AGENT_OUTER_PLAN_RUNTIME_REMOVED`。
  - 这和阶段 6 起的 `AGENT_RUNTIME` 一样：`rag/config.js` 的 `assertAgentRuntimeSupported` 两个变量都查（阶段 8 起是三个，加上 `AGENT_SKILL_GRAPH_ROLLOUT`，见 3.49）。
  - 阶段 7 之前，拼错的取值会被悄悄当成 native。
- **等价怎么保住**（和阶段 6 同一个办法）：
  - 删除之前，在提交 3313b40b 上把各 parity 套件比较过的每个场景的原生一侧冻结成 golden。`server/test/fixtures/graph-goldens/` 下新增 32 个文件：`langgraph-execution-plan-graph` 24 个（10 个轨迹用例、14 个直接场景），`langgraph-chat-stream` 5 个（SSE 字节、帧和 run），`langgraph-routes` 3 个。
  - 在那个提交上，原生一侧写出每个文件，LangGraph 一侧对照它。
  - 删除之后，每个套件只在 LangGraph 上跑一次、对照 golden：`langgraph-execution-plan-graph` 26/26、`langgraph-chat-stream` 8/8、`langgraph-routes` 8/8、`agent-run-chat-statement-count` 10/10（run store 的调用次数不变，因为外层计划没有 checkpointer）。检查拒绝已删除取值的 `agent-runtime-removed` 15/15。
  - 三个确定性 agent 评测，删除前后屏蔽后逐字节一致：`eval:trajectory` 19/19、`eval:planner -- --provider mock` 7/7、`eval:recovery-observability` 8/8。
  - （这一段的数字是阶段 7 当时的，没有改写。阶段 8 之后 `agent-runtime-removed` 是 19 个测试，trajectory 是 17 个用例；阶段 10 之后分别是 23 个测试和 15 个用例，planner 是 6 个用例，见 3.51；这里冻结的 32 个文件里，`langgraph-execution-plan-graph` 的 `custom_skill_retry.json` 随那个用例一起删了，见 3.49。）
- **代价**（接受的）：
  - 进程内：一次文档问答的 `runAgentRag`，原生循环 0.605 ms CPU，LangGraph 0.894 ms，多 0.29 ms。2026-11-13 删除之前测，同一进程，交替 7 轮、每轮 400 次，Node 24.21。
  - 压测：阶段 5（pgvector、假模型 0 ms、并发 1）测到每请求 CPU 5.68 → 6.68 ms（+17.6%），p95 9.3 → 10.5 ms（+13%）。阶段 7 没有跑新的压测。
  - 相对真实模型约 2.4 秒的一次回答，这点开销看不出来。
- **其他后果**：
  - 加载：每个回答 agent 请求的进程，现在都在第一个请求时加载 `@langchain/*`。2026-11-13 实测一次性约 115 ms，GC 后常驻内存 82 → 143 MB；默认的 LLM 规划器本来就在第一个 `/chat` 加载 LangChain core，阶段 7 实际多出来的是 LangGraph 本身，约 50 ms、21 MB。拆分部署的 api 入口和入库 worker 仍然不加载。
  - LangSmith：追踪变量为 true 时，`/chat/stream` 拒绝所有流式请求（在 run 建立之前，走不到外层计划的请求也一样），`/chat` 拒绝每个走到外层计划的请求（以 `LANGSMITH_TRACING_ENABLED` 让 run 失败；走不到外层计划的仍然回答）。以前原生循环上的普通文档问答还能回答。`server.js` 本来就拒绝带这种变量启动，所以只有进程内调用方或启动后环境被改动的进程会遇到。
  - 压测脚本：`--outer-plan-runtime` 现在只接受 `langgraph`，`native` 被脚本自己的参数检查拒绝。阶段 7 之前写下的报告里，`/chat` 的 CPU 数字比同一提交现在测出来的每请求低约 1 ms。
- **回退**：没有运行时开关，只能 `git revert` 阶段 7 的删除提交。
- **面试里的说法**：
  - 门是在假模型 0 ms 下按每请求 CPU 和 p95 判的，外层计划两次都没过，这个结论没有变。
  - 后来的取舍是：宁可每次运行多花约 0.3 ms CPU，也只留一种运行时。这是用户明说的决定，不是测量结果变了。
  - 不要说迁移提升了性能，也不要说门后来过了。
  - 新增的 32 个基准文件在 Node 24 上生成；推送后 main 上的 CI（Node 22，合并提交 89a70d0a）通过。
  - 这里没列的数字见 ADR 0001 阶段 7 的证据小节（`docs/adr/0001-langgraph-runtime.md`）。

### 3.47 Office 解析放进工作线程：大文件不再卡住事件循环，内存耗尽只结束 worker（2026-11-13）

- **为什么做**：Word、PowerPoint、Excel 文件原来在调用线程里解析。20 万单元格的工作簿会把 API 进程的事件循环占住 244 ms；解析耗尽内存时，整个进程崩溃，所有租户一起受影响。
- **怎么做**：
  - 压缩包检查和三种解析器放进 worker_threads 池，默认 1 个 worker；设成 0 就回到原来的做法。
  - 文件在主线程里读取和解密（工作文件的密钥在主线程），明文复制一份交给 worker。worker 和进程共用环境变量，运行中改的上限立即生效。
  - 拒收的报错在主线程里还原成同一个类，状态码、`code`、信息都不变。
  - worker 内存耗尽时这份文档返回 413，异步入库不重试，进程不受影响；崩溃 500、超时 504，入库会重试。
  - 调度逻辑抽成共用的池，pdf.js 的 worker 池也改用它，原有测试照旧通过。
- **结果**：
  - 72 份文件（64 份 Office 原生文件、5 份 Office 自己保存的测试文件、3 份生成的大文档）上，改动前的加载函数、改动后的调用线程模式和 worker 模式，结果完全相同，序列化后也一致。
  - 加载期间事件循环最长延迟：大 xlsx 244 ms → 2 ms，大 pptx 65 → 2，大 docx 56 → 2。
  - 代价：小文件按格式平均每份多 0.1–0.9 ms（单份有快有慢），大文档每份多 6–25 ms。复制字节和页面不到 1 ms，其余是解析在 worker 里跑得慢，原因没拆开测。
  - 只把 worker 的内存上限设成 48 MB：那份大工作簿返回 413，下一份照常解析。进程的堆限制在 48 MB、在主线程里解析同一个工作簿：进程直接崩溃。
- **审查后补的**（合并后做了独立代码审查）：
  - worker 的栈比主线程大，嵌套极深的 Word 文档在两边结果不同（主线程栈溢出被拒，worker 能读）。现在 Word 的 XML 嵌套和 PowerPoint 一样限制在 256 层，两边拒的是同一批文件。
  - 进程带 `--max-old-space-size` 时，Node 会把它用到每个 worker，worker 自己的内存上限就失效了。文档写明了，池子也会打警告。
- **面试里的说法**：被问"上传的文件很大或者是恶意的怎么办"：
  - 先有几道上限，在解析之前就拒掉压缩炸弹、超大 XML、过深的嵌套和展开后过多的文字。
  - 解析本身放在有内存上限的工作线程里，最坏情况也只是这个 worker 被结束、这份文件返回 413，服务不受影响。
  - 改动前后用 72 份文件做过逐一对比，解析结果不变。
  - 要主动说：线程不同，隐含的限制也不同（栈深度、内存上限会被进程参数盖掉），审查时发现后把它们改成了显式的上限。
- **提交**：见 docs/evaluation.md「Office 解析放进工作线程」。

### 3.46 检索前扩展查询（多查询改写、HyDE）：两种都没有给候选补进证据（2026-11-12）

- **为什么做**：默认配置的答案漏斗里，177 道可回答题有 34 道的证据不在 10 个候选里。检索前改写查询是常见的补法，这个项目还没试过：
  - 多查询改写（MultiQueryRetriever、RAG-Fusion 的做法）；
  - HyDE（先让模型写一段假想答案，用它的向量去找段落）。
- **怎么做**：
  - 加了默认关的 `RAG_QA_QUERY_EXPANSION`（`multi_query` / `hyde`）。门控和答题模型看的仍是原问题；只有改写找到的段落，覆盖率按原问题重算。
  - `eval:abstention-gate` 的候选存档多记每题的检索耗时和扩展情况。新命令 `compare:gate-dumps` 把两份存档逐题配对，区间按论文重抽；两份存档的提交或设置不同时，它拒绝比较。
  - 规则先写好并提交（285b5b7f），分三步，不论结果都不改默认：
    - A：在 train 上选，候选证据提升的区间下界 > 0，上下文证据不减，拦截率最多降 0.02；
    - B：在 dev 上确认；
    - C：护栏。
  - 基线组在跑的时候，对实现做了一次独立核查，发现两处会影响测量的问题：
    - 没有检索词的回复行（"1."、"N/A"）被当成改写；
    - 存储给的空覆盖率被门控当成"够"。
  - 在任何扩展组产出数字之前停下来修好（dbcaa780）。规则的判定条件没改，基线在修复后的提交上重跑，两次基线的候选逐题相同。
- **结果**（QASPER train，800 道可回答 + 272 道不可回答，nomic-embed-text，top-K 10，qwen2.5:7b 温度 0 做扩展）：
  - 多查询改写：证据进候选 0.805 → 0.7875，−0.0175 [−0.031, −0.005]（多 8 道、少 22 道），区间整个在 0 以下。
  - HyDE：0.805 → 0.805（+21 / −21），没变；证据排第 1 名的变少了（−0.019，区间不含 0）。
  - 两组进上下文的证据点估计都略少（少 5 题、4 题，区间含 0）。
  - 两组都没过 A，dev 和护栏没跑，默认不变。
  - 代价：每题检索从均值 13 ms 变成 659 ms（多查询）和 785 ms（HyDE），几乎都花在扩展那一步：多查询是那次模型调用，HyDE 还加一次段落嵌入。
- **结论**：两种扩展都保留为可选，默认关，不说有帮助。
- **面试里的说法**：被问"有没有试过查询改写或 HyDE"：
  - 试过，按事先写的规则在 QASPER train 上测。
  - 多查询改写反而让候选里的证据变少。原因在倒数排名融合：被两份以上列表找到的段落至少得 2/70，只被一份列表找到的至多得 1/61，所以前者总排在前面。只有原问题找到的段落，名次再靠前也可能被挤掉。
  - 原问题自己排前 3 的证据，有 6 道掉出了前 10。其中 4 道能从留下的第 10 名的分数证明只被原问题找到；另外 2 道推不出，因为存档只留融合后的 10 个。
  - HyDE 不增不减（多 21 道、少 21 道），但证据排第 1 的变少了。门控没变，候选变了，结果多拦下 6 道不可回答题（一道没少），可回答题放行净少 7 道（区间含 0）。
  - 我的解释（没验证）：做扩展的 qwen2.5:7b 看不到论文，提示词里只有问题，改写和假想段落只能猜正文怎么写，多半是在加噪声。
  - 不要说"QASPER 的问题是读着论文写的"：按数据集论文（Dasigi et al. 2021），提问人只看了标题和摘要，答案和证据由另一批人读全文标注。
  - 要主动说：基线跑到一半做了独立核查，发现会影响测量的 bug，停下来修好再重跑，判定条件没改。
- **提交**：
  - 285b5b7f：开关、工具和事先写的规则；
  - dbcaa780：核查后的修复和规则措辞修订；
  - 结果在其后的提交里，见 docs/evaluation.md "检索补漏"。

### 3.45 重排在 top-K 10 下重测：门控仍选 0.02，开重排后多答 32 道可回答题（2026-11-12）

- **为什么做**：交叉编码器重排（bge-reranker-v2-m3）和它的拒答门控（重排概率 ≥ 0.02）是在 top-K 6 时调的。top-K 改成 10 以后，候选池从 18 个变成 30 个，两样都没重测。另外，上一轮的稠密补救没通过，而重排概率是测过的拒答信号里区分得最好的。
- **怎么做**：
  - 规则先写好并提交（ee640eb6）。代价规则沿用当初的：错答一次算三次拒答，不可回答题占 11.5%。
  - 在 train 上让概率网格的每一档和同一批候选上的词面门控一起比：最低代价 +0.01 以内，拦下不可回答题最多的胜出。
  - dev 上确认，再加 `verify:quality` 护栏，最后用 116 道没用过的 dev 题比较答案：不开重排对开重排。
  - 重排模型本机已缓存，没有下载。
- **结果**：
  - 门控：train 上仍选 0.02，默认不改。重排概率的 AUC 在 train 上是 0.648（词面覆盖 0.596），dev 上 0.724（0.658）。
  - 检索（dev）：证据进候选 0.784 → 0.851（+0.067 [+0.045, +0.089]），进前 3 名 +0.050。
  - 门控（dev）：可回答题放行 0.600 → 0.893，不可回答题拦截 0.589 → 0.337。
  - 答案（116 题，qwen2.5:7b）：
    - 可回答题作答 61 → 93，32 题全是新答的，没有一题从作答变成拒答；
    - 官方 F1 +0.039 [−0.018, +0.095]；
    - 不可回答题作答 8 → 9（共 15 题）；
    - 按答题结果算的代价 0.535 → 0.277。
  - 护栏：`verify:quality` 18/18。
  - 只记录：阈值设 0.2 时，开重排的拦截率和不开重排时没检出差异：dev 上点估计都是 0.589，配对区间 ±0.105，拦下的不是同一批题。可回答题却多放行 14 个百分点（+0.140 [+0.108, +0.172]）。0.2 没做过答题确认。
- **结论**：有重排服务就开重排，门控默认 0.02 的推荐照旧成立。代价是门控放进来的不可回答题明显变多；更看重"不乱答"的部署可以考虑 0.2。
- **面试里的说法**：被问"拒答怎么判断"：
  - 在同一批 dev 候选上，词面覆盖率的 AUC 是 0.658，embedding 相似度 0.655；交叉编码器把问题和段落放在一起读，是 0.724。train 上是 0.596、0.613 对 0.648。
  - 按事先定的代价规则选阈值，top-K 改了以后重测，规则仍选 0.02。
  - 在 116 道没用过的题上，开重排后可回答题多答了 32 道，F1 没检出变差。
  - 要主动说代价：门控放进来的不可回答题变多了。如果在乎这个，阈值 0.2 时拦截率和不开重排时没检出差异，可回答题仍多放行 14 个百分点。
  - 0.2 这一档是事后看到的，不是规则选的，也没做过答题确认。
- **提交**：ee640eb6（分析工具和事先写的规则）；结果在其后的提交里，见 docs/evaluation.md "重排在 top-K 10 下重测"。

### 3.44 门控换信号：用稠密相似度补救，dev 上多放行了 3 道不可回答题，没通过（2026-11-12）

- **为什么做**：单文档问答的门控只看查询词覆盖率（≥ 0.51），分不太开可回答题和不可回答题（dev AUC 0.638）。答案漏斗里，177 道可回答题有 56 道证据已经在候选里，却被门控拒答。稠密余弦分得略好（dev 0.657），想看用它补救覆盖率不够的切块，能不能多放行可回答题而不多放行不可回答题。
- **怎么做**：
  - 加了默认关的 `RAG_QA_DENSE_RESCUE`（`absolute` / `margin`）。覆盖率不够的切块，只要余弦够高、覆盖率不低于下限、没有近邻替换，也放行。问题里的编号和引号短语仍须出现；多部分问题、重排门控和对比路线不走这条路。
  - `eval:abstention-gate` 加了候选存档和重放（`--dump` / `--replay`）。网格的阈值取本次信号的分位数，不看标签。
  - 规则先写好并提交（1e5f05b4），分四步：
    - A：在 train 上，从拦截率最多降 0.02 的配置里选放行最多的，至少多放行 0.03；
    - B：在 dev 上原样确认，放行的提升按论文区间下界 > 0，拦截率最多降 0.03；
    - C：护栏；
    - D：用 116 道没用过的 dev 题做答题确认。
- **结果**：
  - train（800 道可回答 + 272 道不可回答）：选出 `absolute` 0.7737、下限 0。放行 +0.031 [+0.020, +0.044]，拦截 −0.011（3 题），A 通过。
  - dev（821 + 95）：放行 +0.029 [+0.019, +0.041]，新放行的 24 题里 14 题证据也被放行，b1 通过；拦截 −0.032（95 道不可回答题里门控多放行了 3 道），超过 0.03，b2 不通过。这一轮只重放门控，没生成答案；护栏和答题确认没跑。
- **结论**：设置保留，默认关，不给推荐值。稠密余弦只比词面覆盖略好，多放行可回答题的同时，也多放行了不可回答题。
- **面试里的说法**：被问"为什么不用 embedding 相似度判断该不该拒答"：测过。在 nomic-embed-text 上，它区分两类题只比词面覆盖略好（dev AUC 0.657 对 0.638）。按事先写好的规则在 train 上选阈值，dev 上能多放行约 3% 的可回答题，但 95 道不可回答题里门控也多放行了 3 道，超过事先定的上限，所以没采用。规则写在运行之前，差一题也算没过。
- **提交**：1e5f05b4（开关、工具和事先写的规则）；结果在其后的提交里，见 docs/evaluation.md "门控换信号"。

### 3.43 Office 文件对比 Office 自己导出的 PDF：表格直接传 .xlsx 答得更准（2026-11-11）

- **为什么做**：Word、PowerPoint、Excel 的入库上线后（4db859c6），还没在 Office 文件上测过检索和答案。想知道：同一份内容，直接上传 Office 文件和上传它自己导出的 PDF，结果有没有差别。
- **怎么做**：
  - 先用 Word、PowerPoint、Excel 16.115 for Mac 真实保存的 5 个文件测加载器：主题、母版继承的项目符号、备注页、隐藏页、Word 自己的表格和脚注、Excel 的合并单元格、数字格式、公式缓存和隐藏表。逐页结果都对，加载器不用改。文件去掉账户名和用户目录后再提交（2ada73d3）。
  - 规则先写好并提交（a9aefd00）。语料用 AppleScript 驱动三个应用生成，每份文档存两份：原生文件，和同一个应用导出的 PDF。
    - word：QASPER train 的 30 篇论文排成 Word 文档，117 题；
    - sheet：18 个合成工作簿，Excel 自动列宽、每页重复表头、缩放到一页宽后导出，108 道单元格查找题；
    - deck：16 份 PowerPoint 新建的演示文稿，64 道正文题、32 道演讲者备注题。
  - 两个版本都经上传用的 `ingestDocument` 入库，逐题问单文档 QA 路线。qwen2.5:7b，温度 0 加上限 1024，区间按文档整组重抽。
- **结果**：
  - 表格：答对 106/108 对 96/108（0.981 对 0.889），+0.093 [+0.037, +0.157]，10 题翻转全部偏向原生。原因是 PDF 丢了"值属于哪一列"：数据行是一串用空格隔开的值，列名只在页顶一行。
    - 3 行和表头被切到不同的切块，行所在切块的查询词覆盖率都是 0.5（两道销售题四个查询词命中两个，预算题两个查询词命中一个），低于门控的 0.51，被拒答；
    - 另外 7 题列名就在给模型的上下文里（其中 4 题还和那一行在同一个切块），模型照样读错：5 道"经理是谁"答没列出经理，2 道 Spent 答成了左边一列 Budget 的值。
  - Word 正文：F1 +0.004 [−0.014, +0.024]，没有检测到差异。
  - 演示文稿正文：两组都是 64/64，到顶了，分不出来。备注题原生 32/32；PowerPoint 默认导出的 PDF 只有幻灯片，没有备注（导出备注页的 PDF 没测）。
  - 逐条核对：宽松判分可能把答错列也算对，所以事先写了核对规则。两组各抽 30 个判为答对的表格答案，60 个都是所问那一列的值；之后的独立核查把全部 376 个表格和演示文稿答案都对了一遍，和判分一处不差。核对是 Claude 逐条读的，不是人工标注。
  - 独立核查还找到 3 处判分缺陷，都修了，判定都不变：一种标注下拒答会记 1 分（word 的 F1 水平因此从 0.139 / 0.135 改为 0.130 / 0.126，差值不变）；带弯引号的标注片段匹配不上（1 题）；数字判分会把引用标签"[Source 1]"里的数字也算进去（重算后 376 个判定一个没变）。
- **结论**：只测量，不改默认。在 qwen2.5:7b 和这些合成表格的单元格查找题上，表格类文档直接传 .xlsx 更好。
- **面试里的说法**：被问"导出成 PDF 再传不行吗，为什么要专门支持 Office 格式"：在 qwen2.5:7b 上，Word 正文测不出差别，表格差别显著，而且原因指得出来。PDF 把表格压成一串用空格隔开的值，列名只在页顶一行。有 3 题是切块把那一行和列名分开了，门控因此拒答；另外 7 题列名就在给模型的上下文里，模型仍然分不清哪个值属于哪一列。原生加载器把每个值写成"列名: 值"，每一行都自带列名。备注更直接：PowerPoint 默认导出的 PDF 里根本没有备注。
- **提交**：2ada73d3（Office 自己保存的测试文件和测试），a9aefd00（评测和事先写的规则）；结果和独立核查后的判分修正在其后的两个提交里。结果见 docs/evaluation.md "Office 文件对比 Office 自己导出的 PDF"。

### 3.42 CI 上的输出上限检查；温度 0 的两次 CI 运行答案不同（2026-11-10）

- **为什么做**：CI 答题样本改用温度 0 加上限后，第一次运行（42909240063）没有一个答案碰到上限。所以看不出 CI 固定的 Ollama 0.40.3 认不认 `max_tokens`，此前只在本机 0.34.4 上证实过。
- **怎么做**：
  - 新增命令 `npm run probe:output-limit`。它经应用自己的对话客户端发一个上限 8 token 的请求，回复必须在 8 个 token 内因长度停下，否则以非 0 退出。
  - CI 在答题前跑它。
  - 本机 0.34.4 上：`max_tokens` 通过；`max_completion_tokens` 写了 723 个 token，不通过。
  - 合并前做了一轮独立审查：确认 16 条，都修了。
- **结果**：
  - 加上这一步后的第一次 CI 运行（42922531176）：0.40.3 写 8 个 token 后因长度停下，通过，整步 12 秒。
  - 顺带发现：两次 CI 运行（Ollama 0.40.3，只用 CPU）都是温度 0、同一批 40 题，作答的是同一组 15 题，但其中至少 9 题的答案不同（官方 F1 0.297 对 0.296）。本机（Ollama 0.34.4）的两次运行是 113/113 逐字相同；还没有在同一台机器上跑过两次 0.40.3。
  - 原因还没定：
    - 更可能是换了硬件：第二次的 runner 慢了一倍多，证据召回那步入库 141 篇，用了 1486 秒对 685 秒。
    - 答题前的检查请求不太可能：它到第一个答题请求至少隔了 5 分 35 秒，超过 Ollama 默认 5 分钟的 keep-alive，模型多半已经重新加载。但 Ollama 日志没留下，没法确认。
  - 现在每次运行都在日志里记下 runner 的 CPU 型号、逻辑 CPU 数、物理核数和是否支持 AVX-512；检查之后也会卸载对话模型（`ollama stop`），排除第二种可能。
- **结论**：上限在 CI 上管用。温度 0 的逐字可复现目前只在本机见过；CI 上两次运行不同，原因未定，所以 CI 答题样本的小幅变化不能当成效果。
- **面试里的说法**：
  - 贪心解码的“确定”只在同一硬件、同一软件下才有保证：换一种 CPU，浮点累加顺序一变，某一步的 argmax 就可能翻。这次 CI 上的差别最可能就是这个原因，但还没确认。
  - 要比较两个设置，就在同一台机器上配对跑；不要拿 CI 两次的数字直接比。
  - 发现靠的是把逐题结果对齐比，而不是只看总分：总分只差 0.001，逐题却有 9 题变了。
- **提交**：1a607639、fdcb3bad（检查命令、CI 步骤和审查修复），合并为 820a833d。记录见 docs/deployment.md “CI 里的真实模型评测”。

### 3.41 温度 0 带上限重测：四条规则全过，答案评测改用温度 0（2026-11-10）

- **为什么做**：3.39 那一轮因为一道题卡死而无法判定。有了输出上限（3.40），按新写的规则重测：沿用 3.39 的三条（`verify:quality` 改在温度 0 加上限下跑），再加一条：每个温度 0 臂最多 4 题被上限截断。
- **怎么做**：
  - 规则先写好并提交（88fad23d）。三臂都设上限 1024，只有温度不同：Z 设 0 跑两次，B 用端点默认的 1.0 跑一次。顺序 Z1、B、Z2，每臂各起一个新的 Ollama 进程。
  - 样本是下一份没用过的 dev 200 题（181 可答 / 19 不可答）。
- **结果**：
  - 两次温度 0 的运行逐字相同：113 个答案一个不差（本机 Ollama 0.34.4 上；CI 上的两次运行并不相同，见 3.42）。在 1.0 下，同一设置、同一批题重复跑，F1 会来回约 0.01（3.38 那份样本上四次是 0.205–0.215）；这一轮的 B 只跑了一次（官方 F1 0.228，Z 是 0.231），没有在这份样本上重测 1.0 的来回。
  - 质量没有检出下降：官方 F1 +0.0025 [−0.013, +0.016]。
  - `verify:quality` 18/18，没有答案被截断。
  - 顺带：温度 0 的答案更短（中位数 30 对 36 个词；按题配对 61 题更短、43 题更长）。作答的题平均快 0.13–0.16 秒，但其中 0.03–0.05 秒是 B 的 Ollama 进程预填就慢（与温度无关），解码部分的差区间含 0，所以不能说温度 0 本身让答题变快。
- **结论**：答案侧评测从此固定温度 0 加上限 1024。应用默认值不变。CI 真实模型评测的答案样本随后也改成这个口径（只改那一步，阻断用的 `verify:quality` 不变）。
- **面试里的说法**：评测噪声和效应一样大时，先把噪声去掉，比多跑几次求平均更干净。但温度 0 不是免费的：第一次直接上就撞上了停不下来的生成。所以先补上限，再按新写的四条规则（原来的三条加一条截断上限）重测，四条都过了才改口径。“没有检出下降”不等于“一样好”，区间宽约 ±0.015。
- **提交**：88fad23d（规则）。结果见 docs/evaluation.md “答案温度 0 重测：带输出上限”。

### 3.40 答案输出上限：卡死的那道题 22 秒停下（2026-11-10）

- **为什么做**：3.39 里温度 0 下有一道题生成停不下来，客户端只能等超时、重试，最坏约 8 分钟后失败。原因是答案调用没有输出上限。
- **怎么做**：
  - 新增可选设置 `RAG_ANSWER_MAX_TOKENS`，只加在文档答案的三种调用上。默认不发送，请求逐字节不变。
  - 上限默认放在 `max_tokens` 字段里，可改成 `max_completion_tokens`（OpenAI 推理模型只认它）。
  - 直连、流式、模型网关三条路都带上。网关收到不合法的上限直接返回 400，不会悄悄丢掉；设置值不对时应用和网关拒绝启动。
  - 回复因上限停下（`finish_reason: "length"`）时，答案标 `answerTruncated: true`，MCP 结果里也有。语义缓存不存这种答案，评测报告逐题记录。一个字都没写出来就被截断的回复算拒答，不再冒充答案。v3 统一图路径的步骤输出还不带这个标记。（v3 统一图 2026-11-14 已删除，这一条限制随它没有了，见 3.51。）
  - 独立审查确认 9 处低严重度问题，都已修，例如：值不对的调用原来会被熔断器记成成功；空回复原来被当成作答。
- **机制检查**（不是对照轮）：
  - Ollama 0.34.4 只认 `max_tokens`，忽略 `max_completion_tokens`：上限设 8，照样写了 185 个 token。
  - 温度 0 加 1024 上限，重跑那份样本的前 24 题。第 24 题在 1,024 token 处停下：生成 20.5 秒，整题 22 秒，答案是 747 词的重复长文，标了截断。
  - 其余 23 题都没碰到上限，24 题连入库 68 秒跑完。
- **结论**：最坏情况从约 8 分钟后失败，变成约 22 秒后返回一个带截断标记的答案。温度 0 的答案质量还没测，要按新规则另做一轮。
- **面试里的说法**：上限默认不开，因为各服务认的字段不一样：OpenAI 推理模型拒绝 `max_tokens`，Ollama 又忽略 `max_completion_tokens`。默认开的话，有的部署会全部报错，有的以为有上限其实没有。所以做成显式设置，并把“被截断”当成一等信号记录下来，而不是悄悄返回半截答案。
- **提交**：5da4bb14（设置、各条路径、截断标记和测试）。结果见 docs/evaluation.md “答案输出上限”。

### 3.39 答案温度设为 0：先写规则，结果是一道题卡死，口径不改（2026-11-10）

- **为什么做**：应用不传 temperature，Ollama 按 1.0 采样。同一设置、同一批题重复跑，作答的题完全相同，官方 F1 却在 0.205–0.215 之间来回（3.38）。想用温度 0 去掉这份噪声。
- **怎么做**：新增可选设置 `RAG_ANSWER_TEMPERATURE`，只加在文档答案的三种调用上。默认不设、不发送，因为有的模型只接受默认温度（例如 OpenAI 的推理模型）。规则先写好并提交：温度 0 跑两次看是否逐字可复现，F1 不能检出下降，`verify:quality` 18/18。样本是没用过的 dev 200 题，每次运行各起一个新的 Ollama 进程。
- **结果**：温度 0 的第一次运行在第 24 题（是非题）卡死。同一个请求四次都写到 5,600–5,800 个 token，被 120 秒超时取消；重试 3 次后评测中止。同一道题在 1.0 下 91 个 token、1.7 秒就答完。温度 1.0 的五次运行共 599 次作答，最长 554 token，从没出现过这种情况。
- **结论**：一臂跑不完，按规则算不过，评测口径不改。设置保留为可选，文档写明“没有输出上限时不要设 0”。下一步应先给答案调用加输出上限，让这类请求的最坏情况从 8 分钟变成几十秒，再重测温度 0。
- **面试里的说法**：本想做的是降低评测噪声，结果先撞上一个生产风险：小模型贪心解码会进入停不下来的生成，而答案调用没有输出上限。规则先写好，所以“跑不完”没被当成小问题绕过去。改动默认不发送温度，是因为有的托管模型不接受这个参数。
- **提交**：86a7759f（设置和规则），结果见 docs/evaluation.md “答案温度设为 0”。

### 3.38 默认配置的答案漏斗、延迟分解和 token（2026-11-10）

- **做了什么**：三个不调模型的工具，读评测已经写下的报告和事件：`funnel:qasper-answers`（每道可回答题卡在哪一步）、`latency:qa`（QA 路线的耗时拆成查询 embedding、答案模型、路线自己的开销，给 token 和按单价算的成本；`--compare` 按题配对两次运行）、`label:answers`（人工标注页和 LLM 评审的输入）。机器醒着在 QASPER dev 的同一个 200 题样本上跑了四次（默认 topK 10 三次、topK 6 一次；rag 面，qwen2.5:7b，Ollama，M5 Pro，一次一题）。只测量，不改默认。
- **漏斗**（177 道可回答题）：证据不在 10 个候选里 34 题（19.2%）；证据在候选里但被门控拒答 56 题（31.6%）；作答但证据不在上下文里 10 题（5.6%）；作答且证据在上下文里 77 题（43.5%）。68 次拒答全部来自门控。最后一档的 F1 均值也只有 0.32，F1 ≥ 0.5 的 14 题；没有证据也作答的 32 题均值约 0.12。23 道不可回答题答了 12 道。
- **怎么读**：最大的损失在门控（三成题证据已经找到却没答），不是检索；而门控的信号区分力弱（3.12），调阈值只是换错误，要换信号。答了且有证据的 77 题分数低，不全是答错：作答的 109 道可回答题答案中位数 35 个词，最短的参考答案中位数 6 个词，完整包含参考答案的 35 词回答 token F1 也只有约 0.29；按词面看，77 题里 31 题的回答包含某份参考答案的全部词，20 题连一半都不到；词面差得远可能是答偏，也可能是换了说法，词面召回不判对错。到底对多少，要人工标注。
- **延迟**（QA 路线进程内，作答的 121 题）：整题 p50 2.4 秒、p95 3.9 秒，99.5% 在答案模型；查询 embedding p50 8 ms，检索、门控、选上下文合计 p50 3.4 ms。拒答的题不调答案模型，p50 17 ms。模型时间里预填和解码各占一半（预填约 950–970 token/s，解码约 53 token/s）。三次默认配置的运行 p50 是 2,315 / 2,423 / 2,414 ms；按题配对，相邻两次的差含 0（+113、+76 ms），首尾两次差 +189 ms [+52, +327]、不含 0：机器在 45 分钟里越跑越慢，同一设置可以差到约 0.2 秒。
- **topK 10 的延迟代价**（上一轮没量出来的那一项）：同一个 Ollama 进程里先后跑 topK 6 和 10，两次都作答的 118 题按题配对：整题均值 +604 ms [+438, +791]（换进程、次序相反的重复是 +535 ms，漂移把真值夹在两者之间），p50 1.75 秒 → 2.40 秒（+37%），输入 token 均值 +437 [+398, +474]（+36%），输出 token 没有检出变化。拆开看，确定的部分是读上下文的预填 +0.42 秒 [+0.37, +0.47]（换进程重复 +0.45 秒），其余在解码里，区间含 0。同一次重复里答案 F1 仍没有检出差别（全部 200 题的官方 F1 −0.001 [−0.021, +0.017]），上下文含证据 +0.045 [+0.017, +0.079]。方法上的一个坑：同一个进程里后跑的那一臂有 7 次请求（121 次里）复用了前一臂给同一道题留下的提示缓存，各省 0.14–1.2 秒预填，摊到整臂约 45 ms；以后两个设置各用一个新进程。
- **token 与成本**：每道作答题输入均值 1,660 token（p95 2,165）、输出均值 66 token（p95 145），是模型端点返回的实际用量；入库每篇论文约 6,300 个 embedding token（估算）。成本公式是 (1,660.5 × 输入单价 + 66.4 × 输出单价) ÷ 10⁶；带入示意单价（每百万输入 1 美元、输出 4 美元）是每 1,000 道作答题 1.93 美元，在这组单价下 86% 是输入。这是算术，不是账单。
- **采样温度**：应用不传 temperature，Ollama 这个端点默认 1.0（服务日志每次请求都是 `temp = 1.000`）。所以同一设置三次的作答集合逐题相同（门控和检索是确定性的），答案不同：三次的官方 F1 是 0.2079 / 0.2046 / 0.2073，上一轮同一设置的那次是 0.2146。读任何一个 0.01 以内的 F1 差别都要先想到这一点。
- **标注页**：121 条答案的标注页和评审输入已生成，页面实际操作过（打标、翻页、导出、导入），进度保存和恢复由测试用页面自己的脚本覆盖；合并前的独立复查在页面里找到并修掉了四个会弄错或弄丢标注的问题（按住数字键连发、点按钮后按空格或回车、两个标签页互相覆盖、同名页面换报告后旧结论套到新答案上）；还没有人标；评审模型要和作答模型不同，本机只有 qwen2.5:7b，所以 LLM 评审仍未校准。
- **边界**：一台机器、一个本地 7B、串行，没有并发；是 MCP `archive_ask` 这条路的进程内耗时，Agent `/chat`（规划、自检、定稿、数据库往返）没有在真实模型下拆过；local 索引单篇文档，pgvector 的检索时间引用的是规模基准（单文档稠密 p95 不到 1 ms，100 篇混合约 20 ms）；成本只有公式和示意单价。
- **面试里的说法**：被问“F1 才 0.2，问题在哪”，按漏斗答：19% 检索没找到，32% 找到了但门控不敢答，6% 答了但证据没进上下文，44% 答了且有证据；最后这一档的低分一部分是长答案对短参考的 token F1（77 题里 31 题包含参考答案的全部词），另有 20 题连一半的词都没有，是答偏还是换了说法词面上分不出来，要人工标注才能说对多少。被问“一次查询多久、多贵”：本地 7B 上 p50 2.4 秒，99.5% 在模型，预填和解码各半；每次约 1,660 输入 + 66 输出 token，按输出单价是输入 4 倍算输入占成本 86%，所以 topK 是成本和延迟的主要旋钮，topK 6 → 10 是输入 token 均值 +36%、+0.6 秒（其中读上下文 +0.42 秒是确定的），换来上下文含证据 +4.5 个百分点。
- **提交**：c5286cb3（三个工具，报告存整段答案），942f300f（标注页导出），6161c59f（`latency:qa --compare` 和结果），其后一个提交是独立核对之后的修正（预填 / 解码的拆分、同进程对照的不对称、词面召回，漏斗拒绝没记录检索设置的报告），合并（5f5a8618）之后还有一个提交处理合并前复查的发现（标注页的四个问题、“三次运行两两都含 0”这句错话、几处过强的措辞、两个工具的小缺陷）；结果见 docs/evaluation.md “默认配置的答案漏斗、延迟和 token”。

### 3.37 检索候选数 topK 6 → 10：改了默认（2026-10-29）

- **结论**：`RAG_RETRIEVAL_TOP_K` 默认从 6 改为 10。规则先于运行：T8 和 T10 都过了前三个阶段（检索核对、门控护栏、答案），T10 对 T8 多出的上下文证据显著，所以选 T10；第四阶段上线检查只对 T10 做，也过了。QASPER dev 821 题：证据进入候选 0.704 → 0.784（+0.080 [+0.063, +0.099]），进入模型上下文 0.361 → 0.407（+0.046 [+0.032, +0.061]），前 3 名没有检出差异（−0.004 [−0.019, +0.012]，照记不裁决）；区间按论文聚类。
- **答案没检出变差，但也不能说变好**：dev 200 题（qwen2.5:7b，rag 面，样本排除了以前用过的 200 题）官方 F1 0.201 → 0.215（+0.013 [−0.008, +0.034]），可答题 F1 +0.019 [−0.001, +0.040]，两臂都作答的 106 题 F1 +0.027 [−0.006, +0.060]，多答 3 题，不可回答题被回答数不变（12/23）。同一设置跑两次（B、B′）F1 来回差约 0.01，作答集合逐题相同。
- **代价**：作答时模型多读约 1,700 字符（两臂都作答的题均值 2,876 → 4,557，输入 token 中位数 1,254 → 1,753）；不可回答题的门控拦截率 0.531 → 0.515（train + dev 367 题，护栏 −0.02，离线只差 0.004）。延迟在这一轮量不出来（阶段 C 跑在合盖睡眠里）：B 跑两次中位数就差 16%，T10 是 1.18×。2026-11-10 机器醒着重测：每道作答的题 +0.6 秒，p50 1.75 秒 → 2.40 秒（见 3.38）。
- **上线检查**：`verify:quality` 18/18；两个确定性评测（near-duplicate、compare-hard）的报告在 6 和 10 下去掉 id、时间戳和耗时后逐项相同（只差 topK 和由它算出的配置哈希）；锁定基线换成 v2（在 pgvector 上重跑，指标和用例与 v1 逐项相同），manifest 1.15.0；全套测试（含一次性 pgvector 上的集成套件）和 pgvector 上的 `quality:current` 通过。
- **边界**：Agent `/chat` 的主检索、follow-up 和自定义 Skill 按意图自带 topK（`INTENT_OPTIONS`：fact 4、timeline 9、comparison 8、analysis 10），不读这个默认值；Agent 里读它的只有门控拒答后补缺规划器的补充检索和 `research_brief` 的逐问子调用，这两处跟着变成 10，没测。这次改的主要是 MCP `archive_ask`、直接调用 `chat()` 和评测口径；只在本地 7B 上测；交叉编码器重排现在是 30 选 10，权重和概率门槛没重测；阶段 C 跑在合盖睡眠里，延迟当时量不出来（2026-11-10 醒着重测了，见 3.38）。
- **面试里的说法**：上一轮最强的信号（topK 10 候选覆盖 +0.09）没有直接采纳，因为它同时改变模型读到的上下文；这一轮先写规则，把检索、门控护栏、答案质量和成本分开量，B 跑两次量噪声，加一条"T10 必须比 T8 多出收益"的选择规则，再过上线检查才改默认。说法是"证据进上下文显著变多，答案没检出变差，代价是模型多读约六成上下文"，不是"答案变好了"。
- **提交**：f42ccedf（工具和规则），72af7c0a（改默认、基线 v2、`--exclude-report` 收多份），结果见 docs/evaluation.md "候选数 topK 6 → 8 / 10"。

### 3.36 检索默认参数在 chunker v2 上重测：没有一个臂过线，默认不变（2026-10-29）

- **结论**：块大小 / 重叠 / 融合权重 / RRF k / 融合方法这些默认值（来自 4–6 月、说明为空的提交，此前从没在 QASPER 上变过）按事先写好的规则在 QASPER train seed 11（400 题 / 311 篇）上重测：7 个决策臂没有一个的候选覆盖显著高于基线（delta：C600 −0.020、C1200 −0.0025、O0 +0.0025、O360 −0.020、W50 −0.015、K4 −0.0025、FW +0.0025；按论文聚类的下界 −0.049 / −0.024 / −0.013 / −0.036 / −0.044 / −0.012 / 0，O360 显著更差，FW 下界正好 0 不算过），所以阶段 2/3 没跑、默认不变。`eval:qasper-retrieval`，nomic-embed-text 经 Ollama，local 索引，无对话模型，配对 bootstrap 95% 区间按论文聚类、10000 次。
- **先核实的三件事**：环境可复现（train seed 1 和 dev 821 题都与 10-08 的报告逐题相同；B 跑两次逐题相同，噪声底 0）；算术推论实测成立（默认权重 0.65/0.35、k=60 下稀疏独有候选最高 0.35 分，低于稠密第 8 名的 0.583，所以最终 6 个候选永远是稠密前 8 的子集：seed 1、seed 11、dev 共 1,621 题里稀疏独有候选为 0）；每臂真正只差它那一个变量（报告新增 `config.retrieval`，`--compare` 会列出差异并拒绝样本不同的报告）。
- **两个值得说的机制**：(1) 稀疏路不是没用——纯余弦前 6（D）对 B 上下文含证据 −0.0275 [−0.047, −0.010]、dev 上 −0.0171 [−0.034, −0.001]（dev 上纯稠密的前 3 名反而 +0.033 [+0.006, +0.060] 更好：两路都在的块一律排在稠密独有的块前面，净 27 题的证据被挤出前 3 名（多数是稠密独有的）；所以贡献在前 6 的组成和门控，不在前 3 名的名次）：B 把稠密第 7、8 名里词法匹配好的证据抬进前 6；(2) 让稀疏独有候选进来（W50、K4）不提高候选覆盖，却显著提高"门控作答"和"上下文含证据"——能翻门控的稀疏独有候选按构造词覆盖 ≥ 0.51，但 W50 新增的 33 题作答里证据真被放行的只有 2 题，K4 的 18 题里 0 题：这是门控耦合，不是候选覆盖变好（W50 净 −6 题；它多放行的 10 题里 8 题是只有稀疏路返回的证据），不可回答题会不会同样多放本轮没测。
- **只记录的最强信号**：topK 10 的候选覆盖 +0.0925 [+0.064, +0.123]、上下文含证据 +0.0475 [+0.027, +0.070]，前 3 名不显著（−0.0025，6/7 翻转），代价是放行上下文 +226 字符/题（约 +25%）；T8 的前 6 名与 B 零翻转，只在第 7、8 名补了 15 题（其中 7 题的证据原在稠密第 4–6 名，被两路都在的块挤出前 6）。按规则不改默认，要改得先测答案质量和成本（下一轮测了，改了默认，见 3.37）。
- **面试里的说法**：这一轮的价值在方法：规则先于运行、三个对抗审查把 k=5 改成 k=4（k<4.83 稀疏候选才进得来）、D 臂补上 `RAG_RETRIEVAL_SCORING_MODE=dense`（不然纯稠密路会混入词覆盖打分）、区间按论文聚类、B 重复一次量噪声；结论是"没有哪个臂被证明更好"，不是"默认值最优"。
- **提交**：c7d14df1（工具和规则），结果见 docs/evaluation.md "检索参数在 chunker v2 上重测"。

### 3.35 Claim 检查两侧对称：逐字引用按构造通过（2026-10-28）

- **结论**：词法 claim 检查对逐字原句的拒绝率从 29.9% 降到 2.5%（QASPER train 前 120 篇论文、2,521 句，离线复放不调模型，`classify-refusals.mjs`），剩下的 64 句里 44 句只是 `;` 前半段没有 `[Source N]`（`RAG_CLAIM_SOURCE_INHERITANCE` 的范围，默认关，没有改）。六处修改都是让 claim 侧按证据侧的规则读词，或一字不差时直接通过，不放宽对释义的判定；五个新用例各带一个改了事实的对照仍被拒。全套 4,018 过、0 败；确定性评测改前改后逐行相同，trajectory 19/19。
- **六处不对称**：词内数字被 `stripNumericValueSurfaces` 删掉（`BIBREF20`→`bibref`、`seq2seq`→`seq`，755 条拒绝里 531 条缺 `term:bibref`）；子句切分吃掉的 however / but / while 仍被当 claim 词项和主语绑定词；additive 词组没过别名表（`references` 对 `reference`）；数字事实的歧义规则连一字不差的子句也拒（`13,215 ... six domains`）；证据句只在和 claim 完全相等时整句参与，跨子句的逐字引文没有任何一段装得下；整句参与后反转启发式对重复词误判。
- **面试里的说法**：这是对"按构造通过校验"前提的修正——此前逐字引文只有七成能过，不是模型的问题，是校验器两侧读法不一致；修完后抽取模式的 `unsupported` 回退、agent 面的引用召回、finalizer 对散文的保留率都需要重测（未做，要先写规则）。要主动说：数字事实的"同文通过"第一版用去掉符号的比较，7 个既有用例（`+2`/`-2`、`$500`/`€500`、`~2`/`2`）立刻失败，改成保留符号、运算符、币种、约数标记的比较才过。
- **提交**：fb737f28（代码和用例），细节见 docs/evaluation.md "Claim 检查两侧对称"。

### 3.34 抽取式作答模式：同一思路搬到单文档问答，阶段 1 没过（2026-10-22）

- **结论**：加了默认关的 `RAG_QA_EXTRACTIVE_OUTPUT`（模型返回最短确切答案 + 逐字引文，服务端渲染成 finalizer 写法的行，响应多 `directAnswer`）。按事先写好的规则在 QASPER train seed 5（100 题）上测：Agent 路径从几乎不作答变成作答 35/88，短答案 F1（`f1Direct`，拒答记 0）+0.131 [0.074, 0.194]，作答行引用证据召回 0.43；但不可答题多答了 3/12（基线 0），rag 面因引文定位失败少答 17 道可答题、短答案指标持平。两个面各有一条规则没过，按规则停在阶段 1，开关保持默认关。
- **先核实的前提**：抽取式题占可答题 63%、其标注片段 95% 逐字在证据页里；是非题参考答案 99% 就是 Yes/No；finalizer 删掉所有不带 `[Source N]` 的行、`No [Source 1]` 会被极性否决，所以 Yes/No 只走字段；JSON 不能过草稿通道的逐句切分。
- **度量的公平性**：候选和基线都用同一条"短答案"规则打分（`directAnswer`，没有则第一句），官方 F1 和全文 F1 只记录；不可答被回答用硬规则。
- **第二轮（同日，提交 ebc2c207，规则先写再跑，train seed 6，100 题）**：加了两条——直接答案没定位到引文句就不作答（`answer_ungrounded` / `answer_empty`）；抽取尝试任何失败都用同一上下文回退到散文 prompt（trace `fallback: "prose"`）。结果：rag 面作答集合与基线完全相同（58/86、不可答 8/14，同一门控），短答案 F1 +0.033 [−0.005, +0.076]，r1 差一点不过；agent 面作答 2 → 28/86（+0.302 [0.198, 0.407]）、短答案 F1 +0.085 [0.038, 0.140]，但不可答仍答了 2/14（两道的直接答案都是引文里的逐字片段）、作答行引用证据召回 0.29，a3、a4 不过。停在阶段 1，开关仍默认关。回退比例 rag 34/66、agent 36/67，每次回退多一次模型调用（rag QA 延迟中位数 1.25 → 1.87 s）。
- **两条机制发现（离线复放，不调模型）**：把 QASPER 原句逐字渲染成 `<句子> [Source 1]` 交给词法 claim 检查，29.9% 被拒，去掉 `BIBREF2`/`UTF8gkai` 这类占位符后 10.4%（claim 侧把 `BIBREF2` 读成词项 `bibref`，证据侧没有），所以"逐字引文按构造通过"只有七成成立；渲染器删不受支持的行时用包含匹配，直接答案行被拒会连带删掉包含它的引文行（7 道 `unsupported` 里 5 道）；后者已在代码清理里改成逐行检查（未重测），前者已于 2026-10-28 修复（3.35）。
- **第三轮（2026-10-28，提交 624a02b1，规则先写再跑，train seed 9，100 题，86 可答 / 14 不可答）**：加"直接答案所在的引文句必须按门控的锚点、共词、近邻替换三条检查回答问题"（trace 码 `answer_unanchored`，同样回退散文），两侧对称修复和逐行检查也一起进入测量。rag 面作答集合仍与基线相同，短答案 +0.006 [−0.035, +0.049]，r1 不过（54 次尝试回退 37 次：新规则 15、未定位 13、无引文 5、定位失败 4，`unsupported` 从第二轮的 7 降到 0）；agent 面 2 → 22/86（+0.233 [0.151, 0.326]）、短答案 +0.055 [0.023, 0.093]、不可答被答 1/14（"Which languages do they focus on?" 答 "African languages"，标注边界题）、引用证据召回 0.32，a3、a4 不过。停在阶段 1，开关默认关，不再做第四轮词法规则：定位、回退、锚点三种手段用尽，a4 的 0.4 对这个模型始终过不了。
- **面试里的说法（三轮合并）**：三轮都按事先写好的规则判定为不通过、没有改默认，这本身是方法论证据；能稳定复现的收益是 Agent 路径从几乎不作答到作答 22–35/86 且短答案显著更好，稳定复现的代价是不可答题多答 1–3 道、作答行引用证据召回 0.3 上下。
- **面试里的说法**：这是"按构造通过校验"思路的第二次应用，证明了它能让 Agent 路径作答，也暴露了代价：模型总能挑出一句引文，不可答题会被多答；"直接答案必须定位"把错答从 3/12 压到 2/14 但压不到 0，因为模型会从相关句子里挑片段。要主动说：只在 7B 上测过，两轮都停在阶段 1，默认关；离线复放发现词法校验对逐字原句也有一到三成拒绝率，这是下一步的优化点。

### 3.33 对比答案结构化输出：模型选证据、服务端写答案（2026-10-21）

- **结论**：加了默认关的 `RAG_COMPARISON_STRUCTURED_OUTPUT`。打开后 qwen2.5:7b 的对比答案采纳率从 0/16 变成 12/16（补齐近重复漏引之前是 10/16），被词法检查拒掉的 claim 从 171/175 变成 0；`verify:quality` 两边都是 18/18（compare-hard 真实模型各 3 轮加 `verify:quality` 1 轮，按 trace 的 `modelRejectReason` 统计）。默认仍关：只在这一个模型上测过。
- **做了什么**：对比 prompt 换成 `comparison_answer_structured`（strict JSON Schema）：模型按差异点给每份文档一条逐字引文和 Source 编号；服务端把引文定位到证据句（数字必须一字不差）、按"说法相同"分组、每两组之间两两配对写成 `<文档> states <句子> [Source N]`，再过原来的闸门。引文不在证据里、编号不在给过的范围里、只覆盖一份文档的差异点都丢掉；解析失败回退模板。
- **近重复漏引**：三文档（两份近重复 + 一份冲突）用例里模型每轮都只引两份，改 prompt 没用；现在由服务端补齐：漏掉的文档和已引文档是近重复对、自己的证据里又有同一句话，就替它补上这一句，和伙伴同组、只和说法不同的文档配对。补齐后这个用例 3 轮都被采用。
- **没变好的**：语料外用例模型返回空列表，和以前一样拒答；另有一轮里一个两文档用例的两条引文都改了措辞、定位不到证据，回退模板，答案和基线相同。
- **一个坑**：第一版把每份文档各写一行，三文档用例 6 行全被判不受支持：差异段的校验要求能两两配成"不同文档、实质对立"的对子，奇数行整段作废，所以改成按组两两配对（同一行可重复），和模板同一写法。
- **面试里的说法**：7B 写不出能过词法校验的对比散文，但能选对证据；把"写"交给服务端，校验就按构造通过，闸门一行没改。要主动说：只在 7B 上测过；近重复的漏引是服务端用"同一句话"的硬条件补的，不是模型学会了。

### 3.32 多租户加固阶段 1–5（2026-10-18）

- **结论**：阶段 1–5 已合并进 main（`5dc46718`）。新增的加固项大多是开关、默认关（默认就生效的几项列在下面）；全部打开的组合在一次性真库和 Docker 演示里各验证过一次。代码改动本身的开销：同机压测 `/chat` 吞吐变化在 −3.5% 到 +1.5% 之间。
- **做了什么**（威胁模型、分层和开关见 `docs/tenant-isolation.md`）：
  - 阶段 1–2：开鉴权时拒绝空租户范围、审计进行级安全（迁移 032）、反馈进行级安全（034）、strict 租户上下文、数据库角色拆分（035：运行时登录不拥有任何表，system 工作切到 NOLOGIN 的 system 角色）、健康检查查角色属性和没有策略的表、探针只回 `{status}`、输入上限。
  - 阶段 3：工作区注册表和成员校验（036）、按租户限流和并发、按租户公平的模型排队、模型和存储配额、用量账本（037）、任务上限。
  - 阶段 4：租户擦除和导出（038）、保留期清理（039）、删除联动和可选脱敏（040）、审计哈希链和 `audit:verify`（041）、数据访问审计事件。
  - 阶段 5：按租户的信封加密（AES-256-GCM，每个对象一把数据密钥，由租户密钥包裹），擦除工作区时销毁它的密钥。
  - 同一批里还有：文档回收站、备份恢复演练、长期记忆按工作区、缓存按租户分区、拒绝计数进用量账本、前端工作区切换器。
- **默认关**：成员校验（`TENANT_MEMBERSHIP`）、strict 上下文（默认 `lenient`）、角色拆分、按租户限流和并发上限、模型和存储配额、加密（`TENANT_ENCRYPTION`）、回收站（默认直接删除）、删除脱敏、数据访问审计、保留期清理（默认永久保留）、长期记忆按工作区（默认 `user`）、缓存按租户分区（默认 `shared`）。默认就生效的：开鉴权时拒绝空租户范围、探针对外只回 `{status}`；以及 `no-store` 缓存头、输入上限、按租户公平的模型排队、审计哈希链、用量账本（有数据库时）。
- **验证**：`deploy/demo/hardened.env` 一次打开上面所有开关，下面的端到端测试和 Docker 演示用它。2026-10-18 的完整验证（`docs/tenant-isolation.md`，提交 837345f2 前后）：
  - 后端全量在一次性 PostgreSQL 18.6 + pgvector 0.8.6 上跑，同时提供 Redis 和旧版本检出：4038 项，4036 通过、0 失败、2 项跳过（需要流复制副本，另用副本脚本补跑 5/5）；前端 177/177，构建成功。`test/tenant-isolation-hardened.e2e.test.mjs` 用这份配置在真实 PostgreSQL 上启动 `node server.js`，跑 seed、walkthrough 和一次真实擦除。
  - 确定性评测：trajectory 84/84、planner（mock）27/27、recovery 29/29 项检查，合成评测与固定基线一致。
  - Docker：镜像构建成功，`compose.demo.yml` 下三个容器都健康；walkthrough 连跑两遍都是 26 PASS / 0 FAIL / 1 SKIP（审计链只能在命令行校验）；之后对容器里的库跑 `audit:verify`：63 条记录、5 条链，全部通过。`docs/demo-tenant-isolation.md` 里"只用 `docker compose config` 验证过"是这次之前写的。
  - 没覆盖的：演示只有单实例单体，拆分部署、Redis 共享状态、读副本都不在里面；拆分部署的 `compose.services.yml` 仍只用 `docker compose config` 校验过。
- **开销**（`run-load-test-pgvector.sh --tenant --model-latency-ms 0 --repeat 3`，main 与本分支同机依次跑，3 次平均）：`POST /chat` 吞吐在并发 1/4/16/32 下 −3.5%、+1.5%、+0.2%、−2.1%，并发 32 每请求 CPU 约多 4–5%；`GET /documents` −5.8% 到 +0.5%。本地存储模式并发 32 的 −10.7% 两边各只跑了一轮，而并发 32 不同轮次本身漂 15–20%，不能当成确定的开销。
- **局限**：本地 KMS 只是演示级，生产要换云 KMS 或 HSM（接口留了，没实现）；加密只覆盖文件字节，切块文本、向量、run 快照、反馈和记忆仍是明文，擦除会删掉它们，但旧备份里还在；没有 Redis 时限流按进程计数，擦除碰不到别的进程的内存缓存；没有 PITR、按租户恢复和 BYOK；内部通信不是 mTLS。
- **面试里的说法**：多租户是分层兜底：入口只从凭据解析租户，行级安全兜漏写的过滤，strict 和角色拆分兜丢失的上下文。加固项大多默认关、可以逐个打开，全开组合有一套端到端测试和一次完整验证。要主动说：本地 KMS 是演示级，加密不覆盖切块和向量，拆分部署的 compose 没跑过。

### 3.31 PDF 按页分流与并行解析（2026-10-18）

- **结论**：已合并进 main（`692ca7da`）。两个开关都默认关（`PDF_PARSER=pdfjs`、`PDF_PARSE_WORKERS=0`），默认路径和改动前一样。`auto` 在 30 篇表格多的论文上答案 F1 和 pdf.js 没有显著差异，**不能说更好**；worker 池只在多个 PDF 同时解析时有用。
- **做了什么**：
  - `PDF_PARSER=auto`：每页先用 pdf.js 解析并采集信号（字符数、表格行、表格标题、图片覆盖率、乱码比例），按规则分成 `text`（保留 pdf.js 文本）、`layout`（docling-serve，不做 OCR）、`ocr`（docling-serve，强制 OCR）；后两类按 `page_range` 请求送 docling-serve，Docling 的文本替换这些页，请求失败的页保留 pdf.js 文本。
  - `PDF_PARSE_WORKERS`：pdf.js 放进 worker_threads，文档按页段并行解析。
- **分流**（默认阈值，38 个本地 PDF、290 页：30 篇按表格题挑出的 QASPER 论文加 8 个合成文档，只跑 pdf.js）：105 页 `layout`（103 页因为表格行、2 页因为表格标题），185 页 `text`，0 页 `ocr`；合成文档一页都没送出去。阈值就是看这 30 篇论文定的，不是对路由器的独立检验。
- **真实 docling-serve**（CPU 版 1.37.0，同样 30 篇 QASPER 论文、266 页，一份接一份解析）：
  - `auto` 只送 105/266 页（39%），三种请求设置下总耗时 252.5–279.3 秒，整份 `docling` 329.6 秒，只少两成左右：每个请求都上传整个文件，docling-serve 也要为每个请求付一份固定开销。5 组里没有一个请求失败。
  - 发现并修掉一个问题：Docling 把跨页段落合成一个文本项，原来整段记在第一页，引用页码不准。按字符区间拆回各页后，`auto` 用 Docling 文本的 105 页里，和整份转换逐字相同的从 64 页升到 80 页（不合并）/ 89 页（合并间隔 2），最低 token Dice 0.866 → 0.998。这也改了 `PDF_PARSER=docling` 下跨页段落的页码。
- **答案质量**（`eval:layout-parsing -- --parsers pdfjs-paragraphs,auto`，qwen2.5:7b，30 篇论文、149 道可回答题，配对 bootstrap 95% CI）：全部题 F1 0.197 → 0.202，+0.005 [−0.020, +0.032]；表格题（69 道）+0.008 [−0.031, +0.053]；每个区间都含 0，**不显著**。解析耗时 1.3 秒对 263.7 秒。
- **worker 池**（同样 38 个 PDF，只取文本）：38 个同时解析，进程内 0.79–0.96 秒，4 个 worker 0.30–0.48 秒；主线程最长的事件循环停顿 21–33 ms → 7–9 ms。一个接一个解析没有收益，第一遍还多付约 250 ms 的 worker 启动。页面文本和信号与进程内解析 8 × 38 次对照 0 差异；默认路径和改动前的代码 230 次对照 0 差异。
- **OCR 路由**：只有 1 份样本。把一篇论文的前 3 页按 150 dpi 渲染成没有文字层的页，3 页都判成 `ocr`，OCR 文本对原文的 token 召回 0.930–0.968。只说明能走通，不代表扫描件的整体质量。
- **局限**：只在 CPU 版 docling-serve 1.37 上测过，没测 GPU、其他版本、真实扫描档案和乱码文字层；3.14 里 Docling 整份解析那一臂用的还是修复前的跨页归属。
- **面试里的说法**：按页分流把表格页和扫描页交给版面模型，只送了 39% 的页，耗时却只少两成，答案 F1 也没有显著差异，所以默认关；worker 池的主要收益是大 PDF 不再卡住事件循环，文本逐字节不变。跨页段落记错页的 bug 是接真实服务才发现的。

### 3.30 删除原生图调度器（2026-10-16）

- **做了什么**：用户决定提前结束 ADR 0001 约束 12 的回退窗口，删除原生图调度器（ADR"阶段 6 结果"）。约束 12 原定 LangGraph 成为默认后 `AGENT_RUNTIME=native` 至少保留一个发布周期；分支还没推送、没发布，这个周期还没开始算。这一条是被明确豁免的，不是"窗口过了"。
- **删了什么**：`runExecutionGraph` 的调度循环；custom-Skill 阶段和 v3 阶段里的 native 分支；`getAgentRuntime()` 和依赖它的分支（启动恢复总做线程核对，规划器的模型调用总经 LangChain ChatModel 适配器，只有 LangSmith 追踪变量为 true 时直接调用）；守住回退路径的套件及其守卫；各 parity 套件里的 native 一侧。
- **留下什么**：准入、收尾、已结算图的回放（`replayExecutionGraphRun`，不调度）和单节点执行模块不变；外层计划的原生循环当时不动（3.29 的决定；2026-11-13 阶段 7 已删除，见 3.48）；V1 顺序链和 `AGENT_SKILL_GRAPH_ROLLOUT=off` 仍可用（当时；2026-11-13 阶段 8 已删除，见 3.49）。
- **拒绝已删除的取值**：`AGENT_RUNTIME` 只接受未设置、空值或 `langgraph`。设成 `native` 或拼错的值，`server.js` 和拆分部署的每个角色都拒绝启动（`AGENT_RUNTIME_REMOVED`），`createAppServices` 也在建任何服务之前拒绝（所有进程内 app）；不建 app、直接调用 `runAgentRag` 的 eval runner，在请求要调度图的那一刻（custom-Skill stage、v3 入口、执行器）以同一个错误失败，trajectory 报告里是一条 `case_error`。不调度图的请求不受影响，它们在两种 runtime 下本来就走同一份代码（这是阶段 6 当时的范围；阶段 7 起外层计划的入口也查，走到外层计划的请求同样被拒，见 3.48；阶段 8 起同样的位置还拒绝 `AGENT_SKILL_GRAPH_ROLLOUT` 的 `off`、`shadow` 和拼错的值，见 3.49）。
- **等价怎么保住**：删除之前先把 native 一侧的结果冻结成 golden：第一批 6 个套件、94 个文件；评审发现路由层（v3 批准/拒绝、v3 流、后台任务的审批重入、启动恢复）和外层计划套件里三个跑 custom-Skill DAG 的用例没有冻结，又从 HEAD e1385c1c 以 `AGENT_RUNTIME=native` 补冻了 8 个文件，共 8 个套件、102 个文件，扫描太大的只存 sha256。这些场景现在只在 LangGraph 上跑一次、对照 golden，屏蔽规则与删除前相同，例外两处：v3 回放扫描原来在同一进程里不屏蔽地比较，现在屏蔽后比摘要；规划器 golden 规范化了临时端口和 V8 的 JSON.parse 位置后缀。原生 runner 的 52 个调度契约测试直接跑在 LangGraph 执行器上，断言一条没改。（v3 统一图 2026-11-14 阶段 10 已删除：它的 17 个测试文件和 44 份 golden 随它一起删，规划器 golden 摘要里去掉了统一图规划器的 21 条，见 3.51。）
- **golden 怎么改**：只有 `UPDATE_GRAPH_GOLDENS=1` 能从 LangGraph 改写；改写了也让本次测试失败，要先看 diff、在同一次改动里写明行为变化，再不带变量重跑。其他取值（如 `native`）一律拒绝。
- **回退**：没有运行时开关了，只能 `git revert` 这次提交。
- **数字**：覆盖率闸门 3,250 个测试，3,235 通过、15 跳过、0 失败，全局行覆盖 90.46%；`eval:trajectory` 19/19、`eval:planner` 7/7、`eval:recovery-observability` 8/8 与删除前屏蔽后逐字节一致；`test:pgvector` 101/101；`quality:current` 在删除提交 f7535832 上通过。代码量：`agent-execution-graph-runner.js` 478 → 295 行，生产代码净减 136 行，测试净增 265 行（不含约 5.3 MB 的 golden）。
- **局限**：golden 只记录删除前 native 在这些固定场景上的行为，不是对任意图形状的证明；只描述 native 自身行为的少量断言没有替代；两个 PostgreSQL 集成套件原来在 native 下也跑一遍，冻结要真库，没有做，现在只有 LangGraph 一侧和用例自己的断言（`test:pgvector` 里通过）；golden 在 Node 24 上生成；写这一节时 CI 的 Node 22 上还没验证，合并进 main 之后 CI 已在 Node 22 上带着这些套件运行并通过（阶段 7 新增的 32 个文件也一样，见 3.48）。
- **面试里可以讲**：回退窗口是手段，不是目的。分支还没发布时删掉第二套调度器，等于用"把旧实现的输出冻结成 golden"代替"两套实现长期并跑"；同时把它记成对约束的豁免，并写清唯一的回退方式。

### 3.29 LangGraph 迁移收尾：外层计划再测一次，定为长期原生（2026-10-16）

- **做了什么**：对照目标文件的"完成定义"逐条处理（ADR 0001"阶段 5 结果"）。外层 V1 计划的 LangGraph 实现从 StateGraph 改为底层 Pregel：按计划形状只编译一次，请求状态放在 `config.configurable`，未选中 Skill 的五个内置阶段静态剪掉。五个规划器的模型调用在 `AGENT_RUNTIME=langgraph` 下改走 LangChain 的 ChatModel 适配器，结果与原生一致（3.30 起只剩这条路径）。
- **开销**（微基准，桩阶段）：文档问答 416 → 143 µs CPU，7 阶段 1,086 → 347 µs；每次调用的 LangSmith `RunTree` 54 → 2。进程内同一个 `runAgentRag`：外层计划放到 LangGraph 上多 0.28 ms（原来 1.23 ms）。
- **压测硬门仍不过**：pgvector、模型 0 ms，native 与 langgraph 交替跑四轮、每轮 5 次。并发 1 时每请求 CPU 中位数 5.68 → 6.68 ms（+17.6%），p95 9.3 → 10.5 ms（+13%），超过 10%。并发 32 两对结果方向相反（同一配置不同轮次就漂移约 15–20%），不下结论。所以外层计划默认仍是原生循环（当时；2026-11-13 起只走 LangGraph，见 3.48）。
- **最终决定**（用户认可）：不放宽 10% 的门，外层计划长期保持原生循环，它不在要删的调度代码之列；LangGraph 实现留作实验开关。只有 LangGraph 升级后单次调用开销明显下降，才按同样的方法重测。（2026-11-13 已被用户的新决定取代：只留 LangGraph 一种运行时，原生循环和这个开关都删了；门没有重测，是明知不达标、接受代价，见 3.48。）
- **交回原生调度器的情形已消除**：两种调度器都改为按校验器的拓扑层序排队，LangGraph 不再把任何图交给原生调度器；v3 stage 的两处直接调用（结算回放、没有 run 目标的分支）也已替换，`AGENT_RUNTIME=langgraph` 下没有生产路径再调用原生图调度器。代价是不按层声明的图在 `native` 下执行顺序变了（生产里只有带 Web 的 v3 文档图，答案不变）。等价扫描覆盖 720 种声明顺序与压力组合，两种 runtime 精确一致；全量测试 3,300 个，0 失败。原生图调度器当时只等回退窗口结束再删（3.30 已按用户决定提前删除）。
- **没做的**：v3 统一图不设为默认（mock 下每请求 CPU 是 V1 的数倍到十几倍，还会改变拒答、Skill、错误码和流式草稿等可见行为；2026-11-14 阶段 10 把 v3 统一图整个删了，见 3.51）；原生调度器按"新默认发布一个周期"的约束保留（3.30 已按用户决定提前删除）；检索和工具适配器接进生产会改变 `/chat` 契约或缺预算与观测，不接。
- **面试里可以讲**：同一个门禁测了两次，第二次把框架开销削到四分之一，仍在低并发下超标；进程内微基准（+0.28 ms）会低估真实请求的开销（约 +1 ms），因为请求之间有空闲。结论是记录偏离和理由，不放宽门。（后续：2026-11-13 外层计划还是迁到了 LangGraph。门没有重测，也没有通过，是用户为了只留一种运行时、明知不达标接受这份开销，见 3.48。）

### 3.28 编排运行时迁到 LangGraph.js：阶段 0–4（2026-10-16）

- **做了什么**：按 ADR 0001（`docs/adr/0001-langgraph-runtime.md`）用 strangler 方式迁移，开关 `AGENT_RUNTIME=native|langgraph`，阶段 4 起默认 `langgraph`，`native` 作为整体回退保留一个发布周期（回退后未完成的 run 由原生路径从图 checkpoint 接管；3.30 已删除 `native` 和原生调度器）。`langgraph` 下 custom-Skill typed DAG 和 v3 统一图由 LangGraph 调度：节点执行代码和原生调度器共用（`agent-execution-graph-node.js`），状态只放回执，typed 输出仍在 agent run 的私有 checkpoint；审批用 `interrupt()` + `Command({resume})` 在同一线程续跑；checkpointer 是写现有 run store 的自定义 `BaseCheckpointSaver`，没有新表；取消走 drain（`RunControl.requestDrain`），不把请求 signal 交给 LangGraph（直接交会让在途节点被重跑）。LangSmith 永不启用（追踪变量为 true 时拒绝启动）。（v3 统一图 2026-11-14 阶段 10 已删除，LangGraph 调度的图只剩 custom-Skill DAG 和外层计划；节点停在审批门、同一线程续跑的代码还在共用的执行器里，没有生产调用方，下一步删，见 3.51。）
- **等价证据**：两种 runtime 下 `eval:trajectory` 19/19、`eval:planner` 7/7、`eval:recovery-observability` 8/8 屏蔽 id 和时间后逐字节一致；原生 runner 的 51 个测试改指 LangGraph 执行器全部通过；`test:pgvector` 109/109（含跨进程审批续跑、写入后崩溃转人工、拒绝审批）；`verify:quality` 18/18。
- **压测硬门（≤10%）先没过，后来过了**：最初把外层 V1 计划也编成 StateGraph，每个 `/chat` 多约 1.2 ms CPU：pgvector、模型 0 ms、每档 3 次，并发 32 时每请求 CPU 3.93–4.26 → 5.27–5.47 ms（+29–35%），p95 125–138 → 165–169 ms。剖析：LangChain core 每个节点调用都新建一个 `RunTree`（无法配置关闭），空的 3–5 节点图底价 0.38–0.59 ms，而 10% 的预算只有 0.4 ms，属于结构性开销。决定：外层计划保持 native 循环（改到实验开关 `AGENT_OUTER_PLAN_RUNTIME` 后面），LangGraph 只跑需要持久状态和中断的图。复测（同一 harness，各 3 次）：并发 32 每请求 CPU 3.78–4.20 → 3.82–4.34 ms、p95 121.8–123.5 → 120.6–126.4 ms，区间重叠，通过。（这是当时的决定，"通过"说的是外层留在原生循环时的默认配置。原生循环和这个开关 2026-11-13 已删除，现在外层也在 LangGraph 上，没有为它重跑压测，见 3.48。）
- **面试里可以讲**：框架迁移要有硬性的性能门和回退开关（这次的回退开关在分支发布前按决定删除，见 3.30）；这次门禁抓到了一个结构性开销，结论是"只把需要 checkpoint 和中断的图交给框架"，而不是全盘替换或调参硬过。（这个结论 2026-11-13 被用户的新决定取代：外层计划也交给 LangGraph，压测门没有重测、明知不达标，见 3.48。门禁抓到结构性开销这件事仍然成立。）
- **写放大**（阶段 4 接上 K=2 保留和完成即丢弃线程记录）：真库 `pg_stat_statements`，一次 2 节点 custom-Skill `/chat`，langgraph 比 native 多 7 次无事件 CAS、1 次 run 读、1 次事件表读；完成后 run 行的 `result` 11,894 字节（native 11,860，阶段 3 时 17,006）。
- **局限**：只用 mock 和确定性用例证明等价，不是真实模型的规划证据；部分不按层声明且并发受限的图仍交回原生调度器，所以原生调度器还不能删（阶段 5 已改为两种调度器都按层序排队，不再交回，见 3.29；剩下的只是回退窗口）；维护面要等删掉原生调度器后才会缩小（3.30 已删除，数字见那里）。
- 测试：阶段 3 提交时后端全量 3296 个（通过 3281、跳过 15、失败 0），全局行覆盖 90.46%；阶段 4 的数字见提交说明。

### 3.27 按句子装块：测了，默认没改（2026-10-05）

- 新增 `RAG_CHUNK_STRATEGY=sentence`：整句装块、不超过块大小、只用末尾整句做重叠、块不跨页；`simple` 输出不变。**当时说 `structured` 也不变，这不对**（2026-10-18 复查）：同一个提交重写了 `structured` 的超长段落切分和段落重叠，块从此不超过块大小（38 个本地 PDF 里 30 个切法变了，超过 900 字符的块 419 → 0）。保留了新行为，事后补测：dev 821 题上和旧 `structured` 没有可测差别（候选覆盖 +0.010 [−0.004, +0.023]，门控放行 +0.004 [−0.006, +0.013]）；train 400 题上第 1 名命中 −0.050 [−0.075, −0.028]、候选覆盖 +0.028 [+0.008, +0.050]。
- 事先定的规则下没通过：train 400 题选出 sentence 600/120（候选覆盖 +0.040 [0.005, 0.075]），但 dev 821 题上候选覆盖 +0.004 [−0.017, 0.026]、门控放行 −0.007 [−0.022, 0.007] 都没过 −0.01 的下界，前三名命中 −0.027 [−0.050, −0.004] 显著更差；30 篇 PDF 的片段命中均值为负。
- 所以默认仍是 `structured`。这里的"块会超大、整段块让第一名更好"只适用于 1dcc8467 之前的 `structured`（段落识别开启后 17.9% 超过 900 字符；和 3.26 的 183/2338 对不上，见那里；索引多存约三分之一重复文本，QASPER 上第一名、前三名命中更好）；现在的 `structured` 不超过块大小。`sentence` 能把块严格控制在大小以内、索引小 25%，可选，但不能说更好。
- 面试里可以讲：直觉上"更规整"的切块不一定检索更好，要用 train 选、dev 确认；这次 train 上的显著增益在 dev 上没有复现。

### 3.26 pdf.js 段落识别（2026-10-05）

- **做了什么**：pdf.js 每个排版行输出一行，同一段落被切成多个单元，块经常从句中开始。现在按行距、字号、缩进、列表标记判断段落边界，段内软换行按原有规则接回（标题、列表项、"标签:" 行、表格行、中文永不接）；行末连字符从严处理（`state-of-the-art`、全文别处写成连字符的词都保留）。开关 `PDF_PARAGRAPH_DETECTION`，**现在默认开**。
- **事先定的四条规则都满足才改默认**：
  - 55 份本地 PDF 不丢字（丢失 0）；每页行数 65.6 → 31.3；以句中开头的块 12.8% → 5.3%，结尾不在句末的块 68.9% → 48.1%。
  - 30 篇 QASPER 论文、149 个可回答问题（qwen2.5:7b）：答案原文片段在检索结果里 0.000 [−0.047, +0.047]；答案 F1 −0.0001 [−0.019, +0.020]。所有区间都含 0，**不能说更好**；检索那条没达到 −0.02 的非劣性下界，只靠"区间含 0 且均值不为负"那一条通过，证据很弱。
  - 确定性评测和固定基线不变（合成 PDF 在开关下文本完全相同，所以这两项其实测不到这个开关）。
- **改默认的理由**：块边界更贴近句子，而且没有显著变差，不是测出了提升。
- **副作用**：块变大了：切块器做重叠时把上一整段带进来，现在一个单元是一整段，183/2338 个块超过 900 字符（最长 1910；这是 1dcc8467 之前的 `structured`，现在的不超过 900），块文本总量多 21%（docs/evaluation.md"pdf.js 段落识别"一节的统计；"按句子装块"一节对同样 55 份 PDF、同样 2338 块记的是 17.9% 超出块大小，两处口径没写清、对不上，引用前要说明）。按句子装块的替代方案测了，没通过（见 3.27）。
- 已入库的文档要 `vector:reindex` 才会用上。测试：后端全量 2912 个（通过 2898、跳过 14、失败 0）。

### 3.25 PDF 切块丢字、单进程优雅停机（2026-10-04）

- **切块丢字**：pdf.js 一行一个换行，切块器把表格行、以冒号结尾的引导句当成标题；连续"标题"时后一个覆盖前一个，被覆盖的行、页尾的标题都没进任何块，也就检索不到。现在这些行保留为块的正文，标题不跨页。
  - 55 份本地 PDF（30 篇 QASPER arXiv 论文、25 份合成文档），按阅读顺序逐段对齐：丢失 **7,866 个非空白字符（612 段，涉及 28/55 份文档、119/336 页）→ 0**。总字符不变，块数 2,551 → 2,557。
  - 7 个合成评测语料的切块输出逐字节不变，所以确定性评测和固定基线都不受影响。这一步只说"消除丢字"，不宣称检索变好；已入库的文档要 `vector:reindex` 才会重新切块。
- **单进程优雅停机**：以前只有开了入库 worker 才处理 SIGTERM，开了 tracing 时 flush 完就退出，`docker stop` 会切断正在处理的 `/chat`。现在复用拆分部署的排空逻辑：停止接新连接、等进行中的请求（默认 25 秒）、停 worker 并交回任务、刷 trace、关连接池；第二个信号或超时强制退出；compose 停机等待 30 秒。测试在 `/chat` 处理到一半时发 SIGTERM：请求 200、运行完成、进程以 0 退出。
- 测试：后端全量 2892 个（通过 2878、跳过 14、失败 0）。

### 3.24 claim 校验缓存：单进程吞吐约 2.6 倍（2026-10-04）

- **问题**：每条结论都把引用重新切句、重算别名和数字归一化；一次没有补检索的 `/chat` 跑 2 遍完整校验，有补检索时跑 5 遍。压测里 agent 层占了大部分 CPU，就是这个原因。
- **做法**：只在一次调用、一次 `/chat` 内按完整输入缓存纯函数结果（切句、别名、数字归一化），内容完全相同的校验结果直接复用；不跨请求，读写都复制，防止被调用方改写。正确性：缓存开关两种情况下，所有 claim 校验测试的输出逐项相同；确定性评测和 `eval:trajectory` 的报告与改动前逐行一致。
- **压测**（单体、pgvector、行级安全、假模型 0 ms、每档 3 次，改动前用当前提交的副本跑；事先定的规则是 CPU 区间不重叠才算更快）：

| 并发 | 每请求应用 CPU（ms） | 吞吐（req/s） | p95（ms） |
| --- | --- | --- | --- |
| 1 | 12.0–13.4 → **5.1–5.8** | 63.5–71.4 → 110–139 | 17–22 → 8–9 |
| 16 | 12.2–13.7 → **5.0–5.8** | 82–91 → **226–230** | 201–224 → 79–82 |
| 32 | 11.7–13.5 → **4.6–4.9** | 83–94 → **239–258** | 394–413 → 139–148 |

  三档的区间都不重叠，按规则算"更快、吞吐更高"。数据库查询数和 PostgreSQL CPU 不变。拆分部署下 agent 层占总 CPU 62–67%（以前 84% 是另一天的测量，不是配对数据）。
- 局限：假模型的回答很短；真实模型的回答结论更多，加速比例没有测。这张表是外层计划还在原生循环时测的：阶段 7（3.48）之后，同一提交现在测出来的 `/chat` 每请求 CPU 会高约 1 ms，表里的数字没有重测。
- **CI 提速**：同一个任务里后端测试不再跑两遍（只保留覆盖率门禁那一遍，测试集完全相同）；发布门禁测试从约 63 秒降到约 28 秒。
- 测试：后端全量 2876 个（新增的缓存一致性测试会重放 7 个 claim 校验套件），通过 2862，跳过 14，失败 0。

### 3.23 另一轮代码审查的修复：安全、记忆、依赖、对比回答、引用精度（2026-10-04）

另一个会话（Fable 5.1 调度 56 个 Opus 5.5 子代理）扫出 43 条确认的问题，按它建议的顺序做了前 3 步。

- **安全与配置**：
  - 一键部署的端口默认只绑 127.0.0.1，数据库密码可配；
  - 不带 userId 的 token 不能再用 `x-user-id` 冒充同 workspace 的其他用户（审查还堵住了触发器 payload 里嵌套 userId 的绕过）；
  - 留空的数字环境变量不再被解析成 0（实测影响 29 个设置，例如 `.env.example` 里空的 LLMOps 预算让每个事件都"超预算"）。
- **依赖**：multer 1.4.5 → 2.4.0；另外 8 条生产依赖告警（3 高危）全部修复，`npm audit` 为 0。其中 pdfjs-dist 5.6.205 → 6.4.299（"打开恶意 PDF 可执行任意 JS"），升级前后 55 份本地 PDF 提取的文本逐字节相同；它要求 Node ≥ 22.13，所以 CI 从已停更的 Node 20 升到 Node 22（与镜像一致）。
- **会话记忆按租户隔离**（第 6 条）：以前会话记忆只按客户端传的 sessionId 存取，租户角色对会话表有全部写权限却没有策略，拿到或猜中别人的 sessionId 就能读、追加或清空对方的对话上下文。现在开了鉴权时，存储键是 `tenant:` + sha256(userId \0 workspaceId \0 sessionId)，读写清除都走它；迁移 031 给会话表加归属列和 tenant_isolation 策略，纳入健康检查。审查又堵住一个绕过：没有租户身份的调用方传 `tenant:` 开头的 id 会撞上别人的键，现在这种 id 不对应任何会话。代价：升级前的会话上下文对租户不可见（6 小时内被清理）。真实 PostgreSQL 上以租户角色直接写 SQL 读改删别人的会话，全部 0 行或被拒。
- **记忆污染**：补检索、研究简报子问题和后台任务的中间轮次，以前会把系统拼的文本当成用户消息写进会话记忆和长期偏好；现在只记录用户自己的那一次对话。
- **对比回答**：模型写成 `## Differences` 或"差异："的答案以前在校验前就被格式正则丢掉；现在按结构识别后照常做结论校验，兜底模板会先接上 PDF 软换行，不再输出半句。用 qwen2.5:7b 实测，这个模型的对比答案仍全部过不了词法校验（未标来源、换了数值说法），所以采用率没有变化，瓶颈在校验而不是标题格式。
- **引用精度（第一次测）**：QASPER dev 200 题、rag 路径、当前默认配置：
  - 作答时上下文里有证据 0.596 [0.500, 0.692]，而**答案实际引用的页里有证据只有 0.490** [0.394, 0.587]，配对差 −0.106 [−0.164, −0.048]，显著：11 道题证据在上下文里，答案却没引用它。
  - 引用精度 0.321 [0.248, 0.399]（每题标注证据只有一两段，标注之外的引用不一定是错引）；作答时没有引用的比例 0.019。
  - 以前文档里的"答案来源里有证据"实际是上下文指标，已逐处更正。
- 测试：后端全量 2659 个（通过 2645、跳过 14、失败 0），CI 在 Node 22 上通过；`verify:quality` 18/18。

### 3.22 OIDC 登录与 RBAC（2026-10-03）

默认都关：`API_AUTH_OIDC_ENABLED`、`RBAC_MODE=off`，不开时鉴权与以前完全一样。

- **OIDC 资源服务器**（`rag/oidc.js`，不加依赖）：从签发方的发现地址取 JWKS，缓存带 TTL；遇到不认识的 kid 时限速刷新（换密钥自动跟上，乱造的 kid 刷不爆 IdP）；IdP 挂了继续用最后一份好的公钥。支持 RS256 / PS256 / ES256 / EdDSA，算法必须和密钥类型一致，拒绝 HS*、none、对称密钥和 2048 位以下的 RSA。校验 iss、aud、azp、exp/nbf/iat（带时钟偏差）、可选 `typ: at+jwt`；吊销列表同样作用于 OIDC token。
  - 验签开销（公钥已缓存，1 万次）：RS256 p50 约 20 µs、ES256 约 48 µs，HS256 约 4 µs；相对 `/chat` 可以忽略。
- **本地开发 IdP**（`npm run oidc:dev`）：只绑 127.0.0.1、拒绝在生产环境启动；授权码 + PKCE S256（必需），授权码一次性、60 秒过期，失败一次即作废；refresh token 轮换，旧的被重用就吊销整条链；可以在线换密钥。
- **RBAC**（`rag/rbac.js`）：权限目录（读文档、上传、删除、提问、任务、记忆、反馈，加上原有的管理权限），角色 workspace.viewer / member / admin，加上原有的 admin.owner / operator / viewer；角色可以按 workspace 授予，只在那个 workspace 生效，而且 workspace 内授予的角色拿不到部署级的 admin 权限。一张路由权限表覆盖所有接口，有接口没登记时测试直接失败；不在表里的一律拒绝；拒绝写审计。拆分部署时在入口层统一检查。
- **前端**：授权码 + PKCE，access token 只放内存，校验 state 和 nonce；登录后按 `/auth/me` 的权限隐藏没权限的按钮，服务端仍是最终判断。
- **安全审查和修复**：
  - workspace 内授予的 workspace.admin 能读部署级的 `/admin/status`（跨租户的部署信息）：改为 workspace 角色只授 workspace 权限。
  - 默认角色 member 会把显式给的 viewer 抬成 member，viewer 什么也没限制住：改为只有没有任何 workspace 权限时才补默认角色。
  - **一个早就存在的租户隔离漏洞**：workspace 的权限匹配不区分大小写，但数据库租户用的是请求头原值，只被授权访问 `acme` 的 token 发 `ACME` 就进了另一个租户。改为 token 列了允许的 workspace 时统一用列表里的小写形式；workspace 角色只在租户名完全一致时生效。
- **端到端测试**：真实的授权码 + PKCE 流程拿 token，viewer 能读和提问但上传、删除 403；member 能上传不能删；ws-a 的 admin 只能删 ws-a；过期 token 401；IdP 换密钥后新 kid 通过，旧 kid 在缓存过期后被拒；经拆分部署的入口转发结果与单体一致。
- 测试：后端全量在 Node 24 和 Node 20 下都是 2616 个（通过 2602、跳过 14、失败 0）；前端 158 个测试通过，构建通过；覆盖率门禁通过。
- 没做的：没接过真实的 Keycloak / Auth0 / Entra ID（接入步骤按各家文档写）；RBAC 只管动作，不管文档可见性（文档仍按上传者过滤）；不带 `workspaces` claim 的 token 仍可选任意 workspace，文档要求 IdP 签发它（默认如此；开 `TENANT_MEMBERSHIP=enforce` 后用户必须是该 workspace 的成员，见 3.32）。

### 3.21 Agent 路径答题率：诊断、7 个开关、没有改默认（2026-10-03）

本地 qwen2.5:7b + nomic-embed-text，确定性规划器。先诊断再修，修完按事先定的规则测；结论是**一个默认都没改**，这是如实的结果。

- **先纠正了评测口径**：finalizer 输出的"证据不足"文本以前被 `eval:answer-drafts` 和 `eval:qasper-answers --surface agent` 算成"回答"，所以文档里"论文题答了 3/36"其实是 3 次拒答。现在统一按 `classifyAgentAnswer` 判定。正确口径下，评审关时 Agent 路径在 60 道 QASPER 训练题上一题没答，评审开时答了 3 题（人工核对都对）。
- **诊断**（逐次读 trace 归类）：
  - 检索阶段的词覆盖门控拒了 33/60（纯 RAG 路径拒的是同一批；其中 20 题候选里其实有标准证据）。典型是短问题两个词只命中一个（0.5 < 0.51），或词形不同（governs / governed）。
  - 补检索几乎全失败（61 次只过 1 次）：补检索把"请重新检查文档……"这段元文本当成了检索查询和门控基准。
  - 开评审后，最大的阻断是结论没标 `[Source N]`（评审只看有标签的结论）。
  - 路由误判：compare / between 被当成多文档对比，"RAG-Sequence"被当成时间线。
- **7 个开关**（默认都关）：补检索用原问题、门控和结论校验接受词形变化（数词、同形异义词精确匹配）、无标签句继承同行标签、章节标题作证据上下文、评审 temperature、单文档路由收紧。审查找出并修掉 3 类开关打开后会答错的缺陷：数词被归约（"Two thirds" 支持 "A third"）、同形异义词（United / units）、章节标题替结论补上了另一方当事人。
- **训练集测量**（QASPER train 50 题：41 可答、9 不可答；各组共用同一次模型抽样，配对 bootstrap CI）：
  - 评审关时，任何开关单开或全开，可答题都是 **0/41** 被回答：门控放行的题从 31 增加到 40，但词法校验仍然全部拒掉。
  - 只开评审：10/41，答题率 +0.244 [0.122, 0.390]，F1 +0.077 [0.023, 0.143]；但不可答题被回答 0/9 → 2/9。
  - 全开 + 评审：17/41，+0.415 [0.268, 0.561]；不可答题被回答 4/9，+0.444 [0.111, 0.778]，显著上升；新放行的答案里有明显错答（引用错误的 87% 准确率等）。
  - 规则要求"不可答题被回答不增加"，所以没有候选；开发集刻意没跑，留作以后的干净确认集。
- **第二轮**（评审 temperature 0 + 答案模型先判断证据里有没有答案 `RAG_QA_ANSWER_VERDICT` + 7 个开关）：
  - 训练集换新样本（seed 3，47 可答 / 3 不可答）：答题率 0.021 → 0.340，+0.319 [0.191, 0.468]；F1 +0.120 [0.054, 0.200]；不可答被回答 0/3。入选为候选。
  - **开发集确认**（100 题：91 可答 / 9 不可答）：答题率 **0 → 0.363，+0.363 [0.264, 0.462]**（+33 / −0 题）；F1 +0.123 [0.081, 0.170]；但不可答题被回答 **0/9 → 2/9**（区间 [0, 0.556] 含 0，不显著，可事先定的上限是"基线 + 1"，所以不通过）。两道里有一道标注者意见不一。
  - 按规则不改默认，护栏（评审对照集、`verify:quality`、合同题）没有跑；开发集 seed 1 已用过，以后确认要换新样本。
- **用户决定"护栏全过就作为产品决定设为默认"，补跑护栏**：评审对照集错误接受 0（改写接受 28/28）通过；合同和政策题两轮答错 0（回答 5/7、7/7，全关时 2/7）通过；**`verify:quality` 14/18 不通过**。原因是答案模型的"证据里没有答案"标记误触发：同一道单文档题重复 20 次，开这个标记时 10 次拒答（其中 7 次拒答文本里其实写着正确的值），关掉它时 0 次。文档只有 3 个块，补检索也救不回来。所以**默认仍不变**。
- **第三轮（用户选"修误拒答再测"）**：新开关 `RAG_QA_VERDICT_OVERRIDE=supported`（默认关）：模型打了"没有答案"标记、后面却写出带来源的结论时，结论全部通过确定性词法校验（数字、来源、问题里的名称和关键词都要对上，不用 LLM 评审）才按回答处理。独立审查又堵了 7 类会答错的情形（只答多子问题的一部分、答成别的实体、复述问题、指向"见附表"等）。
  - 新训练样本（seed 4，43 可答 / 7 不可答）：答题率 0.023 → 0.302，+0.279 [0.140, 0.419]；F1 +0.095 [0.037, 0.159]；但不可答题 0/7 → **1/7**，规则要求基线为 0 时也必须为 0，第一阶段就不通过，开发集和护栏没跑。
  - 复核逻辑在 QASPER 上判断了 42 次、**作答 0 次**（7B 的标记回复里大多没有带来源的事实句），它只对 `verify:quality` 那种"标记 + 值"的回复有效；那道被误答的不可答题走的是普通作答路径，和复核无关。
- **结论**：瓶颈是词法校验，7B 上"评审 + 先判断"能把 Agent 路径从几乎不答变成答三成左右，F1 显著上升，但每一轮都会多答一两道没有答案的题，三轮都没通过事先定的规则，所以默认全部保持关闭。要两头都顾，需要更强的答案或评审模型。
- 测试：后端全量在 Node 24 和 Node 20 下都是 2575 个（通过 2561、跳过 14、失败 0）；覆盖率门禁通过；`eval:trajectory` 84 项检查不变。

### 3.20 读副本、按服务的非对称身份、端到端截止时间、指标与 SLO 告警（2026-10-02）

都默认关闭，只有"依赖故障答 503/504"是默认就生效的行为变化。数字都在一台机器上测（主库、副本、应用、压测器、假模型同机），每个配置重复 3 次，写区间；判定规则事先定好。

- **读副本**（`POSTGRES_READ_REPLICA_URLS`，本机 Postgres.app 用 `pg_basebackup -R` 建流复制备库，不用下载）：只有带租户、标为只读、不在事务里的 pgvector 稠密和稀疏检索去副本；注册表、文档列表、运行和任务的读接口都留在主库。
  - 一致性靠设计：文档行和分块在同一个事务里提交，所以副本在同一次往返里先证明自己有每篇被检索文档的当前 `content_version` 和索引指针的当前 generation，不够新就交给主库；另有按 LSN 采样的最大延迟（默认 2 秒）。`/chat` 开始时的注册表刷新失败，这次请求整个只读主库。
  - 硬验收（真实流复制，`pg_wal_replay_pause()` 暂停回放）：在一个实例上上传、替换、删除，两个实例的 `/chat` 都没有缺失、过时或已删除的内容；回放恢复后读回到副本。
  - 压测（单体 ×2，行级安全）：主库语句每次 `/chat` 39.2 → 27.9（**−28.8%**），没达到事先定的 30%；只有并发 1（−34.8% / −32.5%）和延迟 0、并发 16（−30.2%）过线。原因是副本连接池（每进程每副本 10 个）满了，并发 32 时 32–40% 的只读语句回到主库；因为副本落后而回退的次数是 0。吞吐所有档位区间重叠，**不更快**。主库每次 `/chat` 的 PostgreSQL CPU 从 3.7–3.9 降到 2.2–2.3 ms（并发 1），但副本在同一台机器上，不是整机节省。
- **层间身份**（`INTERNAL_SERVICE_AUTH=hmac|ed25519|mixed`，默认 hmac）：每个服务只持有自己的 Ed25519 私钥，公钥绑定签发方；一张表规定谁能调谁；token 绑定请求方法、路径和请求体摘要；防重放缓存（有 Redis 时跨实例共享）。四进程测试里：截获的 token 重放被拒，用检索层的密钥冒充 api 被拒，agent 调 agent 被拒。`mixed` 用于从共享密钥不停机切换。
- **截止时间与取消**（`AGENT_REQUEST_TIMEOUT_MS`、`AGENT_CANCEL_ON_DISCONNECT`）：截止时间从入口一路传到 agent、检索、网关和模型调用；到点后进行中的调用被中止，运行在下一个安全点以 `deadline_exceeded` 结束，不会被启动恢复接手；已开始的写入型 Capability 不被打断，跑完后运行标为不可重试。依赖不可用时 `/chat` 返回 503/504 和 `Retry-After`，不再用"请求批准 Web 搜索"顶替（单体和拆分都改了）。
  - 测量发现并修掉一个真缺陷：被截止时间取消的模型调用被熔断器记成失败，5 次就把这个模型熔断 30 秒，影响进程里所有租户（234 次运行里 226 次直接 503）。修复后取消既不算失败也不算成功。
  - 修复后复测（默认熔断配置，截止时间 300 ms，假模型 800 ms，并发 4/16）：234 次运行全部以 `deadline_exceeded` 结束（504），0 次 503；失败延迟 p50 309 / 322 ms；进行中的模型调用全部被中止，排空后在途 0。
- **指标与告警**（`METRICS_ENABLED`，独立内网端口，可加 token，不加依赖，手写 Prometheus 文本格式）：HTTP 请求量/错误/延迟、Agent 运行结局、模型调用（次数、延迟、token、成本、熔断状态）、检索、入库队列、连接池、副本路由与延迟、进程。标签不含租户、文档、问题或原始路径。`deploy/prometheus/` 有按 SLO 消耗速度的多窗口告警（快：1h/5m 14.4 倍；慢：6h/30m 6 倍），每条附处置步骤；规则只经过测试里的解析和指标名校验，没有在真实 Prometheus 里加载过。
  - 开销（单体，并发 16/32）：每请求 CPU 关 12.4–12.6 ms，开 12.4–12.8 ms；并发 16 时吞吐开比关低约 1.5% 且区间不重叠，但事后复测的"关"与"开"重叠，所以**不下结论**；并发 32 完全重叠。
- 审查找出并修掉 18 个问题，包括：副本 guard 用错了指针快照（能读到没建完的版本表）；请求体绑定换个 Content-Type 就能绕过；写错的安全开关值悄悄回落到默认；Prometheus 3 下延迟 SLI 永远为空；所有请求都失败时可用性 SLI 不存在、快烧告警触发不了；熔断卡在半开时告警永远凑不满 5 分钟；超过 24.8 天的超时设置会让每个请求立刻超时。
- 测试：后端全量 2508 个（通过 2494、跳过 14、失败 0）；一次性 PostgreSQL 集成 95/95；真实流复制集成 5/5；覆盖率门禁通过；`eval:trajectory` 84 项检查与之前逐项相同。
- 没做的：CI 里没有副本（副本测试在 CI 报告为跳过）；compose 文件没加指标端口，也没真正构建过；副本语句只有连接超时，不受请求截止时间约束；统一图里非主节点的依赖故障仍返回 409。（最后一条随 v3 统一图 2026-11-14 删除而没有了，见 3.51。）

### 3.19 拆分部署：API / Agent / 检索 / 模型网关各自扩缩（2026-09-30）

同一个镜像，`ARCHIVE_RAG_ROLE` 选角色，默认仍是单进程。数字来自 `npm run eval:load-test:split`（`--topology split`）和单体对照：一台机器、假模型、行级安全（`--tenant`），每个配置重复 3 次，吞吐写 3 次的范围，全程 0 错误，模型调用全部经过网关（直连 0 次）。判定规则事先定好：某一层扩到 2 副本，吞吐至少 1.5 倍且区间不重叠，才算"扩了有效"。

- **每多一跳的代价**（拆成 4 个进程对单体 1 个进程，并发 1、模型延迟 0）：p50 12.7 → 17.0 ms（+4.3），p95 17.4 → 20.3 ms（+2.9）；每请求 CPU 在并发 32 时 11.7 → 14.1 ms（+21%，多出来的是层间 HTTP 和序列化）。拆分本身不更快。
- **模型延迟 0 时瓶颈是 agent 层**：它占全部应用 CPU 的 84%（claim 校验 memo 之前；之后另测的是 62–67%，不是配对数据，见 3.24），事件循环 p99 52–61 ms，其他层最忙的进程只用 0.05–0.08 核。
  - agent ×2：93.6–94.6 → 170.9–176.1 req/s，**1.84 倍**；agent ×4：255.5–263.1，**2.75 倍**（效率 69%，机器忙碌核数到 8 个，开始用慢核，PostgreSQL 也从 0.4 核升到 1.3 核）。
  - api、检索、网关各扩到 2：都是 1.00 倍——它们不是瓶颈，这是预期结果，数据能指出该扩哪一层。
- **模型延迟 800 ms 时瓶颈是网关的模型并发上限**（每进程 8 个槽位，8 / 0.8 s = 10 req/s）：网关 ×2 9.89–10.06 → 19.44–20.01 req/s，1.99 倍。要如实说：这是上限翻倍，不是算力增加；假模型的上游容量是无限的，用 Redis 共享一个全局上限时这个效果会消失。
- **同一台机器、同样 7 个进程，单体更好**：单体 ×7 398–408 req/s，拆分（agent ×4）256–263 req/s，单体 1.56 倍；800 ms 时 3.67 倍（单体 7×8=56 个模型槽位，拆分只有网关的 8 个）。拆分在一台机器上的价值只在"能只给瓶颈层加副本、各层故障隔离、模型调用集中管控（配额、计量、上游副本池）"，不在效率。面试里要主动说这一点。
- **行为不变**：端到端测试让 `/chat` 和 `/chat/stream` 依次经过 api → agent → 检索 → 网关，回答与单体逐字段一致，一个 trace id 贯穿四层；检索层结果与进程内 `deepStrictEqual`；别的租户的文档与不存在的文档返回一样的结果。
- **安全边界**：公网入口剥掉所有内部头；内部身份是 HS256 签名 token（固定算法、校验 audience/issuer/过期、常量时间比较、支持轮换），租户只从 token 取。限制：所有层共用一组对称密钥，任何一层都能签任何 issuer；token 60 秒内可重放；不是 mTLS。（默认 `hmac` 下至今如此；3.20 起可选 `ed25519`：每层一把私钥、公钥绑定 issuer，默认开防重放缓存；服务客户端在任何模式下都把方法、路径和请求体摘要签进 token，所以截获的 token 只能重放同一个请求。）
- 审查找出并修掉 14 个问题，包括：`GET /chat` 被当成幂等请求，在第二个副本上重跑 agent；慢客户端断开时 SSE 中继永久挂起；检索层接受空 docIds，Qdrant 下会搜到所有租户；检索和重排的依赖故障被当成副本故障，重试层层叠加；拆分后检索里的 embedding 和重排用量没计入运行上限；网关模式下重排沿用 600 秒预算；超过 8192 条文本的 embedding 被网关拒绝。
- 测试：后端全量 2351 个（通过 2340、跳过 11、失败 0）；一次性 PostgreSQL 上的集成套件 95/95；覆盖率门禁通过。
- 没做的：多机部署、K8s、服务发现；`compose.services.yml` 只校验过解析，没有构建和启动过；拆分模式下的入库压测。

### 3.18 检索调优：BM25、常见词剪枝、语义缓存、查询适配器（2026-09-27）

详见 `docs/retrieval-tuning.md`；都在本地 nomic-embed-text / qwen2.5:7b 上测。

- **真正的 BM25**（`RAG_SPARSE_SCORING=bm25`，**现在是默认**，由用户决定；`ts_rank_cd` 仍可选）：在 PostgreSQL 里按租户和索引版本维护词频统计，不装扩展；分数与本地 BM25 实现一致到 1e-9。统计走只追加的日志表，由 `<t>_sparse_fold()` 折叠、`<t>_sparse_search` 打分（迁移 030）：单篇 50 块入库约慢 6%，同一作用域 4 个写入方并发 10.4 对 11.1 篇/秒（有/无统计触发器），写入不互相等待（压测集群关了 fsync，写入数字是持久化服务器上的下限）。QASPER dev 821 题 hybrid 证据召回 0.6931 → 0.6918，−0.0012 [−0.0122, +0.0097]，不显著；事先定的"不差于 0.01"规则要求下限高于 −0.01，没达到非劣性，但也没有显著差异；之后按用户决定改为默认（理由：标准的 BM25 更易解释、与本地实现一致，剪枝后大文档集更快）。面试里要如实说：切换默认值是产品决定，数据只说明"没有显著差异"。旧库需要 `npm run vector:sparse-length` 回填分块长度。
- **常见词剪枝**（默认开启，只在检索超过 1,000 个分块时生效）：候选只由文档频率低的词经 GIN 召回，常见词只参与打分。10 万分块、2000 篇、行级安全、全表（合成数据，`npm run bench:pgvector-scale -- --sizes 100k --latest-name latest-pgvector-scale-sparse`）：100 条混合查询中含常见词的 11 条，`ts_rank_cd` p50/p95 **135/180 → 39/49 ms**，BM25 281/389 → 40/51 ms；100 条整体 `ts_rank_cd` p95 135 → 73 ms；QASPER（全部论文作文档集）train/dev 证据召回 hitAtAll 差值都是 0 [0, 0]。代价：只由常见词组成的查询，前 10 条和不剪枝相比只重合 32%（单个常见词）到 41%（三个常见词），这是 `ts_rank_cd`；BM25 单个常见词 29%、三个常见词 95.7%。
- **语义缓存**（`RAG_SEMANTIC_CACHE`，默认关）：键包含租户、文档集合（含每篇的内容版本）、索引版本和查询向量空间、prompt 指纹、模型和影响检索与答案的配置；文档变动即失效。缓存看到的是模型原始查询向量，所以键里取当前加载的适配器文件的指纹：同一路径换成重新训练的文件后换键并清掉旧条目；拆分部署下调用方要挂同一个文件，检索层用了别的适配器的答案不存（2026-10-18 修复；此前这一项恒为 `no-adapter`，同一路径换文件后键不变，旧答案在 TTL 内仍可能命中；换路径会经配置指纹换键，但不会清掉旧条目）。只靠相似度阈值不行——否定、数字、角色互换的问题相似度能到 0.99 以上，所以加了否定、数字、日期、实体、情态、方向、比较符等守卫。留出的对照集误命中 **0/59**（旧守卫 25/59），每次命中省约 1.35 秒（[0.65, 2.19] 秒，守卫 v1 那次运行测的）；代价是近义改写的命中率 11/17。
- **查询适配器**（轻量 embedding 微调，`RAG_EMBEDDING_QUERY_ADAPTER`，默认关）：不下载模型，用本地 nomic 向量在 QASPER train 上训练一个只作用于查询向量的线性变换，文档不用重建索引。dev 821 题 hybrid：证据进入候选 0.6918 → **0.7381，+0.0463 [+0.0244, +0.0694]**，第 1 名 +0.029 [+0.007, +0.051]，证据进入模型上下文 +0.0195 [+0.002, +0.037]；但 200 题答案 F1 0.2576 → 0.2562，不显著。只在单文档问答的 hybrid 路径上生效（纯稠密路径会变差，已关闭）；`/chat` 的 agent 选中 document_rag 时总会建检索计划，所以目前不经过适配器，只有不带计划的单篇调用（如 MCP `archive_ask`）会用到。
- 审查找出 20 个问题，其中 19 个当时修掉，包括：统计表触发器让每个租户的写入串行、清空和入库反序加锁会死锁、缓存守卫漏掉情态词和非拉丁文字、适配器把余弦压到所有阈值以下。另一个是缓存键没包含适配器：当时补的一项从查询向量取指纹，但缓存拿到的是原始向量，实际恒为 `no-adapter`，没修住；2026-10-18 才改为取当前加载的适配器文件指纹（见上面语义缓存一条）。
- 测试：带一次性 PostgreSQL 的全量 2298 个，0 失败。

### 3.17 审批续跑、真实模型规划统一图、按激活版本做查询、并行建版本（2026-09-27）

（这一节是 2026-09-27 的记录，没有改写。v3 统一图 2026-11-14 已删除，见 3.51：下面“审批续跑解冻”和“真实模型规划统一图”两条说的功能、评测用例和脚本都不在了，数字留作当时的测量。另外两条不受影响。）

- **审批续跑解冻**：`guarded` 下含审批 Capability 的统一图在审批节点暂停，不依赖它的节点先完成；批准后从同一个 checkpoint 续跑，Capability 只执行一次；拒绝则跳过它照常收尾。跨进程测试（真实 PostgreSQL，进程 A 暂停、进程 B 批准）14/14：写入次数恰为 1；Capability 写入后立即崩溃的 run 进入人工恢复、不重放；过期的 Capability 版本和被篡改的审批门都被拒绝。确定性评测加了 trajectory 用例 `unified_graph_approval_gated_action`（manifest 1.14.0；两个统一图用例共 13 项检查），用的是注入提案加 mock，属于运行时契约证据。
- **真实模型规划统一图**（本地 qwen2.5:7b，只有规划器调模型，其余是 mock；3 轮 15 次规划）：模型自己的计划只被接受 **3/15**，12 次回落到确定性图、0 次回落到 V1；检查 37/45、用例 0/6（`model_plan_used` 一次没过）。报告 lineage：commit 85efbb6a（工作区 dirty）、`unified_graph_planner@v1#037c0f5c79da`。回落原因：漏选要求的 Skill 6 次、图无法投影 4 次、引用了没列入依赖的节点输出 4 次、需要审批但没有授权 1 次。每次规划约 8 秒、约 2,000 token。面试里的说法：运行时契约（校验器整图拒绝、回落不部分执行）在真实模型下成立；7B 模型不能可靠地规划这种图，需要强模型再测。
- **查询跟随激活版本**：激活不同模型的新版本、但不改配置时，关掉查询缓存测（2 实例、租户、embedding 100 ms）：改前每个 `/chat` 做 3.98 次 embedding、吞吐掉 28.4%；改后 2.01 次、掉 1.4%。配置和激活版本不一致时健康检查给出警告和要改的变量。
- **并行建版本**：200 篇、embedding 100 ms：串行 8.57 篇/秒 → 同时 4 篇 33.2 篇/秒（3.87 倍）；模型并发上限 2 时 25.1 篇/秒，200 篇只发了 153 次 embedding 请求（合批生效）。建版本期间 `/chat` 吞吐没有下降。
- 审查找出并修掉 12 个问题，包括：审批续跑和恢复没检查运维配置的 Capability 白名单、切回 off/shadow 后停在审批门的 run 被卡住、第一版"查询跟随激活版本"的 −65% → +0.5% 其实测的是缓存大小（已撤回，改用关缓存的数字）。
- 测试：后端 2158 个（0 失败，8 个跳过）；带一次性 PostgreSQL 的全量 2230 个，0 失败。

### 3.16 索引版本、分阶段入库、统一图部分解冻（2026-09-27）

同一台机器、一次性 PostgreSQL 18.6 + pgvector 0.8.6、假模型；设计与边界见 `docs/data-lifecycle.md` 和 `docs/unified-agent-dag-migration.md`。

- **零停机换索引**（2 个实例、按租户走行级安全、`/chat` 并发 8 全程压测、200 篇文档，新版本把 embedding 从 1536 维换成 768 维）：
  - 建新版本、校验、切换、再回滚，全程 **0 错误**（8,749 和 9,844 次 `/chat` 两轮），答案 100% 有依据；建版本期间 p95 67 → 70 ms。
  - 切换和回滚命令约 235 ms，所有实例在 **2 秒内**跟上（指针缓存 TTL 2 s；宽限期内旧版本继续被双写，读到旧指针也不丢数据）。
  - 这组数只覆盖只读 `/chat`、800 个 chunk，期间没有并发的上传、删除或替换，也不含 retire（见 `docs/data-lifecycle.md`「零停机切换的适用范围」）。
  - 建版本 79 篇/秒（embedding 0 ms）；embedding 100 ms 时 8.8 篇/秒，因为构建是串行的、每篇一次请求。（已被取代：3.17 起并行建版本，另一组 embedding 100 ms 的运行里串行 8.57 → 4 篇并行 33.2 篇/秒，见 3.17 和 `docs/data-lifecycle.md`「查询嵌入跟随活动版本、并行构建」。）
  - 已知代价：激活一个和当前配置不同模型的版本后，改配置之前每个查询要多做一次 embedding；embedding 100 ms 时吞吐掉 60%。（已被取代：3.17 让查询跟随激活版本，并关掉查询缓存重测：旧代码 85efbb6a 激活后每个 `/chat` 3.98 次 embedding、吞吐 −28.4%，新代码 2.01 次、−1.4%；引用以那组为准，出处同上。）
- **分阶段入库**（解析 → 切块 → 向量化 → 写索引，每阶段落库、单独重试，失败进死信队列，同租户按内容去重，`PUT /documents/:docId` 原子替换）：
  - 跨文档合批：模型并发上限不卡时，开和关吞吐一样（64.8 对 65.2 篇/秒，区间重叠）；上限为 2 时开合批 41.7 篇/秒、关 19.6 篇/秒（2.1 倍），64 篇的 embedding 请求 26–30 次对 64 次。
  - 第一版合批在上限不卡时反而慢 24%，被审查发现，改成"先占并发槽再合批"。
- **统一图部分解冻**（`AGENT_UNIFIED_GRAPH_ROLLOUT=guarded`，默认仍 `off`；这是 2026-09-27 的记录，没有改写。v3 统一图 2026-11-14 已删除，`guarded` 现在让进程拒绝启动，见 3.51；`docs/unified-agent-dag-migration.md` 现在是历史记录）：
  - 按冻结时写下的条件补了评测用例（文档证据不足 → 按条件查 Web → 结果交给 Skill），旧的固定顺序表达不了，guarded 下 7/7 通过。证据是确定性提案加 mock，不是真实模型规划。
  - 三块跨进程恢复测试（文档循环缺口与工作记忆、最终答案收据、节点边界续跑）在真实 PostgreSQL 上通过；审批续跑仍冻结，含审批节点的图在任何节点执行前整图拒绝、回到 V1（3.17 已解冻）。
  - 审查找出并修掉 12 个问题，包括：Web 节点会把文档内容发给外部搜索、Web 结果未经注入筛查就进了 Skill 的 prompt、只用 Web 就回答了限定文档范围的问题、`off` 挡不住启动恢复执行 v3 图。
- 测试：后端 2128 个（0 失败，8 个需要数据库或 Redis 的跳过）；带一次性 PostgreSQL 的全量 2194 个，0 失败。

### 3.13 工程基线（2026-09-26，压测与规模提交）

- （这是历史基线，后面各节记了当时的全量数字。连 Redis 一起跑的最近一次全量是 2026-10-18 在一次性 PostgreSQL + Redis 上的 4038 项、0 失败，见 3.32；覆盖率闸门最近一次是 2026-11-14 阶段 10 删除 v3 统一图、做完独立复核的修正之后的 4,479 个测试，4,472 通过、7 跳过、0 失败，全局行覆盖 91.92%，本机 Node 24、接一次性 PostgreSQL 18 + pgvector，见 3.51；这一次“RAG / AgentRAG core”一组是 94.46%，过了 90% 的门、没到 95% 的目标，CI 用的是 Node 22、本机没有。上一次是阶段 9 的 4,607 个测试，本机和合并之后 CI 的 Node 22 上都通过，见 3.50。）
- 后端测试 2214 个：2205 通过，0 失败，9 个跳过（3 个需要 PostgreSQL、1 个需要 Redis 的集成测试文件在无对应服务时各报告 1 个跳过）。pgvector 集成测试在一次性 PostgreSQL 18 集群上 46/46（本次测得，含租户流水线和 run 行锁等待用例）；Redis 集成测试 5/5。
- 默认覆盖率门禁不含 Redis，`model-call-guard.js` 的共享分支只由 Redis 集成测试覆盖。
- 前端测试 113 个全部通过，生产构建通过（Docker 镜像构建时执行）。
- 覆盖率门禁通过：后端全局行覆盖 89.8%，RAG/AgentRAG 核心 93.6%（本次测得；全局比上次低 0.8 个百分点，因为新加的压测和规模脚本里需要数据库的主流程只在一次性集群上跑，单元测试覆盖不到）。
- 定时的 Planner Real Provider Gate 从 2026-09-20 起每天失败，原因是仓库 secret `OPENAI_API_KEY` 失效，OpenAI 返回 "Incorrect API key provided"，真实规划器全部退回确定性规划。这不是代码问题，需要换一个有效的 key；workflow 现在会在第一步检查 key，并给出明确的报错。
- 真实模型 `verify:quality`（qwen2.5:7b，默认配置）：18/18。

## 4. 边界（主动说，不要等被问）

- **模型**：只用本地 7B 模型验证过，没有 GPT 级模型或生产流量的数据。单次查询的 token 用量和本地延迟分解量过了（3.38），但成本只有公式和示意单价，没有真实账单；延迟是串行、单机、QA 路线进程内的数字，不是并发下的服务延迟。
- **评测规模**：自建检索集 48 条、端到端 18 项检查，多数差异不显著。外部标注的 QASPER dev 已接入：检索 821 题，答案抽样 200 题。只测过一个 7B 模型；LLM 评审仍只有框架，没有人工校准（标注页已备好，见 3.38，还没有人标）。答案模型的采样温度没有固定（端点默认 1.0），同一设置、同一批题重复运行，官方 F1 有 0.003–0.01 的来回差。
- **校验器**：默认是词法规则，认不出语义等价的改写；可选的 LLM 评审（`RAG_CLAIM_JUDGE=llm`）只复核被词法拒绝的 claim，数字和引用仍由确定性规则把关。评审默认关闭：构造对照集上错误接受 0/54（留出集含），但前一轮观察到过 1 次真实误判，而且还没用人工标注的真实答案校准。对比答案仍走模板兜底。
- **文档解析**：默认只读 PDF 文本层，按行距、字号、缩进识别段落（3.26）；兜底模板先接上软换行，不再输出半句（3.23）。版面解析（`PDF_PARSER=docling`）和按页分流（`PDF_PARSER=auto`，表格页、扫描页送 docling-serve）是可选项，测下来答案 F1 都没有显著差异（3.14、3.31）。OCR 路由只在 1 份手工扫描件上验证能走通，真实扫描档案和乱码文字层没测过。
- **租户隔离**：默认鉴权关（`API_AUTH_ENABLED=false`），整个归档就是一个租户。开鉴权后是应用层过滤加行级安全（默认 enforce），会话记忆（迁移 031）和 admin audit（迁移 032）也在行级安全下。租户靠异步上下文传递，默认 `POSTGRES_TENANT_CONTEXT=lenient` 下上下文丢失时回落到 owner 身份，只剩应用层过滤；可开 strict（没绑定上下文的语句直接报错）或角色拆分（`POSTGRES_MIGRATION_DATABASE_URL`，运行时登录没有表权限，以 42501 失败）做到 fail-closed，两者默认都关。成员校验、限流配额、加密等加固也都默认关（3.32）。`local`、`qdrant` 向量库是单租户的。这层防护针对漏写过滤条件的 bug，不防 SQL 注入（注入的语句可以 `RESET ROLE`；角色拆分下运行时登录也仍能切进 system 角色）。
- **安全**：提示注入有了自建红队集和攻击成功率数据（见 3.10），但用例是自己构造的、数量小、攻击方式公开；确定性筛查挡得住已知写法，挡不住刻意改写（`evasion_paraphrase` 仍 3/3 成功），只靠 prompt 规则挡不住 7B 模型。没有用第三方基准（如 BIPIA、AgentDojo）测过。
- **登录和权限**：OIDC 只在自带的开发 IdP 上端到端测过，没接过真实 IdP；RBAC 只管动作，不管文档可见性。
- **拆分部署**：只在一台机器上测过；同样进程数下单体比拆分快 1.56 倍，拆分的收益是只扩瓶颈层和故障隔离，不是效率；层间身份可选 Ed25519（每服务一把私钥），但仍不是 mTLS；没有 K8s 和服务发现，拆分用的 `compose.services.yml` 没有真正跑过（只用 `docker compose config` 校验过）。
- **读副本**：主库语句只减少 28.8%，没达到事先定的 30%，吞吐也没变快；副本和主库在同一台机器上，CI 里没有副本。
- **告警规则**：没有在真实 Prometheus 里加载和求值过，99.5% 可用性和 20 秒延迟目标是建议值，不是从真实流量定的。
- **架构**：V2 typed DAG 是自定义 Skill 阶段唯一的执行器。V1 顺序链 2026-11-13 已删除（3.49）：它原来是 `off`、`shadow` 两个档位的执行方式，也是整图被拒时的兜底。现在整张图在任何节点运行之前被拒时，不执行任何 Skill，逐个记录原因；预算付不起的节点跳过。随顺序链一起没有、也没有替代的：手动重试单个失败的 custom Skill 步骤（图运行的步骤拒绝单独重试；默认配置下这项能力从 2026-09-25 起就不可用了）、`shadow` 对照、没有类型契约的 custom Skill（不再运行）。同一天的阶段 9（3.50）接着删掉了阶段 8 留下的、只有顺序链存下的旧 run 走得到的代码：`custom_skill` 步骤的独立处理器、启动时的单步重放、恢复动作 `resume_from_step`。现在 custom Skill 只作为图节点运行，它的步骤不单独重试、也不单独重放；启动恢复自己只续跑中断的图，其余中断的 run 交给人；人在恢复面板上只能重试失败步骤（重放安全矩阵允许的步骤类型，`custom_skill` 不在其中）或取消。旧链留下的 run 中断了只能取消，失败了不能单步重试，要得到答案只能重新提问。v3 统一图 2026-11-14 已删除（阶段 10，3.51）。它是开关 `AGENT_UNIFIED_GRAPH_ROLLOUT` 后面的第二种回答方式：把整个请求规划成一张受治理的图，有 `shadow`、`guarded` 两档，默认一直是 `off`。删它是因为用户要 agent 只有一种回答请求的方式，而让 v3 成为那一种，数字不支持：本地 7B 模型的计划 15 次只被接受 3 次、每次规划约 8 秒；一次文档问答的 CPU 约 1 ms 对 11–15 ms（mock 微基准）；有六类请求它答不了。现在每个请求都由外层执行计划回答，这个开关只接受未设置、空值或 `off`，设成 `guarded`、`shadow` 或其他任何值进程拒绝启动。开过 `guarded` 的部署里已存的 v3 run，已经结束的不动，没结束的交给人、只能取消。随 v3 一起没有、也没有替代的：两种编排（Skill 只在文档答案通过证据检查之后运行并拿到已验证的答案；审批的任务内容来自已验证的文档答案）、图内审批和它的 7 个跨进程 PostgreSQL 用例（外层计划的 Capability 审批还在，是另一条路径）、v3 的真实模型规划评测、shadow 观测。还没做完的：共用图模块里只有 v3 用过的代码（执行器里节点停在审批门和同一线程续跑、v3 图契约和 v2 checkpoint、run store 的图审批门、Capability 的图预检、任务级的 `deny` 动作）已经没有生产调用方，下一步删；在那之前覆盖率里“RAG / AgentRAG core”一组是 94.26%，没到 95% 的目标，过了 90% 的门。没有验证的：真实 PostgreSQL 上的已存 v3 run、真实浏览器。外层文档、Web、内置 Skill 仍是固定顺序。整个 agent 只有 LangGraph 一种运行时（3.28）：它是 custom-Skill DAG 唯一的调度器（原生图调度器已删除，见 3.30），2026-11-13 起也是外层计划和 `/chat/stream` 唯一的路径（原生循环已删除，见 3.48）；五次删除（原生图调度器、原生循环、顺序链、custom Skill 步骤的单独重放、v3 统一图）都没有留运行时回退开关，只能 revert。外层计划交给 LangGraph 起初让每个 `/chat` 多约 30% CPU；阶段 5 改用底层 Pregel 后降到低并发 +17.6%，仍超 10% 的门，当时保持原生循环（3.29）。阶段 7 没有重测这个门：是用户为了只留一种运行时、明知不达标接受的开销（进程内每次运行多 0.29 ms CPU），不能说成性能提升。删顺序链（阶段 8）没有量过性能，也不能说成性能提升。删 v3 统一图（阶段 10）同样不能说成性能提升：开关默认是 `off`，默认配置下回答请求的本来就是外层执行计划。外层计划的持久化仍靠 run 的步骤，LangGraph 只给 custom-Skill DAG 做 checkpoint。规划器的模型调用经 LangChain ChatModel 适配器。
- **Agent 路径的答题率**：用 qwen2.5:7b 走 agent（`/chat` 的真实路径），合同和政策 7 题里 6 题、论文 12 题里 11 题最终改为澄清，因为词法校验器拒绝了大部分答案；`verify:quality` 的 18/18 测的是不经过 agent 自检的纯 RAG 路径。修了两个校验器 bug（"twelve (12)"被算成两个数；证据在 PDF 换行处被切断）后，合同和政策题从 2/21 升到 4/21（各 3 轮），论文题不变；剩下的主要是改写用词过不了词法校验。打开 LLM 评审后合同和政策题 3/21 → 14/21 得到回答且 14 个全对，p50 延迟多约 0.8 秒；两道管辖法律题仍在检索阶段判为证据不足。2026-10-03 按正确口径重测（见 3.21）：QASPER 训练题评审关 0/41 可答题被回答；开评审能答 10–17/41，但会回答不可答题，所以默认仍关。
- **流式草稿**：机制已上线并有测试，但在上面的校验器下很少产生草稿（修 bug 后合同和政策题 21 次里 4 次，论文题 0 次），所以还没有实际的延迟收益。

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
