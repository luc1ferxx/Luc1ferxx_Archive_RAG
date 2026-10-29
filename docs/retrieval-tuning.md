# 检索调优：BM25、常见词剪枝、语义缓存、查询适配器

这份文档讲三块检索调优：pgvector 稀疏路的 BM25 与常见词剪枝、语义答案缓存、查询侧 embedding 适配器。每块写做法、配置、实测、结论与局限。结果汇总见 `docs/evaluation.md`「检索调优（2026-09-27）」。

| 改动 | 默认 | 一句话结论 |
| --- | --- | --- |
| BM25 替代 `ts_rank_cd` | 开（`RAG_SPARSE_SCORING=bm25`，用户决定） | 默认 hybrid 路由上与 `ts_rank_cd` 没有显著差异 |
| 常见词剪枝 | 开（被搜文档超过 1000 个 chunk 时生效） | 全表含常见词的查询明显变快；hybrid 证据召回没有测出损失 |
| 语义答案缓存 | 关 | 守卫 v2 下类内对照 0/30、留出 confirm 0/59 误命中（单侧 95% 上界 9.5%、5.0%），只能算实验性 opt-in |
| 查询适配器 | 关 | 检索层有收益，答案 F1 持平，不能说它提升了回答 |

除特别说明外，实测都用本地 Ollama：embedding 为 nomic-embed-text，聊天模型为 qwen2.5:7b。用到数据库的（稀疏路的召回评测和规模压测）是一次性的 PostgreSQL 18.6 + pgvector 0.8.6；规模压测用合成向量，不调 embedding 模型。

## BM25 与常见词剪枝

### 做法

**两种打分**，二选一（`RAG_SPARSE_SCORING`）：

- `bm25`（默认）：Okapi BM25，IDF 用 Lucene 的恒正公式，与 local 稀疏路（`server/rag/sparse-store.js`）同一个公式。同样的 chunk 和统计量下，两边分数差小于 1e-9（`test/vector-store-pgvector-bm25.integration.test.mjs`）。报告里的 `sparseBackend` 为 `postgres_bm25`。
- `ts_rank_cd`：PostgreSQL 的 cover density 排序，没有集合统计，不是 BM25，文档和报告里不能写成 BM25。`sparseBackend` 为 `postgres_fts_ts_rank_cd`。

词频取自 tsvector 的 position 数，chunk 长度是 `sparse_length`（迁移 029 加的列）。N、平均长度和文档频率按被搜文档所在的 (owner_user_id, workspace_id) 作用域计算，不会用到别的租户的统计。local 稀疏路本来就是 BM25，`RAG_SPARSE_SCORING` 只影响 pgvector。

**集合统计**（迁移 030，`server/rag/vector-store-pgvector-sparse.js`）。每个索引版本的 chunk 表都有：

- 两张只追加的日志表 `<t>_sparse_scope_log`、`<t>_sparse_term_log`，没有主键和唯一索引；
- 两张汇总表 `<t>_sparse_scopes`（每个作用域的 chunk 数和总长度）、`<t>_sparse_terms`（每个词的文档频率）；
- 语句级 INSERT/UPDATE/DELETE/TRUNCATE 触发器（带 transition table）和 BEFORE 行触发器 `<t>_sparse_length`。

写入方（入库、替换、删除、清空、级联删除、版本构建、reindex）只往日志表插行，所以同一作用域的多个写入方互不等待，也不会在版本表之间互相死锁。汇总由 `<t>_sparse_fold()` 在 `pg_try_advisory_xact_lock` 下完成：抢到锁的写语句负责折叠，其余直接跳过，不等待。查询在同一快照里读"汇总 + 未折叠的日志"，结果精确。触发器和 fold 以表所有者身份运行（SECURITY DEFINER）。

第一版实现是每个作用域一行计数器，触发器直接 upsert 它：同一作用域的写入方因此排队，清空和入库还会在版本表之间反序加锁、互相死锁。现在的只追加日志就是为此改的，不要把对共享计数行的 upsert 加回触发器。

新索引版本建表时调用 `<base>_install_bm25` 装上这些对象，退役版本时随表一起删掉（`renderPgvectorBm25DropDdl`）。

**打分函数** `<t>_sparse_search(...)` 以表所有者身份运行，只读被搜文档所属作用域的统计。调用方是租户角色时，函数先用行级安全的策略谓词过滤文档 id，所以拿别的租户的文档 id 直接调用也返回空。哪条语句会用到它：

- BM25：总是走这个函数；
- `ts_rank_cd` + 剪枝开 + 多篇文档：走这个函数；
- `ts_rank_cd` + 单篇文档：普通语句（走 `doc_id` 索引最便宜）；
- `ts_rank_cd` + 剪枝关 + 多篇文档：租户身份走迁移 014/033 的 `<t>_sparse_rank`，owner 身份走普通语句。

