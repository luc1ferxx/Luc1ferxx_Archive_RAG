# 多租户隔离演示（hardened profile）

租户隔离第 1–4 阶段的每个开关此前都只单独测过。这个演示把它们同时打开，用一组固定的演示身份跑一遍，证明组合起来仍然成立：

- API 鉴权（按用户的静态 token），每个请求必须解析出 workspace；
- `RBAC_MODE=enforce`，`TENANT_MEMBERSHIP=enforce`；
- 行级安全（`enforce`）加 `POSTGRES_TENANT_CONTEXT=strict`；
- 数据库角色拆分：owner 登录跑迁移，运行时登录不拥有任何表；
- 数据访问审计事件、删除文档时的脱敏；
- 按租户的限流、并发上限、模型配额、存储配额、任务上限；
- 保留期清理；
- `API_AUTH_OIDC_ALLOW_PLATFORM_ROLES=false`。

**只用于演示，不能用于生产。** 文件里的 token 和数据库密码都是写死的公开演示值，任何读过这个仓库的人都知道。

## 组成

| 文件 | 作用 |
| --- | --- |
| `deploy/demo/hardened.env` | 服务端环境配置，带注释。每个变量名都由 `server/test/demo-tenants.test.mjs` 核对：服务端确实读取它，并且在本文档或 `server/.env.example` 里有说明。 |
| `compose.demo.yml` | `docker-compose.yml` 的 override：用上面的配置跑 `--profile app`，app 以运行时登录连接数据库。 |
| `server/demo-tenants.mjs` | 命令行：`npm run demo:seed`、`npm run demo:walkthrough`、`npm run demo:fake-model`。只通过 HTTP 访问正在运行的服务，不直接连数据库。 |
| `server/demo/tenant-demo.js` | 演示身份、seed 和检查清单，e2e 测试直接复用。 |
| `server/demo/fake-model.js` | 确定性的 OpenAI 兼容假模型：哈希词向量，答案是与问题最相关的证据句并带 `[Source N]`。支持 `stream: true`。不需要任何 key。 |
| `server/test/tenant-isolation-hardened.e2e.test.mjs` | 用这份配置启动真实的 `node server.js`，跑 seed 和全部检查，外加更多断言（见下文）。 |

## 演示身份

| 身份 | token | 绑定方式 | 角色（来自租户注册表） |
| --- | --- | --- | --- |
| alice | `demo-alice-token` | token 固定在 `alpha` | alpha `workspace.admin` |
| alpha-library | `demo-alpha-library-token` | token 固定在 `alpha`，没有用户 | 不是成员；`RBAC_DEFAULT_ROLE`（member） |
| anna | `demo-anna-token` | 只有用户，用 `x-workspace-id` 选 workspace | alpha `workspace.viewer` |
| bob | `demo-bob-token` | token 固定在 `beta` | beta `workspace.admin` |
| ben | `demo-ben-token` | 只有用户 | beta `workspace.member` |
| carol | `demo-carol-token` | token 允许 `alpha`、`beta`，每次必须指定一个 | 两个 workspace 都是 `workspace.member` |
| dave | `demo-dave-token` | 只有用户 | gamma `workspace.admin`（"吵闹的邻居"，限流、配额、暂停都拿它试） |
| platform-admin | `demo-platform-admin-token` | 没有 workspace | `admin.owner`：擦除、导出、用量、审计、健康详情 |
| tenant-manager | `demo-tenant-manager-token` | 没有 workspace | `admin.tenant_manager`：登记 workspace 和成员 |

文档属于上传它的 (用户, workspace)：同一 workspace 的其他成员看不到（`documentMatchesAccessScope` 和迁移 013 的行策略）。没有用户的 workspace 凭据（alpha-library，相当于服务账号）上传的文档没有 owner，整个 workspace 都能看到，所以 anna 作为只读成员能读到它。

## 启动

### 方式一：docker compose

```bash
docker compose -f docker-compose.yml -f compose.demo.yml --profile app up -d --build
cd server
npm run demo:seed
npm run demo:walkthrough
```

