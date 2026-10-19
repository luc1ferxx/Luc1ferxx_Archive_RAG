# Unified AgentRAG DAG：迁移决策与验收清单

本文记录 v3 统一图（文档、Web、内置 Skill、自定义 Skill 和 Capability 放进同一张受治理的 DAG）的冻结与解冻决定、`guarded` 档的准入规则与边界、图内审批续跑、真实模型规划结果，以及剩下的冻结项。测量数字也见 `docs/evaluation.md`「统一图的真实模型规划（2026-09-27）」。

## 结论

- `AGENT_UNIFIED_GRAPH_ROLLOUT` 有三档：`off`（默认）、`shadow`、`guarded`；无法识别的取值按 `off`。默认配置下 `/chat` 不走 v3 图。
- `guarded` 下，通过准入的 v3 图回答整个请求，包括含一个审批门 Capability 的图：图在审批门暂停，批准或拒绝后在同一张图上续跑，Capability 最多执行一次。
- 解冻要求的四块跨进程恢复（文档循环、finalization 收据、节点边界续跑、审批续跑）都有真实 PostgreSQL 上的跨进程测试。
- 生产总会注入统一图 planner。本地 qwen2.5:7b 上，模型自己的计划只被接受 3/15，其余由确定性图兜底（见「真实模型规划」）。本文不能用来宣称真实模型能可靠地规划全阶段图。
- 默认仍为 `off`。理由（被接管请求的行为变化、每个请求数倍于 V1 的 CPU、真实模型证据不足）见 [ADR 0001](adr/0001-langgraph-runtime.md) 阶段 5「没有做的部分与理由」。

**调度运行时**：`guarded` 下的 v3 图一律由 LangGraph.js 调度（`server/rag/langgraph/run-execution-graph.js`）。原生图调度器已在 ADR 阶段 6（2026-10-16）按用户决定删除，提前结束了 ADR 约束 12 的回退窗口。`AGENT_RUNTIME` 设成 `native` 或其他不是 `langgraph` 的值都会拒绝启动；要恢复原生调度器只能 revert 阶段 6 的提交。准入、v2 graph checkpoint、finalization 收据、回放矩阵、审批表和启动恢复仍是本文描述的同一批模块。审批停靠：其后各层没有不依赖它的待跑节点时，停在 run 线程上的 `interrupt()`，审批续跑以 `Command({resume})` 续同一线程；否则先跑完那些节点，再按原生方式停靠，续跑是从 checkpoint 起的新 invocation。线程怎样与 checkpoint 对账，见 [ADR 0001](adr/0001-langgraph-runtime.md) 阶段 3 和阶段 6。v3 图的运维回退仍是 `AGENT_UNIFIED_GRAPH_ROLLOUT=off`。

## 默认路径与开关

- **`off`（默认）**：`/chat` 由 `agent-execution-plan-runner.js` 按固定外层步骤运行文档、Web、内置 Skill 和 Capability。typed DAG 只替代其中的 `custom_skills` 阶段（`AGENT_SKILL_GRAPH_ROLLOUT`，默认 `guarded`；V1 chain 是整图被拒时的兜底和 `off` 回退）。不能把这条路径称为全 Agent 动态 DAG。
- **`shadow`**：生成候选 v3 图，用和 `guarded` 相同的 validator 与准入判定，只记录精简的 `unified_graph_planned` run event，不执行任何节点，答案仍走 V1（见「规划器」中的 shadow 观测）。
- **`guarded`**：见「准入规则」「执行边界」「图内审批续跑」「启动恢复」。
- **planner**：`app-services.js` 的 `createUnifiedGraphPlannerAdapter()` 在生产里总会注入一个 planner，所以改成 `guarded` 会立刻改变 `/chat` 的行为。它和 DAG planner 读同一组开关：`AGENT_PLANNER_ROLLOUT` 为 `llm`（默认）或 `guarded_llm` 时是模型 adapter `llm_unified_graph`；`deterministic` 时是 `deterministic_unified_graph`；`shadow` 时以确定性图为主；`configured` 时看 `AGENT_EXECUTION_PLANNER`。
- **`AGENT_UNIFIED_GRAPH_CAPABILITIES`**：v3 图可以直接调用的 Capability id，逗号分隔，默认空。这是可信运维白名单，不是 planner 输入。每个 id 还必须是有显式图契约的已注册 Capability；审批门 Capability 仍在门上暂停。

## 冻结与解冻的经过

- **原冻结决定（2026-09-25）**：custom Skill 阶段的 typed DAG（V2）改为默认执行器，v3 统一图停在 `shadow`。解冻需要两个条件：
  1. 出现外层固定顺序表达不了、且有评测用例证明的编排需求；
  2. 四块恢复能力各自有跨进程测试：文档循环的缺口与工作记忆、整次运行的 finalization 收据、节点边界的跨进程续跑、审批续跑。
