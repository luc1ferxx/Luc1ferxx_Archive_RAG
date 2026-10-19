# 索引版本与分阶段入库

本文讲两件事：

- pgvector 索引版本：零停机重建、双写、构建、激活门、切换、回滚和退役。
- 异步入库流水线：分阶段执行、按阶段重试、死信、跨文档合批、去重和文档替换。

压测汇总见 `docs/evaluation.md` 的"索引切换与入库流水线"和"按激活版本做查询、并行建版本"。本文"测量"一节写了这些数字的前提和适用范围。

## 索引版本：零停机重建 pgvector 索引

只适用于 `VECTOR_STORE_PROVIDER=pgvector`（默认）。`local` 和 `qdrant` 仍然只有一份索引，没有版本、双写、切换和回滚。`npm run vector:index` 直接拒绝这两个 provider，它们继续用 `npm run vector:reindex` 原地重写。

### 数据模型（迁移 016、019）

- `rag_index_versions`：每个版本一行，包括：
  - `version_id`；
  - `status`：building / ready / active / retired / failed；
  - 物理位置：`chunk_table`、`sparse_rank_function`；
  - 嵌入空间：`embedding_space_source`、`embedding_model`、`embedding_identity`、文档/查询前缀、`embedding_dimensions`；
  - `index_params`：hnsw/ivfflat 参数和全文检索配置；
  - 行数与构建进度：`document_count`、`chunk_count`、`build_documents_*`；
  - 构建租约：`builder_id`、`lease_expires_at`；
  - `dual_write_until`、`last_error` 和各阶段时间戳。

  部分唯一索引保证任何时候最多一个 active 版本、一个 building 版本。
- `rag_index_versions_pointer`：唯一的活动指针，字段为 `active_version_id`、`previous_version_id`、`generation`、`switched_at`，迁移 019 加了 `pointer_ttl_ms`（见"指针缓存"）。
- `rag_index_versions_build_progress`：每个文档一行，和该文档的 chunk 在同一个事务里提交。它列出所有租户的 doc_id，所以租户角色没有任何权限，只有 owner（和迁移 035 的系统角色）能访问。
- 升级时，现有的 `rag_document_chunks` 原地登记为版本 1，一行也不移动，指针指向它。
  - 被别的版本替换之前，版本 1 一直"跟随配置"，行为和原来的单表一样：空表可以按新宽度 resize，混入其他模型的 chunk 时 fail closed，`vector:reindex` 原地重写。
  - 第一次激活其他版本时，版本 1 被固定（pin）在它验证过的嵌入空间上。之后回滚到版本 1，不再受配置变化影响。
- 租户角色对注册表和指针只有 SELECT：写事务要在自己的事务里读取写目标，但不能改它们。这两张表不含租户数据，所以没有行策略。

### 每个版本的物理表

表名为 `<DOCUMENT_CHUNKS_POSTGRES_TABLE>_v<N>`，由 owner 在运行时创建（开了角色拆分时走 owner 连接池）。DDL 由 `renderIndexVersionChunkTableDdl` 渲染迁移的同一套模板，和登记行在同一个事务里提交：

- 迁移 012 的 chunk 表，带本版本宽度的 `vector(N)` 列、HNSW（或 IVFFlat）索引、GIN 索引和指向文档表的级联外键；
- 迁移 013 的 `tenant_isolation` 行策略和租户 GRANT；
- `<表名>_sparse_rank` SECURITY DEFINER 函数：先渲染迁移 014 的模板，再在同一条语句里由迁移 033 的安装函数换成按文档策略过滤 doc id 的版本，PUBLIC 不可执行；
- 迁移 030 的 BM25 统计表、触发器和 rank 函数，用本版本的全文检索配置；
- 迁移 035 的系统角色授权和 `system_access` 策略。

所有标识符都经过校验，包括派生出来的索引、约束和函数名，并确认不超过 63 字节。版本号从不复用，所以用 `CREATE TABLE`，不用 `IF NOT EXISTS`。宽度超过 2000 维的列建不了 ANN 索引，在任何 DDL 之前就拒绝。

### 写路径：双写

每个 ingest、替换、delete、clear 事务（以及移入回收站、恢复、清理回收站和租户擦除）的第一步是 `beginVectorIndexWrite`：先拿事务级共享 advisory 锁，再用单独一条语句读出写目标。写目标包括：

- 活动版本；
- 正在构建的版本；
- 已构建完成、尚未激活的版本；
- 被替换后仍在宽限期内的旧活动版本。

注册新版本、切换指针、退役版本时持有同一把锁的排他模式。所以构建者的快照（注册提交之后才列出文档）和写入者看到的目标集合之间没有缝隙。

锁顺序固定，不会形成环：

- 生命周期操作（注册、切换、退役）：指针行 → 版本行 → advisory 锁（排他）→ DDL；
- 写入者（ingest、替换、删除、clear、`vector:reindex`）：先拿 advisory 锁（共享），再锁文档行，最后才碰 chunk 行。ingest 先登记文档行；替换、删除和 `vector:reindex` 先对文档行加 `FOR UPDATE`。删除以前先删各版本表里的 chunk、再删文档行，和构建者的顺序相反，遇到构建者正在重写同一篇文档时会死锁；
- 构建者不拿 advisory 锁：文档行（`FOR SHARE`）→ 该文档的 chunk 行 → 版本行（续租）→ 进度行；
- 上传失败时的 fence 和接管租约（claim）只锁版本行。

生命周期事务锁住的版本行，不会是构建者正在等的那一行：激活锁的是 active 和 ready 版本；退役在自己的事务开始前，先把它能中止的构建单独标成 failed（见"回滚与退役"）。

嵌入在事务外计算，每个嵌入空间算一次，活动版本的空间优先。加锁后如果读到一个新注册、嵌入空间不同的版本，就在事务内补算。这种情况很少，但保证正确。

