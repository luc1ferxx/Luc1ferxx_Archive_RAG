# 04 答案生成、防幻觉与提示注入

> 范围：答案生成、防幻觉与提示注入（QA 门控/上下文选择、答案写作、拒答标记、claim 自检与 finalizer、有界补检索循环、多文档对比门、校验过的流式草稿、提示注入三层防护、prompt 版本指纹）
>
> 回到 [总手册](../DEEP-DIVE-PLAYBOOK.md)。数字出处以 [CURRENT-TRUTH.md](../CURRENT-TRUTH.md) 和 `docs/evaluation.md` 为准；代码位置写成「路径 + 函数/常量名」，均经核验代理 grep 确认。

## 30 秒讲法

这块只负责一件事：证据够就带页级引用作答，证据不够就拒答，不让模型编。调模型之前先过确定性门控（assessQaConfidence：问题实词覆盖 ≥0.51、相关度下限、编号/引号短语必须出现），过了才写答案。模型输出先统一来源标签、删掉没出处的链接；在 agent 的 /chat 路径上，再由词法 claim 校验器逐句核对数字、主语、否定、情态和所引片段对不对得上，不支持就补检索一轮，最后由 finalizer 删掉无支持的句子，全删光就回固定拒答文本（MCP archive_ask 直接返回的单文档答案不经过这层自检）。多文档对比更严，模型答案过不了结构化门就换成引擎按证据拼的模板。证据进 prompt 前先过确定性注入筛查，流式只推校验通过的整句。要主动说的是：词法校验对正确改写太严，本地 qwen2.5:7b 下 agent 路径答题率很低。LLM 评审、模型自判拒答及其复核、7 个答题率开关都按事先定的规则测过，每轮都会多答 1–4 道不可答题，所以全部默认关闭。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `server/rag/confidence.js` | QA/对比门控：assessQaConfidence（覆盖率+相关度+anchor，可选重排概率门 selectByRerankProbability）、selectQaContext（判定与上下文分开）、findQueryTermSubstitution（近邻替换否决）、assessComparisonConfidence |
| `server/rag/document-rag-execution.js` | 答案路由主干：executeDocumentRag → runDocumentRag → executeQaRag / executeComparisonRag；门控不过时 buildQaGapPlan；模型拒答后 retryQaWithDeeperRetrieval；QA_CONTEXT_MIN_COVERAGE |
| `server/rag/answer-writer.js` | prompt 模板与写作：writeQaAnswer、writeComparisonAnswer、assessStructuredDifferenceAnswer、模板兜底 buildGroundedDifferenceAnswer / buildNoMaterialDifferenceAnswer、证据筛查 prepareQASourceBundle / buildScreenedContextSection、UNTRUSTED_EVIDENCE_RULES |
| `server/rag/self-check/text.js` | normalizeGroupedSourceLabels：把 [Source 1, Source 3] 归一成一括号一个标签（answer-writer.js 和 answer-drafts.js 引用它） |
| `server/rag/answer-verdict.js` | NOT_IN_EVIDENCE: 拒答标记解析（readQaAnswerVerdict / QA_NOT_IN_EVIDENCE_MARKER），RAG_QA_ANSWER_VERDICT 默认关（config.js isQaAnswerVerdictEnabled） |
| `server/rag/answer-verdict-override.js` | overrideNotInEvidenceVerdict：标记后的句子能被确定性证明时改判作答（RAG_QA_VERDICT_OVERRIDE 默认关，config.js getQaVerdictOverrideMode） |
| `server/rag/self-check/evaluate.js` | evaluateClaimSupport / computeClaimSupport：逐 claim 核对；evaluateDocumentEvidence 产出 passed/retryRecommended；evaluateDocumentEvidenceWithJudge；selectBetterRagResult |
| `server/rag/self-check/support.js` | evaluateClaimAgainstCitations：数字锚点、情态、主语绑定、极性、关系方向、词重叠 ≥0.6 的核心词法判定（约 1800 行） |
| `server/rag/self-check/claims.js` | splitAnswerStructure / splitAnswerClaims：按标题/句号/分号（CLAIM_SPLIT_PATTERN）和 splitCoordinatedClaim 切 claim，识别 Differences 段 |
| `server/rag/self-check/claim-judge.js` | 可选 LLM 评审 judgeClaimSupport：只复核被词法拒绝且引用合法（isJudgeEligible）、数字都在证据里（claimNumbersAppearInEvidence）的 claim，只升不降，异常时保留词法结论；按租户分区缓存（CACHE_LIMIT 500，Redis SHARED_VERDICT_TTL_MS 7 天） |
| `server/rag/self-check/evidence-context.js` | 每次 /chat 内的精确 memo（createSelfCheckEvidenceContext / memoizeInEvidenceContext / buildClaimSupportContentKey），不跨请求 |
| `server/rag/agent-document-loop.js` | runDocumentRagLoop：主答 → 自检 → 最多 1 次补检索 → 再自检 → 选优/澄清 |
| `server/rag/grounded-answer-finalizer.js` | finalizeGroundedAnswer：有 claim 不被支持时只保留被支持的 claim，引用改写成已验证的 rank（formatSupportedClaim）；一条都不剩则 GROUNDED_ABSTENTION_TEXT（agent-finalizer.js 只是 re-export） |
| `server/rag/answer-drafts.js` | createAnswerDraftReleaser / findCompletePrefix / runWithAnswerDraftChannel：token 留在服务端，每个完整句子过 finalizer 同一套校验后才推 answer_draft |
| `server/rag/agent-event-stream.js` | SSE 事件 sink（AsyncLocalStorage，emitAgentEvent / AGENT_EVENT_TYPES），只发步骤摘要和已校验草稿 |
| `server/rag/prompt-injection-screen.js` | screenUntrustedText（对 AI 说话的句子替换为 SCREENED_SENTENCE_MARKER，SENTENCE_RULES 含中英文规则）+ guardAnswerLinks（删 markdown 图片和含模型没见过链接的句子） |
| `server/rag/comparison-engine.js` | analyzeComparison：近重复（NEAR_DUPLICATE_TERM_JACCARD 0.75 / NEAR_DUPLICATE_SENTENCE_OVERLAP 0.6）、shouldShortCircuitNoMaterialDifference、显式数值冲突 |
| `server/rag/comparison-equivalence.js` | evaluateBidirectionalEvidenceEntailment：双向蕴含判等价 |
| `server/rag/gap-planner.js` | planQaEvidenceGap：拒答时说明'找到了什么、缺什么'，生成补充查询 |
| `server/rag/prompt-registry.js` | definePrompt / fingerprintPromptSource（SHA-256 前 12 位）/ hashPromptSet / PROMPT_IDS（11 个） |
| `server/rag/prompt-catalog.js` | listPromptTemplates / describeActivePromptTemplates 汇总全部模板和当前生效集 |
| `server/test/prompt-registry.test.mjs` | PINNED_PROMPT_TEMPLATES 钉死 19 个 id@version 的指纹 |
| `server/evaluation/release-evidence-gate.js` | buildPromptLineageCheck：发布报告必须同一 prompt setHash |
| `server/evaluation/agent-answer-outcome.js` | classifyAgentAnswer：澄清、grounded abstention、空答案都不算回答（评测口径） |

## 一次请求怎么经过这里

一次 /chat 走默认配置的文档问答路径（V1 外层计划，原生循环）：
1. agent-execution-plan-runner.js 的 documentRag 阶段调 runDocumentRagLoop（agent-document-loop.js）。它先 createSelfCheckEvidenceContext（本次 /chat 的 memo），再 consumeBudget(budgetState, documentRagSkill.budgetKey)（DEFAULT_AGENT_BUDGET.maxDocumentRagCalls = 2），然后在 runWithAnswerDraftChannel 里 executeObservedSkill(documentRagSkill)，进到 ragService.chat → executeDocumentRag。
2. executeDocumentRag：buildRetrievalInputs → lookupSemanticCache（RAG_SEMANTIC_CACHE 默认关）→ runDocumentRag，按路由分 QA 或对比。
3. QA（executeQaRag）：
   - retrieveGlobalContextForQueries 拿候选，然后 assessQaConfidence 判定。词面门（selectUsableResults）的条件是准入分（getAdmissionScore）≥ RAG_MIN_RELEVANCE_SCORE 0.32（回退档 ×0.8，FALLBACK_THRESHOLD_RATIO）、覆盖率 ≥ 0.51、放行块合起来覆盖问题里全部 anchor 组（编号类 code、引号短语）。所有候选都带 crossEncoderScore 且重排概率门没关时，改用 selectByRerankProbability。实测相关度下限在 nomic 上 0.2–0.6 之间不影响结果，起作用的只有覆盖率（docs/evaluation.md「拒答门控调参」）。
   - 不通过：buildQaGapPlan / planQaEvidenceGap 生成"找到了什么、缺什么"的说明（可能再跑补充检索，但只用于说明），返回 abstained: true，不调用答案模型。
   - 通过：selectQaContext 先放门控放行的块，再按检索顺序补候选，补到 topK 为止（要求过相关度回退下限、命中 anchor、没有近邻替换；QA_CONTEXT_MIN_COVERAGE = 0）。
   - prepareQASourceBundle：每个块和文件名都经 buildScreenedContextSection 过 screenUntrustedText 再进 prompt，citation 保留原文。
   - writeQaAnswer：completeText 带 qa_answer 模板描述符和 drafts 的 onTextDelta。输出依次经过 normalizeGroupedSourceLabels 和 guardAnswerLinks。开了 RAG_QA_ANSWER_VERDICT 时还有 readQaAnswerVerdict，再开 override 时有 overrideNotInEvidenceVerdict。模型自判拒答（abstainSource = answer_model）时调 retryQaWithDeeperRetrieval（top 18，只给模型没看过、且过同一门控的块，最多 topK 条，只重试一次）。
