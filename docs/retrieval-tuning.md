# 检索调优：BM25、常见词剪枝、语义缓存、查询适配器

数字和决策见 `docs/evaluation.md` 的"检索调优"与 `server/docs/interview/CURRENT-TRUTH.md` 3.18。

## BM25 与常见词剪枝

> 2026-09-27 更新：`RAG_SPARSE_SCORING` 默认改为 `bm25`（用户决定）。QASPER dev 上与 `ts_rank_cd` 没有显著差异；升级前写入的库先跑 `npm run vector:sparse-length` 回填分块长度。设 `RAG_SPARSE_SCORING=ts_rank_cd` 可以回到原来的排序。

1）更新现有行：
- `RAG_PGVECTOR_TEXT_SEARCH_CONFIG`：说明结尾改为"默认用 `ts_rank_cd` 排序（不是 BM25）；`RAG_SPARSE_SCORING=bm25` 时改用 Okapi BM25。"

2）新增行：
- `RAG_SPARSE_SCORING`，默认 `ts_rank_cd`
  - pgvector 稀疏路的排序方式，二选一：
    - `ts_rank_cd`：PostgreSQL cover density，不是 BM25，报告里的 sparseBackend 为 `postgres_fts_ts_rank_cd`；
    - `bm25`：Okapi BM25，sparseBackend 为 `postgres_bm25`。
  - 未知值直接报错，不回退。local 稀疏路本来就是 BM25，不受影响。
  - 迁移 029/030 的统计量不论取哪个值都会实时维护，所以切换立即生效。
- `RAG_BM25_K1`，默认 `1.2`：BM25 词频饱和参数，≥0。local 与 pgvector 两条 BM25 共用。
- `RAG_BM25_B`，默认 `0.75`：BM25 长度归一化参数，取值 [0,1]，超出范围回到 0.75。两条 BM25 共用。
- `RAG_BM25_PRUNE_DF_FRACTION`，默认 `0.1`：常见词剪枝。
  - 候选只由"文档频率不超过作用域 chunk 数这一比例"的查询词经 GIN 生成，再用全部查询词打分。
  - 以下情况不剪枝，直接穷举：
    - 所有词都会被剪掉，或没有词会被剪掉；
    - 被检索文档合计不超过 1000 个 chunk（按文档表 chunk_count；单篇 QA 永远穷举）；
    - 区分度高的词命中不足 topK。
  - `off`、`0` 或 ≥1 表示关闭。

【docs/agent-rag.md 第 4 步括号】
改为："sparse 路（PostgreSQL FTS，默认 `ts_rank_cd` 排序，不是 BM25；`RAG_SPARSE_SCORING=bm25` 时为 Okapi BM25，统计量按索引版本、按 owner/workspace 作用域维护）"。

【docs/development.md 第 161 行】
改为：
"sparse 路在 pgvector 上默认是 PostgreSQL FTS（`ts_rank_cd`），只有 `RAG_SPARSE_SCORING=bm25` 时才是 BM25。sparseBackend 分别是 `postgres_fts_ts_rank_cd` 和 `postgres_bm25`，文档、报告、代码里不要混写。"

【docs/evaluation.md，或评测章节】
新增：
"`npm run eval:sparse-scoring -- --corpus evaluation/generated/qasper-dev.json --cases 821`
- 在一次性 PostgreSQL 里用应用自己的迁移、入库和检索代码，比较 pgvector 稀疏路的三种打分：ts_rank_cd、BM25 穷举、BM25 常见词剪枝。
  - `eval:qasper-retrieval` 走 standalone profile，测到的是 local BM25，不是这条路。
  - 不传 `--database-url` 时，自动在 $TMPDIR、系统分配的端口上建集群，结束后删除。
- 指标：
  - hybrid 与纯 sparse 两种路由下的证据召回（hitAt1/3/All、admitted），每项都带配对 bootstrap 95% CI；
  - 强制剪枝时，剪枝相对穷举有多少 top-K 列表发生变化。
- 需要 embedding 端点（例如本地 Ollama nomic-embed-text），不调用聊天模型。
- 运行时把 DOTENV_CONFIG_PATH 指向空文件。

规模压测新增参数：
- `bench:pgvector-scale` 新增 `--sparse-doc-sets 1,100,1000,all` 与 `--prune-df-fractions 0.1,0.2`：在同一批数据、同一组种子查询上，以租户身份比较上述打分的 p50/p95（常见词查询单独列出）和剪枝造成的结果变化。
- ingest 探针在有、无 BM25 统计触发器两种模式间按 ABBA 交替测量写入代价。"

【server/docs/interview/CURRENT-TRUTH.md 新条目】
"**pgvector 稀疏路补上真 BM25，常见词长尾靠剪枝解决（2026-09-27）**