- **第一轮解冻（2026-09-27）**：条件 1 和前三块恢复满足，`guarded` 档开放，审批续跑仍冻结。原因：图内暂停与续跑要把审批对象和输入 hash 绑定到图节点，还要对“批准后执行、结果未知”的状态做跨进程恢复，当时没有这块证据；常设授权只存在于原请求里，恢复进程无法重建。所以当时任何可能中途等待用户确认的节点都会让整图在运行前被拒，由 V1 回答。
- **第二轮解冻（2026-09-27）**：审批续跑落地并有跨进程测试，含一个审批门 Capability 的图可以进图（见「图内审批续跑」）。
- **仍冻结的部分**：见「剩余冻结与未完成项」。

### 条件一：编排需求与评测用例

trajectory 用例 `unified_graph_evidence_gated_skill_hand_off`（manifest 1.13.0 加入，现为 1.14.0）固定了 V1 表达不了的路径：
- 风险审查请求先由所选文档作答。只有该答案通过自身的 `document_evidence_check`，才运行 `risk_review`，并把已验证的文档答案作为类型化 `priorFindings` 交给它。
- 证据不足时，Skill 以 `condition_not_met` 跳过，不计费，文档循环向用户澄清。
- 同一请求在 V1 上（chain 与 V2 DAG 两种执行器、两种证据变体）每次都先无条件运行 Skill，从不运行 `document_rag`，Skill 提示词不含上游段落。原因是 V1 的 `custom_skills` 固定排在 `document_rag` 与 `web_search` 之前，条件只有 `selected_custom_skills`，没有证据谓词。
- 最初设想的例子“文档证据不足 → Web → 把 Web 结果交给 Skill”按设计不被准入（见「准入规则」的数据边界），检查 `web_to_skill_hand_off_refused` 固定了这一拒绝。
- 证据类型：确定性注入提案加 mock provider。mock 的 Skill 答案与上游段落无关，所以它只证明编排与运行时契约（跑什么、花多少、Skill 收到什么类型化输入、收据、一请求一路径），不宣称答案质量提升，也不是真实模型规划证据。

### 条件二：四块跨进程恢复

测试文件是 `server/test/agent-unified-graph-postgres.integration.test.mjs`，使用真实 PostgreSQL run store：第一个进程在指定写入处退出，再另起一个 Node 进程执行生产启动恢复或审批决定。它属于 `npm run test:pgvector`，需要 `PGVECTOR_TEST_DATABASE_URL`，没有时报告为跳过。共 7 个跨进程用例：

1. **文档循环的缺口与工作记忆**：进程在 follow-up 节点完成后退出。重启后 primary 与 follow-up 都被复用，不重复执行、不重复计费（`documentRagCalls` 为 2）。claims、evidence gaps、executionLoop 与未中断的运行一致，resolved 与 unresolved 两种结局都覆盖。这些状态由 `agent-unified-graph-document-loop.js` 从已持久化的 typed 输出重建，不依赖进程内存。
2. **整次运行的 finalization 收据**：
   - 收据写入后崩溃：恢复只用收据完成 run，答案逐字相同。
   - 收据写入前崩溃（图已 completed）：从同一批持久化节点输出重算，不执行任何节点，结果与未中断运行一致。
   - 之后再次启动不会产生第二个答案：claim 已用尽，run 已终结。
3. **节点边界的跨进程续跑**（两个用例）：
   - 只复用 typed-output 摘要能对账的已完成节点，待执行节点在新进程运行。篡改收据摘要会进入人工恢复（`completed_step_without_checkpoint`）。进行中的文档调用（step 为 running）进入人工恢复（`unknown_in_flight_node`），绝不重放。
   - 因证据检查通过而跳过的 Web 回退：恢复进程没有常设 Web 授权也能完成。Skill 版本提升后，已封存答案的运行仍能完成；需要重算的运行在 claim 下转人工（`graph_resume_failed`）。
4. **审批续跑**（三个用例）：
   - 进程 A 暂停、进程 B 批准，Capability 恰好写一次。
   - 批准后的写入完成、收据写入前，进程真实退出（exit 17）：下次启动转人工，不重放。
   - 在另一个进程中拒绝：同一张图收尾，不做这次写入。

## 准入规则

`guarded` 在任何节点执行前对整图判定（`server/rag/agent-unified-graph-admission.js`）。规划、校验和准入都不写持久状态，所以被拒的请求可以原样交给 V1。不要为了让某个图能准入而放宽这些规则。