4. 回到 runDocumentRagLoop：evaluateDocumentEvidenceWithJudge 调 evaluateDocumentEvidence → evaluateAnswerEvidence → evaluateClaimSupport（另要求引用覆盖 min(docIds 数, 2) 份文档）。evaluateClaimSupport 先 splitAnswerClaims，再对每条 claim 做 evaluateClaimAgainstCitations 和关系检查（对比、一致、排他、无差异）。RAG_CLAIM_JUDGE=llm 时再走 judgeClaimSupport。
5. 补检索：retryRecommended（= 没通过且不是拒答；拒答的不算）且 followUpsRun < maxFollowUps（1）时，调 buildFollowUpQuestion（默认返回 buildEvidenceRetryQuestion 的 "Re-check the uploaded documents…" 元文本，里面带原问题和证据问题）和 buildAgentRetrievalPlan（phase follow_up：主查询就是这段补检索问题文本，再加 2 条修复查询，共 3 条）。第二次 executeObservedSkill 带 memoryWrites:false，结果再自检一遍，然后 selectBetterRagResult 选优。仍不通过就 buildEvidenceClarification；计划没要 Web（!plan.wantsWeb）时直接返回澄清。
6. 主答拒答或失败：webSearch 阶段 state.shouldRunWeb 成立，Web 需要审批或常设授权；依赖故障则直接以 503/504 结束，不转 Web。
7. agent-finalization-flow.js：getBoundSelfCheckEvidenceContext 取回 memo，对同样的文本和证据直接命中，开评审时走 judgeClaimSupport。然后 finalizeAgentAnswer（即 finalizeGroundedAnswer）：全部 claim 被支持时原文原样返回；有不被支持的就重建文本，只保留被支持的 claim，formatSupportedClaim 只写已验证的 [Source N]；一条证据 claim 都不剩时输出 GROUNDED_ABSTENTION_TEXT。
8. /chat/stream 额外的部分：createAnswerDraftReleaser 用 findCompletePrefix 等到句末、来源标签和下一个字符都到了，才对已写出的前缀调 evaluateClaimSupport。通过的句子先 formatSupportedClaim；如果 guardAnswerLinks 会删掉其中的链接，这句就不推；否则 emitAgentEvent(answer_draft)。以 NOT_IN_EVIDENCE: 开头的回复不出草稿。模型重试或切换时发 answer_draft_reset。最后的 result 事件与 /chat 的 body 完全一致，替换掉所有草稿。
9. 对比路径（executeComparisonRag）：
   - retrievePerDocumentContextForQueries 逐文档召回。assessComparisonConfidence 要求至少 min(2, 文档数) 份文档有证据，允许 vectorScore ≥ 0.32 的语义豁免（allowSemanticBypass，只有对比开）。
   - alignComparisonEvidence → prepareComparisonSourceBundle，再由 buildComparisonAnalysisFromContexts（内部调 analyzeComparison）判近重复、双向蕴含和数值冲突。
   - writeComparisonAnswer：先看近重复能否短路成"无实质差异"（buildNoMaterialDifferenceAnswer，不调模型）；否则调模型，经 normalizeGroupedSourceLabels 和 guardAnswerLinks 后进 assessStructuredDifferenceAnswer。不过门就换 buildGroundedDifferenceAnswer 模板，模板也过不了就拒答。modelRejectReason（只有代码和计数）只进 trace。

## 设计决策

### D1. 在调用答案模型之前用确定性词面门控决定答不答（assessQaConfidence）

**为什么**

- 便宜、确定、可复现，每次拒答都能说出原因（低相关度或缺 anchor）
- 能挡住'相邻话题'，比如问育儿假却拿年假条款回答，回归测试钉死了这类行为
- 不过门就不调模型，省一次生成

**为什么不用主流替代方案**

- 让 LLM 自己判断能不能答：已实现为 RAG_QA_ANSWER_VERDICT，7B 模型会拒掉写对了的答案，默认关
- 交叉编码器概率做门：已实现，只在开重排时生效（开重排时默认用它），因为需要单独的模型服务
- 降低阈值：0.2 时 F1 显著变差；阈值 ≤0.5 会让 5 个行为测试翻转，其中 2 个是真实的相邻话题退化

**代价**

- 词面信号区分可答和不可答的能力很弱（AUC 约 0.6）
- QASPER 上四成多可回答题被拒
- 换了说法的证据会被误杀
- 相关度下限在 nomic 上实测不起作用，真正起作用的只有覆盖率

**证据**

- 降阈值 0.51→0.2：拒答 41.7%→7.2%，但不可回答题识别 85%→15%，F1 0.206→0.153，配对 −0.053 [−0.101, −0.009] 显著变差（CURRENT-TRUTH 3.12；docs/evaluation.md「拒答门控调参」；train 选值、dev 200 题验证，qwen2.5:7b）

**代码**：server/rag/confidence.js assessQaConfidence / selectUsableResults / hasEnoughQueryCoverage；server/rag/config.js DEFAULT_MIN_QA_QUERY_TERM_COVERAGE / getMinRelevanceScore；server/rag/text-utils.js extractAnchorGroups

### D2. 门控只决定答不答，模型能看到哪些上下文另由 selectQaContext 决定

**为什么**

- 门控逐块判断，换了说法的证据段即使在候选里也到不了模型
- 拆开以后拒答决定不变，只是把更多候选补进上下文

**为什么不用主流替代方案**

- 整体降低门控阈值：拒答识别会崩（见上一条）
- 补进来的段落不设任何过滤：会把 cobalt ceiling 那类近邻话题段落一起引进来

**代价**

- 上下文变长
- 必须保留近邻替换否决和 anchor 检查
- QA_CONTEXT_MIN_COVERAGE=0，补进来的段落不要求共享问题词

**证据**

- 证据进模型上下文（dev 821 题）0.245→0.353，配对 +0.108 [+0.088, +0.130]
- 答案（dev 200 题）F1 0.235→0.249，+0.014 [−0.000, +0.029]，不显著
- 出处：docs/evaluation.md「门控：判定和上下文分开」，qwen2.5:7b
- 注意这是上下文指标，不是引用指标

**代码**：server/rag/confidence.js selectQaContext；server/rag/document-rag-execution.js QA_CONTEXT_MIN_COVERAGE / executeQaRag

### D3. 生成后用确定性词法 claim 校验逐句核对，finalizer 删掉没有支持的句子（默认方案，agent /chat 路径）

**为什么**

- 不多花一次模型调用
- 结论可解释，trace 里有 missingAnchors 代码，例如 term:xxx、subject:xxx、polarity、relation_order
- 数字、极性、情态、文档归属这几类最危险的错误由规则精确把关，构造集上错误 claim 被接受 0

**为什么不用主流替代方案**

- LLM-as-judge（如 Ragas faithfulness）作为主校验：同一个 7B 模型偶尔结论和自己的理由矛盾；'模型评审最容易让改过的数字溜过去'是 claim-judge.js 注释里的设计判断，实测是数字规则在评审前挡下了 6 次错数字
- NLI 模型（如 DeBERTa-MNLI）：没测过，是候选，不能说它不行
- 只要求带引用、不核对内容：挡不住错数字

**代价**

- 正确改写几乎全被拒（只用词法时只接受 3/42）
- 本地 7B 下 agent 路径大多以澄清结束
- 规则很多（support.js 约 1800 行），维护成本高

**证据**

- 只用词法：正确改写接受 3/42，错误 claim 接受 0/42（docs/evaluation.md「Claim 评审：校准与端到端」；构造集 14 条正确改写 + 14 条错误 claim × 3 轮，每类错误只有 1–2 条，qwen2.5:7b）
- QASPER train 评审关时 agent 可答题被回答 0/41（CURRENT-TRUTH 3.21）

**代码**：server/rag/self-check/evaluate.js evaluateClaimSupport / computeClaimSupport；server/rag/self-check/support.js evaluateClaimAgainstCitations；server/rag/self-check/patterns.js SUPPORT_TOKEN_OVERLAP_THRESHOLD；server/rag/grounded-answer-finalizer.js finalizeGroundedAnswer

