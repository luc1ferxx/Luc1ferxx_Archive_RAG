# 项目深挖面试应对手册

> 2026-10-18 生成，基于 `main`（692ca7da）。生成方式：7 个代理分别精读 7 个子系统，7 个核验代理逐条对照代码核对文件、函数名和数字（共改正约 150 处），最后 1 个"面试官红队"代理设计跨模块追问。数字的权威出处仍是 [CURRENT-TRUTH.md](CURRENT-TRUTH.md) 和 `docs/evaluation.md`；这里引用的每个数字都带了出处和前提。
>
> 这是给你自己看的材料。照例不要在 README 里提它。

## 0. 怎么用

| 文件 | 用途 | 什么时候看 |
| --- | --- | --- |
| 本文 | 方法、结构图、主线、跨模块追问链、不能说的话、真伪测试、白板题、练习计划 | 先通读一遍 |
| [deep-dive/01-agent-orchestration.md](deep-dive/01-agent-orchestration.md) | Agent 编排与规划 | 主线 1 |
| [deep-dive/02-durability-recovery.md](deep-dive/02-durability-recovery.md) | 运行持久化、审批、崩溃恢复 | 主线 1 |
| [deep-dive/03-retrieval-parsing.md](deep-dive/03-retrieval-parsing.md) | PDF 解析、切块、混合检索 | 主线 2 |
| [deep-dive/04-grounding-safety.md](deep-dive/04-grounding-safety.md) | 答案生成、防幻觉、提示注入 | 主线 2 |
| [deep-dive/05-evaluation.md](deep-dive/05-evaluation.md) | 评测体系与实验方法 | 主线 2 |
| [deep-dive/06-multitenancy-security.md](deep-dive/06-multitenancy-security.md) | 多租户隔离与安全 | 被问到再讲 |
| [deep-dive/07-platform-reliability.md](deep-dive/07-platform-reliability.md) | 服务拆分、模型网关、可靠性、可观测性、性能 | 主线 3 |
| [deep-dive/STALE-ITEMS.md](deep-dive/STALE-ITEMS.md) | 讲述稿、FAQ、CURRENT-TRUTH、AGENTS.md 里过时或说大了的句子，以及每条的处理结果（2026-10-18 已修正） | 复习时对照 |

每个子系统文件的结构一样：30 秒讲法 → 关键文件 → 一次请求怎么经过它 → 设计决策（为什么、为什么不用主流方案、代价、证据）→ 由浅到深的追问阶梯（每题有答题要点、代码位置、陷阱）→ 可引用的数字 → 要主动说的边界 → 容易记错的地方（核验代理改正过的说法）。

## 1. 先认清局面

**体量。** `server/rag/` 340 个文件约 13.2 万行，`server/evaluation/` 约 5.4 万行，测试 354 个套件约 20.7 万行，35 个迁移，前端约 1.3 万行，2026 年 1 月以来 330 次提交。

**面试官看到这个量，脑子里只有两个问题：**

1. 这是你做的吗？（还是 AI 生成、你没吃透？）
2. 你懂到哪一层？

一场项目深挖通常 20–40 分钟，你讲不完这个项目的十分之一。所以策略只有一个：**3 条主线讲到第 5 层，其余每块只准备一句话和一个入口函数**，被问到再展开。面试官会抓住你话里的每个名词往下追，**你主动说出口的每一个名词，都要能再讲三层**；讲不深的，就不要主动提。

**这个项目最大的优势**：几乎每个决定都有数字，而且有大量"测了、没改默认"的记录（门控阈值、LLM 评审、按句切块、Docling、外层计划上 LangGraph……）。这比"提升了 X%"更难伪造，是工程判断力的直接证据，要当卖点讲。

**最大的两个风险**：一是夸大，尤其是把默认关闭的功能说成已上线、把不显著的差异说成"更好"；二是被追问到函数级细节时讲不出来。第 6 节和第 7 节专门对付这两点。

## 2. 项目结构地图

### 2.1 分层

```text
        React 工作台（SSE 进度 + 校验过的草稿）        MCP 客户端（archive_ask，只读）
                         │                                    │
┌──────────── API 层  server/app.js · server/routes/ ──────────────────────────┐
│ 鉴权与租户绑定 auth.js（requireApiAuth → bindDatabaseTenant）· 限流 · RBAC  │
│ zod 入参校验 · 上传/替换/删除 · 入库任务 · 管理接口                         │
└──────┬───────────────────────────────────────────────────┬──────────────────┘
       │ /chat、/chat/stream                               │ 上传
┌──────▼──────── Agent 编排  server/rag/agent*.js ──────┐  ┌▼── 入库  rag/ingest-*.js ─────┐
│ 意图规划（正则候选 → LLM 在 enum 里选）              │  │ parse → chunk → embed → index │
│ 执行规划（strict schema，白名单阶段）                 │  │ 每段落库、各自重试、死信队列  │
│ 外层原生循环 runAgentExecutionPlan：                  │  │ PDF：pdf.js 段落识别（默认）  │
│   custom_skills → typed DAG（LangGraph 调度）         │  │      Docling / auto（可选）   │
│   document_rag  → 门控 → 作答 → claim 校验 → 补检索 │  │ FOR UPDATE SKIP LOCKED + 围栏 │
│   web / capability（审批门）                          │  └──────────────┬────────────────┘
│ finalizer 删无支持句 → run store（PG，revision CAS）  │                 │
└──────┬──────────────────────────┬─────────────────────┘                 │
       │                          │                                       │
┌──────▼──── 检索 ──────────┐ ┌───▼──── 模型调用 ──────────────────┐      │
│ 查询 embedding（按激活    │ │ openai.js：抖动退避、Retry-After、 │      │
│   的索引版本，带缓存）    │ │   超时重试、空响应重试、备用模型   │      │
│ pgvector HNSW ∥ BM25      │ │ model-call-guard.js：并发上限、    │      │
│ 加权 RRF → 交叉编码器重排 │ │   熔断、按租户公平排队             │      │
│   （可选）                │ │ 拆分部署时 = model-gateway 服务    │      │
└──────┬────────────────────┘ └────────────────────────────────────┘      │
       └────────────────► PostgreSQL 16 + pgvector + 行级安全 ◄────────────┘
          文档 · 分块 · BM25 统计 · 索引版本 · run/步骤/事件/checkpoint · 任务队列 · 记忆 · 审计
          （可选：读副本、Redis 共享熔断/并发、docling-serve、重排服务、OTLP、Prometheus）
```

默认这四个框在**一个进程**里（`ARCHIVE_RAG_ROLE` 不设 = `all`），层之间是函数调用；设了角色和服务地址才拆成 api / agent / retrieval / model-gateway 四种进程，层间走带签名身份的 HTTP。

### 2.2 一次 `/chat` 的函数链（必须能脱稿画）

