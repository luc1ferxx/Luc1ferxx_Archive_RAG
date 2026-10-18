# 多租户隔离

本文从整体上说明租户隔离是怎么做的：威胁模型、分层防御、每一层对应的开关和默认值、加固配置，以及验证证据和已知限制。每个开关的细节在 `docs/configuration.md`（"多租户治理"和"租户文件加密"），运维步骤在 `docs/operations.md`，演示在 `docs/demo-tenant-isolation.md`，实现约定在 `AGENTS.md`。

## 租户模型

- **租户 = 访问范围** `(userId, workspaceId)`。工作区对应一个组织；同一个用户可以属于多个工作区，每个工作区是一个独立租户。
- 访问范围只从凭据推出：静态 token（`API_AUTH_TOKENS`）、HS256 JWT 或 OIDC access token。请求体、查询参数和普通请求头都不能指定租户；只有凭据允许时，`x-workspace-id` 才能在凭据列出的工作区里选一个。
- **单租户模式**：关闭 auth，或者只用一个共享 `API_AUTH_TOKEN`，整个归档就是一个租户。这两种情况都是有意设计的。
- **平台主体**：不绑定工作区、也不带工作区列表的管理员凭据，只能走固定的几条平台路由（`TENANTLESS_PLATFORM_PATHS`），每条都要求对应的 `admin.*` 权限。

## 威胁模型

| 威胁 | 例子 | 主要防线 |
| --- | --- | --- |
| 越权读写 | 用别的租户的 docId 下载、提问、删除；直接调用内部服务 | 认证层租户解析、RBAC、行级安全（RLS）、内部服务签名身份 |
| 丢失租户上下文 | 后台任务、CLI、健康检查漏绑租户，以 owner 身份查询 | strict 租户上下文、数据库角色拆分 |
| 共享资源被挤占 | 一个租户占满模型并发、连接池、入库队列 | 按租户限流和并发、公平队列、配额 |
| 侧信道 | 缓存命中更快、全局递增 id 暴露活动量 | 缓存按租户分区、按 run 编号的事件 id |
| 跨工作区数据流 | 同一用户把工作区 A 的笔记带进工作区 B | 长期记忆按工作区、会话记忆按租户 |
| 数据残留 | 删除后切块仍可检索，擦除后备份里还有原件 | 删除联动、回收站、擦除、信封加密与密钥销毁 |
| 审计被篡改 | 管理员删改审计记录掩盖操作 | 审计哈希链、`audit:verify`、数据访问事件 |
| 拆分部署里的内部伪造 | 某一层冒充另一层，或重放请求 | 每层独立 Ed25519 密钥（可选）、调用策略、请求绑定、防重放 |

## 分层防御

### 1. 认证与租户解析（`server/auth.js`）

- 认证后的空租户直接拒绝（`requireTenantScope`）：既没有用户也没有工作区的访问范围，在数据库层会被当成"所有租户"，所以在入口就挡掉。启动时拒绝没有任何范围的 `API_AUTH_TOKENS` 条目。
- `TENANT_MEMBERSHIP=enforce`：工作区必须在注册表里登记，用户必须是成员，工作区必须是 active；暂停、删除中、未登记一律 403，注册表故障是 503，不会放行。
- `API_AUTH_REQUIRE_WORKSPACE=true`：多工作区凭据必须选一个工作区，平台路由和 `GET /auth/me` 除外。
- RBAC（`RBAC_MODE=enforce`）：每条路由都在 `RBAC_ROUTE_TABLE` 里登记权限，未登记的路由在 enforce 模式下是 403；`test/rbac-routes.test.mjs` 保证新路由不会漏登记。
- OIDC 平台角色：`API_AUTH_OIDC_ALLOW_PLATFORM_ROLES=false` 时，IdP 发的 `admin.*` 角色一律丢弃。

### 2. 请求层

- 认证之后的所有响应都带 `Cache-Control: private, no-store` 和按凭据区分的 `Vary`，防止中间缓存把一个租户的响应给另一个租户。
- 健康探针对外只返回 `{status}`。完整报告只给单租户 token、持有 `admin.status.read` 的主体，以及（检索层和模型网关上）有效的内部签名身份。
- 输入上限：问题长度、docId 个数和长度、任务路由的 id、载荷大小和嵌套深度。api 边缘层和 agent 层用同一套校验函数。

