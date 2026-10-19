# 现有面试材料里过时或说大了的句子

> 回到 [总手册](../DEEP-DIVE-PLAYBOOK.md)。红队代理逐句对照当前代码、AGENTS.md 和 CURRENT-TRUTH.md 核对。按 AGENTS.md 的约定，先改 CURRENT-TRUTH.md，再改讲述稿和 FAQ。

## 汇总清单

### 180-SECOND-NARRATIVE.md

1. 原句：「运行状态持久化在 PostgreSQL，崩溃后可以从 checkpoint 在节点边界续跑，并用版本号 CAS 防止两个 worker 重复执行有副作用的步骤。」
   - 问题：说大了。自动续跑只覆盖外层只剩 custom_skills 的 guarded 图（agent-run-recovery.js hasGraphOnlyStoredExecutionPlan）、v3 guarded run 和无图 checkpoint 的 V1 custom_skill 步骤；主 document_rag 在途会转人工。CAS/claim 挡的是旧 worker 的状态写，不是已发出的副作用。另外整段没提 LangGraph 迁移和外层留在原生循环
   - 改法：改为：运行状态在 PostgreSQL，只在能证明安全时在节点边界续跑；有副作用的步骤不自动重放，写入靠幂等键，旧 worker 的状态写被版本号 CAS 挡住。补一句：custom-Skill DAG 和 v3 图由 LangGraph.js 调度，外层计划因压测 +17.6% 不过门留在原生循环
2. 原句：「有缺口就补检索一轮（最多 3 条查询）」
   - 问题：没说默认补检索拿「Re-check the uploaded documents…」元文本当问题和主查询，诊断时 61 次只过 1 次；修复开关 AGENT_FOLLOW_UP_ORIGINAL_QUESTION 单开也没多答题（CURRENT-TRUTH 3.21）
   - 改法：保留机制描述，但别把补检索讲成有效修复手段；被问到时补充 61 次过 1 次的诊断和开关结果
3. 原句：「启发式 reranker 在真实 embedding 下没有带来提升，全量上还降了约 5 个点，这也是它默认关闭的依据。」
   - 问题：−0.049 [−0.115, +0.014] 不显著，原句没标；而且交叉编码器已在 QASPER dev 上测过（3.14a），不再只是启发式
   - 改法：改为：启发式重排没有带来提升（−0.049，不显著）；交叉编码器在 QASPER 上让上下文证据 +0.063 显著，但 F1 不显著，又要单独服务，所以默认关
4. 原句：「但 48 条用例的置信区间还跨 0」
   - 问题：只讲了 48 条用例；QASPER dev 821 题已给出结论：hybrid 只显著好于 BM25（+0.074），和稠密没有显著差异（+0.006）
   - 改法：补上 QASPER 结论，以它为主：「外部标注的 821 题上，hybrid 显著好于单用 BM25，和纯稠密没有显著差异」
5. 原句：「修完之后端到端检查从 16/18 到 18/18。」
   - 问题：缺关键事实：现在通过的对比答案来自引擎模板，qwen2.5:7b 自己写的对比答案进门后 6/6 判为 unsupported_claims（AGENTS.md「Comparison answer gate」2026-10-04）
   - 改法：补一句：现在对比题是靠按证据拼的模板通过的，7B 自己写的对比答案仍会被词法校验拒绝
6. 原句：「目前只处理 PDF 文本层，没有 OCR 和表格」
   - 问题：已有 PDF_PARSER=docling 和 PDF_PARSER=auto（按页把表格页/扫描页送 docling-serve），还有 pdf.js worker 池；只是默认仍是 pdf.js，测下来没有显著收益
   - 改法：改为：默认只读文本层；版面解析和按页分流是可选项，30 篇论文上答案 F1 没有显著差异，OCR 只在 1 份手工扫描件上验证能走通
7. 原句：「评测集还小，正在接 QASPER 扩到几百题。」
   - 问题：已完成：QASPER dev 检索 821 题、答案抽样 200 题，每周 Ollama CI 跑 200 题检索（CURRENT-TRUTH §4、3.14）
   - 改法：改为：外部标注的 QASPER 已接入（检索 821 题、答案 200 题），仍只用了一个 7B 模型
8. 原句：「打开后合同题回答率从 3/21 到 14/21 且全对，但还没用人工标注校准，所以默认关闭」
   - 问题：漏了更直接的默认关理由：QASPER train 只开评审时不可答题被回答 0/9→2/9（全开 4/9），三轮都没过事先定的规则（3.21）
   - 改法：补一句：在 QASPER 上开评审会回答不可答题，按事先定的规则不改默认

### INTERVIEW-FAQ.md

9. 原句：「执行规划器只能在本次请求选中的步骤里挑。」
   - 问题：默认 guarded 下，有已授权原子 Skill 时 getSelectedExecutionStepIds 会加入 custom_skills，LLM 可以给意图没选 custom Skill 的请求加上这个阶段（3.5）；另外执行规划器对未选中阶段是静默丢弃（normalizePlannerPayload），「整图拒绝不清洗」只适用于 DAG
   - 改法：改为：执行规划器只能在本次可用的阶段里挑（guarded 下含已授权的 custom_skills），未选中的阶段被丢弃；伪造运行时字段整图拒绝只针对 DAG
10. 原句：「思路和 Temporal、LangGraph checkpointer 类似」
   - 问题：已经真的用了 LangGraph：自定义 RunStoreCheckpointSaver 写现有 run 行；v3 审批走 interrupt + Command(resume)。另外矩阵是运行时按步骤类型登记的（STEP_REPLAY_SAFETY_MATRIX），Skill 声明只能收窄，「由 Skill 契约声明」不准
   - 改法：改为：custom-Skill DAG 和 v3 图由 LangGraph 调度，checkpointer 写现有 run 行，权威仍是自己的图 checkpoint；能否自动重放由运行时矩阵决定，Skill 声明只能收窄
11. 原句：「启动时只在节点边界自动续跑，而且要求没有待审批项、checkpoint 与已持久化的步骤对账一致。」
   - 问题：漏了前提：custom-Skill 图要求外层计划只剩 custom_skills，v3 还要 rollout 仍是 guarded 且线程核对通过；非图 run 只有 custom_skill 能重放；主 document_rag 在途转人工；V1 待审批 run 被打 manual 标记
   - 改法：补上自动续跑的三种情形，并明确「普通文档问答 run 不自动续跑」；再主动说 run 没有租约，多实例重启会误判（读代码推断）
12. 原句：「长期记忆和经验记忆（只作为规划提示，永远不作为证据或引用）」
   - 问题：长期偏好会进追问改写 prompt 和答案 prompt 的偏好块；经验记忆能重排或补入白名单意图候选（applyExperienceHintsToCandidates），会改变确定性规划器的选择；还漏了只记用户自己的话（memoryWrites:false、runWithoutConversationMemoryWrites）、会话键按租户哈希、LONG_MEMORY_SCOPE=workspace
   - 改法：改为：记忆永远不作证据或引用；长期偏好会影响改写和答案风格；经验记忆只作规划提示；只记录用户自己说的话，会话键按租户派生
13. 原句：「sparse（PostgreSQL 全文检索，不是 BM25）」
   - 问题：默认已是 Okapi BM25（rag/config.js DEFAULT_SPARSE_SCORING = "bm25"，迁移 029/030），ts_rank_cd 仍可选
   - 改法：改为：sparse 默认是在 PostgreSQL 里自建统计的 Okapi BM25，可切回 ts_rank_cd；QASPER 上两者没有显著差异，默认是产品决定
14. 原句：「真实 embedding 下全量 Recall@5：hybrid 0.71、dense 0.65、BM25 0.66。」
   - 问题：这是 48 条用例；QASPER dev 821 题上 hybrid−dense 不显著，只显著好于 BM25
   - 改法：以 QASPER 为主：hybrid 0.517、dense 0.511、BM25 0.442；结论「比单用 BM25 好」；48 条作为历史补充
15. 原句：「神经交叉编码器的接入已经有了，下一步在更大的评测集上测它。」
   - 问题：已在 QASPER dev 上测过（3.14a、3.14b）：上下文证据 +0.063 显著、F1 不显著、可答拒答 −4.4pp 显著；作为概率门时不可答识别 80%→45%
   - 改法：改为已测结论，并说明默认关是因为要单独的模型服务且 F1 不显著
16. 原句：「上线前要用人工标注的真实答案报告 kappa。」
   - 问题：还应补上 QASPER train 上开评审会回答不可答题（0/9→2/9，全开 4/9），这是默认关的直接证据（3.21）
   - 改法：在这一题末尾补上 3.21 的结论
17. 原句：「这些都能在本地用真实模型复现。」
   - 问题：轨迹、planner mock、recovery 用的是脚本化 ragService 或 mock provider；只有 verify:quality、QASPER、planner --provider real、红队用真实模型；也没提 QASPER、cited/context 拆分、同 SHA 门
   - 改法：改为：效果层用真实模型 + 外部标注的 QASPER + 配对 CI；契约层（轨迹、规划 mock、恢复）用 mock，只证明编排行为
18. 原句：「换成真实 embedding 后结论完全反过来」
   - 问题：排序确实反过来，但 48 条上 hybrid−BM25 +0.054 [−0.038, +0.149] 不显著，显著性来自 QASPER
   - 改法：改为：伪 embedding 下的排序是错的，不能用来做架构决策；真实 embedding 下的显著结论来自 QASPER
19. 原句：「下一步是换成 NLI 或校准过的 LLM 评审。」
   - 问题：LLM 评审已实现（RAG_CLAIM_JUDGE=llm，默认关）并在构造集上校准；之后又做了拒答标记、override 和 7 个开关，三轮都没过规则（3.21）；NLI 没做
   - 改法：改为：评审已做但没过 QASPER 规则，默认关；NLI 仍是候选，没测
20. 原句：「一轮 6 个用例的规划器评测约 14 秒」
   - 问题：现在 createDefaultPlannerCases 是 7 个用例（新增 planner_unified_graph，3.30 为 7/7）；14 秒是 6 用例时的历史值
   - 改法：注明「6 个用例时测的」，或重测 7 用例后更新
21. 原句：「调用深在检索服务里也能通过 AsyncLocalStorage 记到发起它的运行上」
   - 问题：只在单体同进程成立；拆分部署时检索层在答案里带 usage，由 remote-retrieval.js chargeRetrievalUsage 记账，网关调用由调用方写 model_gateway_mirror 事件
   - 改法：改为：单体里靠 AsyncLocalStorage；拆分时检索层回传 usage、网关写 mirror 事件，所以运行上限跨层也成立
22. 原句：「检索服务深处的模型调用自动挂在发起它的 Skill 下面，不用一层层传参」
   - 问题：同上，跨进程靠 service-client.js 注入 W3C traceparent、接收端 bindServiceTraceContext 恢复
   - 改法：补一句：拆分时用 traceparent 跨层串成一条 trace
23. 原句：「还没做的是对抗性测试集（投毒 PDF）和攻击成功率统计，这是下一步。」
   - 问题：已做：eval:prompt-injection 13 个攻击用例，三层防护（screenUntrustedText、UNTRUSTED_EVIDENCE_RULES、guardAnswerLinks）上线，文档 RAG 出口 17/39→0/39，改写 3/3 仍成功（3.10）
   - 改法：整题重写为三层防护 + 红队数字 + 改写绕过和自建用例的局限
24. 原句：「最近才把 V2 转成默认执行器、把 v3 冻结在 shadow」
   - 问题：v3 已有 guarded 档和图内审批（默认 off）；两张图由 LangGraph 调度，原生调度器已在阶段 6 删除（3.17、3.28–3.30）
   - 改法：改为：V1/V2/v3 三代并存加 LangGraph 迁移，维护面大；v3 有 guarded 档但默认关
25. 原句：「但评测数据本身只有几十条」
   - 问题：QASPER dev 已接入（检索 821 题、答案 200 题），每周有真实模型 CI
   - 改法：改为「接外部标注集太晚」，而不是「只有几十条」