```text
routes/chat.js handleChatRequest
└─ runAgentRequestWithCancellation（rag/request-deadline.js，可选截止时间/断连取消）
   └─ runAgentRag → runAgentRagInScope（rag/agent.js，run 级用量计量 + invoke_agent span）
      ├─ createAgentIntentPlanResult（agent-intent-planner.js）
      │    buildIntentPlanCandidates（正则白名单候选）→ LLM 在 enum 里选 ......... 模型调用 ①
      ├─ createAgentSession（agent-bootstrap.js：Skill match、工作记忆、预算）
      ├─ 建 run（PostgreSQL 1 次 INSERT）
      ├─ prepareAgentRun（agent-preparation-flow.js：澄清门、查询规划）
      ├─ createAgentExecutionPlanResult（agent-execution-plan.js，strict schema）... 模型调用 ②
      ├─ runAgentExecutionPlan（agent-execution-plan-runner.js，原生外层循环）
      │    ├─ custom_skills → runExecutionGraphOnLangGraph（validateExecutionGraph 整图校验）
      │    ├─ document_rag  → runDocumentRagLoop（agent-document-loop.js）
      │    │     └─ executeDocumentRag → executeQaRag（document-rag-execution.js）
      │    │          retrieveGlobalContextForQueries（dense ∥ BM25 → RRF）
      │    │          assessQaConfidence（门控，不过就不调模型）→ selectQaContext
      │    │          writeQaAnswer（answer-writer.js）......................... 模型调用 ③
      │    │       evaluateClaimSupport（self-check/）→ 有缺口最多补检索 1 轮
      │    └─ web_search（被选中，或文档拒答/失败时兜底）
      └─ finalizeAgentRun（agent-finalization-flow.js → finalizeAgentAnswer 删无支持句）
         └─ completeRun（revision CAS；一次 /chat 共 1 insert、3 CAS、2 事件追加、0 回读）
```

默认配置下一次普通文档问答 **3 次模型调用**（两次规划 + 一次作答）；LLM 规划器失败就降级到确定性规划器。

### 2.3 七个子系统，各一句话

| 子系统 | 一句话（能展开三层再说出口） | 入口 |
| --- | --- | --- |
| Agent 编排 | 模型只提议、运行时决定：意图在正则候选的 enum 里选，外层是白名单阶段，只有 custom Skill 阶段由模型画 typed DAG，整图接受或整图拒绝 | `agent.js runAgentRag`、`agent-execution-graph.js validateExecutionGraph` |
| 持久化与恢复 | run 是 PostgreSQL 一行 + revision CAS；只在能证明安全时自动续跑，在途状态不明一律转人工，不是 exactly-once | `agent-runs.js`、`agent-run-step-replay-safety.js` |
| 解析与检索 | pgvector 稠密 ∥ PostgreSQL 内自建统计的 BM25，加权 RRF；QASPER 上只显著好于单用 BM25 | `document-rag-execution.js`、`vector-store-pgvector*.js` |
| 答案与防幻觉 | 门控 → 引用约束的作答 → 词法 claim 校验 → 补检索 1 轮 → finalizer 删句；代价是 7B 下答题率很低 | `confidence.js assessQaConfidence`、`self-check/` |
| 评测方法 | 伪 embedding 只测管道；外部标注 QASPER + 配对 bootstrap；规则事先定，train 调、dev 确认 | `server/evaluation/` |
| 多租户安全 | 应用层过滤 + 行级安全兜底，租户设置和语句一次往返；大部分加固开关默认关 | `auth.js`、`postgres.js`、`postgres-tenant.js` |
| 平台与可靠性 | 故障注入驱动的模型调用容错；pg_stat_statements 定位往返 167→22；可选四层拆分 | `openai.js`、`model-call-guard.js`、`service-topology.js` |

## 3. 深挖的规律和答题方法

### 3.1 面试官怎么追

几乎所有深挖都沿着这条阶梯往下走，而且**抓住你上一句话里的某个词**作为下一题：

| 层 | 问法 | 他在判断什么 |
| --- | --- | --- |
| L1 是什么 | "讲讲你这个 Agent 怎么规划的" | 能不能把系统讲清楚 |
| L2 为什么 | "为什么让规则先出候选，不让模型直接选意图？" | 是你做的决定，还是照搬 |
| L3 为什么不用 X / 怎么证明 | "为什么不用 ReAct？""降级率怎么测的？多少样本？" | 视野和证据意识 |
| L4 边界 / 故障 / 规模 | "规则没覆盖的意图怎么办？Skill 从 4 个变 400 个哪里先坏？" | 是否真跑过、真想过 |
| L5 反思 | "重做你改什么？哪次直觉被数据推翻了？" | 成熟度 |

每个子系统文件的追问阶梯就是按这个顺序排的，L3/L4 的题最多，因为淘汰都发生在这两层。

### 3.2 每个回答用四步

**结论一句 → 机制（指到函数）→ 证据（数字 + 前提）→ 代价与边界。** 一个回合控制在 30–60 秒，把第四步留成钩子，让面试官顺着你准备好的方向追。

例子，问"为什么不用 ReAct？"：

- 差的回答："ReAct 不可控，我们的更可靠。"（没有机制、没有证据，还贬低了一个你没对比过的方案。）
- 好的回答：
  - **结论**："外层没用开放循环，是受控的 Plan-and-Execute。"
  - **机制**："意图由 `buildIntentPlanCandidates` 先用规则出白名单候选，LLM 只能在 enum 里选；外层阶段也是白名单；只有 custom Skill 阶段让模型画 typed DAG，`validateExecutionGraph` 整图接受或拒绝。"
  - **证据**："7B 模型下，按请求生成的 strict schema 把规划降级从 56% 降到 8%（6 个用例各跑 5 轮，qwen2.5:7b）。"
  - **代价**："灵活性差，7B 上让模型动态组合两个 Skill 只成功 2/5；我没跑 ReAct 对照，所以不说它不行，只说文档场景要可审计、成本有上限、有副作用的操作要在执行前审批，开放循环很难事前知道要做什么。"

### 3.3 被问住时

分三种情况，**绝不现编数字**：

- **没做**："没做。要做的话我会……，当时没做是因为……"（比硬撑好得多。）
- **做了但记不清细节**：讲机制、说去哪里查（"阈值在 `config.js` 的 `DEFAULT_MIN_QA_QUERY_TERM_COVERAGE`，具体值我得看一下，印象是 0.51"）。
- **不确定**："我的推断是……，这个没测过。"手册里凡是标了"读代码推断""未测""作者判断"的，都用这个句式。

### 3.4 数字纪律

- 每个数字说出口时带三个前提：**什么模型**（本地 qwen2.5:7b / nomic-embed-text，不是 GPT 级）、**多少样本**、**是否显著**。
- 置信区间跨 0 就说"数值上高、不显著"，不说"更好"。
- 假模型压测的吞吐数字一定要说"假模型、0 ms、单机"。
- 一个结论只背一个数字，不要把三个版本的数字混着说。

### 3.5 "用了 AI 编码工具吗？"

坦白用了（FAQ #22 已是这个口径）。所有权讲这四样，并且每样都准备一个具体例子：

1. **边界是你定的**："模型只提议、运行时决定"，哪些步骤允许自动重放、哪些转人工。
2. **指标是你选的**：为什么用外部标注的 QASPER、为什么要配对 bootstrap、为什么分 cited 和 context 两种证据召回。
3. **你知道什么时候不信一个数字**：伪 embedding 让 hybrid 看起来比 BM25 差；评测脚本只读了拆分后的第一条 claim，冤枉了 LLM 评审。
4. **你自己定位过 bug**：`Number(null)` 让 Retry-After 失效；取消的调用被熔断器记成失败（234 次里 226 次 503）。

再补一个强证据：**你知道项目文档哪里曾经过时**（比如 AGENTS.md 以前写着 `<表>_bm25_rank` 函数和 `RAG_BM25_PRUNE_DF_FRACTION`，代码里实际是 `<表>_sparse_search` 和 `RAG_SPARSE_PRUNE_DF_FRACTION`，已改正）。能说出这种细节，说明你读的是代码，不是文档。

### 3.6 "测了没改默认"怎么讲成优点

