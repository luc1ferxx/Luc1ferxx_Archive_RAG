# 06 多租户隔离与安全

> 范围：多租户隔离与安全（鉴权/租户解析、PostgreSQL 行级安全与角色拆分、注册表与成员、限流配额、生命周期擦除导出、信封加密与 crypto-shred、审计哈希链、缓存时序侧信道）
>
> 回到 [总手册](../DEEP-DIVE-PLAYBOOK.md)。数字出处以 [CURRENT-TRUTH.md](../CURRENT-TRUTH.md) 和 `docs/evaluation.md` 为准；代码位置写成「路径 + 函数/常量名」，均经核验代理 grep 确认。

## 30 秒讲法

租户就是访问范围 (userId, workspaceId)，由凭据决定（静态 token、HS256 JWT、OIDC）：凭据带 userId 就用它，客户端传的 userId 不认；凭据固定或列出了 workspace 时，x-workspace-id 只能在里面选，并规范成小写。认证后的空范围在入口直接 403（单共享 token、/auth/me 和平台路由除外），因为空范围在数据库层等于"所有租户"。隔离分两层：应用层每个 store 自己带过滤条件；PostgreSQL 行级安全再兜一层。AsyncLocalStorage 带着租户，`set_config('role', …, true)`（即 SET LOCAL ROLE）和业务语句用扩展协议在一次往返里发出，17 张表的 tenant_isolation 策略挡住其他租户的行。自建探测里，一条漏写过滤条件的查询原本会泄露 9/9 张表，开 RLS 后是 0/9；租户路径每次 /chat 的往返从 167 降到 22。外面一圈都是可选开关，默认基本关：strict 上下文和数据库角色拆分（上下文丢了就失败，不退回 owner）、成员制和 RBAC 路由表、按租户的限流和配额、擦除和导出、每对象信封加密加擦除时销毁密钥（crypto-shred）、审计哈希链、缓存按租户分区。要主动说清楚：API 鉴权默认关（默认就是单租户）；RLS 不防 SQL 注入；加密只覆盖文件字节；本地 KMS 只到演示级；这些开关全开的组合只在单机单体上用 e2e 验证过。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `server/auth.js` | 认证与租户解析：resolveAuthenticatedPrincipal（静态 token 用 constantTimeEqual / OIDC / HS256），buildAccessScope→resolveUserId、resolveWorkspaceId（getRequestValue 依次读 header、body、query）；requireTenantScope 拒绝空范围；checkTenantMembership；resolveRefusalLedgerScope；bindDatabaseTenant 绑租户上下文；requireApiAuth 串起整条链；TENANTLESS_PLATFORM_PATHS |
| `server/access-scope.js` | normalizeScopeId：workspace id 去空白后转小写，授权比较按它做 |
| `server/rag/postgres-tenant.js` | AsyncLocalStorage 维护四种上下文 tenant/system/unscoped/unbound（DATABASE_TENANT_CONTEXTS，system/unscoped 是冻结单例，按身份比较）；runWithDatabaseTenant、runAsDatabaseSystem、toDatabaseTenant |
| `server/rag/postgres.js` | 每条语句的身份决策 resolveStatementRole；TENANT_SETTINGS_SQL / SYSTEM_SETTINGS_SQL；PipelinedQuery + runPipeline 单往返流水线，transactionStatusAfterFailure 判断失败后能不能还回连接池；assertDatabaseContextBound（strict 且 RLS enforce 时生效）；角色拆分下 withPostgresClient 拒绝（ARCHIVE_RAG_ROLE_SPLIT_RAW_SESSION），owner 池只给 system 上下文（assertOwnerWork） |
| `server/db/migrations/013_enable_tenant_row_level_security.sql` | 租户角色 NOLOGIN；PG16 起 GRANT ... WITH SET TRUE；各表 tenant_isolation 策略（ENABLE 而非 FORCE，只作用于租户角色） |
| `server/db/migrations/033_harden_sparse_rank_function.sql` | __DOCUMENT_CHUNKS_TABLE___install_sparse_rank：014 的 SECURITY DEFINER 排序函数在租户角色下先按文档策略收窄 doc_id；search_path 固定、enable_indexscan=off、ROWS 20、REVOKE FROM PUBLIC |
| `server/db/migrations/030_create_sparse_bm25_statistics.sql` | __DOCUMENT_CHUNKS_TABLE___install_bm25：为每张分块表建 BM25 统计表、触发器和 SECURITY DEFINER 的 <chunks>_sparse_search；函数在租户角色下同样按文档策略收窄 doc_id。默认 BM25 走的是这个函数 |
| `server/db/migrations/035_create_system_role.sql` | NOLOGIN system 角色 + system_access 策略，供角色拆分使用 |
| `server/rag/db-migrations.js` | renderRuntimeRoleGrantSql：角色拆分时把租户角色和 system 角色授给运行时登录（WITH INHERIT FALSE, SET TRUE） |
| `server/rag/vector-store-pgvector.js` | searchPgvectorSparseDocuments：默认（BM25 或开着剪枝的多文档）走 runSparseSearchFunction，调迁移 030 的函数；只有 ts_rank_cd 且关掉剪枝时，多文档才用 buildTenantSparseSearchSql（先以租户身份在 documents 表筛 doc_id，再调 014/033 的 _sparse_rank，最后以租户身份 JOIN 回 chunks 表） |
| `server/rag/vector-store-pgvector-sparse.js` | usesPgvectorSparseSearchFunction（bm25，或剪枝开且多于 1 篇文档时为真）；buildPgvectorSparseSearchSql |
| `server/health.js` | checkRowLevelSecurityHealth：检查租户角色不是 SUPERUSER/BYPASSRLS、不拥有任何表、对没有策略的表没有权限；roleSplit 子项；getRowLevelSecurityTables 列出 17 张表，运行时再加上每个 live 索引版本的分块表和 BM25 统计表 |
| `server/rag/rbac.js` | RBAC_PERMISSION_IDS（8 个普通权限）；RBAC_ROUTE_TABLE 登记每条路由；describeEffectiveAccess 合并全局角色、workspace 角色和默认角色；matchRbacRoute / decideRbacRequest / createRbacMiddleware；assertRbacConfiguration |
| `server/rag/oidc.js` | 零依赖的 OIDC 资源服务器：ALGORITHM_SPECS 白名单、MIN_RSA_MODULUS_BITS=2048、JWKS 缓存和限速刷新（createOidcVerifier） |
| `server/rag/tenant-registry.js` | 工作区/成员注册表；decideTenantMembership（注册表故障返回 503，不放行）；resolveMembershipRefusalTenant；workspaceCacheKey（TENANT_REGISTRY_CACHE_SCOPE=tenant 时按请求用户分区）；MAX_SCOPE_WORKSPACE_ROLES |
| `server/rag/tenant-limits.js` | 按租户的固定窗口限流（chat/ingest/destructive/default 四个成本类别，classifyTenantLimitRequest、resolveTenantLimitKey）和并发上限（createTenantRateLimiter / createTenantConcurrencyLimiter）；RAG_SHARED_STATE=redis 时用 Lua 脚本共享 |
| `server/rag/model-call-guard.js` | createTenantFairQueue：模型调用等待队列，最近最少被服务的租户先出队，同一租户内 FIFO；FAIR_QUEUE_MAX_TRACKED_TENANTS |
| `server/rag/model-quotas.js` | 进程内模型配额：调用在额度内才放行，token 在模型回答后才扣，在途调用可能超出 |
| `server/rag/tenant-storage-quota.js` | 存储配额：上传时 assertTenantStorageQuotaAllows 预检；提交事务里先 lockTenantStorageQuota（advisory 锁）再 assertTenantStorageQuota |
| `server/rag/tenant-usage.js` | 按小时的用量账本，以 runAsDatabaseSystem 异步刷写；stopTenantUsageLedger / flushTenantUsageOnExit |
| `server/rag/tenant-refusals.js` | recordTenantRefusal 统一记录拒绝（指标只带错误码，账本按租户） |
| `server/rag/tenant-lifecycle.js` | TENANT_STORE_IDS 固定擦除顺序、先标 deleting、默认 dry run（dryRun = true）、写墓碑、所有存储成功后才销毁密钥；导出 NDJSON；TENANT_LIFECYCLE_ERROR_CODES |
| `server/rag/tenant-encryption.js` | 信封加密 encryptTenantBytes / maybeEncryptTenantBytes / decryptTenantBytes，payloadAad/dataKeyAad 绑定 (kind, objectId, workspaceId, userId)；rewrapTenantEnvelope；destroyTenantKeysForErase；documentFileContext |
| `server/rag/kms/key-scope.js` | resolveTenantKeyScope（每 workspace 一把，没有 workspace 时按用户，key id 是 tk_ 加哈希）；resolveTenantKeyScopesForErase |
| `server/rag/kms/local-provider.js` | createLocalTenantKmsProvider：演示级本地 KMS |
| `server/rag/admin-audit-chain.js` | computeAdminAuditRowHash：row_hash=sha256(prev_hash\|\|规范化行)；getAdminAuditChainLockKey；createAdminAuditChainVerifier 找第一处断裂；ADMIN_AUDIT_CHAIN_BREAKS |
| `server/rag/postgres-admin-audit-store.js` | 同一条链用 pg_advisory_xact_lock 串行写入，事务固定 READ COMMITTED；scanChainRows 在一个快照里校验 |
| `server/rag/data-access-audit.js` | 破坏性操作先写意图记录，写不进去就 sendAuditUnavailable 返回 503 AUDIT_UNAVAILABLE、不执行 |
| `server/rag/embedding-cache.js` | embedQueryCached；describeFlightTenant；RAG_EMBEDDING_CACHE_SCOPE=tenant 时 buildCacheKey 带上租户分区 |
| `server/rag/memory.js` | resolveSessionMemoryKey：tenant: + sha256(userId\0workspaceId\0sessionId) |
| `server/rag/agent-runs.js` | stripInternalRunFields：公开的事件 id 改写成 runId:n |
| `docs/tenant-isolation.md` | 威胁模型、分层防御、默认值、2026-10-18 的完整验证、已知限制 |

## 一次请求怎么经过这里

