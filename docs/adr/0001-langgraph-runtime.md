# ADR 0001：Agent 编排运行时迁到 LangGraph.js（strangler，保留领域层）

- 状态：**已采纳**（2026-10-14）。阶段 0–4 已完成：自阶段 4 起 `AGENT_RUNTIME` 默认 `langgraph`，`native` 作为整体回退保留一个发布周期。取消方案（drain，不把请求 signal 直接交给 LangGraph）和外层计划保持原生循环（阶段 3）都已认可。阶段 5（收尾，2026-10-16）对照"完成的定义"逐条处理，结论与未达成的条目见"阶段 5 结果"。外层计划长期保持原生循环、不放宽压测硬门，已定为最终决定（用户认可）。
- 日期：2026-10-14
- 范围：`server/rag/` 的 Agent 编排运行时。领域层（检索 SQL、切块、门控、claim 校验、finalizer、注入筛查、鉴权/RBAC/RLS、服务身份、指标）不在范围内。

## 背景

`server/rag/` 里的编排运行时是自研的，分三层：

| 层 | 主要模块 | 行数 |
| --- | --- | --- |
| 外层执行计划（内置 Skill 与 Capability → custom Skills → document loop → Web 兜底 → finalize 的固定阶段） | `agent-execution-plan.js`、`agent-execution-plan-runner.js` | 343（runner） |
| V2 custom-Skill typed DAG 与 v3 统一图的调度 | `agent-execution-graph-runner.js`（拓扑调度、并发上限、原子预算预留、副作用串行、输入/输出 schema gate、审批停靠） | 1055 |
| 图 checkpoint、启动续跑、审批续跑、finalization 收据 | `agent-execution-graph-checkpoint.js`、`agent-unified-graph-run.js`、`agent-unified-graph-stage.js`、`agent-run-recovery.js`、`agent-run-graph-replay-guard.js` | 409 + 1223 + 823 + 671 + 199 |

这些模块和 LangGraph 的原语一一对应：调度器对应 Pregel superstep，私有 graph checkpoint 对应 checkpointer，审批停靠对应 `interrupt()` + `Command({ resume })`，SSE 进度对应 `stream`。迁移的目的，是把调度、checkpoint 落盘、中断续跑和流式传输交给一个广泛使用的运行时，自研代码只保留本项目特有的部分：准入规则、预算、fencing、回放安全矩阵、证据检查和 finalizer。

**与此前决定的关系。** `docs/development.md` 记录过一次移除 langchain（后端直接依赖 18 → 13）。当时 langchain 只用来做 prompt 模板、OpenAI 客户端和 PDF 读取，三者都被更薄的自有模块（`prompt-template.js`、`openai-client.js`、`pdf-loader.js`）替代。本 ADR 不撤销那个决定：模型调用、embedding、检索、切块继续走自有模块，LangChain 只以适配器的形式包在外面（阶段 1）；真正换掉的是编排运行时（LangGraph）。

## 决策

采用 strangler 模式，把编排运行时迁到 LangGraph.js，分 5 个阶段，每个阶段一个独立 commit，阶段末停下评审：

| 阶段 | 内容 | 生产行为 |
| --- | --- | --- |
| 0 | 本 ADR、依赖、spike（全部在 `server/test/` 下） | 不变 |
| 1 | `server/rag/langgraph/` 适配层：ChatModel、Embeddings、Retriever、Skill → tool、`definePrompt` → `ChatPromptTemplate`；启动时断言 LangSmith 关闭 | 不变（适配器与直接调用 `deepStrictEqual`） |
| 2 | custom-Skill typed DAG 跑在 LangGraph 上；run-store checkpointer 进生产；新开关 `AGENT_RUNTIME=native\|langgraph`（默认 `native`） | `native` 下不变 |
| 3 | 统一图成为主图：外层阶段编进 StateGraph；审批走 `interrupt()`；SSE 走 `stream`；启动恢复走 checkpointer | `native` 下不变 |
| 4 | `AGENT_RUNTIME` 默认改为 `langgraph`，删除被替代的调度代码，`native` 保留一个发布周期 | 切换 |

**迁移完成的定义**（来自目标文件；阶段 5 的最终决定修订了“被替代的调度代码已删除”一条：外层计划的原生循环 `runAgentExecutionPlan` 是生产调度器，不属于被替代的调度代码，要删的只有回退窗口之后的 `runExecutionGraph`，见“阶段 5 结果”）：`AGENT_RUNTIME=langgraph` 为默认；被替代的调度代码已删除；所有确定性评测在屏蔽 id 和时间后与迁移前逐字节一致，或差异已按流程在 `quality-current-suite-manifest.js` 升版本并逐条说明；`verify:quality` 18/18；`eval:load-test:pgvector` 的 app CPU/请求和 p95 退化不超过 10%。

### 不可放松的约束

1. 模型只提议、运行时决定。外层计划按确定性的阶段顺序执行（生产为原生循环 `runAgentExecutionPlan`，见阶段 5 的最终决定；实验开关下为同序的底层 Pregel 图），只用确定性条件，不用 `createAgent` 的自由 ReAct 循环。
2. 不出现第二个 run store 和第二套回放安全矩阵。checkpointer 是自定义 `BaseCheckpointSaver`，写现有 agent run store（revision CAS、RLS 租户、事件契约不变），不用 `PostgresSaver` 的 `checkpoints` 表。
3. 有副作用的节点在审批前零写入，审批后只跑一次，带 run+node 幂等键；`interrupt()` 是节点里第一个有效操作。
4. 原始答案 token 不出服务器：SSE 只用 `streamMode: ["updates", "custom"]`，不开 `messages`。
5. Planner 看不到文档正文；跨层的事件、日志、span、token claim 不带问题、prompt、模型输出、文档正文和密钥。不开 LangSmith，追踪继续走 OTel。
6. 每个 prompt 仍有 `definePrompt` 的 `{id, version, fingerprint}`。
7. 模型调用继续走 `openai.js` / 模型网关的重试、熔断、并发上限、failover 和计量；LangChain 侧 `maxRetries: 0`，不用 `withFallbacks`。
8. 检索和切块不换实现，只做薄包装。
9. `bindDatabaseTenant` 的 AsyncLocalStorage 必须穿过节点和 Send 分支；`thread_id` 由 userId、workspaceId 和 runId 派生。
10. 截止时间与取消的终态仍走 `failRun` 的 revision CAS，错误码不变。
11. 预算仍由 `consumeBudget` / `reserveBudget` / `run-usage.js` 负责。
12. V1 顺序链和 `AGENT_SKILL_GRAPH_ROLLOUT=off` 保留到 LangGraph 成为默认后至少一个发布周期；`AGENT_RUNTIME=native` 是整体回退开关。
13. 依赖固定精确版本，`@langchain/core` 单一版本，`npm audit --omit=dev` 为 0。
14. 新代码放 `server/rag/langgraph/`，每个文件一个职责，`agent.js` 不再长大。

## 备选方案

| 方案 | 做法 | 好处 | 代价 | 结论 |
| --- | --- | --- | --- | --- |
| A. 保持自研 | 不迁移 | 零风险；现有恢复、审批、fencing 都有跨进程测试 | 调度器、checkpoint、中断续跑、流式传输都要自己维护；外层固定阶段和图执行是两套机制 | 不选：维护面不缩小 |
| B. 只换 checkpointer | 自研调度器不动，checkpoint 换成 LangGraph saver | 改动小 | LangGraph checkpoint 的格式绑定 Pregel 的 channel/version 语义，脱离 LangGraph 调度器单独使用没有意义；得到的是两套 checkpoint 而不是一套 | 不选 |
| C. 全量替换（strangler） | 调度、checkpoint、中断、流式全部交给 LangGraph；准入、预算、fencing、证据检查、finalizer 保留 | 一套执行模型覆盖外层阶段和图节点；`interrupt()`、`stream`、checkpoint 是标准原语 | 迁移量大；LangGraph 的语义和现有契约有差异（见 spike 结果），需要包装层弥合；状态序列化可能吃掉性能 | **采用**，分阶段、带开关 |

## 阶段 0 spike 结果

### 依赖与位置

| 包 | 版本 | 说明 |
| --- | --- | --- |
| `@langchain/core` | 1.2.17 | 单一副本，`test/langchain-dependency-pins.test.mjs` 读 lock 断言 |
| `@langchain/langgraph` | 1.5.0 | |
| `@langchain/langgraph-checkpoint` | 1.2.0 | 目标文件没列，但自定义 saver 需要 `writesSortKey` / `compareWritesSortKeys` / `WRITES_IDX_MAP`，`@langchain/langgraph` 不转出，所以改为直接依赖 |
| `@langchain/openai` | 1.6.2 | 阶段 1 才用 |
| `langchain` | 1.5.16 | 只用于窄子任务的 `createAgent`，阶段 1 之后才用 |

