# 索引版本与分阶段入库

本文记录 pgvector 索引版本（零停机重建、切换、回滚、退役）和异步入库流水线（分阶段、跨文档合批、死信、去重、文档版本）。测量数字见 `docs/evaluation.md` 的"索引切换与入库流水线"和 `server/docs/interview/CURRENT-TRUTH.md`。

## 索引版本：零停机重建 pgvector 索引

只适用于 `VECTOR_STORE_PROVIDER=pgvector`（默认）。`local` 和 `qdrant` 仍然只有一份索引：没有版本、双写、切换和回滚。`npm run vector:index` 会直接拒绝这两个 provider，它们继续用 `npm run vector:reindex` 原地重写。

### 数据模型（迁移 016）
- `rag_index_versions`：每个版本一行，包括：
  - `version_id`
  - `status`：building / ready / active / retired / failed
  - 物理位置：`chunk_table`、`sparse_rank_function`
  - 嵌入空间：`embedding_space_source`、`embedding_model`、`embedding_identity`、文档/查询前缀、`embedding_dimensions`
  - `index_params`：hnsw/ivfflat 参数和全文检索配置
  - 行数与构建进度：`document_count`、`chunk_count`、`build_documents_*`
  - 构建租约：`builder_id`、`lease_expires_at`
  - `dual_write_until` 和各阶段时间戳

  部分唯一索引保证任何时候最多只有一个 active 版本和一个 building 版本。
- `rag_index_versions_pointer`：唯一的活动指针，字段为 `active_version_id`、`previous_version_id`、`generation`、`switched_at`。
- `rag_index_versions_build_progress`：每个文档一行，和该文档的 chunk 在同一个事务里提交。它列出了所有租户的 doc_id，所以只有 owner 角色能访问。
- 升级时，现有的 `rag_document_chunks` 原地登记为版本 1，一行也不移动，指针指向它。
  - 在被别的版本替换之前，版本 1 一直"跟随配置"，行为和原来的单表完全一样：空表可以按新宽度 resize，混入其他模型的 chunk 时 fail closed，`vector:reindex` 原地重写。
  - 第一次激活其他版本时，版本 1 被固定（pin）在它验证过的嵌入空间上。之后回滚到版本 1 不再受配置变化影响。
- 租户角色对注册表和指针只有 SELECT 权限：写事务需要在自己的事务里读取写目标，但不能改它们。这两张表不含租户数据，所以没有行策略。

### 每个版本的物理表
表名为 `<DOCUMENT_CHUNKS_POSTGRES_TABLE>_v<N>`，由 owner 在运行时创建。DDL 直接渲染迁移 012/013/014 的同一套模板，包含：
- 本版本宽度的 `vector(N)` 列；
- HNSW（或 IVFFlat）索引和 GIN 索引；
- 指向文档表的级联外键；
- `tenant_isolation` 行策略和租户 GRANT；
- `<表名>_sparse_rank` SECURITY DEFINER 函数（PUBLIC 不可执行，只授予租户角色）。

所有标识符都经过校验，包括派生出来的索引、约束和函数名，并确认不超过 63 字节。版本号从不复用，所以用 `CREATE TABLE`，不用 `IF NOT EXISTS`。

### 写路径：双写
每个 ingest、delete、clear 事务的第一条语句是事务级共享 advisory 锁，拿到锁之后才读取写目标。写目标包括：
- 活动版本；
- 正在构建的版本；
- 已构建完成、尚未激活的版本；
- 被替换后仍在宽限期内的旧活动版本。

注册新版本、切换指针、退役版本时，持有同一把锁的排他模式。这样构建者的快照（注册提交之后才列出文档）和写入者看到的目标集合之间不会有缝隙。

锁顺序是固定的，不会形成环：
- 生命周期操作：指针行 → 版本行 → advisory 锁 → DDL；
- 写入者：先拿 advisory 锁，再碰文档行；
- 构建者：版本行 → 单个文档行。

嵌入在事务外计算，每个嵌入空间算一次，活动版本的空间优先。如果加锁后读到了一个新注册、嵌入空间不同的版本，就在事务内补算。这种情况很少见，但保证正确。

### 构建：可恢复、带租约、分批
```
npm run vector:index -- build [--model M] [--dimensions N] [--document-prefix P] [--query-prefix Q]
    [--index-type hnsw|ivfflat] [--hnsw-m] [--hnsw-ef-construction] [--ivfflat-lists]
    [--text-search-config] [--batch-size] [--lease-ms]
```
- 构建从文档注册表保存的 PDF 字节重新解析、分块，用新版本自己的模型嵌入，按批推进（`RAG_INDEX_VERSION_BUILD_BATCH_SIZE`，默认 16）。
- 每个文档一个事务，依次做这些事：
  - 续租，并以 `builder_id` 做围栏：租约被接管后，旧构建者的下一次写入直接失败；
  - 对文档行加 `FOR SHARE` 锁，确认 `uploaded_at` 没变；
  - 替换该文档的 chunk；
  - 写入进度行。
- 各种情况的处理：
  - 文档在读取后被删除：记为 `skipped_deleted`，不会复活。外键级联同样作用于所有版本表。
  - 文档在读取后被重新上传：重新读取新字节，最多 3 次。
  - 解析失败：只把该文档记为失败，构建继续。
  - 嵌入宽度和声明不符：版本标记为 failed。
  - 其他错误（嵌入服务不可用、数据库断开）：释放租约，版本保持 building。
- 同一时间只允许一个版本处于 building，活着的租约会拒绝第二个构建者。进程崩溃后，等租约过期再执行 `npm run vector:index -- resume`，它只处理没有进度行或之前失败的文档。

### 激活门与切换
`npm run vector:index -- validate <id>` 只做检查（只读）；`npm run vector:index -- activate <id>` 检查通过后切换。检查内容：
- 目标版本必须是 ready，且仍在接收写入；
- 表宽度等于登记宽度，表里只有自己的嵌入身份；
- 在同一条语句（同一快照）里，对每个存在的文档比较活动版本和目标版本的 chunk 数，必须全部相等。加 `--allow-chunk-count-drift` 时（换了分块策略的情况），只要求活动版本里有 chunk 的文档在目标版本里也有；
- 如果活动版本仍跟随配置，执行激活的进程的嵌入配置必须和它存储的行一致，这样才能正确 pin；
- 可选的召回探针，阈值用 `--min-recall`（默认 0.8），K 用 `--probe-top-k`（默认 5）：
  - `--probe-sample N`：抽 N 个已存 chunk 当查询，每个都要在本版本全表 top-K 里找回自己；
  - `--probe-queries file.json`：用保存下来的查询，统计新版本返回了活动版本 top-K 中的多大比例。