- postgres 用自己的数据卷 `pgdata-demo`。第一次初始化时，镜像执行挂载进去的 `deploy/postgres/create-split-roles.sql`，创建 owner 登录 `archive_rag_owner`（拥有 `archive_rag` 库，CREATEROLE）和运行时登录 `archive_rag_app`（NOSUPERUSER、NOBYPASSRLS、NOINHERIT，不拥有任何东西）。默认的 `pgdata` 卷不会被复用，也不会被改动。
- app 先读 `server/.env`（如果有），再读 `deploy/demo/hardened.env`，后者覆盖前者；数据库地址和模型地址由 compose 的 `environment` 换成 compose 网络里的服务。
- `demo-model` 服务用同一个镜像跑假模型，只在 compose 网络内可达，不发布端口。
- 端口仍然只绑定 `127.0.0.1`（`ARCHIVE_RAG_BIND_HOST`）。不要配合这个文件设 `ARCHIVE_RAG_BIND_HOST=0.0.0.0`。
- 重新开始：`docker compose -f docker-compose.yml -f compose.demo.yml down -v`（会删除 `pgdata-demo`）。

这个 override 只用 `docker compose ... config` 验证过（`server/test/deployment-contract.test.mjs` 固定了它的接线），镜像没有在这里构建过。

### 方式二：本地 `node server.js` 加本地 PostgreSQL

需要一个带 pgvector 的 PostgreSQL（例如 Postgres.app）和一个超级用户：

```bash
psql "postgresql://postgres@127.0.0.1:5432/postgres" -v ON_ERROR_STOP=1 \
  -v owner_password=demo_owner_password -v runtime_password=demo_runtime_password \
  -f deploy/postgres/create-split-roles.sql

cd server
npm run demo:fake-model                                   # 终端 1，监听 127.0.0.1:5199
DOTENV_CONFIG_PATH=../deploy/demo/hardened.env node server.js   # 终端 2
npm run demo:seed && npm run demo:walkthrough             # 终端 3
```

两个密码必须和 `hardened.env` 里两个数据库 URL 中的一致。`DOTENV_CONFIG_PATH` 让服务只读这份配置，不读 `server/.env`。

想用真实模型：改 `hardened.env` 末尾的 `OPENAI_*` 和 `RAG_EMBEDDING_DIMENSIONS`，并且从空库开始（向量宽度在建表时就固定了）。

## `demo:seed`

以 tenant-manager 身份通过 `/admin/workspaces` 登记 `alpha`、`beta`、`gamma` 三个 workspace 和全部成员关系，再以各自的上传者身份上传 5 份生成的小 PDF（上传接口只收 PDF）。其中 carol 的文档走分片上传（`/upload/init`、`/upload/chunk`、`/upload/complete`），其余走 `POST /upload`。异步入库模式下会轮询入库任务直到完成。

可以重复执行：已存在的 workspace 保留（之前中断留下的暂停状态会重新激活），成员角色重新写一遍，相同字节的文档按去重解析为已有文档（`duplicate`）。

`--url <地址>` 指定服务地址，默认 `http://127.0.0.1:5001`。

## `demo:walkthrough`

逐项检查并打印 PASS/FAIL 表，有 FAIL 时退出码为 1（无法运行时为 2）。`--only <id,...>` 只跑部分检查，`--json` 输出 JSON。检查会改动 gamma（暂停再恢复、耗尽限流、填满再清空存储配额）和 beta 的一份探测文档（上传后删除），结束时恢复到 seed 之后的状态，所以可以在同一个限流窗口内连续再跑一遍。