**数据边界**：
- 有外部副作用的节点（Web 搜索、外部 Capability）只读用户自己的请求：字符串输入只能绑定 `request.question`，不能绑定上游输出（`external_input_not_request_question`）。文档派生文本因此不会发给第三方搜索服务。
- 外部节点的输出不能绑定进任何其他节点的输入（`external_output_hand_off`）。Web 文本是基于外部网页的模型输出，只有 finalizer 把它当作不可信证据处理，所以它只进入最终答案，不进入 Skill 提示词。基于它的布尔 `when` 条件仍然允许。
- 意图要求读取所选文档时（`plan.wantsDocumentRag` 且 docIds 非空），图中必须有一个无条件、无依赖的主 `document_rag` 节点（`document_request_without_document_node`）。意图没有要求 Web 时，Web 节点必须挂在主文档答案自身 `document_evidence_check` 的 `passed == false` 上（`web_not_gated_on_document_evidence`）。这相当于把 V1 的“文档弃答或失败才走 Web”扩展为“文档答案未通过证据检查才走 Web”。

**意图节点**：图必须包含意图本身的节点，即意图的自定义 Skill（或 chain 中每个 Skill）、workspace action 的 Capability，或独立的 inventory / discovery / Web 节点（`intent_skill_missing`）。否则 finalizer 只能给出“Skill 未完成”。research brief 和 arXiv import 在 v3 目录里没有节点，一律由 V1 回答。这条规则是真实模型测试暴露缺口后加的。

**审批**：
- 直连的审批门 Capability 可以进图，每个图最多一个（`multiple_approval_gated_capabilities`）：run store 同一时间只持有一个待决的图审批门。
- Web / 文档发现这类内置包装节点，如果请求没有常设、与输入无关的授权，整图拒绝（`approval_required_without_standing_grant`）。它们的审批发生在 execute 内部，不在节点边界，停在那里会留下 running 收据。

**投影形状**（`describeUnifiedGraphProjectionShape`，不符即 `graph_not_projectable`）：图必须能投影回 `finalizeAgentRun` 使用的旧执行状态：
- 最多一个主 `document_rag` 节点，加至多一个 follow-up：以主答案自身检查的 `retryRecommended == true` 为条件，`question` 绑定该检查的 `followUpQuestion`；
- 最多一个 Web 节点；
- inventory 与文档发现只能单独成图；
- 最多一个 Capability 节点，而且只能是意图要求的动作：`plan.mode` 为 `workspace_action`，节点为 `capability:<actionCapabilityId>`。

**拒绝怎样记录**：执行前的任何拒绝都记成一条 `unified_graph_planned` 事件（`status: "rejected"`、`fallback: "v1"`，带原因码）和一个 `unified_graph_fallback` trace 步骤，然后由 V1 回答。除上面的原因码外：
- 已有 run 的重入（例如 V1 审批暂停后由后台任务续跑）留在 V1（`reentry_stays_on_v1`）；
- 没有可持久化的 run store 时拒绝（`durable_runtime_unavailable`）；没有注入 planner 时也记录拒绝（生产总会注入）；
- 模型提案和兜底的确定性图都不可准入时，记录 validator 或准入的原因码；
- **选中后 stage 拒绝**：stage 用实时服务重建目录并再次校验。首次写 checkpoint 之前的拒绝（例如所选文档在规划与执行之间被另一实例删除）追加一条带 `supersedes: "selected"` 的 `rejected` 事件，原因码列表以 `stage_refused_before_execution` 开头，然后由 V1 回答。`hasUnifiedGuardedGraphPath` 以最新一条 planned 事件为准。

## 执行边界

- 一次请求只走一条路径：V1 外层流程，或统一图。不能先跑 V1 的某个阶段，再把它当作图节点的未记录前置结果。
- 被接纳后（`selected` 事件，没有 `execution_planned` 事件），请求只在图上执行。从 stage 首次写 checkpoint 起不再回退 V1。节点失败时，run 以 409 `AGENT_UNIFIED_GRAPH_PARTIAL` 失败结束；唯一例外是主 `document_rag` 节点因依赖故障失败，这时图停下，按依赖故障回答 503 `AGENT_DEPENDENCY_UNAVAILABLE` 或 504 `AGENT_DEPENDENCY_TIMEOUT`。
- 图与 V1 共用同一个 Agent run store、validator、预算预留、回放矩阵和带栅栏的图生命周期，不另建执行运行时或 run store。
- 结果由 `projectUnifiedGraphRun` 投影回旧执行状态，再交给同一个 `finalizeAgentRun`。
- 图内证据检查用词法的 `evaluateDocumentEvidence`；claim judge 开启时只在 finalizer 中生效。
- `/chat/stream` 在图路径上不发送 `answer_draft`：草稿只在 V1 文档循环的主调用上打开。
- 只有至少一个自定义 Skill 结果未弃答时，finalizer 才采用图证据策略。一个弃答的 Skill 节点不会让 Web 上下文变成可验证证据。
- follow-up 节点的 `question` 绑定上游输出，调用时传 `memoryWrites: false`，不写会话记忆；主 `document_rag` 节点照常记录用户这一轮。

