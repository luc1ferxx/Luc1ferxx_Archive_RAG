# ADR 0001：Agent 编排运行时迁到 LangGraph.js（strangler，保留领域层）

- 状态：**已采纳**（2026-10-14）。阶段 0–4 已完成：自阶段 4 起 `AGENT_RUNTIME` 默认 `langgraph`。取消方案（drain，不把请求 signal 直接交给 LangGraph）和外层计划保持原生循环（阶段 3）都已认可。阶段 5（收尾，2026-10-16）对照"完成的定义"逐条处理，结论见"阶段 5 结果"。外层计划长期保持原生循环、不放宽压测硬门，曾定为最终决定（用户认可，2026-10-16）；阶段 7（2026-11-13）按用户的新决定推翻：外层计划也只走 LangGraph，原生循环和 `AGENT_OUTER_PLAN_RUNTIME` 开关已删除，见“阶段 7 结果”。阶段 6（2026-10-16）：用户决定提前结束约束 12 的回退窗口，原生图调度器 `runExecutionGraph` 和 `AGENT_RUNTIME=native` 已删除，需要持久状态与中断的图一律由 LangGraph 调度，没有运行时回退开关，见"阶段 6 结果"。阶段 8（2026-11-13）：用户决定删除 custom Skill 阶段的 V1 顺序链和选择它的 `AGENT_SKILL_GRAPH_ROLLOUT=off|shadow`，agent 里不再有不走 LangGraph 的路径，见“阶段 8 结果”。
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

阶段 5（收尾）、阶段 6（删除原生图调度器）和阶段 7（删除外层原生循环）是后加的，见各自的"结果"一节。阶段 6 提前结束了阶段 4 这一行的"`native` 保留一个发布周期"；阶段 7 之后 agent 只有 LangGraph 一种运行方式。

**迁移完成的定义**（来自目标文件；阶段 5 的最终决定修订了“被替代的调度代码已删除”一条：外层计划的原生循环 `runAgentExecutionPlan` 是生产调度器，不属于被替代的调度代码，要删的只有原生图调度器 `runExecutionGraph`，阶段 6 已删除，见“阶段 5 结果”“阶段 6 结果”）：`AGENT_RUNTIME=langgraph` 为默认；被替代的调度代码已删除；所有确定性评测在屏蔽 id 和时间后与迁移前逐字节一致，或差异已按流程在 `quality-current-suite-manifest.js` 升版本并逐条说明；`verify:quality` 18/18；`eval:load-test:pgvector` 的 app CPU/请求和 p95 退化不超过 10%。

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
12. V1 顺序链和 `AGENT_SKILL_GRAPH_ROLLOUT=off` 保留到 LangGraph 成为默认后至少一个发布周期；`AGENT_RUNTIME=native` 是整体回退开关。**后半条已由用户于 2026-10-16 豁免**：分支还没推送、没发布，回退窗口还没开始计算，用户决定提前结束它。原生图调度器和 `AGENT_RUNTIME=native` 已删除，不再存在（阶段 6）。前半条当时不受影响：V1 顺序链和 `AGENT_SKILL_GRAPH_ROLLOUT=off` 保留到了阶段 8。**前半条已由用户于 2026-11-13 结束**：`guarded` 成为默认值七周之后，顺序链和 `off`、`shadow` 两个取值已删除（阶段 8）。
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

- **开关**：`AGENT_RUNTIME`（`rag/config.js` 的 `getAgentRuntime()`），阶段 2、3 默认 `native`，除 `langgraph` 外的任何值都回落到 `native`（阶段 4 起默认 `langgraph`，见下文；阶段 6 删除了 `native` 和这个开关）。custom-Skill 阶段据此选择 `runExecutionGraph` 或 `runExecutionGraphOnLangGraph`；`AGENT_SKILL_GRAPH_ROLLOUT` 语义不变；v3 统一图仍走原生调度器。
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
- **回退窗口**：原生图调度器 `runExecutionGraph` 不删，作为一个发布周期的整体回退（约束 12），见“回退”。阶段 4 时它还接手 LangGraph 无法按原生声明顺序调度的图（`canScheduleExecutionGraphOnLangGraph`）；这个交回情形已在阶段 5 解决，见“层序调度”。删除它原计划在新默认发布一个周期后单独进行；阶段 6 已提前删除（用户豁免了约束 12 的回退窗口），见“阶段 6 结果”。外层 V1 计划在两种 runtime 下都走原生循环 `runAgentExecutionPlan`（阶段 3 的决定，阶段 5 定为长期）；那是外层计划的生产调度器，不属于原生图调度器，也不在删除之列。
- **写放大已接上**：执行器把 `retainCheckpoints: 2` 交给 saver；custom-Skill DAG 结算保存与 v3 一样在同一个 CAS 里丢弃线程记录。真库 `pg_stat_statements` 重测（PostgreSQL 18，2 节点 guarded custom-Skill `/chat`）：
  - 语句数与阶段 3 相同：native 是 1 insert、9 带事件 CAS、3 追加事件、1 run 读、1 事件表读；langgraph 在此之外多 7 次无事件 CAS、1 次 run 读、1 次事件表读。
  - 完成后的 `result` 从 17,006 字节降到 11,894 字节（native 11,860 字节，多出的是 29 字节的墓碑）。
  - 运行中单次写入的线程记录最大 2,975 字节，`result` 最大 14,639 字节。
- **spike 删除**：`server/test/langgraph-spike/` 和四个 spike 套件已删除。只有 spike 证明过的性质移进了生产套件：
  - LangGraph 1.5.0 的两个 `maxConcurrency` 缺陷、只有 Capability 的 preflight 能停靠或拒绝节点：`langgraph-execution-graph-runtime`。
  - 直接交给 LangGraph 的 `AbortSignal` 会重跑在途节点：`langgraph-checkpointer`。
  - 两租户重叠执行时上下文与线程写入各归各的；被放弃的停靠节点；排队的门控 Capability 在取消后不被预检；暂停后 policy 变化时拒绝执行（`graph_approval_not_required`）：`langgraph-unified-graph`。
  - 有待定审批门时拒绝启动 claim：`agent-execution-graph-checkpoint`。
- **回退路径不失去覆盖**：新套件 `agent-graph-suites-native-rollback` 在 `AGENT_RUNTIME=native` 下原样重跑 9 个图相关套件。预加载钩子会让任何进入 LangGraph 执行器的调用直接失败，同时统计原生调度的图数。两个 PostgreSQL 集成套件的跨进程用例在两种 runtime 下各跑一遍。（阶段 6 随原生调度器一起删除了这个套件和它的预加载，native 一侧改为 golden，见“阶段 6 结果”。）
- **测试环境**：`npm test` 和覆盖率闸门给每个测试子进程去掉 LangSmith 追踪变量（变量列表取自生产守卫），由 `ci-workflow.test.mjs` 钉住。
- **压测脚本**：`--agent-runtime` 默认改为 `langgraph`，与应用一致。（阶段 6 起只接受 `langgraph`，见“阶段 6 结果”的“删了什么”。）
- **代码量**：现在原生 runner 386 行、共享节点模块 1,138 行、`server/rag/langgraph/` 下 19 个文件共 6,463 行（含阶段 1 的适配器）。维护面还没有缩小：要等回退窗口结束、删除原生调度器之后才会体现，届时再按行数和测试数衡量。如果解决交回情形的成本过高，应重新评估是否保留原生调度器作为长期的第二调度器。（交回情形已在阶段 5 解决，见“层序调度”；原生图调度器不留作第二调度器，阶段 6 已删除，见“阶段 6 结果”。）

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
  - "完成的定义"据此修订：`runAgentExecutionPlan`（`agent-execution-plan-runner.js` 的原生循环）是外层计划的生产调度器，不属于"被替代的调度代码"。要删的只剩原生图调度器 `runExecutionGraph`（阶段 6 已删除）。
  - `AGENT_OUTER_PLAN_RUNTIME=langgraph` 与底层 Pregel 实现保留为实验开关，不再计划转正，`test/langgraph-execution-plan-graph*.test.mjs` 继续守住它与原生外层循环的等价（阶段 6 不动这个开关）。
  - 重新评估的条件：升级 `@langchain/langgraph` 或 `@langchain/core` 后，Pregel 每次调用的固定开销（执行循环、任务 id、checkpoint 对象）有实质下降。届时按本节的方法重测：进程内对比，交替四轮、每轮 5 次的并发 1 压测，以及并发 32。每一档都在 10% 以内，才考虑切换默认值。

### 规划器的模型调用经 LangChain ChatModel

- `rag/langgraph/planner-model.js` 的 `completePlannerText`：`AGENT_RUNTIME=langgraph` 时，意图、执行、DAG、v3 统一图、replan 五个规划器的模型调用经 `ArchiveRagChatModel.invoke(prompt, { promptTemplate, responseFormat, temperature })`；`native` 时仍直接调 `completeTextWithMetadata`（阶段 6 删除了 `native`，见“阶段 6 结果”）。适配器按需动态加载（原生进程不加载 `@langchain/*`），每个（capability, routeId）缓存一个实例，调用在空的 LangChain 异步上下文里进行，不建根 `RunTree`。只接受 capability、promptTemplate、responseFormat、routeId、temperature 五个选项，多传就拒绝。
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
- **删除原生调度器还剩什么**：代码上已没有阻碍，只剩回退窗口（约束 12）。窗口过后要删的是下面四项（阶段 6 没有等窗口，按用户决定删掉了这四项，见“阶段 6 结果”）：
  - `runExecutionGraph` 的调度循环；
  - 两个 stage 的 `native` 分支；
  - `agent-graph-suites-native-rollback.test.mjs` 及其守卫；
  - 各 parity 套件里的 native 一侧。

  准入（`admitExecutionGraphRun`）、收尾（`finishExecutionGraphRun`）、`replayExecutionGraphRun` 和 node 模块不在删除之列，阶段 6 之后仍然保留（LangGraph 执行器、v3 的 finalization 回放和启动恢复都依赖它们）。

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
- **原生调度器不删除**（阶段 5 时的结论；阶段 6 按用户决定提前删除，见“阶段 6 结果”）：
  - 约束 12 要求 `AGENT_RUNTIME=native` 在新默认发布后至少保留一个周期；阶段 4 刚切默认。
  - 目标点名的四个文件里，只有 `agent-execution-graph-runner.js` 有可删的调度循环（`runExecutionGraph`）。`agent-execution-graph-checkpoint.js` 和 `agent-unified-graph-run.js` 没有调度代码：前者是 run 的权威图 checkpoint，后者是 v3 的入口与准入流程。`agent-execution-plan-runner.js` 的原生循环是外层计划的生产调度器（见上）。
  - 交回情形：`eval:trajectory` 里实测为 0 次（17 次执行器调用）；生产默认的 custom-Skill DAG 不会出现（预算 2、四个 custom Skill 都可并行、上限 3）；v3 带 Web 的确定性文档图以前每次都会出现（非按层声明，document_rag 与 web 节点独占）。解法是两种 runtime 都按校验器的层序调度（按层声明的图不受影响），已实现，见上面的“层序调度”。v3 stage 里另外两处对它的使用（finalization 回放、step lifecycle 没有 run 目标的分支）也已替换，见“v3 stage 不再直接调用原生调度器”。
- **发布证据**：`release:gate` 要九份报告都来自同一提交、干净工作区、`release` 配置。确定性的几份（rerank-hard-cs、arxiv-real-paper-rerank、trajectory、planner-mock、recovery-observability）可以在本机生成；compare-hard-synthetic（要求 8/8，qwen2.5:7b 上一次 6/8）、planner-real（7/7 固定投影）、runtime-smoke 和 rollout-readiness 需要 GPT 级模型，本机没有 `OPENAI_API_KEY`，只能在 CI 的 `Release Evidence Gate` 或提供密钥后生成。

### 对照"迁移完成的定义"