非活动的写目标是尽力而为：

- 上传在某个空间嵌入失败时，`fenceFailedWriteSpace` 把这个空间里所有非 active 的 building/ready 版本标成 failed（写入 `last_error`），上传照常写入 active 版本。
- fence 在上传的写事务打开之前、在单独的事务里执行，`lock_timeout` 为 2 s。
- failed 版本不能再被激活或回滚到。
- active 版本自己的空间嵌入失败时，上传照原样失败。

删除、替换和 clear 还会清掉那些已不是写目标、但表还在的版本里该文档的 chunk：failed 版本、宽限期外的 ready 版本、还没删表的 retired 版本。没有搜索读这些表，但它们仍存着文档原文。

### 构建：可恢复、带租约、并行

```
npm run vector:index -- build [--model M] [--dimensions N] [--document-prefix P] [--query-prefix Q]
    [--index-type hnsw|ivfflat] [--hnsw-m] [--hnsw-ef-construction] [--ivfflat-lists]
    [--text-search-config] [--batch-size] [--concurrency] [--lease-ms]
```

- 创建版本时，在任何 DDL 之前先用新空间嵌入一条探测文本并校验宽度。模型不可用、密钥被拒、`--dimensions` 与模型实际输出不符时直接报错，不登记任何版本。
- 构建从文档注册表保存的 PDF 字节重新解析、分块（加密存储的字节先按该行的属主解密），再用新版本自己的模型嵌入。chunk 带上文档当前的 `documentVersion`。
- 同时处理的文档数：`RAG_INDEX_VERSION_BUILD_CONCURRENCY`（默认 4）。CLI 用 `--concurrency`，build 和 resume 都能用。
- 待处理文档按 `RAG_INDEX_VERSION_BUILD_BATCH_SIZE`（默认 16）一页一页列出：
  - 游标只往前走，每个文档只取一次；
  - 一页的文档全部结束后，才刷新进度计数、续租、打印进度，页与页按列出的顺序完成；
  - 并发为 1 时，和原来的串行构建一样。
- 嵌入走入库流水线的跨文档合批器（`rag/ingest-embedding-batcher.js`，本进程的默认实例），向量仍按版本宽度校验：
  - 遵守 `RAG_LLM_MAX_CONCURRENCY`（设了 `RAG_LLM_INGEST_MAX_CONCURRENCY` 时用它）；
  - 只有上限小于同时处理的文档数时才会有文档排队，排队的文档再合并成一个请求。默认配置（4 篇在处理、上限 8）下每篇文档单独一个请求；
  - `RAG_INGEST_EMBED_BATCHING=false`（入库的合批开关）对构建同样生效：每篇文档单独一个请求。
- 每个文档一个独立事务，依次执行：
  1. 对文档行加 `FOR SHARE`，确认 `uploaded_at` 和 `content_version` 没变；
  2. 替换该文档的 chunk；
  3. 续租：`UPDATE` 版本行，条件是 `builder_id` 和 `status = 'building'`。租约被接管、或版本已被 fence 或退役时，整个事务回滚；
  4. 写进度行。

  版本行只在续租到 COMMIT 这一小段被锁住，所以不同文档的 chunk 写入可以并行，上传失败时的 fence 也最多等几次提交，不用排在整篇文档的写入后面。最初续租是事务的第一条语句，版本行从头锁到提交：4 个文档并行时写事务一个接一个执行，fence 排在整篇文档的写入后面，2 秒的 `lock_timeout` 可能等不到，上传就会失败。
- 各种情况的处理：
  - 文档在读取后被删除：记为 `skipped_deleted`，不会复活。外键级联同样作用于所有版本表。
  - 回收站里的文档（迁移 042）不列入待处理。恢复时由恢复本身写入正在构建的版本，因为它也是写目标。
  - 文档在读取后被重新上传或替换：重新读取，最多 3 次。
  - 解析失败、没有可提取的文本：只把该文档记为 failed，构建继续。
  - 保存的 PDF 解不开或读不出（`TENANT_*` 错误码：密钥被单独的 `tenant:keys destroy` 销毁、字节被改、字节只是看起来像信封）：该文档记为 failed，进度错误以 `unreadable_source <CODE>:` 开头，构建继续，摘要里计入 `unreadable`。
  - 嵌入宽度和声明不符：版本标记为 failed。
  - 租约丢失：构建停止，不改版本状态。
  - 其他错误（嵌入服务不可用、数据库断开）：释放租约，版本保持 building。
- 出错时，第一个错误出现后不再领取新文档；已在处理的文档各自提交或回滚，全部结束后才释放租约或把版本标成 failed。所以不会在还有写入时交出租约。
- 同一时间只允许一个版本处于 building，活着的租约会拒绝第二个构建者。进程崩溃后，等租约过期再执行 `npm run vector:index -- resume`。它只处理没有进度行或之前失败的文档；进程被杀时还在处理的文档没有进度行，resume 会补上。
- 构建前必须完成滚动升级：旧代码的实例只写 active 表，新版本会缺它们的写入，激活门会拒绝（chunk 数不符，或替换后内容过旧）。

### 激活门与切换

`npm run vector:index -- validate <id>` 只做检查（只读）；`npm run vector:index -- activate <id>` 检查通过后切换。检查内容：