26. 原句：「## 工程与可靠性」
   - 问题：覆盖缺口：没有多租户隔离（RLS、流水线、加密擦除）、LangGraph 迁移取舍、服务拆分、往返优化的题目，而这些是最近大块工作
   - 改法：至少补 3 题：为什么只把两张图交给 LangGraph；多租户怎么隔离（含默认关的清单）；数据库往返 167→22 怎么定位

### NARRATIVE-CASES.md

27. 原句：「并开始接 QASPER 扩大评测集。」
   - 问题：已完成，且 QASPER 推翻了 48 条用例上「hybrid 比稠密高」的印象
   - 改法：结尾补上：QASPER dev 上 hybrid 只显著好于 BM25，和稠密不显著，结论收窄为「比单用 BM25 好」
28. 原句：「16/18 → 18/18，离线自测也变成 18/18」
   - 问题：同 180 秒稿：现在通过的对比答案来自模板，7B 自己写的对比答案仍全部被拒
   - 改法：在「结果」后补一句模板兜底的事实，免得被追问时像在夸大
29. 原句：「该换校验器而不是继续打补丁」
   - 问题：后续实际做了评审、拒答标记、override、7 个开关，三轮都没过事先定的规则，默认没改（3.21）；故事停在这里会被问「那你换了吗」
   - 改法：补后续：换了几种信号，都会多答不可答题，按规则不改默认；瓶颈是词法校验 + 7B
30. 原句：「# 故障与决策故事」
   - 问题：7 个故事都不涉及恢复、审批、取消、多租户、LangGraph；而有数字的好故事已经存在
   - 改法：补 2–3 个：取消被熔断器记成失败（234 次 226 次 503 → 0，3.20）；CAS 等锁期间漏事件改为先 FOR NO KEY UPDATE（3.15）；外层 LangGraph 两次压测不过门、坚持不放宽（3.28–3.29）

### CURRENT-TRUTH.md

31. 原句：「9 张表的策略拒绝其他租户的行」
   - 问题：server/health.js getRowLevelSecurityTables 现在列 17 张表，运行时再加每个 live 索引版本的分块表和 BM25 统计表；开角色拆分时 system 工作走 NOLOGIN system 角色（迁移 035）
   - 改法：改为 17 张表 + 版本表；补一句 strict 和角色拆分可选
32. 原句：「10 个 prompt、16 个模板变体」
   - 问题：rag/prompt-registry.js PROMPT_IDS 现有 11 个 id（多了 unified_graph_planner），test/prompt-registry.test.mjs PINNED_PROMPT_TEMPLATES 钉了 19 个 id@version
   - 改法：改为 11 个 prompt、19 个钉住的模板版本
33. 原句：「默认配置：hybrid 检索（pgvector 余弦 + PostgreSQL 全文检索，RRF 融合）」
   - 问题：不完整：稀疏路默认是 Okapi BM25 打分；RRF 是加权的（dense 0.65 / sparse 0.35，k=60）
   - 改法：改为：pgvector 余弦 + PostgreSQL 全文检索匹配、Okapi BM25 打分，加权 RRF 融合
34. 原句：「上限 12 个节点、深度 5、并发 3」
   - 问题：默认 custom 预算为 2，capNodesToBudget 把节点上限压到 2，12 节点在默认配置下用不满
   - 改法：补一句：默认预算下实际最多 2 个 custom 节点
35. 原句：「认领、节点开始、完成都用运行版本号 CAS 防止旧 worker 重复执行」
   - 问题：CAS 挡的是旧 worker 的状态写，不是重复执行本身；也缺 LangGraph 线程作为次要记录、审批快照哈希、drain 取消
   - 改法：改为「挡住旧 worker 的状态写」，补上 rag/langgraph/checkpointer.js、rag/langgraph/drain-bridge.js
36. 原句：「后端测试 2214 个：2205 通过，0 失败，9 个跳过」
   - 问题：3.13「工程基线」停在 2026-09-26；3.30 已是 3,250 个，docs/tenant-isolation.md 2026-10-18 完整验证是 4038 项、4036 通过、0 失败
   - 改法：把工程基线更新为最近一次全量结果，并注明日期和环境
37. 原句：「吞吐停在约 91 req/s（并发 32 时 p50 347 ms）；每个请求约 12–13 ms 应用 CPU」
   - 问题：被 3.24 取代：claim memo 后并发 32 约 239–258 req/s，每请求 CPU 4.6–4.9 ms
   - 改法：在 3.15 加注「memo 之前的数字，现状见 3.24」
38. 原句：「（+0.15–0.25 ms，多了 3 次往返）」
   - 问题：2026-09-27 起租户设置和语句合成一次往返（PipelinedQuery），这是历史数字；同节「PostgreSQL 集成测试共 24/24」也已过时
   - 改法：加注「流水线优化之前；现在单语句一次往返，见 3.15 往返优化」
39. 原句：「所有层共用一组对称密钥，任何一层都能签任何 issuer；token 60 秒内可重放；不是 mTLS。」
   - 问题：3.20 起有 ed25519/mixed（每层私钥、公钥绑定 issuer）、请求绑定 htm/htu/bdh、防重放缓存；默认 hmac 下原句仍成立，但重放只对同一方法、路径和 body 有效
   - 改法：加注「默认 hmac 下如此；可选 ed25519 + 防重放，见 3.20」
40. 原句：「183/2338 个块超过 900 字符（最长 1910）」
   - 问题：与 3.27 的「段落识别开启后 17.9% 超过 900 字符」口径不一致（183/2338 约 7.8%）
   - 改法：核对两个数各自的语料和统计口径，统一或分别注明
41. 原句：「只读 PDF 文本层，没有 OCR、表格和版面解析；换行会把句子切断，导致模板答案出现半句话。」
   - 问题：段落识别已默认开（3.26）；兜底模板先用 joinEvidenceSoftWraps 接软换行（3.23）；Docling 与 PDF_PARSER=auto 可选
   - 改法：改为：默认只读文本层并识别段落；版面解析和按页分流可选、没有显著收益；OCR 只验证过 1 份手工扫描件
42. 原句：「行级安全不覆盖会话记忆（只有 session id）和 admin audit（管理员需要跨用户读取）」
   - 问题：迁移 031 已给会话记忆加归属列和策略（3.23 自己也写了），迁移 032 让审计进入 RLS
   - 改法：删掉这句，改为当前真实边界：默认鉴权关、默认 lenient、RLS 不防注入
43. 原句：「要做到拒绝访问需要一个没有表权限的独立登录角色」
   - 问题：已实现：POSTGRES_TENANT_CONTEXT=strict 和角色拆分（POSTGRES_MIGRATION_DATABASE_URL、迁移 035），都默认关
   - 改法：改为：默认 lenient 时回落到 owner；可开 strict 或角色拆分做到 fail-closed
44. 原句：「### 3.30 删除原生图调度器（2026-10-16）」
   - 问题：最新一节停在 2026-10-16，缺两块已合并的工作：租户隔离阶段 2–5（5dc46718 合并，数字在 docs/tenant-isolation.md「2026-10-18 的一次完整验证」：4038 项 0 失败、walkthrough 26 PASS/0 FAIL/1 SKIP、audit:verify 63 条 5 条链、/chat 吞吐 −3.5%~+1.5%）；PDF_PARSER=auto 与 worker 池（692ca7da，数字在 docs/evaluation.md「按页分流和并行解析」：105/266 页、252–279 s 对 329.6 s、F1 +0.005 [−0.020, +0.032]、38 个 PDF 同时解析 0.79–0.96 s → 0.30–0.48 s）
   - 改法：按 AGENTS.md 约定先补 3.31（PDF 按页分流和并行解析）和 3.32（多租户加固 2–5），再改讲述稿和 FAQ

### AGENTS.md

45. 原句：「`<t>_bm25_rank(...)`, which is SECURITY DEFINER」
   - 问题：仓库里 grep 不到 _bm25_rank；迁移 030 建的函数是 <t>_sparse_search，同节 RAG_BM25_PRUNE_DF_FRACTION 也不存在（rag/config.js 读的是 RAG_SPARSE_PRUNE_DF_FRACTION）
   - 改法：面试准备时以代码为准：<t>_sparse_search、RAG_SPARSE_PRUNE_DF_FRACTION、PGVECTOR_SPARSE_PRUNE_MIN_CHUNKS
46. 原句：「The model-call guard's concurrency queue does not observe the signal.」
   - 问题：rag/model-call-guard.js enqueueWaiter 在 signal abort 时让等待者离队并 reject，AGENTS.md 租户一节也写了 waiters observe their abort signal
   - 改法：面试里别说「排队不响应取消」；文档这句应删
47. 原句：「(checked with `docker compose config` only, never built)」
   - 问题：指 compose.demo.yml；docs/tenant-isolation.md 2026-10-18 记录镜像构建成功、三个容器健康。注意 compose.services.yml（拆分）确实仍只校验过 config（docs/deployment.md）
   - 改法：统一口径：演示 compose 已构建并跑过；拆分 compose 仍没跑过

### server/evaluation/run-retrieval-comparison.mjs

48. 原句：「A pgvector deployment's sparse route is PostgreSQL `ts_rank_cd` FTS」
   - 问题：报告里写死的说明与当前默认 bm25 不符，引用这份报告时会被误读
   - 改法：引用报告时口头更正：pgvector 稀疏路默认是 BM25；该脚本的稀疏臂是 local store 的 BM25

## 各子系统核验时另外发现的

与上面的清单有重叠；上面没有的条目以这里为准。

### Agent 编排与规划

