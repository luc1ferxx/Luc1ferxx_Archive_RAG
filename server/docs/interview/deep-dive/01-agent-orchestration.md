# 01 Agent 编排与规划

> 范围：Agent 编排与规划（意图/执行规划、Skill 契约、typed DAG、v3 统一图（做过，2026-11-14 已删除）、LangGraph 迁移、结构化输出、预算、记忆）
>
> 回到 [总手册](../DEEP-DIVE-PLAYBOOK.md)。数字出处以 [CURRENT-TRUTH.md](../CURRENT-TRUTH.md) 和 `docs/evaluation.md` 为准；代码位置写成「路径 + 函数/常量名」，均经核验代理 grep 确认。

## 30 秒讲法

编排层是「模型只提议、运行时决定」的受控 Plan-and-Execute。正则规则先生成白名单意图候选，LLM 在按请求现生成的 strict JSON Schema 下只能从中选一个；执行规划器只能在 8 种固定阶段里挑选和排序。只有自定义 Skill 阶段由模型画 typed DAG：纯函数校验器整图接受或整图拒绝，模型的图被拒就换成确定性图；确定性图也被拒时不执行任何 Skill，逐个记录原因（以前这里退回 V1 顺序链，2026-11-13 已删除）。换图只发生在任何节点执行之前。权限、文档范围、预算、审批、并发、重试上限都归运行时；配了 PostgreSQL 时 run、step、事件和图 checkpoint 都在库里，用版本号 CAS 挡住旧 worker，有副作用的步骤不会自动重放。整个 Agent 现在只有 LangGraph.js 一种运行时：迁移时需要持久状态和审批中断的两张图（custom-Skill DAG 和后来删掉的 v3 统一图）先迁过去；外层计划放到 LangGraph 上并发 1 时 CPU +17.6%，过不了 10% 的硬门，一度留在原生循环，2026-11-13 按用户「不要两种运作模式」的决定也迁了过去，门没有重测，接受的代价是进程内每次运行多约 0.3 ms CPU。同一天删了 custom Skill 阶段的 V1 顺序链，那是最后一条不走 LangGraph 的路径：按代码和默认配置它作为兜底在生产里已经不会真正执行任何 Skill，代价是不能再手动重试单个失败的 Skill 步骤、少了两个 trajectory 用例。效果数字只来自本地 qwen2.5:7b：结构化输出把规划降级从 56% 降到 8%，但 7B 动态组合 Skill 只过 2/5。我还做过 v3 统一图：把整个请求规划成一张受治理的图，放在开关后面，默认一直关。它的运行时契约（整图准入、数据边界、图内审批）测过，但 7B 规划 15 次只被采纳 3 次，一次文档问答的 CPU 约 1 ms 对 11–15 ms，还有六类请求答不了。2026-11-14 用户要 agent 只留一种回答请求的方式，把它删了：现在每个请求都由外层执行计划回答，失去的是图内审批和「证据检查通过才运行 Skill」这类编排。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `server/rag/agent.js` | 主流程 runAgentRag / runAgentRagInScope：意图规划 → 会话 → 原子 Skill 目录（listAuthorizedAtomicCustomSkills）→ 建 run → 准备 → 外层执行计划 → finalize；异常转审批澄清或 failRun 终态（阶段 10 删除了这里的 v3 guarded、shadow 两个分支和图内审批续跑；带 agentRunId 重入一个停在审批门上的已存 v3 run 现在答 409 unified_graph_removed） |
| `server/rag/agent-intent-rules.js` | 正则信号生成白名单意图候选 buildIntentPlanCandidates，最后总会补一个 document / document_web 兜底候选 |
| `server/rag/agent-intent-llm-adapter.js` | LLM 意图规划：候选 id 做成 enum schema（buildIntentPlannerResponseFormat），理由限 220 字符；deterministicIntentPlannerAdapter 选第一个候选 |
| `server/rag/agent-intent-planner.js / agent-intent-validator.js` | createAgentIntentPlanResult：LLM 选择抛错就退到确定性；resolveSelectedCandidate 拒绝不在候选里的 id |
| `server/rag/agent-intent-memory-hints.js` | applyExperienceHintsToCandidates：用经验记忆重排候选，或补入白名单意图（置信度不低于 0.45） |
| `server/rag/agent-bootstrap.js / agent-preparation-flow.js` | createAgentSession（Skill match、工作记忆、预算）；prepareAgentRun（执行前澄清、检索计划、skill_chain trace） |
| `server/rag/agent-execution-plan.js` | AGENT_EXECUTION_STEP_SCHEMA 定义 8 种外层阶段；validateAgentExecutionPlan（含 validateWebFallbackOrdering）；createDeterministicAgentExecutionPlan |
| `server/rag/agent-llm-planner-adapter.js` | LLM 执行规划：buildPlannerResponseFormat 给每个可用阶段一个变体（oneOfSchemas，实际生成 anyOf）；getSelectedExecutionStepIds 决定本次可用阶段；normalizePlannerPayload 静默丢掉未选中的阶段 |
| `server/rag/agent-execution-plan-runner.js` | 外层计划的阶段体 createAgentExecutionPlanStages 和唯一入口 runAgentExecutionPlan：懒加载图模块，把每个计划交给 runAgentExecutionPlanOnLangGraph；isAgentExecutionPlanStageStaticallyInert 判断哪些内置阶段可以静态剪掉（阶段 7 删除了这里的原生 for 循环和 resolveAgentExecutionPlanRunner） |
| `server/rag/structured-output.js` | strict schema 构造（boundedString 用 pattern 限长、boundedArray 用 maxItems）和 extractFirstJsonValue / parseFirstJsonValue 容错解析 |
| `server/rag/agent-execution-graph.js` | 版本化 ExecutionGraph 契约；纯函数 validateExecutionGraph / compileExecutionGraph；EXECUTION_GRAPH_LIMITS 为 12 节点、深度 5、并发 3 |
| `server/rag/agent-dag-planner-adapter.js` | 脱敏规划上下文 buildDagPlanningContext；capNodesToBudget；回落链 createAgentExecutionGraphResult（模型的图 → 确定性图；模型的图按调用预算整张校验，确定性图不在这里按预算拒绝）；确定性图 createDeterministicExecutionGraph（选中的 Skill 按顺序连起来，规划的是已删除的 V1 顺序链当年跑的那些 Skill；两者不等价：前一个节点失败或被跳过时，依赖它的后一个节点也不跑，链会照样跑后一个） |
| `server/rag/agent-custom-skill-stage.js` | runCustomSkillStage：custom Skill 唯一的执行方式（阶段 8 删除了 off、shadow 两档和整图被拒时的 runV1）。规划 typed DAG、写图 checkpoint、交给 LangGraph 执行器；整张图被拒时不执行任何 Skill，reportSkillsNotRun 给每个选中的 Skill 记一条失败结果（AGENT_SKILL_GRAPH_REJECTED），trace 里一条 skill_graph_rejected |
| `server/rag/agent-replanner.js` | 有界重规划：DEFAULT_MAX_REPLANS=1，只打补丁，用指纹去重，补丁重走同一校验器 |
| `server/rag/agent-execution-graph-node.js / agent-execution-graph-runner.js` | 单节点执行（输入输出 schema 门、原子预算预留、围栏 step 生命周期）；准入 admitExecutionGraphRun、收尾、replayExecutionGraphRun（后者阶段 10 之后没有生产调用方，下一步删） |
| `server/rag/langgraph/run-execution-graph.js` | runExecutionGraphOnLangGraph：custom-Skill 图唯一的调度器（阶段 6 删除了原生调度器）。阶段 10 之前它还调度 v3 统一图；节点停在审批门和同一线程续跑审批的部分现在没有生产调用方，下一步删 |
| `server/rag/langgraph/checkpointer.js / concurrency-gate.js / drain-bridge.js` | RunStoreCheckpointSaver 写现有 run 行；进程内并发闸门；取消走 drain，不把 signal 交给 LangGraph |
| `server/rag/langgraph/planner-model.js / model.js` | completePlannerText：四个规划器经 ArchiveRagChatModel 调用（maxRetries 0，拒绝 withRetry/withFallbacks）；原来是五个，v3 统一图的规划器阶段 10 删除 |
| `server/rag/langgraph/execution-plan-graph.js / agent-stream.js` | runAgentExecutionPlanOnLangGraph：外层计划唯一的调度器（阶段 7 起）。底层 Pregel，不带 checkpointer，按计划形状只编译一次，静态剪掉不起作用的内置阶段；压测 10% 的门没过，是按用户决定接受的代价。streamAgentRun：`/chat/stream` 唯一的路径（阶段 7 删除了 routes/chat.js 的原生分支），SSE 字节不变 |
| `server/rag/agent-removed-unified-graph.js` | v3 统一图留下的全部代码（93 行，阶段 10 新增）：认出已存的 v3 run（看 checkpoint 版本），决定交给人时用什么原因，拒绝续跑；不运行任何节点，也不决定任何审批门。v3 自己的 14 个模块（规划器和它的模型适配器、授权目录、准入规则、stage、结果与投影等）2026-11-14 已删除；删除之前的代码在提交 21eae0c6 的 server/rag/agent-unified-*.js，设计文本是同一提交的 docs/unified-agent-dag-migration.md |
| `server/rag/skills/registry.js / skill-contract.js / authorized-catalog.js / custom/` | Skill 注册与 V1 必填字段；typed 契约（effects/idempotency/replaySafe）；面向模型的原子目录只收显式契约，阶段 8 起它也是 custom Skill 运行的唯一途径（没有类型契约的 custom Skill 以前靠 V1 顺序链照跑，现在不运行）；4 个只读 custom Skill，都有契约 |
| `server/rag/agent-budget.js / run-usage.js` | 次数预算 DEFAULT_AGENT_BUDGET；token、成本、时长上限按 AsyncLocalStorage 计到 run 上，软截止 |
| `server/rag/agent-working-memory.js / memory.js / long-memory.js / conversation-memory-writes.js` | run 内工作记忆；会话记忆（租户哈希键、需要时用 LLM 改写追问）；长期偏好；只写用户自己话的抑制开关 |
| `server/rag/agent-run-recovery.js / agent-execution-graph-checkpoint.js / agent-run-step-replay-safety.js` | 启动恢复（hasGraphOnlyStoredExecutionPlan：custom-Skill 图续跑的前提之一，存下的外层计划恰好只有 custom_skills；没有图可续的 run 由 explainInterruptedRun 给出原因后转人工，不重放步骤。阶段 9 删除了 findAutoRecoverableStep 和启动时的单步重放；阶段 10 起已存的 v3 run 不续跑，没结束的转人工）；图 checkpoint 校验与对账；步骤重放安全矩阵（isStepRetryAllowed：失败的步骤能不能由人重试；阶段 9 删除了「可自动重放」一列和 isAutoReplaySafeStepType） |
| `docs/adr/0001-langgraph-runtime.md` | 迁移决策、14 条不可放松约束、阶段 0–10 的结果：阶段 5 决定外层计划留在原生循环，阶段 7（2026-11-13）按用户的新决定删除原生循环、只走 LangGraph，阶段 8（同一天）删除 custom Skill 阶段的 V1 顺序链，阶段 9（同一天）删除 custom_skill 步骤的独立处理器、启动时的单步重放和 resume_from_step 动作，阶段 10（2026-11-14）删除 v3 统一图 |

## 一次请求怎么经过这里

1) routes/chat.js 用 runAgentRequestWithCancellation（定义在 rag/request-deadline.js）绑定请求截止时间 → app-services.js buildChatResponse → agent.js runAgentRag：runWithRunUsage 为这次调用建用量计量（AsyncLocalStorage），withAgentRunSpan 打开 invoke_agent span。
2) runAgentRagInScope：请求带 agentRunId，且它指向一个停在审批门上的已存 v3 run → 409 unified_graph_removed，run 转人工（阶段 10 之前这里是图内审批续跑 continueAgentExecutionGraphApprovalInScope，还没有审批决定时把待审批的内容再说一遍；v3 统一图 2026-11-14 删除后这两条入口都没有了）。
3) loadAgentExperienceMemorySafely 读经验记忆 → createAgentIntentPlanResult（包在 withPlannerSpan 里）：buildIntentPlanCandidates 用正则信号生成候选 → applyExperienceHintsToCandidates 重排或补候选 → llmIntentPlannerAdapter.selectIntentPlan（completePlannerText，候选 id 做 enum schema）→ resolveSelectedCandidate；抛错就由 deterministicIntentPlannerAdapter 选（重排后的）第一个候选。
4) createAgentSession（agent-bootstrap.js）：registry.select 调各 Skill 的 match()，再 orderSelectedSkills、createAgentWorkingMemory、createAgentRunContext（预算）。回到 runAgentRagInScope：listAuthorizedAtomicCustomSkills 用 getDocument(docId, accessScope) 逐个核验文档，得到原子 Skill 目录（阶段 8 起无条件调用；以前只在 AGENT_SKILL_GRAPH_ROLLOUT 不是 off 时调用）。
5) createAgentRunCursor + agentRunService.createRun（重入时 updateRun 带 graphReentryGuard）；createAgentRunStepLifecycle。
6) prepareAgentRun：记 plan trace → buildPreExecutionClarification（缺文档、对比不足 2 份、超过 12 份时直接返回澄清）→ buildAgentRetrievalPlan。
7) （这一步 2026-11-14 已删除，编号保留。）阶段 10 之前，AGENT_UNIFIED_GRAPH_ROLLOUT=guarded 时这里走 v3 统一图：规划 → validateExecutionGraph → 整图准入 → stage 在 LangGraph 上执行 → 投影回 V1 状态 → finalizeAgentRun → 写 finalization 收据；被拒就落回外层计划，shadow 档只旁路规划、记一条 unified_graph_planned 事件。现在每个请求都直接走第 8 步的外层执行计划；开关设成 guarded、shadow 或其他任何值，进程拒绝启动（CURRENT-TRUTH §3.51）。
8) createAgentExecutionPlanResult：llmPlannerAdapter.createExecutionPlan（schema 由 buildPlannerResponseFormat 生成）→ normalizePlannerPayload → validateAgentExecutionPlan；失败就用 createDeterministicAgentExecutionPlan。记 execution_planned 事件。
9) runAgentExecutionPlan → runAgentExecutionPlanOnLangGraph（langgraph/execution-plan-graph.js：底层 Pregel，按计划顺序一个阶段一个节点，每个节点入口是请求取消的安全点；阶段 7 之前这里是原生循环）：arxiv_import / workspace_action / research_brief / inventory / document_discovery（Skill 未选中时这些内置阶段被静态剪掉，不建节点）→ custom_skills（runCustomSkillStage → createAgentExecutionGraphResult → runExecutionGraphOnLangGraph；整图被拒时不执行任何 Skill，记 skill_graph_rejected，阶段 8 之前这里走 runV1）→ document_rag（runDocumentRagLoop：主调用 → 自检 → 缺口分析 → 最多 1 次补检索）→ web_search（Web Skill 被选中时直接跑；否则只在文档弃答或失败时兜底）。哪个阶段设置了 response，计划就在那里结束。
10) throwIfRequestCancelled → finalizeAgentRun（agent-finalization-flow.js：选来源、合成答案、finalizer 删掉没有支持的 claim）→ completeRecordedRunAndExperience（写经验记忆、完成 run）。
11) 异常分支：AgentRunInterrupt → 返回审批澄清并完成 run；截止、断连、依赖故障 → resolveAgentRunTermination + endRunForTermination（failRun 走 CAS，答 504/499/503）；AGENT_GRAPH_EXECUTION_FENCED 直接抛出，不改 run；其他错误 → failRun。

