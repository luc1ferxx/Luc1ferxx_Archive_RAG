# ADR 0001：Agent 编排运行时迁到 LangGraph.js（strangler，保留领域层）

- 状态：**已采纳**（2026-10-14）。阶段 0、1、2 已完成（阶段 2 在 `AGENT_RUNTIME=langgraph` 后面，默认 `native`）；取消方案（drain，不把请求 signal 直接交给 LangGraph）已认可。
- 日期：2026-10-14
- 范围：`server/rag/` 的 Agent 编排运行时。领域层（检索 SQL、切块、门控、claim 校验、finalizer、注入筛查、鉴权/RBAC/RLS、服务身份、指标）不在范围内。

## 背景

`server/rag/` 里的编排运行时是自研的，分三层：

| 层 | 主要模块 | 行数 |
| --- | --- | --- |
| 外层执行计划（document loop → Web → custom Skills → Capability → finalize 的固定阶段） | `agent-execution-plan.js`、`agent-execution-plan-runner.js` | 343（runner） |
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

**迁移完成的定义**（来自目标文件）：`AGENT_RUNTIME=langgraph` 为默认；被替代的调度代码已删除；所有确定性评测在屏蔽 id 和时间后与迁移前逐字节一致，或差异已按流程在 `quality-current-suite-manifest.js` 升版本并逐条说明；`verify:quality` 18/18；`eval:load-test:pgvector` 的 app CPU/请求和 p95 退化不超过 10%。

### 不可放松的约束

1. 模型只提议、运行时决定。外层用显式 StateGraph 和确定性条件边，不用 `createAgent` 的自由 ReAct 循环。
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
- spike 全部放在 `server/test/`：辅助模块在 `server/test/langgraph-spike/`，四个套件为 `langgraph-spike-{checkpointer,evidence-gated-case,runner-mechanics,runtime-semantics}.test.mjs`，共 61 个用例。生产代码没有任何改动，覆盖率闸门不计入 `server/test/`。
- 每个套件第一个 import 是 `langgraph-spike/langsmith-off.mjs`，在 LangChain 读取环境变量之前清掉 LangSmith 的追踪开关。

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

`server/rag/langgraph/` 下 6 个文件，生产代码还没有 import 它们（`server.js` 只用到守卫）。每个适配器都有"直接调用 vs 经适配器"的 `deepStrictEqual` 套件；`prompt-registry`、`llmops-metrics`、`tracing` 三个套件没有改动，照常通过。

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

- **开关**：`AGENT_RUNTIME`（`rag/config.js` 的 `getAgentRuntime()`），默认 `native`，除 `langgraph` 外的任何值都回落到 `native`。custom-Skill 阶段据此选择 `runExecutionGraph` 或 `runExecutionGraphOnLangGraph`；`AGENT_SKILL_GRAPH_ROLLOUT` 语义不变；v3 统一图仍走原生调度器。
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

**阶段 2 的一处保留（2026-10-14）。** 原生队列按整张图的声明顺序发射节点，LangGraph 按超步进入节点。如果图不是按层声明（例如节点写在它的依赖之前，或者 `[a, c 依赖 a, b]` 且并发上限为 1），而上限或独占节点又会让原生队列压住一个就绪节点，原生每次都会先发射后层的节点。这时两个运行时会给不同节点拨预算、跑不同节点、因 fail_fast 中止不同节点，而且与时序无关。这类调用（`canScheduleExecutionGraphOnLangGraph` 为假）先丢弃线程记录，再整体交给原生调度器，结果与原生完全一致。阶段 4 删除原生调度之前必须先解决它。一种做法是在规划阶段把声明顺序规范化，但这会改变原生行为，需要单独评估。

**代码量不会自动变少。** spike 的 runner 有 2,143 行，原生 `agent-execution-graph-runner.js` 是 1,055 行。原因是 runner 自己实现了准入、复用、恢复检查、审批门绑定、取消桥接、并发闸门，还要绕开 LangGraph 的两个并发缺陷。阶段 2 要复用原生模块（调用导出的恢复检查、审批 preflight），不能复制。阶段 4 删掉原生调度后，再用行数和测试数衡量维护面有没有真的缩小。如果到阶段 3 结束仍明显变大，应回到这里重新评估方案 A。

## 回退

- 阶段 2、3：`AGENT_RUNTIME` 默认 `native`，LangGraph 路径只在显式打开时运行。
- 阶段 4 起：`AGENT_RUNTIME=native` 保留一个发布周期，作为整体回退。`AGENT_SKILL_GRAPH_ROLLOUT=off`（V1 顺序链）同样保留。
- 数据：LangGraph checkpoint 写在 run 行 `result` 下的独立私有键，原生路径不读它；回退后已有的 run 不受影响。正在 LangGraph 上执行、尚未结束的 run 在回退后由启动恢复转人工，不由原生路径接管。

## 明确不做

- 不接 LangSmith、LangGraph Platform/Server、LangServe；自托管 Express 不变。
- 不用 `PGVectorStore`、`TextSplitter` 替换现有检索与切块。
- 不把 pgvector SQL、RLS、BM25 函数、索引版本、读副本、服务身份、RBAC、指标、注入筛查、claim 校验、门控、评测框架迁到 LangChain。
- 第一期不改长期记忆和经验记忆的存储。
- 不改任何评测语料、基线、阈值来让迁移"通过"。