检查通过后，在一个 owner 事务里持排他锁原子切换：旧版本变为 ready，在宽限期内继续被双写；新版本变为 active；指针的 generation 加 1。

API 实例不需要重启：它们用短 TTL 缓存指针（`RAG_INDEX_VERSION_POINTER_TTL_MS`，默认 2000 ms）。选 TTL 而不用 LISTEN/NOTIFY 的原因：
- 读到过期的指针没有害处：它指向的旧版本在宽限期（至少 2×TTL）内仍收到全部写入；
- TTL 不需要每个实例常驻一个 session 模式连接（事务级连接池会破坏 LISTEN）；
- TTL 不会因为监听重连时丢了通知，而让实例长期停在旧版本上。

退役会删表。如果搜索撞上已删除的表（错误码 42P01 或 42883），会刷新指针并重试一次。

如果活动版本固定在与本进程配置不同的模型上，每个查询会嵌入两次：先按配置模型，再按活动版本的模型。健康检查会报 `configuration_differs_from_active` 警告。下次部署时把 `OPENAI_EMBEDDING_MODEL` / `RAG_EMBEDDING_DIMENSIONS` 改成活动模型即可消除。

### 回滚与退役
- `npm run vector:index -- rollback`：切回指针记录的上一个版本，走同一道激活门。上一个版本在宽限期内收到了所有写入，所以回滚不丢数据。宽限期由 `RAG_INDEX_VERSION_DUAL_WRITE_GRACE_MS` 设置，默认 24 小时，至少 2×TTL。宽限期结束后拒绝回滚，只能重新构建。
- `npm run vector:index -- retire <id> [--force]`：删除非活动版本的表和 sparse-rank 函数。
  - 总是拒绝：活动版本；被替换不足 2×TTL 的版本（可能还有实例在读）。
  - 没有 `--force` 时拒绝：仍在回滚窗口内的版本；租约还活着的构建。
  - 版本 1 的表归迁移所有（健康检查和迁移 014 都引用它），所以退役版本 1 时改为 TRUNCATE 清空，不删表。

### 状态与健康
- `npm run vector:index -- status [--json]`：列出所有版本、指针、构建进度和警告。警告有 build_stalled、ready_out_of_grace、drift、build_failed、configuration_differs_from_active。
- `GET /admin/index-versions`：需要 `admin.status.read` 权限，只读，返回同样的内容。构建、激活、回滚、退役只能通过 CLI 执行。
- `/health` 里的 `checks.vectorStore`：`table` 和 `embedding` 都按活动版本描述，新增 `activeVersion` 和 `indexVersions`（活动版本、构建进度、drift、警告）。
- `checks.rowLevelSecurity`：检查所有存活版本的表，以及活动版本的 sparse-rank 函数。
- `npm run vector:reindex` 仍然原地重写活动版本（以及它双写的版本）。活动版本是固定模型时，它会提示改用 `vector:index build`。

### 配置
| 变量 | 默认值 | 说明 |
|---|---|---|
| `INDEX_VERSIONS_POSTGRES_TABLE` | `rag_index_versions` | 注册表名，指针表和进度表的名字由它派生 |
| `RAG_INDEX_VERSION_POINTER_TTL_MS` | 2000 | 指针缓存的 TTL |
| `RAG_INDEX_VERSION_DUAL_WRITE_GRACE_MS` | 86400000 | 旧版本继续被双写的时长，至少 2×TTL |
| `RAG_INDEX_VERSION_BUILD_LEASE_MS` | 60000 | 构建租约，每写一个文档续一次 |
| `RAG_INDEX_VERSION_BUILD_BATCH_SIZE` | 16 | 每批处理的文档数 |

### 典型流程：更换嵌入模型
1. `npm run vector:index -- build --model nomic-embed-text --dimensions 768`
2. `npm run vector:index -- validate 2 --probe-sample 50`
3. `npm run vector:index -- activate 2 --probe-sample 50`
4. 观察一段时间，有问题就执行 `npm run vector:index -- rollback`
5. 宽限期结束后执行 `npm run vector:index -- retire 1`，下次部署时把 `OPENAI_EMBEDDING_MODEL` 改为新模型。

### 已知限制
- 新版本表在构建开始时就建好 HNSW 索引，因为双写需要它可用。逐行维护索引比先批量加载再建索引慢。
- 构建依赖注册表里保存的 PDF 字节。如果文档当初不是由这些字节解析出来的（例如直接传入页面文本的导入），chunk 数会和活动版本不同，激活门会拒绝，需要加 `--allow-chunk-count-drift`。
- 固定模型的嵌入调用沿用默认 embedding 路由（同一个 provider 和 endpoint），只替换模型名，不经过模型注册表对模型本身的选择。宽度必须是模型的原生宽度，不会发送 `dimensions` 参数。
- 当存在非活动的存活版本时，健康检查会对活动表和这些版本表各做一次 COUNT。

### 测试
- 单元测试：
  ```
  node --test test/vector-store-pgvector-versions.test.mjs test/vector-store-pgvector-version-lifecycle.test.mjs test/vector-index-cli.test.mjs test/index-versions-route.test.mjs
  ```
- PostgreSQL：执行 `bash scripts/run-pgvector-integration.sh`（需要先把 `test/vector-store-pgvector-versions.integration.test.mjs` 加进 `test:pgvector`）。这个套件自建数据库，owner 是非超级用户，覆盖以下场景：
  - 升级时原地登记版本 1；
  - 用不同模型和维度构建新版本；
  - 构建期间的双写、重新上传、删除后不复活；
  - 另一个进程用 CLI 激活，同时有并发的租户 /chat 和检索，零错误；
  - 宽限期内有写入后回滚；
  - 退役；
  - 构建进程崩溃后，活租约阻止第二个构建者；
  - 构建期间的范围 clear；
  - resume 只补缺失的文档；
  - 新表的租户隔离和健康检查。

## 异步入库流水线（分阶段）

`RAG_INGEST_MODE=async` 时，上传请求只做校验，然后把 PDF 写成一个 ingest job，返回 202。worker 按 parse → chunk → embed → index 四个阶段执行这个 job：

