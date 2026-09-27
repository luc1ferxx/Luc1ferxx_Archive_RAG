# Unified AgentRAG DAG：迁移决策与验收清单

状态：**审批续跑也已解冻（2026-09-27）**。`AGENT_UNIFIED_GRAPH_ROLLOUT=guarded` 可以执行含审批节点的统一图：图在审批节点暂停，批准后从 checkpoint 续跑，Capability 只执行一次。默认值仍为 `off`。统一图规划器已接上真实模型，但本地 qwen2.5:7b 只有 3/15 的计划被接受，其余回落到确定性图（见下文"真实模型规划"）。本文件不能用来宣称真实模型能可靠地规划全阶段图。

## 冻结与部分解冻

- **原冻结决定（2026-09-25）**：custom Skill 阶段的 typed DAG（V2）改为默认执行器，全阶段 v3 统一图停在 shadow。解冻需要两个条件：一是出现外层固定顺序表达不了、且有评测用例证明的编排需求；二是四块恢复能力各自有跨进程测试，即文档循环的缺口与工作记忆、审批续跑、整次运行的 finalization 收据、跨进程恢复。
- **已满足：编排需求与评测用例**。trajectory 用例 `unified_graph_evidence_gated_skill_hand_off`（已写入 `quality-current-suite-manifest.js`，版本 1.13.0）固定了这条路径：
  - 文档证据不足时，图经由已校验的谓词边 `document_evidence_check.passed == false` 进入 Web。
  - Web 的 `text` 通过 typed 绑定作为 `priorFindings` 交给 `risk_review`。
  - 证据充分时，Web 节点为 `condition_not_met`，Skill 节点为 `dependency_skipped`，两者都不计费。
  - 同一请求在 V1 上的表现：`custom_skills` 固定排在 `document_rag` 与 `web_search` 之前；它的条件只有 `selected_custom_skills`，没有证据谓词；Web 结果没有任何进入 Skill 输入的通道。
  - 证据类型：确定性注入提案加 mock provider。这证明的是运行时契约（接纳、条件调度、typed 交接、预算、收据、一请求一路径），不是真实模型规划证据。
- **已满足：三块跨进程恢复**。测试文件为 `server/test/agent-unified-graph-postgres.integration.test.mjs`，使用真实 PostgreSQL run store。第一个进程在指定写入处“退出”，之后另起一个 Node 进程执行生产启动恢复。
  1. **文档循环的缺口与工作记忆**：进程在 follow-up 节点完成后退出。重启后 primary 与 follow-up 都被复用，不重复执行、不重复计费（`documentRagCalls` 为 2）。claims、evidence gaps、executionLoop 与未中断的运行完全一致，resolved 与 unresolved 两种结局都覆盖。这些状态来自已持久化的 typed 输出（`agent-unified-graph-document-loop.js`），不依赖进程内存。
  2. **整次运行的 finalization 收据**：答案由同一个 `finalizeAgentRun` 生成，先写入私有 graph checkpoint 的 `finalization` 收据，再完成 run。
     - 收据写入后崩溃：恢复只用收据完成 run，答案逐字相同。
     - 收据写入前崩溃（图已 completed）：从同一批持久化节点输出重算，不执行任何节点，结果与未中断运行一致。
     - 之后再次启动不会产生第二个答案：claim 已用尽，run 已终结。
  3. **节点边界的跨进程续跑**：只复用 typed-output 摘要能对账的已完成节点，待执行节点在新进程运行。篡改收据摘要会进入人工恢复（`completed_step_without_checkpoint`）。进行中的文档调用（step 为 running）会进入人工恢复（`unknown_in_flight_node`），绝不重放。
- **仍冻结：审批续跑**。原因如下：
  - 图内暂停、批准后继续执行，需要把审批对象和输入 hash 绑定到图节点，还要对“批准后执行、结果未知”的状态做跨进程恢复。这一块没有新的恢复证据。
  - 常设授权只存在于原请求里，恢复进程无法重建。
  - 因此在 guarded 下，任何可能中途等待用户确认的节点都会在所有节点运行之前被整图拒绝，然后回退 V1。这包括声明审批门的 Capability 适配器，以及没有常设、与输入无关授权的 Web / 文档发现内置节点。拒绝原因写入 `unified_graph_planned` 事件（`fallback: "v1"`）和 `unified_graph_fallback` trace 步骤。
  - 已有 run 的重入（V1 批准后续跑的入口）一律留在 V1，原因码为 `approval_continuation_frozen`。
  - 恢复时，如果待执行节点需要审批，则不执行，交给人工处理。
  - `agent-unified-graph-stage.js` 中的图绑定审批 preflight 代码保留，但在 guarded 路径上不可达。
- **guarded 的边界**：
  - 没有默认模型 planner，未注入 adapter 时会记录拒绝并回退 V1。
  - 一次请求只走一条路径；图被接纳后出错不回退 V1，部分执行的 run 以失败结束。
  - 图的形状必须能投影回 V1 的执行状态：最多一个 primary 文档节点，加上一个以 primary 检查 `retryRecommended == true` 为条件的 follow-up；最多一个 Web 节点；inventory 与文档发现只能单独出现；Capability 节点不可投影。
  - 图内证据检查使用词法的 `evaluateDocumentEvidence`（claim judge 只在 finalizer 中生效），`/chat/stream` 在 guarded 图路径上不发送 `answer_draft`。
  - 仍待补：quality:current / release:gate 的同 SHA 证据，以及真实模型 DAG planner 的评测。

