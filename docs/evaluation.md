# Evaluation And Quality Gates

这份文档说明项目的评测和质量门控。README 只保留最常用命令。

## 评测原则

Node 自定义评测是主回归，因为它能覆盖产品行为：

- 是否该拒答
- 页级引用是否命中
- Compare 是否覆盖多文档
- 答案关键片段是否出现
- 上传恢复是否成功
- Agent 是否正确 follow-up、clarify、传递 access scope、遵守 budget

`ragas` 只作为语义相关性和 grounding 的补充观察。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `cd server && npm test` | 运行后端聚合测试。 |
| `cd server && npm run coverage:gate` | 运行后端 coverage minimum gate。 |
| `cd server && npm run test:pgvector` | 真实 pgvector PostgreSQL 集成测试；需要 `PGVECTOR_TEST_DATABASE_URL`，缺失时报告 skipped。 |
| `cd server && npm run coverage:targets` | 把目标覆盖率作为硬门控运行。 |
| `cd server && npm run eval:synthetic` | 运行默认 synthetic RAG eval。 |
| `cd server && npm run eval:trajectory` | 评测 AgentRAG 执行轨迹。 |
| `cd server && npm run eval:planner` | 用 mock LLM provider 评测 execution planner、validator、fallback 和 guarded 原子 Skill DAG 组合；`-- --provider real` 会让 DAG case 调用真实 LLM planner 并生成 real-provider 报告。 |
| `cd server && npm run eval:recovery-observability` | 生成 recovery/replay observability report，覆盖 manual recovery、auto replay、step retry/resume、planner fallback、guarded replan signal，以及 checkpoint + 重建服务实例的 graph-only startup resume；真实 PostgreSQL 跨进程验证另见 `bash scripts/run-pgvector-integration.sh`。 |
| `cd server && npm run planner:gate -- --provider real` | 强制检查 real planner report、unexpected fallback rate 和 mock/real planner 分歧。 |
| `cd server && npm run rollout:readiness` | 汇总 real planner gate、纯 LLM runtime target、`AGENT_SKILL_GRAPH_ROLLOUT=guarded`、real-provider 动态 DAG case、guarded runtime smoke、trajectory/recovery gate、fallback rate 和 mock/real divergence；只报告纯 LLM 规划的 readiness，不改任何开关。 |
| `cd server && npm run runtime:smoke` | 用真实后端 HTTP、真实 LLM planner 和 PostgreSQL smoke `/health` + 两次 `/chat`；同时要求两次都由真实 LLM 规划并执行 guarded custom-Skill DAG、无 fallback，并检查 experience memory 只作为 planning hint。 |
| `cd server && npm run verify:quality` | 用真实 embedding + chat 模型验证零基础设施档案下的检索、页码引文、对比取值归属、弃答和跨进程持久化。见 “DocCompare quality verification”。 |
| `cd server && npm run feedback:corpus` | 从负反馈生成 synthetic 评测语料。 |
| `cd server && npm run eval:feedback` | 用 seed + runtime feedback corpus 运行 deterministic 回归评测。 |
| `cd server && npm run eval:robust-suite` | 手动运行 compare-hard synthetic、hard-CS rerank 和 arXiv real-paper rerank；固定周期由 Release Evidence Gate 调用同一 suite。 |
| `cd server && npm run robust:gate -- --fail-on-warn` | 只校验三份 robust suite 最新报告；不会读取历史 synthetic、feedback、planner、trajectory 或 recovery 状态。 |
| `cd server && npm run quality:gate` | 兼容旧 payload 的历史 metrics gate；PASS 不代表当前 commit 已验证。 |
| `cd server && npm run quality:current` | 校验当前 commit 的轻量报告 lineage、freshness、clean worktree 和 metrics。 |
| `cd server && npm run release:gate` | 严格检查当前 commit 的完整发布证据 lineage 和 freshness。 |
| `cd server && npm run eval:rerank` | 运行离线 rerank ranking eval。 |
| `cd server && npm run eval:rerank:sweep` | 批量对比 rerank 参数。 |
| `cd server && npm run corpus:arxiv` | 生成 arXiv real-paper corpus 草稿。 |
| `cd server && npm run eval:param-sweep` | 测试 topK、chunk overlap、rerank、hybrid 权重。 |
| `cd server && npm run eval:real -- evaluation/real-corpus.json` | 运行真实语料评测。 |
| `cd server && npm run eval:ragas -- --input evaluation/results/latest.json` | 对保存的 Node eval payload 运行 ragas。 |
| `cd server && npm run observability:report` | 汇总 RAG / AgentRAG JSONL trace 为可读报告。 |

## 当前追踪报告

| 报告 | 结果摘要 |
| --- | --- |
| `evaluation/results/latest.*` | 主 synthetic regression 报告。`eval:robust-suite` 会用 compare-hard corpus 刷新它，避免长期只追踪 near-duplicate 满分小语料。 |
| `evaluation/results/latest-quality.*` | PR current gate 专用 deterministic near-duplicate synthetic 报告；不会覆盖 robust/release 使用的 `latest.*`。 |
| `evaluation/results/latest-current-quality-gate.{json,md}` | 当前 commit 的轻量质量证据；逐项记录 SHA、freshness、dirty、corpus/provider/config 和 metrics 检查。 |
| `evaluation/baselines/quality-near-duplicate-deterministic-v1.json` | PR deterministic profile 的固定 100% regression baseline；运行目录中的旧报告不能替换它。 |
| `evaluation/results/latest-trajectory.*` | AgentRAG trajectory eval：当前默认 deterministic suite 为 `17/17` cases passed，`71/71` checks passed，包含 goal lifecycle completion 和四个钉住 `AGENT_SKILL_GRAPH_ROLLOUT` 的 skill graph case。 |
| `evaluation/results/latest-planner*.{json,md}` | AgentRAG planner eval：默认 mock provider，覆盖 LLM plan selection、validator rejection、deterministic fallback、planner observability，以及 compare-only Intent 下由授权原子 catalog 规划 `compare_documents -> risk_review` 的 guarded case；real provider 调用真实 LLM DAG planner，分别写 provider-specific latest report。 |
| `evaluation/results/latest-recovery-observability.{json,md}` | AgentRAG recovery observability eval：既有恢复统计与 guarded replan signal，加上从持久化 checkpoint 经新服务实例启动恢复的 `skill_graph_startup_resume` 生产路径检查；当前 `8/8` cases、`29/29` checks。 |
| `evaluation/results/latest-rollout-readiness.{json,md}` | AgentRAG rollout readiness：只输出是否 ready 的信号，要求纯 LLM planner、guarded Skill graph、real-provider DAG case、guarded runtime smoke、trajectory/recovery gate，以及零 unexpected fallback / mock-real divergence；衡量纯 LLM 规划，不是执行器默认值（`guarded`）的门禁。 |
| `evaluation/results/latest-rerank-hard-cs.*` | Hard-CS rerank eval：baseline 不再满分，heuristic rerank 需要保持 NDCG/Recall 不回退并保留 NDCG lift。 |
| `evaluation/results/latest-arxiv-rerank.*` | arXiv real-paper rerank eval：使用固定 manifest 生成的真实论文 corpus，覆盖更长文档和 hard negative。 |
| `evaluation/results/latest-release-evidence.{json,md}` | 严格发布证据报告：逐项记录 8 份 required reports 的状态、稳定 reason code、期望值、实际值和 lineage 摘要。 |
| `evaluation/results/latest-rerank.*` | Legacy near-duplicate rerank eval：baseline 已接近饱和，仅作历史参考。 |
| `evaluation/results/arxiv-rerank-sweep-latest.*` | arXiv real-paper quick sweep 当前最佳 variant 为 `broad_topk`，NDCG `0.5831`，Recall `0.8177`，MRR `0.5891`。 |
| `evaluation/results/compare-hard-ragas.*` | Ragas supplement：faithfulness `0.8939`，context precision `1.0`，compare rubric `0.9333`。 |

说明：仓库内旧的 `latest.*` snapshot 可能仍来自 near-duplicate，或尚未包含统一 lineage metadata；不要为这些旧报告补写或伪造 metadata。固定周期入口 `eval:robust-suite` 会用真实运行结果刷新 compare-hard、hard-CS 和 arXiv 三份报告。旧报告只可由 `quality:gate` 查看，不能充当 current evidence，也不能参与 `quality:current` 的 baseline 竞争；缺 lineage 的当前报告会得到 `missing_lineage`。

