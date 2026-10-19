# 03 文档解析、切块与混合检索

> 范围：文档解析、切块与混合检索（PDF 解析 → 切块 → embedding → pgvector 稠密 + PG 内 BM25 稀疏 → 加权 RRF → 可选重排；含索引版本、查询路由/分解、语义缓存、查询适配器）
>
> 回到 [总手册](../DEEP-DIVE-PLAYBOOK.md)。数字出处以 [CURRENT-TRUTH.md](../CURRENT-TRUTH.md) 和 `docs/evaluation.md` 为准；代码位置写成「路径 + 函数/常量名」，均经核验代理 grep 确认。

## 30 秒讲法

解析默认用 pdf.js 读 PDF 文本层，并按行的几何信息识别段落（默认开）。Docling 整份解析和 PDF_PARSER=auto 都是可选项，auto 只把表格页和扫描页送去 docling-serve。切块默认是 structured：识别标题、以段落为单元、块不跨页，并用 findUnindexedPageText 逐页检查丢字，55 份 PDF 的丢字从 7,866 个字符降到 0。检索全在一个 PostgreSQL 里：pgvector 余弦，加上自建的 Okapi BM25（按租户范围维护统计、剪掉常见词），两路用加权 RRF 融合，交叉编码器重排可选；文档行和分块同事务写，行级安全兜底，换 embedding 模型走索引版本切换，在单机 2 实例、假模型的压测里 0 错误。评测用外部标注的 QASPER dev 821 题，配对 bootstrap CI 看显著性：hybrid 显著好于单用 BM25，和纯稠密没有显著差异；nomic 任务前缀让证据进入候选显著 +4.4 个点，但答案 F1 被拒答门控挡住，没有显著变化。交叉编码器和查询适配器在检索层有显著收益，答案 F1 却不显著；Docling/auto、按句子切块、语义缓存要么没有显著收益，要么代价太大。所以这些都默认关闭。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `server/rag/pdf-loader.js` | 所有入库路径的 PDF 入口 loadPdfPages，按 PDF_PARSER（pdfjs/docling/auto）分派；docling 失败时退回 pdf.js，DOCLING_FALLBACK=none 时直接报错 |
| `server/rag/pdfjs-document.js` | parsePdfBytesWithPdfjs：在进程内解析，或交给 worker 池按页段解析；最后在全文范围统一渲染（renderExtractedPages，连字符词表跨页） |
| `server/rag/pdf-page-extraction.js` | extractPdfPageRange 读每页文本和信号（字符数、表格行、表格标题、图片覆盖、乱码比）；EQUATION_NUMBER_PATTERN 排除公式编号行；renderExtractedPages 渲染 |
| `server/rag/pdf-paragraphs.js` | 段落识别 isPdfParagraphBreak / renderPdfParagraphText；行末连字符 shouldDropLineEndHyphen / buildHyphenationVocabulary |
| `server/rag/wrapped-lines.js` | isWrappedLineContinuation：入库和 claim 校验共用的软换行规则 |
| `server/rag/pdf-page-router.js` | classifyPdfPage 按规则把页分到 text/layout/ocr；planDoclingBatches 拼 page_range 请求 |
| `server/rag/pdf-auto-parser.js` | loadPdfPagesWithRouting：pdf.js 带信号过一遍，选出的页送 docling-serve，失败或空页退回 pdf.js 文本，并给出路由报告 |
| `server/rag/docling-parser.js` | docling-serve 客户端：进程级 FIFO 限流（默认 2 个并发）；renderDoclingTable 把表格按列名展开；splitDoclingTextByPage 把跨页段落拆回各页 |
| `server/rag/pdf-parse-pool.js` | pdf.js 的 worker_threads 池 runPdfParseTask：FIFO、超时、worker 崩溃后替换、空闲时 unref |
| `server/rag/chunker.js` | chunkPageWithStructure（默认）/ chunkPageWithSentences / chunkPageWithFixedWindows；findUnindexedPageText 查丢字 |
| `server/rag/sentence-splitter.js` | sentence 策略用的规则切句（缩写、首字母、小数、CJK 句号）：splitSentenceSegments |
| `server/rag/config.js` | EMBEDDING_TASK_PREFIXES、getEmbeddingIndexIdentity、getRrfK、getHybridDenseWeight、DEFAULT_SPARSE_SCORING、getPgvectorIterativeScan、getChunkSize 等默认值 |
| `server/rag/openai.js` | embedQuery / embedTexts：加任务前缀，按 embeddingSpace 嵌入，标记模型自己产生的向量 |
| `server/rag/embedding-cache.js` | embedQueryCached：按激活版本的空间嵌入查询；LRU + 同租户 in-flight 去重；缓存里只存模型自己的向量 |
| `server/rag/query-adapter.js` | 查询侧线性适配器，只在单文档 QA、恰好一篇文档、hybrid RRF、向量空间一致时生效。adaptQueryVectorForSearch 不满足条件时退回未适配并告警一次；文件不可读或无效时，健康检查 checks.queryAdapter 报 error |
| `server/rag/vector-store.js` | 检索接缝：provider 白名单（getVectorStoreImplementation）、searchHybridDocumentsWithRoutes 两路并发、fuseSearchResultsByRrf、provenance、beginVectorIndexWrite |
| `server/rag/vector-store-pgvector.js` | 稠密 SQL（iterative scan + MATERIALIZED CTE）；稀疏检索 searchPgvectorSparseDocuments：默认 BM25 走 <t>_sparse_search 函数，ts_rank_cd 且关剪枝时走普通语句或 014 的租户函数；多版本写入 |
| `server/rag/vector-store-pgvector-sparse.js` | BM25 与剪枝的 JS 侧：PGVECTOR_SPARSE_BACKENDS 后端标签、SPARSE_CANDIDATE_PATHS 候选路径、PGVECTOR_SPARSE_PRUNE_MIN_CHUNKS、usesPgvectorSparseSearchFunction、buildPgvectorSparseSearchSql |
| `server/db/migrations/030_create_sparse_bm25_statistics.sql` | 给每个版本表建 BM25 统计（__DOCUMENT_CHUNKS_TABLE___install_bm25）：只追加的日志表、try-lock 下的 fold、语句级 transition 触发器、_sparse_search 函数 |
| `server/db/migrations/014_create_sparse_rank_function.sql` | RLS 下让全文检索能用上 GIN 的 SECURITY DEFINER 排序函数（033 加固）。现在只在 ts_rank_cd 且关剪枝的多文档租户查询里用；默认 BM25 走 030 的 _sparse_search |
| `server/rag/vector-store-pgvector-versions.js` | 索引版本注册表、指针 TTL 缓存、写入目标锁 lockIndexVersionWriteTargets、双写宽限 getEffectiveDualWriteGraceMs、resolveServingQueryEmbeddingSpace |
| `server/rag/vector-store-pgvector-version-lifecycle.js` | 建版本、校验、激活、回滚、退役；runBuildDocuments 并行建；runIndexVersionRecallProbe 召回探针 |
| `server/rag/sparse-store.js` | 本地 BM25 searchSparseDocuments（参照实现，Lucene IDF）；评测的 standalone 档走它 |
| `server/rag/retrievers/global-retriever.js` | retrieveGlobalContextWithRoutes：开 rerank 时先取 topK×3 个候选，融合后再重排 |
| `server/rag/reranker.js` | 启发式 / cross-encoder 重排；rerankResultsOrKeepOrder 出错时保持融合顺序 |
| `server/rag/query-router.js` | routeQuery：用正则信号判 qa / compare（多文档且置信度 ≥0.5 才走 compare） |
| `server/rag/query-decomposer.js` | buildEvidenceRequirements / buildRetrievalQueries：按 and、also、以及、分号等拆多部分问题（最多 4 个，RAG_QUERY_DECOMPOSITION_MAX_REQUIREMENTS） |
| `server/rag/agent-query-planner.js` | buildAgentRetrievalPlan：agent 路径的检索计划（意图 → topK + 模板化子查询，INTENT_OPTIONS） |
| `server/rag/document-rag-execution.js` | executeDocumentRag / buildRetrievalInputs / retrieveGlobalContextForQueries（本地或远程检索层）/ retrieveQaCandidates |
| `server/rag/semantic-cache.js` | 进程内语义答案缓存：键、命中、失效（lookupSemanticCache / storeSemanticCacheAnswer / invalidateSemanticCacheDocuments，默认关） |
| `server/rag/semantic-cache-guard.js` | compareCacheQuestions 词法守卫（SEMANTIC_CACHE_GUARD_VERSION = semantic-cache-guard/v2） |

## 一次请求怎么经过这里

【上传入库】routes/uploads → rag/index.js ingestDocument。RAG_INGEST_MODE=async 时改走 ingest-pipeline，分 parse→chunk→embed→index 四个阶段，每阶段落库。→ pdf-loader.js loadPdfPages：
- pdfjs（默认）：parsePdfBytesWithPdfjs → extractPdfPageRange（PDF_PARSE_WORKERS>0 时经 runPdfParseTask 走 worker 池）→ renderExtractedPages（renderPdfParagraphText + buildHyphenationVocabulary）
- docling：loadPdfPagesWithDocling
- auto：loadPdfPagesAuto → loadPdfPagesWithRouting。pdf.js 带 collectSignals 过一遍 → classifyPdfPage → planDoclingBatches → convertPdfBytesWithDocling（受限流器约束）→ 用 Docling 文本替换选中页；失败或空页保留 pdf.js 文本