### D4. LLM 评审只作为第二意见：只复核被词法拒绝的 claim，只能把不支持改成支持，不能反过来，有确定性护栏，默认关闭

**为什么**

- 评审擅长认同义改写，规则擅长数字和引用，各用所长
- 四条护栏：引用缺失、歧义或归属错的 claim 不送评审（标题和 Differences 段的 claim 也不送）；claim 里的数字必须出现在所引证据里；对比答案不送评审；调用异常/超时时 status=failed、解析不出某条 verdict 时该条保留词法结论（fail closed）

**为什么不用主流替代方案**

- 评审双向裁决、替代词法：会把规则挡住的错数字放回来
- 每个 claim 单独调一次：成本高；现在是每个答案一次批量调用，只送被拒的 claim
- 默认打开：QASPER 上会回答不可答题

**代价**

- 每个答案多一次模型调用：合同题 p50 约 +0.8 秒，论文题 p95 约翻倍
- 还没用人工标注校准过

**证据**

- 构造集：正确改写接受 39/42，错误接受 0/42；留出集 10/12 和 0/12（14+14 条 × 3 轮；留出 4+4 条 × 3 轮）
- 合同题端到端 3/21→14/21 得到回答，14 个全对；p50 1150→1985 ms
- 以上出处：docs/evaluation.md「Claim 评审：校准与端到端」，qwen2.5:7b
- QASPER train：只开评审时可答题回答 10/41，但不可答题被回答 0/9→2/9（CURRENT-TRUTH 3.21）

**代码**：server/rag/self-check/claim-judge.js judgeClaimSupport / isJudgeEligible / claimNumbersAppearInEvidence；server/rag/config.js getClaimJudgeMode

### D5. 有界自检循环：最多 1 次补检索、3 条检索查询；主答已经拒答时不补检索

**为什么**

- 成本和延迟有上限，每一步都可审计
- 预算由运行时决定（maxDocumentRagCalls 2），不交给模型

**为什么不用主流替代方案**

- ReAct 开放循环：步数和成本不可控
- Self-RAG：要微调出反思 token，接不了任意 OpenAI 兼容模型
- CRAG：要额外的检索评估器和 Web 兜底；本项目的 Web 是需要审批的单独阶段

**代价**

默认补检索的问题文本是 'Re-check the uploaded documents…' 这种元文本（它同时是补检索的主查询和门控基准），实测几乎不起作用。修复开关 AGENT_FOLLOW_UP_ORIGINAL_QUESTION 单开时没有多答出任何一题，默认仍关

**证据**

- 诊断：补检索 61 次只过 1 次，原因是元文本被当成检索查询和门控基准
- 开关单开（A2）：可答题回答仍是 0/41
- 出处：CURRENT-TRUTH 3.21；docs/evaluation.md「Agent 答题率开关」，QASPER train 50 题，qwen2.5:7b

**代码**：server/rag/agent-document-loop.js runDocumentRagLoop；server/rag/agent-bootstrap.js DEFAULT_AGENT_MAX_FOLLOW_UPS；server/rag/agent-budget.js DEFAULT_AGENT_BUDGET；server/rag/self-check/gaps.js buildFollowUpQuestion / buildEvidenceRetryQuestion；server/rag/agent-query-planner.js buildAgentRetrievalPlan

### D6. 不向客户端流式推原始 token，只推通过 finalizer 同一套校验的整句草稿

**为什么**

- finalizer 会在生成后删句，边生成边推，用户会先看到后来被删的内容
- 一句话只有在来源标签和下一个字符（或换行）都到了之后才算写完，否则会被判成没有引用

**为什么不用主流替代方案**

- 直接推 token 再撤回或标红：用户已经读到了未经校验的内容
- 推 token 加免责声明：等于默认会推出幻觉
- 完全不流式：失去长答案的首字延迟收益

**代价**

- 只能保证'推出去的都校验过'，不能保证不撤回（补检索可能换答案，也可能改成澄清）
- 在当前词法校验下几乎没有延迟收益

**证据**

- 合同政策 7 题里 1 题产生草稿，比最终答案只早 7ms；论文 12 题 0 题（CURRENT-TRUTH 3.7；docs/evaluation.md「校验过的答案草稿」，qwen2.5:7b）
- 修完 2 个校验器 bug 后（各 3 轮），合同题有草稿的运行 2/21→4/21，草稿全部保留；论文 0/36 不变

**代码**：server/rag/answer-drafts.js createAnswerDraftReleaser / findCompletePrefix / runWithAnswerDraftChannel；server/rag/agent-event-stream.js emitAgentEvent / AGENT_EVENT_TYPES

### D7. 对比答案三级降级：模型答案过结构化门就用它，否则用引擎按证据拼的模板，模板也过不了就拒答

**为什么**

把 A 文档的数值安到 B 头上是对比里最严重的错误。所以模型答案要同时满足：非空；有 Differences 段；全文 claim 都被检查且都被支持；被支持的差异 claim 引用覆盖证据包里的每一份文档

**为什么不用主流替代方案**

- 信任模型加引用：数值可能错配到另一份文档
- 用 LLM 评审对比答案：刻意排除，因为对比有自己的差异和等价检查

**代价**

qwen2.5:7b 写的对比答案全部被拒，用户看到的是模板文本，可读性差

**证据**

- 2026-10-04，qwen2.5:7b：进门的模型对比答案全部判为 unsupported_claims（verify:quality 1 次、compare-hard 5 次），5 次退回模板，1 次拒答（AGENTS.md「Comparison answer gate」）
- verify:quality 16/18→18/18，但通过的对比答案来自模板（CURRENT-TRUTH 3.2 注）

**代码**：server/rag/answer-writer.js writeComparisonAnswer / assessStructuredDifferenceAnswer / buildGroundedDifferenceAnswer / buildNoMaterialDifferenceAnswer；server/rag/comparison-engine.js analyzeComparison

### D8. 提示注入三层防护：证据进 prompt 前确定性筛查，prompt 里声明证据是不可信数据（spotlighting），输出时守卫链接

**为什么**

- 只加 prompt 规则挡不住 7B 模型，指令覆盖类仍 9/9 成功
- 筛查是确定性的，在良性语料上误判 0 句
- 给用户看的引用保留原文
- 规划器本来就看不到文档正文，注入改不了要调哪个工具

**为什么不用主流替代方案**

- Llama Guard / Prompt Guard 这类分类模型：多一次模型调用和延迟，也没测过，可以以后叠加
- 只靠模型对齐或 prompt 规则：测过不够
- dual-LLM 隔离：改动大，当前读文档的路径没有工具调用面

**代价**

- 基于模式匹配，刻意改写可以绕过
- 新规则必须保持良性语料 0 误判，否则会误删真事实

**证据**

- 文档 RAG 出口（MCP 原样返回）攻击进入答案 17/39→0/39
- 受攻击时仍给出正确事实 22/30→30/30
- 对照组 9/12 不变
- 16,001 句良性语料误判 0
- evasion_paraphrase 在文档 RAG 出口改前改后都是 3/3 成功（Agent 路径 3/3→1/3）
- 出处：CURRENT-TRUTH 3.10；docs/evaluation.md「Prompt 注入红队」，qwen2.5:7b，每组 3 轮

**代码**：server/rag/prompt-injection-screen.js screenUntrustedText / guardAnswerLinks / SENTENCE_RULES；server/rag/answer-writer.js UNTRUSTED_EVIDENCE_RULES / buildScreenedContextSection；server/rag/self-check/claim-judge.js buildClaimJudgePrompt；server/rag/config.js getPromptInjectionScreenMode

### D9. 答案模型自判拒答（NOT_IN_EVIDENCE: 标记），再加一层确定性复核 override，两者默认都关

**为什么**

- 词面信号的上限就是 AUC 约 0.6，模型读过证据，可能判断得更好
- override 修的是 7B 打了标记、后面却写出带出处正确值的情况

**为什么不用主流替代方案**

- 直接信任模型标记：verify:quality 上会把写对了的答案判成拒答
- 用 LLM 评审复核 override：刻意不用，只走词法校验，避免再引入一个模型判断

**代价**

- 这是拿拒答率换答案质量：只开补救区 + 模型标记时可回答题拒答显著上升，加扩大检索重试后拉回基线，但不可回答题识别 85%→70%
- override 的 hedge 后半句规则是看着 verify:quality 的失败样例写的，那份数据不能当它的独立证据

**证据**

- RAG_QA_ANSWER_VERDICT=true（补救区 + 模型标记）：F1 0.231→0.242，配对 +0.010 [−0.027, +0.048] 不显著；可回答题拒答 +10.0pp [+2.2, +18.1]，显著变差（docs/evaluation.md「两段式拒答」，dev 200 题）；只加模型判定、不开补救区时 F1 0.235、拒答 58.3%
- 候选全开（B2）时 verify:quality 14/18
- override 在 QASPER 上判断了 42 次，作答 0 次（CURRENT-TRUTH 3.21）