**finalization 收据**：
- 新鲜路径先完成响应准备（run id、task continuation、经验记忆写入），再把完整响应作为 `finalization` 收据写进私有 graph checkpoint，然后完成 run。所以回放结果与未中断请求一致。
- 无收据的重算路径会再次写经验记忆。写入按确定性 memoryKey upsert，不会重复。
- 重算时从 selected 事件的 `requestContext`（脱敏的 intentPlanner 与经验记忆读取观测）恢复会话观测字段。

**已结束的 v3 运行**：以澄清结束（有收据）或部分失败（run 为 `failed`）的 v3 运行不会被重入。后台任务的 continue 或带 agentRunId 的请求会新建运行（事件 `run_continued`，payload 含 `previousRunId`），由任务记忆携带上下文，已结束的运行保持不变。其他带图 checkpoint 的运行仍由 CAS 拦截（`AGENT_GRAPH_EXECUTION_FENCED`）。

## 图内审批续跑

**暂停**：
- 调度器把需要审批的节点停在干净边界（`awaiting_approval`）：没有 step、没有预算、没有输出。不依赖它的节点继续跑完。
- 没有其他节点可跑时，基于最新 checkpoint 生成图绑定审批门。审批对象 hash 覆盖精确的解析后输入，并绑定 run、graph digest、revision 和 nodeId。
- 审批门、私有执行快照（与 V1 同一张审批快照表、同一套 policy）和 `awaiting_approval` checkpoint 在同一个 CAS 中写入（`pauseExecutionGraphForApproval`）。
- 请求返回与 V1 相同的 `capability_approval_required` 澄清，run 进入 `waiting_for_user`，不完成 run，不写收据。

**决策入口**：`/agent-runs/:runId/actions/approve|deny`（agentRunStepExecutor 识别图审批门后交给 `continueAgentExecutionGraphApproval`），或后台任务带该门 gateId 与 approvalObjectHash 的决定（批准或拒绝）重入。两者都经 `continueUnifiedAgentGraphAfterApproval` 在同一张图上续跑，不重新规划。

**决策前的检查**（任何一项不过都不做决定）：
- 错误的审批对象：`approval_object_hash_mismatch`。已决定的门再次决定：409，不写任何东西。私有快照与所示输入不符：绑定校验在决策 CAS 内失败。
- 审批门展示后 Capability 版本变了：`graph_approval_stale`，决策前拒绝，run 仍在等待。
- 读取实时 allowlist：决策和启动恢复都按当前配置读 `AGENT_UNIFIED_GRAPH_CAPABILITIES`，不用规划时封存在 checkpoint owner 里的列表；封存列表只用于核对目录身份。批准时该 Capability 已不在实时 allowlist：门保持 pending，run 以 `unified_graph_capability_not_allowed` 转人工（不取 claim），请求返回 409 `graph_approval_capability_not_allowed`。拒绝（deny）不受影响，照常以不含该 Capability 的答案结束。
- 档位不是 `guarded`（回滚到 `off` 或 `shadow`）：先把 run 标记为人工，再返回 409 `unified_graph_rollout_not_guarded`。
- 审批 CAS 拒绝已标记人工的运行，所以之后恢复 `guarded` 或 allowlist，也不会绕过 operator 重新打开它。

**批准**：
- 决策 CAS 把图重新打开为无 claim 的 `running`，用与新请求 worker 相同的 run-revision 栅栏。已完成节点按摘要复用。
- Capability 执行前，用实时 Capability、实时 policy 和当前绑定输入重算审批门（`verifyCapabilityGraphApproval`），必须与用户批准的门和私有快照一致，然后以批准的输入执行一次。
- 执行时带由 run、node 和 Skill id 派生的确定性幂等键：task.create 按该键 upsert。
- 之后依次运行下游节点、整次 finalization，写入收据并完成 run。

**拒绝**：该节点记为 `skipped / approval_denied`，下游为 `dependency_skipped`，不写任何东西。回答为“<Capability> was not run: the approval was denied.”，同样写入收据并完成 run。前端直接显示返回的最终答案（已验证的文档答案加“未执行”说明）；V1 的拒绝仍显示通用文案。

