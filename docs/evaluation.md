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
| `cd server && npm run coverage:targets` | 把目标覆盖率作为硬门控运行。 |
| `cd server && npm run eval:synthetic` | 运行默认 synthetic RAG eval。 |
| `cd server && npm run eval:trajectory` | 评测 AgentRAG 执行轨迹。 |
| `cd server && npm run eval:planner` | 用 mock LLM provider 评测 execution planner、validator 和 fallback；`-- --provider real` 会生成真实 provider 报告。 |
| `cd server && npm run eval:recovery-observability` | 生成 deterministic recovery/replay observability report，覆盖 manual recovery、auto replay、step retry/resume 和 planner fallback signal。 |
| `cd server && npm run planner:gate -- --provider real` | 强制检查 real planner report、unexpected fallback rate 和 mock/real planner 分歧。 |
| `cd server && npm run rollout:readiness` | 汇总 real planner gate、纯 LLM runtime target、trajectory gate、recovery gate、fallback rate 和 mock/real divergence，生成默认启用纯 LLM planner 前的 readiness signal。 |
| `cd server && npm run runtime:smoke` | 用真实后端 HTTP 路径、真实 LLM planner 和 PostgreSQL smoke `/health` + `/chat`，确认 long/experience memory default-on、planner 选中 `llm`、experience memory 只进入 planning hints 而不进入 evidence sources。 |
| `cd server && npm run feedback:corpus` | 从负反馈生成 synthetic 评测语料。 |
| `cd server && npm run eval:feedback` | 用 seed + runtime feedback corpus 运行 deterministic 回归评测。 |
| `cd server && npm run eval:robust-suite` | 固定周期运行 compare-hard synthetic、hard-CS rerank 和 arXiv real-paper rerank。 |
| `cd server && npm run quality:gate` | 检查主线、feedback、trajectory、planner 和 recovery gate。 |
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
| `evaluation/results/latest-trajectory.*` | AgentRAG trajectory eval：当前默认 deterministic suite 为 `13/13` cases passed，`52/52` checks passed，包含 goal lifecycle completion。 |
| `evaluation/results/latest-planner*.{json,md}` | AgentRAG planner eval：默认 mock provider，覆盖 LLM plan selection、validator rejection、deterministic fallback 和 planner observability；mock/real provider 会各自写入 provider-specific latest report。 |
| `evaluation/results/latest-recovery-observability.{json,md}` | AgentRAG recovery observability eval：deterministic fixture 覆盖 recoverable run、manual recovery action、safe step retry/resume、auto replay success rate 和 planner fallback signal。 |
| `evaluation/results/latest-rollout-readiness.{json,md}` | AgentRAG rollout readiness：只输出是否 ready 的信号，汇总 real planner provider gate、trajectory gate、recovery gate、unexpected fallback rate 和 mock/real planner divergence，不改变默认 planner 行为。 |
| `evaluation/results/latest-rerank-hard-cs.*` | Hard-CS rerank eval：baseline 不再满分，heuristic rerank 需要保持 NDCG/Recall 不回退并保留 NDCG lift。 |
| `evaluation/results/latest-arxiv-rerank.*` | arXiv real-paper rerank eval：使用固定 manifest 生成的真实论文 corpus，覆盖更长文档和 hard negative。 |
| `evaluation/results/latest-release-evidence.{json,md}` | 严格发布证据报告：逐项记录 8 份 required reports 的状态、稳定 reason code、期望值、实际值和 lineage 摘要。 |
| `evaluation/results/latest-rerank.*` | Legacy near-duplicate rerank eval：baseline 已接近饱和，仅作历史参考。 |
| `evaluation/results/arxiv-rerank-sweep-latest.*` | arXiv real-paper quick sweep 当前最佳 variant 为 `broad_topk`，NDCG `0.5831`，Recall `0.8177`，MRR `0.5891`。 |
| `evaluation/results/compare-hard-ragas.*` | Ragas supplement：faithfulness `0.8939`，context precision `1.0`，compare rubric `0.9333`。 |

说明：仓库内旧的 `latest.*` snapshot 可能仍来自 near-duplicate，或尚未包含统一 lineage metadata；不要为这些旧报告补写或伪造 metadata。固定周期入口 `eval:robust-suite` 会用真实运行结果刷新 compare-hard、hard-CS 和 arXiv 三份报告；旧报告仍可由默认 `quality:gate` 读取，但严格 `release:gate` 会把缺少 lineage 的报告判为 `missing_lineage`。

## Evidence metadata

纳入发布判断的 runner 共用 `server/evaluation/eval-evidence.js` 构造 additive `evidence`，不改变原有 metrics、cases、checks 或 status 语义。metadata 包含：