做法：
- 迁移 029/030 为每个索引版本的 chunk 表、按 (owner_user_id, workspace_id) 作用域维护 BM25 统计（chunk 数、总长度、每个词的文档频率），由语句级触发器在写入事务内精确维护；
- 词频取自 tsvector 的 position 数；
- BM25 由表所有者身份运行的函数打分：只读被检索文档所属作用域的统计，租户身份下再按行级安全谓词过滤文档 id；
- 与 local BM25 在同样数据上的分数差小于 1e-9。

常见词剪枝：只用区分度高的词经 GIN 生成候选，再用全部词打分。

10 万分块、2000 篇文档、行级安全开启，同一次运行、100 条查询，稀疏路 p50/p95（ms）：

| 文档范围 | ts_rank_cd | BM25 剪枝 |
|---|---|---|
| 1000 篇 | 24.2/64.5 | 21.7/32.7 |
| 全表 | 55.6/187.8 | 42.7/104.7 |
| 全表常见词查询 | 186.6/262.5 | 49.5/64.2 |

- 另一次负载更低的运行：全表 42.1/136.1 → 33.1/78.6。
- 剪枝后的 top-10 与穷举 BM25 相比，100 条查询里 0 条变化；不剪枝的 BM25 全表 p95 反而是 377 ms。
- 代价一：单篇文档搜索慢约 0.27 ms（0.47 → 0.74 ms）。
- 代价二：写入每 50 个 chunk 慢约 6%（337 → 359 ms）。

QASPER（pgvector 路，nomic），BM25 剪枝 − ts_rank_cd：
- dev：hybrid 证据召回 −0.0012 [−0.0122, +0.0097]，不显著；纯 sparse hitAt3 +0.023 [−0.005, +0.051]，不显著；
- train：hybrid −0.0075 [−0.030, +0.015]。

结论：按事先定的规则（dev hybrid 召回 CI 下界要高于 −0.01，且延迟不退化），召回一项没过，所以默认仍是 ts_rank_cd，BM25 由 `RAG_SPARSE_SCORING=bm25` 开启。面试里不能说"BM25 提升了召回"，只能说"BM25 + 剪枝把全表 p95 砍了近一半，召回没有可测差异"。"

### 审查后的修正

### 稀疏路由：集合统计、BM25 与常见词剪枝（迁移 029/030）

- 统计怎么维护：每个索引版本的 chunk 表都有两张只追加的日志表 `<t>_sparse_scope_log` 和 `<t>_sparse_term_log`（没有主键和唯一索引），以及两张汇总表 `<t>_sparse_scopes` 和 `<t>_sparse_terms`。
  - 写入方（ingest、替换、删除、清空、级联删除、版本构建、reindex）只往日志表插行，所以同一租户范围内的多个写入方互不等待，也不会在版本表之间互相死锁。
  - 汇总由 `<t>_sparse_fold()` 在 `pg_try_advisory_xact_lock` 下完成：抢到锁的那条写语句负责折叠，其余写语句直接跳过，不等待。
  - 查询在同一快照里读“汇总 + 未折叠日志”，结果精确。
  - 触发器和 fold 以 owner 身份运行（SECURITY DEFINER）。统计表带 tenant_isolation 策略，但不授权给租户角色。
- 两种打分：
  - `ts_rank_cd`（默认）是覆盖密度排序，不是 BM25。
  - `RAG_SPARSE_SCORING=bm25` 是 Okapi BM25（Lucene IDF），统计按被搜文档所在的 (owner_user_id, workspace_id) 范围计算。
- 常见词剪枝（默认开启，两种打分都适用）：
  - 生效条件：被搜文档的 chunk 数超过 1000。`RAG_SPARSE_PRUNE_DF_FRACTION=0.1` 表示在所属范围内出现在超过 10% chunk 中的词算常见词。
  - 候选只从稀有词生成，但用全部查询词打分；稀有词召回不足 K 条时，从常见词里补齐。
  - 只含常见词的查询（包括单个词）最多取 `RAG_SPARSE_COMMON_TERM_CAP=2000` 个候选：若这些词的文档频率之和超过上限，先取同时含全部常见词的 chunk，再取含任一常见词的，按物理顺序、不并行（结果确定）。若频率之和不超过上限，结果与穷举完全相同。
  - 每条结果的 `sparseCandidates` 标明走的是哪条路径（exhaustive / pruned / pruned_filled / common_bounded）。
- 实测（scale bench，10 万 chunk，租户、开启 RLS、查全表）：
  - 含常见词的混合查询：ts_rank_cd 的 p50/p95 从 135/180 ms 降到 39/49 ms（100 条中 4 条 top-10 列表有变化，recall@K 0.995）；BM25 从 281/389 降到 40/51 ms（列表不变）。
  - 单个常见词：ts_rank_cd 从 64/151 降到 16/25 ms，BM25 从 77/369 降到 18/26 ms。但与穷举结果相比 recall@K 只有 0.29-0.32，因为这类查询按物理顺序截断，不是按相关度。
  - 三个常见词：ts_rank_cd 从 177/455 降到 10/20 ms（recall@K 0.41），BM25 从 210/409 降到 11/22 ms（recall@K 0.957）。
