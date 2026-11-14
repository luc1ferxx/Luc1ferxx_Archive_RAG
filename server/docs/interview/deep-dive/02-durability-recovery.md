# 02 运行持久化、审批与崩溃恢复

> 范围：运行持久化、审批与崩溃恢复（agent run store / CAS / 重放安全矩阵 / 图 checkpoint / 图内审批（做过，2026-11-14 随 v3 统一图删除） / LangGraph checkpointer / drain 取消 / 依赖故障 / 后台任务租约 / 优雅停机）
>
> 回到 [总手册](../DEEP-DIVE-PLAYBOOK.md)。数字出处以 [CURRENT-TRUTH.md](../CURRENT-TRUTH.md) 和 `docs/evaluation.md` 为准；代码位置写成「路径 + 函数/常量名」，均经核验代理 grep 确认。

## 30 秒讲法

Agent 的每次运行（状态、步骤、审批门、图 checkpoint）在 PostgreSQL 里是一行（steps、result 等是 JSON 列），每次状态变更是一条带 revision 的 CAS，同一条 SQL 返回提交后的行和完整事件列表，所以 /chat 路径上不回读。我不承诺 exactly-once，承诺的是「自动恢复路径不重放副作用」：启动恢复自己只续跑中断的图（先认领，在节点边界），不单独重放任何步骤，其余中断的 run 交给人；重放安全矩阵按步骤类型登记失败的步骤能不能由人重试，Skill 自己的声明只往原因码里加原因；写型 Capability 用 runId+节点的确定性幂等键，审批绑定输入的哈希；恢复时凡是「在途、说不清有没有写」的步骤一律转人工。现在生效的审批只有外层计划的 capability_call 审批。图内审批我做过：v3 统一图里的审批用 LangGraph 的 interrupt + 同一线程 Command(resume)，线程只是回执，权威是自己带 digest 的 graph checkpoint，授权永远从 run store 重读，Capability 最多执行一次，有 7 个跨进程 PostgreSQL 用例。2026-11-14 v3 统一图整个删除（用户要 agent 只有一种回答请求的方式，而数字不支持让 v3 当那一种），图内审批随它没有了；开过 guarded 的部署里没结束的 v3 run 现在交给人、只能取消。取消用 drain 而不是 AbortSignal，因为在原始 LangGraph 上实测，把 signal 交给它会让在途节点在续跑时再跑一次（至少一次）。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `server/rag/agent-runs.js` | run 服务层：mutateStoredRun（cursor 乐观尝试 + 重读重判；重试次数由各方法传入，claim、checkpoint、completeRun、failRun、recordRunStep 等用 DEFAULT_AGENT_RUN_MUTATION_RETRIES=32，无图守卫的 updateRun 和 V1 applyApprovalAction 用默认 0）、createAgentRunCursor、claimExecutionGraphResume / saveExecutionGraphCheckpoint / pauseExecutionGraphForApproval / applyExecutionGraphApprovalAction / applyApprovalAction、completeRun / failRun（hasCommittedCapabilityWrite）、markManualRecovery、stripInternalRunFields（剥私有字段，事件 id 经 toPublicRunEventIds 改写成 runId:n）。其中 pauseExecutionGraphForApproval / applyExecutionGraphApprovalAction 是图审批门，只有 v3 统一图用过，阶段 10 之后没有生产调用方，下一步删 |
| `server/rag/postgres-agent-run-store.js` | PG 存储：commitRunUpdate 的 revision CAS SQL（WHERE revision = $4）、buildRunEventListCte（同语句返回事件列表）、lockRunRowFirst（FOR NO KEY UPDATE 前导）、审批快照表与 SQLSTATE 22012（APPROVAL_SNAPSHOT_ROLLBACK_SQLSTATE）强制回滚、listRecoverable（只按 status 过滤） |
| `server/rag/agent-run-state-machine.js` | 5 个状态与合法转换（AGENT_RUN_STATUS_TRANSITIONS），终态只能自环，completed/failed 仅经显式 retry 回 running（RETRYABLE_AGENT_RUN_STATUSES） |
| `server/rag/agent-run-step-replay-safety.js` | 重放安全矩阵 STEP_REPLAY_SAFETY_MATRIX、isStepRetryAllowed（失败的步骤能不能由人重试）与 buildStepReplaySafetyAssessment（原因码）；Skill 持久化的声明只往原因码里加原因（getDeclaredContractReasonCodes）；「可自动重放」一列 2026-11-13 阶段 9 删除 |
| `server/rag/agent-run-graph-replay-guard.js` | assertStandaloneGraphReplayAllowed：图节点不能当独立步骤重放，只有图终结后新建的门或步骤可走 V1 路径；阶段 9 起凡是 custom_skill 步骤一律拒绝，不看有没有 nodeId 或 checkpoint（生效的地方：step executor 重试前的预检、run store 的 retryStep 和 updateRunStep；图自己写节点步骤走 recordRunStep，只在 run 上有 checkpoint、步骤又不是其中节点时才问它） |
| `server/rag/agent-execution-graph-checkpoint.js` | 图 checkpoint：sealExecutionGraphCheckpoint（sha256 digest）、buildExecutionGraphCheckpointOwner（owner 摘要）、digestExecutionGraphTypedOutput、reconcileExecutionGraphCheckpoint（unknown_in_flight_node 等原因码） |
| `server/rag/agent-run-recovery.js` | 启动恢复 createAgentRunRecoveryService.recoverOnStartup：runAsDatabaseSystem 下跨租户扫描、逐 run 以 runWithDatabaseTenant 处理、图认领续跑 / 其余转人工（explainInterruptedRun 只给原因，不重放；阶段 9 删除了 findAutoRecoverableStep 和单步自动重放）；阶段 10 起已存的 v3 run（v2 checkpoint）不续跑：已经收尾成向用户提问的跳过，其余转人工（unified_graph_removed，节点步骤还在执行中的是 unknown_in_flight_node）。认领前核对 LangGraph 线程（verifyLangGraphThread）是 v3 才有的一步，随它删了 |
| `server/rag/agent-run-recovery-actions.js` | 运维动作 AGENT_RUN_RECOVERY_ACTIONS：cancel / retry_failed_step（resume_from_step 阶段 9 删除，现在返回 400）；buildAgentRunRecoveryState 只对矩阵允许重试的步骤类型给出 retry_failed_step |
| `server/rag/agent-run-step-executor.js` | approve/deny/retry 入口（applyApprovalAction、retryStep；resumeStep 阶段 9 删除）；审批走外层计划的 capability_call 步骤；对着一个停在审批门上的已存 v3 run 批准或拒绝，答 409 unified_graph_removed、run 转人工（阶段 10 之前这里把 v3 图审批交给 agent.js 的图内审批续跑，已删除） |
| `server/rag/agent-run-step-lifecycle.js` | startStep / startGraphStep 开头的 throwIfRequestCancelled 安全点，图步骤带 expectedResumeClaimId |
| `server/rag/capabilities/approval-execution-snapshot.js` | 审批对象哈希（内部函数 buildApprovalObjectHash）、createApprovalExecutionSnapshot / verifyApprovalExecutionSnapshot（私有快照重算哈希，timingSafeEqual 比较） |
| `server/rag/capabilities/graph-approval-preflight.js` | preflightCapabilityGraphApproval / verifyCapabilityGraphApproval：续跑时按 live Capability 与当前绑定输入重算门。只有 v3 图内审批用过，阶段 10 之后没有生产调用方，下一步删 |
| `server/rag/capabilities/registry.js` | approvalPolicy.writesWorkspace === true 的 Capability 用 runOutsideRequestDeadline 执行，开始后不被取消打断 |
| `server/rag/capabilities/artifacts.js` | buildCapabilityArtifactIdempotencyKey：确定性幂等键（超长时截断 + sha256） |
| `server/rag/langgraph/checkpointer.js` | RunStoreCheckpointSaver：写在 run.result.__langGraphCheckpoint，经 run 服务 CAS 与写者围栏；LANGGRAPH_CHECKPOINT_RETENTION=2；DEFAULT_LANGGRAPH_MAX_RECORD_BYTES=262144；deriveLangGraphThreadId 对租户和 runId 取哈希 |
| `server/rag/langgraph/run-execution-graph.js` | runExecutionGraphOnLangGraph，唯一图调度器：非续跑时先 deleteThread（tombstone）、durability sync、RunControl drain；审批续跑 Command(resume) 的部分只有 v3 图内审批用过，阶段 10 之后没有生产调用方，下一步删 |
| `server/rag/langgraph/drain-bridge.js` | bridgeRequestSignalToDrain（signal 触发 requestDrain）、resolveDrainedInvocationError（GraphDrained 映射回请求自己的取消错误） |
| `server/rag/langgraph/unified-graph-approval.js` | buildApprovalInterruptPayload：interrupt 载荷只有 kind、nodeId、gateId:null（公开 id，不含快照和输入）；RUNTIME_RESUME_MARKER 是唯一 resume 值。v3 图内审批用的，阶段 10 之后没有生产调用方，下一步删 |
| `server/rag/langgraph/unified-graph-resume.js` | prepareUnifiedGraphApprovalResume：线程回执与 checkpoint 对账后才 resume 同一线程，矛盾即 409 转人工。同上，阶段 10 之后没有生产调用方 |
| `server/rag/agent-removed-unified-graph.js` | v3 统一图留下的全部代码（阶段 10 新增，复核修正之后 136 行）：认出已存的 v3 run（看 checkpoint 版本），判断它是不是已经收尾（run 已结束，或已收尾成向用户提问），决定交给人时用什么原因，拒绝续跑；不运行任何节点，也不决定任何审批门。原来这一行是 langgraph/unified-graph-recovery.js（verifyLangGraphThreadForRecovery，认领前核对线程），阶段 10 随 v3 统一图删除 |
| `server/rag/request-deadline.js` | AsyncLocalStorage 截止时间与 signal、throwIfRequestCancelled、runAgentRequestWithCancellation、runOutsideRequestDeadline、REQUEST_CANCELLATION_CODES |
| `server/rag/dependency-outage.js` | classifyDependencyOutage 按 code/status/SQLSTATE 分类（503/504 + Retry-After，DEFAULT_OUTAGE_RETRY_AFTER_SECONDS=5）、resolveAgentRunTermination、describeAgentRequestFailure |
| `server/rag/job-orchestrator.js` | 后台任务认领 claimWithinRunningCap（租户运行上限）、createClaimHeartbeat（lease/3 续租，丢失即中止）、recoverRunnableTasks |
| `server/rag/postgres-task-store.js` | 任务写入围栏 claimed_by + attempt_count（updateTaskSnapshot）；认领条件含租约过期判断 |
| `server/rag/agent-service/role-server.js` | createGracefulShutdown：停接新连接、每 50 ms closeIdleConnections、排空在途请求、并行停 worker、按序 finalizer、exit(0) |
| `server/server.js` | 单体 handleShutdownSignals：第二个信号或 grace+SHUTDOWN_FINALIZER_MARGIN_MS（3 s）超时 exit(1)；INGEST_WORKER_STOP_GRACE_MS=5 s |

## 一次请求怎么经过这里

