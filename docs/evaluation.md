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
| `evaluation/results/latest-trajectory.*` | AgentRAG trajectory eval：`5/5` cases passed，`20/20` checks passed。 |
| `evaluation/results/latest-planner*.{json,md}` | AgentRAG planner eval：默认 mock provider，覆盖 LLM plan selection、validator rejection、deterministic fallback 和 planner observability；mock/real provider 会各自写入 provider-specific latest report。 |
| `evaluation/results/latest-recovery-observability.{json,md}` | AgentRAG recovery observability eval：deterministic fixture 覆盖 recoverable run、manual recovery action、safe step retry/resume、auto replay success rate 和 planner fallback signal。 |
| `evaluation/results/latest-rollout-readiness.{json,md}` | AgentRAG rollout readiness：只输出是否 ready 的信号，汇总 real planner provider gate、trajectory gate、recovery gate、unexpected fallback rate 和 mock/real planner divergence，不改变默认 planner 行为。 |
| `evaluation/results/latest-rerank-hard-cs.*` | Hard-CS rerank eval：baseline 不再满分，heuristic rerank 需要保持 NDCG/Recall 不回退并保留 NDCG lift。 |
| `evaluation/results/latest-arxiv-rerank.*` | arXiv real-paper rerank eval：使用固定 manifest 生成的真实论文 corpus，覆盖更长文档和 hard negative。 |
| `evaluation/results/latest-rerank.*` | Legacy near-duplicate rerank eval：baseline 已接近饱和，仅作历史参考。 |
| `evaluation/results/arxiv-rerank-sweep-latest.*` | arXiv real-paper quick sweep 当前最佳 variant 为 `broad_topk`，NDCG `0.5831`，Recall `0.8177`，MRR `0.5891`。 |
| `evaluation/results/compare-hard-ragas.*` | Ragas supplement：faithfulness `0.8939`，context precision `1.0`，compare rubric `0.9333`。 |

说明：仓库内旧的 `latest.*` snapshot 可能仍来自 near-duplicate；固定周期入口是 `eval:robust-suite`，它会把 compare-hard 写回 `latest.*`，并生成 hard-CS / arXiv rerank latest reports 供 `quality:gate -- --require-robust-suite` 检查。

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