- QASPER 证据召回（剪枝真正生效的场景：全部论文作为文档集，train 400 题、dev 821 题，配对 bootstrap 95% CI）：
  - 默认 hybrid 路由上，ts_rank_cd 剪枝减穷举：train hitAtAll 0 [0, 0]、hitAt3 −0.005 [−0.0125, 0]；dev hitAtAll 0 [0, 0]、hitAt1 −0.0037 [−0.0097, 0.0012]。没有显示出损失。
  - BM25 剪枝减穷举在所有指标上都是 0 [0, 0]。
  - 只含常见词的题只有 3 题（train）和 19 题（dev），且召回接近 0，因此截断路径对证据召回的影响实际上没有测到。
- 两种打分对比：只走稀疏路由且搜全部论文时，BM25 − ts_rank_cd 的 hitAtAll 在 train 为 +0.1125 [0.08, 0.1475]、dev 为 +0.1035 [0.078, 0.1291]，两次都排除了 0。但在默认 hybrid 路由上，无论单篇还是全部论文，差异的区间都包含 0，所以默认打分仍是 ts_rank_cd。
- 按租户统计（每篇论文属于独立 owner，开启 RLS）与合并统计相比：hitAtAll 在 train 和 dev 都没有显示出差异。
- 代价：
  - 单个 50 chunk 的 ingest：p50 336 ms，对比无触发器 317 ms。
  - 4 个同租户写入方并发：10.4 对比 11.1 docs/s，吞吐随并发扩展，与无触发器相同。
  - 删除和清空要展开每个被删 chunk 的 tsvector：每 1000 个 chunk 25 ms，对比无触发器 4.4 ms。
  - 升级前写入的行 sparse_length 为 NULL：每 1000 个 chunk 43 ms（对比 8.6 ms），且穷举 BM25 在 p50 上慢 3-4 倍。可以用 `npm run vector:sparse-length` 分批回填，可中断续跑。

=== AGENTS.md paragraph (replaces the ts_rank_cd-only wording in the VECTOR_STORE_PROVIDER=pgvector bullet) ===
- Sparse route statistics, BM25 and pruning live in migrations 029/030 and `server/rag/vector-store-pgvector-sparse.js`.
  - Statistics are append-only: writers only INSERT into `<t>_sparse_scope_log` and `<t>_sparse_term_log` (no unique index). Whichever write statement wins `pg_try_advisory_xact_lock` folds the log into `<t>_sparse_scopes` and `<t>_sparse_terms` (`<t>_sparse_fold()`); the others skip. Searches read totals plus log in one STABLE snapshot. Never put an upsert on a shared counter row back into the triggers: it serialized same-scope writers and deadlocked a clear against an ingest across version tables. `test/vector-store-pgvector-bm25.integration.test.mjs` pins both.
  - Triggers and the fold are SECURITY DEFINER. The statistics tables carry tenant_isolation but no tenant grant. `checks.rowLevelSecurity` probes the four tables of every live version, plus EXECUTE on the active `<t>_sparse_search` whenever BM25 or pruning makes tenants call it.
  - `RAG_SPARSE_SCORING` defaults to `ts_rank_cd`, which must still not be called BM25. `bm25` is Okapi BM25 over the searched documents' (owner, workspace) scopes. On the default hybrid route BM25 showed no demonstrated difference on QASPER train or dev; on the sparse-only route over all papers it did (+0.10 to +0.11 hitAtAll, CIs exclude 0).
  - `RAG_SPARSE_PRUNE_DF_FRACTION` (default 0.1, above 1000 searched chunks) prunes common terms for both scorings. Measured where it runs (all papers, train then dev), it shows no demonstrated evidence-recall loss on the hybrid route. `RAG_SPARSE_COMMON_TERM_CAP` (default 2000) bounds all-common and one-word queries, whose list fidelity to exhaustive is low (0.29-0.47 on the bench) and whose evidence effect is unmeasured (3 + 19 QASPER questions).
  - Single-document ts_rank_cd keeps the plain statement; multi-document ts_rank_cd with pruning off keeps migration 014's function.
  - `npm run eval:sparse-scoring` (`evaluation/run-sparse-scoring-eval.mjs`, disposable cluster, embeddings only) runs three regimes: single paper, all papers (pruning active), and per-tenant scopes. `npm run bench:pgvector-scale -- --sizes 100k --latest-name latest-pgvector-scale-sparse` reports scoring and pruning latency per query slice, concurrent same-scope writer throughput and delete cost; add `--sparse-length null` for an upgraded archive.
  - Rows written before migration 029 keep `sparse_length` NULL until `npm run vector:sparse-length` (`sparse-length-backfill.mjs`, batched, resumable) fills them.

=== server/package.json scripts to add ===
"vector:sparse-length": "node sparse-length-backfill.mjs",
"eval:sparse-scoring": "node evaluation/run-sparse-scoring-eval.mjs"