**常见词剪枝**（两种打分都适用）。查询里一个几乎所有 chunk 都含的词，会让 GIN 匹配到整个文档集，每个 chunk 都要打分。剪枝只在被搜文档合计超过 1000 个 chunk 时生效（代码常量 `PGVECTOR_SPARSE_PRUNE_MIN_CHUNKS`，按文档表的 chunk_count）。单篇文档的 `ts_rank_cd` 走普通语句，从不剪枝；BM25 的单篇文档只有超过 1000 个 chunk 才会剪枝，QASPER 的论文都在这以下。在作用域内出现在超过 `RAG_SPARSE_PRUNE_DF_FRACTION`（默认 0.1）比例 chunk 里的词算常见词。候选路径有四条，每行结果的 `sparseCandidates` 记录走的是哪条：

- `exhaustive`：没有常见词，或剪枝没生效，所有匹配任一词的 chunk 都打分；
- `pruned`：候选只从稀有词经 GIN 生成，但用全部查询词打分；
- `pruned_filled`：稀有词的候选不足 topK 时，其余候选从常见词补齐；
- `common_bounded`：只含常见词的查询（一个或几个），每一轮最多取 `RAG_SPARSE_COMMON_TERM_CAP`（默认 2000）个候选。常见词的文档频率之和超过上限时，先取同时含全部常见词的 chunk，再取含任一常见词的，都按物理顺序、关掉并行，结果确定。频率之和不超过上限时，结果与穷举完全相同。

剪枝只会在两种情况下改变结果：一个不含稀有词的 chunk 本该排进 top-K，或者有上限的那一轮漏掉了更好的 chunk。

**行级安全**：四张统计表带迁移 013 的 `tenant_isolation` 策略，但不授权给租户角色，租户从不直接读写。健康检查的 `checks.rowLevelSecurity` 检查每个在用版本的四张统计表，以及 BM25 或剪枝会让租户调用时 `<t>_sparse_search` 的 EXECUTE 权限。

**升级已有的库**：迁移 029 只加列，不回填。升级前写入的行 `sparse_length` 为 NULL，BM25 每次打分都要现数 position，删除时也要重数。用 `npm run vector:sparse-length`（`server/sparse-length-backfill.mjs`，可加 `--dry-run`、`--batch-size`、`--lock-timeout-ms`、`--max-batches`）分批回填：短事务、带锁超时和 SKIP LOCKED，可中断续跑。每行更新都会让包括 HNSW 在内的索引重新收录，按 reindex 的方式安排在低峰期跑。

**测试**：`test/vector-store-pgvector-bm25.test.mjs`（单元）；`test/vector-store-pgvector-bm25.integration.test.mjs`（真实数据库：每次写入后统计精确、同作用域写入方不互等也不死锁、分数与 local BM25 差小于 1e-9、剪枝走的路径、租户之间不串统计、回填不改统计、新版本建表带上这些对象而退役版本删掉它们；没有 `PGVECTOR_TEST_DATABASE_URL` 时记为跳过）。

### 配置

默认值以 `server/rag/config.js` 为准。

- `RAG_SPARSE_SCORING`：默认 `bm25`，可选 `ts_rank_cd`。未知值直接报错，不回退。迁移 029/030 的统计不论选哪个都实时维护，所以切换不用重建。
- `RAG_BM25_K1`：默认 `1.2`，≥0（0 表示忽略词频）。local 和 pgvector 两条 BM25 共用。
- `RAG_BM25_B`：默认 `0.75`，取值 [0,1]，超出范围回到 0.75。两条 BM25 共用。
- `RAG_SPARSE_PRUNE_DF_FRACTION`：默认 `0.1`。`off`、`false`、0、负数或 ≥1 关闭剪枝；非数字回到 0.1。
- `RAG_SPARSE_COMMON_TERM_CAP`：默认 `2000`。`off`、`false`、0 或负数表示不设上限，只含常见词的查询按穷举打分。
- `RAG_PGVECTOR_TEXT_SEARCH_CONFIG`：默认 `simple`。chunk 文本先用应用内 tokenizer 切分再建 tsvector，用语言相关的词干器只会让 pgvector 和 local 两条稀疏路分叉。

### 实测

**延迟**（`npm run bench:pgvector-scale -- --sizes 100k --latest-name latest-pgvector-scale-sparse`）。合成数据：10 万 chunk、2000 篇文档、每篇 50 个 chunk；一个租户拥有全部行，以租户身份查询，行级安全 enforce，`sparse_length` 已填；每组查询先预热；集群关了 fsync。下面是查全表时的 p50/p95（ms），每格是"穷举 → 剪枝"：