**后台任务**：
- 任务 `continue` 重入一个停在图审批门、但没有带上该门决定的运行时，原样返回存储的审批澄清（同一个 gateId 与 approvalObjectHash），不写任何东西，不重新规划（`restateUnifiedGraphApprovalPause`）。任务回到 `waiting_for_user`（`approve_capability`），保留这个门。
- 任务动作 `deny` 只适用于 `graph_capability_approval` 门。它和 approve 一样要求 gateId 与 approvalObjectHash 同待决门一致，映射为图的拒绝决定。V1 门的拒绝仍在 agent run 上进行，任务动作对 V1 门返回 409。
- 与门不符的决定（缺 gateId 或 hash 不符）返回 409 `graph_approval_not_pending`。

**续跑出错**：
- 请求被取消：超过 deadline 时 run 失败，客户端离开时 run 取消，都不转人工。已开始的批准节点先跑完，写入的 Capability 从不中途中止。
- 图已被另一个 worker 接管（`AGENT_GRAPH_EXECUTION_FENCED`）：原样抛出，不改动 run。
- 部分失败的图：run 失败。其他错误：转人工（`graph_approval_continuation_failed`）。续跑中遇到依赖故障也属于这一类。
- Capability policy 拒绝解析后的输入（例如必填字段绑定到空的上游输出）：该节点经生命周期记为失败，不崩溃，也不执行。

## 启动恢复

- 只有 run 的事件证明它走了 guarded 图路径（`hasUnifiedGuardedGraphPath`）时，v2 checkpoint 才交给 v3 续跑。
- 只有 `AGENT_UNIFIED_GRAPH_ROLLOUT=guarded` 时才自动续跑或完成 v3 图。回滚到 `off` 或 `shadow` 后，这类运行以 `unified_graph_rollout_not_guarded` 转人工，不取 claim。
- 可以续跑的是 phase 为 `running` 或 `completed` 的 v2 checkpoint。phase 为 `partial`（有节点失败）的图从不由启动恢复完成，转人工（`graph_finalization_requires_recovery`）。已经以澄清结束（有收据、run 为 `waiting_for_user`）的运行直接跳过。
- claim 之前先把 run 的 LangGraph 线程与 v2 checkpoint 对账：矛盾转人工（`langgraph_thread_mismatch`），saver 拒绝读取的记录转人工（`langgraph_thread_unreadable`）。细节见 ADR 0001 阶段 3。
- 有收据时先回放收据，再比较实时 Skill 目录，所以部署提升 Skill 版本不会让已封存答案的运行卡住；需要重算时，目录变化仍会被拒绝。
- 已复用输出判定为不会运行的节点不算待运行节点，例如证据检查已通过而跳过的 Web 回退及其后续节点，所以恢复进程没有常设 Web 授权也能完成。
- 待运行节点在恢复时再过一次准入的审批检查。恢复进程拿不到原请求的常设授权，所以待运行的 Web / 文档发现节点如果需要授权，运行转人工，不执行。
- stage 每次续跑（审批决定之后、启动恢复时）都对每个待运行（未完成、也不会被跳过）的 Capability 节点核对一次实时 allowlist，不在列表中则抛 `AGENT_GRAPH_CHECKPOINT_REQUIRES_RECOVERY`。已批准但尚未启动的节点因此同样尊重撤销：启动恢复时运行转人工（`graph_resume_failed`），不写入。
- 复用的节点不再执行。它们持久化的收据重新放进这次响应的 trace，检索查询放回工作记忆，所以重建的状态与未中断运行一致。
- 审批相关的状态：
  - 批准后、Capability 的 step 尚未开始时崩溃：启动恢复可以取 claim，读取同一批准，执行一次。
  - Capability 已写入、收据之前崩溃（step 为 running）：转人工（`unknown_in_flight_node`），绝不重放。
  - 干净停在审批门的运行：`guarded` 下跳过，不改动。非 `guarded` 下以 `unified_graph_rollout_not_guarded` 转人工，状态保持 `waiting_for_user`，出现在 `/agent-runs/recovery` 并带 cancel 动作。
- 持有 claim 的 worker 自己续跑失败后，会在同一 claim 下标记人工恢复（`markManualRecovery({ expectedGraphResumeClaimId })`，原因 `graph_resume_failed`），运行不会停在 `running`、被以后的扫描永久跳过。不带 claim id 时，run store 仍拒绝标记被 claim 的运行。

## 规划器

- 模型 adapter 在 `agent-unified-dag-planner-adapter.js`，prompt 为 `unified_graph_planner@v1`，已登记在 prompt catalog，指纹由 `test/prompt-registry.test.mjs` 固定。
- response_format 是按请求从运行时授权目录生成的严格 JSON Schema：
  - nodeId 必须是 skillId 或 skillId_2..9；
  - 绑定和 `when` 只能引用来源 Skill 声明的同类型输出；
  - object 输入只接同名（或 `followUp` 前缀变体）的输出；
  - 节点不绑定自己 Skill 的输出；
  - 受限的 docIds 只接请求值；
  - 字符串用 `pattern` 限长，数组有 `maxItems`。