一次 POST /chat（pgvector、API_AUTH_ENABLED=true）：
1. app.js 挂载顺序：stripInternalServiceHeadersMiddleware（定义在 rag/service-identity.js，剥掉 x-archive-service-* 头）→ helmet / cors / 静态前端 → express.json → createSystemRouter（/health、/ready、/livez）→ createAuthConfigRouter（/auth/config）→ 按 IP 的 express-rate-limit（只在 RATE_LIMIT_ENABLED=true 时挂，默认关）→ requireApiAuth。探针和 /auth/config 在 IP 限流和鉴权之前。
2. requireApiAuth：getProvidedToken → resolveAuthenticatedPrincipal（静态 token 用 constantTimeEqual；开 OIDC 时 JWS 交给 verifyOidcAccessToken，HS* 且开了 HS256 JWT 时除外；否则交给 verifyJwtAuthToken）→ buildAccessScope（resolveUserId：凭据自带 userId 就用它；auth off、单共享 token、allowClientUserId 条目可以由客户端选；其余情况请求里带 userId 就 403。resolveWorkspaceId：凭据固定 workspace 时请求只能与它一致；有列表时只能在列表里选并规范成小写；两者都没有时请求里写什么就用什么）→ requireTenantScope（空范围 403）→ checkTenantMembership（只在 TENANT_MEMBERSHIP=enforce 时走 decideTenantMembership；被拒时 recordTenantRefusal，记在 resolveRefusalLedgerScope 决定的租户名下）。
3. bindDatabaseTenant → runWithDatabaseTenant：把范围放进 AsyncLocalStorage（没有租户的范围记为 unscoped 单例）。
4. noStoreTenantData：设置 Cache-Control: private, no-store 和按凭据区分的 Vary。
5. tenantLimits.middleware（只有开了按租户限流或并发上限才挂）：classifyTenantLimitRequest 判成本类别，resolveTenantLimitKey 取键（workspace > user > IP），超限 429。
6. createRbacMiddleware（RBAC_MODE=off 时直接放行）→ decideRbacRequest：matchRbacRoute 查 RBAC_ROUTE_TABLE，describeEffectiveAccess 算权限；拒绝时 403 并写审计。
7. 路由里的 store 仍按 accessScope 过滤（documentMatchesAccessScope 等）。每条 SQL 经 queryPostgres：assertDatabaseContextBound（strict 且 RLS enforce 时，unbound 报错）→ resolveStatementRole（租户时用 TENANT_SETTINGS_SQL：role、user_id、workspace_id、两个超时，全部是绑定参数）→ runPipeline / PipelinedQuery：设置语句和业务语句在一次往返里发出、一个 Sync 结束，失败后不能证明事务状态正常的连接直接销毁 → 数据库按 tenant_isolation 策略过滤。
8. 检索：稠密路走普通租户语句。稀疏路默认 BM25：searchPgvectorSparseDocuments 里 usesPgvectorSparseSearchFunction 为真 → runSparseSearchFunction 调迁移 030 的 SECURITY DEFINER 函数 <chunks>_sparse_search，函数在租户角色下自己按文档策略谓词收窄 doc_id，结果以租户身份 JOIN 回分块表。只有 RAG_SPARSE_SCORING=ts_rank_cd 且关掉常见词剪枝时，多文档才走 buildTenantSparseSearchSql 加 014/033 的 _sparse_rank。查询 embedding 走 embedQueryCached（tenant 档时缓存键带 describeFlightTenant）。
9. 模型调用：可选的模型配额，加上 model-call-guard 的并发守卫（等待队列 createTenantFairQueue 按租户公平）→ 用量按调用时的数据库租户记进 tenant-usage，每 TENANT_USAGE_FLUSH_MS 以 runAsDatabaseSystem 刷写。
10. 会话记忆用 resolveSessionMemoryKey 派生的键读写。
上传分支（POST /upload）：upload.single 之后再挂一次 bindDatabaseTenant（multer 内存存储会丢异步上下文）→ 配了存储配额时 assertTenantStorageQuotaAllows 预检 → commitDocument（一个 withPostgresTransaction）：beginVectorIndexWrite 拿索引写锁 → 开去重时 lockDocumentContentHash 内容哈希锁 → 配了配额时 lockTenantStorageQuota（advisory 锁）→ 替换时锁文档行 → assertTenantStorageQuota → registerDocument（doc-registry.js 里 maybeEncryptTenantBytes(documentFileContext)，带 WITH CHECK 的插入）→ writeDocumentsToIndex。ADMIN_AUDIT_DATA_EVENTS=on 时，破坏性路由先写意图记录（失败返回 503 AUDIT_UNAVAILABLE）；审计写入在链的 advisory 锁下算 computeAdminAuditRowHash。

## 设计决策

### D1. 应用层过滤 + PostgreSQL RLS 两道防线（共享表 / pool 模型），策略只作用于租户角色（ENABLE，不用 FORCE）

**为什么**

防的是"某个 store 漏写 WHERE"这类 bug：中间的代码从不把范围传给数据库层，漏写过滤条件的查询也只能看到调用方自己的行；所有租户共用一套索引、迁移和索引版本，运维成本最低

**为什么不用主流替代方案**

只做应用层过滤（含 LangChain/LlamaIndex 的 metadata filter）：一处漏写就泄露，没有第二道。schema-per-tenant：每个租户一份 chunk 表加 HNSW/GIN，再乘上索引版本（迁移 016），表数会爆炸，search_path 也是会话状态。每租户一个库（silo）：隔离最强，但运维重，文档明确列为没实现

**代价**

每条语句要先切角色、设变量；非 leakproof 运算符在 RLS 下不能当索引条件（全文检索因此要绕路）；owner 不受策略约束，上下文丢了等于看到全部租户（后来靠 strict 和角色拆分补上，两者默认都关）；吵闹邻居要单独靠限流和配额处理

**证据**

CURRENT-TRUTH 3.8 / docs/evaluation.md「租户隔离（数据库行级安全）」（2026-09-25，PG 18.6 + pgvector 0.8.6，20 租户、10000 切块，一次性库，自建探测）：漏写过滤的查询泄露 9/9 表、9728 行 → 0/9、0 行；越权读写 5/5 → 0/5。每条语句 p50 多 0.15–0.25 ms，这是流水线优化之前的数字

**代码**：server/db/migrations/013_enable_tenant_row_level_security.sql；server/rag/postgres.js resolveStatementRole；server/health.js getRowLevelSecurityTables

### D2. 租户靠 AsyncLocalStorage 隐式传递，每条语句在事务内用 set_config('role', $1, true)（即 SET LOCAL ROLE）切到租户角色并设置租户变量；角色和 id 都是绑定参数

**为什么**

LOCAL 设置在事务结束时自动失效，连接回到池里不会还带着租户身份；绑定参数避免把 id 拼进 SQL；store 代码不用改签名

**为什么不用主流替代方案**

每个查询显式传 scope：调用链很长，漏传就会退回 owner。会话级 SET ROLE：一旦 reset 失败，下一个借连接的人就以别人的身份执行（withPostgresClient 的注释里写了角色拆分下的同类风险）。会话级变量放在 pgbouncer 事务池后面会串到别的客户端，事务级 LOCAL 不受影响（通用知识，项目没在 pgbouncer 下测过）

**代价**

异步上下文会丢，例如 multer 内存存储从流回调里恢复执行链，所以 /upload、/upload/chunk、PUT /documents/:docId 都在 upload.single 后面重新挂 bindDatabaseTenant；后台任务要自己 runWithDatabaseTenant；系统工作要显式包一层 runAsDatabaseSystem

**证据**

CURRENT-TRUTH 3.8：做的过程中发现进程级 registry 在租户请求里首次加载只装进了该租户的文档，改为以 owner 身份加载；multer 丢上下文后补了重新绑定

**代码**：server/rag/postgres-tenant.js runWithDatabaseTenant / runAsDatabaseSystem；server/rag/postgres.js TENANT_SETTINGS_SQL；server/routes/uploads.js（upload.single 之后再挂 bindDatabaseTenant）

### D3. 租户设置和语句用扩展协议流水线一次往返发出（PipelinedQuery：每条 Parse/Bind/Execute，最后一个 Sync）

**为什么**

原来每条租户语句都是 BEGIN、设置、语句、COMMIT 四次往返，一次 /chat 要 167 次。PG 把同一个 Sync 之前的消息当成一个隐式事务，所以 LOCAL 设置仍只在这次有效，出错就回滚

**为什么不用主流替代方案**

保留四次往返：多实例时数据库成为瓶颈。用 multi-statement 简单协议把 SET 拼进一条字符串：要拼 SQL 文本，不能用绑定参数。连接级缓存租户：违背"连接不带租户身份"的原则

**代价**

依赖 pg 内部的 Submittable 接口，升级 pg 要跑 postgres-tenant-pipeline 测试；native 绑定退回四次往返；在 Sync 时提交，所以 Sync 之后客户端出错（query_timeout、断连）时结果未知；一次调用不能带多条分号分隔的语句；租户语句如果留下打开的事务块，调用失败（ARCHIVE_RAG_TENANT_PIPELINE_STATUS）并销毁连接

**证据**

docs/evaluation.md「每次 /chat 的数据库往返（2026-09-27）」：租户路径往返 167 → 22，owner 路径 46 → 20（并发 1，pg_stat_statements 差值法）；租户 4 实例并发 32 吞吐 205 → 283 req/s（+37.9%），1 实例 +12.6%；4 实例 PG 每请求 CPU 7.7 → 4.0 ms。这里同时包含 run store 不再回读（读事件 15、读 run 行 11 → 0）的改动

**代码**：server/rag/postgres.js PipelinedQuery / runPipeline / transactionStatusAfterFailure / TENANT_PIPELINE_STATUS_ERROR_CODE

### D4. RLS 下多文档全文检索改走 owner 身份的 SECURITY DEFINER 函数：函数用 GIN 找候选、打分，只返回 chunk_id 和分数；函数在租户角色下按文档策略谓词收窄 doc_id；最后以租户身份 JOIN 回分块表。演进三步：迁移 014 的 _sparse_rank（调用方先以租户身份筛 doc_id）→ 迁移 033 在函数内再收窄一次 → BM25 成为默认后改走迁移 030 的 <chunks>_sparse_search（同样的函数内收窄加 JOIN 回）