**代码**：server/rag/answer-verdict.js readQaAnswerVerdict / QA_NOT_IN_EVIDENCE_MARKER；server/rag/answer-verdict-override.js overrideNotInEvidenceVerdict / QA_VERDICT_OVERRIDE_REASONS；server/rag/document-rag-execution.js retryQaWithDeeperRetrieval

### D10. 每个 prompt 模板一个描述符 id@version#fingerprint（未渲染模板原文 SHA-256 的前 12 位），测试钉死

**为什么**

- 每次模型调用、LLMOps 事件、span 和评测报告都能归到具体模板
- 改了模板却不改版本号，测试直接失败
- 事件里只带描述符，不带 prompt 原文

**为什么不用主流替代方案**

- LangSmith 或 Langfuse 的 prompt 管理：项目强制 LangSmith 不运行（有守卫）；要不绑厂商，trace 走 OTLP 也能进 Langfuse
- 只按 model route 分组：同一个桶里混着多个 prompt

**代价**

- 要靠人自觉升版本号
- 只有归因，没有线上 A/B 灰度

**证据**

35 个 completion 事件全部能归到具体模板，改前 0 个（CURRENT-TRUTH 3.9；docs/evaluation.md「Prompt 模板归因」，样本很小）

**代码**：server/rag/prompt-registry.js definePrompt / fingerprintPromptSource / hashPromptSet；server/rag/prompt-catalog.js describeActivePromptTemplates；server/test/prompt-registry.test.mjs PINNED_PROMPT_TEMPLATES；server/evaluation/release-evidence-gate.js buildPromptLineageCheck

### D11. claim 校验在一次 /chat 内做精确输入 memo，不做跨请求缓存

**为什么**

- 压测发现 claim 校验是 agent 层 CPU 热点：主答自检、补检索自检、选优、finalizer 会对同样的文本反复校验（无补检索 2 次调用算 1 次，有补检索 5 次算 2 次）
- 不跨请求、不跨租户，就没有失效问题和泄露风险

**为什么不用主流替代方案**

- 进程级 LRU：要处理失效，还会有跨租户的时序侧信道
- 按归一化后的输入做 key：normalizeNumericSyntax 不幂等，会改变结果
- 换语言重写：成本太高

**代价**

- 新加一个影响校验的配置，必须同时加进 content key
- 读写都复制（facts 和 claimSupport 用 structuredClone）

**证据**

- 每请求应用 CPU 约 12–13 ms → 约 5 ms，并发 32 时吞吐约 2.6 倍，三档区间都不重叠
- 条件：单体、pgvector、行级安全、假模型 0 ms、回答很短，真实长答案上的加速没测（CURRENT-TRUTH 3.24；docs/evaluation.md「Claim 检查 memo」）

**代码**：server/rag/self-check/evidence-context.js createSelfCheckEvidenceContext / memoizeInEvidenceContext / buildClaimSupportContentKey / getBoundSelfCheckEvidenceContext；server/rag/agent-document-loop.js runDocumentRagLoop

## 追问阶梯

按面试官的追问顺序排。先自己出声答一遍，再看要点。⚠ 是这题最容易答错或夸大的地方。

### Q1. 你的系统怎么控制幻觉？讲一下一次文档问答从检索到返回的完整链路。

*L1 是什么*

- 分四道关
- 生成前：确定性门控决定答不答。证据不够直接拒答，并说明找到了什么、缺什么
- 生成时：prompt 要求保留证据原文的措辞和数值，必须标 [Source N]，证据被声明为不可信数据
- 生成后（agent /chat 路径）：词法 claim 逐句核对数字、主语、否定、情态、关系方向。没过就补检索一轮，finalizer 删掉没有支持的句子，全删光就回固定拒答文本
- 对比路径另加一道结构化门：模型答案过不了就换成按证据拼的模板
- 主动说明：MCP archive_ask 直接返回的单文档答案只有门控、注入筛查和链接守卫，不经过 claim 自检

代码：`server/rag/document-rag-execution.js executeQaRag`；`server/rag/confidence.js assessQaConfidence`；`server/rag/agent-document-loop.js runDocumentRagLoop`；`server/rag/grounded-answer-finalizer.js finalizeGroundedAnswer`

> ⚠ 不要说'杜绝幻觉'或'零幻觉'。安全说法：'校验的是每句话有没有被它引用的片段支持；构造集上错数字基本过不去，代价是会误删正确改写；它不判断答案是否完整回答了问题。'

### Q2. 为什么在调用模型之前就决定拒答？门控具体看什么？0.51 这个阈值怎么来的？

*L2 为什么*

- 门控看三样：准入分 ≥ RAG_MIN_RELEVANCE_SCORE 0.32（回退档 ×0.8）、问题实词覆盖率 ≥ 0.51、问题里的编号和引号短语必须被放行块覆盖
- 实测相关度下限在 nomic 上 0.2–0.6 之间不影响结果，真正起作用的只有覆盖率
- 0.51 的含义是两个词的问题两个词都要命中
- 在 QASPER train 上调过，dev 上验证：降到 0.2 时 F1 显著变差，不可回答题识别率从 85% 掉到 15%，所以结论是不改
- 对比路径有语义豁免（vectorScore ≥ 0.32）。原因是'compare'和'two contracts'这类词永远不会出现在条款里，实测自然措辞的对比问题覆盖率都恰好是 0.50
- 不过门就不调模型，省一次生成

代码：`server/rag/confidence.js hasEnoughQueryCoverage`；`server/rag/confidence.js selectUsableResults`；`server/rag/config.js DEFAULT_MIN_QA_QUERY_TERM_COVERAGE`；`server/rag/config.js getMinRelevanceScore`

> ⚠ 不要把 0.51 说成调参得到的最优值。安全说法：'调参的结论是不调，数据和回归测试都不支持改默认值。'

### Q3. （追问）你说门控 AUC 只有 0.6，那它挡掉了多少正确能答的题？用户被拒了体验怎么办？你又怎么提高真正送到模型的证据？

*L3 为什么不用 X / 怎么证明*

- QASPER dev 200 题上，可回答题被拒约 42%，不可回答题识别 80–85%
- 拒答不是一句冷冰冰的'不知道'：planQaEvidenceGap 会说'找到了和 X 相关的内容，但不能确认 Y'，并列出补充查询
- agent 路径主答拒答后会进入 Web 阶段，但 Web 需要审批或常设授权
- 提高送到模型的证据：selectQaContext 把判定和上下文分开，证据进入上下文 0.245→0.353，显著
- 开重排时可以用交叉编码器概率做门：可回答题拒答 37.8%→13.9%，但不可回答题识别 80%→45%

代码：`server/rag/gap-planner.js planQaEvidenceGap`；`server/rag/confidence.js selectQaContext`；`server/rag/confidence.js selectByRerankProbability`；`server/rag/agent-execution-plan-runner.js state.shouldRunWeb`

> ⚠ 0.353 和 0.596 是'上下文里有证据'，不是'答案引用对了'；3.23 专门更正过。答案实际引用的证据只有 0.490，比上下文少 0.106，显著。

### Q4. 为什么 claim 校验用词法规则，不用 LLM-as-judge（比如 Ragas faithfulness）或者 NLI 模型？

*L3 为什么不用 X / 怎么证明*

- 词法规则是确定的、可解释、不花模型调用
- 在数字、否定、情态、实体/主语这几类风险最高的错误上，构造集错误接受 0/42（14 条错误 claim × 3 轮，每类只有 1–2 条，样本小）
- LLM 评审已经做了，但只作为第二意见：只复核被词法拒绝的 claim，只升不降；引用不合法、数字不在证据里、对比答案都不送评审
- NLI 没测过，是下一步候选，我不会说它不行
- 真正的问题在词法规则一侧：正确改写只接受 3/42，7B 下 agent 路径几乎不作答

代码：`server/rag/self-check/support.js evaluateClaimAgainstCitations`；`server/rag/self-check/claim-judge.js isJudgeEligible`；`server/rag/self-check/claim-judge.js claimNumbersAppearInEvidence`

> ⚠ 不要贬低 NLI 或 Ragas，自己没测过的东西只能说'未测'。也不要说词法规则'准'：它的精度靠拒掉大量正确答案换来。

### Q5. （追问）你的评审用的是同一个 7B 模型，自己评自己可靠吗？你怎么证明它不会放过错答？

*L3 为什么不用 X / 怎么证明*

- 构造集 14 条错误 claim × 3 轮（42 次判定）加留出集 4 条 × 3 轮（12 次），错误接受都是 0
- 第一轮的 2 次误判是评测脚本只读了拆分后的第一条 claim，修正口径后消失；这是先怀疑测量、再动模型
- 真实问题也有：结论字段和它自己的理由矛盾，约百分之一
- 所以只允许它升级，数字仍由规则把关（评审前挡下 6 次错数字），调用失败时保留词法结论
- QASPER 上开评审后不可答题被回答 0/9→2/9，所以默认关
- 还没用人工标注的真实答案报一致率和 kappa（eval:judge 只有框架）