## Evidence metadata

纳入发布判断的 runner 共用 `server/evaluation/eval-evidence.js` 构造 additive `evidence`，不改变原有 metrics、cases、checks 或 status 语义。metadata 包含：

- `schemaVersion`、`reportType`、`reportId`、`runId`、`generatedAt`、`command`、`profile` 和 `generatorVersion`
- `git.commitSha` 与 `git.dirty`
- `corpus.id`、repo-relative `corpus.relativePath`、`corpus.contentHash` 和 corpus version
- 基于公开配置 canonical JSON 计算的 `configHash`
- `provider.id`、`provider.mode` 和公开 `modelRouteId`
- aggregate report 实际消费的 `sourceReports`；每项保留 report type/id、run ID、commit、生成时间、config hash、corpus ID 和 provider mode

路径会正规化为 repo-relative；仓库外路径写为 `unknown`。公开配置会移除 API key、token、secret、authorization、prompt、原始文档内容、完整环境变量和内部 model name。无 Git 环境时 commit/dirty 记为 `unknown`：普通开发流程可以继续读取，严格发布门会失败。`eval:robust-suite` 还会把同一个 target commit、suite run ID 和 suite config hash 传给 compare-hard、Hard-CS 与 arXiv 三个 runner，防止把不同批次结果拼成一次 robust 证据。

CI 可通过 `EVAL_TARGET_COMMIT_SHA` 把报告绑定到指定 SHA；它必须等于 runner 所在 checkout 的 `HEAD`。本地默认直接读取当前 `HEAD`。生成报告时除受控的 `server/evaluation/generated/` 与 `server/evaluation/results/` 输出外，只要 worktree 仍有其他改动，`git.dirty` 就会为 `true`，该报告不能通过 current 或 release evidence gate。Git 状态使用 NUL 分隔的 porcelain 解析，rename/copy 的源和目标都会检查，不能通过把源文件移入受控输出目录来伪装 clean。

## Current quality gate

`quality:current` 是 PR 的 fail-closed 轻量入口。它不调用评测 runner，只读取本次 workflow 已生成的报告，并同时检查：

- gate 执行时 checkout 必须仍是 target SHA 且 clean；
- `latest-quality.json`、feedback、trajectory、planner-mock 和 recovery 五份 required reports 必须存在；synthetic/feedback 报告的 `summary.retrieval` 必须声明 `pgvector` + hybrid + `rrf` 且能从 case 重算（见 “Retrieval 架构证据”）；
- evidence profile 必须是 `quality-current`；trajectory/planner/recovery 必须精确匹配版本化 manifest 中的 case/check IDs，synthetic 与 feedback 必须匹配 corpus case，并保留固定的 8 个 near-duplicate cases 和 2 个 feedback seed cases；固定 case 的问题、答案片段、事实 claim/来源归属、证据页、文档页内容和拒答输出也必须匹配 manifest；
- synthetic/feedback 会交叉校验 document/upload/citation 身份、固定 chunk/byte/path 关系和 evidence schema；每个 citation 必须对应本次 raw `retrievedContexts`，Ragas context identity 由 raw retrieval 重建。门禁再从版本化 corpus page 重建 citation evidence，并复用生产 claim checker 独立重算 answer claims 与 claim support；upload resume 和 summary metrics 也会从 raw payload 重算，summary 或自报 `supported=true` 不能覆盖 raw failure；
- planner/trajectory 的关键模式、技能链、planner、budget、loop、telemetry 与 trace 字段必须匹配版本化 response projection；作用域、approval resume/deny、retry、memory、privacy 与 goal lifecycle 等高风险 case 还必须携带最小化、privacy-safe 的 `case.response.observed` 原始观测。`check.detail` 只用于诊断，不作为 verdict oracle；recovery cases/checks 则由独立共享 builder 从 `report.recovery` 重新计算；
- 每份报告必须包含完整 evidence、来自同一 target SHA、`git.dirty=false`，且默认不超过 24 小时；
- 每份报告必须通过自身的绝对 gate；稳定复现的失败不能靠“与同样失败的 baseline 无回退”获得 PASS；
- synthetic/feedback corpus hash、provider、公开 config hash 和 model route 必须与当前 checkout 相符；
- metrics gate 必须通过；它只有在 worktree、逐报告 lineage/contract 和 baseline 全部验证后才公开 PASS/FAIL，否则公开状态为 `unverified`，原始 metrics 判断只保留为 diagnostics。回归比较只接受版本控制的 deterministic baseline，旧 `latest.json`、timestamped 文件和本地残留不能抢占；
- planner-real 默认可选，但只要文件存在就必须是 fresh、clean、同 SHA；传入 `--require-planner-real` 后缺失也会失败。

```bash
cd server
npm run quality:current
npm run quality:current -- --target-commit <sha> --max-age-hours <hours>
npm run quality:current -- --input-directory evaluation/results --json
npm run quality:current -- --require-planner-real
```

默认每次检查会写入 `evaluation/results/latest-current-quality-gate.json` 和 `.md`。即使 producer 留下 malformed JSON，reader 也会把它记录为 `invalid_report` 后继续写 gate diagnostics。其他稳定失败原因包括 `missing_report`、`missing_lineage`、`report_failed`、`report_integrity_failed`、`suite_contract_mismatch`、`unknown_commit`、`commit_mismatch`、`dirty_worktree`、`stale_report`、`future_report`、`invalid_generated_at`、`config_hash_mismatch`、`wrong_corpus`、`wrong_provider`、`wrong_profile`、`wrong_model_route`、`quality_metrics_unverified` 和 `quality_metrics_failed`。这份报告明确标记 `robustSuiteCurrentEvidence=false`；未要求 robust suite 时的历史 `pass (skipped)` 不能被解释为当前 robust evidence。

证据边界：`quality:current` 是 fail-closed 的 report contract/lineage validator，不是密码学 attestation。单独运行 CLI 不能证明 runner、真实上传或检索一定发生；`evidence.command` 也是声明字段。PR 的实际执行 provenance 来自同一 GitHub Actions job 中先 producer、后 gate 的固定步骤以及上传的原始 artifacts。当前 lightweight report 不包含完整内部事件签名、上传源文件/合并文件 digest 或不可伪造的 chunk transcript；若威胁模型包含恶意 producer，需要另加签名事件链和内容 digest，不能把 current gate 的 PASS 描述成该级别证明。

`/quality/latest`、`/quality/history` 与 `quality:gate` 继续保留历史兼容结构和退出码，但响应会附带 `verification.scope=historical`、`currentCommitVerified=false`，CLI/UI/admin 也会明确显示历史或未验证状态。缺少 verification marker 的旧后端响应按未验证处理。HTTP 刷新统一走受 RBAC 和审计保护的 `POST /admin/actions/quality-refresh`，请求只接受注册的 `corpusId`；自定义文件系统路径仅保留给本地可信 CLI。

## Release evidence gate

`release:gate` 是发布入口；它只验证已生成的报告，不会调用 OpenAI、下载 arXiv 语料或伪造 `latest.*`。默认 target 是当前 `HEAD`，并检查以下 8 份 JSON：

| Required report | 文件 | 发布约束 |
| --- | --- | --- |
| compare-hard synthetic | `evaluation/results/latest.json` | 原报告通过，使用规定 compare-hard corpus，commit/config/corpus lineage 与 robust suite 一致。 |
| Hard-CS rerank | `evaluation/results/latest-rerank-hard-cs.json` | 原报告通过，使用规定 Hard-CS corpus/version，且 robust lineage 未分裂。 |
| arXiv real-paper rerank | `evaluation/results/latest-arxiv-rerank.json` | 原报告通过，使用规定 manifest corpus/version，且 robust lineage 未分裂。 |
| trajectory | `evaluation/results/latest-trajectory.json` | trajectory 原始 cases/checks 通过并属于 target commit。 |
| planner-real | `evaluation/results/latest-planner-real.json` | planner 原始状态通过、provider mode 为 `real`，包含真实 LLM 规划并执行的 `planner_dynamic_skill_graph` compare+risk case。 |
| recovery observability | `evaluation/results/latest-recovery-observability.json` | recovery 原始状态通过并属于 target commit。 |
| runtime smoke | `evaluation/results/latest-runtime-smoke.json` | 两次 HTTP `/chat` 都由真实 LLM 规划并执行 guarded Skill DAG、零 graph fallback，且 provider/config lineage 与发布批次一致。 |
| rollout readiness | `evaluation/results/latest-rollout-readiness.json` | readiness 为 ready，guarded runtime/real DAG planner case 等检查通过，且 `sourceReports` 与实际读取的 planner/trajectory/recovery/runtime 输入一致。 |