| 查询 | ts_rank_cd | BM25 | 剪枝后与穷举相比 |
| --- | --- | --- | --- |
| 100 条混合查询中含常见词的 11 条 | 135/180 → 39/49 | 281/389 → 40/51 | ts_rank_cd 100 条里 4 条 top-10 变化（recall@K 0.995）；BM25 不变 |
| 单个常见词（30 条） | 64/151 → 16/25 | 77/369 → 18/26 | recall@K ts_rank_cd 0.32，BM25 0.29 |
| 三个常见词（30 条） | 177/455 → 10/20 | 210/409 → 11/22 | recall@K ts_rank_cd 0.41，BM25 0.957 |

100 条混合查询整体，ts_rank_cd 的 p95 从 135 ms 降到 73 ms。只含常见词的查询按物理顺序截断，不按相关度，所以 recall@K 低。

**写入代价**（同一次运行，有/无统计触发器按 ABBA 交替）：

- 单个 50 chunk 的入库：p50 336 ms 对 317 ms，约慢 6%；
- 同一作用域 4 个写入方并发：10.4 对 11.1 篇/秒，吞吐随并发扩展，与无触发器时相同；
- 删除和清空要展开每个被删 chunk 的 tsvector：每 1000 个 chunk 25 ms 对 4.4 ms；
- `sparse_length` 为 NULL 时（另跑 `--sparse-length null`）：删除每 1000 个 chunk 43 ms 对 8.6 ms，穷举 BM25 的 p50 慢 3–4 倍。

集群关了 fsync，写入数字是持久化服务器上的下限。

**单篇文档**：上面这次运行没有单篇的打分对比。更早一次运行在第一版实现上（统计是每个作用域一行计数器，剪枝只用于 BM25，还没有常见词上限）测过：单篇文档的稀疏搜索 `ts_rank_cd` p50 0.47 ms，BM25 0.74 ms，约慢 0.27 ms。现在 BM25 单篇仍走打分函数（`ts_rank_cd` 单篇走普通语句），但当前实现没有重测这一项。

**证据召回**（`npm run eval:sparse-scoring`，`server/evaluation/run-sparse-scoring-eval.mjs`）。在一次性 PostgreSQL 里用应用自己的迁移、入库和检索代码，跑 QA 路由到门控为止（`retrieveQaCandidates`），配对 bootstrap 95% CI。样本：QASPER train 400 题（311 篇论文），dev 821 题（272 篇），seed 1，top-K 6。三种设置：

- 单篇：只搜问题自己的论文。每篇都不到 1000 个 chunk，剪枝不触发。
- 全部论文：所有抽到的论文作为文档集，剪枝真正生效。
- 按租户：每篇论文以独立 owner 再入库一次，以该租户身份、开行级安全检索，BM25 统计只来自这一篇。

| 比较 | 路由 | 结果 |
| --- | --- | --- |
| BM25 − ts_rank_cd，单篇 | hybrid | hitAtAll：dev −0.0012 [−0.0122, +0.0097]，train −0.0075 [−0.030, +0.015]，都不显著 |
| BM25 − ts_rank_cd，单篇 | 纯稀疏 | dev hitAt3 +0.023 [−0.005, +0.051]，不显著 |
| BM25 − ts_rank_cd，全部论文 | hybrid | 各指标的区间都包含 0 |
| BM25 − ts_rank_cd，全部论文 | 纯稀疏 | hitAtAll：train +0.1125 [0.08, 0.1475]，dev +0.1035 [0.078, 0.1291]，两次都排除 0 |
| ts_rank_cd 剪枝 − 穷举，全部论文 | hybrid | train hitAtAll 0 [0, 0]、hitAt3 −0.005 [−0.0125, 0]；dev hitAtAll 0 [0, 0]、hitAt1 −0.0037 [−0.0097, 0.0012] |
| BM25 剪枝 − 穷举，全部论文 | hybrid | 所有指标 0 [0, 0] |
| 按租户统计 − 合并统计（BM25） | hybrid | hitAtAll 在 train 和 dev 都没有显示出差异 |

只含常见词的题只有 3 题（train）和 19 题（dev），召回都接近 0，所以截断路径对证据召回的影响实际上没有测到。

报告另外对"全部论文"设置逐题跑一遍原始稀疏路（owner 身份，不开行级安全），按剪枝走的路径（混合查询 / 全是常见词 / 没有常见词）分别给出召回、剪枝后 top-K 与穷举不同的比例和延迟。

复现（语料先用 `npm run corpus:qasper` 生成，见"查询侧 embedding 适配器"一节的"复现"）：

```
cd server
OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_API_KEY=ollama \
OPENAI_EMBEDDING_MODEL=nomic-embed-text RAG_EMBEDDING_DIMENSIONS=768 \
DOTENV_CONFIG_PATH=<空文件> \
npm run eval:sparse-scoring -- --corpus evaluation/generated/qasper-train.json --cases 400
# dev：--corpus evaluation/generated/qasper-dev.json --cases 821
```