| 条目 | 状态 |
| --- | --- |
| `AGENT_RUNTIME=langgraph` 为默认 | 达成（阶段 4） |
| 被替代的调度代码已删除 | 达成（阶段 6）：`runExecutionGraph` 的调度循环、两个 stage 的 `native` 分支和 `AGENT_RUNTIME=native` 已删除。这是用户提前结束约束 12 回退窗口的结果，不是等窗口过去。外层原生循环 `runAgentExecutionPlan` 不是被替代的调度代码：按阶段 5 的最终决定，它是外层计划的生产调度器，保留。checkpoint 模块与 `agent-unified-graph-run.js` 没有调度代码可删 |
| 确定性评测屏蔽后逐字节一致 | 阶段 5 达成：`eval:trajectory`、`eval:planner`、`eval:recovery-observability` 在两种 runtime 下一致，`quality:current` 通过。阶段 6 达成：删除前后三项评测屏蔽后逐字节一致，`quality:current` 的结果见“阶段 6 结果”的证据；阶段 6 起没有 native 可比，图相关套件对照删除前从 native 冻结的 golden |
| `verify:quality` 18/18 | 达成（阶段 3，qwen2.5:7b；文档 RAG 路径与 runtime 无关） |
| 压测退化不超过 10% | 默认配置达成（外层计划原生）；外层计划放到 LangGraph 上不达成（并发 1 时 CPU +17.6%、p95 +13%），按最终决定门不放宽，外层计划不交给 LangGraph |

## 阶段 6 结果：删除原生图调度器（2026-10-16）

### 决定

- 用户决定提前结束约束 12 的回退窗口，现在就删除原生图调度器。
- 这是对约束 12 后半条的豁免。按约束 12，LangGraph 成为默认后，`AGENT_RUNTIME=native` 要至少保留一个发布周期。分支 `feat/langgraph-runtime` 还没推送、没发布，这个周期还没开始算。
- 删除之后 `AGENT_RUNTIME=native` 不再存在，也没有别的运行时回退开关。要回到原生调度器，只能 revert（见下文"怎样恢复回退"）。
- 不动的部分：
  - 外层计划的原生循环 `runAgentExecutionPlan`。按阶段 5 的最终决定，它是外层计划的生产调度器，长期保留。
  - `AGENT_OUTER_PLAN_RUNTIME` 实验开关和它的底层 Pregel 图。
  - 约束 12 的前半条：V1 顺序链和 `AGENT_SKILL_GRAPH_ROLLOUT=off`。（阶段 8 已删除。）

### 删了什么

- `agent-execution-graph-runner.js`：`runExecutionGraph` 的调度循环，以及只有它用到的导入（`prepareExecutionGraphNodeLaunch`、`executeExecutionGraphNodeLaunch`）。文件从 478 行减到 295 行，文件名不变。
- `agent-custom-skill-stage.js` 和 `agent-unified-graph-stage.js`：
  - 删掉 native 分支、`runtime` 参数，以及导出的 `CUSTOM_SKILL_GRAPH_RUNTIMES` / `UNIFIED_GRAPH_RUNTIMES`。
  - 图一律交给 `runExecutionGraphOnLangGraph`。
  - 执行器仍按需动态导入：在 `agent.js` 之后再加载 LangGraph 实测多 174 ms，api 边缘层和 rollout 为 `off` 的进程不必承担。（阶段 7 之后外层计划也在 LangGraph 上，rollout 为 `off` 的进程同样加载 LangGraph，见阶段 7 的代价。）
  - v3 stage 现在总会检查 lifecycle target 的 runId 等于 `agentRunId`。原来的默认 runtime 下本来就检查。
- `rag/config.js` 的 `getAgentRuntime()`，以及依赖它的所有分支：
  - `agent-run-recovery.js`：线程核对（`verifyLangGraphThread`）总是执行。
  - `agent-unified-graph-run.js`：LangSmith 守卫总是执行。
  - `rag/langgraph/planner-model.js`：五个规划器始终经 `ArchiveRagChatModel`。只有 LangSmith 追踪变量为 `"true"` 时走直接调用，这是阶段 5 已有的路径。第三个参数 `runtime` 删除。
- 压测 `evaluation/run-api-load-bench.mjs`：
  - `--agent-runtime` 只接受 `langgraph`，它不改变任何设置；`--agent-runtime native` 在参数检查时给出压测自己的错误（"--agent-runtime native was removed (ADR 0001 phase 6) ..."），其他值也拒绝。
  - app 子进程本来就丢掉继承来的 `AGENT_*` 变量，现在也不再设 `AGENT_RUNTIME`，所以压测的子进程碰不到 app 的启动拒绝，shell 里的 `AGENT_RUNTIME` 也到不了子进程。
  - 报告照旧记录 `config.agentRuntime`，阶段 6 起总是 `langgraph`，报告里的 `Agent runtime` 一行仍然打印它。
- 测试：
  - `agent-graph-suites-native-rollback.test.mjs`，以及它的预加载 `native-rollback-guard.mjs`、`langgraph-executor-forbidden.mjs`、`native-runner-counter.mjs`。
  - `langgraph-native-runner-suite.test.mjs` 和 `langgraph-runtime-parity/runner-on-langgraph.mjs`。它的职责成了默认：`agent-execution-graph-runner.test.mjs` 直接对 `runExecutionGraphOnLangGraph` 跑。
  - `stage-native-scheduler-tripwire.mjs`，由只统计回放次数的 `stage-replay-counter.mjs` 替代。
  - 各 parity 套件里的 native 一侧。

### 保留什么

- `agent-execution-graph-runner.js` 里的准入 `admitExecutionGraphRun`、收尾 `finishExecutionGraphRun`、不调度的 `replayExecutionGraphRun`。
- node 模块 `agent-execution-graph-node.js`（代码没改；评审之后只把文件头和一处 JSDoc 里指向已删除的 `runExecutionGraph` 的注释改成了现在的调度器和 `admitExecutionGraphRun`，1,171 → 1,175 行）。
- 图 checkpoint、回放安全矩阵、启动恢复、审批表与 policy。
- 外层原生循环 `runAgentExecutionPlan` 和 `AGENT_OUTER_PLAN_RUNTIME`。

### 拒绝已删除的取值（启动时与每个图入口）

- `rag/config.js` 的 `assertAgentRuntimeSupported(env)`，错误码 `AGENT_RUNTIME_REMOVED`。
  - 照常启动：未设置、空串、纯空白、`langgraph`（去首尾空白，大小写不限）。
  - `native`：拒绝，信息是"AGENT_RUNTIME=native was removed (ADR 0001 phase 6) ... Unset AGENT_RUNTIME or set it to langgraph."
  - 其他值（如 `lang-graph`）：同样拒绝，信息里带原值。
- 为什么拒绝而不是忽略：阶段 4 时拼错的值会落到 native。现在没有 native 可落，静默跑 LangGraph 等于忽略运维的意图。
- 检查位置：
  - `server.js`：紧接在 LangSmith 启动守卫之后。
  - `startServiceRole`（`rag/agent-service/role-server.js`）：一开头检查传入的 env，在 topology 校验之前。它覆盖不经过 `server.js` 直接起角色的调用方，例如压测的 split 拓扑。
  - `createAppServices`（`app-services.js`）：第一行就检查，还没读任何 option。所有进程内的 app 都经过它：monolith、agent tier，以及调用 `createApp` 的 eval runner（如 runtime smoke）。压测子进程也经过它，但压测从不把 `AGENT_RUNTIME` 交给子进程，这里不会触发。
  - 每个把图交给 LangGraph 的入口，和 LangSmith 守卫在同一位置：custom-Skill stage（写图 checkpoint 之前）、v3 统一图的三个入口（新请求、审批续跑、启动续跑）和 v3 stage、执行器 `runExecutionGraphOnLangGraph`（准入之前）。这一层覆盖不建 app、直接调用 `runAgentRag` 的 eval runner（`eval:trajectory`、`eval:planner`、`eval:recovery-observability`、`eval:prompt-injection`、`eval:answer-drafts`、`eval:qasper-answers -- --surface agent` 等）：需要调度图的请求以 `AGENT_RUNTIME_REMOVED` 失败，trajectory 报告里是一条 `case_error`，不会被当成 native 的证据。
- 这一层之外不检查的：
  - 不调度图的请求（文档问答、research brief、V1 外层计划本身）。这些请求在 native 和 LangGraph 下本来就走同一份代码，结果不依赖这个变量。
  - 规划器的模型调用（`completePlannerText`）。它总经 ChatModel 适配器，与直接调用的等价由 `langgraph-planner-model` 的 golden 钉住；在这里拒绝只会让 LLM 规划器回落到确定性规划，反而悄悄改变行为。
  - `chat-mcp.js`、`ingest-worker.mjs`、`retrieval-service.mjs`、`model-gateway.mjs`：不跑图。
- `test/agent-runtime-removed.test.mjs`（9 个测试）覆盖 8 种取值：`assertAgentRuntimeSupported` 本身、`startServiceRole` 在 topology 检查前拒绝、真实执行 `node server.js` 时以非 0 退出且 stderr 带 `AGENT_RUNTIME_REMOVED`、`createAppServices` 在读任何 option 之前拒绝、执行器在准入之前拒绝，以及 eval runner 的进程内调用（custom-Skill DAG 与 v3 统一图各一个 trajectory 用例）在 `native` 下得到 `case_error`、未设置时没有。后三个测试在去掉这些检查的副本上都失败。

### 等价保护怎么保住

- 删除之前，先从 native 一侧冻结 golden，放在 `server/test/fixtures/graph-goldens/<套件>/`。第一批 6 个套件共 94 个文件，约 4.7 MB；评审之后又从 HEAD e1385c1c（原生调度器还在）以 `AGENT_RUNTIME=native` 补冻了两个套件的 8 个文件（见下面 `langgraph-routes`、`langgraph-execution-plan-graph`），现在共 8 个套件、102 个文件，约 5.4 MB。补冻的文件在同一提交上连跑两次，逐字节相同。
  - 能存全量的，存屏蔽后的完整 JSON。
  - 扫描太大的，存规范化序列化的 sha256（`digests.json`）。
  - 规范形式保留 `deepStrictEqual` 在纯数据上比较的一切：键排序、数组保序；`undefined`、`-0`、`NaN`、±Infinity、Map、Set、Date 加标签，不丢弃。
- 下列套件里原来比较两种 runtime 的场景，现在只在 LangGraph 上跑一次，对照 golden（`test/langgraph-support/graph-goldens.mjs`）。比较的屏蔽规则与删除前相同，下面单独列出的两处例外除外。第一批 94 个文件的 sha256 在改动前后一致。逐套件：
  - `langgraph-execution-graph-runtime`：`assertParity` 对照 golden；五节点扫描的 720 个场景存摘要，另有 6 份完整 golden。
  - `langgraph-unified-graph`：回放扫描的 480 个原始运行现在由 LangGraph 跑出，对照 native 的 480 条摘要和 8 份完整 golden；回放结果对照 native 调度器重跑已完成图的 golden。
  - `langgraph-unified-graph-without-run-target`：执行器 tap 代替绊线。断言执行器调用次数等于原来原生调度器的调用次数，没有 run 目标时一律不绑定 run；回放计数器断言 finalization 回放时执行器调用 0 次、回放 1 次。
  - `langgraph-runtime-parity`：每个用例只跑一次，对照 `<case id>.json`。
  - `agent-run-chat-statement-count`：native 的语句数存在 golden 里，注释也写了原值；剩 `default` 和 `outerPlan` 两个 pass。
  - `langgraph-planner-model`：每个场景只走 ChatModel 路径一次，对照直接调用路径的 golden（115 条摘要和 4 份完整决策）。另外断言第一次走适配器之前没有任何 `@langchain` 模块被加载。
  - `langgraph-routes`（补冻，5 个文件）：经真实 app 的 v3 批准与拒绝（暂停响应、暂停的 run、决定响应、完成的 run 和 checkpoint）、v3 的 `/chat/stream` 到审批暂停（SSE 字节、帧、run）、后台任务的审批重入（等待中的 task、暂停的 run、完成的 task、完成的 run）、启动恢复（崩溃留下的 run、恢复后的 run、第二个实例的调用）。生产配置（`AGENT_OUTER_PLAN_RUNTIME` 未设置）对照 golden，屏蔽规则就是套件里原来的 `mask` / `maskText`。只读文档问答、它的流和 V1 Capability 审批不建图，从来不依赖 `AGENT_RUNTIME`，没有 golden。
  - `langgraph-execution-plan-graph`（补冻，3 个文件）：custom-Skill 阶段跑 guarded DAG 的三个 trajectory 用例（`skill_chain_contract_review`、`custom_skill_access_scope`、`multi_doc_conflict`）的结果、agent 事件和 run，生产 pass 对照 golden。其余场景不建 custom-Skill DAG 或 v3 图，规划用注入的适配器，与 `AGENT_RUNTIME` 无关。