- 目标版本必须是 ready，且仍在接收写入；
- 表宽度等于登记宽度，表里只有自己的嵌入身份；
- 在同一条语句（同一快照）里，对每个已登记的文档比较活动版本和目标版本的 chunk 数，必须全部相等。加 `--allow-chunk-count-drift`（换了分块策略时）后，只要求活动版本里有 chunk 的文档在目标版本里也有；
- 目标版本里每个文档的 chunk 所带的 `documentVersion`（迁移 018 之前的 chunk 视为 1）必须等于注册表的 `content_version`，否则以内容过旧拒绝；
- 构建时读不出源字节的文档在目标版本里没有 chunk，激活门会拦住并列出它们（`unreadable`、`unreadableDocuments`）。加 `--allow-unreadable-sources` 才放行这些文档，放行后它们在新版本里检索不到。这不能当默认：构建进程看不到 keystore 或主密钥时，每个加密文档都会这样报；
- 如果活动版本仍跟随配置，执行激活的进程的嵌入配置必须和它存储的行一致，这样才能正确 pin；
- 可选的召回探针，阈值用 `--min-recall`（默认 0.8），K 用 `--probe-top-k`（默认 5）：
  - `--probe-sample N`：抽 N 个已存 chunk 当查询，每个都要在本版本全表 top-K 里找回自己；
  - `--probe-queries file.json`：用保存下来的查询，统计新版本返回了活动版本 top-K 中的多大比例。

活动版本的表不存在时（手工 DROP、部分恢复），activate 和 rollback 默认拒绝，并在原因里提示 `--active-unreadable`。带上它后，跳过所有与活动表的比较，只做目标侧检查（状态、写窗口、宽度、嵌入身份、内容版本），并把表已丢失的旧活动版本标成 failed，不进入宽限期，否则每次上传都会写这张不存在的表。

检查通过后，在一个 owner 事务里持排他锁原子切换：

- 旧版本变为 ready，在宽限期内继续被双写；
- 新版本变为 active；
- 指针的 generation 加 1。

#### 指针缓存

API 实例不需要重启：它们用短 TTL 缓存指针（`RAG_INDEX_VERSION_POINTER_TTL_MS`，默认 2000 ms）。选 TTL 而不用 LISTEN/NOTIFY 的原因：

- 读到过期的指针没有害处：它指向的旧版本在宽限期（至少 2×TTL）内仍收到全部写入；
- TTL 不需要每个实例常驻一个 session 模式连接（事务级连接池会破坏 LISTEN）；
- TTL 不会因为监听重连时丢了通知，让实例长期停在旧版本上。

迁移 019 在指针行上记录 `pointer_ttl_ms`，取执行迁移的进程的配置值：

- API 实例的缓存时长取 min(本进程 TTL, 注册表 TTL)；
- 生命周期操作（宽限期下限、retire 的安全窗口）取 max(本进程 TTL, 注册表 TTL)，所以 CLI 和实例配置不同也能对齐；
- 缓存从读取开始时计时，不从返回时计时；
- 要改这个上界，直接更新该行：调大立即生效；调小要等所有实例当前的缓存过期后才完全生效。

切换后，同一进程内的并发请求共享一次 schema 校验（按校验 key 单飞），不会每个请求各做一次全表 GROUP BY。

退役会删表。搜索撞上已删除的表（错误码 42P01 或 42883）时，会刷新指针并重试一次；在调用方自己的事务里不重试，因为事务已经中止。

### 查询嵌入跟随活动版本

- 每个查询只嵌入一次，而且是在活动版本的嵌入空间里。`rag/embedding-cache.js` 嵌入之前先用 `peekServingQueryEmbeddingSpace`（指针缓存为空或已过期时用 `resolveServingQueryEmbeddingSpace` 读一次指针，都在 `rag/vector-store-pgvector-versions.js`）确定空间：
  - local、Qdrant，或者没有配置数据库时，用配置空间；
  - pgvector 时，用指针缓存里活动版本的空间。检索紧接着读的也是这份 TTL 缓存，所以不会多一次数据库往返。
- 活动版本固定在别的模型上时，直接用那个模型、它的查询前缀和宽度嵌入，不会先按配置模型再嵌入一次。
- 查询嵌入缓存只有一个 LRU，键是"嵌入空间 + 文本"：
  - 大小由 `RAG_EMBEDDING_CACHE_MAX` 决定（默认 256，所有空间共用）；
  - 过期时间是 `RAG_EMBEDDING_CACHE_TTL_MS`（默认 10 分钟）；
  - `RAG_EMBEDDING_CACHE_ENABLED=false` 关闭缓存；
  - `RAG_EMBEDDING_CACHE_SCOPE=tenant` 按租户分区，见 `docs/configuration.md`。
- 同一文本的并发请求只嵌入一次（在途合并）。原来给固定模型单独用的缓存（固定 256 条，不合并并发请求）已经删除。
- 返回的向量带着它所在空间的标记。检索时标记和活动版本一致，就直接用这个向量。只有两种情况会按活动空间再嵌入一次（同样走这份缓存）：
  - 嵌入和检索之间指针变了，比如 TTL 刚过期时发生了切换或回滚；
  - 调用方传入自己按配置模型算的向量（没有标记，按配置空间处理），而活动版本固定在别的模型上。
- 入库不变：每个存活写目标的嵌入空间各嵌入一次。没有写目标在配置空间里时，就不按配置模型嵌入。
- 回滚后，查询随指针回到旧版本的空间；缓存里两个空间的条目互不影响。

配置和活动版本不一致时，报 `configuration_differs_from_active` 警告。它出现在健康检查的 `checks.vectorStore.indexVersions.warnings`、`npm run vector:index -- status` 和 `GET /admin/index-versions` 里。它是警告，不是错误，`checks.vectorStore.status` 仍为 ok。

警告带 `settings` 字段，只列出需要改的环境变量和取值：

- `OPENAI_EMBEDDING_MODEL`；
- `RAG_EMBEDDING_DIMENSIONS`：按"改完模型之后配置会得到的宽度"比较。没有显式设置时宽度跟着新模型走（已知宽度，否则默认 1536），显式设置了就保持不变；
- `RAG_EMBEDDING_QUERY_PREFIX` / `RAG_EMBEDDING_DOCUMENT_PREFIX`：活动版本的前缀不是该模型文档里的默认前缀，或者当前有一个换模型后仍会生效的覆盖值时才列出。空值表示关闭前缀。

