# 多租户隔离演示（hardened profile）

租户隔离第 1–5 阶段的每个开关此前都只单独测过。这个演示把它们同时打开，用一组固定的演示身份跑一遍，证明组合起来仍然成立：

- API 鉴权（按用户的静态 token），每个请求必须解析出 workspace；
- `RBAC_MODE=enforce`，`TENANT_MEMBERSHIP=enforce`；
- 行级安全（`enforce`）加 `POSTGRES_TENANT_CONTEXT=strict`；
- 数据库角色拆分：owner 登录跑迁移，运行时登录不拥有任何表；
- 数据访问审计事件、删除文档时的脱敏、文档回收站（`DOCUMENT_TRASH_RETENTION_HOURS=72`）；
- 按租户的限流、并发上限、模型配额、存储配额、任务上限，以及拒绝计数（`GET /admin/usage?metric=refusals`）；
- 保留期清理；
- 存储文件的信封加密（`TENANT_ENCRYPTION=on`，本地 KMS，每个 workspace 一把密钥，擦除时销毁）；
- 按租户分区的查询嵌入缓存和注册表缓存（`RAG_EMBEDDING_CACHE_SCOPE=tenant`、`TENANT_REGISTRY_CACHE_SCOPE=tenant`）；
- 按 workspace 的长期记忆（`LONG_MEMORY_SCOPE=workspace`）；
- `API_AUTH_OIDC_ALLOW_PLATFORM_ROLES=false`。

**只用于演示，不能用于生产。** 文件里的 token 和数据库密码都是写死的公开演示值，任何读过这个仓库的人都知道；本地 KMS 的主密钥就放在服务所在的机器（或 app 数据卷）上。

## 组成

| 文件 | 作用 |
| --- | --- |
| `deploy/demo/hardened.env` | 服务端环境配置，带注释。每个变量名都由 `server/test/demo-tenants.test.mjs` 核对：服务端确实读取它，并且在 `docs/configuration.md` 或 `server/.env.example` 里有说明；每个开关都用服务端自己的解析函数确认是打开的。 |
| `compose.demo.yml` | `docker-compose.yml` 的 override：用上面的配置跑 `--profile app`，app 以运行时登录连接数据库，密钥库和主密钥放在 app 数据卷里。 |
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
| carol | `demo-carol-token` | token 允许 `alpha`、`beta`，每次必须指定一个 | 两个 workspace 都是 `workspace.member`，两边各有一份自己的文档 |
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

- 演示和默认部署互不相干：`compose.demo.yml` 用自己的 compose 项目名（`luc1ferxx-archive-rag-demo`）、自己的容器名和自己的数据卷（`pgdata-demo`、`appdata-demo`），所以不会读写默认部署的 `pgdata`、`appdata`。两者用同样的宿主机端口，不能同时运行；默认部署停着时可以留在原地。
- postgres 第一次初始化 `pgdata-demo` 时，镜像执行挂载进去的 `deploy/postgres/create-split-roles.sql`，创建 owner 登录 `archive_rag_owner`（拥有 `archive_rag` 库，CREATEROLE）和运行时登录 `archive_rag_app`（NOSUPERUSER、NOBYPASSRLS、NOINHERIT，不拥有任何东西）。
- app 只读 `deploy/demo/hardened.env`（`env_file: !override`，不读 `server/.env`，所以默认部署的模型 key 和设置都不会进入演示）；数据库地址和模型地址由 compose 的 `environment` 换成 compose 网络里的服务。
- 本地 KMS 的密钥库 `/data/tenant-keystore` 和主密钥 `/data/tenant-kms-master.key` 在演示自己的 app 数据卷 `appdata-demo` 里，不在数据库卷里，所以数据库备份里没有能用的密钥；但谁能读这个卷，谁就能解密所有租户的文件。
- `demo-model` 服务用同一个镜像跑假模型，只在 compose 网络内可达，不发布端口；`init: true`，命令本身也处理 SIGTERM，`docker compose stop` 不用等超时。
- 端口仍然只绑定 `127.0.0.1`（`ARCHIVE_RAG_BIND_HOST`）。不要配合这个文件设 `ARCHIVE_RAG_BIND_HOST=0.0.0.0`。
- 重新开始：`docker compose -f docker-compose.yml -f compose.demo.yml --profile app down -v`。它只删除演示项目的容器和 `pgdata-demo`、`appdata-demo`（连同主密钥，所以演示里加密的文件也一起作废），默认部署的数据卷不受影响。

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