### 审查后的修正（2026-09-27）

**guarded 准入的数据边界**（`server/rag/agent-unified-graph-admission.js`；任何节点执行前对整图判定，拒绝即记录 `unified_graph_planned`（`rejected`），由 V1 回答）：
- 有外部副作用的节点（Web 搜索、外部 Capability）只读取用户自己的请求：字符串输入只能绑定 `request.question`，不能绑定上游输出（`external_input_not_request_question`），因此文档派生文本不会被发给第三方搜索服务。
- 外部节点的输出不能绑定进任何其他节点的输入（`external_output_hand_off`）。Web 文本是基于外部网页的模型输出，只有 finalizer 把它当作不可信证据处理，所以它只能进入最终答案，不能进入 Skill 提示词。基于它的布尔 `when` 条件仍然允许。
- 意图要求读取所选文档时（`plan.wantsDocumentRag` 且 docIds 非空），图中必须有一个无条件、无依赖的主 `document_rag` 节点（`document_request_without_document_node`）。意图没有要求 Web 时，Web 节点必须挂在主文档答案自身 `document_evidence_check` 的 `passed == false` 上（`web_not_gated_on_document_evidence`），相当于把 V1 的“文档弃答或失败才走 Web”扩展为“文档答案未通过证据检查才走 Web”。
- 只有至少一个自定义 Skill 结果未弃答时，finalizer 才采用图证据策略。一个弃答的 Skill 节点不会让 Web 上下文变成可验证证据。

**解冻用例已更换**：原例子“文档证据不足 → Web → 把 Web 结果交给 Skill”按设计不被准入（trajectory 检查 `web_to_skill_hand_off_refused` 固定了这一拒绝）。新用例为 `unified_graph_evidence_gated_skill_hand_off`：
- 风险审查请求先由所选文档作答。只有该答案通过自身证据检查时才运行 `risk_review`，并把已验证的文档答案作为类型化 `priorFindings` 交给它。
- 证据不足时，Skill 以 `condition_not_met` 跳过，不计费，文档循环向用户澄清。
- 同一请求在 V1 上（chain 与 V2 DAG 两种执行器，两种证据变体）每次都先无条件运行 Skill，从不运行 `document_rag`，Skill 提示词不含上游段落。
- mock 的 Skill 答案与上游段落无关，所以该用例只证明编排与运行时契约（跑什么、花多少、Skill 收到什么类型化输入），不宣称答案质量提升，也不是真实模型规划证据。
- 当前 trajectory 结果：18/18 用例、78/78 检查通过（unified_graph 类别 7 项）。

**选中后 stage 拒绝**：stage 用实时服务重建目录并再次校验。在首次写 checkpoint 之前的拒绝（例如所选文档在规划与执行之间被另一实例删除）会追加一条 `supersedes: "selected"` 的 `rejected` 事件（错误码以 `stage_refused_before_execution` 开头），然后由 V1 回答。`hasUnifiedGuardedGraphPath` 以最新一条 planned 事件为准。从 stage 首次写 checkpoint 起不再回退 V1。

**finalization 收据**：
- 新鲜路径先完成响应准备（run id、task continuation、经验记忆写入），再写收据，所以收据保存的就是完整响应，回放结果与未中断请求一致。
- 无收据的重算路径会再次写经验记忆。写入按确定性 memoryKey upsert，不会重复。
- 重算时还会从 selected 事件的 `requestContext`（脱敏的 intentPlanner 与经验记忆读取观测）恢复会话观测字段。

**启动恢复**：
- 只有 `AGENT_UNIFIED_GRAPH_ROLLOUT=guarded` 时才会自动续跑或完成 v3 图。回滚到 `off` 或 `shadow` 后，这类运行以 `unified_graph_rollout_not_guarded` 转人工，不取 claim。
- 有收据时先回放收据，再比较实时 Skill 目录，所以部署提升 Skill 版本不会让已封存答案的运行卡住；需要重算时，目录变化仍会被拒绝。
- 已复用输出判定为不会运行的节点不算待运行节点，例如证据检查已通过而跳过的 Web 回退及其后续节点，因此恢复进程没有常备 Web 授权也能完成。节点即将启动前还会再检查一次审批需求。
- 持有 claim 的 worker 在自己的续跑失败后，会在同一 claim 下标记人工恢复（`markManualRecovery({ expectedGraphResumeClaimId })`，原因 `graph_resume_failed`），运行不会停在 `running`、被以后的扫描永久跳过。不带 claim id 时，run store 仍拒绝标记被 claim 的运行。

**已结束的 v3 运行的续接**：以澄清结束（有收据）或部分失败（run 为 `failed`）的 v3 运行不会被重入。后台任务的 continue 或带 agentRunId 的请求会新建运行（事件 `run_continued`，payload 含 `previousRunId`），由任务记忆携带上下文，已结束的运行保持不变。其他带图 checkpoint 的运行仍由 CAS 拦截（`AGENT_GRAPH_EXECUTION_FENCED`）。

=== docs/configuration.md，`AGENT_UNIFIED_GRAPH_ROLLOUT` 行 ===
取值 `off`（默认）/ `shadow` / `guarded`。`guarded` 在注入统一图 planner adapter 时，让通过准入（审批与数据边界）的 v3 图回答整个请求；规划、准入或 stage 在首次写 checkpoint 前拒绝时，由 V1 回答。启动恢复只在 `guarded` 下续跑或完成 v3 图，其他取值下这类运行转人工（`unified_graph_rollout_not_guarded`）。

