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
| 预算 | 每次运行两层：次数（文档 RAG 2 次、自定义 Skill 2 次、Web 搜索 1 次、trace 16 步），以及用量（默认 10 万 token、0.5 美元、5 分钟）。用量按每次成功的模型调用计量，用完后下一个工具被跳过、运行降级而不报错；已开始的步骤会跑完，所以是软截止 | `rag/agent-budget.js`、`rag/run-usage.js` |
| LLM 调用容错 | 带抖动的指数退避、遵守 `retry-after-ms` / `Retry-After`、可重试的超时、空响应重试一次、经模型注册表切换备用模型；每个模型端点有并发上限（默认 8）和熔断器（连续 5 次不可用错误熔断 30 秒，429 不计） | `rag/openai.js`、`rag/openai-client.js`、`rag/model-call-guard.js`、`rag/model-providers/` |
| 可观测性 | OpenTelemetry trace，遵循 GenAI 语义约定：一次运行一个 `invoke_agent` span，规划器、每个 Skill（`execute_tool`）、每次模型调用（`chat` / `embeddings`，带 token 和估算成本）逐层嵌套；步骤是 span 事件；不记录问题、prompt、输出和文档内容。默认关闭；OTLP 导出默认 protobuf（Phoenix 只收 protobuf），也能接 Langfuse。响应里的 `traceId` 和 span 上的 `agent.run.id` 互相可查 | `rag/tracing.js`、`otel.js` |
| Claim 校验 | 默认词法规则；可选 LLM 评审只复核被词法拒绝的 claim，只能升级不能降级，引用错误、证据中没有的数字、对比答案不送评审，失败时保留词法结论；结论缓存 | `rag/self-check/`、`rag/self-check/claim-judge.js` |
| Prompt 版本 | 10 个 prompt、16 个模板变体，每个模板有 `id@version#fingerprint`（模板原文的哈希）。每次模型调用带上它，进入 LLMOps 事件、模型 span、每次运行的 prompt 清单、LLM 规划器的决策和每份评测报告；测试把每个版本钉到 fingerprint，改模板不改版本号会失败；发布门要求所有发布报告用同一组 prompt | `rag/prompt-registry.js`、`rag/prompt-catalog.js`、`test/prompt-registry.test.mjs` |
| 提示注入防护 | 文档、文件名、网页结果进 prompt 前做确定性筛查（对 AI 说话的句子替换成标记，中英文都覆盖）；答案、网页回答、claim 评审的 prompt 写明证据是不可信数据；输出链接守卫删掉图片和模型没见过的链接。规划器本来就看不到文档正文 | `rag/prompt-injection-screen.js`、`evaluation/prompt-injection-cases.js` |
| 租户隔离 | 应用层每个 store 按 user/workspace 过滤；PostgreSQL 行级安全再兜一层：鉴权后的中间件把访问范围放进 `AsyncLocalStorage`，带范围的语句在短事务里 `SET LOCAL ROLE` 到租户角色并设置租户变量，9 张表的策略拒绝其他租户的行。后台任务和恢复以记录自己的范围执行；迁移、进程级缓存加载、跨租户恢复扫描显式以 owner 身份执行 | `db/migrations/013_enable_tenant_row_level_security.sql`、`rag/postgres.js`、`rag/postgres-tenant.js` |
| 流式进度与草稿 | `POST /chat/stream` 以 SSE 推送每一步 trace 摘要；主文档答案按 token 生成，但只推送通过 finalizer 同一套 claim 校验的整句（草稿），原始 token 不出服务器；最终答案整体发送并替换草稿。聊天界面已接上 | `routes/chat.js`、`rag/agent-event-stream.js`、`rag/answer-drafts.js`、`src/components/ChatComponent.jsx` |

默认配置：hybrid 检索（pgvector 余弦 + PostgreSQL 全文检索，RRF 融合），rerank 关闭，规划器用 LLM，自定义 Skill 阶段默认由 typed DAG 执行（`AGENT_SKILL_GRAPH_ROLLOUT=guarded`），V1 顺序链只在整图被拒时兜底。

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

并发上限与熔断（同一评测，三轮平均；改前 `d5623593`，改后加 `rag/model-call-guard.js`）：

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| 主模型宕机，有备用模型 | 每次调用 5.00 个请求，p50 2.6s | **1.33 个请求，p50 24ms** |
| 主模型宕机，无备用模型 | 等 2.6s 后失败 | **立即失败（<1ms）** |
| 自托管服务饱和（2 个工作线程，16 个并发调用方） | 1.42 个请求/调用，p95 5.2s，服务端峰值排队 16 | **1.00，p95 3.2s，峰值排队 8** |

成功率在这三个场景都没变：重试本来就能兜住，改进的是延迟和对故障端点、过载服务的无效请求。其他场景在噪声内不变，40% 返回 503 的场景没有误熔断。饱和场景是为这次改动新加的，改前改后跑的是同一份脚本。

### 3.5 执行器转正：typed DAG 设为默认

`AGENT_SKILL_GRAPH_ROLLOUT` 默认值从 `off` 改为 `guarded`。项目原有的 `rollout:readiness` 门禁要求真实 LLM 规划零降级、零 mock/real 分歧，它把两个决定绑在了一起：用哪个执行器（V1 链还是 DAG 运行时），以及由谁规划 DAG（LLM 还是确定性规划器）。LLM 规划失败时退回的是确定性 DAG，不是 V1 链，所以执行器转正只需要执行语义的证据：

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

能看出的东西：延迟几乎全在模型调用上，编排本身是毫秒级；第一次调用可能包含模型加载时间；第二个 Skill 的输入 token 多了一倍，因为它带着上游输出（类型化的 `priorFindings`）。单次 trace 不是性能基准。

