# 05 评测体系与实验方法

> 范围：评测体系与实验方法（server/evaluation/ 的 runner 与 gate、CI、测试组织）
>
> 回到 [总手册](../DEEP-DIVE-PLAYBOOK.md)。数字出处以 [CURRENT-TRUTH.md](../CURRENT-TRUTH.md) 和 `docs/evaluation.md` 为准；代码位置写成「路径 + 函数/常量名」，均经核验代理 grep 确认。

## 30 秒讲法

评测分三类：每个 PR 跑的确定性回归（检索真走 pgvector + hybrid RRF，但 embedding 换成 64 维哈希词频替身、模型换成确定性/mock，只证明管道和契约没坏）；真实模型效果评测（本地 Ollama nomic-embed-text + qwen2.5:7b，外部标注的 QASPER，官方 F1，配对 bootstrap 置信区间，先在 train 调参再到 dev 确认，规则提前定好）；可靠性和安全评测（故障注入、提示注入红队）。门禁是 fail-closed 的：报告必须来自同一个 commit、干净工作区、24 小时内，语料哈希、configHash、manifest 都要对上，任何一项不过，指标就标 unverified，不公开 PASS。方法上最重要的教训是：伪 embedding 给出过相反的架构结论；置信区间跨 0 就不说"更好"；对照组用来防"总是拒答"和"总是找到差异"。很多次实验的结论是"测了，不改默认"，比如门控阈值、答题率开关、按句切块。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `server/evaluation/run-retrieval-comparison.mjs` | 四臂检索对比（dense/sparse/hybrid RRF/hybrid+rerank），tuning/held-out 按源文档切分（SPLIT_DOCS）；pairedBootstrapDelta（BOOTSTRAP_RESAMPLES=2000、BOOTSTRAP_SEED=1729，mulberry32）；文件头的 HONESTY CONTRACT 要求报告标注 embedding provider |
| `server/evaluation/eval-case-helpers.js` | toDeterministicEmbedding / DETERMINISTIC_EMBEDDING_DIMENSIONS=64：确定性评测用的哈希词频替身 embedding |
| `server/evaluation/import-qasper.mjs` | convertQasperPaper：QASPER JSON 转语料，默认一个段落算一页，保留所有标注者答案（referenceAnswers），不可答题（按第一位标注者）标 shouldAbstain，证据只在图表里的（FLOAT SELECTED）丢弃、找不到可定位证据的题跳过 |
| `server/evaluation/run-qasper-retrieval-eval.mjs` | 逐题记录证据段落在 hitAt1/hitAt3/hitAtAll/admitted 的命中；--compare 时用 pairedRecallDeltas（4000 次、seed 1）算配对 CI；--min-hit-at-all 是 CI 流水线用的召回下限（低于就退出码 1），不是置信区间下限 |
| `server/evaluation/run-qasper-answer-eval.mjs` | 官方 F1 答案评测，rag 面（chat()，即 MCP archive_ask 返回的答案）和 agent 面（runAgentRag）两种；sampleQasperCases 按种子抽样；本身不算 CI |
| `server/evaluation/qasper-answer-metrics.js` | qasperAnswerF1 / toQasperPrediction（拒答记作 Unanswerable）；citedSourcePages、scoreQasperEvidence、summarizeQasperRuns 把 cited 和 context 两种证据分开（readContextEvidenceHit 兼容旧字段 evidenceHit） |
| `server/evaluation/agent-answer-outcome.js` | classifyAgentAnswer：澄清、grounded abstention 句、空答案都不算回答 |
| `server/evaluation/run-abstention-gate-analysis.mjs` | 每题只检索一次（retrieveQaCandidates），在网格上重放真实的 assessQaConfidence；computeAuc、gateCost（WRONG_ANSWER_COST=3，UNANSWERABLE_PRIOR=0.115 取自 QASPER train 的不可答比例）、pickRerankThreshold |
| `server/evaluation/run-synthetic-eval.mjs / synthetic-case-evaluator.js / synthetic-case-verdict.js` | 确定性合成回归；evaluateSyntheticCaseResponse 复用生产的 evaluateClaimSupport；evaluateSyntheticComparisonExpectation 判 no_difference / difference / abstain 三种对照 |
| `server/evaluation/run-doccompare-verification.mjs` | verify:quality：用真实模型跑 18 项端到端检查，含相同文档对照组、页码对 fixture 真值（citationPageIsHonest）、数值归属（compare.value-binding）、拒答有效性交叉检查（meta.abstention-is-discriminating）；分 blocking 和 advisory |
| `server/evaluation/trajectory/run.js、trajectory/cases/*.js、agent-eval-harness.js` | 轨迹评测：19 个用例（createDefaultTrajectoryCases），buildScopedRagService 用脚本化的 ragService 跑真实的 runAgentRag，断言的是行为而不是文本 |
| `server/evaluation/planner/run.js、planner/cases/index.js` | 规划器评测，7 个用例（createDefaultPlannerCases）；mock provider（createMockPlannerProvider）测接线，--provider real 测真实 LLM |
| `server/evaluation/run-llm-resilience-eval.mjs` | startFaultInjectingServer：本地假 OpenAI 服务，RESILIENCE_SCENARIOS 共 8 个场景，故障序列由种子固定 |
| `server/evaluation/run-prompt-injection-eval.mjs、prompt-injection-cases.js` | 红队：PROMPT_INJECTION_CASES 现有 15 个攻击用例（主测量用的 13 个 + 第一次基线后加的 2 个 evasion 用例，单独对比）加 PROMPT_INJECTION_CONTROLS 4 个对照组，分 rag 和 agent 两个出口，用金丝雀字符串或被篡改的事实判定攻击是否成功；另用 JUDGE_INJECTION_PROBES 测 claim judge 在注入下的表现 |
| `server/evaluation/eval-evidence.js、eval-evidence-validation.js` | resolveEvaluationGitState、attachEvaluationEvidence 给报告盖证据信封；getEvaluationEvidenceFailureReason 产出稳定的 reason code |
| `server/evaluation/quality-current-gate.js、quality-current-suite-manifest.js、quality-current-suite-validator.js` | PR 门 quality:current：同 SHA、干净工作区、24h（DEFAULT_CURRENT_QUALITY_MAX_AGE_HOURS）、manifest（CURRENT_QUALITY_SUITE_MANIFEST_VERSION 1.14.0）钉死 case/check id 和响应投影、钉死的 baseline |
| `server/evaluation/release-evidence-gate.js、eval-evidence-policy.js` | release:gate：完整报告集（RELEASE_EVIDENCE_REPORT_SPECS）；buildPromptLineageCheck、buildRobustLineageCheck、buildReadinessSourceCheck、buildGateWorktreeCheck |
| `server/evaluation/baselines/quality-near-duplicate-deterministic-v1.json` | PR 门唯一接受的确定性回归基线 |
| `server/evaluation/run-llm-judge.mjs、run-claim-judge-eval.mjs` | LLM 评审：measureJudgeAgreement 对人工标签算一致率和 Cohen's kappa 的框架（还没在真实数据上跑）；claim judge 在构造的对照集（CLAIM_JUDGE_CONTRAST_SET、CLAIM_JUDGE_HELD_OUT_SET）上做校准 |
| `.github/workflows/quality-gate.yml、real-model-eval.yml、release-evidence.yml、planner-real-gate.yml、robust-eval-suite.yml` | PR 三个并行 job；每周一用 Ollama 跑真实模型（不需要 key）；每周一（或手动）跑发布证据（需要 OPENAI_API_KEY）；真实规划器门（需要 key）；robust suite 手动诊断 |
| `server/test/run.test.mjs、coverage-gate.mjs、coverage-policy.mjs、ci-workflow.test.mjs` | 测试文件自动发现（collectTestFiles），每个文件一个子进程；CI 只跑一遍 coverage:gate；ci-workflow.test.mjs 钉死 workflow 和两处发现逻辑一致，并断言 quality-gate.yml 里不出现 OPENAI_API_KEY |
| `server/test/langgraph-support/graph-goldens.mjs、test/fixtures/graph-goldens/` | 删除原生调度器前冻结的 golden，8 个套件、102 个文件、约 5.3 MB；只有 UPDATE_GRAPH_GOLDENS=1 能改写，改写后本次测试仍判失败 |

## 一次请求怎么经过这里