=== server/.env.example lines ===
# Sparse route on pgvector (migrations 029/030). ts_rank_cd (default) is PostgreSQL's cover-density
# rank, not BM25; bm25 is Okapi BM25 over the searched documents' (owner, workspace) statistics.
# RAG_SPARSE_SCORING=ts_rank_cd
# RAG_BM25_K1=1.2
# RAG_BM25_B=0.75
# Common-term pruning for either scoring, above 1000 searched chunks (off = exhaustive), and the
# candidate cap for queries whose every term is common (off = score all of them).
# RAG_SPARSE_PRUNE_DF_FRACTION=0.1
# RAG_SPARSE_COMMON_TERM_CAP=2000

=== server/docs/interview/CURRENT-TRUTH.md (Chinese, the numbers that changed) ===
稀疏路由常见词长尾：
- 10 万 chunk、租户开启 RLS、查全表时，含常见词的查询 ts_rank_cd p95 从 180 ms 降到 49 ms（混合查询整体 p95 从 135 ms 降到 73 ms）。
- QASPER 全部论文作为文档集时，hybrid 路由证据召回的剪枝减穷举：train hitAtAll 0 [0, 0]，dev hitAtAll 0 [0, 0]。
- 同租户 4 个写入方并发：10.4 docs/s，无统计触发器时为 11.1 docs/s。
- 命令：`npm run bench:pgvector-scale -- --sizes 100k --latest-name latest-pgvector-scale-sparse`；`npm run eval:sparse-scoring -- --corpus evaluation/generated/qasper-train.json --cases 400`（dev 用 `--corpus evaluation/generated/qasper-dev.json --cases 821`）。
- 基于未提交的工作树，commit 1cdb6029 之上。

## 语义缓存

### 语义答案缓存（RAG_SEMANTIC_CACHE，默认关闭）

`RAG_SEMANTIC_CACHE=on` 开启一个按进程的语义答案缓存（`server/rag/semantic-cache.js`）。它挂在答案接缝 `executeDocumentRag` 上，`/chat`（经 agent 的 document_rag 步骤）和 MCP `archive_ask` 都经过这里。

**查找位置**：路由和查询向量计算之后、检索之前。查找复用检索本来就要算的那个向量，不多调一次模型。命中时跳过检索和答案模型，直接返回缓存的文档 RAG 响应。

**缓存键**：以下各项的摘要，跨键永不命中。
- 租户（userId + workspaceId）
- 精确的授权 docId 集合，以及每个文档的内容版本（version、内容哈希、更新和上传时间、chunk 数）
- 当前索引版本：pgvector 的 version id 加指针 generation，或 provider，再加查询向量空间
- 答案提示词指纹
- 主、备聊天模型
- 答案模式（route mode、需求数）
- agent 检索计划的形状（去掉问题本身；follow-up 计划不缓存）
- 长期记忆偏好块
- 影响检索和答案的配置（RAG_*、OPENAI_* 等，不含密钥）

没有传 accessScope 的调用方不走缓存。

**命中条件**：同一键内，查询向量余弦 ≥ `RAG_SEMANTIC_CACHE_THRESHOLD`（默认 0.97），并且通过词法守卫（`semantic-cache-guard.js`）。守卫要求以下各项一致：
- 否定：not、n't、without、except、un-/non- 前缀，以及 minimum/maximum 这类反义词
- 数字：有序比较，"three" 等于 "3"
- 日期和时间单位："per day" 等于 "daily"
- 命名实体
- 含中日韩文字的问题须完全一致
- 按序的实词序列：允许词形变化、虚词/情态词差异，以及 get/receive、let/allow、need/require、say/state 这几组同义词

守卫是必需的：nomic-embed-text 给否定句 0.994、角色互换 0.991–0.997、长问题里换一个词 0.988–0.995，都高于部分真正的改写（0.94–0.999）。

**只缓存回答**：弃答不缓存。

**失效**：文档入库、替换、删除或清空时立即清掉涉及该文档的条目。另一实例写入后，本进程在注册表刷新后看到新版本，也会清掉旧版本的条目；索引版本切换同样清理。键本身也带版本，旧条目本来就不可达。

**存储**：进程内 LRU（`RAG_SEMANTIC_CACHE_MAX_ENTRIES`，默认 500）加 TTL（`RAG_SEMANTIC_CACHE_TTL_MS`，默认 1 小时，0 表示不过期）。不落 PostgreSQL，理由：
- 正确性不依赖共享；
- 条目含租户文档原文，落库需要新的 RLS 表、保留期和随文档删除；
- 代价是多实例时命中率更低。

**命中标记**：RAG trace 里的 `semanticCache` 字段（hit、similarity、ageMs，未命中时有 bestSimilarity 和 guardRejections）；OTel 事件 `rag.semantic_cache.hit`，只有数值；RAG 响应只在命中时多一个 `semanticCache: {hit, similarity, ageMs}`，其余响应契约不变。命中响应里的 `retrieval` 块描述的是当初生成该答案的那次检索。

**测量**：`npm run eval:semantic-cache`，本地 Ollama（qwen2.5:7b、nomic-embed-text），synthetic-corpus-5docs，构造集 14 组 71 个追问，阈值 0.97。