=== server/docs/interview/CURRENT-TRUTH.md（数字不变，仅更新用例名）===
trajectory 18/18 用例、78/78 检查；v3 解冻用例为 `unified_graph_evidence_gated_skill_hand_off`（确定性注入提案与 mock，属于运行时契约证据，不是真实模型证据）。Web→Skill 交接按设计被准入拒绝。

=== AGENTS.md paragraph (replaces the v3 bullet) ===
- The heterogeneous v3 DAG has a `guarded` rollout (`AGENT_UNIFIED_GRAPH_ROLLOUT`, default `off`) in `agent-unified-graph-run.js`: an admitted graph answers the whole request, and any refusal before the stage's first checkpoint write (at planning, at admission, or in the stage, where it records `supersedes: "selected"` and `stage_refused_before_execution`) is recorded as `unified_graph_planned` `rejected` and V1 answers. `agent-unified-graph-admission.js` refuses approval-gated nodes and enforces data boundaries; do not relax them to make a graph admissible:
  - an external-effect node's string inputs bind only to `request.question`;
  - no node input binds an external node's output (Web text reaches only the finalizer, never a Skill prompt);
  - a document-scoped intent needs an unconditional, dependency-free primary `document_rag` node;
  - when the intent did not ask for Web, a Web node must be gated on `passed == false` of the primary answer's own `document_evidence_check`.

  The prepared response (run id, continuation, experience-memory write) is sealed as the finalization receipt before completion. Startup recovery:
  - resumes or finalizes v3 only under `guarded`, and otherwise marks the run manual with `unified_graph_rollout_not_guarded`;
  - replays a stored receipt before comparing the live Skill catalog;
  - treats nodes that the reused outputs already skip as not pending;
  - lets a claim holder whose resume failed mark the run manual under that claim (`markManualRecovery({ expectedGraphResumeClaimId })`, reason `graph_resume_failed`).

  A settled v3 run (a finalized receipt, or partial and failed) is never re-entered: `runAgentRag` with its id creates a new run (`run_continued`). The unfreeze trajectory case is `unified_graph_evidence_gated_skill_hand_off`; the "Web → Skill" example is refused by design. Approval continuation inside the graph stays frozen. This is pinned by `agent-unified-graph-boundaries.test.mjs`, `agent-unified-graph-guarded.test.mjs` and `agent-unified-graph-postgres.integration.test.mjs`.

=== npm script (server/package.json) ===
Append `test/agent-unified-graph-postgres.integration.test.mjs` to `test:pgvector` so the focused disposable runner covers it. For example: "test:pgvector": "node --test test/vector-store-pgvector.integration.test.mjs test/agent-execution-graph-postgres.integration.test.mjs test/agent-unified-graph-postgres.integration.test.mjs test/postgres-row-level-security.integration.test.mjs test/ingest-jobs-postgres.integration.test.mjs". Merge this with any DATA-track change to the same script.

Changed files (all agent track):
- /Users/luc1ferx/Desktop/Projects/Luc1ferxx_Archive_RAG/server/rag/agent-unified-graph-admission.js
- /Users/luc1ferx/Desktop/Projects/Luc1ferxx_Archive_RAG/server/rag/agent-unified-graph-stage.js
- /Users/luc1ferx/Desktop/Projects/Luc1ferxx_Archive_RAG/server/rag/agent-unified-graph-run.js
- /Users/luc1ferx/Desktop/Projects/Luc1ferxx_Archive_RAG/server/rag/agent-unified-graph-projection.js
- /Users/luc1ferx/Desktop/Projects/Luc1ferxx_Archive_RAG/server/rag/agent.js
- /Users/luc1ferx/Desktop/Projects/Luc1ferxx_Archive_RAG/server/rag/agent-runs.js
- /Users/luc1ferx/Desktop/Projects/Luc1ferxx_Archive_RAG/server/rag/agent-run-recovery.js
- /Users/luc1ferx/Desktop/Projects/Luc1ferxx_Archive_RAG/server/rag/config.js (AGENT block comment only)
- /Users/luc1ferx/Desktop/Projects/Luc1ferxx_Archive_RAG/server/evaluation/trajectory/cases/unified-graph.js
- /Users/luc1ferx/Desktop/Projects/Luc1ferxx_Archive_RAG/server/evaluation/trajectory/cases/index.js
- /Users/luc1ferx/Desktop/Projects/Luc1ferxx_Archive_RAG/server/evaluation/quality-current-suite-manifest.js
- /Users/luc1ferx/Desktop/Projects/Luc1ferxx_Archive_RAG/server/test/agent-unified-graph-boundaries.test.mjs (new)
- /Users/luc1ferx/Desktop/Projects/Luc1ferxx_Archive_RAG/server/test/agent-unified-graph-guarded.test.mjs
- /Users/luc1ferx/Desktop/Projects/Luc1ferxx_Archive_RAG/server/test/agent-unified-graph-postgres.integration.test.mjs
- /Users/luc1ferx/Desktop/Projects/Luc1ferxx_Archive_RAG/server/test/fixtures/unified-graph-run-fixtures.mjs
- /Users/luc1ferx/Desktop/Projects/Luc1ferxx_Archive_RAG/server/test/trajectory-eval.test.mjs

