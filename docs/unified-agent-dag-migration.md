# Unified AgentRAG DAG：迁移决策与验收清单

状态：**迁移中：统一图底座和 shadow 观测已部分接线，生产执行路径尚未接线**。用户已确认目标是把文档 RAG、Web、内置 Skill 和带审批的 Capability 与自定义 Skill 放进**同一张执行图**；按当前要求，真实模型调用及其证据暂缓。本文件同时记录已落地的底座与待验收的迁移规格，不能据此宣称全 Agent 动态 DAG 已上线。

## 当前边界与决策

当前 `/chat` 仍由 `agent-execution-plan-runner.js` 依固定外层步骤顺序运行文档、Web、内置 Skill 和 Capability；`agent-custom-skill-stage.js` 的 typed DAG 只替代其中的 `custom_skills` 阶段。生产可达的图 checkpoint/启动恢复仍限于自定义 Skill，旧节点收据使用 `custom_skill:<nodeId>`。现有 `off` / `shadow` / `guarded` 开关默认 `off`，V1 chain 和确定性 planner 仍是兼容路径，不能把当前生产路径称为全 Agent 动态 DAG。

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