→ index.js chunkDocumentPages → chunker.js chunkDocumentWithConfig（默认 chunkPageWithStructure，900/180）→ commitDocument。
- 事务外：vector-store.js prepareDocumentsForIndex（embedTexts 加 search_document: 前缀；异步模式由跨文档合批器嵌入）
- 同一事务内：beginVectorIndexWrite（pgvector 内部走 lockIndexVersionWriteTargets：共享 advisory 锁 + 读写入目标版本）→ registerDocument 写文档行 → writeDocumentsToPgvectorIndex 写每个写入目标版本表；030 的触发器填 sparse_length、追加 BM25 统计日志
- 提交后：invalidateSemanticCacheDocuments

【一次 /chat 的检索】agent 的 document_rag 步骤（agent-preparation-flow 先用 buildAgentRetrievalPlan 生成检索计划；MCP archive_ask 没有这个计划）→ ragService.chat → document-rag-execution.js executeDocumentRag → buildRetrievalInputs：
- routeQuery 判 qa/compare
- buildEvidenceRequirements + buildRetrievalQueries 拆子查询；有 agent 计划时用计划里的查询
- embedQueryCached(resolvedQuery)：加查询前缀，按激活版本的空间嵌入

→ lookupSemanticCache（开启时；命中直接返回）→ executeQaRag 或 executeComparisonRag → retrieveGlobalContextForQueries（走远程检索层或进程内）。每条子查询：
- retrieveGlobalContextWithRoutes → vector-store.js searchDocumentsWithRoutes → searchHybridDocumentsWithRoutes
- adaptQueryVectorForSearch（仅单文档 QA、没有 agent 计划时）
- 并发跑 searchPgvectorDocuments（doc_id 过滤 + hnsw.iterative_scan）和 searchPgvectorSparseDocuments（默认 BM25 走 <t>_sparse_search 函数）
- keepNewestDocumentVersion → fuseSearchResultsByRrf（k=60，权重 0.65/0.35）
- 回到 global-retriever：rerankResultsOrKeepOrder

→ mergeRetrievedResults + rerankMergedResults 合并多条子查询的结果 → 交给门控 assessQaConfidence / selectQaContext（属于答案子系统）→ writeQaAnswer → storeSemanticCacheAnswer。

对比路径走 retrievePerDocumentContextForQueries → searchDocumentsPerDocumentWithRoutes：每篇文档各跑一次 hybrid（Promise.all 并发）。

## 设计决策

### D1. 默认向量库用 pgvector，和文档注册表放在同一个 PostgreSQL

**为什么**

文档行和分块在同一事务提交，不存在跨系统一致性问题；行级安全在库里兜底租户隔离；索引版本指针也在同库，能原子切换；有状态组件只有一个

**为什么不用主流替代方案**

Milvus/Qdrant：没有行级安全，删文档后向量可能还在，需要跨系统补偿。Qdrant 实现保留为 opt-in，但健康检查标为单租户（single_tenant_vector_store，BM25 统计跨整个集合）。ES/OpenSearch：BM25、中文分词、分片都更成熟，但要多维护一个集群和同步链路

**代价**

PG 特有的坑得自己踩、自己修：HNSW 先取候选再过滤导致少返回、RLS 下 @@ 走不了 GIN、BM25 统计要自建。没有分片，单库容量就是上限

**证据**

CURRENT-TRUTH 3.15，bench:pgvector-scale，合成 768 维向量，RLS enforce，集群关了 fsync：100 万分块 10.4 GB，HNSW 构建 169 s，单文档 dense p95 0.91 ms，100 篇 hybrid p95 21.2 ms（热）、首次读 111 ms。没做和 Milvus/ES 的对比

**代码**：server/rag/vector-store.js getVectorStoreImplementation；server/rag/index.js commitDocument；server/rag/vector-store.js beginVectorIndexWrite

### D2. 稠密和稀疏两路独立召回，用加权 RRF 融合（k=60；dense 0.65 / sparse 0.35，归一后乘到每路的 RRF 贡献上），rerank 只放在融合之后

**为什么**

余弦和 BM25 的分数尺度不可比（BM25 没有上界），RRF 只看名次，不需要标定。每条结果都带 provenance（哪一路、名次、原始分），质量门据此验证路由确实执行了、和 manifest 一致

**为什么不用主流替代方案**

加权分数融合需要先归一化（保留为 RAG_HYBRID_FUSION=weighted）；只用 dense；学习型融合需要标注数据

**代价**

每次检索两条 SQL。融合分乘 (k+1) 后只用于排序，不是置信度，准入用 admissionScore=max(vectorScore, keywordScore)。0.65/0.35 这组权重没找到调参记录

**证据**

QASPER dev 821 题 Top-5：hybrid 0.517、dense 0.511、BM25 0.442。hybrid−BM25 +0.074 [+0.048, +0.102]，显著；hybrid−dense +0.006 [−0.019, +0.031]，不显著（CURRENT-TRUTH 3.1，local store）。权重：无实测

**代码**：server/rag/vector-store.js fuseSearchResultsByRrf / getRrfContribution；server/rag/config.js getRrfK / getHybridDenseWeight / getHybridSparseWeight；server/rag/citations.js computeAdmissionScore

### D3. 在 PostgreSQL 里自建 Okapi BM25 统计（迁移 029/030），RAG_SPARSE_SCORING 默认 bm25，ts_rank_cd 仍可选

**为什么**

PG 的 ts_rank_cd 是覆盖密度排序，没有 IDF，不是 BM25。不装扩展，托管 PG 也能用。统计按 (owner_user_id, workspace_id) 范围维护，IDF 不跨租户。公式和本地 sparse-store 相同（Lucene IDF，k1=1.2，b=0.75），可以互为参照

**为什么不用主流替代方案**

BM25 扩展（如 ParadeDB pg_search）：托管环境不一定能装，没评估过；ES：多一套系统；继续只用 ts_rank_cd：保留为选项

**代价**

写入方只往日志表追加，抢到 pg_try_advisory_xact_lock 的那条语句负责 fold，其余直接跳过，写入方之间互不等待。代价：一次 50 块入库 p50 336 vs 317 ms；删除要展开 tsvector，每 1000 块 25 ms vs 4.4 ms；迁移前写入的行要 vector:sparse-length 回填；文本配置是 'simple'，没有词干，中文按单字切

**证据**

QASPER dev hybrid 证据召回 −0.0012 [−0.0122, +0.0097]：不显著，也没达到事先定的 −0.01 非劣性下界。默认改成 bm25 是用户的产品决定（CURRENT-TRUTH 3.18）

**代码**：server/db/migrations/030_create_sparse_bm25_statistics.sql __DOCUMENT_CHUNKS_TABLE___install_bm25；server/rag/vector-store-pgvector-sparse.js PGVECTOR_SPARSE_BACKENDS；server/rag/config.js DEFAULT_SPARSE_SCORING

### D4. 常见词剪枝：被搜文档超过 1000 个分块时生效，候选只由文档频率 ≤10% 的词经 GIN 召回，再用全部查询词打分；纯常见词查询最多取 2000 个候选

**为什么**

一个常见词会让 GIN 几乎命中整个文档集，每块都要打分，尾延迟很高

**为什么不用主流替代方案**

Lucene 的 WAND/MaxScore 在 SQL 里难实现；固定停用词表管不住领域常见词；不剪枝就要逐行打分

**代价**

纯常见词查询的结果按物理顺序截断，前 10 条和穷举只重合 32–41%（ts_rank_cd；BM25 单个常见词 29%、三个常见词 95.7%）。每条结果标出候选路径（exhaustive/pruned/pruned_filled/common_bounded）

**证据**

10 万分块、2000 篇、RLS、全表：100 条混合查询中含常见词的 11 条，ts_rank_cd p50/p95 135/180→39/49 ms，BM25 281/389→40/51 ms；100 条整体 ts_rank_cd p95 135→73 ms；QASPER train/dev hitAtAll 差值 0 [0, 0]（CURRENT-TRUTH 3.18；retrieval-tuning.md「BM25 与常见词剪枝」→「实测」）。纯常见词的题 train 只有 3 道、dev 只有 19 道，截断对证据召回的影响实际没测到（同一小节）

**代码**：server/rag/vector-store-pgvector-sparse.js PGVECTOR_SPARSE_PRUNE_MIN_CHUNKS / SPARSE_CANDIDATE_PATHS；server/rag/config.js getSparseCommonTermCap / DEFAULT_SPARSE_PRUNE_DF_FRACTION

### D5. 稠密检索每次在同一事务里设 hnsw.iterative_scan=relaxed_order，再用 MATERIALIZED CTE 加 `distance + 0` 恢复严格的距离排序

**为什么**

doc_id 过滤发生在 HNSW 返回 ef_search 个候选之后。文档集占表的比例很大、优化器又选了 HNSW 时，返回的结果会少于 topK

**为什么不用主流替代方案**

调大 ef_search 只是降低概率；按租户或文档分区要改表结构；强制精确扫描在大文档集上慢

**代价**

需要 pgvector 0.8+（supportsPgvectorIterativeScan 判断，旧版本用原语句）；每次查询多 0.04–0.17 ms；它只解决条数不够，解决不了 HNSW 本身的近似损失

**证据**

1 万分块、文档集占半表：平均 9.95/10、最差 5/10 → 10/10，recall 0.994→1.0。10 万分块、1000 篇：0.898→0.912，在两次建图的波动范围内，不算改进（CURRENT-TRUTH 3.15）

**代码**：server/rag/vector-store-pgvector.js buildIterativeDenseSearchSql / runIterativeDenseSearch / supportsPgvectorIterativeScan；server/rag/config.js getPgvectorIterativeScan

### D6. 行级安全下的多文档稀疏检索走 SECURITY DEFINER 函数：先只保留租户看得见的 doc id，函数用 GIN 打分、只返回 chunk_id 和分数，再以租户身份 join 回分块表。最早是迁移 014 的 _sparse_rank（033 加固）；现在默认 BM25 一律走 030 的 <t>_sparse_search，同一套思路，014 只在 ts_rank_cd 且关剪枝时用