## 当前边界与决策

当前 `/chat` 仍由 `agent-execution-plan-runner.js` 依固定外层步骤顺序运行文档、Web、内置 Skill 和 Capability；`agent-custom-skill-stage.js` 的 typed DAG 只替代其中的 `custom_skills` 阶段。生产可达的图 checkpoint/启动恢复仍限于自定义 Skill，旧节点收据使用 `custom_skill:<nodeId>`。`AGENT_SKILL_GRAPH_ROLLOUT` 现在默认 `guarded`（typed DAG 执行 custom Skill），V1 chain 只是整图被拒时的兜底和 `off` 回退，确定性 planner 仍是 LLM 规划失败时的兜底，不能把当前生产路径称为全 Agent 动态 DAG。

统一图的**基础模块已经存在，但并未组合成生产执行路径**：`agent-execution-graph.js` 增加异构节点的 `v3` 图契约及整图校验；现有 scheduler 可运行 `v3` 节点，使用 `graph_node` 收据与独立的 `agent_graph_node:<编码后的 nodeId>` 身份。`agent-execution-graph-checkpoint.js` 增加与 `v3` 配套的 `v2` checkpoint，对完整 typed output 摘要、收据身份和未知进行中状态做保守对账；这不是统一图启动续跑已接线的证明。`skills/unified-graph-catalog.js`、`agent-unified-dag-planner.js`、`agent-unified-graph-results.js` 和 `agent-unified-graph-projection.js` 分别提供受限候选目录、注入式提案/校验边界、按节点保留的结果收集，以及**仅覆盖部分现有结果形状**的旧状态投影；目录本身标记 `executionWired: false`。显式 Capability 图适配器仅在可信调用方给出 allowlist 时进入候选目录，不代表审批后的统一图续跑已经可用。`AGENT_UNIFIED_GRAPH_ROLLOUT=shadow` 且注入提案 adapter 时，真实 AgentRAG/后台 task 会旁路验证 v3 图并记录精简 `unified_graph_planned` event；答案仍走旧路径，不执行统一图。`guarded` 当前不开放，未注入 adapter 时 shadow 记录拒绝。

迁移继续沿用**同一个 Agent run store、同一套图 validator/scheduler 与审批/重放安全策略**，不新增平行执行运行时。一次请求只选一条执行路径：V1 外层流程，或统一图；不能先跑 V1 的某阶段再把它当作图节点的未记录前置结果。模型未来只提出授权目录内的节点、依赖与合法输入绑定；在暂缓真实模型期间，用确定性图和注入式测试 planner 验证运行时，不把 mock 评测称为真实模型证据。

## 目标契约

- 运行时从注册表构造**权限过滤后的候选目录**：每项有稳定 `id/version`、显式 input/output schema、effect/idempotency/replay 契约。选中文档逐个用可信 `accessScope` 核验；未核验、空范围或已撤权的文档不进入可执行输入。模型/请求文本不能发明 Skill、扩大 `docIds`，或设置身份、审批、密钥、预算、并发与重试上限。
- 图节点有唯一 `nodeId`、能力 ID、声明依赖、类型化输入绑定、失败策略。validator 在任何节点运行前整图校验；scheduler 只把已完成、已校验、已持久化的上游**声明输出字段**交给下游。条件分支仅使用预定义且可校验的结果谓词（如文档证据不足时进入 Web），不执行 planner 编写的表达式。
- 自定义 Skill 是原子节点。当前 v3 候选已能表达文档 `primary → document_evidence_check → 条件 follow-up`：检查节点复用确定性证据评估，后续文档调用另耗一次预算；但缺口处理、最终选择、工作记忆和恢复仍未接齐，不能用这三个节点声称替代整个 V1 文档循环。Web 为受控外部读取节点；Capability 以注册的 `capabilityId`、政策和审批门禁为准，未经批准绝不执行写操作。所有节点均由同一图 claim/CAS 约束，不能绕开图走通用单步骤重试。
- 输出契约必须在节点完成后、下游可调度前强制检查。完成步骤的收据记录完整 typed output 的稳定摘要（包括 citation 身份），与私有图 checkpoint 对账；无摘要的旧收据、摘要/类型/Skill 版本失配均拒绝自动恢复，不能靠重新执行“修复”。结构校验不等于语义证据支持；最终回答仍走现有 self-check、citation 绑定与 finalizer。

## 文档循环、预算与副作用

`ragService.chat` 会记录 session turn，且在有 `userId` 时可能写用户 long memory；因此内置 `document_rag` 不能视为纯读取或无条件安全重放。统一图中的文档循环须声明实际写效应、非并行安全及非自动重放；未知进行中的调用只能进入人工恢复，除非以后引入经验证的幂等键/事务 outbox。

目标图中 primary 与条件 follow-up 是两个独立 `document_rag` 调用，各从运行时预算原子预留 **1 次**；只有检查节点确实建议 follow-up 时才调度第二次，不能让 V1 文档循环再对相同调用重复计费。预算不足仍须保留现有 clarification 和 trace 行为。checkpoint 必须记录各调用的实际尝试/计费、最终 `ragResult`、evidence clarification、working-memory/loop 状态和必要的 trace/观测状态，跨进程恢复后不能把 follow-up 计作新的免费调用，也不能丢失证据缺口。

## 持久化、恢复与最终回答