- `zod` 的声明范围从 `^4.1.13` 改为 `^4.2.0`，对齐 LangGraph 的 peer 下限；锁定版本仍是 4.3.5。
- `npm audit --omit=dev` 为 0。基线原本不是 0（`proxy-addr` critical、`@modelcontextprotocol/sdk` high），已在单独的 commit `ef826f57` 里修掉，只改 lock。
- spike 全部放在 `server/test/`：辅助模块在 `server/test/langgraph-spike/`，四个套件为 `langgraph-spike-{checkpointer,evidence-gated-case,runner-mechanics,runtime-semantics}.test.mjs`，共 61 个用例。生产代码没有任何改动，覆盖率闸门不计入 `server/test/`。阶段 4 删除了这些文件，它们证明过的性质都已由生产套件覆盖（见“阶段 4 结果”）。
- 每个套件第一个 import 是 `langsmith-off.mjs`（阶段 4 起位于 `server/test/langgraph-support/`），在 LangChain 读取环境变量之前清掉 LangSmith 的追踪开关。

### 四项证明

**1. 租户 AsyncLocalStorage 穿过节点和 Send 分支：成立。**
- 以下上下文在每个节点、每个 Skill、每次模型调用和每次 saver 的 store 调用里都可见：租户（`runWithDatabaseTenant`）、run usage 计量、请求截止时间与 signal、SSE sink。
- Send 扇出：3 个分支在 barrier 上互相重叠，各自看到自己的上下文。两个租户用同一个 runId 并发执行，没有串号。
- 审批续跑在第二个请求的上下文里执行，续跑后看到的全部是新请求的上下文。
- 两个注意点：
  - LangChain 的回调 handler 默认放在进程级 `p-queue`（并发 1）里异步执行，那里的应用 ALS 属于不确定的请求。不能在回调里读租户、截止时间或 sink。
  - `AsyncCaller` 配了有限的 `maxConcurrency` 时，排队的模型调用会在别的请求的上下文里启动。保持不设，并发由 `model-call-guard.js` 管。

**2. `interrupt()` 续跑后副作用只发生一次：成立，但依赖包装层的纪律。**
- LangGraph 续跑时从节点第一行重跑。实测 `interrupt()` 之前的代码跑了 2 次，之后的副作用 1 次。
- 包装层的规则：
  - `interrupt()` 是第一个有效操作，排在预算预留、step 开始、trace 和任何写入之前。
  - 续跑的 `Command({ resume })` 值不是授权依据。决定从 run store 重新读取，并且绑定审批门：节点 id 加上当前精确输入的摘要。一个批准只能用一次。
  - 副作用的幂等键是 `buildCapabilityArtifactIdempotencyKey({ parts: [runId, nodeId, skillId] })`。
- 换一个进程续跑（新的 run service、新的 saver、重新编译的图，同一个 store）：副作用 1 次、预算 1 次、step 开始 1 次，上游文档节点没有重跑。完成后再续跑一次，什么都不执行。伪造的批准（store 里没有记录）、带 `update` / `goto` 的 Command 都被拒绝。拒绝审批时节点记为 `approval_denied`，没有 step，没有预算。
- LangGraph 自身的坑：
  - 假值的 resume（`false`、`0`、`""`）会被丢掉，抛 `EmptyInputError`。
  - 一个节点内的多次 `interrupt()` 共用同一个 id。
  - 客户端的 resume 值会作为 `__resume__` 写入 checkpoint，所以 runner 总是用自己的标记值续跑，客户端文本不进 run 行。

**3. 截止时间与取消在节点边界停下：成立，但不能直接把请求 signal 交给 LangGraph。**
- 直接用 `RunnableConfig.signal`（在原始 LangGraph 上实测）：
  - `invoke` 立即 reject；
  - 正在跑的节点在后台继续执行，它的写入被丢弃；
  - 续跑时这个节点再跑一次，所以是"至少一次"。
- 采用的做法：
  - 请求 signal 触发时调用 `RunControl.requestDrain()`：在下一个 superstep 边界停下，已经跑完的节点写入 checkpoint，然后抛 `GraphDrained`。
  - 保留原生的安全点：节点入口一处，并发闸门放行后再一处。
  - 先等在途节点全部结束，再交给 `failRun`。
  - 用 v2 checkpoint 的复用和 step 开始栅栏兜底。
- 结果：drain 和 signal 两种模式都做到最多一次，错误码经 `resolveAgentRunTermination` 得到 `AGENT_DEADLINE_EXCEEDED` / `AGENT_CLIENT_CANCELLED`。drain 下 LangGraph 自己就不会重跑已完成的节点；signal 下要靠 runner 等待在途节点并从 v2 checkpoint 复用结果。
- 真实模型调用仍会经 `withRequestSignal` 被中止，所以在途的模型节点和原生一样以失败结束。mock 忽略了 signal，这一点没有测到。

**4. 自定义 checkpointer 写现有的内存 run store：成立。**
- `RunStoreCheckpointSaver` 把记录写在同一个 run 行的 `result.__langGraphCheckpoint` 下，走 revision CAS（冲突最多重试 32 次）。不新增 store，不新增表。
- 契约：同一套脚本分别跑 MemorySaver 和本 saver，每次读取都 `deepStrictEqual`，覆盖 1.2.0 新增的 pending write 排序规则。
- `thread_id` = `"agent-run:v1:" + sha256(userId, workspaceId, runId)`，不含用户 id。另一个租户的 saver 读写一律 404。
- 栅栏：
  - v2 graph checkpoint 的 `resumeClaim` 必须与绑定的 claim 一致；
  - 人工恢复标记、run 状态与图阶段不是 `running` 时拒绝写入；
  - ALS 里的租户与绑定的租户不一致时拒绝；
  - 记录超过 256 KiB 返回 413。
- `claim()` 复制了 `claimExecutionGraphResume` 的拒绝条件：有活动 step、有待定审批门、或者调用方检查之后记录又变了，都拒绝。
- 写入按调用顺序串行，并发的 Send 分支不会互相覆盖。

### 与原生运行时等价

trajectory 用例 `unified_graph_evidence_gated_skill_hand_off`，证据充分和不足两个变体，原生 `runUnifiedGraphStage` 与 LangGraph runner 的以下结果一致（只屏蔽 `durationMs`、时间戳和 checkpoint digest）：
- run 对象与 nodeRuns；
- 每个已完成节点的结果和 `graphOutput`；
- 预算、`ragService.chat` 的次数与问题；
- 持久化的 step；
- v2 graph checkpoint；
- trace 与跳过记录；
- run store 的事件序列（去掉 LangGraph 自己的事件后）；
- `collectUnifiedGraphResults` 和 `projectUnifiedGraphRun` 的输出。

LangGraph 状态只放回执（`status`、`reason`、`outputDigest`）。typed 输出仍在 v2 `__skillGraphCheckpoint` 里，LangGraph 记录中查不到任何文档、风险、问题或答案文本（含 base64 解码后的值）。三次运行的网络调用都是 0。

### 实测数字（每次 3 节点运行，内存 run store）

| | 证据充分 | 证据不足 |
| --- | --- | --- |
| `__langGraphCheckpoint` 大小 | 7,222 字节 | 7,104 字节 |
| 同一状态在 MemorySaver 中的大小 | 5,841 字节 | 5,723 字节 |
| run 事件数（原生） | 17（12） | 14（9） |

- saver 调用：`getTuple` 2、`put` 5、`putWrites` 4。
- 新增的 run store 调用：`get` 11、`update` 4、`updateWithEvent` 5，即每次运行多出 9 次 CAS 写和 5 个 `langgraph_checkpointed` 事件。

### LangGraph 与现有契约的差异

包装层要弥合的差异：

| 差异 | 处理 |
| --- | --- |
| 1.5.0 缺陷：`maxConcurrency` 小于一个 superstep 的宽度时会丢任务；有任务抛错时，未启动的任务被记为 `__no_writes__`，续跑也不再执行 | 并发上限只在进程内闸门里执行，传给 `invoke` 的 `maxConcurrency` 等于节点数；有节点没有回执就整体失败（两个缺陷都有测试钉住） |
| superstep 是屏障：下游要等整个 superstep；一个节点停在审批时，后续 superstep 里的独立节点也不跑 | 只影响时序，不影响回执和 checkpoint |
| `LastValue` 通道拒绝同一步内的并发写 | 扇出写到的每个键都要有 reducer |
| 导出的 `writer()` 在 1.5.0 是空操作 | 用 `config.writer` |
| zod 插件 `.langgraph` 对 zod 4 不生效 | 用 `@langchain/langgraph/zod` 的 registry 或 `StateSchema` |
| 默认的 `retryPolicy` 会重试 `RequestCancelledError` | 节点不设 `retryPolicy` |
| `durability` 默认 `async` | 一律用 `sync` |
| 节点名不能含 `:`、`\|`，不能以 `__` 开头，不能与状态键同名 | 不支持的 nodeId 在执行前整体拒绝（planner 生成的 id 可能撞上） |
| 节点抛出的错误会作为 `__error__` 写进 checkpoint | 持久化前把错误改写成不含正文的代码 |