- 不调用聊天模型，只要 embedding 端点。
- 不读 `server/.env`；它引用的 QASPER 辅助模块会加载 dotenv，所以把 `DOTENV_CONFIG_PATH` 指向空文件。
- 不传 `--database-url` 时，自动在 `$TMPDIR` 下、系统分配的端口上建集群，结束后删除；传了就必须是一次性数据库（前后都会清空文档）。
- `eval:qasper-retrieval` 走 standalone profile，测的是 local BM25，不是这条路。
- 规模压测可用 `--sparse-doc-sets 1000,all`、`--prune-df-fractions 0.1`、`--common-term-cap 2000|off` 调整，`--sparse-length null` 模拟没回填的升级库。

### 结论与局限

- 2026-09-27 起默认是 `bm25`，这是用户的决定，不是数据证明的。事先定的规则是"dev hybrid 证据召回 CI 下界高于 −0.01，且延迟不退化"，下界 −0.0122 没过。数据只说明默认 hybrid 路由上没有显著差异，不能说 BM25 提升了召回。设 `RAG_SPARSE_SCORING=ts_rank_cd` 可以回到原来的排序。
- 只走稀疏路且搜全部论文时，BM25 两次都明显更高（+0.10 到 +0.11 hitAtAll）。但默认路由是 hybrid，这个差异没有传到 hybrid 上。
- 剪枝在真正生效的场景（全部论文）没有测出 hybrid 证据召回的损失，同时把全表含常见词的查询 p95 从约 180–390 ms 降到约 50 ms。
- 只含常见词的查询，剪枝后的 top-10 与穷举的重合度低（recall@K 0.29–0.41，BM25 三词查询 0.957），对证据召回的影响只有 3 + 19 题，等于没测。
- 写入约慢 6%；删除和清空每 1000 个 chunk 多约 20 ms；没回填 `sparse_length` 的库，删除和穷举 BM25 都更慢，升级后先跑 `npm run vector:sparse-length`。
- 延迟数字来自合成数据和一台机器，不是真实负载。

## 语义答案缓存

### 做法

`RAG_SEMANTIC_CACHE=on` 开启一个进程内的语义答案缓存（`server/rag/semantic-cache.js`）。它挂在答案接缝 `executeDocumentRag` 上，`/chat`（经 agent 的 document_rag 步骤）和 MCP `archive_ask` 都经过这里。

**查找位置**：路由和查询向量计算之后、检索之前。查找复用检索本来就要算的那个向量，不多调一次模型。命中时跳过检索和答案模型，直接返回缓存的文档 RAG 响应。

**缓存键**：下列各项的摘要，跨键永不命中。

- 租户（userId + workspaceId）；没有传 accessScope 的调用方不走缓存；
- 精确的 docId 集合，以及每篇文档的内容版本（version、内容哈希、更新和上传时间、chunk 数）；
- 当前索引版本（pgvector 的 version id 加指针 generation，或 provider）、查询向量空间，以及当前加载的查询适配器文件指纹（没配置为 `no-adapter`，文件不可用为 `unavailable:<code>`；见「结论与局限」末条）；
- 答案提示词指纹、主备聊天模型；
- 答案模式（route mode、需求数）；
- agent 检索计划的形状（去掉问题本身；follow-up 计划不缓存）；
- 长期记忆偏好块；
- 影响检索和答案的配置（`RAG_*`、`OPENAI_*`、`VECTOR_STORE_*` 等）。不含密钥，也不含缓存、观测、模型调用和入库调优类设置。

**命中条件**：同一键内，查询向量余弦 ≥ `RAG_SEMANTIC_CACHE_THRESHOLD`（默认 0.97），并且通过词法守卫 `server/rag/semantic-cache-guard.js`（当前为 v2）。

只靠向量不够：nomic-embed-text 给否定句 0.994、角色互换 0.991–0.997、长问题里换一个词 0.988–0.995，都高于部分真正的改写（0.94–0.999）。

**守卫 v2 是"近乎逐字"匹配加一张短白名单。** 允许的差异只有：

- 大小写、空白、标点、缩写；
- 冠词、of、please、kindly、do/does、is/are/am、所有格 's；
- 英文词的复数或第三人称 -s；
- 同一类内的情态词：许可（can/could/may/might）、义务（must/shall/should/have|has|need|ought to）、将来（will/would）；
- 几组同义词：get/obtain/receive、let/permit/allow、need/require、say/state/mention（词形必须一致），以及 during/in、were/was、has/have；
- 数字与数词（"3"/"three"）；
- "per/each/every/a <单位>" 与 daily、weekly 等写法。

其余内容都必须按顺序一致：否定词及其位置（也不能多出 un-/non-/in-/dis- 这类否定前缀，或换成 minimum/maximum、before/after 这类反义词）、数字、比较符（< > ≤ ≥ = ≠）与货币符号、日期与时间单位、实体、情态词的类别、疑问词、介词（to/from/into/by/for 等）、代词与所有格、时态、量词。