代码：`server/rag/self-check/claim-judge.js judgeClaimSupport`；`server/rag/self-check/claim-judge.js buildClaimJudgePrompt`

> ⚠ 不要把 39/42（93%）说成评审准确率。那是构造集上正确改写的接受率，标签由构造保证，不是人工标注；而且只有 14 条句子跑了 3 轮。

### Q6. finalizer 删句之后答案还通顺吗？引用怎么处理？全删光了怎么办？

*L2 为什么*

- 全部 claim 被支持时原文原样返回，不改写
- 有不被支持的 claim 时才重建：只保留 supported 的 claim，按原结构输出：标题保留；Differences 标题只有在该段有被支持的差异时才保留
- 重建时 formatSupportedClaim 把来源标签改写成已验证的 rank
- 一条证据 claim 都不剩时，输出固定的 GROUNDED_ABSTENTION_TEXT，abstained 为 true
- 被删的句子记录在 finalizer 结果的 removedClaims 里，进入 trace
- 不会再调模型润色，所以删句后可能不连贯，这是有意的取舍

代码：`server/rag/grounded-answer-finalizer.js finalizeGroundedAnswer`；`server/rag/grounded-answer-finalizer.js formatSupportedClaim`；`server/rag/grounded-answer-finalizer.js GROUNDED_ABSTENTION_TEXT`

> ⚠ 不要说'模型标错的来源一律不会留下'：全部被支持时 finalizer 不重写文本。另外评测时 finalizer 的拒答文本曾被算成'回答'（arxiv 3/36 实为拒答），后来统一用 classifyAgentAnswer。讲答题率时要用正确口径。

### Q7. 为什么不直接流式输出 token？ChatGPT 都是边生成边显示。

*L3 为什么不用 X / 怎么证明*

- finalizer 生成之后会删句，边生成边推，用户就会先看到后来被删掉的话
- 做法：token 留在服务端，每写完一句就用 finalizer 同一套校验检查已生成的前缀，通过才推 answer_draft
- 句号先于 [Source 1] 到达，所以要等标签和下一个字符都到了，才算一句写完
- 含模型没见过的链接的句子不推；以 NOT_IN_EVIDENCE 开头的回复不出草稿
- 模型重试或切换时发 answer_draft_reset
- 最终 result 和 /chat 的 body 逐字节相同，替换掉草稿

代码：`server/rag/answer-drafts.js createAnswerDraftReleaser`；`server/rag/answer-drafts.js findCompletePrefix`；`server/rag/agent-event-stream.js AGENT_EVENT_TYPES`

> ⚠ 不要说'推出去的不会撤回'。补检索可能换答案，也可能改成澄清。也不要说有延迟收益：第一次测 19 题里只有 1 题出过草稿，只早 7ms；修 bug 后合同题 21 次运行里 4 次有草稿，论文题 0 次。安全说法：保证的是'不展示未经校验的内容'。

### Q8. 多文档对比怎么防止把 A 的数值安到 B 头上？为什么你说模型自己写的对比答案经常被模板替换？

*L2 为什么*

- 每份文档独立召回，至少 2 份文档有证据才答
- analyzeComparison 用词项 Jaccard 和句子重叠判近重复，再用双向蕴含判'无实质差异'，可以直接短路、不调模型
- 模型答案要同时满足：非空；有 Differences 段；claim 都经过检查且全文都被支持；被支持的差异 claim 引用覆盖证据包里的每一份文档
- 不满足就换按证据拼的模板，模板也不过就拒答
- modelRejectReason 只进 trace，只有代码和计数
- qwen2.5:7b 的对比答案实测全被拒，原因是 Summary/Agreements 段没引用、差异值被改写

代码：`server/rag/answer-writer.js assessStructuredDifferenceAnswer`；`server/rag/answer-writer.js buildGroundedDifferenceAnswer`；`server/rag/comparison-engine.js analyzeComparison`；`server/rag/comparison-equivalence.js evaluateBidirectionalEvidenceEntailment`

> ⚠ 讲'对比 100% 拒答修到 18/18'的故事时，必须补一句：现在通过的对比答案来自模板，模型写的版本在 7B 下仍全部被词法校验拒绝。

### Q9. 提示注入怎么防？为什么不上 Llama Guard 或 Prompt Guard 这类分类器？

*L3 为什么不用 X / 怎么证明*

- 三层
- 第一层：检索片段、文件名、网页结果进 prompt 前，screenUntrustedText 把对 AI 说话的句子替换成标记，中英文规则都有；评审 prompt 里的来源也过筛查
- 第二层：答案、网页回答、评审的 prompt 都声明证据是不可信数据
- 第三层：guardAnswerLinks 删掉 markdown 图片和含模型没见过链接的句子
- 用户看到的引用保留原文
- 规划器看不到文档正文，注入改不了要调哪个工具
- 不先上分类器：多一次模型调用；确定性筛查在良性语料上误判 0 句；分类器可以作为第四层叠加，但没测过

代码：`server/rag/prompt-injection-screen.js screenUntrustedText`；`server/rag/prompt-injection-screen.js guardAnswerLinks`；`server/rag/answer-writer.js UNTRUSTED_EVIDENCE_RULES`

> ⚠ 不要说'防住了提示注入'。筛查是模式匹配，刻意改写的英文载荷在文档 RAG 出口 3/3 绕过；用例只有 13 个、是自建的，没有跑过 BIPIA 或 AgentDojo。

### Q10. （追问）你说 Agent 路径攻击 0/39，怎么证明不是因为 Agent 本来就大多拒答？

*L3 为什么不用 X / 怎么证明*

- 对，Agent 路径的 0/39 要打折看：7B 下它大多以澄清结束（对照组改前 0/12、改后 2/12 得到回答），攻击进不了答案很大程度上是答案被扣下了
- 真正能说明问题的是文档 RAG 出口（MCP archive_ask 原样返回，不经过自检）：17/39→0/39
- 受攻击时仍给出正确事实：22/30→30/30
- 对照组正确率 9/12 不变，说明没有误伤
- 分层看：只加 prompt 规则时，指令覆盖类仍 9/9 成功，起决定作用的是确定性筛查

代码：`server/rag/prompt-injection-screen.js SENTENCE_RULES`

> ⚠ 主动说明 Agent 路径改前进入答案的 4 次都是原样照抄的金丝雀串，词法校验会接受它，因为它就在证据里。词法校验本身不防注入。

### Q11. 补检索怎么做的？为什么只一轮？为什么不用 Self-RAG、CRAG 那种迭代？

*L3 为什么不用 X / 怎么证明*

- 只在'答了但没过校验'时补检索；主答拒答不补
- 最多 1 轮（DEFAULT_AGENT_MAX_FOLLOW_UPS=1），3 条检索查询（补检索问题文本 + 2 条修复查询），预算 maxDocumentRagCalls 2
- 补检索不写会话记忆（memoryWrites:false）
- 两轮结果用 selectBetterRagResult 选优，仍不通过就返回澄清
- 不用 Self-RAG：需要微调出反思 token
- 不用 CRAG：要额外的评估器，而且 Web 兜底在本项目是要审批的单独阶段
- 不用开放循环：成本和步数没有上限
- 坦白一个缺陷：默认补检索拿 'Re-check the uploaded documents…' 元文本当问题和主查询，61 次只过 1 次。修复开关 AGENT_FOLLOW_UP_ORIGINAL_QUESTION 单开也没多答出题，所以默认没改

代码：`server/rag/agent-document-loop.js runDocumentRagLoop`；`server/rag/self-check/gaps.js buildFollowUpQuestion`；`server/rag/agent-query-planner.js buildAgentRetrievalPlan`；`server/rag/self-check/evaluate.js selectBetterRagResult`

> ⚠ 不要把补检索说成有效的修复手段。默认路径下它几乎不起作用，真正的瓶颈是词法校验。

### Q12. 你做了评审、模型自判、override、7 个答题率开关，结果全部默认关闭。这些是不是白做了？你怎么决定开不开？

*L3 为什么不用 X / 怎么证明*

- 每轮测量前都先写好采用规则，之后没改：回答的可答题要多于基线（第二轮起要求区间不含 0）；F1 不能显著变差；不可答题被回答数不超过基线（基线为 0 时必须仍为 0；dev 阶段上限是'基线 + 1'）；候选还要过护栏（评审对照集、answer-drafts 合同题、verify:quality 18/18）
- 第一轮：只开评审 10/41 但不可答 0/9→2/9；全开 + 评审 17/41 但不可答 4/9，没有候选
- 第二轮开发集：答题率 0→0.363，显著；但不可答题被回答 0/9→2/9，超过'基线 + 1'的上限
- 用户要求补跑护栏：verify:quality 14/18，没通过
- 第三轮 override：train 上不可答题 1/7，第一阶段就没过
- 收获：先纠正了评测口径（classifyAgentAnswer）；定位到瓶颈是词法校验加 7B 模型；换更强的模型时开关可以直接重测