`latest-planner-mock.json` 不是第 9 份 required report，但它是 rollout readiness 实际读取的辅助 source；readiness 的 `sourceReports` 必须同时准确引用 mock/real planner、trajectory、recovery observability 和 runtime smoke。

调用 `release:gate` 时，当前 checkout 本身也必须与 target commit 相同且 worktree 干净；Git 状态不可读取同样会失败，不能拿先前 clean 时生成的报告给当前 dirty 工作树背书。所有 required reports 还必须存在、包含完整 `evidence`、使用 `profile=release`、`git.commitSha` 等于 target、`git.dirty=false`，并在默认 `24` 小时 freshness policy 内。未来时间戳同样会失败。三份 robust report 必须满足 `evidence.runId == summary.runId`、`evidence.generatedAt == summary.createdAt`；Runtime smoke 必须满足 `evidence.runId == report.runId`、`evidence.generatedAt == report.completedAt`；rollout readiness 必须满足 `evidence.runId == summary.runId`、`evidence.generatedAt == summary.createdAt`。发布合同还会重算 readiness 的 `guarded` graph 信号，并逐字段验证 runtime smoke 的 Skill graph 检查；不能用一个自报 PASS 的旧报告绕过。任一报告缺失、过期、commit 不匹配、由 dirty worktree 生成、profile、corpus/provider ID 或 mode 错误、public model route 错误、source report lineage 不一致，或 robust 三份报告出现 split lineage，整体状态都是 `fail`。

```bash
cd server
npm run release:gate
npm run release:gate -- --target-commit <sha> --max-age-hours <hours>
npm run release:gate -- --input-directory evaluation/results --json
npm run release:gate -- --no-fail
```

CLI 选项：

| 选项 | 作用 |
| --- | --- |
| `--target-commit <sha>` | 显式声明当前 checkout 的 target；该值必须等于 `HEAD`，随后要求全部报告绑定同一 commit。 |
| `--max-age-hours <hours>` | 覆盖集中定义的默认 `24` 小时 freshness 上限。 |
| `--input-directory <path>` | 从指定目录读取 8 份 required reports 及辅助 source，并把 `latest-release-evidence.*` 写回同一目录。 |
| `--json` | 在 stdout 输出机器可读 JSON。 |
| `--no-fail` | 仅把失败时的进程退出码改为 0；报告内 `status` 和 reason codes 仍保持失败。 |

默认每次检查都会写入 `evaluation/results/latest-release-evidence.json` 和 `.md`。逐项结果包含 `status`、`reasonCode`、`expected`、`actual`、`reportType`、`runId`、`generatedAt`、`commitSha` 以及 corpus/provider 摘要，便于 CI 用稳定 reason code 判断失败原因。当前稳定 reason codes 为：`ok`、`missing_report`、`missing_lineage`、`unknown_commit`、`commit_mismatch`、`dirty_worktree`、`stale_report`、`future_report`、`invalid_generated_at`、`report_failed`、`report_integrity_failed`、`config_hash_mismatch`、`wrong_corpus`、`wrong_provider`、`wrong_profile`、`wrong_model_route`、`source_report_lineage_mismatch` 和 `robust_lineage_split`。

### 与 quality gate 的兼容边界

默认 `quality:gate` 的成本和历史语义不变：它仍兼容旧 synthetic/feedback/trajectory/planner/recovery payload，且未传 `--require-robust-suite` 时 robust gate 继续显示 pass + skipped。`quality:gate -- --require-robust-suite` 仅为旧调用方保留；自动 workflow 使用独立的 `robust:gate`，不会让历史报告状态影响 robust suite。PR workflow 用独立的 `quality:current` 拦截轻量 current evidence；`release:gate` 再验证完整发布批次。因此默认 PR 不需要真实 OpenAI，也不会下载 arXiv corpus。

## Synthetic regression

```bash
cd server
npm run eval:synthetic
npm run eval:synthetic -- evaluation/synthetic-corpus-near-duplicate.json
npm run eval:synthetic -- evaluation/synthetic-corpus-compare-hard.json
```

默认报告写入 `server/evaluation/results/latest.json` 和 `.md`。Synthetic corpus 必须声明稳定的顶层 `id` 和 `version`，且每个 document `key` 唯一；runner 用三者生成确定性 document ID，门禁才能把 raw citation/context 精确绑定回受版本控制的 corpus，而不是信任报告自报的来源标识。

## Robust hard/real suite

`eval:robust-suite` 是固定周期入口，不放进每个 PR 的默认轻量 gate。它集中维护 hard/real 语料集合，避免 npm scripts、CI 和 quality gate 各自硬编码：

```bash
cd server
npm run eval:robust-suite
npm run robust:gate -- --fail-on-warn
```

默认 suite 包含三层：

| Report | 语料 | 输出 | 作用 |
| --- | --- | --- | --- |
| compare-hard synthetic | `evaluation/synthetic-corpus-compare-hard.json` | `evaluation/results/latest.*` | 刷新主 synthetic regression，替代长期只看 near-duplicate。 |
| hard-CS rerank | `evaluation/synthetic-corpus-rerank-hard-cs.json` | `evaluation/results/latest-rerank-hard-cs.*` | 检查 baseline 非饱和、NDCG/Recall 不回退，并要求 NDCG 有 lift。 |
| arXiv real-paper rerank | `evaluation/corpora/arxiv-computer-science-rerank-v1.json` | `evaluation/results/latest-arxiv-rerank.*` | 用受版本控制且绑定 SHA-256 的真实论文 corpus 覆盖长文档、hard negative 和跨论文比较。 |

compare-hard synthetic 使用真实 provider，要求 `OPENAI_API_KEY`。两项 rerank eval 使用 deterministic embedding + heuristic rerank，可稳定复跑。周期 Release 只读取 checked-in arXiv corpus；runner 在执行前校验文件 SHA-256、manifest ID 和 version，并把这些值写入 suite lineage contract。这样 arXiv 的临时 429、5xx 或超时不会被误判为代码回归。

联网刷新与发布验证分离。需要更新论文文本时，先显式生成 ignored 候选文件：

```bash
cd server
npm run corpus:arxiv
```

人工检查候选 corpus 后，再单独更新 `evaluation/corpora/arxiv-computer-science-rerank-v1.json` 及 `evaluation/eval-suite.js` 中固定的 SHA-256；两者不一致时 suite 会 fail closed，不会静默回退到网络或旧报告。

`robust:gate` 只读取以上三份 report，并要求它们都存在：synthetic report 不能有失败 case；rerank report 必须有 ranking case、语料匹配、NDCG/Recall 不回退。workflow 使用 `--fail-on-warn`，因此 NDCG lift 退化成 0 或 baseline 饱和也会失败。它不会把旧 synthetic 历史、feedback、planner、trajectory 或 recovery 状态混入 robust 判定；这些信号分别由 current/release gate 校验。单独运行 `robust:gate` 的输出固定标记为 `latest_reports_unverified/currentCommitVerified=false`；只有随后执行的 `release:gate` 才验证 commit、freshness、profile 与 suite lineage。Suite lineage hash 绑定 provider、固定 corpus 的内容 hash/identity、threshold 以及实际 chunk/retrieval/rerank 配置；release gate 会从代码中的权威 suite 计划重算这个 hash，因此三份报告共享任意自造 hash 也不能通过。

## Trajectory eval

Trajectory eval 检查 AgentRAG 行为，而不是只看答案文本：

- Skill / chain 是否选对
- 证据不足时是否 follow-up
- 该澄清时是否 clarification
- Custom skill 是否传递 `accessScope`
- Budget 是否阻止无限重试
- Goal lifecycle 是否验证 plan steps、unresolved gaps、deliverables、pending approval 和 research phases
- Skill graph：`guarded` 下 typed DAG 是否真的执行且 `/chat` 合同不变、`shadow` 下是否只规划不执行、非法图是否在任何 node 执行前整体被拒、有界 replan 是否只重跑受影响的 node 并在上限处停下