例如配置是 `text-embedding-3-small`、活动版本是 `text-embedding-3-large@1536` 时，给出 `OPENAI_EMBEDDING_MODEL=text-embedding-3-large RAG_EMBEDDING_DIMENSIONS=1536`，改一次就够。

服务本身不受影响，但仍建议下次部署时按提示改配置，因为不带 `--model` 的 build 用的是配置空间。

### 回滚与退役

- `npm run vector:index -- rollback`：切回指针记录的上一个版本，走同一道激活门。上一个版本在宽限期内收到了所有写入，所以回滚不丢数据。宽限期由 `RAG_INDEX_VERSION_DUAL_WRITE_GRACE_MS` 设置，默认 24 小时，不低于 2×TTL。宽限期结束后拒绝回滚，只能重新构建。
- `npm run vector:index -- retire <id> [--force]`：退役一个非活动版本，删掉它的表、sparse-rank 函数，以及迁移 030 的 BM25 统计表、触发器函数和 rank 函数。
  - 总是拒绝：活动版本；被替换不足 2×TTL 的版本（可能还有实例在读）。
  - 没有 `--force` 时拒绝：仍在回滚窗口内的版本；租约还活着的构建。
  - 版本 1 的表归迁移所有（健康检查和迁移 014 都引用它），所以退役版本 1 时改为 TRUNCATE 清空，不删表。

退役分两步：

1. 一个不含 DDL 的短事务：持有生命周期排他锁（等所有仍以该版本为目标的写入结束），把版本标成 retired，清掉构建进度和 previous 指针。从这一刻起不再有写入进入该版本。
2. 删表和函数（版本 1 为清空），分多次短尝试。删除版本表需要对文档表加 AccessExclusiveLock（外键触发器在文档表上）。这个锁请求排队期间，后来的文档表读者都会被挡住。所以每次尝试只等 `RAG_INDEX_VERSION_RETIRE_LOCK_TIMEOUT_MS`（默认 200 ms），最多 `RAG_INDEX_VERSION_RETIRE_DROP_ATTEMPTS`（默认 25）次，间隔 `RAG_INDEX_VERSION_RETIRE_RETRY_DELAY_MS`（默认 400 ms，带抖动）。

仍拿不到锁时，结果为 `dropPending`，CLI 以退出码 1 结束；对这个已 retired 的版本再执行一次 retire 即可完成删除。集成测试实测：一个长读者占住文档表时，新的文档表读者最长等了 99–101 ms（改成分次尝试之前最长 10 s）。

退役正在构建的版本（`--force`，或者租约已过期、已释放）时，先用一条单独的语句把它标成 failed，再开始退役事务：

- 这样仍在进行的构建事务续租时直接失败，不会一边拿着文档行、一边等退役锁住的版本行。否则构建者、等这个文档行的写入者、等写入者的退役三方会死锁。
- 返回值里 `previousStatus` 仍是 `building`。
- 退役事务里如果看到版本还在 building（租约活着、没带 `--force`），就拒绝。

### 状态与健康

- `npm run vector:index -- status [--json]`：列出版本、指针、构建进度和警告。警告有：
  - `build_stalled`：在构建但租约已过期，每次上传仍会为它嵌入，直到 resume 或 retire；
  - `ready_not_activated`：已构建但从未激活，会一直被双写；
  - `ready_out_of_grace`：已停止接收写入，不能再激活或回滚到，应退役；
  - `drift`：ready 版本的 chunk 数或文档数和活动版本不同；
  - `build_failed`；
  - `configuration_differs_from_active`（见上）。
- 状态总是返回 active、building、ready 和指针上的 previous 版本；只有 retired/failed 的历史按 limit（默认 25）分页，并返回 `historyLimit`。旧版本再多，active 也不会从状态里消失，健康检查也不会因此变红。
- `GET /admin/index-versions`：需要 `admin.status.read`，只读，返回同样的内容。构建、激活、回滚、退役只能通过 CLI 执行。
- `/health` 的 `checks.vectorStore`：`table` 和 `embedding` 按活动版本描述，另有 `activeVersion` 和 `indexVersions`（活动版本、构建进度、警告）。健康检查不算 drift（报告里 `drift` 为 null），不对每个 ready 表做全表 COUNT；drift 只在 status 和管理接口里有。
- `checks.rowLevelSecurity`：检查所有存活版本的表，以及活动版本的 sparse-rank 函数。
- `npm run vector:reindex` 原地重写活动版本（以及它双写的版本）。活动版本是固定模型时，它会提示：`--apply` 按该模型重写；要换到配置模型，用 `vector:index build` 再激活。
  - `--apply` 每个文档一个事务：先取索引写锁，再对文档行加 `FOR UPDATE`，只有 `content_version` 和 `content_sha256` 仍与读取字节时一致才写入，否则报告跳过（期间被替换或被删除）。
  - 从 local/Qdrant 复制时，源 chunk 的内容版本和注册表不一致也跳过。
  - 保存的 PDF 读不出（`TENANT_*` 错误码）的文档跳过，chunk 保持原样，其他文档继续。