1) routes/chat.js 用 runAgentRequestWithCancellation（request-deadline.js）包住请求：只有设了 AGENT_REQUEST_TIMEOUT_MS、AGENT_CANCEL_ON_DISCONNECT 或有上游服务截止时间时才绑定 deadline/signal，否则原样执行。 2) runAgentRag 内建 createAgentRunCursor；agentRunService.createRun 调 store.createWithEvent（1 次 INSERT，CTE 同时返回行和事件）。 3) 外层计划的每个阶段节点入口过取消安全点（langgraph/execution-plan-graph.js：请求已取消就以 drain 停下；阶段 7 之前是 agent-execution-plan-runner.js 原生循环里的 throwIfRequestCancelled）；createAgentRunStepLifecycle.startStep 先过安全点，再 recordRunStep 到 mutateStoredRun：先用 cursor 快照乐观决定，再 commitRunUpdate：同一往返前导 SELECT ... FOR NO KEY UPDATE，然后 UPDATE ... WHERE revision = $4 + INSERT 事件 + run_events CTE 聚合事件，返回提交后的行；冲突、no-op 或被拒则重读重判。step_started 在会写记忆的 ragService.chat 之前落盘（写前意图）。 4) 自定义 Skill 阶段（只走图：V1 顺序链和 AGENT_SKILL_GRAPH_ROLLOUT 的 off、shadow 两档 2026-11-13 已删除，这个变量只接受未设置、空值或 guarded）：saveExecutionGraphCheckpoint 写带 digest 的 checkpoint，再 runExecutionGraphOnLangGraph：RunStoreCheckpointSaver 先 deleteThread（tombstone），bridgeRequestSignalToDrain 把 signal 接到 RunControl，invoke(durability sync)；每个节点 startGraphStep / 结算都带 resumeClaim 围栏；线程写走 mutateLangGraphCheckpointRecord + assertLangGraphCheckpointWriter；结算保存时 dropLangGraphRecord。 5) 需要审批的 Capability：外层计划在 completeRun 时写 pending gate（事件 approval_gate_created），状态 waiting_for_user，这是现在唯一生效的审批路径。（阶段 10 之前还有 v3 guarded 路径的图内审批：节点 preflight 被停靠，若后续层没有独立工作就 interrupt({kind,nodeId,gateId:null})，否则先跑完独立层再停，然后 stage 调 pauseExecutionGraphForApproval：一个 CAS 同时写 gate、私有执行快照（快照表）、phase=awaiting_approval 的 checkpoint、status=waiting_for_user（事件 graph_approval_gate_created），返回 capability_approval_required 澄清。v3 统一图 2026-11-14 删除，这条路径没有了。） 6) POST /agent-runs/:runId/actions/approve（routes/tasks.js，同样过 runAgentRequestWithCancellation）到 agentRunStepExecutor.applyApprovalAction：走 agentRunService.applyApprovalAction 后执行 capability_call 步骤（幂等键 parts=[runId, rootStepId, capabilityId]；writesWorkspace 的 Capability 用 runOutsideRequestDeadline 执行）。对着一个停在审批门上的已存 v3 run 批准或拒绝：409 unified_graph_removed，run 转人工。（阶段 10 之前 v3 走 continueAgentExecutionGraphApproval 到 applyExecutionGraphApprovalAction（校验 approvalObjectHash、快照绑定、门唯一且 pending，CAS 把 phase 改回 running、无 claim），再 prepareUnifiedGraphApprovalResume 核对线程回执，Command({resume:{[interruptId]: RUNTIME_RESUME_MARKER}})，节点从第一行重跑进 preflight，verifyCapabilityGraphApproval 后 capabilityRegistry.execute（幂等键 parts=[runId, nodeId, skillId]）。这条图内审批续跑随 v3 统一图删除。） 7) 收尾：completeRun（图 owner 校验、活跃步骤冲突检查）；出错 failRun：已有 capability_call 完成则 retryable:false，同一 CAS 丢弃 LangGraph 线程；路由用 describeAgentRouteError / describeAgentRequestFailure 答 504/499/503。 8) 崩溃后：下一次启动时 app.js（单体/api）或 agent-service/app.js（agent 层）调 recoverOnStartup：runAsDatabaseSystem 下 listRecoverableRuns（running/waiting_for_user 全租户），逐 run runWithDatabaseTenant：有 manual 标记跳过；有图 checkpoint 时已认领跳过；已存的 v3 run（v2 checkpoint）不续跑：已经收尾成向用户提问的跳过，其余 markManualRecovery（原因 unified_graph_removed，节点步骤还在执行中的是 unknown_in_flight_node）；custom-Skill 图先 reconcileExecutionGraphCheckpoint，再 claimExecutionGraphResume（CAS 写 UUID claim）后续跑（阶段 10 之前 v3 图也在这里续跑：干净的审批暂停跳过，认领前还要 verifyLangGraphThread）；没有图可续时不重放任何步骤，直接 markManualRecovery（running 改 waiting_for_user + manual_recovery_required），原因由 explainInterruptedRun 给出（2026-11-13 阶段 9 之前，这里是 findAutoRecoverableStep 按矩阵挑一个步骤后 resumeStep，挑不到才转人工）。 9) 计划内停机：SIGTERM 到 server.js handleShutdownSignals 再到 createGracefulShutdown：server.close + 每 50 ms closeIdleConnections，在途请求最多 SERVICE_SHUTDOWN_GRACE_MS（默认 25 s），入库 worker 并行停，再跑 app.locals.stop、span flush、resetPostgresPool，exit(0)；第二个信号或超时 exit(1)。

## 设计决策

### D1. 运行状态是 PostgreSQL 里的一行（多列 JSON）+ revision 乐观 CAS，不引入外部工作流引擎

**为什么**

已有 PG 带行级安全、备份、租户加密；一次 run 天然以 run 为单位；一条 CAS 同时覆盖状态、步骤、checkpoint、审批门和事件，状态与审计原子一致；一次 run 跨多秒 LLM 调用，长事务持锁会占满连接池

**为什么不用主流替代方案**

Temporal/Cadence：要求 workflow 代码确定性，LLM 调用要包成 activity，activity 失败重试也是至少一次，还要多运维一套集群并重做租户隔离；SELECT FOR UPDATE 贯穿整个处理：长事务持锁；Redis：持久性和 RLS 都没有；纯事件溯源：读要重放，改造大

**代价**

整行重写带来写放大，单个 run 内并发节点结算会撞 CAS（靠重读重试）；没有 Temporal 现成的定时器、长流程、可视化

**证据**

docs/evaluation.md「每次 /chat 的数据库往返（2026-09-27）」：run 回读 26 到 0（事件列表 15、run 行 11，pg_stat_statements、并发 1、按差值计）；租户 4 实例 205 到 283 req/s（+37.9%，模型 0 ms、并发 32、同机，其中也含租户语句流水线的贡献）；test/agent-run-chat-statement-count.test.mjs 固定 1 次插入、3 次 CAS、2 次事件追加、0 次读

**代码**：server/rag/postgres-agent-run-store.js commitRunUpdate；server/rag/agent-runs.js mutateStoredRun / DEFAULT_AGENT_RUN_MUTATION_RETRIES

### D2. 写语句同条返回提交后的行和完整事件列表；CAS 前同一往返先 FOR NO KEY UPDATE；run cursor 只作乐观 CAS 基准

**为什么**

消除每次步骤流转后的回读；CAS 语句的快照在开始时拍，如果它在等行锁时有 appendEvent 提交（不改 revision），返回列表会漏事件，所以先锁行再拍快照

**为什么不用主流替代方案**

写后再 SELECT：多 26 次读；进程内缓存 run：多实例和并发下会脏；SERIALIZABLE 隔离：全局重试开销大

**代价**

cursor 的事件列表可能落后于不改 revision 的追加，依赖事件的判定必须 requiresFreshRun；reuseBaseEvents 只给 LangGraph 线程写用

**证据**

CURRENT-TRUTH.md 3.15：审查发现「CAS 等锁期间并发追加的事件没出现在返回列表里」，改为同一往返先 FOR NO KEY UPDATE（代码注释在 buildRunEventListCte 上方）

**代码**：server/rag/postgres-agent-run-store.js lockRunRowFirst / buildRunEventListCte；server/rag/agent-runs.js createAgentRunCursor

### D3. 用重放安全矩阵代替 exactly-once：没有步骤被单独自动重放；矩阵按步骤类型登记 replayActions（失败后能不能由人重试）/ idempotency / requiredInput / 审批策略，Skill 持久化的声明只往原因码里加原因

**为什么**

外部写和 step 完成落盘之间总有崩溃窗口，存储层无法证明旧 worker 写没写；所以不去证明「恰好一次」，而是规定中断之后谁可以再跑。现在的规则（2026-11-13 阶段 9 起，CURRENT-TRUTH.md 3.50）：没有步骤被单独自动重放。启动恢复自己只续跑中断的图（条件见 Q2），其余中断的 run 交给人；矩阵登记的是重放每类步骤会冒什么风险（原因码），以及它失败后能不能由人重试。custom_skill 的 replayActions 为空、retryable:false、幂等类别 graph_owned、原因码 graph_node_step：custom Skill 只作为图节点运行，它的步骤不单独重试，也不单独重放。document_rag / follow_up_retrieval / research_question 都标 memory_writing_rag：现在只有主 document_rag 真写会话和长期记忆，后两者传 memoryWrites:false，但注入的 ragService 不一定遵守，所以保守地都当成会写记忆，中断了转人工，失败了可以由人显式重试；capability_call 要哈希绑定的已批准门，失败了可以由人重试；web_search 是不确定的外部读、arxiv_import 是靠导入器去重的写，这两类需要审批的主步骤不能直接重试（处理器一直拒绝，要重试的是审批后排进来的 capability_call 步骤），矩阵里 replayActions 也是空的（阶段 9 的独立复核之前矩阵列着重试，恢复面板因此给过一个点了必 409 的按钮）。阶段 9 之前矩阵还有「可自动重放」一列，唯一的一项是 custom_skill（幂等类别 read_only_rag）：没有图 checkpoint 的 custom_skill 步骤在启动时整步重放。这种步骤只有已删除的 V1 顺序链写得出来（图节点的步骤一定带 nodeId，会先被回放守卫拒绝），所以这一列连同独立处理器一起删了

**为什么不用主流替代方案**

LangGraph/Temporal 默认的「从 checkpoint 重跑在途节点」（至少一次）；全部转人工（可用性差，所以对账一致、停在节点边界的图仍然自动续跑）；信任 Skill 自报 replaySafe（可伪造，所以未知 effects 当写处理，声明只进原因码，放宽不了矩阵的结论。阶段 9 之前，单步重放一个步骤之前 custom-research-steps.js 还用 live registry 的 isSideEffectingSkill 复核一次；单步重放删除后这次复核也没有了，文件改名 research-steps.js，只剩研究子问题的重试，isSideEffectingSkill 也删了）

**代价**

最常见的崩溃（主 document_rag 步骤在途）会转人工，不自动恢复；显式 retry_failed_step 重试主 document_rag 会再记一次用户的交流，不是 exactly-once；失败的 custom Skill 节点不能单独手动重试：图运行的步骤拒绝单独重试（409 AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY），以前只有 V1 顺序链的步骤支持，顺序链 2026-11-13 删除后这项能力没有了，也没有替代（CURRENT-TRUTH.md 3.49）；阶段 9 之后恢复面板也不再给失败的图节点「重试失败步骤」按钮（以前给，点了一定是 409），顺序链留下的旧 run 中断了只能取消、失败了不能单步重试，要得到答案只能重新提问（3.50）