固定句式：**"事先定了规则 → 在 train 上调 → 在 dev 上确认 → 没过规则，所以不改默认；代价已知，选项保留。"** 例如 LLM 评审能把答题率拉上去，但会多答不可答题（QASPER train 0/9 → 2/9），超过事先定的上限，所以默认关。面试官真正想听的是：你不会为了好看的数字改标准。

## 4. 选主线，背必会

### 4.1 三条主线

简历和自我介绍只突出 3 条主线，其余等被问到再展开：
- 主线 1：受控 Agent 编排。「模型只提议、运行时决定」+ 按请求生成 strict schema（7B 降级 56%→8%）+ typed DAG 整图校验 + LangGraph 只接管需要 checkpoint/中断的两张图（外层因压测 +17.6% 不过门留在原生）。配套讲持久化、重放矩阵、审批哈希绑定、fencing，以及「不是 exactly-once」。
- 主线 2：有证据的 RAG + 评测方法论。hybrid（pgvector + PG 内 BM25，加权 RRF）+ 拒答门控 + 词法 claim 校验 + finalizer；评测用外部标注的 QASPER、配对 bootstrap、事先定规则、train/dev 分离。把「测了不改默认」当成卖点：伪 embedding 反转、评审/开关三轮不过规则、按句切块 dev 不复现。必须主动说 agent 路径答题率低（0/41）。
- 主线 3：生产化可靠性与性能。LLM 容错/熔断/公平队列（79→100%、取消计失败 bug），用 pg_stat_statements 定位往返 167→22，claim memo CPU 12–13→约 5 ms，RLS 多租户一次往返流水线。
只在被问到时讲：服务四层拆分与签名 token、读副本（没达标）、索引版本蓝绿切换、语义缓存、查询适配器、Docling/auto 与 worker 池、信封加密与 crypto-shred、审计哈希链、RBAC/OIDC、Prometheus/SLO、MCP server、备份恢复、入库分阶段队列。
注意：
- 简历上不要罗列几十个开关和迁移号，面试官会挑你讲不清的那个打。
- 每个数字只写一个，并带前提（本地 qwen2.5:7b、假模型、单机、样本量）。
- 多租户在简历上写「实现了可选开启的多租户加固（RLS、加密擦除、审计链）」，不要写「生产级多租户」。
- CURRENT-TRUTH 的 3.31/3.32 和过时句子已在 2026-10-18 补改（见第 9 节）；以后数字变了，照例先改 CURRENT-TRUTH。

投什么岗就把哪条主线放第一：偏 Agent / 应用架构的岗位先讲主线 1，偏 RAG / 算法应用的先讲主线 2，偏平台 / 后端的先讲主线 3。

### 4.2 面试前必须能脱稿讲的 12 件事

1. 一句话定位 + 「模型只提议、运行时决定」的四个落点：意图在正则候选的 enum 里选；外层 8 种固定阶段；只有 custom Skill 阶段画 typed DAG、整图校验；scope/docIds/预算/审批/并发归运行时
2. 一次 /chat 的函数链能脱稿画：runAgentRag → createAgentIntentPlanResult → createAgentSession → prepareAgentRun → createAgentExecutionPlanResult → runAgentExecutionPlan（custom_skills 走 LangGraph DAG、document_rag 走 runDocumentRagLoop）→ finalizeAgentRun；默认配置有 3 次模型调用（两次规划 + 一次答案）
3. 防幻觉四道关和它的代价：门控 0.51 → 词法 claim 校验 → 补检索 1 轮 → finalizer 删句；只词法正确改写接受 3/42、agent 路径 QASPER train 0/41；评审默认关因为会答不可答题（0/9→2/9）
4. 评测方法论三件事：伪 embedding 反转排序；QASPER dev 821 题配对 bootstrap，hybrid 只显著好于 BM25；规则事先定、train 调 dev 确认（按句切块、门控阈值都是「测了不改」）
5. 结构化输出故事：降级 56%→8%、通过 47%→80%；pattern 而非 maxLength；不限长 rationale 3810 token；parseFirstJsonValue 取第一个平衡 JSON；只修 prompt 的对照组没提升
6. LangGraph 取舍：只两张图；外层 StateGraph +29–35%、Pregel 后并发 1 仍 +17.6%，不放宽 10% 门；自定义 checkpointer 写 run 行；drain 代替 signal；golden 102 文件后删原生，回退只能 git revert
7. 持久化与恢复：revision CAS 同语句返回事件；重放矩阵；claim fencing；自动续跑范围很窄；不是 exactly-once；主动承认 run 没有租约、多实例重启会误判
8. 审批防 TOCTOU：approvalObjectHash + 一个 CAS 写 gate/快照/checkpoint；resume 只用运行时标记；跨进程 14/14 写入恰 1；但 4 个 custom Skill 全只读、v3 默认 off
9. LLM 容错：等抖动退避、Retry-After 下限、超时可重试、空响应重试、注册表切备用；在途 8、5 次熔断 30 s、429 不计、取消不计；429 79→100%、宕机 0→100%（须备用）；Number(null) 和取消计失败两个 bug
10. 多租户：RLS 兜漏写过滤（9/9→0/9）；一次往返流水线（167→22，4 实例 +37.9%）；RLS 下 GIN 不可用 → SECURITY DEFINER 函数内收窄；默认鉴权关、lenient fail-open、RLS 不防注入
11. 性能数字的前提：假模型 0 ms、单机；claim memo 每请求 CPU 12–13→约 5 ms；拆分同机比单体慢 1.56 倍、只扩 agent 层有效；LLM 规划约 1/3 容量是推算
12. 默认关闭清单和理由（必须背熟）：评审、拒答标记/override、7 个答题率开关、交叉编码器、Docling/auto、v3 统一图、语义缓存、查询适配器、按句切块、截止时间与断连取消、加密与多数租户开关；以及边界：只测过本地 7B、无生产流量、compose.services.yml 未跑、告警未在 Prometheus 求值、OCR 只 1 份样本、注入改写 3/3

## 5. 跨模块追问链

真实面试不会按子系统出题，而是从一个开场问题出发，抓住你回答里的词一路追到另一个模块。每条链先遮住答案骨架，自己连续答到最后一层。

### 5.1 你的系统怎么保证回答不胡说（防幻觉）？

**在考**：精度与答题率的取舍意识；评审校准方法（构造集 vs 人工标注）；是否敢主动说出 0/41 这类难看的数字

**追问顺序**

1. 你说逐句校验，词法规则会不会把正确的改写也拒掉？拒掉多少？
2. 那为什么不直接用 LLM-as-judge 或 Ragas faithfulness？
3. 你的评审用的是同一个 7B 模型，怎么校准的？kappa 多少？
4. 没有人工标注校准，凭什么说它能用？为什么默认关？
5. 那默认配置下 agent 路径到底答了多少题？用户一直被拒怎么办？
6. 如果重做，你换成什么信号、用什么数据证明？

**答题骨架**

- 四道关：生成前门控 server/rag/confidence.js assessQaConfidence；prompt 要求保留原文措辞和数值；生成后词法校验 server/rag/self-check/support.js evaluateClaimAgainstCitations；finalizer 删无支持句 server/rag/grounded-answer-finalizer.js finalizeGroundedAnswer。对比另有结构化门 assessStructuredDifferenceAnswer
- 主动说范围：claim 自检只在 agent /chat 路径；MCP archive_ask 只有门控、注入筛查、链接守卫
- 代价：只用词法时正确改写接受 3/42、错误 0/42（docs/evaluation.md「Claim 评审：校准与端到端」，构造集 14+14 条×3 轮，qwen2.5:7b）
- 评审只当第二意见：只复核被词法拒绝的、只升不降、数字必须在证据里（claim-judge.js isJudgeEligible / claimNumbersAppearInEvidence），异常保留词法结论
- 校准只在构造对照集上做：错误接受 0/54；kappa 没算，eval:judge 只有框架
- 默认关的直接原因：QASPER train 只开评审可答 10/41，但不可答 0/9→2/9（CURRENT-TRUTH 3.21）
- 默认 agent 路径 QASPER train 评审关 0/41：这是瓶颈，不是成绩；宁可拒答是产品取舍
- 重做：让模型结构化输出 claim + 片段 id；人工标注一小批校准 NLI/评审并报 kappa