A. 一次 PR（.github/workflows/quality-gate.yml 的 quality-gate job，带 pgvector/pgvector:pg16 服务，VECTOR_STORE_PROVIDER=pgvector、RAG_HYBRID_ENABLED=true、RAG_HYBRID_FUSION=rrf）：
1) npm run eval:synthetic -- evaluation/synthetic-corpus-near-duplicate.json --latest-name latest-quality --openai-provider deterministic：run-synthetic-eval.mjs 先用 configureOpenAIProvider 换成替身（toDeterministicEmbedding，64 维哈希词频；回答也是确定性替身），再 ingestDocument → chat() → evaluateSyntheticCaseResponse（内部调 evaluateClaimSupport、evaluateSyntheticComparisonExpectation）→ attachEvaluationEvidence 盖信封：resolveEvaluationGitState 取 commitSha/dirty，另有语料 contentHash、configHash、promptTemplates。
2) eval:trajectory：runTrajectoryEvaluation 先用 withEnvironmentOverrides 把 AGENT_UNIFIED_GRAPH_ROLLOUT 固定为 off（并关掉经验记忆和长期记忆），再逐个跑 case（runTrajectoryCaseSafely）：buildScopedRagService 脚本化 chat，真实 runAgentRag，buildCheck 断言 trace、预算和作用域。
3) eval:planner --provider mock：runPlannerEvaluation → configureOpenAIProvider(createMockPlannerProvider())。
4) eval:recovery-observability、eval:feedback。
5) quality:current（check-current-quality.mjs）：resolveEvaluationGitState → readCurrentQualityInputs → buildCurrentQualityGateReport，其中 getGateWorktreeReason 检查门禁自身的 checkout；validateCurrentQualitySuiteReport 对照 manifest；getEvaluationEvidenceFailureReason 逐份检查 SHA、dirty、未来时间戳、24h、configHash、语料、provider、profile、modelRoute、semanticCache；baseline 必须是 quality-near-duplicate-deterministic-v1。全部通过才公开 metrics，否则标 unverified。最后上传 artifacts。

B. 离线效果评测（本地 Ollama，或每周的 real-model-eval.yml，后者用 local 向量库、不连数据库）：
- import-qasper.mjs 的 convertQasperPaper 生成语料。
- 检索：run-qasper-retrieval-eval.mjs：sampleQasperCases → retrieveQaCandidates → assessQaConfidence → hitAt1/hitAt3/hitAtAll/admitted；带 --compare 时调 pairedRecallDeltas。
- 答案：run-qasper-answer-eval.mjs：chat() 或 runAgentRag（agent 面用 classifyAgentAnswer 判断是否回答）→ toQasperPrediction → qasperAnswerF1 → citedSourcePages + scoreQasperEvidence → summarizeQasperRuns。
- 门控：run-abstention-gate-analysis.mjs，每题检索一次 → 在网格上重放 assessQaConfidence → computeAuc / gateCost / pickRerankThreshold。
- 检索对比：run-retrieval-comparison.mjs，每个 route 跑一次 runRerankEvaluation → pairedBootstrapDelta。

C. 发布（release-evidence.yml，每周一或手动，第一步要求 OPENAI_API_KEY 非空）：test:pgvector → eval:robust-suite → robust:gate --fail-on-warn → planner（mock 和 real）、trajectory、recovery、runtime:smoke、rollout:readiness → release-evidence-gate.js 的 buildReleaseEvidenceReport（buildGateWorktreeCheck、buildRobustLineageCheck、buildPromptLineageCheck、buildReadinessSourceCheck）。

## 设计决策

### D1. PR 门只用确定性和 mock 两种 provider；真实模型放到每周（Ollama）和手动/每周的发布门

**为什么**

PR 要快、免费、不受外部抖动影响；quality-gate.yml 里不出现 OPENAI_API_KEY（ci-workflow.test.mjs 用 assert.doesNotMatch 钉住），key 失效或限流不会挡住普通提交；检索路由本身仍在真 pgvector 上跑 hybrid RRF

**为什么不用主流替代方案**

每个 PR 都跑真实模型或 LLM 评分（Ragas/DeepEval/promptfoo 在线评测）：贵、慢、结果不稳定；Planner Real Gate 就因为 secret 失效从 2026-09-20 起每天失败，放在 PR 上会挡住所有合并

**代价**

PR 绿只说明管道和契约没回归，不说明效果；效果退化最长要等一周的真实模型 CI 才发现

**证据**

伪 embedding 下 hybrid 0.543 < BM25 0.658，真实 embedding 下 hybrid 0.712 最高（CURRENT-TRUTH §3.1，48 条用例）；key 失效（CURRENT-TRUTH §3.13）

**代码**：.github/workflows/quality-gate.yml quality-gate job；server/evaluation/eval-case-helpers.js toDeterministicEmbedding；server/test/ci-workflow.test.mjs

### D2. 所有臂之间的差异都用配对 percentile bootstrap，种子固定（mulberry32）；run-retrieval-comparison 里显著性（excludesZero）按未四舍五入的上下界判定

**为什么**

两臂回答的是同一批题，配对能去掉题目难度带来的方差；种子固定后，同样的逐题指标总得到同一个区间，报告可以复现；四舍五入造不出显著

**为什么不用主流替代方案**

只比均值：48 条用例上 +0.057 看着像赢，其实区间跨 0。t 检验：要假设分布，0/1 指标、样本小时不合适。McNemar 对二元配对也合理，但没有实现

**代价**

按题重采样，没有按论文做 cluster bootstrap；没有多重比较校正；excludesZero 只有 pairedBootstrapDelta 有，pairedRecallDeltas 只输出四舍五入后的 ci95；各脚本的重采样次数和种子不一致（2000/4000，种子 1729/1/20260927，文档里还用过 5000/10000）；mulberry32 PRNG 在 9 个文件里各写了一份，配对 bootstrap 至少有 5 份独立实现（pairedBootstrapDelta、pairedRecallDeltas、pairedMeanDelta、run-layout-parsing-eval 的 pairedDelta、bootstrapMeanInterval）

**证据**

48 条：hybrid−dense +0.057 [−0.031,+0.156] 不显著；QASPER dev 821 题：hybrid−dense +0.006 [−0.019,+0.031] 不显著，hybrid−BM25 +0.074 [+0.048,+0.102] 显著（CURRENT-TRUTH §3.1）

**代码**：server/evaluation/run-retrieval-comparison.mjs pairedBootstrapDelta / createSeededRandom / BOOTSTRAP_RESAMPLES / BOOTSTRAP_SEED；server/evaluation/run-qasper-retrieval-eval.mjs pairedRecallDeltas

### D3. 效果主评测用外部标注的 QASPER 和官方 token F1（取所有标注者里的最大值，拒答记作 Unanswerable），不用 LLM 评分

**为什么**

标注是外部的，评分器确定、可复现，口径和公开评测器一致；LLM 评审没经过人工校准就不能引用

**为什么不用主流替代方案**

Ragas faithfulness 或 LLM-as-judge：没校准，自评还有偏；继续只用自建的 48 条：样本太小，区间几乎都跨 0

**代价**

token F1 惩罚长答案，不能和抽取式排行榜比；QASPER 主评测是从 JSON 文本导入的，没有经过 PDF 解析器（版面解析评测另用 30 篇 QASPER 论文的 PDF 走过解析器）；证据只取第一位标注者；89 道证据只在图表里的题被跳过

**证据**

dev 转换后 916 题：821 可答、95 不可答、89 跳过（docs/evaluation.md「QASPER：外部标注的检索和答案评测」）

**代码**：server/evaluation/import-qasper.mjs convertQasperPaper；server/evaluation/qasper-answer-metrics.js qasperAnswerF1 / toQasperPrediction

### D4. 证据召回拆成 citedEvidenceRecall（答案 [Source N] 实际引用的页）和 contextEvidenceRecall（模型看到的上下文）

**为什么**

QA 路径会把每个上下文块都当 citation 返回，旧的 evidenceRecall 测的其实是检索加上下文大小，被误写成了「答案来源里有证据」

**为什么不用主流替代方案**

继续沿用一个 evidenceRecall：会把检索的改进说成引用的改进

**代价**

旧报告没有保存引用页，以前改动对引用有多大影响已经算不出来；旧的 evidenceHit 只能和新的 contextEvidenceHit 配对

**证据**