```bash
cd server
npm run eval:trajectory
npm run quality:gate
```

## Planner eval

Planner eval 固化 LLM execution planner 的灰度检查。默认使用 mock LLM provider，不调用外部模型，适合 CI 和本地回归：

```bash
cd server
npm run eval:planner
```

默认 case 覆盖：

- inventory、document RAG、web search 和 custom skill chain 的合法 planner 输出
- validator 拒绝未注册 step
- 非法 LLM-style plan fallback 到 deterministic planner
- `agentObservability.executionPlanner` 记录 selected/fallback 状态
- `planner_dynamic_skill_graph` 将上游 Intent 固定为仅 `compare_documents`，在 `guarded` 下要求 DAG planner 从按 `accessScope` / `docIds` 核验的原子 catalog 独立选出 `compare_documents -> risk_review`，同时检查节点依赖、真实执行、最终 selectedSkills / trace 和文档 scope。mock provider 用固定模型响应验证接线；real provider 才检验真实 LLM 的这次规划。

需要真实模型灰度时显式开启：

```bash
cd server
npm run eval:planner -- --provider real
```

真实模式需要 `OPENAI_API_KEY`。单独运行 provider 会继续更新兼容文件 `server/evaluation/results/latest-planner.json` 和 `.md`，同时写入 provider-specific 文件：

- mock: `latest-planner-mock.json` 和 `.md`
- real: `latest-planner-real.json` 和 `.md`

`quality:gate` 会优先读取 provider-specific planner reports，并在没有这些文件时回退到旧的 `latest-planner.json`。任何 provider 的 planner eval 有失败 case 或 failed check，gate 都会失败，并在文本 / JSON 输出里汇总 provider、失败 case 和失败 check 数。

独立 real-provider gate 用于 scheduled/manual CI，要求 real report 存在并通过，同时检查非预期 fallback 和 mock/real planner 分歧：

```bash
cd server
npm run eval:planner -- --provider mock
npm run eval:planner -- --provider real
npm run planner:gate -- --provider real --compare-provider mock
```

`planner:gate` 默认 `--provider real`，并在 real provider 下默认比较 `mock`。默认阈值为 `--max-unexpected-fallback-rate=0` 和 `--max-divergence-count=0`。Planner eval 中故意验证 validator 的 fallback case 会计入总 fallback 数，但不会计入 unexpected fallback。`rollout:readiness` 还单独要求 real-provider 报告的动态 DAG case、五个对应 check、`llm_dag` planner 且无 fallback；只看 mock PASS 不能证明模型会动态组合 Skill。

## Retrieval 架构证据

Synthetic / feedback 报告从 1.9.0 manifest 起带一个 `summary.retrieval` 块和逐 case 的 `retrieval` 字段，全部由 `/chat` 响应里的 `retrieval` 派生（provider、hybrid 是否开启、fusion 方法、dense/sparse 两路是否真实执行、各产生多少候选、是否发生 fallback），不是从配置抄来的。runner 在写报告前会核对：每个 case 都有 retrieval 证据、所有 case 跑在同一个 provider 上、没有 fallback、hybrid 开启时两路在每个 case 都执行；对不上就拒绝写报告。

`quality:current` 再逐字段校验 `summary.retrieval` 与 manifest 的 `requiredRetrieval`（`pgvector` / `hybridEnabled: true` / `rrf`），从 case 重算路由计数并要求 dense、sparse 两路都至少在一个 case 产生候选；robust gate 对 compare-hard synthetic 报告做同样的检查（`robustSuiteRetrievalContract`）。配置不符、某一路没跑、或出现 fallback 都是 fail。

`summary.config` 故意不包含这些字段：regression profile key 由 `config` 构成，钉住的 deterministic baseline（`quality-near-duplicate-deterministic-v1`）早于 pgvector 默认值，metrics 仍按同一语料比较。CI 的 `quality-gate` job 用真实 `pgvector/pgvector:pg16` service 跑 current profile；本地没有 PostgreSQL 时 `VECTOR_STORE_PROVIDER=local npm run eval:synthetic` 可以跑通，但 `quality:current` 会因 retrieval 合同不符而失败——这是预期行为，不要通过改 manifest 绕过。

## Rollout readiness

```bash
cd server
AGENT_SKILL_GRAPH_ROLLOUT=guarded npm run rollout:readiness
AGENT_SKILL_GRAPH_ROLLOUT=guarded npm run rollout:readiness -- --json
```

`rollout:readiness` 会读取 `latest-planner-real.json`、`latest-planner-mock.json`、`latest-trajectory.json`、`latest-recovery-observability.json` 和 `latest-runtime-smoke.json`，检查当前 runtime 是纯 LLM target（`AGENT_PLANNER_ROLLOUT=llm`，effective intent/execution planner 均为 `llm`）且 `AGENT_SKILL_GRAPH_ROLLOUT=guarded`，生成 `latest-rollout-readiness.*`。real-provider `planner_dynamic_skill_graph` 必须由 `llm_dag` 真正规划并执行 compare+risk、无 fallback；runtime smoke 的两次 HTTP `/chat` 也必须由 LLM 规划并执行 guarded DAG、无 fallback。缺少报告、trajectory/recovery gate 失败、unexpected fallback、mock/real 分歧或上述条件任一不满足，都会标成 `not_ready` 并以非零状态退出。只想生成报告时可用 `npm run rollout:readiness -- --no-fail`；该参数不是 PASS。

## Skill graph rollout 的评测边界

`AGENT_SKILL_GRAPH_ROLLOUT` 的默认值是 `guarded`，所以默认 trajectory case 里凡是进入 custom skill 阶段的请求都由 typed DAG 执行；四个 `skill_graph` case 仍各自钉住 `shadow` 或 `guarded`，`custom_skill_retry` 钉住 `off` 以保留 V1 单步重试的覆盖。固定评测覆盖三层：trajectory 的执行语义、planner eval 的独立原子 Skill 选择、runtime smoke 的真实 HTTP + LLM 路径。它们仍只证明 custom Skill 阶段内的 typed DAG；外层 document/Web/built-in/capability 不是同一张图，schema gate 也不等于差异/风险内容的语义真值校验。

Trajectory eval 的四个 `skill_graph` case 用 `withEnvironmentOverrides` 在各自运行期间钉住灰度位，跑完即还原；同一份报告还保留默认 `off` 路径的既有 case：

| Case | 钉住的模式 | 证明什么 |
| --- | --- | --- |
| `skill_graph_guarded_execution` | `guarded` | `skill_graph_planned` 事件 `executed: true`；node 是原子 skill id 而不是复合 chain id；risk node `dependsOn` summary 并以 typed `priorFindings` 读取上游输出（第二次检索的问题带 "Upstream findings" 而不是 V1 的 "Previous skill outputs"）；每个 node step 持久化了只读 replay contract；`/chat` 响应与 V1 逐字段一致且没有 `graph` / `nodeRuns` / `replans` 字段。 |
| `skill_graph_shadow_comparison` | `shadow` | 答案由 V1 chain 产出（拼接问题、V1 step id、step input 无 `priorFindings`）；graph 只规划校验、`executed: false`、`nodeRuns` 为空；`diverged: false` 被记录；预算只扣一次。 |
| `skill_graph_illegal_plan_rejected` | `guarded` + 注入的 LLM planner | planner 交出同时带伪造 `approval`、未注册 skill 和越权 `scope.docIds` 的图；整图被拒，三个 reason code 全部记录，伪造 node 没有任何一个执行；deterministic graph 在授权范围内作答；planner 拿到的上下文只有白名单视图，不含 `accessScope` / userId / workspaceId。 |
| `skill_graph_bounded_replan` | `guarded` + 注入的 replanner，`maxCustomSkillCalls: 3` | 第一次 risk review 空手而归触发 `insufficient_evidence`；一次 patch 被应用，只有新增 node 执行，已完成的两个 node 状态为 `reused` 且不再计费；第二次尝试在 `replan_limit_reached` 处 abstain；replanner 拿到的上下文只有状态和白名单，没有证据文本和调用者身份。 |

四个 trajectory case 的 id、check id、response 投影，以及 `planner_dynamic_skill_graph` 的同类合同，都钉在 `quality-current-suite-manifest.js`，`quality:current` 会逐字段校验，多一个 case 或少一个 check 都会失败。`planner_dynamic_skill_graph` 在 mock/real provider 下都跑 guarded：Intent 固定为 compare-only，但 graph 必须组合 compare+risk；real provider 才调用真实 LLM DAG planner。这验证了 Skill 选择不再依赖硬编码复合 Intent，同时检查授权文档范围和最终 observability。