问题里只要出现任何非拉丁字母（西里尔、希腊、阿拉伯、希伯来、泰文、天城文、中日韩等），就只接受逐字相同（忽略大小写、空白和标点）。原因是这里的词表都是英文的，而英文嵌入模型对这些文字几乎分不出差别：同一句俄语的否定形式得分 0.986，还有一对泰文样例得分 1.0。

v1 守卫丢掉了情态词、介词、代词和否定词的位置，审查找到的反例正是利用了这些。

**会话改写**：如果会话改写让检索问题和用户原话不同，原话也必须通过守卫，因为答案提示词回答的是原话。

**只缓存回答**：弃答不缓存。缓存的拒答会比拒答的理由活得更久。

**失效**：

- 本实例入库、替换、删除或清空文档时，立即清掉涉及该文档的条目；
- 注册表读到别的实例删除或替换了文档时，通过 `onDocumentStoreChange` 清掉相关条目；
- 查找时发现某篇文档、索引版本或查询适配器文件指纹是本进程没见过的，清掉建立在旧值上的条目；
- 键本身带版本，旧条目本来就不可达；
- 生成答案期间索引版本切换了、适配器文件换了，或某篇文档被替换、删除了，这个答案不存；检索结果里记录的适配器指纹（`routes.dense.queryAdapter`）和键里的不一致时也不存（`storeSkipReason: query_adapter_changed`）；
- 租户擦除清掉本进程里该租户的条目（`server/rag/tenant-lifecycle.js`），别的进程的条目碰不到，只能等失效或过期；
- 每次查找和写入都会清扫所有过期条目。

**存储**：进程内 LRU，条目数和字节数都有上限。只有请求要 `retrievedContexts` 时才保存分块文本，没存分块文本的条目不会服务要它的请求。不落 PostgreSQL，理由：正确性不依赖共享（每个键的组成都按请求现读）；条目含租户文档原文，落库需要新的行级安全表、保留期和随文档删除。代价是多实例时命中率更低。

**命中标记**：

- RAG 响应：命中时多一个 `semanticCache: {hit, similarity, ageMs}`；`retrieval` 块写入 `servedFromCache: true`，所有路由标记为 `executed: false`，评测报告不能把缓存答案当成新的检索。
- RAG trace 的 `semanticCache` 字段：命中时有 similarity、ageMs；未命中时有 bestSimilarity 和 guardRejections。
- OTel 事件 `rag.semantic_cache.hit`，只有数值。
- `/chat` 的 `agentObservability` 和 MCP 的 `formatAskResult` 目前不带这个标记。

**评测门禁**：评测报告的 `evidence.semanticCache` 记录缓存是否开启及阈值；`quality:current` 和 `release:gate` 遇到开着缓存的报告，以 `semantic_cache_enabled` 判失败。

**测试**：`test/semantic-cache.test.mjs`。

### 配置

- `RAG_SEMANTIC_CACHE`：默认关。`on`、`true`、`1`、`yes`、`memory` 开启，其他值都是关。
- `RAG_SEMANTIC_CACHE_THRESHOLD`：默认 `0.97`，取值 (0,1]，否则回到默认。
- `RAG_SEMANTIC_CACHE_MAX_ENTRIES`：默认 `500`。
- `RAG_SEMANTIC_CACHE_MAX_BYTES`：默认 `33554432`（32 MiB），按存储的响应 JSON 计；比整个预算还大的答案不存。
- `RAG_SEMANTIC_CACHE_TTL_MS`：默认 `3600000`（1 小时），0 表示不过期，只靠 LRU 和失效移除。

### 实测

`npm run eval:semantic-cache`（`server/evaluation/run-semantic-cache-eval.mjs`，用例在 `semantic-cache-cases.js`）在临时的 standalone 归档里入库 synthetic-corpus-5docs 的 5 篇文档，用真实 embedding 和聊天模型（qwen2.5:7b + nomic-embed-text）。三部分：离线扫描（阈值 × 守卫模式）、留出对照对、经 `chat()` 的在线运行（每次命中再关缓存问一遍，得到配对的不走缓存延迟）。在线对照命中、留出集误命中、或真实查找路径与离线判定不一致，任何一项出现都以退出码 1 结束。结果写到被忽略的 `server/evaluation/results/latest-semantic-cache.*`；`--offline-only` 只跑离线部分。

用例（`semantic-cache-cases/v2`）：

- 类内构造集 14 组。每组先问一个基问题（答出来就存进缓存），再问追问，共 71 个：16 个重复、19 个改写、36 个对照。对照的类别是否定、数字、日期、实体、角色，另有 5 个换文档集、1 个换租户。离线扫描只算 30 个词法对照，换文档和换租户的本来就被键隔开。
- 留出问题对 92 对：tune 12 对，都是对照，是审查时找出 v1 漏洞的探针（守卫照着它们重建）；confirm 80 对（59 个对照、21 个改写），是重建后另写的。