### 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `INDEX_VERSIONS_POSTGRES_TABLE` | `rag_index_versions` | 注册表名，指针表和进度表的名字由它派生 |
| `RAG_INDEX_VERSION_POINTER_TTL_MS` | 2000 | 指针缓存的 TTL。API 实例缓存取它和指针行 `pointer_ttl_ms` 的较小值，生命周期操作取较大值 |
| `RAG_INDEX_VERSION_DUAL_WRITE_GRACE_MS` | 86400000 | 旧版本继续被双写的时长，不低于 2×TTL |
| `RAG_INDEX_VERSION_BUILD_LEASE_MS` | 60000 | 构建租约，每写一个文档续一次 |
| `RAG_INDEX_VERSION_BUILD_BATCH_SIZE` | 16 | 每页列出的待处理文档数，进度计数按页刷新 |
| `RAG_INDEX_VERSION_BUILD_CONCURRENCY` | 4 | 构建时同时处理的文档数，每个文档仍是独立事务 |
| `RAG_INDEX_VERSION_RETIRE_LOCK_TIMEOUT_MS` | 200 | 退役删表时每次尝试等锁的时长 |
| `RAG_INDEX_VERSION_RETIRE_DROP_ATTEMPTS` | 25 | 退役删表的最多尝试次数 |
| `RAG_INDEX_VERSION_RETIRE_RETRY_DELAY_MS` | 400 | 两次删表尝试的间隔，带抖动 |
| `RAG_EMBEDDING_CACHE_MAX` | 256 | 查询嵌入缓存的条数，按"嵌入空间 + 文本"计，所有空间共用 |
| `RAG_EMBEDDING_CACHE_TTL_MS` | 600000 | 查询嵌入缓存条目的有效期 |
| `RAG_EMBEDDING_CACHE_ENABLED` | 开 | `false` 关闭查询嵌入缓存 |

### 典型流程：更换嵌入模型

1. `npm run vector:index -- build --model nomic-embed-text --dimensions 768`
2. `npm run vector:index -- validate 2 --probe-sample 50`
3. `npm run vector:index -- activate 2 --probe-sample 50`
4. 观察一段时间，有问题就执行 `npm run vector:index -- rollback`。
5. 宽限期结束后执行 `npm run vector:index -- retire 1`（版本 1 只清空，不删表）。下次部署时按 `configuration_differs_from_active` 警告的 `settings` 改配置，例如 `OPENAI_EMBEDDING_MODEL`。

### 已知限制

- 新版本表在构建开始时就建好 HNSW 索引，因为双写需要它可用。逐行维护索引比先批量加载再建索引慢。
- 构建依赖注册表里保存的 PDF 字节。如果文档当初不是由这些字节解析出来的（例如直接传入页面文本的导入），chunk 数会和活动版本不同，激活门会拒绝，需要加 `--allow-chunk-count-drift`。
- 固定模型的嵌入调用沿用默认 embedding 路由（同一个 provider 和 endpoint），只替换模型名，不经过模型注册表对模型本身的选择。宽度必须是模型的原生宽度，不发送 `dimensions` 参数。
- status 和管理接口算 drift 时，会对活动表和每个 ready 表各做一次全表 COUNT。
- 同一个构建者的文档事务都要更新版本行，所以在续租到提交这一段排队；解析、嵌入和 chunk 写入是并行的。嵌入延迟越高，并行的收益越大。
- 查询向量的空间标记只挂在 `embedQueryCached` 返回的那个数组对象上。复制出来的向量没有标记，按配置空间处理：活动版本固定在别的模型上时会再嵌入一次，结果仍然正确。

### 测试

- 单元测试：
  ```
  node --test test/vector-store-pgvector-versions.test.mjs test/vector-store-pgvector-version-lifecycle.test.mjs test/vector-index-cli.test.mjs test/index-versions-route.test.mjs test/embedding-cache.test.mjs
  ```
  前四个用 `test/pgvector-version-fake-database.mjs`（辅助文件，不是套件）。`test/embedding-cache.test.mjs` 覆盖按空间分键的 LRU、条数上限和向量的空间标记。
- PostgreSQL：`test/vector-store-pgvector-versions.integration.test.mjs` 是 `npm run test:pgvector` 的一部分，用 `bash scripts/run-pgvector-integration.sh` 在一次性集群上运行；没有 `PGVECTOR_TEST_DATABASE_URL` 时报告为跳过。套件自建数据库（指针是全局状态），owner 是非超级用户，CLI 和会崩溃的构建者都在子进程里跑。覆盖：
  - 升级时原地登记版本 1；
  - 用不同模型和维度构建新版本，构建期间的双写、重新上传、删除后不复活；
  - 另一个进程用 CLI 激活，同时有并发的租户 /chat 和检索，零错误；
  - 宽限期内有写入后回滚；
  - 退役，以及分次短尝试删表时长读者不会挡住其他读者；
  - 构建进程崩溃后活租约阻止第二个构建者，构建期间的范围 clear，resume 只补缺失的文档；
  - 新表的租户隔离和健康检查；
  - 非服务版本的模型嵌入失败时上传继续、该版本被 fence；
  - 三个并发场景：多个构建事务写到一半时 fence 能通过；删除构建者正在重写的文档不死锁；`retire --force` 中止写到一半的构建、同时有删除在等文档行时不死锁；
  - 删除、替换和范围 clear 也会清到 failed 版本和尚未删表的 retired 版本。

## 异步入库流水线（分阶段）

`RAG_INGEST_MODE=async`（默认 `sync`）时，上传请求只做校验，然后把 PDF 写成一个 ingest job，返回 202。worker 按 parse → chunk → embed → index 四个阶段执行这个 job：

- **parse**：解析 PDF，得到页面文本（输出 `pages`）。解析成功后，PDF 字节离开 job 行，转为 `document_file` 输出，只留给 index 阶段写进文档行；`GET /documents/:docId/file` 和索引版本构建都要用到它。
- **chunk**：切块，得到 chunk、页数和 profile（输出 `chunks`）。
- **embed**：计算向量（输出 `embeddings`，以 float32 存储）。写目标版本（active、正在构建、已构建未激活、宽限期内）的每个嵌入空间各算一次。
- **index**：通过和同步上传同一个 `commitDocument`，在一个事务里写文档行和所有写目标版本的 chunk（双写）。pgvector 上同一事务还把 job 记为 succeeded（`store.completeInTransaction`），所以文档提交和 job 成功是同一次 COMMIT。

每个阶段的输出写入 `rag_ingest_jobs_outputs`（迁移 017，带租户授权和 `tenant_isolation` 行策略），写完才推进到下一阶段。所以重试从失败的阶段继续，不从头开始。