- 比较方式与删除前不同的两处：
  - `langgraph-unified-graph` 的回放扫描：删除前在同一进程里拿回放结果和原生重跑的结果直接比较，不屏蔽（用的是 `assert.deepEqual`）；现在两边都按套件的 `mask` 屏蔽后存摘要再比较。UUID、时间戳这类进程间不同的值不再参与比较；反过来，规范形式区分类型和 `undefined`，比原来的 `deepEqual` 严格。
  - `langgraph-planner-model`：golden 里把假 OpenAI 服务的临时端口规范成 `http://127.0.0.1:<port>`，并去掉 V8 在新版 Node 上给 `JSON.parse` 错误加的 " (line L column C)" 后缀。删除前两边在同一进程里共享这两个值，不需要规范化。
- superstep 屏障的四类已知差异，改为对 golden 的投影比较。例如要求 skillRuns 两边顺序不同、排序后相同。这类 golden 只经 `readGolden` 读取，没有代码路径能改写。
- 直接调用调度器的套件改指 `runExecutionGraphOnLangGraph`，断言一条没改：`agent-execution-graph-runner`（52 个）、`agent-document-rag-graph-result`、`agent-replanner`。

### UPDATE_GRAPH_GOLDENS 规则

- 不设或为空：只比较。缺失或不同即失败，不写文件。
- `=1`：从被测运行时（LangGraph）写入，只限允许写入的一侧。必须对照调度器 golden 的一侧（例如回放）传 `write: false`，永远不写。
- 写入新的或改变了的 fixture 后，本次测试仍然失败，并给出文件名。要先看 diff，在同一次改动里用注释说明有意的行为变化，再不带变量重跑。所以更新模式只有什么都没变时才通过。
- 其他值（`native`、`true`、`yes`、`" 1"` 等）一律拒绝。
- 只读的 golden（superstep 与已知差异）要有意改变时，只能手工编辑 fixture。
- `test/graph-goldens.test.mjs` 钉住这些规则。
- "在注释里说明行为变化"这一条代码无法强制，只写在报错文案和 helper 的文件头里。

### 失去、且没有替代的覆盖

- 只描述 native 自身的断言：native 不写线程、native 的 fence 报错信息、recovery-claim 与预算已知差异里 native 的字面期望（原值留在注释里）。
- 两个 PostgreSQL 集成套件的 native 跨进程运行：`agent-execution-graph-postgres.integration` 的两个用例、`agent-unified-graph-postgres.integration` 的七个用例，删除前各在 `AGENT_RUNTIME=native` 下再跑一遍、用同样的断言。冻结 golden 需要真库，没有做；现在它们只在 LangGraph 上跑，只受各自的字面断言约束，没有 native 锚点。
- `langgraph-chat-stream` 原来的 `AGENT_RUNTIME=native` pass：它只发文档问题，不建图，那一 pass 跑的就是现在 native pass 的同一份代码，所以没有冻结，也没有实际损失。
- 两类回退场景：LangGraph 暂停后由 native 决定、native 恢复一个伪造的线程。原生路径已不存在，它们没有对象了。
- `getAgentRuntime()` 的开关测试，由 `agent-runtime-removed` 的启动拒绝测试替代。

### 升级时在途的 run

- 阶段 6 之前在 `AGENT_RUNTIME=native` 下暂停或崩溃的 run 只有图 checkpoint，没有 LangGraph 线程。
- LangGraph 的审批续跑和启动恢复对没有线程的 run 本来就走一次新的 invocation（阶段 3）。
- 两个改写过的用例钉住了这一点，都对照同一份 golden：
  - LangGraph 暂停，从 store 删掉线程，再决定。
  - LangGraph 崩溃，删掉线程，再由 LangGraph 恢复；compare 节点在新线程里是 reused。

### 怎样恢复回退

- `git revert` 阶段 6 的提交。没有别的开关能恢复原生调度。
- revert 恢复 `runExecutionGraph`、两个 stage 的 native 分支、`getAgentRuntime()`、回退套件和各 parity 套件的 native 一侧，同时去掉启动拒绝和 golden。
- revert 之后在途 run 怎么处理，见下文"回退"一节里阶段 4、5 的规则。

### 证据

- 删除提交前逐个运行的单文件套件（Node 24.21.0）：`agent-execution-graph-runner` 52/52、`langgraph-execution-graph-runtime` 43/43（原 44 个，删了开关测试）、`langgraph-unified-graph` 25/25（原 26 个，同上）、`langgraph-unified-graph-without-run-target` 4/4、`langgraph-runtime-parity` 6/6（`UPDATE_GRAPH_GOLDENS=1` 下也是 6/6 且没有文件被改写，`=native` 下按预期被拒绝）、`agent-run-chat-statement-count` 10/10、`langgraph-planner-model` 12/12、`agent-runtime-removed` 6/6、`graph-goldens` 5/5。
- 评审修复之后逐个重跑（Node 24.21.0）：`langgraph-routes` 8/8、`langgraph-execution-plan-graph` 26/26（两者对照补冻的 golden）、`agent-runtime-removed` 9/9（新增的三个测试在去掉进程内检查的副本上失败）、`agent-execution-graph-runner` 52/52、`langgraph-execution-graph-runtime` 43/43、`langgraph-unified-graph` 25/25、`langgraph-unified-graph-without-run-target` 4/4、`langgraph-runtime-parity` 6/6、`langgraph-planner-model` 12/12、`langgraph-tools-adapter` 23/23、`graph-goldens` 5/5、`agent-unified-graph-guarded` 21/21、`agent-custom-skill-stage` 23/23。`AGENT_RUNTIME=native` 下 `langgraph-runtime-parity` 现在 5 个用例以 `AGENT_RUNTIME_REMOVED` 失败（剩下的 shadow 用例不调度图）；修复前 6 个全部通过，即悄悄跑了 LangGraph。把 `langgraph-routes` 的启动恢复 golden 删掉一个 `skill_graph_resume_claimed` 事件，比较按预期失败。
- 两个 PostgreSQL 集成套件（`agent-execution-graph-postgres.integration`、`agent-unified-graph-postgres.integration`）现在只在 LangGraph 上跑，没有从 native 冻结的 golden（冻结需要真库），只靠用例自己的行为断言；它们在下面的 `test:pgvector` 里通过。
- 删除之后的整体验证（本机 Node 24.21.0）：
  - `coverage:gate`：3,250 个测试，3,235 通过、15 跳过、0 失败，全局行覆盖 90.46%。删除前是 3,300 个，少掉的主要是删除的 `agent-graph-suites-native-rollback`、`langgraph-native-runner-suite` 和各套件里的开关测试。
  - `eval:trajectory` 19/19、`eval:planner -- --provider mock` 7/7、`eval:recovery-observability` 8/8：删除前（e1385c1c）与删除后各跑一次，屏蔽 UUID、时间戳、时长和 git 状态后逐字节一致。
  - `test:pgvector`（一次性集群，`scripts/run-pgvector-integration.sh`）：101/101。删除前是 111 个，因为跨进程用例原来在两种 runtime 下各跑一遍。
  - `quality:current`：在删除提交 f7535832 上于模拟 CI 的环境里运行（一次性 PostgreSQL、干净工作区、五项确定性评测都由该提交生成），通过，指标 `pass`。
  - CI（Node 22）上的 golden 比较：写这一节时还没跑，golden 在 Node 24 上生成。合并进 main 之后，CI 的 `server-tests`（Node 22）带着这些套件运行并通过（例如 2026-11-13 main 上 b8e4d2ed 和 89a70d0a 的 Quality Gate 运行）。
- 代码量（阶段 4 说过要等删掉原生调度器后再衡量维护面）：`agent-execution-graph-runner.js` 478 → 295 行；生产代码 +397 −533 行，净减 136 行；测试（不含 golden）+4,353 −4,088 行，净增 265 行；golden 共 102 个文件、约 5.3 MB。维护面在生产代码上缩小了，测试一侧因为固定期望而变大。

## 阶段 7 结果：外层计划只走 LangGraph，删除原生循环（2026-11-13）

### 决定

- 用户决定 agent 只保留一种运行方式（原话：“我不希望 agent 有两种运作模式，我只希望用已经迁移了的 langgraph”）。
- 这推翻了阶段 5 的最终决定（“外层计划长期保持原生循环、不放宽压测硬门”，2026-10-16，同一位用户认可）。10% 的门没有重测，也没有通过：这次是知情地接受代价，换取只有一个调度器。
- 删除之后 `AGENT_OUTER_PLAN_RUNTIME=native` 不再存在，也没有别的开关能回到原生循环。要回去只能 revert（见下文“怎样恢复”）。
- 不动的部分：
  - 各阶段的阶段体（`createAgentExecutionPlanStages`）、剪枝规则、底层 Pregel 图本身（阶段 5 的实现，未改一行调度逻辑）。
  - 外层计划的持久性：仍然是 run 的 step 和回放矩阵，外层图不带 checkpointer。
  - V1 顺序链和 `AGENT_SKILL_GRAPH_ROLLOUT=off|shadow`、`AGENT_UNIFIED_GRAPH_ROLLOUT`（v3 默认 `off`）、三个 planner 开关。它们是灰度开关，不是调度器之分。（顺序链和 `off|shadow` 在阶段 8 删除。）

### 代价（接受的）

- 进程内（2026-11-13，删除之前在同一进程里交替 7 轮、每轮 400 次文档问答，Node 24.21.0，内存 run store、桩 ragService）：每次 `runAgentRag` 的 CPU 中位数 0.605 ms（原生循环）对 0.894 ms（LangGraph），多 0.29 ms；墙钟 0.506 对 0.701 ms。与阶段 5 的 0.28 ms 一致。
- 压测没有重跑。阶段 5 的数字仍是唯一的端到端测量：pgvector、模型 0 ms、并发 1，每请求 CPU 中位数 5.68 → 6.68 ms（+17.6%），p95 9.3 → 10.5 ms（+13%）。阶段 7 之前写的压测报告里，`/chat` 的每请求 CPU 比同一提交现在测出来的低约 1 ms。
- 真实模型下一次文档问答约 2.4 s，其中 99.5% 是答案模型（见 `docs/evaluation.md`“默认配置的答案漏斗、延迟和 token”），这 0.3 ms 看不出来。受影响的是 0 ms 假模型下的单进程吞吐上限。
- 回答 agent 请求的进程在第一个请求时加载 `@langchain/*`。2026-11-13 实测（Node 24.21.0，`agent.js` 之后导入图模块，GC 后的 RSS）：一次性约 115 ms，RSS 82 → 143 MB。默认配置下 LLM 规划器本来就在第一个 `/chat` 加载 LangChain core（约 70 ms，RSS 到 122 MB），所以阶段 7 实际多出的是 LangGraph 本身：约 50 ms、约 21 MB；规划器全用确定性实现的部署才承担全部的 115 ms 和约 60 MB。split 部署的 api 边缘层、ingest worker、检索层和模型网关仍然不加载。

### 删了什么