钉住、尚未消除的两处差异：停在审批门的节点因上游失败被放弃时，它的下游在这里记为 `skipped/dependency_skipped`，原生保持 `pending`；取消之后只剩跳过节点时，这里停下，原生会把它们记完并完成图。

### 没有覆盖的部分

- 真实审批路径：`pauseExecutionGraphForApproval`、审批快照、`waiting_for_user` 状态、真实 Capability 的 preflight 与 `verifyCapabilityGraphApproval`。spike 用的是测试替身，暂停期间 run 仍是 `running`。
- PostgreSQL run store：JSONB、/chat 语句数、没有 cursor 时每次读整条事件列表（随 superstep 数平方增长）。
- finalization 收据回放；用 checkpointer 的 `list` 做启动恢复。
- LangGraph 记录的修剪：目前每个 superstep 都在增长。
- 阶段 1 的模型与检索适配器、LangChain 回调到 OTel 的桥。

## 阶段 1 结果：适配层

`server/rag/langgraph/` 下 6 个文件，阶段 1 时生产代码还没有 import 它们（`server.js` 只用到守卫；阶段 5 起 `model.js` 经 `planner-model.js` 承接规划器的模型调用，见"阶段 5 结果"）。每个适配器都有"直接调用 vs 经适配器"的 `deepStrictEqual` 套件；`prompt-registry`、`llmops-metrics`、`tracing` 三个套件没有改动，照常通过。

| 文件 | 包的是什么 | 要点 |
| --- | --- | --- |
| `langsmith-guard.js` | 启动断言与每次调用的检查 | 5 个追踪变量任一为 `"true"` 时 `server.js` 拒绝启动；`guardRunnableEntryPoints` 给适配器自己建的、以及由它们组合出来的 runnable 加检查 |
| `model.js` | `completeTextWithMetadata` | `maxRetries: 0`；不转发 LangChain 的 `signal` / `timeout`（drain 方案）；`withRetry` / `withFallbacks` 拒绝；`withStructuredOutput` 只接 JSON Schema，发严格 `json_schema`，用 `parseFirstJsonValue` 解析；只接受 system / human 字符串消息 |
| `embeddings.js` | `embedQueryCached` / `embedTexts` | 返回同一个向量对象，embedding 空间标签和缓存不变 |
| `retriever.js` | `retrieveGlobalContextForQueries` / `retrievePerDocumentContextForQueries` | 这两个分发函数改为导出（只加了 `export`），所以远程检索层也覆盖到了；`toRetrievalResults` 能还原原始结果 |
| `tools.js` | `executeAgentSkill` | 只有授权目录里的 Skill 才能成为 tool；模型能写的字段只有 `question`、`priorFindings`（白名单），其余由运行时决定，模型传来就拒绝；Skill 失败时返回 `status: "error"` 的 ToolMessage |
| `prompts.js` | `lib/prompt-template.js` 的模板 | 13 个生产模板渲染结果逐字一致；指纹始终按未渲染的原文计算；planner 和 claim judge 的 prompt 由函数构建，保留原 builder |

验证中发现并已处理：
- 组合调用会绕过逐次检查：`template.pipe(model).invoke(...)` 在适配器代码运行之前就挂上 LangSmith tracer，把渲染后的 prompt 发出去。现在由 `guardRunnableEntryPoints` 覆盖。
- 适配器转发 LangChain 的 `signal`，会让 LangGraph 里兄弟节点失败时中止在途的模型调用，调用方的超时还会计入熔断器。现在不再转发，截止时间由 `request-deadline.js` 经 ALS 传到 `openai.js`。

留给阶段 2 的事：
- 由其他 runnable 发起的组合（`RunnableSequence.from`、`other.pipe(adapter)`、`graph.invoke`）仍然先挂 tracer，测试钉住了这一点。阶段 2 的每个外层入口必须先调 `assertLangSmithTracingDisabled()`。
- tool 不预留预算、不开 lifecycle step、不记 Skill 观测，调用方要自己包上。`createAgent` 不能直接用这些 tool。
- LangGraph 的 `messages` 流模式会在调用结束时发出完整回复，必须保持关闭（约束 4）。
- 两处包装依赖 `@langchain/core` 1.2.17 的内部行为（`invoke` 内部调 `this.call`，`tool()` 的包装函数读 `config.signal`），升级 core 时要重跑对应测试。

## 阶段 2 结果：custom-Skill DAG 跑在 LangGraph 上

- **开关**：`AGENT_RUNTIME`（`rag/config.js` 的 `getAgentRuntime()`），阶段 2、3 默认 `native`，除 `langgraph` 外的任何值都回落到 `native`（阶段 4 起默认 `langgraph`，见下文）。custom-Skill 阶段据此选择 `runExecutionGraph` 或 `runExecutionGraphOnLangGraph`；`AGENT_SKILL_GRAPH_ROLLOUT` 语义不变；v3 统一图仍走原生调度器。
- **复用，不复制**：原生 runner 的单节点执行、跳过判定、节点状态和结果组装抽到 `agent-execution-graph-node.js`，准入和收尾以 `admitExecutionGraphRun` / `finishExecutionGraphRun` 导出。原生 runner 从 1,055 行减到 373 行，只剩调度。用差分工具对比 HEAD 的原 runner，几十万次比较零差异；三个确定性评测在重构前后逐字节一致。LangGraph 一侧只有 `compile-execution-graph.js`（480 行）、`run-execution-graph.js`（329 行）和 `concurrency-gate.js`（129 行）。
- **checkpointer**：`rag/langgraph/checkpointer.js` 只经 `agent-runs.js` 新增的 `getLangGraphCheckpointRecord` / `mutateLangGraphCheckpointRecord` 写入，与原生图写入共用 fencing，不写事件。`__langGraphCheckpoint` 从所有公开投影里剥离，通用更新不能碰它。
- **每次调用都是新的 LangGraph invocation**：replan 和启动恢复都会先把旧线程写成墓碑，再从 `completedNodeRuns` 复用已完成的节点。agent run 的图 checkpoint 仍是权威。
- **等价证据**：
  - `langgraph-execution-graph-runtime` 39 个场景，在两种 runtime 下 `deepStrictEqual`：结果、step、事件、trace、预算、v1 checkpoint。
  - 原生 runner 的测试套件改指 LangGraph 执行器后 51/51 通过（`langgraph-native-runner-suite`）。
  - 4 个 skill_graph trajectory 用例、`planner_dynamic_skill_graph` 和恢复评测的 replan / startup resume 信号完全一致（`langgraph-runtime-parity`）。
  - `eval:trajectory` 19/19、`eval:planner` 7/7、`eval:recovery-observability` 8/8 在两种 runtime 下屏蔽后逐字节一致。
  - PostgreSQL：`test:pgvector` 102/102，其中跨进程续跑在 langgraph 下不重放已完成的写节点。
- **钉住的差异**：都来自 superstep 屏障，只影响事件、trace 和 Skill 调用的先后，节点结果不变；`test/langgraph-execution-graph-runtime.test.mjs` 逐条钉住。
- **未解决：写放大**。内存实测，一个 3 节点的 guarded 阶段在 LangGraph 上：run 读 48 次对 38 次，普通 update 21 次对 13 次，最大的 `result` 9,302 字节对 3,273 字节。原因是线程记录留在 run 行里，之后每次 CAS 都要重写它。阶段 3 之前要先降下来，再用 `pg_stat_statements` 和 load test 验证。

## 阶段 3 结果：v3 统一图跑在 LangGraph 上（外层计划改为可选）

- **范围**（两个开关，默认都是 `native`，`native` 逐字节不变）：
  - `AGENT_RUNTIME=langgraph`：guarded v3 统一图用阶段 2 的同一执行器调度（`agent-unified-graph-stage.js` 把执行器绑定到节点 step 所写的 run），与阶段 2 的 custom-Skill DAG 一起。只有这两张需要持久状态与中断的图受它控制；外层计划与 `/chat/stream` 在它的两种取值下都走原生循环与原生路由。
  - `AGENT_OUTER_PLAN_RUNTIME=langgraph`（实验开关，见下文"压测硬门与外层计划的决定"）：V1 外层执行计划编成一张不带 checkpointer 的 StateGraph（`rag/langgraph/execution-plan-graph.js`，阶段体不变，由 step 持久化续跑）；`/chat/stream` 经 `graph.stream(streamMode ["updates","custom"])` 中继（`rag/langgraph/agent-stream.js`），SSE 字节与 native 一致。两个开关互相独立。
  - 取消在两条路径上都仍是 drain。