Recovery 与仍需区分的证据：

- `eval:recovery-observability` 的 `skill_graph_signal` 从一次 guarded `runAgentRag` 的 `skill_graph_planned` 事件统计 replan 内复用与执行后 fallback。新增的 `skill_graph_startup_resume` 不复用这组计数冒充重启证据：它向内存 store 写入部分 graph checkpoint，重建 run/recovery 服务实例，调用生产启动恢复 API 并检查同一 run 完成、已完成写节点只执行一次、待执行节点只执行一次、CAS 只领取一次、第二次扫描不再领取且没有部分执行后回落 V1。这验证续跑协议和调用链，不证明操作系统进程重启或 PostgreSQL 跨进程持久化。该评测仍只覆盖外层 plan 恰为 `custom_skills`、无待审批且 checkpoint/step 对账成功的 guarded run；unknown in-flight 或混合外层 plan 转 manual，已被领取的 run 由其他 worker 跳过，不会自动二次执行。
- `agent-execution-graph-postgres.integration.test.mjs` 是独立的数据库集成测试：父进程将部分 graph 和已完成写节点落到 PostgreSQL，子 Node 进程重新加载服务并运行启动恢复，然后用数据库 effect 计数证明写节点未重放、后续节点只执行一次。`bash scripts/run-pgvector-integration.sh` 会在临时数据库上运行它；`FULL_SUITE=1 bash scripts/run-pgvector-integration.sh` 会运行整套后端测试且不跳过数据库用例。此测试不代替真实 LLM 与 clean-SHA 的 release 门禁。
- `rollout:readiness` 现在要求运行环境已显式设为 `guarded`、real-provider 动态 DAG case 通过、guarded runtime smoke 的两次 HTTP 运行都由 LLM 规划并执行且无 fallback，此外还要求 trajectory/recovery 和原有 planner gate。`release:gate` 再对完整报告集校验新鲜度、clean worktree、同一目标提交及报告合同。这组门禁衡量的是纯 LLM 规划能否零降级、零分歧；执行器默认值 `guarded` 的依据是执行语义证据（全量测试、trajectory、recovery、PostgreSQL 跨进程恢复），不以它为前提。
- Mock planner、注入的 trajectory planner 和 deterministic recovery fixture 是稳定接线回归；只有 `eval:planner -- --provider real` 的动态 case 与 `runtime:smoke` 检查真实 LLM 的 DAG 规划。它们不衡量真实文档上的语义差异/风险质量。

需要确认 V1 回退路径时，可以整份用 `off` 复跑：

```bash
cd server
AGENT_SKILL_GRAPH_ROLLOUT=off npm run eval:trajectory
```

这只是额外的本地实验，不代替上述 real-provider 和 release 门禁；注意 `server/.env` 里的取值会覆盖代码默认值。`latest-trajectory.*` 是 gitignore 的本地产物，跑完后若要恢复默认报告，应在默认配置下重跑。

## Runtime smoke

```bash
cd server
AGENT_PLANNER_ROLLOUT=llm AGENT_INTENT_PLANNER=llm AGENT_EXECUTION_PLANNER=llm AGENT_SKILL_GRAPH_ROLLOUT=guarded npm run runtime:smoke
```

`runtime:smoke` 需要 `OPENAI_API_KEY` 和 `POSTGRES_DATABASE_URL` 或 `LONG_MEMORY_DATABASE_URL`。它会启动真实 Express app，走 `/health` 和两次 `/chat` HTTP 请求，不注入 deterministic planner。文档 RAG 使用 smoke stub，避免依赖上传文件和 embedding；intent/execution 与 DAG planner 仍走真实 LLM provider。`off` 不能通过该 smoke；默认 `guarded` 可以，但 `server/.env` 里写着 `off` 时要显式覆盖。

Smoke 断言：

- `/health` 的 `longMemory` 和 `agentExperienceMemory` 都是 `ok`，且 reason 为 `postgres_configured_default`
- 两次 `/chat` 的 `agentObservability.intentPlanner` 和 `agentObservability.executionPlanner` 都选中 `llm`，且没有 fallback
- 两次运行都写入 `mode: "guarded"`、`executed: true`、`fallback: null`、`selectedPlannerId: "llm_dag"` 的 `skill_graph_planned` 事件，并执行 `summarize_contract` 与 `risk_review`
- 第一次 successful `skill_chain` 写入 `successful_plan` experience memory
- 第二次请求加载该 memory 为 planning hint
- `ragSources` 只包含 smoke document source，不包含 `agent_experience` 或 `successful_plan`

报告写入 `evaluation/results/latest-runtime-smoke.json` 和 `.md`。`Planner Real Provider Gate` scheduled workflow 会启动 PostgreSQL service，在纯 LLM + guarded Skill graph 环境下先运行这个 smoke，再运行 `rollout:readiness` 把 smoke、real/mock planner gate、trajectory 和 recovery 汇总成灰度准备信号；完整发布还需 `release:gate` 的同提交证据校验。

## DocCompare quality verification

```bash
cd server
npm run verify:quality
```

这是唯一一条用**真实 embedding 模型 + 真实 chat 模型**验证「零基础设施档案」检索与对比质量的路径。其余测试都跑 deterministic stub embedder —— 那证明管线接通，不证明检索找对了文本。

不需要 PostgreSQL，也不需要 OpenAI 官方 key：`rag/openai-client.js` 的 `resolveBaseUrl()` 支持 `OPENAI_BASE_URL` / `OPENAI_API_BASE`，所以任何提供 `/v1/embeddings` 和 `/v1/chat/completions` 的端点都行。本地 Ollama 示例（key 只要非空即可）：

```bash
cd server
OPENAI_API_KEY=ollama \
OPENAI_BASE_URL=http://127.0.0.1:11434/v1 \
OPENAI_EMBEDDING_MODEL=nomic-embed-text \
OPENAI_CHAT_MODEL=qwen2.5:7b \
npm run verify:quality
```

五条路径：单文档问答（带页码引文）、双文档对比、**同文档控制组**、语料外弃答、第二个进程读同一份归档。

两个设计使评分**不能被坏系统蒙过**：

- 「永远弃答」的系统会通过所有弃答检查。所以弃答只在答题路径确实产出答案时才算有效，且这条交叉检查本身记为一个 check（`meta.abstention-is-discriminating`），而不是写在散文里。
- 「永远声称找到差异」的系统会轻松通过对比测试。所以语料里放了一对逐字节相同的 `policy-v1.pdf` / `policy-v2.pdf`，在这对文档上编出差异即失败。

页码是**对着 ground truth 校验**而不是校验「存在」：`evaluation/build-doccompare-fixtures.mjs` 知道每句话在第几页，所以引文指向错误页会被抓出来（`citationPageIsHonest` 按 excerpt 的特征词是否真在该页比对）。责任条款故意放在第 2 页，永远回答「第 1 页」的系统会失败。

最关键的一条是 `compare.value-binding`：答案必须把每个数值绑定到它来源的那份文档（12 个月 → Vendor A，6 个月 → Vendor B），任一侧串到另一侧的数值即失败。自信而张冠李戴的答案比不回答更糟，而且读起来跟正确答案一模一样。

检查分 blocking 和 advisory。advisory 只依赖模型措辞而非系统行为（例如是否说出「identical」），小模型措辞不到位不算产品缺陷，不会让整轮失败。

报告写入 `evaluation/results/latest-doccompare-verification.json` 和 `.md`，并在 artifact 里写明适用范围：它不衡量真实世界文档上的答案质量，不做模型对比，也不覆盖 PostgreSQL 部署。

### 自检模式

```bash
cd server
node evaluation/run-doccompare-verification.mjs --self-test
```

用 synthetic eval 那套 deterministic provider 跑完整流程，不需要 key 和网络，用来确认 harness 本身能跑通 —— 避免 harness 的崩溃在别人第一次真实运行时才被发现。

**预期结果是 16/18，不是全绿。** 但失败的原因容易搞错，这里写清楚：对比答案有三级（`rag/answer-writer.js` 约 923-957 行）—— 模型文本过 `isSafeStructuredDifferenceAnswer` 就用它；否则退到引擎构造的 `buildGroundedDifferenceAnswer`；两者都不过才弃答。deterministic stand-in 下**两级都没过**，所以弃答，`compare.answers` 和 `compare.value-binding` 因此失败 —— 这正是 harness 拒绝给假模型放行。