- `agent-execution-plan-runner.js`：原生调度循环（`runAgentExecutionPlan` 里的 `for` 循环和阶段边界的 `throwIfRequestCancelled`）、`resolveAgentExecutionPlanRunner`。`runAgentExecutionPlan` 这个名字保留为唯一入口：按需导入图模块，把每个计划交给 `runAgentExecutionPlanOnLangGraph`。472 → 444 行。
- `rag/config.js` 的 `getAgentOuterPlanRuntime()`。
- `routes/chat.js` 的 `/chat/stream` native 分支。路由只剩 `streamAgentRun` 生成器一条路径（`rag/langgraph/agent-stream.js`，本身不依赖 `@langchain/*`，改为静态导入）。
- `agent.js`：调用点直接调 `runAgentExecutionPlan`。
- 压测 `evaluation/run-api-load-bench.mjs`：`--outer-plan-runtime` 只接受 `langgraph`；`native` 在参数检查时给出压测自己的错误，其他值也拒绝。app 子进程不再收到 `AGENT_OUTER_PLAN_RUNTIME`。报告的 `config.outerPlanRuntime` 从此总是 `langgraph`，旧报告照原样渲染。
- 测试里的 native 一趟：四个对拍套件改为只在 LangGraph 上跑一次、对照 golden（见“等价保护怎么保住”）。`service-split.e2e` 不再把 `AGENT_OUTER_PLAN_RUNTIME` 从 shell 透传给各 tier。

### 拒绝已删除的取值

- `assertAgentRuntimeSupported(env)` 现在检查两个变量，各有错误码：`AGENT_RUNTIME`（`AGENT_RUNTIME_REMOVED`，阶段 6，文案未变）和 `AGENT_OUTER_PLAN_RUNTIME`（`AGENT_OUTER_PLAN_RUNTIME_REMOVED`）。
  - 照常启动：未设置、空串、纯空白、`langgraph`（去首尾空白，大小写不限）。
  - `native`：拒绝，“AGENT_OUTER_PLAN_RUNTIME=native was removed (ADR 0001 phase 7): the outer execution plan always runs on LangGraph. Unset AGENT_OUTER_PLAN_RUNTIME or set it to langgraph.”
  - 其他值（如 `pregel`）：同样拒绝，信息里带原值。
- 行为变化：阶段 7 之前，`AGENT_OUTER_PLAN_RUNTIME` 拼错的值静默落到 native。现在没有 native 可落，拼错即拒绝启动。`server/.env` 里如果显式写了 `AGENT_OUTER_PLAN_RUNTIME=native`，要删掉这一行。
- 检查位置：阶段 6 的全部位置（`server.js`、`startServiceRole`、`createAppServices`、custom-Skill stage、v3 的三个入口与 stage、执行器），再加外层计划的入口 `runAgentExecutionPlanOnLangGraph`（在校验计划、建任何阶段之前）。
- 检查范围因此变宽：阶段 6 时“不调度图的请求不检查”，因为它们在两种 runtime 下走同一份代码。现在每个走到外层计划的请求都调度图，所以不建 app、直接调 `runAgentRag` 的 eval runner 在环境里有任一已删除取值时，文档问答也以对应的 `*_REMOVED` 失败（trajectory 报告里是一条 `case_error`）。
- LangSmith：外层计划的入口本来就在建图之前拒绝 LangSmith 追踪变量。阶段 7 之前，普通文档问答走原生循环、不建图，在这种变量下照常回答；现在两条路由的拒绝范围不同：`/chat/stream` 拒绝所有流式请求，检查在 run 创建之前，给出 `error`、`done` 两帧，走不到外层计划的请求（例如规划前就要求澄清的）也一样；`/chat` 拒绝每个走到外层计划的请求，在规划之后把 run 置为 failed，错误码 `LANGSMITH_TRACING_ENABLED`，走不到外层计划的仍然回 200。`server.js` 启动时本来就拒绝这种变量，受影响的只有绕过启动检查的进程内调用方，以及启动后环境被改动的进程。规划器的模型调用在这种变量下仍走直接路径、不拒绝（阶段 5 的理由不变）。
- `test/agent-runtime-removed.test.mjs`（15 个测试，原 9 个）对两个变量各跑一遍：取值、`startServiceRole`、真实执行 `node server.js`、`createAppServices`、执行器；新增外层计划入口在读计划之前拒绝，以及 eval runner 的文档问答、custom-Skill DAG、v3 统一图三类用例在任一变量为 `native` 时得到 `case_error`。

### 等价保护怎么保住

- 办法和阶段 6 相同：先冻结，再删除，两个提交分开。
- 冻结提交 3313b40b：四个对拍套件原来在同一进程里把每个场景跑两趟（原生循环一趟、LangGraph 一趟）并要求屏蔽后逐字节一致。在这个提交上，native 一趟把屏蔽后的结果写成 golden（`UPDATE_GRAPH_GOLDENS=1`，只有 native 一趟允许写），两趟都对照同一份 golden，LangGraph 一趟传 `write: false`。所以每个 fixture 都是原生循环的记录，并且在同一提交上被证明等于 LangGraph 的结果。新增 32 个文件：
  - `langgraph-execution-plan-graph`：24 个。10 个 trajectory 用例（另外 3 个跑 custom-Skill DAG 的用例沿用阶段 6 的 fixture，内容未变）和 14 个直接场景：research brief、弃答后走 Web（有、无常设批准）、依赖故障、阶段边界取消（两种原因）、阶段内取消、阶段内超时、一串事件之后抛错（两种原因）、交错计划（两种原因 × 运行前/文档阶段中）。每份包含响应或错误、流式客户端会收到的 agent 事件、run 的事件/step/结果/错误。
  - `langgraph-chat-stream`：5 个。线上的 SSE 字节、解析出的帧、run：完整支持的答案、含不被支持句子的答案、运行中超时、一串 trace step 之后超时、客户端离开后被取消的 run。
  - `langgraph-routes`：3 个。`POST /chat` 文档问答、`POST /chat/stream` 连同 `GET`/`POST /chat`、V1 Capability 审批（暂停、暂停的 run、批准的响应、完成的 run）。
- 删除提交之后，这些套件每个场景只在 LangGraph 上跑一次，对照 golden，屏蔽规则与删除前相同。fixture 在删除前后逐字节未变。
  - `langgraph-execution-plan-graph`：26/26。另外断言每个该走到外层计划的场景确实把计划交给了图（tap），并且剪枝确实发生。
  - `langgraph-chat-stream`：8/8。另外断言每条流经过 `streamAgentRun`、外层计划被调度一次。
  - `langgraph-routes`：8/8。阶段 6 从原生图调度器冻结的 5 份 golden 是在外层计划走原生循环、流走 native 分支时冻结的，现在外层计划和流都在 LangGraph 上，仍然逐字节一致（包括 v3 流到审批暂停的 SSE 字节）。
  - `agent-run-chat-statement-count`：10/10。原来的 `default`、`outerPlan` 两趟合成一趟；store 调用数和语句数不变（外层图没有 checkpointer）。
  - `langgraph-runtime-parity`（6/6）、`langgraph-unified-graph`（25/25）、`langgraph-unified-graph-without-run-target`（4/4）、`langgraph-planner-model`（12/12）：没有改断言，golden 都是外层计划走原生循环时冻结的，现在照样通过。
- 直接调用原生循环的套件改指同一个名字：`agent-execution-plan-runner`（13 个）断言一条没改，`runAgentExecutionPlan` 现在就是 LangGraph 入口。`agent-execution-plan-pruning`（13 个）里两个“原生对 LangGraph”的测试改为：逐个调用每个阶段体（原生循环做的事）得到的状态，等于图跑出来的状态；取消的错误码、状态码写成字面期望。
- `UPDATE_GRAPH_GOLDENS` 规则不变（阶段 6）：现在只有 LangGraph 一侧，`=1` 从它写入，写了的那次仍然失败。

### 流式实测

- 外层图把阶段里发出的 agent 事件经 `config.writer` 作为 custom chunk 送出，消费循环再交给绑定在 run 外面的 sink。担心的是事件会不会攒到节点结束才到。
- 实测（进程内，`streamAgentRun`，文档阶段的桩先发一个事件、等 300 ms、再发一个、再等 300 ms 后回答）：两个事件到达消费者的时刻比发出晚 0 ms 和 1 ms，没有攒批。answer draft 走的是同一条通道。
- SSE 字节与原生分支一致，由 `langgraph-chat-stream` 和 `langgraph-routes` 的 golden 钉住。

### 失去、且没有替代的覆盖

- 两趟互比变成对照 golden 之后，新增的场景不再有原生一侧可比：以后给外层计划加场景，只能靠字面断言，或者从 LangGraph 写新的 golden。
- 压测里的 native 对照：`--outer-plan-runtime native` 已不可用。要重现阶段 3、5 的对比，只能在删除提交之前的 checkout 上跑。
- LangSmith 变量下“原生分支照常回答文档问答”的两条断言：原生分支不存在了，改为断言去掉变量后同一个 app 照常回答。

### 怎样恢复

- `git revert` 阶段 7 的删除提交。它恢复原生循环、`getAgentOuterPlanRuntime()`、`resolveAgentExecutionPlanRunner`、路由的 native 分支、压测的 `native` 取值和各套件的 native 一趟，并去掉 `AGENT_OUTER_PLAN_RUNTIME` 的启动拒绝。冻结提交可以保留。
- 没有在途数据要处理：外层图不带 checkpointer，不写线程记录，run 的 step 和事件在两种调度下相同。

### 证据

- 改动前基线（b8e4d2ed）：`eval:trajectory` 19/19、`eval:planner -- --provider mock` 7/7、`eval:recovery-observability` 8/8，在原生循环和 `AGENT_OUTER_PLAN_RUNTIME=langgraph` 下各跑一次，屏蔽 UUID、时间戳、时长和 git 状态后逐字节一致。删除之后再跑一次，与基线同样一致。
- 删除之后逐个运行的单文件套件（Node 24.21.0）：`langgraph-execution-plan-graph` 26/26、`langgraph-chat-stream` 8/8、`langgraph-routes` 8/8、`agent-run-chat-statement-count` 10/10、`agent-execution-plan-runner` 13/13、`agent-execution-plan-pruning` 13/13、`langgraph-execution-plan-graph-isolation` 7/7、`agent-runtime-removed` 15/15、`langgraph-runtime-parity` 6/6、`langgraph-planner-model` 12/12、`langgraph-unified-graph` 25/25、`langgraph-unified-graph-without-run-target` 4/4、`langgraph-execution-graph-runtime` 43/43、`agent-cancellation` 20/20、`request-deadline-split` 4/4、`load-test` 63/63、`graph-goldens` 5/5、`chat-input-bounds` 7/7。
- 全量结果（本机 Node 24.21.0，删除之后）：
  - `coverage:gate` 接一次性 PostgreSQL 18 + pgvector（`scripts/run-pgvector-integration.sh` 起的集群，与 CI 的 `server-tests` 同一条命令）：4,585 个测试，4,578 通过、7 跳过、0 失败；全局行覆盖 92.58%，五组覆盖率门和目标都通过。跳过的 7 个需要 Redis、读副本或旧版本 checkout，与改动无关。PostgreSQL 集成套件（`agent-execution-graph-postgres.integration`、`agent-unified-graph-postgres.integration`、`langgraph-checkpointer-postgres.integration` 等）都在其中，没有跳过。
  - 不接数据库再跑一次：4,413 个测试，4,385 通过、28 跳过、0 失败。这种跑法下覆盖率清单会报 `tenant-encryption-maintenance.js` 缺失，因为唯一导入它的集成套件被跳过了；这是本机没有数据库时的既有现象，不是这次改动带来的。
  - `quality:current`：在删除提交 95ce9c2d 上按 CI 的 `quality-gate` 步骤运行（干净的独立 worktree、一次性 PostgreSQL + pgvector、五项确定性评测都由该提交生成），通过，`gate-worktree`、`quality-synthetic`、`feedback`、`trajectory`、`planner-mock`、`recovery`、`quality-baseline`、`quality-metrics` 八项检查全部 `pass`。
  - Node 版本：新增的 32 个 fixture 在 Node 24.21.0 上生成；对照 golden 的五个套件（`langgraph-execution-plan-graph`、`langgraph-chat-stream`、`langgraph-routes`、`agent-run-chat-statement-count`、`langgraph-runtime-parity`，共 58 个测试）在本机的 Node 20.20.2 下同样全部通过，fixture 里没有绝对路径、端口、主机名或 Node 版本相关的报错文本。CI 的 Node 22：推送后，main 上合并提交 89a70d0a 的 Quality Gate 运行（43413082658，2026-11-13）三个任务全部通过，其中 `server-tests` 在 Node 22.23.4 上带着新增的 32 个 fixture 跑完全量测试和覆盖率门：4,585 个测试，4,577 通过、8 跳过、0 失败，全局行覆盖 92.54%。