同 200 题、作答时：context 0.596 vs cited 0.490，差 −0.106 [−0.164,−0.048] 显著；引用精度 0.321（docs/evaluation.md「引用证据：答案实际引用的页（2026-10-04）」）

**代码**：server/evaluation/qasper-answer-metrics.js citedSourcePages / scoreQasperEvidence / summarizeQasperRuns / readContextEvidenceHit

### D5. 门控调参：离线重放，每题只检索一次，在阈值网格上重放真实的 assessQaConfidence；选值按事先定好的代价规则，不在 dev 上挑最高 F1

**为什么**

不调 chat 模型，成本低；代价规则把「错答一次相当于拒答 3 次」写成显式的产品取舍；dev 只用来确认

**为什么不用主流替代方案**

直接在 dev 上选 F1 最高的阈值：dev 就不再独立了。Youden J 最优：错答和拒答被当成等价

**代价**

k=3 是人定的产品取舍，不是测出来的；p=0.115 是 QASPER train 上不可答题的比例，换数据就要重算；这个信号本身区分力弱，调阈值只是在两种错误之间换

**证据**

AUC 只有 0.59–0.60；按规则在 train 上该选 0.2，但 dev F1 0.206→0.153，−0.053 [−0.101,−0.009] 显著变差，另有 5 个相邻话题行为测试翻转，所以默认维持 0.51（CURRENT-TRUTH §3.12；docs/evaluation.md「拒答门控调参（QASPER train → dev）」）

**代码**：server/evaluation/run-abstention-gate-analysis.mjs gateCost / WRONG_ANSWER_COST / UNANSWERABLE_PRIOR / pickRerankThreshold / computeAuc；server/rag/confidence.js assessQaConfidence；server/rag/config.js DEFAULT_MIN_QA_QUERY_TERM_COVERAGE

### D6. 事先定规则（采纳条件、非劣性下界、护栏），train 调、dev 确认，看到结果后不改规则

**为什么**

防止事后挑指标；很多次「测了不改默认」都由此而来

**为什么不用主流替代方案**

边看结果边调：结论会贴合样本，不可信

**代价**

慢，而且结果常常是「不改」；同一组 dev 200 题（seed 1）反复用于多轮实验，agent 面的 dev seed 1（100 题）文档里也已注明用过、以后要换新样本

**证据**

按句切块：train +0.040 [0.005,0.075]，dev +0.004 [−0.017,0.026]，没复现，前三名命中 −0.027 [−0.050,−0.004] 显著更差（CURRENT-TRUTH §3.27）；答题率三轮都没过规则（CURRENT-TRUTH §3.21）

**代码**：server/evaluation/run-qasper-answer-eval.mjs sampleQasperCases（--seed）；规则本身写在 docs/evaluation.md，不在代码里

### D7. 端到端和合成评测都放对照组：相同文档必须判「没有差异」，语料外的问题必须拒答；拒答检查只有在回答路径真的产生了答案时才算数

**为什么**

总是拒答的系统会通过所有拒答检查，总是找差异的系统会通过所有对比检查

**为什么不用主流替代方案**

只放正例：宽松的评分器比没有评分器更糟，因为它报告成功

**代价**

合成评测判分复用了生产的 evaluateClaimSupport，和被测系统有共同盲点；verify:quality 里对比题能通过，是靠引擎的模板兜底，不是模型自己的改写

**证据**

verify:quality 从 16/18 修到 18/18（CURRENT-TRUTH §3.2）；第一版软换行规则让相同文档对照组误报差异，被抓到（NARRATIVE 故事 6）

**代码**：server/evaluation/synthetic-case-verdict.js evaluateSyntheticComparisonExpectation；server/evaluation/synthetic-case-evaluator.js evaluateSyntheticCaseResponse；server/evaluation/run-doccompare-verification.mjs record / citationPageIsHonest

### D8. 轨迹评测：脚本化的 ragService 加真实的 runAgentRag，断言行为（选了哪个 Skill、自检先失败后通过、补检索次数、预算、accessScope、审批），不看文本

**为什么**

Agent 编排的正确性是确定性契约，应该每个 PR 都跑，并且不受模型随机性影响

**为什么不用主流替代方案**

用 LLM 评审给轨迹打分：没校准，也测不准预算、作用域这类硬约束；LangSmith：项目里任何 LangSmith 追踪变量为 "true" 都拒绝启动（LangChain 的 tracer 会把问题、prompt、文档正文发给第三方），所以也不会用它的评测

**代价**

只证明编排契约，不证明模型规划能力；每个 case/check id 和响应投影都钉在 manifest 里，加用例或改名就要升版本

**证据**

eval:trajectory 19/19（CURRENT-TRUTH §3.30）；真实模型规划另测：动态组合只有 2/5（§3.5），统一图规划被接受 3/15（§3.17）

**代码**：server/evaluation/trajectory/run.js runTrajectoryEvaluation；server/evaluation/agent-eval-harness.js buildScopedRagService；server/evaluation/trajectory/cases/core-flow.js createFollowUpCase

### D9. 给报告加证据谱系：同一个 SHA、干净工作区（porcelain -z，含 untracked，rename/copy 的源和目标都查，只放过受控的 generated/ 和 results/ 输出）、24h 内、没有未来时间戳、语料 contentHash、configHash 重算、provider/profile/modelRoute 对上、semanticCache 不能开；有任何一项不过，指标就是 unverified

**为什么**

防止误用：旧报告、脏工作区、换了语料或配置、缓存答案都可能冒充当前 commit 的证据

**为什么不用主流替代方案**

信 latest.json 或 CI 绿勾：旧报告能顶替；Sigstore/in-toto 签名：威胁模型不包括恶意 producer，没做

**代价**

不是密码学 attestation，evidence.command 是声明字段；manifest 有 2215 行，维护成本高

**证据**

无实测（这是契约设计）；有 test/quality-current-gate.test.mjs、test/release-evidence-gate.test.mjs、test/eval-evidence.test.mjs 单测

**代码**：server/evaluation/eval-evidence.js resolveEvaluationGitState；server/evaluation/eval-evidence-validation.js getEvaluationEvidenceFailureReason；server/evaluation/quality-current-gate.js buildCurrentQualityGateReport / getGateWorktreeReason

### D10. release:gate 另加 prompt 谱系检查（所有报告的 promptTemplates.setHash 相同）和 robust 谱系检查（三份 robust 报告同 commit、同 suite runId、同 configHash，且 configHash 等于从代码里的权威 suite 计划 buildRobustSuiteExecutionPlan 重算的值）

**为什么**

防止把两套 prompt、两个批次的结果拼成一次发布证据

**为什么不用主流替代方案**

每份报告单独过：每份都会自报 PASS，拼起来却不是同一个系统

**代价**

本机产不出完整的发布证据：compare-hard（要求 8/8，qwen2.5:7b 上一次 6/8）、planner-real、runtime-smoke、rollout-readiness 需要 GPT 级模型和 OPENAI_API_KEY，本机没有；Release Evidence Gate 用的 OPENAI_API_KEY secret 就是 2026-09-20 起被 OpenAI 拒绝的那一个，文档里没有它在 CI 上通过的记录

**证据**

docs/adr/0001-langgraph-runtime.md 阶段 5「发布证据」；CURRENT-TRUTH §3.13

**代码**：server/evaluation/release-evidence-gate.js buildPromptLineageCheck / buildRobustLineageCheck / buildReadinessSourceCheck

### D11. 可靠性：本地假 OpenAI 服务注入故障，故障序列由种子固定，按 SLO 统计成功率、每次调用的请求数和 p50/p95

**为什么**

可复现，不花钱；覆盖托管 API 的真实故障，也覆盖自托管服务饱和

**为什么不用主流替代方案**

在真实 provider 上做混沌测试：不可复现，还要花钱；单测 mock：测不出排队和重试叠加

**代价**

并发交错每次不同，小差异算噪声；评测里备用模型和主模型共用一个限流器，这是 failover 的最坏情况

**证据**

429：79.2%→100%（无备用模型时精确 retry-after 场景 83.3%）；主模型宕机：0→100%；代价是限流时 p95 2.5s→4.7s（CURRENT-TRUTH §3.4）

**代码**：server/evaluation/run-llm-resilience-eval.mjs RESILIENCE_SCENARIOS / startFaultInjectingServer