**证据**

CURRENT-TRUTH.md 3.30：eval:recovery-observability 8/8，删除原生调度器前后屏蔽后逐字节一致（2026-11-13 删 V1 顺序链前后同样 8/8、逐字节一致，3.49；阶段 9 之后仍是 8/8，检查项从 29 变成 27，报告有 51 处差异，都在随功能删掉的范围内，3.50）；test/agent-run-recovery.test.mjs「agent run recovery leaves a memory-writing document step for manual recovery」「startup explains an interrupted run and never picks a step to replay」（阶段 9 之前这里是「auto recovery refuses a graph node that declared a side effect」，那条测试随单步重放一起改掉了）；test/agent-skill-step-replay.test.mjs 把 custom_skill 步骤在启动、恢复面板和重试路由上的行为写成字面期望（冻结提交 7a2e3d99 时 10 个测试，删除提交 be353b62 的 diff 里看得到每处变化；独立复核之后加了失败的 web_search、arxiv_import 两种情形，现在 12 个）

**代码**：server/rag/agent-run-step-replay-safety.js STEP_REPLAY_SAFETY_MATRIX / isStepRetryAllowed / getDeclaredContractReasonCodes / buildStepReplaySafetyAssessment；server/rag/agent-run-recovery.js explainInterruptedRun；server/rag/agent-run-graph-replay-guard.js assertStandaloneGraphReplayAllowed

### D4. 副作用不重复靠三件套：写前意图（step 先记 running）+ 确定性幂等键 + 在途未知一律转人工

**为什么**

恢复时 running/paused 的图步骤即使声明只读也判 unknown_in_flight_node，因为存储证明不了原 worker 已停（已存的 v3 run 里还在执行中的节点步骤同样以这个原因转人工）；Capability 写带 buildCapabilityArtifactIdempotencyKey（外层计划的步骤 parts=[runId, rootStepId, capabilityId]；图节点 parts=[runId, nodeId, skillId] 是 v3 图内审批用的，阶段 10 之后没有生产调用方），工件表 UNIQUE(owner_user_id, workspace_id, idempotency_key) + ON CONFLICT

**为什么不用主流替代方案**

2PC/XA：外部系统不支持；Saga 补偿：对外部读和记忆写没意义；outbox：适合消息投递，当前 Capability 写的是同库表，幂等键更轻

**代价**

幂等性在矩阵里标为 capability_defined，交给 adapter；不遵守幂等键的 Capability 没有保证；记忆写入没有幂等键

**证据**

CURRENT-TRUTH.md 3.17：跨进程审批测试 14/14，写入次数恰为 1，Capability 写入后立即崩溃的 run 转人工不重放（v3 图内审批当时的证据；v3 统一图 2026-11-14 删除，它的 7 个跨进程 PostgreSQL 用例随之删除，3.51）；ADR 0001 阶段 0 spike「2. interrupt() 续跑后副作用只发生一次」：interrupt 之前的代码跑 2 次、之后的副作用 1 次

**代码**：server/rag/agent-execution-graph-checkpoint.js reconcileExecutionGraphCheckpoint；server/rag/capabilities/artifacts.js buildCapabilityArtifactIdempotencyKey；server/rag/agent-run-step-handlers/capability-steps.js createCapabilityCallStepHandler；server/db/migrations/009_create_workspace_artifacts.sql；server/rag/workspace-artifacts/postgres-store.js（ON CONFLICT）

### D5. Fencing：恢复认领在 CAS 里写 UUID resumeClaim；节点开始/结算、checkpoint 保存、completeRun/failRun、LangGraph 线程写都校验 claim 和 checkpoint digest

**为什么**

防止 GC 停顿或分区后回来的旧 worker 继续写状态；等价于 fencing token，判定和写入在同一个 revision CAS 里；manual 标记同样让图写入被 fence

**为什么不用主流替代方案**

Redis Redlock 之类分布式锁：锁过期后旧持有者仍能写；PG advisory lock：事务级锁不能跨多秒的 LLM 调用持有，会话级锁在连接池下难管理，而且都挡不住长停顿后回来的写；只靠租约超时

**代价**

只保安全不保活：被 fence 的 worker 白干；被放弃的 claim 永不自动重放，要运维介入；挡不住旧 worker 已经发出的外部调用（所以要幂等键）

**证据**

CURRENT-TRUTH.md 3.5（较早）：PG 集成 15/15，其中 5 个是图恢复跨进程与 CAS 竞争；test/agent-run-recovery.test.mjs「an existing graph claim cannot be claimed or executed again」「a second startup worker does not mark an actively resuming graph manual」

**代码**：server/rag/agent-runs.js claimExecutionGraphResume / assertExecutionGraphRunOwner / assertLangGraphCheckpointWriter

### D6. 图 checkpoint 是权威，LangGraph 线程只存回执；自定义 RunStoreCheckpointSaver 写在 run 行上，不用官方 PostgresSaver

**为什么**

权威 checkpoint 带 sha256 digest、owner 摘要（scope、预算、docIds、问题、选中 Skill 等）和每个节点 typed 输出摘要，要和 step 回执对账；LangGraph channel state 不懂这些。写在 run 行上就和节点 step 共用同一个 CAS 与围栏，不加表、不加第二个 run store；每次调用先 tombstone 旧线程、从 checkpoint 种子重来，只有图内审批续跑才 resume 同一线程（v3 统一图的路径，2026-11-14 删除后没有生产调用方）

**为什么不用主流替代方案**

@langchain/langgraph-checkpoint-postgres 的 PostgresSaver：新的 checkpoints 表、不在本项目的租户 RLS 策略和 resumeClaim 围栏之内，且线程会变成第二个真相源；只换 checkpointer、调度器自研（ADR 方案 B）：得到两套 checkpoint；MemorySaver：不持久

**代价**

写放大：线程记录随每次 CAS 整行重写，所以保留 2 个 checkpoint、no-op 不读、完成或失败即丢弃；依赖 LangGraph 1.5.0 的若干内部行为，升级要重跑契约测试

**证据**

ADR 0001「不可放松的约束」第 2 条：不用 PostgresSaver 的 checkpoints 表；CURRENT-TRUTH.md 3.28 写放大：2 节点 custom-Skill /chat，LangGraph 比 native 多 7 次无事件 CAS、1 次 run 读、1 次事件读；完成后 result 11,894 字节（native 11,860，阶段 3 时 17,006）

**代码**：server/rag/langgraph/checkpointer.js RunStoreCheckpointSaver / LANGGRAPH_CHECKPOINT_RETENTION；server/rag/agent-runs.js mutateLangGraphCheckpointRecord

### D7. 审批绑定输入哈希，授权永远从 run store 读：interrupt 载荷只有公开 id，resume 值只用运行时标记（interrupt 和 resume 这一半是 v3 图内审批的设计，2026-11-14 随 v3 统一图删除）

**为什么**

现在生效的是哈希这一半：外层计划的 capability_call 审批，门上带 approvalObjectHash，批准请求必须带这个哈希，执行前用私有快照重算。另一半（一个 CAS 写 gate、快照和暂停的 checkpoint；interrupt 和 resume）是 v3 图内审批的设计，v3 统一图 2026-11-14 删除后代码还在共用模块里，没有生产调用方，下一步删（CURRENT-TRUTH.md 3.51）。下面是当时的设计。防 TOCTOU（批准 A 执行 B）：approvalObjectHash = sha256(规范化 {accessScope, capabilityId, capabilityVersion, executionInput, inputPreview, snapshotVersion})，gate、私有快照、暂停的 checkpoint、状态在一个 CAS 里写；LangGraph 会把客户端 resume 值作为 __resume__ 写进线程，所以只用 RUNTIME_RESUME_MARKER，客户端文本不进 run 行；续跑时 verifyCapabilityGraphApproval 按 live Capability 和当前绑定输入重算

**为什么不用主流替代方案**

把审批结果当 resume 值（可伪造、会持久化用户输入）；只记 gateId 不绑定输入；外接审批系统（范围外）

**代价**

Capability 升级版本会让待批门失效（graph_approval_stale）；admission 限制一张图最多一个审批 Capability；多一次快照读和哈希比较（前两条是图内审批当时的代价，随 v3 统一图删除）。删掉图内审批的代价：审批的任务内容不再来自已验证的文档答案，外层计划里来自原始问题

**证据**

CURRENT-TRUTH.md 3.17：过期 Capability 版本和被篡改的审批门都被拒（图内审批当时的证据）；ADR 0001 阶段 0 spike：伪造的批准、带 update / goto 的 Command 都被拒（spike 测试已在阶段 4 删除，性质由生产套件覆盖）

**代码**：server/rag/capabilities/approval-execution-snapshot.js createApprovalExecutionSnapshot / verifyApprovalExecutionSnapshot；server/rag/agent-runs.js pauseExecutionGraphForApproval / applyExecutionGraphApprovalAction；server/rag/langgraph/unified-graph-approval.js RUNTIME_RESUME_MARKER / buildApprovalInterruptPayload；server/rag/capabilities/graph-approval-preflight.js verifyCapabilityGraphApproval

### D8. 取消用 drain（RunControl.requestDrain）+ 原生安全点，不把 AbortSignal 交给 LangGraph

**为什么**

spike 在原始 LangGraph 上实测 RunnableConfig.signal：invoke 立即 reject，在途节点在后台继续跑、写入被丢，续跑时再跑一次，即至少一次。drain 在下一个 superstep 边界停，已完成节点写进 checkpoint，LangGraph 自己就不会重跑它们，再把 GraphDrained 映射回请求自己的 RequestCancelledError。诚实补充：spike 里 signal 模式靠 runner 等在途节点 + v2 checkpoint 复用也做到了最多一次，但那要额外兜底，drain 更直接

**为什么不用主流替代方案**

直接传 signal（裸用是至少一次）；强杀进程（制造崩溃窗口，转人工）；不取消（截止时间形同虚设）

**代价**

取消不是立即生效：要等在途节点到安全点；writesWorkspace 的 Capability 开始了就跑完，run 再标 retryable:false；数据库语句不读 signal；模型调用仍经 withRequestSignal 被中止，所以在途模型节点以失败结束（spike 用的 mock 忽略 signal，这点没测到）

**证据**

ADR 0001 阶段 0 spike「3. 截止时间与取消在节点边界停下」；CURRENT-TRUTH.md 3.20：修复「取消被熔断器记成失败」前 234 次运行 226 次 503，修后 234 次全部 504 deadline_exceeded、0 次 503（假模型 800 ms、截止 300 ms、并发 4/16、同机）

**代码**：server/rag/langgraph/drain-bridge.js bridgeRequestSignalToDrain / resolveDrainedInvocationError；server/rag/request-deadline.js throwIfRequestCancelled / runOutsideRequestDeadline；server/rag/capabilities/registry.js（runOutsideRequestDeadline 调用处）；server/rag/agent-runs.js hasCommittedCapabilityWrite