代码：`server/rag/config.js describeAnswerRateFlags`；`server/rag/answer-verdict-override.js overrideNotInEvidenceVerdict`；`server/evaluation/agent-answer-outcome.js classifyAgentAnswer`

> ⚠ 既不要说'开了更好'，也不要说'白做'。安全说法：'每轮都能把答题率拉到两三成到四成、F1 显著上升，但都会多答 1–4 道不可答题，按事先定的规则不改默认。规则没有因为结果不好看而改。'

### Q13. （追问）你的 override 规则是看着 verify:quality 的失败样例写的，这不是在过拟合评测集吗？

*L3 为什么不用 X / 怎么证明*

- 是，我在文档里明确写了：hedge 后半句那条规则是看过 verify:quality 的拒答形状之后写的，所以 verify:quality 不能当它的独立证据
- 独立判断要看新样本 QASPER：判断 42 次，作答 0 次，说明它在 QASPER 上基本不触发
- 那道被误答的不可答题走的是普通作答路径，和 override 无关
- 另做过独立审查：用合成反例攻击规则，堵住 7 类情况（多子问题、别的实体、复述问题、指向'见附表'、名词短语后半句、注入删掉的句子等），每条都先写了修复前失败的测试

代码：`server/rag/answer-verdict-override.js overrideNotInEvidenceVerdict`；`server/rag/answer-verdict-override.js extractQuestionNames`

> ⚠ 要主动承认还有已知漏洞：同一主题另一方面的、有引用的事实，在问题没有 anchor 和名称时仍会被当成答案；小写写的实体名不算名称；单个问题只答了一部分也会通过。

### Q14. prompt 改了怎么追溯是哪一版产生的答案？

*L2 为什么*

- definePrompt 给每个模板生成 id@version#fingerprint，fingerprint 是未渲染模板原文 SHA-256 的前 12 位
- 描述符随每次模型调用进入 LLMOps 事件、模型 span、运行的 prompt 清单、规划器决策和评测报告
- 测试钉住每个 id@version 对应的 fingerprint；改了模板不升版本号，测试失败
- 发布门要求所有发布报告用同一组 prompt（hashPromptSet 算出的 setHash，buildPromptLineageCheck）
- 事件里永远不带 prompt 原文

代码：`server/rag/prompt-registry.js definePrompt`；`server/rag/prompt-registry.js hashPromptSet`；`server/rag/prompt-catalog.js describeActivePromptTemplates`；`server/test/prompt-registry.test.mjs PINNED_PROMPT_TEMPLATES`；`server/evaluation/release-evidence-gate.js buildPromptLineageCheck`

> ⚠ 现在代码里是 11 个 prompt id、19 个钉住的 id@version，CURRENT-TRUTH 写的 10/16 已经过时。这套只做归因，没有线上 A/B 或灰度。

### Q15. QPS 放大 100 倍，这条自检链路哪里先扛不住？如果评审模型挂了、超时或者输出乱码，会发生什么？

*L4 边界 / 规模 / 重做*

- CPU：claim 校验是 agent 层的热点。memo 之后每个 /chat 约 5 ms 应用 CPU，但这是假模型、短答案上测的，真实长答案 claim 更多，没测
- 拆分部署时 agent 层占总 CPU 62–67%，要单独水平扩 agent 层
- 评审开启时每个答案多一次模型调用（已是每个答案一次批量）。缓存按租户分区（进程内 500 条，Redis 7 天）；模型调用有并发上限和熔断
- 100 倍时可以做的：切句和数字归一化提前到入库时预计算；评审跨请求合批或换小模型；打开已有的模型网关和按 workspace 配额（默认关）
- 故障：评审调用异常或超时时 status=failed，保留词法结论；输出解析不出的 claim 也保留词法结论，不影响作答
- 筛查误删真事实时，RAG_INJECTION_SCREEN=off 是总开关；给用户的引用本来就保留原文
- 模型 5xx 时按依赖故障返回 503/504，不会伪装成'证据不足'

代码：`server/rag/self-check/evidence-context.js memoizeInEvidenceContext`；`server/rag/self-check/claim-judge.js judgeClaimSupport`；`server/rag/config.js getPromptInjectionScreenMode`

> ⚠ 不要说'memo 让吞吐提升 2.6 倍所以能扛'。那是单机、假模型 0ms 的数，真实瓶颈是模型调用。memo 故意只在一次 /chat 内有效，不能为了提速改成跨请求缓存，否则有跨租户泄露的风险。

### Q16. 如果让你重做这一块，你会改什么？

*L4 边界 / 规模 / 重做*

- 让模型用结构化输出直接给出 claim 列表和对应的来源片段 id，而不是从自由文本里用正则切句、猜引用
- 用人工标注的真实答案校准一个 NLI 或 LLM 评审，报 kappa，再考虑替换 token 重叠规则
- 默认补检索不再用元文本当问题
- 区分'能不能答'和'怎么答'：单独训练或校准一个可答性判别信号，而不是靠词面覆盖率
- 更早接真实模型和外部标注集（QASPER），少做一些不改默认的开关
- 对比路径改为先让模型输出逐文档的值绑定（结构化），再由引擎渲染文本

代码：`server/rag/self-check/claims.js splitAnswerStructure`；`server/rag/self-check/gaps.js buildEvidenceRetryQuestion`

> ⚠ 不要说'换成 LangChain 或 LlamaIndex 就解决了'。框架不解决校验精度问题。要说出具体换什么信号、用什么数据证明。

## 可以引用的数字