- `schemaVersion`、`reportType`、`reportId`、`runId`、`generatedAt`、`command`、`profile` 和 `generatorVersion`
- `git.commitSha` 与 `git.dirty`
- `corpus.id`、repo-relative `corpus.relativePath`、`corpus.contentHash` 和 corpus version
- 基于公开配置 canonical JSON 计算的 `configHash`
- `provider.id`、`provider.mode` 和公开 `modelRouteId`
- aggregate report 实际消费的 `sourceReports`；每项保留 report type/id、run ID、commit、生成时间、config hash、corpus ID 和 provider mode

路径会正规化为 repo-relative；仓库外路径写为 `unknown`。公开配置会移除 API key、token、secret、authorization、prompt、原始文档内容、完整环境变量和内部 model name。无 Git 环境时 commit/dirty 记为 `unknown`：普通开发流程可以继续读取，严格发布门会失败。`eval:robust-suite` 还会把同一个 target commit、suite run ID 和 suite config hash 传给 compare-hard、Hard-CS 与 arXiv 三个 runner，防止把不同批次结果拼成一次 robust 证据。

CI 可通过 `EVAL_TARGET_COMMIT_SHA` 把报告绑定到指定 SHA；它必须等于 runner 所在 checkout 的 `HEAD`。本地默认直接读取当前 `HEAD`。生成报告时除受控的 `server/evaluation/generated/` 与 `server/evaluation/results/` 输出外，只要 worktree 仍有其他改动，`git.dirty` 就会为 `true`，该报告不能通过严格发布门。

## Release evidence gate

`release:gate` 是发布入口；它只验证已生成的报告，不会调用 OpenAI、下载 arXiv 语料或伪造 `latest.*`。默认 target 是当前 `HEAD`，并检查以下 8 份 JSON：

| Required report | 文件 | 发布约束 |
| --- | --- | --- |
| compare-hard synthetic | `evaluation/results/latest.json` | 原报告通过，使用规定 compare-hard corpus，commit/config/corpus lineage 与 robust suite 一致。 |
| Hard-CS rerank | `evaluation/results/latest-rerank-hard-cs.json` | 原报告通过，使用规定 Hard-CS corpus/version，且 robust lineage 未分裂。 |
| arXiv real-paper rerank | `evaluation/results/latest-arxiv-rerank.json` | 原报告通过，使用规定 manifest corpus/version，且 robust lineage 未分裂。 |
| trajectory | `evaluation/results/latest-trajectory.json` | trajectory 原始 cases/checks 通过并属于 target commit。 |
| planner-real | `evaluation/results/latest-planner-real.json` | planner 原始状态通过，且 provider mode 必须为 `real`。 |
| recovery observability | `evaluation/results/latest-recovery-observability.json` | recovery 原始状态通过并属于 target commit。 |
| runtime smoke | `evaluation/results/latest-runtime-smoke.json` | runtime smoke 原始状态通过，provider/config lineage 与发布批次一致。 |
| rollout readiness | `evaluation/results/latest-rollout-readiness.json` | readiness 为 ready，且 `sourceReports` 与它实际读取的 planner/trajectory/recovery/runtime 输入一致。 |

`latest-planner-mock.json` 不是第 9 份 required report，但它是 rollout readiness 实际读取的辅助 source；readiness 的 `sourceReports` 必须同时准确引用 mock/real planner、trajectory、recovery observability 和 runtime smoke。

所有 required reports 还必须存在、包含完整 `evidence`、`git.commitSha` 等于 target、`git.dirty=false`，并在默认 `24` 小时 freshness policy 内。未来时间戳同样会失败。任一报告缺失、过期、commit 不匹配、由 dirty worktree 生成、corpus/provider ID 或 mode 错误、public model route 错误、source report lineage 不一致，或 robust 三份报告出现 split lineage，整体状态都是 `fail`。

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

默认每次检查都会写入 `evaluation/results/latest-release-evidence.json` 和 `.md`。逐项结果包含 `status`、`reasonCode`、`expected`、`actual`、`reportType`、`runId`、`generatedAt`、`commitSha` 以及 corpus/provider 摘要，便于 CI 用稳定 reason code 判断失败原因。当前稳定 reason codes 为：`ok`、`missing_report`、`missing_lineage`、`unknown_commit`、`commit_mismatch`、`dirty_worktree`、`stale_report`、`future_report`、`invalid_generated_at`、`report_failed`、`config_hash_mismatch`、`wrong_corpus`、`wrong_provider`、`wrong_model_route`、`source_report_lineage_mismatch` 和 `robust_lineage_split`。

### 与 quality gate 的兼容边界

默认 `quality:gate` 的成本和历史语义不变：它仍兼容旧 synthetic/feedback/trajectory/planner/recovery payload，且未传 `--require-robust-suite` 时 robust gate 继续显示 pass + skipped。`quality:gate -- --require-robust-suite` 继续执行既有三报告 metrics/corpus 合同，但不追加 release lineage 要求。旧报告的 `missing_lineage`、target commit、dirty 和 freshness 只由 `release:gate` 严格拦截，因此 PR 默认 workflow 不需要真实 OpenAI，也不会下载 arXiv corpus。