### D12. 提示注入红队：按最终答案里的金丝雀（或被篡改的事实）判定攻击是否成功，分 rag 和 agent 两个出口，带对照组；良性语料零误判写成回归测试

**为什么**

衡量用户或 MCP 客户端实际拿到了什么；对照组用来测防护有没有误伤

**为什么不用主流替代方案**

第三方基准 BIPIA/AgentDojo/garak：没接，算未做项，不是因为更差

**代价**

用例是自建的，筛查规则也是对着这些用例写的，同一个集合上测量偏乐观；agent 出口的 0/39 很大程度是答案被澄清扣下了

**证据**

rag 出口 17/39→0/39；刻意改写在 rag 出口改前改后都是 3/3 成功；16,001 句良性语料误判 0（CURRENT-TRUTH §3.10；docs/evaluation.md「Prompt 注入红队」）

**代码**：server/evaluation/run-prompt-injection-eval.mjs summarizeSurfaceRuns；server/evaluation/prompt-injection-cases.js PROMPT_INJECTION_CASES / PROMPT_INJECTION_CONTROLS

### D13. 测试组织：自动发现 test/*.test.mjs，每个文件一个子进程；CI 只跑一遍 coverage:gate，由 ci-workflow.test.mjs 钉死两处发现逻辑一致；删除原生调度器之前，先把 native 一侧的行为冻结成 golden

**为什么**

新套件放进目录就会被跑，各文件之间不串状态；用冻结的 golden 代替两套调度器长期并跑

**为什么不用主流替代方案**

Jest 快照的 --updateSnapshot：一键更新会掩盖行为变化，这里改写后本次测试仍然判失败；继续保留两套调度器并跑：维护面大

**代价**

golden 只覆盖固定场景，不能证明任意图形状都等价；golden 在 Node 24 上生成，CI 用 Node 22，还没验证；CI 日志要等全部跑完才有 stdout

**证据**

3,250 个测试：3,235 通过、15 跳过、0 失败，全局行覆盖 90.46%；102 个 golden 文件（CURRENT-TRUTH §3.30）

**代码**：server/test/run.test.mjs collectTestFiles；server/test/coverage-gate.mjs TEST_FILE_EXCLUDES；server/test/langgraph-support/graph-goldens.mjs isUpdatingGraphGoldens / assertMatchesGraphGolden

### D14. 真实模型 CI：GitHub CPU runner 上跑 Ollama（不需要 key，钉 OLLAMA_VERSION 0.40.3），verify:quality 和 QASPER 召回下限 0.6 是阻断项，答案 F1 只报告

**为什么**

不需要付费 key，用的是和本机测数字时同一套模型栈；钉住版本，避免上游升级悄悄改变结果

**为什么不用主流替代方案**

托管 API：key 会失效、要花钱；答案 F1 也做阻断：CPU 上约一分钟一题，样本小、噪声大

**代价**

下限 0.6 只是回归地板，不是质量结论；约 63 分钟一次，只能每周跑；这个 job 用 VECTOR_STORE_PROVIDER=local、不连数据库，真实模型 CI 不覆盖 pgvector / PostgreSQL BM25 路径

**证据**

首次运行（run 36229084695）：18/18、候选召回 0.655，和本机一致；10 题 F1 0.164，只作报告（CURRENT-TRUTH §3.14）

**代码**：.github/workflows/real-model-eval.yml；server/evaluation/run-qasper-retrieval-eval.mjs --min-hit-at-all

## 追问阶梯

按面试官的追问顺序排。先自己出声答一遍，再看要点。⚠ 是这题最容易答错或夸大的地方。

### Q1. 你的评测体系怎么分层？伪 embedding 在里面干什么？

*L1 是什么*

- 三类：PR 确定性回归、真实模型效果评测、可靠性和安全评测
- 效果层（真实模型）：检索（Recall/hitAt）、门控（离线重放）、答案（QASPER 官方 F1 + cited/context 证据）、端到端（verify:quality 18 项）
- 契约层（mock/脚本化）：轨迹（19 个用例）、规划（7 个用例，mock；--provider real 才测真实模型）
- 伪 embedding 是 64 维哈希词频向量，确定、免费，只用来测管道和契约
- 门禁两档：quality:current 管 PR，release:gate 管完整发布批次（robust:gate 只看三份 robust 报告）

代码：`server/evaluation/eval-case-helpers.js toDeterministicEmbedding`；`server/evaluation/quality-current-gate.js CURRENT_QUALITY_REPORT_SPECS`；`server/evaluation/release-evidence-gate.js buildReleaseEvidenceReport`

> ⚠ 把 PR 绿说成「质量过关」。安全说法：PR 门只证明管道和契约没回归，效果结论只来自真实模型 + 外部标注 + 置信区间。

### Q2. 伪 embedding 给过你错误结论吗？（追问：那真实 embedding 证明 hybrid 更好了吗？）

*L2 为什么*

- 伪 embedding 下 hybrid 0.543 < BM25 0.658；换成真实 nomic 后 hybrid 0.712 最高，排序反过来
- 但 48 条用例上 hybrid−dense +0.057 [−0.031,+0.156]，不显著
- 放到 QASPER dev 821 题：hybrid 只显著优于 BM25（+0.074），和 dense 比不显著（+0.006）
- 所以只能说「比单用 BM25 好，从不显著更差」

代码：`server/evaluation/run-retrieval-comparison.mjs pairedBootstrapDelta`；`server/evaluation/run-retrieval-comparison.mjs SPLIT_DOCS`

> ⚠ 说「hybrid 比 dense 好」。QASPER 上这个差异不显著，要主动说出来。

### Q3. 为什么 PR 门禁不跑真实模型？那效果退化了怎么办？

*L2 为什么*

- 成本、速度、外部抖动；quality-gate.yml 里不出现 OPENAI_API_KEY，ci-workflow.test.mjs 钉住
- 真实例子：Planner Real Gate 因为 secret 失效每天失败，放在 PR 上会堵住所有合并
- 真实模型放在每周的 real-model-eval.yml：Ollama、不需要 key、钉 Ollama 0.40.3、下载失败会重试
- 阻断项是 verify:quality 和 QASPER 召回 ≥0.6；答案 F1 只报告

代码：`.github/workflows/quality-gate.yml`；`.github/workflows/real-model-eval.yml`；`server/evaluation/run-qasper-retrieval-eval.mjs --min-hit-at-all`

> ⚠ 被追问退化窗口时含糊过去。如实说最长一周（也可以手动触发）；可以改进的是对改动 rag/ 的 PR 按路径触发一个小样本真实模型 job（还没做）。

### Q4. 配对 bootstrap 具体怎么做？为什么不用 t 检验，或者直接比均值？

*L2 为什么*

- 逐题算差值，有放回重采样题目 B 次求均值，取 2.5%/97.5% 分位
- 配对去掉题目难度方差；同一题的两个结果一起重采样
- mulberry32 固定种子，报告可复现；run-retrieval-comparison 的 excludesZero 按未四舍五入的上下界判定（pairedRecallDeltas 只给四舍五入后的 ci95）
- 指标是 0/1 或有界的、样本小，bootstrap 不需要正态假设；直接比均值看不到噪声

代码：`server/evaluation/run-retrieval-comparison.mjs pairedBootstrapDelta / createSeededRandom / BOOTSTRAP_RESAMPLES`；`server/evaluation/run-qasper-retrieval-eval.mjs pairedRecallDeltas`

> ⚠ 说「bootstrap 更准」。安全说法：它假设更少；二元配对用 McNemar 也合理，但没有实现。

### Q5. citedEvidenceRecall 和 contextEvidenceRecall 有什么区别？（追问「上下文」：你以前报的数字是哪个？）

*L2 为什么*

- context：模型看到的上下文里有没有标注证据；QA 路径把每个上下文块都当 citation 返回
- cited：答案的 [Source N] 解析到的页里有没有证据；拒答不算引用任何页
- 同 200 题作答时：0.596 vs 0.490，差 −0.106 [−0.164,−0.048] 显著；11 题证据在上下文里，答案却没引用
- 以前写的「答案来源里有证据」其实是 context 指标，已经逐处更正、改名

代码：`server/evaluation/qasper-answer-metrics.js citedSourcePages / scoreQasperEvidence / summarizeQasperRuns`

> ⚠ 把 0.321 的引用精度说成错引率。标注每题只有一两段，标注之外的引用不一定是错引。改动对引用的影响也算不出来，因为旧报告没存引用页。