`hardened.env` 故意不设 `TENANT_KEYSTORE_DIR` 和 `TENANT_KMS_MASTER_KEY_FILE`：默认值在数据目录旁边，本地运行时是 `server/data/tenant-keystore` 和 `server/data/tenant-kms-master.key`（按服务端源码目录解析，与当前工作目录无关，`server/data/` 已在 `.gitignore` 里），镜像里是 `/data/...`。没有一个相对路径能同时适合这两种情况，而写错工作目录时不能在仓库里生成主密钥。

想用真实模型：改 `hardened.env` 末尾的 `OPENAI_*` 和 `RAG_EMBEDDING_DIMENSIONS`，并且从空库开始（向量宽度在建表时就固定了）。

### 浏览器界面

前端的 workspace 切换器（`src/auth/WorkspaceProvider.jsx`）在不带 `x-workspace-id` 的 `/auth/me` 列出多个 workspace、且没有固定 workspace 时出现，选中的 workspace 作为 `x-workspace-id` 随每个请求发出。静态 token 由构建时的 `VITE_API_AUTH_TOKEN` 决定用哪个演示身份：

- `demo-carol-token`：切换器列出 `alpha` 和 `beta`，切换后文档、对话、任务都换成那个 workspace 的；
- `demo-alice-token`、`demo-bob-token`：固定在一个 workspace，不显示切换器，直接可用；
- 只有用户的 token（anna、ben、dave）也能用界面：`TENANT_MEMBERSHIP=enforce` 下，`/auth/me` 列出该用户在注册表里所有 active 的成员关系，并返回 `workspaceRequired: true`，切换器因此不提供"不选 workspace"，默认选中第一个。

本地：仓库根目录 `.env` 里设 `VITE_DOMAIN=http://localhost:5001`、`VITE_API_AUTH_TOKEN=demo-carol-token`，再 `npm start`（`hardened.env` 的 `ALLOWED_ORIGINS` 已包含 `http://localhost:3000`）。compose：`docker compose -f docker-compose.yml -f compose.demo.yml --profile app build --build-arg VITE_API_AUTH_TOKEN=demo-carol-token app` 后再 `up -d`。token 会打进前端包，只适合本机演示。

## `demo:seed`

以 tenant-manager 身份通过 `/admin/workspaces` 登记 `alpha`、`beta`、`gamma` 三个 workspace 和全部成员关系，再以各自的上传者身份上传 6 份生成的小 PDF（上传接口只收 PDF）。carol 在 alpha 的文档走分片上传（`/upload/init`、`/upload/chunk`、`/upload/complete`），其余走 `POST /upload`。异步入库模式下会轮询入库任务直到完成。

可以重复执行：已存在的 workspace 保留（之前中断留下的暂停状态会重新激活），成员角色重新写一遍，相同字节的文档按去重解析为已有文档（`duplicate`）。

`--url <地址>` 指定服务地址，默认 `http://127.0.0.1:5001`。

## `demo:walkthrough`

逐项检查并打印 PASS/FAIL 表，有 FAIL 时退出码为 1（无法运行时为 2）。`--only <id,...>` 只跑部分检查，`--json` 输出 JSON。检查会改动 gamma（暂停再恢复、耗尽限流、填满存储配额）、在回收站里删除再恢复 alice 的一份文档、写入再删掉 carol 的两条记忆，并在 bob 的回收站里留一份探测文档（下一次运行先恢复它再删除）。除 gamma 的配额探测文档留在回收站里（它们在清除前继续占配额，所以之后的运行一上来就被拒绝，检查仍然成立）之外，结束时都回到 seed 之后的状态，可以在同一个限流窗口内连续再跑一遍。`refusal_accounting` 要在 `tenant_rate_limit` 之后运行。