### 3. 数据库（PostgreSQL 行级安全）

- 所有租户表都有 `tenant_isolation` 策略。租户请求在一个短事务里 `SET LOCAL ROLE` 到租户角色，并把用户和工作区写进事务级设置；角色和 id 都是绑定参数，不拼进 SQL。
- 稀疏检索的 `SECURITY DEFINER` 函数在租户角色下先按文档表的策略收窄 docId，直接传别人的 docId 也排不出任何结果。
- `POSTGRES_TENANT_CONTEXT=strict`：没有绑定任何上下文的语句直接报错，不会悄悄以 owner 身份执行。所有启动、后台、CLI、指标和健康检查路径都显式绑定了 system 或记录自己的租户。
- **角色拆分**（`POSTGRES_MIGRATION_DATABASE_URL`）：迁移和 DDL 用 owner 登录，运行时登录什么都不拥有、没有任何表权限；system 工作切到一个 NOLOGIN 的 system 角色，它有自己的 `system_access` 策略。没绑定上下文的语句会以 42501 失败。
- 健康检查会验证：租户角色不是 SUPERUSER 或 BYPASSRLS，不拥有任何表，对没有策略的表没有任何权限；在角色拆分下，运行时登录也满足同样的条件。

### 4. 资源公平

- 按租户的固定窗口限流（chat / ingest / 破坏性操作 / 其他四类）和并发上限。
- 模型调用的等待队列按租户公平调度，最近最少被服务的租户先出队；单个租户的排队长度有上限。
- 模型配额（进程内或模型网关）、存储配额（文档数和字节数，在提交事务里加锁检查）、入库排队上限、任务并发和排队上限。
- 每一类拒绝都有 Prometheus 计数（只带错误码，不带租户标签），同时按租户记进用量账本，`GET /admin/usage?metric=refusals` 能看出是哪个租户在被拒。

### 5. 跨工作区和侧信道

- 会话记忆按 `(userId, workspaceId, sessionId)` 的哈希做键，客户端选的 sessionId 单独构不成租户边界。
- `LONG_MEMORY_SCOPE=workspace`：自由文本笔记和经验记忆只在写入它的工作区可见，只有固定枚举的偏好（回复语言、回答风格）是用户级。数据库策略同步限制。
- `RAG_EMBEDDING_CACHE_SCOPE=tenant`、`TENANT_REGISTRY_CACHE_SCOPE=tenant`：缓存按租户分区，命中与否不会泄露别的租户最近问过什么、用过哪个工作区。其他缓存的排查结论见 `AGENTS.md`。
- 公开的 run 事件 id 是每个 run 自己的序号（`runId:n`），不暴露跨租户共用的全局序列。

### 6. 数据生命周期

- **删除联动**：删除文档时取消它的入库任务，从每个索引版本里删掉切块；`DOCUMENT_DELETE_REDACTION=on` 时，把已结束的 run、引用它的产物和反馈里的原文替换成占位符。
- **回收站**（`DOCUMENT_TRASH_RETENTION_HOURS`）：删除和清空先进回收站，切块立即删除，所有读路径都看不到它；宽限期内可以恢复（从存着的原件重新切块和嵌入），过期后由保留期清理任务彻底清除。
- **保留期**：run、任务、产物、反馈、观测日志按天清理，可以按工作区覆盖；策略读不到时这一轮什么都不删。
- **租户擦除和导出**：按固定顺序遍历每个存储（入库任务、上传会话、任务、run、文档和所有索引版本的切块、产物、反馈、会话和长期记忆、Redis、语义缓存、用量账本、注册表）。默认只做 dry run；擦除前先把工作区标成 deleting；审计记录保留，并写一条墓碑。导出在租户自己的 RLS 下进行。
- **信封加密**（`TENANT_ENCRYPTION=on`）：原件、入库中间产物、上传分片和临时文件都用每个对象一把的数据密钥加密（AES-256-GCM），数据密钥由租户密钥包裹；AAD 绑定所属租户和对象，把密文挪到别的行会解密失败。擦除工作区时销毁它的密钥，旧备份里这个租户的原件随之无法解密（crypto-shred）。密钥库和主密钥不在数据库里，也不进备份。
- **备份恢复**：`backup:postgres`、`backup:restore`、`backup:verify`。校验会在一次性集群里恢复，然后检查迁移、行数和租户数、RLS 健康和审计链。