**为什么**

@@ 不是 leakproof 运算符，RLS 下不能当索引条件，租户查 1000 篇文档时要逐行解压 5 万个 search_vector

**为什么不用主流替代方案**

关掉 RLS 只靠应用层过滤，就失去了兜底；把租户 id 拼进 tsvector，会污染排序，也防不住漏写过滤

**代价**

候选排序这一步绕过了 RLS，用户明确同意了这个权衡。必须先过滤 doc id 再截断：审查发现过"先截断后过滤"会暴露别的租户的文档是否含某个词。ts_rank_cd 下单文档仍走普通语句；BM25 下单文档也走函数

**证据**

迁移 014（ts_rank_cd 路径）：10 万分块、1000 篇，sparse p50/p95 142/157 → 19/58 ms；全表时 p95 不变（CURRENT-TRUTH 3.15，evaluation.md"全文检索与行级安全"）。BM25 函数的延迟见常见词剪枝那一条

**代码**：server/rag/vector-store-pgvector.js buildTenantSparseSearchSql / searchPgvectorSparseDocuments；server/rag/vector-store-pgvector-sparse.js usesPgvectorSparseSearchFunction / buildPgvectorSparseSearchSql；server/db/migrations/014_create_sparse_rank_function.sql

### D7. embedding 任务前缀加进查询和文档，并作为"索引标识"（model#prefix）的一部分；标识不一致时失败关闭

**为什么**

nomic-embed-text 官方要求加前缀；换了前缀就是另一个向量空间，和旧向量算余弦没有意义

**为什么不用主流替代方案**

不加前缀（原状）；悄悄混用新旧向量

**代价**

已有索引必须 vector:reindex 重建；重建之前 pgvector 直接报错，local 和 Qdrant 对旧块不给向量分

**证据**

dev 821 题，证据进入候选 0.648→0.692，+0.044 [+0.021, +0.067]；第 1 名 +0.029，前 3 名 +0.033，都显著。答案 F1 0.231→0.235，不显著（CURRENT-TRUTH 3.1）

**代码**：server/rag/config.js EMBEDDING_TASK_PREFIXES / getEmbeddingIndexIdentity / isEmbeddingIdentityCurrent；server/rag/openai.js embedTexts / embedQuery

### D8. 索引版本（蓝绿）：每个版本一张表，一行指针，实例按 2 s TTL 缓存指针；被替换的版本在宽限期内继续双写（默认 24 h，至少 2×TTL）

**为什么**

换 embedding 模型或维度时不停机、能回滚、不丢写入；查询按激活版本的空间嵌入

**为什么不用主流替代方案**

原地 reindex：期间新旧空间混在一起，回滚要再全量重建。ES 式别名切换：需要换存储

**代价**

宽限期内写入翻倍。建版本要从存储的 PDF 原件重新解析和嵌入。锁顺序（指针行 → 版本行 → advisory 锁）不能改。local 和 Qdrant 没有版本机制

**证据**

2 实例、租户 RLS、/chat 并发 8 压测，假模型：建、校验、切换、回滚全程 0 错误（两轮 8,749 / 9,844 次），切换 235 ms，所有实例 2 s 内跟上（CURRENT-TRUTH 3.16）。并行建版本 8.57→33.2 篇/秒（3.17）

**代码**：server/rag/vector-store-pgvector-versions.js lockIndexVersionWriteTargets / getEffectiveDualWriteGraceMs / resolveServingQueryEmbeddingSpace；server/rag/vector-store-pgvector-version-lifecycle.js activateIndexVersion / rollbackIndexVersion / runIndexVersionRecallProbe

### D9. PDF 默认用 pdf.js，段落识别默认开；Docling 整份（PDF_PARSER=docling）和按页分流（auto）都是 opt-in

**为什么**

born-digital 页 pdf.js 毫秒级就能读好；Docling 在 CPU 上一篇 10 页论文约 12 秒，测下来没有显著收益

**为什么不用主流替代方案**

全量 Docling、unstructured 或云解析（LlamaParse 等）：成本高，云服务还要把文档送出去；只用 OCR：born-digital 文本反而变差

**代价**

pdf.js 读表格只有数字，没有列名；默认没有 OCR。auto 的阈值是看那 30 篇论文定的；每个页段请求都要上传整个文件

**证据**

Docling 整份：69 道表格题 F1 +0.020 [−0.011, +0.057]，不显著；30 篇解析 350 s vs 1.4 s。auto：266 页里送 105 页（39%），总耗时 252–279 s（整份 Docling 330 s）；表格题 F1 +0.008 [−0.031, +0.053]，全部题 +0.005 [−0.020, +0.032]（evaluation.md"按页分流和并行解析"）。段落识别：F1 −0.0001 [−0.0185, +0.0204]（evaluation.md"pdf.js 段落识别"，CURRENT-TRUTH 3.26）

**代码**：server/rag/pdf-loader.js loadPdfPages；server/rag/pdf-page-router.js classifyPdfPage / planDoclingBatches；server/rag/pdf-auto-parser.js loadPdfPagesWithRouting；server/rag/pdf-paragraphs.js isPdfParagraphBreak

### D10. 默认用结构化切块：识别标题、以段落为单元、块不跨页，heading-like 行保留为 leading。用 findUnindexedPageText 逐页检查丢字；sentence 策略只作为可选项

**为什么**

实测发现旧切块器里连续的"标题"会互相覆盖，表格行和引导句没进任何块，所以检索不到

**为什么不用主流替代方案**

固定 token 窗口（类似 RecursiveCharacterTextSplitter）：会切断句子和表格行。sentence 策略：按事先定的规则测了，没通过。语义切块（按 embedding 断点）：没做

**代价**

段落识别开启后块会超长。evaluation.md 段落识别一节记的是 183/2338 个块超过 900 字符（最长 1910）；按句子装块一节记的是"超出块大小 17.9%"，两处口径不一致。块文本总量是页面文本的 1.48 倍，约三分之一是重复文本。改切块后要 vector:reindex 才生效

**证据**

55 份 PDF 丢字：7,866 个非空白字符（612 段）→ 0（3.25）。sentence 600/120 在 dev 上：前三名命中 −0.027 [−0.050, −0.004]，显著更差；候选覆盖 +0.004 [−0.017, 0.026]（3.27）

**代码**：server/rag/chunker.js chunkPageWithStructure / chunkPageWithSentences / findUnindexedPageText / isLikelyHeading

### D11. 查询路由和问题分解都用确定性规则：正则判 qa/compare；按 and、以及、分号等拆多部分问题，最多 4 个，每个子问题有自己的 topK 预算

**为什么**

零模型调用、可审计、可复现；对比路径要按文档各自召回

**为什么不用主流替代方案**

LLM 改写、HyDE、multi-query 生成：多一次模型调用，结果不可复现，也没有评测数据

**代价**

正则覆盖不全。agent 路径的子查询是模板文本（如 "Find exact cited evidence for: …"），会给 BM25 和 embedding 加进噪声词

**证据**

无实测（没有找到分解或模板子查询收益的评测）

**代码**：server/rag/query-router.js routeQuery；server/rag/query-decomposer.js buildEvidenceRequirements / buildRetrievalQueries；server/rag/agent-query-planner.js buildAgentRetrievalPlan

### D12. 交叉编码器重排可选（bge-reranker-v2-m3，取 topK×3 个候选，权重 0.6）；重排失败时这次查询保持融合顺序，不报错

**为什么**

更深的候选加上重排，能把证据送进上下文；但它需要单独的模型服务

**为什么不用主流替代方案**

启发式重排：QASPER 上没有收益；LLM 重排：成本和延迟太高，没做

**代价**

要多部署一个服务（CPU torch）。min-max 归一后的分数只能在同一个查询内比较，所以门控用原始 crossEncoderScore。延迟只记过一个粗略值（本机 MPS 上一次 18 个候选约 0.4 s），没有系统压测

**证据**

dev：证据进入上下文 0.353→0.417，+0.063 [+0.044, +0.085]，显著；F1 +0.008，不显著；可回答题被拒答 −4.4pp [−7.7, −1.7]，显著（3.14a）。权重 0.6 是在 train 上按事先定的指标选的。启发式重排 −0.007，不显著（3.1）

**代码**：server/rag/retrievers/global-retriever.js retrieveGlobalContextWithRoutes；server/rag/reranker.js rerankResultsOrKeepOrder / rerankResultsWithScores

### D13. 语义答案缓存默认关闭；开启时要同时满足余弦 ≥0.97 和词法守卫 v2；键覆盖租户、文档内容版本、索引版本、prompt 指纹、模型和配置（查询适配器取当前加载文件的指纹）

**为什么**

embedding 分不清否定、数字、角色互换（nomic 给否定句 0.994），只靠阈值会给出错误答案

**为什么不用主流替代方案**

只按相似度阈值（GPTCache 式）；放进 PostgreSQL 或 Redis 共享：要新建一张存租户原文的表，配 RLS、保留期和随文档删除

**代价**

改写命中只有 11/17；多实例之间不共享；命中可能给出管线本来会拒答的答案；键取配置的适配器文件指纹，不区分本次检索是否真的适配，换适配器文件会清空本进程所有条目（包括比较、多文档这些不经过适配器的答案）；拆分部署下调用方必须挂同一个文件。2026-10-18 之前这一项恒为 no-adapter，同一路径换文件后旧答案在 TTL 内仍可能命中

**证据**

留出 confirm 集误命中 0/59（旧守卫 25/59，单侧 95% 上界 5%，假设样本独立）；每次命中省约 1.35 s [0.65, 2.19]（旧守卫、无争用、n=26）（CURRENT-TRUTH 3.18；retrieval-tuning.md）