- 单个输出不能超过 `RAG_INGEST_STAGE_OUTPUT_MAX_BYTES`（默认 64 MiB，0 表示不限），超过时报 413。
- embeddings 的上限按每个空间单独算：构建第二个模型期间，文档不会因为多了一组向量而超限。
- job 结束（succeeded 或 failed）后阶段输出随之删除。

同步上传不走流水线和合批器，行为与原来一致。

### 重试、死信与重新入队

- 每个阶段有自己的重试预算和退避：`RAG_INGEST_<STAGE>_MAX_ATTEMPTS`、`RAG_INGEST_<STAGE>_RETRY_BASE_MS`、`RAG_INGEST_<STAGE>_RETRY_MAX_MS`，STAGE 取 PARSE、CHUNK、EMBED 或 INDEX。默认值与拆分前单步 job 的一致：`RAG_INGEST_JOB_MAX_ATTEMPTS`（3 次），退避从 5 秒开始翻倍，上限 5 分钟。
- 退避带 50%–100% 的抖动，同一批失败的 job 不会同时到期、重新凑成同一批。Provider 返回的 Retry-After 仍作为退避下限。
- 重试判定按阶段区分：
  - 408/409/425/429、5xx 和网络错误在任何阶段都重试；
  - parse/chunk 阶段的其他 4xx（无可提取文本、pages/chunks 超限 413）直接 failed，因为重试读的还是同样的字节；
  - embed/index 阶段的 4xx（401/403/404、宽度错误、embeddings 超限 413）属于供应商或配置问题：先用完该阶段的预算，再进入 `dead_letter`，保留字节和各阶段输出，运维修复后可以 requeue；
  - 错误自身标记为不可重试的（被替换的文档已不存在、job 丢了文件）在任何阶段都直接失败。
- 写入仍按 job_id + claimed_by + attempt_count 做围栏，worker 仍在 job 自己的租户下执行。
- worker 在 index 提交前（以及一步式 ingest 前）做一次带围栏的续租：已失去租约或已被交回的尝试不会再开始提交。
- `advanceStage` 是幂等的：提交已成功、只是响应丢失时，重试同一调用返回成功，不当作丢了租约。claim 清扫把一个 job 判为 succeeded 时，会一并删除它的阶段输出。
- 某个阶段用尽重试后，job 进入 `dead_letter`，并记录阶段和原因。原因只含阶段、尝试次数、状态码、错误码、错误类名和公开错误信息，不含依赖返回的原始报错。死信 job 保留字节和已完成阶段的输出，重新入队后从该阶段继续，并重新获得该阶段的完整预算。
- 为兼容前端，`GET /ingest-jobs/:jobId` 对死信 job 返回 `status: "failed"`，另附 `deadLetter: { stage, deadLetteredAt }`。该接口还返回 `kind`、`stage`、`duplicate`、`superseded` 和 `documentVersion`。
- 文档被删除时，它排队中、等待重试和死信的 job 以 failed 结束，带 `canceledReason: "document_deleted"`（迁移 040），字节和输出一起删掉。
- 管理接口（按请求者租户隔离，别的租户的 job 返回 404）：
  - `GET /admin/ingest-jobs/dead-letter?limit=N`（默认 50），需要 `admin.status.read`；
  - `POST /admin/ingest-jobs/:jobId/requeue`，需要 `admin.actions.recover_tasks`。
- 命令行（以 owner 身份运行，按属主精确匹配）：
  - `npm run ingest:jobs -- dead-letter list --user <id> --workspace <id>`（`--all` 覆盖所有租户，`--limit` 默认 50、最多 500）；
  - `npm run ingest:jobs -- dead-letter requeue <jobId> --user <id> --workspace <id>`；
  - `npm run ingest:jobs -- counts`。
- 健康检查的 `checks.ingestJobs` 给出各状态计数和 `deadLetterCount`。存在死信只产生警告，不会让整体健康状态报错。

### 跨文档 embedding 批处理

同一进程内，多个 job 的 embed 阶段共用一个批处理器（`rag/ingest-embedding-batcher.js`），每个 job 拿回自己的向量，顺序不变。

- 单个请求不超过 `RAG_INGEST_EMBED_BATCH_MAX_ITEMS`（默认 512）条、`RAG_INGEST_EMBED_BATCH_MAX_TOKENS`（默认 240000，按估算 token 计）。
- 批处理器自己同时在途的请求不超过 `RAG_LLM_INGEST_MAX_CONCURRENCY`（不设时等于 `RAG_LLM_MAX_CONCURRENCY`，默认 8），请求经过 `rag/openai.js` 的 model-call guard。
- 有空闲槽位时，文本立即单独发送；只有等不到槽位的积压，才在有请求结束后合并成一个请求。空闲时合并只会让每个 job 等一个更大的请求，省请求但降吞吐。
- 只有不设上限（0）时，才按 `RAG_INGEST_EMBED_BATCH_LINGER_MS`（默认 25 ms）等待凑批，攒满立即发送。
- 每个租户的文本在自己的子队列里，凑批时轮流取（最久没被服务的先取），一个租户的大批入库不会挡住另一个租户的小批。索引版本构建等没有租户的调用共用一个 system 子队列。
- 模型调用不走 model gateway 时，一批可以混合多个租户，以系统身份发出；开了 `MODEL_QUOTA_ENABLED` 时每个租户先过本进程的配额检查再入批，返回的 token 和费用按各租户文本的估算 token 分摊记账。走 gateway 时，一批只带一个租户的文本，以该租户的身份发出。
- 失败的处理：
  - 只有 `CIRCUIT_OPEN` 和 429 算整批失败，所有相关 job 各自按带抖动的退避重试；
  - 其他失败（包括 5xx 和超时）可能只由某个 job 的输入引起，此时按 job 分别重发一次，只让出错的那个 job 失败。