- **审批停靠与同线程续跑**：被 preflight 停靠的 v3 节点以 `interrupt()` 作为第一个有副作用的操作（此前没有 step、预算、trace、checkpoint 写入），载荷只有公开 id（`rag/langgraph/unified-graph-approval.js`）；门仍由原来的 `pauseExecutionGraphForApproval` 在一个 CAS 里持久化。续跑（`/agent-runs/:runId/actions/*` 与后台任务同一入口）先把线程回执与 checkpoint 建出的节点状态核对（`unified-graph-thread.js`、`unified-graph-resume.js`），再以 `Command({resume: {[interruptId]: 运行时标记}})` 续同一线程：已结算节点不再进入，被批准的节点从第一行重跑进 stage 的 preflight，拿到经 `verifyCapabilityGraphApproval` 核验的门后在 run+node 幂等键下只执行一次；拒绝的节点在调度前结算为 `skipped/approval_denied`。resume 值永远只是运行时标记，决定从 run store 读。
- **停靠时机与 native 对齐**：native 只在"再没有能跑的节点"时停靠。`interrupt()` 会让 LangGraph 在该 superstep 之后就停，所以只在"后面各层所有待跑节点都依赖被停靠节点"时才调用（`compile-execution-graph.js` 的 `hasExecutionGraphWorkBeforePause`，层是静态的）；否则停靠节点像普通节点一样返回回执，后面各层把 native 会跑的节点跑完，执行器丢弃线程并按 native 方式持久化停靠，续跑是从 checkpoint 播种的新 invocation。两种形状下停靠时与批准/拒绝后的 run 事件、步骤、预算、`unified_graph_executed.nodeRuns` 都与 native `deepStrictEqual`（`test/langgraph-unified-graph.test.mjs`）。
- **启动恢复**：claim 之前先读线程并与 v2 checkpoint 核对（`unified-graph-recovery.js`）；矛盾转 manual `langgraph_thread_mismatch`，saver 自己拒绝的记录（损坏、他人/他租户的）转 `langgraph_thread_unreadable`，其他读取故障像别的 claim 前读取一样抛出、下次启动再恢复；一致、落后或没有线程的 run 以新 invocation 恢复（旧线程在 claim 下写墓碑）；批准节点内崩溃仍是 `unknown_in_flight_node`，不重放。
- **线程记录**：只在 `run.result.__langGraphCheckpoint`，始终是根命名空间 `""`（开 `AGENT_OUTER_PLAN_RUNTIME=langgraph` 时，custom-Skill DAG 是在外层计划图的 `custom_skills` 节点里被调用的；执行器在空的 LangChain 异步上下文里 invoke，否则会以嵌套子图落到 `custom_skills:<task id>` 命名空间而 `readLangGraphThread` 读不到。外层计划走原生循环时不存在外层图，DAG 本来就在根命名空间）。v3 图结算保存与 `failRun` 在同一 CAS 里丢弃它；审批停靠保留；下一次 invocation 先写墓碑。
- **写放大（部分完成）**：已接入——无变化的线程写在 run cursor 上不读库（`acceptCursorNoOp`）、无事件写不回读事件表（`reuseBaseEvents`）、v3 结算与终态丢记录。未接入——saver 的 K=2 保留（`retainCheckpoints`，执行器未传，阶段 2 的测试钉着每次 invocation 3 个 checkpoint）与 custom-Skill DAG 完成后的记录丢弃。真库 `pg_stat_statements` 实测（PostgreSQL 18，2 节点 guarded custom-Skill `/chat`，owner 路径）：native 1 insert、9 带事件 CAS、3 追加事件、1 run 读、1 事件表读；langgraph 多 7 次无事件 CAS、1 次 run 读、1 次事件表读，完成后 `result` 11,860 → 17,006 字节（v2 记录 5,116 字节留在行里）。
- **证据**：`langgraph-unified-graph` 19、`langgraph-routes` 8、`langgraph-execution-plan-graph` 24（每个场景四组 pass：两者皆 native、两者皆 `langgraph`、只开 `AGENT_RUNTIME`、只开 `AGENT_OUTER_PLAN_RUNTIME`）、`langgraph-chat-stream` 7、`langgraph-checkpointer-write-amplification` 9、`langgraph-execution-graph-runtime` 39、`langgraph-native-runner-suite` 52、`langgraph-runtime-parity` 6、`agent-run-chat-statement-count` 10；`eval:trajectory` 19/19 两种 runtime；PostgreSQL：`langgraph-checkpointer-postgres.integration` 4/4、`agent-unified-graph-postgres.integration` 12/12（五个跨进程用例也在 langgraph 下跑）。
- **压测硬门与外层计划的决定（2026-10-16）**：
  - 压测脚本新增 `--agent-runtime native|langgraph`。app 子进程会丢掉继承来的 `AGENT_*` 变量，所以必须用参数显式指定，报告配置里会记录 `Agent runtime`。决定之后又加了 `--outer-plan-runtime native|langgraph`（即 `AGENT_OUTER_PLAN_RUNTIME`），报告配置记录 `Outer plan runtime`；此后 `--agent-runtime langgraph` 不再把外层计划放到 LangGraph 上，要复现下面第一轮的 langgraph 配置需两个参数都给 `langgraph`。决定之前写的报告没有 `outerPlanRuntime` 字段，报告里注明外层计划当时跟随 `AGENT_RUNTIME`。
  - 第一轮配对：`latest-load-test-p3-{native,langgraph}-r3`，pgvector，owner 路径，模型 0 ms，每档 3 次。当时 langgraph 下每个 `/chat` 都把外层 V1 计划作为 StateGraph 跑。
    - 每请求 CPU：并发 1 时 5.02–5.19 → 6.35–7.31 ms，并发 32 时 3.93–4.26 → 5.27–5.47 ms（+29–35%）。
    - p95：并发 32 时 125–138 → 165–169 ms。
    - 吞吐：并发 32 时 273–281 → 208–214 req/s。
    - 模型 800 ms 档的 p95 两边相差不到 1%。
  - 按 10% 的硬门判为不通过。
  - 原因：进程内同一个 `runAgentRag`，native 0.65 ms、langgraph 1.88 ms CPU。剖析结果如下。
    - LangChain、LangGraph、LangSmith 自身代码占 45%。
    - 其中最大的一块是 core 在每个节点调用时新建 `RunTree`，没有配置项能关掉。
    - 空图底价：3 节点 0.38 ms，5 节点 0.59 ms；改用不建 `RunTree` 的节点包装后仍有 0.38–0.52 ms。
    - 而 native 每个 `/chat` 只有约 4 ms CPU，10% 的预算是 0.4 ms，所以这是结构性的，不是可以调掉的。
  - **决定**（用户认可）：外层 V1 计划在两种 runtime 下都走 native 循环。LangGraph 只跑需要持久状态和中断的图，也就是 custom-Skill DAG 和 v3 统一图。外层计划图（`rag/langgraph/execution-plan-graph.js`）与它的 `/chat/stream` 中继保留，改到单独的实验开关 `AGENT_OUTER_PLAN_RUNTIME` 后面，默认 `native`。
  - 这偏离了目标文件"删除 `agent-execution-plan-runner.js` 调度部分"这一条：外层计划的调度只是按计划顺序执行阶段的一个循环，交给 LangGraph 没有带来持久化或中断能力，只带来开销。阶段 4 保留这个循环。
  - **决定后的复测（通过）**：同一份 harness（sha256 `1577ba554459a74a`）配对 `latest-load-test-p3b-{native,langgraph}-r3`，`--agent-runtime langgraph`、外层计划 native，pgvector、owner 路径、模型 0 ms、每档 3 次，与 native 相比如下。
    - 每请求 CPU：并发 1 时 4.94–5.14 → 4.59–4.91 ms，并发 32 时 3.78–4.20 → 3.82–4.34 ms，区间重叠。
    - p95：并发 32 时 121.8–123.5 → 120.6–126.4 ms。
    - 吞吐：并发 32 时 280–287 → 274–289 req/s。
    - 模型 800 ms 档的 p95 相差在 2% 以内。
    - 整轮里 800 ms、并发 4 这一档的 native 每请求 CPU 偏低（4.9–5.4 ms，langgraph 9.3–10.3 ms）。单独复测这一档（`...-800c4`，各 3 次），两边都是 836.5–840.4 ms 的 p95、约 9.6 ms CPU，没有差别。偏低来自档位顺序，不是 runtime 的差异。
    - 进程内同一个 `runAgentRag`：两边都是 0.65 ms CPU。文档问答请求在 `AGENT_RUNTIME=langgraph` 下不加载 LangGraph。
  - **其余验收**：
    - `verify:quality` 18/18（qwen2.5:7b + nomic-embed-text，`AGENT_RUNTIME=langgraph`；它走文档 RAG 路径，与 runtime 无关，确认迁移没有碰坏真实模型下的检索与回答）。
    - 覆盖率闸门：3296 个测试，3281 通过、15 跳过、0 失败，全局行覆盖 90.46%。
    - `test:pgvector` 109/109。