**代码**：server/rag/semantic-cache.js lookupSemanticCache / storeSemanticCacheAnswer；server/rag/semantic-cache-guard.js compareCacheQuestions

### D14. 查询侧线性适配器（q'=Wq，只变换查询，文档不重建）只在测过的范围生效：单文档 QA、恰好一篇文档、hybrid RRF、向量是模型自己产生的、空间一致、向量库支持（local/pgvector，Qdrant 不支持）；vectorScore 仍用原始余弦

**为什么**

不下载新模型、不重建索引，相当于做一次轻量的 embedding 微调

**为什么不用主流替代方案**

全量微调 embedding 模型（要重建索引）；在 dense-only 路由上用（测了，更差）

**代价**

它依赖语料和 embedding 模型，换任何一个都要重训。agent 路径（/chat 带检索计划）不生效。检索时文件坏了或空间不匹配，只告警、退回未适配；健康检查对不可读或无效的文件报 error（严格启动时会拒绝启动），对空间不匹配报 warning

**证据**

dev hybrid 证据进入候选 0.6918→0.7381，+0.0463 [+0.0244, +0.0694]；答案 F1 0.2576→0.2562，不显著；dense-only 前三名 −0.032，CI 不含 0（3.18；retrieval-tuning.md）

**代码**：server/rag/query-adapter.js adaptQueryVectorForSearch / applyQueryAdapter / QUERY_ADAPTER_SCOPE_QA；server/rag/vector-store.js searchHybridDocumentsWithRoutes

## 追问阶梯

按面试官的追问顺序排。先自己出声答一遍，再看要点。⚠ 是这题最容易答错或夸大的地方。

### Q1. 一个 PDF 上传后到能被检索，中间经过哪些步骤？

*L1 是什么*

- loadPdfPages 按 PDF_PARSER 分派：默认 pdf.js，可选 docling 整份，或 auto 按页分流
- pdf.js 段落识别默认开：按行距、字号、缩进、列表标记切段，软换行接回，行末连字符从严处理
- 默认切块 structured 900/180：识别标题、段落为单元、块不跨页，逐页检查丢字
- embedTexts 加文档前缀（nomic 是 search_document:），在事务外完成；异步入库时跨文档合批
- commitDocument 一个事务：先拿共享 advisory 锁、读写入目标版本，再写文档行和每个版本表的分块
- 030 的触发器填 sparse_length、追加 BM25 统计日志；提交后清语义缓存
- RAG_INGEST_MODE=async 时分阶段落库、各自重试、失败进死信（默认是 sync）

代码：`server/rag/index.js ingestDocument / commitDocument`；`server/rag/pdf-loader.js loadPdfPages`；`server/rag/chunker.js chunkDocumentWithConfig`；`server/rag/vector-store.js beginVectorIndexWrite / prepareDocumentsForIndex`

> ⚠ 别说默认就有 OCR 或版面解析（默认只读 pdf.js 文本层），也别说用了 LangChain 的 loader 或 splitter。异步入库和 Docling 都是 opt-in

### Q2. 检索默认怎么做？topK、融合参数各是多少？

*L1 是什么*

- 两路并发：pgvector 余弦（HNSW m16/efc64，doc_id 过滤 + iterative scan），加上 PG FTS 匹配、Okapi BM25 打分
- sparse topK 取 max(topK, 8)，dense 取 max(topK, sparseTopK)，加权 RRF k=60 后取 6
- rerank 默认关；打开后取 topK×3 个候选，交叉编码器重排
- 多部分问题拆子查询（最多 4 个），各自检索后合并去重、全局重排
- 对比路径每篇文档各自跑 hybrid，每篇 3 条
- /chat 走 agent 时用 agent-query-planner 的计划（fact 意图 topK 4，另加一条模板子查询）；MCP archive_ask 用默认的 6

代码：`server/rag/vector-store.js searchHybridDocumentsWithRoutes`；`server/rag/config.js getRetrievalTopK / getSparseRetrievalTopK / getRrfK / getComparisonTopKPerDoc`；`server/rag/agent-query-planner.js INTENT_OPTIONS`

> ⚠ 代码里是加权 RRF（每路贡献乘归一化后的 0.65/0.35），不是标准 RRF。这组权重没找到调参记录，被问就说"沿用加权融合的默认值，没单独测过"。另外，QASPER 答案数字测的是 MCP/RAG 路径，不是 /chat 的 agent 路径

### Q3. 为什么用 RRF？你说 hybrid 好，好多少，显著吗？

*L2 为什么*

- 余弦有界，BM25 无界；RRF 只用名次，不需要标定分数
- 融合分乘 (k+1) 归一到 [0,1]，只用于排序；准入看 admissionScore = max(原始余弦, 关键词覆盖)
- QASPER dev 821 题 Top-5：hybrid 0.517、dense 0.511、BM25 0.442
- hybrid−BM25 +0.074 [+0.048, +0.102]，显著；hybrid−dense +0.006，不显著
- 安全结论：比单用 BM25 显著好，和纯稠密没有显著差异，也从没显著更差

代码：`server/rag/vector-store.js fuseSearchResultsByRrf`；`server/rag/citations.js computeAdmissionScore`

> ⚠ 别把 48 条用例上的 0.71 vs 0.65 说成"提升 6 个点"，那组 CI 跨 0。被追问"那 sparse 有什么用"时，可以说编号、专有名词、精确短语是它的强项，两路互为兜底；但要承认没有按查询类型拆开的数据

### Q4. 你说 sparse 是 BM25？PostgreSQL 不是只有 ts_rank_cd 吗？统计怎么维护，并发写入会不会串行？

*L2 为什么*

- ts_rank_cd 是覆盖密度排序、没有 IDF，不是 BM25；两种都支持，报告里的标签分开（postgres_fts_ts_rank_cd / postgres_bm25）
- 029 加 sparse_length 列；030 装 BEFORE 行触发器来填它，并给每个版本表建 scope 和 term 统计
- 写入方只追加日志（语句级 transition 触发器），抢到 pg_try_advisory_xact_lock 的语句负责 fold，其余跳过：写入互不等待、不死锁
- 查询在同一快照读"汇总 + 未折叠日志"，结果精确
- 统计按被搜文档的 (owner, workspace) 范围算，IDF 不跨租户
- Lucene IDF、k1=1.2、b=0.75，和本地 BM25 的分数差小于 1e-9
- 默认改成 bm25 是用户决定：hybrid 召回差 −0.0012，不显著

代码：`server/db/migrations/030_create_sparse_bm25_statistics.sql __DOCUMENT_CHUNKS_TABLE___install_bm25`；`server/rag/vector-store-pgvector-sparse.js PGVECTOR_SPARSE_TABLE_SUFFIXES / buildPgvectorSparseSearchSql`；`server/rag/sparse-store.js searchSparseDocuments`

> ⚠ 最容易夸大的是"换 BM25 提升了召回"：hybrid 路上没有显著差异。只有纯 sparse 路、搜全部论文时，BM25 比 ts_rank_cd 的 hitAtAll 高约 +0.10，CI 不含 0（retrieval-tuning.md「BM25 与常见词剪枝」的「实测」表和「结论与局限」）。也别照旧版 AGENTS.md 说"scope 行锁串行"，那是被审查推翻的旧设计

### Q5. 为什么不用 Milvus、Qdrant 或 Elasticsearch？

*L3 为什么不用 X / 怎么证明*

- 核心约束是一致性和隔离：文档行和分块同事务提交、RLS 兜底、版本指针同库切换
- 专用向量库要做跨系统一致性，也没有 RLS；Qdrant 实现保留着，但标为单租户，空 docIds 直接返回空
- ES 的 BM25、IK 分词、分片都更成熟，代价是多一个集群和 CDC 同步
- 测到 100 万分块（合成数据）：单文档 dense p95 0.91 ms，100 篇 hybrid 21.2 ms（热）
- 代价是 PG 特有的坑都得自己修（iterative scan、RLS 下的排序函数、BM25 统计）

代码：`server/rag/vector-store.js getVectorStoreImplementation`；`server/rag/vector-store-qdrant.js searchQdrantDocuments`；`server/health.js single_tenant_vector_store`

> ⚠ 别说"pgvector 比 Milvus 快"，没做对比。100 篇的检索走的是 doc_id 精确扫描，没用 HNSW，recall=1 说明不了 HNSW 的质量。安全说法：选型理由是一致性、隔离和运维，不是性能

### Q6. 为什么不直接用 LangChain 或 LlamaIndex 的 loader、splitter、retriever？

*L3 为什么不用 X / 怎么证明*

- 需要框架没有的契约：每条结果带 provenance，质量门据此证明路由确实执行了
- 租户 scope 只来自运行时；检索感知索引版本和 embedding 空间；未知 provider 直接报错，不回退
- 解析和切块的问题是测出来的：换行切断句子、标题覆盖丢了 7,866 个字符，通用 splitter 不会报告丢字
- 检索层是一个接缝：可以在进程内，也可以走远程检索层，两边结果 deepStrictEqual
- 仓库里有 LangChain BaseRetriever 适配器（ArchiveRagRetriever）包着这个接缝，有逐项相等测试；生产没用，因为会改 /chat 的 retrieval 契约

代码：`server/rag/document-rag-execution.js retrieveGlobalContextForQueries`；`server/rag/langgraph/retriever.js ArchiveRagRetriever`；`server/rag/chunker.js findUnindexedPageText`

> ⚠ 别贬低框架，说"原型阶段框架合适，这里要的是可证明的契约"。被问"是不是重复造轮子"时承认维护成本：030 迁移一个文件约 760 行（含大段注释）

### Q7. 为什么默认用 pdf.js、不默认用 Docling？表格和扫描件怎么办？auto 路由怎么判的？

*L3 为什么不用 X / 怎么证明*