## 设计决策

### D1. 意图识别：正则规则先生成白名单候选，LLM 只在候选 id 的 enum 里选一个，失败时由确定性规划器选第一个

**为什么**

- 模型不能发明意图、工具或权限
- 每次选择可审计，候选、理由、是否回落都写进 planner 观测
- 模型挂了或乱答时能确定性降级

**为什么不用主流替代方案**

- 纯 LLM 自由分类：输出无界，会越界
- embedding / 语义路由：要标注集，项目里没有
- LangChain createAgent 自由 ReAct：ADR 约束 1 明确不用

**代价**

- 规则没生成的意图模型选不了（经验记忆只能补白名单内的意图）
- 正则会误路由：compare/between 被判成对比，RAG-Sequence 被判成时间线；修复开关 AGENT_SINGLE_DOCUMENT_ROUTING 默认关
- 只有一个候选时也调一次模型，代码里没有短路

**证据**

- 意图选择本身没有单独的实测
- CURRENT-TRUTH §3.3 的降级 14/25 → 2/25 是 planner eval 整体（主要衡量执行规划器；降级原因是 step 条件写错、输出未选中的 step、DAG 绑定不存在的字段），不能说成意图识别的效果
- §3.21：逐次读 trace 归类时发现了路由误判

**代码**：server/rag/agent-intent-rules.js buildIntentPlanCandidates; server/rag/agent-intent-llm-adapter.js buildIntentPlannerResponseFormat, deterministicIntentPlannerAdapter; server/rag/agent-intent-validator.js resolveSelectedCandidate

### D2. 外层执行计划：8 种固定阶段，LLM 只能在本次可用的阶段里挑选和排序，阶段条件由 schema 固定（selected_skill / selected_custom_skills / selected_or_document_fallback），是否真正执行由运行时判断

**为什么**

- 阶段语义、预算键、accessScope 要求都写死在 AGENT_EXECUTION_STEP_SCHEMA
- Web 只能排在 document_rag 之后做兜底（validateWebFallbackOrdering）

**为什么不用主流替代方案**

- LLM 自由编排工具序列
- LangGraph 条件边：阶段顺序由校验过的计划决定，不需要图里再做路由。外层现在虽然由 LangGraph 调度（阶段 7，见 D8），也只是按计划顺序一个阶段一个节点，唯一的分支是某个阶段设置了 response 就提前结束

**代价**

- 表达不了「证据不足 → Web → 结果交给 Skill」这类条件编排，这正是当初做 v3 统一图的动机。v3 统一图 2026-11-14 删除后，这类编排又表达不了了：Skill 只在文档答案通过证据检查之后运行，以后想要得在外层计划里另做（§3.51）
- 执行规划器对未选中的阶段是静默丢弃（normalizePlannerPayload 里 continue），不是整体拒绝；未知阶段 id 仍由 validateAgentExecutionPlan 整体拒绝
- 校验器不要求包含所有已选阶段，LLM 可以省略阶段

**证据**

- docs/unified-agent-dag-migration.md（现在是历史记录）：外层执行计划里 Skill 先跑、无条件跑，v3 统一图做到过「Skill 只在文档答案通过证据检查之后运行」。当时证明这一点的 trajectory 用例 unified_graph_evidence_gated_skill_hand_off 是 mock 下的运行时契约证据，2026-11-14 随 v3 统一图一起删了

**代码**：server/rag/agent-execution-plan.js AGENT_EXECUTION_STEP_SCHEMA, validateAgentExecutionPlan; server/rag/agent-llm-planner-adapter.js buildPlannerResponseFormat, normalizePlannerPayload

### D3. 结构化输出：每个请求按运行时白名单现生成 strict JSON Schema，自由文本用 pattern 限长、数组用 maxItems；解析取第一个完整 JSON 值；校验器做最终裁决

**为什么**

- 7B 模型的降级全是格式错误或越界
- Ollama 不硬执行 schema：JSON 闭合后还会接着写
- 不限长度的 rationale 会让约束解码停不下来

**为什么不用主流替代方案**

- 规划器改用 withStructuredOutput（ArchiveRagChatModel 上的 LangChain 接口）：「文字里带括号、后面跟 fenced JSON」时解析失败；不接受意图规划器在无候选时的 null schema；replan 调用不发 schema（见 planner-model.js 注释）
- 只改 prompt：对照组几乎没提升
- 用 maxLength：strict 模式文档只列了 pattern

**代价**

- schema 构造和校验器是两份要同步维护的逻辑
- 只约束形状，不约束规划选择对不对
- 端点不支持 response_format 时，RAG_STRUCTURED_OUTPUT_ENABLED=false 退回只靠 prompt

**证据**

- CURRENT-TRUTH §3.3：用例 14/30 → 24/30，降级 14/25 → 2/25，每轮 14.1s → 14.2s（qwen2.5:7b，各 5 轮）
- NARRATIVE-CASES 故事 2：单次调用 754 token/15s → 374 token/7s

**代码**：server/rag/structured-output.js boundedString, buildJsonSchemaResponseFormat, parseFirstJsonValue; server/rag/config.js isStructuredOutputEnabled

### D4. 自定义 Skill 阶段用 typed DAG：节点输入只能绑定请求字段或上游节点的 typed 输出；纯函数校验器整图接受或拒绝；伪造运行时字段整图拒绝，不清洗

**为什么**

- 非法图不会被部分执行
- 取代 V1 的自由文本拼接（buildChainedSkillQuestion 把前 3 个结果拼进问题；这个函数和 V1 顺序链 2026-11-13 已删除），避免上下文膨胀和注入面
- 清洗等于教规划器「多要权限没代价」

**为什么不用主流替代方案**

- 清洗后执行
- 继续用 V1 文本链（当时的备选；V1 顺序链 2026-11-13 已删除）
- 完全交给框架的动态图：校验和权限仍要自己做

**代价**

- 输出只是答案封套（text / citations / abstained），priorFindings 仍是上游 text，不是经过语义校验的结构化对象
- 默认 custom 预算 2，capNodesToBudget 把节点上限压到 2，12 节点上限基本是理论值
- 7B 动态组合弱

**证据**

- CURRENT-TRUTH §3.5：动态组合用例（只选了对比，要求规划出对比 → 风险审查）2/5
- docs/agent-rag.md「Validator」：校验器 reason code 清单

**代码**：server/rag/agent-execution-graph.js validateExecutionGraph, EXECUTION_GRAPH_LIMITS, FORGED_POLICY_FIELDS; server/rag/skills/skill-contract.js EXECUTION_REQUEST_FIELD_TYPES, isAssignableValueType; server/rag/agent-dag-planner-adapter.js capNodesToBudget

### D5. 回落链：LLM 图 → 确定性图，只在任何节点执行之前换；确定性图也被拒就不执行任何 Skill（2026-11-13 之前还有第三级 V1 顺序链，阶段 8 删除）；一旦有节点执行就不再换计划

**为什么**

- 节点执行后换一套计划重跑，会重复计费，还可能重复副作用
- 删掉第三级是用户的决定：要 agent 只有一种运作方式，V1 顺序链是最后一条不走 LangGraph 的路径。用户先要方案，看过调查和三个方案后选了「只走图」
- 调查（CURRENT-TRUTH §3.49）：给阶段加记录点，全量测试和三个确定性评测进入阶段 188 次，被拒后回落到顺序链 14 次，全部在测试里；按代码和默认配置，回落在生产里不会执行任何 Skill
- 顺序链替预算兜的底现在由图自己做：确定性图在规划时不按调用预算拒绝，执行器在节点启动时预留预算，付不起的节点跳过；模型的图仍按预算整张校验

**为什么不用主流替代方案**

- 失败后整体换 V1 重跑
- 两条路径都跑再挑结果
- 留着 V1 顺序链当第三级兜底（2026-11-13 之前的做法）：用户不要第二种运作方式，调查又显示默认配置下它在生产里不执行任何 Skill

**代价**

- 已部分执行又失败的 run 只能失败（已删除的 v3 统一图里，非主节点失败返回 409 AGENT_UNIFIED_GRAPH_PARTIAL）
- 回落后失去动态组合，用户拿到的是规则版回答
- 删掉第三级之后：整张图因预算以外的原因被拒时，选中的 Skill 一个都不跑，各记一条失败结果；没有类型契约的 custom Skill 不再运行；不能再手动重试单个失败的 custom Skill 步骤；没有运行时开关能回到顺序链，只能 git revert

**证据**

- CURRENT-TRUTH §3.17：v3 规划 15 次，采纳 3 次，12 次回落确定性图，0 次回 V1（qwen2.5:7b；历史测量，v3 统一图 2026-11-14 已删除）
- §3.49：阶段进入 188 次，被拒回落 14 次，全在测试里，三个评测里 0 次
- §3.49：冻结提交把顺序链的回答写进 test/agent-custom-skill-budget.test.mjs；删除后默认预算、预算 1 次、预算 0 次的答案不变（预算 1 次和 0 次的记录有差别），阶段核实不了文档时答案从两段结论变成弃答（/chat 走不到）

**代码**：server/rag/agent-dag-planner-adapter.js createAgentExecutionGraphResult; server/rag/agent-custom-skill-stage.js runCustomSkillStage, AGENT_SKILL_GRAPH_REJECTED_CODE

### D6. 有界重规划：最多 1 次，只打补丁，补丁过同一个校验器，指纹去重；写副作用的节点失败后不重规划；只在实际用的是 LLM 规划器时才接线

**为什么**

- 终止性可证明
- 重规划不能用来绕过第一次被拒的东西
- 确定性或 shadow 档下没有可回落的确定性重规划器，接上就等于让模型绕过灰度开关

**为什么不用主流替代方案**

- Reflexion 或 ReAct 式无界循环重试

**代价**

- 适应性有限
- 把上限调高没做过灰度验证

**证据**

- 无真实模型实测
- CURRENT-TRUTH §3.30：recovery-observability 8/8（replan 信号来自注入的确定性 replanner，不是真实模型）

**代码**：server/rag/agent-replanner.js DEFAULT_MAX_REPLANS, createReplanResult, fingerprintExecutionGraph, buildReplanContext; server/app-services.js createReplanAdapter

### D7. 执行器开关和规划器开关拆开（2026-09-25 的转正决定）：当时 AGENT_SKILL_GRAPH_ROLLOUT 决定执行器（默认改成 guarded），AGENT_EXECUTION_PLANNER 决定谁来规划；执行器按执行语义的证据转正。2026-11-13 阶段 8 之后执行器只剩 DAG 一个，前一个开关不再选择任何东西

**为什么**

- rollout:readiness 要求真实 LLM 规划零降级，衡量的是规划质量
- LLM 规划失败退回的是确定性 DAG，不是 V1，所以不影响执行器本身是否安全

**为什么不用主流替代方案**

- 等 7B 也能过零降级门再转正：一直达不到

**代价**

- 执行规划器能看到已授权的原子 Skill，可能给普通问答多加一个 custom_skills 阶段（当时只在 guarded 下；阶段 8 起没有别的档位）
- AGENT_SKILL_GRAPH_ROLLOUT 现在只接受未设置、空值、空白或 guarded；off、shadow 和拼错的值让进程拒绝启动（AGENT_SKILL_GRAPH_ROLLOUT_REMOVED）。阶段 8 之前，不认识的取值解析为 off，也就是 V1 顺序链

**证据**

- CURRENT-TRUTH §3.5：guarded 下用例 27/30、降级 0/25（off 时 24/30、2/25，差异在噪声内；off 那一组现在跑不出来）
- 文档问答 5/5 都没被多加阶段
- 全量测试 + PostgreSQL 集成测试 15/15（其中 5 个是图恢复跨进程与 CAS 竞争）

**代码**：server/rag/config.js assertAgentRuntimeSupported, AGENT_SKILL_GRAPH_ROLLOUT_REMOVED_CODE, getAgentExecutionPlanner（getAgentSkillGraphRollout 已在阶段 8 删除）; server/app-services.js createDagPlannerAdapter

### D8. 整个 Agent 只有 LangGraph.js 一种运行时：先迁需要持久状态和中断的两张图（custom-Skill DAG、v3 统一图）；外层计划因压测不过门留在原生循环，2026-11-13 按用户决定也迁过去（阶段 7）；custom Skill 阶段的 V1 顺序链同一天删除（阶段 8）；阶段 8 留下的 custom_skill 步骤单独重试和单独重放也在同一天删除（阶段 9）；v3 统一图 2026-11-14 删除，回答请求只剩外层执行计划一种方式（阶段 10）