实测（通过 chat()）：
- 重复问题命中 13/13，改写命中 14/17；
- 对照问题误命中 0/36（其中 31 个的基问题已缓存；类别包括否定、数字、日期、实体、角色、文档、租户）；
- 命中延迟均值 9.4 ms（含一次查询向量），同问题不走缓存均值 1355 ms、中位 509 ms；
- 每次命中节省 1346 ms，配对 bootstrap 95% CI [653, 2189] ms，n=26；
- 未命中时每次查找约 60 µs。

离线扫描（30 个用词不同的对照、19 个改写）：
- 只用向量、阈值 0.97：10/30 误命中；要到 0.995 才降为 0，此时改写只剩 10/19；
- 只查否定、数字、日期、实体：0.97 时仍有 4/30 误命中（实体、角色）；
- 完整守卫：0.90–0.995 全部 0/30，0.97 时改写 16/19。

有 1 次改写命中（"get" 替换 "receive" 的长问题），不走缓存时会被 QA 词法门弃答。也就是说，命中可能给出管线本来会拒答的答案。

`verify:quality` 开缓存仍 18/18。该套件在同一进程内不重复提问，所以 0 命中，只验证查找和存储不改变结果。

默认保持关闭。

### 审查后的修正

## Chinese doc text (for the docs/evaluation.md semantic-cache section; update server/docs/interview/CURRENT-TRUTH.md numbers first)

### 语义答案缓存（RAG_SEMANTIC_CACHE，默认关闭）

缓存位于 `executeDocumentRag` 的答案接缝处，只在进程内生效。命中需要同时满足两个条件：在同一个键内，查询向量的余弦相似度 ≥ `RAG_SEMANTIC_CACHE_THRESHOLD`（默认 0.97），并且词法守卫 `semantic-cache-guard.js` v2 通过。

键包括：租户、文档集及每个文档的内容版本、索引版本、查询嵌入空间、查询 adapter 指纹、答案 prompt 指纹、聊天模型与回退模型、答案模式、规划形状、长期记忆偏好块，以及检索/答案配置。

**守卫 v2 是"近乎逐字"匹配加一张短白名单。** 允许的差异只有：大小写、标点、缩写；冠词、do/does、is/are/am、所有格 's、of；复数 -s；get/obtain/receive、let/permit/allow、need/require、say/state/mention 这几组同义词（词形必须一致）；during/in；数字与数词；"per/each/a <单位>" 与 daily 等写法；同一类内的情态词。情态词分三类：许可（can/could/may/might）、义务（must/shall/should/have|has|need|ought to）、将来（will/would）。

其余内容都必须按顺序一致：否定词及其位置、数字、比较符（< > ≤ ≥ = ≠）与货币符号、日期与时间单位、实体、疑问词、介词（to/from/into/by/for 等）、代词与所有格、时态。

只要问题里出现任何非拉丁字母（西里尔、希腊、阿拉伯、希伯来、泰文、天城文、中日韩等），就只接受逐字相同（忽略大小写、空白和标点）。原因是这里的词表都是英文的，而英文嵌入模型对这些文字几乎分不出差别：同一句俄语的否定形式得分 0.986，还有一对泰文样例得分 1.0。

v1 守卫丢掉了情态词、介词、代词和否定词的位置，这些都被评审找到的反例利用了。

**会话改写。** 如果会话改写让检索问题和用户原话不同，原话也必须通过守卫，因为答案提示词回答的是原话。

**命中的标记。** 命中时，响应的 `retrieval` 块写入 `servedFromCache: true`，所有路由都标记为 `executed: false`。评测报告的 `evidence.semanticCache` 记录缓存是否开启及阈值。`quality:current` 和 `release:gate` 遇到开启缓存的报告，会以 `semantic_cache_enabled` 判为失败。

**失效与上限。**
- 本实例删除或替换文档时，立即清掉相关条目。
- 注册表读到其他实例删除或替换了文档时，通过 `onDocumentStoreChange` 清掉相关条目。
- 每次查找和写入都会清扫所有过期条目。
- 只有请求要 `retrievedContexts` 时才保存分块文本。
- 条目数上限为 `RAG_SEMANTIC_CACHE_MAX_ENTRIES`，字节上限为 `RAG_SEMANTIC_CACHE_MAX_BYTES`（默认 32 MiB）。

**测量**（`npm run eval:semantic-cache`，qwen2.5:7b + nomic-embed-text，阈值 0.97）。上界均为单侧精确 95%，并假设样本对相互独立（实际不独立）。

| 集合 | 旧守卫 v1 | 新守卫 v2 | 95% 上界 | 备注 |
| --- | --- | --- | --- | --- |
| 类内对照（离线） | 0/30 | 0/30 | 9.5% | 改述命中 16/19 → 13/19 |
| 类内对照（在线，有已存 base） | 0/31 | 0/31 | 9.2% | 重复 13/13；改述 14/17 → 11/17 |
| 保留集 tune（评审探针） | 9/12 误命中 | 0/12 | 22.1% | 9/12 相似度 ≥ 0.97 |
| 保留集 confirm | 25/59 误命中 | 0/59 | 5.0% | 39/59 相似度 ≥ 0.97 |