- **parse**：解析 PDF，得到页面文本（输出 `pages`）。解析成功后，PDF 字节离开 job 行，转为 `document_file` 输出，只留给 index 阶段写进文档行；`GET /documents/:docId/file` 和索引版本构建都要用到它。
- **chunk**：切块，得到 chunk 文档、页数和 profile（输出 `chunks`）。
- **embed**：计算向量（输出 `embeddings`，以 float32 存储）。按索引生命周期，active 版本、正在构建的版本和回滚窗口内的版本都需要写入，每个版本各用自己的 embedding 空间。
- **index**：在一个事务里写文档行和所有写目标版本的 chunk（dual write），并在同一事务里把 job 记为 succeeded。

每个阶段的输出写入 `rag_ingest_jobs_outputs`（迁移 017，带租户授权和 `tenant_isolation` 行策略），写完才推进到下一阶段。所以重试从失败的阶段继续，不会从头开始。单个输出的大小不能超过 `RAG_INGEST_STAGE_OUTPUT_MAX_BYTES`（默认 64 MiB，0 表示不限）；超过时 job 以 413 失败。job 结束后阶段输出随之删除。

### 重试、死信与重新入队

- 每个阶段有自己的重试预算和退避时间：`RAG_INGEST_<STAGE>_MAX_ATTEMPTS`、`RAG_INGEST_<STAGE>_RETRY_BASE_MS`、`RAG_INGEST_<STAGE>_RETRY_MAX_MS`，其中 STAGE 取 PARSE、CHUNK、EMBED 或 INDEX。默认值与拆分前单步 job 的一致：`RAG_INGEST_JOB_MAX_ATTEMPTS`（3 次），退避从 5 秒开始翻倍，上限 5 分钟。Provider 返回的 Retry-After 仍作为退避下限。
- 写入仍按 job_id + claimed_by + attempt_count 做 fencing，worker 仍在 job 自己的租户下执行。
- 某个阶段用尽重试次数后，job 进入 `dead_letter`，并记录阶段和原因（原因只含状态码、错误码和公开错误信息，不含依赖返回的原始报错）。死信 job 保留字节和已完成阶段的输出，重新入队后从该阶段继续，并重新获得该阶段的完整预算。上传本身的问题（如 422 无可提取文本）仍直接进入 `failed`。
- 为兼容前端，`GET /ingest-jobs/:jobId` 对死信 job 返回 `status: "failed"`，另附 `deadLetter: { stage, deadLetteredAt }`。该接口新增的字段还有 `kind`、`stage`、`duplicate` 和 `documentVersion`。
- 管理接口（按请求者租户隔离）：
  - `GET /admin/ingest-jobs/dead-letter?limit=N`，需要 `admin.status.read`
  - `POST /admin/ingest-jobs/:jobId/requeue`，需要 `admin.actions.recover_tasks`
- 命令行：
  - `npm run ingest:jobs -- dead-letter list --user <id> --workspace <id>`（或用 `--all` 覆盖所有租户）
  - `npm run ingest:jobs -- dead-letter requeue <jobId> --user <id> --workspace <id>`
  - `npm run ingest:jobs -- counts`
- 健康检查中新增 `checks.ingestJobs`，内容为各状态计数和 `deadLetterCount`。存在死信只产生警告，不会让整体健康状态报错。

### 跨文档 embedding 批处理

同一进程内，多个 job 的 embed 阶段共用一个批处理器。同一 embedding 空间的文本合并成一个请求发出，单个请求不超过 `RAG_INGEST_EMBED_BATCH_MAX_ITEMS`（默认 512）条、`RAG_INGEST_EMBED_BATCH_MAX_TOKENS`（默认 240000，按估算 token 计）。攒满立即发送；否则等待最多 `RAG_INGEST_EMBED_BATCH_LINGER_MS`（默认 25 ms）。结果按 job 拆回，每个 job 拿到自己的向量，顺序不变。

请求经过 `rag/openai.js` 的 model-call guard。批处理器自身同时在途的请求不超过 `RAG_LLM_MAX_CONCURRENCY` 个。失败的处理方式：
- 服务不可用、限流、熔断这类整批失败，所有相关 job 一起按各自的退避重试。
- 其他失败可能只由某个 job 的输入引起，此时按 job 分别重发一次，只让出错的那个 job 失败。

同步上传不走批处理器，行为与原来一致。

### 去重

- 每个文档记录内容哈希 `content_sha256`（字节的 SHA-256，迁移 018）。
- 同一租户（owner_user_id 和 workspace_id 完全相同）再次上传相同字节时：
  - 同步模式返回 200，body 是已有文档，并带 `duplicate: true`；
  - 异步模式返回 202，job 直接解析到已有 docId（`status: "succeeded"`、`duplicate: true`）。
- 不会跨租户去重。
- index 事务会对“租户 + 哈希”加 advisory 锁后再查一次，所以两个相同的上传同时进行也只会产生一个文档。
- `RAG_INGEST_DEDUP=false` 关闭去重（默认开启）。
- 迁移 018 之前的文档没有哈希，需要执行 `npm run ingest:jobs -- backfill-hashes`（可加 `--dry-run` 只统计）后才能参与去重。哈希由数据库分批计算，PDF 不经过网络。

### 文档替换与版本

- `PUT /documents/:docId`（multipart 字段 `file`）用新内容替换文档。校验规则和租户范围与上传相同；看不到该文档的租户收到 404。
- docId 和 uploadedAt 不变，`version` 加 1，`updatedAt` 更新。
- 同步模式返回 200 和文档；异步模式返回 202，body 带 `kind: "replace"`。
- pgvector 上，替换会锁住文档行，在同一个事务里删除旧 chunk、写入新 chunk：每条检索语句要么看到完整的旧版本，要么看到完整的新版本，不会看到一半，也不会一个都看不到；提交后旧版本的 chunk 不再返回。chunk 的 metadata 带 `documentVersion`。
- 后发起的替换胜出：请求时间早于当前内容的替换即使晚完成，也不会覆盖（返回 `superseded: true`）。
- 替换同样会写入正在构建的索引版本。索引版本构建器会比较 content_version，因此不会用构建开始时读到的旧内容覆盖替换结果。
- local 和 Qdrant provider 没有事务，替换不保证原子性。

## 审查后的修正（2026-09-27）