| 说什么 | 数字 | 出处 | 前提 / 注意 |
| --- | --- | --- | --- |
| 端到端质量检查（纯 RAG 路径） | 18/18（修复前 16/18） | CURRENT-TRUTH 3.2；§4「Agent 路径的答题率」 | 真实 qwen2.5:7b；不经过 agent 自检；现在通过的对比答案来自模板 |
| QASPER 答案官方 F1 基线 | 0.206；可回答题拒答 41.7%；不可回答题识别 85% | CURRENT-TRUTH 3.12 | dev 200 题，qwen2.5:7b，文档 RAG 路径 |
| QA 下限 0.51 降到 0.2 | F1 0.206→0.153，配对 −0.053 [−0.101, −0.009] 显著变差；不可回答题识别 85%→15% | CURRENT-TRUTH 3.12；docs/evaluation.md「拒答门控调参」 | train 调参、dev 验证；结论是不改默认 |
| 词面门控信号的区分能力 | AUC 约 0.59–0.61（train 门控信号 0.59–0.60，离线词面信号 0.59–0.61；dev 门控层面约 0.63） | CURRENT-TRUTH 3.12；docs/evaluation.md「拒答门控调参」「两段式拒答」 | QASPER 的不可回答题大多是'论文没报告这个细节'，这是词面信号的天花板 |
| 答案变短（qa_answer v2.2） | F1 0.206→0.231，配对 +0.025 [+0.013, +0.037] 显著 | CURRENT-TRUTH 3.12；docs/evaluation.md「答案变短」 | 同一组 200 题；拒答不变 |
| selectQaContext 判定与上下文分开 | 证据进上下文 0.245→0.353（+0.108 [+0.088, +0.130]）；F1 0.235→0.249（+0.014 [−0.000, +0.029]）不显著 | docs/evaluation.md「门控：判定和上下文分开」 | 上下文指标，不是引用指标；检索 821 题、答案 200 题 |
| 答案实际引用 vs 上下文 | 上下文有证据 0.596，引用的页有证据 0.490，差 −0.106 [−0.164, −0.048] 显著；引用精度 0.321 | CURRENT-TRUTH 3.23；docs/evaluation.md「引用证据」 | 作答的可回答题 n=104；QASPER 每题只标一两段证据，0.32 不能读成错引率 |
| Claim 评审在构造集上 | 正确改写接受：词法 3/42，加评审 39/42；错误接受 0/42；留出集 10/12 和 0/12 | docs/evaluation.md「Claim 评审：校准与端到端」 | 构造集 14+14 条 × 3 轮、留出 4+4 条 × 3 轮；标签由构造保证，不是人工标注；评审是同一个 7B 模型 |
| 开评审的端到端合同题 | 3/21→14/21 得到回答，14 个全对；p50 1150→1985 ms | docs/evaluation.md「Claim 评审：校准与端到端」 | 7 题 × 3 轮，样本小 |
| Agent 路径答题率（QASPER train） | 评审关：可答题 0/41；只开评审：10/41，但不可答题被回答 0/9→2/9；全开加评审：17/41，不可答题 4/9 | CURRENT-TRUTH 3.21；docs/evaluation.md「Agent 答题率开关」 | 50 题（41 可答 / 9 不可答），配对 bootstrap；没通过事先定的规则 |
| 第二轮开发集确认 | 答题率 0→0.363（+0.363 [0.264, 0.462]）；不可答题 0/9→2/9；候选配置下 verify:quality 14/18 | CURRENT-TRUTH 3.21 | 2/9 的区间含 0，但超过'基线 + 1'的上限，所以不通过 |
| 拒答标记 override（第三轮） | QASPER 上判断 42 次，作答 0 次；train 不可答题 0/7→1/7（走的是普通作答路径） | CURRENT-TRUTH 3.21 | 规则看过 verify:quality 的样例，那份数据不是它的独立证据 |
| 两段式拒答（补救区 + 模型自判） | F1 0.231→0.242，+0.010 [−0.027, +0.048] 不显著；可回答题拒答 +10.0pp [+2.2, +18.1]，显著变差 | docs/evaluation.md「两段式拒答」；CURRENT-TRUTH 3.12 | dev 200 题；加扩大检索重试后 F1 0.247（+0.015 [−0.026, +0.056]）仍不显著，拒答回到 41.1%，但不可回答题识别 85%→70% |
| 校验过的流式草稿 | 合同 7 题里 1 题有草稿（只早 7ms），论文 12 题 0 题；修 bug 后合同题有草稿的运行 2/21→4/21 | CURRENT-TRUTH 3.7；docs/evaluation.md「校验过的答案草稿」「校验器的两个 bug」 | 瓶颈在校验器，没有实际延迟收益 |
| 提示注入红队 | 文档 RAG 攻击成功 17/39→0/39；Agent 4/39→0/39；良性 16,001 句误判 0；刻意改写（文档 RAG 出口）3/3 绕过 | CURRENT-TRUTH 3.10；docs/evaluation.md「Prompt 注入红队」 | 自建 13 个用例、每组 3 轮；Agent 的 0/39 要打折看 |
| Claim 校验 memo | 每请求应用 CPU 约 12–13 ms → 约 5 ms；并发 32 时吞吐约 2.6 倍 | CURRENT-TRUTH 3.24；docs/evaluation.md「Claim 检查 memo」 | 单体、假模型 0 ms、短答案；真实长答案没测 |
| Prompt 归因 | 35/35 个 completion 事件能归到模板（改前 0） | CURRENT-TRUTH 3.9 | 样本小，只说明能归因 |
| 重排概率做拒答门 | 可回答题拒答 37.8%→13.9%；不可回答题识别 80%→45%；F1 0.257→0.261 不显著 | CURRENT-TRUTH 3.14b | 需要开交叉编码器重排服务 |
| 对比答案门（7B） | 进门的模型对比答案 6/6 判为 unsupported_claims，5 次退回模板、1 次拒答 | AGENTS.md「Comparison answer gate」（2026-10-04 实测） | qwen2.5:7b；verify:quality 1 次加 compare-hard 5 次 |
| 代码常量 | QA 覆盖下限 0.51；补救区下限 0.3；相关度下限 0.32；回退档系数 0.8；词重叠阈值 0.6；补检索最多 1 轮；documentRag 预算 2；模型拒答后重试检索 top 18；默认检索 topK 10（2026-10-29 前是 6）；评审单段证据最多 2000 字符；评审进程内缓存 500 条、Redis 7 天；近重复 Jaccard 0.75 / 句子重叠 0.6 | server/rag/config.js DEFAULT_MIN_QA_QUERY_TERM_COVERAGE / DEFAULT_QA_PARTIAL_COVERAGE_FLOOR / getMinRelevanceScore / DEFAULT_QA_VERDICT_RETRY_TOP_K / getRetrievalTopK；server/rag/confidence.js FALLBACK_THRESHOLD_RATIO；server/rag/self-check/patterns.js SUPPORT_TOKEN_OVERLAP_THRESHOLD；server/rag/agent-bootstrap.js DEFAULT_AGENT_MAX_FOLLOW_UPS；server/rag/agent-budget.js DEFAULT_AGENT_BUDGET.maxDocumentRagCalls；server/rag/self-check/claim-judge.js MAX_EVIDENCE_CHARS / CACHE_LIMIT / SHARED_VERDICT_TTL_MS；server/rag/comparison-engine.js NEAR_DUPLICATE_TERM_JACCARD / NEAR_DUPLICATE_SENTENCE_OVERLAP | 0.32 和 topK 10 是环境变量默认值，可覆盖 |

## 要主动说出口的边界

- 词法 claim 校验认不出语义等价的改写：正确改写只接受 3/42；本地 7B 下 agent 路径在 QASPER train 上可答题被回答 0/41
- verify:quality 18/18 测的是纯 RAG 路径，不经过 agent 自检，不能拿来说明 agent 的答题质量
- claim 自检和 finalizer 只在 agent /chat 路径上；MCP archive_ask 原样返回的单文档 RAG 答案只有门控、注入筛查和链接守卫
- LLM 评审默认关：没用人工标注校准（eval:judge 只有框架）；结论字段偶尔和自己的理由矛盾；QASPER 上会回答不可答题
- 对比路径在 qwen2.5:7b 下模型自己写的答案全部被拒，用户看到的是引擎模板；'**Differences**:'（冒号在加粗外）还不被识别成标题
- 词面门控 AUC 只有约 0.6，QASPER 上约四成可回答题被拒；相关度下限在 nomic 上实测不起作用
- 答案引用到的证据比上下文里的证据少，配对 −0.106，显著；引用精度 0.32
- 默认补检索把元文本当问题和主查询，几乎不起作用（61 次过 1 次）；修复开关默认关
- 流式草稿机制可用，但在当前校验器下几乎没有延迟收益
- 提示注入筛查基于模式匹配，刻意改写可以绕过（文档 RAG 出口 3/3）；用例只有 13 个、是自建的；没跑过 BIPIA 或 AgentDojo
- 近邻替换否决是纯词面的：下位词（recurrent network 对 neural network）也算替换；中文按单字配对
- 拒答标记 override 是看着 verify:quality 的失败样例写的，那份数据不是它的独立证据；QASPER 上作答 0 次；仍有已知漏洞（同一主题另一方面的事实、小写实体名）
- 只用本地 qwen2.5:7b 验证过，没有 GPT 级模型和生产流量的数据
- claim memo 的加速是在假模型、短答案上测的，真实长答案没测
- 代码里看到、还没测过影响：evaluateDocumentEvidence 要求引用覆盖 min(docIds 数, 2) 份文档。如果前端在多文档范围内把所有 docIds 发进来，单文档事实题可能被判 document_coverage 缺口，从而触发补检索或澄清，需要自己确认
- 多子问题只看覆盖率下限；单个问题只答了一部分（比如漏了条款的例外）也可能通过校验

## 只能当推理讲的内容

核验代理找不到代码或数据依据的条目。讲的时候用「我的判断是……，没测过」。

- 'LLM-as-judge 最容易在数字上放水'：只有 claim-judge.js 注释里的设计判断，没有直接对照测量；已改为'设计判断'并附上实测的 6 次错数字拦截
- Self-RAG 需要微调反思 token、CRAG 需要额外检索评估器：属于对外部方法的一般性描述，仓库里没有对这两者的实现或测量，只能作为不选的理由，不能说'测过不如'
- '评审已是每个答案一次批量调用'以外的扩容方案（入库时预计算切句和数字归一化、跨请求合批）：是提议，代码里没有，也没测
- '删句后可能不连贯'：设计层面的推断，没有可读性评测
- '代码里看到、还没测过影响：evaluateDocumentEvidence 要求引用覆盖 min(docIds 数, 2) 份文档'：代码行为已确认（evaluateAnswerEvidence requiredDocCoverage），但它对多文档范围内单文档问题答题率的实际影响没有测量，保留为待确认

## 容易记错的地方

第一遍阅读（主要依据 AGENTS.md 和文档）写错、被核验代理对照代码改正的说法。这些正是读文档容易产生的误解。

- **requestFlow 第 5 步**
  - 原以为：buildAgentRetrievalPlan（phase follow_up：原问题加 2 条修复查询）
  - 实际：主查询就是补检索问题文本（默认是 buildEvidenceRetryQuestion 的元文本，里面带原问题），再加 2 条修复查询，共 3 条
  - 依据：server/rag/agent-document-loop.js 把 followUpQuestion 作为 question 传给 buildAgentRetrievalPlan；server/rag/agent-query-planner.js buildIntentQueries 的 follow_up 分支 baseQueries 用的是传入的 question
- **decisions[8]（模型自判拒答）evidence 与 numbers「两段式拒答」**
  - 原以为：只开标记：F1 0.231→0.242，配对 +0.010 [−0.027, +0.048] 不显著；可回答题拒答 +10pp
  - 实际：RAG_QA_ANSWER_VERDICT=true（补救区 + 模型标记）：F1 0.231→0.242……；只加模型判定、不开补救区时 F1 0.235、拒答 58.3%
  - 依据：docs/evaluation.md「两段式拒答」表：'只加模型判定' 列是 0.235 / 58.3%，0.242 / +10pp 是 '补救区 + 模型判定' 列