## Synthetic regression

```bash
cd server
npm run eval:synthetic
npm run eval:synthetic -- evaluation/synthetic-corpus-near-duplicate.json
npm run eval:synthetic -- evaluation/synthetic-corpus-compare-hard.json
```

默认报告写入 `server/evaluation/results/latest.json` 和 `.md`。

## Robust hard/real suite

`eval:robust-suite` 是固定周期入口，不放进每个 PR 的默认轻量 gate。它集中维护 hard/real 语料集合，避免 npm scripts、CI 和 quality gate 各自硬编码：

```bash
cd server
npm run eval:robust-suite
npm run quality:gate -- --fail-on-warn --require-robust-suite
```

默认 suite 包含三层：

| Report | 语料 | 输出 | 作用 |
| --- | --- | --- | --- |
| compare-hard synthetic | `evaluation/synthetic-corpus-compare-hard.json` | `evaluation/results/latest.*` | 刷新主 synthetic regression，替代长期只看 near-duplicate。 |
| hard-CS rerank | `evaluation/synthetic-corpus-rerank-hard-cs.json` | `evaluation/results/latest-rerank-hard-cs.*` | 检查 baseline 非饱和、NDCG/Recall 不回退，并要求 NDCG 有 lift。 |
| arXiv real-paper rerank | `evaluation/generated/arxiv-corpus.json` | `evaluation/results/latest-arxiv-rerank.*` | 用固定真实论文 manifest 覆盖长文档、hard negative 和跨论文比较。 |

compare-hard synthetic 使用真实 provider，要求 `OPENAI_API_KEY`。两项 rerank eval 使用 deterministic embedding + heuristic rerank，可稳定复跑。arXiv corpus 默认会按固定 manifest 构建；本地已有缓存时可用：

```bash
cd server
npm run eval:robust-suite -- --skip-arxiv-build
npm run eval:robust-suite -- --arxiv-skip-download
```

`quality:gate -- --require-robust-suite` 会要求三份 report 都存在：synthetic report 不能有失败 case；rerank report 必须有 ranking case、语料匹配、NDCG/Recall 不回退，且 NDCG lift 不能退化成 0。未加该开关时 robust suite gate 会跳过，保持 PR gate 轻量。

## Trajectory eval

Trajectory eval 检查 AgentRAG 行为，而不是只看答案文本：

- Skill / chain 是否选对
- 证据不足时是否 follow-up
- 该澄清时是否 clarification
- Custom skill 是否传递 `accessScope`
- Budget 是否阻止无限重试
- Goal lifecycle 是否验证 plan steps、unresolved gaps、deliverables、pending approval 和 research phases

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

`planner:gate` 默认 `--provider real`，并在 real provider 下默认比较 `mock`。默认阈值为 `--max-unexpected-fallback-rate=0` 和 `--max-divergence-count=0`。Planner eval 中故意验证 validator 的 fallback case 会计入总 fallback 数，但不会计入 unexpected fallback。

## Rollout readiness

```bash
cd server
npm run rollout:readiness
npm run rollout:readiness -- --json
```

`rollout:readiness` 会读取 `latest-planner-real.json`、`latest-planner-mock.json`、`latest-trajectory.json`、`latest-recovery-observability.json` 和 `latest-runtime-smoke.json`，并检查当前 runtime 是否已经达到纯 LLM target（`AGENT_PLANNER_ROLLOUT=llm`，effective intent/execution planner 都是 `llm`），生成 `latest-rollout-readiness.*`。缺少 real planner report、runtime smoke report、runtime target 未到纯 LLM、trajectory/recovery gate 失败、runtime smoke 失败、unexpected fallback rate 大于 0，或 mock/real planner divergence 大于 0 都会标成 `not_ready`，并让命令以非零状态退出。只想生成报告时可用 `npm run rollout:readiness -- --no-fail`。

## Runtime smoke

```bash
cd server
npm run runtime:smoke
```

`runtime:smoke` 需要 `OPENAI_API_KEY` 和 `POSTGRES_DATABASE_URL` 或 `LONG_MEMORY_DATABASE_URL`。它会启动真实 Express app，走 `/health` 和两次 `/chat` HTTP 请求，不注入 deterministic planner。文档 RAG 使用 smoke stub，避免依赖上传文件和 embedding；intent/execution planner 仍走真实 LLM provider。

Smoke 断言：