**不要以为对比答案路径在别处被覆盖了。** `test/rag.test.mjs` 的 `the MCP ask tool carries a real comparison summary onto the wire` 跑在该文件全局的 stub provider 下，`completeText` 返回的是手写死字符串，断言的只有引擎算出来的结构化字段（`comparedDocIds`、`evidenceBalance`、`explicitConflictPairs`）和引文。它真正覆盖的是**对比引擎**和 MCP 序列化接缝，不是「模型写出了正确的对比」—— 这条测试的名字夸大了它检查的内容。

所以全绿只应出现在真实模型上，而「真实模型能否过 `isSafeStructuredDifferenceAnswer`」目前**没有测过**。第一次真跑时如果对比仍然弃答，值得查：为什么 `buildGroundedDifferenceAnswer` 在 3 页语料上不出答案，而在单元测试的 1 页语料上可以 —— 那会是真实的产品发现，不是 harness 的问题。自检报告写到 `latest-doccompare-selftest.*`，不会覆盖真实报告。

## Quality gate baseline

`quality:gate` 的 synthetic regression baseline 会先排除比 current run 更新的历史结果，然后按优先级选择：同 corpus + 同 profile、同 corpus、同 profile、最后才是最近的 previous synthetic run。这样本地保存的 hard-cs、compare-hard 或其他实验 corpus 不会误作为 `latest.*` 的直接回归基线。

## Observability report

```bash
cd server
npm run observability:report
npm run observability:report -- --json
```

报告会汇总 RAG / AgentRAG JSONL trace，包括：

- skill attempts、latency、citations、retry/failure/abstain rate
- execution planner requested/selected provider 分布
- LLM planner selected count、fallback count 和 fallback rate
- LLMOps operation / model route 指标、token/cost/SLO 聚合，以及 annotation、alert、budget status counts
- planner fallback reason top list
- 各 `agentMode` 下的 planner `stepIds` 分布
- recovery/replay 指标：recoverable run 数、manual recovery 数、auto replay 成功率、step retry/resume 次数、step replay failure 数，并在同一区块展示 planner fallback count 和 skill graph 的 planned / executed / fallback / reused node / replan 计数
- query planner intent、retrieval query 数量和 topK profile
- RAG route mode、latency、citation 和 abstain 指标

`eval:recovery-observability` 会用 deterministic fixture 与实际 guarded graph 服务重建探针生成 `latest-recovery-observability.*`，再由 `quality:gate` 的 recovery gate 检查：observability eval case/check 不能失败，auto replay failure、manual recovery action failure、step replay failure、observed planner fallback 和 skill graph 执行后 fallback（`recoverySkillGraphUnsafeFallbackCount`，阈值 0）都必须为 0，同时要求 report 覆盖 recoverable run、manual recovery action、auto replay attempt、step retry、step resume 和 graph startup resume。`recovery` 区块的 planned / executed / fallback / reused / replan 计数来自 `skill_graph_planned` run event；resume claim / completion 来自 run 事件，是否重复执行来自服务重建探针在生成报告前的直接断言。PostgreSQL 跨进程恢复仍需独立环境验证。

## Feedback regression

```bash
cd server
npm run feedback:corpus
npm run eval:feedback
npm run eval:feedback:real
```

`feedback:corpus` 默认合并 tracked seed 数据 `server/evaluation/feedback-seed.jsonl` 和 runtime 数据 `server/data/feedback/feedback.jsonl`，收集 `citation_error`、`incomplete` 和 `hallucination` 三类负反馈。使用 `--no-seed` 可以只评测指定 runtime 输入。

`eval:feedback` 默认使用 deterministic OpenAI provider，适合本地和 CI 稳定回归；`eval:feedback:real` 使用真实 provider，需要 `OPENAI_API_KEY`。`quality:gate` 会读取 `latest-feedback.json`；如果 feedback eval 没有 case、有失败 case 或 unsupported claim，gate 会失败，并按 `skillId@skillVersion` 汇总问题。

## Coverage gate

默认命令执行所有后端测试文件，排除聚合入口 `run.test.mjs`，并检查当前可稳定执行的 minimum gate：

```bash
cd server
npm run coverage:gate
```

门禁从 Node `test:coverage` 结构化事件读取原始 covered/total 计数；Global
和各分组都在排除测试文件后按计数加权聚合，避免 Node 20 把测试源码计入
`all files`，也避免小文件与大文件等权造成假通过。
受控源码清单来自 Git tracked files，任何未出现在报告中的 Global、RAG、检索或
route 源文件都会 fail closed。确实需要外部进程或服务的入口脚本必须显式列入
`test/coverage-policy.mjs` 的 exclusion 清单，新增源码默认不能静默逃逸门禁。

目标阈值分组：

| 分组 | 目标 |
| --- | --- |
| RAG / AgentRAG core | line 95%+, branch 80%+, funcs 90%+ |
| Rerank / retrieval | line 95%+, branch 85%+, funcs 95%+ |
| API routes | line 85%+, branch 70%+, funcs 85%+ |
| DB / OpenAI / CLI scripts | line 70%+, branch 70%+, funcs 70%，report-only，不硬拦 |
| Global backend | line 85%+, branch 75%+, funcs 90%+ |

严格目标：

```bash
cd server
npm run coverage:targets
```

## Rerank ranking eval

离线 rerank eval 只评估候选 chunk 排序，不调用回答生成模型。默认使用 near-duplicate corpus 的 `expectedEvidence` 作为页级相关性标注，并用确定性 embedding 生成可复跑结果：

```bash
cd server
npm run eval:rerank
```

指定语料和输出名：

```bash
cd server
npm run eval:rerank -- evaluation/synthetic-corpus-compare-hard.json --latest-name compare-hard-rerank
npm run eval:rerank -- evaluation/synthetic-corpus-rerank-hard-cs.json --latest-name rerank-hard-cs
npm run eval:rerank -- evaluation/generated/arxiv-corpus.json --embedding-provider openai --rerank-provider heuristic --latest-name arxiv-openai-rerank
npm run eval:rerank -- evaluation/generated/arxiv-corpus.json --rerank-provider cross-encoder --cross-encoder-endpoint http://localhost:8081/rerank --latest-name arxiv-cross-encoder-rerank
```

报告包含 baseline 粗排与 rerank 后的 `NDCG@k`、`Precision@k`、`Recall@k`、`MRR`、`Noise rate@k` 和排序提升率。严格 gate 会按报告声明且由 suite 固定的 chunk 配置，从当前 corpus 重新切分每个候选，并要求候选文本、文件、页码和 chunk index 完全一致；页内任意短子串不能再冒充真实检索候选。

固定周期 gate 使用 `latest-rerank-hard-cs.*` 和 `latest-arxiv-rerank.*`，不再依赖 near-duplicate rerank 的饱和报告判断 lift。

## arXiv real-paper corpus

真实论文 rerank 评测采用受版本控制的固定 corpus，避免每次评测实时下载导致语料漂移或瞬时网络失败：

```bash
cd server
npm run eval:rerank -- evaluation/corpora/arxiv-computer-science-rerank-v1.json --latest-name arxiv-rerank
```

只有显式刷新候选 corpus 时才访问 arXiv：

```bash
cd server
npm run corpus:arxiv
npm run eval:rerank -- evaluation/generated/arxiv-corpus.json --latest-name arxiv-refresh-review
```

当前 manifest 固定 8 篇计算机方向论文：RAG、DPR、ColBERT、HNSW、Transformer、ReAct、Toolformer、Self-RAG。当前 pinned corpus 包含 48 个标注 case，覆盖精确问答、hard negative 和跨论文比较。

批量 sweep：

```bash
cd server
npm run eval:rerank:sweep
npm run eval:rerank:sweep -- --profile full
npm run eval:rerank:sweep -- --include-openai
npm run eval:rerank:sweep -- --include-openai --include-cross-encoder
```

本地神经 cross-encoder reranker：

```bash
cd server
npm run rerank:cross-encoder:setup
npm run rerank:cross-encoder
```

默认监听 `http://127.0.0.1:8081/rerank`。只想验证 HTTP 协议链路时，可以运行：