- 解析回复中第一个完整 JSON 值。validator 与准入仍是最终权威：解析、校验或准入任一失败，就整图换成确定性图，绝不部分执行；确定性图也不可准入时，由 V1 回答。
- planner 只看到脱敏上下文：目标、意图标志、授权 docIds 及数量、目录描述、限制、剩余预算。从不看到文档文本、access scope、用户或工作区身份、审批和密钥。
- 每次决策记录在 `unified_graph_planned.payload.planner`：fallback、原因码与原因、`plannerCall`（延迟、tokens、prompt 模板、模型路由、response format 摘要）。

**shadow 观测**：
- `AGENT_UNIFIED_GRAPH_ROLLOUT=shadow` 时，若规划开关带旁路 planner（`AGENT_PLANNER_ROLLOUT=shadow`），观测的是该模型 planner；否则观测主 planner（默认 `llm` 下就是模型 adapter）。
- 观测不使用 fallback（`allowPlannerFallback: false`）：模型计划失败、解析失败、没通过 validator 或没通过准入时记为 `rejected` 并带原因码，不会被确定性图替换后记成成功。
- shadow 和 `guarded` 面对同一个规划问题：同一份 Capability allowlist（`AGENT_UNIFIED_GRAPH_CAPABILITIES`）、同一个基础 Capability 注册表，图通过 validator 后再跑同一个 `assessUnifiedGraphAdmission`（带本次请求的审批）。所以 `selected` 表示这张图交给 `guarded` 的准入会被接受，`rejected` 带准入的原因码。但 `guarded` 实际规划出的图可能不是这张：`AGENT_PLANNER_ROLLOUT=shadow` 时 shadow 观测旁路的模型，`guarded` 用确定性图；模型提案被准入拒绝时，`guarded` 会整图换成确定性图。所以 shadow 的 `rejected` 不代表 `guarded` 会交给 V1 回答。`blockedSkillIds` 只在准入拒绝时出现（`selected`、规划器拒绝和 error 时没有这个字段），按 Skill id 记被挡住的节点，不记节点 id；图级原因（`graph_not_projectable`、`intent_skill_missing` 等）不挡具体节点，这时是空数组。它不检查只有执行时才检查的东西：持久化 run store、重入的 run、stage 在第一次写 checkpoint 前的拒绝（stage 用同样的入参重做 validator 和准入，所以那里的拒绝只来自运行时条件）；入口的 `assertRuntimeEntryAllowed`（LangSmith、`AGENT_RUNTIME`）启动时已经拒绝这些配置。2026-10-18 之前 shadow 不做准入、也不传 allowlist，那时的 `selected` 只说明通过了 validator，含 Capability 的意图上 `rejected` 也不代表 `guarded` 会拒绝。
- 事件带 `planner.fallback`、`selectedPlannerId` 和 `plannerCall`。
- 已知限制：shadow 规划在请求路径上同步等待，7B 模型约 8 s 的规划会计入 shadow 请求延迟；`guarded` 在 `AGENT_PLANNER_ROLLOUT=shadow` 下用确定性图，不做旁路模型规划。

## 真实模型规划

结论：运行时契约（validator 与准入整图拒绝、兜底不部分执行）在真实模型下成立；本地 7B 模型的 v3 计划大多被拒，执行主要靠确定性兜底图，不能作为模型规划能力的证据，需要更强的模型再测。

**前提**：
- 本地 Ollama 上的 qwen2.5:7b，不是 GPT 级模型。
- 只有 planner 调用模型；RAG、Skill、Web、task.create 都是 mock，所以失败的只是规划。这是 mock 文档服务加真实模型规划的证据，不是答案质量证据。
- 命令：`cd server && npm run eval:unified-graph-planner -- --real --runs 3`，跑统一图的两个 trajectory 用例，共 15 次规划。
- 报告（1.1.0 版）写到 git 忽略的 `server/evaluation/results/latest-planner-unified-graph-<provider>.*`。`summary.lineage` 列出实际运行过的 prompt 模板、模型路由和 response format schema 摘要；`evidence` 块记录 commit、工作区是否 dirty 和全部 prompt 模板。只在附带 lineage 时引用它的数字。