**为什么**

@@ 背后的 ts_match_vq 不是 leakproof，RLS 下不能当索引条件，GIN 用不上，1000 篇文档时要逐行解压 5 万个 search_vector（约 150 ms）。函数以 owner 身份用索引，最终返回哪些行仍由 RLS 决定

**为什么不用主流替代方案**

把函数标成 LEAKPROOF：PG 里只有超级用户能这样标（通用知识），而且它确实可能通过报错泄露信息。全文检索搬到 ES/OpenSearch：隔离要在第二个系统里重做，删除和擦除要跨系统保持一致。接受 150 ms 慢查询：规模上不可接受

**代价**

候选打分这一步绕过 RLS，这是用户明确同意的设计；因为租户角色有 EXECUTE 权限，函数内部必须自己收窄，否则直接调用并传入别人的 doc_id 就能知道"哪份文档含哪个词"；审查发现过"先截断再过滤"会泄露这类信息；每个索引版本的表都要单独安装函数

**证据**

docs/evaluation.md「全文检索与行级安全（迁移 014）」（2026-09-26，合成数据，RLS enforce，每组 100 条查询，当时是 ts_rank_cd 走 014 的函数）：10 万块、1000/2000 篇 sparse p50/p95 141.9/157.0 → 18.7/57.6 ms；1 万块、100/200 篇 8.3/10.6 → 2.3/5.1 ms；全部 2000 篇时 p95 基本不变（138.4 → 134.4）。之后的常见词剪枝（迁移 030，CURRENT-TRUTH 3.18；docs/retrieval-tuning.md「BM25 与常见词剪枝」→「实测」）在 10 万块、2000 篇全表上：100 条混合查询中含常见词的 11 条，ts_rank_cd p50/p95 135/180 → 39/49 ms（BM25 281/389 → 40/51 ms），100 条整体 ts_rank_cd p95 135 → 73 ms

**代码**：server/rag/vector-store-pgvector.js searchPgvectorSparseDocuments / runSparseSearchFunction / buildTenantSparseSearchSql；server/rag/vector-store-pgvector-sparse.js usesPgvectorSparseSearchFunction / buildPgvectorSparseSearchSql；server/db/migrations/030_create_sparse_bm25_statistics.sql __DOCUMENT_CHUNKS_TABLE___install_bm25；server/db/migrations/033_harden_sparse_rank_function.sql __DOCUMENT_CHUNKS_TABLE___install_sparse_rank

### D5. 四种上下文状态 + 可选 strict 模式 + 可选数据库角色拆分（运行时登录什么都不拥有；system 工作切到 NOLOGIN 的 system 角色；DDL 走单独的 owner 池，且只允许在 system 上下文里用）

**为什么**

策略是 ENABLE 不是 FORCE，owner 不受约束：上下文丢失（unbound）的语句以 owner 执行会读到所有租户。strict 让它直接报错；角色拆分后即使是 lenient 模式，它也会以 42501 失败（fail-closed）

**为什么不用主流替代方案**

FORCE ROW LEVEL SECURITY：迁移、启动加载、跨租户恢复扫描都需要绕过策略，强制后得给每张表写 owner 例外。一直让 unbound 回落到 owner（原状）：等于失效时开放

**代价**

默认是 lenient、不拆分（为了兼容），所以默认状态下上下文丢失仍然 fail-open；角色拆分需要 CREATEROLE 或 DBA 先建 system 角色；拆分下 withPostgresClient 直接拒绝（ARCHIVE_RAG_ROLE_SPLIT_RAW_SESSION）；评测脚本以 unbound 查询，不能在评测读的 .env 里开 strict；角色拆分防不住 SQL 注入（运行时登录仍能切进 system 角色）

**证据**

无性能实测。正确性证据：test/postgres-strict-tenant-context-sweep.test.mjs、test/postgres-strict-tenant-context.e2e.test.mjs、test/postgres-role-split.test.mjs、test/postgres-role-split.integration.test.mjs；hardened e2e 日志里没有 ARCHIVE_RAG_TENANT_CONTEXT_MISSING 和 permission denied（docs/demo-tenant-isolation.md「e2e 测试」）

**代码**：server/rag/postgres-tenant.js DATABASE_TENANT_CONTEXTS；server/rag/postgres.js assertDatabaseContextBound / resolveStatementRole / withPostgresClient / assertOwnerWork；server/db/migrations/035_create_system_role.sql；server/rag/db-migrations.js renderRuntimeRoleGrantSql（GRANT ... WITH INHERIT FALSE, SET TRUE）

### D6. 租户由凭据决定：凭据带 userId 时客户端选不了用户；凭据固定或列出 workspace 时只能在其中选，并规范成小写；认证后的空范围直接 403；启动时拒绝没有任何范围的 token

**为什么**

空范围在 registry、反馈、入库过滤和 toDatabaseTenant 里都会被当成"所有租户"（owner 路径、没有 RLS）；大小写不一致会让数据库租户和授权检查各用各的值

**为什么不用主流替代方案**

信任客户端传的 x-user-id 或请求体里的 userId（旧行为）：同一 workspace 的 token 能冒充其他用户。API 网关统一鉴权、后端完全信任：拆分部署时内部端口一旦暴露就没有任何防线

**代价**

单共享 API_AUTH_TOKEN 和 auth off 是有意保留的单租户模式，客户端可以选 userId；凭据既不固定也不列出 workspace 时，默认（TENANT_MEMBERSHIP=off）可以用 x-workspace-id 任选 workspace；平台管理路由要单独维护白名单 TENANTLESS_PLATFORM_PATHS；用户 id 没有按身份源加命名空间

**证据**

CURRENT-TRUTH 3.22：审查发现只被授权 acme 的 token 发 ACME 就进了另一个租户，已修。3.23：不带 userId 的 token 能用 x-user-id 冒充同 workspace 用户，已修（触发器 payload 里嵌套 userId 的绕过一并堵上）

**代码**：server/auth.js resolveUserId / resolveWorkspaceId / requireTenantScope / assertApiAuthTokenConfiguration / TENANTLESS_PLATFORM_PATHS；server/access-scope.js normalizeScopeId

### D7. RBAC 用一张路由权限表（RBAC_ROUTE_TABLE）加一个遍历 Express router 栈的测试保证完整；enforce 下表外路由 403；workspace 角色只授普通权限，默认角色只在没有任何 workspace 权限时才补

**为什么**

新加路由忘了鉴权是最常见的漏洞，表加测试能证明覆盖完整；workspace 角色不能抬成部署级的 admin 权限

**为什么不用主流替代方案**

每条路由各写一个中间件或装饰器：完整性没法静态证明。OPA/Casbin：多一个依赖和策略语言，当前权限模型（8 个普通权限加 admin.*）用不上

**代价**

RBAC 只管动作、不管文档可见性（可见性仍按上传者加 workspace）；拆分部署里 agent 层不挂 RBAC，信任入口签名的身份，而这个身份不带 workspaceRoles；默认 RBAC_MODE=off

**证据**

CURRENT-TRUTH 3.22：审查修掉两个问题，workspace.admin 能读 /admin/status，以及默认 member 角色把显式给的 viewer 抬成 member；oidc-rbac.e2e 用开发 IdP 验证了 viewer/member/admin 各自的决策。只在自带的开发 IdP 上测过

**代码**：server/rag/rbac.js RBAC_PERMISSION_IDS / RBAC_ROUTE_TABLE / describeEffectiveAccess / decideRbacRequest / createRbacMiddleware；server/test/rbac-routes.test.mjs

### D8. 静态加密用信封：每个对象一把随机 DEK（AES-256-GCM），由租户 KEK（每 workspace 一把，没有 workspace 时按用户）包裹；AAD 绑定 (kind, objectId, workspaceId, userId)；擦除时销毁 KEK（crypto-shred）

**为什么**

磁盘加密和 TDE 对备份透明，也没法按租户销毁；AAD 由读者从行本身提供，所以密文被拷到别的租户或别的文档的行里会解密失败；payload 的 AAD 不含 header，rewrap 只需要改 header

**为什么不用主流替代方案**

磁盘/卷加密、PG TDE：防的是"偷盘"，不防"旧备份里还有被擦除租户的数据"。pgcrypto 把密钥放进数据库：数据库备份里同时有密钥和密文。一份数据一把全局密钥：做不到按租户销毁

**代价**

只加密文件字节；切块文本、向量、tsvector、run 快照、反馈、记忆、审计都是明文，旧数据库备份里仍然有，所以备份保留期必须有上限；本地 KMS 只到演示级，主密钥和密钥库在同一台机器上，写时复制文件系统上销毁只是尽力而为；所有读写文件的进程必须看到同一个密钥库；默认 TENANT_ENCRYPTION=off

**证据**

无性能实测。正确性：hardened e2e 里每份 file_bytes 都是信封，每个 workspace 一把密钥（tk_ 前缀加哈希）；换一行的上下文就解不开；真实擦除 alpha 后，擦除前留下的 alpha 密文解密报 TENANT_KEY_DESTROYED，beta 照常（docs/demo-tenant-isolation.md「e2e 测试」）

**代码**：server/rag/tenant-encryption.js encryptTenantBytes / decryptTenantBytes / payloadAad / dataKeyAad / rewrapTenantEnvelope / destroyTenantKeysForErase；server/rag/kms/key-scope.js resolveTenantKeyScope / resolveTenantKeyScopesForErase；server/rag/kms/local-provider.js createLocalTenantKmsProvider

### D9. 租户擦除按固定顺序遍历每个存储，先把工作区标成 deleting，默认 dry run，保留审计并写墓碑，所有存储都成功之后才销毁密钥

**为什么**

顺序防止"擦完又被写回来"：入库任务最先擦，还持有任务的 worker 的受保护提交会失败；registry 放最后，失败可以重跑（幂等）；deleting 让 membership enforce 立刻拒绝该工作区的请求

**为什么不用主流替代方案**

软删除标记：数据仍在，不满足擦除要求。只删文档表、依赖 FK 级联：缓存、Redis、用量账本、文件系统上的上传分片都覆盖不到

**代价**