| 检查 | 证明什么 |
| --- | --- |
| `probes_answer_status_only` | 匿名的 `/ready` 只返回 `{status}`，不泄露拓扑和存储信息。 |
| `health_row_level_security` | 平台管理员能读健康详情，`checks.rowLevelSecurity` 和其中的 `roleSplit` 都是 `ok`，开了加密时 `checks.tenantEncryption` 也是 `ok`；不带 workspace 也能访问 `/admin/status`、`/admin/index-versions`。 |
| `credential_required` | 没有 token 是 401；有多个 workspace 却没指定的凭据是 403（`API_AUTH_REQUIRE_WORKSPACE`）。 |
| `membership_required` | 指定一个自己不是成员的 workspace（或一个没登记的）是 403 `WORKSPACE_MEMBERSHIP_REQUIRED`；token 固定的 workspace 之外也是 403。 |
| `list_isolation` | 每个成员列出的正好是自己的文档加本 workspace 的共享文档。 |
| `download_isolation` | 下载别的 workspace 的文档、或同 workspace 其他成员的私有文档都是 404；自己的和共享的是 200；共享文档在另一个 workspace 里也是 404。 |
| `delete_isolation` | alpha 的 workspace.admin 删除 beta 的文档得到 404，文档还在。 |
| `document_trash` | alice 删除自己的文档后，它从列表、下载（404）和对话（404）里消失，出现在她的回收站里并带清除时间；bob（另一个租户）和 carol（同 workspace 的另一个成员）的回收站里都没有它，bob 恢复它是 404；alice 恢复后它重新出现在列表里，对话又能回答。 |
| `chat_isolation` | 对 beta 的文档提问得到 404，回复里没有 beta 文档的内容和文件名；对自己的文档能正常回答。 |
| `chat_stream_isolation` | 同上，走 `/chat/stream`（SSE）。 |
| `viewer_is_read_only` | workspace.viewer 能读共享文档，上传和删除都被 RBAC 拒绝（403 `RBAC_PERMISSION_DENIED`）。 |
| `membership_roles_in_rbac` | `/auth/me` 的权限就是注册表里成员角色对应的权限：anna 是 viewer，alice 是 admin，carol 在 beta 是 member。 |
| `workspace_switcher` | 前端切换器读的那条路径：不带 `x-workspace-id` 的 `/auth/me` 给 carol 列出 `alpha`、`beta`；alice 固定在 alpha；anna 的 token 本身不带 workspace，列表来自注册表里的成员关系（`alpha`）；两人都返回 `workspaceRequired: true`。 |
| `memory_isolation` | 长期记忆只属于写入它的用户，别人列不出、删不掉；两个租户用同一个 sessionId 各自清空自己的会话。 |
| `workspace_memory` | carol 在 alpha 记下一条笔记（"Remember that …"）：在 beta 的 `GET /memory` 里看不到；在 beta 问一个和笔记用词相同的问题后，笔记的 `lastUsedAt` 仍然为空（没有被召回进 beta 的回答）；同样的问题在 alpha 会召回它。回答语言偏好（`reply_language`）按用户保存，在 beta 也能看到。最后两条记忆都删掉。 |
| `tenant_manager_least_privilege` | tenant-manager 能管理注册表，但不能擦除租户，也不能读任何 workspace 的文档。 |
| `suspended_workspace` | 暂停 gamma 后它的请求是 403 `WORKSPACE_SUSPENDED`，恢复后正常；alpha 不受影响。 |
| `background_task_isolation` | 后台任务在提交者自己的租户里跑完；其他 workspace 的用户和同 workspace 的其他成员都看不到它（404）。 |
| `delete_redaction` | 反馈里保存的引用摘录：开着回收站时，删除后文档还能恢复，摘录保持原样；清除时才换成 `[source document deleted]`（e2e 测试把探测文档改成过期来验证；不开回收站时删除立即替换）。角色拆分下由系统角色更新，迁移 040 只允许它改这一列。 |
| `tenant_rate_limit` | gamma 的 chat 配额用完后返回 429 `TENANT_RATE_LIMITED`，同时 alpha 不受影响。这里用无效的 `/chat` 请求体：限流在路由校验之前计数，不调用模型。 |
| `refusal_accounting` | 平台管理员的 `GET /admin/usage?metric=refusals&reason=TENANT_RATE_LIMITED` 里有 gamma 的拒绝计数，没有 alpha（按 `TENANT_USAGE_FLUSH_MS` 延迟写入，检查会等待）。 |
| `storage_quota` | gamma 存到 `TENANT_MAX_DOCUMENTS` 份之后，下一次上传返回 429 `TENANT_STORAGE_QUOTA_EXCEEDED`；探测文档随后删除，进入回收站后仍占配额，直到清除。 |
| `platform_usage_view` | 平台管理员的 `/admin/usage` 能看到所有 workspace 的入库字节；workspace 管理员无权读取。 |
| `erase_dry_run` | `POST /admin/tenants/erase` 默认只预览：返回每个存储的记录数，什么都不删。 |
| `export_isolation` | alpha 的导出包含 alpha 的文档，不含任何其他 workspace 或其他用户的记录，也不含 beta 文档的内容。alpha 自己的审计记录会引用 alice 请求过的 beta 文档 id（那是 alpha 的请求，不是 beta 的数据），检查会单独列出这类记录。 |
| `data_access_audit` | alpha 的审计记录里有 `data.access` 事件，且都属于 alpha；只有平台管理员能跨租户读审计。 |
| `audit_chain` | 总是 SKIP：哈希链校验要读数据库，见下一节。 |