- 真实 lookup/store 路径交叉核对：92 对，0 处与离线判定不一致。
- confirm 集由守卫作者在重建守卫之后编写，所以只是"与调参分离"，并不盲。白名单本身（被丢弃的词、同义词、复数处理）还没有经过盲测。
- 结论：默认保持关闭，阈值保持 0.97（守卫重建后，调低阈值只多命中 1–2 条改述，不足以说明更好）。0.97 加完整守卫只能作为实验性的 opt-in，不能写成"已证明安全"。
- 延迟：守卫不影响命中本身的开销。此前在无争用条件下测得每次命中节省 1346 ms（95% CI 653–2189，n=26，旧守卫）。本次重跑与其他任务共用 Ollama，部分命中在嵌入服务上排队等待，因此不作为延迟数据引用。

## AGENTS.md paragraph (Implementation Notes)

- Semantic answer cache (`server/rag/semantic-cache.js`; `RAG_SEMANTIC_CACHE`, default off): per process, at the `executeDocumentRag` seam. A hit needs cosine similarity ≥ `RAG_SEMANTIC_CACHE_THRESHOLD` (0.97) within the key AND the lexical guard `semantic-cache-guard.js` v2. The key covers tenant, doc set and content versions, index version, embedding space, query adapter fingerprint, prompts, models, answer mode, plan shape, preference block and config. The guard is a near-exact normalized match plus a short allowlist of rewrites. Do not widen it by dropping word classes (modals, prepositions, pronouns, negator positions, comparators, tense): v1 did, and 25/59 held-out contrasts hit. Any non-Latin letter requires an exact match. When a session rewrite changed the question, the raw query must also pass. A hit sets `retrieval.servedFromCache: true` with no route executed. `evidence.semanticCache` records the setting, and `quality:current` / `release:gate` fail with `semantic_cache_enabled`; keep it out of `summary.config`. Entries leave on local ingest/delete/clear and on a registry read that sees another instance delete or replace a document (`doc-registry.js` `onDocumentStoreChange`). Expired entries are swept on every lookup and store. `retrievedContexts` are kept only for callers that ask for them, and memory is bounded by `RAG_SEMANTIC_CACHE_MAX_ENTRIES` and `RAG_SEMANTIC_CACHE_MAX_BYTES`. `npm run eval:semantic-cache` reports in-category contrasts plus held-out tune/confirm pairs with one-sided 95% bounds. Quote them as "in-category" and "held-out confirm", never as "0 false hits"; the confirm pairs were written by the guard's author.

## npm scripts (server/package.json)

"eval:semantic-cache": "node evaluation/run-semantic-cache-eval.mjs"

## 查询适配器（轻量 embedding 微调）

### 查询侧 embedding 适配器（不重建索引的 embedding 微调）

做法：只对查询向量做线性变换 q' = W q（W 是 d×d 矩阵，d=768），文档向量不动，所以不用 reindex。W 从单位矩阵开始训练，损失由三部分组成：InfoNCE、同一篇论文的其他 chunk 作为 hard negative、batch 内其他问题的证据段落作为 in-batch negative，再加 λ‖W−I‖² 把 W 往单位矩阵拉回。训练数据是 QASPER train 的问题和它们标注的证据段落。向量与应用完全一致：本地 Ollama 的 nomic-embed-text，文档加 `search_document: ` 前缀，查询加 `search_query: ` 前缀，切块用应用自己的 chunker。调参只在 train 上做：按论文留出 20% 的 train 论文做早停和网格选择（λ∈{0.01,0.1,0.3,1}、τ∈{0.05,0.1}、lr∈{5e-5,2e-4}，共 16 组），选择指标是留出集上篇内 dense hit@6，并列时看 MRR。dev 只用来确认一次。

复现（在 server/ 下，不需要下载任何东西，torch 用已安装的 `.venv-neural-reranker`）：
```
export OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_API_KEY=ollama OPENAI_EMBEDDING_MODEL=nomic-embed-text RAG_EMBEDDING_DIMENSIONS=768
npm run adapter:data          # 导出 QASPER train 的 chunk/问题向量，写到 evaluation/generated/query-adapter/，中断后可续跑
npm run adapter:train         # 训练并写出 evaluation/generated/query-adapter/qasper-nomic-adapter.json
npm run eval:query-adapter    # QASPER dev：dense-only 和 hybrid 各跑 identity 与 adapter 两个 arm，给出配对 bootstrap 95% CI
```
启用：`RAG_EMBEDDING_QUERY_ADAPTER=evaluation/generated/query-adapter/qasper-nomic-adapter.json`（相对路径按工作目录解析；默认关闭）。文件里写明了它所属的 embedding 空间（模型、两个前缀、维度）。如果配置的空间与之不一致，查询 embedding 会直接报错（`QUERY_ADAPTER_MISMATCH`），而不是静默跳过。某个 pinned 到其他空间的索引版本，其查询不会被变换。adapter 指纹（本次为 `qa1-8a7d74c666072fa6`）会进入三处：查询向量缓存的 key、结果上的 `provenance.queryAdapter`、以及 `/chat` 的 `retrieval.routes.dense.queryAdapter`。