- `/health` 的 `longMemory` 和 `agentExperienceMemory` 都是 `ok`，且 reason 为 `postgres_configured_default`
- 两次 `/chat` 的 `agentObservability.intentPlanner` 和 `agentObservability.executionPlanner` 都选中 `llm`，且没有 fallback
- 第一次 successful `skill_chain` 写入 `successful_plan` experience memory
- 第二次请求加载该 memory 为 planning hint
- `ragSources` 只包含 smoke document source，不包含 `agent_experience` 或 `successful_plan`

报告写入 `evaluation/results/latest-runtime-smoke.json` 和 `.md`。`Planner Real Provider Gate` scheduled workflow 会启动 PostgreSQL service，在纯 LLM planner env 下先运行这个 smoke，再运行 `rollout:readiness` 把 smoke、real/mock planner gate、trajectory 和 recovery 汇总成最终发布门。

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
- recovery/replay 指标：recoverable run 数、manual recovery 数、auto replay 成功率、step retry/resume 次数、step replay failure 数，并在同一区块展示 planner fallback count
- query planner intent、retrieval query 数量和 topK profile
- RAG route mode、latency、citation 和 abstain 指标

`eval:recovery-observability` 会用 deterministic fixture 生成 `latest-recovery-observability.*`，再由 `quality:gate` 的 recovery gate 检查：observability eval case/check 不能失败，auto replay failure、manual recovery action failure、step replay failure 和 observed planner fallback 都必须为 0，同时要求 report 至少覆盖 recoverable run、manual recovery action、auto replay attempt、step retry 和 step resume。

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

报告包含 baseline 粗排与 rerank 后的 `NDCG@k`、`Precision@k`、`Recall@k`、`MRR`、`Noise rate@k` 和排序提升率。

固定周期 gate 使用 `latest-rerank-hard-cs.*` 和 `latest-arxiv-rerank.*`，不再依赖 near-duplicate rerank 的饱和报告判断 lift。

## arXiv real-paper corpus

真实论文 rerank 评测采用固定 manifest，避免每次评测实时搜索导致语料漂移：

```bash
cd server
npm run corpus:arxiv
npm run eval:rerank -- evaluation/generated/arxiv-corpus.json --latest-name arxiv-rerank
```

当前 manifest 固定 8 篇计算机方向论文：RAG、DPR、ColBERT、HNSW、Transformer、ReAct、Toolformer、Self-RAG。当前 seed 包含 16 个标注 case，覆盖精确问答、hard negative 和跨论文比较。

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
2. `npm run eval:trajectory`
3. `npm run eval:planner -- --provider mock`
4. 如果配置了 `OPENAI_API_KEY`，再运行 `npm run eval:planner -- --provider real`
5. `npm run eval:recovery-observability`
6. `npm run eval:feedback`
7. `npm run quality:gate -- --fail-on-warn`

`Planner Real Provider Gate` workflow 通过 `workflow_dispatch` 和每日 schedule 触发。它不使用 conditional real step：会在纯 LLM planner runtime env 下强制运行 mock planner eval、real planner eval、trajectory eval、recovery observability eval，并执行 `npm run planner:gate -- --provider real --compare-provider mock --max-unexpected-fallback-rate=0 --max-divergence-count=0`、`npm run rollout:readiness` 和 `npm run runtime:smoke`。该 workflow 会启动 PostgreSQL service，让 smoke 覆盖 Postgres default-on memory 和 runtime `/chat` observability。如果没有配置 `OPENAI_API_KEY` secret，real provider eval 或 runtime smoke 会失败，从而暴露配置缺口。

`Robust Eval Suite` workflow 通过 `workflow_dispatch` 和每周一 schedule 触发。它要求 `OPENAI_API_KEY`，运行 `npm run eval:robust-suite`，再用 `npm run quality:gate -- --fail-on-warn --require-robust-suite` 强制检查 compare-hard、hard-CS rerank 和 arXiv real-paper rerank 三份 report，并上传 `latest.*`、`latest-rerank-hard-cs.*`、`latest-arxiv-rerank.*` artifacts。

`Release Evidence Gate` workflow 只通过 `workflow_dispatch` 和每周一 `0 11 * * 1` schedule 触发，明确不在 `pull_request` 上运行。它在单个 job、单次 target checkout 中设置 `EVAL_TARGET_COMMIT_SHA=${{ github.sha }}` 和 `EVAL_EVIDENCE_PROFILE=release`，依次生成 robust suite、mock/real planner、trajectory、recovery observability、runtime smoke 与 rollout readiness，再执行严格 `release:gate` 并上传 required latest JSON/Markdown 和 `latest-release-evidence.*`。这样昂贵的 real/robust 评测不会增加默认 PR gate 成本，发布 artifacts 又都绑定同一 SHA。

提交前建议至少运行：

```bash
cd server
npm test
npm run eval:trajectory
npm run eval:planner
npm run eval:recovery-observability
npm run rollout:readiness
npm run quality:gate
```