擦不到其他进程的内存缓存（注册表缓存、embedding 缓存、未刷写的用量等）；不会撤销凭据，要先撤销；workspace 内单个用户的擦除不销毁共享的 workspace 密钥；有在跑的工作时返回 409 TENANT_ERASE_ACTIVE_WORK，除非 force

**证据**

hardened e2e：真实擦除后，每张带 workspace_id 列的表都没有 alpha 的行（审计表按设计保留），两个刷写周期后仍然没有（docs/demo-tenant-isolation.md「e2e 测试」）。没有性能数字

**代码**：server/rag/tenant-lifecycle.js TENANT_STORE_IDS / createTenantLifecycleService / TENANT_LIFECYCLE_ERROR_CODES

### D10. 审计用哈希链（每个 workspace 一条链，没有 workspace 时每个用户一条），同一条链的写入在 READ COMMITTED 事务里用 advisory 锁串行

**为什么**

链的划分和迁移 032 的 RLS 读范围一致，租户请求能续写自己的链，又看不到别人的链；篡改、删除、绕过写入都会在 audit:verify 里表现为第一处断裂

**为什么不用主流替代方案**

WORM 存储、S3 Object Lock、QLDB 或区块链：引入外部依赖，单 PG 部署做不了。只做 append-only 权限（032 已经 REVOKE UPDATE/DELETE）：防不了 owner 或 DBA

**代价**

只能发现篡改，不能防篡改，DBA 可以重算整条链；链尾被截断无法自证，要把 audit:verify 打印的链头哈希存到外部比对；开头的行被保留期清理时只报 startsAfterPurge；同一条链的写入被串行；滚动升级期间有一个未加哈希的窗口

**证据**

hardened e2e：audit-verify.mjs 以两个数据库 URL 运行，所有链校验通过（docs/demo-tenant-isolation.md「e2e 测试」，演示数据规模很小）

**代码**：server/rag/admin-audit-chain.js computeAdminAuditRowHash / getAdminAuditChainLockKey / createAdminAuditChainVerifier / ADMIN_AUDIT_CHAIN_BREAKS；server/rag/data-access-audit.js sendAuditUnavailable

### D11. 资源公平：按租户的固定窗口限流和并发上限、模型等待队列按租户公平调度、模型/存储/入库/任务配额；所有拒绝统一记账，指标只用错误码作标签

**为什么**

pool 模型最大的风险是吵闹的邻居占满模型并发、连接池和队列；按租户记拒绝，运维能看出是谁在被拒，又不在 Prometheus 里放租户标签（避免高基数）

**为什么不用主流替代方案**

只在网关做全局限流（Kong/Envoy）：分不出租户，也看不到 Agent 内部的模型调用。令牌桶或滑动窗口：更平滑，但这里选了实现最简单、能用 Lua 原子更新的固定窗口

**代价**

固定窗口在边界处会有突发；没有 Redis 时按进程计数；token 配额在模型回答后才扣，在途调用可能超额；公平队列 take() 要线性扫描所有在等的租户；默认全部关闭或不限

**证据**

hardened e2e：beta 的第 3 个并发请求返回 429 TENANT_CONCURRENCY_LIMITED，同时 alpha 正常；walkthrough 里 gamma 被限流时 alpha 不受影响（docs/demo-tenant-isolation.md）。没有公平性的量化数据

**代码**：server/rag/tenant-limits.js createTenantRateLimiter / createTenantConcurrencyLimiter；server/rag/model-call-guard.js createTenantFairQueue；server/rag/tenant-storage-quota.js assertTenantStorageQuota；server/rag/tenant-refusals.js recordTenantRefusal

### D12. 缓存时序侧信道：查询 embedding 缓存和注册表查询缓存可以按租户分区（默认 shared）；in-flight 去重始终只在同一租户内共享；公开的事件 id 改成 runId:n

**为什么**

命中缓存跳过了模型调用，响应明显更快，租户可以计时探测别人最近有没有问过某句话；全局 BIGSERIAL 事件 id 的间隔能暴露别的租户的活动量

**为什么不用主流替代方案**

全部缓存都按租户分区：语义缓存等已经分区，剩下的 registry map 要猜别人的 UUID 才能探测，危害很小。干脆不缓存：每次 /chat 都多一次 embedding 调用

**代价**

tenant 档下每个租户每段文本要多一次模型调用；默认 shared，所以默认配置下这个信道是开着的；local/qdrant 的 BM25 统计跨整个集合，不在这次处理范围内

**证据**

无实测：文档没有量化计时差异，也没有测分区后的命中率和成本

**代码**：server/rag/embedding-cache.js embedQueryCached / describeFlightTenant / buildCacheKey；server/rag/tenant-registry.js workspaceCacheKey；server/rag/agent-runs.js stripInternalRunFields

## 追问阶梯

按面试官的追问顺序排。先自己出声答一遍，再看要点。⚠ 是这题最容易答错或夸大的地方。

### Q1. 你这个系统里的"租户"具体指什么？一个请求的租户是怎么确定的？

*L1 是什么*

- 租户 = 访问范围 (userId, workspaceId)；同一个用户在不同工作区是不同的租户
- 由凭据决定：静态 token、HS256 JWT、OIDC
- 凭据自带 userId 时，客户端传的 userId 一律忽略；不允许客户端选用户的凭据，请求里带了 userId 就 403
- 凭据固定 workspace 时请求必须和它一致；有 workspace 列表时 x-workspace-id 只能在列表里选，并规范成小写
- 凭据什么都不绑时，默认可以任选 workspace；要校验就开 TENANT_MEMBERSHIP=enforce（必须是注册表里的成员）
- 认证后既没有用户也没有工作区的范围直接 403（requireTenantScope），因为空范围在下游等于"所有租户"；单共享 token、/auth/me 和平台路由除外

代码：`server/auth.js resolveUserId`；`server/auth.js resolveWorkspaceId`；`server/auth.js requireTenantScope`；`server/rag/tenant-registry.js decideTenantMembership`

> ⚠ 别说"请求体和请求头永远不能指定租户"：auth off、单共享 token 和 allowClientUserId 条目可以由客户端选 userId；凭据不绑 workspace 时，默认可以用 x-workspace-id 任选。也别说"租户 = workspace"：文档按 (用户, workspace) 隔离，同一 workspace 的成员彼此看不到对方上传的文档。只有不带用户的 workspace 凭据上传的文档在 workspace 内共享；用户不带 workspace 上传的文档在他的每个 workspace 里都可见。auth off 是默认值，也是有意保留的单租户模式，不是漏洞。

### Q2. 每个 store 的 SQL 都已经带了 WHERE user_id/workspace_id，为什么还要上行级安全？

*L2 为什么*

- 纵深防御：RLS 兜住"某个查询漏写过滤条件"这类 bug，中间的业务代码根本不把范围传给数据库层
- 量化：eval:tenant-isolation 的自建探测里，一条漏写过滤的查询，改前泄露 9/9 张表、9728 行，改后 0/9；越权读写 5/5 → 0/5
- 做的过程中真找到了问题：registry 在租户请求里首次加载只装进了该租户的文档；multer 丢异步上下文
- 现在 17 张表都在策略下，另加每个 live 索引版本的分块表和 BM25 统计表；健康检查会逐项探测

代码：`server/db/migrations/013_enable_tenant_row_level_security.sql`；`server/health.js checkRowLevelSecurityHealth`；`server/health.js getRowLevelSecurityTables`

> ⚠ "off 下 9/9"量化的是这层能兜住的 bug 类型，不代表之前线上真有泄露。那次测的是当时的 9 张表。绝不能说 RLS 防 SQL 注入：注入的语句可以 RESET ROLE，角色拆分下也能切进 system 角色。

### Q3. 具体怎么让数据库知道当前租户？为什么用 SET LOCAL ROLE，而不是连接级的 SET ROLE？

*L2 为什么*

- bindDatabaseTenant 把范围放进 AsyncLocalStorage；queryPostgres 每次调用 resolveStatementRole
- 租户时在同一次往返里先执行 TENANT_SETTINGS_SQL：set_config('role', $1, true)，等价于 SET LOCAL ROLE，同时设 archive_rag.user_id / workspace_id 和两个超时
- LOCAL 只在当前事务有效，连接回到池里一定变回登录身份；会话级 SET ROLE 一旦 reset 失败，下一个借这条连接的请求就会以别人的身份执行
- 角色名和 id 都是绑定参数，不拼进 SQL 文本
- 策略用 ENABLE 不用 FORCE，只作用于租户角色；迁移、启动加载和跨租户扫描走 system 上下文

代码：`server/rag/postgres.js TENANT_SETTINGS_SQL`；`server/rag/postgres.js resolveStatementRole`；`server/rag/postgres-tenant.js runWithDatabaseTenant`

> ⚠ 被问"set_config 能设 role 吗"，要答得出：第三个参数 true 就是事务级，效果等同 SET LOCAL ROLE；登录角色需要被授予租户角色，PG16 起要带 SET 选项（迁移 013 里 GRANT ... WITH SET TRUE）。

### Q4. 你说每条语句都要先切角色，那岂不是每条语句都多了几次往返？性能怎么样？

*L3 为什么不用 X / 怎么证明*

- 最初确实如此：BEGIN、设置、语句、COMMIT 四次往返，每条语句 p50 多 0.15–0.25 ms，一次 /chat 167 次往返
- PipelinedQuery：设置语句和业务语句各发一组 Parse/Bind/Execute，最后只发一个 Sync，PG 把 Sync 之前的消息当成一个隐式事务
- 结果（2026-09-27）：租户路径往返 167 → 22；租户 4 实例并发 32 吞吐 205 → 283 req/s（+37.9%），1 实例 +12.6%
- 安全细节：失败后看 ReadyForQuery 里的事务状态，不能证明连接回到预期状态就销毁，不放回池里
- 先测量再优化：从压测报告里一个异常值（166 次往返）开始查，用 pg_stat_statements 定位到具体语句

代码：`server/rag/postgres.js PipelinedQuery`；`server/rag/postgres.js runPipeline`；`server/rag/postgres.js TENANT_PIPELINE_STATUS_ERROR_CODE`