**守卫 v2 的结果**（阈值 0.97）。上界是单侧精确 95%，并假设样本对相互独立（实际不独立）。

| 集合 | 旧守卫 v1 | 新守卫 v2 | 95% 上界 | 备注 |
| --- | --- | --- | --- | --- |
| 类内对照（离线） | 0/30 | 0/30 | 9.5% | 改写命中 16/19 → 13/19 |
| 类内对照（在线，36 个对照里基问题已缓存的 31 个） | 0/31 | 0/31 | 9.2% | 重复命中 13/13；改写 14/17 → 11/17 |
| 留出集 tune（审查探针） | 9/12 误命中 | 0/12 | 22.1% | 9/12 相似度 ≥ 0.97 |
| 留出集 confirm | 25/59 误命中 | 0/59 | 5.0% | 39/59 相似度 ≥ 0.97 |

- 真实 lookup/store 路径交叉核对：92 对，0 处与离线判定不一致。
- confirm 集由守卫作者在重建守卫之后编写，所以只是"与调参分离"，并不盲。白名单本身（被丢弃的词、同义词、复数处理）还没有经过盲测。
- 守卫重建后，调低阈值只多命中 1–2 条改写（离线 0.90–0.96 为 14/19），不足以说明更好。

**离线消融**（30 个类内对照、19 个改写）：

- 只用向量、阈值 0.97：10/30 误命中；要到 0.995 才降到 0，此时改写只剩 10/19；
- 只查否定、数字、日期、实体：0.97 时仍有 4/30 误命中（实体、角色）；
- 完整守卫：0.90–0.995 全部 0/30。

**延迟**（守卫 v1 时的运行，Ollama 无争用）：

- 命中均值 9.4 ms（含一次查询向量）；同一问题不走缓存均值 1355 ms、中位 509 ms；
- 每次命中节省 1346 ms，配对 bootstrap 95% CI [653, 2189] ms，n=26；
- 未命中时每次查找约 60 µs。

守卫不改变命中本身的开销。守卫 v2 的那次重跑与其他任务共用 Ollama，部分命中在 embedding 服务上排队，所以不作为延迟数据引用。

v1 那次运行还有两个观察：

- 有 1 次改写命中（"get" 替换 "receive" 的长问题），不走缓存时会被 QA 词法门弃答。也就是说，命中可能给出管线本来会拒答的答案。
- `verify:quality` 开缓存仍 18/18。该套件在同一进程内不重复提问，所以 0 命中，只说明查找和存储不改变结果。

### 结论与局限

- 默认保持关闭，阈值保持 0.97。0.97 加完整守卫只能作为实验性的 opt-in，不能写成"已证明安全"；引用误命中数字时要写明是"类内对照"和"留出集 confirm"，不能写成"0 误命中"。
- 命中会绕过检索和 QA 门控，可能给出管线本来会拒答的答案（见上面的 v1 观察）。
- 只在进程内，多实例时命中率更低。
- 质量门禁和 `verify:quality` 的证据运行要关着缓存，除非就是在测缓存：命中响应里的 `retrieval` 块描述的是当初生成该答案的那次检索。
- 缓存看到的是模型原始查询向量（见下一节），所以键里的适配器一项取的是当前加载的适配器文件的指纹（文件按路径、大小和修改时间重新加载）：在同一路径上换成重新训练的文件后，下一次查找换到新键，并清掉按旧适配器建的条目；文件读不了时同样换键（检索此时不做适配）。重新加载只看路径、大小和修改时间：保留修改时间的复制（`cp -p`、`rsync -a`）换进同样大小的文件不会被发现，要等进程重启；训练脚本原子写文件，修改时间总会变。2026-10-18 之前键里这一项恒为空，同一路径换文件后旧答案在 TTL 内仍可能命中。
- 拆分部署（`RETRIEVAL_SERVICE_URL`）下缓存在调用方（agent 层或单体）查找，键里的指纹取调用方进程看到的文件，适配器却在检索层施加。所以开缓存时调用方要挂载与检索层相同的适配器文件；不一致时，检索层按别的适配器生成的答案不会存进缓存（`query_adapter_changed`），但调用方自己的旧文件不换，键也不换。agent 层的健康检查不检查这个文件。

## 查询侧 embedding 适配器

### 做法

只对查询向量做线性变换 q' = W q（W 是 d×d 矩阵，nomic-embed-text 下 d=768），文档向量不动，所以不用 reindex，关掉也只是改配置（`server/rag/query-adapter.js`）。

**训练**（`server/evaluation/train-query-adapter.py`，数据由 `server/evaluation/query-adapter-data.mjs` 导出）：