### Q6. 为什么不用 Ragas 或 LLM-as-judge 打分？

*L3 为什么不用 X / 怎么证明*

- 没有人工标注校准的评审分数不引用；eval:judge 只有框架（对人工标签算一致率和 kappa），还没跑过真实数据
- 选外部标注的 QASPER + 官方 F1：确定、可复现
- Ragas 只是补充观察，不作结论
- claim judge 只在构造的对照集上校准过：错误接受 0/54，但见过结论和自己的理由矛盾，所以只能升级不能降级，默认关闭

代码：`server/evaluation/run-llm-judge.mjs JUDGE_VERDICTS / measureJudgeAgreement`；`server/evaluation/run-claim-judge-eval.mjs CLAIM_JUDGE_CONTRAST_SET`；`server/evaluation/qasper-answer-metrics.js qasperAnswerF1`

> ⚠ 拿 F1 0.25 去和排行榜比。token F1 惩罚长答案，只用于同一系统前后版本之间比较。

### Q7. 为什么自己写评测框架，不用 LangSmith、promptfoo 或 DeepEval？

*L3 为什么不用 X / 怎么证明*

- 断言大多落在运行时内部状态：拒答、页级引用、多文档数值归属、accessScope、预算、审批续跑
- LangSmith 在项目里被强制禁止：追踪变量为 "true" 就拒绝启动，因为 LangChain 的 tracer 会把问题、prompt、文档正文发给第三方
- 证据谱系要接自己的 prompt registry（setHash）和语料哈希
- 代价：manifest 2215 行、每改一个用例都要升版本（现 1.14.0）、mulberry32 在 9 个文件里各一份、配对 bootstrap 至少 5 份独立实现

代码：`server/evaluation/quality-current-suite-manifest.js CURRENT_QUALITY_SUITE_MANIFEST_VERSION`；`server/evaluation/eval-evidence.js attachEvaluationEvidence`；`server/rag/langgraph/langsmith-guard.js LANGSMITH_TRACING_VARIABLES`

> ⚠ 贬低现成工具。安全说法：它们适合做 prompt 层回归；重做的话会把统计和报告抽成共享模块，prompt 层可以接 promptfoo。

### Q8. 门控阈值怎么调的？（追问：k=3 是怎么来的？）

*L3 为什么不用 X / 怎么证明*

- 每题只检索一次，在网格上重放真实的 assessQaConfidence，不调大模型
- 事先定的规则：cost=(1−p)(1−放行)+3p(1−拦截)，p=0.115（QASPER train 的不可答比例），最低代价 +0.01 以内取最保守
- 按规则该选 0.2，但相邻话题测试会翻转，dev F1 −0.053 显著变差 → 维持 0.51
- AUC 0.59–0.60，调阈值只是在两种错误之间换

代码：`server/evaluation/run-abstention-gate-analysis.mjs gateCost / WRONG_ANSWER_COST / UNANSWERABLE_PRIOR / computeAuc`；`server/rag/confidence.js assessQaConfidence`；`server/rag/document-rag-execution.js retrieveQaCandidates`

> ⚠ 说 k=3 是测出来的。它是产品取舍（一次错答约等于三次拒答）；p 是 train 上数出来的。报告列出每档阈值的放行率和拦截率，换 k 可以自己重算代价。

### Q9. 你说「事先定规则」，举个规则让你放弃改进的例子？（追问：那不是白做了？用户体验呢？）

*L3 为什么不用 X / 怎么证明*

- 第二轮 dev 100 题：答题率 0→0.363，+0.363 [0.264,0.462]，F1 也显著上升
- 但不可答题被回答 0/9→2/9，超过了事先定的「基线+1」上限 → 不改默认
- 补跑护栏：verify:quality 14/18，拒答标记误触发
- 第三轮在 train 上就出现 1/7 不可答被回答，直接停
- 如实说：默认 Agent 路径在 7B 上几乎不答（train 0/41），宁可拒答也不编造；瓶颈是词法校验和 7B 模型

代码：`server/evaluation/agent-answer-outcome.js classifyAgentAnswer`；`server/evaluation/run-qasper-answer-eval.mjs sampleQasperCases`

> ⚠ 说「0/9→2/9 显著」。区间 [0,0.556] 含 0，是触发了事先定的上限，不是显著。也不要回避答题率低是一个真实的产品问题。

### Q10. 轨迹评测全是 mock，怎么证明 Agent 真的好用？

*L3 为什么不用 X / 怎么证明*

- 脚本化 ragService 加真实 runAgentRag，证明的是编排契约：Skill 选择、补检索、预算、作用域、审批
- 模型能力单独测：planner real 通过 24/30、LLM 规划降级 2/25（8%）；动态组合 2/5；统一图规划被接受 3/15
- recovery 评测用的是同一个内存 store，不证明 OS 重启和 PG 持久化；PG 跨进程由集成测试证明
- manifest 钉死 case/check id 和响应投影

代码：`server/evaluation/trajectory/run.js runTrajectoryEvaluation`；`server/evaluation/agent-eval-harness.js buildScopedRagService`；`server/evaluation/planner/run.js runPlannerEvaluation`

> ⚠ 说「19/19 说明 Agent 质量好」。它只说明在脚本化输入下编排行为符合契约。

### Q11. verify:quality 18/18 会不会是评测太宽松？

*L3 为什么不用 X / 怎么证明*

- 防「总是拒答」：只有回答路径真的产生了答案，拒答检查才算数（meta.abstention-is-discriminating 本身是一项检查）
- 防「总是找差异」：相同文档对照组里编造差异就算失败
- 页码对照 fixture 真值，不只检查有没有页码
- 措辞类检查是 advisory，不会让整次运行失败

代码：`server/evaluation/run-doccompare-verification.mjs record / citationPageIsHonest`；`server/evaluation/synthetic-case-verdict.js evaluateSyntheticComparisonExpectation`

> ⚠ 不说清对比题是怎么过的。主动讲：靠引擎模板兜底，模型自己的改写仍被词法校验拒；18/18 是纯 RAG 路径，不经过 Agent 自检；合成判分复用了生产 claim checker。

### Q12. quality:current 怎么防止拿旧报告或脏工作区的报告冒充？门禁本身谁来测？

*L3 为什么不用 X / 怎么证明*

- 每份报告都要对上：SHA、dirty、24h、未来时间戳、configHash 重算、语料哈希、provider、profile、modelRoute、semanticCache 关闭
- 门禁执行时，checkout 自己也必须是目标 SHA 且干净
- 引用必须绑定本次的原始 retrievedContexts，claim support 从版本化语料重算；有一项不过，指标就是 unverified
- 门禁本身有 quality-current-gate 和 release-evidence-gate 的单测，ci-workflow.test.mjs 钉死 workflow

代码：`server/evaluation/eval-evidence-validation.js getEvaluationEvidenceFailureReason`；`server/evaluation/quality-current-gate.js getGateWorktreeReason`；`server/test/ci-workflow.test.mjs`

> ⚠ 说「防伪造」。它防的是误用，不是密码学 attestation；evidence.command 是声明字段，恶意 producer 能绕过。

### Q13. 测试怎么组织的？删掉原生调度器之后，怎么证明行为没变？

*L3 为什么不用 X / 怎么证明*

- 自动发现，每个文件一个子进程，进程级状态不会串；CI 只跑一遍 coverage:gate
- 删除前把 native 一侧冻结成 golden：8 个套件、102 个文件
- 只有 UPDATE_GRAPH_GOLDENS=1 能改写，改写后本次测试仍判失败，必须写明行为变化再重跑
- 52 个调度契约测试直接跑在 LangGraph 执行器上，断言一条没改

代码：`server/test/run.test.mjs collectTestFiles`；`server/test/langgraph-support/graph-goldens.mjs isUpdatingGraphGoldens / assertMatchesGraphGolden`

> ⚠ 说「golden 证明完全等价」。它只覆盖固定场景；golden 在 Node 24 上生成，Node 22 还没验证。

### Q14. 你的置信区间可信吗？有什么统计上的问题？（追问「显著」）

*L4 边界 / 规模 / 重做*