**为什么**

- LangGraph 的价值是 checkpoint、interrupt()/Command({resume}) 和 stream，迁移时需要它们的是 custom-Skill DAG 和 v3 统一图（v3 2026-11-14 已删除；用 interrupt()/Command({resume}) 的图内审批续跑现在没有生产调用方，下一步删）
- 外层计划没有中断，持久化靠 run 的 step（外层图不带 checkpointer）。它迁过去不是因为需要这些能力，而是用户不要两种运作模式：只用已经迁好的 LangGraph
- 压测硬门（CPU/请求和 p95 退化不超过 10%）外层计划两次都没过，所以阶段 3、阶段 5 把它留在原生循环。阶段 7 没有重测，门仍然没过，是明知不达标、接受代价
- 阶段 7 之后还剩一条不走 LangGraph 的路径：custom Skill 阶段的 V1 顺序链（off、shadow 两档，以及 guarded 下整图被拒时的回落）。用户看过调查和方案后决定把它也删了（阶段 8），调查和代价见 D5；这一步没有量性能，不是性能改进
- 阶段 8 把只有顺序链存下的旧 run 才走得到的重试和恢复代码留了下来，并问了用户要不要删；用户的回答是「接着清理」，阶段 9 把它们删了：custom_skill 步骤的独立处理器、step executor 的 resumeStep、启动时的单步重放、恢复动作 resume_from_step、矩阵的「可自动重放」一列。现在 custom Skill 只作为图节点运行，启动恢复自己只续跑中断的图，其余中断的 run 交给人（CURRENT-TRUTH §3.50）
- 阶段 9 之后每条路径都在 LangGraph 上，但回答一个请求还有两种方式：默认的外层执行计划，和开关 AGENT_UNIFIED_GRAPH_ROLLOUT 后面的 v3 统一图。它不是第二个运行时，是第二种回答方式。用户先要方案，看过清点结果和三个选项后选了方案 A：删掉 v3 统一图，只留外层执行计划（阶段 10，2026-11-14）。清点和理由见 D13；这一步同样不是性能改进

**为什么不用主流替代方案**

- 全部编进 StateGraph：并发 32 时 CPU +29–35%
- 外层长期留在原生循环（2026-10-16 的决定）：底层 Pregel + 编译缓存 + 剪枝后并发 1 仍 +17.6%，当时因此不迁；2026-11-13 被用户的新决定取代
- ADR 方案 A（保持自研）：维护面不缩小
- ADR 方案 B（只换 checkpointer）：脱离 Pregel 调度没有意义

**代价**

- 外层计划每次运行多 0.29 ms CPU（进程内 0.605 → 0.894 ms）；阶段 5 的压测是并发 1 每请求 CPU +17.6%、p95 +13%，阶段 7 没有跑新的压测
- 每个回答 agent 请求的进程在第一个请求时加载 `@langchain/*`（2026-11-13 实测一次性约 115 ms，GC 后常驻内存 82 → 143 MB；默认的 LLM 规划器本来就加载 LangChain core，阶段 7 实际多出约 50 ms、21 MB）；LangSmith 追踪变量为 true 时，所有流式请求和走到外层计划的 /chat 请求都被拒绝（server.js 本来就拒绝带这种变量启动）
- 阶段 6、阶段 7、阶段 8、阶段 9、阶段 10 之后都没有运行时回退开关，只能 git revert
- 阶段 8 的代价：不能再手动重试单个失败的 custom Skill 步骤；trajectory 少了 custom_skill_retry 和 skill_graph_shadow_comparison 两个用例；shadow 对照没有了
- 阶段 9 的代价：顺序链留下的旧 run 中断了只能取消、失败了不能单步重试，要得到答案只能重新提问；resumeStep 这项通用能力没有了（它没有别的调用方）；恢复评测少了两项检查（29 → 27 项，8 个用例不变，阈值没改）
- 阶段 10 的代价：两种编排（Skill 只在文档答案通过证据检查之后运行并拿到已验证的答案；审批的任务内容来自已验证的文档答案）、图内审批和它的 7 个跨进程 PostgreSQL 用例、v3 的真实模型规划评测、shadow 观测都没有了；开过 guarded 的部署里没结束的 v3 run 只能由人取消；trajectory 少了两个用例、planner 少了一个；共用图模块里只有 v3 用过的代码还没删，这之前「RAG / AgentRAG core」一组覆盖率 94.26%（目标 95%、门 90%）
- superstep 屏障：下游要等最慢的兄弟节点，事件和步骤顺序与原生不同（已钉住）
- 依赖 1.5.0 的两个并发缺陷绕行方案

**证据**

- CURRENT-TRUTH §3.28：StateGraph 下并发 32 每请求 CPU 3.93–4.26 → 5.27–5.47 ms
- §3.29：Pregel 进程内多 0.28 ms；并发 1 每请求 CPU 5.68 → 6.68 ms（+17.6%），p95 9.3 → 10.5 ms（+13%）
- §3.48：删除前进程内 0.605 → 0.894 ms CPU（交替 7 轮、每轮 400 次）；删除前把原生循环的结果冻结成 32 个 golden 文件，删除后各套件只在 LangGraph 上跑、对照 golden；trajectory 19/19、planner 7/7、recovery 8/8 删除前后屏蔽后逐字节一致
- §3.49：删顺序链之后覆盖率闸门 4,595 个测试、0 失败，复核修正之后 4,598 个、0 失败（本机 Node 24）；planner 7/7、recovery 8/8 删除前后屏蔽后逐字节一致；trajectory 从 19/19（84 项检查）变成 17/17（76 项），共有的 17 个用例里 16 个逐字节一致，另一个只差 V1 对照从 4 次变 2 次
- §3.50：阶段 9 之后覆盖率闸门 4,607 个测试、0 失败（本机 Node 24；合并进 main 之后 CI 的 Node 22.23.4 上也通过（合并提交 db3ed97b，运行 43529876304：4,607 个测试，4,599 通过、8 跳过、0 失败，行覆盖 92.52%））；planner 7/7、trajectory 17/17 改动前后屏蔽后逐字节一致；recovery 8/8，检查项 29 → 27，报告有 51 处差异，都在随功能删掉的范围内；冻结提交把 custom_skill 步骤被单独重放时的行为写成 10 个测试（test/agent-skill-step-replay.test.mjs）
- §3.51：阶段 10 之后覆盖率闸门 4,469 个测试、0 失败（4,462 通过、7 跳过），全局行覆盖 91.90%（本机 Node 24.21.0；CI 用的是 Node 22，本机没有）；trajectory 共有的 15 个用例、planner 共有的 6 个用例删除前后屏蔽后逐字节一致，recovery 的用例和指标逐字节一致；冻结提交把新请求和已存 v3 run 的行为写成两个字面期望的测试文件（13 个测试）

**代码**：server/rag/agent-execution-plan-runner.js runAgentExecutionPlan, createAgentExecutionPlanStages; server/rag/langgraph/execution-plan-graph.js runAgentExecutionPlanOnLangGraph; server/rag/langgraph/agent-stream.js streamAgentRun; server/rag/config.js assertAgentRuntimeSupported, AGENT_OUTER_PLAN_RUNTIME_REMOVED_CODE, AGENT_SKILL_GRAPH_ROLLOUT_REMOVED_CODE, AGENT_UNIFIED_GRAPH_ROLLOUT_REMOVED_CODE; server/rag/agent-removed-unified-graph.js

### D9. LangGraph 落地细节：自定义 RunStoreCheckpointSaver 写现有 run 行，图 checkpoint 仍是权威；取消用 drain，不把 AbortSignal 交给 LangGraph；并发上限放在进程内闸门；LangSmith 永不启用

**为什么**

- 不出现第二套 run store 和第二套回放矩阵，沿用 revision CAS 和 RLS
- spike 证明直接传 signal 是「至少一次」：在途节点被放弃，续跑时重跑
- LangGraph 1.5.0 的 maxConcurrency 小于 superstep 宽度时会丢任务

**为什么不用主流替代方案**

- 官方 PostgresSaver：独立的 checkpoints 表，不走现有 CAS 和事件契约
- 直接用 RunnableConfig.signal
- 用 LangGraph 自带的 maxConcurrency

**代价**

- 写放大：2 节点的 custom-Skill /chat 多 7 次无事件 CAS、1 次 run 读、1 次事件表读
- 取消只在 superstep 边界生效，在途节点要先结算（其中真实模型调用仍会被请求 signal 中止、以失败结束；ADR 写明 mock 下这点没测到）
- 包装层代码量不小

**证据**

- CURRENT-TRUTH §3.28：写放大数字；完成后 run result 11,894 B（原生 11,860 B）
- ADR「LangGraph 与现有契约的差异」一节

**代码**：server/rag/langgraph/checkpointer.js RunStoreCheckpointSaver, LANGGRAPH_CHECKPOINT_RETENTION; server/rag/langgraph/drain-bridge.js bridgeRequestSignalToDrain; server/rag/langgraph/concurrency-gate.js createExecutionGraphConcurrencyGate; server/rag/langgraph/langsmith-guard.js assertLangSmithTracingDisabled

### D10. 阶段 6 提前删除原生图调度器：删之前把 native 一侧的输出冻结成 golden，代替两套实现长期并跑

**为什么**

- 分支还没发布，回退窗口还没开始计算（用户明确豁免约束 12 的后半条）
- 维护面要真正缩小

**为什么不用主流替代方案**

- 保留 AGENT_RUNTIME=native 一个发布周期，两套并跑

**代价**

- 没有运行时回退开关，只能 git revert
- golden 只覆盖固定场景
- 两个 PostgreSQL 集成套件的 native 一侧没冻结
- golden 在 Node 24 上生成，CI 的 Node 22 上通过

**证据**

- CURRENT-TRUTH §3.30：8 个套件 102 个 golden 文件
- 3,250 个测试 0 失败，行覆盖 90.46%
- trajectory 19/19、planner 7/7、recovery 8/8 屏蔽后与删除前逐字节一致
- runner 文件 478 → 295 行

**代码**：server/rag/config.js assertAgentRuntimeSupported, AGENT_RUNTIME_REMOVED_CODE; server/rag/agent-execution-graph-node.js orderExecutionGraphNodeStatesByLayer; server/rag/agent-execution-graph-runner.js replayExecutionGraphRun

### D11. 预算分两层：次数预算，加上按 AsyncLocalStorage 计到 run 上的 token / 成本 / 时长上限；在步骤边界检查，软截止后降级而不报错

**为什么**

- 次数管不住单次长上下文的花费
- 检索服务深处的模型调用也要算到发起它的 run 上
- 降级路径（澄清、证据受限回答）本来就有

**为什么不用主流替代方案**

- 硬中断在途调用
- 只在模型网关层限流（看不到 run）

**代价**

- 已开始的步骤会跑完：文档写「最多超出一个步骤」，DAG 并发时同时在途的节点都会跑完
- 三个规划器的调用发生在第一个工具之前，计入用量但不受上限阻止
- 每次 runAgentRag 或图恢复是新计量器，token 和成本不跨审批续跑累加
- 默认值（10 万 token、0.5 美元、5 分钟）是按次数预算推算的防失控上限，没用真实流量校准

**证据**

- 无实测校准
- 默认值来自 agent-budget.js DEFAULT_AGENT_BUDGET 和 config.js getAgentRunMaxTokens / getAgentRunMaxCostUsd / getAgentRunMaxDurationMs
- 推算依据见 docs/agent-rag.md「运行预算」

**代码**：server/rag/agent-budget.js DEFAULT_AGENT_BUDGET, consumeBudget, reserveBudget; server/rag/run-usage.js runWithRunUsage, checkRunUsage, resolveRunUsageLimits

### D12. 记忆分四层：工作记忆（run 内）、会话记忆（改写追问，开鉴权时键为租户哈希）、长期偏好、经验记忆（只作规划提示）；只记录用户自己说的话

**为什么**

- 答案证据只能来自本次检索到的文档
- 补检索、子问题和 Skill 拼出的文本写进记忆会污染偏好和改写

**为什么不用主流替代方案**

- mem0 / 向量记忆 / LangChain ConversationBufferMemory：没有正式评估或对比过；理由是没有证据表明需要，而且会引入新的租户数据面（这是作者判断，不是测出来的）

**代价**

- 追问改写在判定需要时（shouldRewriteQuestion）多一次 LLM 调用
- 升级前（迁移 031 之前）的会话对租户不可见
- 经验记忆能重排候选，会改变确定性规划器的选择
- 长期偏好会进改写 prompt 和答案 prompt
- 记忆效果没有评测

**证据**

- CURRENT-TRUTH §3.23：记忆污染与会话越权在代码审查中发现后修复
- 租户角色直接写 SQL 读改删别人的会话：0 行或被拒

**代码**：server/rag/agent-working-memory.js createAgentWorkingMemory; server/rag/memory.js resolveSessionMemoryKey, resolveQueryWithSessionMemory; server/rag/long-memory.js getLongMemoryContext, resolveLongMemoryWorkspace; server/rag/conversation-memory-writes.js runWithoutConversationMemoryWrites; server/rag/index.js recordUserExchange

### D13. v3 统一图：做出来、量过、2026-11-14 删除（阶段 10）。它有 guarded 档（含图内审批续跑），默认一直是 off；准入规则限定数据边界

**为什么**

- 当时为什么这样设计（准入规则守的边界）：
  - 外部节点的字符串输入只能来自 request.question
  - 任何节点的输入都不能绑定外部节点的输出
  - Web 节点必须挂在主文档答案的证据检查不通过上
  - 每张图最多一个审批 Capability
- 为什么删：
  - 用户要 agent 只有一种回答请求的方式。用户先要方案（原话「先出方案」），看过清点结果和三个选项后选了方案 A（原话「按方案 A 做」）：删掉 v3 统一图，只留外层执行计划
  - 让 v3 成为那一种，数字不支持：7B 规划 15 次只被采纳 3 次、每次约 8 秒；一次文档问答的 CPU 约 1 ms 对 11–15 ms；research brief、arXiv 导入等六类请求它答不了，都要先补；证据全是 mock，只证明编排契约
  - 留着不用也有成本：清点时只有它走得到的代码是 22 个文件、8,108 行，测试 17 个文件加 44 份 golden，共用模块的每次改动都要让它的 golden 继续通过