- **有意的差异**：开 `AGENT_OUTER_PLAN_RUNTIME=langgraph` 时，LangSmith 追踪变量为 `"true"` 会让 `/chat/stream` 在 run 创建前拒绝，`/chat` 在规划之后、图构建之前拒绝并把 run 置为 failed（native 没有 tracer 可拒绝）。只开 `AGENT_RUNTIME=langgraph` 时，不建 LangGraph 图的请求（如文档问答）与 native 一样作答；custom-Skill 阶段与 v3 入口仍在各自路径上拒绝。

## 阶段 4 结果：默认切到 langgraph

- **默认值**：`AGENT_RUNTIME` 未设、为空或只有空白时取 `langgraph`；`native`、`langgraph`（不分大小写）照用；其他任何值回落到 `native`，因为拼错的回退指令应当落到经过长期验证的运行时。`AGENT_OUTER_PLAN_RUNTIME` 仍默认 `native`。
- **回退窗口**：原生调度器不删，作为一个发布周期的整体回退（约束 12），见“回退”。它同时仍在两处使用：LangGraph 无法按原生声明顺序调度的图（`canScheduleExecutionGraphOnLangGraph`）交给它跑；外层 V1 计划在两种 runtime 下都是原生循环（阶段 3 的决定）。删除原生调度器的前提是先解决前一种交回情形，计划在新默认发布一个周期后单独进行。（交回情形已在阶段 5 解决，见“层序调度”。）
- **写放大已接上**：执行器把 `retainCheckpoints: 2` 交给 saver；custom-Skill DAG 结算保存与 v3 一样在同一个 CAS 里丢弃线程记录。真库 `pg_stat_statements` 重测（PostgreSQL 18，2 节点 guarded custom-Skill `/chat`）：
  - 语句数与阶段 3 相同：native 是 1 insert、9 带事件 CAS、3 追加事件、1 run 读、1 事件表读；langgraph 在此之外多 7 次无事件 CAS、1 次 run 读、1 次事件表读。
  - 完成后的 `result` 从 17,006 字节降到 11,894 字节（native 11,860 字节，多出的是 29 字节的墓碑）。
  - 运行中单次写入的线程记录最大 2,975 字节，`result` 最大 14,639 字节。
- **spike 删除**：`server/test/langgraph-spike/` 和四个 spike 套件已删除。只有 spike 证明过的性质移进了生产套件：
  - LangGraph 1.5.0 的两个 `maxConcurrency` 缺陷、只有 Capability 的 preflight 能停靠或拒绝节点：`langgraph-execution-graph-runtime`。
  - 直接交给 LangGraph 的 `AbortSignal` 会重跑在途节点：`langgraph-checkpointer`。
  - 两租户重叠执行时上下文与线程写入各归各的；被放弃的停靠节点；排队的门控 Capability 在取消后不被预检；暂停后 policy 变化时拒绝执行（`graph_approval_not_required`）：`langgraph-unified-graph`。
  - 有待定审批门时拒绝启动 claim：`agent-execution-graph-checkpoint`。
- **回退路径不失去覆盖**：新套件 `agent-graph-suites-native-rollback` 在 `AGENT_RUNTIME=native` 下原样重跑 9 个图相关套件。预加载钩子会让任何进入 LangGraph 执行器的调用直接失败，同时统计原生调度的图数。两个 PostgreSQL 集成套件的跨进程用例在两种 runtime 下各跑一遍。
- **测试环境**：`npm test` 和覆盖率闸门给每个测试子进程去掉 LangSmith 追踪变量（变量列表取自生产守卫），由 `ci-workflow.test.mjs` 钉住。
- **压测脚本**：`--agent-runtime` 默认改为 `langgraph`，与应用一致。
- **代码量**：现在原生 runner 386 行、共享节点模块 1,138 行、`server/rag/langgraph/` 下 19 个文件共 6,463 行（含阶段 1 的适配器）。维护面还没有缩小：要等回退窗口结束、删除原生调度器之后才会体现，届时再按行数和测试数衡量。如果解决交回情形的成本过高，应重新评估是否保留原生调度器作为长期的第二调度器。

## 阶段 5 结果：收尾（2026-10-16）

阶段 4 之后按"完成的定义"逐条检查，先做只读调查（性能、交回情形、v3 默认、适配器、发布证据五个方向），再实现能做的部分。

### 外层计划：降到底层 Pregel，压测仍不过，默认保持原生

- **开销从哪来**（微基准，桩阶段，生产包装层）：文档问答的确定性计划有 7 个阶段，StateGraph 版本跑 8 个 superstep。每个阶段被包成节点 `RunnableCallable`、`ChannelWrite` 及其 mapper、控制分支、条件边路径，每个都经 `runWithConfig` 新建一个 LangSmith `RunTree`：每次调用 54 个 `RunTree`、78 次回调配置、约 800 次环境变量读取，约 1.09 ms CPU。建图加编译只有约 37 µs，所以缓存编译结果只省约 3%。`invoke`/`stream`、`durability`、`streamMode`、`recursionLimit` 都在噪声内；`callbacks: []` 反而 +22%。StateGraph 层面能做到的最好结果（缓存 + `Command` 路由 + 直接调用的节点）是 7 阶段约 0.65 ms。
- **改动**（`rag/langgraph/execution-plan-graph.js`，只在 `AGENT_OUTER_PLAN_RUNTIME=langgraph` 时运行）：
  - 改用公开的底层 API `@langchain/langgraph/pregel` 与 `/channels`：每个阶段一个节点，触发 channel → 直接调用阶段的小 `Runnable` → 一个 `ChannelWrite`。写回执并在阶段没有给出响应时触发下一阶段；mapper 返回 `undefined` 即不写，计划就此结束。没有 START superstep 和控制分支。
  - 按计划形状只编译一次（LRU 64 项，键是被调度的阶段 id 序列）。每个请求的状态都放在 `config.configurable` 的一个私有键下，节点闭包里没有请求数据。`langgraph-execution-plan-graph-isolation` 用 1,024 个请求（64 个并发，随机延迟、提前结束、失败、取消）共用一张编译好的图，结果、错误对象和事件流各归各的。
  - 剪枝：`isAgentExecutionPlanStageStaticallyInert`（`agent-execution-plan-runner.js` 导出）为真时不调度该阶段。只对 arxiv_import、workspace_action、research_brief、inventory、document_discovery 五个内置阶段成立，条件是 `selected_skill` 且阶段体用的同一个 `getSelectedSkill` 查不到 Skill；custom_skills、document_rag、web_search 从不剪。`agent-execution-plan-pruning` 用记录型 Proxy 证明这五个阶段在未选中时不碰任何协作者、不发事件、不改状态，并验证剪枝前取消在两种调度器下结果相同。原生循环不变，仍进入每个阶段。
  - 回执检查更严：进入的阶段必须按计划顺序，且要么走到最后一个阶段，要么停在给出响应的那个阶段，否则 `AGENT_LANGGRAPH_PLAN_RECEIPT_MISMATCH`。
  - 审查发现并修复：LangGraph 1.5.0 在节点失败或 drain 后一个微任务就让输出流出错，`ReadableStream` 出错时丢弃消费者还没读的 custom chunk，阶段在抛错前发出的 trace 事件因此会从 SSE 里丢失（StateGraph 版本因调用链更长碰巧没丢）。现在节点要等消费者确认已转发它经 `config.writer` 发出的每个事件后才结算（`createEventRelay`），`langgraph-chat-stream` 与 `langgraph-execution-plan-graph` 各加了先发事件再失败的用例。
- **微基准**（同一方法）：7 阶段 1,086 → 347 µs CPU（并发 32 时 955 → 320）；剪枝后的文档问答形状（document_rag + web_search 两个节点）416 → 143 µs（并发 32 时 392 → 132）；每次调用的 `RunTree` 54 → 2。进程内同一个 `runAgentRag`（桩 RAG）：native 0.69 ms，外层计划在 LangGraph 上 0.97 ms，多 0.28 ms（阶段 3 时多 1.23 ms）；阶段里加 400 个异步等待后差值不变（0.88–0.91 对 1.19 ms）。
- **压测**（pgvector、owner 路径、模型 0 ms、确定性规划器，两边都给两个参数：`--agent-runtime X --outer-plan-runtime X`）：
  - 第一对 `latest-load-test-p5-{native,langgraph}-r3`（native 先跑，每档 3 次）：每请求 CPU 并发 1 时 4.87–5.14 → 6.65–7.24 ms，并发 32 时 4.91–5.51 → 4.38–4.91 ms；并发 32 的 p95 153.7–175 → 137.5–142 ms。
  - 反向一对 `latest-load-test-p5b-{langgraph,native}-r3`（langgraph 先跑）：并发 1 时 5.83–6.31 → 6.63–7.43 ms，并发 32 时 4.76–5.03 → 5.44–5.81 ms；并发 32 的 p95 148–149.6 → 168.8–174.8 ms。
  - 两对在并发 32 上方向相反，同一配置在不同轮次之间就有约 15–20% 的漂移，所以并发 32 的结论不确定。并发 1 两对都是 langgraph 更贵，于是交替跑了四轮（`latest-load-test-p5c-{1..4}-*`，native、langgraph、native、langgraph，各 5 次、每次 256 个请求）。并发 1 的中位数：每请求 CPU 5.68 → 6.68 ms（+17.6%），p95 9.3 → 10.5 ms（+13%），平均延迟 7.8 → 8.6 ms。
  - 按 10% 的硬门判为**不通过**（并发 1）。剩下的开销是 Pregel 每次调用固定要做的事：执行循环、任务 id（uuid5/SHA-1）、checkpoint 对象（uuid6）、配置合并，每个 superstep 约 40 µs、每次调用约 100 µs 起步，属于库内部，不改库削不掉。进程内只多 0.28 ms、压测并发 1 却多约 1 ms，与"请求间有空闲时 CPU 降频、缓存变冷，同样的指令更贵"相符，这一条是推断，没有单独测量。