- 按题重采样，没有按论文 cluster：200 题来自 139 篇论文，区间可能偏窄（这是读代码得出的判断，没有量过）
- 同一组 dev 200 题（seed 1）做了很多轮实验，没有做多重比较校正
- 区间不含模型采样噪声：同配置重跑 F1 −0.007 [−0.018,+0.002]
- 答题率实验用回放代理让各组共用同一次抽样，但代理是一次性脚本，不在仓库里
- 不可答题只有 20 道（17/20 被识别），拒答召回的区间会很宽（按样本量推断）

代码：`server/evaluation/run-qasper-retrieval-eval.mjs pairedRecallDeltas`；`server/evaluation/run-retrieval-comparison.mjs pairedBootstrapDelta`

> ⚠ 硬说「bootstrap 很稳」。应该主动把 cluster、多重比较、dev 复用这三点说出来。

### Q15. 提示注入 0/39，能说防住了吗？

*L4 边界 / 规模 / 重做*

- 不能：主测量是自建的 13 个攻击用例 × 3 轮，攻击方式公开，筛查规则也是对着这些用例写的；代码里另有 2 个基线后加的 evasion 用例单独对比
- 刻意改写在 rag 出口上改前改后都是 3/3 成功（agent 出口 3/3 → 1/3）
- agent 出口的 0/39 很大程度是答案被澄清扣下了
- 对照组正确率 9/12 不变；良性语料 16,001 句误判 0
- 没测过 BIPIA、AgentDojo

代码：`server/evaluation/run-prompt-injection-eval.mjs summarizeSurfaceRuns`；`server/evaluation/prompt-injection-cases.js PROMPT_INJECTION_CASES / PROMPT_INJECTION_CONTROLS`

> ⚠ 说「注入防护 100%」。安全说法：已知写法被挡住了，挡不住有针对性的改写。

### Q16. 评测规模放大 100 倍（几万题、多个模型、天天跑）怎么办？

*L4 边界 / 规模 / 重做*

- 检索和门控评测本来就不调 chat 模型，可以直接扩
- 答案评测：并行，把回放缓存产品化并入仓；固定一个小 smoke 子集每个 PR 跑，全量每周跑
- 统计：按论文 cluster bootstrap、预注册主指标、Holm/BH 校正、dev 样本轮换
- 先人工标注一小批，校准 LLM 评审（算 kappa），过关后再用评审扩规模
- 报告按 SHA 入库，做趋势看板；release 证据用 GPU 或托管模型跑

代码：`server/evaluation/run-abstention-gate-analysis.mjs`；`server/evaluation/run-llm-judge.mjs`

> ⚠ 承诺「用 LLM 评审跑十万题」。评审没校准就不能引用。

### Q17. 如果重做评测体系，你改什么？

*L4 边界 / 规模 / 重做*

- 先做外部标注的真实数据，再做谱系门禁：之前是流程比数据先进
- 把统计抽成共享模块：mulberry32 复制在 9 个文件里、配对 bootstrap 至少 5 份实现，重采样次数也不统一；答案 CI 和回放代理并入仓库
- 把预注册规则写成仓库里的文件、带哈希，而不是只写在文档里
- 评分器和被测系统解耦：合成判分不再复用生产 evaluateClaimSupport
- release:gate 分级：开源模型能产出的那部分证据先能本地通过

代码：`server/evaluation/synthetic-case-evaluator.js evaluateSyntheticCaseResponse`；`server/evaluation/quality-current-suite-manifest.js`

> ⚠ 说「全部推倒重来」。挑 2–3 条具体、能落地的讲。

## 可以引用的数字

| 说什么 | 数字 | 出处 | 前提 / 注意 |
| --- | --- | --- | --- |
| 伪 embedding 和真实 embedding 下 hybrid Recall@5 | 0.543 vs 0.712（BM25 两种下都是 0.658） | CURRENT-TRUTH.md §3.1 检索：伪 embedding 与真实 embedding | 8 篇 arXiv 论文、48 条用例、Top-5；用来说明排序反转，不是 hybrid 显著更好的证据 |
| 48 条用例上 hybrid−dense | +0.057 [−0.031,+0.156]，不显著 | CURRENT-TRUTH.md §3.1 | 区间跨 0 |
| QASPER dev 上 hybrid 与 BM25、dense 的差异 | −BM25 +0.074 [+0.048,+0.102] 显著；−dense +0.006 [−0.019,+0.031] 不显著 | docs/evaluation.md「QASPER：外部标注的检索和答案评测」 | 821 题，按段落算 Top-5，nomic；BM25 是 retrieval-comparison 里本地 store 的实现 |
| embedding 任务前缀带来的候选召回变化 | 0.648→0.692，+0.044 [+0.021,+0.067] | docs/evaluation.md「检索召回：embedding 任务前缀」 | 先在 train 400 题上定，再到 dev 821 题确认；答案 F1 不显著（+0.004） |
| 门控覆盖下限降到 0.2 的后果 | dev F1 0.206→0.153，−0.053 [−0.101,−0.009] 显著变差；信号 AUC 0.59–0.60 | docs/evaluation.md「拒答门控调参（QASPER train → dev）」 | 200 题，qwen2.5:7b；所以默认维持 0.51 |
| 答案变短带来的 F1 变化 | 0.206→0.231，+0.025 [+0.013,+0.037] 显著 | CURRENT-TRUTH.md §3.12「答案变短」 | 同一组 dev 200 题，qwen2.5:7b |
| cited 与 context 证据召回之差 | 作答时 0.596 vs 0.490，差 −0.106 [−0.164,−0.048]；引用精度 0.321 | docs/evaluation.md「引用证据：答案实际引用的页（2026-10-04）」 | dev 200 题、rag 面；区间是 runner 之外按 5000 次 bootstrap 算的；引用精度不能读成错引率 |
| 同一配置重跑的噪声 | F1 0.249→0.242，−0.007 [−0.018,+0.002] | docs/evaluation.md「引用证据：答案实际引用的页」 | 用来校准「多大的差异才可能是真的」 |
| 交叉编码器重排的效果 | 上下文证据 +0.063 [+0.044,+0.085]；可答题拒答 −4.4pp [−7.7,−1.7]；F1 +0.008 不显著 | CURRENT-TRUTH.md §3.14a | bge-reranker-v2-m3，需要单独的模型服务，不默认开 |
| 规划器结构化输出前后 | 降级 56%→8%，用例通过 47%→80% | CURRENT-TRUTH.md §3.3 | qwen2.5:7b，5 轮，30 个用例、25 次 LLM 规划调用；只修 prompt 的对照组没有提升 |
| LLM 调用容错前后 | 429：79.2%→100%；主模型宕机：0→100%；限流时 p95 2.5s→4.7s | CURRENT-TRUTH.md §3.4 | 本地假服务，每场景 24 次调用、并发 8，三轮平均；100% 是有备用模型时，无备用模型时精确 retry-after 场景 83.3%；备用模型和主模型共用限流器 |
| 提示注入红队 | rag 出口 17/39→0/39；改写绕过 3/3；良性语料误判 0/16,001 句 | CURRENT-TRUTH.md §3.10 | 13 个自建攻击用例 × 3 轮；agent 出口的 0/39 大多是澄清扣下了答案 |
| 答题率开关第二轮 dev | 答题率 +0.363 [0.264,0.462]，但不可答被回答 0/9→2/9，不通过 | CURRENT-TRUTH.md §3.21 | 100 题，qwen2.5:7b；没过事先定的「基线+1」上限，默认不变 |
| 按句切块 | train +0.040 [0.005,0.075]；dev +0.004 [−0.017,0.026]，没复现 | CURRENT-TRUTH.md §3.27 | 指标是候选覆盖；dev 上前三名命中 −0.027 [−0.050,−0.004] 显著更差；train 上显著不等于 dev 上能复现 |
| BM25 与 ts_rank_cd 对比 | −0.0012 [−0.0122,+0.0097]，没达到非劣性 | CURRENT-TRUTH.md §3.18 | QASPER dev 821 题 hybrid 证据召回；改成默认是产品决定，不是测出来更好 |
| verify:quality | 16/18→18/18 | CURRENT-TRUTH.md §3.2 | 对比题靠模板兜底；纯 RAG 路径 |
| claim judge 构造对照集 | 错误接受 0/54（对照集 0/42 + 留出集 0/12）；合同题 3/21→14/21 被回答且全对 | docs/evaluation.md「Claim 评审：校准与端到端」；CURRENT-TRUTH.md §4「校验器」「Agent 路径的答题率」 | 对照集由 verify:quality 的合同构造，标签由构造保证、不是人工标注；评审模型 qwen2.5:7b，端到端合同题里作答和评审是同一个 7B 模型；QASPER train 上只开评审时不可答题被回答 0/9→2/9 |
| 后端测试与覆盖率 | 3,250 个测试：3,235 通过、15 跳过、0 失败，全局行覆盖 90.46% | CURRENT-TRUTH.md §3.30 | 覆盖率门禁的最低线是全局行 78、分支 65、函数 80（test/coverage-policy.mjs GLOBAL_GATE） |
| 真实模型 CI 首次运行 | verify 18/18；QASPER 候选召回 0.655；约 63 分钟 | CURRENT-TRUTH.md §3.14「真实模型 CI」 | 阻断下限是 0.6；10 题 F1 0.164 只作报告 |
| 统计和门禁的代码常量 | BOOTSTRAP_RESAMPLES=2000、BOOTSTRAP_SEED=1729；pairedRecallDeltas 默认 4000 次、seed 1；WRONG_ANSWER_COST=3、UNANSWERABLE_PRIOR=0.115；DEFAULT_CURRENT_QUALITY_MAX_AGE_HOURS=24；CURRENT_QUALITY_SUITE_MANIFEST_VERSION=1.14.0 | run-retrieval-comparison.mjs、run-qasper-retrieval-eval.mjs、run-abstention-gate-analysis.mjs、quality-current-gate.js、quality-current-suite-manifest.js | 各脚本的重采样次数和种子不统一 |
| QASPER dev 转换后的题量 | 916 题：821 可答、95 不可答；89 道证据只在图表里，跳过 | docs/evaluation.md「QASPER：外部标注的检索和答案评测」 | 答案评测的主要实验抽 200 题（seed 1，139 篇论文），其中不可答 20 道 |