- `RAG_INGEST_EMBED_BATCHING=false` 绕过批处理器：每个 job 按嵌入空间各发一个请求，和同步上传一样。

实测（每项 3 次重复，64 份上传，2 个独立 worker × 8 路，200 ms/请求的假模型）：

- 默认上限 8：开 64.83 [60.23, 69.43] 篇/秒，关 65.20 [60.50, 69.91]，持平。
- 每条输入另加 2 ms：开 62.58 [58.46, 66.69]，关 63.07 [59.67, 66.48]，持平。
- 上限 2：开 41.67 [35.68, 47.66]，关 19.57 [19.21, 19.93]，开是关的 2.1 倍；每 64 份文档 26–30 个 embeddings 请求（关为 64 个）。
- 早期实现在空闲时也合并，上限不卡时比关闭慢：默认上限下 58.33 篇/秒（低约 10%），每条输入加 2 ms 时 47.74（低 24%）。改成"先占槽位再合并"后与关闭持平。

结论：上限不成为瓶颈时与关闭持平；上限成为瓶颈时请求减少约 2–2.5 倍、吞吐约提高一倍。假模型按请求固定计时，偏向合批，这个倍数是上限。报告里的 probe-time docs/s 列受 1 s 轮询影响，不反映吞吐。

### 去重

- 每个文档记录内容哈希 `content_sha256`（字节的 SHA-256），以及 `content_version` 和 `content_updated_at`（迁移 018）。
- 同一租户（`owner_user_id` 和 `workspace_id` 完全相同）再次上传相同字节时：
  - 同步模式返回 200，body 是已有文档，带 `duplicate: true`；
  - 异步模式返回 202，job 直接解析到已有 docId（`status: "succeeded"`、`duplicate: true`）。
- 不会跨租户去重。
- index 事务在索引写锁之后、任何文档行锁之前，对"租户 + 哈希"加 advisory 锁再查一次，所以两个相同的上传同时进行也只会产生一个文档。
- 注册表是 PostgreSQL、而索引不支持事务时（例如 Qdrant 配合独立 worker），相同字节的上传通过同一把"租户 + 哈希" advisory 锁在进程之间串行。
- `RAG_INGEST_DEDUP=false` 关闭去重（默认开启）。
- 迁移 018 之前的文档没有哈希，需要执行 `npm run ingest:jobs -- backfill-hashes`（可加 `--dry-run` 只统计）后才能参与去重。哈希由数据库分批计算，PDF 不经过网络。

### 文档替换与版本

- `PUT /documents/:docId`（multipart 字段 `file`）用新内容替换文档。校验规则和租户范围与上传相同；看不到该文档的租户收到 404。
- 只在 pgvector 上支持。local 和 Qdrant 无法原子地替换一个文档的 chunk，因此返回 409，而且在解析和嵌入之前就拒绝，异步模式也不入队。
- docId、属主和 uploadedAt 不变，`version` 加 1，`updatedAt` 更新。
- 同步模式返回 200 和文档；异步模式返回 202，body 带 `kind: "replace"`。
- 替换会锁住文档行，在同一个事务里删除旧 chunk、写入新 chunk：每条检索语句要么看到完整的旧版本，要么看到完整的新版本，不会看到一半，也不会一个都看不到；提交后旧版本的 chunk 不再返回。chunk 的 metadata 带 `documentVersion`。
- 后发起的替换胜出，排序统一用数据库时钟：
  - 异步 job 按它的 `created_at`；同步写入不带请求时间，`content_updated_at` 由数据库 `NOW()` 写入；
  - 请求时间早于当前内容的替换即使晚完成，也不会覆盖：异步 job 以 succeeded 结束并带 `superseded: true`（迁移 019 的列）；同步 PUT 返回 409 和 `superseded: true`。
- 替换同样写入正在构建的索引版本。构建者比较 `uploaded_at` 和 `content_version`，不会用构建开始时读到的旧内容覆盖替换结果。
- 同一次检索里的版本一致：dense 和 sparse 两路是两条语句，替换可能恰好在中间提交。融合时对每个文档只保留各路结果中最新的内容版本（`keepNewestDocumentVersion`）。
- 版本 2 及以后的 chunk 的 `publicFilePath` 是 `documents/<id>/file?version=N`。`GET /documents/:docId/file?version=N` 在 N 不是当前版本时返回 409（附 `currentVersion`），不会给出其他版本的 PDF。
- 版本 1 的链接保持不变（兼容），所以文档后来被替换后，版本 1 的引用会打开新 PDF。
- 同一次 agent 运行里，primary 和 follow-up 检索之间的版本固定尚未实现（属于 agent 侧）。

### 配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RAG_INGEST_MODE` | `sync` | `async` 时上传返回 202，由 worker 分阶段执行 |
| `RAG_INGEST_STAGE_OUTPUT_MAX_BYTES` | 67108864（64 MiB） | 单个阶段输出的上限，embeddings 按空间计；0 不限 |
| `RAG_INGEST_JOB_MAX_ATTEMPTS` | 3 | 各阶段尝试次数的默认值 |
| `RAG_INGEST_<STAGE>_MAX_ATTEMPTS` | 同上 | 单个阶段的尝试次数，用尽进入死信 |
| `RAG_INGEST_<STAGE>_RETRY_BASE_MS` | 5000 | 单个阶段退避的起点，翻倍增长 |
| `RAG_INGEST_<STAGE>_RETRY_MAX_MS` | 300000 | 单个阶段退避的上限 |
| `RAG_INGEST_EMBED_BATCHING` | 开 | `false` 绕过跨文档批处理器（入库和索引版本构建都生效） |
| `RAG_INGEST_EMBED_BATCH_MAX_ITEMS` | 512 | 一个合并请求的最多条数 |
| `RAG_INGEST_EMBED_BATCH_MAX_TOKENS` | 240000 | 一个合并请求的估算 token 上限 |
| `RAG_INGEST_EMBED_BATCH_LINGER_MS` | 25 | 只在并发不设上限时，等待凑批的时长 |
| `RAG_INGEST_DEDUP` | 开 | `false` 关闭同租户按内容去重 |