【索引版本生命周期（pgvector）】
- 创建版本：在任何 DDL 之前，先在新 embedding 空间里嵌入一条探测文本，并校验向量宽度。模型不可用、密钥被拒、--dimensions 与模型实际输出不符时，直接报错，不会登记任何版本。
- 非服务版本不拖垮上传：写目标中除 active 以外的版本（构建中、已构建未激活、宽限期内可回滚的旧版本）都是尽力而为。上传在某个空间嵌入失败时，该空间所有非 active 的 building/ready 版本会被标记为 failed（写入 last_error；在独立事务中执行，lock_timeout 2 s），上传照常写入 active 版本。failed 版本不能再被激活或回滚到。active 版本自己的空间失败时，上传仍按原样失败。
- 状态告警：新增 ready_not_activated（已构建但未激活，会一直被双写）；build_stalled 的说明补充了"每次上传仍会为它嵌入"。
- 状态分页：describeIndexVersions 总是返回 active、building、ready 以及指针上的 previous 版本；只有 retired/failed 的历史按 limit（默认 25）分页，并返回 historyLimit。旧版本再多，也不会让 active 从状态里消失、让健康检查变红。
- 健康检查：/health 不再计算 drift，也就不再对 active 和每个 ready 表做 COUNT(*) / COUNT(DISTINCT)，健康报告里的 drift 为 null。drift 仍保留在 `npm run vector:index -- status` 和 GET /admin/index-versions 中。
- 切换后的校验：同一进程内并发请求共享一次 schema 校验（按校验 key 单飞），不再每个请求各做一次全表 GROUP BY。
- 指针 TTL（迁移 019）：指针行新增 pointer_ttl_ms，由执行迁移的进程写入其配置值。API 实例的缓存时长取 min(本进程 TTL, 注册表 TTL)；生命周期操作（宽限期下限、retire 的安全窗口）取 max(本进程 TTL, 注册表 TTL)，因此 CLI 与实例配置不同也能对齐。缓存从读取开始时计时，不再从返回时计时。要改这个上界，请直接更新该行：调大立即生效；调小要等所有实例当前的缓存过期后才完全生效。
- 激活闸门：除了按文档比较 chunk 数、宽度和 embedding identity，还要求目标版本中每个文档的 chunk 所带的 documentVersion（018 之前的 chunk 视为 1）等于注册表里的 content_version，不一致就拒绝（内容过旧）。构建版本前必须完成滚动升级：旧代码实例只写 active 表。
- active 表丢失时：rollback/activate 在不带参数时会拒绝，并在原因里提示 --active-unreadable。带上 `--active-unreadable` 后，跳过与 active 表的所有比较，只做目标侧检查（状态、写窗口、宽度、identity、内容版本），并把表已丢失的旧 active 标记为 failed（不进入宽限期，否则每次上传都会写这张不存在的表）。
- retire 分两步：
  1. 一个不含 DDL 的短事务。持有生命周期排他锁（等待所有仍以该版本为目标的写入结束），把版本标记为 retired、清掉构建进度和 previous 指针。从这一刻起不再有写入进入该版本。
  2. 删表/删函数（v1 为清空）分多次短尝试。删除版本表需要对 documents 表加 AccessExclusiveLock（外键触发器在 documents 上），这个锁请求排队期间，后来的 documents 读者都会被挡住；因此每次尝试只等 RAG_INDEX_VERSION_RETIRE_LOCK_TIMEOUT_MS（默认 200 ms），最多 RAG_INDEX_VERSION_RETIRE_DROP_ATTEMPTS（默认 25）次，间隔为 RAG_INDEX_VERSION_RETIRE_RETRY_DELAY_MS（默认 400 ms，带抖动）。
  若仍拿不到锁，结果为 dropPending，CLI 以退出码 1 结束；对这个已 retired 的版本再执行一次 retire 即可完成删除。实测：一个长读者占住 documents 时，新的 documents 读者最长只等了 99–101 ms（此前最长 10 s）。

【入库流水线】
- 重试判定按阶段区分：parse/chunk 阶段的 4xx（无可抽取文本、pages/chunks 超限 413）仍然直接 failed。embed/index 阶段的 4xx（401/403/404、宽度错误、embeddings 超限 413）属于供应商或配置问题：先用完该阶段的重试预算，再进入 dead_letter，保留字节和各阶段输出，运维修复后可以 requeue。错误自身标记为不可重试的（被替换的文档已不存在、任务丢失文件）在任何阶段都直接失败。
- embeddings 输出上限按每个空间单独计算：构建第二个模型期间，文档不会因为多了一组向量而超限。
- 批处理器：受并发上限（RAG_LLM_MAX_CONCURRENCY，默认 8）约束时，有空闲槽位就立即单独发送，只有等不到槽位的积压才合并成一个请求；只有不设上限（0）时才按 RAG_INGEST_EMBED_BATCH_LINGER_MS 等待凑批。批请求失败时，只有 CIRCUIT_OPEN 和 429 算作整批失败；5xx 和超时会按任务逐个重发，从而隔离有毒输入。阶段退避加了 50%–100% 的抖动。
- 实测（每项 3 次重复，64 份上传，200 ms/请求的假模型）：
  - 默认上限 8：ON 64.83 [60.23, 69.43] docs/s，OFF 65.20 [60.50, 69.91]，两者持平（修复前 ON 58.33，比 OFF 低约 10%）。
  - 每条输入另加 2 ms：ON 62.58 [58.46, 66.69]，OFF 63.07 [59.67, 66.48]，持平（修复前 ON 47.74，低 24%）。
  - 上限 2：ON 41.67 [35.68, 47.66]，OFF 19.57 [19.21, 19.93]，ON 为 OFF 的 2.1 倍，每 64 份文档 26–30 个 embeddings 请求（OFF 为 64 个）。
  结论应表述为"上限不成为瓶颈时与关闭持平；上限成为瓶颈时请求减少约 2–2.5 倍、吞吐约提高一倍"。不要引用旧报告里的"64→8 个请求"，也不要引用 probe-time docs/s 列（它是 1 s 轮询造成的假象）。