> ⚠ 167 → 22 有两个来源：一是 run store 不再回读（读事件 15、读 run 行 11 → 0），二是流水线，不要全算在流水线头上。代价也要说：依赖 pg 内部接口；native 绑定没有这个优化；Sync 之后客户端出错时结果未知，必须原子的写入放进 withPostgresTransaction。数字来自单机、假模型 0 ms。

### Q5. 为什么用共享表加 RLS，而不是每个租户一个 schema 或者一个库？

*L3 为什么不用 X / 怎么证明*

- 共享表（pool 模型）：一套 HNSW/GIN 索引、一套迁移，索引版本切换（迁移 016）一次完成
- schema-per-tenant：每个租户一份分块表和 HNSW，再乘上索引版本数，表数量会爆炸；search_path 也是会话状态，和连接池冲突
- 每租户一个库（silo）隔离最强，但运维成本高；文档里明确写了没实现
- pool 模型的代价是噪声邻居和统计混用，所以另做了限流、配额、公平队列，BM25 统计也按 scope 分开（迁移 030）

代码：`server/db/migrations/013_enable_tenant_row_level_security.sql`；`server/rag/tenant-limits.js createTenantRateLimiter`

> ⚠ 不要说 pool 模型"更安全"，它的优势是运维，隔离强度靠 RLS 加测试来证明。比较好的回答方向：大客户或强合规场景可以单独 silo 部署，但目前没做。

### Q6. 你提到 RLS 下全文检索用不上 GIN 索引，为什么会这样？你怎么解决的？

*L3 为什么不用 X / 怎么证明*

- @@ 背后的 ts_match_vq 不是 leakproof，RLS 下 PG 不能让它先于策略条件求值，所以不能当索引条件
- 结果是沿 doc_id 取出整个文档集逐行解压，1000 篇文档约 150 ms
- 迁移 014 加了 SECURITY DEFINER 的 <chunks>_sparse_rank：以表 owner 身份用 GIN 打分，只返回 chunk_id 和分数；buildTenantSparseSearchSql 先以租户身份从 documents 表筛 doc_id，再调函数，再以租户身份 JOIN 回分块表
- 10 万块、1000 篇：p50/p95 141.9/157.0 → 18.7/57.6 ms（当时是 ts_rank_cd）
- 现在默认 BM25，走迁移 030 的 <chunks>_sparse_search：一样是 owner 函数，函数内按策略收窄，再以租户身份 JOIN 回；014 那条路只在 ts_rank_cd 且关掉剪枝时还用

代码：`server/rag/vector-store-pgvector.js buildTenantSparseSearchSql`；`server/rag/vector-store-pgvector.js runSparseSearchFunction`；`server/rag/vector-store-pgvector-sparse.js usesPgvectorSparseSearchFunction`；`server/db/migrations/033_harden_sparse_rank_function.sql`

> ⚠ 面试官一定会问"那这个函数不就绕过 RLS 了？"。要承认：候选打分这一步确实绕过了，这是用户明确同意的设计，所以才有函数内外两道收窄。全表查询时 014 修复后 p95 基本没变（138.4 → 134.4，常见词几乎命中所有行），后来的常见词剪枝才把 100 条混合查询整体的 p95 降到 73 ms（ts_rank_cd 135 → 73；其中含常见词的 11 条 p95 180 → 49 ms），而剪枝会改变只含常见词的查询的结果（前 10 条只重合：ts_rank_cd 32–41%，BM25 单个常见词 29%），不要说"全部变快、结果不变"。

### Q7. 接着问：调用方已经先筛过 doc_id 了，为什么迁移 033 还要在函数里再筛一次？审查发现过什么问题？

*L4 边界 / 规模 / 重做*

- 租户角色对这个函数有 EXECUTE 权限，任何以租户身份执行的语句都能直接调用它，传入别人的 doc_id
- 不收窄的话能拿回别人匹配的 chunk id 和分数，等于知道"哪份文档含哪个词、匹配多少块"
- 033：当 current_setting('role') 等于租户角色时，函数先用迁移 013 的文档策略谓词收窄（函数以 owner 身份执行，不受策略约束，所以要自己写这个谓词）；030 的 _sparse_search 也做同样的收窄
- 014 的审查发现过"先截断后过滤"会泄露：别的租户的块会占掉 LIMIT 的位置，于是改成先过滤 doc_id
- 调用方的收窄继续保留：还没回放 033 的读副本上可能还是 014 的函数体
- SECURITY DEFINER 的固定防护：search_path 固定为 pg_catalog, pg_temp，REVOKE FROM PUBLIC，只返回 id 和分数

代码：`server/db/migrations/033_harden_sparse_rank_function.sql __DOCUMENT_CHUNKS_TABLE___install_sparse_rank`；`server/db/migrations/030_create_sparse_bm25_statistics.sql __DOCUMENT_CHUNKS_TABLE___install_bm25`；`server/rag/vector-store-pgvector.js buildTenantSparseSearchSql`

> ⚠ 别说"三方向对抗审查保证没有泄露"，审查只能说明发现并修掉了这些问题。函数也只能返回 chunk_id 和分数，扩大返回内容就会打破这个设计。

### Q8. 你说租户靠 AsyncLocalStorage 传递，那上下文丢了会怎样？

*L3 为什么不用 X / 怎么证明*

- 四种状态：tenant / system / unscoped / unbound，system 和 unscoped 是冻结的单例、按身份比较，任何租户对象都冒充不了
- 默认 lenient：unbound 以登录身份（owner）执行，只剩应用层过滤，是 fail-open
- POSTGRES_TENANT_CONTEXT=strict（RLS enforce 下生效）：unbound 语句直接抛 ARCHIVE_RAG_TENANT_CONTEXT_MISSING，并打印调用栈
- 角色拆分（POSTGRES_MIGRATION_DATABASE_URL）：运行时登录不拥有任何表，unbound 直接 42501，lenient 模式下也是 fail-closed
- 真实案例：multer 内存存储从流回调里恢复执行链，上下文就丢了，所以在它后面重新挂 bindDatabaseTenant；有 sweep 测试和 e2e 检查有没有漏绑

代码：`server/rag/postgres-tenant.js DATABASE_TENANT_CONTEXTS`；`server/rag/postgres.js assertDatabaseContextBound`；`server/rag/postgres.js resolveStatementRole`

> ⚠ strict 和角色拆分默认都是关的，不要说"默认就 fail-closed"。评测脚本以 unbound 查询，所以 strict 不能写进评测读的 .env。角色拆分防的是上下文丢失和漏绑，不防注入。

### Q9. 为什么不用 LangChain/LlamaIndex 的 metadata filter，或者 Milvus 的 partition key、ES 的文档级权限来做多租户？

*L3 为什么不用 X / 怎么证明*

- metadata filter 本质上还是应用层过滤，一处漏写就泄露，没有数据库强制的第二道
- 向量和业务数据都在 PG：文档行和它的切块在一个事务里提交、替换和删除，一套策略覆盖所有表
- Milvus/ES 也能做，但隔离会分散到两个系统里，擦除和删除联动要跨系统保持一致
- local 和 qdrant 被明确标成单租户存储，多租户只支持 pgvector；qdrant 收到空 docIds 返回 []，防止退化成"无过滤"的搜索

代码：`server/rag/vector-store-pgvector.js buildTenantSparseSearchSql`；`server/rag/index.js commitDocument`

> ⚠ 不要贬低 Milvus 或 ES，要说清楚取舍：PG 的单表规模和带过滤 HNSW 的 recall 是上限。有个实测细节（CURRENT-TRUTH 3.15）：10 万块以上、100 篇文档时，优化器用 doc_id 索引取行再精确排序，没走 HNSW，所以 recall 为 1 说明不了 HNSW 质量。

### Q10. RBAC 怎么做的？新加一条路由时，怎么保证不会忘了鉴权？

*L2 为什么*

- RBAC_ROUTE_TABLE：每个 method + path 对应 public、authenticated 或某个具体权限；enforce 下不在表里的路由一律 403
- rbac-routes.test.mjs 遍历 app._router.stack，有路由没登记测试就失败
- describeEffectiveAccess：全局角色 ∪ 当前 workspace 的角色（只授普通权限，admin.* 不能从 workspace 角色来）∪ 默认角色（只在没有任何 workspace 权限时才补）
- 审查修过：workspace 内的 admin 能读部署级的 /admin/status；默认的 member 角色把显式给的 viewer 抬成了 member
- 拆分部署时在入口统一检查，agent 层信任入口签名的身份

代码：`server/rag/rbac.js RBAC_ROUTE_TABLE`；`server/rag/rbac.js describeEffectiveAccess`；`server/rag/rbac.js decideRbacRequest`

> ⚠ RBAC 只管动作，不管文档可见性；默认 RBAC_MODE=off；只用自带的开发 IdP 端到端测过，没接过 Keycloak、Auth0 这些真实 IdP。为什么不用 OPA/Casbin：零依赖，表加测试就能证明完整（8 个普通权限加 admin.*），但权限模型变复杂后需要重新评估。

### Q11. 静态加密怎么做的？为什么不直接用磁盘加密或者 PG 的 TDE？

*L3 为什么不用 X / 怎么证明*

- 信封加密：每个对象一把随机的 32 字节 DEK，AES-256-GCM；DEK 再由租户 KEK 包裹，每个 workspace 一把，没有 workspace 时按用户
- AAD = (kind, objectId, workspaceId, userId)，由读者从行本身提供：密文被拷到别的行或别的租户就解不开
- payload 的 AAD 不含 header，所以 rewrap 只改 header；key id 是范围的哈希（tk_ 前缀），不含原始 id
- 磁盘加密和 TDE 对备份透明，也没法按租户销毁，所以做不到 crypto-shred
- 擦除工作区时销毁它的 KEK，旧备份里这个租户的原件就无法解密了；e2e 验证过旧密文解密报 TENANT_KEY_DESTROYED

代码：`server/rag/tenant-encryption.js encryptTenantBytes`；`server/rag/tenant-encryption.js decryptTenantBytes`；`server/rag/kms/key-scope.js resolveTenantKeyScope`

> ⚠ 最容易夸大的点：只加密了文件字节。切块文本、向量、tsvector、run 快照、反馈、记忆都是明文，旧备份里还在，所以"crypto-shred 让旧备份不可读"只对原件成立，备份保留期必须有上限。本地 KMS 只到演示级（主密钥和密钥库在同一台机器上），没实现云 KMS/HSM；默认是关的。