图、owner（scope、请求与目录版本、预算上限）、节点结果和版本化进度仍私存于现有 run store。节点开始、子步骤、节点完成与最终 run 状态使用同一 run-revision CAS/claim 栅栏；批准后的 Capability 必须绑定原审批对象/输入 hash，执行后的未知状态不能自动补跑。恢复流程先核对 owner、注册表契约、授权文档、步骤收据、typed-output 摘要和已扣预算，再只复用**已完成且可证明一致**的节点。任何 active/paused 不明子调用、已完成子步骤但缺图 checkpoint、失效审批、过期 claim 或矛盾收据进入人工恢复。跨进程 PostgreSQL 测试必须证明已完成写入不重复、失配时无下游执行。

统一图产物需投影回现有 `finalizeAgentRun` 所需的 `customSkillResults`、`ragResult`、`webResult`、Capability 答案与 clarification 等字段；恢复时还原 working memory、执行循环和 trace，避免重复或丢失。保留 `/chat` 的响应字段、status、citations/source identity、`agentObservability`、审批交互与前端 trace。若图已结束而最终回答/完成 run 的写入中断，需有可重入的 finalization 收据或等效机制；仅“节点都完成”不足以宣称整次 Agent 可恢复。

## 迁移次序与验收

1. **契约/安全底座（部分已落地，未接线）**：已增加 `v3` 图、独立节点收据、`v2` checkpoint、受限目录、注入式规划边界及部分投影。继续补齐各类效果的审批/恢复规则与端到端验证；非法节点、越权文档、伪造审批/预算、非法类型、条件边、循环和超限必须在零执行时拒绝。
2. **文档节点（部分合同/规划已落地，生产待完成）**：当前显式 `document_rag` 仍只代表一次 RAG 调用；新增 graph-only `document_evidence_check`，规划器可校验 primary→检查→条件 follow-up 的类型绑定，检查节点会生成聚焦的 `followUpRetrievalPlan`，第二次检索需显式绑定该输出。执行器和 checkpoint 复用会核对原始 RAG 值与下游绑定的结构化证据；但这些节点**尚未代替** `runDocumentRagLoop` 的完整状态循环。需接入缺口、最终结果选择、工作记忆与 Web 条件分支；以 stub RAG 验证 primary/follow-up 的 1/2 次预算、证据不足、clarification、Web fallback、typed 输出门禁及原有回答/trace 等价性。此阶段仍不等于 Capability 同图完成。
3. **审批 Capability 与最终合成（待完成）**：已有显式适配器和可信 allowlist，但生产统一图的审批暂停、批准后续跑及输入 hash 绑定仍未实现；现有投影也尚不能表达任意内置/Capability 组合，最终合成仍依赖旧 `plan.mode`。须覆盖批准前零写入、批准后输入 hash 不变、拒绝/超时、写后崩溃、重复 worker，以及图结果到回答/trace 的等价投影。只有已证明幂等的 adapter 可自动补跑，其他情况人工处置。
4. **恢复与发布**：用独立 Node 进程和 PostgreSQL run store 验证部分完成图的恢复、scope/版本变化、预算重建、收据篡改、未知 in-flight 和 finalization 中断。`off` 保持 V1；`shadow` 只记录候选图不执行；`guarded` 仅在**首节点执行前**允许回退 V1，部分执行后禁止回退。逐级灰度，不删除 V1，直至门禁和实际观测证明可替换。
5. **评测门禁**：为统一图新增 pinned trajectory/planner/recovery/runtime/readiness 用例并更新 manifest 版本；断言真实 `/chat` 与后台 task 经过同一图路径、审批与权限/预算不回退、图节点/步骤/收据一致。运行后端含 pgvector 集成、前端与 build，以及 `quality:current` / `release:gate` 的同 SHA、干净工作树、fresh lineage 检查。真实 LLM DAG planner 的评测与上线判定仍是目标要求，但依用户当前指示暂缓；mock PASS 不可替代它，也不可据此宣称总迁移完成。

## 审批续跑与真实模型规划（2026-09-27）

状态：**解冻（2026-09-27 第二轮）**。`AGENT_UNIFIED_GRAPH_ROLLOUT=guarded` 可以执行统一图，包括含一个审批门 Capability 的图：图在审批门暂停，批准或拒绝后在同一个图上续跑。四块恢复能力都已有跨进程 PostgreSQL 测试。统一图现在有默认模型 planner。但在本地 7B 模型上，模型自己的方案大多被拒，由确定性图兜底（数字见下文“真实模型规划”）。默认值仍为 `off`，无法识别的值也回落到 `off`。不能把本地 mock 或确定性结果说成 GPT 级模型的规划证据。