| 检查 | 证明什么 |
| --- | --- |
| `probes_answer_status_only` | 匿名的 `/ready` 只返回 `{status}`，不泄露拓扑和存储信息。 |
| `health_row_level_security` | 平台管理员能读健康详情，`checks.rowLevelSecurity` 和其中的 `roleSplit` 都是 `ok`；不带 workspace 也能访问 `/admin/status`、`/admin/index-versions`。 |
| `credential_required` | 没有 token 是 401；有多个 workspace 却没指定的凭据是 403（`API_AUTH_REQUIRE_WORKSPACE`）。 |
| `membership_required` | 指定一个自己不是成员的 workspace（或一个没登记的）是 403 `WORKSPACE_MEMBERSHIP_REQUIRED`；token 固定的 workspace 之外也是 403。 |
| `list_isolation` | 每个成员列出的正好是自己的文档加本 workspace 的共享文档。 |
| `download_isolation` | 下载别的 workspace 的文档、或同 workspace 其他成员的私有文档都是 404；自己的和共享的是 200；共享文档在另一个 workspace 里也是 404。 |
| `delete_isolation` | alpha 的 workspace.admin 删除 beta 的文档得到 404，文档还在。 |
| `chat_isolation` | 对 beta 的文档提问得到 404，回复里没有 beta 文档的内容和文件名；对自己的文档能正常回答。 |
| `chat_stream_isolation` | 同上，走 `/chat/stream`（SSE）。 |
| `viewer_is_read_only` | workspace.viewer 能读共享文档，上传和删除都被 RBAC 拒绝（403 `RBAC_PERMISSION_DENIED`）。 |
| `membership_roles_in_rbac` | `/auth/me` 的权限就是注册表里成员角色对应的权限：anna 是 viewer，alice 是 admin，carol 在 beta 是 member。 |
| `memory_isolation` | 长期记忆只属于写入它的用户，别人列不出、删不掉；两个租户用同一个 sessionId 各自清空自己的会话。 |
| `tenant_manager_least_privilege` | tenant-manager 能管理注册表，但不能擦除租户，也不能读任何 workspace 的文档。 |
| `suspended_workspace` | 暂停 gamma 后它的请求是 403 `WORKSPACE_SUSPENDED`，恢复后正常；alpha 不受影响。 |
| `background_task_isolation` | 后台任务在提交者自己的租户里跑完；其他 workspace 的用户和同 workspace 的其他成员都看不到它（404）。 |
| `delete_redaction` | 删除文档后，反馈里保存的引用摘录被替换成 `[source document deleted]`（角色拆分下由系统角色更新，迁移 040 只允许它改这一列）。 |
| `tenant_rate_limit` | gamma 的 chat 配额用完后返回 429 `TENANT_RATE_LIMITED`，同时 alpha 不受影响。这里用无效的 `/chat` 请求体：限流在路由校验之前计数，不调用模型。 |
| `storage_quota` | gamma 存到 `TENANT_MAX_DOCUMENTS` 份之后，下一次上传返回 429 `TENANT_STORAGE_QUOTA_EXCEEDED`；探测文档随后删除。 |
| `platform_usage_view` | 平台管理员的 `/admin/usage` 能看到所有 workspace 的入库字节（按 `TENANT_USAGE_FLUSH_MS` 延迟写入，检查会等待）；workspace 管理员无权读取。 |
| `erase_dry_run` | `POST /admin/tenants/erase` 默认只预览：返回每个存储的记录数，什么都不删。 |
| `export_isolation` | alpha 的导出包含 alpha 的文档，不含任何其他 workspace 或其他用户的记录，也不含 beta 文档的内容。alpha 自己的审计记录会引用 alice 请求过的 beta 文档 id（那是 alpha 的请求，不是 beta 的数据），检查会单独列出这类记录。 |
| `data_access_audit` | alpha 的审计记录里有 `data.access` 事件，且都属于 alpha；只有平台管理员能跨租户读审计。 |
| `audit_chain` | 总是 SKIP：哈希链校验要读数据库，见下一节。 |

## 审计链校验

`audit:verify` 只有命令行，需要数据库地址（和服务用同样的两个 URL）：

```bash
cd server
DOTENV_CONFIG_PATH=../deploy/demo/hardened.env npm run audit:verify
# compose：docker compose -f docker-compose.yml -f compose.demo.yml exec app node audit-verify.mjs
```

## e2e 测试

```bash
cd server
TEST_FILES="test/tenant-isolation-hardened.e2e.test.mjs" bash scripts/run-pgvector-integration.sh
```

没有 `PGVECTOR_TEST_DATABASE_URL` 时报告为 skipped。它在测试集群里新建一个一次性数据库，用 `psql` 执行 `create-split-roles.sql` 建两个登录（密码走 `\getenv`，和 compose 初始化一样；找不到 psql 时用 pg 执行同样的语句），用 `hardened.env` 的值启动 `node server.js`（只替换数据库地址、角色名、模型地址、端口和数据目录），然后：