- 代码量（删除提交相对冻结提交 3313b40b）：生产代码（`server/rag`、`server/routes`）+204 −235 行，净减 31 行，其中大半是注释改写，真正删掉的是原生循环、选择调度器的函数、`getAgentOuterPlanRuntime()` 和路由的 native 分支；测试 +1,186 −1,330 行，净减 144 行（每个场景少了第二趟）。冻结提交另加 32 个 golden 文件，约 1.1 MB，golden 总量约 6.4 MB。这次换来的不是代码量，而是只有一个调度器、一条流式路径、少一个要测两遍的开关。

### 独立复核（2026-11-13）

冻结和删除两个提交（b8e4d2ed..95ce9c2d）交给一个只读的独立复核。结论是没有高、中级缺陷；五条低级意见的处理如下，修正都在删除提交之后的同一分支上。

- LangSmith 的拒绝范围写窄了：`streamAgentRun` 在 run 创建之前检查，所以 `/chat/stream` 拒绝的是所有流式请求，不只是走到外层计划的；`/chat` 对走不到外层计划的请求仍然回答。行为没有改（`server.js` 本来就拒绝带这种变量启动），改的是上面“拒绝已删除的取值”小节和 `AGENTS.md` 里的说法。
- 测试转换时少了一项比较：两趟对照时，三个 custom-Skill DAG 用例的执行器调用记录（`boundToRun`、`nodeIds`、`reusedNodeIds`）要求两边 `deepStrictEqual`，单趟之后只剩“非空”。现在改成字面量期望。取值在冻结提交 3313b40b 上重新跑过：原生一趟和 LangGraph 一趟记录的都是这组值。
- 七处检查点的注释只提 `AGENT_RUNTIME`，补上 `AGENT_OUTER_PLAN_RUNTIME`。两处“rollout 关着的进程不加载 LangGraph”的注释在阶段 7 之后不成立，改为：按需导入仍然让不跑 guarded 图的进程不加载图执行器和编译器，LangGraph 本身已由外层计划加载。
- `rag/config.js` 把进程内的 0.3 ms 和压测的 5.68 → 6.68 ms 写成了一句因果，现在分开写；`docs/agent-rag.md` 补上压测的数字。
- 没有做的一条：LangGraph 在第一个 agent 请求里加载（run 已创建、截止时间已开始计时），没有在启动后预热。复核用加载钩子测得 `routes/chat.js` 之后导入图模块 141 ms、720 个模块（其中 437 个来自 `@langchain/*`），与上面“代价”里的约 115 ms 是同一量级的两次测量。每个进程只付一次，没有东西因此出错；要消掉它，可以让承载 agent tier 的角色在 listen 之后后台导入 `rag/langgraph/execution-plan-graph.js`。

复核没能验证的两项：`server/.env` 按规则没有读（里面如果有 `AGENT_OUTER_PLAN_RUNTIME=native` 或拼错的值，`node server.js` 现在拒绝启动）；Node 22 上新 golden 的比较，当时等 CI，推送后已通过（见上面“证据”里的 Node 版本一条）。

修正之后重跑（提交 9b74106c，即修正提交 8f51955f 加面试材料的文档提交，本机 Node 24.21.0）：

- `coverage:gate` 接一次性 PostgreSQL 18 + pgvector：4,585 个测试，4,578 通过、7 跳过、0 失败；全局行覆盖 92.58%，五组覆盖率门和目标都通过。数字与删除提交上的那次相同（修正没有增减测试）。
- `quality:current` 按 CI 的 `quality-gate` 步骤在该提交的干净 worktree 上运行：通过，八项检查全部 `pass`。
- 受修正影响的单文件套件：`agent-runtime-removed` 15/15、`langgraph-execution-plan-graph` 26/26、`langgraph-routes` 8/8、`langgraph-chat-stream` 8/8、`service-split.e2e` 1/1。

## 阶段 8 结果：custom Skill 只走图，删除 V1 顺序链（2026-11-13）

### 决定

- 阶段 7 之后，custom Skill 阶段是 agent 里最后一处不走 LangGraph 的路径：V1 顺序链（一个接一个跑 Skill，把前面的答案拼进下一个 Skill 的问题）。它有两类入口：`AGENT_SKILL_GRAPH_ROLLOUT=off` 或 `shadow`；默认的 `guarded` 下，整张图在任何节点运行之前被拒时回落到它。
- 用户先要方案（原话：“先出方案”），看过调查结果和三个方案后选了方案 A（原话：“按方案 A 做”）：只走图；预算付不起的节点跳过；其他原因被拒时不执行任何 Skill 并逐个记录原因。
- 这结束了约束 12 的前半条（V1 顺序链和 `AGENT_SKILL_GRAPH_ROLLOUT=off` 保留到 LangGraph 成为默认后至少一个发布周期）。`guarded` 从 2026-09-25 起就是默认值，顺序链已经七周不在默认路径上。
- 删除之后没有开关能回到顺序链，要回去只能 revert（见下文“怎样恢复”）。
- 不动的部分：
  - 图怎么规划（模型的提议先校验，不合法就整张换成确定性图）、校验器的其他规则、执行器、图 checkpoint、启动恢复、replan。
  - `/chat` 的响应契约。
  - `AGENT_UNIFIED_GRAPH_ROLLOUT`（v3 统一图，默认 `off`）和三个 planner 开关。

### 删除之前的调查

回落在默认配置下基本走不到。这是选方案的依据，数字来自 main 上的 e11ced91。

- 规划分两层。模型提议的图不合法时，换成确定性图（把意图选中的 Skill 按顺序连起来）。只有确定性图也不合法，才算整张被拒。原因只有四种：

| 原因 | 顺序链当时做什么 | 默认配置下生产里会不会发生 |
| --- | --- | --- |
| 意图没选任何 custom Skill，模型的提议又不合法 | 空跑，返回空结果 | 会，但链什么都没做 |
| 预算不够付选中的 Skill（`budget_exceeded`） | 按顺序跑付得起的，其余记为因预算跳过 | 调用次数：不会。每个意图最多选 2 个 custom Skill，预算正好 2 次，只能在代码里调低。运行的 token、费用、时间上限用完：少见，此时一个 Skill 都不跑 |
| 选中的 Skill 不在本次请求的授权目录里（`unregistered_capability`） | 照跑 | 不会。`/chat` 进 agent 之前用同一个 `getDocument` 查询核实过每个文档，四个 custom Skill 都声明了类型契约 |
| 超过图的规模上限（深度 5、节点 12） | 照跑 | 不会，最多 2 个节点 |

- 实测：在临时 worktree 里给这个阶段加记录点，跑全量测试和三个确定性 agent 评测，阶段共被进入 188 次。
  - 133 次走图；27 次是显式的 `off`；12 次是 `shadow`；1 次检查点重放；1 次无 Skill 空跑。
  - 14 次是被拒后回落，全部在测试里：1 个专门测预算回落，1 个是空跑，12 个是因为测试用的假 RAG 服务没有 `getDocument`，授权目录为空。
  - 三个评测里被拒回落 0 次。

### 被拒之后怎么办

- **预算付不起全部选中的 Skill。** 确定性图在规划时不再按调用预算整张拒绝（`createAgentExecutionGraphResult` 里校验确定性图时不传 `budgetRemaining`，一行）。图照常执行，执行器本来就在每个节点启动时预留预算，付不起的节点记为跳过。顺序链当年是按 Skill 逐个扣预算，效果相同。模型提议的图仍然按预算整张校验：它自己决定了要规划什么，只执行预算碰巧够得着的那一部分不是它的提议。
- **其他原因被拒。** 不执行任何 Skill。每个选中的 Skill 得到一条失败结果，写明校验器给的原因（错误码 `AGENT_SKILL_GRAPH_REJECTED`）；trace 里有一条 `skill_graph_rejected` 步骤说明这个阶段为什么什么都没做（run 里存成一条 `decision` 类、`skipped` 的步骤）；请求继续往下走。
- **没有 Skill 产出时请求怎么回答。** 选中两个 Skill 的请求（`skill_chain`）走最终核查，以“证据不足”弃答。只选中一个 Skill 的请求不走最终核查，回答是固定的一句 “The custom skill could not complete the request.”，`ragAnswer` 为空。这两种回答都是原有的，不是这次新加的。
- **没选 Skill、提议又不可用。** 返回空结果，和以前一样；永远不会把整个授权目录都跑一遍作为替代。
- 图事件里的 `mode` 仍然写 `guarded`，`fallback` 仍然存在、从此总是 `null`：已存的 run、回放守卫和报告都读这两个字段。

### 用户看到的差别

冻结提交 2c1c6c06 把顺序链在这些情形下的回答逐字写进了 `test/agent-custom-skill-budget.test.mjs`（合同审查请求，选中“总结合同”和“风险审查”两个 Skill，默认注册表和规划器）。删除提交改的就是这些期望：

| 情形 | 答案 | 记录 |
| --- | --- | --- |
| 默认预算（2 次） | 不变。冻结提交上链和图的响应逐字段相同 | 不变 |
| 预算 1 次 | 不变：第一个 Skill 的答案、1 条引用、同样的 trace 步骤类型 | 被跳过的 Skill 没有结果，不再出现在 `agentSkills` 里（链把它列为 failed）；预算提示多了“needed 1”；图事件从“被拒、回落 v1”变成“已执行、partial” |
| 预算 0 次 | 不变：“证据不足”的弃答 | 预算提示从 2 条变 1 条（第二个节点是因为它依赖的节点没跑而跳过，没有单独提示）；`agentSkills` 为空 |
| 阶段无法核实文档（假 RAG 服务没有 `getDocument`） | **变了**：从链跑出的两段答案变成弃答 | 两个 Skill 列为 failed，trace 多一条 `skill_graph_rejected`，没有 `custom_skill` 步骤 |
| 第一个 Skill 失败 | 默认路径不变：第二个 Skill 不运行，弃答。只有 `off` 下的链不同：它照样跑第二个 Skill 并用它的结果回答 | 不变（第二个节点 `skipped: dependency_failed`） |

- “无法核实文档”一行在 `/chat` 上走不到（见上表）。受影响的是直接调用 `runAgentRag`、又不提供文档查询的调用方，仓库里只有测试。
- “第一个 Skill 失败”一行是独立复核指出的（冻结提交没有钉住它，删除之后才补进测试）。确定性图里后一个节点绑定前一个节点的结果，所以依赖它；执行器对依赖失败或被跳过的节点一律跳过，不管 `failurePolicy`。链没有这种依赖，前一个失败后照样用原问题跑后一个。图成为默认（2026-09-25）之后默认路径一直是前一种表现，这次没有改它；改掉的是“设成 `off` 就能得到后一种”这条路。在删除之前的提交 e11ced91 上实测：`off` 下链调用了两次 Skill、以第二个 Skill 的结果回答；默认配置下图调用一次、弃答。
- 同一组请求在只选中一个 Skill 时的结果也钉在同一个测试文件里：预算 0 次时回答不变（固定的那一句），记录的差别和两个 Skill 时相同；无法核实文档时回答从链跑出的结果变成固定的那一句。
- 运行上限（token、费用、时间）用完的情形，删除之前的表现随时机在两种形态之间变化：规划时已经用完，是“被拒、回落、每个 Skill 一条提示”；规划之后才用完，是“图执行、节点在启动时跳过”。现在只剩后一种。

### 拒绝已删除的取值