### 5.2 你说 hybrid 检索效果好，好多少？怎么证明？

**在考**：统计素养；会不会主动收窄结论；能否说出自己评测设计的漏洞

**追问顺序**

1. 在什么评测集上测的？多少题？用的什么 embedding？
2. 48 条用例够吗？置信区间怎么算的？
3. 为什么用配对 bootstrap，不用 t 检验或直接比均值？
4. QASPER 上 hybrid 比纯稠密显著吗？
5. 同一篇论文的多道题是相关的，按题重采样区间会不会偏窄？
6. 同一个 dev 集用了很多轮实验，算不算在 dev 上过拟合？

**答题骨架**

- 伪 embedding 下 hybrid 0.543 < BM25 0.658，真实 nomic 下 0.712 最高：替身只能测管道（CURRENT-TRUTH 3.1，48 条）
- 48 条：hybrid−dense +0.057 [−0.031, +0.156]，不显著
- QASPER dev 821 题：hybrid−BM25 +0.074 [+0.048, +0.102] 显著；hybrid−dense +0.006 [−0.019, +0.031] 不显著 → 只说「比单用 BM25 好」
- 方法：server/evaluation/run-retrieval-comparison.mjs pairedBootstrapDelta，配对去掉题目难度方差、固定种子可复现
- 主动认缺陷：没按论文 cluster；没做多重比较校正；dev 200 题（seed 1）被多轮复用；这些 QASPER 数字在 standalone 本地 store 上测
- 纪律：规则事先定、train 调 dev 确认；按句切块 train +0.040 显著，dev 不复现、前三名 −0.027 显著更差（3.27）

### 5.3 你这个算 Agent 还是 workflow？和 ReAct 比有什么区别？

**在考**：设计理念是否自洽；能否承认模型能力限制；扩展性思考

**追问顺序**

1. 意图是谁识别的？规则没覆盖的意图怎么办？
2. 为什么不让模型自由调用工具？
3. 那模型到底能决定什么？typed DAG 在 7B 上效果怎样？
4. 动态组合只有 2/5，这个设计的价值在哪？
5. Skill 从 4 个变成 400 个，哪里先坏？
6. 换成 GPT 级模型，你会放开哪些限制？

**答题骨架**

- 受控 Plan-and-Execute：正则生成白名单候选（agent-intent-rules.js buildIntentPlanCandidates）→ LLM 在 enum 里选（buildIntentPlannerResponseFormat）→ 外层 8 种固定阶段（agent-execution-plan.js AGENT_EXECUTION_STEP_SCHEMA）
- 只有 custom Skill 阶段由模型画 typed DAG，validateExecutionGraph 整图接受或拒绝；scope、docIds、预算、审批由运行时决定
- 不用 ReAct：要可审计、成本有界（replan 1 次、补检索 1 次）、副作用需事前审批；没做 ReAct 对照实验，不说它不行
- 7B 证据：降级 56%→8%（3.3）；动态组合 2/5（3.5）；v3 统一图采纳 3/15（3.17）
- 价值是安全边界：模型规划差时退回确定性图，不越权、不部分执行
- 规模：正则意图会冲突、schema 随目录膨胀 → 检索式工具选择再给 LLM；默认 custom 预算 2，capNodesToBudget 把节点压到 2

### 5.4 你为什么用 LangGraph？

**在考**：框架选型判断力；性能门禁；迁移工程方法（strangler、golden）；风险意识

**追问顺序**

1. 既然用了，外层计划为什么不放上去？
2. 10% 的门怎么定的？+17.6% 怎么测出来的？
3. checkpointer 为什么不用官方 PostgresSaver？
4. 取消为什么不直接把 AbortSignal 传进去？
5. 你删了原生调度器，怎么证明行为没变？
6. 现在出问题怎么回退？

**答题骨架**

- 只给需要持久状态和中断的两张图：custom-Skill DAG 和 v3 统一图（langgraph/run-execution-graph.js runExecutionGraphOnLangGraph）
- 外层编成 StateGraph 并发 32 每请求 CPU +29–35%（3.28）；改底层 Pregel + 编译缓存 + 剪枝后进程内多 0.28 ms，但并发 1 仍 +17.6%、p95 +13%（3.29）→ 不放宽门，外层长期原生（runAgentExecutionPlan）
- RunStoreCheckpointSaver 写现有 run 行，同一 CAS 和 RLS；权威是自己带 digest 的图 checkpoint；代价写放大：2 节点 /chat 多 7 次无事件 CAS
- signal：spike 实测是至少一次（在途节点续跑时再跑）→ 改 drain（drain-bridge.js bridgeRequestSignalToDrain）
- 删原生前冻结 golden：8 套件 102 文件；52 个调度契约测试原样跑在 LangGraph 上（3.30）
- 局限：golden 只覆盖固定场景、Node 22 未验证、两个 PG 集成套件 native 侧没冻结；回退只能 git revert

### 5.5 Agent 跑到一半进程崩了怎么办？

**在考**：分布式一致性基本功；能否主动承认设计缺陷

**追问顺序**

1. 能自动从断点续跑吗？哪些 run 能？
2. 是 exactly-once 吗？
3. 两个 worker 同时续跑怎么办？旧 worker GC 停顿 60 秒回来呢？
4. 多实例滚动重启，会不会把别的实例正在跑的 run 当成孤儿？
5. 为什么不用 Temporal？
6. 如果重做你改什么？

**答题骨架**

- run 是 PG 一行 + revision CAS（postgres-agent-run-store.js commitRunUpdate），同一语句返回事件列表
- 自动续跑很窄：custom_skill 步骤；外层只剩 custom_skills 的 guarded 图（agent-run-recovery.js hasGraphOnlyStoredExecutionPlan）；v3 guarded run。主 document_rag 在途 → 转人工
- 不是 exactly-once：重放矩阵 STEP_REPLAY_SAFETY_MATRIX + 写前意图 + 幂等键 + 在途未知一律转人工
- fencing：claimExecutionGraphResume 写 UUID claim，旧 worker 下一次写被 AGENT_GRAPH_EXECUTION_FENCED 拒；挡不住它已发出的外部调用，所以要幂等键
- 主动承认（读代码推断、未测）：listRecoverable 只按 status 选，run 没有租约和心跳，多实例重启会误判
- Temporal 没正式评估：粒度只需节点边界 + 审批暂停，已有 PG + RLS，ALS 上下文要穿 activity 边界
- 重做：run 租约 + 心跳；记忆写入按 runId+stepId 加幂等键

### 5.6 Agent 要做有副作用的操作（比如写工件）时，你怎么控制？

**在考**：TOCTOU 意识；幂等设计；能否诚实说「防护守的边界还没有真实实例」

**追问顺序**

1. 用户批准的和实际执行的，怎么保证是同一个东西？
2. 审批中断后怎么续跑？resume 传的是什么？
3. 批准后执行时崩溃，会写两次吗？
4. 你现在的 4 个 custom Skill 有副作用吗？
5. 图内审批默认开吗？现在谁在用审批？

**答题骨架**