- **决定**：外层 V1 计划默认继续走原生循环，与阶段 3 的决定一致；新实现替换了 `AGENT_OUTER_PLAN_RUNTIME=langgraph` 后面的 StateGraph 版本，开销约为原来的四分之一，仍不建议开启。`agent-execution-plan-runner.js` 的原生循环因此不能删。
- **最终决定（2026-10-16，用户认可）**：不放宽 10% 的硬门，外层 V1 计划长期保持原生循环。
  - 理由：外层计划不需要持久状态或中断，续跑靠 run 的 step；交给 LangGraph 只增加开销，没有带来能力。
  - "完成的定义"据此修订：`runAgentExecutionPlan`（`agent-execution-plan-runner.js` 的原生循环）是外层计划的生产调度器，不属于"被替代的调度代码"。要删的只剩回退窗口之后的原生图调度器 `runExecutionGraph`。
  - `AGENT_OUTER_PLAN_RUNTIME=langgraph` 与底层 Pregel 实现保留为实验开关，不再计划转正，`test/langgraph-execution-plan-graph*.test.mjs` 继续守住它与原生的等价。
  - 重新评估的条件：升级 `@langchain/langgraph` 或 `@langchain/core` 后，Pregel 每次调用的固定开销（执行循环、任务 id、checkpoint 对象）有实质下降。届时按本节的方法重测：进程内对比，交替四轮、每轮 5 次的并发 1 压测，以及并发 32。每一档都在 10% 以内，才考虑切换默认值。

### 规划器的模型调用经 LangChain ChatModel

- `rag/langgraph/planner-model.js` 的 `completePlannerText`：`AGENT_RUNTIME=langgraph` 时，意图、执行、DAG、v3 统一图、replan 五个规划器的模型调用经 `ArchiveRagChatModel.invoke(prompt, { promptTemplate, responseFormat, temperature })`；`native` 时仍直接调 `completeTextWithMetadata`。适配器按需动态加载（原生进程不加载 `@langchain/*`），每个（capability, routeId）缓存一个实例，调用在空的 LangChain 异步上下文里进行，不建根 `RunTree`。只接受 capability、promptTemplate、responseFormat、routeId、temperature 五个选项，多传就拒绝。
- 各规划器保留自己的 JSON 解析和校验器，不用 `withStructuredOutput`：实测 `parseFirstJsonValue` 在"文字里带 `[...]`/`{...}`、后面跟 fenced JSON"的回复上解析失败，而规划器自己的解析器能解析；它也不接受意图规划器在没有候选时构造的 null schema；replan 根本不发 schema。
- LangSmith 追踪变量为 `"true"` 时，`completePlannerText` 在任何 runtime 下都走直接调用，不进入 LangChain（审查发现：最初实现在这种情况下拒绝调用，让 LLM 规划器在默认 runtime 下退回确定性计划，破坏了"不建图的请求与 native 一致"）。
- 等价证据：`langgraph-planner-model`（五个规划器在两种 runtime 下 `deepStrictEqual` 结果、每次 provider 输入、每条 LLMOps 事件、各类失败的错误对象；langgraph 下确实经过适配器，native 下没有加载）；现有规划器套件在两种 runtime 下各跑一遍；`eval:planner -- --provider mock` 两种 runtime 屏蔽后一致。每次调用多约 13–19 µs CPU（微基准）；压测用确定性规划器，测不到这部分。

### 层序调度：交回情形已解决（2026-10-16）

- **改动**：两种调度器都按校验器的拓扑层序排队，即 `compiled.order`（Kahn 分层，层内按声明顺序），由 `agent-execution-graph-node.js` 的 `orderExecutionGraphNodeStatesByLayer` 统一给出。
  - 原生 `runExecutionGraph` 的扫描从声明顺序改为这个队列。
  - LangGraph 的节点名改用队列位置编号，所以 superstep 内的进入顺序就是队列顺序；跨 superstep 本来就是逐层进入。
  - `canScheduleExecutionGraphOnLangGraph`、`isExecutionGraphDeclaredInLayerOrder` 和执行器里的交回分支已删除，`runExecutionGraphOnLangGraph` 不再引用 `runExecutionGraph`。
  - 结果、node run 和 v1/v2 checkpoint 仍按声明顺序记录，只有排队顺序变了。
- **为什么这就够了**：队列按层序后，原生扫描先碰到后层 node 只有一种情况：前一层某个 node 还没就绪（它的依赖仍在途，而另一个 node 已经结算）。这正是已认可的 superstep 屏障差异 1，取决于谁先完成。旧的确定性差异是：上限或独占 node 压住就绪 node 时，声明顺序会先发射后层 node，与时序无关。这一差异已不存在。
- **原生行为的变化**：只影响不按层声明的图；按层声明的图队列就是声明顺序，行为不变。
  - 上限或独占 node 压住就绪 node 时，先跑前一层的 node。例如 `[summary 依赖 risk, risk, timeline]`、上限 1：以前是 risk → summary → timeline，现在是 risk → timeline → summary。预算只够两次时，以前资助 summary，现在资助 timeline；summary 为 fail_fast 且失败时，以前会中止 timeline，现在 timeline 已经先跑完。
  - 生产中出现的唯一形状是带 Web 的 v3 确定性文档图（`AGENT_UNIFIED_GRAPH_ROLLOUT=guarded`）。它声明为 document、evidence_check、follow_up、follow_up_check、web：web 在第三层，follow_up_check 在第四层，document_rag 与 web 节点独占。follow-up 与 Web 都触发时，以前 follow_up_check 先于 web，现在 web 先于 follow_up_check。用 mock 实测（primary 不受支持、follow-up 未解决），与旧队列相比只有 `agentTrace`、`agentRunSteps`、`agentObservability.runs` 的顺序变了，答案、来源和各 node 状态不变。
  - 生产默认的 custom-Skill DAG（预算 2、四个 custom Skill 都可并行、上限 3）和 `eval:trajectory` 的 17 次执行器调用都不受影响。
- **证据**：
  - `langgraph-execution-graph-runtime` 44/44。新用例覆盖一张 5 节点三层图的全部 120 种声明顺序，乘以两种压住方式（上限 1；全部独占、上限 3）和三种压力（无、预算 3、中间层 fail_fast），共 720 个场景。两种 runtime 用同一个精确的 `assertParity` 比较，没有放宽；LangGraph 线程持有每个 node 的回执。把原生循环临时改回声明顺序时，这个用例和四个旧交回场景都失败。
  - 原来钉住交回的两个用例改为钉住新行为：四个旧交回场景仍用同一个精确 parity，原生 journal 变成层序；另一个用例改为验证旧线程被丢弃后，LangGraph 在新线程上把不按层声明的图跑完。钉住谓词的用例改为钉住共享队列。
  - `agent-execution-graph-runner` 新增一个层序用例，52/52。`langgraph-native-runner-suite` 53/53：原生 runner 套件在 LangGraph 执行器上跑，至少 45 次调度到 LangGraph。
  - `langgraph-unified-graph` 新增上面那张 v3 文档 + Web 图的两 runtime parity，24/24：`/chat` 响应、run 和 v2 checkpoint 屏蔽后一致，Web 运行时线程里已有前两层的回执。
  - `agent-execution-graph-node`、`langgraph-runtime-parity`、`agent-unified-graph-*`（PostgreSQL 集成用例无库时跳过）、`agent-graph-suites-native-rollback` 全部通过。
  - `eval:trajectory` 19/19、`eval:planner -- --provider mock` 7/7、`eval:recovery-observability` 8/8：`AGENT_RUNTIME=native` 与未设置两次运行，屏蔽 UUID、时间戳和时长后逐字节一致，只差报告自己的 runId。
  - `coverage:gate` 通过：3,294 个测试，0 失败，15 个跳过（都是需要 PostgreSQL、只读副本或 Redis 的用例）；五组覆盖率最低线全部通过。