- 替换（PUT /documents/:docId）只在 pgvector 上支持。local 和 Qdrant 无法原子地替换一个文档的 chunk，因此返回 409，且在解析和嵌入之前就拒绝，async 模式同样不入队。
- 替换的排序统一使用数据库时钟：async 任务按其 created_at；同步写入不带请求时间，content_updated_at 由数据库 NOW() 写入。被更新请求抢先覆盖的替换：async 任务以 succeeded 结束并带 superseded: true（迁移 019 的列，GET /ingest-jobs/:jobId 会返回）；同步 PUT 返回 409 和 superseded: true。
- 注册表为 PostgreSQL 而索引不支持事务时（例如 Qdrant 配合独立 worker），相同字节的上传通过租户 + 哈希的 advisory lock 在进程之间串行化。
- worker 在 index 提交前（以及一步式 ingest 前）做一次带围栏的续租：已失去租约或已被交回的尝试不会再开始提交。
- advanceStage 幂等：提交已成功、只是响应丢失时，重试同一调用会返回成功，而不是当作丢了租约。claim 清扫把一个任务判为 succeeded 时，会一并删除它的阶段输出，不再保留到过期。
- vector:reindex --apply：先取索引写锁，再对文档行加 FOR UPDATE，只有 content_version 和 content_sha256 仍与读取字节时一致才写入，否则报告跳过（期间被替换或被删除）。复制路径（local/qdrant）在源 chunk 的版本与注册表不一致时同样跳过。
- 同一次检索中的版本一致性：融合时对每个文档只保留各路由返回结果中最新的内容版本。v2 及以后的 chunk 的 publicFilePath 为 documents/<id>/file?version=N；GET /documents/:docId/file?version=N 在 N 不是当前版本时返回 409（附 currentVersion），不会给出其他版本的 PDF。v1 链接保持不变（兼容性），所以 v1 引用在文档后来被替换后仍会打开新 PDF。同一次 agent 运行中 primary 与 follow-up 检索之间的版本固定尚未实现（属于 agent 侧）。

【零停机切换的表述更正】
index-switch 的数字来自只读 /chat、800 个 chunk，期间没有并发上传、删除或替换，也不含 retire，只能按这个范围引用。retire 对读者的影响以集成测试中的实测为准（最长约 100 ms）。

=== AGENTS.md paragraph (proposed, under Implementation Notes) ===
- Index-version lifecycle hardening:
  - `retireIndexVersion` is two-phase. A DDL-free transaction marks the version retired under the lifecycle lock. Then `dropRetiredIndexVersionStorage` drops the table in short lock_timeout attempts (RAG_INDEX_VERSION_RETIRE_LOCK_TIMEOUT_MS / _DROP_ATTEMPTS / _RETRY_DELAY_MS), because dropping a version table needs an AccessExclusiveLock on the documents table (FK triggers). A `dropPending` result is finished by running retire again. Never put the drop back into the state-change transaction.
  - `createIndexVersion` probes the new embedding space before any DDL.
  - A write target that is not the active version is best effort: `fenceFailedWriteSpace` marks non-active building/ready versions of a failing space `failed` in its own transaction before the upload's write transaction. Never fence from inside a write transaction, and never fence the active version's space.
  - The activation gate also compares each target document's chunk `documentVersion` (missing = 1) with `documents.content_version`. `--active-unreadable` (`allowUnreadableActive`) skips the comparisons with a missing active table and marks that version failed, never in grace.
  - `describeIndexVersions` always returns the live and pointer versions and pages only retired/failed history. Health calls it with `includeDrift: false`.
  - Migration 019 records `pointer_ttl_ms` on the pointer row: instances cache for min(own, registry); lifecycle windows use max(own, registry). Cache entries expire one TTL after the read started. Schema verification is single-flight per verification key on the pool path.
- Staged ingest hardening:
  - `isRetryableIngestError(error, stage)`: only parse/chunk 4xx are terminal; embed/index errors spend the retry budget and dead-letter with bytes kept unless the error says `retryable: false`.
  - The batcher merges only what the concurrency cap holds back and lingers only without a cap. Only CIRCUIT_OPEN and 429 fail a whole batch; 5xx and timeouts are isolated per job. Stage backoff is jittered (50-100%). The embeddings output cap is per space.
  - `advanceStage` is idempotent under its fence; the claim sweep deletes outputs of jobs it settles as succeeded.
  - Replacement is pgvector-only (409 elsewhere). Replacements are ordered by the database clock (`contentUpdatedAtFromDatabase`), and superseded jobs carry `superseded` (migration 019).
  - The worker does a fenced renew right before a commit.
  - With a PostgreSQL registry, non-transactional dedup takes the tenant content advisory lock.
  - `vector:reindex --apply` writes through `writeReindexedDocument` (index write lock, then document row FOR UPDATE, then a version/hash check).
  - Hybrid fusion keeps one content version per document (`keepNewestDocumentVersion`). Chunks of version >= 2 link to `documents/<id>/file?version=N`, and the file route answers 409 for a replaced version.
- Migrations 016-019 belong to the data track; 020-022 are reserved for the agent track.

=== npm scripts (server/package.json, proposed) ===
"vector:index": "node vector-index.mjs",
"ingest:jobs": "node ingest-jobs.mjs",
"test:pgvector": "node --test test/vector-store-pgvector.integration.test.mjs test/agent-execution-graph-postgres.integration.test.mjs test/postgres-row-level-security.integration.test.mjs test/ingest-jobs-postgres.integration.test.mjs test/vector-store-pgvector-versions.integration.test.mjs test/ingest-pipeline-postgres.integration.test.mjs"

Key files: /Users/luc1ferx/Desktop/Projects/Luc1ferxx_Archive_RAG/server/rag/vector-store-pgvector-version-lifecycle.js, .../server/rag/vector-store-pgvector-versions.js, .../server/rag/vector-store-pgvector.js, .../server/rag/vector-store.js, .../server/rag/index.js, .../server/rag/ingest-worker.js, .../server/rag/ingest-embedding-batcher.js, .../server/rag/ingest-pipeline.js, .../server/rag/ingest-job-store.js, .../server/rag/doc-registry.js, .../server/rag/db-migrations.js, .../server/rag/config.js (DATA block: RAG_INDEX_VERSION_RETIRE_*), .../server/db/migrations/019_bound_pointer_ttl_and_flag_superseded_jobs.sql, .../server/db/migrations/018_add_document_content_identity.sql (comment only), .../server/vector-reindex.mjs, .../server/vector-index.mjs, .../server/routes/uploads.js, .../server/routes/documents.js, plus tests in .../server/test/ (versions, lifecycle, CLI, route, pipeline, pipeline-routes, jobs, reindex, both integration suites, pgvector-version-fake-database.mjs).

## 查询跟随激活版本、并行建版本（2026-09-27）

#### 查询嵌入跟随活动版本
- 每个查询只嵌入一次，而且是在活动版本的嵌入空间里。`rag/embedding-cache.js` 嵌入之前先调用 `resolveServingQueryEmbeddingSpace`（`vector-store-pgvector-versions.js`）确定用哪个空间：
  - local、Qdrant，或者没有配置数据库时，用配置空间；
  - pgvector 时，用指针缓存里活动版本的空间。检索紧接着读的也是这份 TTL 缓存，所以不会多一次数据库往返。