- Docling 整份：69 道表格题 F1 +0.020 [−0.011, +0.057]，不显著；解析 350 s vs 1.4 s
- 23 道抽取式表格题里，pdf.js 也能抽出 91% 的答案原文，只是不带列名
- auto 先用 pdf.js 过一遍、采集每页信号，再按规则路由
- 规则：乱码比 ≥0.3 且 ≥20 字 → ocr；不到 200 字且图片覆盖 ≥0.3 → ocr；≥4 条表格行，或有表格标题且 ≥2 行 → layout
- 只有 layout/ocr 页按 page_range 送 docling-serve；默认 2 个并发；失败或返回空页时保留 pdf.js 文本
- 266 页送出 105 页，耗时 252–279 s（整份 330 s），F1 没有显著差异
- 修过一个 bug：跨页段落原来整段记在首页，现在按 charspan 拆回各页

代码：`server/rag/pdf-page-router.js classifyPdfPage`；`server/rag/pdf-auto-parser.js loadPdfPagesWithRouting`；`server/rag/docling-parser.js splitDoclingTextByPage / renderDoclingTable`

> ⚠ 阈值就是看这 30 篇论文定的，路由计数不是独立检验。OCR 只用一份人工扫描件验证过（token 召回 0.93–0.97）。不能说 auto 更好，也不能说能处理真实的扫描档案

### Q8. 切块怎么做？为什么不用固定 token 窗口或语义切块？按句子切不是更规整吗？

*L3 为什么不用 X / 怎么证明*

- structured 900/180：标题靠编号、Title Case、冒号结尾、"第X章"识别；超长段落按整句切；重叠只带末尾能放下的整段或整句
- 修过丢字：连续"标题"互相覆盖；现在保留为 leading，findUnindexedPageText 逐页检查
- sentence 策略按事先定的规则测：train 选出 600/120，dev 前三名命中 −0.027，显著更差，所以没上
- 代价：块会超长（183/2338 超过 900 字符、最长 1910），块文本总量是页面文本的 1.48 倍
- 语义切块没做

代码：`server/rag/chunker.js chunkPageWithStructure / buildOverlapParagraphs / findUnindexedPageText`；`server/rag/sentence-splitter.js splitSentenceSegments`

> ⚠ "整段块排名更好"是推测（QASPER 一页恰好是一个证据段），别说成结论。findUnindexedPageText 按 token 集合检查，同一个词重复出现时丢掉一次看不出来。别说"sentence 更好只是没上"。超长块的比例文档里有两种口径（183/2338 和 17.9%），被追问时说清出处

### Q9. embedding 前缀这件事怎么发现、怎么证明的？为什么端到端没涨？

*L3 为什么不用 X / 怎么证明*

- nomic 官方要求加 search_query: 和 search_document: 前缀，之前没加
- 规则事先定好：train 400 题上变好，并且 dev 的配对 CI 不含 0
- dev：证据进入候选 0.648→0.692，+0.044 [+0.021, +0.067]
- 前缀进了索引标识，pgvector 遇到旧标识就失败关闭，需要 reindex
- F1 0.231→0.235 不显著：约 69% 的证据在候选里，门控只放行 24%
- 后来把"答不答"和"给什么上下文"分开（selectQaContext）：上下文里的证据 0.245→0.353

代码：`server/rag/config.js EMBEDDING_TASK_PREFIXES / getEmbeddingIndexIdentity`；`server/rag/document-rag-execution.js retrieveQaCandidates`；`server/rag/confidence.js selectQaContext`

> ⚠ 被追问"那为什么不放松门控"：降到 0.2 后 F1 0.206→0.153，显著变差，相邻话题的行为测试也会翻转。只能说"检索召回显著提升，端到端被门控挡住"

### Q10. rerank 为什么默认关？交叉编码器的收益到底在哪？

*L3 为什么不用 X / 怎么证明*

- 启发式重排在 QASPER 上 −0.007，不显著
- bge-reranker-v2-m3 从 18 个候选里取 6 个，权重 0.6（在 train 上选的）
- dev：上下文里的证据 +0.063，显著；F1 +0.008，不显著；可回答题被拒答 −4.4pp，显著
- 默认关是因为要单独的模型服务；服务挂了，这次查询退回融合顺序并告警
- 开重排时默认用重排概率做门控（阈值 0.02）：AUC 0.641 vs 0.588，误拒大幅下降，但不可回答题识别从 80% 降到 45%（只有 20 题）

代码：`server/rag/reranker.js rerankResultsOrKeepOrder / rerankResultsWithScores`；`server/rag/retrievers/global-retriever.js retrieveGlobalContextWithRoutes`

> ⚠ 别说"cross-encoder 让答案更准"，F1 不显著。收益来自"更深的候选 + 重排"，它单独选出的第 1 名并不比融合好。延迟只有一个粗略值（本机 MPS 上 18 个候选约 0.4 s），没有系统压测；compose 里的 reranker 镜像也还没真正构建过

### Q11. 你怎么证明检索有效？评测怎么设计的？

*L3 为什么不用 X / 怎么证明*

- 外部标注：QASPER dev，281 篇论文，821 道有证据的可回答题加 95 道不可回答题，每题只在自己那篇论文里检索
- 指标分层：证据在第 1 名、前 3、全部候选、门控放行、模型上下文、答案实际引用
- 配对 bootstrap 95% CI；规则事先写好；train 上调，dev 上确认
- 伪 embedding 只用来测管道：哈希词频下 hybrid 0.543 < BM25 0.658，排序是错的
- CI 每周用 Ollama 跑 200 题 QASPER 检索，hitAtAll 低于 0.6 就失败（首次跑 0.655）
- 质量门检查每个 case 的 retrieval provenance：路由确实执行了，和 manifest 一致

代码：`server/evaluation/run-qasper-retrieval-eval.mjs main`；`server/evaluation/run-retrieval-comparison.mjs`；`server/evaluation/run-sparse-scoring-eval.mjs`

> ⚠ 主动说三件事。① 这些效果数字大多是在 standalone 档的本地 store 上测的（精确余弦 + 内存 BM25），pgvector 路只有 eval:sparse-scoring 测过召回。② 只测了一个 embedding 模型、一个 7B 模型。③ 旧报告里的 evidenceRecall 其实是上下文指标，已改名为 contextEvidenceRecall

### Q12. pgvector 在带过滤和多租户的场景下踩过哪些坑？你说 recall 到 1.0 了，说明 HNSW 很好吗？

*L4 边界 / 规模 / 重做*

- HNSW 先取 ef_search=40 个候选再按 doc_id 过滤：文档集占半表时平均只返回 9.95/10，最差 5/10
- 修法：同一事务里设 hnsw.iterative_scan=relaxed_order，再用 MATERIALIZED CTE 恢复排序 → 10/10，每次多 0.04–0.17 ms
- RLS 下 @@ 走不了 GIN，租户查 1000 篇约 142 ms；014 函数先过滤 doc id 再用 GIN 打分 → p50 19 ms。默认 BM25 走 030 的 _sparse_search，是同一套做法
- 审查发现过泄露通道：先截断后过滤，会暴露别的租户文档含不含某个词
- 常见词让 GIN 命中整个文档集 → 剪枝

代码：`server/rag/vector-store-pgvector.js buildIterativeDenseSearchSql / buildTenantSparseSearchSql`；`server/rag/vector-store-pgvector-sparse.js usesPgvectorSparseSearchFunction`；`server/db/migrations/014_create_sparse_rank_function.sql`

> ⚠ recall 1.0 来自 doc_id 精确扫描或单一场景，说明不了 HNSW 的质量。10 万分块、1000 篇时 0.898→0.912，在波动范围内。SECURITY DEFINER 意味着"候选排序这一步绕过了 RLS"，要说清楚是怎么限制住的

### Q13. 线上要换 embedding 模型（还变维度），怎么做到零停机？

*L4 边界 / 规模 / 重做*

- 每个版本一张表，有自己的 vector(N)、HNSW/GIN、RLS 策略和 BM25 统计；状态 building/ready/active/retired/failed
- 从库里存的 PDF 原件重新解析、切块、嵌入；租约加 builder_id 做围栏；进度和分块同事务提交，可以精确 resume
- validate：比对分块数，加可选的召回探针（默认下限 0.8）
- activate/rollback 锁指针；实例 2 s 内跟上；旧版本双写宽限 24 h，宽限期内回滚不丢写入
- 查询按激活版本的空间嵌入；压测下切换 0 错误，命令耗时约 235 ms

代码：`server/rag/vector-store-pgvector-version-lifecycle.js validateIndexVersion / activateIndexVersion / runBuildDocuments`；`server/rag/vector-store-pgvector-versions.js getEffectiveDualWriteGraceMs / lockIndexVersionWriteTargets`

> ⚠ "零停机"是在单机、2 实例、假模型下测的。embedding 100 ms 时，串行建版本只有约 8.6 篇/秒，并行后 33.2。local 和 Qdrant 没有版本机制

### Q14. 做语义缓存了吗？阈值多少？0.97 安全吗？为什么默认关？

*L4 边界 / 规模 / 重做*

- 做了：进程内 LRU，在拿到查询向量之后、检索之前查，不多调一次模型
- 键含租户、文档内容版本、索引版本、prompt 指纹、模型、检索计划形状、配置指纹；缓存拿到的是原始查询向量，键里取当前加载的适配器文件指纹，同一路径换成重训文件后换键并清掉旧条目（2026-10-18 修复）
- 命中要余弦 ≥0.97，并且过词法守卫（否定及其位置、数字、比较符、实体、介词、情态；非拉丁文字要逐字一致）
- 留出 confirm 集误命中 0/59（旧守卫 25/59），改写命中 11/17
- 不缓存拒答；文档变动立即失效