结果（QASPER dev，821 个可回答问题，seed 1，top-K 6，adapter 减 identity，配对 bootstrap 95% CI）：

| 路由 | 指标 | identity | adapter | 差值 [95% CI] |
|---|---|---|---|---|
| hybrid（默认） | 证据在 rank 1 | 0.281 | 0.311 | +0.029 [0.007, 0.051] |
| hybrid（默认） | 证据在 top 3 | 0.516 | 0.541 | +0.024 [0.001, 0.048] |
| hybrid（默认） | 证据在候选中 | 0.692 | 0.738 | +0.046 [0.024, 0.069] |
| hybrid（默认） | 证据被 gate 放行 | 0.245 | 0.259 | +0.015 [0.004, 0.027] |
| dense-only（combined 打分） | 证据在 rank 1 | 0.275 | 0.266 | −0.010 [−0.035, 0.016] |
| dense-only（combined 打分） | 证据在 top 3 | 0.507 | 0.475 | −0.032 [−0.061, −0.002] |
| dense-only（combined 打分） | 证据在候选中 | 0.694 | 0.686 | −0.009 [−0.037, 0.020] |

结论：预先声明的规则是“hybrid 的证据在候选中提升，且 CI 不含 0”，本次满足。因此它作为 QASPER + nomic-embed-text + hybrid 这一组合的调优设置记录下来，但默认仍然关闭，因为它依赖语料和 embedding 空间。

注意事项：
- adapter 会整体改变余弦的绝对值。留出的 train 论文上，篇内平均余弦从 0.59 降到 0.14，top-1 从 0.72 降到 0.31。
- dense-only 的 combined 打分取 max(余弦, 关键词覆盖, 加权和)。余弦变小后排序被关键词覆盖主导，所以 dense-only 的 top 3 反而下降（CI 不含 0）。
- 对比问答的语义旁路（vectorScore ≥ RAG_MIN_RELEVANCE_SCORE=0.32）未测量，预计会更少触发。
- 答案 F1、pgvector 后端、cross-encoder 重排叠加都未测量。
- 留出集上的提升（hit@6 0.668→0.722）是 16 组配置里选出的最好结果，偏乐观；以 dev 结果为准。

### 审查后的修正

### 查询侧 embedding 适配器（RAG_EMBEDDING_QUERY_ADAPTER，默认关闭）
在 QASPER train 上训练一个 768x768 线性矩阵 W（evaluation/train-query-adapter.py，数据来自 evaluation/query-adapter-data.mjs，保留 20% 论文做早停），查询向量 q 变为 W q，文档向量不变、无需重建索引。
- 生效范围（只在测过的地方）：单文档 QA 路由自己的检索（无 agent 检索计划）、恰好一个文档、hybrid 路由且 RRF 融合、查询向量确由 embedding 模型在适配器训练所用空间（模型 + 两个任务前缀 + 维度）中生成、且向量库能"按 W q 排序、按原向量打分"（local、pgvector；Qdrant 不支持，健康检查告警后不启用）。比较、多文档、gap-plan 补充检索、agent 规划/追问检索、dense-only、加权融合、替身（stand-in）provider 一律不适配。
- 分数：dense 路由按 W q 排序，但 vectorScore / admissionScore 仍是模型原向量的余弦，因此 RAG_MIN_RELEVANCE_SCORE、selectQaContext 的额外候选门槛、比较的语义旁路都保持原刻度（W q 会把 top-1 余弦从约 0.72 压到约 0.31，远低于这些门槛）。
- 失效方式：文件缺失/损坏、空间不匹配只会让检索退回未适配并打一次告警，不会让 /chat 500；checks.queryAdapter 在文件不可读时报 error（STARTUP_HEALTH_STRICT 启动失败），空间不匹配、非 hybrid、非 RRF、向量库不支持时报 warning。训练脚本原子写文件。evaluation/generated/ 不进 Git 也不进 Docker 镜像，部署时需挂载该文件。
- 可追溯：被适配的检索在 routes.dense.queryAdapter / provenance.queryAdapter 上带指纹；eval:qasper-retrieval、eval:qasper-answers、eval:abstention-gate 的 config.queryAdapter 记录指纹，eval:qasper-retrieval --compare 拒绝配对指纹不同的两份报告。
- 数字（dev，821 可答 + 95 不可答，seed 1，nomic-embed-text，hybrid RRF，适配器减基线，配对 bootstrap 95% CI）：证据进入候选 +0.0463 [0.0244, 0.0694]；rank1 +0.0292 [0.0073, 0.0512]；top3 +0.0231 [0, 0.0463]（不宣称）；证据进入回答模型上下文 0.3532→0.3727，+0.0195 [0.0024, 0.0365]；不可答问题被门控放行 0.3895→0.3684，-0.0211 [-0.0737, 0.0316]（无可测增加，但区间宽）。两臂共同排到的 4060 个（chunk, 查询）对 vectorScore 完全一致。
- 回答（eval:qasper-answers，dev 200 题含 20 不可答，qwen2.5:7b，配对）：答案 F1 0.2576→0.2562，-0.0014 [-0.0158, 0.0131]；证据在引用中 +0.0167 [-0.0111, 0.0500]；可答题作答率 +0.0278 [-0.0056, 0.0611]。
- 结论：默认保持关闭。检索层收益成立，但回答 F1 持平，不能说它提升了回答；此前"推荐为调优配置"撤回，仅作为可选的检索设置。dense-only 下 top3 更差（-0.0317 [-0.0609, -0.0024]），因此不在该路由启用。