## 审计链和密钥

`audit:verify` 和 `tenant:keys` 只有命令行，需要数据库地址（和服务用同样的两个 URL），`tenant:keys` 还要读同一个密钥库：

```bash
cd server
DOTENV_CONFIG_PATH=../deploy/demo/hardened.env npm run audit:verify
DOTENV_CONFIG_PATH=../deploy/demo/hardened.env npm run tenant:keys -- status
# compose：docker compose -f docker-compose.yml -f compose.demo.yml --profile app exec app node audit-verify.mjs
#          docker compose -f docker-compose.yml -f compose.demo.yml --profile app exec app node tenant-keys.mjs status
```

## e2e 测试

```bash
cd server
TEST_FILES="test/tenant-isolation-hardened.e2e.test.mjs" bash scripts/run-pgvector-integration.sh
```

没有 `PGVECTOR_TEST_DATABASE_URL` 时报告为 skipped。它在测试集群里新建一个一次性数据库，用 `psql`（15 及以上）执行 `create-split-roles.sql` 建两个登录（密码走 `\getenv`，和 compose 初始化一样；找不到时用 pg 执行同样的语句），用 `hardened.env` 的值启动 `node server.js`（只替换数据库地址、角色名、模型地址、端口、数据目录和密钥库路径），然后：