**为什么不用主流替代方案**

- 直接设为默认主图：2026-10-16 阶段 5 的结论是不设（覆盖不了全部请求、被接管的请求行为会变、CPU 是外层计划的数倍、真实模型证据不足）
- 设成默认、留外层计划兜底：阶段 10 没有列为选项，那是两种方式同时在线上回答请求，和用户的要求相反
- 留着、默认关：就是删除之前的状态，成本见上

**代价**

- 它自己的代价（没设为默认的原因）：接管请求后可见行为会变（没有 answer_draft；非主节点失败变成 409；文档拒答时不再提议 Web 审批；custom Skill 请求多一次 document_rag 和一次会话记忆写入）；CPU 是外层计划的数倍到十几倍；7B 规划采纳率很低
- 删除的代价：Skill 只在文档答案通过证据检查之后运行、审批内容来自已验证的答案，这两种编排没有了，以后想要得在外层计划里另做；图内审批和它的 7 个跨进程 PostgreSQL 用例没有了（外层计划的 Capability 审批还在，是另一条路径）；v3 的真实模型规划评测成了历史记录；shadow 观测没有了
- 开过 guarded 的部署里已存的 v3 run：已经结束的不动，没结束的不能再续跑，启动恢复、审批端点和带 agentRunId 的重入都把它交给人，人只能取消
- 没做完的：共用图模块里只有 v3 用过的代码（执行器里节点停在审批门和同一线程续跑、v3 图契约和 v2 checkpoint、run store 的图审批门、Capability 的图预检、任务级的 deny 动作）已经没有生产调用方，下一步删
- 没有开关能回到 v3，只能 git revert

**证据**

- ADR 阶段 5「没有做的部分与理由」：文档问答 V1 约 0.8–1.2 ms CPU，v3 在 LangGraph 上约 11–15 ms（进程内微基准，mock RAG）
- CURRENT-TRUTH §3.17：规划采纳 3/15（本地 qwen2.5:7b）
- CURRENT-TRUTH §3.51、ADR 阶段 10：删除之前的清点（22 个文件、8,108 行；17 个测试文件、138 个测试；44 份 golden）；server/rag 删了 14 个模块，生产代码 +225 −6,717 行；覆盖率闸门 4,469 个测试、0 失败（本机 Node 24）
- 它做到过的都有确定性测试，证据类型是注入提案加 mock：证明的是运行时契约，不是答案质量（docs/unified-agent-dag-migration.md）

**代码**：server/rag/agent-removed-unified-graph.js（留下的全部代码）; server/rag/config.js assertAgentRuntimeSupported, AGENT_UNIFIED_GRAPH_ROLLOUT_REMOVED_CODE; server/test/agent-unified-graph-dial.test.mjs; server/test/agent-stored-unified-graph-runs.test.mjs; 删除之前的实现在提交 21eae0c6 的 server/rag/agent-unified-*.js（runGuardedUnifiedAgentGraph、assessUnifiedGraphAdmission 等，现在 grep 不到）

### D14. Skill 契约：V1 必填字段之外显式声明 effects / idempotency / replaySafe；持久化的声明只进重放矩阵的原因码、放宽不了任何东西；续跑图之前按 live registry 重新校验；面向模型的原子目录只收显式契约

**为什么**

- 只看持久化的 step 时手里没有 live Skill：不把契约存在 step 上，写入型节点的 step 和一次 RAG 读就分不出来
- 推断出来的默认值不能让 Skill 变成模型可调用的能力
- 2026-11-13 阶段 9 之后没有步骤被单独重放，所以这份声明不再决定「能不能自动重放」，只给人看重放它会冒什么风险（原因码）。阶段 9 之前，没有图 checkpoint 的 custom_skill 步骤在整步重放之前还要按 live registry 再查一次（custom-research-steps.js 里的 isSideEffectingSkill）；那个处理器删了，现在 live registry 的复核只在整图续跑里（见 Q13）

**为什么不用主流替代方案**

- 只用 MCP / 函数 schema 描述输入，不声明副作用

**代价**

- 4 个 custom Skill 全是 readOnly，副作用防护守的是还没有实例的边界
- 外层 document_rag 一律标 workspace_write、replaySafe:false，不能当只读

**证据**

- docs/agent-rag.md「当前限制」

**代码**：server/rag/skills/registry.js validateSkillContract, executeAgentSkill; server/rag/skills/skill-contract.js SKILL_EFFECTS, describeSkillReplayContract, inferSkillContractDefaults; server/rag/skills/authorized-catalog.js listAuthorizedAtomicCustomSkills; server/rag/skills/custom/custom-skill-contract.js CUSTOM_RAG_SKILL_CONTRACT

## 追问阶梯

按面试官的追问顺序排。先自己出声答一遍，再看要点。⚠ 是这题最容易答错或夸大的地方。

### Q1. 一次 /chat 进到 Agent 之后走了哪些步骤？

*L1 是什么*

- runAgentRag 先建这次调用的用量计量和 invoke_agent span
- 读经验记忆 → 规则生成意图候选 → LLM 选一个，失败就选（经验重排后的）第一名
- createAgentSession：Skill 的 match() 选技能，建工作记忆和预算；随后核验文档得到原子 Skill 目录
- 在 PostgreSQL 建 run → prepareAgentRun：缺文档、对比不足 2 份时直接澄清
- 执行规划器挑选并排阶段 → 外层计划由 LangGraph 按计划顺序逐阶段调度（底层 Pregel，一个阶段一个节点）：custom_skills 内是另一张 LangGraph 调度的 DAG，document_rag 是自检加最多 1 次补检索，Web 选中时直接跑、否则只做兜底
- finalizeAgentRun 删掉无支持的 claim → 完成 run；审批中断转澄清；超时、断连、依赖故障走 failRun 终态

代码：`server/rag/agent.js runAgentRag, runAgentRagInScope`；`server/rag/agent-intent-planner.js createAgentIntentPlanResult`；`server/rag/agent-bootstrap.js createAgentSession`；`server/rag/agent-preparation-flow.js prepareAgentRun`；`server/rag/agent-execution-plan-runner.js runAgentExecutionPlan`；`server/rag/langgraph/execution-plan-graph.js runAgentExecutionPlanOnLangGraph`；`server/rag/agent-finalization-flow.js finalizeAgentRun`

> ⚠ 2026-11-13 起外层计划和 custom-Skill DAG 都由 LangGraph 调度，可以说「Agent 只有 LangGraph 一种运行时」；2026-11-14 删掉 v3 统一图之后，还可以说「回答请求只有外层执行计划一种方式」。别再说「还有一张 v3 统一图可以打开」：开关设成 guarded 或 shadow，进程拒绝启动。但别说成「LangGraph 负责持久化」或「迁过去更快」：外层图不带 checkpointer，持久化仍是 run 的 step；文档循环是阶段内部的普通代码；外层计划的压测门没过。custom Skill 阶段原来的 V1 顺序链兜底 2026-11-13 已删除，别再说「图被拒了还有 V1 兜底」：现在被拒就不执行任何 Skill。也别说「每一步都由模型决定」：意图候选是正则生成的。

### Q2. 这到底是 Agent 还是 workflow？意图是怎么识别的？

*L1 是什么*

- 是受控的 Plan-and-Execute，不是开放循环
- 意图候选由 agent-intent-rules.js 的正则信号生成，最后总会补一个 document / document_web 兜底候选
- LLM 只能在候选 id 的 enum 里选一个，理由限 220 字符
- 外层是 8 种固定阶段，LLM 只能在本次可用的阶段里挑选和排序
- 只有自定义 Skill 阶段里，模型能自己画节点和依赖（以前还有默认关闭的 v3 统一图，2026-11-14 已删除）

代码：`server/rag/agent-intent-rules.js buildIntentPlanCandidates, AGENT_INTENT_IDS`；`server/rag/agent-intent-llm-adapter.js buildIntentPlannerResponseFormat`；`server/rag/agent-execution-plan.js AGENT_EXECUTION_STEP_SCHEMA`

> ⚠ 规则没生成的意图 LLM 选不了。只有一个候选时也会调一次模型（代码里没有短路）。正则会误路由（§3.21：compare/between、RAG-Sequence），修复开关 AGENT_SINGLE_DOCUMENT_ROUTING 默认关。安全说法：「路由是规则 + 模型在白名单里选，灵活性换可审计。」

### Q3. 为什么坚持「模型只提议、运行时决定」？规划器能看到什么、看不到什么？

*L2 为什么*

- 意图规划器看得到：问题（截到 1000 字符）、文档数量、候选、经验记忆提示、任务记忆提示
- 执行规划器看得到：问题（截到 1000 字符）、文档数量、白名单阶段、已选 Skill 的精简描述、已授权原子 Skill 的数量、任务记忆提示
- 看不到：userId、accessScope、凭据、文档正文
- DAG 规划器看 buildDagPlanningContext：已授权 docIds、Skill 描述、按剩余预算收紧的 limits
- scope、docIds、审批、预算、并发、重试归运行时；节点里出现这些字段就整图拒绝
- 执行时每个读文档的 Skill 都带运行时的 accessScope；授权目录逐个文档用 getDocument 核验

代码：`server/rag/agent-dag-planner-adapter.js buildDagPlanningContext`；`server/rag/agent-execution-graph.js validateExecutionGraph`；`server/rag/skills/authorized-catalog.js listAuthorizedAtomicCustomSkills`；`server/rag/skills/skill-contract.js EXECUTION_REQUEST_FIELD_TYPES`

> ⚠ replanner 看得到原问题（buildReplanContext 的 goal），只是看不到检索内容。「整图拒绝伪造字段」只针对 DAG；执行规划器对未选中的阶段是静默丢弃（normalizePlannerPayload）。

### Q4. 结构化输出怎么做的？已经有 strict schema 了，为什么还要校验器？

*L2 为什么*

- schema 每个请求按白名单现生成：意图做成 enum；执行计划每个可用阶段一个变体（anyOf），id、skillId、condition 都是单值 enum；DAG 的绑定按上游输出类型生成
- 自由文本用 pattern 限长，数组用 maxItems
- 解析取第一个括号平衡的 JSON 值：Ollama 在 JSON 闭合后还会接着写
- 校验器是最终裁决：不是每个 OpenAI 兼容端点都硬执行 schema；端点不支持时可以关 schema，只剩 prompt + 校验器
- 结果：降级 56% → 8%，用例 47% → 80%；只改 prompt 的对照组没提升

代码：`server/rag/structured-output.js boundedString, extractFirstJsonValue, buildJsonSchemaResponseFormat`；`server/rag/agent-llm-planner-adapter.js buildPlannerResponseFormat`；`server/rag/config.js isStructuredOutputEnabled`

> ⚠ 别说「schema 解决了规划质量」：剩下的失败是规划选择问题（动态组合 2/5），约束解码只管形状。也别说用了 maxLength，代码里用的是 pattern。

### Q5. 你说校验器「整图拒绝」，那 7B 下拒绝率多少？被拒后用户体验怎样？

*L2 为什么*

- 执行规划：最终版降级 2/25（8%），执行器 guarded 下 0/25
- DAG 动态组合用例 2/5 通过；已删除的 v3 统一图当时的规划只被采纳 3/15，12 次回落确定性图，0 次回 V1（历史测量，§3.17、§3.51）
- 拒绝不报错：先换确定性规划（按意图选中的 Skill 串成链）
- 确定性图也被拒（选中的 Skill 不在本次请求的授权目录里、超过图的规模上限）：不执行任何 Skill，每个选中的 Skill 记一条失败结果（AGENT_SKILL_GRAPH_REJECTED），trace 里一条 skill_graph_rejected 说明原因，请求继续往下走。2026-11-13 之前这里回 V1 顺序链，阶段 8 删除（§3.49）
- 预算不算在「被拒」里：确定性图在规划时不按调用预算拒绝，执行器在节点启动时预留预算，付不起的节点跳过；模型的图仍按预算整张校验
- 这些都发生在任何节点执行之前，零计费、零副作用
- 原因码写进 skill_graph_planned 事件，可以统计（unified_graph_planned 事件随 v3 统一图一起没有了）
- 代价：用户拿到的是「规则版」回答，失去「对比后自动接风险审查」这类动态组合

代码：`server/rag/agent-dag-planner-adapter.js createAgentExecutionGraphResult, createDeterministicExecutionGraph`；`server/rag/agent-custom-skill-stage.js runCustomSkillStage`；`server/rag/agent-execution-graph.js EXECUTION_GRAPH_REASON_CODES`

> ⚠ 3/15 和 2/5 都是本地 7B、样本很小，不能外推到 GPT 级模型；3/15 是已删除的 v3 统一图留下的测量，现在跑不出来。别说「回落对用户无感」，回落就是失去动态编排。也别说「被拒后还有 V1 顺序链兜底」：2026-11-13 起没有了。「默认配置下 /chat 上不会出现选中的 Skill 因整图被拒而一个都不跑」是从代码和默认配置推出来的（每个意图最多选 2 个 custom Skill、预算 2 次、/chat 先核实文档、四个 Skill 都有类型契约），没有生产流量数据。

### Q6. 为什么不用 ReAct、LangChain createAgent 或者让模型自由调用工具？

*L3 为什么不用 X / 怎么证明*

- 文档场景要可审计、可复现：执行前就知道要跑哪些阶段或哪张已校验的图
- 成本要有界：次数预算 + token/成本/时长上限；replan 最多 1 次，补检索最多 1 次
- 有副作用的动作要在执行前审批，并过重放安全矩阵；开放循环做不到事前知道
- ADR 约束 1 明确不用 createAgent 的自由 ReAct；langgraph/tools.js 适配器存在但不进生产（没有预算、lifecycle 和观测）
- 代价：灵活性差，7B 动态组合弱