- 暂停时生成私有快照，approvalObjectHash 对规范化的 scope、Capability、版本、输入取 sha256；gate、快照、checkpoint、状态一个 CAS（agent-runs.js pauseExecutionGraphForApproval）
- 批准请求必须带门上的哈希；执行前 verifyApprovalExecutionSnapshot 重算，timingSafeEqual；verifyCapabilityGraphApproval 按 live 版本复核
- interrupt 载荷只有 kind、nodeId、gateId:null；resume 只用 RUNTIME_RESUME_MARKER，决定从 run store 读
- 写入用 buildCapabilityArtifactIdempotencyKey + 唯一约束；跨进程测试 14/14 写入恰 1 次，写后崩溃转人工（3.17）
- 诚实交代：4 个 custom Skill 全 readOnly；v3 默认 off；默认生效的是 V1 capability_call 审批

### 5.7 多租户数据隔离怎么做的？

**在考**：纵深防御理念；PostgreSQL 细节；性能工程；不夸大默认能力

**追问顺序**

1. 每个 store 已经有 WHERE 了，为什么还上 RLS？
2. 每条语句都要切角色，性能怎么样？
3. RLS 下全文检索怎么办？
4. SECURITY DEFINER 不就绕过 RLS 了吗？
5. 租户上下文丢了会怎样？
6. 默认配置下隔离开着吗？

**答题骨架**

- 租户 = (userId, workspaceId)，来自凭据；认证后的空范围 403（server/auth.js requireTenantScope）
- RLS 兜漏写过滤的 bug：自建探测 9/9 表 → 0/9（CURRENT-TRUTH 3.8）
- set_config('role', $1, true) + 扩展协议流水线一次往返（postgres.js PipelinedQuery）：租户往返 167→22，4 实例 +37.9%（evaluation.md「每次 /chat 的数据库往返」，含 run store 不回读的贡献）
- @@ 不是 leakproof → owner 函数用 GIN 打分只返回 id+分，函数内按策略收窄 doc_id；审查发现过「先截断后过滤」泄露
- 默认 lenient：上下文丢失 fail-open；strict 和角色拆分可选（postgres.js assertDatabaseContextBound）
- 主动说：API 鉴权默认关（默认单租户）；RLS 不防 SQL 注入；全开配置只在单机单体 e2e 验证过

### 5.8 调用大模型 API 失败、限流时怎么处理？

**在考**：生产可靠性经验；故障注入方法；并发控制

**追问顺序**

1. Retry-After 怎么处理的？踩过坑吗？
2. 429 也切备用模型，不会加重拥塞吗？
3. 持续过载靠重试兜不住怎么办？
4. 熔断器什么算失败？被用户取消的调用算不算？
5. 多实例时并发上限怎么算？Redis 挂了呢？
6. 为什么不用 SDK 自带重试或 LiteLLM？

**答题骨架**

- openai.js withRetry：等抖动指数退避（500/1000/2000，封顶 4 s）；Retry-After 作下限；超过 10 s 放弃；超时可重试；空响应重试 1 次；isFailoverEligible 才切备用
- 故事：Number(null)=0 让 Retry-After 被忽略，单测推翻了我原来的解释（NARRATIVE 故事 3）
- 故障注入：429 79.2%→100%，主模型宕机 0→100%（必须配备用），限流 p95 2.5→4.7 s（3.4，本地假服务）
- model-call-guard.js guardModelCall：在途 8、连续 5 次不可用熔断 30 s、429 不计；按租户公平队列 createTenantFairQueue
- 取消曾被记成失败：234 次里 226 次 503，修后 0 次（3.20）
- Redis Lua + 租约共享，挂了退回进程内；ArchiveRagChatModel maxRetries 0，避免两层重试叠加

### 5.9 单机能扛多少 QPS？瓶颈在哪？

**在考**：测量方法；对假模型数字的边界意识；规模推演

**追问顺序**

1. 这个数是接真实模型测的吗？
2. CPU 花在哪？怎么定位的？
3. 为什么要拆成四个服务？拆了更快吗？
4. 默认 LLM 规划器开着，容量会变多少？
5. 放大 100 倍，先坏在哪？

**答题骨架**

- 假模型 0 ms：claim memo 后并发 32 约 239–258 req/s，每请求 CPU 4.6–4.9 ms（3.24）；旧的 91 req/s 是 memo 前
- 定位：压测里每个 /chat 166 条语句的异常值 → pg_stat_statements 差值法 → 往返 167→22
- claim 校验是热点 → 一次 /chat 内精确 memo（self-check/evidence-context.js buildClaimSupportContentKey），不跨请求以免跨租户
- 拆分：同机同进程数单体快 1.56 倍；价值是只扩 agent 层（×2 1.84 倍）和故障隔离（3.19）
- 真模型下容量由模型并发上限决定；LLM 规划每请求多 2 次调用、约 1/3 容量是推算
- 100 倍：PG 单点、单表 HNSW、run 行整行重写、BM25 统计锁热点 → 按 workspace 分区/分片、事件拆表

### 5.10 PDF 里的表格、扫描件怎么处理？切块怎么做的？

**在考**：数据处理工程；实验纪律；不夸大可选功能

**追问顺序**

1. Docling 效果怎么样？为什么不默认开？
2. auto 路由怎么判断一页要不要送 Docling？阈值怎么定的？
3. 为什么不用 RecursiveCharacterTextSplitter？
4. 按句子切不是更规整吗？
5. 做了这么多都没改默认，是不是白做了？

**答题骨架**

- 默认 pdf.js + 段落识别；Docling 整份：69 道表格题 F1 +0.020 [−0.011, +0.057] 不显著，解析 350 s 对 1.4 s（3.14）
- auto：pdf-page-router.js classifyPdfPage 按乱码比、图片覆盖、表格行分页；30 篇送 105/266 页，252–279 s 对整份 329.6 s；F1 无显著差异（docs/evaluation.md「按页分流和并行解析」）
- 阈值就在这 30 篇上定，路由计数不是独立检验；OCR 只在 1 份手工扫描件上验证能走通
- 切块丢字：55 份 PDF 7,866 个字符 → 0（chunker.js findUnindexedPageText，3.25）
- 按句切块：train 显著、dev 前三 −0.027 显著更差，所以不改（3.27）
- 结论是「测了不改默认」：代价已知、选项保留，比凭直觉改默认安全

### 5.11 证据不够时，系统怎么决定拒答？

**在考**：阈值调参方法；能否区分上下文指标和引用指标；产品取舍

**追问顺序**

1. 0.51 怎么来的？为什么不调低？
2. 门控区分可答和不可答的能力有多强？
3. 被门控挡掉的正确题怎么办？
4. 你说上下文里的证据变多了，答案真的引用了吗？
5. 能不能用交叉编码器概率做门？代价是什么？

**答题骨架**

- assessQaConfidence：覆盖率 ≥0.51、相关度下限、编号/引号短语必须出现；不过门不调模型
- 0.51 = 两个词的问题两个都要命中；降到 0.2 时 F1 −0.053 显著变差、不可答识别 85%→15%（3.12）
- 词面信号 AUC 约 0.6，调阈值只是在两种错误之间换
- selectQaContext 把判定和上下文分开：上下文证据 0.245→0.353 显著，F1 不显著
- 上下文有证据 0.596 对答案引用页 0.490，差 −0.106 显著（3.23）：不能把上下文指标说成引用
- 重排概率门：可答拒答 37.8%→13.9%，但不可答识别 80%→45%，且只有 20 题（3.14b）

### 5.12 文档里藏了「忽略之前的指令」，你的系统会被劫持吗？