- 活动版本固定在别的模型上时，直接用那个模型、它的查询前缀和宽度嵌入，不会先按配置模型再嵌入一次。
- 查询嵌入缓存只有一个 LRU，键是“嵌入空间 + 文本”：
  - 大小由 `RAG_EMBEDDING_CACHE_MAX` 决定（默认 256，所有空间共用）；
  - 过期时间是 `RAG_EMBEDDING_CACHE_TTL_MS`；
  - `RAG_EMBEDDING_CACHE_ENABLED=false` 关闭缓存。
- 原来单独给固定模型用的缓存（固定 256 条，不合并并发请求）已经删除。现在同一文本的并发请求只嵌入一次。
- 返回的向量带着它所在空间的标记。检索时标记和活动版本一致，就直接用这个向量。只有两种情况会按活动空间再嵌入一次（同样走这份缓存）：
  - 嵌入和检索之间指针变了，比如 TTL 刚过期时发生了切换或回滚；
  - 调用方传入自己按配置模型算的向量（没有标记，按配置空间处理），而活动版本固定在别的模型上。
- 入库不变：每个存活写目标的嵌入空间各嵌入一次。如果没有写目标在配置空间里，就不会按配置模型嵌入。
- 配置和活动版本不一致时，会报 `configuration_differs_from_active` 警告，出现在三个地方：
  - 健康检查的 `checks.vectorStore.indexVersions.warnings`；
  - `npm run vector:index -- status`；
  - `GET /admin/index-versions`。

  它是警告，不是错误，`checks.vectorStore.status` 仍为 ok。
- 警告带 `settings` 字段，只列出需要改的环境变量和取值：
  - `OPENAI_EMBEDDING_MODEL`、`RAG_EMBEDDING_DIMENSIONS`；
  - `RAG_EMBEDDING_QUERY_PREFIX` / `RAG_EMBEDDING_DOCUMENT_PREFIX`：活动版本的前缀不是该模型文档里的默认前缀，或者当前有一个换模型后仍会生效的覆盖值时才列出。空值表示关闭前缀。

  例如：`OPENAI_EMBEDDING_MODEL=nomic-embed-text RAG_EMBEDDING_DIMENSIONS=768`。
- 服务本身不受影响，但仍建议下次部署时按提示改配置，因为不带 `--model` 的 build 用的是配置空间。
- 回滚和指针 TTL 的语义不变。回滚后，查询随指针回到旧版本的空间；缓存里两个空间的条目互不影响。

=== docs/data-lifecycle.md：“构建：可恢复、带租约、分批”一节，替换第一条，并在“各种情况的处理”之后补充 ===
- 构建从文档注册表保存的 PDF 字节重新解析、分块，再用新版本自己的模型嵌入。
- 同时处理的文档数：`RAG_INDEX_VERSION_BUILD_CONCURRENCY`（默认 4）。CLI 用 `--concurrency`，build 和 resume 都可以用。
- 待处理文档按 `RAG_INDEX_VERSION_BUILD_BATCH_SIZE`（默认 16）一页一页地列出：
  - 游标只往前走，每个文档只会被取一次；
  - 一页的文档全部处理完，才刷新进度计数、续租、打印进度，页与页之间按列出的顺序进行；
  - 并发为 1 时，和原来的串行构建完全一样。
- 嵌入走入库流水线的跨文档合批器（`rag/ingest-embedding-batcher.js`，本进程的默认实例）：
  - 遵守 `RAG_LLM_MAX_CONCURRENCY`；
  - 有空闲槽位时，每个文档单独发一个请求；
  - 槽位全忙时，排队的文档等有请求结束后合并成一个请求发出；
  - 向量仍然按版本宽度校验。
- 每个文档仍然是一个独立事务，依次执行：
  1. 续租，并按 `builder_id` 做围栏（这是事务的第一条语句）；
  2. 对文档行加 `FOR SHARE` 锁；
  3. 替换 chunk；
  4. 写进度行。

  续租要锁版本行，所以同一个构建者的写事务在版本行上是一个接一个执行的。并行的是解析和嵌入。
- 出错时：第一个错误出现后不再领取新文档；已经在处理的文档各自提交或回滚，全部结束后才释放租约（或者把版本标记为 failed）。所以不会在还有写入进行时交出租约。
- 崩溃后的 resume 不变：只处理没有进度行或者之前失败的文档。进程被杀时还在处理中的文档没有进度行，resume 会补上。

=== docs/data-lifecycle.md：配置表 ===
- 修改 `RAG_INDEX_VERSION_BUILD_BATCH_SIZE` 一行的说明：每页列出的待处理文档数，进度计数按页刷新。
- 新增：| `RAG_INDEX_VERSION_BUILD_CONCURRENCY` | 4 | 构建时同时处理的文档数，每个文档仍是独立事务 |
- 新增：| `RAG_EMBEDDING_CACHE_MAX` | 256 | 查询嵌入缓存的条数，按“嵌入空间 + 文本”计，所有空间共用 |

=== docs/data-lifecycle.md：已知限制，追加 ===
- 并行构建时，同一个构建者的文档写事务在版本行上串行执行（每个事务都要先续租）。因此吞吐上限约为 1 / 单个文档写事务的时长。embedding 延迟越高，并行的收益越大。
- 查询向量的空间标记只挂在 `embedQueryCached` 返回的那个数组对象上。复制出来的向量没有标记，会按配置空间处理：活动版本固定在别的模型上时会再嵌入一次，结果仍然正确。

=== docs/data-lifecycle.md：测试，单元测试一段补充 ===
test/embedding-cache.test.mjs 覆盖：按空间分键的 LRU、条数上限、向量带空间标记。

=== docs/evaluation.md 的“索引切换与入库流水线”，以及 server/docs/interview/CURRENT-TRUTH.md 3.16：追加 / 替换“已知代价”和“8.8 篇/秒”两条 ===

**查询嵌入跟随活动版本、并行构建（2026-09-27）**

测试条件：
- 同一台机器，一次性 PostgreSQL 18.6 + pgvector 0.8.6；
- 假模型，embedding 100 ms/请求；
- 2 个实例，`--tenant`，`/chat` 并发 8；
- 200 篇文档 × 4 页，新版本从 1536 维换到 768 维，实例配置不改；
- 稳态阶段 20 s；
- 所有轮次都是 0 错误。