## 要主动说出口的边界

- 只用本地 7B（qwen2.5:7b）和 nomic 验证过，没有 GPT 级模型的数据，也没有生产流量。
- 样本小：自建检索集 48 条、端到端 18 项；答案抽样 200 题里只有 20 道不可答，agent 面的样本里只有 3–9 道，区间很宽。
- PR 门是确定性的，只证明管道和契约；钉死的 baseline 是 near-duplicate 语料的 100%。
- release:gate 的完整证据本机产不出来：compare-hard（要求 8/8，qwen2.5:7b 上一次 6/8）、planner-real、runtime-smoke、rollout-readiness 需要 GPT 级模型和 key；CI 上用的 OPENAI_API_KEY secret 2026-09-20 起被拒，Planner Real Gate 因此每天失败，文档里没有 release:gate 通过的记录。
- quality:current 不是密码学 attestation，evidence.command 是声明字段，恶意 producer 能伪造。
- bootstrap 按题重采样，没有按论文做 cluster；没有多重比较校正；同一组 dev 200 题（seed 1）被多轮实验复用，已经用旧。
- 答案层的置信区间由 runner 之外的脚本算（runner 不打 CI）；回放代理（各组共用同一次模型抽样）是一次性脚本，不在仓库里，别人难以复现。
- 合成评测的判分复用生产的 evaluateClaimSupport，和被测系统有共同盲点。
- 轨迹、planner-mock、recovery 评测都是 mock，只证明编排契约；recovery 评测不证明 OS 重启和 PG 持久化。
- eval:judge 没在真实标注数据上跑过；claim judge 只在构造的对照集上校准过，端到端时评审和作答是同一个 7B 模型。
- 提示注入用例是自建的，筛查是对着这些用例写的，测量偏乐观；刻意改写 3/3 成功；没测过 BIPIA/AgentDojo。
- QASPER 主评测从 JSON 文本导入，不经过 PDF 解析；证据只取第一位标注者；token F1 惩罚长答案，不能和排行榜比。
- robust 门里的 rerank NDCG 提升是在伪 embedding 加启发式重排上测的；真实 embedding 下启发式重排没有带来提升。
- 真实模型 CI（real-model-eval.yml）用 VECTOR_STORE_PROVIDER=local、不连数据库，不覆盖 pgvector / PostgreSQL BM25 路径。
- golden 只覆盖固定场景，在 Node 24 上生成，CI 的 Node 22 上还没验证。
- 统计代码重复：mulberry32 PRNG 在 9 个文件里各一份，配对 bootstrap 至少 5 份独立实现；manifest 有 2215 行，维护成本高。

## 只能当推理讲的内容

核验代理找不到代码或数据依据的条目。讲的时候用「我的判断是……，没测过」。

- 「release:gate 本机从来没有通过」：没有找到直接出处，已改成「本机产不出完整证据、文档里没有通过记录」。
- 「k 一换，结论就会变」：没有出处，已删除。
- 「200 题来自 139 篇论文，区间可能偏窄」：139 篇有出处（docs/evaluation.md），「偏窄」是读代码得出的判断，没有量过，已标成判断。
- 「不可答题只有 20 道，拒答召回区间很宽」：文档没给这个区间，是按 17/20 的样本量推断的，已标成推断。
- 「dev 已经用旧」：文档只说 agent 面的 dev seed 1 用过、以后要换新样本，200 题 rag 面的「用旧」是推断。
- 「对照集上评审和被评审是同一个 7B 模型」：对照集的 claim 是构造的、不是模型生成的，所以这句不成立，已改成只在端到端时成立。

## 容易记错的地方

第一遍阅读（主要依据 AGENTS.md 和文档）写错、被核验代理对照代码改正的说法。这些正是读文档容易产生的误解。

- **keyFiles: run-qasper-retrieval-eval.mjs**
  - 原以为：--min-hit-at-all 是 CI 下限
  - 实际：--min-hit-at-all 是 CI 流水线用的召回下限（低于就退出码 1），不是置信区间下限；pairedRecallDeltas 默认 4000 次、seed 1
  - 依据：文件第 19 行注释 "exit 1 below this rate (the CI floor)"；第 68 行 pairedRecallDeltas({ iterations = 4000, seed = 1 })
- **keyFiles / numbers: 提示注入用例数**
  - 原以为：13 个攻击用例加 4 个对照组
  - 实际：PROMPT_INJECTION_CASES 现有 15 个攻击用例（主测量 13 个 + 第一次基线后加的 2 个 evasion 用例，单独对比）+ 4 个对照组
  - 依据：prompt-injection-cases.js 里 PROMPT_INJECTION_CASES 有 15 个 id（含 evasion_paraphrase、evasion_chinese）；docs/evaluation.md「Prompt 注入红队」写明 evasion 类 2 个用例是第一次基线之后加的
- **numbers: 统计和门禁的代码常量**
  - 原以为：BOOTSTRAP_RESAMPLES=2000、SEED=1729 … 报告最大年龄 24h；manifest 1.14.0
  - 实际：BOOTSTRAP_RESAMPLES=2000、BOOTSTRAP_SEED=1729；pairedRecallDeltas 默认 4000 次、seed 1；DEFAULT_CURRENT_QUALITY_MAX_AGE_HOURS=24；CURRENT_QUALITY_SUITE_MANIFEST_VERSION=1.14.0
  - 依据：run-retrieval-comparison.mjs 第 129–130 行常量名是 BOOTSTRAP_SEED，没有叫 SEED 的常量
- **decisions[1] / questionLadder Q7、Q17 / limitations: 统计代码重复**
  - 原以为：PRNG 和 bootstrap 在 9 个文件里各写了一份
  - 实际：mulberry32 PRNG（常量 0x6d2b79f5）在 9 个文件里各一份（其中 import-qasper、resilience、pgvector-scale 只用它抽样或注入故障）；配对 bootstrap 至少 5 份独立实现：pairedBootstrapDelta、pairedRecallDeltas、pairedMeanDelta、run-layout-parsing-eval 的 pairedDelta、bootstrapMeanInterval（run-sparse-scoring-eval 直接 import pairedRecallDeltas）
  - 依据：grep 0x6d2b79f5 命中 9 个文件；grep bootstrap 实现只在 5 处；种子 1729/1/20260927 不同
- **decisions[1] / Q4: excludesZero**
  - 原以为：显著性按未四舍五入的上下界判定（泛指所有臂）
  - 实际：只有 run-retrieval-comparison 的 pairedBootstrapDelta 按未四舍五入的上下界算 excludesZero；pairedRecallDeltas 只输出四舍五入后的 ci95，没有 excludesZero
  - 依据：run-retrieval-comparison.mjs 第 355 行注释 "Judged on the unrounded bounds"；run-qasper-retrieval-eval.mjs pairedRecallDeltas 返回 { delta, ci95: [round(...), round(...)] }