- `assertAgentRuntimeSupported(env)` 现在检查三个变量，各有错误码。新增的是 `AGENT_SKILL_GRAPH_ROLLOUT`（`AGENT_SKILL_GRAPH_ROLLOUT_REMOVED`）。
  - 照常启动：未设置、空串、纯空白、`guarded`（去首尾空白，大小写不限）。
  - `off`、`shadow`：拒绝，“AGENT_SKILL_GRAPH_ROLLOUT=off was removed (ADR 0001 phase 8): custom Skills always run as a typed graph on LangGraph. Unset AGENT_SKILL_GRAPH_ROLLOUT or set it to guarded.”
  - 其他值（如 `gaurded`）：同样拒绝，信息里带原值。
- 行为变化：阶段 8 之前，这个变量拼错的值静默落到 `off`，也就是顺序链。现在拼错即拒绝启动。`server/.env` 里如果显式写了 `off`、`shadow` 或拼错的值，要先改掉。
- 检查位置和阶段 7 相同（`server.js`、`startServiceRole`、`createAppServices`、外层计划入口、custom-Skill stage、v3 的入口与 stage、执行器），所以不建 app、直接调 `runAgentRag` 的 eval runner 在环境里有这种取值时也以 `case_error` 失败。
- `rag/config.js` 的 `getAgentSkillGraphRollout()` 已删除。两个 workflow（`release-evidence.yml`、`planner-real-gate.yml`）和几个评测脚本仍然设置 `AGENT_SKILL_GRAPH_ROLLOUT=guarded`，这是唯一还接受的取值，没有改。
- `evaluation/rollout-readiness-report.js` 的 “custom Skill DAG 处于 guarded” 一项保留，改为直接读这个变量：环境里是别的值时进程根本起不来，这样的环境生成的报告不应该显示就绪。
- `test/agent-runtime-removed.test.mjs`（19 个测试，原 15 个）对三个变量各跑一遍。

### 删了什么

- `rag/agent-custom-skill-runner.js`（`runCustomSkills`，173 行）和 `rag/agent-planner.js` 的 `buildChainedSkillQuestion`。
- `rag/agent-custom-skill-stage.js`：`off`、`shadow` 两条路径、`runV1`、被拒后的回落、`mode` 参数和 `CUSTOM_SKILL_STAGE_MODES`。601 → 587 行（少掉的代码被新的“未执行”记录和注释抵掉大半）。
- `rag/agent.js`、`rag/agent-execution-plan-runner.js`：`skillGraphMode` 的传递。授权目录不再因为 `off` 而置空。
- `rag/config.js`：`getAgentSkillGraphRollout()`。
- 评测：trajectory 的 `custom_skill_retry`、`skill_graph_shadow_comparison` 两个场景和空出来的 `retry` 分类；`unified_graph_evidence_gated_skill_hand_off` 里 V1 对照的 `off` 那一半。
- 测试：阶段测试里只测 `off`、`shadow` 的 8 个测试（另有 4 个改写成现在的行为，新增 9 个，套件从 23 个变成 24 个），`runCustomSkills` 的 1 个测试，`config.test.mjs` 里两个取值测试；两个 golden 文件（`custom_skill_retry.json`、`skill_graph_shadow_comparison.json`）。

### 保留什么

- 确定性图 `createDeterministicExecutionGraph`：它规划的就是顺序链当年跑的那些 Skill、同样的顺序，现在是唯一的回落。它和链不等价：有节点没跑成时，后面依赖它的节点也不跑（见“用户看到的差别”和“失去”）。
- 单步重试和启动恢复里处理 `custom_skill` 步骤的处理器（`agent-run-step-handlers/custom-research-steps.js`）。新的 run 不再产生这种不带 `nodeId` 的步骤，处理器只对阶段 8 之前存下来的 run 有用。要不要删，没有在这一阶段决定（**阶段 9 删除了，下面三条随之解决，见“阶段 9 结果”**）。留着它意味着三件事：
  - 它是剩下的唯一一条不经 LangGraph、也不经授权目录执行 custom Skill 的路径，只有旧 run 走得到。
  - 回放矩阵仍然把 `custom_skill` 标成可以自动重放、可以重试，所以恢复接口和界面对图 run 里失败的 Skill 节点仍然给出“重试失败步骤”，点了一定是 409。图成为默认之后就是这样，这次没有改。
  - `eval:recovery-observability` 和发布门里“步骤级自动重放”“手动 resume”两项信号，用的是手写的、不带 `nodeId` 的 `custom_skill` 步骤。现在的代码不再产生这种步骤，这两项信号证明的只是旧 run 还能恢复。
- 合成和响应构建里按 `customSkillGraphExecuted` 分的两条分支。图没执行的那一支现在只在“被拒、没有 Skill 运行”和“根本没有 custom Skill”时走到。
- 场景 id、标签和描述里的 “guarded” 字样（如 `skill_graph_guarded_execution`）：`guarded` 是唯一还接受的取值，也是每个图事件记录的 mode，阶段 6 冻结的 golden 里也是这些字样。

### 评测套件的改动

本 ADR 的“明确不做”里有一条：不改任何评测语料、基线、阈值来让迁移“通过”。这一阶段删了两个 trajectory 场景，原因和范围如下，不属于放宽门槛。

- `custom_skill_retry`：把开关设成 `off`，让顺序链的一个步骤失败，再从 run 里单独重试它。顺序链删除后这个场景跑不起来；图运行的步骤拒绝单独重试（`AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY`，409），这一点由 `agent-run-step-executor`、`agent-execution-graph-checkpoint` 的单元测试钉住，失败节点的记录由 `agent-primary-run-persistence` 钉住。
- `skill_graph_shadow_comparison`：`shadow` 模式本身不存在了。
- 数量：19 个场景、84 项检查变成 17 个、76 项（减去的是这两个场景的 4 + 4 项）。其余 17 个场景的检查项一条没动；`quality-current-suite-manifest.js` 里只删了这两个场景的条目，并把统一图场景的 V1 对照从 4 次改成 2 次。阈值没有改。
- 没有新增场景来替代它们。

### 失去、且没有替代的能力和覆盖

- **手动重试某个失败的 custom Skill 步骤。** 只有顺序链的步骤支持。默认走图是 2026-09-25 起的事，所以默认配置下这个能力已经七周不可用；现在彻底没有。图里的替代是有限 replan，只在模型规划器是主规划器时存在；确定性规划器下，失败的节点留下 partial 的图，没有重试。
- **`shadow` 对照**：让顺序链回答、同时旁路规划一张图来比较。规划器自己的 shadow（`AGENT_PLANNER_ROLLOUT=shadow`，确定性图为主、模型在旁边规划）不受影响。
- **链和 DAG 的并排对照**：统一图场景里 V1 外层计划原来在两种 custom Skill 执行方式下各跑一遍，数字相同；现在只有 DAG 一种。
- **没有类型契约的 custom Skill**：以前靠顺序链照跑，现在不会运行，trace 里写 `no legal execution graph (unregistered_capability)`。注册时不拒绝这样的 Skill，是运行时才报。仓库里的四个 custom Skill 都有契约。
- **前一个 Skill 失败后照样跑后一个**：只有链这样做。图里后一个节点依赖前一个，前一个失败它就被跳过。默认路径七周以来一直是图的表现；能用 `off` 换回链的表现，这一点现在没有了。

### 升级时已存的 run

- 顺序链留下的 run（`off`、`shadow` 或回落时创建的）：它们的 `custom_skill` 步骤没有 `nodeId`，没有图 checkpoint。启动恢复和单步重试仍然用保留下来的处理器处理它们，行为不变。（阶段 9 起不再如此：处理器删除，这些步骤转人工或不可重试。）
- 历史事件里的 `fallback: "v1"` 和 `mode: "shadow"`：报告照旧读取和统计；回放守卫只认 `mode: "guarded"`、`fallback: null`、`executed: true` 的事件，和以前一样。
- 图运行的 run：没有变化。
- 一种没有验证的情形：顺序链创建、停在审批门上的 run，升级之后再被批准并重新进入。重新进入时 custom Skill 阶段会按图重新规划，而确定性图的节点 step id（`custom_skill:<skillId>`）和链当年写下的 step id 相同；按代码读下来，节点启动会因为同名 step 已经存在而以 `AGENT_GRAPH_EXECUTION_FENCED` 失败，请求报错、run 留在原状态，需要重新发起请求。这条路径没有端到端跑过。只有升级那一刻恰好有这样的 run（环境里设过 `off` 或 `shadow`）才会遇到。

### 怎样恢复

- `git revert` 删除提交 3b3a8719。它恢复 `runCustomSkills`、`buildChainedSkillQuestion`、阶段的 `off`、`shadow` 和回落、`getAgentSkillGraphRollout()`、两个 trajectory 场景和它们的 golden，并去掉 `AGENT_SKILL_GRAPH_ROLLOUT` 的启动拒绝。冻结提交可以保留。
- 没有数据要处理：图 checkpoint 的格式没有变。

### 证据

（以下是复核之前、在 9c3c3de8 上的结果。复核修正之后重跑的结果在“独立复核”小节末尾。）

- 提交：冻结 2c1c6c06，删除 3b3a8719，清单版本 9c3c3de8（`quality-current-suite-manifest.js` 1.15.0 → 1.16.0；删场景时就该一起升，补在了后一个提交里）。下面的结果都在 9c3c3de8 上，本机 Node 24.21.0。
- 三个确定性 agent 评测，改动前（e11ced91）和改动后各在一个干净的 worktree 里跑一次，屏蔽 UUID、时间戳、时长和 git 状态后比较：
  - `eval:planner -- --provider mock`（7/7）、`eval:recovery-observability`（8/8）：逐字节一致。
  - `eval:trajectory`：19/19（84 项检查）变成 17/17（76 项）。除了删掉的两个场景，17 个共有场景里 16 个逐字节一致；`unified_graph_evidence_gated_skill_hand_off` 只在 V1 对照处不同（4 次变 2 次，去掉 `skillGraphRollout` 字段，对应检查项的标签改了）。
- 全量结果：
  - `coverage:gate` 接一次性 PostgreSQL 18 + pgvector（与 CI 的 `server-tests` 同一条命令，干净 worktree）：4,595 个测试，4,588 通过、7 跳过、0 失败；全局行覆盖 92.54%（阶段 7 是 92.58%），五组覆盖率门和目标都通过。`agent-custom-skill-stage.js` 行覆盖 100%。跳过的 7 个需要 Redis、读副本或旧版本 checkout，与改动无关。
  - 不接数据库（3b3a8719 的内容）：4,423 个测试，4,395 通过、28 跳过、0 失败。
  - `quality:current` 按 CI 的 `quality-gate` 步骤运行（干净 worktree、一次性 PostgreSQL + pgvector、五项确定性评测都由该提交生成）：通过，`gate-worktree`、`quality-synthetic`、`feedback`、`trajectory`、`planner-mock`、`recovery`、`quality-baseline`、`quality-metrics` 八项检查全部 `pass`。
- 单文件套件：`agent-custom-skill-stage` 24/24、`agent-custom-skill-budget` 5/5、`agent-dag-planner-adapter` 40/40、`agent-runtime-removed` 19/19（其中一条真实执行 `node server.js`，在三个变量的已删除取值下都以非零退出）、`agent-execution-plan-runner` 13/13、`langgraph-runtime-parity` 5/5（原 6，少了 shadow 场景）、`langgraph-execution-plan-graph` 25/25（原 26，少了 `custom_skill_retry`）、`langgraph-unified-graph` 25/25。
- golden：删除 2 个文件；改写 1 个（`langgraph-unified-graph/trajectory-unified-graph-evidence-gated-skill-hand-off.json`，只有 V1 对照的 4 → 2 次和检查项标签，原因写在 `test/langgraph-unified-graph.test.mjs` 的注释里）；其余阶段 6、7 冻结的 fixture 逐字节未变。
- 代码量（3b3a8719 相对冻结提交）：`server/rag` +217 −404 行；`server/evaluation` +70 −497 行；测试（不含 fixture）+878 −582 行，fixture −1,956 行。冻结提交另加 386 行测试。
- CI 的 Node 22：写这一节时还没跑（本机只有 Node 20 和 24）。合并进 main 之后，合并提交 7fbf8974 的 Quality Gate 运行（43517749419，2026-11-13）三个任务全部通过，其中 `server-tests` 在 Node 22.23.4 上跑完全量测试和覆盖率门：4,598 个测试，4,590 通过、8 跳过、0 失败，全局行覆盖 92.53%。
- 没有验证的：
  - 真实模型下的答案质量。顺序链和图告诉第二个 Skill 上游结果的方式不同，但默认路径七周以来就是图，这不是新变化。
  - 真实流量。这里没有线上数据，“默认配置下生产里走不到”是从代码和默认配置推出来的，加上上面的记录点统计。
  - `server/.env` 按规则没有读。里面如果有 `AGENT_SKILL_GRAPH_ROLLOUT=off`、`shadow` 或拼错的值，`node server.js` 现在拒绝启动。