### D9. 依赖故障答 503/504 + Retry-After，不伪装成证据缺口；只读 code/status/SQLSTATE

**为什么**

以前主 document_rag 失败会掉到 Web 阶段，让用户「批准 Web 搜索」，误导用户；分类不读 message，错误体可以安全存进 run 和回给客户端

**为什么不用主流替代方案**

统一 500（客户端不知道能否重试）；降级成 Web 答案（误导）

**代价**

默认行为变化：后台任务遇到故障直接失败而不是暂停等 Web 审批；直连模型的连接失败被标成 dependency 而不是 model（以前还有一条：v3 非主节点故障仍是 409 AGENT_UNIFIED_GRAPH_PARTIAL，2026-11-14 随 v3 统一图删除）

**证据**

CURRENT-TRUTH.md 3.20；代码常量 DEFAULT_OUTAGE_RETRY_AFTER_SECONDS = 5

**代码**：server/rag/dependency-outage.js classifyDependencyOutage / resolveAgentRunTermination / describeAgentRequestFailure

### D10. 后台任务用 claimed_by + attempt_count 围栏、60 s 租约、lease/3 心跳；幂等 key 哈希成任务 id

**为什么**

任务是长时间后台工作：心跳丢失时任务自中止，避免两个 worker 同时跑；启动恢复（或管理员 recover-tasks 动作）扫到租约未过期的任务会按剩余租约延迟重试，过期后才接管，仍在心跳的任务抢不走；触发器重复投递得到同一个任务

**为什么不用主流替代方案**

只靠启动扫描、不设租约（run 现在就是这样，见边界）；消息队列 exactly-once 语义（依赖外部 MQ）

**代价**

崩溃任务最快在租约到期（最长 60 s）后才被接管，而且要有进程跑过恢复扫描；租户运行上限下任务会延后

**证据**

无实测（代码常量 DEFAULT_TASK_CLAIM_LEASE_MS = 60_000，心跳间隔 Math.floor(claimLeaseMs / 3)）

**代码**：server/rag/job-orchestrator.js createClaimHeartbeat / claimWithinRunningCap / recoverRunnableTasks；server/rag/postgres-task-store.js updateTaskSnapshot；server/rag/agent-tasks.js buildIdempotentAgentTaskId；server/rag/tasks.js DEFAULT_TASK_CLAIM_LEASE_MS

### D11. 单体优雅停机复用拆分角色的 createGracefulShutdown，排空 HTTP 请求而不是立即退出

**为什么**

docker stop 会切断进行中的 /chat；在途请求允许在 SERVICE_SHUTDOWN_GRACE_MS（默认 25 s）内完成，入库 worker 并行停（5 s 后把任务交回队列），finalizer 再给 3 s，总时间低于 compose stop_grace_period 30 s

**为什么不用主流替代方案**

收到信号立即退出（切断请求，留给启动恢复）；只靠 k8s preStop sleep（不知道在途请求何时完成）

**代价**

只覆盖 HTTP 请求；进程内后台 agent 任务仍被切断，留给下次启动恢复；超过窗口的连接被强关

**证据**

CURRENT-TRUTH.md 3.25：在 /chat 处理到一半时发 SIGTERM，请求 200、运行完成、进程以 0 退出（test/monolith-graceful-shutdown.test.mjs）

**代码**：server/rag/agent-service/role-server.js createGracefulShutdown；server/server.js handleShutdownSignals / SHUTDOWN_FINALIZER_MARGIN_MS / INGEST_WORKER_STOP_GRACE_MS

### D12. 对外投影里把共享 BIGSERIAL 事件 id 改写成 runId:n（按 id 在本 run 内的排名）

**为什么**

事件表的 event_id 是所有租户共用的序列，id 间隔会泄露其他租户的事件量；排名稳定，因为每次插入事件都先锁 run 行、在锁下取 id；PG 存储按 id（提交顺序）列事件，而不是 created_at（事务开始时间，在拿锁前取，两个并发追加可能和编号顺序相反）

**为什么不用主流替代方案**

每个 run 单独一个序列（要为每个 run 建对象）；直接暴露 id（侧信道）

**代价**

导出和对外接口要统一做映射（tenant-records.js 的 createExportEventOrdinalMapper 也做了）

**证据**

无实测（设计约束，AGENTS.md「Public event ids」）

**代码**：server/rag/agent-runs.js toPublicRunEventIds / stripInternalRunFields；server/rag/tenant-records.js createExportEventOrdinalMapper

## 追问阶梯

按面试官的追问顺序排。先自己出声答一遍，再看要点。⚠ 是这题最容易答错或夸大的地方。

### Q1. 一次 agent run 在库里长什么样？有哪些状态？

*L1 是什么*

- 一行 run：status、goal、input、plan、steps、observations、decisions、approval_gates、result、error、revision
- 另有事件表和审批快照表
- 5 个状态：running、waiting_for_user、completed、failed、canceled；终态只能自环，completed/failed 只能经显式 retry 回 running
- result 里有两个私有字段：__skillGraphCheckpoint（图 checkpoint）和 __langGraphCheckpoint（LangGraph 线程），对外投影都剥掉
- 对外事件 id 改写成 runId:n，避免共享序列泄露其他租户的事件量

代码：`server/rag/agent-run-state-machine.js AGENT_RUN_STATUS_TRANSITIONS`；`server/rag/agent-runs.js stripInternalRunFields / toPublicRunEventIds`；`server/rag/postgres-agent-run-store.js agentRunSelectColumns`

> ⚠ 别说成事件溯源：状态是整行快照，事件是附带的审计流，恢复不靠重放事件。

### Q2. 进程崩了，run 会怎样？默认会自动续跑吗？计划内停机呢？

*L1 是什么*

- 只在启动时扫描（app.js 和 agent 层的 agent-service/app.js 调 recoverOnStartup）；PG store 时默认 auto，内存 store 默认 manual
- 结局：自动续跑；转人工（manual_recovery_required，running 改 waiting_for_user）；跳过（已被认领的 custom-Skill 图、已经带 manual_recovery_required 事件的 run、已经收尾成向用户提问的已存 v3 run）。已存的 v3 run 即使被更早一次启动恢复认领过也转人工：这个版本没有进程能持有它的 claim（独立复核找出来的，CURRENT-TRUTH.md 3.51）
- V1 的待审批 run 会被打上 manual 标记（状态仍是 waiting_for_user），不是跳过
- 自动续跑条件很窄，而且只续跑一种图：custom-Skill 图要 digest 对、与 step 对账一致、无待审批、外层计划恰好只有 custom_skills 一个阶段（v1 checkpoint），并且认领 CAS 成功。外层计划 2026-11-13 起也由 LangGraph 调度，但那张图不带 checkpointer，不在此列
- 2026-11-14 阶段 10 之前还有第二种：走 v3 guarded 路径的统一图（还要 rollout 仍是 guarded、LangGraph 线程核对通过）。v3 统一图删除后，已存的 v3 run 不再续跑：没结束的转人工，原因 unified_graph_removed（节点步骤还在执行中的是 unknown_in_flight_node），只能取消；已经收尾成向用户提问的跳过、不动（CURRENT-TRUTH.md 3.51）
- 没有图可续的 run 一律转人工，步骤不单独重放。原因码由 explainInterruptedRun 给：有待审批项是 pending_approval_gate，否则是第一个中断步骤的第一个原因码（custom_skill 步骤是 graph_node_step），没有中断步骤是 no_safe_recoverable_step
- 2026-11-13 阶段 9 之前还有第三种自动恢复：非图 run 里中断的 custom_skill 步骤整步重放。带这种步骤的非图 run 只有 V1 顺序链存下的；阶段 9 把这条路删了，这种旧 run 现在转人工、只能取消（CURRENT-TRUTH.md 3.50）
- 所以最常见的崩溃（主 document_rag 在途）是转人工
- 人在恢复面板上只有两个动作：重试失败步骤（retry_failed_step，只对矩阵允许的四类步骤给出：document_rag、follow_up_retrieval、research_question、capability_call；custom_skill、web_search、arxiv_import 不在其中）和取消（cancel）
- 计划内停机：SIGTERM 排空在途请求（默认 25 s），worker 并行停，第二个信号或超时 exit 1

代码：`server/rag/agent-run-recovery.js createAgentRunRecoveryService / explainInterruptedRun`；`server/rag/agent-run-recovery-actions.js AGENT_RUN_RECOVERY_ACTIONS / buildAgentRunRecoveryState`；`server/rag/config.js getAgentRunRecoveryModeConfigStatus`；`server/rag/agent-service/role-server.js createGracefulShutdown`

> ⚠ 别说「崩溃后自动从断点续跑」，也别说「只读的步骤会自动重放」。安全说法：只在能证明安全时自动续跑，而且只续跑整张图，其余交给人；优雅停机只保 HTTP 请求，后台 agent 任务仍会被切断。

### Q3. 为什么用 revision CAS，不在整个处理过程里持行锁？

*L2 为什么*

- 一次 run 要跨多秒的 LLM 调用，长事务持锁会占满连接池、阻塞其他写
- 乐观并发：在内存里决定，提交时 WHERE revision = $4，冲突就重读重判（多数方法最多 32 次）
- 锁只在 CAS 那一次往返里持有（FOR NO KEY UPDATE 前导）
- 状态转换、终态不可改、图 owner、审批绑定等检查都在 mutate 回调里，和写入同一个 CAS

代码：`server/rag/agent-runs.js mutateStoredRun / decideRunMutation`；`server/rag/postgres-agent-run-store.js commitRunUpdate`

> ⚠ 别说 CAS 能防重复副作用。CAS 只保证状态写入不丢、不乱；副作用靠幂等键和重放矩阵。

### Q4. 你说「不重复副作用」，那是 exactly-once 吗？

*L2 为什么*

- 不是。外部写和「step 完成」落盘之间总有崩溃窗口
- 写前意图：step_started 在会写记忆的调用之前落盘，恢复依赖它
- 恢复时 running/paused 的步骤一律 unknown_in_flight_node 转人工，不做推断
- 写型 Capability 带确定性幂等键（图节点 runId+nodeId+skillId），工件表唯一约束 + ON CONFLICT
- 没有步骤被无人值守地单独重放：自动的只有整图续跑；重放安全矩阵决定失败的步骤能不能由人重试
- 例外：主 document_rag 的显式重试会再记一次会话和长期记忆

代码：`server/rag/agent-execution-graph-checkpoint.js reconcileExecutionGraphCheckpoint`；`server/rag/agent-run-step-handlers/capability-steps.js createCapabilityCallStepHandler`；`server/rag/agent-run-step-replay-safety.js STEP_REPLAY_SAFETY_MATRIX`

> ⚠ 安全说法：自动恢复路径不重放副作用；写型 Capability 在 adapter 遵守幂等键时做到效果一次；记忆写入的显式重试不是 exactly-once。

### Q5. （追问）矩阵里谁能自动重放？Skill 声明 replaySafe:true 就能放吗？

*L2 为什么*