【把“仍冻结：审批续跑”整段替换为】
- **已满足：审批续跑（第四块）**
  - 准入：直连的审批门 Capability 可以进图，每个图最多一个（`multiple_approval_gated_capabilities`）。它只能是意图本身要求的动作：`plan.mode` 为 `workspace_action`，且节点是 `capability:<actionCapabilityId>`；否则 finalizer 无法表达它的结果（`graph_not_projectable`）。
  - 仍然拒绝：Web / 文档发现这类内置包装节点，如果没有常设授权，仍整图拒绝。它们的审批发生在 execute 内部，不在节点边界。
  - 暂停：
    - 调度器把需要审批的节点停在干净边界（`awaiting_approval`），此时没有 step、没有预算、没有输出。
    - 不依赖它的节点继续跑完。
    - 等没有其他节点可跑时，基于最新 checkpoint 生成图绑定审批门。审批对象 hash 覆盖精确的解析后输入，并绑定 run、graph digest、revision 和 nodeId。
    - 审批门、私有执行快照（与 V1 同一张审批快照表、同一套 policy）和 `awaiting_approval` checkpoint 在同一个 CAS 中写入。
    - 请求返回与 V1 相同的 `capability_approval_required` 澄清，run 进入 `waiting_for_user`，不完成 run，不写收据。
  - 决策入口：`/agent-runs/:runId/actions/approve|deny`（agentRunStepExecutor 识别图门后交给 `continueAgentExecutionGraphApproval`），或后台任务带该门 gateId 与 approvalObjectHash 的批准重入。两者都在同一个图上续跑，不重新规划。
  - 批准：
    - 决策 CAS 把图重新打开为无 claim 的 `running`，用与新请求 worker 相同的 run-revision 栅栏。
    - 已完成节点按摘要复用。
    - Capability 执行前，用实时 Capability、实时 policy 和当前绑定输入重算审批门，必须与用户批准的门和私有快照一致，然后以批准的输入执行一次。
    - 执行时带确定性幂等键 `run+node`：task.create 按该键 upsert。
    - 之后依次运行下游节点、整次 finalization，写入收据并完成 run。
  - 拒绝：该节点记为 `skipped / approval_denied`，下游 `dependency_skipped`，不写任何东西。回答为“<Capability> was not run: the approval was denied.”，同样写入收据并完成 run。
  - 被拒绝的审批：
    - 错误的审批对象（`approval_object_hash_mismatch`）。
    - 已决定的门再次决定（409）。
    - 审批门展示后 Capability 版本变了（`graph_approval_stale`，决策前拒绝，run 仍在等待）。
    - 私有快照与所示输入不符（绑定校验在决策 CAS 内失败）。
  - 未知状态不自动重放：
    - 批准后、Capability 的 step 尚未开始时崩溃：启动恢复可以取 claim，读取同一批准，执行一次。
    - Capability 已写入、收据之前崩溃（step 为 running）：启动恢复进入人工恢复（`unknown_in_flight_node`），绝不重放。
    - 干净停在审批门的运行，启动恢复不改动它（跳过，不转人工）。
    - 续跑失败时：部分失败的图使 run 失败；其他错误由 worker 转人工（`graph_approval_continuation_failed`）。
    - 回滚到非 `guarded` 后，审批决策被拒绝（`unified_graph_rollout_not_guarded`），由运维处理。
  - Capability policy 拒绝解析后输入（例如必填字段绑定到空的上游输出）时，该节点经生命周期记为失败，不会崩溃，也不会执行。
  - 证据：
    - `server/test/agent-unified-graph-postgres.integration.test.mjs` 新增三个真实跨进程用例：进程 A 暂停、进程 B 批准，Capability 恰好写一次；批准写入后真实退出（exit 17），下次启动转人工且不重放；拒绝。
    - 内存套件为 `agent-unified-graph-approval.test.mjs`。
    - trajectory 用例 `unified_graph_approval_gated_action`（manifest 1.14.0）同时测量同一请求在 V1 上的表现：V1 只运行动作，审批的任务描述是原始问题，没有文档答案。
- **新增准入规则**：图必须包含意图本身的节点，即意图的自定义 Skill（或 chain 中每个 Skill）、workspace action 的 Capability，或独立的 inventory / discovery / Web 节点（`intent_skill_missing`）。否则 finalizer 只能给出“Skill 未完成”。research brief / arXiv import 在 v3 目录中没有节点，一律由 V1 回答。真实模型测试暴露了这个缺口。

【“guarded 的边界”中把“没有默认模型 planner……”一条替换为】
- 默认 planner 由 `app-services.js` 的 `createUnifiedGraphPlannerAdapter()` 提供，与 DAG planner 读同一个开关（`AGENT_PLANNER_ROLLOUT` / `AGENT_EXECUTION_PLANNER`）：llm 时为 `llm_unified_graph`，否则为 `deterministic_unified_graph`。
  - 模型 adapter（`agent-unified-dag-planner-adapter.js`）使用 prompt `unified_graph_planner@v1`，已登记在 prompt-catalog 并固定指纹。
  - response_format 是从运行时授权目录生成的严格 JSON Schema：
    - nodeId 必须是 skillId 或 skillId_2..9；
    - 绑定和 when 只能引用来源 Skill 声明的同类型输出；
    - object 输入只接同名（或 followUp 变体）输出；
    - 节点不绑定自己 Skill 的输出；
    - 受限的 docIds 只接请求值；
    - 字符串用 pattern 限长，数组有 maxItems。
  - 解析回复中第一个完整 JSON 值。validator 与准入仍是最终权威。解析、校验或准入任一失败，就整图换成确定性图，绝不部分执行；确定性图也不可准入时，由 V1 回答。
  - planner 只看到脱敏上下文：目标、意图标志、授权 docIds、目录描述、限制、剩余预算，从不看到文档文本。
  - 每次决策记录在 `unified_graph_planned.payload.planner`：fallback、原因码与原因、`plannerCall.latencyMs / tokens / promptTemplate`。
- 允许直接调用的 Capability 由可信配置 `AGENT_UNIFIED_GRAPH_CAPABILITIES` 决定（逗号分隔，默认空），不是 planner 输入。恢复时按已封存 owner 中的目录身份重建。