### Q12. 擦除一个租户的流程是什么？你怎么保证擦干净了？擦到一半挂了怎么办？

*L3 为什么不用 X / 怎么证明*

- TENANT_STORE_IDS 是固定顺序：入库任务最先（还持有任务的 worker 提交会失败，不会把数据写回来）、上传、任务、run、文档（所有索引版本）……用量账本、注册表最后
- 先把 workspace 标成 deleting，TENANT_MEMBERSHIP=enforce 时这个工作区的请求立刻被拒
- 默认只 dry run；有在跑的工作返回 409 TENANT_ERASE_ACTIVE_WORK，除非 force
- 可以重跑：中途失败时 workspace 保持 deleting，再跑一次会补完
- 审计保留，并写一条 admin.tenant.erased 墓碑（只有 id 和计数）；所有存储都成功之后才销毁密钥
- e2e：每张带 workspace_id 的表都没有 alpha 的行，两个刷写周期后仍然没有

代码：`server/rag/tenant-lifecycle.js TENANT_STORE_IDS`；`server/rag/tenant-lifecycle.js createTenantLifecycleService`

> ⚠ 被问"其他实例内存里的缓存呢？"要承认擦不到，只能靠 TTL 或下次刷新。擦除也不撤销凭据，要先撤销。workspace 内单个用户的擦除不销毁共享密钥。不要说"彻底、立刻删除"。

### Q13. 审计日志怎么防篡改？为什么不用 WORM 存储或者区块链？

*L3 为什么不用 X / 怎么证明*

- 每条记录 row_hash = sha256(prev_hash || 规范化后的行)；每个 workspace 一条链，没有 workspace 时每个用户一条，和 032 的 RLS 读范围一致
- 同一条链的写入在 READ COMMITTED 事务里用 advisory 锁串行，一条链的行按提交顺序可见
- audit:verify 在一个快照里走完所有链，报告第一处断裂：row_hash_mismatch、prev_hash_mismatch、unchained_row
- 破坏性操作先写意图记录，写不进去就 503 AUDIT_UNAVAILABLE，不执行（ADMIN_AUDIT_DATA_EVENTS=on 时）
- WORM/QLDB 要引入外部依赖；单 PG 部署下，哈希链提供的是"可发现篡改"

代码：`server/rag/admin-audit-chain.js computeAdminAuditRowHash`；`server/rag/admin-audit-chain.js createAdminAuditChainVerifier`；`server/rag/data-access-audit.js sendAuditUnavailable`

> ⚠ 不要说"不可篡改"：DBA 能重算整条链；链尾被截断没法自证，要把 audit:verify 打印的链头哈希存到外部比对；开头被删在校验器里看起来和保留期清理一样（startsAfterPurge）。验证只在很小的演示数据上做过，具体条数还没写进 CURRENT-TRUTH，先别报数字。

### Q14. 吵闹的邻居怎么处理？比如一个租户把模型并发占满了。

*L3 为什么不用 X / 怎么证明*

- 按租户的固定窗口限流，分 chat、ingest、destructive、default 四类；另有每个租户的并发 run 上限
- 模型调用的等待队列按租户公平：最近最少被服务的租户先出队，同一租户内 FIFO；RAG_LLM_MAX_QUEUE 限制单个租户的排队长度
- 配额：模型（每分钟请求数、每分钟 token、每日 token）、存储（在提交事务里加 advisory 锁检查）、入库排队、任务
- RAG_SHARED_STATE=redis 时用 Lua 脚本原子共享；Redis 出错时退回进程内计数
- 每次拒绝在指标里只带错误码，在账本里按租户记 refused_*；非成员的探测只记在请求者自己名下，编造的 workspace id 撑不大账本

代码：`server/rag/tenant-limits.js createTenantRateLimiter`；`server/rag/model-call-guard.js createTenantFairQueue`；`server/rag/tenant-storage-quota.js assertTenantStorageQuota`；`server/rag/tenant-refusals.js recordTenantRefusal`

> ⚠ 这些默认都是关的；没有公平性的量化数据，只有 e2e 证明 beta 被限流时 alpha 不受影响。固定窗口在边界处有突发；没有 Redis 时按实例计；token 配额回答后才扣，在途调用可能超出。

### Q15. 你提到缓存有时序侧信道，具体是什么？怎么修的？量化过吗？

*L4 边界 / 规模 / 重做*

- 共享的查询 embedding 缓存命中时跳过模型调用、响应更快，一个租户可以计时探测别人最近有没有问过某句话
- RAG_EMBEDDING_CACHE_SCOPE=tenant 把租户分区加进缓存键；in-flight 去重本来就只在同一租户内共享（防止配额拒绝传给别的租户）
- TENANT_REGISTRY_CACHE_SCOPE=tenant：工作区查询按请求用户分区，非成员被拒的耗时不反映别人的请求
- 其他缓存做了分类：已分区的（语义缓存、claim 评审缓存）、无害的（registry map，要猜别人的 UUID）、范围外的（local/qdrant 的全局 BM25 统计）
- 公开的事件 id 改成 runId:n，不暴露跨租户共用的 BIGSERIAL

代码：`server/rag/embedding-cache.js describeFlightTenant`；`server/rag/embedding-cache.js buildCacheKey`；`server/rag/tenant-registry.js workspaceCacheKey`；`server/rag/agent-runs.js stripInternalRunFields`

> ⚠ 没有量化：文档里没有计时差异的大小，也没有分区后的成本数据，不要编数字。默认是 shared，也就是说默认配置下这个信道是开着的，要主动说。

### Q16. 如果租户数和数据量都放大 100 倍，比如几万个租户、十亿级切块，这套设计哪里先坏？你会怎么改？如果重做呢？

*L4 边界 / 规模 / 重做*

- 已测范围（CURRENT-TRUTH 3.15，合成 768 维向量，RLS enforce）：pgvector 100 万块时，100 篇文档 hybrid p95（热）21.2 ms、首次读 p95 111 ms；10 万块以上这类查询走 doc_id 精确排序，不是 HNSW；租户路径每次 /chat 22 次往返
- 可能先坏的地方：单表 HNSW 在过滤下的 recall、BM25 统计触发器的写放大（AGENTS.md：每个入库文档约 +6%）、同一 scope 的 advisory 锁热点、公平队列 take() 要线性扫描等待中的租户、每个进程一份的 registry map 和缓存
- 改进方向（都没做）：按 workspace 哈希做 PG 声明式分区或用 Citus 分片（RLS 策略随表走）；大客户单独 silo；Redis 从可选变必选；KMS 换成云 KMS/HSM；审计链头外部锚定
- 重做：从第一天就把角色拆分和 strict 设成默认（现在为了兼容默认是 lenient）；隔离从一开始就设计进 store 接口（013 是后加的，会话记忆和审计到 031、032 才补进来）；用户 id 带上身份源命名空间

代码：`server/rag/model-call-guard.js createTenantFairQueue`；`server/rag/tenant-storage-quota.js lockTenantStorageQuota`；`server/rag/postgres-tenant.js runAsDatabaseSystem`

> ⚠ 没在 100 倍规模上测过，不要说"支持一万租户"。hardened 配置（全部开关一起打开）没有压测数字。

## 可以引用的数字

| 说什么 | 数字 | 出处 | 前提 / 注意 |
| --- | --- | --- | --- |
| 漏写过滤条件的查询泄露的表数和行数，改前和改后 | 9/9 张表、9728 行 → 0/9、0 行 | CURRENT-TRUTH.md 3.8「数据库行级安全」；docs/evaluation.md「租户隔离（数据库行级安全）」 | 2026-09-25，本机一次性库，PG 18.6 + pgvector 0.8.6，20 租户、10000 切块；当时覆盖 9 张表；量化的是这层能兜住的 bug 类型，不代表之前有泄露 |
| 被接受的越权写或越权读 | 5/5 → 0/5 | CURRENT-TRUTH.md 3.8；docs/evaluation.md「租户隔离（数据库行级安全）」 | 5 种自己构造的探测（伪造插入、upsert 抢占、跨租户更新、跨租户删除、store 拿错 scope），不是第三方基准 |
| RLS 每条语句的额外延迟（流水线优化之前） | p50 +0.15–0.25 ms（主键读 0.10 → 0.25 ms，稠密 0.23 → 0.48 ms，全文 0.31 → 0.56 ms） | docs/evaluation.md「租户隔离（数据库行级安全）」 | 2026-09-25，每种操作计时 300 次；当时每条语句多 3 次往返，09-27 起已合并成一次往返，不能当现状讲 |
| 开 RLS 前后的多实例吞吐差（流水线优化之前） | 走 RLS 时每个 /chat 166 条语句，吞吐比 owner 路径低 11–16% | docs/evaluation.md「多实例与异步入库（2026-09-26）」 | 单机、假模型、单次运行；之后被往返优化取代 |
| 每次 /chat 的数据库往返 | 租户路径 167 → 22；owner 路径 46 → 20 | docs/evaluation.md「每次 /chat 的数据库往返（2026-09-27）」；CURRENT-TRUTH.md 3.15 | 并发 1，用 pg_stat_statements 差值法统计；包含两个改动：run store 不再回读、租户语句流水线 |
| 往返优化后的吞吐 | 租户 4 实例 205.2/204.6 → 280.8/284.4 req/s（+37.9%）；租户 1 实例 +12.6%；PG CPU 每请求 7.7 → 4.0 ms（4 实例） | docs/evaluation.md「每次 /chat 的数据库往返（2026-09-27）」 | 假模型 0 ms，并发 32，单机，前后交替各跑两次；1 实例时受单进程 CPU 限制 |
| RLS 下全文检索修复（迁移 014） | 10 万块、1000/2000 篇：p50/p95 141.9/157.0 → 18.7/57.6 ms；1 万块、100/200 篇：8.3/10.6 → 2.3/5.1 ms；全部 2000 篇时 p95 138.4 → 134.4 ms（基本不变） | docs/evaluation.md「全文检索与行级安全（迁移 014）」 | 2026-09-26，合成数据，RLS enforce，每组 100 条查询；当时打分是 ts_rank_cd、走 014 的函数；现在默认 BM25，走迁移 030 的函数 |
| 常见词剪枝对全表 sparse 延迟的影响 | 10 万分块、2000 篇、RLS、全表：100 条混合查询中含常见词的 11 条，ts_rank_cd p50/p95 135/180 → 39/49 ms，BM25 281/389 → 40/51 ms；100 条整体 ts_rank_cd p95 135 → 73 ms | CURRENT-TRUTH.md 3.18；docs/retrieval-tuning.md「BM25 与常见词剪枝」→「实测」 | 只在超过 1,000 分块时生效；合成数据；QASPER 召回差值 0 [0, 0]；只含常见词的查询前 10 条只和不剪枝重合 32–41%（ts_rank_cd；BM25 单个常见词 29%、三个 95.7%）；旧说法"p95 135 → 49"（旧版 docs/evaluation.md「检索调优（2026-09-27）」表和本材料都这样写过）把穷举时的 p50 135 和剪枝后的 p95 49 放在一起，别照它说 |
| OIDC 验签开销 | RS256 p50 约 20 µs，ES256 约 48 µs，HS256 约 4 µs | CURRENT-TRUTH.md 3.22「OIDC 登录与 RBAC」 | 公钥已缓存，1 万次；只用自带的开发 IdP 测过 |
| RLS 覆盖的表 | 17 张表（迁移 013/015/017/031/032/034/036/037），运行时另加每个 live 索引版本（active/building/ready）的分块表和它的 BM25 统计表 | server/health.js getRowLevelSecurityTables、checkRowLevelSecurityHealth | 这是代码事实，不是测量值；CURRENT-TRUTH §2 现在也写 17 张，3.8 的"9/9"是 2026-09-25 当时覆盖的表数 |
| 加密和鉴权相关常量 | DEK 32 字节、GCM nonce 12 字节、tag 16 字节、信封 header 最多 4096 字节；RSA 至少 2048 位；一个 workspace 的角色最多 32 个；公平队列最多记住 1024 个租户的上次服务轮次；RBAC 8 个普通权限 | server/rag/tenant-encryption.js DATA_KEY_BYTES/NONCE_BYTES/TAG_BYTES/MAX_HEADER_BYTES；server/rag/oidc.js MIN_RSA_MODULUS_BITS；server/rag/tenant-registry.js MAX_SCOPE_WORKSPACE_ROLES；server/rag/model-call-guard.js FAIR_QUEUE_MAX_TRACKED_TENANTS；server/rag/rbac.js RBAC_PERMISSION_IDS | 代码常量 |