- seed 两次（第二次全部是已有/重复）、walkthrough 两次，全部 PASS；
- 用 dev OIDC IdP 登录一个 token 里自带 `admin.owner` 的用户：不是成员时被拒；登记为 beta 的 viewer 后只有 viewer 权限，平台角色被丢弃（`API_AUTH_OIDC_ALLOW_PLATFORM_ROLES=false`），不能擦除；移出成员后又被拒；
- 假模型把每次 chat 延迟 1.5 秒，beta 的第三个并发请求返回 429 `TENANT_CONCURRENCY_LIMITED`，同时 alpha 的请求正常；
- `/ready` 为 200，平台管理员看到的健康报告没有任何 error，`rowLevelSecurity.roleSplit` 为 `ok`；
- 把一个已完成的 run、一个已完成的任务和反馈改成过期，保留期清理（系统角色）在几秒内删掉它们；
- `audit-verify.mjs` 以两个数据库 URL 运行，所有链校验通过；
- 运维命令（`tenant-registry.mjs list`、`tenant-lifecycle.mjs erase/export`、`ingest-jobs.mjs`、`vector-index.mjs status`）在 strict 和角色拆分下都能运行，beta 的导出不含 alpha 的内容；
- 真正擦除 alpha：每张带 `workspace_id` 列的表里都没有 alpha 的行（审计表除外，按设计保留并有一条擦除 tombstone），两个刷写周期后仍然没有；beta 的文档和 chat 照常；审计链仍然完整；alpha 可以重新登记，重新上传的文档是新文档，不会被去重成已删除的文档；
- 日志里没有 `ARCHIVE_RAG_TENANT_CONTEXT_MISSING`、`permission denied`、保留期失败或用量刷写失败；SIGTERM 后退出码为 0。

## 组合暴露的问题

- **`API_AUTH_REQUIRE_WORKSPACE=true` 拒绝所有平台身份。** 这个设置要求每个已认证请求都解析出 workspace，连平台管理路由也不例外，而平台身份（没有 workspace、也没有 workspace 列表）按设计不属于任何 workspace。结果是开了它就无法登记 workspace（`POST /admin/workspaces` 只允许平台身份），也无法擦除、导出、跨租户读用量和审计；给平台身份带上 `x-workspace-id` 也不行，路由会把它当成该 workspace 的管理员。健康探针同样受影响：平台管理员读不到健康详情。修复（`server/auth.js`）：在 `TENANTLESS_PLATFORM_PATHS` 上，对没有 workspace 列表的身份不要求 workspace，和 `requireTenantScope` 放行的范围一致；探针的权限判断不要求 workspace（它本来就不应用 `requireTenantScope`）。其他路由照旧要求。回归测试在 `test/admin-tenants-routes.test.mjs` 和 `test/health-access.test.mjs`。

## 按设计如此的行为

- 文档按 (用户, workspace) 隔离，不是按 workspace：同一 workspace 的成员彼此看不到对方上传的文档，只有不带用户的 workspace 凭据上传的文档是共享的。workspace.viewer 因此只能读共享文档。
- 长期记忆只按用户隔离：carol 在 alpha 和 beta 用的是同一份长期记忆。
- `GET /admin/ingest-jobs/dead-letter` 和重新入队是租户范围的路由。`TENANT_MEMBERSHIP=enforce` 下只有该 workspace 的成员（且有全局 `admin.status.read`）能用；平台运维用 `npm run ingest:jobs -- dead-letter list --all`。
- 擦除保留审计记录，所以擦除后的导出里仍然有该租户的审计事件。
- 删除文档时的脱敏只替换以文档 id 标注的原文（引用、摘录、证据），不改模型写的答案。本演示的 run 只保存答案，所以 `delete_redaction` 检查反馈里的引用摘录。
- 鉴权之前还有按 IP 的限流（`RATE_LIMIT_*`）。演示配置把它调宽，让按租户的限流先生效。

## 限制

- token 和数据库密码是公开的演示值；没有 TLS，没有 KMS 或密钥管理，静态 token 只能通过改配置并重启来撤销。
- 只有单实例单体部署：拆分部署（`compose.services.yml`）、Redis 共享状态、读副本都没有覆盖。
- 进程内状态按进程计：注册表查询缓存（`TENANT_REGISTRY_CACHE_TTL_MS`，其他进程最多晚一个 TTL）、限流计数和并发计数（不开 `RAG_SHARED_STATE=redis` 时）、用量账本未刷写的部分。多实例时这些上限按实例分别生效。
- 假模型只证明隔离边界在一条能工作的检索和回答路径上成立，不说明回答质量。模型配额的上限设得较宽，walkthrough 不会触发模型配额拒绝。
- 浏览器界面不发送 `x-workspace-id`，也没有登录态（除非配置 OIDC），所以演示通过命令行进行；只有固定 workspace 的 token（alice、bob）能在构建时写进前端使用。
- compose override 只用 `docker compose config` 验证过，没有构建镜像、没有实际启动；e2e 测试在本地 PostgreSQL（Postgres.app 18）上跑，不是 compose 里的 pg16。
- 保留期清理的第一次执行在启动后 1 分钟（`RETENTION_SWEEP_INTERVAL_MS` 和 60 秒取小）。e2e 把间隔调成 2 秒，并手工把记录改成过期，才在测试时间内看到删除。