代码：`server/rag/agent-execution-plan.js AGENT_EXECUTION_STEP_SCHEMA`；`server/rag/agent-replanner.js DEFAULT_MAX_REPLANS`；`server/rag/agent-bootstrap.js DEFAULT_AGENT_MAX_FOLLOW_UPS`；`server/rag/langgraph/tools.js`

> ⚠ 没做过 ReAct 对照实验（无实测），不能说「比 ReAct 准」或「ReAct 不行」。只讲这个场景下的取舍。

### Q7. 外层计划压测没过 10% 的门、一度留在原生循环，为什么最后还是全换成了 LangGraph？

*L3 为什么不用 X / 怎么证明*

- LangGraph 给的是 checkpoint、interrupt()/Command({resume}) 和 stream，迁移时需要它们的是 custom-Skill DAG 和 v3 统一图（v3 2026-11-14 已删除，见 D13）
- 外层计划不需要中断，持久化靠 run 的 step，交给 LangGraph 在性能上只多开销
- 硬门：CPU/请求和 p95 退化不超过 10%
- 编成 StateGraph 时，并发 32 每请求 CPU +29–35%
- 改底层 Pregel + 编译缓存 + 剪枝后，RunTree 每次调用 54 → 2，进程内只多 0.28 ms，但并发 1 仍 +17.6% CPU、p95 +13%
- 剩下的是 Pregel 每次调用的固定开销，在库内部；2026-10-16 的决定是不放宽门，外层留在原生循环，LangGraph 实现只作实验开关
- 2026-11-13 用户改了决定（阶段 7）：不要两种运作模式，只用已经迁好的 LangGraph。原生循环和开关一起删除；门没有重测，也没有通过，是明知不达标、接受代价
- 接受的代价：进程内每次运行 0.605 → 0.894 ms CPU（多 0.29 ms），相对真实模型约 2.4 s 的一次回答看不出来；阶段 7 没有跑新的压测
- 等价靠 golden：删除前把原生循环的结果冻结成 32 个文件，删除后只在 LangGraph 上跑、对照 golden；回退只能 git revert

代码：`server/rag/agent-execution-plan-runner.js runAgentExecutionPlan, isAgentExecutionPlanStageStaticallyInert`；`server/rag/langgraph/execution-plan-graph.js runAgentExecutionPlanOnLangGraph, EXECUTION_PLAN_GRAPH_CACHE_LIMIT`；`server/rag/config.js assertAgentRuntimeSupported`

> ⚠ 别说「为了性能迁 LangGraph」，它更慢。别说「门后来过了」：阶段 7 没有重测，是用户明说宁可多花约 0.3 ms 也只要一种运行时。别说「代码大幅变少」：阶段 6 生产代码只净减 136 行，阶段 7 的代码量见 ADR 0001 阶段 7 的证据小节。进程内 0.28 ms 和压测里约 1 ms 的差距，归因于降频、冷缓存是推断，没单独测过。

### Q8. checkpointer 为什么不用官方 PostgresSaver？取消为什么不直接把 AbortSignal 传给 LangGraph？并发为什么不用 LangGraph 自带的 maxConcurrency？

*L3 为什么不用 X / 怎么证明*

- 自定义 RunStoreCheckpointSaver 写现有 run 行（run.result.__langGraphCheckpoint），同一个 run store、revision CAS、RLS 和事件契约
- 权威仍是 agent run 的图 checkpoint；LangGraph 线程只存回执，保留 2 个 checkpoint，图结算时丢弃
- AbortSignal：spike 证明是「至少一次」，在途节点被放弃、续跑时重跑；改成 RunControl.requestDrain，在 superstep 边界停、在途节点先结算
- LangGraph 1.5.0 的 maxConcurrency 小于 superstep 宽度会丢任务，所以 invoke 传节点数，上限、独占和队列顺序放在进程内闸门
- LangSmith 任何追踪变量为 true 就拒绝启动，追踪只走 OTel

代码：`server/rag/langgraph/checkpointer.js RunStoreCheckpointSaver, LANGGRAPH_CHECKPOINT_RETENTION, deriveLangGraphThreadId`；`server/rag/langgraph/drain-bridge.js bridgeRequestSignalToDrain`；`server/rag/langgraph/concurrency-gate.js createExecutionGraphConcurrencyGate`；`server/rag/langgraph/langsmith-guard.js assertLangSmithTracingDisabled`

> ⚠ 要主动说代价：写放大（2 节点 /chat 多 7 次无事件 CAS、1 次 run 读、1 次事件读）；drain 意味着取消在节点边界才生效，在途节点要先结算（真实模型调用仍会被 signal 中止，这一点 mock 下没测到）。

### Q9. 做持久化执行，为什么不用 Temporal？

*L3 为什么不用 X / 怎么证明*

- 需要的粒度是「节点边界 + 审批暂停」，不是任意代码行的重放
- 已有 PostgreSQL run store，带 revision CAS 和 RLS 租户；Temporal 要另起集群和 worker，workflow 代码还有确定性约束
- 租户上下文、用量计量都靠 AsyncLocalStorage，要穿过 Temporal 的 activity 边界
- LangGraph 跑在进程内，checkpointer 写现有表
- 什么时候会考虑：长时间的多步任务、跨服务补偿事务、需要平台化的定时器和重试

代码：`server/rag/agent-execution-graph-checkpoint.js verifyExecutionGraphCheckpoint`；`server/rag/agent-runs.js createAgentRunCursor`；`docs/adr/0001-langgraph-runtime.md 备选方案`

> ⚠ ADR 的备选只比较了「保持自研 / 只换 checkpointer / 全量 strangler」，没有正式评估 Temporal。不要说「评估过 Temporal 不合适」，要说「没正式评估，我的理由是……」。

### Q10. 你删掉了原生调度器，怎么证明行为没变？

*L3 为什么不用 X / 怎么证明*

- 删之前把 native 一侧的输出冻结成 golden：8 个套件、102 个文件，扫描太大的只存 sha256
- 删除后同一批场景只在 LangGraph 上跑一次，屏蔽 id 和时间后对照 golden
- 只有 UPDATE_GRAPH_GOLDENS=1 能改写，改写也让本次测试失败，必须看 diff 并写明行为变化
- 原生 runner 的 52 个调度契约测试直接跑在 LangGraph 执行器上，断言一条没改
- 两种调度器都按校验器的拓扑层序排队，720 种声明顺序 × 压力组合精确一致
- 删除前后 trajectory 19/19、planner 7/7、recovery 8/8 屏蔽后逐字节一致
- 阶段 7 删外层计划的原生循环用的是同一个办法：先在一个提交里把原生一侧冻结成 32 个 golden 文件，再删；删除后各套件只在 LangGraph 上跑、对照 golden（§3.48）
- 阶段 8 删 custom Skill 阶段的 V1 顺序链也是先冻结再删除，但冻结的不是 golden 文件：冻结提交把顺序链在四种情形（默认预算、预算 1 次、预算 0 次、阶段核实不了文档）下的回答逐字写进 test/agent-custom-skill-budget.test.mjs，删除提交改掉其中变了的期望，哪里变了在 diff 里看得见。结论不是「完全等价」：前三种答案不变，其中预算 1 次和 0 次的记录有差别；第四种答案从两段结论变成弃答，只是 /chat 走不到（§3.49）。上面的 trajectory 19/19 是阶段 6、7 当时的数；阶段 8 删掉 custom_skill_retry 和 skill_graph_shadow_comparison 之后是 17/17，共有的 17 个用例里 16 个与删除前逐字节一致，另一个只差 V1 对照
- 阶段 9 删 custom_skill 步骤的单独重放同样先冻结再删除：冻结提交把这种步骤被单独重放时的行为写成 10 个测试的字面期望（test/agent-skill-step-replay.test.mjs，用真实的 run store、step executor、启动恢复和恢复动作服务），删除提交的 diff 就是变了的地方。结论同样不是「完全等价」：顺序链留下的旧 run 从「单独重跑这个 Skill」变成「转人工、只能取消」，另有两处是顺带修掉的（启动时的死循环、点了必 409 的按钮）。planner 7/7、trajectory 17/17 改动前后屏蔽后逐字节一致，recovery 8/8 有 51 处差异，都在随功能删掉的范围内（§3.50）
- 阶段 10 删 v3 统一图同样先冻结再删除，冻结的是两个字面期望的测试文件（13 个测试，调用的是真实的服务代码，手工接线、内存 run store）：test/agent-unified-graph-dial.test.mjs 钉新请求在开关每种取值下由谁回答，test/agent-stored-unified-graph-runs.test.mjs 钉已存的 v3 run 在启动恢复、审批端点、重入和恢复面板上怎么处理；删除提交对这两个文件的 diff 就是变了的地方。已存 run 的夹具是 21eae0c6 的 v3 代码在内存 run store 里写下的记录（8 种状态加一个停在门上的后台任务），所以 v3 的代码删了，测试照样能跑。结论同样不是「完全等价」：guarded、shadow 和拼错的取值从能启动变成拒绝启动；已存的 v3 run 没结束的不能再续跑，转人工的原因从好几个变成 unified_graph_removed 一个（节点步骤还在执行中的仍是 unknown_in_flight_node）。trajectory 共有的 15 个用例、planner 共有的 6 个用例删除前后屏蔽后逐字节一致，recovery 的用例和指标逐字节一致；上面各条里的 trajectory 17/17、planner 7/7 是当时的数，现在是 15/15、6/6（§3.51）

代码：`server/rag/agent-execution-graph-node.js orderExecutionGraphNodeStatesByLayer`；`server/rag/langgraph/run-execution-graph.js runExecutionGraphOnLangGraph`；`server/rag/agent-execution-graph-runner.js replayExecutionGraphRun`；`server/rag/config.js assertAgentRuntimeSupported`

> ⚠ golden 只证明固定场景，不能证明任意图形状；两个 PostgreSQL 集成套件的 native 一侧没冻结；golden 在 Node 24 上生成（CI 的 Node 22 上通过）；没有运行时回退，只能 git revert；superstep 屏障让事件顺序和延迟与原生不同（已钉住）。阶段 8 之后 102 + 32 个 golden 文件里删了 2 个（custom_skill_retry、skill_graph_shadow_comparison，随用例一起删）、改写了 1 个（统一图用例的 V1 对照从 4 次变 2 次），阶段 9 又改写了 1 个（恢复评测的 recovery_observability_skill_graph_signal.json，事件从 37 条变成 33 条，17 条图事件逐字节未变），阶段 10 又随 v3 统一图删了 44 份 golden，规划器 golden 摘要里去掉了统一图规划器的 21 条（§3.51），不要再说「冻结之后一个字节没动过」；阶段 8 的结果本机 Node 24 上测，合并进 main 之后 CI 的 Node 22 上也通过（合并提交 7fbf8974）。

### Q11. DAG 执行器的灰度门禁一直不过，你最后是怎么把它转正的？

*L3 为什么不用 X / 怎么证明*

- rollout:readiness 要求真实 LLM 规划零降级、零 mock/real 分歧，它测的是规划质量
- LLM 规划失败退回的是确定性 DAG，不是 V1，所以执行器安不安全只取决于执行语义
- 拆成两个开关：AGENT_SKILL_GRAPH_ROLLOUT 管执行器，AGENT_EXECUTION_PLANNER 管谁规划
- 转正证据：全量测试、trajectory、recovery、PostgreSQL 跨进程恢复和 CAS 竞争
- 复测 24/30 → 27/30、2/25 → 0/25，在噪声内；专门查了最可能出问题的行为变化：普通问答被多加 custom_skills，5/5 都没加
- 后续：转正七周后（2026-11-13，阶段 8）V1 顺序链整个删除，DAG 从默认执行器变成唯一的执行器；AGENT_SKILL_GRAPH_ROLLOUT 不再选择任何东西，off、shadow 和拼错的值让进程拒绝启动

代码：`server/rag/config.js assertAgentRuntimeSupported, AGENT_SKILL_GRAPH_ROLLOUT_REMOVED_CODE`（getAgentSkillGraphRollout 已在阶段 8 删除）；`server/app-services.js createDagPlannerAdapter, createRolloutPlannerAdapter`；`server/rag/agent-llm-planner-adapter.js buildPlannerResponseFormat`

> ⚠ 不能说「转正后规划变好」。纯 LLM 规划的 readiness 在 7B 上仍不过（动态组合 2/5）。拆门禁本身也有风险，所以要说清楚针对它查了哪些行为变化。转正和删除是两件事、隔了七周：转正的依据是执行语义的证据，删除的依据是用户的决定加上「默认配置下顺序链作为兜底在生产里已经不会真正执行任何 Skill」的调查。

### Q12. 记忆怎么设计的？为什么不用 mem0 或向量记忆？记忆污染怎么防？

*L2 为什么*

- 工作记忆：只在 run 内，做查询去重、claim 支持与否、缺口、循环计数，不写进长期记忆
- 会话记忆：保留最近几轮，判定需要时用一次 LLM 调用改写追问，TTL 6 小时；开鉴权时键为 tenant:sha256(user\0ws\0session)，迁移 031 加了 RLS
- 长期记忆：按查询词打分取偏好和笔记，进改写 prompt 和答案 prompt 的偏好块；LONG_MEMORY_SCOPE=workspace 时按工作区隔离
- 经验记忆：只作规划提示，可以重排或补入白名单意图候选（置信度不低于 0.45）
- 防污染：只记用户自己的话；补检索、子问题、Skill 拼的 prompt、后台任务中间轮都不写（memoryWrites:false、runWithoutConversationMemoryWrites）
- 不上向量记忆：没正式评估过，判断是没证据表明需要，而且记忆永远不能成为证据来源

代码：`server/rag/agent-working-memory.js createAgentWorkingMemory`；`server/rag/memory.js resolveSessionMemoryKey, resolveQueryWithSessionMemory, recordSessionTurn`；`server/rag/long-memory.js getLongMemoryContext, resolveLongMemoryWorkspace`；`server/rag/conversation-memory-writes.js runWithoutConversationMemoryWrites`；`server/rag/index.js recordUserExchange`；`server/rag/agent-intent-memory-hints.js applyExperienceHintsToCandidates`

