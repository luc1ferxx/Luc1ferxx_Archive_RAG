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
| `cd server && npm run eval:planner` | 用 mock LLM provider 评测 execution planner、validator 和 fallback。 |
| `cd server && npm run feedback:corpus` | 从负反馈生成 synthetic 评测语料。 |
| `cd server && npm run eval:feedback` | 用 feedback corpus 运行回归评测。 |
| `cd server && npm run quality:gate` | 检查主线、feedback 和 trajectory gate。 |
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
| `evaluation/results/latest.*` | Synthetic near-duplicate corpus：overall pass rate `1.0`，QA page hit rate `1.0`，compare doc coverage `1.0`，abstain accuracy `1.0`。 |
| `evaluation/results/latest-trajectory.*` | AgentRAG trajectory eval：`5/5` cases passed，`20/20` checks passed。 |
| `evaluation/results/latest-planner.*` | AgentRAG planner eval：默认 mock provider，覆盖 LLM plan selection、validator rejection、deterministic fallback 和 planner observability。 |
| `evaluation/results/latest-rerank.*` | Near-duplicate rerank eval：baseline 已满分，heuristic rerank 无额外 lift。 |
| `evaluation/results/arxiv-rerank-sweep-latest.*` | arXiv real-paper quick sweep 当前最佳 variant 为 `broad_topk`，NDCG `0.5831`，Recall `0.8177`，MRR `0.5891`。 |
| `evaluation/results/compare-hard-ragas.*` | Ragas supplement：faithfulness `0.8939`，context precision `1.0`，compare rubric `0.9333`。 |

说明：`latest.*` synthetic 报告来自 near-duplicate corpus，报告内 run id 为 `2026-04-21T20-42-35-142Z`；rerank 和 trajectory 报告来自 2026-06-09 到 2026-06-10 的开发进度。

## Synthetic regression

```bash
cd server
npm run eval:synthetic
npm run eval:synthetic -- evaluation/synthetic-corpus-near-duplicate.json
npm run eval:synthetic -- evaluation/synthetic-corpus-compare-hard.json
```

默认报告写入 `server/evaluation/results/latest.json` 和 `.md`。

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

真实模式需要 `OPENAI_API_KEY`，并会把结果写入 `server/evaluation/results/latest-planner.json` 和 `.md`。

## Feedback regression

```bash
cd server
npm run feedback:corpus
npm run eval:feedback
```

`feedback:corpus` 默认读取 `server/data/feedback/feedback.jsonl`，收集 `citation_error`、`incomplete` 和 `hallucination` 三类负反馈。`quality:gate` 会读取 `latest-feedback.json`；如果 feedback eval 有失败 case 或 unsupported claim，gate 会失败，并按 `skillId@skillVersion` 汇总问题。

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
3. `npm run eval:planner`
4. `npm run quality:gate -- --fail-on-warn`
5. 如果存在 `server/data/feedback/feedback.jsonl`，再运行 `npm run eval:feedback` 和一次 quality gate

提交前建议至少运行：

```bash
cd server
npm test
npm run eval:trajectory
npm run eval:planner
npm run quality:gate
```