- INTERVIEW-FAQ #18 原句：「最近才把 V2 转成默认执行器、把 v3 冻结在 shadow，V1 只留作整图被拒时的兜底。」 → 现在：v3 统一图已部分解冻，有 guarded 档，2026-09-27 起含图内审批续跑，默认仍 off；两张图都由 LangGraph.js 调度，原生调度器已在阶段 6 删除（CURRENT-TRUTH §3.17、§3.30，docs/unified-agent-dag-migration.md）。
- INTERVIEW-FAQ #4 原句：「思路和 Temporal、LangGraph checkpointer 类似，区别是我把'哪些步骤可以自动重放'做成了……矩阵。」 → 现在已经真的用了 LangGraph：自定义 BaseCheckpointSaver（RunStoreCheckpointSaver）写现有 run 行；v3 审批走 interrupt() + Command({resume})；run 的图 checkpoint 仍是权威，LangGraph 线程只存回执。同一条里「启动时只在节点边界自动续跑」还漏了前提：custom-Skill 图要求外层计划恰好只有 custom_skills 一个阶段（agent-run-recovery.js hasGraphOnlyStoredExecutionPlan），v3 走自己的续跑路径。
- 180-SECOND-NARRATIVE（0:25–1:15）原句：「运行状态持久化在 PostgreSQL，崩溃后可以从 checkpoint 在节点边界续跑」 → 说大了：自动续跑只覆盖 guarded custom-Skill 图（外层计划恰好只有 custom_skills）、v3 guarded run，以及没有图 checkpoint 的 V1 custom_skill 步骤；普通 document_rag 的 run 不自动续跑，在途节点一律转人工。另外整段 Agent 设计没提 LangGraph.js 迁移，也没提外层计划因压测留在原生循环。
- INTERVIEW-FAQ #3 原句：「执行规划器只能在本次请求选中的步骤里挑。」 → 默认 guarded 下不对：只要有已授权的原子 Skill，agent-llm-planner-adapter.js 的 getSelectedExecutionStepIds 就会加入 custom_skills，LLM 能给意图没选 custom Skill 的请求加上这个阶段（CURRENT-TRUTH §3.5、docs/agent-rag.md「行为变化」）。另外执行规划器对未选中的阶段是静默丢弃（normalizePlannerPayload），「整图拒绝不清洗」只适用于 DAG。
- INTERVIEW-FAQ #5 原句：「长期记忆和经验记忆（只作为规划提示，永远不作为证据或引用）」 → 长期记忆会以偏好块进入追问改写 prompt（rewriteBlock）和答案 prompt（answerBlock → preferenceBlock），只有经验记忆是规划提示，而且它能重排或补入白名单意图候选，从而改变确定性规划器的选择（applyExperienceHintsToCandidates）。这一条还漏了：只记录用户自己的话（memoryWrites:false、runWithoutConversationMemoryWrites，§3.23）、会话键按租户哈希、LONG_MEMORY_SCOPE=workspace。
- INTERVIEW-FAQ #15 原句：「还没做的是对抗性测试集（投毒 PDF）和攻击成功率统计，这是下一步。」 → 已经做了：eval:prompt-injection 有 13 个攻击用例、7 类，三层全开时攻击进入答案 0/39，但刻意改写（evasion_paraphrase）仍 3/3 成功（CURRENT-TRUTH §3.10）。
- INTERVIEW-FAQ #14 原句：「本地 7B 下，一轮 6 个用例的规划器评测约 14 秒」 → 14 秒是 2026-09-25 的 6 用例集测的（当时已含 planner_dynamic_skill_graph，见提交 75628674）；2026-09-27 提交 1cdb6029 新增 planner_unified_graph，现在 eval:planner 是 7 个用例（§3.30 为 7/7），引用时要说明是旧用例集。
- CURRENT-TRUTH §4 边界原句：「行级安全不覆盖会话记忆（只有 session id）和 admin audit」，以及「要做到拒绝访问需要一个没有表权限的独立登录角色」 → 迁移 031 已给会话表加归属列和 tenant_isolation 策略，键为 tenant:sha256(user\0ws\0session)（§3.23）；迁移 032 让 admin audit 也受 RLS 约束；POSTGRES_TENANT_CONTEXT=strict 和角色拆分（POSTGRES_MIGRATION_DATABASE_URL）已实现，但都是可选开启（AGENTS.md）。
- CURRENT-TRUTH §3.15 的「面试里的说法」：「单个 Node 进程的瓶颈是 CPU，约 90 req/s」（当时每请求约 12–13 ms 应用 CPU） → 被 §3.24 取代：claim 校验 memo 之后单体 pgvector + RLS、并发 32 约 239–258 req/s，每请求 CPU 4.6–4.9 ms（假模型 0 ms）。引用 90 req/s 时要说明是 2026-09-26 的旧数字。
- （非本子系统，顺带发现）180-SECOND-NARRATIVE 边界段：「目前只处理 PDF 文本层，没有 OCR 和表格」「评测集还小，正在接 QASPER 扩到几百题」；CURRENT-TRUTH §4「文档解析：只读 PDF 文本层，没有 OCR、表格和版面解析」 → 已接入 Docling 与 PDF_PARSER=auto（默认仍是 pdf.js；OCR 路由只在 1 份手工扫描件上验证能走通，docs/evaluation.md「真实 docling-serve 上的验证」）；QASPER 已接入，dev 检索 821 题、答案抽样 200 题（CURRENT-TRUTH §4「评测规模」）。
- （非本子系统，顺带发现）INTERVIEW-FAQ #6 原句：「sparse（PostgreSQL 全文检索，不是 BM25）」 → pgvector 的 sparse 默认已是 Okapi BM25（rag/config.js DEFAULT_SPARSE_SCORING = "bm25"，RAG_SPARSE_SCORING 可切回 ts_rank_cd）；这是用户的决定，QASPER dev 上与 ts_rank_cd 的差异不显著（AGENTS.md）。

### 运行持久化、审批与崩溃恢复

- INTERVIEW-FAQ.md 第 4 题：「思路和 Temporal、LangGraph checkpointer 类似，区别是我把哪些步骤可以自动重放做成了由 Skill 契约声明、由运行时复核的矩阵」。现在不只是类似：custom-Skill DAG 和 v3 统一图都由 LangGraph 调度，用自定义 BaseCheckpointSaver（RunStoreCheckpointSaver）写在 run 行 result.__langGraphCheckpoint；权威仍是带 digest 的图 checkpoint，线程只存回执，矛盾时转人工（langgraph_thread_mismatch）。另外矩阵是运行时按步骤类型登记的（STEP_REPLAY_SAFETY_MATRIX），Skill 契约声明只能收窄、不能授予自动重放，「由 Skill 契约声明」的说法不准。
- INTERVIEW-FAQ.md 第 4 题：「启动时只在节点边界自动续跑，而且要求没有待审批项、checkpoint 与已持久化的步骤对账一致」。不完整，容易被理解成大部分 run 都能自动续跑。实际还要求：外层计划只剩 custom_skills（v1 checkpoint）或走 v3 guarded 路径且 rollout 仍是 guarded；v3 认领前核对 LangGraph 线程；非图 run 只有 custom_skill 步骤能自动重放；主 document_rag 在途的 run 转人工；v3 干净的审批暂停被跳过，V1 待审批 run 被打 manual 标记。
- INTERVIEW-FAQ.md 第 18 题：「最近才把 V2 转成默认执行器、把 v3 冻结在 shadow」。v3 已有 guarded 档（默认仍 off），而且审批已在图内续跑（CURRENT-TRUTH 3.17：interrupt 暂停、同一线程 Command(resume)、跨进程 14/14 写入恰 1 次）。「冻结在 shadow」已过时。
- 180-SECOND-NARRATIVE.md：「崩溃后可以从 checkpoint 在节点边界续跑，并用版本号 CAS 防止两个 worker 重复执行有副作用的步骤」。夸大。CAS / resumeClaim 防的是旧 worker 的状态写入，不防它已经发出的副作用；有副作用的步骤根本不自动重放（重放安全矩阵），在途未知转人工，写型 Capability 靠幂等键。建议改为「只在能证明安全时续跑；有副作用的步骤不自动重放，写入用幂等键，旧 worker 被版本号 CAS 挡在外面」。
- NARRATIVE-CASES.md：没有本子系统的故事（不是过时，是缺口；文件里 7 个故事都不涉及恢复、审批或取消）。可补两个有数字的：取消被熔断器记成失败（234 次 226 次 503，修后 0 次，CURRENT-TRUTH 3.20），以及 CAS 等锁期间漏掉并发追加的事件、改为先 FOR NO KEY UPDATE（CURRENT-TRUTH 3.15）。
- CURRENT-TRUTH.md 第 2 节「持久化与恢复」一行只写了「认领、节点开始、完成都用运行版本号 CAS 防止旧 worker 重复执行」和三个文件。不完整：缺 LangGraph 线程（RunStoreCheckpointSaver）作为次要记录、线程写同样被围栏、审批快照哈希绑定，以及 drain 取消；可补上 rag/langgraph/checkpointer.js 和 rag/langgraph/drain-bridge.js；「防止重复执行」也宜改成「挡住旧 worker 的状态写」。
- CURRENT-TRUTH.md 第 4 节「租户隔离」：「行级安全不覆盖会话记忆（只有 session id）和 admin audit」已过时：迁移 031 / 032 让会话记忆和审计事件进入 RLS。「上下文丢失时回落到 owner 身份……要做到拒绝访问需要一个没有表权限的独立登录角色」部分过时：POSTGRES_TENANT_CONTEXT=strict 和角色拆分（POSTGRES_MIGRATION_DATABASE_URL，迁移 035）已实现，但都是可选，默认 lenient 下仍回落到 owner 路径。和本子系统相关在于：启动恢复按记录自己的范围 runWithDatabaseTenant 运行，跨租户扫描用 runAsDatabaseSystem。
- （顺带，不在 interview 目录）AGENTS.md「Deadlines, cancellation and dependency outages」的 Limits 写着「The model-call guard's concurrency queue does not observe the signal」，但 server/rag/model-call-guard.js 的 enqueueWaiter / acquire({ signal }) 会在 signal abort 时让等待者离队并 reject，openai-client.js 调 guardModelCall 时也传了 signal，AGENTS.md「Model fairness and quotas」一节同样写 waiters observe their abort signal。Limits 这一句已过时，面试里别说「排队不响应取消」。

### 文档解析、切块与混合检索

- INTERVIEW-FAQ #6 原句"sparse（PostgreSQL 全文检索，不是 BM25）两路独立召回"：现在 RAG_SPARSE_SCORING 默认 bm25，是迁移 029/030 自建统计的 Okapi BM25（config.js DEFAULT_SPARSE_SCORING），ts_rank_cd 只是可选项
- INTERVIEW-FAQ #6 只给了 48 条用例的"hybrid 0.71、dense 0.65、BM25 0.66"：QASPER dev 821 题已经表明 hybrid 和纯稠密没有显著差异（+0.006），只显著好于 BM25（+0.074）。应补上 QASPER 的结论，并以它为主
- INTERVIEW-FAQ #7 原句"神经交叉编码器的接入已经有了，下一步在更大的评测集上测它"：已经在 QASPER dev 上测完（CURRENT-TRUTH 3.14a/3.14b）。上下文证据 +0.063，显著；F1 不显著；拒答 −4.4pp，显著。定位是有条件时的推荐配置，默认关
- INTERVIEW-FAQ #10 原句"在它下面 hybrid 比 BM25 差很多，换成真实 embedding 后结论完全反过来"：这不是过时，是说过头了。真实 embedding 下 48 条用例的全量差异不显著。安全说法是"伪 embedding 下的排序是错的，不能用来做架构决策"
- 180-SECOND-NARRATIVE 边界段原句"目前只处理 PDF 文本层，没有 OCR 和表格"：现在有 PDF_PARSER=docling（表格按列名展开）和 PDF_PARSER=auto（layout/ocr 按页分流），只是默认仍是 pdf.js。应改成"默认只读文本层，版面和 OCR 是可选项，测下来没有显著收益"
- 180-SECOND-NARRATIVE 原句"评测集还小，正在接 QASPER 扩到几百题"：已经完成。QASPER dev 检索 821 题、答案抽样 200 题，CI 每周跑 200 题检索
- NARRATIVE-CASES 故事 4 原句"并开始接 QASPER 扩大评测集"：已经完成。而且 QASPER 推翻了 48 条用例上"hybrid 比稠密高 0.057"的印象（evaluation.md QASPER 节），故事结尾应补上这一点
- CURRENT-TRUTH 第 4 节原句"文档解析：只读 PDF 文本层，没有 OCR、表格和版面解析；换行会把句子切断，导致模板答案出现半句话"：段落识别已经默认开（3.26），Docling 和 auto 可选（evaluation.md 2026-10-18）
- CURRENT-TRUTH 没有收录 2026-10-18 PDF_PARSER=auto 和 worker 池的数字，它们只在 docs/evaluation.md"按页分流和并行解析"里；按 AGENTS.md 的约定应该先进 CURRENT-TRUTH
- CURRENT-TRUTH 第 2 节默认配置"hybrid 检索（pgvector 余弦 + PostgreSQL 全文检索，RRF 融合）"：不算错，但不完整。没写稀疏路默认是 BM25 打分，也没写 RRF 是加权的（0.65/0.35）
- （非面试稿，准备时会读到）AGENTS.md 的 BM25 描述已过时。它写的是"Trigger lock order: scope rows first … The scope row is the per-scope lock"、`<t>_bm25_rank`、`RAG_BM25_PRUNE_DF_FRACTION`、`PGVECTOR_BM25_PRUNE_MIN_CHUNKS`。现在的代码是：只追加的日志表 + pg_try_advisory_xact_lock 下的 `<t>_sparse_fold`、`<t>_sparse_search`、`RAG_SPARSE_PRUNE_DF_FRACTION`、`RAG_SPARSE_COMMON_TERM_CAP`、`PGVECTOR_SPARSE_PRUNE_MIN_CHUNKS`（见迁移 030 头注释、config.js、vector-store-pgvector-sparse.js）
- （非面试稿）AGENTS.md 原句"a tenant's multi-document sparse search goes through `<chunks table>_sparse_rank` (migration 014)"：默认 BM25（以及 ts_rank_cd 开剪枝时）走的是 030 的 `<t>_sparse_search`（usesPgvectorSparseSearchFunction）；014 的函数只在 ts_rank_cd 且关剪枝的多文档租户查询里用
- （非面试稿）AGENTS.md 的查询适配器描述已过时。它写的是"a configured space that differs is refused with QUERY_ADAPTER_MISMATCH … never skipped"、"anything that compares vectorScore with an absolute bar is off-calibration"、"The fingerprint is part of the query-embedding cache key"、"documented tuned setting"。现在的代码：adaptQueryVectorForSearch 不满足条件就告警并退回未适配，只有健康检查对坏文件报 error；vectorScore 保留模型的原始余弦；embedding 缓存只存模型自己的向量（embedding-cache.js 注释）；"调优设置"的说法已在 retrieval-tuning.md 撤回
- （非面试稿）AGENTS.md 把 `planDoclingBatches` 写在 `rag/pdf-auto-parser.js` 下，实际定义在 rag/pdf-page-router.js，pdf-auto-parser.js 只是导入
- （非面试稿）docs/retrieval-tuning.md 里多份草稿互相矛盾。有的写"RAG_SPARSE_SCORING，默认 ts_rank_cd"、"默认仍是 ts_rank_cd"，和文首 2026-09-27 的更新冲突；适配器一节先写"作为…调优设置记录下来"、"配置的空间不一致会直接报错（QUERY_ADAPTER_MISMATCH）"、"指纹进入查询向量缓存的 key"，后面的审查修正节又写"此前'推荐为调优配置'撤回"、只告警退回；evaluation.md"检索调优"表格又写"关（推荐配置）"。面试里按代码和 CURRENT-TRUTH 说：默认 bm25，适配器只是可选的检索设置