- W 从单位矩阵开始。损失是余弦上的 InfoNCE：问题标注的证据段落所在 chunk 是正例；同一篇论文的其他 chunk 是 hard negative（单篇 QA 路由只在一篇论文里排序）；batch 内其他问题的正例是 in-batch negative；再加 λ‖W−I‖² 把 W 往单位矩阵拉回。
- 数据是 QASPER train 的问题和它们的证据段落。向量与应用一致：本地 Ollama 的 nomic-embed-text，文档加 `search_document: ` 前缀，查询加 `search_query: ` 前缀，切块用应用自己的 chunker。
- 调参只在 train 上做：按论文留出 20% 的 train 论文做早停和网格选择（λ∈{0.01, 0.1, 0.3, 1}、τ∈{0.05, 0.1}、lr∈{5e-5, 2e-4}，共 16 组），选择指标是留出集上的篇内 dense hit@6，并列时看 MRR。dev 只用来确认。
- 在 CPU 上训练，结果确定；输出文件原子写入。文件里写明它所属的 embedding 空间：模型、两个任务前缀、维度。

**生效范围**（只在测过的地方生效）。查询 embedding 和查询向量缓存（`server/rag/embedding-cache.js`）始终保存模型的原始向量；检索接缝（`server/rag/vector-store.js`）只在下列条件全部满足时，为这一次搜索算一份 W q：

- 调用方是单篇 QA 路由自己的检索（`queryAdapterScope: "single_document_qa"`，没有 agent 检索计划），且恰好一篇文档；
- hybrid 路由，且融合方式是 RRF；
- 查询向量确实由 embedding 模型在适配器训练所用的空间里生成（替身 provider 的向量不适配，除非它声明 `allowQueryAdapter: true`；pinned 到别的空间的索引版本，其查询也不适配）；
- 向量库能"按 W q 排序、按原向量打分"：local 和 pgvector 可以，Qdrant 不行。

比较、多文档、gap-plan 补充检索、agent 规划和追问的检索、dense-only、加权融合一律不适配。`/chat` 的 agent 在选中 document_rag 时总会建检索计划，所以 `/chat` 目前用不到适配器；不带计划的 `chat()` 调用（例如 MCP `archive_ask`）在单篇文档时会用到。

**分数保持原刻度**：dense 路由按 W q 排序，但 `vectorScore` / `admissionScore` 仍是模型原向量的余弦。所以 `RAG_MIN_RELEVANCE_SCORE`、`selectQaContext` 的额外候选门槛、比较的语义旁路都还是按原刻度设定的。W q 会把余弦整体压低（留出的 train 论文上，篇内平均余弦 0.59 → 0.14，top-1 0.72 → 0.31），远低于这些门槛。

**失效方式**：在适用范围内却没法适配时（文件缺失或损坏、训练空间与配置不一致、路由或融合方式不对、向量库不支持、替身 provider 的向量），检索退回未适配，每种原因只告警一次，不会让请求失败。不在适用范围的调用（不是单篇 QA，或不止一篇文档）直接不适配，也不告警。健康检查 `checks.queryAdapter`：文件不可读或格式不对时报 error（`STARTUP_HEALTH_STRICT` 下启动失败）；空间不匹配、路由不是 hybrid、融合不是 RRF、向量库不支持时报 warning（这些情况下不适配）。

**可追溯**：被适配的检索在 `routes.dense.queryAdapter` 和 `provenance.queryAdapter` 上带适配器指纹。`eval:qasper-retrieval`、`eval:qasper-answers`、`eval:abstention-gate` 在 `config.queryAdapter` 里记录指纹；`eval:qasper-retrieval --compare` 拒绝配对指纹不同的两份报告（2026-10-28 起也拒绝语料、seed 或题数不同的报告，并列出 `config.retrieval` 的差异）。没开适配器时，检索结果和 `retrieval` 块不加这两个字段，响应和评测基线的形状不变；三个评测报告的 `config.queryAdapter` 记为 null。

**测试**：`test/query-adapter.test.mjs`。

### 配置

- `RAG_EMBEDDING_QUERY_ADAPTER`：默认关。值是适配器文件路径，相对路径按进程工作目录解析；空、`0`、`false`、`no`、`off`、`none` 表示关闭。
- 训练产物在 `server/evaluation/generated/` 下，这个目录不进 Git，也不进 Docker 镜像，部署时要挂载文件。

### 复现

先用 `npm run corpus:qasper` 把下载的 QASPER 发布文件转成 `server/evaluation/generated/qasper-train.json` 和 `qasper-dev.json`（`--input` 指向发布文件，`--papers all` 转换全部论文（默认只抽 20 篇），`--output` 指定输出，默认是 `qasper-dev-sample.json`；见 `docs/evaluation.md`），用 `npm run rerank:cross-encoder:setup` 建好训练用的 `evaluation/.venv-neural-reranker`（torch）。然后在 `server/` 下：