## 要主动说出口的边界

- 默认配置几乎不隔离：API_AUTH_ENABLED 默认 false，整个归档就是一个租户；客户端可以自己选 userId
- 大多数开关默认关闭：RBAC_MODE=off、TENANT_MEMBERSHIP=off、POSTGRES_TENANT_CONTEXT=lenient、不做角色拆分、TENANT_ENCRYPTION=off、两个缓存 scope 都是 shared、ADMIN_AUDIT_DATA_EVENTS=off、删除脱敏 off、回收站 0、按租户限流关、存储/模型配额不限、API_AUTH_REQUIRE_WORKSPACE=false。默认就生效的：POSTGRES_ROW_LEVEL_SECURITY=enforce；开鉴权后的空范围 403 和会话记忆按租户派生键；认证后的 no-store 缓存头；有数据库时的用量账本；每个租户的上传会话上限（200 个 / 10 GiB）
- TENANT_MEMBERSHIP=off（默认）时，既不固定也不列出 workspace 的凭据可以用 x-workspace-id 任选 workspace，能读到那个 workspace 里不带用户上传的共享文档；要么给凭据配 workspaces，要么开 membership enforce（CURRENT-TRUTH 3.22 也写了这一点）
- 默认配置下上下文丢失是 fail-open：unbound 语句以 owner 执行，只剩应用层过滤；要 fail-closed 必须开 strict 或角色拆分
- RLS 和角色拆分都不防 SQL 注入：注入的语句能 RESET ROLE，或者切进 system 角色
- 稀疏检索的候选打分在 SECURITY DEFINER 函数里绕过 RLS（用户同意的设计），靠函数内外的收窄补偿
- 加密只覆盖文件字节；切块文本、向量、tsvector、run 快照、反馈、会话和长期记忆、审计、用量账本都是明文；旧数据库备份里仍然有这些，所以备份保留期必须有上限
- 本地 KMS 只到演示级：主密钥和密钥库在同一台机器或同一个数据卷上，没有职责分离；写时复制文件系统和 SSD 上销毁密钥只是尽力而为；云 KMS/HSM、BYOK、数据驻留都没实现
- 进程内状态按进程计：注册表缓存、embedding 缓存、没有 Redis 时的限流和并发计数、未刷写的用量；擦除碰不到其他进程的内存缓存
- 只有 pgvector 支持多租户；local 和 qdrant 是单租户存储（只给警告），qdrant 的 BM25 统计跨整个集合
- 用户 id 没有身份源命名空间：静态 token、JWT、OIDC 的用户 id 必须由部署保证不冲突
- RBAC 只管动作、不管文档可见性；OIDC 只在自带的开发 IdP 上端到端测过，没接过 Keycloak、Auth0、Entra
- 审计哈希链只能发现篡改，不能防篡改；链尾截断需要外部锚定链头才能发现
- 缓存时序侧信道和公平调度都没有量化数据
- hardened 全开配置只在单实例单体上验证过；拆分部署、Redis、读副本没有和它组合测过；全开配置没有压测数字
- 内部服务通信不是 mTLS；默认 hmac 模式下 issuer 是自报的
- 没有 WAL 归档和 PITR，没有按租户恢复（有导出、没有导入），没有 silo 部署
- 文档按 (用户, workspace) 隔离，同 workspace 成员看不到彼此上传的文档；这是设计如此，不是 bug，但面试时要先讲清楚语义
- compose.demo.yml 的实际运行情况口径不一致：docs/tenant-isolation.md（提交 6c83fb96）记录 2026-10-18 镜像构建成功、三个容器健康；AGENTS.md 和 docs/demo-tenant-isolation.md「限制」仍写"只用 docker compose config 检查过"。讲之前先统一口径

## 只能当推理讲的内容

核验代理找不到代码或数据依据的条目。讲的时候用「我的判断是……，没测过」。

- 2026-10-18 全量验证规模（后端 4038 项：4036 通过、0 失败、2 跳过，补跑副本 5/5；前端 177/177；walkthrough 两遍 26 PASS / 0 FAIL / 1 SKIP；audit:verify 63 条记录、5 条链）：只在 docs/tenant-isolation.md「2026-10-18 的一次完整验证」里，不在 CURRENT-TRUTH / docs/evaluation.md / AGENTS.md，已从 numbers 和 evidence 移除；补进 CURRENT-TRUTH 后再引用
- 租户隔离分支相对 main 的 /chat 吞吐（并发 1/4/16/32：−3.5%、+1.5%、+0.2%、−2.1%，并发 32 时每请求 CPU 多 4–5%）：同样只在 docs/tenant-isolation.md，已移除；而且并发 32 本身会漂 15–20%，比的是默认配置，不是 hardened 全开配置
- "会话级变量在 pgbouncer 事务池下会串到别的客户端"：通用知识，项目没有在 pgbouncer 下测过 RLS，已降级为"通用知识、未实测"
- "PG 里只有超级用户能把函数标成 LEAKPROOF"：PostgreSQL 通用知识，仓库文档没有写，已标注
- 缓存时序侧信道的实际计时差和按租户分区后的命中率/成本：仓库里没有测量
- 模型等待队列公平性的量化效果：只有 e2e 定性结论（beta 被限流时 alpha 正常），没有数字
- hardened 全开配置的压测开销：没有数字
- "按 workspace 哈希做 PG 声明式分区或 Citus 分片"等 100 倍规模的改进方向：都是设想，没做也没测

## 容易记错的地方

第一遍阅读（主要依据 AGENTS.md 和文档）写错、被核验代理对照代码改正的说法。这些正是读文档容易产生的误解。

- **elevatorPitch；questionLadder[0] answerPoints/trap；decisions[5]**
  - 原以为："只从凭据推出……请求体和普通请求头不能指定租户"；"x-workspace-id 只能在凭据列出的工作区里选"
  - 实际：改成按凭据分情况：凭据带 userId 时以它为准；auth off、单共享 token、allowClientUserId 条目可由客户端选 userId；凭据固定 workspace 时必须一致，有列表时只能在列表里选并规范成小写；两者都没有时请求写什么就用什么，只有开 TENANT_MEMBERSHIP=enforce 才校验成员关系
  - 依据：server/auth.js getRequestValue 依次读 header、body、query；resolveUserId 在 allowsClientUserId 时返回客户端值；resolveWorkspaceId 在 allowedWorkspaceIds 为空、凭据没固定 workspace 时直接 return requestedWorkspaceId；CURRENT-TRUTH 3.22"不带 workspaces claim 的 token 仍可选任意 workspace"
- **elevatorPitch；questionLadder[0]**
  - 原以为："认证后的空范围在入口直接 403"
  - 实际：补上例外：单共享 token、GET /auth/me 和平台路由（TENANTLESS_PLATFORM_PATHS，且凭据没有 workspace 列表）
  - 依据：server/auth.js requireTenantScope 对 SINGLE_TENANT_CREDENTIAL、AUTH_ME_PATH、isTenantlessPlatformPath 直接 return
- **requestFlow 第 1 步**
  - 原以为："stripInternalServiceHeadersMiddleware 剥掉 x-archive-service-* 头 → 按 IP 限流 → 健康探针和 /auth/config 在鉴权之前挂载"
  - 实际：顺序改为 strip → helmet/cors/静态 → express.json → createSystemRouter → createAuthConfigRouter → 按 IP 限流（只在 RATE_LIMIT_ENABLED=true 时挂）→ requireApiAuth；strip 中间件定义在 rag/service-identity.js
  - 依据：server/app.js 第 218–350 行的 app.use 顺序；isRateLimitEnabled 要求 RATE_LIMIT_ENABLED === "true"