### 答案生成、防幻觉与提示注入

- INTERVIEW-FAQ #15 原句：「目前是设计层防御……还没做的是对抗性测试集（投毒 PDF）和攻击成功率统计，这是下一步。」现在的事实：prompt-injection-screen.js 的确定性筛查、prompt 规则（UNTRUSTED_EVIDENCE_RULES）和 guardAnswerLinks 都已上线，筛查默认开（RAG_INJECTION_SCREEN 默认 on）；eval:prompt-injection 有 13 个攻击用例，文档 RAG 攻击成功 17/39→0/39（CURRENT-TRUTH 3.10）。这一题需要整段重写
- INTERVIEW-FAQ #13 原句：「下一步是换成 NLI 或校准过的 LLM 评审」。现在的事实：LLM 评审已实现（RAG_CLAIM_JUDGE=llm，默认关），在构造集上校准过，但没有人工标注；NLI 没做。另外 3.21 的三轮测量都显示放宽后会多答不可答题
- INTERVIEW-FAQ #8 默认关闭的理由不完整，原句：「它默认关闭，因为评审用的是同一个 7B 模型……上线前要用人工标注的真实答案报告 kappa」。现在还应补上：QASPER train 上开评审后不可答题被回答 0/9→2/9（全开 4/9），三轮都没通过事先定的规则（CURRENT-TRUTH 3.21）
- 180-SECOND-NARRATIVE 边界段原句：「目前只处理 PDF 文本层，没有 OCR 和表格」。现在的事实：有 PDF_PARSER=docling/auto（可选；auto 会把表格页和扫描页送 docling-serve，ocr 路由只在一份手工扫描 PDF 上测过；docling 和 auto 的答案质量都没有显著更好，CURRENT-TRUTH 3.14、AGENTS.md）。原句「评测集还小，正在接 QASPER 扩到几百题」：QASPER 已经接入（检索 821 题、答案 200 题，CURRENT-TRUTH §4）
- 180-SECOND-NARRATIVE「多文档对比……修完之后端到端检查从 16/18 到 18/18」和 NARRATIVE-CASES 故事 1「模型的答案其实是对的……16/18 → 18/18」：缺了关键事实。现在通过的对比答案来自引擎按证据拼的模板，qwen2.5:7b 自己写的对比答案仍全部被词法校验拒绝（CURRENT-TRUTH 3.2 注、3.23；AGENTS.md「Comparison answer gate」2026-10-04 实测 6/6 unsupported_claims）。不补这句，被追问时会被认为在夸大
- 180-SECOND-NARRATIVE 原句：「已经加了受限的 LLM 评审……打开后合同题回答率从 3/21 到 14/21 且全对，但还没用人工标注校准，所以默认关闭」。应补上 QASPER 上会回答不可答题的风险（3.21）
- NARRATIVE-CASES 故事 6 结尾：「该换校验器而不是继续打补丁」。后续实际是加了 7 个开关、评审、拒答标记和 override，三轮都没通过规则，默认没改（3.21）。讲这个故事要接上后续，否则被问'那你换了吗'会卡住
- CURRENT-TRUTH §2 表「Prompt 版本」行原句：「10 个 prompt、16 个模板变体」。代码里 PROMPT_IDS 有 11 个 id（多了 unified_graph_planner），server/test/prompt-registry.test.mjs 的 PINNED_PROMPT_TEMPLATES 钉了 19 个 id@version（测试要求与 listPromptTemplates 完全相等）
- CURRENT-TRUTH §4 边界原句：「文档解析：只读 PDF 文本层……换行会把句子切断，导致模板答案出现半句话」。这和 3.23 矛盾：兜底模板现在会先用 joinEvidenceSoftWraps 接上软换行；另外已有 Docling / auto 路径
- CURRENT-TRUTH §4 原句：「租户隔离：行级安全不覆盖会话记忆……和 admin audit」。迁移 031（会话记忆）和 032（审计）已经覆盖了，3.23 也写了；同段「要做到拒绝访问需要一个没有表权限的独立登录角色」现在已有可选的 POSTGRES_TENANT_CONTEXT=strict 和角色拆分（POSTGRES_MIGRATION_DATABASE_URL，默认关）（非本子系统，顺带提一下）
- INTERVIEW-FAQ #6 原句：「sparse（PostgreSQL 全文检索，不是 BM25）」。现在默认 RAG_SPARSE_SCORING=bm25（Okapi BM25，config.js DEFAULT_SPARSE_SCORING，CURRENT-TRUTH 3.18）；CURRENT-TRUTH §2 末尾「默认配置：hybrid 检索（pgvector 余弦 + PostgreSQL 全文检索，RRF 融合）」也应写明 sparse 是 BM25（非本子系统，顺带提一下）
- INTERVIEW-FAQ #7 原句：「神经交叉编码器的接入已经有了，下一步在更大的评测集上测它」。现在已在 QASPER dev 上测过（证据进上下文 0.353→0.417 显著、F1 不显著，CURRENT-TRUTH 3.14a）（非本子系统，顺带提一下）
- INTERVIEW-FAQ #18 原句：「把 v3 冻结在 shadow」。现在 v3 统一图有 guarded 档可执行，默认 off（非本子系统，顺带提一下）

### 评测体系与实验方法

- INTERVIEW-FAQ Q6 原句「sparse（PostgreSQL 全文检索，不是 BM25）」→ 现在默认 RAG_SPARSE_SCORING=bm25（rag/config.js DEFAULT_SPARSE_SCORING，Okapi BM25），ts_rank_cd 可选；BM25 设为默认是产品决定，QASPER 上没有显著差异（CURRENT-TRUTH §3.18）。
- INTERVIEW-FAQ Q6 原句「hybrid 0.71、dense 0.65、BM25 0.66 …数值最好、从不显著更差」→ 这是 48 条用例的数字；QASPER dev 821 题上 hybrid−dense +0.006 [−0.019,+0.031] 不显著，只能说「显著好于单用 BM25（+0.074）」。
- INTERVIEW-FAQ Q7 原句「神经交叉编码器的接入已经有了，下一步在更大的评测集上测它」→ 已经在 QASPER dev 上测过：上下文证据 +0.063 显著，可答题拒答 −4.4pp 显著，F1 不显著；作为推荐配置，不默认开（CURRENT-TRUTH §3.14a）。
- INTERVIEW-FAQ Q9 原句「这些都能在本地用真实模型复现」→ 轨迹、planner-mock、recovery 用的是脚本化 ragService 或 mock provider，只有 verify:quality、QASPER、planner --provider real、红队用真实模型；而且没提 QASPER 外部标注、cited/context 拆分、同 SHA 门。
- INTERVIEW-FAQ Q10 原句「换成真实 embedding 后结论完全反过来」→ 排序确实反过来了，但 48 条上 hybrid−BM25 +0.054 [−0.038,+0.149] 不显著，显著性来自 QASPER，「完全」要收着说。
- INTERVIEW-FAQ Q14 原句「一轮 6 个用例的规划器评测约 14 秒」→ 现在 createDefaultPlannerCases 有 7 个用例（新增 planner_unified_graph）；14 秒是 6 个用例时测的历史值。
- INTERVIEW-FAQ Q15 原句「还没做的是对抗性测试集（投毒 PDF）和攻击成功率统计，这是下一步」→ 已经有 eval:prompt-injection：主测量 13 个攻击用例、7 类、4 个对照组（另有 2 个 evasion 用例单独对比），rag 出口 17/39→0/39（CURRENT-TRUTH §3.10）；剩下的缺口是第三方基准和改写绕过（3/3）。
- INTERVIEW-FAQ Q8 只说「打开后合同题 14/21 得到回答且全对」→ 应补上：QASPER train 上只开评审时不可答题被回答 0/9→2/9（全开 + 评审时 4/9），所以默认关（CURRENT-TRUTH §3.21）。
- INTERVIEW-FAQ Q18 原句「评测数据本身只有几十条」「把 v3 冻结在 shadow」→ QASPER dev 已有检索 821 题、答案 200 题，并有每周真实模型 CI；v3 有 guarded 档（默认 off），LangGraph 迁移完成，原生调度器已删除（CURRENT-TRUTH §3.28–3.30）。
- NARRATIVE-CASES 故事 4 原句「真实 embedding 下 hybrid 反而是数值最好的（0.71）…于是我把'hybrid 更好'改成'数值最好、从不显著更差'，并开始接 QASPER 扩大评测集」→ 叙述作为历史没错，但 QASPER 已接；讲到这里要补上 dev 上 hybrid 和 dense 比不显著、和 BM25 比显著，结论改成「比单用 BM25 好」。
- 180-SECOND-NARRATIVE 原句「评测集还小，正在接 QASPER 扩到几百题」→ 已完成：检索 821 题、答案 200 题，每周用 Ollama 跑真实模型 CI。
- 180-SECOND-NARRATIVE 原句「目前只处理 PDF 文本层，没有 OCR 和表格」→ 已有可选的 PDF_PARSER=docling 和按页分流的 auto（含 OCR 路由），都测过，没有显著收益（Docling 表格题 F1 +0.020 [−0.011,+0.057]；auto 表格题 F1 +0.008 [−0.031,+0.053]），所以默认仍是 pdf.js；OCR 路由只在一份手工扫描 PDF 上验证过。
- 180-SECOND-NARRATIVE 检索段「Recall@5 是 0.71 …但 48 条用例的置信区间还跨 0，所以我只说'数值上最好'」→ 应补上 QASPER 的结论：hybrid 只显著优于 BM25。
- （同目录 CURRENT-TRUTH §4 边界，不在三份稿里）原句「只读 PDF 文本层，没有 OCR、表格和版面解析」「行级安全不覆盖会话记忆（只有 session id）和 admin audit」→ 已有 Docling/auto；会话记忆已由迁移 031 纳入 tenant_isolation 策略，admin audit 已由迁移 032 纳入行级安全；上下文丢失回落 owner 的问题现在有可选的 POSTGRES_TENANT_CONTEXT=strict 和角色拆分（POSTGRES_MIGRATION_DATABASE_URL，迁移 035）。
- （docs/evaluation.md「当前追踪报告」，不在面试目录）原句「当前默认 deterministic suite 为 17/17 cases passed，71/71 checks」→ createDefaultTrajectoryCases 现在是 19 个用例，eval:trajectory 19/19（CURRENT-TRUTH §3.30）。
- （docs/evaluation.md「DocCompare quality verification / 自检模式」）原句「预期结果是 16/18，不是全绿」「真实模型能否过 isSafeStructuredDifferenceAnswer 目前没有测过」→ run-doccompare-verification.mjs 头部注释写的是 EXPECTED SELF-TEST RESULT: 18/18；门控函数现在叫 assessStructuredDifferenceAnswer（rag/answer-writer.js）；qwen2.5:7b 已测过，模型的对比答案全部以 unsupported_claims 被拒、走模板兜底（同一文件「对比答案闸门的拒绝原因（2026-10-04）」）。