- **删除原生调度器还剩什么**：当时是两件：回退窗口（约束 12），以及 v3 stage 里另外两处直接调用 `runExecutionGraph` 的地方（finalization 回放，不跑 node；step lifecycle 没有 run 目标时走原生）。后一件已在下一节解决。

### v3 stage 不再直接调用原生调度器（2026-10-16）

- **改动**：`agent-unified-graph-stage.js` 在 `AGENT_RUNTIME=langgraph` 下原来还有两处直接调用 `runExecutionGraph`，都已换掉；`runExecutionGraph` 本身保留（约束 12）。
  - **finalization 回放**（启动恢复为一张已完成的图重建 node 收据，交给 `finalizeAgentRun`）：两种 runtime 都改用 `agent-execution-graph-runner.js` 新导出的 `replayExecutionGraphRun`，它不调度。
    - 它用 checkpoint 里已完成的收据和被拒绝的节点建 node 状态，再按校验器层序对每个 pending 节点做与调度器相同的判断（`decideExecutionGraphNode`）。
    - 判为跳过的（`condition_not_met`、`dependency_skipped`）照常经 `recordSkippedSkill` 记录，最后用 `finishExecutionGraphRun` 收尾。
    - 判为要执行或等待的节点，直接抛回放守卫错误（`AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY`），不碰 step、预算、preflight 和 checkpoint 钩子。
  - **step lifecycle 没有 run 目标**（`getAgentRunStepLifecycleTarget` 返回 null）：改为不带 checkpointer 调用 `runExecutionGraphOnLangGraph`，执行器本来就支持这种调用。
    - thread id 是临时派生的，没有人读回。
    - 审批节点不调用 `interrupt()`，而是交回自己的收据，暂停由 stage 的 `pauseForApproval` 持久化，和原生一样。
    - 审批之后的继续是一次新调用，也和原生暂停之后一样。
    - 生产调用方传入的 lifecycle 都带 run 目标，所以这个分支只会出现在注入的 lifecycle 上。
  - 结果：`AGENT_RUNTIME=langgraph` 下，没有任何生产路径再调用 `runExecutionGraph`，custom-Skill stage 本来就不调用。只剩两个 stage 的 `native` 分支（回退开关）在用它。
  - LangSmith 守卫和 LangGraph 执行器的按需加载，现在在 langgraph 下总会执行；以前没有 run 目标时会跳过。
- **为什么结果不变**：
  - **回放**：对一张已完成的图，原生循环也不发射任何节点。按层序，依赖总是先于依赖它的节点判定，所以一遍扫描就能把每个节点定为 reused 或 skipped，第二遍时已没有 pending 节点。`replayExecutionGraphRun` 做的就是这一遍，判断、跳过记录和收尾都是同一套代码。
  - 唯一的不同出现在本来就会失败的路径上：checkpoint 标为 completed，却缺某个必跑节点的收据。两者都以回放守卫失败。区别是原生会先发射这个节点（输入无效时还会写一条失败的 step），新实现在任何钩子之前就拒绝。
  - **没有 run 目标**：用的是有 run 目标时同一个 LangGraph 执行器，已认可的四类 superstep 差异同样适用。不带 checkpointer 只意味着不写 thread、不在 interrupt 处停下。
- **证据**：
  - **`langgraph-unified-graph`** 新增两个用例，共 26/26：
    - **等价扫描**：一张 5 节点 v3 图，120 种声明顺序 × `when` 成立与否 × 有无被拒绝节点，共 480 种已结算形状。`replayExecutionGraphRun` 与按旧 stage 回放方式传参的 `runExecutionGraph` 相比，结果 `deepStrictEqual`，钩子调用记录逐条相同（只有 `recordSkippedSkill`），预算用量相同。
    - **拒绝路径**：另有 480 种缺一个必跑节点收据的形状。两者都拒绝，回放在任何钩子之前就拒绝。
    - **端到端回放**：图完成后、finalization 收据写入前崩溃，再由启动恢复回放。覆盖四个场景：需要重新推导跳过的文档循环、follow-up 已解决的文档循环、已批准的审批门、已拒绝的审批门。两种 runtime 屏蔽后一致；没有任何节点重跑（RAG 调用、Capability 写入、`graph_node` step 都不变），也没有 thread。
    - **与旧实现对照**：临时换回旧 stage 跑同样四个场景，屏蔽后的结果与新实现逐字节相同。
  - **新套件 `langgraph-unified-graph-without-run-target`**，4/4：
    - 在独立进程里，把 stage 对 run 目标的查询重定向为 null（`test/langgraph-support/stage-run-target-switch.mjs`）。
    - 把 stage 对 runner 的导入换成绊线（`stage-native-scheduler-tripwire.mjs`）：按 runtime 计数，langgraph 下一旦调用 `runExecutionGraph` 就抛错。
    - 覆盖四个场景：没有 run 目标时的证据门文档循环、审批暂停加批准、拒绝，以及有和没有 run 目标两种情况下的 finalization 回放。两种 runtime 屏蔽后一致。
    - LangGraph 下，Skill 调用和 Capability 写入都发生在一个临时 thread 里（不是 run 的 thread），run 上没有 thread 记录，langgraph 下的原生调度器调用数为 0。
    - 临时换回旧 stage 时，四个用例全部失败。
  - **`agent-graph-suites-native-rollback`**：守卫把 `replayExecutionGraphRun` 单独计数。guarded 套件原来记为 36 次原生调度，现在是 33 次调度加 3 次回放，下限按此改写，9/9。
  - `agent-unified-graph-*`、`agent-execution-graph-runner` 52/52、`langgraph-native-runner-suite` 53/53、`langgraph-execution-graph-runtime` 44/44 通过。
  - `eval:trajectory` 19/19、`eval:planner -- --provider mock` 7/7、`eval:recovery-observability` 8/8：`AGENT_RUNTIME=native` 与未设置各跑一次，屏蔽 UUID、时间戳和时长后逐字节一致，只差报告自己的 runId。
  - `coverage:gate` 通过：3,300 个测试，0 失败，15 个跳过（都是需要 PostgreSQL、只读副本或 Redis 的用例）；五组覆盖率最低线全部通过。
- **删除原生调度器还剩什么**：代码上已没有阻碍，只剩回退窗口（约束 12）。窗口过后要删的是：
  - `runExecutionGraph` 的调度循环；
  - 两个 stage 的 `native` 分支；
  - `agent-graph-suites-native-rollback.test.mjs` 及其守卫；
  - 各 parity 套件里的 native 一侧。

  准入（`admitExecutionGraphRun`）、收尾（`finishExecutionGraphRun`）、`replayExecutionGraphRun` 和 node 模块保留。

### 没有做的部分与理由

- **其余适配器不接入生产**：
  - `retriever.js` 一次只接一个查询、不共享查询向量，也带不回 `/chat` 和质量门要读的 `retrieval` 摘要；接到生产调用点会改变 `/chat` 契约。
  - `tools.js` 的形状不适合图调度器：没有预算预留、lifecycle step、Skill 观测、preflight 授权和逐节点 scope，每个请求建一次 tool 还要约 283 µs。
  - `embeddings.js` 与 `prompts.js` 很便宜，但它们所在的位置（检索层之下、答案生成器里）没有任何 LangChain 组件会消费它们。
- **工作记忆进图状态、replan 改成条件边：不做。** 工作记忆的主要写入发生在外层计划里，外层计划仍是原生循环；v3 图本来就从持久化的 typed 输出重建工作记忆。replan 上限是 1 次，而且从 v1 图 checkpoint 恢复；改成回环至少给每个 guarded custom-Skill 阶段多一次 LangGraph 调用（1 节点图实测 260–310 µs CPU），没有收益。
- **v3 统一图不设为默认主图**（`AGENT_UNIFIED_GRAPH_ROLLOUT` 仍默认 `off`）：
  - 生产其实有默认的统一图规划适配器（`app-services.js` 的 `createUnifiedGraphPlannerAdapter`，跟随规划器开关），所以改成 `guarded` 会立刻改变行为，不是"没有规划器就什么都不变"。
  - 它覆盖不了全部请求：research brief、没有文档的 discovery 和 Web、没有常设授权的 document_web、未配 `AGENT_UNIFIED_GRAPH_CAPABILITIES` 的 workspace action、已有 run 的重入、规划前就返回的澄清，仍要 V1 外层计划回答。
  - 被接管的请求行为会变（mock 实测）：文档问答拒答时不再提议 Web 审批；custom Skill 请求多一次 `document_rag` 和一次会话记忆写入，证据不通过时 Skill 被跳过；非主节点失败从 200 或可重试的 503 变成 409 `AGENT_UNIFIED_GRAPH_PARTIAL`；`/chat/stream` 不再有 `answer_draft`；trace 改为 `graph_node`。trajectory 与 planner 评测的投影会变，需要按流程给 manifest 升版本。
  - 性能（进程内微基准，内存 run store、mock RAG）：一次文档问答 V1 约 0.8–1.2 ms CPU，v3 native 约 5.8–7.4 ms，v3 在 LangGraph 上约 11–15 ms；带事件的 CAS 写 3 → 10 次，LangGraph 下另加 11 次无事件写。必然违反 10% 的硬门。
  - 真实模型证据不足：v3 规划器在 qwen2.5:7b 上的采纳率是 3/15（2026-09-27，提交 85efbb6a）。