```
export OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_API_KEY=ollama OPENAI_EMBEDDING_MODEL=nomic-embed-text RAG_EMBEDDING_DIMENSIONS=768
npm run adapter:data          # 导出 QASPER train 的 chunk/问题向量到 evaluation/generated/query-adapter/，中断后可续跑
npm run adapter:train         # 训练并写出 evaluation/generated/query-adapter/qasper-nomic-adapter.json
npm run eval:query-adapter    # QASPER dev，hybrid 单篇 QA 路由上比较 identity 与 adapter，配对 bootstrap 95% CI
```

启用：`RAG_EMBEDDING_QUERY_ADAPTER=evaluation/generated/query-adapter/qasper-nomic-adapter.json`。

`eval:query-adapter` 用 local 索引入库一次，每个问题跑两遍 `retrieveQaCandidates`。适配臂的每个问题都必须在 dense provenance 上带指纹、identity 臂一个都不能带，两臂都排到的 chunk `vectorScore` 必须相同，否则整次运行失败：报告证明的是哪一臂真的跑了，而不是相信开关。

### 实测

**检索**（QASPER dev，821 个可回答 + 95 个不可回答问题，seed 1，top-K 6，hybrid RRF，适配器指纹 `qa1-8a7d74c666072fa6`，适配器减 identity，配对 bootstrap 95% CI）：

| 指标 | identity | adapter | 差值 [95% CI] |
| --- | --- | --- | --- |
| 证据进入候选 | 0.692 | 0.738 | +0.0463 [0.0244, 0.0694] |
| 证据在 rank 1 | 0.281 | 0.311 | +0.0292 [0.0073, 0.0512] |
| 证据在 top 3 | 0.516 | 0.540 | +0.0231 [0, 0.0463]，下界为 0，不宣称 |
| 证据被门控放行 | 0.245 | 0.259 | +0.0146 [0.0037, 0.0268] |
| 证据进入回答模型的上下文 | 0.3532 | 0.3727 | +0.0195 [0.0024, 0.0365] |
| 不可答问题被门控放行（误放行） | 0.3895 | 0.3684 | −0.0211 [−0.0737, 0.0316]，没有可测的增加，但区间宽 |

两臂共同排到的 4060 个（chunk, 查询）对，`vectorScore` 完全一致。事先声明的检索规则（hybrid 证据进入候选和进入上下文都提升且 CI 不含 0，不可答误放行没有可测增加）满足。

**回答**（`eval:qasper-answers`，dev 200 题，其中 20 题不可答，qwen2.5:7b，配对）：

- 答案 F1 0.2576 → 0.2562，−0.0014 [−0.0158, 0.0131]；
- 报告里的 `evidenceRecall`（证据段落在答案的来源中）+0.0167 [−0.0111, 0.0500]；
- 可答题作答率 +0.0278 [−0.0056, 0.0611]。

三项都不显著。这两份报告早于 2026-10-04 的指标改名：QA 路径把给模型看的每个上下文 chunk 都当作来源返回，所以 `evidenceRecall` 测的是上下文证据召回（现在叫 `contextEvidenceRecall`），不是答案引用了哪页（见 `docs/evaluation.md`「引用证据：答案实际引用的页（2026-10-04）」）。

**dense-only**（早先一次运行，combined 打分，同样是 dev 821 题）：top 3 0.507 → 0.475，−0.0317 [−0.0609, −0.0024]，CI 不含 0；rank 1 0.275 → 0.266，−0.010 [−0.035, 0.016]；证据进入候选 0.694 → 0.686，−0.009 [−0.037, 0.020]；后两项不显著。combined 打分取 max(余弦, 关键词覆盖, 加权和)，余弦变小后排序被关键词覆盖主导。所以 dense-only 不启用适配器，`eval:query-adapter` 现在也不再跑这一臂。

**训练集留出**：hit@6 0.668 → 0.722，是 16 组配置里选出的最好结果，偏乐观，以 dev 结果为准。

### 结论与局限

- 默认保持关闭。检索层收益成立，但答案 F1 持平，不能说它提升了回答。此前把它"推荐为调优配置"的说法撤回，它只是一个可选的检索设置。
- 只在 QASPER + nomic-embed-text + hybrid RRF + 单篇 QA 这一组合上测过。换 embedding 模型或语料要重新训练、重新评测。
- `/chat` 的 agent 路径目前不经过适配器，收益只对不带检索计划的单篇调用有意义。
- 未测量：pgvector 后端上的效果（评测用 local 索引）、与 cross-encoder 重排叠加、比较和多文档检索。
- 训练产物不在镜像里，部署时要挂载；在同一路径替换文件后，语义缓存会换键并清掉旧条目（见上一节）。