- 现在没有：矩阵里没有「可自动重放」一列，任何步骤都不会被单独自动重放（2026-11-13 阶段 9 起）。自动的只有整图续跑，条件见 Q2
- 矩阵现在回答的是另外两件事：失败的步骤能不能由人重试（isStepRetryAllowed 看 replayActions 里有没有 retry_failed_step），以及重放它会冒什么风险（原因码）
- custom_skill：replayActions 为空、retryable:false、幂等类别 graph_owned、原因码 graph_node_step。custom Skill 只作为图节点运行；回放守卫凡是 custom_skill 步骤一律拒绝（409 AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY），不看有没有 nodeId 或 checkpoint，在 step executor 重试前的预检和 run store 的 retryStep、updateRunStep 里都生效（图自己写节点步骤走 recordRunStep，不经过这条拒绝）
- document_rag / follow_up_retrieval / research_question：memory_writing_rag，中断了转人工，失败了可以由人显式重试（后两者现在不写记忆，但注入的 ragService 不一定遵守，保守处理）
- capability_call：要 hash 绑定的已批准门，失败了可以由人重试
- web_search（不确定的外部读）、arxiv_import（靠导入器去重的写）：需要审批的主步骤，不能直接重试，replayActions 为空；要重试的是审批后排进来的 capability_call 步骤。矩阵允许人重试的一共四类：document_rag、follow_up_retrieval、research_question、capability_call
- 持久化在 step 上的声明（effects、replaySafe）只往原因码里加原因：非 read_only 当写，external_read 当非幂等，未知值当写。replaySafe:true 放宽不了任何东西；unsafe_by_policy 现在只表示「这个 Skill 自己声明不能重放」
- 阶段 9 之前这一题的答案是「只有 custom_skill（read_only_rag）autoReplaySafe」：没有图 checkpoint 的 custom_skill 步骤在启动时整步重放，重放前 custom-research-steps.js 用 live registry 的 isSideEffectingSkill 再查一次。这种步骤只有已删除的 V1 顺序链写得出来，所以这一列、独立处理器和这次复核都删了（CURRENT-TRUTH.md 3.50）

代码：`server/rag/agent-run-step-replay-safety.js isStepRetryAllowed / getDeclaredContractReasonCodes / getPolicyReasonCodes`；`server/rag/agent-run-graph-replay-guard.js assertStandaloneGraphReplayAllowed`；`server/rag/skills/skill-contract.js describeSkillReplayContract`

> ⚠ 别说「由 Skill 声明决定」，也别再说「只读的 custom_skill 步骤会自动重放」。是运行时按步骤类型登记能不能由人重试，声明只加原因；自动的只有整图续跑。

### Q6. 为什么不用 Temporal / Cadence 这种 durable execution 引擎？

*L3 为什么不用 X / 怎么证明*

- Temporal 要求 workflow 代码确定性，LLM 规划和调用都得包成 activity，改造量大
- activity 失败重试也是至少一次，幂等还是得自己做
- 多运维一套集群；租户 RLS、备份、加密要再做一遍
- run 是单行记录，PG + CAS 够用，而且和已有存储一致
- 诚实承认：长流程、定时器、跨服务 saga、可视化、活实例间接管，Temporal 现成，这里没有

代码：`server/rag/postgres-agent-run-store.js createPostgresAgentRunStore`；`server/rag/agent-run-recovery.js createAgentRunRecoveryService`

> ⚠ 别说「Temporal 做不到」。它能做而且更成熟；理由是范围、运维、和已有 RLS 存储一致，不是能力差距。

### Q7. 你用了 LangGraph，为什么不用它自带的 PostgresSaver，让 LangGraph 的 checkpoint 做权威？

*L3 为什么不用 X / 怎么证明*

- 权威是自己的图 checkpoint：sha256 digest、owner 摘要（scope、预算、问题、选中 Skill 等）、每个节点 typed 输出摘要，要和 step 回执对账
- ADR 的硬约束：不出现第二个 run store，不用 PostgresSaver 的 checkpoints 表
- RunStoreCheckpointSaver 写在 run 行上，和节点 step 共用 CAS 与围栏
- 每次调用先 tombstone 旧线程、从 checkpoint 种子重来；只有图内审批续跑 resume 同一线程、而且先核对回执，那是 v3 统一图的路径，2026-11-14 删除后没有生产调用方
- 代价是写放大：保留 2 个、no-op 不读、完成或失败即丢

代码：`server/rag/langgraph/checkpointer.js RunStoreCheckpointSaver / LANGGRAPH_CHECKPOINT_RETENTION`；`server/rag/langgraph/run-execution-graph.js runExecutionGraphOnLangGraph`（原来这里还列着 langgraph/unified-graph-recovery.js verifyLangGraphThreadForRecovery，阶段 10 随 v3 统一图删除）

> ⚠ 别说「LangGraph 负责持久化」。说「LangGraph 只调度；权威在自己的 checkpoint，线程只是回执，每次调用从 checkpoint 种子重来」。「线程和 checkpoint 矛盾就转人工」是 v3 统一图恢复时才有的核对，2026-11-14 随它删除，别再当现状讲。

### Q8. 取消为什么用 drain，不直接把 AbortSignal 传给 LangGraph？

*L3 为什么不用 X / 怎么证明*

- spike 实测原始 LangGraph 的 RunnableConfig.signal：invoke 立即 reject，在途节点在后台继续跑，写入被丢，续跑时再跑一次，即至少一次
- drain：signal 只触发 RunControl.requestDrain，在下一个 superstep 边界停，已完成节点落 checkpoint，不会被重跑
- GraphDrained 映射回请求自己的 AGENT_DEADLINE_EXCEEDED / AGENT_CLIENT_CANCELLED，走 failRun
- 节点入口、闸门放行后、startGraphStep 还有原生安全点
- writesWorkspace 的 Capability 用 runOutsideRequestDeadline 跑完，run 再标 retryable:false

代码：`server/rag/langgraph/drain-bridge.js bridgeRequestSignalToDrain / resolveDrainedInvocationError`；`server/rag/request-deadline.js throwIfRequestCancelled / runOutsideRequestDeadline`；`server/rag/capabilities/registry.js（runOutsideRequestDeadline 调用处）`

> ⚠ 追问「用户要等多久」：最坏是一个 superstep 里最慢的在途节点；模型调用仍会被 withRequestSignal 中止，所以通常很快；写型 Capability 要等它写完。别说「立即停」。

### Q9. 审批怎么保证「批准的」和「执行的」是同一个东西？

*L3 为什么不用 X / 怎么证明*

- 审批门带私有执行快照；approvalObjectHash = sha256(规范化 {accessScope, capabilityId, capabilityVersion, executionInput, inputPreview, snapshotVersion})
- 批准请求必须带门上显示的哈希，不一致就 409；执行前再用私有快照重算哈希，timingSafeEqual 比较
- 现在生效的只有外层计划的 capability_call 审批；下面四条是 v3 图内审批的设计，2026-11-14 随 v3 统一图删除（代码还在共用模块里，没有生产调用方，下一步删），讲的时候说「当时」
- 当时：gate、快照、暂停的 checkpoint、状态在一个 CAS 里写；快照冲突用除零（SQLSTATE 22012）强制整条语句回滚，因为数据修改 CTE 不会因最终 SELECT 无行而回滚
- 当时：v3 门必须 pending 且唯一，只能决定一次
- 当时：续跑时 verifyCapabilityGraphApproval 按 live Capability、live 策略和当前绑定输入重算；版本变了 graph_approval_stale
- 当时：resume 值只用 RUNTIME_RESUME_MARKER，interrupt 载荷只有 kind、nodeId、gateId:null，决定从 run store 读

代码：`server/rag/capabilities/approval-execution-snapshot.js createApprovalExecutionSnapshot / verifyApprovalExecutionSnapshot`；`server/rag/agent-runs.js pauseExecutionGraphForApproval / applyExecutionGraphApprovalAction`；`server/rag/postgres-agent-run-store.js commitRunUpdate`；`server/rag/langgraph/unified-graph-approval.js RUNTIME_RESUME_MARKER`

> ⚠ 会被追问「图内审批现在还在吗？」：不在了。它是 v3 统一图的路径，v3 统一图 2026-11-14 删除：用户要 agent 只有一种回答请求的方式，而 7B 规划统一图只接受 3/15、文档问答 CPU 约 1 ms 对 11–15 ms、六类请求答不了。图内审批证明的是运行时契约，不是模型规划效果。现在生效的只有外层计划的 capability_call 审批，它的审批内容来自原始问题，不是已验证的文档答案。

### Q10. 你怎么证明 Capability 真的只执行了一次？

*L3 为什么不用 X / 怎么证明*

- 先说现状：这道题最强的证据是 v3 图内审批的。v3 统一图 2026-11-14 删除，它的 7 个跨进程 PostgreSQL 用例随之删除。讲成做过的设计和当时的证据，不要讲成现在还在跑的测试
- 当时：跨进程测试（真实 PG，进程 A 暂停、进程 B 批准）14/14，写入次数恰为 1（CURRENT-TRUTH.md 3.17）
- 当时：Capability 写入后立即崩溃的 run 转人工，不重放；过期版本和篡改的门被拒
- 现在外层计划的 capability_call：写入带确定性幂等键（parts=[runId, rootStepId, capabilityId]），工件表唯一约束 + ON CONFLICT；幂等性交给 adapter
- 阶段 10 之后还在测的一条共用规则：会写工作区的 Capability 不被截止时间打断，直接在 Capability 注册表上测（test/agent-cancellation.test.mjs）
- ADR spike：interrupt 之前的代码跑 2 次、之后副作用 1 次，所以 interrupt 必须是第一个有效操作
- 删除原生调度器前冻结 golden（8 个套件、102 个文件），恢复评测 8/8 前后屏蔽后逐字节一致

代码：`server/rag/capabilities/artifacts.js buildCapabilityArtifactIdempotencyKey`；`server/rag/agent-run-step-handlers/capability-steps.js createCapabilityCallStepHandler`；`server/test/agent-cancellation.test.mjs`（原来这里列的 agent-unified-graph-postgres.integration.test.mjs 和 agent-unified-graph-approval.test.mjs 已随 v3 统一图删除；langgraph/unified-graph-resume.js prepareUnifiedGraphApprovalResume 还在，没有生产调用方）

> ⚠ 不要说「线上验证过」，也不要说「有跨进程测试在跑」：那 7 个用例随 v3 统一图删了。能说的是「做过图内审批，当时用跨进程集成测试加故障注入点覆盖了暂停、批准、写后崩溃、拒绝」；第三方 adapter 不遵守幂等键就没有保证。

### Q11. 写语句直接返回事件、run cursor 不回读，不会读到脏数据吗？

*L3 为什么不用 X / 怎么证明*

- cursor 不是缓存，是乐观 CAS 基准：只有 revision CAS 成功才算数；no-op、拒绝、冲突一律重读重判
- 审查发现的坑：CAS 快照在语句开始时拍，等行锁期间别人追加的事件（不改 revision）会漏；改成同一往返先 FOR NO KEY UPDATE
- 依赖事件的判定设 requiresFreshRun
- 效果：/chat 的 run 回读 26 到 0；租户往返 167 到 22、租户 4 实例 +37.9%，但这两项里大部分来自租户语句流水线，不全是 run store

代码：`server/rag/agent-runs.js createAgentRunCursor / mutateStoredRun`；`server/rag/postgres-agent-run-store.js lockRunRowFirst / buildRunEventListCte`