代码：`server/rag/semantic-cache.js lookupSemanticCache`；`server/rag/semantic-cache-guard.js compareCacheQuestions`

> ⚠ 别说"已证明安全"或"0 误命中"：confirm 集是守卫作者写的，不是盲测；95% 上界 5% 还假设样本相互独立。每次命中省 1.35 s 是旧守卫在无争用时测的

### Q15. 如果数据量放大 100 倍（上亿分块、上千租户），哪里先坏？怎么改？

*L4 边界 / 规模 / 重做*

- 已测到 100 万分块单库（合成数据，关 fsync）：冷读 p95 111 ms，HNSW 构建 169 s，写 50 块 p50 从 203 涨到 513 ms
- 先坏的地方：单库容量和 HNSW 内存；对比路径每篇文档各跑两条 SQL；删除要展开 tsvector；进程内缓存的命中率随实例数下降
- 方向：按 workspace 分区或分库（RLS 本来就是这个维度）；大租户用索引版本机制迁到专用引擎
- 检索层已经能独立扩缩；读副本已实现但收益有限；halfvec 或量化没做；HNSW 参数要用真实 embedding 重测

代码：`server/rag/vector-store.js searchDocumentsPerDocumentWithRoutes`；`server/rag/document-rag-execution.js retrieveGlobalContextForQueries`

> ⚠ 别说"已支持亿级"。读副本实测主库语句只减少 28.8%，没达到 30% 的目标，吞吐也没变快。拆分部署只在单机上测过

### Q16. 如果重做这个子系统，你会改什么？

*L4 边界 / 规模 / 重做*

- 一开始就在 pgvector 路上跑效果评测，而不是在 standalone 本地 store 上
- 中文：现在是 'simple' 配置加单字切分，没有分词；应该接 zhparser 或 IK，并建中文评测集
- 更早接真实 embedding 和外部标注集（伪 embedding 给出过错误的排序）
- 切块重叠要限长，避免超长块和三分之一的重复文本
- 融合权重和 RRF k 先在 train 上调过再定
- 端到端瓶颈在门控而不是召回，应该更早投入"答不答"的信号

代码：`server/rag/config.js getHybridDenseWeight`；`server/rag/chunker.js buildOverlapParagraphs`；`server/standalone-profile.js applyStandaloneProfile`

> ⚠ 每条都要挂到已有数据上，别说成"全推倒重来"；也别说中文已经做好了

## 可以引用的数字

| 说什么 | 数字 | 出处 | 前提 / 注意 |
| --- | --- | --- | --- |
| QASPER dev Top-5 召回：hybrid / dense / BM25 | 0.517 / 0.511 / 0.442；hybrid−BM25 +0.074 [+0.048, +0.102] 显著，hybrid−dense +0.006 [−0.019, +0.031] 不显著 | CURRENT-TRUTH 3.1；docs/evaluation.md "QASPER：外部标注的检索和答案评测" | 821 题、按段落、nomic-embed-text、local store（standalone 档 BM25）、2026-09-25；只能说比单用 BM25 好 |
| 自建 48 条 arXiv 用例 Recall@5（真实 embedding） | hybrid 0.712、dense 0.654、BM25 0.658；全量差异都不显著；伪 embedding 下 hybrid 只有 0.543 | CURRENT-TRUTH 3.1 | 样本小、CI 跨 0，不能当"提升" |
| nomic 任务前缀对证据召回 | dev 证据进入候选 0.648→0.692，+0.044 [+0.021, +0.067]；第 1 名 +0.029，前 3 名 +0.033 | CURRENT-TRUTH 3.1；evaluation.md "检索召回：embedding 任务前缀" | 答案 F1 0.231→0.235 不显著；只测了 nomic-embed-text |
| 门控损失 | 约 69% 的证据在候选里，默认门控只放行约 24% | evaluation.md "检索召回：embedding 任务前缀" | 门控属于答案子系统；QASPER 的改写式提问不一定代表合同和政策文档 |
| 判定和上下文分开（selectQaContext） | 证据进入模型上下文 0.245→0.353，+0.108 [+0.088, +0.130]；F1 0.235→0.249，+0.014 [−0.000, +0.029] | CURRENT-TRUTH 3.1；evaluation.md "门控：判定和上下文分开" | F1 区间下限贴着 0，不说显著；"上下文指标"不等于引用 |
| 交叉编码器重排（bge-reranker-v2-m3） | 上下文证据 0.353→0.417，+0.063 [+0.044, +0.085]；F1 +0.008 不显著；可回答题拒答 42.2%→37.8%，−4.4pp [−7.7, −1.7] | CURRENT-TRUTH 3.14a；evaluation.md "交叉编码器重排" | 200 题答案、qwen2.5:7b；需要单独服务，默认关；权重 0.6 在 train 上选 |
| 重排概率做门控 | AUC 0.641（词面 0.588）；可回答题拒答 37.8%→13.9%；不可回答题识别 80%→45% | CURRENT-TRUTH 3.14b；evaluation.md "重排概率做拒答门控" | F1 0.257→0.261 不显著；不可回答题只有 20 道，−35pp 的区间 [−61.5, −9.5] 很宽；用不可回答题识别率换取少拒答 |
| BM25 对比 ts_rank_cd（hybrid 路） | dev 证据召回 0.6931→0.6918，−0.0012 [−0.0122, +0.0097] | CURRENT-TRUTH 3.18 | 不显著，也没达到 −0.01 非劣性下界；默认 bm25 是用户决定；这条是在 pgvector 路（eval:sparse-scoring）上测的 |
| 常见词剪枝的延迟 | 10 万分块、2000 篇、RLS、全表：100 条混合查询中含常见词的 11 条，ts_rank_cd p50/p95 135/180→39/49 ms，BM25 281/389→40/51 ms；100 条整体 ts_rank_cd p95 135→73 ms；QASPER hitAtAll 差 0 [0, 0] | CURRENT-TRUTH 3.18；docs/retrieval-tuning.md「BM25 与常见词剪枝」→「实测」 | 纯常见词查询前 10 条只和穷举重合 32–41%（ts_rank_cd；BM25 单个常见词 29%、三个 95.7%）；合成数据 bench |
| BM25 统计触发器的写入代价 | 一次 50 块入库 p50 336 vs 317 ms（约 6%）；同一作用域 4 个写入方 10.4 vs 11.1 篇/秒；删除每 1000 块 25 ms vs 4.4 ms | server/db/migrations/030_create_sparse_bm25_statistics.sql 头注释；docs/retrieval-tuning.md「BM25 与常见词剪枝」→「实测」的"写入代价" | scale bench，一次性集群，关 fsync |
| pgvector 规模 | 100 万分块 10.4 GB，HNSW 构建 169 s，单文档 dense p95 0.91 ms，100 篇 hybrid p95 21.2 ms（热）、首次读 111 ms | CURRENT-TRUTH 3.15；evaluation.md "pgvector 规模" | 合成 768 维、本机一次性集群、关 fsync；100 篇的检索没走 HNSW |
| HNSW iterative scan | 1 万分块、文档集占半表：9.95/10→10/10，recall 0.994→1.0，每次多 0.04–0.17 ms | CURRENT-TRUTH 3.15 | 10 万分块、1000 篇时 0.898→0.912，在波动范围内，不算改进 |
| RLS 下全文检索修复（迁移 014） | 10 万分块、1000 篇：sparse p50/p95 142/157 → 19/58 ms | CURRENT-TRUTH 3.15；evaluation.md "全文检索与行级安全" | 这是 ts_rank_cd 路径；全表时 p95 不变；现在默认 BM25 走 030 的 _sparse_search |
| 零停机切换索引版本 | 建、校验、切换、回滚全程 0 错误（两轮 8,749 / 9,844 次 /chat）；切换命令约 235 ms；2 s 内所有实例跟上 | CURRENT-TRUTH 3.16 | 单机 2 实例、假模型、200 篇；1536→768 维 |
| 按激活版本做查询 / 并行建版本 | 每个 /chat 3.98→2.01 次 embedding，吞吐降幅 28.4%→1.4%；建版本 8.57→33.2 篇/秒 | CURRENT-TRUTH 3.17 | 关查询缓存、embedding 100 ms 的模拟 |
| Docling 整份解析 | 69 道表格题 F1 0.159→0.180，+0.020 [−0.011, +0.057]；30 篇解析 350 s vs 1.4 s | CURRENT-TRUTH 3.14；evaluation.md "版面解析" | 不显著；Docling 那一臂用的是跨页拆分修复之前的页码归属 |
| PDF_PARSER=auto | 送 105/266 页（39%）给 Docling；总耗时 252–279 s vs 整份 330 s；表格题 F1 +0.008 [−0.031, +0.053]，全部题 +0.005 [−0.020, +0.032] | docs/evaluation.md "按页分流和并行解析" | docling-serve-cpu 1.37、qwen2.5:7b、30 篇、149 题；阈值就是在这批论文上定的；CURRENT-TRUTH 3.31 也收录了 |
| pdf.js worker 池 | 38 个 PDF 同时解析：进程内 0.79–0.96 s，4 worker 0.30–0.48 s；主线程最长停顿 21–33 ms vs 7–9 ms；逐个解析没有收益 | docs/evaluation.md "按页分流和并行解析" | 本机 15 CPU；默认 PDF_PARSE_WORKERS=0 |
| 段落识别 | 每页行数 65.6→31.3；从句中开始的块 12.8%→5.3%；F1 −0.0001 [−0.0185, +0.0204]；183/2338 个块超过 900 字符（最长 1910） | CURRENT-TRUTH 3.26；docs/evaluation.md "pdf.js 段落识别" | 改成默认开的理由是没有显著变差，不是测出了提升；CURRENT-TRUTH 把 CI 四舍五入成 [−0.019, +0.020] |
| 切块丢字修复 | 55 份 PDF 丢 7,866 个非空白字符（612 段、28 份文档）→ 0 | CURRENT-TRUTH 3.25 | 只说消除丢字，不宣称检索变好 |
| 按句子装块 | dev 前三名命中 −0.027 [−0.050, −0.004]，显著更差；候选覆盖 +0.004 [−0.017, 0.026] | CURRENT-TRUTH 3.27；evaluation.md "按句子装块" | train 上的显著增益在 dev 上没有复现 |
| 查询适配器 | hybrid 证据进入候选 0.6918→0.7381，+0.0463 [+0.0244, +0.0694]；F1 0.2576→0.2562，不显著 | CURRENT-TRUTH 3.18 | QASPER + nomic 专用；dense-only 下前三名 −0.032 |
| 语义缓存 | 留出 confirm 集误命中 0/59（旧守卫 25/59，单侧 95% 上界 5%）；改写命中 11/17；每次命中省约 1.35 s [0.65, 2.19] | CURRENT-TRUTH 3.18；docs/retrieval-tuning.md | 省时数字是旧守卫、无争用、n=26；confirm 集不是盲测；默认关；别说成"0 误命中" |
| 代码默认值 | 切块 900/180；topK 6；sparse topK 8；RRF k=60，权重 0.65/0.35；rerank ×3、权重 0.6；稀疏查询最多 64 个词；剪枝门槛 1000 块、DF 比例 0.1、常见词候选上限 2000；HNSW m16/efc64；指针 TTL 2 s；双写 24 h；DOCLING_MAX_CONCURRENCY 2；每任务 32 页；语义缓存阈值 0.97 | server/rag/config.js getChunkSize / getRetrievalTopK / getRrfK / getHybridDenseWeight / getRerankWeight / getPgvectorHnswM / getIndexVersionPointerTtlMs / DEFAULT_SEMANTIC_CACHE_THRESHOLD / DEFAULT_SPARSE_COMMON_TERM_CAP；sparse-query-terms.js SPARSE_MAX_QUERY_TERMS；vector-store-pgvector-sparse.js PGVECTOR_SPARSE_PRUNE_MIN_CHUNKS | rerank 权重 0.6 是在 train 上选的（3.14a），其余多数是默认值，不是调出来的最优值 |