【新增小节：真实模型规划（本地 qwen2.5:7b，2026-09-27）】
- 这是本地 7B 模型（Ollama 上的 qwen2.5:7b），不是 GPT 级模型。只有 planner 调用模型，RAG / Skill / Web / task.create 均为 mock，因此失败的只是规划。
- `npm run eval:unified-graph-planner -- --real --runs 3`，统一图的两个 trajectory 用例，共 15 次规划：
  - 模型自己的方案被接纳 2/15（13.3%），换成确定性图 13/15，由 V1 回答 0。
  - 原因：intent_skill_missing 6（风险审查意图的 6 次全部漏了 risk_review）、illegal_output_reference 5（绑定了没列进 dependsOn 的节点）、invalid_node_shape 1（约束解码失效，JSON 解析失败）、graph_not_projectable 1。
  - 分用例：证据门控用例 0/6，审批用例 2/9。
  - 运行时检查 39/39 全部通过（确定性兜底图承担了执行）；planner 模式检查 `model_plan_used` 0/6，所以用例层面 0/6 通过。
  - 每次规划延迟：均值 8194 ms，p50 8205 ms，最大 11103 ms。每次规划 token：均值 2036，最大 2217。
- `npm run eval:planner -- --real` 跑 3 次：用例 16/21，检查 72/81。
  - 新用例 `planner_unified_graph` 三次都未通过 `unified_planner_selected`（1 次 illegal_output_reference，2 次 intent_skill_missing）。
  - 既有的 `planner_dynamic_skill_graph`（V2 DAG planner，本轮未改动）三次中失败两次。
- 结论：运行时契约已经具备，但本地 7B 模型的 v3 方案目前主要靠确定性兜底，不能作为模型规划能力的证据。

=== docs/configuration.md ===
- `AGENT_UNIFIED_GRAPH_ROLLOUT` 行：取值 `off`（默认）/ `shadow` / `guarded`。
  - `guarded` 让通过准入的 v3 图回答整个请求，包括在审批门暂停、并由审批决策在同一图上续跑。
  - 规划、准入或 stage 在首次写 checkpoint 前拒绝时，由 V1 回答。
  - 审批决策和启动恢复只在 `guarded` 下续跑 v3 图；其他取值下，审批被拒绝（`unified_graph_rollout_not_guarded`），启动恢复转人工。
  - planner 跟随 `AGENT_PLANNER_ROLLOUT` / `AGENT_EXECUTION_PLANNER`（`llm_unified_graph` 或 `deterministic_unified_graph`）。
- 新增行 `AGENT_UNIFIED_GRAPH_CAPABILITIES`：v3 图可以直接调用的 Capability id，逗号分隔，默认空。这是可信运维白名单，不是 planner 输入。审批门 Capability 仍在审批门暂停。

=== server/docs/interview/CURRENT-TRUTH.md ===
- trajectory 19/19 用例、84/84 检查（unified_graph 类别 13 项），manifest 1.14.0。新增 `unified_graph_approval_gated_action`：审批续跑的运行时契约证据，确定性注入提案与 mock。planner mock 7/7、27/27。
- v3 真实模型规划（本地 qwen2.5:7b，不是 GPT 级模型）：方案接纳率 2/15，兜底 13/15；每次规划约 8.2 s、约 2.0k token。
- 审批续跑跨进程 PostgreSQL 测试 3 项全部通过；两个 agent 图 PostgreSQL 套件合计 14/14。

### 第二轮审查修正（2026-09-27）

**审批续跑读取实时 allowlist**：
- 审批决定（`/agent-runs/:runId/actions/:action`，以及后台任务的重入）和启动恢复都按当前配置读取 `AGENT_UNIFIED_GRAPH_CAPABILITIES`，不使用规划时封存在 checkpoint owner 里的列表。封存列表只用于核对目录身份。
- 批准时若该 Capability 已不在实时 allowlist：不做决定，门保持 pending，运行以 `unified_graph_capability_not_allowed` 转人工（不取 claim），请求返回 409 `graph_approval_capability_not_allowed`。拒绝（deny）不受影响，照常以不含该 Capability 的答案结束。
- stage 续跑或恢复时，对每个待运行（未完成、也不会被跳过）的 Capability 节点再核对一次实时 allowlist，不在列表中则抛 `AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY`。因此，已批准但尚未启动的节点在启动恢复时同样尊重撤销：运行转人工（`graph_resume_failed`），不写入。

**回滚不再让审批暂停搁浅**：
- 启动恢复只在 `guarded` 下跳过干净的审批暂停。回滚到 `off` 或 `shadow` 后，这类运行以 `unified_graph_rollout_not_guarded` 转人工，状态保持 `waiting_for_user`，出现在 `/agent-runs/recovery` 并带 cancel 动作。
- 在非 `guarded` 下做审批决定（批准或拒绝）时，先把运行标记为人工，再返回 409 `unified_graph_rollout_not_guarded`。
- 审批 CAS 拒绝已标记人工的运行，所以之后恢复 `guarded` 或 allowlist 也不会绕过 operator 重新打开它。