> ⚠ 数字来自假模型 0 ms、同一台机器，往返数是 pg_stat_statements 并发 1 按差值算的，别说成生产 QPS。

### Q12. fencing 具体怎么做？旧 worker GC 停顿 60 秒后回来会怎样？

*L3 为什么不用 X / 怎么证明*

- 恢复 worker 用 claimExecutionGraphResume 在 CAS 里写 UUID claim
- 之后每个节点开始/结算、checkpoint 保存、completeRun/failRun、LangGraph 线程写都校验 claimId 和 digest
- 旧 worker（claim 为 null）下一次写会 409 AGENT_GRAPH_EXECUTION_FENCED
- 它已经发出去的外部调用拦不住，所以需要幂等键，所以在途步骤要转人工
- 被放弃的 claim 永不自动重放
- 后台任务另有 claimed_by + attempt_count 围栏、60 s 租约、lease/3 心跳，心跳丢了任务自中止

代码：`server/rag/agent-runs.js claimExecutionGraphResume / assertExecutionGraphRunOwner / assertLangGraphCheckpointWriter`；`server/rag/job-orchestrator.js createClaimHeartbeat`；`server/rag/postgres-task-store.js updateTaskSnapshot`

> ⚠ fencing 防的是旧 worker 的状态写，不防它已经发出的副作用。别说「fencing 保证不重复执行」。

### Q13. 多实例部署时一台重启，会不会把别的实例上正在跑的 run 当成孤儿？

*L4 边界 / 规模 / 重做*

- 诚实回答（读代码得出，没有测试覆盖）：会
- listRecoverable 只按 status 选，没有心跳、租约或实例 id 过滤，而且扫描所有租户
- 图 run：若有在途 step，判 unknown_in_flight_node 转人工；若恰在节点边界，恢复进程可能认领并接着跑。两种情况原 worker 下一次写都被 fence、它那次请求失败。状态安全，但丢了可用性
- 非图 run：会被标 manual_recovery_required、running 改 waiting_for_user，但 waiting_for_user 下仍接受 step 写，原 worker 可能照常完成，留下误导的人工标记
- 修法：像任务那样给 run 加租约 + 心跳，启动恢复只接手租约过期的 run

代码：`server/rag/postgres-agent-run-store.js listRecoverable`；`server/rag/agent-run-recovery.js createAgentRunRecoveryService`；`server/rag/agent-runs.js markManualRecovery`

> ⚠ 这是要主动承认的设计边界。CAS 保证不写坏，不保证不误判；别硬说「CAS 能处理」。

### Q14. 依赖挂了（网关、检索、数据库）或者超时，用户看到什么？run 记成什么？

*L4 边界 / 规模 / 重做*

- 按 code/status/SQLSTATE 分类，不读 message：503 AGENT_DEPENDENCY_UNAVAILABLE / 504 AGENT_DEPENDENCY_TIMEOUT，带 Retry-After（默认 5 s）
- run 记 failed、retryable:true、dependency、causeCode；已有 capability_call 完成则 retryable:false、不发 Retry-After
- 截止时间 504 AGENT_DEADLINE_EXCEEDED；客户端断开 499，run 记 canceled；启动恢复不列 failed/canceled
- 以前 document_rag 失败会掉到 Web 阶段、请用户批准 Web 搜索
- 实测发现：被取消的模型调用被熔断器计为失败，234 次 226 次 503；修后 234 次全是 504

代码：`server/rag/dependency-outage.js classifyDependencyOutage / describeAgentRequestFailure / resolveAgentRunTermination`；`server/rag/request-deadline.js REQUEST_CANCELLATION_CODES`；`server/rag/agent-runs.js hasCommittedCapabilityWrite`

> ⚠ 主动说边界：后台任务遇到故障直接失败；截止时间、断开取消默认都关。（以前还有一条「v3 非主节点故障仍 409」，2026-11-14 随 v3 统一图删除。）

### Q15. 规模放大 100 倍（run 数或单个 run 的节点数）怎么办？

*L4 边界 / 规模 / 重做*

- 单行 JSON 整行重写：steps 和 checkpoint 越大，每次 CAS 越贵
- 每次 CAS 还聚合返回整条事件列表，开销随事件数线性增长
- 方向：steps/节点运行拆子表；事件只返回增量；run 和事件表按租户分区；已结束的 run 靠 AGENT_RUN_RETENTION_DAYS 按期删除（是删除，不是归档）
- 单 run 内并发节点结算撞同一行，节点多时改成节点子表加行级 CAS
- 恢复扫描改成分片 + 租约过期索引 + 并行 worker
- 真实模型下容量先受模型并发上限约束，不是存储

代码：`server/rag/postgres-agent-run-store.js commitRunUpdate / buildRunEventListCte / listRecoverable`；`server/rag/agent-runs.js DEFAULT_AGENT_RUN_MUTATION_RETRIES`

> ⚠ 没测过 100 倍，只测过单机 4 实例、假模型。这里给方向，不报数字。

### Q16. 如果重做，你会改什么？

*L4 边界 / 规模 / 重做*

- run 级租约 + 心跳，取代「启动时认为所有 running 都是孤儿」
- 记忆写入按 runId+stepId 加幂等键，让 document_rag 能真正幂等，从而可以自动重放
- 统一的副作用账本表，记录外部写的意图和完成，不再靠每个 adapter 自己幂等
- steps/事件拆表，降低单行写放大
- 评估 DBOS/Temporal 这类 durable execution，但保留「运行时决定能否重放」的矩阵
- （原来有一条「合并 V1 capability_call 审批和图内审批两条路径」。2026-11-14 删除 v3 统一图之后只剩外层计划的审批一条路径，是删出来的，不是合并出来的；图内审批「审批内容来自已验证的答案」这一点没有搬过去，以后想要得在外层计划里另做）

代码：`server/rag/agent-run-step-replay-safety.js STEP_REPLAY_SAFETY_MATRIX`；`server/rag/agent-runs.js mutateStoredRun`；`server/rag/postgres-agent-run-store.js listRecoverable`

> ⚠ 说改进时别否定当初的取舍；先讲当时为什么这样（单机起步、已有 PG、范围），再讲触发重做的信号。

## 可以引用的数字

| 说什么 | 数字 | 出处 | 前提 / 注意 |
| --- | --- | --- | --- |
| /chat 路径上 run 存储的回读 | 每个 /chat 26 次到 0 次（事件列表 15、run 行 11） | docs/evaluation.md「每次 /chat 的数据库往返（2026-09-27）」；CURRENT-TRUTH.md 3.15 | pg_stat_statements、并发 1、按 300 减 100 个请求的差值除以 200 计 |
| 每个 /chat 的数据库往返 | 租户路径 167 到 22，owner 路径 46 到 20 | docs/evaluation.md「每次 /chat 的数据库往返」 | 包含租户语句流水线优化（另一个子系统）的贡献，不全是 run store |
| 往返优化后的吞吐 | 租户 4 实例 205 到 283 req/s（+37.9%）；租户 1 实例 +12.6%；owner 1 实例 +4.6% | docs/evaluation.md「每次 /chat 的数据库往返」；CURRENT-TRUTH.md 3.15 | 假模型 0 ms、并发 32、每格 3000 请求、同机；单实例受 Node CPU 限制 |
| 一次 /chat 的 run store 语句数（回归钉子） | 1 次插入、3 次 CAS、2 次事件追加、0 次 run 或事件读取 | AGENTS.md（Agent run writes 一节）；server/test/agent-run-chat-statement-count.test.mjs | 测试固定的计数，不是性能数字；PG 侧是测试自己的替身，已对照过一次真实 pg_stat_statements |
| 图内审批跨进程只执行一次 | 14/14 通过，写入次数恰为 1；写后立即崩溃转人工不重放 | CURRENT-TRUTH.md 3.17 | 真实 PostgreSQL 上的集成测试，确定性用例和 mock，不是生产流量。历史证据：图内审批是 v3 统一图的路径，2026-11-14 删除，删除时它有 7 个跨进程 PostgreSQL 用例，都随它删了（3.51） |
| interrupt 续跑时节点从第一行重跑 | interrupt 之前的代码跑 2 次，之后的副作用 1 次 | docs/adr/0001-langgraph-runtime.md 阶段 0 spike「2. interrupt() 续跑后副作用只发生一次」 | 所以 interrupt 必须排在预算预留、step 开始、任何写入之前；spike 测试已在阶段 4 删除，性质由生产套件覆盖 |
| 截止时间与熔断器的缺陷与修复 | 修复前 234 次运行 226 次 503；修复后 234/234 以 deadline_exceeded（504）结束，0 次 503；失败延迟 p50 309 ms（并发 4）/ 322 ms（并发 16） | CURRENT-TRUTH.md 3.20；docs/evaluation.md「读副本、层间身份、截止时间和指标」 | 假模型 800 ms、截止时间 300 ms、并发 4/16、默认熔断配置、同机 |
| LangGraph checkpointer 的写放大 | 2 节点 custom-Skill /chat 比 native 多 7 次无事件 CAS、1 次 run 读、1 次事件读；完成后 result 11,894 字节（native 11,860，阶段 3 时 17,006）；单条记录最大 2,975 字节 | CURRENT-TRUTH.md 3.28；AGENTS.md「Write amplification」 | PostgreSQL 18、owner 路径、一个固定的 2 节点用例 |
| LangGraph 线程保留与上限（代码常量） | LANGGRAPH_CHECKPOINT_RETENTION = 2；DEFAULT_LANGGRAPH_MAX_RECORD_BYTES = 262,144 | server/rag/langgraph/checkpointer.js | 常量，不是测量值 |
| CAS 冲突重试上限（代码常量） | DEFAULT_AGENT_RUN_MUTATION_RETRIES = 32 | server/rag/agent-runs.js | mutateStoredRun 默认 maxRetries 是 0，32 由各方法显式传入；V1 applyApprovalAction 用默认 0，冲突直接 409 |
| 后台任务租约（代码常量） | DEFAULT_TASK_CLAIM_LEASE_MS = 60,000；心跳间隔 lease/3 | server/rag/tasks.js；server/rag/job-orchestrator.js createClaimHeartbeat | 只对任务；agent run 本身没有租约 |
| 优雅停机窗口 | 在途请求 25 s（SERVICE_SHUTDOWN_GRACE_MS 默认），finalizer 余量 3 s，入库 worker 交回 5 s，compose stop_grace_period 30 s | AGENTS.md「Monolith shutdown」；server/server.js SHUTDOWN_FINALIZER_MARGIN_MS / INGEST_WORKER_STOP_GRACE_MS；server/rag/config.js | 只覆盖 HTTP 请求 |
| 恢复与图回归证据 | eval:recovery-observability 8/8，删除原生调度器前后屏蔽后逐字节一致；test:pgvector 101/101；golden 8 个套件、102 个文件 | CURRENT-TRUTH.md 3.30 | golden 只代表固定场景，不是对任意图形状的证明；在 Node 24 生成，CI 的 Node 22 上通过 |
| custom Skill 步骤不再单独重放（阶段 9）之后的恢复证据 | eval:recovery-observability 8/8，检查项 29 → 27；可恢复的 run 4 → 3，转人工 1 → 2，手动动作 3 → 2，自动恢复尝试 3 → 1（成功率仍是 1）；agent-skill-step-replay 12/12（冻结时 10 个）、agent-run-recovery 17/17、agent-run-recovery-actions 7/7、agent-run-step-executor 22/22（原 26 个）；覆盖率闸门 4,607 个测试（通过 4,600、跳过 7、失败 0） | CURRENT-TRUTH.md 3.50；docs/adr/0001-langgraph-runtime.md 阶段 9 | 独立复核修正之后、在 015f06a1 上，本机 Node 24.21.0、一次性 PostgreSQL 18 + pgvector；独立复核没有高级缺陷，两条中级意见都不是这次改出来的，已处理；合并进 main 之后 CI 的 Node 22.23.4 上也通过（合并提交 db3ed97b，运行 43529876304：4,607 个测试，4,599 通过、8 跳过、0 失败，行覆盖 92.52%）。恢复评测的计数来自内存 store 上的确定性造数，自动恢复那一次由图启动续跑探针提供；去掉的两项检查随功能一起消失，阈值没改 |
| 真实模型规划 v3 统一图 | 模型计划只被接受 3/15，12 次回落确定性图，0 次回落 V1 | CURRENT-TRUTH.md 3.17；docs/evaluation.md「统一图的真实模型规划（2026-09-27）」 | 本地 qwen2.5:7b、3 轮 15 次规划；历史测量：v3 统一图 2026-11-14 已删除（3.51）；图内审批的证据是确定性提案 |
| 删除 v3 统一图（阶段 10）之后已存 v3 run 的处理 | 已结束的（完成、失败、取消）和已收尾成向用户提问的不动，续接它的请求开新 run；没结束的续不了，启动恢复把它交给人（被更早一次启动恢复领取过的也一样），原因 unified_graph_removed（节点步骤还在执行中的是 unknown_in_flight_node），审批端点和带 agentRunId 重入停在门上的 run 被拒，人只能取消；agent-stored-unified-graph-runs 12/12（独立复核之前 9/9）、agent-unified-graph-dial 3/3；eval:recovery-observability 不变，8 个用例、27 项检查，用例和指标与删除前逐字节一致；覆盖率闸门 4,479 个测试（通过 4,472、跳过 7、失败 0） | CURRENT-TRUTH.md 3.51；docs/adr/0001-langgraph-runtime.md 阶段 10 | 复核修正提交 637593f3，本机 Node 24.21.0、一次性 PostgreSQL 18 + pgvector；夹具是 v3 代码在内存 run store 里写下的记录（12 种状态加一个停在门上的后台任务，其中 4 种是独立复核之后补的）；真实 PostgreSQL 上的已存 v3 run 没有验证，跨进程用例随 v3 删了 |
| 依赖故障默认 Retry-After | 5 秒 | server/rag/dependency-outage.js DEFAULT_OUTAGE_RETRY_AFTER_SECONDS | 原因自带 Retry-After 时用原因的 |