=== AGENTS.md paragraph ===
- Query-side embedding adapter (`server/rag/query-adapter.js`, `RAG_EMBEDDING_QUERY_ADAPTER`, default off): a d x d matrix W trained on QASPER train by `evaluation/train-query-adapter.py` (data from `evaluation/query-adapter-data.mjs`; the trainer writes the file atomically). `embedQuery` and the query-embedding cache always hold the model's own vector. `openai.js` marks a vector as the model's (with the space it was embedded in) only for the real client; a stand-in provider is never adapted unless it sets `allowQueryAdapter: true`. The retrieval seam adapts one search only when all hold: `queryAdapterScope: "single_document_qa"` (set by `document-rag-execution.js` for `retrieveQaCandidates` and for `executeQaRag`/the verdict retry without an agent retrieval plan), exactly one docId, the hybrid route with RRF fusion, a marked vector in the adapter's space, and a store with `denseScoreVector` (local, pgvector; not Qdrant). The dense route then ranks by W q while `vectorScore`/`admissionScore` stay the model's cosine (the store receives `scoreVector`; pgvector adds `$6` only then), so never let an adapted cosine reach `RAG_MIN_RELEVANCE_SCORE`, `selectQaContext` extras or the comparison semantic bypass. Anything else searches unadapted with a one-time warning, never a per-query error. `checks.queryAdapter` is an error for an unreadable or invalid file and a warning for a space mismatch, a non-hybrid route, non-RRF fusion or an unsupported store. Adapted searches carry `routes.dense.queryAdapter`/`provenance.queryAdapter`; `eval:qasper-retrieval`, `eval:qasper-answers` and `eval:abstention-gate` record `config.queryAdapter`, and `eval:qasper-retrieval --compare` refuses reports with different fingerprints. `evaluation/generated/` is not in the Docker image, so mount the adapter file. `npm run eval:query-adapter` compares identity and adapter on the hybrid QA route (candidates, the answer model's context, unanswerable false admissions, paired CIs) and fails if any dense vectorScore changes. On QASPER dev it raised evidence among the candidates (+0.046 [0.024, 0.069]) and in the context (+0.020 [0.002, 0.037]), but QASPER answer F1 with qwen2.5:7b was flat (-0.001 [-0.016, 0.013]), so it stays off and must not be described as improving answers.

=== npm scripts (server/package.json) ===
"adapter:data": "node evaluation/query-adapter-data.mjs",
"adapter:train": "evaluation/.venv-neural-reranker/bin/python evaluation/train-query-adapter.py",
"eval:query-adapter": "node evaluation/run-query-adapter-eval.mjs"

=== Notes for other tracks ===
- SPARSE: I made a small dense-only change in rag/vector-store-pgvector.js: an optional `scoreVector` in buildDenseSearchSql, buildIterativeDenseSearchSql and searchPgvectorDocuments. Unscored statements are byte-identical, and your sparse code is untouched. There is also a small dense-only change in rag/vector-store-local.js searchLocalDocuments.
- CACHE: in rag/document-rag-execution.js I only threaded `queryAdapterScope` through the QA retrieval functions and exported QA_CONTEXT_MIN_COVERAGE. The semantic cache now always sees the model's raw query vector, whatever the adapter setting. Answers cached before the adapter was switched on are not keyed on it.

Files: /Users/luc1ferx/Desktop/Projects/Luc1ferxx_Archive_RAG/server/rag/query-adapter.js, rag/openai.js, rag/embedding-cache.js, rag/vector-store.js, rag/vector-store-local.js, rag/vector-store-pgvector.js, rag/retrievers/global-retriever.js, rag/document-rag-execution.js, rag/config.js, health.js, evaluation/run-query-adapter-eval.mjs, evaluation/train-query-adapter.py, evaluation/run-qasper-retrieval-eval.mjs, evaluation/run-qasper-answer-eval.mjs, evaluation/run-abstention-gate-analysis.mjs, test/query-adapter.test.mjs. Reports (git-ignored): evaluation/results/latest-qasper-retrieval-query-adapter.{json,md}, latest-qasper-answers-adapter-{off,on}.{json,md}.