**在考**：安全评测设计；能否识别自己测量的偏差

**追问顺序**

1. 攻击成功率多少？有对照组吗？
2. agent 路径 0/39，是不是因为它本来就不怎么作答？
3. 改写过的攻击呢？
4. 为什么不上 Llama Guard / Prompt Guard？
5. 这些攻击用例是谁写的？

**答题骨架**

- 三层：证据进 prompt 前 screenUntrustedText；prompt 声明证据不可信（answer-writer.js UNTRUSTED_EVIDENCE_RULES）；输出 guardAnswerLinks；规划器看不到正文
- 文档 RAG 出口 17/39→0/39，受攻击时正确事实 22/30→30/30，对照组 9/12 不变，良性 16,001 句误判 0（3.10）
- agent 出口 0/39 要打折：它大多以澄清结束
- evasion_paraphrase 在文档 RAG 出口改前改后都是 3/3 成功
- 用例自建、规则对着用例写，测量偏乐观；没跑 BIPIA、AgentDojo；分类器可作第四层，没测

## 6. 不能说的话，以及该怎么说

左列是最容易脱口而出、一追就倒的说法。

| 别说 | 为什么站不住 | 改成 |
| --- | --- | --- |
| 我们的系统基本不会幻觉 / 零幻觉 | 校验的只是每句话是否被所引片段词法支持；MCP archive_ask 返回的答案不经 claim 自检；不判断答案是否完整；构造集每类错误只有 1–2 条 | agent /chat 路径上每句话都要被它引用的片段支持，构造集上错数字基本过不去；代价是误杀正确改写，7B 下大多以澄清结束 |
| hybrid 检索比纯稠密检索效果更好 | QASPER dev 821 题 hybrid−dense +0.006 [−0.019, +0.031] 不显著（CURRENT-TRUTH 3.1） | hybrid 显著好于单用 BM25（+0.074），和纯稠密没有显著差异，也从没显著更差 |
| 把稀疏检索换成 BM25 后召回提升了 | hybrid 路上 BM25 对 ts_rank_cd 是 −0.0012 [−0.0122, +0.0097]，不显著也没达到非劣性下界；默认 bm25 是产品决定（3.18） | BM25 是标准、可对照的打分，默认用它是我们的选择；QASPER 上两者没有显著差异 |
| 整个 Agent 跑在 LangGraph 上 / 迁 LangGraph 提升了性能 | 只有 custom-Skill DAG 和 v3 统一图在 LangGraph 上；外层计划放上去 CPU +17.6% 过不了门，留在原生循环（3.29） | LangGraph 只调度需要 checkpoint 和中断的两张图，外层因压测不过门长期原生 |
| 进程崩了能从断点自动续跑 | 自动续跑只覆盖 custom_skill 步骤、外层只剩 custom_skills 的 guarded 图、v3 guarded run；最常见的主 document_rag 在途会转人工 | 只在能证明安全时自动续跑，在途未知和会写记忆的步骤一律转人工 |
| 保证 exactly-once / 副作用不会重复执行 | 显式重试主 document_rag 会再记一次会话；Capability 幂等交给 adapter；外部写和落盘之间总有崩溃窗口 | 自动恢复路径不重放副作用；写型 Capability 在 adapter 遵守幂等键时做到效果一次 |
| 版本号 CAS 防止两个 worker 重复执行副作用 | CAS 和 claim 只挡旧 worker 的状态写，挡不住它已经发出的外部调用 | CAS/claim 挡住旧 worker 的状态写；外部写靠幂等键，在途未知靠转人工 |
| 我把系统拆成微服务，性能和扩展性都提升了 | 同机同进程数单体快 1.56 倍；只在一台机器上测过；compose.services.yml 只用 docker compose config 校验过、从没构建启动 | 拆分是可选部署形态，契约测试保证与单体一致；单机实测只有扩 agent 层有效，价值是按瓶颈扩容和故障隔离 |
| 提示注入防住了，攻击成功率 0 | 刻意改写在文档 RAG 出口 3/3 成功；用例自建、规则对着用例写；agent 出口的 0 大多因为答案被澄清扣下 | 已知写法在文档 RAG 出口从 17/39 降到 0/39，挡不住有针对性的改写，没跑第三方基准 |
| LLM 评审准确率 93% | 39/42 是构造集上正确改写的接受率，标签由构造保证、不是人工标注；评审和作答是同一个 7B | 构造集上正确改写接受 39/42、错误 0/42，没有人工标注校准，所以默认关 |
| 我把 Agent 答题率从 0 提到了 36% | 第二轮多答了不可答题（0/9→2/9），超过事先定的上限，verify:quality 也掉到 14/18，默认没改（3.21） | 开关能把答题率拉到约 0.36，但会多答不可答题，按事先定的规则没改默认 |
| 系统支持表格和扫描件，Docling 让表格题更准 | Docling 和 auto 的 F1 差异都不显著；OCR 路由只在 1 份手工扫描件上验证；默认仍是 pdf.js 文本层 | 有可选的版面解析和按页分流，测下来答案质量没有显著差异；OCR 只验证了能走通 |
| 做了生产级多租户隔离，默认就是隔离的 | API_AUTH_ENABLED 默认 false；strict、角色拆分、成员制、RBAC、加密等大多默认关；全开组合只在单机单体 e2e 验证 | 实现了一套可选开启的多租户加固，默认是单租户；RLS 默认 enforce，全开配置在单机单体上端到端验证过 |
| 删租户时销毁密钥，旧备份里的数据也读不了了 | 加密只覆盖文件字节；切块文本、向量、run 快照、记忆、审计在旧备份里是明文；本地 KMS 只到演示级 | 原件做到 crypto-shred；其他数据在旧备份里仍是明文，所以备份保留期必须有上限 |
| 审计日志不可篡改 | 哈希链只能发现篡改；DBA 可重算整条链；链尾截断要外部锚定链头才能发现 | 审计哈希链能发现篡改，不能防 DBA 重写，链头要存到外部比对 |
| 单机能扛 250 QPS / 优化让吞吐提升 2.6 倍 | 假模型 0 ms、回答很短、单机；真实模型下容量由模型并发决定；默认 LLM 规划器每请求多 2 次调用 | 假模型下编排层每请求 CPU 从 12–13 ms 降到约 5 ms；真实模型的加速比没测 |
| 流式输出降低了首字延迟 | 当前校验器下几乎不产生草稿：合同题 21 次里 4 次，论文题 0 次（CURRENT-TRUTH §4） | 流式草稿保证不展示未经校验的内容，在当前校验器下几乎没有延迟收益 |
| 语义缓存零误命中，很安全 | confirm 集是守卫作者自己写的、不是盲测；95% 上界 5% 还假设样本独立；默认关 | 留出集误命中 0/59（旧守卫 25/59），没有盲测，默认关 |
| trajectory 19/19、规划器 80% 通过，说明 Agent 质量好 | trajectory 是脚本化 ragService + mock，只证明编排契约；80% 是 7B、30 个用例、5 轮 | 契约层 19/19；真实 7B 规划器用例 24/30、动态组合只有 2/5 |
| SLO 告警已经上线 | 告警规则从没在真实 Prometheus 或 promtool 里加载求值过；compose 没打开 METRICS | 写了按 SLO 燃烧率的规则和解析测试，还没在真实 Prometheus 上求值过 |
| v3 统一图已经上线，模型能自由编排异构工具 | v3 默认 off；7B 规划只被采纳 3/15；CPU 是 V1 的数倍到十几倍（ADR 阶段 5，mock 微基准） | v3 有 guarded 档和图内审批，运行时契约测过；默认关，没有真实模型证据 |