- **decisions[3]、questionLadder（评审可靠性）、numbers「Claim 评审在构造集上」**
  - 原以为：构造集 42 条加留出集 12 条
  - 实际：构造集 14 条正确改写 + 14 条错误 claim × 3 轮 = 42 次判定；留出集 4+4 条 × 3 轮 = 12 次
  - 依据：server/evaluation/run-claim-judge-eval.mjs CLAIM_JUDGE_CONTRAST_SET（14 supported / 14 unsupported）、CLAIM_JUDGE_HELD_OUT_SET（4/4），默认 --rounds 3
- **decisions[3] why、questionLadder L4（100 倍）**
  - 原以为：超时或解析失败时 status=failed，保留词法结论
  - 实际：调用异常/超时时 status=failed；输出解析不出某条 verdict 时该条保留词法结论（status 可能仍是 judged）
  - 依据：server/rag/self-check/claim-judge.js judgeClaimSupport：只有 catch 分支写 summary.status = "failed"；parseVerdicts 解析不出时 verdicts 为空，claim 原样返回
- **questionLadder（finalizer 删句）与 requestFlow 第 7 步**
  - 原以为：formatSupportedClaim 把来源标签改写成已验证的 rank，模型标错的来源不会留下
  - 实际：全部 claim 被支持时原文原样返回；只有存在不被支持的 claim 时才重建文本并改写成已验证的 rank
  - 依据：server/rag/grounded-answer-finalizer.js finalizeGroundedAnswer：unsupportedClaims.length === 0 且有证据 claim 时返回 { text, changed: false }
- **elevatorPitch、questionLadder（开关）trap**
  - 原以为：每轮都会多答一两道不可答题
  - 实际：每轮都会多答 1–4 道不可答题
  - 依据：CURRENT-TRUTH 3.21：第一轮全开 + 评审不可答题被回答 4/9；A1 2/9；第二轮 dev 2/9；第三轮 1/7
- **elevatorPitch、questionLadder L1、limitations**
  - 原以为：未说明自检/finalizer 的适用范围
  - 实际：补充：claim 自检和 finalizer 只在 agent /chat 路径；MCP archive_ask 原样返回的单文档 RAG 答案不经过自检
  - 依据：docs/evaluation.md「Prompt 注入红队」：'文档 RAG 答案（chat()，即 MCP archive_ask 原样返回的内容，不经过 Agent 自检）'；writeQaAnswer 内无 evaluateClaimSupport 调用
- **requestFlow 第 8 步**
  - 原以为：通过的句子先 formatSupportedClaim，再过 guardAnswerLinks，然后 emitAgentEvent(answer_draft)
  - 实际：如果 guardAnswerLinks 会删掉该句中的链接，这句不推；否则 emitAgentEvent(answer_draft)
  - 依据：server/rag/answer-drafts.js createAnswerDraftReleaser：guardAnswerLinks(...).removed.length > 0 时 text 置空，不 emit
- **requestFlow 第 9 步**
  - 原以为：alignComparisonEvidence 之后 analyzeComparison 判近重复和双向蕴含
  - 实际：alignComparisonEvidence → prepareComparisonSourceBundle，再由 buildComparisonAnalysisFromContexts（内部调 analyzeComparison）判近重复、双向蕴含和数值冲突
  - 依据：server/rag/document-rag-execution.js executeComparisonRag 调 buildComparisonAnalysisFromContexts；server/rag/comparison-analysis-summary.js 内调 alignComparisonEvidence
- **requestFlow 第 3 步、questionLadder L2、decisions[0] tradeoff、limitations**
  - 原以为：未提相关度下限实测不起作用
  - 实际：补充：相关度下限在 nomic 上 0.2–0.6 之间不影响结果，起作用的只有覆盖率；门不过时 buildQaGapPlan 可能跑补充检索但只用于说明
  - 依据：docs/evaluation.md「拒答门控调参」：'相关度下限不起作用'；document-rag-execution.js buildQaGapPlan 调 searchGlobalContext
- **decisions[0] alternativesRejected**
  - 原以为：0.2 时 F1 显著变差，5 个相邻话题测试翻转
  - 实际：阈值 ≤0.5 会让 5 个行为测试翻转，其中 2 个是真实的相邻话题退化
  - 依据：docs/evaluation.md「拒答门控调参」：'只要问答阈值不高于 0.5，就有 5 个行为测试翻转。其中两个是真实的相邻话题退化'
- **decisions[7] evidence、questionLadder（注入）trap、numbers 提示注入**
  - 原以为：evasion_paraphrase 改前改后都是 3/3 成功
  - 实际：evasion_paraphrase 在文档 RAG 出口改前改后都是 3/3 成功（Agent 路径 3/3→1/3）
  - 依据：docs/evaluation.md「Prompt 注入红队」绕过测试
- **questionLadder（流式）trap**
  - 原以为：实测 19 题里只有 1 题出过草稿，而且只早 7ms
  - 实际：第一次测 19 题里 1 题出过草稿、只早 7ms；修 bug 后合同题 21 次运行里 4 次有草稿，论文题 0 次
  - 依据：docs/evaluation.md「校验器的两个 bug」表：有草稿的运行 2/21→4/21，arxiv 0/36
- **questionLadder L4（100 倍）answerPoints**
  - 原以为：评审批量调用或换小模型；模型网关做配额
  - 实际：评审已是每个答案一次批量调用，可跨请求合批或换小模型；打开已有的模型网关和按 workspace 配额（默认关）
  - 依据：server/rag/self-check/claim-judge.js judgeClaimSupport 把所有 uncached items 拼进一个 prompt；AGENTS.md「Model gateway」/ MODEL_QUOTA_ENABLED
- **questionLadder（开关）answerPoints**
  - 原以为：采用规则：可答题答题率要显著上升，不可答题被回答不能增加……
  - 实际：按轮写清：第一轮'回答的可答题多于基线、F1 上界 ≥ 0、不可答数不超过基线'；第二轮起答题率区间不含 0、基线为 0 时必须为 0、dev 上限'基线 + 1'；候选还要过护栏
  - 依据：docs/evaluation.md「Agent 答题率开关」规则与「第二轮」规则
- **questionLadder L3 codeRefs**
  - 原以为：server/rag/agent-execution-plan-runner.js shouldRunWeb
  - 实际：server/rag/agent-execution-plan-runner.js state.shouldRunWeb（是状态字段，不是函数）
  - 依据：grep：agent-execution-plan-runner.js 第 388 行 state.shouldRunWeb = ...，没有同名函数
- **questionLadder（对比）answerPoints、decisions[6] why**
  - 原以为：差异 claim 引用覆盖每一份文档
  - 实际：被支持的差异 claim 引用覆盖证据包（bundle.citations）里出现的每一份文档，且至少 2 份；另有非空和 claims_not_checked 条件
  - 依据：server/rag/answer-writer.js assessStructuredDifferenceAnswer：selectedDocIds 来自 bundle.citations，selectedDocIds.size < 2 也拒
- **decisions[2] alternativesRejected**
  - 原以为：也最容易在数字上放水
  - 实际：标为 claim-judge.js 注释里的设计判断；实测是数字规则在评审前挡下 6 次错数字
  - 依据：server/rag/self-check/claim-judge.js 文件头注释；docs/evaluation.md「Claim 评审」'数字规则在评审前挡下了 6 次错数字'
- **keyFiles**
  - 原以为：comparison-engine.js / comparison-equivalence.js、prompt-registry.js / prompt-catalog.js 合在一条路径
  - 实际：拆成独立条目，并补 self-check/text.js（normalizeGroupedSourceLabels 实际定义处）、release-evidence-gate.js（buildPromptLineageCheck）、evaluation/agent-answer-outcome.js（classifyAgentAnswer）
  - 依据：grep：normalizeGroupedSourceLabels 定义在 server/rag/self-check/text.js:415；buildPromptLineageCheck 在 server/evaluation/release-evidence-gate.js
- **numbers「代码常量」**
  - 原以为：相关度 0.32 无代码出处；documentRag 预算写成 agent-budget.js maxDocumentRagCalls
  - 实际：补 config.js getMinRelevanceScore（默认 0.32）、getRetrievalTopK（默认 6）、DEFAULT_AGENT_BUDGET.maxDocumentRagCalls、claim-judge.js CACHE_LIMIT / SHARED_VERDICT_TTL_MS、comparison-engine.js 近重复阈值
  - 依据：server/rag/config.js 第 915–916、875–876 行；server/rag/agent-budget.js DEFAULT_AGENT_BUDGET；claim-judge.js 第 50、57 行
- **staleInExistingDocs**
  - 原以为：无
  - 实际：新增 FAQ #7（交叉编码器已在 QASPER 测过）、CURRENT-TRUTH §2 默认配置行（sparse 已是 BM25）、§4 租户隔离（strict 模式和角色拆分已有）、180 秒稿'没有 OCR'（auto 有 ocr 路由）
  - 依据：INTERVIEW-FAQ.md #7 原文；CURRENT-TRUTH.md §2 末行与 3.14a、3.18；AGENTS.md POSTGRES_TENANT_CONTEXT / 角色拆分、PDF_PARSER=auto ocr 路由