### 测试

- 单元测试：`test/ingest-pipeline.test.mjs`、`test/ingest-pipeline-routes.test.mjs`、`test/ingest-jobs.test.mjs`、`test/ingest-jobs-routes.test.mjs`、`test/ingest-jobs-cli.test.mjs`、`test/ingest-embedding-batcher-tenants.test.mjs`、`test/vector-reindex.test.mjs`。
- PostgreSQL：`test/ingest-pipeline-postgres.integration.test.mjs` 和 `test/ingest-jobs-postgres.integration.test.mjs` 是 `npm run test:pgvector` 的一部分，没有 `PGVECTOR_TEST_DATABASE_URL` 时报告为跳过。覆盖：
  - 迁移 017/018 的租户策略和内容标识；
  - 各阶段输出落库、parse 后 PDF 移出 job 行、文档和 job 成功同一次提交；
  - worker 在任一阶段被杀后，下一个 worker 从该阶段继续；
  - 并发 job 共享一个 embed 请求、坏输入只让自己的 job 失败；
  - 死信的列出、按租户 requeue、健康计数和从原阶段继续；
  - 去重不跨租户，两个相同上传并发时也只产生一个文档；
  - 替换在租户检索进行时原子交换 chunk；构建期间的替换写入构建中的版本，构建者不会写回旧内容；
  - 替换按数据库时钟排序，被抢先的 job 以 superseded 成功；
  - `advanceStage` 提交后重试算作完成，清扫删除已结束 job 的输出；
  - PostgreSQL 注册表配非事务索引时，相同上传在进程之间按内容锁串行。

## 测量

以下都是同一台机器上、压测脚本自带的假模型测得的，数字只代表各自写明的前提，不代表真实服务商在 RPM/TPM 限额下的情况。

### 零停机切换的适用范围

`docs/evaluation.md` 里 index-switch 的数字（0 错误、2 秒内跟上新指针、切换和回滚命令约 235 ms）来自只读 /chat、800 个 chunk，期间没有并发的上传、删除或替换，也不含 retire，只能按这个范围引用。retire 对读者的影响以集成测试的实测为准（最长约 100 ms，见"回滚与退役"）。

### 查询嵌入跟随活动版本、并行构建

测量条件：

- 一次性 PostgreSQL 18.6 + pgvector 0.8.6；
- 假模型：每个 embedding 请求固定 100 ms，与输入多少无关，可以并行，没有限流；
- 2 个实例，按租户走行级安全，`/chat` 闭环并发 8；
- 200 篇文档 × 4 页；新版本把模型从 1536 维换成 768 维，实例配置不改；
- 关闭查询缓存（`--no-embedding-cache`），每个查询真实的嵌入次数都会显示出来；
- 旧代码是提交 85efbb6a。

| | 旧代码 85efbb6a | 新代码 |
|---|---|---|
| 激活后每个 /chat 的嵌入次数 | 3.98（配置模型 2.00 + 固定模型 1.98） | 2.01（固定模型 1.86 + 配置模型 0.15） |
| 激活前后吞吐 | 29.60 → 21.19 req/s（-28.4%） | 29.20 → 28.79 req/s（-1.4%） |
| 激活前后平均延迟 | 273 → 378 ms | 277 → 278 ms |

- 新代码的 0.15 次配置模型嵌入，全部发生在切换后约 2 秒的指针 TTL 内。
- 开着查询缓存的那一轮测的是缓存大小，不是"只嵌入一次"：压测脚本把 `RAG_EMBEDDING_CACHE_MAX` 设成 6464，能装下整个问题池，并且激活后先预热；旧代码给固定模型单独用的缓存写死 256 条，装不下约 1600 个检索查询。所以"每个 /chat 0 次嵌入"只在与问题池一样大、并且预热过的缓存下成立。用默认的 256 条缓存或不重复的问题时，每个检索查询仍要嵌入一次，大约每个 /chat 2 次。引用查询嵌入的代价时，用关缓存的这组数。

构建（同一组关缓存运行，只代表"假模型、延迟固定、瓶颈在嵌入"的最好情况）：

- 旧代码串行 8.57 篇/秒；新代码 4 篇并行 33.2 篇/秒（3.87 倍）。两边都是 201 个 embedding 请求（1 个创建探测，加每篇 1 个）。
- 构建期间 /chat（每个请求 2 次 embedding）：新代码 30.13 对构建前 29.20 req/s，旧代码 30.05 对 29.60。这个假模型不限流，模型调用上限是每个进程各自的、按模型区分，所以构建请求和 /chat 从来不争同一份限额。这组数只反映数据库和主机的争用。
- 上限 2（`RAG_LLM_MAX_CONCURRENCY=2`，每个进程各自一份，CLI 也一样）、4 篇并行：25.13 篇/秒，200 篇文档只用了 152 个请求（加 1 个探测共 153），合批确实生效。/chat 受上限限制，只有约 19.6 req/s，构建期间 19.25。

命令（每次运行用自己的 `--latest-name`，结果写到被忽略的 `evaluation/results/latest-load-test-index-switch*.{json,md}`）：

```
cd server && bash scripts/run-load-test-pgvector.sh --scenario index-switch --instances 2 --tenant \
  --documents 200 --embedding-latency-ms 100 --switch-phase-ms 20000 --model-latency-ms 0 \
  --no-embedding-cache --switch-build-concurrency 4 --latest-name <名字>
```

测串行构建时把 `--switch-build-concurrency` 改成 1。`npm run eval:load-test:index-switch` 是开着缓存的版本，它激活后的数字描述的是一个和问题池一样大的缓存。