```bash
cd server
npm run rerank:cross-encoder:local
```

## 真实模型评测与外部基准（框架）

这一组入口用来把评测从确定性替身换成真实模型和外部标注。除 `eval:retrieval-comparison` 和 `verify:quality` 已用本地 Ollama 实跑过外，其余目前是框架：脚本可运行，但还没有提交的基线结果或测试。

| 命令 | 用途 |
| --- | --- |
| `npm run eval:retrieval-comparison -- --embedding-provider openai` | 四组检索配置用真实 embedding 对比（任何 OpenAI 兼容端点，含 Ollama），每个 split 带配对 bootstrap 95% CI；报告写到 `latest-retrieval-comparison-openai.*`，不覆盖确定性报告。加 `--rerank-provider cross-encoder --cross-encoder-endpoint <url>` 测神经 reranker（服务见 `npm run rerank:cross-encoder:docker`）。 |
| `npm run corpus:qasper -- --input <qasper-dev-v0.3.json> [--papers 20]` | 把 QASPER（allenai.org/data/qasper，CC BY 4.0，需自行下载解压）转成本仓库语料格式：摘要为第 1 页、每个章节一页，证据段落映射到页码，不可回答题成为 `shouldAbstain`。输出默认在已忽略的 `evaluation/generated/`。 |
| `npm run eval:judge -- --input <answers.json> [--labels <labels.json>]` | LLM 评审：对 `{id, question, answer, referenceAnswer?, evidence?}` 按意思判 correct / partially_correct / incorrect / correct_abstention / wrong_abstention，并判忠实度。给了人工标注就报告一致率和 Cohen's kappa；没有校准过的评审分数不应对外引用。评审走 chat 路由，应把 `OPENAI_CHAT_MODEL` 设成与作答模型不同的模型。 |
| `npm run eval:claim-judge [-- --rounds 3]` | claim 评审的校准门槛：用 verify:quality 合同构造的对照集（14 条正确改写、14 条各错一处：错数字、错主体、错动作方、加条件、去条件、否定、may/must、方向颠倒、外部知识），另有 8 条留出集。分别跑"只用词法"和"词法 + 评审"，报告改写接受率和错误接受率。标签由构造保证，不是人工标注。 |
| `npm run eval:answer-drafts [-- --set fixtures\|arxiv\|all] [--cases 12]` | 用真实 embedding + chat 模型（任何 OpenAI 兼容端点）在临时 standalone 档案里跑单文档问答：`fixtures` 是 verify:quality 的合同和政策（事实逐字出现），`arxiv` 是 8 篇论文。通过 `runAgentRag` + 流式接收端测首个草稿时间、最终答案时间、草稿保留率、撤回原因和澄清率；报告写到已忽略的 `latest-answer-drafts.*`。 |
| `npm run eval:llm-resilience [-- --no-fallback]` | 故障注入：本地 OpenAI 兼容服务注入 429（精确 / 粗粒度 Retry-After）、503、挂起、空响应、主模型宕机，以及模拟自托管服务的饱和场景（2 个工作线程、请求排队、客户端放弃的请求仍被处理，16 个并发调用方），报告 SLO 内成功率、每次调用的上游请求数、p50/p95 和饱和场景的服务端峰值排队。每个场景开始前重置熔断和并发状态，避免上一个场景打开的熔断影响下一个。 |

### LLM 调用容错：改前 / 改后

`npm run eval:llm-resilience`，每个场景 24 次调用、并发 8、SLO 15 秒，三轮平均。改前是 `75628674`（固定 250/750/1500ms 重试、不读 Retry-After、超时 120 秒且不重试、无备用模型），改后是 `a2764083` 起的代码；"改后无备用"用 `--no-fallback`。评测里的备用模型和主模型共用同一个限流器，这是 failover 的最坏情况。

| 场景 | 改前 | 改后 | 改后无备用 |
| --- | --- | --- | --- |
| healthy | 100% | 100% | 100% |
| 429，精确 `retry-after-ms` | 79.2%（2.63 请求/调用，p95 2.5s） | 100%（3.21，p95 4.7s） | 83.3%（2.67） |
| 429，粗粒度 `Retry-After: 1` | 79.2%（2.63） | 100%（2.22，p95 4.9s） | 94.4%（2.08） |
| 40% 返回 503 | 100%（p95 1.0s） | 100%（p95 1.2s） | 100% |
| 20% 请求挂起 | 87.5%（p95 15s） | 100%（p95 3.4s） | 100% |
| 30% 空 completion | 62.5% | 91.7% | 91.7% |
| 主模型宕机 | 0% | 100% | 0% |

代价：遵守 Retry-After 让限流场景的 p95 从约 2.5 秒升到约 4.7 秒；成功率的提升来自不再在服务端要求等待时抢跑。持续过载下单靠重试无法兜住，需要客户端并发限制或自适应限流。

### 校验过的答案草稿：真实模型

`npm run eval:answer-drafts`（qwen2.5:7b + nomic-embed-text，本地 Ollama，确定性规划器）：

| 用例集 | 有草稿的运行 | 首个草稿 / 最终答案（p50） | 草稿保留 | 最终是澄清 |
| --- | --- | --- | --- | --- |
| fixtures（合同、政策，7 题） | 1/7 | 476ms / 1067ms（有草稿那次只早 7ms） | 1/1 | 6/7 |
| arxiv（8 篇论文，12 题） | 0/12 | - / 2826ms | - | 11/12 |

- 机制按设计工作：唯一的草稿保留在最终答案里，没有撤回；但在这个模型和校验器下几乎没有收益。
- 瓶颈是校验器，不是流式：绝大多数答案过不了词法 claim 校验，所以既没有草稿，agent 最后也改为澄清。对照 `verify:quality` 的 18/18，那个测的是不经过 agent 自检的纯 RAG 路径。
- 查出并修了两个校验器 bug（见下节），但主要原因不是 bug：模型会加证据里没有的词（"According to the document"、"defined such that"、"can be terminated"），词法校验对每个没出现的词都判失败。
- 答案短、收尾只需毫秒，所以即使有草稿，也只比最终答案早一句话的生成时间；草稿的价值要等长答案和能放行正确改写的校验器。

### 校验器的两个 bug：改前 / 改后

1. **"twelve (12)"被算成两个数**：合同常把数字写两遍，数值比较要求双方数字个数相同，所以"twelve months"、"12 months"都对不上"twelve (12) months"。现在两种写法值相同时合并成一个数（`collapseParenthesizedNumberRestatements`），值不同（"twelve (13)"）则保留两个，照样判失败。
2. **证据在 PDF 换行处被切断**：证据句子按每个换行切分，而 PDF 文本保留了排版换行，"…on thirty (30) days / written notice to the other party."被切成两半，哪一半都支持不了完整复述；此前能用的 220 字符摘录又把后半截截掉了。现在额外检查"软换行"重新接起来的句子：上一行没有句末标点、下一行小写开头才算软换行，所以标题（"Remote Work Policy" / "Employees may…"）不会被接到正文上，比较等价性判断依赖这一点；按行切出的句子保留不变。

同一评测（qwen2.5:7b，各 3 轮，改前 `416066ee`，两边读同一份 `.env`）：

| 用例集 | 改前：非澄清的回答 | 改后 | 改前：有草稿的运行 | 改后 |
| --- | --- | --- | --- | --- |
| fixtures（7 题 × 3） | 2/21 | 4/21 | 2/21（草稿全部保留） | 4/21（全部保留） |
| arxiv（12 题 × 3） | 3/36 | 3/36 | 0/36 | 0/36 |

arxiv 的 3 次"回答"都是误路由到时间线 Skill，不是文档问答。`verify:quality` 仍是 18/18。提升很小：这两个 bug 是真的，但不是主要瓶颈；剩下的失败主要是改写用词（见上一节）、"According to policy-v1.pdf"这类文档归属短语没被识别（文件名里的"v1"被当成数字），以及管辖法律问题在检索阶段就判为证据不足。它们要靠替换词法校验器解决，而不是继续打补丁。

### Claim 评审：校准与端到端

`npm run eval:claim-judge`（评审模型 qwen2.5:7b，3 轮）：

| 校验 | 正确改写被接受 | 错误 claim 被接受 |
| --- | --- | --- |
| 只用词法 | 3/42（7%） | 0/42 |
| 词法 + 评审 | 39/42（93%） | 0/42 |
| 留出集，词法 + 评审 | 10/12 | 0/12 |