- **requestFlow 第 8 步；decisions[3]；questionLadder[5]、[6]；keyFiles**
  - 原以为："稀疏路多文档时用 buildTenantSparseSearchSql 调 SECURITY DEFINER 的 _sparse_rank（BM25 默认走迁移 030 的函数）"，决策和问题把 014/033 的路径当成现状
  - 实际：默认 BM25（或开着剪枝的多文档）走 runSparseSearchFunction → 迁移 030 的 <chunks>_sparse_search，函数内在租户角色下按文档策略收窄；buildTenantSparseSearchSql + 014/033 的 _sparse_rank 只在 RAG_SPARSE_SCORING=ts_rank_cd 且关剪枝时用于多文档。014 的数字标成"当时 ts_rank_cd"的历史数字；新增 keyFiles：030 迁移和 vector-store-pgvector-sparse.js
  - 依据：server/rag/vector-store-pgvector-sparse.js usesPgvectorSparseSearchFunction = bm25 || (pruneDfFraction !== null && docCount > 1)；server/rag/vector-store-pgvector.js searchPgvectorSparseDocuments 先判断它再决定是否用 buildTenantSparseSearchSql；030 迁移 search_function := lower(target_table) || '_sparse_search'，第 243 行 tenant_scoped、第 325 行策略谓词；rag/config.js DEFAULT_SPARSE_PRUNE_DF_FRACTION = 0.1
- **numbers；decisions[3].evidence；questionLadder[5].trap**
  - 原以为：只有 014 修复的数字，全表 p95"基本不变"
  - 实际：新增常见词剪枝：10 万分块全表，含常见词的 11 条查询 ts_rank_cd p95 180 → 49 ms（p50 135 → 39），100 条整体 p95 135 → 73 ms，并写明它改变只含常见词的查询的结果（前 10 条只重合：ts_rank_cd 32–41%，BM25 单个常见词 29%）。早先这里照 evaluation.md 写成"p95 135 → 49"，把 p50 当成了 p95，已改
  - 依据：CURRENT-TRUTH 3.18；docs/retrieval-tuning.md「BM25 与常见词剪枝」→「实测」表
- **requestFlow 上传分支**
  - 原以为："内容哈希锁 → assertTenantStorageQuota（提交事务内、advisory 锁）→ maybeEncryptTenantBytes(documentFileContext) → 带 WITH CHECK 的插入"
  - 实际：beginVectorIndexWrite → （开去重时）lockDocumentContentHash → （配了配额时）lockTenantStorageQuota 拿 advisory 锁 → （替换时）锁文档行 → assertTenantStorageQuota → registerDocument（doc-registry.js 里 maybeEncryptTenantBytes(documentFileContext)）→ writeDocumentsToIndex
  - 依据：server/rag/index.js commitDocument 第 491–560 行；server/rag/tenant-storage-quota.js lockTenantStorageQuota 用 pg_advisory_xact_lock，assertTenantStorageQuota 单独做检查；server/rag/doc-registry.js 第 666 行加密调用
- **requestFlow 第 5、6、7 步**
  - 原以为：没写挂载条件；"assertDatabaseContextBound（strict 下 unbound 报错）"
  - 实际：注明 tenantLimits 中间件只在开了按租户限流或并发上限时挂、RBAC_MODE=off 时直接放行；strict 只在 RLS enforce 下生效
  - 依据：server/app.js if (tenantLimits.enabled)；server/rag/postgres.js assertDatabaseContextBound 同时检查 getPostgresTenantContextMode() === strict 和 RLS enforce
- **decisions[6].alternativesRejected**
  - 原以为："当前权限模型（9 个普通权限加 admin.*）"
  - 实际：8 个普通权限
  - 依据：server/rag/rbac.js RBAC_PERMISSION_IDS：chat.ask、documents.delete/read/write、memory.read/write、quality.feedback、tasks.run，共 8 个
- **decisions[4].codeRef**
  - 原以为："server/rag/db-migrations.js（GRANT ... WITH INHERIT FALSE, SET TRUE）"（没有函数名）
  - 实际：server/rag/db-migrations.js renderRuntimeRoleGrantSql
  - 依据：server/rag/db-migrations.js 第 519 行 export const renderRuntimeRoleGrantSql，第 547 行生成 GRANT ... WITH INHERIT FALSE, SET TRUE
- **numbers「RLS 覆盖的表」；questionLadder[1]；keyFiles health.js**
  - 原以为："另加每个活跃索引版本的分块表"
  - 实际：每个 live 索引版本（active/building/ready）的分块表和 BM25 统计表
  - 依据：server/health.js checkRowLevelSecurityHealth 调 listLivePgvectorVersionTables（注释：active, building, ready）和 describePgvectorSparseRowLevelSecurityTargets
- **numbers「租户隔离分支相对 main 的 /chat 开销」「完整验证的测试规模」；decisions[9].evidence；questionLadder[12].trap**
  - 原以为：−3.5%/+1.5%/+0.2%/−2.1%、CPU 多 4–5%；4038 项、177/177、26 PASS、audit:verify 63 条记录 5 条链
  - 实际：从 numbers 和 evidence 里移除，改用 docs/demo-tenant-isolation.md 里的定性 e2e 结论（"所有链校验通过"）；写进 unverifiable，提示先补进 CURRENT-TRUTH
  - 依据：这些数字只出现在 docs/tenant-isolation.md「2026-10-18 的一次完整验证」；grep CURRENT-TRUTH.md、docs/evaluation.md、AGENTS.md 都没有
- **questionLadder[15].answerPoints**
  - 原以为："pgvector 100 万块时，100 篇文档的 dense 约 20 ms（走精确计划，不是 HNSW）"
  - 实际：100 万块时 100 篇文档 hybrid p95（热）21.2 ms、首次读 p95 111 ms；10 万块以上走 doc_id 精确排序
  - 依据：CURRENT-TRUTH 3.15「pgvector 规模」表和第 1 点
- **limitations 第 1 条**
  - 原以为："默认开启的只有 POSTGRES_ROW_LEVEL_SECURITY=enforce"
  - 实际：列出默认就生效的项（RLS enforce、开鉴权后的空范围 403 和会话键派生、no-store 头、有数据库时的用量账本、上传会话按租户上限），并新增两条限制：API_AUTH_ENABLED 默认 false（默认单租户）；membership 关闭时不绑 workspace 的凭据可任选 workspace，能读到该 workspace 的共享文档
  - 依据：docs/configuration.md：API_AUTH_ENABLED 默认 false、TENANT_USAGE_LEDGER 有数据库时开、UPLOAD_SESSION_MAX_PER_TENANT 200、UPLOAD_SESSION_MAX_BYTES_PER_TENANT 10 GiB；迁移 013 documents 策略 owner_user_id = '' OR 匹配
- **staleInExistingDocs 第 4 条**
  - 原以为："现在有 29 个 test（grep 计数）"
  - 实际：28 个用例，外加 1 个 suite 级外层 test
  - 依据：test/postgres-row-level-security.integration.test.mjs：第 22 行是外层 test，第 201–2043 行有 28 个内层 test
- **staleInExistingDocs 第 6 条（CURRENT-TRUTH 3.19）**
  - 原以为：直接判为过时
  - 实际：注明同一文件 3.20 和 §4 已经写了可选 Ed25519，3.19 是按日期记的历史；默认 hmac 下原句仍成立
  - 依据：CURRENT-TRUTH 3.20「层间身份」和 §4「拆分部署」；server/rag/service-identity.js DEFAULT_SERVICE_TOKEN_TTL_MS = 60_000
- **staleInExistingDocs（新增两条）**
  - 原以为：无
  - 实际：当时 AGENTS.md 里 `<t>_bm25_rank` 和 RAG_BM25_PRUNE_DF_FRACTION 与代码不符（代码是 `<t>_sparse_search` 和 RAG_SPARSE_PRUNE_DF_FRACTION），CURRENT-TRUTH §4「文档解析」已过时；两处现在都已改写（AGENTS.md 已改用代码里的名字，§4 按 3.26、3.31 重写）
  - 依据：server/rag/vector-store-pgvector-sparse.js PGVECTOR_SPARSE_TABLE_SUFFIXES.searchFunction = "_sparse_search"；rag/config.js getSparsePruneDfFraction 读 RAG_SPARSE_PRUNE_DF_FRACTION；grep 不到 bm25_rank；rag/pdf-loader.js 支持 docling/auto
- **decisions[1].alternativesRejected；decisions[3].alternativesRejected**
  - 原以为："pgbouncer 的会话变量：transaction pooling 下不可靠"；"把函数标成 LEAKPROOF：要超级用户"
  - 实际：标注为通用知识、项目没在 pgbouncer 下测过；LEAKPROOF 需要超级用户写成"PG 里只有超级用户能这样标（通用知识）"
  - 依据：仓库里 pgbouncer 只出现在 LISTEN 不能经过事务池的说明（docs/deployment.md、docs/configuration.md），没有 RLS 与 pgbouncer 的测试
- **decisions[8].tradeoff**
  - 原以为："擦不到其他进程的内存缓存（语义缓存、claim 评审缓存、registry map、未刷写的用量）"
  - 实际：改成"注册表缓存、embedding 缓存、未刷写的用量等"；语义缓存和 claim 评审缓存（Redis）在 TENANT_STORE_IDS 里，本进程会擦
  - 依据：server/rag/tenant-lifecycle.js TENANT_STORE_IDS 含 claim_judge_cache、semantic_cache；AGENTS.md "Other processes' in-memory caches are not reached"
- **questionLadder[12].trap**
  - 原以为："链尾被截断和开头被保留期清理都没法自证"
  - 实际：链尾截断没法自证；开头被删在校验器里和保留期清理一样，报 startsAfterPurge
  - 依据：server/rag/admin-audit-chain.js 第 29–33 行注释
- **keyFiles**
  - 原以为："server/rag/tenant-usage.js / tenant-refusals.js"、"tenant-encryption.js + kms/"、"admin-audit-chain.js + postgres-admin-audit-store.js" 合并写
  - 实际：拆成独立条目，路径写全；补 server/access-scope.js、server/rag/model-quotas.js、server/rag/agent-runs.js、server/rag/db-migrations.js
  - 依据：各文件 ls 存在，对应函数 grep 到