- **decisions[4] tradeoff / Q8 trap: 门控代价先验 p**
  - 原以为：k=3 和先验 p 是人定的，不是测出来的；k 一换，结论就会变，所以报告里每一档的代价都列出来了
  - 实际：k=3 是人定的产品取舍；p=0.115 是 QASPER train 上不可答题的比例（数出来的），换数据要重算；报告列出每档放行率和拦截率，换 k 可以自己重算
  - 依据：run-abstention-gate-analysis.mjs 第 55–59 行注释 "p is the unanswerable share of QASPER train"；docs/evaluation.md「拒答门控调参」p = train 上不可回答题的比例 11.5%；「k 一换结论就会变」没有出处
- **decisions[0] why**
  - 原以为：PR 根本不读 OPENAI_API_KEY
  - 实际：quality-gate.yml 里不出现 OPENAI_API_KEY，ci-workflow.test.mjs 用 assert.doesNotMatch 钉住；检索路由仍在真 pgvector 上跑 hybrid RRF
  - 依据：server/test/ci-workflow.test.mjs 第 274 行 assert.doesNotMatch(workflow, /OPENAI_API_KEY/)；quality-gate.yml 的 quality-gate job 带 pgvector 服务和 VECTOR_STORE_PROVIDER=pgvector
- **decisions[9] tradeoff / limitations: release:gate**
  - 原以为：要求 GPT 级模型和 API key，本机从来没有通过
  - 实际：本机产不出完整发布证据（compare-hard 要求 8/8、qwen2.5:7b 上一次 6/8；planner-real、runtime-smoke、rollout-readiness 要 GPT 级模型和 key）；CI 用的 secret 2026-09-20 起被拒，文档里没有 release:gate 通过的记录
  - 依据：docs/adr/0001-langgraph-runtime.md 第 387 行「发布证据」；release-evidence.yml 第一步 test -n "$OPENAI_API_KEY"；CURRENT-TRUTH §3.13。「从来没有通过」找不到直接出处
- **decisions[9] decision: robust 谱系**
  - 原以为：robust 谱系检查（configHash 从代码里的权威 suite 计划重算）
  - 实际：三份 robust 报告同 commit、同 suite runId、同 configHash，且 configHash 等于 buildRobustSuiteExecutionPlan 重算的值
  - 依据：release-evidence-gate.js 第 33–37 行 EXPECTED_RELEASE_ROBUST_SUITE_CONFIG_HASH，第 84–124 行 buildRobustLineageCheck
- **decisions[7] alternativesRejected / Q7: LangSmith**
  - 原以为：LangSmith evals 在本项目被强制禁用；因为 trace 后端是一个新的泄露面
  - 实际：任何 LangSmith 追踪变量为 "true" 都拒绝启动，因为 LangChain 的 tracer 会把问题、prompt、文档正文发给第三方
  - 依据：server/rag/langgraph/langsmith-guard.js 文件头注释与 LANGSMITH_TRACING_VARIABLES；守卫拒绝的是追踪，代码里没有专门针对 "LangSmith evals" 的禁令
- **numbers: claim judge 构造对照集**
  - 原以为：source: CURRENT-TRUTH.md §4 边界「校验器」、FAQ Q8；caveat: 评审和被评审是同一个 7B 模型
  - 实际：source 补 docs/evaluation.md「Claim 评审：校准与端到端」和 §4「Agent 路径的答题率」（3/21→14/21 在那一条）；caveat 改为对照集由 verify:quality 合同构造、标签由构造保证，评审模型 qwen2.5:7b，端到端里作答和评审是同一个 7B，QASPER train 上只开评审时不可答被回答 0/9→2/9
  - 依据：对照集的 claim 是构造的、不是模型生成的，所以说对照集上「评审和被评审是同一个模型」不准确；0/54 = 0/42 + 0/12
- **numbers: 按句切块**
  - 原以为：train +0.040；dev +0.004，没复现
  - 实际：保留原值，caveat 补上 dev 前三名命中 −0.027 [−0.050,−0.004] 显著更差
  - 依据：CURRENT-TRUTH §3.27
- **numbers: LLM 调用容错**
  - 原以为：429：79.2%→100%
  - 实际：补上 100% 是有备用模型时，无备用模型时精确 retry-after 场景是 83.3%
  - 依据：CURRENT-TRUTH §3.4 表格「改后、无备用模型」一列
- **decisions[13] tradeoff / limitations: 真实模型 CI**
  - 原以为：（没写）
  - 实际：补上 real-model-eval.yml 用 VECTOR_STORE_PROVIDER=local、POSTGRES_DATABASE_URL 为空，真实模型 CI 不覆盖 pgvector / PostgreSQL BM25 路径
  - 依据：.github/workflows/real-model-eval.yml 的 env 段
- **decisions[2] tradeoff: QASPER 没过 PDF 解析器**
  - 原以为：QASPER 是从 JSON 文本导入的，没有经过 PDF 解析器
  - 实际：主评测是这样；版面解析评测另外用 30 篇 QASPER 论文的 PDF 走过 pdf.js/Docling
  - 依据：AGENTS.md「Layout parsing」和 docs/evaluation.md「版面解析」都用 30 篇 QASPER 论文的 PDF
- **questionLadder Q1**
  - 原以为：效果评测按层分：…轨迹（19 个用例）、规划（7 个用例）
  - 实际：把轨迹和规划（mock）移到契约层，和真实模型效果层分开
  - 依据：trajectory 用 buildScopedRagService 脚本化 chat；planner 默认 createMockPlannerProvider
- **limitations: agent 面样本**
  - 原以为：agent 面的样本里只有 7–9 道
  - 实际：agent 面的样本里只有 3–9 道
  - 依据：CURRENT-TRUTH §3.21：train seed 2 9 道、seed 3 3 道、seed 4 7 道、dev 9 道
- **requestFlow A.1 / A.2 / C**
  - 原以为：npm run eval:synthetic -- near-duplicate --openai-provider deterministic；C 只列报告
  - 实际：写成 workflow 里的真实参数（evaluation/synthetic-corpus-near-duplicate.json --latest-name latest-quality）；补 pgvector 服务、trajectory 另关的两个记忆开关、runTrajectoryCaseSafely；C 写出 release-evidence.yml 的实际步骤顺序
  - 依据：.github/workflows/quality-gate.yml、server/evaluation/trajectory/run.js、.github/workflows/release-evidence.yml
- **keyFiles: workflows**
  - 原以为：只列 4 个 workflow
  - 实际：补上 robust-eval-suite.yml，并写明 real-model-eval 和 release-evidence 都是每周一 cron
  - 依据：.github/workflows/ 目录有 5 个文件；cron "0 7 * * 1" 和 "0 11 * * 1"
- **staleInExistingDocs: CURRENT-TRUTH §4**
  - 原以为：行级安全不覆盖会话记忆 → 迁移 031
  - 实际：再补上 admin audit 已由迁移 032 纳入行级安全，以及可选的 POSTGRES_TENANT_CONTEXT=strict 和角色拆分（迁移 035）
  - 依据：server/db/migrations/032_enable_admin_audit_row_level_security.sql、035_create_system_role.sql；AGENTS.md「Tenant context states」「Database role split」
- **staleInExistingDocs: 新增一条**
  - 原以为：（没有）
  - 实际：docs/evaluation.md「自检模式」写自检预期 16/18、真实模型能否过 isSafeStructuredDifferenceAnswer 没测过，这两处都过时了
  - 依据：run-doccompare-verification.mjs 第 36 行 "EXPECTED SELF-TEST RESULT: 18/18"；rag/answer-writer.js 里现在叫 assessStructuredDifferenceAnswer；docs/evaluation.md 同节下方已记录 qwen2.5:7b 的 unsupported_claims 结果
- **staleInExistingDocs: NARRATIVE 故事 4**
  - 原以为：「hybrid 反而是数值最好的（0.71）…并开始接 QASPER 扩大评测集」整句判为过时
  - 实际：改成：叙述作为历史没错，但讲的时候要补上 QASPER 的结论
  - 依据：NARRATIVE-CASES.md 故事 4 原文是按时间顺序的叙述