- 数字规则在评审前挡下了 6 次错数字。
- 第一版评测只看拆分后的第一条 claim，把"…30 天书面通知，且通知须挂号寄出"算成了评审误判；实际校验器把它拆成两条，评审只接受了前半句，finalizer 会删掉后半句。修正为"整句拆出的每条都通过才算接受"后误判消失。
- 真实的误判也有：前一轮里"…six months of fees unless the claim involves data loss"被接受过 1 次，评审的理由写着"引入了原文没有的条件"，结论却是 supported；反方向也出现过（理由说支持、结论说不支持）。7B 评审的结论字段有时和它自己的理由不一致，前后两次完整运行里约百分之一。
- 标签由构造保证，不是人工标注的真实答案；上线默认值前应该用 `eval:judge -- --labels` 在真实答案上报告一致率和 kappa。

端到端（`eval:answer-drafts`，同一份代码，评审关 / 开各 3 轮）：

| 用例集 | 指标 | 评审关 | 评审开 |
| --- | --- | --- | --- |
| fixtures（7 题 × 3） | 得到回答 | 3/21 | **14/21** |
| | 回答正确 / 错误（值对、且没混入另一家的值） | 3 / 0 | **14 / 0** |
| | 延迟 p50 / p95 | 1150 / 1463 ms | 1985 / 2367 ms |
| arxiv（12 题 × 3） | 得到回答（不含误路由） | 0/36 | 3/36 |
| | 延迟 p50 / p95 | 3269 / 6264 ms | 4312 / 12110 ms |

剩下 7 次澄清里 6 次是两道管辖法律题，检索阶段就判为证据不足，与校验器无关。代价是每个答案多一次模型调用：合同题 p50 多 0.8 秒；论文答案 claim 更多、还可能补检索后再评一次，p95 翻倍。

### 并发上限与熔断：改前 / 改后

同一评测，三轮平均。改前是 `d5623593`（上表"改后"的代码），改后加了 `server/rag/model-call-guard.js`（默认每个端点和模型最多 8 个在途请求，连续 5 次不可用错误熔断 30 秒）。饱和场景是这次新加的，改前改后跑的是同一份评测脚本。

| 场景 | 指标 | 改前 | 改后 |
| --- | --- | --- | --- |
| 主模型宕机，有备用模型 | 成功率 / 请求/调用 / p50 / p95 | 100% / 5.00 / 2.6s / 3.1s | 100% / **1.33** / **24ms** / **0.47s** |
| 主模型宕机，无备用模型 | 成功率 / 请求/调用 / p50 / p95 | 0% / 4.00 / 2.6s / 3.0s | 0% / **0.33** / **<1ms** / 0.48s |
| 饱和（2 个工作线程，16 个并发调用方） | 成功率 / 请求/调用 / p50 / p95 / 服务端峰值排队 | 100% / 1.42 / 2.4s / 5.2s / 16 | 100% / **1.00** / 2.4s / **3.2s** / **8** |

- 主模型宕机：熔断打开后调用不再先把重试计划在主模型上走一遍，而是直接切备用模型；没有备用模型时立即失败，而不是等 2.6 秒的退避后失败。成功率不变，因为这个场景里重试本来就能兜住，熔断省的是时间和对故障端点的请求。
- 饱和：改前 42% 的请求是超时后的重试，服务端还在处理客户端已经放弃的请求；并发上限把服务端队列压到 8 以内，排队时间始终短于 3 秒请求超时，于是没有一次重试。p50 不变，因为总工作量由服务端的 2 个工作线程决定，上限只去掉了浪费的部分。
- 其他场景（限流、503、挂起、空响应）在噪声范围内不变：429 不计入熔断，评测的 8 个并发没超过上限。40% 返回 503 的场景没有误熔断（无备用模型时仍是 100%），但连续失败阈值在更高错误率下可能误熔断，这是阈值的取舍。
- 边界：状态按进程保存，多进程部署各自计数；上限按在途请求数而不是每分钟 token 数；排队等待没有单独的超时。

## Ragas supplement

`ragas` 不替代自定义 compare harness，但适合补充观察语义相关性和 grounding：

```bash
cd server
python3 -m venv evaluation/.venv-ragas
evaluation/.venv-ragas/bin/python -m pip install -r evaluation/ragas-requirements.txt
npm run eval:ragas -- --input evaluation/results/latest.json
```

## CI quality gate

GitHub Actions 的 `Quality Gate` workflow 会在 PR 和 `main` push 时执行：

1. `cd server && npm test`
2. 用 near-duplicate corpus 和 deterministic provider 生成独立 `latest-quality.*`
3. `npm run eval:trajectory`
4. `npm run eval:planner -- --provider mock`
5. `npm run eval:recovery-observability`
6. `npm run eval:feedback`
7. `npm run quality:current -- --target-commit "$EVAL_TARGET_COMMIT_SHA"`

PR/main Quality Gate 只消费 deterministic/mock provider，不读取 `OPENAI_API_KEY`，因此无效密钥、限流或外部模型抖动不会让普通代码提交失败。真实 provider 由独立的 `Planner Real Provider Gate` 和每周 `Release Evidence Gate` 强制验证。eval producer 和 current gate 都使用 `!cancelled()`，因此单个 producer 失败后仍会运行其余诊断；job 保持失败，最后通过 `always()` 上传原始 latest reports 与 `latest-current-quality-gate.*`。workflow 不再把兼容命令 `quality:gate` 的历史 PASS 当作 PR current 证据。

`Planner Real Provider Gate` workflow 通过 `workflow_dispatch` 和每周二至周日 `0 9 * * 0,2-6` schedule 触发。它在纯 LLM planner + `AGENT_SKILL_GRAPH_ROLLOUT=guarded` 环境下强制运行 mock/real planner eval（含动态 DAG case）、trajectory eval、recovery observability eval，并执行 `npm run planner:gate -- --provider real --compare-provider mock --max-unexpected-fallback-rate=0 --max-divergence-count=0`、`npm run runtime:smoke` 和 `npm run rollout:readiness`。该 workflow 会启动 PostgreSQL service，让 smoke 覆盖 Postgres default-on memory 和两次真实 LLM 规划的 guarded `/chat` DAG；缺少 `OPENAI_API_KEY` 会让 real eval 或 smoke 失败。周一由 `Release Evidence Gate` 在 `0 11 * * 1` 统一覆盖 planner、runtime、recovery 和 readiness 信号，避免重复周期通知。

`Robust Eval Suite` workflow 仅通过 `workflow_dispatch` 手动触发。它要求 `OPENAI_API_KEY`，运行 `npm run eval:robust-suite`，再用 scoped `npm run robust:gate -- --fail-on-warn` 强制检查 compare-hard、hard-CS rerank 和 arXiv real-paper rerank 三份 report，并上传 `latest.*`、`latest-rerank-hard-cs.*`、`latest-arxiv-rerank.*` artifacts。该 workflow 不读取历史 quality 状态。每周固定运行由 `Release Evidence Gate` 统一负责，避免同一 robust suite 产生重复周期任务和通知。

`Release Evidence Gate` workflow 通过 `workflow_dispatch` 和每周一 `0 11 * * 1` schedule 触发，明确不在 `pull_request` 上运行。它在单个 job、单次 target checkout 中设置 `EVAL_TARGET_COMMIT_SHA=${{ github.sha }}`、`EVAL_EVIDENCE_PROFILE=release` 和 `AGENT_SKILL_GRAPH_ROLLOUT=guarded`，先用同一 pgvector PostgreSQL 服务运行 `test:pgvector`（包括跨 Node 进程的 graph checkpoint 恢复测试），再依次生成 robust suite、mock/real planner、trajectory、recovery observability、runtime smoke 与 rollout readiness，执行严格 `release:gate` 并上传 required latest JSON/Markdown 和 `latest-release-evidence.*`。集成测试失败会使发布 job 失败，但 `release:gate` 的 JSON 报告只验证评测报告本身，不会将这项测试的运行结果伪装成其中一份报告。这样昂贵的 real/robust 评测不会增加默认 PR gate 成本，发布 artifacts 又都绑定同一 SHA。

提交前建议至少运行：

```bash
cd server
npm test
npm run eval:trajectory
npm run eval:planner
npm run eval:recovery-observability
npm run rollout:readiness
npm run quality:gate
npm run quality:current
```