## 要主动说出口的边界

- 检索效果数字（QASPER 检索和答案、前缀、查询适配器、句子切块、版面解析、语义缓存）都是在 standalone 本地 store 上测的：精确余弦 + 内存 BM25，统计跨整个语料。生产默认的 pgvector 路只有 eval:sparse-scoring 单独测过召回
- 只测过一个 embedding 模型（nomic-embed-text）和一个 7B chat 模型（qwen2.5:7b），没有 GPT 级模型和生产流量
- hybrid 只显著好于单用 BM25，和纯稠密没有显著差异；自建 48 条用例上的差异都不显著
- QASPER 答案数字测的是 MCP/RAG 路径。/chat 的 agent 路径有自己的检索计划（fact 意图 topK 4，另加模板子查询），查询适配器在那里也不生效；这条路径的检索召回没有单独评测（--surface agent 只测过答题率）
- RRF 权重 0.65/0.35 和 k=60 是默认值，没找到调参证据；查询分解和 agent 模板子查询的收益无实测
- 默认改用 BM25 是产品决定，数据只说明没有显著差异
- 中文：全文检索配置是 'simple'，没有词干、没有分词，中文按单字切；没有中文检索评测集
- 默认只读 PDF 文本层，Docling 和 auto（含 OCR 路由）都是 opt-in。auto 的阈值就是在评测那 30 篇论文上定的；OCR 只用一份人工扫描件验证过；没在真实扫描档案、乱码文字层、GPU 或别的 docling-serve 版本上测过
- structured 切块的块会超长：183/2338 超过 900 字符（evaluation.md 段落识别一节；按句子装块一节记作 17.9%，口径不一致）。块文本是页面文本的 1.48 倍，约三分之一重复；切块重叠还没限长。findUnindexedPageText 按 token 集合检查，重复词丢失看不出来
- 100 篇以上文档集的检索走 doc_id 精确扫描，不是 HNSW。整表 HNSW 召回在合成数据上随规模下降（100 万时 0.495，是压力场景，不是应用路径）。没测过真实 embedding 下的 HNSW 召回，也没测检索和写入并发时的延迟
- 对比路径每篇文档各跑两条 SQL，文档多时线性增长
- 交叉编码器只记过一个粗略延迟（本机 MPS 上 18 个候选约 0.4 s），没有系统压测；compose.rerank.yml 的镜像没有构建过
- 语义缓存只在进程内，多实例时命中率低；守卫没有盲测过
- 查询适配器只对 QASPER + nomic 有效，换语料或模型要重训；对答案 F1 没有收益
- local 和 Qdrant 是单租户 store，没有索引版本，也不受 RLS 保护
- run-retrieval-comparison.mjs 的报告说明 2026-10-18 起写为"pgvector 稀疏路默认 Okapi BM25（可选 ts_rank_cd），由 eval:sparse-scoring 测量"；本机已有的 latest-retrieval-comparison*.md 是改之前生成的，仍写 ts_rank_cd，引用旧报告时要注意

## 只能当推理讲的内容

核验代理找不到代码或数据依据的条目。讲的时候用「我的判断是……，没测过」。

- pgvector 规模 bench 的机器型号（原材料写"单机 M5 Pro"）：evaluation.md "pgvector 规模"没写机器，已改成"本机一次性集群"
- structured 切块超长比例：evaluation.md 两节分别记 183/2338（≈7.8%）和 17.9%，口径不一致，查不清哪个对；材料改为优先引用 183/2338 并注明分歧
- RRF 权重 0.65/0.35 与 k=60 的调参依据：evaluation.md、retrieval-tuning.md、run-param-sweep.mjs 里都没找到调参记录，只能说是默认值
- 交叉编码器在 CPU 镜像（compose.rerank.yml）下的延迟：没有任何实测，只有本机 MPS 上"18 个候选约 0.4 秒"的粗略值
- "整段块排名更好"的原因解释（QASPER 一页恰好一个证据段）：evaluation.md 是推测性解释，不是对照实验

## 容易记错的地方

第一遍阅读（主要依据 AGENTS.md 和文档）写错、被核验代理对照代码改正的说法。这些正是读文档容易产生的误解。

- **elevatorPitch**
  - 原以为：并有检查保证一个字都不丢……Docling、按句子切块、查询适配器、语义缓存这些"高级选项"都做了也测了，没有显著收益或代价太大，所以默认关闭。（共约 8 句）
  - 实际：改成"用 findUnindexedPageText 逐页检查丢字，55 份 PDF 丢字 7,866→0"。改成"交叉编码器和查询适配器在检索层有显著收益，答案 F1 却不显著；Docling/auto、按句子切块、语义缓存要么没有显著收益，要么代价太大"。零停机切换加上"单机 2 实例、假模型压测下"。
  - 依据：chunker.js findUnindexedPageText 是 token 集合检查（AGENTS.md 和本材料 limitations 都说重复词丢失查不出），"保证"说过头了。CURRENT-TRUTH 3.18：适配器证据进候选 +0.0463，CI 不含 0；3.14a：重排上下文证据 +0.063，显著。这两项检索层显著，不能归为"没有显著收益"。3.16：压测是 2 实例、假模型。
- **keyFiles: server/rag/query-adapter.js；decisions[查询适配器].tradeoff**
  - 原以为：adaptQueryVectorForSearch 不满足条件时退回未适配，不报错／文件坏了或空间不匹配时只告警、退回未适配
  - 实际：检索时退回未适配并告警一次；健康检查 checks.queryAdapter 对不可读或无效的文件报 error（严格启动时会拒绝启动），对空间不匹配报 warning。另补上"恰好一篇文档""Qdrant 不支持"两个生效条件
  - 依据：query-adapter.js 头注释："A missing or broken file, or one trained for another space, leaves searches unadapted with a warning; checks.queryAdapter in the health report fails startup on the first and warns on the rest"、"over exactly one document"；retrieval-tuning.md「查询侧 embedding 适配器」→「做法」的"生效范围"：Qdrant 不支持
- **keyFiles: 014_create_sparse_rank_function.sql、vector-store-pgvector.js；decisions[RLS 下全文检索]**
  - 原以为：行级安全下的多文档全文检索改走 SECURITY DEFINER 排序函数（迁移 014，033 加固）
  - 实际：思路不变，但现在默认 BM25 一律走 030 的 <t>_sparse_search（单文档和多文档都走）；014 的 _sparse_rank 只在 ts_rank_cd 且关剪枝的多文档租户查询里用。codeRef 补上 vector-store-pgvector-sparse.js usesPgvectorSparseSearchFunction / buildPgvectorSparseSearchSql
  - 依据：vector-store-pgvector-sparse.js：usesPgvectorSparseSearchFunction = scoring===bm25 || (pruneDfFraction!==null && docCount>1)；buildPgvectorSparseSearchSql 注释写"One statement for every caller, tenant or owner, one document or many"；vector-store-pgvector.js searchPgvectorSparseDocuments 只在不走函数时才用 buildTenantSparseSearchSql
- **decisions[常见词剪枝].evidence**
  - 原以为：纯常见词的题只有 3/19 道
  - 实际：纯常见词的题 train 只有 3 道、dev 只有 19 道
  - 依据：docs/retrieval-tuning.md「BM25 与常见词剪枝」→「实测」："只含常见词的题只有 3 题（train）和 19 题（dev）"