## 要主动说出口的边界

- 不是 exactly-once：主 document_rag 的显式 retry_failed_step 会再记一次会话和长期记忆；Capability 的幂等性交给 adapter（capability_defined），不遵守幂等键的 adapter 没有保证。
- 恢复只在启动时扫描（app.js 与 agent-service/app.js 各调一次 recoverOnStartup），agent run 没有租约和心跳；活着的实例之间不会接管彼此崩溃的 run，要等某个进程重启。
- （读代码推断，未测）listRecoverable 只按状态选、不区分孤儿和别的实例正在跑的 run；多实例滚动重启时，会把其他实例上在跑的图 run 转人工或认领接管、并 fence 掉原 worker（状态安全但那次请求失败），也会给非图 run 打上误导的人工标记。
- 自动续跑范围很窄，只剩一种，续跑的是整张图：外层计划恰好只有 custom_skills 的 custom-Skill 图。走 v3 guarded 路径的统一图 2026-11-14 随 v3 统一图删除（阶段 10，CURRENT-TRUTH.md 3.51）：已存的 v3 run 不再续跑，没结束的转人工、只能取消。步骤不单独重放，没有图可续的 run 一律转人工（2026-11-13 阶段 9 起，CURRENT-TRUTH.md 3.50；之前非图 run 里的 custom_skill 步骤会整步重放，那种 run 只有 V1 顺序链存下的）。最常见的崩溃（主 document_rag 在途）会转人工；V1 待审批的 run 重启后也会被打上 manual 标记。外层计划 2026-11-13 起也由 LangGraph 调度（阶段 7），但外层图不带 checkpointer，持久化仍是 run 的步骤，这个范围没有因此改变。
- 被放弃的恢复 claim 永不自动重放，在途未知的节点（包括声明只读的）一律转人工，需要运维处理。运维动作只有两个：cancel 和 retry_failed_step（resume_from_step 阶段 9 删除）。cancel 给的是转了人工、还在等待的 run，所以转人工的 run 在恢复面板上实际只能取消；retry_failed_step 给的是已经结束（completed 或 failed）的 run 里最后一个失败步骤，而且只在矩阵允许这类步骤重试时给出，custom_skill、web_search、arxiv_import 都不在其中（聊天答案里失败步骤的 Retry 按钮按同一份清单显示）。没有运维处理量的数据可引用。
- 失败的 custom Skill 节点不能单独手动重试：图运行的步骤拒绝单独重试（409 AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY）。以前只有 V1 顺序链的步骤支持；顺序链 2026-11-13 删除（ADR 0001 阶段 8，CURRENT-TRUTH.md 3.49）后这项能力没有了，也没有替代。默认走图是 2026-09-25 起的事，所以默认配置下它已经七周不可用。图里只有有限 replan，而且只在模型规划器是主规划器时存在；确定性规划器下，失败的节点留下 partial 的图，没有重试。处理 custom_skill 步骤的单步重试和启动恢复处理器在阶段 8 还留着，同一天的阶段 9 也删了（3.50）：顺序链留下的旧 run 中断了转人工、只能取消，失败了不能单步重试，要得到答案只能重新提问；恢复面板不再给失败的图节点「重试失败步骤」按钮（以前给，点了一定是 409）。
- 阶段 9 的结果在本机 Node 24 和 CI 的 Node 22 上都通过（合并提交 db3ed97b），但有两样没有验证过：真实浏览器里的恢复面板没有起应用看过（前端只跑了组件测试）；真实 PostgreSQL 上的旧链 run 没有验证过（postgres-agent-run-store 的测试用的是假的 pg 客户端，本机和 CI 的数据库里也没有这种存量 run）。「这些代码只有旧 run 走得到」是从代码的调用关系读出来的，没有线上数据。
- 取消不是立即生效：要等在途节点到安全点；写型 Capability 开始后一定跑完；数据库语句不读 signal；检索层不随调用方断开而停止。截止时间（AGENT_REQUEST_TIMEOUT_MS）和断开取消（AGENT_CANCEL_ON_DISCONNECT）默认都关。
- （已不适用）v3 非主节点遇到依赖故障答 409 AGENT_UNIFIED_GRAPH_PARTIAL、v3 审批续跑中的依赖故障转人工，这两条 2026-11-14 随 v3 统一图删除。
- 优雅停机只覆盖 HTTP 请求，进程内的后台 agent 任务仍被切断，留给启动恢复。
- 图内审批（v3 guarded）2026-11-14 随 v3 统一图删除：停在审批门、决定之后在同一张图上续跑、Capability 恰好执行一次，以及它的 7 个跨进程 PostgreSQL 用例都没有了。外层计划的 Capability 审批还在，是另一条路径，审批内容来自原始问题，不是已验证的文档答案。图内审批当时的证据来自确定性提案和 mock，7B 模型规划统一图只接受 3/15。
- 开过 guarded 的部署里已存的 v3 run：停在门上的不能再批准或拒绝，中断的不再自动续完，收据已写的不再补完成，都要人来取消；已经结束的不动。
- 阶段 10 没做完、没验证的：run store 的图审批门（暂停、决定、读取）和它的绑定校验、执行器里节点停在审批门和同一线程续跑、v2 checkpoint、capabilities/graph-approval-preflight.js、任务级的 deny 动作（只对图审批门有效，现在不可能成功）还在代码里，没有生产调用方，下一步删。真实 PostgreSQL 上的已存 v3 run 没有验证（夹具是内存 run store 的记录），真实浏览器没有验证，存量数据里是否真有 v3 run 也没有验证。
- 写放大：LangGraph 线程记录随 run 行每次 CAS 被整行重写；单行设计在单个 run 节点很多、事件很多时会变贵，没做过规模测试。
- LangGraph 包装依赖 @langchain/langgraph 1.5.0 和 @langchain/core 1.2.17 的具体行为（drain 后输出流一个微任务就出错、maxConcurrency 低于 superstep 宽度时丢任务等），版本是精确钉住的，升级要重跑契约测试。
- 所有数字来自单机、假模型或确定性用例，没有生产流量；PostgreSQL 集成测试在 CI 里依赖 pgvector service，本地没有数据库时报告为跳过。

## 只能当推理讲的内容

核验代理找不到代码或数据依据的条目。讲的时候用「我的判断是……，没测过」。

- 多实例滚动重启时误判别的实例在跑的 run（L4 题与 limitations 第 3 条）：只能从代码推断（listRecoverable 只按 status 过滤、无租约），没有测试或测量，已保留并标注为读代码推断。
- ADR 0001 阶段 0 spike 的数字（interrupt 前代码跑 2 次、伪造批准与带 update/goto 的 Command 被拒、signal 模式至少一次）：spike 测试套件已在阶段 4 删除，只能引用 ADR 文字，不能指到现存的 spike 测试；性质据 ADR 由生产套件覆盖。
- decisions 里对 Temporal、Redlock、2PC/Saga/outbox、PostgresSaver 的取舍理由属于作者的设计论证，仓库文档里只有 ADR 约束 2 提到 PostgresSaver，其余没有书面出处，不是测量结论。
- 后台任务租约与心跳（60 s、lease/3）只有代码常量，没有接管延迟的实测数据。
- 「单个 run 内并发节点结算会撞 CAS」与「规模放大 100 倍」的各条方向：没有测量，只能作为推断讲。

## 容易记错的地方

第一遍阅读（主要依据 AGENTS.md 和文档）写错、被核验代理对照代码改正的说法。这些正是读文档容易产生的误解。

- **keyFiles: server/rag/agent-runs.js 的 role**
  - 原以为：mutateStoredRun（cursor 乐观尝试 + 重读重判，最多 32 次）
  - 实际：重试次数由各方法传入：claim、checkpoint、completeRun、failRun、recordRunStep 等传 DEFAULT_AGENT_RUN_MUTATION_RETRIES=32；mutateStoredRun 默认 maxRetries=0，无图守卫的 updateRun 和 V1 applyApprovalAction 用 0
  - 依据：server/rag/agent-runs.js：mutateStoredRun 参数 maxRetries = 0（约 1737 行）；updateRun 传 graphReentryGuard ? DEFAULT : 0；applyApprovalAction 不传 maxRetries