## 7. 「是不是你做的」真伪测试

面试官用这类问题判断你是否真的吃透了代码，而不是背了 AI 写的文档。共同点：问一个具体常量或写法的理由，或问「改一下会怎样」。答法是讲出当时的现象、指到函数、说出改动后果。

**7.1 QA 覆盖率下限为什么是 0.51，不是 0.5？改成 0.5 会怎样？**

讲含义：两个词的问题两个都要命中；说出后果：≤0.5 会翻转 test/rag.test.mjs、rag-boundary-coverage 里的相邻话题测试（育儿假 vs 年假）；再给数据：降到 0.2 dev F1 −0.053 显著变差（CURRENT-TRUTH 3.12）

**7.2 parseFirstJsonValue 为什么取第一个括号平衡的 JSON，而不是第一个 { 到最后一个 }？**

讲现象：Ollama 不硬执行 schema，JSON 闭合后还会接着写中文，旧解析失败；指出 server/rag/structured-output.js parseFirstJsonValue；顺带说为什么规划器不用 withStructuredOutput

**7.3 strict schema 为什么用 pattern 限长，不用 maxLength？**

讲踩坑：不限长的 rationale 让约束解码一次生成到 3810 token；查文档 strict 模式只列 pattern；改后单次 754 token/15 s → 374 token/7 s（NARRATIVE 故事 2）

**7.4 Retry-After 那个 bug 是怎么定位的？**

先讲自己原来的错误解释（粗粒度 Retry-After 让重试保守），再讲单测失败暴露 Number(null)=0，最后讲修法：先判断头存在、退避基数调到 500 ms 让平均等待持平（server/rag/openai-client.js parseRetryAfterMs）

**7.5 interrupt() 为什么必须是节点里第一个有效操作？**

讲 LangGraph 语义：resume 时节点从第一行重跑，spike 里 interrupt 之前的代码跑 2 次、之后的副作用 1 次；所以审批节点在 interrupt 前不开 step、不预留预算、不写 checkpoint

**7.6 CAS 写之前为什么要在同一往返里先 SELECT ... FOR NO KEY UPDATE？**

讲 PG 快照语义：语句开始时拍快照，等行锁期间别人追加的事件不改 revision，返回列表会漏；这是审查发现的；指出 postgres-agent-run-store.js lockRunRowFirst / buildRunEventListCte

**7.7 把 RAG_LLM_MAX_CONCURRENCY 从 8 改成 2 会怎样？**

推演：吞吐被卡、排队延迟上升；跨文档 embedding 合批开始起作用（上限 2 时 41.7 对 19.6 篇/秒，3.16，假模型下的上限）；开 Redis 时这是集群上限，不是每进程

**7.8 把 DEFAULT_MAX_REPLANS 调成 3 会怎样？**

讲还剩什么保护：补丁过同一个校验器、指纹去重；讲变弱的：终止性论证、成本上限；承认更高上限没灰度过，也没有真实模型 replan 证据

**7.9 429 为什么不计入熔断？有什么副作用？**

讲理由：429 说明服务在线，交给退避；再主动说边界：guard 对 429 调 recordSuccess 会清零连续失败，429 和 503 交替时会推迟熔断

**7.10 被截止时间取消的模型调用，为什么不算熔断失败？**

讲实测发现：5 次短截止就把模型熔断 30 s、影响所有租户，234 次里 226 次 503；修法 isCallerCancellation + 半开探测 abandon；修后 0 次 503（3.20）

**7.11 golden 改写后为什么本次测试仍然判失败？**

讲意图：防止像 --updateSnapshot 一样一键掩盖行为变化，必须看 diff、在同一改动里写明行为变化再重跑；指出 test/langgraph-support/graph-goldens.mjs isUpdatingGraphGoldens

**7.12 公开事件 id 为什么要改写成 runId:n？**

讲侧信道：事件表 BIGSERIAL 所有租户共用，id 间隔泄露别的租户活动量；排名稳定是因为插事件前先锁 run 行；指出 agent-runs.js toPublicRunEventIds

**7.13 evaluateDocumentEvidence 里 requiredDocCoverage 为什么是 min(docIds 数, 2)？有什么副作用？**

说出代码位置 server/rag/self-check/evaluate.js；推测副作用：多文档范围内问单文档事实题，可能被判 document_coverage 缺口触发补检索或澄清；明确说这是读代码看到、没测过影响

**7.14 给你一个反直觉的结论：哪次你的直觉被数据推翻了？**

挑 2 个讲细节：外层 LangGraph 两次压测都不过门、坚持不放宽（3.29）；按句切块 train 显著、dev 前三名显著更差（3.27）；软换行规则太宽让相同文档对照组误报差异（故事 6）

**7.15 用了 AI 编码工具吗？哪些是你自己的？**

坦白用了（FAQ #22）；说清自己负责的是边界、指标和「何时不信一个数字」；举出自己发现并改正过的过时文档（如 AGENTS.md 曾写着不存在的 <t>_bm25_rank、RAG_BM25_PRUNE_DF_FRACTION），证明读过真实代码

**7.16 如果要让补检索用原问题而不是元文本，你改哪里？效果会怎样？**

指出 server/rag/self-check/gaps.js buildFollowUpQuestion / buildEvidenceRetryQuestion 和已有开关 AGENT_FOLLOW_UP_ORIGINAL_QUESTION；给结论：单开时可答仍 0/41（3.21），说明瓶颈在词法校验，不在补检索

**7.17 这个仓库这么大，你真的都读过吗？**

不背行数，按子系统讲：每块能指到入口函数和关键常量；坦白有些部分只读过接口和测试；现场能画 /chat 链路并说出 runAgentRag → runAgentExecutionPlan → runDocumentRagLoop → finalizeAgentRun

## 8. 白板题

### 8.1 画出系统整体架构（默认单体 + 可选拆分）

- 前端 React（fetch + ReadableStream 解析 SSE）与 MCP stdio server（archive_ask，只读、不走 agent 规划器）
- 单体进程 server.js（ARCHIVE_RAG_ROLE=all）内部：鉴权/租户/RBAC 中间件 → chat/tasks 路由 → Agent 编排 → 文档 RAG → 检索 → 模型调用
- 可选拆分四层：api → agent → retrieval → model-gateway，层间签名 token（accessScope、aud/iss、htm/htu/bdh）和 SERVICE_CALL_POLICY
- PostgreSQL 16 + pgvector：文档/分块/BM25 统计/run/task/审计/入库队列，RLS 策略；可选读副本
- 可选组件：Redis（共享熔断和并发）、docling-serve、交叉编码器 reranker、OTLP 收集端、/metrics 独立端口
- 标注默认值：鉴权默认关、v3 默认 off、rerank/Docling 默认关；compose.services.yml 未真正跑过

### 8.2 画一次 POST /chat 的全链路，标出模型调用点和数据库写

- runAgentRequestWithCancellation（可选截止时间）→ runAgentRag（runWithRunUsage、invoke_agent span）
- 意图：buildIntentPlanCandidates（正则）→ LLM enum 选择 → 失败回落确定性（模型调用 1）
- createAgentSession（Skill match、工作记忆、预算）→ createRun（1 次 INSERT）
- 执行规划：buildPlannerResponseFormat strict schema → validateAgentExecutionPlan（模型调用 2）
- runAgentExecutionPlan 原生循环：custom_skills（LangGraph DAG）→ document_rag（runDocumentRagLoop：检索 hybrid RRF → assessQaConfidence → writeQaAnswer（模型调用 3）→ 自检 → 至多 1 次补检索）→ web 兜底
- finalizeAgentRun：finalizer 删无支持句 → completeRun（CAS）
- 标注：每次 /chat 1 insert、3 CAS、2 事件追加、0 回读（test/agent-run-chat-statement-count.test.mjs）