**结果（2026-09-27，lineage：commit 85efbb6a 加未提交改动（dirty），`unified_graph_planner@v1#037c0f5c79da`，在最后一次运行时代码修改之后重跑）**：
- 模型自己的计划被接纳 3/15；12 次换成确定性图；0 次由 V1 回答。
- 回退原因：`intent_skill_missing` 6、`graph_not_projectable` 4、`illegal_output_reference` 4（绑定了没列进 dependsOn 的节点）、`approval_required_without_standing_grant` 1。
- 检查 37/45，用例 0/6（planner 模式检查 `model_plan_used` 没有一次通过）。
- 两项运行时检查各失败 1 次，都来自模型计划的形状：一次任务描述没有绑定到已验证答案；一次 `when` 条件把 task.create 跳过，导致没有门可以拒绝。
- 每次规划延迟 mean/p50/max 为 8140/8226/10778 ms，tokens 平均 2044。

**更早的测量，不再作为结论引用**：同日更早一次运行没有 lineage，而且测量之后运行时代码仍有改动。它得到模型计划接纳 2/15，已被上面的 3/15 取代。同一批里 `npm run eval:planner -- --real` 跑了 3 次：用例 16/21，检查 72/81；新用例 `planner_unified_graph` 三次都没通过 `unified_planner_selected`（1 次 `illegal_output_reference`，2 次 `intent_skill_missing`），既有的 `planner_dynamic_skill_graph`（V2 DAG planner，那一轮没有改动）三次中失败两次。

## 设计不变量

**目录与图契约**：
- 运行时从注册表构造权限过滤后的候选目录（`skills/unified-graph-catalog.js`）：每项有稳定 `id/version`、显式 input/output schema 和 effect/idempotency/replay 契约。选中文档逐个用可信 `accessScope` 核验；未核验、空范围或已撤权的文档不进入可执行输入。模型或请求文本不能发明 Skill、扩大 `docIds`，也不能设置身份、审批、密钥、预算、并发与重试上限。Capability 适配器只在可信 allowlist 列出时进入目录。构建目录本身不执行任何东西（该模块的 `executionWired` 始终为 false），只有 guarded 路径在准入后执行从中取出的图。
- 图节点有唯一 `nodeId`、能力 ID、声明依赖、类型化输入绑定和失败策略。validator 在任何节点运行前整图校验，非法图不会部分执行。scheduler 只把已完成、已校验、已持久化的上游声明输出字段交给下游。条件分支只用预定义、可校验的结果谓词（如 `passed == false`、`retryRecommended == true`），不执行 planner 写的表达式。
- 输出契约在节点完成后、下游可调度前强制检查。完成步骤的收据记录完整 typed output 的稳定摘要（包括 citation 身份），与私有图 checkpoint 对账。无摘要的旧收据、摘要/类型/Skill 版本失配都拒绝自动恢复，不能靠重新执行“修复”。结构校验不等于语义证据支持；最终回答仍走现有 self-check、citation 绑定与 finalizer。
- v3 图的节点步骤类型为 `graph_node`，身份为 `agent_graph_node:<编码后的 nodeId>`，配套 v2 checkpoint；custom Skill DAG 仍用 `custom_skill:<nodeId>` 与 v1 checkpoint。所有节点都受同一图 claim/CAS 约束，不能绕开图走通用单步骤重试。
- Web 是受控的外部读取节点。Capability 以注册的 `capabilityId`、它的 policy 和审批门为准，未经批准绝不执行写操作。

**文档节点、预算与副作用**：
- 图里的文档循环是三个节点：primary `document_rag` → graph-only 的 `document_evidence_check`（复用确定性证据评估，输出 `passed`、`retryRecommended`、`followUpQuestion` 和可选的 `followUpRetrievalPlan`）→ 条件 follow-up `document_rag`（显式绑定检查节点的输出）。
- primary 与 follow-up 是两个独立的 `document_rag` 调用，各从运行时预算原子预留 1 次（`documentRagCalls`）。只有检查节点确实建议 follow-up 时才调度第二次；不能让文档循环对同一调用重复计费。预算不够时，节点在启动前以 `budget_exhausted` 跳过，并照常写预算限制的 trace 步骤。
- `ragService.chat` 会记录 session turn，有 `userId` 时可能写 long memory。所以 `document_rag` 声明 `workspace_write`、`adapter_defined`、非并行安全、不可自动重放，不能视为纯读取。未知进行中的调用只能进入人工恢复，除非以后引入经验证的幂等键或事务 outbox。
- 图结束后，`agent-unified-graph-document-loop.js` 只从持久化输出重建 claims、gaps 和循环计数，跨进程恢复后 follow-up 只计一次，证据缺口不丢。与 V1 的有意差异：图内检查是词法的；是否 follow-up 由图决定，primary 检查建议 follow-up 而图里没有 follow-up 节点时，以 `follow_up_limit_reached` 结束（与 V1 到达 follow-up 上限时一样）。