> ⚠ 别照旧 FAQ 说「长期记忆只作规划提示」：长期偏好会进答案 prompt。经验记忆能改变确定性规划器的选择（它选重排后的第一名）。记忆污染和会话越权是代码审查发现后才修的（§3.23）。没有记忆效果的评测（无实测），也没有和 mem0 做过对比。

### Q13. 进程崩溃，或者两个 worker 同时续跑同一个 run，怎么保证有副作用的节点不重复执行？

*L4 边界 / 规模 / 重做*

- run、step、事件、图 checkpoint 都在 PostgreSQL；每次写都走 revision CAS，run cursor 只是乐观基准
- 续跑前：图 checkpoint 要和已持久化的 step 对账，校验 owner、摘要和 live 契约，重算已花的预算，然后才复用已完成节点
- claim、节点开始、完成和失败都带 claim 做 CAS 围栏，旧 worker 写不进去（AGENT_GRAPH_EXECUTION_FENCED）
- 在途节点（step 为 running）一律转人工，哪怕它声明 readOnly：存储层证明不了旧 worker 已经停了
- 步骤不单独重放（2026-11-13 阶段 9 起）：启动恢复自己只续跑中断的图，没有图可续的 run 交给人。重放矩阵登记的是失败的步骤能不能由人重试（四类可以：document_rag、follow_up_retrieval、research_question、审批绑定的 capability_call；custom_skill 不能，它只作为图节点运行；web_search、arxiv_import 的主步骤也不能，要走审批后的 capability_call）；持久化的声明只往原因码里加原因。live registry 的复核就是上面续跑前的那一次，阶段 9 之前单步重放之前还要再查一次，随单步重放一起删了
- 审批：外层计划的 capability_call 要哈希绑定的已批准门，写入带幂等键。图内审批节点（审批前零写入，批准后以 run+node 幂等键只执行一次，写入后崩溃转人工）是 v3 统一图的路径，2026-11-14 随它删除（§3.51）

代码：`server/rag/agent-execution-graph-checkpoint.js verifyExecutionGraphCheckpoint, reconcileExecutionGraphCheckpoint`；`server/rag/agent-run-step-replay-safety.js isStepRetryAllowed`；`server/rag/agent-run-recovery.js createAgentRunRecoveryService, explainInterruptedRun`；`server/rag/agent-runs.js createAgentRunCursor`（原来这里还列着 capabilities/graph-approval-preflight.js verifyCapabilityGraphApproval：阶段 10 之后它没有生产调用方，下一步删）

> ⚠ 这不是 exactly-once：重试主 document_rag 会再记一次会话；被放弃的 claim 不会自动重放，要运维介入。启动自动续跑只剩一种情况，续跑的是整张图：外层计划恰好只有 custom_skills 一个阶段的 custom-Skill 图（agent-run-recovery.js hasGraphOnlyStoredExecutionPlan；确定性外层计划至少列出其余 7 个阶段，所以永远不满足）。以前还有两种，都删了。一种是 v3 guarded run：2026-11-14 阶段 10 随 v3 统一图删除，已存的 v3 run 没结束的转人工、只能取消（CURRENT-TRUTH §3.51）。另一种是没有图 checkpoint 的 V1 custom_skill 步骤整步重放（当时矩阵里唯一 autoReplaySafe 的步骤类型）；这种步骤只有 V1 顺序链存下的旧 run 里有，2026-11-13 阶段 9 把处理器和这条路一起删了，这种旧 run 现在转人工、只能取消（CURRENT-TRUTH §3.50）。普通文档问答的 run 不会自动续跑，其余中断的 run 一律交给人，人只能重试失败步骤或取消。失败的 custom Skill 节点也不能单独手动重试：恢复面板不给它重试按钮，直接调重试接口是 409 AGENT_GRAPH_STEP_REQUIRES_GRAPH_RECOVERY，以前只有顺序链的步骤支持。外层计划 2026-11-13 起由 LangGraph 调度也没有改变这一点：外层图不带 checkpointer，不从它续跑。

### Q14. 预算用完会怎样？为什么做成软截止？成本放大 100 倍怎么控？

*L4 边界 / 规模 / 重做*

- 两层预算：次数（文档 RAG 2 次、custom Skill 2 次、Web 1 次、研究子问题 3 个、trace 16 步）+ 用量（10 万 token、0.5 美元、5 分钟）
- 用量按每次成功的模型调用计费，经 AsyncLocalStorage 找到所属 run，检索服务深处的调用也算进去
- 检查放在 consumeBudget / reserveBudget：下一个工具被跳过并记 budget_limit，走澄清或证据受限回答，不报错
- 软截止：已开始的步骤跑完；DAG 并发时同时在途的节点都会跑完
- DAG 规划时把剩余预算换算成节点上限告诉规划器；节点启动前原子预留预算，审批中断会退回
- 预算不够付全部选中的 Skill 时（阶段 8 起）：模型的图超出预算仍整图拒绝、换成确定性图；确定性图不在规划时按调用预算拒绝，付不起的节点在启动时跳过。预算 1 次、选中两个 Skill 时，回答是第一个 Skill 的答案，和删除前 V1 顺序链兜底时相同（test/agent-custom-skill-budget.test.mjs 钉住）
- 放大 100 倍：靠模型网关的租户配额、模型并发上限、租户限流，并且要用真实流量重新校准默认值

代码：`server/rag/agent-budget.js DEFAULT_AGENT_BUDGET, consumeBudget, reserveBudget`；`server/rag/run-usage.js runWithRunUsage, checkRunUsage, chargeRunUsage`；`server/rag/agent-dag-planner-adapter.js capNodesToBudget`

> ⚠ 默认值是推算出来的防失控上限，没用真实流量校准，也没有真实的单次成本分布。custom 预算为 2，意味着默认 DAG 最多 2 个 custom 节点，12 节点上限是理论值。规划器调用在第一个工具之前，不受上限阻止；计量器按每次调用新建，审批续跑后 token 和成本不累加。

### Q15. 规模放大 100 倍（QPS、Skill 数、图节点数），这套编排会先坏在哪？

*L4 边界 / 规模 / 重做*

- QPS：单 Node 进程用假模型时瓶颈是 CPU。§3.15（2026-09-26）约 90 req/s；§3.24 claim 校验 memo 之后，单体 pgvector + RLS、并发 32 约 239–258 req/s，每请求 CPU 4.6–4.9 ms（测于外层计划迁 LangGraph 之前，之后每请求 CPU 约多 1 ms，没有重测，§3.48）。接真实模型后容量由模型并发上限决定
- 默认 LLM 规划每个请求多 2 次模型调用，容量约为三分之一（按调用次数推算，没实测）。改法：单候选跳过模型、缓存规划、规划器换小模型、agent 层单独扩
- Skill 数：正则意图规则会互相冲突；schema 变体随目录膨胀。要换成检索式工具选择，再交给 LLM
- 节点数：superstep 屏障让延迟取决于最慢的兄弟节点；写放大随 superstep 增长；默认预算本来就只允许 2 个 custom 节点
- （v3 统一图 2026-11-14 已删除，下面这条不再适用：当时量到它每请求 CPU 是外层计划的数倍到十几倍，不适合在大流量下默认打开）
- run store：每个 /chat 是 1 次 insert、3 次 CAS、2 次事件追加、0 次回读；热点在 run 行，LangGraph 线程记录也写在 run 行上

代码：`server/rag/agent-intent-rules.js buildIntentPlanCandidates`；`server/rag/agent-llm-planner-adapter.js buildPlannerResponseFormat`；`server/rag/agent-budget.js DEFAULT_AGENT_BUDGET`；`server/rag/langgraph/run-execution-graph.js runExecutionGraphOnLangGraph`

> ⚠ 这些都没有在 100 倍规模测过。容量约 1/3 是按调用次数推算的。吞吐数字来自假模型、确定性规划器、单机。拆分部署的压测只在单机上做过。

### Q16. 如果重做，你会改什么？

*L4 边界 / 规模 / 重做*

- 更早收敛：V1 链、V2 DAG、v3 统一图三代并存过，再加 LangGraph 迁移，维护面太大。V1 链到 2026-11-13 才删（阶段 8），距离 DAG 成为默认已经七周；v3 统一图到 2026-11-14 才删（阶段 10），它从来没成为过默认，清点时只有它走得到的代码是 22 个文件、8,108 行，共用模块的每次改动都要让它的 golden 继续通过
- 意图层：正则候选换成有标注集校准的分类或 embedding 路由；只有一个候选时不调 LLM
- Skill 输出做成真正的类型化语义对象（差异条目、风险条目），不再是 text/citations/abstained 封套
- 更早用更强的模型做规划评测：7B 上 2/5、3/15 这些结论被模型能力卡住了；v3 统一图直到删除，真实模型的规划证据也只有 7B 这一组
- 框架选型前先做框架开销的微基准：这次是阶段 3 的压测门才发现外层计划的结构性开销

代码：`server/rag/skills/custom/custom-skill-contract.js CUSTOM_RAG_SKILL_OUTPUT_SCHEMA`；`server/rag/agent-intent-rules.js buildIntentPlanCandidates`；`server/rag/agent-custom-skill-stage.js runCustomSkillStage`（原来这里引用的 agent-planner.js buildChainedSkillQuestion 已随 V1 顺序链删除）（原来这里还引用 agent-unified-graph-run.js runGuardedUnifiedAgentGraph，已随 v3 统一图删除）

> ⚠ 别把「重做」讲成否定现有决策。删 v3 统一图也一样：讲成「做出来、量过、数字不支持它当唯一的方式」，不讲成失败，也不讲成优化。分清哪些是数据驱动的（压测门、事先定的评测规则），哪些是事后看出来的。

## 可以引用的数字