### 多租户隔离与安全

- CURRENT-TRUTH.md §2 表格「租户隔离」行原文："9 张表的策略拒绝其他租户的行……迁移、进程级缓存加载、跨租户恢复扫描显式以 owner 身份执行"。现在：server/health.js getRowLevelSecurityTables 列出 17 张表（013/015/017/031/032/034/036/037），运行时再加每个 live 索引版本的分块表和 BM25 统计表；开角色拆分时 system 工作走 NOLOGIN 的 system 角色（迁移 035），不再以 owner 执行（默认不拆分时仍是 owner）。
- CURRENT-TRUTH.md §4 边界「租户隔离」原文："行级安全不覆盖会话记忆（只有 session id）和 admin audit"。现在：迁移 031 已给会话记忆加归属列和 tenant_isolation 策略（键是 tenant: + sha256），迁移 032 已把审计放到 RLS 下（租户只读自己 workspace 的事件、只能插入自己的事件，UPDATE/DELETE 已撤销）。
- CURRENT-TRUTH.md §4 原文："上下文丢失时回落到 owner 身份……要做到拒绝访问需要一个没有表权限的独立登录角色"。现在：这个角色已经实现（POSTGRES_MIGRATION_DATABASE_URL 角色拆分，unbound 语句 42501），另有 POSTGRES_TENANT_CONTEXT=strict。只是两者默认都关，应改成"默认 lenient 时回落到 owner；可开 strict 或角色拆分做到 fail-closed"。"不防 SQL 注入"仍然成立。
- CURRENT-TRUTH.md 3.8 原文："每条语句 p50 延迟 +0.15–0.25 ms，多了 3 次往返"、"9 个用例；PostgreSQL 集成测试共 24/24"。现在：2026-09-27 起租户语句和设置一次往返（PipelinedQuery），"多 3 次往返"只是历史数字；test/postgres-row-level-security.integration.test.mjs 现在是 28 个用例（外面套 1 个 suite 级 test，grep test( 共 29 处）。
- docs/evaluation.md「租户隔离（数据库行级安全）」（不在面试目录，但会被引用）原文："可行的优化是把 BEGIN 和租户设置合成一次往返，目前没做"。现在：同一文件的「每次 /chat 的数据库往返（2026-09-27）」已经做了（单语句一次往返，withPostgresTransaction 把 BEGIN 和设置合并）。
- CURRENT-TRUTH.md 3.19（2026-09-30 的小节）原文："所有层共用一组对称密钥，任何一层都能签任何 issuer；token 60 秒内可重放"。现在：有 INTERNAL_SERVICE_AUTH=ed25519/mixed（每层自己的私钥）、请求绑定（htm/htu/bdh）、防重放缓存（ed25519 和 mixed 下默认开）。同一文件的 3.20 和 §4「拆分部署」已经写了可选 Ed25519，所以 3.19 是按日期记的历史；hmac 仍是默认，默认配置下原句依然成立（DEFAULT_SERVICE_TOKEN_TTL_MS = 60_000），单独引用 3.19 时要补一句"可选 ed25519"。
- CURRENT-TRUTH.md 3.22 原文："不带 workspaces claim 的 token 仍可选任意 workspace"。现在：开 TENANT_MEMBERSHIP=enforce 后，用户必须是该 workspace 的成员（decideTenantMembership）；没有用户、也没有绑定 workspace 的凭据用请求头指定 workspace 会被拒。默认 off 时原句仍然成立。
- 覆盖缺口（不是措辞过时）：INTERVIEW-FAQ.md、NARRATIVE-CASES.md、180-SECOND-NARRATIVE.md 完全没有多租户内容（grep 租户/行级/RLS/tenant 无结果）；CURRENT-TRUTH.md 只有 3.23 的会话记忆一条，没有租户隔离阶段 2–5（strict 和角色拆分、注册表和成员、限流配额、擦除导出、回收站、哈希链、信封加密、hardened 演示）的小节或数字。面试前要先把 docs/tenant-isolation.md「2026-10-18 的一次完整验证」的数字补进 CURRENT-TRUTH。
- AGENTS.md 和 docs/demo-tenant-isolation.md「限制」原文：compose.demo.yml "只用 docker compose config 验证过，没有构建镜像、没有实际启动"。现在：docs/tenant-isolation.md（提交 6c83fb96，2026-10-18，比 demo 文档最后一次提交 a0c617d5 更晚）记录镜像构建成功，compose.demo.yml 下三个容器都健康。口径冲突，需要统一。
- （AGENTS.md，非面试目录，但作者可能照着引用）BM25 一节原文："`<t>_bm25_rank(...)`, which is SECURITY DEFINER" 和 "Common-term pruning (`RAG_BM25_PRUNE_DF_FRACTION`, default 0.1)"。现在：迁移 030 建的函数叫 `<t>_sparse_search`（PGVECTOR_SPARSE_TABLE_SUFFIXES.searchFunction），代码里读的环境变量是 RAG_SPARSE_PRUNE_DF_FRACTION（rag/config.js getSparsePruneDfFraction，默认 0.1），仓库里 grep 不到 _bm25_rank 和 RAG_BM25_PRUNE_DF_FRACTION。
- （非本子系统，顺带）CURRENT-TRUTH.md §4「文档解析」原文："只读 PDF 文本层，没有 OCR、表格和版面解析"。现在：有 PDF_PARSER=docling/auto（可选开启，rag/pdf-loader.js），默认仍是 pdfjs；auto 实测没有显著提升。
- （非本子系统，顺带）INTERVIEW-FAQ.md #6 原文："sparse（PostgreSQL 全文检索，不是 BM25）"。现在：默认 RAG_SPARSE_SCORING=bm25（Okapi BM25，迁移 029/030），ts_rank_cd 仍可选。
- （非本子系统，顺带）INTERVIEW-FAQ.md #15 原文："还没做的是对抗性测试集（投毒 PDF）和攻击成功率统计"。现在：已有 eval:prompt-injection 和 CURRENT-TRUTH 3.10 的攻击成功率数据。
- （非本子系统，顺带）INTERVIEW-FAQ.md #18 原文："把 v3 冻结在 shadow"。现在：v3 统一图有 guarded 档，可以执行（AGENT_UNIFIED_GRAPH_ROLLOUT 默认 off）。
- （非本子系统，顺带）180-SECOND-NARRATIVE.md 原文："目前只处理 PDF 文本层，没有 OCR 和表格……正在接 QASPER"。现在：有 PDF_PARSER=docling/auto（可选开启，实测没有显著提升）；QASPER 已经接入。

### 服务拆分、模型网关、可靠性与可观测性

- CURRENT-TRUTH 3.15「面试里的说法：单个 Node 进程的瓶颈是 CPU，约 90 req/s」以及同节「每个请求约 12–13 ms 应用 CPU」→ 现在：3.24 的 claim memo 之后，每请求应用 CPU 约 5 ms，并发 32 时吞吐 239–258 req/s（租户路径、假模型 0 ms）。docs/evaluation.md「Claim 检查 memo」明确写了 12–13 ms 是改动之前的数字
- CURRENT-TRUTH 3.19「模型延迟 0 时瓶颈是 agent 层：它占全部应用 CPU 的 84%」→ 现在：memo 之后拆分部署下 agent 层占 62–67%（3.24，只测了改后，不是配对测量），仍是最忙的一层
- CURRENT-TRUTH 3.19「内部身份是 HS256 签名 token……所有层共用一组对称密钥，任何一层都能签任何 issuer；token 60 秒内可重放」→ 现在：3.20 起可选 ed25519（每层一把私钥、公钥绑定 issuer）；服务客户端在任何模式下都签请求绑定（htm/htu/bdh，buildAttempt 传 request），HS256 token 带绑定时也会校验；ed25519 和 mixed 下默认开防重放。默认 hmac 下这句仍成立，但重放只对同一方法、路径和 body 有效
- INTERVIEW-FAQ #14「调用深在检索服务里也能通过 AsyncLocalStorage 记到发起它的运行上」→ 现在：只在单体（同一进程）里成立。拆分部署时 ALS 不跨进程：检索层在答案里带 usage，由 remote-retrieval.js 的 chargeRetrievalUsage 记账；网关调用由调用方写 model_gateway_mirror 事件
- INTERVIEW-FAQ #17「span 靠 AsyncLocalStorage 嵌套，检索服务深处的模型调用自动挂在发起它的 Skill 下面，不用一层层传参」→ 现在：拆分时跨进程靠 service-client.js 用 propagation.inject 注入 W3C traceparent、接收端 bindServiceTraceContext 恢复；进程内才是 ALS
- INTERVIEW-FAQ #18「最近才把 V2 转成默认执行器、把 v3 冻结在 shadow」→ 现在：v3 统一图有 guarded 档（默认仍 off），图内审批已解冻；custom-Skill DAG 和 v3 的唯一调度器是 LangGraph（CURRENT-TRUTH 3.28–3.30）
- INTERVIEW-FAQ #4「思路和 Temporal、LangGraph checkpointer 类似」→ 现在：custom-Skill DAG 和 v3 已经实际跑在 LangGraph 上，checkpointer 是写进现有 run store 的 RunStoreCheckpointSaver（rag/langgraph/checkpointer.js，CURRENT-TRUTH 3.28）
- INTERVIEW-FAQ #6「sparse（PostgreSQL 全文检索，不是 BM25）」→ 现在：默认 RAG_SPARSE_SCORING=bm25（rag/config.js DEFAULT_SPARSE_SCORING），是 Okapi BM25（3.18），ts_rank_cd 仍可选
- INTERVIEW-FAQ #7「神经交叉编码器的接入已经有了，下一步在更大的评测集上测它」→ 现在：已在 QASPER dev 上测过（3.14a），是推荐配置，默认不开
- INTERVIEW-FAQ #15「还没做的是对抗性测试集（投毒 PDF）和攻击成功率统计，这是下一步」→ 现在：3.10 已有 13 个攻击用例的红队评测和三层防护的数据
- 180-SECOND-NARRATIVE「目前只处理 PDF 文本层，没有 OCR 和表格」「评测集还小，正在接 QASPER 扩到几百题」→ 现在：Docling 和 PDF_PARSER=auto 已作为可选项实现（没有证明更好）；QASPER dev 已接入，检索 821 题、答案抽样 200 题
- CURRENT-TRUTH §4 边界「行级安全不覆盖会话记忆（只有 session id）和 admin audit……上下文丢失时回落到 owner 身份……要做到拒绝访问需要一个没有表权限的独立登录角色」→ 现在：迁移 031 / 032 已经覆盖会话记忆和 admin audit；POSTGRES_TENANT_CONTEXT=strict 和数据库角色拆分（POSTGRES_MIGRATION_DATABASE_URL、迁移 035）都已作为可选项实现
- CURRENT-TRUTH §4 边界「文档解析：只读 PDF 文本层，没有 OCR、表格和版面解析」→ 现在：同上，Docling 和 auto 路由已有，默认仍是 pdf.js
- AGENTS.md「Deadlines … Limits: The model-call guard's concurrency queue does not observe the signal」、docs/deployment.md 拆分部署限制「模型并发上限的排队不响应取消」、docs/configuration.md「模型并发上限的排队（RAG_LLM_MAX_CONCURRENCY）不响应取消信号」（不是面试稿，但面试会被问到）→ 现在：model-call-guard.js 的 enqueueWaiter 在 signal 中止时出队并 reject；guardModelCall 把 signal 传给 limiter.acquire，openai-client.js sendToUpstream 和网关 upstream-pool 都传了 signal。这是租户隔离提交 eb5650ea 加的，晚于写下这句限制的 d8c1e01f；AGENTS.md 租户部分也写了 waiters observe their abort signal

## 处理结果（2026-10-18）

每组文件先由一个代理按上面的清单修改，再由另一个代理对照代码和出处文档逐处核验并改正（4 组共改正 31 处编辑引入的问题）。以下是核验后的最终状态。未提交。

补充说明：
- CURRENT-TRUTH 新增的是 3.32「多租户加固阶段 1–5」：合并提交 5dc46718 写的是 phases 1-5，清单里的「阶段 2–5」不准。
- INTERVIEW-FAQ 新增三题后重新编号：新题是 18（LangGraph 取舍）、19（多租户）、20（数据库往返）；原来的 18、19 两道反思题现在是 21、22。上面清单里的题号是改前的编号。
- 清单之外顺手改了同类错误：`docs/retrieval-tuning.md` 的 `RAG_BM25_PRUNE_DF_FRACTION` → `RAG_SPARSE_PRUNE_DF_FRACTION` 及穷举条件；`docs/configuration.md`、`docs/deployment.md` 里「模型并发排队不响应取消」（`model-call-guard.js enqueueWaiter` 会在取消时离队）；`docs/demo-tenant-isolation.md` 里「compose override 没构建过」。改后跑了读 `docs/configuration.md` 的 `test/demo-tenants.test.mjs`：10/10 通过。

仍未处理：
- 48 号：`server/evaluation/run-retrieval-comparison.mjs` 报告里写死的「pgvector 稀疏路是 ts_rank_cd」。这是代码里的报告文字，改它会改变生成的报告，这次只改文档，没动。引用这份报告时口头更正。
- `docs/retrieval-tuning.md`、`docs/data-lifecycle.md`、`docs/unified-agent-dag-migration.md` 里残留了 10 段「【某文件】改为：……」形式的编辑指令（例如 55ee73ab 带进来的那段还写着 pgvector 稀疏路默认是 `ts_rank_cd`）。需要逐段判断是否已落实，另作一个任务。
- 核验代理提出、但属于判断而非事实错误的：`docs/retrieval-tuning.md` 把查询适配器称为「调优设置」、`docs/evaluation.md` 写「关（推荐配置）」；AGENTS.md 语义缓存的 key 列表没提查询适配器指纹。
- 3.26 的 183/2338（约 7.8%）和 3.27 的 17.9% 出自 docs/evaluation.md 两节，语料和块数相同但比例对不上，不跑代码查不清；两处都加了分歧注。
- 讲述稿仍然没有多租户、审批续跑、CAS 漏事件这几个故事（是内容缺口，不是说法过时）。180 秒稿比原来长约 8%，没有实际计时。

### CURRENT-TRUTH.md

| 条目 | 结果 | 说明 |
| --- | --- | --- |
| 31「9 张表的策略拒绝其他租户的行」 | 已改 | 核对过 health.js getRowLevelSecurityTables（17 张）和 describePgvectorSparseRowLevelSecurityTargets（每个 live 版本的统计表）。owner/system 角色的说法和 AGENTS.md 角色拆分一节一致。编辑代理的改法保留。 |
| 32「10 个 prompt、16 个模板变体」 | 已改 | PROMPT_IDS 有 11 个，PINNED_PROMPT_TEMPLATES 逐条数是 19 个 id@version。编辑代理的改法正确，保留。 |
| 33 默认配置 hybrid 检索描述 | 已改 | 核对过 config.js：DEFAULT_SPARSE_SCORING=bm25，权重 0.65/0.35，RRF k=60；vector-store.js getRrfContribution = weight/(k+rank+1)。保留。 |
| 34「上限 12 个节点、深度 5、并发 3」 | 已改 | 核对过 agent-budget.js maxCustomSkillCalls: 2；4 个 custom Skill 的 budgetKey 都是 customSkillCalls；capNodesToBudget 和 collectBudgetErrors 的逻辑与补写的那句一致。保留。 |
| 35 持久化与恢复「CAS 防止旧 worker 重复执行」 | 已改 | 三种自动续跑情形按 agent-run-recovery.js 核实过（hasGraphOnlyStoredExecutionPlan、unifiedGraphPath 加 rollout guarded、findAutoRecoverableStep，矩阵里只有 custom_skill 的 autoReplaySafe 为 true）；审批哈希加图摘要绑定见 graph-approval-preflight.js。我又改了两处：线程核对限定为 v3；「只执行一次」改成「带幂等键」。 |
| 36 3.13「后端测试 2214 个」 | 已改 | 节首注保留：4038 项、0 失败（docs/tenant-isolation.md 2026-10-18）；覆盖率闸门 3,250（3.30）。数字都对得上。 |
| 37 3.15「约 91 req/s……12–13 ms」及面试说法「约 90 req/s」 | 已改 | 表格里的注对得上 3.24 的表（并发 32：239–258 req/s，4.6–4.9 ms）。面试说法一处我补了「行级安全路径、并发 32」的前提。 |
| 38 3.8「多了 3 次往返」「24/24」 | 已改 | 往返注和 3.15「每次 /chat 的数据库往返（2026-09-27）」一致；套件里确有会话记忆、审计、反馈、注册表等用例。没有写进新的用例数。 |
| 39 3.19「所有层共用一组对称密钥……60 秒内可重放」 | 已改 | 核对过：service-identity.js 的 DEFAULT_SERVICE_TOKEN_TTL_MS=60_000；注释里写着「The service client always binds」；防重放在 ed25519/mixed 下默认开。注保留。 |
| 40「183/2338」与 3.27「17.9%」 | 已改 | 两处都标了分歧，但查不出哪个对。我去掉了编辑代理加的「优先说 183/2338」，因为没有依据，并把注写短。 |
| 41 §4「只读 PDF 文本层……半句话」 | 已改 | 3.14 和 3.31 的 F1 都不显著；3.23 写了兜底模板先接软换行、不再输出半句；OCR 只有 1 份样本。核对一致，保留。 |
| 42 §4「行级安全不覆盖会话记忆和 admin audit」 | 已改 | API_AUTH_ENABLED 默认 false；031、032 两个迁移都在；local/qdrant 是单租户；角色拆分下运行时登录仍能切进 system 角色（AGENTS.md）。保留。 |
| 43 §4「需要一个没有表权限的独立登录角色」 | 已改 | getPostgresTenantContextMode 默认 lenient；角色拆分下未绑定上下文的语句以 42501 失败（docs/tenant-isolation.md）。保留。 |
| 44 缺 3.31/3.32 两节 | 已改 | 两节所有数字都和 docs/tenant-isolation.md、docs/evaluation.md 原文逐条对过。我又改了：阶段 2–5 改为 1–5；「几乎都默认关、行为和以前一样」改成不自相矛盾的说法；验证标签改为「验证」；评测数补上「项检查」；OCR 样本描述改准。 |
| 下半部分：3.15 面试说法「单个 Node 进程约 90 req/s」 | 已改 | 同 37，补了前提。 |
| 下半部分：3.19「agent 层占全部应用 CPU 的 84%」 | 已改 | 注里的「62–67%，不是配对数据」和 3.24 原文一致，保留。 |
| 下半部分：3.22「不带 workspaces claim 的 token 仍可选任意 workspace」 | 已改 | 注写的是默认 off 时如此、TENANT_MEMBERSHIP=enforce 时要求成员身份，和 AGENTS.md、config.js 的默认值一致，保留。 |
| 下半部分：CURRENT-TRUTH 没收录 PDF_PARSER=auto 与 worker 池数字 | 已改 | 已在 3.31 补上，见 44。 |
| 下半部分：CURRENT-TRUTH 没有租户隔离阶段 2–5 的小节和数字 | 已改 | 已在 3.32 补上，并按合并提交改为阶段 1–5。 |
| 下半部分：3.8「test/postgres-row-level-security 现在是 28 个用例」 | 未改 | 28 不是文档原文，也不是代码常量，所以没写；只注明 24/24 是当时的数字，套件后来加了用例。 |
| 下半部分：§2 持久化与恢复缺 LangGraph 线程、审批哈希、drain | 已改 | 同 35。checkpointer.js 和 drain-bridge.js 两个文件都存在。 |
| 下半部分：§4 拆分部署「compose 文件没有真正跑过」（与 47 口径统一） | 已改 | 改为只有 compose.services.yml 只用 docker compose config 校验过，和 docs/deployment.md 一致；compose.demo.yml 已构建、已启动的事实记在 3.32。 |

核验时改正的编辑问题：

- §2 表「持久化与恢复」行：写成「LangGraph 线程……和 checkpoint 对不上就转人工」，没限定范围。代码里只有 v3 图在启动恢复时核对线程（agent-run-recovery.js 的 verifyLangGraphThread 只在 unifiedGraph 时调用）；custom-Skill DAG 是重新调用，旧线程直接写墓碑。 → 改为「v3 恢复时和 checkpoint 对不上就转人工」。
- §2 表「持久化与恢复」行：「图内批准后的写入按 run + 节点的幂等键只执行一次」接近 exactly-once 的说法。agent-unified-graph-stage.js 的注释写的是只有遵守这个键的 Capability 才不会对同一节点写两次；重放矩阵里 capability_call 的幂等性是 capabilityDefined（交给 Capability 适配器）。 → 改为「图内批准后的写入带 run + 节点的幂等键」。
- 3.32 标题与结论：写的是「阶段 2–5」。合并提交 5dc46718 写的是「tenant isolation (phases 1-5)」；阶段 1 的提交 25e48382（拒绝空租户范围、审计进 RLS、健康检查查角色属性）也在这次合并里，CURRENT-TRUTH 之前没收录过它。 → 标题和结论改为阶段 1–5；第一条子项改为「阶段 1–2」，补上「开鉴权时拒绝空租户范围、审计进行级安全（迁移 032）」。
- 3.32 结论：「新增的加固项几乎都是开关、默认关，不开时行为和以前一样」和同一节自己列的「默认就生效的」几项（空租户拒绝、探针只回 status、no-store、输入上限、公平排队、审计哈希链、用量账本）矛盾。 → 改为「大多是开关、默认关（默认就生效的几项列在下面）」。面试说法里的「加固项默认关」也改成「大多默认关」。
- 3.32「全开组合在哪验证过」：这个标签下也列了后端全量和确定性评测，但它们不是在 hardened.env 下跑的。只有 hardened e2e 测试和 Docker 演示用了全开配置。 → 标签改为「验证」，并写明 hardened.env 只用于端到端测试和 Docker 演示。
- 3.32 确定性评测：「trajectory 84/84、planner（mock）27/27、recovery 29/29」没写单位，容易和 3.30 的 19/19、7/7、8/8（用例数）混淆。2026-10-18 本地报告里这几个数是 checkCount（用例数分别是 19/7/8）；3.20、3.21 也写作「84 项检查」。 → 补上「项检查」。
- 3.15「面试里的说法」：「memo 之后约 239–258 req/s」没写前提。3.24 测的是行级安全路径、并发 32。 → 补上「行级安全路径、并发 32」。
- 3.26 / 3.27 的分歧注：注里写了「引用时优先说 183/2338」，这个偏好没有依据：两节都是同样 55 份 PDF、2338 块，17.9% 那节日期更晚、标的是「当前抽取」。注也偏长。 → 去掉偏好，只说明两处口径没写清、对不上，引用前要说明；3.27 的注也压短了。
- 3.31 OCR 路由：「渲染成没有文字层的 PDF」不准确。evaluation.md 里的样本是前 3 页渲染成图片，后面再接原件第 4、5 页，共 5 页。 → 改为「渲染成没有文字层的页」。

### INTERVIEW-FAQ.md

| 条目 | 结果 | 说明 |
| --- | --- | --- |
| #9 FAQ 第 3 题 执行规划器只能在选中步骤里挑 | 已改 | 编辑代理的改法基本对。我补了 web_search 兜底，核对了 getSelectedExecutionStepIds 和 normalizePlannerPayload（continue 丢弃），以及 agent.js 里 rollout 不为 off 时才列出已授权的 Skill。 |
| #10 FAQ 第 4 题 Temporal/LangGraph checkpointer 类似、由 Skill 契约声明 | 已改 | 核对了 RunStoreCheckpointSaver extends BaseCheckpointSaver、interrupt()、langgraph_thread_mismatch，以及 STEP_REPLAY_SAFETY_MATRIX 和 getDeclaredContractReasonCodes（声明只能收窄）。编辑代理的改法成立。 |
| #11 FAQ 第 4 题 启动时只在节点边界自动续跑 | 已改 | 我改正了“只剩”（应为“恰好只有”），并把“节点边界、checkpoint 对账”的条件只归到两种图，custom_skill 是整步重放。保留了“run 没有租约（读代码推断）”。默认 AGENT_RUN_RECOVERY_MODE 在 PostgreSQL 下是 auto（docs/configuration.md）。V1 待审批 run 被打 manual 标记这一点没有写进去。 |
| #12 FAQ 第 5 题 长期记忆和经验记忆只作规划提示 | 已改 | 我把“长期偏好”改成“长期记忆（偏好和笔记）”，因为 PUBLIC_MEMORY_CATEGORIES 包含 note。经验记忆的重排和补入核对了 applyExperienceHintsToCandidates；会话键和 LONG_MEMORY_SCOPE 与 AGENTS.md 一致。 |
| #13 FAQ 第 6 题 sparse 不是 BM25 | 已改 | config.js 里 DEFAULT_SPARSE_SCORING 是 bm25；与 ts_rank_cd 的差异是 −0.0012，不显著（docs/evaluation.md 检索调优）。编辑代理的改法正确。 |
| #14 FAQ 第 6 题 hybrid 0.71/0.65/0.66 | 已改 | 0.517/0.511/0.442、+0.074 显著、+0.006 不显著，与 CURRENT-TRUTH 3.1 一致；48 条用例的数字留作历史补充，表述也正确。 |
| #15 FAQ 第 7 题 交叉编码器下一步再测 | 已改 | 数字与 3.14a/3.14b 一致。我删掉了编辑代理加上的、出处里没有的默认关理由（F1 不显著）。 |
| #16 FAQ 第 8 题 上线前要报告 kappa | 已改 | 3.21 的数字核对一致：10/41、0/9→2/9、4/9；第二轮 dev 0/9→2/9，第三轮 train 1/7。我补了“Agent 路径”这个前提。 |
| #17 FAQ 第 9 题 都能在本地用真实模型复现 | 已改 | 已分成效果层和契约层，quality:current 的同提交、干净工作区要求核对过（quality-current-gate.js dirtyWorktree）。我把“差异都带置信区间”改成“比较两组时带”。 |
| #18 FAQ 第 10 题 结论完全反过来 | 已改 | 0.543 对 0.658 与 3.1 表格一致。我把“48 条上不显著”改成“全量上不显著”，因为 tuning 子集是显著的。 |
| #19 FAQ 第 13 题 下一步换 NLI 或 LLM 评审 | 已改 | RAG_CLAIM_JUDGE 默认 off，NLI 没做。编辑代理的改法成立。 |
| #20 FAQ 第 14 题 一轮 6 个用例约 14 秒 | 已改 | createDefaultPlannerCases 现在是 7 个用例，3.3 的每组 30 用例 / 5 轮 = 6 个；已注明“没重测”。 |
| #21 FAQ 第 14 题 AsyncLocalStorage 跨层记账 | 已改 | 核对了 remote-retrieval.js 的 chargeRetrievalUsage 和 mirror 事件。我把“检索服务”改成“检索代码”。 |
| #22 FAQ 第 17 题 检索服务深处的调用挂在 Skill 下 | 已改 | 核对了 service-client.js 的 propagation.inject，agent、检索、网关三层都挂了 bindServiceTraceContext。我把“四层”改成出处里的“跨层”。 |
| #23 FAQ 第 15 题 还没做对抗测试集 | 已改 | 数字与 3.10 和 docs/evaluation.md 一致。我把“已上线”改成“已实现、默认开启”，并给改写绕过补了“英文、文档 RAG”的前提。 |
| #24 FAQ 第 18 题 v3 冻结在 shadow | 已改 | V2 默认、V1 兜底、v3 有 guarded 档但默认关、原生调度器已删，与 AGENTS.md 和 3.30 一致。 |
| #25 FAQ 第 18 题 评测数据只有几十条 | 已改 | 已改成“QASPER 接得太晚”，没有问题。 |
| #26 工程与可靠性缺多租户、LangGraph、往返的题 | 已改 | 第 20–22 题的数字都核对过：3.8、3.15、3.22（ACME 漏洞）、3.28–3.30、docs/evaluation.md 往返一节、ADR 0001 的 10% 门。我改正了硬门漏写的 p95 和信封加密的密钥范围。题号顺延、保留第 18、19 题的理由站得住，DEEP-DIVE-PLAYBOOK 里有按 FAQ #18、#19 的引用。 |
| 下半部分：FAQ 第 19 题 | 原本无误 | 没有过时的事实。 |
| 清单 #2（补检索 61 次只过 1 次）对 FAQ 第 8 题 | 未改 | 清单把这条派给了 180 秒稿。FAQ 第 8 题只是描述机制，机制本身准确，不改。 |

核验时改正的编辑问题：

- INTERVIEW-FAQ 第 3 题：“可用阶段”只列了意图选中的阶段和 custom_skills，漏了 Web 兜底：getSelectedExecutionStepIds 在选了 document_rag 时总会加入 web_search。 → 补了“选了文档问答时还能带上条件触发的 Web 兜底”。
- INTERVIEW-FAQ 第 4 题：“外层计划只剩 custom_skills”不准，hasGraphOnlyStoredExecutionPlan 要求存下的计划恰好只有 custom_skills 这一个阶段。另外“都在节点边界续跑、都要求 checkpoint 对账”套在了第三种情形上，但没有图 checkpoint 的 custom_skill 是整步重放（findAutoRecoverableStep → resumeStep），不在节点边界，也没有 checkpoint 可对账。 → 改成“恰好只有 custom_skills 一个阶段”。三种情形共同的条件只留“没有待审批项”；节点边界、checkpoint 对账、在途节点转人工只归到两种图；第三种写成“整步重放，矩阵里只有它标成可自动重放”。
- INTERVIEW-FAQ 第 5 题：“长期偏好进 prompt、影响答案风格”说小了：getLongMemoryContext 读的是 preference 和 note 两类（PUBLIC_MEMORY_CATEGORIES），笔记也会进 rewriteBlock 和 answerBlock，影响的不只是风格。 → 改成“长期记忆（偏好和用户记下的笔记）会进追问改写和答案 prompt 的偏好块，并标明不能当文档证据”（buildMemoryBlock 的表头就这么写）。
- INTERVIEW-FAQ 第 7 题：“默认关是因为……F1 又没有显著提升”给默认关编了一个出处没有的理由。CURRENT-TRUTH 3.14a 和 AGENTS.md 只说默认关是因为要单独的模型服务。 → 理由只留“要单独的模型服务”。F1 +0.008 不显著前面已经写了，没有重复。
- INTERVIEW-FAQ 第 8 题：QASPER train 50 题这组数字（10/41、0/9→2/9、4/9）来自 3.21 的 Agent 路径测量，原文没写这个前提。 → 改成“Agent 路径上的 QASPER train 50 题”。
- INTERVIEW-FAQ 第 9 题：“差异都带配对置信区间”说过头了：verify:quality 是检查清单，没有置信区间；eval:qasper-answers 本身也不输出置信区间（AGENTS.md）。 → 改成“比较两组时带配对置信区间”。
- INTERVIEW-FAQ 第 10 题：“48 条用例上差异不显著”不准确：48 条里的 tuning 子集上 hybrid 比 BM25 +0.097，是显著的（3.1）。 → 改成“48 条用例全量上差异不显著”。
- INTERVIEW-FAQ 第 14 题：“单体里调用深在检索服务里”自相矛盾：单体部署里没有独立的检索服务。 → 改成“单体里调用深在检索代码里”。
- INTERVIEW-FAQ 第 15 题：“三层防护都已上线”读起来像在生产上验证过。“改写改前改后都是 3/3”漏了前提：这是英文改写、在文档 RAG 出口上的结果，Agent 路径是 3/3→1/3（docs/evaluation.md）。 → 改成“都已实现、默认开启”（RAG_INJECTION_SCREEN 默认 on，guardAnswerLinks 和 prompt 规则没有开关），删掉了重复的“（默认开）”；绕过一句改成“刻意绕开模式的英文改写在文档 RAG 上改前改后都是 3/3 成功”。
- INTERVIEW-FAQ 第 17 题：“四层仍是一条 trace”在出处里找不到：docs/configuration.md 只写“跨层是同一条 trace”，测试也只覆盖到 edge 和检索这两跳。 → 改成“跨层仍是一条 trace”。
- INTERVIEW-FAQ 第 20 题：硬门只写了“每请求 CPU 最多 +10%”，漏了 p95。ADR 0001 的完成定义是“app CPU/请求和 p95 退化不超过 10%”。 → 改成“压测每请求 CPU 和 p95 退化都不超过 10%”。
- INTERVIEW-FAQ 第 21 题：“按 workspace 的信封加密”太窄：密钥按租户分，有 workspace 用 workspace，没有就按用户，再没有用 unscoped（key-scope.js），CURRENT-TRUTH 3.32 写的是“按租户”。 → 改成“按租户的信封加密（擦除工作区时销毁它的密钥）”。

### NARRATIVE-CASES.md 与 180-SECOND-NARRATIVE.md

| 条目 | 结果 | 说明 |
| --- | --- | --- |
| 1（180 秒稿：checkpoint 续跑、CAS 防重复执行） | 已改 | 编辑代理的改法已核对：只在能证明安全时续跑（STEP_REPLAY_SAFETY_MATRIX 里 capability_call 和 arxiv_import 的 autoReplaySafe 为 false，custom_skill 为 true；恢复逻辑有 hasGraphOnlyStoredExecutionPlan）；CAS 挡住的是旧 worker 的状态写。17.6% 和 10% 的门对上了 CURRENT-TRUTH 3.29 和 ADR 第 291、397 行。没有写幂等键，可以接受。 |
| 2（180 秒稿：补检索一轮，最多 3 条查询） | 未改 | 只描述机制，没说补检索有效。代码核对：DEFAULT_AGENT_MAX_FOLLOW_UPS = 1，gap-planner 里是 slice(0, 3)。被追问时补上 3.21 的「61 次只过 1 次」。 |
| 3（180 秒稿：启发式 reranker 降约 5 个点） | 已改 | 「降约 5 个点」已删。交叉编码器 +0.063 [+0.044, +0.085] 显著、F1 +0.008 不显著，对上了 3.14a。我又把默认关的理由改成只说要单独的模型服务，和出处一致。 |
| 4（180 秒稿：48 条用例的区间跨 0） | 已改 | QASPER 821 题：对 BM25 +0.074 显著，对稠密 +0.006 不显著，对上了 3.1。48 条上 hybrid 比 BM25 +0.054 [−0.038, +0.149]，确实不显著。 |
| 5（180 秒稿：16/18 → 18/18） | 已改 | 「对比题靠模板通过，7B 自己写的对比答案仍被词法校验拒绝」对上了 3.2 注、3.23 和 evaluation.md「对比答案闸门的拒绝原因（2026-10-04）」。 |
| 6（180 秒稿：只处理 PDF 文本层，没有 OCR 和表格） | 已改 | 「30 篇论文上答案 F1 没有显著差异」：Docling 在 69 道表格题上 +0.020 [−0.011, +0.057]（3.14）；auto 在 149 题上 +0.005 [−0.020, +0.032]（evaluation.md）。OCR 只在一份手工扫描件上走通（evaluation.md「OCR 路由」）。 |
| 7（180 秒稿：评测集还小，正在接 QASPER） | 已改 | 改成「外部标注集已接入，但只测过一个 7B 模型」，和 CURRENT-TRUTH §4 一致。 |
| 8（180 秒稿：LLM 评审默认关的理由） | 已改 | 补上了「在 QASPER 上还会回答不可答题」，出处是 3.21：只开评审时 0/9 → 2/9。3/21 → 14/21 是故事 7 的原数。 |
| 27（故事 4：开始接 QASPER） | 已改 | 281 篇、821 题、+0.074 [+0.048, +0.102]、+0.006 [−0.019, +0.031]、0.057 都和 3.1 原文一致。0.057 在 48 条上本来就不显著，写成「印象」是恰当的。 |
| 28（故事 1：16/18 → 18/18） | 已改 | 补充句已核对。我把「开始记录拒绝原因后看到」改成「加上拒绝原因记录后测了两轮」，免得把样本说大。 |
| 29（故事 6：该换校验器而不是继续打补丁） | 已改 | 「后续」核对了 3.21：三轮里选出的组答题率和 F1 都显著上升（+0.244/+0.077、+0.363/+0.123、+0.279/+0.095），每轮都多答了不可答题（2/9、开发集 2/9、1/7），三轮都没通过。我只改了末句断句。 |
| 30（故事集缺恢复、取消、LangGraph） | 已改 | 新增故事 8（取消被熔断器记成失败）和故事 9（外层计划上 LangGraph 两次压测不过门），数字逐个对过 3.20、evaluation.md、3.28、3.29 和 ADR 阶段 3、阶段 5。我把故事 9 的「续跑靠 run 的 step」改成「它的持久化就是 run 的 step」。CAS 漏事件的故事没加，清单的 2–3 个已满足下限。 |
| 下半部分·Agent 编排 / 运行持久化：180 秒稿续跑与 CAS 说大了、没提 LangGraph | 已改 | 和第 1 条是同一处修改，已核对。 |
| 下半部分·运行持久化：NARRATIVE-CASES 没有恢复、审批、取消的故事 | 已改 | 取消有故事 8，LangGraph 有故事 9。审批续跑和 CAS 漏事件仍然没有故事（见剩余疑虑）。 |
| 下半部分·文档解析 / 评测体系 / 服务拆分：180 秒稿边界段（PDF 文本层、QASPER） | 已改 | 和第 6、7 条是同一处修改，已核对。 |
| 下半部分·评测体系：180 秒稿检索段只有 48 条用例 | 已改 | 和第 4 条是同一处修改，已核对。 |
| 下半部分·答案生成：180 秒稿和故事 1 缺「对比靠模板通过」 | 已改 | 和第 5、28 条是同一处修改，已核对并收紧了措辞。 |
| 下半部分·答案生成：故事 6 结尾缺后续 / 180 秒稿评审缺 QASPER 风险 | 已改 | 和第 29、8 条是同一处修改，已核对。 |
| 下半部分·评测体系 / 文档解析：故事 4 的 QASPER | 已改 | 和第 27 条是同一处修改，已核对。 |
| 下半部分·多租户：三份稿完全没有多租户内容 | 未改 | 是内容缺口，不是说法过时；这次任务只要求修正事实，没有补写。 |

核验时改正的编辑问题：

- server/docs/interview/180-SECOND-NARRATIVE.md（1:15–2:20 检索段）：把交叉编码器默认关的原因写成「答案 F1 不显著、要单独服务」两条。CURRENT-TRUTH 3.14a 和 AGENTS.md 给的理由只有一条：需要单独的模型服务。 → 改为「但答案 F1 不显著；它要单独的模型服务，所以默认关」。F1 不显著仍作为事实保留，默认关只归因于要单独的服务。
- server/docs/interview/NARRATIVE-CASES.md 故事 1「结果」：「2026-10-04 开始记录拒绝原因后看到」读起来像那之后一直在观察，样本被说大了。docs/evaluation.md 里只有那天测的两轮：verify:quality 1 次、compare-hard 5 次。 → 改为「2026-10-04 加上拒绝原因记录后测了两轮」。「全部 unsupported_claims」有 evaluation.md 和 CURRENT-TRUTH 3.23 原文支持，保留。
- server/docs/interview/NARRATIVE-CASES.md 故事 9「修复一」：「续跑靠 run 的 step」容易被理解成外层计划能自动续跑。实际上外层 V1 run 只有 custom_skill 步骤能自动重放，主 document_rag 在途会转人工。ADR 和 AGENTS.md 的说法是外层计划的持久化就是 run 的 step。 → 改为「外层计划不需要持久状态和中断（它的持久化就是 run 的 step），所以留在原生循环」。
- server/docs/interview/NARRATIVE-CASES.md 故事 6「后续」：末句「两头都顾需要更强的答案或评审模型」少了断句，读着像病句。 → 改为「瓶颈是词法校验加 7B 模型；要两头都顾，需要更强的答案或评审模型」。只改标点，事实不变。

### AGENTS.md

| 条目 | 结果 | 说明 |
| --- | --- | --- |
| 45：BM25 一节 `<t>_bm25_rank` / RAG_BM25_PRUNE_DF_FRACTION / PGVECTOR_BM25_PRUNE_MIN_CHUNKS | 已改 | 编辑代理的改法和代码对得上：迁移 030 第 627、697 行的 `<t>_sparse_fold()` 和 `<t>_sparse_search(...)` 都是 SECURITY DEFINER；config.js 里有 RAG_SPARSE_PRUNE_DF_FRACTION（默认 0.1）和 RAG_SPARSE_COMMON_TERM_CAP（默认 2000）；vector-store-pgvector-sparse.js 里有 PGVECTOR_SPARSE_PRUNE_MIN_CHUNKS = 1000。我又改了剪枝那句：迁移 030 里每一轮常见词扫描都受上限约束，`pruned_filled` 的补齐轮也一样，不只是 `common_bounded`。现在写成『each common-term pass scores at most RAG_SPARSE_COMMON_TERM_CAP (default 2000) candidates』。 |
| 46：Limits 里 'The model-call guard's concurrency queue does not observe the signal.' | 已改 | 删得对。model-call-guard.js 的 enqueueWaiter 在 signal abort 时让等待者离队并 reject（第 369–382 行）；acquire 遇到已 abort 的 signal 直接 reject（第 430、815 行）；guardModelCall 也把 signal 传了进去（第 911 行）。 |
| 47：compose.demo.yml '(checked with docker compose config only, never built)' | 已改 | 出处对得上：docs/tenant-isolation.md 第 110 行写着『镜像构建成功；compose.demo.yml 下三个容器都健康』（提交 6c83fb96）。compose.demo.yml 里正好有 postgres、demo-model、app 三个服务。原来的括号接在『test/deployment-contract.test.mjs pins it』后面，读起来像是测试做了构建，我改成『pins it, and it was built and started once (2026-10-18: …; docs/tenant-isolation.md)』。compose.services.yml 那句『never built』保留，docs/deployment.md 第 262 行仍这么写。 |
| 下半部分·文档解析：BM25 锁顺序 'Trigger lock order: scope rows first … per-scope lock' | 已改 | 新写的『Statistics writes』和迁移 030 头注释一致：只追加日志、pg_try_advisory_xact_lock 下合并、只有 fold 写总表、搜索在一个快照里读总表加日志。『no tenant grant』也对：迁移 030 只有 REVOKE ALL FROM PUBLIC，迁移 035 注释也写了 no grant there，vector-store-pgvector.js 注释写的是 policy (and no tenant grant)。 |
| 下半部分·文档解析：剪枝描述（缺 RAG_SPARSE_COMMON_TERM_CAP，'fewer than K 时走穷举'） | 已改 | 按迁移 030 第 226–235 行和第 345–500 行核对过：没有常见词，或分块不超过 prune_min_chunks 时走穷举；稀有词召回不足时走 pruned_filled；只有常见词时走 common_bounded。上限一句已按上面 45 号的说明改准。 |
| 下半部分·文档解析：RLS 一节 '<chunks table>_sparse_rank (migration 014)' | 已改 | 按 usesPgvectorSparseSearchFunction 核对：BM25 一律走 030 的 `<t>_sparse_search`；ts_rank_cd 只有在开剪枝且多文档时才走它；否则租户多文档查询走 014 的 _sparse_rank，单文档走普通语句。健康检查那句和 health.js 第 1139–1142、1221 行一致。我补了一处：剪枝默认开（0.1），所以 014 的函数只在 `RAG_SPARSE_PRUNE_DF_FRACTION=off` 时才会用到。原句写成『without pruning』，像是剪枝默认关，现在改成『with pruning off (RAG_SPARSE_PRUNE_DF_FRACTION=off)』，并补上『which is on by default』。 |
| 下半部分·文档解析：查询适配器（QUERY_ADAPTER_MISMATCH 直接拒绝、指纹进缓存键、documented tuned setting、vectorScore 失准） | 已改 | 大部分和 query-adapter.js 头注释、embedding-cache.js 第 105–110 行、run-query-adapter-eval.mjs 头注释对得上，0.692→0.738、+0.046 [0.024, 0.069]、0.2576→0.2562 不显著、−0.032 也和 CURRENT-TRUTH §3.18、docs/retrieval-tuning.md 一致。我改了三处。(1) 原句说其他情况都会告警一次，其实超出范围的调用（不是 single_document_qa，或不止一个 docId）直接返回 null，不告警。现在改成：只有在范围内但没法适配时才告警，每个原因一次。(2) 答案 F1 补上前提：『200 QASPER dev questions with qwen2.5:7b』，依据 retrieval-tuning.md 第 306 行。(3) 『its key; it is stamped』里的『it』指代不清，改成『the fingerprint is stamped』。 |
| 下半部分·文档解析：planDoclingBatches 写在 rag/pdf-auto-parser.js 下 | 已改 | 核对过：定义在 rag/pdf-page-router.js 第 120 行，pdf-auto-parser.js 第 41 行导入、第 189 行调用。 |
| 顺带：'Both use Lucene's IDF and RAG_BM25_K1 / RAG_BM25_B' | 已改 | 改成『bm25 uses』是对的：ts_rank_cd 不用 IDF 和 k1/b，迁移 030 搜索函数里只有 BM25 分支计算 idfs。 |
| 顺带：sparse_length 'Do not backfill with an UPDATE' | 已改 | 新句和迁移 029 头注释（在迁移里回填会给每个索引加一条新条目，HNSW 也算）以及 sparse-length-backfill.mjs 头注释（分短批次、像 reindex 一样放在低峰跑）一致，package.json 里有 vector:sparse-length。 |
| 清单 1–44、48（不属于 AGENTS.md） | 未改 | 不在我的文件范围，没动。 |

核验时改正的编辑问题：

- AGENTS.md，BM25 节『Common-term pruning』第二条：写成只有『只含常见词的查询』每轮受 RAG_SPARSE_COMMON_TERM_CAP 限制；迁移 030 里 pruned_filled 的补齐轮同样受上限约束（capped 时用 LIMIT common_term_cap） → 改为『a query with only common terms is `common_bounded`; each common-term pass scores at most `RAG_SPARSE_COMMON_TERM_CAP` (default 2000) candidates』
- AGENTS.md，PostgreSQL row-level security 一条：『multi-document ts_rank_cd search without pruning』容易读成剪枝默认关；实际 DEFAULT_SPARSE_PRUNE_DF_FRACTION = 0.1，014 的 _sparse_rank 只在显式关掉剪枝时才会用到 → 改为『with pruning off (`RAG_SPARSE_PRUNE_DF_FRACTION=off`)』，括号里写成『a multi-document `ts_rank_cd` search with pruning, which is on by default』
- AGENTS.md，Query-side embedding adapter 一条：『anything else … searches unadapted with a one-time warning』不准：adaptQueryVectorForSearch 在 scope 不是 single_document_qa 或 docIds 不止一个时直接返回 null，不告警 → 改为：其他情况都按未适配检索；在范围内却没法适配时（路由、融合方式或存储不对，替身向量，空间不一致，文件损坏或读不了），每个原因告警一次
- AGENTS.md，Query-side embedding adapter 一条：新写的答案 F1 数字缺前提：没写模型和数据切分 → 改为『answer F1 on 200 QASPER dev questions with qwen2.5:7b was flat (0.2576 -> 0.2562, not significant)』（docs/retrieval-tuning.md 第 306 行、CURRENT-TRUTH §3.18）
- AGENTS.md，Query-side embedding adapter 一条：『so the fingerprint is not part of its key; it is stamped as …』里的『it』指代不清 → 改为『the fingerprint is stamped as …』
- AGENTS.md，Hardened tenant-isolation demo 一条：括号接在『test/deployment-contract.test.mjs pins it』后面，读起来像是这个测试构建并启动了镜像 → 改为『`test/deployment-contract.test.mjs` pins it, and it was built and started once (2026-10-18: the image built and all three containers were healthy; `docs/tenant-isolation.md`)』