### 独立复核（2026-11-13）

冻结、删除、清单版本三个提交（e11ced91..9c3c3de8）和当时的文档交给一个只读的独立复核（不运行测试和评测）。结论是没有高、中级缺陷，默认配置下经 `/chat` 的请求没有哪一种比改动前更差；七条低级意见处理如下。

- **确定性图不是“链的图版本”**（处理了说法，没有改行为）。第一个 Skill 失败时，图跳过依赖它的第二个节点，链会照样跑第二个。这不是这次改出来的（默认路径一直如此），但代码注释和本节原来写的是“它就是顺序链的图版本”“`continue` 就是链的做法”，说过头了。现在注释和文档都写明差别，“失去”里加了一条，`agent-custom-skill-budget` 加了一个测试把它钉住，并在 e11ced91 上实测了链当时的表现。
- **预算跳过的确定性图会走进 replan 循环**（没有改，记录在案）。模型规划器开着、调用预算又被调低时，图在规划时不再被拒，于是执行之后会问一次 replanner，再因为预算不够而放弃，白花一次模型调用；选中三个以上 Skill、预算只够一个时，一个只去掉未执行节点的补丁还可能被接受，图事件就以 `completed` 结束、被跳过的 Skill 从 `graph.nodeIds` 里消失。默认配置走不到（每个意图最多两个 Skill、预算两次；运行上限用完时所有预算键归零，不会调用 replanner）。replanner 判断“还有没有预算”时看的是所有预算键而不是这张图用的那几个，这是原有的宽松，正常路径上也会白问一次。
- **恢复接口和界面仍然给图 run 里失败的 Skill 节点提供“重试失败步骤”，而它一定返回 409**（没有改，写进了“保留什么”）。
- **恢复评测和发布门里的步骤级信号只对旧 run 有意义**（没有改，写进了“保留什么”）。
- **`docs/agent-rag.md` 把“默认配置下基本走不到”说成了表里的后两行**，其实是前两行；第三行（没选 Skill、提议不可用）在模型规划器下会发生。已改。
- **遗留**：七处检查点的注释只提两个已删除的开关，补上第三个；`authorized-catalog.js` 说目录是“custom Skill 运行的唯一途径”，改成“请求运行 custom Skill 的唯一途径”，并写明旧 run 的单步处理器是例外；一个评测脚本和两个测试文件还在给阶段传已经不存在的 `mode: "guarded"`，删掉。前端 trace 详情里的 “Chain mode” 一行没有动：它只在旧 trace 带这个字段时显示。
- **测试缺口**：`skill_graph_rejected` 归为 `decision` 没有测试钉住，现在钉在 `agent-custom-skill-budget` 里；预算跳过的测试原来只从预算提示推断跳过原因，现在直接断言节点的 `reason`（`budget_exhausted`、`dependency_skipped`）；只选中一个 Skill 的请求走另一条收尾分支（固定的一句而不是弃答），原来没有覆盖，加了两个测试，本节“弃答”的说法也限定到了两个 Skill 的请求；阶段测试里“在加载执行器之前拒绝”的说法在那个测试里观察不到，改成它实际断言的内容（不读写 checkpoint、不规划、不执行）。没有做的一条：图被整张拒绝现在意味着“选中的 Skill 没有运行”，报告里没有单独的计数，只能从“规划数减执行数”看出来。

复核没能验证的：需要执行才能确认的部分（它只读代码，加上四个纯函数的探针）；`server/.env`；上面“升级时已存的 run”里那条重新进入的路径。

另外在核对预算规则时发现一处与这次改动无关的旧问题，没有改：`AGENT_PLANNER_ROLLOUT=deterministic` 或 `shadow` 时，custom Skill 图的规划记录总是写成“fallback”，原因是 “DAG planner response must contain a non-empty nodes array.”。包了一层灰度信息的确定性规划器被当成主规划器，拿到的是脱敏后的上下文，里面没有选中的 Skill，先产出一张空图，再回落到真正的确定性图。执行结果是对的，记录不对。e11ced91 上同样如此。

修正之后重跑（复核修正提交，本机 Node 24.21.0）：

- `coverage:gate` 接一次性 PostgreSQL 18 + pgvector（341ad5f3 的干净 worktree）：4,598 个测试，4,591 通过、7 跳过、0 失败；全局行覆盖 92.55%，五组覆盖率门和目标都通过。比复核之前多 3 个测试（`agent-custom-skill-budget` 从 5 个变成 8 个）。PostgreSQL 集成套件（其中 `agent-execution-graph-postgres.integration` 去掉了两处无效参数）都在里面，没有跳过。
- `quality:current` 按 CI 的 `quality-gate` 步骤在该提交的干净 worktree 上运行：通过，八项检查全部 `pass`。
- 三个确定性 agent 评测与 e11ced91 的比较：和复核之前相同（planner-mock、recovery-observability 逐字节一致；trajectory 17 个共有场景里 16 个一致，另一个只差 V1 对照）。
- 受修正影响的单文件套件：`agent-custom-skill-budget` 8/8、`agent-custom-skill-stage` 24/24、`agent-execution-graph-checkpoint` 32/32。
- 不接数据库的全量：4,426 个测试，4,398 通过、28 跳过、0 失败。

## 阶段 9 结果：custom Skill 步骤不再单独重放（2026-11-13）

### 决定

阶段 8 把“只有旧 run 才走得到的重试和恢复代码”留了下来，并问了用户要不要删。用户的回答是“接着清理”。这一阶段删掉它们，规则变成四条：

1. custom Skill 只作为图节点运行。`custom_skill` 步骤不能单独重试，启动时也不单独重放。
2. 启动恢复在 `auto` 模式下自己只做一件事：续跑中断的图（要先领到 claim）。其余中断的 run 都交给人。
3. 人在恢复面板上能做的只有两件事：重试失败步骤（`retry_failed_step`）和取消（`cancel`）。`resume_from_step` 不再是一个动作。
4. “重试失败步骤”只在回放矩阵允许这类步骤重试时才给出。

### 为什么这些代码只有旧 run 走得到

- 独立处理器只接不带 `nodeId` 的 `custom_skill` 步骤：带 `nodeId` 的会先被回放守卫拒绝（`AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY`）。图节点写步骤时一定带 `nodeId`（`agent-execution-graph-node.js` 的 `persistedInput`），所以不带的只有已删除的顺序链写得出来。
- 回放矩阵里“可自动重放”的步骤类型只有 `custom_skill` 一个。启动恢复的单步重放分支和恢复面板的 `resume_from_step` 都只在矩阵允许时才调用 `resumeStep`，所以它们的入口也只有旧链的步骤。
- `resumeStep` 自己不看类型：它能恢复任何有处理器的步骤（原来有一条测试用它恢复一个 pending 的 `document_rag` 步骤）。但除了上面两处，没有别的调用方，路由上也没有。

这是从代码读出来的，没有线上数据。

### 行为的变化

冻结提交 7a2e3d99 用真实的 run store、step executor、启动恢复和恢复动作服务，把下面每种情形当时的行为写成字面期望（`server/test/agent-skill-step-replay.test.mjs`，10 个测试）；删除提交 be353b62 对这个文件的改动就是下表“现在”一列。“旧链形状的步骤”指不带 `nodeId`、run 上没有图 checkpoint 的 `custom_skill` 步骤。

| 情形 | 之前 | 现在 |
| --- | --- | --- |
| 启动恢复（auto），旧链形状的步骤中断 | 单独重跑这个 Skill，run 以它一个的答案完成 | 交给人：`waiting_for_user`，原因 `graph_node_step`，步骤原样不动，只能取消 |
| 启动恢复（auto），图节点的步骤中断、run 上没有 checkpoint | 每次启动都尝试单独重放，被守卫拒绝，记一条 `auto_recovery_failed`；run 一直是 `running`，不进恢复列表 | 第一次启动交给人，之后的启动不再动它 |
| 恢复面板，等待人工的 run 里有旧链形状的 paused 步骤 | 给出 “Resume step”，点了就单独跑这个 Skill | 只有 “Cancel”；`resume_from_step` 返回 400 |
| 恢复面板，失败的旧链形状的步骤 | 给出 “Retry failed step”，点了就单独跑这个 Skill | 不给，run 不进恢复列表；重试路由返回 409 `AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY` |
| 恢复面板，失败的图节点步骤 | 给出 “Retry failed step”，点了一定是 409 | 不给 |
| 失败的 `document_rag` 步骤 | 可以手动重试 | 不变 |
| 中断的 `web_search` 步骤 | 交给人，原因 `requires_approval` | 不变 |

第二行和第五行是顺带修掉的两处：前者是一个没人接手的死循环（每次启动失败一次，run 永远停在 `running`），后者是阶段 8 复核记下的“点了必 409 的按钮”。

### 删了什么

- `createCustomSkillStepExecutor`、`createCustomSkillStepHandler` 和它们的输入解析（`agent-run-step-handlers/custom-research-steps.js`，文件改名为 `research-steps.js`，里面只剩研究子问题的重试）；`app-services.js` 里的接线。
- `agentRunStepExecutor.resumeStep`。step executor 现在只有 `applyApprovalAction` 和 `retryStep`。
- 启动恢复里的单步重放：`runAutoRecovery`、`findAutoRecoverableStep`、`safeAutoRecoveryStepTypes` 和 `agentRunStepExecutor` 两个参数、恢复记录里的 `stepId` / `stepType`。启动恢复服务不再持有 step executor。
- 恢复动作 `resume_from_step`。
- 回放矩阵里的“可自动重放”一列（`autoReplaySafe`、`getAutoReplaySafeStepTypes`、`isAutoReplaySafeStepType`）、评估结果里的 `canAutoReplay` / `configuredAutoReplaySafe`，以及没有策略再用的两个幂等类别（`read_only_rag`、`read_only_deterministic`）。恢复接口、admin 的恢复扫描和前端跟着去掉 `canAutoReplay`。
- 前端：“Resume step” 按钮和提示语，“Auto replay allowed / blocked” 一行（改成直接显示原因码），trace 详情里的 “Chain mode” 一行（服务端早已不写这个字段）。
- 评测：见“评测套件的改动”。
- 测试：见“证据”。

### 改了什么

- 回放矩阵（`agent-run-step-replay-safety.js`）：`custom_skill` 的 `replayActions` 为空、`retryable: false`，幂等类别 `graph_owned`，原因码 `graph_node_step`。新增 `isStepRetryAllowed(stepType)`，恢复面板给不给“重试失败步骤”读它；没有策略的类型（如 v3 的 `graph_node`）没有处理器，同样不给。
- 回放守卫（`agent-run-graph-replay-guard.js`）：凡是 `custom_skill` 步骤一律拒绝，不再看有没有 `nodeId`。原来靠 checkpoint 里的节点 id 去认“没带 `nodeId` 的图节点”的那段分支因此走不到，删了。守卫在 step executor 的预检和 run store 的 CAS 里都生效，所以直接调 `agentRunService.retryStep` / `updateRunStep` 也改不了这类步骤。
- 启动恢复（`agent-run-recovery.js`）：没有图可续的 run 直接交给人，原因由 `explainInterruptedRun` 给出（有待审批项是 `pending_approval_gate`，否则是第一个中断步骤的第一个原因码，没有中断步骤是 `no_safe_recoverable_step`）。对非 `custom_skill` 的步骤，原因和以前一样。
- 步骤持久化的 Skill 契约（`effects`、`replaySafe`）继续进原因码，只是不再决定“能不能自动重放”。`unsafe_by_policy` 现在只表示“这个 Skill 自己声明不能重放”。