- seed 两次（第二次全部是已有/重复）、walkthrough 两次，全部 PASS；
- 数据库里每份 `rag_documents.file_bytes` 都是信封（`isTenantEnvelope`）：没有 `%PDF` 标记，也没有文档里的句子；每个 workspace 一把密钥（`tk_` 加哈希，不含原始 id），不同 workspace 不共用；用同一个本地 KMS 和本行的上下文能解出 PDF，换成别的文档的行就解不开；`tenant:keys -- status` 列出这几把密钥；
- 用 dev OIDC IdP 登录一个 token 里自带 `admin.owner` 的用户：不是成员时被拒；登记为 beta 的 viewer 后只有 viewer 权限，平台角色被丢弃（`API_AUTH_OIDC_ALLOW_PLATFORM_ROLES=false`），不能擦除；移出成员后又被拒；
- 假模型把每次 chat 延迟 1.5 秒，beta 的第三个并发请求返回 429 `TENANT_CONCURRENCY_LIMITED`，同时 alpha 的请求正常；
- `/ready` 为 200，平台管理员看到的健康报告没有任何 error，`rowLevelSecurity.roleSplit` 和 `tenantEncryption` 为 `ok`；
- 把 bob 回收站里的探测文档改成超过 72 小时：保留期清理（系统角色）清除它（行和字节），然后才把反馈里的摘录换成 `[source document deleted]`；
- 把一个已完成的 run、一个已完成的任务和反馈改成过期，保留期清理在几秒内删掉它们；
- `audit-verify.mjs` 以两个数据库 URL 运行，所有链校验通过；
- 运维命令（`tenant-registry.mjs list`、`tenant-lifecycle.mjs erase/export`、`ingest-jobs.mjs`、`vector-index.mjs status`）在 strict 和角色拆分下都能运行，beta 的导出不含 alpha 的内容；
- 真正擦除 alpha：结果里的 `tenantKeys` 报告销毁了 alpha 的 workspace 密钥（只有 id 和版本）；擦除前留下的一份 alpha 密文（相当于旧的数据库备份）此后解密失败，报 `TENANT_KEY_DESTROYED`；beta 的文件照常解密、bob 照常下载；每张带 `workspace_id` 列的表里都没有 alpha 的行（审计表除外，按设计保留并有一条擦除 tombstone），两个刷写周期后仍然没有，alice 之后被拒绝的请求只记在她自己名下；beta 的文档和 chat 照常；审计链仍然完整；alpha 可以重新登记，重新上传的文档是新文档，用同一个密钥 id 的新版本加密，旧版本仍然无法解密；
- 日志里没有 `ARCHIVE_RAG_TENANT_CONTEXT_MISSING`、`permission denied`、保留期失败或用量刷写失败；SIGTERM 后退出码为 0。

## 组合暴露的问题

- **`API_AUTH_REQUIRE_WORKSPACE=true` 拒绝所有平台身份。** 这个设置要求每个已认证请求都解析出 workspace，连平台管理路由也不例外，而平台身份（没有 workspace、也没有 workspace 列表）按设计不属于任何 workspace。结果是开了它就无法登记 workspace（`POST /admin/workspaces` 只允许平台身份），也无法擦除、导出、跨租户读用量和审计；给平台身份带上 `x-workspace-id` 也不行，路由会把它当成该 workspace 的管理员。健康探针同样受影响：平台管理员读不到健康详情。修复（`server/auth.js`）：在 `TENANTLESS_PLATFORM_PATHS` 上，对没有 workspace 列表的身份不要求 workspace，和 `requireTenantScope` 放行的范围一致；探针的权限判断不要求 workspace（它本来就不应用 `requireTenantScope`）。其他路由照旧要求。回归测试在 `test/admin-tenants-routes.test.mjs` 和 `test/health-access.test.mjs`。
- **成员拒绝的计数把任意 workspace id 写进用量账本，也让擦除过的 workspace 重新出现。** `TENANT_MEMBERSHIP=enforce` 的每次拒绝都按"用户 + 请求里的 workspace"记一行 `refused_*`。这个 workspace 是客户端在 `x-workspace-id` 里随便写的：每个编造的 id 都变成账本里自己的行（账本没有保留期）。擦除也因此不完整：擦除先清账本、最后才删注册表，alpha 被擦除后，前成员 alice 的第一个被拒请求就把 `alpha` 写回了刚清空的账本（擦除期间 `WORKSPACE_DELETING` 的拒绝也一样）。修复（`server/auth.js` `resolveRefusalLedgerScope`）：只有注册表里存在、且不在删除中的 workspace 才按 workspace 计；其他情况只记在用户名下，指标照常计数；注册表不可用时保持原样。回归测试在 `test/tenant-refusals.test.mjs`（未登记的、已登记但不是成员的、删除中的 workspace），e2e 断言擦除后 alice 的拒绝落在 `(alice, '')`。

## 按设计如此的行为