**后台任务在图审批门上**：
- 任务 `continue` 重入一个停在图审批门的运行、且没有带上该门的决定时，不再报 `graph_approval_not_pending`。它原样返回存储的审批澄清（同一个 gateId 与 approvalObjectHash），不写任何东西，不重新规划。任务回到 `waiting_for_user`（`approve_capability`），并保留这个门。
- 新增任务动作 `deny`，只适用于 `graph_capability_approval` 门。它和 approve 一样要求 gateId 与 approvalObjectHash 同待决门一致，映射为图的拒绝决定，任务以不含该 Capability 的答案结束。V1 门的拒绝仍在 agent run 上进行，任务动作对 V1 门返回 409。
- 与门不符的决定（缺 gateId 或 hash 不符）仍返回 409 `graph_approval_not_pending`。

**shadow 观测模型自身的结果**：
- `AGENT_UNIFIED_GRAPH_ROLLOUT=shadow` 时，若规划 rollout 带有旁路 planner（`AGENT_PLANNER_ROLLOUT=shadow`），观测的是该模型 planner。
- 观测不使用 fallback：模型计划解析、校验或准入失败时记为 `rejected` 并带原因码，不再被确定性图替换后记成成功。
- 事件新增 `planner.fallback`、`selectedPlannerId`、`plannerCall`（延迟、tokens、prompt 模板、模型路由、response format 摘要）。
- 已知限制：shadow 规划仍在请求路径上同步等待，模型规划约 8 s 会计入 shadow 请求延迟；`guarded` 路径在 `AGENT_PLANNER_ROLLOUT=shadow` 下仍不做旁路模型规划。

**真实模型 v3 planner 评测（带 lineage）**：
- 报告 1.1.0 版新增 `summary.lineage`，列出实际运行过的 prompt 模板、模型路由和 response format schema 摘要；另有 `evidence` 块，记录 commit、工作区是否 dirty 和全部 prompt 模板。
- 最后一次运行时代码修改之后重跑一次：commit 85efbb6a 加未提交改动（dirty），`unified_graph_planner@v1#037c0f5c79da`，本地 Ollama `qwen2.5:7b`，3 轮 15 次规划。
- 结果：模型自身计划被采纳 3/15；12 次回退到确定性图（原因：intent_skill_missing 6、graph_not_projectable 4、illegal_output_reference 4、approval_required_without_standing_grant 1）；0 次回 V1。检查 37/45，用例 0/6。延迟 mean/p50/max 为 8140/8226/10778 ms，tokens 平均 2044。
- 两项运行时检查各有 1 次失败，都来自模型计划的形状：一次任务描述没有绑定到已验证答案；一次 `when` 条件把 task.create 跳过，导致没有门可以拒绝。
- 这是 mock 文档服务加真实模型规划的证据，不是答案质量证据。之前引用的 2/15、39/45 没有 lineage，而且测量之后运行时代码仍有改动，不再引用。

**前端**：图审批被拒绝时，返回的最终答案（已验证的文档答案加“未执行”说明）直接显示；V1 的拒绝仍显示通用文案。

=== server/docs/interview/CURRENT-TRUTH.md（v3 planner 真实模型数字）===
v3 统一图 planner 真实模型评测（`npm run eval:unified-graph-planner -- --real --runs 3`，qwen2.5:7b，本地 Ollama）：模型自身计划采纳 3/15，其余 12 次回退到确定性图，0 次回 V1；检查 37/45；单次规划延迟均值 8.1 s，tokens 均值 2044。报告带 lineage：commit 85efbb6a（dirty）、`unified_graph_planner@v1#037c0f5c79da`。这是规划证据，文档服务、Skill 与 Capability 都是 mock。

=== AGENTS.md paragraph (append to the v3 unified-graph bullet) ===
Guarded v3 approval is governed by the live configuration. The approval decision (`continueUnifiedAgentGraphAfterApproval`, reached from `/agent-runs/:runId/actions/:action` and from a task re-entry) and startup recovery read `AGENT_UNIFIED_GRAPH_CAPABILITIES` at call time. The allowlist sealed in the checkpoint owner only identifies the catalog. An approve of a Capability no longer on the live list, or any decision outside `guarded`, marks the run manual without a claim and returns 409. The reason codes are `unified_graph_capability_not_allowed` and `unified_graph_rollout_not_guarded`. The stage refuses any pending Capability node missing from the live list with `AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY`. Startup recovery skips a clean approval pause only under `guarded`; otherwise it marks the run manual with `unified_graph_rollout_not_guarded`, so the run is listed with a cancel action. A `runAgentRag` re-entry into a parked graph that carries no decision for its gate (a task `continue`) re-states the stored approval clarification and writes nothing (`restateUnifiedGraphApprovalPause`). A mismatched decision stays 409 `graph_approval_not_pending`. The task action `deny` applies to `graph_capability_approval` gates only and maps to the graph denial; V1 gates are denied on their run. Shadow observation plans with the rollout's shadow planner when there is one, and never with a fallback (`allowPlannerFallback: false`). `npm run eval:unified-graph-planner [-- --real --runs 3]` writes ignored `evaluation/results/latest-planner-unified-graph-<provider>.*` with `summary.lineage` (prompt template, model route, response-format digest) and an `evidence` block. Quote its numbers only together with that lineage; a local mock provider result is not real-model evidence. This is pinned by `agent-unified-graph-approval.test.mjs`, `agent-unified-graph-shadow.test.mjs` and `unified-graph-planner-eval.test.mjs`.

=== npm script (server/package.json, scripts) ===
"eval:unified-graph-planner": "node evaluation/run-unified-graph-planner-eval.mjs"