| 说什么 | 数字 | 出处 | 前提 / 注意 |
| --- | --- | --- | --- |
| 结构化输出前后的规划器真实模型评测 | 用例 14/30 → 24/30；LLM 规划降级 14/25 → 2/25；每轮 14.1s → 14.2s | server/docs/interview/CURRENT-TRUTH.md §3.3 规划器：结构化输出 | 本地 qwen2.5:7b，每组 5 轮（每轮 6 个用例），执行器 off（当时的档位，2026-11-13 随 V1 顺序链删除，这组条件现在跑不出来）；planner eval 主要衡量执行规划器；只修 prompt 的对照组 14/30、15/25 |
| 不限长度的 schema 导致约束解码停不下来 | 一次生成到 3810 token 还没停；加 pattern 限长后单次调用 754 token/15s → 374 token/7s；不限长那组每轮 16.4s | NARRATIVE-CASES.md 故事 2；CURRENT-TRUTH §3.3 | Ollama + qwen2.5:7b，个别调用的观测 |
| 执行器默认改为 guarded 后的规划器复测 | 27/30 用例，LLM 规划降级 0/25（off 时 24/30、2/25） | CURRENT-TRUTH §3.5 执行器转正 | 差异在抽样噪声内，不能说变好；off 档 2026-11-13 已删除，这组对照现在跑不出来 |
| 7B 的动态组合 Skill 能力 | 只选了对比的用例，要求规划出对比 → 风险审查：2/5 | CURRENT-TRUTH §3.5 | qwen2.5:7b，5 轮；纯 LLM 规划的 rollout:readiness 仍不过 |
| v3 统一图的真实模型规划 | 15 次规划采纳 3 次，12 次回落确定性图，0 次回 V1；每次约 8 秒、约 2,000 token | CURRENT-TRUTH §3.17；docs/evaluation.md「统一图的真实模型规划」 | 本地 qwen2.5:7b，只有规划器调模型，其余是 mock；历史测量：v3 统一图和这个评测脚本 2026-11-14 已删除（§3.51），现在跑不出来 |
| DAG 校验器上限 | maxNodes 12、maxDepth 5、maxConcurrency 3 | server/rag/agent-execution-graph.js EXECUTION_GRAPH_LIMITS | 默认 custom 预算为 2，capNodesToBudget 会把节点上限压到 2 |
| 次数预算默认值 | trace 16 步、文档 RAG 2 次、custom Skill 2 次、Web 1 次、研究子问题 3 个、arXiv 1 次 | server/rag/agent-budget.js DEFAULT_AGENT_BUDGET | 不是按真实流量校准的 |
| run 用量上限默认值 | 10 万 token、0.5 美元、300000 ms（5 分钟）；0 表示关闭 | server/rag/config.js getAgentRunMaxTokens / getAgentRunMaxCostUsd / getAgentRunMaxDurationMs（环境变量 AGENT_RUN_MAX_TOKENS / AGENT_RUN_MAX_COST_USD / AGENT_RUN_MAX_DURATION_MS） | 软截止，已开始的步骤会跑完（DAG 并发时可能是多个在途节点）；防失控用的推算上限 |
| 重规划与补检索上限 | DEFAULT_MAX_REPLANS = 1；DEFAULT_AGENT_MAX_FOLLOW_UPS = 1 | server/rag/agent-replanner.js；server/rag/agent-bootstrap.js | 更高的上限没做过灰度 |
| 外层计划编成 StateGraph 时的压测 | 并发 32 时每请求 CPU 3.93–4.26 → 5.27–5.47 ms（+29–35%）；一张空的 3–5 节点图底价 0.38–0.59 ms，而 10% 的预算只有 0.4 ms | CURRENT-TRUTH §3.28 | pgvector、模型 0 ms、每档 3 次，单机 |
| 外层计划改底层 Pregel 后的开销 | 微基准：7 阶段 1,086 → 347 µs，文档问答 416 → 143 µs；RunTree 每次调用 54 → 2；进程内同一个 runAgentRag 多 0.28 ms（原来多 1.23 ms） | CURRENT-TRUTH §3.29；ADR 阶段 5 | 桩阶段的微基准 |
| Pregel 版外层计划的压测硬门 | 并发 1 时每请求 CPU 中位数 5.68 → 6.68 ms（+17.6%），p95 9.3 → 10.5 ms（+13%），超过 10%，不通过 | CURRENT-TRUTH §3.29；ADR 阶段 5 | pgvector、owner 路径、模型 0 ms、确定性规划器；交替跑四轮、每轮 5 次；并发 32 同一配置轮次之间漂移约 15–20%，不下结论。2026-11-13 外层计划仍按用户决定迁到 LangGraph，门没有重测（§3.48） |
| 外层计划迁到 LangGraph 时接受的开销（阶段 7） | 进程内一次文档问答的 runAgentRag：原生循环 0.605 ms CPU，LangGraph 0.894 ms，多 0.29 ms | CURRENT-TRUTH §3.48；ADR 阶段 7 | 2026-11-13 删除原生循环之前测，同一进程，交替 7 轮、每轮 400 次，Node 24.21；阶段 7 没有跑新的压测；相对真实模型约 2.4 s 的一次回答看不出来 |
| 阶段 3 当时的默认配置（外层原生）通过压测门 | 并发 32 每请求 CPU 3.78–4.20 → 3.82–4.34 ms，p95 区间重叠 | CURRENT-TRUTH §3.28 | 同一 harness，各 3 次；2026-11-13 起外层也在 LangGraph 上，这个结果不再描述现在的默认配置 |
| LangGraph checkpointer 的写放大 | 2 节点 custom-Skill /chat 多 7 次无事件 CAS、1 次 run 读、1 次事件表读；完成后 run result 11,894 B（原生 11,860 B） | CURRENT-TRUTH §3.28；AGENTS.md | PostgreSQL 18 pg_stat_statements 实测，owner 路径 |
| 删除原生调度器（阶段 6）的证据 | 3,250 个测试（通过 3,235、跳过 15、失败 0），行覆盖 90.46%；golden 8 个套件 102 个文件；trajectory 19/19、planner 7/7、recovery 8/8 屏蔽后逐字节一致；runner 文件 478 → 295 行 | CURRENT-TRUTH §3.30 | golden 只覆盖固定场景；在 Node 24 上生成，CI 的 Node 22 上通过 |
| 删除外层原生循环（阶段 7）的证据 | 删除前冻结 32 个 golden 文件（外层计划套件 24、流式套件 5、路由套件 3）；删除后 langgraph-execution-plan-graph 26/26、langgraph-chat-stream 8/8、langgraph-routes 8/8、agent-run-chat-statement-count 10/10、agent-runtime-removed 15/15；trajectory 19/19、planner 7/7、recovery 8/8 删除前后屏蔽后逐字节一致 | CURRENT-TRUTH §3.48 | golden 只覆盖固定场景；全量测试和代码量的数字见 ADR 0001 阶段 7 的证据小节。这是阶段 7 当时的数字，阶段 8 之后 agent-runtime-removed 是 19 个测试、trajectory 是 17 个用例 |
| 删除 V1 顺序链之前的调查（阶段 8） | 给 custom Skill 阶段加记录点，全量测试和三个确定性 agent 评测进入阶段 188 次：133 次走图，27 次显式 off，12 次 shadow，14 次被拒后回落到顺序链（全在测试里），1 次检查点重放，1 次无 Skill 空跑；三个评测里回落 0 次 | CURRENT-TRUTH §3.49；ADR 阶段 8 | main 的 e11ced91，临时 worktree。「默认配置下回落在生产里不会执行任何 Skill」是从代码、默认配置和这组计数推出来的，没有生产流量数据 |
| 删除 V1 顺序链（阶段 8）的证据 | 覆盖率闸门 4,595 个测试（通过 4,588、跳过 7、失败 0），全局行覆盖 92.54%；复核修正之后 4,598 个（通过 4,591、跳过 7、失败 0），92.55%；planner 7/7、recovery 8/8 删除前后屏蔽后逐字节一致；trajectory 19/19（84 项检查）→ 17/17（76 项），共有的 17 个用例里 16 个逐字节一致，另一个只差 V1 对照；agent-runtime-removed 19 个测试（原 15 个），agent-custom-skill-stage 24 个 | CURRENT-TRUTH §3.49；ADR 阶段 8 | 删除之后、本机 Node 24、一次性 PostgreSQL + pgvector；合并进 main 之后 CI 的 Node 22 上通过（合并提交 7fbf8974：4,598 个测试、4,590 通过、8 跳过、0 失败，92.53%）；删掉的两个 trajectory 用例没有替代，阈值没改；没有量性能，真实模型下的答案质量没有重测 |
| custom Skill 步骤不再单独重放（阶段 9）的证据 | 覆盖率闸门 4,607 个测试（通过 4,600、跳过 7、失败 0），全局行覆盖 92.53%；planner 7/7、trajectory 17/17（76 项检查）改动前后屏蔽后逐字节一致；recovery 8/8，检查项 29 → 27，报告有 51 处差异，都在随功能删掉的范围内；agent-skill-step-replay 12/12（冻结时 10 个），agent-run-step-executor 22/22（原 26 个） | CURRENT-TRUTH §3.50；ADR 阶段 9 | 独立复核修正之后、在 015f06a1 上，本机 Node 24.21.0、一次性 PostgreSQL 18 + pgvector；独立复核没有高级缺陷；合并进 main 之后 CI 的 Node 22.23.4 上也通过（合并提交 db3ed97b，运行 43529876304：4,607 个测试，4,599 通过、8 跳过、0 失败，行覆盖 92.52%）；恢复评测去掉的两项检查随功能一起消失，阈值没改；真实浏览器里的恢复面板、真实 PostgreSQL 上的旧链 run 没有验证 |
| 删除 v3 统一图之前的清点（阶段 10） | 只有 v3 走得到的代码 22 个文件、8,108 行（server/rag 17 个文件 6,599 行，评测 5 个文件 1,509 行），另有 9 个共用文件 import 它们；17 个测试文件、138 个测试，44 份 golden（约 10.5 万行）；评测门里 trajectory 17 个用例占 2 个（76 项检查占 13 项），planner 7 个占 1 个（27 项占 5 项），recovery 没有；只有外层计划走得到的代码上限 13 个文件、4,559 行 | CURRENT-TRUTH §3.51；ADR 阶段 10 | main 的 21eae0c6，脚本按静态 import 图计算；开关是默认的 off 时，v3 的代码只在遇到已存的 v3 run 时运行，做的事是把它交给人 |
| 删除 v3 统一图（阶段 10）的证据 | 覆盖率闸门 4,469 个测试（通过 4,462、跳过 7、失败 0），全局行覆盖 91.90%；「RAG / AgentRAG core」一组 94.26%（门 90%、目标 95%）；trajectory 17 → 15 个用例（76 → 63 项检查），planner 7 → 6 个（27 → 22 项），共有的用例删除前后屏蔽后逐字节一致，recovery 不变（8 个、27 项）；agent-stored-unified-graph-runs 9/9、agent-unified-graph-dial 3/3、agent-runtime-removed 23/23；生产代码 +225 −6,717 行，测试（不含 golden）+234 −12,069 行，golden −104,803 行 | CURRENT-TRUTH §3.51；ADR 阶段 10 | 删除提交 9653dd60 的干净 worktree，本机 Node 24.21.0、一次性 PostgreSQL 18 + pgvector；CI 用的是 Node 22，本机没有；那一组覆盖率没到目标，是因为共用模块里只有 v3 用过的代码还在而测试没了，下一步删；真实 PostgreSQL 上的已存 v3 run、真实浏览器没有验证 |
| v3 统一图的 CPU 成本 | 文档问答 V1 约 0.8–1.2 ms CPU，v3 原生约 5.8–7.4 ms，v3 在 LangGraph 上约 11–15 ms | docs/adr/0001-langgraph-runtime.md 阶段 5「没有做的部分与理由」 | 进程内微基准，内存 run store，mock RAG；历史测量，v3 统一图 2026-11-14 已删除（§3.51） |
| 一次 /chat 的 run store 语句数 | 1 次 insert、3 次 CAS、2 次事件追加、0 次 run 或事件回读 | AGENTS.md（test/agent-run-chat-statement-count.test.mjs 钉住） | 不含 custom-Skill DAG 的 LangGraph 额外写入；外层计划迁到 LangGraph 后不变（外层图不带 checkpointer） |
| 一条真实 trace 的耗时分布 | 总 5840 ms、740 token、2 次模型调用；三个规划器各 0–2 ms，两个 Skill 的模型调用 3912 ms 和 1859 ms | CURRENT-TRUTH §3.6 | 单次 trace，确定性规划器，不是性能基准 |
| 默认 LLM 规划器的容量影响 | 每个请求多 2 次模型调用，同样的并发上限下容量约为三分之一 | CURRENT-TRUTH §3.15 | 按调用次数推算，没有实测 |
| Agent 路径的答题率（编排后的瓶颈） | QASPER train 41 道可答题，评审关时 0/41 被回答 | CURRENT-TRUTH §3.21 | qwen2.5:7b、确定性规划器；瓶颈是词法校验器，不是编排 |
| 单进程吞吐（claim 校验 memo 之后） | 并发 32：每请求应用 CPU 11.7–13.5 → 4.6–4.9 ms，吞吐 83–94 → 239–258 req/s | CURRENT-TRUTH §3.24 claim 校验缓存 | 单体、pgvector、行级安全、假模型 0 ms、每档 3 次；假模型回答很短，真实模型下的加速比例没测；测于外层计划迁 LangGraph 之前，之后每请求 CPU 约多 1 ms，没有重测 |

## 要主动说出口的边界

- 只在本地 qwen2.5:7b 上验证过规划。动态组合 2/5；已删除的 v3 统一图当时规划采纳 3/15。没有 GPT 级模型和生产流量的数据
- 意图候选来自正则规则，模型选不了规则没生成的意图；路由会误判，修复开关 AGENT_SINGLE_DOCUMENT_ROUTING 默认关
- 只有一个意图候选时也会调一次 LLM（代码没有短路）；默认 LLM 规划每请求多 2 次模型调用，容量影响是推算的
- typed DAG 只覆盖自定义 Skill 阶段，外层文档、Web、内置阶段仍是固定阶段集合；执行规划器能省略阶段，校验器不要求全选
- 默认 custom 预算为 2，DAG 实际最多 2 个 custom 节点，12 节点、并发 3 在默认配置下用不满
- Skill 的 typed 输出只是答案封套（text/citations/abstained），priorFindings 仍是上游 text，不是语义校验过的结构化对象
- 4 个 custom Skill 全是 readOnly，副作用防护、重放矩阵守的是还没有实例的边界
- 重规划只有 1 次，没有真实模型下的 replan 效果证据
- v3 统一图 2026-11-14 已删除（阶段 10）：回答请求只有外层执行计划一种方式，开关设成 guarded、shadow 或其他任何值进程拒绝启动。随它没有、也没有替代的：Skill 只在文档答案通过证据检查之后运行、审批内容来自已验证的答案这两种编排，图内审批和它的 7 个跨进程 PostgreSQL 用例，v3 的真实模型规划评测，shadow 观测。开过 guarded 的部署里没结束的 v3 run 只能由人取消
- 阶段 10 没做完的：共用图模块里只有 v3 用过的代码（执行器里节点停在审批门和同一线程续跑、v3 图契约和 v2 checkpoint、run store 的图审批门、Capability 的图预检、任务级的 deny 动作）下一步删：除了任务级的 deny（接口还接受它，只是不可能成功），它们已经没有生产调用方；这之前「RAG / AgentRAG core」一组覆盖率 94.46%，没到 95% 的目标，过了 90% 的门。没验证的：真实 PostgreSQL 上的已存 v3 run、真实浏览器。证据是本机 Node 24 上的；CI 用的是 Node 22，本机没有
- 外层计划 2026-11-13 起也由 LangGraph 调度（阶段 7，用户决定只留一种运行时）：10% 的压测门两次没过、这次没有重测，进程内每次运行多 0.29 ms CPU，阶段 7 没有跑新的压测；不能说成性能提升
- superstep 屏障让下游等最慢的兄弟节点，步骤和事件顺序、延迟与删除前的原生调度器不同（已用测试钉住）
- custom Skill 只走图（阶段 8，2026-11-13）：V1 顺序链删除后，整张图因预算以外的原因被拒时选中的 Skill 一个都不跑，各记一条失败结果；没有类型契约的 custom Skill 不再运行；不能再手动重试单个失败的 custom Skill 步骤（默认配置下这项能力从 2026-09-25 起就不可用）；trajectory 少了两个用例，没有替代
- 删顺序链的依据「默认配置下它作为兜底在生产里已经不会真正执行任何 Skill」是从代码、默认配置和测试里的计数推出来的，没有生产流量数据；真实模型下的答案质量没有为这次删除重测（默认路径七周以来一直是图）；没有量性能，不能说成性能改进
- custom Skill 步骤不再单独重放（阶段 9，2026-11-13）：顺序链留下的旧 run 中断了只能取消、失败了不能单步重试；恢复面板只有「重试失败步骤」和「取消」，失败的 custom Skill 节点没有重试按钮。「这些代码只有旧 run 走得到」是从代码的调用关系读出来的，没有线上数据；真实浏览器里的恢复面板和真实 PostgreSQL 上的旧链 run 都没有验证过
- 阶段 6、阶段 7、阶段 8、阶段 9、阶段 10 之后都没有运行时回退开关，只能 git revert；golden 只覆盖固定场景，在 Node 24 上生成、CI 的 Node 22 上通过（阶段 8 合并之后 CI 的 Node 22 上同样通过；阶段 9 的结果本机 Node 24 上测，合并进 main 之后 CI 的 Node 22 上也通过，合并提交 db3ed97b），两个 PostgreSQL 集成套件的 native 一侧没冻结
- LangGraph checkpointer 有写放大（每个 2 节点 custom-Skill /chat 多 7 次无事件 CAS）；取消靠 drain，只在 superstep 边界生效，在途节点要先结算
- 预算是软截止，已开始的步骤（DAG 并发时可能多个）会跑完；规划器调用不受上限阻止；计量按每次调用新建、不跨审批累加；默认值没用真实流量校准，没有真实的单次成本分布
- 不是 exactly-once：重试主 document_rag 会再记一次会话；被放弃的 claim 和在途节点都要人工介入
- 启动自动续跑只剩一种，续跑的是整张图：外层计划恰好只有 custom_skills 的 custom-Skill 图。步骤不单独重放（以前会整步重放的「没有图 checkpoint 的 V1 custom_skill 步骤」2026-11-13 阶段 9 删除；v3 guarded run 的续跑 2026-11-14 阶段 10 随 v3 统一图删除）；普通文档问答 run 不会自动续跑（外层计划迁到 LangGraph 后也一样，外层图不带 checkpointer），其余中断的 run 一律转人工
- 等价证据（trajectory、planner、recovery 逐字节一致）来自 mock 和确定性用例，不是真实模型的规划证据
- 记忆没有效果评测，也没和 mem0 等方案对比过；会话改写多一次 LLM 调用；迁移 031 之前的会话对租户不可见；拆分部署时每层要用相同的 API_AUTH_ENABLED
- Agent 路径答题率很低（QASPER train 评审关时 0/41），瓶颈在词法校验器；verify:quality 18/18 测的是不经过 agent 自检的纯 RAG 路径