- **decisions[结构化切块].tradeoff；questionLadder 切块题；limitations**
  - 原以为：整段重叠让 17.9% 的块超过 900 字符（最长 1910）
  - 实际：evaluation.md 段落识别一节记的是 183/2338 个块超过 900 字符（最长 1910），按句子装块一节记的是"超出块大小 17.9%"，两处口径不一致；面试时优先引用 183/2338，并说明出处
  - 依据：evaluation.md "pdf.js 段落识别"表：超过 900 字符的 chunk 183（最长 1910），chunk 数 2338；"按句子装块"表：S0 超出块大小 17.9%；AGENTS.md：183 of 2,338。183/2338≈7.8%，和 17.9% 对不上
- **decisions[交叉编码器].tradeoff；questionLadder rerank 题 trap；limitations**
  - 原以为：延迟没有系统测过（别报数字）
  - 实际：只记过一个粗略值：本机 Apple MPS 上一次 18 个候选约 0.4 s，没有系统压测，CPU 镜像下的延迟没测
  - 依据：docs/evaluation.md "交叉编码器重排"："跑在本机 Apple MPS 上，一次 18 个候选约 0.4 秒"
- **decisions[交叉编码器].evidence；numbers 代码默认值 caveat**
  - 原以为：多数是默认值，不是调出来的最优值
  - 实际：补上"rerank 权重 0.6 是在 train 上按事先定的指标选的（3.14a）"
  - 依据：CURRENT-TRUTH 3.14a："混合权重 0.6。权重在 train 上选定"；evaluation.md train 选权重表
- **questionLadder Q4（BM25 统计）**
  - 原以为：029 加 sparse_length（BEFORE 行触发器填）；030 给每个版本表建 scope 和 term 统计
  - 实际：029 加 sparse_length 列；030 装 BEFORE 行触发器来填它，并建统计表
  - 依据：029_add_chunk_sparse_length.sql 头注释："Migration 030 installs the BEFORE row trigger that sets it"；030 头注释 <t>_sparse_length BEFORE row trigger
- **questionLadder 若干 codeRefs**
  - 原以为：server/rag/vector-store-pgvector-sparse.js（无名字）；server/rag/vector-store-qdrant.js（无名字）；server/rag/langgraph/retriever.js（无名字）；server/standalone-profile.js（无名字）
  - 实际：分别改为 PGVECTOR_SPARSE_TABLE_SUFFIXES / buildPgvectorSparseSearchSql；searchQdrantDocuments（另加 server/health.js single_tenant_vector_store）；ArchiveRagRetriever；applyStandaloneProfile
  - 依据：grep 到 export 名：vector-store-pgvector-sparse.js、vector-store-qdrant.js L623、langgraph/retriever.js L200 class ArchiveRagRetriever、standalone-profile.js L137、health.js L494
- **questionLadder LangChain 题 trap**
  - 原以为：030 迁移有 700+ 行 PL/pgSQL
  - 实际：030 迁移一个文件约 760 行（含大段注释）
  - 依据：wc -l 030_create_sparse_bm25_statistics.sql = 761，头部约 80 行是注释
- **questionLadder Docling 题**
  - 原以为：pdf.js 也能抽出 91% 表格题的答案原文
  - 实际：23 道抽取式表格题里，pdf.js 也能抽出 91% 的答案原文
  - 依据：evaluation.md "版面解析"表：标注答案原文出现在解析文本里 0.913（n = 23）
- **questionLadder 评测题、decisions[RRF].why**
  - 原以为：质量门检查每个 case 的 retrieval provenance：两路都执行、没有 fallback
  - 实际：质量门检查 retrieval provenance：路由确实执行了，和 manifest 一致
  - 依据：AGENTS.md："quality:current and the robust gate fail when it disagrees with the manifest or when a route did not actually run"，没提到 fallback
- **questionLadder rerank 题**
  - 原以为：用重排概率做门控时 AUC 0.641 vs 0.588……不可回答题识别从 80% 降到 45%
  - 实际：补上"开重排时默认用它（阈值 0.02）"和"只有 20 题"
  - 依据：CURRENT-TRUTH 3.14b："开重排时默认用它"；evaluation.md：不可回答题识别 −35pp [−61.5, −9.5]，样本只有 20 题
- **questionLadder 规模题；numbers pgvector 规模 caveat**
  - 原以为：合成 768 维、单机 M5 Pro、关 fsync
  - 实际：合成 768 维、本机一次性集群、关 fsync；规模题的写入数字也标上关 fsync
  - 依据：evaluation.md "pgvector 规模"写了"集群设置：关闭了 fsync"，但没写机器型号；CURRENT-TRUTH 3.15 里的 M5 Pro 属于 API 压测的环境说明
- **questionLadder 语义缓存题 trap；numbers 语义缓存**
  - 原以为：留出集误命中 0/59
  - 实际：留出 confirm 集误命中 0/59，单侧 95% 上界 5%（假设独立）；别说成"0 误命中"
  - 依据：docs/retrieval-tuning.md「语义答案缓存」→「结论与局限」："引用误命中数字时要写明是'类内对照'和'留出集 confirm'，不能写成'0 误命中'"；同节「实测」："confirm 集由守卫作者在重建守卫之后编写"
- **decisions[语义缓存].decision**
  - 原以为：键覆盖租户、文档内容版本、索引版本、prompt 指纹、模型和配置
  - 实际：键里有一项适配器指纹。2026-10-18 修复前它从查询向量取，而缓存拿到的是模型原始向量，所以恒为 "no-adapter"；适配器只经配置指纹里的路径进入键，同一路径换文件后键不变。现在这一项取当前加载的适配器文件指纹，同一路径换文件后换键并清掉旧条目；存入前还核对检索实际用的适配器指纹。（第一轮核验写的"补上查询适配器指纹"不对，已改）
  - 依据（修复前）：semantic-cache.js 里 getQueryVectorAdapterFingerprint(queryVector) ?? "no-adapter" 拼进 spaceKey；现在是 getQueryAdapterReportFingerprint() ?? "no-adapter"，传入的是 embedQueryCached 的原始向量；query-adapter.js 只给 applyQueryAdapter 产出的向量记指纹（adaptedVectors），由 vector-store.js 调 adaptQueryVectorForSearch；embedding-cache.js buildCacheKey 注释："The cache holds the model's own vectors only"；semantic-cache.js CONFIG_ENV_PREFIXES 含 RAG_；docs/retrieval-tuning.md「语义答案缓存」→「结论与局限」末条
- **numbers 段落识别 source**
  - 原以为：CURRENT-TRUTH 3.26
  - 实际：CURRENT-TRUTH 3.26；docs/evaluation.md "pdf.js 段落识别"（精确 CI 出自后者，CURRENT-TRUTH 四舍五入成 [−0.019, +0.020]）
  - 依据：evaluation.md 表：−0.0001 [−0.0185, +0.0204]；CURRENT-TRUTH 3.26：[−0.019, +0.020]
- **limitations（agent 路径）**
  - 原以为：这条路径的检索没有单独评测
  - 实际：这条路径的检索召回没有单独评测（--surface agent 只测过答题率）
  - 依据：evaluation.md "Agent 答题率开关（QASPER train，--surface agent）"测的是答题率，不是检索召回
- **questionLadder 检索默认题**
  - 原以为：sparse topK 8、dense 取 max(topK, 8)
  - 实际：sparse topK 取 max(topK, 8)，dense 取 max(topK, sparseTopK)
  - 依据：vector-store.js searchHybridDocumentsWithRoutes：sparseTopK = Math.max(topK, getSparseRetrievalTopK())；denseTopK = Math.max(topK, sparseTopK)
- **staleInExistingDocs**
  - 原以为：INTERVIEW-FAQ #10 "完全反过来"写成过时；retrieval-tuning.md 一处写"推荐为调优配置"
  - 实际：#10 改成"说过头，不是过时"。retrieval-tuning.md 已重写，那几句旧原文都不在了：「查询侧 embedding 适配器」→「结论与局限」撤回了"推荐为调优配置"，适配器只是默认关的可选检索设置；同节「做法」写明查询 embedding 和查询向量缓存只存模型原始向量（适配器不进查询向量缓存的 key），空间不一致时退回未适配、健康检查报 warning，不是直接报错。新增三条 AGENTS.md 过时项：PGVECTOR_BM25_PRUNE_MIN_CHUNKS 的名字、多文档租户稀疏检索走 _sparse_rank 的说法、planDoclingBatches 的位置（AGENTS.md 现已改正这三处）
  - 依据：docs/retrieval-tuning.md「查询侧 embedding 适配器」的「做法」和「结论与局限」；query-adapter.js adaptQueryVectorForSearch 空间不一致时 skip("space_mismatch")，describeQueryAdapterHealth 记 warning；embedding-cache.js buildCacheKey 注释；grep：PGVECTOR_BM25_PRUNE_MIN_CHUNKS 在代码里 0 次（代码是 PGVECTOR_SPARSE_PRUNE_MIN_CHUNKS）；pdf-page-router.js L120 export planDoclingBatches；vector-store-pgvector-sparse.js usesPgvectorSparseSearchFunction
- **requestFlow**
  - 原以为：commitDocument → prepareDocumentsForIndex（…）→ 同一事务内：beginVectorIndexWrite / lockIndexVersionWriteTargets …
  - 实际：标明 prepareDocumentsForIndex 在 vector-store.js、在事务外完成；事务内的顺序是 beginVectorIndexWrite → registerDocument → writeDocumentsToPgvectorIndex；auto 入口是 loadPdfPagesAuto → loadPdfPagesWithRouting；rerankResultsOrKeepOrder 在 global-retriever 里调用
  - 依据：rag/index.js L432 prepareDocumentsForIndex 在 L497 beginVectorIndexWrite 之前；L555 registerDocument；pdf-loader.js 里 auto 分支调 loadPdfPagesAuto；global-retriever.js 在 searchDocumentsWithRoutes 之后调 rerankResultsOrKeepOrder