### 3.7 校验过的答案草稿

`npm run eval:answer-drafts`（qwen2.5:7b，确定性规划器）：合同和政策 7 题里 1 题产生草稿，草稿保留在最终答案里，比最终答案只早 7 毫秒（答案只有一句）；论文 12 题 0 题产生草稿。6/7 和 11/12 的最终答案是澄清。结论：流式本身工作正常，瓶颈是词法校验器，详见 `docs/evaluation.md`。

校验器 bug 修复后（`npm run eval:answer-drafts`，各 3 轮）：合同和政策题 2/21 → 4/21 得到回答，有草稿的运行 2 → 4 次，草稿全部保留；论文题不变。`verify:quality` 仍 18/18。

### 3.8 数据库行级安全

`npm run eval:tenant-isolation`（2026-09-25，PostgreSQL 18.6 + pgvector 0.8.6，本机一次性数据库，owner 是只有 `CREATEROLE` 的非超级用户）：20 个租户、10000 个切块，以其中一个租户身份执行。`off` 就是改动之前的连接路径。

| 探测 | 改前（off） | 改后（enforce） |
| --- | --- | --- |
| 漏写过滤条件的查询，泄露其他租户数据的表 | 9/9（9728 行） | **0/9（0 行）** |
| 被接受的越权写或越权读（伪造插入、upsert 抢占、跨租户更新、跨租户删除、store 拿错 scope） | 5/5 | **0/5** |
| 每条语句 p50 延迟 | 0.10–0.31 ms | 0.25–0.56 ms（+0.15–0.25 ms，多了 3 次往返） |

- 查询计划两种模式都走索引，没有退化成顺序扫描。
- “off 下 9/9”量化的是这层防护能兜住的 bug 类型；现有 store 都带过滤条件，不代表现在就有泄露。
- 做的过程中发现并修掉的问题：进程级文档 registry 如果在租户请求里首次加载，会只装进这个租户的文档，现在改为以 owner 身份加载；multer 的内存存储会丢掉异步上下文，分片上传路由在 multer 之后重新绑定租户。
- 正确性：`test/postgres-row-level-security.integration.test.mjs` 9 个用例；PostgreSQL 集成测试共 24/24。

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

### 3.11 工程基线（2026-09-25，提示注入防护提交）

- 后端测试 1768 个：1765 通过，0 失败，3 个跳过（3 个需要 PostgreSQL 的集成测试文件在无数据库时各报告 1 个跳过）。在一次性 PostgreSQL 18.6 集群上跑（`FULL_SUITE=1 bash scripts/run-pgvector-integration.sh`）是 1789/1789。
- 前端测试 111 个全部通过，生产构建通过（这次没改前端）。
- 覆盖率门禁通过：后端全局行覆盖 91.3%，RAG/AgentRAG 核心 93.5%。

## 4. 边界（主动说，不要等被问）

- **模型**：只用本地 7B 模型验证过，没有 GPT 级模型或生产流量的数据；没有真实的单次查询成本数据。
- **评测规模**：检索 48 条、端到端 18 项检查，多数差异不显著。QASPER 导入脚本和 LLM 评审只有框架，还没跑过真实数据，评审也还没做人工校准。
- **校验器**：默认是词法规则，认不出语义等价的改写；可选的 LLM 评审（`RAG_CLAIM_JUDGE=llm`）只复核被词法拒绝的 claim，数字和引用仍由确定性规则把关。评审默认关闭：构造对照集上错误接受 0/54（留出集含），但前一轮观察到过 1 次真实误判，而且还没用人工标注的真实答案校准。对比答案仍走模板兜底。
- **文档解析**：只读 PDF 文本层，没有 OCR、表格和版面解析；换行会把句子切断，导致模板答案出现半句话。
- **租户隔离**：行级安全不覆盖会话记忆（只有 session id）和 admin audit（管理员需要跨用户读取）。租户靠异步上下文传递，上下文丢失时回落到 owner 身份，也就是只剩应用层过滤，而不是拒绝访问；要做到拒绝访问需要一个没有表权限的独立登录角色。这层防护针对漏写过滤条件的 bug，不防 SQL 注入（注入的语句可以 `RESET ROLE`）。
- **安全**：提示注入有了自建红队集和攻击成功率数据（见 3.10），但用例是自己构造的、数量小、攻击方式公开；确定性筛查挡得住已知写法，挡不住刻意改写（`evasion_paraphrase` 仍 3/3 成功），只靠 prompt 规则挡不住 7B 模型。没有用第三方基准（如 BIPIA、AgentDojo）测过。
- **架构**：V2 typed DAG 已是自定义 Skill 阶段的默认执行器，V1 顺序链只作为整图被拒时的兜底和运维回退；v3 统一图已冻结在 shadow（冻结原因见 `docs/unified-agent-dag-migration.md`）。DAG 只覆盖自定义 Skill 阶段，外层文档、Web、内置 Skill 仍是固定顺序。
- **Agent 路径的答题率**：用 qwen2.5:7b 走 agent（`/chat` 的真实路径），合同和政策 7 题里 6 题、论文 12 题里 11 题最终改为澄清，因为词法校验器拒绝了大部分答案；`verify:quality` 的 18/18 测的是不经过 agent 自检的纯 RAG 路径。修了两个校验器 bug（"twelve (12)"被算成两个数；证据在 PDF 换行处被切断）后，合同和政策题从 2/21 升到 4/21（各 3 轮），论文题不变；剩下的主要是改写用词过不了词法校验。打开 LLM 评审后合同和政策题 3/21 → 14/21 得到回答且 14 个全对，p50 延迟多约 0.8 秒；两道管辖法律题仍在检索阶段判为证据不足。
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