### 7. 审计

- 每条审计记录接进它所在的链（每个工作区一条，没有工作区时每个用户一条），`row_hash = sha256(prev_hash || 规范化记录)`；`audit:verify` 能指出第一处断裂。
- `ADMIN_AUDIT_DATA_EVENTS=on`：记录下载、删除、清空、替换、清除记忆、平台管理员的跨租户读取和租户擦除；破坏性操作先写意图记录，写不进去就返回 503、不执行。

### 8. 内部服务（拆分部署）

- 每次内部调用都带短期签名 token，audience 是目标层，issuer 是调用方的角色；接收方按 `SERVICE_CALL_POLICY` 决定谁能调谁。
- 租户只来自 token 里的访问范围，请求体不能指定。token 绑定方法、路径和请求体哈希；`ed25519` 模式下每层只能以自己的身份签名，并启用防重放缓存。
- 这些都不是 mTLS，内部端口仍然不能暴露在公网上。

## 加固配置

`deploy/demo/hardened.env` 把上面所有开关一起打开（演示用的固定 token 和密码，不要在别处复用），`compose.demo.yml` 用独立的数据卷和非超级用户的运行时登录启动它。`test/tenant-isolation-hardened.e2e.test.mjs` 在真实 PostgreSQL 上用这份配置启动 `node server.js`，跑完整的 seed 和检查清单，再做一次真实擦除。

## 验证证据

| 证据 | 测试 |
| --- | --- |
| 每条路由在跨租户主体下的对象访问 | `test/tenant-isolation-route-sweep.test.mjs` |
| RLS 策略、租户角色直接执行 SQL 越权失败、健康检查 | `test/postgres-row-level-security.integration.test.mjs` |
| 角色拆分 | `test/postgres-role-split.test.mjs`、`test/postgres-role-split.integration.test.mjs` |
| strict 上下文没有漏绑 | `test/postgres-strict-tenant-context-sweep.test.mjs`、`test/postgres-strict-tenant-context.e2e.test.mjs` |
| 全部开关一起打开 | `test/tenant-isolation-hardened.e2e.test.mjs` |
| 从旧版本升级（最小权限库、角色拆分） | `test/postgres-upgrade.integration.test.mjs`（需要 `ARCHIVE_RAG_UPGRADE_FROM`） |
| 加密、密钥销毁、密文换行失败 | `test/tenant-encryption-postgres.integration.test.mjs` |
| 回收站、连接池耗尽回归 | `test/document-trash-postgres.integration.test.mjs`、`test/document-commit-pool.integration.test.mjs` |
| 备份恢复演练 | `test/backup-restore-postgres.integration.test.mjs` |
| 擦除和导出 | `test/tenant-lifecycle-postgres.integration.test.mjs` |
| 共享状态（Redis）下的限流 | `test/tenant-limits-redis.integration.test.mjs`（需要 `REDIS_TEST_URL`） |

## 已知限制

- **加密范围**：切块文本、向量、tsvector、run 快照、反馈和记忆仍是明文，因为检索和 agent 要直接读。擦除会删掉它们，但更早的数据库备份里还在，所以备份保留期必须有上限。
- **本地 KMS 只用于演示**：生产环境应换成云 KMS 或 HSM（接口已留好，没有实现）。在写时复制文件系统或 SSD 上，销毁密钥是尽力而为。
- **进程内缓存和计数**：限流在没有 Redis 时按进程计数；擦除碰不到其他进程的内存缓存。
- **向量库**：`local` 和 `qdrant` 是单租户存储，多租户部署只支持 pgvector。
- **用户 id 没有命名空间**：同一部署里不同身份源（静态 token、JWT、OIDC）的用户 id 必须保证不冲突。
- **没有实现**：WAL 归档和时间点恢复（PITR）、按租户恢复（导出可以导出，没有对应的导入工具）、按租户独立部署（silo）、BYOK 和数据驻留。
- **内部通信不是 mTLS**：内部端口必须留在内网。默认的 `hmac` 模式下每层共享同一组密钥，issuer 是自报的；`ed25519` 才能做到每层只能以自己的身份签名。