**持久化、恢复与最终回答**：
- 图、owner（scope、请求与目录版本、预算上限）、节点结果和版本化进度都私存于现有 run store。节点开始、子步骤、节点完成和最终 run 状态使用同一 run-revision CAS/claim 栅栏。
- 批准后的 Capability 绑定原审批对象和输入 hash，执行后的未知状态不能自动补跑。
- 恢复先核对 owner、注册表契约、授权文档、步骤收据、typed-output 摘要和已扣预算，再只复用已完成且可证明一致的节点。任何不明的 active/paused 子调用、已完成子步骤但缺图 checkpoint、失效审批、过期 claim 或矛盾收据都进入人工恢复。
- 投影产物是 `finalizeAgentRun` 需要的 `customSkillResults`、`ragResult`、`webResult`、Capability 答案与 clarification。保留 `/chat` 的响应字段、status、citations/source identity、`agentObservability`、审批交互与前端 trace。

## 验收清单

| 项 | 状态 |
| --- | --- |
| 契约与安全底座：`v3` 图、独立节点收据、`v2` checkpoint、受限目录、注入式规划边界、投影 | 已落地。非法节点、越权文档、非法类型、条件边、循环和超限在零执行时整图拒绝 |
| 文档节点：primary → 检查 → 条件 follow-up，缺口、工作记忆、循环计数 | 已落地，状态从持久化输出重建；跨进程用例 1 |
| 审批 Capability 与最终合成 | 已落地，限于一个、且是意图本身要求的 workspace action；任意内置/Capability 组合不支持 |
| 恢复：部分完成图、收据篡改、未知 in-flight、finalization 中断、审批续跑 | 已落地，四块各有跨进程 PostgreSQL 测试 |
| 发布：`off` 保持 V1，`shadow` 只记录，`guarded` 仅在首节点执行前回退 V1 | 档位已实现；默认 `off`，没有逐级灰度，V1 不删除 |
| 评测门禁 | 确定性：两个 trajectory 用例已钉进 manifest（1.14.0），planner 评测有 `planner_unified_graph`。真实模型：只有本地 7B 的规划评测；GPT 级模型的规划评测和 `release:gate` 证据都没有，mock PASS 不能替代 |

## 剩余冻结与未完成项

- **仍由 V1 回答的请求**：research brief 和 arXiv import（v3 目录里没有节点）；没有常设授权的 Web / 文档发现；第二个审批门 Capability，或不是意图本身动作的 Capability；V1 拥有的 run 的重入。已结束的 v3 运行不重入，续接时新建运行。ADR 阶段 5「没有做的部分与理由」有完整列表。
- **与 V1 的有意差异**：图内证据检查是词法的；图路径没有 `answer_draft`；非主节点（follow-up、Web、custom Skill）失败或遇到依赖故障时以 409 `AGENT_UNIFIED_GRAPH_PARTIAL` 结束；审批续跑中遇到依赖故障进入人工恢复。
- **规划**：本地 7B 的计划大多回退；shadow 规划同步等待；`guarded` 在 `AGENT_PLANNER_ROLLOUT=shadow` 下不做旁路模型规划。
- **证据**：GPT 级模型的规划评测，以及 `release:gate` 要求的同 SHA、干净工作区报告还没有生成。

## 测试与评测入口

- 内存套件都在 `server/test/`：`agent-unified-graph-*.test.mjs` 一组（主要是 `boundaries` 准入与数据边界、`guarded`、`approval`、`shadow`，另有 catalog、projection、stage、results、response、answer、recovery-eligibility），`agent-unified-dag-planner.test.mjs` 与 `agent-unified-dag-planner-adapter.test.mjs`，`unified-graph-planner-eval.test.mjs`，以及 LangGraph 一侧的 `langgraph-unified-graph.test.mjs`、`langgraph-unified-graph-without-run-target.test.mjs`。
- 跨进程：`agent-unified-graph-postgres.integration.test.mjs`（7 个用例，见「条件二」）。审批续跑落地时（2026-09-27），它和 `agent-execution-graph-postgres.integration.test.mjs` 两个 agent 图 PostgreSQL 套件合计 14/14 通过。
- trajectory 用例：`unified_graph_evidence_gated_skill_hand_off` 与 `unified_graph_approval_gated_action`（manifest 1.14.0，共 13 项检查）。后者同时测量同一请求在 V1 上的表现：V1 只运行动作，审批的任务描述是原始问题，没有文档答案。两者都是确定性注入提案加 mock，属于运行时契约证据。
- 确定性评测（2026-10-18）：trajectory 84/84 项检查（19 个用例），planner（mock）7/7 个用例、27/27 项检查。
- 真实模型规划：`cd server && npm run eval:unified-graph-planner -- --real --runs 3`（见「真实模型规划」）。