### 8.3 画崩溃恢复和图内审批续跑的时序

- run 行字段：status、steps、approval_gates、result.__skillGraphCheckpoint、result.__langGraphCheckpoint、revision
- 节点执行：startGraphStep（带 resumeClaim 的 CAS）→ 写前意图 → 执行 → 结算 CAS
- 审批：preflight 停靠 → interrupt({kind,nodeId,gateId:null}) → pauseExecutionGraphForApproval 一个 CAS 写 gate+快照+checkpoint+waiting_for_user
- 批准：带 approvalObjectHash → applyExecutionGraphApprovalAction → prepareUnifiedGraphApprovalResume 对账 → Command({resume: RUNTIME_RESUME_MARKER}) → verifyCapabilityGraphApproval → 幂等键执行一次
- 崩溃后启动：listRecoverable → 对账 checkpoint 与 steps → claimExecutionGraphResume 写 UUID → 续跑；在途未知 → markManualRecovery
- 旧 worker 回来：下一次写被 AGENT_GRAPH_EXECUTION_FENCED 拒；标出缺陷：没有 run 租约，多实例重启会误判

### 8.4 画一条租户语句在数据库里怎么被隔离（含稀疏检索）

- requireApiAuth → buildAccessScope → requireTenantScope → bindDatabaseTenant（AsyncLocalStorage）
- queryPostgres → resolveStatementRole → 一次往返：Parse/Bind/Execute(set_config role/user_id/workspace_id) + Parse/Bind/Execute(业务语句) + 一个 Sync
- PG：tenant_isolation 策略按 current_setting 过滤；LOCAL 设置在 Sync 结束失效
- 稀疏检索：租户身份 → SECURITY DEFINER 函数（GIN 打分，函数内按策略收窄 doc_id，只返回 chunk_id+分）→ 租户身份 JOIN 回分块表
- 四种上下文 tenant/system/unscoped/unbound；默认 lenient 时 unbound 走 owner（fail-open），strict 或角色拆分时报错
- 标数字：往返 167→22（并发 1 差值法）；漏写过滤探测 9/9→0/9

### 8.5 画评测体系和门禁的分层

- PR：quality-gate.yml 三个并行 job；确定性 64 维哈希 embedding + mock 模型；trajectory 19 用例、planner mock 7 用例；quality:current 同 SHA、干净工作区、24h、manifest、钉死 baseline
- 每周：real-model-eval.yml Ollama（nomic + qwen2.5:7b），verify:quality 和 QASPER 召回 ≥0.6 阻断，答案 F1 只报告；local store、不连数据库
- 离线效果：QASPER train 调 → dev 确认；配对 bootstrap；事先定规则；cited 与 context 证据分开
- 可靠性/安全：eval:llm-resilience 故障注入、eval:prompt-injection 红队 + 对照组
- 发布：release:gate 要 GPT 级模型和 key，本机产不出，文档里没有通过记录
- 标出盲点：按题重采样没 cluster、dev 复用、合成判分复用生产 claim checker

## 9. 已经修正的材料

2026-10-18 按 [deep-dive/STALE-ITEMS.md](deep-dive/STALE-ITEMS.md) 修正了 CURRENT-TRUTH、FAQ、两份讲述稿和 AGENTS.md（每条的处理结果记在那个文件末尾）。面试前把这几处改动重读一遍，因为它们就是你以前会说错的地方：

| 以前的说法 | 现在的说法 |
| --- | --- |
| FAQ #6："sparse（PostgreSQL 全文检索，不是 BM25）" | 默认是 PostgreSQL 内自建统计的 Okapi BM25，`ts_rank_cd` 可选；QASPER 上两者没有显著差异，默认 BM25 是产品决定 |
| FAQ #15："还没做对抗性测试集" | 已有 `eval:prompt-injection`：13 个攻击用例、三层防护，文档 RAG 出口 17/39 → 0/39；刻意改写的英文攻击仍 3/3 成功 |
| FAQ 反思题："v3 冻结在 shadow" | v3 有 `guarded` 档和图内审批（默认 off）；两张图由 LangGraph 调度，原生调度器已在阶段 6 删除 |
| 180 秒稿："崩溃后从 checkpoint 续跑，用 CAS 防止重复执行有副作用的步骤" | 只在能证明安全时续跑；CAS 挡的是旧 worker 的**状态写**，不是已发出的外部调用 |
| 180 秒稿："评测集还小，正在接 QASPER" | 外部标注集已接入（检索 821 题、答案 200 题），但只测过一个 7B 模型 |
| 180 秒稿："只处理 PDF 文本层，没有 OCR 和表格" | 版面解析和按页分流可选，答案 F1 没有显著差异，所以默认仍是 pdf.js |
| CURRENT-TRUTH 停在 3.30 | 新增 3.31（PDF 按页分流与 worker 池）和 3.32（租户隔离阶段 1–5） |

FAQ 新增了三题（18 LangGraph 取舍、19 多租户、20 数据库往返），原来的 18、19 两道反思题顺延成 21、22；故事集新增故事 8（取消被熔断器记成失败）和故事 9（外层计划上 LangGraph 两次压测不过门）。

## 10. 练习计划

**原则**：每道题**出声**用四步法答，录音回放，超过 60 秒就砍；答不上的题回到代码里找到那个函数再答一遍，而不是背答案。

| 天 | 内容 | 产出 |
| --- | --- | --- |
| 1 | 第 2 节结构图 + `/chat` 函数链；白板题 1、2；第 4 节必会清单前 4 条 | 能 3 分钟脱稿画完 `/chat` 链路，标出 3 个模型调用点 |
| 2 | 主线 1：`01-agent-orchestration`、`02-durability-recovery` 的追问阶梯 | 每题四步法录音一遍；L3/L4 题打开代码核对函数名 |
| 3 | 主线 2：`03-retrieval-parsing`、`04-grounding-safety`、`05-evaluation` | 能讲清 cited 和 context 两种证据召回的区别、配对 bootstrap 为什么配对 |
| 4 | 主线 3：`07-platform-reliability`；`06-multitenancy-security` 只看 30 秒讲法和前 5 题 | 第 6 节"不能说的话"逐条改成你自己的说法 |
| 5 | 第 5 节 12 条追问链 + 第 7 节真伪测试 | 每条链连续答到最后一层不卡；每个真伪题能指到文件和函数 |
| 6 | 模拟面试两场：一场"严厉拷打型"，一场"深挖学术型"（见下） | 复盘：哪道题答超时、哪个名词是自己挖的坑 |
| 7 | 重读第 9 节列的改动，再用自己的话重写 3 分钟讲述，只保留三条主线 | 新的 3 分钟稿，每句都能展开五分钟 |

时间只有两天：第 1 天做 1–3 的内容只看 L1–L3，第 2 天做 5、6 节和一场模拟面试，第 9 节那张表一定要先看。

**模拟面试**：本机装了 `ai-dev-interview-simulator` 技能，说"开始模拟面试"就能触发。把本手册和你的简历一起给它，身份选你的真实情况，面试官风格选"严厉拷打型"或"深挖学术型"，并要求它专挖本项目。

**怎么判断自己准备好了**：随便翻开一个子系统文件，随机挑一道 L3 或 L4 题，60 秒内用四步法答完，说出至少一个函数名和一个带前提的数字，而且没有用到第 6 节表里左列的任何说法。