- **keyFiles: unified-graph-approval.js；questionLadder 审批题**
  - 原以为：interrupt 载荷只含 nodeId
  - 实际：载荷只有 kind、nodeId、gateId:null 三个字段（公开 id，不含快照和输入）
  - 依据：server/rag/langgraph/unified-graph-approval.js buildApprovalInterruptPayload 返回 { gateId: null, kind: UNIFIED_GRAPH_INTERRUPT_KIND, nodeId }
  - 2026-11-14 更新（阶段 10）：这个文件还在，但图内审批是 v3 统一图的路径，v3 删除后它没有生产调用方，下一步删（CURRENT-TRUTH.md 3.51）
- **requestFlow 第 8 步、questionLadder L1 第 2 题、limitations 第 2 条**
  - 原以为：下一次启动 app.js 调 recoverOnStartup / app.js 调 recoverOnStartup 一次
  - 实际：app.js（单体/api）和 agent-service/app.js（agent 层）启动时各调一次
  - 依据：grep recoverOnStartup：server/app.js:276 与 server/rag/agent-service/app.js:161
- **decisions 第 3 条 why；limitations 第 1 条**
  - 原以为：document_rag / follow_up_retrieval / research_question 会写会话记忆；三者的显式重试会再写一次会话记忆
  - 实际：三者在矩阵里都标 memory_writing_rag，但现在只有主 document_rag 真写记忆，follow_up 和 research_question 传 memoryWrites:false，只是因为注入的 ragService 不一定遵守才保守地不自动重放；只有主 document_rag 的重试会再记一次
  - 依据：AGENTS.md「Conversation memory」Never writes 一节与「The outer document_rag ... steps」一节；docs/configuration.md AGENT_RUN_RECOVERY_MODE 行；STEP_REPLAY_SAFETY_MATRIX 的 summary 文本
- **decisions 第 5 条 alternativesRejected**
  - 原以为：PG advisory lock：会话级，连接池下难用
  - 实际：事务级锁不能跨多秒的 LLM 调用持有，会话级锁在连接池下难管理，而且都挡不住长停顿后回来的写
  - 依据：PostgreSQL 同时有事务级 advisory lock（项目自己就在保留扫描里用 pg_try_advisory_xact_lock，见 AGENTS.md Retention 一节），原说法以偏概全
- **decisions 第 7 条 why**
  - 原以为：只写 signal 模式是至少一次
  - 实际：补充：spike 里 signal 模式靠 runner 等待在途节点 + v2 checkpoint 复用也做到了最多一次，选 drain 是因为 LangGraph 自己就不重跑已完成节点、不需要额外兜底；mock 忽略 signal 这点没测到
  - 依据：docs/adr/0001-langgraph-runtime.md 阶段 0 spike「3. 截止时间与取消」：drain 和 signal 两种模式都做到最多一次，signal 下要靠 runner 等待在途节点并从 v2 checkpoint 复用
- **decisions 第 9 条；questionLadder fencing 题**
  - 原以为：后台任务用 claim_id + attempt_count 围栏；需要在活着的实例间接管
  - 实际：围栏列是 claimed_by + attempt_count；接管只发生在启动恢复或管理员 recover-tasks 动作扫到任务、且租约过期之后（未过期会按剩余租约延迟重试）
  - 依据：server/rag/postgres-task-store.js：没有 claim_id 列，WHERE task.claimed_by = $6 AND task.attempt_count = $7，认领条件含 claimed_at 早于 now - lease；job-orchestrator.js recoverRunnableTasks 只在 app.js / agent-service/app.js 启动和 admin-actions.js recover-tasks 调用，notRunnable 时 scheduleTaskRun({ delayMs })
- **decisions 第 11 条 why / alternativesRejected**
  - 原以为：按 id 排名而不是列表位置，是因为 created_at 在拿锁前取，并发追加可能乱序；按列表位置编号（并发追加会重编号）
  - 实际：排名稳定是因为每次插入事件都先锁 run 行、在锁下取 id；created_at 那条是说事件列表按 id（提交顺序）而不是 created_at 排序；删掉无出处的「按列表位置会重编号」
  - 依据：AGENTS.md「Public event ids」原文；server/rag/postgres-agent-run-store.js RUN_EVENT_ORDER = ORDER BY event_id ASC
- **questionLadder 审批题第 3 条要点**
  - 原以为：批准请求必须带哈希，timingSafeEqual 比较
  - 实际：客户端带来的哈希与门上哈希是普通相等比较（不一致 409 approval_object_hash_mismatch）；timingSafeEqual 用在执行前用私有快照重算哈希的校验里
  - 依据：server/rag/agent-runs.js assertApprovalObjectBinding 用 suppliedHash !== expectedHash；approval-execution-snapshot.js verifyApprovalExecutionSnapshot 用 hashesMatch（timingSafeEqual）
- **questionLadder L1 第 2 题；staleInExistingDocs FAQ 第 4 题条目**
  - 原以为：跳过（已被认领、干净的审批暂停）
  - 实际：只有 v3 图的干净审批暂停被跳过；V1 待审批 run 在 auto 模式下返回 pending_approval_gate 并被打 manual 标记（状态仍 waiting_for_user）；v3 自动续跑还要求 rollout 仍是 guarded、线程核对通过
  - 依据：server/rag/agent-run-recovery.js findAutoRecoverableStep 首先返回 pending_approval_gate，随后 markManualRecovery；test/agent-run-recovery.test.mjs 断言 manualRecoveredCount 1、reason pending_approval_gate；isCleanGraphApprovalPause 只在 unifiedGraphPath 下判断
  - 2026-11-13 更新（阶段 9）：结论不变，函数名变了。findAutoRecoverableStep 已删除；现在是 explainInterruptedRun 先看待审批项、给出 pending_approval_gate，recoverOnStartup 随后 markManualRecovery。它只给原因，不再挑步骤重放
  - 2026-11-14 更新（阶段 10）：v3 图不再有「干净的审批暂停被跳过」和「自动续跑」。v3 统一图已删除，停在审批门上的已存 v3 run 在启动恢复时转人工（unified_graph_removed），被跳过的只有已经收尾成向用户提问的；isCleanGraphApprovalPause 和 unifiedGraphPath 现在 grep 不到（CURRENT-TRUTH.md 3.51）
- **requestFlow 第 8 步**
  - 原以为：reconcileExecutionGraphCheckpoint + verifyLangGraphThread → claimExecutionGraphResume
  - 实际：verifyLangGraphThread 只对 v3 统一图（v2 checkpoint）调用，v1 custom-Skill checkpoint 直接视为线程 ok
  - 依据：server/rag/agent-run-recovery.js：const thread = unifiedGraph ? await verifyLangGraphThread(...) : { ok: true, reason: null }
  - 2026-11-14 更新（阶段 10）：verifyLangGraphThread 随 v3 统一图删除，现在 grep 不到；v2 checkpoint 的 run 不对账、不续跑，没结束的直接转人工。上面的依据到阶段 10 之前成立
- **requestFlow 第 5 步**
  - 原以为：节点 preflight 被停靠 → interrupt
  - 实际：只有后续层没有独立工作时才 interrupt；否则停靠节点返回回执，先跑完独立层，再丢线程、按原生方式持久化暂停
  - 依据：AGENTS.md「Approval parking」（hasExecutionGraphWorkBeforePause）；run-execution-graph.js 中 interrupts.length === 0 && parked.length > 0 时 deleteThread
  - 2026-11-14 更新（阶段 10）：这是 v3 图内审批的行为，入口已随 v3 统一图删除；审批停靠的代码还在共用的执行器里，没有生产调用方，下一步删
- **questionLadder L4 多实例题**
  - 原以为：图 run：在途 step 判 unknown_in_flight_node 转人工
  - 实际：补充节点边界情形：恢复进程可能认领并接着跑，原 worker 下一次写被 fence、那次请求失败
  - 依据：agent-run-recovery.js：reconciliation.ok 且无 claim 时直接 claimExecutionGraphResume；assertExecutionGraphRunOwner 对 claim 不符的写抛 AGENT_GRAPH_EXECUTION_FENCED
- **questionLadder L4 规模题**
  - 原以为：冷 run 靠 AGENT_RUN_RETENTION_DAYS 归档
  - 实际：按期删除已结束的 run（不是归档）
  - 依据：AGENTS.md Retention 一节；postgres-agent-run-store.js deleteExpired 删除 completed/failed/canceled 的 run 及事件
- **questionLadder cursor 题效果要点**
  - 原以为：效果：/chat 的 run 回读 26→0，租户往返 167→22，租户 4 实例 +37.9%
  - 实际：加注 167 到 22 和 +37.9% 里大部分来自租户语句流水线，不全是 run store；往返数是并发 1 按差值算的
  - 依据：docs/evaluation.md「每次 /chat 的数据库往返」表：租户 BEGIN/COMMIT 41/41 到 2/2 占大头，run 读只有 26
- **elevatorPitch**
  - 原以为：图内审批用 LangGraph 的 interrupt + 同一线程 Command(resume)（未说明默认状态）
  - 实际：标明这是 v3 guarded 路径、默认 off，默认生效的是 V1 capability_call 审批
  - 依据：AGENTS.md：AGENT_UNIFIED_GRAPH_ROLLOUT 默认 off；CURRENT-TRUTH.md 第 4 节「架构」
  - 2026-11-14 更新（阶段 10）：v3 统一图已删除，30 秒讲法改成「图内审批做过、随 v3 删了，现在生效的只有外层计划的 capability_call 审批」；AGENT_UNIFIED_GRAPH_ROLLOUT 现在只接受未设置、空值或 off，其他取值拒绝启动（CURRENT-TRUTH.md 3.51）
- **decisions 第 6 条 evidence / alternativesRejected**
  - 原以为：只有 CURRENT-TRUTH 3.28 写放大数字
  - 实际：补充 ADR 0001「不可放松的约束」第 2 条（不用 PostgresSaver 的 checkpoints 表）与 ADR 方案 B（只换 checkpointer 会得到两套 checkpoint）作为选型依据
  - 依据：docs/adr/0001-langgraph-runtime.md 第 40 行与「备选方案」表
- **keyFiles**
  - 原以为：缺少幂等键与运维动作所在文件
  - 实际：新增 server/rag/capabilities/artifacts.js（buildCapabilityArtifactIdempotencyKey）和 server/rag/agent-run-recovery-actions.js（AGENT_RUN_RECOVERY_ACTIONS）
  - 依据：grep 到 export const buildCapabilityArtifactIdempotencyKey 与 AGENT_RUN_RECOVERY_ACTIONS = { cancel, resume_from_step, retry_failed_step }
  - 2026-11-13 更新（阶段 9）：resume_from_step 已删除，现在是 AGENT_RUN_RECOVERY_ACTIONS = { cancel, retry_failed_step }；上面的依据到阶段 9 之前成立
- **staleInExistingDocs CURRENT-TRUTH 第 4 节条目**
  - 原以为：上下文丢失回落 owner……已过时
  - 实际：改为部分过时：strict 和角色拆分已实现但可选，默认 lenient 仍回落 owner 路径
  - 依据：server/rag/config.js POSTGRES_TENANT_CONTEXT_MODES 与 getPostgresTenantContextMode；AGENTS.md：POSTGRES_TENANT_CONTEXT 默认 lenient，角色拆分 opt-in