### 保留什么

- 外层计划步骤（`document_rag`、`follow_up_retrieval`、`research_question`、`web_search`、`arxiv_import`、`capability_call`）的手动重试，以及审批放行后执行 capability 步骤。它们不是 custom Skill，当前的 run 用得到。
- 启动恢复 trace 和发布门里 `autoReplay*` 这组名字。名字没改（存量 trace、报告和前端都读它），含义变成“自动续跑中断的图”，因为启动恢复不再重放别的东西。前端这一项的标签从 “Auto replay” 改成 “Auto recovery”。
- connector 清单自己的 `replaySafety.autoReplaySafe`。那是另一套 schema，声明为 `true` 会被拒绝，和步骤矩阵无关。
- 报告里图回落的两个计数和 `graph_fallback_after_execution_zero`。它们是“必须为 0”的守卫。
- 合成和响应构建里按 `customSkillGraphExecuted` 分的两条分支。阶段 8 的遗留清单曾把它们算作“旧链专属”，这次读下来不是：没执行图的那一支服务于所有不含 custom Skill 的请求，以及整图被拒的请求，所以没有动。

### 评测套件的改动

和阶段 8 一样，这不属于为了“通过”而放宽门槛：去掉的是随功能一起消失的检查。

- `eval:recovery-observability`：8 个场景不变，检查项 29 → 27。去掉 `resume_after_partial_step_recorded`（要求出现过一次手动 `resume_from_step`）和 `resume_step_recorded`（要求出现过一次单步 resume）。报告版本 1.1.0 → 1.2.0，报告里不再有 `stepResumeCount`。
- 启动恢复的造数：原来是两个旧链形状的步骤被自动重放、一个 web search 转人工；现在是一个旧链形状的步骤和一个 web search，构建函数先断言两个都转了人工、步骤和事件没有被动过，再产出事件。手动动作的造数去掉了 `resume_from_step` 那一个 run。
- “自动恢复尝试过、成功率 100%、失败 0” 这三项检查原来由旧链形状的步骤喂数，现在只由图启动续跑探针（`skill_graph_startup_resume` 用的同一次运行）喂数：实际数值是可恢复的 run 4 → 3、转人工 1 → 2、手动动作 3 → 2、自动恢复尝试 3 → 1（成功率仍是 1）。
- 发布门（`quality-recovery-gate.js`）：去掉 `recoveryStepResumeCount ≥ 1`。其余阈值没动。
- `quality-current-suite-manifest.js`：删去这两个检查项，版本 1.16.0 → 1.17.0。
- 三个 trajectory 场景文件里早已不用的两行 import 一并删掉（阶段 8 删 `custom_skill_retry` 时留下的）；trajectory 的场景和检查项没有变化。

### 失去的

- 旧链留下的 run 的单步恢复和单步重试（见上表前四行）。这些 run 只有在设过 `AGENT_SKILL_GRAPH_ROLLOUT=off` 或 `shadow`、或者整图被拒回落到链的时候才会产生。
- `resumeStep` 这项通用能力（恢复一个 pending 的、有处理器的步骤）。它没有别的调用方。
- 存量 trace 里的 `resume_step` / `resume_from_step` 事件不再有单独的计数。报告仍把它们计入事件总数，失败的计入重放失败数，手动动作按动作名进 `actionCounts`。

### 升级时已存的 run

- 旧链的 run：中断的转人工、只能取消；失败的不能单步重试。要得到答案，重新提问。
- 存量恢复记录里可能有 `reason: "safe_step_ready"` 和 `stepId`（旧的自动重放写的）：接口照原样返回，前端照原样显示。
- 图运行的 run：整图恢复没有变化。区别只在恢复面板：失败的 Skill 节点不再有重试按钮；没有 checkpoint 的中断节点现在会进恢复列表。
- 没有数据迁移，run 和 checkpoint 的格式没有变。

### 怎样恢复

`git revert` 删除提交 be353b62。冻结提交可以保留（revert 之后它的期望要一起回到冻结时的样子，revert 会带回去）。

### 证据

（以下是独立复核之前、在 be353b62 上的结果，本机 Node 24.21.0。）

- 提交：冻结 7a2e3d99，删除 be353b62。
- 三个确定性 agent 评测，改动前（a26eecd7）和改动后各在一个干净的 worktree 里跑一次，屏蔽 UUID、时间戳、时长和 git 状态后比较：
  - `eval:planner -- --provider mock`（7/7）：逐字节一致。
  - `eval:trajectory`（17/17，76 项检查）：17 个场景全部逐字节一致。
  - `eval:recovery-observability`（8/8）：有 51 处差异，都在上面“评测套件的改动”列出的范围内（版本、检查项 29 → 27、四个计数、去掉的造数和它们的事件）。
- 全量：
  - `coverage:gate` 接一次性 PostgreSQL 18 + pgvector（与 CI 的 `server-tests` 同一条命令，干净 worktree）：4,604 个测试，4,597 通过、7 跳过、0 失败；全局行覆盖 92.52%，覆盖率门和目标都通过。阶段 8 是 4,598 个：冻结文件加 10 个，另外净减 4 个。
  - 不接数据库：4,432 个测试，4,404 通过、28 跳过、0 失败。
  - `quality:current` 按 CI 的 `quality-gate` 步骤运行（干净 worktree、一次性 PostgreSQL + pgvector、五项确定性评测都由该提交生成）：通过，八项检查全部 `pass`。
  - 前端（`vitest run`）：27 个文件、238 个测试全部通过。
- 单文件套件：`agent-skill-step-replay` 10/10、`agent-run-recovery` 17/17、`agent-run-recovery-actions` 7/7、`agent-run-step-executor` 22/22（原 26：四个旧链处理器的测试并成一个“任何形状的 `custom_skill` 步骤都被拒绝”，去掉两个 `resumeStep` 的测试，加一个“executor 没有 resume”）、`agent-run-step-replay-safety` 8/8、`recovery-observability-eval` 9/9、`postgres-agent-run-store` 29/29、`langgraph-runtime-parity` 5/5。
- golden：改写 1 个（`langgraph-runtime-parity/recovery_observability_skill_graph_signal.json`）。逐项比对过：报告里变的只有上面列的那些字段，事件从 37 条变成 33 条（少的是被删造数的事件），其中 17 条图事件逐字节未变。其余 golden 未动。
- 代码量（be353b62 相对 a26eecd7，含冻结提交）：`server/rag` +168 −623 行；`server/evaluation` +82 −137 行；测试（不含 fixture）+1,201 −841 行，其中冻结文件 654 行；fixture +57 −394 行；前端 +24 −49 行。
- 没有验证的：
  - CI 的 Node 22（本机只有 Node 20 和 24）。合并进 main 之后才有。
  - 真实浏览器里的恢复面板。前端只跑了组件测试，没有起应用看。
  - 真实 PostgreSQL 上的旧链 run。`postgres-agent-run-store` 用的是假的 pg 客户端；本机和 CI 的数据库里也没有这种存量 run。
  - `server/.env` 按规则没有读。

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

**代码量不会自动变少。** spike 的 runner 有 2,143 行，原生 `agent-execution-graph-runner.js` 是 1,055 行。原因是 runner 自己实现了准入、复用、恢复检查、审批门绑定、取消桥接、并发闸门，还要绕开 LangGraph 的两个并发缺陷。阶段 2 要复用原生模块（调用导出的恢复检查、审批 preflight），不能复制。删掉原生图调度器 `runExecutionGraph` 后（阶段 6 已删，提前结束了回退窗口；外层原生循环不在删除之列），再用行数和测试数衡量维护面有没有真的缩小，数字见“阶段 6 结果”的证据。如果到阶段 3 结束仍明显变大，应回到这里重新评估方案 A。

## 回退

- 阶段 2、3：`AGENT_RUNTIME` 默认 `native`，LangGraph 路径只在显式打开时运行。
- 阶段 4、5：`AGENT_RUNTIME=native` 作为整体回退保留。
- 阶段 6 起：没有运行时回退开关。
  - 用户豁免了约束 12 的回退窗口，原生图调度器和 `AGENT_RUNTIME=native` 已删除。
  - `AGENT_RUNTIME` 只接受未设置、空值、空白或 `langgraph`，其他值拒绝启动（`AGENT_RUNTIME_REMOVED`）。
  - 恢复原生调度器的唯一办法是 `git revert` 阶段 6 的提交，见“阶段 6 结果”。
  - 当时仍然可用的运维回退：`AGENT_SKILL_GRAPH_ROLLOUT=off` 让 custom-Skill 阶段回到 V1 顺序链（阶段 8 已删除）；`AGENT_UNIFIED_GRAPH_ROLLOUT` 默认 `off`，v3 图不执行。
- 阶段 7 起：外层计划也没有运行时回退开关。
  - 原生循环和 `AGENT_OUTER_PLAN_RUNTIME=native` 已删除，变量只接受未设置、空值、空白或 `langgraph`，其他值拒绝启动（`AGENT_OUTER_PLAN_RUNTIME_REMOVED`）。
  - 恢复原生循环的唯一办法是 `git revert` 阶段 7 的删除提交，见“阶段 7 结果”。外层图不写线程记录，没有在途数据要处理。
- 阶段 8 起：custom Skill 阶段没有回到顺序链的开关。
  - V1 顺序链和 `AGENT_SKILL_GRAPH_ROLLOUT=off|shadow` 已删除，变量只接受未设置、空值、空白或 `guarded`，其他值拒绝启动（`AGENT_SKILL_GRAPH_ROLLOUT_REMOVED`）。
  - 恢复顺序链的唯一办法是 `git revert` 阶段 8 的删除提交，见“阶段 8 结果”。图 checkpoint 的格式没有变，没有数据要处理。
  - 剩下的运维开关只有 `AGENT_UNIFIED_GRAPH_ROLLOUT`（默认 `off`，v3 图不执行）和三个 planner 开关。
- 阶段 9 起：没有不经图执行 custom Skill 的恢复路径。
  - `custom_skill` 步骤的独立处理器、单步 resume、启动时的单步重放和 `resume_from_step` 动作已删除。没有对应的环境变量，所以没有启动拒绝要加。
  - 恢复它们的唯一办法是 `git revert` 阶段 9 的删除提交，见“阶段 9 结果”。run 和 checkpoint 的格式没有变，没有数据要处理。
- 数据（阶段 4、5 的规则，revert 阶段 6 之后同样适用）：LangGraph 的线程记录写在 run 行 `result` 下的独立私有键，原生路径不读它。回退到 `native` 后，正在 LangGraph 上执行、尚未结束的 run 由原生路径接管：启动恢复和审批续跑都从 agent run 的图 checkpoint（权威）继续，不看线程；结算保存或 `failRun` 用 null 墓碑覆盖旧线程记录。已批准、尚未写入的 Capability 在原生路径上以 run+node 幂等键执行一次；写入后崩溃（step 为 running）仍转人工，不重放。反方向（native 停靠、langgraph 续跑）走一次新的 invocation。阶段 4、5 时两个方向都有测试钉住（`langgraph-unified-graph`、`langgraph-execution-graph-runtime` 的启动恢复交叉用例、`agent-unified-graph-postgres.integration` 的 7 个跨进程用例在两种 runtime 下各跑一遍）。阶段 6 删掉了“交给 native 接管”这一方向的用例，revert 会把它们一起恢复；“native 留下的 run 由 LangGraph 接管”这一方向仍由删掉线程后续跑、恢复的用例钉住（见“阶段 6 结果”的“升级时在途的 run”）。

## 明确不做

- 不接 LangSmith、LangGraph Platform/Server、LangServe；自托管 Express 不变。
- 不用 `PGVectorStore`、`TextSplitter` 替换现有检索与切块。
- 不把 pgvector SQL、RLS、BM25 函数、索引版本、读副本、服务身份、RBAC、指标、注入筛查、claim 校验、门控、评测框架迁到 LangChain。
- 第一期不改长期记忆和经验记忆的存储。
- 不改任何评测语料、基线、阈值来让迁移"通过"。