- 文档按 (用户, workspace) 隔离，不是按 workspace：同一 workspace 的成员彼此看不到对方上传的文档，只有不带用户的 workspace 凭据上传的文档是共享的。workspace.viewer 因此只能读共享文档。回收站同样按 (用户, workspace)：同 workspace 的其他成员看不到、也恢复不了。
- `LONG_MEMORY_SCOPE=workspace` 下笔记和 agent 经验只在写入它的 workspace 里可见；只有固定枚举的偏好（回答语言、回答风格）按用户保存，并且存成固定文本。开启前写入的记忆是用户级的，在每个 workspace 都能看到。
- `GET /admin/ingest-jobs/dead-letter` 和重新入队是租户范围的路由。`TENANT_MEMBERSHIP=enforce` 下只有该 workspace 的成员（且有全局 `admin.status.read`）能用；平台运维用 `npm run ingest:jobs -- dead-letter list --all`。
- 擦除保留审计记录，所以擦除后的导出里仍然有该租户的审计事件。
- 删除文档时的脱敏只替换以文档 id 标注的原文（引用、摘录、证据），不改模型写的答案。本演示的 run 只保存答案，所以 `delete_redaction` 检查反馈里的引用摘录。开着回收站时脱敏推迟到清除，因为在那之前文档还能恢复。
- 回收站里的文档继续占存储配额，直到清除；上传与回收站里相同字节的 PDF 会成为一份新文档，不会去重成回收站里的那份。
- 鉴权之前还有按 IP 的限流（`RATE_LIMIT_*`）。演示配置把它调宽，让按租户的限流先生效。

## 限制

- token 和数据库密码是公开的演示值；数据库连接没有 TLS（`POSTGRES_SSL_ENABLED` 未开），静态 token 只能通过改配置并重启来撤销。
- 加密只覆盖存储的文件字节：`rag_documents.file_bytes`、入库任务的字节和各阶段产物、上传分块文件，以及一次请求内的临时文件。**不加密**：切块文本、embedding 向量、全文检索的 tsvector、agent run 和任务快照（其中有问题和答案）、反馈、会话记忆和长期记忆、审计记录、用量账本、内存里的入库队列。擦除会删除这些数据，但旧的数据库备份里仍然有，所以备份的保留期要有界；销毁密钥只让备份里的文件字节无法解密。
- 本地 KMS 只是演示级：密钥文件由同一台机器上的主密钥文件包裹（compose 下两者在同一个 app 数据卷里），没有 KMS/HSM、没有职责分离；能读这个目录的人能解密所有租户的文件。在写时复制的文件系统上，销毁密钥（清零文件）只是尽力而为。生产环境应换成云 KMS 或 HSM，本仓库没有实现。
- 只有单实例单体部署：拆分部署（`compose.services.yml`）、Redis 共享状态、读副本都没有覆盖。
- 进程内状态按进程计：注册表查询缓存（`TENANT_REGISTRY_CACHE_TTL_MS`，其他进程最多晚一个 TTL；按租户分区后仍然是每个进程一份）、查询嵌入缓存（按租户分区，每个进程一份）、限流计数和并发计数（不开 `RAG_SHARED_STATE=redis` 时）、用量账本未刷写的部分。多实例时这些上限按实例分别生效，擦除也碰不到其他进程的内存缓存。
- 假模型只证明隔离边界在一条能工作的检索和回答路径上成立，不说明回答质量。模型配额的上限设得较宽，walkthrough 不会触发模型配额拒绝。
- 浏览器界面只适合 token 带 workspace 列表或固定 workspace 的身份（carol、alice、bob），而且 token 是构建时写进前端包的；只有用户的 token 用不了界面（见"浏览器界面"）。界面没有在这里实际打开测试过，只核对了它读取的 `/auth/me` 路径（`workspace_switcher` 检查）。
- compose override 只用 `docker compose config` 验证过，没有构建镜像、没有实际启动；e2e 测试在本地 PostgreSQL（Postgres.app 18）上跑，不是 compose 里的 pg16。
- 保留期清理的第一次执行在启动后 1 分钟（`RETENTION_SWEEP_INTERVAL_MS` 和 60 秒取小）。e2e 把间隔调成 2 秒，并手工把记录改成过期，才在测试时间内看到删除和清除。