## 只能当推理讲的内容

核验代理找不到代码或数据依据的条目。讲的时候用「我的判断是……，没测过」。

- 「mem0 / 向量记忆评测没证明需要」：仓库里没有这类评测或对比，已改成「没正式评估，是作者判断」
- 「规模放大 100 倍」题里的改法（单候选跳过模型、缓存规划、检索式工具选择）是设计设想，代码里没有实现，也没有实测，只能当思路讲
- 「做持久化执行为什么不用 Temporal」的 answerPoints 是作者的推理；ADR 没有评估 Temporal（trap 里已经说明）
- 「重做」题的 answerPoints 是主观反思，没有数据支撑

## 容易记错的地方

第一遍阅读（主要依据 AGENTS.md 和文档）写错、被核验代理对照代码改正的说法。这些正是读文档容易产生的误解。

- **requestFlow 第 4 步**
  - 原以为：createAgentSession（agent-bootstrap.js）：……；listAuthorizedAtomicCustomSkills 用 getDocument(docId, accessScope) 逐个核验文档
  - 实际：listAuthorizedAtomicCustomSkills 不在 createAgentSession 里，而是 runAgentRagInScope 在 createAgentSession 之后、建 run 之前调用，且只在 AGENT_SKILL_GRAPH_ROLLOUT 不是 off 时调用
  - 依据：server/rag/agent-bootstrap.js 中 grep 不到 listAuthorizedAtomicCustomSkills；server/rag/agent.js 第 979 行 `skillGraphMode !== "off" ? listAuthorizedAtomicCustomSkills({...}) : []`
  - 2026-11-13 更新：阶段 8 删掉了 skillGraphMode 和这个条件，现在无条件调用（server/rag/agent.js 里 `const authorizedCustomSkills = listAuthorizedAtomicCustomSkills({...})`）；调用位置没变，仍在 createAgentSession 之后、建 run 之前
- **requestFlow 第 9 步、questionLadder 第 1 题**
  - 原以为：web_search（只在文档弃答或失败时跑）
  - 实际：Web Skill 被选中时直接跑；否则只在文档弃答或失败时兜底
  - 依据：server/rag/agent-execution-plan-runner.js：shouldRunWeb = Boolean(webSearchSkill) && (Boolean(plannedWebSearchSkill) || ragResult 弃答 || ragResult.ok === false)
- **elevatorPitch、外层执行计划 decision、questionLadder 第 2 题**
  - 原以为：执行规划器只能给 8 种固定阶段排序 / LLM 只能排序
  - 实际：LLM 只能在本次可用的阶段里挑选和排序，可以省略阶段；条件由 schema 固定
  - 依据：agent-llm-planner-adapter.js 注释「The model still decides which steps to run and in what order」；validateAgentExecutionPlan 不要求包含全部已选阶段
- **keyFiles agent-llm-planner-adapter.js、questionLadder 结构化输出题**
  - 原以为：buildPlannerResponseFormat 给每个阶段一个 oneOf 变体
  - 实际：每个可用阶段一个变体，经 oneOfSchemas 生成的是 anyOf
  - 依据：server/rag/structured-output.js oneOfSchemas：`schemas.length === 1 ? schemas[0] : { anyOf: schemas }`
- **意图识别 decision 的 evidence**
  - 原以为：CURRENT-TRUTH §3.3：规划降级 14/25 → 2/25
  - 实际：意图选择没有单独实测；§3.3 是 planner eval 整体（主要衡量执行规划器），降级原因是 step 条件、未选中 step、DAG 绑定，不能算作意图识别的证据
  - 依据：docs/evaluation.md「Planner eval」：「固化 LLM execution planner 的灰度检查」；CURRENT-TRUTH §3.3 列出的降级原因
- **elevatorPitch 末句**
  - 原以为：统一图规划只被采纳 3/15，所以 v3 默认关闭
  - 实际：v3 默认关的原因是接管后可见行为会变、CPU 是 V1 的数倍到十几倍、缺真实模型证据；3/15 只是其中一条
  - 依据：docs/adr/0001-langgraph-runtime.md 阶段 5「没有做的部分与理由」；CURRENT-TRUTH §3.29「没做的」
  - 2026-11-14 更新（阶段 10）：v3 统一图已删除，不再是「默认关」。删除的理由也不只是 3/15：用户要只有一种回答请求的方式，而让 v3 成为那一种，数字不支持（3/15、CPU 约 1 ms 对 11–15 ms、六类请求答不了）。30 秒讲法已照此改（CURRENT-TRUTH §3.51）
- **预算 decision tradeoff、numbers run 用量上限 caveat、预算题 answerPoints**
  - 原以为：最多超出一个在途步骤
  - 实际：已开始的步骤会跑完（docs/agent-rag.md 写「最多超出一个步骤」，DAG 并发时同时在途的节点都会跑完）；补上：规划器调用不受上限阻止，计量器按每次调用新建、不跨审批累加
  - 依据：EXECUTION_GRAPH_LIMITS.maxConcurrency 3；docs/agent-rag.md「运行预算」的「边界」小节
- **numbers run 用量上限 source**
  - 原以为：server/rag/config.js AGENT_RUN_MAX_TOKENS / AGENT_RUN_MAX_COST_USD / AGENT_RUN_MAX_DURATION_MS
  - 实际：server/rag/config.js getAgentRunMaxTokens / getAgentRunMaxCostUsd / getAgentRunMaxDurationMs（环境变量名保留在括号里）
  - 依据：config.js 第 359–366 行：readRunLimit("AGENT_RUN_MAX_TOKENS", 100000) 等，导出的是 getter，不是同名常量
- **规模放大 100 倍题 answerPoints**
  - 原以为：单 Node 进程用假模型时 CPU 瓶颈约 90 req/s
  - 实际：§3.15（2026-09-26）约 90 req/s；§3.24 claim 校验 memo 之后并发 32 约 239–258 req/s、每请求 CPU 4.6–4.9 ms；新增对应 numbers 条目
  - 依据：CURRENT-TRUTH §3.24 表格
- **崩溃续跑题 trap、limitations、180 秒稿 stale 条目**
  - 原以为：启动自动续跑只覆盖两种 run……（确定性外层计划总是列出全部阶段）
  - 实际：三种：graph-only 外层计划的 guarded 图、v3 guarded run、没有图 checkpoint 的 V1 custom_skill 步骤；确定性外层计划在没选 custom Skill 时会去掉 custom_skills，但至少列出其余 7 个阶段，所以永远不是 graph-only
  - 依据：agent-run-step-replay-safety.js 中 custom_skill 为 autoReplaySafe: true，agent-run-recovery.js findAutoRecoverableStep 走通用步骤恢复；getAgentRunRecoveryMode 在持久 store 下默认 auto；createDeterministicAgentExecutionPlan 的 filter
  - 2026-11-13 更新：第三种只对阶段 8 之前存下来的 run 成立。V1 顺序链删除后，新的 run 里每个 custom Skill 步骤都是带 nodeId 的图节点，不再产生没有图 checkpoint 的 custom_skill 步骤；矩阵没有改，处理器保留
  - 2026-11-13 更新（阶段 9）：第三种没有了，现在是两种。这和上面「原以为」的数目相同，原因不同：当时是漏看了第三种，现在是它被删了。阶段 9 删除了矩阵的 autoReplaySafe 一列（custom_skill 现在 replayActions 为空、原因码 graph_node_step）、agent-run-recovery.js 的 findAutoRecoverableStep 和 custom_skill 的独立处理器；没有图可续的 run 由 explainInterruptedRun 给出原因后转人工，旧链留下的 run 只能取消（CURRENT-TRUTH §3.50）。上面的依据到阶段 9 之前都成立
  - 2026-11-14 更新（阶段 10）：现在是一种。v3 guarded run 的续跑随 v3 统一图删除，已存的 v3 run 没结束的转人工（原因 unified_graph_removed，节点步骤还在执行中的是 unknown_in_flight_node）、只能取消（CURRENT-TRUTH §3.51）
- **记忆 decision alternativesRejected、记忆题**
  - 原以为：mem0 / 向量记忆 / LangChain ConversationBufferMemory：评测没证明需要
  - 实际：没有正式评估或对比过，这是作者的判断
  - 依据：docs/ 与 server/docs/ 里 grep 不到 mem0、ConversationBufferMemory 或相关评测
- **结构化输出 decision alternativesRejected**
  - 原以为：LangChain withStructuredOutput：……
  - 实际：规划器改用 withStructuredOutput（ArchiveRagChatModel 上的 LangChain 接口）的三条理由，出自 planner-model.js 注释
  - 依据：server/rag/langgraph/planner-model.js 第 9–13 行注释；model.js 第 334 行 withStructuredOutput
- **LangGraph 落地细节 decision tradeoff、checkpointer 题 trap、limitations**
  - 原以为：取消要等在途节点跑完
  - 实际：取消在 superstep 边界生效，在途节点先结算；其中真实模型调用仍会被请求 signal 中止，ADR 写明 mock 下这点没测到
  - 依据：docs/adr/0001-langgraph-runtime.md「四项证明」第 3 条（drain、withRequestSignal 两句）
- **staleInExistingDocs FAQ #14 条目**
  - 原以为：现在 eval:planner 是 7 个用例（新增 planner_dynamic_skill_graph）
  - 实际：新增的第 7 个是 planner_unified_graph（2026-09-27 提交 1cdb6029）；planner_dynamic_skill_graph 在 75628674 的 6 用例集里就有
  - 依据：git show 75628674:server/evaluation/planner/cases/index.js 列出 6 个 planner_ 用例；git log -S planner_unified_graph 指向 1cdb6029
  - 2026-11-14 更新（阶段 10）：planner_unified_graph 随 v3 统一图删除，eval:planner 现在是 6 个用例、22 项检查（CURRENT-TRUTH §3.51）
- **requestFlow 第 1 步**
  - 原以为：routes/chat.js 用 runAgentRequestWithCancellation
  - 实际：标明函数定义在 rag/request-deadline.js，由 routes/chat.js 导入
  - 依据：server/rag/request-deadline.js 第 332 行 export const runAgentRequestWithCancellation；routes/chat.js 第 14 行 import
- **numbers Pregel 压测硬门 caveat**
  - 原以为：交替跑四轮、每轮 5 次……
  - 实际：补上前提：pgvector、owner 路径、模型 0 ms、确定性规划器
  - 依据：ADR 阶段 5「压测」小节
- **记忆 decision tradeoff、记忆题 answerPoints**
  - 原以为：追问改写要多一次 LLM 调用
  - 实际：判定需要改写时（shouldRewriteQuestion）才多一次 LLM 调用
  - 依据：server/rag/memory.js resolveQueryWithSessionMemory 里 `if (!shouldRewriteQuestion(...)) return`
- **v3 decision why**
  - 原以为：外部节点的输出不能交给 Skill
  - 实际：任何节点的输入都不能绑定外部节点的输出
  - 依据：AGENTS.md：no node input binds an external node's output
  - 2026-11-14 更新（阶段 10）：这条准入规则随 v3 统一图一起删除，现在是历史设计，写在 docs/unified-agent-dag-migration.md 的历史记录里（外部节点的输出不进任何其他节点的输入，只进最终答案）；上面的依据到阶段 10 之前成立
- **replan decision evidence**
  - 原以为：recovery-observability 8/8（mock 下产生的 replan 信号）
  - 实际：replan 信号来自注入的确定性 replanner，不是真实模型
  - 依据：docs/evaluation.md「Skill graph rollout 的评测边界」：skill_graph_bounded_replan 用注入的 replanner
- **staleInExistingDocs**
  - 原以为：（无）
  - 实际：新增 3 条：CURRENT-TRUTH §3.15 的 90 req/s 已被 §3.24 取代；FAQ #6「不是 BM25」已过时；CURRENT-TRUTH §4 的 PDF 解析边界并入 180 秒稿那条
  - 依据：CURRENT-TRUTH §3.24；rag/config.js DEFAULT_SPARSE_SCORING = "bm25"；docs/evaluation.md「真实 docling-serve 上的验证」
- **keyFiles**
  - 原以为：（没有恢复相关文件）
  - 实际：新增 agent-run-recovery.js / agent-execution-graph-checkpoint.js / agent-run-step-replay-safety.js 一行，因为问题阶梯里引用了它们
  - 依据：三个文件都在，hasGraphOnlyStoredExecutionPlan、findAutoRecoverableStep、verifyExecutionGraphCheckpoint、isAutoReplaySafeStepType 都 grep 得到
  - 2026-11-13 更新（阶段 9）：这条依据到阶段 9 之前成立。findAutoRecoverableStep 和 isAutoReplaySafeStepType 已删除，grep 不到了；三个文件都还在，hasGraphOnlyStoredExecutionPlan 和 verifyExecutionGraphCheckpoint 没变，现在对应的是 explainInterruptedRun（agent-run-recovery.js）和 isStepRetryAllowed（agent-run-step-replay-safety.js），关键文件表那一行已照此改