1. 激活与配置不同模型的版本后，`/chat` 吞吐：
   - 修改前：50.5 req/s。激活前是 144.5，下降 65%。p95 171.9 ms，每次 `/chat` 2 个 embedding 请求。
   - 修改后：144.3 req/s。激活前是 143.6，持平。p95 65.6 ms，每次 `/chat` 0 个 embedding 请求。另一轮：激活后 151.6，激活前 149.6。

   测量方法：
   - 修改前的代码是 85efbb6a，用 git archive 导出到临时目录，用同一份压测脚本运行；
   - 两边都在激活后先把每个问题在每个实例上问一遍（这部分结果丢弃），再测“new version active”阶段，和第一次测量前预热配置空间的做法一样。这样它和“before”阶段处于相同的缓存状态。

   数字要这样解读：
   - 修改前，固定模型那份 256 条的缓存装不下 800 个问题，所以一直在重新嵌入；
   - 这组数字里，大部分改善来自按空间分键、大小可配置的查询缓存；
   - 冷缓存下“每个查询只嵌入一次”（修改前是配置空间一次、固定空间再一次）由单元测试和集成测试验证，不是这组数字测出来的。
2. 并行构建（同一份代码，200 篇，embedding 100 ms）：
   - 并发 1：8.74 篇/秒（22.9 s）；
   - 并发 4：34.51 篇/秒（5.8 s），3.95 倍；
   - 修改前的串行构建：8.81 篇/秒。
   - 两组都是 201 个 embedding 请求：1 个创建时的探测请求，加每篇 1 个。模型并发上限 8 没有被用满，所以合批器没有合并请求。
   - 构建期间 `/chat` 吞吐 140.6，构建前 143.6（−2%）；p95 67.1 ms，构建前 66.8 ms。
3. 报告：`server/evaluation/results/latest-load-test-index-switch-{before,after,after-serial}.{json,md}`。
4. 命令：`cd server && bash scripts/run-load-test-pgvector.sh --scenario index-switch --instances 2 --tenant --documents 200 --embedding-latency-ms 100 --switch-phase-ms 20000 --model-latency-ms 0 --switch-build-concurrency 4 --latest-name latest-load-test-index-switch-after`。测串行时把 `--switch-build-concurrency` 改成 1。

CURRENT-TRUTH.md 3.16 中两条的替换文字：
- 建版本：79 篇/秒（embedding 0 ms，旧的串行数字）。embedding 100 ms 时，同时处理 4 篇为 34.5 篇/秒，串行为 8.7 篇/秒（3.95 倍）。每个文档仍是独立事务，写进度行，受同一个租约围栏保护。
- 激活与当前配置不同模型的版本后，每个查询只在活动版本的模型里嵌入一次，查询缓存按嵌入空间分键。激活后 `/chat` 吞吐 144.3 req/s，激活前 143.6（修改前是 50.5，−65%）。配置不一致只作为健康警告，并给出要改的具体设置。

锁顺序是固定的，不会形成环：
- 生命周期操作（注册、切换、退役）：指针行 → 版本行 → advisory 锁 → DDL；
- 写入者（ingest、替换、删除、清空、vector:reindex）：先拿 advisory 锁，再锁文档行，最后才碰 chunk 行。ingest 先登记文档行；替换、`vector:reindex` 和删除先对文档行加 `FOR UPDATE`；
- 构建者不拿 advisory 锁，顺序是：文档行（`FOR SHARE`）→ 该文档的 chunk 行 → 版本行（续租）→ 进度行；
- 围栏（fence）和接管租约（claim）只锁版本行。

生命周期事务锁住的版本行，不会是构建者正在等的那一行：激活锁的是 active/ready 版本；退役在自己的事务开始之前，先把它可以中止的构建单独标成 failed。

=== docs/data-lifecycle.md：“构建”一节，替换“嵌入走入库流水线的跨文档合批器”和“每个文档仍然是一个独立事务”两条 ===
- 嵌入走入库流水线的跨文档合批器（`rag/ingest-embedding-batcher.js`，本进程的默认实例），向量仍然按版本宽度校验：
  - 遵守 `RAG_LLM_MAX_CONCURRENCY`；
  - 只有上限小于同时处理的文档数时，才会有文档排队，排队的文档再合并成一个请求。默认配置（4 篇在处理、上限 8）下每篇文档单独一个请求；
  - `RAG_INGEST_EMBED_BATCHING=false`（入库的合批开关）对构建同样生效：每篇文档单独一个请求。
- 每个文档仍然是一个独立事务，依次执行：
  1. 对文档行加 `FOR SHARE`，确认内容没变；
  2. 替换该文档的 chunk；
  3. 续租：`UPDATE` 版本行，条件是 `builder_id` 和 `status = 'building'`。租约被接管、或者版本已被 fence/退役时，整个事务回滚；
  4. 写进度行。

  版本行只在续租到 COMMIT 这一小段时间里被锁住。所以不同文档的 chunk 写入可以并行；上传失败时触发的 fence 也只需要等最多几次提交，不用排在整篇文档的写入后面。
  - 原来续租是事务的第一条语句，版本行从头锁到提交：4 个文档并行时写事务一个接一个。fence 的 `lock_timeout` 只有 2 秒，可能等不到，上传就会失败。
- 删除、重新上传和构建同时发生时：删除现在先锁文档行，再删 chunk，和其他写入者的顺序一致。
  - 原来删除是先删各版本表里的 chunk、再删文档行，和构建者的顺序正好相反。如果构建者正在重写这篇文档（例如构建期间上传、双写进来的文档），两边会死锁，其中一方报错。

=== docs/data-lifecycle.md：“回滚与退役”的 retire 条目后补一条 ===
- 退役正在构建的版本（`--force`，或者租约已过期、已释放）时，先用一条单独的语句把它标成 failed，再开始退役事务。
  - 这样仍在进行的构建事务续租时直接失败，不会一边拿着文档行、一边等退役锁住的版本行；否则构建者、等这个文档行的写入者、等写入者的退役三方会死锁。
  - 返回值里 `previousStatus` 仍是 `building`。
  - 退役事务里如果看到版本还在 building（租约活着、没带 `--force`），就拒绝。

=== docs/data-lifecycle.md：“查询嵌入跟随活动版本”一节，`settings` 那条补充 ===
- `RAG_EMBEDDING_DIMENSIONS` 按“改完模型之后配置会得到的宽度”来比较：
  - 没有显式设置时，宽度跟着新模型走（已知宽度，否则默认 1536）；
  - 显式设置了，就保持不变。

  例如配置是 `text-embedding-3-small`、活动版本是 `text-embedding-3-large@1536` 时，给出 `OPENAI_EMBEDDING_MODEL=text-embedding-3-large RAG_EMBEDDING_DIMENSIONS=1536`，改一次就够。