- **原生调度器不删除**：
  - 约束 12 要求 `AGENT_RUNTIME=native` 在新默认发布后至少保留一个周期；阶段 4 刚切默认。
  - 目标点名的四个文件里，只有 `agent-execution-graph-runner.js` 有可删的调度循环（`runExecutionGraph`）。`agent-execution-graph-checkpoint.js` 和 `agent-unified-graph-run.js` 没有调度代码：前者是 run 的权威图 checkpoint，后者是 v3 的入口与准入流程。`agent-execution-plan-runner.js` 的原生循环是外层计划的生产调度器（见上）。
  - 交回情形：`eval:trajectory` 里实测为 0 次（17 次执行器调用）；生产默认的 custom-Skill DAG 不会出现（预算 2、四个 custom Skill 都可并行、上限 3）；v3 带 Web 的确定性文档图以前每次都会出现（非按层声明，document_rag 与 web 节点独占）。解法是两种 runtime 都按校验器的层序调度（按层声明的图不受影响），已实现，见上面的“层序调度”。v3 stage 里另外两处对它的使用（finalization 回放、step lifecycle 没有 run 目标的分支）也已替换，见“v3 stage 不再直接调用原生调度器”。
- **发布证据**：`release:gate` 要九份报告都来自同一提交、干净工作区、`release` 配置。确定性的几份（rerank-hard-cs、arxiv-real-paper-rerank、trajectory、planner-mock、recovery-observability）可以在本机生成；compare-hard-synthetic（要求 8/8，qwen2.5:7b 上一次 6/8）、planner-real（7/7 固定投影）、runtime-smoke 和 rollout-readiness 需要 GPT 级模型，本机没有 `OPENAI_API_KEY`，只能在 CI 的 `Release Evidence Gate` 或提供密钥后生成。

### 对照"迁移完成的定义"

| 条目 | 状态 |
| --- | --- |
| `AGENT_RUNTIME=langgraph` 为默认 | 达成（阶段 4） |
| 被替代的调度代码已删除 | 未达成：外层原生循环因压测硬门保留为生产调度器；`runExecutionGraph` 按约束 12 保留到回退窗口之后（层序调度已实现，交回路径已删，v3 stage 的两处直接调用已替换，`AGENT_RUNTIME=langgraph` 下没有生产路径再调用它）；checkpoint 模块与 `agent-unified-graph-run.js` 没有调度代码可删 |
| 确定性评测屏蔽后逐字节一致 | 达成：`eval:trajectory`、`eval:planner`、`eval:recovery-observability` 两种 runtime 一致；`quality:current` 通过 |
| `verify:quality` 18/18 | 达成（阶段 3，qwen2.5:7b；文档 RAG 路径与 runtime 无关） |
| 压测退化不超过 10% | 默认配置达成（外层计划原生）；外层计划放到 LangGraph 上不达成（并发 1 时 CPU +17.6%、p95 +13%），按最终决定门不放宽，外层计划不交给 LangGraph |

按最终决定，“被替代的调度代码已删除”一行只剩原生图调度器 `runExecutionGraph` 未删（回退窗口，约束 12）；外层原生循环 `runAgentExecutionPlan` 是外层计划的生产调度器，不属于被替代的调度代码。阶段 4“回退窗口”一条把外层原生循环列为原生调度器的一处用途，那里说的“删除原生调度器”也只指 `runExecutionGraph`。

## 后果

**已认可的一处偏离（2026-10-14）。** 目标文件第 10 条写的是"`RunnableConfig.signal` 接 `request-deadline.js`"。spike 证明这样做是"至少一次"：取消后在途节点在后台跑完、写入被丢、续跑时重跑。本 ADR 改为：请求 signal 触发 `RunControl.requestDrain()`，配合节点安全点、等待在途节点、v2 checkpoint 复用。终态和错误码不变（仍走 `failRun` 的 revision CAS）。

**阶段 1 要做的事：**
- 生产代码第一次 import `@langchain/*` 的同时，加启动断言：四个 LangSmith 追踪变量不得为 `"true"`。
- `ChatOpenAI` 默认 `maxRetries` 是 6，必须设 0，或者用自定义 `BaseChatModel` 包 `completeTextWithMetadata`。
- `@langchain/core` 默认的 `withStructuredOutput` 会静默忽略 `method: "jsonSchema"`，遇到 `strict` 直接抛错。自定义模型必须自己覆盖 `withStructuredOutput`，保持 `structured-output.js` 的严格 schema 行为。

**阶段 2 要改的生产代码：**
- `agent-runs.js`：
  - `stripInternalRunFields` 删掉 `__langGraphCheckpoint`，否则它会经 `getRun` / `GET /agent-runs` 泄露；
  - 私有字段保护把它加进去；
  - 增加读写 LangGraph 记录的 service 方法，建在 `mutateStoredRun` 上，让 saver 不再自己跑 CAS 循环。
- 启动恢复要认识这个新键。
- 写放大要降下来：
  - 不再每次 put 都写事件；
  - 只在节点边界 put；
  - 统一使用 run cursor 作为 CAS 基准。
- 降不下来就要用 `pg_stat_statements` 实测后更新 `test/agent-run-chat-statement-count.test.mjs`，并在阶段 3 的 load test 里验证。

**阶段 2 的一处保留（2026-10-14）。** 原生队列按整张图的声明顺序发射节点，LangGraph 按超步进入节点。如果图不是按层声明（例如节点写在它的依赖之前，或者 `[a, c 依赖 a, b]` 且并发上限为 1），而上限或独占节点又会让原生队列压住一个就绪节点，原生每次都会先发射后层的节点。这时两个运行时会给不同节点拨预算、跑不同节点、因 fail_fast 中止不同节点，而且与时序无关。这类调用（`canScheduleExecutionGraphOnLangGraph` 为假）先丢弃线程记录，再整体交给原生调度器，结果与原生完全一致。阶段 4 删除原生调度之前必须先解决它。一种做法是在规划阶段把声明顺序规范化，但这会改变原生行为，需要单独评估。（阶段 5 已解决：没有改规划，而是让两种调度器都按校验器的层序排队，原生行为的变化与证据见阶段 5“层序调度”。）

**代码量不会自动变少。** spike 的 runner 有 2,143 行，原生 `agent-execution-graph-runner.js` 是 1,055 行。原因是 runner 自己实现了准入、复用、恢复检查、审批门绑定、取消桥接、并发闸门，还要绕开 LangGraph 的两个并发缺陷。阶段 2 要复用原生模块（调用导出的恢复检查、审批 preflight），不能复制。阶段 4 删掉原生调度后，再用行数和测试数衡量维护面有没有真的缩小。如果到阶段 3 结束仍明显变大，应回到这里重新评估方案 A。

## 回退

- 阶段 2、3：`AGENT_RUNTIME` 默认 `native`，LangGraph 路径只在显式打开时运行。
- 阶段 4 起：`AGENT_RUNTIME=native` 保留一个发布周期，作为整体回退。`AGENT_SKILL_GRAPH_ROLLOUT=off`（V1 顺序链）同样保留。
- 数据：LangGraph 的线程记录写在 run 行 `result` 下的独立私有键，原生路径不读它。回退到 `native` 后，正在 LangGraph 上执行、尚未结束的 run 由原生路径接管：启动恢复和审批续跑都从 agent run 的图 checkpoint（权威）继续，不看线程；结算保存或 `failRun` 用 null 墓碑覆盖旧线程记录。已批准、尚未写入的 Capability 在原生路径上以 run+node 幂等键执行一次；写入后崩溃（step 为 running）仍转人工，不重放。反方向（native 停靠、langgraph 续跑）走一次新的 invocation。两个方向都有测试钉住（`langgraph-unified-graph`、`langgraph-execution-graph-runtime` 的启动恢复交叉用例、`agent-unified-graph-postgres.integration` 的 7 个跨进程用例在两种 runtime 下各跑一遍）。

## 明确不做

- 不接 LangSmith、LangGraph Platform/Server、LangServe；自托管 Express 不变。
- 不用 `PGVectorStore`、`TextSplitter` 替换现有检索与切块。
- 不把 pgvector SQL、RLS、BM25 函数、索引版本、读副本、服务身份、RBAC、指标、注入筛查、claim 校验、门控、评测框架迁到 LangChain。
- 第一期不改长期记忆和经验记忆的存储。
- 不改任何评测语料、基线、阈值来让迁移"通过"。