=== docs/data-lifecycle.md（或 docs/evaluation.md）：索引切换压测结果，替换上一轮的“-65% → +0.5%”和“构建期间 /chat -2%” ===
测量条件：
- 同一台机器，一次性 PostgreSQL 18.6 + pgvector 0.8.6；
- 假模型：每个 embedding 请求固定 100 ms，与输入多少无关，可以并行，没有限流；
- 2 个实例，按租户走行级安全，`/chat` 闭环并发 8；
- 200 篇文档 × 4 页；新版本把模型从 1536 维换成 768 维，实例配置不改；
- 关闭查询缓存（`--no-embedding-cache`），所以每个查询真实的嵌入次数都会显示出来。

| | 旧代码 85efbb6a | 新代码 |
|---|---|---|
| 激活后每个 /chat 的嵌入次数 | 3.98（配置模型 2.00 + 固定模型 1.98） | 2.01（固定模型 1.86 + 配置模型 0.15） |
| 激活前后吞吐 | 29.60 → 21.19 req/s（-28.4%） | 29.20 → 28.79 req/s（-1.4%） |
| 激活前后平均延迟 | 273 → 378 ms | 277 → 278 ms |

- 新代码的 0.15 次配置模型嵌入，全部发生在切换后约 2 秒的指针 TTL 内。
- 上一轮的“-65% → +0.5%、0 次嵌入”测的是缓存大小，不是“只嵌入一次”：
  - 压测脚本把 `RAG_EMBEDDING_CACHE_MAX` 设成 6464，能装下整个问题池，并且激活后先预热；
  - 旧代码里给固定模型单独用的缓存写死只有 256 条，装不下约 1600 个检索查询；
  - 所以“每个 /chat 0 次嵌入”只在这种与问题池一样大、并且预热过的缓存下成立。用默认的 256 条缓存或不重复的问题时，每个检索查询仍要嵌入一次，大约每个 /chat 2 次。

构建（同样的无缓存运行，数字只代表“假模型、延迟固定、瓶颈在嵌入”的最好情况）：
- 旧代码串行：8.57 篇/秒；新代码 4 篇并行：33.2 篇/秒（3.87 倍）。两边都是 201 个 embedding 请求（1 个创建探测 + 每篇 1 个）。
- 构建期间 /chat（每个请求 2 次 embedding）：新代码 30.13 对构建前 29.20 req/s，旧代码 30.05 对 29.60。这个假模型不限流，模型调用上限是每个进程各自的，而且按模型区分，所以构建请求和 /chat 从来不争同一份限额。这组数只反映数据库和主机的争用，不代表真实服务商在 RPM/TPM 限额下的情况。
- 上限 2（`RAG_LLM_MAX_CONCURRENCY=2`，每个进程各自一份，CLI 也一样）、4 篇并行：25.13 篇/秒，200 篇文档只用了 152 个请求（加 1 个探测共 153），合批确实生效。/chat 受上限限制，只有约 19.6 req/s，构建期间 19.25。

=== server/docs/interview/CURRENT-TRUTH.md：3.17 索引部分（先写数字）===
- 激活一个和当前配置模型不同的版本后，查询只按活动版本的模型嵌入一次。
  - 测量条件：关闭查询缓存，embedding 100 ms，假模型；
  - 每个 /chat 的 embedding 从 3.98 次降到 2.01 次；
  - 激活后吞吐从 -28.4% 变成 -1.4%。
  - 上一轮说的 -65% → +0.5% 主要是压测缓存大小造成的，不引用。
- 版本构建 4 篇并行：33.2 篇/秒，串行是 8.57 篇/秒（3.87 倍），条件是假模型、延迟固定、不限流。模型并发上限为 2 时 25.1 篇/秒，200 篇只发 152 个请求。
- 审查修掉 6 个问题：
  - 续租挪到 chunk 写入之后，fence 不再排在整篇文档的写入后面；
  - 删除先锁文档行，不再和构建者死锁；
  - 退役正在构建的版本时先停掉构建，避免三方死锁；
  - 换模型的配置建议会带上宽度；
  - 构建遵守 `RAG_INGEST_EMBED_BATCHING=false`；
  - 压测说明改正（缓存阶段测的是缓存大小）。

=== AGENTS.md：替换 Index versions 下的 “Builders fence every write …” 条目 ===
  - Builders lock the document row `FOR SHARE`, write its chunk rows, then renew the lease. The renewal is an UPDATE of the version row fenced on `builder_id` and `status = 'building'`; it is the transaction's last lock, right before the progress row. Progress rows commit with the chunks, which is what makes `resume` exact. Every other writer locks the document row before any chunk row: ingest registers it first, and replacement, `vector:reindex` and `deleteDocument` lock it `FOR UPDATE` first. `retireIndexVersion` stops a build it may abort (`--force`, or an expired or released lease) in a statement of its own (`stop_build`, status failed) before its transaction locks the version row; after that, builders' lease checks never wait for that row. Do not move the renewal back to the start of the document transaction: fences would then queue behind whole-document writes and hit their 2 s `lock_timeout`. Do not lock a building version's row in a lifecycle transaction without stopping the build first: builder, writer and retire can deadlock. `test/vector-store-pgvector-versions.integration.test.mjs` reproduces all three races. Builds embed through `resolveBuildEmbeddingBatcher()`. It merges documents only when `RAG_LLM_MAX_CONCURRENCY` is below `RAG_INDEX_VERSION_BUILD_CONCURRENCY`, and `RAG_INGEST_EMBED_BATCHING=false` sends one request per document. Quote query-embedding costs of the index-switch load test from a `--no-embedding-cache` run: the cached run's harness sizes the cache to the whole question pool and warms it, so its after-activation phase measures the cache.

=== npm scripts（server/package.json）===
"eval:load-test:index-switch:no-cache": "bash scripts/run-load-test-pgvector.sh --scenario index-switch --instances 2 --tenant --documents 200 --embedding-latency-ms 100 --switch-phase-ms 20000 --model-latency-ms 0 --no-embedding-cache --switch-build-concurrency 4 --latest-name latest-load-test-index-switch-no-cache"
(Keep the previous round's eval:load-test:index-switch. Its after-activation numbers describe a cache the size of the question pool.)
